import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const policySource = await readFile(new URL("../utils/retired-runner-cleanup.js", import.meta.url), "utf8");
const backgroundSource = await readFile(new URL("../background.js", import.meta.url), "utf8");
const start = backgroundSource.indexOf("async function closeRetiredUnattendedRunnerAfterReceipt(");
const end = backgroundSource.indexOf("\nasync function relayToContentWithRetry(", start);
assert.ok(start >= 0 && end > start);
const backgroundCleanupSource = backgroundSource.slice(start, end);
const prefix = "onstarvoice.unattendedAttemptRetired.v1.";
const receipt = () => ({
  v: 1, requestId: "old-request", attemptId: "old-attempt", tabId: 41,
  documentId: "old-document", at: "2026-09-28T00:00:00.000Z",
  heartbeatStopped: true, flushed: true, flushing: false, pendingUploads: 0,
});
const key = (value) => `${prefix}${value.requestId}.${value.attemptId}`;
const runnerUrl = (value) => `chrome-extension://test/sidebar/sidebar.html?unattendedRun=${value.requestId}&unattendedAttempt=${value.attemptId}`;

function createState() {
  const value = receipt();
  return {
    receipts: {[key(value)]: value},
    tabs: new Map([[41, {id: 41, status: "complete", url: runnerUrl(value)}]]),
    contexts: [{documentId: value.documentId, tabId: value.tabId}],
    outbox: {known: true, pendingCount: 0}, slot: null, lock: null, relays: [],
    removed: [], contextReads: 0, outboxReads: 0,
  };
}

// Execute the actual background integration functions, with the browser state
// injected. Rebuilding this harness represents a sleeping MV3 worker waking up.
function createHarness(state = createState()) {
  const context = vm.createContext({
    URL, console, Promise, Map, Set,
    STORAGE_KEYS: {captureExecutionLock: "lock"},
    UNATTENDED_ATTEMPT_RETIRED_SESSION_PREFIX: prefix,
    UNATTENDED_RECOVERY_SELF_STOP_TIMING: {closeConfirmMs: 1, closePollMs: 1},
    extensionSessionValueFallback: new Map(),
    chrome: {
      storage: {local: {get: async () => ({lock: state.lock})}},
      runtime: {getContexts: async () => {
        state.contextReads += 1;
        await state.onContexts?.(state);
        return state.contexts;
      }},
      tabs: {
        get: async (tabId) => {
          if (!state.tabs.has(tabId)) throw new Error("No tab with id");
          return {...state.tabs.get(tabId)};
        },
        remove: async (tabId) => {
          if (state.removeThrows) throw new Error("browser temporarily unavailable");
          state.removed.push(tabId);
          if (!state.removeNoop) state.tabs.delete(tabId);
        },
      },
    },
    getExtensionSessionArea: () => ({get: async () => {
      if (state.sessionThrows) throw new Error("session unavailable");
      return state.receipts;
    }}),
    readExtensionSessionValue: async (storageKey) => state.receipts[storageKey],
    buildUnattendedAttemptRetiredKey: (requestId, attemptId) => `${prefix}${requestId}.${attemptId}`,
    resolveCaptureTaskTabId: (value) => Number.isSafeInteger(value) && value > 0 ? value : null,
    normalizeCaptureExecutionLock: (value) => value?.id ? value : null,
    readUnattendedKeywordRunRequest: async () => state.slot,
    isTerminalUnattendedRunStatus: (status) => ["completed", "failed", "needs_action", "canceled"].includes(status),
    inspectUnattendedCheckpointOutboxAttempt: async () => {
      state.outboxReads += 1;
      await state.onOutbox?.(state);
      return state.outbox;
    },
    listRequestRelays: () => state.relays,
    buildUnattendedCaptureTaskId: (requestId) => `unattended-capture:${requestId}`,
    isUnattendedRunnerTabForRequest: (tab, requestId, attemptId) => {
      try {
        const url = new URL(tab.url);
        return url.protocol === "chrome-extension:" && url.host === "test" &&
          url.pathname === "/sidebar/sidebar.html" &&
          url.searchParams.get("unattendedRun") === requestId &&
          url.searchParams.get("unattendedAttempt") === attemptId;
      } catch { return false; }
    },
    runUnattendedRunnerTabLifecycle: (operation) => operation(),
    runCaptureExecutionLockOperation: (operation) => operation(),
    isStopFenceMissingTabError: (error) => /No tab with id/.test(error?.message || ""),
    waitForTabToBeGone: async (tabId) => !state.tabs.has(tabId),
  });
  vm.runInContext(policySource, context);
  vm.runInContext(backgroundCleanupSource, context);
  return {
    state, context,
    sweep: () => context.reconcileRetiredUnattendedRunners(),
    close: (value) => context.closeRetiredUnattendedRunnerAfterReceipt(value),
    policy: context.OnStarvoiceRetiredRunnerCleanup,
  };
}

test("worker restart replays a persisted final receipt and confirms its exact document closed", async () => {
  const state = createState();
  createHarness(state); // Prior worker's in-memory state is not needed.
  const result = await createHarness(state).sweep();
  assert.equal(result.closed, 1);
  assert.deepEqual(state.removed, [41]);
  assert.equal(state.contextReads, 2);
  assert.ok(state.receipts[key(receipt())], "keep retirement evidence for its other cleanup consumers");
});

test("absence of a current task and an empty outbox never substitute for a final receipt", async () => {
  const harness = createHarness();
  harness.state.receipts = {};
  const result = await harness.sweep();
  assert.equal(result.checked, 0);
  assert.deepEqual(harness.state.removed, []);
});

test("incomplete, coercible, in-progress, or mis-keyed receipts cannot authorize cleanup", async () => {
  for (const patch of [
    {pendingUploads: null}, {pendingUploads: undefined}, {pendingUploads: "0"},
    {pendingUploads: false}, {pendingUploads: 1}, {flushing: true},
    {flushed: false}, {heartbeatStopped: false}, {documentId: ""},
    {tabId: "41"}, {v: 0}, {at: "invalid"},
  ]) {
    const harness = createHarness();
    harness.state.receipts[key(receipt())] = {...receipt(), ...patch};
    assert.equal((await harness.sweep()).checked, 0, JSON.stringify(patch));
    assert.deepEqual(harness.state.removed, []);
  }
  const harness = createHarness();
  harness.state.receipts = {[`${prefix}wrong-key`]: receipt()};
  assert.equal((await harness.sweep()).checked, 0);
});

test("old document receipts cannot close a navigated or reloaded tab even at the same URL", async () => {
  for (const configure of [
    (state) => {state.tabs.get(41).url = "https://www.douyin.com/jingxuan";},
    (state) => {state.contexts = [{tabId: 41, documentId: "new-document"}];},
    (state) => {state.contexts = [{tabId: 99, documentId: "old-document"}];},
    (state) => {state.contexts = [];},
    (state) => {state.contexts = null;},
    (state) => {state.tabs.get(41).pendingUrl = runnerUrl(receipt());},
    (state) => {state.tabs.get(41).status = "loading";},
  ]) {
    const harness = createHarness();
    configure(harness.state);
    assert.equal((await harness.sweep()).closed, 0);
    assert.deepEqual(harness.state.removed, []);
  }
});

test("a running exact attempt or a future task assigned the same tab retains the runner", async () => {
  for (const slot of [
    {id: "old-request", attemptId: "old-attempt", status: "running"},
    {id: "old-request", attemptId: "new-attempt", status: "pending", runnerTabId: 41},
    {id: "new-request", attemptId: "new-attempt", status: "running", runnerTabId: 41},
  ]) {
    const harness = createHarness();
    harness.state.slot = slot;
    assert.equal((await harness.sweep()).closed, 0);
    assert.deepEqual(harness.state.removed, []);
  }
});

test("terminal failure requires a receipt; with it an unrelated future task is untouched", async () => {
  for (const status of ["failed", "needs_action", "canceled", "completed"]) {
    const harness = createHarness();
    harness.state.slot = {id: "old-request", attemptId: "old-attempt", status};
    assert.equal((await harness.sweep()).closed, 1, status);
  }
  const harness = createHarness();
  harness.state.slot = {id: "new-request", attemptId: "new-attempt", status: "running", runnerTabId: 99};
  harness.state.tabs.set(99, {id: 99, url: runnerUrl(harness.state.slot)});
  assert.equal((await harness.sweep()).closed, 1);
  assert.ok(harness.state.tabs.has(99));
});

test("exact, document, tab and ambiguous task locks are preserved even when expired", async () => {
  for (const lock of [
    {id: "lock", holderDocumentId: "old-document", expiresAt: 0},
    {id: "lock", holderTabId: 41},
    {id: "lock", captureTaskId: "unattended-capture:old-request", captureTaskAttemptId: "old-attempt"},
    {id: "lock", captureTaskId: "unattended-capture:old-request"},
    {corrupt: true},
  ]) {
    const harness = createHarness();
    harness.state.lock = lock;
    assert.equal((await harness.sweep()).closed, 0);
    assert.deepEqual(harness.state.lock, lock);
  }
  const harness = createHarness();
  harness.state.lock = {id: "unrelated", holderTabId: 99, holderDocumentId: "future-document"};
  assert.equal((await harness.sweep()).closed, 1);
  assert.equal(harness.state.lock.id, "unrelated");
});

test("pending or unknown checkpoint delivery retains the only flushing document", async () => {
  for (const outbox of [{known: true, pendingCount: 1}, {known: false, pendingCount: 0}, {known: true, pendingCount: null}, null]) {
    const harness = createHarness();
    harness.state.outbox = outbox;
    assert.equal((await harness.sweep()).closed, 0);
    assert.deepEqual(harness.state.removed, []);
  }
});

test("exact or ambiguous in-flight relays block closing while a later attempt's relay is isolated", async () => {
  for (const relay of [
    {senderDocumentId: "old-document"}, {senderTabId: 41},
    {runnerRequestId: "old-request", runnerAttemptId: "old-attempt"},
    {runnerRequestId: "old-request"}, {taskId: "unattended-capture:old-request"},
  ]) {
    const harness = createHarness();
    harness.state.relays = [relay];
    assert.equal((await harness.sweep()).closed, 0);
  }
  const harness = createHarness();
  harness.state.relays = [{runnerRequestId: "old-request", runnerAttemptId: "new-attempt", senderTabId: 99}];
  assert.equal((await harness.sweep()).closed, 1);
});

test("a second-pass outbox, document, or receipt change cancels cleanup", async () => {
  for (const mutate of [
    (state) => {state.outbox = {known: true, pendingCount: 1};},
    (state) => {state.contexts = [{tabId: 41, documentId: "new-document"}];},
    (state) => {state.receipts[key(receipt())] = {...receipt(), flushing: true};},
    (state) => {state.tabs.get(41).url = "https://example.test/user-page";},
  ]) {
    const harness = createHarness();
    harness.state.onContexts = (state) => {if (state.contextReads === 1) mutate(state);};
    assert.equal((await harness.sweep()).closed, 0);
    assert.deepEqual(harness.state.removed, []);
  }
});

test("temporary inspection and removal failures preserve evidence for the next wake-up", async () => {
  const harness = createHarness();
  harness.state.removeThrows = true;
  assert.equal((await harness.sweep()).closed, 0);
  assert.ok(harness.state.receipts[key(receipt())]);
  harness.state.removeThrows = false;
  assert.equal((await harness.sweep()).closed, 1);
  const unavailable = createHarness();
  unavailable.state.sessionThrows = true;
  assert.equal((await unavailable.sweep()).ok, false);
  assert.deepEqual(unavailable.state.removed, []);
});

test("successful remove without disappearance is not reported as cleanup complete", async () => {
  const harness = createHarness();
  harness.state.removeNoop = true;
  const result = await harness.sweep();
  assert.equal(result.closed, 0);
  assert.equal(result.results[0].reason, "close_failed");
});

test("simultaneous wake-up hooks share a single sweep", async () => {
  const harness = createHarness();
  const results = await Promise.all([harness.sweep(), harness.sweep(), harness.sweep()]);
  assert.ok(results.every((result) => result.closed === 1));
  assert.deepEqual(harness.state.removed, [41]);
});
