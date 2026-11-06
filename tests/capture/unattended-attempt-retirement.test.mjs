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
    flushPendingUnattendedCheckpointReports: async () => ({ok: true, retained: 0}),
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
  context.sendUnattendedRuntimeMessage = message => context.chrome.runtime.sendMessage(message);
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
  // 冲刷前先报“冲刷中”（心跳已停，后台据此保留本页），冲刷后再报结果。
  assert.equal(runner.calls.messages.length, 2);
  const [flushing, receipt] = runner.calls.messages;
  assert.equal(flushing.type, "onstarvoice:unattended-attempt-retired");
  assert.equal(flushing.heartbeatStopped, true);
  assert.equal(flushing.flushing, true);
  assert.equal(flushing.flushed, false);
  assert.equal(flushing.pendingUploads, 1);
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
  assert.equal(runner.calls.messages.length, 2);
});

test("a runner without an upload queue retires with a single flushed receipt", async () => {
  const runner = createRunner({queue: null});
  runner.context.__handle({id: "request-r", attemptId: "attempt-2", status: "recovering"});
  await settle();
  assert.equal(runner.calls.messages.length, 1);
  assert.equal(runner.calls.messages[0].flushed, true);
  assert.equal(runner.calls.messages[0].pendingUploads, 0);
});

test("a stuck upload queue is bounded and the receipt reports what was left", async () => {
  const runner = createRunner({
    queue: createQueue({remainingBefore: 4, hang: true}),
    flushMs: 20,
  });
  runner.context.__handle({id: "request-r", attemptId: "attempt-2", status: "recovering"});
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  const receipt = runner.calls.messages.at(-1);
  assert.equal(runner.calls.messages.length, 2);
  assert.equal(receipt.flushing, true);
  assert.equal(receipt.flushed, false);
  assert.equal(receipt.pendingUploads, 4);
});

test("the same attempt or a legacy runner without an attempt does not retire", async () => {
  const same = createRunner();
  same.context.__handle({id: "request-r", attemptId: "attempt-1", status: "running"});
  const legacy = createRunner({urlAttemptId: "", activeAttemptId: ""});
  legacy.context.__handle({id: "request-r", attemptId: "attempt-2", status: "recovering"});
  await settle();
  for (const runner of [same, legacy]) {
    assert.deepEqual(runner.calls.messages, []);
    assert.deepEqual(runner.calls.cancelFlags, []);
    assert.equal(runner.context.activeCaptureExecutionLockId, "lock-r");
  }
});

test("a runner retires when the supervisor ends its request and asks this attempt to retire", async () => {
  for (const status of ["failed", "needs_action"]) {
    const runner = createRunner({queue: null});
    runner.context.__handle({
      id: "request-r",
      attemptId: "attempt-1",
      status,
      runnerRetireAttemptId: "attempt-1",
    });
    await settle();
    assert.deepEqual(runner.calls.cancelFlags, [true], status);
    assert.deepEqual(runner.calls.rejected, ["request_terminal"], status);
    assert.equal(runner.calls.heartbeatStops, 1, status);
    assert.equal(runner.context.activeCaptureExecutionLockId, "", status);
    assert.equal(runner.calls.messages.length, 1, status);
    const [receipt] = runner.calls.messages;
    assert.equal(receipt.type, "onstarvoice:unattended-attempt-retired");
    assert.equal(receipt.reason, "request_terminal");
    assert.equal(receipt.heartbeatStopped, true);
    assert.equal(receipt.flushed, true);
  }
});

test("a terminal status without the supervisor's retire request (or for another attempt) keeps the runner's own finish", async () => {
  const cases = [
    {id: "request-r", attemptId: "attempt-1", status: "failed"},
    {id: "request-r", attemptId: "attempt-1", status: "completed", runnerRetireAttemptId: "attempt-1"},
    {id: "request-r", attemptId: "attempt-1", status: "running", runnerRetireAttemptId: "attempt-1"},
    {id: "request-r", attemptId: "attempt-1", status: "failed", runnerRetireAttemptId: "attempt-0"},
  ];
  for (const request of cases) {
    const runner = createRunner();
    runner.context.__handle(request);
    await settle();
    assert.deepEqual(runner.calls.messages, [], JSON.stringify(request));
    assert.equal(runner.calls.heartbeatStops, 0, JSON.stringify(request));
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

test("retirement preserves pending uploads, retries a network failure and reports success only after acknowledgments", async () => {
  const {createRecordSyncQueue} = await import('../../utils/record-sync-queue.js');
  const runner = createRunner({flushMs: 20});
  let failNetwork = true;
  let unblock;
  const calls = [];
  runner.context.createRecordSyncQueue = options => createRecordSyncQueue({...options, retryDelaysMs: []});
  runner.context.isTransientStreamingSyncFailure = r => r?.ok === false && r?.message === 'network';
  runner.context.maybeRunAutoSyncAfterDetailCapture = async (_settings, options) => {
    const id = options.recordIds[0];
    calls.push({id, task: options.captureTaskId, stopped: options.shouldStop()});
    if (id === 'a' && failNetwork) {
      await new Promise(resolve => { unblock = resolve; });
      return {ok: false, message: 'network'};
    }
    return {ok: true, successCount: 1};
  };
  vm.runInContext(readSection(sidebarSource, 'function createStreamingDetailAutoSyncQueue(',
    'function isTransientStreamingSyncFailure(') + '\nthis.__queue = createStreamingDetailAutoSyncQueue;', runner.context);
  const queue = runner.context.__queue({autoDetailCaptureAfterListCapture: true, autoSyncAfterDetailCapture: true}, {
    shouldStop: () => runner.context.searchCaptureCancelRequested, captureTaskId: 'request-r',
  });
  runner.context.activeUnattendedStreamingSyncQueue = queue;
  queue.enqueue('a'); queue.enqueue('b');
  runner.context.__handle({id: 'request-r', attemptId: 'attempt-2', status: 'recovering'});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(queue.getStats().remainingCount, 2, 'canceling collection did not empty uploads');
  assert.equal(runner.calls.messages.at(-1).flushed, false);
  unblock();
  await settle();
  assert.equal(queue.getStats().unsettledCount, 1, 'a processed failure is still an unacknowledged upload');
  assert.equal(runner.calls.messages.at(-1).flushed, false);
  queue.enqueue('late');
  await queue.drain();
  assert.equal(runner.calls.messages.at(-1).flushed, false, 'the producer is still unwinding');
  queue.finishProducing();
  failNetwork = false;
  for (let i = 0; i < 100 && !runner.calls.messages.at(-1).flushed; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(runner.calls.messages.at(-1).flushed, true);
  assert.equal(queue.getStats().unsettledCount, 0);
  assert.deepEqual(calls.map(c => c.id), ['a', 'b', 'late', 'a']);
  assert.ok(calls.every(c => c.task === 'request-r' && c.stopped === false));
});


test("a different request retires and flushes the old URL identity without canceling the successor", async () => {
  const runner = createRunner({queue: createQueue({remainingBefore: 2})});
  runner.context.__handle({id: "request-next", attemptId: "attempt-next", status: "running"});
  await settle();
  assert.deepEqual(runner.calls.rejected, ["request_superseded"]);
  assert.equal(runner.context.retiredUnattendedAttemptKey, "request-r:attempt-1");
  assert.equal(runner.calls.messages.at(-1).flushed, true);
  assert.equal(runner.calls.messages.at(-1).pendingUploads, 0);
  assert.ok(runner.calls.messages.every(message => message.type === "onstarvoice:unattended-attempt-retired"));
  runner.context.__handle({id: "request-next", attemptId: "attempt-next", status: "running"});
  await settle();
  assert.equal(runner.calls.heartbeatStops, 1);
});

test("retirement cannot claim a flush while durable checkpoint reports remain", async () => {
  const runner = createRunner({flushMs: 10});
  let retained = 1;
  runner.context.flushPendingUnattendedCheckpointReports = async () => ({ok: retained === 0, retained});
  runner.context.__handle({id: "request-next", attemptId: "attempt-next", status: "running"});
  await settle();
  assert.equal(runner.calls.messages.at(-1).flushed, false);
  assert.equal(runner.calls.messages.at(-1).pendingUploads, 1);
  retained = 0;
  for (let i = 0; i < 30 && !runner.calls.messages.at(-1).flushed; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(runner.calls.messages.at(-1).flushed, true);
  assert.equal(runner.calls.messages.at(-1).pendingUploads, 0);
});

test('a runner without uploads automatically resends a failed retirement receipt under its original identity', async () => {
  const runner = createRunner({queue: null, flushMs: 10});
  const realTimeout = setTimeout;
  runner.context.setTimeout = (handler, ms) => realTimeout(handler, [500, 2000].includes(ms) ? 0 : ms);
  const scopes = [];
  runner.context.flushPendingUnattendedCheckpointReports = async scope => {scopes.push(scope); return {ok: true, retained: 0};};
  let sends = 0;
  runner.context.chrome.runtime.sendMessage = async message => {
    runner.calls.messages.push(JSON.parse(JSON.stringify(message)));
    if (++sends <= 3) throw new Error('worker transport unavailable');
    return {ok: true};
  };
  await runner.context.__retire({requestId: 'request-r', attemptId: 'attempt-1'});
  assert.equal(sends, 3);
  runner.context.activeUnattendedRunRequestId = 'successor';
  runner.context.activeUnattendedRunAttemptId = 'attempt-2';
  let successorTouched = false;
  runner.context.activeUnattendedStreamingSyncQueue = {retire() {successorTouched = true;}};
  for (let i = 0; i < 30 && sends === 3; i++) await new Promise(resolve => realTimeout(resolve, 5));
  assert.equal(sends, 4, 'retiredKey must not suppress the automatic receipt retry');
  assert.equal(successorTouched, false);
  assert.ok(scopes.every(scope => scope.requestId === 'request-r' && scope.attemptId === 'attempt-1'));
  assert.ok(runner.calls.messages.every(message => message.flushed === true && message.pendingUploads === 0));
  assert.ok(runner.calls.messages.every(message => message.requestId === undefined && message.attemptId === undefined), 'background must continue deriving identity from the sender');
});


test('a hung retirement receipt is bounded and a late acknowledgment cannot restart the retired pipeline', async () => {
  const runner = createRunner({queue: null, flushMs: 10});
  const realTimeout = setTimeout;
  runner.context.setTimeout = (handler, ms) => realTimeout(handler, [500, 2000].includes(ms) ? 0 : ms);
  runner.context.UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS = 2;
  const lateAcks = [];
  let sends = 0;
  runner.context.chrome.runtime.sendMessage = async message => {
    runner.calls.messages.push(JSON.parse(JSON.stringify(message)));
    if (++sends <= 3) return await new Promise(resolve => lateAcks.push(resolve));
    return {ok: true};
  };
  vm.runInContext(readSection(sidebarSource, 'async function sendUnattendedRuntimeMessage(',
    'async function reportUnattendedTerminalRun('), runner.context);
  await runner.context.__retire({requestId: 'request-r', attemptId: 'attempt-1'});
  assert.equal(sends, 3);
  for (let i = 0; i < 30 && sends === 3; i++) await new Promise(resolve => realTimeout(resolve, 5));
  assert.equal(sends, 4);
  runner.context.activeUnattendedRunRequestId = 'new-request';
  runner.context.activeUnattendedRunAttemptId = 'new-attempt';
  lateAcks.forEach(resolve => resolve({ok: true}));
  await new Promise(resolve => realTimeout(resolve, 30));
  assert.equal(sends, 4); assert.equal(runner.calls.heartbeatStops, 1);
  assert.equal(runner.context.activeUnattendedRunRequestId, 'new-request');
});
