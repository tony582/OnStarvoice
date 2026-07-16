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
  let uuidCounter = 0;
  let contextMode = "alive";
  let tabMessageHandler = null;
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
      async clear() {
        return true;
      },
      async create() {},
    },
    action: {onClicked: createEvent()},
    tabs: {
      onActivated: createEvent(),
      onUpdated: createEvent(),
      async sendMessage(tabId, payload) {
        sentTabMessages.push({tabId, payload});
        if (typeof tabMessageHandler === "function") {
          return await tabMessageHandler(tabId, payload);
        }
        return {ok: true};
      },
      async get(tabId) {
        return {
          id: tabId,
          status: "complete",
          url: "https://www.xiaohongshu.com/explore/test-note",
        };
      },
      async query() {
        return [];
      },
      async update(tabId, patch) {
        return {id: tabId, ...patch};
      },
      async reload(tabId) {
        reloadedTabIds.push(tabId);
        if (typeof reloadHook === "function") {
          await reloadHook(tabId);
        }
      },
      async create(options) {
        return {id: 99, ...options};
      },
    },
    sidePanel: {
      async open() {},
      async setOptions() {},
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
  });

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
      `  releaseUnattendedKeywordPlanLock,\n` +
      `  flush: () => captureExecutionLockOperationQueue,\n` +
      `  flushRuntime: () => runtimeMutationQueue,\n` +
      `};`,
    context,
    {filename: "background.js"},
  );

  return {
    api: context.__captureLockTestApi,
    chrome,
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
    storage,
  };
}

const LOCK_KEY = "onstarvoice.captureExecutionLock";

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

test("concurrent progress and page-state messages preserve both runtime patches", async () => {
  const harness = createHarness();
  const sender = {
    tab: {
      id: 22,
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
