import {
  createDrainController,
  DRAIN_TIMEOUT_DEFAULT_MS,
} from './drain-controller.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function normalizeTimeout(timeoutMs) {
  const value = timeoutMs === undefined ? DRAIN_TIMEOUT_DEFAULT_MS : Number(timeoutMs);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError('background drain timeoutMs must be a non-negative integer');
  }
  return value;
}

function safeLog(logger, label, error) {
  try {
    logger?.error?.(`[${label}] ${error?.message || error}`);
  } catch {
    // Detached work must never become an unhandled rejection because logging failed.
  }
}

/**
 * Track process-local work that deliberately outlives its HTTP response or
 * Cron callback. Runtime producers are stopped before drain(), so drain keeps
 * admission open only long enough for already-tracked parents to register
 * their child work, then closes admission once the dynamic set becomes idle.
 */
export function createProcessBackgroundWorkRegistry({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setImmediateFn = setImmediate,
  now = Date.now,
} = {}) {
  if (typeof setImmediateFn !== 'function' || typeof now !== 'function') {
    throw new TypeError('setImmediateFn and now must be functions');
  }
  const controller = createDrainController({ setTimer, clearTimer });
  let draining = false;

  function run(work, { label = 'ProcessBackground', logger = console } = {}) {
    const pending = controller.run(work);
    pending.catch(error => safeLog(logger, label, error));
    return pending;
  }

  function schedule(work, options = {}) {
    return run(() => new Promise((resolve, reject) => {
      setImmediateFn(() => {
        Promise.resolve().then(work).then(resolve, reject);
      });
    }), options);
  }

  async function drain({ timeoutMs } = {}) {
    draining = true;
    const boundedTimeout = normalizeTimeout(timeoutMs);
    const deadline = now() + boundedTimeout;

    while (controller.inFlightCount > 0) {
      const remaining = Math.max(0, deadline - now());
      const result = await controller.waitForIdle({ timeoutMs: remaining });
      if (!result.drained) return result;
    }

    controller.stopAccepting();
    return Object.freeze({ drained: true, timedOut: false, pending: 0 });
  }

  return Object.freeze({
    run,
    schedule,
    drain,
    snapshot() {
      return Object.freeze({ draining, inFlight: controller.inFlightCount });
    },
  });
}

const processBackgroundWork = createProcessBackgroundWorkRegistry();

export function runProcessBackgroundWork(work, options) {
  return processBackgroundWork.run(work, options);
}

export function scheduleProcessBackgroundWork(work, options) {
  return processBackgroundWork.schedule(work, options);
}

export function drainProcessBackgroundWork(options) {
  return processBackgroundWork.drain(options);
}

export function getProcessBackgroundWorkSnapshot() {
  return processBackgroundWork.snapshot();
}
