// L2 history: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createHistoryStage({state, ports, operations}) {
  const {
    COMMENT_LEADS_ELIGIBLE_SYNC_TYPES,
    ERROR_REASON,
    FRONTEND_SYNC_ERROR_MESSAGE_LIMIT,
    FRONTEND_SYNC_ERROR_STACK_LINE_LIMIT,
    FRONTEND_SYNC_FAILURE_REASON,
    FRONTEND_SYNC_HISTORY_ITEM_LIMIT,
    SYNC_TYPE,
    addSyncHistoryEntry,
    buildSyncHistoryTarget,
    console,
    getTarget,
  } = ports;
  const buildSyncTargetPayload = (...args) => operations.buildSyncTargetPayload(...args);
  const getSingleNoteType = (...args) => operations.getSingleNoteType(...args);
  const resolveSyncInputForRecord = (...args) => operations.resolveSyncInputForRecord(...args);


  function isCommentLeadsEligibleSyncType(syncType) {
    return COMMENT_LEADS_ELIGIBLE_SYNC_TYPES.has(syncType);
  }

  function hasCommentLeadsEligibleType(syncTypes = []) {
    return Array.isArray(syncTypes)
      ? syncTypes.some((syncType) => isCommentLeadsEligibleSyncType(syncType))
      : false;
  }

  function truncateFrontendSyncText(value, limit = FRONTEND_SYNC_ERROR_MESSAGE_LIMIT) {
    const text = String(value || '').trim();
    if (!text || text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit - 1)}...`;
  }

  function normalizeFrontendSyncError(error, {
    phase = 'sync',
    source = 'plugin_frontend',
    fallbackMessage = '前端同步失败',
  } = {}) {
    const safeError = error && typeof error === 'object' ? error : {};
    const nestedError =
      safeError.error && typeof safeError.error === 'object' ? safeError.error : {};
    const reason = String(
      safeError.code ||
        safeError.reason ||
        nestedError.code ||
        nestedError.reason ||
        FRONTEND_SYNC_FAILURE_REASON,
    ).trim() || FRONTEND_SYNC_FAILURE_REASON;
    const message = truncateFrontendSyncText(
      safeError.message ||
        nestedError.message ||
        (typeof error === 'string' ? error : '') ||
        fallbackMessage,
    );
    const stack = truncateFrontendSyncText(
      String(safeError.stack || nestedError.stack || '')
        .split('\n')
        .slice(0, FRONTEND_SYNC_ERROR_STACK_LINE_LIMIT)
        .join('\n'),
      1600,
    );

    return {
      source,
      phase,
      reason,
      code: reason,
      message,
      name: String(safeError.name || nestedError.name || '').trim(),
      stack,
    };
  }

  function resolveFrontendFailurePlatform(syncInputs = []) {
    const platforms = new Set(
      syncInputs
        .map((input) => String(input?.platform || '').trim())
        .filter(Boolean),
    );
    if (platforms.size === 1) {
      return Array.from(platforms)[0];
    }
    if (platforms.size > 1) {
      return 'mixed';
    }
    return 'unknown';
  }

  function resolveFrontendFailureSyncType(syncInputs = [], requiredSyncTypes = []) {
    const syncTypes = new Set(
      syncInputs
        .map((input) => String(input?.syncType || '').trim())
        .filter(Boolean),
    );
    if (syncTypes.size === 0 && Array.isArray(requiredSyncTypes)) {
      requiredSyncTypes
        .map((syncType) => String(syncType || '').trim())
        .filter(Boolean)
        .forEach((syncType) => syncTypes.add(syncType));
    }
    if (syncTypes.size === 1) {
      return Array.from(syncTypes)[0];
    }
    if (syncTypes.size > 1) {
      return 'mixed';
    }
    return '';
  }

  function buildFrontendFailureItems({
    records = [],
    recordIds = [],
    requestTarget = {},
    frontendError,
  } = {}) {
    const items = [];
    const seenRecordIds = new Set();
    const limitedRecords = Array.isArray(records)
      ? records.slice(0, FRONTEND_SYNC_HISTORY_ITEM_LIMIT)
      : [];

    for (const record of limitedRecords) {
      const syncInput = resolveSyncInputForRecord(record, requestTarget);
      const recordId = String(record?.id || '').trim();
      if (recordId) {
        seenRecordIds.add(recordId);
      }
      items.push({
        recordId,
        platform: syncInput.platform || 'unknown',
        type: syncInput.syncType || record?.type || '',
        sourceType: record?.type || record?.recordType || '',
        workflow: syncInput.workflow || 'shared_unknown',
        noteType: syncInput.syncType === SYNC_TYPE.SINGLE_NOTE
          ? getSingleNoteType(syncInput.payload || record?.payload)
          : null,
        success: false,
        reason: frontendError.reason,
        message: frontendError.message,
        debugUrl: null,
        rawResponse: null,
        frontendError,
        error: {
          source: frontendError.source,
          phase: frontendError.phase,
          reason: frontendError.reason,
          code: frontendError.code,
          message: frontendError.message,
          stack: frontendError.stack,
        },
      });
    }

    if (items.length > 0) {
      return items;
    }

    const limitedRecordIds = Array.isArray(recordIds)
      ? recordIds.slice(0, FRONTEND_SYNC_HISTORY_ITEM_LIMIT)
      : [];
    for (const recordId of limitedRecordIds) {
      const normalizedRecordId = String(recordId || '').trim();
      if (!normalizedRecordId || seenRecordIds.has(normalizedRecordId)) {
        continue;
      }
      items.push({
        recordId: normalizedRecordId,
        platform: 'unknown',
        type: '',
        workflow: 'frontend_failure',
        success: false,
        reason: frontendError.reason,
        message: frontendError.message,
        debugUrl: null,
        rawResponse: null,
        frontendError,
        error: {
          source: frontendError.source,
          phase: frontendError.phase,
          reason: frontendError.reason,
          code: frontendError.code,
          message: frontendError.message,
          stack: frontendError.stack,
        },
      });
    }

    return items;
  }

  async function appendFrontendSyncFailureHistory({
    records = [],
    recordIds = [],
    requiredSyncTypes = [],
    error,
    phase = 'sync',
    source = 'plugin_frontend',
    trigger = 'manual',
    syncScope = 'pending',
    startedAt = Date.now(),
    fallbackMessage = '前端同步失败',
  } = {}) {
    try {
      const safeRecords = Array.isArray(records) ? records.filter(Boolean) : [];
      const safeRecordIds = Array.isArray(recordIds)
        ? recordIds.map((recordId) => String(recordId || '').trim()).filter(Boolean)
        : safeRecords.map((record) => String(record?.id || '').trim()).filter(Boolean);
      const target = await getTarget();
      const requestTarget = buildSyncTargetPayload(target);
      const syncInputs = safeRecords.map((record) =>
        resolveSyncInputForRecord(record, requestTarget),
      );
      const frontendError = normalizeFrontendSyncError(error, {
        phase,
        source,
        fallbackMessage,
      });
      const platform = resolveFrontendFailurePlatform(syncInputs);
      const syncType = resolveFrontendFailureSyncType(syncInputs, requiredSyncTypes);
      const workflow =
        syncInputs.length === 1
          ? syncInputs[0]?.workflow || 'frontend_failure'
          : 'frontend_failure';
      const items = buildFrontendFailureItems({
        records: safeRecords,
        recordIds: safeRecordIds,
        requestTarget,
        frontendError,
      });
      const failedCount = Math.max(
        items.length,
        safeRecordIds.length,
        safeRecords.length,
        1,
      );

      return await addSyncHistoryEntry({
        trigger,
        syncScope,
        startedAt,
        finishedAt: Date.now(),
        totalCount: failedCount,
        requestedTotalCount: Math.max(safeRecordIds.length, safeRecords.length, failedCount),
        skippedCount: 0,
        successCount: 0,
        failedCount,
        debugUrl: null,
        platform,
        syncType,
        workflow,
        target: buildSyncHistoryTarget(requestTarget, {
          platform,
          syncType,
          workflow,
        }),
        recordIds: safeRecordIds,
        skippedRecordIds: [],
        frontendFailure: true,
        frontendError,
        errorMessage: frontendError.message,
        message: frontendError.message,
        items,
      });
    } catch (historyError) {
      console.error('[CaptureSync] Append frontend sync failure history failed:', historyError);
      return null;
    }
  }

  async function appendSingleSyncHistoryEntry({
    requestTarget,
    syncInput,
    recordId,
    result,
    startedAt,
    trigger = 'single',
  } = {}) {
    const safeSyncInput =
      syncInput && typeof syncInput === 'object'
        ? syncInput
        : {
            platform: 'unknown',
            syncType: '',
            workflow: 'shared_unknown',
            payload: {},
          };
    const safeResult = result && typeof result === 'object' ? result : {};
    const success = Boolean(safeResult.ok);
    const payload = safeSyncInput.payload && typeof safeSyncInput.payload === 'object'
      ? safeSyncInput.payload
      : {};

    await addSyncHistoryEntry({
      trigger,
      syncScope: 'pending',
      startedAt,
      finishedAt: Date.now(),
      totalCount: 1,
      requestedTotalCount: 1,
      skippedCount: 0,
      successCount: success ? 1 : 0,
      failedCount: success ? 0 : 1,
      debugUrl: safeResult.debugUrl || null,
      platform: safeSyncInput.platform || 'unknown',
      syncType: safeSyncInput.syncType || '',
      workflow: safeSyncInput.workflow || 'shared_unknown',
      target: buildSyncHistoryTarget(requestTarget, safeSyncInput),
      recordIds: recordId ? [recordId] : [],
      skippedRecordIds: [],
      items: [
        {
          recordId,
          platform: safeSyncInput.platform || 'unknown',
          type: safeSyncInput.syncType || '',
          workflow: safeSyncInput.workflow || 'shared_unknown',
          noteType:
            safeSyncInput.syncType === SYNC_TYPE.SINGLE_NOTE
              ? getSingleNoteType(payload)
              : null,
          success,
          reason: safeResult.reason || (success ? ERROR_REASON.NONE : 'SYNC_ERROR'),
          message: safeResult.message || (success ? '同步成功' : '同步失败'),
          debugUrl: safeResult.debugUrl || null,
          rawResponse: safeResult.rawResponse || null,
          error: safeResult.error || null,
        },
      ],
    });
  }

  return Object.freeze({
    isCommentLeadsEligibleSyncType,
    hasCommentLeadsEligibleType,
    truncateFrontendSyncText,
    normalizeFrontendSyncError,
    resolveFrontendFailurePlatform,
    resolveFrontendFailureSyncType,
    buildFrontendFailureItems,
    appendFrontendSyncFailureHistory,
    appendSingleSyncHistoryEntry,
  });
}
