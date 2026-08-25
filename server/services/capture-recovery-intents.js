import crypto from 'node:crypto';

import {
  getAllSettings,
  queryAll as dbQueryAll,
  queryOne as dbQueryOne,
  withTransaction as dbWithTransaction,
} from '../db/init.js';
import {
  CAPTURE_PLATFORM_SAFETY_CODES,
  normalizeCaptureHealthDetailReadyReason,
  normalizeCaptureHealthEndpointClass,
  normalizeCaptureHealthNetworkStatus,
  normalizeCaptureHealthPageType,
  normalizeCaptureHealthPlatform,
  normalizeCaptureRecoveryErrorCode,
  normalizeCaptureHealthStage,
  normalizeCaptureHealthTabStatus,
} from './capture-health-schema.js';

export const CAPTURE_RECOVERY_SETTING_KEYS = Object.freeze({
  enabled: 'ops_control_recovery_enabled',
  mode: 'ops_control_recovery_mode',
});

export const CAPTURE_RECOVERY_GLOBAL_ENV = 'OPS_CONTROL_RECOVERY_GLOBAL_ENABLED';
export const CAPTURE_RECOVERY_ACTIONS_GLOBAL_ENV =
  'OPS_CONTROL_RECOVERY_ACTIONS_GLOBAL_ENABLED';
export const CAPTURE_RECOVERY_LEASE_SECONDS = 120;
export const CAPTURE_RECOVERY_BATCH_LIMIT = 25;
export const CAPTURE_RECOVERY_BACKFILL_PAGE_LIMIT = 25;
export const CAPTURE_RECOVERY_BACKFILL_SOURCE_TYPE = 'capture_recovery_backfill';
export const CAPTURE_RECOVERY_AGENT_SLOT_SOURCE_TYPE =
  'capture_recovery_agent_slot';
export const CAPTURE_RECOVERY_SCOPE_STOP_SOURCE_TYPE =
  'capture_recovery_scope_stop';
export const CAPTURE_RECOVERY_FAST_ATTEMPT_LIMIT = 3;
export const CAPTURE_RECOVERY_MAX_GENERATIONS = 3;
export const CAPTURE_RECOVERY_WAITING_AGENT_BACKOFF_MS = 10 * 60 * 1000;
export const CAPTURE_RECOVERY_VERIFY_DELAY_MS = 2 * 60 * 1000;
export const CAPTURE_RECOVERY_VERIFICATION_GRACE_MS = 30 * 60 * 1000;

const CAPTURE_RECOVERY_GENERATION_BACKOFF_MS = Object.freeze({
  1: 0,
  2: 30 * 60 * 1000,
  3: 60 * 60 * 1000,
});

const CAPTURE_RECOVERY_BACKFILL_STATUSES = Object.freeze([
  'retryable',
  'needs_action',
  'failed',
]);

const BOOLEAN_TRUE = new Set(['1', 'true', 'on', 'yes']);
const READY_STATUSES = Object.freeze([
  'ready',
  'waiting_due',
  'waiting_agent',
  'verifying_collection',
  'verifying_postprocessing',
]);
const TERMINAL_STATUSES = new Set([
  'resolved',
  'exhausted_window',
  'stopped_by_user',
  'failed',
]);
const HUMAN_REQUIRED_STATUSES = new Set(['waiting_human']);
const AUTOMATIC_CAPTURE_RECOVERY_FAULT_CLASSES = new Set([
  'extension_dom_contract',
  'extension_runtime',
  'host_browser_pressure',
  'network_local',
  'platform_service',
  'agent_control_plane',
]);
const VALID_STAGES = new Set([
  'unknown',
  'preflight',
  'search_nav',
  'search_ready',
  'list_capture',
  'detail_queue',
  'detail_capture',
  'comments',
  'local_durable_sync',
  'server_persisted',
  'ai_settled',
]);
const VALID_FAULT_CLASSES = new Set([
  'unknown',
  'extension_dom_contract',
  'extension_runtime',
  'host_browser_pressure',
  'network_local',
  'platform_service',
  'server_sync_ai',
  'platform_safety',
  'agent_control_plane',
  'user_stop',
]);
const SAFETY_CODES = new Set(CAPTURE_PLATFORM_SAFETY_CODES);
const USER_STOP_CODES = new Set([
  'USER_CANCELED',
  'USER_CANCELLED',
  'USER_CANCEL_REQUESTED',
  'CANCELED',
]);
const SENSITIVE_HEALTH_VALUE_PATTERN =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|apikey|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session|bearer)/iu;
const JWT_LIKE_HEALTH_VALUE_PATTERN =
  /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/u;
const UUID_LIKE_HEALTH_VALUE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LONG_OPAQUE_HEALTH_SEGMENT_PATTERN =
  /(?:^|[._:-])[A-Za-z0-9]{32,}(?:$|[._:-])/u;
const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u;

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function looksSensitiveHealthValue(value) {
  const raw = text(value, 320);
  if (!raw) return false;
  if (
    SENSITIVE_HEALTH_VALUE_PATTERN.test(raw)
    || JWT_LIKE_HEALTH_VALUE_PATTERN.test(raw)
    || UUID_LIKE_HEALTH_VALUE_PATTERN.test(raw)
    || LONG_OPAQUE_HEALTH_SEGMENT_PATTERN.test(raw)
    || AWS_ACCESS_KEY_ID_PATTERN.test(raw)
  ) return true;
  const compact = raw.replace(/[._:-]/gu, '');
  return (
    compact.length >= 32
    && /^[A-Za-z0-9+/_-]+$/u.test(compact)
    && /[a-z]/u.test(compact)
    && /[A-Z]/u.test(compact)
    && /\d/u.test(compact)
  );
}

function safeAppVersion(value) {
  const raw = text(value, 320);
  if (
    !raw
    || looksSensitiveHealthValue(raw)
  ) return '';
  return /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]{1,32})?$/u.test(raw)
    ? raw
    : '';
}

function integer(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedNumber(value, {minimum = 0, maximum = Number.MAX_SAFE_INTEGER} = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function exactNonNegativeInteger(value) {
  if (
    value === ''
    || value === null
    || value === undefined
    || (typeof value !== 'number' && typeof value !== 'string')
  ) return null;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (typeof normalized === 'string' && !/^\d+$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function timestampText(value) {
  if (value === undefined || value === null || text(value, 120) === '') return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestTimestampText(...values) {
  const timestamps = values
    .map(timestamp)
    .filter(value => value > 0);
  return timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : '';
}

function sha256(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function recoveryEvidenceObjects(candidate = {}) {
  const metadata = object(candidate.metadata);
  return [
    object(candidate.source_attempt_error),
    object(candidate.source_attempt_checkpoint),
    object(candidate.execution_attempt_error),
    object(candidate.execution_attempt_checkpoint),
    object(candidate.error),
    object(metadata.checkpoint),
  ];
}

function recoveryEvidenceCode(value = {}) {
  const source = object(value);
  return normalizeCaptureRecoveryErrorCode(
    source.code || source.errorCode || source.error_code,
    '',
  );
}

function recoveryEvidenceCategory(value = {}) {
  const source = object(value);
  return text(
    source.category || source.errorCategory || source.error_category,
    120,
  ).toLowerCase();
}

function recoveryEvidenceHasSafetyBoundary(value = {}) {
  const source = object(value);
  return Boolean(
    source.securityBlocked === true
    || source.security_blocked === true
    || source.platformSafetyBlocked === true
    || source.platform_safety_blocked === true
    || source.requiresManualAction === true
    || source.requires_manual_action === true
    || object(source.securityEvidence).confirmed === true
    || object(source.security_evidence).confirmed === true
  );
}

function recoveryEvidenceIsUserStop(value = {}) {
  const source = object(value);
  const cancelSource = text(
    source.cancelSource || source.cancel_source,
    80,
  ).toLowerCase();
  return USER_STOP_CODES.has(recoveryEvidenceCode(source))
    || recoveryEvidenceCategory(source) === 'user_canceled'
    || cancelSource === 'user';
}

function recoveryEvidenceIsSafety(value = {}) {
  const source = object(value);
  return SAFETY_CODES.has(recoveryEvidenceCode(source))
    || [
      'platform_safety_block',
      'login_required',
      'authentication_required',
    ].includes(recoveryEvidenceCategory(source))
    || recoveryEvidenceHasSafetyBoundary(source);
}

function normalizedCode(candidate = {}) {
  const evidence = recoveryEvidenceObjects(candidate);
  const stop = evidence.find(recoveryEvidenceIsUserStop);
  if (stop) return recoveryEvidenceCode(stop);
  const safety = evidence.find(recoveryEvidenceIsSafety);
  if (safety) return recoveryEvidenceCode(safety);
  return evidence.map(recoveryEvidenceCode).find(Boolean) || 'UNKNOWN';
}

function normalizedCategory(candidate = {}) {
  const evidence = recoveryEvidenceObjects(candidate);
  const stop = evidence.find(recoveryEvidenceIsUserStop);
  if (stop) return recoveryEvidenceCategory(stop);
  const safety = evidence.find(recoveryEvidenceIsSafety);
  if (safety) return recoveryEvidenceCategory(safety);
  return evidence.map(recoveryEvidenceCategory).find(Boolean) || '';
}

function firstObject(...values) {
  for (const value of values) {
    const normalized = object(value);
    if (Object.keys(normalized).length > 0) return normalized;
  }
  return {};
}

function healthEnvelope(value) {
  const source = object(value);
  const supplied = object(source.healthEvidence);
  const nested = object(supplied.healthEvidence);
  return {
    version: source.version ?? supplied.version ?? nested.version,
    appVersion: source.appVersion ?? supplied.appVersion ?? nested.appVersion,
    stage: source.stage || supplied.stage || nested.stage,
    phase: source.phase || supplied.phase || nested.phase,
    progressObserved: firstObject(
      source.progressObserved,
      supplied.progressObserved,
      nested.progressObserved,
    ),
    page: {
      ...object(nested.page),
      ...object(supplied.page),
      ...object(source.page),
    },
    network: {
      ...object(nested.network),
      ...object(supplied.network),
      ...object(source.network),
    },
    runtime: {
      ...object(nested.runtime),
      ...object(supplied.runtime),
      ...object(source.runtime),
    },
  };
}

function healthSources(candidate = {}) {
  const itemAttemptCheckpoint = object(candidate.source_attempt_checkpoint);
  return {
    taskAttempt: healthEnvelope(candidate.execution_attempt_health_evidence),
    // Only immutable, attempt-scoped evidence may influence an automatic
    // recovery decision. Replaceable task/parent metadata and its historical
    // aliases are intentionally excluded, even though the bounded formatter
    // below would prevent their raw text from being persisted.
    item: healthEnvelope({
      ...itemAttemptCheckpoint,
      healthEvidence: firstObject(
        itemAttemptCheckpoint.healthEvidence,
      ),
      stage: itemAttemptCheckpoint.stage,
      phase: itemAttemptCheckpoint.phase,
      progressObserved: firstObject(itemAttemptCheckpoint.progressObserved),
    }),
    execution: {},
    parent: {},
    itemMetadata: {},
    itemAttemptCheckpoint,
    executionMetadata: {},
    parentMetadata: {},
  };
}

function hasHealthSignal(value) {
  const source = object(value);
  return Boolean(
    source.stage
    || source.phase
    || source.appVersion
    || Object.keys(object(source.progressObserved)).length > 0
    || Object.keys(object(source.page)).length > 0
    || Object.keys(object(source.network)).length > 0
    || Object.keys(object(source.runtime)).length > 0
  );
}

function firstHealthEnvelope(...values) {
  for (const value of values) {
    if (hasHealthSignal(value)) return object(value);
  }
  return {};
}

function mergedHealthSection(sources, key) {
  // Later spreads are progressively stronger evidence. Exact per-task-attempt
  // health wins over replaceable task metadata, while item-attempt evidence
  // wins when it exists for the specific orchestration item.
  return {
    ...object(sources.parent[key]),
    ...object(sources.execution[key]),
    ...object(sources.taskAttempt[key]),
    ...object(sources.item[key]),
  };
}

/**
 * Return the only health fields the Agent ledger is allowed to persist.
 * Record text, URLs, cookies, headers and arbitrary metadata are deliberately
 * not copied even if a future heartbeat accidentally contains them.
 */
export function buildBoundedCaptureRecoveryHealth(candidate = {}) {
  const sources = healthSources(candidate);
  const preferred = firstHealthEnvelope(
    sources.item,
    sources.taskAttempt,
    sources.execution,
    sources.parent,
  );
  const page = mergedHealthSection(sources, 'page');
  const network = mergedHealthSection(sources, 'network');
  const runtime = mergedHealthSection(sources, 'runtime');
  const progress = firstObject(
    sources.item.progressObserved,
    sources.taskAttempt.progressObserved,
    sources.execution.progressObserved,
    sources.parent.progressObserved,
    sources.itemMetadata.progressObserved,
    sources.executionMetadata.progressObserved,
    sources.parentMetadata.progressObserved,
  );
  const stage = normalizeCaptureHealthStage(
    sources.item.stage
      || sources.itemAttemptCheckpoint.stage
      || sources.taskAttempt.stage
      || sources.execution.stage
      || sources.executionMetadata.stage
      || sources.parent.stage
      || sources.parentMetadata.stage,
    '',
  );
  const phase = normalizeCaptureHealthStage(
    sources.item.phase
      || sources.itemAttemptCheckpoint.phase
      || sources.taskAttempt.phase
      || sources.execution.phase
      || sources.executionMetadata.phase
      || sources.parent.phase
      || sources.parentMetadata.phase,
    '',
  );
  const appVersion = safeAppVersion(
    candidate.execution_attempt_app_version
      || sources.item.appVersion
      || sources.taskAttempt.appVersion
      || sources.execution.appVersion
      || sources.parent.appVersion,
  );
  return Object.freeze({
    version: integer(boundedNumber(preferred.version, {minimum: 1, maximum: 100}), 1) || 1,
    appVersion,
    stage,
    phase,
    progressObserved: {
      observed: progress.observed === true,
      sequence: integer(boundedNumber(progress.sequence, {maximum: 1000000})),
      current: integer(boundedNumber(progress.current, {maximum: 1000000})),
      total: integer(boundedNumber(progress.total, {maximum: 1000000})),
      observedAt: timestampText(progress.observedAt),
      ageMs: boundedNumber(progress.ageMs, {maximum: 7 * 24 * 60 * 60 * 1000}),
    },
    page: {
      platform: normalizeCaptureHealthPlatform(page.platform, ''),
      pageType: normalizeCaptureHealthPageType(page.pageType, ''),
      platformMatchesTask: booleanOrNull(page.platformMatchesTask),
      detailReady: booleanOrNull(page.detailReady),
      detailReadyReason: normalizeCaptureHealthDetailReadyReason(
        page.detailReadyReason,
      ),
      tabStatus: normalizeCaptureHealthTabStatus(page.tabStatus, ''),
      discarded: booleanOrNull(page.discarded),
      frozen: booleanOrNull(page.frozen),
    },
    network: {
      available: booleanOrNull(network.available),
      status: normalizeCaptureHealthNetworkStatus(network.status, ''),
      lastRequestLatencyMs: boundedNumber(network.lastRequestLatencyMs, {maximum: 120000}),
      lastRequestAt: timestampText(network.lastRequestAt),
      endpointClass: normalizeCaptureHealthEndpointClass(
        network.endpointClass,
      ),
      timeoutCount: integer(boundedNumber(network.timeoutCount, {maximum: 1000000})),
    },
    runtime: {
      stateAgeMs: boundedNumber(runtime.stateAgeMs, {maximum: 7 * 24 * 60 * 60 * 1000}),
      captureProgressAgeMs: boundedNumber(
        runtime.captureProgressAgeMs,
        {maximum: 7 * 24 * 60 * 60 * 1000},
      ),
      eventLoopLagMs: boundedNumber(runtime.eventLoopLagMs, {maximum: 120000}),
      heapUsedMb: boundedNumber(runtime.heapUsedMb, {maximum: 1024 * 1024}),
      heapLimitMb: boundedNumber(runtime.heapLimitMb, {maximum: 1024 * 1024}),
      serviceWorkerRestartCount: integer(boundedNumber(
        runtime.serviceWorkerRestartCount,
        {maximum: 1000000},
      )),
    },
  });
}

export function resolveCaptureRecoveryGlobalEnabled(env = process.env) {
  return BOOLEAN_TRUE.has(
    String(env?.[CAPTURE_RECOVERY_GLOBAL_ENV] ?? 'false').trim().toLowerCase(),
  );
}

export function resolveCaptureRecoveryActionsGlobalEnabled(env = process.env) {
  return BOOLEAN_TRUE.has(
    String(env?.[CAPTURE_RECOVERY_ACTIONS_GLOBAL_ENV] ?? 'false')
      .trim()
      .toLowerCase(),
  );
}

export function normalizeCaptureRecoverySettings(settings = {}, {
  env = process.env,
} = {}) {
  const source = object(settings);
  const globalEnabled = resolveCaptureRecoveryGlobalEnabled(env);
  const actionsGlobalEnabled = resolveCaptureRecoveryActionsGlobalEnabled(env);
  const tenantEnabled = BOOLEAN_TRUE.has(
    String(source[CAPTURE_RECOVERY_SETTING_KEYS.enabled] ?? 'false')
      .trim()
      .toLowerCase(),
  );
  const requestedMode = text(
    source[CAPTURE_RECOVERY_SETTING_KEYS.mode],
    40,
  ).toLowerCase();
  const mode = requestedMode === 'guarded' ? 'guarded' : 'observe';
  const enabled = globalEnabled && tenantEnabled;
  const actionsEnabled = enabled && actionsGlobalEnabled && mode === 'guarded';
  return Object.freeze({
    globalEnabled,
    actionsGlobalEnabled,
    tenantEnabled,
    enabled,
    mode,
    actionsEnabled,
    guarded: actionsEnabled,
  });
}

function normalizeCaptureRecoveryBackfillCursor(value, {now = new Date()} = {}) {
  const source = object(value);
  const cutoffCreatedAt = timestampText(
    source.cutoffCreatedAt || source.cutoff_created_at,
  ) || new Date(now).toISOString();
  const afterCreatedAt = timestampText(
    source.afterCreatedAt || source.after_created_at,
  );
  const afterId = text(source.afterId || source.after_id, 100).toLowerCase();
  const hasValidPosition = Boolean(
    afterCreatedAt && UUID_LIKE_HEALTH_VALUE_PATTERN.test(afterId),
  );
  return Object.freeze({
    version: 1,
    cutoffCreatedAt,
    afterCreatedAt: hasValidPosition ? afterCreatedAt : '',
    afterId: hasValidPosition ? afterId : '',
  });
}

function captureRecoveryBackfillDedupeKey(cursor) {
  const normalized = cursor ? normalizeCaptureRecoveryBackfillCursor(cursor) : null;
  return normalized?.afterId
    ? `capture-recovery-backfill:${normalized.afterId}`
    : 'capture-recovery-backfill:root';
}

export async function scanCaptureRecoveryBackfillPage({
  tenantId,
  cursor = null,
  now = new Date(),
  limit = CAPTURE_RECOVERY_BACKFILL_PAGE_LIMIT,
  queryAll = dbQueryAll,
} = {}) {
  const normalizedTenantId = text(tenantId, 100);
  const normalizedCursor = normalizeCaptureRecoveryBackfillCursor(cursor, {now});
  const boundedLimit = Math.max(1, Math.min(200, integer(
    limit,
    CAPTURE_RECOVERY_BACKFILL_PAGE_LIMIT,
  )));
  const rows = await queryAll(`
    SELECT
      item.id AS item_id,
      item.task_id,
      item.execution_task_id,
      item.status,
      item.assignment_revision,
      item.attempt_count,
      item.created_at
    FROM capture_task_items item
    WHERE item.tenant_id = $1
      AND item.status = ANY($2::text[])
      AND item.created_at <= $3::timestamptz
      AND (
        $4::timestamptz IS NULL
        OR (item.created_at, item.id) > ($4::timestamptz, $5::uuid)
      )
    ORDER BY item.created_at, item.id
    LIMIT $6
  `, [
    normalizedTenantId,
    [...CAPTURE_RECOVERY_BACKFILL_STATUSES],
    normalizedCursor.cutoffCreatedAt,
    normalizedCursor.afterCreatedAt || null,
    normalizedCursor.afterId || null,
    boundedLimit + 1,
  ]);
  const candidates = (Array.isArray(rows) ? rows : []).slice(0, boundedLimit);
  const hasMore = (Array.isArray(rows) ? rows.length : 0) > boundedLimit;
  const last = candidates[candidates.length - 1] || null;
  const nextCursor = hasMore && last
    ? normalizeCaptureRecoveryBackfillCursor({
        cutoffCreatedAt: normalizedCursor.cutoffCreatedAt,
        afterCreatedAt: last.created_at,
        afterId: last.item_id,
      }, {now})
    : null;
  const items = candidates
    .map(row => ({
      itemId: text(row?.item_id, 100),
      taskId: text(row?.task_id, 100),
      executionTaskId: text(row?.execution_task_id, 100),
      status: text(row?.status, 80),
      assignmentRevision: integer(row?.assignment_revision),
      attemptCount: integer(row?.attempt_count),
      createdAt: timestampText(row?.created_at),
    }))
    .filter(row => row.itemId);
  return Object.freeze({
    tenantId: normalizedTenantId,
    cutoffCreatedAt: normalizedCursor.cutoffCreatedAt,
    items: Object.freeze(items.map(row => Object.freeze(row))),
    itemIds: Object.freeze(items.map(row => row.itemId)),
    scanned: items.length,
    hasMore: Boolean(nextCursor),
    nextCursor,
  });
}

export async function enqueueCaptureRecoveryBackfillsForEnabledTenants({
  env = process.env,
  queryAll = dbQueryAll,
  enqueueWakeup,
  now = new Date(),
} = {}) {
  if (!resolveCaptureRecoveryGlobalEnabled(env)) {
    return Object.freeze({kind: 'global_disabled', tenants: 0, enqueued: 0});
  }
  if (typeof enqueueWakeup !== 'function') {
    throw new TypeError('capture recovery startup backfill requires enqueueWakeup');
  }
  const rows = await queryAll(`
    SELECT setting.tenant_id
    FROM tenant_settings setting
    JOIN tenants tenant ON tenant.id = setting.tenant_id
    WHERE setting.key = $1
      AND lower(btrim(setting.value)) = ANY($2::text[])
      AND tenant.status <> 'deleted'
    ORDER BY setting.tenant_id
  `, [CAPTURE_RECOVERY_SETTING_KEYS.enabled, [...BOOLEAN_TRUE]]);
  let enqueued = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const enabledTenantId = text(row?.tenant_id, 100);
    if (!enabledTenantId) continue;
    await enqueueWakeup({
      tenantId: enabledTenantId,
      reason: 'capture_recovery_backfill',
      sourceType: CAPTURE_RECOVERY_BACKFILL_SOURCE_TYPE,
      sourceId: enabledTenantId,
      dedupeKey: captureRecoveryBackfillDedupeKey(null),
      availableAt: now,
      payload: {
        cursor: null,
        trigger: 'global_enable_startup',
        observeOnly: true,
      },
      replaceAvailable: false,
    });
    enqueued += 1;
  }
  return Object.freeze({kind: 'enqueued', tenants: enqueued, enqueued});
}

export async function wakeWaitingCaptureRecoveryIntents({
  tenantId,
  agentIds = [],
  now = new Date(),
  limit = CAPTURE_RECOVERY_BATCH_LIMIT,
  queryAll = dbQueryAll,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(100, integer(limit, 25)));
  const normalizedAgentIds = Array.from(new Set(
    (Array.isArray(agentIds) ? agentIds : [])
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID_LIKE_HEALTH_VALUE_PATTERN.test(value)),
  ));
  const rows = await queryAll(`
    WITH waiting AS (
      SELECT intent.id
      FROM capture_recovery_intents intent
      JOIN capture_task_items item
        ON item.id = intent.item_id AND item.tenant_id = intent.tenant_id
      JOIN capture_tasks parent
        ON parent.id = intent.parent_task_id
        AND parent.tenant_id = intent.tenant_id
      CROSS JOIN LATERAL (
        SELECT lower(COALESCE(
          NULLIF(parent.metadata->>'promotedBusinessTaskType', ''),
          NULLIF(parent.metadata->>'businessTaskType', ''),
          NULLIF(parent.metadata->>'workflow', ''),
          NULLIF(parent.feature_key, ''),
          parent.task_type
        )) AS business_type,
        lower(COALESCE(NULLIF(item.platform, ''), parent.platform)) AS platform,
        COALESCE(
          parent.metadata->'planSnapshot',
          parent.metadata->'plan_snapshot',
          '{}'::jsonb
        ) AS plan_snapshot
      ) scope
      WHERE intent.tenant_id = $1
        AND intent.status = 'waiting_agent'
        AND intent.window_ends_at > $2
        AND intent.lease_token IS NULL
        AND EXISTS (
          SELECT 1
          FROM capture_agents agent
          JOIN tenants tenant ON tenant.id = agent.tenant_id
          JOIN auth_codes auth_code
            ON auth_code.id = agent.auth_code_id
            AND auth_code.tenant_id = agent.tenant_id
          JOIN auth_bindings binding
            ON binding.id = agent.auth_binding_id
            AND binding.code_id = auth_code.id
          WHERE agent.tenant_id = intent.tenant_id
            AND (
              cardinality($4::uuid[]) = 0
              OR agent.id = ANY($4::uuid[])
            )
            AND agent.status = 'active'
            AND tenant.status = 'active'
            AND auth_code.status = 'active'
            AND (
              auth_code.expires_at IS NULL
              OR auth_code.expires_at > $2::timestamptz
            )
            AND agent.last_heartbeat_at >=
              $2::timestamptz - interval '2 minutes'
            AND agent.capabilities @> '{
              "remoteTaskCreate": true,
              "remoteStop": true
            }'::jsonb
            AND (
              cardinality(agent.allowed_platforms) = 0
              OR scope.platform = ANY(agent.allowed_platforms)
            )
            AND CASE
              WHEN jsonb_typeof(
                agent.capabilities->'supportedPlatforms'
              ) = 'array' THEN
                jsonb_array_length(
                  agent.capabilities->'supportedPlatforms'
                ) = 0
                OR agent.capabilities->'supportedPlatforms' ? scope.platform
              ELSE true
            END
            AND CASE scope.business_type
              WHEN 'unattended_keyword_capture' THEN
                (
                  COALESCE(scope.plan_snapshot->'captureSettings', '{}'::jsonb)
                    = '{}'::jsonb
                  OR agent.capabilities @> '{
                    "remoteTaskEnhancementOptions": true
                  }'::jsonb
                )
                AND (
                  NOT (scope.plan_snapshot ? 'keywordMaxDetectedItems')
                  OR agent.capabilities @> '{
                    "remoteTaskKeywordPostLimit": true
                  }'::jsonb
                )
              WHEN 'negative_post_patrol' THEN
                agent.capabilities @> '{
                  "remoteTargetedPostCaptureV1": true,
                  "negativePostPatrol": true
                }'::jsonb
              WHEN 'watched_content_patrol' THEN
                agent.capabilities @> '{
                  "remoteTargetedPostCaptureV1": true,
                  "watchedContentPatrol": true
                }'::jsonb
              WHEN 'followed_creator_post_patrol' THEN
                agent.capabilities @> '{
                  "remoteTargetedPostCaptureV1": true,
                  "followedCreatorPostPatrol": true
                }'::jsonb
              WHEN 'official_account_post_discovery' THEN
                agent.capabilities @> '{
                  "remoteTargetedPostCaptureV1": true,
                  "officialAccountPostDiscovery": true
                }'::jsonb
              WHEN 'official_account_comment_patrol' THEN CASE
                WHEN item.item_type = 'profile_subscription' THEN
                  agent.capabilities @> '{
                    "remoteTargetedPostCaptureV1": true,
                    "officialAccountCommentPatrolProfileV1": true,
                    "officialAccountLatestPostsByCountV1": true
                  }'::jsonb
                ELSE agent.capabilities @> '{
                  "remoteTargetedPostCaptureV1": true,
                  "officialAccountCommentPatrol": true
                }'::jsonb
              END
              ELSE false
            END
            AND NOT EXISTS (
              SELECT 1
              FROM capture_tasks blocking_task
              WHERE blocking_task.tenant_id = agent.tenant_id
                AND COALESCE(
                  blocking_task.assigned_agent_id,
                  blocking_task.origin_agent_id
                ) = agent.id
                AND blocking_task.task_type <> 'capture_orchestration'
                AND blocking_task.status IN (
                  'pending', 'waiting_device', 'claimed', 'running',
                  'recovering', 'resume_requested'
                )
                AND blocking_task.id <> parent.id
                AND blocking_task.id IS DISTINCT FROM item.execution_task_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM capture_agent_commands blocking_command
              WHERE blocking_command.tenant_id = agent.tenant_id
                AND blocking_command.agent_id = agent.id
                AND blocking_command.status IN ('pending', 'acknowledged')
                AND (
                  blocking_command.expires_at IS NULL
                  OR blocking_command.expires_at > $2::timestamptz
                )
                AND blocking_command.task_id <> parent.id
                AND blocking_command.task_id IS DISTINCT FROM
                  item.execution_task_id
            )
        )
      ORDER BY intent.available_at, intent.id
      FOR UPDATE SKIP LOCKED
      LIMIT $3
    )
    UPDATE capture_recovery_intents intent
    SET available_at = LEAST(intent.available_at, $2),
      verification = intent.verification || jsonb_build_object(
        'agentSlotEventAt', $2::timestamptz::text
      ),
      updated_at = $2
    FROM waiting
    WHERE intent.id = waiting.id
    RETURNING intent.*
  `, [
    tenantId,
    new Date(now).toISOString(),
    boundedLimit,
    normalizedAgentIds,
  ]);
  return Object.freeze(Array.isArray(rows) ? rows : []);
}

export async function reactivateObservedCaptureRecoveryIntents({
  tenantId,
  now = new Date(),
  limit = CAPTURE_RECOVERY_BATCH_LIMIT,
  queryAll = dbQueryAll,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(100, integer(limit, 25)));
  const rows = await queryAll(`
    WITH observed AS (
      SELECT id
      FROM capture_recovery_intents
      WHERE tenant_id = $1
        AND status IN ('ready', 'waiting_due', 'waiting_agent')
        AND decision = 'observe'
        AND action_count = 0
        AND recovery_task_id IS NULL
        AND dispatched_attempt_id IS NULL
        AND fault_class NOT IN ('platform_safety', 'user_stop')
        AND window_ends_at > $2
        AND lease_token IS NULL
      ORDER BY available_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $3
    )
    UPDATE capture_recovery_intents intent
    SET status = 'ready',
      decision = 'none',
      available_at = $2,
      decision_payload = intent.decision_payload || jsonb_build_object(
        'reactivatedByGuardedMode', true
      ),
      verification = intent.verification || jsonb_build_object(
        'guardedModeActivatedAt', $2::timestamptz::text
      ),
      updated_at = $2
    FROM observed
    WHERE intent.id = observed.id
    RETURNING intent.*
  `, [tenantId, new Date(now).toISOString(), boundedLimit]);
  return Object.freeze(Array.isArray(rows) ? rows : []);
}

export function normalizeCaptureRecoveryStage(value) {
  const raw = text(value, 120).toLowerCase().replaceAll('-', '_');
  if (VALID_STAGES.has(raw)) return raw;
  if (raw.includes('search') && raw.includes('ready')) return 'search_ready';
  if (raw.includes('search')) return 'search_nav';
  if (raw.includes('comment')) return 'comments';
  if (raw.includes('detail')) return 'detail_capture';
  if (raw.includes('sync') || raw.includes('persist')) return 'local_durable_sync';
  if (raw.includes('prefilter') || raw.includes('ai')) return 'ai_settled';
  if (raw.includes('list') || raw.includes('scroll')) return 'list_capture';
  return 'unknown';
}

export function normalizeCaptureRecoveryFaultClass(value) {
  const normalized = text(value, 120).toLowerCase().replaceAll('-', '_');
  return VALID_FAULT_CLASSES.has(normalized) ? normalized : 'unknown';
}

function inferredStage(candidate = {}) {
  const error = object(candidate.error);
  const metadata = object(candidate.metadata);
  const checkpoint = object(metadata.checkpoint);
  const attemptError = object(candidate.source_attempt_error);
  const attemptCheckpoint = object(candidate.source_attempt_checkpoint);
  const executionAttemptError = object(candidate.execution_attempt_error);
  const executionAttemptCheckpoint = object(candidate.execution_attempt_checkpoint);
  const health = buildBoundedCaptureRecoveryHealth(candidate);
  return normalizeCaptureRecoveryStage(
    error.stage
      || error.phase
      || attemptError.stage
      || attemptError.phase
      || checkpoint.stage
      || checkpoint.phase
      || attemptCheckpoint.stage
      || attemptCheckpoint.phase
      || executionAttemptError.stage
      || executionAttemptError.phase
      || executionAttemptCheckpoint.stage
      || executionAttemptCheckpoint.phase
      || health.stage
      || health.phase,
  );
}

function inferredFaultClass(candidate = {}) {
  const evidence = recoveryEvidenceObjects(candidate);
  if (evidence.some(recoveryEvidenceIsUserStop)) return 'user_stop';
  if (evidence.some(recoveryEvidenceIsSafety)) return 'platform_safety';
  const explicit = normalizeCaptureRecoveryFaultClass(
    evidence.map(value => (
      value.failureOrigin
      || value.failure_origin
      || value.faultClass
      || value.fault_class
    )).find(Boolean),
  );
  if (explicit !== 'unknown') return explicit;

  const code = normalizedCode(candidate);
  const category = normalizedCategory(candidate);
  if (
    /DOUYIN_(?:DETAIL|COMMENT).*?(?:NOT_READY|ID_MISMATCH|SELECTOR)/u.test(code)
    || code === 'UNATTENDED_SEARCH_BOOTSTRAP_FAILED'
    || code === 'CAPTURE_FAILED'
  ) return 'extension_dom_contract';
  if (
    /CONTENT_RELAY|RECEIVING_END|NO_TAB|FRAME|STACK|FENCE|CHECKPOINT|EXTENSION_RUNTIME_RESTARTED|RUNTIME_ERROR|TASK_RUN_ERROR|CAPTURE_TASK_UNEXPECTED_CANCELLATION|CAPTURE_CANCELED/u
      .test(code)
    || ['runtime_error', 'extension_runtime'].includes(category)
  ) return 'extension_runtime';
  if (
    /SERVICE_ABNORMAL|PLATFORM_(?:UNAVAILABLE|RATE_LIMIT)|RATE_LIMITED/u.test(code)
    || ['platform_service', 'platform_unavailable', 'rate_limited'].includes(category)
  ) return 'platform_service';
  if (
    /STALE_TASK_HEARTBEAT|AGENT_(?:OFFLINE|UNAVAILABLE)|COMMAND_(?:DELIVERY_)?TIMEOUT/u
      .test(code)
    || ['agent_control_plane', 'agent_offline'].includes(category)
  ) return 'agent_control_plane';
  if (
    /TAB_DISCARDED|TAB_FROZEN|SERVICE_WORKER|BROWSER_PRESSURE/u.test(code)
    || ['host_browser_pressure', 'browser_pressure'].includes(category)
  ) return 'host_browser_pressure';
  if (
    (/REQUEST_TIMEOUT|NETWORK|DNS|TLS/u.test(code) || code === 'TIMEOUT')
    || ['network', 'network_timeout', 'api_timeout'].includes(category)
  ) return 'network_local';
  if (/SYNC|PERSIST|AI_|PREFILTER/u.test(code)) return 'server_sync_ai';

  // Health is supporting evidence, not a license to over-attribute a platform
  // failure. Only explicit bounded signals classify an otherwise unknown item.
  const health = buildBoundedCaptureRecoveryHealth(candidate);
  if (
    health.page.discarded === true
    || health.page.frozen === true
    || (health.runtime.eventLoopLagMs ?? 0) >= 5000
    || (
      (health.runtime.heapLimitMb ?? 0) > 0
      && (health.runtime.heapUsedMb / health.runtime.heapLimitMb) >= 0.95
    )
  ) return 'host_browser_pressure';
  if (
    (health.network.timeoutCount ?? 0) > 0
    || ['timeout', 'timed_out', 'offline', 'unreachable', 'degraded']
      .includes(health.network.status)
  ) return 'network_local';
  if (
    health.page.platformMatchesTask === false
    || health.page.detailReady === false
  ) return 'extension_dom_contract';
  return 'unknown';
}

export function captureRecoveryExplicitUserStop(candidate = {}) {
  const parentMetadata = object(
    candidate.parent_metadata || candidate.parentMetadata,
  );
  const itemMetadata = object(candidate.metadata);
  const stopCommandId = text(
    parentMetadata.stopCommandId || parentMetadata.stop_command_id,
    100,
  ).toLowerCase();
  const cancelSource = text(
    parentMetadata.cancelSource
      || parentMetadata.cancel_source
      || itemMetadata.cancelSource
      || itemMetadata.cancel_source,
    80,
  ).toLowerCase();
  return Boolean(
    UUID_LIKE_HEALTH_VALUE_PATTERN.test(stopCommandId)
    || parentMetadata.operatorStopped === true
    || parentMetadata.operator_stopped === true
    || parentMetadata.stoppedBeforeDispatch === true
    || parentMetadata.stopped_before_dispatch === true
    || itemMetadata.operatorStopped === true
    || itemMetadata.operator_stopped === true
    || itemMetadata.stoppedBeforeDispatch === true
    || itemMetadata.stopped_before_dispatch === true
    || cancelSource === 'user'
    || recoveryEvidenceObjects(candidate).some(recoveryEvidenceIsUserStop)
  );
}

export function captureRecoveryFastBudgetState(candidate = {}) {
  const evidence = recoveryEvidenceObjects(candidate);
  const explicitExhausted = evidence.some(value => (
    value.fastRetryExhausted === true
    || value.fast_retry_exhausted === true
    || value.localRetryExhausted === true
    || value.local_retry_exhausted === true
  ));
  const attemptCount = Math.max(
    integer(candidate.attempt_count ?? candidate.attemptCount),
    integer(candidate.source_attempt_number ?? candidate.sourceAttemptNumber),
    ...evidence.map(value => integer(
      value.attemptCount
        ?? value.attempt_count
        ?? object(value.recovery).attemptCurrent,
    )),
  );
  return Object.freeze({
    exhausted: explicitExhausted
      || attemptCount >= CAPTURE_RECOVERY_FAST_ATTEMPT_LIMIT,
    attemptCount,
    attemptLimit: CAPTURE_RECOVERY_FAST_ATTEMPT_LIMIT,
    explicitExhausted,
  });
}

export function classifyCaptureRecoveryCandidate(candidate = {}) {
  const status = text(candidate.status, 80).toLowerCase();
  const stage = inferredStage(candidate);
  const faultClass = inferredFaultClass(candidate);
  const code = normalizedCode(candidate);
  const fastBudget = captureRecoveryFastBudgetState(candidate);

  if (['completed', 'completed_with_warnings'].includes(status)) {
    return Object.freeze({
      eligible: false,
      terminalStatus: 'resolved',
      decision: 'observe',
      stage,
      faultClass,
      code,
      reason: 'item_completed',
    });
  }
  if (captureRecoveryExplicitUserStop(candidate)) {
    return Object.freeze({
      eligible: false,
      terminalStatus: 'stopped_by_user',
      decision: 'stop',
      stage,
      faultClass: 'user_stop',
      code,
      reason: 'user_stop',
    });
  }
  if (status === 'skipped') {
    return Object.freeze({
      eligible: false,
      terminalStatus: 'failed',
      decision: 'observe',
      stage,
      faultClass,
      code,
      reason: 'item_skipped_without_recovery',
    });
  }
  if (faultClass === 'platform_safety') {
    return Object.freeze({
      eligible: true,
      terminalStatus: 'waiting_human',
      decision: 'human_required',
      stage,
      faultClass,
      code,
      reason: 'platform_safety',
    });
  }
  if (!['retryable', 'needs_action', 'failed'].includes(status)) {
    return Object.freeze({
      eligible: false,
      terminalStatus: null,
      decision: 'none',
      stage,
      faultClass,
      code,
      reason: 'item_not_recovery_candidate',
    });
  }
  if (!fastBudget.exhausted && faultClass !== 'platform_safety') {
    return Object.freeze({
      eligible: false,
      terminalStatus: null,
      decision: 'observe',
      stage,
      faultClass,
      code,
      reason: 'fast_recovery_budget_available',
      fastBudget,
    });
  }
  return Object.freeze({
    eligible: true,
    terminalStatus: null,
    decision: 'none',
    stage,
    faultClass,
    code,
    reason: 'observe_candidate',
    fastBudget,
  });
}

export function buildCaptureRecoverySourceFingerprint(candidate = {}, classification = {}) {
  return sha256([
    text(candidate.tenant_id || candidate.tenantId, 100),
    text(candidate.item_id || candidate.itemId, 100),
    text(candidate.source_attempt_id || candidate.sourceAttemptId, 100),
    text(candidate.execution_attempt_id || candidate.executionAttemptId, 100),
    integer(candidate.assignment_revision ?? candidate.assignmentRevision),
    integer(
      candidate.source_attempt_number
        ?? candidate.sourceAttemptNumber
        ?? candidate.attempt_count
        ?? candidate.attemptCount,
    ),
    integer(
      candidate.execution_attempt_number
        ?? candidate.executionAttemptNumber,
    ),
  ]);
}

export function buildCaptureRecoveryKey({
  tenantId,
  itemId,
  stage,
  generation,
  sourceFingerprint,
} = {}) {
  return sha256([
    text(tenantId, 100),
    text(itemId, 100),
    normalizeCaptureRecoveryStage(stage),
    integer(generation),
    text(sourceFingerprint, 64),
  ]);
}

function recoveryWindow(candidate, now, previousWindowEndsAt = null) {
  const previous = timestamp(previousWindowEndsAt);
  if (previous > 0) {
    return {windowEndsAt: new Date(previous), fallback: true, reused: true};
  }
  const metadata = object(candidate.parent_metadata);
  const planSnapshot = object(metadata.planSnapshot);
  const recoveryPolicy = object(planSnapshot.recoveryPolicy);
  const explicit = [
    metadata.recoveryWindowEndsAt,
    metadata.windowEndsAt,
    recoveryPolicy.windowEndsAt,
  ].map(timestamp).find(value => value > 0);
  if (explicit) return {windowEndsAt: new Date(explicit), fallback: false};
  const anchor = [
    candidate.parent_scheduled_for,
    candidate.parent_created_at,
    candidate.item_created_at,
  ].map(timestamp).find(value => value > 0) || timestamp(now);
  return {
    windowEndsAt: new Date(anchor + 12 * 60 * 60 * 1000),
    fallback: true,
    reused: false,
  };
}

function captureRecoveryIntentEvidence({
  candidate,
  classification,
  window,
  availableAt,
  now,
  reboundFromSourceFingerprint = '',
} = {}) {
  return {
    sourceStatus: candidate.status,
    sourceAttemptStatus: candidate.source_attempt_status || '',
    sourceExecutionTaskId: candidate.execution_task_id || null,
    sourceExecutionAttemptId: candidate.execution_attempt_id || null,
    sourceExecutionAttemptNumber: integer(candidate.execution_attempt_number),
    sourceAgentId: candidate.source_attempt_agent_id
      || candidate.execution_attempt_agent_id
      || candidate.assigned_agent_id
      || null,
    errorCode: classification.code,
    reason: classification.reason,
    fastBudget: classification.fastBudget || captureRecoveryFastBudgetState(candidate),
    windowFallback: window.fallback,
    windowReused: window.reused === true,
    backoffMs: Math.max(0, timestamp(availableAt) - timestamp(now)),
    health: buildBoundedCaptureRecoveryHealth(candidate),
    observeOnly: true,
    ...(reboundFromSourceFingerprint
      ? {reboundFromSourceFingerprint}
      : {}),
  };
}

export function captureRecoveryGenerationAvailableAt({
  generation,
  now = new Date(),
  windowEndsAt,
  faultClass = 'unknown',
} = {}) {
  const nowMs = timestamp(now) || Date.now();
  let backoffMs = CAPTURE_RECOVERY_GENERATION_BACKOFF_MS[
    Math.max(1, Math.min(CAPTURE_RECOVERY_MAX_GENERATIONS, integer(generation, 1)))
  ] ?? 0;
  if (
    integer(generation, 1) === 1
    && normalizeCaptureRecoveryFaultClass(faultClass) === 'platform_service'
  ) {
    backoffMs = CAPTURE_RECOVERY_WAITING_AGENT_BACKOFF_MS;
  }
  const dueMs = nowMs + backoffMs;
  const windowMs = timestamp(windowEndsAt);
  return new Date(windowMs > 0 ? Math.min(dueMs, windowMs) : dueMs);
}

function boundedRecoveryFollowupAt(now, windowEndsAt, delayMs) {
  const nowMs = timestamp(now) || Date.now();
  const windowMs = timestamp(windowEndsAt);
  const dueMs = nowMs + Math.max(0, integer(delayMs));
  return new Date(windowMs > 0 ? Math.min(dueMs, windowMs) : dueMs);
}

function captureRecoveryVerificationEndsAt(windowEndsAt) {
  const actionDeadline = timestamp(windowEndsAt);
  return new Date(
    (actionDeadline > 0 ? actionDeadline : Date.now())
      + CAPTURE_RECOVERY_VERIFICATION_GRACE_MS,
  );
}

function captureRecoveryReuseEligibleAt(current = {}, now = new Date()) {
  const verification = object(
    current.intent_verification || current.verification,
  );
  const existing = timestampText(
    verification.reuseEligibleAt || verification.reuse_eligible_at,
  );
  if (existing) return existing;
  const plannedAvailableAt = timestamp(current.intent_available_at);
  const createdAt = timestamp(current.intent_created_at);
  if (
    plannedAvailableAt > 0
    && createdAt > 0
    && plannedAvailableAt - createdAt >= CAPTURE_RECOVERY_WAITING_AGENT_BACKOFF_MS
  ) {
    return new Date(plannedAvailableAt).toISOString();
  }
  return boundedRecoveryFollowupAt(
    now,
    current.window_ends_at,
    CAPTURE_RECOVERY_WAITING_AGENT_BACKOFF_MS,
  ).toISOString();
}

async function loadCaptureRecoveryCandidate(tx, tenantId, itemId) {
  return tx.queryOne(`
    SELECT
      item.id AS item_id,
      item.tenant_id,
      item.task_id AS parent_task_id,
      item.execution_task_id,
      item.assigned_agent_id,
      item.status,
      item.attempt_count,
      item.assignment_revision,
      item.error,
      item.metadata,
      item.created_at AS item_created_at,
      item.updated_at,
      parent.status AS parent_status,
      parent.metadata AS parent_metadata,
      parent.created_at AS parent_created_at,
      parent.scheduled_for AS parent_scheduled_for,
      execution_task.status AS execution_status,
      execution_task.metadata AS execution_metadata,
      execution_task.progress_seq AS execution_progress_seq,
      execution_task.business_progress_at AS execution_business_progress_at,
      item_attempt.id AS source_attempt_id,
      item_attempt.attempt_number AS source_attempt_number,
      item_attempt.status AS source_attempt_status,
      item_attempt.checkpoint AS source_attempt_checkpoint,
      item_attempt.error AS source_attempt_error,
      item_attempt.agent_id AS source_attempt_agent_id,
      execution_attempt.id AS execution_attempt_id,
      execution_attempt.agent_id AS execution_attempt_agent_id,
      execution_attempt.attempt_number AS execution_attempt_number,
      execution_attempt.status AS execution_attempt_status,
      execution_attempt.checkpoint AS execution_attempt_checkpoint,
      execution_attempt.error AS execution_attempt_error,
      execution_attempt.app_version AS execution_attempt_app_version,
      execution_attempt.health_evidence AS execution_attempt_health_evidence
    FROM capture_task_items item
    JOIN capture_tasks parent
      ON parent.id = item.task_id AND parent.tenant_id = item.tenant_id
    LEFT JOIN capture_tasks execution_task
      ON execution_task.id = item.execution_task_id
      AND execution_task.tenant_id = item.tenant_id
    LEFT JOIN LATERAL (
      SELECT latest.*
      FROM capture_task_item_attempts latest
      WHERE latest.tenant_id = item.tenant_id
        AND latest.item_id = item.id
      ORDER BY latest.attempt_number DESC, latest.created_at DESC, latest.id DESC
      LIMIT 1
    ) item_attempt ON true
    LEFT JOIN LATERAL (
      SELECT latest.*
      FROM capture_task_attempts latest
      WHERE latest.tenant_id = item.tenant_id
        AND latest.task_id = COALESCE(item.execution_task_id, item.task_id)
      ORDER BY latest.attempt_number DESC, latest.created_at DESC, latest.id DESC
      LIMIT 1
    ) execution_attempt ON true
    WHERE item.tenant_id = $1 AND item.id = $2
  `, [tenantId, itemId]);
}

async function reconcileTerminalRecoveryIntents(tx, {
  tenantId,
  itemId,
  classification,
  now,
}) {
  const rows = await tx.queryAll(`
    UPDATE capture_recovery_intents
    SET status = $3,
      decision = $4,
      verification = verification || $5::jsonb,
      resolved_at = $6,
      lease_token = NULL,
      lease_owner = '',
      leased_at = NULL,
      lease_expires_at = NULL,
      last_error = '',
      updated_at = $6
    WHERE tenant_id = $1 AND item_id = $2
      AND status <> ALL($7::text[])
      AND action_count = 0
      AND recovery_task_id IS NULL
      AND recovery_command_id IS NULL
      AND dispatched_attempt_id IS NULL
    RETURNING *
  `, [
    tenantId,
    itemId,
    classification.terminalStatus,
    classification.decision,
    JSON.stringify({
      reason: classification.reason,
      observedAt: new Date(now).toISOString(),
      noBusinessAction: true,
    }),
    new Date(now).toISOString(),
    [...TERMINAL_STATUSES],
  ]);
  return rows;
}

async function wakeActionedRecoveryIntentForBusinessVerification(tx, {
  tenantId,
  itemId,
  classification,
  now,
}) {
  const observedAt = new Date(now).toISOString();
  return tx.queryOne(`
    WITH actioned AS (
      SELECT id
      FROM capture_recovery_intents
      WHERE tenant_id = $1 AND item_id = $2
        AND status <> ALL($5::text[])
        AND (
          action_count > 0
          OR recovery_task_id IS NOT NULL
          OR recovery_command_id IS NOT NULL
          OR dispatched_attempt_id IS NOT NULL
          OR status IN ('verifying_collection', 'verifying_postprocessing')
        )
      ORDER BY generation DESC
      FOR UPDATE
      LIMIT 1
    )
    UPDATE capture_recovery_intents intent
    SET available_at = LEAST(intent.available_at, $3::timestamptz),
      verification = intent.verification || jsonb_build_object(
        'businessItemEventAt', $3::timestamptz::text,
        'businessItemEventStatus', $4::text,
        'businessVerifierRequired', true
      ),
      updated_at = $3
    FROM actioned
    WHERE intent.id = actioned.id
    RETURNING intent.*
  `, [
    tenantId,
    itemId,
    observedAt,
    classification.reason,
    [...TERMINAL_STATUSES],
  ]);
}

export async function ingestCaptureRecoveryItem({
  tenantId,
  itemId,
  now = new Date(),
  withTransaction = dbWithTransaction,
} = {}) {
  return withTransaction(async tx => {
    const candidate = await loadCaptureRecoveryCandidate(tx, tenantId, itemId);
    if (!candidate) return {kind: 'item_missing', itemId};
    const classification = classifyCaptureRecoveryCandidate(candidate);
    if (classification.terminalStatus && !classification.eligible) {
      if ([
        'item_completed',
        'item_skipped_without_recovery',
      ].includes(classification.reason)) {
        const actionedIntent =
          await wakeActionedRecoveryIntentForBusinessVerification(tx, {
            tenantId,
            itemId,
            classification,
            now,
          });
        if (actionedIntent) {
          return {
            kind: 'existing',
            itemId,
            classification,
            intent: actionedIntent,
          };
        }
      }
      const intents = await reconcileTerminalRecoveryIntents(tx, {
        tenantId,
        itemId,
        classification,
        now,
      });
      return {kind: 'terminal_reconciled', itemId, classification, intents};
    }
    if (!classification.eligible) {
      return {kind: 'ignored', itemId, classification};
    }

    await tx.execute(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['capture_recovery_intent', `${tenantId}:${itemId}`],
    );
    const sourceFingerprint = buildCaptureRecoverySourceFingerprint(
      candidate,
      classification,
    );
    const existing = await tx.queryOne(`
      SELECT *
      FROM capture_recovery_intents
      WHERE tenant_id = $1 AND source_fingerprint = $2
      FOR UPDATE
    `, [tenantId, sourceFingerprint]);
    if (existing) {
      if (classification.terminalStatus === 'waiting_human') {
        const observedAt = new Date(now).toISOString();
        const escalated = await tx.queryOne(`
          UPDATE capture_recovery_intents
          SET status = 'waiting_human',
            decision = 'human_required',
            fault_class = 'platform_safety',
            evidence = evidence || $3::jsonb,
            decision_payload = decision_payload || $4::jsonb,
            verification = verification || $5::jsonb,
            available_at = $6,
            lease_token = NULL,
            lease_owner = '',
            leased_at = NULL,
            lease_expires_at = NULL,
            resolved_at = NULL,
            updated_at = $6
          WHERE tenant_id = $1 AND id = $2
          RETURNING *
        `, [
          tenantId,
          existing.id,
          JSON.stringify({
            sourceStatus: candidate.status,
            errorCode: classification.code,
            health: buildBoundedCaptureRecoveryHealth(candidate),
            observeOnly: true,
          }),
          JSON.stringify({
            reason: classification.reason,
            noBusinessAction: true,
          }),
          JSON.stringify({
            observedAt,
            reason: 'human_boundary_escalated',
          }),
          observedAt,
        ]);
        return {
          kind: 'human_required',
          itemId,
          classification,
          intent: escalated,
        };
      }
      return {kind: 'existing', itemId, classification, intent: existing};
    }

    const latest = await tx.queryOne(`
      SELECT *
      FROM capture_recovery_intents
      WHERE tenant_id = $1 AND item_id = $2
      ORDER BY generation DESC
      LIMIT 1
      FOR UPDATE
    `, [tenantId, itemId]);
    if (latest?.status === 'stopped_by_user') {
      return {
        kind: 'stopped_by_user',
        itemId,
        classification,
        intent: latest,
      };
    }
    const latestActionCount = integer(latest?.action_count);
    const latestHasActionLineage = Boolean(
      latestActionCount > 0
      && UUID_LIKE_HEALTH_VALUE_PATTERN.test(
        text(latest?.recovery_task_id, 100),
      )
      && UUID_LIKE_HEALTH_VALUE_PATTERN.test(
        text(latest?.dispatched_attempt_id, 100),
      )
    );
    const candidateIsLatestDutyAttempt = Boolean(
      latestHasActionLineage
      && text(latest?.dispatched_attempt_id, 100).toLowerCase()
        === text(candidate.source_attempt_id, 100).toLowerCase()
    );
    if (latest && latestActionCount > 0 && !candidateIsLatestDutyAttempt) {
      return {
        kind: 'awaiting_lineage_reconciliation',
        itemId,
        classification,
        intent: latest,
      };
    }

    const generation = latestHasActionLineage
      ? integer(latest.generation) + 1
      : Math.max(1, integer(latest?.generation, 1));
    if (generation > CAPTURE_RECOVERY_MAX_GENERATIONS) {
      const exhaustedAt = new Date(now).toISOString();
      const exhausted = await tx.queryOne(`
        UPDATE capture_recovery_intents
        SET status = 'waiting_human',
          decision = 'human_required',
          decision_payload = decision_payload || $3::jsonb,
          verification = verification || $4::jsonb,
          lease_token = NULL,
          lease_owner = '',
          leased_at = NULL,
          lease_expires_at = NULL,
          resolved_at = NULL,
          updated_at = $5
        WHERE tenant_id = $1 AND item_id = $2
          AND generation = $6
        RETURNING *
      `, [
        tenantId,
        itemId,
        JSON.stringify({
          reason: 'generation_budget_exhausted',
          maxGenerations: CAPTURE_RECOVERY_MAX_GENERATIONS,
          exhaustedSourceFingerprint: sourceFingerprint,
          noBusinessAction: true,
        }),
        JSON.stringify({
          observedAt: exhaustedAt,
          sourceStatus: candidate.status,
          errorCode: classification.code,
        }),
        exhaustedAt,
        integer(latest?.generation),
      ]);
      return {
        kind: 'generation_exhausted',
        itemId,
        classification,
        intent: exhausted,
      };
    }
    const window = recoveryWindow(candidate, now, latest?.window_ends_at);
    const recoveryKey = buildCaptureRecoveryKey({
      tenantId,
      itemId,
      stage: classification.stage,
      generation,
      sourceFingerprint,
    });
    const initialStatus = classification.terminalStatus || 'ready';
    const initialDecision = classification.decision || 'none';
    const initialAvailableAt = classification.terminalStatus
      ? new Date(now)
      : captureRecoveryGenerationAvailableAt({
          generation,
          now,
          windowEndsAt: window.windowEndsAt,
          faultClass: classification.faultClass,
        });
    if (latest && !latestHasActionLineage) {
      if (latest.status === 'waiting_human' && initialStatus !== 'waiting_human') {
        return {
          kind: 'human_boundary_preserved',
          itemId,
          classification,
          intent: latest,
        };
      }
      const rebound = await tx.queryOne(`
        UPDATE capture_recovery_intents
        SET parent_task_id = $3,
          source_attempt_id = $4,
          source_execution_attempt_id = $5,
          stage = $6,
          fault_class = $7,
          status = $8,
          decision = $9,
          recovery_key = $10,
          source_fingerprint = $11,
          expected_assignment_revision = $12,
          expected_attempt_number = $13,
          window_ends_at = $14,
          available_at = $15,
          evidence = $16::jsonb,
          decision_payload = '{}'::jsonb,
          verification = verification || $17::jsonb,
          last_error = '',
          lease_token = NULL,
          lease_owner = '',
          leased_at = NULL,
          lease_expires_at = NULL,
          resolved_at = NULL,
          updated_at = $15
        WHERE tenant_id = $1 AND id = $2
          AND action_count = 0
          AND recovery_task_id IS NULL
          AND dispatched_attempt_id IS NULL
        RETURNING *
      `, [
        tenantId,
        latest.id,
        candidate.parent_task_id,
        candidate.source_attempt_id || null,
        candidate.execution_attempt_id || null,
        classification.stage,
        classification.faultClass,
        initialStatus,
        initialDecision,
        recoveryKey,
        sourceFingerprint,
        integer(candidate.assignment_revision),
        integer(candidate.source_attempt_number || candidate.attempt_count),
        window.windowEndsAt.toISOString(),
        initialAvailableAt.toISOString(),
        JSON.stringify(captureRecoveryIntentEvidence({
          candidate,
          classification,
          window,
          availableAt: initialAvailableAt,
          now,
          reboundFromSourceFingerprint: text(latest.source_fingerprint, 64),
        })),
        JSON.stringify({
          reboundAt: new Date(now).toISOString(),
          budgetGenerationPreserved: true,
          previousSourceFingerprint: text(latest.source_fingerprint, 64),
        }),
      ]);
      if (rebound) {
        return {
          kind: initialStatus === 'waiting_human'
            ? 'human_required'
            : 'rebound_without_budget_consumption',
          itemId,
          classification,
          intent: rebound,
        };
      }
      return {
        kind: 'rebind_conflict',
        itemId,
        classification,
        intent: latest,
      };
    }
    const intent = await tx.queryOne(`
      INSERT INTO capture_recovery_intents (
        tenant_id, parent_task_id, item_id,
        source_attempt_id, source_execution_attempt_id,
        stage, fault_class, generation, status, decision,
        recovery_key, source_fingerprint,
        expected_assignment_revision, expected_attempt_number,
        window_ends_at, available_at, evidence,
        resolved_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3,
        $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12,
        $13, $14,
        $15, $16, $17::jsonb,
        $18, $16, $16
      )
      ON CONFLICT (tenant_id, source_fingerprint) DO NOTHING
      RETURNING *
    `, [
      tenantId,
      candidate.parent_task_id,
      candidate.item_id,
      candidate.source_attempt_id || null,
      candidate.execution_attempt_id || null,
      classification.stage,
      classification.faultClass,
      generation,
      initialStatus,
      initialDecision,
      recoveryKey,
      sourceFingerprint,
      integer(candidate.assignment_revision),
      integer(candidate.source_attempt_number || candidate.attempt_count),
      window.windowEndsAt.toISOString(),
      initialAvailableAt.toISOString(),
      JSON.stringify(captureRecoveryIntentEvidence({
        candidate,
        classification,
        window,
        availableAt: initialAvailableAt,
        now,
      })),
      TERMINAL_STATUSES.has(initialStatus) ? new Date(now).toISOString() : null,
    ]);
    if (!intent) {
      const replay = await tx.queryOne(`
        SELECT * FROM capture_recovery_intents
        WHERE tenant_id = $1 AND source_fingerprint = $2
      `, [tenantId, sourceFingerprint]);
      return {kind: 'existing', itemId, classification, intent: replay};
    }
    return {kind: 'created', itemId, classification, intent};
  });
}

export async function claimCaptureRecoveryIntents({
  tenantId,
  intentIds = [],
  now = new Date(),
  limit = CAPTURE_RECOVERY_BATCH_LIMIT,
  leaseSeconds = CAPTURE_RECOVERY_LEASE_SECONDS,
  leaseOwner = `ops-control:${process.pid}`,
  leaseToken = crypto.randomUUID(),
  withTransaction = dbWithTransaction,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(100, integer(limit, 25)));
  const boundedLeaseSeconds = Math.max(30, Math.min(900, integer(leaseSeconds, 120)));
  const normalizedIds = Array.from(new Set(
    (Array.isArray(intentIds) ? intentIds : []).map(value => text(value, 100)).filter(Boolean),
  ));
  const claimed = await withTransaction(async tx => {
    const intents = await tx.queryAll(`
      WITH due AS (
        SELECT intent.id
        FROM capture_recovery_intents intent
        WHERE intent.tenant_id = $1
          AND intent.status = ANY($2::text[])
          AND intent.available_at <= clock_timestamp()
          AND (cardinality($3::uuid[]) = 0 OR intent.id = ANY($3::uuid[]))
          AND (
            intent.lease_token IS NULL
            OR intent.lease_expires_at <= clock_timestamp()
          )
        ORDER BY intent.available_at, intent.id
        FOR UPDATE SKIP LOCKED
        LIMIT $4
      )
      UPDATE capture_recovery_intents intent
      SET lease_token = $5::uuid,
        lease_owner = $6,
        leased_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + ($7::int * interval '1 second'),
        claim_count = intent.claim_count + 1,
        last_error = '',
        updated_at = clock_timestamp()
      FROM due
      WHERE intent.id = due.id
      RETURNING intent.*
    `, [
      tenantId,
      READY_STATUSES,
      normalizedIds,
      boundedLimit,
      leaseToken,
      text(leaseOwner, 240) || 'ops-control',
      boundedLeaseSeconds,
    ]);
    if (normalizedIds.length === 0) return {intents, deferred: []};
    const claimedIds = intents.map(intent => intent.id);
    const deferred = await tx.queryAll(`
      SELECT intent.*,
        CASE
          WHEN intent.lease_token IS NOT NULL
            AND intent.lease_expires_at > clock_timestamp()
            THEN GREATEST(intent.available_at, intent.lease_expires_at)
          -- A competing claimant may still hold the row lock while its new
          -- lease is invisible to this transaction. In that window the old
          -- row looks immediately due even though SKIP LOCKED correctly kept
          -- us from claiming it. Give the winner time to commit before the
          -- durable wakeup retries instead of creating a hot retry loop.
          ELSE GREATEST(
            intent.available_at,
            clock_timestamp() + interval '5 seconds'
          )
        END AS retry_at
      FROM capture_recovery_intents intent
      WHERE intent.tenant_id = $1
        AND intent.id = ANY($2::uuid[])
        AND intent.status = ANY($3::text[])
        AND (cardinality($4::uuid[]) = 0 OR NOT (intent.id = ANY($4::uuid[])))
      ORDER BY retry_at, intent.id
    `, [
      tenantId,
      normalizedIds,
      READY_STATUSES,
      claimedIds,
    ]);
    return {intents, deferred};
  });
  return Object.freeze({
    leaseToken,
    intents: claimed.intents,
    deferred: claimed.deferred,
  });
}

export async function renewCaptureRecoveryIntentLease({
  tenantId,
  intentId,
  leaseToken,
  now = new Date(),
  leaseSeconds = CAPTURE_RECOVERY_LEASE_SECONDS,
  queryOne = dbQueryOne,
} = {}) {
  const boundedLeaseSeconds = Math.max(30, Math.min(900, integer(leaseSeconds, 120)));
  return queryOne(`
    UPDATE capture_recovery_intents
    SET lease_expires_at = clock_timestamp() + ($4::int * interval '1 second'),
      updated_at = clock_timestamp()
    WHERE id = $1 AND tenant_id = $2 AND lease_token = $3::uuid
    RETURNING id, lease_expires_at
  `, [
    intentId,
    tenantId,
    leaseToken,
    boundedLeaseSeconds,
  ]);
}

export async function propagateStoppedCaptureRecoveryIntents({
  tenantId,
  intentIds = [],
  withTransaction = dbWithTransaction,
} = {}) {
  const normalizedIds = Array.from(new Set(
    (Array.isArray(intentIds) ? intentIds : [])
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID_LIKE_HEALTH_VALUE_PATTERN.test(value)),
  ));
  if (normalizedIds.length === 0) {
    return Object.freeze({claimed: 0, propagated: 0});
  }
  return withTransaction(async tx => {
    const rows = await tx.queryAll(`
      SELECT id, parent_task_id, verification
      FROM capture_recovery_intents
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND status = 'stopped_by_user'
      ORDER BY updated_at, id
      FOR UPDATE
    `, [tenantId, normalizedIds]);
    let propagated = 0;
    for (const row of rows) {
      const verification = object(row.verification);
      const sourceStopCommandId = text(
        verification.stopCommandId
          || verification.stop_command_id
          || verification.reason
          || 'recovery-intent-stopped',
        240,
      );
      await tx.execute(`
        SELECT propagate_capture_recovery_user_stop(
          $1::uuid, $2::uuid, $3::uuid, $4::text
        )
      `, [tenantId, row.id, row.parent_task_id, sourceStopCommandId]);
      propagated += 1;
    }
    return Object.freeze({claimed: rows.length, propagated});
  });
}

export async function stopCaptureRecoveryIntentsForScopes({
  tenantId,
  watchRecordIds = [],
  subscriptionIds = [],
  recoveryIntentIds = [],
  withTransaction = dbWithTransaction,
} = {}) {
  const normalizeIds = values => Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID_LIKE_HEALTH_VALUE_PATTERN.test(value)),
  ));
  const watchedIds = normalizeIds(watchRecordIds);
  const profileIds = normalizeIds(subscriptionIds);
  const exactIntentIds = normalizeIds(recoveryIntentIds);
  if (
    watchedIds.length === 0
    && profileIds.length === 0
    && exactIntentIds.length === 0
  ) {
    return Object.freeze({stopped: 0, propagated: 0, intentIds: []});
  }
  return withTransaction(async tx => {
    const stoppedById = new Map();
    if (exactIntentIds.length > 0) {
      const rows = await tx.queryAll(`
        UPDATE capture_recovery_intents intent
        SET status = 'stopped_by_user',
          decision = 'stop',
          verification = intent.verification || jsonb_build_object(
            'reason', 'recovery_child_stopped_by_user',
            'observedAt', clock_timestamp()::text,
            'noBusinessAction', intent.action_count = 0
          ),
          last_error = '',
          resolved_at = clock_timestamp(),
          lease_token = NULL,
          lease_owner = '',
          leased_at = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
        WHERE intent.tenant_id = $1
          AND intent.id = ANY($2::uuid[])
          AND intent.status NOT IN ('resolved', 'exhausted_window')
          AND (
            intent.status <> 'stopped_by_user'
            OR COALESCE(intent.verification->>'cascadeStopState', '') NOT IN (
              'verified', 'manual_required'
            )
          )
        RETURNING intent.id, intent.item_id, intent.parent_task_id
      `, [tenantId, exactIntentIds]);
      for (const row of rows) stoppedById.set(text(row.id, 100), row);
    }
    if (watchedIds.length > 0) {
      const rows = await tx.queryAll(`
        UPDATE capture_recovery_intents intent
        SET status = 'stopped_by_user',
          decision = 'stop',
          verification = intent.verification || jsonb_build_object(
            'reason', 'watchlist_intent_removed',
            'observedAt', clock_timestamp()::text,
            'noBusinessAction', intent.action_count = 0
          ),
          last_error = '',
          resolved_at = clock_timestamp(),
          lease_token = NULL,
          lease_owner = '',
          leased_at = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
        FROM capture_task_items item
        WHERE intent.tenant_id = $1
          AND item.id = intent.item_id
          AND item.tenant_id = intent.tenant_id
          AND item.item_type = 'watched_content'
          AND item.record_id = ANY($2::uuid[])
          AND NOT EXISTS (
            SELECT 1
            FROM record_watchlist watched
            WHERE watched.tenant_id = intent.tenant_id
              AND watched.record_id = item.record_id
          )
          AND intent.status NOT IN ('resolved', 'exhausted_window')
          AND (
            intent.status <> 'stopped_by_user'
            OR COALESCE(intent.verification->>'cascadeStopState', '') NOT IN (
              'verified', 'manual_required'
            )
          )
        RETURNING intent.id, intent.item_id, intent.parent_task_id
      `, [tenantId, watchedIds]);
      for (const row of rows) stoppedById.set(text(row.id, 100), row);
    }
    if (profileIds.length > 0) {
      const rows = await tx.queryAll(`
        UPDATE capture_recovery_intents intent
        SET status = 'stopped_by_user',
          decision = 'stop',
          verification = intent.verification || jsonb_build_object(
            'reason', 'profile_subscription_inactive',
            'observedAt', clock_timestamp()::text,
            'noBusinessAction', intent.action_count = 0
          ),
          last_error = '',
          resolved_at = clock_timestamp(),
          lease_token = NULL,
          lease_owner = '',
          leased_at = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
        FROM capture_task_items item
        WHERE intent.tenant_id = $1
          AND item.id = intent.item_id
          AND item.tenant_id = intent.tenant_id
          AND item.item_type = 'profile_subscription'
          AND lower(COALESCE(
            NULLIF(item.metadata->>'subscriptionId', ''),
            NULLIF(item.metadata->>'subscription_id', ''),
            item.external_id
          )) = ANY($2::text[])
          AND NOT EXISTS (
            SELECT 1
            FROM monitor_subscriptions subscription
            WHERE subscription.tenant_id = intent.tenant_id
              AND subscription.id::text = lower(COALESCE(
                NULLIF(item.metadata->>'subscriptionId', ''),
                NULLIF(item.metadata->>'subscription_id', ''),
                item.external_id
              ))
              AND subscription.status = 'active'
          )
          AND intent.status NOT IN ('resolved', 'exhausted_window')
          AND (
            intent.status <> 'stopped_by_user'
            OR COALESCE(intent.verification->>'cascadeStopState', '') NOT IN (
              'verified', 'manual_required'
            )
          )
        RETURNING intent.id, intent.item_id, intent.parent_task_id
      `, [tenantId, profileIds]);
      for (const row of rows) stoppedById.set(text(row.id, 100), row);
    }
    for (const row of stoppedById.values()) {
      await tx.execute(`
        SELECT enqueue_ops_control_wakeup(
          $1::uuid,
          'capture_recovery_scope_stopped',
          'capture_recovery_intent',
          $2::text,
          'capture-recovery-intent:' || $2::text || ':cascade-stop',
          clock_timestamp(),
          jsonb_build_object(
            'itemId', $3::uuid,
            'cascadeStop', true,
            'trigger', 'business_intent_removed'
          ),
          true
        )
      `, [tenantId, row.id, row.item_id]);
    }
    return Object.freeze({
      stopped: stoppedById.size,
      propagated: 0,
      intentIds: Object.freeze([...stoppedById.keys()]),
    });
  });
}

async function settleCaptureRecoveryIntent({
  tenantId,
  intentId,
  leaseToken,
  status,
  decision,
  decisionPayload = {},
  verification = {},
  lastError = '',
  now = new Date(),
  availableAt = now,
  queryOne = dbQueryOne,
}) {
  const terminal = TERMINAL_STATUSES.has(status);
  return queryOne(`
    UPDATE capture_recovery_intents
    SET status = $4,
      decision = $5,
      decision_payload = decision_payload || $6::jsonb,
      verification = verification || $7::jsonb,
      last_error = $8,
      available_at = $9,
      resolved_at = CASE WHEN $10::boolean THEN $11 ELSE resolved_at END,
      lease_token = NULL,
      lease_owner = '',
      leased_at = NULL,
      lease_expires_at = NULL,
      updated_at = $11
    WHERE id = $1 AND tenant_id = $2 AND lease_token = $3::uuid
    RETURNING *
  `, [
    intentId,
    tenantId,
    leaseToken,
    status,
    decision,
    JSON.stringify(decisionPayload),
    JSON.stringify(verification),
    text(lastError, 2000),
    new Date(availableAt).toISOString(),
    terminal,
    new Date(now).toISOString(),
  ]);
}

const KNOWN_RECOVERY_DISPATCH_ERRORS = new Set([
  'automatic_retry_disabled',
  'cross_device_retry_item_conflict',
  'cross_device_retry_revision_conflict',
  'duty_recovery_source_command_active',
  'duty_recovery_source_execution_active',
  'duty_recovery_agent_reuse_not_due',
  'duty_recovery_lease_expired',
  'duty_recovery_not_due',
  'duty_recovery_source_superseded',
  'idle_compatible_agent_unavailable',
  'idempotency_key_conflict',
  'invalid_duty_recovery_request',
  'invalid_recovery_phase',
  'invalid_retry_item_scope',
  'retry_items_not_automatically_recoverable',
  'retry_items_unavailable',
  'retry_item_capacity_exceeded',
  'retry_profile_execution_busy',
  'retry_profile_subscription_busy',
  'retry_profile_subscription_invalid',
  'retry_profile_subscription_unavailable',
  'recovery_window_ended',
  'retry_requires_manual_safety_action',
  'retry_source_command_active',
  'retry_source_execution_active',
  'revision_conflict',
  'source_attempt_conflict',
  'task_cross_device_retry_unsupported',
  'task_not_found',
  'task_not_settled_for_retry',
]);

function normalizedRecoveryDispatchError(value) {
  const normalized = text(value, 120).toLowerCase();
  return KNOWN_RECOVERY_DISPATCH_ERRORS.has(normalized)
    ? normalized
    : 'recovery_dispatch_failed';
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function verifiedZeroBusinessCheckpoint(value) {
  const source = object(value);
  const status = text(
    source.status || source.businessStatus || source.business_status,
    80,
  ).toLowerCase();
  const explicitZero = source.noResults === true
    || source.no_results === true
    || source.zeroResults === true
    || source.zero_results === true;
  const candidateCount = exactNonNegativeInteger(
    source.candidateCount ?? source.candidate_count,
  );
  const settledAt = timestampText(
    source.finishedAt
      || source.finished_at
      || source.checkedAt
      || source.checked_at,
  );
  return Boolean(
    ['completed', 'completed_with_warnings', 'succeeded', 'success']
      .includes(status)
    && explicitZero
    && text(source.resultKind || source.result_kind, 80).toLowerCase()
      === 'no_matching_results'
    && source.scanComplete === true
    && candidateCount === 0
    && settledAt
  );
}

function verifiedProfileZeroCheckpoint(value) {
  const source = object(value);
  const status = text(source.status, 80).toLowerCase();
  const hitCount = exactNonNegativeInteger(
    source.hitCount ?? source.hit_count,
  );
  const qualifyingCount = exactNonNegativeInteger(
    source.qualifyingCount ?? source.qualifying_count,
  );
  return Boolean(
    ['completed', 'completed_with_warnings'].includes(status)
    && (source.noResults === true || source.no_results === true)
    && text(source.resultKind || source.result_kind, 80).toLowerCase()
      === 'profile_scan_no_new_posts'
    && text(source.businessOutcome || source.business_outcome, 80).toLowerCase()
      === 'profile_scan_no_new_posts'
    && source.scanComplete === true
    && hitCount === 0
    && qualifyingCount === 0
    && timestampText(source.finishedAt || source.finished_at)
  );
}

function captureRecoveryBusinessTaskType(current = {}) {
  const parentMetadata = object(current.parent_metadata);
  return text(
    current.exact_recovery_task_type
      || parentMetadata.promotedBusinessTaskType
      || parentMetadata.workflow
      || current.parent_feature_key
      || current.parent_task_type,
    80,
  ).toLowerCase();
}

function captureRecoveryExpectedSearchPassCount(current = {}) {
  const parentMetadata = object(current.parent_metadata);
  const plan = object(
    parentMetadata.planSnapshot
      || parentMetadata.plan_snapshot
      || parentMetadata.plan,
  );
  const searchPasses = Array.isArray(plan.searchPasses)
    ? plan.searchPasses.filter(pass => text(pass, 80))
    : [];
  return Math.max(1, searchPasses.length);
}

function captureRecoverySearchPassesSettled(checkpoint = {}, current = {}) {
  const rows = Array.isArray(checkpoint.searchPassResults)
    ? checkpoint.searchPassResults
    : [];
  const expectedCount = captureRecoveryExpectedSearchPassCount(current);
  const byRound = new Map();
  for (const row of rows) {
    const pass = object(row);
    const round = integer(pass.round);
    if (round >= 1 && round <= expectedCount) byRound.set(round, pass);
  }
  if (
    checkpoint.scanComplete !== true
    || checkpoint.partial === true
    || byRound.size !== expectedCount
  ) return false;
  return Array.from({length: expectedCount}, (_, index) => index + 1)
    .every(round => {
    const pass = byRound.get(round);
    return [
      'completed',
      'completed_with_warnings',
    ].includes(text(pass.status, 80).toLowerCase())
      && pass.scanComplete === true
      && pass.partial !== true;
  });
}

function captureRecoveryRecordPostprocessingSettled(current = {}) {
  const recordType = text(current.result_record_type, 80).toLowerCase();
  const recordAiSettled = ['official_content', 'blogger_profile'].includes(recordType)
    || Boolean(
      timestampText(current.result_record_ai_labeled_at)
      && text(current.result_record_relevance, 80),
    );
  const commentReceiptSettled = [
    'not_required',
    'persisted',
  ].includes(text(current.result_observation_comment_workflow_status, 80));
  return recordAiSettled
    && commentReceiptSettled
    && integer(current.result_record_pending_comment_ai_count) === 0;
}

export function verifyCaptureRecoveryBusinessOutcome(current = {}) {
  const taskType = captureRecoveryBusinessTaskType(current);
  const attemptCheckpoint = object(current.exact_dispatched_attempt_checkpoint);
  const attemptResult = object(current.exact_dispatched_attempt_result);
  const targetResult = Object.keys(attemptResult).length > 0
    ? attemptResult
    : object(object(current.metadata).targetResult);
  const observedAt = timestampText(
    current.exact_dispatched_attempt_finished_at
      || attemptCheckpoint.finishedAt
      || attemptCheckpoint.finished_at
      || targetResult.finishedAt
      || targetResult.finished_at,
  );
  const attemptCompleted = [
    'completed',
    'completed_with_warnings',
  ].includes(text(current.exact_dispatched_attempt_status, 80).toLowerCase());

  if (taskType === 'unattended_keyword_capture') {
    if (
      !attemptCompleted
      || !captureRecoverySearchPassesSettled(attemptCheckpoint, current)
    ) {
      return Object.freeze({
        verified: false,
        kind: 'keyword_attempt_not_settled',
        taskType,
      });
    }
    const savedCount = boundedNumber(
      attemptCheckpoint.savedCount
        ?? attemptCheckpoint.saved_count
        ?? attemptResult.savedCount
        ?? attemptResult.saved_count,
      {minimum: 0, maximum: 1000000},
    );
    if (savedCount > 0) {
      const observationCount = integer(current.exact_attempt_observation_count);
      const postprocessingSettled =
        integer(current.exact_attempt_pending_record_ai_count) === 0
        && integer(current.exact_attempt_pending_comment_ai_count) === 0
        && integer(current.exact_attempt_unsettled_comment_workflow_count) === 0;
      return Object.freeze({
        verified: observationCount >= savedCount && postprocessingSettled,
        kind: observationCount >= savedCount && postprocessingSettled
          ? 'keyword_records_persisted_and_labeled'
          : 'keyword_postprocessing_pending',
        taskType,
        savedCount,
        observationCount,
        pendingRecordAi: integer(current.exact_attempt_pending_record_ai_count),
        pendingCommentAi: integer(current.exact_attempt_pending_comment_ai_count),
        unsettledCommentWorkflows: integer(
          current.exact_attempt_unsettled_comment_workflow_count,
        ),
        observedAt: timestampText(current.exact_attempt_latest_observation_at)
          || observedAt,
        proofCompletedAt: latestTimestampText(
          current.exact_attempt_latest_observation_at,
          current.exact_attempt_latest_record_ai_at,
          current.exact_attempt_latest_comment_ai_at,
          current.exact_attempt_latest_comment_workflow_at,
        ),
      });
    }
    if (verifiedZeroBusinessCheckpoint(attemptCheckpoint)) {
      return Object.freeze({
        verified: true,
        kind: 'verified_zero_result',
        taskType,
        observedAt,
      });
    }
    return Object.freeze({
      verified: false,
      kind: 'keyword_business_evidence_pending',
      taskType,
    });
  }

  const profileTask = [
    'followed_creator_post_patrol',
    'official_account_comment_patrol',
    'official_account_post_discovery',
  ].includes(taskType) && text(current.item_type, 80) === 'profile_subscription';
  if (profileTask) {
    const expectedSubjectType = taskType === 'followed_creator_post_patrol'
      ? 'creator'
      : 'official';
    const executionId = text(
      targetResult.executionId || targetResult.execution_id,
      100,
    ).toLowerCase();
    const targetSubscriptionId = text(
      targetResult.subscriptionId || targetResult.subscription_id,
      100,
    ).toLowerCase();
    const itemSubscriptionId = text(
      object(current.metadata).subscriptionId
        || object(current.metadata).subscription_id,
      100,
    ).toLowerCase();
    const hasHitCount = hasOwn(targetResult, 'hitCount')
      || hasOwn(targetResult, 'hit_count');
    const hitCount = boundedNumber(
      targetResult.hitCount ?? targetResult.hit_count,
      {minimum: 0, maximum: 1000000},
    );
    const monitorReady = attemptCompleted
      && targetResult.scanComplete === true
      && targetResult.partial !== true
      && UUID_LIKE_HEALTH_VALUE_PATTERN.test(executionId)
      && executionId === text(current.monitor_execution_id, 100).toLowerCase()
      && UUID_LIKE_HEALTH_VALUE_PATTERN.test(targetSubscriptionId)
      && targetSubscriptionId === itemSubscriptionId
      && targetSubscriptionId === text(
        current.monitor_subscription_id,
        100,
      ).toLowerCase()
      && text(current.monitor_execution_status, 80).toLowerCase() === 'succeeded'
      && text(current.monitor_subject_type, 80).toLowerCase() === expectedSubjectType
      && timestampText(current.monitor_execution_finished_at)
      && hasHitCount
      && hitCount === integer(current.monitor_execution_records_found);
    if (!monitorReady) {
      return Object.freeze({
        verified: false,
        kind: 'profile_monitor_evidence_pending',
        taskType,
      });
    }
    if (hitCount === 0) {
      if (verifiedProfileZeroCheckpoint(targetResult)) {
        return Object.freeze({
          verified: true,
          kind: 'profile_zero_result_verified',
          taskType,
          observedAt: timestampText(current.monitor_execution_finished_at),
          proofCompletedAt: timestampText(current.monitor_execution_finished_at),
        });
      }
      return Object.freeze({
        verified: false,
        kind: 'profile_zero_scan_completeness_missing',
        taskType,
        humanRequired: true,
      });
    }
    const observationCount = integer(current.monitor_observation_count);
    const postprocessingSettled =
      integer(current.monitor_pending_record_ai_count) === 0
      && integer(current.monitor_pending_comment_ai_count) === 0
      && integer(current.monitor_unsettled_comment_workflow_count) === 0;
    return Object.freeze({
      verified: observationCount >= hitCount && postprocessingSettled,
      kind: observationCount >= hitCount && postprocessingSettled
        ? 'profile_records_persisted_and_labeled'
        : 'profile_postprocessing_pending',
      taskType,
      hitCount,
      observationCount,
      pendingRecordAi: integer(current.monitor_pending_record_ai_count),
      pendingCommentAi: integer(current.monitor_pending_comment_ai_count),
      unsettledCommentWorkflows: integer(
        current.monitor_unsettled_comment_workflow_count,
      ),
      observedAt: timestampText(current.monitor_execution_finished_at),
      proofCompletedAt: latestTimestampText(
        current.monitor_execution_finished_at,
        current.monitor_latest_observation_at,
        current.monitor_latest_record_ai_at,
        current.monitor_latest_comment_ai_at,
        current.monitor_latest_comment_workflow_at,
      ),
    });
  }

  if ([
    'negative_post_patrol',
    'watched_content_patrol',
    'official_account_comment_patrol',
  ].includes(taskType)) {
    const businessOutcome = text(
      targetResult.businessOutcome || targetResult.business_outcome,
      80,
    ).toLowerCase();
    const availability = object(targetResult.availability);
    const availabilityStatus = text(
      targetResult.availabilityStatus
        || targetResult.availability_status
        || availability.availabilityStatus
        || availability.availability_status,
      80,
    ).toLowerCase();
    const targetScanComplete = targetResult.scanComplete === true
      && targetResult.partial !== true;
    const availabilityObservedAt = timestampText(
      availability.observedAt
        || availability.observed_at
        || targetResult.finishedAt
        || targetResult.finished_at,
    );
    const persistedAvailabilityAt = timestampText(
      current.result_record_availability_checked_at,
    );
    const unavailableRecordMatches = text(
      targetResult.recordId || targetResult.record_id,
      100,
    ).toLowerCase() === text(
      current.result_record_id || current.item_record_id,
      100,
    ).toLowerCase();
    const unavailableProofMatchesAttempt = Boolean(
      ['completed', 'completed_with_warnings', 'skipped'].includes(
        text(current.exact_dispatched_attempt_status, 80).toLowerCase(),
      )
      && targetScanComplete
      && unavailableRecordMatches
      && availabilityObservedAt
      && persistedAvailabilityAt
      && timestamp(availabilityObservedAt) === timestamp(persistedAvailabilityAt)
    );
    if (
      businessOutcome === 'post_unavailable'
      && ['deleted', 'page_unavailable'].includes(availabilityStatus)
      && unavailableProofMatchesAttempt
      && availabilityStatus === text(
        current.result_record_availability_status,
        80,
      ).toLowerCase()
    ) {
      return Object.freeze({
        verified: true,
        kind: 'post_unavailable_verified',
        taskType,
        observedAt: persistedAvailabilityAt,
        proofCompletedAt: persistedAvailabilityAt,
      });
    }
    const observationMatchesAttempt =
      UUID_LIKE_HEALTH_VALUE_PATTERN.test(
        text(current.result_observation_id, 100).toLowerCase(),
      )
      && text(current.result_observation_capture_attempt_id, 100).toLowerCase()
        === text(current.dispatched_attempt_id, 100).toLowerCase()
      && text(current.result_observation_record_id, 100).toLowerCase()
        === text(
          current.result_record_id || current.item_record_id,
          100,
        ).toLowerCase();
    const postprocessingSettled = captureRecoveryRecordPostprocessingSettled(current);
    return Object.freeze({
      verified: attemptCompleted
        && targetScanComplete
        && observationMatchesAttempt
        && postprocessingSettled,
      kind: attemptCompleted
        && targetScanComplete
        && observationMatchesAttempt
        && postprocessingSettled
        ? 'target_record_persisted_and_labeled'
        : 'target_postprocessing_pending',
      taskType,
      targetScanComplete,
      observationMatchesAttempt,
      postprocessingSettled,
      observedAt: timestampText(current.result_observation_captured_at),
      proofCompletedAt: latestTimestampText(
        current.result_observation_captured_at,
        current.result_record_ai_labeled_at,
        current.result_record_latest_comment_ai_at,
        current.result_observation_comment_workflow_finished_at,
      ),
    });
  }

  return Object.freeze({
    verified: false,
    kind: 'unsupported_business_task_type',
    taskType,
    humanRequired: true,
  });
}

async function defaultCaptureRecoveryDispatcher(input) {
  const {dispatchCrossDeviceRetry} = await import('../routes/capture-cloud.js');
  return dispatchCrossDeviceRetry(input);
}

function dispatchProjection(result = {}) {
  const itemAttempts = Array.isArray(result.itemAttempts) ? result.itemAttempts : [];
  const attempt = object(itemAttempts[0]);
  return Object.freeze({
    existing: result.existing === true,
    recoveryTaskId: text(result.child?.id || result.recoveryTaskId, 100).toLowerCase(),
    recoveryCommandId: text(
      result.command?.id || result.recoveryCommandId,
      100,
    ).toLowerCase(),
    recoveryAgentId: text(result.agent?.id || attempt.agentId, 100).toLowerCase(),
    dispatchedAttemptId: text(
      attempt.id || attempt.attemptId || result.dispatchedAttemptId,
      100,
    ).toLowerCase(),
    assignmentRevision: integer(
      attempt.assignmentRevision
        ?? result.parent?.orchestration_revision
        ?? result.assignmentRevision,
    ),
    attemptNumber: integer(attempt.attemptNumber ?? result.attemptNumber),
    executionTaskId: text(
      attempt.executionTaskId || result.child?.id || result.recoveryTaskId,
      100,
    ).toLowerCase(),
  });
}

export function verifyCaptureRecoveryDispatchLineage(current = {}) {
  const recoveryMetadata = object(current.exact_recovery_task_metadata);
  const expectedIntentId = text(current.id, 100).toLowerCase();
  const expectedItemId = text(current.item_id, 100).toLowerCase();
  const expectedParentId = text(current.parent_task_id, 100).toLowerCase();
  const expectedTaskId = text(current.recovery_task_id, 100).toLowerCase();
  const expectedAgentId = text(current.recovery_agent_id, 100).toLowerCase();
  const expectedAttemptId = text(current.dispatched_attempt_id, 100).toLowerCase();
  const checks = Object.freeze({
    attemptIdentity:
      expectedAttemptId
        === text(current.exact_dispatched_attempt_id, 100).toLowerCase(),
    attemptItem:
      expectedItemId
        === text(current.exact_dispatched_item_id, 100).toLowerCase(),
    attemptParent:
      expectedParentId
        === text(current.exact_dispatched_parent_task_id, 100).toLowerCase(),
    attemptExecution:
      expectedTaskId
        === text(current.exact_dispatched_execution_task_id, 100).toLowerCase(),
    attemptAgent:
      expectedAgentId
        === text(current.exact_dispatched_agent_id, 100).toLowerCase(),
    attemptNumber:
      integer(current.expected_attempt_number)
        === integer(current.exact_dispatched_attempt_number),
    attemptRevision:
      integer(current.expected_assignment_revision)
        === integer(current.exact_dispatched_assignment_revision),
    currentItemExecution:
      expectedTaskId === text(current.execution_task_id, 100).toLowerCase(),
    currentItemAgent:
      expectedAgentId
        === text(current.item_assigned_agent_id, 100).toLowerCase(),
    currentItemRevision:
      integer(current.expected_assignment_revision)
        === integer(current.assignment_revision),
    currentAttempt:
      expectedAttemptId
        === text(current.current_source_attempt_id, 100).toLowerCase(),
    recoveryTask:
      expectedTaskId === text(current.exact_recovery_task_id, 100).toLowerCase()
      && expectedParentId
        === text(current.exact_recovery_parent_task_id, 100).toLowerCase()
      && expectedAgentId
        === text(current.exact_recovery_agent_id, 100).toLowerCase(),
    recoveryMetadata:
      recoveryMetadata.dutyRecovery === true
      && text(recoveryMetadata.dutyRecoveryIntentId, 100).toLowerCase()
        === expectedIntentId
      && integer(recoveryMetadata.dutyRecoveryGeneration)
        === integer(current.generation)
      && text(recoveryMetadata.dutyRecoverySourceItemId, 100).toLowerCase()
        === expectedItemId,
    recoveryCommand:
      text(current.recovery_command_id, 100).toLowerCase()
        === text(current.exact_recovery_command_id, 100).toLowerCase()
      && expectedTaskId
        === text(current.exact_recovery_command_task_id, 100).toLowerCase()
      && expectedAgentId
        === text(current.exact_recovery_command_agent_id, 100).toLowerCase()
      && text(current.exact_recovery_command_type, 80).toLowerCase() === 'create',
  });
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return Object.freeze({
    verified: failedChecks.length === 0,
    checks,
    failedChecks: Object.freeze(failedChecks),
  });
}

async function markCaptureRecoveryDispatched({
  tenantId,
  intent,
  leaseToken,
  projection,
  countExistingIfUnrecorded = false,
  now,
  windowEndsAt,
  queryOne,
}) {
  const actionExecuted = projection.existing !== true;
  const incrementActionCount = actionExecuted || countExistingIfUnrecorded === true;
  const availableAt = boundedRecoveryFollowupAt(
    now,
    captureRecoveryVerificationEndsAt(windowEndsAt),
    CAPTURE_RECOVERY_VERIFY_DELAY_MS,
  );
  const row = await queryOne(`
    UPDATE capture_recovery_intents
    SET status = 'verifying_collection',
      decision = 'cross_agent_recovery',
      recovery_task_id = $4::uuid,
      recovery_command_id = $5::uuid,
      recovery_agent_id = $6::uuid,
      dispatched_attempt_id = $7::uuid,
      dispatched_at = COALESCE(dispatched_at, $8),
      expected_assignment_revision = $9,
      expected_attempt_number = $10,
      action_count = action_count + CASE
        WHEN $11::boolean AND action_count = 0 THEN 1
        ELSE 0
      END,
      decision_payload = decision_payload || $12::jsonb,
      verification = verification || $13::jsonb,
      last_error = '',
      available_at = $14,
      lease_token = NULL,
      lease_owner = '',
      leased_at = NULL,
      lease_expires_at = NULL,
      updated_at = $8
    WHERE id = $1 AND tenant_id = $2 AND lease_token = $3::uuid
    RETURNING *
  `, [
    intent.id,
    tenantId,
    leaseToken,
    projection.recoveryTaskId,
    projection.recoveryCommandId || null,
    projection.recoveryAgentId,
    projection.dispatchedAttemptId,
    new Date(now).toISOString(),
    projection.assignmentRevision,
    projection.attemptNumber,
    incrementActionCount,
    JSON.stringify({
      recoveryTaskId: projection.recoveryTaskId,
      recoveryCommandId: projection.recoveryCommandId || null,
      recoveryAgentId: projection.recoveryAgentId,
      dispatchedAttemptId: projection.dispatchedAttemptId,
      executionTaskId: projection.executionTaskId || null,
      generation: integer(intent.generation),
      replayed: projection.existing,
    }),
    JSON.stringify({
      dispatchedAt: new Date(now).toISOString(),
      businessEvidenceRequired: true,
      commandStateIsNotBusinessSuccess: true,
    }),
    availableAt.toISOString(),
  ]);
  return row ? {
    ...row,
    actionExecuted,
    recoveredUnrecordedDispatch: countExistingIfUnrecorded === true,
  } : row;
}

export async function processClaimedCaptureRecoveryIntent({
  tenantId,
  intent,
  leaseToken,
  now = new Date(),
  policy = {mode: 'observe', actionsEnabled: false},
  dispatchRecovery = defaultCaptureRecoveryDispatcher,
  queryOne = dbQueryOne,
}) {
  const current = await queryOne(`
    SELECT
      intent.id,
      intent.generation,
      intent.status AS intent_status,
      intent.available_at AS intent_available_at,
      intent.created_at AS intent_created_at,
      intent.decision AS intent_decision,
      intent.fault_class AS intent_fault_class,
      intent.stage AS intent_stage,
      intent.recovery_task_id,
      intent.recovery_command_id,
      intent.recovery_agent_id,
      intent.dispatched_attempt_id,
      intent.dispatched_at,
      intent.verification AS intent_verification,
      intent.item_id,
      intent.source_attempt_id,
      intent.source_execution_attempt_id,
      intent.expected_assignment_revision,
      intent.expected_attempt_number,
      intent.window_ends_at,
      item.task_id AS parent_task_id,
      item.execution_task_id,
      item.assigned_agent_id AS item_assigned_agent_id,
      item.item_type,
      item.platform AS item_platform,
      item.keyword AS item_keyword,
      item.record_id AS item_record_id,
      EXISTS (
        SELECT 1
        FROM record_watchlist watched
        WHERE watched.tenant_id = item.tenant_id
          AND watched.record_id = item.record_id
      ) AS watched_record_active,
      item.status AS item_status,
      item.attempt_count AS item_attempt_count,
      item.assignment_revision,
      COALESCE(result_observation.record_id, item.result_record_id) AS
        result_record_id,
      result_observation.id AS result_observation_id,
      result_observation.captured_at AS result_observation_captured_at,
      result_observation.capture_task_item_attempt_id AS
        result_observation_capture_attempt_id,
      result_observation.record_id AS result_observation_record_id,
      result_observation.comment_workflow_status AS
        result_observation_comment_workflow_status,
      result_observation.comment_workflow_finished_at AS
        result_observation_comment_workflow_finished_at,
      result_record.record_type AS result_record_type,
      result_record.ai_labeled_at AS result_record_ai_labeled_at,
      result_record.ai_result->>'relevance' AS result_record_relevance,
      result_record.content_availability_status AS
        result_record_availability_status,
      result_record.content_availability_checked_at AS
        result_record_availability_checked_at,
      direct_postprocessing.pending_comment_ai_count AS
        result_record_pending_comment_ai_count,
      direct_postprocessing.latest_comment_ai_at AS
        result_record_latest_comment_ai_at,
      item.finished_at AS item_finished_at,
      item.error,
      item.metadata,
      parent.status AS parent_status,
      parent.task_type AS parent_task_type,
      parent.feature_key AS parent_feature_key,
      parent.metadata AS parent_metadata,
      parent.orchestration_revision AS parent_orchestration_revision,
      current_item_attempt.id AS current_source_attempt_id,
      current_item_attempt.attempt_number AS current_source_attempt_number,
      current_item_attempt.assignment_revision AS current_source_assignment_revision,
      current_item_attempt.status AS current_source_attempt_status,
      current_item_attempt.checkpoint AS current_source_attempt_checkpoint,
      current_item_attempt.result AS current_source_attempt_result,
      current_item_attempt.error AS current_source_attempt_error,
      current_item_attempt.agent_id AS current_source_attempt_agent_id,
      current_execution_attempt.id AS current_execution_attempt_id,
      current_execution_attempt.attempt_number AS current_execution_attempt_number,
      current_execution_attempt.status AS current_execution_attempt_status,
      current_execution_attempt.checkpoint AS current_execution_attempt_checkpoint,
      current_execution_attempt.error AS current_execution_attempt_error,
      dispatched_attempt.id AS exact_dispatched_attempt_id,
      dispatched_attempt.item_id AS exact_dispatched_item_id,
      dispatched_attempt.parent_task_id AS exact_dispatched_parent_task_id,
      dispatched_attempt.execution_task_id AS exact_dispatched_execution_task_id,
      dispatched_attempt.agent_id AS exact_dispatched_agent_id,
      dispatched_attempt.attempt_number AS exact_dispatched_attempt_number,
      dispatched_attempt.assignment_revision AS
        exact_dispatched_assignment_revision,
      dispatched_attempt.status AS exact_dispatched_attempt_status,
      dispatched_attempt.checkpoint AS exact_dispatched_attempt_checkpoint,
      dispatched_attempt.result AS exact_dispatched_attempt_result,
      dispatched_attempt.error AS exact_dispatched_attempt_error,
      dispatched_attempt.finished_at AS exact_dispatched_attempt_finished_at,
      attempt_business.observation_count AS exact_attempt_observation_count,
      attempt_business.pending_record_ai_count AS
        exact_attempt_pending_record_ai_count,
      attempt_business.pending_comment_ai_count AS
        exact_attempt_pending_comment_ai_count,
      attempt_business.unsettled_comment_workflow_count AS
        exact_attempt_unsettled_comment_workflow_count,
      attempt_business.failed_comment_workflow_count AS
        exact_attempt_failed_comment_workflow_count,
      attempt_business.latest_observation_at AS
        exact_attempt_latest_observation_at,
      attempt_business.latest_record_ai_at AS
        exact_attempt_latest_record_ai_at,
      attempt_business.latest_comment_ai_at AS
        exact_attempt_latest_comment_ai_at,
      attempt_business.latest_comment_workflow_at AS
        exact_attempt_latest_comment_workflow_at,
      recovery_task.id AS exact_recovery_task_id,
      recovery_task.parent_task_id AS exact_recovery_parent_task_id,
      recovery_task.assigned_agent_id AS exact_recovery_agent_id,
      recovery_task.status AS exact_recovery_task_status,
      recovery_task.task_type AS exact_recovery_task_type,
      recovery_task.feature_key AS exact_recovery_feature_key,
      recovery_task.metadata AS exact_recovery_task_metadata,
      recovery_command.id AS exact_recovery_command_id,
      recovery_command.task_id AS exact_recovery_command_task_id,
      recovery_command.agent_id AS exact_recovery_command_agent_id,
      recovery_command.command_type AS exact_recovery_command_type,
      monitor_execution.status AS monitor_execution_status,
      monitor_execution.id AS monitor_execution_id,
      monitor_execution.records_found AS monitor_execution_records_found,
      monitor_execution.finished_at AS monitor_execution_finished_at,
      monitor_execution.updated_at AS monitor_execution_updated_at,
      monitor_execution.subject_type AS monitor_subject_type,
      monitor_execution.subscription_id AS monitor_subscription_id,
      monitor_business.observation_count AS monitor_observation_count,
      monitor_business.pending_record_ai_count AS monitor_pending_record_ai_count,
      monitor_business.pending_comment_ai_count AS monitor_pending_comment_ai_count,
      monitor_business.unsettled_comment_workflow_count AS
        monitor_unsettled_comment_workflow_count,
      monitor_business.failed_comment_workflow_count AS
        monitor_failed_comment_workflow_count,
      monitor_business.latest_observation_at AS monitor_latest_observation_at,
      monitor_business.latest_record_ai_at AS monitor_latest_record_ai_at,
      monitor_business.latest_comment_ai_at AS monitor_latest_comment_ai_at,
      monitor_business.latest_comment_workflow_at AS
        monitor_latest_comment_workflow_at,
      replayed_recovery_task.id AS replayed_recovery_task_id,
      replayed_recovery_task.assigned_agent_id AS replayed_recovery_agent_id,
      replayed_recovery_command.id AS replayed_recovery_command_id,
      replayed_item_attempt.id AS replayed_dispatched_attempt_id,
      replayed_item_attempt.attempt_number AS replayed_attempt_number,
      replayed_item_attempt.assignment_revision AS replayed_assignment_revision,
      replayed_item_attempt.execution_task_id AS replayed_execution_task_id
    FROM capture_recovery_intents intent
    JOIN capture_task_items item
      ON item.id = intent.item_id AND item.tenant_id = intent.tenant_id
    JOIN capture_tasks parent
      ON parent.id = intent.parent_task_id AND parent.tenant_id = intent.tenant_id
    LEFT JOIN LATERAL (
      SELECT exact_observation.*
      FROM record_observations exact_observation
      WHERE exact_observation.tenant_id = intent.tenant_id
        AND exact_observation.capture_task_item_attempt_id =
          intent.dispatched_attempt_id
      ORDER BY exact_observation.captured_at DESC,
        exact_observation.id DESC
      LIMIT 1
    ) result_observation ON true
    LEFT JOIN records result_record
      ON result_record.id = COALESCE(
        result_observation.record_id,
        item.result_record_id,
        item.record_id
      )
      AND result_record.tenant_id = item.tenant_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (
        WHERE comment.is_official = false
          AND comment.ai_classified_at IS NULL
      )::integer AS pending_comment_ai_count,
        MAX(comment.ai_classified_at) AS latest_comment_ai_at
      FROM record_comments comment
      WHERE comment.tenant_id = item.tenant_id
        AND comment.record_id = result_record.id
        AND comment.last_seen_at >= result_observation.captured_at
    ) direct_postprocessing ON true
    LEFT JOIN LATERAL (
      SELECT latest.id, latest.attempt_number, latest.assignment_revision,
        latest.status, latest.checkpoint, latest.result, latest.error,
        latest.agent_id
      FROM capture_task_item_attempts latest
      WHERE latest.tenant_id = intent.tenant_id
        AND latest.item_id = intent.item_id
      ORDER BY latest.attempt_number DESC, latest.created_at DESC, latest.id DESC
      LIMIT 1
    ) current_item_attempt ON true
    LEFT JOIN capture_task_item_attempts dispatched_attempt
      ON dispatched_attempt.id = intent.dispatched_attempt_id
      AND dispatched_attempt.tenant_id = intent.tenant_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT observation.record_id)::integer AS observation_count,
        COUNT(DISTINCT record.id) FILTER (
          WHERE record.record_type NOT IN ('official_content', 'blogger_profile')
            AND (
              record.ai_labeled_at IS NULL
              OR NULLIF(record.ai_result->>'relevance', '') IS NULL
            )
        )::integer AS pending_record_ai_count,
        COUNT(comment.id) FILTER (
          WHERE comment.is_official = false
            AND comment.ai_classified_at IS NULL
        )::integer AS pending_comment_ai_count,
        COUNT(DISTINCT observation.id) FILTER (
          WHERE observation.comment_workflow_status IN (
            'queued', 'running', 'failed'
          )
        )::integer AS unsettled_comment_workflow_count,
        COUNT(DISTINCT observation.id) FILTER (
          WHERE observation.comment_workflow_status = 'failed'
        )::integer AS failed_comment_workflow_count,
        MAX(observation.captured_at) AS latest_observation_at,
        MAX(record.ai_labeled_at) AS latest_record_ai_at,
        MAX(comment.ai_classified_at) AS latest_comment_ai_at,
        MAX(observation.comment_workflow_finished_at) AS
          latest_comment_workflow_at
      FROM record_observations observation
      JOIN records record
        ON record.id = observation.record_id
        AND record.tenant_id = observation.tenant_id
      LEFT JOIN record_comments comment
        ON comment.tenant_id = record.tenant_id
        AND comment.record_id = record.id
        AND comment.last_seen_at >= observation.captured_at
      WHERE observation.tenant_id = intent.tenant_id
        AND observation.capture_task_item_attempt_id = intent.dispatched_attempt_id
    ) attempt_business ON true
    LEFT JOIN LATERAL (
      SELECT latest.id, latest.attempt_number, latest.status,
        latest.checkpoint, latest.error
      FROM capture_task_attempts latest
      WHERE latest.tenant_id = intent.tenant_id
        AND latest.task_id = COALESCE(item.execution_task_id, item.task_id)
      ORDER BY latest.attempt_number DESC, latest.created_at DESC, latest.id DESC
      LIMIT 1
    ) current_execution_attempt ON true
    LEFT JOIN capture_tasks recovery_task
      ON recovery_task.id = intent.recovery_task_id
      AND recovery_task.tenant_id = intent.tenant_id
    LEFT JOIN capture_agent_commands recovery_command
      ON recovery_command.id = intent.recovery_command_id
      AND recovery_command.tenant_id = intent.tenant_id
    LEFT JOIN LATERAL (
      SELECT execution.id, execution.status, execution.records_found,
        execution.finished_at, execution.updated_at,
        execution.subscription_id, subscription.subject_type
      FROM monitor_executions execution
      JOIN monitor_subscriptions subscription
        ON subscription.id = execution.subscription_id
        AND subscription.tenant_id = execution.tenant_id
      WHERE execution.tenant_id = item.tenant_id
        AND execution.id::text = item.metadata->>'monitorExecutionId'
      ORDER BY execution.updated_at DESC, execution.id DESC
      LIMIT 1
    ) monitor_execution ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT observation.record_id)::integer AS observation_count,
        COUNT(DISTINCT record.id) FILTER (
          WHERE record.record_type NOT IN ('official_content', 'blogger_profile')
            AND (
              record.ai_labeled_at IS NULL
              OR NULLIF(record.ai_result->>'relevance', '') IS NULL
            )
        )::integer AS pending_record_ai_count,
        COUNT(comment.id) FILTER (
          WHERE comment.is_official = false
            AND comment.ai_classified_at IS NULL
        )::integer AS pending_comment_ai_count,
        COUNT(DISTINCT observation.id) FILTER (
          WHERE observation.comment_workflow_status IN (
            'queued', 'running', 'failed'
          )
        )::integer AS unsettled_comment_workflow_count,
        COUNT(DISTINCT observation.id) FILTER (
          WHERE observation.comment_workflow_status = 'failed'
        )::integer AS failed_comment_workflow_count,
        MAX(observation.captured_at) AS latest_observation_at,
        MAX(record.ai_labeled_at) AS latest_record_ai_at,
        MAX(comment.ai_classified_at) AS latest_comment_ai_at,
        MAX(observation.comment_workflow_finished_at) AS
          latest_comment_workflow_at
      FROM record_observations observation
      JOIN records record
        ON record.id = observation.record_id
        AND record.tenant_id = observation.tenant_id
      LEFT JOIN record_comments comment
        ON comment.tenant_id = record.tenant_id
        AND comment.record_id = record.id
        AND comment.last_seen_at >= observation.captured_at
      WHERE observation.tenant_id = item.tenant_id
        AND observation.monitor_execution_id = monitor_execution.id
        AND observation.capture_task_item_attempt_id =
          intent.dispatched_attempt_id
    ) monitor_business ON true
    LEFT JOIN capture_tasks replayed_recovery_task
      ON replayed_recovery_task.id = intent.id
      AND replayed_recovery_task.tenant_id = intent.tenant_id
      AND replayed_recovery_task.parent_task_id = intent.parent_task_id
      AND replayed_recovery_task.metadata->>'dutyRecovery' = 'true'
      AND replayed_recovery_task.metadata->>'dutyRecoveryIntentId' =
        intent.id::text
      AND replayed_recovery_task.metadata->>'dutyRecoveryGeneration' =
        intent.generation::text
      AND replayed_recovery_task.metadata->>'dutyRecoverySourceItemId' =
        intent.item_id::text
    LEFT JOIN LATERAL (
      SELECT latest.id, latest.attempt_number, latest.assignment_revision,
        latest.execution_task_id
      FROM capture_task_item_attempts latest
      WHERE latest.tenant_id = intent.tenant_id
        AND latest.item_id = intent.item_id
        AND latest.execution_task_id = replayed_recovery_task.id
      ORDER BY latest.attempt_number DESC, latest.created_at DESC, latest.id DESC
      LIMIT 1
    ) replayed_item_attempt ON true
    LEFT JOIN LATERAL (
      SELECT command.id
      FROM capture_agent_commands command
      WHERE command.tenant_id = intent.tenant_id
        AND command.task_id = replayed_recovery_task.id
        AND command.command_type = 'create'
      ORDER BY command.created_at DESC, command.id DESC
      LIMIT 1
    ) replayed_recovery_command ON true
    WHERE intent.id = $1 AND intent.tenant_id = $2
  `, [intent.id, tenantId]);
  if (!current) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'failed',
      decision: 'observe',
      lastError: 'recovery_source_missing',
      now,
      queryOne,
    });
  }
  if (captureRecoveryExplicitUserStop(current)) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'stopped_by_user',
      decision: 'stop',
      verification: {reason: 'source_stopped', noBusinessAction: true},
      now,
      queryOne,
    });
  }
  if (
    captureRecoveryBusinessTaskType(current) === 'watched_content_patrol'
    && current.watched_record_active !== true
  ) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'stopped_by_user',
      decision: 'stop',
      verification: {
        reason: 'watchlist_intent_removed',
        noBusinessAction: true,
      },
      now,
      queryOne,
    });
  }
  if (
    ['canceled', 'skipped', 'superseded'].includes(current.parent_status)
    || current.item_status === 'canceled'
  ) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'failed',
      decision: 'observe',
      verification: {
        reason: 'source_terminal_without_explicit_user_stop',
        parentStatus: current.parent_status,
        itemStatus: current.item_status,
        noBusinessAction: true,
      },
      lastError: 'source_terminal_without_explicit_user_stop',
      now,
      queryOne,
    });
  }
  const windowEnded = timestamp(current.window_ends_at) <= timestamp(now);
  const verificationEndsAt = captureRecoveryVerificationEndsAt(
    current.window_ends_at,
  );
  const verificationEnded = timestamp(verificationEndsAt) <= timestamp(now);
  if (
    !current.recovery_task_id
    && UUID_LIKE_HEALTH_VALUE_PATTERN.test(
      text(current.replayed_recovery_task_id, 100),
    )
    && UUID_LIKE_HEALTH_VALUE_PATTERN.test(
      text(current.replayed_recovery_agent_id, 100),
    )
    && UUID_LIKE_HEALTH_VALUE_PATTERN.test(
      text(current.replayed_dispatched_attempt_id, 100),
    )
    && integer(current.replayed_attempt_number) > 0
    && integer(current.replayed_assignment_revision) > 0
  ) {
    return markCaptureRecoveryDispatched({
      tenantId,
      intent: {...intent, generation: current.generation || intent.generation},
      leaseToken,
      projection: {
        existing: true,
        recoveryTaskId: text(current.replayed_recovery_task_id, 100),
        recoveryCommandId: text(current.replayed_recovery_command_id, 100),
        recoveryAgentId: text(current.replayed_recovery_agent_id, 100),
        dispatchedAttemptId: text(current.replayed_dispatched_attempt_id, 100),
        assignmentRevision: integer(current.replayed_assignment_revision),
        attemptNumber: integer(current.replayed_attempt_number),
        executionTaskId: text(current.replayed_execution_task_id, 100),
      },
      countExistingIfUnrecorded: true,
      now,
      windowEndsAt: current.window_ends_at,
      queryOne,
    });
  }
  const classification = classifyCaptureRecoveryCandidate({
    ...current,
    status: current.item_status,
    source_attempt_checkpoint: current.current_source_attempt_checkpoint,
    source_attempt_error: current.current_source_attempt_error,
    execution_attempt_checkpoint: current.current_execution_attempt_checkpoint,
    execution_attempt_error: current.current_execution_attempt_error,
  });

  const verifyingDispatchedAttempt = Boolean(
    current.dispatched_attempt_id
    || current.recovery_task_id
    || ['verifying_collection', 'verifying_postprocessing']
      .includes(text(current.intent_status || intent.status, 80)),
  );
  if (verifyingDispatchedAttempt) {
    const lineage = verifyCaptureRecoveryDispatchLineage(current);
    if (!lineage.verified) {
      const superseded = !lineage.checks.currentAttempt
        || !lineage.checks.currentItemExecution
        || !lineage.checks.currentItemAgent
        || !lineage.checks.currentItemRevision;
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: superseded ? 'resolved' : 'waiting_human',
        decision: superseded ? 'observe' : 'human_required',
        verification: {
          reason: superseded
            ? 'recovery_attempt_superseded'
            : 'recovery_lineage_invalid',
          failedChecks: lineage.failedChecks,
          lineage: lineage.checks,
          expectedAttemptNumber: integer(current.expected_attempt_number),
          observedAttemptNumber: integer(current.current_source_attempt_number),
          commandStateIsNotBusinessSuccess: true,
          ...(superseded ? {noBusinessAction: true} : {}),
        },
        now,
        queryOne,
      });
    }
    if ([
      'completed',
      'completed_with_warnings',
      'skipped',
    ].includes(current.item_status)) {
      const businessOutcome = verifyCaptureRecoveryBusinessOutcome(current);
      const businessObservedAt = timestamp(businessOutcome.observedAt);
      const proofCompletedAt = timestamp(
        businessOutcome.proofCompletedAt || businessOutcome.observedAt,
      );
      const businessObservedInsideWindow = (
        businessObservedAt > 0
        && businessObservedAt >= timestamp(current.dispatched_at)
        && businessObservedAt <= timestamp(verificationEndsAt)
        && proofCompletedAt >= businessObservedAt
        && proofCompletedAt <= timestamp(verificationEndsAt)
      );
      if (businessOutcome.verified && businessObservedInsideWindow) {
        return settleCaptureRecoveryIntent({
          tenantId,
          intentId: intent.id,
          leaseToken,
          status: 'resolved',
          decision: 'cross_agent_recovery',
          verification: {
            reason: 'business_outcome_verified',
            businessOutcome,
            commandStateIsNotBusinessSuccess: true,
          },
          now,
          queryOne,
        });
      }
      if (businessOutcome.humanRequired === true) {
        return settleCaptureRecoveryIntent({
          tenantId,
          intentId: intent.id,
          leaseToken,
          status: 'waiting_human',
          decision: 'human_required',
          decisionPayload: {
            reason: businessOutcome.kind,
            taskType: businessOutcome.taskType || '',
            noBusinessAction: true,
          },
          verification: {
            reason: 'business_evidence_contract_requires_human',
            businessOutcome,
            commandStateIsNotBusinessSuccess: true,
          },
          now,
          queryOne,
        });
      }
      if (verificationEnded) {
        return settleCaptureRecoveryIntent({
          tenantId,
          intentId: intent.id,
          leaseToken,
          status: 'exhausted_window',
          decision: 'cross_agent_recovery',
          verification: {
            reason: businessOutcome.verified
              ? 'business_evidence_outside_verification_window'
              : 'verification_window_ended_before_business_evidence',
            businessOutcome,
            verificationEndsAt: verificationEndsAt.toISOString(),
            commandStateIsNotBusinessSuccess: true,
          },
          now,
          queryOne,
        });
      }
      if (current.item_status === 'skipped') {
        return settleCaptureRecoveryIntent({
          tenantId,
          intentId: intent.id,
          leaseToken,
          status: 'waiting_human',
          decision: 'human_required',
          decisionPayload: {
            reason: 'unverified_terminal_business_skip',
            noBusinessAction: true,
          },
          verification: {businessOutcome},
          now,
          queryOne,
        });
      }
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'verifying_postprocessing',
        decision: 'cross_agent_recovery',
        verification: {
          reason: 'business_evidence_pending',
          itemStatus: current.item_status,
          businessOutcome,
          commandStateIsNotBusinessSuccess: true,
        },
        availableAt: boundedRecoveryFollowupAt(
          now,
          verificationEndsAt,
          CAPTURE_RECOVERY_VERIFY_DELAY_MS,
        ),
        now,
        queryOne,
      });
    }

    if (verificationEnded) {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'exhausted_window',
        decision: 'cross_agent_recovery',
        verification: {
          reason: 'verification_window_ended_before_business_completion',
          itemStatus: current.item_status,
          verificationEndsAt: verificationEndsAt.toISOString(),
          commandStateIsNotBusinessSuccess: true,
        },
        now,
        queryOne,
      });
    }

    if (classification.terminalStatus === 'waiting_human') {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'waiting_human',
        decision: 'human_required',
        verification: {
          reason: classification.reason,
          errorCode: classification.code,
          recoveryAttemptFailed: true,
        },
        now,
        queryOne,
      });
    }
    if (['retryable', 'needs_action', 'failed'].includes(current.item_status)) {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'failed',
        decision: 'cross_agent_recovery',
        verification: {
          reason: 'recovery_attempt_failed',
          sourceStatus: current.item_status,
          errorCode: classification.code,
          nextGenerationComesFromItemStateEvent: true,
          commandStateIsNotBusinessSuccess: true,
        },
        lastError: 'recovery_attempt_failed',
        now,
        queryOne,
      });
    }
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'verifying_collection',
      decision: 'cross_agent_recovery',
      verification: {
        reason: 'business_collection_in_progress',
        itemStatus: current.item_status,
        attemptStatus: current.current_source_attempt_status || '',
        commandStateIsNotBusinessSuccess: true,
      },
      availableAt: boundedRecoveryFollowupAt(
        now,
        verificationEndsAt,
        CAPTURE_RECOVERY_VERIFY_DELAY_MS,
      ),
      now,
      queryOne,
    });
  }

  if (windowEnded) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'exhausted_window',
      decision: 'observe',
      verification: {reason: 'window_ended', noBusinessAction: true},
      now,
      queryOne,
    });
  }

  const sourceItemAttemptMatches =
    text(current.source_attempt_id, 100)
      === text(current.current_source_attempt_id, 100)
    && integer(current.expected_attempt_number)
      === integer(
        current.current_source_attempt_id
          ? current.current_source_attempt_number
          : current.item_attempt_count,
      );
  const sourceExecutionAttemptMatches =
    text(current.source_execution_attempt_id, 100)
      === text(current.current_execution_attempt_id, 100);
  const assignmentRevisionMatches =
    integer(current.assignment_revision)
      === integer(current.expected_assignment_revision);
  if (
    !assignmentRevisionMatches
    || !sourceItemAttemptMatches
    || !sourceExecutionAttemptMatches
  ) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'resolved',
      decision: 'observe',
      verification: {
        reason: 'source_attempt_superseded',
        noBusinessAction: true,
        assignmentRevisionMatches,
        sourceItemAttemptMatches,
        sourceExecutionAttemptMatches,
        expectedAttemptNumber: integer(current.expected_attempt_number),
        observedAttemptNumber: integer(
          current.current_source_attempt_id
            ? current.current_source_attempt_number
            : current.item_attempt_count,
        ),
      },
      now,
      queryOne,
    });
  }
  if (classification.terminalStatus) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: classification.terminalStatus,
      decision: classification.decision,
      verification: {reason: classification.reason, noBusinessAction: true},
      now,
      queryOne,
    });
  }
  if (policy?.actionsEnabled !== true) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'waiting_due',
      decision: 'observe',
      decisionPayload: {
        mode: 'observe',
        actionsEnabled: false,
        noBusinessAction: true,
        wouldClassifyAs: intent.fault_class || classification.faultClass,
        stage: intent.stage || classification.stage,
      },
      verification: {
        reason: 'observe_only_gate',
        sourceStatus: current.item_status,
      },
      availableAt: current.window_ends_at,
      now,
      queryOne,
    });
  }

  if (!AUTOMATIC_CAPTURE_RECOVERY_FAULT_CLASSES.has(classification.faultClass)) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'waiting_human',
      decision: 'human_required',
      decisionPayload: {
        reason: classification.faultClass === 'server_sync_ai'
          ? 'server_recovery_action_not_available'
          : 'fault_class_not_safe_for_automatic_capture_retry',
        faultClass: classification.faultClass,
        errorCode: classification.code,
        noBusinessAction: true,
      },
      verification: {reason: 'automatic_action_boundary'},
      now,
      queryOne,
    });
  }

  let dispatched;
  const reuseEligibleAt = captureRecoveryReuseEligibleAt(current, now);
  const allowPreviouslyAttemptedAgents =
    timestamp(now) >= timestamp(reuseEligibleAt);
  try {
    dispatched = await dispatchRecovery({
      tenantId,
      taskId: current.parent_task_id,
      requestKey: intent.id,
      expectedRevision: integer(current.parent_orchestration_revision),
      expectedItemRevision: integer(current.assignment_revision),
      expectedSourceAttemptId: current.current_source_attempt_id || null,
      expectedAttemptNumber: integer(
        current.current_source_attempt_id
          ? current.current_source_attempt_number
          : current.item_attempt_count,
      ),
      itemIds: [current.item_id],
      actorType: 'system',
      requestedByName: '值守 Agent',
      automatic: true,
      recoveryPhase: 'duty',
      dutyRecoveryIntentId: intent.id,
      dutyRecoveryLeaseToken: leaseToken,
      dutyRecoveryGeneration: integer(current.generation || intent.generation, 1),
      allowPreviouslyAttemptedAgents,
    });
  } catch (error) {
    dispatched = {
      error: normalizedRecoveryDispatchError(
        error?.crossDeviceRetryError || error?.code,
      ),
    };
  }
  const dispatchError = normalizedRecoveryDispatchError(dispatched?.error);
  const dispatchCode = text(dispatched?.code, 120).toUpperCase();
  if (dispatched?.error) {
    if (dispatched.stoppedByUser === true) {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'stopped_by_user',
        decision: 'stop',
        decisionPayload: {
          reason: 'source_stopped_during_dispatch',
          dispatchError,
          noBusinessAction: true,
        },
        verification: {reason: 'user_stop_boundary'},
        now,
        queryOne,
      });
    }
    if (dispatchError === 'idle_compatible_agent_unavailable') {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'waiting_agent',
        decision: 'cross_agent_recovery',
        decisionPayload: {
          reason: 'waiting_for_idle_compatible_agent',
          budgetConsumed: false,
          generation: integer(current.generation || intent.generation, 1),
          allowPreviouslyAttemptedAgents,
        },
        verification: {
          reason: 'waiting_agent',
          noBusinessAction: true,
          reuseEligibleAt,
        },
        availableAt: allowPreviouslyAttemptedAgents
          ? boundedRecoveryFollowupAt(
              now,
              current.window_ends_at,
              CAPTURE_RECOVERY_WAITING_AGENT_BACKOFF_MS,
            )
          : new Date(reuseEligibleAt),
        now,
        queryOne,
      });
    }
    if (
      dispatchCode === 'RECOVERY_WINDOW_ENDED'
      || dispatchError === 'recovery_window_ended'
    ) {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'exhausted_window',
        decision: 'observe',
        decisionPayload: {
          reason: 'action_window_closed_during_dispatch',
          dispatchError,
          noBusinessAction: true,
        },
        verification: {
          reason: 'action_window_closed_at_final_gate',
          noBusinessAction: true,
        },
        now,
        queryOne,
      });
    }
    if (dispatchCode === 'RECOVERY_GATE_OFF') {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'waiting_due',
        decision: 'observe',
        decisionPayload: {
          reason: 'action_gate_closed_during_dispatch',
          dispatchError,
          noBusinessAction: true,
        },
        verification: {
          reason: 'action_gate_closed_at_final_gate',
          noBusinessAction: true,
        },
        availableAt: current.window_ends_at,
        now,
        queryOne,
      });
    }
    if ([
      'cross_device_retry_item_conflict',
      'duty_recovery_source_superseded',
      'source_attempt_conflict',
    ].includes(dispatchError)) {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'resolved',
        decision: 'observe',
        verification: {
          reason: 'source_changed_during_dispatch',
          dispatchError,
          noBusinessAction: true,
        },
        now,
        queryOne,
      });
    }
    if ([
      'automatic_retry_disabled',
      'idempotency_key_conflict',
      'invalid_duty_recovery_request',
      'invalid_recovery_phase',
      'invalid_retry_item_scope',
      'retry_items_not_automatically_recoverable',
      'retry_items_unavailable',
      'retry_item_capacity_exceeded',
      'retry_profile_subscription_invalid',
      'retry_profile_subscription_unavailable',
      'retry_requires_manual_safety_action',
      'task_cross_device_retry_unsupported',
    ].includes(dispatchError)) {
      return settleCaptureRecoveryIntent({
        tenantId,
        intentId: intent.id,
        leaseToken,
        status: 'waiting_human',
        decision: 'human_required',
        decisionPayload: {
          reason: 'automatic_dispatch_boundary',
          dispatchError,
          noBusinessAction: true,
        },
        verification: {reason: dispatchError},
        now,
        queryOne,
      });
    }
    const shortRetry = [
      'retry_source_command_active',
      'retry_source_execution_active',
      'duty_recovery_source_command_active',
      'duty_recovery_source_execution_active',
      'duty_recovery_agent_reuse_not_due',
      'duty_recovery_lease_expired',
      'duty_recovery_not_due',
      'revision_conflict',
      'cross_device_retry_revision_conflict',
      'retry_profile_execution_busy',
      'retry_profile_subscription_busy',
      'task_not_settled_for_retry',
    ].includes(dispatchError);
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'waiting_due',
      decision: 'cross_agent_recovery',
      decisionPayload: {
        reason: shortRetry ? 'source_settlement_pending' : 'dispatch_retry_pending',
        dispatchError,
        budgetConsumed: false,
      },
      verification: {reason: dispatchError, noBusinessAction: true},
      lastError: dispatchError,
      availableAt: boundedRecoveryFollowupAt(
        now,
        current.window_ends_at,
        shortRetry
          ? CAPTURE_RECOVERY_VERIFY_DELAY_MS
          : CAPTURE_RECOVERY_WAITING_AGENT_BACKOFF_MS,
      ),
      now,
      queryOne,
    });
  }

  const projection = dispatchProjection(dispatched);
  if (
    !UUID_LIKE_HEALTH_VALUE_PATTERN.test(projection.recoveryTaskId)
    || !UUID_LIKE_HEALTH_VALUE_PATTERN.test(projection.recoveryCommandId)
    || !UUID_LIKE_HEALTH_VALUE_PATTERN.test(projection.recoveryAgentId)
    || !UUID_LIKE_HEALTH_VALUE_PATTERN.test(projection.dispatchedAttemptId)
    || !UUID_LIKE_HEALTH_VALUE_PATTERN.test(projection.executionTaskId)
    || projection.assignmentRevision <= 0
    || projection.attemptNumber <= 0
  ) {
    return settleCaptureRecoveryIntent({
      tenantId,
      intentId: intent.id,
      leaseToken,
      status: 'waiting_due',
      decision: 'cross_agent_recovery',
      decisionPayload: {
        reason: 'invalid_dispatch_projection',
        budgetConsumed: false,
      },
      verification: {reason: 'dispatch_lineage_missing', noBusinessAction: true},
      lastError: 'invalid_dispatch_projection',
      availableAt: boundedRecoveryFollowupAt(
        now,
        current.window_ends_at,
        CAPTURE_RECOVERY_VERIFY_DELAY_MS,
      ),
      now,
      queryOne,
    });
  }
  return markCaptureRecoveryDispatched({
    tenantId,
    intent: {...intent, generation: current.generation || intent.generation},
    leaseToken,
    projection,
    countExistingIfUnrecorded:
      projection.existing === true && !current.recovery_task_id,
    now,
    windowEndsAt: current.window_ends_at,
    queryOne,
  });
}

export async function processCaptureRecoveryIntentBatch({
  tenantId,
  intentIds = [],
  now = new Date(),
  policy = {mode: 'observe', actionsEnabled: false},
  claimIntents = claimCaptureRecoveryIntents,
  processIntent = processClaimedCaptureRecoveryIntent,
  dispatchRecovery = defaultCaptureRecoveryDispatcher,
} = {}) {
  const claimed = await claimIntents({tenantId, intentIds, now});
  const intents = Array.isArray(claimed?.intents) ? claimed.intents : [];
  const deferred = Array.isArray(claimed?.deferred) ? claimed.deferred : [];
  const results = [];
  for (const intent of intents) {
    const settled = await processIntent({
      tenantId,
      intent,
      leaseToken: claimed.leaseToken,
      now,
      policy,
      dispatchRecovery,
    });
    results.push(settled);
  }
  return Object.freeze({
    claimed: intents.length,
    observed: results.filter(row => (
      row?.decision === 'observe'
      && !TERMINAL_STATUSES.has(row?.status)
    )).length,
    terminal: results.filter(row => TERMINAL_STATUSES.has(row?.status)).length,
    humanRequired: results.filter(row => HUMAN_REQUIRED_STATUSES.has(row?.status)).length,
    actionsExecuted: results.filter(row => row?.actionExecuted === true).length,
    results,
    deferred,
  });
}

export async function processCaptureRecoveryWakeups({
  tenantId,
  wakeups = [],
  now = new Date(),
  env = process.env,
  getSettings = getAllSettings,
  ingestItem = ingestCaptureRecoveryItem,
  processIntents = processCaptureRecoveryIntentBatch,
  scanBackfillPage = scanCaptureRecoveryBackfillPage,
  wakeWaitingIntents = wakeWaitingCaptureRecoveryIntents,
  reactivateObservedIntents = reactivateObservedCaptureRecoveryIntents,
  propagateStoppedIntents = propagateStoppedCaptureRecoveryIntents,
  stopScopedIntents = stopCaptureRecoveryIntentsForScopes,
  enqueueWakeup,
} = {}) {
  const rows = Array.isArray(wakeups) ? wakeups : [];
  const watchRecordIds = [];
  const subscriptionIds = [];
  const recoveryIntentScopeIds = [];
  for (const row of rows) {
    if (row.source_type !== CAPTURE_RECOVERY_SCOPE_STOP_SOURCE_TYPE) continue;
    const payload = object(row.payload);
    const scopeType = text(payload.scopeType || payload.scope_type, 80);
    if (scopeType === 'watchlist') {
      watchRecordIds.push(payload.recordId || payload.record_id || row.source_id);
    } else if (scopeType === 'profile_subscription') {
      subscriptionIds.push(
        payload.subscriptionId || payload.subscription_id || row.source_id,
      );
    } else if (scopeType === 'recovery_intent') {
      const intentId = text(
        payload.intentId || payload.intent_id || row.source_id,
        100,
      ).toLowerCase();
      const childTaskId = text(
        payload.childTaskId || payload.child_task_id,
        100,
      ).toLowerCase();
      if (intentId && childTaskId === intentId) {
        recoveryIntentScopeIds.push(intentId);
      }
    }
  }
  const scopeStop = (
    watchRecordIds.length > 0
    || subscriptionIds.length > 0
    || recoveryIntentScopeIds.length > 0
  )
    ? await stopScopedIntents({
        tenantId,
        watchRecordIds,
        subscriptionIds,
        recoveryIntentIds: recoveryIntentScopeIds,
      })
    : {stopped: 0, propagated: 0, intentIds: []};
  const stoppedIntentIds = Array.from(new Set(rows
    .filter(row => (
      row.source_type === 'capture_recovery_intent'
      && (
        /stop/u.test(text(row.reason, 160).toLowerCase())
        || object(row.payload).cascadeStop === true
      )
    ))
    .map(row => text(row.source_id, 100).toLowerCase())
    .filter(value => UUID_LIKE_HEALTH_VALUE_PATTERN.test(value))
    .concat(Array.isArray(scopeStop.intentIds) ? scopeStop.intentIds : [])));
  const stopPropagation = stoppedIntentIds.length > 0
    ? await propagateStoppedIntents({tenantId, intentIds: stoppedIntentIds})
    : {claimed: 0, propagated: 0};
  const policy = normalizeCaptureRecoverySettings(await getSettings(tenantId), {env});
  if (!policy.enabled) {
    return Object.freeze({
      kind: 'disabled',
      policy,
      scopeStop,
      stopPropagation,
      candidates: 0,
      intents: 0,
      humanRequired: 0,
      actionsExecuted: 0,
    });
  }

  const agentSlotIds = Array.from(new Set(rows
    .filter(row => (
      row.source_type === CAPTURE_RECOVERY_AGENT_SLOT_SOURCE_TYPE
      && UUID_LIKE_HEALTH_VALUE_PATTERN.test(text(row.source_id, 100))
    ))
    .map(row => text(row.source_id, 100).toLowerCase())));
  const hasAgentSlotEvent = agentSlotIds.length > 0;
  const hasBackfillEvent = rows.some(
    row => row.source_type === CAPTURE_RECOVERY_BACKFILL_SOURCE_TYPE,
  );
  const agentSlotIntents = hasAgentSlotEvent
    ? await wakeWaitingIntents({tenantId, agentIds: agentSlotIds, now})
    : [];
  const reactivatedIntents = policy.actionsEnabled && hasBackfillEvent
    ? await reactivateObservedIntents({tenantId, now})
    : [];
  const directItemIds = rows
    .filter(row => row.source_type === 'capture_task_item')
    .map(row => text(row.source_id, 100))
    .filter(Boolean);
  const backfillPages = [];
  const backfillItems = [];
  const pendingBackfillItemWakeups = [];
  const pendingBackfillWakeups = [];
  for (const row of rows.filter(
    candidate => candidate.source_type === CAPTURE_RECOVERY_BACKFILL_SOURCE_TYPE,
  )) {
    const payload = object(row.payload);
    const page = await scanBackfillPage({
      tenantId,
      cursor: payload.cursor,
      now,
    });
    backfillPages.push(page);
    backfillItems.push(...(Array.isArray(page?.items) ? page.items : []));
    if (page?.hasMore && page?.nextCursor) {
      if (typeof enqueueWakeup !== 'function') {
        throw new TypeError('capture recovery backfill continuation requires enqueueWakeup');
      }
      pendingBackfillWakeups.push({
        tenantId,
        reason: 'capture_recovery_backfill',
        sourceType: CAPTURE_RECOVERY_BACKFILL_SOURCE_TYPE,
        sourceId: tenantId,
        dedupeKey: captureRecoveryBackfillDedupeKey(page.nextCursor),
        availableAt: now,
        payload: {
          cursor: page.nextCursor,
          trigger: 'cursor_continue',
          observeOnly: policy.actionsEnabled !== true,
        },
        replaceAvailable: false,
      });
    }
  }
  for (const item of backfillItems) {
    if (!item?.itemId) continue;
    if (typeof enqueueWakeup !== 'function') {
      throw new TypeError('capture recovery backfill items require enqueueWakeup');
    }
    pendingBackfillItemWakeups.push({
      tenantId,
      reason: 'capture_recovery_backfill_item',
      sourceType: 'capture_task_item',
      sourceId: item.itemId,
      dedupeKey: `capture-recovery-item:${item.itemId}:${integer(
        item.assignmentRevision,
      )}:${text(item.status, 80)}`,
      availableAt: now,
      payload: {
        taskId: item.taskId || null,
        executionTaskId: item.executionTaskId || null,
        status: item.status,
        assignmentRevision: integer(item.assignmentRevision),
        attemptCount: integer(item.attemptCount),
        backfill: true,
        observeOnly: policy.actionsEnabled !== true,
      },
      replaceAvailable: false,
    });
  }
  const itemIds = Array.from(new Set(directItemIds));
  const intentIds = Array.from(new Set([
    ...rows
      .filter(row => row.source_type === 'capture_recovery_intent')
      .map(row => text(row.source_id, 100))
      .filter(Boolean),
    ...agentSlotIntents.map(row => text(row?.id, 100)).filter(Boolean),
    ...reactivatedIntents.map(row => text(row?.id, 100)).filter(Boolean),
  ]));
  const ingested = [];
  for (const itemId of itemIds) {
    const result = await ingestItem({tenantId, itemId, now});
    ingested.push(result);
    const intent = result?.intent;
    if (
      intent
      && READY_STATUSES.includes(intent.status)
      && typeof enqueueWakeup === 'function'
    ) {
      await enqueueWakeup({
        tenantId,
        reason: 'capture_recovery_intent_due',
        sourceType: 'capture_recovery_intent',
        sourceId: intent.id,
        dedupeKey: `capture-recovery-intent:${intent.id}`,
        availableAt: intent.available_at || now,
        payload: {
          itemId: intent.item_id,
          stage: intent.stage,
          generation: intent.generation,
          observeOnly: policy.actionsEnabled !== true,
        },
        replaceAvailable: false,
      });
    }
  }
  for (const itemWakeup of pendingBackfillItemWakeups) {
    await enqueueWakeup(itemWakeup);
  }
  const processed = intentIds.length > 0
    ? await processIntents({tenantId, intentIds, now, policy})
    : {
        claimed: 0,
        observed: 0,
        terminal: 0,
        humanRequired: 0,
        actionsExecuted: 0,
        results: [],
        deferred: [],
      };
  if (typeof enqueueWakeup === 'function') {
    for (const intent of (Array.isArray(processed?.results) ? processed.results : [])) {
      if (!intent || !READY_STATUSES.includes(intent.status)) continue;
      await enqueueWakeup({
        tenantId,
        reason: 'capture_recovery_intent_due',
        sourceType: 'capture_recovery_intent',
        sourceId: intent.id,
        dedupeKey: `capture-recovery-intent:${intent.id}:${intent.status}`,
        availableAt: intent.available_at || now,
        payload: {
          itemId: intent.item_id,
          stage: intent.stage,
          generation: intent.generation,
          observeOnly: policy.actionsEnabled !== true,
        },
        replaceAvailable: true,
      });
    }
    for (const intent of (Array.isArray(processed?.deferred) ? processed.deferred : [])) {
      if (!intent?.id || !READY_STATUSES.includes(intent.status)) continue;
      await enqueueWakeup({
        tenantId,
        reason: 'capture_recovery_lease_due',
        sourceType: 'capture_recovery_intent',
        sourceId: intent.id,
        dedupeKey: `capture-recovery-intent:${intent.id}:lease`,
        availableAt: intent.retry_at || intent.lease_expires_at || intent.available_at || now,
        payload: {
          itemId: intent.item_id,
          stage: intent.stage,
          generation: intent.generation,
          leaseCatchup: true,
          observeOnly: policy.actionsEnabled !== true,
        },
        replaceAvailable: true,
      });
    }
  }
  for (const continuation of pendingBackfillWakeups) {
    await enqueueWakeup(continuation);
  }
  return Object.freeze({
    kind: integer(processed?.actionsExecuted) > 0 ? 'acted' : 'observed',
    policy,
    scopeStop,
    stopPropagation,
    candidates: itemIds.length + backfillItems.length,
    intents: ingested.filter(row => [
      'created',
      'existing',
      'human_required',
    ].includes(row?.kind)).length,
    ingested,
    backfill: Object.freeze({
      pages: backfillPages.length,
      candidates: backfillItems.length,
      itemWakeups: pendingBackfillItemWakeups.length,
      continuations: pendingBackfillWakeups.length,
      hasMore: pendingBackfillWakeups.length > 0,
    }),
    agentSlot: Object.freeze({
      observed: hasAgentSlotEvent,
      intentsWoken: agentSlotIntents.length,
    }),
    guardedActivation: Object.freeze({
      observed: policy.actionsEnabled && hasBackfillEvent,
      intentsReactivated: reactivatedIntents.length,
    }),
    ...processed,
    humanRequired:
      ingested.filter(row => HUMAN_REQUIRED_STATUSES.has(row?.intent?.status)).length
      + integer(processed?.humanRequired),
    actionsExecuted: integer(processed?.actionsExecuted),
  });
}
