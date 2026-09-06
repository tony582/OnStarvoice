// L2 comment-model: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createCommentModelStage({state, ports, operations}) {
  const {
    COMMENT_CAPTURE_STATUS,
    COMMENT_CONTENT_MAX_LENGTH,
    SYNC_TYPE,
    clearInterruptedCommentObservation,
    dedupeNormalizedCommentItems,
  } = ports;
  const normalizeNonNegativeNumber = (...args) => operations.normalizeNonNegativeNumber(...args);
  const resolveSyncInputForRecord = (...args) => operations.resolveSyncInputForRecord(...args);


  function sanitizeCommentLeadItems(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        const normalized = normalizeCommentItemForLead(item);
        if (!normalized.content) return null;
        return {
          ...normalized,
          matchedKeywords: splitCommentLeadRules(item?.matchedKeywords),
        };
      })
      .filter(Boolean);
  }

  function normalizeCommentLeadSyncStatus(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (
      normalized === 'not_started' ||
      normalized === 'done' ||
      normalized === 'failed' ||
      normalized === 'skipped'
    ) {
      return normalized;
    }
    return 'not_started';
  }

  function applyCommentStatusToPayload(payload, patch) {
    const base = payload && typeof payload === 'object' ? payload : {};
    const baseLeadItems = sanitizeCommentLeadItems(base.commentLeadsItems);
    const patchLeadItems = sanitizeCommentLeadItems(patch.commentLeadsItems);
    return {
      ...base,
      commentsTotalCaptured: patch.commentsTotalCaptured ?? base.commentsTotalCaptured ?? 0,
      commentsCleanedItems: Array.isArray(patch.commentsCleanedItems)
        ? patch.commentsCleanedItems
        : Array.isArray(base.commentsCleanedItems)
          ? base.commentsCleanedItems
          : [],
      commentsMergedText: patch.commentsMergedText ?? base.commentsMergedText ?? '',
      commentsCaptureStatus:
        patch.commentsCaptureStatus ?? base.commentsCaptureStatus ?? COMMENT_CAPTURE_STATUS.NOT_STARTED,
      commentsCaptureStoppedByUser:
        patch.commentsCaptureStoppedByUser ?? base.commentsCaptureStoppedByUser ?? false,
      commentsCaptureStartedAt: patch.commentsCaptureStartedAt ?? base.commentsCaptureStartedAt ?? 0,
      commentsCaptureFinishedAt:
        patch.commentsCaptureFinishedAt ?? base.commentsCaptureFinishedAt ?? 0,
      commentsCaptureError: patch.commentsCaptureError ?? base.commentsCaptureError ?? '',
      commentLeadsEnabled: Boolean(
        patch.commentLeadsEnabled ?? base.commentLeadsEnabled ?? false,
      ),
      commentLeadsKeywords:
        patch.commentLeadsKeywords !== undefined
          ? splitCommentLeadRules(patch.commentLeadsKeywords)
          : splitCommentLeadRules(base.commentLeadsKeywords),
      commentLeadsIps:
        patch.commentLeadsIps !== undefined
          ? splitCommentLeadRules(patch.commentLeadsIps)
          : splitCommentLeadRules(base.commentLeadsIps),
      commentLeadsItems: patchLeadItems.length > 0 || patch.commentLeadsItems !== undefined
        ? patchLeadItems
        : baseLeadItems,
      commentLeadsTotal:
        patch.commentLeadsTotal ??
        (patchLeadItems.length > 0 || patch.commentLeadsItems !== undefined
          ? patchLeadItems.length
          : base.commentLeadsTotal ?? baseLeadItems.length),
      commentLeadsLastComputedAt:
        patch.commentLeadsLastComputedAt ?? base.commentLeadsLastComputedAt ?? 0,
      commentLeadsSyncStatus: normalizeCommentLeadSyncStatus(
        patch.commentLeadsSyncStatus ?? base.commentLeadsSyncStatus ?? 'not_started',
      ),
      commentLeadsSyncError: String(
        patch.commentLeadsSyncError ?? base.commentLeadsSyncError ?? '',
      ),
    };
  }

  function createCommentStatusPatch({
    status,
    startedAt,
    finishedAt,
    stoppedByUser,
    error,
    cleanedItems = null,
    mergedText = null,
    commentLeadsEnabled = undefined,
    commentLeadsKeywords = undefined,
    commentLeadsIps = undefined,
    commentLeadsItems = undefined,
    commentLeadsTotal = undefined,
    commentLeadsLastComputedAt = undefined,
    commentLeadsSyncStatus = undefined,
    commentLeadsSyncError = undefined,
  }) {
    const patch = {
      commentsCaptureStatus: status,
      commentsCaptureStartedAt: startedAt,
      commentsCaptureFinishedAt: finishedAt,
      commentsCaptureStoppedByUser: stoppedByUser,
      commentsCaptureError: error,
    };

    if (Array.isArray(cleanedItems)) {
      patch.commentsCleanedItems = cleanedItems;
      patch.commentsTotalCaptured = cleanedItems.length;
    }

    if (typeof mergedText === 'string') {
      patch.commentsMergedText = mergedText;
    }

    if (commentLeadsEnabled !== undefined) {
      patch.commentLeadsEnabled = Boolean(commentLeadsEnabled);
    }
    if (commentLeadsKeywords !== undefined) {
      patch.commentLeadsKeywords = splitCommentLeadRules(commentLeadsKeywords);
    }
    if (commentLeadsIps !== undefined) {
      patch.commentLeadsIps = splitCommentLeadRules(commentLeadsIps);
    }
    if (commentLeadsItems !== undefined) {
      patch.commentLeadsItems = sanitizeCommentLeadItems(commentLeadsItems);
    }
    if (commentLeadsTotal !== undefined) {
      patch.commentLeadsTotal = normalizeNonNegativeNumber(commentLeadsTotal);
    }
    if (commentLeadsLastComputedAt !== undefined) {
      patch.commentLeadsLastComputedAt = normalizeNonNegativeNumber(commentLeadsLastComputedAt);
    }
    if (commentLeadsSyncStatus !== undefined) {
      patch.commentLeadsSyncStatus = normalizeCommentLeadSyncStatus(commentLeadsSyncStatus);
    }
    if (commentLeadsSyncError !== undefined) {
      patch.commentLeadsSyncError = String(commentLeadsSyncError || '');
    }

    return patch;
  }

  function cleanCommentsItems(items) {
    const normalized = [];

    items.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const content = String(item.content || item.commentContent || '').replace(/\s+/g, ' ').trim();
      if (!content) return;
      const normalizedContent =
        content.length > COMMENT_CONTENT_MAX_LENGTH
          ? `${content.slice(0, COMMENT_CONTENT_MAX_LENGTH)}...`
          : content;
      const likesNum = Number(item.likes ?? item.likeCount);
      const likes = Number.isFinite(likesNum) && likesNum >= 0 ? Math.floor(likesNum) : 0;
      const userId = resolveCommentUserId(item);
      const userName = resolveCommentUserName(item);
      const userUrl = resolveCommentUserUrl(item);
      const ipLocation = resolveCommentIpLocation(item);
      const publishTime = String(item.publishTime || item.publishedAt || item.time || item.date || '').trim();
      const preferredId = String(item.commentId || item.id || '').trim();
      normalized.push({
        ...(preferredId ? { commentId: preferredId } : {}),
        content: normalizedContent,
        likes,
        ...(userName ? { userName } : {}),
        ...(userId ? { userId } : {}),
        ...(userUrl ? { userUrl } : {}),
        ...(ipLocation ? { ipLocation } : {}),
        ...(publishTime ? { publishTime } : {}),
      });
    });

    return dedupeNormalizedCommentItems(normalized);
  }

  function buildCommentsMergedText(items) {
    return items
      .map((item, index) => {
        const name = String(item?.userName || '匿名用户').trim() || '匿名用户';
        const ip = String(item?.ipLocation || '未知IP').trim() || '未知IP';
        const content = String(item?.content || '').trim();
        const likes = Number(item?.likes || 0);
        return `${index + 1}、${name}（${ip}）：${content}（${Number.isFinite(likes) ? Math.max(0, Math.floor(likes)) : 0} 个赞）`;
      })
      .join('\n');
  }

  function splitCommentLeadRules(rawValue) {
    if (Array.isArray(rawValue)) {
      return Array.from(
        new Set(
          rawValue
            .map((item) => String(item || '').trim())
            .filter(Boolean),
        ),
      );
    }

    return Array.from(
      new Set(
        String(rawValue || '')
          .split(/[，,]/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
  }

  function buildCommentLeadsConfigFromSettings(settings = {}) {
    return normalizeCommentLeadsConfig({
      enabled:
        settings.enableCommentLeadsFilter ??
        settings.commentLeadsEnabled ??
        false,
      keywords:
        settings.commentLeadsKeywords ??
        settings.keywords ??
        '',
      ips:
        settings.commentLeadsIps ??
        settings.ips ??
        '',
    });
  }

  function normalizeCommentLeadsConfig(input = {}) {
    const safe = input && typeof input === 'object' ? input : {};
    const enabled = Boolean(safe.enabled);
    const keywords = splitCommentLeadRules(safe.keywords);
    const ips = splitCommentLeadRules(safe.ips);
    return {
      enabled,
      keywords,
      ips,
      hasKeywordRules: keywords.length > 0,
      hasIpRules: ips.length > 0,
      hasRules: keywords.length > 0 || ips.length > 0,
    };
  }

  function normalizeCommentItemForLead(item) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const likesNum = Number(safeItem.likes ?? safeItem.likeCount);
    const likes = Number.isFinite(likesNum) && likesNum >= 0 ? Math.floor(likesNum) : 0;
    return {
      content: String(safeItem.content || safeItem.commentContent || '').replace(/\s+/g, ' ').trim(),
      userName: resolveCommentUserName(safeItem),
      ipLocation: resolveCommentIpLocation(safeItem),
      likes,
      userUrl: resolveCommentUserUrl(safeItem),
      userId: resolveCommentUserId(safeItem),
    };
  }

  function pickFirstNonEmptyString(candidates = []) {
    if (!Array.isArray(candidates)) return '';
    for (const candidate of candidates) {
      const text = String(candidate || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      return text;
    }
    return '';
  }

  function extractUserIdFromProfileUrl(url) {
    const text = String(url || '').trim();
    if (!text) return '';
    const match = text.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/i);
    return match?.[1] || '';
  }

  function resolveCommentUserName(item) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
    return pickFirstNonEmptyString([
      safeItem.userName,
      safeItem.nickname,
      safeItem.user_name,
      safeItem.authorName,
      safeItem.author,
      safeItem.name,
      user.userName,
      user.nickname,
      user.name,
      safeItem['user-name'],
      safeItem['user_name'],
    ]);
  }

  function resolveCommentIpLocation(item) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
    return pickFirstNonEmptyString([
      safeItem.ipLocation,
      safeItem.ip,
      safeItem.location,
      safeItem.region,
      safeItem.ip_location,
      safeItem.userIpLocation,
      safeItem['ip属地'],
      user.ipLocation,
      user.location,
      user.region,
    ]);
  }

  function resolveCommentUserUrl(item) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
    return pickFirstNonEmptyString([
      safeItem.userUrl,
      safeItem.userURL,
      safeItem.profileUrl,
      safeItem.homeUrl,
      user.userUrl,
      user.profileUrl,
    ]);
  }

  function resolveCommentUserId(item) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
    return pickFirstNonEmptyString([
      safeItem.userId,
      safeItem.uid,
      safeItem.user_id,
      user.userId,
      user.uid,
      user.id,
      extractUserIdFromProfileUrl(resolveCommentUserUrl(safeItem)),
    ]);
  }

  function getLeadSourceFromSyncPayload(syncType, payload) {
    const safePayload = payload && typeof payload === 'object' ? payload : {};

    if (syncType === SYNC_TYPE.SINGLE_NOTE) {
      const fallbackComments =
        Array.isArray(safePayload.commentsCleanedItems)
          ? safePayload.commentsCleanedItems
          : Array.isArray(safePayload.commentItems)
            ? safePayload.commentItems
            : Array.isArray(safePayload.commentsItems)
              ? safePayload.commentsItems
              : Array.isArray(safePayload.comments)
                ? safePayload.comments
                : Array.isArray(safePayload.items)
                  ? safePayload.items
                  : [];
      return {
        noteUrl: String(safePayload.url || safePayload.noteUrl || '').trim(),
        noteTitle: String(safePayload.title || safePayload.noteTitle || '').trim(),
        comments: fallbackComments,
      };
    }

    if (syncType === SYNC_TYPE.COMMENTS) {
      return {
        noteUrl: String(safePayload.noteUrl || '').trim(),
        noteTitle: String(safePayload.noteTitle || '').trim(),
        comments: Array.isArray(safePayload.items) ? safePayload.items : [],
      };
    }

    if (syncType === SYNC_TYPE.BLOGGER_NOTES || syncType === SYNC_TYPE.KEYWORD_NOTES) {
      const firstItem =
        Array.isArray(safePayload.items) && safePayload.items[0] && typeof safePayload.items[0] === 'object'
          ? safePayload.items[0]
          : {};
      const fallbackComments =
        Array.isArray(firstItem.commentsCleanedItems)
          ? firstItem.commentsCleanedItems
          : Array.isArray(firstItem.commentItems)
            ? firstItem.commentItems
            : Array.isArray(firstItem.commentsItems)
              ? firstItem.commentsItems
              : Array.isArray(firstItem.comments)
                ? firstItem.comments
                : Array.isArray(safePayload.commentsCleanedItems)
                  ? safePayload.commentsCleanedItems
                  : Array.isArray(safePayload.comments)
                    ? safePayload.comments
                    : [];
      return {
        noteUrl: String(firstItem.url || firstItem.noteUrl || safePayload.detailCaptureNoteUrl || '').trim(),
        noteTitle: String(firstItem.title || firstItem.noteTitle || '').trim(),
        comments: fallbackComments,
      };
    }

    return {
      noteUrl: '',
      noteTitle: '',
      comments: [],
    };
  }

  function evaluateCommentLeadItem(item, config) {
    const normalizedItem = normalizeCommentItemForLead(item);
    if (!normalizedItem.content) {
      return null;
    }

    const contentLower = normalizedItem.content.toLowerCase();
    const matchedKeywords = config.keywords.filter((keyword) =>
      contentLower.includes(keyword.toLowerCase()),
    );
    const keywordMatched = !config.hasKeywordRules || matchedKeywords.length > 0;
    const ipMatched = !config.hasIpRules || config.ips.includes(normalizedItem.ipLocation);
    if (!keywordMatched || !ipMatched) {
      return null;
    }

    return {
      ...normalizedItem,
      matchedKeywords,
    };
  }

  function getStoredCommentLeadsState(syncType, payload) {
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    const source = getLeadSourceFromSyncPayload(syncType, safePayload);
    const firstItem =
      Array.isArray(safePayload.items) && safePayload.items[0] && typeof safePayload.items[0] === 'object'
        ? safePayload.items[0]
        : {};

    const rawItems =
      Array.isArray(firstItem.commentLeadsItems)
        ? firstItem.commentLeadsItems
        : Array.isArray(safePayload.commentLeadsItems)
          ? safePayload.commentLeadsItems
          : [];
    const items = sanitizeCommentLeadItems(rawItems);
    const totalRaw =
      firstItem.commentLeadsTotal ??
      safePayload.commentLeadsTotal ??
      items.length;
    const matchedCount = normalizeNonNegativeNumber(totalRaw);

    if (!source.noteUrl || items.length === 0 || matchedCount <= 0) {
      return {
        matchedCount: 0,
        payload: null,
      };
    }

    return {
      matchedCount: Math.max(matchedCount, items.length),
      payload: {
        noteUrl: source.noteUrl,
        noteTitle: source.noteTitle,
        captureTimestamp:
          Number(safePayload.commentLeadsLastComputedAt || firstItem.commentLeadsLastComputedAt || 0) ||
          Date.now(),
        filterConfigSnapshot: {
          keywords: splitCommentLeadRules(
            safePayload.commentLeadsKeywords ?? firstItem.commentLeadsKeywords,
          ),
          ips: splitCommentLeadRules(
            safePayload.commentLeadsIps ?? firstItem.commentLeadsIps,
          ),
        },
        items,
      },
    };
  }

  function hasStoredCommentLeadsPayload(syncType, payload) {
    return Boolean(getStoredCommentLeadsState(syncType, payload)?.payload);
  }

  function buildCommentLeadsPayloadForRecord(record, configInput = {}, options = {}) {
    const syncInput = resolveSyncInputForRecord(record);
    const config = normalizeCommentLeadsConfig(configInput);
    const source = getLeadSourceFromSyncPayload(syncInput.syncType, syncInput.payload);
    const preferStored = Boolean(options?.preferStored);
    const storedLeadState = getStoredCommentLeadsState(
      syncInput.syncType,
      syncInput.payload,
    );
    const normalizedComments = source.comments
      .map((item) => normalizeCommentItemForLead(item))
      .filter((item) => item.content);
    const result = {
      enabled: config.enabled,
      hasRules: config.hasRules,
      totalComments: normalizedComments.length,
      matchedCount: 0,
      skipReason: '',
      payload: null,
      source: '',
    };

    if (preferStored && storedLeadState.payload) {
      result.matchedCount = storedLeadState.matchedCount;
      result.payload = storedLeadState.payload;
      result.source = 'stored';
      return result;
    }

    if (!config.enabled) {
      result.skipReason = 'disabled';
      return result;
    }

    if (!config.hasRules) {
      result.skipReason = 'no_rules';
      return result;
    }

    if (!source.noteUrl) {
      result.skipReason = 'missing_note_url';
      return result;
    }

    if (normalizedComments.length === 0) {
      result.skipReason = 'no_comments';
      return result;
    }

    const matchedItems = source.comments
      .map((item) => evaluateCommentLeadItem(item, config))
      .filter(Boolean);
    result.matchedCount = matchedItems.length;

    if (matchedItems.length === 0) {
      result.skipReason = 'zero_matched';
      return result;
    }

    result.payload = {
      noteUrl: source.noteUrl,
      noteTitle: source.noteTitle,
      captureTimestamp: Date.now(),
      filterConfigSnapshot: {
        keywords: config.keywords,
        ips: config.ips,
      },
      items: matchedItems,
    };
    result.source = 'computed';

    return result;
  }

  function applyCommentLeadsSyncState(payload, {
    config,
    leadResult,
    syncStatus = 'not_started',
    syncError = '',
  } = {}) {
    const safeConfig = normalizeCommentLeadsConfig(config);
    const safeLeadResult =
      leadResult && typeof leadResult === 'object'
        ? leadResult
        : { matchedCount: 0, payload: null };
    return applyCommentStatusToPayload(
      payload,
      createCommentStatusPatch({
        status: String(payload?.commentsCaptureStatus || COMMENT_CAPTURE_STATUS.NOT_STARTED),
        startedAt: Number(payload?.commentsCaptureStartedAt || 0),
        finishedAt: Number(payload?.commentsCaptureFinishedAt || 0),
        stoppedByUser: Boolean(payload?.commentsCaptureStoppedByUser),
        error: String(payload?.commentsCaptureError || ''),
        cleanedItems: Array.isArray(payload?.commentsCleanedItems)
          ? payload.commentsCleanedItems
          : [],
        mergedText: String(payload?.commentsMergedText || ''),
        commentLeadsEnabled: safeConfig.enabled,
        commentLeadsKeywords: safeConfig.keywords,
        commentLeadsIps: safeConfig.ips,
        commentLeadsItems: safeLeadResult?.payload?.items || [],
        commentLeadsTotal: Number(safeLeadResult?.matchedCount || 0),
        commentLeadsLastComputedAt: Date.now(),
        commentLeadsSyncStatus: syncStatus,
        commentLeadsSyncError: syncError,
      }),
    );
  }

  function applyCommentResultToSingleNotePayload(payload, result) {
    const now = Date.now();
    const payloadWithoutPreviousObservation =
      clearInterruptedCommentObservation(payload);

    if (result.status === COMMENT_CAPTURE_STATUS.FAILED) {
      return applyCommentStatusToPayload(
        payloadWithoutPreviousObservation,
        createCommentStatusPatch({
          status: COMMENT_CAPTURE_STATUS.FAILED,
          startedAt: now,
          finishedAt: now,
          stoppedByUser: false,
          error: result.error || '评论采集失败',
          cleanedItems: Array.isArray(result.cleanedItems)
            ? result.cleanedItems
            : null,
          mergedText:
            typeof result.mergedText === 'string' ? result.mergedText : null,
        }),
      );
    }

    return applyCommentStatusToPayload(
      payloadWithoutPreviousObservation,
      createCommentStatusPatch({
        status: result.status,
        startedAt: now,
        finishedAt: now,
        stoppedByUser: Boolean(result.stoppedByUser),
        error: result.stoppedByStall ? result.error || '评论采集中断' : '',
        cleanedItems: Array.isArray(result.cleanedItems) ? result.cleanedItems : [],
        mergedText: String(result.mergedText || ''),
      }),
    );
  }

  function applyCommentLeadsToPayload({
    syncType,
    payload,
    commentLeadsConfig,
    computedAt = Date.now(),
  }) {
    const normalizedPayload = applyCommentStatusToPayload(payload, {});
    const normalizedConfig = normalizeCommentLeadsConfig(commentLeadsConfig);
    const leadResult = buildCommentLeadsPayloadForRecord(
      {
        type: syncType,
        payload: normalizedPayload,
      },
      normalizedConfig,
    );

    const nextPayload = applyCommentStatusToPayload(
      normalizedPayload,
      createCommentStatusPatch({
        status:
          normalizedPayload.commentsCaptureStatus || COMMENT_CAPTURE_STATUS.NOT_STARTED,
        startedAt: normalizedPayload.commentsCaptureStartedAt || 0,
        finishedAt: normalizedPayload.commentsCaptureFinishedAt || 0,
        stoppedByUser: Boolean(normalizedPayload.commentsCaptureStoppedByUser),
        error: normalizedPayload.commentsCaptureError || '',
        cleanedItems: normalizedPayload.commentsCleanedItems || [],
        mergedText: normalizedPayload.commentsMergedText || '',
        commentLeadsEnabled: normalizedConfig.enabled,
        commentLeadsKeywords: normalizedConfig.keywords,
        commentLeadsIps: normalizedConfig.ips,
        commentLeadsItems: leadResult.payload?.items || [],
        commentLeadsTotal: leadResult.matchedCount,
        commentLeadsLastComputedAt: computedAt,
      }),
    );

    return {
      payload: nextPayload,
      leadResult,
    };
  }

  return Object.freeze({
    sanitizeCommentLeadItems,
    normalizeCommentLeadSyncStatus,
    applyCommentStatusToPayload,
    createCommentStatusPatch,
    cleanCommentsItems,
    buildCommentsMergedText,
    splitCommentLeadRules,
    buildCommentLeadsConfigFromSettings,
    normalizeCommentLeadsConfig,
    normalizeCommentItemForLead,
    pickFirstNonEmptyString,
    extractUserIdFromProfileUrl,
    resolveCommentUserName,
    resolveCommentIpLocation,
    resolveCommentUserUrl,
    resolveCommentUserId,
    getLeadSourceFromSyncPayload,
    evaluateCommentLeadItem,
    getStoredCommentLeadsState,
    hasStoredCommentLeadsPayload,
    buildCommentLeadsPayloadForRecord,
    applyCommentLeadsSyncState,
    applyCommentResultToSingleNotePayload,
    applyCommentLeadsToPayload,
  });
}
