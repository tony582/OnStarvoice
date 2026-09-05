import assert from "node:assert/strict";
import test from "node:test";

await import("../../utils/capture/execution-identity.js");

const identity = globalThis.OnStarvoiceCaptureExecutionIdentity;
const {
  resolveCaptureTaskTabId,
  buildUnattendedCaptureTaskId,
  parseStableUnattendedCaptureTaskId,
  isCaptureExecutionLockOwnedByUnattendedAttempt,
  buildCaptureExecutionLockStopIdentity,
  captureExecutionLockMatchesStopIdentity,
  captureRuntimeSnapshotMatches,
} = identity;

const request = Object.freeze({
  id: "request-current",
  attemptId: "attempt-current",
  runnerTabId: 41,
  progress: Object.freeze({runnerTabId: 42}),
});
const lock = Object.freeze({
  id: "lock-current",
  owner: "unattended_keyword_plan",
  holderId: "holder-current",
  holderDocumentId: "document-current",
  holderTabId: 41,
  captureTaskId: "unattended-capture:request-current",
  captureTaskAttemptId: "attempt-current",
});

test("execution identity exposes only the seven extracted pure helpers", () => {
  assert.deepEqual(Object.keys(identity).sort(), [
    "buildCaptureExecutionLockStopIdentity",
    "buildUnattendedCaptureTaskId",
    "captureExecutionLockMatchesStopIdentity",
    "captureRuntimeSnapshotMatches",
    "isCaptureExecutionLockOwnedByUnattendedAttempt",
    "parseStableUnattendedCaptureTaskId",
    "resolveCaptureTaskTabId",
  ].sort());
  for (const helper of Object.values(identity)) assert.equal(typeof helper, "function");
});

test("tab identity selects the first positive safe integer, including a serialized tab number", () => {
  assert.equal(resolveCaptureTaskTabId(41, 42), 41);
  assert.equal(resolveCaptureTaskTabId(" 42 "), 42);
  assert.equal(resolveCaptureTaskTabId(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const invalid of [undefined, null, "", " ", "not-a-tab", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(resolveCaptureTaskTabId(invalid), null, String(invalid));
    assert.equal(resolveCaptureTaskTabId(invalid, "42"), 42, String(invalid));
  }
  assert.equal(resolveCaptureTaskTabId(), null);
});

test("stable unattended task IDs round-trip without accepting an empty request or another task namespace", () => {
  assert.equal(buildUnattendedCaptureTaskId(" request-current "), lock.captureTaskId);
  assert.deepEqual(parseStableUnattendedCaptureTaskId(` ${lock.captureTaskId} `), {
    unattended: true,
    taskId: lock.captureTaskId,
    requestId: request.id,
  });
  for (const empty of [undefined, null, "", " "]) {
    assert.equal(buildUnattendedCaptureTaskId(empty), "");
  }
  for (const taskId of ["", "capture:request-current", "UNATTENDED-CAPTURE:request-current"]) {
    assert.deepEqual(parseStableUnattendedCaptureTaskId(taskId), {
      unattended: false, taskId, requestId: "",
    });
  }
  assert.deepEqual(parseStableUnattendedCaptureTaskId(" unattended-capture: "), {
    unattended: false, taskId: "unattended-capture:", requestId: "",
  });
  assert.deepEqual(parseStableUnattendedCaptureTaskId("unattended-capture: request:child "), {
    unattended: true,
    taskId: "unattended-capture: request:child",
    requestId: "request:child",
  });
});

test("unattended ownership requires the correct owner and a nonempty request Attempt", () => {
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt(lock, request), true);
  for (const invalidLock of [undefined, null, "lock", {...lock, owner: "manual_capture"}]) {
    assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt(invalidLock, request), false);
  }
  for (const invalidRequest of [undefined, null, {...request, id: ""}, {...request, attemptId: ""}]) {
    assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt(lock, invalidRequest), false);
  }
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt({
    ...lock, captureTaskAttemptId: "attempt-superseded",
  }, request), false);
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt(lock, {
    ...request, attemptId: "attempt-successor",
  }), false);
});

test("legacy stable task locks with no Attempt remain compatible without accepting an explicit stale Attempt", () => {
  const legacyLock = {...lock, captureTaskAttemptId: ""};
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt(legacyLock, request), true);
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt({
    ...legacyLock, captureTaskId: "unattended-capture:another-request",
  }, request), false);
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt({
    ...lock, captureTaskId: "generated-legacy-child",
  }, request), true, "legacy generated children retain their explicit current Attempt fence");
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt({
    ...legacyLock, captureTaskId: "generated-legacy-child",
  }, request), false, "a generated child with no Attempt does not prove ownership");
});

test("unbound reservations require an exact runner tab and never infer ownership from the global lock", () => {
  const reservation = {...lock, captureTaskId: "", captureTaskAttemptId: ""};
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt(reservation, request), true);
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt({
    ...reservation, holderTabId: "42",
  }, request), true, "the persisted progress runner remains a valid ownership fence");
  for (const holderTabId of [null, 0, -1, 43, 41.5]) {
    assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt({
      ...reservation, holderTabId,
    }, request), false, String(holderTabId));
  }
  assert.equal(isCaptureExecutionLockOwnedByUnattendedAttempt(reservation, {
    ...request, runnerTabId: null, progress: {},
  }), false);
});

test("stop identity normalizes only its identity fields and leaves the input unchanged", () => {
  const source = Object.freeze({
    ...lock,
    holderTabId: "41",
    captureTaskId: ` ${lock.captureTaskId} `,
    captureTaskAttemptId: ` ${lock.captureTaskAttemptId} `,
    updatedAt: "2026-09-05T00:00:00.000Z",
    expiresAt: 1,
  });
  const before = {...source};
  assert.deepEqual(buildCaptureExecutionLockStopIdentity(source), lock);
  assert.deepEqual(source, before);
  for (const invalid of [undefined, null, "lock", 41]) {
    assert.equal(buildCaptureExecutionLockStopIdentity(invalid), null);
  }
});

test("a change to any stop-ownership field invalidates a captured stop request", () => {
  const expected = buildCaptureExecutionLockStopIdentity(lock);
  assert.equal(captureExecutionLockMatchesStopIdentity(lock, expected), true);
  for (const [field, replacement] of Object.entries({
    id: "lock-successor",
    owner: "another-owner",
    holderId: "holder-successor",
    holderDocumentId: "document-successor",
    holderTabId: 42,
    captureTaskId: "unattended-capture:request-successor",
    captureTaskAttemptId: "attempt-successor",
  })) {
    assert.equal(captureExecutionLockMatchesStopIdentity({
      ...lock, [field]: replacement,
    }, expected), false, field);
  }
  assert.equal(captureExecutionLockMatchesStopIdentity({
    ...lock, updatedAt: "later", expiresAt: 9999999999999,
  }, expected), true, "a lease renewal does not replace its ownership identity");
  assert.equal(captureExecutionLockMatchesStopIdentity(null, expected), false);
  assert.equal(captureExecutionLockMatchesStopIdentity(lock, null), false);
  assert.equal(captureExecutionLockMatchesStopIdentity(null, null), true);
});

test("MV3 snapshot matching fences task, child run, Attempt and effective source tab independently", () => {
  const snapshot = Object.freeze({
    taskId: lock.captureTaskId,
    runId: "run-current",
    attemptId: request.attemptId,
    sourceTabId: 41,
    tabId: 42,
  });
  assert.equal(captureRuntimeSnapshotMatches(snapshot, {...snapshot}), true);
  for (const [field, replacement] of Object.entries({
    taskId: "unattended-capture:request-successor",
    runId: "run-successor",
    attemptId: "attempt-successor",
    sourceTabId: 43,
  })) {
    assert.equal(captureRuntimeSnapshotMatches({
      ...snapshot, [field]: replacement,
    }, snapshot), false, field);
  }
  for (const field of ["taskId", "runId", "attemptId"]) {
    assert.equal(captureRuntimeSnapshotMatches({...snapshot, [field]: ""}, snapshot), false, field);
  }
  assert.equal(captureRuntimeSnapshotMatches({
    ...snapshot,
    taskId: ` ${snapshot.taskId} `,
    runId: ` ${snapshot.runId} `,
    attemptId: ` ${snapshot.attemptId} `,
    sourceTabId: "41",
    tabId: 99,
  }, snapshot), true, "the valid sourceTabId takes precedence over the fallback tabId");
  assert.equal(captureRuntimeSnapshotMatches({
    ...snapshot, sourceTabId: null, tabId: "41",
  }, snapshot), true);
  assert.equal(captureRuntimeSnapshotMatches({
    ...snapshot, sourceTabId: -1, tabId: 42,
  }, snapshot), false);
  assert.equal(captureRuntimeSnapshotMatches(null, snapshot), false);
  assert.equal(captureRuntimeSnapshotMatches(snapshot, null), false);
  assert.equal(captureRuntimeSnapshotMatches(null, null), false);
});

test("legacy MV3 snapshots without Attempts match only another equally scoped legacy snapshot", () => {
  const legacy = {taskId: "manual-task", runId: "manual-run", tabId: 41};
  assert.equal(captureRuntimeSnapshotMatches(legacy, {
    ...legacy, attemptId: "", sourceTabId: "41",
  }), true);
  assert.equal(captureRuntimeSnapshotMatches(legacy, {
    ...legacy, attemptId: "new-attempt",
  }), false);
  assert.equal(captureRuntimeSnapshotMatches(legacy, {...legacy, tabId: 42}), false);
});
