const DETAIL_WORKER_STATE = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  LOADING: 'loading',
  READY: 'ready',
  COLLECTING: 'collecting',
  FAILED: 'failed',
});

function normalizeTabId(value) {
  const tabId = Number(value);
  return Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null;
}

function cleanText(value, maxLength = 2048) {
  return String(value || '').trim().slice(0, maxLength);
}

function createPipelineError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function resetSlot(slot, {invalidate = true} = {}) {
  if (invalidate) slot.generation += 1;
  slot.state = DETAIL_WORKER_STATE.IDLE;
  slot.recordId = '';
  slot.url = '';
  slot.mode = '';
  slot.readyAt = 0;
  slot.leaseId = 0;
  slot.error = null;
  slot.promise = null;
}

function publicSlot(slot) {
  return {
    tabId: slot.tabId,
    label: slot.label,
    state: slot.state,
    recordId: slot.recordId,
    url: slot.url,
    mode: slot.mode,
    readyAt: slot.readyAt,
    generation: slot.generation,
    leaseId: slot.leaseId,
    errorCode: cleanText(slot.error?.code, 120),
    errorMessage: cleanText(slot.error?.message, 320),
  };
}

/**
 * Two-slot detail pipeline. The standby tab may queue/load the next record while
 * the current record is being extracted, but `acquire()` remains exclusive: the
 * caller must `release()` before another tab can become COLLECTING.
 */
export function createDetailPrefetchPipeline({
  workerTabs = [],
  navigate,
  shouldStop = null,
  onTransition = null,
  minNavigationGapMs = 3000,
  stopTimeoutMs = 1500,
  isFatalError = null,
} = {}) {
  if (typeof navigate !== 'function') {
    throw new TypeError('navigate must be a function');
  }

  const seenTabIds = new Set();
  const slots = workerTabs
    .map((worker, index) => ({
      tabId: normalizeTabId(worker?.tabId ?? worker),
      label: cleanText(worker?.label || `Worker ${index + 1}`, 40),
    }))
    .filter((worker) => {
      if (!worker.tabId || seenTabIds.has(worker.tabId)) return false;
      seenTabIds.add(worker.tabId);
      return true;
    })
    .slice(0, 2)
    .map((worker) => ({
      ...worker,
      state: DETAIL_WORKER_STATE.IDLE,
      recordId: '',
      url: '',
      mode: '',
      readyAt: 0,
      generation: 0,
      leaseId: 0,
      error: null,
      promise: null,
    }));

  if (slots.length === 0) {
    throw createPipelineError(
      'detail_worker_unavailable',
      '没有可用的详情采集工作页',
    );
  }

  let stopped = false;
  let activeTabId = null;
  let activeLease = null;
  let fatalError = null;
  let navigationQueue = Promise.resolve();
  let lastNavigationStartedAt = 0;
  let leaseSequence = 0;
  let revision = 0;
  const navigationGapMs = Math.max(0, Number(minNavigationGapMs) || 0);
  const settleTimeoutMs = Math.max(100, Number(stopTimeoutMs) || 1500);

  function snapshot() {
    return {
      mode: slots.length > 1 ? 'double_buffer' : 'single_worker',
      stopped,
      activeTabId,
      activeLease: activeLease ? {...activeLease} : null,
      revision,
      fatalError: fatalError
        ? {
            code: cleanText(fatalError.code, 120),
            message: cleanText(fatalError.message, 320),
          }
        : null,
      lastNavigationStartedAt,
      slots: slots.map(publicSlot),
    };
  }

  function publishTransition(type, slot, extra = {}) {
    revision += 1;
    if (typeof onTransition !== 'function') return;
    try {
      onTransition({
        type,
        slot: slot ? publicSlot(slot) : null,
        snapshot: snapshot(),
        ...extra,
      });
    } catch {
      // Progress reporting must never break the capture pipeline.
    }
  }

  function isStopRequested() {
    if (stopped || fatalError) return true;
    if (typeof shouldStop !== 'function') return false;
    try {
      return Boolean(shouldStop());
    } catch {
      return true;
    }
  }

  function isFatalNavigationError(error) {
    if (typeof isFatalError === 'function') {
      try {
        return Boolean(isFatalError(error));
      } catch {
        return true;
      }
    }
    const code = cleanText(error?.code, 120).toUpperCase();
    const message = cleanText(error?.message || error, 520);
    return (
      code === 'XHS_SECURITY_BLOCK' ||
      code === 'PAGE_CHALLENGE_BLOCK' ||
      code === 'HTTP_429' ||
      code === 'RATE_LIMITED' ||
      /300013|安全限制|访问频繁|验证码|captcha|challenge|too many requests|\b429\b/iu.test(
        message,
      )
    );
  }

  async function waitForNavigationTurn() {
    while (true) {
      if (isStopRequested()) {
        throw createPipelineError(
          'detail_prefetch_canceled',
          'DETAIL_CAPTURE_CANCELED',
        );
      }
      const remainingMs = Math.max(
        0,
        navigationGapMs - (Date.now() - lastNavigationStartedAt),
      );
      if (remainingMs <= 0) return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, remainingMs)),
      );
    }
  }

  function normalizeItem(item = {}) {
    const recordId = cleanText(item.recordId, 320);
    const url = cleanText(item.url, 4096);
    if (!recordId || !url) {
      throw createPipelineError(
        'invalid_detail_prefetch_item',
        '预加载详情页时缺少记录或链接',
      );
    }
    return {recordId, url};
  }

  function enqueueNavigation(operation, {beforeStart = null} = {}) {
    const queuedNavigation = navigationQueue.then(async () => {
      await waitForNavigationTurn();
      if (typeof beforeStart === 'function') beforeStart();
      if (isStopRequested()) {
        throw createPipelineError(
          'detail_prefetch_canceled',
          'DETAIL_CAPTURE_CANCELED',
        );
      }
      lastNavigationStartedAt = Date.now();
      return await operation();
    });
    navigationQueue = queuedNavigation.then(
      () => undefined,
      () => undefined,
    );
    return queuedNavigation;
  }

  function findMatchingSlot(item) {
    return (
      slots.find(
        (slot) =>
          slot.recordId === item.recordId &&
          slot.url === item.url &&
          slot.state !== DETAIL_WORKER_STATE.IDLE,
      ) || null
    );
  }

  function findIdleSlot({excludeActive = false, excludeTabId = null} = {}) {
    const normalizedExcludedTabId = normalizeTabId(excludeTabId);
    return (
      slots.find(
        (slot) =>
          slot.state === DETAIL_WORKER_STATE.IDLE &&
          (!excludeActive || slot.tabId !== activeTabId) &&
          (!normalizedExcludedTabId || slot.tabId !== normalizedExcludedTabId),
      ) || null
    );
  }

  function startNavigation(slot, item, mode) {
    slot.generation += 1;
    const generation = slot.generation;
    slot.state = DETAIL_WORKER_STATE.QUEUED;
    slot.recordId = item.recordId;
    slot.url = item.url;
    slot.mode = mode;
    slot.readyAt = 0;
    slot.leaseId = 0;
    slot.error = null;
    publishTransition('navigation_queued', slot);

    const queuedNavigation = enqueueNavigation(
      async () =>
        await navigate({
          tabId: slot.tabId,
          recordId: item.recordId,
          url: item.url,
          mode,
          shouldStop: isStopRequested,
        }),
      {
        beforeStart: () => {
          if (slot.generation !== generation) {
            throw createPipelineError(
              'detail_prefetch_stale',
              '详情预加载任务已失效',
            );
          }
          slot.state = DETAIL_WORKER_STATE.LOADING;
          publishTransition('navigation_started', slot);
        },
      },
    );

    slot.promise = (async () => {
      try {
        await queuedNavigation;
        if (slot.generation !== generation) {
          return {
            ok: false,
            stale: true,
            tabId: slot.tabId,
            recordId: item.recordId,
            url: item.url,
            mode,
          };
        }
        if (isStopRequested()) {
          throw createPipelineError(
            'detail_prefetch_canceled',
            'DETAIL_CAPTURE_CANCELED',
          );
        }
        slot.state = DETAIL_WORKER_STATE.READY;
        slot.readyAt = Date.now();
        publishTransition('navigation_ready', slot);
        return {
          ok: true,
          tabId: slot.tabId,
          recordId: slot.recordId,
          url: slot.url,
          mode: slot.mode,
          readyAt: slot.readyAt,
        };
      } catch (error) {
        if (slot.generation !== generation) {
          return {
            ok: false,
            stale: true,
            tabId: slot.tabId,
            recordId: item.recordId,
            url: item.url,
            mode,
            error,
          };
        }
        slot.state = DETAIL_WORKER_STATE.FAILED;
        slot.error = error;
        if (isFatalNavigationError(error)) {
          fatalError = error;
          stopped = true;
        }
        publishTransition('navigation_failed', slot, {error});
        return {
          ok: false,
          tabId: slot.tabId,
          recordId: slot.recordId,
          url: slot.url,
          mode: slot.mode,
          error,
        };
      }
    })();

    return slot.promise;
  }

  function prefetch(itemInput, {excludeTabId = null} = {}) {
    const item = normalizeItem(itemInput);
    if (isStopRequested() || slots.length < 2) {
      return {started: false, reason: 'prefetch_unavailable'};
    }

    const matchingSlot = findMatchingSlot(item);
    if (matchingSlot) {
      return {
        started: false,
        reused: true,
        tabId: matchingSlot.tabId,
        state: matchingSlot.state,
      };
    }

    const slot = findIdleSlot({excludeActive: true, excludeTabId});
    if (!slot) {
      return {started: false, reason: 'worker_busy'};
    }

    startNavigation(slot, item, 'prefetch');
    return {started: true, tabId: slot.tabId, state: slot.state};
  }

  async function acquire(itemInput) {
    const item = normalizeItem(itemInput);
    if (activeLease || activeTabId) {
      throw createPipelineError(
        'detail_worker_active_lease',
        '上一条详情仍在采集中，不能同时晋升第二个工作页',
        {activeLease: activeLease ? {...activeLease} : null},
      );
    }
    if (isStopRequested()) {
      throw createPipelineError(
        'detail_prefetch_canceled',
        'DETAIL_CAPTURE_CANCELED',
      );
    }

    let slot = findMatchingSlot(item);
    const prefetched = Boolean(slot && slot.mode === 'prefetch');
    if (!slot) {
      slot = findIdleSlot();
      if (!slot) {
        throw createPipelineError(
          'detail_worker_busy',
          '详情采集工作页仍在处理上一条记录',
        );
      }
      startNavigation(slot, item, 'foreground');
    }

    const result = await slot.promise;
    if (!result?.ok) {
      const cause = result?.error || new Error('详情页加载失败');
      const failedTabId = slot.tabId;
      resetSlot(slot);
      if (cause && typeof cause === 'object') {
        cause.detailWorkerTabId = failedTabId;
      }
      throw cause;
    }

    leaseSequence += 1;
    slot.leaseId = leaseSequence;
    slot.state = DETAIL_WORKER_STATE.COLLECTING;
    activeTabId = slot.tabId;
    activeLease = {
      leaseId: slot.leaseId,
      generation: slot.generation,
      tabId: slot.tabId,
      recordId: slot.recordId,
      url: slot.url,
    };
    publishTransition('collection_started', slot, {prefetched});
    return {
      ...activeLease,
      tabId: slot.tabId,
      label: slot.label,
      readyAt: slot.readyAt,
      prefetched,
    };
  }

  function release(lease = null) {
    const candidateLease = lease && typeof lease === 'object' ? lease : null;
    if (!candidateLease || !activeLease) return false;
    const tabId = normalizeTabId(candidateLease.tabId);
    const leaseId = Number(candidateLease.leaseId);
    const generation = Number(candidateLease.generation);
    const recordId = cleanText(candidateLease.recordId, 320);
    if (
      tabId !== activeLease.tabId ||
      leaseId !== activeLease.leaseId ||
      generation !== activeLease.generation ||
      recordId !== activeLease.recordId
    ) {
      return false;
    }
    const slot = slots.find(
      (candidate) =>
        candidate.tabId === tabId &&
        candidate.state === DETAIL_WORKER_STATE.COLLECTING &&
        candidate.leaseId === leaseId &&
        candidate.generation === generation &&
        candidate.recordId === recordId,
    );
    if (!slot) return false;
    const completedRecordId = slot.recordId;
    if (activeTabId === slot.tabId) activeTabId = null;
    activeLease = null;
    resetSlot(slot);
    publishTransition('collection_finished', slot, {completedRecordId});
    return true;
  }

  function discard(itemInput = {}) {
    const item = normalizeItem(itemInput);
    const slot = findMatchingSlot(item);
    if (!slot || slot.state === DETAIL_WORKER_STATE.COLLECTING) return false;
    const discardedSlot = publicSlot(slot);
    resetSlot(slot);
    publishTransition('prefetch_discarded', slot, {discardedSlot});
    return true;
  }

  async function stop() {
    stopped = true;
    publishTransition('pipeline_stopping', null);
    const pending = slots
      .map((slot) => slot.promise)
      .filter((promise) => promise && typeof promise.then === 'function');
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, settleTimeoutMs)),
      ]);
    }
    activeTabId = null;
    activeLease = null;
    slots.forEach((slot) => resetSlot(slot));
    publishTransition('pipeline_stopped', null);
    return snapshot();
  }

  function getFatalError() {
    return fatalError || null;
  }

  async function runExternalNavigation(operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('external navigation must be a function');
    }
    try {
      return await enqueueNavigation(operation);
    } catch (error) {
      if (isFatalNavigationError(error)) {
        fatalError = error;
        stopped = true;
        publishTransition('external_navigation_failed', null, {error});
      }
      throw error;
    }
  }

  return Object.freeze({
    acquire,
    prefetch,
    release,
    discard,
    stop,
    snapshot,
    getFatalError,
    runExternalNavigation,
  });
}

export {DETAIL_WORKER_STATE};
