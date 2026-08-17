import {
  aggregateParentTaskItems,
  checkpointEntryToItemStatus,
} from '../../../services/capture-orchestration.js';

export const CAPTURE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const POSTGRES_INTEGER_MAX = 2147483647;

export const AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT = 3;

export const ELASTIC_AUTOMATIC_SAFETY_HANDOFF_ATTEMPTS = 1;
const CROSS_DEVICE_RETRY_SAFETY_CODES = new Set([
  'DOUYIN_SEARCH_SECURITY_CHALLENGE',
  'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
  'DOUYIN_CAPTCHA_REQUIRED',
  'CAPTCHA_PAGE_DETECTED',
  'LOGIN_REQUIRED',
  'AUTH_REQUIRED',
  'DOUYIN_LOGIN_REQUIRED',
  'XHS_LOGIN_REQUIRED',
]);

export const ELASTIC_AGENT_CAPACITY_CODES = new Set([
  'CAPTURE_TASK_GROUP_BUSY',
  'CAPTURE_TASK_CLEANUP_PENDING',
  'CAPTURE_TASK_DEBUG_BUSY',
  'CAPTURE_LOCK_CONFLICT',
]);

export const ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES = new Set([
  ...ELASTIC_AGENT_CAPACITY_CODES,
  'CREATE_COMMAND_EXPIRED',
  'CREATE_AGENT_UNAVAILABLE',
]);

export const CROSS_DEVICE_RETRY_TASK_TYPES = new Set([
  'unattended_keyword_capture',
  'negative_post_patrol',
  'watched_content_patrol',
  'official_account_comment_patrol',
  'followed_creator_post_patrol',
  'official_account_post_discovery',
]);

export function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

export function orchestrationCheckpointTimestamp(value) {
  const normalized = text(value, 100);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function safeJson(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function orchestrationCheckpointInteger(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(POSTGRES_INTEGER_MAX, Math.max(0, parsed));
}

export function orchestrationCheckpointEntries(snapshot) {
  const checkpoint = safeJson(snapshot?.checkpoint);
  const progress = safeJson(snapshot?.progress);
  const entries = Array.isArray(checkpoint.keywordResults)
    ? checkpoint.keywordResults
      .map(entry => safeJson(entry))
      .filter(entry => text(entry.keyword, 120))
    : [];
  const byKeyword = new Map(entries.map(entry => [text(entry.keyword, 120), entry]));
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
    !ORCHESTRATION_ITEM_TERMINAL_STATUSES.has(existingStatus)
  ) {
    byKeyword.set(activeKeyword, {
      ...safeJson(existingEntry),
      keyword: activeKeyword,
      status: 'running',
      round: Math.max(1, Number(checkpoint.round) || 1),
      index: Math.max(
        0,
        Number(checkpoint.activeKeywordIndex ?? checkpoint.keywordIndex) || 0,
      ),
    });
  }
  return Array.from(byKeyword.values());
}

export function orchestrationItemAttemptStatus(itemStatus) {
  // Item attempts start at dispatch, so a checkpoint entry with no meaningful
  // status must not move the append-only audit back to a pre-dispatch state.
  return itemStatus === 'pending' || itemStatus === 'assigned'
    ? 'dispatched'
    : itemStatus;
}

export function promotedRetryBusinessTaskType(task = {}) {
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

export function crossDeviceRetryItemNeedsManualSafety(item = {}) {
  const error = safeJson(item.error);
  const checkpoint = safeJson(safeJson(item.metadata).checkpoint);
  const code = text(
    error.code || checkpoint.errorCode || checkpoint.error_code,
    100,
  ).toUpperCase();
  return CROSS_DEVICE_RETRY_SAFETY_CODES.has(code) ||
    ['platform_safety_block', 'login_required', 'authentication_required']
      .includes(text(error.category, 100).toLowerCase()) ||
    error.securityBlocked === true ||
    error.platformSafetyBlocked === true ||
    error.requiresManualAction === true ||
    checkpoint.securityBlocked === true ||
    checkpoint.platformSafetyBlocked === true ||
    checkpoint.requiresManualAction === true;
}

export function projectElasticKeywordRecoveryStatus({
  elasticPool = false,
  status = '',
  error = {},
  checkpoint = {},
  attemptCount = 0,
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
    return normalizedAttemptCount <= ELASTIC_AUTOMATIC_SAFETY_HANDOFF_ATTEMPTS
      ? 'retryable'
      : 'needs_action';
  }
  return normalizedAttemptCount < AUTOMATIC_CROSS_DEVICE_ITEM_ATTEMPT_LIMIT
    ? 'retryable'
    : 'failed';
}

export function elasticRecoveryErrorCode(source = {}) {
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
  return {
    attemptBudget,
    metadataPatch: {
      elasticAttemptBudgetUsed: attemptBudget,
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

export async function appendEvent(tx, {
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

export const ORCHESTRATION_ITEM_TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'skipped',
  'canceled',
]);

export async function lockOrchestrationParent(tx, tenantId, parentTaskId) {
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

export async function refreshOrchestrationParentTask(tx, {
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

  const items = await tx.queryAll(`
    SELECT status
    FROM capture_task_items
    WHERE task_id = $1 AND tenant_id = $2
    ORDER BY ordinal, id
  `, [parentTaskId, tenantId]);
  const aggregate = aggregateParentTaskItems(items);
  const parentMetadata = safeJson(parent.metadata);
  const elasticPool = parentMetadata.distributionMode === 'elastic_pool';
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
  const businessProgressChanged =
    Number(previousProgress.current || 0) !== aggregate.progress.current ||
    Number(previousProgress.total || 0) !== aggregate.progress.total;
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
        WHEN $6::boolean THEN GREATEST(business_progress_at, $7::timestamptz)
        ELSE business_progress_at
      END,
      finished_at = CASE
        WHEN $8::boolean THEN COALESCE(finished_at, $7::timestamptz, now())
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
    businessProgressChanged,
    orchestrationCheckpointTimestamp(
      snapshot.businessProgressAt ||
      snapshot.updatedAt ||
      snapshot.heartbeatAt,
    ),
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

export async function projectOrchestrationChildControlOutcome(tx, {
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
        SELECT id, attempt_count, metadata
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
