import {
  selectCaptureLocalClosureEvidence,
  verifyCaptureLocalClosureProof,
} from '../../../services/capture-local-closure-proof.js';
import {safeJson, text} from '../application/control-outcome-projection.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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
  return verifyCaptureLocalClosureProof({
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
}
