import {queryAll, withTransaction} from '../../../db/init.js';
import {
  captureAgentLivenessAt,
  captureAgentOnline,
} from '../../../services/capture-cloud.js';
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
  ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN,
} from './postgres-lease-reconciliation.js';
import {
  failProfileDiscoveryWork,
} from './postgres-profile-discovery-work.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function captureCreateCommandExpiryEligible({
  status = '',
  commandType = '',
  lastLivenessAt = '',
  lastFullHeartbeatAt = '',
  lastHeartbeatAt = '',
  taskStatus = '',
  taskHeartbeatAt = '',
  taskStartedAt = '',
  executionAttemptObserved = false,
} = {}, now = Date.now(), livenessGraceMs =
  ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN * 60 * 1000) {
  const normalizedStatus = text(status, 40).toLowerCase();
  if (normalizedStatus === 'pending') return true;
  if (normalizedStatus !== 'acknowledged') return false;
  if (text(commandType, 40).toLowerCase() !== 'create') return true;
  const effectiveLivenessAt = captureAgentLivenessAt({
    last_liveness_at: lastLivenessAt,
    last_full_heartbeat_at: lastFullHeartbeatAt,
    last_heartbeat_at: lastHeartbeatAt,
  });
  if (!captureAgentOnline(effectiveLivenessAt, now, livenessGraceMs)) {
    return true;
  }
  // Delivery acknowledges a command before the Extension creates its local
  // task. An online Agent cannot retain an expired create indefinitely without
  // a task heartbeat, start time, or client execution attempt.
  return ['pending', 'claimed'].includes(
    text(taskStatus, 40).toLowerCase(),
  ) && !taskHeartbeatAt && !taskStartedAt && executionAttemptObserved !== true;
}

export function captureCreateCommandExpiredBeforeOpen({
  error = {},
  executionStartedAt = null,
  itemStartedAt = null,
  attemptStartedAt = null,
} = {}) {
  const normalizedError = safeJson(error);
  return Boolean(
    !executionStartedAt &&
      !itemStartedAt &&
      !attemptStartedAt &&
      text(normalizedError.code, 100).toLowerCase() ===
        'create_command_expired' &&
      text(normalizedError.commandStatusBeforeExpiry, 40).toLowerCase() ===
        'pending',
  );
}

export function captureExecutionNeverOpened({
  executionTaskId = '',
  error = {},
  sourceExecutionMetadata = {},
  executionStartedAt = null,
  itemStartedAt = null,
  attemptStartedAt = null,
  attemptExists = false,
  attemptCount = 0,
} = {}) {
  if (executionStartedAt || itemStartedAt || attemptStartedAt) return false;
  const normalizedError = safeJson(error);
  const normalizedMetadata = safeJson(sourceExecutionMetadata);
  if (
    (
      text(normalizedError.code, 100).toLowerCase() ===
        'create_agent_unavailable' &&
      text(normalizedError.commandStatusBefore, 40).toLowerCase() === 'pending'
    ) ||
    normalizedMetadata.stoppedBeforeDispatch === true
  ) {
    return true;
  }
  if (captureCreateCommandExpiredBeforeOpen({
    error: normalizedError,
    executionStartedAt,
    itemStartedAt,
    attemptStartedAt,
  })) {
    return true;
  }
  return !text(executionTaskId, 100) &&
    Math.max(0, Number(attemptCount) || 0) === 0 &&
    attemptExists !== true;
}


export async function expireStaleCommands(tx, tenantId, taskId = null, agentId = null) {
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
  // An acknowledged create may already be running locally even when its full
  // task snapshot is delayed. Protect that execution with the liveness lease,
  // but expire an online Agent's unstarted create when no task evidence exists.
  // Pending creates and non-create commands keep their normal expiry semantics.
  const expiryCandidates = await tx.queryAll(`
    SELECT c.id, c.status, c.command_type,
      COALESCE(
        ca.last_liveness_at,
        ca.last_full_heartbeat_at,
        ca.last_heartbeat_at
      ) AS agent_liveness_at,
      task.status AS task_status,
      task.heartbeat_at AS task_heartbeat_at,
      task.started_at AS task_started_at,
      EXISTS (
        SELECT 1
        FROM capture_task_attempts task_attempt
        WHERE task_attempt.tenant_id = c.tenant_id
          AND task_attempt.task_id = c.task_id
          AND task_attempt.client_attempt_id <> ''
      ) AS execution_attempt_observed
    FROM capture_agent_commands c
    JOIN capture_tasks task
      ON task.id = c.task_id AND task.tenant_id = c.tenant_id
    LEFT JOIN capture_agents ca
      ON ca.id = c.agent_id AND ca.tenant_id = c.tenant_id
    WHERE c.tenant_id = $1
      AND ($2 = '' OR c.task_id::text = $2)
      AND ($3 = '' OR c.agent_id::text = $3)
      AND c.status IN ('pending', 'acknowledged')
      AND c.expires_at <= now()
      AND (
        c.status = 'pending'
        OR c.command_type <> 'create'
        OR (
          task.status IN ('pending', 'claimed')
          AND task.heartbeat_at IS NULL
          AND task.started_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM capture_task_attempts task_attempt
            WHERE task_attempt.tenant_id = c.tenant_id
              AND task_attempt.task_id = c.task_id
              AND task_attempt.client_attempt_id <> ''
          )
        )
        OR COALESCE(
          ca.last_liveness_at,
          ca.last_full_heartbeat_at,
          ca.last_heartbeat_at,
          '-infinity'::timestamptz
        ) < now() - make_interval(mins => $4::integer)
      )
    ORDER BY c.id
    FOR UPDATE OF c
  `, [
    tenantId,
    scopedTaskId,
    scopedAgentId,
    ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN,
  ]);
  const expiryCandidateIds = expiryCandidates
    .filter(command => captureCreateCommandExpiryEligible({
      status: command.status,
      commandType: command.command_type,
      lastLivenessAt: command.agent_liveness_at,
      taskStatus: command.task_status,
      taskHeartbeatAt: command.task_heartbeat_at,
      taskStartedAt: command.task_started_at,
      executionAttemptObserved: command.execution_attempt_observed,
    }))
    .map(command => command.id);
  const expiryCandidateStatusById = new Map(
    expiryCandidates.map(command => [
      String(command.id),
      text(command.status, 40).toLowerCase(),
    ]),
  );
  const expired = expiryCandidateIds.length > 0 ? await tx.queryAll(`
    UPDATE capture_agent_commands
    SET status = 'expired',
      result = jsonb_build_object('reason', 'expired'),
      finished_at = now(), updated_at = now()
    WHERE tenant_id = $1
      AND ($2 = '' OR task_id::text = $2)
      AND ($3 = '' OR agent_id::text = $3)
      AND id = ANY($4::uuid[])
      AND status IN ('pending', 'acknowledged')
      AND expires_at <= now()
      AND (
        status = 'pending'
        OR command_type <> 'create'
        OR EXISTS (
          SELECT 1
          FROM capture_tasks task
          WHERE task.id = capture_agent_commands.task_id
            AND task.tenant_id = capture_agent_commands.tenant_id
            AND task.status IN ('pending', 'claimed')
            AND task.heartbeat_at IS NULL
            AND task.started_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM capture_task_attempts task_attempt
              WHERE task_attempt.tenant_id = capture_agent_commands.tenant_id
                AND task_attempt.task_id = capture_agent_commands.task_id
                AND task_attempt.client_attempt_id <> ''
            )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM capture_agents ca
          WHERE ca.id = capture_agent_commands.agent_id
            AND ca.tenant_id = capture_agent_commands.tenant_id
            AND COALESCE(
              ca.last_liveness_at,
              ca.last_full_heartbeat_at,
              ca.last_heartbeat_at,
              '-infinity'::timestamptz
            ) >= now() - make_interval(mins => $5::integer)
        )
      )
    RETURNING id, task_id, agent_id, command_type, payload
  `, [
    tenantId,
    scopedTaskId,
    scopedAgentId,
    expiryCandidateIds,
    ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN,
  ]) : [];

  for (const command of expired) {
    if (command.command_type === 'create') {
      const commandStatusBeforeExpiry =
        expiryCandidateStatusById.get(String(command.id)) || '';
      const failedTask = await tx.queryOne(`
        UPDATE capture_tasks
        SET status = 'failed',
          message = '设备创建指令已过期，任务未执行',
          error = jsonb_build_object(
            'code', 'create_command_expired',
            'message', '设备未在指令有效期内领取并创建任务',
            'commandStatusBeforeExpiry', $4::text
          ),
          finished_at = now(),
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
          AND status IN ('pending', 'claimed')
          AND metadata->>'createCommandId' = $3
        RETURNING id, status, parent_task_id, task_type, metadata
      `, [
        command.task_id,
        tenantId,
        command.id,
        commandStatusBeforeExpiry,
      ]);
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
            commandStatusBeforeExpiry,
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
      result = jsonb_build_object(
        'reason', 'agent_inactive',
        'commandStatusBefore', c.status
      ),
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
            OR c.payload->>'executionMode' <> 'source_open'
            OR ca.capabilities->>'xiaohongshuSourceOpenV1' = 'true'
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
    RETURNING id, task_id, agent_id, command_type, payload,
      result->>'commandStatusBefore' AS command_status_before
  `, [tenantId, scopedTaskId, scopedAgentId]);
  for (const command of unavailable) {
    if (command.command_type === 'create') {
      const commandStatusBefore = text(
        command.command_status_before,
        40,
      ).toLowerCase();
      const failedTask = await tx.queryOne(`
        UPDATE capture_tasks
        SET status = 'needs_action',
          message = '目标节点授权或平台职责已变化，任务未执行',
          error = jsonb_build_object(
            'code', 'create_agent_unavailable',
            'message', '目标节点授权或平台职责已变化',
            'commandStatusBefore', $4::text
          ),
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
          AND status IN ('pending', 'claimed')
          AND metadata->>'createCommandId' = $3
        RETURNING id, status, parent_task_id, task_type, metadata
      `, [command.task_id, tenantId, command.id, commandStatusBefore]);
      await appendEvent(tx, {
        tenantId,
        taskId: command.task_id,
        agentId: command.agent_id,
        eventType: 'create_command_canceled_agent_unavailable',
        status: failedTask?.status || '',
        message: failedTask
          ? '目标节点授权或平台职责已变化，创建指令已取消'
          : '目标任务已有更新状态，旧创建指令已取消',
        payload: {
          commandId: command.id,
          commandType: command.command_type,
          commandStatusBefore,
        },
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
            commandStatusBefore,
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

const reconcilePendingCaptureCommandsImpl =
  createPendingCaptureCommandReconciler({
    listPendingTenants: limit => queryAll(`
      SELECT tenant_id, MIN(created_at) AS oldest_command_at
      FROM capture_agent_commands
      WHERE status IN ('pending', 'acknowledged')
      GROUP BY tenant_id
      ORDER BY MIN(created_at), tenant_id
      LIMIT $1
    `, [limit]),
    withTransaction,
    expireTenantCommands: (tx, tenantId) =>
      expireStaleCommands(tx, tenantId),
  });

export async function reconcilePendingCaptureCommands(options = {}) {
  const scopedTenantId = text(options.tenantId, 100).toLowerCase();
  const scopedTaskId = text(options.taskId, 100).toLowerCase();
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
  return reconcilePendingCaptureCommandsImpl(options);
}
