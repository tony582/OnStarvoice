import {queryAll, withTransaction} from '../../../db/init.js';
import {
  RECOVERABLE_STATUSES,
  createPendingCaptureCommandReconciler,
  stopFailureStatus,
} from '../application/command-lifecycle.js';
import {
  appendEvent,
  projectOrchestrationChildControlOutcome,
  safeJson,
  text,
} from '../application/control-outcome-projection.js';
import {
  failProfileDiscoveryWork,
} from './postgres-profile-discovery-work.js';

export async function expireStaleCommands(
  tx,
  tenantId,
  taskId = null,
  agentId = null,
) {
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

async function listPendingCaptureCommandTenants(limit) {
  return queryAll(`
    SELECT tenant_id, MIN(created_at) AS oldest_command_at
    FROM capture_agent_commands
    WHERE status IN ('pending', 'acknowledged')
    GROUP BY tenant_id
    ORDER BY MIN(created_at), tenant_id
    LIMIT $1
  `, [limit]);
}

const reconcilePendingCaptureCommandsImpl =
  createPendingCaptureCommandReconciler({
    listPendingTenants: listPendingCaptureCommandTenants,
    withTransaction,
    expireTenantCommands: (tx, tenantId) =>
      expireStaleCommands(tx, tenantId),
  });

export async function reconcilePendingCaptureCommands(options = {}) {
  return reconcilePendingCaptureCommandsImpl(options);
}
