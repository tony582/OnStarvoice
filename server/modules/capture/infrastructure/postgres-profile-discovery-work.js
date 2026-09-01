import {
  safeJson,
  text,
} from '../application/control-outcome-projection.js';
import {isProfilePatrolTask} from '../application/profile-patrol.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function normalizedProfileExecutionIds(executionIds = []) {
  return [...new Set(
    executionIds
      .map(id => text(id, 100).toLowerCase())
      .filter(id => UUID_PATTERN.test(id)),
  )].sort();
}

export async function lockProfileDiscoverySubscriptionsForExecutions(
  tx,
  tenantId,
  executionIds = [],
) {
  const ids = normalizedProfileExecutionIds(executionIds);
  if (ids.length === 0) return [];
  // Profile producers and terminal projectors share one blocking order:
  // subscription rows in stable order before their execution rows. The
  // subquery only discovers immutable execution-to-subscription identities.
  return await tx.queryAll(`
    SELECT subscription.id
    FROM monitor_subscriptions subscription
    WHERE subscription.tenant_id = $1
      AND subscription.id IN (
        SELECT execution.subscription_id
        FROM monitor_executions execution
        WHERE execution.tenant_id = $1
          AND execution.id = ANY($2::uuid[])
      )
    ORDER BY subscription.id
    FOR UPDATE OF subscription
  `, [tenantId, ids]);
}

async function lockProfileDiscoverySubscriptionsForTask(
  tx,
  tenantId,
  taskId,
) {
  const executions = await tx.queryAll(`
    SELECT DISTINCT execution.id
    FROM capture_task_items item
    JOIN monitor_executions execution
      ON execution.tenant_id = item.tenant_id
      AND item.metadata->>'monitorExecutionId' = execution.id::text
    WHERE item.tenant_id = $1
      AND item.execution_task_id = $2
    ORDER BY execution.id
  `, [tenantId, taskId]);
  const executionIds = executions.map(execution => execution.id);
  await lockProfileDiscoverySubscriptionsForExecutions(
    tx,
    tenantId,
    executionIds,
  );
  return executionIds;
}

export async function lockProfileDiscoveryWorkForTask(
  tx,
  tenantId,
  taskId,
) {
  // Canonical retry already owns Profile items before crossing into monitor
  // subscriptions. Terminal projectors must take the same task-local rows in
  // one stable pass, otherwise a multi-item projector can hold subscription A
  // while waiting for item B that retry already owns.
  await tx.queryAll(`
    SELECT item.id
    FROM capture_task_items item
    WHERE item.tenant_id = $1
      AND item.execution_task_id = $2
    ORDER BY item.ordinal, item.id
    FOR UPDATE OF item
  `, [tenantId, taskId]);
  await tx.queryAll(`
    SELECT attempt.id
    FROM capture_task_item_attempts attempt
    WHERE attempt.tenant_id = $1
      AND attempt.execution_task_id = $2
    ORDER BY attempt.item_id, attempt.attempt_number, attempt.id
    FOR UPDATE OF attempt
  `, [tenantId, taskId]);
  const executionIds = await lockProfileDiscoverySubscriptionsForTask(
    tx,
    tenantId,
    taskId,
  );
  if (executionIds.length > 0) {
    await tx.queryAll(`
      SELECT execution.id
      FROM monitor_executions execution
      WHERE execution.tenant_id = $1
        AND execution.id = ANY($2::uuid[])
      ORDER BY execution.id
      FOR UPDATE OF execution
    `, [tenantId, executionIds]);
  }
}

export async function syncProfileDiscoverySubscriptions(
  tx,
  tenantId,
  executionIds = [],
) {
  const ids = normalizedProfileExecutionIds(executionIds);
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

export async function failProfileDiscoveryWork(tx, {
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
  await lockProfileDiscoveryWorkForTask(tx, tenantId, taskId);
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
