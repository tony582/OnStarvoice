// L2 checkpoint: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createCheckpointStage({state, ports, operations}) {
  const {
    console,
  } = ports;
  const buildRecordsForStorage = (...args) => operations.buildRecordsForStorage(...args);
  const createListCaptureCacheStats = (...args) => operations.createListCaptureCacheStats(...args);
  const isListCaptureRecordType = (...args) => operations.isListCaptureRecordType(...args);
  const orderRecordIdsByCaptureTrace = (...args) => operations.orderRecordIdsByCaptureTrace(...args);
  const saveRecordsWithCacheDedupe = (...args) => operations.saveRecordsWithCacheDedupe(...args);
  const sortCaptureTraceBindings = (...args) => operations.sortCaptureTraceBindings(...args);


  function createListCaptureCheckpointSession({mode = '', source = ''} = {}) {
    if (!isListCaptureRecordType(mode)) {
      return null;
    }

    return {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      mode: String(mode || '').trim(),
      source: String(source || '').trim(),
      startedAt: Date.now(),
      queue: Promise.resolve(),
      knownKeys: new Set(),
      recordIdByKey: new Map(),
      recordIds: [],
      savedRecordIds: [],
      skippedRecordIds: [],
      traceBindings: [],
      savedRecords: [],
      stats: {
        savedCount: 0,
        skippedCount: 0,
        checkpointCount: 0,
        detectedCount: 0,
        filteredCount: 0,
        lastSavedCount: 0,
        lastSkippedCount: 0,
      },
    };
  }

  function beginListCaptureCheckpointSession(options = {}) {
    const session = createListCaptureCheckpointSession(options);
    if (session) {
      state.activeListCaptureCheckpointSession = session;
    }
    return session;
  }

  function finishListCaptureCheckpointSession(session) {
    if (session && state.activeListCaptureCheckpointSession?.id === session.id) {
      state.activeListCaptureCheckpointSession = null;
    }
  }

  function collectListCaptureSessionRecordIds(session) {
    if (!session) return [];
    return orderRecordIdsByCaptureTrace(
      [
        ...(session.recordIds || []),
        ...(session.savedRecordIds || []),
        ...(session.skippedRecordIds || []),
      ],
      session.traceBindings,
    );
  }

  function getActiveListCaptureCheckpointStats() {
    const session = state.activeListCaptureCheckpointSession;
    if (!session) return null;
    return {
      ...session.stats,
      savedRecordIds: [...session.savedRecordIds],
      skippedRecordIds: [...session.skippedRecordIds],
      traceBindings: sortCaptureTraceBindings(session.traceBindings),
    };
  }

  async function processListCaptureCheckpointProgress(progress = {}) {
    const session = state.activeListCaptureCheckpointSession;
    const checkpoint =
      progress?.listCheckpoint && typeof progress.listCheckpoint === 'object'
        ? progress.listCheckpoint
        : null;
    if (!session || !checkpoint || !isListCaptureRecordType(checkpoint.type)) {
      return null;
    }

    const checkpointItems = Array.isArray(checkpoint.items)
      ? checkpoint.items
      : Array.isArray(checkpoint.payload?.items)
        ? checkpoint.payload.items
        : [];
    if (checkpointItems.length === 0) {
      return createListCaptureCacheStats(session);
    }

    const payloadBase =
      checkpoint.payload && typeof checkpoint.payload === 'object'
        ? checkpoint.payload
        : {};
    const payload = {
      ...payloadBase,
      totalCount: checkpointItems.length,
      filteredCount: checkpointItems.length,
      items: checkpointItems,
      captureTimestamp: payloadBase.captureTimestamp || Date.now(),
    };
    const captureResult = {
      ok: true,
      type: checkpoint.type,
      platform: checkpoint.platform || payload.platform || '',
      data: payload,
      meta:
        checkpoint.meta && typeof checkpoint.meta === 'object'
          ? checkpoint.meta
          : {},
    };
    const recordsToSave = buildRecordsForStorage(captureResult);
    session.stats.checkpointCount += checkpointItems.length;
    session.stats.detectedCount = Math.max(
      session.stats.detectedCount,
      Number(progress.detectedCount || payload.rawTotalCount || 0) || 0,
    );
    session.stats.filteredCount = Math.max(
      session.stats.filteredCount,
      Number(progress.filteredCount || payload.filteredCount || 0) || 0,
    );

    session.queue = session.queue
      .catch(() => null)
      .then(() => saveRecordsWithCacheDedupe(recordsToSave, {session}))
      .catch((error) => {
        console.warn('[CaptureSync] list checkpoint save failed:', error);
        return null;
      });

    await session.queue;
    return createListCaptureCacheStats(session);
  }

  return Object.freeze({
    createListCaptureCheckpointSession,
    beginListCaptureCheckpointSession,
    finishListCaptureCheckpointSession,
    collectListCaptureSessionRecordIds,
    getActiveListCaptureCheckpointStats,
    processListCaptureCheckpointProgress,
  });
}
