import {queryAll, withTransaction} from '../../../db/init.js';
import {captureAgentLivenessOnline} from '../../../services/capture-cloud.js';
import {
  createElasticCaptureLeaseReconciler,
} from '../application/lease-reconciliation.js';
import {
  appendEvent,
  projectOrchestrationChildControlOutcome,
  safeJson,
  text,
} from '../application/control-outcome-projection.js';
import {
  captureItemRequiresLocalClosureReuseFence,
  loadVerifiedCaptureLocalClosureProof,
} from './postgres-local-closure-proof.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN = 10;

async function reconcileElasticCaptureLeasesInPostgres(input = 50) {
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
    SELECT child.id, child.tenant_id, child.parent_task_id,
      source_item.id AS item_id
    FROM capture_tasks child
    JOIN capture_tasks parent
      ON parent.id = child.parent_task_id
      AND parent.tenant_id = child.tenant_id
    JOIN capture_agents agent
      ON agent.id = child.assigned_agent_id
      AND agent.tenant_id = child.tenant_id
    LEFT JOIN LATERAL (
      SELECT item.id
      FROM capture_task_items item
      WHERE item.tenant_id = child.tenant_id
        AND item.task_id = child.parent_task_id
        AND item.execution_task_id = child.id
        AND item.assigned_agent_id = child.assigned_agent_id
      ORDER BY item.ordinal, item.id
      LIMIT 1
    ) source_item ON true
    WHERE child.parent_task_id IS NOT NULL
      AND child.status IN (
        'pending', 'claimed', 'running', 'recovering', 'waiting_device'
      )
      AND COALESCE(parent.metadata->>'distributionMode', '') = 'elastic_pool'
      AND parent.status NOT IN (
        'completed', 'completed_with_warnings', 'completed_with_failures',
        'failed', 'canceled', 'skipped', 'superseded'
      )
      AND COALESCE(
        agent.last_liveness_at,
        agent.last_full_heartbeat_at,
        agent.last_heartbeat_at,
        '-infinity'::timestamptz
      ) < now() - make_interval(mins => $1::integer)
      AND COALESCE(
        child.heartbeat_at,
        child.updated_at,
        child.started_at,
        child.created_at
      ) < now() - make_interval(mins => $1::integer)
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

  const scannedItemKeys = new Set([
    ...candidates.map(candidate => {
      const itemId = text(candidate.item_id, 100);
      return itemId ? `item:${itemId}` : `execution:${text(candidate.id, 100)}`;
    }),
  ]);
  const summary = {
    scanned: scannedItemKeys.size,
    requeued: 0,
    skipped: 0,
    sourceClosureBlocked: 0,
    sourceClosureBlockers: [],
  };
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
        SELECT child.*,
          agent.last_heartbeat_at AS agent_last_heartbeat_at,
          agent.last_liveness_at AS agent_last_liveness_at,
          agent.last_full_heartbeat_at AS agent_last_full_heartbeat_at,
          agent.capabilities AS agent_capabilities
        FROM capture_tasks child
        JOIN capture_agents agent
          ON agent.id = child.assigned_agent_id
          AND agent.tenant_id = child.tenant_id
        WHERE child.id = $1 AND child.tenant_id = $2
          AND child.parent_task_id = $3
          AND child.status IN (
            'pending', 'claimed', 'running', 'recovering', 'waiting_device'
          )
          AND COALESCE(
            agent.last_liveness_at,
            agent.last_full_heartbeat_at,
            agent.last_heartbeat_at,
            '-infinity'::timestamptz
          ) < now() - make_interval(mins => $4::integer)
          AND COALESCE(
            child.heartbeat_at,
            child.updated_at,
            child.started_at,
            child.created_at
          ) < now() - make_interval(mins => $4::integer)
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
      const agentView = {
        last_heartbeat_at: child.agent_last_heartbeat_at,
        last_liveness_at: child.agent_last_liveness_at,
        last_full_heartbeat_at: child.agent_last_full_heartbeat_at,
        capabilities: child.agent_capabilities,
      };
      const agentConnected = captureAgentLivenessOnline(
        agentView,
        Date.now(),
        ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN * 60 * 1000,
      );
      const agentOffline = !agentConnected;
      const timeoutCode = agentOffline
        ? 'elastic_agent_offline_timeout'
        : 'elastic_task_heartbeat_timeout';
      const timeoutMessage = agentOffline
        ? '执行节点持续离线，工作项已退回弹性队列'
        : '执行节点在线但当前任务心跳中断，工作项已退回弹性队列';
      const sourceItem = await tx.queryOne(`
        SELECT id, item_type, assigned_agent_id, assignment_revision, keyword
        FROM capture_task_items
        WHERE tenant_id = $1
          AND task_id = $2
          AND execution_task_id = $3
          AND assigned_agent_id = $4
        ORDER BY ordinal, id
        LIMIT 1
        FOR UPDATE
      `, [
        candidate.tenant_id,
        candidate.parent_task_id,
        child.id,
        child.assigned_agent_id,
      ]);
      const sourceAttempt = sourceItem
        ? await tx.queryOne(`
            SELECT id, agent_id, attempt_number, assignment_revision
            FROM capture_task_item_attempts
            WHERE tenant_id = $1
              AND item_id = $2
              AND execution_task_id = $3
              AND agent_id = $4
            ORDER BY attempt_number DESC, created_at DESC, id DESC
            LIMIT 1
            FOR UPDATE
          `, [
            candidate.tenant_id,
            sourceItem.id,
            child.id,
            child.assigned_agent_id,
          ])
        : null;
      const requiresSourceLocalClosure =
        captureItemRequiresLocalClosureReuseFence({
          itemType: sourceItem?.item_type,
          sourceExecutionMetadata: child.metadata,
        });
      const localClosureProof = requiresSourceLocalClosure
        ? await loadVerifiedCaptureLocalClosureProof(tx, {
            tenantId: candidate.tenant_id,
            executionTaskId: child.id,
            sourceAgentId: child.assigned_agent_id,
            itemId: sourceItem?.id,
            itemAttemptId: sourceAttempt?.id,
            itemAttemptNumber: sourceAttempt?.attempt_number,
            assignmentRevision:
              sourceAttempt?.assignment_revision ??
              sourceItem?.assignment_revision,
          })
        : {proven: true, reason: 'local_closure_reuse_fence_not_required'};
      // Local closure remains diagnostic evidence only. Once the server lease
      // is stale, the assignment revision fences late writes and the item can
      // be requeued even when the browser never uploaded closure telemetry.
      const failed = await tx.queryOne(`
        UPDATE capture_tasks
        SET status = 'failed',
          metadata = metadata - 'waitingForSourceClosure' -
            'sourceClosureBlockedAt' - 'sourceClosureBlockedReason' -
            'sourceClosureBlockedAttemptId',
          error = jsonb_build_object(
            'code', $3::text,
            'message', $4::text,
            'retryable', true,
            'serverLeaseRevoked', $5::boolean
          ),
          message = $4,
          finished_at = now(),
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *
      `, [
        child.id,
        candidate.tenant_id,
        timeoutCode,
        timeoutMessage,
        agentOffline,
      ]);
      await projectOrchestrationChildControlOutcome(tx, {
        tenantId: candidate.tenant_id,
        childTask: failed,
        agentId: child.assigned_agent_id,
        status: 'retryable',
        error: {
          code: timeoutCode,
          message: timeoutMessage,
          automaticRetry: true,
          serverLeaseRevoked: agentOffline,
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
          serverLeaseRevoked: agentOffline,
          sourceLocalClosureProven: localClosureProof.proven === true,
        },
      });
      return 'requeued';
    });
    if (settled === 'requeued') {
      summary.requeued += 1;
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}

const reconcileElasticCaptureLeasesImpl =
  createElasticCaptureLeaseReconciler({
    reconcileLeases: reconcileElasticCaptureLeasesInPostgres,
  });

export async function reconcileElasticCaptureLeases(input = 50) {
  return reconcileElasticCaptureLeasesImpl(input);
}
