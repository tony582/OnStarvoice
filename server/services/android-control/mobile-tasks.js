// Shared, dependency-free mapping from an orchestration plan snapshot to the
// mobile Runner's task shape. Used by the poll claim (elastic + assigned), the
// scheduler's fixed-batch materialization and the manual fixed-batch dispatch,
// so the three paths cannot drift. Everything here is a pure function of its
// inputs; it never touches the database.

export const MOBILE_WORKFLOW = 'douyin_mobile_discovery';
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

export function mobileTaskFilters(searchFilters = {}) {
  const source = searchFilters && typeof searchFilters === 'object' && !Array.isArray(searchFilters)
    ? searchFilters
    : {};
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

// A phone can only take a plain single-pass douyin keyword search. Multi-pass
// sequential searches, negative patrols and the `month` publication window stay
// browser-only. Returns a reason string when the plan is not phone-eligible.
export function mobilePlanBlockReason(planSnapshot = {}, platform = 'douyin') {
  const source = planSnapshot && typeof planSnapshot === 'object' && !Array.isArray(planSnapshot)
    ? planSnapshot
    : {};
  if (String(platform || '').toLowerCase() !== 'douyin') return 'platform_not_douyin';
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
