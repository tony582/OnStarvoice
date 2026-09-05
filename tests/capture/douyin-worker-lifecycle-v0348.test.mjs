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
  failCreateAttempts = 0,
  captureSingleNote = null,
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
  const captureCalls = [];
  const currentUrls = new Map([[sourceTab.id, sourceTab.url]]);
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
        if (
          message?.type === "onstarvoice:relay-to-content" &&
          message?.payload?.action === "captureSingleNote" &&
          typeof captureSingleNote === "function"
        ) {
          captureCalls.push(structuredClone(message));
          return await captureSingleNote(message);
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
        if (createIndex <= failCreateAttempts) {
          events.push(`create-failed:${tabId}`);
          throw new Error("simulated worker tab creation failure");
        }
        currentUrls.set(tabId, String(properties?.url || "about:blank"));
        events.push(`create:${tabId}`);
        return {
          id: tabId,
          windowId: sourceTab.windowId,
          index: sourceTab.index + createIndex,
          active: false,
          status: "complete",
          url: currentUrls.get(tabId),
          ...properties,
        };
      },
      async update(tabId, patch) {
        if (patch?.url) currentUrls.set(Number(tabId), String(patch.url));
        events.push(`update:${tabId}`);
        return {
          id: tabId,
          status: "complete",
          ...patch,
          url: currentUrls.get(Number(tabId)) || String(patch?.url || ""),
        };
      },
      async get(tabId) {
        if (Number(tabId) === sourceTab.id) {
          return {...sourceTab, url: currentUrls.get(sourceTab.id)};
        }
        if (workerTabIds.includes(Number(tabId))) {
          return {
            id: Number(tabId),
            windowId: sourceTab.windowId,
            active: false,
            status: "complete",
            url: currentUrls.get(Number(tabId)) || "about:blank",
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
      async executeScript({target, args} = {}) {
        const tabId = Number(target?.tabId);
        const currentUrl = currentUrls.get(tabId) || "";
        const expectedNoteId = String(args?.[0] || "");
        return [{
          result: {
            currentUrl,
            title: "Douyin detail fixture",
            isDouyin: true,
            currentNoteId: expectedNoteId,
            targetMatched: true,
            activeWorkIds: expectedNoteId ? [expectedNoteId] : [],
            conflictingActiveWorkIds: [],
            activeWorkIdentityConflict: false,
            detailReady: true,
            apiDetailReady: true,
            hasBoundDetailRoot: true,
            isSearchModalContext: false,
            blocked: false,
            unavailable: false,
            immediateUnavailable: false,
          },
        }];
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
    captureCalls,
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

test("Douyin detail capture succeeds when optional assist registration fails", async () => {
  const noteId = "766193585000000811";
  const directUrl = `https://www.douyin.com/video/${noteId}`;
  const harness = createDouyinChromeHarness({
    workerTabIds: [811],
    failRegistrationAttempts: 1,
    captureSingleNote: async (message) => {
      assert.equal(message.tabId, 811);
      assert.equal(message.payload.expectedNoteId, noteId);
      return {
        ok: true,
        data: {
          ok: true,
          platform: "douyin",
          type: "single_note",
          data: {
            noteId,
            noteUrl: directUrl,
            title: "Optional assist fallback detail",
            content: "Douyin collection remains authoritative without tab grouping.",
            author: "Fallback author",
            comments: 0,
            commentsCountKnown: true,
            commentsCountSource: "api_statistics",
          },
          meta: {pageType: "note_detail"},
          error: null,
        },
      };
    },
  });
  globalThis.chrome = harness.chromeApi;

  const [{addRecord, getRecord}, captureSync, taskContext] = await Promise.all([
    import("../../utils/storage.js"),
    import("../../utils/capture-sync.js"),
    import("../../utils/task-context.js"),
  ]);
  const recordId = "v0348-douyin-assist-degraded";
  await seedDouyinRecord(addRecord, recordId, noteId);

  const activeTask = taskContext.beginTaskContext({
    taskType: "capture",
    featureKey: "capture.search",
  });
  await captureSync.beginCaptureTaskSession({
    taskId: activeTask.taskId,
    tabId: harness.sourceTab.id,
    label: "Douyin optional assist fallback",
    platform: "douyin",
  });

  try {
    const result = await captureSync.batchCaptureDetailsForRecords([recordId], {
      captureTaskId: activeTask.taskId,
      skipAlreadyCaptured: false,
      includeComments: false,
      includeBloggerMetrics: false,
      detailAfterNavWaitMs: 1,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.processedCount, 1);
    assert.equal(result.successCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(harness.registrations.length, 1);
    assert.equal(harness.registrations[0].tabId, 811);
    assert.equal(harness.captureCalls.length, 1);
    assert.deepEqual(harness.removedTabIds, [811]);
    assert.equal((await getRecord(recordId))?.payload?.detailCaptureStatus, "done");
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

  assert.equal(
    taskContext.getActiveTaskContext("capture", "capture.search"),
    null,
  );
});

test("two worker creation failures settle every item and release the next manual start", async () => {
  const harness = createDouyinChromeHarness({
    workerTabIds: [801, 802, 803],
    failCreateAttempts: 2,
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
      assert.equal(result.error?.code, "RUNNER_TAB_UNAVAILABLE");
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
          "RUNNER_TAB_UNAVAILABLE",
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

  assert.deepEqual(harness.removedTabIds, []);
  assertOrdered(harness.events, "create-failed:801", "create-failed:802");
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
    assertOrdered(harness.events, "create-failed:802", "create:803");
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

  assert.deepEqual(harness.removedTabIds, [803]);
});
