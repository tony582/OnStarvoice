import {queryAll, withTransaction} from '../../../db/init.js';
import {
  createElasticCaptureLeaseReconciler,
} from '../application/lease-reconciliation.js';
import {
  appendEvent,
  projectOrchestrationChildControlOutcome,
} from '../application/control-outcome-projection.js';

const ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN = 10;

async function listElasticCaptureLeaseCandidates(limit) {
  return queryAll(`
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
    ORDER BY child.updated_at, child.id
    LIMIT $2
  `, [ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN, limit]);
}

async function settleElasticCaptureLeaseCandidate(tx, candidate) {
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
}

const reconcileElasticCaptureLeasesImpl =
  createElasticCaptureLeaseReconciler({
    listCandidates: listElasticCaptureLeaseCandidates,
    withTransaction,
    settleCandidate: settleElasticCaptureLeaseCandidate,
  });

export async function reconcileElasticCaptureLeases(limit = 50) {
  return reconcileElasticCaptureLeasesImpl(limit);
}
