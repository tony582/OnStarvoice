import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// 0.4.19：请求槽换代后，旧轮次的 runner 立即退役（事件驱动，不等卡住的流水线）。

const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);

function readSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const retirementSource = readSection(
  sidebarSource,
  "function handleUnattendedRunRequestStorageChange(request) {",
  "async function handleSaveKeywordPlan(",
);

function createRunner({
  urlRequestId = "request-r",
  urlAttemptId = "attempt-1",
  activeRequestId = "request-r",
  activeAttemptId = "attempt-1",
  queue = null,
  flushMs = 60 * 1000,
} = {}) {
  const calls = {
    cancelFlags: [],
    rejected: [],
    heartbeatStops: 0,
    messages: [],
  };
  const context = vm.createContext({
    console: {warn() {}, log() {}, error() {}},
    setTimeout,
    clearTimeout,
    Promise,
    chrome: {
      runtime: {
        async sendMessage(message) {
          calls.messages.push(JSON.parse(JSON.stringify(message)));
          return {ok: true};
        },
      },
    },
    getUnattendedRunRequestIdFromUrl: () => urlRequestId,
    getUnattendedRunAttemptIdFromUrl: () => urlAttemptId,
    isExplicitUserUnattendedCancellationMessage: () => true,
    setCancelFlag: (value) => calls.cancelFlags.push(value),
    stopRejectedUnattendedAttempt: (reason) => calls.rejected.push(reason),
    stopCaptureExecutionLockHeartbeat: () => {
      calls.heartbeatStops += 1;
    },
    activeUnattendedRunRequestId: activeRequestId,
    activeUnattendedRunAttemptId: activeAttemptId,
    pendingUnattendedCancellationRequestId: "",
    pendingUnattendedCancellationAttemptId: "",
    activeCaptureTaskCancellationReason: "",
    batchKeywordCancelRequested: false,
    detailBatchCancelRequested: false,
    searchCaptureCancelRequested: false,
    activeCaptureExecutionLockId: "lock-r",
    adoptedUnattendedCaptureExecutionLockId: "lock-r",
    activeUnattendedStreamingSyncQueue: queue,
    retiredUnattendedAttemptKey: "",
    UNATTENDED_ATTEMPT_RETIREMENT_FLUSH_MS: flushMs,
  });
  vm.runInContext(
    `${retirementSource}\nthis.__handle = handleUnattendedRunRequestStorageChange;\n` +
      `this.__retire = retireSupersededUnattendedAttempt;`,
    context,
  );
  return {context, calls};
}

async function settle() {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createQueue({remainingBefore = 2, hang = false} = {}) {
  let processed = 0;
  let remaining = remainingBefore;
  return {
    enabled: true,
    getStats: () => ({processedCount: processed, remainingCount: remaining}),
    drain: () =>
      hang
        ? new Promise(() => {})
        : Promise.resolve().then(() => {
            processed += 1;
            remaining = 0;
            return {processedCount: processed, remainingCount: 0};
          }),
  };
}

test("a runner retires as soon as its request moves to a new attempt", async () => {
  const queue = createQueue({remainingBefore: 1});
  const runner = createRunner({queue});
  runner.context.__handle({id: "request-r", attemptId: "attempt-2", status: "recovering"});
  await settle();

  assert.deepEqual(runner.calls.cancelFlags, [true]);
  assert.deepEqual(runner.calls.rejected, ["attempt_superseded"]);
  assert.equal(runner.context.searchCaptureCancelRequested, true);
  assert.equal(runner.calls.heartbeatStops, 1);
  assert.equal(runner.context.activeCaptureExecutionLockId, "");
  assert.equal(runner.context.adoptedUnattendedCaptureExecutionLockId, "");
  assert.equal(runner.calls.messages.length, 1);
  const [receipt] = runner.calls.messages;
  assert.equal(receipt.type, "onstarvoice:unattended-attempt-retired");
  assert.equal(receipt.heartbeatStopped, true);
  assert.equal(receipt.flushed, true);
  assert.equal(receipt.pendingUploads, 0);
  // 退役只停本地编排：不发任何全页取消，也不在消息里自报请求或轮次。
  assert.equal(receipt.requestId, undefined);
  assert.equal(receipt.attemptId, undefined);

  // 单飞：同一轮次再看到换代不会重复退役。
  runner.context.__handle({id: "request-r", attemptId: "attempt-3", status: "recovering"});
  await settle();
  assert.equal(runner.calls.messages.length, 1);
});

test("a stuck upload queue is bounded and the receipt reports what was left", async () => {
  const runner = createRunner({
    queue: createQueue({remainingBefore: 4, hang: true}),
    flushMs: 20,
  });
  runner.context.__handle({id: "request-r", attemptId: "attempt-2", status: "recovering"});
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  const [receipt] = runner.calls.messages;
  assert.equal(receipt.flushed, false);
  assert.equal(receipt.pendingUploads, 4);
});

test("the same attempt, another request or a legacy runner without an attempt does not retire", async () => {
  const same = createRunner();
  same.context.__handle({id: "request-r", attemptId: "attempt-1", status: "running"});
  const other = createRunner();
  other.context.__handle({id: "request-other", attemptId: "attempt-9", status: "running"});
  const legacy = createRunner({urlAttemptId: "", activeAttemptId: ""});
  legacy.context.__handle({id: "request-r", attemptId: "attempt-2", status: "recovering"});
  await settle();
  for (const runner of [same, other, legacy]) {
    assert.deepEqual(runner.calls.messages, []);
    assert.deepEqual(runner.calls.cancelFlags, []);
    assert.equal(runner.context.activeCaptureExecutionLockId, "lock-r");
  }
});

test("an explicit cancel of the current attempt keeps its existing handling", async () => {
  const runner = createRunner();
  runner.context.__handle({
    id: "request-r",
    attemptId: "attempt-1",
    status: "canceled",
    message: "用户取消",
  });
  await settle();
  assert.deepEqual(runner.calls.cancelFlags, [true]);
  assert.deepEqual(runner.calls.messages, []);
  assert.equal(runner.context.pendingUnattendedCancellationAttemptId, "attempt-1");
});

test("after retirement a lost lock cannot fall back to a page-wide cancel", () => {
  const lost = readSection(
    sidebarSource,
    "function handleCaptureExecutionLockLost(lockId) {",
    "async function renewCaptureExecutionLock(",
  );
  // 退役清空了 activeCaptureExecutionLockId，这里直接返回。
  assert.match(lost, /if \(!lockId \|\| activeCaptureExecutionLockId !== lockId\) \{\s*return;/u);
  const batch = readSection(
    sidebarSource,
    "streamingSyncQueue = createStreamingDetailAutoSyncQueue(settings, {\n      shouldStop: shouldStopBatchInvocation,",
    "if (\n      settings.autoDetailCaptureAfterListCapture",
  );
  assert.match(batch, /activeUnattendedStreamingSyncQueue = streamingSyncQueue/u);
});
