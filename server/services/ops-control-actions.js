import {createHash} from 'node:crypto';
import {
  execute as dbExecute,
  queryAll as dbQueryAll,
  queryOne as dbQueryOne,
  withTransaction as dbWithTransaction,
} from '../db/init.js';

const ACTION_POLICY_VERSION = 'ops-guarded-v1';
const ACTION_INCIDENT_MAP = Object.freeze({
  final_task_failure: 'capture_retry',
  schedule_occurrence_missing: 'schedule_materialize',
  capture_command_stale: 'command_reconcile',
  capture_task_stalled: 'elastic_requeue',
});
const ACTION_TARGET_TYPES = Object.freeze({
  capture_retry: 'capture_task',
  schedule_materialize: 'capture_schedule',
  command_reconcile: 'capture_task',
  elastic_requeue: 'capture_task',
});
const OPEN_ACTION_STATUSES = new Set(['claimed', 'pending_verification']);
const RETRYABLE_ACTION_STATUSES = new Set(['failed', 'skipped']);

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function integer(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function actionKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function taskById(snapshot, taskId) {
  return (Array.isArray(snapshot?.tasks) ? snapshot.tasks : [])
    .find(task => String(task.id) === String(taskId)) || null;
}

function scheduleById(snapshot, scheduleId) {
  return (Array.isArray(snapshot?.schedules) ? snapshot.schedules : [])
    .find(schedule => String(schedule.id) === String(scheduleId)) || null;
}

function taskFailureCount(task) {
  if (!task) return 0;
  const itemFailures = integer(task.failedItemCount)
    + integer(task.skippedItemCount)
    + integer(task.needsActionItemCount);
  if (itemFailures > 0) return itemFailures;
  return ['failed', 'completed_with_failures', 'skipped'].includes(task.status) ? 1 : 0;
}

function beforeFacts(actionType, targetId, snapshot) {
  if (['capture_retry', 'elastic_requeue'].includes(actionType)) {
    const task = taskById(snapshot, targetId);
    return {
      taskStatus: text(task?.status, 80),
      failureCount: taskFailureCount(task),
      recoveredItemCount: integer(task?.recoveredItemCount),
      progressSeq: integer(task?.progressSeq),
      businessProgressAt: task?.businessProgressAt || null,
    };
  }
  if (actionType === 'schedule_materialize') {
    const schedule = scheduleById(snapshot, targetId);
    return {
      occurrenceState: text(schedule?.occurrenceState, 80),
      lastRunTaskId: text(schedule?.lastRunTaskId, 100),
    };
  }
  return {
    activeCommandCount: integer(snapshot?.operations?.activeCommandCount),
    oldestActiveCommandTaskId: text(
      snapshot?.operations?.oldestActiveCommandTaskId,
      100,
    ),
  };
}

export function selectOpsControlActionCandidates(
  assessment,
  snapshot,
  {allowlist = []} = {},
) {
  if (assessment?.summary?.consecutiveEvidence !== true) return [];
  const allowed = new Set(Array.isArray(allowlist) ? allowlist : []);
  const candidates = [];
  const seen = new Set();
  for (const incident of Array.isArray(assessment?.incidents)
    ? assessment.incidents
    : []) {
    const actionType = ACTION_INCIDENT_MAP[incident.type];
    if (!actionType || !allowed.has(actionType)) continue;
    const targetId = text(
      incident.evidence?.taskId
        || incident.evidence?.scheduleId
        || incident.targetId,
      100,
    );
    if (!targetId) continue;
    if (actionType === 'elastic_requeue') {
      const task = taskById(snapshot, targetId);
      if (task?.distributionMode !== 'elastic_pool') continue;
    }
    const key = `${actionType}:${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      actionType,
      targetType: ACTION_TARGET_TYPES[actionType],
      targetId,
      incidentFingerprint: incident.fingerprint,
      incidentType: incident.type,
      evidence: object(incident.evidence),
      before: beforeFacts(actionType, targetId, snapshot),
    });
  }
  return candidates;
}

export function verifyOpsControlAction(action, snapshot, {now = new Date()} = {}) {
  const actionType = text(action?.action_type || action?.actionType, 80);
  const targetId = text(action?.target_id || action?.targetId, 100);
  const request = object(action?.request);
  const before = object(request.before);
  const dueAt = timestamp(action?.verification_due_at || action?.verificationDueAt);
  const expired = dueAt > 0 && now.getTime() >= dueAt;
  const pending = details => ({status: expired ? 'failed' : 'pending_verification', details});

  if (actionType === 'schedule_materialize') {
    const schedule = scheduleById(snapshot, targetId);
    if (schedule?.occurrenceState === 'observed' || (
      schedule?.lastRunTaskId
      && schedule.lastRunTaskId !== before.lastRunTaskId
    )) {
      return {status: 'verified', details: {occurrenceState: schedule.occurrenceState}};
    }
    return pending({reason: expired ? 'schedule_verification_timeout' : 'schedule_not_materialized'});
  }

  if (actionType === 'command_reconcile') {
    const currentCount = integer(snapshot?.operations?.activeCommandCount);
    const currentTaskId = text(snapshot?.operations?.oldestActiveCommandTaskId, 100);
    if (
      currentCount < integer(before.activeCommandCount)
      || (before.oldestActiveCommandTaskId && currentTaskId !== before.oldestActiveCommandTaskId)
    ) {
      return {status: 'verified', details: {activeCommandCount: currentCount}};
    }
    return pending({reason: expired ? 'command_verification_timeout' : 'command_still_active'});
  }

  const task = taskById(snapshot, targetId);
  if (!task) return pending({reason: expired ? 'task_missing_at_deadline' : 'task_not_in_snapshot'});
  const currentFailures = taskFailureCount(task);
  const recoveredAdvanced = integer(task.recoveredItemCount)
    > integer(before.recoveredItemCount);
  const progressAdvanced = integer(task.progressSeq) > integer(before.progressSeq)
    || timestamp(task.businessProgressAt) > timestamp(before.businessProgressAt);

  if (actionType === 'capture_retry') {
    if (recoveredAdvanced || (
      currentFailures === 0
      && !task.active
      && ['completed', 'completed_with_warnings'].includes(task.status)
    )) {
      return {
        status: 'verified',
        details: {taskStatus: task.status, currentFailures, recoveredAdvanced},
      };
    }
    return pending({
      reason: expired ? 'capture_retry_verification_timeout' : 'capture_retry_in_progress',
      progressAdvanced,
      currentFailures,
    });
  }

  if (actionType === 'elastic_requeue' && (
    progressAdvanced || task.recovering || recoveredAdvanced
  )) {
    return {
      status: 'verified',
      details: {taskStatus: task.status, progressAdvanced, recoveredAdvanced},
    };
  }
  return pending({reason: expired ? 'elastic_requeue_verification_timeout' : 'elastic_requeue_pending'});
}

async function loadDefaultHandlers() {
  const [capture, scheduler] = await Promise.all([
    import('../routes/capture-cloud.js'),
    import('./capture-orchestration-scheduler.js'),
  ]);
  return {
    capture_retry: ({tenantId, targetId}) =>
      capture.reconcileAutomaticCaptureRetries({
        tenantId,
        taskIds: [targetId],
        limit: 1,
        maxDispatchesPerTask: 1,
        requestedByName: '无人值守控制面',
      }),
    schedule_materialize: ({tenantId, targetId}) =>
      scheduler.enqueueDueCaptureOrchestrations({
        tenantId,
        scheduleIds: [targetId],
        limit: 1,
      }),
    command_reconcile: ({tenantId, targetId}) =>
      capture.reconcilePendingCaptureCommands({tenantId, taskId: targetId}),
    elastic_requeue: ({tenantId, targetId}) =>
      capture.reconcileElasticCaptureLeases({
        tenantId,
        parentTaskIds: [targetId],
        limit: 1,
      }),
  };
}

function executionProjection(actionType, result) {
  if (actionType === 'capture_retry') {
    if (integer(result?.dispatched) > 0) return {status: 'pending_verification'};
    if (integer(result?.manualOnly) > 0) return {status: 'blocked'};
    if ((result?.results || []).some(row => row.action === 'existing')) {
      return {status: 'pending_verification'};
    }
    if (integer(result?.failed) > 0 || result?.error) return {status: 'failed'};
    return {status: 'skipped'};
  }
  if (actionType === 'schedule_materialize') {
    const rows = Array.isArray(result) ? result : [];
    if (rows.some(row => ['created', 'existing'].includes(row?.kind))) {
      return {status: 'pending_verification'};
    }
    if (rows.some(row => row?.kind === 'invalid_tenant_id')) return {status: 'failed'};
    return {status: 'skipped'};
  }
  if (actionType === 'command_reconcile') {
    if (result?.error) return {status: 'failed'};
    return {status: integer(result?.commandCount) > 0 ? 'pending_verification' : 'skipped'};
  }
  if (result?.error) return {status: 'failed'};
  return {status: integer(result?.requeued) > 0 ? 'pending_verification' : 'skipped'};
}

async function verifyPendingActions({
  tenantId,
  runId,
  sequence,
  snapshot,
  now,
  queryAll,
  execute,
}) {
  const actions = await queryAll(`
    SELECT *
    FROM ops_control_actions
    WHERE tenant_id = $1 AND run_id = $2
      AND status = 'pending_verification'
    ORDER BY created_at, id
    LIMIT 20
  `, [tenantId, runId]);
  let verified = 0;
  let verificationFailed = 0;
  for (const action of actions) {
    const verification = verifyOpsControlAction(action, snapshot, {now});
    if (verification.status === 'pending_verification') continue;
    await execute(`
      UPDATE ops_control_actions
      SET status = $3,
        snapshot_after_sequence = $4,
        verification = $5::jsonb,
        verified_at = CASE WHEN $3 = 'verified' THEN $6 ELSE verified_at END,
        last_error = CASE WHEN $3 = 'failed' THEN $7 ELSE '' END,
        updated_at = $6
      WHERE id = $1 AND tenant_id = $2
        AND status = 'pending_verification'
    `, [
      action.id,
      tenantId,
      verification.status,
      sequence,
      JSON.stringify(verification.details),
      now.toISOString(),
      verification.details?.reason || '',
    ]);
    if (verification.status === 'verified') verified += 1;
    else verificationFailed += 1;
  }
  return {verified, verificationFailed};
}

async function claimAction({
  tenantId,
  run,
  sequence,
  candidate,
  policy,
  now,
  withTransaction,
}) {
  return withTransaction(async tx => {
    const lockedRun = await tx.queryOne(`
      SELECT id
      FROM ops_control_runs
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE
    `, [run.id, tenantId]);
    if (!lockedRun) return {kind: 'run_missing'};
    const runCount = await tx.queryOne(`
      SELECT COUNT(*)::int AS count
      FROM ops_control_actions
      WHERE tenant_id = $1 AND run_id = $2
    `, [tenantId, run.id]);
    if (integer(runCount?.count) >= policy.actionMaxPerRun) {
      return {kind: 'run_limit'};
    }
    const latest = await tx.queryOne(`
      SELECT *
      FROM ops_control_actions
      WHERE tenant_id = $1 AND run_id = $2
        AND action_type = $3 AND target_id = $4
      ORDER BY attempt_number DESC, created_at DESC
      LIMIT 1
      FOR UPDATE
    `, [tenantId, run.id, candidate.actionType, candidate.targetId]);
    if (latest && (
      OPEN_ACTION_STATUSES.has(latest.status)
      || latest.status === 'verified'
      || latest.status === 'blocked'
    )) return {kind: 'existing', action: latest};
    const attemptNumber = integer(latest?.attempt_number) + 1;
    if (attemptNumber > policy.actionMaxAttempts) return {kind: 'attempt_limit'};
    if (
      latest
      && RETRYABLE_ACTION_STATUSES.has(latest.status)
      && now.getTime() - timestamp(latest.updated_at) < policy.actionCooldownSeconds * 1000
    ) return {kind: 'cooldown'};

    const incident = await tx.queryOne(`
      SELECT id
      FROM ops_control_incidents
      WHERE tenant_id = $1 AND run_id = $2 AND fingerprint = $3
      LIMIT 1
    `, [tenantId, run.id, candidate.incidentFingerprint]);
    const idempotencyKey = actionKey([
      run.id,
      candidate.actionType,
      candidate.targetId,
      attemptNumber,
    ]);
    const request = {
      incidentType: candidate.incidentType,
      evidence: candidate.evidence,
      before: candidate.before,
      actionAllowlist: policy.actionAllowlist,
    };
    const action = await tx.queryOne(`
      INSERT INTO ops_control_actions (
        run_id, tenant_id, incident_id,
        action_type, target_type, target_id,
        status, attempt_number, idempotency_key, policy_version,
        snapshot_before_sequence, request, claimed_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        'claimed', $7, $8, $9,
        $10, $11::jsonb, $12, $12, $12
      )
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING *
    `, [
      run.id,
      tenantId,
      incident?.id || null,
      candidate.actionType,
      candidate.targetType,
      candidate.targetId,
      attemptNumber,
      idempotencyKey,
      ACTION_POLICY_VERSION,
      sequence,
      JSON.stringify(request),
      now.toISOString(),
    ]);
    return action ? {kind: 'claimed', action} : {kind: 'existing'};
  });
}

async function summarizeActions({tenantId, runId, queryAll}) {
  const actions = await queryAll(`
    SELECT id, incident_id, action_type, target_type, target_id,
      status, attempt_number, snapshot_before_sequence,
      snapshot_after_sequence, result, verification, last_error,
      claimed_at, executed_at, verification_due_at, verified_at,
      created_at, updated_at
    FROM ops_control_actions
    WHERE tenant_id = $1 AND run_id = $2
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `, [tenantId, runId]);
  const count = status => actions.filter(action => action.status === status).length;
  return {
    total: actions.length,
    pendingVerification: count('pending_verification'),
    verified: count('verified'),
    failed: count('failed'),
    blocked: count('blocked'),
    skipped: count('skipped'),
    actions,
  };
}

async function persistActionSummary({tenantId, runId, summary, now, execute}) {
  const payload = {
    total: summary.total,
    pendingVerification: summary.pendingVerification,
    verified: summary.verified,
    failed: summary.failed,
    blocked: summary.blocked,
    skipped: summary.skipped,
  };
  await execute(`
    UPDATE ops_control_runs
    SET summary = summary || jsonb_build_object('actions', $3::jsonb),
      updated_at = GREATEST(updated_at, $4::timestamptz)
    WHERE id = $1 AND tenant_id = $2
  `, [runId, tenantId, JSON.stringify(payload), now.toISOString()]);
  await execute(`
    UPDATE ops_control_digests
    SET payload = payload || jsonb_build_object('actions', $3::jsonb),
      updated_at = GREATEST(updated_at, $4::timestamptz)
    WHERE run_id = $1 AND tenant_id = $2
  `, [runId, tenantId, JSON.stringify(payload), now.toISOString()]);
}

export async function runOpsControlGuardedActions({
  tenantId,
  run,
  sequence,
  snapshot,
  assessment,
  policy,
  now = new Date(),
  handlers,
  withTransaction = dbWithTransaction,
  queryAll = dbQueryAll,
  execute = dbExecute,
} = {}) {
  await execute(`
    UPDATE ops_control_actions
    SET status = 'failed',
      last_error = 'action_claim_timeout',
      updated_at = $3
    WHERE tenant_id = $1 AND run_id = $2
      AND status = 'claimed'
      AND claimed_at < $3::timestamptz - interval '5 minutes'
  `, [tenantId, run.id, now.toISOString()]);
  const verification = await verifyPendingActions({
    tenantId,
    runId: run.id,
    sequence,
    snapshot,
    now,
    queryAll,
    execute,
  });

  let executed = 0;
  let actionFailed = 0;
  let actionBlocked = 0;
  if (policy.actionsEnabled) {
    const candidates = selectOpsControlActionCandidates(assessment, snapshot, {
      allowlist: policy.actionAllowlist,
    });
    const actionHandlers = handlers || await loadDefaultHandlers();
    for (const candidate of candidates) {
      const claim = await claimAction({
        tenantId,
        run,
        sequence,
        candidate,
        policy,
        now,
        withTransaction,
      });
      if (claim.kind !== 'claimed') continue;
      const action = claim.action;
      try {
        const handler = actionHandlers[candidate.actionType];
        if (typeof handler !== 'function') throw new Error('action_handler_unavailable');
        const result = await handler({
          tenantId,
          targetId: candidate.targetId,
          action,
          candidate,
        });
        const projection = executionProjection(candidate.actionType, result);
        const verificationDueAt = projection.status === 'pending_verification'
          ? new Date(now.getTime() + policy.actionVerificationSeconds * 1000).toISOString()
          : null;
        await execute(`
          UPDATE ops_control_actions
          SET status = $3,
            result = $4::jsonb,
            executed_at = $5,
            verification_due_at = $6,
            last_error = CASE WHEN $3 = 'failed' THEN 'action_execution_failed' ELSE '' END,
            updated_at = $5
          WHERE id = $1 AND tenant_id = $2 AND status = 'claimed'
        `, [
          action.id,
          tenantId,
          projection.status,
          JSON.stringify(result ?? {}),
          now.toISOString(),
          verificationDueAt,
        ]);
        if (projection.status === 'pending_verification') executed += 1;
        else if (projection.status === 'blocked') actionBlocked += 1;
        else if (projection.status === 'failed') actionFailed += 1;
      } catch (error) {
        actionFailed += 1;
        await execute(`
          UPDATE ops_control_actions
          SET status = 'failed', executed_at = $3,
            last_error = $4, updated_at = $3
          WHERE id = $1 AND tenant_id = $2 AND status = 'claimed'
        `, [action.id, tenantId, now.toISOString(), text(error?.message || error, 2000)]);
      }
    }
  }

  const summary = await summarizeActions({tenantId, runId: run.id, queryAll});
  await persistActionSummary({tenantId, runId: run.id, summary, now, execute});
  return {
    enabled: policy.actionsEnabled === true,
    mode: policy.mode,
    executed,
    actionFailed,
    actionBlocked,
    ...verification,
    ...summary,
  };
}
