import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  enqueueUnattendedCheckpointReport,
  flushUnattendedCheckpointReportOutbox,
  UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY as OUTBOX_PREFIX,
} from "../utils/unattended-report-outbox.js";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `real background function: ${startMarker}`);
  return source.slice(start, end);
}
// Exercise the real mutation queue, durable writer, update handler and cleanup
// chain. Browser resource operations are controlled boundaries, not copies of
// the update/ACK implementation. No production/browser runtime is accessed.
const actualFunctions = [
  between("function runUnattendedRunMutation(", "function runUnattendedRunArchiveMutation("),
  between("function runTaskLedgerMutation(", "function runCaptureTaskLifecycleOperation("),
  between("async function persistUnattendedRunMutation(", "async function readTaskLedger("),
  between("async function cleanupTerminalUnattendedRuntime(", "function isUnattendedRunnerTabForRequest("),
  between("async function retryUnattendedLocalClosureCleanup(", "async function inspectUnattendedLocalClosurePredicate("),
  between("async function updateUnattendedKeywordRun(", "async function launchUnattendedKeywordRun("),
].join("\n");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function within(promise, milliseconds = 100) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("runtime ACK timeout")), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function harness(t, {status = "running", holdPersistence = false, failPersistence = false} = {}) {
  const requestKey = "unattendedKeywordRunRequest";
  const data = {
    [requestKey]: {
      id: "request-a", attemptId: "attempt-a", attemptNumber: 1, status,
      cloudAssigned: true, progressSeq: 1, progress: {},
      checkpoint: {round: 1, completedKeywords: []},
    },
  };
  const cleanupGate = deferred();
  const cleanupStarted = deferred();
  const persistenceGate = deferred();
  const persistenceStarted = deferred();
  const tasks = [];
  const externalGates = [];
  const retrySchedules = [];
  const errors = [];
  let cleanupCalls = 0;
  let durableWrites = 0;
  const storage = {
    async get(keys) {
      return keys === null ? structuredClone(data) : Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]),
      );
    },
    async set(values) {
      // The actual persistUnattendedRunMutation writes request + taskLedger
      // atomically. Hold/fail that boundary to ensure ACK never precedes it.
      if (Object.hasOwn(values, "taskLedger")) {
        persistenceStarted.resolve();
        if (holdPersistence) await persistenceGate.promise;
        if (failPersistence) throw new Error("durable state unavailable");
        durableWrites += 1;
      }
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  const context = vm.createContext({
    console: {warn: (...args) => errors.push(args), error: (...args) => errors.push(args)},
    setTimeout, clearTimeout, queueMicrotask,
    chrome: {storage: {local: storage}},
    STORAGE_KEYS: {unattendedKeywordRunRequest: requestKey, unattendedKeywordPlan: "plan", taskLedger: "taskLedger"},
    UNATTENDED_RUN_SCHEMA_VERSION: 1,
    UNATTENDED_RUN_REPORTABLE_STATUSES: new Set(["running", "completed", "failed", "cancelled", "completed_with_failures"]),
    isTerminalUnattendedRunStatus: value => ["completed", "failed", "cancelled", "completed_with_failures"].includes(value),
    normalizeUnattendedRunRequest: value => value ? structuredClone(value) : null,
    normalizeUnattendedRunProgress: value => structuredClone(value),
    normalizeUnattendedKeywordPlan: value => value || {},
    readUnattendedKeywordRunRequest: async () => structuredClone(data[requestKey]),
    readUnattendedKeywordPlan: async () => ({}),
    runAuthoritativeControlStorageMutation: operation => operation(),
    upsertUnattendedTaskLedger: (_ledger, request) => ({accepted: true, ledger: {runs: [structuredClone(request)]}}),
    buildPlanMirrorForUnattendedRequest: () => ({}),
    buildUnattendedBusinessProgressFingerprint: value => JSON.stringify(value),
    buildUnattendedRecoveryMilestoneFingerprint: value => JSON.stringify(value),
    isLegacyUnattendedCheckpointRegression: () => false,
    resolveUnattendedBusinessProgressAt: ({now}) => now,
    unattendedRunRequiresLocalClosureProof: request => request.cloudAssigned === true,
    scheduleUnattendedLocalClosureRetry: async value => {
      retrySchedules.push({value: structuredClone(value), state: structuredClone(data[requestKey])});
      return {scheduled: true};
    },
    scheduleCloudTaskAgentSync: () => {},
    buildUnattendedLocalClosureKeyFromRequest: () => "",
    readStoredCaptureExecutionLock: async () => null,
    isCaptureExecutionLockOwnedByUnattendedAttempt: () => false,
    buildUnattendedCaptureTaskId: id => `unattended-capture:${id}`,
    captureDebugSessionManager: {getSessionByTaskId: () => null},
    captureTaskTabGroupManager: {getTask: () => null},
    collectExactUnattendedSourceStopTargets: () => [{tabId: 41}],
    buildUnattendedSourceResourceFingerprint: ({taskId}) => ({taskId, lock: null, targetTabIds: [41]}),
    readExactUnattendedStopConfirmation: request => request.stopConfirmation || null,
    sameUnattendedSourceResourceFingerprint: () => true,
    resolveCaptureTaskTabId: () => null,
    stopUnattendedCaptureTargetsForRecovery: async () => {
      cleanupCalls += 1;
      cleanupStarted.resolve();
      await cleanupGate.promise;
      return {ok: true, method: "confirmed", targetTabIds: [41]};
    },
    persistUnattendedStopConfirmationWithinMutation: async (request, confirmation) => {
      const next = {...request, stopConfirmation: confirmation};
      await storage.set({[requestKey]: next});
      return next;
    },
    releaseUnattendedCaptureTaskResourcesForRecovery: async () => {},
    releaseExactCaptureExecutionLockSnapshot: async () => true,
  });
  vm.runInContext(`let unattendedRunMutationQueue = Promise.resolve();
    let taskLedgerMutationQueue = Promise.resolve();\n${actualFunctions}`, context);
  const track = promise => { tasks.push(promise); return promise; };
  const send = message => within(track(context.updateUnattendedKeywordRun(message)));
  t.after(async () => {
    cleanupGate.resolve();
    persistenceGate.resolve();
    for (const gate of externalGates) gate.resolve();
    await Promise.allSettled(tasks);
    await context.runUnattendedRunMutation(async () => {});
  });
  return {
    data, storage, context, retrySchedules, errors, cleanupGate, cleanupStarted,
    persistenceGate, persistenceStarted,
    get cleanupCalls() { return cleanupCalls; },
    get durableWrites() { return durableWrites; },
    get request() { return data[requestKey]; },
    pending: () => Object.keys(data).filter(key => key.startsWith(OUTBOX_PREFIX)).length,
    enqueue: ({requestId = "request-a", attemptId = "attempt-a", nextStatus = "completed"} = {}) => enqueueUnattendedCheckpointReport({
      requestId, attemptId,
      patch: {status: nextStatus, progressSeq: 2, checkpoint: {round: 1, completedKeywords: ["ibuick"]}},
    }, {storage}),
    flush: () => flushUnattendedCheckpointReportOutbox({send}, {storage}),
    send,
    startCleanup: () => track(context.cleanupTerminalUnattendedRuntime(data[requestKey])),
    holdMutation: gate => {
      externalGates.push(gate);
      return track(context.runUnattendedRunMutation(() => gate.promise));
    },
  };
}

test("first terminal checkpoint ACK follows durable persistence but does not await slow runtime cleanup", async t => {
  const h = harness(t);
  await h.enqueue();
  const flushing = h.flush();
  await h.persistenceStarted.promise;
  const result = await flushing;
  assert.equal(h.request.status, "completed", "terminal state has been durably committed");
  assert.equal(h.durableWrites, 1);
  assert.equal(result.ok, true, `durable terminal ACK must precede cleanup: ${result.reason}, retained=${result.retained}`);
  assert.equal(result.delivered, 1);
  assert.equal(result.retained, 0);
  assert.equal(h.pending(), 0);
  assert.ok(h.retrySchedules.length > 0, "a durable cleanup retry must be armed");
  assert.equal(h.retrySchedules[0].state.status, "completed");
  assert.equal(h.request.stopConfirmation, undefined, "ACK is not local closure proof");
});

test("already terminal checkpoint replay is explicitly discarded without awaiting cleanup", async t => {
  const h = harness(t, {status: "completed"});
  await h.enqueue();
  const result = await h.flush();
  assert.equal(result.ok, true, `terminal replay must ACK: ${result.reason}, retained=${result.retained}`);
  assert.equal(result.discarded, 1);
  assert.equal(result.delivered, 0);
  assert.equal(result.retained, 0);
  assert.equal(h.durableWrites, 0, "replay cannot rewrite the durable terminal request");
  assert.equal(h.cleanupCalls, 0, "a replay ACK does not repeat runtime cleanup");
});

test("same-attempt terminal replay ACK bypasses the mutation queue held by actual runtime cleanup", async t => {
  const h = harness(t, {status: "completed"});
  h.startCleanup();
  await h.cleanupStarted.promise;
  await h.enqueue();
  const result = await h.flush();
  assert.equal(h.cleanupCalls, 1);
  assert.equal(result.ok, true, `cleanup-held mutation queue cannot starve terminal ACK: ${result.reason}, retained=${result.retained}`);
  assert.equal(result.discarded, 1);
  assert.equal(result.retained, 0);
  assert.equal(h.request.stopConfirmation, undefined, "pending source stop remains unconfirmed");
});

test("ACK cannot precede the first terminal durable write", async t => {
  const h = harness(t, {holdPersistence: true});
  await h.enqueue();
  const flushing = h.flush();
  await h.persistenceStarted.promise;
  const result = await flushing;
  assert.equal(result.reason, "transport_error");
  assert.equal(result.retained, 1);
  assert.equal(h.pending(), 1);
  assert.equal(h.request.status, "running");
  assert.equal(h.durableWrites, 0);
  assert.equal(h.cleanupCalls, 0);
});

test("failed persistence retains the checkpoint and never starts cleanup", async t => {
  const h = harness(t, {failPersistence: true});
  await h.enqueue();
  const result = await h.flush();
  assert.equal(result.reason, "transport_error");
  assert.equal(result.retained, 1);
  assert.equal(h.pending(), 1);
  assert.equal(h.request.status, "running");
  assert.equal(h.cleanupCalls, 0);
});

test("nonterminal, other-request and other-attempt reports cannot bypass a held mutation queue", async t => {
  for (const row of [
    {name: "nonterminal", status: "running", nextStatus: "running"},
    {name: "other request", status: "completed", requestId: "request-b"},
    {name: "other attempt", status: "completed", attemptId: "attempt-b"},
  ]) {
    await t.test(row.name, async t => {
      const h = harness(t, row);
      const gate = deferred();
      h.holdMutation(gate);
      await h.enqueue(row);
      const result = await h.flush();
      assert.equal(result.reason, "transport_error");
      assert.equal(result.retained, 1);
      assert.equal(h.pending(), 1);
      assert.equal(h.durableWrites, 0);
      assert.equal(h.cleanupCalls, 0);
      gate.resolve();
    });
  }
});

test("ordinary late heartbeat and malformed checkpoint patches keep the normal mutation path", async t => {
  for (const [name, patch] of [
    ["heartbeat", {heartbeatAt: "2026-11-06T08:00:00.000Z"}],
    ["array checkpoint", {checkpoint: []}],
    ["null checkpoint", {checkpoint: null}],
  ]) {
    await t.test(name, async t => {
      const h = harness(t, {status: "completed"});
      const gate = deferred();
      h.holdMutation(gate);
      await assert.rejects(h.send({requestId: "request-a", attemptId: "attempt-a", patch}), /runtime ACK timeout/);
      assert.equal(h.durableWrites, 0);
      assert.equal(h.cleanupCalls, 0);
      gate.resolve();
    });
  }
});
