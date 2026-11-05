// Shared, dependency-free mapping from an orchestration plan snapshot to the
// mobile Runner's task shape. Used by the poll claim (elastic + assigned), the
// scheduler's fixed-batch materialization and the manual fixed-batch dispatch,
// so the three paths cannot drift. Everything here is a pure function of its
// inputs; it never touches the database.

export const MOBILE_WORKFLOW = 'douyin_mobile_discovery';
// WeChat Channels on the same phone (0.4.0): the phone captures the whole post itself and uploads it.
export const WECHAT_MOBILE_WORKFLOW = 'wechat_channels_mobile_capture';
export const MOBILE_WORKFLOWS = Object.freeze([MOBILE_WORKFLOW, WECHAT_MOBILE_WORKFLOW]);
export const MOBILE_PLATFORMS = Object.freeze(['douyin', 'wechat_channels']);
export function mobileWorkflowFor(platform) {
  return String(platform || '').toLowerCase() === 'wechat_channels' ? WECHAT_MOBILE_WORKFLOW : MOBILE_WORKFLOW;
}
export function mobilePlatformForWorkflow(workflow) {
  return workflow === WECHAT_MOBILE_WORKFLOW ? 'wechat_channels' : 'douyin';
}
export const MOBILE_KEYWORD_MINUTES_DEFAULT = 15;
export const MOBILE_BATCH_TAIL_MS = 5 * 60_000;

const SORT_VALUES = new Set(['comprehensive', 'latest', 'likes', 'comments', 'collects']);
// The phone only supports the four calibrated publication windows. `month` is a
// browser-only filter; a plan that requests it is fenced off from phones before
// a child task is ever built, so it can never reach this mapping.
const PUBLISH_VALUES = new Set(['all', 'day', 'week', 'halfyear']);
const CONTENT_VALUES = new Set(['all', 'image', 'video']);

export function mobileKeywordMinutes(planSnapshot = {}) {
  const raw = Number(planSnapshot?.mobileKeywordMaxMinutes);
  if (!Number.isFinite(raw)) return MOBILE_KEYWORD_MINUTES_DEFAULT;
  return Math.min(120, Math.max(1, Math.round(raw)));
}

export function mobileKeywordMs(planSnapshot = {}) {
  return mobileKeywordMinutes(planSnapshot) * 60_000;
}

// Channels has no publication filter in the App: the phone sorts newest first and stops at the window itself.
const WECHAT_WINDOW_HOURS = Object.freeze({all: null, day: 24, week: 168, month: 720, halfyear: 4320});
const WECHAT_SORTS = Object.freeze({comprehensive: 'all', latest: 'latest', likes: 'hot'});

export function mobileTaskFilters(searchFilters = {}, platform = 'douyin') {
  const source = searchFilters && typeof searchFilters === 'object' && !Array.isArray(searchFilters)
    ? searchFilters
    : {};
  if (String(platform).toLowerCase() === 'wechat_channels') {
    const windowHours = Object.hasOwn(WECHAT_WINDOW_HOURS, source.publishTime) ? WECHAT_WINDOW_HOURS[source.publishTime] : null;
    return {sort: windowHours === null ? (WECHAT_SORTS[source.sort] ?? 'all') : 'latest', publishWindowHours: windowHours};
  }
  return {
    sort: SORT_VALUES.has(source.sort) ? source.sort : 'comprehensive',
    publishTime: PUBLISH_VALUES.has(source.publishTime) ? source.publishTime : 'all',
    contentType: CONTENT_VALUES.has(source.contentType) ? source.contentType : 'all',
  };
}

export function mobileTaskBudgets(planSnapshot = {}, keywordCount = 1) {
  const keywordMs = mobileKeywordMs(planSnapshot);
  const rawMax = Number(planSnapshot?.keywordMaxDetectedItems);
  // 0 = unlimited; the Runner ends on "results exhausted / no new cards" and
  // the per-keyword time fence. A configured post limit becomes maxLinks.
  const maxLinks = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : 0;
  const words = Math.max(1, Number(keywordCount) || 1);
  return {
    maxLinks,
    maxCards: 0,
    maxSwipes: 0,
    keywordMs,
    batchMs: keywordMs * words + MOBILE_BATCH_TAIL_MS,
    maxPending: 100,
  };
}

// The plan snapshot stored on the child task is trimmed to the keywords that
// child actually owns; everything else the mapping already consumed (filters,
// budgets) is captured on the task metadata itself.
export function trimMobilePlanSnapshot(planSnapshot = {}, keywords = []) {
  const source = planSnapshot && typeof planSnapshot === 'object' && !Array.isArray(planSnapshot)
    ? planSnapshot
    : {};
  const trimmed = JSON.parse(JSON.stringify(source));
  trimmed.keywords = [...keywords];
  return trimmed;
}

// The phone asks the AI prefilter about result cards only when the plan turned on
// the same switch the browser honours for "AI 精准筛选": detail capture after the
// list and AI relevance screening, both strictly true. A run without a plan
// snapshot (standalone pilot runs) opens every card as before.
export function mobileRelevancePrefilterEnabled(planSnapshot) {
  const settings = planSnapshot && typeof planSnapshot === 'object' ? planSnapshot.captureSettings : null;
  return Boolean(settings && typeof settings === 'object'
    && settings.autoDetailCaptureAfterListCapture === true
    && settings.enableAiRelevancePrefilter === true);
}

// A phone can only take a plain single-pass douyin keyword search. Multi-pass
// sequential searches, negative patrols and the `month` publication window stay
// browser-only. Returns a reason string when the plan is not phone-eligible.
// Comments the phone reads per Channels post: the plan's detail-comment switch and limit (default 50).
export function mobileCommentPlan(planSnapshot = {}) {
  const settings = planSnapshot && typeof planSnapshot === 'object' ? planSnapshot.captureSettings : null;
  const enabled = Boolean(settings && settings.includeCommentsOnDetailCapture === true);
  const raw = Number(settings?.detailCommentsMaxDetectedItems);
  return {enabled, limit: enabled ? Math.min(500, Math.max(1, Number.isInteger(raw) && raw > 0 ? raw : 50)) : 0};
}

export function mobilePlanBlockReason(planSnapshot = {}, platform = 'douyin') {
  const source = planSnapshot && typeof planSnapshot === 'object' && !Array.isArray(planSnapshot)
    ? planSnapshot
    : {};
  const normalized = String(platform || '').toLowerCase();
  if (normalized === 'wechat_channels') {
    // Channels: one search pass; the month window works (the phone filters by the card time itself).
    if (Array.isArray(source.searchPasses) && source.searchPasses.length > 1) return 'sequential_search_unsupported';
    return '';
  }
  if (normalized !== 'douyin') return 'platform_not_douyin';
  if (Array.isArray(source.searchPasses) && source.searchPasses.length > 1) {
    return 'sequential_search_unsupported';
  }
  const negativePatrol = source.negativePatrol && typeof source.negativePatrol === 'object'
    ? source.negativePatrol
    : {};
  if (negativePatrol.enabled === true) return 'negative_patrol_unsupported';
  const searchFilters = source.searchFilters && typeof source.searchFilters === 'object'
    ? source.searchFilters
    : {};
  if (searchFilters.publishTime === 'month') return 'publish_time_month_unsupported';
  return '';
}
