import assert from "node:assert/strict";
import test from "node:test";

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return {promise, resolve};
}

function createMemoryStorageArea() {
  const values = new Map();
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => values.has(key))
          .map((key) => [key, structuredClone(values.get(key))]),
      );
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch || {})) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      requested.forEach((key) => values.delete(key));
    },
  };
}

test("detail worker registration is awaited before its first navigation", async () => {
  const events = [];
  const registerGate = createDeferred();
  const registerStarted = createDeferred();
  const sourceTab = {
    id: 41,
    windowId: 5,
    index: 3,
    active: true,
    status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=test",
  };
  const workerTab = {
    id: 92,
    windowId: 5,
    index: 4,
    active: false,
    status: "complete",
    url: "about:blank",
  };
  let registeredPayload = null;

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          events.push("begin");
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          registeredPayload = structuredClone(message);
          events.push("register:start");
          registerStarted.resolve();
          await registerGate.promise;
          events.push("register:end");
          return {ok: true, data: {taskId: message.taskId}};
        }
        return {ok: true, data: null};
      },
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
    },
    tabs: {
      async query() {
        return [sourceTab];
      },
      async create(properties) {
        events.push("create");
        return {...workerTab, ...properties, id: workerTab.id};
      },
      async update(tabId, patch) {
        if (tabId === workerTab.id && patch?.url) {
          events.push("navigate");
          throw new Error("stop after first worker navigation");
        }
        return tabId === sourceTab.id
          ? {...sourceTab, ...patch}
          : {...workerTab, ...patch};
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return sourceTab;
        if (tabId === workerTab.id) return workerTab;
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove(tabId) {
        assert.equal(tabId, workerTab.id);
        events.push("remove");
      },
    },
    scripting: {
      async executeScript() {
        return [{result: 0}];
      },
    },
    windows: {
      async update() {
        return {};
      },
    },
  };

  const [{addRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  await addRecord({
    id: "capture-task-worker-order-r1",
    type: "keyword_notes",
    platform: "xiaohongshu",
    payload: {
      items: [
        {
          noteId: "worker-order-note",
          url: "https://www.xiaohongshu.com/explore/worker-order-note?xsec_source=pc_search",
        },
      ],
    },
  });

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: sourceTab.id,
    label: "worker order test",
    platform: "xiaohongshu",
  });

  const batchPromise = captureSync.batchCaptureDetailsForRecords(
    ["capture-task-worker-order-r1"],
    {
      skipAlreadyCaptured: false,
      captureTaskId: activeTask.taskId,
    },
  );

  await Promise.race([
    registerStarted.promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("worker registration did not start")), 1000),
    ),
  ]);
  assert.deepEqual(events, ["begin", "create", "register:start"]);
  assert.equal(events.includes("navigate"), false);

  registerGate.resolve();
  const result = await batchPromise;
  assert.equal(result.ok, false);
  assert.deepEqual(registeredPayload, {
    type: "onstarvoice:register-capture-task-tab",
    taskId: activeTask.taskId,
    tabId: workerTab.id,
    role: "detail_worker",
  });
  assert.ok(events.indexOf("create") < events.indexOf("register:start"));
  assert.ok(events.indexOf("register:end") < events.indexOf("navigate"));
  assert.ok(events.indexOf("navigate") < events.indexOf("remove"));

  await captureSync.endCaptureTaskSession({
    taskId: activeTask.taskId,
    reason: "completed",
    status: "completed",
  });
  taskContext.completeTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
});

test("both double-buffer workers register before any site navigation", async () => {
  const events = [];
  const registrationGates = [createDeferred(), createDeferred()];
  const registrationStarted = [createDeferred(), createDeferred()];
  const sourceTab = {
    id: 51,
    windowId: 6,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=buffer",
  };
  const workers = [
    {id: 192, windowId: 6, index: 3, active: false, status: "complete", url: "about:blank"},
    {id: 193, windowId: 6, index: 4, active: false, status: "complete", url: "about:blank"},
  ];
  const registrations = [];
  let createIndex = 0;

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          events.push("begin");
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          const index = registrations.length;
          registrations.push(structuredClone(message));
          events.push(`register${index + 1}:start`);
          registrationStarted[index].resolve();
          await registrationGates[index].promise;
          events.push(`register${index + 1}:end`);
          return {ok: true, data: {taskId: message.taskId}};
        }
        return {ok: true, data: null};
      },
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
    },
    tabs: {
      async query() {
        return [sourceTab];
      },
      async create(properties) {
        const worker = workers[createIndex];
        createIndex += 1;
        events.push(`create${createIndex}`);
        return {...worker, ...properties, id: worker.id};
      },
      async update(tabId, patch) {
        if (workers.some((worker) => worker.id === tabId) && patch?.url) {
          events.push(`navigate:${tabId}`);
          throw new Error(`No tab with id: ${tabId}`);
        }
        return {id: tabId, ...patch};
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return sourceTab;
        const worker = workers.find((candidate) => candidate.id === tabId);
        if (worker) return worker;
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove(tabId) {
        events.push(`remove:${tabId}`);
      },
    },
    scripting: {
      async executeScript() {
        return [{result: 0}];
      },
    },
    windows: {async update() { return {}; }},
  };

  const [{addRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const recordIds = ["double-buffer-order-r1", "double-buffer-order-r2"];
  for (const [index, recordId] of recordIds.entries()) {
    await addRecord({
      id: recordId,
      type: "keyword_notes",
      platform: "xiaohongshu",
      payload: {
        items: [{
          noteId: `double-buffer-note-${index + 1}`,
          url: `https://www.xiaohongshu.com/explore/double-buffer-note-${index + 1}?xsec_source=pc_search`,
        }],
      },
    });
  }

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: sourceTab.id,
    label: "double worker order test",
    platform: "xiaohongshu",
  });

  const batchPromise = captureSync.batchCaptureDetailsForRecords(recordIds, {
    skipAlreadyCaptured: false,
    captureTaskId: activeTask.taskId,
  });

  await registrationStarted[0].promise;
  assert.equal(events.some((event) => event.startsWith("navigate:")), false);
  registrationGates[0].resolve();
  await registrationStarted[1].promise;
  assert.equal(events.some((event) => event.startsWith("navigate:")), false);
  registrationGates[1].resolve();

  const result = await batchPromise;
  assert.equal(result.ok, false);
  assert.deepEqual(
    registrations.map((item) => item.tabId),
    workers.map((worker) => worker.id),
  );
  const navigationIndex = events.findIndex((event) => event.startsWith("navigate:"));
  assert.ok(events.indexOf("register2:end") < navigationIndex, events.join(" -> "));
  assert.deepEqual(
    events
      .filter((event) => event.startsWith("remove:"))
      .map((event) => Number(event.split(":")[1]))
      .sort((a, b) => a - b),
    workers.map((worker) => worker.id),
  );

  await captureSync.endCaptureTaskSession({
    taskId: activeTask.taskId,
    reason: "completed",
    status: "completed",
  });
  taskContext.completeTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
});
