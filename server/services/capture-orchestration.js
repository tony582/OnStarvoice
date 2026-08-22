import crypto from 'node:crypto';

const PLATFORM_ALIASES = Object.freeze({
  xhs: 'xiaohongshu',
  red: 'xiaohongshu',
  xiaohongshu: 'xiaohongshu',
  douyin: 'douyin',
  tiktok_cn: 'douyin',
});

const ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'running',
  'retryable',
  'needs_action',
  'completed',
  'completed_with_warnings',
  'failed',
  'skipped',
  'canceled',
]);

const TERMINAL_ITEM_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'skipped',
  'canceled',
]);

const HASH_IGNORED_KEYS = new Set([
  'requestKey',
  'request_key',
  'requestId',
  'request_id',
  'clientTaskId',
  'client_task_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, limit = 500) {
  const normalized = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function boolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

const SEARCH_FILTER_VALUES = Object.freeze({
  sort: new Set(['comprehensive', 'latest', 'likes', 'comments', 'collects']),
  publishTime: new Set(['all', 'day', 'week', 'month', 'halfyear']),
  contentType: new Set(['all', 'image', 'video']),
  searchScope: new Set(['all', 'followed', 'viewed', 'unviewed']),
  distance: new Set(['all', 'city', 'nearby']),
  videoDuration: new Set(['all', 'under_1m', '1_5m', 'over_5m']),
});

const SEARCH_FILTER_DEFAULTS = Object.freeze({
  sort: 'comprehensive',
  publishTime: 'all',
  contentType: 'all',
  searchScope: 'all',
  distance: 'all',
  videoDuration: 'all',
});

function normalizeSingleSearchFilter(name, value) {
  // Search filters other than the explicitly modeled patrol path are mutually
  // exclusive. If an API caller sends an array, keep only its first valid
  // choice rather than creating an unsupported cross-product of searches.
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    const normalized = text(candidate, 80).toLowerCase();
    if (SEARCH_FILTER_VALUES[name]?.has(normalized)) return normalized;
  }
  return SEARCH_FILTER_DEFAULTS[name] || '';
}

function normalizeSequentialSearchPasses(value, fallbackContentType = 'all') {
  const allowed = new Set(['all', 'image', 'video']);
  const fallback = allowed.has(fallbackContentType) ? fallbackContentType : 'all';
  const requested = normalizeStringList(value, {
    limit: 3,
    itemLimit: 20,
    map: item => text(item, 20).toLowerCase(),
  }).filter(item => allowed.has(item));
  if (requested.length === 0) return [fallback];
  if (requested.length === 1) return requested;

  // Only a comprehensive pass may have one focused supplement. Nested time
  // filters and arbitrary media combinations remain intentionally unsupported.
  if (requested.includes('all')) {
    const supplement = requested.find(item => item === 'image' || item === 'video');
    return supplement ? ['all', supplement] : ['all'];
  }
  return [requested[0]];
}

function normalizeStringList(value, {limit, itemLimit, map = item => item} = {}) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? '').split(/\r?\n/gu);
  const result = [];
  const seen = new Set();
  for (const rawValue of source) {
    const normalized = map(rawValue, itemLimit);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeAgentId(value) {
  return text(
    value && typeof value === 'object'
      ? value.id || value.agentId || value.agent_id
      : value,
    80,
  );
}

function normalizePlatform(value) {
  return PLATFORM_ALIASES[text(value, 40).toLowerCase()] || 'unknown';
}

function normalizeCaptureSettings(value) {
  const source = object(value);
  const enhancementEnabled = boolean(
    source.autoDetailCaptureAfterListCapture,
    false,
  );
  const includeBloggerMetrics = enhancementEnabled && boolean(
    source.includeBloggerMetricsOnDetailCapture,
    false,
  );
  const includeComments = enhancementEnabled && boolean(
    source.includeCommentsOnDetailCapture,
    false,
  );
  return {
    autoDetailCaptureAfterListCapture: enhancementEnabled,
    autoSyncAfterDetailCapture:
      enhancementEnabled && boolean(source.autoSyncAfterDetailCapture, false),
    enableAiRelevancePrefilter:
      enhancementEnabled && boolean(source.enableAiRelevancePrefilter, false),
    includeBloggerMetricsOnDetailCapture: includeBloggerMetrics,
    enableLowFollowerHitFilterOnDetailCapture:
      includeBloggerMetrics &&
      boolean(source.enableLowFollowerHitFilterOnDetailCapture, false),
    lowFollowerHitThresholdOnDetailCapture: integer(
      source.lowFollowerHitThresholdOnDetailCapture,
      10000,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    includeCommentsOnDetailCapture: includeComments,
    detailCommentsMaxDetectedItems: integer(
      source.detailCommentsMaxDetectedItems,
      50,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    enableCommentLeadsFilterOnDetailCapture:
      includeComments &&
      boolean(source.enableCommentLeadsFilterOnDetailCapture, false),
    skipAlreadyCapturedOnDetailCapture:
      enhancementEnabled &&
      boolean(source.skipAlreadyCapturedOnDetailCapture, true),
  };
}

function scheduleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeCalendarDate(value) {
  const match = String(value ?? '').trim().match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u,
  );
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return '';
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (day > daysInMonth) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeScheduleDateList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? '').slice(0, 20000).split(/[\s,，;；]+/gu);
  const dates = [];
  const invalidDates = [];
  const seen = new Set();
  for (const rawDate of source) {
    const candidate = String(rawDate ?? '').trim();
    if (!candidate) continue;
    const normalized = normalizeCalendarDate(candidate);
    if (!normalized) {
      invalidDates.push(candidate);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dates.push(normalized);
    if (dates.length >= 400) break;
  }
  dates.sort((left, right) => left.localeCompare(right));
  return {dates, invalidDates};
}

export function normalizeOrchestrationSchedule(input = {}) {
  const source = object(input);
  const rawMode = text(
    source.mode || source.scheduleMode || source.schedule_mode || 'daily',
    40,
  ).toLowerCase();
  const mode = rawMode === 'holidays'
    ? 'custom_dates'
    : rawMode;
  if (!['daily', 'custom_dates'].includes(mode)) {
    throw scheduleError(
      'invalid_schedule_mode',
      '无人值守运行规则必须是每天或指定日期',
    );
  }
  const startTime = text(
    source.startTime || source.start_time || '09:00',
    5,
  );
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(startTime)) {
    throw scheduleError(
      'invalid_schedule_start_time',
      '无人值守开始时间格式必须是 HH:mm',
    );
  }
  const randomOffsetMin = integer(
    source.randomOffsetMin ?? source.random_offset_min,
    0,
    0,
    240,
  );
  const requestedMaxRounds = integer(source.maxRounds, 1, 1, 100);
  if (requestedMaxRounds !== 1) {
    throw scheduleError(
      'multi_agent_schedule_single_round_only',
      '多 Agent 无人值守计划当前每个运行时间只支持执行 1 轮',
    );
  }
  const {dates, invalidDates} = normalizeScheduleDateList(
    source.customDates || source.custom_dates || source.holidayDates,
  );
  if (invalidDates.length > 0) {
    throw scheduleError(
      'invalid_schedule_dates',
      `存在无效运行日期：${invalidDates.slice(0, 3).join('、')}`,
    );
  }
  if (mode === 'custom_dates' && dates.length === 0) {
    throw scheduleError(
      'custom_dates_required',
      '指定日期计划至少需要一个有效日期',
    );
  }
  return {
    mode,
    timezone: 'Asia/Shanghai',
    startTime,
    randomOffsetMin,
    customDates: mode === 'custom_dates' ? dates.join('\n') : '',
    maxRounds: 1,
    roundGapMin: 10,
    overlapPolicy: 'skip',
    lateStartGraceMin: 360,
  };
}

function shanghaiDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    date: `${values.year}-${values.month}-${values.day}`,
  };
}

function addUtcCalendarDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function deterministicOffsetMinutes(seed, dateText, maximum) {
  if (maximum <= 0) return 0;
  const value = Number.parseInt(
    crypto.createHash('sha256').update(`${seed}:${dateText}`).digest('hex').slice(0, 8),
    16,
  );
  return value % (maximum + 1);
}

function shanghaiLocalTimestamp(dateText, startTime, offsetMinutes) {
  const [year, month, day] = dateText.split('-').map(Number);
  const [hour, minute] = startTime.split(':').map(Number);
  return Date.UTC(
    year,
    month - 1,
    day,
    hour - 8,
    minute + offsetMinutes,
  );
}

export function computeNextOrchestrationRunAt(
  scheduleInput = {},
  {
    after = new Date(),
    seed = 'capture-orchestration',
  } = {},
) {
  const schedule = normalizeOrchestrationSchedule(scheduleInput);
  const afterDate = after instanceof Date ? after : new Date(after);
  const afterMs = afterDate.getTime();
  if (!Number.isFinite(afterMs)) {
    throw scheduleError('invalid_schedule_cursor', '无法计算无人值守下一次运行时间');
  }
  const today = shanghaiDateParts(afterDate).date;
  const candidates = schedule.mode === 'custom_dates'
    ? schedule.customDates.split('\n').filter(date => date >= today)
    : Array.from({length: 370}, (_, index) => addUtcCalendarDays(today, index));
  for (const dateText of candidates) {
    const offsetMinutes = deterministicOffsetMinutes(
      seed,
      dateText,
      schedule.randomOffsetMin,
    );
    const candidateMs = shanghaiLocalTimestamp(
      dateText,
      schedule.startTime,
      offsetMinutes,
    );
    if (candidateMs > afterMs) return new Date(candidateMs).toISOString();
  }
  return '';
}

/**
 * Normalize the shared multi-Agent definition. A one-time definition becomes a
 * real run immediately. An unattended definition is a cloud schedule template;
 * each occurrence later materializes an ordinary one-time run so browser-local
 * plans are not overwritten.
 */
export function normalizeOrchestrationRequest(
  input = {},
  {
    maxKeywords = 300,
    maxAgents = 50,
  } = {},
) {
  const source = object(input);
  const keywords = normalizeStringList(source.keywords, {
    limit: integer(maxKeywords, 300, 1, 1000),
    itemLimit: 120,
    map: value => text(value, 120),
  });
  const agentIds = normalizeStringList(
    source.agentIds || source.agent_ids || source.agents,
    {
      limit: integer(maxAgents, 50, 1, 100),
      itemLimit: 80,
      map: normalizeAgentId,
    },
  );
  const rawFilters = object(source.searchFilters || source.search_filters);
  const readFilter = name => normalizeSingleSearchFilter(
    name,
    Object.prototype.hasOwnProperty.call(source, name)
      ? source[name]
      : rawFilters[name],
  );
  const hasCaptureSettings = Boolean(
    source.captureSettings &&
    typeof source.captureSettings === 'object' &&
    !Array.isArray(source.captureSettings),
  );
  const rawExecutionMode = text(
    source.executionMode || source.execution_mode || 'one_time',
    40,
  ).toLowerCase();
  const executionMode = [
    'unattended',
    'unattended_plan',
    'scheduled',
    'cloud_schedule',
  ].includes(rawExecutionMode)
    ? 'unattended_plan'
    : 'one_time';
  const schedule = executionMode === 'unattended_plan'
    ? normalizeOrchestrationSchedule(source.schedule || source)
    : null;
  const rawRecoveryPolicy = object(
    source.recoveryPolicy || source.recovery_policy,
  );
  const disableAutomaticSearchRetry = boolean(
    rawRecoveryPolicy.disableAutomaticSearchRetry ??
    rawRecoveryPolicy.disable_automatic_search_retry,
    false,
  );
  const requireVerifiedFilters = boolean(
    rawRecoveryPolicy.requireVerifiedFilters ??
    rawRecoveryPolicy.require_verified_filters,
    false,
  );
  const recoveryPolicy = {
    allowIdleAgentHandoff: boolean(
      rawRecoveryPolicy.allowIdleAgentHandoff ??
      rawRecoveryPolicy.allow_idle_agent_handoff,
      true,
    ),
    ...(disableAutomaticSearchRetry ? {disableAutomaticSearchRetry: true} : {}),
    ...(requireVerifiedFilters ? {requireVerifiedFilters: true} : {}),
    platformSafetyMode: 'manual_confirmed',
  };
  const rawDistributionMode = text(
    source.distributionMode || source.distribution_mode || 'fixed_batch',
    40,
  ).toLowerCase();
  const distributionMode = rawDistributionMode === 'elastic_pool'
    ? 'elastic_pool'
    : 'fixed_batch';
  const platform = normalizePlatform(source.platform);
  const baseContentType = readFilter('contentType');
  const searchPasses = normalizeSequentialSearchPasses(
    source.searchPasses ?? source.search_passes,
    baseContentType,
  );
  const sequentialSearchEnabled = Boolean(
    executionMode === 'unattended_plan' &&
    distributionMode === 'elastic_pool' &&
    platform === 'douyin' &&
    searchPasses.length > 1
  );
  const effectiveSearchPasses = sequentialSearchEnabled
    ? searchPasses
    : [baseContentType || 'all'];
  if (sequentialSearchEnabled) {
    recoveryPolicy.disableAutomaticSearchRetry = true;
    recoveryPolicy.requireVerifiedFilters = true;
  }

  return {
    requestKey: text(
      source.requestKey ||
      source.request_key ||
      source.clientTaskId ||
      source.client_task_id,
      240,
    ),
    title: text(source.title || '关键词采集任务', 240),
    platform,
    executionMode,
    allocationMode: 'balanced',
    distributionMode,
    keywords,
    agentIds,
    taskInput: {
      searchFilters: {
        sort: readFilter('sort'),
        publishTime: readFilter('publishTime'),
        contentType: effectiveSearchPasses[0],
        searchScope: readFilter('searchScope'),
        distance: readFilter('distance'),
        videoDuration: readFilter('videoDuration'),
      },
      keywordMaxDetectedItems: integer(
        source.keywordMaxDetectedItems,
        50,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      maxRounds: schedule?.maxRounds || 1,
      roundGapMin: schedule?.roundGapMin || 10,
      ...(sequentialSearchEnabled ? {searchPasses: effectiveSearchPasses} : {}),
      recoveryPolicy,
      ...(schedule ? schedule : {}),
      ...(hasCaptureSettings
        ? {captureSettings: normalizeCaptureSettings(source.captureSettings)}
        : {}),
    },
  };
}

function canonicalize(value, key = '') {
  if (HASH_IGNORED_KEYS.has(key) || typeof value === 'undefined') {
    return undefined;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalize(item)).filter(item => item !== undefined);
  }
  if (!value || typeof value !== 'object') return String(value);
  const result = {};
  for (const childKey of Object.keys(value).sort()) {
    const normalized = canonicalize(value[childKey], childKey);
    if (normalized !== undefined) result[childKey] = normalized;
  }
  return result;
}

/**
 * Stable logical-body hash for idempotency conflict detection. Request keys and
 * volatile timestamps are intentionally ignored, while keyword and Agent order
 * remain significant because they determine the initial allocation.
 */
export function hashOrchestrationRequest(request = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(request)))
    .digest('hex');
}

function itemKeyForKeyword(keyword, ordinal) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(keyword)
    .digest('hex')
    .slice(0, 12);
  return `keyword:${String(ordinal + 1).padStart(4, '0')}:${fingerprint}`;
}

/**
 * Allocate contiguous, disjoint keyword groups. Given the same normalized
 * keyword and Agent order, the result is byte-for-byte deterministic. Group
 * sizes differ by at most one and empty Agent groups are omitted, so callers do
 * not emit no-op create commands.
 */
export function allocateKeywordWorkItems({
  keywords: rawKeywords = [],
  agentIds: rawAgentIds = [],
  revision: rawRevision = 1,
} = {}) {
  const keywords = normalizeStringList(rawKeywords, {
    limit: 1000,
    itemLimit: 120,
    map: value => text(value, 120),
  });
  const agentIds = normalizeStringList(rawAgentIds, {
    limit: 100,
    itemLimit: 80,
    map: normalizeAgentId,
  });
  const revision = integer(
    rawRevision,
    1,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (keywords.length === 0 || agentIds.length === 0) {
    return {items: [], groups: []};
  }

  const baseSize = Math.floor(keywords.length / agentIds.length);
  const remainder = keywords.length % agentIds.length;
  const items = [];
  const groups = [];
  let cursor = 0;

  for (let agentIndex = 0; agentIndex < agentIds.length; agentIndex += 1) {
    const size = baseSize + (agentIndex < remainder ? 1 : 0);
    if (size === 0) continue;
    const agentId = agentIds[agentIndex];
    const groupItems = [];
    for (let offset = 0; offset < size; offset += 1) {
      const ordinal = cursor + offset;
      const keyword = keywords[ordinal];
      const item = {
        itemKey: itemKeyForKeyword(keyword, ordinal),
        itemType: 'keyword',
        ordinal,
        keyword,
        assignedAgentId: agentId,
        assignmentRevision: revision,
        status: 'assigned',
      };
      items.push(item);
      groupItems.push(item);
    }
    groups.push({
      agentId,
      assignmentRevision: revision,
      startOrdinal: groupItems[0].ordinal,
      endOrdinal: groupItems[groupItems.length - 1].ordinal,
      itemKeys: groupItems.map(item => item.itemKey),
      keywords: groupItems.map(item => item.keyword),
    });
    cursor += size;
  }

  return {items, groups};
}

function explicitSafetyBlock(entry) {
  const source = object(entry);
  const error = object(source.error);
  const errorCode = text(
    source.errorCode ||
    source.error_code ||
    error.code,
    100,
  ).toUpperCase();
  if (errorCode === 'DOUYIN_SEARCH_SERVICE_ABNORMAL') {
    return false;
  }
  return (
    source.securityBlocked === true ||
    source.security_blocked === true ||
    source.platformSafetyBlocked === true ||
    source.platform_safety_blocked === true ||
    source.requiresManualAction === true ||
    source.requires_manual_action === true ||
    error.requiresManualAction === true ||
    error.requires_manual_action === true ||
    [
      'PLATFORM_SAFETY_BLOCK',
      'SECURITY_VERIFICATION_REQUIRED',
    ].includes(errorCode)
  );
}

/**
 * Project one extension keyword checkpoint entry onto a server item status.
 * Protective-stop handling only trusts explicit structured evidence;
 * error-message text is never classified as a platform restriction. Douyin's
 * service-abnormal state is a retryable per-keyword search failure. Its exact
 * code also downgrades legacy Extension snapshots that carried old stop flags.
 */
export function checkpointEntryToItemStatus(
  entry = {},
  {maxAttempts = 2} = {},
) {
  const source = object(entry);
  const rawStatus = text(source.status, 80)
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
  if (explicitSafetyBlock(source)) return 'needs_action';

  const aliases = {
    success: 'completed',
    succeeded: 'completed',
    done: 'completed',
    complete: 'completed',
    warning: 'completed_with_warnings',
    partial_success: 'completed_with_warnings',
    cancelled: 'canceled',
    stopped: 'canceled',
    capturing: 'running',
    started: 'running',
    queued: 'pending',
  };
  const status = aliases[rawStatus] || rawStatus;
  if (['partial', 'retry', 'retrying', 'interrupted', 'recovering'].includes(status)) {
    return 'retryable';
  }
  if (['blocked', 'paused', 'security_blocked'].includes(status)) {
    return 'needs_action';
  }
  if (status === 'failed') {
    const attempts = integer(
      source.attemptCount ?? source.attempt_count,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const limit = integer(maxAttempts, 2, 1, Number.MAX_SAFE_INTEGER);
    return attempts < limit ? 'retryable' : 'failed';
  }
  if (ITEM_STATUSES.has(status)) return status;
  return 'pending';
}

function normalizeItemStatus(value) {
  const status = text(value, 80)
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
  return ITEM_STATUSES.has(status) ? status : 'pending';
}

/**
 * Derive a parent projection from its work items without mutating either side.
 * A parent stays `running` while any Agent is making progress, even when another
 * item needs attention. Once all items settle, failures produce a partial-
 * failure terminal state, an operator-stopped remainder produces `canceled`,
 * and skips/warnings produce a warning state.
 */
export function aggregateParentTaskItems(items = []) {
  const source = Array.isArray(items) ? items : [];
  const statuses = source.map(item => normalizeItemStatus(item?.status));
  const count = status => statuses.filter(itemStatus => itemStatus === status).length;
  const counts = {
    total: statuses.length,
    pending: count('pending'),
    assigned: count('assigned'),
    dispatchPending: count('dispatch_pending'),
    dispatched: count('dispatched'),
    waitingDevice: count('waiting_device'),
    running: count('running'),
    retryable: count('retryable'),
    needsAction: count('needs_action'),
    completed: count('completed'),
    completedWithWarnings: count('completed_with_warnings'),
    failed: count('failed'),
    skipped: count('skipped'),
    canceled: count('canceled'),
  };
  counts.settled = statuses.filter(status => TERMINAL_ITEM_STATUSES.has(status)).length;
  const terminal = counts.total > 0 && counts.settled === counts.total;

  let status = 'pending';
  if (terminal) {
    status = counts.failed > 0
      ? 'completed_with_failures'
      : counts.canceled > 0
        ? 'canceled'
        : counts.completedWithWarnings > 0 || counts.skipped > 0
        ? 'completed_with_warnings'
        : 'completed';
  } else if (counts.running > 0) {
    status = 'running';
  } else if (counts.needsAction > 0 || counts.retryable > 0) {
    status = 'needs_action';
  } else if (
    counts.assigned > 0 ||
    counts.dispatchPending > 0 ||
    counts.dispatched > 0 ||
    counts.waitingDevice > 0
  ) {
    status = 'pending';
  }

  const percent = counts.total === 0
    ? 0
    : Math.floor((counts.settled / counts.total) * 100);
  return {
    status,
    progress: {
      current: counts.settled,
      total: counts.total,
      percent,
    },
    counts,
    terminal,
  };
}
