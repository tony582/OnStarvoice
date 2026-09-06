// L2 cancellation: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createCancellationStage({state, ports, operations}) {
  const {
    SYNC_STATUS,
    updateSync,
  } = ports;



  function isSyncCancellationRequested(shouldStop, signal = null) {
    if (signal?.aborted === true) return true;
    if (typeof shouldStop !== 'function') return false;
    try {
      return shouldStop() === true;
    } catch {
      return true;
    }
  }

  function buildCanceledSyncResult(overrides = {}) {
    return {
      ok: false,
      canceled: true,
      skipped: true,
      reason: 'capture_task_canceled',
      message: '任务已取消，未继续同步',
      error: null,
      ...overrides,
    };
  }

  async function resetCanceledSyncState() {
    await updateSync({
      status: SYNC_STATUS.IDLE,
      error: null,
    }).catch(() => null);
  }

  function buildCanceledBatchSyncResult({
    requestedRecordIds = [],
    recordIdsToSync = [],
    skippedRecordIds = [],
    results = [],
    commentLeadsSyncedCount = 0,
    commentLeadsSkippedCount = 0,
    commentLeadsFailedCount = 0,
    commentLeadsCanceledRecordIds = [],
  } = {}) {
    const completedRecordIds = new Set(
      results.map((result) => String(result?.recordId || '').trim()).filter(Boolean),
    );
    const canceledRecordIds = recordIdsToSync.filter(
      (recordId) => !completedRecordIds.has(recordId),
    );
    return buildCanceledSyncResult({
      skipped: false,
      results,
      successCount: results.filter((result) => result?.success === true).length,
      failedCount: results.filter((result) => result?.success === false).length,
      canceledCount: canceledRecordIds.length,
      canceledRecordIds,
      requestedCount: requestedRecordIds.length,
      syncedCount: recordIdsToSync.length - canceledRecordIds.length,
      skippedCount: skippedRecordIds.length,
      commentLeadsSyncedCount,
      commentLeadsSkippedCount,
      commentLeadsFailedCount,
      commentLeadsCanceledCount: commentLeadsCanceledRecordIds.length,
      commentLeadsCanceledRecordIds: [...commentLeadsCanceledRecordIds],
    });
  }

  return Object.freeze({
    isSyncCancellationRequested,
    buildCanceledSyncResult,
    resetCanceledSyncState,
    buildCanceledBatchSyncResult,
  });
}
