import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCaptureLocalClosureEvidence,
  normalizeCaptureLocalClosureEvidenceList,
  selectCaptureLocalClosureEvidence,
  verifyCaptureLocalClosureProof,
} from '../server/services/capture-local-closure-proof.js';

const NOW = new Date('2026-08-27T01:00:00.000Z');

function evidence(overrides = {}) {
  return {
    version: 1,
    requestId: 'request-1',
    attemptId: 'attempt-1',
    itemId: '11111111-1111-4111-8111-111111111111',
    itemAttemptId: '22222222-2222-4222-8222-222222222222',
    attemptNumber: 1,
    assignmentRevision: 7,
    snapshotRevision: 11,
    terminalStatus: 'needs_action',
    terminalUpdatedAt: '2026-08-27T00:58:00.000Z',
    closedAt: '2026-08-27T00:59:00.000Z',
    terminalLedgerConfirmed: true,
    runnerTabCount: 0,
    platformTaskTabCount: 0,
    detailTaskTabCount: 0,
    ownedTaskTabCount: 0,
    executionLockPresent: false,
    debugSessionPresent: false,
    taskSessionPresent: false,
    taskOwnerPresent: false,
    pendingCheckpointReportCount: 0,
    businessUploadEvidenceKnown: true,
    streamingSyncDrainCompleted: true,
    streamingSyncEnabled: true,
    streamingSyncEnqueuedCount: 2,
    streamingSyncProcessedCount: 2,
    streamingSyncSuccessCount: 2,
    streamingSyncFailedCount: 0,
    streamingSyncSkippedCount: 0,
    streamingSyncPendingCount: 0,
    streamingSyncActiveCount: 0,
    streamingSyncRemainingCount: 0,
    streamingSyncCapturedUniqueCount: 3,
    streamingSyncEnqueuedUniqueCount: 2,
    streamingSyncExcludedUniqueCount: 1,
    streamingSyncSucceededUniqueCount: 2,
    streamingSyncBlocked: false,
    streamingSyncCanceled: false,
    capturedRecordCount: 2,
    ...overrides,
  };
}

function verify(overrides = {}) {
  return verifyCaptureLocalClosureProof({
    evidence: evidence(),
    expectedRequestId: 'request-1',
    expectedAttemptId: 'attempt-1',
    expectedItemId: '11111111-1111-4111-8111-111111111111',
    expectedItemAttemptId: '22222222-2222-4222-8222-222222222222',
    expectedAttemptNumber: 1,
    expectedAssignmentRevision: 7,
    expectedSnapshotRevision: 11,
    expectedAgentId: '33333333-3333-4333-8333-333333333333',
    snapshotAgentId: '33333333-3333-4333-8333-333333333333',
    snapshotStatus: 'needs_action',
    snapshotReceivedAt: '2026-08-27T00:59:30.000Z',
    now: NOW,
    ...overrides,
  });
}

test('authoritative terminal closure evidence is accepted exactly once scoped', () => {
  const result = verify();
  assert.equal(result.proven, true);
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.evidence.streamingSyncRemainingCount, 0);
  assert.equal(result.evidence.capturedRecordCount, 2);
  assert.equal(result.evidence.streamingSyncExcludedUniqueCount, 1);
});

test('missing or default-looking upload stats never normalize as closure proof', () => {
  for (const incomplete of [
    evidence({businessUploadEvidenceKnown: false}),
    evidence({streamingSyncDrainCompleted: false}),
    evidence({streamingSyncRemainingCount: 1}),
    evidence({streamingSyncFailedCount: 1}),
    evidence({streamingSyncSkippedCount: 1}),
    evidence({streamingSyncBlocked: true}),
    evidence({streamingSyncCanceled: true}),
    evidence({streamingSyncEnqueuedCount: 1}),
    evidence({streamingSyncProcessedCount: 1}),
    evidence({streamingSyncCapturedUniqueCount: 4}),
    evidence({streamingSyncSucceededUniqueCount: 1}),
  ]) {
    assert.equal(normalizeCaptureLocalClosureEvidence(incomplete), null);
  }
  const missing = evidence();
  delete missing.streamingSyncRemainingCount;
  assert.equal(normalizeCaptureLocalClosureEvidence(missing), null);
  for (const field of [
    'executionLockPresent',
    'debugSessionPresent',
    'taskSessionPresent',
    'taskOwnerPresent',
  ]) {
    const missingNegativeEvidence = evidence();
    delete missingNegativeEvidence[field];
    assert.equal(
      normalizeCaptureLocalClosureEvidence(missingNegativeEvidence),
      null,
      field,
    );
  }
});

test('disabled streaming sync is accepted only when this attempt captured nothing', () => {
  const empty = evidence({
    streamingSyncEnabled: false,
    streamingSyncEnqueuedCount: 0,
    streamingSyncProcessedCount: 0,
    streamingSyncSuccessCount: 0,
    streamingSyncCapturedUniqueCount: 0,
    streamingSyncEnqueuedUniqueCount: 0,
    streamingSyncExcludedUniqueCount: 0,
    streamingSyncSucceededUniqueCount: 0,
    capturedRecordCount: 0,
  });
  assert.ok(normalizeCaptureLocalClosureEvidence(empty));
  assert.equal(
    normalizeCaptureLocalClosureEvidence({
      ...empty,
      capturedRecordCount: 1,
    }),
    null,
  );
});

test('enabled sync proof is based on unique coverage rather than raw saved rows', () => {
  const normalized = normalizeCaptureLocalClosureEvidence(evidence({
    capturedRecordCount: 5,
    streamingSyncEnqueuedCount: 2,
    streamingSyncProcessedCount: 2,
    streamingSyncSuccessCount: 2,
    streamingSyncCapturedUniqueCount: 3,
    streamingSyncEnqueuedUniqueCount: 2,
    streamingSyncExcludedUniqueCount: 1,
    streamingSyncSucceededUniqueCount: 2,
  }));
  assert.ok(normalized);
  assert.equal(normalized.capturedRecordCount, 5);
  assert.equal(normalized.streamingSyncCapturedUniqueCount, 3);
});

test('agent, attempt, assignment, snapshot revision and freshness are all fenced', () => {
  for (const [overrides, failedCheck] of [
    [{expectedAttemptId: 'attempt-2'}, 'attempt'],
    [{expectedItemAttemptId: '44444444-4444-4444-8444-444444444444'}, 'itemAttempt'],
    [{expectedAssignmentRevision: 8}, 'assignmentRevision'],
    [{expectedSnapshotRevision: 12}, 'snapshotRevision'],
    [{snapshotAgentId: '55555555-5555-4555-8555-555555555555'}, 'agent'],
    [{snapshotStatus: 'completed'}, 'terminalStatusMatches'],
    [{snapshotReceivedAt: '2026-08-26T23:00:00.000Z'}, 'freshSnapshot'],
  ]) {
    const result = verify(overrides);
    assert.equal(result.proven, false, failedCheck);
    assert.ok(result.failedChecks.includes(failedCheck), failedCheck);
  }
});

test('multi-item closure selection stays exact and rejects malformed or duplicate arrays', () => {
  const second = evidence({
    itemId: '44444444-4444-4444-8444-444444444444',
    itemAttemptId: '55555555-5555-4555-8555-555555555555',
    attemptNumber: 2,
    assignmentRevision: 8,
  });
  const list = normalizeCaptureLocalClosureEvidenceList([evidence(), second]);
  assert.equal(list.length, 2);
  assert.deepEqual(
    selectCaptureLocalClosureEvidence({
      evidence: evidence(),
      evidences: list,
      expectedItemId: second.itemId,
      expectedItemAttemptId: second.itemAttemptId,
    }),
    normalizeCaptureLocalClosureEvidence(second),
  );
  assert.equal(
    selectCaptureLocalClosureEvidence({
      evidence: evidence(),
      evidences: list,
      expectedItemId: second.itemId,
      expectedItemAttemptId: '66666666-6666-4666-8666-666666666666',
    }),
    null,
  );
  assert.deepEqual(
    normalizeCaptureLocalClosureEvidenceList([evidence(), {...evidence()}]),
    [],
  );
  assert.deepEqual(
    normalizeCaptureLocalClosureEvidenceList([
      evidence(),
      {...second, streamingSyncRemainingCount: 1},
    ]),
    [],
  );
});

test('a present invalid plural channel cannot fall back to a valid legacy proof', () => {
  const legacy = evidence();
  const select = evidences => selectCaptureLocalClosureEvidence({
    evidence: legacy,
    evidences,
    expectedItemId: legacy.itemId,
    expectedItemAttemptId: legacy.itemAttemptId,
  });

  assert.equal(select([]), null, 'present-empty plural evidence fails closed');
  assert.equal(
    select([legacy, {...legacy}]),
    null,
    'duplicate plural evidence fails closed',
  );
  assert.equal(
    select([legacy, {...legacy, streamingSyncRemainingCount: 1}]),
    null,
    'partly malformed plural evidence fails closed',
  );
  assert.equal(
    select(Array.from({length: 31}, (_, index) => ({
      ...legacy,
      itemId: `item-${index}`,
      itemAttemptId: `item-attempt-${index}`,
    }))),
    null,
    'oversized plural evidence fails closed',
  );
});

test('a truly absent plural channel preserves the legacy rolling-upgrade proof', () => {
  const legacy = evidence();
  for (const evidences of [undefined, null]) {
    assert.deepEqual(
      selectCaptureLocalClosureEvidence({
        evidence: legacy,
        ...(evidences === undefined ? {} : {evidences}),
        expectedItemId: legacy.itemId,
        expectedItemAttemptId: legacy.itemAttemptId,
      }),
      normalizeCaptureLocalClosureEvidence(legacy),
    );
  }
});
