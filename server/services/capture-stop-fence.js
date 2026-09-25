import crypto from 'crypto';
import {
  captureAgentFullHeartbeatOnline,
  captureAgentLivenessOnline,
  captureTaskUnconfirmedLocalStopSql,
} from './capture-cloud.js';

// Stop-fence closure (0.4.16). A task that the Extension ended with
// PREVIOUS_CAPTURE_STOP_UNCONFIRMED keeps its source node out of admission
// until someone proves the old capture page stopped. After an elastic handoff
// the task is `superseded`, so no ordinary command reaches the node any more.
// This module closes that loop without touching the fence itself:
//   * the heartbeat offers a check request (never a remote command row, so
//     execution slots, relay gates and command expiry are unaffected);
//   * a self-consistent receipt bound to the current checkId, an explicit
//     operator confirmation, or the existing 976a0c6 admission rule releases
//     the row in the 2026-09-24/25 manual reconciliation format.
// The fence SQL and captureTaskHasUnconfirmedLocalStop are imported, never
// changed. Metadata writes never touch updated_at: the 976a0c6 rule compares
// later settled runs against historical_stop.updated_at.

export const STOP_FENCE_CHECK_CAPABILITY = 'previousCaptureStopCheckV1';
export const STOP_FENCE_CODE = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED';
export const STOP_FENCE_RECONCILED_CODE = 'HISTORICAL_STOP_FENCE_RECONCILED';
export const STOP_FENCE_PROOF_EVIDENCE = Object.freeze([
  'tab_closed',
  'tab_discarded',
  'navigated_off_platform',
  'runner_closed',
  'content_idle',
  'content_absent',
  'content_canceled_settled',
  'unrelated_live_capture',
]);
export const STOP_FENCE_CONTENT_EVIDENCE = Object.freeze([
  'content_idle',
  'content_absent',
  'content_canceled_settled',
  'unrelated_live_capture',
]);
export const STOP_FENCE_CHECK_TTL_MS = 10 * 60 * 1000;
export const STOP_FENCE_CHECK_RETRY_MS = 3 * 60 * 1000;
export const STOP_FENCE_OFFER_WRITE_THROTTLE_MS = 5 * 60 * 1000;
export const STOP_FENCE_OFFER_LIMIT = 3;
export const STOP_FENCE_ESCALATE_AFTER_FAILURES = 3;
export const STOP_FENCE_ESCALATE_AFTER_MS = 30 * 60 * 1000;
export const STOP_FENCE_LOCAL_RELEASE_TTL_MS = 24 * 60 * 60 * 1000;
// After an operator confirmation a 0.4.16 node must drop the lock bound to the
// old request before it runs new capture work, or the new run meets that lock
// (0.4.15 stale-lock path, CAPTURE_LOCK_CONFLICT). New work waits until the
// node answered the release, at most this long after the release was first
// offered.
export const STOP_FENCE_LOCAL_RELEASE_HOLD_MS = 10 * 60 * 1000;
// A release that was never offered holds new work outright on the node's
// first full heartbeat after the confirmation, however long the node was
// away: the offer is claimed in that same heartbeat, so the heartbeat that
// carries release_only never carries new work. After that first heartbeat it
// keeps holding until this long after the confirmation, so a heartbeat claim
// that keeps failing can never keep a node from work for long.
export const STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS = 60 * 60 * 1000;
// A heartbeat that started just before the confirmation committed can carry a
// later timestamp (transaction start vs. application clock); treat heartbeats
// this close to the confirmation as not having seen it.
const STOP_FENCE_LOCAL_RELEASE_SEEN_SKEW_MS = 60 * 1000;
// Per-node listing cap. The overview, the confirm route and the duty view use
// the same cap and order, so the ids an operator saw are exactly the ids the
// confirm route checks. The tenant-wide cap only guards pathological data.
export const STOP_FENCE_AGENT_LISTING_LIMIT = 200;
export const STOP_FENCE_TENANT_LISTING_LIMIT = 5000;
// A receipt may arrive shortly after its round expired (the node finished a
// 45 s sweep just as the round aged out). Accept it for five more minutes.
export const STOP_FENCE_RECEIPT_GRACE_MS = 5 * 60 * 1000;
export const STOP_FENCE_CONFIRMATION_TEXT = '确认旧页面已停止';

export const STOP_FENCE_PHASES = Object.freeze([
  'task_action_required',
  'manual_only',
  'auto_check_disabled',
  'offline',
  'heartbeat_degraded',
  'needs_operator',
  'node_retrying',
  'node_checking',
  'awaiting_node',
  'local_release_pending',
]);
// Phases that nobody can resolve without a person: alert at `high`.
export const STOP_FENCE_OPERATOR_PHASES = Object.freeze([
  'manual_only',
  'needs_operator',
  'auto_check_disabled',
  'heartbeat_degraded',
  'task_action_required',
]);
export const STOP_FENCE_PHASE_LABELS = Object.freeze({
  task_action_required: '停止保护来自仍需处理的任务，请在任务或批次里点「继续」或「停止」',
  manual_only: '扩展版本不支持自动核对或任务无法定位本机记录，请到该电脑检查后点「确认旧页面已停止」',
  auto_check_disabled: '自动核对已在服务端关闭，请到该电脑检查后点「确认旧页面已停止」',
  offline: '节点离线，上线后自动核对',
  heartbeat_degraded: '节点状态上报不完整，暂时收不到核对请求',
  needs_operator: '节点自动核对未能完成，需要到现场处理',
  node_retrying: '节点核对未通过，约 3 分钟后重试',
  node_checking: '已请求节点核对旧采集页面',
  awaiting_node: '等待节点核对旧采集页面',
  local_release_pending: '已人工确认，等待节点释放本机执行锁',
});

const REASON_LABELS = Object.freeze({
  previous_capture_stopped: '节点已确认旧采集页面已停止',
  request_active: '节点本机仍在运行该任务，稍后再核对',
  capture_still_active: '已向旧采集发送精确停止信号，尚未结束，稍后自动复核',
  tab_busy_unattributed: '页面上有无法归属的采集在运行，未做处理，稍后复核',
  off_platform_observing: '旧页面已离开平台，观察满 10 分钟后确认',
  tab_frozen: '页面暂时无法检查（冻结、加载中或无响应），稍后复核',
  probe_failed: '页面暂时无法检查（冻结、加载中或无响应），稍后复核',
  checkpoint_reports_pending: '旧任务还有进度未上报，暂不关闭其运行页，稍后复核',
  runner_close_failed: '本机运行页或执行锁未能释放，稍后复核',
  lock_holder_alive: '本机运行页或执行锁未能释放，稍后复核',
  local_release_failed: '本机运行页或执行锁未能释放，稍后复核',
  request_changed: '本机运行页或执行锁未能释放，稍后复核',
  check_timeout: '核对超时或本机状态读取失败，稍后复核',
  storage_unreadable: '核对超时或本机状态读取失败，稍后复核',
  old_document_uninspectable: '旧采集页面是扩展重载或升级前打开的，无法自动确认；请在该电脑关闭或刷新下列页面（或重启 Chrome），系统会在 3 分钟内自动复核',
  source_identity_unverifiable: '无法确认旧采集页面身份，请在该电脑关闭下列页面，或检查后人工确认',
  proof_rejected: '节点回执不满足放行条件',
  invalid_result: '节点回执格式不正确，请升级扩展或人工确认',
  local_release_done: '节点已释放本机执行锁',
  local_lock_absent: '节点已释放本机执行锁',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TARGET_ROLES = new Set([
  'runner', 'lock_holder', 'progress_tab', 'debug_source', 'group_source',
  'group_worker', 'fence_target', 'relay_target', 'platform_tab',
]);
const TARGET_PLATFORMS = new Set(['xiaohongshu', 'douyin', 'weibo', 'extension', 'other']);
const DOCUMENT_STATES = new Set(['current_runtime', 'before_runtime', 'unknown']);
const OVERLAY_STATES = new Set(['running', 'backoff', 'completed', 'failed', 'cancelled', '']);
const RUNTIME_ORIGINS = new Set(['browser_startup', 'extension_load', 'unknown']);
const FENCE_RUNTIMES = new Set(['same', 'different', 'unknown']);
const RESULT_MODES = new Set(['check', 'release_only']);
const MAX_TARGETS = 40;
const MAX_PENDING_TAB_IDS = 20;
const MAX_PENDING_TABS = 10;

function text(value, limit = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, limit);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isoAt(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isoOrEmpty(value) {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function nowMs(now) {
  const ms = toMs(now === undefined ? Date.now() : now);
  return Number.isFinite(ms) ? ms : Date.now();
}

function uniqueUuids(values, limit = 200) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID.test(value)),
  )].sort().slice(0, limit);
}

function nullableBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function nullableCount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, 1_000_000);
}

function positiveTabId(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function stopFenceAutoCheckEnabled(env = process.env) {
  return String(env?.CAPTURE_STOP_FENCE_AUTO_CHECK ?? '').trim().toLowerCase() !== 'off';
}

export function stopFenceReasonLabel(reason) {
  const code = text(reason, 80);
  return REASON_LABELS[code] || (code ? `节点核对未通过（${code}）` : '节点核对未通过');
}

export function stopFencePhaseLabel(phase) {
  return STOP_FENCE_PHASE_LABELS[text(phase, 80)] || '旧采集页面尚未确认停止';
}

/**
 * Whitelist a node receipt. The receipt is self-reported evidence: keep it
 * flat and bounded so it can be archived with the release, and drop anything
 * the protocol does not name. Missing booleans stay null so that the proof
 * check requires an explicit `false` rather than trusting an omission.
 */
export function normalizeStopFenceCheckResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {ok: false, reason: 'result_not_object'};
  }
  if (raw.version !== 1) return {ok: false, reason: 'unsupported_version'};
  const mode = text(raw.mode, 20);
  if (!RESULT_MODES.has(mode)) return {ok: false, reason: 'invalid_mode'};
  if (typeof raw.accepted !== 'boolean') return {ok: false, reason: 'accepted_not_boolean'};
  const reason = text(raw.reason, 80);
  if (!reason) return {ok: false, reason: 'reason_missing'};
  if (raw.targets !== undefined && !Array.isArray(raw.targets)) {
    return {ok: false, reason: 'targets_not_array'};
  }
  if (raw.pendingTabIds !== undefined && !Array.isArray(raw.pendingTabIds)) {
    return {ok: false, reason: 'pending_tab_ids_not_array'};
  }
  if (raw.pendingTabs !== undefined && !Array.isArray(raw.pendingTabs)) {
    return {ok: false, reason: 'pending_tabs_not_array'};
  }
  const rawTargets = Array.isArray(raw.targets) ? raw.targets : [];
  const targets = rawTargets.slice(0, MAX_TARGETS).map(item => {
    const target = object(item);
    const role = text(target.role, 40);
    const platform = text(target.platform, 40);
    const documentState = text(target.documentState, 40);
    const overlayState = text(target.overlayState, 40);
    return {
      tabId: nullableCount(target.tabId),
      role: TARGET_ROLES.has(role) ? role : '',
      evidence: text(target.evidence, 60),
      platform: TARGET_PLATFORMS.has(platform) ? platform : 'other',
      documentState: DOCUMENT_STATES.has(documentState) ? documentState : 'unknown',
      overlayState: OVERLAY_STATES.has(overlayState) ? overlayState : '',
    };
  });
  const pendingTabIds = (Array.isArray(raw.pendingTabIds) ? raw.pendingTabIds : [])
    .map(positiveTabId)
    .filter(value => value !== null)
    .slice(0, MAX_PENDING_TAB_IDS);
  const pendingTabs = (Array.isArray(raw.pendingTabs) ? raw.pendingTabs : [])
    .slice(0, MAX_PENDING_TABS)
    .map(item => {
      const tab = object(item);
      const platform = text(tab.platform, 40);
      return {
        tabId: nullableCount(tab.tabId),
        platform: TARGET_PLATFORMS.has(platform) ? platform : 'other',
        evidence: text(tab.evidence, 60),
        title: text(tab.title, 40),
      };
    });
  const runtimeEpochOrigin = text(raw.runtimeEpochOrigin, 40);
  const fenceRuntime = text(raw.fenceRuntime, 40);
  return {
    ok: true,
    result: {
      version: 1,
      mode,
      checkId: text(raw.checkId, 100).toLowerCase(),
      taskId: text(raw.taskId, 100).toLowerCase(),
      requestId: text(raw.requestId, 240),
      accepted: raw.accepted,
      reason,
      retryable: nullableBoolean(raw.retryable),
      requiresOperator: nullableBoolean(raw.requiresOperator),
      proofMethod: text(raw.proofMethod, 40),
      requestKnown: nullableBoolean(raw.requestKnown),
      requestStatus: text(raw.requestStatus, 40),
      requestActive: nullableBoolean(raw.requestActive),
      attemptId: text(raw.attemptId, 240),
      lockAttemptId: text(raw.lockAttemptId, 240),
      runtimeEpochOrigin: RUNTIME_ORIGINS.has(runtimeEpochOrigin) ? runtimeEpochOrigin : 'unknown',
      runtimeStartedAt: isoOrEmpty(raw.runtimeStartedAt),
      fenceRuntime: FENCE_RUNTIMES.has(fenceRuntime) ? fenceRuntime : 'unknown',
      captureRequestKnown: nullableBoolean(raw.captureRequestKnown),
      sweepComplete: nullableBoolean(raw.sweepComplete),
      sweptTabCount: nullableCount(raw.sweptTabCount),
      unresolvedTabCount: nullableCount(raw.unresolvedTabCount),
      relayInFlightCount: nullableCount(raw.relayInFlightCount),
      targets,
      targetsTruncated: rawTargets.length > MAX_TARGETS,
      pendingTabIds,
      pendingTabs,
      runnerTabsClosed: nullableCount(raw.runnerTabsClosed),
      scopedCancelSent: nullableBoolean(raw.scopedCancelSent),
      lockReleased: nullableBoolean(raw.lockReleased),
      localLockBoundToRequest: nullableBoolean(raw.localLockBoundToRequest),
      residueReleased: nullableBoolean(raw.residueReleased),
      localStopConfirmationAt: isoOrEmpty(raw.localStopConfirmationAt),
      checkedAt: isoOrEmpty(raw.checkedAt),
      durationMs: nullableCount(raw.durationMs),
      message: text(raw.message, 200),
    },
  };
}

/**
 * The server cannot inspect browser pages. This only proves that the receipt
 * is internally consistent and bound to the round that was offered; every
 * page the node reports must carry stop evidence. Legacy stop receipts
 * (`{accepted: true}`) never qualify.
 */
export function evaluateStopFenceProof(result, {checkId = '', taskId = '', requestId = ''} = {}) {
  const value = object(result);
  if (value.version !== 1) return {ok: false, reason: 'version_mismatch'};
  if (value.mode !== 'check') return {ok: false, reason: 'mode_not_check'};
  if (!text(checkId) || text(value.checkId, 100).toLowerCase() !== text(checkId, 100).toLowerCase()) {
    return {ok: false, reason: 'check_id_mismatch'};
  }
  if (!text(taskId) || text(value.taskId, 100).toLowerCase() !== text(taskId, 100).toLowerCase()) {
    return {ok: false, reason: 'task_id_mismatch'};
  }
  if (!text(requestId) || text(value.requestId, 240) !== text(requestId, 240)) {
    return {ok: false, reason: 'request_id_mismatch'};
  }
  if (value.accepted !== true) return {ok: false, reason: 'not_accepted'};
  if (value.reason !== 'previous_capture_stopped') return {ok: false, reason: 'reason_not_stopped'};
  if (value.proofMethod !== 'browser_sweep') return {ok: false, reason: 'proof_method_invalid'};
  if (value.sweepComplete !== true) return {ok: false, reason: 'sweep_incomplete'};
  if (value.unresolvedTabCount !== 0) return {ok: false, reason: 'unresolved_tabs'};
  if (value.relayInFlightCount !== 0) return {ok: false, reason: 'relay_in_flight'};
  if (value.requiresOperator !== false) return {ok: false, reason: 'requires_operator'};
  if (value.requestActive !== false) return {ok: false, reason: 'request_active'};
  if (value.localLockBoundToRequest !== false) return {ok: false, reason: 'local_lock_bound'};
  if (!Array.isArray(value.pendingTabIds) || value.pendingTabIds.length > 0) {
    return {ok: false, reason: 'pending_tabs'};
  }
  // The Extension lists pages that are not proof first, so a list cut at 40
  // entries only drops pages that were already proof.
  const targets = Array.isArray(value.targets) ? value.targets : [];
  for (const target of targets) {
    const evidence = text(object(target).evidence, 60);
    if (!STOP_FENCE_PROOF_EVIDENCE.includes(evidence)) {
      return {ok: false, reason: `evidence_not_proof:${evidence || 'missing'}`};
    }
    if (
      STOP_FENCE_CONTENT_EVIDENCE.includes(evidence) &&
      object(target).documentState !== 'current_runtime'
    ) {
      return {ok: false, reason: `content_evidence_not_current_runtime:${evidence}`};
    }
  }
  if (typeof value.sweptTabCount !== 'number' || value.sweptTabCount < targets.length) {
    return {ok: false, reason: 'swept_count_short'};
  }
  return {ok: true, reason: 'previous_capture_stopped'};
}

export function readStopFenceCheckState(value) {
  const state = object(value);
  return Object.keys(state).length > 0 ? state : null;
}

/** Why the current escalation epoch needs a person, ignoring escalatedAt. */
export function stopFenceCheckEscalationCause(state, now = Date.now()) {
  const value = object(state);
  if (value.resolvedAt) return '';
  const current = nowMs(now);
  const firstIssuedMs = toMs(value.firstIssuedAt);
  const lastResult = object(value.lastResult);
  // A result from before a manual "recheck" belongs to the previous epoch.
  const resultInEpoch = Number.isFinite(firstIssuedMs)
    ? toMs(lastResult.at) >= firstIssuedMs
    : Boolean(lastResult.at);
  if (lastResult.requiresOperator === true && resultInEpoch) return 'requires_operator';
  if (Number(value.failureCount || 0) >= STOP_FENCE_ESCALATE_AFTER_FAILURES) return 'failure_count';
  // A round a recheck started while the node could not receive it has not
  // asked the node anything yet: its epoch starts at the first offer.
  if (
    value.lastOfferedAt &&
    Number.isFinite(firstIssuedMs) &&
    current - firstIssuedMs >= STOP_FENCE_ESCALATE_AFTER_MS
  ) {
    return 'first_round_age';
  }
  return '';
}

export function stopFenceCheckEscalated(state, now = Date.now()) {
  const value = object(state);
  if (value.resolvedAt) return false;
  return Boolean(value.escalatedAt) || stopFenceCheckEscalationCause(value, now) !== '';
}

function stopFenceRowSelect(alias) {
  return `
    ${alias}.id,
    ${alias}.parent_task_id,
    COALESCE(${alias}.assigned_agent_id, ${alias}.origin_agent_id) AS agent_id,
    ${alias}.status,
    ${alias}.platform,
    ${alias}.title,
    ${alias}.error,
    ${alias}.message,
    COALESCE(
      ${alias}.finished_at,
      CASE
        WHEN ${alias}.metadata->>'handoffAt' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?$'
          THEN (${alias}.metadata->>'handoffAt')::timestamptz
      END,
      ${alias}.updated_at
    ) AS fenced_at,
    NULLIF(${alias}.metadata->>'handoffSuccessorTaskId', '') AS handoff_successor_task_id,
    COALESCE(
      NULLIF(${alias}.control_task_id, ''),
      NULLIF(${alias}.client_task_id, ''),
      ''
    ) AS request_id,
    COALESCE(
      NULLIF(latest_attempt.client_attempt_id, ''),
      NULLIF(${alias}.metadata->>'attemptIdentity', ''),
      ''
    ) AS attempt_id,
    ${alias}.metadata->'stopFenceCheck' AS stop_fence_check`;
}

const LATEST_ATTEMPT_JOIN = (alias) => `
  LEFT JOIN LATERAL (
    SELECT attempt.client_attempt_id
    FROM capture_task_attempts attempt
    WHERE attempt.task_id = ${alias}.id
      AND attempt.tenant_id = ${alias}.tenant_id
      AND attempt.client_attempt_id <> ''
    ORDER BY attempt.attempt_number DESC
    LIMIT 1
  ) latest_attempt ON true`;

const LOCAL_RELEASE_EXPIRES_AT_SQL = `CASE
  WHEN released.metadata #>> '{stopFenceCheck,localRelease,expiresAt}' ~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?$'
    THEN (released.metadata #>> '{stopFenceCheck,localRelease,expiresAt}')::timestamptz
  ELSE '-infinity'::timestamptz
END`;

const REQUEST_ID_PRESENT_SQL = (alias) =>
  `COALESCE(NULLIF(${alias}.control_task_id, ''), NULLIF(${alias}.client_task_id, ''), '') <> ''`;

// Pending local releases of node $2 in tenant $1 that the heartbeat claim can
// locate (non-empty request id); alias `released`.
const LOCAL_RELEASE_PENDING_SQL = `released.tenant_id = $1
  AND (released.assigned_agent_id = $2
    OR (released.assigned_agent_id IS NULL AND released.origin_agent_id = $2))
  AND released.status = 'superseded'
  AND released.task_type <> 'capture_orchestration'
  AND UPPER(COALESCE(released.error->>'code', '')) = 'HISTORICAL_STOP_FENCE_RECONCILED'
  AND released.metadata #>> '{stopFenceCheck,localRelease,state}' = 'pending'
  AND ${REQUEST_ID_PRESENT_SQL('released')}`;

/**
 * Rows that currently hold a node behind the fence, from the SAME SQL that
 * admission uses (so a row released by the 976a0c6 rule never appears), plus
 * optionally rows already released by an operator whose node still has to
 * drop its local execution lock.
 *
 * Every node keeps its first `perAgentLimit` rows (fences first, oldest
 * first; local releases never offered before offered ones) whatever other
 * nodes hold, so one node with many rows can never push another node's fences
 * out of a tenant-wide listing.
 */
export async function listCaptureAgentStopFences(executor, tenantId, {
  agentId = null,
  onlySuperseded = false,
  includeLocalRelease = false,
  includeExpiredLocalRelease = false,
  requireRequestId = false,
  perAgentLimit = STOP_FENCE_AGENT_LISTING_LIMIT,
  limit = agentId ? STOP_FENCE_AGENT_LISTING_LIMIT : STOP_FENCE_TENANT_LISTING_LIMIT,
} = {}) {
  const scopedAgentId = agentId ? text(agentId, 100).toLowerCase() : null;
  if (scopedAgentId && !UUID.test(scopedAgentId)) return [];
  return await executor.queryAll(`
    SELECT ranked.* FROM (
      SELECT stop_fence.*,
        ROW_NUMBER() OVER (
          PARTITION BY stop_fence.agent_id
          ORDER BY stop_fence.kind,
            -- Local releases never offered yet come first, so released rows
            -- waiting for a retry can never keep a new release from its first
            -- offer (the heartbeat claim only reads the first six).
            (stop_fence.kind = 'local_release'
              AND NULLIF(stop_fence.stop_fence_check #>> '{localRelease,firstOfferedAt}', '') IS NOT NULL),
            stop_fence.fenced_at, stop_fence.id
        ) AS agent_row_number
      FROM (
        SELECT 'fence'::text AS kind, ${stopFenceRowSelect('task')},
          NULL::timestamptz AS local_release_expires_at
        FROM capture_tasks task
        ${LATEST_ATTEMPT_JOIN('task')}
        WHERE task.tenant_id = $1
          AND ($2::uuid IS NULL OR COALESCE(task.assigned_agent_id, task.origin_agent_id) = $2::uuid)
          AND task.task_type <> 'capture_orchestration'
          AND UPPER(COALESCE(task.error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
          AND ($3::boolean = false OR task.status = 'superseded')
          AND ($8::boolean = false OR ${REQUEST_ID_PRESENT_SQL('task')})
          AND ${captureTaskUnconfirmedLocalStopSql('task')}

        UNION ALL

        SELECT 'local_release'::text AS kind, ${stopFenceRowSelect('released')},
          ${LOCAL_RELEASE_EXPIRES_AT_SQL} AS local_release_expires_at
        FROM capture_tasks released
        ${LATEST_ATTEMPT_JOIN('released')}
        WHERE $4::boolean
          AND released.tenant_id = $1
          AND ($2::uuid IS NULL OR COALESCE(released.assigned_agent_id, released.origin_agent_id) = $2::uuid)
          AND released.task_type <> 'capture_orchestration'
          AND released.status = 'superseded'
          AND UPPER(COALESCE(released.error->>'code', '')) = 'HISTORICAL_STOP_FENCE_RECONCILED'
          AND released.metadata #>> '{stopFenceCheck,localRelease,state}' = 'pending'
          AND ($8::boolean = false OR ${REQUEST_ID_PRESENT_SQL('released')})
          AND ($6::boolean OR ${LOCAL_RELEASE_EXPIRES_AT_SQL} > now())
      ) stop_fence
    ) ranked
    WHERE ranked.agent_row_number <= $7
    ORDER BY ranked.agent_row_number, ranked.kind, ranked.fenced_at, ranked.id
    LIMIT $5
  `, [
    text(tenantId, 100),
    scopedAgentId,
    onlySuperseded === true,
    includeLocalRelease === true,
    Math.min(STOP_FENCE_TENANT_LISTING_LIMIT, Math.max(1, Number(limit) || STOP_FENCE_AGENT_LISTING_LIMIT)),
    includeExpiredLocalRelease === true,
    Math.min(STOP_FENCE_AGENT_LISTING_LIMIT, Math.max(1, Number(perAgentLimit) || STOP_FENCE_AGENT_LISTING_LIMIT)),
    requireRequestId === true,
  ]);
}

/**
 * Whether a pending local release should keep new capture work away from the
 * node for now. Never once it is done, expired or unusable. Once offered: for
 * STOP_FENCE_LOCAL_RELEASE_HOLD_MS after the first offer; a failed answer is
 * retried after three minutes inside that window. Never offered yet: always on
 * the node's first full heartbeat after the confirmation, however long the
 * node was away (the claim offers it in that same heartbeat and records
 * firstOfferedAt, so the offer and new work never share a heartbeat), and
 * after that until STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS after the
 * confirmation. Bounded on purpose: a node that cannot release, or whose claim
 * keeps failing, gets work again, exactly as a 0.4.15 node would.
 *
 * `previousFullHeartbeatAt` is the node's full heartbeat before the current
 * one; unknown counts as "not seen since the confirmation".
 */
export function stopFenceLocalReleaseHoldsNewWork(localRelease, now = Date.now(), {
  previousFullHeartbeatAt = null,
} = {}) {
  const release = object(localRelease);
  if (release.state !== 'pending' || !release.checkId) return false;
  const current = nowMs(now);
  if (!(current < toMs(release.expiresAt))) return false;
  if (release.firstOfferedAt) {
    const offeredMs = toMs(release.firstOfferedAt);
    return Number.isFinite(offeredMs) && current < offeredMs + STOP_FENCE_LOCAL_RELEASE_HOLD_MS;
  }
  const requestedMs = toMs(release.requestedAt);
  if (!Number.isFinite(requestedMs)) return false;
  const heardSinceRequest =
    toMs(previousFullHeartbeatAt) > requestedMs + STOP_FENCE_LOCAL_RELEASE_SEEN_SKEW_MS;
  return !heardSinceRequest || current < requestedMs + STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS;
}

// A server-written ISO timestamp inside localRelease; NULL when absent or
// malformed (such a row never holds: see stopFenceLocalReleaseHoldsNewWork).
const LOCAL_RELEASE_TIMESTAMP_SQL = (field) => `CASE
  WHEN released.metadata #>> '{stopFenceCheck,localRelease,${field}}' ~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?$'
    THEN (released.metadata #>> '{stopFenceCheck,localRelease,${field}}')::timestamptz
END`;

const LOCAL_RELEASE_HOLD_CANDIDATE_SQL = `${LOCAL_RELEASE_PENDING_SQL}
  AND NULLIF(released.metadata #>> '{stopFenceCheck,localRelease,checkId}', '') IS NOT NULL
  AND ${LOCAL_RELEASE_EXPIRES_AT_SQL} > now()`;

/**
 * Cheap heartbeat precheck. `checkDue` is true only while there is something
 * to offer or to expire; both branches name only rows the claim can locate
 * (non-empty request id), and every pending local release turns into `done`
 * or `expired` within 24 hours, so it cannot stay true forever.
 * `holdNewWork` needs only two rows, however many releases the node has: the
 * hold predicate grows with requestedAt for a release never offered and with
 * firstOfferedAt for an offered one, so if any release holds, the latest of
 * its kind holds too. Reading "the first N rows" instead would skip offered
 * releases still inside their window once N never-offered ones stopped
 * holding.
 */
export async function readStopFenceHeartbeatWork(executor, {
  tenantId,
  agentId,
  previousFullHeartbeatAt = null,
  now = Date.now(),
}) {
  const row = await executor.queryOne(`
    SELECT
      EXISTS (
        SELECT 1 FROM capture_tasks
        WHERE tenant_id = $1
          AND (assigned_agent_id = $2 OR (assigned_agent_id IS NULL AND origin_agent_id = $2))
          AND status = 'superseded'
          AND task_type <> 'capture_orchestration'
          AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
          AND NULLIF(metadata->>'recoveryTaskId', '') IS NULL
          AND COALESCE(NULLIF(control_task_id, ''), NULLIF(client_task_id, ''), '') <> ''
      ) AS fence_pending,
      -- Expired ones count here too: the claim marks them expired.
      EXISTS (
        SELECT 1 FROM capture_tasks released
        WHERE ${LOCAL_RELEASE_PENDING_SQL}
      ) AS local_release_pending,
      COALESCE((
        SELECT jsonb_agg(holding.local_release)
        FROM (
          (
            SELECT released.metadata->'stopFenceCheck'->'localRelease' AS local_release
            FROM capture_tasks released
            WHERE ${LOCAL_RELEASE_HOLD_CANDIDATE_SQL}
              AND NULLIF(released.metadata #>> '{stopFenceCheck,localRelease,firstOfferedAt}', '') IS NULL
            ORDER BY ${LOCAL_RELEASE_TIMESTAMP_SQL('requestedAt')} DESC NULLS LAST, released.id
            LIMIT 1
          )
          UNION ALL
          (
            SELECT released.metadata->'stopFenceCheck'->'localRelease' AS local_release
            FROM capture_tasks released
            WHERE ${LOCAL_RELEASE_HOLD_CANDIDATE_SQL}
              AND NULLIF(released.metadata #>> '{stopFenceCheck,localRelease,firstOfferedAt}', '') IS NOT NULL
            ORDER BY ${LOCAL_RELEASE_TIMESTAMP_SQL('firstOfferedAt')} DESC NULLS LAST, released.id
            LIMIT 1
          )
        ) holding
      ), '[]'::jsonb) AS local_releases
  `, [text(tenantId, 100), text(agentId, 100)]);
  const localReleases = Array.isArray(row?.local_releases) ? row.local_releases : [];
  return {
    checkDue: row?.fence_pending === true || row?.local_release_pending === true,
    holdNewWork: localReleases.some(release =>
      stopFenceLocalReleaseHoldsNewWork(release, now, {previousFullHeartbeatAt})),
  };
}

/** Heartbeat precheck; true only while there is something to offer. */
export async function hasStopFenceCheckWork(executor, {tenantId, agentId}) {
  return (await readStopFenceHeartbeatWork(executor, {tenantId, agentId})).checkDue;
}

function agentAutoCheckSupported(agentRow) {
  return object(agentRow?.capabilities)[STOP_FENCE_CHECK_CAPABILITY] === true;
}

function agentOnline(agentRow, now) {
  if (typeof agentRow?.online === 'boolean') return agentRow.online;
  return agentRow?.status === 'active' && captureAgentLivenessOnline(agentRow, now);
}

function agentDispatchReady(agentRow, now) {
  if (typeof agentRow?.dispatch_ready === 'boolean') return agentRow.dispatch_ready;
  return agentRow?.status === 'active' && captureAgentFullHeartbeatOnline(agentRow, now);
}

function publicCheck(state) {
  if (!state) return null;
  const lastResult = state.lastResult ? object(state.lastResult) : null;
  return {
    check_id: text(state.checkId, 100),
    round: Number(state.round || 0),
    first_issued_at: state.firstIssuedAt || null,
    issued_at: state.issuedAt || null,
    expires_at: state.expiresAt || null,
    last_offered_at: state.lastOfferedAt || null,
    next_issue_at: state.nextIssueAt || null,
    failure_count: Number(state.failureCount || 0),
    escalated_at: state.escalatedAt || null,
    last_result: lastResult
      ? {
          at: lastResult.at || null,
          accepted: lastResult.accepted === true,
          reason: text(lastResult.reason, 80),
          retryable: lastResult.retryable !== false,
          requires_operator: lastResult.requiresOperator === true,
          pending_tab_count: Number(lastResult.pendingTabCount || 0),
          pending_tabs: Array.isArray(lastResult.pendingTabs)
            ? lastResult.pendingTabs.slice(0, MAX_PENDING_TABS)
            : [],
          message: text(lastResult.message, 200),
        }
      : null,
  };
}

function checkRoundState(state, now) {
  if (!state || !state.checkId) return 'none';
  const lastResult = object(state.lastResult);
  if (lastResult.checkId && lastResult.checkId === state.checkId && lastResult.accepted !== true) {
    return 'failed';
  }
  if (!state.lastOfferedAt) return 'none';
  return nowMs(now) < toMs(state.expiresAt) ? 'checking' : 'expired';
}

/**
 * One server-computed phase per node. The Admin and the duty evidence both
 * read this instead of guessing from error codes: the 976a0c6 rule releases
 * rows without changing their code.
 */
export function summarizeAgentStopFence(agentRow = {}, rows = [], {
  now = Date.now(),
  autoCheckEnabled = stopFenceAutoCheckEnabled(),
} = {}) {
  const current = nowMs(now);
  const fences = rows.filter(row => (row.kind || 'fence') === 'fence');
  const releases = rows.filter(row =>
    row.kind === 'local_release' &&
    !(toMs(row.local_release_expires_at) <= current)
  );
  if (fences.length === 0 && releases.length === 0) return null;
  const superseded = fences.filter(row => row.status === 'superseded');
  const actionRequired = fences.filter(row => row.status !== 'superseded');
  const manualOnly = superseded.filter(row => !text(row.request_id, 240));
  const checkable = superseded.filter(row => text(row.request_id, 240));
  const autoCheckSupported = agentAutoCheckSupported(agentRow);
  const states = checkable.map(row => readStopFenceCheckState(row.stop_fence_check));
  const escalatedStates = states.filter(state => state && stopFenceCheckEscalated(state, current));
  const roundStates = states.map(state => checkRoundState(state, current));
  let phase;
  if (fences.length === 0) phase = 'local_release_pending';
  else if (superseded.length === 0) phase = 'task_action_required';
  else if (!autoCheckSupported || manualOnly.length > 0) phase = 'manual_only';
  else if (!autoCheckEnabled) phase = 'auto_check_disabled';
  else if (!agentOnline(agentRow, current)) phase = 'offline';
  else if (!agentDispatchReady(agentRow, current)) phase = 'heartbeat_degraded';
  else if (escalatedStates.length > 0) phase = 'needs_operator';
  else if (roundStates.includes('failed')) phase = 'node_retrying';
  else if (roundStates.includes('checking')) phase = 'node_checking';
  else phase = 'awaiting_node';
  const sinceSource = fences.length > 0 ? fences : releases;
  const sinceMs = Math.min(...sinceSource.map(row => toMs(row.fenced_at)).filter(Number.isFinite));
  const escalatedAtMs = Math.min(
    ...escalatedStates.map(state => toMs(state.escalatedAt)).filter(Number.isFinite),
  );
  // After an operator confirmation the heartbeat keeps new capture work away
  // until the node dropped its old local lock (readStopFenceHeartbeatWork).
  // Evaluate the same predicate the next heartbeat will: its "previous full
  // heartbeat" is the one stored now. Only 0.4.16 nodes with the kill switch
  // off are held; the Admin must not say "does not affect dispatch" then.
  const localReleaseHoldsNewWork = autoCheckSupported && autoCheckEnabled === true &&
    releases.some(row => stopFenceLocalReleaseHoldsNewWork(
      object(readStopFenceCheckState(row.stop_fence_check)).localRelease,
      current,
      {previousFullHeartbeatAt: agentRow?.last_full_heartbeat_at ?? null},
    ));
  return {
    phase,
    task_count: fences.length,
    superseded_count: superseded.length,
    action_required_count: actionRequired.length,
    manual_only_task_count: manualOnly.length,
    local_release_pending_count: releases.length,
    local_release_holds_new_work: localReleaseHoldsNewWork,
    since: isoAt(sinceMs),
    auto_check_supported: autoCheckSupported,
    auto_check_enabled: autoCheckEnabled === true,
    escalated: escalatedStates.length > 0,
    escalated_at: isoAt(escalatedAtMs),
    // Every superseded fence of this node, not cut by the 20-row task list:
    // the confirm route refuses unless the operator sends all of them.
    superseded_task_ids: superseded.map(row => String(row.id)),
    tasks: fences.slice(0, 20).map(row => {
      const error = object(row.error);
      const autoCheckable = row.status === 'superseded' && Boolean(text(row.request_id, 240));
      // Only rows that still hold the node are listed; rows already released
      // and waiting for the node's local lock release are only counted.
      return {
        kind: 'fence',
        id: row.id,
        parent_task_id: row.parent_task_id || null,
        title: text(row.title, 240),
        platform: text(row.platform, 40),
        status: text(row.status, 40),
        fenced_at: isoAt(toMs(row.fenced_at)),
        message: text(error.message || row.message, 300),
        handoff_successor_task_id: row.handoff_successor_task_id || null,
        auto_checkable: autoCheckable,
        check: autoCheckable ? publicCheck(readStopFenceCheckState(row.stop_fence_check)) : null,
      };
    }),
  };
}

/** Group a tenant-wide fence listing and attach `stop_fence` to each agent. */
export function attachAgentStopFences(agents = [], rows = [], options = {}) {
  const byAgent = new Map();
  for (const row of rows) {
    const agentId = text(row.agent_id, 100);
    if (!agentId) continue;
    if (!byAgent.has(agentId)) byAgent.set(agentId, []);
    byAgent.get(agentId).push(row);
  }
  return agents.map(agent => ({
    ...agent,
    stop_fence: summarizeAgentStopFence(agent, byAgent.get(text(agent.id, 100)) || [], options),
  }));
}

async function appendStopFenceEvent(tx, {
  tenantId,
  taskId,
  agentId = null,
  eventType,
  actorType = 'system',
  actorId = '',
  actorName = '',
  status = 'superseded',
  message = '',
  payload = {},
}) {
  await tx.execute(`
    INSERT INTO capture_task_events (
      tenant_id, task_id, agent_id, event_type,
      actor_type, actor_id, actor_name, status, message, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
  `, [
    tenantId,
    taskId,
    agentId,
    eventType,
    actorType,
    text(actorId, 240),
    text(actorName, 240),
    text(status, 80),
    text(message, 2000),
    JSON.stringify(object(payload)),
  ]);
}

async function writeStopFenceCheckState(tx, {tenantId, taskId, state}) {
  // jsonb_set only: status, updated_at and every other metadata key stay as
  // they were, so no wake, slot or user-stop trigger fires.
  await tx.execute(`
    UPDATE capture_tasks
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{stopFenceCheck}', $3::jsonb)
    WHERE tenant_id = $1 AND id = $2
  `, [tenantId, taskId, JSON.stringify(state)]);
}

function newCheckRound(previous, now, {
  requestedBy = 'system',
  requestedByName = '',
  restartEpoch = false,
  offered = true,
} = {}) {
  const at = new Date(now).toISOString();
  const prior = object(previous);
  const firstRound = !previous || prior.version !== 1 || !prior.checkId;
  return {
    version: 1,
    checkId: crypto.randomUUID(),
    round: firstRound ? 1 : Number(prior.round || 0) + 1,
    firstIssuedAt: firstRound || restartEpoch ? at : (prior.firstIssuedAt || at),
    issuedAt: at,
    expiresAt: new Date(now + STOP_FENCE_CHECK_TTL_MS).toISOString(),
    requestedBy,
    requestedByName: text(requestedByName, 240),
    lastOfferedAt: offered ? at : null,
    offerCount: offered ? 1 : 0,
    failureCount: firstRound || restartEpoch ? 0 : Number(prior.failureCount || 0),
    nextIssueAt: null,
    escalatedAt: firstRound || restartEpoch ? null : (prior.escalatedAt || null),
    lastResult: firstRound ? null : (prior.lastResult || null),
    resolvedAt: null,
    resolution: null,
    localRelease: null,
  };
}

async function escalateIfNeeded(tx, {tenantId, taskId, agentId, state, now, actorName = ''}) {
  if (!state || state.escalatedAt || state.resolvedAt) return state;
  const cause = stopFenceCheckEscalationCause(state, now);
  if (!cause) return state;
  const next = {...state, escalatedAt: new Date(now).toISOString()};
  const lastResult = object(state.lastResult);
  const reasonText = lastResult.reason
    ? stopFenceReasonLabel(lastResult.reason)
    : '首轮核对下发已满 30 分钟仍未放行';
  await appendStopFenceEvent(tx, {
    tenantId,
    taskId,
    agentId,
    eventType: 'stop_fence_check_escalated',
    actorType: 'system',
    actorName: actorName || '云端调度器',
    message: `节点自动核对未能完成，需要人工处理：${reasonText}`,
    payload: {
      checkId: state.checkId,
      cause,
      failureCount: Number(state.failureCount || 0),
      reason: text(lastResult.reason, 80),
    },
  });
  return next;
}

/**
 * Record a round that did not prove the stop. The fence stays; the same
 * round is retried with a fresh checkId three minutes later.
 */
export async function recordStopFenceCheckResult(tx, {
  task,
  agent,
  state,
  result,
  now = Date.now(),
}) {
  const current = nowMs(now);
  const tenantId = text(task.tenant_id || agent?.tenant_id, 100);
  const previous = object(state);
  const previousResult = object(previous.lastResult);
  const pendingTabs = (Array.isArray(result.pendingTabs) ? result.pendingTabs : [])
    .slice(0, MAX_PENDING_TABS)
    .map(tab => ({
      platform: text(object(tab).platform, 40),
      evidence: text(object(tab).evidence, 60),
      title: text(object(tab).title, 40),
    }));
  const pendingTabCount = Math.max(
    pendingTabs.length,
    Array.isArray(result.pendingTabIds) ? result.pendingTabIds.length : 0,
    Number.isInteger(result.pendingTabCount) ? result.pendingTabCount : 0,
  );
  const reason = text(result.reason, 80) || 'proof_rejected';
  const lastResult = {
    checkId: text(result.checkId || previous.checkId, 100),
    at: new Date(current).toISOString(),
    accepted: false,
    reason,
    retryable: result.retryable !== false,
    requiresOperator: result.requiresOperator === true,
    pendingTabCount,
    pendingTabs,
    message: text(result.message, 200),
  };
  // A page that left the platform (or sits on a Chrome error page) is proven
  // only after the node watched it for 10 continuous minutes, so rounds 1-3
  // always report `off_platform_observing` before the proof round. That is the
  // protocol working, not a failure: counting it would escalate to "needs
  // operator" (and a high alert) minutes before the node releases the fence
  // itself. The first_round_age rule still escalates a page that stays in
  // observation for 30 minutes.
  const countsAsFailure = !(
    reason === 'off_platform_observing' &&
    lastResult.retryable &&
    !lastResult.requiresOperator
  );
  let next = {
    ...previous,
    version: 1,
    failureCount: Number(previous.failureCount || 0) + (countsAsFailure ? 1 : 0),
    nextIssueAt: new Date(current + STOP_FENCE_CHECK_RETRY_MS).toISOString(),
    lastResult,
  };
  // One event per reason per escalation epoch: a result from before a manual
  // recheck belongs to the previous epoch (same rule as the escalation).
  const firstIssuedMs = toMs(previous.firstIssuedAt);
  const previousResultInEpoch = Boolean(previousResult.reason) && (
    Number.isFinite(firstIssuedMs)
      ? toMs(previousResult.at) >= firstIssuedMs
      : Number(previous.failureCount || 0) > 0
  );
  if (!previousResultInEpoch || previousResult.reason !== reason) {
    await appendStopFenceEvent(tx, {
      tenantId,
      taskId: task.id,
      agentId: agent?.id || null,
      eventType: 'stop_fence_check_failed',
      actorType: reason === 'check_timeout' ? 'system' : 'capture_agent',
      actorId: reason === 'check_timeout' ? '' : (agent?.id || ''),
      actorName: agent?.display_name || agent?.client_label || '',
      message: `节点核对未通过：${stopFenceReasonLabel(reason)}`,
      payload: {
        checkId: lastResult.checkId,
        reason,
        retryable: lastResult.retryable,
        requiresOperator: lastResult.requiresOperator,
        pendingTabCount,
      },
    });
  }
  next = await escalateIfNeeded(tx, {
    tenantId,
    taskId: task.id,
    agentId: agent?.id || null,
    state: next,
    now: current,
  });
  await writeStopFenceCheckState(tx, {tenantId, taskId: task.id, state: next});
  return next;
}

async function enqueueStopFenceReleaseWakeup(tx, {tenantId, agentId}) {
  // Changing only the error code does not fire 074's slot-release trigger.
  // Mirror that trigger (074:720-736) so waiting recovery intents re-plan.
  await tx.execute(`
    SELECT enqueue_ops_control_wakeup(
      $1::uuid,
      'capture_recovery_agent_slot_released',
      'capture_recovery_agent_slot',
      $2::text,
      'capture-recovery-agent-slot:' || $1::text || ':' || $2::text,
      now(),
      jsonb_build_object('agentId', $2::text, 'trigger', 'stop_fence_reconciled'),
      true
    )
    WHERE EXISTS (
      SELECT 1 FROM capture_recovery_intents
      WHERE tenant_id = $1::uuid
        AND status = 'waiting_agent'
        AND window_ends_at > now()
    )
  `, [tenantId, agentId]);
}

const RECONCILED_EVENT_MESSAGES = Object.freeze({
  agent_confirmed: () => '节点已确认旧采集页面已停止，解除停止保护',
  operator_confirmed: actorName => `${actorName || '管理员'} 人工确认旧采集页面已停止，解除停止保护`,
  completed: () => '该节点此后已在同平台完成采集，按既有规则确认旧页面已停止',
});

/**
 * Release fenced rows in the 2026-09-24/25 manual format. Only superseded
 * rows that still carry the fence code and belong to this node change; the
 * status, updated_at, work items, attempts and parent stay untouched.
 */
export async function reconcileCaptureTaskStopFences(tx, {
  tenantId,
  agentId,
  taskIds = [],
  proofStatus,
  reason,
  requestedBy = '',
  actorType = 'system',
  actorId = '',
  actorName = '',
  checkId = '',
  evidence = null,
  note = '',
  requestLocalRelease = false,
  now = Date.now(),
}) {
  if (!['agent_confirmed', 'operator_confirmed', 'completed'].includes(proofStatus)) {
    throw new Error('invalid_stop_fence_proof_status');
  }
  const ids = uniqueUuids(taskIds);
  const scopedTenantId = text(tenantId, 100);
  const scopedAgentId = text(agentId, 100).toLowerCase();
  if (ids.length === 0 || !scopedTenantId || !UUID.test(scopedAgentId)) return [];
  const current = nowMs(now);
  const at = new Date(current).toISOString();
  const rows = await tx.queryAll(`
    SELECT id, error, metadata, client_task_id, control_task_id
    FROM capture_tasks
    WHERE tenant_id = $1
      AND id = ANY($2::uuid[])
      AND COALESCE(assigned_agent_id, origin_agent_id) = $3
      AND status = 'superseded'
      AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
    ORDER BY id
    FOR UPDATE
  `, [scopedTenantId, ids, scopedAgentId]);
  const released = [];
  for (const row of rows) {
    const originalError = object(row.error);
    const requestId = text(row.control_task_id, 240) || text(row.client_task_id, 240);
    const reconciliation = {
      at,
      reason: text(reason, 120),
      proofStatus,
      requestedBy: text(requestedBy, 240),
      originalError,
      agentId: scopedAgentId,
      checkId: text(checkId, 100),
      requestId,
      evidence: evidence || null,
      note: text(note, 200),
      actorId: text(actorId, 240),
    };
    const previousCheck = readStopFenceCheckState(object(row.metadata).stopFenceCheck) || {};
    const check = {
      ...previousCheck,
      resolvedAt: at,
      resolution: proofStatus,
      // Only a row the node can locate by request id can be released locally;
      // a release it could never be offered would stay pending forever.
      ...(requestLocalRelease && requestId
        ? {localRelease: {
            checkId: crypto.randomUUID(),
            state: 'pending',
            requestedAt: at,
            expiresAt: new Date(current + STOP_FENCE_LOCAL_RELEASE_TTL_MS).toISOString(),
            lastOfferedAt: null,
            nextIssueAt: null,
            lastResult: null,
          }}
        : {}),
    };
    const updated = await tx.queryOne(`
      UPDATE capture_tasks
      SET error = COALESCE(error, '{}'::jsonb) || jsonb_build_object(
            'code', 'HISTORICAL_STOP_FENCE_RECONCILED',
            'originalCode', 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'),
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb) ||
            jsonb_build_object('historicalStopFenceReconciliation', $3::jsonb),
          '{stopFenceCheck}',
          $4::jsonb)
      WHERE tenant_id = $1 AND id = $2
        AND status = 'superseded'
        AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
      RETURNING id
    `, [scopedTenantId, row.id, JSON.stringify(reconciliation), JSON.stringify(check)]);
    if (!updated) continue;
    released.push(row.id);
    await appendStopFenceEvent(tx, {
      tenantId: scopedTenantId,
      taskId: row.id,
      agentId: scopedAgentId,
      eventType: 'historical_stop_fence_reconciled',
      actorType,
      actorId,
      actorName,
      status: 'superseded',
      message: RECONCILED_EVENT_MESSAGES[proofStatus](actorName),
      payload: {proofStatus, reason: text(reason, 120), originalError, checkId: text(checkId, 100)},
    });
  }
  // 976a0c6 rows were never counted by admission; nothing new to wake.
  if (released.length > 0 && proofStatus !== 'completed') {
    await enqueueStopFenceReleaseWakeup(tx, {tenantId: scopedTenantId, agentId: scopedAgentId});
  }
  return released;
}

function checkOffer(row, state) {
  return {
    version: 1,
    mode: 'check',
    checkId: state.checkId,
    taskId: row.id,
    requestId: text(row.request_id, 240),
    attemptId: text(row.attempt_id, 240),
    platform: text(row.platform, 40),
    fencedAt: isoAt(toMs(row.fenced_at)),
    expiresAt: state.expiresAt,
  };
}

function releaseOffer(row, localRelease) {
  return {
    version: 1,
    mode: 'release_only',
    checkId: localRelease.checkId,
    taskId: row.id,
    requestId: text(row.request_id, 240),
    attemptId: text(row.attempt_id, 240),
    platform: text(row.platform, 40),
    fencedAt: isoAt(toMs(row.fenced_at)),
    expiresAt: localRelease.expiresAt,
  };
}

/**
 * Heartbeat delivery. Runs in its own short transaction after the heartbeat
 * committed; callers must treat any failure as "nothing offered".
 */
export async function claimStopFenceCheckOffers(tx, {
  agent,
  lockAgentSession,
  now = Date.now(),
} = {}) {
  if (typeof lockAgentSession !== 'function') throw new Error('stop_fence_agent_lock_required');
  const currentAgent = await lockAgentSession(tx, agent);
  if (!currentAgent) return [];
  const current = nowMs(now);
  const tenantId = text(agent.tenant_id, 100);
  const agentId = text(agent.id, 100).toLowerCase();
  const actorName = text(agent.display_name || agent.client_label, 240);

  // Rows the 976a0c6 rule already released: admission ignores them, so only
  // write the fact down once. Afterwards the precheck no longer matches them.
  const implicit = await tx.queryAll(`
    SELECT task.id
    FROM capture_tasks task
    WHERE task.tenant_id = $1
      AND COALESCE(task.assigned_agent_id, task.origin_agent_id) = $2
      AND task.task_type <> 'capture_orchestration'
      AND task.status = 'superseded'
      AND UPPER(COALESCE(task.error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
      AND NULLIF(task.metadata->>'recoveryTaskId', '') IS NULL
      AND NOT ${captureTaskUnconfirmedLocalStopSql('task')}
    ORDER BY task.id
    LIMIT 20
  `, [tenantId, agentId]);
  if (implicit.length > 0) {
    await reconcileCaptureTaskStopFences(tx, {
      tenantId,
      agentId,
      taskIds: implicit.map(row => row.id),
      proofStatus: 'completed',
      reason: 'admission_rule_976a0c6',
      requestedBy: 'system',
      actorType: 'system',
      actorName: '云端调度器',
      now: current,
    });
  }

  // Rows the node cannot locate (empty request id) are filtered in SQL, so
  // they never use up the six-row window; the precheck ignores them too.
  const rows = await listCaptureAgentStopFences(tx, tenantId, {
    agentId,
    onlySuperseded: true,
    includeLocalRelease: true,
    includeExpiredLocalRelease: true,
    requireRequestId: true,
    limit: 6,
  });
  if (rows.length === 0) return [];
  const locked = await tx.queryAll(`
    SELECT id, status, error, metadata
    FROM capture_tasks
    WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'superseded'
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  `, [tenantId, rows.map(row => row.id)]);
  const lockedById = new Map(locked.map(row => [String(row.id), row]));
  const offers = [];
  for (const row of rows) {
    if (offers.length >= STOP_FENCE_OFFER_LIMIT) break;
    const lockedRow = lockedById.get(String(row.id));
    if (!lockedRow) continue;
    const code = text(object(lockedRow.error).code, 100).toUpperCase();
    const state = readStopFenceCheckState(object(lockedRow.metadata).stopFenceCheck);
    const at = new Date(current).toISOString();

    if (row.kind === 'local_release') {
      if (code !== STOP_FENCE_RECONCILED_CODE) continue;
      const localRelease = object(state?.localRelease);
      if (localRelease.state !== 'pending') continue;
      // Expired, or unusable without a checkId: close it so that the
      // precheck stops matching it.
      if (!localRelease.checkId || !(current < toMs(localRelease.expiresAt))) {
        await writeStopFenceCheckState(tx, {
          tenantId,
          taskId: row.id,
          state: {...state, localRelease: {...localRelease, state: 'expired', expiredAt: at}},
        });
        continue;
      }
      if (current < toMs(localRelease.nextIssueAt)) continue;
      const lastOfferedMs = toMs(localRelease.lastOfferedAt);
      if (!(current - lastOfferedMs < STOP_FENCE_OFFER_WRITE_THROTTLE_MS)) {
        await writeStopFenceCheckState(tx, {
          tenantId,
          taskId: row.id,
          state: {...state, localRelease: {
            ...localRelease,
            // The new-work hold (stopFenceLocalReleaseHoldsNewWork) runs
            // from the first offer, written in the same transaction that
            // returns it; until then the release holds outright.
            firstOfferedAt: localRelease.firstOfferedAt || at,
            lastOfferedAt: at,
            offerCount: Number(localRelease.offerCount || 0) + 1,
          }},
        });
      }
      offers.push(releaseOffer(row, localRelease));
      continue;
    }

    if (code !== STOP_FENCE_CODE) continue;
    let next = null;
    let offer = false;
    const lastResult = object(state?.lastResult);
    if (!state || state.version !== 1 || !state.checkId) {
      next = newCheckRound(null, current);
      offer = true;
      await appendStopFenceEvent(tx, {
        tenantId,
        taskId: row.id,
        agentId,
        eventType: 'stop_fence_check_requested',
        actorType: 'system',
        actorName: '云端调度器',
        message: '已请求原节点核对并停止旧采集页面',
        payload: {checkId: next.checkId, round: next.round, requestId: text(row.request_id, 240)},
      });
    } else if (lastResult.checkId && lastResult.checkId === state.checkId) {
      // The current round was answered (and failed): wait, then a fresh id.
      if (current < toMs(state.nextIssueAt)) {
        offer = false;
      } else {
        next = newCheckRound(state, current);
        offer = true;
      }
    } else if (!state.lastOfferedAt) {
      // A round a recheck started while the node could not receive it (offline
      // or degraded heartbeats). It was never asked, so it cannot have timed
      // out: its clock and its escalation epoch start now.
      next = {
        ...state,
        issuedAt: at,
        expiresAt: new Date(current + STOP_FENCE_CHECK_TTL_MS).toISOString(),
        firstIssuedAt: !state.firstIssuedAt || state.firstIssuedAt === state.issuedAt
          ? at
          : state.firstIssuedAt,
        lastOfferedAt: at,
        offerCount: 1,
      };
      offer = true;
    } else if (!(current < toMs(state.expiresAt))) {
      // Expired without an answer: count it as one failed round.
      next = await recordStopFenceCheckResult(tx, {
        task: {id: row.id, tenant_id: tenantId},
        agent: {...agent, id: agentId, display_name: actorName},
        state,
        result: {
          checkId: state.checkId,
          reason: 'check_timeout',
          retryable: true,
          requiresOperator: false,
          message: '节点未在有效期内回报核对结果',
        },
        now: current,
      });
      continue;
    } else {
      offer = true;
      const lastOfferedMs = toMs(state.lastOfferedAt);
      if (!(current - lastOfferedMs < STOP_FENCE_OFFER_WRITE_THROTTLE_MS)) {
        next = {
          ...state,
          lastOfferedAt: at,
          offerCount: Number(state.offerCount || 0) + 1,
        };
      }
    }
    const escalated = await escalateIfNeeded(tx, {
      tenantId,
      taskId: row.id,
      agentId,
      state: next || state,
      now: current,
    });
    if (escalated !== (next || state)) next = escalated;
    if (next) await writeStopFenceCheckState(tx, {tenantId, taskId: row.id, state: next});
    if (offer) offers.push(checkOffer(row, next || state));
  }
  return offers;
}

function stopFenceEvidenceSubset(result) {
  return {
    proofMethod: result.proofMethod,
    runtimeEpochOrigin: result.runtimeEpochOrigin,
    runtimeStartedAt: result.runtimeStartedAt,
    fenceRuntime: result.fenceRuntime,
    sweptTabCount: result.sweptTabCount,
    targets: result.targets,
    lockReleased: result.lockReleased,
    residueReleased: result.residueReleased,
    checkedAt: result.checkedAt,
  };
}

function receipt(status, body) {
  return {status, body};
}

const STALE_RECEIPT = receipt(409, {
  ok: false,
  error: 'stop_fence_check_stale',
  message: '核对请求已过期或已被替换，或该任务已不在停止保护中',
});

async function completeLocalReleaseReceipt(tx, {task, agent, state, checkId, requestId, rawResult, now}) {
  const localRelease = object(state?.localRelease);
  if (!localRelease.checkId || localRelease.checkId !== checkId) return STALE_RECEIPT;
  if (localRelease.state === 'done') {
    return receipt(200, {ok: true, localRelease: 'done', idempotent: true, message: '节点已释放本机执行锁'});
  }
  if (localRelease.state !== 'pending') return STALE_RECEIPT;
  const normalized = normalizeStopFenceCheckResult(rawResult);
  const at = new Date(now).toISOString();
  if (!normalized.ok) {
    await writeStopFenceCheckState(tx, {
      tenantId: task.tenant_id,
      taskId: task.id,
      state: {...state, localRelease: {
        ...localRelease,
        nextIssueAt: new Date(now + STOP_FENCE_CHECK_RETRY_MS).toISOString(),
        lastResult: {checkId, at, accepted: false, reason: 'invalid_result', message: normalized.reason},
      }},
    });
    return receipt(400, {
      ok: false,
      error: 'invalid_stop_fence_check_result',
      message: '节点回执格式不正确，请升级扩展或人工确认',
    });
  }
  const result = normalized.result;
  const accepted = result.accepted === true &&
    result.mode === 'release_only' &&
    result.checkId === checkId &&
    result.taskId === String(task.id).toLowerCase() &&
    result.requestId === requestId;
  const lastResult = {
    checkId,
    at,
    accepted,
    reason: result.reason,
    retryable: result.retryable !== false,
    runnerTabsClosed: result.runnerTabsClosed,
    lockReleased: result.lockReleased,
    localLockBoundToRequest: result.localLockBoundToRequest,
    residueReleased: result.residueReleased,
    message: result.message,
  };
  const nextRelease = accepted
    ? {...localRelease, state: 'done', doneAt: at, nextIssueAt: null, lastResult}
    : {
        ...localRelease,
        nextIssueAt: new Date(now + STOP_FENCE_CHECK_RETRY_MS).toISOString(),
        lastResult,
      };
  await writeStopFenceCheckState(tx, {
    tenantId: task.tenant_id,
    taskId: task.id,
    state: {...state, localRelease: nextRelease},
  });
  if (accepted) {
    await appendStopFenceEvent(tx, {
      tenantId: task.tenant_id,
      taskId: task.id,
      agentId: agent.id,
      eventType: 'stop_fence_local_release_done',
      actorType: 'capture_agent',
      actorId: agent.id,
      actorName: agent.display_name || agent.client_label || '',
      message: '节点已按人工确认释放本机执行锁与采集辅助',
      payload: {
        checkId,
        reason: result.reason,
        lockReleased: result.lockReleased,
        residueReleased: result.residueReleased,
        runnerTabsClosed: result.runnerTabsClosed,
      },
    });
  }
  return receipt(200, {
    ok: true,
    localRelease: accepted ? 'done' : 'pending',
    ...(accepted ? {} : {nextIssueAt: nextRelease.nextIssueAt}),
    message: accepted ? '节点已释放本机执行锁' : stopFenceReasonLabel(result.reason),
  });
}

/**
 * POST /agent/stop-fence-checks/:checkId/complete, inside one transaction.
 * Returns {status, body}; the route only serializes it.
 */
export async function completeStopFenceCheckReceipt(tx, {
  agent,
  lockAgentSession,
  checkId,
  taskId,
  requestId,
  rawResult,
  now = Date.now(),
}) {
  if (typeof lockAgentSession !== 'function') throw new Error('stop_fence_agent_lock_required');
  const current = nowMs(now);
  const scopedCheckId = text(checkId, 100).toLowerCase();
  const scopedTaskId = text(taskId, 100).toLowerCase();
  if (!UUID.test(scopedCheckId) || !UUID.test(scopedTaskId)) {
    return receipt(400, {
      ok: false,
      error: 'invalid_stop_fence_check_result',
      message: '核对回执标识无效',
    });
  }
  const currentAgent = await lockAgentSession(tx, agent);
  if (!currentAgent) {
    return receipt(403, {
      ok: false,
      error: 'agent_inactive',
      message: '采集节点已撤销或授权已变更，请重新验证扩展',
    });
  }
  const tenantId = text(agent.tenant_id, 100);
  const agentId = text(agent.id, 100).toLowerCase();
  const task = await tx.queryOne(`
    SELECT id, tenant_id, status, error, metadata, client_task_id, control_task_id,
      COALESCE(assigned_agent_id, origin_agent_id) AS owner_agent_id
    FROM capture_tasks
    WHERE tenant_id = $1 AND id = $2
    FOR UPDATE
  `, [tenantId, scopedTaskId]);
  if (!task || text(task.owner_agent_id, 100).toLowerCase() !== agentId) {
    return receipt(404, {
      ok: false,
      error: 'stop_fence_check_not_found',
      message: '核对任务不存在或不属于该节点',
    });
  }
  const expectedRequestId = text(task.control_task_id, 240) || text(task.client_task_id, 240);
  if (text(requestId, 240) !== expectedRequestId) {
    return receipt(409, {
      ok: false,
      error: 'stop_fence_check_request_mismatch',
      message: '核对回执的本地任务 ID 与云端任务不一致',
      expectedRequestId,
    });
  }
  const state = readStopFenceCheckState(object(task.metadata).stopFenceCheck);
  const agentForEvents = {...agent, id: agentId};
  if (object(rawResult).mode === 'release_only') {
    return completeLocalReleaseReceipt(tx, {
      task,
      agent: agentForEvents,
      state,
      checkId: scopedCheckId,
      requestId: expectedRequestId,
      rawResult,
      now: current,
    });
  }
  const code = text(object(task.error).code, 100).toUpperCase();
  if (code === STOP_FENCE_RECONCILED_CODE) {
    return receipt(200, {
      ok: true,
      released: true,
      idempotent: true,
      message: '旧采集页面此前已确认停止',
    });
  }
  if (task.status !== 'superseded' || code !== STOP_FENCE_CODE) return STALE_RECEIPT;
  if (!state || state.checkId !== scopedCheckId) return STALE_RECEIPT;
  if (!(current <= toMs(state.expiresAt) + STOP_FENCE_RECEIPT_GRACE_MS)) return STALE_RECEIPT;
  const alreadyRecorded = object(state.lastResult).checkId === scopedCheckId;

  const normalized = normalizeStopFenceCheckResult(rawResult);
  if (!normalized.ok) {
    if (!alreadyRecorded) {
      await recordStopFenceCheckResult(tx, {
        task,
        agent: agentForEvents,
        state,
        result: {
          checkId: scopedCheckId,
          reason: 'invalid_result',
          retryable: true,
          requiresOperator: false,
          message: normalized.reason,
        },
        now: current,
      });
    }
    return receipt(400, {
      ok: false,
      error: 'invalid_stop_fence_check_result',
      message: '节点回执格式不正确，请升级扩展或人工确认',
      reason: normalized.reason,
    });
  }
  const result = normalized.result;
  const verdict = evaluateStopFenceProof(result, {
    checkId: scopedCheckId,
    taskId: scopedTaskId,
    requestId: expectedRequestId,
  });
  if (verdict.ok) {
    const released = await reconcileCaptureTaskStopFences(tx, {
      tenantId,
      agentId,
      taskIds: [scopedTaskId],
      proofStatus: 'agent_confirmed',
      reason: 'agent_confirmed_previous_capture_stopped',
      requestedBy: agent.display_name || agent.client_label || agentId,
      actorType: 'capture_agent',
      actorId: agentId,
      actorName: agent.display_name || agent.client_label || '',
      checkId: scopedCheckId,
      evidence: stopFenceEvidenceSubset(result),
      now: current,
    });
    return receipt(200, {
      ok: true,
      released: released.length > 0,
      message: '节点已确认旧采集页面已停止，已恢复接单',
    });
  }
  if (alreadyRecorded) {
    // A retried delivery of a round that was already recorded must not count
    // the same failure twice.
    return receipt(200, {
      ok: true,
      released: false,
      idempotent: true,
      nextIssueAt: state.nextIssueAt || null,
      message: stopFenceReasonLabel(object(state.lastResult).reason),
    });
  }
  const failure = result.accepted === true
    ? {
        checkId: scopedCheckId,
        reason: 'proof_rejected',
        retryable: true,
        requiresOperator: false,
        pendingTabs: result.pendingTabs,
        pendingTabIds: result.pendingTabIds,
        message: verdict.reason,
      }
    : {
        checkId: scopedCheckId,
        reason: result.reason,
        retryable: result.retryable !== false,
        requiresOperator: result.requiresOperator === true,
        pendingTabs: result.pendingTabs,
        pendingTabIds: result.pendingTabIds,
        message: result.message,
      };
  const next = await recordStopFenceCheckResult(tx, {
    task,
    agent: agentForEvents,
    state,
    result: failure,
    now: current,
  });
  return receipt(200, {
    ok: true,
    released: false,
    nextIssueAt: next.nextIssueAt,
    message: stopFenceReasonLabel(failure.reason),
  });
}

/**
 * Admin "让节点重新核对": a fresh checkId and a fresh escalation epoch for
 * every superseded fenced row of this node that the node can locate. The
 * round is not offered here; its expiry and epoch restart at the first
 * heartbeat that actually offers it (claimStopFenceCheckOffers).
 */
export async function rotateStopFenceChecks(tx, {
  tenantId,
  agentId,
  taskIds = [],
  requestedByName = '',
  actorId = '',
  now = Date.now(),
}) {
  const ids = uniqueUuids(taskIds);
  if (ids.length === 0) return [];
  const current = nowMs(now);
  const rows = await tx.queryAll(`
    SELECT id, metadata,
      COALESCE(NULLIF(control_task_id, ''), NULLIF(client_task_id, ''), '') AS request_id
    FROM capture_tasks
    WHERE tenant_id = $1
      AND id = ANY($2::uuid[])
      AND COALESCE(assigned_agent_id, origin_agent_id) = $3
      AND status = 'superseded'
      AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
    ORDER BY id
    FOR UPDATE
  `, [text(tenantId, 100), ids, text(agentId, 100).toLowerCase()]);
  const rotated = [];
  for (const row of rows) {
    if (!text(row.request_id, 240)) continue;
    const previous = readStopFenceCheckState(object(row.metadata).stopFenceCheck);
    const next = newCheckRound(previous, current, {
      requestedBy: 'user',
      requestedByName,
      restartEpoch: true,
      offered: false,
    });
    await writeStopFenceCheckState(tx, {tenantId, taskId: row.id, state: next});
    await appendStopFenceEvent(tx, {
      tenantId,
      taskId: row.id,
      agentId,
      eventType: 'stop_fence_check_requested',
      actorType: 'user',
      actorId,
      actorName: requestedByName,
      message: `${requestedByName || '管理员'} 已请求原节点重新核对旧采集页面`,
      payload: {checkId: next.checkId, round: next.round, requestId: row.request_id},
    });
    rotated.push(row.id);
  }
  return rotated;
}
