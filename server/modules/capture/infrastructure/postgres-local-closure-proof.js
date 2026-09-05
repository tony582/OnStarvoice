import {
  selectCaptureLocalClosureEvidence,
  verifyCaptureLocalClosureProof,
} from '../../../services/capture-local-closure-proof.js';
import {safeJson, text} from '../application/control-outcome-projection.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LEGACY_LOCAL_CLOSURE_REUSE_QUIESCENCE_MS = 20 * 1000;
const LOCAL_CLOSURE_PROOF_STRICT_MIN_VERSION_PARTS = Object.freeze([0, 4, 4]);

export function captureItemRequiresLocalClosureReuseFence({
  itemType,
  sourceExecutionMetadata,
} = {}) {
  return text(itemType, 40).toLowerCase() === 'keyword' &&
    safeJson(sourceExecutionMetadata).requiresLocalClosureReuseFenceV1 === true;
}

export async function loadVerifiedCaptureLocalClosureProof(tx, {
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
  const verified = verifyCaptureLocalClosureProof({
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
  if (verified.proven === true) return verified;

  // 0.4.3 and earlier could receive the server-owned fence marker but never
  // emitted localClosure proof. Apply the same bounded compatibility rule to
  // every proof consumer (same-Agent reuse, elastic handoff, duty recovery and
  // stale-lease settlement), not only to the Agent-slot gate. Exact execution,
  // Agent and item-attempt lineage remains mandatory; unknown/malformed and
  // 0.4.4+ versions stay fail-closed.
  const legacy = await tx.queryOne(`
    SELECT
      execution.metadata->>'requiresLocalClosureReuseFenceV1' = 'true'
        AS fence_marked,
      execution_version.app_version,
      CASE
        WHEN execution_version.app_version ~
          '^[0-9]+[.][0-9]+[.][0-9]+$'
          AND (
            regexp_match(
              execution_version.app_version,
              '^([0-9]+)[.]([0-9]+)[.]([0-9]+)$'
            )
          )::numeric[] < $8::numeric[]
        THEN true
        ELSE false
      END AS known_legacy_version,
      COALESCE(
        execution.finished_at,
        item_attempt.finished_at,
        GREATEST(execution.updated_at, item_attempt.updated_at),
        execution.updated_at,
        item_attempt.updated_at,
        execution.created_at,
        item_attempt.created_at
      ) AS terminal_at,
      clock_timestamp() AS proof_now
    FROM capture_tasks execution
    JOIN capture_task_item_attempts item_attempt
      ON item_attempt.tenant_id = execution.tenant_id
      AND item_attempt.execution_task_id = execution.id
      AND item_attempt.id = $5::uuid
      AND item_attempt.item_id = $4::uuid
      AND item_attempt.agent_id = $3::uuid
      AND item_attempt.attempt_number = $6::integer
      AND item_attempt.assignment_revision = $7::integer
    LEFT JOIN LATERAL (
      SELECT NULLIF(execution_attempt.app_version, '') AS app_version
      FROM capture_task_attempts execution_attempt
      WHERE execution_attempt.tenant_id = execution.tenant_id
        AND execution_attempt.task_id = execution.id
        AND execution_attempt.agent_id = $3::uuid
        AND execution_attempt.client_attempt_id <> ''
      ORDER BY execution_attempt.attempt_number DESC,
        execution_attempt.updated_at DESC,
        execution_attempt.id DESC
      LIMIT 1
    ) execution_version ON true
    WHERE execution.tenant_id = $1::uuid
      AND execution.id = $2::uuid
      AND execution.assigned_agent_id = $3::uuid
      AND execution.status IN (
        'completed', 'completed_with_warnings',
        'completed_with_failures', 'failed',
        'canceled', 'skipped', 'needs_action'
      )
    LIMIT 1
  `, [
    expected.tenantId,
    expected.executionTaskId,
    expected.sourceAgentId,
    expected.itemId,
    expected.itemAttemptId,
    expected.itemAttemptNumber,
    expected.assignmentRevision,
    LOCAL_CLOSURE_PROOF_STRICT_MIN_VERSION_PARTS,
  ]);
  if (legacy?.fence_marked !== true) {
    return legacy
      ? {proven: true, reason: 'local_closure_reuse_fence_not_required'}
      : verified;
  }
  if (legacy?.known_legacy_version !== true) return verified;
  const terminalAt = new Date(legacy?.terminal_at || 0).getTime();
  const proofNow = new Date(legacy?.proof_now || Date.now()).getTime();
  if (
    Number.isFinite(terminalAt) &&
    Number.isFinite(proofNow) &&
    proofNow - terminalAt >= LEGACY_LOCAL_CLOSURE_REUSE_QUIESCENCE_MS
  ) {
    return {proven: true, reason: 'legacy_local_closure_quiescent'};
  }
  return {proven: false, reason: 'local_cleanup_quiescence'};
}
