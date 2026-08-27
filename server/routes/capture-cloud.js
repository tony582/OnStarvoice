import crypto from 'crypto';
import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import {
  requireCaptureAgent,
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import {
  CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
  captureAgentOnline,
  bindCloudTaskSnapshotHealthToAttempt,
  cloudTaskAttemptIdentityAcceptsSnapshot,
  findCaptureAgentExecutionSlotBlocker,
  isCloudTaskActive,
  lockCaptureAgentExecutionSlot,
  tryLockCaptureAgentExecutionSlot,
  normalizeCaptureAgentPlatforms,
  normalizeCloudTaskSnapshot,
  normalizeRemoteTaskInput,
  sanitizeCloudStructuredObject,
  sanitizeCloudText,
} from '../services/capture-cloud.js';
import {
  aggregateParentTaskItems,
  checkpointEntryToItemStatus,
  hashOrchestrationRequest,
} from '../services/capture-orchestration.js';
import {
  enqueueCaptureSafetyAttentionNotification,
} from '../services/capture-attention-notifier.js';
import {getTenantAiAdmissionSnapshot} from '../services/ai-admission.js';
import {
  processSocialAccountHeartbeat,
} from '../services/social-account-usage.js';
import {
  CAPTURE_PLATFORM_SAFETY_CODES,
} from '../services/capture-health-schema.js';
import {
  CAPTURE_SAFETY_HANDOFF_SEARCH_CODES,
  evaluateCaptureSafetyHandoff,
} from '../services/capture-safety-handoff-policy.js';
import {
  selectCaptureLocalClosureEvidence,
  verifyCaptureLocalClosureProof,
} from '../services/capture-local-closure-proof.js';

const router = Router();
const MAX_HEARTBEAT_TASKS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RECOVERABLE_STATUSES = new Set([
  'interrupted',
  'needs_action',
  'failed',
  'completed_with_failures',
]);
const REMOTELY_STOPPABLE_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'resume_requested',
  'needs_action',
  'failed',
  'completed_with_failures',
]);
const STOP_FINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'canceled',
  'skipped',
  'superseded',
]);
const DISMISSIBLE_ATTENTION_STATUSES = new Set([
  'failed',
  'completed_with_failures',
]);
const CROSS_DEVICE_RETRY_SOURCE_STATUSES = new Set([
  'needs_action',
  'failed',
  'completed_with_failures',
]);
const AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES = new Set([
  'pending',
  'running',
]);
const CROSS_DEVICE_RETRY_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'retryable',
  'needs_action',
  'failed',
]);
const CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'superseded',
  'needs_action',
]);
const AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT = 3;
const DUTY_RECOVERY_TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const DUTY_RECOVERY_SETTING_KEYS = Object.freeze([
  'ops_control_recovery_enabled',
  'ops_control_recovery_mode',
]);
const ELASTIC_QUEUE_CREATE_ACK_TIMEOUT_MS = 3 * 60 * 1000;
const ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN = 10;
const ELASTIC_TECHNICAL_AGENT_HOLD_MS = 2 * 60 * 1000;
const ELASTIC_STALE_TASK_AGENT_HOLD_MS = 10 * 60 * 1000;
const ELASTIC_AGENT_CAPACITY_HOLD_MS = 30 * 60 * 1000;
const ELASTIC_SAFETY_AGENT_HOLD_MS = 30 * 60 * 1000;
const ELASTIC_SAME_ITEM_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const ELASTIC_DISPATCH_RECHECK_MS = 60 * 1000;
const ELASTIC_AUTOMATIC_SAFETY_HANDOFF_ATTEMPTS = 1;
const ELASTIC_TECHNICAL_HANDOFF_LIMIT = 3;
const ELASTIC_BOOTSTRAP_STAGGER_BUCKETS = 4;
const ELASTIC_BOOTSTRAP_STAGGER_GAP_MS = 6 * 1000;
const ELASTIC_BOOTSTRAP_CONGESTION_WINDOW_MS = 2 * 60 * 1000;
const ELASTIC_BOOTSTRAP_CONGESTION_MAX_DELAY_MS = 30 * 1000;
const ELASTIC_BOOTSTRAP_MAX_DELAY_MS = 45 * 1000;
const CROSS_DEVICE_RETRY_SAFETY_CODES = new Set(
  CAPTURE_PLATFORM_SAFETY_CODES,
);
const AUTOMATIC_SEARCH_SAFETY_HANDOFF_CODES = new Set(
  CAPTURE_SAFETY_HANDOFF_SEARCH_CODES,
);
const ELASTIC_AGENT_CAPACITY_CODES = new Set([
  'CAPTURE_TASK_GROUP_BUSY',
  'CAPTURE_TASK_CLEANUP_PENDING',
  'CAPTURE_TASK_DEBUG_BUSY',
  'CAPTURE_LOCK_CONFLICT',
]);

function dutyRecoveryGlobalActionsEnabled(env = process.env) {
  return DUTY_RECOVERY_TRUE_VALUES.has(
    text(env.OPS_CONTROL_RECOVERY_GLOBAL_ENABLED, 20).toLowerCase(),
  ) && DUTY_RECOVERY_TRUE_VALUES.has(
    text(env.OPS_CONTROL_RECOVERY_ACTIONS_GLOBAL_ENABLED, 20).toLowerCase(),
  );
}
const ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES = new Set([
  ...ELASTIC_AGENT_CAPACITY_CODES,
  'CREATE_COMMAND_EXPIRED',
  'CREATE_AGENT_UNAVAILABLE',
  'UNATTENDED_BEGIN_FENCE_CHANGED',
  'UNATTENDED_ATTEMPT_REPLACED',
  'UNATTENDED_STATUS_REPORT_TIMEOUT',
  'UNATTENDED_STATUS_REPORT_REJECTED',
  'UNATTENDED_RUNTIME_MESSAGE_TIMEOUT',
  'UNATTENDED_REQUEST_NOT_FOUND',
  'UNATTENDED_SEARCH_BOOTSTRAP_FAILED',
]);
const ELASTIC_BOOTSTRAP_CONGESTION_CODES = new Set([
  'UNATTENDED_SEARCH_BOOTSTRAP_FAILED',
  'UNATTENDED_STATUS_REPORT_TIMEOUT',
  'UNATTENDED_RUNTIME_MESSAGE_TIMEOUT',
]);
const ELASTIC_STALE_TASK_CODES = new Set([
  'ELASTIC_TASK_HEARTBEAT_TIMEOUT',
  'ELASTIC_AGENT_OFFLINE_TIMEOUT',
]);
const CROSS_DEVICE_RETRY_TASK_TYPES = new Set([
  'unattended_keyword_capture',
  'negative_post_patrol',
  'watched_content_patrol',
  'official_account_comment_patrol',
  'followed_creator_post_patrol',
  'official_account_post_discovery',
]);
const CROSS_DEVICE_RETRY_UNSTARTED_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
]);
const CROSS_DEVICE_RETRY_PERMANENT_CODES = new Set([
  'CONTENT_UNAVAILABLE',
  'INVALID_RECORD',
  'LINK_MISSING',
  'IDENTITY_MISMATCH',
  'DOUYIN_DETAIL_ID_MISMATCH',
  'DOUYIN_COMMENT_ID_MISMATCH',
  'DOUYIN_COMMENT_ID_CONFLICT',
  'CANCELED',
  'DETAIL_CAPTURE_CANCELED',
  'USER_CANCELED',
]);
const EXPLICIT_USER_CANCELLATION_CODES = new Set([
  'USER_CANCELED',
  'USER_CANCELLED',
  'USER_CANCEL_REQUESTED',
]);
const CROSS_DEVICE_RETRY_MESSAGES = Object.freeze({
  task_not_found: ['task_not_found', '任务不存在'],
  task_cross_device_retry_unsupported: [
    'task_cross_device_retry_unsupported',
    '该任务类型暂不支持换设备重试',
  ],
  task_not_settled_for_retry: [
    'task_not_settled_for_retry',
    '原执行仍可能继续，需等任务失败并结算后再换设备重试',
  ],
  revision_conflict: ['revision_conflict', '任务状态已更新，请刷新后重试'],
  idle_compatible_agent_unavailable: [
    'idle_compatible_agent_unavailable',
    '当前没有其它在线、空闲且版本兼容的 Agent',
  ],
  retry_items_unavailable: [
    'retry_items_unavailable',
    '当前任务没有可安全重试的未完成项',
  ],
  retry_requires_manual_safety_action: [
    'retry_requires_manual_safety_action',
    '剩余项涉及平台验证码或安全验证，请先在原设备人工处理',
  ],
  retry_item_capacity_exceeded: [
    'retry_item_capacity_exceeded',
    '未完成关键词超过单个 Agent 容量，请使用多 Agent 编排重试',
  ],
  retry_source_execution_active: [
    'retry_source_execution_active',
    '原执行分支仍未结算，请稍后刷新再重试',
  ],
  retry_source_command_active: [
    'retry_source_command_active',
    '原执行仍有待确认的远程指令，请等待设备确认后重试',
  ],
  retry_profile_subscription_invalid: [
    'retry_profile_subscription_invalid',
    '账号巡查项缺少有效订阅标识，不能自动重试',
  ],
  retry_profile_subscription_unavailable: [
    'retry_profile_subscription_unavailable',
    '账号关注已暂停或删除，不能自动重试',
  ],
  retry_profile_subscription_busy: [
    'retry_profile_subscription_busy',
    '该账号正在被另一轮巡查调度，请稍后自动重试',
  ],
  retry_profile_execution_busy: [
    'retry_profile_execution_busy',
    '该账号已有另一轮巡查正在等待或执行',
  ],
  automatic_retry_disabled: [
    'automatic_retry_disabled',
    '该任务已关闭自动空闲 Agent 接力',
  ],
  retry_items_not_automatically_recoverable: [
    'retry_items_not_automatically_recoverable',
    '未完成项已达到自动恢复上限或属于不可重试业务失败',
  ],
  idempotency_key_conflict: [
    'idempotency_key_conflict',
    '该重试请求标识已用于其它任务',
  ],
});
const AGENT_REMOVAL_TASK_STATUSES = [
  'pending',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'resume_requested',
  'needs_action',
];
const POSTGRES_INTEGER_MAX = 2147483647;
const SUPERSEDED_CREATE_STOP_NO_TARGET_REASONS = new Set([
  'not_found',
  'request_mismatch',
]);

export function orchestrationRecoverySuccessorMatches({
  recordedSuccessorId = '',
  recoveryTask = {},
  lineageTasks = [],
} = {}) {
  const recorded = text(recordedSuccessorId, 240);
  if (!recorded) return true;
  const acceptedIdentities = new Set();
  for (const candidate of [recoveryTask, ...lineageTasks]) {
    const taskId = text(candidate?.id, 240);
    const clientTaskId = text(candidate?.client_task_id, 240);
    if (taskId) acceptedIdentities.add(taskId);
    if (clientTaskId) acceptedIdentities.add(clientTaskId);
  }
  return acceptedIdentities.has(recorded);
}

export function captureAgentRemovalBlockerMessage(blockers = {}) {
  const reasons = [];
  if (blockers.online) {
    reasons.push('节点仍在线，请先关闭该浏览器的 Extension，等待约 2 分钟后再删除');
  }
  if (Number(blockers.activeTasks) > 0) {
    reasons.push(`还有 ${Number(blockers.activeTasks)} 个未结束任务`);
  }
  if (Number(blockers.activeWorkItems) > 0) {
    reasons.push(`还有 ${Number(blockers.activeWorkItems)} 个多 Agent 工作项未结束`);
  }
  if (Number(blockers.pendingCommands) > 0) {
    reasons.push(`还有 ${Number(blockers.pendingCommands)} 条远程指令等待设备确认`);
  }
  if (blockers.localPlan) {
    reasons.push('仍有本地无人值守计划，请先删除计划并等待设备确认');
  }
  if (Number(blockers.cloudSchedules) > 0) {
    reasons.push(`仍参与 ${Number(blockers.cloudSchedules)} 个云端编排计划`);
  }
  return reasons.length > 0
    ? `暂不能删除：${reasons.join('；')}。`
    : '';
}

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

const CAPTURE_TASK_VISIBILITY_ALIASES = new Set(['assigned', 't']);

export function captureTaskBusinessRootVisibilitySql(alias = 't') {
  if (!CAPTURE_TASK_VISIBILITY_ALIASES.has(alias)) {
    throw new Error('Unsupported capture task SQL alias');
  }
  return `NOT (
    ${alias}.task_type IN (
      'negative_post_patrol',
      'watched_content_patrol',
      'official_account_comment_patrol',
      'followed_creator_post_patrol',
      'official_account_post_discovery'
    )
    AND NULLIF(${alias}.metadata->>'logicalRequestId', '') IS NOT NULL
    AND NULLIF(${alias}.metadata->>'attemptId', '') IS NOT NULL
    AND ${alias}.client_task_id =
      (${alias}.metadata->>'logicalRequestId') || '::' ||
      (${alias}.metadata->>'attemptId')
    AND EXISTS (
      SELECT 1
      FROM capture_tasks canonical
      WHERE canonical.tenant_id = ${alias}.tenant_id
        AND canonical.id::text = ${alias}.metadata->>'logicalRequestId'
        AND canonical.client_task_id = ${alias}.metadata->>'logicalRequestId'
        AND canonical.task_type = ${alias}.task_type
        AND canonical.origin_agent_id IS NOT DISTINCT FROM ${alias}.origin_agent_id
        AND canonical.parent_task_id IS NULL
        AND canonical.id <> ${alias}.id
    )
  )`;
}

export async function lockActiveCaptureAgentSession(
  executor,
  authenticatedAgent = {},
) {
  const tenantId = text(authenticatedAgent.tenant_id, 100);
  const agentId = text(authenticatedAgent.id, 100).toLowerCase();
  if (!tenantId || !UUID_PATTERN.test(agentId)) return null;

  // Authentication happens before the route transaction. Serialize with Agent
  // retirement, then re-read the row so a request authenticated just before
  // retirement cannot write after the retirement transaction has committed.
  await lockCaptureAgentExecutionSlot(executor, tenantId, agentId);
  const currentAgent = await executor.queryOne(`
    SELECT id, tenant_id, status, auth_code_id, auth_binding_id
    FROM capture_agents
    WHERE id = $1 AND tenant_id = $2
    FOR UPDATE
  `, [agentId, tenantId]);
  if (!currentAgent || currentAgent.status !== 'active') return null;

  // Also fence an in-flight request authenticated under an entitlement that
  // was replaced before this transaction acquired the execution slot.
  if (
    text(currentAgent.auth_code_id, 100) !==
      text(authenticatedAgent.auth_code_id, 100) ||
    text(currentAgent.auth_binding_id, 100) !==
      text(authenticatedAgent.auth_binding_id, 100)
  ) {
    return null;
  }
  return currentAgent;
}

export function orchestrationCheckpointInteger(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(POSTGRES_INTEGER_MAX, Math.max(0, parsed));
}

export function orchestrationCheckpointTimestamp(value) {
  const normalized = text(value, 100);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

const LATE_EVIDENCE_ACTIVE_ATTEMPT_STATUSES = new Set([
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'running',
]);

export function evaluateObservedCompletionCandidate(row = {}) {
  const checkpoint = safeJson(row.source_attempt_checkpoint);
  const result = safeJson(row.source_attempt_result);
  const parentMetadata = safeJson(row.parent_metadata);
  const planSnapshot = safeJson(
    parentMetadata.planSnapshot || parentMetadata.plan_snapshot,
  );
  const configuredPasses = Array.isArray(planSnapshot.searchPasses)
    ? planSnapshot.searchPasses.filter(value => text(value, 80)).length
    : 0;
  const expectedPassCount = Math.max(1, configuredPasses);
  const passRows = Array.isArray(checkpoint.searchPassResults)
    ? checkpoint.searchPassResults
    : [];
  const settledRounds = new Set();
  for (const value of passRows) {
    const pass = safeJson(value);
    const round = orchestrationCheckpointInteger(pass.round);
    if (
      round >= 1 &&
      round <= expectedPassCount &&
      ['completed', 'completed_with_warnings'].includes(
        text(pass.status, 80).toLowerCase(),
      ) &&
      pass.scanComplete === true &&
      pass.partial !== true
    ) {
      settledRounds.add(round);
    }
  }
  const savedCount = orchestrationCheckpointInteger(
    checkpoint.savedCount ?? checkpoint.saved_count ??
      result.savedCount ?? result.saved_count,
  );
  const observationCount = orchestrationCheckpointInteger(
    row.exact_observation_count,
  );
  const sourceAttemptStatus = text(row.source_attempt_status, 80).toLowerCase();
  const databaseChecks = Object.freeze({
    xiaohongshuOnly: text(row.platform, 40).toLowerCase() === 'xiaohongshu',
    reconcilableItemState: ['failed', 'needs_action'].includes(
      text(row.item_status, 80).toLowerCase(),
    ),
    exactObservationLineage: Boolean(
      text(row.source_attempt_id, 100) && observationCount > 0,
    ),
    savedEvidencePresent: savedCount > 0,
    savedObservationConsistent:
      savedCount > 0 && observationCount >= savedCount,
    scopeComplete:
      checkpoint.scanComplete === true &&
      checkpoint.partial !== true &&
      settledRounds.size === expectedPassCount,
    noStartedSuccessorAttempt:
      orchestrationCheckpointInteger(row.started_successor_attempt_count) === 0,
    noActiveAttempt:
      orchestrationCheckpointInteger(row.active_started_attempt_count) === 0 &&
      !(
        LATE_EVIDENCE_ACTIVE_ATTEMPT_STATUSES.has(sourceAttemptStatus) &&
        Boolean(row.source_attempt_started_at)
      ),
    noActiveCommand:
      orchestrationCheckpointInteger(row.active_command_count) === 0,
    noActiveExecution:
      orchestrationCheckpointInteger(row.active_execution_count) === 0,
    noActiveRecoveryLease:
      orchestrationCheckpointInteger(row.active_recovery_lease_count) === 0,
    lineageSilent: row.lineage_silent === true,
  });
  const blockingChecks = Object.entries(databaseChecks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  const evidenceCandidate = blockingChecks.length === 0;
  const unstartedSuccessorAttemptCount = orchestrationCheckpointInteger(
    row.unstarted_successor_attempt_count,
  );

  // Runner tabs and the execution lock/lease live only in browser-local
  // storage today. Neither a user report nor an HTTP request parameter can
  // prove their absence, so this read-only detector can never authorize a
  // state transition on its own.
  return Object.freeze({
    itemId: text(row.item_id, 100),
    taskId: text(row.task_id, 100),
    executionTaskId: text(row.source_execution_task_id, 100),
    sourceAttemptId: text(row.source_attempt_id, 100),
    assignmentRevision: orchestrationCheckpointInteger(
      row.source_assignment_revision,
    ),
    attemptNumber: orchestrationCheckpointInteger(row.source_attempt_number),
    evidenceCandidate,
    reconcileEligible: false,
    readOnly: true,
    runtimeAbsenceUnverified: true,
    humanReportAcceptedAsEvidence: false,
    blockingChecks: Object.freeze([
      ...blockingChecks,
      ...(evidenceCandidate ? ['runtimeAbsenceUnverified'] : []),
    ]),
    databaseChecks,
    evidence: Object.freeze({
      savedCount,
      observationCount,
      expectedPassCount,
      settledPassCount: settledRounds.size,
      latestObservationAt: orchestrationCheckpointTimestamp(
        row.latest_observation_at,
      ),
      lineageLastActivityAt: orchestrationCheckpointTimestamp(
        row.lineage_last_activity_at,
      ),
    }),
    successorAttempts: Object.freeze({
      unstartedCount: unstartedSuccessorAttemptCount,
      startedCount: orchestrationCheckpointInteger(
        row.started_successor_attempt_count,
      ),
      requiresTransactionalSealing: unstartedSuccessorAttemptCount > 0,
      sealed: false,
    }),
  });
}

function safeJson(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasConfiguredAgentPlan(value) {
  const plan = safeJson(value);
  const keywords = Array.isArray(plan.keywords)
    ? plan.keywords.map(keyword => text(keyword, 120)).filter(Boolean)
    : [];
  return plan.configured === true ||
    plan.enabled === true ||
    keywords.length > 0 ||
    Boolean(text(plan.updatedAt, 100));
}

function remoteTaskRequestHash(agentId, title, executionMode, planSnapshot) {
  const plan = safeJson(planSnapshot);
  const executionPlan = {
    executionMode,
    enabled: plan.enabled,
    platform: plan.platform,
    keywords: plan.keywords,
    searchFilters: plan.searchFilters,
    keywordMaxDetectedItems: plan.keywordMaxDetectedItems,
    captureSettings: plan.captureSettings,
    mode: plan.mode,
    startTime: plan.startTime,
    randomOffsetMin: plan.randomOffsetMin,
    customDates: plan.customDates,
    maxRounds: plan.maxRounds,
    roundGapMin: plan.roundGapMin,
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify({agentId, title, executionPlan}))
    .digest('hex');
}

export function captureTaskSnapshotFingerprint(snapshot = {}) {
  const normalized = safeJson(snapshot);
  // Fingerprint the complete normalized browser report. Exact heartbeat
  // replays are idempotent, while a later source timestamp, progress sequence,
  // status, checkpoint, or payload remains a distinct accepted snapshot.
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      clientTaskId: normalized.clientTaskId,
      controlTaskId: normalized.controlTaskId,
      taskType: normalized.taskType,
      featureKey: normalized.featureKey,
      title: normalized.title,
      platform: normalized.platform,
      source: normalized.source,
      triggerType: normalized.triggerType,
      status: normalized.status,
      progress: normalized.progress,
      checkpoint: normalized.checkpoint,
      targetResults: normalized.targetResults,
      counts: normalized.counts,
      metadata: normalized.metadata,
      error: normalized.error,
      message: normalized.message,
      attemptId: normalized.attemptId,
      attemptNumber: normalized.attemptNumber,
      progressSeq: normalized.progressSeq,
      heartbeatAt: normalized.heartbeatAt,
      businessProgressAt: normalized.businessProgressAt,
      startedAt: normalized.startedAt,
      finishedAt: normalized.finishedAt,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    }))
    .digest('hex');
}

function promotedRetryBusinessTaskType(task = {}) {
  const metadata = safeJson(task.metadata);
  const featureTaskType = text(task.feature_key, 80);
  return text(
    metadata.promotedBusinessTaskType ||
      metadata.businessTaskType ||
      metadata.workflow ||
      (CROSS_DEVICE_RETRY_TASK_TYPES.has(featureTaskType)
        ? featureTaskType
        : '') ||
      (task.task_type === 'capture_orchestration'
        ? 'unattended_keyword_capture'
        : task.task_type),
    80,
  );
}

export function crossDeviceRetryTaskSupported(task = {}) {
  if (task.parent_task_id) return false;
  return CROSS_DEVICE_RETRY_TASK_TYPES.has(
    promotedRetryBusinessTaskType(task),
  );
}

function crossDeviceRetrySourceReady(
  task = {},
  {automatic = false, dutyRecovery = false} = {},
) {
  if (CROSS_DEVICE_RETRY_SOURCE_STATUSES.has(task.status)) return true;
  if (!automatic || !AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES.has(task.status)) {
    return false;
  }
  if (dutyRecovery) return true;
  const metadata = safeJson(task.metadata);
  return Boolean(text(metadata.lastAutomaticRecoveryTaskId, 100));
}

export function classifyCaptureRecoveryDisposition(
  item = {},
  {phase = 'fast'} = {},
) {
  const dutyRecovery = phase === 'duty';
  if (crossDeviceRetryItemNeedsManualSafety(item)) {
    return {kind: 'manual_current', automatic: false};
  }
  const status = text(item.status, 80).toLowerCase();
  const error = safeJson(item.error);
  const checkpoint = safeJson(safeJson(item.metadata).checkpoint);
  const code = text(
    error.code || checkpoint.errorCode || checkpoint.error_code,
    100,
  ).toUpperCase();
  const category = text(
    error.category || checkpoint.errorCategory || checkpoint.error_category,
    100,
  ).toLowerCase();
  if (
    dutyRecovery &&
    (
      CROSS_DEVICE_RETRY_PERMANENT_CODES.has(code) ||
      EXPLICIT_USER_CANCELLATION_CODES.has(code) ||
      ['invalid_record', 'link_missing', 'integrity_blocked', 'user_canceled']
        .includes(category)
    )
  ) {
    return {kind: 'terminal_business_failure', automatic: false};
  }
  if (
    !dutyRecovery &&
    Number(item.attempt_count || 0) >=
    AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT
  ) {
    return {kind: 'automatic_attempts_exhausted', automatic: false};
  }
  if (
    !item.started_at &&
    CROSS_DEVICE_RETRY_UNSTARTED_ITEM_STATUSES.has(status)
  ) {
    return {kind: 'auto_handoff', automatic: true};
  }
  if (
    CROSS_DEVICE_RETRY_PERMANENT_CODES.has(code) ||
    ['invalid_record', 'link_missing', 'integrity_blocked', 'user_canceled']
      .includes(category)
  ) {
    return {kind: 'terminal_business_failure', automatic: false};
  }
  if (['retryable', 'needs_action', 'failed'].includes(status)) {
    return {kind: 'auto_retry_or_handoff', automatic: true};
  }
  return {kind: 'wait', automatic: false};
}

export function crossDeviceRetrySourceAgentIdsForItems(
  items = [],
  attempts = [],
) {
  const selectedItemIds = new Set(
    items.map(item => text(item?.id, 100).toLowerCase()).filter(Boolean),
  );
  return Array.from(new Set([
    ...items.map(item => item?.assigned_agent_id),
    ...attempts
      .filter(attempt => selectedItemIds.has(
        text(attempt?.item_id, 100).toLowerCase(),
      ))
      .map(attempt => attempt?.agent_id),
  ]
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value))));
}

export function crossDeviceRetrySafetyAgentIdsForItems(
  items = [],
  attempts = [],
) {
  const selectedItemIds = new Set(
    items.map(item => text(item?.id, 100).toLowerCase()).filter(Boolean),
  );
  const safetyAgentIds = [
    ...items
      .filter(item => crossDeviceRetryItemNeedsManualSafety(item))
      .map(item => item?.assigned_agent_id),
    ...attempts
      .filter(attempt => (
        selectedItemIds.has(text(attempt?.item_id, 100).toLowerCase())
        && crossDeviceRetryItemNeedsManualSafety({
          status: attempt?.status,
          error: safeJson(attempt?.error),
          metadata: {checkpoint: safeJson(attempt?.checkpoint)},
        })
      ))
      .map(attempt => attempt?.agent_id),
  ];
  return Array.from(new Set(
    safetyAgentIds
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID_PATTERN.test(value)),
  ));
}

export function crossDeviceRetryItemNeedsManualSafety(item = {}) {
  const error = safeJson(item.error);
  const checkpoint = safeJson(safeJson(item.metadata).checkpoint);
  const evidence = [error, checkpoint];
  const code = text(
    error.code || checkpoint.errorCode || checkpoint.error_code,
    100,
  ).toUpperCase();
  return CROSS_DEVICE_RETRY_SAFETY_CODES.has(code) ||
    evidence.some(value => [
      'platform_safety_block',
      'login_required',
      'authentication_required',
    ].includes(text(
      value.category || value.errorCategory || value.error_category,
      100,
    ).toLowerCase())) ||
    evidence.some(value => (
      value.securityBlocked === true
      || value.security_blocked === true
      || value.platformSafetyBlocked === true
      || value.platform_safety_blocked === true
      || value.requiresManualAction === true
      || value.requires_manual_action === true
      || safeJson(value.securityEvidence).confirmed === true
      || safeJson(value.security_evidence).confirmed === true
    ));
}

export function projectElasticKeywordRecoveryStatus({
  elasticPool = false,
  status = '',
  error = {},
  checkpoint = {},
  attemptCount = 0,
  safetyHandoffCount = 0,
  sourceLocalClosureProven = false,
  technicalLimitReached = false,
} = {}) {
  const normalizedStatus = text(status, 80).toLowerCase();
  if (!elasticPool) return normalizedStatus;
  if (![
    'interrupted',
    'needs_action',
    'failed',
    'completed_with_failures',
    'retryable',
  ].includes(normalizedStatus)) {
    return normalizedStatus;
  }
  const normalizedAttemptCount = Math.max(0, Number(attemptCount) || 0);
  const safetyBlocked = crossDeviceRetryItemNeedsManualSafety({
    status: normalizedStatus,
    error,
    metadata: {checkpoint},
  });
  if (safetyBlocked) {
    const safetyCode = text(
      safeJson(error).code ||
        safeJson(checkpoint).errorCode ||
        safeJson(checkpoint).error_code,
      100,
    ).toUpperCase();
    if (!AUTOMATIC_SEARCH_SAFETY_HANDOFF_CODES.has(safetyCode)) {
      return 'needs_action';
    }
    if (sourceLocalClosureProven !== true) {
      return 'needs_action';
    }
    return Math.max(0, Number(safetyHandoffCount) || 0) <
      ELASTIC_AUTOMATIC_SAFETY_HANDOFF_ATTEMPTS
      ? 'retryable'
      : 'needs_action';
  }
  if (technicalLimitReached) {
    return 'needs_action';
  }
  return normalizedAttemptCount < AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT
    ? 'retryable'
    : 'failed';
}

export function isExplicitUserCancellationSnapshot(task = {}, snapshot = {}) {
  const taskMetadata = safeJson(task.metadata);
  const snapshotMetadata = safeJson(snapshot.metadata);
  const snapshotError = safeJson(snapshot.error);
  const code = text(
    snapshotError.code || snapshot.errorCode || snapshot.error_code,
    100,
  ).toUpperCase();
  const category = text(
    snapshotError.category || snapshot.errorCategory || snapshot.error_category,
    100,
  ).toLowerCase();
  const cancelSource = text(
    snapshotMetadata.cancelSource ||
      snapshotMetadata.cancel_source ||
      snapshotError.cancelSource ||
      snapshotError.cancel_source,
    80,
  ).toLowerCase();
  return Boolean(
    taskMetadata.stopCommandId ||
      EXPLICIT_USER_CANCELLATION_CODES.has(code) ||
      category === 'user_canceled' ||
      cancelSource === 'user'
  );
}

export function projectCanceledChildItemStatus({
  elasticPool = false,
  explicitUserCancellation = false,
} = {}) {
  if (explicitUserCancellation) return 'canceled';
  return elasticPool ? 'retryable' : 'needs_action';
}

function unexpectedTaskCancellationError(snapshot = {}) {
  const originalError = safeJson(snapshot.error);
  return {
    ...sanitizeCloudStructuredObject(originalError),
    code: 'UNEXPECTED_TASK_CANCELLATION',
    category: 'technical_recovery',
    message:
      '执行节点意外结束任务，未完成关键词已释放等待重新分配',
    retryable: true,
    automaticRetry: true,
    originalCode: text(
      originalError.code || snapshot.errorCode || snapshot.error_code,
      100,
    ),
  };
}

function elasticRecoveryErrorCode(source = {}) {
  const error = safeJson(source.error);
  const checkpoint = safeJson(source.checkpoint);
  return text(
    error.code ||
      error.errorCode ||
      checkpoint.errorCode ||
      checkpoint.error_code,
    100,
  ).toUpperCase();
}

export function projectElasticBootstrapPacing({
  seed = '',
  recentFailureCount = 0,
  recentAffectedAgentCount = 0,
  now = new Date(),
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime())
    ? nowDate.getTime()
    : Date.now();
  const normalizedSeed = text(seed, 500) || 'elastic-bootstrap';
  const digest = crypto.createHash('sha256').update(normalizedSeed).digest();
  const staggerBucket = digest[0] % ELASTIC_BOOTSTRAP_STAGGER_BUCKETS;
  const staggerDelayMs = staggerBucket * ELASTIC_BOOTSTRAP_STAGGER_GAP_MS;
  const failureCount = Math.max(0, Math.floor(Number(recentFailureCount) || 0));
  const affectedAgentCount = Math.max(
    0,
    Math.floor(Number(recentAffectedAgentCount) || 0),
  );
  const congestionDelayMs = affectedAgentCount >= 2
    ? Math.min(
        ELASTIC_BOOTSTRAP_CONGESTION_MAX_DELAY_MS,
        10 * 1000 +
          Math.max(0, affectedAgentCount - 2) * 6 * 1000 +
          Math.max(0, failureCount - affectedAgentCount) * 2 * 1000,
      )
    : 0;
  const delayMs = Math.min(
    ELASTIC_BOOTSTRAP_MAX_DELAY_MS,
    staggerDelayMs + congestionDelayMs,
  );
  return {
    bootstrapStartNotBefore: new Date(nowMs + delayMs).toISOString(),
    bootstrapDelayMs: delayMs,
    bootstrapPacingReason:
      congestionDelayMs > 0 ? 'recent_technical_congestion' : 'staggered_start',
    bootstrapStaggerBucket: staggerBucket,
    recentTechnicalFailureCount: failureCount,
    recentAffectedAgentCount: affectedAgentCount,
  };
}

export function elasticAttemptBudgetAfterOutcome(
  attemptCount = 0,
  source = {},
) {
  const normalizedAttemptCount = Math.max(0, Number(attemptCount) || 0);
  return ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES.has(
    elasticRecoveryErrorCode(source),
  )
    ? Math.max(0, normalizedAttemptCount - 1)
    : normalizedAttemptCount;
}

export function projectElasticAttemptBudget(
  item = {},
  source = {},
  executionTaskId = '',
) {
  const metadata = safeJson(item?.metadata);
  const explicitBudget = Number(metadata.elasticAttemptBudgetUsed);
  const currentBudget = Number.isInteger(explicitBudget) && explicitBudget >= 0
    ? explicitBudget
    : Math.max(0, Number(item?.attempt_count) || 0);
  const explicitTechnicalAttemptCount = Number(
    metadata.elasticTechnicalAttemptCount,
  );
  const currentTechnicalAttemptCount =
    Number.isInteger(explicitTechnicalAttemptCount) &&
    explicitTechnicalAttemptCount >= 0
      ? explicitTechnicalAttemptCount
      : 0;
  const errorCode = elasticRecoveryErrorCode(source);
  const normalizedExecutionTaskId = text(executionTaskId, 100).toLowerCase();
  const refundState = safeJson(metadata.elasticAttemptBudget);
  const alreadyRefunded = Boolean(
    normalizedExecutionTaskId &&
      text(refundState.refundedExecutionTaskId, 100).toLowerCase() ===
        normalizedExecutionTaskId,
  );
  const shouldRefund = Boolean(
    normalizedExecutionTaskId &&
      ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES.has(errorCode) &&
      !alreadyRefunded,
  );
  const attemptBudget = shouldRefund
    ? elasticAttemptBudgetAfterOutcome(currentBudget, source)
    : currentBudget;
  const technicalAttemptCount = shouldRefund
    ? currentTechnicalAttemptCount + 1
    : currentTechnicalAttemptCount;
  const technicalLimitReached = Boolean(
    ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES.has(errorCode) &&
      technicalAttemptCount >= ELASTIC_TECHNICAL_HANDOFF_LIMIT,
  );
  return {
    attemptBudget,
    technicalAttemptCount,
    technicalLimitReached,
    metadataPatch: {
      elasticAttemptBudgetUsed: attemptBudget,
      elasticTechnicalAttemptCount: technicalAttemptCount,
      ...(shouldRefund
        ? {
            elasticAttemptBudget: {
              refundedExecutionTaskId: normalizedExecutionTaskId,
              refundedCode: errorCode,
              refundedAt: new Date().toISOString(),
            },
          }
        : {}),
    },
    refunded: shouldRefund,
  };
}

function elasticAgentRecoveryHoldMs(source = {}) {
  const errorCode = elasticRecoveryErrorCode(source);
  if (ELASTIC_AGENT_CAPACITY_CODES.has(errorCode)) {
    return ELASTIC_AGENT_CAPACITY_HOLD_MS;
  }
  if (ELASTIC_STALE_TASK_CODES.has(errorCode)) {
    return ELASTIC_STALE_TASK_AGENT_HOLD_MS;
  }
  return crossDeviceRetryItemNeedsManualSafety({
    status: source.status,
    error: safeJson(source.error),
    metadata: {checkpoint: safeJson(source.checkpoint)},
  })
    ? ELASTIC_SAFETY_AGENT_HOLD_MS
    : ELASTIC_TECHNICAL_AGENT_HOLD_MS;
}

export function elasticRecoveryHoldRemainingMs(
  attempt = {},
  now = Date.now(),
) {
  const source = attempt && typeof attempt === 'object' ? attempt : {};
  const updatedAt = Date.parse(String(
    source.updated_at || source.updatedAt || source.finished_at || '',
  ));
  if (!Number.isFinite(updatedAt)) return 0;
  const holdMs = elasticAgentRecoveryHoldMs(source);
  return Math.max(0, updatedAt + holdMs - Number(now || Date.now()));
}

function buildElasticRecoveryMetadata({
  status = '',
  error = {},
  checkpoint = {},
  attemptCount = 0,
  sourceAgentId = '',
  now = new Date(),
} = {}) {
  if (status !== 'retryable') return {};
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime())
    ? nowDate.getTime()
    : Date.now();
  const recoveryError = safeJson(error);
  const recoveryCheckpoint = safeJson(checkpoint);
  const safetyBlocked = crossDeviceRetryItemNeedsManualSafety({
    status,
    error: recoveryError,
    metadata: {checkpoint: recoveryCheckpoint},
  });
  const sourceAgentHoldMs = elasticAgentRecoveryHoldMs({
    status,
    error: recoveryError,
    checkpoint: recoveryCheckpoint,
  });
  return {
    // retryable means the current child no longer owns this item. Another
    // compatible Agent may claim it immediately; only the failing source Agent
    // is cooled down, and it is kept off the same item for a longer window.
    state: 'released_for_handoff',
    reason: safetyBlocked ? 'platform_safety_handoff' : 'technical_recovery',
    attemptCurrent: Math.max(1, Number(attemptCount) || 1),
    attemptTotal: AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT,
    sourceAgentId: text(sourceAgentId, 100),
    queuedAt: new Date(nowMs).toISOString(),
    handoffReadyAt: new Date(nowMs).toISOString(),
    itemLockReleased: true,
    sourceAgentCooling: true,
    ...(Object.prototype.hasOwnProperty.call(recoveryError, 'cooldownHomeRestored') ||
    Object.prototype.hasOwnProperty.call(recoveryCheckpoint, 'cooldownHomeRestored')
      ? {
          cooldownHomeRestored:
            recoveryError.cooldownHomeRestored === true ||
            recoveryCheckpoint.cooldownHomeRestored === true,
        }
      : {}),
    ...(text(
      recoveryError.cooldownHomeUrl || recoveryCheckpoint.cooldownHomeUrl,
      2000,
    )
      ? {
          cooldownHomeUrl: text(
            recoveryError.cooldownHomeUrl || recoveryCheckpoint.cooldownHomeUrl,
            2000,
          ),
        }
      : {}),
    nextEvaluationAt: new Date(
      nowMs + ELASTIC_DISPATCH_RECHECK_MS,
    ).toISOString(),
    sourceAgentHoldUntil: new Date(
      nowMs + sourceAgentHoldMs,
    ).toISOString(),
    sourceAgentSameItemRetryAfter: new Date(
      nowMs + Math.max(sourceAgentHoldMs, ELASTIC_SAME_ITEM_RETRY_COOLDOWN_MS),
    ).toISOString(),
    automatic: true,
  };
}

export function crossDeviceRetryAgentSupportsTask(
  agent = {},
  task = {},
  commandPayload = {},
) {
  const capabilities = safeJson(agent.capabilities);
  if (capabilities.remoteTaskCreate !== true) return false;
  const dutyRecoveryRequested =
    Object.keys(safeJson(commandPayload.dutyRecovery)).length > 0;
  if (dutyRecoveryRequested && (
    capabilities.remoteStop !== true ||
    capabilities.dutyRecoveryLineageV1 !== true
  )) return false;
  const platform = text(task.platform, 40).toLowerCase();
  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : [];
  const supportedPlatforms = normalizeCaptureAgentPlatforms(
    capabilities.supportedPlatforms,
  );
  if (
    (allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform)) ||
    (supportedPlatforms.length > 0 && !supportedPlatforms.includes(platform))
  ) {
    return false;
  }

  const taskType = promotedRetryBusinessTaskType(task);
  if (taskType === 'unattended_keyword_capture') {
    const metadata = safeJson(task.metadata);
    const planSnapshot = safeJson(
      metadata.planSnapshot || commandPayload.planSnapshot,
    );
    if (
      Object.keys(safeJson(planSnapshot.captureSettings)).length > 0 &&
      capabilities.remoteTaskEnhancementOptions !== true
    ) {
      return false;
    }
    if (
      Object.prototype.hasOwnProperty.call(
        planSnapshot,
        'keywordMaxDetectedItems',
      ) &&
      capabilities.remoteTaskKeywordPostLimit !== true
    ) {
      return false;
    }
    return true;
  }

  if (capabilities.remoteTargetedPostCaptureV1 !== true) return false;
  if (taskType === 'negative_post_patrol') {
    return capabilities.negativePostPatrol === true;
  }
  if (taskType === 'watched_content_patrol') {
    return capabilities.watchedContentPatrol === true;
  }
  if (taskType === 'followed_creator_post_patrol') {
    return capabilities.followedCreatorPostPatrol === true;
  }
  if (taskType === 'official_account_post_discovery') {
    return capabilities.officialAccountPostDiscovery === true;
  }
  if (taskType === 'official_account_comment_patrol') {
    if (isProfilePatrolTask({...task, task_type: taskType}, commandPayload)) {
      return capabilities.officialAccountCommentPatrolProfileV1 === true &&
        capabilities.officialAccountLatestPostsByCountV1 === true;
    }
    return capabilities.officialAccountCommentPatrol === true;
  }
  return false;
}

export function crossDeviceRetryAgentDailyUsageEligible(agent = {}) {
  const searches = Number(agent.today_searches);
  if (
    agent.today_usage_current !== true ||
    !agent.today_usage_last_event_at ||
    !Number.isInteger(searches) ||
    searches < 0
  ) {
    return false;
  }

  const rawLimit = agent.daily_search_limit;
  if (rawLimit === null || rawLimit === undefined || rawLimit === '') {
    return true;
  }
  const limit = Number(rawLimit);
  return Number.isInteger(limit) &&
    limit >= 0 &&
    (limit === 0 || searches < limit);
}

function abortCrossDeviceRetry(error, details = {}) {
  const failure = new Error(error);
  failure.code = 'cross_device_retry_transaction_abort';
  failure.crossDeviceRetryError = error;
  failure.details = details;
  throw failure;
}

function sendCrossDeviceRetryError(res, result = {}) {
  const [error, message] = CROSS_DEVICE_RETRY_MESSAGES[result.error] || [
    result.error,
    '换设备重试失败，请刷新后重试',
  ];
  return res.status(result.error === 'task_not_found' ? 404 : 409).json({
    ok: false,
    error,
    message,
    ...(result.currentRevision == null
      ? {}
      : {currentRevision: result.currentRevision}),
  });
}

function attemptStatus(taskStatus) {
  if (taskStatus === 'claimed') return 'claimed';
  if (taskStatus === 'recovering') return 'recovering';
  if (taskStatus === 'running') return 'running';
  if (taskStatus === 'interrupted' || taskStatus === 'needs_action') return 'interrupted';
  if (taskStatus === 'completed') return 'completed';
  if (taskStatus === 'completed_with_warnings') return 'completed_with_warnings';
  if (taskStatus === 'completed_with_failures') return 'completed_with_failures';
  if (taskStatus === 'canceled' || taskStatus === 'skipped') return 'canceled';
  if (taskStatus === 'failed') return 'failed';
  return '';
}

function stopFailureStatus(previousStatus) {
  const normalized = text(previousStatus, 80);
  if (normalized === 'resume_requested') return 'needs_action';
  return REMOTELY_STOPPABLE_STATUSES.has(normalized)
    ? normalized
    : 'needs_action';
}

export function resolveStopCommandOutcome({
  reportedSuccess = false,
  expectedRequestId = '',
  actualRequestId = '',
  expectedAttemptId = '',
  actualAttemptId = '',
  resultReason = '',
  supersededCreateCommandId = '',
  previousStatus = '',
} = {}) {
  const expected = text(expectedRequestId, 240);
  const actual = text(actualRequestId, 240);
  const validRequestId = Boolean(expected && actual === expected);
  const expectedAttempt = text(expectedAttemptId, 240);
  const actualAttempt = text(actualAttemptId, 240);
  // Existing non-targeted stop commands predate attempt fencing. Once a
  // command carries an attempt, however, its receipt must identify that exact
  // execution round so a stale browser run cannot settle the current task.
  const validAttemptId = expectedAttempt
    ? actualAttempt === expectedAttempt
    : true;
  const validIdentity = validRequestId && validAttemptId;
  const normalizedReason = text(resultReason, 120);
  const normalizedCreateCommandId = text(supersededCreateCommandId, 100);
  const stoppedBeforeLocalCreation = Boolean(
    validIdentity &&
      reportedSuccess !== true &&
      UUID_PATTERN.test(normalizedCreateCommandId) &&
      SUPERSEDED_CREATE_STOP_NO_TARGET_REASONS.has(normalizedReason),
  );
  const success = Boolean(
    validIdentity && (reportedSuccess === true || stoppedBeforeLocalCreation),
  );
  return {
    validRequestId,
    validAttemptId,
    success,
    stoppedBeforeLocalCreation,
    commandStatus: success ? 'completed' : 'failed',
    taskStatus: success ? 'canceled' : stopFailureStatus(previousStatus),
  };
}

async function appendEvent(tx, {
  tenantId,
  taskId,
  attemptId = null,
  agentId = null,
  eventType,
  actorType = 'system',
  actorId = '',
  actorName = '',
  status = '',
  message = '',
  payload = {},
}) {
  await tx.execute(`
    INSERT INTO capture_task_events (
      tenant_id, task_id, attempt_id, agent_id, event_type,
      actor_type, actor_id, actor_name, status, message, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
  `, [
    tenantId,
    taskId,
    attemptId,
    agentId,
    eventType,
    actorType,
    text(actorId, 240),
    text(actorName, 240),
    text(status, 80),
    text(message, 2000),
    JSON.stringify(safeJson(payload)),
  ]);
}

export async function supersedeStalePlanConfigurationAttention(tx, {
  tenantId,
  agentId,
  supersededByTaskId,
  supersededByCreatedAt,
  actorType = 'system',
  actorId = '',
  actorName = '',
  taskMessage,
  eventMessage,
}) {
  const supersededTasks = await tx.queryAll(`
    UPDATE capture_tasks
    SET status = 'superseded',
      message = $5,
      metadata = metadata || jsonb_build_object(
        'supersededByTaskId', $3::text,
        'supersededAt', now()
      ),
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
    WHERE tenant_id = $1
      AND COALESCE(assigned_agent_id, origin_agent_id) = $2
      AND id <> $3::uuid
      AND task_type = 'unattended_plan_configuration'
      AND status = 'needs_action'
      AND (
        created_at < $4::timestamptz
        OR (created_at = $4::timestamptz AND id < $3::uuid)
      )
    RETURNING id
  `, [
    tenantId,
    agentId,
    supersededByTaskId,
    supersededByCreatedAt,
    taskMessage,
  ]);

  for (const supersededTask of supersededTasks) {
    await appendEvent(tx, {
      tenantId,
      taskId: supersededTask.id,
      agentId,
      eventType: 'plan_configuration_superseded',
      actorType,
      actorId,
      actorName,
      status: 'superseded',
      message: eventMessage,
      payload: {supersededByTaskId},
    });
  }
}

async function expireStaleCommands(tx, tenantId, taskId = null, agentId = null) {
  const scopedTaskId = text(taskId, 100);
  const scopedAgentId = text(agentId, 100);
  // Every path that can mutate both records locks the task before its command.
  // Lock candidate tasks in a deterministic order before the bulk command
  // updates below, preventing heartbeat/receipt expiry races from deadlocking.
  await tx.queryAll(`
    SELECT t.id
    FROM capture_tasks t
    WHERE t.tenant_id = $1
      AND ($2 = '' OR t.id::text = $2)
      AND EXISTS (
        SELECT 1 FROM capture_agent_commands c
        WHERE c.task_id = t.id AND c.tenant_id = t.tenant_id
          AND c.status IN ('pending', 'acknowledged')
          AND ($3 = '' OR c.agent_id::text = $3)
      )
    ORDER BY t.id
    FOR UPDATE
  `, [tenantId, scopedTaskId, scopedAgentId]);
  const expired = await tx.queryAll(`
    UPDATE capture_agent_commands
    SET status = 'expired',
      result = jsonb_build_object('reason', 'expired'),
      finished_at = now(), updated_at = now()
    WHERE tenant_id = $1
      AND ($2 = '' OR task_id::text = $2)
      AND ($3 = '' OR agent_id::text = $3)
      AND status IN ('pending', 'acknowledged')
      AND expires_at <= now()
    RETURNING id, task_id, agent_id, command_type, payload
  `, [tenantId, scopedTaskId, scopedAgentId]);

  for (const command of expired) {
    if (command.command_type === 'create') {
      const failedTask = await tx.queryOne(`
        UPDATE capture_tasks
        SET status = 'failed',
          message = '设备创建指令已过期，任务未执行',
          error = jsonb_build_object(
            'code', 'create_command_expired',
            'message', '设备未在指令有效期内领取并创建任务'
          ),
          finished_at = now(),
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
          AND status IN ('pending', 'claimed')
          AND metadata->>'createCommandId' = $3
        RETURNING id, status, parent_task_id, task_type, metadata
      `, [command.task_id, tenantId, command.id]);
      await appendEvent(tx, {
        tenantId,
        taskId: command.task_id,
        agentId: command.agent_id,
        eventType: 'create_command_expired',
        status: failedTask?.status || '',
        message: failedTask
          ? '设备创建指令已过期，任务未执行'
          : '设备创建指令已过期，任务已有更新状态',
        payload: {commandId: command.id, commandType: command.command_type},
      });
      if (failedTask) {
        const elasticQueueItem =
          safeJson(failedTask.metadata).cloudWorkQueue === true;
        await failProfileDiscoveryWork(tx, {
          tenantId,
          taskId: failedTask.id,
          task: failedTask,
          taskType: failedTask.task_type,
          payload: command.payload,
          code: 'create_command_expired',
          message: '设备未在指令有效期内领取并创建任务',
        });
        await projectOrchestrationChildControlOutcome(tx, {
          tenantId,
          childTask: failedTask,
          agentId: command.agent_id,
          status: elasticQueueItem ? 'retryable' : 'needs_action',
          error: {
            code: 'create_command_expired',
            message: '设备未在指令有效期内领取并创建任务',
            automaticRetry: elasticQueueItem,
          },
        });
      }
      continue;
    }
    if (command.command_type === 'stop') {
      const restoredStatus = stopFailureStatus(command.payload?.previousStatus);
      const restored = await tx.queryOne(`
        UPDATE capture_tasks
        SET status = $1,
          message = '远程停止指令已过期，可重新下发',
          metadata = metadata - 'stopCommandId' - 'stopPreviousStatus',
          updated_at = now()
        WHERE id = $2 AND tenant_id = $3
          AND metadata->>'stopCommandId' = $4
        RETURNING id
      `, [restoredStatus, command.task_id, tenantId, command.id]);
      if (restored) {
        await appendEvent(tx, {
          tenantId,
          taskId: command.task_id,
          agentId: command.agent_id,
          eventType: 'stop_command_expired',
          status: restoredStatus,
          message: '远程停止指令已过期，可重新下发',
          payload: {commandId: command.id, commandType: command.command_type},
        });
      }
      continue;
    }
    if (command.command_type !== 'resume') {
      await appendEvent(tx, {
        tenantId,
        taskId: command.task_id,
        agentId: command.agent_id,
        eventType: 'command_expired',
        message: '远程指令已过期',
        payload: {commandId: command.id, commandType: command.command_type},
      });
      continue;
    }
    const previousStatus = text(command.payload?.previousStatus, 80);
    const restoredStatus = RECOVERABLE_STATUSES.has(previousStatus)
      ? previousStatus
      : 'needs_action';
    const restored = await tx.queryOne(`
      UPDATE capture_tasks
      SET status = $1,
        message = '远程继续指令已过期，可重新下发',
        metadata = metadata - 'resumeCommandId' - 'resumePreviousStatus',
        updated_at = now()
      WHERE id = $2 AND tenant_id = $3 AND status = 'resume_requested'
        AND metadata->>'resumeCommandId' = $4
      RETURNING id
    `, [restoredStatus, command.task_id, tenantId, command.id]);
    if (!restored) continue;
    await appendEvent(tx, {
      tenantId,
      taskId: command.task_id,
      agentId: command.agent_id,
      eventType: 'command_expired',
      status: restoredStatus,
      message: '远程继续指令已过期，任务已恢复为可重试状态',
      payload: {commandId: command.id, commandType: command.command_type},
    });
  }

  const unavailable = await tx.queryAll(`
    UPDATE capture_agent_commands c
    SET status = 'expired',
      result = jsonb_build_object('reason', 'agent_inactive'),
      finished_at = now(), updated_at = now()
    WHERE c.tenant_id = $1
      AND ($2 = '' OR c.task_id::text = $2)
      AND ($3 = '' OR c.agent_id::text = $3)
      AND c.command_type IN ('resume', 'stop', 'create')
      AND c.status IN ('pending', 'acknowledged')
      AND NOT EXISTS (
        SELECT 1
        FROM capture_agents ca
        JOIN tenants tenant
          ON tenant.id = ca.tenant_id AND tenant.status = 'active'
        JOIN auth_codes ac
          ON ac.id = ca.auth_code_id
          AND ac.tenant_id = ca.tenant_id
          AND ac.status = 'active'
          AND (ac.expires_at IS NULL OR ac.expires_at >= now())
        JOIN auth_bindings ab
          ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
        JOIN capture_tasks t
          ON t.id = c.task_id AND t.tenant_id = c.tenant_id
        WHERE ca.id = c.agent_id AND ca.tenant_id = c.tenant_id
          AND ca.status = 'active'
          AND c.payload->>'authCodeId' = ca.auth_code_id::text
          AND c.payload->>'authBindingId' = ca.auth_binding_id::text
          AND c.payload->>'platform' = t.platform
          AND (
            c.command_type <> 'create'
            OR ca.capabilities->>'remoteTaskCreate' = 'true'
          )
          AND (
            c.command_type <> 'create'
            OR CASE
              WHEN jsonb_typeof(ca.capabilities->'supportedPlatforms') = 'array'
                THEN ca.capabilities->'supportedPlatforms'
              ELSE '[]'::jsonb
            END = '[]'::jsonb
            OR CASE
              WHEN jsonb_typeof(ca.capabilities->'supportedPlatforms') = 'array'
                THEN ca.capabilities->'supportedPlatforms'
              ELSE '[]'::jsonb
            END @> jsonb_build_array(t.platform)
          )
          AND (
            cardinality(ca.allowed_platforms) = 0
            OR t.platform = ANY(ca.allowed_platforms)
          )
      )
    RETURNING id, task_id, agent_id, command_type, payload
  `, [tenantId, scopedTaskId, scopedAgentId]);
  for (const command of unavailable) {
    if (command.command_type === 'create') {
      const failedTask = await tx.queryOne(`
        UPDATE capture_tasks
        SET status = 'needs_action',
          message = '目标节点授权或平台职责已变化，任务未执行',
          error = jsonb_build_object(
            'code', 'create_agent_unavailable',
            'message', '目标节点授权或平台职责已变化'
          ),
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
          AND status IN ('pending', 'claimed')
          AND metadata->>'createCommandId' = $3
        RETURNING id, status, parent_task_id, task_type, metadata
      `, [command.task_id, tenantId, command.id]);
      await appendEvent(tx, {
        tenantId,
        taskId: command.task_id,
        agentId: command.agent_id,
        eventType: 'create_command_canceled_agent_unavailable',
        status: failedTask?.status || '',
        message: failedTask
          ? '目标节点授权或平台职责已变化，创建指令已取消'
          : '目标任务已有更新状态，旧创建指令已取消',
        payload: {commandId: command.id, commandType: command.command_type},
      });
      if (failedTask) {
        await failProfileDiscoveryWork(tx, {
          tenantId,
          taskId: failedTask.id,
          task: failedTask,
          taskType: failedTask.task_type,
          payload: command.payload,
          code: 'create_agent_unavailable',
          message: '目标节点授权或平台职责已变化',
        });
        await projectOrchestrationChildControlOutcome(tx, {
          tenantId,
          childTask: failedTask,
          agentId: command.agent_id,
          status: 'needs_action',
          error: {
            code: 'create_agent_unavailable',
            message: '目标节点授权或平台职责已变化',
          },
        });
      }
      continue;
    }
    if (command.command_type === 'stop') {
      const restoredStatus = stopFailureStatus(command.payload?.previousStatus);
      const restored = await tx.queryOne(`
        UPDATE capture_tasks
        SET status = $1,
          message = '原执行节点授权或平台职责已变化，停止指令已取消',
          metadata = metadata - 'stopCommandId' - 'stopPreviousStatus',
          updated_at = now()
        WHERE id = $2 AND tenant_id = $3
          AND metadata->>'stopCommandId' = $4
        RETURNING id
      `, [restoredStatus, command.task_id, tenantId, command.id]);
      if (restored) {
        await appendEvent(tx, {
          tenantId,
          taskId: command.task_id,
          agentId: command.agent_id,
          eventType: 'stop_command_canceled_agent_unavailable',
          status: restoredStatus,
          message: '原执行节点授权或平台职责已变化，停止指令已取消',
          payload: {commandId: command.id, commandType: command.command_type},
        });
      }
      continue;
    }
    const previousStatus = text(command.payload?.previousStatus, 80);
    const restoredStatus = RECOVERABLE_STATUSES.has(previousStatus)
      ? previousStatus
      : 'needs_action';
    const restored = await tx.queryOne(`
      UPDATE capture_tasks
      SET status = $1,
        message = '原执行节点授权或平台职责已变化，可重新下发',
        metadata = metadata - 'resumeCommandId' - 'resumePreviousStatus',
        updated_at = now()
      WHERE id = $2 AND tenant_id = $3 AND status = 'resume_requested'
        AND metadata->>'resumeCommandId' = $4
      RETURNING id
    `, [restoredStatus, command.task_id, tenantId, command.id]);
    if (!restored) continue;
    await appendEvent(tx, {
      tenantId,
      taskId: command.task_id,
      agentId: command.agent_id,
      eventType: 'command_canceled_agent_unavailable',
      status: restoredStatus,
      message: '原执行节点授权或平台职责已变化，远程继续指令已取消',
      payload: {commandId: command.id, commandType: command.command_type},
    });
  }

  // A device can recover or finish locally before it sees a cloud command. In
  // that case the command must be invalidated, never delivered against a task
  // that no longer points at this exact control command.
  const obsolete = await tx.queryAll(`
    UPDATE capture_agent_commands c
    SET status = 'expired',
      result = jsonb_build_object('reason', 'task_state_changed'),
      finished_at = now(), updated_at = now()
    WHERE c.tenant_id = $1
      AND ($2 = '' OR c.task_id::text = $2)
      AND ($3 = '' OR c.agent_id::text = $3)
      AND c.status IN ('pending', 'acknowledged')
      AND (
        (
          c.command_type = 'resume'
          AND NOT EXISTS (
            SELECT 1 FROM capture_tasks t
            WHERE t.id = c.task_id AND t.tenant_id = c.tenant_id
              AND t.status = 'resume_requested'
              AND t.metadata->>'resumeCommandId' = c.id::text
          )
        )
        OR (
          c.command_type = 'create'
          AND NOT EXISTS (
            SELECT 1 FROM capture_tasks t
            WHERE t.id = c.task_id AND t.tenant_id = c.tenant_id
              AND t.status IN ('pending', 'claimed')
              AND t.metadata->>'createCommandId' = c.id::text
          )
        )
        OR (
          c.command_type = 'stop'
          AND NOT EXISTS (
            SELECT 1 FROM capture_tasks t
            WHERE t.id = c.task_id AND t.tenant_id = c.tenant_id
              AND t.status NOT IN (
                'completed', 'completed_with_warnings', 'canceled',
                'skipped', 'superseded'
              )
              AND t.metadata->>'stopCommandId' = c.id::text
          )
        )
      )
    RETURNING id, task_id, agent_id, command_type
  `, [tenantId, scopedTaskId, scopedAgentId]);
  for (const command of obsolete) {
    if (command.command_type === 'stop') {
      await tx.execute(`
        UPDATE capture_tasks
        SET metadata = metadata - 'stopCommandId' - 'stopPreviousStatus',
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
          AND metadata->>'stopCommandId' = $3
      `, [command.task_id, tenantId, command.id]);
    }
    await appendEvent(tx, {
      tenantId,
      taskId: command.task_id,
      agentId: command.agent_id,
      eventType: command.command_type === 'create'
        ? 'create_command_canceled_task_changed'
        : command.command_type === 'stop'
          ? 'stop_command_canceled_task_changed'
          : 'command_canceled_task_changed',
      message: command.command_type === 'create'
        ? '任务状态已变化，旧的创建指令未再下发'
        : command.command_type === 'stop'
          ? '任务已经结束或控制对象已变化，旧的停止指令未再下发'
          : '任务已在设备侧变化，旧的远程继续指令未再下发',
      payload: {commandId: command.id, commandType: command.command_type},
    });
  }
  return [...expired, ...unavailable, ...obsolete];
}

let pendingCommandReconciliation = null;

export async function reconcilePendingCaptureCommands({
  tenantLimit = 100,
  tenantId = '',
  taskId = '',
} = {}) {
  const scopedTenantId = text(tenantId, 100).toLowerCase();
  const scopedTaskId = text(taskId, 100).toLowerCase();
  if (scopedTaskId && !scopedTenantId) {
    return {tenantCount: 0, commandCount: 0, error: 'tenant_scope_required'};
  }
  if (scopedTenantId) {
    if (!UUID_PATTERN.test(scopedTenantId)) {
      return {tenantCount: 0, commandCount: 0, error: 'invalid_tenant_id'};
    }
    if (scopedTaskId && !UUID_PATTERN.test(scopedTaskId)) {
      return {tenantCount: 0, commandCount: 0, error: 'invalid_task_id'};
    }
    const reconciled = await withTransaction(tx =>
      expireStaleCommands(tx, scopedTenantId, scopedTaskId)
    );
    return {
      tenantCount: 1,
      commandCount: reconciled.length,
      taskId: scopedTaskId,
    };
  }
  if (pendingCommandReconciliation) return pendingCommandReconciliation;
  const limit = Math.max(1, Math.min(500, Number(tenantLimit) || 100));
  pendingCommandReconciliation = (async () => {
    const tenants = await queryAll(`
      SELECT tenant_id, MIN(created_at) AS oldest_command_at
      FROM capture_agent_commands
      WHERE status IN ('pending', 'acknowledged')
      GROUP BY tenant_id
      ORDER BY MIN(created_at), tenant_id
      LIMIT $1
    `, [limit]);
    let commandCount = 0;
    for (const tenant of tenants) {
      const reconciled = await withTransaction(tx =>
        expireStaleCommands(tx, tenant.tenant_id)
      );
      commandCount += reconciled.length;
    }
    return {tenantCount: tenants.length, commandCount};
  })();
  try {
    return await pendingCommandReconciliation;
  } finally {
    pendingCommandReconciliation = null;
  }
}

async function resolveResumeCommandFromSuccessor(tx, agent, snapshot) {
  const parentRequestId = text(snapshot.metadata?.parentRequestId, 240);
  if (!parentRequestId) return null;
  const parentTask = await tx.queryOne(`
    SELECT id, metadata FROM capture_tasks
    WHERE tenant_id = $1 AND origin_agent_id = $2
      AND (client_task_id = $3 OR control_task_id = $3)
      AND status = 'resume_requested'
    ORDER BY created_at DESC
    LIMIT 1
  `, [agent.tenant_id, agent.id, parentRequestId]);
  if (!parentTask) return null;
  const resumeCommandId = text(parentTask.metadata?.resumeCommandId, 100);
  if (!resumeCommandId) return null;

  const command = await tx.queryOne(`
    UPDATE capture_agent_commands
    SET status = 'completed',
      result = $1::jsonb,
      finished_at = now(),
      updated_at = now()
    WHERE id = (
      SELECT id FROM capture_agent_commands
      WHERE tenant_id = $2 AND agent_id = $3 AND task_id = $4
        AND command_type = 'resume'
        AND id::text = $5
        AND status IN ('pending', 'acknowledged')
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    )
    RETURNING id
  `, [
    JSON.stringify({source: 'successor_observed', recoveryTaskId: snapshot.clientTaskId}),
    agent.tenant_id,
    agent.id,
    parentTask.id,
    resumeCommandId,
  ]);
  if (!command) return null;

  const updatedParent = await tx.queryOne(`
    UPDATE capture_tasks
    SET status = 'superseded',
      message = '设备已创建新的恢复任务',
      metadata = (metadata - 'resumeCommandId' - 'resumePreviousStatus') || $1::jsonb,
      updated_at = now()
    WHERE id = $2 AND tenant_id = $3 AND status = 'resume_requested'
    RETURNING id
  `, [
    JSON.stringify({recoveryTaskId: snapshot.clientTaskId, recoveryCommandId: command.id}),
    parentTask.id,
    agent.tenant_id,
  ]);
  if (updatedParent) {
    await appendEvent(tx, {
      tenantId: agent.tenant_id,
      taskId: parentTask.id,
      agentId: agent.id,
      eventType: 'command_completed_from_successor',
      actorType: 'capture_agent',
      actorId: agent.id,
      actorName: agent.display_name || agent.client_label,
      status: 'superseded',
      message: '检测到新的恢复任务，远程继续指令已对账完成',
      payload: {commandId: command.id, recoveryTaskId: snapshot.clientTaskId},
    });
  }
  return command;
}

async function resolveCreateCommandFromSnapshot(tx, agent, task, snapshot, evidence = null) {
  const createCommandId = text(task?.metadata?.createCommandId, 100);
  const taskWorkflow = text(
    task?.metadata?.workflow || task?.task_type,
    80,
  );
  if (
    !createCommandId ||
    !task?.id ||
    task?.metadata?.stopCommandId ||
    (evidence && evidence.id !== createCommandId) ||
    (
      taskWorkflow === 'official_account_comment_patrol' &&
      (
        !evidence ||
        !createCommandSnapshotMatches(evidence.payload, snapshot)
      )
    )
  ) {
    return null;
  }
  const command = await tx.queryOne(`
    UPDATE capture_agent_commands
    SET status = 'completed',
      result = $1::jsonb,
      finished_at = now(),
      updated_at = now()
    WHERE id = $2 AND tenant_id = $3 AND agent_id = $4 AND task_id = $5
      AND command_type = 'create'
      AND status IN ('pending', 'acknowledged', 'expired')
      AND COALESCE(result->>'reason', '') NOT IN (
        'superseded_by_stop', 'stopped_before_dispatch'
      )
      AND payload->>'clientTaskId' = $6
    RETURNING id
  `, [
    JSON.stringify({source: 'task_snapshot_observed', requestId: snapshot.clientTaskId}),
    createCommandId,
    agent.tenant_id,
    agent.id,
    task.id,
    snapshot.clientTaskId,
  ]);
  if (!command) return null;
  await appendEvent(tx, {
    tenantId: agent.tenant_id,
    taskId: task.id,
    agentId: agent.id,
    eventType: 'create_command_completed_from_snapshot',
    actorType: 'capture_agent',
    actorId: agent.id,
    actorName: agent.display_name || agent.client_label,
    status: task.status,
    message: '检测到设备已创建本地任务，创建指令已自动对账',
    payload: {commandId: command.id, requestId: snapshot.clientTaskId},
  });
  return command;
}

const ORCHESTRATION_ITEM_TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'skipped',
  'canceled',
]);
const NEGATIVE_PATROL_RESULT_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'skipped',
  'canceled',
]);
const NEGATIVE_PATROL_SUCCESS_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
]);
const NEGATIVE_PATROL_TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'needs_action',
  'canceled',
  'skipped',
]);
const CONTENT_UNAVAILABLE_STATUSES = new Set([
  'deleted',
  'page_unavailable',
]);
// Targeted detail-capture runs share the same strict item/result protocol.
// Keep this allow-list closed: a remote command must not turn arbitrary task
// types into browser-driven URL capture.
const TARGETED_POST_TASK_TYPES = new Set([
  'negative_post_patrol',
  'watched_content_patrol',
  'official_account_comment_patrol',
  'followed_creator_post_patrol',
  'official_account_post_discovery',
]);

function isTargetedPostTaskType(value) {
  return TARGETED_POST_TASK_TYPES.has(text(value, 80));
}

function targetedPostTaskLabel(taskType) {
  if (taskType === 'watched_content_patrol') {
    return '关注内容巡查';
  }
  if (taskType === 'official_account_comment_patrol') {
    return '官方账号评论巡查';
  }
  if (taskType === 'followed_creator_post_patrol') {
    return '关注博主作品扫描';
  }
  if (taskType === 'official_account_post_discovery') {
    return '官方账号作品发现';
  }
  return '负面帖子巡查';
}

function profilePatrolIntent(source = {}) {
  const value = safeJson(source);
  const targetMode = text(
    value.targetMode || value.target_mode,
    80,
  ).toLowerCase();
  if (targetMode) {
    if ([
      'profile',
      'account',
      'account_profile',
      'profile_patrol',
      'profile_scan',
    ].includes(targetMode)) {
      return true;
    }
    if ([
      'post',
      'detail',
      'record',
      'direct',
      'single_post',
      'post_detail',
    ].includes(targetMode)) {
      return false;
    }
  }
  const profileMode = value.profileMode ?? value.profile_mode;
  if (profileMode === true || profileMode === 'true' || profileMode === 1) {
    return true;
  }
  if (profileMode === false || profileMode === 'false' || profileMode === 0) {
    return false;
  }
  return null;
}

function ownContractValue(source = {}, keys = []) {
  const value = safeJson(source);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return value[key];
    }
  }
  return undefined;
}

function observedContractValue(observed, metadata, keys) {
  const direct = ownContractValue(observed, keys);
  return direct === undefined
    ? ownContractValue(metadata, keys)
    : direct;
}

function contractBoolean(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') {
    return true;
  }
  if (value === false || value === 0 || value === '0' || value === 'false') {
    return false;
  }
  return null;
}

function contractInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

function contractUrl(value) {
  const normalized = text(value, 3000);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return normalized.replace(/\/$/u, '');
  }
}

function patrolTargets(source = {}) {
  const value = Array.isArray(source) ? source : [];
  return value.map(target => {
    const normalized = safeJson(target);
    return {
      accountId: text(
        normalized.subscriptionId ||
          normalized.subscription_id ||
          normalized.recordId ||
          normalized.record_id ||
          normalized.externalId ||
          normalized.external_id,
        240,
      ).toLowerCase(),
      accountUrl: contractUrl(
        normalized.accountUrl ||
          normalized.account_url ||
          normalized.url,
      ),
    };
  });
}

function patrolTargetsMatch(expected = [], observed = []) {
  const expectedTargets = patrolTargets(expected);
  const observedTargets = patrolTargets(observed);
  if (
    expectedTargets.length === 0 ||
    expectedTargets.length !== observedTargets.length
  ) {
    return false;
  }
  return expectedTargets.every((target, index) => {
    const actual = observedTargets[index];
    return Boolean(
      actual &&
      (!target.accountId || actual.accountId === target.accountId) &&
      (!target.accountUrl || actual.accountUrl === target.accountUrl),
    );
  });
}

function expectedContractFieldMatches(
  expected,
  observed,
  key,
  normalizer = value => text(value, 240).toLowerCase(),
) {
  const expectedValue = ownContractValue(expected, [key]);
  if (expectedValue === undefined) return true;
  return normalizer(observed?.[key]) === normalizer(expectedValue);
}

export function createCommandSnapshotMatches(commandPayload = {}, snapshot = {}) {
  const payload = safeJson(commandPayload);
  const observed = safeJson(snapshot);
  const observedMetadata = safeJson(observed.metadata);
  const expectedWorkflow = text(
    payload.workflow || payload.taskKind || payload.taskType,
    80,
  );
  // Official-comment patrol may be either a direct post capture or an account
  // profile scan. A matching task id alone is therefore not execution proof.
  if (expectedWorkflow !== 'official_account_comment_patrol') return true;
  const observedWorkflow = text(
    observed.workflow ||
      observedMetadata.workflow ||
      observed.taskType ||
      observed.featureKey,
    80,
  );
  if (observedWorkflow !== expectedWorkflow) return false;
  const expectedProfileMode = profilePatrolIntent(payload);
  if (expectedProfileMode === null) return false;
  const observedProfileMode = profilePatrolIntent({
    ...observedMetadata,
    ...observed,
  });
  if (observedProfileMode !== expectedProfileMode) return false;

  const expectedProtocolVersion = ownContractValue(
    payload,
    ['protocolVersion', 'protocol_version'],
  );
  const observedProtocolVersion = observedContractValue(
    observed,
    observedMetadata,
    ['protocolVersion', 'protocol_version'],
  );
  if (
    expectedProtocolVersion !== undefined &&
    contractInteger(observedProtocolVersion) !==
      contractInteger(expectedProtocolVersion)
  ) {
    return false;
  }

  const expectedSubjectType = ownContractValue(
    payload,
    ['subjectType', 'subject_type'],
  );
  const observedSubjectType = observedContractValue(
    observed,
    observedMetadata,
    ['subjectType', 'subject_type'],
  );
  if (
    expectedSubjectType !== undefined &&
    text(observedSubjectType, 80).toLowerCase() !==
      text(expectedSubjectType, 80).toLowerCase()
  ) {
    return false;
  }

  const expectedTargets = ownContractValue(payload, ['targets', 'items']);
  const observedTargets = observedContractValue(
    observed,
    observedMetadata,
    ['targets', 'items'],
  );
  if (!patrolTargetsMatch(expectedTargets, observedTargets)) return false;

  const expectedMonitorSettings = safeJson(
    ownContractValue(payload, ['monitorSettings', 'monitor_settings']),
  );
  const observedMonitorSettings = safeJson(observedContractValue(
    observed,
    observedMetadata,
    ['monitorSettings', 'monitor_settings'],
  ));
  for (const key of [
    'publishWindow',
    'publishDateFrom',
    'publishDateTo',
  ]) {
    if (!expectedContractFieldMatches(
      expectedMonitorSettings,
      observedMonitorSettings,
      key,
      value => text(value, 100),
    )) {
      return false;
    }
  }

  const expectedCaptureSettings = safeJson(
    ownContractValue(payload, ['captureSettings', 'capture_settings']),
  );
  const observedCaptureSettings = safeJson(observedContractValue(
    observed,
    observedMetadata,
    ['captureSettings', 'capture_settings'],
  ));
  for (const key of [
    'includeComments',
    'includeCommentsOnDetailCapture',
    'scanLatestPostsByCount',
  ]) {
    if (!expectedContractFieldMatches(
      expectedCaptureSettings,
      observedCaptureSettings,
      key,
      contractBoolean,
    )) {
      return false;
    }
  }
  if (!expectedContractFieldMatches(
    expectedCaptureSettings,
    observedCaptureSettings,
    'commentsMaxDetectedItems',
    contractInteger,
  )) {
    return false;
  }
  return expectedContractFieldMatches(
    expectedMonitorSettings,
    observedMonitorSettings,
    'postsLimit',
    contractInteger,
  );
}

export function isProfilePatrolTask(taskOrType = {}, payload = {}) {
  const task = typeof taskOrType === 'string'
    ? {task_type: taskOrType}
    : safeJson(taskOrType);
  const metadata = safeJson(task.metadata);
  const commandPayload = safeJson(payload);
  const taskType = text(
    task.task_type ||
      task.taskType ||
      task.workflow ||
      metadata.workflow ||
      commandPayload.workflow ||
      commandPayload.taskType,
    80,
  );
  if ([
    'followed_creator_post_patrol',
    'official_account_post_discovery',
  ].includes(taskType)) {
    return true;
  }
  if (taskType !== 'official_account_comment_patrol') {
    return false;
  }
  const taskIntent = profilePatrolIntent(task);
  if (taskIntent !== null) return taskIntent;
  const metadataIntent = profilePatrolIntent(metadata);
  if (metadataIntent !== null) return metadataIntent;
  const payloadIntent = profilePatrolIntent(commandPayload);
  return payloadIntent === true;
}

async function syncProfileDiscoverySubscriptions(
  tx,
  tenantId,
  executionIds = [],
) {
  const ids = [...new Set(
    executionIds
      .map(id => text(id, 100).toLowerCase())
      .filter(id => UUID_PATTERN.test(id)),
  )];
  if (ids.length === 0) return;
  await tx.execute(`
    UPDATE monitor_subscriptions subscription
    SET last_run_at = COALESCE(execution.finished_at, now()),
      next_run_at = CASE
        WHEN execution.status = 'failed'
          THEN now() + interval '15 minutes'
        ELSE now() + make_interval(mins => subscription.cadence_minutes)
      END,
      last_error = CASE
        WHEN execution.status IN ('failed', 'cancelled')
          THEN execution.error_message
        ELSE ''
      END,
      updated_at = now()
    FROM monitor_executions execution
    WHERE execution.tenant_id = $1
      AND execution.id = ANY($2::uuid[])
      AND subscription.id = execution.subscription_id
      AND subscription.tenant_id = execution.tenant_id
      AND execution.status IN ('succeeded', 'failed', 'cancelled')
  `, [tenantId, ids]);
}

async function failProfileDiscoveryWork(tx, {
  tenantId,
  taskId,
  task = {},
  taskType,
  payload = {},
  code,
  message,
}) {
  if (!isProfilePatrolTask(
    Object.keys(safeJson(task)).length > 0
      ? task
      : {task_type: taskType},
    payload,
  )) {
    return {itemCount: 0, executionCount: 0};
  }
  const safeCode = text(code, 120) || 'profile_scan_dispatch_failed';
  const safeMessage = text(message, 1000) || '账号巡查任务未能下发到设备';
  const failedItems = await tx.queryAll(`
    UPDATE capture_task_items
    SET status = 'failed',
      error = error || jsonb_build_object(
        'code', $3::text,
        'message', $4::text
      ),
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
    WHERE tenant_id = $1
      AND execution_task_id = $2
      AND status NOT IN (
        'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
      )
    RETURNING id
  `, [tenantId, taskId, safeCode, safeMessage]);
  await tx.execute(`
    UPDATE capture_task_item_attempts
    SET status = 'failed',
      error = error || jsonb_build_object(
        'code', $3::text,
        'message', $4::text
      ),
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
    WHERE tenant_id = $1
      AND execution_task_id = $2
      AND status NOT IN (
        'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
      )
  `, [tenantId, taskId, safeCode, safeMessage]);
  const failedExecutions = await tx.queryAll(`
    UPDATE monitor_executions execution
    SET status = 'failed',
      error_message = $3,
      finished_at = COALESCE(execution.finished_at, now()),
      updated_at = now()
    FROM capture_task_items item
    WHERE item.tenant_id = $1
      AND item.execution_task_id = $2
      AND item.metadata->>'monitorExecutionId' = execution.id::text
      AND execution.tenant_id = item.tenant_id
      AND execution.status IN ('pending', 'running')
    RETURNING execution.id
  `, [tenantId, taskId, safeMessage]);
  await syncProfileDiscoverySubscriptions(
    tx,
    tenantId,
    failedExecutions.map(execution => execution.id),
  );
  return {
    itemCount: failedItems.length,
    executionCount: failedExecutions.length,
  };
}

async function cancelProfileDiscoveryWork(tx, {
  tenantId,
  taskId,
  task = {},
  payload = {},
  message = '账号扫描任务已停止',
}) {
  if (!isProfilePatrolTask(task, payload)) {
    return {itemCount: 0, executionCount: 0};
  }
  const canceledItems = await tx.queryAll(`
    UPDATE capture_task_items
    SET status = 'canceled',
      error = error || jsonb_build_object(
        'code', 'profile_scan_canceled',
        'message', $3::text
      ),
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
    WHERE tenant_id = $1
      AND execution_task_id = $2
      AND status NOT IN (
        'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
      )
    RETURNING id
  `, [tenantId, taskId, text(message, 1000)]);
  if (canceledItems.length > 0) {
    await tx.execute(`
      UPDATE capture_task_item_attempts
      SET status = 'canceled',
        error = error || jsonb_build_object(
          'code', 'profile_scan_canceled',
          'message', $3::text
        ),
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
      WHERE tenant_id = $1
        AND execution_task_id = $2
        AND status NOT IN (
          'completed', 'completed_with_warnings', 'failed', 'skipped',
          'canceled'
        )
    `, [tenantId, taskId, text(message, 1000)]);
  }
  const canceledExecutions = await tx.queryAll(`
    UPDATE monitor_executions execution
    SET status = 'cancelled',
      error_message = $3,
      finished_at = COALESCE(execution.finished_at, now()),
      updated_at = now()
    FROM capture_task_items item
    WHERE item.tenant_id = $1
      AND item.execution_task_id = $2
      AND item.metadata->>'monitorExecutionId' = execution.id::text
      AND execution.tenant_id = item.tenant_id
      AND execution.status IN ('pending', 'running')
    RETURNING execution.id
  `, [tenantId, taskId, text(message, 1000)]);
  await syncProfileDiscoverySubscriptions(
    tx,
    tenantId,
    canceledExecutions.map(execution => execution.id),
  );
  return {
    itemCount: canceledItems.length,
    executionCount: canceledExecutions.length,
  };
}

export function negativePatrolTargetResults(snapshot = {}) {
  const checkpoint = safeJson(snapshot?.checkpoint);
  const rawResults = Array.isArray(snapshot?.targetResults)
    ? snapshot.targetResults
    : Array.isArray(checkpoint.targetResults)
      ? checkpoint.targetResults
      : [];
  const results = [];
  const seen = new Set();
  for (const rawEntry of rawResults.slice(0, 100)) {
    const entry = safeJson(rawEntry);
    const itemId = text(entry.itemId || entry.item_id, 100).toLowerCase();
    const recordId = text(entry.recordId || entry.record_id, 100).toLowerCase();
    const externalId = text(
      entry.externalId || entry.external_id,
      200,
    );
    const rawStatus = text(entry.status, 80)
      .toLowerCase()
      .replace(/[\s-]+/gu, '_');
    const error = sanitizeCloudStructuredObject(entry.error);
    const syncFailed = text(error.stage, 80).toLowerCase() === 'sync';
    const status = syncFailed && NEGATIVE_PATROL_SUCCESS_STATUSES.has(rawStatus)
      ? 'failed'
      : rawStatus;
    if (
      !UUID_PATTERN.test(itemId) ||
      !UUID_PATTERN.test(recordId) ||
      !/^[a-z0-9_-]{5,200}$/iu.test(externalId) ||
      !NEGATIVE_PATROL_RESULT_STATUSES.has(status) ||
      seen.has(itemId)
    ) {
      continue;
    }
    seen.add(itemId);
    results.push({
      ...sanitizeCloudStructuredObject(entry),
      itemId,
      recordId,
      externalId,
      ordinal: orchestrationCheckpointInteger(entry.ordinal),
      status,
      startedAt: orchestrationCheckpointTimestamp(
        entry.startedAt || entry.started_at,
      ),
      finishedAt: orchestrationCheckpointTimestamp(
        entry.finishedAt || entry.finished_at,
      ),
      error,
    });
  }
  return results.sort((left, right) => left.ordinal - right.ordinal);
}

function targetResultContentAvailability(entry = {}) {
  const source = safeJson(entry);
  const availability = safeJson(source.availability);
  const availabilityEvidence = Array.isArray(availability.evidence)
    ? {
        signals: availability.evidence
          .map(value => text(value, 160))
          .filter(Boolean)
          .slice(0, 8),
      }
    : sanitizeCloudStructuredObject(availability.evidence);
  const businessOutcome = text(
    source.businessOutcome || source.business_outcome,
    80,
  ).toLowerCase();
  const unavailableStatus = text(
    source.availabilityStatus ||
      source.availability_status ||
      availability.availabilityStatus ||
      availability.availability_status,
    80,
  ).toLowerCase();
  if (
    source.status === 'skipped' &&
    businessOutcome === 'post_unavailable' &&
    CONTENT_UNAVAILABLE_STATUSES.has(unavailableStatus)
  ) {
    return {
      status: unavailableStatus,
      checkedAt: orchestrationCheckpointTimestamp(
        availability.observedAt ||
          availability.observed_at ||
          source.finishedAt ||
          source.finished_at,
      ),
      reason: text(
        availability.reason || 'post_deleted_or_unavailable',
        240,
      ),
      evidence: availabilityEvidence,
    };
  }
  if (NEGATIVE_PATROL_SUCCESS_STATUSES.has(source.status)) {
    const checkedAt = orchestrationCheckpointTimestamp(
      source.finishedAt || source.finished_at,
    );
    // A legacy result without an observation time cannot prove that it is
    // newer than a deleted/unavailable observation already stored server-side.
    if (!checkedAt) return null;
    return {
      status: 'available',
      checkedAt,
      reason: '',
      evidence: {},
    };
  }
  return null;
}

export function orchestrationCheckpointEntries(snapshot) {
  const checkpoint = safeJson(snapshot?.checkpoint);
  const progress = safeJson(snapshot?.progress);
  const entries = Array.isArray(checkpoint.keywordResults)
    ? checkpoint.keywordResults
      .map(entry => safeJson(entry))
      .filter(entry => text(entry.keyword, 120))
    : [];
  const groupedByKeyword = new Map();
  for (const rawEntry of entries) {
    const keyword = text(rawEntry.keyword, 120);
    const entry = {...rawEntry};
    delete entry.searchPassResults;
    const group = groupedByKeyword.get(keyword) || {
      representative: null,
      searchPassResults: [],
    };
    group.searchPassResults.push(entry);
    const currentRound = Math.max(1, Number(entry.round) || 1);
    const representativeRound = Math.max(
      1,
      Number(group.representative?.round) || 1,
    );
    if (!group.representative || currentRound >= representativeRound) {
      group.representative = entry;
    }
    groupedByKeyword.set(keyword, group);
  }
  const byKeyword = new Map(
    Array.from(groupedByKeyword.entries(), ([keyword, group]) => {
      const searchPassResults = group.searchPassResults
        .sort((left, right) =>
          Math.max(1, Number(left.round) || 1) -
          Math.max(1, Number(right.round) || 1),
        );
      return [
        keyword,
        {
          ...group.representative,
          searchPassResults,
        },
      ];
    }),
  );
  const activeKeyword = text(
    progress.keyword ||
      progress.currentKeyword ||
      checkpoint.currentKeyword ||
      checkpoint.activeKeyword,
    120,
  );
  const existingEntry = byKeyword.get(activeKeyword);
  const existingStatus = existingEntry
    ? checkpointEntryToItemStatus(existingEntry)
    : '';
  const activeRound = Math.max(
    1,
    Number(progress.round) || 0,
    Number(progress.roundCurrent) || 0,
    Number(checkpoint.round) || 0,
  );
  const existingRound = Math.max(1, Number(existingEntry?.round) || 1);
  const taskIsActivelyExecuting = ['claimed', 'running', 'recovering'].includes(
    text(snapshot?.status, 80),
  );
  // settleUnattendedKeywordCheckpoint intentionally retains activeKeyword and
  // activePhase after a keyword finishes, including in the final completed
  // snapshot. Only a genuinely active child task may project a running item,
  // and it must never overwrite an already terminal keyword result.
  if (
    activeKeyword &&
    taskIsActivelyExecuting &&
    (
      !ORCHESTRATION_ITEM_TERMINAL_STATUSES.has(existingStatus) ||
      existingRound < activeRound
    )
  ) {
    byKeyword.set(activeKeyword, {
      ...safeJson(existingEntry),
      keyword: activeKeyword,
      status: 'running',
      round: activeRound,
      index: Math.max(
        0,
        Number(checkpoint.activeKeywordIndex ?? checkpoint.keywordIndex) || 0,
      ),
    });
  }
  return Array.from(byKeyword.values());
}

function sequentialSearchResumeEntry(entry = {}, keyword = '') {
  const source = safeJson(entry);
  return {
    round: Math.max(1, Number(source.round) || 1),
    index: 0,
    keyword: text(keyword || source.keyword, 120),
    status: 'completed',
    attemptCount: Math.max(0, Number(source.attemptCount) || 0),
    savedCount: Math.max(0, Number(source.savedCount) || 0),
    ...(source.noResults === true || source.no_results === true
      ? {noResults: true}
      : {}),
    ...(text(source.resultKind || source.result_kind, 80)
      ? {resultKind: text(source.resultKind || source.result_kind, 80)}
      : {}),
    ...(source.candidateCount !== undefined || source.candidate_count !== undefined
      ? {
          candidateCount: orchestrationCheckpointInteger(
            source.candidateCount ?? source.candidate_count,
          ),
        }
      : {}),
    ...(source.scanComplete === true || source.scan_complete === true
      ? {scanComplete: true}
      : {}),
    error: '',
    finishedAt: orchestrationCheckpointTimestamp(source.finishedAt),
  };
}

export function buildSequentialSearchResumeCheckpoint({
  planSnapshot = {},
  itemMetadata = {},
  keyword = '',
  now = new Date(),
} = {}) {
  const plan = safeJson(planSnapshot);
  const normalizedKeyword = text(keyword, 120);
  const searchPasses = Array.isArray(plan.searchPasses)
    ? plan.searchPasses.map(pass => text(pass, 80)).filter(Boolean)
    : [];
  if (
    text(plan.platform, 80).toLowerCase() !== 'douyin' ||
    searchPasses.length < 2 ||
    !normalizedKeyword
  ) {
    return null;
  }

  const checkpoint = safeJson(safeJson(itemMetadata).checkpoint);
  const passResults = Array.isArray(checkpoint.searchPassResults)
    ? checkpoint.searchPassResults
    : [];
  const latestByRound = new Map();
  for (const result of passResults) {
    const source = safeJson(result);
    if (text(source.keyword, 120) !== normalizedKeyword) continue;
    const round = Math.max(1, Number(source.round) || 1);
    if (round > searchPasses.length) continue;
    latestByRound.set(round, source);
  }

  const completedPrefix = [];
  for (let round = 1; round <= searchPasses.length; round += 1) {
    const result = latestByRound.get(round);
    if (text(result?.status, 80).toLowerCase() !== 'completed') break;
    completedPrefix.push(sequentialSearchResumeEntry(result, normalizedKeyword));
  }
  if (
    completedPrefix.length === 0 ||
    completedPrefix.length >= searchPasses.length
  ) {
    return null;
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const updatedAt = Number.isFinite(nowDate.getTime())
    ? nowDate.toISOString()
    : new Date().toISOString();
  return {
    schemaVersion: 1,
    round: completedPrefix.length + 1,
    activeKeywordIndex: 0,
    activeKeyword: '',
    activePhase: 'pending',
    keywordResults: completedPrefix,
    updatedAt,
  };
}

function orchestrationItemAttemptStatus(itemStatus) {
  // Item attempts start at dispatch, so a checkpoint entry with no meaningful
  // status must not move the append-only audit back to a pre-dispatch state.
  return itemStatus === 'pending' || itemStatus === 'assigned'
    ? 'dispatched'
    : itemStatus;
}

async function lockOrchestrationParent(tx, tenantId, parentTaskId) {
  return tx.queryOne(`
    SELECT id, title, status, progress, metadata, feature_key,
      orchestration_revision,
      orchestration_schedule_id, scheduled_for
    FROM capture_tasks
    WHERE id = $1 AND tenant_id = $2
      AND task_type = 'capture_orchestration'
    FOR UPDATE
  `, [parentTaskId, tenantId]);
}

async function adoptLocalOrchestrationRecovery(tx, agent, task, snapshot) {
  if (
    !task ||
    task.parent_task_id ||
    task.task_type !== 'unattended_keyword_capture'
  ) {
    return task;
  }
  const snapshotMetadata = safeJson(snapshot.metadata);
  const parentRequestId = text(snapshotMetadata.parentRequestId, 240);
  if (!parentRequestId || snapshotMetadata.cloudAssigned !== true) {
    return task;
  }

  const lineageTasks = [];
  let lineageClientTaskId = parentRequestId;
  let sourceCandidate = null;
  for (let depth = 0; depth < 6 && lineageClientTaskId; depth += 1) {
    const candidate = await tx.queryOne(`
      SELECT id, client_task_id, parent_task_id, assigned_agent_id,
        status, metadata
      FROM capture_tasks
      WHERE tenant_id = $1
        AND origin_agent_id = $2
        AND client_task_id = $3
        AND id <> $4
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `, [agent.tenant_id, agent.id, lineageClientTaskId, task.id]);
    if (
      !candidate ||
      lineageTasks.some(lineageTask => String(lineageTask.id) === String(candidate.id))
    ) {
      break;
    }
    lineageTasks.push(candidate);
    if (candidate.parent_task_id) {
      sourceCandidate = candidate;
      break;
    }
    lineageClientTaskId = text(
      safeJson(candidate.metadata).parentRequestId,
      240,
    );
  }
  if (!sourceCandidate?.parent_task_id) return task;
  const sourceTask = await tx.queryOne(`
    SELECT id, parent_task_id, assigned_agent_id, status, metadata
    FROM capture_tasks
    WHERE id = $1 AND tenant_id = $2 AND parent_task_id = $3
    FOR UPDATE
  `, [
    sourceCandidate.id,
    agent.tenant_id,
    sourceCandidate.parent_task_id,
  ]);
  if (!sourceTask?.parent_task_id) return task;

  const sourceMetadata = safeJson(sourceTask.metadata);
  const recordedSuccessorId = text(
    sourceMetadata.recoveryTaskId || sourceMetadata.handoffSuccessorTaskId,
    240,
  );
  if (!orchestrationRecoverySuccessorMatches({
    recordedSuccessorId,
    recoveryTask: task,
    lineageTasks,
  })) {
    return task;
  }
  const parent = await lockOrchestrationParent(
    tx,
    agent.tenant_id,
    sourceTask.parent_task_id,
  );
  if (
    !parent ||
    ['canceled', 'superseded'].includes(parent.status) ||
    safeJson(parent.metadata).orchestrationTemplate === true ||
    safeJson(parent.metadata).executionMode === 'unattended_plan'
  ) {
    return task;
  }

  const authoritativeItemIds = new Set(
    (Array.isArray(sourceMetadata.itemIds) ? sourceMetadata.itemIds : [])
      .map(itemId => text(itemId, 100))
      .filter(value => UUID_PATTERN.test(value)),
  );
  const desiredKeywords = new Set(
    (Array.isArray(snapshotMetadata.keywords) ? snapshotMetadata.keywords : [])
      .map(keyword => text(keyword, 120))
      .filter(Boolean),
  );
  const sourceItems = await tx.queryAll(`
    SELECT id, keyword, ordinal, status, attempt_count,
      assignment_revision
    FROM capture_task_items
    WHERE tenant_id = $1
      AND task_id = $2
      AND execution_task_id = $3
      AND assigned_agent_id = $4
      AND status IN ('retryable', 'needs_action', 'failed')
    ORDER BY id
    FOR UPDATE
  `, [
    agent.tenant_id,
    parent.id,
    sourceTask.id,
    agent.id,
  ]);
  const eligibleItems = sourceItems
    .filter(item =>
      (authoritativeItemIds.size === 0 || authoritativeItemIds.has(String(item.id))) &&
      (desiredKeywords.size === 0 || desiredKeywords.has(text(item.keyword, 120)))
    )
    .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
    .slice(0, 30);
  if (eligibleItems.length === 0) return task;

  const nextRevision = Number(parent.orchestration_revision || 0) + 1;
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      parentTaskId: parent.id,
      sourceTaskId: sourceTask.id,
      recoveryTaskId: task.id,
      itemIds: eligibleItems.map(item => item.id),
      attemptNumber: Math.max(1, Number(snapshot.attemptNumber) || 1),
    }))
    .digest('hex');
  const adoptedTask = await tx.queryOne(`
    UPDATE capture_tasks
    SET parent_task_id = $1,
      title = $2,
      trigger_type = 'orchestration_local_recovery',
      metadata = metadata || jsonb_build_object(
        'orchestrationChild', true,
        'parentTaskId', $1::uuid::text,
        'orchestrationRevision', $3::integer,
        'itemIds', $4::jsonb,
        'localRecovery', true,
        'localRecoverySourceExecutionTaskId', $5::uuid::text,
        'localRecoveryAdoptedAt', now()
      ),
      updated_at = now(),
      source_updated_at = now()
    WHERE id = $6 AND tenant_id = $7 AND parent_task_id IS NULL
    RETURNING *
  `, [
    parent.id,
    `${text(parent.title || '无人值守计划运行批次', 180)} · 设备重试`,
    nextRevision,
    JSON.stringify(eligibleItems.map(item => item.id)),
    sourceTask.id,
    task.id,
    agent.tenant_id,
  ]);
  if (!adoptedTask) return task;

  const detachedLineageTaskIds = lineageTasks
    .map(lineageTask => String(lineageTask.id))
    .filter(lineageTaskId =>
      lineageTaskId !== String(sourceTask.id) &&
      lineageTaskId !== String(adoptedTask.id)
    );
  if (detachedLineageTaskIds.length > 0) {
    await tx.execute(`
      UPDATE capture_tasks
      SET parent_task_id = $1,
        metadata = metadata || jsonb_build_object(
          'orchestrationChild', true,
          'parentTaskId', $1::uuid::text,
          'orchestrationRecoveryLineageOnly', true,
          'orchestrationLineageAdoptedAt', now()
        ),
        updated_at = now()
      WHERE tenant_id = $2
        AND id = ANY($3::uuid[])
        AND parent_task_id IS NULL
    `, [parent.id, agent.tenant_id, detachedLineageTaskIds]);
  }

  for (const item of eligibleItems) {
    const updatedItem = await tx.queryOne(`
      UPDATE capture_task_items
      SET status = 'dispatched',
        attempt_count = attempt_count + 1,
        assigned_agent_id = $1,
        execution_task_id = $2,
        assignment_revision = $3,
        request_hash = $4,
        error = '{}'::jsonb,
        metadata = metadata || jsonb_build_object(
          'localRecoverySourceExecutionTaskId', $5::uuid::text
        ),
        assigned_at = now(),
        dispatched_at = now(),
        started_at = NULL,
        finished_at = NULL,
        updated_at = now()
      WHERE id = $6
        AND tenant_id = $7
        AND task_id = $8
        AND execution_task_id = $5
        AND assignment_revision = $9
        AND status IN ('retryable', 'needs_action', 'failed')
      RETURNING id, attempt_count
    `, [
      agent.id,
      adoptedTask.id,
      nextRevision,
      requestHash,
      sourceTask.id,
      item.id,
      agent.tenant_id,
      parent.id,
      Number(item.assignment_revision || 0),
    ]);
    if (!updatedItem) {
      const error = new Error('orchestration_local_recovery_item_conflict');
      error.code = 'orchestration_local_recovery_item_conflict';
      throw error;
    }
    await tx.execute(`
      INSERT INTO capture_task_item_attempts (
        id, tenant_id, item_id, parent_task_id, execution_task_id,
        agent_id, attempt_number, assignment_revision, status,
        request_hash, checkpoint, result, error, dispatched_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, 'dispatched',
        $9, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
      )
    `, [
      crypto.randomUUID(),
      agent.tenant_id,
      item.id,
      parent.id,
      adoptedTask.id,
      agent.id,
      Number(updatedItem.attempt_count),
      nextRevision,
      requestHash,
    ]);
  }
  await tx.execute(`
    UPDATE capture_tasks
    SET status = 'superseded',
      metadata = metadata || jsonb_build_object(
        'recoveryTaskId', $1::uuid::text,
        'localRecoveryAdoptedAt', now()
      ),
      message = '设备端重试已归入同一无人值守父任务',
      finished_at = COALESCE(finished_at, now()),
      updated_at = now(),
      source_updated_at = now()
    WHERE id = $2 AND tenant_id = $3
  `, [adoptedTask.id, sourceTask.id, agent.tenant_id]);
  await tx.execute(`
    UPDATE capture_tasks
    SET orchestration_revision = $1,
      status = 'running',
      metadata = metadata || jsonb_build_object(
        'lastLocalRecoveryAt', now(),
        'lastLocalRecoverySourceExecutionTaskId', $2::uuid::text,
        'lastLocalRecoveryTaskId', $3::uuid::text
      ),
      message = '设备端重试已归入本轮无人值守任务',
      finished_at = NULL,
      updated_at = now(),
      source_updated_at = now()
    WHERE id = $4 AND tenant_id = $5
      AND orchestration_revision = $6
  `, [
    nextRevision,
    sourceTask.id,
    adoptedTask.id,
    parent.id,
    agent.tenant_id,
    Number(parent.orchestration_revision || 0),
  ]);
  await appendEvent(tx, {
    tenantId: agent.tenant_id,
    taskId: parent.id,
    agentId: agent.id,
    eventType: 'orchestration_local_recovery_adopted',
    actorType: 'capture_agent',
    actorId: agent.id,
    actorName: agent.display_name || agent.client_label,
    status: 'running',
    message: '设备端重试已合并到原无人值守任务',
    payload: {
      sourceExecutionTaskId: sourceTask.id,
      recoveryTaskId: adoptedTask.id,
      revision: nextRevision,
      itemIds: eligibleItems.map(item => item.id),
    },
  });
  return adoptedTask;
}

async function refreshOrchestrationParentTask(tx, {
  tenantId,
  parentTaskId,
  parent: lockedParent = null,
  agent = null,
  snapshot = {},
  childTaskId = '',
  actorType = 'system',
  actorId = '',
  actorName = '',
  eventAgentId = null,
}) {
  const parent = lockedParent ||
    await lockOrchestrationParent(tx, tenantId, parentTaskId);
  if (!parent) return null;
  if (['canceled', 'superseded'].includes(parent.status)) return parent;
  const parentMetadata = safeJson(parent.metadata);
  const elasticPool = parentMetadata.distributionMode === 'elastic_pool';

  if (!elasticPool) {
    // Fixed-device patrols remain single-shot. Elastic patrols use their own
    // bounded handoff budget: one different Agent may continue an unfinished
    // sequential search pass, and a second safety failure becomes manual.
    await tx.execute(`
      UPDATE capture_task_items
      SET status = 'needs_action',
        metadata = metadata || jsonb_build_object(
          'automaticRetrySuppressed', true,
          'requiresManualAction', true
        ),
        error = error || jsonb_build_object(
          'automaticRetrySuppressed', true,
          'requiresManualAction', true
        ),
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
      WHERE task_id = $1
        AND tenant_id = $2
        AND status = 'retryable'
        AND started_at IS NOT NULL
        AND COALESCE(metadata->>'disableAutomaticSearchRetry', 'false') = 'true'
    `, [parentTaskId, tenantId]);
  }

  const items = await tx.queryAll(`
    SELECT status
    FROM capture_task_items
    WHERE task_id = $1 AND tenant_id = $2
    ORDER BY ordinal, id
  `, [parentTaskId, tenantId]);
  const aggregate = aggregateParentTaskItems(items);
  if (
    elasticPool &&
    aggregate.status === 'needs_action' &&
    Number(aggregate.counts.retryable || 0) > 0 &&
    Number(aggregate.counts.needsAction || 0) === 0
  ) {
    // retryable 是弹性队列的主动恢复状态，不是人工待办。父任务继续保持
    // running，详情页也会持续刷新，直到其它 Agent 领取或尝试真正耗尽。
    aggregate.status = 'running';
    aggregate.terminal = false;
  }
  const negativePatrol =
    parent.feature_key === 'negative_post_patrol' ||
    parentMetadata.workflow === 'negative_post_patrol';
  const watchedContentPatrol =
    parent.feature_key === 'watched_content_patrol' ||
    parentMetadata.workflow === 'watched_content_patrol';
  const contentPatrol = negativePatrol || watchedContentPatrol;
  const contentPatrolLabel = watchedContentPatrol ? '关注内容' : '负面帖子';
  const profilePatrol = [
    'official_account_comment_patrol',
    'followed_creator_post_patrol',
    'official_account_post_discovery',
  ].includes(promotedRetryBusinessTaskType(parent));
  const previousProgress = safeJson(parent.progress);
  const settledProgressChanged =
    Number(previousProgress.current || 0) !== aggregate.progress.current ||
    Number(previousProgress.total || 0) !== aggregate.progress.total;
  const reportedBusinessProgressAt = orchestrationCheckpointTimestamp(
    snapshot.businessProgressAt,
  );
  const message = aggregate.status === 'running'
    ? elasticPool && Number(aggregate.counts.retryable || 0) > 0
      ? contentPatrol
        ? `部分${contentPatrolLabel}正在自动恢复，等待空闲节点逐篇接力`
        : profilePatrol
          ? '部分账号巡查项正在自动恢复，等待空闲节点接力'
          : '部分关键词正在自动恢复，等待空闲节点逐词接力'
      : contentPatrol
      ? `执行节点正在巡查${contentPatrolLabel}`
      : profilePatrol
        ? '执行节点正在重试未完成的账号巡查项'
      : '多个执行节点正在处理关键词工作项'
    : aggregate.status === 'needs_action'
      ? contentPatrol
        ? `部分${contentPatrolLabel}需要人工处理`
        : profilePatrol
          ? '部分账号巡查项仍需要处理'
        : '部分关键词工作项需要人工处理'
      : aggregate.terminal
        ? contentPatrol
          ? `${watchedContentPatrol ? '关注内容' : '多 Agent 负面帖子'}巡查已结算`
          : profilePatrol
        ? '账号巡查任务已结算'
          : '多 Agent 关键词任务已结算'
        : contentPatrol
          ? elasticPool
            ? `${contentPatrolLabel}保留在云端，等待空闲节点逐篇领取`
            : `${contentPatrolLabel}已分配，等待执行节点处理`
          : profilePatrol
            ? '账号巡查项已重新分配，等待执行节点处理'
          : '关键词工作项已分配，等待执行节点处理';

  const updated = await tx.queryOne(`
    UPDATE capture_tasks
    SET status = $1,
      progress = $2::jsonb,
      counts = $3::jsonb,
      message = $4,
      heartbeat_at = GREATEST(heartbeat_at, $5::timestamptz),
      business_progress_at = CASE
        WHEN $6::timestamptz IS NOT NULL THEN GREATEST(
          COALESCE(business_progress_at, $6::timestamptz),
          $6::timestamptz
        )
        WHEN $7::boolean THEN GREATEST(
          COALESCE(business_progress_at, now()),
          now()
        )
        ELSE business_progress_at
      END,
      finished_at = CASE
        WHEN $8::boolean THEN COALESCE(finished_at, $6::timestamptz, now())
        ELSE NULL
      END,
      source_updated_at = CASE
        WHEN $9::timestamptz IS NULL THEN source_updated_at
        ELSE GREATEST(source_updated_at, $9::timestamptz)
      END,
      updated_at = now()
    WHERE id = $10 AND tenant_id = $11
    RETURNING *
  `, [
    aggregate.status,
    JSON.stringify(aggregate.progress),
    JSON.stringify(aggregate.counts),
    message,
    orchestrationCheckpointTimestamp(snapshot.heartbeatAt),
    reportedBusinessProgressAt,
    settledProgressChanged,
    aggregate.terminal,
    orchestrationCheckpointTimestamp(snapshot.updatedAt || snapshot.heartbeatAt),
    parentTaskId,
    tenantId,
  ]);

  if (
    updated &&
    parent.status !== updated.status &&
    parent.orchestration_schedule_id &&
    safeJson(parent.metadata).orchestrationScheduleRun === true
  ) {
    const schedule = await tx.queryOne(`
      UPDATE capture_orchestration_schedules
      SET last_run_at = CASE
          WHEN $7::boolean THEN COALESCE($1::timestamptz, now())
          ELSE last_run_at
        END,
        last_run_status = $2,
        last_error = CASE
          WHEN $2 IN (
            'pending', 'running', 'completed',
            'completed_with_warnings', 'canceled'
          )
            THEN '{}'::jsonb
          WHEN $2 = 'needs_action'
            THEN jsonb_build_object(
              'code', 'scheduled_run_needs_action',
              'message', $3::text
            )
          ELSE jsonb_build_object(
            'code', 'scheduled_run_settled_with_failures',
            'message', $3::text
          )
        END,
        updated_at = now()
      WHERE id = $4
        AND tenant_id = $5
        AND last_run_task_id = $6
      RETURNING template_task_id, status, next_run_at, last_run_at
    `, [
      updated.finished_at,
      updated.status,
      message,
      parent.orchestration_schedule_id,
      tenantId,
      parent.id,
      aggregate.terminal,
    ]);
    if (schedule) {
      await tx.execute(`
        UPDATE capture_tasks
        SET metadata = metadata || jsonb_build_object(
            'scheduleStatus', $1::text,
            'nextRunAt', COALESCE($2::timestamptz::text, ''),
            'lastRunAt', COALESCE($3::timestamptz::text, ''),
            'lastRunStatus', $4::text,
            'lastRunTaskId', $5::uuid::text
          ),
          message = CASE
            WHEN $4 IN ('completed', 'completed_with_warnings')
              THEN '上一轮多 Agent 任务已结算，计划等待下一次运行'
            WHEN $4 = 'canceled'
              THEN '上一轮多 Agent 任务已停止，计划等待下一次运行'
            WHEN $4 = 'needs_action'
              THEN '上一轮有待处理项，可在云端重试失败关键词'
            WHEN $4 = 'running'
              THEN '上一轮多 Agent 任务正在执行'
            WHEN $4 = 'pending'
              THEN '上一轮多 Agent 任务已下发，等待执行节点'
            ELSE '上一轮多 Agent 任务有失败项，计划仍会按下一次时间运行'
          END,
          updated_at = now(),
          source_updated_at = now()
        WHERE id = $6 AND tenant_id = $7
      `, [
        schedule.status,
        schedule.next_run_at,
        schedule.last_run_at,
        updated.status,
        parent.id,
        schedule.template_task_id,
        tenantId,
      ]);
      await appendEvent(tx, {
        tenantId,
        taskId: schedule.template_task_id,
        agentId: agent?.id || eventAgentId || null,
        eventType: aggregate.terminal
          ? 'orchestration_schedule_run_settled'
          : 'orchestration_schedule_run_status_updated',
        actorType: agent ? 'capture_agent' : actorType,
        actorId: agent?.id || actorId,
        actorName: agent
          ? agent.display_name || agent.client_label
          : actorName,
        status: schedule.status,
        message: aggregate.terminal
          ? '无人值守计划的一轮多 Agent 任务已结算'
          : '无人值守计划的本轮状态已同步',
        payload: {
          runTaskId: parent.id,
          runStatus: updated.status,
          nextRunAt: schedule.next_run_at,
        },
      });
    }
  }

  if (updated && parent.status !== updated.status) {
    const resolvedEventAgentId =
      agent?.id || eventAgentId || null;
    await appendEvent(tx, {
      tenantId,
      taskId: parentTaskId,
      agentId: resolvedEventAgentId,
      eventType: 'orchestration_status_changed',
      actorType: agent ? 'capture_agent' : actorType,
      actorId: agent?.id || actorId,
      actorName: agent
        ? agent.display_name || agent.client_label
        : actorName,
      status: updated.status,
      message,
      payload: {
        previousStatus: parent.status,
        childTaskId: childTaskId || snapshot.clientTaskId || '',
        progress: aggregate.progress,
      },
    });
  }
  return updated;
}

async function projectNegativePatrolSnapshot(tx, agent, task, snapshot = {}) {
  if (
    !task ||
    !isTargetedPostTaskType(task.task_type) ||
    task.assigned_agent_id !== agent.id
  ) {
    return null;
  }

  const parentTaskId = text(task.parent_task_id, 100).toLowerCase();
  const orchestrationParent = parentTaskId
    ? await lockOrchestrationParent(tx, agent.tenant_id, parentTaskId)
    : null;
  if (
    parentTaskId &&
    (
      !orchestrationParent ||
      ['canceled', 'superseded'].includes(orchestrationParent.status)
    )
  ) {
    return null;
  }
  const elasticPool =
    safeJson(orchestrationParent?.metadata).distributionMode ===
      'elastic_pool';
  const itemOwnerTaskId = parentTaskId || task.id;
  const executionRevision = Math.max(
    0,
    Number(
      task.orchestration_revision ||
        safeJson(task.metadata).orchestrationRevision ||
        0,
    ) || 0,
  );
  const isProfilePatrol = isProfilePatrolTask(task);
  const projectedItemIds = [];
  for (const entry of negativePatrolTargetResults(snapshot)) {
    const currentItemState = elasticPool
      ? await tx.queryOne(`
          SELECT attempt_count, safety_handoff_count
          FROM capture_task_items
          WHERE tenant_id = $1
            AND task_id = $2
            AND execution_task_id = $3
            AND assigned_agent_id = $4
            AND id = $5::uuid
          FOR UPDATE
        `, [
          agent.tenant_id,
          itemOwnerTaskId,
          task.id,
          agent.id,
          entry.itemId,
        ])
      : null;
    const serverAttemptCount = Math.max(
      0,
      Number(currentItemState?.attempt_count) || 0,
    );
    const recoveryDisposition = classifyCaptureRecoveryDisposition({
      status: entry.status,
      error: entry.error,
      metadata: {checkpoint: entry},
      attempt_count: serverAttemptCount,
    });
    const recoverableStatus = recoveryDisposition.kind === 'manual_current'
      ? 'needs_action'
      : recoveryDisposition.automatic
        ? 'retryable'
        : 'failed';
    const projectedStatus = elasticPool && entry.status === 'failed'
      ? recoveryDisposition.kind === 'manual_current' || recoveryDisposition.automatic
        ? projectElasticKeywordRecoveryStatus({
            elasticPool,
            status: recoverableStatus,
            error: entry.error,
            checkpoint: entry,
            attemptCount: serverAttemptCount,
            safetyHandoffCount: currentItemState?.safety_handoff_count,
          })
        : 'failed'
      : entry.status;
    let resultObservationId = null;
    if (
      !isProfilePatrol &&
      NEGATIVE_PATROL_SUCCESS_STATUSES.has(entry.status) &&
      entry.startedAt
    ) {
      const observation = await tx.queryOne(`
        SELECT id
        FROM record_observations
        WHERE tenant_id = $1
          AND record_id = $2
          AND captured_at >= $3::timestamptz
        ORDER BY captured_at DESC, id DESC
        LIMIT 1
      `, [agent.tenant_id, entry.recordId, entry.startedAt]);
      resultObservationId = observation?.id || null;
    }

    const checkpoint = {
      itemId: entry.itemId,
      recordId: entry.recordId,
      externalId: entry.externalId,
      ordinal: entry.ordinal,
      status: projectedStatus,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
    };
    const recovery = buildElasticRecoveryMetadata({
      status: projectedStatus,
      error: entry.error,
      checkpoint: entry,
      attemptCount: serverAttemptCount,
      sourceAgentId: agent.id,
    });
    if (Object.keys(recovery).length > 0) {
      checkpoint.recovery = recovery;
    }
    const result = sanitizeCloudStructuredObject(entry);
    const terminal = NEGATIVE_PATROL_RESULT_STATUSES.has(projectedStatus);
    const item = await tx.queryOne(`
      UPDATE capture_task_items
      SET status = $1,
        attempt_count = GREATEST(attempt_count, 1),
        result_record_id = CASE
          WHEN $2::boolean AND NOT $18::boolean THEN record_id
          ELSE result_record_id
        END,
        result_observation_id = CASE
          WHEN $2::boolean THEN COALESCE($3::uuid, result_observation_id)
          ELSE result_observation_id
        END,
        error = $4::jsonb,
        metadata = metadata || jsonb_build_object(
          'checkpoint', $5::jsonb,
          'targetResult', $6::jsonb
        ),
        started_at = COALESCE(started_at, $7::timestamptz, now()),
        finished_at = CASE
          WHEN $8::boolean
            THEN COALESCE($9::timestamptz, finished_at, now())
          ELSE NULL
        END,
        updated_at = now()
      WHERE tenant_id = $10
        AND task_id = $11
        AND execution_task_id = $12
        AND assigned_agent_id = $13
        AND id = $14::uuid
        AND (
          (
            $18::boolean
            AND metadata->>'subscriptionId' = $15
          )
          OR (
            NOT $18::boolean
            AND record_id = $15::uuid
          )
        )
        AND external_id = $16
        AND assignment_revision = $17
        AND (capture_task_items.status <> 'canceled' OR $1 = 'canceled')
        AND (
          capture_task_items.status IS DISTINCT FROM $1
          OR capture_task_items.attempt_count < 1
          OR capture_task_items.error IS DISTINCT FROM $4::jsonb
          OR capture_task_items.metadata->'checkpoint'
            IS DISTINCT FROM $5::jsonb
          OR capture_task_items.metadata->'targetResult'
            IS DISTINCT FROM $6::jsonb
          OR (
            $2::boolean
            AND $3::uuid IS NOT NULL
            AND capture_task_items.result_observation_id
              IS DISTINCT FROM $3::uuid
          )
          OR (
            $2::boolean
            AND NOT $18::boolean
            AND capture_task_items.result_record_id
              IS DISTINCT FROM capture_task_items.record_id
          )
          OR capture_task_items.started_at IS NULL
          OR (
            $8::boolean
            AND capture_task_items.finished_at IS NULL
          )
        )
      RETURNING id, assignment_revision, result_record_id,
        result_observation_id
    `, [
      projectedStatus,
      NEGATIVE_PATROL_SUCCESS_STATUSES.has(projectedStatus),
      resultObservationId,
      JSON.stringify(entry.error),
      JSON.stringify(checkpoint),
      JSON.stringify(result),
      entry.startedAt,
      terminal,
      entry.finishedAt,
      agent.tenant_id,
      itemOwnerTaskId,
      task.id,
      agent.id,
      entry.itemId,
      entry.recordId,
      entry.externalId,
      executionRevision,
      isProfilePatrol,
    ]);
    if (!item) continue;
    projectedItemIds.push(item.id);

    await tx.execute(`
      UPDATE capture_task_item_attempts
      SET status = $1,
        checkpoint = $2::jsonb,
        result = $3::jsonb,
        error = $4::jsonb,
        started_at = COALESCE(started_at, $5::timestamptz, now()),
        finished_at = CASE
          WHEN $6::boolean
            THEN COALESCE($7::timestamptz, finished_at, now())
          ELSE NULL
        END,
        updated_at = now()
      WHERE id = (
        SELECT id
        FROM capture_task_item_attempts
        WHERE tenant_id = $8
          AND item_id = $9
          AND parent_task_id = $10
          AND execution_task_id = $11
          AND agent_id = $12
          AND assignment_revision = $13
          AND (
            capture_task_item_attempts.status <> 'canceled'
            OR $1 = 'canceled'
          )
        ORDER BY attempt_number DESC
        LIMIT 1
      )
    `, [
      orchestrationItemAttemptStatus(projectedStatus),
      JSON.stringify(checkpoint),
      JSON.stringify({
        ...result,
        resultRecordId: item.result_record_id || null,
        resultObservationId: item.result_observation_id || null,
      }),
      JSON.stringify(entry.error),
      entry.startedAt,
      terminal,
      entry.finishedAt,
      agent.tenant_id,
      item.id,
      itemOwnerTaskId,
      task.id,
      agent.id,
      item.assignment_revision,
    ]);

    if (isProfilePatrol && UUID_PATTERN.test(text(entry.executionId, 100))) {
      const monitorStatus =
        entry.status === 'canceled'
          ? 'cancelled'
          : NEGATIVE_PATROL_SUCCESS_STATUSES.has(entry.status) ||
              entry.status === 'skipped'
            ? 'succeeded'
            : 'failed';
      const updatedExecutions = await tx.queryAll(`
        UPDATE monitor_executions
        SET status = $1,
          records_found = GREATEST(
            records_found,
            LEAST(10000, GREATEST(0, $2::integer))
          ),
          error_message = CASE
            WHEN $1 = 'failed' THEN $3
            ELSE error_message
          END,
          finished_at = COALESCE(finished_at, now()),
          updated_at = now()
        WHERE id = $4::uuid
          AND tenant_id = $5
          AND status IN ('pending', 'running')
        RETURNING id
      `, [
        monitorStatus,
        Math.max(0, Number(entry.hitCount) || 0),
        text(entry.error?.message, 1000),
        entry.executionId,
        agent.tenant_id,
      ]);
      await syncProfileDiscoverySubscriptions(
        tx,
        agent.tenant_id,
        updatedExecutions.map(execution => execution.id),
      );
    }

    if ([
      'negative_post_patrol',
      'watched_content_patrol',
    ].includes(task.task_type)) {
      const availability = targetResultContentAvailability(entry);
      if (availability) {
        await tx.execute(`
          UPDATE records
          SET content_availability_status = $1,
            content_availability_checked_at = COALESCE(
              $2::timestamptz,
              now()
            ),
            content_availability_reason = $3,
            content_availability_evidence = $4::jsonb,
            updated_at = now()
          WHERE tenant_id = $5
            AND id = $6::uuid
            AND (
              content_availability_checked_at IS NULL
              OR content_availability_checked_at <= COALESCE(
                $2::timestamptz,
                now()
              )
            )
        `, [
          availability.status,
          availability.checkedAt,
          availability.reason,
          JSON.stringify(availability.evidence),
          agent.tenant_id,
          entry.recordId,
        ]);
      }
    }
  }

  const snapshotStatus = text(snapshot.status, 80);
  if (['claimed', 'running', 'recovering'].includes(snapshotStatus)) {
    const checkpoint = safeJson(snapshot.checkpoint);
    const nextOrdinal = orchestrationCheckpointInteger(
      checkpoint.nextOrdinal ?? checkpoint.targetIndex,
    );
    if (nextOrdinal > 0) {
      const activeItem = await tx.queryOne(`
        UPDATE capture_task_items
        SET status = 'running',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
        WHERE id = (
          SELECT id
          FROM capture_task_items
          WHERE tenant_id = $1
            AND task_id = $2
            AND execution_task_id = $3
            AND assigned_agent_id = $4
          ORDER BY ordinal, id
          OFFSET $5
          LIMIT 1
        )
          AND status IN ('assigned', 'dispatch_pending', 'dispatched', 'retryable')
        RETURNING id, assignment_revision
      `, [
        agent.tenant_id,
        itemOwnerTaskId,
        task.id,
        agent.id,
        nextOrdinal - 1,
      ]);
      if (activeItem) {
        await tx.execute(`
          UPDATE capture_task_item_attempts
          SET status = 'running',
            started_at = COALESCE(started_at, now()),
            updated_at = now()
          WHERE id = (
            SELECT id
            FROM capture_task_item_attempts
            WHERE tenant_id = $1
              AND item_id = $2
              AND execution_task_id = $3
              AND agent_id = $4
              AND assignment_revision = $5
            ORDER BY attempt_number DESC
            LIMIT 1
          )
        `, [
          agent.tenant_id,
          activeItem.id,
          task.id,
          agent.id,
          activeItem.assignment_revision,
        ]);
      }
    }
  }
  if (NEGATIVE_PATROL_TERMINAL_TASK_STATUSES.has(snapshotStatus)) {
    const unresolvedMessage = isProfilePatrol
      ? '设备任务已结束，但该账号没有返回可验证的扫描结果'
      : '设备任务已结束，但该帖子没有返回可验证的逐帖结果';
    const rawSnapshotError = snapshot.error;
    const snapshotError = {
      ...(rawSnapshotError && typeof rawSnapshotError === 'object'
        ? sanitizeCloudStructuredObject(rawSnapshotError)
        : text(rawSnapshotError, 1000)
          ? {message: text(rawSnapshotError, 1000)}
          : {}),
      ...(text(
        snapshot?.error?.code || snapshot?.errorCode || snapshot?.error_code,
        100,
      )
        ? {
            code: text(
              snapshot?.error?.code ||
                snapshot?.errorCode ||
                snapshot?.error_code,
              100,
            ),
          }
        : {}),
    };
    const unresolvedError = {
      ...snapshotError,
      code: text(snapshotError.code, 100) || 'missing_target_result',
      message: text(snapshotError.message, 1000) || unresolvedMessage,
    };
    const snapshotCheckpoint = safeJson(snapshot.checkpoint);
    const unresolvedItems = await tx.queryAll(`
      SELECT id, attempt_count, safety_handoff_count,
        assignment_revision, metadata, error
      FROM capture_task_items
      WHERE tenant_id = $1
        AND task_id = $2
        AND execution_task_id = $3
        AND assigned_agent_id = $4
        AND NOT (id = ANY($5::uuid[]))
        AND status NOT IN (
          'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
        )
      ORDER BY ordinal, id
      FOR UPDATE
    `, [
      agent.tenant_id,
      itemOwnerTaskId,
      task.id,
      agent.id,
      projectedItemIds,
    ]);
    for (const unresolvedItem of unresolvedItems) {
      const attemptCount = Math.max(
        0,
        Number(unresolvedItem.attempt_count) || 0,
      );
      const unresolvedStatus = snapshotStatus === 'canceled'
        ? 'canceled'
        : snapshotStatus === 'skipped'
          ? 'skipped'
          : elasticPool && !isProfilePatrol
            ? projectElasticKeywordRecoveryStatus({
                elasticPool: true,
                status: 'failed',
                error: unresolvedError,
                checkpoint: snapshotCheckpoint,
                attemptCount,
                safetyHandoffCount: unresolvedItem.safety_handoff_count,
              })
            : 'needs_action';
      const recovery = buildElasticRecoveryMetadata({
        status: unresolvedStatus,
        error: unresolvedError,
        checkpoint: snapshotCheckpoint,
        attemptCount,
        sourceAgentId: agent.id,
      });
      const checkpoint = {
        ...safeJson(safeJson(unresolvedItem.metadata).checkpoint),
        missingTargetResult: true,
        status: unresolvedStatus,
        ...(Object.keys(recovery).length > 0 ? {recovery} : {}),
      };
      const error = ['needs_action', 'retryable', 'failed'].includes(
        unresolvedStatus,
      )
        ? {
            ...unresolvedError,
            ...(Object.keys(recovery).length > 0 ? {recovery} : {}),
          }
        : safeJson(unresolvedItem.error);
      const terminal = NEGATIVE_PATROL_RESULT_STATUSES.has(unresolvedStatus);
      await tx.execute(`
        UPDATE capture_task_items
        SET status = $1,
          error = $2::jsonb,
          metadata = metadata || jsonb_build_object('checkpoint', $3::jsonb),
          finished_at = CASE
            WHEN $4::boolean THEN COALESCE(finished_at, now())
            ELSE NULL
          END,
          updated_at = now()
        WHERE id = $5
          AND tenant_id = $6
          AND task_id = $7
          AND execution_task_id = $8
          AND assigned_agent_id = $9
          AND assignment_revision = $10
      `, [
        unresolvedStatus,
        JSON.stringify(error),
        JSON.stringify(checkpoint),
        terminal,
        unresolvedItem.id,
        agent.tenant_id,
        itemOwnerTaskId,
        task.id,
        agent.id,
        unresolvedItem.assignment_revision,
      ]);
      await tx.execute(`
        UPDATE capture_task_item_attempts
        SET status = $1,
          checkpoint = $2::jsonb,
          error = $3::jsonb,
          finished_at = CASE
            WHEN $4::boolean THEN COALESCE(finished_at, now())
            ELSE NULL
          END,
          updated_at = now()
        WHERE id = (
          SELECT id
          FROM capture_task_item_attempts
          WHERE tenant_id = $5
            AND item_id = $6
            AND execution_task_id = $7
            AND agent_id = $8
            AND assignment_revision = $9
          ORDER BY attempt_number DESC
          LIMIT 1
        )
      `, [
        orchestrationItemAttemptStatus(unresolvedStatus),
        JSON.stringify(checkpoint),
        JSON.stringify(error),
        terminal,
        agent.tenant_id,
        unresolvedItem.id,
        task.id,
        agent.id,
        unresolvedItem.assignment_revision,
      ]);
    }
    if (isProfilePatrol) {
      const fallbackExecutions = await tx.queryAll(`
        UPDATE monitor_executions execution
        SET status = CASE
            WHEN item.status = 'canceled' THEN 'cancelled'
            ELSE 'failed'
          END,
          error_message = CASE
            WHEN item.status = 'canceled' THEN '账号扫描任务已停止'
            ELSE COALESCE(
              NULLIF(item.error->>'message', ''),
              '账号扫描任务未返回完整结果'
            )
          END,
          finished_at = COALESCE(execution.finished_at, now()),
          updated_at = now()
        FROM capture_task_items item
        WHERE item.tenant_id = $1
          AND item.task_id = $2
          AND item.execution_task_id = $3
          AND item.assigned_agent_id = $4
          AND item.metadata->>'monitorExecutionId' = execution.id::text
          AND execution.tenant_id = item.tenant_id
          AND execution.status IN ('pending', 'running')
          AND item.status IN ('needs_action', 'failed', 'canceled')
        RETURNING execution.id
      `, [agent.tenant_id, itemOwnerTaskId, task.id, agent.id]);
      await syncProfileDiscoverySubscriptions(
        tx,
        agent.tenant_id,
        fallbackExecutions.map(execution => execution.id),
      );
    }
  }

  const items = await tx.queryAll(`
    SELECT status,
      CASE
        WHEN jsonb_typeof(metadata->'targetResult'->'commentObservation') = 'object'
          AND (metadata->'targetResult'->'commentObservation'->>'observedCount') ~ '^[0-9]+$'
        THEN LEAST(
          10000,
          (metadata->'targetResult'->'commentObservation'->>'observedCount')::integer
        )
        ELSE 0
      END AS comments_sampled,
      CASE
        WHEN LOWER(
          COALESCE(
            metadata->'targetResult'->'commentObservation'->>'partial',
            ''
          )
        ) = 'true' THEN true
        ELSE false
      END AS comments_partial
    FROM capture_task_items
    WHERE tenant_id = $1
      AND task_id = $2
      AND execution_task_id = $3
    ORDER BY ordinal, id
  `, [agent.tenant_id, itemOwnerTaskId, task.id]);
  if (items.length === 0) return null;
  const aggregate = aggregateParentTaskItems(items);
  if (task.task_type === 'official_account_comment_patrol') {
    aggregate.counts.commentsSampled = items.reduce(
      (sum, item) => sum + Math.max(0, Number(item.comments_sampled) || 0),
      0,
    );
    aggregate.counts.commentSampledPosts = items.filter(
      item => (Number(item.comments_sampled) || 0) > 0,
    ).length;
    aggregate.counts.commentPartialPosts = items.filter(
      item => item.comments_partial === true,
    ).length;
    aggregate.counts.commentSampleScope = 'visible_comments_bounded';
  }
  const taskLabel = targetedPostTaskLabel(task.task_type);
  const targetNoun = isProfilePatrol ? '账号' : '帖子';
  const statusMessage = aggregate.status === 'running'
    ? `正在逐${targetNoun}执行${taskLabel}`
    : aggregate.status === 'needs_action'
      ? `部分${targetNoun}未能完成${taskLabel}，需要处理`
      : aggregate.status === 'completed'
        ? `${taskLabel}已完成`
        : aggregate.status === 'completed_with_warnings'
          ? `${taskLabel}已完成，部分结果带提示`
          : aggregate.status === 'completed_with_failures'
            ? `${taskLabel}已完成，部分${targetNoun}采集失败`
            : aggregate.status === 'canceled'
              ? `${taskLabel}已停止`
              : `${taskLabel}已下发，等待设备处理`;
  const message =
    task.task_type === 'official_account_comment_patrol' &&
    aggregate.counts.commentsSampled > 0 &&
    aggregate.terminal
      ? `${statusMessage}，本次读取 ${aggregate.counts.commentsSampled} 条可见评论样本`
      : statusMessage;
  const now = new Date().toISOString();
  const projectedBusinessProgressAt =
    orchestrationCheckpointTimestamp(snapshot.businessProgressAt) ||
    (projectedItemIds.length > 0 ? now : null);
  const updatedTask = await tx.queryOne(`
    UPDATE capture_tasks
    SET status = $1,
      progress = $2::jsonb,
      counts = $3::jsonb,
      message = $4,
      metadata = metadata || jsonb_build_object(
        'targetResultProjection', jsonb_build_object(
          'projectedCount', $5::integer,
          'updatedAt', $6::text
        )
      ),
      business_progress_at = CASE
        WHEN $7::timestamptz IS NOT NULL
          THEN GREATEST(
            COALESCE(business_progress_at, $7::timestamptz),
            $7::timestamptz
          )
        ELSE business_progress_at
      END,
      finished_at = CASE
        WHEN $8::boolean THEN COALESCE(finished_at, $6::timestamptz)
        ELSE NULL
      END,
      updated_at = now()
    WHERE id = $9
      AND tenant_id = $10
      AND assigned_agent_id = $11
      AND status NOT IN ('canceled', 'superseded')
    RETURNING *
  `, [
    aggregate.status,
    JSON.stringify(aggregate.progress),
    JSON.stringify(aggregate.counts),
    message,
    projectedItemIds.length,
    now,
    projectedBusinessProgressAt,
    aggregate.terminal,
    task.id,
    agent.tenant_id,
    agent.id,
  ]);
  if (updatedTask && parentTaskId) {
    await refreshOrchestrationParentTask(tx, {
      tenantId: agent.tenant_id,
      parentTaskId,
      parent: orchestrationParent,
      agent,
      snapshot,
      childTaskId: task.id,
    });
  }
  return updatedTask;
}

async function projectOrchestrationChildControlOutcome(tx, {
  tenantId,
  childTask,
  agentId,
  status,
  error = {},
  actorType = 'system',
  actorId = '',
  actorName = '',
}) {
  if (!childTask?.parent_task_id) return null;

  // The caller has already locked and mutated the child task. Lock the parent
  // before touching item rows so command completion, expiry, and heartbeat
  // projection all use the same task -> parent -> item order.
  const parent = await lockOrchestrationParent(
    tx,
    tenantId,
    childTask.parent_task_id,
  );
  if (!parent) return null;

  const elasticPool =
    safeJson(parent.metadata).distributionMode === 'elastic_pool';
  const normalizedError = safeJson(error);
  const currentItemState = elasticPool
    ? await tx.queryOne(`
        SELECT id, attempt_count, safety_handoff_count, metadata
        FROM capture_task_items
        WHERE tenant_id = $1
          AND task_id = $2
          AND execution_task_id = $3
          AND assigned_agent_id = $4
          AND status NOT IN (
            'completed', 'completed_with_warnings',
            'failed', 'skipped', 'canceled'
          )
        ORDER BY ordinal, id
        LIMIT 1
        FOR UPDATE
      `, [tenantId, childTask.parent_task_id, childTask.id, agentId])
    : null;
  const attemptBudgetProjection = elasticPool
    ? projectElasticAttemptBudget(
        currentItemState,
        {error: normalizedError},
        childTask.id,
      )
    : {
        attemptBudget: Math.max(
          0,
          Number(currentItemState?.attempt_count) || 0,
        ),
        metadataPatch: {},
      };
  const projectedAttemptCount = attemptBudgetProjection.attemptBudget;
  const projectedStatus = projectElasticKeywordRecoveryStatus({
    elasticPool,
    status,
    error: normalizedError,
    attemptCount: projectedAttemptCount,
    safetyHandoffCount: currentItemState?.safety_handoff_count,
    technicalLimitReached: attemptBudgetProjection.technicalLimitReached,
  });
  const terminal = ORCHESTRATION_ITEM_TERMINAL_STATUSES.has(projectedStatus);
  await tx.execute(`
    UPDATE capture_task_items
    SET status = $1,
      error = $2::jsonb,
      metadata = CASE
        WHEN $8::boolean THEN metadata || $9::jsonb
        ELSE metadata
      END,
      finished_at = CASE
        WHEN $3::boolean THEN COALESCE(finished_at, now())
        ELSE NULL
      END,
      updated_at = now()
    WHERE tenant_id = $4
      AND task_id = $5
      AND execution_task_id = $6
      AND assigned_agent_id = $7
      AND status NOT IN (
        'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
      )
  `, [
    projectedStatus,
    JSON.stringify(normalizedError),
    terminal,
    tenantId,
    childTask.parent_task_id,
    childTask.id,
    agentId,
    elasticPool,
    JSON.stringify(attemptBudgetProjection.metadataPatch),
  ]);
  await tx.execute(`
    UPDATE capture_task_item_attempts attempt
    SET status = $1,
      error = $2::jsonb,
      finished_at = CASE
        WHEN $3::boolean THEN COALESCE(attempt.finished_at, now())
        ELSE NULL
      END,
      updated_at = now()
    FROM capture_task_items item
    WHERE item.id = attempt.item_id
      AND item.tenant_id = $4
      AND item.task_id = $5
      AND item.execution_task_id = $6
      AND item.assigned_agent_id = $7
      AND item.status = $1
      AND attempt.execution_task_id = $6
      AND attempt.agent_id = $7
      AND attempt.status NOT IN (
        'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
      )
  `, [
    projectedStatus,
    JSON.stringify(normalizedError),
    terminal,
    tenantId,
    childTask.parent_task_id,
    childTask.id,
    agentId,
  ]);

  const now = new Date().toISOString();
  return refreshOrchestrationParentTask(tx, {
    tenantId,
    parentTaskId: childTask.parent_task_id,
    parent,
    snapshot: {
      heartbeatAt: now,
      businessProgressAt: now,
      updatedAt: now,
    },
    childTaskId: childTask.id,
    actorType,
    actorId,
    actorName,
    eventAgentId: agentId,
  });
}

async function projectOrchestrationSnapshot(tx, agent, task, snapshot) {
  if (!task?.parent_task_id || isTargetedPostTaskType(task.task_type)) {
    return null;
  }

  const parent = await lockOrchestrationParent(
    tx,
    agent.tenant_id,
    task.parent_task_id,
  );
  if (!parent) return null;
  if (['canceled', 'superseded'].includes(parent.status)) return parent;
  const elasticPool =
    safeJson(parent.metadata).distributionMode === 'elastic_pool';
  const childStatus = text(snapshot.status, 80);
  const explicitUserCancellation =
    childStatus === 'canceled' &&
    isExplicitUserCancellationSnapshot(task, snapshot);

  // Receiving an accepted child snapshot proves the create command reached a
  // local task. It does not prove that any keyword has started yet.
  await tx.execute(`
    UPDATE capture_task_items
    SET status = 'dispatched',
      dispatched_at = COALESCE(dispatched_at, now()),
      updated_at = now()
    WHERE tenant_id = $1
      AND task_id = $2
      AND execution_task_id = $3
      AND assigned_agent_id = $4
      AND status IN ('assigned', 'dispatch_pending')
  `, [agent.tenant_id, task.parent_task_id, task.id, agent.id]);

  const projectedItemIds = [];
  const snapshotProgress = safeJson(snapshot.progress);
  const snapshotCheckpoint = safeJson(snapshot.checkpoint);
  const activeKeyword = text(
    snapshotProgress.keyword ||
      snapshotProgress.currentKeyword ||
      snapshotCheckpoint.currentKeyword ||
      snapshotCheckpoint.activeKeyword,
    120,
  );
  for (const entry of orchestrationCheckpointEntries(snapshot)) {
    const keyword = text(entry.keyword, 120);
    const entryErrorCode = text(
      entry.errorCode || entry.error_code || entry?.error?.code,
      100,
    ).toUpperCase();
    const keywordServiceAbnormal =
      entryErrorCode === 'DOUYIN_SEARCH_SERVICE_ABNORMAL';
    const checkpointStatus = checkpointEntryToItemStatus(entry);
    const unexpectedCheckpointCancellation =
      checkpointStatus === 'canceled' && !explicitUserCancellation;
    const checkpointProjectedStatus = unexpectedCheckpointCancellation
      ? projectCanceledChildItemStatus({elasticPool})
      : checkpointStatus === 'pending' || checkpointStatus === 'assigned'
        ? 'dispatched'
        : checkpointStatus;
    const attemptCount = orchestrationCheckpointInteger(entry.attemptCount);
    const savedCount = orchestrationCheckpointInteger(entry.savedCount);
    const finishedAt = orchestrationCheckpointTimestamp(entry.finishedAt);
    const rawEntryError = entry.error;
    const baseError = rawEntryError && typeof rawEntryError === 'object'
      ? sanitizeCloudStructuredObject(rawEntryError)
      : text(rawEntryError, 1000)
        ? {message: text(rawEntryError, 1000)}
        : {};
    const error = {
      ...(unexpectedCheckpointCancellation
        ? unexpectedTaskCancellationError({error: baseError})
        : baseError),
      ...(!unexpectedCheckpointCancellation &&
      text(entry.errorCode || entry.error_code, 100)
        ? {code: text(entry.errorCode || entry.error_code, 100)}
        : {}),
      ...(text(entry.errorCategory || entry.error_category, 100)
        ? {
            category: text(
              entry.errorCategory || entry.error_category,
              100,
            ),
          }
        : {}),
      ...(!keywordServiceAbnormal && entry.securityBlocked === true
        ? {securityBlocked: true}
        : {}),
      ...(!keywordServiceAbnormal && entry.platformSafetyBlocked === true
        ? {platformSafetyBlocked: true}
        : {}),
      ...(!keywordServiceAbnormal && entry.requiresManualAction === true
        ? {requiresManualAction: true}
        : {}),
      ...(entry.itemLockReleased === true
        ? {itemLockReleased: true}
        : {}),
      ...(entry.sourceAgentCooling === true
        ? {sourceAgentCooling: true}
        : {}),
      ...(entry.cooldownHomeRestored === true
        ? {cooldownHomeRestored: true}
        : {}),
      ...(text(entry.cooldownHomeUrl, 2000)
        ? {cooldownHomeUrl: text(entry.cooldownHomeUrl, 2000)}
        : {}),
      ...(!keywordServiceAbnormal &&
      entry.securityEvidence?.confirmed === true
        ? {
            securityEvidence: sanitizeCloudStructuredObject(
              entry.securityEvidence,
            ),
          }
        : {}),
    };
    const checkpoint = {
      round: Math.max(1, Number(entry.round) || 1),
      index: Math.max(0, Number(entry.index) || 0),
      keyword,
      status: text(entry.status, 80),
      attemptCount,
      savedCount,
      ...(
        entry.noResults === true
        || entry.no_results === true
        || entry.zeroResults === true
        || entry.zero_results === true
          ? {noResults: true}
          : {}
      ),
      ...(text(entry.resultKind || entry.result_kind, 80)
        ? {resultKind: text(entry.resultKind || entry.result_kind, 80)}
        : {}),
      ...(entry.candidateCount !== undefined || entry.candidate_count !== undefined
        ? {
            candidateCount: orchestrationCheckpointInteger(
              entry.candidateCount ?? entry.candidate_count,
            ),
          }
        : {}),
      ...(entry.scanComplete === true || entry.scan_complete === true
        ? {scanComplete: true}
        : {}),
      ...(text(entry.errorCode || entry.error_code, 100)
        ? {errorCode: text(entry.errorCode || entry.error_code, 100)}
        : {}),
      ...(!keywordServiceAbnormal && entry.securityBlocked === true
        ? {securityBlocked: true}
        : {}),
      ...(!keywordServiceAbnormal && entry.platformSafetyBlocked === true
        ? {platformSafetyBlocked: true}
        : {}),
      ...(!keywordServiceAbnormal && entry.requiresManualAction === true
        ? {requiresManualAction: true}
        : {}),
      ...(entry.itemLockReleased === true
        ? {itemLockReleased: true}
        : {}),
      ...(entry.sourceAgentCooling === true
        ? {sourceAgentCooling: true}
        : {}),
      ...(entry.cooldownHomeRestored === true
        ? {cooldownHomeRestored: true}
        : {}),
      ...(text(entry.cooldownHomeUrl, 2000)
        ? {cooldownHomeUrl: text(entry.cooldownHomeUrl, 2000)}
        : {}),
      ...(Array.isArray(entry.searchPassResults)
        ? {
            searchPassResults: entry.searchPassResults
              .slice(0, 4)
              .map(result => sanitizeCloudStructuredObject(result)),
          }
        : {}),
      ...(!keywordServiceAbnormal &&
      entry.securityEvidence?.confirmed === true
        ? {
            securityEvidence: sanitizeCloudStructuredObject(
              entry.securityEvidence,
            ),
          }
        : {}),
      finishedAt,
    };
    const currentItemState = elasticPool
      ? await tx.queryOne(`
          SELECT id, attempt_count, safety_handoff_count, metadata
          FROM capture_task_items
          WHERE tenant_id = $1
            AND task_id = $2
            AND execution_task_id = $3
            AND assigned_agent_id = $4
            AND keyword = $5
          FOR UPDATE
        `, [
          agent.tenant_id,
          task.parent_task_id,
          task.id,
          agent.id,
          keyword,
        ])
      : null;
    const serverAttemptCount = Math.max(
      0,
      Number(currentItemState?.attempt_count) || 0,
    );
    const attemptBudgetProjection = elasticPool
      ? projectElasticAttemptBudget(
          currentItemState,
          {error, checkpoint},
          task.id,
        )
      : {attemptBudget: serverAttemptCount, metadataPatch: {}};
    const projectedAttemptCount = attemptBudgetProjection.attemptBudget;
    const status = projectElasticKeywordRecoveryStatus({
      elasticPool,
      status: checkpointProjectedStatus,
      error,
      checkpoint,
      attemptCount: projectedAttemptCount,
      safetyHandoffCount: currentItemState?.safety_handoff_count,
      technicalLimitReached: attemptBudgetProjection.technicalLimitReached,
    });
    const recovery = buildElasticRecoveryMetadata({
      status,
      error,
      checkpoint,
      attemptCount: projectedAttemptCount,
      sourceAgentId: agent.id,
    });
    if (Object.keys(recovery).length > 0) {
      checkpoint.recovery = recovery;
    }
    const terminal = ORCHESTRATION_ITEM_TERMINAL_STATUSES.has(status);
    const item = await tx.queryOne(`
      UPDATE capture_task_items
      SET status = $1,
        error = $2::jsonb,
        metadata = metadata || jsonb_build_object('checkpoint', $3::jsonb) ||
          CASE
            WHEN $11::boolean THEN $12::jsonb
            ELSE '{}'::jsonb
          END,
        started_at = CASE
          WHEN $1 IN (
            'running', 'retryable', 'needs_action', 'completed',
            'completed_with_warnings', 'failed', 'skipped', 'canceled'
          ) THEN COALESCE(started_at, now())
          ELSE started_at
        END,
        finished_at = CASE
          WHEN $4::boolean THEN COALESCE($5::timestamptz, finished_at, now())
          ELSE NULL
        END,
        updated_at = now()
      WHERE tenant_id = $6
        AND task_id = $7
        AND execution_task_id = $8
        AND assigned_agent_id = $9
        AND keyword = $10
        AND (capture_task_items.status <> 'canceled' OR $1 = 'canceled')
      RETURNING id, assignment_revision
    `, [
      status,
      JSON.stringify(error),
      JSON.stringify(checkpoint),
      terminal,
      finishedAt,
      agent.tenant_id,
      task.parent_task_id,
      task.id,
      agent.id,
      keyword,
      elasticPool,
      JSON.stringify(attemptBudgetProjection.metadataPatch),
    ]);
    if (!item) continue;
    projectedItemIds.push(item.id);

    await tx.execute(`
      UPDATE capture_task_item_attempts
      SET status = $1,
        checkpoint = $2::jsonb,
        result = jsonb_build_object('savedCount', $3::integer),
        error = $4::jsonb,
        started_at = CASE
          WHEN $1 <> 'dispatched' THEN COALESCE(started_at, now())
          ELSE started_at
        END,
        finished_at = CASE
          WHEN $5::boolean THEN COALESCE($6::timestamptz, finished_at, now())
          ELSE NULL
        END,
        updated_at = now()
      WHERE id = (
        SELECT id
        FROM capture_task_item_attempts
        WHERE tenant_id = $7
          AND item_id = $8
          AND execution_task_id = $9
          AND agent_id = $10
          AND assignment_revision = $11
          AND (capture_task_item_attempts.status <> 'canceled' OR $1 = 'canceled')
        ORDER BY attempt_number DESC
        LIMIT 1
      )
    `, [
      orchestrationItemAttemptStatus(status),
      JSON.stringify(checkpoint),
      checkpoint.savedCount,
      JSON.stringify(error),
      terminal,
      finishedAt,
      agent.tenant_id,
      item.id,
      task.id,
      agent.id,
      item.assignment_revision,
    ]);
  }

  const childErrorCode = text(
    snapshot?.error?.code || snapshot?.errorCode || snapshot?.error_code,
    100,
  ).toUpperCase();
  const childServiceAbnormal =
    childErrorCode === 'DOUYIN_SEARCH_SERVICE_ABNORMAL';
  const childServiceAbnormalNeedsRetry =
    childServiceAbnormal &&
    [
      'interrupted',
      'needs_action',
      'failed',
      'completed_with_failures',
    ].includes(childStatus);
  const unexpectedChildCancellation =
    childStatus === 'canceled' && !explicitUserCancellation;
  const baseUnresolvedStatus = childServiceAbnormalNeedsRetry
    ? 'retryable'
    : childStatus === 'canceled'
      ? projectCanceledChildItemStatus({
          elasticPool,
          explicitUserCancellation,
        })
      : childStatus === 'skipped'
        ? 'skipped'
        : [
          'interrupted',
          'needs_action',
          'failed',
          'completed',
          'completed_with_warnings',
          'completed_with_failures',
        ].includes(childStatus)
          ? 'needs_action'
          : '';
  if (baseUnresolvedStatus) {
    const terminal = ORCHESTRATION_ITEM_TERMINAL_STATUSES.has(baseUnresolvedStatus);
    const rawChildError = snapshot.error;
    const childError = {
      ...(unexpectedChildCancellation
        ? unexpectedTaskCancellationError(snapshot)
        : rawChildError && typeof rawChildError === 'object'
          ? sanitizeCloudStructuredObject(rawChildError)
          : text(rawChildError, 1000)
            ? {message: text(rawChildError, 1000)}
            : {}),
      ...(!unexpectedChildCancellation && text(
        snapshot?.error?.code || snapshot?.errorCode || snapshot?.error_code,
        100,
      )
        ? {
            code: text(
              snapshot?.error?.code ||
                snapshot?.errorCode ||
                snapshot?.error_code,
              100,
            ),
          }
        : {}),
    };
    if (activeKeyword) {
      const currentActiveItem = elasticPool
        ? await tx.queryOne(`
            SELECT id, attempt_count, safety_handoff_count, metadata
            FROM capture_task_items
            WHERE tenant_id = $1
              AND task_id = $2
              AND execution_task_id = $3
              AND assigned_agent_id = $4
              AND keyword = $5
              AND NOT (id = ANY($6::uuid[]))
            FOR UPDATE
          `, [
            agent.tenant_id,
            task.parent_task_id,
            task.id,
            agent.id,
            activeKeyword,
            projectedItemIds,
          ])
        : null;
      const serverAttemptCount = Math.max(
        0,
        Number(currentActiveItem?.attempt_count) || 0,
      );
      const attemptBudgetProjection = elasticPool
        ? projectElasticAttemptBudget(
            currentActiveItem,
            {error: childError, checkpoint: snapshotCheckpoint},
            task.id,
          )
        : {attemptBudget: serverAttemptCount, metadataPatch: {}};
      const projectedAttemptCount = attemptBudgetProjection.attemptBudget;
      const activeUnresolvedStatus = projectElasticKeywordRecoveryStatus({
        elasticPool,
        status: baseUnresolvedStatus,
        error: childError,
        checkpoint: snapshotCheckpoint,
        attemptCount: projectedAttemptCount,
        safetyHandoffCount: currentActiveItem?.safety_handoff_count,
        technicalLimitReached: attemptBudgetProjection.technicalLimitReached,
      });
      const recovery = buildElasticRecoveryMetadata({
        status: activeUnresolvedStatus,
        error: childError,
        checkpoint: snapshotCheckpoint,
        attemptCount: projectedAttemptCount,
        sourceAgentId: agent.id,
      });
      const activeChildError = Object.keys(recovery).length > 0
        ? {...childError, recovery}
        : childError;
      const activeTerminal = ORCHESTRATION_ITEM_TERMINAL_STATUSES.has(
        activeUnresolvedStatus,
      );
      const activeItem = await tx.queryOne(`
        UPDATE capture_task_items
        SET status = $1,
          metadata = CASE
            WHEN $10::boolean THEN metadata || $11::jsonb
            ELSE metadata
          END,
          error = CASE
            WHEN $2::jsonb = '{}'::jsonb THEN jsonb_build_object(
              'code', 'missing_keyword_checkpoint',
              'message', '当前关键词已开始，但子任务停止前未收到完成检查点'
            )
            ELSE $2::jsonb
          END,
          started_at = COALESCE(started_at, now()),
          finished_at = CASE
            WHEN $3::boolean THEN COALESCE(finished_at, now())
            ELSE NULL
          END,
          updated_at = now()
        WHERE tenant_id = $4
          AND task_id = $5
          AND execution_task_id = $6
          AND assigned_agent_id = $7
          AND keyword = $8
          AND NOT (id = ANY($9::uuid[]))
          AND status NOT IN (
            'completed', 'completed_with_warnings',
            'failed', 'skipped', 'canceled'
          )
        RETURNING id
      `, [
        activeUnresolvedStatus,
        JSON.stringify(activeChildError),
        activeTerminal,
        agent.tenant_id,
        task.parent_task_id,
        task.id,
        agent.id,
        activeKeyword,
        projectedItemIds,
        elasticPool,
        JSON.stringify(attemptBudgetProjection.metadataPatch),
      ]);
      if (activeItem) projectedItemIds.push(activeItem.id);
    }
    await tx.execute(`
      UPDATE capture_task_items
      SET status = CASE
          WHEN $1 = 'needs_action' AND started_at IS NULL THEN 'retryable'
          ELSE $1
        END,
        error = CASE
          WHEN $1 = 'needs_action' AND started_at IS NULL
            THEN jsonb_build_object(
              'code', 'blocked_by_prior_item',
              'message', '前序关键词需要人工处理，该关键词尚未开始，可安全接力'
            )
          WHEN $1 = 'needs_action' THEN jsonb_build_object(
            'code', 'missing_keyword_checkpoint',
            'message', '子任务已停止，但未收到该关键词的完成检查点'
          )
          WHEN $8::boolean THEN $9::jsonb
          ELSE error
        END,
        finished_at = CASE
          WHEN $2::boolean THEN COALESCE(finished_at, now())
          ELSE NULL
        END,
        updated_at = now()
      WHERE tenant_id = $3
        AND task_id = $4
        AND execution_task_id = $5
        AND assigned_agent_id = $6
        AND (
          $1 IN ('canceled', 'skipped')
          OR NOT (id = ANY($7::uuid[]))
        )
        AND status NOT IN (
          'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
        )
    `, [
      baseUnresolvedStatus,
      terminal,
      agent.tenant_id,
      task.parent_task_id,
      task.id,
      agent.id,
      projectedItemIds,
      unexpectedChildCancellation,
      JSON.stringify(childError),
    ]);
    await tx.execute(`
      UPDATE capture_task_item_attempts attempt
      SET status = CASE
          WHEN item.status = 'retryable' THEN 'retryable'
          ELSE item.status
        END,
        error = item.error,
        started_at = CASE
          WHEN item.started_at IS NULL THEN attempt.started_at
          ELSE COALESCE(attempt.started_at, item.started_at)
        END,
        finished_at = item.finished_at,
        updated_at = now()
      FROM capture_task_items item
      WHERE item.id = attempt.item_id
        AND item.tenant_id = $1
        AND item.task_id = $2
        AND item.execution_task_id = $3
        AND item.assigned_agent_id = $4
        AND attempt.execution_task_id = $3
        AND attempt.agent_id = $4
        AND attempt.status NOT IN (
          'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'
        )
    `, [
      agent.tenant_id,
      task.parent_task_id,
      task.id,
      agent.id,
    ]);
  }

  return refreshOrchestrationParentTask(tx, {
    tenantId: agent.tenant_id,
    parentTaskId: task.parent_task_id,
    parent,
    agent,
    snapshot,
  });
}

export async function mirrorTaskSnapshot(tx, agent, snapshot) {
  snapshot = bindCloudTaskSnapshotHealthToAttempt(snapshot);
  const previous = await tx.queryOne(`
    SELECT task.id, task.status, task.attempt_number,
      occupied_attempt.client_attempt_id AS occupied_attempt_id
    FROM capture_tasks task
    LEFT JOIN capture_task_attempts occupied_attempt
      ON occupied_attempt.task_id = task.id
      AND occupied_attempt.attempt_number = $4
    WHERE task.tenant_id = $1
      AND task.origin_agent_id = $2
      AND task.client_task_id = $3
    LIMIT 1
  `, [
    agent.tenant_id,
    agent.id,
    snapshot.clientTaskId,
    snapshot.attemptNumber,
  ]);

  if (
    previous
    && !cloudTaskAttemptIdentityAcceptsSnapshot(
      previous.occupied_attempt_id,
      snapshot.attemptId,
    )
  ) {
    return tx.queryOne(`
      SELECT *
      FROM capture_tasks
      WHERE id = $1 AND tenant_id = $2
    `, [previous.id, agent.tenant_id]);
  }

  // Read exact create evidence without locking it; the task upsert below takes
  // the first write lock, and command reconciliation follows that same
  // task-then-command order everywhere.
  const createCommandEvidence = await tx.queryOne(`
    SELECT id::text AS id, status, payload
    FROM capture_agent_commands
    WHERE tenant_id = $1 AND agent_id = $2
      AND task_id::text = $3
      AND command_type = 'create'
      AND payload->>'clientTaskId' = $3
      AND status IN ('pending', 'acknowledged', 'expired')
    ORDER BY created_at DESC
    LIMIT 1
  `, [agent.tenant_id, agent.id, snapshot.clientTaskId]);

  let task = await tx.queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, origin_agent_id, assigned_agent_id,
      client_task_id, control_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status,
      progress, checkpoint, counts, metadata, error, message,
      attempt_number, progress_seq, heartbeat_at, business_progress_at,
      started_at, finished_at, source_updated_at, created_at, updated_at
    ) VALUES (
      $1, $2, $2,
      $3, $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17,
      $18, $19, $20, $21,
      $22, $23, COALESCE($25, $24, now()), COALESCE($24, now()), now()
    )
    ON CONFLICT (tenant_id, origin_agent_id, client_task_id)
      WHERE client_task_id <> ''
    DO UPDATE SET
      assigned_agent_id = EXCLUDED.assigned_agent_id,
      control_task_id = EXCLUDED.control_task_id,
      task_type = EXCLUDED.task_type,
      feature_key = EXCLUDED.feature_key,
      title = EXCLUDED.title,
      platform = EXCLUDED.platform,
      source = EXCLUDED.source,
      trigger_type = EXCLUDED.trigger_type,
      status = CASE
        WHEN capture_tasks.status = 'superseded'
          THEN capture_tasks.status
        WHEN capture_tasks.status = 'failed'
          AND capture_tasks.error->>'code' = 'create_command_expired'
          AND capture_tasks.metadata->>'createCommandId' = $26
          AND capture_tasks.client_task_id = EXCLUDED.client_task_id
          THEN CASE WHEN EXCLUDED.status = 'pending' THEN 'claimed' ELSE EXCLUDED.status END
        WHEN capture_tasks.status = 'claimed'
          AND capture_tasks.metadata ? 'createCommandId'
          AND EXCLUDED.status = 'pending'
          THEN capture_tasks.status
        WHEN capture_tasks.status = 'resume_requested'
          AND EXCLUDED.status IN ('needs_action', 'failed', 'interrupted', 'completed_with_failures')
          THEN capture_tasks.status
        WHEN capture_tasks.attempt_number = EXCLUDED.attempt_number
          AND capture_tasks.status IN (
            'completed', 'completed_with_warnings', 'completed_with_failures',
            'failed', 'canceled', 'skipped'
          )
          AND EXCLUDED.status IN ('pending', 'claimed', 'running', 'recovering')
          THEN capture_tasks.status
        ELSE EXCLUDED.status
      END,
      progress = EXCLUDED.progress,
      checkpoint = EXCLUDED.checkpoint,
      counts = EXCLUDED.counts,
      metadata = EXCLUDED.metadata
        || CASE
          WHEN capture_tasks.status = 'resume_requested'
            AND EXCLUDED.status IN ('needs_action', 'failed', 'interrupted', 'completed_with_failures')
          THEN jsonb_strip_nulls(jsonb_build_object(
            'resumeCommandId', capture_tasks.metadata->'resumeCommandId',
            'resumePreviousStatus', capture_tasks.metadata->'resumePreviousStatus'
          ))
          ELSE '{}'::jsonb
        END
        || CASE
          WHEN capture_tasks.metadata ? 'createCommandId'
          THEN jsonb_strip_nulls(jsonb_build_object(
            'createCommandId', capture_tasks.metadata->'createCommandId',
            'remoteCreated', capture_tasks.metadata->'remoteCreated',
            'requestedByUserId', capture_tasks.metadata->'requestedByUserId',
            'requestedByName', capture_tasks.metadata->'requestedByName',
            'executionMode', capture_tasks.metadata->'executionMode',
            'planSnapshot', capture_tasks.metadata->'planSnapshot',
            'remoteRequestHash', capture_tasks.metadata->'remoteRequestHash',
            'orchestrationChild', capture_tasks.metadata->'orchestrationChild',
            'parentTaskId', capture_tasks.metadata->'parentTaskId',
            'orchestrationRevision', capture_tasks.metadata->'orchestrationRevision',
            'itemIds', capture_tasks.metadata->'itemIds',
            'attemptIdentity', capture_tasks.metadata->'attemptIdentity',
            'handoffRequestHash', capture_tasks.metadata->'handoffRequestHash',
            'handoffRequestKey', capture_tasks.metadata->'handoffRequestKey',
            'handoffSourceExecutionTaskId', capture_tasks.metadata->'handoffSourceExecutionTaskId',
            'handoffConfirmedByUser', capture_tasks.metadata->'handoffConfirmedByUser',
            'handoffSuccessorTaskId', capture_tasks.metadata->'handoffSuccessorTaskId',
            'handoffSuccessorAttemptIdentity', capture_tasks.metadata->'handoffSuccessorAttemptIdentity',
            'handoffSourcePreviousStatus', capture_tasks.metadata->'handoffSourcePreviousStatus',
            'handedOffAt', capture_tasks.metadata->'handedOffAt',
            'retryRequestHash', capture_tasks.metadata->'retryRequestHash',
            'retryRequestKey', capture_tasks.metadata->'retryRequestKey',
            'retrySourceExecutionTaskIds', capture_tasks.metadata->'retrySourceExecutionTaskIds',
            'retryConfirmedByUser', capture_tasks.metadata->'retryConfirmedByUser',
            'retrySafetyConfirmed', capture_tasks.metadata->'retrySafetyConfirmed',
            'recoveryTaskId', capture_tasks.metadata->'recoveryTaskId',
            'recoveryCommandId', capture_tasks.metadata->'recoveryCommandId',
            'queueBlocker', capture_tasks.metadata->'queueBlocker',
            'filter', capture_tasks.metadata->'filter',
            'selectedRecordIds', capture_tasks.metadata->'selectedRecordIds',
            'reassignment', capture_tasks.metadata->'reassignment',
            'reassignmentRequestKey', capture_tasks.metadata->'reassignmentRequestKey',
            'reassignmentRequestHash', capture_tasks.metadata->'reassignmentRequestHash',
            'reassignmentAllocation', capture_tasks.metadata->'reassignmentAllocation',
            'targetResultProjection', capture_tasks.metadata->'targetResultProjection',
            'localRequestId', capture_tasks.metadata->'localRequestId',
            'createCompletedAt', capture_tasks.metadata->'createCompletedAt',
            'createFailedAt', capture_tasks.metadata->'createFailedAt'
          ))
          ELSE '{}'::jsonb
        END
        || CASE
          WHEN capture_tasks.metadata->>'localRecovery' = 'true'
          THEN jsonb_strip_nulls(jsonb_build_object(
            'orchestrationChild', capture_tasks.metadata->'orchestrationChild',
            'parentTaskId', capture_tasks.metadata->'parentTaskId',
            'orchestrationRevision', capture_tasks.metadata->'orchestrationRevision',
            'itemIds', capture_tasks.metadata->'itemIds',
            'localRecovery', capture_tasks.metadata->'localRecovery',
            'localRecoverySourceExecutionTaskId', capture_tasks.metadata->'localRecoverySourceExecutionTaskId',
            'localRecoveryAdoptedAt', capture_tasks.metadata->'localRecoveryAdoptedAt'
          ))
          ELSE '{}'::jsonb
        END
        || CASE
          WHEN capture_tasks.metadata ? 'stopCommandId'
          THEN jsonb_strip_nulls(jsonb_build_object(
            'stopCommandId', capture_tasks.metadata->'stopCommandId',
            'stopPreviousStatus', capture_tasks.metadata->'stopPreviousStatus'
          ))
          ELSE '{}'::jsonb
        END,
      error = EXCLUDED.error,
      message = EXCLUDED.message,
      attempt_number = GREATEST(capture_tasks.attempt_number, EXCLUDED.attempt_number),
      progress_seq = CASE
        WHEN EXCLUDED.attempt_number > capture_tasks.attempt_number
          THEN EXCLUDED.progress_seq
        ELSE GREATEST(capture_tasks.progress_seq, EXCLUDED.progress_seq)
      END,
      heartbeat_at = CASE
        WHEN EXCLUDED.attempt_number > capture_tasks.attempt_number
          THEN EXCLUDED.heartbeat_at
        ELSE GREATEST(capture_tasks.heartbeat_at, EXCLUDED.heartbeat_at)
      END,
      business_progress_at = CASE
        WHEN EXCLUDED.attempt_number > capture_tasks.attempt_number
          THEN EXCLUDED.business_progress_at
        ELSE GREATEST(capture_tasks.business_progress_at, EXCLUDED.business_progress_at)
      END,
      started_at = LEAST(capture_tasks.started_at, EXCLUDED.started_at),
      finished_at = CASE
        WHEN capture_tasks.status = 'failed'
          AND capture_tasks.error->>'code' = 'create_command_expired'
          AND capture_tasks.metadata->>'createCommandId' = $26
          AND capture_tasks.client_task_id = EXCLUDED.client_task_id
          THEN EXCLUDED.finished_at
        WHEN EXCLUDED.attempt_number > capture_tasks.attempt_number
          THEN EXCLUDED.finished_at
        ELSE GREATEST(capture_tasks.finished_at, EXCLUDED.finished_at)
      END,
      source_updated_at = CASE
        WHEN EXCLUDED.attempt_number > capture_tasks.attempt_number
          THEN EXCLUDED.source_updated_at
        ELSE GREATEST(capture_tasks.source_updated_at, EXCLUDED.source_updated_at)
      END,
      updated_at = now()
    WHERE capture_tasks.status NOT IN ('superseded', 'canceled')
      -- Once a single-node task is promoted into a business parent, the old
      -- browser task keeps the same clientTaskId for audit correlation only.
      -- Late source snapshots must never overwrite the aggregate parent.
      AND capture_tasks.metadata->>'promotedRetryParent' IS DISTINCT FROM 'true'
      -- The elastic scheduler revokes the old lease before requeueing a stale
      -- work item. A final snapshot from that same runner incarnation (often a
      -- local stale-ledger "canceled" record) no longer owns the task and must
      -- not turn the requeued item into a terminal cancellation.
      AND NOT (
        EXCLUDED.attempt_number = capture_tasks.attempt_number
        AND capture_tasks.status = 'failed'
        AND UPPER(COALESCE(capture_tasks.error->>'code', '')) IN (
          'ELASTIC_AGENT_OFFLINE_TIMEOUT',
          'ELASTIC_TASK_HEARTBEAT_TIMEOUT'
        )
      )
      -- attempt_number is a monotonic slot, while client_attempt_id identifies
      -- the concrete runner incarnation occupying it. Once a non-empty ID is
      -- recorded, only that exact non-empty ID may overwrite the slot's task
      -- projection. A legacy empty slot may upgrade to a concrete ID, never
      -- the reverse; this asymmetry keeps late legacy reports from mutating a
      -- bound attempt's status, progress, checkpoint, error, or health.
      AND NOT EXISTS (
        SELECT 1
        FROM capture_task_attempts existing_attempt
        WHERE existing_attempt.task_id = capture_tasks.id
          AND existing_attempt.attempt_number = EXCLUDED.attempt_number
          AND existing_attempt.client_attempt_id <> ''
          AND (
            $27 = ''
            OR existing_attempt.client_attempt_id <> $27
          )
      )
      AND NOT (
        EXCLUDED.attempt_number = capture_tasks.attempt_number
        AND capture_tasks.status IN (
          'completed', 'completed_with_warnings', 'completed_with_failures',
          'failed', 'canceled', 'skipped'
        )
        AND EXCLUDED.status IN ('pending', 'claimed', 'running', 'recovering')
        AND NOT (
          capture_tasks.status = 'failed'
          AND capture_tasks.error->>'code' = 'create_command_expired'
          AND capture_tasks.metadata->>'createCommandId' = $26
          AND capture_tasks.client_task_id = EXCLUDED.client_task_id
        )
      )
      AND (
        EXCLUDED.attempt_number > capture_tasks.attempt_number
        OR (
          EXCLUDED.attempt_number = capture_tasks.attempt_number
          AND EXCLUDED.progress_seq > capture_tasks.progress_seq
        )
        OR (
          EXCLUDED.attempt_number = capture_tasks.attempt_number
          AND EXCLUDED.progress_seq = capture_tasks.progress_seq
          AND EXCLUDED.source_updated_at > capture_tasks.source_updated_at
        )
      )
    RETURNING *
  `, [
    agent.tenant_id,
    agent.id,
    snapshot.clientTaskId,
    snapshot.controlTaskId,
    snapshot.taskType,
    snapshot.featureKey,
    snapshot.title,
    snapshot.platform,
    snapshot.source,
    snapshot.triggerType,
    snapshot.status,
    JSON.stringify(snapshot.progress),
    JSON.stringify(snapshot.checkpoint),
    JSON.stringify(snapshot.counts),
    JSON.stringify(snapshot.metadata),
    JSON.stringify(snapshot.error),
    snapshot.message,
    snapshot.attemptNumber,
    snapshot.progressSeq,
    snapshot.heartbeatAt,
    snapshot.businessProgressAt,
    snapshot.startedAt,
    snapshot.finishedAt,
    snapshot.createdAt,
    snapshot.updatedAt,
    createCommandEvidence?.id || '',
    snapshot.attemptId,
  ]);

  const snapshotAccepted = Boolean(task);
  if (!task) {
    task = await tx.queryOne(`
      SELECT * FROM capture_tasks
      WHERE tenant_id = $1 AND origin_agent_id = $2 AND client_task_id = $3
      LIMIT 1
    `, [agent.tenant_id, agent.id, snapshot.clientTaskId]);
  }

  if (snapshotAccepted) {
    task = await adoptLocalOrchestrationRecovery(tx, agent, task, snapshot);
  }

  let attempt = null;
  const normalizedAttemptStatus = attemptStatus(snapshot.status);
  if (snapshotAccepted && snapshot.attemptNumber > 0 && normalizedAttemptStatus) {
    attempt = await tx.queryOne(`
      INSERT INTO capture_task_attempts (
        tenant_id, task_id, agent_id, client_attempt_id, attempt_number,
        app_version, health_evidence,
        status, progress_seq, heartbeat_at, business_progress_at,
        started_at, finished_at, progress, checkpoint, error, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        CASE WHEN $4 <> '' THEN $6 ELSE '' END,
        CASE WHEN $4 <> '' THEN $7::jsonb ELSE '{}'::jsonb END,
        $8, $9, $10, $11,
        COALESCE($12, now()), $13, $14::jsonb, $15::jsonb, $16::jsonb, now()
      )
      ON CONFLICT (task_id, attempt_number)
      DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        client_attempt_id = CASE
          WHEN capture_task_attempts.client_attempt_id <> ''
            AND EXCLUDED.client_attempt_id = ''
            THEN capture_task_attempts.client_attempt_id
          ELSE EXCLUDED.client_attempt_id
        END,
        app_version = CASE
          WHEN EXCLUDED.client_attempt_id <> ''
            AND (
              capture_task_attempts.client_attempt_id = ''
              OR capture_task_attempts.client_attempt_id = EXCLUDED.client_attempt_id
            )
            AND EXCLUDED.app_version <> ''
            THEN EXCLUDED.app_version
          ELSE capture_task_attempts.app_version
        END,
        health_evidence = CASE
          WHEN EXCLUDED.client_attempt_id <> ''
            AND (
              capture_task_attempts.client_attempt_id = ''
              OR capture_task_attempts.client_attempt_id = EXCLUDED.client_attempt_id
            )
            AND EXCLUDED.health_evidence <> '{}'::jsonb
            THEN EXCLUDED.health_evidence
          ELSE capture_task_attempts.health_evidence
        END,
        status = CASE
          WHEN capture_task_attempts.status IN (
            'completed', 'completed_with_warnings', 'completed_with_failures',
            'failed', 'canceled'
          ) AND EXCLUDED.status IN ('claimed', 'running', 'recovering')
            THEN capture_task_attempts.status
          ELSE EXCLUDED.status
        END,
        progress_seq = GREATEST(capture_task_attempts.progress_seq, EXCLUDED.progress_seq),
        heartbeat_at = COALESCE(EXCLUDED.heartbeat_at, capture_task_attempts.heartbeat_at),
        business_progress_at = COALESCE(EXCLUDED.business_progress_at, capture_task_attempts.business_progress_at),
        finished_at = COALESCE(EXCLUDED.finished_at, capture_task_attempts.finished_at),
        progress = EXCLUDED.progress,
        checkpoint = EXCLUDED.checkpoint,
        error = EXCLUDED.error,
        updated_at = now()
      WHERE capture_task_attempts.client_attempt_id = ''
        OR capture_task_attempts.client_attempt_id = EXCLUDED.client_attempt_id
      RETURNING id
    `, [
      agent.tenant_id,
      task.id,
      agent.id,
      snapshot.attemptId,
      snapshot.attemptNumber,
      snapshot.appVersion,
      JSON.stringify(snapshot.structuredTaskHealth),
      normalizedAttemptStatus,
      snapshot.progressSeq,
      snapshot.heartbeatAt,
      snapshot.businessProgressAt,
      snapshot.startedAt,
      snapshot.finishedAt,
      JSON.stringify(snapshot.progress),
      JSON.stringify(snapshot.checkpoint),
      JSON.stringify(snapshot.error),
    ]);
  }

  if (snapshotAccepted) {
    await tx.execute(`
      INSERT INTO capture_task_snapshots (
        tenant_id, task_id, attempt_id, agent_id,
        client_task_id, control_task_id, client_attempt_id,
        attempt_number, progress_seq, task_type, feature_key, title,
        platform, source, trigger_type, status,
        progress, checkpoint, counts, metadata, error, message,
        heartbeat_at, business_progress_at, started_at, finished_at,
        source_created_at, source_updated_at, snapshot_fingerprint
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22,
        $23, $24, $25, $26,
        $27, $28, $29
      )
      ON CONFLICT (task_id, snapshot_fingerprint) DO NOTHING
    `, [
      agent.tenant_id,
      task.id,
      snapshot.attemptId ? attempt?.id || null : null,
      agent.id,
      snapshot.clientTaskId,
      snapshot.controlTaskId,
      snapshot.attemptId,
      snapshot.attemptNumber,
      snapshot.progressSeq,
      snapshot.taskType,
      snapshot.featureKey,
      snapshot.title,
      snapshot.platform,
      snapshot.source,
      snapshot.triggerType,
      snapshot.status,
      JSON.stringify(snapshot.progress),
      JSON.stringify(snapshot.checkpoint),
      JSON.stringify(snapshot.counts),
      JSON.stringify(snapshot.metadata),
      JSON.stringify(snapshot.error),
      snapshot.message,
      snapshot.heartbeatAt,
      snapshot.businessProgressAt,
      snapshot.startedAt,
      snapshot.finishedAt,
      snapshot.createdAt,
      task.source_updated_at,
      captureTaskSnapshotFingerprint(snapshot),
    ]);

    const projectedNegativePatrolTask = await projectNegativePatrolSnapshot(
      tx,
      agent,
      task,
      snapshot,
    );
    if (projectedNegativePatrolTask) {
      task = projectedNegativePatrolTask;
    }
    await projectOrchestrationSnapshot(tx, agent, task, snapshot);
  }

  await enqueueCaptureSafetyAttentionNotification(tx, {
    agent,
    task,
    snapshot,
    previous,
    snapshotAccepted,
  });

  if (!previous || previous.status !== task.status || previous.attempt_number !== task.attempt_number) {
    await appendEvent(tx, {
      tenantId: agent.tenant_id,
      taskId: task.id,
      attemptId: snapshot.attemptId ? attempt?.id || null : null,
      agentId: agent.id,
      eventType: previous ? 'task_status_changed' : 'task_discovered',
      actorType: 'capture_agent',
      actorId: agent.id,
      actorName: agent.display_name || agent.client_label,
      status: task.status,
      message: snapshot.message,
      payload: {
        clientTaskId: snapshot.clientTaskId,
        previousStatus: previous?.status || '',
        attemptNumber: snapshot.attemptNumber,
      },
    });
  }

  await resolveResumeCommandFromSuccessor(tx, agent, snapshot);
  await resolveCreateCommandFromSnapshot(tx, agent, task, snapshot, createCommandEvidence);

  return task;
}

async function dispatchNextElasticWorkItem(tx, {
  agent,
  capabilities = {},
} = {}) {
  const freshCapabilities = safeJson(capabilities);
  const canClaimKeyword =
    freshCapabilities.remoteTaskCreate === true &&
    freshCapabilities.remoteTaskKeywordPostLimit === true;
  const canClaimNegativePost =
    freshCapabilities.remoteTaskCreate === true &&
    freshCapabilities.remoteTargetedPostCaptureV1 === true &&
    freshCapabilities.negativePostPatrol === true;
  const canClaimWatchedContent =
    freshCapabilities.remoteTaskCreate === true &&
    freshCapabilities.remoteTargetedPostCaptureV1 === true &&
    freshCapabilities.watchedContentPatrol === true;
  const canClaimSequentialSearch =
    freshCapabilities.remoteSequentialSearchPassesV1 === true;
  if (!canClaimKeyword && !canClaimNegativePost && !canClaimWatchedContent) {
    return null;
  }
  const busy = await findCaptureAgentExecutionSlotBlocker(
    tx,
    agent.tenant_id,
    agent.id,
  );
  if (busy) return null;
  const recentRecoveryAttempt = await tx.queryOne(`
    SELECT attempt.status, attempt.error, attempt.checkpoint,
      attempt.finished_at, attempt.updated_at
    FROM capture_task_item_attempts attempt
    JOIN capture_tasks parent
      ON parent.id = attempt.parent_task_id
      AND parent.tenant_id = attempt.tenant_id
    WHERE attempt.tenant_id = $1
      AND attempt.agent_id = $2
      AND attempt.status IN ('retryable', 'needs_action', 'failed')
      AND attempt.updated_at > now() - interval '30 minutes'
      AND COALESCE(parent.metadata->>'distributionMode', '') = 'elastic_pool'
    ORDER BY attempt.updated_at DESC, attempt.id DESC
    LIMIT 1
  `, [agent.tenant_id, agent.id]);
  if (elasticRecoveryHoldRemainingMs(recentRecoveryAttempt) > 0) {
    return null;
  }
  const unresolvedSafetyItem = await tx.queryOne(`
    SELECT item.error, item.metadata
    FROM capture_task_items item
    JOIN capture_tasks parent
      ON parent.id = item.task_id
      AND parent.tenant_id = item.tenant_id
    WHERE item.tenant_id = $1
      AND item.assigned_agent_id = $2
      AND item.status = 'needs_action'
      AND COALESCE(parent.metadata->>'distributionMode', '') = 'elastic_pool'
    ORDER BY item.updated_at DESC, item.id
    LIMIT 1
  `, [agent.tenant_id, agent.id]);
  if (
    unresolvedSafetyItem &&
    classifyCaptureRecoveryDisposition(unresolvedSafetyItem).kind ===
      'manual_current'
  ) {
    return null;
  }

  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : [];
  const supportedPlatforms = normalizeCaptureAgentPlatforms(
    freshCapabilities.supportedPlatforms,
  );
  const candidate = await tx.queryOne(`
    SELECT
      parent.id AS parent_id,
      parent.title AS parent_title,
      parent.platform AS parent_platform,
      parent.metadata AS parent_metadata,
      parent.orchestration_schedule_id,
      parent.scheduled_for,
      parent.schedule_revision,
      item.id AS item_id,
      item.platform AS item_platform,
      item.ordinal,
      item.keyword,
      item.item_type,
      item.error AS item_error,
      item.record_id,
      item.external_id,
      item.url_snapshot,
      item.status AS item_status,
      item.attempt_count,
      item.safety_handoff_count,
      item.assignment_revision,
      item.execution_task_id,
      item.metadata AS item_metadata,
      COALESCE(
        CASE
          WHEN (item.metadata->>'elasticAttemptBudgetUsed') ~ '^[0-9]+$'
          THEN (item.metadata->>'elasticAttemptBudgetUsed')::integer
          ELSE NULL
        END,
        item.attempt_count
      ) AS attempt_budget_used,
      (
        SELECT COUNT(*)
        FROM capture_task_items all_items
        WHERE all_items.tenant_id = parent.tenant_id
          AND all_items.task_id = parent.id
      ) AS parent_item_count
    FROM capture_task_items item
    JOIN capture_tasks parent
      ON parent.id = item.task_id
      AND parent.tenant_id = item.tenant_id
    WHERE item.tenant_id = $1
      AND parent.task_type = 'capture_orchestration'
      AND parent.status IN ('pending', 'running', 'needs_action')
      AND COALESCE(parent.metadata->>'distributionMode', '') = 'elastic_pool'
      AND COALESCE(parent.metadata->>'orchestrationTemplate', 'false') <> 'true'
      AND parent.metadata @> jsonb_build_object(
        'eligibleAgentIds', jsonb_build_array($2::text)
      )
      AND (
        (item.item_type = 'keyword' AND $6::boolean)
        OR (item.item_type = 'negative_post' AND $7::boolean)
        OR (item.item_type = 'watched_content' AND $8::boolean)
      )
      AND item.status IN ('pending', 'retryable')
      AND NOT (
        item.status = 'retryable'
        AND upper(COALESCE(
          NULLIF(item.error->>'code', ''),
          NULLIF(item.metadata->'checkpoint'->>'errorCode', ''),
          NULLIF(item.metadata->'checkpoint'->>'error_code', ''),
          ''
        )) = ANY($11::text[])
      )
      AND (
        COALESCE(jsonb_array_length(parent.metadata->'planSnapshot'->'searchPasses'), 0) <= 1
        OR $10::boolean
      )
      AND COALESCE(
        CASE
          WHEN (item.metadata->>'elasticAttemptBudgetUsed') ~ '^[0-9]+$'
          THEN (item.metadata->>'elasticAttemptBudgetUsed')::integer
          ELSE NULL
        END,
        item.attempt_count
      ) < $3
      AND (cardinality($4::text[]) = 0 OR item.platform = ANY($4::text[]))
      AND (cardinality($5::text[]) = 0 OR item.platform = ANY($5::text[]))
      AND (
        item.execution_task_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM capture_tasks previous_execution
          WHERE previous_execution.id = item.execution_task_id
            AND previous_execution.tenant_id = item.tenant_id
            AND previous_execution.status IN (
              'completed', 'completed_with_warnings',
              'completed_with_failures', 'failed', 'canceled',
              'skipped', 'superseded', 'needs_action', 'interrupted'
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM capture_agent_commands active_command
        WHERE active_command.tenant_id = item.tenant_id
          AND active_command.task_id = item.execution_task_id
          AND active_command.status IN ('pending', 'acknowledged')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM capture_task_item_attempts recent_same_agent_attempt
        WHERE recent_same_agent_attempt.tenant_id = item.tenant_id
          AND recent_same_agent_attempt.item_id = item.id
          AND recent_same_agent_attempt.agent_id = $2::uuid
          AND recent_same_agent_attempt.status IN (
            'retryable', 'needs_action', 'failed'
          )
          AND recent_same_agent_attempt.updated_at >
            now() - ($9::bigint * interval '1 millisecond')
      )
    ORDER BY
      COALESCE(parent.scheduled_for, parent.created_at),
      parent.created_at,
      item.ordinal,
      item.id
    FOR UPDATE OF parent, item SKIP LOCKED
    LIMIT 1
  `, [
    agent.tenant_id,
    agent.id,
    AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT,
    allowedPlatforms,
    supportedPlatforms,
    canClaimKeyword,
    canClaimNegativePost,
    canClaimWatchedContent,
    ELASTIC_SAME_ITEM_RETRY_COOLDOWN_MS,
    canClaimSequentialSearch,
    CAPTURE_SAFETY_HANDOFF_SEARCH_CODES,
  ]);
  if (!candidate) return null;

  const parentMetadata = safeJson(candidate.parent_metadata);
  const planSnapshot = safeJson(parentMetadata.planSnapshot);
  const itemMetadata = safeJson(candidate.item_metadata);
  const negativePost = candidate.item_type === 'negative_post';
  const watchedContent = candidate.item_type === 'watched_content';
  const targetedContent = negativePost || watchedContent;
  let bootstrapPacing = null;
  if (!targetedContent) {
    const recentBootstrapHealth = await tx.queryOne(`
      SELECT
        COUNT(*)::integer AS failure_count,
        COUNT(DISTINCT attempt.agent_id)::integer AS affected_agent_count
      FROM capture_task_item_attempts attempt
      WHERE attempt.tenant_id = $1
        AND attempt.updated_at >
          now() - ($2::bigint * interval '1 millisecond')
        AND attempt.status IN ('retryable', 'needs_action', 'failed')
        AND UPPER(COALESCE(attempt.error->>'code', '')) = ANY($3::text[])
    `, [
      agent.tenant_id,
      ELASTIC_BOOTSTRAP_CONGESTION_WINDOW_MS,
      Array.from(ELASTIC_BOOTSTRAP_CONGESTION_CODES),
    ]);
    bootstrapPacing = projectElasticBootstrapPacing({
      seed: [
        candidate.parent_id,
        candidate.item_id,
        candidate.ordinal,
        candidate.assignment_revision,
        agent.id,
      ].join(':'),
      recentFailureCount: recentBootstrapHealth?.failure_count,
      recentAffectedAgentCount: recentBootstrapHealth?.affected_agent_count,
    });
  }
  const targetedWorkflow = watchedContent
    ? 'watched_content_patrol'
    : 'negative_post_patrol';
  if (
    !targetedContent &&
    Object.keys(safeJson(planSnapshot.captureSettings)).length > 0 &&
    freshCapabilities.remoteTaskEnhancementOptions !== true
  ) {
    return null;
  }
  const sequentialResumeCheckpoint = targetedContent
    ? null
    : buildSequentialSearchResumeCheckpoint({
        planSnapshot,
        itemMetadata,
        keyword: candidate.keyword,
      });

  const childTaskId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const assignmentRevision =
    Math.max(0, Number(candidate.assignment_revision) || 0) + 1;
  const attempt = await tx.queryOne(`
    SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number
    FROM capture_task_item_attempts
    WHERE tenant_id = $1 AND item_id = $2
  `, [agent.tenant_id, candidate.item_id]);
  const attemptBudget =
    Math.max(0, Number(candidate.attempt_budget_used) || 0) + 1;
  const attemptNumber = Math.max(
    Math.max(0, Number(candidate.attempt_count) || 0) + 1,
    Number(attempt?.next_attempt_number || 1),
  );
  const attemptIdentity = crypto.randomUUID();
  const childTitle = `${candidate.parent_title} · ${Number(candidate.ordinal) + 1}/${Number(candidate.parent_item_count)}`;
  let requestHash = '';
  let childPlan = {};
  let childTaskType = 'unattended_keyword_capture';
  let childFeatureKey = 'unattended_keyword_plan';
  let childCheckpoint = sequentialResumeCheckpoint || {
    round: 1,
    keywordIndex: 0,
  };
  let claimUnit = 'keyword';
  let childMessage = '已从云端领取 1 个关键词，等待设备确认';
  let commandPayload = {};
  if (targetedContent) {
    const sourceRecord = safeJson(itemMetadata.sourceRecord);
    const captureSettings = safeJson(parentMetadata.captureSettings);
    const target = {
      itemId: candidate.item_id,
      recordId: candidate.record_id,
      externalId: candidate.external_id,
      url: candidate.url_snapshot,
      title: text(sourceRecord.title, 1000),
      publishedAt:
        sourceRecord.publishedAt || sourceRecord.publishTime || undefined,
      noteType: text(sourceRecord.noteType, 100),
      baseline: safeJson(itemMetadata.baseline),
    };
    requestHash = crypto.createHash('sha256').update(JSON.stringify({
      workflow: targetedWorkflow,
      protocolVersion: 3,
      parentTaskId: candidate.parent_id,
      itemId: candidate.item_id,
      assignmentRevision,
      agentId: agent.id,
      recordId: candidate.record_id,
      captureSettings,
    })).digest('hex');
    childTaskType = targetedWorkflow;
    childFeatureKey = targetedWorkflow;
    childCheckpoint = {targetIndex: 0};
    claimUnit = candidate.item_type;
    childMessage = '已从云端领取 1 篇帖子，等待设备确认';
    commandPayload = {
      taskId: childTaskId,
      clientTaskId: childTaskId,
      parentTaskId: candidate.parent_id,
      title: childTitle,
      executionMode: 'one_time',
      platform: candidate.item_platform,
      workflow: targetedWorkflow,
      taskKind: targetedWorkflow,
      protocolVersion: 1,
      targets: [target],
      items: [target],
      captureSettings,
      requestHash,
      authCodeId: agent.auth_code_id,
      authBindingId: agent.auth_binding_id,
      orchestration: {
        parentTaskId: candidate.parent_id,
        revision: assignmentRevision,
        itemIds: [candidate.item_id],
        distributionMode: 'elastic_pool',
        ...(bootstrapPacing || {}),
      },
      attemptIdentity,
    };
  } else {
    const childInput = normalizeRemoteTaskInput({
      clientTaskId: childTaskId,
      title: childTitle,
      executionMode: 'one_time',
      planSnapshot: {
        ...planSnapshot,
        enabled: true,
        autoLoop: false,
        maxRounds: 1,
        roundGapMin: 0,
        platform: candidate.parent_platform,
        keywords: [candidate.keyword],
        searchFilters: {
          ...safeJson(planSnapshot.searchFilters),
        },
        recoveryPolicy: {
          ...safeJson(planSnapshot.recoveryPolicy),
          disableAutomaticSearchRetry:
            itemMetadata.disableAutomaticSearchRetry === true,
          requireVerifiedFilters:
            itemMetadata.requireVerifiedFilters === true,
        },
      },
    });
    childPlan = childInput.planSnapshot;
    requestHash = hashOrchestrationRequest({
      parentTaskId: candidate.parent_id,
      itemId: candidate.item_id,
      assignmentRevision,
      agentId: agent.id,
      taskInput: childInput,
    });
    commandPayload = {
      taskId: childTaskId,
      clientTaskId: childTaskId,
      title: childTitle,
      executionMode: 'one_time',
      platform: childPlan.platform,
      planSnapshot: childPlan,
      ...(sequentialResumeCheckpoint
        ? {checkpoint: sequentialResumeCheckpoint}
        : {}),
      requestHash,
      authCodeId: agent.auth_code_id,
      authBindingId: agent.auth_binding_id,
      orchestration: {
        parentTaskId: candidate.parent_id,
        revision: assignmentRevision,
        itemIds: [candidate.item_id],
        distributionMode: 'elastic_pool',
        ...(bootstrapPacing || {}),
      },
      attemptIdentity,
    };
  }
  const itemAttemptBindings = [{
    itemId: candidate.item_id,
    attemptId: attemptIdentity,
    requestHash,
    attemptNumber,
    assignmentRevision,
    keyword: text(candidate.keyword, 120),
    recordId: text(candidate.record_id, 100),
    externalId: text(candidate.external_id, 160),
  }];
  const bindTargetAttempt = (target) => ({
    ...safeJson(target),
    captureTaskItemAttemptId: attemptIdentity,
    captureTaskItemRequestHash: requestHash,
    captureTaskItemAttemptNumber: attemptNumber,
    captureTaskItemAssignmentRevision: assignmentRevision,
  });
  commandPayload = {
    ...commandPayload,
    ...(Array.isArray(commandPayload.targets)
      ? {targets: commandPayload.targets.map(bindTargetAttempt)}
      : {}),
    ...(Array.isArray(commandPayload.items)
      ? {items: commandPayload.items.map(bindTargetAttempt)}
      : {}),
    orchestration: {
      ...safeJson(commandPayload.orchestration),
      itemAttempts: itemAttemptBindings,
    },
  };
  const childMetadata = {
    remoteCreated: true,
    remoteRequestHash: requestHash,
    createCommandId: commandId,
    requestedByUserId: '',
    requestedByName: '云端弹性调度器',
    executionMode: 'one_time',
    ...(targetedContent
      ? {
          workflow: targetedWorkflow,
          taskKind: targetedWorkflow,
          protocolVersion: 1,
          filter: safeJson(parentMetadata.filter),
          selectedRecordIds: [candidate.record_id],
          captureSettings: safeJson(parentMetadata.captureSettings),
        }
      : {planSnapshot: childPlan}),
    orchestrationChild: true,
    parentTaskId: candidate.parent_id,
    orchestrationRevision: assignmentRevision,
    itemIds: [candidate.item_id],
    cloudWorkQueue: true,
    distributionMode: 'elastic_pool',
    claimUnit,
    attemptIdentity,
    ...(bootstrapPacing ? {bootstrapPacing} : {}),
    ...(sequentialResumeCheckpoint
      ? {
          resumedSequentialSearch: true,
          resumeRound: sequentialResumeCheckpoint.round,
        }
      : {}),
    createAckTimeoutSeconds:
      Math.floor(ELASTIC_QUEUE_CREATE_ACK_TIMEOUT_MS / 1000),
    scheduleId: candidate.orchestration_schedule_id || undefined,
    scheduledFor: candidate.scheduled_for || undefined,
  };
  const previousExecutionTaskId = text(candidate.execution_task_id, 100);
  if (
    UUID_PATTERN.test(previousExecutionTaskId) &&
    previousExecutionTaskId !== childTaskId
  ) {
    await tx.execute(`
      UPDATE capture_tasks
      SET status = 'superseded',
        metadata = metadata || jsonb_build_object(
          'handoffSuccessorTaskId', $1::uuid::text,
          'handoffReason', 'elastic_retry_claimed',
          'handoffAt', now()::text,
          'handoffSuccessorAttemptIdentity', $5::text
        ),
        message = '当前工作项已由其它 Agent 自动接力',
        updated_at = now()
      WHERE id = $2
        AND tenant_id = $3
        AND parent_task_id = $4
        AND status IN (
          'interrupted', 'needs_action', 'failed',
          'completed_with_failures', 'canceled', 'skipped'
        )
    `, [
      childTaskId,
      previousExecutionTaskId,
      agent.tenant_id,
      candidate.parent_id,
      attemptIdentity,
    ]);
  }
  await tx.execute(`
    INSERT INTO capture_tasks (
      id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, task_type, feature_key, title, platform,
      source, trigger_type, status, progress, checkpoint, counts,
      metadata, message, orchestration_revision, source_updated_at,
      orchestration_schedule_id, scheduled_for, schedule_revision
    ) VALUES (
      $1::uuid, $2, $3, $4, $4,
      $1::uuid::text, $5, $6, $7, $8,
      'cloud', 'elastic_pool_claim', 'pending',
      $9::jsonb, $10::jsonb, $11::jsonb,
      $12::jsonb, $13, $14, now(),
      $15, $16, $17
    )
  `, [
    childTaskId,
    agent.tenant_id,
    candidate.parent_id,
    agent.id,
    childTaskType,
    childFeatureKey,
    childTitle,
    targetedContent ? candidate.item_platform : candidate.parent_platform,
    JSON.stringify({current: 0, total: 1, percent: 0, phase: 'queued'}),
    JSON.stringify(childCheckpoint),
    JSON.stringify({
      total: 1,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    }),
    JSON.stringify(childMetadata),
    childMessage,
    assignmentRevision,
    candidate.orchestration_schedule_id || null,
    candidate.scheduled_for || null,
    candidate.schedule_revision || null,
  ]);
  const updatedItem = await tx.queryOne(`
    UPDATE capture_task_items
    SET status = 'dispatched',
      attempt_count = $1,
      metadata = (metadata - 'checkpoint' - 'targetResult') ||
        jsonb_build_object('elasticAttemptBudgetUsed', $2::integer),
      assigned_agent_id = $3,
      execution_task_id = $4,
      assignment_revision = $5,
      request_hash = $6,
      error = '{}'::jsonb,
      assigned_at = now(),
      dispatched_at = now(),
      started_at = NULL,
      finished_at = NULL,
      updated_at = now()
    WHERE id = $7 AND tenant_id = $8 AND task_id = $9
      AND status = $10
      AND assignment_revision = $11
    RETURNING id
  `, [
    attemptNumber,
    attemptBudget,
    agent.id,
    childTaskId,
    assignmentRevision,
    requestHash,
    candidate.item_id,
    agent.tenant_id,
    candidate.parent_id,
    candidate.item_status,
    Number(candidate.assignment_revision || 0),
  ]);
  if (!updatedItem) {
    const conflict = new Error('elastic_queue_item_claim_conflict');
    conflict.code = 'elastic_queue_item_claim_conflict';
    throw conflict;
  }
  await tx.execute(`
    INSERT INTO capture_task_item_attempts (
      id, tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      request_hash, checkpoint, result, error, dispatched_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, 'dispatched',
      $9, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
    )
  `, [
    attemptIdentity,
    agent.tenant_id,
    candidate.item_id,
    candidate.parent_id,
    childTaskId,
    agent.id,
    attemptNumber,
    assignmentRevision,
    requestHash,
  ]);
  await tx.execute(`
    INSERT INTO capture_agent_commands (
      id, tenant_id, agent_id, task_id, command_type, payload,
      requested_by_name, expires_at
    ) VALUES (
      $1, $2, $3, $4, 'create', $5::jsonb,
      '云端弹性调度器', $6
    )
  `, [
    commandId,
    agent.tenant_id,
    agent.id,
    childTaskId,
    JSON.stringify(commandPayload),
    new Date(Date.now() + ELASTIC_QUEUE_CREATE_ACK_TIMEOUT_MS).toISOString(),
  ]);
  await refreshOrchestrationParentTask(tx, {
    tenantId: agent.tenant_id,
    parentTaskId: candidate.parent_id,
    snapshot: {
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    childTaskId,
    actorType: 'system',
    actorName: '云端弹性调度器',
    eventAgentId: agent.id,
  });
  await appendEvent(tx, {
    tenantId: agent.tenant_id,
    taskId: childTaskId,
    agentId: agent.id,
    eventType: 'elastic_work_item_dispatched',
    status: 'pending',
    message: targetedContent
      ? '空闲节点已从云端领取 1 篇帖子'
      : '空闲节点已从云端领取 1 个关键词',
    payload: {
      parentTaskId: candidate.parent_id,
      itemId: candidate.item_id,
      claimUnit,
      ...(targetedContent
        ? {recordId: candidate.record_id}
        : {keyword: candidate.keyword}),
      assignmentRevision,
      attemptNumber,
      attemptBudget,
      ...(bootstrapPacing || {}),
      commandId,
    },
  });
  return {
    childTaskId,
    commandId,
    itemId: candidate.item_id,
    claimUnit,
  };
}

// Keep the short online lease independent from the full state reconciliation.
// A capture snapshot, account probe, or command can legitimately take longer
// than one heartbeat interval; that work must never make a healthy browser look
// offline to the scheduler.
router.post('/agent/liveness', requireCaptureAgent, async (req, res, next) => {
  try {
    const result = await withTransaction(async tx => {
      const currentAgent = await lockActiveCaptureAgentSession(
        tx,
        req.captureAgent,
      );
      if (!currentAgent) return {agentInactive: true};
      await tx.execute(`
        UPDATE capture_agents
        SET last_heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2
      `, [req.captureAgent.id, req.captureAgent.tenant_id]);
      return {agentInactive: false};
    });
    if (result.agentInactive) {
      return res.status(403).json({
        ok: false,
        error: 'agent_inactive',
        message: '采集节点已撤销或授权已变更，请重新验证扩展',
      });
    }
    return res.json({
      ok: true,
      agent: {
        id: req.captureAgent.id,
        heartbeatAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/agent/heartbeat', requireCaptureAgent, async (req, res, next) => {
  try {
    const agent = req.captureAgent;
    const clientUuid = text(req.body?.agent?.clientUuid, 240);
    if (clientUuid && clientUuid !== agent.client_uuid) {
      return res.status(409).json({ ok: false, error: 'agent_identity_mismatch', message: '采集节点身份不匹配，请重新验证扩展' });
    }

    const rawTasks = Array.isArray(req.body?.tasks)
      ? req.body.tasks.slice(0, MAX_HEARTBEAT_TASKS)
      : [];
    const snapshots = rawTasks.map(normalizeCloudTaskSnapshot).filter(Boolean);
    const hasUnattendedPlan = Object.prototype.hasOwnProperty.call(
      req.body || {},
      'unattendedPlan',
    );
    const rawUnattendedPlan = safeJson(req.body?.unattendedPlan);
    const unattendedPlan = req.body?.unattendedPlan == null ||
      Object.keys(rawUnattendedPlan).length === 0
      ? {}
      : normalizeRemoteTaskInput({planSnapshot: rawUnattendedPlan}).planSnapshot;
    const heartbeatCapabilities = sanitizeCloudStructuredObject(
      req.body?.agent?.capabilities,
    );
    const observedSocialAccounts = (
      Array.isArray(req.body?.observedSocialAccounts)
        ? req.body.observedSocialAccounts
        : []
    )
      .slice(0, 10)
      .map(item => sanitizeCloudStructuredObject(item));
    const socialUsageEvents = (
      Array.isArray(req.body?.socialUsageEvents)
        ? req.body.socialUsageEvents
        : []
    )
      .slice(0, 200)
      .map(item => sanitizeCloudStructuredObject(item));
    if (Object.prototype.hasOwnProperty.call(heartbeatCapabilities, 'supportedPlatforms')) {
      heartbeatCapabilities.supportedPlatforms = normalizeCaptureAgentPlatforms(
        heartbeatCapabilities.supportedPlatforms,
      );
    }
    const result = await withTransaction(async tx => {
      const currentAgent = await lockActiveCaptureAgentSession(tx, agent);
      if (!currentAgent) return {agentInactive: true};
      await tx.execute(`
        UPDATE capture_agents
        SET client_label = COALESCE(NULLIF($1, ''), client_label),
          app_version = COALESCE(NULLIF($2, ''), app_version),
          capabilities = $3::jsonb,
          last_heartbeat_at = now(),
          last_error = $4,
          unattended_plan = CASE
            WHEN $5::boolean THEN $6::jsonb
            ELSE unattended_plan
          END,
          unattended_plan_updated_at = CASE
            WHEN $5::boolean THEN now()
            ELSE unattended_plan_updated_at
          END,
          updated_at = now()
        WHERE id = $7 AND tenant_id = $8
      `, [
        text(req.body?.agent?.clientLabel, 240),
        text(req.body?.agent?.appVersion, 80),
        JSON.stringify(heartbeatCapabilities),
        sanitizeCloudText(req.body?.agent?.lastError, 1000),
        hasUnattendedPlan,
        JSON.stringify(unattendedPlan),
        agent.id,
        agent.tenant_id,
      ]);

      await expireStaleCommands(tx, agent.tenant_id, null, agent.id);

      const socialAccountResult = await processSocialAccountHeartbeat(tx, {
        agent,
        observedAccounts: observedSocialAccounts,
        usageEvents: socialUsageEvents,
      });

      const mirroredTasks = [];
      for (const snapshot of snapshots) {
        mirroredTasks.push(await mirrorTaskSnapshot(tx, agent, snapshot));
      }

      const elasticClaim = await dispatchNextElasticWorkItem(tx, {
        agent: {
          ...agent,
          ...currentAgent,
        },
        capabilities: heartbeatCapabilities,
      });

      const commands = await tx.queryAll(`
        SELECT c.id, c.command_type, c.payload, c.status, c.created_at,
          t.id AS task_id, t.client_task_id, t.control_task_id,
          t.task_type, t.platform, t.title, t.status AS task_status
        FROM capture_agent_commands c
        JOIN capture_tasks t ON t.id = c.task_id AND t.tenant_id = c.tenant_id
        WHERE c.agent_id = $1
          AND c.tenant_id = $2
          AND c.status IN ('pending', 'acknowledged')
          AND c.expires_at > now()
          AND c.payload->>'authCodeId' = $3
          AND c.payload->>'authBindingId' = $4
          AND c.payload->>'platform' = t.platform
          AND (
            c.command_type = 'stop'
            OR
            cardinality($5::text[]) = 0
            OR t.platform = ANY($5::text[])
          )
          AND (
            c.command_type <> 'create'
            OR cardinality($6::text[]) = 0
            OR t.platform = ANY($6::text[])
          )
          AND (
            c.command_type <> 'resume'
            OR (
              t.status = 'resume_requested'
              AND t.metadata->>'resumeCommandId' = c.id::text
            )
          )
          AND (
            c.command_type <> 'create'
            OR (
              t.status IN ('pending', 'claimed')
              AND t.metadata->>'createCommandId' = c.id::text
            )
          )
          AND (
            c.command_type <> 'stop'
            OR (
              t.status NOT IN (
                'completed', 'completed_with_warnings', 'canceled',
                'skipped', 'superseded'
              )
              AND t.metadata->>'stopCommandId' = c.id::text
            )
          )
        -- Stop always wins: a queued create/resume must never make the browser
        -- continue work after an operator has requested cancellation.
        ORDER BY CASE
          WHEN c.command_type = 'stop' THEN 0
          WHEN c.command_type = 'resume' THEN 1
          -- Saving a plan does not need the capture execution slot. Prioritize
          -- it over ordinary creates so a busy queue cannot starve a newer
          -- unattended-plan configuration behind ten deferred capture jobs.
          WHEN c.command_type = 'create'
            AND c.payload->>'executionMode' = 'unattended_plan' THEN 2
          ELSE 3
        END, c.created_at ASC, c.id ASC
        LIMIT 10
      `, [
        agent.id,
        agent.tenant_id,
        agent.auth_code_id,
        agent.auth_binding_id,
        Array.isArray(agent.allowed_platforms) ? agent.allowed_platforms : [],
        normalizeCaptureAgentPlatforms(heartbeatCapabilities.supportedPlatforms),
      ]);

      if (commands.length > 0) {
        await tx.execute(`
          UPDATE capture_agent_commands
          SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, now()), updated_at = now()
          WHERE id = ANY($1::uuid[]) AND status = 'pending'
        `, [commands.map(command => command.id)]);

        const newlyAcknowledgedCreates = commands.filter(command =>
          command.command_type === 'create' && command.status === 'pending',
        );
        for (const command of newlyAcknowledgedCreates) {
          await appendEvent(tx, {
            tenantId: agent.tenant_id,
            taskId: command.task_id,
            agentId: agent.id,
            eventType: 'create_command_acknowledged',
            actorType: 'capture_agent',
            actorId: agent.id,
            actorName: agent.display_name || agent.client_label,
            status: command.task_status,
            message: '设备已收到创建指令，等待本地空闲后执行',
            payload: {commandId: command.id, commandType: command.command_type},
          });
        }
      }

      return { mirroredTasks, commands, socialAccountResult, elasticClaim };
    });

    if (result.agentInactive) {
      return res.status(403).json({
        ok: false,
        error: 'agent_inactive',
        message: '采集节点已撤销或授权已变更，请重新验证扩展',
      });
    }
    return res.json({
      ok: true,
      agent: {
        id: agent.id,
        heartbeatAt: new Date().toISOString(),
      },
      tasksAccepted: result.mirroredTasks.length,
      observedAccountsAccepted:
        result.socialAccountResult.observedAccountCount,
      acceptedSocialUsageEventIds:
        result.socialAccountResult.acceptedUsageEventIds,
      elasticWorkItemClaimed: Boolean(result.elasticClaim),
      commands: result.commands,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/agent/commands/:id/complete', requireCaptureAgent, async (req, res, next) => {
  try {
    const reportedSuccess = req.body?.success === true;
    const resultPayload = sanitizeCloudStructuredObject(req.body?.result);
    const commandResult = await withTransaction(async tx => {
      const currentAgent = await lockActiveCaptureAgentSession(
        tx,
        req.captureAgent,
      );
      if (!currentAgent) return {agentInactive: true};

      const commandRef = await tx.queryOne(`
        SELECT task_id
        FROM capture_agent_commands
        WHERE id = $1 AND tenant_id = $2 AND agent_id = $3
      `, [req.params.id, req.tenantId, req.captureAgent.id]);
      if (!commandRef) return {notFound: true};

      // Match heartbeat and expiry ordering: task first, then its command.
      const lockedTask = await tx.queryOne(`
        SELECT id, parent_task_id, assigned_agent_id, task_type,
          status, error, metadata, created_at
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [commandRef.task_id, req.tenantId]);
      const command = await tx.queryOne(`
        SELECT * FROM capture_agent_commands
        WHERE id = $1 AND tenant_id = $2 AND agent_id = $3
        FOR UPDATE
      `, [req.params.id, req.tenantId, req.captureAgent.id]);
      if (!command) return {notFound: true};

      let success = reportedSuccess;
      let stopOutcome = null;
      const createExecutionMode = command.payload?.executionMode === 'unattended_plan'
        ? 'unattended_plan'
        : 'one_time';
      const createPlanOperation =
        createExecutionMode === 'unattended_plan' &&
        command.payload?.planOperation === 'delete'
          ? 'delete'
          : 'save';
      const targetedPostCreate =
        command.command_type === 'create' &&
        (
          isTargetedPostTaskType(lockedTask?.task_type) ||
          isTargetedPostTaskType(command.payload?.workflow)
        );
      let expectedCreateRequestId = '';
      let allowLateCreateSuccess = false;
      if (
        command.command_type === 'create' &&
        (success || targetedPostCreate)
      ) {
        expectedCreateRequestId = text(command.payload?.clientTaskId, 240);
        const actualRequestId = text(resultPayload.requestId, 240);
        if (!expectedCreateRequestId || actualRequestId !== expectedCreateRequestId) {
          return {
            invalidCreateResult: true,
            expectedRequestId: expectedCreateRequestId,
            actualRequestId,
          };
        }
        // A command can cross expires_at after the device has already received
        // and created it. Exact request identity plus acknowledged_at is durable
        // proof, so accept that late success instead of manufacturing a failure.
        const createStopReason = text(command.result?.reason, 120);
        const stoppedByOperator = [
          'superseded_by_stop',
          'stopped_before_dispatch',
          'superseded_by_newer_plan',
          'agent_retired',
        ].includes(createStopReason) || Boolean(lockedTask?.metadata?.stopCommandId);
        allowLateCreateSuccess =
          success &&
          Boolean(command.acknowledged_at) &&
          !stoppedByOperator;
      }
      if (command.command_type === 'stop') {
        stopOutcome = resolveStopCommandOutcome({
          reportedSuccess,
          expectedRequestId: command.payload?.controlTaskId,
          actualRequestId: resultPayload.requestId,
          expectedAttemptId: command.payload?.attemptId,
          actualAttemptId: resultPayload.attemptId,
          resultReason: resultPayload.reason,
          supersededCreateCommandId:
            command.payload?.supersededCreateCommandId,
          previousStatus: command.payload?.previousStatus,
        });
        if (!stopOutcome.validRequestId || !stopOutcome.validAttemptId) {
          return {
            invalidStopResult: true,
            expectedRequestId: text(command.payload?.controlTaskId, 240),
            actualRequestId: text(resultPayload.requestId, 240),
            expectedAttemptId: text(command.payload?.attemptId, 240),
            actualAttemptId: text(resultPayload.attemptId, 240),
            attemptMismatch:
              stopOutcome.validRequestId && !stopOutcome.validAttemptId,
          };
        }
        success = stopOutcome.success;
      }
      const desiredCommandStatus = success ? 'completed' : 'failed';
      if (command.status === 'completed' || command.status === 'failed') {
        return {
          command,
          idempotent: command.status === desiredCommandStatus,
          conflict: command.status !== desiredCommandStatus,
        };
      }
      if (command.status === 'expired' && !allowLateCreateSuccess) {
        return {command, expired: true};
      }
      const expiredByTime = command.expires_at &&
        new Date(command.expires_at).getTime() <= Date.now();
      if (expiredByTime && !allowLateCreateSuccess) {
        await expireStaleCommands(tx, req.tenantId, command.task_id);
        return {command, expired: true};
      }
      await tx.execute(`
        UPDATE capture_agent_commands
        SET status = $1, result = $2::jsonb,
          finished_at = now(), updated_at = now()
        WHERE id = $3 AND status IN ('pending', 'acknowledged', 'expired')
      `, [desiredCommandStatus, JSON.stringify(resultPayload), command.id]);

      let nextStatus = 'needs_action';
      let eventMessage = '';
      let updatedTask = null;
      if (command.command_type === 'create') {
        const expectedRequestId = expectedCreateRequestId ||
          text(command.payload?.clientTaskId, 240);
        nextStatus = success
          ? createExecutionMode === 'unattended_plan' ? 'completed' : 'claimed'
          : 'needs_action';
        eventMessage = targetedPostCreate
          ? text(
              resultPayload.message || (
                success
                  ? `设备已完成${targetedPostTaskLabel(lockedTask?.task_type || command.payload?.workflow)}并返回${
                      isProfilePatrolTask(
                        lockedTask || {
                          task_type: command.payload?.workflow,
                        },
                        command.payload,
                      )
                        ? '账号扫描结果'
                        : '逐帖结果'
                    }`
                  : `设备未能完成${targetedPostTaskLabel(lockedTask?.task_type || command.payload?.workflow)}`
              ),
              2000,
            )
          : success
            ? createExecutionMode === 'unattended_plan'
              ? createPlanOperation === 'delete'
                ? '设备已停止并删除无人值守计划'
                : '设备已保存并启用无人值守计划'
              : '设备已创建本地任务，等待开始执行'
            : text(resultPayload.message || '设备未能创建云端下发任务', 2000);
        updatedTask = await tx.queryOne(`
          UPDATE capture_tasks
          SET status = $1,
            control_task_id = CASE
              WHEN $2 AND $11 = 'one_time' THEN $3
              ELSE control_task_id
            END,
            message = $4,
            error = CASE WHEN $2 THEN '{}'::jsonb ELSE $5::jsonb END,
            progress = CASE
              WHEN $2 AND $11 = 'unattended_plan'
                THEN jsonb_build_object('current', 1, 'total', 1, 'phase', 'saved')
              ELSE progress
            END,
            counts = CASE
              WHEN $2 AND $11 = 'unattended_plan'
                THEN jsonb_build_object(
                  'total', 1, 'processed', 1, 'success', 1,
                  'failed', 0, 'skipped', 0
                )
              ELSE counts
            END,
            finished_at = CASE
              WHEN NOT $2 OR $11 = 'unattended_plan' THEN now()
              ELSE NULL
            END,
            metadata = metadata || $6::jsonb,
            updated_at = now()
          WHERE id = $7 AND tenant_id = $8 AND assigned_agent_id = $9
            AND (
              status IN ('pending', 'claimed')
              OR (
                $2::boolean
                AND status = 'failed'
                AND error->>'code' = 'create_command_expired'
              )
            )
            AND metadata->>'createCommandId' = $10
          RETURNING id, parent_task_id, status
        `, [
          nextStatus,
          success,
          expectedRequestId,
          eventMessage,
          JSON.stringify(success ? {} : {
            code: text(resultPayload.reason || 'create_command_failed', 120),
            message: eventMessage,
          }),
          JSON.stringify(success ? {
            createCompletedAt: new Date().toISOString(),
            executionMode: createExecutionMode,
            ...(createExecutionMode === 'unattended_plan'
              ? createPlanOperation === 'delete'
                ? {
                    planOperation: 'delete',
                    planDeletedAt: new Date().toISOString(),
                  }
                : {planAppliedAt: new Date().toISOString()}
              : {localRequestId: expectedRequestId}),
          } : {
            createFailedAt: new Date().toISOString(),
            executionMode: createExecutionMode,
          }),
          command.task_id,
          req.tenantId,
          req.captureAgent.id,
          command.id,
          createExecutionMode,
        ]);
        if (
          success &&
          createExecutionMode === 'unattended_plan' &&
          createPlanOperation === 'delete'
        ) {
          await tx.execute(`
            UPDATE capture_agents
            SET unattended_plan = '{}'::jsonb,
              unattended_plan_updated_at = now(),
              updated_at = now()
            WHERE id = $1 AND tenant_id = $2
          `, [req.captureAgent.id, req.tenantId]);
        }
      } else if (command.command_type === 'resume') {
        // A manual continuation creates a new local root request. The interrupted
        // cloud mirror is therefore superseded instead of pretending that the old
        // execution attempt itself became running again.
        nextStatus = success ? 'superseded' : 'needs_action';
        eventMessage = success
          ? '设备已创建新的恢复任务'
          : text(
            resultPayload.message || '设备未能执行远程继续',
            2000,
          );
        updatedTask = await tx.queryOne(`
          UPDATE capture_tasks
          SET status = $1,
            message = $2,
            metadata = (metadata - 'resumeCommandId' - 'resumePreviousStatus') || $3::jsonb,
            updated_at = now()
          WHERE id = $4 AND tenant_id = $5
            AND status = 'resume_requested'
            AND metadata->>'resumeCommandId' = $6
          RETURNING id, parent_task_id, status
        `, [
          nextStatus,
          eventMessage,
          JSON.stringify(success ? {
            recoveryTaskId: text(resultPayload.requestId, 240),
            recoveryCommandId: command.id,
          } : {}),
          command.task_id,
          req.tenantId,
          command.id,
        ]);
      } else if (command.command_type === 'stop') {
        nextStatus = stopOutcome?.taskStatus || (
          success ? 'canceled' : stopFailureStatus(command.payload?.previousStatus)
        );
        eventMessage = success
          ? stopOutcome?.stoppedBeforeLocalCreation
            ? '创建指令已被停止取代，设备没有需要继续停止的本地任务'
            : '设备已停止任务'
          : text(resultPayload.message || '设备未能停止任务', 2000);
        updatedTask = await tx.queryOne(`
          UPDATE capture_tasks
          SET status = $1,
            message = $2,
            metadata = metadata
              - 'stopCommandId' - 'stopPreviousStatus'
              - 'resumeCommandId' - 'resumePreviousStatus',
            finished_at = CASE WHEN $3 THEN now() ELSE finished_at END,
            updated_at = now()
          WHERE id = $4 AND tenant_id = $5
            AND metadata->>'stopCommandId' = $6
          RETURNING id, parent_task_id, status
        `, [
          nextStatus,
          eventMessage,
          success,
          command.task_id,
          req.tenantId,
          command.id,
        ]);
        if (success) {
          await cancelProfileDiscoveryWork(tx, {
            tenantId: req.tenantId,
            taskId: command.task_id,
            task: lockedTask,
            payload: command.payload,
            message: eventMessage,
          });
        }
      }
      if (updatedTask && targetedPostCreate) {
        const projectedTask = await projectNegativePatrolSnapshot(
          tx,
          req.captureAgent,
          {
            ...lockedTask,
            ...updatedTask,
            task_type: lockedTask?.task_type || text(command.payload?.workflow, 80),
            assigned_agent_id: req.captureAgent.id,
          },
          {
            status: text(
              resultPayload.status,
              80,
            ) || (success ? 'completed' : 'needs_action'),
            checkpoint: safeJson(resultPayload.checkpoint),
            targetResults: Array.isArray(resultPayload.targetResults)
              ? resultPayload.targetResults
              : [],
            message: eventMessage,
            error: safeJson(resultPayload.error),
          },
        );
        if (projectedTask) {
          updatedTask = projectedTask;
        }
      }
      const currentTask = updatedTask || lockedTask;
      await appendEvent(tx, {
        tenantId: req.tenantId,
        taskId: command.task_id,
        agentId: req.captureAgent.id,
        eventType: updatedTask
          ? success ? 'command_completed' : 'command_failed'
          : 'command_result_ignored',
        actorType: 'capture_agent',
        actorId: req.captureAgent.id,
        actorName: req.captureAgent.display_name || req.captureAgent.client_label,
        status: currentTask?.status || nextStatus,
        message: updatedTask
          ? eventMessage
          : '任务状态已变化，迟到的指令回执未覆盖当前状态',
        payload: {
          commandId: command.id,
          commandType: command.command_type,
          recoveryTaskId: text(resultPayload.requestId, 240),
          requestId: text(resultPayload.requestId, 240),
          ...(command.command_type === 'create'
            ? {planOperation: createPlanOperation}
            : {}),
        },
      });
      if (
        success &&
        updatedTask &&
        command.command_type === 'create' &&
        createExecutionMode === 'unattended_plan' &&
        lockedTask.task_type === 'unattended_plan_configuration'
      ) {
        const planWasDeleted = createPlanOperation === 'delete';
        await supersedeStalePlanConfigurationAttention(tx, {
          tenantId: req.tenantId,
          agentId: req.captureAgent.id,
          supersededByTaskId: command.task_id,
          supersededByCreatedAt: lockedTask.created_at,
          actorType: 'capture_agent',
          actorId: req.captureAgent.id,
          actorName:
            req.captureAgent.display_name || req.captureAgent.client_label,
          taskMessage: planWasDeleted
            ? '已被成功删除无人值守计划的指令替代'
            : '已被成功保存的无人值守计划替代',
          eventMessage: planWasDeleted
            ? '设备已成功删除计划，较早失败的计划配置已封存'
            : '设备已成功保存计划，较早失败的计划配置已封存',
        });
      }
      if (updatedTask?.parent_task_id && command.command_type === 'create') {
        const createError = success
          ? {}
          : {
            code: text(resultPayload.reason || 'create_command_failed', 120),
            message: eventMessage,
          };
        await projectOrchestrationChildControlOutcome(tx, {
          tenantId: req.tenantId,
          childTask: updatedTask,
          agentId: req.captureAgent.id,
          status: success ? 'dispatched' : 'needs_action',
          error: createError,
          actorType: 'capture_agent',
          actorId: req.captureAgent.id,
          actorName:
            req.captureAgent.display_name || req.captureAgent.client_label,
        });
      } else if (
        updatedTask?.parent_task_id &&
        command.command_type === 'stop' &&
        success
      ) {
        await projectOrchestrationChildControlOutcome(tx, {
          tenantId: req.tenantId,
          childTask: updatedTask,
          agentId: req.captureAgent.id,
          status: 'canceled',
          actorType: 'capture_agent',
          actorId: req.captureAgent.id,
          actorName:
            req.captureAgent.display_name || req.captureAgent.client_label,
        });
      }
      return {command: {...command, status: desiredCommandStatus}, taskUpdated: Boolean(updatedTask)};
    });

    if (commandResult.agentInactive) {
      return res.status(403).json({
        ok: false,
        error: 'agent_inactive',
        message: '采集节点已撤销或授权已变更，请重新验证扩展',
      });
    }
    if (commandResult.notFound) {
      return res.status(404).json({ ok: false, error: 'command_not_found', message: '远程指令不存在或已完成' });
    }
    if (commandResult.expired) {
      return res.status(409).json({ ok: false, error: 'command_expired', message: '远程指令已过期' });
    }
    if (commandResult.conflict) {
      return res.status(409).json({ ok: false, error: 'command_result_conflict', message: '远程指令已提交相反结果' });
    }
    if (commandResult.invalidCreateResult) {
      return res.status(409).json({
        ok: false,
        error: 'create_request_id_mismatch',
        message: '设备创建的本地任务 ID 与云端指令不一致',
        expectedRequestId: commandResult.expectedRequestId,
      });
    }
    if (commandResult.invalidStopResult) {
      const attemptMismatch = commandResult.attemptMismatch === true;
      return res.status(409).json({
        ok: false,
        error: attemptMismatch
          ? 'stop_attempt_id_mismatch'
          : 'stop_request_id_mismatch',
        message: attemptMismatch
          ? '设备停止回执的执行轮次与云端指令不一致'
          : '设备停止的本地任务 ID 与云端指令不一致',
        expectedRequestId: commandResult.expectedRequestId,
        expectedAttemptId: commandResult.expectedAttemptId,
      });
    }
    return res.json({
      ok: true,
      commandId: commandResult.command.id,
      idempotent: commandResult.idempotent === true,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/late-evidence-candidates', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Math.max(
      1,
      Math.min(
        100,
        Math.floor(Number.isFinite(requestedLimit) ? requestedLimit : 25),
      ),
    );
    const quietMinutes = Math.max(
      10,
      Math.min(
        24 * 60,
        Math.floor(Number(req.query.quietMinutes) || 15),
      ),
    );
    const rows = await queryAll(`
      SELECT
        item.id AS item_id,
        item.task_id,
        item.status AS item_status,
        item.platform,
        parent.metadata AS parent_metadata,
        source_attempt.id AS source_attempt_id,
        source_attempt.execution_task_id AS source_execution_task_id,
        source_attempt.attempt_number AS source_attempt_number,
        source_attempt.assignment_revision AS source_assignment_revision,
        source_attempt.status AS source_attempt_status,
        source_attempt.checkpoint AS source_attempt_checkpoint,
        source_attempt.result AS source_attempt_result,
        source_attempt.started_at AS source_attempt_started_at,
        observation_evidence.observation_count AS exact_observation_count,
        observation_evidence.latest_observation_at,
        successor_attempts.unstarted_count AS unstarted_successor_attempt_count,
        successor_attempts.started_count AS started_successor_attempt_count,
        active_attempts.count AS active_started_attempt_count,
        active_commands.count AS active_command_count,
        active_executions.count AS active_execution_count,
        active_recovery_leases.count AS active_recovery_lease_count,
        lineage_clock.last_activity_at AS lineage_last_activity_at,
        lineage_clock.last_activity_at <
          now() - make_interval(mins => $2::integer) AS lineage_silent
      FROM capture_task_items item
      JOIN capture_tasks parent
        ON parent.id = item.task_id AND parent.tenant_id = item.tenant_id
      JOIN LATERAL (
        SELECT attempt.*
        FROM capture_task_item_attempts attempt
        WHERE attempt.tenant_id = item.tenant_id
          AND attempt.item_id = item.id
          AND EXISTS (
            SELECT 1
            FROM record_observations observation
            WHERE observation.tenant_id = attempt.tenant_id
              AND observation.capture_task_item_attempt_id = attempt.id
          )
        ORDER BY attempt.attempt_number DESC, attempt.created_at DESC,
          attempt.id DESC
        LIMIT 1
      ) source_attempt ON true
      JOIN LATERAL (
        SELECT COUNT(*)::integer AS observation_count,
          MAX(observation.captured_at) AS latest_observation_at
        FROM record_observations observation
        WHERE observation.tenant_id = source_attempt.tenant_id
          AND observation.capture_task_item_attempt_id = source_attempt.id
      ) observation_evidence ON true
      LEFT JOIN capture_tasks source_execution
        ON source_execution.id = source_attempt.execution_task_id
        AND source_execution.tenant_id = source_attempt.tenant_id
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE later.started_at IS NULL)::integer
            AS unstarted_count,
          COUNT(*) FILTER (WHERE later.started_at IS NOT NULL)::integer
            AS started_count
        FROM capture_task_item_attempts later
        WHERE later.tenant_id = source_attempt.tenant_id
          AND later.item_id = source_attempt.item_id
          AND later.attempt_number > source_attempt.attempt_number
      ) successor_attempts
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::integer AS count
        FROM capture_task_item_attempts attempt
        WHERE attempt.tenant_id = item.tenant_id
          AND attempt.item_id = item.id
          AND attempt.started_at IS NOT NULL
          AND attempt.status IN (
            'assigned', 'dispatch_pending', 'dispatched',
            'waiting_device', 'running'
          )
      ) active_attempts
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::integer AS count
        FROM capture_agent_commands command
        WHERE command.tenant_id = item.tenant_id
          AND (
            command.task_id = item.task_id
            OR command.task_id IN (
              SELECT DISTINCT attempt.execution_task_id
              FROM capture_task_item_attempts attempt
              WHERE attempt.tenant_id = item.tenant_id
                AND attempt.item_id = item.id
                AND attempt.execution_task_id IS NOT NULL
            )
          )
          AND command.status IN ('pending', 'acknowledged')
      ) active_commands
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::integer AS count
        FROM capture_tasks execution
        WHERE execution.tenant_id = item.tenant_id
          AND execution.id = source_attempt.execution_task_id
          AND execution.status IN (
            'pending', 'waiting_device', 'claimed', 'running',
            'recovering', 'resume_requested'
          )
      ) active_executions
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::integer AS count
        FROM capture_recovery_intents intent
        WHERE intent.tenant_id = item.tenant_id
          AND intent.item_id = item.id
          AND intent.lease_token IS NOT NULL
          AND intent.lease_expires_at > clock_timestamp()
      ) active_recovery_leases
      CROSS JOIN LATERAL (
        SELECT GREATEST(
          source_attempt.updated_at,
          source_attempt.finished_at,
          source_execution.business_progress_at,
          source_execution.heartbeat_at,
          source_execution.source_updated_at,
          source_execution.updated_at
        ) AS last_activity_at
      ) lineage_clock
      WHERE item.tenant_id = $1
        AND item.platform = 'xiaohongshu'
        AND item.status IN ('failed', 'needs_action')
      ORDER BY observation_evidence.latest_observation_at DESC,
        item.updated_at DESC, item.id
      LIMIT $3
    `, [req.tenantId, quietMinutes, limit]);
    const candidates = rows.map(row => evaluateObservedCompletionCandidate(row));
    return res.json({
      ok: true,
      readOnly: true,
      automaticMutationEnabled: false,
      runtimeAbsenceSource: 'not_persisted',
      humanReportsAcceptedAsEvidence: false,
      quietMinutes,
      candidates,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/history', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;
    const queryText = text(req.query.q, 120);
    const platform = text(req.query.platform, 40).toLowerCase();
    const status = text(req.query.status, 80).toLowerCase();
    const from = text(req.query.from, 20);
    const to = text(req.query.to, 20);
    const daysInput = Number(req.query.days);
    const days = Number.isFinite(daysInput)
      ? Math.min(3650, Math.max(0, Math.floor(daysInput)))
      : 30;
    const allowedPlatforms = new Set([
      'xiaohongshu', 'douyin', 'weibo', 'mixed', 'unknown',
    ]);
    const allowedStatuses = new Set([
      'completed', 'completed_with_warnings', 'completed_with_failures',
      'failed', 'canceled', 'skipped', 'interrupted', 'needs_action',
    ]);
    const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
    if (platform && !allowedPlatforms.has(platform)) {
      return res.status(400).json({ok: false, error: 'invalid_platform', message: '历史平台筛选无效'});
    }
    if (status && !allowedStatuses.has(status)) {
      return res.status(400).json({ok: false, error: 'invalid_status', message: '历史状态筛选无效'});
    }
    if ((from && !datePattern.test(from)) || (to && !datePattern.test(to))) {
      return res.status(400).json({ok: false, error: 'invalid_date_range', message: '历史日期需使用 YYYY-MM-DD 格式'});
    }
    if (from && to && from > to) {
      return res.status(400).json({ok: false, error: 'invalid_date_range', message: '开始日期不能晚于结束日期'});
    }

    const params = [req.tenantId];
    const where = [`
      t.tenant_id = $1
      AND t.parent_task_id IS NULL
      AND ${captureTaskBusinessRootVisibilitySql('t')}
      AND t.task_type NOT IN ('unattended_plan_configuration', 'sync')
      AND RIGHT(t.task_type, 5) <> '_sync'
      AND t.status <> 'superseded'
      AND NOT (
        t.task_type = 'capture_orchestration'
        AND (
          (t.orchestration_revision = 0 AND t.metadata->>'draft' = 'true')
          OR t.metadata->>'orchestrationTemplate' = 'true'
        )
      )
      AND t.status NOT IN (
        'pending', 'waiting_device', 'claimed', 'running', 'recovering',
        'resume_requested'
      )
      AND NOT (
        t.status IN ('interrupted', 'needs_action', 'failed', 'completed_with_failures')
        AND t.attention_dismissed_at IS NULL
      )
    `];
    if (queryText) {
      params.push(`%${queryText}%`);
      where.push(`t.title ILIKE $${params.length}`);
    }
    if (platform) {
      params.push(platform);
      where.push(`t.platform = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`t.status = $${params.length}`);
    }
    if (from) {
      params.push(from);
      where.push(`COALESCE(t.finished_at, t.updated_at, t.created_at) >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    } else if (!to && days > 0) {
      params.push(days);
      where.push(`COALESCE(t.finished_at, t.updated_at, t.created_at) >= now() - ($${params.length}::integer * interval '1 day')`);
    }
    if (to) {
      params.push(to);
      where.push(`COALESCE(t.finished_at, t.updated_at, t.created_at) < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    }
    const whereSql = where.join('\n AND ');
    const listParams = [...params, pageSize, offset];
    const [totalRow, tasks] = await Promise.all([
      queryOne(`SELECT COUNT(*)::integer AS total FROM capture_tasks t WHERE ${whereSql}`, params),
      queryAll(`
        SELECT t.*,
          ca.display_name AS agent_display_name,
          ca.host_label AS agent_host_label,
          ca.browser_name AS agent_browser_name,
          ca.operating_system AS agent_operating_system,
          ca.allowed_platforms AS agent_allowed_platforms,
          ca.capabilities AS agent_capabilities,
          ca.last_heartbeat_at AS agent_last_heartbeat_at,
          (ca.status = 'active' AND ca.last_heartbeat_at >= now() - interval '2 minutes') AS agent_online,
          ca.status AS agent_status,
          t.status AS effective_status
        FROM capture_tasks t
        LEFT JOIN capture_agents ca
          ON ca.id = COALESCE(t.assigned_agent_id, t.origin_agent_id)
          AND ca.tenant_id = t.tenant_id
        WHERE ${whereSql}
        ORDER BY COALESCE(t.finished_at, t.updated_at, t.created_at) DESC, t.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `, listParams),
    ]);
    const total = Number(totalRow?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (page > totalPages) {
      return res.json({
        ok: true,
        tasks: [],
        pagination: {page, pageSize, total, totalPages},
        filters: {q: queryText, platform, status, from, to, days},
      });
    }
    return res.json({
      ok: true,
      tasks,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
      filters: {q: queryText, platform, status, from, to, days},
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/overview', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100));
    await withTransaction(async tx => expireStaleCommands(tx, req.tenantId));
    const [agents, tasks, taskSummary] = await Promise.all([
      queryAll(`
        WITH task_load AS (
          SELECT
            COALESCE(assigned.assigned_agent_id, assigned.origin_agent_id)
              AS agent_id,
            COUNT(*) FILTER (
              WHERE assigned.status IN (
                'claimed', 'running', 'recovering', 'resume_requested'
              )
            ) AS active_task_count,
            COUNT(*) FILTER (
              WHERE assigned.status IN ('pending', 'waiting_device')
            ) AS queued_task_count
          FROM capture_tasks assigned
          WHERE assigned.tenant_id = $1
            AND ${captureTaskBusinessRootVisibilitySql('assigned')}
            AND assigned.status = ANY($2::text[])
            AND assigned.task_type NOT IN (
              'capture_orchestration', 'unattended_plan_configuration', 'sync'
            )
            AND RIGHT(assigned.task_type, 5) <> '_sync'
            AND COALESCE(
              assigned.assigned_agent_id,
              assigned.origin_agent_id
            ) IS NOT NULL
          GROUP BY COALESCE(
            assigned.assigned_agent_id,
            assigned.origin_agent_id
          )
        )
        SELECT ca.id, ca.client_uuid, ca.client_label, ca.display_name,
          ca.host_label, ca.browser_name, ca.operating_system, ca.app_version,
          ca.allowed_platforms, ca.capabilities, ca.unattended_plan,
          ca.unattended_plan_updated_at, ca.status,
          ca.last_heartbeat_at, ca.last_error, ca.created_at, ca.updated_at,
          COALESCE(task_load.active_task_count, 0)::integer
            AS active_task_count,
          COALESCE(task_load.queued_task_count, 0)::integer
            AS queued_task_count,
          (
            ca.status = 'active'
            AND ca.last_heartbeat_at >= now() - interval '2 minutes'
          ) AS online
        FROM capture_agents ca
        LEFT JOIN task_load ON task_load.agent_id = ca.id
        WHERE ca.tenant_id = $1
          AND ca.status IN ('active', 'paused')
        ORDER BY ca.host_label, ca.display_name, ca.created_at
      `, [req.tenantId, CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES]),
      queryAll(`
        SELECT t.*,
          ca.display_name AS agent_display_name,
          ca.host_label AS agent_host_label,
          ca.browser_name AS agent_browser_name,
          ca.operating_system AS agent_operating_system,
          ca.allowed_platforms AS agent_allowed_platforms,
          ca.capabilities AS agent_capabilities,
          ca.last_heartbeat_at AS agent_last_heartbeat_at,
          (
            ca.status = 'active'
            AND ca.last_heartbeat_at >= now() - interval '2 minutes'
          ) AS agent_online,
          ca.status AS agent_status,
          CASE
            WHEN ca.id IS NULL THEN '原执行节点不存在'
            WHEN tenant.status <> 'active' THEN '当前租户已暂停'
            WHEN ca.status = 'migrated' THEN '原执行节点已移出当前租户'
            WHEN ca.status <> 'active' THEN '原执行节点已暂停或撤销'
            WHEN ac.id IS NULL OR ac.status <> 'active'
              OR (ac.expires_at IS NOT NULL AND ac.expires_at < now())
              THEN '节点授权已失效，请重新验证激活码'
            WHEN ab.id IS NULL THEN '节点环境绑定已失效，请重新验证激活码'
            WHEN cardinality(ca.allowed_platforms) > 0
              AND NOT (t.platform = ANY(ca.allowed_platforms))
              THEN '原执行节点未配置负责该平台'
            ELSE ''
          END AS resume_block_reason,
          command.id AS pending_command_id,
          command.command_type AS pending_command_type,
          command.status AS pending_command_status,
          command.created_at AS pending_command_created_at,
          command.expires_at AS pending_command_expires_at
        FROM capture_tasks t
        LEFT JOIN capture_agents ca
          ON ca.id = COALESCE(t.assigned_agent_id, t.origin_agent_id)
          AND ca.tenant_id = t.tenant_id
        LEFT JOIN tenants tenant ON tenant.id = t.tenant_id
        LEFT JOIN auth_codes ac
          ON ac.id = ca.auth_code_id AND ac.tenant_id = t.tenant_id
        LEFT JOIN auth_bindings ab
          ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
        LEFT JOIN LATERAL (
          SELECT c.id, c.command_type, c.status, c.created_at, c.expires_at
          FROM capture_agent_commands c
          WHERE c.task_id = t.id
            AND c.tenant_id = t.tenant_id
            AND c.status IN ('pending', 'acknowledged')
            AND c.expires_at > now()
          ORDER BY CASE c.command_type
            WHEN 'stop' THEN 0
            WHEN 'resume' THEN 1
            ELSE 2
          END, c.created_at DESC
          LIMIT 1
        ) command ON true
        WHERE t.tenant_id = $1
          AND t.parent_task_id IS NULL
          AND ${captureTaskBusinessRootVisibilitySql('t')}
          AND NOT (
            t.task_type = 'capture_orchestration'
            AND t.orchestration_revision = 0
            AND t.metadata->>'draft' = 'true'
          )
        ORDER BY
          CASE WHEN t.status IN ('running', 'recovering', 'resume_requested', 'needs_action', 'interrupted') THEN 0 ELSE 1 END,
          t.updated_at DESC
        LIMIT $2
      `, [req.tenantId, limit]),
      queryOne(`
        SELECT
          COUNT(*) FILTER (
            WHERE t.status IN ('running', 'recovering')
              AND (
                t.task_type = 'capture_orchestration'
                OR (
                  ca.status = 'active'
                  AND ca.last_heartbeat_at >= now() - interval '2 minutes'
                )
              )
          ) AS running_tasks,
          COUNT(*) FILTER (
            WHERE t.status IN ('interrupted', 'needs_action', 'failed', 'completed_with_failures')
              AND t.attention_dismissed_at IS NULL
          ) AS attention_tasks,
          COUNT(*) FILTER (
            WHERE t.status NOT IN (
              'pending', 'waiting_device', 'claimed', 'running', 'recovering',
              'resume_requested', 'superseded'
            )
              AND NOT (
                t.status IN ('interrupted', 'needs_action', 'failed', 'completed_with_failures')
                AND t.attention_dismissed_at IS NULL
              )
              AND t.task_type NOT IN ('unattended_plan_configuration', 'sync')
              AND RIGHT(t.task_type, 5) <> '_sync'
              AND NOT (
                t.task_type = 'capture_orchestration'
                AND t.metadata->>'orchestrationTemplate' = 'true'
              )
              AND COALESCE(t.finished_at, t.updated_at, t.created_at) >= now() - interval '30 days'
          ) AS history_tasks
        FROM capture_tasks t
        LEFT JOIN capture_agents ca
          ON ca.id = COALESCE(t.assigned_agent_id, t.origin_agent_id)
          AND ca.tenant_id = t.tenant_id
        WHERE t.tenant_id = $1
          AND t.parent_task_id IS NULL
          AND ${captureTaskBusinessRootVisibilitySql('t')}
          AND NOT (
            t.task_type = 'capture_orchestration'
            AND t.orchestration_revision = 0
            AND t.metadata->>'draft' = 'true'
          )
      `, [req.tenantId]),
    ]);

    const aiAdmission = getTenantAiAdmissionSnapshot(req.tenantId);
    return res.json({
      ok: true,
      agents,
      tasks: tasks.map(task => ({
        ...task,
        effective_status:
          task.task_type !== 'capture_orchestration' &&
          isCloudTaskActive(task.status) && !task.agent_online && task.status !== 'needs_action'
            ? 'waiting_device'
            : task.status,
      })),
      summary: {
        agents: agents.length,
        onlineAgents: agents.filter(agent => agent.status === 'active' && captureAgentOnline(agent.last_heartbeat_at)).length,
        runningTasks: Number(taskSummary?.running_tasks || 0),
        attentionTasks: Number(taskSummary?.attention_tasks || 0),
        historyTasks: Number(taskSummary?.history_tasks || 0),
        aiActive: aiAdmission.active,
        aiQueued: aiAdmission.queued,
        aiConcurrencyLimit: aiAdmission.limit,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/agents/:id', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    if (req.body?.status === 'revoked') {
      return res.status(400).json({
        ok: false,
        error: 'agent_delete_endpoint_required',
        message: '请使用“删除节点”操作撤销该节点',
      });
    }
    const displayName = text(req.body?.displayName, 120);
    const hostLabel = text(req.body?.hostLabel, 120);
    const allowedPlatforms = normalizeCaptureAgentPlatforms(req.body?.allowedPlatforms);
    const status = ['active', 'paused'].includes(req.body?.status)
      ? req.body.status
      : null;
    if (!displayName || !hostLabel) {
      return res.status(400).json({ ok: false, error: 'invalid_agent_label', message: '设备名称和节点名称不能为空' });
    }
    const result = await withTransaction(async tx => {
      const current = await tx.queryOne(`
        SELECT id, status FROM capture_agents
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [req.params.id, req.tenantId]);
      if (!current) return {notFound: true};
      if (current.status === 'revoked' && status && status !== 'revoked') {
        return {revokedLocked: true};
      }
      if (current.status === 'migrated' && status && status !== 'migrated') {
        return {migratedLocked: true};
      }
      const agent = await tx.queryOne(`
        UPDATE capture_agents
        SET display_name = $1,
          host_label = $2,
          allowed_platforms = $3::text[],
          status = COALESCE($4, status),
          updated_at = now()
        WHERE id = $5 AND tenant_id = $6
        RETURNING id, display_name, host_label, allowed_platforms, status
      `, [displayName, hostLabel, allowedPlatforms, status, req.params.id, req.tenantId]);
      if (agent.status === 'revoked') {
        await tx.execute(`
          UPDATE capture_agent_tokens
          SET revoked_at = COALESCE(revoked_at, now())
          WHERE agent_id = $1
        `, [agent.id]);
      }
      if (agent.status !== 'active') {
        await expireStaleCommands(tx, req.tenantId, null, agent.id);
      }
      return {agent};
    });
    if (result.notFound) return res.status(404).json({ ok: false, error: 'agent_not_found', message: '采集节点不存在' });
    if (result.revokedLocked) {
      return res.status(409).json({ ok: false, error: 'agent_revoked', message: '已撤销节点不能重新激活，请重新注册浏览器节点' });
    }
    if (result.migratedLocked) {
      return res.status(409).json({
        ok: false,
        error: 'agent_migrated',
        message: '已移出节点不能在管理端直接恢复；请在该浏览器重新验证本租户激活码',
      });
    }
    return res.json({ ok: true, agent: result.agent });
  } catch (err) {
    return next(err);
  }
});

router.delete('/agents/:id', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const agentId = text(req.params.id, 100).toLowerCase();
    if (!UUID_PATTERN.test(agentId)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_agent_id',
        message: '采集节点标识无效',
      });
    }

    const result = await withTransaction(async tx => {
      // Heartbeat and node removal share one execution-slot lock. Once this
      // transaction commits, every previously issued token is invalid and a
      // later heartbeat cannot silently revive the revoked client UUID.
      await lockCaptureAgentExecutionSlot(tx, req.tenantId, agentId);

      const agent = await tx.queryOne(`
        SELECT id, display_name, status, last_heartbeat_at, unattended_plan
        FROM capture_agents
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [agentId, req.tenantId]);
      if (!agent) return {notFound: true};
      if (agent.status === 'revoked') {
        return {agent, alreadyRevoked: true};
      }

      // Read-only blockers are deliberately checked after the Agent row lock.
      // Do not lock task rows here: orchestration dispatch locks parent/items
      // before Agents, and reversing that order would create a deadlock risk.
      const taskLoad = await tx.queryOne(`
        SELECT COUNT(*)::integer AS count
        FROM capture_tasks t
        WHERE t.tenant_id = $1
          AND COALESCE(t.assigned_agent_id, t.origin_agent_id) = $2
          AND t.status = ANY($3::text[])
          AND ${captureTaskBusinessRootVisibilitySql('t')}
      `, [req.tenantId, agentId, AGENT_REMOVAL_TASK_STATUSES]);
      const workItemLoad = await tx.queryOne(`
        SELECT COUNT(*)::integer AS count
        FROM capture_task_items item
        JOIN capture_tasks parent
          ON parent.id = item.task_id
          AND parent.tenant_id = item.tenant_id
        WHERE item.tenant_id = $1 AND item.assigned_agent_id = $2
          AND item.status IN (
            'pending', 'assigned', 'dispatch_pending', 'dispatched',
            'waiting_device', 'running', 'retryable', 'needs_action'
          )
          AND parent.status = ANY($3::text[])
      `, [req.tenantId, agentId, AGENT_REMOVAL_TASK_STATUSES]);
      const pendingCommands = await tx.queryOne(`
        SELECT COUNT(*)::integer AS count
        FROM capture_agent_commands
        WHERE tenant_id = $1 AND agent_id = $2
          AND status IN ('pending', 'acknowledged')
          AND expires_at > now()
      `, [req.tenantId, agentId]);
      const cloudSchedules = await tx.queryOne(`
        SELECT COUNT(DISTINCT schedule.id)::integer AS count
        FROM capture_orchestration_schedule_agents assignment
        JOIN capture_orchestration_schedules schedule
          ON schedule.id = assignment.schedule_id
          AND schedule.tenant_id = assignment.tenant_id
        WHERE assignment.tenant_id = $1
          AND assignment.agent_id = $2
          AND schedule.status IN ('active', 'paused')
      `, [req.tenantId, agentId]);

      const blockers = {
        online: captureAgentOnline(agent.last_heartbeat_at),
        activeTasks: Number(taskLoad?.count || 0),
        activeWorkItems: Number(workItemLoad?.count || 0),
        pendingCommands: Number(pendingCommands?.count || 0),
        localPlan: hasConfiguredAgentPlan(agent.unattended_plan),
        cloudSchedules: Number(cloudSchedules?.count || 0),
      };
      const blockerMessage = captureAgentRemovalBlockerMessage(blockers);
      if (blockerMessage) return {agent, blockers, blockerMessage};

      await tx.execute(`
        UPDATE capture_agent_tokens
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE agent_id = $1
      `, [agentId]);
      await tx.execute(`
        UPDATE capture_agent_commands
        SET status = 'expired',
          result = jsonb_build_object('reason', 'agent_revoked'),
          finished_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND agent_id = $2
          AND status IN ('pending', 'acknowledged')
      `, [req.tenantId, agentId]);
      await tx.execute(`
        UPDATE social_account_bindings
        SET status = 'historical',
          ended_at = COALESCE(ended_at, now()),
          metadata = metadata || jsonb_build_object(
            'nodeRevoked', true,
            'nodeRevokedAt', now(),
            'nodeRevokedByUserId', $3::text
          ),
          updated_at = now()
        WHERE tenant_id = $1 AND agent_id = $2 AND status = 'current'
      `, [req.tenantId, agentId, req.user?.id || '']);
      await tx.execute(`
        UPDATE social_accounts
        SET last_agent_id = NULL, updated_at = now()
        WHERE tenant_id = $1 AND last_agent_id = $2
      `, [req.tenantId, agentId]);
      const revoked = await tx.queryOne(`
        UPDATE capture_agents
        SET status = 'revoked', updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, display_name, status, updated_at
      `, [agentId, req.tenantId]);
      await tx.execute(`
        INSERT INTO audit_logs (
          tenant_id, actor_type, actor_id, actor_user_id,
          action, target_type, target_id, metadata
        ) VALUES (
          $1, 'user', $2, $3, 'capture_agent.revoked',
          'capture_agent', $4, $5::jsonb
        )
      `, [
        req.tenantId,
        String(req.user?.id || ''),
        req.user?.id || null,
        agentId,
        JSON.stringify({
          displayName: agent.display_name || '',
          actorName: text(req.actorName, 240),
          historyPreserved: true,
          authBindingPreserved: true,
        }),
      ]);
      return {agent: revoked};
    });

    if (result.notFound) {
      return res.status(404).json({
        ok: false,
        error: 'agent_not_found',
        message: '采集节点不存在',
      });
    }
    if (result.blockerMessage) {
      return res.status(409).json({
        ok: false,
        error: 'agent_delete_blocked',
        message: result.blockerMessage,
        blockers: result.blockers,
      });
    }
    return res.json({
      ok: true,
      alreadyRevoked: result.alreadyRevoked === true,
      agent: result.agent,
      message: result.alreadyRevoked
        ? '该节点已删除'
        : `节点“${result.agent?.display_name || '未命名节点'}”已删除；历史任务和采集结果已保留。`,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/agents/:id/retire', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const agentId = text(req.params.id, 100).toLowerCase();
    if (!UUID_PATTERN.test(agentId)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_agent_id',
        message: '采集节点标识无效',
      });
    }
    const retirementReason = text(req.body?.reason, 80);
    if (!['tenant_migrated', 'permanently_offline'].includes(retirementReason)) {
      return res.status(400).json({
        ok: false,
        error: 'agent_retirement_reason_required',
        message: '请选择节点已换租户或设备永久停用',
      });
    }
    const movedToAnotherTenant = retirementReason === 'tenant_migrated';
    const requiredConfirmation = movedToAnotherTenant ? '移出当前租户' : '永久停用';
    if (text(req.body?.confirmation, 30) !== requiredConfirmation) {
      return res.status(400).json({
        ok: false,
        error: movedToAnotherTenant
          ? 'agent_migration_confirmation_required'
          : 'agent_retirement_confirmation_required',
        message: `请输入“${requiredConfirmation}”确认该操作`,
      });
    }
    const terminalAgentStatus = movedToAnotherTenant ? 'migrated' : 'revoked';
    const lifecycleCode = movedToAnotherTenant ? 'agent_migrated' : 'agent_retired';
    const lifecycleAction = movedToAnotherTenant
      ? 'capture_agent.migrated'
      : 'capture_agent.retired';
    const lifecycleEventType = movedToAnotherTenant
      ? 'capture_agent_migrated'
      : 'capture_agent_retired';
    const lifecycleProjectionEventType = movedToAnotherTenant
      ? 'capture_agent_migration_projected'
      : 'capture_agent_retirement_projected';
    const lifecycleMetadataKey = movedToAnotherTenant
      ? 'agentMigration'
      : 'agentRetirement';
    const lastLifecycleMetadataKey = movedToAnotherTenant
      ? 'lastAgentMigration'
      : 'lastAgentRetirement';
    const lifecycleLabel = movedToAnotherTenant ? '已移出当前租户' : '已永久停用';

    const result = await withTransaction(async tx => {
      // The same advisory lock fences late heartbeats, credential refreshes and
      // task-control writes for this exact tenant-scoped Agent. We never search
      // another tenant by client_uuid, so an identically named browser profile
      // in its new tenant cannot be changed by this operation.
      await lockCaptureAgentExecutionSlot(tx, req.tenantId, agentId);
      const agent = await tx.queryOne(`
        SELECT id, display_name, status, last_heartbeat_at, unattended_plan
        FROM capture_agents
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [agentId, req.tenantId]);
      if (!agent) return {notFound: true};
      if (agent.status === 'revoked') {
        return {agent, alreadyRetired: true};
      }
      if (agent.status === 'migrated' && movedToAnotherTenant) {
        return {agent, alreadyMigrated: true};
      }
      if (captureAgentOnline(agent.last_heartbeat_at)) {
        return {agent, online: true};
      }

      const actorId = String(req.user?.id || '');
      const actorName = text(req.actorName, 240);
      const retirementMetadata = {
        code: lifecycleCode,
        reason: retirementReason,
        changedAt: new Date().toISOString(),
        changedByUserId: actorId,
        previousStatus: agent.status,
        nextStatus: terminalAgentStatus,
        ...(movedToAnotherTenant
          ? {
              migratedAt: new Date().toISOString(),
              migratedByUserId: actorId,
            }
          : {
              retiredAt: new Date().toISOString(),
              retiredByUserId: actorId,
            }),
      };
      const planSnapshot = safeJson(agent.unattended_plan);

      // Stop cloud schedules that still reference the old Agent. Keeping the
      // schedule and assignment rows preserves their historical allocation;
      // canceled schedules can no longer materialize a new occurrence.
      const retiredSchedules = await tx.queryAll(`
        UPDATE capture_orchestration_schedules schedule
        SET status = 'canceled',
          next_run_at = NULL,
          last_run_status = $4,
          last_error = jsonb_build_object(
            'code', $4::text,
            'message', $5::text,
            'agentId', $2::text,
            'reason', $3::text
          ),
          updated_at = now()
        FROM capture_orchestration_schedule_agents assignment
        WHERE schedule.id = assignment.schedule_id
          AND schedule.tenant_id = assignment.tenant_id
          AND assignment.tenant_id = $1
          AND assignment.agent_id = $2
          AND schedule.status IN ('active', 'paused')
        RETURNING schedule.id, schedule.template_task_id
      `, [
        req.tenantId,
        agentId,
        retirementReason,
        lifecycleCode,
        movedToAnotherTenant
          ? '计划中的执行节点已移出当前租户'
          : '计划中的执行节点已永久停用',
      ]);
      const retiredTemplateTaskIds = retiredSchedules
        .map(schedule => String(schedule.template_task_id || ''))
        .filter(Boolean);

      const activeItemParents = await tx.queryAll(`
        SELECT DISTINCT task_id
        FROM capture_task_items
        WHERE tenant_id = $1 AND assigned_agent_id = $2
          AND status IN (
            'pending', 'assigned', 'dispatch_pending', 'dispatched',
            'waiting_device', 'running', 'retryable', 'needs_action'
          )
      `, [req.tenantId, agentId]);

      const retiredTaskAttempts = await tx.execute(`
        UPDATE capture_task_attempts
        SET status = 'canceled',
          error = error || $3::jsonb,
          finished_at = COALESCE(finished_at, now()),
          updated_at = now()
        WHERE tenant_id = $1 AND agent_id = $2
          AND status IN ('claimed', 'running', 'recovering', 'interrupted')
      `, [req.tenantId, agentId, JSON.stringify(retirementMetadata)]);
      const retiredItemAttempts = await tx.execute(`
        UPDATE capture_task_item_attempts
        SET status = 'canceled',
          error = error || $3::jsonb,
          finished_at = COALESCE(finished_at, now()),
          updated_at = now()
        WHERE tenant_id = $1 AND agent_id = $2
          AND status IN (
            'assigned', 'dispatch_pending', 'dispatched', 'waiting_device',
            'running', 'interrupted', 'retryable', 'needs_action'
          )
      `, [req.tenantId, agentId, JSON.stringify(retirementMetadata)]);
      const retiredItems = await tx.execute(`
        UPDATE capture_task_items
        SET status = 'canceled',
          error = error || $3::jsonb,
          metadata = metadata || jsonb_build_object(
            $4::text, $3::jsonb
          ),
          finished_at = COALESCE(finished_at, now()),
          updated_at = now()
        WHERE tenant_id = $1 AND assigned_agent_id = $2
          AND status IN (
            'pending', 'assigned', 'dispatch_pending', 'dispatched',
            'waiting_device', 'running', 'retryable', 'needs_action'
          )
      `, [
        req.tenantId,
        agentId,
        JSON.stringify(retirementMetadata),
        lifecycleMetadataKey,
      ]);

      const retiredTasks = await tx.queryAll(`
        UPDATE capture_tasks
        SET status = 'canceled',
          message = $6,
          error = error || $4::jsonb,
          metadata = metadata || jsonb_build_object(
            $5::text, $4::jsonb
          ),
          finished_at = COALESCE(finished_at, now()),
          updated_at = now(),
          source_updated_at = now()
        WHERE tenant_id = $1
          AND COALESCE(assigned_agent_id, origin_agent_id) = $2
          AND status = ANY($3::text[])
        RETURNING id, parent_task_id, task_type
      `, [
        req.tenantId,
        agentId,
        AGENT_REMOVAL_TASK_STATUSES,
        JSON.stringify(retirementMetadata),
        lifecycleMetadataKey,
        movedToAnotherTenant
          ? '原执行节点已移出当前租户，任务已终结；历史采集结果已保留'
          : '原执行节点已永久停用，任务已终结；历史采集结果已保留',
      ]);

      let retiredTemplateTasks = [];
      if (retiredTemplateTaskIds.length > 0) {
        retiredTemplateTasks = await tx.queryAll(`
          UPDATE capture_tasks
          SET status = 'canceled',
            message = $6,
            error = error || $3::jsonb,
            metadata = metadata || jsonb_build_object(
              $5::text, $3::jsonb
            ),
            finished_at = COALESCE(finished_at, now()),
            updated_at = now(),
            source_updated_at = now()
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])
            AND status = ANY($4::text[])
          RETURNING id, parent_task_id, task_type
        `, [
          req.tenantId,
          retiredTemplateTaskIds,
          JSON.stringify(retirementMetadata),
          AGENT_REMOVAL_TASK_STATUSES,
          lifecycleMetadataKey,
          movedToAnotherTenant
            ? '计划中的执行节点已移出当前租户，云端计划已停止'
            : '计划中的执行节点已永久停用，云端计划已停止',
        ]);
      }

      const retiredTaskMap = new Map(
        [...retiredTasks, ...retiredTemplateTasks]
          .map(task => [String(task.id), task]),
      );
      for (const task of retiredTaskMap.values()) {
        await tx.execute(`
          INSERT INTO capture_task_events (
            tenant_id, task_id, agent_id, event_type,
            actor_type, actor_id, actor_name, status, message, payload
          ) VALUES (
            $1, $2, $3, $4,
            'user', $5, $6, 'canceled',
            $7,
            $8::jsonb
          )
        `, [
          req.tenantId,
          task.id,
          agentId,
          lifecycleEventType,
          actorId,
          actorName,
          movedToAnotherTenant
            ? '执行节点已移出当前租户，任务控制状态已终结'
            : '执行节点已永久停用，任务控制状态已终结',
          JSON.stringify({
            previousAgentId: agentId,
            reason: retirementReason,
            historyPreserved: true,
          }),
        ]);
      }

      // Re-project orchestration parents whose assigned work items were
      // canceled. Schedule templates were explicitly canceled above and must
      // not be reopened by this aggregate projection.
      const templateTaskIdSet = new Set(retiredTemplateTaskIds);
      const parentIds = new Set(
        activeItemParents
          .map(row => String(row.task_id || ''))
          .filter(id => id && !templateTaskIdSet.has(id)),
      );
      for (const task of retiredTasks) {
        const parentId = String(task.parent_task_id || '');
        if (parentId && !templateTaskIdSet.has(parentId)) parentIds.add(parentId);
      }
      for (const parentId of parentIds) {
        const parent = await tx.queryOne(`
          SELECT id
          FROM capture_tasks
          WHERE id = $1 AND tenant_id = $2
            AND task_type = 'capture_orchestration'
          FOR UPDATE
        `, [parentId, req.tenantId]);
        if (!parent) continue;
        const items = await tx.queryAll(`
          SELECT status
          FROM capture_task_items
          WHERE task_id = $1 AND tenant_id = $2
          ORDER BY ordinal, id
        `, [parentId, req.tenantId]);
        const aggregate = aggregateParentTaskItems(items);
        const parentMessage = aggregate.terminal
          ? `执行节点${lifecycleLabel}后，多 Agent 任务已结算`
          : `部分工作项因执行节点${lifecycleLabel}而停止，其余工作项继续执行`;
        await tx.execute(`
          UPDATE capture_tasks
          SET status = $1,
            progress = $2::jsonb,
            counts = $3::jsonb,
            message = $4,
            metadata = metadata || jsonb_build_object(
              $5::text, $6::jsonb
            ),
            finished_at = CASE
              WHEN $7::boolean THEN COALESCE(finished_at, now())
              ELSE NULL
            END,
            updated_at = now(),
            source_updated_at = now()
          WHERE id = $8 AND tenant_id = $9
        `, [
          aggregate.status,
          JSON.stringify(aggregate.progress),
          JSON.stringify(aggregate.counts),
          parentMessage,
          lastLifecycleMetadataKey,
          JSON.stringify(retirementMetadata),
          aggregate.terminal,
          parentId,
          req.tenantId,
        ]);
        await tx.execute(`
          INSERT INTO capture_task_events (
            tenant_id, task_id, agent_id, event_type,
            actor_type, actor_id, actor_name, status, message, payload
          ) VALUES (
            $1, $2, $3, $4,
            'user', $5, $6, $7, $8, $9::jsonb
          )
        `, [
          req.tenantId,
          parentId,
          agentId,
          lifecycleProjectionEventType,
          actorId,
          actorName,
          aggregate.status,
          parentMessage,
          JSON.stringify({reason: retirementReason, counts: aggregate.counts}),
        ]);
      }

      const expiredCommands = await tx.execute(`
        UPDATE capture_agent_commands
        SET status = 'expired',
          result = result || jsonb_build_object(
            'reason', $4::text,
            'retirementReason', $3::text
          ),
          finished_at = COALESCE(finished_at, now()),
          updated_at = now()
        WHERE tenant_id = $1 AND agent_id = $2
          AND status IN ('pending', 'acknowledged')
      `, [req.tenantId, agentId, retirementReason, lifecycleCode]);
      const revokedTokens = await tx.execute(`
        UPDATE capture_agent_tokens
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE agent_id = $1
      `, [agentId]);
      const socialBindingLifecycleMetadata = movedToAnotherTenant
        ? {
            nodeMigrated: true,
            nodeMigratedAt: retirementMetadata.migratedAt,
            nodeMigratedReason: retirementReason,
            nodeMigratedByUserId: actorId,
          }
        : {
            nodeRetired: true,
            nodeRetiredAt: retirementMetadata.retiredAt,
            nodeRetiredReason: retirementReason,
            nodeRetiredByUserId: actorId,
          };
      const historicalBindings = await tx.execute(`
        UPDATE social_account_bindings
        SET status = 'historical',
          ended_at = COALESCE(ended_at, now()),
          metadata = metadata || $3::jsonb,
          updated_at = now()
        WHERE tenant_id = $1 AND agent_id = $2 AND status = 'current'
      `, [
        req.tenantId,
        agentId,
        JSON.stringify(socialBindingLifecycleMetadata),
      ]);
      await tx.execute(`
        UPDATE social_accounts
        SET last_agent_id = NULL, updated_at = now()
        WHERE tenant_id = $1 AND last_agent_id = $2
      `, [req.tenantId, agentId]);

      const retired = await tx.queryOne(`
        UPDATE capture_agents
        SET status = $3,
          unattended_plan = '{}'::jsonb,
          unattended_plan_updated_at = now(),
          last_error = '',
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, display_name, status, updated_at
      `, [agentId, req.tenantId, terminalAgentStatus]);
      await tx.execute(`
        INSERT INTO audit_logs (
          tenant_id, actor_type, actor_id, actor_user_id,
          action, target_type, target_id, metadata
        ) VALUES (
          $1, 'user', $2, $3, $4,
          'capture_agent', $5, $6::jsonb
        )
      `, [
        req.tenantId,
        actorId,
        req.user?.id || null,
        lifecycleAction,
        agentId,
        JSON.stringify({
          displayName: agent.display_name || '',
          actorName,
          reason: retirementReason,
          previousLastHeartbeatAt: agent.last_heartbeat_at || null,
          unattendedPlanSnapshot: planSnapshot,
          unattendedPlanMirrorCleared: true,
          revokedTokenCount: Number(revokedTokens.changes || 0),
          expiredCommandCount: Number(expiredCommands.changes || 0),
          retiredTaskCount: retiredTaskMap.size,
          retiredTaskAttemptCount: Number(retiredTaskAttempts.changes || 0),
          retiredItemCount: Number(retiredItems.changes || 0),
          retiredItemAttemptCount: Number(retiredItemAttempts.changes || 0),
          canceledScheduleIds: retiredSchedules.map(schedule => schedule.id),
          historicalSocialBindingCount: Number(historicalBindings.changes || 0),
          historyPreserved: true,
          authBindingPreserved: true,
          reversible: movedToAnotherTenant,
        }),
      ]);
      return {
        agent: retired,
        expiredCommandCount: Number(expiredCommands.changes || 0),
        retiredTaskCount: retiredTaskMap.size,
        canceledScheduleCount: retiredSchedules.length,
        historicalSocialBindingCount: Number(historicalBindings.changes || 0),
      };
    });

    if (result.notFound) {
      return res.status(404).json({
        ok: false,
        error: 'agent_not_found',
        message: '采集节点不存在',
      });
    }
    if (result.online) {
      return res.status(409).json({
        ok: false,
        error: 'agent_retirement_online',
        message: movedToAnotherTenant
          ? '节点仍在线，请先在 Extension 切换到其他租户，并等待约 2 分钟后再移出。'
          : '节点仍在线，不能永久停用。请先关闭 Extension，并等待约 2 分钟。',
      });
    }
    return res.json({
      ok: true,
      alreadyRetired: result.alreadyRetired === true,
      alreadyMigrated: result.alreadyMigrated === true,
      agent: result.agent,
      summary: {
        expiredCommands: result.expiredCommandCount || 0,
        retiredTasks: result.retiredTaskCount || 0,
        canceledSchedules: result.canceledScheduleCount || 0,
        historicalSocialBindings: result.historicalSocialBindingCount || 0,
      },
      message: result.alreadyRetired
        ? '该节点已永久停用'
        : result.alreadyMigrated
          ? '该节点已移出当前租户'
          : movedToAnotherTenant
            ? `节点“${result.agent?.display_name || '未命名节点'}”已移出当前租户；客户列表和新建任务不再显示，以后重新验证本租户激活码会自动恢复。`
            : `节点“${result.agent?.display_name || '未命名节点'}”已永久停用；历史任务、采集结果和审计记录均已保留。`,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/agents/:id/tasks', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const result = await withTransaction(async tx => {
      const agent = await tx.queryOne(`
        SELECT ca.*, tenant.status AS tenant_status,
          ac.status AS auth_code_status,
          ac.expires_at AS auth_code_expires_at,
          ab.id AS active_auth_binding_id
        FROM capture_agents ca
        JOIN tenants tenant ON tenant.id = ca.tenant_id
        LEFT JOIN auth_codes ac
          ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
        LEFT JOIN auth_bindings ab
          ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
        WHERE ca.id = $1 AND ca.tenant_id = $2
        FOR UPDATE OF ca
      `, [req.params.id, req.tenantId]);
      if (!agent) return {error: 'agent_not_found'};

      const authCodeExpired = agent.auth_code_expires_at &&
        new Date(agent.auth_code_expires_at) < new Date();
      if (
        agent.tenant_status !== 'active' ||
        agent.status !== 'active' ||
        agent.auth_code_status !== 'active' ||
        !agent.active_auth_binding_id ||
        authCodeExpired
      ) {
        return {error: 'agent_unavailable'};
      }
      const capabilities = safeJson(agent.capabilities);
      if (capabilities.remoteTaskCreate !== true) {
        return {error: 'agent_capability_missing'};
      }

      const mirroredPlan = safeJson(agent.unattended_plan);
      const body = safeJson(req.body);
      const hasKeywordMaxDetectedItems = Object.prototype.hasOwnProperty.call(
        body,
        'keywordMaxDetectedItems',
      );
      const rawKeywordMaxDetectedItems = Number(body.keywordMaxDetectedItems);
      if (
        hasKeywordMaxDetectedItems &&
        (
          !Number.isSafeInteger(rawKeywordMaxDetectedItems) ||
          rawKeywordMaxDetectedItems <= 0
        )
      ) {
        return {error: 'invalid_keyword_max_detected_items'};
      }
      if (
        hasKeywordMaxDetectedItems &&
        capabilities.remoteTaskKeywordPostLimit !== true
      ) {
        return {error: 'agent_keyword_limit_capability_missing'};
      }
      if (
        Object.keys(safeJson(body.captureSettings)).length > 0 &&
        capabilities.remoteTaskEnhancementOptions !== true
      ) {
        return {error: 'agent_enhancement_capability_missing'};
      }
      const bodyFilters = safeJson(body.searchFilters);
      const mirroredFilters = safeJson(mirroredPlan.searchFilters);
      const explicitInput = normalizeRemoteTaskInput({
        title: body.title,
        clientTaskId: body.clientTaskId || body.requestKey,
        executionMode: body.executionMode,
        planSnapshot: {
          ...body,
          enabled: true,
          searchFilters: {
            ...bodyFilters,
            ...(body.sort == null ? {} : {sort: body.sort}),
            ...(body.publishTime == null ? {} : {publishTime: body.publishTime}),
          },
        },
      });
      const normalizedInput = normalizeRemoteTaskInput({
        title: body.title,
        clientTaskId: body.clientTaskId || body.requestKey,
        executionMode: body.executionMode,
        planSnapshot: {
          ...mirroredPlan,
          ...body,
          enabled: true,
          searchFilters: {
            ...mirroredFilters,
            ...bodyFilters,
            ...(body.sort == null ? {} : {sort: body.sort}),
            ...(body.publishTime == null ? {} : {publishTime: body.publishTime}),
          },
        },
      });
      const executionMode = normalizedInput.executionMode;
      if (
        executionMode === 'unattended_plan' &&
        capabilities.remoteUnattendedPlanWrite !== true
      ) {
        return {error: 'agent_plan_capability_missing'};
      }
      const planSnapshot = normalizedInput.planSnapshot;
      // This limit is an explicit per-task override. Legacy callers that omit
      // it must continue using the device's current capture preference instead
      // of inheriting a possibly stale mirrored unattended-plan value.
      if (!hasKeywordMaxDetectedItems) {
        delete planSnapshot.keywordMaxDetectedItems;
      }
      if (!['xiaohongshu', 'douyin'].includes(planSnapshot.platform)) {
        return {error: 'unsupported_platform'};
      }
      if (planSnapshot.keywords.length === 0) {
        return {error: 'keywords_required'};
      }
      if (
        executionMode === 'unattended_plan' &&
        planSnapshot.mode === 'custom_dates' &&
        !planSnapshot.customDates
      ) {
        return {error: 'custom_dates_required'};
      }

      const allowedPlatforms = Array.isArray(agent.allowed_platforms)
        ? agent.allowed_platforms
        : [];
      if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(planSnapshot.platform)) {
        return {error: 'agent_platform_mismatch'};
      }
      const supportedPlatforms = normalizeCaptureAgentPlatforms(
        capabilities.supportedPlatforms,
      );
      if (
        supportedPlatforms.length > 0 &&
        !supportedPlatforms.includes(planSnapshot.platform)
      ) {
        return {error: 'agent_platform_unsupported'};
      }

      // One stable id identifies the cloud placeholder and the local request the
      // browser must create. The first heartbeat therefore updates this row rather
      // than inserting a visually duplicated task.
      const title = normalizedInput.title || (
        executionMode === 'unattended_plan'
          ? '无人值守关键词采集计划'
          : '一次性关键词采集'
      );
      if (!normalizedInput.clientTaskId) {
        return {error: 'request_key_required'};
      }
      if (!UUID_PATTERN.test(normalizedInput.clientTaskId)) {
        return {error: 'invalid_client_task_id'};
      }
      const clientTaskId = normalizedInput.clientTaskId.toLowerCase();
      const taskId = clientTaskId;
      const requestHash = remoteTaskRequestHash(
        agent.id,
        explicitInput.title || title,
        explicitInput.executionMode,
        explicitInput.planSnapshot,
      );

      // The agent row lock serializes creates for this node. A retry carrying the
      // same clientTaskId reuses the committed task/command only when its normalized
      // execution contract is identical; a conflicting payload is never ignored.
      const existingTask = await tx.queryOne(`
        SELECT t.*,
          c.id AS create_command_id,
          c.status AS create_command_status,
          c.expires_at AS create_command_expires_at,
          c.created_at AS create_command_created_at
        FROM capture_tasks t
        LEFT JOIN capture_agent_commands c
          ON c.id::text = t.metadata->>'createCommandId'
          AND c.task_id = t.id
          AND c.tenant_id = t.tenant_id
          AND c.agent_id = t.assigned_agent_id
          AND c.command_type = 'create'
        WHERE t.tenant_id = $1 AND t.origin_agent_id = $2
          AND t.client_task_id = $3
        FOR UPDATE OF t
      `, [req.tenantId, agent.id, clientTaskId]);
      if (existingTask) {
        const existingMetadata = safeJson(existingTask.metadata);
        if (
          existingTask.id !== clientTaskId ||
          existingMetadata.remoteCreated !== true ||
          existingMetadata.remoteRequestHash !== requestHash ||
          !existingTask.create_command_id
        ) {
          return {error: 'idempotency_key_conflict'};
        }
        return {
          agent,
          task: existingTask,
          command: {
            id: existingTask.create_command_id,
            status: existingTask.create_command_status,
            expires_at: existingTask.create_command_expires_at,
            created_at: existingTask.create_command_created_at,
          },
          existing: true,
          queueBlocker: safeJson(existingMetadata.queueBlocker),
          executionMode: existingMetadata.executionMode === 'unattended_plan'
            ? 'unattended_plan'
            : 'one_time',
        };
      }
      const idCollision = await tx.queryOne(`
        SELECT id FROM capture_tasks WHERE id = $1::uuid
      `, [taskId]);
      if (idCollision) return {error: 'idempotency_key_conflict'};

      const commandId = crypto.randomUUID();
      const isPlanConfiguration = executionMode === 'unattended_plan';

      // A plan configuration replaces the node's previous desired plan. Keep
      // the audit rows, but fence every older uncompleted plan command before
      // inserting the new one so an old acknowledged command cannot be
      // redelivered later and overwrite the newer plan. The agent row is
      // already locked above, serializing concurrent submissions for this node.
      if (isPlanConfiguration) {
        const olderPlanCommands = await tx.queryAll(`
          SELECT t.id AS task_id, c.id AS command_id
          FROM capture_tasks t
          JOIN capture_agent_commands c
            ON c.task_id = t.id AND c.tenant_id = t.tenant_id
          WHERE t.tenant_id = $1
            AND c.agent_id = $2
            AND c.command_type = 'create'
            AND c.status IN ('pending', 'acknowledged')
            AND c.payload->>'executionMode' = 'unattended_plan'
          ORDER BY t.id
          FOR UPDATE OF t
        `, [req.tenantId, agent.id]);
        const olderCommandIds = olderPlanCommands.map(item => item.command_id);
        if (olderCommandIds.length > 0) {
          const supersededCommands = await tx.queryAll(`
            UPDATE capture_agent_commands
            SET status = 'expired',
              result = jsonb_build_object(
                'reason', 'superseded_by_newer_plan',
                'supersededByTaskId', $2::text
              ),
              finished_at = now(), updated_at = now()
            WHERE id = ANY($1::uuid[])
              AND status IN ('pending', 'acknowledged')
            RETURNING id, task_id
          `, [olderCommandIds, taskId]);
          const supersededCommandByTask = new Map(
            supersededCommands.map(item => [String(item.task_id), item.id]),
          );
          const supersededTasks = await tx.queryAll(`
            UPDATE capture_tasks
            SET status = 'superseded',
              message = '已被较新的无人值守计划修改替代',
              error = '{}'::jsonb,
              metadata = metadata || jsonb_build_object(
                'supersededByTaskId', $2::text,
                'supersededAt', now()
              ),
              finished_at = now(), updated_at = now()
            WHERE id = ANY($1::uuid[])
              AND task_type = 'unattended_plan_configuration'
              AND status IN ('pending', 'claimed')
            RETURNING id, status
          `, [
            [...supersededCommandByTask.keys()],
            taskId,
          ]);
          for (const supersededTask of supersededTasks) {
            await appendEvent(tx, {
              tenantId: req.tenantId,
              taskId: supersededTask.id,
              agentId: agent.id,
              eventType: 'plan_configuration_superseded',
              actorType: 'user',
              actorId: req.user?.id || '',
              actorName: req.actorName,
              status: 'superseded',
              message: '较新的无人值守计划修改已替代此配置',
              payload: {
                commandId: supersededCommandByTask.get(
                  String(supersededTask.id),
                ) || '',
                supersededByTaskId: taskId,
              },
            });
          }
        }
      }

      // A busy browser keeps create commands durably queued. Only work that
      // still owns or is waiting for the execution slot may explain that wait;
      // terminal failed/partial results remain retryable but must not block the
      // next assignment forever.
      // Plan configuration itself does not consume the capture slot, so it must
      // neither inherit this blocker nor tell the operator to resolve old work.
      const queueBlocker = isPlanConfiguration ? null : await tx.queryOne(`
        SELECT id, title, platform, status
        FROM capture_tasks
        WHERE tenant_id = $1 AND assigned_agent_id = $2
          AND control_task_id IS NOT NULL AND control_task_id <> ''
          AND status IN (
            'pending', 'claimed', 'running', 'recovering',
            'interrupted', 'resume_requested'
          )
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `, [req.tenantId, agent.id]);

      const total = isPlanConfiguration
        ? 1
        : planSnapshot.keywords.length * planSnapshot.maxRounds;
      const taskType = isPlanConfiguration
        ? 'unattended_plan_configuration'
        : 'unattended_keyword_capture';
      const triggerType = isPlanConfiguration
        ? 'remote_plan_configuration'
        : 'remote_manual';
      const metadata = {
        remoteCreated: true,
        remoteRequestHash: requestHash,
        createCommandId: commandId,
        requestedByUserId: req.user?.id || '',
        requestedByName: text(req.actorName, 240),
        executionMode,
        planSnapshot,
        ...(queueBlocker ? {queueBlocker: {
          id: queueBlocker.id,
          title: queueBlocker.title,
          platform: queueBlocker.platform,
          status: queueBlocker.status,
        }} : {}),
      };
      const queuedMessage = queueBlocker
        ? '目标节点有待处理的旧任务，新任务已排队'
        : isPlanConfiguration
          ? '已创建无人值守计划，等待目标设备保存'
          : '已创建一次性采集任务，等待目标设备领取';
      const task = await tx.queryOne(`
        INSERT INTO capture_tasks (
          id, tenant_id, origin_agent_id, assigned_agent_id,
          client_task_id, task_type, feature_key, title, platform,
          source, trigger_type, status, progress, checkpoint, counts,
          metadata, message, source_updated_at
        ) VALUES (
          $1::uuid, $2, $3, $3,
          $1::text, $6, 'unattended_keyword_plan', $4, $5,
          'cloud', $7, 'pending', $8::jsonb, $9::jsonb, $10::jsonb,
          $11::jsonb, $12, now()
        )
        RETURNING id, client_task_id, task_type, feature_key, title, platform,
          source, trigger_type, status, progress, counts, metadata,
          created_at, updated_at
      `, [
        taskId,
        req.tenantId,
        agent.id,
        title,
        planSnapshot.platform,
        taskType,
        triggerType,
        JSON.stringify({current: 0, total, phase: 'queued'}),
        JSON.stringify({round: 1, keywordIndex: 0}),
        JSON.stringify({total, processed: 0, success: 0, failed: 0, skipped: 0}),
        JSON.stringify(metadata),
        queuedMessage,
      ]);
      const command = await tx.queryOne(`
        INSERT INTO capture_agent_commands (
          id, tenant_id, agent_id, task_id, command_type, payload,
          requested_by_user_id, requested_by_name
        ) VALUES ($1, $2, $3, $4, 'create', $5::jsonb, $6, $7)
        RETURNING id, status, expires_at, created_at
      `, [
        commandId,
        req.tenantId,
        agent.id,
        task.id,
        JSON.stringify({
          taskId: task.id,
          clientTaskId,
          title,
          executionMode,
          platform: planSnapshot.platform,
          planSnapshot,
          requestHash,
          authCodeId: agent.auth_code_id,
          authBindingId: agent.auth_binding_id,
        }),
        req.user?.id || null,
        text(req.actorName, 240),
      ]);
      await appendEvent(tx, {
        tenantId: req.tenantId,
        taskId: task.id,
        agentId: agent.id,
        eventType: 'remote_task_created',
        actorType: 'user',
        actorId: req.user?.id || '',
        actorName: req.actorName,
        status: task.status,
        message: isPlanConfiguration
          ? '后台已向指定节点下发无人值守计划'
          : '后台已向指定节点创建一次性任务',
        payload: {
          commandId: command.id,
          clientTaskId,
          executionMode,
          platform: planSnapshot.platform,
          keywordCount: planSnapshot.keywords.length,
          keywordMaxDetectedItems: planSnapshot.keywordMaxDetectedItems,
          maxRounds: planSnapshot.maxRounds,
          queuedBehindTaskId: queueBlocker?.id || '',
        },
      });
      return {agent, task, command, existing: false, queueBlocker, executionMode};
    });

    const messages = {
      agent_not_found: ['agent_not_found', '采集节点不存在'],
      agent_unavailable: ['agent_unavailable', '目标节点授权已失效、已停用或不存在'],
      agent_capability_missing: ['agent_capability_missing', '目标节点版本尚不支持云端创建任务，请先更新扩展'],
      agent_plan_capability_missing: ['agent_plan_capability_missing', '目标节点版本尚不支持云端保存无人值守计划，请先更新扩展'],
      agent_enhancement_capability_missing: ['agent_enhancement_capability_missing', '目标节点版本尚不支持远程任务增强选项，请先更新扩展'],
      agent_keyword_limit_capability_missing: ['agent_keyword_limit_capability_missing', '目标节点版本尚不支持为远程任务指定帖子采集数量，请先更新扩展'],
      invalid_keyword_max_detected_items: ['invalid_keyword_max_detected_items', '每个关键词采集帖子数必须是大于 0 的整数'],
      custom_dates_required: ['custom_dates_required', '指定日期计划至少需要一个有效日期'],
      request_key_required: ['request_key_required', '缺少任务请求标识，请刷新页面后重试'],
      invalid_client_task_id: ['invalid_client_task_id', 'clientTaskId 必须是有效 UUID'],
      idempotency_key_conflict: ['idempotency_key_conflict', '该 clientTaskId 已用于不同的任务请求，请重新生成'],
      unsupported_platform: ['unsupported_platform', '云端创建任务当前只支持小红书和抖音'],
      keywords_required: ['keywords_required', '请至少填写一个关键词'],
      agent_platform_mismatch: ['agent_platform_mismatch', '目标节点未配置负责该任务平台'],
      agent_platform_unsupported: ['agent_platform_unsupported', '目标节点当前版本不支持该任务平台'],
    };
    if (result.error) {
      const [error, message] = messages[result.error];
      const status = result.error === 'agent_not_found'
        ? 404
        : [
            'unsupported_platform',
            'keywords_required',
            'request_key_required',
            'invalid_client_task_id',
            'invalid_keyword_max_detected_items',
            'custom_dates_required',
          ].includes(result.error) ? 400 : 409;
      return res.status(status).json({ok: false, error, message});
    }
    const online = captureAgentOnline(result.agent.last_heartbeat_at);
    const responseStatus = result.existing
      ? result.task.status === 'pending' && !online ? 'waiting_device' : result.task.status
      : online ? 'pending' : 'waiting_device';
    return res.status(result.existing ? 200 : 201).json({
      ok: true,
      task: result.task,
      commandId: result.command.id,
      commandExpiresAt: result.command.expires_at,
      existing: result.existing === true,
      queuedBehindRecoverableTask: Boolean(
        result.queueBlocker?.id && result.task.status === 'pending',
      ),
      agentOnline: online,
      status: responseStatus,
      message: result.existing
        ? '相同请求已存在，已返回原任务状态'
        : result.queueBlocker?.id
          ? '任务已排队；请先继续或处理该节点的旧任务，设备空闲后会自动执行'
          : result.executionMode === 'unattended_plan' && online
            ? '无人值守计划已下发，在线设备将在下一次心跳保存并启用'
            : result.executionMode === 'unattended_plan'
              ? '无人值守计划已排队，设备上线后自动保存并启用'
          : online
            ? '一次性任务已创建，在线设备将在下一次心跳领取'
            : '一次性任务已创建，设备当前离线，上线后自动领取',
    });
  } catch (err) {
    return next(err);
  }
});

router.delete('/agents/:id/unattended-plan', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const result = await withTransaction(async tx => {
      const agent = await tx.queryOne(`
        SELECT ca.*, tenant.status AS tenant_status,
          ac.status AS auth_code_status,
          ac.expires_at AS auth_code_expires_at,
          ab.id AS active_auth_binding_id
        FROM capture_agents ca
        JOIN tenants tenant ON tenant.id = ca.tenant_id
        LEFT JOIN auth_codes ac
          ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
        LEFT JOIN auth_bindings ab
          ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
        WHERE ca.id = $1 AND ca.tenant_id = $2
        FOR UPDATE OF ca
      `, [req.params.id, req.tenantId]);
      if (!agent) return {error: 'agent_not_found'};

      const authCodeExpired = agent.auth_code_expires_at &&
        new Date(agent.auth_code_expires_at) < new Date();
      if (
        agent.tenant_status !== 'active' ||
        agent.status !== 'active' ||
        agent.auth_code_status !== 'active' ||
        !agent.active_auth_binding_id ||
        authCodeExpired
      ) {
        return {error: 'agent_unavailable'};
      }

      const capabilities = safeJson(agent.capabilities);
      if (
        capabilities.remoteTaskCreate !== true ||
        capabilities.remoteUnattendedPlanWrite !== true ||
        capabilities.remoteUnattendedPlanDelete !== true
      ) {
        return {error: 'agent_plan_delete_capability_missing'};
      }

      const existing = await tx.queryOne(`
        SELECT t.id, t.status, t.created_at,
          c.id AS command_id, c.status AS command_status,
          c.expires_at AS command_expires_at
        FROM capture_tasks t
        JOIN capture_agent_commands c
          ON c.task_id = t.id AND c.tenant_id = t.tenant_id
        WHERE t.tenant_id = $1
          AND c.agent_id = $2
          AND c.command_type = 'create'
          AND c.status IN ('pending', 'acknowledged')
          AND c.payload->>'executionMode' = 'unattended_plan'
          AND c.payload->>'planOperation' = 'delete'
        ORDER BY c.created_at DESC
        LIMIT 1
        FOR UPDATE OF t
      `, [req.tenantId, agent.id]);
      if (existing) {
        return {
          agent,
          task: existing,
          command: {
            id: existing.command_id,
            status: existing.command_status,
            expires_at: existing.command_expires_at,
          },
          existing: true,
        };
      }

      const mirroredPlan = safeJson(agent.unattended_plan);
      if (!hasConfiguredAgentPlan(mirroredPlan)) {
        return {error: 'plan_not_found'};
      }

      const supportedPlatforms = normalizeCaptureAgentPlatforms(
        capabilities.supportedPlatforms,
      );
      const allowedPlatforms = Array.isArray(agent.allowed_platforms)
        ? agent.allowed_platforms
        : [];
      const platformCandidates = [
        text(mirroredPlan.platform, 60),
        ...allowedPlatforms,
        ...supportedPlatforms,
        'xiaohongshu',
      ];
      const platform = platformCandidates.find(candidate =>
        ['xiaohongshu', 'douyin'].includes(candidate) &&
        (allowedPlatforms.length === 0 || allowedPlatforms.includes(candidate)) &&
        (supportedPlatforms.length === 0 || supportedPlatforms.includes(candidate)),
      );
      if (!platform) return {error: 'agent_platform_unsupported'};

      const taskId = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      const olderPlanCommands = await tx.queryAll(`
        SELECT t.id AS task_id, c.id AS command_id
        FROM capture_tasks t
        JOIN capture_agent_commands c
          ON c.task_id = t.id AND c.tenant_id = t.tenant_id
        WHERE t.tenant_id = $1
          AND c.agent_id = $2
          AND c.command_type = 'create'
          AND c.status IN ('pending', 'acknowledged')
          AND c.payload->>'executionMode' = 'unattended_plan'
        ORDER BY t.id
        FOR UPDATE OF t
      `, [req.tenantId, agent.id]);
      const olderCommandIds = olderPlanCommands.map(item => item.command_id);
      if (olderCommandIds.length > 0) {
        const supersededCommands = await tx.queryAll(`
          UPDATE capture_agent_commands
          SET status = 'expired',
            result = jsonb_build_object(
              'reason', 'superseded_by_newer_plan',
              'supersededByTaskId', $2::text
            ),
            finished_at = now(), updated_at = now()
          WHERE id = ANY($1::uuid[])
            AND status IN ('pending', 'acknowledged')
          RETURNING id, task_id
        `, [olderCommandIds, taskId]);
        const supersededCommandByTask = new Map(
          supersededCommands.map(item => [String(item.task_id), item.id]),
        );
        const supersededTaskIds = [...supersededCommandByTask.keys()];
        if (supersededTaskIds.length > 0) {
          const supersededTasks = await tx.queryAll(`
            UPDATE capture_tasks
            SET status = 'superseded',
              message = '已被删除无人值守计划的指令替代',
              error = '{}'::jsonb,
              metadata = metadata || jsonb_build_object(
                'supersededByTaskId', $2::text,
                'supersededAt', now()
              ),
              finished_at = now(), updated_at = now()
            WHERE id = ANY($1::uuid[])
              AND task_type = 'unattended_plan_configuration'
              AND status IN ('pending', 'claimed')
            RETURNING id, status
          `, [supersededTaskIds, taskId]);
          for (const supersededTask of supersededTasks) {
            await appendEvent(tx, {
              tenantId: req.tenantId,
              taskId: supersededTask.id,
              agentId: agent.id,
              eventType: 'plan_configuration_superseded',
              actorType: 'user',
              actorId: req.user?.id || '',
              actorName: req.actorName,
              status: 'superseded',
              message: '删除计划指令已替代较早的计划修改',
              payload: {
                commandId: supersededCommandByTask.get(
                  String(supersededTask.id),
                ) || '',
                supersededByTaskId: taskId,
              },
            });
          }
        }
      }

      const planSnapshot = {
        configured: false,
        enabled: false,
        platform,
        keywords: [],
      };
      const metadata = {
        remoteCreated: true,
        createCommandId: commandId,
        requestedByUserId: req.user?.id || '',
        requestedByName: text(req.actorName, 240),
        executionMode: 'unattended_plan',
        planOperation: 'delete',
        planSnapshot,
      };
      const task = await tx.queryOne(`
        INSERT INTO capture_tasks (
          id, tenant_id, origin_agent_id, assigned_agent_id,
          client_task_id, task_type, feature_key, title, platform,
          source, trigger_type, status, progress, checkpoint, counts,
          metadata, message, source_updated_at
        ) VALUES (
          $1::uuid, $2, $3, $3,
          $1::text, 'unattended_plan_configuration',
          'unattended_keyword_plan', '删除无人值守计划', $4,
          'cloud', 'remote_plan_delete', 'pending',
          '{"current":0,"total":1,"phase":"queued"}'::jsonb,
          '{}'::jsonb,
          '{"total":1,"processed":0,"success":0,"failed":0,"skipped":0}'::jsonb,
          $5::jsonb, '删除指令已创建，等待目标设备确认', now()
        )
        RETURNING id, client_task_id, task_type, feature_key, title, platform,
          source, trigger_type, status, progress, counts, metadata,
          created_at, updated_at
      `, [
        taskId,
        req.tenantId,
        agent.id,
        platform,
        JSON.stringify(metadata),
      ]);
      const command = await tx.queryOne(`
        INSERT INTO capture_agent_commands (
          id, tenant_id, agent_id, task_id, command_type, payload,
          requested_by_user_id, requested_by_name
        ) VALUES ($1, $2, $3, $4, 'create', $5::jsonb, $6, $7)
        RETURNING id, status, expires_at, created_at
      `, [
        commandId,
        req.tenantId,
        agent.id,
        task.id,
        JSON.stringify({
          taskId: task.id,
          clientTaskId: task.id,
          executionMode: 'unattended_plan',
          planOperation: 'delete',
          platform,
          planSnapshot,
          authCodeId: agent.auth_code_id,
          authBindingId: agent.auth_binding_id,
        }),
        req.user?.id || null,
        text(req.actorName, 240),
      ]);
      await appendEvent(tx, {
        tenantId: req.tenantId,
        taskId: task.id,
        agentId: agent.id,
        eventType: 'unattended_plan_delete_requested',
        actorType: 'user',
        actorId: req.user?.id || '',
        actorName: req.actorName,
        status: task.status,
        message: '后台已向指定节点下发删除无人值守计划指令',
        payload: {
          commandId: command.id,
          planOperation: 'delete',
          platform,
        },
      });
      return {agent, task, command, existing: false};
    });

    const messages = {
      agent_not_found: ['agent_not_found', '采集节点不存在'],
      agent_unavailable: ['agent_unavailable', '目标节点授权已失效、已停用或不存在'],
      agent_plan_delete_capability_missing: [
        'agent_plan_delete_capability_missing',
        '目标节点版本尚不支持安全删除无人值守计划，请先更新 Extension',
      ],
      plan_not_found: ['plan_not_found', '该节点当前没有可删除的无人值守计划'],
      agent_platform_unsupported: ['agent_platform_unsupported', '目标节点当前版本不支持该计划平台'],
    };
    if (result.error) {
      const [error, message] = messages[result.error];
      const status = result.error === 'agent_not_found' || result.error === 'plan_not_found'
        ? 404
        : 409;
      return res.status(status).json({ok: false, error, message});
    }

    const online = captureAgentOnline(result.agent.last_heartbeat_at);
    return res.status(result.existing ? 200 : 202).json({
      ok: true,
      task: result.task,
      commandId: result.command.id,
      commandExpiresAt: result.command.expires_at,
      existing: result.existing === true,
      agentOnline: online,
      status: online ? 'pending' : 'waiting_device',
      message: result.existing
        ? '删除计划指令已存在，正在等待设备确认'
        : online
          ? '删除指令已下发，设备将在下一次心跳停止并清除计划'
          : '删除指令已排队，设备上线后自动停止并清除计划',
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/tasks/:id/dismiss-attention', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const result = await withTransaction(async tx => {
      const task = await tx.queryOne(`
        SELECT id, parent_task_id, status, attention_dismissed_at
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [req.params.id, req.tenantId]);
      if (!task) return {error: 'task_not_found'};
      if (task.parent_task_id) return {error: 'task_not_root'};
      if (!DISMISSIBLE_ATTENTION_STATUSES.has(task.status)) {
        return {error: 'task_not_dismissible'};
      }
      if (task.attention_dismissed_at) {
        return {task, idempotent: true};
      }

      const dismissed = await tx.queryOne(`
        UPDATE capture_tasks
        SET attention_dismissed_at = now(),
          attention_dismissed_by_user_id = $1,
          attention_dismissed_by_name = $2,
          updated_at = now()
        WHERE id = $3 AND tenant_id = $4
        RETURNING id, status, attention_dismissed_at,
          attention_dismissed_by_user_id, attention_dismissed_by_name
      `, [
        req.user?.id || null,
        text(req.actorName, 240),
        task.id,
        req.tenantId,
      ]);
      await appendEvent(tx, {
        tenantId: req.tenantId,
        taskId: task.id,
        eventType: 'task_attention_dismissed',
        actorType: 'user',
        actorId: req.user?.id || '',
        actorName: req.actorName,
        status: task.status,
        message: '已将结束的失败任务移到历史',
        payload: {
          previousStatus: task.status,
          mode: 'single',
        },
      });
      return {task: dismissed, idempotent: false};
    });

    const messages = {
      task_not_found: ['task_not_found', '任务不存在'],
      task_not_root: ['task_not_root', '子任务请在编排详情中处理，不能从主任务队列单独清理'],
      task_not_dismissible: ['task_not_dismissible', '只有已结束的失败或部分失败任务可以移到历史'],
    };
    if (result.error) {
      const [error, message] = messages[result.error];
      return res.status(result.error === 'task_not_found' ? 404 : 409).json({
        ok: false,
        error,
        message,
      });
    }
    return res.json({
      ok: true,
      task: result.task,
      idempotent: result.idempotent,
      message: result.idempotent ? '任务已经在历史中' : '已移到历史，任务和采集结果仍会保留',
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/tasks/dismiss-terminal-attention', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const result = await withTransaction(async tx => {
      const tasks = await tx.queryAll(`
        SELECT id, status
        FROM capture_tasks
        WHERE tenant_id = $1
          AND parent_task_id IS NULL
          AND status IN ('failed', 'completed_with_failures')
          AND attention_dismissed_at IS NULL
        ORDER BY id
        FOR UPDATE
      `, [req.tenantId]);
      if (tasks.length === 0) return {tasks: []};

      const taskIds = tasks.map(task => task.id);
      await tx.execute(`
        UPDATE capture_tasks
        SET attention_dismissed_at = now(),
          attention_dismissed_by_user_id = $1,
          attention_dismissed_by_name = $2,
          updated_at = now()
        WHERE tenant_id = $3
          AND id = ANY($4::uuid[])
      `, [
        req.user?.id || null,
        text(req.actorName, 240),
        req.tenantId,
        taskIds,
      ]);
      for (const task of tasks) {
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: task.id,
          eventType: 'task_attention_dismissed',
          actorType: 'user',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: task.status,
          message: '批量将结束的失败任务移到历史',
          payload: {
            previousStatus: task.status,
            mode: 'bulk',
          },
        });
      }
      return {tasks};
    });

    const dismissedCount = result.tasks.length;
    return res.json({
      ok: true,
      dismissedCount,
      taskIds: result.tasks.map(task => task.id),
      message: dismissedCount > 0
        ? `已将 ${dismissedCount} 个结束的失败任务移到历史`
        : '当前没有可清理的结束失败任务',
    });
  } catch (err) {
    return next(err);
  }
});

function promotedRetryKeywordItemKey(keyword, ordinal) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(String(keyword || ''))
    .digest('hex')
    .slice(0, 12);
  return `keyword:${String(ordinal + 1).padStart(4, '0')}:${fingerprint}`;
}

function promotedRetryKeywordError(entry = {}) {
  const raw = entry.error;
  const error = raw && typeof raw === 'object'
    ? sanitizeCloudStructuredObject(raw)
    : text(raw, 1000)
      ? {message: text(raw, 1000)}
      : {};
  const code = text(entry.errorCode || entry.error_code, 100);
  const category = text(entry.errorCategory || entry.error_category, 100);
  return {
    ...error,
    ...(code ? {code} : {}),
    ...(category ? {category} : {}),
    ...(entry.securityBlocked === true ? {securityBlocked: true} : {}),
    ...(entry.requiresManualAction === true
      ? {requiresManualAction: true}
      : {}),
  };
}

async function synthesizePromotedKeywordItems(tx, task, sourceTaskId) {
  const metadata = safeJson(task.metadata);
  const command = await tx.queryOne(`
    SELECT payload
    FROM capture_agent_commands
    WHERE tenant_id = $1 AND task_id = $2 AND command_type = 'create'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [task.tenant_id, task.id]);
  const commandPayload = safeJson(command?.payload);
  const planSnapshot = safeJson(
    metadata.planSnapshot || commandPayload.planSnapshot,
  );
  const normalized = normalizeRemoteTaskInput({
    clientTaskId: task.id,
    title: task.title,
    executionMode: 'one_time',
    planSnapshot: {
      ...planSnapshot,
      platform: task.platform,
    },
  });
  const checkpointEntries = orchestrationCheckpointEntries(task);
  const checkpointByKeyword = new Map(
    checkpointEntries.map(entry => [text(entry.keyword, 120), entry]),
  );
  const keywords = normalized.planSnapshot.keywords.length > 0
    ? normalized.planSnapshot.keywords
    : checkpointEntries.map(entry => text(entry.keyword, 120)).filter(Boolean);
  if (keywords.length === 0) return {error: 'retry_items_unavailable'};

  const baseRevision = Math.max(1, Number(task.orchestration_revision || 0));
  const sourceAgentId = task.assigned_agent_id || task.origin_agent_id || null;
  for (let ordinal = 0; ordinal < keywords.length; ordinal += 1) {
    const keyword = keywords[ordinal];
    const entry = safeJson(checkpointByKeyword.get(keyword));
    const projected = Object.keys(entry).length > 0
      ? checkpointEntryToItemStatus(entry)
      : 'retryable';
    const error = promotedRetryKeywordError(entry);
    const manualSafety = crossDeviceRetryItemNeedsManualSafety({
      error,
      metadata: {checkpoint: entry},
    });
    const status = [
      'completed',
      'completed_with_warnings',
      'skipped',
      'canceled',
    ].includes(projected)
      ? projected
      : manualSafety
        ? 'needs_action'
        : 'retryable';
    const attemptCount = Math.max(
      1,
      orchestrationCheckpointInteger(entry.attemptCount),
    );
    const finishedAt = ORCHESTRATION_ITEM_TERMINAL_STATUSES.has(status)
      ? orchestrationCheckpointTimestamp(entry.finishedAt) || new Date().toISOString()
      : null;
    const item = await tx.queryOne(`
      INSERT INTO capture_task_items (
        id, tenant_id, task_id, item_key, ordinal, keyword,
        platform, item_type, status, attempt_count,
        assigned_agent_id, execution_task_id, assignment_revision,
        error, metadata, assigned_at, dispatched_at, started_at, finished_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, 'keyword', $8, $9,
        $10, $11, $12,
        $13::jsonb, $14::jsonb, $15, $15, $16, $17
      )
      ON CONFLICT (task_id, item_key) DO NOTHING
      RETURNING id
    `, [
      crypto.randomUUID(),
      task.tenant_id,
      task.id,
      promotedRetryKeywordItemKey(keyword, ordinal),
      ordinal,
      keyword,
      task.platform,
      status,
      attemptCount,
      sourceAgentId,
      sourceTaskId,
      baseRevision,
      JSON.stringify(error),
      JSON.stringify({checkpoint: entry, promotedFromSingleNodeTask: true}),
      task.started_at || task.created_at || new Date().toISOString(),
      Object.keys(entry).length > 0
        ? task.started_at || task.created_at || new Date().toISOString()
        : null,
      finishedAt,
    ]);
    if (!item) continue;
    await tx.execute(`
      INSERT INTO capture_task_item_attempts (
        id, tenant_id, item_id, parent_task_id, execution_task_id,
        agent_id, attempt_number, assignment_revision, status,
        checkpoint, result, error, assigned_at, dispatched_at,
        started_at, finished_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10::jsonb, $11::jsonb, $12::jsonb, $13, $13,
        $14, $15
      )
    `, [
      crypto.randomUUID(),
      task.tenant_id,
      item.id,
      task.id,
      sourceTaskId,
      sourceAgentId,
      attemptCount,
      baseRevision,
      orchestrationItemAttemptStatus(status),
      JSON.stringify(entry),
      JSON.stringify({savedCount: orchestrationCheckpointInteger(entry.savedCount)}),
      JSON.stringify(error),
      task.started_at || task.created_at || new Date().toISOString(),
      Object.keys(entry).length > 0
        ? task.started_at || task.created_at || new Date().toISOString()
        : null,
      finishedAt,
    ]);
  }
  return {planSnapshot: normalized.planSnapshot, commandPayload};
}

async function promoteSingleNodeTaskForRetry(tx, task) {
  const metadata = safeJson(task.metadata);
  if (
    task.task_type === 'capture_orchestration' ||
    metadata.promotedRetryParent === true
  ) {
    return {
      parent: task,
      businessTaskType: promotedRetryBusinessTaskType(task),
      sourceTaskId: text(metadata.promotedSourceExecutionTaskId, 100),
    };
  }
  const businessTaskType = promotedRetryBusinessTaskType(task);
  const sourceTaskId = crypto.randomUUID();
  const sourceMetadata = {
    ...metadata,
    orchestrationChild: true,
    parentTaskId: task.id,
    promotedSourceExecution: true,
    promotedAt: new Date().toISOString(),
  };
  await tx.execute(`
    INSERT INTO capture_tasks (
      id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, control_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, progress, checkpoint, counts,
      metadata, error, message, attempt_number, progress_seq,
      orchestration_revision, heartbeat_at, business_progress_at,
      started_at, finished_at, source_updated_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      '', $6, $7, $8, $9,
      $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb,
      $17::jsonb, $18::jsonb, $19, $20, $21,
      $22, $23, $24,
      $25, $26, $27, $28, now()
    )
  `, [
    sourceTaskId,
    task.tenant_id,
    task.id,
    task.origin_agent_id,
    task.assigned_agent_id,
    task.control_task_id,
    businessTaskType,
    task.feature_key,
    `${text(task.title, 190)} · 原执行`,
    task.platform,
    task.source,
    task.trigger_type,
    task.status,
    JSON.stringify(safeJson(task.progress)),
    JSON.stringify(safeJson(task.checkpoint)),
    JSON.stringify(safeJson(task.counts)),
    JSON.stringify(sourceMetadata),
    JSON.stringify(safeJson(task.error)),
    task.message,
    Number(task.attempt_number || 0),
    Number(task.progress_seq || 0),
    Math.max(1, Number(task.orchestration_revision || 0)),
    task.heartbeat_at,
    task.business_progress_at,
    task.started_at,
    task.finished_at,
    task.source_updated_at,
    task.created_at,
  ]);
  await tx.execute(`
    UPDATE capture_task_items
    SET execution_task_id = $1, updated_at = now()
    WHERE tenant_id = $2 AND task_id = $3
      AND execution_task_id = $3
  `, [sourceTaskId, task.tenant_id, task.id]);
  await tx.execute(`
    UPDATE capture_task_item_attempts
    SET execution_task_id = $1, updated_at = now()
    WHERE tenant_id = $2 AND parent_task_id = $3
      AND execution_task_id = $3
  `, [sourceTaskId, task.tenant_id, task.id]);

  const existingItems = await tx.queryOne(`
    SELECT COUNT(*)::integer AS count
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2
  `, [task.tenant_id, task.id]);
  let keywordContract = {};
  if (
    businessTaskType === 'unattended_keyword_capture' &&
    Number(existingItems?.count || 0) === 0
  ) {
    keywordContract = await synthesizePromotedKeywordItems(
      tx,
      task,
      sourceTaskId,
    );
    if (keywordContract.error) return keywordContract;
  }

  const items = await tx.queryAll(`
    SELECT status
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2
    ORDER BY ordinal, id
  `, [task.tenant_id, task.id]);
  if (items.length === 0) return {error: 'retry_items_unavailable'};
  const aggregate = aggregateParentTaskItems(items);
  const parent = await tx.queryOne(`
    UPDATE capture_tasks
    SET task_type = 'capture_orchestration',
      assigned_agent_id = NULL,
      status = $1,
      progress = $2::jsonb,
      counts = $3::jsonb,
      metadata = metadata || jsonb_build_object(
        'promotedRetryParent', true,
        'promotedBusinessTaskType', $4::text,
        'promotedSourceExecutionTaskId', $5::uuid::text,
        'promotedAt', now(),
        'originalAssignedAgentId', COALESCE($6::uuid::text, ''),
        'planSnapshot', COALESCE($7::jsonb, metadata->'planSnapshot')
      ),
      message = '原任务已保留，未完成项正在准备由空闲设备重试',
      orchestration_revision = GREATEST(orchestration_revision, 1),
      finished_at = NULL,
      attention_dismissed_at = NULL,
      updated_at = now(),
      source_updated_at = now()
    WHERE id = $8 AND tenant_id = $9
      AND metadata->>'promotedRetryParent' IS DISTINCT FROM 'true'
    RETURNING *
  `, [
    aggregate.status,
    JSON.stringify(aggregate.progress),
    JSON.stringify(aggregate.counts),
    businessTaskType,
    sourceTaskId,
    task.assigned_agent_id || task.origin_agent_id || null,
    keywordContract.planSnapshot
      ? JSON.stringify(keywordContract.planSnapshot)
      : null,
    task.id,
    task.tenant_id,
  ]);
  return {
    parent,
    businessTaskType,
    sourceTaskId,
    commandPayload: keywordContract.commandPayload,
  };
}

async function loadIdleCrossDeviceRetryAgent(tx, {
  tenantId,
  task,
  sourceAgentIds = [],
  commandPayload = {},
  safetyHandoffPolicy = null,
}) {
  const platform = text(task.platform, 40).toLowerCase();
  if (!['xiaohongshu', 'douyin', 'weibo'].includes(platform)) return null;
  const excludedIds = sourceAgentIds
    .map(value => text(value, 100).toLowerCase())
    .filter(value => UUID_PATTERN.test(value));
  // Agent usage remains authoritative even when account identity is absent.
  // A current account contributes only its configured hard search limit.
  const candidates = await tx.queryAll(`
    SELECT ca.*, tenant.status AS tenant_status,
      ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
      ab.id AS active_auth_binding_id,
      daily_usage.usage_date =
        (now() AT TIME ZONE 'Asia/Shanghai')::date AS today_usage_current,
      daily_usage.searches AS today_searches,
      daily_usage.last_event_at AS today_usage_last_event_at,
      current_social_account.daily_search_limit,
      current_social_account.platform_account_id,
      current_social_binding.last_login_state,
      (
        SELECT COUNT(*)::integer
        FROM capture_tasks active_task
        WHERE active_task.tenant_id = ca.tenant_id
          AND COALESCE(
            active_task.assigned_agent_id,
            active_task.origin_agent_id
          ) = ca.id
          AND active_task.id <> $3
          AND active_task.task_type <> 'capture_orchestration'
          AND active_task.status = ANY($4::text[])
      ) AS active_task_count,
      (
        SELECT COUNT(*)::integer
        FROM capture_agent_commands active_command
        WHERE active_command.tenant_id = ca.tenant_id
          AND active_command.agent_id = ca.id
          AND active_command.status IN ('pending', 'acknowledged')
          AND (
            active_command.expires_at IS NULL OR
            active_command.expires_at > now()
          )
      ) AS active_command_count
      , (
        SELECT COUNT(*)::integer
        FROM capture_tasks recent_failure
        WHERE recent_failure.tenant_id = ca.tenant_id
          AND COALESCE(
            recent_failure.assigned_agent_id,
            recent_failure.origin_agent_id
          ) = ca.id
          AND recent_failure.created_at > now() - interval '2 hours'
          AND recent_failure.status IN ('failed', 'completed_with_failures')
          AND NOT (
            COALESCE(recent_failure.error::text, '') ~*
              'captcha|security.verification|login.required|safety.block'
          )
      ) AS recent_technical_failure_count
      , (
        SELECT COUNT(*)::integer
        FROM capture_tasks recent_success
        WHERE recent_success.tenant_id = ca.tenant_id
          AND COALESCE(
            recent_success.assigned_agent_id,
            recent_success.origin_agent_id
          ) = ca.id
          AND recent_success.created_at > now() - interval '2 hours'
          AND recent_success.status IN ('completed', 'completed_with_warnings')
      ) AS recent_success_count
      , (
        SELECT MAX(recent_assignment.created_at)
        FROM capture_tasks recent_assignment
        WHERE recent_assignment.tenant_id = ca.tenant_id
          AND COALESCE(
            recent_assignment.assigned_agent_id,
            recent_assignment.origin_agent_id
          ) = ca.id
      ) AS last_assignment_at
    FROM capture_agents ca
    JOIN tenants tenant ON tenant.id = ca.tenant_id
    LEFT JOIN auth_codes ac
      ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
    LEFT JOIN auth_bindings ab
      ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
    JOIN social_agent_daily_usage daily_usage
      ON daily_usage.tenant_id = ca.tenant_id
      AND daily_usage.agent_id = ca.id
      AND daily_usage.platform = $5
      AND daily_usage.usage_date =
        (now() AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN social_account_bindings current_social_binding
      ON current_social_binding.tenant_id = ca.tenant_id
      AND current_social_binding.agent_id = ca.id
      AND current_social_binding.platform = $5
      AND current_social_binding.status = 'current'
    LEFT JOIN social_accounts current_social_account
      ON current_social_account.tenant_id = ca.tenant_id
      AND current_social_account.id =
        current_social_binding.social_account_id
    WHERE ca.tenant_id = $1
      AND ca.status = 'active'
      AND NOT (ca.id = ANY($2::uuid[]))
      AND daily_usage.last_event_at IS NOT NULL
      AND (
        current_social_account.daily_search_limit IS NULL OR
        current_social_account.daily_search_limit = 0 OR
        daily_usage.searches < current_social_account.daily_search_limit
      )
    ORDER BY daily_usage.searches ASC,
      recent_technical_failure_count ASC,
      recent_success_count DESC,
      last_assignment_at ASC NULLS FIRST,
      ca.last_heartbeat_at DESC NULLS LAST,
      ca.id
  `, [
    tenantId,
    excludedIds,
    task.id,
    CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
    platform,
  ]);
  const eligibleCandidates = candidates.filter(agent => {
    const authExpired = agent.auth_code_expires_at &&
      new Date(agent.auth_code_expires_at) < new Date();
    return agent.tenant_status === 'active' &&
      agent.auth_code_status === 'active' &&
      Boolean(agent.active_auth_binding_id) &&
      !authExpired &&
      captureAgentOnline(agent.last_heartbeat_at) &&
      Number(agent.active_task_count || 0) === 0 &&
      Number(agent.active_command_count || 0) === 0 &&
      crossDeviceRetryAgentDailyUsageEligible(agent) &&
      crossDeviceRetryAgentSupportsTask(agent, task, commandPayload);
  });
  for (const candidate of eligibleCandidates) {
    const savepoint = 'capture_retry_agent_candidate';
    await tx.execute(`SAVEPOINT ${savepoint}`);
    try {
      const slotLocked = await tryLockCaptureAgentExecutionSlot(
        tx,
        tenantId,
        candidate.id,
      );
      if (!slotLocked) {
        await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
        continue;
      }
      const locked = await tx.queryOne(`
        SELECT ca.*, tenant.status AS tenant_status,
          ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
          ab.id AS active_auth_binding_id,
          daily_usage.usage_date =
            (now() AT TIME ZONE 'Asia/Shanghai')::date AS today_usage_current,
          daily_usage.searches AS today_searches,
          daily_usage.last_event_at AS today_usage_last_event_at,
          current_social_account.daily_search_limit,
          current_social_account.platform_account_id,
          current_social_binding.last_login_state
        FROM capture_agents ca
        JOIN tenants tenant ON tenant.id = ca.tenant_id
        LEFT JOIN auth_codes ac
          ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
        LEFT JOIN auth_bindings ab
          ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
        JOIN social_agent_daily_usage daily_usage
          ON daily_usage.tenant_id = ca.tenant_id
          AND daily_usage.agent_id = ca.id
          AND daily_usage.platform = $3
          AND daily_usage.usage_date =
            (now() AT TIME ZONE 'Asia/Shanghai')::date
        LEFT JOIN social_account_bindings current_social_binding
          ON current_social_binding.tenant_id = ca.tenant_id
          AND current_social_binding.agent_id = ca.id
          AND current_social_binding.platform = $3
          AND current_social_binding.status = 'current'
        LEFT JOIN social_accounts current_social_account
          ON current_social_account.tenant_id = ca.tenant_id
          AND current_social_account.id =
            current_social_binding.social_account_id
        WHERE ca.id = $1 AND ca.tenant_id = $2
          AND daily_usage.last_event_at IS NOT NULL
          AND (
            current_social_account.daily_search_limit IS NULL OR
            current_social_account.daily_search_limit = 0 OR
            daily_usage.searches < current_social_account.daily_search_limit
          )
        FOR UPDATE OF ca, daily_usage
      `, [candidate.id, tenantId, platform]);
      const authExpired = locked?.auth_code_expires_at &&
        new Date(locked.auth_code_expires_at) < new Date();
      let eligible = locked &&
        locked.status === 'active' &&
        locked.tenant_status === 'active' &&
        locked.auth_code_status === 'active' &&
        Boolean(locked.active_auth_binding_id) &&
        !authExpired &&
        captureAgentOnline(locked.last_heartbeat_at) &&
        crossDeviceRetryAgentDailyUsageEligible(locked) &&
        crossDeviceRetryAgentSupportsTask(locked, task, commandPayload);
      if (eligible && safetyHandoffPolicy) {
        const lockedAccount = await tx.queryOne(`
          SELECT binding.last_login_state, account.platform_account_id
          FROM social_account_bindings binding
          JOIN social_accounts account
            ON account.tenant_id = binding.tenant_id
            AND account.id = binding.social_account_id
          WHERE binding.tenant_id = $1
            AND binding.agent_id = $2
            AND binding.platform = $3
            AND binding.status = 'current'
          FOR SHARE OF binding, account
        `, [tenantId, locked.id, platform]);
        eligible = evaluateCaptureSafetyHandoff({
          ...safetyHandoffPolicy,
          targetPlatformAccountId: lockedAccount?.platform_account_id,
          targetLoginState: lockedAccount?.last_login_state,
        }).automaticEligible === true;
      }
      const busy = eligible
        ? await findCaptureAgentExecutionSlotBlocker(
            tx,
            tenantId,
            locked.id,
            {excludeTaskIds: [task.id]},
          )
        : {kind: 'ineligible'};
      if (!eligible || busy) {
        // Rolling back to the per-candidate savepoint releases both its row
        // lock and its transaction-level advisory lock before trying the next
        // idle browser. Locks acquired by the surrounding dispatch remain.
        await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
        continue;
      }
      await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
      return locked;
    } catch (error) {
      try {
        await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {}
      throw error;
    }
  }
  return null;
}

function promotedRetryFallbackTarget(item = {}) {
  const metadata = safeJson(item.metadata);
  const sourceRecord = safeJson(metadata.sourceRecord);
  const subscriptionId = text(
    metadata.subscriptionId || item.external_id,
    240,
  );
  if (item.item_type === 'profile_subscription') {
    return {
      itemId: item.id,
      recordId: subscriptionId,
      externalId: subscriptionId,
      subscriptionId,
      accountUrl: item.url_snapshot,
      url: item.url_snapshot,
      title: metadata.accountName || sourceRecord.title || '',
      platform: item.platform,
    };
  }
  return {
    itemId: item.id,
    recordId: item.record_id || item.external_id,
    externalId: item.external_id,
    url: item.url_snapshot,
    title: sourceRecord.title || '',
    publishedAt: sourceRecord.publishedAt || '',
    noteType: sourceRecord.noteType || '',
    baseline: safeJson(metadata.baseline),
  };
}

async function loadPromotedRetryPayload(tx, tenantId, parent, items) {
  const executionTaskIds = Array.from(new Set([
    parent.id,
    ...items.map(item => text(item.execution_task_id, 100)).filter(Boolean),
  ]));
  const commands = await tx.queryAll(`
    SELECT task_id, payload
    FROM capture_agent_commands
    WHERE tenant_id = $1
      AND task_id = ANY($2::uuid[])
      AND command_type = 'create'
    ORDER BY created_at DESC, id DESC
  `, [tenantId, executionTaskIds]);
  const targetByItemId = new Map();
  for (const command of commands) {
    const payload = safeJson(command.payload);
    const targets = Array.isArray(payload.targets)
      ? payload.targets
      : Array.isArray(payload.items)
        ? payload.items
        : [];
    for (const target of targets) {
      const itemId = text(target?.itemId || target?.item_id, 100).toLowerCase();
      if (UUID_PATTERN.test(itemId) && !targetByItemId.has(itemId)) {
        targetByItemId.set(itemId, sanitizeCloudStructuredObject(target));
      }
    }
  }
  return {
    basePayload: safeJson(commands[0]?.payload),
    targets: items.map(item => ({
      ...promotedRetryFallbackTarget(item),
      ...safeJson(targetByItemId.get(String(item.id))),
      itemId: item.id,
    })),
  };
}

async function renewProfileRetryExecutions(tx, tenantId, items, targets) {
  const executionIdByItem = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.item_type !== 'profile_subscription') continue;
    const metadata = safeJson(item.metadata);
    const subscriptionId = text(
      metadata.subscriptionId || item.external_id,
      100,
    ).toLowerCase();
    if (!UUID_PATTERN.test(subscriptionId)) {
      return {error: 'retry_profile_subscription_invalid'};
    }
    const subscriptionSnapshot = await tx.queryOne(`
      SELECT id, status
      FROM monitor_subscriptions
      WHERE id = $1 AND tenant_id = $2
    `, [subscriptionId, tenantId]);
    if (!subscriptionSnapshot || subscriptionSnapshot.status !== 'active') {
      return {error: 'retry_profile_subscription_unavailable'};
    }
    // Profile dispatchers do not all acquire subscription/execution rows in
    // the same order. Never wait while crossing that boundary: claim the
    // previous execution first with SKIP LOCKED, then claim the subscription
    // the same way. A competing manual/scheduled dispatch makes this recovery
    // roll back and retry later instead of forming a lock cycle.
    const previousExecutionId = text(metadata.monitorExecutionId, 100);
    if (UUID_PATTERN.test(previousExecutionId)) {
      const previousExecutionExists = await tx.queryOne(`
        SELECT id
        FROM monitor_executions
        WHERE id = $1 AND tenant_id = $2
      `, [previousExecutionId, tenantId]);
      if (previousExecutionExists) {
        const previousExecution = await tx.queryOne(`
          SELECT id, status
          FROM monitor_executions
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE SKIP LOCKED
        `, [previousExecutionId, tenantId]);
        if (!previousExecution) {
          return {error: 'retry_profile_execution_busy'};
        }
        if (['pending', 'running'].includes(previousExecution.status)) {
          await tx.execute(`
            UPDATE monitor_executions
            SET status = 'failed',
              error_message =
                '原设备任务已结束，未完成账号已转交其他设备重试',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
            WHERE id = $1 AND tenant_id = $2
              AND status IN ('pending', 'running')
          `, [previousExecutionId, tenantId]);
        }
      }
    }
    const subscription = await tx.queryOne(`
      SELECT id, status
      FROM monitor_subscriptions
      WHERE id = $1 AND tenant_id = $2
      FOR SHARE SKIP LOCKED
    `, [subscriptionId, tenantId]);
    if (!subscription) {
      return {error: 'retry_profile_subscription_busy'};
    }
    if (subscription.status !== 'active') {
      return {error: 'retry_profile_subscription_unavailable'};
    }
    const execution = await tx.queryOne(`
      INSERT INTO monitor_executions (tenant_id, subscription_id, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (subscription_id)
        WHERE status IN ('pending', 'running')
      DO NOTHING
      RETURNING id
    `, [tenantId, subscriptionId]);
    if (!execution) return {error: 'retry_profile_execution_busy'};
    executionIdByItem.set(String(item.id), execution.id);
    targets[index] = {
      ...targets[index],
      subscriptionId,
      recordId: subscriptionId,
      externalId: subscriptionId,
      executionId: execution.id,
    };
  }
  return {executionIdByItem};
}

async function loadVerifiedCaptureLocalClosureProof(tx, {
  tenantId,
  executionTaskId,
  sourceAgentId,
  itemId,
  itemAttemptId,
  itemAttemptNumber,
  assignmentRevision,
} = {}) {
  const expected = {
    tenantId: text(tenantId, 100).toLowerCase(),
    executionTaskId: text(executionTaskId, 100).toLowerCase(),
    sourceAgentId: text(sourceAgentId, 100).toLowerCase(),
    itemId: text(itemId, 100).toLowerCase(),
    itemAttemptId: text(itemAttemptId, 100).toLowerCase(),
    itemAttemptNumber: Number(itemAttemptNumber),
    assignmentRevision: Number(assignmentRevision),
  };
  if (
    !UUID_PATTERN.test(expected.tenantId) ||
    !UUID_PATTERN.test(expected.executionTaskId) ||
    !UUID_PATTERN.test(expected.sourceAgentId) ||
    !UUID_PATTERN.test(expected.itemId) ||
    !UUID_PATTERN.test(expected.itemAttemptId) ||
    !Number.isSafeInteger(expected.itemAttemptNumber) ||
    expected.itemAttemptNumber < 1 ||
    !Number.isSafeInteger(expected.assignmentRevision) ||
    expected.assignmentRevision < 0
  ) {
    return verifyCaptureLocalClosureProof();
  }
  const snapshot = await tx.queryOne(`
    SELECT snapshot.metadata->'localClosure' AS local_closure,
      snapshot.metadata->'localClosures' AS local_closures,
      snapshot.agent_id, snapshot.client_task_id,
      snapshot.client_attempt_id, snapshot.attempt_number,
      snapshot.progress_seq, snapshot.status, snapshot.received_at,
      clock_timestamp() AS proof_now
    FROM capture_task_snapshots snapshot
    JOIN capture_tasks execution_task
      ON execution_task.tenant_id = snapshot.tenant_id
      AND execution_task.id = snapshot.task_id
    JOIN capture_task_attempts execution_attempt
      ON execution_attempt.tenant_id = snapshot.tenant_id
      AND execution_attempt.id = snapshot.attempt_id
      AND execution_attempt.task_id = snapshot.task_id
      AND execution_attempt.agent_id = snapshot.agent_id
      AND execution_attempt.client_attempt_id = snapshot.client_attempt_id
      AND execution_attempt.attempt_number = snapshot.attempt_number
    WHERE snapshot.tenant_id = $1::uuid
      AND snapshot.task_id = $2::uuid
      AND snapshot.agent_id = $3::uuid
      AND snapshot.client_task_id = execution_task.client_task_id
      AND snapshot.client_attempt_id <> ''
      AND snapshot.status IN (
        'completed', 'completed_with_warnings',
        'completed_with_failures', 'failed',
        'canceled', 'skipped', 'needs_action'
      )
    ORDER BY snapshot.progress_seq DESC,
      snapshot.source_updated_at DESC, snapshot.id DESC
    LIMIT 1
  `, [
    expected.tenantId,
    expected.executionTaskId,
    expected.sourceAgentId,
  ]);
  const evidence = selectCaptureLocalClosureEvidence({
    evidence: snapshot?.local_closure,
    evidences: snapshot?.local_closures,
    expectedItemId: expected.itemId,
    expectedItemAttemptId: expected.itemAttemptId,
  });
  return verifyCaptureLocalClosureProof({
    evidence,
    expectedRequestId: snapshot?.client_task_id,
    expectedAttemptId: snapshot?.client_attempt_id,
    expectedItemId: expected.itemId,
    expectedItemAttemptId: expected.itemAttemptId,
    expectedAttemptNumber: expected.itemAttemptNumber,
    expectedAssignmentRevision: expected.assignmentRevision,
    expectedSnapshotRevision: snapshot?.progress_seq,
    expectedAgentId: expected.sourceAgentId,
    snapshotAgentId: snapshot?.agent_id,
    snapshotStatus: snapshot?.status,
    snapshotReceivedAt: snapshot?.received_at,
    now: snapshot?.proof_now || new Date(),
  });
}

export async function dispatchCrossDeviceRetry(options = {}) {
  const {
    tenantId,
    taskId,
    requestKey,
    expectedRevision,
    actorType = 'system',
    requestedByUserId = '',
    requestedByName = '自动调度中心',
    automatic = false,
    recoveryPhase = 'fast',
    itemIds = null,
    dutyRecoveryIntentId = '',
    dutyRecoveryLeaseToken = '',
    dutyRecoveryGeneration = 0,
    expectedItemRevision,
    expectedSourceAttemptId,
    expectedAttemptNumber,
    allowPreviouslyAttemptedAgents = false,
    safetyHandoff = null,
  } = options;
  if (!['fast', 'duty'].includes(recoveryPhase)) {
    return {error: 'invalid_recovery_phase'};
  }
  const dutyRecovery = recoveryPhase === 'duty';
  const safetyHandoffRequested = safetyHandoff !== null &&
    safetyHandoff !== undefined;
  const safetyHandoffRequest = safeJson(safetyHandoff);
  const requestedItemIds = Array.isArray(itemIds)
    ? Array.from(new Set(
        itemIds
          .map(value => text(value, 100).toLowerCase())
          .filter(Boolean),
      ))
    : [];
  const itemScopeProvided = itemIds !== null && itemIds !== undefined;
  if (
    itemScopeProvided &&
    (
      !Array.isArray(itemIds) ||
      requestedItemIds.length !== itemIds.length ||
      requestedItemIds.some(value => !UUID_PATTERN.test(value))
    )
  ) {
    return {error: 'invalid_retry_item_scope'};
  }
  if (
    dutyRecovery &&
    (
      automatic !== true ||
      requestedItemIds.length !== 1 ||
      !UUID_PATTERN.test(text(tenantId, 100).toLowerCase()) ||
      !UUID_PATTERN.test(text(taskId, 100).toLowerCase()) ||
      !UUID_PATTERN.test(text(requestKey, 100).toLowerCase()) ||
      !UUID_PATTERN.test(text(dutyRecoveryIntentId, 100).toLowerCase()) ||
      !UUID_PATTERN.test(text(dutyRecoveryLeaseToken, 100).toLowerCase()) ||
      text(dutyRecoveryIntentId, 100).toLowerCase() !==
        text(requestKey, 100).toLowerCase() ||
      !Number.isSafeInteger(Number(dutyRecoveryGeneration)) ||
      Number(dutyRecoveryGeneration) < 1 ||
      Number(dutyRecoveryGeneration) > 3 ||
      !Number.isSafeInteger(Number(expectedRevision)) ||
      Number(expectedRevision) < 0 ||
      !Number.isSafeInteger(Number(expectedItemRevision)) ||
      Number(expectedItemRevision) < 0 ||
      !Number.isSafeInteger(Number(expectedAttemptNumber)) ||
      Number(expectedAttemptNumber) < 0 ||
      typeof allowPreviouslyAttemptedAgents !== 'boolean' ||
      !(
        expectedSourceAttemptId == null ||
        text(expectedSourceAttemptId, 100) === '' ||
        UUID_PATTERN.test(text(expectedSourceAttemptId, 100).toLowerCase())
      )
    )
  ) {
    return {error: 'invalid_duty_recovery_request'};
  }
  if (!dutyRecovery && allowPreviouslyAttemptedAgents === true) {
    return {error: 'invalid_duty_recovery_request'};
  }
  if (
    safetyHandoffRequested &&
    (
      !dutyRecovery ||
      !Number.isSafeInteger(Number(safetyHandoffRequest.count)) ||
      Number(safetyHandoffRequest.count) < 0 ||
      safetyHandoffRequest.requireDistinctPlatformAccount !== true ||
      safetyHandoffRequest.requireSourceLineageQuiet !== true ||
      !text(safetyHandoffRequest.challengeCode, 100) ||
      !text(safetyHandoffRequest.sourcePlatformAccountId, 320) ||
      text(safetyHandoffRequest.sourceLoginState, 40).toLowerCase() !==
        'authenticated'
    )
  ) {
    return {error: 'invalid_duty_recovery_request'};
  }
  if (
    safetyHandoffRequested &&
    safetyHandoffRequest.sourceLocalClosureProven !== true
  ) {
    return {
      error: 'retry_requires_manual_safety_action',
      code: 'HUMAN_REQUIRED',
      humanRequired: true,
      reason: 'source_local_closure_proof_unavailable',
    };
  }
  // `sourceLocalClosureProven` is only an internal caller hint that prevents
  // an obviously incomplete request from entering the transaction. It is not
  // authority: the append-only terminal snapshot is loaded and verified
  // below, then loaded once more immediately before the first child write.
  const dutyIntentId = dutyRecovery
    ? text(dutyRecoveryIntentId, 100).toLowerCase()
    : '';
  const dutyGeneration = dutyRecovery
    ? Number(dutyRecoveryGeneration)
    : 0;
  const noIdleAgentResult = () => dutyRecovery
    ? {
        error: 'idle_compatible_agent_unavailable',
        code: 'NO_IDLE_AGENT',
        waitingForAgent: true,
      }
    : {error: 'idle_compatible_agent_unavailable'};
  const supersededResult = details => ({
    error: 'duty_recovery_source_superseded',
    code: 'RECOVERY_SOURCE_SUPERSEDED',
    superseded: true,
    ...details,
  });
  const itemAttemptEvidence = attempt => ({
    id: text(attempt?.id, 100).toLowerCase(),
    itemId: text(attempt?.item_id || attempt?.itemId, 100).toLowerCase(),
    executionTaskId: text(
      attempt?.execution_task_id || attempt?.executionTaskId,
      100,
    ).toLowerCase(),
    agentId: text(attempt?.agent_id || attempt?.agentId, 100).toLowerCase(),
    attemptNumber: Number(
      attempt?.attempt_number ?? attempt?.attemptNumber ?? 0,
    ),
    assignmentRevision: Number(
      attempt?.assignment_revision ?? attempt?.assignmentRevision ?? 0,
    ),
    status: text(attempt?.status, 80).toLowerCase(),
    requestHash: text(
      attempt?.request_hash || attempt?.requestHash,
      100,
    ).toLowerCase(),
  });
  const req = {
    tenantId,
    user: requestedByUserId ? {id: requestedByUserId} : null,
    actorName: requestedByName,
  };
  try {
    return await withTransaction(async tx => {
      let dutySafetyHandoffPolicy = null;
      await tx.execute(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        ['capture_cross_device_retry', requestKey],
      );
      const replay = await tx.queryOne(`
        SELECT id, parent_task_id, assigned_agent_id, status, metadata
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [requestKey, req.tenantId]);
      if (replay) {
        const replayMetadata = safeJson(replay.metadata);
        if (
          String(replay.parent_task_id || '') !== taskId ||
          replayMetadata.crossDeviceRetryRequestKey !== requestKey ||
          (
            dutyRecovery &&
            (
              replayMetadata.dutyRecovery !== true ||
              replayMetadata.dutyRecoveryIntentId !== dutyIntentId ||
              Number(replayMetadata.dutyRecoveryGeneration || 0) !==
                dutyGeneration ||
              !Array.isArray(replayMetadata.itemIds) ||
              replayMetadata.itemIds.length !== 1 ||
              text(replayMetadata.itemIds[0], 100).toLowerCase() !==
                requestedItemIds[0] ||
              (replayMetadata.safetyHandoff === true) !==
                safetyHandoffRequested
            )
          )
        ) {
          return {error: 'idempotency_key_conflict'};
        }
        const command = await tx.queryOne(`
          SELECT id, status, expires_at
          FROM capture_agent_commands
          WHERE tenant_id = $1 AND task_id = $2 AND command_type = 'create'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `, [req.tenantId, replay.id]);
        const itemAttempts = await tx.queryAll(`
          SELECT id, item_id, execution_task_id, agent_id,
            attempt_number, assignment_revision, status, request_hash
          FROM capture_task_item_attempts
          WHERE tenant_id = $1 AND execution_task_id = $2
            AND (
              cardinality($3::uuid[]) = 0 OR item_id = ANY($3::uuid[])
            )
          ORDER BY attempt_number, item_id, id
        `, [req.tenantId, replay.id, requestedItemIds]);
        const parent = await tx.queryOne(`
          SELECT id, status, orchestration_revision
          FROM capture_tasks
          WHERE tenant_id = $1 AND id = $2
        `, [req.tenantId, replay.parent_task_id]);
        return {
          existing: true,
          replayed: true,
          child: replay,
          command,
          agent: replay.assigned_agent_id
            ? {id: replay.assigned_agent_id}
            : null,
          parent,
          itemAttempts: itemAttempts.map(itemAttemptEvidence),
          itemCount: itemAttempts.length,
          targetAgentId: replay.assigned_agent_id || '',
          recovery: dutyRecovery
            ? {phase: 'duty', intentId: dutyIntentId, generation: dutyGeneration}
            : {phase: 'fast'},
        };
      }

      if (dutyRecovery) {
        if (!dutyRecoveryGlobalActionsEnabled()) {
          return {error: 'automatic_retry_disabled', code: 'RECOVERY_GATE_OFF'};
        }
        const recoverySettings = await tx.queryAll(`
          SELECT key, value
          FROM tenant_settings
          WHERE tenant_id = $1 AND key = ANY($2::text[])
          ORDER BY key
          FOR SHARE
        `, [req.tenantId, DUTY_RECOVERY_SETTING_KEYS]);
        const recoverySettingMap = Object.fromEntries(
          recoverySettings.map(row => [text(row.key, 120), text(row.value, 120)]),
        );
        if (
          !DUTY_RECOVERY_TRUE_VALUES.has(
            text(
              recoverySettingMap.ops_control_recovery_enabled,
              20,
            ).toLowerCase(),
          )
          || text(
            recoverySettingMap.ops_control_recovery_mode,
            20,
          ).toLowerCase() !== 'guarded'
        ) {
          return {error: 'automatic_retry_disabled', code: 'RECOVERY_GATE_OFF'};
        }
      }

      const initialTask = await tx.queryOne(`
        SELECT *
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
        ${dutyRecovery ? 'FOR UPDATE' : ''}
      `, [taskId, req.tenantId]);
      if (!initialTask) return {error: 'task_not_found'};
      if (
        dutyRecovery &&
        (
          ['canceled', 'skipped', 'superseded'].includes(initialTask.status) ||
          isExplicitUserCancellationSnapshot(initialTask, {
            status: initialTask.status,
            error: initialTask.error,
            metadata: initialTask.metadata,
          })
        )
      ) {
        return {
          error: 'retry_items_not_automatically_recoverable',
          code: 'SOURCE_STOPPED_BY_USER',
          stoppedByUser: true,
        };
      }
      if (dutyRecovery) {
        // Lock order is task -> intent everywhere (including the user-stop
        // trigger). The dispatcher also proves it is acting under the live
        // worker claim instead of trusting an internal caller's boolean.
        const durableIntent = await tx.queryOne(`
          SELECT id, parent_task_id, item_id, generation, created_at,
            status, action_count, recovery_task_id, dispatched_attempt_id,
            safety_handoff_count, source_lineage_silent,
            lease_token, lease_expires_at, available_at, window_ends_at,
            CASE
              WHEN verification->>'reuseEligibleAt' ~
                '^\\d{4}-\\d{2}-\\d{2}T'
              THEN (verification->>'reuseEligibleAt')::timestamptz
              ELSE created_at + interval '10 minutes'
            END AS reuse_eligible_at
          FROM capture_recovery_intents
          WHERE id = $1::uuid
            AND tenant_id = $2
            AND parent_task_id = $3::uuid
            AND item_id = $4::uuid
            AND generation = $5::integer
          FOR UPDATE
        `, [
          dutyIntentId,
          req.tenantId,
          taskId,
          requestedItemIds[0],
          dutyGeneration,
        ]);
        const actionClock = durableIntent ? await tx.queryOne(`
          WITH action_clock AS (
            SELECT clock_timestamp() AS action_time
          )
          SELECT action_time,
            $1::timestamptz > action_time AS lease_valid,
            $2::timestamptz <= action_time AS intent_due,
            $3::timestamptz > action_time AS window_open,
            $4::timestamptz <= action_time AS reuse_due
          FROM action_clock
        `, [
          durableIntent.lease_expires_at,
          durableIntent.available_at,
          durableIntent.window_ends_at,
          durableIntent.reuse_eligible_at,
        ]) : null;
        const durableLeaseMatches = Boolean(
          durableIntent
          && text(durableIntent.lease_token, 100).toLowerCase() ===
            text(dutyRecoveryLeaseToken, 100).toLowerCase()
        );
        if (durableIntent && actionClock?.window_open !== true) {
          return {
            error: 'recovery_window_ended',
            code: 'RECOVERY_WINDOW_ENDED',
          };
        }
        if (durableLeaseMatches && actionClock?.lease_valid !== true) {
          return {
            error: 'duty_recovery_lease_expired',
            code: 'RECOVERY_LEASE_EXPIRED',
          };
        }
        if (durableLeaseMatches && actionClock?.intent_due !== true) {
          return {
            error: 'duty_recovery_not_due',
            code: 'RECOVERY_INTENT_NOT_DUE',
          };
        }
        if (
          !durableIntent
          || !durableLeaseMatches
          || Number(durableIntent.action_count || 0) !== 0
          || durableIntent.recovery_task_id
          || durableIntent.dispatched_attempt_id
          || (
            safetyHandoffRequested &&
            (
              Number(durableIntent.safety_handoff_count || 0) !== 0 ||
              durableIntent.source_lineage_silent !== false
            )
          )
          || (
            !safetyHandoffRequested &&
            durableIntent.source_lineage_silent === true
          )
          || !['ready', 'waiting_due', 'waiting_agent'].includes(
            text(durableIntent.status, 80).toLowerCase(),
          )
        ) {
          return {error: 'invalid_duty_recovery_request'};
        }
        if (
          allowPreviouslyAttemptedAgents
          && actionClock.reuse_due !== true
        ) {
          return {
            error: 'duty_recovery_agent_reuse_not_due',
            code: 'AGENT_REUSE_BACKOFF_ACTIVE',
          };
        }
      }
      const initialPlanSnapshot = safeJson(
        safeJson(initialTask.metadata).planSnapshot,
      );
      if (
        automatic &&
        (
          safeJson(initialTask.metadata).automaticRetryDisabled === true ||
          safeJson(initialPlanSnapshot.recoveryPolicy)
            .allowIdleAgentHandoff === false
        )
      ) {
        return {error: 'automatic_retry_disabled'};
      }
      if (!crossDeviceRetryTaskSupported(initialTask)) {
        return {error: 'task_cross_device_retry_unsupported'};
      }
      if (!crossDeviceRetrySourceReady(initialTask, {
        automatic,
        dutyRecovery,
      })) {
        return {error: 'task_not_settled_for_retry'};
      }
      if (Number(initialTask.orchestration_revision || 0) !== expectedRevision) {
        return {
          error: 'revision_conflict',
          currentRevision: Number(initialTask.orchestration_revision || 0),
        };
      }
      if (dutyRecovery) {
        const sourceItem = await tx.queryOne(`
          SELECT *
          FROM capture_task_items
          WHERE id = $1 AND tenant_id = $2 AND task_id = $3
          FOR UPDATE
        `, [requestedItemIds[0], req.tenantId, initialTask.id]);
        if (!sourceItem) {
          return supersededResult({reason: 'item_scope_changed'});
        }
        const currentSourceAttempt = await tx.queryOne(`
          SELECT id, item_id, agent_id, attempt_number, assignment_revision,
            status, checkpoint, error
          FROM capture_task_item_attempts
          WHERE tenant_id = $1 AND item_id = $2
          ORDER BY attempt_number DESC, created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE
        `, [req.tenantId, sourceItem.id]);
        const currentSourceAttemptId = text(
          currentSourceAttempt?.id,
          100,
        ).toLowerCase();
        const normalizedExpectedSourceAttemptId = text(
          expectedSourceAttemptId,
          100,
        ).toLowerCase();
        if (
          Number(sourceItem.assignment_revision || 0) !==
            Number(expectedItemRevision) ||
          currentSourceAttemptId !== normalizedExpectedSourceAttemptId ||
          Number(
            currentSourceAttempt?.attempt_number ?? sourceItem.attempt_count ?? 0,
          ) !== Number(expectedAttemptNumber)
        ) {
          return supersededResult({
            reason: 'source_attempt_changed',
            currentItemRevision: Number(sourceItem.assignment_revision || 0),
            currentSourceAttemptId,
            currentAttemptNumber: Number(
              currentSourceAttempt?.attempt_number ??
                sourceItem.attempt_count ??
                0,
            ),
          });
        }
        const sourceDisposition = classifyCaptureRecoveryDisposition(
          {
            ...sourceItem,
            error: {
              ...safeJson(sourceItem.error),
              ...safeJson(currentSourceAttempt?.error),
            },
            metadata: {
              ...safeJson(sourceItem.metadata),
              checkpoint: {
                ...safeJson(safeJson(sourceItem.metadata).checkpoint),
                ...safeJson(currentSourceAttempt?.checkpoint),
              },
            },
          },
          {phase: 'duty'},
        );
        if (safetyHandoffRequested) {
          const sourceAccount = await tx.queryOne(`
            SELECT binding.last_login_state, account.platform_account_id
            FROM social_account_bindings binding
            JOIN social_accounts account
              ON account.tenant_id = binding.tenant_id
              AND account.id = binding.social_account_id
            WHERE binding.tenant_id = $1
              AND binding.agent_id = $2
              AND binding.platform = $3
              AND binding.status = 'current'
            FOR SHARE OF binding, account
          `, [
            req.tenantId,
            currentSourceAttempt?.agent_id || sourceItem.assigned_agent_id,
            text(sourceItem.platform || initialTask.platform, 40).toLowerCase(),
          ]);
          const mergedError = {
            ...safeJson(sourceItem.error),
            ...safeJson(currentSourceAttempt?.error),
          };
          const mergedCheckpoint = {
            ...safeJson(safeJson(sourceItem.metadata).checkpoint),
            ...safeJson(currentSourceAttempt?.checkpoint),
          };
          const challengeCode = text(
            mergedError.code ||
              mergedCheckpoint.errorCode ||
              mergedCheckpoint.error_code,
            100,
          ).toUpperCase();
          if (
            Number(safetyHandoffRequest.count) !==
              Number(sourceItem.safety_handoff_count || 0) ||
            text(
              safetyHandoffRequest.sourcePlatformAccountId,
              320,
            ).toLowerCase() !== text(
              sourceAccount?.platform_account_id,
              320,
            ).toLowerCase() ||
            text(safetyHandoffRequest.challengeCode, 100).toUpperCase() !==
              challengeCode
          ) {
            return supersededResult({reason: 'safety_handoff_source_changed'});
          }
          const sourceAgentId = text(
            currentSourceAttempt?.agent_id || sourceItem.assigned_agent_id,
            100,
          ).toLowerCase();
          const localClosureProof = await loadVerifiedCaptureLocalClosureProof(
            tx,
            {
              tenantId: req.tenantId,
              executionTaskId: sourceItem.execution_task_id,
              sourceAgentId,
              itemId: sourceItem.id,
              itemAttemptId: currentSourceAttemptId,
              itemAttemptNumber:
                currentSourceAttempt?.attempt_number ?? sourceItem.attempt_count,
              assignmentRevision: sourceItem.assignment_revision,
            },
          );
          const safetyDecision = evaluateCaptureSafetyHandoff({
            faultClass: 'platform_safety',
            challengeCode,
            platform: sourceItem.platform || initialTask.platform,
            businessTaskType: promotedRetryBusinessTaskType(initialTask),
            itemType: sourceItem.item_type,
            safetyHandoffCount: sourceItem.safety_handoff_count,
            sourcePlatformAccountId: sourceAccount?.platform_account_id,
            sourceLoginState: sourceAccount?.last_login_state,
            sourceLocalClosureProven: localClosureProof.proven === true,
          });
          if (!safetyDecision.automaticEligible) {
            return {
              error: 'retry_requires_manual_safety_action',
              code: 'HUMAN_REQUIRED',
              humanRequired: true,
              reason: safetyDecision.reason,
            };
          }
          dutySafetyHandoffPolicy = {
            faultClass: 'platform_safety',
            challengeCode,
            platform: sourceItem.platform || initialTask.platform,
            businessTaskType: promotedRetryBusinessTaskType(initialTask),
            itemType: sourceItem.item_type,
            safetyHandoffCount: sourceItem.safety_handoff_count,
            sourcePlatformAccountId: sourceAccount.platform_account_id,
            sourceLoginState: sourceAccount.last_login_state,
            sourceLocalClosureProven: true,
            sourceExecutionTaskId: sourceItem.execution_task_id,
            sourceAgentId,
            sourceItemId: sourceItem.id,
            sourceItemAttemptId: currentSourceAttemptId,
            sourceItemAttemptNumber: Number(
              currentSourceAttempt?.attempt_number ?? sourceItem.attempt_count,
            ),
            sourceAssignmentRevision: Number(
              sourceItem.assignment_revision,
            ),
          };
        } else if (!sourceDisposition.automatic) {
          if (sourceDisposition.kind === 'manual_current') {
            return {
              error: 'retry_requires_manual_safety_action',
              code: 'HUMAN_REQUIRED',
              humanRequired: true,
            };
          }
          return {
            error: 'retry_items_not_automatically_recoverable',
            code: sourceDisposition.kind === 'terminal_business_failure'
              ? 'TERMINAL_BUSINESS_FAILURE'
              : 'ITEM_NOT_RECOVERABLE',
          };
        }
      }
      await expireStaleCommands(tx, req.tenantId, initialTask.id);

      const sourceCommand = await tx.queryOne(`
        SELECT payload
        FROM capture_agent_commands
        WHERE tenant_id = $1 AND task_id = $2 AND command_type = 'create'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [req.tenantId, initialTask.id]);
      let targetAgent = null;

      const task = await tx.queryOne(`
        SELECT *
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [taskId, req.tenantId]);
      if (!task) return {error: 'task_not_found'};
      if (
        !crossDeviceRetryTaskSupported(task) ||
        !crossDeviceRetrySourceReady(task, {automatic, dutyRecovery})
      ) {
        return {error: 'task_not_settled_for_retry'};
      }
      if (Number(task.orchestration_revision || 0) !== expectedRevision) {
        return {
          error: 'revision_conflict',
          currentRevision: Number(task.orchestration_revision || 0),
        };
      }
      const promoted = await promoteSingleNodeTaskForRetry(tx, task);
      if (promoted.error) abortCrossDeviceRetry(promoted.error);
      const parent = promoted.parent;
      const businessTaskType = promoted.businessTaskType;

      const items = await tx.queryAll(`
        SELECT *
        FROM capture_task_items
        WHERE tenant_id = $1 AND task_id = $2
          AND status = ANY($3::text[])
        ORDER BY ordinal, id
        FOR UPDATE
      `, [
        req.tenantId,
        parent.id,
        [...CROSS_DEVICE_RETRY_ITEM_STATUSES],
      ]);
      const scopedItems = itemScopeProvided
        ? items.filter(item => requestedItemIds.includes(
            text(item.id, 100).toLowerCase(),
          ))
        : items;
      if (
        itemScopeProvided &&
        scopedItems.length !== requestedItemIds.length
      ) {
        if (dutyRecovery) {
          abortCrossDeviceRetry('duty_recovery_source_superseded', {
            code: 'RECOVERY_SOURCE_SUPERSEDED',
            reason: 'item_scope_changed',
          });
        }
        abortCrossDeviceRetry('retry_items_unavailable');
      }
      let retryItems = scopedItems.filter(
        item => (dutySafetyHandoffPolicy
          ? text(item.id, 100).toLowerCase() === requestedItemIds[0]
          : dutyRecovery
          ? classifyCaptureRecoveryDisposition(item, {phase: 'duty'}).automatic
          : classifyCaptureRecoveryDisposition(item).automatic),
      );
      let sourceExecutionPending = false;
      if (automatic && retryItems.length > 0) {
        const executionTaskIds = Array.from(new Set(
          retryItems
            .map(item => text(item.execution_task_id, 100))
            .filter(Boolean),
        ));
        const sourceStates = executionTaskIds.length > 0
          ? await tx.queryAll(`
              SELECT id, status
              FROM capture_tasks
              WHERE tenant_id = $1 AND id = ANY($2::uuid[])
            `, [req.tenantId, executionTaskIds])
          : [];
        const sourceStatusById = new Map(
          sourceStates.map(source => [String(source.id), source.status]),
        );
        retryItems = retryItems
          .filter(item => {
            const executionTaskId = text(item.execution_task_id, 100);
            const sourceSettled = !executionTaskId ||
              CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES.has(
                sourceStatusById.get(executionTaskId),
              );
            if (!sourceSettled) sourceExecutionPending = true;
            return sourceSettled;
          })
          .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
          .slice(0, 1);
      }
      if (retryItems.length === 0) {
        if (dutyRecovery && sourceExecutionPending) {
          abortCrossDeviceRetry('duty_recovery_source_execution_active', {
            code: 'SOURCE_EXECUTION_ACTIVE',
            waitingForSource: true,
          });
        }
        const hasManualSafetyItem = scopedItems.some(item =>
          (dutyRecovery
            ? classifyCaptureRecoveryDisposition(item, {phase: 'duty'})
            : classifyCaptureRecoveryDisposition(item)).kind ===
              'manual_current',
        );
        abortCrossDeviceRetry(
          hasManualSafetyItem
            ? 'retry_requires_manual_safety_action'
            : scopedItems.length > 0
              ? 'retry_items_not_automatically_recoverable'
              : 'retry_items_unavailable',
        );
      }
      if (
        businessTaskType === 'unattended_keyword_capture' &&
        retryItems.length > 30
      ) {
        abortCrossDeviceRetry('retry_item_capacity_exceeded');
      }
      const sourceExecutionTaskIds = Array.from(new Set(
        retryItems
          .map(item => text(item.execution_task_id, 100))
          .filter(Boolean),
      ));
      const activeSource = await tx.queryOne(`
        SELECT id, status
        FROM capture_tasks
        WHERE tenant_id = $1
          AND id = ANY($2::uuid[])
          AND status <> ALL($3::text[])
        ORDER BY id
        LIMIT 1
      `, [
        req.tenantId,
        sourceExecutionTaskIds,
        [...CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES],
      ]);
      if (activeSource) {
        abortCrossDeviceRetry(
          dutyRecovery
            ? 'duty_recovery_source_execution_active'
            : 'retry_source_execution_active',
          dutyRecovery
            ? {code: 'SOURCE_EXECUTION_ACTIVE', waitingForSource: true}
            : {},
        );
      }
      const activeSourceCommand = await tx.queryOne(`
        SELECT id
        FROM capture_agent_commands
        WHERE tenant_id = $1
          AND task_id = ANY($2::uuid[])
          AND status IN ('pending', 'acknowledged')
        ORDER BY created_at, id
        LIMIT 1
      `, [req.tenantId, [parent.id, ...sourceExecutionTaskIds]]);
      if (activeSourceCommand) {
        abortCrossDeviceRetry(
          dutyRecovery
            ? 'duty_recovery_source_command_active'
            : 'retry_source_command_active',
          dutyRecovery
            ? {code: 'SOURCE_COMMAND_ACTIVE', waitingForSource: true}
            : {},
        );
      }

      // Finish profile authorization and execution-lineage preparation before
      // acquiring an Agent slot. If no compatible Agent remains, the explicit
      // transaction abort below rolls these writes back.
      const payloadContract = await loadPromotedRetryPayload(
        tx,
        req.tenantId,
        parent,
        retryItems,
      );
      const renewedExecutions = await renewProfileRetryExecutions(
        tx,
        req.tenantId,
        retryItems,
        payloadContract.targets,
      );
      if (renewedExecutions.error) {
        abortCrossDeviceRetry(renewedExecutions.error);
      }

      // The source create command predates this recovery and therefore does
      // not carry the duty marker. Add a capability-only marker before Agent
      // selection so a 0.3.92 browser (or any client without exact item
      // attempt/request-hash lineage and remote stop) can never win the slot.
      const agentCompatibilityPayload = dutyRecovery
        ? {
            ...safeJson(sourceCommand?.payload),
            dutyRecovery: {intentId: dutyIntentId, protocolVersion: 1},
          }
        : safeJson(sourceCommand?.payload);

      if (!targetAgent) {
        const attemptedAgents = await tx.queryAll(`
          SELECT item_id, agent_id, status, checkpoint, error
          FROM capture_task_item_attempts
          WHERE tenant_id = $1
            AND item_id = ANY($2::uuid[])
            AND agent_id IS NOT NULL
        `, [req.tenantId, retryItems.map(item => item.id)]);
        targetAgent = await loadIdleCrossDeviceRetryAgent(tx, {
          tenantId: req.tenantId,
          task: parent,
          sourceAgentIds: crossDeviceRetrySourceAgentIdsForItems(
            retryItems,
            attemptedAgents,
          ),
          commandPayload: agentCompatibilityPayload,
          safetyHandoffPolicy: dutySafetyHandoffPolicy,
        });
        if (!targetAgent && dutyRecovery && allowPreviouslyAttemptedAgents) {
          targetAgent = await loadIdleCrossDeviceRetryAgent(tx, {
            tenantId: req.tenantId,
            task: parent,
            sourceAgentIds: crossDeviceRetrySafetyAgentIdsForItems(
              retryItems,
              attemptedAgents,
            ),
            commandPayload: agentCompatibilityPayload,
            safetyHandoffPolicy: dutySafetyHandoffPolicy,
          });
        }
        if (!targetAgent) {
          abortCrossDeviceRetry('idle_compatible_agent_unavailable', {
            code: 'NO_IDLE_AGENT',
            waitingForAgent: dutyRecovery,
          });
        }
      }

      const nextRevision = Number(parent.orchestration_revision || 0) + 1;
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({
        action: 'cross_device_retry',
        parentTaskId: parent.id,
        requestKey,
        expectedRevision,
        targetAgentId: targetAgent.id,
        itemIds: retryItems.map(item => item.id).sort(),
        recoveryPhase: dutyRecovery ? 'duty' : 'fast',
        dutyRecoveryIntentId: dutyIntentId,
        dutyRecoveryGeneration: dutyGeneration,
        safetyHandoff: Boolean(dutySafetyHandoffPolicy),
      })).digest('hex');
      const commandId = crypto.randomUUID();

      let commandPayload;
      let childPlan = {};
      let sequentialResumeCheckpoint = null;
      if (businessTaskType === 'unattended_keyword_capture') {
        const planSnapshot = safeJson(safeJson(parent.metadata).planSnapshot);
        if (retryItems.length === 1) {
          sequentialResumeCheckpoint = buildSequentialSearchResumeCheckpoint({
            planSnapshot,
            itemMetadata: retryItems[0].metadata,
            keyword: retryItems[0].keyword,
          });
        }
        const normalized = normalizeRemoteTaskInput({
          clientTaskId: requestKey,
          title: `${parent.title} · 换设备重试`,
          executionMode: 'one_time',
          planSnapshot: {
            ...planSnapshot,
            enabled: true,
            autoLoop: false,
            maxRounds: 1,
            roundGapMin: 0,
            platform: parent.platform,
            keywords: retryItems.map(item => item.keyword),
          },
        });
        childPlan = normalized.planSnapshot;
        commandPayload = {
          taskId: requestKey,
          clientTaskId: requestKey,
          title: normalized.title,
          executionMode: 'one_time',
          platform: childPlan.platform,
          planSnapshot: childPlan,
          ...(sequentialResumeCheckpoint
            ? {checkpoint: sequentialResumeCheckpoint}
            : {}),
          requestHash,
          authCodeId: targetAgent.auth_code_id,
          authBindingId: targetAgent.auth_binding_id,
          orchestration: {
            parentTaskId: parent.id,
            revision: nextRevision,
            itemIds: retryItems.map(item => item.id),
            sourceExecutionTaskIds,
          },
        };
      } else {
        commandPayload = {
          ...payloadContract.basePayload,
          taskId: requestKey,
          clientTaskId: requestKey,
          parentTaskId: parent.id,
          title: `${parent.title} · 换设备重试`,
          executionMode: 'one_time',
          platform: parent.platform,
          workflow: businessTaskType,
          taskKind: businessTaskType,
          targets: payloadContract.targets,
          items: payloadContract.targets,
          requestHash,
          authCodeId: targetAgent.auth_code_id,
          authBindingId: targetAgent.auth_binding_id,
        };
      }
      if (dutyRecovery) {
        commandPayload.dutyRecovery = {
          intentId: dutyIntentId,
          generation: dutyGeneration,
          itemId: retryItems[0].id,
          sourceAttemptId: text(expectedSourceAttemptId, 100).toLowerCase(),
          sourceAssignmentRevision: Number(expectedItemRevision),
          sourceAttemptNumber: Number(expectedAttemptNumber),
        };
      }
      const childMetadata = {
        ...safeJson(parent.metadata),
        promotedRetryParent: false,
        promotedBusinessTaskType: businessTaskType,
        workflow: businessTaskType,
        orchestrationChild: true,
        parentTaskId: parent.id,
        orchestrationRevision: nextRevision,
        remoteCreated: true,
        remoteRequestHash: requestHash,
        createCommandId: commandId,
        executionMode: 'one_time',
        ...(Object.keys(childPlan).length > 0 ? {planSnapshot: childPlan} : {}),
        itemIds: retryItems.map(item => item.id),
        crossDeviceRetry: true,
        crossDeviceRetryRequestKey: requestKey,
        crossDeviceRetrySourceExecutionTaskIds: sourceExecutionTaskIds,
        automaticRecovery: automatic,
        ...(dutyRecovery
          ? {
              dutyRecovery: true,
              dutyRecoveryIntentId: dutyIntentId,
              dutyRecoveryGeneration: dutyGeneration,
              dutyRecoverySourceItemId: retryItems[0].id,
              dutyRecoverySourceAttemptId:
                text(expectedSourceAttemptId, 100).toLowerCase(),
              dutyRecoverySourceAssignmentRevision:
                Number(expectedItemRevision),
              dutyRecoverySourceAttemptNumber: Number(expectedAttemptNumber),
            }
          : {}),
        ...(sequentialResumeCheckpoint
          ? {
              resumedSequentialSearch: true,
              resumeRound: sequentialResumeCheckpoint.round,
            }
          : {}),
        requestedByUserId: req.user?.id || '',
        requestedByName: text(req.actorName, 240),
      };
      if (dutyRecovery) {
        // Everything that can wait on another row/advisory lock has completed.
        // Re-check authority with PostgreSQL's wall clock immediately before
        // the first child/command write; aborting rolls back profile-renewal
        // preparation performed earlier in this transaction.
        const finalAgent = await tx.queryOne(`
          SELECT ca.*, tenant.status AS tenant_status,
            ac.status AS auth_code_status,
            ac.expires_at AS auth_code_expires_at,
            binding.id AS active_auth_binding_id,
            ca.last_heartbeat_at >= clock_timestamp() - interval '2 minutes'
              AS heartbeat_fresh,
            (
              ac.expires_at IS NULL OR ac.expires_at > clock_timestamp()
            ) AS auth_not_expired,
            NOT EXISTS (
              SELECT 1
              FROM capture_tasks blocking_task
              WHERE blocking_task.tenant_id = ca.tenant_id
                AND COALESCE(
                  blocking_task.assigned_agent_id,
                  blocking_task.origin_agent_id
                ) = ca.id
                AND blocking_task.id <> ALL($3::uuid[])
                AND blocking_task.task_type <> 'capture_orchestration'
                AND blocking_task.status = ANY($4::text[])
            ) AND NOT EXISTS (
              SELECT 1
              FROM capture_agent_commands blocking_command
              WHERE blocking_command.tenant_id = ca.tenant_id
                AND blocking_command.agent_id = ca.id
                AND blocking_command.task_id <> ALL($3::uuid[])
                AND blocking_command.status IN ('pending', 'acknowledged')
                AND (
                  blocking_command.expires_at IS NULL
                  OR blocking_command.expires_at > clock_timestamp()
                )
            ) AS slot_clear
          FROM capture_agents ca
          JOIN tenants tenant ON tenant.id = ca.tenant_id
          JOIN auth_codes ac
            ON ac.id = ca.auth_code_id AND ac.tenant_id = ca.tenant_id
          JOIN auth_bindings binding
            ON binding.id = ca.auth_binding_id AND binding.code_id = ac.id
          WHERE ca.id = $1::uuid AND ca.tenant_id = $2
          FOR SHARE OF ca, tenant, ac, binding
        `, [
          targetAgent.id,
          req.tenantId,
          [parent.id, ...sourceExecutionTaskIds],
          CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
        ]);
        if (
          !finalAgent
          || finalAgent.status !== 'active'
          || finalAgent.tenant_status !== 'active'
          || finalAgent.auth_code_status !== 'active'
          || finalAgent.heartbeat_fresh !== true
          || finalAgent.auth_not_expired !== true
          || finalAgent.slot_clear !== true
          || !crossDeviceRetryAgentSupportsTask(
            finalAgent,
            parent,
            commandPayload,
          )
        ) {
          abortCrossDeviceRetry('idle_compatible_agent_unavailable', {
            code: 'RECOVERY_AGENT_NO_LONGER_USABLE',
          });
        }
        if (dutySafetyHandoffPolicy) {
          const finalTargetAccount = await tx.queryOne(`
            SELECT binding.last_login_state, account.platform_account_id
            FROM social_account_bindings binding
            JOIN social_accounts account
              ON account.tenant_id = binding.tenant_id
              AND account.id = binding.social_account_id
            WHERE binding.tenant_id = $1
              AND binding.agent_id = $2
              AND binding.platform = $3
              AND binding.status = 'current'
            FOR SHARE OF binding, account
          `, [
            req.tenantId,
            targetAgent.id,
            text(parent.platform, 40).toLowerCase(),
          ]);
          const finalSafetyDecision = evaluateCaptureSafetyHandoff({
            ...dutySafetyHandoffPolicy,
            targetPlatformAccountId:
              finalTargetAccount?.platform_account_id,
            targetLoginState: finalTargetAccount?.last_login_state,
          });
          if (!finalSafetyDecision.automaticEligible) {
            abortCrossDeviceRetry('idle_compatible_agent_unavailable', {
              code: 'DISTINCT_AUTHENTICATED_ACCOUNT_UNAVAILABLE',
            });
          }
          const finalLocalClosureProof =
            await loadVerifiedCaptureLocalClosureProof(tx, {
              tenantId: req.tenantId,
              executionTaskId:
                dutySafetyHandoffPolicy.sourceExecutionTaskId,
              sourceAgentId: dutySafetyHandoffPolicy.sourceAgentId,
              itemId: dutySafetyHandoffPolicy.sourceItemId,
              itemAttemptId:
                dutySafetyHandoffPolicy.sourceItemAttemptId,
              itemAttemptNumber:
                dutySafetyHandoffPolicy.sourceItemAttemptNumber,
              assignmentRevision:
                dutySafetyHandoffPolicy.sourceAssignmentRevision,
            });
          if (!finalLocalClosureProof.proven) {
            abortCrossDeviceRetry(
              'retry_requires_manual_safety_action',
              {
                code: 'HUMAN_REQUIRED',
                humanRequired: true,
                reason: 'source_local_closure_proof_unavailable',
                failedChecks: finalLocalClosureProof.failedChecks,
              },
            );
          }
        }
        if (businessTaskType === 'watched_content_patrol') {
          const watchedIntent = await tx.queryOne(`
            SELECT watched.record_id
            FROM record_watchlist watched
            WHERE watched.tenant_id = $1
              AND watched.record_id = $2::uuid
            FOR SHARE
          `, [req.tenantId, retryItems[0].record_id]);
          if (!watchedIntent) {
            abortCrossDeviceRetry('duty_recovery_source_superseded', {
              code: 'WATCHLIST_INTENT_REMOVED',
            });
          }
        }
        const finalFence = await tx.queryOne(`
          SELECT
            lease_token = $3::uuid AS lease_matches,
            lease_expires_at > clock_timestamp() AS lease_valid,
            window_ends_at > clock_timestamp() AS window_open,
            status IN ('ready', 'waiting_due', 'waiting_agent') AS
              status_open,
            action_count = 0 AS action_budget_open,
            recovery_task_id IS NULL AND dispatched_attempt_id IS NULL AS
              lineage_open
          FROM capture_recovery_intents
          WHERE id = $1::uuid AND tenant_id = $2
        `, [dutyIntentId, req.tenantId, dutyRecoveryLeaseToken]);
        if (finalFence && finalFence.window_open !== true) {
          abortCrossDeviceRetry('recovery_window_ended', {
            code: 'RECOVERY_WINDOW_ENDED',
          });
        }
        if (
          !finalFence
          || finalFence.lease_matches !== true
          || finalFence.lease_valid !== true
          || finalFence.status_open !== true
          || finalFence.action_budget_open !== true
          || finalFence.lineage_open !== true
        ) {
          abortCrossDeviceRetry('duty_recovery_lease_expired', {
            code: 'RECOVERY_LEASE_EXPIRED',
          });
        }
      }
      const child = await tx.queryOne(`
        INSERT INTO capture_tasks (
          id, tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
          client_task_id, task_type, feature_key, title, platform,
          source, trigger_type, status, progress, checkpoint, counts,
          metadata, message, orchestration_revision, source_updated_at
        ) VALUES (
          $1, $2, $3, $4, $4,
          $1::uuid::text, $5, $5, $6, $7,
          'cloud', 'cross_device_retry', 'pending', $8::jsonb,
          $9::jsonb, $10::jsonb, $11::jsonb,
          '未完成项已转交在线空闲设备，等待领取', $12, now()
        )
        RETURNING *
      `, [
        requestKey,
        req.tenantId,
        parent.id,
        targetAgent.id,
        businessTaskType,
        commandPayload.title,
        parent.platform,
        JSON.stringify({
          current: 0,
          total: retryItems.length,
          percent: 0,
          phase: 'queued',
        }),
        JSON.stringify(businessTaskType === 'unattended_keyword_capture'
          ? sequentialResumeCheckpoint || {round: 1, keywordIndex: 0}
          : {targetIndex: 0}),
        JSON.stringify({
          total: retryItems.length,
          assigned: retryItems.length,
          processed: 0,
          success: 0,
          failed: 0,
          skipped: 0,
        }),
        JSON.stringify(childMetadata),
        nextRevision,
      ]);
      const command = await tx.queryOne(`
        INSERT INTO capture_agent_commands (
          id, tenant_id, agent_id, task_id, command_type, payload,
          requested_by_user_id, requested_by_name
        ) VALUES ($1, $2, $3, $4, 'create', $5::jsonb, $6, $7)
        RETURNING id, status, expires_at
      `, [
        commandId,
        req.tenantId,
        targetAgent.id,
        child.id,
        JSON.stringify(commandPayload),
        req.user?.id || null,
        text(req.actorName, 240),
      ]);

      const dispatchedItemAttempts = [];
      for (const item of retryItems) {
        const attempt = await tx.queryOne(`
          SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number
          FROM capture_task_item_attempts
          WHERE tenant_id = $1 AND item_id = $2
        `, [req.tenantId, item.id]);
        const attemptNumber = Math.max(
          Number(item.attempt_count || 0) + 1,
          Number(attempt?.next_attempt_number || 1),
        );
        const monitorExecutionId = renewedExecutions.executionIdByItem.get(
          String(item.id),
        );
        const dutyItemMetadata = dutyRecovery
          ? {
              dutyRecovery: true,
              dutyRecoveryIntentId: dutyIntentId,
              dutyRecoveryGeneration: dutyGeneration,
            }
          : {};
        const updatedItem = await tx.queryOne(`
          UPDATE capture_task_items
          SET status = 'dispatched',
            attempt_count = $1,
            assigned_agent_id = $2,
            execution_task_id = $3,
            assignment_revision = $4,
            request_hash = $5,
            safety_handoff_count = safety_handoff_count +
              CASE WHEN $15::boolean THEN 1 ELSE 0 END,
            result_record_id = NULL,
            result_observation_id = NULL,
            error = '{}'::jsonb,
            metadata = (metadata - 'checkpoint' - 'targetResult') ||
              jsonb_strip_nulls(jsonb_build_object(
                'crossDeviceRetrySourceExecutionTaskId', $6::uuid::text,
                'crossDeviceRetryRequestKey', $7::uuid::text,
                'monitorExecutionId', $8::text
              )) || $9::jsonb,
            assigned_at = now(), dispatched_at = now(),
            started_at = NULL, finished_at = NULL, updated_at = now()
          WHERE id = $10 AND tenant_id = $11 AND task_id = $12
            AND execution_task_id IS NOT DISTINCT FROM $6::uuid
            AND assignment_revision = $13
            AND status = ANY($14::text[])
            AND (
              NOT $15::boolean
              OR safety_handoff_count = 0
            )
          RETURNING id, execution_task_id, assigned_agent_id,
            attempt_count, safety_handoff_count,
            assignment_revision, status, request_hash
        `, [
          attemptNumber,
          targetAgent.id,
          child.id,
          nextRevision,
          requestHash,
          item.execution_task_id,
          requestKey,
          monitorExecutionId || null,
          JSON.stringify(dutyItemMetadata),
          item.id,
          req.tenantId,
          parent.id,
          Number(item.assignment_revision || 0),
          [...CROSS_DEVICE_RETRY_ITEM_STATUSES],
          Boolean(dutySafetyHandoffPolicy),
        ]);
        if (!updatedItem) {
          const conflict = new Error('cross_device_retry_item_conflict');
          conflict.code = 'cross_device_retry_item_conflict';
          throw conflict;
        }
        const itemAttemptId = crypto.randomUUID();
        await tx.execute(`
          INSERT INTO capture_task_item_attempts (
            id, tenant_id, item_id, parent_task_id, execution_task_id,
            agent_id, attempt_number, assignment_revision, status,
            request_hash, checkpoint, result, error, dispatched_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, 'dispatched',
            $9, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
          )
        `, [
          itemAttemptId,
          req.tenantId,
          item.id,
          parent.id,
          child.id,
          targetAgent.id,
          attemptNumber,
          nextRevision,
          requestHash,
        ]);
        dispatchedItemAttempts.push({
          id: itemAttemptId,
          itemId: updatedItem.id,
          executionTaskId: updatedItem.execution_task_id,
          agentId: updatedItem.assigned_agent_id,
          attemptNumber,
          assignmentRevision: updatedItem.assignment_revision,
          status: updatedItem.status,
          requestHash: updatedItem.request_hash,
          safetyHandoffCount: updatedItem.safety_handoff_count,
        });
      }
      const itemAttemptBindings = dispatchedItemAttempts.map((attempt) => {
        const sourceItem = retryItems.find(
          item => String(item.id) === String(attempt.itemId),
        );
        return {
          itemId: attempt.itemId,
          attemptId: attempt.id,
          requestHash: attempt.requestHash,
          attemptNumber: attempt.attemptNumber,
          assignmentRevision: attempt.assignmentRevision,
          keyword: text(sourceItem?.keyword, 120),
          recordId: text(sourceItem?.record_id, 100),
          externalId: text(sourceItem?.external_id, 160),
        };
      });
      const attemptBindingByItemId = new Map(
        itemAttemptBindings.map(binding => [String(binding.itemId), binding]),
      );
      const bindTargetAttempt = target => {
        const source = safeJson(target);
        const binding = attemptBindingByItemId.get(String(source.itemId));
        return binding
          ? {
              ...source,
              captureTaskItemAttemptId: binding.attemptId,
              captureTaskItemRequestHash: binding.requestHash,
              captureTaskItemAttemptNumber: binding.attemptNumber,
              captureTaskItemAssignmentRevision: binding.assignmentRevision,
            }
          : source;
      };
      commandPayload = {
        ...commandPayload,
        itemAttempts: itemAttemptBindings,
        ...(Array.isArray(commandPayload.targets)
          ? {targets: commandPayload.targets.map(bindTargetAttempt)}
          : {}),
        ...(Array.isArray(commandPayload.items)
          ? {items: commandPayload.items.map(bindTargetAttempt)}
          : {}),
        ...(commandPayload.orchestration
          ? {
              orchestration: {
                ...safeJson(commandPayload.orchestration),
                itemAttempts: itemAttemptBindings,
              },
            }
          : {}),
        ...(dutyRecovery && itemAttemptBindings[0]
          ? {
              dutyRecovery: {
                ...safeJson(commandPayload.dutyRecovery),
                captureTaskItemAttemptId: itemAttemptBindings[0].attemptId,
                captureTaskItemRequestHash: itemAttemptBindings[0].requestHash,
              },
            }
          : {}),
      };
      await tx.execute(`
        UPDATE capture_agent_commands
        SET payload = $3::jsonb, updated_at = now()
        WHERE id = $1::uuid AND tenant_id = $2
      `, [command.id, req.tenantId, JSON.stringify(commandPayload)]);
      if (dutyRecovery) {
        const dutyAttempt = dispatchedItemAttempts[0];
        const boundIntent = await tx.queryOne(`
          UPDATE capture_recovery_intents
          SET status = 'verifying_collection',
            decision = 'cross_agent_recovery',
            recovery_task_id = $4::uuid,
            recovery_command_id = $5::uuid,
            recovery_agent_id = $6::uuid,
            dispatched_attempt_id = $7::uuid,
            dispatched_at = COALESCE(dispatched_at, clock_timestamp()),
            expected_assignment_revision = $8::integer,
            expected_attempt_number = $9::integer,
            safety_handoff_count = CASE
              WHEN $11::boolean THEN 1
              ELSE safety_handoff_count
            END,
            source_lineage_silent = false,
            action_count = GREATEST(action_count, 1),
            decision_payload = decision_payload || jsonb_build_object(
              'recoveryTaskId', $4::uuid,
              'recoveryCommandId', $5::uuid,
              'recoveryAgentId', $6::uuid,
              'dispatchedAttemptId', $7::uuid,
              'executionTaskId', $4::uuid,
              'generation', $10::integer,
              'safetyHandoff', $11::boolean,
              'safetyHandoffCount', CASE WHEN $11::boolean THEN 1 ELSE 0 END,
              'sourceLineageSilent', false,
              'dispatchBoundAtomically', true
            ),
            verification = verification || jsonb_build_object(
              'dispatchedAt', clock_timestamp()::text,
              'businessEvidenceRequired', true,
              'commandStateIsNotBusinessSuccess', true,
              'dispatchBoundAtomically', true
            ),
            last_error = '',
            updated_at = clock_timestamp()
          WHERE id = $1::uuid AND tenant_id = $2
            AND lease_token = $3::uuid
            AND lease_expires_at > clock_timestamp()
            AND window_ends_at > clock_timestamp()
            AND status IN ('ready', 'waiting_due', 'waiting_agent')
            AND recovery_task_id IS NULL
            AND dispatched_attempt_id IS NULL
            AND action_count = 0
          RETURNING id
        `, [
          dutyIntentId,
          req.tenantId,
          dutyRecoveryLeaseToken,
          child.id,
          command.id,
          targetAgent.id,
          dutyAttempt?.id,
          dutyAttempt?.assignmentRevision,
          dutyAttempt?.attemptNumber,
          dutyGeneration,
          Boolean(dutySafetyHandoffPolicy),
        ]);
        if (!boundIntent) {
          abortCrossDeviceRetry('duty_recovery_lease_expired', {
            code: 'RECOVERY_BIND_FENCE_REJECTED',
          });
        }
        await tx.execute(`
          SELECT enqueue_ops_control_wakeup(
            $1::uuid,
            'capture_recovery_dispatch_bound',
            'capture_recovery_intent',
            $2::text,
            'capture-recovery-intent:' || $2::text || ':dispatch-bound',
            clock_timestamp() + interval '2 minutes',
            jsonb_build_object(
              'itemId', $3::uuid,
              'recoveryTaskId', $4::uuid,
              'generation', $5::integer,
              'businessEvidenceRequired', true
            ),
            true
          )
        `, [
          req.tenantId,
          dutyIntentId,
          retryItems[0].id,
          child.id,
          dutyGeneration,
        ]);
      }
      const refreshedItems = await tx.queryAll(`
        SELECT status
        FROM capture_task_items
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY ordinal, id
      `, [req.tenantId, parent.id]);
      const aggregate = aggregateParentTaskItems(refreshedItems);
      const parentRetryMetadata = {
        lastCrossDeviceRetryAt: new Date().toISOString(),
        lastCrossDeviceRetryTaskId: child.id,
        lastCrossDeviceRetryAgentId: targetAgent.id,
        lastCrossDeviceRetryRequestKey: child.id,
        ...(dutyRecovery
          ? {
              lastDutyRecoveryAt: new Date().toISOString(),
              lastDutyRecoveryTaskId: child.id,
              lastDutyRecoveryAgentId: targetAgent.id,
              lastDutyRecoveryIntentId: dutyIntentId,
              lastDutyRecoveryGeneration: dutyGeneration,
            }
          : {}),
        ...(automatic
          ? {
              lastAutomaticRecoveryAt: new Date().toISOString(),
              lastAutomaticRecoveryTaskId: child.id,
              ...(!dutyRecovery
                ? {
                    automaticRecoveryCount:
                      Math.max(
                        0,
                        Number(
                          safeJson(parent.metadata).automaticRecoveryCount,
                        ) || 0,
                      ) + 1,
                  }
                : {}),
            }
          : {}),
      };
      const parentUpdate = await tx.queryOne(`
        UPDATE capture_tasks
        SET orchestration_revision = $1,
          status = $2, progress = $3::jsonb, counts = $4::jsonb,
          metadata = metadata || $5::jsonb,
          message = $6,
          finished_at = NULL, attention_dismissed_at = NULL,
          updated_at = now(), source_updated_at = now()
        WHERE id = $7 AND tenant_id = $8
          AND task_type = 'capture_orchestration'
          AND orchestration_revision = $9
        RETURNING id, status, orchestration_revision
      `, [
        nextRevision,
        aggregate.status,
        JSON.stringify(aggregate.progress),
        JSON.stringify(aggregate.counts),
        JSON.stringify(parentRetryMetadata),
        automatic
          ? '系统已把未完成项自动转交其他空闲设备'
          : '未完成项已在原任务内转交其他空闲设备重试',
        parent.id,
        req.tenantId,
        Number(parent.orchestration_revision || 0),
      ]);
      if (!parentUpdate) {
        const conflict = new Error('cross_device_retry_revision_conflict');
        conflict.code = 'cross_device_retry_revision_conflict';
        throw conflict;
      }
      await appendEvent(tx, {
        tenantId: req.tenantId,
        taskId: parent.id,
        agentId: targetAgent.id,
        eventType: 'cross_device_retry_dispatched',
        actorType,
        actorId: req.user?.id || '',
        actorName: req.actorName,
        status: parentUpdate.status,
        message: automatic
          ? '系统已自动选择在线空闲设备接管未完成项'
          : '未完成项已转交在线空闲设备，并保留在原任务中',
        payload: {
          retryTaskId: child.id,
          targetAgentId: targetAgent.id,
          itemIds: retryItems.map(item => item.id),
          sourceExecutionTaskIds,
          revision: parentUpdate.orchestration_revision,
          automatic,
          ...(dutyRecovery
            ? {
                recoveryPhase: 'duty',
                dutyRecoveryIntentId: dutyIntentId,
                dutyRecoveryGeneration: dutyGeneration,
              }
            : {}),
        },
      });
      return {
        existing: false,
        replayed: false,
        child,
        command,
        agent: targetAgent,
        parent: parentUpdate,
        itemAttempts: dispatchedItemAttempts,
        itemCount: retryItems.length,
        targetAgentId: targetAgent.id,
        recovery: dutyRecovery
          ? {phase: 'duty', intentId: dutyIntentId, generation: dutyGeneration}
          : {phase: 'fast'},
      };
    });
  } catch (error) {
    if (
      error?.crossDeviceRetryError ===
        'idle_compatible_agent_unavailable'
    ) {
      return noIdleAgentResult();
    }
    if (
      dutyRecovery &&
      error?.crossDeviceRetryError === 'duty_recovery_source_superseded'
    ) {
      return supersededResult(safeJson(error.details));
    }
    if (
      dutyRecovery &&
      [
        'duty_recovery_source_execution_active',
        'duty_recovery_source_command_active',
      ].includes(error?.crossDeviceRetryError)
    ) {
      return {
        error: error.crossDeviceRetryError,
        waitingForSource: true,
        ...safeJson(error.details),
      };
    }
    if (
      dutyRecovery &&
      error?.crossDeviceRetryError ===
        'retry_requires_manual_safety_action'
    ) {
      return {
        error: 'retry_requires_manual_safety_action',
        code: 'HUMAN_REQUIRED',
        humanRequired: true,
        reason:
          text(error?.details?.reason, 160) ||
          'source_local_closure_proof_unavailable',
      };
    }
    throw error;
  }
}

export async function reconcileElasticCaptureLeases(input = 50) {
  const options = input && typeof input === 'object' ? input : {limit: input};
  const normalizedLimit = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const tenantId = text(options.tenantId, 100).toLowerCase();
  const parentTaskIdInput = Array.isArray(options.parentTaskIds)
    ? options.parentTaskIds
    : [];
  const parentTaskIds = Array.from(new Set(
    parentTaskIdInput
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID_PATTERN.test(value)),
  ));
  if (tenantId && !UUID_PATTERN.test(tenantId)) {
    return {scanned: 0, requeued: 0, skipped: 0, error: 'invalid_tenant_id'};
  }
  if (Object.hasOwn(options, 'parentTaskIds') && (
    !tenantId
    || parentTaskIds.length === 0
    || parentTaskIds.length !== parentTaskIdInput.length
  )) {
    return {scanned: 0, requeued: 0, skipped: 0, error: 'invalid_parent_task_scope'};
  }
  const candidates = await queryAll(`
    SELECT child.id, child.tenant_id, child.parent_task_id
    FROM capture_tasks child
    JOIN capture_tasks parent
      ON parent.id = child.parent_task_id
      AND parent.tenant_id = child.tenant_id
    JOIN capture_agents agent
      ON agent.id = child.assigned_agent_id
      AND agent.tenant_id = child.tenant_id
    WHERE child.parent_task_id IS NOT NULL
      AND child.status IN (
        'pending', 'claimed', 'running', 'recovering', 'waiting_device'
      )
      AND COALESCE(parent.metadata->>'distributionMode', '') = 'elastic_pool'
      AND parent.status NOT IN (
        'completed', 'completed_with_warnings', 'completed_with_failures',
        'failed', 'canceled', 'skipped', 'superseded'
      )
      AND (
        (
          agent.last_heartbeat_at <
            now() - make_interval(mins => $1::integer)
          AND child.updated_at <
            now() - make_interval(mins => $1::integer)
        )
        OR (
          child.status IN ('claimed', 'running', 'recovering')
          AND COALESCE(child.heartbeat_at, child.started_at, child.created_at) <
            now() - make_interval(mins => $1::integer)
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM capture_agent_commands command
        WHERE command.tenant_id = child.tenant_id
          AND command.task_id = child.id
          AND command.status IN ('pending', 'acknowledged')
      )
      AND ($3::uuid IS NULL OR child.tenant_id = $3::uuid)
      AND (
        cardinality($4::uuid[]) = 0
        OR child.parent_task_id = ANY($4::uuid[])
      )
    ORDER BY child.updated_at, child.id
    LIMIT $2
  `, [
    ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN,
    normalizedLimit,
    tenantId || null,
    parentTaskIds,
  ]);

  const summary = {scanned: candidates.length, requeued: 0, skipped: 0};
  for (const candidate of candidates) {
    const settled = await withTransaction(async tx => {
      const parent = await tx.queryOne(`
        SELECT id
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
          AND status NOT IN (
            'completed', 'completed_with_warnings',
            'completed_with_failures', 'failed', 'canceled',
            'skipped', 'superseded'
          )
          AND COALESCE(metadata->>'distributionMode', '') = 'elastic_pool'
        FOR UPDATE SKIP LOCKED
      `, [candidate.parent_task_id, candidate.tenant_id]);
      if (!parent) return false;
      const child = await tx.queryOne(`
        SELECT child.*, agent.last_heartbeat_at AS agent_last_heartbeat_at
        FROM capture_tasks child
        JOIN capture_agents agent
          ON agent.id = child.assigned_agent_id
          AND agent.tenant_id = child.tenant_id
        WHERE child.id = $1 AND child.tenant_id = $2
          AND child.parent_task_id = $3
          AND child.status IN (
            'pending', 'claimed', 'running', 'recovering', 'waiting_device'
          )
          AND (
            (
              agent.last_heartbeat_at <
                now() - make_interval(mins => $4::integer)
              AND child.updated_at <
                now() - make_interval(mins => $4::integer)
            )
            OR (
              child.status IN ('claimed', 'running', 'recovering')
              AND COALESCE(
                child.heartbeat_at,
                child.started_at,
                child.created_at
              ) < now() - make_interval(mins => $4::integer)
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM capture_agent_commands command
            WHERE command.tenant_id = child.tenant_id
              AND command.task_id = child.id
              AND command.status IN ('pending', 'acknowledged')
          )
        FOR UPDATE OF child SKIP LOCKED
      `, [
        candidate.id,
        candidate.tenant_id,
        candidate.parent_task_id,
        ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN,
      ]);
      if (!child) return false;
      const agentHeartbeatAt = Date.parse(
        String(child.agent_last_heartbeat_at || ''),
      );
      const agentOffline =
        !Number.isFinite(agentHeartbeatAt) ||
        agentHeartbeatAt <
          Date.now() - ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN * 60 * 1000;
      const timeoutCode = agentOffline
        ? 'elastic_agent_offline_timeout'
        : 'elastic_task_heartbeat_timeout';
      const timeoutMessage = agentOffline
        ? '执行节点持续离线，工作项已退回弹性队列'
        : '执行节点在线但当前任务心跳中断，工作项已退回弹性队列';
      const failed = await tx.queryOne(`
        UPDATE capture_tasks
        SET status = 'failed',
          error = jsonb_build_object(
            'code', $3::text,
            'message', $4::text,
            'retryable', true
          ),
          message = $4,
          finished_at = now(),
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *
      `, [child.id, candidate.tenant_id, timeoutCode, timeoutMessage]);
      await projectOrchestrationChildControlOutcome(tx, {
        tenantId: candidate.tenant_id,
        childTask: failed,
        agentId: child.assigned_agent_id,
        status: 'retryable',
        error: {
          code: timeoutCode,
          message: timeoutMessage,
          automaticRetry: true,
        },
        actorType: 'system',
        actorName: '云端弹性调度器',
      });
      await appendEvent(tx, {
        tenantId: candidate.tenant_id,
        taskId: child.id,
        agentId: child.assigned_agent_id,
        eventType: 'elastic_work_item_requeued',
        status: 'failed',
        message: timeoutMessage,
        payload: {
          parentTaskId: candidate.parent_task_id,
          offlineTimeoutMinutes: ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN,
          timeoutCode,
        },
      });
      return true;
    });
    if (settled) summary.requeued += 1;
    else summary.skipped += 1;
  }
  return summary;
}

export async function reconcileAutomaticCaptureRetries(input = 10) {
  const options = input && typeof input === 'object' ? input : {limit: input};
  const normalizedLimit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const tenantId = text(options.tenantId, 100).toLowerCase();
  const taskIdInput = Array.isArray(options.taskIds) ? options.taskIds : [];
  const taskIds = Array.from(new Set(
    taskIdInput
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID_PATTERN.test(value)),
  ));
  const maxDispatchesPerTask = Math.max(
    1,
    Math.min(30, Number(options.maxDispatchesPerTask) || 30),
  );
  const requestedByName = text(
    options.requestedByName || '自动调度中心',
    240,
  );
  if (tenantId && !UUID_PATTERN.test(tenantId)) {
    return {
      scanned: 0,
      dispatched: 0,
      waitingForAgent: 0,
      manualOnly: 0,
      skipped: 0,
      failed: 0,
      results: [],
      error: 'invalid_tenant_id',
    };
  }
  if (Object.hasOwn(options, 'taskIds') && (
    !tenantId
    || taskIds.length === 0
    || taskIds.length !== taskIdInput.length
  )) {
    return {
      scanned: 0,
      dispatched: 0,
      waitingForAgent: 0,
      manualOnly: 0,
      skipped: 0,
      failed: 0,
      results: [],
      error: 'invalid_task_scope',
    };
  }
  const candidates = await queryAll(`
    SELECT id, tenant_id, status, orchestration_revision
    FROM capture_tasks
    WHERE parent_task_id IS NULL
      AND attention_dismissed_at IS NULL
      AND (
        status = ANY($1::text[])
        OR (
          status = ANY($2::text[])
          AND COALESCE(metadata->>'lastAutomaticRecoveryTaskId', '') <> ''
        )
      )
      AND updated_at > now() - interval '24 hours'
      AND COALESCE(metadata->>'orchestrationTemplate', 'false') <> 'true'
      AND COALESCE(metadata->>'distributionMode', '') <> 'elastic_pool'
      AND COALESCE(metadata->>'automaticRetryDisabled', 'false') <> 'true'
      AND COALESCE(
        metadata #>> '{planSnapshot,recoveryPolicy,allowIdleAgentHandoff}',
        'true'
      ) <> 'false'
      AND (
        task_type = ANY($3::text[])
        OR (
          task_type = 'capture_orchestration'
          AND COALESCE(
            NULLIF(metadata->>'promotedBusinessTaskType', ''),
            NULLIF(metadata->>'workflow', ''),
            CASE
              WHEN feature_key = ANY($3::text[]) THEN feature_key
              ELSE NULL
            END,
            'unattended_keyword_capture'
          ) = ANY($3::text[])
        )
      )
      AND ($5::uuid IS NULL OR tenant_id = $5::uuid)
      AND (cardinality($6::uuid[]) = 0 OR id = ANY($6::uuid[]))
      AND (
        $7::boolean = false
        OR NOT EXISTS (
          SELECT 1
          FROM tenant_settings recovery_enabled
          JOIN tenant_settings recovery_mode
            ON recovery_mode.tenant_id = recovery_enabled.tenant_id
            AND recovery_mode.key = 'ops_control_recovery_mode'
          WHERE recovery_enabled.tenant_id = capture_tasks.tenant_id
            AND recovery_enabled.key = 'ops_control_recovery_enabled'
            AND LOWER(BTRIM(recovery_enabled.value)) = ANY($8::text[])
            AND LOWER(BTRIM(recovery_mode.value)) = 'guarded'
        )
      )
    ORDER BY
      CASE status WHEN 'needs_action' THEN 0 ELSE 1 END,
      updated_at,
      id
    LIMIT $4
  `, [
    [...CROSS_DEVICE_RETRY_SOURCE_STATUSES],
    [...AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES],
    [...CROSS_DEVICE_RETRY_TASK_TYPES],
    normalizedLimit,
    tenantId || null,
    taskIds,
    dutyRecoveryGlobalActionsEnabled(),
    [...DUTY_RECOVERY_TRUE_VALUES],
  ]);

  const summary = {
    scanned: candidates.length,
    dispatched: 0,
    waitingForAgent: 0,
    manualOnly: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };
  for (const candidate of candidates) {
    let expectedRevision = Number(candidate.orchestration_revision || 0);
    for (let allocation = 0; allocation < maxDispatchesPerTask; allocation += 1) {
      try {
        const result = await dispatchCrossDeviceRetry({
          tenantId: candidate.tenant_id,
          taskId: candidate.id,
          requestKey: crypto.randomUUID(),
          expectedRevision,
          actorType: 'system',
          requestedByName,
          automatic: true,
        });
        if (!result?.error) {
          summary.dispatched += result.existing ? 0 : 1;
          expectedRevision = Number(
            result.parent?.orchestration_revision ?? expectedRevision,
          );
          summary.results.push({
            taskId: candidate.id,
            action: result.existing ? 'existing' : 'dispatched',
            retryTaskId: result.child?.id || '',
            itemCount: Number(result.itemCount || 0),
          });
          if (result.existing) break;
          continue;
        }
        if (result.error === 'idle_compatible_agent_unavailable') {
          summary.waitingForAgent += 1;
        } else if (
          [
            'retry_requires_manual_safety_action',
            'automatic_retry_disabled',
            'retry_items_not_automatically_recoverable',
          ].includes(result.error)
        ) {
          summary.manualOnly += 1;
        } else {
          summary.skipped += 1;
        }
        summary.results.push({
          taskId: candidate.id,
          action: result.error,
        });
        break;
      } catch (error) {
        if (
          error?.crossDeviceRetryError ||
          [
            'cross_device_retry_item_conflict',
            'cross_device_retry_revision_conflict',
          ].includes(error?.code)
        ) {
          summary.skipped += 1;
          summary.results.push({
            taskId: candidate.id,
            action: error.crossDeviceRetryError || error.code,
          });
          break;
        }
        summary.failed += 1;
        summary.results.push({
          taskId: candidate.id,
          action: 'worker_error',
          message: text(error?.message, 240),
        });
        break;
      }
    }
  }
  return summary;
}

router.post('/tasks/:id/retry-on-idle-agent', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const taskId = text(req.params.id, 100).toLowerCase();
    const requestKey = text(req.body?.requestKey, 100).toLowerCase();
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!UUID_PATTERN.test(taskId) || !UUID_PATTERN.test(requestKey)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_retry_request',
        message: '任务标识或重试请求标识无效，请刷新后重试',
      });
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_expected_revision',
        message: '任务版本无效，请刷新后重试',
      });
    }

    const result = await dispatchCrossDeviceRetry({
      tenantId: req.tenantId,
      taskId,
      requestKey,
      expectedRevision,
      actorType: 'user',
      requestedByUserId: req.user?.id || '',
      requestedByName: text(req.actorName, 240),
      automatic: false,
    });

    if (result.error) {
      return sendCrossDeviceRetryError(res, result);
    }
    return res.status(result.existing ? 200 : 201).json({
      ok: true,
      idempotent: result.existing === true,
      taskId,
      retryTaskId: result.child.id,
      targetAgentId: result.child.assigned_agent_id,
      targetAgentName: result.agent
        ? result.agent.display_name || result.agent.client_label || ''
        : '',
      itemCount: result.itemCount || 0,
      revision: result.parent?.orchestration_revision ?? null,
      message: result.existing
        ? '该换设备重试请求已经下发'
        : `${result.itemCount} 个未完成项已在原任务内转交空闲设备重试`,
    });
  } catch (err) {
    if (err?.crossDeviceRetryError) {
      return sendCrossDeviceRetryError(res, {
        error: err.crossDeviceRetryError,
        ...safeJson(err.details),
      });
    }
    if ([
      'cross_device_retry_item_conflict',
      'cross_device_retry_revision_conflict',
    ].includes(err?.code)) {
      return res.status(409).json({
        ok: false,
        error: 'cross_device_retry_conflict',
        message: '任务刚刚被其它操作更新，请刷新后重试',
      });
    }
    return next(err);
  }
});

router.post('/tasks/:id/resume', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const mode = ['remaining', 'failed', 'skip_current'].includes(req.body?.mode)
      ? req.body.mode
      : 'remaining';
    const result = await withTransaction(async tx => {
      const taskIdentity = await tx.queryOne(`
        SELECT COALESCE(assigned_agent_id, origin_agent_id) AS agent_id
        FROM capture_tasks
        WHERE id = $1 AND tenant_id = $2
      `, [req.params.id, req.tenantId]);
      if (!taskIdentity) return { error: 'task_not_found' };
      if (!taskIdentity.agent_id) return { error: 'agent_unavailable' };
      await lockCaptureAgentExecutionSlot(
        tx,
        req.tenantId,
        taskIdentity.agent_id,
      );
      await expireStaleCommands(tx, req.tenantId, req.params.id);
      const task = await tx.queryOne(`
        SELECT t.*, ca.status AS agent_status, ca.last_heartbeat_at,
          ca.display_name AS agent_display_name, ca.client_label AS agent_client_label,
          ca.allowed_platforms AS agent_allowed_platforms,
          ca.auth_code_id AS agent_auth_code_id,
          ca.auth_binding_id AS agent_auth_binding_id,
          ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
          ab.id AS active_auth_binding_id,
          tenant.status AS tenant_status
        FROM capture_tasks t
        LEFT JOIN capture_agents ca
          ON ca.id = COALESCE(t.assigned_agent_id, t.origin_agent_id)
          AND ca.tenant_id = t.tenant_id
        LEFT JOIN auth_codes ac ON ac.id = ca.auth_code_id AND ac.tenant_id = t.tenant_id
        LEFT JOIN auth_bindings ab ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
        LEFT JOIN tenants tenant ON tenant.id = t.tenant_id
        WHERE t.id = $1 AND t.tenant_id = $2
        FOR UPDATE OF t
      `, [req.params.id, req.tenantId]);
      if (!task) return { error: 'task_not_found' };
      if (task.metadata?.handoffSuccessorTaskId) {
        return { error: 'task_handed_off', task };
      }
      const agentId = task.assigned_agent_id || task.origin_agent_id;
      if (String(agentId || '') !== String(taskIdentity.agent_id)) {
        return { error: 'task_agent_changed', task };
      }
      if (!task.control_task_id || !String(task.task_type).includes('unattended')) {
        return { error: 'task_not_remotely_resumable', task };
      }
      const authCodeExpired = task.auth_code_expires_at && new Date(task.auth_code_expires_at) < new Date();
      if (
        !agentId ||
        task.tenant_status !== 'active' ||
        task.agent_status !== 'active' ||
        task.auth_code_status !== 'active' ||
        !task.active_auth_binding_id ||
        authCodeExpired
      ) {
        return { error: 'agent_unavailable', task };
      }
      const allowedPlatforms = Array.isArray(task.agent_allowed_platforms)
        ? task.agent_allowed_platforms
        : [];
      if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(task.platform)) {
        return { error: 'agent_platform_mismatch', task };
      }
      const existing = agentId ? await tx.queryOne(`
        SELECT id, status FROM capture_agent_commands
        WHERE task_id = $1 AND agent_id = $2 AND command_type = 'resume'
          AND status IN ('pending', 'acknowledged') AND expires_at > now()
          AND payload->>'authCodeId' = $3
          AND payload->>'authBindingId' = $4
          AND payload->>'platform' = $5
        ORDER BY created_at DESC LIMIT 1
      `, [
        task.id,
        agentId,
        task.agent_auth_code_id,
        task.agent_auth_binding_id,
        task.platform,
      ]) : null;
      if (existing) return { task, command: existing, existing: true };
      if (!RECOVERABLE_STATUSES.has(task.status)) {
        return { error: 'task_not_recoverable', task };
      }

      let allowedKeywords = [];
      if (task.parent_task_id) {
        const parent = await tx.queryOne(`
          SELECT metadata
          FROM capture_tasks
          WHERE id = $1 AND tenant_id = $2
        `, [task.parent_task_id, req.tenantId]);
        const parentMetadata = safeJson(parent?.metadata);
        if (text(parentMetadata.lastCrossDeviceRetryTaskId, 100)) {
          const retainedItems = await tx.queryAll(`
            SELECT keyword
            FROM capture_task_items
            WHERE tenant_id = $1
              AND task_id = $2
              AND execution_task_id = $3
              AND status = 'needs_action'
              AND started_at IS NOT NULL
            ORDER BY ordinal, id
            LIMIT 30
          `, [req.tenantId, task.parent_task_id, task.id]);
          allowedKeywords = retainedItems
            .map(item => text(item.keyword, 120))
            .filter(Boolean);
          if (allowedKeywords.length === 0) {
            return {error: 'task_handed_off', task};
          }
        }
      }

      const command = await tx.queryOne(`
        INSERT INTO capture_agent_commands (
          tenant_id, agent_id, task_id, command_type, payload,
          requested_by_user_id, requested_by_name
        ) VALUES ($1, $2, $3, 'resume', $4::jsonb, $5, $6)
        RETURNING id, status, created_at
      `, [
        req.tenantId,
        agentId,
        task.id,
        JSON.stringify({
          mode,
          controlTaskId: task.control_task_id,
          previousStatus: task.status,
          ...(allowedKeywords.length > 0 ? {allowedKeywords} : {}),
          authCodeId: task.agent_auth_code_id,
          authBindingId: task.agent_auth_binding_id,
          platform: task.platform,
        }),
        req.user?.id || null,
        text(req.actorName, 240),
      ]);
      await tx.execute(`
        UPDATE capture_tasks
        SET status = 'resume_requested', assigned_agent_id = $1,
          message = '后台已请求设备继续任务',
          metadata = metadata || $2::jsonb,
          updated_at = now()
        WHERE id = $3 AND tenant_id = $4
      `, [
        agentId,
        JSON.stringify({resumePreviousStatus: task.status, resumeCommandId: command.id}),
        task.id,
        req.tenantId,
      ]);
      await appendEvent(tx, {
        tenantId: req.tenantId,
        taskId: task.id,
        agentId,
        eventType: 'resume_requested',
        actorType: 'user',
        actorId: req.user?.id || '',
        actorName: req.actorName,
        status: 'resume_requested',
        message: '后台请求继续剩余任务',
        payload: {commandId: command.id, mode, allowedKeywords},
      });
      return { task, command, existing: false };
    });

    const messages = {
      task_not_found: ['task_not_found', '任务不存在'],
      task_not_recoverable: ['task_not_recoverable', '任务当前状态不能继续'],
      task_handed_off: ['task_handed_off', '该任务的后续关键词已经转交其他 Agent，不能再由原设备继续'],
      task_agent_changed: ['task_agent_changed', '任务执行节点刚刚发生变化，请刷新后重试'],
      task_not_remotely_resumable: ['task_not_remotely_resumable', '该任务还不支持远程继续'],
      agent_unavailable: ['agent_unavailable', '原执行节点授权已失效、已停用或不存在'],
      agent_platform_mismatch: ['agent_platform_mismatch', '原执行节点未配置负责该任务平台'],
    };
    if (result.error) {
      const [error, message] = messages[result.error];
      return res.status(result.error === 'task_not_found' ? 404 : 409).json({ ok: false, error, message });
    }
    const online = captureAgentOnline(result.task.last_heartbeat_at);
    return res.json({
      ok: true,
      commandId: result.command.id,
      existing: result.existing,
      agentOnline: online,
      status: online ? 'resume_requested' : 'waiting_device',
      message: online ? '已向在线设备发送继续指令' : '设备当前离线，指令会等待设备上线',
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/tasks/:id/stop', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const result = await withTransaction(async tx => {
      await expireStaleCommands(tx, req.tenantId, req.params.id);
      const task = await tx.queryOne(`
        SELECT t.*, ca.status AS agent_status, ca.last_heartbeat_at,
          ca.allowed_platforms AS agent_allowed_platforms,
          ca.capabilities AS agent_capabilities,
          ca.auth_code_id AS agent_auth_code_id,
          ca.auth_binding_id AS agent_auth_binding_id,
          ac.status AS auth_code_status, ac.expires_at AS auth_code_expires_at,
          ab.id AS active_auth_binding_id,
          tenant.status AS tenant_status
        FROM capture_tasks t
        LEFT JOIN capture_agents ca
          ON ca.id = COALESCE(t.assigned_agent_id, t.origin_agent_id)
          AND ca.tenant_id = t.tenant_id
        LEFT JOIN auth_codes ac
          ON ac.id = ca.auth_code_id AND ac.tenant_id = t.tenant_id
        LEFT JOIN auth_bindings ab
          ON ab.id = ca.auth_binding_id AND ab.code_id = ac.id
        LEFT JOIN tenants tenant ON tenant.id = t.tenant_id
        WHERE t.id = $1 AND t.tenant_id = $2
        FOR UPDATE OF t
      `, [req.params.id, req.tenantId]);
      if (!task) return {error: 'task_not_found'};

      const agentId = task.assigned_agent_id || task.origin_agent_id;
      const targetedStop = isTargetedPostTaskType(task.task_type);
      const currentAttempt =
        targetedStop && Number(task.attempt_number) > 0
          ? await tx.queryOne(`
            SELECT client_attempt_id
            FROM capture_task_attempts
            WHERE tenant_id = $1 AND task_id = $2 AND attempt_number = $3
            LIMIT 1
          `, [req.tenantId, task.id, task.attempt_number])
          : null;
      const clientAttemptId = text(currentAttempt?.client_attempt_id, 240);
      const existing = agentId ? await tx.queryOne(`
        SELECT id, status, expires_at
        FROM capture_agent_commands
        WHERE task_id = $1 AND agent_id = $2 AND command_type = 'stop'
          AND status IN ('pending', 'acknowledged') AND expires_at > now()
          AND payload->>'authCodeId' = $3
          AND payload->>'authBindingId' = $4
          AND payload->>'platform' = $5
          AND (
            $6::boolean = false
            OR ($7 <> '' AND payload->>'attemptId' = $7)
          )
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `, [
        task.id,
        agentId,
        task.agent_auth_code_id,
        task.agent_auth_binding_id,
        task.platform,
        targetedStop,
        clientAttemptId,
      ]) : null;
      if (existing) return {task, command: existing, existing: true};
      if (task.status === 'canceled') {
        return {task, alreadyStopped: true};
      }

      const activeCreate = agentId ? await tx.queryOne(`
        SELECT id, status
        FROM capture_agent_commands
        WHERE task_id = $1 AND agent_id = $2 AND command_type = 'create'
          AND status IN ('pending', 'acknowledged') AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `, [task.id, agentId]) : null;

      // A create that has never reached the browser can be canceled immediately.
      // This is stronger than queuing a stop behind work the device never saw.
      if (activeCreate?.status === 'pending') {
        await tx.execute(`
          UPDATE capture_agent_commands
          SET status = 'expired',
            result = jsonb_build_object('reason', 'stopped_before_dispatch'),
            finished_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'pending'
        `, [activeCreate.id]);
        const canceledTask = await tx.queryOne(`
          UPDATE capture_tasks
          SET status = 'canceled',
            message = '任务已在设备领取前取消',
            metadata = (metadata
              - 'resumeCommandId' - 'resumePreviousStatus'
              - 'stopCommandId' - 'stopPreviousStatus')
              || jsonb_build_object('stoppedBeforeDispatch', true),
            finished_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, parent_task_id, status
        `, [task.id, req.tenantId]);
        await cancelProfileDiscoveryWork(tx, {
          tenantId: req.tenantId,
          taskId: task.id,
          task,
          message: '任务已在设备领取前取消',
        });
        await appendEvent(tx, {
          tenantId: req.tenantId,
          taskId: task.id,
          agentId,
          eventType: 'task_stopped_before_dispatch',
          actorType: 'user',
          actorId: req.user?.id || '',
          actorName: req.actorName,
          status: 'canceled',
          message: '后台已在设备领取前取消任务',
          payload: {createCommandId: activeCreate.id},
        });
        if (canceledTask?.parent_task_id) {
          await projectOrchestrationChildControlOutcome(tx, {
            tenantId: req.tenantId,
            childTask: canceledTask,
            agentId,
            status: 'canceled',
            actorType: 'user',
            actorId: req.user?.id || '',
            actorName: req.actorName,
          });
        }
        return {task: canceledTask || task, immediate: true};
      }

      const metadata = safeJson(task.metadata);
      const controlTaskId = text(task.control_task_id || task.client_task_id, 240);
      const remotelyControlled = String(task.task_type || '').includes('unattended') ||
        metadata.remoteCreated === true;
      if (!controlTaskId || !remotelyControlled) {
        return {error: 'task_not_remotely_stoppable', task};
      }
      if (STOP_FINAL_STATUSES.has(task.status) || !REMOTELY_STOPPABLE_STATUSES.has(task.status)) {
        return {error: 'task_not_stoppable', task};
      }
      if (safeJson(task.agent_capabilities).remoteStop !== true) {
        return {error: 'agent_stop_capability_missing', task};
      }

      const authCodeExpired = task.auth_code_expires_at &&
        new Date(task.auth_code_expires_at) < new Date();
      if (
        !agentId ||
        task.tenant_status !== 'active' ||
        task.agent_status !== 'active' ||
        task.auth_code_status !== 'active' ||
        !task.active_auth_binding_id ||
        authCodeExpired
      ) {
        return {error: 'agent_unavailable', task};
      }
      if (targetedStop && !clientAttemptId) {
        return {error: 'task_attempt_unavailable', task};
      }

      const previousStatus = task.status === 'resume_requested'
        ? text(metadata.resumePreviousStatus, 80) || 'needs_action'
        : task.status;
      // Invalidate continuation and already-acknowledged create commands before
      // inserting stop. Only the stop command remains eligible for heartbeat.
      await tx.execute(`
        UPDATE capture_agent_commands
        SET status = 'expired',
          result = jsonb_build_object('reason', 'superseded_by_stop'),
          finished_at = now(), updated_at = now()
        WHERE task_id = $1 AND agent_id = $2
          AND command_type IN ('resume', 'create')
          AND status IN ('pending', 'acknowledged')
      `, [task.id, agentId]);

      const command = await tx.queryOne(`
        INSERT INTO capture_agent_commands (
          tenant_id, agent_id, task_id, command_type, payload,
          requested_by_user_id, requested_by_name
        ) VALUES ($1, $2, $3, 'stop', $4::jsonb, $5, $6)
        RETURNING id, status, expires_at, created_at
      `, [
        req.tenantId,
        agentId,
        task.id,
        JSON.stringify({
          controlTaskId,
          previousStatus,
          ...(activeCreate?.status === 'acknowledged'
            ? {supersededCreateCommandId: activeCreate.id}
            : {}),
          ...(clientAttemptId ? {attemptId: clientAttemptId} : {}),
          authCodeId: task.agent_auth_code_id,
          authBindingId: task.agent_auth_binding_id,
          platform: task.platform,
        }),
        req.user?.id || null,
        text(req.actorName, 240),
      ]);
      await tx.execute(`
        UPDATE capture_tasks
        SET assigned_agent_id = $1,
          message = '后台已请求设备停止任务',
          metadata = (metadata
            - 'resumeCommandId' - 'resumePreviousStatus'
            - 'stopCommandId' - 'stopPreviousStatus') || $2::jsonb,
          updated_at = now()
        WHERE id = $3 AND tenant_id = $4
      `, [
        agentId,
        JSON.stringify({stopCommandId: command.id, stopPreviousStatus: previousStatus}),
        task.id,
        req.tenantId,
      ]);
      await appendEvent(tx, {
        tenantId: req.tenantId,
        taskId: task.id,
        agentId,
        eventType: 'stop_requested',
        actorType: 'user',
        actorId: req.user?.id || '',
        actorName: req.actorName,
        status: task.status,
        message: '后台请求停止当前任务',
        payload: {commandId: command.id, controlTaskId},
      });
      return {task, command, existing: false};
    });

    const messages = {
      task_not_found: ['task_not_found', '任务不存在'],
      task_not_stoppable: ['task_not_stoppable', '任务当前状态不能停止'],
      task_not_remotely_stoppable: ['task_not_remotely_stoppable', '该任务还不支持远程停止'],
      task_attempt_unavailable: ['task_attempt_unavailable', '设备尚未上报当前执行轮次，请稍后重试停止'],
      agent_stop_capability_missing: ['agent_stop_capability_missing', '原执行节点版本尚不支持远程停止，请先更新扩展'],
      agent_unavailable: ['agent_unavailable', '原执行节点授权已失效、已停用或不存在'],
    };
    if (result.error) {
      const [error, message] = messages[result.error];
      return res.status(result.error === 'task_not_found' ? 404 : 409).json({ok: false, error, message});
    }
    if (result.alreadyStopped) {
      return res.json({
        ok: true,
        existing: true,
        status: 'canceled',
        message: '任务已经停止',
      });
    }
    if (result.immediate) {
      return res.json({
        ok: true,
        existing: false,
        status: 'canceled',
        message: '任务已在设备领取前取消',
      });
    }
    const online = captureAgentOnline(result.task.last_heartbeat_at);
    return res.json({
      ok: true,
      commandId: result.command.id,
      commandExpiresAt: result.command.expires_at,
      existing: result.existing === true,
      agentOnline: online,
      status: online ? 'stop_requested' : 'waiting_device',
      message: online
        ? '已向在线设备发送停止指令'
        : '设备当前离线，停止指令会排队等待设备上线',
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/tasks/:id/snapshots', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(500, Math.max(1, Math.floor(requestedLimit)))
      : 100;
    const task = await queryOne(
      'SELECT id FROM capture_tasks WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId],
    );
    if (!task) {
      return res.status(404).json({
        ok: false,
        error: 'task_not_found',
        message: '任务不存在',
      });
    }
    const snapshots = await queryAll(`
      SELECT id, attempt_id, agent_id,
        client_task_id, control_task_id, client_attempt_id,
        attempt_number, progress_seq, task_type, feature_key, title,
        platform, source, trigger_type, status,
        progress, checkpoint, counts, metadata, error, message,
        heartbeat_at, business_progress_at, started_at, finished_at,
        source_created_at, source_updated_at, received_at
      FROM capture_task_snapshots
      WHERE task_id = $1 AND tenant_id = $2
      ORDER BY source_updated_at DESC, id DESC
      LIMIT $3
    `, [task.id, req.tenantId, limit]);
    return res.json({ok: true, snapshots});
  } catch (err) {
    return next(err);
  }
});

router.get('/tasks/:id/events', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  try {
    const task = await queryOne('SELECT id FROM capture_tasks WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!task) return res.status(404).json({ ok: false, error: 'task_not_found', message: '任务不存在' });
    const events = await queryAll(`
      SELECT id, event_type, actor_type, actor_name, status, message, payload, created_at
      FROM capture_task_events
      WHERE task_id = $1 AND tenant_id = $2
      ORDER BY created_at DESC
      LIMIT 200
    `, [task.id, req.tenantId]);
    return res.json({ ok: true, events });
  } catch (err) {
    return next(err);
  }
});

export default router;
