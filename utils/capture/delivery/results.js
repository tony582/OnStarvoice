// L2 results: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createResultsStage({state, ports, operations}) {
  const {
    ERROR_REASON,
    RECORD_STATUS,
    markRecordSynced,
    updateRecord,
  } = ports;
  const getSingleNoteType = (...args) => operations.getSingleNoteType(...args);


  function extractDebugUrl(syncResult) {
    if (!syncResult || typeof syncResult !== 'object') {
      return '';
    }

    const topLevelDebugUrl = syncResult.data?.debugUrl;
    if (typeof topLevelDebugUrl === 'string' && topLevelDebugUrl.trim()) {
      return topLevelDebugUrl.trim();
    }

    const nestedDebugUrl = syncResult.data?.cozeResult?.debug_url;
    if (typeof nestedDebugUrl === 'string' && nestedDebugUrl.trim()) {
      return nestedDebugUrl.trim();
    }

    return '';
  }

  function buildSyncRecordResultItem(record, item, batchResult) {
    const debugUrl =
      normalizeDebugUrl(item?.debugUrl) ||
      (batchResult?.ok ? extractDebugUrl(batchResult) : '');
    const success = item?.ok === true;
    const reason =
      item?.reason ||
      (success
        ? ERROR_REASON.NONE
        : batchResult?.reason ||
          batchResult?.error?.reason ||
          batchResult?.error?.code ||
          'SYNC_ERROR');
    const message =
      item?.message ||
      (success
        ? '同步成功'
        : batchResult?.message || batchResult?.error?.message || '同步失败');

    return {
      recordId: record.id,
      platform: record.platform || 'unknown',
      type: record.syncType || record.type,
      sourceType: record.sourceType || record.type,
      workflow: record.workflow || '',
      noteType:
        (record.syncType || record.type) === 'single_note'
          ? getSingleNoteType(record.syncPayload || record.payload)
          : null,
      success,
      reason,
      message,
      debugUrl: debugUrl || null,
      rawResponse: item?.rawResponse || batchResult,
      error: success
        ? null
        : {
            reason,
            message,
          },
    };
  }

  async function applySyncRecordResultItem(resultItem) {
    if (!resultItem?.recordId) return;

    if (resultItem.success) {
      await markRecordSynced(resultItem.recordId, resultItem.debugUrl || null);
      return;
    }

    await updateRecord(resultItem.recordId, {
      status: RECORD_STATUS.FAILED,
      lastSyncedAt: Date.now(),
      lastSyncReason: resultItem.reason,
      lastSyncDebugUrl: resultItem.debugUrl || null,
    });
  }

  function getSyncBatchItems(batchResult) {
    return Array.isArray(batchResult?.data?.items) ? batchResult.data.items : [];
  }

  function collectQueuedSyncRecords(queue = []) {
    return Array.isArray(queue)
      ? queue.flatMap((item) =>
          Array.isArray(item?.records) ? item.records.filter(Boolean) : [],
        )
      : [];
  }

  function buildSyncPausedMetadata({
    reason,
    message,
    pausedRecords = [],
    batchResult = null,
    blocking = true,
  } = {}) {
    const pausedRecordIds = Array.from(
      new Set(
        (Array.isArray(pausedRecords) ? pausedRecords : [])
          .map((record) => String(record?.id || '').trim())
          .filter(Boolean),
      ),
    );

    return {
      reason: String(reason || 'sync_result_unknown').trim() || 'sync_result_unknown',
      message:
        String(message || '').trim() ||
        `同步已暂停，剩余 ${pausedRecordIds.length} 条待继续`,
      pausedCount: pausedRecordIds.length,
      pausedRecordIds,
      rawResponse: batchResult,
      blocking: blocking !== false,
    };
  }

  function extendSyncPausedMetadata(paused, additionalRecords = [], {
    confirmedSuccessCount = 0,
  } = {}) {
    if (!paused || typeof paused !== 'object') {
      return paused;
    }
    const additionalRecordIds = (Array.isArray(additionalRecords) ? additionalRecords : [])
      .map((record) => String(record?.id || '').trim())
      .filter(Boolean);

    const pausedRecordIds = Array.from(
      new Set([
        ...(Array.isArray(paused.pausedRecordIds) ? paused.pausedRecordIds : []),
        ...additionalRecordIds,
      ]),
    );
    const reason = String(paused.reason || 'sync_result_unknown').trim();

    return {
      ...paused,
      pausedCount: pausedRecordIds.length,
      pausedRecordIds,
      message: formatSyncPausedMessage(reason, confirmedSuccessCount, pausedRecordIds.length),
    };
  }

  function mergeSyncPausedMetadata(current, next, {
    confirmedSuccessCount = 0,
  } = {}) {
    if (!current || typeof current !== 'object') {
      return extendSyncPausedMetadata(next, [], { confirmedSuccessCount });
    }
    if (!next || typeof next !== 'object') {
      return extendSyncPausedMetadata(current, [], { confirmedSuccessCount });
    }

    const pausedRecordIds = Array.from(
      new Set([
        ...(Array.isArray(current.pausedRecordIds) ? current.pausedRecordIds : []),
        ...(Array.isArray(next.pausedRecordIds) ? next.pausedRecordIds : []),
      ]),
    );
    const reasons = [
      String(current.reason || '').trim(),
      String(next.reason || '').trim(),
    ].filter(Boolean);
    const reason = reasons.includes('rate_limited')
      ? 'rate_limited'
      : Array.from(new Set(reasons)).length === 1
        ? reasons[0]
        : 'sync_result_unknown';

    return {
      ...current,
      ...next,
      reason,
      blocking: current.blocking !== false || next.blocking !== false,
      pausedCount: pausedRecordIds.length,
      pausedRecordIds,
      rawResponse: next.rawResponse || current.rawResponse || null,
      message: formatSyncPausedMessage(reason, confirmedSuccessCount, pausedRecordIds.length),
    };
  }

  function formatSyncPausedMessage(reason, confirmedSuccessCount, pausedCount) {
    const isRateLimited = String(reason || '').trim() === 'rate_limited';
    return isRateLimited
      ? `同步接口触发限流，已确认成功 ${confirmedSuccessCount} 条，剩余 ${pausedCount} 条待稍后继续`
      : `同步请求超时或结果未知，已确认成功 ${confirmedSuccessCount} 条，剩余 ${pausedCount} 条待继续`;
  }

  function normalizeDebugUrl(url) {
    if (typeof url !== 'string') {
      return '';
    }

    const trimmed = url.trim();
    return trimmed || '';
  }

  function pickBatchDebugUrl(results) {
    const failedWithDebug = results.find(
      (result) => !result?.success && normalizeDebugUrl(result?.debugUrl)
    );
    if (failedWithDebug?.debugUrl) {
      return normalizeDebugUrl(failedWithDebug.debugUrl);
    }

    const firstWithDebug = results.find((result) =>
      normalizeDebugUrl(result?.debugUrl)
    );
    if (firstWithDebug?.debugUrl) {
      return normalizeDebugUrl(firstWithDebug.debugUrl);
    }

    return '';
  }

  return Object.freeze({
    extractDebugUrl,
    buildSyncRecordResultItem,
    applySyncRecordResultItem,
    getSyncBatchItems,
    collectQueuedSyncRecords,
    buildSyncPausedMetadata,
    extendSyncPausedMetadata,
    mergeSyncPausedMetadata,
    formatSyncPausedMessage,
    normalizeDebugUrl,
    pickBatchDebugUrl,
  });
}
