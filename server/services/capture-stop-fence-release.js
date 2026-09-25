import {
  RECONCILED_EVENT_MESSAGES,
  STOP_FENCE_OPERATOR_RELEASED_ITEM_CODE,
  STOP_FENCE_OPERATOR_RELEASED_REASON,
  appendStopFenceEvent,
  buildStopFenceReleaseRecord,
  enqueueStopFenceReleaseWakeup,
  stopFenceReleaseItemOutcome,
  stopFenceReleaseOutcomeSentence,
} from './capture-stop-fence.js';

// docs/hotfix/20260925-needs-action-fence.md. A batch child that the
// Extension left in needs_action with PREVIOUS_CAPTURE_STOP_UNCONFIRMED can
// neither be resumed nor skipped on the node, and the batch never hands its
// keywords on. Only an explicit operator confirmation ends it here. Unlike the
// check protocol in capture-stop-fence.js (which never reads commands, never
// changes a status and never moves updated_at), this is a real status
// transition to `superseded`, written in the same release format.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function text(value, limit = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, limit);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  const ms = typeof now === 'number' ? now : Date.parse(String(now ?? ''));
  return Number.isFinite(ms) ? ms : Date.now();
}

function uniqueUuids(values, limit = 200) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => text(value, 100).toLowerCase())
      .filter(value => UUID.test(value)),
  )].sort().slice(0, limit);
}

const NEEDS_ACTION_RELEASE_MESSAGE = '已人工确认旧采集页面已停止，本执行结束';

/**
 * Operator release of needs_action batch children (the operator selected each
 * id explicitly). Each row becomes `superseded` in the same format as a
 * superseded release, which the heartbeat mirror can no longer rewrite, and
 * leaves the fence. The caller hands the work items back to the batch
 * (projectOrchestrationChildControlOutcome) and then records the actual
 * outcome with recordNeedsActionStopFenceOutcome. A row with a remote command
 * in flight (for example a stop the operator just requested) is skipped.
 */
export async function releaseNeedsActionStopFences(tx, {
  tenantId,
  agentId,
  taskIds = [],
  requestedBy = '',
  actorId = '',
  note = '',
  requestLocalRelease = false,
  now = Date.now(),
}) {
  const ids = uniqueUuids(taskIds);
  const scopedTenantId = text(tenantId, 100);
  const scopedAgentId = text(agentId, 100).toLowerCase();
  const result = {released: [], skipped: []};
  if (ids.length === 0 || !scopedTenantId || !UUID.test(scopedAgentId)) return result;
  const current = nowMs(now);
  const rows = await tx.queryAll(`
    SELECT id, parent_task_id, task_type, status, error, metadata,
      client_task_id, control_task_id
    FROM capture_tasks
    WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      AND COALESCE(assigned_agent_id, origin_agent_id) = $3
      AND status = 'needs_action'
      AND parent_task_id IS NOT NULL
      AND task_type = 'unattended_keyword_capture'
      AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
      AND NULLIF(metadata->>'recoveryTaskId', '') IS NULL
    ORDER BY id
    FOR UPDATE
  `, [scopedTenantId, ids, scopedAgentId]);
  const found = new Set(rows.map(row => String(row.id).toLowerCase()));
  for (const id of ids) {
    if (!found.has(id)) result.skipped.push({id, reason: 'not_releasable'});
  }
  if (rows.length === 0) return result;
  // Read only. Every route that creates a stop/resume command locks the task
  // row first, and this transaction holds it; a command that completes
  // meanwhile only leaves `pending`, so seeing it is the conservative side.
  const busy = await tx.queryAll(`
    SELECT DISTINCT task_id FROM capture_agent_commands
    WHERE tenant_id = $1 AND task_id = ANY($2::uuid[])
      AND status IN ('pending', 'acknowledged') AND expires_at > now()
  `, [scopedTenantId, rows.map(row => row.id)]);
  const busyIds = new Set(busy.map(row => String(row.task_id).toLowerCase()));
  for (const row of rows) {
    if (busyIds.has(String(row.id).toLowerCase())) {
      result.skipped.push({id: row.id, reason: 'command_in_flight'});
      continue;
    }
    const {originalError, reconciliation, check} = buildStopFenceReleaseRecord(row, {
      current,
      reason: 'operator_confirmed_needs_action_released',
      proofStatus: 'operator_confirmed',
      requestedBy,
      agentId: scopedAgentId,
      note,
      actorId,
      requestLocalRelease,
      extra: {releasedFromStatus: 'needs_action'},
    });
    // A real status transition: updated_at moves like any dispatch that sets
    // superseded. The fence code leaves in the same statement, so the
    // 976a0c6 comparison against historical_stop.updated_at never sees it.
    // terminalReason alone marks the release (stopFenceReleasedRetrySource,
    // the pending-retry scan and the adoption guard read it). No
    // terminalDisposition, like the superseded release: an operator-stopped
    // batch counts a child carrying one as unsettled until a terminal notice
    // is acknowledged, keyword children never get that notice, and the batch
    // would stay in waiting_device for good.
    const updated = await tx.queryOne(`
      UPDATE capture_tasks
      SET status = 'superseded',
        error = COALESCE(error, '{}'::jsonb) || jsonb_build_object(
          'code', 'HISTORICAL_STOP_FENCE_RECONCILED',
          'originalCode', 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'),
        message = $5,
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'historicalStopFenceReconciliation', $3::jsonb,
            'terminalReason', $6::text),
          '{stopFenceCheck}', $4::jsonb),
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
      WHERE tenant_id = $1 AND id = $2
        AND status = 'needs_action'
        AND UPPER(COALESCE(error->>'code', '')) = 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'
      RETURNING id, parent_task_id, task_type, status, metadata
    `, [
      scopedTenantId,
      row.id,
      JSON.stringify(reconciliation),
      JSON.stringify(check),
      NEEDS_ACTION_RELEASE_MESSAGE,
      STOP_FENCE_OPERATOR_RELEASED_REASON,
    ]);
    if (!updated) {
      result.skipped.push({id: row.id, reason: 'not_releasable'});
      continue;
    }
    result.released.push({
      id: updated.id,
      parentTaskId: updated.parent_task_id,
      row: updated,
      originalError,
    });
  }
  if (result.released.length > 0) {
    await enqueueStopFenceReleaseWakeup(tx, {tenantId: scopedTenantId, agentId: scopedAgentId});
  }
  return result;
}

/**
 * The work items the operator release handed back for one child, read after
 * the projection. Only this path writes STOP_FENCE_OPERATOR_RELEASED_ITEM_CODE,
 * so the rows it matches are exactly the rows this projection changed.
 */
export async function readNeedsActionReleaseItemOutcome(tx, {
  tenantId,
  parentTaskId,
  taskId,
  parentBefore = null,
}) {
  const counts = await tx.queryAll(`
    SELECT status, COUNT(*)::int AS count
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2 AND execution_task_id = $3
      AND error->>'code' = $4
    GROUP BY status
  `, [text(tenantId, 100), parentTaskId, taskId, STOP_FENCE_OPERATOR_RELEASED_ITEM_CODE]);
  return stopFenceReleaseItemOutcome(counts, parentBefore);
}

/**
 * Write the actual outcome of one needs_action release: the child message,
 * historicalStopFenceReconciliation.itemOutcome and the release event. The
 * row is already locked in this transaction.
 */
export async function recordNeedsActionStopFenceOutcome(tx, {
  tenantId,
  agentId,
  taskId,
  itemOutcome,
  originalError = {},
  actorType = 'user',
  actorId = '',
  actorName = '',
}) {
  const outcome = object(itemOutcome);
  const sentence = stopFenceReleaseOutcomeSentence(outcome);
  await tx.execute(`
    UPDATE capture_tasks
    SET message = $3,
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{historicalStopFenceReconciliation,itemOutcome}',
        $4::jsonb)
    WHERE tenant_id = $1 AND id = $2
      AND status = 'superseded'
      AND metadata ? 'historicalStopFenceReconciliation'
  `, [text(tenantId, 100), taskId, `${NEEDS_ACTION_RELEASE_MESSAGE}；${sentence}`, JSON.stringify(outcome)]);
  await appendStopFenceEvent(tx, {
    tenantId: text(tenantId, 100),
    taskId,
    agentId: text(agentId, 100).toLowerCase() || null,
    eventType: 'historical_stop_fence_reconciled',
    actorType,
    actorId,
    actorName,
    status: 'superseded',
    message: `${RECONCILED_EVENT_MESSAGES.operator_confirmed(actorName)}；该执行结束，${sentence}`,
    payload: {
      proofStatus: 'operator_confirmed',
      reason: 'operator_confirmed_needs_action_released',
      originalError: object(originalError),
      checkId: '',
      releasedFromStatus: 'needs_action',
      itemOutcome: outcome,
    },
  });
  return sentence;
}

