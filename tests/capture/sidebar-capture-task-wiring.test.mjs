import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);
const sidebarHtml = await readFile(
  new URL("../../sidebar/sidebar.html", import.meta.url),
  "utf8",
);
const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);

function readSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function readFunctionSection(startMarker, endMarker) {
  return readSourceSection(sidebarSource, startMarker, endMarker);
}

test("observer sidebar renders the active cloud run before Debug attaches", () => {
  const displaySection = readFunctionSection(
    "function buildKeywordRunDisplayPlan(",
    "function clearKeywordPlanProgressCountdown(",
  );
  assert.match(displaySection, /request\.planSnapshot/u);
  assert.match(displaySection, /lastRunRequestId:\s*requestId/u);
  assert.match(displaySection, /unattendedRequestId:\s*requestId/u);
  assert.match(displaySection, /cloudAssigned:\s*request\.cloudAssigned === true/u);

  const loadSection = readFunctionSection(
    "async function loadActiveKeywordRunState()",
    "function shouldRefreshDataPoolForKeywordPlan(",
  );
  assert.match(
    loadSection,
    /onstarvoice:get-unattended-keyword-run-state/u,
  );
  assert.match(loadSection, /renderActiveKeywordRunState\(response\.data/u);

  const storageSection = readFunctionSection(
    "function setupKeywordPlanStorageListener()",
    "function handleUnattendedRunRequestStorageChange(",
  );
  assert.match(storageSection, /renderActiveKeywordRunState\(request\)/u);
  assert.ok(
    storageSection.indexOf("renderActiveKeywordRunState(request)") <
      storageSection.indexOf("handleUnattendedRunRequestStorageChange(request)"),
    "the observer UI must update before runner-only cancellation handling",
  );
});

test("cloud and unattended Debug sessions stop through the exact request id", () => {
  const bindingSection = readFunctionSection(
    "function resolveDisplayedUnattendedSessionBinding(",
    "function renderCaptureDebugSession(",
  );
  const renderSection = readFunctionSection(
    "function renderCaptureDebugSession(runtime = {})",
    "function setupDebugSessionPanelControls()",
  );
  assert.match(bindingSection, /nativeTaskId\.startsWith\("unattended-capture:"\)/u);
  assert.match(renderSection, /resolveDisplayedUnattendedSessionBinding/u);
  assert.match(renderSection, /data-unattended-request-id/u);

  const controlsSection = readFunctionSection(
    "function setupDebugSessionPanelControls()",
    "function setupAuthCodeInputListeners()",
  );
  assert.match(
    controlsSection,
    /cancelUnattendedKeywordPlanFromSidebar\([\s\S]*?panel\?\.dataset\?\.unattendedRequestId/u,
  );

  const cancelSection = readFunctionSection(
    "async function cancelUnattendedKeywordPlanFromSidebar(",
    "function populateKeywordPlanUI(",
  );
  assert.match(cancelSection, /requestId:\s*exactRequestId/u);
  assert.match(cancelSection, /activeKeywordRunState\?\.id/u);
});

test("the stop binding follows the session shown in the panel across native and cloud races", () => {
  const section = readFunctionSection(
    "function resolveDisplayedUnattendedSessionBinding(",
    "function renderCaptureDebugSession(",
  );
  const context = {};
  vm.runInNewContext(
    `${section}\nglobalThis.__resolveBinding = resolveDisplayedUnattendedSessionBinding;`,
    context,
  );
  const resolveBinding = context.__resolveBinding;

  assert.deepEqual(
    {...resolveBinding({
      usingSyntheticSession: false,
      session: {taskId: "unattended-capture:request-A"},
      nativeSession: {taskId: "unattended-capture:request-A"},
      displayPlan: {lastRunRequestId: "request-B"},
    })},
    {unattended: true, requestId: "request-A"},
    "an older native session must not borrow the newer cloud request id",
  );
  assert.deepEqual(
    {...resolveBinding({
      usingSyntheticSession: false,
      session: {
        taskId: "unattended-capture:request-A",
        progress: {unattendedRequestId: "request-B"},
      },
      nativeSession: {
        taskId: "unattended-capture:request-A",
        progress: {unattendedRequestId: "request-B"},
      },
      displayPlan: {lastRunRequestId: "request-C"},
    })},
    {unattended: true, requestId: "request-A"},
    "the native task id fences a stale progress identity",
  );
  assert.deepEqual(
    {...resolveBinding({
      usingSyntheticSession: false,
      session: {taskId: "manual-capture:request-A"},
      nativeSession: {taskId: "manual-capture:request-A"},
      displayPlan: {lastRunRequestId: "request-B"},
    })},
    {unattended: false, requestId: ""},
    "a visible manual Debug session must not stop a deferred cloud task",
  );
  assert.deepEqual(
    {...resolveBinding({
      usingSyntheticSession: true,
      session: {taskId: "unattended-capture:request-B"},
      nativeSession: {taskId: "unattended-capture:request-A"},
      displayPlan: {lastRunRequestId: "request-C"},
    })},
    {unattended: true, requestId: "request-B"},
    "a synthetic panel uses its own selected cloud task identity",
  );
});

test("capture terminal status preserves partial completion when an issue is attached", () => {
  const section = readFunctionSection(
    "function resolveCaptureTaskTerminalStatus(",
    "function resolveUnattendedEnhanceCancellation(",
  );
  const partialIndex = section.indexOf('taskStatus === "partial"');
  const genericErrorIndex = section.indexOf(
    'if (error) return {reason: "failed", status: "failed"};',
  );

  assert.ok(partialIndex > -1);
  assert.ok(genericErrorIndex > partialIndex);
});

test("protective platform stops remain needs-action instead of user-canceled", () => {
  const terminalSection = readFunctionSection(
    "function resolveCaptureTaskTerminalStatus(",
    "function resolveUnattendedEnhanceCancellation(",
  );
  assert.match(
    terminalSection,
    /taskStatus === "needs_action"[\s\S]*reason: "needs_action", status: "needs_action"/u,
  );

  const batchSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "function activateUnattendedRunRequest(",
  );
  const needsActionIndex = batchSection.indexOf(
    'result?.securityBlocked\n      ? "needs_action"',
  );
  const canceledIndex = batchSection.indexOf(
    'result?.canceled || batchKeywordCancelRequested',
    needsActionIndex,
  );
  assert.ok(needsActionIndex > -1);
  assert.ok(canceledIndex > needsActionIndex);
  assert.match(
    batchSection,
    /sidebarTaskError = \{\.\.\.result\.blockingError\}/u,
  );
});

test("blogger capture owns one task session across list and detail work", () => {
  const section = readFunctionSection(
    "async function handleCaptureBloggerData()",
    "// 搜索页:",
  );
  const beginIndex = section.indexOf("await startRequiredCaptureTaskSession({");
  const firstCaptureIndex = section.indexOf("await captureAndSync({");
  const finallyIndex = section.lastIndexOf("} finally {");
  const endIndex = section.indexOf(
    "await endCaptureTaskSession({",
    finallyIndex,
  );
  const finishIndex = section.indexOf("finishSidebarTask(", finallyIndex);

  assert.ok(beginIndex > -1 && beginIndex < firstCaptureIndex);
  assert.ok(finallyIndex > firstCaptureIndex);
  assert.ok(endIndex > finallyIndex && endIndex < finishIndex);
  assert.match(section, /enhanceResult\?\.securityBlocked \|\| enhanceResult\?\.canceled/);
  assert.match(section, /taskStatus = "completed_with_failures"/);
  assert.match(
    section,
    /captureTaskId: captureTaskSessionStarted \? taskContext\.taskId : ""/,
  );
});

test("manual search begins only for the actual run and always ends in finally", () => {
  const section = readFunctionSection(
    "async function handleCaptureSearchData()",
    "function setKeywordStrategyTab(",
  );
  const scheduleIndex = section.indexOf("const scheduledStart =");
  const beginIndex = section.indexOf("await startRequiredCaptureTaskSession({");
  const runIndex = section.indexOf("let searchRound = 0;");
  const finallyIndex = section.lastIndexOf("} finally {");
  const endIndex = section.indexOf(
    "await endCaptureTaskSession({",
    finallyIndex,
  );

  assert.ok(scheduleIndex > -1 && scheduleIndex < beginIndex);
  assert.ok(beginIndex > -1 && beginIndex < runIndex);
  assert.ok(endIndex > finallyIndex);
  assert.match(section, /preferredTabId: searchActiveTabId/);
  assert.match(section, /onProgress: \(p\) => \{\s+handleProgress\(p\);/);
  assert.match(section, /captureTaskId: persistentCaptureTaskId/);
  assert.match(
    section,
    /batchCaptureByKeywords\(\{\s+keywords: \[\.\.\.attemptKeywords\],[\s\S]*?captureTaskId: persistentCaptureTaskId/,
  );
  assert.match(section, /runUnattendedKeywordAttempts\(\{/);
  assert.doesNotMatch(section, /retryFailedEnhancementsAfterRound\(/);
  assert.match(
    section.slice(finallyIndex),
    /buildStreamingSyncTaskIssue\(\s*streamingSyncResult,?\s*\)/,
  );
  assert.match(
    section.slice(finallyIndex),
    /taskStatus = "completed_with_failures";[\s\S]*?taskError = taskError \|\| streamingSyncTaskIssue/,
  );
  assert.match(
    section.slice(finallyIndex),
    /buildStreamingSyncTaskMetadata\(streamingSyncResult\)/,
  );
});

test("batch keyword parent task absorbs hidden streaming sync failures", () => {
  const section = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );

  assert.match(
    section,
    /const streamingSyncTaskIssue = buildStreamingSyncTaskIssue\(\s*streamingSyncResult,?\s*\)/,
  );
  assert.match(
    section,
    /totalFailed > 0 \|\| streamingSyncTaskIssue\s*\? "completed_with_failures"/,
  );
  assert.match(section, /sidebarTaskError = streamingSyncTaskIssue/);
  assert.match(
    section,
    /buildStreamingSyncTaskMetadata\(streamingSyncResult\)/,
  );
  assert.match(
    section,
    /totalFailed === 0 &&\s*!streamingSyncTaskIssue/,
  );
});

test("unattended plan keeps XHS pre-navigation Debug and starts Douyin on the final replacement tab", () => {
  const section = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(request)",
    "async function runCaptureAction({",
  );
  const contextIndex = section.indexOf(
    "unattendedCaptureTaskContext = beginTaskContext({",
  );
  const startIndex = section.indexOf(
    "await startRequiredCaptureTaskSession({",
    contextIndex,
  );
  const xhsStartIndex = section.indexOf(
    'if (captureTaskDebugSupported && platform !== "douyin")',
    startIndex,
  );
  const navigationIndex = section.indexOf(
    "const navigationResult = await navigateActiveTabToKeywordSearchForPlan({",
    xhsStartIndex,
  );
  const finalTabIndex = section.indexOf(
    "const finalSourceTabId = Number(navigationResult?.tabId)",
    navigationIndex,
  );
  const douyinStartIndex = section.indexOf(
    "if (captureTaskDebugSupported && !unattendedCaptureTaskSessionStarted)",
    finalTabIndex,
  );
  const rehydrateIndex = section.indexOf(
    "await beginCaptureTaskSession({",
    douyinStartIndex,
  );
  const batchIndex = section.indexOf(
    "batchRunResult = await handleBatchKeywordCapture({",
    rehydrateIndex,
  );
  const finallyIndex = section.lastIndexOf("} finally {");
  const endIndex = section.indexOf(
    "await endCaptureTaskSession({",
    finallyIndex,
  );
  const releaseIndex = section.indexOf(
    "releaseCaptureTaskOwner(unattendedCaptureTaskContext.taskId)",
    endIndex,
  );
  const completeIndex = section.indexOf(
    "completeTaskContext({",
    releaseIndex,
  );

  assert.ok(contextIndex > -1);
  assert.ok(startIndex > contextIndex);
  assert.ok(xhsStartIndex > startIndex);
  assert.ok(navigationIndex > xhsStartIndex);
  assert.ok(finalTabIndex > navigationIndex);
  assert.ok(douyinStartIndex > finalTabIndex);
  assert.ok(rehydrateIndex > douyinStartIndex);
  assert.ok(batchIndex > rehydrateIndex);
  assert.ok(finallyIndex > batchIndex);
  assert.ok(endIndex > finallyIndex);
  assert.ok(releaseIndex > endIndex);
  assert.ok(completeIndex > releaseIndex);
  assert.match(
    section,
    /taskId: unattendedCaptureTaskContext\.taskId,[\s\S]*?tabId: unattendedSourceTabId/,
  );
  assert.match(
    section,
    /unattendedCaptureTaskContext\.taskId = `unattended-capture:\$\{requestId\}`/,
    "one unattended request must keep one stable Debug task id across runner recovery",
  );
  assert.match(
    section,
    /startRequiredCaptureTaskSession\(\{[\s\S]*?ownerRequired: false/,
    "the transient sidebar runner must not own unattended task lifetime",
  );
  assert.match(
    section,
    /beginCaptureTaskSession\(\{[\s\S]*?ownerRequired: false/,
    "replacement-tab rebinding must remain unattended-owned",
  );
  assert.match(
    section,
    /captureTaskContext: unattendedCaptureTaskContext,\s+captureTaskSessionStarted: unattendedCaptureTaskSessionStarted,\s+captureTaskLifecycleOwnedByCaller:\s+unattendedCaptureTaskSessionStarted/,
  );
});

test("unattended Douyin navigation readiness is bound to the expected URL and keyword", () => {
  const readinessSection = readFunctionSection(
    "async function waitForActiveTabReady(",
    "async function waitForRuntimeSearchPage(",
  );
  assert.match(readinessSection, /expectedUrl\s*=\s*""/);
  assert.match(readinessSection, /expectedKeyword\s*=\s*""/);
  assert.match(readinessSection, /shouldStop\s*=\s*null/);
  assert.match(
    readinessSection,
    /UNATTENDED_SEARCH_BOOTSTRAP_CANCELED/,
  );
  assert.match(readinessSection, /tab\?\.url/);
  assert.doesNotMatch(
    readinessSection,
    /if \(String\(tab\?\.status \|\| ""\) === "complete"\) \{\s*return \{ready: true/,
    "a stale complete tab must not be accepted before its search identity matches",
  );

  const navigationSection = readFunctionSection(
    "async function navigateActiveTabToKeywordSearchForPlan({",
    "function buildUnattendedTaskCounts(",
  );
  assert.match(
    navigationSection,
    /waitForActiveTabReady\(\s*preferredTabId,\s*15000,\s*\{[\s\S]*?expectedUrl:\s*searchUrl,[\s\S]*?expectedKeyword:\s*keyword,/,
  );
  assert.match(
    navigationSection,
    /readyState\.ready\s*\?\s*await waitForRuntimeSearchPage\(\{[\s\S]*?platform,[\s\S]*?tabId:\s*preferredTabId,[\s\S]*?expectedUrl:\s*searchUrl,[\s\S]*?expectedKeyword:\s*keyword,/,
    "runtime readiness must describe the same final tab and search identity",
  );
  assert.match(
    navigationSection,
    /for \(let attempt = 1; attempt <= boundedMaxAttempts; attempt \+= 1\)/,
  );
  assert.match(
    navigationSection,
    /error\.code = "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"/,
  );
});

function createUnattendedNavigationHarness({
  tabReadiness = [],
  runtimeReadiness = [],
  stopAfterTabReadiness = false,
  trackedTabMissing = false,
  queriedTabs = [],
} = {}) {
  const navigationSection = readFunctionSection(
    "async function navigateActiveTabToKeywordSearchForPlan({",
    "function buildUnattendedTaskCounts(",
  );
  const updates = [];
  const retries = [];
  let runtimeChecks = 0;
  let stopRequested = false;
  const tab = {
    id: 101,
    windowId: 7,
    status: "complete",
    url: "https://www.douyin.com/jingxuan",
  };
  const sandbox = vm.createContext({
    UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS: 2,
    UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAY_MS: 0,
    buildSidebarKeywordSearchUrl: (keyword) =>
      `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`,
    chrome: {
      tabs: {
        get: async () => {
          if (trackedTabMissing) throw new Error("No tab with id: 101");
          return {...tab};
        },
        query: async () => queriedTabs.map((entry) => ({...entry})),
        update: async (tabId, patch) => {
          updates.push({tabId, ...patch});
          Object.assign(tab, patch);
          return {...tab};
        },
      },
      windows: {update: async () => ({})},
    },
    detectPlatformFromUrl: (url) =>
      String(url || "").includes("douyin.com") ? "douyin" : "unknown",
    sleep: async () => {},
    waitForActiveTabReady: async () => {
      const ready = Boolean(tabReadiness.shift());
      if (stopAfterTabReadiness) stopRequested = true;
      return {ready, tabId: tab.id, tab: ready ? {...tab} : null};
    },
    waitForRuntimeSearchPage: async () => {
      runtimeChecks += 1;
      return Boolean(runtimeReadiness.shift());
    },
  });
  vm.runInContext(
    `${navigationSection}\nglobalThis.__navigate = navigateActiveTabToKeywordSearchForPlan;`,
    sandbox,
  );
  return {
    navigate: (options = {}) =>
      sandbox.__navigate({
        keyword: "凯迪拉克",
        platform: "douyin",
        tabId: tab.id,
        retryDelayMs: 0,
        shouldStop: () => stopRequested,
        onRetry: async (payload) => retries.push(payload),
        ...options,
      }),
    retries,
    runtimeChecks: () => runtimeChecks,
    updates,
  };
}

test("unattended bootstrap reopens the same keyword after a transient page drift", async () => {
  const harness = createUnattendedNavigationHarness({
    tabReadiness: [false, true],
    runtimeReadiness: [true],
  });

  const result = await harness.navigate();

  assert.equal(result.recovered, true);
  assert.equal(result.attemptCount, 2);
  assert.equal(harness.updates.length, 2);
  assert.equal(harness.updates[0].url, harness.updates[1].url);
  assert.match(harness.updates[0].url, /\/search\/%E5%87%AF%E8%BF%AA%E6%8B%89%E5%85%8B/);
  assert.equal(harness.retries.length, 1);
  assert.equal(harness.retries[0].nextAttempt, 2);
  assert.equal(
    harness.runtimeChecks(),
    1,
    "a failed tab identity must retry immediately instead of waiting on stale runtime state",
  );
});

test("unattended bootstrap retry is bounded and exposes a recoverable error code", async () => {
  const harness = createUnattendedNavigationHarness({
    tabReadiness: [false, false, true],
  });

  await assert.rejects(harness.navigate(), (error) => {
    assert.equal(error.code, "UNATTENDED_SEARCH_BOOTSTRAP_FAILED");
    assert.equal(error.attempts, 2);
    return true;
  });
  assert.equal(harness.updates.length, 2);
  assert.equal(harness.retries.length, 1);
  assert.equal(harness.runtimeChecks(), 0);
});

test("unattended bootstrap retries when the tab is ready but runtime is a video page", async () => {
  const harness = createUnattendedNavigationHarness({
    tabReadiness: [true, true],
    runtimeReadiness: [false, true],
  });

  const result = await harness.navigate();

  assert.equal(result.recovered, true);
  assert.equal(result.attemptCount, 2);
  assert.equal(harness.updates.length, 2);
  assert.equal(harness.runtimeChecks(), 2);
  assert.equal(harness.retries.length, 1);
});

test("unattended bootstrap cannot pass its final fence after cancellation", async () => {
  const harness = createUnattendedNavigationHarness({
    tabReadiness: [true],
    runtimeReadiness: [true],
    stopAfterTabReadiness: true,
  });

  await assert.rejects(harness.navigate(), (error) => {
    assert.equal(error.code, "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED");
    return true;
  });
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.runtimeChecks(), 0);
  assert.equal(harness.retries.length, 0);
});

test("a missing tracked tab never hijacks the user's unrelated active page", async () => {
  const harness = createUnattendedNavigationHarness({
    trackedTabMissing: true,
    queriedTabs: [
      {
        id: 202,
        windowId: 7,
        active: true,
        status: "complete",
        url: "https://www.douyin.com/user/unrelated",
      },
    ],
  });

  await assert.rejects(harness.navigate(), (error) => {
    assert.equal(error.code, "UNATTENDED_SEARCH_BOOTSTRAP_FAILED");
    return true;
  });
  assert.equal(harness.updates.length, 0);
  assert.equal(harness.retries.length, 1);
});

test("tab readiness never promotes an unrelated same-platform tab to the task tab", async () => {
  const readinessSection = readFunctionSection(
    "async function waitForActiveTabReady(",
    "async function waitForRuntimeSearchPage(",
  );
  let now = 0;
  const sandbox = vm.createContext({
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    chrome: {
      tabs: {
        get: async () => {
          throw new Error("No tab with id: 101");
        },
        query: async () => [
          {
            id: 202,
            windowId: 7,
            active: true,
            status: "complete",
            url: "https://www.douyin.com/user/unrelated",
          },
        ],
      },
    },
    detectPlatformFromUrl: (url) =>
      String(url || "").includes("douyin.com") ? "douyin" : "unknown",
    setTimeout: (resolve) => {
      now += 301;
      resolve();
    },
  });
  vm.runInContext(
    `${readinessSection}\nglobalThis.__waitForActiveTabReady = waitForActiveTabReady;`,
    sandbox,
  );

  const result = await sandbox.__waitForActiveTabReady(101, 1, {
    windowId: 7,
    platform: "douyin",
    expectedUrl:
      "https://www.douyin.com/search/%E5%87%AF%E8%BF%AA%E6%8B%89%E5%85%8B?type=general",
    expectedKeyword: "凯迪拉克",
  });

  assert.equal(result.ready, false);
  assert.equal(result.tabId, 101);
});

test("unattended bootstrap retry is reported before keyword batch delegation", () => {
  const section = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(request)",
    "async function runCaptureAction({",
  );
  const navigationIndex = section.indexOf(
    "const navigationResult = await navigateActiveTabToKeywordSearchForPlan({",
  );
  const retryIndex = section.indexOf("onRetry: async ({nextAttempt, maxAttempts})", navigationIndex);
  const batchIndex = section.indexOf("batchRunResult = await handleBatchKeywordCapture({", retryIndex);

  assert.ok(navigationIndex > -1);
  assert.ok(retryIndex > navigationIndex);
  assert.ok(batchIndex > retryIndex);
  assert.match(section.slice(retryIndex, batchIndex), /phase: "recovering_search_page"/);
  assert.match(section.slice(retryIndex, batchIndex), /retried: Math\.max\(0, Number\(nextAttempt\) - 1\)/);
  assert.match(
    section,
    /const bootstrapFailed =\s+error\?\.code === "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"/,
  );
  assert.match(
    section,
    /const terminalStatus = cancellation\?\.status \|\|\s*\(needsAction \? "needs_action" : "failed"\)/,
  );
});

test("unattended final source tab stays pinned through the batch runner", () => {
  const unattendedSection = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(request)",
    "async function runCaptureAction({",
  );
  assert.match(
    unattendedSection,
    /handleBatchKeywordCapture\(\{[\s\S]*?sourceTabId:\s*unattendedSourceTabId,/,
  );

  const handlerSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  const pinnedOptionIndex = handlerSection.indexOf("runOptions.sourceTabId");
  const pinnedLookupIndex = handlerSection.indexOf(
    "await chrome.tabs.get(",
    pinnedOptionIndex,
  );
  const activeFallbackIndex = handlerSection.indexOf(
    "await chrome.tabs.query(",
    pinnedOptionIndex,
  );
  assert.ok(pinnedOptionIndex >= 0, "batch handler must accept sourceTabId");
  assert.ok(
    pinnedLookupIndex > pinnedOptionIndex,
    "batch handler must resolve the caller-provided source tab",
  );
  assert.ok(
    activeFallbackIndex === -1 || pinnedLookupIndex < activeFallbackIndex,
    "an arbitrary active tab may only be used after the pinned source tab fails",
  );
  assert.match(
    handlerSection,
    /const baseBatchOptions = \{[\s\S]*?sourceTabId:\s*activeBatchRunnerTabId,/,
  );

  const captureSyncBatchSection = readSourceSection(
    captureSyncSource,
    "export async function batchCaptureByKeywords({",
    "export async function lightSampleByKeywords({",
  );
  assert.match(captureSyncBatchSection, /sourceTabId\s*=\s*null/);
  const captureSyncPinnedLookupIndex = captureSyncBatchSection.indexOf(
    "await chrome.tabs.get(",
  );
  const captureSyncActiveFallbackIndex = captureSyncBatchSection.indexOf(
    "getCurrentActiveTab()",
  );
  assert.ok(
    captureSyncPinnedLookupIndex >= 0 &&
      captureSyncPinnedLookupIndex < captureSyncActiveFallbackIndex,
    "capture-sync must prefer sourceTabId before falling back to the active tab",
  );
});

test("batch keyword handler reuses caller-owned task lifecycle and threads its id through every phase", () => {
  const section = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  const ensureIndex = section.indexOf(
    "await ensurePersistentCaptureTaskSession();",
  );
  const firstBatchIndex = section.indexOf(
    "const attemptResult = await batchCaptureByKeywords({",
  );
  const finallyIndex = section.lastIndexOf("} finally {");

  assert.match(
    section,
    /const externalCaptureTaskContext =[\s\S]*?runOptions\.captureTaskContext/,
  );
  assert.match(
    section,
    /const captureTaskLifecycleOwnedByCaller =\s+runOptions\.captureTaskLifecycleOwnedByCaller === true/,
  );
  assert.match(
    section,
    /captureTaskContext = externalCaptureTaskContext/,
  );
  assert.ok(ensureIndex > -1 && ensureIndex < firstBatchIndex);
  assert.match(
    section,
    /const baseBatchOptions = \{[\s\S]*?captureTaskId: persistentCaptureTaskId/,
  );
  assert.match(
    section,
    /maybeRunAutoDetailCaptureAfterListCapture\([\s\S]*?captureTaskId: persistentCaptureTaskId/,
  );
  assert.match(
    section,
    /const keywordPlanIndex = keywords\.indexOf\([\s\S]*?const keywordPlanProgress =\s+keywordPlanIndex >= 0[\s\S]*?keywordCurrent: keywordPlanIndex \+ 1,\s+keywordTotal: keywords\.length,[\s\S]*?: \{\};/,
  );
  assert.match(
    section,
    /\.\.\.detailProgress,\s+keyword: capturedKeyword,\s+\.\.\.keywordPlanProgress,/,
  );
  assert.doesNotMatch(
    section,
    /afterKeywordCapture:[\s\S]*?keywordCurrent:\s*current|keywordTotal:\s*total/,
  );
  assert.doesNotMatch(section, /retryFailedEnhancementsAfterRound\(/);
  assert.match(
    section.slice(finallyIndex),
    /captureTaskSessionStarted &&\s+!captureTaskLifecycleOwnedByCaller/,
  );
  assert.match(
    section.slice(finallyIndex),
    /await endCaptureTaskSession\(\{[\s\S]*?releaseCaptureTaskOwner\(persistentCaptureTaskId\)/,
  );
});

test("unattended detail interruption only stops the whole plan for explicit terminal reasons", () => {
  const section = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );

  assert.match(
    section,
    /const resultInterruption = resolveUnattendedEnhanceCancellation\([\s\S]*?if \(enhanceResult\?\.canceled \|\| resultInterruption\.recoverable\)/,
  );
  assert.match(
    section,
    /if \(cancellation\.stopBatch\) \{\s*batchKeywordCancelRequested = true/,
  );
  assert.match(
    section,
    /canceled: false,\s*partial: true,\s*recoverable: true/,
  );
  assert.doesNotMatch(
    section,
    /if \(enhanceResult\?\.canceled \|\| resultInterruption\.recoverable\) \{\s*batchKeywordCancelRequested = true/,
  );
});

test("manual Douyin multi-keyword capture retries only after the first pass", () => {
  const section = readFunctionSection(
    "async function handleCaptureSearchData()",
    "function setKeywordStrategyTab(",
  );

  assert.match(
    section,
    /const runSearchBatchAttempt = \(attemptKeywords\) =>[\s\S]*?batchCaptureByKeywords\(\{[\s\S]*?keywords: \[\.\.\.attemptKeywords\]/u,
  );
  assert.match(
    section,
    /runUnattendedKeywordAttempts\(\{[\s\S]*?maxAttempts: pagePlatform === "douyin" \? 2 : 1/u,
  );
  assert.match(
    section,
    /onRetryScheduled:[\s\S]*?sleepWithStop\([\s\S]*?retryDelay/u,
  );
});

test("one keyword cannot schedule a third detail enhancement attempt", () => {
  const manualSection = readFunctionSection(
    "async function handleCaptureSearchData()",
    "function setKeywordStrategyTab(",
  );
  const unattendedSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  const detailSection = readFunctionSection(
    "async function runDetailCaptureForRecordIds(",
    "/**\n * 处理导出",
  );

  // The single-retry helper owns the complete retry budget. Manual and
  // unattended rounds must never launch another enhancement orchestration.
  assert.doesNotMatch(sidebarSource, /retryFailedEnhancementsAfterRound\(/);
  assert.doesNotMatch(
    manualSection,
    /collectFailedEnhanceRecordIds|enhance_retrying/,
  );
  assert.doesNotMatch(
    unattendedSection,
    /collectFailedEnhanceRecordIds|enhance_retrying/,
  );
  assert.equal(
    (detailSection.match(/runEnhancementWithSingleRetry\(/g) || []).length,
    1,
  );
  assert.equal(
    (detailSection.match(/batchCaptureDetailsForRecords\(/g) || []).length,
    1,
  );
  assert.match(
    detailSection,
    /runAttempt:\s*async \(attemptRecordIds,[\s\S]*?return await batchCaptureDetailsForRecords\(attemptRecordIds,/,
  );
});

test("manual task start fails closed when debugger or tab-group ownership is unavailable", () => {
  const section = readFunctionSection(
    "async function startRequiredCaptureTaskSession(options = {})",
    "const DEFAULT_MONITOR_SETTINGS",
  );

  const bindIndex = section.indexOf("bindCaptureTaskOwner(taskId)");
  const beginIndex = section.indexOf("await beginCaptureTaskSession({");
  assert.ok(bindIndex >= 0 && beginIndex > bindIndex);
  assert.match(section, /supportsPersistentCaptureTaskPlatform\(platform\)/);
  assert.match(section, /capture_task_platform_unsupported/);
  assert.match(section, /const ownerRequired = options\?\.ownerRequired !== false/);
  assert.match(section, /bindCaptureTaskOwner\(taskId\)/);
  assert.match(section, /beginCaptureTaskSession\(\{[\s\S]*?ownerRequired,/);
  assert.match(section, /result\?\.ok === true && result\?\.active === true/);
  assert.match(section, /throw error;/);
});

test("Weibo capture paths keep their non-Debug workflow", () => {
  const supportSection = readFunctionSection(
    "function supportsPersistentCaptureTaskPlatform(platform = \"\")",
    "async function startRequiredCaptureTaskSession(",
  );
  assert.match(
    supportSection,
    /new Set\(\["xiaohongshu", "douyin"\]\)/,
  );

  const bloggerSection = readFunctionSection(
    "async function handleCaptureBloggerData()",
    "// 搜索页:",
  );
  assert.match(
    bloggerSection,
    /if \(supportsPersistentCaptureTaskPlatform\(pagePlatform\)\) \{/,
  );
  assert.match(
    bloggerSection,
    /captureTaskId: captureTaskSessionStarted \? taskContext\.taskId : ""/,
  );
  assert.match(
    bloggerSection,
    /if \(captureTaskSessionStarted\) \{[\s\S]*?endCaptureTaskSession/,
  );

  const searchSection = readFunctionSection(
    "async function handleCaptureSearchData()",
    "function setKeywordStrategyTab(",
  );
  assert.match(
    searchSection,
    /if \(supportsPersistentCaptureTaskPlatform\(pagePlatform\)\) \{/,
  );
  assert.match(
    searchSection,
    /persistentCaptureTaskId = taskContext\.taskId/,
  );
  assert.match(searchSection, /captureTaskId: persistentCaptureTaskId/);
  assert.match(
    searchSection,
    /if \(captureTaskSessionStarted\) \{[\s\S]*?endCaptureTaskSession/,
  );

  const batchSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  assert.match(
    batchSection,
    /const captureTaskDebugSupported =\s+supportsPersistentCaptureTaskPlatform\(pagePlatform\)/,
  );
  assert.match(
    batchSection,
    /persistentCaptureTaskId = captureTaskDebugSupported\s+\? String\(captureTaskContext\?\.taskId \|\| ""\)\.trim\(\)\s+: ""/,
  );
  assert.match(
    batchSection,
    /if \(!captureTaskDebugSupported\) return;/,
  );

  const unattendedSection = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(request)",
    "async function runCaptureAction({",
  );
  assert.match(
    unattendedSection,
    /const startUnattendedCaptureTaskSession = async[\s\S]*?startRequiredCaptureTaskSession/,
  );
  assert.match(
    unattendedSection,
    /if \(captureTaskDebugSupported && platform !== "douyin"\)[\s\S]*?startUnattendedCaptureTaskSession/,
  );
  assert.match(
    unattendedSection,
    /if \(captureTaskDebugSupported && !unattendedCaptureTaskSessionStarted\)[\s\S]*?startUnattendedCaptureTaskSession/,
  );
  assert.match(
    unattendedSection,
    /else if \(unattendedCaptureTaskSessionStarted && sourceTabWasReplaced\)[\s\S]*?beginCaptureTaskSession/,
  );
  assert.match(
    unattendedSection,
    /captureTaskSessionStarted: unattendedCaptureTaskSessionStarted/,
  );
});

test("capture progress rejects stale owners before forwarding into local UI", () => {
  const section = readFunctionSection(
    "function handleProgress(progress)",
    "async function syncRuntimeCommentProgress(",
  );
  const ownerGuardIndex = section.indexOf("const incomingCaptureTaskId");
  const rememberIndex = section.indexOf(
    "progress = rememberCaptureTaskProgressContext(progress)",
  );
  const updateIndex = section.indexOf("void updateCaptureTaskSession({");
  const localPhaseIndex = section.indexOf("const phase = incomingPhase");
  const domIndex = section.indexOf("document.getElementById(");

  assert.ok(ownerGuardIndex > -1 && ownerGuardIndex < rememberIndex);
  assert.match(
    section.slice(ownerGuardIndex, rememberIndex),
    /incomingCaptureTaskId !== currentCaptureTaskId[\s\S]*?return progress/,
  );
  assert.ok(updateIndex > rememberIndex && updateIndex < localPhaseIndex);
  assert.ok(updateIndex < domIndex);
  assert.match(
    section.slice(updateIndex, localPhaseIndex),
    /taskId:\s*incomingCaptureTaskId\s*\|\|\s*captureTaskOwnerTaskId/,
  );
});

test("task surface renders real A/B worker states from progress", () => {
  assert.match(sidebarHtml, /id="debugSessionWorkers"/);
  assert.match(sidebarHtml, /data-worker-index="0"/);
  assert.match(sidebarHtml, /data-worker-index="1"/);
  const section = readFunctionSection(
    "function renderCaptureTaskWorkers(progress = {})",
    "function renderCaptureDebugSession(runtime = {})",
  );
  assert.match(section, /progress\?\.workerStates/);
  assert.match(section, /"queued"/);
  assert.match(section, /"已排队，等待安全导航间隔"/);
  assert.match(section, /"正在预加载下一条"/);
  assert.match(section, /"下一条已加载，等待当前条完成"/);
  assert.match(section, /"下一条已加载，等待安全切换"/);
  assert.match(section, /"正在读取作品详情"/);
});

test("unattended plan renders startup and durable terminal task surfaces", () => {
  const syntheticSection = readFunctionSection(
    "function buildUnattendedSyntheticDebugSession(",
    "function renderCaptureDebugSession(runtime = {})",
  );
  assert.match(
    syntheticSection,
    /!plan\?\.enabled \|\| \(!running && !visibleTerminal\)/,
  );
  assert.match(syntheticSection, /synthetic: true/);
  assert.match(syntheticSection, /unattended: true/);
  assert.match(syntheticSection, /terminal: visibleTerminal/);
  assert.match(syntheticSection, /state: visibleTerminal \? status : "starting"/);
  assert.match(
    syntheticSection,
    /phase: visibleTerminal[\s\S]*?`unattended_\$\{status\}`[\s\S]*?String\(storedProgress\.phase \|\| "initializing_unattended"\)/,
  );

  const renderSection = readFunctionSection(
    "function renderCaptureDebugSession(runtime = {})",
    "function setupDebugSessionPanelControls()",
  );
  assert.match(
    renderSection,
    /const syntheticSession = buildUnattendedSyntheticDebugSession\(\s*runtime,\s*displayPlan,\s*\)/,
  );
  assert.match(
    renderSection,
    /const active = nativeVisible \|\| Boolean\(syntheticSession\)/,
  );
  assert.match(
    renderSection,
    /usingSyntheticSession \? "unattended-synthetic" : "native-debug"/,
  );
  assert.match(
    renderSection,
    /syntheticSession && \(!nativeVisible \|\| syntheticSession\.terminal\)/,
  );

  const statusSection = readFunctionSection(
    "function renderKeywordPlanStatus(plan = keywordPlanState, scope = null)",
    "function isKeywordPlanRunning(plan = {})",
  );
  assert.match(
    statusSection,
    /renderCaptureDebugSession\(getCurrentRuntime\(\) \|\| \{\}\)/,
  );
  assert.match(statusSection, /ambiguousCanceled/);
  assert.match(statusSection, /"运行状态异常中断（非用户操作）"/);
});

test("dark task surface stops an active unattended request through its real cancel endpoint", () => {
  const controlsSection = readFunctionSection(
    "function setupDebugSessionPanelControls()",
    "function setupAuthCodeInputListeners()",
  );
  assert.match(
    controlsSection,
    /panel\?\.dataset\?\.unattended === "true" \|\|\s+isKeywordPlanRunning\(buildKeywordRunDisplayPlan\(keywordPlanState\)\)/,
  );
  assert.match(
    controlsSection,
    /if \(stoppingUnattended\) \{\s+await cancelUnattendedKeywordPlanFromSidebar\([\s\S]*?unattendedRequestId/,
  );
  assert.match(controlsSection, /else \{\s+await handleCancel\(\)/);
});

test("unattended Debug startup and unexpected cancellation retain system error identity", () => {
  const terminalSection = readFunctionSection(
    "function resolveUnattendedCancellationTerminal(",
    "function supportsPersistentCaptureTaskPlatform(platform = \"\")",
  );
  assert.match(terminalSection, /native_debug_canceled/);
  assert.match(terminalSection, /sidebar_owner_disconnected/);
  assert.match(terminalSection, /source_tab_removed/);
  assert.match(terminalSection, /status: "failed"/);
  assert.match(
    terminalSection,
    /"CAPTURE_TASK_UNEXPECTED_CANCELLATION"/,
  );
  assert.doesNotMatch(
    terminalSection,
    /!normalizedReason \|\|\s+normalizedReason === "user_cancel_requested"/,
  );
  assert.match(terminalSection, /CAPTURE_TASK_/);

  const unattendedSection = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(request)",
    "async function runCaptureAction({",
  );
  assert.match(
    unattendedSection,
    /phase: "initializing_unattended"/,
  );
  assert.match(
    unattendedSection,
    /AI Debug 启动失败（\$\{code\}）：\$\{message\}/,
  );
  assert.match(unattendedSection, /startError\.code = code/);
  assert.match(
    unattendedSection,
    /resolveUnattendedCancellationTerminal\(\s+activeCaptureTaskCancellationReason/,
  );
  assert.match(
    unattendedSection,
    /status: cancellation\.status[\s\S]*message: cancellation\.message[\s\S]*error: cancellation\.error/,
  );

  const batchSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  const cancellationFence = batchSection.match(
    /executionLockOwner === "unattended_keyword_plan" &&[\s\S]{0,180}!isCurrentUnattendedInvocation\(\)[\s\S]{0,180}activeCaptureTaskCancellationReason/,
  );
  const resetAt = batchSection.indexOf("batchKeywordCancelRequested = false;");
  assert.ok(cancellationFence?.index >= 0 && cancellationFence.index < resetAt);

  const storageSection = readFunctionSection(
    "function handleUnattendedRunRequestStorageChange(request)",
    "async function handleSaveKeywordPlan(",
  );
  assert.match(
    storageSection,
    /isExplicitUserUnattendedCancellationMessage\(request\.message\)/,
  );
  assert.match(
    storageSection,
    /"unattended_request_canceled_without_user_action"/,
  );
});

test("task surface hides invented percentages and exposes only explicit progressPercent", () => {
  const percentSection = readFunctionSection(
    "function resolveCaptureTaskPercent(progress = {})",
    "function buildCaptureTaskStats(progress = {})",
  );
  assert.match(percentSection, /Number\(progress\?\.progressPercent\)/);
  assert.match(percentSection, /if \(!Number\.isFinite\(explicit\)\) return null/);
  assert.doesNotMatch(percentSection, /progress\?\.current|progress\?\.total/);

  const renderSection = readFunctionSection(
    "function renderCaptureDebugSession(runtime = {})",
    "async function syncRuntimeCommentProgress(",
  );
  assert.match(
    renderSection,
    /classList\.toggle\("is-indeterminate", percent === null\)/,
  );
  assert.match(renderSection, /removeAttribute\("aria-valuenow"\)/);
  assert.match(renderSection, /progressPercent\.hidden = percent === null/);
  assert.match(renderSection, /percent === null \? "—" : `\$\{percent\}%`/);
});

test("worker revisions prevent late progress from restoring stale A/B states", () => {
  const section = readFunctionSection(
    "function handleProgress(progress)",
    "async function syncRuntimeCommentProgress(",
  );
  assert.match(section, /incomingWorkerRevision >= detailBatchWorkerRevision/);
  assert.match(section, /detailBatchWorkerRevision = incomingWorkerRevision/);
  assert.match(section, /workerRevision: Math\.max\(/);
});

test("detail progress forwards the merged A/B snapshot instead of overwriting it", () => {
  const section = readFunctionSection(
    "async function runDetailCaptureForRecordIds(",
    "/**\n * 处理导出",
  );
  assert.match(
    section,
    /const mergedProgress = handleProgress\(normalizedProgress\)/,
  );
  assert.match(section, /onProgress\(mergedProgress\)/);
  assert.match(section, /onItemSettled\(mergedProgress\)/);

  const handleSection = readFunctionSection(
    "function handleProgress(progress)",
    "async function syncRuntimeCommentProgress(",
  );
  assert.match(handleSection, /return progress;/);
});

test("multi-keyword detail progress separates keyword and current-item counts", () => {
  const statsSection = readFunctionSection(
    "function buildCaptureTaskStats(progress = {})",
    "async function setCaptureTaskPanelMinimized(",
  );
  assert.match(statsSection, /progress\?\.keywordCurrent/);
  assert.match(statsSection, /progress\?\.keywordTotal/);
  assert.match(statsSection, /`关键词 \$\{/);
  assert.match(statsSection, /`当前词内作品 \$\{/);

  const renderSection = readFunctionSection(
    "function renderCaptureDebugSession(runtime = {})",
    "function setupDebugSessionPanelControls()",
  );
  assert.match(renderSection, /progress\?\.keyword/);
  assert.match(renderSection, /完善「\$\{keywordLabel\}」作品详情/);
});

test("task stop targets persisted source or worker and releases persistent Debug ownership", () => {
  const section = readFunctionSection(
    "async function handleCancel()",
    "/**\n * 处理鉴权",
  );
  assert.match(section, /const captureTaskSession = getCurrentRuntime\(\)\?\.captureDebugSession/);
  assert.match(section, /captureTaskSession\?\.workerTabIds/);
  assert.match(section, /captureTaskSession\?\.sourceTabId/);
  assert.match(section, /type: "onstarvoice:end-capture-task"/);
  assert.match(section, /reason: "user_cancel_requested"/);
});

test("detail context rebuild fences cleanup with the current unattended attempt", () => {
  const section = readFunctionSection(
    "async function rebuildCaptureTaskSessionForEnhancementRetry({",
    "const DEFAULT_MONITOR_SETTINGS",
  );
  const attemptIndex = section.indexOf("const retryAttemptId =");
  const localEndIndex = section.indexOf("await endCaptureTaskSession({");
  const directEndIndex = section.indexOf(
    "const sendDirectCaptureTaskEnd = async",
  );
  const beginIndex = section.indexOf(
    "return await startRequiredCaptureTaskSession({",
  );
  const failedCleanupIndex = section.lastIndexOf(
    'reason: "context_rebuild_failed"',
  );

  assert.ok(attemptIndex > -1 && attemptIndex < localEndIndex);
  assert.ok(directEndIndex > attemptIndex && directEndIndex < localEndIndex);
  assert.ok(beginIndex > localEndIndex);
  assert.ok(failedCleanupIndex > beginIndex);
  assert.match(
    section,
    /type: "onstarvoice:end-capture-task",[\s\S]*?attemptId: retryAttemptId/,
  );
  assert.match(section, /data\?\.ignored === true/);
  assert.match(section, /data\?\.released === false/);
  assert.match(
    section,
    /reason: "context_rebuild_failed",\s+status: "failed"/,
  );
  assert.match(
    section,
    /attemptId: retryAttemptId,[\s\S]*?return await startRequiredCaptureTaskSession\(\{/,
    "the cleanup and replacement BEGIN must share one attempt fence",
  );
  assert.match(section, /unattendedAttemptId = ""/);
  assert.doesNotMatch(
    section,
    /activeUnattendedRunAttemptId/,
    "a stale callback must never borrow the replacement attempt from globals",
  );
});

function createContextRebuildHarness({
  endResult = {ok: true, reason: "no_active_task_session"},
  sendMessage = async () => ({ok: true, data: {released: true}}),
  startSession = async () => ({ok: true, active: true}),
  sourceTabId = 73,
} = {}) {
  const section = readFunctionSection(
    "async function rebuildCaptureTaskSessionForEnhancementRetry({",
    "const DEFAULT_MONITOR_SETTINGS",
  );
  const context = {
    activeUnattendedRunAttemptId: "attempt-current",
    captureTaskOwnerTaskId: "",
    resolveCaptureTaskSourceTabId: async () => sourceTabId,
    endCaptureTaskSession: async () => endResult,
    startRequiredCaptureTaskSession: startSession,
    wait: async () => undefined,
    chrome: {runtime: {sendMessage}},
    console,
  };
  vm.runInNewContext(
    `${section}\nglobalThis.__rebuildCaptureTaskSession = rebuildCaptureTaskSessionForEnhancementRetry;`,
    context,
  );
  return context.__rebuildCaptureTaskSession;
}

test("missing local unattended session retries ignored END with the current attempt before BEGIN", async () => {
  const endMessages = [];
  const beginCalls = [];
  const rebuild = createContextRebuildHarness({
    sendMessage: async (message) => {
      endMessages.push(message);
      return endMessages.length === 1
        ? {
            ok: true,
            data: {
              ignored: true,
              released: false,
              reason: "stale_unattended_attempt",
            },
          }
        : {ok: true, data: {released: true}};
    },
    startSession: async (options) => {
      beginCalls.push(options);
      return {ok: true, active: true};
    },
  });

  const result = await rebuild({
    taskId: "unattended-capture:request-current",
    platform: "douyin",
    unattendedAttemptId: "attempt-current",
  });

  assert.equal(result.active, true);
  assert.equal(endMessages.length, 2, "ignored or unreleased END must retry");
  assert.ok(
    endMessages.every((message) => message.attemptId === "attempt-current"),
  );
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0].attemptId, "attempt-current");
});

test("unattended context rebuild rejects a missing scoped attempt before END", async () => {
  const endMessages = [];
  const rebuild = createContextRebuildHarness({
    sendMessage: async (message) => {
      endMessages.push(message);
      return {ok: true, data: {released: true}};
    },
  });

  await assert.rejects(
    rebuild({
      taskId: "unattended-capture:request-current",
      platform: "douyin",
    }),
    /缺少当前执行标识/,
  );
  assert.equal(endMessages.length, 0, "missing identity must not END any task");
});

test("exhausted context rebuild finalizes recovering ledger with the same attempt", async () => {
  const endMessages = [];
  const beginCalls = [];
  const rebuild = createContextRebuildHarness({
    endResult: {ok: true, data: {released: true}},
    sendMessage: async (message) => {
      endMessages.push(message);
      return {ok: true, data: {released: true}};
    },
    startSession: async (options) => {
      beginCalls.push(options);
      const error = new Error("cleanup pending");
      error.code = "capture_task_cleanup_pending";
      throw error;
    },
  });

  await assert.rejects(
    rebuild({
      taskId: "unattended-capture:request-current",
      platform: "douyin",
      unattendedAttemptId: "attempt-current",
    }),
    /cleanup pending/,
  );

  assert.equal(beginCalls.length, 4);
  assert.ok(
    beginCalls.every((call) => call.attemptId === "attempt-current"),
  );
  assert.equal(endMessages.length, 1);
  assert.equal(endMessages[0].attemptId, "attempt-current");
  assert.equal(endMessages[0].reason, "context_rebuild_failed");
  assert.equal(endMessages[0].status, "failed");
});

test("native Debug cancellation stops list, detail and keyword-gap work", () => {
  const section = readFunctionSection(
    "function applyCaptureTaskCancellation(cancellation = {})",
    "function syncCaptureTaskOwnerFromRuntime(",
  );
  assert.match(section, /taskId !== captureTaskOwnerTaskId/);
  assert.match(section, /searchCaptureCancelRequested = true/);
  assert.match(section, /batchKeywordCancelRequested = true/);
  assert.match(section, /detailBatchCancelRequested = true/);
  assert.match(section, /requestDetailRunnerCancelSignals\(\{/);
  assert.match(section, /extraTabIds: taskWorkerTabIds/);
});

test("detail cancellation fans out to every known A/B worker", () => {
  const section = readFunctionSection(
    "async function requestDetailRunnerCancelSignals(",
    "function parseKeywordsFromMultilineInput(",
  );
  assert.match(section, /getKnownDetailRunnerTabIds\(extraTabIds\)/);
  assert.match(section, /Promise\.allSettled\(/);
  assert.match(section, /runnerTabIds\.map\(\(tabId\) => requestCaptureCancelSignal\(tabId\)\)/);
});

test("sidebar binds a dedicated capture owner port and disconnects it on unload", () => {
  assert.match(
    sidebarSource,
    /chrome\.runtime\.connect\(\{name: CAPTURE_TASK_OWNER_PORT_NAME\}\)/,
  );
  const startSection = readFunctionSection(
    "async function startRequiredCaptureTaskSession(options = {})",
    "const DEFAULT_MONITOR_SETTINGS",
  );
  assert.match(startSection, /bindCaptureTaskOwner\(/);
  const unloadSection = sidebarSource.slice(
    sidebarSource.indexOf('window.addEventListener("beforeunload"'),
  );
  assert.match(unloadSection, /captureTaskOwnerClosing = true/);
  assert.match(unloadSection, /captureTaskOwnerPort\?\.disconnect\?\.\(\)/);
});

test("native cancellation fences automatic backend sync at every task call site", () => {
  const autoSyncSection = readFunctionSection(
    "async function maybeRunAutoSyncAfterDetailCapture(",
    "async function runDetailCaptureForRecordIds(",
  );
  assert.match(autoSyncSection, /shouldStop = null/);
  assert.match(autoSyncSection, /if \(stopRequested\(\)\) return canceledResult\(\)/);
  assert.match(autoSyncSection, /const checkResult = await checkBeforeSync/);
  assert.match(autoSyncSection, /shouldStop: stopRequested/);
  assert.match(autoSyncSection, /signal,/);
  assert.match(autoSyncSection, /if \(result\?\.canceled\) return canceledResult\(\)/);

  const searchSection = readFunctionSection(
    "async function handleCaptureSearchData()",
    "function setKeywordStrategyTab(",
  );
  assert.match(
    searchSection,
    /shouldStop: \(\) => searchCaptureCancelRequested/,
  );

  const batchSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  assert.match(
    batchSection,
    /const shouldStopBatchInvocation = \(\) =>\s+batchKeywordCancelRequested \|\| !isCurrentUnattendedInvocation\(\)/,
  );
  assert.match(
    batchSection,
    /shouldStop: shouldStopBatchInvocation/,
  );
});

test("cloud task capture settings override local UI settings and reach unattended batches", () => {
  const batchSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  assert.match(batchSection, /runOptions\.captureSettings/u);
  assert.match(
    batchSection,
    /resolveTaskCaptureSettingsOverrides\(\s*storedCaptureSettings,\s*runOptions\.captureSettings/u,
  );
  assert.match(
    batchSection,
    /const settings = taskCaptureSettings \|\|\s*resolveCurrentDetailCaptureSettings\(storedCaptureSettings\)/u,
  );

  const unattendedSection = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(",
    "async function runCaptureAction(",
  );
  assert.match(
    unattendedSection,
    /handleBatchKeywordCapture\(\{[\s\S]*captureSettings:\s*plan\.captureSettings/u,
  );
});

test("task keyword post limits override local settings and reach unattended capture params", () => {
  const resolverSource = readFunctionSection(
    "function resolveTaskKeywordMaxDetectedItems(",
    "function resolveCurrentDetailCaptureSettings(",
  );
  const context = vm.createContext({});
  vm.runInContext(
    `const DEFAULT_CAPTURE_SETTINGS = {keywordMaxDetectedItems: 50};\n${resolverSource}\nglobalThis.__resolveTaskLimit = resolveTaskKeywordMaxDetectedItems;`,
    context,
  );
  const resolveTaskLimit = context.__resolveTaskLimit;

  assert.equal(resolveTaskLimit(50, 275), 275);
  assert.equal(resolveTaskLimit(), 50);
  assert.equal(resolveTaskLimit(73, null), 73);
  assert.equal(resolveTaskLimit(73, undefined), 73);
  for (const invalidValue of [0, -1, "invalid", 12.5]) {
    assert.equal(
      resolveTaskLimit(73, invalidValue),
      73,
      `invalid task value ${String(invalidValue)} must preserve the local setting`,
    );
  }

  const batchSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  assert.match(batchSection, /runOptions\.keywordMaxDetectedItems/u);
  assert.match(
    batchSection,
    /resolveTaskKeywordMaxDetectedItems\(\s*settings\.keywordMaxDetectedItems,\s*runOptions\.keywordMaxDetectedItems/u,
  );
  assert.match(
    batchSection,
    /maxDetectedItems:\s*keywordMaxDetectedItems/u,
  );

  const unattendedSection = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(",
    "async function runCaptureAction(",
  );
  assert.match(
    unattendedSection,
    /handleBatchKeywordCapture\(\{[\s\S]*keywordMaxDetectedItems:[\s\S]*plan\.keywordMaxDetectedItems/u,
  );
});

test("task capture-setting overrides preserve 1000 comments and normalize dependencies", () => {
  const resolverSource = readFunctionSection(
    "function resolveTaskCaptureSettingsOverrides(",
    "function resolveCurrentDetailCaptureSettings(",
  );
  const context = vm.createContext({});
  vm.runInContext(
    `${resolverSource}\nglobalThis.resolveTaskCaptureSettingsOverridesForTest = resolveTaskCaptureSettingsOverrides;`,
    context,
  );
  const resolveOverrides = context.resolveTaskCaptureSettingsOverridesForTest;

  const enabled = resolveOverrides(
    {detailCommentsMaxDetectedItems: 50},
    {
      autoDetailCaptureAfterListCapture: "true",
      autoSyncAfterDetailCapture: true,
      enableAiRelevancePrefilter: true,
      includeBloggerMetricsOnDetailCapture: true,
      enableLowFollowerHitFilterOnDetailCapture: true,
      lowFollowerHitThresholdOnDetailCapture: 8000,
      includeCommentsOnDetailCapture: true,
      detailCommentsMaxDetectedItems: 1000,
      enableCommentLeadsFilterOnDetailCapture: true,
      skipAlreadyCapturedOnDetailCapture: true,
    },
  );
  assert.equal(enabled.detailCommentsMaxDetectedItems, 1000);
  assert.equal(enabled.enableLowFollowerHitFilterOnDetailCapture, true);
  assert.equal(enabled.enableCommentLeadsFilterOnDetailCapture, true);

  const disabledEnhancement = resolveOverrides(
    {},
    {
      autoDetailCaptureAfterListCapture: false,
      autoSyncAfterDetailCapture: true,
      enableAiRelevancePrefilter: true,
      includeBloggerMetricsOnDetailCapture: true,
      enableLowFollowerHitFilterOnDetailCapture: true,
      includeCommentsOnDetailCapture: true,
      enableCommentLeadsFilterOnDetailCapture: true,
      skipAlreadyCapturedOnDetailCapture: true,
    },
  );
  for (const key of [
    "autoSyncAfterDetailCapture",
    "enableAiRelevancePrefilter",
    "includeBloggerMetricsOnDetailCapture",
    "enableLowFollowerHitFilterOnDetailCapture",
    "includeCommentsOnDetailCapture",
    "enableCommentLeadsFilterOnDetailCapture",
    "skipAlreadyCapturedOnDetailCapture",
  ]) {
    assert.equal(disabledEnhancement[key], false, `${key} must be gated`);
  }

  const disabledParents = resolveOverrides(
    {},
    {
      autoDetailCaptureAfterListCapture: true,
      includeBloggerMetricsOnDetailCapture: false,
      enableLowFollowerHitFilterOnDetailCapture: true,
      includeCommentsOnDetailCapture: false,
      enableCommentLeadsFilterOnDetailCapture: true,
    },
  );
  assert.equal(disabledParents.enableLowFollowerHitFilterOnDetailCapture, false);
  assert.equal(disabledParents.enableCommentLeadsFilterOnDetailCapture, false);
});
