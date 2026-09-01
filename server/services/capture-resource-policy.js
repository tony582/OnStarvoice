const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function positiveInteger(value, maximum = 100) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return 0;
  return Math.min(maximum, parsed);
}

function isPositiveIntegerWithin(value, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum;
}

function normalizeAgentIds(value, limit = 100) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map(item => String(item || '').trim().toLowerCase())
      .filter(item => UUID_PATTERN.test(item)),
  )).slice(0, limit);
}

function capacityGroup(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,79}$/u.test(normalized)
    ? normalized
    : '';
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

export function validateCaptureResourcePolicy(value = {}) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'object' && !Array.isArray(value))
  ) {
    const source = object(value);
    const supportedKeys = new Set([
      'maxActive',
      'max_active',
      'maxActivePerHost',
      'max_active_per_host',
      'maxActiveInGroup',
      'max_active_in_group',
      'maxDailySearchesPerAgent',
      'max_daily_searches_per_agent',
      'capacityGroup',
      'capacity_group',
      'relayAgentIds',
      'relay_agent_ids',
    ]);
    const unknownKey = Object.keys(source).find(key => !supportedKeys.has(key));
    if (unknownKey) {
      return {valid: false, reason: 'resource_policy_unknown_field'};
    }
    const numericFields = [
      ['maxActive', 'max_active', 50],
      ['maxActivePerHost', 'max_active_per_host', 50],
      ['maxActiveInGroup', 'max_active_in_group', 50],
      ['maxDailySearchesPerAgent', 'max_daily_searches_per_agent', 10000],
    ];
    for (const [camelKey, snakeKey, maximum] of numericFields) {
      const key = hasOwn(source, camelKey)
        ? camelKey
        : hasOwn(source, snakeKey)
          ? snakeKey
          : '';
      if (key && !isPositiveIntegerWithin(source[key], maximum)) {
        return {valid: false, reason: `${camelKey}_invalid`};
      }
    }
    const rawGroup = source.capacityGroup ?? source.capacity_group;
    const groupLimitProvided =
      hasOwn(source, 'maxActiveInGroup') ||
      hasOwn(source, 'max_active_in_group');
    const groupProvided =
      hasOwn(source, 'capacityGroup') ||
      hasOwn(source, 'capacity_group');
    if (groupLimitProvided !== groupProvided || (groupProvided && !capacityGroup(rawGroup))) {
      return {valid: false, reason: 'capacity_group_invalid'};
    }
    const rawRelayIds = source.relayAgentIds ?? source.relay_agent_ids;
    if (rawRelayIds !== undefined) {
      if (!Array.isArray(rawRelayIds) || rawRelayIds.length > 100) {
        return {valid: false, reason: 'relay_agent_ids_invalid'};
      }
      const normalized = normalizeAgentIds(rawRelayIds);
      if (normalized.length !== rawRelayIds.length) {
        return {valid: false, reason: 'relay_agent_ids_invalid'};
      }
    }
    return {valid: true, reason: ''};
  }
  return {valid: false, reason: 'resource_policy_invalid'};
}

/**
 * A deliberately small admission policy for scheduled capture queues.
 *
 * `maxActive` limits one schedule occurrence. Among policy-bearing elastic
 * plans, `maxActivePerHost` limits active captures sharing the Agent's
 * administrator-managed host label across platforms and schedules.
 * `capacityGroup`/`maxActiveInGroup` add one explicit shared resource such as
 * the SIM router used by two physical Windows hosts.
 * Daily search admission uses the server's persisted usage ledger; it is an
 * Agent-selection guard, not an independent counter of browser submissions.
 * `relayAgentIds` are standby nodes and may only receive a retryable item; they
 * never claim a fresh pending item.
 */
export function normalizeCaptureResourcePolicy(value = {}) {
  const source = object(value);
  const maxActive = positiveInteger(
    source.maxActive ?? source.max_active,
    50,
  );
  const maxActivePerHost = positiveInteger(
    source.maxActivePerHost ?? source.max_active_per_host,
    50,
  );
  const maxActiveInGroup = positiveInteger(
    source.maxActiveInGroup ?? source.max_active_in_group,
    50,
  );
  const normalizedCapacityGroup = capacityGroup(
    source.capacityGroup ?? source.capacity_group,
  );
  const maxDailySearchesPerAgent = positiveInteger(
    source.maxDailySearchesPerAgent ??
      source.max_daily_searches_per_agent,
    10000,
  );
  const relayAgentIds = normalizeAgentIds(
    source.relayAgentIds ?? source.relay_agent_ids,
  );

  return {
    ...(maxActive ? {maxActive} : {}),
    ...(maxActivePerHost ? {maxActivePerHost} : {}),
    ...(maxActiveInGroup
      ? {
          maxActiveInGroup,
          ...(normalizedCapacityGroup
            ? {capacityGroup: normalizedCapacityGroup}
            : {}),
        }
      : {}),
    ...(maxDailySearchesPerAgent ? {maxDailySearchesPerAgent} : {}),
    ...(relayAgentIds.length > 0 ? {relayAgentIds} : {}),
  };
}

export function captureResourceAgentIds({
  eligibleAgentIds = [],
  resourcePolicy = {},
} = {}) {
  return Array.from(new Set([
    ...normalizeAgentIds(eligibleAgentIds),
    ...normalizeAgentIds(object(resourcePolicy).relayAgentIds),
  ])).sort((left, right) => left.localeCompare(right));
}

export function projectCaptureResourceAdmission({
  resourcePolicy = {},
  hostLabel = '',
  planActive = 0,
  hostActive = 0,
  groupActive = 0,
  todaySearches = 0,
  expectedSearches = 1,
  dailySearchLimit = 0,
} = {}) {
  const policy = normalizeCaptureResourcePolicy(resourcePolicy);
  const parsedSearchCost = Number(expectedSearches);
  const searchCost = Number.isFinite(parsedSearchCost) && parsedSearchCost >= 0
    ? Math.floor(parsedSearchCost)
    : 1;
  const normalizedTodaySearches = Math.max(
    0,
    Number(todaySearches) || 0,
  );
  if (
    policy.maxActive &&
    Math.max(0, Number(planActive) || 0) >= policy.maxActive
  ) {
    return {allowed: false, reason: 'plan_capacity'};
  }
  if (policy.maxActivePerHost && !String(hostLabel || '').trim()) {
    return {allowed: false, reason: 'host_unknown'};
  }
  if (
    policy.maxActivePerHost &&
    Math.max(0, Number(hostActive) || 0) >= policy.maxActivePerHost
  ) {
    return {allowed: false, reason: 'host_capacity'};
  }
  if (policy.maxActiveInGroup && !policy.capacityGroup) {
    return {allowed: false, reason: 'capacity_group_unknown'};
  }
  if (
    policy.maxActiveInGroup &&
    Math.max(0, Number(groupActive) || 0) >= policy.maxActiveInGroup
  ) {
    return {allowed: false, reason: 'capacity_group_full'};
  }
  if (
    policy.maxDailySearchesPerAgent &&
    normalizedTodaySearches + searchCost >
      policy.maxDailySearchesPerAgent
  ) {
    return {allowed: false, reason: 'daily_search_capacity'};
  }
  const normalizedDailySearchLimit = Math.max(
    0,
    Math.floor(Number(dailySearchLimit) || 0),
  );
  if (
    normalizedDailySearchLimit > 0 &&
    normalizedTodaySearches + searchCost > normalizedDailySearchLimit
  ) {
    return {allowed: false, reason: 'account_daily_search_capacity'};
  }
  return {allowed: true, reason: ''};
}
