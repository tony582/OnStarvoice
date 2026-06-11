const STAGE_KEYS = Object.freeze({
  SCROLL_LOAD: "capture.scroll_load",
  LIST_PARSE: "capture.list_parse",
  FILTER_APPLY: "capture.filter_apply",
  COMMENT_LOAD: "capture.comment_load",
  DETAIL_ENHANCE: "capture.detail_enhance",
  BLOGGER_METRICS: "capture.blogger_metrics",
  LOW_FOLLOWER_FILTER: "capture.low_follower_filter",
  COMMENT_LEADS_FILTER: "capture.comment_leads_filter",
});

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  const number = finiteNumber(value, fallback);
  return number >= 0 ? number : fallback;
}

function cleanText(value, limit = 120) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) : text;
}

function compactMetrics(metrics = {}) {
  const result = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value === undefined) continue;
    if (typeof value === "number") {
      result[key] = Number.isFinite(value) ? value : null;
      continue;
    }
    if (typeof value === "boolean" || value === null) {
      result[key] = value;
      continue;
    }
    if (typeof value === "string") {
      result[key] = cleanText(value);
    }
  }
  return result;
}

function topReason(entries = []) {
  if (!Array.isArray(entries) || !entries.length) {
    return {reason: "", count: null};
  }
  const first = entries[0] || {};
  return {
    reason: cleanText(first.reason || "", 80),
    count: finiteNumber(first.count),
  };
}

function scrollTerminalReason(scrollResult = {}) {
  const stopReason = cleanText(scrollResult?.stopReason || "", 80);
  if (stopReason) return stopReason;
  if (scrollResult?.canceled) return "canceled";
  if (scrollResult?.completed) return "no_new";
  return "";
}

function stage(stageKey, label, metrics = {}, status = "completed") {
  return {
    stageKey,
    label,
    status,
    metrics: compactMetrics(metrics),
  };
}

export function buildScrollLoadStage({
  label = "滚动加载",
  status = "completed",
  requestedMaxDetectedItems = null,
  finalContentCount = null,
  scrollResult = {},
  maxScrollTimes = null,
  waitMinMs = null,
  waitMaxMs = null,
  stallTimeoutMs = null,
  maxDurationMs = null,
} = {}) {
  return stage(
    STAGE_KEYS.SCROLL_LOAD,
    label,
    {
      requestedMaxDetectedItems: finiteNumber(requestedMaxDetectedItems),
      finalContentCount:
        finiteNumber(finalContentCount) ??
        finiteNumber(scrollResult?.finalContentCount),
      scrollCount: finiteNumber(scrollResult?.scrollCount),
      maxScrollTimes:
        finiteNumber(maxScrollTimes) ?? finiteNumber(scrollResult?.maxScrollTimes),
      noNewContentCount: finiteNumber(scrollResult?.noNewContentCount),
      stopReason: cleanText(scrollResult?.stopReason || ""),
      terminalReason: scrollTerminalReason(scrollResult),
      reachedNoNewThreshold: Boolean(scrollResult?.completed),
      canceled: Boolean(scrollResult?.canceled),
      elapsedMs: finiteNumber(scrollResult?.elapsedMs),
      waitMinMs: finiteNumber(waitMinMs),
      waitMaxMs: finiteNumber(waitMaxMs),
      stallTimeoutMs: finiteNumber(stallTimeoutMs),
      maxDurationMs: finiteNumber(maxDurationMs),
    },
    status,
  );
}

export function buildListParseStage({
  label = "列表解析",
  rawTotalCount = null,
  parsedCount = null,
  duplicateRemovedCount = null,
  missingMetricCount = null,
} = {}) {
  return stage(STAGE_KEYS.LIST_PARSE, label, {
    rawTotalCount: finiteNumber(rawTotalCount),
    parsedCount: finiteNumber(parsedCount),
    duplicateRemovedCount: finiteNumber(duplicateRemovedCount),
    missingMetricCount: finiteNumber(missingMetricCount),
  });
}

export function buildFilterApplyStage({
  label = "筛选应用",
  rawTotalCount = null,
  filteredBeforeLimitCount = null,
  filteredCount = null,
  minLikes = null,
  sortDimension = "",
  keywordFilter = "",
  maxDetectedItems = null,
  missingMetricCount = null,
  minMetricCount = null,
  maxMetricCount = null,
  zeroMetricCount = null,
  metricExtractionSuspicious = false,
} = {}) {
  return stage(STAGE_KEYS.FILTER_APPLY, label, {
    rawTotalCount: finiteNumber(rawTotalCount),
    filteredBeforeLimitCount: finiteNumber(filteredBeforeLimitCount),
    filteredCount: finiteNumber(filteredCount),
    minLikes: finiteNumber(minLikes),
    sortDimension: cleanText(sortDimension, 80),
    keywordFilterEnabled: Boolean(cleanText(keywordFilter)),
    maxDetectedItems: finiteNumber(maxDetectedItems),
    missingMetricCount: finiteNumber(missingMetricCount),
    minMetricCount: finiteNumber(minMetricCount),
    maxMetricCount: finiteNumber(maxMetricCount),
    zeroMetricCount: finiteNumber(zeroMetricCount),
    metricExtractionSuspicious: Boolean(metricExtractionSuspicious),
  });
}

export function buildCommentLoadStage({
  label = "评论加载",
  status = "completed",
  commentsMaxDetectedItems = null,
  collectedCount = null,
  uniqueCount = null,
  commentContainerFound = null,
  scrollResult = {},
  maxScrollTimes = null,
  waitMinMs = null,
  waitMaxMs = null,
  stallTimeoutMs = null,
  maxDurationMs = null,
  scene = "",
  commentDiagnostics = null,
} = {}) {
  const rejectTop = topReason(commentDiagnostics?.rejectedReasonsTopN);
  const nodeRejectTop = topReason(commentDiagnostics?.rejectedNodeReasonsTopN);
  const contentRejectTop = topReason(
    commentDiagnostics?.rejectedContentReasonsTopN,
  );

  return stage(
    STAGE_KEYS.COMMENT_LOAD,
    label,
    {
      commentsMaxDetectedItems: finiteNumber(commentsMaxDetectedItems),
      collectedCount: finiteNumber(collectedCount),
      uniqueCount: finiteNumber(uniqueCount),
      commentContainerFound:
        typeof commentContainerFound === "boolean" ? commentContainerFound : null,
      scrollCount: finiteNumber(scrollResult?.scrollCount),
      maxScrollTimes:
        finiteNumber(maxScrollTimes) ?? finiteNumber(scrollResult?.maxScrollTimes),
      noNewContentCount: finiteNumber(scrollResult?.noNewContentCount),
      stopReason: cleanText(scrollResult?.stopReason || ""),
      terminalReason: scrollTerminalReason(scrollResult),
      reachedNoNewThreshold: Boolean(scrollResult?.completed),
      canceled: Boolean(scrollResult?.canceled),
      elapsedMs: finiteNumber(scrollResult?.elapsedMs),
      waitMinMs: finiteNumber(waitMinMs),
      waitMaxMs: finiteNumber(waitMaxMs),
      stallTimeoutMs: finiteNumber(stallTimeoutMs),
      maxDurationMs: finiteNumber(maxDurationMs),
      scene: cleanText(scene, 80),
      openStrategy: cleanText(commentDiagnostics?.openStrategy || "", 80),
      containerSource: cleanText(commentDiagnostics?.containerSource || "", 80),
      candidateCount: finiteNumber(commentDiagnostics?.candidateCount),
      candidateCountAfterFilter: finiteNumber(
        commentDiagnostics?.candidateCountAfterFilter,
      ),
      extractedCount: finiteNumber(commentDiagnostics?.extractedCount),
      acceptedCount: finiteNumber(commentDiagnostics?.acceptedCount),
      updatedCount: finiteNumber(commentDiagnostics?.updatedCount),
      rejectTopReason: rejectTop.reason,
      rejectTopCount: rejectTop.count,
      rejectNodeTopReason: nodeRejectTop.reason,
      rejectNodeTopCount: nodeRejectTop.count,
      rejectContentTopReason: contentRejectTop.reason,
      rejectContentTopCount: contentRejectTop.count,
    },
    status,
  );
}

export function buildDetailEnhanceStage({
  label = "采集增强",
  status = "completed",
  targetCount = null,
  processedCount = null,
  successCount = null,
  failedCount = null,
  filteredCount = null,
  currentStage = "",
  failureStageSummary = {},
} = {}) {
  const metrics = {
    targetCount: finiteNumber(targetCount),
    processedCount: finiteNumber(processedCount),
    successCount: nonNegativeNumber(successCount),
    failedCount: nonNegativeNumber(failedCount),
    filteredCount: nonNegativeNumber(filteredCount),
    currentStage: cleanText(currentStage, 80),
  };
  for (const [stageKey, count] of Object.entries(failureStageSummary || {})) {
    metrics[`failure_${cleanText(stageKey, 40)}`] = nonNegativeNumber(count);
  }
  return stage(STAGE_KEYS.DETAIL_ENHANCE, label, metrics, status);
}

export function buildBloggerMetricsStage({
  label = "账号指标补采",
  status = "completed",
  enabled = false,
  source = "",
  followersCount = null,
  likedAndCollectedCount = null,
  error = "",
} = {}) {
  return stage(STAGE_KEYS.BLOGGER_METRICS, label, {
    enabled: Boolean(enabled),
    source: cleanText(source, 80),
    followersCount: finiteNumber(followersCount),
    likedAndCollectedCount: finiteNumber(likedAndCollectedCount),
    error: cleanText(error, 160),
  }, status);
}

export function countMissingMetric(items = [], metricName = "likes") {
  if (!Array.isArray(items)) return 0;
  return items.filter((item) => {
    const value = item?.[metricName];
    return value === null || value === undefined || value === "";
  }).length;
}

export {STAGE_KEYS};
