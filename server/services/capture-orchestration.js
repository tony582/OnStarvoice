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

/**
 * Normalize the first orchestration release's deliberately small contract.
 *
 * The first slice accepts only immediate keyword capture and deterministic
 * balanced allocation. It does not normalize "AI assignment" or a live handoff
 * into something that the backend cannot yet execute.
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
  const readFilter = name => text(
    Object.prototype.hasOwnProperty.call(source, name)
      ? source[name]
      : rawFilters[name],
    80,
  ).toLowerCase();
  const hasCaptureSettings = Boolean(
    source.captureSettings &&
    typeof source.captureSettings === 'object' &&
    !Array.isArray(source.captureSettings),
  );

  return {
    requestKey: text(
      source.requestKey ||
      source.request_key ||
      source.clientTaskId ||
      source.client_task_id,
      240,
    ),
    title: text(source.title || '关键词采集任务', 240),
    platform: normalizePlatform(source.platform),
    // Immediate, disjoint child create commands are the only implemented
    // execution contract in this slice.
    executionMode: 'one_time',
    allocationMode: 'balanced',
    keywords,
    agentIds,
    taskInput: {
      searchFilters: {
        sort: readFilter('sort'),
        publishTime: readFilter('publishTime'),
        contentType: readFilter('contentType'),
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
      // The first orchestration slice settles one work item per keyword. Keep
      // it to a single round so a parent cannot appear complete between local
      // rounds before the server has a round-aware item identity.
      maxRounds: 1,
      roundGapMin: 10,
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
  return (
    source.securityBlocked === true ||
    source.security_blocked === true ||
    source.platformSafetyBlocked === true ||
    source.platform_safety_blocked === true ||
    [
      'PLATFORM_SAFETY_BLOCK',
      'SECURITY_VERIFICATION_REQUIRED',
      'DOUYIN_SEARCH_SERVICE_ABNORMAL',
    ].includes(errorCode)
  );
}

/**
 * Project one extension keyword checkpoint entry onto a server item status.
 * Protective-stop handling only trusts explicit structured evidence;
 * error-message text is never classified as a platform restriction. Douyin's
 * service-abnormal state is kept as its own reason instead of being relabeled
 * as a confirmed CAPTCHA or account restriction.
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
