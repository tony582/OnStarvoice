import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {readFile} from "node:fs/promises";
import test, {after} from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

// 0.4.19 无人值守自愈（设计：docs/hotfix/20260927-unattended-self-heal.md）：
// 真实 background.js + 假 chrome。自停路径的禁止调用（刷新、带刷新的停止、
// 重注入）用 spy 锁定。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFileKeepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(testFileKeepAlive));

const read = (path) => readFile(resolve(repoRoot, path), "utf8");
const backgroundSource = await read("background.js");
const contentSource = await read("content-v2.js");
const supportSources = await Promise.all(
  [
    "utils/task-center.js",
    "utils/cloud-targeted-post.js",
    "utils/control-storage-reserve.js",
    "utils/manual-keyword-dispatch.js",
    "utils/runtime-tab-policy.js",
    "utils/capture/debug-session.js",
    "utils/capture/task-tab-group.js",
    "utils/capture/task-runtime.js",
    "utils/capture/task-owner.js",
  ].map(async (path) => ({path, source: await read(path)})),
);

const REQUEST_KEY = "onstarvoice.unattendedKeywordRunRequest";
const PLAN_KEY = "onstarvoice.unattendedKeywordPlan";
const LOCK_KEY = "onstarvoice.captureExecutionLock";
const EPOCH_KEY = "onstarvoice.runtimeEpoch";
const OWNED_TABS_KEY = "onstarvoice.ownedCaptureTabs.v1";
const RETIRED_PREFIX = "onstarvoice.unattendedAttemptRetired.v1.";
const EXTENSION_ORIGIN = "chrome-extension://test";
const MISSING_RECEIVER =
  "Could not establish connection. Receiving end does not exist.";

const REQUEST_ID = "self-stop-request";
const TASK_KEY = `unattended-capture:${REQUEST_ID}`;
const A1 = "attempt-1";
const CAPTURE_ID = "capture-r";
const SOURCE_TAB = 20;
const RUNNER_TAB = 30;
const RUNNER_DOCUMENT = "runner-document";

// 自停路径绝不调用的函数：带刷新或不限定请求的停止、重注入、刷新清理。
const FORBIDDEN_FUNCTIONS = [
  "stopUnattendedCaptureTargetsForRecovery",
  "stopPreviousUnattendedCaptureForResume",
  "reloadUnattendedCaptureTabAndConfirm",
  "removeStaleCaptureExecutionLock",
  "ensureContentScriptReady",
  "waitForContentScriptReady",
  "cancelTimedOutContentCapture",
  "relayToContentWithRetry",
];

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const contentInspectBlock = sourceBlock(
  contentSource,
  "function handleInspectCaptureActivity",
  "function reportCaptureProgress",
);
const buildRealContentInspect = vm.runInContext(
  `(activeCaptureRequestCounts) => {\n${contentInspectBlock}\n` +
    `return handleInspectCaptureActivity;\n}`,
  vm.createContext({}),
  {filename: "content-v2-inspect.js"},
);

function inspectWithRealContentHandler(activeCounts, request = {}) {
  let response = null;
  buildRealContentInspect(new Map(activeCounts))(request, (value) => {
    response = value;
  });
  return JSON.parse(JSON.stringify(response));
}

function runnerUrl(requestId, attemptId = "") {
  return (
    `${EXTENSION_ORIGIN}/sidebar/sidebar.html?unattendedRun=${requestId}` +
    (attemptId ? `&unattendedAttempt=${attemptId}` : "")
  );
}

function runnerSender(attemptId, {tabId = RUNNER_TAB, documentId = RUNNER_DOCUMENT} = {}) {
  const url = runnerUrl(REQUEST_ID, attemptId);
  return {documentId, tab: {id: tabId, url}, url};
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// state 可以在两个 harness 之间共享：第二个 harness 相当于 service worker 重启
// （内存里的中继登记、中止标记、tabs.onCreated 记录全部丢失，存储与标签页保留）。
function createHarness({state = null} = {}) {
  const shared = state || {
    storage: {},
    sessionStore: {},
    tabs: new Map(),
    tabDocuments: new Map(),
    deadDocuments: new Set(),
    documents: new Map(),
    contents: new Map(),
    windowFocus: new Map([[1, false]]),
    nextTabId: {value: 900},
  };
  const {storage, sessionStore, tabs, tabDocuments, deadDocuments, documents, contents} = shared;
  const sentTabMessages = [];
  const removedTabIds = [];
  const createdTabs = [];
  const updatedTabs = [];
  const forbiddenTabCalls = {reload: [], discard: []};
  const forbiddenCalls = Object.fromEntries(
    FORBIDDEN_FUNCTIONS.map((name) => [name, 0]),
  );
  let uuidCounter = 0;
  const unrefSetTimeout = (handler, delay, ...args) => {
    const timer = setTimeout(handler, delay, ...args);
    timer.unref?.();
    return timer;
  };

  const localStorage = {
    async get(keys) {
      if (keys === null || keys === undefined) return {...storage};
      if (typeof keys === "string") {
        return Object.hasOwn(storage, keys) ? {[keys]: storage[keys]} : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys.filter((key) => Object.hasOwn(storage, key))
            .map((key) => [key, storage[key]]),
        );
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          Object.hasOwn(storage, key) ? storage[key] : fallback,
        ]),
      );
    },
    async set(values) {
      Object.assign(storage, JSON.parse(JSON.stringify(values)));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete storage[key];
      }
    },
  };

  const session = {
    async get(key) {
      return Object.hasOwn(sessionStore, key) ? {[key]: sessionStore[key]} : {};
    },
    async set(values) {
      Object.assign(sessionStore, JSON.parse(JSON.stringify(values)));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete sessionStore[key];
      }
    },
  };

  const missingTab = (tabId) => new Error(`No tab with id: ${tabId}.`);
  const onCreated = createEvent();
  const onRemoved = createEvent();

  const chrome = {
    runtime: {
      id: "test",
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent(),
      onConnect: createEvent(),
      getManifest: () => ({version: "0.4.19"}),
      getURL: (path) => `${EXTENSION_ORIGIN}/${path}`,
      async getContexts({documentIds = []} = {}) {
        return documentIds
          .filter((documentId) => !deadDocuments.has(documentId))
          .map((documentId) => ({documentId}));
      },
    },
    storage: {local: localStorage, session},
    alarms: {
      onAlarm: createEvent(),
      async clear() {
        return true;
      },
      async create() {},
    },
    action: {
      onClicked: createEvent(),
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
    },
    tabs: {
      onActivated: createEvent(),
      onCreated,
      onUpdated: createEvent(),
      onRemoved,
      onReplaced: createEvent(),
      async sendMessage(tabId, payload) {
        const id = Number(tabId);
        sentTabMessages.push({tabId: id, payload: {...payload}});
        const content = contents.get(id);
        if (!tabs.has(id) || !content || content.receiver === false) {
          throw new Error(MISSING_RECEIVER);
        }
        const action = String(payload?.action || "");
        if (action === "inspectCaptureActivity") {
          if (content.hang) return await new Promise(() => {});
          return inspectWithRealContentHandler(content.active, payload);
        }
        if (action === "cancelCapture") {
          const target = String(payload?.captureRequestId || "");
          const matched = !target || content.active.has(target);
          if (matched && content.cancel === "settle") content.active.clear();
          return {ok: true, matched};
        }
        if (typeof content.onAction === "function") {
          return await content.onAction(payload);
        }
        return {ok: true};
      },
      async get(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw missingTab(tabId);
        return {...tab};
      },
      async query(queryInfo = {}) {
        const all = [...tabs.values()].map((tab) => ({...tab}));
        return queryInfo?.active === true
          ? all.filter((tab) => tab.active === true)
          : all;
      },
      async remove(tabId) {
        const id = Number(tabId);
        if (!tabs.has(id)) throw missingTab(id);
        if (tabs.get(id)?.stuckOnRemove === true) return;
        removedTabIds.push(id);
        tabs.delete(id);
        const documentId = tabDocuments.get(id);
        if (documentId) deadDocuments.add(documentId);
        for (const listener of [...onRemoved.listeners]) {
          listener(id, {isWindowClosing: false});
        }
      },
      async reload(tabId) {
        forbiddenTabCalls.reload.push(Number(tabId));
      },
      async update(tabId, patch) {
        updatedTabs.push({tabId: Number(tabId), patch});
        const tab = tabs.get(Number(tabId));
        return tab ? {...tab, ...patch} : {id: Number(tabId), ...patch};
      },
      async discard(tabId) {
        // 与 Chrome 一致：活动页和已丢弃的页不丢弃（返回 undefined）；丢弃后
        // 旧文档被销毁，标签页留在标签栏。
        const id = Number(tabId);
        forbiddenTabCalls.discard.push(id);
        const tab = tabs.get(id);
        if (!tab) throw missingTab(id);
        if (tab.active === true || tab.discarded === true) return undefined;
        tabs.set(id, {...tab, discarded: true, frozen: false, status: "unloaded"});
        documents.delete(id);
        contents.delete(id);
        const documentId = tabDocuments.get(id);
        if (documentId) deadDocuments.add(documentId);
        return {...tabs.get(id)};
      },
      async create(options = {}) {
        shared.nextTabId.value += 1;
        const id = shared.nextTabId.value;
        const tab = {
          id,
          windowId: Number.isFinite(Number(options.windowId))
            ? Number(options.windowId)
            : 1,
          groupId: -1,
          status: "complete",
          active: options.active === true,
          url: String(options.url || ""),
          title: "",
        };
        tabs.set(id, tab);
        createdTabs.push({...tab});
        for (const listener of [...onCreated.listeners]) listener({...tab});
        return {...tab};
      },
      async group() {
        return 1;
      },
      async ungroup() {},
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
      async get(windowId) {
        return {id: windowId, focused: shared.windowFocus.get(windowId) === true};
      },
      async update(windowId, patch) {
        return {id: windowId, ...patch};
      },
    },
    scripting: {
      async executeScript(options = {}) {
        const tabId = Number(options?.target?.tabId);
        const documentState = documents.get(tabId);
        if (tabs.has(tabId) && documentState?.errorPage) {
          throw new Error("Frame with ID 0 is showing error page");
        }
        if (!tabs.has(tabId) || !documentState || documentState.fail) {
          throw new Error("Cannot access contents of the page");
        }
        if (documentState.hang) return await new Promise(() => {});
        return [{
          frameId: 0,
          result: {t: documentState.timeOrigin, o: documentState.overlay || ""},
        }];
      },
    },
  };

  const context = vm.createContext({
    chrome,
    console: {error() {}, log() {}, warn() {}, debug() {}},
    crypto: {
      subtle: webcrypto.subtle,
      randomUUID() {
        uuidCounter += 1;
        return `uuid-${uuidCounter}`;
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
          agent: {
            registrationId: options.agentId || "",
            capabilities: {previousCaptureStopCheckV1: true},
            health: {status: "healthy", degradedReasons: []},
          },
          tasks: [],
          reason: options.reason || "",
        };
      },
      async sendHeartbeat() {
        return {ok: true, commands: []};
      },
      async completeCommand(options = {}) {
        return {ok: true, commandId: options.commandId};
      },
      async completeStopFenceCheck() {
        return {ok: true, released: true};
      },
    },
  });

  for (const {path, source} of supportSources) {
    vm.runInContext(source, context, {filename: path});
  }
  vm.runInContext(
    `${backgroundSource}\n;globalThis.__selfStopTestApi = {\n` +
      `  recoverUnattendedKeywordRunRequest,\n` +
      `  superviseUnattendedKeywordRun,\n` +
      `  launchPendingUnattendedRecovery,\n` +
      `  manuallyRecoverUnattendedKeywordRun,\n` +
      `  confirmPreviousUnattendedStopForFenceCheck,\n` +
      `  claimUnattendedKeywordRun,\n` +
      `  renewCaptureExecutionLock,\n` +
      `  readActiveCaptureExecutionLock,\n` +
      `  markCaptureRequestAborted,\n` +
      `  isCaptureRequestAborted,\n` +
      `  listRequestRelays,\n` +
      `  listOwnedCaptureTabsForRequest,\n` +
      `  readUnattendedAttemptRetiredReceipt,\n` +
      `  inFlightRelays: () => [...inFlightContentRelays.values()],\n` +
      `  relay: (...args) => relayToContentWithRetry(...args),\n` +
      `  stopFenceTiming: STOP_FENCE_CHECK_TIMING,\n` +

      `  registrationTiming: OWNED_CAPTURE_TAB_REGISTRATION_TIMING,\n` +
      `  selfStopTiming: UNATTENDED_RECOVERY_SELF_STOP_TIMING,\n` +
      `  flushUnattended: () => unattendedRunMutationQueue,\n` +
      `  flushOwnedTabs: () => ownedCaptureTabsQueue,\n` +
      `};`,
    context,
    {filename: "background.js"},
  );
  const api = context.__selfStopTestApi;
  Object.assign(api.stopFenceTiming, {
    deadlineMs: 3000,
    probeTimeoutMs: 150,
    contentQueryTimeoutMs: 150,
    cancelSettleMs: 250,
    cancelPollMs: 20,
    relayDrainMs: 150,
    relayPollMs: 10,
  });
  Object.assign(api.registrationTiming, {createdWaitMs: 50, createdPollMs: 5});
  Object.assign(api.selfStopTiming, {
    firstRetireWaitMs: 200,
    retirePollMs: 10,
    closeConfirmMs: 300,
    closePollMs: 10,
  });

  for (const name of FORBIDDEN_FUNCTIONS) {
    const original = context[name];
    assert.equal(typeof original, "function", `${name} must exist`);
    context[name] = function forbiddenSpy(...args) {
      forbiddenCalls[name] += 1;
      return original.apply(this, args);
    };
  }

  const harness = {
    api,
    chrome,
    context,
    state: shared,
    storage,
    sessionStore,
    tabs,
    sentTabMessages,
    removedTabIds,
    createdTabs,
    updatedTabs,
    forbiddenTabCalls,
    forbiddenCalls,
    addTab({
      id,
      url,
      title = "",
      status = "complete",
      active = false,
      discarded = false,
      frozen = false,
      windowId = 1,
      lastAccessed = undefined,
      documentId = "",
      timeOrigin = null,
      overlay = "",
      content = null,
    }) {
      tabs.set(id, {
        id,
        url,
        title,
        status,
        active,
        discarded,
        frozen,
        windowId,
        groupId: -1,
        ...(lastAccessed === undefined ? {} : {lastAccessed}),
      });
      if (documentId) tabDocuments.set(id, documentId);
      if (timeOrigin !== null) documents.set(id, {timeOrigin, overlay});
      if (content) {
        contents.set(id, {
          receiver: true,
          hang: false,
          cancel: "settle",
          ...content,
          active: new Map(Object.entries(content.active || {})),
        });
      }
    },
    patchTab(tabId, patch) {
      tabs.set(tabId, {...tabs.get(tabId), ...patch});
    },
    setDocument(tabId, patch) {
      documents.set(tabId, {...(documents.get(tabId) || {}), ...patch});
    },
    content(tabId) {
      return contents.get(tabId);
    },
    killDocument(documentId) {
      deadDocuments.add(documentId);
    },
    resetCallLog() {
      sentTabMessages.length = 0;
      removedTabIds.length = 0;
      forbiddenTabCalls.reload.length = 0;
      forbiddenTabCalls.discard.length = 0;
      for (const name of FORBIDDEN_FUNCTIONS) forbiddenCalls[name] = 0;
    },
    sendBackgroundMessage(message, sender = {}) {
      const listener = chrome.runtime.onMessage.listeners[0];
      return new Promise((resolvePromise) => {
        let responded = false;
        const keepOpen = listener(message, sender, (response) => {
          responded = true;
          resolvePromise(response);
        });
        if (keepOpen !== true && !responded) resolvePromise(undefined);
      });
    },
  };
  return harness;
}

function freshDocument() {
  return Date.now() - 60 * 1000;
}

function seedRuntimeEpoch(harness) {
  harness.sessionStore[EPOCH_KEY] = {
    id: "epoch-current",
    startedAt: Date.now() - 10 * 60 * 1000,
    origin: "extension_load",
  };
}

// 典型现场：R 在第 1 轮采集，来源页 20（晚于本次加载、内容脚本空闲），
// runner 30 持有绑定 R 的执行锁（BEGIN 之后锁的持有页是来源页）。
function seedRunningRequest(harness, overrides = {}) {
  seedRuntimeEpoch(harness);
  const now = new Date().toISOString();
  harness.storage[PLAN_KEY] = {
    enabled: true,
    platform: "xiaohongshu",
    mode: "daily",
    startTime: "09:00",
    keywords: ["关键词一"],
  };
  harness.storage[REQUEST_KEY] = {
    schemaVersion: 2,
    id: REQUEST_ID,
    attemptId: A1,
    attemptNumber: 1,
    progressSeq: 3,
    recoveryCount: 0,
    type: "keyword_batch",
    status: "running",
    cloudAssigned: true,
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    businessProgressAt: now,
    runnerTabId: RUNNER_TAB,
    planSnapshot: harness.storage[PLAN_KEY],
    progress: {
      current: 29,
      total: 50,
      keyword: "关键词一",
      phase: "detail_comments_capturing",
      runnerTabId: SOURCE_TAB,
      captureRequestId: CAPTURE_ID,
    },
    checkpoint: {completedKeywords: [], failedKeywords: [], skippedKeywords: []},
    error: null,
    ...overrides,
  };
  harness.storage[LOCK_KEY] = {
    id: "lock-r",
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "runner-holder",
    holderDocumentId: RUNNER_DOCUMENT,
    holderTabId: SOURCE_TAB,
    captureTaskId: TASK_KEY,
    captureTaskAttemptId: A1,
    schemaVersion: 1,
    startedAt: now,
    updatedAt: now,
    expiresAt: Date.now() + 60 * 1000,
  };
  harness.addTab({
    id: SOURCE_TAB,
    url: "https://www.xiaohongshu.com/search_result?keyword=test",
    title: "小红书搜索页",
    timeOrigin: freshDocument(),
    content: {active: {}},
  });
  harness.addTab({
    id: RUNNER_TAB,
    url: runnerUrl(REQUEST_ID, A1),
    title: "运行页",
    documentId: RUNNER_DOCUMENT,
  });
  return harness.storage[REQUEST_KEY];
}

// A1 的 runner 在后台登记一页详情工作页（about:blank 新建，经 tabs.onCreated 核实）。
async function createRegisteredWorker(harness, {attemptId = A1} = {}) {
  const tab = await harness.chrome.tabs.create({
    url: "about:blank",
    active: false,
    windowId: 1,
  });
  const response = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:record-owned-capture-tab",
      tabId: tab.id,
      sourceTabId: SOURCE_TAB,
    },
    runnerSender(attemptId),
  );
  assert.equal(response?.ok, true, JSON.stringify(response));
  return tab.id;
}

async function retireRunner(harness, attemptId = A1, overrides = {}) {
  const response = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:unattended-attempt-retired",
      reason: "attempt_superseded",
      heartbeatStopped: true,
      flushed: true,
      pendingUploads: 0,
      ...overrides,
    },
    runnerSender(attemptId),
  );
  assert.equal(response?.ok, true, JSON.stringify(response));
}

async function recover(harness, reason = "business_progress_stalled") {
  const result = await harness.api.recoverUnattendedKeywordRunRequest(
    harness.storage[REQUEST_KEY],
    {healthy: false, reason},
  );
  await harness.api.flushUnattended();
  return plain(result);
}

async function superviseAfterWait(harness) {
  harness.storage[REQUEST_KEY] = {
    ...harness.storage[REQUEST_KEY],
    recoveryWaitUntil: new Date(Date.now() - 1000).toISOString(),
    progress: {
      ...harness.storage[REQUEST_KEY].progress,
      waitUntil: new Date(Date.now() - 1000).toISOString(),
    },
  };
  const result = await harness.api.superviseUnattendedKeywordRun();
  await harness.api.flushUnattended();
  return plain(result);
}

function assertSelfStopSafety(
  harness,
  {allowedRemovedTabIds = [], allowedDiscardedTabIds = []} = {},
) {
  assert.deepEqual(harness.forbiddenTabCalls.reload, [], "no tabs.reload");
  for (const tabId of harness.forbiddenTabCalls.discard) {
    assert.ok(
      allowedDiscardedTabIds.includes(tabId),
      `unexpected tab discard ${tabId}`,
    );
  }
  for (const name of FORBIDDEN_FUNCTIONS) {
    assert.equal(harness.forbiddenCalls[name], 0, `${name} must not be called`);
  }
  for (const {payload} of harness.sentTabMessages) {
    if (payload?.action === "cancelCapture") {
      assert.ok(
        String(payload.captureRequestId || "").trim(),
        "every cancelCapture must carry a captureRequestId",
      );
    }
  }
  for (const tabId of harness.removedTabIds) {
    assert.ok(
      allowedRemovedTabIds.includes(tabId),
      `unexpected tab removal ${tabId}`,
    );
  }
}

function runnerLaunches(harness) {
  return harness.createdTabs.filter((tab) =>
    String(tab.url || "").includes("unattendedRun="),
  );
}

async function waitFor(predicate, {timeoutMs = 2000, pollMs = 5} = {}) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// 模拟 0.4.19 runner：看到监督端写的终态退役请求（runnerRetireAttemptId）后
// 立即退役并送回执。
function retireRunnerOnTerminalMarker(harness, attemptId = A1) {
  const originalSet = harness.chrome.storage.local.set;
  let retired = false;
  harness.chrome.storage.local.set = async (values) => {
    await originalSet(values);
    const next = values?.[REQUEST_KEY];
    if (
      !retired &&
      next?.runnerRetireAttemptId === attemptId &&
      ["failed", "needs_action"].includes(next.status)
    ) {
      retired = true;
      setTimeout(() => {
        retireRunner(harness, attemptId, {reason: "request_terminal"}).catch(() => {});
      }, 0);
    }
  };
}

// ==================== 中继轮次围栏 ====================

test("a superseded runner's capture relays are refused before any side effect; controls and the current attempt pass", async () => {
  const harness = createHarness();
  seedRunningRequest(harness, {attemptId: "attempt-2", previousAttemptId: A1});
  const relayTo = (payload, sender) =>
    harness.sendBackgroundMessage(
      {type: "onstarvoice:relay-to-content", tabId: SOURCE_TAB, payload},
      sender,
    );

  const comments = await relayTo(
    {action: "captureComments", captureRequestId: "capture-old", taskId: TASK_KEY},
    runnerSender(A1),
  );
  assert.equal(comments.ok, false);
  assert.equal(comments.error.code, "unattended_attempt_superseded");
  const list = await relayTo(
    {action: "captureKeywordNotes", keyword: "x", taskId: TASK_KEY},
    runnerSender(A1),
  );
  assert.equal(list.ok, false);
  assert.equal(list.error.code, "unattended_attempt_superseded");
  assert.equal(
    harness.sentTabMessages.some(({payload}) =>
      ["captureComments", "captureKeywordNotes"].includes(payload?.action),
    ),
    false,
    "the old attempt never reaches the page",
  );
  assert.equal(harness.api.inFlightRelays().length, 0);

  for (const action of ["ping", "inspectCaptureActivity"]) {
    const response = await relayTo({action}, runnerSender(A1));
    assert.equal(response.ok, true, `${action} passes`);
  }
  const cancel = await relayTo(
    {action: "cancelCapture", captureRequestId: "capture-old"},
    runnerSender(A1),
  );
  assert.equal(cancel.ok, true);

  const current = await relayTo(
    {action: "captureComments", captureRequestId: "capture-new", taskId: TASK_KEY},
    runnerSender("attempt-2"),
  );
  assert.equal(current.ok, true, JSON.stringify(current));
  const legacy = await relayTo(
    {action: "captureComments", captureRequestId: "capture-legacy"},
    {
      documentId: "legacy-document",
      tab: {id: 31, url: runnerUrl(REQUEST_ID)},
      url: runnerUrl(REQUEST_ID),
    },
  );
  assert.equal(legacy.ok, true, "a runner without an attempt parameter is not fenced");
});

test("a runner of a terminal request cannot start another capture", async () => {
  const harness = createHarness();
  seedRunningRequest(harness, {status: "needs_action"});
  const response = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:relay-to-content",
      tabId: SOURCE_TAB,
      payload: {action: "captureComments", captureRequestId: "capture-late"},
    },
    runnerSender(A1),
  );
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unattended_attempt_superseded");
});

// ==================== 自建工作页登记表 ====================

test("only a verified about:blank worker created by an unattended runner is registered", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  const workerId = await createRegisteredWorker(harness);
  const [entry] = plain(await harness.api.listOwnedCaptureTabsForRequest(REQUEST_ID));
  assert.equal(entry.tabId, workerId);
  assert.equal(entry.attemptId, A1);
  assert.equal(entry.role, "detail_worker");
  assert.ok(harness.sessionStore[OWNED_TABS_KEY].entries[workerId]);

  const register = (tabId, sender, sourceTabId = SOURCE_TAB) =>
    harness.sendBackgroundMessage(
      {type: "onstarvoice:record-owned-capture-tab", tabId, sourceTabId},
      sender,
    );
  // 重复登记：一个创建记录只能登记一次。
  const duplicate = await register(workerId, runnerSender(A1));
  assert.equal(duplicate.ok, false);
  // 不是 15 秒内新建的页（来源页）。
  assert.equal(
    (await register(SOURCE_TAB, runnerSender(A1))).reason,
    "creation_unverified",
  );
  // 手动采集的侧栏页没有 runner 参数。
  const manualTab = await harness.chrome.tabs.create({url: "about:blank", windowId: 1});
  assert.equal(
    (await register(manualTab.id, {
      documentId: "panel",
      url: `${EXTENSION_ORIGIN}/sidebar/sidebar.html`,
    })).reason,
    "not_unattended_runner",
  );
  // 创建时不是 about:blank。
  const platformTab = await harness.chrome.tabs.create({
    url: "https://www.xiaohongshu.com/explore/1",
    windowId: 1,
  });
  assert.equal(
    (await register(platformTab.id, runnerSender(A1))).reason,
    "creation_url_mismatch",
  );
  // 与 runner 报的来源页不在同一个窗口。
  const otherWindowTab = await harness.chrome.tabs.create({url: "about:blank", windowId: 2});
  assert.equal(
    (await register(otherWindowTab.id, runnerSender(A1))).reason,
    "window_mismatch",
  );
  // service worker 在创建与登记之间重启：内存里的创建记录已丢失。
  const lateTab = await harness.chrome.tabs.create({url: "about:blank", windowId: 1});
  const restarted = createHarness({state: harness.state});
  assert.equal(
    (await restarted.sendBackgroundMessage(
      {type: "onstarvoice:record-owned-capture-tab", tabId: lateTab.id, sourceTabId: SOURCE_TAB},
      runnerSender(A1),
    )).reason,
    "creation_unverified",
  );
  assert.equal(
    (await harness.api.listOwnedCaptureTabsForRequest(REQUEST_ID)).length,
    1,
  );
});

test("tabs.onRemoved drops a registered worker and tabs.onReplaced migrates it", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  const first = await createRegisteredWorker(harness);
  const second = await createRegisteredWorker(harness);
  for (const listener of harness.chrome.tabs.onReplaced.listeners) {
    listener(777, second);
  }
  await harness.api.flushOwnedTabs();
  await harness.chrome.tabs.remove(first);
  await harness.api.flushOwnedTabs();
  const entries = plain(await harness.api.listOwnedCaptureTabsForRequest(REQUEST_ID));
  assert.deepEqual(entries.map((entry) => entry.tabId), [777]);
});

test("a retirement receipt is recorded with the sender's own request, attempt and document", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  await retireRunner(harness, A1, {flushed: false, pendingUploads: 3});
  const receipt = plain(
    await harness.api.readUnattendedAttemptRetiredReceipt(REQUEST_ID, A1),
  );
  assert.equal(receipt.documentId, RUNNER_DOCUMENT);
  assert.equal(receipt.tabId, RUNNER_TAB);
  assert.equal(receipt.heartbeatStopped, true);
  assert.equal(receipt.flushed, false);
  assert.equal(receipt.pendingUploads, 3);
  assert.ok(harness.sessionStore[`${RETIRED_PREFIX}${REQUEST_ID}.${A1}`]);
  const refused = await harness.sendBackgroundMessage(
    {type: "onstarvoice:unattended-attempt-retired", heartbeatStopped: true},
    {documentId: "panel", url: `${EXTENSION_ORIGIN}/sidebar/sidebar.html`},
  );
  assert.equal(refused.ok, false);
});

// ==================== 锁标记 ====================

test("a self-stop mark survives renewal, never reloads through lock reads, and is dropped on transfer", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    allowReload: false,
    selfStopRequestId: REQUEST_ID,
    expiresAt: Date.now() - 1000,
  };
  const renewed = plain(await harness.api.renewCaptureExecutionLock({
    lockId: "lock-r",
    holderId: "runner-holder",
    holderDocumentId: RUNNER_DOCUMENT,
  }));
  assert.equal(renewed.ok, true);
  assert.equal(harness.storage[LOCK_KEY].allowReload, false);
  assert.equal(harness.storage[LOCK_KEY].selfStopRequestId, REQUEST_ID);

  // 租约过期、持有文档已不在：侧栏打开、手动批次、计划闹钟都会读锁。
  harness.storage[LOCK_KEY].expiresAt = Date.now() - 1000;
  harness.killDocument(RUNNER_DOCUMENT);
  harness.resetCallLog();
  const active = await harness.api.readActiveCaptureExecutionLock();
  const viaMessage = await harness.sendBackgroundMessage({
    type: "onstarvoice:get-capture-lock",
  });
  assert.equal(active.id, "lock-r", "the marked lock is kept while its page exists");
  assert.equal(viaMessage.data.id, "lock-r");
  assert.deepEqual(harness.forbiddenTabCalls.reload, []);
  assert.equal(
    harness.sentTabMessages.some(({payload}) => payload?.action === "cancelCapture"),
    false,
    "no cancel of any kind through lock reads",
  );
  // 持有页关掉之后才会被清理。
  await harness.chrome.tabs.remove(SOURCE_TAB);
  assert.equal(await harness.api.readActiveCaptureExecutionLock(), null);
  assert.equal(harness.storage[LOCK_KEY], undefined);

  // 转交给新的领取者时去掉标记。
  const transfer = createHarness();
  seedRunningRequest(transfer, {status: "pending", runnerTabId: 44});
  transfer.storage[LOCK_KEY] = {
    ...transfer.storage[LOCK_KEY],
    allowReload: false,
    selfStopRequestId: "another-request",
  };
  const claimed = plain(await transfer.api.claimUnattendedKeywordRun({
    requestId: REQUEST_ID,
    senderTabId: 44,
    senderDocumentId: "new-document",
    holderId: "new-holder",
  }));
  assert.equal(claimed.accepted, true, JSON.stringify(claimed));
  assert.equal(transfer.storage[LOCK_KEY].allowReload, undefined);
  assert.equal(transfer.storage[LOCK_KEY].selfStopRequestId, undefined);
});

// ==================== 恢复时自停（S2） ====================

test("a frozen registered worker is closed, the lock is released, the retired runner is closed after it and A2 starts without any reload", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  const worker = await createRegisteredWorker(harness);
  harness.patchTab(worker, {
    url: "https://www.xiaohongshu.com/explore/29",
    frozen: true,
  });
  await retireRunner(harness);
  harness.resetCallLog();

  const result = await recover(harness);

  assert.equal(result.deferred, true, JSON.stringify(result));
  assert.equal(result.reason, "recovery_wait");
  assert.equal(harness.tabs.has(worker), false, "the frozen worker was closed");
  assert.equal(harness.tabs.has(SOURCE_TAB), true, "the source page stays");
  // 退役回执已是最终回执：按精确身份删锁之后关掉这个旧 runner，不留到 R 结束。
  assert.equal(harness.tabs.has(RUNNER_TAB), false, "the retired runner is closed");
  assert.equal(harness.storage[LOCK_KEY], undefined, "lock released");
  const recovering = harness.storage[REQUEST_KEY];
  assert.equal(recovering.status, "recovering");
  assert.equal(recovering.previousAttemptId, A1);
  assert.deepEqual(recovering.recoverySelfStop.captureRequestIds, [CAPTURE_ID]);
  assert.deepEqual(recovering.recoverySelfStop.done.closedTabIds, [worker]);
  assert.equal(recovering.recoverySelfStop.done.runnersRetained, 1);
  assert.equal(recovering.recoverySelfStop.done.retiredRunnersClosed, 1);
  assert.equal(recovering.recoverySelfStop.done.runnerClosedWithoutReceipt, false);
  assert.equal(recovering.recoverySelfStop.done.lockReleased, true);
  assert.equal(recovering.progress.phase, "waiting_automatic_recovery");
  assert.equal(harness.api.isCaptureRequestAborted(CAPTURE_ID), true);
  assert.deepEqual(
    plain(await harness.api.listOwnedCaptureTabsForRequest(REQUEST_ID)),
    [],
  );
  assert.equal(runnerLaunches(harness).length, 0, "A2 waits for the recovery delay");
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [worker, RUNNER_TAB]});

  const launched = await superviseAfterWait(harness);
  assert.equal(launched.recovered, true, JSON.stringify(launched));
  const [runner] = runnerLaunches(harness);
  assert.match(runner.url, new RegExp(`unattendedAttempt=${recovering.attemptId}`));
  assert.deepEqual(harness.forbiddenTabCalls.reload, []);

  // 自停之后，旧采集 id 的中继（暂时错误或停滞刷新）直接返回“已中止”，
  // 不会把 A1 的采集再发进任何文档。
  harness.resetCallLog();
  const replay = plain(await harness.api.relay(SOURCE_TAB, {
    action: "captureComments",
    captureRequestId: CAPTURE_ID,
  }));
  assert.equal(replay.data.stopReason, "canceled");
  assert.equal(
    harness.sentTabMessages.some(({payload}) => payload?.action === "captureComments"),
    false,
  );
});

test("the source page is never closed or reloaded: a capture that keeps running ends in needs_action with its reason", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  harness.content(SOURCE_TAB).active.set(CAPTURE_ID, 1);
  harness.content(SOURCE_TAB).cancel = "ignore";
  await retireRunner(harness);
  harness.resetCallLog();

  const first = await recover(harness);
  assert.equal(first.deferred, true, JSON.stringify(first));
  assert.equal(first.reason, "recovery_self_stop_pending");
  assert.equal(first.selfStopReason, "capture_still_active");
  let current = harness.storage[REQUEST_KEY];
  const transitionProgressAt = current.businessProgressAt;
  assert.equal(current.status, "recovering");
  assert.equal(current.progress.phase, "recovery_self_stop");
  assert.match(current.progress.message, /正在确认旧采集页面已停止（第 1\/5 次）/u);
  assert.equal(current.recoverySelfStop.tries, 1);
  assert.equal(current.recoverySelfStop.lastReason, "capture_still_active");
  assert.equal(harness.storage[LOCK_KEY].allowReload, false);
  assert.equal(harness.storage[LOCK_KEY].selfStopRequestId, REQUEST_ID);
  assert.ok(
    harness.sentTabMessages.some(
      ({tabId, payload}) =>
        tabId === SOURCE_TAB &&
        payload?.action === "cancelCapture" &&
        payload.captureRequestId === CAPTURE_ID,
    ),
    "a request-scoped cancel was sent",
  );

  let last = first;
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    const before = harness.storage[REQUEST_KEY];
    last = await superviseAfterWait(harness);
    current = harness.storage[REQUEST_KEY];
    if (attempt < 5) {
      assert.equal(current.status, "recovering", `attempt ${attempt}`);
      assert.equal(current.recoverySelfStop.tries, attempt);
      // 每次尝试都刷新心跳；业务时钟不动。
      assert.ok(current.progressSeq >= before.progressSeq + 2);
      assert.ok(Date.parse(current.heartbeatAt) >= Date.parse(before.heartbeatAt));
      assert.equal(current.businessProgressAt, transitionProgressAt);
      assert.equal(current.progress.phase, "recovery_self_stop");
    }
  }
  assert.equal(last.reason, "previous_capture_stop_unconfirmed");
  assert.equal(current.status, "needs_action");
  assert.equal(current.error.code, "PREVIOUS_CAPTURE_STOP_UNCONFIRMED");
  assert.equal(current.error.reason, "self_stop:capture_still_active");
  assert.equal(current.stopFenceEvidence.failedTabId, SOURCE_TAB);
  assert.equal(harness.tabs.has(SOURCE_TAB), true);
  assert.equal(runnerLaunches(harness).length, 0, "A2 never started");
  assert.equal(harness.storage[LOCK_KEY].allowReload, false);
  assertSelfStopSafety(harness);

  // 之后租约过期、持有文档消失：侧栏、手动批次、计划闹钟读锁都不会刷新来源页。
  harness.storage[LOCK_KEY].expiresAt = Date.now() - 1000;
  harness.killDocument(RUNNER_DOCUMENT);
  harness.resetCallLog();
  assert.equal((await harness.api.readActiveCaptureExecutionLock()).id, "lock-r");
  assert.deepEqual(harness.forbiddenTabCalls.reload, []);
  assert.equal(
    harness.sentTabMessages.some(({payload}) => payload?.action === "cancelCapture"),
    false,
  );
});

test("a frozen platform page is discarded (never closed or reloaded) and then counts as proof; an active one is left alone", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  harness.addTab({
    id: 25,
    url: "https://www.xiaohongshu.com/explore/user-tab",
    frozen: true,
  });
  await retireRunner(harness);
  harness.resetCallLog();

  const result = await recover(harness);

  assert.equal(result.reason, "recovery_wait", JSON.stringify(result));
  assert.equal(harness.tabs.has(25), true, "the frozen page stays in the tab strip");
  assert.equal(harness.tabs.get(25).discarded, true);
  const done = harness.storage[REQUEST_KEY].recoverySelfStop.done;
  assert.deepEqual(done.discardedTabIds, [25]);
  assert.equal(
    done.targets.find((target) => target.tabId === 25).evidence,
    "tab_discarded",
  );
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assertSelfStopSafety(harness, {
    allowedRemovedTabIds: [RUNNER_TAB],
    allowedDiscardedTabIds: [25],
  });

  // Chrome 不丢弃活动页：活动的冻结页（理论上不会出现）仍然不成立，也不被关。
  const active = createHarness();
  seedRunningRequest(active);
  active.addTab({
    id: 25,
    url: "https://www.xiaohongshu.com/explore/user-tab",
    frozen: true,
    active: true,
  });
  await retireRunner(active);
  active.resetCallLog();
  const blocked = await recover(active);
  assert.equal(blocked.reason, "recovery_self_stop_pending");
  assert.equal(blocked.selfStopReason, "tab_frozen");
  assert.equal(active.tabs.get(25).discarded, false);
  assert.deepEqual(active.forbiddenTabCalls.discard, []);
  assert.equal(active.storage[LOCK_KEY].id, "lock-r");
  assertSelfStopSafety(active);
});

test("R's own frozen or hung source page is discarded (never reloaded or closed), then proven, and A2 starts", async () => {
  for (const variant of ["frozen", "hung"]) {
    const harness = createHarness();
    seedRunningRequest(harness);
    if (variant === "frozen") harness.patchTab(SOURCE_TAB, {frozen: true});
    else harness.setDocument(SOURCE_TAB, {hang: true});
    await retireRunner(harness);
    harness.resetCallLog();

    const result = await recover(harness);

    assert.equal(result.reason, "recovery_wait", `${variant}: ${JSON.stringify(result)}`);
    assert.equal(harness.tabs.has(SOURCE_TAB), true, `${variant}: the source page stays`);
    assert.equal(harness.tabs.get(SOURCE_TAB).discarded, true, variant);
    const done = harness.storage[REQUEST_KEY].recoverySelfStop.done;
    assert.deepEqual(done.discardedTabIds, [SOURCE_TAB], variant);
    assert.equal(harness.storage[LOCK_KEY], undefined, variant);
    assertSelfStopSafety(harness, {
      allowedRemovedTabIds: [RUNNER_TAB],
      allowedDiscardedTabIds: [SOURCE_TAB],
    });
    const launched = await superviseAfterWait(harness);
    assert.equal(launched.recovered, true, `${variant}: ${JSON.stringify(launched)}`);
    assert.equal(runnerLaunches(harness).length, 1, variant);
  }
});

test("a hung source page that is the active tab, or a hung page not attributed to R, is never discarded", async () => {
  const active = createHarness();
  seedRunningRequest(active);
  active.patchTab(SOURCE_TAB, {active: true});
  active.setDocument(SOURCE_TAB, {hang: true});
  await retireRunner(active);
  active.resetCallLog();
  const blocked = await recover(active);
  assert.equal(blocked.reason, "recovery_self_stop_pending");
  assert.equal(blocked.selfStopReason, "probe_failed");
  assert.deepEqual(active.forbiddenTabCalls.discard, []);
  assert.equal(active.storage[LOCK_KEY].id, "lock-r");
  assertSelfStopSafety(active);

  const unrelated = createHarness();
  seedRunningRequest(unrelated);
  unrelated.addTab({
    id: 27,
    url: "https://www.douyin.com/search/other",
    timeOrigin: freshDocument(),
  });
  unrelated.setDocument(27, {hang: true});
  await retireRunner(unrelated);
  unrelated.resetCallLog();
  const failing = await recover(unrelated);
  assert.equal(failing.selfStopReason, "probe_failed");
  assert.deepEqual(unrelated.forbiddenTabCalls.discard, []);
  assert.equal(unrelated.tabs.get(27).discarded, false);
  assertSelfStopSafety(unrelated);
  // 用尽后写围栏：未归属的页只作为 failedTabId 留下，不记成围栏目标（节点
  // 核对会把围栏目标当作 R 的页）。
  let last = failing;
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    last = await superviseAfterWait(unrelated);
  }
  assert.equal(last.reason, "previous_capture_stop_unconfirmed", JSON.stringify(last));
  const evidence = unrelated.storage[REQUEST_KEY].stopFenceEvidence;
  assert.equal(evidence.failedTabId, 27);
  assert.equal(
    evidence.targets.some((target) => target.tabId === 27),
    false,
    JSON.stringify(evidence.targets),
  );
  assert.ok(evidence.targets.some((target) => target.tabId === SOURCE_TAB));
});

test("a registered worker the user took elsewhere is forgotten, and one the user is looking at is not closed", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  const navigated = await createRegisteredWorker(harness);
  harness.patchTab(navigated, {url: "https://example.com/reading"});
  const watched = await createRegisteredWorker(harness);
  harness.patchTab(watched, {
    url: "https://www.xiaohongshu.com/explore/watched",
    active: true,
    lastAccessed: Date.now() - 10 * 1000,
  });
  harness.state.windowFocus.set(1, true);
  harness.setDocument(watched, {timeOrigin: freshDocument()});
  harness.state.contents.set(watched, {
    receiver: true,
    hang: false,
    cancel: "settle",
    active: new Map(),
  });
  await retireRunner(harness);
  harness.resetCallLog();

  const result = await recover(harness);

  assert.equal(harness.tabs.has(navigated), true, "a navigated-away page is not closed");
  assert.equal(harness.tabs.has(watched), true, "a page the user is looking at is not closed");
  const remaining = plain(await harness.api.listOwnedCaptureTabsForRequest(REQUEST_ID));
  assert.deepEqual(remaining.map((entry) => entry.tabId), [watched]);
  // 用户在看的那页内容空闲，本身就是证明；这次自停成立。
  assert.equal(result.reason, "recovery_wait", JSON.stringify(result));
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});
});

test("before BEGIN the lock holder is A1's runner page: its receipt proves it retired, the lock is released and then the runner is closed", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    holderTabId: RUNNER_TAB,
    captureTaskId: "",
    captureTaskAttemptId: "",
  };
  await retireRunner(harness);
  harness.resetCallLog();

  const result = await recover(harness);

  assert.equal(result.reason, "recovery_wait", JSON.stringify(result));
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.equal(harness.tabs.has(RUNNER_TAB), false);
  const done = harness.storage[REQUEST_KEY].recoverySelfStop.done;
  assert.equal(done.runnerClosed, false, "not closed as an unretired runner");
  assert.equal(done.retiredRunnersClosed, 1);
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});
});

test("a stuck runner without a receipt is closed only on the second attempt, inside the lock operation", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  harness.addTab({
    id: 33,
    url: runnerUrl("another-request", "attempt-x"),
    documentId: "another-runner-document",
  });
  harness.resetCallLog();

  const first = await recover(harness);
  assert.equal(first.reason, "recovery_self_stop_pending");
  assert.equal(first.selfStopReason, "runner_not_retired");
  assert.equal(harness.tabs.has(RUNNER_TAB), true, "not closed on the first attempt");
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");

  const second = await superviseAfterWait(harness);
  assert.equal(harness.tabs.has(RUNNER_TAB), false, "closed on the second attempt");
  assert.equal(harness.storage[LOCK_KEY], undefined);
  const done = harness.storage[REQUEST_KEY].recoverySelfStop.done;
  assert.equal(done.runnerClosed, true);
  assert.equal(done.runnerClosedWithoutReceipt, true);
  assert.equal(done.tries, 2);
  assert.equal(harness.tabs.has(33), true, "another request's runner is untouched");
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});
  // 第二次尝试把重试等待推后了 60 秒；到点后启动 A2。
  if (second.recovered !== true) {
    assert.equal(second.reason, "recovery_wait", JSON.stringify(second));
    const launched = await superviseAfterWait(harness);
    assert.equal(launched.recovered, true, JSON.stringify(launched));
  }
  assert.equal(runnerLaunches(harness).length, 1);
});

test("a runner that reports the new attempt means the request changed: nothing is closed", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  await retireRunner(harness);
  const first = await recover(harness);
  assert.equal(first.reason, "recovery_wait");
  // 已证明、正在等待；再造一个（异常的）新轮次 runner 页和一把新锁。
  const recovering = harness.storage[REQUEST_KEY];
  const again = createHarness({state: harness.state});
  again.storage[REQUEST_KEY] = {
    ...recovering,
    recoverySelfStop: {...recovering.recoverySelfStop, done: null, tries: 1},
  };
  again.addTab({id: 34, url: runnerUrl(REQUEST_ID, recovering.attemptId)});
  again.resetCallLog();
  const result = await superviseAfterWait(again);
  assert.equal(result.reason, "recovery_self_stop_pending");
  assert.equal(result.selfStopReason, "request_changed");
  assert.equal(again.tabs.has(34), true);
  assertSelfStopSafety(again);
});

test("after a service worker restart the intent re-marks aborts and exactly one replacement starts", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  harness.content(SOURCE_TAB).active.set(CAPTURE_ID, 1);
  harness.content(SOURCE_TAB).cancel = "ignore";
  await retireRunner(harness);
  const first = await recover(harness);
  assert.equal(first.selfStopReason, "capture_still_active");

  const restarted = createHarness({state: harness.state});
  assert.equal(restarted.api.isCaptureRequestAborted(CAPTURE_ID), false);
  restarted.content(SOURCE_TAB).cancel = "settle";
  const proved = await superviseAfterWait(restarted);
  // 证明成立后回到换代时定下的恢复间隔，到点再启动 A2。
  assert.equal(proved.reason, "recovery_wait", JSON.stringify(proved));
  assert.equal(
    restarted.storage[REQUEST_KEY].message,
    "旧采集页面已确认停止，自动恢复将在倒计时结束后开始",
  );
  assert.equal(runnerLaunches(restarted).length, 0);
  const launched = await superviseAfterWait(restarted);

  assert.equal(launched.recovered, true, JSON.stringify(launched));
  assert.equal(restarted.api.isCaptureRequestAborted(CAPTURE_ID), true);
  assert.equal(restarted.storage[LOCK_KEY], undefined);
  assert.equal(runnerLaunches(restarted).length, 1);
  const again = await restarted.api.superviseUnattendedKeywordRun();
  assert.notEqual(plain(again)?.recovered, true);
  assert.equal(runnerLaunches(restarted).length, 1, "never two runners");
  assertSelfStopSafety(restarted, {allowedRemovedTabIds: [RUNNER_TAB]});
});

test("a terminal transition asks its runner to retire, self-stops once and never writes a fence", async () => {
  const blocked = {
    code: "SECURITY_VERIFICATION_REQUIRED",
    message: "小红书安全验证",
    securityBlocked: true,
    requiresManualAction: true,
  };
  // 旧 runner 已不在：一次自停成立，锁与资源释放。
  const released = createHarness();
  seedRunningRequest(released, {error: blocked});
  released.tabs.delete(RUNNER_TAB);
  released.killDocument(RUNNER_DOCUMENT);
  const done = await recover(released);
  assert.equal(done.terminal, true);
  assert.equal(done.reason, undefined);
  assert.equal(released.storage[REQUEST_KEY].status, "needs_action");
  assert.equal(released.storage[REQUEST_KEY].error.code, "SECURITY_VERIFICATION_REQUIRED");
  assert.equal(released.storage[REQUEST_KEY].runnerRetireAttemptId, A1);
  assert.equal(released.storage[REQUEST_KEY].stopFenceEvidence, undefined);
  assert.equal(released.storage[LOCK_KEY], undefined);
  assertSelfStopSafety(released);

  // runner 还活着、看到退役请求后退役：持有文档有回执，锁按精确身份释放，
  // 之后关掉这个已退役的 runner。
  const retiring = createHarness();
  seedRunningRequest(retiring, {error: blocked});
  retireRunnerOnTerminalMarker(retiring);
  retiring.resetCallLog();
  const retired = await recover(retiring);
  assert.equal(retired.terminal, true);
  assert.equal(retired.reason, undefined, JSON.stringify(retired));
  assert.equal(retiring.storage[LOCK_KEY], undefined);
  assert.equal(retiring.tabs.has(RUNNER_TAB), false);
  const receipt = plain(
    await retiring.api.readUnattendedAttemptRetiredReceipt(REQUEST_ID, A1),
  );
  assert.equal(receipt.reason, "request_terminal");
  assert.equal(retiring.storage[REQUEST_KEY].stopFenceEvidence, undefined);
  assertSelfStopSafety(retiring, {allowedRemovedTabIds: [RUNNER_TAB]});

  // runner 卡死、始终不退役（第 5 次卡住，交回云端）：限时等待后，在证明之后
  // 的锁操作里关掉它并释放锁；终态请求照旧，不写围栏。
  const stuck = createHarness();
  seedRunningRequest(stuck, {recoveryCount: 4});
  stuck.resetCallLog();
  const closed = await recover(stuck);
  assert.equal(closed.terminal, true);
  assert.equal(closed.reason, undefined, JSON.stringify(closed));
  const failed = stuck.storage[REQUEST_KEY];
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "UNATTENDED_RECOVERY_EXHAUSTED");
  assert.equal(failed.stopFenceEvidence, undefined);
  assert.equal(stuck.tabs.has(RUNNER_TAB), false);
  assert.equal(stuck.storage[LOCK_KEY], undefined, "the node is free again");
  assertSelfStopSafety(stuck, {allowedRemovedTabIds: [RUNNER_TAB]});
  // 之后没有东西能挡住定向单帖、云端指令与手动批次。
  assert.equal(await stuck.api.readActiveCaptureExecutionLock(), null);
});

test("a terminal self-stop that cannot prove keeps the marked lock (never reloads) and the supervisor retries it every 3 minutes", async () => {
  const harness = createHarness();
  seedRunningRequest(harness, {recoveryCount: 4});
  harness.content(SOURCE_TAB).active.set(CAPTURE_ID, 1);
  harness.content(SOURCE_TAB).cancel = "ignore";
  retireRunnerOnTerminalMarker(harness);
  harness.resetCallLog();

  const first = await recover(harness);
  assert.equal(first.terminal, true);
  assert.equal(first.reason, "previous_capture_stop_unconfirmed");
  assert.equal(first.selfStopReason, "capture_still_active");
  assert.equal(harness.storage[REQUEST_KEY].status, "failed");
  assert.equal(harness.storage[REQUEST_KEY].stopFenceEvidence, undefined);
  assert.equal(harness.storage[LOCK_KEY].allowReload, false);
  assert.equal(harness.storage[LOCK_KEY].selfStopRequestId, REQUEST_ID);
  assertSelfStopSafety(harness);
  // 退役的 runner 停了锁心跳：租约过期、读锁也不刷新来源页。
  harness.storage[LOCK_KEY].expiresAt = Date.now() - 1000;
  harness.resetCallLog();
  assert.equal((await harness.api.readActiveCaptureExecutionLock()).id, "lock-r");
  assert.deepEqual(harness.forbiddenTabCalls.reload, []);
  harness.resetCallLog();

  // 监督闹钟补试：仍不成立，锁留着；3 分钟内不再试。
  const retry = plain(await harness.api.superviseUnattendedKeywordRun());
  assert.equal(retry.terminalSelfStop.retried, true, JSON.stringify(retry));
  assert.equal(retry.terminalSelfStop.reason, "capture_still_active");
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  const throttled = plain(await harness.api.superviseUnattendedKeywordRun());
  assert.equal(throttled.terminalSelfStop.reason, "terminal_self_stop_retry_wait");

  // 来源页的采集停下来之后，下一次补试证明成立：释放锁、关掉已退役的 runner。
  harness.content(SOURCE_TAB).cancel = "settle";
  harness.sessionStore["onstarvoice.terminalSelfStopRetry.v1"].at =
    Date.now() - 4 * 60 * 1000;
  const proved = plain(await harness.api.superviseUnattendedKeywordRun());
  assert.equal(proved.terminalSelfStop.ok, true, JSON.stringify(proved));
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.equal(harness.tabs.has(RUNNER_TAB), false);
  assert.equal(harness.storage[REQUEST_KEY].status, "failed");
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});

  // 锁已不在：之后的监督闹钟什么都不做。
  const idle = plain(await harness.api.superviseUnattendedKeywordRun());
  assert.equal(idle.terminalSelfStop, undefined);
});

test("a fenced needs_action is left to the node check: the supervisor never retries it as a terminal self-stop", async () => {
  const harness = createHarness();
  seedRunningRequest(harness, {
    status: "needs_action",
    error: {code: "PREVIOUS_CAPTURE_STOP_UNCONFIRMED", message: "旧采集页面未能安全停止"},
  });
  harness.storage[LOCK_KEY] = {
    ...harness.storage[LOCK_KEY],
    allowReload: false,
    selfStopRequestId: REQUEST_ID,
  };
  harness.resetCallLog();
  const result = plain(await harness.api.superviseUnattendedKeywordRun());
  assert.equal(result.terminalSelfStop, undefined);
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assert.deepEqual(harness.sentTabMessages, []);
  assertSelfStopSafety(harness);
});

test("the launch-time stop point self-stops once and keeps its paused message with a reason", async () => {
  const seedPending = (harness) => {
    seedRunningRequest(harness, {
      status: "recovering",
      recoveryPendingLaunch: true,
      recoveryWaitUntil: new Date(Date.now() - 1000).toISOString(),
      recoveryReason: "manual_recovery_unused",
      runnerTabId: null,
    });
    harness.tabs.delete(RUNNER_TAB);
    harness.killDocument(RUNNER_DOCUMENT);
  };
  const failing = createHarness();
  seedPending(failing);
  failing.content(SOURCE_TAB).active.set(CAPTURE_ID, 1);
  failing.content(SOURCE_TAB).cancel = "ignore";
  const paused = plain(
    await failing.api.launchPendingUnattendedRecovery(failing.storage[REQUEST_KEY]),
  );
  assert.equal(paused.reason, "previous_capture_stop_unconfirmed");
  const stored = failing.storage[REQUEST_KEY];
  assert.equal(stored.status, "needs_action");
  assert.equal(
    stored.message,
    "旧采集页面未能安全停止，本次恢复已暂停；请人工检查页面后从任务中心重试",
  );
  assert.equal(stored.error.reason, "self_stop:capture_still_active");
  assert.equal(runnerLaunches(failing).length, 0);
  assertSelfStopSafety(failing);

  const passing = createHarness();
  seedPending(passing);
  const launched = plain(
    await passing.api.launchPendingUnattendedRecovery(passing.storage[REQUEST_KEY]),
  );
  assert.equal(launched.recovered, true, JSON.stringify(launched));
  assert.equal(passing.storage[LOCK_KEY], undefined);
  assert.equal(runnerLaunches(passing).length, 1);
  assertSelfStopSafety(passing);
});

test("manual 继续 after an exhausted self-stop: the new request inherits no intent, the old request's retired runner is recognized by its own receipt, and exactly one runner starts", async () => {
  const harness = createHarness();
  seedRunningRequest(harness, {cloudAssigned: false});
  harness.content(SOURCE_TAB).active.set(CAPTURE_ID, 1);
  harness.content(SOURCE_TAB).cancel = "ignore";
  await retireRunner(harness);
  await recover(harness);
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    await superviseAfterWait(harness);
  }
  const fenced = harness.storage[REQUEST_KEY];
  assert.equal(fenced.status, "needs_action");
  assert.equal(fenced.error.reason, "self_stop:capture_still_active");
  assert.equal(harness.storage[LOCK_KEY].holderDocumentId, RUNNER_DOCUMENT);
  assert.ok(harness.tabs.has(RUNNER_TAB), "the retired A1 runner is still open");

  // 来源页的采集后来停了；用户点「继续」（新请求 id）。
  harness.content(SOURCE_TAB).active.clear();
  harness.content(SOURCE_TAB).cancel = "settle";
  harness.resetCallLog();
  const result = plain(await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: REQUEST_ID,
    mode: "remaining",
  }));
  await harness.api.flushUnattended();

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.reason, "recovered");
  const slot = harness.storage[REQUEST_KEY];
  assert.notEqual(slot.id, REQUEST_ID);
  assert.equal(slot.parentRequestId, REQUEST_ID);
  assert.equal(slot.recoverySelfStop, undefined, "no inherited self-stop intent");
  assert.equal(harness.storage[LOCK_KEY], undefined, "the old lock was released");
  assert.equal(harness.tabs.has(RUNNER_TAB), false, "the old retired runner was closed");
  assert.equal(runnerLaunches(harness).length, 1);
  assert.match(runnerLaunches(harness)[0].url, new RegExp(`unattendedRun=${slot.id}`));
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});
});

test("a second 继续 still recognizes the first request's retired runner after the first 继续 re-marked the lock", async () => {
  const harness = createHarness();
  seedRunningRequest(harness, {cloudAssigned: false});
  harness.content(SOURCE_TAB).active.set(CAPTURE_ID, 1);
  harness.content(SOURCE_TAB).cancel = "ignore";
  await retireRunner(harness);
  await recover(harness);
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    await superviseAfterWait(harness);
  }
  assert.equal(harness.storage[REQUEST_KEY].status, "needs_action");

  // 第一次「继续」时来源页的采集还没停：新请求暂停，锁被它重新打了标记。
  const first = plain(await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: REQUEST_ID,
    mode: "remaining",
  }));
  await harness.api.flushUnattended();
  const firstRequest = harness.storage[REQUEST_KEY];
  assert.notEqual(firstRequest.id, REQUEST_ID, JSON.stringify(first));
  assert.equal(firstRequest.status, "needs_action");
  assert.equal(firstRequest.error.reason, "self_stop:capture_still_active");
  assert.equal(harness.storage[LOCK_KEY].selfStopRequestId, firstRequest.id);
  assert.equal(harness.storage[LOCK_KEY].captureTaskId, TASK_KEY);
  assert.ok(harness.tabs.has(RUNNER_TAB));

  // 采集停了之后第二次「继续」：锁的绑定属于最初的请求、标记属于第一次继续。
  harness.content(SOURCE_TAB).active.clear();
  harness.content(SOURCE_TAB).cancel = "settle";
  harness.resetCallLog();
  const second = plain(await harness.api.manuallyRecoverUnattendedKeywordRun({
    requestId: firstRequest.id,
    mode: "remaining",
  }));
  await harness.api.flushUnattended();

  assert.equal(second.accepted, true, JSON.stringify(second));
  assert.equal(second.reason, "recovered");
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.equal(harness.tabs.has(RUNNER_TAB), false);
  assert.equal(runnerLaunches(harness).length, 1);
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});
});

test("the launch-time stop closes an unretired runner of the request it was derived from after a bounded wait; other requests' runners are untouched", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  const newRequestId = "manual-new-request";
  harness.storage[REQUEST_KEY] = {
    ...harness.storage[REQUEST_KEY],
    id: newRequestId,
    parentRequestId: REQUEST_ID,
    attemptId: "attempt-new",
    status: "recovering",
    recoveryPendingLaunch: true,
    recoveryWaitUntil: "",
    recoveryReason: "manual_recovery",
    runnerTabId: null,
    progress: null,
    error: null,
  };
  harness.addTab({
    id: 33,
    url: runnerUrl("another-request", "attempt-x"),
    documentId: "another-runner-document",
  });
  harness.resetCallLog();

  const launch = plain(
    await harness.api.launchPendingUnattendedRecovery(harness.storage[REQUEST_KEY]),
  );
  await harness.api.flushUnattended();

  assert.equal(launch.recovered, true, JSON.stringify(launch));
  assert.equal(harness.tabs.has(RUNNER_TAB), false, "the derived-from request's stuck runner was closed");
  assert.equal(harness.tabs.has(33), true, "another request's runner is untouched");
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.equal(runnerLaunches(harness).length, 1);
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});
});

// ==================== 节点核对里关登记过的工作页（S2'） ====================

function seedFencedForCheck(harness) {
  seedRunningRequest(harness, {
    status: "needs_action",
    attemptId: "attempt-2",
    previousAttemptId: A1,
    attemptNumber: 2,
    recoveryCount: 1,
    runnerTabId: null,
    error: {code: "PREVIOUS_CAPTURE_STOP_UNCONFIRMED", message: "旧采集页面未能安全停止"},
  });
  harness.tabs.delete(RUNNER_TAB);
  harness.killDocument(RUNNER_DOCUMENT);
}

function buildOffer() {
  return {
    version: 1,
    mode: "check",
    checkId: "check-1",
    taskId: "11111111-2222-4333-8444-555555555555",
    requestId: REQUEST_ID,
    attemptId: "attempt-2",
    platform: "xiaohongshu",
    fencedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

test("S2': a node check closes a frozen worker registered to R and then proves the stop", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  const worker = await createRegisteredWorker(harness);
  seedFencedForCheck(harness);
  harness.patchTab(worker, {
    url: "https://www.xiaohongshu.com/explore/frozen",
    frozen: true,
  });
  harness.resetCallLog();

  const result = plain(
    await harness.api.confirmPreviousUnattendedStopForFenceCheck(buildOffer()),
  );

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.targets.find((target) => target.tabId === worker)?.evidence, "tab_closed");
  assert.equal(harness.tabs.has(worker), false);
  assert.equal(harness.tabs.has(SOURCE_TAB), true);
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [worker]});
});

test("S2': an unregistered frozen page is discarded (not closed) and a failing source page is never closed", async () => {
  const unregistered = createHarness();
  seedFencedForCheck(unregistered);
  unregistered.addTab({
    id: 26,
    url: "https://www.xiaohongshu.com/explore/unregistered",
    frozen: true,
  });
  unregistered.resetCallLog();
  const frozen = plain(
    await unregistered.api.confirmPreviousUnattendedStopForFenceCheck(buildOffer()),
  );
  assert.equal(frozen.accepted, true, JSON.stringify(frozen));
  assert.equal(
    frozen.targets.find((target) => target.tabId === 26)?.evidence,
    "tab_discarded",
  );
  assert.equal(unregistered.tabs.has(26), true, "discarded, never closed");
  assertSelfStopSafety(unregistered, {allowedDiscardedTabIds: [26]});

  const source = createHarness();
  seedRunningRequest(source);
  const worker = await createRegisteredWorker(source);
  seedFencedForCheck(source);
  source.patchTab(worker, {url: "https://www.xiaohongshu.com/explore/w", frozen: true});
  source.content(SOURCE_TAB).active.set("unknown-capture", 1);
  const mixed = plain(
    await source.api.confirmPreviousUnattendedStopForFenceCheck(buildOffer()),
  );
  assert.equal(mixed.accepted, false);
  assert.equal(mixed.reason, "tab_busy_unattributed");
  assert.equal(source.tabs.has(worker), true, "not every failing page is a registered worker");
  assert.equal(source.tabs.has(SOURCE_TAB), true);
  assert.equal(source.tabs.get(SOURCE_TAB).discarded, false, "a live page is never discarded");
  // 冻结的工作页被丢弃（不是关闭）；应答中的来源页不动。
  assertSelfStopSafety(source, {allowedDiscardedTabIds: [worker]});
});

test("self-stop retries on a one-minute cadence while the replacement keeps its recovery delay", async () => {
  const harness = createHarness();
  // 第 4 次自动恢复：恢复间隔 10 分钟。
  seedRunningRequest(harness, {recoveryCount: 3});
  harness.content(SOURCE_TAB).active.set(CAPTURE_ID, 1);
  harness.content(SOURCE_TAB).cancel = "ignore";
  await retireRunner(harness);

  const startedAt = Date.now();
  const first = await recover(harness);
  assert.equal(first.reason, "recovery_self_stop_pending");
  const pending = harness.storage[REQUEST_KEY];
  const retryAt = Date.parse(pending.recoveryWaitUntil) - startedAt;
  const launchAt = Date.parse(pending.recoverySelfStop.launchNotBefore) - startedAt;
  assert.ok(retryAt > 50 * 1000 && retryAt < 70 * 1000, `retry in ~1 minute (${retryAt})`);
  assert.ok(launchAt > 9 * 60 * 1000, `launch keeps the 10-minute delay (${launchAt})`);

  harness.content(SOURCE_TAB).cancel = "settle";
  const proved = await superviseAfterWait(harness);
  assert.equal(proved.reason, "recovery_wait", JSON.stringify(proved));
  assert.equal(
    harness.storage[REQUEST_KEY].recoveryWaitUntil,
    new Date(Date.parse(pending.recoverySelfStop.launchNotBefore)).toISOString(),
  );
  assert.equal(runnerLaunches(harness).length, 0);
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});
});

test("a runner still flushing after retirement is kept open by its early receipt and closed by its final one", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  await retireRunner(harness, A1, {flushing: true, flushed: false, pendingUploads: 2});
  const result = await recover(harness);
  assert.equal(result.reason, "recovery_wait", JSON.stringify(result));
  assert.equal(harness.tabs.has(RUNNER_TAB), true);
  const done = harness.storage[REQUEST_KEY].recoverySelfStop.done;
  assert.equal(done.runnersRetained, 1);
  assert.equal(done.retiredRunnersClosed, 0);
  assert.equal(done.pendingUploads, 2);
  const receipt = plain(
    await harness.api.readUnattendedAttemptRetiredReceipt(REQUEST_ID, A1),
  );
  assert.equal(receipt.flushing, true);

  // 冲刷结束，最终回执到达：锁已释放、它的轮次已不是当前轮次，关掉它。
  harness.resetCallLog();
  await retireRunner(harness, A1, {flushed: true, pendingUploads: 0});
  await waitFor(() => !harness.tabs.has(RUNNER_TAB));
  assert.equal(harness.tabs.has(SOURCE_TAB), true);
  assertSelfStopSafety(harness, {allowedRemovedTabIds: [RUNNER_TAB]});
});

test("a final receipt never closes the lock holder or the runner of the current attempt", async () => {
  // 锁仍由这个 runner 的文档持有：留给自停第 5 步（删锁后再关）。
  const holder = createHarness();
  seedRunningRequest(holder, {
    status: "recovering",
    attemptId: "attempt-2",
    previousAttemptId: A1,
    recoveryPendingLaunch: true,
    runnerTabId: null,
  });
  await retireRunner(holder, A1, {flushed: true});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(holder.tabs.has(RUNNER_TAB), true);

  // 请求槽里仍是这一轮、非终态（不会发生，防御）：不关。
  const current = createHarness();
  seedRunningRequest(current);
  delete current.storage[LOCK_KEY];
  await retireRunner(current, A1, {flushed: true});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(current.tabs.has(RUNNER_TAB), true);
  assert.deepEqual(current.removedTabIds, []);
});

test("another rotation before the self-stop proves keeps the older attempt in scope", async () => {
  const harness = createHarness();
  seedRunningRequest(harness);
  harness.content(SOURCE_TAB).active.set(CAPTURE_ID, 1);
  harness.content(SOURCE_TAB).cancel = "ignore";
  const first = await recover(harness);
  assert.equal(first.reason, "recovery_self_stop_pending");
  const a2 = harness.storage[REQUEST_KEY].attemptId;

  // 等待期间又触发一次恢复（A2 → A3）：A1 仍在旧轮次之列，采集 id 继续被中止。
  const second = await recover(harness, "source_tab_removed");
  const intent = harness.storage[REQUEST_KEY].recoverySelfStop;
  assert.equal(intent.fromAttemptId, a2);
  assert.deepEqual(intent.olderAttemptIds, [A1]);
  assert.deepEqual(intent.captureRequestIds, [CAPTURE_ID]);
  assert.equal(second.reason, "recovery_self_stop_pending");
  // A1 的 runner 仍按旧轮次处理（不是 request_changed）。
  assert.equal(second.selfStopReason, "capture_still_active");
  assertSelfStopSafety(harness);
});
