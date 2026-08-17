import {
  safeJson,
  text,
} from '../application/control-outcome-projection.js';
import {isProfilePatrolTask} from '../application/profile-patrol.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function syncProfileDiscoverySubscriptions(
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
