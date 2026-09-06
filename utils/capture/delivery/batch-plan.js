// L2 batch-plan: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createBatchPlanStage({state, ports, operations}) {
  const {
    MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST,
    MAX_SYNC_RECORDS_PER_REQUEST,
    MAX_SYNC_REQUEST_PAYLOAD_BYTES,
    SYNC_COMMENT_RICH_RECORD_MIN_COMMENTS,
    SYNC_LARGE_RECORD_BYTES_PER_REQUEST,
    SYNC_TYPE,
    waitMs,
  } = ports;
  const isSyncCancellationRequested = (...args) => operations.isSyncCancellationRequested(...args);


  function buildSyncBatchRecordInput(record) {
    const syncType = record.syncType || record.type;
    return {
      id: record.id,
      type: syncType,
      platform: record.platform || '',
      workflow: record.workflow || '',
      monitorExecutionId: record.monitorExecutionId || '',
      captureTaskId: record.captureTaskId || '',
      captureTaskItemAttemptId: record.captureTaskItemAttemptId || '',
      captureTaskItemRequestHash: record.captureTaskItemRequestHash || '',
      payload: buildSyncRequestPayload(syncType, record.syncPayload || record.payload),
    };
  }

  function buildSyncBatchRecordRequestShape(record) {
    const syncType = record.syncType || record.type;
    return {
      recordId: record.id,
      syncType,
      platform: record.platform || '',
      workflow: record.workflow || '',
      monitorExecutionId: record.monitorExecutionId || '',
      captureTaskId: record.captureTaskId || '',
      captureTaskItemAttemptId: record.captureTaskItemAttemptId || '',
      captureTaskItemRequestHash: record.captureTaskItemRequestHash || '',
      payload: buildSyncRequestPayload(syncType, record.syncPayload || record.payload),
    };
  }

  function buildSyncRequestPayload(syncType, payload) {
    const normalizedType = String(syncType || '').trim();
    if (
      normalizedType === SYNC_TYPE.COMMENTS ||
      normalizedType === SYNC_TYPE.COMMENT_LEADS
    ) {
      return payload;
    }
    // 内容同步必须【原样发送】，不剔除结构化评论。
    // 当前没有独立的评论同步通道，服务端通过内容同步包里的 commentsCleanedItems 入库。
    // record_comments → 评论分诊/销售客资/评论时间。若通过
    // stripCommentCollectionsForContentSync 剔除评论数组，会导致关键词笔记采集
    // 的评论只剩合并文本、进不了表（列表能看到，但弹窗/分诊/客资全空），故此处不剔除。
    return payload;
  }

  function stripCommentCollectionsForContentSync(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') {
      return value;
    }
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => stripCommentCollectionsForContentSync(item, seen));
    }

    const result = {};
    Object.entries(value).forEach(([key, nestedValue]) => {
      const isCommentCollection =
        key === 'commentsCleanedItems' ||
        key === 'commentsItems' ||
        key === 'commentItems' ||
        key === 'commentLeadsItems' ||
        (key === 'comments' && Array.isArray(nestedValue));
      if (isCommentCollection) {
        return;
      }
      result[key] = stripCommentCollectionsForContentSync(nestedValue, seen);
    });
    return result;
  }

  function normalizeSyncDelayMs(value, fallback) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }

  function normalizeSyncAttemptCount(value, fallback) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }

  function resolveRateLimitRetryDelayMs(batchResult, attempt, {
    baseDelayMs,
    maxDelayMs,
  } = {}) {
    const explicitMs = Number(
      batchResult?.data?.retryAfterMs ||
        batchResult?.data?.retry_after_ms ||
        batchResult?.retryAfterMs,
    );
    if (Number.isFinite(explicitMs) && explicitMs > 0) {
      return Math.min(Math.floor(explicitMs), maxDelayMs);
    }

    const explicitSeconds = Number(
      batchResult?.data?.retryAfterSeconds ||
        batchResult?.data?.retry_after_seconds ||
        batchResult?.retryAfterSeconds,
    );
    if (Number.isFinite(explicitSeconds) && explicitSeconds > 0) {
      return Math.min(Math.floor(explicitSeconds * 1000), maxDelayMs);
    }

    const multiplier = 2 ** Math.max(0, Math.floor(Number(attempt) || 0));
    return Math.min(Math.max(0, baseDelayMs) * multiplier, maxDelayMs);
  }

  function sleep(ms) {
    const delay = Math.max(0, Math.floor(Number(ms) || 0));
    if (delay <= 0) {
      return Promise.resolve();
    }
    // 走可靠时钟(Worker),后台标签页里不被 Chrome 节流;见 waitMs 上方注释。
    return waitMs(delay);
  }

  async function waitForCancelableSyncDelay(
    delayMs,
    shouldStop = null,
    signal = null,
    pollMs = 100,
  ) {
    let remainingMs = Math.max(0, Math.floor(Number(delayMs) || 0));
    const intervalMs = Math.max(25, Math.floor(Number(pollMs) || 100));
    while (remainingMs > 0) {
      if (isSyncCancellationRequested(shouldStop, signal)) return false;
      const currentDelayMs = Math.min(intervalMs, remainingMs);
      await sleep(currentDelayMs);
      remainingMs -= currentDelayMs;
    }
    return !isSyncCancellationRequested(shouldStop, signal);
  }

  async function waitForSyncRequestSlot(
    lastRequestStartedAt,
    spacingMs,
    shouldStop = null,
    signal = null,
  ) {
    const spacing = Math.max(0, Math.floor(Number(spacingMs) || 0));
    if (!lastRequestStartedAt || spacing <= 0) {
      return !isSyncCancellationRequested(shouldStop, signal);
    }
    const elapsedMs = Date.now() - lastRequestStartedAt;
    if (elapsedMs >= spacing) {
      return !isSyncCancellationRequested(shouldStop, signal);
    }
    return await waitForCancelableSyncDelay(
      spacing - elapsedMs,
      shouldStop,
      signal,
    );
  }

  function canContinueAfterIsolatedSyncPause(records = []) {
    const safeRecords = (Array.isArray(records) ? records : []).filter(Boolean);
    return safeRecords.length === 1 && isIsolatedHeavySyncRecord(safeRecords[0]);
  }

  function isIsolatedHeavySyncRecord(record = {}) {
    if (!record || typeof record !== 'object') {
      return false;
    }
    if (isCommentRichSyncRecord(record)) {
      return true;
    }
    return (
      estimateJsonBytes(buildSyncBatchRecordRequestShape(record)) >=
      SYNC_LARGE_RECORD_BYTES_PER_REQUEST
    );
  }

  function chunkSyncRecordsForRequest(records = [], options = {}) {
    if (!Array.isArray(records) || records.length === 0) {
      return [];
    }

    const chunkOptions =
      typeof options === 'number' ? { maxRecords: options } : options || {};
    const maxRecords = Math.max(
      1,
      Math.floor(Number(chunkOptions.maxRecords || MAX_SYNC_RECORDS_PER_REQUEST)) || 1,
    );
    const maxPayloadBytes = Math.max(
      1,
      Math.floor(
        Number(
          chunkOptions.maxPayloadBytes || MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST,
        ),
      ) || MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST,
    );
    const chunks = [];
    let currentChunk = [];
    let currentBytes = 0;

    const flushCurrentChunk = () => {
      if (currentChunk.length === 0) return;
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    };

    for (const record of records) {
      const recordBytes = estimateJsonBytes(buildSyncBatchRecordRequestShape(record));
      if (isIsolatedHeavySyncRecord(record)) {
        flushCurrentChunk();
        currentChunk.push(record);
        currentBytes += recordBytes;
        flushCurrentChunk();
        continue;
      }

      const wouldExceedCount = currentChunk.length >= maxRecords;
      const wouldExceedBytes =
        currentChunk.length > 0 && currentBytes + recordBytes > maxPayloadBytes;

      if (wouldExceedCount || wouldExceedBytes) {
        flushCurrentChunk();
      }

      currentChunk.push(record);
      currentBytes += recordBytes;

      if (currentChunk.length >= maxRecords || currentBytes >= maxPayloadBytes) {
        flushCurrentChunk();
      }
    }

    flushCurrentChunk();
    return chunks;
  }

  function isCommentRichSyncRecord(record = {}) {
    const payload =
      record?.syncPayload && typeof record.syncPayload === 'object'
        ? record.syncPayload
        : record?.payload && typeof record.payload === 'object'
          ? record.payload
          : {};
    return countPayloadCommentItems(payload) >= SYNC_COMMENT_RICH_RECORD_MIN_COMMENTS;
  }

  function countPayloadCommentItems(value, seen = new Set()) {
    if (!value || typeof value !== 'object') {
      return 0;
    }
    if (seen.has(value)) {
      return 0;
    }
    seen.add(value);

    let count = 0;
    const candidates = [
      value.commentsCleanedItems,
      value.commentsItems,
      value.comments,
    ];
    candidates.forEach((candidate) => {
      if (Array.isArray(candidate)) {
        count += candidate.length;
      }
    });

    const mergedText = String(value.commentsMergedText || '').trim();
    if (mergedText) {
      count += 1;
    }

    const detailPayload =
      value.detailPayload && typeof value.detailPayload === 'object'
        ? value.detailPayload
        : null;
    if (detailPayload) {
      count += countPayloadCommentItems(detailPayload, seen);
    }

    if (Array.isArray(value.items)) {
      value.items.forEach((item) => {
        count += countPayloadCommentItems(item, seen);
      });
    }

    return count;
  }

  function estimateJsonBytes(value) {
    let text = '';
    try {
      text = JSON.stringify(value) || '';
    } catch {
      return MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST + 1;
    }

    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).length;
    }

    return text.length * 2;
  }

  function buildWorkflowSyncGroups(records = []) {
    if (!Array.isArray(records) || records.length === 0) {
      return [];
    }

    const orderedTypes = new Map([
      [SYNC_TYPE.BLOGGER_PROFILE, 0],
      [SYNC_TYPE.BLOGGER_NOTES, 1],
      [SYNC_TYPE.KEYWORD_NOTES, 2],
      [SYNC_TYPE.SINGLE_NOTE, 3],
      [SYNC_TYPE.COMMENTS, 4],
      [SYNC_TYPE.COMMENT_LEADS, 5],
    ]);
    const groupsByKey = new Map();

    records.forEach((record) => {
      const syncType = String(record?.syncType || record?.type || '').trim();
      const platform = String(record?.platform || 'unknown').trim() || 'unknown';
      const workflow = String(record?.workflow || '').trim();
      // For keyword_notes, include keyword in group key so each keyword gets its own
      // syncBatch call. This prevents rapid sequential Coze calls within a single request
      // from causing silent failures where only the first keyword's data is written to Feishu.
      const keywordSuffix =
        syncType === SYNC_TYPE.KEYWORD_NOTES
          ? `::kw:${String(
              record?.syncPayload?.keyword || record?.payload?.keyword || '',
            ).trim()}`
          : '';
      const key = `${platform}::${syncType}::${workflow}${keywordSuffix}`;
      const existing = groupsByKey.get(key);
      if (existing) {
        existing.records.push(record);
        return;
      }
      groupsByKey.set(key, {
        platform,
        syncType,
        workflow,
        records: [record],
      });
    });

    return Array.from(groupsByKey.values()).sort((left, right) => {
      const leftOrder = orderedTypes.has(left.syncType)
        ? orderedTypes.get(left.syncType)
        : Number.MAX_SAFE_INTEGER;
      const rightOrder = orderedTypes.has(right.syncType)
        ? orderedTypes.get(right.syncType)
        : Number.MAX_SAFE_INTEGER;

      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      if (left.platform !== right.platform) {
        return left.platform.localeCompare(right.platform);
      }
      return left.workflow.localeCompare(right.workflow);
    });
  }

  function buildSyncBatchRecord(record) {
    return {
      id: record.id,
      type: record.syncType || record.type,
      platform: record.platform,
      workflow: record.workflow,
      monitorExecutionId: record.monitorExecutionId || '',
      captureTaskId: record.captureTaskId || '',
      captureTaskItemAttemptId: record.captureTaskItemAttemptId || '',
      captureTaskItemRequestHash: record.captureTaskItemRequestHash || '',
      payload: record.syncPayload || record.payload,
    };
  }

  function estimateSyncBatchRecordBytes(record) {
    try {
      return JSON.stringify(buildSyncBatchRecord(record)).length;
    } catch {
      return MAX_SYNC_REQUEST_PAYLOAD_BYTES;
    }
  }

  function getSingleNoteType(payload) {
    const normalized = String(payload?.noteType || payload?.type || '').trim().toLowerCase();
    if (normalized === 'video' || normalized === '视频') {
      return 'video';
    }
    if (
      normalized === 'image' ||
      normalized === 'img' ||
      normalized === '图文' ||
      normalized === 'normal'
    ) {
      return 'image';
    }

    if (
      payload?.videoUrl ||
      payload?.videoLink ||
      payload?.video_url ||
      payload?.playUrl ||
      payload?.play_url ||
      payload?.media?.videoUrl ||
      payload?.media?.playUrl ||
      (Array.isArray(payload?.videoUrls) && payload.videoUrls.length > 0) ||
      (Array.isArray(payload?.videoList) && payload.videoList.length > 0) ||
      (Array.isArray(payload?.videos) && payload.videos.length > 0)
    ) {
      return 'video';
    }

    return 'image';
  }

  return Object.freeze({
    buildSyncBatchRecordInput,
    buildSyncBatchRecordRequestShape,
    buildSyncRequestPayload,
    stripCommentCollectionsForContentSync,
    normalizeSyncDelayMs,
    normalizeSyncAttemptCount,
    resolveRateLimitRetryDelayMs,
    sleep,
    waitForCancelableSyncDelay,
    waitForSyncRequestSlot,
    canContinueAfterIsolatedSyncPause,
    isIsolatedHeavySyncRecord,
    chunkSyncRecordsForRequest,
    isCommentRichSyncRecord,
    countPayloadCommentItems,
    estimateJsonBytes,
    buildWorkflowSyncGroups,
    buildSyncBatchRecord,
    estimateSyncBatchRecordBytes,
    getSingleNoteType,
  });
}
