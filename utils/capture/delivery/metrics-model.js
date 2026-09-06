// L2 metrics-model: unchanged stage behavior, explicit host ports and per-pipeline state.
export function createMetricsModelStage({state, ports, operations}) {
  const {
    BLOGGER_METRICS_CAPTURE_STATUS,
    normalizeOpenUrl,
    parseInteractionCount,
  } = ports;



  function normalizeBloggerAccountType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'famous') return 'famous';
    if (normalized === 'company') return 'company';
    return '';
  }

  function normalizeNonNegativeNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return 0;
    }
    return Math.floor(num);
  }

  function normalizeOptionalCount(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = parseInteractionCount(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return Math.floor(parsed);
  }

  function isExplicitCountValue(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0;
    }
    return /[0-9]/u.test(String(value ?? ''));
  }

  function resolveProvenBloggerMetricCount(
    payload,
    {
      valueKeys = [],
      knownKeys = [],
    } = {},
  ) {
    const safePayload =
      payload && typeof payload === 'object' ? payload : {};
    const explicitlyKnown = knownKeys.some(
      (key) => safePayload[key] === true,
    );

    for (const key of valueKeys) {
      if (!Object.prototype.hasOwnProperty.call(safePayload, key)) continue;
      const rawCount = safePayload[key];
      if (!isExplicitCountValue(rawCount)) continue;
      const count = normalizeOptionalCount(rawCount);
      if (count === null) continue;
      // Positive values cannot be introduced by the zero-default normalizer.
      // Zero is evidence only when the extractor explicitly marks the metric
      // known; a generic completed/defaulted payload is not sufficient proof.
      if (count > 0 || explicitlyKnown) return count;
    }
    return null;
  }

  function resolveProvenBloggerFollowersCount(payload) {
    return resolveProvenBloggerMetricCount(payload, {
      valueKeys: ['bloggerFollowersCount', 'followersCount'],
      knownKeys: ['bloggerFollowersCountKnown', 'followersCountKnown'],
    });
  }

  function resolveProvenBloggerLikedAndCollectedCount(payload) {
    return resolveProvenBloggerMetricCount(payload, {
      valueKeys: [
        'bloggerLikedAndCollectedCount',
        'likedAndCollectedCount',
      ],
      knownKeys: [
        'bloggerLikedAndCollectedCountKnown',
        'likedAndCollectedCountKnown',
      ],
    });
  }

  function pickFirstCountFromSources(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const count = normalizeOptionalCount(source[key]);
        if (count !== null) return count;
      }
    }
    return null;
  }

  function resolveRecordListCommentsCount(record = {}) {
    const payload =
      record?.payload && typeof record.payload === 'object'
        ? record.payload
        : {};
    const firstItem =
      Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
        ? payload.items[0]
        : {};
    return pickFirstCountFromSources([firstItem, payload], [
      'comments',
      'commentCount',
      'comment_count',
      'commentsCount',
      'comments_count',
    ]);
  }

  function resolveKnownCommentsCountForDetailCapture(
    record = {},
    detailPayload = {},
  ) {
    const countKeys = [
      'comments',
      'commentCount',
      'comment_count',
      'commentsCount',
      'comments_count',
    ];
    const knownKeys = [
      'commentsCountKnown',
      'commentCountKnown',
      'comment_count_known',
      'comments_count_known',
    ];
    const pickProvenCount = (sources = []) => {
      for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        const isKnown = knownKeys.some((key) => source[key] === true);
        if (!isKnown) continue;
        for (const key of countKeys) {
          if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
          const rawCount = source[key];
          if (
            typeof rawCount !== 'number' &&
            !/[0-9]/.test(String(rawCount ?? ''))
          ) {
            continue;
          }
          const count = normalizeOptionalCount(rawCount);
          if (count !== null) return count;
        }
      }
      return null;
    };

    const detailCount = pickProvenCount([detailPayload]);
    if (detailCount !== null) return detailCount;

    const payload =
      record?.payload && typeof record.payload === 'object'
        ? record.payload
        : {};
    const firstItem =
      Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
        ? payload.items[0]
        : {};
    return pickProvenCount([firstItem, payload]);
  }

  function isValidBloggerMetricsStatus(status) {
    return (
      status === BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED ||
      status === BLOGGER_METRICS_CAPTURE_STATUS.DONE ||
      status === BLOGGER_METRICS_CAPTURE_STATUS.FAILED
    );
  }

  function isFiniteNonNegativeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0;
  }

  function ensureBloggerMetricsFields(payload) {
    const base = payload && typeof payload === 'object' ? payload : {};
    const rawStatus = String(base.bloggerMetricsCaptureStatus || '')
      .trim()
      .toLowerCase();
    const status = isValidBloggerMetricsStatus(rawStatus)
      ? rawStatus
      : BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED;

    return {
      ...base,
      bloggerFollowersCount: normalizeNonNegativeNumber(
        base.bloggerFollowersCount ?? base.followersCount,
      ),
      bloggerLikedAndCollectedCount: normalizeNonNegativeNumber(
        base.bloggerLikedAndCollectedCount ?? base.likedAndCollectedCount,
      ),
      bloggerFollowersCountKnown:
        base.bloggerFollowersCountKnown === true ||
        base.followersCountKnown === true,
      bloggerLikedAndCollectedCountKnown:
        base.bloggerLikedAndCollectedCountKnown === true ||
        base.likedAndCollectedCountKnown === true,
      bloggerProfileUrl: String(base.bloggerProfileUrl || base.authorUrl || ''),
      bloggerMetricsCaptureStatus: status,
      bloggerMetricsCaptureError: String(base.bloggerMetricsCaptureError || ''),
      bloggerAccountType: normalizeBloggerAccountType(base.bloggerAccountType),
      bloggerUserId: String(base.bloggerUserId || ''),
    };
  }

  function applyBloggerMetricsPatch(payload, patch) {
    const base = ensureBloggerMetricsFields(payload);
    const bloggerName = patch.bloggerName === undefined
      ? ''
      : String(patch.bloggerName || '').trim();
    return {
      ...base,
      ...(bloggerName
        ? {
            bloggerName,
            author: bloggerName,
            authorName: bloggerName,
            authorNameBoundToProfile: true,
          }
        : {}),
      bloggerFollowersCount:
        patch.bloggerFollowersCount ?? base.bloggerFollowersCount,
      bloggerLikedAndCollectedCount:
        patch.bloggerLikedAndCollectedCount ?? base.bloggerLikedAndCollectedCount,
      bloggerFollowersCountKnown:
        patch.bloggerFollowersCountKnown ?? base.bloggerFollowersCountKnown,
      bloggerLikedAndCollectedCountKnown:
        patch.bloggerLikedAndCollectedCountKnown ??
        base.bloggerLikedAndCollectedCountKnown,
      bloggerProfileUrl: patch.bloggerProfileUrl ?? base.bloggerProfileUrl,
      bloggerMetricsCaptureStatus:
        patch.bloggerMetricsCaptureStatus ?? base.bloggerMetricsCaptureStatus,
      bloggerMetricsCaptureError:
        patch.bloggerMetricsCaptureError ?? base.bloggerMetricsCaptureError,
      bloggerAccountType: patch.bloggerAccountType ?? base.bloggerAccountType,
      bloggerUserId: patch.bloggerUserId ?? base.bloggerUserId,
    };
  }

  function createBloggerMetricsPatch({
    status,
    followersCount,
    likedAndCollectedCount,
    profileUrl,
    error,
    accountType,
    bloggerId,
    bloggerName,
    followersCountKnown,
    likedAndCollectedCountKnown,
  }) {
    const patch = {
      bloggerMetricsCaptureStatus: status,
      bloggerMetricsCaptureError: String(error || ''),
    };

    if (followersCount !== undefined) {
      patch.bloggerFollowersCount = normalizeNonNegativeNumber(followersCount);
    }
    if (likedAndCollectedCount !== undefined) {
      patch.bloggerLikedAndCollectedCount = normalizeNonNegativeNumber(
        likedAndCollectedCount,
      );
    }
    if (followersCountKnown !== undefined) {
      patch.bloggerFollowersCountKnown = followersCountKnown === true;
    }
    if (likedAndCollectedCountKnown !== undefined) {
      patch.bloggerLikedAndCollectedCountKnown =
        likedAndCollectedCountKnown === true;
    }
    if (profileUrl !== undefined) {
      patch.bloggerProfileUrl = String(profileUrl || '');
    }
    if (accountType !== undefined) {
      patch.bloggerAccountType = normalizeBloggerAccountType(accountType);
    }
    if (bloggerId !== undefined) {
      patch.bloggerUserId = String(bloggerId || '');
    }
    if (bloggerName !== undefined) {
      patch.bloggerName = String(bloggerName || '').trim();
    }

    return patch;
  }

  function isInternalAccountNo(value) {
    const v = String(value || '').trim();
    if (!v) return true;
    if (/^[0-9a-f]{24}$/i.test(v)) return true; // 小红书内部 user_id
    if (/^MS4w/i.test(v)) return true; // 抖音 sec_uid
    return false;
  }

  function pickHumanAccountNo(payload = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const candidates = [
      p.bloggerUserId,
      p.redId,
      p.douyinId, // 抖音号(extractDouyinId),非 sec_uid
      p.authorUsername, // 抖音作品页 API unique_id
      p.bloggerId, // 小红书:此处常是号;但抖音是 sec_uid → 被过滤
    ];
    for (const c of candidates) {
      const v = String(c || '').trim();
      if (v && !isInternalAccountNo(v)) return v;
    }
    return '';
  }

  function resolveBloggerMetricsFromProfilePayload(
    profilePayload = {},
    fallbackProfileUrl = '',
  ) {
    const safePayload =
      profilePayload && typeof profilePayload === 'object' ? profilePayload : {};
    const rawFollowersCount =
      safePayload.bloggerFollowersCount ?? safePayload.followersCount;
    const rawLikedAndCollectedCount =
      safePayload.bloggerLikedAndCollectedCount ??
      safePayload.likedAndCollectedCount;

    return createBloggerMetricsPatch({
      status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
      followersCount: rawFollowersCount,
      likedAndCollectedCount: rawLikedAndCollectedCount,
      followersCountKnown:
        isExplicitCountValue(rawFollowersCount) &&
        normalizeOptionalCount(rawFollowersCount) !== null,
      likedAndCollectedCountKnown:
        isExplicitCountValue(rawLikedAndCollectedCount) &&
        normalizeOptionalCount(rawLikedAndCollectedCount) !== null,
      profileUrl:
        safePayload.bloggerProfileUrl ||
        safePayload.authorUrl ||
        safePayload.bloggerUrl ||
        fallbackProfileUrl,
      error: '',
      accountType: safePayload.bloggerAccountType || safePayload.accountType,
      bloggerName:
        safePayload.bloggerName ||
        safePayload.authorName ||
        safePayload.author ||
        safePayload.nickname,
      // 只回填「人看的号」,内部 hex / sec_uid 一律不写(宁可空也不写错)
      bloggerId: pickHumanAccountNo(safePayload),
    });
  }

  function resolveBloggerMetricsPatchFromCurrentPayload(
    payload = {},
    { requireBothMetrics = false } = {},
  ) {
    const normalizedPayload = ensureBloggerMetricsFields(payload);
    const followersCount = resolveProvenBloggerFollowersCount(payload);
    const likedAndCollectedCount =
      resolveProvenBloggerLikedAndCollectedCount(payload);

    if (requireBothMetrics) {
      if (followersCount === null || likedAndCollectedCount === null) {
        return null;
      }
    } else if (followersCount === null && likedAndCollectedCount === null) {
      return null;
    }

    return createBloggerMetricsPatch({
      status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
      followersCount: followersCount ?? undefined,
      likedAndCollectedCount: likedAndCollectedCount ?? undefined,
      followersCountKnown: followersCount !== null,
      likedAndCollectedCountKnown: likedAndCollectedCount !== null,
      profileUrl:
        normalizedPayload.bloggerProfileUrl ||
        resolveBloggerProfileUrlFromPayload(normalizedPayload),
      error: '',
      accountType:
        normalizedPayload.bloggerAccountType || normalizedPayload.accountType,
      // 抖音号(unique_id,来自作品页 API)→ author_account_no;过滤掉 sec_uid/内部 hex
      bloggerId: pickHumanAccountNo(normalizedPayload),
    });
  }

  function applyBloggerMetricsResultToPayload(payload, result) {
    if (result?.ok) {
      const patch =
        result.patch ||
        createBloggerMetricsPatch({
          status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
          error: '',
        });
      return applyBloggerMetricsPatch(payload, patch);
    }

    return applyBloggerMetricsPatch(
      payload,
      createBloggerMetricsPatch({
        status: BLOGGER_METRICS_CAPTURE_STATUS.FAILED,
        error: result?.error || '博主指标采集失败',
        profileUrl: result?.profileUrl,
      }),
    );
  }

  function resolveBloggerProfileUrlFromPayload(payload) {
    const base = payload && typeof payload === 'object' ? payload : {};
    const candidates = [base.authorUrl, base.bloggerProfileUrl, base.bloggerUrl];

    for (const candidate of candidates) {
      const normalized = normalizeOpenUrl(candidate);
      if (normalized) return normalized;
    }

    return '';
  }

  return Object.freeze({
    normalizeBloggerAccountType,
    normalizeNonNegativeNumber,
    normalizeOptionalCount,
    isExplicitCountValue,
    resolveProvenBloggerMetricCount,
    resolveProvenBloggerFollowersCount,
    resolveProvenBloggerLikedAndCollectedCount,
    pickFirstCountFromSources,
    resolveRecordListCommentsCount,
    resolveKnownCommentsCountForDetailCapture,
    isValidBloggerMetricsStatus,
    isFiniteNonNegativeNumber,
    ensureBloggerMetricsFields,
    applyBloggerMetricsPatch,
    createBloggerMetricsPatch,
    isInternalAccountNo,
    pickHumanAccountNo,
    resolveBloggerMetricsFromProfilePayload,
    resolveBloggerMetricsPatchFromCurrentPayload,
    applyBloggerMetricsResultToPayload,
    resolveBloggerProfileUrlFromPayload,
  });
}
