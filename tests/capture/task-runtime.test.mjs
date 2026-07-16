import assert from "node:assert/strict";
import test from "node:test";

await import("../../utils/capture/task-runtime.js");

const {
  collectWorkerTabIds,
  closeWorkerTabsIndividually,
  publishCancellationFailSoft,
  endTaskResources,
} =
  globalThis.OnStarvoiceCaptureTaskRuntime;

test("worker snapshots merge debugger and native-group ownership", () => {
  assert.deepEqual(
    collectWorkerTabIds(
      {workerTabIds: [42, "43", 42, -1]},
      {workerTabIds: [43, 44, null]},
    ),
    [42, 43, 44],
  );
});

test("group restoration failure still closes snapshotted workers after Debug release", async () => {
  const calls = [];
  await assert.rejects(
    endTaskResources({
      taskId: "task-group-failure",
      reason: "completed",
      debugSnapshot: {workerTabIds: [42]},
      groupSnapshot: {workerTabIds: [42, 43]},
      async stopDebug() {
        calls.push("debug");
        return {released: true, reason: "completed"};
      },
      async endGroup() {
        calls.push("group");
        throw new Error("temporary group restore failure");
      },
      async closeWorkerTabs(tabIds) {
        calls.push(["workers", tabIds]);
      },
    }),
    /temporary group restore failure/,
  );
  assert.deepEqual(calls, ["debug", ["workers", [42, 43]], "group"]);
});

test("Debug detach failure preserves native group and worker tabs for retry", async () => {
  const calls = [];
  await assert.rejects(
    endTaskResources({
      taskId: "task-debug-failure",
      debugSnapshot: {workerTabIds: [42]},
      groupSnapshot: {workerTabIds: [43]},
      async stopDebug() {
        calls.push("debug");
        throw new Error("detach refused");
      },
      async endGroup() {
        calls.push("group");
      },
      async closeWorkerTabs(tabIds) {
        calls.push(["workers", tabIds]);
      },
    }),
    /detach refused/,
  );
  assert.deepEqual(calls, ["debug"]);
});

test("a retry with no debugger still restores the group and closes workers", async () => {
  const calls = [];
  const result = await endTaskResources({
    taskId: "task-retry",
    groupSnapshot: {workerTabIds: [42]},
    async stopDebug() {
      calls.push("debug");
      return {released: false, reason: "not_attached"};
    },
    async endGroup() {
      calls.push("group");
      return {released: true};
    },
    async closeWorkerTabs(tabIds) {
      calls.push(["workers", tabIds]);
    },
  });
  assert.equal(result.group.released, true);
  assert.deepEqual(calls, ["debug", ["workers", [42]], "group"]);
});

test("worker close failure preserves the native group for a later retry", async () => {
  const calls = [];
  await assert.rejects(
    endTaskResources({
      taskId: "task-worker-failure",
      debugSnapshot: {workerTabIds: [42]},
      groupSnapshot: {workerTabIds: [42]},
      async stopDebug() {
        calls.push("debug");
        return {released: true};
      },
      async closeWorkerTabs(tabIds) {
        calls.push(["workers", tabIds]);
        throw new Error("worker close refused");
      },
      async endGroup() {
        calls.push("group");
      },
    }),
    /worker close refused/,
  );
  assert.deepEqual(calls, ["debug", ["workers", [42]]]);
});

test("one stale worker id cannot prevent another live worker from closing", async () => {
  const removed = [];
  const result = await closeWorkerTabsIndividually([42, 43], {
    async removeTab(tabId) {
      removed.push(tabId);
      if (tabId === 42) throw new Error("No tab with id: 42");
    },
  });
  assert.deepEqual(removed, [42, 43]);
  assert.deepEqual(result, [
    {tabId: 42, closed: false, alreadyMissing: true},
    {tabId: 43, closed: true},
  ]);
});

test("non-benign worker close failures are retried and retain exact failed ids", async () => {
  const attempts = [];
  await assert.rejects(
    closeWorkerTabsIndividually([42, 43], {
      async removeTab(tabId) {
        attempts.push(tabId);
        if (tabId === 42) throw new Error("browser refused removal");
      },
      wait: async () => undefined,
    }),
    (error) =>
      error?.code === "capture_worker_close_failed" &&
      JSON.stringify(error.failedTabIds) === JSON.stringify([42]),
  );
  assert.equal(attempts.filter((tabId) => tabId === 42).length, 2);
  assert.equal(attempts.filter((tabId) => tabId === 43).length, 1);
});

test("cancellation storage failure is fail-soft so cleanup can continue", async () => {
  const calls = [];
  const cancellation = {
    taskId: "task-storage-failure",
    reason: "native_debug_canceled",
  };
  const published = await publishCancellationFailSoft({
    cancellation,
    notify(value) {
      calls.push(["notify", value.taskId]);
    },
    async writeState() {
      calls.push("storage");
      throw new Error("storage temporarily unavailable");
    },
  });
  calls.push("cleanup");
  assert.equal(published.published, false);
  assert.equal(published.reason, "storage_write_failed");
  assert.deepEqual(calls, [
    ["notify", "task-storage-failure"],
    "storage",
    "cleanup",
  ]);
});
