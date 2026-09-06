// L2 cache: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createCacheStage({state, ports, operations}) {
  const {
    DETAIL_CAPTURE_STATUS,
    LIST_CAPTURE_RECORD_TYPES,
    LIST_METRIC_KNOWN_FLAG_KEYS,
    SYNC_TYPE,
    detectPlatformFromUrl,
    extractNoteId,
    getDataPool,
    parseInteractionCount,
    runDataPoolMutation,
    setDataPool,
  } = ports;
  const applyCaptureTraceToRecord = (...args) => operations.applyCaptureTraceToRecord(...args);
  const bindCaptureTrace = (...args) => operations.bindCaptureTrace(...args);
  const buildCaptureTraceBinding = (...args) => operations.buildCaptureTraceBinding(...args);
  const buildRecordsForStorage = (...args) => operations.buildRecordsForStorage(...args);
  const collectListCaptureSessionRecordIds = (...args) => operations.collectListCaptureSessionRecordIds(...args);
  const normalizeOptionalCount = (...args) => operations.normalizeOptionalCount(...args);
  const orderRecordIdsByCaptureTrace = (...args) => operations.orderRecordIdsByCaptureTrace(...args);
  const resolveCaptureTraceFromRecord = (...args) => operations.resolveCaptureTraceFromRecord(...args);
  const sortCaptureTraceBindings = (...args) => operations.sortCaptureTraceBindings(...args);
  const upsertCaptureTraceBindings = (...args) => operations.upsertCaptureTraceBindings(...args);
  const addRecord = (...args) => operations.savePreparedRecord(...args);
  const addRecords = (...args) => operations.savePreparedRecords(...args);

  function isListCaptureRecordType(type) {
    return LIST_CAPTURE_RECORD_TYPES.has(String(type || '').trim());
  }

  function normalizeIdentityUrl(value) {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('//')) {
      raw = `https:${raw}`;
    }
    if (raw.startsWith('/')) {
      return raw.replace(/#.*$/, '').replace(/\/$/, '');
    }
    try {
      const parsed = new URL(raw);
      parsed.hash = '';
      const removableParams = [
        'xsec_token',
        'xsec_source',
        'source',
        'share_from_user_hidden',
        'type',
        'appuid',
        'apptime',
        'timestamp',
      ];
      removableParams.forEach((param) => parsed.searchParams.delete(param));
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return raw.replace(/#.*$/, '').replace(/\/$/, '');
    }
  }

  function resolveRecordIdentityPlatform(record = {}) {
    const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
    const firstItem = Array.isArray(payload.items) ? payload.items[0] || {} : {};
    const candidates = [
      record.platform,
      payload.platform,
      firstItem.platform,
      firstItem.url,
      firstItem.noteUrl,
      firstItem.detailPageUrl,
      payload.url,
      payload.noteUrl,
      payload.detailPageUrl,
      payload.searchUrl,
      payload.bloggerUrl,
    ];

    for (const candidate of candidates) {
      const direct = String(candidate || '').trim().toLowerCase();
      if (direct === 'xiaohongshu' || direct === 'douyin') {
        return direct;
      }
      const inferred = detectPlatformFromUrl(String(candidate || ''));
      if (inferred === 'xiaohongshu' || inferred === 'douyin') {
        return inferred;
      }
    }

    return 'unknown';
  }

  function resolveRecordIdentityKeys(record = {}) {
    const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
    const firstItem = Array.isArray(payload.items) ? payload.items[0] || {} : {};
    const platform = resolveRecordIdentityPlatform(record);
    const noteIdCandidates = [
      firstItem.noteId,
      firstItem.id,
      payload.noteId,
      extractNoteId(firstItem.url),
      extractNoteId(firstItem.noteUrl),
      extractNoteId(firstItem.detailPageUrl),
      extractNoteId(payload.url),
      extractNoteId(payload.noteUrl),
      extractNoteId(payload.detailPageUrl),
      extractNoteId(payload.detailCaptureNoteUrl),
    ];
    const urlCandidates = [
      firstItem.url,
      firstItem.noteUrl,
      firstItem.detailPageUrl,
      payload.url,
      payload.noteUrl,
      payload.detailPageUrl,
      payload.detailCaptureNoteUrl,
    ];
    const keys = [];

    for (const noteId of noteIdCandidates) {
      const normalized = String(noteId || '').trim();
      if (normalized) {
        keys.push(`${platform}:note:${normalized}`);
        break;
      }
    }

    for (const url of urlCandidates) {
      const normalizedUrl = normalizeIdentityUrl(url);
      if (normalizedUrl) {
        keys.push(`${platform}:url:${normalizedUrl}`);
        break;
      }
    }

    return [...new Set(keys)];
  }

  function buildDataPoolIdentityIndex(records = []) {
    const keyToRecord = new Map();
    (Array.isArray(records) ? records : []).forEach((record) => {
      if (!isListCaptureRecordType(record?.type || record?.recordType)) return;
      resolveRecordIdentityKeys(record).forEach((key) => {
        if (key && !keyToRecord.has(key)) {
          keyToRecord.set(key, record);
        }
      });
    });
    return keyToRecord;
  }

  function pushUnique(target, values = []) {
    const seen = new Set(target);
    values.forEach((value) => {
      const normalized = String(value || '').trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      target.push(normalized);
    });
  }

  function createListCaptureCacheStats(session, extra = {}) {
    const safeSession = session || state.activeListCaptureCheckpointSession;
    const stats = safeSession?.stats || {};
    return {
      savedCount: Number(stats.savedCount || 0),
      skippedCount: Number(stats.skippedCount || 0),
      checkpointCount: Number(stats.checkpointCount || 0),
      detectedCount: Number(stats.detectedCount || 0),
      filteredCount: Number(stats.filteredCount || 0),
      lastSavedCount: Number(stats.lastSavedCount || 0),
      lastSkippedCount: Number(stats.lastSkippedCount || 0),
      savedRecordIds: safeSession ? [...safeSession.savedRecordIds] : [],
      skippedRecordIds: safeSession ? [...safeSession.skippedRecordIds] : [],
      traceBindings: safeSession
        ? sortCaptureTraceBindings(safeSession.traceBindings)
        : [],
      ...extra,
    };
  }

  function refreshListCaptureMetricsInPlace(existingRecord, freshRecord) {
    const existingItem = existingRecord?.payload?.items?.[0];
    const freshItem = freshRecord?.payload?.items?.[0];
    if (!existingItem || typeof existingItem !== 'object') return false;
    if (!freshItem || typeof freshItem !== 'object') return false;
    let changed = false;
    for (const field of ['likes', 'comments', 'collects', 'shares']) {
      if (!isListMetricExplicitlyKnown(freshItem, field)) continue;
      const next = parseInteractionCount(freshItem[field]);
      const previous = parseInteractionCount(existingItem[field]);
      if (previous === next) continue; // 没变化,不动
      if (
        field === 'comments' &&
        String(existingRecord?.payload?.detailCaptureStatus || '') === DETAIL_CAPTURE_STATUS.DONE &&
        normalizeOptionalCount(existingRecord?.payload?.detailCommentCountBaseline) === null
      ) {
        existingRecord.payload.detailCommentCountBaseline = previous;
      }
      existingItem[field] = next;
      changed = true;
    }
    return changed;
  }

  function validatedFreshXhsCaptureUrl(value, expectedNoteId) {
    const expected = String(expectedNoteId || '').trim().toLowerCase();
    if (!expected) return '';
    try {
      const url = new URL(String(value || '').trim());
      const host = String(url.hostname || '').toLowerCase();
      const actual = String(extractNoteId(url.toString()) || '').trim().toLowerCase();
      if (
        url.protocol !== 'https:' ||
        (host !== 'xiaohongshu.com' && !host.endsWith('.xiaohongshu.com')) ||
        (url.port && url.port !== '443') ||
        url.username ||
        url.password ||
        actual !== expected ||
        !String(url.searchParams.get('xsec_token') || '').trim()
      ) {
        return '';
      }
      return url.toString();
    } catch {
      return '';
    }
  }

  function refreshListCaptureSourceUrlInPlace(existingRecord, freshRecord) {
    if (
      resolveRecordIdentityPlatform(existingRecord) !== 'xiaohongshu' ||
      resolveRecordIdentityPlatform(freshRecord) !== 'xiaohongshu'
    ) {
      return false;
    }
    const existingItem = existingRecord?.payload?.items?.[0];
    const freshItem = freshRecord?.payload?.items?.[0];
    if (!existingItem || typeof existingItem !== 'object') return false;
    if (!freshItem || typeof freshItem !== 'object') return false;

    const existingNoteId = String(
      existingItem.noteId ||
        extractNoteId(existingItem.url) ||
        extractNoteId(existingItem.noteUrl) ||
        '',
    ).trim().toLowerCase();
    const freshNoteId = String(
      freshItem.noteId ||
        extractNoteId(freshItem.url) ||
        extractNoteId(freshItem.noteUrl) ||
        '',
    ).trim().toLowerCase();
    if (!existingNoteId || existingNoteId !== freshNoteId) return false;

    const nextUrl = [freshItem.url, freshItem.noteUrl, freshItem.detailPageUrl]
      .map((candidate) => validatedFreshXhsCaptureUrl(candidate, freshNoteId))
      .find(Boolean) || '';
    if (!nextUrl) return false;

    let changed = false;
    if (String(existingItem.url || '').trim() !== nextUrl) {
      existingItem.url = nextUrl;
      changed = true;
    }
    const replaceSameNoteUrl = (container, field) => {
      if (!container || typeof container !== 'object') return;
      if (!Object.prototype.hasOwnProperty.call(container, field)) return;
      const current = String(container[field] || '').trim();
      if (String(extractNoteId(current) || '').trim().toLowerCase() !== freshNoteId) {
        return;
      }
      if (current === nextUrl) return;
      container[field] = nextUrl;
      changed = true;
    };
    replaceSameNoteUrl(existingItem, 'noteUrl');
    replaceSameNoteUrl(existingItem, 'detailPageUrl');
    replaceSameNoteUrl(existingRecord.payload, 'url');
    replaceSameNoteUrl(existingRecord.payload, 'noteUrl');
    replaceSameNoteUrl(existingRecord.payload, 'detailCaptureNoteUrl');
    replaceSameNoteUrl(existingRecord.payload?.detailPayload, 'url');
    replaceSameNoteUrl(existingRecord.payload?.detailPayload, 'noteUrl');
    if (changed) existingRecord.updatedAt = Date.now();
    return changed;
  }

  function normalizeListMetricDimension(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'comment' || normalized === 'comment_count') return 'comments';
    if (normalized === 'collect' || normalized === 'favorite') return 'collects';
    if (normalized === 'like' || normalized === 'digg') return 'likes';
    if (normalized === 'share' || normalized === 'repost') return 'shares';
    return normalized;
  }

  function isListMetricExplicitlyKnown(item = {}, field = '') {
    const normalizedField = normalizeListMetricDimension(field);
    if (!hasMetricValue(item, normalizedField)) return false;

    const count = parseInteractionCount(item[normalizedField]);
    if (count > 0) return true;

    if (item?.metricKnown?.[normalizedField] === true) return true;
    const knownFlagKeys = LIST_METRIC_KNOWN_FLAG_KEYS[normalizedField] || [];
    if (knownFlagKeys.some((key) => item?.[key] === true)) return true;

    return (
      item?.displayMetricKnown === true &&
      normalizeListMetricDimension(item?.displayMetricDimension) ===
      normalizedField
    );
  }

  function hasMetricValue(item = {}, field) {
    if (!item || typeof item !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(item, field)) return false;
    const value = item[field];
    return value !== undefined && value !== null && value !== '';
  }

  function collectKeywordMatchLabels(record = {}) {
    const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
    const firstItem = Array.isArray(payload.items) ? payload.items[0] || {} : {};
    const candidates = [
      payload.keyword,
      payload.searchKeyword,
      payload.matchedKeyword,
      payload.matchedKeywords,
      payload.keywords,
      firstItem.keyword,
      firstItem.searchKeyword,
      firstItem.matchedKeyword,
      firstItem.matchedKeywords,
    ];
    const labels = [];
    const seen = new Set();
    const append = (value) => {
      if (Array.isArray(value)) {
        value.forEach(append);
        return;
      }
      const label = String(value || '').trim();
      const key = label.toLowerCase();
      if (!label || seen.has(key)) {
        return;
      }
      seen.add(key);
      labels.push(label);
    };
    candidates.forEach(append);
    return labels;
  }

  function mergeKeywordMatchLabelsInPlace(existingRecord, freshRecord) {
    const recordType = String(existingRecord?.type || existingRecord?.recordType || '').trim();
    if (recordType !== SYNC_TYPE.KEYWORD_NOTES) {
      return false;
    }
    const existingPayload =
      existingRecord?.payload && typeof existingRecord.payload === 'object'
        ? existingRecord.payload
        : null;
    if (!existingPayload) {
      return false;
    }

    const byKey = new Map();
    collectKeywordMatchLabels(existingRecord).forEach((label) => {
      byKey.set(label.toLowerCase(), label);
    });
    const beforeSize = byKey.size;
    collectKeywordMatchLabels(freshRecord).forEach((label) => {
      const key = label.toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, label);
      }
    });
    if (byKey.size === beforeSize) {
      return false;
    }

    const matchedKeywords = Array.from(byKey.values());
    existingPayload.matchedKeywords = matchedKeywords;
    const existingItem = Array.isArray(existingPayload.items)
      ? existingPayload.items[0]
      : null;
    if (existingItem && typeof existingItem === 'object') {
      existingItem.matchedKeywords = matchedKeywords;
    }
    return true;
  }

  function mergeCaptureTraceIntoExistingRecord(existingRecord, freshRecord) {
    const freshTrace = resolveCaptureTraceFromRecord(freshRecord);
    if (!existingRecord || !freshTrace) {
      return {changed: false, binding: null};
    }

    const currentTrace = resolveCaptureTraceFromRecord(existingRecord);
    let nextTrace = bindCaptureTrace(freshTrace, existingRecord.id, 'saved');
    if (
      currentTrace &&
      currentTrace.runId === nextTrace?.runId &&
      currentTrace.identityKey === nextTrace?.identityKey &&
      currentTrace.sequence !== null &&
      nextTrace?.sequence !== null &&
      currentTrace.sequence < nextTrace.sequence
    ) {
      nextTrace = {...nextTrace, sequence: currentTrace.sequence};
    }
    if (!nextTrace) {
      return {changed: false, binding: null};
    }

    const currentComparable = currentTrace
      ? JSON.stringify(bindCaptureTrace(currentTrace, existingRecord.id, currentTrace.state))
      : '';
    const nextComparable = JSON.stringify(nextTrace);
    if (currentComparable === nextComparable) {
      return {
        changed: false,
        binding: buildCaptureTraceBinding(nextTrace),
      };
    }

    const updatedRecord = applyCaptureTraceToRecord(existingRecord, nextTrace);
    Object.assign(existingRecord, updatedRecord, {updatedAt: Date.now()});
    return {
      changed: true,
      binding: buildCaptureTraceBinding(nextTrace),
    };
  }

  function uniqueRecordsById(records = []) {
    const byId = new Map();
    (Array.isArray(records) ? records : []).forEach((record) => {
      const recordId = String(record?.id || '').trim();
      if (!recordId || byId.has(recordId)) return;
      byId.set(recordId, record);
    });
    return [...byId.values()];
  }

  async function saveRecordsWithCacheDedupe(records = [], {session = null} = {}) {
    const normalizedRecords = Array.isArray(records) ? records.filter(Boolean) : [];
    if (normalizedRecords.length === 0) {
      return {
        savedRecords: [],
        skippedCount: 0,
        skippedRecordIds: [],
        recordIds: [],
        syncRecordIds: [],
        traceBindings: [],
      };
    }

    return await runDataPoolMutation(async () => {
      const dataPool = await getDataPool();
      const existingRecords = Array.isArray(dataPool.records) ? dataPool.records : [];
      const keyToRecord = buildDataPoolIdentityIndex(existingRecords);
      const pendingKnownKeys = session?.knownKeys ? new Set() : null;
      const savedRecords = []; // 全新记录:入本地池(unshift)+ 同步
      const refreshedRecords = []; // 已存但刷新了互动数:就地改 + 同步,但不 unshift(避免本地重复)
      const skippedRecordIds = [];
      const traceBindings = [];
      let skippedCount = 0;

      for (const record of normalizedRecords) {
        const recordType = record?.type || record?.recordType;
        if (!isListCaptureRecordType(recordType)) {
          const boundTrace = bindCaptureTrace(
            resolveCaptureTraceFromRecord(record),
            record?.id,
            'saved',
          );
          const recordToSave = boundTrace
            ? applyCaptureTraceToRecord(record, boundTrace)
            : record;
          savedRecords.push(recordToSave);
          const binding = buildCaptureTraceBinding(boundTrace);
          if (binding) traceBindings.push(binding);
          continue;
        }

        const keys = resolveRecordIdentityKeys(record);
        const knownInSession = keys.some((key) =>
          session?.knownKeys?.has(key) || pendingKnownKeys?.has(key),
        );
        if (knownInSession) {
          continue;
        }

        const existingRecord = keys
          .map((key) => keyToRecord.get(key))
          .find(Boolean);
        if (existingRecord) {
          skippedCount += 1;
          const existingId = String(existingRecord.id || '').trim();
          keys.forEach((key) => pendingKnownKeys?.add(key));
          const traceMerge = mergeCaptureTraceIntoExistingRecord(
            existingRecord,
            record,
          );
          if (traceMerge.binding) traceBindings.push(traceMerge.binding);
          // 不再整条丢弃:把这次采到的互动数就地刷新进已存记录并纳入同步;
          // 没刷新到(0/空/没变)才按「已采过」计入 skipped。
          const keywordLabelsChanged =
            mergeKeywordMatchLabelsInPlace(existingRecord, record);
          const sourceUrlChanged =
            refreshListCaptureSourceUrlInPlace(existingRecord, record);
          if (
            refreshListCaptureMetricsInPlace(existingRecord, record) ||
            keywordLabelsChanged ||
            sourceUrlChanged ||
            traceMerge.changed
          ) {
            refreshedRecords.push(existingRecord);
          } else if (existingId) {
            skippedRecordIds.push(existingId);
          }
          continue;
        }

        const boundTrace = bindCaptureTrace(
          resolveCaptureTraceFromRecord(record),
          record?.id,
          'saved',
        );
        const recordToSave = boundTrace
          ? applyCaptureTraceToRecord(record, boundTrace)
          : record;
        savedRecords.push(recordToSave);
        const binding = buildCaptureTraceBinding(boundTrace);
        if (binding) traceBindings.push(binding);
        keys.forEach((key) => {
          pendingKnownKeys?.add(key);
          keyToRecord.set(key, recordToSave);
        });
      }

      if (savedRecords.length > 0) {
        dataPool.records.unshift(...savedRecords); // 只 unshift 全新记录
      }
      if (savedRecords.length > 0 || refreshedRecords.length > 0) {
        // 刷新的记录是 dataPool.records 内的引用、已就地改 → 一并持久化
        const saved = await setDataPool(dataPool);
        if (!saved) {
          throw new Error('本地缓存写入失败，请检查扩展存储空间或稍后重试');
        }
      }

      // 全新 + 已存刷新的,都回传给调用方同步(后端按新互动数 upsert)
      const syncRecords = [...savedRecords, ...refreshedRecords];
      const savedRecordIds = syncRecords.map((record) => record?.id).filter(Boolean);
      if (session) {
        pendingKnownKeys?.forEach((key) => session.knownKeys?.add(key));
        session.stats.savedCount += savedRecords.length; // 统计「新增」只算全新,刷新不计新增
        session.stats.skippedCount += skippedCount;
        session.stats.lastSavedCount = savedRecords.length;
        session.stats.lastSkippedCount = skippedCount;
        session.savedRecords.push(...syncRecords);
        pushUnique(session.savedRecordIds, savedRecordIds);
        pushUnique(session.skippedRecordIds, skippedRecordIds);
        upsertCaptureTraceBindings(session.traceBindings, traceBindings);
      }

      const normalizedTraceBindings = sortCaptureTraceBindings(traceBindings);
      return {
        savedRecords: syncRecords,
        skippedCount,
        skippedRecordIds: [...new Set(skippedRecordIds)],
        recordIds: [...new Set([...savedRecordIds, ...skippedRecordIds])],
        syncRecordIds: [...new Set(savedRecordIds)],
        traceBindings: normalizedTraceBindings,
      };
    });
  }

  async function saveCaptureResultRecords(captureResult, {session = null} = {}) {
    const recordsToSave = buildRecordsForStorage(captureResult);
    if (!isListCaptureRecordType(captureResult?.type)) {
      if (recordsToSave.length === 0) {
        return {
          savedRecords: [],
          recordIds: [],
          syncRecordIds: [],
          traceBindings: [],
          cacheStats: null,
        };
      }
      const savedRecords =
        recordsToSave.length === 1
          ? [await addRecord(recordsToSave[0])]
          : await addRecords(recordsToSave);
      const traceBindings = sortCaptureTraceBindings(
        savedRecords
          .map((record) => buildCaptureTraceBinding(resolveCaptureTraceFromRecord(record)))
          .filter(Boolean),
      );
      const recordIds = orderRecordIdsByCaptureTrace(
        savedRecords.map((record) => record?.id).filter(Boolean),
        traceBindings,
      );
      return {
        savedRecords,
        recordIds,
        syncRecordIds: recordIds,
        traceBindings,
        cacheStats: null,
      };
    }

    if (session?.queue) {
      await session.queue.catch(() => null);
    }
    const finalSave = await saveRecordsWithCacheDedupe(recordsToSave, {session});
    const finalTraceBindings = Array.isArray(finalSave?.traceBindings)
      ? finalSave.traceBindings
      : [];
    const finalRecordIds = Array.isArray(finalSave?.recordIds)
      ? finalSave.recordIds
      : [];
    const finalSavedRecords = Array.isArray(finalSave?.savedRecords)
      ? finalSave.savedRecords
      : [];
    const traceBindings = sortCaptureTraceBindings([
      ...(session?.traceBindings || []),
      ...finalTraceBindings,
    ]);
    const recordIds = orderRecordIdsByCaptureTrace(
      [
        ...collectListCaptureSessionRecordIds(session),
        ...finalRecordIds,
      ],
      traceBindings,
    );
    const savedRecords = uniqueRecordsById([
      ...(session?.savedRecords || []),
      ...finalSavedRecords,
    ]);
    const syncRecordIds = orderRecordIdsByCaptureTrace(
      savedRecords.map((record) => record?.id),
      traceBindings,
    );

    return {
      savedRecords,
      recordIds,
      syncRecordIds,
      traceBindings,
      cacheStats: createListCaptureCacheStats(session, {
        finalSkippedCount: Number(finalSave?.skippedCount || 0),
        finalSavedCount: finalSavedRecords.length,
      }),
    };
  }

  return Object.freeze({
    isListCaptureRecordType,
    normalizeIdentityUrl,
    resolveRecordIdentityPlatform,
    resolveRecordIdentityKeys,
    buildDataPoolIdentityIndex,
    pushUnique,
    createListCaptureCacheStats,
    refreshListCaptureMetricsInPlace,
    validatedFreshXhsCaptureUrl,
    refreshListCaptureSourceUrlInPlace,
    normalizeListMetricDimension,
    isListMetricExplicitlyKnown,
    hasMetricValue,
    collectKeywordMatchLabels,
    mergeKeywordMatchLabelsInPlace,
    mergeCaptureTraceIntoExistingRecord,
    uniqueRecordsById,
    saveRecordsWithCacheDedupe,
    saveCaptureResultRecords,
  });
}
