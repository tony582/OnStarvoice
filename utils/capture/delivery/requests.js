// L2 requests: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createRequestsStage({state, ports, operations}) {
  const {
    ERROR_REASON,
    MAX_SYNC_COMMENT_RICH_RECORDS_PER_REQUEST,
    MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST,
    MAX_SYNC_RECORDS_PER_REQUEST,
    SYNC_BATCH_REQUEST_SPACING_MS,
    SYNC_LARGE_RECORD_BYTES_PER_REQUEST,
    SYNC_RATE_LIMIT_RETRY_ATTEMPTS,
    SYNC_RATE_LIMIT_RETRY_BASE_DELAY_MS,
    SYNC_RATE_LIMIT_RETRY_MAX_DELAY_MS,
    isIndeterminateBatchResult,
    isIndeterminateSyncItem,
    isRateLimitedBatchResult,
    isRateLimitedSyncItem,
    normalizeBatchFailureReason,
    normalizeSyncItemFailureReason,
    syncBatch,
  } = ports;
  const applySyncRecordResultItem = (...args) => operations.applySyncRecordResultItem(...args);
  const buildSyncBatchRecordInput = (...args) => operations.buildSyncBatchRecordInput(...args);
  const buildSyncPausedMetadata = (...args) => operations.buildSyncPausedMetadata(...args);
  const buildSyncRecordResultItem = (...args) => operations.buildSyncRecordResultItem(...args);
  const canContinueAfterIsolatedSyncPause = (...args) => operations.canContinueAfterIsolatedSyncPause(...args);
  const chunkSyncRecordsForRequest = (...args) => operations.chunkSyncRecordsForRequest(...args);
  const collectQueuedSyncRecords = (...args) => operations.collectQueuedSyncRecords(...args);
  const getSyncBatchItems = (...args) => operations.getSyncBatchItems(...args);
  const isCommentRichSyncRecord = (...args) => operations.isCommentRichSyncRecord(...args);
  const isSyncCancellationRequested = (...args) => operations.isSyncCancellationRequested(...args);
  const normalizeSyncAttemptCount = (...args) => operations.normalizeSyncAttemptCount(...args);
  const normalizeSyncDelayMs = (...args) => operations.normalizeSyncDelayMs(...args);
  const resolveRateLimitRetryDelayMs = (...args) => operations.resolveRateLimitRetryDelayMs(...args);
  const waitForCancelableSyncDelay = (...args) => operations.waitForCancelableSyncDelay(...args);
  const waitForSyncRequestSlot = (...args) => operations.waitForSyncRequestSlot(...args);


  async function syncGroupRecordsWithRetry({
    group,
    requestTarget,
    onProgress = null,
    completedOffset = 0,
    totalCount = 0,
    requestSpacingMs,
    rateLimitBaseDelayMs,
    rateLimitMaxDelayMs,
    rateLimitRetryAttempts,
    shouldStop = null,
    signal = null,
  } = {}) {
    const groupRecords = Array.isArray(group?.records) ? group.records : [];
    const queue = chunkSyncRecordsForRequest(groupRecords).map((records) => ({
      records,
    }));
    const normalizedRequestSpacingMs = normalizeSyncDelayMs(
      requestSpacingMs,
      SYNC_BATCH_REQUEST_SPACING_MS,
    );
    const normalizedRateLimitBaseDelayMs = normalizeSyncDelayMs(
      rateLimitBaseDelayMs,
      SYNC_RATE_LIMIT_RETRY_BASE_DELAY_MS,
    );
    const normalizedRateLimitMaxDelayMs = normalizeSyncDelayMs(
      rateLimitMaxDelayMs,
      SYNC_RATE_LIMIT_RETRY_MAX_DELAY_MS,
    );
    const normalizedRateLimitRetryAttempts = normalizeSyncAttemptCount(
      rateLimitRetryAttempts,
      SYNC_RATE_LIMIT_RETRY_ATTEMPTS,
    );
    const syncDiagnostics = {
      maxRecordsPerRequest: MAX_SYNC_RECORDS_PER_REQUEST,
      maxPayloadBytesPerRequest: MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST,
      maxCommentRichRecordsPerRequest: MAX_SYNC_COMMENT_RICH_RECORDS_PER_REQUEST,
      largeRecordBytesPerRequest: SYNC_LARGE_RECORD_BYTES_PER_REQUEST,
      commentRichRecordCount: groupRecords.filter(isCommentRichSyncRecord).length,
      requestSpacingMs: normalizedRequestSpacingMs,
      initialChunkSizes: queue.map((item) => item.records.length),
      requestCount: 0,
      chunkSizes: [],
      rateLimitRetryCount: 0,
      rateLimitRetryDelaysMs: [],
      paused: false,
      pausedReason: '',
      pausedCount: 0,
    };
    const groupResults = [];
    const nonBlockingPausedRecords = [];
    const nonBlockingPausedReasons = new Set();
    let requestIndex = 0;
    let lastRequestStartedAt = 0;
    let syncPaused = null;
    let syncCanceled = false;

    const emitProgress = (message, extra = {}) => {
      if (!onProgress) return;
      onProgress({
        phase: 'batch_sync',
        current: completedOffset + groupResults.length,
        total: totalCount,
        message,
        ...extra,
      });
    };

    while (queue.length > 0) {
      if (isSyncCancellationRequested(shouldStop, signal)) {
        syncCanceled = true;
        break;
      }
      if (syncPaused) {
        break;
      }

      const work = queue.shift();
      const chunkRecords = Array.isArray(work?.records)
        ? work.records.filter(Boolean)
        : [];

      if (chunkRecords.length === 0) {
        continue;
      }

      requestIndex += 1;
      const plannedRequestCount = requestIndex + queue.length;
      emitProgress(
        plannedRequestCount > 1
          ? `正在同步第 ${requestIndex}/${plannedRequestCount} 组...`
          : `正在批量同步 ${chunkRecords.length} 条记录...`,
      );

      let batchResult = null;
      for (let attempt = 0; attempt <= normalizedRateLimitRetryAttempts; attempt += 1) {
        if (isSyncCancellationRequested(shouldStop, signal)) {
          syncCanceled = true;
          break;
        }
        if (lastRequestStartedAt > 0) {
          const waitCompleted = await waitForSyncRequestSlot(
            lastRequestStartedAt,
            normalizedRequestSpacingMs,
            shouldStop,
            signal,
          );
          if (!waitCompleted) {
            syncCanceled = true;
            break;
          }
        }

        if (isSyncCancellationRequested(shouldStop, signal)) {
          syncCanceled = true;
          break;
        }
        lastRequestStartedAt = Date.now();
        syncDiagnostics.requestCount += 1;
        syncDiagnostics.chunkSizes.push(chunkRecords.length);
        batchResult = await runSyncBatchRequest(
          chunkRecords,
          requestTarget,
          shouldStop,
          signal,
        );
        if (batchResult?.canceled) {
          syncCanceled = true;
          break;
        }

        const attemptItems = getSyncBatchItems(batchResult);
        const allItemsRateLimited =
          attemptItems.length > 0 &&
          attemptItems.every(
            (item) => item?.ok !== true && isRateLimitedSyncItem(item, batchResult),
          );
        if (!isRateLimitedBatchResult(batchResult) && !allItemsRateLimited) {
          break;
        }

        if (attempt >= normalizedRateLimitRetryAttempts) {
          break;
        }

        const delayMs = resolveRateLimitRetryDelayMs(batchResult, attempt, {
          baseDelayMs: normalizedRateLimitBaseDelayMs,
          maxDelayMs: normalizedRateLimitMaxDelayMs,
        });
        syncDiagnostics.rateLimitRetryCount += 1;
        syncDiagnostics.rateLimitRetryDelaysMs.push(delayMs);
        emitProgress(
          `同步接口触发限流，${Math.ceil(delayMs / 1000)} 秒后重试当前 ${chunkRecords.length} 条...`,
        );
        const retryWaitCompleted = await waitForCancelableSyncDelay(
          delayMs,
          shouldStop,
          signal,
        );
        if (!retryWaitCompleted) {
          syncCanceled = true;
          break;
        }
      }

      if (syncCanceled) break;

      const batchItems = getSyncBatchItems(batchResult);
      const batchItemMap = new Map(
        batchItems
          .filter((item) => item && typeof item === 'object' && item.recordId)
          .map((item) => [item.recordId, item]),
      );

      if (isRateLimitedBatchResult(batchResult)) {
        const pausedRecords = [
          ...nonBlockingPausedRecords,
          ...chunkRecords,
          ...collectQueuedSyncRecords(queue),
        ];
        syncPaused = buildSyncPausedMetadata({
          reason: 'rate_limited',
          message: `同步接口触发限流，已确认成功 ${groupResults.length} 条，剩余 ${pausedRecords.length} 条待稍后继续`,
          pausedRecords,
          batchResult,
          blocking: true,
        });
        break;
      }

      if (batchItems.length === 0 && isIndeterminateBatchResult(batchResult)) {
        if (canContinueAfterIsolatedSyncPause(chunkRecords)) {
          nonBlockingPausedRecords.push(...chunkRecords);
          nonBlockingPausedReasons.add(
            normalizeBatchFailureReason(batchResult) || 'sync_result_unknown',
          );
          emitProgress(
            `当前记录同步超时，已保留待继续，正在尝试后续记录...`,
          );
          continue;
        }

        const pausedRecords = [
          ...nonBlockingPausedRecords,
          ...chunkRecords,
          ...collectQueuedSyncRecords(queue),
        ];
        syncPaused = buildSyncPausedMetadata({
          reason: normalizeBatchFailureReason(batchResult) || 'sync_result_unknown',
          message: `同步请求超时或中断，已确认成功 ${groupResults.length} 条，剩余 ${pausedRecords.length} 条待继续`,
          pausedRecords,
          batchResult,
          blocking: true,
        });
        break;
      }

      const pausedRecords = [];
      const finalResults = [];

      for (const record of chunkRecords) {
        const item = batchItemMap.get(record.id);
        const resultItem = buildSyncRecordResultItem(record, item, batchResult);

        if (!resultItem.success && isRateLimitedSyncItem(item, batchResult)) {
          pausedRecords.push(record);
          continue;
        }

        if (!resultItem.success && isIndeterminateSyncItem(item, batchResult)) {
          pausedRecords.push(record);
          continue;
        }

        finalResults.push(resultItem);
      }

      for (const resultItem of finalResults) {
        await applySyncRecordResultItem(resultItem);
        groupResults.push(resultItem);

        emitProgress(`正在处理第 ${completedOffset + groupResults.length}/${totalCount} 条记录...`, {
          recordId: resultItem.recordId,
        });
      }

      if (pausedRecords.length > 0) {
        if (canContinueAfterIsolatedSyncPause(pausedRecords)) {
          nonBlockingPausedRecords.push(...pausedRecords);
          const firstPausedItem = pausedRecords
            .map((record) => batchItemMap.get(record.id))
            .find(Boolean);
          nonBlockingPausedReasons.add(
            normalizeSyncItemFailureReason(firstPausedItem, batchResult) ||
              'sync_result_unknown',
          );
          emitProgress(
            `当前记录同步结果未知，已保留待继续，正在尝试后续记录...`,
          );
          continue;
        }

        const remainingRecords = [...pausedRecords, ...collectQueuedSyncRecords(queue)];
        const firstPausedItem = pausedRecords
          .map((record) => batchItemMap.get(record.id))
          .find(Boolean);
        const pauseReason = isRateLimitedSyncItem(firstPausedItem, batchResult)
          ? 'rate_limited'
          : normalizeSyncItemFailureReason(firstPausedItem, batchResult) ||
            'sync_result_unknown';
        syncPaused = buildSyncPausedMetadata({
          reason: pauseReason,
          message:
            pauseReason === 'rate_limited'
              ? `同步接口触发限流，已确认成功 ${groupResults.length} 条，剩余 ${remainingRecords.length} 条待稍后继续`
              : `同步请求超时或结果未知，已确认成功 ${groupResults.length} 条，剩余 ${remainingRecords.length} 条待继续`,
          pausedRecords: remainingRecords,
          batchResult,
          blocking: true,
        });
        break;
      }
    }

    if (!syncPaused && nonBlockingPausedRecords.length > 0) {
      const pausedCount = Array.from(
        new Set(nonBlockingPausedRecords.map((record) => record?.id).filter(Boolean)),
      ).length;
      const primaryReason =
        Array.from(nonBlockingPausedReasons).find(Boolean) || 'sync_result_unknown';
      syncPaused = buildSyncPausedMetadata({
        reason: primaryReason,
        message: `部分记录同步超时或结果未知，已确认成功 ${groupResults.length} 条，剩余 ${pausedCount} 条待继续`,
        pausedRecords: nonBlockingPausedRecords,
        batchResult: null,
        blocking: false,
      });
    }

    if (syncPaused) {
      syncDiagnostics.paused = true;
      syncDiagnostics.pausedReason = syncPaused.reason;
      syncDiagnostics.pausedCount = syncPaused.pausedCount;
      syncDiagnostics.pausedBlocking = syncPaused.blocking !== false;
    }
    if (syncCanceled) {
      syncDiagnostics.canceled = true;
    }

    Object.defineProperty(groupResults, 'syncDiagnostics', {
      value: syncDiagnostics,
      enumerable: false,
    });
    if (syncPaused) {
      Object.defineProperty(groupResults, 'syncPaused', {
        value: syncPaused,
        enumerable: false,
      });
    }
    if (syncCanceled) {
      Object.defineProperty(groupResults, 'syncCanceled', {
        value: true,
        enumerable: false,
      });
    }
    return groupResults;
  }

  async function runSyncBatchRequest(
    records,
    requestTarget,
    shouldStop = null,
    signal = null,
  ) {
    try {
      return await syncBatch(
        records.map(buildSyncBatchRecordInput),
        requestTarget,
        {shouldStop, signal},
      );
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        reason: ERROR_REASON.NETWORK_ERROR,
        message: error?.message || 'Network error',
        error: {
          reason: ERROR_REASON.NETWORK_ERROR,
          message: error?.message || 'Network error',
        },
        data: null,
      };
    }
  }

  return Object.freeze({
    syncGroupRecordsWithRetry,
    runSyncBatchRequest,
  });
}
