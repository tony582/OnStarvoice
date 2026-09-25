import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {readFile} from "node:fs/promises";
import test, {after} from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

// 0.4.16 停止保护核对：真实 background.js + 假 chrome。核对路径的禁止调用
// （刷新、重注入、带刷新的停止与认锁）用 spy 锁定。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFileKeepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(testFileKeepAlive));

const read = (path) => readFile(resolve(repoRoot, path), "utf8");
const backgroundSource = await read("background.js");
const cloudTaskAgentSource = await read("utils/cloud-task-agent.js");
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
const ARCHIVE_KEY = "onstarvoice.unattendedKeywordRunArchive";
const LOCK_KEY = "onstarvoice.captureExecutionLock";
const LEDGER_KEY = "onstarvoice.taskLedger";
const STOP_FENCE_STORE_KEY = "onstarvoice.stopFenceChecks";
const OUTBOX_PREFIX = "onstarvoice.unattendedCheckpointReportOutbox.v2.";
const EPOCH_KEY = "onstarvoice.runtimeEpoch";
const EXTENSION_ORIGIN = "chrome-extension://test";
const MISSING_RECEIVER =
  "Could not establish connection. Receiving end does not exist.";

const REQUEST_ID = "fenced-request";
const TASK_KEY = `unattended-capture:${REQUEST_ID}`;
const ATTEMPT_ID = "attempt-2";
const PREVIOUS_ATTEMPT_ID = "attempt-1";
const SERVER_TASK_ID = "11111111-2222-4333-8444-555555555555";
// 离站观察按“页面:请求”记。
const SEEN_20 = `20:${REQUEST_ID}`;

const FORBIDDEN_FUNCTIONS = [
  "relayToContentWithRetry",
  "sendContentMessageWithTimeout",
  "stopUnattendedCaptureTargetsForRecovery",
  "stopPreviousUnattendedCaptureForResume",
  "reloadUnattendedCaptureTabAndConfirm",
  "readActiveCaptureExecutionLock",
  "removeStaleCaptureExecutionLock",
  "ensureContentScriptReady",
  "waitForContentScriptReady",
  "cancelTimedOutContentCapture",
  "releaseUnattendedCaptureTaskResourcesForRecovery",
  "isCaptureExecutionLockOwnedByUnattendedAttempt",
  "retryUnattendedLocalClosureCleanup",
];

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

// 真实 content-v2.js 的 inspectCaptureActivity 处理函数：假页面按它的回复
// 形状作答，内容脚本少了字段时这里的测试会变红，而不是被假回复掩盖。
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

function createHarness({sessionStorage = true} = {}) {
  const storage = {};
  const sessionStore = {};
  const tabs = new Map();
  const tabDocuments = new Map();
  const deadDocuments = new Set();
  const documents = new Map();
  const contents = new Map();
  const sentTabMessages = [];
  const executeScriptCalls = [];
  const removedTabIds = [];
  const forbiddenTabCalls = {reload: [], update: [], discard: []};
  const stopFenceCompletions = [];
  const heartbeats = [];
  const forbiddenCalls = Object.fromEntries(
    FORBIDDEN_FUNCTIONS.map((name) => [name, 0]),
  );
  let stopFenceCompletionHandler = null;
  let heartbeatHandler = null;
  let tabQueryHook = null;
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
  };

  const missingTab = (tabId) => new Error(`No tab with id: ${tabId}.`);

  // 页面回复一律由真实 content-v2.js 处理函数生成。两个开关只用来模拟
  // 别的内容脚本：reportsActiveRequests:false 是 0.4.15 及更早的回复形状；
  // unlistedActive 是列表与计数对不上的回复。
  const contentResponse = (content, payload = {}) => {
    const response = inspectWithRealContentHandler(content.active, payload);
    if (content.reportsActiveRequests === false) {
      delete response.activeRequests;
      delete response.targetCount;
    }
    if (Number(content.unlistedActive) > 0) {
      response.activeCount += Number(content.unlistedActive);
      response.targetActive = true;
    }
    return response;
  };

  const chrome = {
    runtime: {
      id: "test",
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent(),
      onConnect: createEvent(),
      getManifest: () => ({version: "0.4.16"}),
      getURL: (path) => `${EXTENSION_ORIGIN}/${path}`,
      async getContexts({documentIds = []} = {}) {
        return documentIds
          .filter((documentId) => !deadDocuments.has(documentId))
          .map((documentId) => ({documentId}));
      },
    },
    storage: {
      local: localStorage,
      ...(sessionStorage ? {session} : {}),
    },
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
      onUpdated: createEvent(),
      onRemoved: createEvent(),
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
          return contentResponse(content, payload);
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
        if (typeof tabQueryHook === "function") await tabQueryHook(queryInfo);
        const all = [...tabs.values()].map((tab) => ({...tab}));
        return queryInfo?.active === true
          ? all.filter((tab) => tab.active === true)
          : all;
      },
      async remove(tabId) {
        const id = Number(tabId);
        if (!tabs.has(id)) throw missingTab(id);
        removedTabIds.push(id);
        tabs.delete(id);
        const documentId = tabDocuments.get(id);
        if (documentId) deadDocuments.add(documentId);
      },
      async reload(tabId) {
        forbiddenTabCalls.reload.push(Number(tabId));
      },
      async update(tabId, patch) {
        forbiddenTabCalls.update.push({tabId: Number(tabId), patch});
        return {id: Number(tabId), ...patch};
      },
      async discard(tabId) {
        forbiddenTabCalls.discard.push(Number(tabId));
      },
      async create(options) {
        return {id: 900 + tabs.size, ...options};
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
      async update(windowId, patch) {
        return {id: windowId, ...patch};
      },
    },
    scripting: {
      async executeScript(options = {}) {
        const tabId = Number(options?.target?.tabId);
        executeScriptCalls.push({
          tabId,
          frameIds: options?.target?.frameIds,
          hasFunc: typeof options?.func === "function",
        });
        const documentState = documents.get(tabId);
        // Chrome 对停在错误页（断网、超时、DNS/代理错误）的主框架的原样报错。
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
            capabilities: {
              previousCaptureStopCheckV1: true,
              taskStateKnown: options.taskStateKnown !== false,
            },
            health: {status: "healthy", degradedReasons: []},
          },
          tasks: [],
          reason: options.reason || "",
        };
      },
      async sendHeartbeat(options = {}) {
        heartbeats.push(JSON.parse(JSON.stringify(options.body || {})));
        return typeof heartbeatHandler === "function"
          ? await heartbeatHandler(options, heartbeats.length)
          : {ok: true, commands: []};
      },
      async completeCommand(options = {}) {
        return {ok: true, commandId: options.commandId};
      },
      async completeStopFenceCheck(options = {}) {
        stopFenceCompletions.push(JSON.parse(JSON.stringify(options)));
        return typeof stopFenceCompletionHandler === "function"
          ? await stopFenceCompletionHandler(options, stopFenceCompletions.length)
          : {ok: true, released: true, message: "已放行"};
      },
    },
  });

  for (const {path, source} of supportSources) {
    vm.runInContext(source, context, {filename: path});
  }
  vm.runInContext(
    `${backgroundSource}\n;globalThis.__stopFenceTestApi = {\n` +
      `  confirmPreviousUnattendedStopForFenceCheck,\n` +
      `  releaseStopFenceLocalResourcesForOperator,\n` +
      `  runStopFenceChecksFromHeartbeat,\n` +
      `  ensureRuntimeEpoch,\n` +
      `  markRuntimeEpochOrigin,\n` +
      `  isDocumentFromCurrentRuntime,\n` +
      `  listRequestRelays,\n` +
      `  inFlightRelays: () => [...inFlightContentRelays.values()],\n` +
      `  isCaptureRequestAborted,\n` +
      `  syncCloudTaskAgent,\n` +
      `  claimUnattendedKeywordRun,\n` +
      `  recoverUnattendedKeywordRunRequest,\n` +
      `  acquireCaptureExecutionLock,\n` +
      `  timing: STOP_FENCE_CHECK_TIMING,\n` +
      `  getCaptureTaskGroup: (taskId) => captureTaskTabGroupManager.getTask(taskId),\n` +
      `  getCaptureDebugSessionByTaskId: (taskId) => captureDebugSessionManager.getSessionByTaskId(taskId),\n` +
      `  flushUnattended: () => unattendedRunMutationQueue,\n` +
      `};`,
    context,
    {filename: "background.js"},
  );
  const api = context.__stopFenceTestApi;
  // 缩短核对时限，场景仍走同一套逻辑。
  Object.assign(api.timing, {
    deadlineMs: 3000,
    probeTimeoutMs: 150,
    contentQueryTimeoutMs: 150,
    cancelSettleMs: 250,
    cancelPollMs: 20,
    relayDrainMs: 150,
    relayPollMs: 10,
  });

  const spies = {};
  for (const name of FORBIDDEN_FUNCTIONS) {
    const original = context[name];
    assert.equal(typeof original, "function", `${name} must exist`);
    spies[name] = original;
    context[name] = function forbiddenSpy(...args) {
      forbiddenCalls[name] += 1;
      return original.apply(this, args);
    };
  }

  const harness = {
    api,
    chrome,
    context,
    storage,
    sessionStore,
    tabs,
    sentTabMessages,
    executeScriptCalls,
    removedTabIds,
    forbiddenTabCalls,
    forbiddenCalls,
    stopFenceCompletions,
    heartbeats,
    addTab({
      id,
      url,
      title = "",
      status = "complete",
      active = false,
      discarded = false,
      frozen = false,
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
        windowId: 1,
        groupId: -1,
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
    setDocument(tabId, patch) {
      documents.set(tabId, {...(documents.get(tabId) || {}), ...patch});
    },
    content(tabId) {
      return contents.get(tabId);
    },
    killDocument(documentId) {
      deadDocuments.add(documentId);
    },
    setStopFenceCompletionHandler(handler) {
      stopFenceCompletionHandler = handler;
    },
    setHeartbeatHandler(handler) {
      heartbeatHandler = handler;
    },
    setTabQueryHook(handler) {
      tabQueryHook = handler;
    },
    resetCallLog() {
      sentTabMessages.length = 0;
      executeScriptCalls.length = 0;
      removedTabIds.length = 0;
      forbiddenTabCalls.reload.length = 0;
      forbiddenTabCalls.update.length = 0;
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

// 本次加载标识：默认是一次扩展重载（extension_load），startedAt 固定为“现在
// 往前 10 分钟”，于是 timeOrigin 取“现在”的文档晚于本次加载。
function seedRuntimeEpoch(harness, {origin = "extension_load", startedAt} = {}) {
  harness.sessionStore[EPOCH_KEY] = {
    id: "epoch-current",
    startedAt: startedAt ?? Date.now() - 10 * 60 * 1000,
    origin,
  };
  return harness.sessionStore[EPOCH_KEY];
}

function freshDocument() {
  return Date.now() - 60 * 1000;
}

function oldDocument() {
  return Date.now() - 60 * 60 * 1000;
}

function seedFencedRequest(harness, overrides = {}) {
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
    attemptId: ATTEMPT_ID,
    previousAttemptId: PREVIOUS_ATTEMPT_ID,
    attemptNumber: 2,
    progressSeq: 3,
    recoveryCount: 1,
    type: "keyword_batch",
    status: "needs_action",
    cloudAssigned: true,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    heartbeatAt: now,
    businessProgressAt: now,
    runnerTabId: null,
    message: "旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续",
    error: {
      code: "PREVIOUS_CAPTURE_STOP_UNCONFIRMED",
      message: "旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续",
    },
    progress: {
      current: 1,
      total: 1,
      keyword: "关键词一",
      phase: "unattended_needs_action",
      runnerTabId: 20,
      captureRequestId: "capture-r",
    },
    checkpoint: {completedKeywords: [], failedKeywords: [], skippedKeywords: []},
    stopFenceEvidence: {
      version: 1,
      at: now,
      runtimeEpochId: "epoch-current",
      runtimeStartedAt: Date.now() - 10 * 60 * 1000,
      runtimeEpochOrigin: "extension_load",
      captureRequestId: "capture-r",
      lockIdentity: null,
      targets: [{tabId: 20, role: "progress_tab", reason: "stop_unconfirmed"}],
      failedTabId: 20,
      failedReason: "stop_unconfirmed",
    },
    ...overrides,
  };
  return harness.storage[REQUEST_KEY];
}

function seedLock(harness, overrides = {}) {
  harness.storage[LOCK_KEY] = {
    id: "lock-r",
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "runner-holder",
    holderDocumentId: "runner-document",
    holderTabId: 30,
    captureTaskId: TASK_KEY,
    captureTaskAttemptId: PREVIOUS_ATTEMPT_ID,
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() - 60 * 1000,
    ...overrides,
  };
  return harness.storage[LOCK_KEY];
}

function buildOffer(overrides = {}) {
  return {
    version: 1,
    mode: "check",
    checkId: "check-1",
    taskId: SERVER_TASK_ID,
    requestId: REQUEST_ID,
    attemptId: ATTEMPT_ID,
    platform: "xiaohongshu",
    fencedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// 典型现场：北京那台机器。R 已 needs_action（轮次 2，上一轮 1），轮次 1 的
// runner 仍开着并持有执行锁，平台来源页晚于本次加载、内容脚本空闲。
function seedTypicalFence(harness, {lock = true} = {}) {
  seedRuntimeEpoch(harness);
  const request = seedFencedRequest(harness);
  if (lock) {
    seedLock(harness);
    harness.killDocument("runner-document");
  }
  harness.addTab({
    id: 20,
    url: "https://www.xiaohongshu.com/search_result?keyword=test",
    title: "小红书搜索页",
    timeOrigin: freshDocument(),
    content: {active: {}},
  });
  harness.addTab({
    id: 30,
    url: runnerUrl(REQUEST_ID, PREVIOUS_ATTEMPT_ID),
    title: "运行页",
    documentId: "runner-document",
  });
  return request;
}

// vm 上下文里的对象跨 realm，deepEqual 前先转成本 realm 的普通值。
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function runCheck(harness, offer = buildOffer()) {
  harness.resetCallLog();
  const result = await harness.api.confirmPreviousUnattendedStopForFenceCheck(
    offer,
  );
  await harness.api.flushUnattended();
  return plain(result);
}

// 每个场景都要满足的安全约束。
function assertCheckSafety(harness, {allowedRemovedTabIds = []} = {}) {
  assert.deepEqual(harness.forbiddenTabCalls.reload, [], "no tabs.reload");
  assert.deepEqual(harness.forbiddenTabCalls.update, [], "no tabs.update");
  assert.deepEqual(harness.forbiddenTabCalls.discard, [], "no tabs.discard");
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

function targetFor(result, tabId) {
  return result.targets.find((target) => target.tabId === tabId);
}

// ==================== 核对：拒绝与零副作用 ====================

test("a request still running in the slot answers request_active with zero side effects", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.storage[REQUEST_KEY].status = "running";
  const lockBefore = JSON.stringify(harness.storage[LOCK_KEY]);

  const result = await runCheck(harness);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "request_active");
  assert.equal(result.retryable, true);
  assert.equal(result.requestActive, true);
  assert.deepEqual(harness.sentTabMessages, []);
  assert.deepEqual(harness.executeScriptCalls, []);
  assert.deepEqual(harness.removedTabIds, []);
  assert.equal(harness.api.isCaptureRequestAborted("capture-r"), false);
  assert.equal(JSON.stringify(harness.storage[LOCK_KEY]), lockBefore);
  assertCheckSafety(harness);
});

test("a platform document older than this extension load needs an operator even when its content looks idle", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.setDocument(20, {timeOrigin: oldDocument(), overlay: "running"});

  const result = await runCheck(harness);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "old_document_uninspectable");
  assert.equal(result.requiresOperator, true);
  assert.equal(result.retryable, false);
  assert.deepEqual(result.pendingTabIds, [20]);
  assert.equal(result.pendingTabs[0].evidence, "old_document_uninspectable");
  assert.equal(result.pendingTabs[0].title, "小红书搜索页");
  assert.match(result.message, /仍在自动滚动/u);
  const target = targetFor(result, 20);
  assert.equal(target.documentState, "before_runtime");
  assert.equal(target.overlayState, "running");
  // 年龄门槛之后不再查询内容脚本，也不发取消、不关页、不放锁。
  assert.equal(
    harness.sentTabMessages.some(({tabId}) => tabId === 20),
    false,
  );
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assert.equal(harness.tabs.has(30), true, "runner stays open when phase one fails");
  assert.equal(
    harness.storage[REQUEST_KEY].localClosureStopConfirmation,
    undefined,
  );
  assertCheckSafety(harness);
});

test("a fence written in this same load still cannot vouch for an older document", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.storage[REQUEST_KEY].stopFenceEvidence.runtimeEpochId = "epoch-current";
  harness.setDocument(20, {timeOrigin: oldDocument()});

  const result = await runCheck(harness);

  assert.equal(result.reason, "old_document_uninspectable");
  assert.equal(result.fenceRuntime, "same");
  assertCheckSafety(harness);
});

test("after a browser startup every document passes the age gate and is judged by its content", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  seedRuntimeEpoch(harness, {origin: "browser_startup", startedAt: Date.now()});
  harness.setDocument(20, {timeOrigin: oldDocument()});

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.runtimeEpochOrigin, "browser_startup");
  assert.equal(targetFor(result, 20).evidence, "content_idle");
  assert.equal(targetFor(result, 20).documentState, "current_runtime");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

// ==================== 核对：成功路径与本机释放 ====================

test("the typical fence is proven, the exact runner closed, the lock released and the request left needs_action", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.reason, "previous_capture_stopped");
  assert.equal(result.proofMethod, "browser_sweep");
  assert.equal(result.sweepComplete, true);
  assert.equal(result.unresolvedTabCount, 0);
  assert.equal(result.relayInFlightCount, 0);
  assert.equal(result.requiresOperator, false);
  assert.equal(result.localLockBoundToRequest, false);
  assert.equal(result.lockReleased, true);
  assert.deepEqual(result.pendingTabIds, []);
  assert.equal(result.runnerTabsClosed, 1);
  assert.ok(result.sweptTabCount >= result.targets.length);
  assert.equal(targetFor(result, 20).evidence, "content_idle");
  assert.equal(targetFor(result, 30).evidence, "runner_closed");
  assert.equal(targetFor(result, 30).role, "runner");
  assert.deepEqual(harness.removedTabIds, [30]);
  assert.equal(harness.storage[LOCK_KEY], undefined);

  const request = harness.storage[REQUEST_KEY];
  assert.equal(request.status, "needs_action");
  assert.equal(request.error.code, "PREVIOUS_CAPTURE_STOP_UNCONFIRMED");
  assert.equal(request.localClosureStopConfirmation.stage, "runtime_released");
  assert.equal(request.localClosureStopConfirmation.method, "stop_fence_check");
  assert.equal(request.localClosureStopConfirmation.attemptId, ATTEMPT_ID);
  assert.ok(request.localClosureStopConfirmation.runtimeReleasedAt);
  assert.deepEqual(
    {...request.stopFenceClosure, at: undefined},
    {
      version: 1,
      at: undefined,
      checkId: "check-1",
      taskId: SERVER_TASK_ID,
      proofStatus: "agent_confirmed",
    },
  );
  assert.equal(
    result.localStopConfirmationAt,
    request.localClosureStopConfirmation.runtimeReleasedAt,
  );
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("content_absent proves a current document only after R has no relay in flight", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.content(20).receiver = false;

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(targetFor(result, 20).evidence, "content_absent");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("a content query timeout or a loading tab is probe_failed and releases nothing", async () => {
  for (const variant of ["timeout", "loading"]) {
    const harness = createHarness();
    seedTypicalFence(harness);
    if (variant === "timeout") harness.content(20).hang = true;
    else harness.tabs.get(20).status = "loading";

    const result = await runCheck(harness);

    assert.equal(result.accepted, false, variant);
    assert.equal(result.reason, "probe_failed", variant);
    assert.equal(result.retryable, true, variant);
    assert.equal(harness.storage[LOCK_KEY].id, "lock-r", variant);
    assert.equal(harness.tabs.has(30), true, variant);
    assertCheckSafety(harness);
  }
});

test("a page running only R is precisely stopped with a non-empty id, then proven", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  // 没有 runner 页：阶段一的结论就是最终结论（有 runner 时复扫会看到空闲页）。
  harness.tabs.delete(30);
  harness.content(20).active.set("capture-r", 1);

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.runnerTabsClosed, 0);
  assert.equal(targetFor(result, 20).evidence, "content_canceled_settled");
  assert.equal(result.scopedCancelSent, true);
  const cancels = harness.sentTabMessages.filter(
    ({payload}) => payload.action === "cancelCapture",
  );
  assert.deepEqual(
    cancels.map(({tabId, payload}) => [tabId, payload.captureRequestId]),
    [[20, "capture-r"]],
  );
  assert.equal(harness.api.isCaptureRequestAborted("capture-r"), true);
  assertCheckSafety(harness);
});

test("after a precise stop the runner is closed and the rescan sees the page idle", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.content(20).active.set("capture-r", 1);

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.scopedCancelSent, true);
  assert.equal(targetFor(result, 20).evidence, "content_idle");
  assert.equal(targetFor(result, 30).evidence, "runner_closed");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("a precise stop that does not settle in time is capture_still_active and closes nothing", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.content(20).active.set("capture-r", 1);
  harness.content(20).cancel = "ignore";

  const result = await runCheck(harness);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "capture_still_active");
  assert.equal(harness.tabs.has(30), true);
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assertCheckSafety(harness);
});

test("R mixed with another capture on one page is tab_busy_unattributed and is never canceled", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.content(20).active.set("capture-r", 1);
  harness.content(20).active.set("capture-other", 1);

  const result = await runCheck(harness);

  assert.equal(result.reason, "tab_busy_unattributed");
  assert.equal(
    harness.sentTabMessages.some(({payload}) => payload.action === "cancelCapture"),
    false,
  );
  assertCheckSafety(harness);
});

test("activity without the 0.4.16 activeRequests field cannot be attributed", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.content(20).active.set("capture-r", 1);
  harness.content(20).reportsActiveRequests = false;

  const result = await runCheck(harness);

  assert.equal(result.reason, "tab_busy_unattributed");
  assert.equal(
    harness.sentTabMessages.some(({payload}) => payload.action === "cancelCapture"),
    false,
  );
  assertCheckSafety(harness);
});

test("an activity list that does not account for every active handler cannot be attributed", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.content(20).active.set("capture-r", 1);
  harness.content(20).unlistedActive = 1;

  const result = await runCheck(harness);

  assert.equal(result.reason, "tab_busy_unattributed");
  assert.equal(
    harness.sentTabMessages.some(({payload}) => payload.action === "cancelCapture"),
    false,
  );
  assertCheckSafety(harness);
});

async function startManualRelay(harness, {tabId, captureRequestId, documentId}) {
  let release;
  const content = harness.content(tabId);
  content.onAction = () => new Promise((resolvePromise) => {
    release = () => resolvePromise({ok: true});
  });
  const relay = harness.sendBackgroundMessage(
    {
      type: "onstarvoice:relay-to-content",
      tabId,
      payload: {action: "captureDetailForManual", captureRequestId},
    },
    {documentId, url: `${EXTENSION_ORIGIN}/sidebar/sidebar.html`},
  );
  for (let attempt = 0; attempt < 50 && !release; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  }
  assert.equal(typeof release, "function", "manual relay must be in flight");
  return async () => {
    release();
    await relay;
  };
}

test("an unrelated live capture is proven only when every id traces to the live lock holder", async () => {
  const harness = createHarness();
  seedTypicalFence(harness, {lock: false});
  // 另一个手动采集持有执行锁，持有文档存活。
  seedLock(harness, {
    id: "manual-lock",
    owner: "manual_batch_keyword_capture",
    holderId: "manual-holder",
    holderDocumentId: "manual-document",
    holderTabId: null,
    captureTaskId: "manual-task",
    captureTaskAttemptId: "",
  });
  harness.addTab({
    id: 21,
    url: "https://www.xiaohongshu.com/explore/manual",
    timeOrigin: freshDocument(),
    content: {active: {}},
  });
  const finishRelay = await startManualRelay(harness, {
    tabId: 21,
    captureRequestId: "manual-capture",
    documentId: "manual-document",
  });
  harness.content(21).active.set("manual-capture", 1);

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(targetFor(result, 21).evidence, "unrelated_live_capture");
  assert.equal(harness.storage[LOCK_KEY].id, "manual-lock", "other lock untouched");
  assert.equal(harness.tabs.has(21), true);
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
  await finishRelay();
});

test("an activity id with no in-flight relay (for example after a worker restart) stays unattributed", async () => {
  const harness = createHarness();
  seedTypicalFence(harness, {lock: false});
  seedLock(harness, {
    id: "manual-lock",
    owner: "manual_batch_keyword_capture",
    holderDocumentId: "manual-document",
    holderTabId: null,
    captureTaskId: "manual-task",
    captureTaskAttemptId: "",
  });
  harness.addTab({
    id: 21,
    url: "https://www.xiaohongshu.com/explore/manual",
    timeOrigin: freshDocument(),
    content: {active: {"manual-capture": 1}},
  });

  const result = await runCheck(harness);

  assert.equal(result.reason, "tab_busy_unattributed");
  assert.equal(harness.storage[LOCK_KEY].id, "manual-lock");
  assertCheckSafety(harness);
});

test("a relay still in flight for R, even without a capture id, blocks proof and closes nothing", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  let release;
  harness.content(20).onAction = () => new Promise((resolvePromise) => {
    release = () => resolvePromise({ok: true});
  });
  const relay = harness.sendBackgroundMessage(
    {
      type: "onstarvoice:relay-to-content",
      tabId: 20,
      payload: {action: "applyBatchSearchFilters", taskId: TASK_KEY},
    },
    {
      documentId: "runner-document",
      tab: {id: 30, url: runnerUrl(REQUEST_ID, PREVIOUS_ATTEMPT_ID)},
      url: runnerUrl(REQUEST_ID, PREVIOUS_ATTEMPT_ID),
    },
  );
  for (let attempt = 0; attempt < 50 && !release; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  }
  assert.equal(harness.api.listRequestRelays(REQUEST_ID, TASK_KEY).length, 1);

  const result = await runCheck(harness);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "capture_still_active");
  assert.equal(result.relayInFlightCount, 1);
  assert.equal(harness.tabs.has(30), true, "runner stays open");
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assertCheckSafety(harness);
  release();
  await relay;
  assert.equal(harness.api.listRequestRelays(REQUEST_ID, TASK_KEY).length, 0);
});

// ==================== 两阶段：runner 页 ====================

test("checkpoint rows still pending keep the runner open and release nothing", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.storage[`${OUTBOX_PREFIX}rev-1`] = {
    id: `${REQUEST_ID}:${PREVIOUS_ATTEMPT_ID}`,
    requestId: REQUEST_ID,
    attemptId: PREVIOUS_ATTEMPT_ID,
    revision: "rev-1",
    patch: {checkpoint: {completedKeywords: []}},
  };

  const result = await runCheck(harness);

  assert.equal(result.reason, "checkpoint_reports_pending");
  assert.equal(result.retryable, true);
  assert.equal(harness.tabs.has(30), true);
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assert.equal(
    result.pendingTabIds.includes(30),
    false,
    "the runner that must flush its checkpoints is not listed for the operator",
  );
  assertCheckSafety(harness);
});

// 北京现场：19:33 轮次 0 → 20:16 自动恢复到轮次 1 → 20:41 恢复到轮次 2 时停止
// 失败写下围栏。T_R 只有 {轮次 2, 轮次 1}，但轮次 0 的 runner 仍开着。
function seedTwoRecoveryRunners(harness) {
  seedTypicalFence(harness);
  harness.addTab({id: 31, url: runnerUrl(REQUEST_ID, "attempt-0"), title: "轮次 0 运行页"});
  harness.addTab({id: 32, url: runnerUrl(REQUEST_ID, ATTEMPT_ID), title: "轮次 2 运行页"});
}

test("after two recoveries the runners of every attempt of the terminal request are closed and proven", async () => {
  const harness = createHarness();
  seedTwoRecoveryRunners(harness);

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.requiresOperator, false);
  assert.equal(result.runnerTabsClosed, 3);
  assert.deepEqual([...harness.removedTabIds].sort(), [30, 31, 32]);
  for (const tabId of [30, 31, 32]) {
    assert.equal(targetFor(result, tabId).evidence, "runner_closed", String(tabId));
  }
  assert.equal(targetFor(result, 20).evidence, "content_idle");
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assertCheckSafety(harness, {allowedRemovedTabIds: [30, 31, 32]});
});

test("an older attempt's runner with checkpoint rows still pending keeps every runner open", async () => {
  const harness = createHarness();
  seedTwoRecoveryRunners(harness);
  harness.storage[`${OUTBOX_PREFIX}rev-0`] = {
    id: `${REQUEST_ID}:attempt-0`,
    requestId: REQUEST_ID,
    attemptId: "attempt-0",
    revision: "rev-0",
    patch: {checkpoint: {completedKeywords: []}},
  };

  const result = await runCheck(harness);

  assert.equal(result.reason, "checkpoint_reports_pending");
  assert.deepEqual(harness.removedTabIds, []);
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assertCheckSafety(harness);
});

test("release_only also closes the runners left by older attempts", async () => {
  const harness = createHarness();
  seedTwoRecoveryRunners(harness);
  harness.resetCallLog();

  const result = plain(await harness.api.releaseStopFenceLocalResourcesForOperator(
    buildOffer({mode: "release_only", checkId: "release-older"}),
  ));

  assert.equal(result.reason, "local_release_done", JSON.stringify(result));
  assert.equal(result.runnerTabsClosed, 3);
  assert.deepEqual([...harness.removedTabIds].sort(), [30, 31, 32]);
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assertCheckSafety(harness, {allowedRemovedTabIds: [30, 31, 32]});
});

test("a runner of R needs an operator when R's local record is missing or not terminal", async () => {
  // 本机读不到 R：认不出这个 runner 是谁留下的。
  const unknown = createHarness();
  seedRuntimeEpoch(unknown);
  unknown.addTab({id: 31, url: runnerUrl(REQUEST_ID, "attempt-0"), title: "旧运行页"});
  const unknownResult = await runCheck(unknown);
  assert.equal(unknownResult.reason, "source_identity_unverifiable");
  assert.equal(unknownResult.requiresOperator, true);
  assert.ok(unknownResult.pendingTabIds.includes(31));
  assert.deepEqual(unknown.removedTabIds, []);
  assertCheckSafety(unknown);

  // 台账里的 R 不是终态（请求槽已换成别的请求）：只认台账记录的那一轮。
  const ledgerOnly = createHarness();
  seedRuntimeEpoch(ledgerOnly);
  ledgerOnly.storage[LEDGER_KEY] = {
    version: 1,
    runs: [{id: REQUEST_ID, status: "running", attemptId: ATTEMPT_ID}],
  };
  ledgerOnly.addTab({id: 31, url: runnerUrl(REQUEST_ID, "attempt-0"), title: "旧运行页"});
  ledgerOnly.addTab({id: 32, url: runnerUrl(REQUEST_ID, ATTEMPT_ID), title: "运行页"});
  const ledgerResult = await runCheck(ledgerOnly);
  assert.equal(ledgerResult.reason, "source_identity_unverifiable");
  assert.ok(ledgerResult.pendingTabIds.includes(31));
  assert.equal(ledgerResult.pendingTabIds.includes(32), false);
  assert.deepEqual(ledgerOnly.removedTabIds, []);
  assertCheckSafety(ledgerOnly);
});

test("a new attempt of R appearing before the runner closes is request_changed", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  let queries = 0;
  harness.setTabQueryHook(async (queryInfo) => {
    if (queryInfo?.active === true) return;
    queries += 1;
    if (queries === 2) {
      harness.storage[REQUEST_KEY] = {
        ...harness.storage[REQUEST_KEY],
        status: "needs_action",
        attemptId: "attempt-3",
        previousAttemptId: ATTEMPT_ID,
      };
    }
  });

  const result = await runCheck(harness);

  assert.equal(result.reason, "request_changed");
  assert.equal(harness.tabs.has(30), true);
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assertCheckSafety(harness);
});

// ==================== 认锁 ====================

test("a lock bound to another task id with the same attempt id is never released", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  seedLock(harness, {
    id: "other-task-lock",
    captureTaskId: "unattended-capture:other-request",
    captureTaskAttemptId: PREVIOUS_ATTEMPT_ID,
    holderDocumentId: "runner-document",
  });

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.lockReleased, false);
  assert.equal(harness.storage[LOCK_KEY].id, "other-task-lock");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("an unbound reservation whose holder tab happens to be the old runner is not treated as R's lock", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  seedLock(harness, {
    id: "reservation-lock",
    captureTaskId: "",
    captureTaskAttemptId: "",
    holderTabId: 30,
    holderDocumentId: "runner-document",
  });

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.lockReleased, false);
  assert.equal(harness.storage[LOCK_KEY].id, "reservation-lock");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("a reservation recorded in the fence evidence is released by exact identity", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  const lock = seedLock(harness, {
    id: "fenced-reservation",
    captureTaskId: "",
    captureTaskAttemptId: "",
  });
  harness.storage[REQUEST_KEY].stopFenceEvidence.lockIdentity = {
    id: lock.id,
    owner: lock.owner,
    holderId: lock.holderId,
    holderDocumentId: lock.holderDocumentId,
    holderTabId: lock.holderTabId,
    captureTaskId: "",
    captureTaskAttemptId: "",
  };

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.lockReleased, true);
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("a live lock holder document is lock_holder_alive and keeps the lock", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  seedLock(harness, {holderDocumentId: "sidebar-document", holderTabId: null});

  const result = await runCheck(harness);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "lock_holder_alive");
  assert.equal(result.localLockBoundToRequest, true);
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("a non-terminal request in the slot blocks the local release", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  const archived = harness.storage[REQUEST_KEY];
  harness.storage[ARCHIVE_KEY] = {
    version: 1,
    requests: {[REQUEST_ID]: {...archived, archivedAt: new Date().toISOString()}},
  };
  harness.storage[REQUEST_KEY] = {
    ...archived,
    id: "other-running-request",
    status: "running",
    attemptId: "other-attempt",
    previousAttemptId: "",
    stopFenceEvidence: undefined,
  };

  const result = await runCheck(harness);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "local_release_failed");
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("capture assist left by R is reclaimed through the 0.4.15 residue path, keeping the foreground tab", async () => {
  const harness = createHarness();
  seedRuntimeEpoch(harness);
  const request = seedFencedRequest(harness, {status: "running", runnerTabId: 30});
  harness.addTab({
    id: 20,
    url: "https://www.xiaohongshu.com/search_result?keyword=test",
    timeOrigin: freshDocument(),
    active: true,
    content: {active: {}},
  });
  harness.addTab({
    id: 30,
    url: runnerUrl(REQUEST_ID, ATTEMPT_ID),
    documentId: "runner-document",
  });
  const acquired = await harness.api.acquireCaptureExecutionLock({
    owner: "unattended_keyword_plan",
    label: "无人值守计划",
    holderId: "runner-holder",
    holderDocumentId: "runner-document",
    holderTabId: 30,
  });
  assert.equal(acquired.ok, true);
  const begun = await harness.sendBackgroundMessage(
    {
      type: "onstarvoice:begin-capture-task",
      taskId: TASK_KEY,
      attemptId: ATTEMPT_ID,
      sourceTabId: 20,
      platform: "xiaohongshu",
    },
    {
      documentId: "runner-document",
      tab: {id: 30, url: runnerUrl(REQUEST_ID, ATTEMPT_ID)},
      url: runnerUrl(REQUEST_ID, ATTEMPT_ID),
    },
  );
  assert.equal(begun.ok, true, JSON.stringify(begun));
  assert.notEqual(harness.api.getCaptureTaskGroup(TASK_KEY), null);
  harness.storage[REQUEST_KEY] = {...request, status: "needs_action", runnerTabId: 30};

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.lockReleased, true);
  assert.equal(result.residueReleased, true);
  assert.equal(harness.api.getCaptureTaskGroup(TASK_KEY), null);
  assert.equal(harness.api.getCaptureDebugSessionByTaskId(TASK_KEY), null);
  assert.equal(harness.tabs.has(20), true, "foreground source tab is kept");
  assert.deepEqual(harness.removedTabIds, [30]);
  assert.equal(harness.storage[REQUEST_KEY].status, "needs_action");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

// ==================== 页面状态 ====================

test("closed, discarded and frozen pages", async () => {
  const closed = createHarness();
  seedTypicalFence(closed);
  closed.tabs.delete(20);
  const closedResult = await runCheck(closed);
  assert.equal(closedResult.accepted, true, JSON.stringify(closedResult));
  assert.equal(targetFor(closedResult, 20).evidence, "tab_closed");
  assertCheckSafety(closed, {allowedRemovedTabIds: [30]});

  const discarded = createHarness();
  seedTypicalFence(discarded);
  discarded.tabs.get(20).discarded = true;
  const discardedResult = await runCheck(discarded);
  assert.equal(discardedResult.accepted, true, JSON.stringify(discardedResult));
  assert.equal(targetFor(discardedResult, 20).evidence, "tab_discarded");
  assertCheckSafety(discarded, {allowedRemovedTabIds: [30]});

  const frozen = createHarness();
  seedTypicalFence(frozen);
  frozen.tabs.get(20).frozen = true;
  const frozenResult = await runCheck(frozen);
  assert.equal(frozenResult.reason, "tab_frozen");
  assert.equal(frozenResult.retryable, true);
  assertCheckSafety(frozen);
});

test("an attributed page that left the platform is proven only after ten minutes off-site", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.tabs.get(20).url = "https://www.example.com/";

  const first = await runCheck(harness);
  assert.equal(first.reason, "off_platform_observing");
  assert.equal(first.retryable, true);
  const seen = harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20];
  assert.equal(seen.requestId, REQUEST_ID);
  assertCheckSafety(harness);

  harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20].firstSeenAt =
    Date.now() - 5 * 60 * 1000;
  const early = await runCheck(harness, buildOffer({checkId: "check-2"}));
  assert.equal(early.reason, "off_platform_observing", "five minutes is not enough");

  harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20].firstSeenAt =
    Date.now() - 11 * 60 * 1000;
  const second = await runCheck(harness, buildOffer({checkId: "check-3"}));
  assert.equal(second.accepted, true, JSON.stringify(second));
  assert.equal(targetFor(second, 20).evidence, "navigated_off_platform");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("an attributed page that comes back to the platform restarts its off-site window", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.storage[STOP_FENCE_STORE_KEY] = {
    version: 1,
    entries: {},
    offPlatformSeen: {
      [SEEN_20]: {requestId: REQUEST_ID, tabId: 20, firstSeenAt: Date.now() - 11 * 60 * 1000},
      "20:other-request": {requestId: "other-request", tabId: 20, firstSeenAt: Date.now() - 11 * 60 * 1000},
      "21:other-request": {requestId: "other-request", tabId: 21, firstSeenAt: Date.now() - 11 * 60 * 1000},
    },
  };
  harness.setDocument(20, {timeOrigin: oldDocument()});

  const back = await runCheck(harness);
  assert.equal(back.reason, "old_document_uninspectable");
  const seenAfterReturn = harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen;
  assert.equal(seenAfterReturn[SEEN_20], undefined);
  assert.equal(
    seenAfterReturn["20:other-request"],
    undefined,
    "the page came back, so every request's window for it restarts",
  );
  assert.ok(seenAfterReturn["21:other-request"], "other pages keep their windows");

  harness.tabs.get(20).url = "https://www.example.com/";
  const leftAgain = await runCheck(harness, buildOffer({checkId: "check-2"}));
  assert.equal(leftAgain.reason, "off_platform_observing");
  assertCheckSafety(harness);
});

test("two fenced requests that attribute the same off-site page keep separate ten-minute windows", async () => {
  const harness = createHarness();
  seedTypicalFence(harness, {lock: false});
  harness.tabs.delete(30);
  // 另一个围栏请求（只在台账里）也把 20 号页面记成自己的 runner 页。
  harness.storage[LEDGER_KEY] = {
    version: 1,
    runs: [{id: "other-request", status: "needs_action", attemptId: "other-attempt", runnerTabId: 20}],
  };
  harness.tabs.get(20).url = "https://www.example.com/";
  const offerR = buildOffer();
  const offerOther = buildOffer({
    checkId: "check-other",
    requestId: "other-request",
    taskId: "22222222-2222-4333-8444-555555555555",
  });

  const firstR = await runCheck(harness, offerR);
  const firstOther = await runCheck(harness, offerOther);
  assert.equal(firstR.reason, "off_platform_observing");
  assert.equal(firstOther.reason, "off_platform_observing");
  const seen = harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen;
  assert.ok(seen[SEEN_20]);
  assert.ok(seen["20:other-request"]);

  // 轮流核对不会互相重置：R 的窗口先满 10 分钟，R 先通过。
  seen[SEEN_20].firstSeenAt = Date.now() - 11 * 60 * 1000;
  const otherAgain = await runCheck(harness, buildOffer({...offerOther, checkId: "check-other-2"}));
  assert.equal(otherAgain.reason, "off_platform_observing");
  const provenR = await runCheck(harness, buildOffer({checkId: "check-2"}));
  assert.equal(provenR.accepted, true, JSON.stringify(provenR));
  assert.equal(targetFor(provenR, 20).evidence, "navigated_off_platform");
  assertCheckSafety(harness);
});

test("bare-domain platform pages are outside the sweep unless attributed, and then count as off-site", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.addTab({id: 40, url: "https://xiaohongshu.com/explore/x", timeOrigin: oldDocument()});
  const unattributed = await runCheck(harness);
  assert.equal(unattributed.accepted, true, JSON.stringify(unattributed));
  assert.equal(targetFor(unattributed, 40), undefined);

  const attributed = createHarness();
  seedTypicalFence(attributed);
  attributed.tabs.get(20).url = "https://xiaohongshu.com/explore/x";
  const result = await runCheck(attributed);
  assert.equal(result.reason, "off_platform_observing");
  assertCheckSafety(attributed);
});

// 自动恢复刷新落在 Chrome 错误页（断网、超时、DNS/代理错误）本身就是围栏的
// 来源之一：地址仍是平台地址、状态 complete，扩展脚本进不去。
test("a platform page left on a browser error page is proven after ten minutes, like an off-site page", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.setDocument(20, {errorPage: true});
  harness.content(20).receiver = false;

  const first = await runCheck(harness);
  assert.equal(first.reason, "off_platform_observing", JSON.stringify(first));
  assert.equal(first.retryable, true);
  assert.equal(first.requiresOperator, false);
  assert.equal(targetFor(first, 20).evidence, "off_platform_observing");
  assert.equal(targetFor(first, 20).platform, "xiaohongshu");
  assert.equal(first.pendingTabs[0].title, "浏览器错误页·小红书搜索页");
  assert.match(first.message, /1 个页面停在浏览器错误页/);
  assert.deepEqual(
    harness.sentTabMessages.filter((message) => message.tabId === 20),
    [],
    "an error page is never asked anything",
  );
  assert.equal(harness.storage[LOCK_KEY]?.id, "lock-r");
  assert.deepEqual(harness.removedTabIds, [], "the runner stays open until the page is proven");
  const seen = harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20];
  assert.equal(seen.requestId, REQUEST_ID);
  assertCheckSafety(harness);

  // 仍停在错误页的后续轮次沿用同一个窗口，不重新计时。
  const again = await runCheck(harness, buildOffer({checkId: "check-2"}));
  assert.equal(again.reason, "off_platform_observing");
  assert.equal(
    harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20].firstSeenAt,
    seen.firstSeenAt,
  );

  harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20].firstSeenAt =
    Date.now() - 5 * 60 * 1000;
  const early = await runCheck(harness, buildOffer({checkId: "check-3"}));
  assert.equal(early.reason, "off_platform_observing", "five minutes is not enough");

  harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20].firstSeenAt =
    Date.now() - 11 * 60 * 1000;
  const proven = await runCheck(harness, buildOffer({checkId: "check-4"}));
  assert.equal(proven.accepted, true, JSON.stringify(proven));
  assert.equal(targetFor(proven, 20).evidence, "navigated_off_platform");
  assert.equal(targetFor(proven, 30).evidence, "runner_closed");
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.ok(harness.tabs.has(20), "the error page itself is left alone");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("an unrecorded platform page on a browser error page is observed the same way instead of failing every round", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.addTab({
    id: 50,
    url: "https://www.douyin.com/video/1",
    title: "www.douyin.com",
    timeOrigin: oldDocument(),
  });
  harness.setDocument(50, {errorPage: true});
  const key = `50:${REQUEST_ID}`;

  const first = await runCheck(harness);
  assert.equal(first.reason, "off_platform_observing", JSON.stringify(first));
  assert.equal(targetFor(first, 50).role, "platform_tab");
  assert.equal(targetFor(first, 50).evidence, "off_platform_observing");
  assert.equal(targetFor(first, 50).platform, "douyin");
  assert.equal(targetFor(first, 20).evidence, "content_idle");
  assert.ok(harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[key]);
  assertCheckSafety(harness);

  harness.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[key].firstSeenAt =
    Date.now() - 11 * 60 * 1000;
  const proven = await runCheck(harness, buildOffer({checkId: "check-2"}));
  assert.equal(proven.accepted, true, JSON.stringify(proven));
  assert.equal(targetFor(proven, 50).evidence, "navigated_off_platform");
  assert.ok(harness.tabs.has(50));
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("only Chrome's error-page rejection counts: a real document or any other probe failure restarts the window", async () => {
  const elevenMinutesAgo = () => ({
    version: 1,
    entries: {},
    offPlatformSeen: {
      [SEEN_20]: {requestId: REQUEST_ID, tabId: 20, firstSeenAt: Date.now() - 11 * 60 * 1000},
    },
  });

  // 错误页重新加载出平台文档：按文档判定，窗口清零；再落回错误页要重新计时。
  const reloaded = createHarness();
  seedTypicalFence(reloaded);
  reloaded.storage[STOP_FENCE_STORE_KEY] = elevenMinutesAgo();
  reloaded.setDocument(20, {timeOrigin: oldDocument()});
  const back = await runCheck(reloaded);
  assert.equal(back.reason, "old_document_uninspectable");
  assert.equal(reloaded.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20], undefined);
  reloaded.setDocument(20, {errorPage: true});
  const errorAgain = await runCheck(reloaded, buildOffer({checkId: "check-2"}));
  assert.equal(errorAgain.reason, "off_platform_observing", "the window starts over");
  assertCheckSafety(reloaded);

  // 其它注入失败（无权限、无响应）仍是探测失败，也不沿用旧窗口。
  for (const patch of [{fail: true}, {hang: true}]) {
    const other = createHarness();
    seedTypicalFence(other);
    other.storage[STOP_FENCE_STORE_KEY] = elevenMinutesAgo();
    other.setDocument(20, patch);
    const result = await runCheck(other);
    assert.equal(result.reason, "probe_failed", JSON.stringify(patch));
    assert.equal(targetFor(result, 20).evidence, "probe_failed");
    assert.doesNotMatch(result.message, /错误页/);
    assert.equal(other.storage[STOP_FENCE_STORE_KEY].offPlatformSeen[SEEN_20], undefined);
    assert.equal(other.storage[LOCK_KEY]?.id, "lock-r");
    assertCheckSafety(other);
  }

  // 旧写法（报错里带 chrome-error:// 地址）同样认作错误页。
  const legacy = createHarness();
  seedTypicalFence(legacy);
  const execute = legacy.chrome.scripting.executeScript;
  legacy.chrome.scripting.executeScript = async (options) => {
    if (Number(options?.target?.tabId) === 20) {
      throw new Error(
        'Cannot access contents of url "chrome-error://chromewebdata/". Extension manifest must request permission to access this host.',
      );
    }
    return await execute(options);
  };
  const legacyResult = await runCheck(legacy);
  assert.equal(targetFor(legacyResult, 20).evidence, "off_platform_observing");
  assertCheckSafety(legacy);
});

test("an unrecorded old platform page anywhere in the browser blocks automatic release", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.addTab({
    id: 50,
    url: "https://www.douyin.com/video/1",
    title: "抖音旧详情页",
    timeOrigin: oldDocument(),
  });

  const result = await runCheck(harness);

  assert.equal(result.reason, "old_document_uninspectable");
  assert.equal(targetFor(result, 50).role, "platform_tab");
  assert.equal(result.pendingTabs[0].platform, "douyin");
  assertCheckSafety(harness);
});

test("R unknown on this machine still sweeps every page and only releases a strictly bound lock", async () => {
  const harness = createHarness();
  seedRuntimeEpoch(harness);
  seedLock(harness, {holderTabId: null});
  harness.killDocument("runner-document");
  harness.addTab({
    id: 20,
    url: "https://www.xiaohongshu.com/explore/a",
    timeOrigin: freshDocument(),
    content: {active: {}},
  });

  const result = await runCheck(harness);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.requestKnown, false);
  assert.equal(result.lockReleased, true);
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.equal(targetFor(result, 20).evidence, "content_idle");
  assertCheckSafety(harness);
});

// ==================== 仅释放 ====================

test("release_only closes the terminal runner and releases the exact lock without any page proof", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.setDocument(20, {timeOrigin: oldDocument()});
  harness.content(20).active.set("capture-r", 1);
  harness.resetCallLog();

  const result = plain(await harness.api.releaseStopFenceLocalResourcesForOperator(
    buildOffer({mode: "release_only", checkId: "release-1"}),
  ));

  assert.equal(result.mode, "release_only");
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.reason, "local_release_done");
  assert.equal(result.lockReleased, true);
  assert.equal(result.runnerTabsClosed, 1);
  assert.deepEqual(harness.sentTabMessages, []);
  assert.deepEqual(harness.executeScriptCalls, []);
  assert.equal(harness.storage[LOCK_KEY], undefined);
  const request = harness.storage[REQUEST_KEY];
  assert.equal(request.status, "needs_action");
  assert.equal(request.localClosureStopConfirmation.method, "stop_fence_operator_confirmed");
  assert.equal(request.stopFenceClosure.proofStatus, "operator_confirmed");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("release_only reports local_lock_absent without a bound lock and request_active while R runs", async () => {
  const harness = createHarness();
  seedTypicalFence(harness, {lock: false});
  harness.resetCallLog();
  const absent = await harness.api.releaseStopFenceLocalResourcesForOperator(
    buildOffer({mode: "release_only", checkId: "release-2"}),
  );
  assert.equal(absent.accepted, true);
  assert.equal(absent.reason, "local_lock_absent");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});

  const running = createHarness();
  seedTypicalFence(running);
  running.storage[REQUEST_KEY].status = "running";
  running.resetCallLog();
  const active = await running.api.releaseStopFenceLocalResourcesForOperator(
    buildOffer({mode: "release_only", checkId: "release-3"}),
  );
  assert.equal(active.accepted, false);
  assert.equal(active.reason, "request_active");
  assert.deepEqual(running.removedTabIds, []);
  assert.equal(running.storage[LOCK_KEY].id, "lock-r");
  assertCheckSafety(running);
});

// ==================== 心跳接入、去重与回执 ====================

test("the heartbeat hands stopFenceChecks to one single-flight check and a release triggers a follow-up heartbeat", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.storage["onstarvoice.auth"] = {
    captureAgent: {id: "agent-1", token: "agent-token"},
  };
  harness.setHeartbeatHandler(async (_options, count) => ({
    ok: true,
    commands: [],
    ...(count === 1 ? {stopFenceChecks: [buildOffer()]} : {}),
  }));

  const response = await harness.api.syncCloudTaskAgent({reason: "test", force: true});
  assert.equal(response.ok, true);
  for (let attempt = 0; attempt < 200 && harness.heartbeats.length < 2; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }

  assert.equal(harness.stopFenceCompletions.length, 1);
  const completion = harness.stopFenceCompletions[0];
  assert.equal(completion.token, "agent-token");
  assert.equal(completion.checkId, "check-1");
  assert.equal(completion.taskId, SERVER_TASK_ID);
  assert.equal(completion.requestId, REQUEST_ID);
  assert.equal(completion.result.accepted, true);
  assert.equal(harness.heartbeats.length >= 2, true, "released:true triggers a heartbeat");
  const entry = harness.storage[STOP_FENCE_STORE_KEY].entries["check-1"];
  assert.equal(entry.state, "done");
  assert.equal(entry.posted, true);
});

test("the same checkId is not executed twice and a check already in flight is skipped", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.content(20).hang = true;
  harness.api.timing.contentQueryTimeoutMs = 120;
  const credential = {token: "agent-token"};

  const first = harness.api.runStopFenceChecksFromHeartbeat([buildOffer()], credential);
  const concurrent = await harness.api.runStopFenceChecksFromHeartbeat(
    [buildOffer()],
    credential,
  );
  assert.equal(concurrent.reason, "check_in_flight");
  const firstResult = await first;
  assert.equal(firstResult.action, "executed");
  assert.equal(harness.stopFenceCompletions.length, 1);

  const again = await harness.api.runStopFenceChecksFromHeartbeat([buildOffer()], credential);
  assert.equal(again.handled, 0);
  assert.equal(harness.stopFenceCompletions.length, 1);
});

test("client errors discard the result while 5xx and network errors keep it for a resend", async () => {
  for (const status of [400, 403, 404, 409]) {
    const harness = createHarness();
    seedTypicalFence(harness);
    harness.setStopFenceCompletionHandler(async () => ({
      ok: false,
      status,
      reason: status === 404 ? "endpoint_missing" : "stop_fence_check_stale",
    }));
    await harness.api.runStopFenceChecksFromHeartbeat([buildOffer()], {token: "t"});
    const entry = harness.storage[STOP_FENCE_STORE_KEY].entries["check-1"];
    assert.equal(entry.posted, true, String(status));
    assert.equal(entry.result, null, String(status));
    const again = await harness.api.runStopFenceChecksFromHeartbeat([buildOffer()], {token: "t"});
    assert.equal(again.handled, 0, String(status));
    assert.equal(harness.stopFenceCompletions.length, 1, String(status));
  }

  for (const failure of [
    {ok: false, status: 503, reason: "server_busy"},
    {ok: false, status: 429, reason: "rate_limited"},
    {ok: false, reason: "network_error"},
  ]) {
    const harness = createHarness();
    seedTypicalFence(harness);
    let calls = 0;
    harness.setStopFenceCompletionHandler(async () => {
      calls += 1;
      return calls === 1 ? failure : {ok: true, released: false};
    });
    const first = await harness.api.runStopFenceChecksFromHeartbeat([buildOffer()], {token: "t"});
    assert.equal(first.action, "executed");
    const entry = harness.storage[STOP_FENCE_STORE_KEY].entries["check-1"];
    assert.equal(entry.posted, false, failure.reason);
    assert.ok(entry.result, failure.reason);
    harness.resetCallLog();
    const resend = await harness.api.runStopFenceChecksFromHeartbeat([buildOffer()], {token: "t"});
    assert.equal(resend.action, "redelivered", failure.reason);
    assert.deepEqual(
      plain(harness.stopFenceCompletions[1].result),
      plain(harness.stopFenceCompletions[0].result),
      "the cached result is resent unchanged",
    );
    assert.deepEqual(harness.executeScriptCalls, [], "resend does not re-run the sweep");
    assert.equal(harness.storage[STOP_FENCE_STORE_KEY].entries["check-1"].posted, true);
  }
});

// 服务端对未完成的仅释放回执答 200 {ok:true, localRelease:'pending'}，3 分钟后
// 以同一 checkId 重发（capture-stop-fence.js completeLocalReleaseReceipt）。
function releaseOnlyServer(harness) {
  harness.setStopFenceCompletionHandler(async (options) => (
    options.result.accepted
      ? {ok: true, localRelease: "done", message: "节点已释放本机执行锁"}
      : {
          ok: true,
          localRelease: "pending",
          nextIssueAt: new Date(Date.now() + 180000).toISOString(),
        }
  ));
}

function seedSuccessorInSlot(harness, status = "running") {
  const fenced = harness.storage[REQUEST_KEY];
  harness.storage[ARCHIVE_KEY] = {
    version: 1,
    requests: {[REQUEST_ID]: {...fenced, archivedAt: new Date().toISOString()}},
  };
  harness.storage[REQUEST_KEY] = {
    ...fenced,
    id: "successor-request",
    status,
    attemptId: "successor-attempt",
    previousAttemptId: "",
    error: null,
    stopFenceEvidence: undefined,
  };
}

test("a release_only receipt that did not release is retried when the server re-offers the same checkId", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  seedSuccessorInSlot(harness, "running");
  releaseOnlyServer(harness);
  const offer = buildOffer({mode: "release_only", checkId: "release-1"});
  const credential = {token: "agent-token"};

  const first = plain(await harness.api.runStopFenceChecksFromHeartbeat([offer], credential));
  assert.equal(first.action, "executed");
  assert.equal(first.result.reason, "local_release_failed");
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r");
  const entry = harness.storage[STOP_FENCE_STORE_KEY].entries["release-1"];
  assert.equal(entry.posted, true);
  assert.ok(entry.retryAt > Date.now(), "the retry waits for the server's re-offer");

  // 服务端的 3 分钟节流之内同一 checkId 再来：不重跑。
  const early = plain(await harness.api.runStopFenceChecksFromHeartbeat([offer], credential));
  assert.equal(early.handled, 0);
  assert.equal(harness.stopFenceCompletions.length, 1);

  // 接替的任务结束了；服务端 3 分钟后以同一 checkId 重发。
  harness.storage[REQUEST_KEY] = {...harness.storage[REQUEST_KEY], status: "completed"};
  harness.storage[STOP_FENCE_STORE_KEY].entries["release-1"].retryAt = Date.now() - 1;
  const retried = plain(await harness.api.runStopFenceChecksFromHeartbeat([offer], credential));
  assert.equal(retried.action, "executed", JSON.stringify(retried));
  assert.equal(retried.result.reason, "local_release_done");
  assert.equal(harness.stopFenceCompletions.length, 2);
  assert.equal(harness.storage[LOCK_KEY], undefined);
  assert.equal(harness.storage[STOP_FENCE_STORE_KEY].entries["release-1"].retryAt, 0);

  // 已完成释放：同一 checkId 再来也不再执行。
  const done = plain(await harness.api.runStopFenceChecksFromHeartbeat([offer], credential));
  assert.equal(done.handled, 0);
  assert.equal(harness.stopFenceCompletions.length, 2);
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("a delivered check receipt stays final even if the same checkId comes back", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.content(20).active.set("capture-other", 1);
  harness.setStopFenceCompletionHandler(async () => ({
    ok: true,
    released: false,
    nextIssueAt: new Date(Date.now() + 180000).toISOString(),
  }));
  const credential = {token: "agent-token"};

  const first = plain(await harness.api.runStopFenceChecksFromHeartbeat([buildOffer()], credential));
  assert.equal(first.result.reason, "tab_busy_unattributed");
  const entry = harness.storage[STOP_FENCE_STORE_KEY].entries["check-1"];
  assert.equal(entry.retryAt, 0, "check retries always come with a new checkId");
  entry.at = Date.now() - 60 * 60 * 1000;
  const again = plain(await harness.api.runStopFenceChecksFromHeartbeat([buildOffer()], credential));
  assert.equal(again.handled, 0);
  assert.equal(harness.stopFenceCompletions.length, 1);
});

test("release_only runs before the same heartbeat's create command, so the new task never meets R's lock", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.storage["onstarvoice.auth"] = {
    captureAgent: {id: "agent-1", token: "agent-token"},
  };
  releaseOnlyServer(harness);
  const executed = [];
  harness.context.executeCloudTaskAgentCommand = async (command) => {
    executed.push({
      id: command.id,
      lockPresent: Boolean(harness.storage[LOCK_KEY]),
      receiptsBefore: harness.stopFenceCompletions.length,
    });
  };
  harness.setHeartbeatHandler(async (_options, count) => {
    // 只约束心跳响应之后的动作（心跳前段的账号探测等与本次无关）。
    if (count === 1) harness.resetCallLog();
    return {
      ok: true,
      commands: count === 1 ? [{id: "command-create", commandType: "create"}] : [],
      ...(count === 1
        ? {
            stopFenceChecks: [
              buildOffer({mode: "release_only", checkId: "release-1"}),
            ],
          }
        : {}),
    };
  });

  const response = await harness.api.syncCloudTaskAgent({reason: "test", force: true});

  assert.equal(response.ok, true);
  assert.deepEqual(plain(executed), [
    {id: "command-create", lockPresent: false, receiptsBefore: 1},
  ]);
  assert.equal(harness.stopFenceCompletions[0].result.reason, "local_release_done");
  assertCheckSafety(harness, {allowedRemovedTabIds: [30]});
});

test("release_only waits for a check already in flight, but never holds the commands past its budget", async () => {
  const waits = createHarness();
  seedTypicalFence(waits);
  waits.storage["onstarvoice.auth"] = {
    captureAgent: {id: "agent-1", token: "agent-token"},
  };
  releaseOnlyServer(waits);
  // 一次正在进行的核对：页面的内容查询要等到超时。
  waits.api.timing.contentQueryTimeoutMs = 400;
  waits.content(20).hang = true;
  const executed = [];
  waits.context.executeCloudTaskAgentCommand = async (command) => {
    executed.push({
      id: command.id,
      lockPresent: Boolean(waits.storage[LOCK_KEY]),
      receipts: waits.stopFenceCompletions.map((entry) => entry.result.mode),
    });
  };
  waits.setHeartbeatHandler(async (_options, count) => ({
    ok: true,
    commands: count === 1 ? [{id: "command-create", commandType: "create"}] : [],
    ...(count === 1
      ? {stopFenceChecks: [buildOffer({mode: "release_only", checkId: "release-1"})]}
      : {}),
  }));
  const inFlight = waits.api.runStopFenceChecksFromHeartbeat(
    [buildOffer({checkId: "check-in-flight"})],
    {token: "agent-token"},
  );
  await waits.api.syncCloudTaskAgent({reason: "test", force: true});
  await inFlight;
  assert.deepEqual(plain(executed), [
    {id: "command-create", lockPresent: false, receipts: ["check", "release_only"]},
  ]);

  const bounded = createHarness();
  seedTypicalFence(bounded);
  bounded.storage["onstarvoice.auth"] = {
    captureAgent: {id: "agent-1", token: "agent-token"},
  };
  bounded.api.timing.releaseOnlyWaitMs = 40;
  bounded.api.timing.contentQueryTimeoutMs = 1500;
  bounded.content(20).hang = true;
  const boundedExecuted = [];
  bounded.context.executeCloudTaskAgentCommand = async (command) => {
    boundedExecuted.push(command.id);
  };
  bounded.setHeartbeatHandler(async (_options, count) => ({
    ok: true,
    commands: count === 1 ? [{id: "command-create", commandType: "create"}] : [],
    ...(count === 1
      ? {stopFenceChecks: [buildOffer({mode: "release_only", checkId: "release-1"})]}
      : {}),
  }));
  const slowCheck = bounded.api.runStopFenceChecksFromHeartbeat(
    [buildOffer({checkId: "check-in-flight"})],
    {token: "agent-token"},
  );
  const startedAt = Date.now();
  await bounded.api.syncCloudTaskAgent({reason: "test", force: true});
  assert.deepEqual(boundedExecuted, ["command-create"]);
  assert.ok(Date.now() - startedAt < 1000, "commands are not held until the check ends");
  await slowCheck;
});

test("the overall deadline reports checked and unresolved pages as check_timeout", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  harness.api.timing.deadlineMs = 60;
  harness.api.timing.probeTimeoutMs = 1000;
  harness.setDocument(20, {hang: true});

  const result = await runCheck(harness);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "check_timeout");
  assert.equal(result.sweepComplete, false);
  assert.equal(result.unresolvedTabCount, 1);
  assert.deepEqual(result.pendingTabIds, [20]);
  assert.equal(harness.tabs.has(30), true);
  assertCheckSafety(harness);
});

// ==================== 围栏证据、加载标识、中继登记 ====================

test("the automatic-recovery fence records which pages failed without changing the 0.4.15 outcome", async () => {
  const harness = createHarness();
  seedRuntimeEpoch(harness);
  const request = seedFencedRequest(harness, {
    status: "running",
    attemptId: "attempt-1",
    previousAttemptId: "",
    recoveryCount: 0,
    error: null,
    stopFenceEvidence: undefined,
    progress: {runnerTabId: 74, captureRequestId: "capture-74", phase: "capturing"},
  });
  seedLock(harness, {
    holderTabId: 74,
    captureTaskAttemptId: "attempt-1",
    expiresAt: Date.now() + 60_000,
  });
  harness.addTab({id: 74, url: "https://www.xiaohongshu.com/explore/x", content: {active: {}}});
  harness.content(74).receiver = false;
  harness.chrome.tabs.reload = async () => {
    throw new Error("reload failed");
  };

  const result = await harness.api.recoverUnattendedKeywordRunRequest(request, {
    healthy: false,
    reason: "business_progress_stalled",
  });

  assert.equal(result.reason, "previous_capture_stop_unconfirmed");
  const stored = harness.storage[REQUEST_KEY];
  assert.equal(stored.status, "needs_action");
  assert.equal(stored.error.code, "PREVIOUS_CAPTURE_STOP_UNCONFIRMED");
  assert.equal(stored.previousAttemptId, "attempt-1");
  assert.equal(harness.storage[LOCK_KEY].id, "lock-r", "lock kept as in 0.4.15");
  const evidence = plain(stored.stopFenceEvidence);
  assert.equal(evidence.version, 1);
  assert.equal(evidence.runtimeEpochId, "epoch-current");
  assert.equal(evidence.runtimeEpochOrigin, "extension_load");
  assert.equal(evidence.captureRequestId, "capture-74");
  assert.equal(evidence.lockIdentity.id, "lock-r");
  assert.equal(evidence.lockIdentity.captureTaskId, TASK_KEY);
  assert.deepEqual(
    evidence.targets.map(({tabId, role}) => [tabId, role]),
    [[74, "progress_tab"]],
  );
  assert.equal(evidence.failedTabId, 74);
  assert.ok(evidence.failedReason);
});

test("the pending-recovery and runner-refresh fences also record evidence", async () => {
  const pending = createHarness();
  seedRuntimeEpoch(pending);
  const pendingRequest = seedFencedRequest(pending, {
    status: "recovering",
    recoveryPendingLaunch: true,
    recoveryWaitUntil: new Date(Date.now() - 1000).toISOString(),
    error: null,
    stopFenceEvidence: undefined,
    progress: {runnerTabId: 75, captureRequestId: "capture-75", phase: "waiting_automatic_recovery"},
  });
  seedLock(pending, {holderTabId: 76, expiresAt: Date.now() + 60_000});
  pending.addTab({id: 75, url: "https://www.douyin.com/search/x", content: {active: {}}});
  pending.addTab({id: 76, url: "https://www.douyin.com/video/1", content: {active: {}}});
  pending.content(75).receiver = false;
  pending.content(76).receiver = false;
  pending.chrome.tabs.reload = async () => {
    throw new Error("reload failed");
  };
  const launched = await pending.context.launchPendingUnattendedRecovery(pendingRequest);
  assert.equal(launched.reason, "previous_capture_stop_unconfirmed");
  const pendingEvidence = plain(pending.storage[REQUEST_KEY].stopFenceEvidence);
  assert.deepEqual(
    pendingEvidence.targets.map(({tabId, role}) => [tabId, role]),
    [[76, "lock_holder"], [75, "progress_tab"]],
  );
  assert.equal(pendingEvidence.failedTabId, 76);

  const refresh = createHarness();
  seedRuntimeEpoch(refresh);
  seedFencedRequest(refresh, {
    status: "running",
    runnerTabId: 42,
    error: null,
    stopFenceEvidence: undefined,
    progress: {runnerTabId: 91, captureRequestId: "capture-91"},
  });
  seedLock(refresh, {holderTabId: 91, expiresAt: Date.now() + 60_000});
  refresh.addTab({id: 91, url: "https://www.xiaohongshu.com/explore/y", content: {active: {}}});
  refresh.content(91).receiver = false;
  refresh.chrome.tabs.reload = async () => {
    throw new Error("reload failed");
  };
  const blocked = await refresh.api.claimUnattendedKeywordRun({
    requestId: REQUEST_ID,
    senderTabId: 42,
    senderDocumentId: "new-document",
    holderId: "new-holder",
  });
  assert.equal(blocked.reason, "previous_capture_stop_unconfirmed");
  const refreshEvidence = plain(refresh.storage[REQUEST_KEY].stopFenceEvidence);
  assert.equal(refreshEvidence.lockIdentity.holderDocumentId, "new-document");
  assert.deepEqual(
    refreshEvidence.targets.map(({tabId, role}) => [tabId, role]),
    [[91, "lock_holder"]],
  );
  assert.equal(refresh.storage[REQUEST_KEY].error.code, "PREVIOUS_CAPTURE_STOP_UNCONFIRMED");
});

test("the runtime epoch is created once per load and only its creator may label the origin", async () => {
  const harness = createHarness();
  const created = await harness.api.ensureRuntimeEpoch();
  assert.equal(created.known, true);
  assert.equal(created.origin, "unknown");
  const again = await harness.api.ensureRuntimeEpoch();
  assert.equal(again.id, created.id);

  assert.equal(await harness.api.markRuntimeEpochOrigin("browser_startup"), true);
  assert.equal(harness.sessionStore[EPOCH_KEY].origin, "browser_startup");
  // extension_load 更保守，可以覆盖；反之不行。
  assert.equal(await harness.api.markRuntimeEpochOrigin("extension_load"), true);
  assert.equal(await harness.api.markRuntimeEpochOrigin("browser_startup"), false);
  assert.equal(harness.sessionStore[EPOCH_KEY].origin, "extension_load");

  const restarted = createHarness();
  restarted.sessionStore[EPOCH_KEY] = {id: "older", startedAt: Date.now() - 1000, origin: "unknown"};
  assert.equal(await restarted.api.markRuntimeEpochOrigin("browser_startup"), false);
  assert.equal(restarted.sessionStore[EPOCH_KEY].origin, "unknown");

  const noSession = createHarness({sessionStorage: false});
  const fallback = await noSession.api.ensureRuntimeEpoch();
  assert.equal(fallback.known, false);
  assert.equal(fallback.origin, "unknown");

  const epoch = {known: true, origin: "extension_load", startedAt: 1_000_000};
  assert.equal(harness.api.isDocumentFromCurrentRuntime(1_001_000, epoch), false);
  assert.equal(harness.api.isDocumentFromCurrentRuntime(1_003_000, epoch), true);
  assert.equal(
    harness.api.isDocumentFromCurrentRuntime(1, {...epoch, origin: "browser_startup"}),
    true,
  );
});

test("relay-to-content registers its sender while in flight and internal cancels stay unowned", async () => {
  const harness = createHarness();
  harness.addTab({id: 7, url: "https://www.xiaohongshu.com/explore/z", content: {active: {}}});
  let release;
  harness.content(7).onAction = () => new Promise((resolvePromise) => {
    release = () => resolvePromise({ok: true, echoed: true});
  });
  const relay = harness.sendBackgroundMessage(
    {
      type: "onstarvoice:relay-to-content",
      tabId: 7,
      payload: {action: "applyBatchSearchFilters", taskId: TASK_KEY},
    },
    {
      documentId: "runner-document",
      tab: {id: 30, url: runnerUrl(REQUEST_ID, ATTEMPT_ID)},
      url: runnerUrl(REQUEST_ID, ATTEMPT_ID),
    },
  );
  for (let attempt = 0; attempt < 50 && !release; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  }
  const [entry] = plain(harness.api.inFlightRelays());
  assert.equal(entry.tabId, 7);
  assert.equal(entry.action, "applyBatchSearchFilters");
  assert.equal(entry.captureRequestId, "");
  assert.equal(entry.taskId, TASK_KEY);
  assert.equal(entry.senderTabId, 30);
  assert.equal(entry.senderDocumentId, "runner-document");
  assert.equal(entry.runnerRequestId, REQUEST_ID);
  assert.equal(entry.runnerAttemptId, ATTEMPT_ID);
  assert.equal(entry.internal, false);
  assert.equal(harness.api.listRequestRelays(REQUEST_ID, "").length, 1);
  release();
  const response = await relay;
  assert.deepEqual(plain(response), {ok: true, data: {ok: true, echoed: true}});
  assert.deepEqual(plain(harness.api.inFlightRelays()), []);

  // 内部取消中继（relayCancelToTabs）不传 owner。
  harness.content(7).onAction = null;
  let internalEntry = null;
  harness.content(7).receiver = true;
  const originalSendMessage = harness.chrome.tabs.sendMessage;
  harness.chrome.tabs.sendMessage = async (tabId, payload) => {
    if (payload?.action === "cancelCapture") {
      internalEntry = harness.api.inFlightRelays()[0] || null;
    }
    return await originalSendMessage(tabId, payload);
  };
  await harness.context.relayCancelToTabs([7], {captureRequestId: "capture-x"});
  assert.equal(internalEntry.internal, true);
  assert.equal(internalEntry.runnerRequestId, "");
  assert.deepEqual(plain(harness.api.inFlightRelays()), []);
});

// ==================== content-v2 ====================

test("content-v2 inspectCaptureActivity reports targetCount and activeRequests (at most 20, ids cut to 200)", () => {
  assert.match(
    contentSource,
    /case "inspectCaptureActivity":\s*\n\s*handleInspectCaptureActivity\(request, sendResponseWithDiagnostics\);/,
  );

  const idle = inspectWithRealContentHandler([]);
  assert.deepEqual(idle, {
    ok: true,
    captureRequestId: "",
    targetActive: false,
    activeCount: 0,
    targetCount: 0,
    activeRequests: [],
  });

  const busy = [["capture-a", 2], ["capture-b", 1], ["capture-zero", 0]];
  assert.deepEqual(inspectWithRealContentHandler(busy), {
    ok: true,
    captureRequestId: "",
    targetActive: true,
    activeCount: 3,
    targetCount: 3,
    activeRequests: [
      {id: "capture-a", count: 2},
      {id: "capture-b", count: 1},
    ],
  });
  // 原有字段语义不变（waitForContentCaptureToSettle 只读它们）。
  const targeted = inspectWithRealContentHandler(busy, {captureRequestId: "capture-b"});
  assert.equal(targeted.captureRequestId, "capture-b");
  assert.equal(targeted.targetActive, true);
  assert.equal(targeted.activeCount, 3);
  assert.equal(targeted.targetCount, 1);
  const settled = inspectWithRealContentHandler(busy, {captureRequestId: "capture-gone"});
  assert.equal(settled.targetActive, false);
  assert.equal(settled.targetCount, 0);

  const longId = `capture-${"x".repeat(300)}`;
  const many = [
    [longId, 1],
    ...Array.from({length: 24}, (_, index) => [`capture-${index}`, 1]),
  ];
  const truncated = inspectWithRealContentHandler(many);
  assert.equal(truncated.activeCount, 25);
  assert.equal(truncated.activeRequests.length, 20);
  assert.equal(truncated.activeRequests[0].id, longId.slice(0, 200));
});

test("the background never attributes a page whose activity list was cut at 20 entries", async () => {
  const harness = createHarness();
  seedTypicalFence(harness);
  const content = harness.content(20);
  content.active.set("capture-r", 1);
  for (let index = 0; index < 20; index += 1) {
    content.active.set(`capture-other-${index}`, 1);
  }

  const result = await runCheck(harness);

  assert.equal(result.reason, "tab_busy_unattributed");
  assert.equal(
    harness.sentTabMessages.some(({payload}) => payload.action === "cancelCapture"),
    false,
  );
  assertCheckSafety(harness);
});

// ==================== cloud-task-agent ====================

test("the cloud agent advertises previousCaptureStopCheckV1 and posts receipts to the dedicated route", async () => {
  const requests = [];
  const context = vm.createContext({
    AbortController,
    Date,
    URL,
    clearTimeout,
    setTimeout,
    async fetch(url, init) {
      requests.push({url, init});
      return {
        status: 200,
        ok: true,
        async json() {
          return {ok: true, released: true};
        },
      };
    },
  });
  vm.runInContext(cloudTaskAgentSource, context, {filename: "utils/cloud-task-agent.js"});
  const agent = context.OnStarvoiceCloudTaskAgent;

  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "client", appVersion: "0.4.16"},
    ledger: {runs: []},
    agentId: "agent-1",
    taskStateKnown: true,
  });
  assert.equal(payload.agent.capabilities.previousCaptureStopCheckV1, true);

  const response = await agent.completeStopFenceCheck({
    token: "agent-token",
    checkId: "check/1",
    taskId: SERVER_TASK_ID,
    requestId: REQUEST_ID,
    result: {version: 1, accepted: true},
    fetchImpl: context.fetch,
    baseUrls: ["https://api.example.test"],
  });
  assert.equal(response.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.example.test/api/capture-cloud/agent/stop-fence-checks/check%2F1/complete",
  );
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer agent-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    taskId: SERVER_TASK_ID,
    requestId: REQUEST_ID,
    result: {version: 1, accepted: true},
  });

  const skipped = await agent.completeStopFenceCheck({token: "t", checkId: ""});
  assert.equal(skipped.reason, "missing_check_id");
});
