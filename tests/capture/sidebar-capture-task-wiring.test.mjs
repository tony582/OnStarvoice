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
    /batchCaptureByKeywords\(\{\s+keywords: \[\.\.\.searchKeywords\],[\s\S]*?captureTaskId: persistentCaptureTaskId/,
  );
  assert.doesNotMatch(section, /retryFailedEnhancementsAfterRound\(/);
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
    /waitForActiveTabReady\(targetTab\.id, 15000, \{[\s\S]*?expectedUrl:\s*searchUrl,[\s\S]*?expectedKeyword:\s*keyword,/,
  );
  assert.match(
    navigationSection,
    /waitForRuntimeSearchPage\(\{[\s\S]*?platform,[\s\S]*?tabId:\s*readyState\.tabId,[\s\S]*?expectedUrl:\s*searchUrl,[\s\S]*?expectedKeyword:\s*keyword,/,
    "runtime readiness must describe the same final tab and search identity",
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
    /const syntheticSession = buildUnattendedSyntheticDebugSession\(runtime\)/,
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
    /panel\?\.dataset\?\.unattended === "true" \|\|\s+isKeywordPlanRunning\(keywordPlanState\)/,
  );
  assert.match(
    controlsSection,
    /if \(stoppingUnattended\) \{\s+await cancelUnattendedKeywordPlanFromSidebar\(\)/,
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
  const cancellationFenceAt = batchSection.indexOf(
    'executionLockOwner === "unattended_keyword_plan" &&\n      activeCaptureTaskCancellationReason',
  );
  const resetAt = batchSection.indexOf("batchKeywordCancelRequested = false;");
  assert.ok(cancellationFenceAt > -1 && cancellationFenceAt < resetAt);

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
    /shouldStop: \(\) => batchKeywordCancelRequested/,
  );
});
