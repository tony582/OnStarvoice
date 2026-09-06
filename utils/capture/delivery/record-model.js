// L2 record-model: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createRecordModelStage({state, ports, operations}) {
  const {
    BLOGGER_METRICS_CAPTURE_STATUS,
    DETAIL_CAPTURE_STATUS,
    createRecordEnvelope,
  } = ports;
  const applyCaptureTraceToRecord = (...args) => operations.applyCaptureTraceToRecord(...args);
  const applyCommentStatusToPayload = (...args) => operations.applyCommentStatusToPayload(...args);
  const bindCaptureTrace = (...args) => operations.bindCaptureTrace(...args);
  const ensureBloggerMetricsFields = (...args) => operations.ensureBloggerMetricsFields(...args);
  const isFiniteNonNegativeNumber = (...args) => operations.isFiniteNonNegativeNumber(...args);
  const isValidBloggerMetricsStatus = (...args) => operations.isValidBloggerMetricsStatus(...args);
  const normalizeBloggerAccountType = (...args) => operations.normalizeBloggerAccountType(...args);
  const resolveCaptureTraceFromPayload = (...args) => operations.resolveCaptureTraceFromPayload(...args);


  function resolveDetailRecordItemMetricsStatus(item, payload) {
    const itemStatus = String(item?.bloggerMetricsCaptureStatus || '')
      .trim()
      .toLowerCase();
    if (isValidBloggerMetricsStatus(itemStatus)) return itemStatus;

    const payloadStatus = String(payload?.bloggerMetricsCaptureStatus || '')
      .trim()
      .toLowerCase();
    if (isValidBloggerMetricsStatus(payloadStatus)) return payloadStatus;

    const hasMetricsData =
      isFiniteNonNegativeNumber(item?.bloggerFollowersCount) ||
      isFiniteNonNegativeNumber(item?.bloggerLikedAndCollectedCount) ||
      isFiniteNonNegativeNumber(payload?.bloggerFollowersCount) ||
      isFiniteNonNegativeNumber(payload?.bloggerLikedAndCollectedCount) ||
      Boolean(
        normalizeBloggerAccountType(
          item?.bloggerAccountType || payload?.bloggerAccountType,
        ),
      );

    if (hasMetricsData) {
      return BLOGGER_METRICS_CAPTURE_STATUS.DONE;
    }

    return BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED;
  }

  function normalizeDetailRecordItem(item, payload) {
    const rawItem = item && typeof item === 'object' ? item : {};
    const rawPayload = payload && typeof payload === 'object' ? payload : {};

    return ensureBloggerMetricsFields(sanitizeListItemForStorage({
      ...rawItem,
      bloggerFollowersCount:
        rawItem.bloggerFollowersCount ??
        rawPayload.bloggerFollowersCount ??
        rawPayload.followersCount,
      bloggerLikedAndCollectedCount:
        rawItem.bloggerLikedAndCollectedCount ??
        rawPayload.bloggerLikedAndCollectedCount ??
        rawPayload.likedAndCollectedCount,
      bloggerProfileUrl:
        rawItem.bloggerProfileUrl || rawItem.authorUrl || rawPayload.bloggerUrl || '',
      bloggerMetricsCaptureStatus: resolveDetailRecordItemMetricsStatus(
        rawItem,
        rawPayload,
      ),
      bloggerMetricsCaptureError:
        String(rawItem.bloggerMetricsCaptureError || rawPayload.bloggerMetricsCaptureError || ''),
      bloggerAccountType: normalizeBloggerAccountType(
        rawItem.bloggerAccountType || rawPayload.bloggerAccountType,
      ),
    }));
  }

  function truncateStorageString(value, maxLength = 240) {
    const text = String(value || '').trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  function trimStorageStringList(value, maxItems = 3, maxLength = 360) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => truncateStorageString(item, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  }

  function sanitizeDomLocatorForStorage(locator) {
    if (!locator || typeof locator !== 'object') {
      return locator || null;
    }

    return {
      ...locator,
      className: truncateStorageString(locator.className, 160),
      textSnippet: truncateStorageString(locator.textSnippet, 100),
      cssPath: truncateStorageString(locator.cssPath, 240),
      parentCssPath: truncateStorageString(locator.parentCssPath, 240),
      imageFingerprints: trimStorageStringList(locator.imageFingerprints, 3, 220),
      videoFingerprints: trimStorageStringList(locator.videoFingerprints, 2, 220),
    };
  }

  function sanitizeDomMatchHintsForStorage(hints) {
    if (!hints || typeof hints !== 'object') {
      return hints || null;
    }

    return {
      ...hints,
      noteUrl: truncateStorageString(hints.noteUrl, 360),
      noteUrlFingerprint: truncateStorageString(hints.noteUrlFingerprint, 220),
      coverImageUrl: truncateStorageString(hints.coverImageUrl, 360),
      coverImageFingerprint: truncateStorageString(
        hints.coverImageFingerprint,
        220,
      ),
      videoUrl: '',
      videoUrlFingerprint: '',
      titleSnippet: truncateStorageString(hints.titleSnippet, 80),
      authorSnippet: truncateStorageString(hints.authorSnippet, 80),
    };
  }

  function sanitizeListItemForStorage(item) {
    if (!item || typeof item !== 'object') {
      return item || {};
    }

    return {
      ...item,
      videoUrl: '',
      videoUrls: [],
      audioUrl: '',
      audioUrls: [],
      cardImageCandidates: trimStorageStringList(item.cardImageCandidates, 2, 360),
      cardVideoCandidates: [],
      domLocator: sanitizeDomLocatorForStorage(item.domLocator),
      domMatchHints: sanitizeDomMatchHintsForStorage(item.domMatchHints),
    };
  }

  function ensureDetailCaptureFields(payload) {
    const base = payload && typeof payload === 'object' ? payload : {};
    return {
      ...base,
      detailCaptureStatus:
        base.detailCaptureStatus || DETAIL_CAPTURE_STATUS.NOT_STARTED,
      detailCaptureError: String(base.detailCaptureError || ''),
      detailCaptureFailureCode: String(base.detailCaptureFailureCode || ''),
      detailCaptureFailureStage: String(base.detailCaptureFailureStage || ''),
      detailCaptureFailureCategory: String(base.detailCaptureFailureCategory || ''),
      detailCaptureDiagnosticMessage: String(base.detailCaptureDiagnosticMessage || ''),
      detailCaptureStartedAt: Number(base.detailCaptureStartedAt || 0),
      detailCaptureFinishedAt: Number(base.detailCaptureFinishedAt || 0),
      detailCaptureNoteUrl: String(base.detailCaptureNoteUrl || ''),
      detailPayload:
        base.detailPayload && typeof base.detailPayload === 'object'
          ? ensureBloggerMetricsFields(
              applyCommentStatusToPayload(base.detailPayload, {}),
            )
          : null,
    };
  }

  function applyDetailCapturePatch(payload, patch) {
    const base = ensureDetailCaptureFields(payload);
    return {
      ...base,
      detailCaptureStatus: patch.detailCaptureStatus ?? base.detailCaptureStatus,
      detailCaptureError: patch.detailCaptureError ?? base.detailCaptureError,
      detailCaptureFailureCode:
        patch.detailCaptureFailureCode ?? base.detailCaptureFailureCode,
      detailCaptureFailureStage:
        patch.detailCaptureFailureStage ?? base.detailCaptureFailureStage,
      detailCaptureFailureCategory:
        patch.detailCaptureFailureCategory ?? base.detailCaptureFailureCategory,
      detailCaptureDiagnosticMessage:
        patch.detailCaptureDiagnosticMessage ?? base.detailCaptureDiagnosticMessage,
      detailCaptureStartedAt:
        patch.detailCaptureStartedAt ?? base.detailCaptureStartedAt,
      detailCaptureFinishedAt:
        patch.detailCaptureFinishedAt ?? base.detailCaptureFinishedAt,
      detailCaptureNoteUrl:
        patch.detailCaptureNoteUrl ?? base.detailCaptureNoteUrl,
      detailPayload:
        patch.detailPayload !== undefined ? patch.detailPayload : base.detailPayload,
    };
  }

  function createDetailCapturePatch({
    status,
    startedAt = 0,
    finishedAt = 0,
    error = '',
    failureCode = '',
    failureStage = '',
    failureCategory = '',
    diagnosticMessage = '',
    noteUrl = '',
    detailPayload = undefined,
  }) {
    return {
      detailCaptureStatus: status,
      detailCaptureError: error,
      detailCaptureFailureCode: failureCode,
      detailCaptureFailureStage: failureStage,
      detailCaptureFailureCategory: failureCategory,
      detailCaptureDiagnosticMessage: diagnosticMessage,
      detailCaptureStartedAt: startedAt,
      detailCaptureFinishedAt: finishedAt,
      detailCaptureNoteUrl: noteUrl,
      detailPayload,
    };
  }

  function buildRecordsForStorage(captureResult) {
    const type = captureResult?.type || '';
    const payload =
      captureResult?.data && typeof captureResult.data === 'object'
        ? captureResult.data
        : null;
    const meta =
      captureResult?.meta && typeof captureResult.meta === 'object'
        ? captureResult.meta
        : {};
    const platform = captureResult?.platform || '';

    if (!payload || typeof payload !== 'object') {
      return [];
    }

    // 将博主笔记/搜索笔记按“单条笔记”拆分缓存，便于页面逐条展示和操作
    if ((type === 'blogger_notes' || type === 'keyword_notes') && Array.isArray(payload.items)) {
      if (payload.items.length === 0) return [];

      return payload.items.map((item) => {
        const normalizedItem = normalizeDetailRecordItem(item, payload);
        const nextPayload = ensureDetailCaptureFields({
          ...payload,
          totalCount: 1,
          items: [normalizedItem],
        });
        const preview = buildRecordPreview(type, nextPayload);
        const record = {
          ...createRecordEnvelope({
            platform,
            type,
            data: nextPayload,
            meta,
          }),
          title: preview.title,
          summary: preview.summary,
        };
        const boundTrace = bindCaptureTrace(
          normalizedItem.captureTrace,
          record.id,
          'saved',
        );
        return boundTrace
          ? applyCaptureTraceToRecord(record, boundTrace)
          : record;
      });
    }

    const preview = buildRecordPreview(type, payload);
    const record = {
      ...createRecordEnvelope({
        platform,
        type,
        data: payload,
        meta,
      }),
      title: preview.title,
      summary: preview.summary,
    };
    const boundTrace = bindCaptureTrace(
      resolveCaptureTraceFromPayload(payload),
      record.id,
      'saved',
    );
    return [boundTrace ? applyCaptureTraceToRecord(record, boundTrace) : record];
  }

  function buildRecordPreview(type, payload) {
    if (!payload || typeof payload !== 'object') {
      return { title: '无标题数据', summary: '无内容摘要...' };
    }

    if (type === 'single_note') {
      return {
        title: payload.title || payload.noteId || '单篇笔记',
        summary: payload.content || payload.url || '单篇笔记采集数据',
      };
    }

    if (type === 'blogger_profile') {
      return {
        title: payload.bloggerName || payload.bloggerId || '博主信息',
        summary: payload.description || payload.bloggerUrl || '博主主页信息采集数据',
      };
    }

    if (type === 'blogger_notes') {
      const firstItem = (payload.items || [])[0] || {};
      return {
        title: firstItem.title || '博主笔记',
        summary: `${firstItem.author || payload.bloggerName || '作者未知'} · 点赞 ${firstItem.likes || 0}`,
      };
    }

    if (type === 'keyword_notes') {
      const firstItem = (payload.items || [])[0] || {};
      const sortDimension = String(payload.sortDimension || '').trim().toLowerCase();
      const metricLabel =
        sortDimension === 'collects'
          ? '收藏'
          : sortDimension === 'comments'
            ? '评论'
            : '点赞';
      const metricValue =
        sortDimension === 'collects'
          ? firstItem.collects || 0
          : sortDimension === 'comments'
            ? firstItem.comments || 0
            : firstItem.likes || 0;
      return {
        title: firstItem.title || (payload.keyword ? `关键词：${payload.keyword}` : '搜索结果笔记'),
        summary: `${firstItem.author || '作者未知'} · ${metricLabel} ${metricValue}`,
      };
    }

    if (type === 'comments') {
      return {
        title: payload.noteTitle || payload.noteId || '评论采集',
        summary: `共 ${payload.totalCount || 0} 条评论`,
      };
    }

    return { title: '无标题数据', summary: '无内容摘要...' };
  }

  return Object.freeze({
    resolveDetailRecordItemMetricsStatus,
    normalizeDetailRecordItem,
    truncateStorageString,
    trimStorageStringList,
    sanitizeDomLocatorForStorage,
    sanitizeDomMatchHintsForStorage,
    sanitizeListItemForStorage,
    ensureDetailCaptureFields,
    applyDetailCapturePatch,
    createDetailCapturePatch,
    buildRecordsForStorage,
    buildRecordPreview,
  });
}
