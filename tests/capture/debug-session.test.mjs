import assert from "node:assert/strict";
import test from "node:test";

await import("../../utils/capture/debug-session.js");

const {createManager, isListCaptureAction, resolveListRelayRunId} =
  globalThis.OnStarvoiceCaptureDebugSession;

function createDebuggerDouble({
  attachError = null,
  focusError = null,
  detachError = null,
  detachDuringFocus = false,
  emitDetachOnStop = true,
} = {}) {
  const detachListeners = new Set();
  const calls = [];
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
      if (attachError) throw attachError;
    },
    async sendCommand(debuggee, method, params) {
      calls.push(["sendCommand", debuggee, method, params]);
      if (detachDuringFocus && params?.enabled === true) {
        detachListeners.forEach((listener) =>
          listener(debuggee, "canceled_by_user"),
        );
      }
      if (focusError && params?.enabled === true) throw focusError;
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
