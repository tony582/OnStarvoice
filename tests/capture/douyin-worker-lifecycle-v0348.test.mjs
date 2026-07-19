import assert from "node:assert/strict";
import test from "node:test";

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

function createDouyinChromeHarness({
  workerTabIds,
  failRegistrationAttempts = 0,
} = {}) {
  const sourceTab = {
    id: 641,
    windowId: 64,
    index: 2,
    active: true,
    status: "complete",
    url: "https://www.douyin.com/jingxuan/search/v0348?type=general",
  };
  const events = [];
  const registrations = [];
  const removedTabIds = [];
  let createIndex = 0;
  let registrationAttempt = 0;

  const chromeApi = {
    storage: {local: createMemoryStorageArea()},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:begin-capture-task") {
          events.push(`begin:${message.taskId}`);
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:register-capture-task-tab") {
          registrationAttempt += 1;
          registrations.push(structuredClone(message));
          events.push(`register:${message.tabId}`);
          if (registrationAttempt <= failRegistrationAttempts) {
            return {
              ok: false,
              error: {
                code: "capture_task_not_found",
                message: "simulated task group setup failure",
              },
            };
          }
          return {ok: true, data: {taskId: message.taskId}};
        }
        if (message?.type === "onstarvoice:end-capture-task") {
          events.push(`end:${message.taskId}`);
          return {ok: true, data: {taskId: message.taskId}};
        }
        return {ok: true, data: null};
      },
      getURL(path) {
        return `chrome-extension://v0348/${path}`;
      },
    },
    tabs: {
      async query() {
        return [{...sourceTab}];
      },
      async create(properties) {
        const tabId = Number(workerTabIds[createIndex]);
        createIndex += 1;
        if (!Number.isSafeInteger(tabId)) {
          throw new Error("worker fixture exhausted");
        }
        events.push(`create:${tabId}`);
        return {
          id: tabId,
          windowId: sourceTab.windowId,
          index: sourceTab.index + createIndex,
          active: false,
          status: "complete",
          url: "about:blank",
          ...properties,
        };
      },
      async update(tabId, patch) {
        events.push(`update:${tabId}`);
        return {id: tabId, status: "complete", ...patch};
      },
      async get(tabId) {
        if (Number(tabId) === sourceTab.id) return {...sourceTab};
        if (workerTabIds.includes(Number(tabId))) {
          return {
            id: Number(tabId),
            windowId: sourceTab.windowId,
            active: false,
            status: "complete",
            url: "about:blank",
          };
        }
        throw new Error(`No tab with id: ${tabId}`);
      },
      async remove(tabId) {
        removedTabIds.push(Number(tabId));
        events.push(`remove:${tabId}`);
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

  return {
    chromeApi,
    sourceTab,
    events,
    registrations,
    removedTabIds,
  };
}

async function seedDouyinRecord(addRecord, recordId, noteId) {
  await addRecord({
    id: recordId,
    type: "keyword_notes",
    platform: "douyin",
    meta: {
      sourceUrl: "https://www.douyin.com/jingxuan/search/v0348?type=general",
    },
    payload: {
      searchUrl: "https://www.douyin.com/jingxuan/search/v0348?type=general",
      items: [
        {
          noteId,
          noteType: "video",
          url: `https://www.douyin.com/video/${noteId}`,
        },
      ],
    },
  });
}

function assertOrdered(events, first, second) {
  const firstIndex = events.indexOf(first);
  const secondIndex = events.indexOf(second);
  assert.ok(firstIndex >= 0, `missing event: ${first}\n${events.join(" -> ")}`);
  assert.ok(secondIndex >= 0, `missing event: ${second}\n${events.join(" -> ")}`);
  assert.ok(
    firstIndex < secondIndex,
    `expected ${first} before ${second}\n${events.join(" -> ")}`,
  );
}

test("v0.3.48 creates and closes a fresh serial Douyin worker for each consecutive batch", async () => {
  const harness = createDouyinChromeHarness({workerTabIds: [701, 702]});
  globalThis.chrome = harness.chromeApi;

  const [{addRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const recordIds = [
    "v0348-douyin-keyword-one",
    "v0348-douyin-keyword-two",
  ];
  await seedDouyinRecord(addRecord, recordIds[0], "766193585000000701");
  await seedDouyinRecord(addRecord, recordIds[1], "766193585000000702");

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: harness.sourceTab.id,
    label: "Douyin v0.3.48 two-keyword lifecycle",
    platform: "douyin",
  });

  try {
    for (const recordId of recordIds) {
      await captureSync.batchCaptureDetailsForRecords([recordId], {
        captureTaskId: activeTask.taskId,
        skipAlreadyCaptured: false,
        shouldStop: () => true,
      });
    }

    assert.deepEqual(
      harness.registrations.map((item) => item.tabId),
      [701, 702],
    );
    assert.equal(
      harness.registrations.some(
        (item) => Number(item.tabId) === harness.sourceTab.id,
      ),
      false,
      "the search source tab must never be registered as a detail worker",
    );
    assert.equal(
      harness.registrations.every((item) => item.role === "detail_worker"),
      true,
    );
    assert.deepEqual(harness.removedTabIds, [701, 702]);
    assertOrdered(harness.events, "remove:701", "create:702");
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

test("two setup failures settle every item, clean both workers, and release the next manual start", async () => {
  const harness = createDouyinChromeHarness({
    workerTabIds: [801, 802, 803],
    failRegistrationAttempts: 2,
  });
  globalThis.chrome = harness.chromeApi;

  const [{addRecord, getRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const failedRecordIds = [
    "v0348-douyin-setup-failure-one",
    "v0348-douyin-setup-failure-two",
  ];
  const manualRecordId = "v0348-douyin-next-manual";
  await seedDouyinRecord(addRecord, failedRecordIds[0], "766193585000000801");
  await seedDouyinRecord(addRecord, failedRecordIds[1], "766193585000000802");
  await seedDouyinRecord(addRecord, manualRecordId, "766193585000000803");

  const failedTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: failedTask.taskId,
    tabId: harness.sourceTab.id,
    label: "Douyin v0.3.48 setup failure retry",
    platform: "douyin",
  });

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await captureSync.batchCaptureDetailsForRecords(
        failedRecordIds,
        {
          captureTaskId: failedTask.taskId,
          skipAlreadyCaptured: false,
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "TASK_TAB_GROUP_UNAVAILABLE");
      assert.equal(result.total, failedRecordIds.length);
      assert.equal(result.processedCount, failedRecordIds.length);
      assert.equal(result.failedCount, failedRecordIds.length);
      assert.equal(result.results.length, failedRecordIds.length);
      assert.deepEqual(
        result.results.map((item) => item.recordId),
        failedRecordIds,
      );
      assert.equal(
        result.results.every(
          (item) =>
            item.ok === false &&
            item.runnerInterrupted === true &&
            item.recoveryRequired === true,
        ),
        true,
      );
      for (const recordId of failedRecordIds) {
        const storedRecord = await getRecord(recordId);
        assert.equal(storedRecord?.payload?.detailCaptureStatus, "failed");
        assert.equal(
          storedRecord?.payload?.detailCaptureFailureCode,
          "TASK_TAB_GROUP_UNAVAILABLE",
        );
        assert.equal(
          storedRecord?.payload?.detailCaptureFailureStage,
          "runner_initialization",
        );
      }
    }
  } finally {
    await captureSync.endCaptureTaskSession({
      taskId: failedTask.taskId,
      reason: "completed_with_failures",
      status: "completed_with_failures",
    });
    taskContext.completeTaskContext({
      taskType: "capture",
      featureKey: "capture.search",
    });
  }

  assert.deepEqual(harness.removedTabIds, [801, 802]);
  assertOrdered(harness.events, "remove:801", "create:802");
  assert.equal(
    taskContext.getActiveTaskContext("capture", "capture.search"),
    null,
    "the failed task context must be released before a manual restart",
  );

  const manualTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: manualTask.taskId,
    tabId: harness.sourceTab.id,
    label: "Douyin v0.3.48 immediate manual restart",
    platform: "douyin",
  });

  try {
    await captureSync.batchCaptureDetailsForRecords([manualRecordId], {
      captureTaskId: manualTask.taskId,
      skipAlreadyCaptured: false,
      shouldStop: () => true,
    });
    assert.equal(harness.registrations.at(-1)?.tabId, 803);
    assert.equal(harness.registrations.at(-1)?.taskId, manualTask.taskId);
    assert.notEqual(manualTask.taskId, failedTask.taskId);
    assertOrdered(harness.events, "remove:802", "create:803");
  } finally {
    await captureSync.endCaptureTaskSession({
      taskId: manualTask.taskId,
      reason: "completed",
      status: "completed",
    });
    taskContext.completeTaskContext({
      taskType: "capture",
      featureKey: "capture.search",
    });
  }

  assert.deepEqual(harness.removedTabIds, [801, 802, 803]);
});
