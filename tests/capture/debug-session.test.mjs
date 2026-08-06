import assert from "node:assert/strict";
import test from "node:test";

await import("../../utils/capture/debug-session.js");

const {createManager, isListCaptureAction, resolveListRelayRunId} =
  globalThis.OnStarvoiceCaptureDebugSession;

function createDebuggerDouble({
  attachError = null,
  attachErrors = null,
  focusError = null,
  focusErrors = null,
  detachError = null,
  detachDuringFocus = false,
  emitDetachOnStop = true,
} = {}) {
  const detachListeners = new Set();
  const calls = [];
  const queuedAttachErrors = Array.isArray(attachErrors)
    ? [...attachErrors]
    : null;
  const queuedFocusErrors = Array.isArray(focusErrors)
    ? [...focusErrors]
    : null;
  const api = {
    calls,
    detachError,
    onDetach: {
      addListener(listener) {
        detachListeners.add(listener);
      },
    },
    async attach(debuggee, version) {
      calls.push(["attach", debuggee, version]);
      const nextAttachError = queuedAttachErrors?.length
        ? queuedAttachErrors.shift()
        : attachError;
      if (nextAttachError) throw nextAttachError;
    },
    async sendCommand(debuggee, method, params) {
      calls.push(["sendCommand", debuggee, method, params]);
      if (detachDuringFocus && params?.enabled === true) {
        detachListeners.forEach((listener) =>
          listener(debuggee, "canceled_by_user"),
        );
      }
      const nextFocusError = queuedFocusErrors?.length
        ? queuedFocusErrors.shift()
        : focusError;
      if (nextFocusError && params?.enabled === true) throw nextFocusError;
      return {};
    },
    async detach(debuggee) {
      calls.push(["detach", debuggee]);
      if (api.detachError) throw api.detachError;
      if (emitDetachOnStop) {
        detachListeners.forEach((listener) =>
          listener(debuggee, "canceled_by_user"),
        );
      }
    },
    emitDetach(tabId, reason = "canceled_by_user") {
      detachListeners.forEach((listener) => listener({tabId}, reason));
    },
  };
  return api;
}

test("list capture actions are the only automatic debug-session entrypoints", () => {
  assert.equal(isListCaptureAction("captureKeywordNotes"), true);
  assert.equal(isListCaptureAction("captureBloggerNotes"), true);
  assert.equal(isListCaptureAction("captureSingleNote"), false);
  assert.equal(isListCaptureAction("captureComments"), false);
  assert.equal(isListCaptureAction("cancelCapture"), false);
});

test("consecutive keyword relays receive independent child run ids", async () => {
  const manager = createManager({debuggerApi: createDebuggerDouble()});
  await manager.start({
    tabId: 9,
    runId: "capture-task:multi-keyword-task",
    persistent: true,
    taskId: "multi-keyword-task",
  });
  let sequence = 0;
  const childRunIds = [];
  for (const keyword of ["汽车", "露营"]) {
    const childRunId = resolveListRelayRunId("", () =>
      `keyword-${++sequence}`,
    );
    childRunIds.push(childRunId);
    await manager.updateTask({
      taskId: "multi-keyword-task",
      activeListRunId: childRunId,
      progress: {keyword},
    });
  }

  assert.deepEqual(childRunIds, [
    "capture-debug:keyword-1",
    "capture-debug:keyword-2",
  ]);
  assert.notEqual(childRunIds[0], childRunIds[1]);
  assert.equal(
    manager.getSessionByTaskId("multi-keyword-task").runId,
    "capture-task:multi-keyword-task",
  );
  assert.equal(
    manager.getSessionByTaskId("multi-keyword-task").activeListRunId,
    childRunIds[1],
  );
  assert.equal(
    resolveListRelayRunId(" caller-owned-list-run ", () => "unused"),
    "caller-owned-list-run",
  );
});

test("a capture run attaches, applies focus emulation and detaches cleanly", async () => {
  const debuggerApi = createDebuggerDouble();
  const stateChanges = [];
  const unexpectedDetaches = [];
  const manager = createManager({
    debuggerApi,
    now: () => Date.parse("2026-07-15T00:00:00.000Z"),
    onStateChange: (session, metadata) =>
      stateChanges.push({session, metadata}),
    onUnexpectedDetach: (event) => unexpectedDetaches.push(event),
  });

  const session = await manager.start({
    tabId: 41,
    runId: "capture-run-41",
    label: "搜索「车机升级」",
  });
  assert.deepEqual(session, {
    version: 1,
    tabId: 41,
    runId: "capture-run-41",
    label: "搜索「车机升级」",
    state: "attached",
    startedAt: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(manager.getSession(41).runId, "capture-run-41");
  assert.deepEqual(debuggerApi.calls.slice(0, 2), [
    ["attach", {tabId: 41}, "1.3"],
    [
      "sendCommand",
      {tabId: 41},
      "Emulation.setFocusEmulationEnabled",
      {enabled: true},
    ],
  ]);

  const stopped = await manager.stop({
    tabId: 41,
    runId: "capture-run-41",
    reason: "capture_finished",
  });
  assert.equal(stopped.released, true);
  assert.equal(manager.getSession(41), null);
  assert.deepEqual(debuggerApi.calls.slice(-2), [
    [
      "sendCommand",
      {tabId: 41},
      "Emulation.setFocusEmulationEnabled",
      {enabled: false},
    ],
    ["detach", {tabId: 41}],
  ]);
  assert.equal(unexpectedDetaches.length, 0);
  assert.equal(stateChanges[0].session.state, "attached");
  assert.equal(stateChanges.at(-1).session, null);
});

test("a persisted task adopts an extension-owned debugger after worker restart", async () => {
  const debuggerApi = createDebuggerDouble();
  const stateChanges = [];
  const manager = createManager({
    debuggerApi,
    onStateChange: (session, metadata) =>
      stateChanges.push({session, metadata}),
  });

  const restored = await manager.restore({
    persistent: true,
    taskId: "task-restored",
    attemptId: "attempt-restored",
    tabId: 41,
    runId: "capture-task:task-restored",
    label: "恢复中的关键词任务",
    startedAt: "2026-08-06T01:00:00.000Z",
    progress: {keyword: "智能座舱"},
    workerTabIds: [42],
    groupId: 700,
    originalGroupId: 55,
    minimized: true,
  });

  assert.equal(restored.restored, true);
  assert.equal(restored.attachmentReused, true);
  assert.equal(restored.attemptId, "attempt-restored");
  assert.equal(manager.getSessionByTaskId("task-restored").state, "attached");
  assert.deepEqual(debuggerApi.calls, [[
    "sendCommand",
    {tabId: 41},
    "Emulation.setFocusEmulationEnabled",
    {enabled: true},
  ]]);
  assert.equal(stateChanges.at(-1).metadata.reason, "capture_restored");
});

test("a persisted task reattaches when the worker restart dropped debugger ownership", async () => {
  const debuggerApi = createDebuggerDouble({
    focusErrors: [new Error("Debugger is not attached to the tab with id: 41")],
  });
  const manager = createManager({debuggerApi});

  const restored = await manager.restore({
    persistent: true,
    taskId: "task-reattached",
    tabId: 41,
    runId: "capture-task:task-reattached",
    groupId: 700,
  });

  assert.equal(restored.restored, true);
  assert.equal(restored.attachmentReused, false);
  assert.deepEqual(debuggerApi.calls.map(([type]) => type), [
    "sendCommand",
    "attach",
    "sendCommand",
  ]);
});

test("runtime restore rejects incomplete or conflicting persisted ownership", async () => {
  const manager = createManager({debuggerApi: createDebuggerDouble()});
  await assert.rejects(
    manager.restore({persistent: true, taskId: "missing-tab"}),
    (error) => error?.code === "invalid_capture_restore_snapshot",
  );
  await manager.restore({
    persistent: true,
    taskId: "task-one",
    tabId: 41,
    runId: "capture-task:task-one",
  });
  await assert.rejects(
    manager.restore({
      persistent: true,
      taskId: "task-two",
      tabId: 42,
      runId: "capture-task:task-two",
    }),
    (error) => error?.code === "debug_session_busy",
  );
});

test("one active AI debug session blocks another tab and mismatched release", async () => {
  const manager = createManager({debuggerApi: createDebuggerDouble()});
  await manager.start({tabId: 11, runId: "run-one"});

  await assert.rejects(
    manager.start({tabId: 12, runId: "run-two"}),
    (error) => error?.code === "debug_session_busy",
  );
  assert.deepEqual(
    await manager.stop({tabId: 11, runId: "wrong-run"}),
    {released: false, reason: "run_mismatch"},
  );
  assert.equal(manager.getSession(11).runId, "run-one");
  assert.equal((await manager.stopByTab(11, "user_cancel")).released, true);
});

test("a real detach failure keeps ownership so Stop can be retried safely", async () => {
  const debuggerApi = createDebuggerDouble({
    detachError: new Error("transport still busy"),
    emitDetachOnStop: false,
  });
  const manager = createManager({debuggerApi});
  await manager.start({tabId: 13, runId: "retry-detach"});

  await assert.rejects(
    manager.stopByTab(13, "first_stop"),
    (error) => error?.code === "debug_session_detach_failed",
  );
  assert.equal(manager.getSession(13).state, "attached");
  assert.equal(manager.getSession(13).runId, "retry-detach");

  debuggerApi.detachError = null;
  const retried = await manager.stopByTab(13, "second_stop");
  assert.equal(retried.released, true);
  assert.equal(manager.getSession(13), null);
});

test("attach or CDP setup failure stops capture before it begins", async () => {
  const attachManager = createManager({
    debuggerApi: createDebuggerDouble({attachError: new Error("busy")}),
  });
  await assert.rejects(
    attachManager.start({tabId: 21, runId: "attach-fails"}),
    (error) => error?.code === "debug_session_attach_failed",
  );
  assert.equal(attachManager.getActiveSessions().length, 0);

  const commandApi = createDebuggerDouble({
    focusError: new Error("unsupported command"),
  });
  const commandManager = createManager({debuggerApi: commandApi});
  await assert.rejects(
    commandManager.start({tabId: 22, runId: "command-fails"}),
    (error) => error?.code === "debug_session_command_failed",
  );
  assert.equal(commandManager.getActiveSessions().length, 0);
  assert.equal(
    commandApi.calls.some(([type]) => type === "detach"),
    true,
  );
});

test("an immediate native Cancel during setup cannot publish a fake attached session", async () => {
  const debuggerApi = createDebuggerDouble({detachDuringFocus: true});
  const manager = createManager({debuggerApi});

  await assert.rejects(
    manager.start({tabId: 23, runId: "cancel-during-start"}),
    (error) => error?.code === "debug_session_detached_during_start",
  );
  assert.equal(manager.getSession(23), null);
  assert.equal(manager.getActiveSessions().length, 0);
  assert.equal(
    debuggerApi.calls.some(([type]) => type === "detach"),
    true,
  );
});

test("Chrome Cancel or DevTools detach clears ownership and cancels capture", async () => {
  const debuggerApi = createDebuggerDouble({emitDetachOnStop: false});
  const unexpected = [];
  const manager = createManager({
    debuggerApi,
    onUnexpectedDetach: (event) => unexpected.push(event),
  });
  await manager.start({tabId: 31, runId: "external-detach"});

  debuggerApi.emitDetach(31, "canceled_by_user");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(manager.getSession(31), null);
  assert.equal(unexpected.length, 1);
  assert.equal(unexpected[0].reason, "canceled_by_user");
  assert.equal(unexpected[0].session.runId, "external-detach");
});

test("target_closed reattaches a nonpersistent list capture on the same live tab", async () => {
  const debuggerApi = createDebuggerDouble({emitDetachOnStop: false});
  const unexpected = [];
  let replacementTimeout = null;
  const manager = createManager({
    debuggerApi,
    onUnexpectedDetach: (event) => unexpected.push(event),
    setTimeoutFn(handler) {
      replacementTimeout = handler;
      return 1;
    },
    clearTimeoutFn() {
      replacementTimeout = null;
    },
  });
  await manager.start({
    tabId: 30,
    runId: "list-capture:transient-target-closed",
  });

  debuggerApi.emitDetach(30, "target_closed");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(unexpected.length, 0);
  assert.equal(typeof replacementTimeout, "function");
  assert.equal(manager.getSession(30).state, "attached");

  replacementTimeout();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(unexpected.length, 0);
  assert.equal(manager.getSession(30).state, "attached");
  assert.equal(
    debuggerApi.calls.filter(([type]) => type === "attach").length,
    2,
  );
});

test("target_closed releases only debug ownership when a nonpersistent list reattach fails", async () => {
  const debuggerApi = createDebuggerDouble({
    emitDetachOnStop: false,
    attachErrors: [null, new Error("target no longer exists")],
  });
  const unexpected = [];
  let replacementTimeout = null;
  const manager = createManager({
    debuggerApi,
    onUnexpectedDetach: (event) => unexpected.push(event),
    setTimeoutFn(handler) {
      replacementTimeout = handler;
      return 1;
    },
    clearTimeoutFn() {
      replacementTimeout = null;
    },
  });
  await manager.start({
    tabId: 35,
    runId: "list-capture:closed-target",
  });

  debuggerApi.emitDetach(35, "target_closed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unexpected.length, 0);

  replacementTimeout();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(unexpected.length, 0);
  assert.equal(manager.getSession(35), null);
});

test("persistent native detach keeps a recovery snapshot until ordered cleanup finishes", async () => {
  const debuggerApi = createDebuggerDouble({emitDetachOnStop: false});
  let manager;
  let releaseCleanup;
  let callbackStarted = false;
  let snapshotDuringCallback = null;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  manager = createManager({
    debuggerApi,
    async onUnexpectedDetach(event) {
      callbackStarted = true;
      snapshotDuringCallback = manager.getSessionByTaskId(event.session.taskId);
      await cleanupGate;
      await manager.stopByTaskId(event.session.taskId, "debugger_detached");
    },
  });
  await manager.start({
    tabId: 32,
    runId: "capture-task:persistent-detach",
    persistent: true,
    taskId: "persistent-detach",
    workerTabIds: [33, 34],
    groupId: 701,
  });

  debuggerApi.emitDetach(32, "canceled_by_user");
  while (!callbackStarted) await Promise.resolve();
  assert.equal(snapshotDuringCallback.state, "detached");
  assert.deepEqual(snapshotDuringCallback.workerTabIds, [33, 34]);
  assert.equal(manager.getSessionByTaskId("persistent-detach").state, "detached");

  releaseCleanup();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!manager.getSessionByTaskId("persistent-detach")) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(manager.getSessionByTaskId("persistent-detach"), null);
});

test("target_closed waits for tabs.onReplaced and reattaches a persistent source", async () => {
  const debuggerApi = createDebuggerDouble({emitDetachOnStop: false});
  const unexpected = [];
  let replacementTimeout = null;
  const manager = createManager({
    debuggerApi,
    onUnexpectedDetach: (event) => unexpected.push(event),
    setTimeoutFn(handler) {
      replacementTimeout = handler;
      return 1;
    },
    clearTimeoutFn() {
      replacementTimeout = null;
    },
  });
  await manager.start({
    tabId: 81,
    runId: "capture-task:source-replacement",
    persistent: true,
    taskId: "source-replacement",
    workerTabIds: [82],
    groupId: 700,
  });

  debuggerApi.emitDetach(81, "target_closed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unexpected.length, 0);
  assert.equal(typeof replacementTimeout, "function");
  assert.equal(manager.getSession(81).state, "attached");

  const replaced = await manager.replaceTab({
    removedTabId: 81,
    addedTabId: 83,
    pageTitle: "抖音搜索",
    pageUrl: "https://www.douyin.com/search/test",
  });
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.role, "source");
  assert.equal(replacementTimeout, null);
  assert.equal(manager.getSession(81), null);
  assert.equal(manager.getSession(83).state, "attached");
  assert.equal(manager.getSession(83).taskId, "source-replacement");
  assert.deepEqual(manager.getSession(83).workerTabIds, [82]);
  assert.equal(manager.getSession(83).pageTitle, "抖音搜索");
  assert.equal(unexpected.length, 0);
  assert.deepEqual(debuggerApi.calls.slice(-2), [
    ["attach", {tabId: 83}, "1.3"],
    [
      "sendCommand",
      {tabId: 83},
      "Emulation.setFocusEmulationEnabled",
      {enabled: true},
    ],
  ]);
});

test("target_closed still cancels when no replacement arrives in the grace window", async () => {
  const debuggerApi = createDebuggerDouble({
    emitDetachOnStop: false,
    attachErrors: [null, new Error("target no longer exists")],
  });
  const unexpected = [];
  let replacementTimeout = null;
  const manager = createManager({
    debuggerApi,
    onUnexpectedDetach: (event) => unexpected.push(event),
    setTimeoutFn(handler) {
      replacementTimeout = handler;
      return 1;
    },
    clearTimeoutFn() {
      replacementTimeout = null;
    },
  });
  await manager.start({
    tabId: 84,
    runId: "capture-task:source-closed",
    persistent: true,
    taskId: "source-closed",
  });

  debuggerApi.emitDetach(84, "target_closed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unexpected.length, 0);
  replacementTimeout();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    debuggerApi.calls.filter(([type]) => type === "attach").length,
    2,
  );
  assert.equal(unexpected.length, 1);
  assert.equal(unexpected[0].reason, "target_closed");
  assert.equal(unexpected[0].session.state, "detached");
});

test("target_closed reattaches the same persistent source when no replacement event arrives", async () => {
  const debuggerApi = createDebuggerDouble({emitDetachOnStop: false});
  const unexpected = [];
  let replacementTimeout = null;
  const manager = createManager({
    debuggerApi,
    onUnexpectedDetach: (event) => unexpected.push(event),
    setTimeoutFn(handler) {
      replacementTimeout = handler;
      return 1;
    },
    clearTimeoutFn() {
      replacementTimeout = null;
    },
  });
  await manager.start({
    tabId: 89,
    runId: "capture-task:same-tab-reattach",
    persistent: true,
    taskId: "same-tab-reattach",
  });

  debuggerApi.emitDetach(89, "target_closed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  replacementTimeout();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(unexpected.length, 0);
  assert.equal(manager.getSessionByTaskId("same-tab-reattach").state, "attached");
  assert.equal(
    debuggerApi.calls.filter(([type]) => type === "attach").length,
    2,
  );
});

test("target_closed cleanup can re-enter stopByTaskId without deadlocking the session queue", async () => {
  const debuggerApi = createDebuggerDouble({
    emitDetachOnStop: false,
    attachErrors: [null, new Error("same-tab reattach failed")],
  });
  const stateChanges = [];
  let replacementTimeout = null;
  let cleanupStarted = false;
  let cleanupFinished = false;
  let manager;
  manager = createManager({
    debuggerApi,
    onStateChange(session, metadata) {
      stateChanges.push({session, metadata});
    },
    async onUnexpectedDetach(event) {
      cleanupStarted = true;
      await manager.stopByTaskId(event.session.taskId, "debugger_detached");
      cleanupFinished = true;
    },
    setTimeoutFn(handler) {
      replacementTimeout = handler;
      return 1;
    },
    clearTimeoutFn() {
      replacementTimeout = null;
    },
  });
  await manager.start({
    tabId: 88,
    runId: "capture-task:target-closed-cleanup",
    persistent: true,
    taskId: "target-closed-cleanup",
  });

  debuggerApi.emitDetach(88, "target_closed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof replacementTimeout, "function");
  replacementTimeout();

  // Give the queued callback several turns. A re-entrant queue deadlock leaves
  // cleanupStarted=true forever while stopByTaskId waits behind its caller.
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(cleanupStarted, true);
  assert.equal(cleanupFinished, true);
  assert.equal(manager.getSessionByTaskId("target-closed-cleanup"), null);
  assert.equal(stateChanges.at(-1).session, null);
});

test("worker tab replacement preserves persistent task ownership", async () => {
  const manager = createManager({debuggerApi: createDebuggerDouble()});
  await manager.start({
    tabId: 85,
    runId: "capture-task:worker-replacement",
    persistent: true,
    taskId: "worker-replacement",
    workerTabIds: [86],
  });

  const replaced = await manager.replaceTab({
    removedTabId: 86,
    addedTabId: 87,
  });
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.role, "worker");
  assert.deepEqual(
    manager.getSessionByTaskId("worker-replacement").workerTabIds,
    [87],
  );
});

test("closing the owned tab forgets the session without touching another tab", async () => {
  const manager = createManager({debuggerApi: createDebuggerDouble()});
  await manager.start({tabId: 51, runId: "closed-tab"});
  assert.equal(await manager.handleTabRemoved(52), false);
  assert.equal(await manager.handleTabRemoved(51), true);
  assert.equal(manager.getSession(51), null);
});

test("persistent capture tasks keep task progress, workers and minimized state until task end", async () => {
  const debuggerApi = createDebuggerDouble();
  const manager = createManager({
    debuggerApi,
    now: () => Date.parse("2026-07-15T01:00:00.000Z"),
  });

  const started = await manager.start({
    tabId: 61,
    runId: "capture-task:task-61",
    label: "小红书搜索采集",
    persistent: true,
    taskId: "task-61",
    progress: {phase: "starting", current: 0, total: 20},
    groupId: 700,
  });
  assert.deepEqual(started, {
    version: 1,
    tabId: 61,
    runId: "capture-task:task-61",
    label: "小红书搜索采集",
    state: "attached",
    startedAt: "2026-07-15T01:00:00.000Z",
    persistent: true,
    taskId: "task-61",
    progress: {phase: "starting", current: 0, total: 20},
    workerTabIds: [],
    groupId: 700,
    originalGroupId: null,
    minimized: false,
    activeListRunId: "",
  });

  await manager.updateTask({
    taskId: "task-61",
    progress: {phase: "detail", current: 4, total: 20},
  });
  await manager.registerWorkerTab({
    taskId: "task-61",
    tabId: 62,
    groupId: 700,
  });
  const minimized = await manager.setMinimized({
    taskId: "task-61",
    minimized: true,
  });
  assert.deepEqual(minimized.progress, {
    phase: "detail",
    current: 4,
    total: 20,
  });
  assert.deepEqual(minimized.workerTabIds, [62]);
  assert.equal(minimized.minimized, true);
  assert.equal(manager.getSessionByTaskId("task-61").tabId, 61);

  assert.equal(await manager.handleTabRemoved(62), true);
  assert.deepEqual(
    manager.getSessionByTaskId("task-61").workerTabIds,
    [],
  );
  const stopped = await manager.stopByTaskId(
    "task-61",
    "capture_task_finished",
  );
  assert.equal(stopped.released, true);
  assert.equal(stopped.session.persistent, true);
  assert.equal(manager.getSession(61), null);
  assert.deepEqual(debuggerApi.calls.slice(-2), [
    [
      "sendCommand",
      {tabId: 61},
      "Emulation.setFocusEmulationEnabled",
      {enabled: false},
    ],
    ["detach", {tabId: 61}],
  ]);
});

test("persistent capture task ids cannot be silently reused by legacy sessions", async () => {
  const manager = createManager({debuggerApi: createDebuggerDouble()});
  await manager.start({
    tabId: 71,
    runId: "shared-run",
    persistent: true,
    taskId: "task-71",
  });

  await assert.rejects(
    manager.start({tabId: 71, runId: "shared-run"}),
    (error) => error?.code === "debug_session_tab_busy",
  );
  assert.equal(manager.getSession(71).persistent, true);
});
