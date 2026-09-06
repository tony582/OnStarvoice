// L2 payload: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createPayloadStage({state, ports, operations}) {
  const {
    DETAIL_CAPTURE_STATUS,
    SYNC_TYPE,
    buildPlatformSyncInput,
    detectPlatformFromUrl,
    extractDouyinDetailGuardItemId,
    getFirstPayloadItem,
    isDouyinOwnProfileUrl,
    pickDouyinAuthorName,
    resolveExpectedDouyinCommentNoteId,
  } = ports;
  const applyCommentStatusToPayload = (...args) => operations.applyCommentStatusToPayload(...args);
  const ensureBloggerMetricsFields = (...args) => operations.ensureBloggerMetricsFields(...args);
  const getSingleNoteType = (...args) => operations.getSingleNoteType(...args);


  function applySyncPreferencesToPayload(payload = {}, captureSettings = {}) {
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    return {
      ...compactPayloadForBackendSync(safePayload),
      skipOfficialAccounts: captureSettings.skipOfficialAccounts !== false,
    };
  }

  function compactPayloadForBackendSync(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const next = {...source};
    const items = Array.isArray(source.items)
      ? source.items
          .filter((item) => item && typeof item === 'object')
          .map((item) => compactSyncItemForBackend(item))
      : [];

    if (items.length > 0) {
      next.items = items.slice(0, 1);
      // 已补采详情的记录,detailPayload 里才有完整正文/评论/博主指标/小红书号·抖音号。
      // 同步必须保留它,否则后端 sync 从 detailPayload 取不到这些(尤其号)→ 号永远是空。
      // 只有纯列表态(从没补采过详情)才删,避免 payload 膨胀。
      const dp = source.detailPayload;
      const hasDetailPayload =
        dp && typeof dp === 'object' && Object.keys(dp).length > 0;
      if (!hasDetailPayload) {
        delete next.detailPayload;
      }
    }

    delete next.detailCaptureDiagnosticMessage;
    delete next.detailCaptureFailureStage;
    delete next.detailCaptureFailureCategory;
    delete next.cardImageCandidates;
    delete next.cardVideoCandidates;
    delete next.domLocator;
    delete next.domMatchHints;

    return compactSyncItemForBackend(next);
  }

  function trimMediaUrlList(list, primary = '', max = 3) {
    const out = [];
    const seen = new Set();
    const push = (value) => {
      const url = String(value || '').trim();
      if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return;
      seen.add(url);
      out.push(url);
    };
    push(primary);
    (Array.isArray(list) ? list : []).forEach(push);
    return out.slice(0, max);
  }

  function compactSyncItemForBackend(item = {}) {
    const next = item && typeof item === 'object' ? {...item} : {};

    // captureTrace 只用于扩展本地的「页面标记 ↔ 记录 ↔ 详情任务」寻址，
    // 不是后端业务字段。避免仅因 trace 状态变化扩大同步 payload。
    delete next.captureTrace;
    delete next.domLocator;
    delete next.domMatchHints;
    delete next.cardImageCandidates;
    delete next.cardVideoCandidates;
    delete next.mediaDiagnostics;
    delete next.detailDiagnostics;
    delete next.captureDiagnostics;

    // 保留媒体直链：后台「下载附件」依赖 videoUrl/audioUrl（封面+视频+音频）。
    // 之前这里整列清空导致采到的视频直链入库即丢，后台只能下封面。
    next.videoUrls = trimMediaUrlList(next.videoUrls, next.videoUrl);
    next.audioUrls = trimMediaUrlList(next.audioUrls, next.audioUrl);
    next.musicUrls = trimMediaUrlList(next.musicUrls, next.musicUrl);
    next.videoUrl = next.videoUrl || next.videoUrls[0] || '';
    next.audioUrl = next.audioUrl || next.audioUrls[0] || '';
    next.musicUrl = next.musicUrl || next.musicUrls[0] || '';

    return next;
  }

  function resolveSyncInputForRecord(record, target = {}) {
    if (!record || typeof record !== 'object') {
      return {
        platform: 'unknown',
        recordType: '',
        syncType: '',
        payload: {},
        workflow: 'shared_unknown',
        tableName: '',
      };
    }

    const recordType = String(record.type || record.recordType || '').trim();
    if (isRecordHydratedAsSingleNote(record)) {
      const payload = sanitizeDouyinPayloadAuthorsForSync(
        record,
        mergeHydratedDetailIntoRecordPayload(record),
      );
      return buildPlatformSyncInput(record, target, {
        recordType,
        syncType: recordType,
        payload,
      });
    }

    const payload = sanitizeDouyinPayloadAuthorsForSync(
      record,
      record.payload && typeof record.payload === 'object' ? record.payload : {},
    );
    return buildPlatformSyncInput(record, target, {
      recordType,
      syncType: recordType,
      payload,
    });
  }

  function isRecordHydratedAsSingleNote(record) {
    if (!record || typeof record !== 'object') return false;
    if (
      record.type !== SYNC_TYPE.BLOGGER_NOTES &&
      record.type !== SYNC_TYPE.KEYWORD_NOTES
    ) {
      return false;
    }

    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
    const status = String(payload.detailCaptureStatus || '').trim().toLowerCase();
    if (status !== DETAIL_CAPTURE_STATUS.DONE) {
      return false;
    }

    return Boolean(payload.detailPayload && typeof payload.detailPayload === 'object');
  }

  function normalizeSingleNotePayloadForSync(payload) {
    const base = payload && typeof payload === 'object' ? payload : {};
    const normalized = sanitizeMediaFieldsForStorage(ensureBloggerMetricsFields(
      applyCommentStatusToPayload(base, {}),
    ));
    return normalized;
  }

  function sanitizeMediaFieldsForStorage(payload) {
    const base = payload && typeof payload === 'object' ? payload : {};
    const platform = resolvePayloadPlatform(base);
    const noteType = getSingleNoteType(base);

    const sanitizeUrlList = (list) => {
      if (!Array.isArray(list)) return [];
      const seen = new Set();
      const next = [];
      list.forEach((item) => {
        const normalized = normalizeMediaUrlForStorage(item);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        next.push(normalized);
      });
      return next;
    };

    if (noteType === 'image') {
      const imageUrls = sanitizeUrlList([
        ...(Array.isArray(base.imageUrls) ? base.imageUrls : []),
        ...(Array.isArray(base.images) ? base.images : []),
      ]);
      const coverImageUrl =
        normalizeMediaUrlForStorage(base.coverImageUrl) || imageUrls[0] || '';
      const orderedImageUrls = sanitizeUrlList([
        coverImageUrl,
        ...imageUrls,
      ]);

      return clearPlayableMediaFields({
        ...base,
        coverImageUrl,
        imageUrls: orderedImageUrls,
      });
    }

    if (platform !== 'douyin') {
      return base;
    }

    const sanitizeList = (list, kind) => {
      if (!Array.isArray(list)) return [];
      const seen = new Set();
      const next = [];
      list.forEach((item) => {
        const normalized = normalizeMediaUrlForStorage(item);
        if (!normalized || seen.has(normalized)) return;
        if (!isLikelyDownloadableDouyinMediaUrlForStorage(normalized, kind)) return;
        seen.add(normalized);
        next.push(normalized);
      });
      return next;
    };

    const videoUrls = sanitizeList(
      [base.videoUrl, ...(Array.isArray(base.videoUrls) ? base.videoUrls : [])],
      'video',
    );
    const audioUrls = sanitizeList(
      [
        base.audioUrl,
        base.musicUrl,
        ...(Array.isArray(base.audioUrls) ? base.audioUrls : []),
        ...(Array.isArray(base.musicUrls) ? base.musicUrls : []),
      ],
      'audio',
    );

    return {
      ...base,
      videoUrl: videoUrls[0] || '',
      videoUrls,
      audioUrl: audioUrls[0] || '',
      audioUrls,
      musicUrl: audioUrls[0] || '',
      musicUrls: audioUrls,
    };
  }

  function normalizeDetailPayloadAgainstRecord(record, detailPayload) {
    const item = getFirstPayloadItem(record?.payload);
    const base = protectDouyinDetailAuthorAgainstListItem(
      record,
      detailPayload && typeof detailPayload === 'object'
        ? {...detailPayload}
        : {},
      item,
    );

    if (getSingleNoteType(base) !== 'image') {
      return base;
    }

    const listCoverImageUrl = normalizeMediaUrlForStorage(
      item?.coverImageUrl ||
        item?.coverUrl ||
        item?.coverImage ||
        item?.cover ||
        '',
    );
    if (!listCoverImageUrl) {
      return base;
    }

    const imageUrls = [
      listCoverImageUrl,
      ...(Array.isArray(base.imageUrls) ? base.imageUrls : []),
      ...(Array.isArray(base.images) ? base.images : []),
    ];

    return {
      ...base,
      coverImageUrl: listCoverImageUrl,
      imageUrls,
    };
  }

  function protectDouyinDetailAuthorAgainstListItem(
    record,
    detailPayload,
    listItem,
  ) {
    const base = detailPayload && typeof detailPayload === 'object'
      ? detailPayload
      : {};
    const platform = String(
      record?.platform || base?.platform || resolvePayloadPlatform(base),
    ).trim().toLowerCase();
    if (platform !== 'douyin') {
      return base;
    }

    const detailAuthor = pickDouyinAuthorName(
      base.author,
      base.authorName,
      base.nickname,
      base.bloggerName,
    );
    const listAuthor = pickDouyinAuthorName(
      listItem?.author,
      listItem?.authorName,
      listItem?.nickname,
      listItem?.bloggerName,
    );
    const expectedNoteId =
      resolveExpectedDouyinCommentNoteId(record, base.url || base.noteUrl) ||
      extractDouyinDetailGuardItemId(listItem?.noteId) ||
      extractDouyinDetailGuardItemId(listItem?.url);
    const detailNoteIds = [
      base.noteId,
      base.url,
      base.noteUrl,
    ]
      .map(extractDouyinDetailGuardItemId)
      .filter(Boolean);
    const detailIdentityVerified = Boolean(
      expectedNoteId &&
        detailNoteIds.length > 0 &&
        detailNoteIds.every((noteId) => noteId === expectedNoteId),
    );
    // 详情采集已经用作品 ID 绑定到目标作品时，详情作者才是该作品的
    // 第一手证据。搜索列表可能复用旧卡片，不能反向覆盖详情作者。
    // 详情未绑定或作者缺失时，列表作者只作为完整的一组兜底信息。
    const preferDetailAuthor = Boolean(detailAuthor && detailIdentityVerified);
    const preferListAuthor = Boolean(listAuthor && !preferDetailAuthor);
    const author = preferDetailAuthor
      ? detailAuthor
      : preferListAuthor
        ? listAuthor
        : detailAuthor;
    const authorUrl = preferDetailAuthor
      ? pickTrustedDouyinAuthorUrl([
          base.authorProfileUrl,
          base.authorUrl,
          base.bloggerProfileUrl,
          base.profileUrl,
        ])
      : preferListAuthor
        ? pickTrustedDouyinAuthorUrl([
            listItem?.authorProfileUrl,
            listItem?.authorUrl,
            listItem?.bloggerProfileUrl,
            listItem?.profileUrl,
          ])
        : '';
    const detailAuthorId = String(base.authorId || base.bloggerId || '').trim();
    const listAuthorId = String(
      listItem?.authorId || listItem?.bloggerId || '',
    ).trim();
    const authorId = preferDetailAuthor
      ? !/^self$/i.test(detailAuthorId)
        ? detailAuthorId
        : ''
      : preferListAuthor
        ? !/^self$/i.test(listAuthorId)
          ? listAuthorId
          : ''
        : '';

    base.author = author;
    base.authorName = author;
    if (Object.prototype.hasOwnProperty.call(base, 'nickname')) {
      base.nickname = author;
    }
    if (Object.prototype.hasOwnProperty.call(base, 'bloggerName')) {
      base.bloggerName = author;
    }
    base.authorId = authorId;
    base.authorUrl = authorUrl;
    base.bloggerProfileUrl = authorUrl;
    if (Object.prototype.hasOwnProperty.call(base, 'authorProfileUrl')) {
      base.authorProfileUrl = authorUrl;
    }
    if (Object.prototype.hasOwnProperty.call(base, 'profileUrl')) {
      base.profileUrl = authorUrl;
    }
    return base;
  }

  function pickTrustedDouyinAuthorUrl(...candidateGroups) {
    for (const candidates of candidateGroups) {
      for (const candidate of candidates || []) {
        const url = String(candidate || '').trim();
        if (url && !isDouyinOwnProfileUrl(url)) return url;
      }
    }
    return '';
  }

  function sanitizeDouyinPayloadAuthorsForSync(record, payload) {
    const base = payload && typeof payload === 'object' ? payload : {};
    const platform = String(
      record?.platform || base.platform || resolvePayloadPlatform(base),
    ).trim().toLowerCase();
    if (platform !== 'douyin') {
      return base;
    }

    const next = {...base};
    const items = Array.isArray(base.items) ? base.items : [];
    const firstItem = items[0] && typeof items[0] === 'object' ? items[0] : null;
    if (items.length > 0) {
      next.items = items.map((item) =>
        item && typeof item === 'object'
          ? protectDouyinDetailAuthorAgainstListItem(record, {...item}, null)
          : item,
      );
    } else {
      protectDouyinDetailAuthorAgainstListItem(record, next, null);
    }

    if (base.detailPayload && typeof base.detailPayload === 'object') {
      next.detailPayload = protectDouyinDetailAuthorAgainstListItem(
        record,
        {...base.detailPayload},
        firstItem,
      );
    }
    return next;
  }

  function clearPlayableMediaFields(payload) {
    const base = payload && typeof payload === 'object' ? payload : {};
    const media = base.media && typeof base.media === 'object'
      ? {
          ...base.media,
          videoUrl: '',
          videoURL: '',
          video_url: '',
          videoLink: '',
          video_link: '',
          playUrl: '',
          play_url: '',
          videoUrls: [],
          videoList: [],
          videos: [],
          audioUrl: '',
          audioURL: '',
          audio_url: '',
          musicUrl: '',
          music_url: '',
          audioUrls: [],
          musicUrls: [],
        }
      : base.media;

    return {
      ...base,
      media,
      videoUrl: '',
      videoURL: '',
      video_url: '',
      videoLink: '',
      video_link: '',
      playUrl: '',
      play_url: '',
      videoUrls: [],
      videoList: [],
      videos: [],
      audioUrl: '',
      audioURL: '',
      audio_url: '',
      audioUrls: [],
      musicUrl: '',
      music_url: '',
      musicUrls: [],
      audioAvailability: 'not_collected',
    };
  }

  function resolvePayloadPlatform(payload) {
    const explicit = String(payload?.platform || '').trim().toLowerCase();
    if (explicit && explicit !== 'unknown') {
      return explicit;
    }

    const candidates = [
      payload?.url,
      payload?.noteUrl,
      payload?.authorUrl,
    ];

    for (const candidate of candidates) {
      const detected = detectPlatformFromUrl(String(candidate || ''));
      if (detected && detected !== 'unknown') {
        return detected;
      }
    }

    return 'unknown';
  }

  function normalizeMediaUrlForStorage(value) {
    if (!value || typeof value !== 'string') return '';
    let normalized = value.trim();
    if (!normalized) return '';
    if (normalized.startsWith('//')) {
      normalized = `https:${normalized}`;
    } else if (/^http:\/\//i.test(normalized)) {
      normalized = normalized.replace(/^http:\/\//i, 'https://');
    }
    return /^https?:\/\//i.test(normalized) ? normalized : '';
  }

  function isLikelyDownloadableDouyinMediaUrlForStorage(url, kind = 'video') {
    const lower = normalizeMediaUrlForStorage(url).toLowerCase();
    if (!lower) return false;
    if (/^https?:\/\/v\.douyin\.com\//i.test(lower)) return false;
    if (lower.endsWith('.html')) return false;
    if (/^https?:\/\/(?:www\.)?douyin\.com\/(?!aweme\/v1\/play\/)/i.test(lower)) {
      return false;
    }

    if (kind === 'audio') {
      return Boolean(
        lower.includes('xtag=audio') ||
        lower.includes('media-audio') ||
        lower.includes('mime_type=audio_') ||
        lower.includes('ies-music') ||
        lower.includes('music-east') ||
        lower.includes('/obj/ies-music-') ||
        lower.includes('/audio/') ||
        /\.(mp3|m4a|aac|wav|ogg)(\?|$)/i.test(lower)
      );
    }

    return Boolean(
      !lower.includes('media-audio') &&
      !lower.includes('mime_type=audio_') &&
      (
        lower.includes('/aweme/v1/play/') ||
        lower.includes('mime_type=video_') ||
        lower.includes('/video/tos/') ||
        lower.includes('video_id=') ||
        lower.includes('douyinvod.com') ||
        lower.includes('bytevod.com') ||
        lower.includes('zjcdn.com') ||
        /\.(mp4|m3u8|mpd|webm)(\?|$)/i.test(lower)
      )
    );
  }

  function mergeHydratedDetailIntoRecordPayload(record) {
    const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
    const normalizedDetail = normalizeSingleNotePayloadForSync(payload.detailPayload);
    if (!normalizedDetail || typeof normalizedDetail !== 'object') {
      return payload;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const firstItem =
      items[0] && typeof items[0] === 'object' ? items[0] : {};
    // 必须在合并列表字段之前判断详情作者是否真的与目标作品绑定。
    // 否则详情缺少 noteId/url 时，会继承列表作品 ID，并被误判为“详情已验证”，
    // 进而让另一条作品的作者覆盖当前列表作者。
    const detail = protectDouyinDetailAuthorAgainstListItem(
      record,
      {...normalizedDetail},
      firstItem,
    );
    const mergedItem = {
      ...firstItem,
      ...detail,
    };
    protectDouyinDetailAuthorAgainstListItem(record, mergedItem, firstItem);

    // 同一抖音作品的详情正文可能先返回折叠 DOM，稍后才有完整 desc。
    // 只有 DOM 未经接口验证时才保护长版本；完整 API desc 允许真实编辑变短。
    const listTitle = /^抖音搜索结果/.test(String(firstItem.title || ''))
      ? ''
      : firstItem.title;
    const detailPlatform = String(
      record?.platform || detail?.platform || resolvePayloadPlatform(detail),
    ).trim().toLowerCase();
    const detailTextVerified =
      String(detail.contentCompleteness || '').trim().toLowerCase() === 'complete' ||
      String(detail.contentSource || '').trim().toLowerCase() === 'api_detail';
    if (detailPlatform === 'douyin' && !detailTextVerified) {
      mergedItem.title = pickMoreCompleteCapturedText(listTitle, detail.title);
      mergedItem.content = pickMoreCompleteCapturedText(
        firstItem.content || listTitle,
        detail.content || detail.title,
      );
    }

    // 详情增强若返回空标题/正文(典型:抖音图文 desc 常为空),别用空覆盖搜索卡片已采到的真实值。
    // 卡片兜底占位「抖音搜索结果 N」不算真标题,不回填;抖音正文=标题,缺正文时用标题补。
    if (!mergedItem.title && firstItem.title && !/^抖音搜索结果/.test(String(firstItem.title))) {
      mergedItem.title = firstItem.title;
    }
    if (!mergedItem.content && firstItem.content) mergedItem.content = firstItem.content;
    if (!mergedItem.content && mergedItem.title) mergedItem.content = mergedItem.title;

    if (!mergedItem.url && mergedItem.noteUrl) mergedItem.url = mergedItem.noteUrl;
    if (!mergedItem.noteUrl && mergedItem.url) mergedItem.noteUrl = mergedItem.url;
    if (!mergedItem.title && mergedItem.noteTitle) mergedItem.title = mergedItem.noteTitle;
    if (!mergedItem.noteTitle && mergedItem.title) mergedItem.noteTitle = mergedItem.title;
    if (!mergedItem.author && mergedItem.authorName) mergedItem.author = mergedItem.authorName;
    if (!mergedItem.authorName && mergedItem.author) mergedItem.authorName = mergedItem.author;
    if ((mergedItem.likes == null || mergedItem.likes === '') && mergedItem.likeCount != null) {
      mergedItem.likes = mergedItem.likeCount;
    }
    if (
      (mergedItem.likeCount == null || mergedItem.likeCount === '') &&
      mergedItem.likes != null
    ) {
      mergedItem.likeCount = mergedItem.likes;
    }
    if (!mergedItem.noteType && mergedItem.type) mergedItem.noteType = mergedItem.type;
    if (!mergedItem.type && mergedItem.noteType) mergedItem.type = mergedItem.noteType;

    const mergedItems = items.length > 0 ? [mergedItem, ...items.slice(1)] : [mergedItem];
    return {
      ...payload,
      detailPayload:
        payload.detailPayload && typeof payload.detailPayload === 'object'
          ? {
              ...payload.detailPayload,
              title: mergedItem.title,
              content: mergedItem.content,
            }
          : payload.detailPayload,
      items: mergedItems,
      totalCount: payload.totalCount || mergedItems.length,
    };
  }

  function pickMoreCompleteCapturedText(existingValue, incomingValue) {
    const existing = String(existingValue || '').trim();
    const incoming = String(incomingValue || '').trim();
    if (!incoming) return existing;
    if (!existing) return incoming;
    const comparable = value => String(value || '')
      .normalize('NFKC')
      .trim()
      .replace(/\s*(?:\.{3}|…+)\s*展开\s*$/u, '')
      .replace(/\s+/gu, '');
    const existingComparable = comparable(existing);
    const incomingComparable = comparable(incoming);
    if (
      incomingComparable.length < existingComparable.length &&
      existingComparable.startsWith(incomingComparable)
    ) {
      return existing;
    }
    if (
      existingComparable.length < incomingComparable.length &&
      incomingComparable.startsWith(existingComparable)
    ) {
      return incoming;
    }
    return incoming;
  }

  return Object.freeze({
    applySyncPreferencesToPayload,
    compactPayloadForBackendSync,
    trimMediaUrlList,
    compactSyncItemForBackend,
    resolveSyncInputForRecord,
    isRecordHydratedAsSingleNote,
    normalizeSingleNotePayloadForSync,
    sanitizeMediaFieldsForStorage,
    normalizeDetailPayloadAgainstRecord,
    protectDouyinDetailAuthorAgainstListItem,
    pickTrustedDouyinAuthorUrl,
    sanitizeDouyinPayloadAuthorsForSync,
    clearPlayableMediaFields,
    resolvePayloadPlatform,
    normalizeMediaUrlForStorage,
    isLikelyDownloadableDouyinMediaUrlForStorage,
    mergeHydratedDetailIntoRecordPayload,
    pickMoreCompleteCapturedText,
  });
}
