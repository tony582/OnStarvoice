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
    "https://www.douyin.com/jingxuan/search/test?type=general&modal_id=766193585000000001",
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

test("Douyin modal readiness failure falls back to the direct video route", async () => {
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
    `${sourceTab.url}&modal_id=${noteId}`,
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

test("Douyin dedicated worker loss stops the batch for an outer fresh-worker retry", async () => {
  const sourceTab = {
    id: 81,
    windowId: 9,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/rebind?type=general",
  };
  const workerTab = {
    id: 493,
    windowId: 9,
    index: 3,
    active: false,
    status: "complete",
    url: "about:blank",
  };
  const replacementTab = {
    ...workerTab,
    id: 494,
  };
  const noteIds = ["766193585000000181", "766193585000000182"];
  const registrations = [];
  const navigationTabs = [];
  let replacementListener = null;
  let replacementListenerRemoved = false;
  let replacementTriggered = false;
  let secondNavigationStarted = false;
  let createCount = 0;
  const removedTabIds = [];

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
        return {ok: true, data: null};
      },
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
    },
    tabs: {
      onReplaced: {
        addListener(listener) {
          replacementListener = listener;
        },
        removeListener(listener) {
          assert.equal(listener, replacementListener);
          replacementListenerRemoved = true;
        },
      },
      async query() {
        return [sourceTab];
      },
      async create(properties) {
        createCount += 1;
        return {...workerTab, ...properties, id: workerTab.id};
      },
      async update(tabId, patch) {
        const targetUrl = String(patch?.url || "");
        if (targetUrl && targetUrl !== sourceTab.url) {
          navigationTabs.push({tabId, url: targetUrl});
        }
        if (
          tabId === workerTab.id &&
          targetUrl &&
          targetUrl !== workerTab.url &&
          !replacementTriggered
        ) {
          replacementTriggered = true;
          replacementListener?.(replacementTab.id, workerTab.id);
          throw new Error(`No tab with id: ${workerTab.id}`);
        }
        if (
          tabId === replacementTab.id &&
          targetUrl.includes(noteIds[1])
        ) {
          secondNavigationStarted = true;
        }
        return tabId === sourceTab.id
          ? {...sourceTab, ...patch}
          : tabId === replacementTab.id
            ? {...replacementTab, ...patch}
            : {...workerTab, ...patch};
      },
      async get(tabId) {
        if (tabId === sourceTab.id) {
          return {...sourceTab};
        }
        if (tabId === replacementTab.id && replacementTriggered) {
          return {...replacementTab};
        }
        if (tabId === workerTab.id && !replacementTriggered) {
          return {...workerTab};
        }
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove(tabId) {
        removedTabIds.push(tabId);
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
  const recordIds = ["douyin-rebind-r1", "douyin-rebind-r2"];
  for (const [index, recordId] of recordIds.entries()) {
    await addRecord({
      id: recordId,
      type: "keyword_notes",
      platform: "douyin",
      meta: {sourceUrl: sourceTab.url},
      payload: {
        searchUrl: sourceTab.url,
        items: [{
          noteId: noteIds[index],
          noteType: "video",
          url: `https://www.douyin.com/video/${noteIds[index]}`,
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
    label: "Douyin replacement recovery test",
    platform: "douyin",
  });

  const result = await captureSync.batchCaptureDetailsForRecords(recordIds, {
    skipAlreadyCaptured: false,
    captureTaskId: activeTask.taskId,
    shouldStop: () => secondNavigationStarted,
  });

  assert.equal(createCount, 1);
  assert.equal(replacementTriggered, true);
  assert.equal(replacementListener, null);
  assert.equal(replacementListenerRemoved, false);
  assert.deepEqual(
    registrations.map((item) => item.tabId),
    [workerTab.id],
  );
  assert.equal(
    registrations.some((item) => item.tabId === sourceTab.id),
    false,
  );
  assert.equal(
    navigationTabs.some(
      (item) => item.tabId === workerTab.id && item.url.includes(noteIds[0]),
    ),
    true,
  );
  assert.equal(
    navigationTabs.some(
      (item) => item.tabId === replacementTab.id && item.url.includes(noteIds[1]),
    ),
    false,
  );
  assert.equal(result.processedCount, 1);
  assert.equal(result.runnerInterrupted, true);
  assert.equal(result.results[0]?.reason, "CONTEXT_INTERRUPTED");
  assert.equal(result.results[0]?.runnerInterrupted, true);
  assert.deepEqual(removedTabIds, [workerTab.id]);

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

test("detail worker initialization failure settles every nonempty Douyin target", async () => {
  const sourceTab = {
    id: 91,
    windowId: 10,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/init-failure?type=general",
  };
  const workerTab = {
    id: 593,
    windowId: 10,
    index: 3,
    active: false,
    status: "complete",
    url: "about:blank",
  };

  globalThis.chrome = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          return {
            ok: false,
            error: {
              code: "capture_task_not_found",
              message: "task session ended before worker registration",
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
        return {...workerTab, ...properties, id: workerTab.id};
      },
      async get(tabId) {
        if (tabId === sourceTab.id) return sourceTab;
        if (tabId === workerTab.id) return workerTab;
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove() {
        return undefined;
      },
      async update(tabId, patch) {
        return {id: tabId, ...patch};
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
  const recordIds = ["douyin-init-failure-r1", "douyin-init-failure-r2"];
  for (const [index, recordId] of recordIds.entries()) {
    const noteId = `76619358500000009${index + 1}`;
    await addRecord({
      id: recordId,
      type: "keyword_notes",
      platform: "douyin",
      payload: {
        items: [{
          noteId,
          noteType: "video",
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
    label: "Douyin init failure settlement test",
    platform: "douyin",
  });

  try {
    const result = await captureSync.batchCaptureDetailsForRecords(recordIds, {
      skipAlreadyCaptured: false,
      captureTaskId: activeTask.taskId,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "TASK_TAB_GROUP_UNAVAILABLE");
    assert.equal(result.processedCount, recordIds.length);
    assert.equal(result.failedCount, recordIds.length);
    assert.equal(result.results.length, recordIds.length);
    assert.deepEqual(
      result.results.map((item) => item.recordId),
      recordIds,
    );
    assert.equal(result.results.every((item) => item.ok === false), true);
  } finally {
    await captureSync.endCaptureTaskSession({
      taskId: activeTask.taskId,
      reason: "completed",
      status: "completed_with_failures",
    });
    taskContext.completeTaskContext({
      taskType: "capture",
      featureKey: "capture.search",
    });
  }
});
