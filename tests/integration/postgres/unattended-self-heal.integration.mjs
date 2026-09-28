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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const testFileKeepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(testFileKeepAlive));

const read = (path) => readFile(resolve(repoRoot, path), "utf8");
const backgroundSource = await read("background.js");
const contentSource = await read("content-v2.js");
const supportSources = await Promise.all(
  [
    "utils/task-center.js",
    "utils/cloud-task-agent.js",
    "utils/cloud-targeted-post.js",
    "utils/control-storage-reserve.js",
    "utils/manual-keyword-dispatch.js",
    "utils/runtime-tab-policy.js",
    "utils/retired-runner-cleanup.js",
    "utils/task-home-cleanup.js",
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

let REQUEST_ID = "self-stop-request";
let TASK_KEY = `unattended-capture:${REQUEST_ID}`;
let A1 = "attempt-1";
function setIdentity(requestId, attemptId) { REQUEST_ID = requestId; TASK_KEY = `unattended-capture:${requestId}`; A1 = attemptId; }
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
function createHarness({state = null, productionTiming = false} = {}) {
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
    onLocalSet: [],
    pendingByTab: new Map(),
    resolveByTab: new Map(),
    activations: [],
    discarded: [],
    discardReplacesId: false,
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
      const copy = JSON.parse(JSON.stringify(values));
      Object.assign(storage, copy);
      for (const listener of shared.onLocalSet || []) {
        setTimeout(() => listener(copy), 0);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete storage[key];
      }
    },
  };

  const session = {
    async get(key) {
      if (key === null || key === undefined) return {...sessionStore};
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
          .map((documentId) => {
            const tabId = [...tabDocuments].find(([, value]) => value === documentId)?.[0];
            const tab = tabs.get(tabId);
            return {documentId, tabId: tab?.id ?? -1,
              documentUrl: tab?.url || `${EXTENSION_ORIGIN}/sidebar/sidebar.html`,
              contextType: tab ? "TAB" : "SIDE_PANEL"};
          });
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
        const park = (resolvable) => new Promise((resolveP, reject) => {
          const list = shared.pendingByTab.get(id) || [];
          list.push(reject);
          shared.pendingByTab.set(id, list);
          if (resolvable) {
            const resolvers = shared.resolveByTab.get(id) || [];
            resolvers.push(resolveP);
            shared.resolveByTab.set(id, resolvers);
          }
        });
        if (content.hang) return await park(false);
        if (action === "inspectCaptureActivity") {
          return inspectWithRealContentHandler(content.active, payload);
        }
        if (action === "cancelCapture") {
          const target = String(payload?.captureRequestId || "");
          const matched = !target || content.active.has(target);
          if (matched && content.cancel === "settle") {
            content.active.clear();
            for (const resolveP of shared.resolveByTab.get(id) || []) {
              resolveP({ok: true, type: "comments", data: {items: [], totalCount: 0, captureStatus: "partial",
                stoppedByUser: true, stoppedByStall: false, stopReason: "canceled"}});
            }
            shared.resolveByTab.delete(id);
          }
          return {ok: true, matched};
        }
        if (content.hangActions?.has?.(action)) {
          return await park(true);
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
        const closing = tabs.get(id);
        const order = [...tabs.values()].filter((t) => t.windowId === closing.windowId).map((t) => t.id);
        const at = order.indexOf(id);
        tabs.delete(id);
        if (closing.active === true) {
          const next = order[at + 1] ?? order[at - 1];
          if (next !== undefined && tabs.has(next)) {
            tabs.set(next, {...tabs.get(next), active: true, lastAccessed: Date.now()});
            shared.activations.push({closed: id, activated: next});
          }
        }
        for (const reject of shared.pendingByTab.get(id) || []) {
          reject(new Error("The message port closed before a response was received."));
        }
        shared.pendingByTab.delete(id);
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
        if (!tab) throw missingTab(tabId);
        if (patch?.active === true) {
          for (const other of tabs.values()) {
            if (other.windowId === tab.windowId && other.id !== tab.id && other.active) tabs.set(other.id, {...other, active: false});
          }
        }
        const next = {...tab, ...(patch?.active === true ? {active: true, lastAccessed: Date.now()} : {}), ...(patch?.url ? {url: patch.url} : {}), ...(patch?.autoDiscardable === false ? {autoDiscardable: false} : {})};
        tabs.set(tab.id, next);
        return {...next};
      },
      async discard(tabId) {
        const id = Number(tabId);
        forbiddenTabCalls.discard.push(id);
        const tab = tabs.get(id);
        if (!tab) throw missingTab(id);
        // Chrome refuses to discard the active tab of a window (and tabs with autoDiscardable:false are still discardable by the API).
        if (tab.active === true) throw new Error(`Cannot discard tab with id: ${id}.`);
        if (tab.discarded === true) return {...tab};
        const next = {...tab, discarded: true, frozen: false, status: 'unloaded'};
        documents.delete(id);
        contents.delete(id);
        const documentId = tabDocuments.get(id);
        if (documentId) deadDocuments.add(documentId);
        for (const reject of shared.pendingByTab.get(id) || []) {
          reject(new Error("The message port closed before a response was received."));
        }
        shared.pendingByTab.delete(id);
        shared.discarded.push(id);
        if (shared.discardReplacesId) {
          shared.nextTabId.value += 1;
          const newId = shared.nextTabId.value;
          tabs.delete(id);
          tabs.set(newId, {...next, id: newId});
          for (const listener of [...chrome.tabs.onReplaced.listeners]) listener(newId, id);
          return {...next, id: newId};
        }
        tabs.set(id, next);
        for (const listener of [...chrome.tabs.onUpdated.listeners]) {
          try { listener(id, {discarded: true}, {...next}); } catch {}
        }
        return {...next};
      },
      async create(options = {}) {
        shared.nextTabId.value += 1;
        const id = shared.nextTabId.value;
        const tab = {
          id,
          lastAccessed: Date.now(),
          windowId: Number.isFinite(Number(options.windowId))
            ? Number(options.windowId)
            : 1,
          groupId: -1,
          status: "complete",
          active: options.active === true,
          url: String(options.url || ""),
          title: "",
        };
        if (tab.active) {
          for (const other of tabs.values()) {
            if (other.windowId === tab.windowId && other.active) tabs.set(other.id, {...other, active: false});
          }
        }
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
        return webcrypto.randomUUID();
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
    AbortController, performance, structuredClone, queueMicrotask,
    setInterval,
    setTimeout: unrefSetTimeout,
    importScripts() {},
    __ONSTARVOICE_API_BASE_URL__: globalThis.__R3_SERVER_ORIGIN__,
  });

  for (const {path, source} of supportSources) {
    vm.runInContext(source, context, {filename: path});
  }
  vm.runInContext(
    `${backgroundSource}\n;globalThis.__selfStopTestApi = {\n` +
      `  recoverUnattendedKeywordRunRequest,\n` +
      `  superviseUnattendedKeywordRun,\n` +
      `  launchPendingUnattendedRecovery,\n` +
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
      `  assessUnattendedRunHealth,\n` +
      `  closeExactTerminalUnattendedRunnerAfterFlush,\n` +
      `  persistUnattendedLocalClosureReadyMarker,\n` +
      `  readStoredCaptureExecutionLock,\n` +
      `  runStopFenceChecksFromHeartbeat, stopFenceInFlight: () => stopFenceCheckInFlight,\n` +
      `  normalizeUnattendedRunProgress,\n` +
      `  manuallyRecoverUnattendedKeywordRun, closeRetiredUnattendedRunnerAfterReceipt,\n` +
      `  readUnattendedKeywordRunRequest, readActiveCaptureExecutionLockForTest: () => readActiveCaptureExecutionLock(),\n` +
      `  maxRecoveries: UNATTENDED_MAX_RECOVERY_ATTEMPTS,\n` +
      `  syncCloudTaskAgent, executeCloudTaskAgentCommand, readTaskLedger, updateUnattendedKeywordRun, handleUnattendedKeywordAlarm,\n` +
      `  syncState: () => ({inFlight: cloudTaskAgentSyncInFlight, pending: cloudTaskAgentSyncPending, lastError: cloudTaskAgentLastError}),\n` +
      `  selfStopMaxTries: UNATTENDED_RECOVERY_SELF_STOP_MAX_TRIES, selfStopBudgetMs: UNATTENDED_RECOVERY_SELF_STOP_BUDGET_MS,\n` +
      `  bizStall: UNATTENDED_RUN_BUSINESS_STALL_MS, commentStall: UNATTENDED_RUN_COMMENT_STAGE_STALL_MS,\n` +
      `};`,
    context,
    {filename: "background.js"},
  );
  const api = context.__selfStopTestApi;
  if (!productionTiming) Object.assign(api.stopFenceTiming, {
    deadlineMs: 3000,
    probeTimeoutMs: 150,
    contentQueryTimeoutMs: 150,
    cancelSettleMs: 250,
    cancelPollMs: 20,
    relayDrainMs: 150,
    relayPollMs: 10,
  });
  if (!productionTiming) Object.assign(api.registrationTiming, {createdWaitMs: 50, createdPollMs: 5});
  if (!productionTiming) Object.assign(api.selfStopTiming, {
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

function assertSelfStopSafety(harness, {allowedRemovedTabIds = [], allowedDiscardTabIds = []} = {}) {
  assert.deepEqual(harness.forbiddenTabCalls.reload, [], "no tabs.reload");
  for (const tabId of harness.forbiddenTabCalls.discard) {
    assert.ok(allowedDiscardTabIds.includes(tabId), `unexpected tabs.discard ${tabId}`);
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


// ============================================================================
// FIELD REPLAY (adversarial review round 1, extension area).
// Replays the 09-27 火星 (39b541f8) and 上海 (6bd697a1) cases against W HEAD
// background.js + the real sidebar retirement code, with a fake chrome that
// models what Chrome does in the field: a pending tabs.sendMessage rejects
// when its tab is closed, storage.onChanged reaches the runner page
// asynchronously, the runner drains its upload queue before the final receipt.
// ============================================================================

const sidebarSource = await read("sidebar/sidebar-logic.js");
const retirementSource = sourceBlock(
  sidebarSource,
  "function handleUnattendedRunRequestStorageChange(request) {",
  "async function handleSaveKeywordPlan(",
);

const W_A = 101; // detail worker A (foreground, comments of #29)
const W_B = 102; // detail worker B (prefetched #30)
const USER_TAB = 40; // user's own Douyin tab in another window
const ADMIN_TAB = 41; // non-platform tab
const LOG = [];
const log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  LOG.push(line);
  if (process.env.SELFHEAL_REPLAY_VERBOSE === "1") console.log(line);
};

// The A1 runner page: the real sidebar retirement handler, with its storage
// listener wired to the background's chrome.storage.local.set.
function attachRunner(harness, {
  attemptId = A1,
  queue = null,
  responsive = true,
  documentId = RUNNER_DOCUMENT,
  tabId = RUNNER_TAB,
} = {}) {
  const calls = {cancelFlags: [], rejected: [], heartbeatStops: 0, messages: [], renewals: 0};
  let lockHeartbeat = null;
  const context = vm.createContext({
    console: {warn() {}, log() {}, error() {}},
    setTimeout,
    clearTimeout,
    Promise,
    chrome: {
      runtime: {
        async sendMessage(message) {
          calls.messages.push(JSON.parse(JSON.stringify(message)));
          return await harness.sendBackgroundMessage(
            message,
            runnerSender(attemptId, {tabId, documentId}),
          );
        },
      },
    },
    getUnattendedRunRequestIdFromUrl: () => REQUEST_ID,
    getUnattendedRunAttemptIdFromUrl: () => attemptId,
    isExplicitUserUnattendedCancellationMessage: () => true,
    setCancelFlag: (value) => calls.cancelFlags.push(value),
    stopRejectedUnattendedAttempt: (reason) => calls.rejected.push(reason),
    stopCaptureExecutionLockHeartbeat: () => {
      calls.heartbeatStops += 1;
      if (lockHeartbeat) clearInterval(lockHeartbeat);
      lockHeartbeat = null;
    },
    activeUnattendedRunRequestId: REQUEST_ID,
    activeUnattendedRunAttemptId: attemptId,
    pendingUnattendedCancellationRequestId: "",
    pendingUnattendedCancellationAttemptId: "",
    activeCaptureTaskCancellationReason: "",
    batchKeywordCancelRequested: false,
    detailBatchCancelRequested: false,
    searchCaptureCancelRequested: false,
    activeCaptureExecutionLockId: "lock-r",
    adoptedUnattendedCaptureExecutionLockId: "lock-r",
    activeUnattendedStreamingSyncQueue: queue,
    retiredUnattendedAttemptKey: "",
    UNATTENDED_ATTEMPT_RETIREMENT_FLUSH_MS: 60 * 1000,
  });
  vm.runInContext(
    `${retirementSource}\nthis.__handle = handleUnattendedRunRequestStorageChange;`,
    context,
  );
  // The runner keeps renewing its lock every 200 ms until retirement stops it.
  lockHeartbeat = setInterval(() => {
    calls.renewals += 1;
    harness.sendBackgroundMessage(
      {type: "onstarvoice:renew-capture-lock", lockId: context.activeCaptureExecutionLockId || "lock-r", holderId: "runner-holder"},
      runnerSender(attemptId, {tabId, documentId}),
    ).catch(() => null);
  }, 200);
  lockHeartbeat.unref?.();
  harness.state.onLocalSet.push((values) => {
    if (!responsive) return;
    if (Object.hasOwn(values, REQUEST_KEY)) {
      context.__handle(values[REQUEST_KEY]);
    }
  });
  return {
    context,
    calls,
    stop() {
      if (lockHeartbeat) clearInterval(lockHeartbeat);
    },
  };
}

function createUploadQueue({pending = 2, drainMs = 400} = {}) {
  let processed = 0;
  let remaining = pending;
  return {
    enabled: true,
    getStats: () => ({processedCount: processed, remainingCount: remaining}),
    drain: () =>
      new Promise((resolvePromise) =>
        setTimeout(() => {
          processed += remaining;
          remaining = 0;
          resolvePromise({processedCount: processed, remainingCount: 0});
        }, drainMs),
      ),
  };
}

function setContent(harness, tabId, content) {
  harness.state.contents.set(tabId, {
    receiver: true,
    hang: false,
    cancel: "settle",
    ...content,
    active: new Map(Object.entries(content.active || {})),
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

// 火星 at 05:06:32: round 1, 29/50, comments of #29 on worker A, worker B holds
// the prefetched #30, runner A1 alive (heartbeat 13 s old), no content
// progress, lock bound to R/A1 (holder = runner doc, holderTabId = source tab).
async function seedMars(harness, {workerAHung = true} = {}) {
  const nowMs = Date.now();
  seedRunningRequest(harness, {
    cloudAssigned: true,
    executionMode: "one_time",
    heartbeatAt: new Date(nowMs - 13 * 1000).toISOString(),
    businessProgressAt: new Date(nowMs - (12 * 60 + 18) * 1000).toISOString(),
  });
  harness.patchTab(RUNNER_TAB, {active: true});
  harness.state.windowFocus.set(1, true);
  // Workers created by the 0.4.19 runner (about:blank, active:false) and registered.
  harness.state.nextTabId.value = W_A - 1;
  const a = await createRegisteredWorker(harness);
  const b = await createRegisteredWorker(harness);
  assert.equal(a, W_A);
  assert.equal(b, W_B);
  harness.patchTab(W_A, {url: "https://www.xiaohongshu.com/explore/note-29?xsec_source=pc_search", title: "#29"});
  harness.patchTab(W_B, {url: "https://www.xiaohongshu.com/explore/note-30?xsec_source=pc_search", title: "#30"});
  harness.setDocument(W_A, {timeOrigin: freshDocument(), hang: workerAHung});
  harness.setDocument(W_B, {timeOrigin: freshDocument()});
  setContent(harness, W_A, {
    active: {"cap-29": 1},
    cancel: "ignore",
    hang: workerAHung,
    hangActions: new Set(["captureComments"]),
  });
  setContent(harness, W_B, {active: {}});
  harness.storage[REQUEST_KEY] = {
    ...harness.storage[REQUEST_KEY],
    progress: {
      current: 29,
      total: 50,
      keyword: "别克哨兵",
      phase: "detail_comments_capturing",
      message: "标记 #29（第 29/50 条）：正在采集评论...",
      runnerTabId: W_A,
      captureRequestId: "cap-29",
      captureAction: "captureComments",
      activeStage: "comments_capture",
    },
  };
  // The user's own Douyin tab in another (focused) window and a non-platform tab.
  harness.addTab({
    id: USER_TAB,
    url: "https://www.douyin.com/video/123",
    title: "用户自己的页",
    active: true,
    windowId: 2,
    lastAccessed: Date.now() - 1000,
    timeOrigin: freshDocument(),
    content: {active: {}},
  });
  harness.state.windowFocus.set(2, true);
  harness.addTab({id: ADMIN_TAB, url: "https://admin.example.com/ops", windowId: 2});
}

function startHungCommentRelay(harness) {
  return harness.sendBackgroundMessage(
    {
      type: "onstarvoice:relay-to-content",
      tabId: W_A,
      payload: {action: "captureComments", captureRequestId: "cap-29", taskId: TASK_KEY},
    },
    runnerSender(A1),
  );
}

// ---- 上海 6bd697a1: the real sidebar reporter + background normalization + watchdog ----
const reporterSource =
  sourceBlock(sidebarSource, "function readFiniteProgressNumber(", "function rememberCaptureTaskProgressContext(") +
  "\n" +
  sourceBlock(sidebarSource, "function createUnattendedKeywordProgressReporter(", "function resolveUnattendedProtectedWaitUntilMs(");

function attachReporter(harness, attemptId = A1) {
  const reports = [];
  const context = vm.createContext({
    console: {warn() {}, log() {}, error() {}},
    Date, Math, Number, String, JSON, Array, Map, Object, Promise, setTimeout,
    activeUnattendedRunRequestId: REQUEST_ID,
    activeUnattendedRunAttemptId: attemptId,
    activeCaptureTaskProgressContext: null,
    activeUnattendedProgressSeq: 10,
    getKeywordExecutionCopy: () => ({taskLabel: "无人值守计划"}),
    summarizeUnattendedKeywordCheckpoint: () => ({}),
    buildUnattendedTaskCounts: () => ({}),
    reportUnattendedKeywordRun: async (requestId, patch, {attemptId: a} = {}) => {
      const response = await harness.sendBackgroundMessage(
        {type: "onstarvoice:update-unattended-keyword-run", requestId, attemptId: a, patch},
        runnerSender(attemptId),
      );
      reports.push({patch: JSON.parse(JSON.stringify(patch)), response});
      return response;
    },
  });
  vm.runInContext(`${reporterSource}\nthis.__reporter = createUnattendedKeywordProgressReporter(${JSON.stringify(REQUEST_ID)}, {attemptId: ${JSON.stringify(attemptId)}});`, context);
  return {reporter: context.__reporter, reports};
}

// The events exactly as W HEAD capture-sync emits them for the 上海 sequence:
// foreground A enters the comment stage of #1/3, then worker B finishes
// prefetching #2 (the last business event seen in production, 03:38:06).
function commentsEvent(current, total) {
  return {
    phase: "detail_comments_capturing", message: `#${current}（第 ${current}/${total} 条）：正在采集评论...`,
    recordId: `rec-${current}`, current, total, includeComments: true,
    captureRequestId: `cap-${current}`, runnerTabId: W_A,
    captureAction: "captureComments", activeStage: "comments_capture",
    keyword: "ibuick", progressScope: "detail_item",
  };
}
function prefetchReadyEvent(foreground, total, {activeStage}) {
  return {
    // readForegroundDetailProgress()
    current: foreground, total, activeStage,
    captureAction: activeStage === "comments_capture" ? "captureComments" : "",
    phase: "detail_item_prefetch_ready", message: "工作页 B 已加载下一条，等待当前采集完成",
    recordId: `rec-${foreground + 1}`, runnerTabId: W_B,
    keyword: "ibuick", progressScope: "detail_item",
  };
}


// ============================================================================
// FIELD REPLAY round 2 (HEAD bbc7dc1). Fake chrome now also models:
// - tabs.discard: refuses the active tab, kills the document, rejects pending
//   messages, fires onUpdated{discarded} (which re-enters the supervisor);
// - closing the active tab activates its right (else left) neighbour and
//   stamps lastAccessed = now (Chromium TabStripModel behaviour);
// - openUrlInTab(active:true): the foreground detail worker is the ACTIVE tab
//   of the capture window, the runner is not; the capture window is focused.
// ============================================================================

const T_STALL_MS = (12 * 60 + 18) * 1000;

async function seedMarsField(harness, {workerAHung = true, sourceActive = false, bHung = false} = {}) {
  await seedMars(harness, {workerAHung});
  // Field layout: window 1 = capture window (focused), window 2 = user window.
  harness.state.windowFocus.set(1, true);
  harness.state.windowFocus.set(2, false);
  harness.patchTab(RUNNER_TAB, {active: false, lastAccessed: Date.now() - 81 * 60 * 1000});
  harness.patchTab(W_B, {active: false});
  if (sourceActive) {
    harness.patchTab(W_A, {active: false, lastAccessed: Date.now() - T_STALL_MS});
    harness.patchTab(SOURCE_TAB, {active: true, lastAccessed: Date.now() - T_STALL_MS});
  } else {
    // openUrlInTab(#29, {active:true}) at the start of the frozen item.
    harness.patchTab(W_A, {active: true, lastAccessed: Date.now() - T_STALL_MS});
    harness.patchTab(SOURCE_TAB, {active: false, lastAccessed: Date.now() - 81 * 60 * 1000});
  }
  if (bHung) {
    harness.setDocument(W_B, {hang: true});
    harness.content(W_B).hang = true;
  }
}

function snapshot(harness) {
  const req = harness.storage[REQUEST_KEY];
  return {
    status: req?.status, attempt: req?.attemptId, phase: req?.progress?.phase,
    err: req?.error ? {code: req.error.code, reason: req.error.reason} : null,
    done: req?.recoverySelfStop?.done ? {
      tries: req.recoverySelfStop.done.tries, closed: req.recoverySelfStop.done.closedTabIds,
      discarded: req.recoverySelfStop.done.discardedTabIds, retained: req.recoverySelfStop.done.runnersRetained,
      retiredClosed: req.recoverySelfStop.done.retiredRunnersClosed, runnerClosed: req.recoverySelfStop.done.runnerClosed,
    } : null,
    lock: harness.storage[LOCK_KEY] ? {doc: harness.storage[LOCK_KEY].holderDocumentId, allowReload: harness.storage[LOCK_KEY].allowReload, self: harness.storage[LOCK_KEY].selfStopRequestId} : null,
    tabs: [...harness.tabs.values()].map((t) => `${t.id}${t.active ? '*' : ''}${t.discarded ? 'D' : ''}`),
    activations: harness.state.activations,
    discards: harness.forbiddenTabCalls.discard,
  };
}

async function runTries(harness, maxTries = 6, between = null) {
  let result = plain(await harness.api.superviseUnattendedKeywordRun());
  await harness.api.flushUnattended();
  const trail = [{try: 1, reason: result.reason, self: result.selfStopReason, status: harness.storage[REQUEST_KEY].status}];
  for (let i = 2; i <= maxTries && harness.storage[REQUEST_KEY].status === 'recovering' && !harness.storage[REQUEST_KEY].recoverySelfStop?.done; i += 1) {
    if (between) await between(i);
    result = plain(await superviseAfterWait(harness));
    trail.push({try: i, reason: result.reason, self: result.selfStopReason, status: harness.storage[REQUEST_KEY].status});
  }
  return {trail, result};
}


// ==================== R3: terminal transition after the fixer change ====================
function ledgerTrail(harness) {
  const trail = [];
  const originalSet = harness.chrome.storage.local.set;
  harness.chrome.storage.local.set = async (values) => {
    await originalSet(values);
    const run = (values?.["onstarvoice.taskLedger"]?.runs || []).find((entry) => entry?.id === REQUEST_ID);
    if (run) {
      const entry = `${run.status}:${run.attemptNumber}:${String(run.error?.code || "")}:${String(run.error?.reason || "")}`;
      if (trail.at(-1) !== entry) trail.push(entry);
    }
  };
  return trail;
}


// ============================================================================
// Production-incident replay with the current extension and S3 server.
// Real background.js, cloud-task-agent.js, task-center.js and retirement logic
// run inside a fake Chrome, talking over HTTP to server/app.js backed by an
// isolated local PostgreSQL test database. No browser or production mutation.
// ============================================================================
import {createHash, randomUUID as nodeUuid} from "node:crypto";

const W = repoRoot;
const {validatePostgresIntegrationTarget} = await import(`${W}/scripts/lib/postgres-integration-target.mjs`);
validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
  databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
const {runMigrations} = await import(`${W}/server/db/migrate.js`);
const {getPool, closePool} = await import(`${W}/server/db/pool.js`);
const {withTransaction} = await import(`${W}/server/db/init.js`);
const {findCaptureAgentExecutionSlotBlocker, hashCaptureAgentToken, makeCaptureAgentToken} =
  await import(`${W}/server/services/capture-cloud.js`);
const {clearCaptureOverviewProjectionCache} = await import(`${W}/server/routes/capture-cloud.js`);
const {createApp} = await import(`${W}/server/app.js`);
const {hashPassword} = await import(`${W}/server/services/auth-service.js`);
await runMigrations();
const pool = getPool();
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const httpServer = await new Promise((resolvePromise, reject) => {
  const listening = createApp({logger: {log() {}, error() {}}}).listen(0, "127.0.0.1");
  listening.once("error", reject);
  listening.once("listening", () => resolvePromise(listening));
});
const ORIGIN = `http://127.0.0.1:${httpServer.address().port}`;
globalThis.__R3_SERVER_ORIGIN__ = ORIGIN;
after(async () => {
  await new Promise((r) => { httpServer.close(r); httpServer.closeAllConnections?.(); });
  await closePool();
});

async function http(path, {method = "POST", body, token, tenantId} = {}) {
  const response = await fetch(`${ORIGIN}/api/capture-cloud${path}`, {
    method,
    headers: {"content-type": "application/json",
      ...(token ? {authorization: `Bearer ${token}`} : {}),
      ...(tenantId ? {"x-tenant-id": tenantId} : {})},
    ...(method === "GET" ? {} : {body: JSON.stringify(body || {})}),
  });
  return {status: response.status, body: await response.json()};
}

async function serverFixture(st, {keywords}) {
  const [tenant] = await q("INSERT INTO tenants(name) VALUES($1) RETURNING id", [`R3 field ${nodeUuid()}`]);
  const [code] = await q(`INSERT INTO auth_codes(tenant_id,code,status,expires_at)
    VALUES($1,$2,'active',now()+interval '1 day') RETURNING id`, [tenant.id, nodeUuid()]);
  const [binding] = await q("INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id", [code.id, nodeUuid()]);
  const [agent] = await q(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,
    status,allowed_platforms,auth_code_id,auth_binding_id,capabilities,app_version,
    last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
    VALUES($1,$2,'火星','active',ARRAY['xiaohongshu'],$3,$4,$5,'0.4.19',now(),now(),now()) RETURNING *`,
  [tenant.id, nodeUuid(), code.id, binding.id, {previousCaptureStopCheckV1: true, singleRelayV1: true,
    remoteTaskCreate: true, remoteSequentialSearchPassesV1: true, supportedPlatforms: ["xiaohongshu"]}]);
  const token = makeCaptureAgentToken();
  await q(`INSERT INTO capture_agent_tokens(agent_id,auth_code_id,auth_binding_id,token_hash)
    VALUES($1,$2,$3,$4)`, [agent.id, code.id, binding.id, hashCaptureAgentToken(token)]);
  const email = `r3-${nodeUuid()}@integration.invalid`;
  const password = "r3-field-replay-only";
  const [user] = await q(`INSERT INTO users(email,name,password_hash,status,must_change_password)
    VALUES($1,'值班运营',$2,'active',false) RETURNING id`, [email, hashPassword(password)]);
  await q(`INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_admin','active')`, [user.id, tenant.id]);
  const login = await fetch(`${ORIGIN}/api/auth/login`, {method: "POST",
    headers: {"content-type": "application/json"}, body: JSON.stringify({email, password})});
  const session = await login.json();
  const [parent] = await q(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
    feature_key,platform,status,title,metadata,counts,orchestration_revision) VALUES($1,$2,'capture_orchestration',
    'keyword_orchestration','xiaohongshu','running','小红书~03:30 巡检',$3,$4,1) RETURNING *`,
  [tenant.id, nodeUuid(), {distributionMode: "elastic_pool", eligibleAgentIds: [agent.id],
    planSnapshot: {enabled: true, platform: "xiaohongshu", keywords,
      recoveryPolicy: {singleRelayV1: true, allowIdleAgentHandoff: true, disableAutomaticSearchRetry: true}}},
  {total: keywords.length}]);
  for (const [index, keyword] of keywords.entries()) {
    await q(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,
      platform,status,ordinal,metadata) VALUES($1,$2,$3,'keyword',$4,'xiaohongshu','pending',$5,'{}'::jsonb)`,
    [tenant.id, parent.id, `keyword:${index}:${keyword}`, keyword, index]);
  }
  st.after(async () => {
    await q("DELETE FROM tenants WHERE id=$1", [tenant.id]).catch(() => null);
    await q("DELETE FROM users WHERE id=$1", [user.id]).catch(() => null);
  });
  const view = async () => {
    const children = await q(`SELECT id,status,error,progress,title,metadata FROM capture_tasks
      WHERE tenant_id=$1 AND parent_task_id=$2 ORDER BY created_at`, [tenant.id, parent.id]);
    const items = await q(`SELECT keyword,status,attempt_count,execution_task_id,error FROM capture_task_items
      WHERE tenant_id=$1 AND task_id=$2 ORDER BY ordinal`, [tenant.id, parent.id]);
    const attempts = await q(`SELECT task_id,attempt_number,status,error FROM capture_task_attempts
      WHERE tenant_id=$1 ORDER BY task_id,attempt_number`, [tenant.id]);
    const blocker = await withTransaction((tx) => findCaptureAgentExecutionSlotBlocker(tx, tenant.id, agent.id));
    const commands = await q(`SELECT command_type,status,task_id FROM capture_agent_commands
      WHERE tenant_id=$1 ORDER BY created_at`, [tenant.id]);
    return {
      children: children.map((c) => ({id: c.id.slice(0, 8), status: c.status, code: c.error?.code || "",
        reason: c.error?.reason || "", phase: c.progress?.phase || "", cur: c.progress?.current,
        tot: c.progress?.total, activeStage: c.progress?.activeStage ?? null, captureAction: c.progress?.captureAction ?? null,
        stopFenceCheck: c.metadata?.stopFenceCheck ? {checkId: String(c.metadata.stopFenceCheck.checkId || "").slice(0, 8)} : null})),
      items: items.map((i) => `${i.keyword}:${i.status}:${i.attempt_count}`),
      attempts: attempts.map((a) => `${a.task_id.slice(0, 8)}#${a.attempt_number}:${a.status}${a.error?.code ? ":" + a.error.code : ""}`),
      blocker: blocker ? `${String(blocker.id).slice(0, 8)}:${blocker.status}` : null,
      commands: commands.map((c) => `${c.command_type}:${c.status}`),
    };
  };
  const overview = async () => {
    clearCaptureOverviewProjectionCache();
    const result = await http("/overview", {method: "GET", token: session.token, tenantId: tenant.id});
    return (result.body.agents || []).find((a) => a.id === agent.id)?.stop_fence || null;
  };
  const confirm = (taskIds) => http(`/agents/${agent.id}/stop-fence/confirm`, {token: session.token, tenantId: tenant.id,
    body: {confirmation: "确认旧页面已停止", expectedTaskIds: taskIds}});
  return {tenant, agent, token, parent, view, overview, confirm};
}

// A fresh node: fake Chrome window 1 (capture window, focused) with one idle
// Xiaohongshu tab 20, and the user's own window 2.
function seedNode(harness, f) {
  seedRuntimeEpoch(harness);
  harness.storage["onstarvoice.auth"] = {captureAgent: {id: f.agent.id, token: f.token}};
  harness.storage["onstarvoice.runtime"] = {clientUuid: f.agent.client_uuid};
  harness.state.windowFocus.set(1, true);
  harness.addTab({id: SOURCE_TAB, url: "https://www.xiaohongshu.com/explore", title: "小红书",
    active: true, windowId: 1, lastAccessed: Date.now() - 60 * 60 * 1000, timeOrigin: freshDocument(), content: {active: {}}});
  harness.addTab({id: USER_TAB, url: "https://www.douyin.com/video/123", title: "用户自己的页", active: true,
    windowId: 2, lastAccessed: Date.now() - 1000, timeOrigin: freshDocument(), content: {active: {}}});
  harness.addTab({id: ADMIN_TAB, url: "https://admin.example.com/ops", windowId: 2});
  harness.state.nextTabId.value = RUNNER_TAB - 1;
}

async function beat(harness, label, f, trail) {
  const waitStart = Date.now();
  while (harness.api.syncState().inFlight && Date.now() - waitStart < 20000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const waited = Date.now() - waitStart;
  if (waited > 500) log(`[beat ${label}] waited ${waited} ms for an in-flight sync`, harness.api.syncState());
  const response = plain(await harness.api.syncCloudTaskAgent({reason: label, force: true}));
  await harness.api.flushUnattended();
  const view = await f.view();
  const req = harness.storage[REQUEST_KEY];
  const entry = {label, ok: response?.ok !== false ? true : response,
    creates: (response?.commands || []).filter((c) => c.command_type === "create").map((c) => c.payload?.planSnapshot?.keywords?.[0]),
    offers: (response?.stopFenceChecks || []).map((o) => o.mode),
    local: req ? `${req.status}#${req.attemptNumber}:${req.progress?.phase || ""}${req.error?.code ? ":" + req.error.code : ""}${req.error?.reason ? ":" + req.error.reason : ""}` : null,
    server: view.children.map((c) => `${c.id}:${c.status}:${c.phase}${c.code ? ":" + c.code : ""}${c.reason ? ":" + c.reason : ""}`),
    items: view.items, blocker: view.blocker};
  trail.push(entry);
  log(`[beat ${label}]`, entry);
  return {response, view};
}

// The A1 runner claims the request and the lock, BEGIN binds the lock to the
// task (holder page = source tab 20), then two 0.4.19 detail workers.
async function startRunner(harness, {tabId = RUNNER_TAB, documentId = RUNNER_DOCUMENT} = {}) {
  const request = harness.storage[REQUEST_KEY];
  setIdentity(request.id, request.attemptId);
  harness.state.tabDocuments.set(tabId, documentId);
  const claim = await harness.sendBackgroundMessage(
    {type: "onstarvoice:claim-unattended-keyword-run", requestId: REQUEST_ID, attemptId: A1, holderId: "runner-holder"},
    runnerSender(A1, {tabId, documentId}));
  assert.equal(claim?.accepted, true, JSON.stringify(claim));
  const lock = harness.storage[LOCK_KEY];
  harness.storage[LOCK_KEY] = {...lock, id: "lock-r", captureTaskId: TASK_KEY, captureTaskAttemptId: A1, holderTabId: SOURCE_TAB,
    expiresAt: Date.now() + 90 * 1000};
  return claim;
}

async function report(harness, patch, attemptId = A1) {
  const response = await harness.sendBackgroundMessage(
    {type: "onstarvoice:update-unattended-keyword-run", requestId: REQUEST_ID, attemptId, patch},
    runnerSender(attemptId));
  await harness.api.flushUnattended();
  return response;
}

async function registerWorker(harness) {
  const tab = await harness.chrome.tabs.create({url: "about:blank", active: false, windowId: 1});
  const response = await harness.sendBackgroundMessage(
    {type: "onstarvoice:record-owned-capture-tab", tabId: tab.id, sourceTabId: SOURCE_TAB}, runnerSender(A1));
  assert.equal(response?.ok, true, JSON.stringify(response));
  return tab.id;
}

// 火星 39b541f8 at 05:06:32: comments of #29 on worker A (active tab of the
// capture window, hung renderer, a comment relay in flight), B holds #30.
async function reachMarsFrozen(harness, {workerAHung = true, sourceHungActive = false} = {}) {
  const wA = await registerWorker(harness);
  const wB = await registerWorker(harness);
  harness.patchTab(wA, {url: "https://www.xiaohongshu.com/explore/note-29?xsec_source=pc_search", active: !sourceHungActive,
    lastAccessed: Date.now() - T_STALL_MS});
  harness.patchTab(wB, {url: "https://www.xiaohongshu.com/explore/note-30?xsec_source=pc_search"});
  harness.patchTab(SOURCE_TAB, {active: sourceHungActive});
  harness.setDocument(wA, {timeOrigin: freshDocument(), hang: workerAHung});
  harness.setDocument(wB, {timeOrigin: freshDocument()});
  setContent(harness, wA, {active: {"cap-29": 1}, cancel: "ignore", hang: workerAHung, hangActions: new Set(["captureComments"])});
  setContent(harness, wB, {active: {}});
  if (sourceHungActive) {
    // The list/source page itself is the hung, ACTIVE page (Chrome never discards it).
    harness.setDocument(SOURCE_TAB, {hang: true});
    harness.content(SOURCE_TAB).hang = true;
    harness.content(SOURCE_TAB).active = new Map([["cap-29", 1]]);
  }
  await report(harness, {status: "running", startedAt: new Date(Date.now() - 95 * 60 * 1000).toISOString(),
    progress: {current: 29, total: 50, keyword: "别克哨兵", phase: "detail_comments_capturing",
      message: "标记 #29（第 29/50 条）：正在采集评论...", runnerTabId: sourceHungActive ? SOURCE_TAB : wA,
      captureRequestId: "cap-29", captureAction: "captureComments", activeStage: "comments_capture"}});
  const relay = harness.sendBackgroundMessage({type: "onstarvoice:relay-to-content", tabId: sourceHungActive ? SOURCE_TAB : wA,
    payload: {action: "captureComments", captureRequestId: "cap-29", taskId: TASK_KEY}}, runnerSender(A1));
  return {wA, wB, relay};
}

function ageStall(harness) {
  const nowMs = Date.now();
  harness.storage[REQUEST_KEY] = {...harness.storage[REQUEST_KEY],
    heartbeatAt: new Date(nowMs - 13 * 1000).toISOString(),
    businessProgressAt: new Date(nowMs - T_STALL_MS).toISOString()};
}

async function finishKeyword(harness, attemptId, keyword) {
  const now = new Date().toISOString();
  return await report(harness, {status: "completed", finishedAt: now, message: "关键词采集完成",
    checkpoint: {round: 1, completedKeywords: [keyword], failedKeywords: [], skippedKeywords: [],
      keywordResults: [{keyword, round: 1, status: "completed", savedCount: 12, attemptCount: 1, finishedAt: now}]},
    counts: {total: 1, processed: 1, success: 1, saved: 12},
    progress: {current: 50, total: 50, keyword, phase: "completed", message: "关键词采集完成"}}, attemptId);
}

// ============================================================================
// ADVERSARIAL REVIEW round 1 (server area), LENS field replay.
// W server HEAD 1ff9d3a (S3 + S2-srv + S1-srv + F3 + S4) on a throwaway
// PostgreSQL database, real heartbeat / claim / receipt routes over HTTP.
// ============================================================================

let TEST_T0 = Date.now();
async function waitIdle(h, label = "") {
  const start = Date.now();
  for (;;) {
    const sync = h.api.syncState();
    const busy = sync.inFlight || h.api.stopFenceInFlight();
    if (!busy) break;
    if (Date.now() - start > 30000) { log(`[waitIdle ${label}] gave up`, sync, h.api.stopFenceInFlight()); break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  await h.api.flushUnattended();
}

// One full heartbeat that really reached the server (retries a skipped sync),
// then waits for the stop-fence check it started (0.4.18 runs it with `void`)
// and for the follow-up sync a release triggers.
async function beat2(h, label, f, trail) {
  await waitIdle(h, label);
  let response;
  for (let i = 0; i < 50; i += 1) {
    response = plain(await h.api.syncCloudTaskAgent({reason: label, force: true}));
    if (!(response?.skipped && response?.reason === "sync_in_flight")) break;
    await waitIdle(h, label);
  }
  await h.api.flushUnattended();
  await new Promise((r) => setTimeout(r, 30));
  await waitIdle(h, label);
  await new Promise((r) => setTimeout(r, 30));
  await waitIdle(h, label);
  const view = await f.view();
  const req = h.storage[REQUEST_KEY];
  const rows = await q(`SELECT id,status,error,metadata FROM capture_tasks WHERE tenant_id=$1 AND parent_task_id=$2 ORDER BY created_at`,
    [f.tenant.id, f.parent.id]);
  const entry = {label, t: Math.round((Date.now() - TEST_T0) / 100) / 10, ok: response?.ok !== false ? true : response,
    creates: (response?.commands || []).filter((c) => c.command_type === "create").map((c) => c.payload?.planSnapshot?.keywords?.[0]),
    offers: (response?.stopFenceChecks || []).map((o) => `${o.mode}:${String(o.checkId || "").slice(0, 8)}`),
    local: req ? `${String(req.id).slice(0, 8)}:${req.status}#${req.attemptNumber}:${req.progress?.phase || ""}${req.error?.code ? ":" + req.error.code : ""}${req.error?.reason ? ":" + req.error.reason : ""}` : null,
    server: view.children.map((c) => `${c.id}:${c.status}:${c.code || "-"}`),
    checks: rows.map((r) => checkSummary(r)).filter(Boolean),
    items: view.items, blocker: view.blocker};
  trail.push(entry);
  log(`[beat ${label}]`, entry);
  return {response, view, entry};
}

function checkSummary(row) {
  const c = row?.metadata?.stopFenceCheck;
  if (!c) return null;
  return {task: String(row.id).slice(0, 8), check: String(c.checkId || "").slice(0, 8), round: c.round,
    failures: c.failureCount, last: c.lastResult?.reason || "", nextIssueAt: c.nextIssueAt || null,
    escalated: Boolean(c.escalatedAt), resolution: c.resolution || "", localRelease: c.localRelease?.state || ""};
}

async function childRows(f) {
  return await q(`SELECT id,status,error,metadata,message,updated_at,attempt_number FROM capture_tasks
    WHERE tenant_id=$1 AND parent_task_id=$2 ORDER BY created_at`, [f.tenant.id, f.parent.id]);
}

// Simulates the 3-minute wait of a failed round (STOP_FENCE_CHECK_RETRY_MS).
async function ageCheckRound(f, childId) {
  await q(`UPDATE capture_tasks SET metadata = jsonb_set(metadata, '{stopFenceCheck,nextIssueAt}', to_jsonb($3::text))
    WHERE tenant_id=$1 AND id=$2 AND metadata ? 'stopFenceCheck'
      AND metadata->'stopFenceCheck'->>'nextIssueAt' IS NOT NULL`,
  [f.tenant.id, childId, new Date(Date.now() - 1000).toISOString()]);
}

async function childEvents(f, childId) {
  return (await q(`SELECT event_type,actor_type,status,message,payload FROM capture_task_events
    WHERE tenant_id=$1 AND task_id=$2 ORDER BY created_at, id`, [f.tenant.id, childId]))
    .map((e) => `${e.event_type}:${e.actor_type}:${e.status || ""}:${String(e.message || "").slice(0, 44)}`);
}

function createCountAfter(trail, index) {
  return trail.slice(index).reduce((n, e) => n + e.creates.length, 0);
}

async function waitRelay(relay) {
  return plain(await Promise.race([relay.then((v) => ({settled: v}), (e) => ({rejected: String(e?.message || e)})),
    new Promise((r) => setTimeout(() => r("pending"), 300))]));
}

// Query counters (the in-process W server shares this pg module instance).
const pgModule = (await import(`${W}/server/node_modules/pg/lib/index.js`)).default;
const SQL_COUNTS = {claimListing: 0, fenceSql: 0, precheck: 0};
{
  const origQuery = pgModule.Client.prototype.query;
  pgModule.Client.prototype.query = function patchedQuery(config, ...rest) {
    const sql = typeof config === "string" ? config : String(config?.text || "");
    if (sql.includes("WITH confirmed_stops AS MATERIALIZED")) SQL_COUNTS.fenceSql += 1;
    if (sql.includes("$9::boolean AND") && sql.includes("OR task.status = 'superseded'")) SQL_COUNTS.claimListing += 1;
    if (sql.includes("AS fence_pending")) SQL_COUNTS.precheck += 1;
    return origQuery.call(this, config, ...rest);
  };
}

// ---------------------------------------------------------------------------
// Full release: Extension 0.4.19 (W HEAD background.js) + W server.
// ---------------------------------------------------------------------------

async function localSlotAndServer(h, f) {
  const rows = await childRows(f);
  const req = h.storage[REQUEST_KEY];
  return {
    local: req ? `${String(req.id).slice(0, 8)}:${req.status}` : null,
    server: rows.map((r) => `${String(r.id).slice(0, 8)}:${r.status}:${r.error?.code || "-"}`),
  };
}

test("S2/S3 end to end: hold an unprovable stop, then resume the next keyword on node proof", async (t) => {
  const f = await serverFixture(t, {keywords: ["别克哨兵", "ibuick"]});
  const h = createHarness();
  seedNode(h, f);
  const trail = [];
  await beat2(h, "idle node", f, trail);
  if (!h.storage[REQUEST_KEY]) await beat2(h, "idle node 2", f, trail);
  await startRunner(h);
  const runnerSim = attachRunner(h, {queue: createUploadQueue({pending: 0, drainMs: 10})});
  t.after(() => runnerSim.stop());
  const {relay} = await reachMarsFrozen(h, {workerAHung: false, sourceHungActive: true});
  relay.catch(() => null);
  await beat2(h, "running 29/50", f, trail);
  ageStall(h);
  plain(await h.api.superviseUnattendedKeywordRun());
  await h.api.flushUnattended();
  await beat2(h, "S2 try 1", f, trail);
  for (let i = 2; i <= 6 && h.storage[REQUEST_KEY].status === "recovering"; i += 1) {
    const r = await superviseAfterWait(h);
    await beat2(h, `S2 try ${i} (${r?.reason}/${r?.selfStopReason || ""})`, f, trail);
  }
  const local = h.storage[REQUEST_KEY];
  log("[19A] local after S2", local.status, local.error, "lock", h.storage[LOCK_KEY] && {allowReload: h.storage[LOCK_KEY].allowReload, self: h.storage[LOCK_KEY].selfStopRequestId});
  assert.equal(local.status, "needs_action");
  h.storage[PLAN_KEY] = {...local.planSnapshot, enabled: true, mode: "daily"};
  const heldLock = plain(h.storage[LOCK_KEY]);
  await h.api.handleUnattendedKeywordAlarm();
  assert.equal(h.storage[REQUEST_KEY].id, local.id);
  assert.deepEqual(h.storage[LOCK_KEY], heldLock);
  const fenceStart = trail.length;
  const childId = (await childRows(f))[0].id;
  // The S3 rounds while the source page stays the hung active tab.
  for (let round = 1; round <= 4; round += 1) {
    await beat2(h, `fenced, round ${round}`, f, trail);
    const beforeListing = SQL_COUNTS.claimListing;
    await beat2(h, `fenced, waiting after round ${round}`, f, trail);
    assert.equal(SQL_COUNTS.claimListing, beforeListing, "a waiting round adds no heavy claim listing");
    await ageCheckRound(f, childId);
  }
  const held = await f.overview();
  log("[19A] overview while held", {phase: held?.phase, auto: held?.auto_check_task_count, confirmable: held?.operator_confirmable_task_ids?.length});
  const events = await q(`SELECT event_type,status FROM capture_task_events WHERE task_id=$1
    AND event_type IN ('stop_fence_check_requested','stop_fence_check_failed','stop_fence_check_escalated')`, [childId]);
  assert.ok(events.length >= 3);
  assert.ok(events.every(event => event.status === 'needs_action'), 'check events preserve actual status');
  const heldRow = (await childRows(f))[0];
  assert.equal(heldRow.status, "needs_action");
  assert.equal(createCountAfter(trail, fenceStart), 0, "no work while unprovable");
  assert.ok(trail.slice(fenceStart).every((e) => e.blocker), "node held");
  // The user switches the capture window to another tab: the hung source
  // page is now a background page, which 0.4.19 discards in the node check.
  h.patchTab(SOURCE_TAB, {active: false});
  const other = await h.chrome.tabs.create({url: "https://www.xiaohongshu.com/explore", active: true, windowId: 1});
  h.setDocument(other.id, {timeOrigin: freshDocument()});
  setContent(h, other.id, {active: {}});
  const before = await localSlotAndServer(h, f);
  await beat2(h, "source now a background page, round offered", f, trail);
  await beat2(h, "after release 1", f, trail);
  await beat2(h, "after release 2", f, trail);
  const after = await localSlotAndServer(h, f);
  const row = (await childRows(f)).find((r) => r.id === childId);
  const recon = row.metadata?.historicalStopFenceReconciliation || {};
  log("[19A] before/after", before, after);
  log("[19A] released row", row.status, row.error?.code, {proof: recon.proofStatus, from: recon.releasedFromStatus, item: recon.itemOutcome,
    evidence: (recon.evidence?.targets || []).map((x) => `${x.tabId}:${x.role}:${x.evidence}`)});
  log("[19A] events", await childEvents(f, childId));
  log("[19A] trail", trail.map((e) => `${e.label} | local=${e.local} | server=${e.server.join(",")} | offers=${e.offers} | creates=${e.creates} | blocker=${e.blocker} | checks=${JSON.stringify(e.checks)}`));
  log("[19A] tabs", [...h.tabs.values()].map((tab) => `${tab.id}${tab.active ? "*" : ""}${tab.discarded ? "D" : ""}`), "removed", h.removedTabIds,
    "reloads", h.forbiddenTabCalls.reload, "discards", h.forbiddenTabCalls.discard, "lock", h.storage[LOCK_KEY] || null);
  assert.equal(row.status, "superseded");
  assert.equal(recon.proofStatus, "agent_confirmed");
  assert.ok(after.server.length >= 2 || after.local !== before.local, "next keyword dispatched after the proof");
  assert.deepEqual(h.forbiddenTabCalls.reload, [], "no reload");
  assert.ok(h.tabs.has(SOURCE_TAB) && h.tabs.has(USER_TAB) && h.tabs.has(ADMIN_TAB), "source/user tabs never closed");
});

// each_agent keyword coverage batch (pinned keywords), single capable node.
async function coverageFixture(st, {keywords}) {
  const base = await serverFixture(st, {keywords: []});
  const {tenant, agent} = base;
  const [parent] = await q(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
    feature_key,platform,status,title,metadata,counts,orchestration_revision,created_at,started_at) VALUES($1,$2,'capture_orchestration',
    'keyword_orchestration','xiaohongshu','running','覆盖批次 · 每个节点都搜',$3,$4,1,now()-interval '40 minutes',now()-interval '40 minutes') RETURNING *`,
  [tenant.id, nodeUuid(), {distributionMode: "elastic_pool", keywordCoverage: "each_agent", eligibleAgentIds: [agent.id],
    publishedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    planSnapshot: {enabled: true, platform: "xiaohongshu", keywords, keywordCoverage: "each_agent",
      recoveryPolicy: {singleRelayV1: true, allowIdleAgentHandoff: true, disableAutomaticSearchRetry: true}}},
  {total: keywords.length}]);
  for (const [index, keyword] of keywords.entries()) {
    await q(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,
      platform,status,ordinal,metadata) VALUES($1,$2,$3,'keyword',$4,'xiaohongshu','pending',$5,$6)`,
    [tenant.id, parent.id, `keyword:${index}:${keyword}:${agent.id}`, keyword, index, {keywordCoverage: "each_agent", pinnedAgentId: agent.id}]);
  }
  // Drop the plain batch serverFixture created (no keywords) so beats only see the coverage batch.
  await q(`UPDATE capture_tasks SET status='completed' WHERE id=$1`, [base.parent.id]);
  return {...base, parent};
}

test("S2-srv: coverage waits for the node watchdog; unprovable recovery blocks other batches", async (t) => {
  const {reconcileKeywordNodeCoverage} = await import(`${W}/server/services/keyword-node-coverage.js`);
  const f = await coverageFixture(t, {keywords: ["别克哨兵", "别克车机"]});
  const h = createHarness();
  seedNode(h, f);
  const trail = [];
  await beat2(h, "idle node", f, trail);
  if (!h.storage[REQUEST_KEY]) await beat2(h, "idle node 2", f, trail);
  assert.ok(h.storage[REQUEST_KEY]?.cloudAssigned === true, "pinned keyword dispatched");
  await startRunner(h);
  const runnerSim = attachRunner(h, {queue: createUploadQueue({pending: 0, drainMs: 10})});
  t.after(() => runnerSim.stop());
  const {relay} = await reachMarsFrozen(h, {workerAHung: false, sourceHungActive: true});
  relay.catch(() => null);
  await beat2(h, "running 29/50 (comment stage)", f, trail);
  const childId = h.storage[REQUEST_KEY].id;
  // 12 min 30 s without business progress: server row and node agree.
  const stalledAt = new Date(Date.now() - (12 * 60 + 30) * 1000).toISOString();
  await q(`UPDATE capture_tasks SET business_progress_at=$2, created_at=now()-interval '95 minutes',
    started_at=now()-interval '95 minutes' WHERE id=$1`, [childId, stalledAt]);
  const before = (await q(`SELECT status, progress->>'phase' AS phase, progress->>'activeStage' AS stage,
    progress->>'captureAction' AS action, heartbeat_at, business_progress_at FROM capture_tasks WHERE id=$1`, [childId]))[0];
  log("[19B] server row before coverage", before);
  // The coverage cron tick lands first (both thresholds are 12 min, both run once a minute).
  const coverage = await reconcileKeywordNodeCoverage({tenantId: f.tenant.id, parentTaskIds: [f.parent.id]});
  const revoked = (await q(`SELECT status, error, metadata->>'terminalReason' AS reason FROM capture_tasks WHERE id=$1`, [childId]))[0];
  log("[19B] coverage", coverage, "child", revoked.status, revoked.error?.code, revoked.reason);
  assert.equal(coverage.skipped, 0);
  assert.equal(revoked.status, "running");
  // Then the node's own watchdog fires: S2 x5 cannot prove (R's source page is the hung active tab).
  h.storage[REQUEST_KEY] = {...h.storage[REQUEST_KEY], heartbeatAt: new Date(Date.now() - 13 * 1000).toISOString(), businessProgressAt: stalledAt};
  plain(await h.api.superviseUnattendedKeywordRun());
  await h.api.flushUnattended();
  await beat2(h, "S2 try 1", f, trail);
  for (let i = 2; i <= 6 && h.storage[REQUEST_KEY].status === "recovering"; i += 1) {
    const r = await superviseAfterWait(h);
    await beat2(h, `S2 try ${i} (${r?.reason}/${r?.selfStopReason || ""})`, f, trail);
  }
  const local = h.storage[REQUEST_KEY];
  log("[19B] local after S2", local.status, local.error?.code, local.error?.reason, "lock", h.storage[LOCK_KEY] && {allowReload: h.storage[LOCK_KEY].allowReload, task: h.storage[LOCK_KEY].captureTaskId});
  await beat2(h, "after fence 1", f, trail);
  await beat2(h, "after fence 2", f, trail);
  const row = (await q(`SELECT status, error, metadata FROM capture_tasks WHERE id=$1`, [childId]))[0];
  const blocker = await withTransaction((tx) => findCaptureAgentExecutionSlotBlocker(tx, f.tenant.id, f.agent.id));
  const fencing = await q(`SELECT id,status FROM capture_tasks task WHERE tenant_id=$1 AND
    ${(await import(`${W}/server/services/capture-cloud.js`)).captureTaskUnconfirmedLocalStopSql("task")}`, [f.tenant.id]);
  const phase = await f.overview();
  assert.equal(row.error.code, "PREVIOUS_CAPTURE_STOP_UNCONFIRMED");
  assert.ok(blocker, "unproven node stays fenced");
  log("[19B] server child", row.status, row.error?.code, row.error?.coverageReason || "", "stopFenceCheck", Boolean(row.metadata?.stopFenceCheck));
  log("[19B] admission", {blocker: blocker && {id: String(blocker.id).slice(0, 8), status: blocker.status}, fencingRows: fencing, stopFencePhase: phase?.phase || null});
  const items = await q(`SELECT keyword,status,execution_task_id FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal`, [f.parent.id]);
  log("[19B] items", items.map((i) => `${i.keyword}:${i.status}`), "children", (await childRows(f)).map((r) => `${String(r.id).slice(0, 8)}:${r.status}:${r.error?.code || "-"}`));
  log("[19B] trail", trail.map((e) => `${e.label} | local=${e.local} | offers=${e.offers} | creates=${e.creates} | blocker=${e.blocker}`));
  log("[19B] local slot now", h.storage[REQUEST_KEY]?.id?.slice(0, 8), h.storage[REQUEST_KEY]?.status, "runner launches", runnerLaunches(h).map((x) => x.url.slice(-60)));
  // Another (plain elastic) batch has work for this node: does the server hand it out?
  const [other] = await q(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,
    feature_key,platform,status,title,metadata,counts,orchestration_revision) VALUES($1,$2,'capture_orchestration',
    'keyword_orchestration','xiaohongshu','running','小红书 19:30 巡检',$3,$4,1) RETURNING *`,
  [f.tenant.id, nodeUuid(), {distributionMode: "elastic_pool", eligibleAgentIds: [f.agent.id],
    planSnapshot: {enabled: true, platform: "xiaohongshu", keywords: ["君越"],
      recoveryPolicy: {singleRelayV1: true, allowIdleAgentHandoff: true, disableAutomaticSearchRetry: true}}}, {total: 1}]);
  await q(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,status,ordinal,metadata)
    VALUES($1,$2,'keyword:0:君越','keyword','君越','xiaohongshu','pending',0,'{}'::jsonb)`, [f.tenant.id, other.id]);
  const launchesBefore = runnerLaunches(h).length;
  const {response} = await beat2(h, "other batch has work", f, trail);
  await beat2(h, "after other create", f, trail);
  const otherChildren = await q(`SELECT id,status,error FROM capture_tasks WHERE parent_task_id=$1`, [other.id]);
  log("[19B] other batch", {creates: (response?.commands || []).filter((c) => c.command_type === "create").map((c) => c.payload?.planSnapshot?.keywords?.[0]),
    children: otherChildren.map((c) => `${String(c.id).slice(0, 8)}:${c.status}:${c.error?.code || "-"}`)});
  assert.equal(otherChildren.length, 0, "no second pipeline from another batch");
  const cmds = await q(`SELECT command_type,status,result,expires_at FROM capture_agent_commands WHERE tenant_id=$1 AND task_id=ANY($2::uuid[])`,
    [f.tenant.id, otherChildren.map((c) => c.id)]);
  const otherEvents = otherChildren.length ? await childEvents(f, otherChildren[0].id) : [];
  log("[19B] other create command", cmds.map((c) => ({type: c.command_type, status: c.status, result: c.result, expiresAt: c.expires_at})), otherEvents);
  log("[19B] node cloud results", JSON.stringify(h.storage["onstarvoice.cloudCommandResults"] || null).slice(0, 600));
  log("[19B] node after", {slot: h.storage[REQUEST_KEY] && `${String(h.storage[REQUEST_KEY].id).slice(0, 8)}:${h.storage[REQUEST_KEY].status}:${h.storage[REQUEST_KEY].message || ""}`,
    newRunnerTabs: runnerLaunches(h).slice(launchesBefore).map((x) => x.url.slice(-80)),
    lock: h.storage[LOCK_KEY] && {task: h.storage[LOCK_KEY].captureTaskId, allowReload: h.storage[LOCK_KEY].allowReload},
    oldSourceStillCapturing: [...(h.content(SOURCE_TAB)?.active || new Map()).keys()], sourceHung: h.content(SOURCE_TAB)?.hang});
});
