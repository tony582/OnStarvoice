import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);
const sidebarHtml = await readFile(
  new URL("../../sidebar/sidebar.html", import.meta.url),
  "utf8",
);

function readFunctionSection(startMarker, endMarker) {
  const start = sidebarSource.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = sidebarSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return sidebarSource.slice(start, end);
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
  assert.match(section, /captureTaskId: taskContext\.taskId/);
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
  assert.match(section, /captureTaskId: taskContext\.taskId/);
});

test("manual task start fails closed when debugger or tab-group ownership is unavailable", () => {
  const section = readFunctionSection(
    "async function startRequiredCaptureTaskSession(options = {})",
    "const DEFAULT_MONITOR_SETTINGS",
  );

  const bindIndex = section.indexOf("bindCaptureTaskOwner(taskId)");
  const beginIndex = section.indexOf("await beginCaptureTaskSession({");
  assert.ok(bindIndex >= 0 && beginIndex > bindIndex);
  assert.match(section, /new Set\(\["xiaohongshu", "douyin"\]\)\.has\(platform\)/);
  assert.match(section, /capture_task_platform_unsupported/);
  assert.match(section, /ownerRequired: true/);
  assert.match(section, /result\?\.ok === true && result\?\.active === true/);
  assert.match(section, /throw error;/);
});

test("capture progress is forwarded before any local UI branch", () => {
  const section = readFunctionSection(
    "function handleProgress(progress)",
    "async function syncRuntimeCommentProgress(",
  );
  const updateIndex = section.indexOf(
    "void updateCaptureTaskSession({taskId: captureTaskOwnerTaskId, progress});",
  );
  const phaseIndex = section.indexOf("const phase =");
  const domIndex = section.indexOf("document.getElementById(");

  assert.ok(updateIndex > -1 && updateIndex < phaseIndex);
  assert.ok(updateIndex < domIndex);
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
  assert.match(section, /"正在采集详情"/);
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
