/**
 * 采集偏好本地配置（共享层 + 场景层）
 */

export const CAPTURE_SETTINGS_KEYS = {
  AUTO_DETAIL_CAPTURE_AFTER_LIST_CAPTURE:
    "capture.autoDetailCaptureAfterListCapture",
  COMMENTS_MAX_DETECTED_ITEMS: "capture.commentsMaxDetectedItems",
  DETAIL_COMMENTS_MAX_DETECTED_ITEMS: "capture.detailCommentsMaxDetectedItems",
  INCLUDE_COMMENTS_ON_NOTE_CAPTURE: "capture.includeCommentsOnNoteCapture",
  INCLUDE_COMMENTS_ON_DETAIL_CAPTURE: "capture.includeCommentsOnDetailCapture",
  ENABLE_COMMENT_LEADS_FILTER: "capture.enableCommentLeadsFilter",
  ENABLE_COMMENT_LEADS_FILTER_ON_DETAIL_CAPTURE:
    "capture.enableCommentLeadsFilterOnDetailCapture",
  COMMENT_LEADS_KEYWORDS: "capture.commentLeadsKeywords",
  COMMENT_LEADS_IPS: "capture.commentLeadsIps",
  INCLUDE_BLOGGER_METRICS_ON_NOTE_CAPTURE:
    "capture.includeBloggerMetricsOnNoteCapture",
  INCLUDE_BLOGGER_METRICS_ON_DETAIL_CAPTURE:
    "capture.includeBloggerMetricsOnDetailCapture",
  ENABLE_LOW_FOLLOWER_HIT_FILTER: "capture.enableLowFollowerHitFilter",
  ENABLE_LOW_FOLLOWER_HIT_FILTER_ON_DETAIL_CAPTURE:
    "capture.enableLowFollowerHitFilterOnDetailCapture",
  LOW_FOLLOWER_HIT_THRESHOLD: "capture.lowFollowerHitThreshold",
  LOW_FOLLOWER_HIT_THRESHOLD_ON_DETAIL_CAPTURE:
    "capture.lowFollowerHitThresholdOnDetailCapture",
  SYNC_SCOPE: "capture.syncScope",
  DETAIL_CAPTURE_SCOPE: "capture.detailCaptureScope",
  SHARED_WAIT_MIN_MS: "capture.sharedWaitMinMs",
  SHARED_WAIT_MAX_MS: "capture.sharedWaitMaxMs",
  SHARED_STALL_TIMEOUT_MS: "capture.sharedStallTimeoutMs",
  SHARED_MAX_DURATION_MS: "capture.sharedMaxDurationMs",
  DETAIL_NAV_TIMEOUT_MS: "capture.detailNavTimeoutMs",
  DETAIL_AFTER_NAV_WAIT_MS: "capture.detailAfterNavWaitMs",
  PROFILE_AFTER_NAV_WAIT_MS: "capture.profileAfterNavWaitMs",
  BLOGGER_MAX_DETECTED_ITEMS: "capture.bloggerMaxDetectedItems",
  BLOGGER_MIN_LIKES: "capture.bloggerMinLikes",
  KEYWORD_MAX_DETECTED_ITEMS: "capture.keywordMaxDetectedItems",
  KEYWORD_MIN_LIKES: "capture.keywordMinLikes",
  BLOGGER_KEYWORD_FILTER: "capture.bloggerKeywordFilter",
};

const LEGACY_CAPTURE_SETTINGS_KEYS = {
  COMMENTS_MAX_ITEMS: "capture.commentsMaxItems",
  BLOGGER_MAX_ITEMS: "capture.bloggerMaxItems",
  KEYWORD_MAX_ITEMS: "capture.keywordMaxItems",
  COMMENTS_WAIT_MIN_MS: "capture.commentsWaitMinMs",
  COMMENTS_WAIT_MAX_MS: "capture.commentsWaitMaxMs",
  COMMENTS_STALL_TIMEOUT_MS: "capture.commentsStallTimeoutMs",
};

export const DEFAULT_CAPTURE_SETTINGS = {
  autoDetailCaptureAfterListCapture: false,
  commentsMaxDetectedItems: 50,
  detailCommentsMaxDetectedItems: 50,
  includeCommentsOnNoteCapture: false,
  includeCommentsOnDetailCapture: false,
  enableCommentLeadsFilter: false,
  enableCommentLeadsFilterOnDetailCapture: false,
  commentLeadsKeywords: "",
  commentLeadsIps: "",
  includeBloggerMetricsOnNoteCapture: false,
  includeBloggerMetricsOnDetailCapture: false,
  enableLowFollowerHitFilter: false,
  enableLowFollowerHitFilterOnDetailCapture: false,
  lowFollowerHitThreshold: 10000,
  lowFollowerHitThresholdOnDetailCapture: 10000,
  syncScope: "pending",
  detailCaptureScope: "pending",
  sharedWaitMinMs: 3000,
  sharedWaitMaxMs: 6000,
  sharedStallTimeoutMs: 5000,
  sharedMaxDurationMs: 10 * 60 * 1000,
  detailNavTimeoutMs: 90000,
  detailAfterNavWaitMs: 2000,
  profileAfterNavWaitMs: 2000,
  bloggerMaxDetectedItems: 50,
  bloggerMinLikes: 0,
  keywordMaxDetectedItems: 50,
  keywordMinLikes: 0,
  bloggerKeywordFilter: "",
};

function normalizePositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded > 0 ? rounded : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function normalizeText(value, fallback = "") {
  if (typeof value === "string") return value.trim();
  return String(fallback || "").trim();
}

function normalizeSyncScope(
  value,
  fallback = DEFAULT_CAPTURE_SETTINGS.syncScope,
) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "all" || normalized === "pending") {
    return normalized;
  }
  return fallback;
}

function normalizeDetailCaptureScope(
  value,
  fallback = DEFAULT_CAPTURE_SETTINGS.detailCaptureScope,
) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "all" || normalized === "pending") {
    return normalized;
  }
  return fallback;
}

function normalizeWaitRange(minMs, maxMs) {
  const min = normalizePositiveInteger(
    minMs,
    DEFAULT_CAPTURE_SETTINGS.sharedWaitMinMs,
  );
  const max = normalizePositiveInteger(
    maxMs,
    DEFAULT_CAPTURE_SETTINGS.sharedWaitMaxMs,
  );
  return min <= max ? {minMs: min, maxMs: max} : {minMs: max, maxMs: min};
}

export async function getCaptureSettings() {
  const raw = await chrome.storage.local.get([
    ...Object.values(CAPTURE_SETTINGS_KEYS),
    ...Object.values(LEGACY_CAPTURE_SETTINGS_KEYS),
  ]);

  const waitRange = normalizeWaitRange(
    raw[CAPTURE_SETTINGS_KEYS.SHARED_WAIT_MIN_MS] ??
      raw[LEGACY_CAPTURE_SETTINGS_KEYS.COMMENTS_WAIT_MIN_MS],
    raw[CAPTURE_SETTINGS_KEYS.SHARED_WAIT_MAX_MS] ??
      raw[LEGACY_CAPTURE_SETTINGS_KEYS.COMMENTS_WAIT_MAX_MS],
  );

  return {
    autoDetailCaptureAfterListCapture: normalizeBoolean(
      raw[CAPTURE_SETTINGS_KEYS.AUTO_DETAIL_CAPTURE_AFTER_LIST_CAPTURE],
      DEFAULT_CAPTURE_SETTINGS.autoDetailCaptureAfterListCapture,
    ),
    commentsMaxDetectedItems: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.COMMENTS_MAX_DETECTED_ITEMS] ??
        raw[LEGACY_CAPTURE_SETTINGS_KEYS.COMMENTS_MAX_ITEMS],
      DEFAULT_CAPTURE_SETTINGS.commentsMaxDetectedItems,
    ),
    detailCommentsMaxDetectedItems: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.DETAIL_COMMENTS_MAX_DETECTED_ITEMS],
      normalizePositiveInteger(
        raw[CAPTURE_SETTINGS_KEYS.COMMENTS_MAX_DETECTED_ITEMS] ??
          raw[LEGACY_CAPTURE_SETTINGS_KEYS.COMMENTS_MAX_ITEMS],
        DEFAULT_CAPTURE_SETTINGS.detailCommentsMaxDetectedItems,
      ),
    ),
    includeCommentsOnNoteCapture: normalizeBoolean(
      raw[CAPTURE_SETTINGS_KEYS.INCLUDE_COMMENTS_ON_NOTE_CAPTURE],
      DEFAULT_CAPTURE_SETTINGS.includeCommentsOnNoteCapture,
    ),
    includeCommentsOnDetailCapture: normalizeBoolean(
      raw[CAPTURE_SETTINGS_KEYS.INCLUDE_COMMENTS_ON_DETAIL_CAPTURE],
      normalizeBoolean(
        raw[CAPTURE_SETTINGS_KEYS.INCLUDE_COMMENTS_ON_NOTE_CAPTURE],
        DEFAULT_CAPTURE_SETTINGS.includeCommentsOnDetailCapture,
      ),
    ),
    enableCommentLeadsFilter: normalizeBoolean(
      raw[CAPTURE_SETTINGS_KEYS.ENABLE_COMMENT_LEADS_FILTER],
      DEFAULT_CAPTURE_SETTINGS.enableCommentLeadsFilter,
    ),
    enableCommentLeadsFilterOnDetailCapture: normalizeBoolean(
      raw[CAPTURE_SETTINGS_KEYS.ENABLE_COMMENT_LEADS_FILTER_ON_DETAIL_CAPTURE],
      normalizeBoolean(
        raw[CAPTURE_SETTINGS_KEYS.ENABLE_COMMENT_LEADS_FILTER],
        DEFAULT_CAPTURE_SETTINGS.enableCommentLeadsFilterOnDetailCapture,
      ),
    ),
    commentLeadsKeywords: normalizeText(
      raw[CAPTURE_SETTINGS_KEYS.COMMENT_LEADS_KEYWORDS],
      DEFAULT_CAPTURE_SETTINGS.commentLeadsKeywords,
    ),
    commentLeadsIps: normalizeText(
      raw[CAPTURE_SETTINGS_KEYS.COMMENT_LEADS_IPS],
      DEFAULT_CAPTURE_SETTINGS.commentLeadsIps,
    ),
    includeBloggerMetricsOnNoteCapture: normalizeBoolean(
      raw[CAPTURE_SETTINGS_KEYS.INCLUDE_BLOGGER_METRICS_ON_NOTE_CAPTURE],
      DEFAULT_CAPTURE_SETTINGS.includeBloggerMetricsOnNoteCapture,
    ),
    includeBloggerMetricsOnDetailCapture: normalizeBoolean(
      raw[CAPTURE_SETTINGS_KEYS.INCLUDE_BLOGGER_METRICS_ON_DETAIL_CAPTURE],
      normalizeBoolean(
        raw[CAPTURE_SETTINGS_KEYS.INCLUDE_BLOGGER_METRICS_ON_NOTE_CAPTURE],
        DEFAULT_CAPTURE_SETTINGS.includeBloggerMetricsOnDetailCapture,
      ),
    ),
    enableLowFollowerHitFilter: normalizeBoolean(
      raw[CAPTURE_SETTINGS_KEYS.ENABLE_LOW_FOLLOWER_HIT_FILTER],
      DEFAULT_CAPTURE_SETTINGS.enableLowFollowerHitFilter,
    ),
    enableLowFollowerHitFilterOnDetailCapture: normalizeBoolean(
      raw[
        CAPTURE_SETTINGS_KEYS.ENABLE_LOW_FOLLOWER_HIT_FILTER_ON_DETAIL_CAPTURE
      ],
      normalizeBoolean(
        raw[CAPTURE_SETTINGS_KEYS.ENABLE_LOW_FOLLOWER_HIT_FILTER],
        DEFAULT_CAPTURE_SETTINGS.enableLowFollowerHitFilterOnDetailCapture,
      ),
    ),
    lowFollowerHitThreshold: normalizeNonNegativeInteger(
      raw[CAPTURE_SETTINGS_KEYS.LOW_FOLLOWER_HIT_THRESHOLD],
      DEFAULT_CAPTURE_SETTINGS.lowFollowerHitThreshold,
    ),
    lowFollowerHitThresholdOnDetailCapture: normalizeNonNegativeInteger(
      raw[CAPTURE_SETTINGS_KEYS.LOW_FOLLOWER_HIT_THRESHOLD_ON_DETAIL_CAPTURE],
      normalizeNonNegativeInteger(
        raw[CAPTURE_SETTINGS_KEYS.LOW_FOLLOWER_HIT_THRESHOLD],
        DEFAULT_CAPTURE_SETTINGS.lowFollowerHitThresholdOnDetailCapture,
      ),
    ),
    syncScope: normalizeSyncScope(
      raw[CAPTURE_SETTINGS_KEYS.SYNC_SCOPE],
      DEFAULT_CAPTURE_SETTINGS.syncScope,
    ),
    detailCaptureScope: normalizeDetailCaptureScope(
      raw[CAPTURE_SETTINGS_KEYS.DETAIL_CAPTURE_SCOPE],
      DEFAULT_CAPTURE_SETTINGS.detailCaptureScope,
    ),
    sharedWaitMinMs: waitRange.minMs,
    sharedWaitMaxMs: waitRange.maxMs,
    sharedStallTimeoutMs: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.SHARED_STALL_TIMEOUT_MS] ??
        raw[LEGACY_CAPTURE_SETTINGS_KEYS.COMMENTS_STALL_TIMEOUT_MS],
      DEFAULT_CAPTURE_SETTINGS.sharedStallTimeoutMs,
    ),
    sharedMaxDurationMs: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.SHARED_MAX_DURATION_MS],
      DEFAULT_CAPTURE_SETTINGS.sharedMaxDurationMs,
    ),
    detailNavTimeoutMs: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.DETAIL_NAV_TIMEOUT_MS],
      DEFAULT_CAPTURE_SETTINGS.detailNavTimeoutMs,
    ),
    detailAfterNavWaitMs: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.DETAIL_AFTER_NAV_WAIT_MS],
      DEFAULT_CAPTURE_SETTINGS.detailAfterNavWaitMs,
    ),
    profileAfterNavWaitMs: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.PROFILE_AFTER_NAV_WAIT_MS],
      DEFAULT_CAPTURE_SETTINGS.profileAfterNavWaitMs,
    ),
    bloggerMaxDetectedItems: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.BLOGGER_MAX_DETECTED_ITEMS] ??
        raw[LEGACY_CAPTURE_SETTINGS_KEYS.BLOGGER_MAX_ITEMS],
      DEFAULT_CAPTURE_SETTINGS.bloggerMaxDetectedItems,
    ),
    bloggerMinLikes: normalizeNonNegativeInteger(
      raw[CAPTURE_SETTINGS_KEYS.BLOGGER_MIN_LIKES],
      DEFAULT_CAPTURE_SETTINGS.bloggerMinLikes,
    ),
    keywordMaxDetectedItems: normalizePositiveInteger(
      raw[CAPTURE_SETTINGS_KEYS.KEYWORD_MAX_DETECTED_ITEMS] ??
        raw[LEGACY_CAPTURE_SETTINGS_KEYS.KEYWORD_MAX_ITEMS],
      DEFAULT_CAPTURE_SETTINGS.keywordMaxDetectedItems,
    ),
    keywordMinLikes: normalizeNonNegativeInteger(
      raw[CAPTURE_SETTINGS_KEYS.KEYWORD_MIN_LIKES],
      DEFAULT_CAPTURE_SETTINGS.keywordMinLikes,
    ),
    bloggerKeywordFilter: normalizeText(
      raw[CAPTURE_SETTINGS_KEYS.BLOGGER_KEYWORD_FILTER],
      DEFAULT_CAPTURE_SETTINGS.bloggerKeywordFilter,
    ),
  };
}

export async function saveCaptureSettings(updates = {}) {
  const normalizedUpdates = {
    ...updates,
  };
  if (
    normalizedUpdates.commentsMaxDetectedItems == null &&
    normalizedUpdates.commentsMaxItems != null
  ) {
    normalizedUpdates.commentsMaxDetectedItems =
      normalizedUpdates.commentsMaxItems;
  }
  if (
    normalizedUpdates.bloggerMaxDetectedItems == null &&
    normalizedUpdates.bloggerMaxItems != null
  ) {
    normalizedUpdates.bloggerMaxDetectedItems =
      normalizedUpdates.bloggerMaxItems;
  }
  if (
    normalizedUpdates.keywordMaxDetectedItems == null &&
    normalizedUpdates.keywordMaxItems != null
  ) {
    normalizedUpdates.keywordMaxDetectedItems =
      normalizedUpdates.keywordMaxItems;
  }

  const current = await getCaptureSettings();
  const next = {
    ...current,
    ...normalizedUpdates,
  };
  const waitRange = normalizeWaitRange(
    next.sharedWaitMinMs,
    next.sharedWaitMaxMs,
  );

  await chrome.storage.local.set({
    [CAPTURE_SETTINGS_KEYS.AUTO_DETAIL_CAPTURE_AFTER_LIST_CAPTURE]:
      normalizeBoolean(
        next.autoDetailCaptureAfterListCapture,
        DEFAULT_CAPTURE_SETTINGS.autoDetailCaptureAfterListCapture,
      ),
    [CAPTURE_SETTINGS_KEYS.COMMENTS_MAX_DETECTED_ITEMS]:
      normalizePositiveInteger(
        next.commentsMaxDetectedItems,
        DEFAULT_CAPTURE_SETTINGS.commentsMaxDetectedItems,
      ),
    [CAPTURE_SETTINGS_KEYS.DETAIL_COMMENTS_MAX_DETECTED_ITEMS]:
      normalizePositiveInteger(
        next.detailCommentsMaxDetectedItems,
        DEFAULT_CAPTURE_SETTINGS.detailCommentsMaxDetectedItems,
      ),
    [CAPTURE_SETTINGS_KEYS.INCLUDE_COMMENTS_ON_NOTE_CAPTURE]: normalizeBoolean(
      next.includeCommentsOnNoteCapture,
      DEFAULT_CAPTURE_SETTINGS.includeCommentsOnNoteCapture,
    ),
    [CAPTURE_SETTINGS_KEYS.INCLUDE_COMMENTS_ON_DETAIL_CAPTURE]:
      normalizeBoolean(
        next.includeCommentsOnDetailCapture,
        DEFAULT_CAPTURE_SETTINGS.includeCommentsOnDetailCapture,
      ),
    [CAPTURE_SETTINGS_KEYS.ENABLE_COMMENT_LEADS_FILTER]: normalizeBoolean(
      next.enableCommentLeadsFilter,
      DEFAULT_CAPTURE_SETTINGS.enableCommentLeadsFilter,
    ),
    [CAPTURE_SETTINGS_KEYS.ENABLE_COMMENT_LEADS_FILTER_ON_DETAIL_CAPTURE]:
      normalizeBoolean(
        next.enableCommentLeadsFilterOnDetailCapture,
        DEFAULT_CAPTURE_SETTINGS.enableCommentLeadsFilterOnDetailCapture,
      ),
    [CAPTURE_SETTINGS_KEYS.COMMENT_LEADS_KEYWORDS]: normalizeText(
      next.commentLeadsKeywords,
      DEFAULT_CAPTURE_SETTINGS.commentLeadsKeywords,
    ),
    [CAPTURE_SETTINGS_KEYS.COMMENT_LEADS_IPS]: normalizeText(
      next.commentLeadsIps,
      DEFAULT_CAPTURE_SETTINGS.commentLeadsIps,
    ),
    [CAPTURE_SETTINGS_KEYS.INCLUDE_BLOGGER_METRICS_ON_NOTE_CAPTURE]:
      normalizeBoolean(
        next.includeBloggerMetricsOnNoteCapture,
        DEFAULT_CAPTURE_SETTINGS.includeBloggerMetricsOnNoteCapture,
      ),
    [CAPTURE_SETTINGS_KEYS.INCLUDE_BLOGGER_METRICS_ON_DETAIL_CAPTURE]:
      normalizeBoolean(
        next.includeBloggerMetricsOnDetailCapture,
        DEFAULT_CAPTURE_SETTINGS.includeBloggerMetricsOnDetailCapture,
      ),
    [CAPTURE_SETTINGS_KEYS.ENABLE_LOW_FOLLOWER_HIT_FILTER]: normalizeBoolean(
      next.enableLowFollowerHitFilter,
      DEFAULT_CAPTURE_SETTINGS.enableLowFollowerHitFilter,
    ),
    [CAPTURE_SETTINGS_KEYS.ENABLE_LOW_FOLLOWER_HIT_FILTER_ON_DETAIL_CAPTURE]:
      normalizeBoolean(
        next.enableLowFollowerHitFilterOnDetailCapture,
        DEFAULT_CAPTURE_SETTINGS.enableLowFollowerHitFilterOnDetailCapture,
      ),
    [CAPTURE_SETTINGS_KEYS.LOW_FOLLOWER_HIT_THRESHOLD]:
      normalizeNonNegativeInteger(
        next.lowFollowerHitThreshold,
        DEFAULT_CAPTURE_SETTINGS.lowFollowerHitThreshold,
      ),
    [CAPTURE_SETTINGS_KEYS.LOW_FOLLOWER_HIT_THRESHOLD_ON_DETAIL_CAPTURE]:
      normalizeNonNegativeInteger(
        next.lowFollowerHitThresholdOnDetailCapture,
        DEFAULT_CAPTURE_SETTINGS.lowFollowerHitThresholdOnDetailCapture,
      ),
    [CAPTURE_SETTINGS_KEYS.SYNC_SCOPE]: normalizeSyncScope(
      next.syncScope,
      DEFAULT_CAPTURE_SETTINGS.syncScope,
    ),
    [CAPTURE_SETTINGS_KEYS.DETAIL_CAPTURE_SCOPE]: normalizeDetailCaptureScope(
      next.detailCaptureScope,
      DEFAULT_CAPTURE_SETTINGS.detailCaptureScope,
    ),
    [CAPTURE_SETTINGS_KEYS.SHARED_WAIT_MIN_MS]: waitRange.minMs,
    [CAPTURE_SETTINGS_KEYS.SHARED_WAIT_MAX_MS]: waitRange.maxMs,
    [CAPTURE_SETTINGS_KEYS.SHARED_STALL_TIMEOUT_MS]: normalizePositiveInteger(
      next.sharedStallTimeoutMs,
      DEFAULT_CAPTURE_SETTINGS.sharedStallTimeoutMs,
    ),
    [CAPTURE_SETTINGS_KEYS.SHARED_MAX_DURATION_MS]: normalizePositiveInteger(
      next.sharedMaxDurationMs,
      DEFAULT_CAPTURE_SETTINGS.sharedMaxDurationMs,
    ),
    [CAPTURE_SETTINGS_KEYS.DETAIL_NAV_TIMEOUT_MS]: normalizePositiveInteger(
      next.detailNavTimeoutMs,
      DEFAULT_CAPTURE_SETTINGS.detailNavTimeoutMs,
    ),
    [CAPTURE_SETTINGS_KEYS.DETAIL_AFTER_NAV_WAIT_MS]: normalizePositiveInteger(
      next.detailAfterNavWaitMs,
      DEFAULT_CAPTURE_SETTINGS.detailAfterNavWaitMs,
    ),
    [CAPTURE_SETTINGS_KEYS.PROFILE_AFTER_NAV_WAIT_MS]: normalizePositiveInteger(
      next.profileAfterNavWaitMs,
      DEFAULT_CAPTURE_SETTINGS.profileAfterNavWaitMs,
    ),
    [CAPTURE_SETTINGS_KEYS.BLOGGER_MAX_DETECTED_ITEMS]:
      normalizePositiveInteger(
        next.bloggerMaxDetectedItems,
        DEFAULT_CAPTURE_SETTINGS.bloggerMaxDetectedItems,
      ),
    [CAPTURE_SETTINGS_KEYS.BLOGGER_MIN_LIKES]: normalizeNonNegativeInteger(
      next.bloggerMinLikes,
      DEFAULT_CAPTURE_SETTINGS.bloggerMinLikes,
    ),
    [CAPTURE_SETTINGS_KEYS.KEYWORD_MAX_DETECTED_ITEMS]:
      normalizePositiveInteger(
        next.keywordMaxDetectedItems,
        DEFAULT_CAPTURE_SETTINGS.keywordMaxDetectedItems,
      ),
    [CAPTURE_SETTINGS_KEYS.KEYWORD_MIN_LIKES]: normalizeNonNegativeInteger(
      next.keywordMinLikes,
      DEFAULT_CAPTURE_SETTINGS.keywordMinLikes,
    ),
    [CAPTURE_SETTINGS_KEYS.BLOGGER_KEYWORD_FILTER]: normalizeText(
      next.bloggerKeywordFilter,
      DEFAULT_CAPTURE_SETTINGS.bloggerKeywordFilter,
    ),
  });

  return await getCaptureSettings();
}

function normalizeNonNegativeInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded >= 0 ? rounded : fallback;
}
