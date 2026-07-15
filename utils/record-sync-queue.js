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
} = {}) {
  const queueEnabled = Boolean(enabled);
  if (queueEnabled && typeof processRecord !== "function") {
    throw new TypeError("record sync queue requires processRecord");
  }

  const pendingJobs = [];
  const pendingIds = new Set();
  const seenIds = new Set();
  const dirtyIds = new Set();
  const latestMetaById = new Map();
  let activeJob = null;
  let workerPromise = null;
  let blockedError = null;
  const stats = {
    enqueuedCount: 0,
    processedCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
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
  });

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

  const markSeen = (recordId) => {
    const normalizedId = normalizeRecordId(recordId);
    if (!normalizedId) {
      return false;
    }
    seenIds.add(normalizedId);
    return true;
  };

  const enqueue = (recordId, meta = {}) => {
    if (!queueEnabled) {
      return false;
    }
    const normalizedId = normalizeRecordId(recordId);
    if (!normalizedId) {
      return false;
    }

    seenIds.add(normalizedId);
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

  const processJob = async (job) => {
    activeJob = job;
    pendingIds.delete(job.recordId);
    const latestMeta = latestMetaById.get(job.recordId) || job.meta || {};
    latestMetaById.delete(job.recordId);
    emitState("syncing", {recordId: job.recordId, meta: latestMeta});

    let result = null;
    if (blockedError) {
      result = {ok: false, blocked: true, error: blockedError};
    } else {
      try {
        result =
          (await processRecord({
            recordId: job.recordId,
            meta: latestMeta,
          })) || {ok: true};
      } catch (error) {
        result = {ok: false, error};
      }
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
    }

    emitState("settled", {
      recordId: job.recordId,
      meta: latestMeta,
      result,
    });
    activeJob = null;

    if (dirtyIds.delete(job.recordId) && !blockedError) {
      enqueue(job.recordId, latestMetaById.get(job.recordId) || latestMeta);
    } else {
      latestMetaById.delete(job.recordId);
    }
  };

  const runWorker = async () => {
    while (pendingJobs.length > 0) {
      const job = pendingJobs.shift();
      await processJob(job);
    }
  };

  function ensureWorker() {
    if (!queueEnabled || workerPromise || pendingJobs.length === 0) {
      return;
    }
    workerPromise = runWorker().finally(() => {
      workerPromise = null;
      if (pendingJobs.length > 0) {
        ensureWorker();
      }
    });
  }

  const drain = async () => {
    if (!queueEnabled) {
      return getStats();
    }
    do {
      ensureWorker();
      const currentWorker = workerPromise;
      if (currentWorker) {
        await currentWorker;
      }
    } while (workerPromise || pendingJobs.length > 0 || activeJob);
    emitState("drained");
    return getStats();
  };

  return {
    enabled: queueEnabled,
    enqueue,
    enqueueMissing,
    markSeen,
    hasSeen(recordId) {
      return seenIds.has(normalizeRecordId(recordId));
    },
    getStats,
    drain,
  };
}
