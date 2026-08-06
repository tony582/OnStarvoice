import assert from "node:assert/strict";
import test from "node:test";

await import("../../utils/capture/task-tab-group.js");

const {createManager, normalizeTaskTabRole} =
  globalThis.OnStarvoiceCaptureTaskTabGroup;

function createTabGroupDouble({
  sourceGroupId = -1,
  workerGroupId = -1,
  updateError = null,
} = {}) {
  const tabs = new Map([
    [41, {id: 41, windowId: 5, groupId: sourceGroupId}],
    [42, {id: 42, windowId: 5, groupId: workerGroupId}],
    [44, {id: 44, windowId: 5, groupId: workerGroupId}],
    [43, {id: 43, windowId: 6}],
  ]);
  const calls = [];
  return {
    calls,
    tabsApi: {
      async get(tabId) {
        calls.push(["get", tabId]);
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      },
      async group(options) {
        calls.push(["group", options]);
        return options.groupId ?? 700;
      },
      async ungroup(tabIds) {
        calls.push(["ungroup", tabIds]);
      },
    },
    tabGroupsApi: {
      async update(groupId, patch) {
        calls.push(["update", groupId, patch]);
        if (updateError) throw updateError;
        return {id: groupId, ...patch};
      },
    },
  };
}

test("worker and detail_worker share the same native worker role", () => {
  assert.equal(normalizeTaskTabRole("worker"), "worker");
  assert.equal(normalizeTaskTabRole("detail_worker"), "worker");
  assert.equal(normalizeTaskTabRole(""), "worker");
  assert.equal(normalizeTaskTabRole("source"), null);
});

test("a task creates one native group and registers detail workers into it", async () => {
  const double = createTabGroupDouble();
  const manager = createManager(double);

  const started = await manager.begin({
    taskId: "task-41",
    sourceTabId: 41,
  });
  assert.deepEqual(started, {
    version: 1,
    taskId: "task-41",
    sourceTabId: 41,
    workerTabIds: [],
    groupId: 700,
    originalGroupId: null,
    windowId: 5,
    title: "StarVoice 采集任务",
  });
  assert.deepEqual(double.calls.slice(0, 3), [
    ["get", 41],
    ["group", {tabIds: [41]}],
    [
      "update",
      700,
      {title: "StarVoice 采集任务", collapsed: false},
    ],
  ]);

  const registered = await manager.register({
    taskId: "task-41",
    tabId: 42,
    role: "detail_worker",
  });
  assert.equal(registered.role, "worker");
  assert.deepEqual(registered.workerTabIds, [42]);
  assert.deepEqual(double.calls.slice(-2), [
    ["get", 42],
    ["group", {groupId: 700, tabIds: [42]}],
  ]);

  const ended = await manager.end({
    taskId: "task-41",
    reason: "capture_task_finished",
  });
  assert.equal(ended.released, true);
  assert.deepEqual(double.calls.slice(-2), [
    ["ungroup", [42]],
    ["ungroup", [41]],
  ]);
  assert.equal(manager.getTask("task-41"), null);
});

test("task end restores a source tab to its original native group", async () => {
  const double = createTabGroupDouble({sourceGroupId: 55});
  const manager = createManager(double);
  const started = await manager.begin({
    taskId: "task-restore-source-group",
    sourceTabId: 41,
  });
  assert.equal(started.originalGroupId, 55);

  const ended = await manager.end({taskId: "task-restore-source-group"});
  assert.equal(ended.released, true);
  assert.deepEqual(double.calls.at(-1), [
    "group",
    {groupId: 55, tabIds: [41]},
  ]);
  assert.equal(
    double.calls.some(
      ([type, tabIds]) => type === "ungroup" && tabIds?.includes(41),
    ),
    false,
  );
});

test("a service-worker restart rehydrates an existing native task group", async () => {
  const double = createTabGroupDouble({
    sourceGroupId: 700,
    workerGroupId: 700,
  });
  const manager = createManager(double);

  const restored = await manager.restore({
    taskId: "task-restored",
    tabId: 41,
    workerTabIds: [42, 43, 99],
    groupId: 700,
    originalGroupId: 55,
    title: "StarVoice 采集任务",
  });

  assert.equal(restored.restored, true);
  assert.deepEqual(restored.workerTabIds, [42]);
  assert.deepEqual(restored.missingWorkerTabIds, [43, 99]);
  assert.equal(
    double.calls.some(([type]) => type === "group" || type === "ungroup"),
    false,
  );
  assert.equal(manager.getTask("task-restored").groupId, 700);

  const forgotten = manager.forget("task-restored");
  assert.equal(forgotten.forgotten, true);
  assert.equal(manager.getTask("task-restored"), null);
});

test("runtime restore refuses a source tab that left its persisted group", async () => {
  const manager = createManager(createTabGroupDouble({sourceGroupId: -1}));
  await assert.rejects(
    manager.restore({taskId: "task-moved", tabId: 41, groupId: 700}),
    (error) => error?.code === "capture_task_group_restore_mismatch",
  );
});

test("group-title setup failure rolls an originally grouped source back", async () => {
  const double = createTabGroupDouble({
    sourceGroupId: 55,
    updateError: new Error("tab group update failed"),
  });
  const manager = createManager(double);

  await assert.rejects(
    manager.begin({taskId: "task-begin-rollback", sourceTabId: 41}),
    (error) => error?.code === "capture_task_group_create_failed",
  );
  assert.deepEqual(double.calls.at(-1), [
    "group",
    {groupId: 55, tabIds: [41]},
  ]);
  assert.equal(manager.getTask("task-begin-rollback"), null);
});

test("workers in another window are rejected before changing the native group", async () => {
  const double = createTabGroupDouble();
  const manager = createManager(double);
  await manager.begin({taskId: "task-41", sourceTabId: 41});

  await assert.rejects(
    manager.register({taskId: "task-41", tabId: 43, role: "worker"}),
    (error) => error?.code === "capture_worker_window_mismatch",
  );
  assert.equal(
    double.calls.some(
      ([type, options]) =>
        type === "group" && options?.tabIds?.includes(43),
    ),
    false,
  );
});

test("removed worker tabs are forgotten without releasing the task source", async () => {
  const double = createTabGroupDouble();
  const manager = createManager(double);
  await manager.begin({taskId: "task-41", sourceTabId: 41});
  await manager.register({taskId: "task-41", tabId: 42});

  assert.equal(await manager.handleTabRemoved(42), true);
  assert.deepEqual(manager.getTask("task-41").workerTabIds, []);
  assert.equal(await manager.handleTabRemoved(99), false);
  assert.equal(manager.getTask("task-41").sourceTabId, 41);
});

test("browser tab replacement migrates the source without ending the task", async () => {
  const double = createTabGroupDouble();
  const manager = createManager(double);
  await manager.begin({taskId: "task-source-replaced", sourceTabId: 41});
  await manager.register({taskId: "task-source-replaced", tabId: 42});

  const replaced = await manager.replaceTab({
    removedTabId: 41,
    addedTabId: 44,
  });

  assert.equal(replaced.replaced, true);
  assert.equal(replaced.role, "source");
  assert.equal(replaced.group.sourceTabId, 44);
  assert.deepEqual(replaced.group.workerTabIds, [42]);
  assert.deepEqual(double.calls.slice(-2), [
    ["get", 44],
    ["group", {groupId: 700, tabIds: [44]}],
  ]);

  const ended = await manager.end({taskId: "task-source-replaced"});
  assert.equal(ended.released, true);
  assert.deepEqual(double.calls.slice(-2), [
    ["ungroup", [42]],
    ["ungroup", [44]],
  ]);
});

test("browser tab replacement migrates a worker inside the same task group", async () => {
  const double = createTabGroupDouble();
  const manager = createManager(double);
  await manager.begin({taskId: "task-worker-replaced", sourceTabId: 41});
  await manager.register({taskId: "task-worker-replaced", tabId: 42});

  const replaced = await manager.replaceTab({
    removedTabId: 42,
    addedTabId: 44,
  });

  assert.equal(replaced.replaced, true);
  assert.equal(replaced.role, "worker");
  assert.equal(replaced.group.sourceTabId, 41);
  assert.deepEqual(replaced.group.workerTabIds, [44]);
  assert.deepEqual(double.calls.slice(-2), [
    ["get", 44],
    ["group", {groupId: 700, tabIds: [44]}],
  ]);
});

test("worker rollback leaves the source group active without an orphan tab", async () => {
  const double = createTabGroupDouble();
  const manager = createManager(double);
  await manager.begin({taskId: "task-rollback", sourceTabId: 41});
  await manager.register({
    taskId: "task-rollback",
    tabId: 42,
    role: "detail_worker",
  });

  const released = await manager.unregister({
    taskId: "task-rollback",
    tabId: 42,
  });
  assert.equal(released.released, true);
  assert.deepEqual(released.group.workerTabIds, []);
  assert.deepEqual(double.calls.at(-1), ["ungroup", [42]]);
  assert.equal(manager.getTask("task-rollback").sourceTabId, 41);
});

test("closing a source tab releases every surviving worker before forgetting the task", async () => {
  const double = createTabGroupDouble();
  const manager = createManager(double);
  await manager.begin({taskId: "task-source-close", sourceTabId: 41});
  await manager.register({taskId: "task-source-close", tabId: 42});

  assert.equal(await manager.handleTabRemoved(41), true);
  assert.deepEqual(double.calls.at(-1), ["ungroup", [42]]);
  assert.equal(manager.getTask("task-source-close"), null);
});
