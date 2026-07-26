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

test("runtime app version refreshes after an extension update", () => {
  assert.match(
    backgroundSource,
    /const installedAppVersion = getAppVersion\(\)/,
  );
  assert.match(
    backgroundSource,
    /current\.appVersion !== installedAppVersion/,
  );
});

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
  };
}

async function waitFor(assertion, message, {attempts = 50, delayMs = 5} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  assert.fail(message);
}

function createCaptureOwnerPort() {
  return {
    name: "osv.capture.sidebar-owner.v1",
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    postMessage() {},
  };
}

function createHarness() {
  const storage = {};
  const sentTabMessages = [];
  const reloadedTabIds = [];
  const removedTabIds = [];
  const badgeTextHistory = [];
  const createdTabs = [];
  const updatedTabs = [];
  const cloudCommandCompletions = [];
  const cloudHeartbeats = [];
  const alarmDefinitions = new Map();
  const missingTabIds = new Set();
  let uuidCounter = 0;
  let contextMode = "alive";
  let tabMessageHandler = null;
  let tabCreateHandler = null;
  let tabGetHandler = null;
  let tabQueryHandler = null;
  let tabUpdateHandler = null;
  let storageGetHandler = null;
  let reloadHook = null;
  let nextRuntimeSetError = null;
  const unrefSetTimeout = (handler, delay, ...args) => {
    const timer = setTimeout(handler, delay, ...args);
    timer.unref?.();
    return timer;
  };

  const localStorage = {
    async get(keys) {
      let result;
      if (typeof keys === "string") {
        result = Object.hasOwn(storage, keys) ? {[keys]: storage[keys]} : {};
      } else if (Array.isArray(keys)) {
        result = Object.fromEntries(
          keys
            .filter((key) => Object.hasOwn(storage, key))
            .map((key) => [key, storage[key]]),
        );
      } else if (keys && typeof keys === "object") {
        result = Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.hasOwn(storage, key) ? storage[key] : fallback,
          ]),
        );
      } else {
        result = {...storage};
      }
      return typeof storageGetHandler === "function"
        ? await storageGetHandler(keys, result)
        : result;
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
    action: {
      onClicked: createEvent(),
      async setBadgeText({text} = {}) {
        badgeTextHistory.push(String(text ?? ""));
      },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
    },
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
      async query(queryInfo) {
        if (typeof tabQueryHandler === "function") {
          return await tabQueryHandler(queryInfo);
        }
        return [];
      },
      async update(tabId, patch) {
        const tab = {id: tabId, ...patch};
        updatedTabs.push(tab);
        if (typeof tabUpdateHandler === "function") {
          return await tabUpdateHandler(tabId, patch);
        }
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
        removedTabIds.push(Number(tabId));
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
    OnStarvoiceCloudTaskAgent: {
      buildHeartbeatPayload(options = {}) {
        return {
          agent: {clientUuid: options.runtime?.clientUuid || ""},
          tasks: Array.isArray(options.ledger?.runs)
            ? options.ledger.runs.map((run) => ({...run}))
            : [],
          unattendedPlan: options.unattendedPlan || null,
          reason: options.reason || "",
          lastError: options.lastError || "",
        };
      },
      async sendHeartbeat(options = {}) {
        cloudHeartbeats.push(JSON.parse(JSON.stringify(options.body || {})));
        return {ok: true, commands: []};
      },
      async completeCommand(options = {}) {
        cloudCommandCompletions.push({...options});
        return {ok: true, commandId: options.commandId};
      },
    },
  });

  vm.runInContext(taskCenterCoreSource, context, {filename: "utils/task-center.js"});
  for (const {path, source} of phase5RuntimeSources) {
    vm.runInContext(source, context, {filename: path});
  }
  vm.runInContext(
    `${backgroundSource}\n;globalThis.__captureLockTestApi = {\n` +
      `  acquireCaptureExecutionLock,\n` +
      `  bindCaptureExecutionLockToTask,\n` +
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
      `  reconcileUnattendedKeywordPlanSchedule,\n` +
      `  createUnattendedKeywordRunRequest,\n` +
      `  openTargetedPostRunnerTab,\n` +
      `  openUnattendedRunnerTab,\n` +
      `  bindUnattendedRunnerTab,\n` +
      `  saveUnattendedKeywordPlan,\n` +
      `  claimUnattendedKeywordRun,\n` +
      `  updateUnattendedKeywordRun,\n` +
      `  assessUnattendedRunHealth,\n` +
      `  recoverUnattendedKeywordRunRequest,\n` +
      `  manuallyRecoverUnattendedKeywordRun,\n` +
      `  executeCloudTaskAgentCommand,\n` +
      `  syncCloudTaskAgent,\n` +
      `  superviseUnattendedKeywordRun,\n` +
      `  syncUnattendedSupervisorAlarm,\n` +
      `  upsertTaskLedgerRun,\n` +
      `  terminalizeCaptureTaskLedgerRun,\n` +
      `  cleanupStaleCaptureRuntimeSession,\n` +
      `  getCaptureDebugSessionByTaskId: (taskId) => captureDebugSessionManager.getSessionByTaskId(taskId),\n` +
      `  stopCaptureDebugTask: (taskId, reason = "test_detach") => captureDebugSessionManager.stopByTaskId(taskId, reason),\n` +
      `  bindCaptureTaskOwner: (port, taskId) => {\n` +
      `    captureTaskOwnerCoordinator.attachPort(port);\n` +
      `    return captureTaskOwnerCoordinator.bind(port, taskId);\n` +
      `  },\n` +
      `  handleAbandonedCaptureTask,\n` +
      `  handleUnexpectedCaptureDebugDetach,\n` +
      `  handleCaptureRuntimeTabRemoved,\n` +
      `  handleCaptureRuntimeTabReplaced,\n` +
      `  getCaptureTaskGroup: (taskId) => captureTaskTabGroupManager.getTask(taskId),\n` +
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
    cloudCommandCompletions,
    cloudHeartbeats,
    updatedTabs,
    reloadedTabIds,
    removedTabIds,
    badgeTextHistory,
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
    setTabQueryHandler(handler) {
      tabQueryHandler = handler;
    },
    setTabUpdateHandler(handler) {
      tabUpdateHandler = handler;
    },
    setStorageGetHandler(handler) {
      storageGetHandler = handler;
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
const UNATTENDED_ARCHIVE_KEY = "onstarvoice.unattendedKeywordRunArchive";
const TASK_LEDGER_KEY = "onstarvoice.taskLedger";
const SYNC_HISTORY_KEY = "onstarvoice.sync_history";

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

function buildUnattendedRunnerSender(request, holderDocumentId) {
  return {
    documentId: String(holderDocumentId || ""),
    tab: {
      id: Number(request?.runnerTabId),
      url: `chrome-extension://test/sidebar/sidebar.html?unattendedRun=${request.id}`,
    },
  };
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

test("persistent task end clears page markers for xiaohongshu and douyin", async () => {
  for (const [platform, url] of [
    [
      "xiaohongshu",
      "https://www.xiaohongshu.com/search_result?keyword=terminal-cleanup",
    ],
    [
      "douyin",
      "https://www.douyin.com/search/terminal-cleanup?type=general",
    ],
  ]) {
    const harness = createHarness();
    harness.setTabGetHandler(async (tabId) => ({
      id: Number(tabId),
      windowId: 1,
      groupId: -1,
      status: "complete",
      url,
      title: `${platform} capture source`,
    }));
    const taskId = `${platform}-terminal-marker-cleanup`;

    const begun = await harness.sendBackgroundMessage({
      type: "onstarvoice:begin-capture-task",
      taskId,
      sourceTabId: 41,
      platform,
    });
    assert.equal(begun.ok, true, JSON.stringify(begun));

    const ended = await harness.sendBackgroundMessage({
      type: "onstarvoice:end-capture-task",
      taskId,
      reason: "completed",
      status: "completed",
    });
    assert.equal(ended.ok, true, JSON.stringify(ended));
    assert.deepEqual(
      JSON.parse(JSON.stringify(harness.sentTabMessages)),
      [
      {
        tabId: 41,
        payload: {
          action: "setCaptureTaskTakeover",
          taskId,
          active: false,
          clearTrace: true,
          label: "AI 正在接管",
        },
      },
      ],
    );
  }
});

test("runtime restart best-effort clears stale trace overlays on known task tabs", async () => {
  const harness = createHarness();
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    groupId: 7,
    status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=restart-cleanup",
  }));

  await harness.api.cleanupStaleCaptureRuntimeSession({
    taskId: "restart-cleanup-task",
    sourceTabId: 41,
    workerTabIds: [42],
    groupId: 7,
    originalGroupId: -1,
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.sentTabMessages)),
    [41, 42].map((tabId) => ({
      tabId,
      payload: {
        action: "setCaptureTaskTakeover",
        taskId: "restart-cleanup-task",
        active: false,
        clearTrace: true,
        label: "AI 正在接管",
      },
    })),
  );
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

test("matching holder credential can release after Chrome replaces the document context", async () => {
  const harness = createHarness();
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_search_capture",
    holderId: "stable-random-holder",
    holderDocumentId: "sidebar-document-before-reload",
  });

  assert.equal(
    await harness.api.releaseCaptureExecutionLock(acquired.lock.id, {
      holderId: "stable-random-holder",
      holderDocumentId: "sidebar-document-after-reload",
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

test("a newly created unattended runner tab is made non-discardable", async () => {
  const harness = createHarness();

  const runner = await harness.api.openUnattendedRunnerTab("request-create", {
    windowId: 7,
  });

  assert.equal(harness.createdTabs.length, 1);
  assert.equal(harness.createdTabs[0].active, true);
  assert.equal(harness.createdTabs[0].windowId, 7);
  assert.match(harness.createdTabs[0].url, /unattendedRun=request-create/);
  assert.deepEqual(harness.updatedTabs, [
    {id: harness.createdTabs[0].id, autoDiscardable: false},
  ]);
  assert.equal(runner.autoDiscardable, false);
});

test("a targeted post runner never coerces a missing window to id zero", async () => {
  const harness = createHarness();

  const runner = await harness.api.openTargetedPostRunnerTab("targeted-create");

  assert.equal(harness.createdTabs.length, 1);
  assert.equal(
    Object.hasOwn(harness.createdTabs[0], "windowId"),
    false,
  );
  assert.match(harness.createdTabs[0].url, /targetedPostRun=targeted-create/);
  assert.deepEqual(harness.updatedTabs, [
    {id: harness.createdTabs[0].id, autoDiscardable: false},
  ]);
  assert.equal(runner.autoDiscardable, false);
});

test("a targeted post runner keeps a concrete browser window", async () => {
  const harness = createHarness();

  await harness.api.openTargetedPostRunnerTab("targeted-window", {
    windowId: 7,
  });

  assert.equal(harness.createdTabs.length, 1);
  assert.equal(harness.createdTabs[0].windowId, 7);
});

test("a targeted post runner falls back once when its preferred window closed", async () => {
  const harness = createHarness();
  const attempts = [];
  harness.setTabCreateHandler(async (options) => {
    attempts.push({...options});
    if (attempts.length === 1) {
      throw new Error("No window with id: 7.");
    }
    return {id: 103, ...options};
  });

  const runner = await harness.api.openTargetedPostRunnerTab("targeted-stale-window", {
    windowId: 7,
  });

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].windowId, 7);
  assert.equal(Object.hasOwn(attempts[1], "windowId"), false);
  assert.equal(runner.id, 103);
});

test("an unattended runner never coerces a missing window to id zero", async () => {
  const harness = createHarness();

  await harness.api.openUnattendedRunnerTab("unattended-no-window");

  assert.equal(harness.createdTabs.length, 1);
  assert.equal(
    Object.hasOwn(harness.createdTabs[0], "windowId"),
    false,
  );
});

test("an unattended runner falls back once when its preferred window closed", async () => {
  const harness = createHarness();
  const attempts = [];
  harness.setTabCreateHandler(async (options) => {
    attempts.push({...options});
    if (attempts.length === 1) {
      throw new Error("No window with id: 9.");
    }
    return {id: 104, ...options};
  });

  await harness.api.openUnattendedRunnerTab("unattended-stale-window", {
    windowId: 9,
  });

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].windowId, 9);
  assert.equal(Object.hasOwn(attempts[1], "windowId"), false);
});

test("runner tab creation does not retry an unrelated browser error", async () => {
  const harness = createHarness();
  let attempts = 0;
  harness.setTabCreateHandler(async () => {
    attempts += 1;
    throw new Error("Tabs cannot be edited right now.");
  });

  await assert.rejects(
    harness.api.openTargetedPostRunnerTab("targeted-non-window-error", {
      windowId: 7,
    }),
    /Tabs cannot be edited right now/,
  );
  assert.equal(attempts, 1);
});

test("a reused unattended runner tab stays non-discardable", async () => {
  const harness = createHarness();
  harness.setTabQueryHandler(async () => [
    {
      id: 77,
      url: "chrome-extension://test/sidebar/sidebar.html?unattendedRun=old-request",
    },
  ]);

  const runner = await harness.api.openUnattendedRunnerTab("request-reuse");

  assert.equal(harness.createdTabs.length, 0);
  assert.deepEqual(harness.updatedTabs, [
    {
      id: 77,
      url: "chrome-extension://test/sidebar/sidebar.html?unattendedRun=request-reuse",
      active: true,
      autoDiscardable: false,
    },
  ]);
  assert.equal(runner.autoDiscardable, false);
});

test("a cloud create command starts exactly one local task without replacing the saved plan", async () => {
  const harness = createHarness();
  harness.storage["onstarvoice.unattendedKeywordPlan"] = {
    enabled: true,
    platform: "xiaohongshu",
    mode: "daily",
    startTime: "09:00",
    keywords: ["本地计划关键词"],
    updatedAt: "2026-07-21T01:00:00.000Z",
  };
  const command = {
    id: "cloud-command-create-1",
    command_type: "create",
    client_task_id: "cloud-task-local-1",
    platform: "douyin",
    payload: {
      clientTaskId: "cloud-task-local-1",
      planSnapshot: {
        enabled: true,
        platform: "douyin",
        keywords: ["远程关键词", "远程关键词"],
        keywordMaxDetectedItems: 275,
        searchFilters: {sort: "latest", publishTime: "day"},
        autoLoop: false,
        maxRounds: 1,
      },
    },
  };

  const first = await harness.api.executeCloudTaskAgentCommand(
    command,
    "agent-token",
  );
  const request = harness.storage["onstarvoice.unattendedKeywordRunRequest"];
  const savedPlan = harness.storage["onstarvoice.unattendedKeywordPlan"];

  assert.equal(first.ok, true);
  assert.equal(request.id, "cloud-task-local-1");
  assert.equal(request.cloudAssigned, true);
  assert.equal(request.executionMode, "one_time");
  assert.match(request.message, /一次性采集任务/u);
  assert.doesNotMatch(request.message, /无人值守/u);
  assert.equal(request.cloudCommandId, "cloud-command-create-1");
  assert.deepEqual(Array.from(request.planSnapshot.keywords), ["远程关键词"]);
  assert.equal(request.planSnapshot.keywordMaxDetectedItems, 275);
  assert.deepEqual(Array.from(savedPlan.keywords), ["本地计划关键词"]);
  assert.equal(harness.cloudCommandCompletions.length, 1);
  assert.equal(harness.cloudCommandCompletions[0].success, true);
  assert.equal(harness.createdTabs.length, 2);

  await harness.api.executeCloudTaskAgentCommand(command, "agent-token");
  assert.equal(harness.createdTabs.length, 2);
  assert.equal(harness.cloudCommandCompletions.length, 2);
  assert.equal(
    harness.storage["onstarvoice.unattendedKeywordRunRequest"].id,
    "cloud-task-local-1",
  );
});

test("cloud tasks without a valid post limit do not create a device override", async () => {
  for (const [suffix, planPatch] of [
    ["legacy", {}],
    ["zero", {keywordMaxDetectedItems: 0}],
  ]) {
    const harness = createHarness();
    await harness.api.executeCloudTaskAgentCommand(
      {
        id: `cloud-command-limit-${suffix}`,
        command_type: "create",
        client_task_id: `cloud-task-limit-${suffix}`,
        platform: "douyin",
        payload: {
          clientTaskId: `cloud-task-limit-${suffix}`,
          planSnapshot: {
            enabled: true,
            platform: "douyin",
            keywords: ["远程关键词"],
            ...planPatch,
          },
        },
      },
      "agent-token",
    );

    const request = harness.storage[UNATTENDED_REQUEST_KEY];
    assert.equal(
      Object.hasOwn(request.planSnapshot, "keywordMaxDetectedItems"),
      false,
      `${suffix} task must continue with the device-local capture limit`,
    );
  }
});

test("a cloud unattended-plan command saves the schedule without opening a runner", async () => {
  const harness = createHarness();
  const command = {
    id: "cloud-command-plan-1",
    command_type: "create",
    client_task_id: "cloud-plan-config-1",
    platform: "douyin",
    payload: {
      executionMode: "unattended_plan",
      clientTaskId: "cloud-plan-config-1",
      planSnapshot: {
        enabled: true,
        platform: "douyin",
        mode: "custom_dates",
        startTime: "08:30",
        randomOffsetMin: 12,
        customDates: "2099/7/2\n2099-07-02\n2099/2/29",
        keywords: ["远程无人值守计划"],
        keywordMaxDetectedItems: 310,
        searchFilters: {sort: "latest", publishTime: "week"},
        maxRounds: 2,
        roundGapMin: 15,
      },
    },
  };

  const result = await harness.api.executeCloudTaskAgentCommand(
    command,
    "agent-token",
  );

  assert.equal(result.ok, true);
  assert.equal(harness.createdTabs.length, 0);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY], undefined);
  assert.equal(harness.storage[UNATTENDED_PLAN_KEY].enabled, true);
  assert.equal(harness.storage[UNATTENDED_PLAN_KEY].platform, "douyin");
  assert.deepEqual(
    Array.from(harness.storage[UNATTENDED_PLAN_KEY].keywords),
    ["远程无人值守计划"],
  );
  assert.equal(
    harness.storage[UNATTENDED_PLAN_KEY].keywordMaxDetectedItems,
    310,
  );
  assert.equal(
    harness.storage[UNATTENDED_PLAN_KEY].customDates,
    "2099-07-02",
  );
  assert.equal(harness.cloudCommandCompletions[0].success, true);
  assert.equal(
    harness.cloudCommandCompletions[0].result.executionMode,
    "unattended_plan",
  );
  assert.equal(
    harness.cloudCommandCompletions[0].result.requestId,
    "cloud-plan-config-1",
  );
});

test("a cloud unattended-plan delete command clears the local schedule without clearing task history", async () => {
  const harness = createHarness();
  harness.storage[UNATTENDED_PLAN_KEY] = buildUnattendedPlan({
    platform: "douyin",
    keywords: ["待删除计划"],
    nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  harness.storage["onstarvoice.taskLedger"] = {
    version: 1,
    runs: [{id: "historical-run", status: "completed"}],
  };

  const result = await harness.api.executeCloudTaskAgentCommand(
    {
      id: "cloud-command-plan-delete-1",
      command_type: "create",
      client_task_id: "cloud-plan-delete-1",
      platform: "douyin",
      payload: {
        executionMode: "unattended_plan",
        planOperation: "delete",
        clientTaskId: "cloud-plan-delete-1",
        platform: "douyin",
        planSnapshot: {
          configured: false,
          enabled: false,
          platform: "douyin",
          keywords: [],
        },
      },
    },
    "agent-token",
  );

  assert.equal(result.ok, true);
  assert.equal(harness.storage[UNATTENDED_PLAN_KEY], undefined);
  assert.equal(harness.storage["onstarvoice.taskLedger"].runs.length, 1);
  assert.equal(harness.storage["onstarvoice.taskLedger"].runs[0].id, "historical-run");
  assert.equal(harness.createdTabs.length, 0);
  assert.equal(harness.cloudCommandCompletions[0].success, true);
  assert.equal(
    harness.cloudCommandCompletions[0].result.reason,
    "plan_deleted",
  );
  assert.equal(
    harness.cloudCommandCompletions[0].result.requestId,
    "cloud-plan-delete-1",
  );
});

test("a cloud stop command cancels only its exact active request", async () => {
  const harness = createHarness();
  const futureAlarm = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  harness.storage[UNATTENDED_PLAN_KEY] = buildUnattendedPlan({
    nextRunAt: futureAlarm,
    lastRunStatus: "completed",
    lastRunMessage: "保留本地计划结果",
  });
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    id: "cloud-stop-target",
    attemptId: "cloud-stop-attempt",
    attemptNumber: 1,
    status: "running",
    cloudAssigned: true,
    executionMode: "one_time",
    runnerTabId: 77,
    progress: {runnerTabId: 77},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    planSnapshot: buildUnattendedPlan({keywords: ["云端停止目标"]}),
  };
  harness.storage[LOCK_KEY] = {
    id: "cloud-stop-lock",
    owner: "unattended_keyword_plan",
    holderId: "cloud-stop-holder",
    holderTabId: 77,
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };

  await harness.api.executeCloudTaskAgentCommand(
    {
      id: "cloud-command-stop-1",
      command_type: "stop",
      client_task_id: "cloud-stop-target",
      payload: {controlTaskId: "cloud-stop-target"},
    },
    "agent-token",
  );

  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "canceled");
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.equal(harness.storage[UNATTENDED_PLAN_KEY].lastRunMessage, "保留本地计划结果");
  assert.equal(harness.cloudCommandCompletions[0].success, true);
  assert.equal(harness.cloudCommandCompletions[0].result.requestId, "cloud-stop-target");
  assert.ok(
    harness.sentTabMessages.some(
      ({tabId, payload}) => tabId === 77 && payload.action === "cancelCapture",
    ),
  );

  harness.storage[UNATTENDED_REQUEST_KEY] = {
    ...harness.storage[UNATTENDED_REQUEST_KEY],
    id: "newer-task",
    attemptId: "newer-attempt",
    status: "running",
  };
  await harness.api.executeCloudTaskAgentCommand(
    {
      id: "cloud-command-stop-stale",
      command_type: "stop",
      client_task_id: "old-task",
      payload: {controlTaskId: "old-task"},
    },
    "agent-token",
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].id, "newer-task");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "running");
  assert.equal(harness.cloudCommandCompletions[1].success, false);
});

test("a cloud create command waits without overwriting an active unattended task", async () => {
  const harness = createHarness();
  harness.storage["onstarvoice.unattendedKeywordRunRequest"] = {
    id: "active-local-task",
    attemptId: "active-attempt",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    planSnapshot: {
      enabled: true,
      platform: "xiaohongshu",
      keywords: ["正在执行"],
    },
  };

  const result = await harness.api.executeCloudTaskAgentCommand(
    {
      id: "cloud-command-create-busy",
      command_type: "create",
      client_task_id: "cloud-task-waiting",
      payload: {
        clientTaskId: "cloud-task-waiting",
        planSnapshot: {
          platform: "xiaohongshu",
          keywords: ["等待执行"],
        },
      },
    },
    "agent-token",
  );

  assert.equal(result.deferred, true);
  assert.equal(result.reason, "unattended_task_busy");
  assert.equal(
    harness.storage["onstarvoice.unattendedKeywordRunRequest"].id,
    "active-local-task",
  );
  assert.equal(harness.createdTabs.length, 0);
  assert.equal(harness.cloudCommandCompletions.length, 0);
});

test("terminal unattended results release the slot for the next cloud task", async () => {
  for (const status of ["needs_action", "failed", "completed_with_failures"]) {
    const harness = createHarness();
    const now = new Date().toISOString();
    const oldRequestId = `recoverable-${status}`;
    const oldPlan = buildUnattendedPlan({
      keywords: ["已完成关键词", "待重试关键词"],
      enhance: true,
      aiFilter: true,
      includeComments: true,
      commentLimit: 35,
    });
    harness.storage[UNATTENDED_REQUEST_KEY] = {
      schemaVersion: 2,
      id: oldRequestId,
      attemptId: `attempt-${status}`,
      status,
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      planSnapshot: oldPlan,
      checkpoint: {
        round: 1,
        keywordResults: [
          {
            round: 1,
            index: 0,
            keyword: "已完成关键词",
            status: "completed",
          },
          {
            round: 1,
            index: 1,
            keyword: "待重试关键词",
            status: "failed",
          },
        ],
      },
    };
    harness.storage[TASK_LEDGER_KEY] = {
      version: 1,
      runs: [
        {
          id: oldRequestId,
          taskType: "unattended_keyword_capture",
          status,
          createdAt: now,
          updatedAt: now,
          finishedAt: now,
        },
      ],
    };

    const result = await harness.api.executeCloudTaskAgentCommand(
      {
        id: `cloud-command-after-${status}`,
        command_type: "create",
        client_task_id: `cloud-task-after-${status}`,
        payload: {
          clientTaskId: `cloud-task-after-${status}`,
          planSnapshot: {
            platform: "xiaohongshu",
            keywords: ["等待旧任务处理"],
          },
        },
      },
      "agent-token",
    );

    assert.equal(result.ok, true);
    assert.equal(
      harness.storage[UNATTENDED_REQUEST_KEY].id,
      `cloud-task-after-${status}`,
    );
    assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "pending");
    assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].cloudAssigned, true);
    assert.equal(harness.createdTabs.length, 2);
    assert.equal(harness.cloudCommandCompletions.length, 1);
    assert.equal(harness.cloudCommandCompletions[0].success, true);
    assert.equal(
      harness.cloudCommandCompletions[0].result.reason,
      "created",
    );

    const archived =
      harness.storage[UNATTENDED_ARCHIVE_KEY]?.requests?.[oldRequestId];
    assert.equal(archived?.id, oldRequestId);
    assert.equal(archived?.status, status);
    assert.deepEqual(
      Array.from(archived?.planSnapshot?.keywords || []),
      ["已完成关键词", "待重试关键词"],
    );
    assert.equal(archived?.planSnapshot?.enhance, true);
    assert.equal(archived?.planSnapshot?.includeComments, true);
    assert.equal(archived?.checkpoint?.keywordResults?.[1]?.status, "failed");
    assert.deepEqual(
      Array.from(
        harness.storage[TASK_LEDGER_KEY]?.runs || [],
        (run) => run.id,
      ).sort(),
      [oldRequestId, `cloud-task-after-${status}`].sort(),
    );
  }
});

test("an archived failed task remains retryable after a newer task finishes", async () => {
  const harness = createHarness();
  const now = new Date().toISOString();
  const oldRequestId = "archived-failed-task";
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    schemaVersion: 2,
    id: oldRequestId,
    attemptId: "archived-failed-attempt",
    attemptNumber: 1,
    progressSeq: 4,
    status: "completed_with_failures",
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    planSnapshot: buildUnattendedPlan({
      keywords: ["成功词", "失败词"],
      enhance: true,
      aiFilter: true,
      includeComments: true,
      commentLimit: 50,
    }),
    checkpoint: {
      round: 1,
      keywordResults: [
        {round: 1, index: 0, keyword: "成功词", status: "completed"},
        {round: 1, index: 1, keyword: "失败词", status: "failed"},
      ],
    },
  };

  await harness.api.executeCloudTaskAgentCommand(
    {
      id: "cloud-command-newer-task",
      command_type: "create",
      client_task_id: "newer-cloud-task",
      payload: {
        clientTaskId: "newer-cloud-task",
        planSnapshot: {
          platform: "xiaohongshu",
          keywords: ["新任务关键词"],
        },
      },
    },
    "agent-token",
  );
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    ...harness.storage[UNATTENDED_REQUEST_KEY],
    status: "completed",
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const recovered = await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: oldRequestId,
    mode: "failed",
  });

  assert.equal(recovered.accepted, true);
  const recoveryRequest = harness.storage[UNATTENDED_REQUEST_KEY];
  assert.equal(recoveryRequest.parentRequestId, oldRequestId);
  assert.equal(recoveryRequest.status, "pending");
  assert.deepEqual(Array.from(recoveryRequest.planSnapshot.keywords), ["失败词"]);
  assert.equal(recoveryRequest.planSnapshot.enhance, true);
  assert.equal(recoveryRequest.planSnapshot.aiFilter, true);
  assert.equal(recoveryRequest.planSnapshot.includeComments, true);
  assert.equal(recoveryRequest.planSnapshot.commentLimit, 50);
  assert.equal(
    harness.storage[UNATTENDED_ARCHIVE_KEY]?.requests?.[oldRequestId],
    undefined,
  );
  assert.equal(harness.createdTabs.length, 4);
});

test("an archived retry waits while another unattended task is active", async () => {
  const harness = createHarness();
  const now = new Date().toISOString();
  harness.storage[UNATTENDED_ARCHIVE_KEY] = {
    version: 1,
    updatedAt: now,
    requests: {
      "archived-busy-task": {
        schemaVersion: 2,
        id: "archived-busy-task",
        attemptId: "archived-busy-attempt",
        status: "failed",
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
        planSnapshot: buildUnattendedPlan(),
        checkpoint: {failedKeywords: ["关键词二"]},
      },
    },
  };
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    schemaVersion: 2,
    id: "active-new-task",
    attemptId: "active-new-attempt",
    status: "running",
    createdAt: now,
    updatedAt: now,
    planSnapshot: buildUnattendedPlan({keywords: ["正在执行"]}),
  };

  const recovered = await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: "archived-busy-task",
    mode: "failed",
  });

  assert.equal(recovered.accepted, false);
  assert.equal(recovered.reason, "unattended_task_busy");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].id, "active-new-task");
  assert.equal(harness.createdTabs.length, 0);
  assert.equal(
    harness.storage[UNATTENDED_ARCHIVE_KEY].requests["archived-busy-task"].id,
    "archived-busy-task",
  );
});

test("a cloud resume command can recover a task from the local archive", async () => {
  const harness = createHarness();
  const now = new Date().toISOString();
  harness.storage[UNATTENDED_ARCHIVE_KEY] = {
    version: 1,
    updatedAt: now,
    requests: {
      "archived-cloud-resume": {
        schemaVersion: 2,
        id: "archived-cloud-resume",
        attemptId: "archived-cloud-resume-attempt",
        attemptNumber: 1,
        status: "completed_with_failures",
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
        planSnapshot: buildUnattendedPlan({
          keywords: ["成功词", "云端重试词"],
          enhance: true,
          includeComments: true,
        }),
        checkpoint: {
          round: 1,
          keywordResults: [
            {round: 1, index: 0, keyword: "成功词", status: "completed"},
            {round: 1, index: 1, keyword: "云端重试词", status: "failed"},
          ],
        },
      },
    },
  };
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    schemaVersion: 2,
    id: "newer-finished-task",
    attemptId: "newer-finished-attempt",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    planSnapshot: buildUnattendedPlan({keywords: ["新任务"]}),
  };

  const result = await harness.api.executeCloudTaskAgentCommand(
    {
      id: "cloud-command-resume-archive",
      command_type: "resume",
      client_task_id: "archived-cloud-resume",
      payload: {
        controlTaskId: "archived-cloud-resume",
        mode: "failed",
      },
    },
    "agent-token",
  );

  assert.equal(result.ok, true);
  assert.equal(harness.cloudCommandCompletions.length, 1);
  assert.equal(harness.cloudCommandCompletions[0].success, true);
  assert.equal(
    harness.cloudCommandCompletions[0].result.parentRequestId,
    "archived-cloud-resume",
  );
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].parentRequestId,
    "archived-cloud-resume",
  );
  assert.deepEqual(
    Array.from(harness.storage[UNATTENDED_REQUEST_KEY].planSnapshot.keywords),
    ["云端重试词"],
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].planSnapshot.enhance, true);
  assert.equal(harness.createdTabs.length, 2);
});

test("a cloud archive resume stays pending while another task is active", async () => {
  const harness = createHarness();
  const now = new Date().toISOString();
  harness.storage[UNATTENDED_ARCHIVE_KEY] = {
    version: 1,
    updatedAt: now,
    requests: {
      "archived-cloud-busy": {
        schemaVersion: 2,
        id: "archived-cloud-busy",
        attemptId: "archived-cloud-busy-attempt",
        status: "failed",
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
        planSnapshot: buildUnattendedPlan(),
        checkpoint: {failedKeywords: ["关键词二"]},
      },
    },
  };
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    schemaVersion: 2,
    id: "active-cloud-blocker",
    attemptId: "active-cloud-blocker-attempt",
    status: "running",
    createdAt: now,
    updatedAt: now,
    planSnapshot: buildUnattendedPlan({keywords: ["正在执行"]}),
  };

  const result = await harness.api.executeCloudTaskAgentCommand(
    {
      id: "cloud-command-resume-busy-archive",
      command_type: "resume",
      client_task_id: "archived-cloud-busy",
      payload: {
        controlTaskId: "archived-cloud-busy",
        mode: "failed",
      },
    },
    "agent-token",
  );

  assert.equal(result.deferred, true);
  assert.equal(result.reason, "unattended_task_busy");
  assert.equal(harness.cloudCommandCompletions.length, 0);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].id, "active-cloud-blocker");
  assert.equal(harness.createdTabs.length, 0);
});

test("a cloud one-off never consumes or rewrites the recurring local plan schedule", async () => {
  const harness = createHarness();
  const futureAlarm = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  harness.storage[UNATTENDED_PLAN_KEY] = buildUnattendedPlan({
    nextRunAt: futureAlarm,
    lastRunAt: "2026-07-20T01:00:00.000Z",
    lastRunStatus: "completed",
    lastRunMessage: "本地计划已完成",
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    id: "cloud-running-plan-isolation",
    attemptId: "cloud-attempt-plan-isolation",
    status: "running",
    cloudAssigned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    planSnapshot: buildUnattendedPlan({keywords: ["云端关键词"]}),
  };

  await harness.api.reconcileUnattendedKeywordPlanSchedule({launchDue: true});

  const plan = harness.storage[UNATTENDED_PLAN_KEY];
  assert.equal(plan.nextRunAt, futureAlarm);
  assert.equal(plan.lastRunStatus, "completed");
  assert.equal(plan.lastRunMessage, "本地计划已完成");
  assert.equal(
    harness.alarmDefinitions.get("onstarvoice:unattended-keyword-plan").when,
    Date.parse(futureAlarm),
  );
});

test("cloudAssigned survives claim, progress, and terminal mutations", async () => {
  const harness = createHarness();
  harness.storage[UNATTENDED_PLAN_KEY] = buildUnattendedPlan({
    keywords: ["本地计划关键词"],
    lastRunStatus: "completed",
    lastRunMessage: "本地计划结果",
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  await harness.api.executeCloudTaskAgentCommand(
    {
      id: "cloud-command-lifecycle",
      command_type: "create",
      client_task_id: "cloud-task-lifecycle",
      payload: {
        clientTaskId: "cloud-task-lifecycle",
        planSnapshot: {
          platform: "xiaohongshu",
          keywords: ["云端生命周期"],
        },
      },
    },
    "agent-token",
  );
  let request = harness.storage[UNATTENDED_REQUEST_KEY];
  const claim = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: request.runnerTabId,
    senderDocumentId: "cloud-runner-document",
    holderId: "cloud-runner-holder",
  });
  assert.equal(claim.accepted, true);
  assert.equal(claim.data.cloudAssigned, true);

  const running = await harness.api.updateUnattendedKeywordRun({
    requestId: claim.data.id,
    attemptId: claim.data.attemptId,
    patch: {
      status: "running",
      progress: {current: 1, total: 1, keyword: "云端生命周期"},
    },
  });
  assert.equal(running.accepted, true);
  assert.equal(running.data.cloudAssigned, true);

  const completed = await harness.api.updateUnattendedKeywordRun({
    requestId: running.data.id,
    attemptId: running.data.attemptId,
    patch: {
      status: "completed",
      finishedAt: new Date().toISOString(),
      progress: {current: 1, total: 1, keyword: "云端生命周期"},
    },
  });
  assert.equal(completed.accepted, true);
  assert.equal(completed.data.cloudAssigned, true);
  assert.deepEqual(
    Array.from(harness.storage[UNATTENDED_PLAN_KEY].keywords),
    ["本地计划关键词"],
  );
  assert.equal(harness.storage[UNATTENDED_PLAN_KEY].lastRunMessage, "本地计划结果");
});

test("a missing local schedule is durably retried while a cloud one-off owns the slot", async () => {
  const harness = createHarness();
  harness.storage[UNATTENDED_PLAN_KEY] = buildUnattendedPlan({
    nextRunAt: "",
    lastRunAt: "2026-07-20T01:00:00.000Z",
    lastRunStatus: "completed",
    lastRunMessage: "本地计划已完成",
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    id: "cloud-running-missing-alarm",
    attemptId: "cloud-attempt-missing-alarm",
    status: "running",
    cloudAssigned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    planSnapshot: buildUnattendedPlan({keywords: ["云端关键词"]}),
  };
  const before = Date.now();

  await harness.api.reconcileUnattendedKeywordPlanSchedule({launchDue: true});

  const plan = harness.storage[UNATTENDED_PLAN_KEY];
  const scheduledAt = Date.parse(plan.nextRunAt);
  assert.ok(scheduledAt >= before + 4.9 * 60 * 1000);
  assert.ok(scheduledAt <= Date.now() + 5.1 * 60 * 1000);
  assert.equal(plan.lastRunStatus, "completed");
  assert.equal(plan.lastRunMessage, "本地计划已完成");
  assert.equal(
    harness.alarmDefinitions.get("onstarvoice:unattended-keyword-plan").when,
    scheduledAt,
  );
});

test("canceling a cloud one-off leaves the recurring local plan result untouched", async () => {
  const harness = createHarness();
  const futureAlarm = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  harness.storage[UNATTENDED_PLAN_KEY] = buildUnattendedPlan({
    keywords: ["本地计划关键词"],
    nextRunAt: futureAlarm,
    lastRunAt: "2026-07-20T01:00:00.000Z",
    lastRunStatus: "completed",
    lastRunMessage: "本地结果保留",
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    id: "cloud-cancel-plan-isolation",
    attemptId: "cloud-cancel-attempt",
    attemptNumber: 1,
    progressSeq: 1,
    status: "running",
    cloudAssigned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    businessProgressAt: new Date().toISOString(),
    planSnapshot: buildUnattendedPlan({keywords: ["云端关键词"]}),
  };

  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:cancel-unattended-keyword-run",
    requestId: "cloud-cancel-plan-isolation",
    message: "停止云端一次性任务",
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.request.status, "canceled");
  assert.deepEqual(Array.from(response.data.plan.keywords), ["本地计划关键词"]);
  assert.equal(response.data.plan.nextRunAt, futureAlarm);
  assert.equal(response.data.plan.lastRunStatus, "completed");
  assert.equal(response.data.plan.lastRunMessage, "本地结果保留");
});

test("switching capture-agent identity does not mirror the previous tenant's local plan or history", async () => {
  const harness = createHarness();
  harness.storage["onstarvoice.auth"] = {
    captureAgent: {id: "agent-a", token: "token-a"},
  };
  harness.storage[UNATTENDED_PLAN_KEY] = buildUnattendedPlan({
    keywords: ["客户 A 计划"],
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  harness.storage[TASK_LEDGER_KEY] = {
    version: 1,
    runs: [{
      id: "customer-a-task",
      status: "completed",
      createdAt: "2026-07-20T01:00:00.000Z",
      updatedAt: "2026-07-20T01:05:00.000Z",
    }],
  };

  await harness.api.syncCloudTaskAgent({reason: "agent-a", force: true});
  assert.equal(harness.cloudHeartbeats.at(-1).tasks.length, 1);
  assert.equal(harness.cloudHeartbeats.at(-1).unattendedPlan.keywords[0], "客户 A 计划");

  harness.storage["onstarvoice.cloudCommandResults"] = {
    "old-command": {state: "completed"},
  };
  harness.storage["onstarvoice.auth"] = {
    captureAgent: {id: "agent-b", token: "token-b"},
  };
  await harness.api.syncCloudTaskAgent({reason: "agent-b", force: true});

  assert.equal(harness.cloudHeartbeats.at(-1).tasks.length, 0);
  assert.equal(harness.cloudHeartbeats.at(-1).unattendedPlan, null);
  assert.equal(harness.storage["onstarvoice.cloudCommandResults"], undefined);

  const scopeStartedAt = harness.storage["onstarvoice.cloudTaskAgentStatus"].scopeStartedAt;
  const afterScope = new Date(Date.parse(scopeStartedAt) + 1000).toISOString();
  await harness.api.saveUnattendedKeywordPlan(
    buildUnattendedPlan({keywords: ["客户 A 自动改期后的旧计划"]}),
    {recomputeNext: false},
  );
  await harness.api.syncCloudTaskAgent({reason: "agent-b-automatic-plan-update", force: true});
  assert.equal(harness.cloudHeartbeats.at(-1).unattendedPlan, null);

  await harness.api.saveUnattendedKeywordPlan(
    buildUnattendedPlan({
      keywords: ["客户 B 计划"],
      updatedAt: afterScope,
    }),
    {recomputeNext: false, confirmCloudScope: true},
  );
  harness.storage[TASK_LEDGER_KEY] = {
    version: 1,
    runs: [{
      id: "customer-b-task",
      status: "running",
      createdAt: afterScope,
      updatedAt: afterScope,
      metadata: {cloudAgentScopeId: "agent-b"},
    }],
  };
  harness.storage["onstarvoice.auth"] = {
    captureAgent: {id: "agent-b", token: "token-b-rotated"},
  };
  await harness.api.syncCloudTaskAgent({reason: "agent-b-token-rotation", force: true});

  assert.equal(harness.cloudHeartbeats.at(-1).tasks[0].id, "customer-b-task");
  assert.equal(harness.cloudHeartbeats.at(-1).unattendedPlan.keywords[0], "客户 B 计划");
});

test("switching Agent scope cannot revive another tenant's recovery snapshot", async () => {
  const harness = createHarness();
  const now = new Date().toISOString();
  harness.storage["onstarvoice.auth"] = {
    captureAgent: {id: "tenant-agent-a", token: "token-a"},
  };
  harness.storage["onstarvoice.cloudTaskAgentStatus"] = {
    agentId: "tenant-agent-a",
    updatedAt: now,
  };
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    schemaVersion: 2,
    id: "tenant-a-current-failure",
    attemptId: "tenant-a-current-attempt",
    status: "failed",
    cloudAgentScopeId: "tenant-agent-a",
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    planSnapshot: buildUnattendedPlan({keywords: ["客户 A 私有关键词"]}),
    checkpoint: {failedKeywords: ["客户 A 私有关键词"]},
  };
  harness.storage[UNATTENDED_ARCHIVE_KEY] = {
    version: 1,
    agentScopeId: "tenant-agent-a",
    updatedAt: now,
    requests: {
      "tenant-a-archived-failure": {
        schemaVersion: 2,
        id: "tenant-a-archived-failure",
        attemptId: "tenant-a-archived-attempt",
        status: "failed",
        cloudAgentScopeId: "tenant-agent-a",
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
        planSnapshot: buildUnattendedPlan({keywords: ["客户 A 归档关键词"]}),
        checkpoint: {failedKeywords: ["客户 A 归档关键词"]},
      },
    },
  };

  harness.storage["onstarvoice.auth"] = {
    captureAgent: {id: "tenant-agent-b", token: "token-b"},
  };
  await harness.api.syncCloudTaskAgent({reason: "tenant-switch", force: true});
  assert.equal(harness.storage[UNATTENDED_ARCHIVE_KEY], undefined);

  // Simulate an old in-flight archive write landing after the scope clear.
  harness.storage[UNATTENDED_ARCHIVE_KEY] = {
    version: 1,
    agentScopeId: "tenant-agent-a",
    updatedAt: now,
    requests: {
      "tenant-a-late-archive": {
        schemaVersion: 2,
        id: "tenant-a-late-archive",
        attemptId: "tenant-a-late-attempt",
        status: "failed",
        cloudAgentScopeId: "tenant-agent-a",
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
        planSnapshot: buildUnattendedPlan({keywords: ["客户 A 延迟快照"]}),
        checkpoint: {failedKeywords: ["客户 A 延迟快照"]},
      },
    },
  };

  const currentRecovery = await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: "tenant-a-current-failure",
    mode: "failed",
  });
  assert.equal(currentRecovery.accepted, false);
  assert.equal(currentRecovery.reason, "agent_scope_mismatch");

  const archivedRecovery = await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: "tenant-a-late-archive",
    mode: "failed",
  });
  assert.equal(archivedRecovery.accepted, false);
  assert.equal(archivedRecovery.reason, "not_found");

  await harness.api.executeCloudTaskAgentCommand(
    {
      id: "tenant-b-create-command",
      command_type: "create",
      client_task_id: "tenant-b-new-task",
      payload: {
        clientTaskId: "tenant-b-new-task",
        planSnapshot: {
          platform: "xiaohongshu",
          keywords: ["客户 B 关键词"],
        },
      },
    },
    "agent-token-b",
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].id, "tenant-b-new-task");
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].cloudAgentScopeId,
    "tenant-agent-b",
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
    senderDocumentId: "terminal-race-document",
    holderId: "terminal-race-holder",
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

test("manual continuation starts with a fresh automatic recovery budget", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    status: "needs_action",
    recoveryCount: 2,
    recoveryLaunchFailures: 2,
    finishedAt: new Date().toISOString(),
  });

  const result = await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: request.id,
    mode: "remaining",
  });

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.notEqual(harness.storage[UNATTENDED_REQUEST_KEY].id, request.id);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 0);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryLaunchFailures,
    0,
  );
});

test("human-confirmed continuation reopens only the blocked keyword without replaying completed work", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    status: "needs_action",
    finishedAt: new Date().toISOString(),
    checkpoint: {
      schemaVersion: 1,
      round: 1,
      activeKeywordIndex: 1,
      activeKeyword: "关键词二",
      activePhase: "failed",
      keywordResults: [
        {
          round: 1,
          index: 0,
          keyword: "关键词一",
          status: "completed",
          attemptCount: 1,
          savedCount: 8,
        },
        {
          round: 1,
          index: 1,
          keyword: "关键词二",
          status: "failed",
          attemptCount: 3,
          savedCount: 4,
          errorCode: "DOUYIN_SEARCH_SECURITY_CHALLENGE",
          errorCategory: "platform_safety_block",
          securityBlocked: true,
          requiresManualAction: true,
          error: "请人工完成验证",
        },
      ],
    },
    progress: {
      current: 2,
      total: 3,
      keyword: "关键词二",
    },
  });

  const result = await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: request.id,
    mode: "remaining",
  });

  assert.equal(result.accepted, true, JSON.stringify(result));
  const nextCheckpoint =
    harness.storage[UNATTENDED_REQUEST_KEY].checkpoint;
  assert.equal(nextCheckpoint.keywordResults[0].status, "completed");
  assert.equal(nextCheckpoint.keywordResults[0].savedCount, 8);
  assert.equal(nextCheckpoint.keywordResults[1].status, "retrying");
  assert.equal(nextCheckpoint.keywordResults[1].attemptCount, 0);
  assert.equal(nextCheckpoint.keywordResults[1].savedCount, 4);
  assert.equal(
    Object.hasOwn(nextCheckpoint.keywordResults[1], "securityBlocked"),
    false,
  );
  assert.equal(
    Object.hasOwn(nextCheckpoint.keywordResults[1], "requiresManualAction"),
    false,
  );
  assert.equal(nextCheckpoint.activePhase, "pending");
});

test("progress refreshes the business clock but only a durable milestone resets recovery budgets", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    recoveryCount: 2,
    recoveryLaunchFailures: 1,
    progressSeq: 8,
  });
  const duplicateProgress = {
    ...request.progress,
    updatedAt: new Date().toISOString(),
  };

  const heartbeat = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {heartbeatAt: new Date().toISOString()},
  });
  const duplicate = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      progressSeq: request.progressSeq + 1,
      progress: duplicateProgress,
    },
  });

  assert.equal(heartbeat.accepted, true);
  assert.equal(duplicate.accepted, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 2);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryLaunchFailures,
    1,
  );

  const advanced = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      progressSeq: harness.storage[UNATTENDED_REQUEST_KEY].progressSeq + 1,
      progress: {
        ...duplicateProgress,
        current: Number(duplicateProgress.current || 0) + 1,
        message: "已进入下一条作品",
      },
    },
  });

  assert.equal(advanced.accepted, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 2);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryLaunchFailures,
    1,
  );

  const milestone = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      checkpoint: {
        ...request.checkpoint,
        completedKeywords: ["关键词一"],
      },
    },
  });

  assert.equal(milestone.accepted, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 0);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryLaunchFailures,
    0,
  );
});

test("a repeated checkpoint does not reset recovery but an advanced checkpoint does", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    recoveryCount: 2,
    recoveryLaunchFailures: 1,
  });
  const duplicateCheckpoint = {
    ...request.checkpoint,
    updatedAt: new Date().toISOString(),
  };

  const duplicate = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {checkpoint: duplicateCheckpoint},
  });
  assert.equal(duplicate.accepted, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 2);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryLaunchFailures,
    1,
  );

  const advanced = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      checkpoint: {
        ...duplicateCheckpoint,
        keywordIndex: Number(duplicateCheckpoint.keywordIndex || 0) + 1,
        completedKeywords: ["关键词一"],
      },
    },
  });
  assert.equal(advanced.accepted, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 0);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryLaunchFailures,
    0,
  );
});

test("repeated old progress cannot replenish more than two automatic recoveries", async () => {
  const harness = createHarness();
  let request = seedUnattendedRequest(harness);

  const first = await harness.api.recoverUnattendedKeywordRunRequest(request, {
    healthy: false,
    reason: "runner_heartbeat_stale",
  });
  assert.equal(first.recovered, true, JSON.stringify(first));
  request = harness.storage[UNATTENDED_REQUEST_KEY];
  assert.equal(request.recoveryCount, 1);

  const duplicate = await harness.api.updateUnattendedKeywordRun({
    requestId: request.id,
    attemptId: request.attemptId,
    patch: {
      progressSeq: request.progressSeq + 1,
      progress: {...request.progress, updatedAt: new Date().toISOString()},
    },
  });
  assert.equal(duplicate.accepted, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 1);

  request = harness.storage[UNATTENDED_REQUEST_KEY];
  const second = await harness.api.recoverUnattendedKeywordRunRequest(request, {
    healthy: false,
    reason: "runner_heartbeat_stale",
  });
  assert.equal(second.recovered, true, JSON.stringify(second));
  request = harness.storage[UNATTENDED_REQUEST_KEY];
  assert.equal(request.recoveryCount, 2);

  const exhausted = await harness.api.recoverUnattendedKeywordRunRequest(
    request,
    {healthy: false, reason: "runner_heartbeat_stale"},
  );
  assert.equal(exhausted.terminal, true, JSON.stringify(exhausted));
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "needs_action");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 2);
});

test("a legacy service-abnormal checkpoint no longer blocks recovery", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    checkpoint: {
      keywordIndex: 0,
      currentKeyword: "关键词一",
      completedKeywords: [],
      failedKeywords: ["关键词一"],
      skippedKeywords: [],
      keywordResults: [
        {
          keyword: "关键词一",
          status: "failed",
          error: "检测到抖音“服务出现异常”",
          errorCode: "DOUYIN_SEARCH_SERVICE_ABNORMAL",
          errorCategory: "platform_service_abnormal",
          securityBlocked: true,
          requiresManualAction: true,
        },
      ],
    },
  });

  const recovery = await harness.api.recoverUnattendedKeywordRunRequest(
    request,
    {healthy: false, reason: "runner_heartbeat_stale"},
  );
  const stored = harness.storage[UNATTENDED_REQUEST_KEY];

  assert.equal(recovery.recovered, true, JSON.stringify(recovery));
  assert.notEqual(stored.attemptId, request.attemptId);
  assert.equal(stored.recoveryCount, 1);
  assert.equal(harness.createdTabs.length, 2);
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
    senderDocumentId: "assigned-runner-document",
    holderId: "assigned-runner-holder",
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

test("a frozen runner is woken without rebuilding the current keyword attempt", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {runnerTabId: 42});
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    active: Number(tabId) === 88,
    status: "complete",
    frozen: Number(tabId) === 42,
    discarded: false,
    url: "chrome-extension://test/sidebar/sidebar.html",
  }));
  harness.setTabQueryHandler(async (queryInfo) =>
    queryInfo?.active && Number(queryInfo?.windowId) === 1
      ? [{id: 88, windowId: 1, active: true}]
      : [],
  );

  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(result.healthy, true, JSON.stringify(result));
  assert.equal(result.reason, "runner_tab_woken");
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].attemptId,
    request.attemptId,
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 0);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].wakeReason,
    "runner_tab_frozen",
  );
  assert.deepEqual(harness.updatedTabs, [
    {id: 42, active: true, autoDiscardable: false},
    {id: 88, active: true},
  ]);
});

test("the tab-state event wakes a frozen background runner without a new attempt", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {runnerTabId: 42});
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    active: false,
    status: "complete",
    frozen: Number(tabId) === 42,
    discarded: false,
    url: "chrome-extension://test/sidebar/sidebar.html",
  }));

  for (const listener of harness.chrome.tabs.onUpdated.listeners) {
    listener(42, {frozen: true}, {id: 42, active: false, frozen: true});
  }
  await waitFor(
    () =>
      harness.storage[UNATTENDED_REQUEST_KEY]?.wakeReason ===
      "runner_tab_frozen",
    "frozen runner event should wake the existing runner",
  );

  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].attemptId,
    request.attemptId,
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].recoveryCount, 0);
  assert.ok(
    harness.updatedTabs.some(
      (tab) => tab.id === 42 && tab.active === true,
    ),
  );
});

test("a frozen runner falls back to bounded recovery when it cannot be woken", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {runnerTabId: 42});
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    active: false,
    status: "complete",
    frozen: Number(tabId) === 42,
    discarded: false,
    url: "chrome-extension://test/sidebar/sidebar.html",
  }));
  harness.setTabUpdateHandler(async (tabId, patch) => {
    if (Number(tabId) === 42 && patch?.active === true) {
      throw new Error("tab activation failed");
    }
    return {id: Number(tabId), ...patch};
  });

  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(result.recovered, true, JSON.stringify(result));
  assert.notEqual(
    harness.storage[UNATTENDED_REQUEST_KEY].attemptId,
    request.attemptId,
  );
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryReason,
    "runner_tab_wake_failed",
  );
});

test("a discarded runner is recovered without waiting for heartbeat expiry", async () => {
  const harness = createHarness();
  seedUnattendedRequest(harness, {runnerTabId: 42});
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    status: "unloaded",
    frozen: false,
    discarded: Number(tabId) === 42,
    url: "chrome-extension://test/sidebar/sidebar.html",
  }));

  const result = await harness.api.superviseUnattendedKeywordRun();

  assert.equal(result.recovered, true, JSON.stringify(result));
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].recoveryReason,
    "runner_tab_discarded",
  );
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

test("keep-results resolves needs-action and dismisses finished recovery", async () => {
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
  assert.equal(kept.reason, "results_kept");
  assert.equal(finishedHarness.storage[UNATTENDED_REQUEST_KEY].status, "failed");
  assert.equal(
    Boolean(
      finishedHarness.storage[UNATTENDED_REQUEST_KEY].recoveryDismissedAt,
    ),
    true,
  );
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

test("abnormal Debug shutdown immediately terminalizes the task ledger", async () => {
  const harness = createHarness();
  await harness.api.upsertTaskLedgerRun({
    run: {
      id: "debug-task-abandoned-1",
      taskType: "capture",
      featureKey: "capture.search",
      title: "搜索页采集",
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });

  const result = await harness.api.terminalizeCaptureTaskLedgerRun(
    "debug-task-abandoned-1",
    {
      reason: "source_tab_removed",
      message: "采集来源页面已关闭，任务已停止",
    },
  );
  const run = harness.storage[TASK_LEDGER_KEY].runs.find(
    (item) => item.id === "debug-task-abandoned-1",
  );

  assert.equal(result.accepted, true);
  assert.equal(run.status, "canceled");
  assert.equal(Boolean(run.finishedAt), true);
  assert.equal(run.error.code, "source_tab_removed");
});

test("normal persistent task end directly terminalizes its task-center run", async () => {
  const harness = createHarness();
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    groupId: -1,
    status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=terminal-ledger",
  }));
  await harness.api.upsertTaskLedgerRun({
    run: {
      id: "normal-terminal-task",
      taskType: "capture",
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "normal-terminal-task",
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);

  const ended = await harness.sendBackgroundMessage({
    type: "onstarvoice:end-capture-task",
    taskId: "normal-terminal-task",
    reason: "completed",
    status: "completed",
  });
  const run = harness.storage[TASK_LEDGER_KEY].runs.find(
    (item) => item.id === "normal-terminal-task",
  );
  assert.equal(ended.ok, true);
  assert.equal(run.status, "completed");
  assert.equal(Boolean(run.finishedAt), true);
  assert.equal(run.error, null);
});

test("unexpected native Debug detach clears badge and group before the next task starts", async () => {
  const harness = createHarness();
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    groupId: -1,
    status: "complete",
    title: "抖音搜索",
    url: "https://www.douyin.com/search/debug-detach?type=general",
  }));
  const oldTaskId = "douyin-native-debug-canceled";
  await harness.api.upsertTaskLedgerRun({
    run: {
      id: oldTaskId,
      taskType: "capture",
      platform: "douyin",
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: oldTaskId,
    sourceTabId: 41,
    platform: "douyin",
  });
  assert.equal(begun.ok, true);
  assert.equal(harness.badgeTextHistory.at(-1), "1");

  const detachListener = harness.chrome.debugger.onDetach.listeners[0];
  assert.equal(typeof detachListener, "function");
  detachListener({tabId: 41}, "canceled_by_user");
  await waitFor(
    () => {
      const terminalRun = harness.storage[TASK_LEDGER_KEY]?.runs?.find(
        (item) => item.id === oldTaskId,
      );
      return (
        terminalRun?.status === "canceled" &&
        harness.badgeTextHistory.at(-1) === "" &&
        harness.api.getCaptureDebugSessionByTaskId(oldTaskId) === null &&
        harness.api.getCaptureTaskGroup(oldTaskId) === null
      );
    },
    "unexpected Debug detach cleanup did not reach a terminal state",
  );
  const run = harness.storage[TASK_LEDGER_KEY].runs.find(
    (item) => item.id === oldTaskId,
  );

  assert.equal(run.status, "canceled");
  assert.equal(run.error.code, "native_debug_canceled");
  assert.equal(harness.badgeTextHistory.at(-1), "");
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(oldTaskId), null);
  assert.equal(harness.api.getCaptureTaskGroup(oldTaskId), null);
  assert.equal(
    harness.storage["onstarvoice.runtime"].captureDebugSession,
    null,
  );

  const replacement = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "douyin-after-native-debug-canceled",
    sourceTabId: 41,
    platform: "douyin",
  });
  assert.equal(replacement.ok, true, JSON.stringify(replacement));
});

test("a confirmed stale native capture group is released before a new task begins", async () => {
  const harness = createHarness();
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    groupId: -1,
    status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=stale-group",
  }));

  const oldTaskId = "stale-group-old-task";
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: oldTaskId,
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);
  const registered = await harness.sendBackgroundMessage({
    type: "onstarvoice:register-capture-task-tab",
    taskId: oldTaskId,
    workerTabId: 42,
    role: "detail_worker",
  });
  assert.equal(registered.ok, true);

  await harness.api.stopCaptureDebugTask(oldTaskId);
  await harness.api.terminalizeCaptureTaskLedgerRun(oldTaskId, {
    reason: "native_debug_canceled",
    status: "canceled",
    message: "浏览器 Debug 接管已取消",
  });
  const newLock = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_batch_keyword_capture",
    holderId: "new-holder",
    holderDocumentId: "new-document",
    holderTabId: 41,
  });
  assert.equal(newLock.ok, true);

  const replacement = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "stale-group-new-task",
    sourceTabId: 41,
    platform: "xiaohongshu",
  });

  assert.equal(replacement.ok, true, JSON.stringify(replacement));
  assert.equal(harness.api.getCaptureTaskGroup(oldTaskId), null);
  assert.equal(
    harness.api.getCaptureTaskGroup("stale-group-new-task")?.sourceTabId,
    41,
  );
  assert.deepEqual(harness.removedTabIds, [42]);
  assert.equal(
    harness.storage[LOCK_KEY].captureTaskId,
    "stale-group-new-task",
  );
});

test("stale-group recovery never removes a task with a live Debug session", async () => {
  const harness = createHarness();
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "live-debug-task",
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);

  const blocked = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "live-debug-contender",
    sourceTabId: 44,
    platform: "xiaohongshu",
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "capture_task_group_busy");
  assert.equal(harness.api.getCaptureTaskGroup("live-debug-task")?.sourceTabId, 41);
});

test("stale-group recovery never removes a task with a connected owner", async () => {
  const harness = createHarness();
  const oldTaskId = "live-owner-task";
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: oldTaskId,
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);
  const ownerPort = createCaptureOwnerPort();
  assert.equal(
    harness.api.bindCaptureTaskOwner(ownerPort, oldTaskId).bound,
    true,
  );
  await harness.api.stopCaptureDebugTask(oldTaskId);

  const blocked = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "live-owner-contender",
    sourceTabId: 44,
    platform: "xiaohongshu",
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "capture_task_group_busy");
  assert.equal(harness.api.getCaptureTaskGroup(oldTaskId)?.sourceTabId, 41);
});

test("a terminal tombstone lets recovery clear a stranded connected owner", async () => {
  const harness = createHarness();
  const oldTaskId = "terminal-owner-residue";
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: oldTaskId,
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);
  const ownerPort = createCaptureOwnerPort();
  assert.equal(
    harness.api.bindCaptureTaskOwner(ownerPort, oldTaskId).bound,
    true,
  );
  await harness.api.stopCaptureDebugTask(oldTaskId);
  await harness.api.terminalizeCaptureTaskLedgerRun(oldTaskId, {
    status: "canceled",
    reason: "native_debug_canceled",
  });

  const replacement = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "terminal-owner-replacement",
    sourceTabId: 44,
    platform: "xiaohongshu",
  });

  assert.equal(replacement.ok, true, JSON.stringify(replacement));
  assert.equal(harness.api.getCaptureTaskGroup(oldTaskId), null);
  assert.equal(
    harness.api.getCaptureTaskGroup("terminal-owner-replacement")?.sourceTabId,
    44,
  );
});

test("stale-group recovery never removes a task with its live execution lock", async () => {
  const harness = createHarness();
  const oldTaskId = "live-lock-task";
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_batch_keyword_capture",
    holderId: "old-holder",
    holderDocumentId: "old-document",
    holderTabId: 41,
  });
  assert.equal(acquired.ok, true);
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: oldTaskId,
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);
  assert.equal(harness.storage[LOCK_KEY].captureTaskId, oldTaskId);
  await harness.api.stopCaptureDebugTask(oldTaskId);
  await harness.api.terminalizeCaptureTaskLedgerRun(oldTaskId, {
    status: "canceled",
    reason: "debugger_detached",
  });

  const blocked = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "live-lock-contender",
    sourceTabId: 44,
    platform: "xiaohongshu",
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "capture_task_group_busy");
  assert.equal(harness.api.getCaptureTaskGroup(oldTaskId)?.sourceTabId, 41);
});

test("stale-group recovery never removes a task with recent active ledger progress", async () => {
  const harness = createHarness();
  const oldTaskId = "live-ledger-task";
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: oldTaskId,
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);
  await harness.api.stopCaptureDebugTask(oldTaskId);
  await harness.api.upsertTaskLedgerRun({
    run: {
      id: oldTaskId,
      taskType: "capture",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });

  const blocked = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "live-ledger-contender",
    sourceTabId: 44,
    platform: "xiaohongshu",
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "capture_task_group_busy");
  assert.equal(harness.api.getCaptureTaskGroup(oldTaskId)?.sourceTabId, 41);
});

test("tabs.onReplaced migrates a persistent capture source instead of canceling it", async () => {
  const harness = createHarness();
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    groupId: 1,
    status: "complete",
    title: "抖音搜索",
    url: "https://www.douyin.com/search/tab-replaced?type=general",
  }));
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "douyin-tab-replaced-task",
    sourceTabId: 41,
    platform: "douyin",
  });
  assert.equal(begun.ok, true);

  const migrated = await harness.api.handleCaptureRuntimeTabReplaced(44, 41);
  const runtime = harness.storage["onstarvoice.runtime"];
  const group = harness.api.getCaptureTaskGroup("douyin-tab-replaced-task");

  assert.equal(migrated, true);
  assert.equal(runtime.captureDebugSession.taskId, "douyin-tab-replaced-task");
  assert.equal(runtime.captureDebugSession.tabId, 44);
  assert.equal(runtime.captureDebugSession.state, "attached");
  assert.equal(runtime.captureTaskCancellation, null);
  assert.equal(group.sourceTabId, 44);
  assert.equal(
    harness.sentTabMessages.some(
      ({payload}) => payload?.action === "cancelCapture",
    ),
    false,
  );
});

test("unattended recovery releases the previous child Debug group before relaunching from checkpoint", async () => {
  const harness = createHarness();
  const keywords = Array.from({length: 13}, (_, index) => `关键词${index + 1}`);
  const request = seedUnattendedRequest(harness, {
    planSnapshot: {keywords},
    checkpoint: {
      schemaVersion: 1,
      round: 1,
      activeKeywordIndex: 1,
      activeKeyword: "关键词2",
      keywordResults: [
        {
          round: 1,
          index: 0,
          keyword: "关键词1",
          status: "completed",
        },
      ],
    },
  });
  const lock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "runner-holder-1",
    holderDocumentId: "runner-document-1",
    holderTabId: 41,
  });
  assert.equal(lock.ok, true);
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "unattended-child-attempt-1",
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);
  assert.equal(
    harness.storage[LOCK_KEY].captureTaskId,
    "unattended-child-attempt-1",
  );

  const recovery = await harness.api.recoverUnattendedKeywordRunRequest(
    request,
    {healthy: false, reason: "runner_heartbeat_stale"},
  );

  assert.equal(recovery.recovered, true, JSON.stringify(recovery));
  assert.equal(
    harness.api.getCaptureTaskGroup("unattended-child-attempt-1"),
    null,
  );
  assert.equal(
    harness.api.getCaptureDebugSessionByTaskId("unattended-child-attempt-1"),
    null,
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].attemptNumber, 2);
  assert.deepEqual(
    harness.storage[UNATTENDED_REQUEST_KEY].checkpoint.keywordResults,
    request.checkpoint.keywordResults,
  );
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].planSnapshot.keywords.length,
    13,
  );
});

test("an unattended sidebar owner disconnect recovers the parent request instead of canceling it", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    planSnapshot: {
      keywords: Array.from({length: 13}, (_, index) => `计划词${index + 1}`),
    },
    checkpoint: {
      schemaVersion: 1,
      round: 1,
      activeKeywordIndex: 1,
      activeKeyword: "计划词2",
      keywordResults: [
        {
          round: 1,
          index: 0,
          keyword: "计划词1",
          status: "completed",
        },
      ],
    },
  });
  const lock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "runner-holder-disconnected",
    holderDocumentId: "runner-document-disconnected",
    holderTabId: 41,
  });
  assert.equal(lock.ok, true);
  const begun = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "unattended-child-owner-disconnected",
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(begun.ok, true);

  await harness.api.handleAbandonedCaptureTask({
    taskId: "unattended-child-owner-disconnected",
  });

  const recoveredRequest = harness.storage[UNATTENDED_REQUEST_KEY];
  assert.equal(recoveredRequest.attemptNumber, 2);
  assert.notEqual(recoveredRequest.status, "failed");
  assert.notEqual(recoveredRequest.status, "canceled");
  assert.equal(recoveredRequest.error, null);
  assert.deepEqual(
    recoveredRequest.checkpoint.keywordResults,
    request.checkpoint.keywordResults,
  );
  assert.equal(
    harness.api.getCaptureTaskGroup("unattended-child-owner-disconnected"),
    null,
  );
  assert.equal(
    harness.storage["onstarvoice.runtime"]?.captureTaskCancellation?.reason ===
      "sidebar_owner_disconnected",
    false,
  );
});

test("a late Debug detach only cleans a terminal unattended wrapper and never creates a public ledger run", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness);
  const stableTaskId = `unattended-capture:${request.id}`;
  const lock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "terminal-detach-holder",
    holderDocumentId: "terminal-detach-document",
    holderTabId: 41,
  });
  assert.equal(lock.ok, true);
  const begun = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(request, lock.lock.holderDocumentId),
  );
  assert.equal(begun.ok, true, JSON.stringify(begun));
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    ...harness.storage[UNATTENDED_REQUEST_KEY],
    status: "completed",
    finishedAt: new Date().toISOString(),
  };
  harness.storage[TASK_LEDGER_KEY] = {
    version: 1,
    runs: [{id: request.id, status: "completed"}],
  };

  await harness.api.handleUnexpectedCaptureDebugDetach({
    session: harness.api.getCaptureDebugSessionByTaskId(stableTaskId),
    reason: "target_closed",
  });

  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.deepEqual(
    Array.from(harness.storage[TASK_LEDGER_KEY].runs, (run) => run.id),
    [request.id],
  );
  assert.equal(harness.storage[TASK_LEDGER_KEY].runs[0].status, "completed");
});

test("a late owner disconnect only cleans a terminal unattended wrapper and preserves the root ledger", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness);
  const stableTaskId = `unattended-capture:${request.id}`;
  const lock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "terminal-owner-holder",
    holderDocumentId: "terminal-owner-document",
    holderTabId: 41,
  });
  assert.equal(lock.ok, true);
  const begun = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(request, lock.lock.holderDocumentId),
  );
  assert.equal(begun.ok, true, JSON.stringify(begun));
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    ...harness.storage[UNATTENDED_REQUEST_KEY],
    status: "completed",
    finishedAt: new Date().toISOString(),
  };
  harness.storage[TASK_LEDGER_KEY] = {
    version: 1,
    runs: [{id: request.id, status: "completed"}],
  };

  await harness.api.handleAbandonedCaptureTask({taskId: stableTaskId});

  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.deepEqual(
    Array.from(harness.storage[TASK_LEDGER_KEY].runs, (run) => run.id),
    [request.id],
  );
  assert.equal(harness.storage[TASK_LEDGER_KEY].runs[0].status, "completed");
});

test("closing an active unattended source tab recovers the root request without creating a wrapper ledger", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    planSnapshot: {
      keywords: Array.from({length: 4}, (_, index) => `来源页恢复词${index + 1}`),
    },
  });
  const stableTaskId = `unattended-capture:${request.id}`;
  const lock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "source-removed-holder",
    holderDocumentId: "source-removed-document",
    holderTabId: 41,
  });
  assert.equal(lock.ok, true);
  const begun = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(request, lock.lock.holderDocumentId),
  );
  assert.equal(begun.ok, true, JSON.stringify(begun));

  await harness.api.handleCaptureRuntimeTabRemoved(41);

  const recoveredRequest = harness.storage[UNATTENDED_REQUEST_KEY];
  assert.equal(recoveredRequest.attemptNumber, 2);
  assert.equal(recoveredRequest.status, "pending");
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.equal(
    Boolean(
      harness.storage[TASK_LEDGER_KEY]?.runs?.some(
        (run) => run.id === stableTaskId,
      ),
    ),
    false,
  );
});

test("a replacement runner reclaims its own stale unattended child instead of reporting group busy", async () => {
  const harness = createHarness();
  seedUnattendedRequest(harness, {
    planSnapshot: {
      keywords: Array.from({length: 13}, (_, index) => `恢复词${index + 1}`),
    },
  });
  const lock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "runner-holder-replacement",
    holderDocumentId: "runner-document-replacement",
    holderTabId: 41,
  });
  assert.equal(lock.ok, true);
  const oldBegin = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: "unattended-child-before-runner-replacement",
    sourceTabId: 41,
    platform: "xiaohongshu",
  });
  assert.equal(oldBegin.ok, true);

  const replacement = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: "unattended-child-after-runner-replacement",
      sourceTabId: 44,
      platform: "xiaohongshu",
    },
    {
      documentId: "runner-document-replacement",
      tab: {
        id: 42,
        url: "chrome-extension://test/sidebar/sidebar.html?unattendedRun=unattended-run-1",
      },
    },
  );

  assert.equal(replacement.ok, true, JSON.stringify(replacement));
  assert.equal(
    harness.api.getCaptureTaskGroup("unattended-child-before-runner-replacement"),
    null,
  );
  assert.equal(
    harness.api.getCaptureTaskGroup("unattended-child-after-runner-replacement")
      ?.sourceTabId,
    44,
  );
  assert.equal(
    harness.storage[LOCK_KEY].captureTaskId,
    "unattended-child-after-runner-replacement",
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "running");
});

test("a replacement Douyin runner releases stable Debug resources even after the lock binding was cleared", async () => {
  const harness = createHarness();
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    groupId: -1,
    status: "complete",
    url: "https://www.douyin.com/search/unattended-rebind?type=general",
    title: "douyin capture source",
  }));
  const request = seedUnattendedRequest(harness);
  const stableTaskId = `unattended-capture:${request.id}`;
  const lock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "runner-holder-residual-debug",
    holderDocumentId: "runner-document-residual-debug",
    holderTabId: 41,
  });
  assert.equal(lock.ok, true);

  const firstBegin = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "douyin",
    },
    buildUnattendedRunnerSender(request, lock.lock.holderDocumentId),
  );
  assert.equal(firstBegin.ok, true, JSON.stringify(firstBegin));

  // This is the real recovery race from the Windows diagnostic: the persisted
  // binding was already cleared while the stable Debug/group resources still
  // belonged to the old source tab.
  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    captureTaskId: "",
    captureTaskAttemptId: "",
  };

  const replacement = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 44,
      platform: "douyin",
    },
    {
      documentId: "runner-document-residual-debug",
      tab: {
        id: 42,
        url: `chrome-extension://test/sidebar/sidebar.html?unattendedRun=${request.id}`,
      },
    },
  );

  assert.equal(replacement.ok, true, JSON.stringify(replacement));
  assert.equal(
    harness.api.getCaptureDebugSessionByTaskId(stableTaskId)?.tabId,
    44,
  );
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId, 44);
  assert.equal(harness.storage[LOCK_KEY].captureTaskId, stableTaskId);
});

test("a replacement Douyin runner clears a residual group instead of reporting cleanup pending", async () => {
  const harness = createHarness();
  harness.setTabGetHandler(async (tabId) => ({
    id: Number(tabId),
    windowId: 1,
    groupId: -1,
    status: "complete",
    url: "https://www.douyin.com/search/unattended-cleanup?type=general",
    title: "douyin capture source",
  }));
  const request = seedUnattendedRequest(harness);
  const stableTaskId = `unattended-capture:${request.id}`;
  const lock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "runner-holder-residual-group",
    holderDocumentId: "runner-document-residual-group",
    holderTabId: 41,
  });
  assert.equal(lock.ok, true);
  const firstBegin = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "douyin",
    },
    buildUnattendedRunnerSender(request, lock.lock.holderDocumentId),
  );
  assert.equal(firstBegin.ok, true, JSON.stringify(firstBegin));

  await harness.api.stopCaptureDebugTask(stableTaskId, "simulate_cleanup_race");
  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    captureTaskId: "",
    captureTaskAttemptId: "",
  };

  const replacement = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 44,
      platform: "douyin",
    },
    {
      documentId: "runner-document-residual-group",
      tab: {
        id: 42,
        url: `chrome-extension://test/sidebar/sidebar.html?unattendedRun=${request.id}`,
      },
    },
  );

  assert.equal(replacement.ok, true, JSON.stringify(replacement));
  assert.equal(
    harness.api.getCaptureDebugSessionByTaskId(stableTaskId)?.tabId,
    44,
  );
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId, 44);
  assert.equal(harness.storage[LOCK_KEY].captureTaskId, stableTaskId);
});

test("a late END from the recovered unattended attempt cannot stop the replacement Debug task", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    planSnapshot: {
      keywords: Array.from({length: 13}, (_, index) => `竞态词${index + 1}`),
    },
  });
  const stableTaskId = `unattended-capture:${request.id}`;
  const firstLock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "late-end-holder-1",
    holderDocumentId: "late-end-document-1",
    holderTabId: 41,
  });
  assert.equal(firstLock.ok, true);
  const firstBegin = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(
      request,
      firstLock.lock.holderDocumentId,
    ),
  );
  assert.equal(firstBegin.ok, true, JSON.stringify(firstBegin));

  const recovery = await harness.api.recoverUnattendedKeywordRunRequest(
    request,
    {healthy: false, reason: "runner_heartbeat_stale"},
  );
  assert.equal(recovery.recovered, true, JSON.stringify(recovery));
  const replacementRequest = harness.storage[UNATTENDED_REQUEST_KEY];
  assert.notEqual(replacementRequest.attemptId, request.attemptId);

  const replacementLock = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "late-end-holder-2",
    holderDocumentId: "late-end-document-2",
    holderTabId: 44,
  });
  assert.equal(replacementLock.ok, true);
  const replacementBegin = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: replacementRequest.attemptId,
      sourceTabId: 44,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(
      replacementRequest,
      replacementLock.lock.holderDocumentId,
    ),
  );
  assert.equal(replacementBegin.ok, true, JSON.stringify(replacementBegin));

  // The replacement runner may report its terminal checkpoint just before its
  // own finally block releases Debug. The old runner is still fenced by the
  // attempt token bound to the execution lock during that interval.
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    ...harness.storage[UNATTENDED_REQUEST_KEY],
    status: "completed",
    finishedAt: new Date().toISOString(),
  };

  const lateEnd = await harness.sendBackgroundMessage({
    type: "onstarvoice:end-capture-task",
    taskId: stableTaskId,
    attemptId: request.attemptId,
    reason: "failed",
    status: "failed",
  });

  assert.equal(lateEnd.ok, true, JSON.stringify(lateEnd));
  assert.equal(lateEnd.data.ignored, true);
  assert.equal(lateEnd.data.reason, "stale_unattended_attempt");
  assert.equal(
    harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId,
    44,
  );
  assert.equal(
    harness.api.getCaptureDebugSessionByTaskId(stableTaskId)?.tabId,
    44,
  );
  assert.equal(harness.storage[LOCK_KEY].captureTaskId, stableTaskId);
  assert.equal(
    harness.storage[UNATTENDED_REQUEST_KEY].attemptId,
    replacementRequest.attemptId,
  );
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "completed");
});

test("a stale unattended BEGIN is fenced even between recovery locks", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    attemptId: "attempt-current",
    attemptNumber: 2,
  });
  const stableTaskId = `unattended-capture:${request.id}`;

  const staleBegin = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: stableTaskId,
    attemptId: "attempt-old",
    sourceTabId: 41,
    platform: "xiaohongshu",
  });

  assert.equal(staleBegin.ok, false, JSON.stringify(staleBegin));
  assert.equal(staleBegin.error.code, "stale_unattended_attempt");
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);
  assert.equal(harness.storage[LOCK_KEY], undefined);
});

test("a current stable unattended BEGIN is rejected when its execution lock is missing", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    attemptId: "attempt-current-no-lock",
  });
  const stableTaskId = `unattended-capture:${request.id}`;

  const begin = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: stableTaskId,
    attemptId: request.attemptId,
    sourceTabId: 41,
    platform: "xiaohongshu",
  });

  assert.equal(begin.ok, false, JSON.stringify(begin));
  assert.ok(String(begin.error?.code || ""));
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);
  assert.equal(harness.storage[LOCK_KEY], undefined);
});

test("claim without holder evidence is rejected before changing request state", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    status: "pending",
    attemptId: "attempt-missing-holder",
    startedAt: "",
    claimedAt: "",
  });

  const claim = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: request.runnerTabId,
  });

  assert.equal(claim.accepted, false, JSON.stringify(claim));
  assert.equal(claim.reason, "missing_lock_holder");
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY].status, "pending");
  assert.equal(harness.storage[LOCK_KEY], undefined);
});

test("claim reserves the unattended lock before the stable capture task begins", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    status: "pending",
    attemptId: "attempt-claim-lock",
    startedAt: "",
    claimedAt: "",
  });
  const stableTaskId = `unattended-capture:${request.id}`;

  const claim = await harness.api.claimUnattendedKeywordRun({
    requestId: request.id,
    senderTabId: request.runnerTabId,
    senderDocumentId: "claim-runner-document",
    holderId: "claim-runner-holder",
  });

  assert.equal(claim.accepted, true, JSON.stringify(claim));
  assert.equal(claim.lock?.owner, "unattended_keyword_plan");
  assert.equal(harness.storage[LOCK_KEY]?.id, claim.lock?.id);

  const begin = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "xiaohongshu",
    },
    {
      documentId: "claim-runner-document",
      tab: {
        id: request.runnerTabId,
        url: `chrome-extension://test/sidebar/sidebar.html?unattendedRun=${request.id}`,
      },
    },
  );

  assert.equal(begin.ok, true, JSON.stringify(begin));
  assert.equal(harness.storage[LOCK_KEY]?.captureTaskId, stableTaskId);
  assert.equal(
    harness.storage[LOCK_KEY]?.captureTaskAttemptId,
    request.attemptId,
  );
});

test("unattended bind CAS rejects a lock transferred after BEGIN preflight", async () => {
  const harness = createHarness();
  const stableTaskId = "unattended-capture:request-race";
  const attemptId = "attempt-old";
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "holder-old",
    holderDocumentId: "document-old",
    holderTabId: 42,
  });
  assert.equal(acquired.ok, true);
  const initiallyBound = await harness.api.bindCaptureExecutionLockToTask(
    stableTaskId,
    41,
    {
      allowUnattendedRebind: true,
      attemptId,
      expectedLockId: acquired.lock.id,
      expectedHolderId: acquired.lock.holderId,
      expectedHolderDocumentId: acquired.lock.holderDocumentId,
    },
  );
  assert.equal(initiallyBound.captureTaskId, stableTaskId);
  assert.equal(initiallyBound.captureTaskAttemptId, attemptId);
  const oldLock = {...initiallyBound};
  harness.storage[LOCK_KEY] = {
    ...oldLock,
    holderId: "holder-new",
    holderDocumentId: "document-new",
    holderTabId: 52,
  };

  const result = await harness.api.bindCaptureExecutionLockToTask(
    stableTaskId,
    41,
    {
      allowUnattendedRebind: true,
      attemptId,
      expectedLockId: oldLock.id,
      expectedHolderId: oldLock.holderId,
      expectedHolderDocumentId: oldLock.holderDocumentId,
    },
  );

  assert.equal(result, null);
  assert.equal(harness.storage[LOCK_KEY].holderId, "holder-new");
  assert.equal(harness.storage[LOCK_KEY].captureTaskId, stableTaskId);
  assert.equal(harness.storage[LOCK_KEY].captureTaskAttemptId, attemptId);
});

test("an old unattended BEGIN cannot replace or clean resources after holder transfer", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    attemptId: "attempt-holder-transfer",
  });
  const stableTaskId = `unattended-capture:${request.id}`;
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "holder-old",
    holderDocumentId: "document-old",
    holderTabId: 41,
  });
  assert.equal(acquired.ok, true);
  const initiallyBound = await harness.api.bindCaptureExecutionLockToTask(
    stableTaskId,
    41,
    {
      allowUnattendedRebind: true,
      attemptId: request.attemptId,
      expectedLockId: acquired.lock.id,
      expectedHolderId: acquired.lock.holderId,
      expectedHolderDocumentId: acquired.lock.holderDocumentId,
    },
  );
  assert.equal(initiallyBound.captureTaskId, stableTaskId);
  assert.equal(initiallyBound.captureTaskAttemptId, request.attemptId);

  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    holderId: "holder-new",
    holderDocumentId: "document-new",
    holderTabId: 52,
  };

  const replacementBegin = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 52,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(request, "document-new"),
  );
  assert.equal(replacementBegin.ok, true, JSON.stringify(replacementBegin));
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId, 52);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId)?.tabId, 52);

  const staleBegin = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(request, "document-old"),
  );

  assert.equal(staleBegin.ok, false, JSON.stringify(staleBegin));
  assert.equal(staleBegin.error.code, "unattended_runner_mismatch");
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId, 52);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId)?.tabId, 52);
  assert.equal(harness.storage[LOCK_KEY].holderId, "holder-new");
  assert.equal(harness.storage[LOCK_KEY].holderDocumentId, "document-new");
  assert.equal(harness.storage[LOCK_KEY].holderTabId, 52);
  assert.equal(harness.storage[LOCK_KEY].captureTaskId, stableTaskId);
  assert.equal(
    harness.storage[LOCK_KEY].captureTaskAttemptId,
    request.attemptId,
  );
});

test("serialized stable BEGIN rechecks holder before cleanup and lets the new holder win", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    attemptId: "attempt-holder-cleanup-race",
  });
  const stableTaskId = `unattended-capture:${request.id}`;
  const oldHolderDocumentId = "holder-cleanup-old-document";
  const newHolderDocumentId = "holder-cleanup-new-document";
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "holder-cleanup-old",
    holderDocumentId: oldHolderDocumentId,
    holderTabId: request.runnerTabId,
  });
  assert.equal(acquired.ok, true);

  const initialBegin = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 41,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(request, oldHolderDocumentId),
  );
  assert.equal(initialBegin.ok, true, JSON.stringify(initialBegin));
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId, 41);

  let releaseOldHolderRead;
  let markOldHolderRead;
  const oldHolderReadPaused = new Promise((resolve) => {
    markOldHolderRead = resolve;
  });
  const oldHolderReadGate = new Promise((resolve) => {
    releaseOldHolderRead = resolve;
  });
  let lockReadCount = 0;
  harness.setStorageGetHandler(async (keys, result) => {
    if (keys === LOCK_KEY) {
      lockReadCount += 1;
      // First read is beginCaptureTask's preflight; the second is reclaim's
      // holder snapshot, immediately before its later cleanup decision.
      if (lockReadCount === 2) {
        markOldHolderRead();
        await oldHolderReadGate;
      }
    }
    return result;
  });

  let releaseNewBegin;
  let markNewBegin;
  const newBeginPaused = new Promise((resolve) => {
    markNewBegin = resolve;
  });
  const newBeginGate = new Promise((resolve) => {
    releaseNewBegin = resolve;
  });
  let newBeginWasPaused = false;
  harness.setTabGetHandler(async (tabId) => {
    if (Number(tabId) === 52 && !newBeginWasPaused) {
      newBeginWasPaused = true;
      markNewBegin();
      await newBeginGate;
    }
    return {
      id: Number(tabId),
      windowId: 1,
      groupId: -1,
      status: "complete",
      url: "https://www.xiaohongshu.com/search_result?keyword=holder-race",
      title: "holder race source",
    };
  });

  const oldBeginPromise = harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 43,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(request, oldHolderDocumentId),
  );
  await oldHolderReadPaused;

  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    holderId: "holder-cleanup-new",
    holderDocumentId: newHolderDocumentId,
    updatedAt: new Date().toISOString(),
  };
  const newBeginPromise = harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: stableTaskId,
      attemptId: request.attemptId,
      sourceTabId: 52,
      platform: "xiaohongshu",
    },
    buildUnattendedRunnerSender(request, newHolderDocumentId),
  );

  await Promise.resolve();
  assert.equal(
    harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId,
    41,
    "the queued new BEGIN must not create resources while the old BEGIN is paused",
  );

  releaseOldHolderRead();
  await newBeginPaused;
  const oldBegin = await oldBeginPromise;
  assert.equal(oldBegin.ok, false, JSON.stringify(oldBegin));
  assert.equal(oldBegin.error.code, "unattended_runner_mismatch");
  assert.equal(
    harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId,
    41,
    "the rejected old BEGIN must not clean the current stable task resources",
  );
  assert.equal(
    harness.api.getCaptureDebugSessionByTaskId(stableTaskId)?.tabId,
    41,
  );

  releaseNewBegin();
  const newBegin = await newBeginPromise;
  assert.equal(newBegin.ok, true, JSON.stringify(newBegin));
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId, 52);
  assert.equal(
    harness.api.getCaptureDebugSessionByTaskId(stableTaskId)?.tabId,
    52,
  );
  assert.equal(harness.storage[LOCK_KEY]?.holderId, "holder-cleanup-new");
  assert.equal(
    harness.storage[LOCK_KEY]?.holderDocumentId,
    newHolderDocumentId,
  );
});

test("a post-bind holder transfer rolls back the old BEGIN before the queued holder starts", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    attemptId: "attempt-post-bind-holder-transfer",
  });
  const stableTaskId = `unattended-capture:${request.id}`;
  const oldHolderDocumentId = "post-bind-old-document";
  const newHolderDocumentId = "post-bind-new-document";
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "post-bind-old-holder",
    holderDocumentId: oldHolderDocumentId,
    holderTabId: request.runnerTabId,
  });
  assert.equal(acquired.ok, true);

  let releaseOldPreflight;
  let markOldPreflight;
  const oldPreflightPaused = new Promise((resolve) => {
    markOldPreflight = resolve;
  });
  const oldPreflightGate = new Promise((resolve) => {
    releaseOldPreflight = resolve;
  });
  let releaseNewPreflight;
  let markNewPreflight;
  const newPreflightPaused = new Promise((resolve) => {
    markNewPreflight = resolve;
  });
  const newPreflightGate = new Promise((resolve) => {
    releaseNewPreflight = resolve;
  });
  let debuggerPreflightCount = 0;
  harness.chrome.debugger.getTargets = async () => {
    debuggerPreflightCount += 1;
    if (debuggerPreflightCount === 1) {
      markOldPreflight();
      await oldPreflightGate;
    } else if (debuggerPreflightCount === 2) {
      markNewPreflight();
      await newPreflightGate;
    }
    return [];
  };

  let oldBeginSettled = false;
  const oldBeginPromise = harness
    .sendBackgroundMessage(
      {
        type: "onstarvoice:begin-capture-task",
        taskId: stableTaskId,
        attemptId: request.attemptId,
        sourceTabId: 41,
        platform: "xiaohongshu",
      },
      buildUnattendedRunnerSender(request, oldHolderDocumentId),
    )
    .then((response) => {
      oldBeginSettled = true;
      return response;
    });
  await oldPreflightPaused;

  assert.equal(harness.storage[LOCK_KEY]?.captureTaskId, stableTaskId);
  assert.equal(
    harness.storage[LOCK_KEY]?.captureTaskAttemptId,
    request.attemptId,
  );
  assert.equal(harness.storage[LOCK_KEY]?.holderId, "post-bind-old-holder");
  assert.equal(
    harness.storage[LOCK_KEY]?.holderDocumentId,
    oldHolderDocumentId,
  );
  assert.equal(harness.storage[LOCK_KEY]?.holderTabId, 41);
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);

  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    holderId: "post-bind-new-holder",
    holderDocumentId: newHolderDocumentId,
    holderTabId: 52,
    updatedAt: new Date().toISOString(),
  };

  let newBeginSettled = false;
  const newBeginPromise = harness
    .sendBackgroundMessage(
      {
        type: "onstarvoice:begin-capture-task",
        taskId: stableTaskId,
        attemptId: request.attemptId,
        sourceTabId: 52,
        platform: "xiaohongshu",
      },
      buildUnattendedRunnerSender(request, newHolderDocumentId),
    )
    .then((response) => {
      newBeginSettled = true;
      return response;
    });

  await Promise.resolve();
  assert.equal(oldBeginSettled, false);
  assert.equal(newBeginSettled, false);
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);

  releaseOldPreflight();
  await newPreflightPaused;
  const oldBegin = await oldBeginPromise;
  assert.equal(oldBegin.ok, false, JSON.stringify(oldBegin));
  assert.equal(oldBegin.error.code, "unattended_begin_fence_changed");
  assert.equal(newBeginSettled, false);
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);
  assert.equal(harness.storage[LOCK_KEY]?.holderId, "post-bind-new-holder");
  assert.equal(
    harness.storage[LOCK_KEY]?.holderDocumentId,
    newHolderDocumentId,
  );
  assert.equal(harness.storage[LOCK_KEY]?.holderTabId, 52);
  assert.equal(harness.storage[LOCK_KEY]?.captureTaskId, stableTaskId);
  assert.equal(
    harness.storage[LOCK_KEY]?.captureTaskAttemptId,
    request.attemptId,
  );

  releaseNewPreflight();
  const newBegin = await newBeginPromise;
  assert.equal(newBegin.ok, true, JSON.stringify(newBegin));
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId)?.sourceTabId, 52);
  assert.equal(
    harness.api.getCaptureDebugSessionByTaskId(stableTaskId)?.tabId,
    52,
  );
  assert.equal(harness.storage[LOCK_KEY]?.holderId, "post-bind-new-holder");
  assert.equal(
    harness.storage[LOCK_KEY]?.holderDocumentId,
    newHolderDocumentId,
  );
  assert.equal(harness.storage[LOCK_KEY]?.holderTabId, 52);
  assert.equal(harness.storage[LOCK_KEY]?.captureTaskId, stableTaskId);
  assert.equal(
    harness.storage[LOCK_KEY]?.captureTaskAttemptId,
    request.attemptId,
  );
});

test("a terminal unattended request cannot BEGIN even while its old lock remains", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    attemptId: "attempt-already-terminal",
    status: "completed",
    finishedAt: new Date().toISOString(),
  });
  const stableTaskId = `unattended-capture:${request.id}`;
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    holderId: "terminal-holder",
    holderDocumentId: "terminal-document",
    holderTabId: 41,
  });
  assert.equal(acquired.ok, true);

  const begin = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: stableTaskId,
    attemptId: request.attemptId,
    sourceTabId: 41,
    platform: "xiaohongshu",
  });

  assert.equal(begin.ok, false, JSON.stringify(begin));
  assert.ok(String(begin.error?.code || ""));
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);
  assert.notEqual(harness.storage[LOCK_KEY]?.captureTaskId, stableTaskId);
});

test("a stable unattended BEGIN cannot bind through a non-unattended lock", async () => {
  const harness = createHarness();
  const request = seedUnattendedRequest(harness, {
    attemptId: "attempt-wrong-lock-owner",
  });
  const stableTaskId = `unattended-capture:${request.id}`;
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "manual_batch_keyword_capture",
    holderId: "manual-holder",
    holderDocumentId: "manual-document",
    holderTabId: 41,
  });
  assert.equal(acquired.ok, true);

  const begin = await harness.sendBackgroundMessage({
    type: "onstarvoice:begin-capture-task",
    taskId: stableTaskId,
    attemptId: request.attemptId,
    sourceTabId: 41,
    platform: "xiaohongshu",
  });

  assert.equal(begin.ok, false, JSON.stringify(begin));
  assert.ok(String(begin.error?.code || ""));
  assert.equal(harness.api.getCaptureTaskGroup(stableTaskId), null);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(stableTaskId), null);
  assert.equal(harness.storage[LOCK_KEY].id, acquired.lock.id);
  assert.equal(harness.storage[LOCK_KEY].owner, "manual_batch_keyword_capture");
  assert.equal(harness.storage[LOCK_KEY].captureTaskId, undefined);
});

test("owner disconnect terminalizes a ledger-only task after resources already vanished", async () => {
  const harness = createHarness();
  await harness.api.upsertTaskLedgerRun({
    run: {
      id: "ledger-only-owner-task",
      taskType: "capture",
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });

  await harness.api.handleAbandonedCaptureTask({
    taskId: "ledger-only-owner-task",
  });
  const run = harness.storage[TASK_LEDGER_KEY].runs.find(
    (item) => item.id === "ledger-only-owner-task",
  );
  assert.equal(run.status, "canceled");
  assert.equal(run.error.code, "sidebar_owner_disconnected");
});

test("task ledger reads reconcile abandoned running records", async () => {
  const harness = createHarness();
  const oldAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  harness.storage[TASK_LEDGER_KEY] = {
    version: 1,
    runs: [
      {
        id: "abandoned-task",
        taskType: "keyword_capture",
        status: "running",
        createdAt: oldAt,
        updatedAt: oldAt,
        businessProgressAt: oldAt,
      },
    ],
  };

  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:get-task-ledger",
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.runs[0].status, "canceled");
  assert.equal(harness.storage[TASK_LEDGER_KEY].runs[0].status, "canceled");
});

test("clearing task center removes history but preserves a recently active task", async () => {
  const harness = createHarness();
  const nowIso = new Date().toISOString();
  harness.storage[TASK_LEDGER_KEY] = {
    version: 1,
    runs: [
      {
        id: "recent-task",
        taskType: "keyword_capture",
        status: "running",
        createdAt: nowIso,
        updatedAt: nowIso,
        businessProgressAt: nowIso,
      },
      {
        id: "finished-task",
        taskType: "sync",
        status: "completed",
        createdAt: nowIso,
        finishedAt: nowIso,
      },
    ],
  };
  harness.storage[SYNC_HISTORY_KEY] = {entries: [{id: "old-sync"}]};
  harness.storage[UNATTENDED_ARCHIVE_KEY] = {
    version: 1,
    requests: {
      "old-retryable-task": {
        id: "old-retryable-task",
        attemptId: "old-retryable-attempt",
        status: "failed",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  };

  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:clear-task-center",
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.preservedActiveCount, 1);
  assert.deepEqual(
    Array.from(harness.storage[TASK_LEDGER_KEY].runs, (run) => run.id),
    ["recent-task"],
  );
  assert.equal(Boolean(harness.storage[TASK_LEDGER_KEY].clearedAt), true);
  assert.deepEqual(Array.from(harness.storage[SYNC_HISTORY_KEY].entries), []);
  assert.equal(harness.storage[UNATTENDED_ARCHIVE_KEY], undefined);
});

test("clearing task center removes a stale unattended request and its legacy plan mirror", async () => {
  const harness = createHarness();
  const oldAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  harness.storage[UNATTENDED_REQUEST_KEY] = {
    id: "stale-unattended-request",
    status: "running",
    createdAt: oldAt,
    updatedAt: oldAt,
    heartbeatAt: oldAt,
    businessProgressAt: oldAt,
  };
  harness.storage[UNATTENDED_PLAN_KEY] = buildUnattendedPlan({
    lastRunAt: oldAt,
    lastRunStatus: "running",
    lastRunMessage: "旧任务仍在运行",
    lastRunProgress: {current: 1, total: 2, updatedAt: oldAt},
  });
  harness.storage[TASK_LEDGER_KEY] = {
    version: 1,
    runs: [
      {
        id: "stale-unattended-request",
        taskType: "unattended_keyword_capture",
        status: "running",
        createdAt: oldAt,
        updatedAt: oldAt,
        businessProgressAt: oldAt,
      },
    ],
  };

  const response = await harness.sendBackgroundMessage({
    type: "onstarvoice:clear-task-center",
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.clearedUnattendedRequest, true);
  assert.equal(harness.storage[UNATTENDED_REQUEST_KEY], undefined);
  assert.equal(harness.storage[UNATTENDED_PLAN_KEY].lastRunStatus, "");
  assert.equal(harness.storage[UNATTENDED_PLAN_KEY].lastRunAt, "");
  assert.deepEqual(
    Array.from(harness.storage[TASK_LEDGER_KEY].runs),
    [],
  );
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
      assert.match(acquireBlock, /captureExecutionLockReleasePendingId/);
      assert.match(
        acquireBlock,
        /await releaseCaptureExecutionLock\(\s*captureExecutionLockReleasePendingId/,
      );
      const releaseBlock = source.slice(
        source.indexOf("async function releaseCaptureExecutionLock"),
        source.indexOf("function getUnattendedRunRequestIdFromUrl"),
      );
      assert.match(releaseBlock, /for \(const delayMs of \[0, 120, 360\]\)/);
      assert.match(releaseBlock, /captureExecutionLockReleasePendingId = lockId/);
      assert.doesNotMatch(releaseBlock, /finally \{/);
    },
  );
});
