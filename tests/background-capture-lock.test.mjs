import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backgroundSource = await readFile(
  resolve(repoRoot, "background.js"),
  "utf8",
);
const taskCenterCoreSource = await readFile(
  resolve(repoRoot, "utils/task-center.js"),
  "utf8",
);
const phase5RuntimeSources = await Promise.all(
  [
    "utils/runtime-tab-policy.js",
    "utils/capture/debug-session.js",
    "utils/capture/task-tab-group.js",
    "utils/capture/task-runtime.js",
    "utils/capture/task-owner.js",
  ].map(async (path) => ({
    path,
    source: await readFile(resolve(repoRoot, path), "utf8"),
  })),
);

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
  };
}

function createHarness() {
  const storage = {};
  const sentTabMessages = [];
  const reloadedTabIds = [];
  const createdTabs = [];
  const updatedTabs = [];
  const alarmDefinitions = new Map();
  const missingTabIds = new Set();
  let uuidCounter = 0;
  let contextMode = "alive";
  let tabMessageHandler = null;
  let tabCreateHandler = null;
  let tabGetHandler = null;
  let reloadHook = null;
  let nextRuntimeSetError = null;
  const unrefSetTimeout = (handler, delay, ...args) => {
    const timer = setTimeout(handler, delay, ...args);
    timer.unref?.();
    return timer;
  };

  const localStorage = {
    async get(keys) {
      if (typeof keys === "string") {
        return Object.hasOwn(storage, keys) ? {[keys]: storage[keys]} : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => Object.hasOwn(storage, key))
            .map((key) => [key, storage[key]]),
        );
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.hasOwn(storage, key) ? storage[key] : fallback,
          ]),
        );
      }
      return {...storage};
    },
    async set(values) {
      if (
        nextRuntimeSetError &&
        Object.hasOwn(values, "onstarvoice.runtime")
      ) {
        const error = nextRuntimeSetError;
        nextRuntimeSetError = null;
        throw error;
      }
      Object.assign(storage, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete storage[key];
      }
    },
  };

  const runtime = {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: createEvent(),
    onConnect: createEvent(),
    getManifest: () => ({version: "test"}),
    getURL: (path) => `chrome-extension://test/${path}`,
    async getContexts({documentIds}) {
      if (contextMode === "throw") {
        throw new Error("getContexts unavailable");
      }
      if (contextMode === "invalid") {
        return null;
      }
      return contextMode === "gone"
        ? []
        : documentIds.map((documentId) => ({documentId}));
    },
  };

  const chrome = {
    runtime,
    storage: {local: localStorage},
    alarms: {
      onAlarm: createEvent(),
      async clear(name) {
        alarmDefinitions.delete(name);
        return true;
      },
      async create(name, options) {
        alarmDefinitions.set(name, {...options});
      },
    },
    action: {onClicked: createEvent()},
    tabs: {
      onActivated: createEvent(),
      onUpdated: createEvent(),
      onRemoved: createEvent(),
      onReplaced: createEvent(),
      async sendMessage(tabId, payload) {
        sentTabMessages.push({tabId, payload});
        if (typeof tabMessageHandler === "function") {
          return await tabMessageHandler(tabId, payload);
        }
        return {ok: true};
      },
      async get(tabId) {
        if (missingTabIds.has(Number(tabId))) {
          throw new Error("No tab with id");
        }
        if (typeof tabGetHandler === "function") {
          return await tabGetHandler(tabId);
        }
        return {
          id: tabId,
          windowId: 1,
          groupId: -1,
          status: "complete",
          url: "https://www.xiaohongshu.com/explore/test-note",
        };
      },
      async query() {
        return [];
      },
      async update(tabId, patch) {
        const tab = {id: tabId, ...patch};
        updatedTabs.push(tab);
        return tab;
      },
      async reload(tabId) {
        reloadedTabIds.push(tabId);
        if (typeof reloadHook === "function") {
          await reloadHook(tabId);
        }
      },
      async create(options) {
        if (typeof tabCreateHandler === "function") {
          return await tabCreateHandler(options);
        }
        const tab = {id: 99 + createdTabs.length, ...options};
        createdTabs.push(tab);
        return tab;
      },
      async group() {
        return 1;
      },
      async ungroup() {},
      async remove(tabId) {
        missingTabIds.add(Number(tabId));
      },
    },
    tabGroups: {
      async get(groupId) {
        return {id: groupId, title: "StarVoice 采集任务"};
      },
      async update(groupId, patch) {
        return {id: groupId, ...patch};
      },
    },
    debugger: {
      onDetach: createEvent(),
      async attach() {},
      async detach() {},
      async sendCommand() {},
      async getTargets() {
        return [];
      },
    },
    sidePanel: {
      async open() {},
      async setOptions() {},
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async update(windowId, patch) {
        return {id: windowId, ...patch};
      },
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
  };

  const context = vm.createContext({
    chrome,
    console: {
      error() {},
      log() {},
      warn() {},
    },
    crypto: {
      randomUUID() {
        uuidCounter += 1;
        return `lock-${uuidCounter}`;
      },
    },
    navigator: {userAgent: "Chrome Test"},
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    clearInterval,
    clearTimeout,
    fetch,
    setInterval,
    setTimeout: unrefSetTimeout,
    importScripts() {},
  });

  vm.runInContext(taskCenterCoreSource, context, {filename: "utils/task-center.js"});
  for (const {path, source} of phase5RuntimeSources) {
    vm.runInContext(source, context, {filename: path});
  }
  vm.runInContext(
    `${backgroundSource}\n;globalThis.__captureLockTestApi = {\n` +
      `  acquireCaptureExecutionLock,\n` +
      `  readActiveCaptureExecutionLock,\n` +
      `  releaseCaptureExecutionLock,\n` +
      `  renewCaptureExecutionLock,\n` +
      `  normalizeCaptureProgress,\n` +
      `  writeRuntimeState,\n` +
      `  clearStoredCaptureProgress,\n` +
      `  markCaptureRequestAborted,\n` +
      `  isCaptureRequestAborted,\n` +
      `  relayToContentWithRetry,\n` +
      `  handleUnattendedKeywordAlarm,\n` +
      `  createUnattendedKeywordRunRequest,\n` +
      `  bindUnattendedRunnerTab,\n` +
      `  saveUnattendedKeywordPlan,\n` +
      `  claimUnattendedKeywordRun,\n` +
      `  updateUnattendedKeywordRun,\n` +
      `  assessUnattendedRunHealth,\n` +
      `  recoverUnattendedKeywordRunRequest,\n` +
      `  manuallyRecoverUnattendedKeywordRun,\n` +
      `  superviseUnattendedKeywordRun,\n` +
      `  syncUnattendedSupervisorAlarm,\n` +
      `  upsertTaskLedgerRun,\n` +
      `  releaseUnattendedKeywordPlanLock,\n` +
      `  flush: () => captureExecutionLockOperationQueue,\n` +
      `  flushRuntime: () => runtimeMutationQueue,\n` +
      `  flushUnattended: () => unattendedRunMutationQueue,\n` +
      `  flushTaskLedger: () => taskLedgerMutationQueue,\n` +
      `};`,
    context,
    {filename: "background.js"},
  );

  return {
    api: context.__captureLockTestApi,
    chrome,
    alarmDefinitions,
    createdTabs,
    updatedTabs,
    reloadedTabIds,
    sentTabMessages,
    failNextRuntimeSet(error = new Error("runtime set failed")) {
      nextRuntimeSetError = error;
    },
    sendBackgroundMessage(message, sender = {}) {
      const listener = runtime.onMessage.listeners[0];
      if (typeof listener !== "function") {
        return Promise.reject(new Error("background message listener missing"));
      }
      return new Promise((resolve) => {
        let responded = false;
        const keepChannelOpen = listener(
          message,
          sender,
          (response) => {
            responded = true;
            resolve(response);
          },
        );
        if (keepChannelOpen !== true && !responded) {
          resolve(undefined);
        }
      });
    },
    setContextMode(mode) {
      contextMode = mode;
    },
    setReloadHook(handler) {
      reloadHook = handler;
    },
    setTabMessageHandler(handler) {
      tabMessageHandler = handler;
    },
    setTabCreateHandler(handler) {
      tabCreateHandler = handler;
    },
    setTabGetHandler(handler) {
      tabGetHandler = handler;
    },
    setTabMissing(tabId, missing = true) {
      if (missing) missingTabIds.add(Number(tabId));
      else missingTabIds.delete(Number(tabId));
    },
    async removeTab(tabId) {
      missingTabIds.add(Number(tabId));
      for (const listener of chrome.tabs.onRemoved.listeners) {
        listener(Number(tabId), {isWindowClosing: false});
      }
      await context.__captureLockTestApi.flushUnattended();
    },
    storage,
  };
}

const LOCK_KEY = "onstarvoice.captureExecutionLock";
const UNATTENDED_PLAN_KEY = "onstarvoice.unattendedKeywordPlan";
const UNATTENDED_REQUEST_KEY = "onstarvoice.unattendedKeywordRunRequest";
const TASK_LEDGER_KEY = "onstarvoice.taskLedger";

function buildUnattendedPlan(overrides = {}) {
  return {
    enabled: true,
    platform: "xiaohongshu",
    mode: "daily",
    startTime: "09:00",
    randomOffsetMin: 0,
    keywords: ["关键词一", "关键词二"],
    nextRunAt: "",
    ...overrides,
  };
}

function seedUnattendedRequest(harness, overrides = {}) {
  const now = new Date().toISOString();
  const plan = buildUnattendedPlan(overrides.planSnapshot || {});
  harness.storage[UNATTENDED_PLAN_KEY] = plan;
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    schemaVersion: 2,
    id: "unattended-run-1",
    attemptId: "attempt-1",
    attemptNumber: 1,
    progressSeq: 1,
    recoveryCount: 0,
    type: "keyword_batch",
    status: "running",
    reason: "alarm",
    createdAt: now,
    claimedAt: now,
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    businessProgressAt: now,
    runnerTabId: 42,
    planSnapshot: plan,
    progress: {
      current: 1,
      total: 2,
      keyword: "关键词一",
      phase: "searching",
      message: "正在采集关键词一",
      updatedAt: now,
    },
    checkpoint: {
      keywordIndex: 0,
      currentKeyword: "关键词一",
      completedKeywords: [],
      failedKeywords: [],
      skippedKeywords: [],
    },
    error: null,
    ...overrides,
    planSnapshot: plan,
  };
  return harness.storage[UNATTENDED_REQUEST_KEY];
}

test("capture progress is persisted with heartbeat and runner metadata", () => {
  const harness = createHarness();
  const before = Date.now();
  const progress = harness.api.normalizeCaptureProgress(
    {
      phase: "comments_collecting",
      captureRequestId: "capture-1",
      recordId: "record-1",
    },
    22,
  );

  assert.equal(progress.captureRequestId, "capture-1");
  assert.equal(progress.recordId, "record-1");
  assert.equal(progress.runnerTabId, 22);
  assert.ok(progress.updatedAt >= before);
  assert.equal(progress.heartbeatAt, progress.updatedAt);
});

test("a persistent list task rejects platform drift before relaying to content", async () => {
  const harness = createHarness();
  let sourceUrl = "https://www.xiaohongshu.com/search_result?keyword=test";
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    groupId: -1,
    status: "complete",
    url: sourceUrl,
    title: "capture source",
  }));

  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "platform-drift-task",
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true, JSON.stringify(begun));

  sourceUrl = "https://s.weibo.com/weibo?q=drifted";
  const rejected = await harness.sendBackgroundMessage({
    type: "onstarvoice:relay-to-content",
    tabId: 41,
    payload: {
      action: "captureKeywordNotes",
      taskId: "platform-drift-task",
      listCaptureRunId: "list-run-platform-drift",
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "capture_task_platform_unsupported");
  assert.equal(harness.sentTabMessages.length, 0);

  await harness.sendBackgroundMessage({
    type: "onstarvoice:end-capture-task",
    taskId: "platform-drift-task",
    reason: "completed",
    status: "completed",
  });
});

test("concurrent progress and page-state messages preserve both runtime patches", async () => {
  const harness = createHarness();
  const sender = {
    tab: {
      id: 22,
      active: true,
      url: "https://www.xiaohongshu.com/explore/test-note",
    },
  };

  const [progressResponse, pageResponse] = await Promise.all([
    harness.sendBackgroundMessage(
      {
        action: "captureProgress",
        progress: {
          phase: "comments_collecting",
          captureRequestId: "request-concurrent",
          recordId: "record-concurrent",
        },
      },
      sender,
    ),
    harness.sendBackgroundMessage(
      {
        action: "pageStateChanged",
        url: sender.tab.url,
        platform: "xiaohongshu",
        pageType: "note_detail",
        detailReady: true,
        detailReadyReason: "ready",
        detailReadyCheckedAt: 4567,
      },
      sender,
    ),
  ]);

  assert.equal(progressResponse.ok, true);
  assert.equal(pageResponse.ok, true);
  const runtime = harness.storage["onstarvoice.runtime"];
  assert.equal(runtime.lastCaptureProgress.captureRequestId, "request-concurrent");
  assert.equal(runtime.lastCaptureProgress.recordId, "record-concurrent");
  assert.equal(runtime.lastPageUrl, sender.tab.url);
  assert.equal(runtime.platform, "xiaohongshu");
  assert.equal(runtime.pageType, "note_detail");
  assert.equal(runtime.detailReady, true);
});

test("a stale clear queued after progress B cannot erase progress B", async () => {
  const harness = createHarness();
  const runtimeKey = "onstarvoice.runtime";
  harness.storage[runtimeKey] = {
    lastCaptureProgress: {
      phase: "comments_partial",
      captureRequestId: "request-a",
      recordId: "record-a",
      updatedAt: 1000,
    },
    lastCaptureProgressAt: 1000,
  };

  const progressB = {
    phase: "comments_collecting",
    captureRequestId: "request-b",
    recordId: "record-b",
    updatedAt: 2000,
  };
  const [, cleared] = await Promise.all([
    harness.api.writeRuntimeState({
      lastCaptureProgress: progressB,
      lastCaptureProgressAt: progressB.updatedAt,
    }),
    harness.api.clearStoredCaptureProgress({captureRequestId: "request-a"}),
  ]);

  assert.equal(cleared, false);
  assert.equal(
    harness.storage[runtimeKey].lastCaptureProgress.captureRequestId,
    "request-b",
  );
  assert.equal(harness.storage[runtimeKey].lastCaptureProgressAt, 2000);
});

test("runtime mutation queue continues after a rejected storage write", async () => {
  const harness = createHarness();
  const runtimeKey = "onstarvoice.runtime";
  harness.failNextRuntimeSet(new Error("injected runtime write failure"));

  await assert.rejects(
    harness.api.writeRuntimeState({platform: "douyin"}),
    /injected runtime write failure/,
  );
  await harness.api.writeRuntimeState({pageType: "search_results"});
  await harness.api.flushRuntime();

  assert.equal(harness.storage[runtimeKey].platform, "unknown");
  assert.equal(harness.storage[runtimeKey].pageType, "search_results");
});

test("delegated runtime updates use the background mutation writer", async () => {
  const harness = createHarness();
  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:update-runtime",
    updates: {
      lastActiveTabId: 88,
      platform: "weibo",
      pageType: "search_results",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.lastActiveTabId, 88);
  assert.equal(response.data.platform, "weibo");
  assert.equal(response.data.pageType, "search_results");
  assert.ok(Number(response.data.lastUpdatedAt) > 0);
});

test("storage updateRuntime delegates in extensions and only falls back without an extension id", async () => {
  const originalChrome = globalThis.chrome;
  const runtimeKey = "onstarvoice.runtime";
  const delegatedMessages = [];
  let directWrites = 0;

  try {
    globalThis.chrome = {
      runtime: {
        id: "runtime-writer-test",
        async sendMessage(message) {
          delegatedMessages.push(message);
          return {ok: true, data: {platform: message.updates.platform}};
        },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {
            directWrites += 1;
          },
        },
      },
    };
    const storageApi = await import(
      new URL("../utils/storage.js?runtime-mutation-test", import.meta.url)
    );

    assert.equal(await storageApi.updateRuntime({platform: "douyin"}), true);
    assert.equal(delegatedMessages.length, 1);
    assert.equal(
      delegatedMessages[0].type,
      "onstarvoice:update-runtime",
    );
    assert.equal(delegatedMessages[0].updates.platform, "douyin");
    assert.equal(directWrites, 0);

    globalThis.chrome = {
      runtime: {
        id: "runtime-writer-test",
        async sendMessage() {
          throw new Error(
            "Could not establish connection. Receiving end does not exist.",
          );
        },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {
            directWrites += 1;
          },
        },
      },
    };

    const originalConsoleError = console.error;
    const delegatedErrors = [];
    console.error = (...args) => delegatedErrors.push(args);
    try {
      assert.equal(await storageApi.updateRuntime({platform: "weibo"}), false);
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(delegatedErrors.length, 1);
    assert.equal(directWrites, 0);

    const fallbackStorage = {
      [runtimeKey]: {
        platform: "xiaohongshu",
        lastCaptureProgress: {captureRequestId: "preserve-me"},
      },
    };
    globalThis.chrome = {
      runtime: {
        async sendMessage() {
          throw new Error(
            "Could not establish connection. Receiving end does not exist.",
          );
        },
      },
      storage: {
        local: {
          async get(key) {
            return Object.hasOwn(fallbackStorage, key)
              ? {[key]: fallbackStorage[key]}
              : {};
          },
          async set(values) {
            Object.assign(fallbackStorage, values);
          },
        },
      },
    };

    assert.equal(
      await storageApi.updateRuntime({pageType: "note_detail"}),
      true,
    );
    assert.equal(fallbackStorage[runtimeKey].platform, "xiaohongshu");
    assert.equal(fallbackStorage[runtimeKey].pageType, "note_detail");
    assert.equal(
      fallbackStorage[runtimeKey].lastCaptureProgress.captureRequestId,
      "preserve-me",
    );
  } finally {
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});

test("capture progress clears only when the dismissed identity still matches", async () => {
  const harness = createHarness();
  const runtimeKey = "onstarvoice.runtime";
  harness.storage[runtimeKey] = {
    lastCaptureProgress: {
      phase: "comments_partial",
      recordId: "record-clear",
      captureRequestId: "request-clear",
      updatedAt: 1234,
    },
    lastCaptureProgressAt: 1234,
  };

  const staleClear = await harness.api.clearStoredCaptureProgress({
    phase: "comments_partial",
    recordId: "record-clear",
    captureRequestId: "request-clear",
    updatedAt: 999,
  });
  assert.equal(staleClear, false);
  assert.equal(
    harness.storage[runtimeKey].lastCaptureProgress.captureRequestId,
    "request-clear",
  );

  const matchedClear = await harness.api.clearStoredCaptureProgress({
    phase: "comments_partial",
    recordId: "record-clear",
    captureRequestId: "request-clear",
    updatedAt: 1234,
  });
  assert.equal(matchedClear, true);
  assert.equal(harness.storage[runtimeKey].lastCaptureProgress, null);
  assert.equal(harness.storage[runtimeKey].lastCaptureProgressAt, 0);
});

test("a settled relay clears recovery progress for the same request", async () => {
  const harness = createHarness();
  const runtimeKey = "onstarvoice.runtime";
  harness.storage[runtimeKey] = {
    lastCaptureProgress: {
      phase: "capture_recovering",
      captureRequestId: "request-settled",
      updatedAt: 2000,
    },
    lastCaptureProgressAt: 2000,
  };

  await harness.api.relayToContentWithRetry(22, {
    action: "captureKeywordNotes",
    captureRequestId: "request-settled",
  });

  assert.equal(harness.storage[runtimeKey].lastCaptureProgress, null);
});

test("an aborted comment request returns a retryable partial without starting content", async () => {
  const harness = createHarness();
  harness.api.markCaptureRequestAborted("comments-aborted-before-start");

  const response = await harness.api.relayToContentWithRetry(22, {
    action: "captureComments",
    captureRequestId: "comments-aborted-before-start",
    recordId: "record-1",
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.captureStatus, "partial");
  assert.equal(response.data.stoppedByUser, true);
  assert.equal(response.meta.stoppedByUser, true);
  assert.equal(response.data.stopReason, "canceled");
  assert.equal(response.data.items.length, 0);
  assert.equal(harness.sentTabMessages.length, 0);
});

test("an aborted non-comment request fails closed instead of returning capture data", async () => {
  const harness = createHarness();
  harness.api.markCaptureRequestAborted("keyword-aborted-before-start");

  await assert.rejects(
    harness.api.relayToContentWithRetry(22, {
      action: "captureKeywordNotes",
      captureRequestId: "keyword-aborted-before-start",
    }),
    (error) => {
      assert.equal(error.code, "CAPTURE_CANCELED");
      return true;
    },
  );
  assert.equal(harness.sentTabMessages.length, 0);
});

test("an in-flight aborted non-comment response cannot escape as success", async () => {
  const harness = createHarness();
  const requestId = "keyword-aborted-after-start";
  harness.setTabMessageHandler(async (_tabId, payload) => {
    if (payload.action === "captureKeywordNotes") {
      harness.api.markCaptureRequestAborted(requestId);
      return {ok: true, data: {items: [{id: "must-not-escape"}]}};
    }
    return {ok: true};
  });

  await assert.rejects(
    harness.api.relayToContentWithRetry(22, {
      action: "captureKeywordNotes",
      captureRequestId: requestId,
    }),
    (error) => {
      assert.equal(error.code, "CAPTURE_CANCELED");
      return true;
    },
  );
});

test("cancel during stalled-tab reload fences the second comments attempt", async () => {
  const harness = createHarness();
  const requestId = "comments-canceled-during-reload";
  let captureAttempts = 0;
  harness.setTabMessageHandler(async (_tabId, payload) => {
    if (payload.action === "captureComments") {
      captureAttempts += 1;
      const error = new Error("stalled");
      error.code = "CONTENT_RELAY_STALLED";
      throw error;
    }
    return {ok: true};
  });
  harness.setReloadHook(() => {
    harness.api.markCaptureRequestAborted(requestId);
  });

  const response = await harness.api.relayToContentWithRetry(33, {
    action: "captureComments",
    captureRequestId: requestId,
    recordId: "record-reload",
  });

  assert.equal(captureAttempts, 1);
  assert.deepEqual(harness.reloadedTabIds, [33]);
  assert.equal(response.data.captureStatus, "partial");
  assert.equal(response.data.stoppedByUser, true);
  const cancelMessage = harness.sentTabMessages.find(
    ({payload}) => payload.action === "cancelCapture",
  );
  assert.equal(cancelMessage.payload.captureRequestId, requestId);
});

test("comment cancellation preserves returned items and forces stoppedByUser", async () => {
  const harness = createHarness();
  const requestId = "comments-canceled-with-items";
  harness.setTabMessageHandler(async (_tabId, payload) => {
    if (payload.action === "captureComments") {
      harness.api.markCaptureRequestAborted(requestId);
      return {
        ok: true,
        type: "comments",
        data: {
          items: [{id: "comment-1", content: "保留我"}],
          totalCount: 1,
          captureStatus: "partial",
          stoppedByUser: false,
        },
        meta: {captureStatus: "partial", stoppedByUser: false},
      };
    }
    return {ok: true};
  });

  const response = await harness.api.relayToContentWithRetry(44, {
    action: "captureComments",
    captureRequestId: requestId,
  });

  assert.equal(response.data.items.length, 1);
  assert.equal(response.data.items[0].id, "comment-1");
  assert.equal(response.data.stoppedByUser, true);
  assert.equal(response.meta.stoppedByUser, true);
  assert.equal(response.data.stopReason, "canceled");
});

test("concurrent acquisition grants exactly one lock", async () => {
  const harness = createHarness();
  const results = await Promise.all([
    harness.api.acquireCaptureExecutionLock({
      owner: "first",
      holderId: "holder-a",
      holderDocumentId: "doc-a",
      holderTabId: 1,
    }),
    harness.api.acquireCaptureExecutionLock({
      owner: "second",
      holderId: "holder-b",
      holderDocumentId: "doc-b",
      holderTabId: 2,
    }),
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.equal(
    harness.storage[LOCK_KEY].id,
    results.find((result) => result.ok).lock.id,
  );
});

test("a vanished holder is canceled and replaced immediately", async () => {
  const harness = createHarness();
  const first = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    holderId: "holder-a",
    holderDocumentId: "doc-a",
    holderTabId: 7,
  });
  harness.setContextMode("gone");

  const second = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    holderId: "holder-b",
    holderDocumentId: "doc-b",
    holderTabId: 8,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(second.lock.id, first.lock.id);
  assert.equal(harness.sentTabMessages.length, 1);
  assert.equal(harness.sentTabMessages[0].tabId, 7);
  assert.equal(harness.sentTabMessages[0].payload.action, "cancelCapture");
});

test("an alive holder remains mutually exclusive", async () => {
  const harness = createHarness();
  const first = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    holderId: "holder-a",
    holderDocumentId: "doc-a",
  });
  const second = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_batch_keyword_capture",
    holderId: "holder-b",
    holderDocumentId: "doc-b",
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.lock.id, first.lock.id);
});

test("renewal requires the exact lock and holder document", async () => {
  const harness = createHarness();
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    holderId: "holder-a",
    holderDocumentId: "doc-a",
  });
  harness.storage[LOCK_KEY].expiresAt = Date.now() + 10;

  const wrongDocument = await harness.api.renewCaptureExecutionLock({
    lockId: acquired.lock.id,
    holderId: "holder-a",
    holderDocumentId: "doc-other",
  });
  assert.equal(wrongDocument.ok, false);
  assert.equal(wrongDocument.reason, "document_mismatch");

  const renewed = await harness.api.renewCaptureExecutionLock({
    lockId: acquired.lock.id,
    holderId: "holder-a",
    holderDocumentId: "doc-a",
  });
  assert.equal(renewed.ok, true);
  assert.ok(renewed.lock.expiresAt > Date.now() + 60_000);
});

test("release is fail-closed for missing, wrong, or foreign tokens", async () => {
  const harness = createHarness();
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    holderId: "holder-a",
    holderDocumentId: "doc-a",
  });

  assert.equal(await harness.api.releaseCaptureExecutionLock(), false);
  assert.equal(await harness.api.releaseCaptureExecutionLock("wrong-lock"), false);
  assert.equal(
    await harness.api.releaseCaptureExecutionLock(acquired.lock.id, {
      holderId: "holder-other",
      holderDocumentId: "doc-a",
      requireHolder: true,
    }),
    false,
  );
  assert.equal(harness.storage[LOCK_KEY].id, acquired.lock.id);

  assert.equal(
    await harness.api.releaseCaptureExecutionLock(acquired.lock.id, {
      holderId: "holder-a",
      holderDocumentId: "doc-a",
      requireHolder: true,
    }),
    true,
  );
  assert.equal(harness.storage[LOCK_KEY], undefined);
});

test("legacy 12-hour ghost locks are removed immediately after upgrade", async () => {
  const harness = createHarness();
  const oldTimestamp = new Date().toISOString();
  harness.storage[LOCK_KEY] = {
    id: "legacy-lock",
    owner: "manual_search_capture",
    label: "手动搜索页采集",
    startedAt: oldTimestamp,
    updatedAt: oldTimestamp,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  };

  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    holderId: "holder-new",
    holderDocumentId: "doc-new",
  });
  assert.equal(acquired.ok, true);
  assert.notEqual(acquired.lock.id, "legacy-lock");
});

test("an unattended alarm defers instead of stealing a live manual lock", async () => {
  const harness = createHarness();
  harness.storage["onstarvoice.unattendedKeywordPlan"] = {
    enabled: true,
    platform: "xiaohongshu",
    mode: "daily",
    startTime: "09:00",
    randomOffsetMin: 0,
    keywords: ["测试关键词"],
    nextRunAt: new Date().toISOString(),
  };
  const manualLock = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    label: "手动搜索页采集",
    holderId: "manual-holder",
    holderDocumentId: "manual-doc",
    holderTabId: 12,
  });

  await harness.api.handleUnattendedKeywordAlarm();

  assert.equal(harness.storage[LOCK_KEY].id, manualLock.lock.id);
  assert.equal(
    harness.storage["onstarvoice.unattendedKeywordPlan"].lastRunStatus,
    "deferred",
  );
  assert.match(
    harness.storage["onstarvoice.unattendedKeywordPlan"].lastRunMessage,
    /手动搜索页采集正在运行/,
  );
});

test("canceling unattended work never releases a manual batch lock", async () => {
  const harness = createHarness();
  const manualLock = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_batch_keyword_capture",
    label: "手动批量关键词采集",
    holderId: "manual-holder",
    holderDocumentId: "manual-doc",
  });

  assert.equal(await harness.api.releaseUnattendedKeywordPlanLock(), false);
  assert.equal(harness.storage[LOCK_KEY].id, manualLock.lock.id);
});

test("getContexts failures fall back conservatively to the lease", async () => {
  const harness = createHarness();
  const first = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    holderId: "holder-a",
    holderDocumentId: "doc-a",
  });

  harness.setContextMode("throw");
  const afterThrow = await harness.api.acquireCaptureExecutionLock({
    owner: "second",
    holderId: "holder-b",
    holderDocumentId: "doc-b",
  });
  assert.equal(afterThrow.ok, false);
  assert.equal(afterThrow.lock.id, first.lock.id);

  harness.setContextMode("invalid");
  const afterInvalid = await harness.api.acquireCaptureExecutionLock({
    owner: "third",
    holderId: "holder-c",
    holderDocumentId: "doc-c",
  });
  assert.equal(afterInvalid.ok, false);
  assert.equal(afterInvalid.lock.id, first.lock.id);

  delete harness.chrome.runtime.getContexts;
  const withoutApi = await harness.api.acquireCaptureExecutionLock({
    owner: "fourth",
    holderId: "holder-d",
    holderDocumentId: "doc-d",
  });
  assert.equal(withoutApi.ok, false);
  assert.equal(withoutApi.lock.id, first.lock.id);
});

test("expired cleanup and concurrent acquisition cannot delete the winner", async () => {
  const harness = createHarness();
  harness.storage[LOCK_KEY] = {
    id: "expired-lock",
    owner: "manual_search_capture",
    label: "手动搜索页采集",
    schemaVersion: 1,
    holderId: "old-holder",
    holderDocumentId: "old-doc",
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    updatedAt: new Date(Date.now() - 10_000).toISOString(),
    expiresAt: Date.now() - 1,
  };

  const results = await Promise.all([
    harness.api.acquireCaptureExecutionLock({
      owner: "first",
      holderId: "holder-a",
      holderDocumentId: "doc-a",
    }),
    harness.api.acquireCaptureExecutionLock({
      owner: "second",
      holderId: "holder-b",
      holderDocumentId: "doc-b",
    }),
  ]);
  const winner = results.find((result) => result.ok);

  assert.ok(winner);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(harness.storage[LOCK_KEY].id, winner.lock.id);
});

test("unattended terminal state absorbs concurrent and late heartbeats", async () => {
  const harness = createHarness();
  const request = await harness.api.createUnattendedKeywordRunRequest(
    buildUnattendedPlan(),
    {reason: "test"},
  );
  const claim = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: 42,
  });
  assert.equal(claim.accepted, true);

  await Promise.all([
    harness.api.updateUnattendedKeywordRun({
      requestId: request.id,
      attemptId: claim.data.attemptId,
      patch: {
        status: "completed",
        message: "采集完成",
        progress: {
          current: 2,
          total: 2,
          keyword: "关键词二",
          phase: "completed",
          message: "全部完成",
        },
      },
    }),
    harness.api.updateUnattendedKeywordRun({
      requestId: request.id,
      attemptId: claim.data.attemptId,
      patch: {heartbeatAt: new Date().toISOString()},
    }),
  ]);
  const lateHeartbeat = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: claim.data.attemptId,
    patch: {heartbeatAt: new Date().toISOString()},
  });

  assert.equal(lateHeartbeat.accepted, false);
  assert.equal(lateHeartbeat.reason, "terminal");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "completed");
  assert.equal(
    harness.storage[UNATTENDED_PLAN_KEY].lastRunProgress.keyword,
    "关键词二",
  );
  const ledgerRun = harness.storage[TASK_LEDGER_KEY].runs.find(
    (item) => item.id === request.id,
  );
  assert.equal(ledgerRun.status, "completed");
  assert.equal(ledgerRun.progress.keyword, "关键词二");
});

test("runner heartbeats never masquerade as business progress", async () => {
  const harness = createHarness();
  const originalBusinessProgressAt = new Date(
    Date.now() - 4 * 60 * 1000,
  ).toISOString();
  const request = seedUnattendedRequest(harness, {
    businessProgressAt: originalBusinessProgressAt,
    progressSeq: 7,
  });
  const heartbeat = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {heartbeatAt: new Date().toISOString()},
  });

  assert.equal(heartbeat.accepted, true);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].businessProgressAt,
    originalBusinessProgressAt,
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].progressSeq, 7);
  assert.ok(
    Date.parse(harness.storage[UNATTENDED_REQUEST_KEY].heartbeatAt) >=
      Date.parse(request.heartbeatAt),
  );
});

test("completed-with-failures is terminal and cannot be resurrected", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness);
  const completed = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      status: "completed_with_failures",
      message: "部分完成",
      progress: {current: 2, total: 2, keyword: "关键词二"},
    },
  });
  const late = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {heartbeatAt: new Date().toISOString()},
  });

  assert.equal(completed.accepted, true);
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "terminal");
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].status,
    "completed_with_failures",
  );
});

test("a concurrent plan save cannot overwrite the request terminal mirror", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness);
  const stalePlan = {
    ...harness.storage[UNATTENDED_PLAN_KEY],
    lastRunStatus: "running",
    lastRunMessage: "旧运行状态",
  };

  await Promise.all([
    harness.api.updateUnattendedKeywordRun({
      requestId: request.id,
      attemptId: request.attemptId,
      patch: {
        status: "completed",
        message: "最终完成",
        progress: {current: 2, total: 2, keyword: "关键词二"},
      },
    }),
    harness.api.saveUnattendedKeywordPlan(stalePlan, {recomputeNext: false}),
  ]);

  assert.equal(harness.storage[UNATTENDED_PLAN_KEY].lastRunStatus, "completed");
  assert.equal(harness.storage[UNATTENDED_PLAN_KEY].lastRunMessage, "最终完成");
});

test("a recovered attempt fences updates from the old runner", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness);
  const recovery = await harness.api.recoverUnattendedKeywordRunRequest(
    request,
    {healthy: false, reason: "business_progress_stalled"},
  );
  assert.equal(recovery.recovered, true, JSON.stringify(recovery));
  const recovered = harness.storage[UNATTENDED_REQUEST_KEY];
  assert.notEqual(recovered.attemptId, request.attemptId);
  assert.equal(recovered.attemptNumber, 2);

  const staleUpdate = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      status: "completed",
      progress: {current: 2, total: 2, keyword: "旧运行页"},
    },
  });
  assert.equal(staleUpdate.accepted, false);
  assert.equal(staleUpdate.reason, "attempt_mismatch");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].attemptId, recovered.attemptId);
  const ledgerRun = harness.storage[TASK_LEDGER_KEY].runs.find(
    (item) => item.id === request.id,
  );
  assert.equal(ledgerRun.attemptId, recovered.attemptId);
});

test("only the runner tab assigned by background can claim a pending request", async () => {
  const harness = createHarness();
  const request = await harness.api.createUnattendedKeywordRunRequest(
    buildUnattendedPlan(),
    {reason: "test"},
  );
  await harness.api.bindUnattendedRunnerTab(request, 55);

  const foreign = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: 56,
  });
  const assigned = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: 55,
  });

  assert.equal(foreign.accepted, false);
  assert.equal(foreign.reason, "runner_mismatch");
  assert.equal(assigned.accepted, true);
  assert.equal(assigned.data.runnerTabId, 55);
});

test("refreshing the same runner preserves its protected wait and business clock", async () => {
  const harness = createHarness();
  const businessProgressAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  const recoveryWaitUntil = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const request = seedUnattendedRequest(harness, {
    runnerTabId: 42,
    businessProgressAt,
    recoveryWaitUntil,
  });
  const originalLock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "old-holder",
    holderDocumentId: "old-document",
    holderTabId: 91,
  });

  const resumed = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: 42,
    senderDocumentId: "new-document",
    holderId: "new-holder",
  });

  assert.equal(resumed.accepted, true);
  assert.equal(resumed.reason, "resumed");
  assert.equal(resumed.data.businessProgressAt, businessProgressAt);
  assert.equal(resumed.data.recoveryWaitUntil, recoveryWaitUntil);
  assert.equal(resumed.lock.id, originalLock.lock.id);
  assert.equal(harness.storage[LOCK_KEY].holderId, "new-holder");
  assert.equal(harness.storage[LOCK_KEY].holderDocumentId, "new-document");
  assert.equal(harness.storage[LOCK_KEY].holderTabId, 91);
  assert.ok(
    harness.sentTabMessages.some(
      ({tabId, payload}) => tabId === 91 && payload?.action === "cancelCapture",
    ),
  );
});

test("runner refresh keeps an expired unattended lock target long enough to stop it", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    runnerTabId: 42,
    progress: {current: 0, total: 2, phase: "starting", runnerTabId: null},
  });
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "old-holder",
    holderDocumentId: "old-document",
    holderTabId: 92,
  });
  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    expiresAt: Date.now() - 1,
  };

  const resumed = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: 42,
    senderDocumentId: "new-document",
    holderId: "new-holder",
  });

  assert.equal(resumed.accepted, true);
  assert.equal(resumed.lock.id, acquired.lock.id);
  assert.equal(resumed.lock.holderTabId, 92);
  assert.ok(
    harness.sentTabMessages.some(
      ({tabId, payload}) => tabId === 92 && payload?.action === "cancelCapture",
    ),
  );
});

test("runner refresh fails closed when another capture owns the lock", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {runnerTabId: 42});
  const manualLock = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_batch_keyword_capture",
    label: "手动关键词采集",
    holderId: "manual-holder",
    holderDocumentId: "manual-document",
    holderTabId: 93,
  });

  const blocked = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: 42,
    senderDocumentId: "new-document",
    holderId: "new-holder",
  });

  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, "capture_lock_conflict");
  assert.equal(blocked.data.status, "needs_action");
  assert.equal(harness.storage[LOCK_KEY].id, manualLock.lock.id);
  assert.equal(harness.storage[LOCK_KEY].holderId, "manual-holder");
});

test("runner refresh hard-reloads the old capture tab when cancel is not acknowledged", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {runnerTabId: 42});
  await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "old-holder",
    holderDocumentId: "old-document",
    holderTabId: 91,
  });
  harness.setTabMessageHandler(async () => ({
    ok: false,
    error: {message: "旧页面没有确认取消"},
  }));

  const resumed = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: 42,
    senderDocumentId: "new-document",
    holderId: "new-holder",
  });

  assert.equal(resumed.accepted, true);
  assert.deepEqual(harness.reloadedTabIds, [91]);
});

test("runner refresh requires attention when neither cancel nor reload can stop the old capture", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {runnerTabId: 42});
  await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "old-holder",
    holderDocumentId: "old-document",
    holderTabId: 91,
  });
  harness.setTabMessageHandler(async () => ({
    ok: false,
    error: {message: "旧页面没有确认取消"},
  }));
  harness.setReloadHook(async () => {
    throw new Error("reload failed");
  });

  const blocked = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: 42,
    senderDocumentId: "new-document",
    holderId: "new-holder",
  });

  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, "previous_capture_stop_unconfirmed");
  assert.equal(blocked.data.status, "needs_action");
  assert.equal(
    blocked.data.error.code,
    "PREVIOUS_CAPTURE_STOP_UNCONFIRMED",
  );
  assert.equal(harness.storage[LOCK_KEY].holderDocumentId, "new-document");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "needs_action");
});

test("supervisor detects business stalls even while runner heartbeats are fresh", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    heartbeatAt: new Date().toISOString(),
    businessProgressAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(result.recovered, true, JSON.stringify(result));
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 1);
  assert.notEqual(harness.storage[UNATTENDED_REQUEST_KEY].attemptId, request.attemptId);
});

test("fresh content business progress protects a long-running unattended capture", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    heartbeatAt: new Date().toISOString(),
    businessProgressAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
  });
  const progress = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      progressSeq: request.progressSeq + 1,
      progress: {
        phase: "capturing",
        keyword: "关键词一",
        current: 37,
        total: 100,
        message: "已检测 37 条，继续滚动",
      },
    },
  });
  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(progress.accepted, true);
  assert.equal(result.healthy, true, JSON.stringify(result));
  assert.equal(result.reason, "active");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].attemptId, request.attemptId);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 0);
});

test("a long round gap remains a protected wait beyond the business stall threshold", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    heartbeatAt: new Date().toISOString(),
    businessProgressAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
    recoveryWaitUntil: new Date(Date.now() + 23 * 60 * 1000).toISOString(),
    progress: {
      current: 0,
      total: 2,
      keyword: "",
      phase: "waiting_next_round",
      message: "第 1 轮完成，等待第 2 轮",
    },
  });
  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(result.healthy, true);
  assert.equal(result.reason, "protected_wait");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].attemptId, request.attemptId);
  assert.equal(harness.createdTabs.length, 0);

  const resumed = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      waitUntil: "",
      progress: {current: 1, total: 2, keyword: "关键词一", phase: "resumed"},
    },
  });
  assert.equal(resumed.accepted, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryWaitUntil, "");
});

test("stalled list capture recovery cancels the old lock holder before replacement", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    progress: {
      current: 1,
      total: 2,
      keyword: "关键词一",
      phase: "capturing",
      message: "正在采集列表",
      runnerTabId: null,
    },
  });
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "sidebar-holder",
    holderDocumentId: "sidebar-document",
    holderTabId: 73,
  });

  assert.equal(acquired.ok, true);
  const result = await harness.api.recoverUnattendedKeywordRunRequest(request, {
    healthy: false,
    reason: "business_progress_stalled",
  });

  assert.equal(result.recovered, true);
  assert.ok(
    harness.sentTabMessages.some(
      ({tabId, payload}) => tabId === 73 && payload?.action === "cancelCapture",
    ),
  );
  assert.notEqual(
    harness.storage[UNATTENDED_REQUEST_KEY].attemptId,
    request.attemptId,
  );
});

test("automatic recovery never launches a replacement when the old capture cannot be stopped", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    progress: {
      current: 1,
      total: 2,
      keyword: "关键词一",
      phase: "capturing",
      runnerTabId: 74,
    },
  });
  await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "sidebar-holder",
    holderDocumentId: "sidebar-document",
    holderTabId: 74,
  });
  harness.setTabMessageHandler(async () => ({
    ok: false,
    error: {message: "旧页面没有确认取消"},
  }));
  harness.setReloadHook(async () => {
    throw new Error("reload failed");
  });

  const result = await harness.api.recoverUnattendedKeywordRunRequest(request, {
    healthy: false,
    reason: "business_progress_stalled",
  });

  assert.equal(result.recovered, false);
  assert.equal(result.reason, "previous_capture_stop_unconfirmed");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "needs_action");
  assert.equal(harness.storage[LOCK_KEY].holderTabId, 74);
  assert.equal(harness.createdTabs.length, 0);
});

test("closing the active runner triggers recovery through tabs.onRemoved", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {runnerTabId: 77});

  await harness.removeTab(77);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await harness.api.flushUnattended();

  assert.notEqual(
    harness.storage[UNATTENDED_REQUEST_KEY].attemptId,
    request.attemptId,
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 1);
});

test("startup and sleep recovery apply a short grace before retrying", async () => {
  const harness = createHarness();
  const oldTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const request = seedUnattendedRequest(harness, {
    heartbeatAt: oldTimestamp,
    businessProgressAt: oldTimestamp,
  });

  const wakeResult = await harness.api.superviseUnattendedKeywordRun({
    applyWakeGrace: true,
    reason: "browser_startup",
  });
  assert.equal(wakeResult.reason, "wake_grace");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].attemptId, request.attemptId);
  assert.ok(
    Date.parse(harness.storage[UNATTENDED_REQUEST_KEY].wakeGraceUntil) > Date.now(),
  );

  harness.storage[UNATTENDED_REQUEST_KEY].wakeGraceUntil = new Date(
    Date.now() - 1000,
  ).toISOString();
  const afterGrace = await harness.api.superviseUnattendedKeywordRun();
  assert.equal(afterGrace.recovered, true, JSON.stringify(afterGrace));
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 1);
});

test("a delayed supervisor alarm identifies wake-from-sleep without storage churn", async () => {
  const harness = createHarness();
  const oldTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const request = seedUnattendedRequest(harness, {
    heartbeatAt: oldTimestamp,
    businessProgressAt: oldTimestamp,
  });
  const result = await harness.api.superviseUnattendedKeywordRun({
    scheduledTime: Date.now() - 10 * 60 * 1000,
    reason: "supervisor_alarm",
  });

  assert.equal(result.reason, "wake_grace");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].attemptId, request.attemptId);
});

test("recovery stops at the bounded retry limit and requires attention", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    recoveryCount: 2,
    heartbeatAt: new Date().toISOString(),
    businessProgressAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(result.terminal, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "needs_action");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].attemptId, request.attemptId);
  assert.match(harness.storage[UNATTENDED_REQUEST_KEY].message, /达到 2 次/);
});

test("repeated runner launch failures also stop instead of recovering forever", async () => {
  const harness = createHarness();
  seedUnattendedRequest(harness, {
    heartbeatAt: new Date().toISOString(),
    businessProgressAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  harness.setTabCreateHandler(async () => {
    throw new Error("cannot create tab");
  });

  const first = await harness.api.superviseUnattendedKeywordRun();
  assert.equal(first.deferred, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryLaunchFailures, 1);
  harness.storage[UNATTENDED_REQUEST_KEY].recoveryWaitUntil = new Date(
    Date.now() - 1000,
  ).toISOString();
  const second = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(second.terminal, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "needs_action");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryLaunchFailures, 2);
});

test("keyword checkpoints become task-center success failure and skip details", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness);
  const checkpoint = {
    schemaVersion: 1,
    round: 1,
    activeKeywordIndex: 1,
    activeKeyword: "关键词二",
    activePhase: "finished",
    keywordResults: [
      {round: 1, keyword: "关键词一", status: "completed", attemptCount: 1},
      {round: 1, keyword: "关键词二", status: "failed", attemptCount: 2},
    ],
    updatedAt: new Date().toISOString(),
  };
  await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      status: "completed_with_failures",
      checkpoint,
      progress: {current: 2, total: 2, keyword: "关键词二"},
    },
  });

  const run = harness.storage[TASK_LEDGER_KEY].runs.find(
    (item) => item.id === request.id,
  );
  assert.deepEqual(Array.from(run.checkpoint.completedKeywords), ["关键词一"]);
  assert.deepEqual(Array.from(run.checkpoint.failedKeywords), ["关键词二"]);
  assert.deepEqual(
    Array.from(run.checkpoint.keywordResults, (entry) => ({
      keyword: entry.keyword,
      status: entry.status,
      attemptCount: entry.attemptCount,
    })),
    [
      {keyword: "关键词一", status: "completed", attemptCount: 1},
      {keyword: "关键词二", status: "failed", attemptCount: 2},
    ],
  );
  assert.deepEqual(Array.from(run.metadata.keywords), ["关键词一", "关键词二"]);
});

test("automatic recovery never releases or steals a manual capture lock", async () => {
  const harness = createHarness();
  seedUnattendedRequest(harness, {
    heartbeatAt: new Date().toISOString(),
    businessProgressAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const manualLock = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_batch_keyword_capture",
    label: "手动批量关键词采集",
    holderId: "manual-holder",
    holderDocumentId: "manual-document",
  });

  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(result.deferred, true);
  assert.equal(harness.storage[LOCK_KEY].id, manualLock.lock.id);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "recovering");
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryPendingLaunch,
    true,
  );
});

test("risk and login failures trip a circuit breaker without automatic retries", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    message: "账号触发安全验证，请重新登录",
    error: {code: "LOGIN_REQUIRED", message: "请重新登录"},
    heartbeatAt: new Date().toISOString(),
    businessProgressAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(result.terminal, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "needs_action");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 0);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].attemptId, request.attemptId);
});

test("manual recovery creates a new linked request and opens one runner", async () => {
  const harness = createHarness();
  const failed = seedUnattendedRequest(harness, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    checkpoint: {
      keywordIndex: 1,
      currentKeyword: "关键词二",
      completedKeywords: ["关键词一"],
      failedKeywords: ["关键词二"],
      skippedKeywords: [],
    },
  });
  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:recover-unattended-keyword-run",
    requestId: failed.id,
    mode: "remaining",
  });

  assert.equal(response.ok, true);
  assert.notEqual(response.data.id, failed.id);
  assert.equal(response.data.parentRequestId, failed.id);
  assert.equal(response.data.checkpoint.completedKeywords[0], "关键词一");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "pending");
  assert.equal(harness.createdTabs.length, 2);
});

test("retry-failed recovery narrows the new plan to failed keywords", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    planSnapshot: buildUnattendedPlan({
      autoLoop: true,
      maxRounds: 5,
      roundGapMin: 10,
    }),
  });
  await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      status: "failed",
      checkpoint: {
        schemaVersion: 1,
        round: 1,
        activeKeywordIndex: 1,
        activeKeyword: "关键词二",
        activePhase: "failed",
        keywordResults: [
          {round: 1, keyword: "关键词一", status: "completed", attemptCount: 1},
          {round: 1, keyword: "关键词二", status: "failed", attemptCount: 2},
        ],
      },
      progress: {current: 2, total: 2, keyword: "关键词二"},
    },
  });
  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:recover-unattended-keyword-run",
    requestId: request.id,
    mode: "failed",
  });

  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.data.planSnapshot.keywords), ["关键词二"]);
  assert.equal(response.data.planSnapshot.autoLoop, false);
  assert.equal(response.data.planSnapshot.maxRounds, 1);
  assert.equal(response.data.planSnapshot.roundGapMin, 0);
  assert.deepEqual(Array.from(response.data.checkpoint.keywordResults), []);
});

test("recovering a needs-action task resolves the old ledger entry", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness);
  await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      status: "needs_action",
      message: "请重新登录",
      error: {code: "LOGIN_REQUIRED", message: "请重新登录"},
      progress: {current: 1, total: 2, keyword: "关键词一"},
    },
  });
  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:recover-unattended-keyword-run",
    requestId: request.id,
    mode: "remaining",
  });
  const oldRun = harness.storage[TASK_LEDGER_KEY].runs.find(
    (run) => run.id === request.id,
  );

  assert.equal(response.ok, true);
  assert.equal(oldRun.status, "canceled");
  assert.equal(oldRun.metadata.recoveredByTaskId, response.data.id);
});

test("cancel rejects a stale task id without touching the current request", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness);
  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:cancel-unattended-keyword-run",
    requestId: "another-task",
    message: "停止任务",
  });

  assert.equal(response.ok, false);
  assert.equal(response.reason, "request_mismatch");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].id, request.id);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "running");
});

test("cancel snapshots the unattended lock holder and stops list capture before release", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    progress: {
      current: 1,
      total: 2,
      keyword: "关键词一",
      phase: "capturing",
      runnerTabId: null,
    },
  });
  await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "sidebar-holder",
    holderDocumentId: "sidebar-document",
    holderTabId: 81,
  });

  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:cancel-unattended-keyword-run",
    requestId: request.id,
    message: "停止并保留",
  });

  assert.equal(response.ok, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "canceled");
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.ok(
    harness.sentTabMessages.some(
      ({tabId, payload}) => tabId === 81 && payload?.action === "cancelCapture",
    ),
  );
});

test("disabling the plan also stops the lock holder captured before cancellation", async () => {
  const harness = createHarness();
  seedUnattendedRequest(harness, {
    progress: {current: 0, total: 2, phase: "navigating", runnerTabId: null},
  });
  await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "sidebar-holder",
    holderDocumentId: "sidebar-document",
    holderTabId: 82,
  });

  await harness.api.saveUnattendedKeywordPlan(
    buildUnattendedPlan({enabled: false}),
  );

  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "canceled");
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.ok(
    harness.sentTabMessages.some(
      ({tabId, payload}) => tabId === 82 && payload?.action === "cancelCapture",
    ),
  );
});

test("keep-results resolves needs-action but is idempotent for finished work", async () => {
  const needsActionHarness = createHarness();
  const needsAction = seedUnattendedRequest(needsActionHarness, {
    status: "needs_action",
    finishedAt: new Date().toISOString(),
  });
  const resolved = await needsActionHarness.sendBackgroundMessage({
    type: "onstarvoice:cancel-unattended-keyword-run",
    requestId: needsAction.id,
    message: "保留已有结果",
  });
  assert.equal(resolved.ok, true);
  assert.equal(
    needsActionHarness.storage[UNATTENDED_REQUEST_KEY].status,
    "canceled",
  );

  const finishedHarness = createHarness();
  const finished = seedUnattendedRequest(finishedHarness, {
    status: "failed",
    finishedAt: new Date().toISOString(),
  });
  const kept = await finishedHarness.sendBackgroundMessage({
    type: "onstarvoice:cancel-unattended-keyword-run",
    requestId: finished.id,
    message: "保留已有结果",
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.reason, "already_terminal");
  assert.equal(finishedHarness.storage[UNATTENDED_REQUEST_KEY].status, "failed");
});

test("generic task ledger messages share normalized upsert and history reads", async () => {
  const harness = createHarness();
  const upsert = await harness.sendBackgroundMessage({
    type: "onstarvoice:upsert-task-run",
    run: {
      id: "manual-task-1",
      taskType: "manual_capture",
      title: "手动采集",
      status: "running",
      attemptId: "manual-attempt-1",
      attemptNumber: 1,
    },
    event: {type: "started", message: "开始采集"},
  });
  const ledger = await harness.sendBackgroundMessage({
    type: "onstarvoice:get-task-ledger",
  });

  assert.equal(upsert.accepted, true);
  assert.equal(ledger.ok, true);
  assert.equal(ledger.data.runs[0].id, "manual-task-1");
  assert.equal(ledger.data.runs[0].events[0].message, "开始采集");
});

test("the unattended supervisor alarm is installed as a one-minute heartbeat", async () => {
  const harness = createHarness();
  await harness.api.syncUnattendedSupervisorAlarm();
  assert.equal(
    harness.alarmDefinitions.get("onstarvoice:unattended-supervisor")
      .periodInMinutes,
    1,
  );
});

test("sidebar acquisition fails closed when background messaging fails", () => {
  return readFile(resolve(repoRoot, "sidebar/sidebar-logic.js"), "utf8").then(
    (source) => {
      const acquireBlock = source.slice(
        source.indexOf("async function acquireCaptureExecutionLock"),
        source.indexOf("function stopCaptureExecutionLockHeartbeat"),
      );
      assert.doesNotMatch(acquireBlock, /degraded\s*:\s*true/);
      assert.match(acquireBlock, /return null;/);
      assert.match(source, /onstarvoice:renew-capture-lock/);
      const lostLockBlock = source.slice(
        source.indexOf("function handleCaptureExecutionLockLost"),
        source.indexOf("async function renewCaptureExecutionLock"),
      );
      assert.match(lostLockBlock, /setCancelFlag\(true\)/);
      assert.match(lostLockBlock, /detailBatchCancelRequested\s*=\s*true/);
      assert.match(
        lostLockBlock,
        /requestCaptureCancelSignal\(relayTabId\)/,
      );
      const runnerResolverBlock = source.slice(
        source.indexOf("function resolveCaptureExecutionLockRunnerTabId"),
        source.indexOf("function handleCaptureExecutionLockLost"),
      );
      assert.ok(
        runnerResolverBlock.indexOf("detailBatchRunnerTabId") <
          runnerResolverBlock.indexOf("activeBatchRunnerTabId"),
      );
    },
  );
});
