const PRIORITY_RANK = Object.freeze({
  interactive: 0,
  normal: 1,
  capture: 2,
  background: 3,
});

function emptyPriorityCounts() {
  return {
    capture: 0,
    interactive: 0,
    normal: 0,
    background: 0,
  };
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizedTenantId(value) {
  return String(value || '').trim() || 'system';
}

function normalizedPriority(value) {
  const priority = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, priority)
    ? priority
    : 'normal';
}

export class AiAdmissionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiAdmissionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * One in-process admission controller per server process. Production currently
 * runs a single PM2 worker, so this is the authoritative tenant-wide LLM gate.
 * Every model caller enters here instead of maintaining an independent pool.
 */
export class TenantAiAdmissionController {
  constructor({
    concurrency = 6,
    captureConcurrency = 4,
    maxQueue = 500,
    queueTimeoutMs = 120000,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.concurrency = boundedInteger(concurrency, 6, 1, 20);
    this.captureConcurrency = boundedInteger(
      captureConcurrency,
      Math.min(4, this.concurrency),
      1,
      this.concurrency,
    );
    this.maxQueue = boundedInteger(maxQueue, 500, 1, 5000);
    this.queueTimeoutMs = boundedInteger(
      queueTimeoutMs,
      120000,
      1000,
      600000,
    );
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.states = new Map();
    this.sequence = 0;
  }

  stateFor(tenantId) {
    const key = normalizedTenantId(tenantId);
    let state = this.states.get(key);
    if (!state) {
      state = {active: 0, activeByPriority: emptyPriorityCounts(), queue: []};
      this.states.set(key, state);
    }
    return {key, state};
  }

  canAdmit(state, priority) {
    if (state.active >= this.concurrency) return false;
    if (
      priority === 'capture'
      && state.activeByPriority.capture >= this.captureConcurrency
    ) return false;
    return true;
  }

  activate(state, priority) {
    state.active += 1;
    state.activeByPriority[priority] += 1;
  }

  bestWaiterIndex(queue, state) {
    let bestIndex = -1;
    for (let index = 0; index < queue.length; index += 1) {
      const candidate = queue[index];
      if (!this.canAdmit(state, candidate.priority)) continue;
      if (bestIndex < 0) {
        bestIndex = index;
        continue;
      }
      const best = queue[bestIndex];
      if (
        candidate.rank < best.rank ||
        (candidate.rank === best.rank && candidate.sequence < best.sequence)
      ) {
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  cleanup(key, state) {
    if (state.active === 0 && state.queue.length === 0) {
      this.states.delete(key);
    }
  }

  async acquire(tenantId, options = {}) {
    const {key, state} = this.stateFor(tenantId);
    const priority = normalizedPriority(options.priority);
    const kind = String(options.kind || 'llm').trim().slice(0, 80) || 'llm';
    const queuedAt = this.now();
    if (this.canAdmit(state, priority)) {
      this.activate(state, priority);
      return {tenantId: key, priority, kind, waitMs: 0};
    }
    if (state.queue.length >= this.maxQueue) {
      throw new AiAdmissionError(
        'AI_ADMISSION_QUEUE_FULL',
        'AI 请求队列暂时已满，请稍后重试',
        {tenantId: key, queued: state.queue.length, limit: this.concurrency},
      );
    }
    const timeoutMs = boundedInteger(
      options.queueTimeoutMs,
      this.queueTimeoutMs,
      1000,
      600000,
    );
    return await new Promise((resolve, reject) => {
      const waiter = {
        priority,
        rank: PRIORITY_RANK[priority],
        kind,
        queuedAt,
        sequence: this.sequence++,
        timer: null,
        resolve,
        reject,
      };
      waiter.timer = this.setTimer(() => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        this.cleanup(key, state);
        reject(new AiAdmissionError(
          'AI_ADMISSION_QUEUE_TIMEOUT',
          'AI 请求排队超时，请稍后重试',
          {
            tenantId: key,
            priority,
            kind,
            waitMs: Math.max(0, this.now() - queuedAt),
          },
        ));
      }, timeoutMs);
      state.queue.push(waiter);
    });
  }

  release(admission) {
    const key = normalizedTenantId(
      typeof admission === 'string' ? admission : admission?.tenantId,
    );
    const releasedPriority = normalizedPriority(
      typeof admission === 'string' ? 'normal' : admission?.priority,
    );
    const state = this.states.get(key);
    if (!state) return;
    state.active = Math.max(0, state.active - 1);
    state.activeByPriority[releasedPriority] = Math.max(
      0,
      state.activeByPriority[releasedPriority] - 1,
    );
    while (state.queue.length > 0 && state.active < this.concurrency) {
      const index = this.bestWaiterIndex(state.queue, state);
      if (index < 0) break;
      const [waiter] = state.queue.splice(index, 1);
      this.clearTimer(waiter.timer);
      this.activate(state, waiter.priority);
      waiter.resolve({
        tenantId: key,
        priority: waiter.priority,
        kind: waiter.kind,
        waitMs: Math.max(0, this.now() - waiter.queuedAt),
      });
    }
    this.cleanup(key, state);
  }

  async run(tenantId, operation, options = {}) {
    const admission = await this.acquire(tenantId, options);
    try {
      return await operation(admission);
    } finally {
      this.release(admission);
    }
  }

  snapshot(tenantId = '') {
    const summarize = (key, state) => {
      const queuedByPriority = emptyPriorityCounts();
      for (const waiter of state.queue) {
        queuedByPriority[waiter.priority] += 1;
      }
      const oldestQueuedAt = state.queue.reduce(
        (oldest, waiter) => Math.min(oldest, waiter.queuedAt),
        Number.POSITIVE_INFINITY,
      );
      return {
        tenantId: key,
        limit: this.concurrency,
        captureLimit: this.captureConcurrency,
        active: state.active,
        activeByPriority: {...state.activeByPriority},
        queued: state.queue.length,
        queuedByPriority,
        oldestWaitMs: Number.isFinite(oldestQueuedAt)
          ? Math.max(0, this.now() - oldestQueuedAt)
          : 0,
      };
    };
    if (tenantId) {
      const key = normalizedTenantId(tenantId);
      const state = this.states.get(key) || {
        active: 0,
        activeByPriority: emptyPriorityCounts(),
        queue: [],
      };
      return summarize(key, state);
    }
    return Array.from(this.states.entries()).map(([key, state]) =>
      summarize(key, state)
    );
  }
}

export const DEFAULT_AI_TENANT_CONCURRENCY = 6;
export const DEFAULT_AI_CAPTURE_CONCURRENCY = 4;
export const DEFAULT_AI_QUEUE_TIMEOUT_MS = 120000;

const controller = new TenantAiAdmissionController({
  concurrency: boundedInteger(
    process.env.AI_TENANT_CONCURRENCY,
    DEFAULT_AI_TENANT_CONCURRENCY,
    1,
    20,
  ),
  captureConcurrency: boundedInteger(
    process.env.AI_TENANT_CAPTURE_CONCURRENCY,
    DEFAULT_AI_CAPTURE_CONCURRENCY,
    1,
    20,
  ),
  maxQueue: boundedInteger(process.env.AI_TENANT_QUEUE_MAX, 500, 1, 5000),
  queueTimeoutMs: boundedInteger(
    process.env.AI_TENANT_QUEUE_TIMEOUT_MS,
    DEFAULT_AI_QUEUE_TIMEOUT_MS,
    1000,
    600000,
  ),
});

export async function runWithTenantAiAdmission(
  tenantId,
  operation,
  options = {},
) {
  return await controller.run(tenantId, async admission => {
    if (admission.waitMs >= 1000) {
      console.info('[AIAdmission] request admitted after queueing', {
        tenantId: admission.tenantId,
        kind: admission.kind,
        priority: admission.priority,
        waitMs: admission.waitMs,
      });
    }
    return await operation(admission);
  }, options);
}

export function getTenantAiAdmissionSnapshot(tenantId) {
  return controller.snapshot(tenantId);
}
