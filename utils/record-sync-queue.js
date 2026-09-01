function normalizeRecordId(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 单消费者记录同步队列。采集只负责入队，网络同步在后台串行执行。
 */
export function createRecordSyncQueue({
  enabled = true,
  processRecord,
  onStateChange = null,
  shouldStop = null,
  signal = null,
  retryDelaysMs = [],
  shouldRetry = null,
} = {}) {
  const queueEnabled = Boolean(enabled);
  if (queueEnabled && typeof processRecord !== "function") {
    throw new TypeError("record sync queue requires processRecord");
  }

  const pendingJobs = [];
  const pendingIds = new Set();
  const seenIds = new Set();
  const capturedIds = new Set();
  const enqueuedIds = new Set();
  const excludedIds = new Set();
  const succeededIds = new Set();
  const dirtyIds = new Set();
  const latestMetaById = new Map();
  let activeJob = null;
  let workerPromise = null;
  let blockedError = null;
  let canceled = signal?.aborted === true;
  let cancelReason = canceled ? "aborted" : "";
  const normalizedRetryDelaysMs = (Array.isArray(retryDelaysMs)
    ? retryDelaysMs
    : []
  )
    .map((value) => Math.max(0, Number(value) || 0))
    .filter(Number.isFinite)
    .slice(0, 5);
  const stats = {
    enqueuedCount: 0,
    processedCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    retryCount: 0,
  };

  const getStats = () => ({
    enabled: queueEnabled,
    ...stats,
    pendingCount: pendingJobs.length,
    activeCount: activeJob ? 1 : 0,
    remainingCount:
      pendingJobs.length + (activeJob ? 1 : 0) + dirtyIds.size,
    activeRecordId: activeJob?.recordId || "",
    blocked: Boolean(blockedError),
    error: blockedError,
    canceled,
    cancelReason,
    capturedUniqueCount: capturedIds.size,
    enqueuedUniqueCount: enqueuedIds.size,
    excludedUniqueCount: excludedIds.size,
    succeededUniqueCount: succeededIds.size,
  });

  const stopRequested = () => {
    if (canceled || signal?.aborted === true) {
      return true;
    }
    if (typeof shouldStop !== "function") {
      return false;
    }
    try {
      return shouldStop() === true;
    } catch {
      return true;
    }
  };

  const cancel = (reason = "capture_task_canceled") => {
    if (!queueEnabled) return false;
    const firstCancellation = !canceled;
    canceled = true;
    if (firstCancellation || !cancelReason) {
      cancelReason = String(reason || "capture_task_canceled");
    }
    pendingJobs.splice(0, pendingJobs.length);
    pendingIds.clear();
    dirtyIds.clear();
    latestMetaById.clear();
    if (firstCancellation) {
      emitState("canceled", {reason: cancelReason});
    }
    return firstCancellation;
  };

  const syncCancellationState = () => {
    if (!stopRequested()) return false;
    cancel(signal?.aborted ? "aborted" : "capture_task_canceled");
    return true;
  };

  signal?.addEventListener?.("abort", () => cancel("aborted"), {once: true});

  const emitState = (phase, extra = {}) => {
    if (typeof onStateChange !== "function") {
      return;
    }
    try {
      onStateChange({
        phase,
        ...getStats(),
        ...extra,
      });
    } catch (error) {
      console.warn("[RecordSyncQueue] State callback failed:", error);
    }
  };

  const registerCaptured = (recordIds) => {
    const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
    let addedCount = 0;
    ids.forEach((recordId) => {
      const normalizedId = normalizeRecordId(recordId);
      if (!normalizedId || capturedIds.has(normalizedId)) return;
      capturedIds.add(normalizedId);
      addedCount += 1;
    });
    return addedCount;
  };

  const markExcluded = (recordId) => {
    const normalizedId = normalizeRecordId(recordId);
    if (!normalizedId) {
      return false;
    }
    seenIds.add(normalizedId);
    if (enqueuedIds.has(normalizedId)) {
      return false;
    }
    excludedIds.add(normalizedId);
    return true;
  };

  // Kept as a compatibility alias for callers that only need deduplication.
  // New capture paths should use markExcluded so closure coverage is explicit.
  const markSeen = markExcluded;

  const enqueue = (recordId, meta = {}) => {
    if (!queueEnabled || syncCancellationState()) {
      return false;
    }
    const normalizedId = normalizeRecordId(recordId);
    if (!normalizedId) {
      return false;
    }

    seenIds.add(normalizedId);
    excludedIds.delete(normalizedId);
    enqueuedIds.add(normalizedId);
    latestMetaById.set(normalizedId, meta || {});
    if (activeJob?.recordId === normalizedId) {
      dirtyIds.add(normalizedId);
      emitState("requeue_requested", {recordId: normalizedId});
      return false;
    }
    if (pendingIds.has(normalizedId)) {
      const queuedJob = pendingJobs.find(
        (job) => job.recordId === normalizedId,
      );
      if (queuedJob) {
        queuedJob.meta = meta || queuedJob.meta || {};
      }
      return false;
    }

    pendingJobs.push({recordId: normalizedId, meta: meta || {}});
    pendingIds.add(normalizedId);
    stats.enqueuedCount += 1;
    emitState("queued", {recordId: normalizedId});
    ensureWorker();
    return true;
  };

  const enqueueMissing = (recordIds, meta = {}) => {
    if (syncCancellationState()) return 0;
    const ids = Array.isArray(recordIds) ? recordIds : [];
    let addedCount = 0;
    ids.forEach((recordId) => {
      const normalizedId = normalizeRecordId(recordId);
      if (!normalizedId || seenIds.has(normalizedId)) {
        return;
      }
      if (enqueue(normalizedId, meta)) {
        addedCount += 1;
      }
    });
    return addedCount;
  };

  const isRetryableResult = (result, context = {}) => {
    if (
      typeof shouldRetry !== "function" ||
      result?.ok !== false ||
      result?.blocked ||
      result?.skipped ||
      result?.canceled ||
      syncCancellationState()
    ) {
      return false;
    }
    try {
      return shouldRetry(result, context) === true;
    } catch (error) {
      console.warn("[RecordSyncQueue] Retry predicate failed:", error);
      return false;
    }
  };

  const waitForRetryDelay = async (delayMs) => {
    const finishAt = Date.now() + Math.max(0, Number(delayMs) || 0);
    while (Date.now() < finishAt) {
      if (syncCancellationState()) return false;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(0, finishAt - Date.now()))),
      );
    }
    return !syncCancellationState();
  };

  const processJob = async (job) => {
    if (syncCancellationState()) return;
    activeJob = job;
    pendingIds.delete(job.recordId);
    const latestMeta = latestMetaById.get(job.recordId) || job.meta || {};
    latestMetaById.delete(job.recordId);
    emitState("syncing", {recordId: job.recordId, meta: latestMeta});

    let result = null;
    let retryIndex = 0;
    while (true) {
      if (blockedError) {
        result = {ok: false, blocked: true, error: blockedError};
      } else {
        try {
          result =
            (await processRecord({
              recordId: job.recordId,
              meta: latestMeta,
              signal,
            })) || {ok: true};
        } catch (error) {
          result = {ok: false, error};
        }
      }

      if (
        retryIndex >= normalizedRetryDelaysMs.length ||
        !isRetryableResult(result, {
          recordId: job.recordId,
          meta: latestMeta,
          attempt: retryIndex + 1,
        })
      ) {
        break;
      }

      const retryDelayMs = normalizedRetryDelaysMs[retryIndex];
      retryIndex += 1;
      emitState("retry_wait", {
        recordId: job.recordId,
        meta: latestMeta,
        retryAttempt: retryIndex,
        retryDelayMs,
        result,
      });
      if (!(await waitForRetryDelay(retryDelayMs))) {
        result = {
          ok: false,
          canceled: true,
          skipped: true,
          reason: cancelReason || "capture_task_canceled",
        };
        break;
      }
      stats.retryCount += 1;
      emitState("retrying", {
        recordId: job.recordId,
        meta: latestMeta,
        retryAttempt: retryIndex,
      });
    }

    stats.processedCount += 1;
    if (result?.blocked) {
      blockedError = result.error || new Error("自动同步前检查失败");
    }
    if (result?.skipped) {
      stats.skippedCount += 1;
    } else if (result?.ok === false) {
      stats.failedCount += 1;
    } else {
      stats.successCount += 1;
      succeededIds.add(job.recordId);
    }

    emitState("settled", {
      recordId: job.recordId,
      meta: latestMeta,
      result,
    });
    activeJob = null;

    if (
      dirtyIds.delete(job.recordId) &&
      !blockedError &&
      !syncCancellationState()
    ) {
      enqueue(job.recordId, latestMetaById.get(job.recordId) || latestMeta);
    } else {
      latestMetaById.delete(job.recordId);
    }
  };

  const runWorker = async () => {
    while (pendingJobs.length > 0) {
      if (syncCancellationState()) break;
      const job = pendingJobs.shift();
      await processJob(job);
    }
  };

  function ensureWorker() {
    if (
      !queueEnabled ||
      workerPromise ||
      pendingJobs.length === 0 ||
      syncCancellationState()
    ) {
      return;
    }
    workerPromise = runWorker().finally(() => {
      workerPromise = null;
      if (pendingJobs.length > 0 && !syncCancellationState()) {
        ensureWorker();
      }
    });
  }

  const drain = async () => {
    if (!queueEnabled) {
      return getStats();
    }
    do {
      syncCancellationState();
      ensureWorker();
      const currentWorker = workerPromise;
      if (currentWorker) {
        await currentWorker;
      }
    } while (workerPromise || (!canceled && pendingJobs.length > 0) || activeJob);
    emitState(canceled ? "canceled" : "drained");
    return getStats();
  };

  return {
    enabled: queueEnabled,
    enqueue,
    enqueueMissing,
    registerCaptured,
    markExcluded,
    markSeen,
    hasSeen(recordId) {
      return seenIds.has(normalizeRecordId(recordId));
    },
    getStats,
    drain,
    cancel,
  };
}
