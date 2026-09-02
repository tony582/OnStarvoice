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
  let stopRequested = false;

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
          stopRequested = true;
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
    shouldStop: () => stopRequested,
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
    events.join(" -> "),
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

test("Xiaohongshu recreates a lost detail worker and retries the same record", async () => {
  const sourceTab = {
    id: 151,
    windowId: 16,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=recovery",
  };
  const workers = [
    {id: 692, windowId: 16, index: 3, active: false, status: "complete", url: "about:blank"},
    {id: 693, windowId: 16, index: 4, active: false, status: "complete", url: "about:blank"},
  ];
  const currentUrls = new Map(workers.map((worker) => [worker.id, worker.url]));
  const registrations = [];
  const navigationTabIds = [];
  const removedTabIds = [];
  const progressPhases = [];
  let createIndex = 0;
  let firstWorkerLost = false;

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          registrations.push(structuredClone(message));
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (
          message?.type === "onstarvoice:relay-to-content" &&
          message?.payload?.action === "captureSingleNote"
        ) {
          assert.equal(message.tabId, workers[1].id);
          return {
            ok: true,
            data: {
              ok: true,
              platform: "xiaohongshu",
              type: "single_note",
              data: {
                noteId: "xhs-recovery-note",
                noteUrl:
                  "https://www.xiaohongshu.com/explore/xhs-recovery-note?xsec_source=pc_search",
                title: "Recovered detail",
                content: "The replacement worker captured this record.",
                author: "Recovery author",
                likes: 8,
              },
              error: null,
            },
          };
        }
        return {ok: true, data: {ok: true}};
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
        assert.ok(worker, "worker recreation exceeded the bounded fixture");
        currentUrls.set(worker.id, String(properties?.url || worker.url));
        return {
          ...worker,
          ...properties,
          id: worker.id,
          url: currentUrls.get(worker.id),
        };
      },
      async update(tabId, patch) {
        const targetUrl = String(patch?.url || "");
        if (targetUrl && workers.some((worker) => worker.id === tabId)) {
          navigationTabIds.push(tabId);
          if (tabId === workers[0].id && !firstWorkerLost) {
            firstWorkerLost = true;
            throw new Error(`No tab with id: ${tabId}`);
          }
          currentUrls.set(tabId, targetUrl);
        }
        if (tabId === sourceTab.id) return {...sourceTab, ...patch};
        const worker = workers.find((candidate) => candidate.id === tabId);
        return {
          ...worker,
          ...patch,
          url: currentUrls.get(tabId) || worker?.url,
          status: "complete",
        };
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return {...sourceTab};
        const worker = workers.find((candidate) => candidate.id === tabId);
        if (!worker || (tabId === workers[0].id && firstWorkerLost)) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        return {
          ...worker,
          url: currentUrls.get(tabId) || worker.url,
          status: "complete",
        };
      },
      async remove(tabId) {
        removedTabIds.push(tabId);
      },
    },
    scripting: {
      async executeScript() {
        return [{result: {blocked: false, isDouyin: false}}];
      },
    },
    windows: {async update() { return {}; }},
  };

  const [{addRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const recordId = "xiaohongshu-worker-recovery-r1";
  await addRecord({
    id: recordId,
    type: "keyword_notes",
    platform: "xiaohongshu",
    payload: {
      items: [{
        noteId: "xhs-recovery-note",
        url:
          "https://www.xiaohongshu.com/explore/xhs-recovery-note?xsec_source=pc_search",
      }],
    },
  });

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: sourceTab.id,
    label: "XHS worker recovery test",
    platform: "xiaohongshu",
  });

  const result = await captureSync.batchCaptureDetailsForRecords([recordId], {
    skipAlreadyCaptured: false,
    captureTaskId: activeTask.taskId,
    detailAfterNavWaitMs: 1,
    onProgress(progress) {
      progressPhases.push(progress?.phase);
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(result.runnerInterrupted, false);
  assert.equal(result.runnerRecoveryCount, 1);
  assert.deepEqual(navigationTabIds, workers.map((worker) => worker.id));
  assert.deepEqual(
    registrations.map((item) => item.tabId),
    workers.map((worker) => worker.id),
  );
  assert.deepEqual(removedTabIds, workers.map((worker) => worker.id));
  assert.equal(progressPhases.includes("detail_runner_recreated"), true);
  assert.equal(progressPhases.includes("detail_item_done"), true);

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

test("Douyin detail batches create one dedicated serial worker and never register the source tab", async () => {
  const events = [];
  const sourceTab = {
    id: 61,
    windowId: 7,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/test?type=general",
  };
  const workerTab = {
    id: 292,
    windowId: 7,
    index: 3,
    active: false,
    status: "complete",
    url: "about:blank",
  };
  let createCount = 0;
  let navigationPatch = null;
  let registeredPayload = null;

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          registeredPayload = structuredClone(message);
          events.push(`register:${message.tabId}`);
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
        createCount += 1;
        events.push(`create:${createCount}`);
        return {...workerTab, ...properties, id: workerTab.id};
      },
      async update(tabId, patch) {
        if (
          tabId === workerTab.id &&
          patch?.url &&
          String(patch.url) !== workerTab.url
        ) {
          navigationPatch = structuredClone(patch);
          events.push("navigate");
          throw new Error("stop after first Douyin navigation");
        }
        return {id: tabId, ...patch};
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return sourceTab;
        if (tabId === workerTab.id) return workerTab;
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove(tabId) {
        assert.equal(tabId, workerTab.id);
        events.push(`remove:${tabId}`);
      },
    },
    scripting: {
      async executeScript() {
        return [{result: {isDouyin: true, detailReady: false}}];
      },
    },
    windows: {async update() { return {}; }},
  };

  const [{addRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const recordIds = ["douyin-single-worker-r1", "douyin-single-worker-r2"];
  for (const [index, recordId] of recordIds.entries()) {
    const noteId = `76619358500000000${index + 1}`;
    await addRecord({
      id: recordId,
      type: "keyword_notes",
      platform: "douyin",
      payload: {
        items: [{
          noteId: index === 0 ? "search_card_1" : noteId,
          noteType: "video",
          duration: "00:29",
          url: `https://www.douyin.com/video/${noteId}`,
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
    label: "Douyin single worker test",
    platform: "douyin",
  });

  const result = await captureSync.batchCaptureDetailsForRecords(recordIds, {
    skipAlreadyCaptured: false,
    captureTaskId: activeTask.taskId,
    shouldStop: () => navigationPatch !== null,
  });

  assert.equal(result.ok, false);
  assert.equal(createCount, 1, events.join(" -> "));
  assert.equal(events.filter((event) => event.startsWith("register:")).length, 1);
  assert.deepEqual(registeredPayload, {
    type: "onstarvoice:register-capture-task-tab",
    taskId: activeTask.taskId,
    tabId: workerTab.id,
    role: "detail_worker",
  });
  assert.notEqual(registeredPayload.tabId, sourceTab.id);
  assert.equal(navigationPatch?.active, true);
  assert.equal(
    navigationPatch?.url,
    "https://www.douyin.com/video/766193585000000001",
  );
  assert.equal(events.includes(`remove:${workerTab.id}`), true);

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

test("Douyin direct-route readiness failure falls back to the record search modal", async () => {
  const sourceTab = {
    id: 71,
    windowId: 8,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/fallback?type=general",
  };
  const workerTab = {
    id: 392,
    windowId: 8,
    index: 3,
    active: false,
    status: "complete",
    url: "about:blank",
  };
  const noteId = "766193585000000099";
  const navigationUrls = [];
  let createCount = 0;
  let sourceNavigationCount = 0;

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
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
        createCount += 1;
        return {...workerTab, ...properties, id: workerTab.id};
      },
      async update(tabId, patch) {
        if (
          tabId === sourceTab.id &&
          patch?.url &&
          String(patch.url) !== sourceTab.url
        ) {
          sourceNavigationCount += 1;
          throw new Error("Douyin source search tab must stay untouched");
        }
        if (
          tabId === workerTab.id &&
          patch?.url &&
          String(patch.url) !== workerTab.url
        ) {
          navigationUrls.push(String(patch.url));
          if (navigationUrls.length === 1) {
            const error = new Error("search modal did not bind the target");
            error.code = "DOUYIN_DETAIL_NOT_READY";
            throw error;
          }
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
      async remove() {
        return undefined;
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
  const recordId = "douyin-modal-timeout-fallback-r1";
  await addRecord({
    id: recordId,
    type: "keyword_notes",
    platform: "douyin",
    meta: {sourceUrl: sourceTab.url},
    payload: {
      searchUrl: sourceTab.url,
      items: [{
        noteId,
        noteType: "video",
        duration: "00:29",
        url: `${sourceTab.url}&modal_id=${noteId}`,
      }],
    },
  });

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: sourceTab.id,
    label: "Douyin modal fallback test",
    platform: "douyin",
  });

  const result = await captureSync.batchCaptureDetailsForRecords([recordId], {
    skipAlreadyCaptured: false,
    captureTaskId: activeTask.taskId,
    detailNavTimeoutMs: 5000,
    shouldStop: () => navigationUrls.length >= 2,
  });

  assert.equal(result.ok, false);
  assert.equal(createCount, 1);
  assert.equal(sourceNavigationCount, 0);
  assert.deepEqual(navigationUrls, [
    `https://www.douyin.com/video/${noteId}`,
    `${sourceTab.url}&modal_id=${noteId}`,
  ]);

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

test("Douyin extractor readiness failure reuses its worker and advances only to the record modal", async () => {
  const sourceTab = {
    id: 73,
    windowId: 8,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/extractor-fallback?type=general",
  };
  const workerTab = {
    id: 394,
    windowId: 8,
    index: 3,
    active: false,
    status: "complete",
    url: "about:blank",
  };
  const noteId = "766193585000000101";
  const directUrl = `https://www.douyin.com/video/${noteId}`;
  const modalUrl = `${sourceTab.url}&modal_id=${noteId}`;
  const navigationUrls = [];
  const captureTabIds = [];
  const removedTabIds = [];
  const events = [];
  let workerCurrentUrl = workerTab.url;
  let createCount = 0;
  let registrationCount = 0;
  let sourceNavigationCount = 0;
  let captureCount = 0;

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          registrationCount += 1;
          assert.equal(message.tabId, workerTab.id);
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (
          message?.type === "onstarvoice:relay-to-content" &&
          message?.payload?.action === "captureSingleNote"
        ) {
          captureCount += 1;
          captureTabIds.push(message.tabId);
          events.push(`capture:${captureCount}`);
          if (captureCount === 1) {
            return {
              ok: true,
              data: {
                ok: false,
                type: "single_note",
                data: null,
                error: {
                  code: "DOUYIN_DETAIL_NOT_READY",
                  message: "direct detail DOM was not readable",
                },
              },
            };
          }
          return {
            ok: true,
            data: {
              ok: true,
              platform: "douyin",
              type: "single_note",
              data: {
                noteId,
                noteUrl: directUrl,
                title: "Extractor fallback detail",
                content: "Fallback capture succeeded from the record modal.",
                author: "Fallback author",
                likes: 12,
                bloggerFollowersCount: 1200,
                bloggerLikedAndCollectedCount: 3400,
                bloggerProfileUrl: "https://www.douyin.com/user/fallback-author",
              },
              meta: {pageType: "note_detail"},
              error: null,
            },
          };
        }
        return {ok: true, data: {ok: true}};
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
        createCount += 1;
        workerCurrentUrl = String(properties?.url || workerTab.url);
        return {
          ...workerTab,
          ...properties,
          id: workerTab.id,
          url: workerCurrentUrl,
        };
      },
      async update(tabId, patch) {
        const targetUrl = String(patch?.url || "");
        if (
          tabId === sourceTab.id &&
          targetUrl &&
          targetUrl !== sourceTab.url
        ) {
          sourceNavigationCount += 1;
          throw new Error("Douyin source search tab must stay untouched");
        }
        if (tabId === workerTab.id && targetUrl) {
          workerCurrentUrl = targetUrl;
          navigationUrls.push(targetUrl);
          events.push(`navigate:${targetUrl}`);
          return {
            ...workerTab,
            ...patch,
            url: workerCurrentUrl,
            status: "complete",
          };
        }
        return tabId === sourceTab.id
          ? {...sourceTab, ...patch}
          : {...workerTab, ...patch, url: workerCurrentUrl};
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return {...sourceTab};
        if (tabId === workerTab.id) {
          return {
            ...workerTab,
            url: workerCurrentUrl,
            status: "complete",
          };
        }
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove(tabId) {
        removedTabIds.push(tabId);
        events.push(`remove:${tabId}`);
      },
    },
    scripting: {
      async executeScript({target, args}) {
        assert.equal(target?.tabId, workerTab.id);
        const expectedNoteId = String(args?.[0] || noteId);
        const isModal = workerCurrentUrl === modalUrl;
        return [{
          result: {
            currentUrl: workerCurrentUrl,
            title: "Douyin detail",
            isDouyin: true,
            currentNoteId: expectedNoteId,
            targetMatched: true,
            activeWorkIds: [expectedNoteId],
            conflictingActiveWorkIds: [],
            activeWorkIdentityConflict: false,
            // Edge 后台直达页的作品 ID 已匹配，但可见 DOM 探针仍会返回
            // false；它必须先进入 extractor，而不是立刻跳去搜索弹层。
            detailReady: isModal,
            apiDetailReady: false,
            requireVisibleDetailRoot: Boolean(args?.[1]),
            hasBoundDetailRoot: isModal,
            usedModalIdentityFallback: isModal,
            isSearchModalContext: isModal,
            blocked: false,
            unavailable: false,
            immediateUnavailable: false,
            code: "",
            message: "",
          },
        }];
      },
    },
    windows: {async update() { return {}; }},
  };

  const [{addRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const recordId = "douyin-extractor-modal-fallback-r1";
  await addRecord({
    id: recordId,
    type: "keyword_notes",
    platform: "douyin",
    meta: {sourceUrl: sourceTab.url},
    payload: {
      searchUrl: sourceTab.url,
      items: [{
        noteId,
        noteType: "video",
        duration: "00:29",
        url: modalUrl,
      }],
    },
  });

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: sourceTab.id,
    label: "Douyin extractor modal fallback test",
    platform: "douyin",
  });

  try {
    const result = await captureSync.batchCaptureDetailsForRecords([recordId], {
      skipAlreadyCaptured: false,
      captureTaskId: activeTask.taskId,
      detailNavTimeoutMs: 5000,
      detailAfterNavWaitMs: 1,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.successCount, 1);
    assert.equal(createCount, 1);
    assert.equal(registrationCount, 1);
    assert.equal(sourceNavigationCount, 0);
    assert.equal(captureCount, 2);
    assert.deepEqual(captureTabIds, [workerTab.id, workerTab.id]);
    assert.deepEqual(
      navigationUrls,
      [directUrl, modalUrl],
      "the extractor fallback must advance to the record modal without replaying direct",
    );
    assert.deepEqual(removedTabIds, [workerTab.id]);
    assert.ok(
      events.indexOf("capture:1") <
        events.indexOf(`navigate:${modalUrl}`) &&
        events.indexOf(`navigate:${modalUrl}`) <
          events.indexOf("capture:2") &&
        events.indexOf("capture:2") <
          events.indexOf(`remove:${workerTab.id}`),
      events.join(" -> "),
    );
  } finally {
    await captureSync.endCaptureTaskSession({
      taskId: activeTask.taskId,
      reason: "completed",
      status: "completed",
    });
    taskContext.completeTaskContext({
      taskType: "capture",
      featureKey: "capture.search",
    });
  }
});

test("Douyin core detail and comments survive optional metrics failure while commit identity stays strict", async () => {
  const sourceTab = {
    id: 74,
    windowId: 8,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/direct-verified?type=general",
  };
  const workerTab = {
    id: 395,
    windowId: 8,
    index: 3,
    active: false,
    status: "complete",
    url: "about:blank",
  };
  const scenarios = [
    {
      recordId: "douyin-direct-verified-nonzero-comments-r1",
      noteId: "766193585000000102",
      comments: 15,
      expectsCommentCapture: true,
      expectsCommitSuccess: true,
    },
    {
      recordId: "douyin-direct-verified-zero-comments-r1",
      noteId: "766193585000000103",
      comments: 0,
      expectsCommentCapture: false,
      expectsCommitSuccess: true,
    },
    {
      recordId: "douyin-direct-verified-route-mismatch-r1",
      noteId: "766193585000000104",
      comments: 0,
      expectsCommentCapture: false,
      expectsCommitSuccess: false,
      postCaptureNoteId: "766193585000000904",
    },
  ].map((scenario) => ({
    ...scenario,
    directUrl: `https://www.douyin.com/video/${scenario.noteId}`,
    modalUrl: `${sourceTab.url}&modal_id=${scenario.noteId}`,
    postCaptureUrl: scenario.postCaptureNoteId
      ? `https://www.douyin.com/video/${scenario.postCaptureNoteId}`
      : `https://www.douyin.com/video/${scenario.noteId}`,
  }));
  const lowFollowerScenarios = [
    {
      recordId: "douyin-low-follower-metrics-unknown-r1",
      noteId: "766193585000000105",
      comments: 9,
      metricsOutcome: "unknown",
    },
    {
      recordId: "douyin-low-follower-proven-zero-r1",
      noteId: "766193585000000106",
      comments: 4,
      metricsOutcome: "zero",
    },
    {
      recordId: "douyin-low-follower-above-threshold-r1",
      noteId: "766193585000000107",
      comments: 2,
      metricsOutcome: "above_threshold",
    },
  ].map((scenario) => ({
    ...scenario,
    directUrl: `https://www.douyin.com/video/${scenario.noteId}`,
    modalUrl: `${sourceTab.url}&modal_id=${scenario.noteId}`,
    postCaptureUrl: `https://www.douyin.com/video/${scenario.noteId}`,
  }));
  const lowFollowerCanceledScenario = {
    recordId: "douyin-low-follower-metrics-canceled-r1",
    noteId: "766193585000000108",
    comments: 3,
    metricsOutcome: "canceled",
    directUrl: "https://www.douyin.com/video/766193585000000108",
    modalUrl: `${sourceTab.url}&modal_id=766193585000000108`,
    postCaptureUrl: "https://www.douyin.com/video/766193585000000108",
  };
  const scenarioByNoteId = new Map(
    [
      ...scenarios,
      ...lowFollowerScenarios,
      lowFollowerCanceledScenario,
    ].map((scenario) => [scenario.noteId, scenario]),
  );
  const navigationUrls = [];
  const contentActions = [];
  const events = [];
  const probeSnapshots = [];
  let workerCurrentUrl = workerTab.url;
  const verifiedDetailNoteIds = new Set();

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          assert.equal(message.tabId, workerTab.id);
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:relay-to-content") {
          const action = String(message?.payload?.action || "");
          if (action === "captureSingleNote") {
            const expectedNoteId = String(
              message.payload.expectedNoteId || "",
            );
            if (message.payload.includeBloggerMetrics === true) {
              const scenario = scenarioByNoteId.get(expectedNoteId);
              assert.ok(
                scenario,
                `optional metrics lost expected note identity: ${expectedNoteId}`,
              );
              contentActions.push({
                action: "captureBloggerMetrics",
                expectedNoteId,
              });
              events.push(`capture:metrics:${expectedNoteId}`);
              if (scenario.metricsOutcome === "canceled") {
                return {
                  ok: true,
                  data: {
                    ok: false,
                    platform: "douyin",
                    type: "single_note",
                    data: null,
                    error: {
                      code: "CAPTURE_CANCELED",
                      message: "DETAIL_CAPTURE_CANCELED",
                    },
                  },
                };
              }
              if (
                scenario.metricsOutcome === "zero" ||
                scenario.metricsOutcome === "above_threshold"
              ) {
                const followersCount =
                  scenario.metricsOutcome === "zero" ? 0 : 9001;
                return {
                  ok: true,
                  data: {
                    ok: true,
                    platform: "douyin",
                    type: "single_note",
                    data: {
                      noteId: expectedNoteId,
                      noteUrl: scenario.directUrl,
                      bloggerFollowersCount: followersCount,
                      bloggerFollowersCountKnown: true,
                      bloggerLikedAndCollectedCount: 100,
                      bloggerLikedAndCollectedCountKnown: true,
                      bloggerMetricsCaptureStatus: "done",
                    },
                    meta: {pageType: "note_detail"},
                    error: null,
                  },
                };
              }
              return {
                ok: true,
                data: {
                  ok: false,
                  platform: "douyin",
                  type: "single_note",
                  data: null,
                  error: {
                    code: "DOUYIN_BLOGGER_METRICS_NOT_READY",
                    message: "optional metrics panel did not become ready",
                  },
                },
              };
            }
            assert.equal(
              message.payload.includeBloggerMetrics,
              false,
              "the core detail transaction must not request optional blogger metrics",
            );
            const scenario = scenarioByNoteId.get(expectedNoteId);
            assert.ok(scenario, `unexpected detail note: ${expectedNoteId}`);
            contentActions.push({
              action,
              expectedNoteId,
            });
            events.push(`capture:single:${expectedNoteId}`);
            assert.equal(message.tabId, workerTab.id);
            assert.equal(workerCurrentUrl, scenario.directUrl);
            verifiedDetailNoteIds.add(expectedNoteId);
            if (scenario.postCaptureNoteId) {
              workerCurrentUrl = scenario.postCaptureUrl;
              events.push(
                `spa-switch:${expectedNoteId}:${scenario.postCaptureNoteId}`,
              );
            }
            return {
              ok: true,
              data: {
                ok: true,
                platform: "douyin",
                type: "single_note",
                data: {
                  noteId: expectedNoteId,
                  noteUrl: scenario.directUrl,
                  title: `Verified direct route detail ${expectedNoteId}`,
                  content: "The exact payload ID has been captured.",
                  author: "Direct route author",
                  likes: 18,
                  bloggerProfileUrl:
                    "https://www.douyin.com/user/direct-route-author",
                  comments: scenario.comments,
                  commentsCountKnown: true,
                  commentsCountSource: "api_statistics",
                },
                meta: {pageType: "note_detail"},
                error: null,
              },
            };
          }
          if (action === "captureComments") {
            const expectedNoteId = String(
              message.payload.expectedNoteId || "",
            );
            const scenario = scenarioByNoteId.get(expectedNoteId);
            assert.ok(scenario, `unexpected comment note: ${expectedNoteId}`);
            assert.equal(
              scenario.expectsCommentCapture,
              true,
              "a confirmed-zero item must never invoke captureComments",
            );
            contentActions.push({
              action,
              expectedNoteId,
              verifiedNoteId: message.payload.verifiedNoteId,
            });
            events.push(`capture:comments:${expectedNoteId}`);
            assert.equal(message.tabId, workerTab.id);
            assert.equal(workerCurrentUrl, scenario.directUrl);
            return {
              ok: true,
              data: {
                ok: true,
                platform: "douyin",
                type: "comments",
                data: {
                  noteId: expectedNoteId,
                  items: [
                    {
                      commentId: `direct-route-comment-${expectedNoteId}`,
                      content: "评论采集已真正执行",
                      userName: "测试用户",
                      likes: 2,
                    },
                  ],
                  captureStatus: "done",
                  stoppedByUser: false,
                  stoppedByStall: false,
                  stopReason: "",
                },
                meta: {captureStatus: "done"},
                error: null,
              },
            };
          }
        }
        return {ok: true, data: {ok: true}};
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
        workerCurrentUrl = String(properties?.url || workerTab.url);
        return {
          ...workerTab,
          ...properties,
          id: workerTab.id,
          url: workerCurrentUrl,
        };
      },
      async update(tabId, patch) {
        if (tabId === sourceTab.id && patch?.url) {
          throw new Error("Douyin source search tab must stay untouched");
        }
        if (tabId === workerTab.id && patch?.url) {
          workerCurrentUrl = String(patch.url);
          navigationUrls.push(workerCurrentUrl);
          events.push(`navigate:${workerCurrentUrl}`);
        }
        return tabId === sourceTab.id
          ? {...sourceTab, ...patch}
          : {
              ...workerTab,
              ...patch,
              url: workerCurrentUrl,
              status: "complete",
            };
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return {...sourceTab};
        if (tabId === workerTab.id) {
          return {
            ...workerTab,
            url: workerCurrentUrl,
            status: "complete",
          };
        }
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove(tabId) {
        assert.equal(tabId, workerTab.id);
        events.push(`remove:${tabId}`);
      },
    },
    scripting: {
      async executeScript({target, args}) {
        assert.equal(target?.tabId, workerTab.id);
        const expectedNoteId = String(args?.[0] || "");
        const scenario = scenarioByNoteId.get(expectedNoteId);
        assert.ok(scenario, `unexpected probe note: ${expectedNoteId}`);
        const afterDetailVerification =
          verifiedDetailNoteIds.has(expectedNoteId);
        const observedNoteId =
          afterDetailVerification && scenario.postCaptureNoteId
            ? scenario.postCaptureNoteId
            : expectedNoteId;
        const expectedCurrentUrl =
          afterDetailVerification && scenario.postCaptureNoteId
            ? scenario.postCaptureUrl
            : scenario.directUrl;
        assert.equal(workerCurrentUrl, expectedCurrentUrl);
        probeSnapshots.push({
          noteId: expectedNoteId,
          observedNoteId,
          currentUrl: workerCurrentUrl,
          requireVisibleDetailRoot: Boolean(args?.[1]),
          afterDetailVerification,
          activeWorkIdentityConflict: false,
        });
        events.push(
          `probe:${afterDetailVerification ? "verified" : "initial"}:${expectedNoteId}`,
        );
        return [{
          result: {
            currentUrl: workerCurrentUrl,
            title: "Douyin direct detail",
            isDouyin: true,
            currentNoteId: observedNoteId,
            targetMatched: observedNoteId === expectedNoteId,
            activeWorkIds: [],
            conflictingActiveWorkIds: [],
            activeWorkIdentityConflict: false,
            detailReady: false,
            apiDetailReady: false,
            requireVisibleDetailRoot: Boolean(args?.[1]),
            hasBoundDetailRoot: false,
            usedModalIdentityFallback: false,
            isSearchModalContext: false,
            blocked: false,
            unavailable: false,
            immediateUnavailable: false,
            code: "",
            message: "",
          },
        }];
      },
    },
    windows: {async update() { return {}; }},
  };

  const [{addRecord, getRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  for (const scenario of [
    ...scenarios,
    ...lowFollowerScenarios,
    lowFollowerCanceledScenario,
  ]) {
    await addRecord({
      id: scenario.recordId,
      type: "keyword_notes",
      platform: "douyin",
      meta: {sourceUrl: sourceTab.url},
      payload: {
        searchUrl: sourceTab.url,
        items: [{
          noteId: scenario.noteId,
          noteType: "video",
          duration: "00:39",
          url: scenario.modalUrl,
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
    label: "Douyin verified direct route test",
    platform: "douyin",
  });

  try {
    const result = await captureSync.batchCaptureDetailsForRecords(
      scenarios.map((scenario) => scenario.recordId),
      {
        skipAlreadyCaptured: false,
        includeComments: true,
        includeBloggerMetrics: true,
        captureTaskId: activeTask.taskId,
        detailNavTimeoutMs: 5000,
        detailAfterNavWaitMs: 1,
      },
    );

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.successCount, 2);
    assert.equal(result.failedCount, 1);
    assert.equal(result.processedCount, 3);
    assert.equal(result.integrityBlocked, true);
    assert.equal(result.fatal, true);
    assert.equal(result.stopBatch, true);
    assert.equal(result.error?.code, "FATAL_DOUYIN_IDENTITY_MISMATCH");
    assert.deepEqual(
      navigationUrls,
      scenarios.map((scenario) => scenario.directUrl),
    );
    for (const scenario of scenarios) {
      assert.equal(navigationUrls.includes(scenario.modalUrl), false);
    }
    assert.deepEqual(contentActions, [
      {
        action: "captureSingleNote",
        expectedNoteId: scenarios[0].noteId,
      },
      {
        action: "captureBloggerMetrics",
        expectedNoteId: scenarios[0].noteId,
      },
      {
        action: "captureComments",
        expectedNoteId: scenarios[0].noteId,
        verifiedNoteId: scenarios[0].noteId,
      },
      {
        action: "captureSingleNote",
        expectedNoteId: scenarios[1].noteId,
      },
      {
        action: "captureBloggerMetrics",
        expectedNoteId: scenarios[1].noteId,
      },
      {
        action: "captureSingleNote",
        expectedNoteId: scenarios[2].noteId,
      },
      {
        action: "captureBloggerMetrics",
        expectedNoteId: scenarios[2].noteId,
      },
    ]);
    for (const scenario of scenarios) {
      const scenarioProbes = probeSnapshots.filter(
        (probe) => probe.noteId === scenario.noteId,
      );
      assert.equal(scenarioProbes[0]?.afterDetailVerification, false);
      assert.equal(
        scenarioProbes[0]?.currentUrl,
        scenario.directUrl,
      );
      assert.equal(
        scenarioProbes.every(
          (probe) => probe.activeWorkIdentityConflict === false,
        ),
        true,
      );
      assert.ok(
        scenarioProbes.filter((probe) => probe.afterDetailVerification)
          .length >= (scenario.expectsCommentCapture ? 2 : 1),
        !scenario.expectsCommitSuccess
          ? "commit must inspect the SPA-switched direct route"
          : scenario.expectsCommentCapture
          ? "comment preflight and commit must both accept the verified direct route without visible detail DOM"
          : "confirmed-zero commit must accept the verified direct route without visible detail DOM",
      );
      const verifiedProbes = scenarioProbes.filter(
        (probe) => probe.afterDetailVerification,
      );
      assert.equal(
        verifiedProbes.every(
          (probe) => probe.currentUrl === scenario.postCaptureUrl,
        ),
        true,
      );
      assert.equal(
        verifiedProbes.every(
          (probe) => probe.observedNoteId ===
            (scenario.postCaptureNoteId || scenario.noteId),
        ),
        true,
      );
      const singleAt = events.indexOf(`capture:single:${scenario.noteId}`);
      const firstVerifiedProbeAt = events.indexOf(
        `probe:verified:${scenario.noteId}`,
      );
      assert.ok(singleAt >= 0 && firstVerifiedProbeAt > singleAt);
      if (scenario.postCaptureNoteId) {
        const spaSwitchAt = events.indexOf(
          `spa-switch:${scenario.noteId}:${scenario.postCaptureNoteId}`,
        );
        assert.ok(spaSwitchAt > singleAt);
        assert.ok(firstVerifiedProbeAt > spaSwitchAt);
      }
      if (scenario.expectsCommentCapture) {
        const commentsAt = events.indexOf(
          `capture:comments:${scenario.noteId}`,
        );
        const finalVerifiedProbeAt = events.lastIndexOf(
          `probe:verified:${scenario.noteId}`,
        );
        assert.ok(commentsAt > firstVerifiedProbeAt);
        assert.ok(finalVerifiedProbeAt > commentsAt);
      } else {
        assert.equal(
          events.includes(`capture:comments:${scenario.noteId}`),
          false,
        );
      }
    }

    const nonzeroRecord = await getRecord(scenarios[0].recordId);
    assert.equal(nonzeroRecord?.payload?.detailCaptureStatus, "done");
    assert.equal(
      nonzeroRecord?.payload?.detailPayload?.noteId,
      scenarios[0].noteId,
    );
    assert.equal(
      nonzeroRecord?.payload?.detailPayload?.commentsCaptureStatus,
      "done",
    );
    assert.equal(
      nonzeroRecord?.payload?.detailPayload?.bloggerMetricsCaptureStatus,
      "failed",
      "optional metrics failure must not roll back the core detail/comment transaction",
    );
    assert.equal(
      nonzeroRecord?.payload?.detailPayload?.commentsTotalCaptured,
      1,
    );
    assert.equal(
      nonzeroRecord?.payload?.detailPayload?.commentsCleanedItems?.[0]?.commentId,
      `direct-route-comment-${scenarios[0].noteId}`,
    );
    assert.notEqual(
      nonzeroRecord?.payload?.detailPayload?.commentsCaptureSkipReason,
      "confirmed_zero",
    );

    const zeroRecord = await getRecord(scenarios[1].recordId);
    assert.equal(zeroRecord?.payload?.detailCaptureStatus, "done");
    assert.equal(
      zeroRecord?.payload?.detailPayload?.noteId,
      scenarios[1].noteId,
    );
    assert.equal(
      zeroRecord?.payload?.detailPayload?.commentsCaptureStatus,
      "done",
    );
    assert.equal(
      zeroRecord?.payload?.detailPayload?.commentsCaptureSkipReason,
      "confirmed_zero",
    );
    assert.equal(
      zeroRecord?.payload?.detailPayload?.commentsTotalCaptured,
      0,
    );
    assert.deepEqual(
      zeroRecord?.payload?.detailPayload?.commentsCleanedItems,
      [],
    );

    const mismatchScenario = scenarios[2];
    const mismatchResult = result.results.find(
      (item) => item.recordId === mismatchScenario.recordId,
    );
    assert.equal(mismatchResult?.ok, false);
    assert.equal(mismatchResult?.reason, "IDENTITY_MISMATCH");
    assert.equal(mismatchResult?.category, "integrity_blocked");
    assert.equal(mismatchResult?.stage, "commit_guard");
    assert.equal(mismatchResult?.integrityBlocked, true);
    assert.equal(mismatchResult?.fatal, true);
    assert.equal(mismatchResult?.stopBatch, true);

    const mismatchRecord = await getRecord(mismatchScenario.recordId);
    assert.equal(mismatchRecord?.payload?.detailCaptureStatus, "failed");
    assert.equal(
      mismatchRecord?.payload?.detailCaptureFailureCode,
      "IDENTITY_MISMATCH",
    );
    assert.equal(
      mismatchRecord?.payload?.detailCaptureFailureStage,
      "commit_guard",
    );
    assert.equal(
      mismatchRecord?.payload?.detailCaptureFailureCategory,
      "integrity_blocked",
    );
    assert.notEqual(mismatchRecord?.payload?.detailCaptureStatus, "done");

    navigationUrls.length = 0;
    contentActions.length = 0;
    probeSnapshots.length = 0;
    verifiedDetailNoteIds.clear();
    workerCurrentUrl = workerTab.url;

    const lowFollowerResult =
      await captureSync.batchCaptureDetailsForRecords(
        lowFollowerScenarios.map((scenario) => scenario.recordId),
        {
          skipAlreadyCaptured: false,
          includeComments: false,
          includeBloggerMetrics: false,
          enableLowFollowerHitFilter: true,
          lowFollowerHitThreshold: 8000,
          captureTaskId: activeTask.taskId,
          detailNavTimeoutMs: 5000,
          detailAfterNavWaitMs: 1,
        },
      );

    assert.equal(lowFollowerResult.ok, false, JSON.stringify(lowFollowerResult));
    assert.equal(lowFollowerResult.successCount, 1);
    assert.equal(lowFollowerResult.failedCount, 1);
    assert.equal(lowFollowerResult.filteredCount, 1);
    assert.equal(lowFollowerResult.processedCount, 3);
    assert.equal(lowFollowerResult.canceled, false);
    assert.equal(lowFollowerResult.fatal, false);
    assert.equal(lowFollowerResult.stopBatch, false);
    assert.equal(lowFollowerResult.securityBlocked, false);
    assert.equal(lowFollowerResult.integrityBlocked, false);
    assert.equal(
      contentActions.some((item) => item.action === "captureComments"),
      false,
    );

    const unknownScenario = lowFollowerScenarios[0];
    const unknownResult = lowFollowerResult.results.find(
      (item) => item.recordId === unknownScenario.recordId,
    );
    assert.equal(unknownResult?.ok, false);
    assert.equal(unknownResult?.reason, "BLOGGER_METRICS_FAILED");
    assert.equal(unknownResult?.stage, "blogger_metrics_capture");
    assert.equal(unknownResult?.category, "page_failed");
    assert.equal(unknownResult?.retryable, true);
    assert.equal(unknownResult?.fatal, false);
    assert.equal(unknownResult?.stopBatch, false);
    assert.equal(unknownResult?.canceled, false);
    const unknownRecord = await getRecord(unknownScenario.recordId);
    assert.ok(unknownRecord, "unknown follower metrics must not delete the item");
    assert.equal(unknownRecord.payload.detailCaptureStatus, "failed");
    assert.equal(
      unknownRecord.payload.detailCaptureFailureCode,
      "BLOGGER_METRICS_FAILED",
    );
    assert.equal(
      unknownRecord.payload.detailPayload?.noteId,
      unknownScenario.noteId,
      "retryable metrics failure must retain the captured core detail",
    );

    const provenZeroScenario = lowFollowerScenarios[1];
    const provenZeroResult = lowFollowerResult.results.find(
      (item) => item.recordId === provenZeroScenario.recordId,
    );
    assert.equal(provenZeroResult?.ok, true);
    assert.notEqual(provenZeroResult?.filtered, true);
    const provenZeroRecord = await getRecord(provenZeroScenario.recordId);
    assert.equal(provenZeroRecord?.payload?.detailCaptureStatus, "done");
    assert.equal(
      provenZeroRecord?.payload?.detailPayload?.bloggerFollowersCount,
      0,
    );
    assert.equal(
      provenZeroRecord?.payload?.detailPayload?.bloggerFollowersCountKnown,
      true,
    );

    const aboveThresholdScenario = lowFollowerScenarios[2];
    const aboveThresholdResult = lowFollowerResult.results.find(
      (item) => item.recordId === aboveThresholdScenario.recordId,
    );
    assert.equal(aboveThresholdResult?.ok, true);
    assert.equal(aboveThresholdResult?.filtered, true);
    assert.equal(aboveThresholdResult?.reason, "low_follower_filtered");
    assert.equal(
      await getRecord(aboveThresholdScenario.recordId),
      null,
      "a proven above-threshold follower count keeps the existing delete/filter behavior",
    );

    workerCurrentUrl = workerTab.url;
    verifiedDetailNoteIds.clear();
    const canceledLowFollowerResult =
      await captureSync.batchCaptureDetailsForRecords(
        [lowFollowerCanceledScenario.recordId],
        {
          skipAlreadyCaptured: false,
          includeComments: false,
          includeBloggerMetrics: false,
          enableLowFollowerHitFilter: true,
          lowFollowerHitThreshold: 8000,
          captureTaskId: activeTask.taskId,
          detailNavTimeoutMs: 5000,
          detailAfterNavWaitMs: 1,
        },
      );
    assert.equal(canceledLowFollowerResult.canceled, true);
    assert.equal(canceledLowFollowerResult.successCount, 0);
    assert.equal(canceledLowFollowerResult.failedCount, 0);
    assert.equal(canceledLowFollowerResult.processedCount, 1);
    const canceledItem = canceledLowFollowerResult.results[0];
    assert.equal(canceledItem.ok, false);
    assert.equal(canceledItem.reason, "CANCELED");
    assert.equal(canceledItem.canceled, true);
    const canceledRecord = await getRecord(
      lowFollowerCanceledScenario.recordId,
    );
    assert.equal(canceledRecord?.payload?.detailCaptureStatus, "failed");
    assert.equal(
      canceledRecord?.payload?.detailCaptureFailureCode,
      "CANCELED",
    );
    assert.equal(
      canceledRecord?.payload?.detailPayload?.noteId,
      lowFollowerCanceledScenario.noteId,
      "mandatory low-follower metrics cancellation retains the core snapshot without committing done",
    );
  } finally {
    await captureSync.endCaptureTaskSession({
      taskId: activeTask.taskId,
      reason: "completed",
      status: "completed",
    });
    taskContext.completeTaskContext({
      taskType: "capture",
      featureKey: "capture.search",
    });
  }
});

test("Douyin security errors stop at the direct route without trying a fallback entry", async () => {
  const sourceTab = {
    id: 72,
    windowId: 8,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/security?type=general",
  };
  const workerTab = {
    id: 393,
    windowId: 8,
    index: 3,
    active: false,
    status: "complete",
    url: "about:blank",
  };
  const noteId = "766193585000000100";
  const navigationUrls = [];

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
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
        return {...workerTab, ...properties, id: workerTab.id};
      },
      async update(tabId, patch) {
        if (
          tabId === workerTab.id &&
          patch?.url &&
          String(patch.url) !== workerTab.url
        ) {
          navigationUrls.push(String(patch.url));
          const error = new Error("Douyin captcha challenge requires human action");
          error.code = "PAGE_CHALLENGE_BLOCK";
          throw error;
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
      async remove() {
        return undefined;
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
  const recordId = "douyin-direct-security-stop-r1";
  await addRecord({
    id: recordId,
    type: "keyword_notes",
    platform: "douyin",
    meta: {sourceUrl: sourceTab.url},
    payload: {
      searchUrl: sourceTab.url,
      items: [{
        noteId,
        noteType: "video",
        duration: "00:29",
        url: `${sourceTab.url}&modal_id=${noteId}`,
      }],
    },
  });

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: sourceTab.id,
    label: "Douyin security stop test",
    platform: "douyin",
  });

  const result = await captureSync.batchCaptureDetailsForRecords([recordId], {
    skipAlreadyCaptured: false,
    captureTaskId: activeTask.taskId,
    detailNavTimeoutMs: 5000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.securityBlocked, true);
  assert.deepEqual(navigationUrls, [
    `https://www.douyin.com/video/${noteId}`,
  ]);

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

test("Douyin worker loss rebuilds once and retries the same expected work under the same task fence", async () => {
  const sourceTab = {
    id: 81,
    windowId: 9,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/rebind?type=general",
  };
  const workers = [493, 494].map((id, index) => ({
    id,
    windowId: 9,
    index: 3 + index,
    active: false,
    status: "complete",
    url: "about:blank",
  }));
  const noteId = "766193585000000181";
  const directUrl = `https://www.douyin.com/video/${noteId}`;
  const registrations = [];
  const navigationTabs = [];
  const removedTabIds = [];
  const captureCalls = [];
  const progress = [];
  const liveWorkerIds = new Set();
  const currentUrls = new Map();
  let firstWorkerLost = false;
  let createCount = 0;

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          registrations.push(structuredClone(message));
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (
          message?.type === "onstarvoice:relay-to-content" &&
          message?.payload?.action === "captureSingleNote"
        ) {
          captureCalls.push({
            tabId: message.tabId,
            expectedNoteId: String(message.payload.expectedNoteId || ""),
            includeBloggerMetrics: message.payload.includeBloggerMetrics,
          });
          assert.equal(message.tabId, workers[1].id);
          assert.equal(message.payload.expectedNoteId, noteId);
          assert.equal(message.payload.includeBloggerMetrics, false);
          return {
            ok: true,
            data: {
              ok: true,
              platform: "douyin",
              type: "single_note",
              data: {
                noteId,
                noteUrl: directUrl,
                title: "Recovered Douyin detail",
                content: "The replacement worker retried the same item.",
                author: "Recovery author",
                comments: 0,
                commentsCountKnown: true,
                commentsCountSource: "api_statistics",
              },
              meta: {pageType: "note_detail"},
              error: null,
            },
          };
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
        const worker = workers[createCount];
        createCount += 1;
        assert.ok(worker, "worker recreation exceeded the bounded fixture");
        liveWorkerIds.add(worker.id);
        currentUrls.set(worker.id, String(properties?.url || worker.url));
        return {
          ...worker,
          ...properties,
          id: worker.id,
          url: currentUrls.get(worker.id),
        };
      },
      async update(tabId, patch) {
        const targetUrl = String(patch?.url || "");
        if (targetUrl && targetUrl !== sourceTab.url) {
          navigationTabs.push({tabId, url: targetUrl});
        }
        if (
          tabId === workers[0].id &&
          targetUrl &&
          targetUrl !== workers[0].url &&
          !firstWorkerLost
        ) {
          firstWorkerLost = true;
          liveWorkerIds.delete(tabId);
          throw new Error(`No tab with id: ${tabId}`);
        }
        if (liveWorkerIds.has(tabId) && targetUrl) {
          currentUrls.set(tabId, targetUrl);
        }
        if (tabId === sourceTab.id) return {...sourceTab, ...patch};
        const worker = workers.find((candidate) => candidate.id === tabId);
        if (!worker || !liveWorkerIds.has(tabId)) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        return {
          ...worker,
          ...patch,
          url: currentUrls.get(tabId) || worker.url,
          status: "complete",
        };
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return {...sourceTab};
        const worker = workers.find((candidate) => candidate.id === tabId);
        if (!worker || !liveWorkerIds.has(tabId)) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        return {
          ...worker,
          url: currentUrls.get(tabId) || worker.url,
          status: "complete",
        };
      },
      async remove(tabId) {
        removedTabIds.push(tabId);
        liveWorkerIds.delete(tabId);
      },
    },
    scripting: {
      async executeScript({target, args}) {
        if (target?.tabId === sourceTab.id) {
          return [{result: 0}];
        }
        assert.equal(target?.tabId, workers[1].id);
        assert.equal(String(args?.[0] || ""), noteId);
        return [{
          result: {
            currentUrl: currentUrls.get(workers[1].id) || directUrl,
            title: "Douyin direct detail",
            isDouyin: true,
            currentNoteId: noteId,
            targetMatched: true,
            activeWorkIds: [],
            conflictingActiveWorkIds: [],
            activeWorkIdentityConflict: false,
            detailReady: false,
            apiDetailReady: false,
            requireVisibleDetailRoot: Boolean(args?.[1]),
            hasBoundDetailRoot: false,
            usedModalIdentityFallback: false,
            isSearchModalContext: false,
            blocked: false,
            unavailable: false,
            immediateUnavailable: false,
            code: "",
            message: "",
          },
        }];
      },
    },
    windows: {async update() { return {}; }},
  };

  const [{addRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const recordId = "douyin-rebind-r1";
  await addRecord({
    id: recordId,
    type: "keyword_notes",
    platform: "douyin",
    meta: {sourceUrl: sourceTab.url},
    payload: {
      searchUrl: sourceTab.url,
      items: [{noteId, noteType: "video", url: directUrl}],
    },
  });

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: sourceTab.id,
    label: "Douyin replacement recovery test",
    platform: "douyin",
  });

  const result = await captureSync.batchCaptureDetailsForRecords([recordId], {
    skipAlreadyCaptured: false,
    captureTaskId: activeTask.taskId,
    detailNavTimeoutMs: 5000,
    detailAfterNavWaitMs: 1,
    onProgress(entry) {
      progress.push(structuredClone(entry));
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(result.runnerInterrupted, false);
  assert.equal(result.runnerRecoveryCount, 1);
  assert.equal(createCount, 2);
  assert.equal(firstWorkerLost, true);
  assert.deepEqual(
    registrations.map((item) => item.tabId),
    workers.map((worker) => worker.id),
  );
  assert.deepEqual(
    registrations.map((item) => item.taskId),
    [activeTask.taskId, activeTask.taskId],
    "the replacement worker must remain under the original task attempt fence",
  );
  assert.deepEqual(
    navigationTabs.map((item) => item.url),
    [directUrl, directUrl],
    "the rebuilt worker must retry the interrupted item before advancing",
  );
  assert.deepEqual(captureCalls, [{
    tabId: workers[1].id,
    expectedNoteId: noteId,
    includeBloggerMetrics: false,
  }]);
  const recoveryProgress = progress.find(
    (entry) => entry?.phase === "detail_runner_recreated",
  );
  assert.equal(recoveryProgress?.recordId, recordId);
  assert.equal(recoveryProgress?.expectedNoteId, noteId);
  assert.deepEqual(removedTabIds, workers.map((worker) => worker.id));

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

test("capture assist registration failure does not block Xiaohongshu detail capture", async () => {
  const sourceTab = {
    id: 91,
    windowId: 10,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=assist-degraded",
  };
  const workerTab = {
    id: 593,
    windowId: 10,
    index: 3,
    active: false,
    status: "complete",
    url: "about:blank",
  };
  const noteIds = [
    "6a94e7f40000000021033bd1",
    "6a94e7f40000000021033bd2",
  ];
  const noteUrls = new Map(noteIds.map((noteId) => [
    noteId,
    `https://www.xiaohongshu.com/explore/${noteId}?xsec_source=pc_search`,
  ]));
  const removedTabIds = [];
  let workerCurrentUrl = workerTab.url;
  let workerCreateCount = 0;
  let registrationAttempts = 0;
  let captureAttempts = 0;

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          registrationAttempts += 1;
          return {
            ok: false,
            error: {
              code: "capture_task_not_found",
              message: "task session ended before worker registration",
            },
          };
        }
        if (
          message?.type === "onstarvoice:relay-to-content" &&
          message?.payload?.action === "captureSingleNote"
        ) {
          captureAttempts += 1;
          assert.equal(message.tabId, workerTab.id);
          const expectedNoteId = String(
            message.payload.expectedNoteId ||
              workerCurrentUrl.match(/\/explore\/([^?]+)/u)?.[1] ||
              "",
          );
          assert.equal(
            noteIds.includes(expectedNoteId),
            true,
            `unexpected expectedNoteId: ${expectedNoteId}`,
          );
          return {
            ok: true,
            data: {
              ok: true,
              platform: "xiaohongshu",
              type: "single_note",
              data: {
                noteId: expectedNoteId,
                noteUrl: noteUrls.get(expectedNoteId),
                title: "Capture continues without assist grouping",
                content: "The optional assist session is not a collection prerequisite.",
                author: "Assist fallback author",
                likes: 6,
              },
              error: null,
            },
          };
        }
        return {ok: true, data: {ok: true}};
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
        workerCreateCount += 1;
        workerCurrentUrl = String(properties?.url || workerTab.url);
        return {
          ...workerTab,
          ...properties,
          id: workerTab.id,
          url: workerCurrentUrl,
        };
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return sourceTab;
        if (tabId === workerTab.id) {
          return {...workerTab, url: workerCurrentUrl, status: "complete"};
        }
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove(tabId) {
        removedTabIds.push(tabId);
        return undefined;
      },
      async update(tabId, patch) {
        if (tabId === workerTab.id && patch?.url) {
          workerCurrentUrl = String(patch.url);
        }
        return {
          id: tabId,
          ...patch,
          url: tabId === workerTab.id ? workerCurrentUrl : sourceTab.url,
          status: "complete",
        };
      },
    },
    scripting: {
      async executeScript() {
        return [{result: {blocked: false, isDouyin: false}}];
      },
    },
    windows: {async update() { return {}; }},
  };

  const [{addRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const recordIds = noteIds.map((_, index) =>
    `xhs-assist-degraded-r${index + 1}`,
  );
  for (const [index, recordId] of recordIds.entries()) {
    const noteId = noteIds[index];
    await addRecord({
      id: recordId,
      type: "keyword_notes",
      platform: "xiaohongshu",
      payload: {
        items: [{
          noteId,
          noteType: "image",
          url: noteUrls.get(noteId),
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
    label: "Xiaohongshu optional assist fallback test",
    platform: "xiaohongshu",
  });

  try {
    const result = await captureSync.batchCaptureDetailsForRecords(recordIds, {
      skipAlreadyCaptured: false,
      captureTaskId: activeTask.taskId,
      detailAfterNavWaitMs: 1,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.processedCount, 2);
    assert.equal(result.successCount, 2);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(
      result.results.map((item) => item.recordId),
      recordIds,
    );
    assert.equal(registrationAttempts, 1);
    assert.equal(workerCreateCount, 1);
    assert.equal(captureAttempts, 2);
    assert.deepEqual(removedTabIds, [workerTab.id]);
  } finally {
    await captureSync.endCaptureTaskSession({
      taskId: activeTask.taskId,
      reason: "completed",
      status: "completed",
    });
    taskContext.completeTaskContext({
      taskType: "capture",
      featureKey: "capture.search",
    });
  }
});
