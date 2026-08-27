import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const [
  backgroundSource,
  manifestSource,
  captureSyncSource,
  douyinKeywordSearchSource,
] = await Promise.all([
  readFile(new URL("background.js", repoRoot), "utf8"),
  readFile(new URL("manifest.json", repoRoot), "utf8"),
  readFile(new URL("utils/capture-sync.js", repoRoot), "utf8"),
  readFile(
    new URL("utils/capture/douyin-keyword-search.js", repoRoot),
    "utf8",
  ),
]);
const manifest = JSON.parse(manifestSource);

function readDetailBatchFunctionSource() {
  const start = captureSyncSource.indexOf(
    "export async function batchCaptureDetailsForRecords",
  );
  const end = captureSyncSource.indexOf(
    "export function resolveSyncInputForRecord",
    start,
  );
  assert.ok(start >= 0, "missing batchCaptureDetailsForRecords");
  assert.ok(end > start, "missing detail batch end marker");
  return captureSyncSource.slice(start, end);
}

test("capture task runtime declares native tab-group permissions and worker module", () => {
  assert.equal(manifest.permissions.includes("tabs"), true);
  assert.equal(manifest.permissions.includes("tabGroups"), true);
  assert.equal(manifest.permissions.includes("unlimitedStorage"), true);
  assert.match(backgroundSource, /utils\/capture\/task-tab-group\.js/);
  assert.match(backgroundSource, /utils\/capture\/task-runtime\.js/);
  assert.match(backgroundSource, /utils\/capture\/task-owner\.js/);
});

test("all task-level runtime messages are wired in the service worker", () => {
  for (const type of [
    "onstarvoice:begin-capture-task",
    "onstarvoice:update-capture-task",
    "onstarvoice:register-capture-task-tab",
    "onstarvoice:end-capture-task",
    "onstarvoice:set-capture-task-minimized",
  ]) {
    assert.equal(backgroundSource.includes(`type === '${type}'`), true, type);
  }
});

test("legacy relays only release sessions they started themselves", () => {
  assert.match(
    backgroundSource,
    /if \(existingDebugSession\?\.persistent && isListCaptureAction\) \{[\s\S]*persistentRelayTaskId[\s\S]*persistentRelayTaskId !== existingDebugSession\.taskId[\s\S]*debugSession = await captureDebugSessionManager\.updateTask/u,
  );
  assert.match(
    backgroundSource,
    /if \(debugSession && debugSessionStartedByRelay\) \{\s*await captureDebugSessionManager\.stop/u,
  );
});

test("persistent debugger ownership does not replace each list relay child run", () => {
  const relayStart = backgroundSource.indexOf(
    "if (type === 'onstarvoice:relay-to-content')",
  );
  const relaySource = backgroundSource.slice(relayStart);
  assert.match(
    relaySource,
    /resolveListRelayRunId\(\s*sourcePayload\.listCaptureRunId,\s*createUuid/u,
  );
  assert.match(relaySource, /activeListRunId: listRunId/u);
  assert.match(relaySource, /runId: listRunId/u);
  assert.match(relaySource, /listCaptureRunId: listRunId/u);
  assert.doesNotMatch(
    relaySource,
    /listCaptureRunId: debugSession\.runId/u,
  );
});

test("unexpected debugger detach fans cancellation out to source and worker tabs", () => {
  assert.match(
    backgroundSource,
    /const cancelListRunId = session\.persistent\s*\? session\.activeListRunId\s*: session\.runId/u,
  );
  assert.match(
    backgroundSource,
    /const targetTabIds = \[\s*session\.tabId,[\s\S]*session\.workerTabIds/u,
  );
  assert.match(
    backgroundSource,
    /\[\.\.\.new Set\(targetTabIds\)\]\.map\(\(tabId\) =>[\s\S]*relayToContentWithRetry\(tabId, cancelPayload\)/u,
  );
});

test("task end attempts debugger release before source ungroup cleanup", () => {
  const start = backgroundSource.indexOf(
    "async function releaseCaptureTaskResources",
  );
  const end = backgroundSource.indexOf("async function endCaptureTask", start);
  const body = backgroundSource.slice(start, end);
  const detachAt = body.indexOf("stopByTaskId");
  const ungroupAt = body.indexOf("captureTaskTabGroupManager.end");
  assert.ok(detachAt >= 0);
  assert.ok(ungroupAt > detachAt);
});

test("task begin checks debugger ownership before changing native groups", () => {
  const start = backgroundSource.indexOf("async function beginCaptureTask");
  const end = backgroundSource.indexOf("async function updateCaptureTask", start);
  const body = backgroundSource.slice(start, end);
  const ownershipAt = body.indexOf("getActiveSessions()");
  const groupAt = body.indexOf("captureTaskTabGroupManager.begin");
  assert.ok(ownershipAt >= 0);
  assert.ok(groupAt > ownershipAt);
  assert.match(body, /capture_task_debug_busy/u);
});

test("task begin reconciles only confirmed stale native groups before reporting group busy", () => {
  const start = backgroundSource.indexOf("async function beginCaptureTask");
  const end = backgroundSource.indexOf("async function updateCaptureTask", start);
  const body = backgroundSource.slice(start, end);
  const reconcileAt = body.indexOf(
    "releaseConfirmedStaleCaptureTaskGroupsForBegin",
  );
  const conflictAt = body.indexOf("capture_task_group_busy");

  assert.ok(reconcileAt >= 0);
  assert.ok(conflictAt > reconcileAt);
  const livenessStart = backgroundSource.indexOf(
    "async function inspectCaptureTaskGroupLiveness",
  );
  const livenessEnd = backgroundSource.indexOf(
    "async function releaseConfirmedStaleCaptureTaskGroupsForBegin",
    livenessStart,
  );
  const livenessBody = backgroundSource.slice(livenessStart, livenessEnd);
  for (const signal of [
    "debug_session",
    "task_owner",
    "execution_lock",
    "task_ledger",
  ]) {
    assert.match(livenessBody, new RegExp(signal, "u"));
  }
  assert.match(
    livenessBody,
    /debugSession && debugSessionState !== 'detached'/u,
  );
  assert.match(
    livenessBody,
    /reason: 'confirmed_stale',[\s\S]*debugSession,/u,
  );
  assert.match(
    backgroundSource,
    /releaseCaptureTaskResourcesWithRetry\([\s\S]*reason: 'stale_capture_task_recovered'/u,
  );
});

test("task-level Debug trusts the source URL and rejects unsupported or spoofed platforms", () => {
  const start = backgroundSource.indexOf("async function beginCaptureTask");
  const end = backgroundSource.indexOf("async function updateCaptureTask", start);
  const body = backgroundSource.slice(start, end);
  assert.match(body, /sourceTab = await chrome\.tabs\.get\(sourceTabId\)/u);
  assert.match(body, /detectPlatformFromUrl\(sourceTab\?\.url \|\| ''\)/u);
  assert.match(body, /resolveCaptureTaskReplacementLease\(sourceTabId/u);
  assert.match(body, /replacementPlatform !== sourcePlatform/u);
  assert.match(body, /new Set\(\['xiaohongshu', 'douyin'\]\)\.has\(sourcePlatform\)/u);
  assert.match(body, /capture_task_platform_unsupported/u);
  assert.match(body, /requestedPlatform !== sourcePlatform/u);
  assert.match(body, /capture_task_platform_mismatch/u);

  const relayStart = backgroundSource.indexOf(
    "if (type === 'onstarvoice:relay-to-content')",
  );
  const relayBody = backgroundSource.slice(relayStart);
  assert.match(relayBody, /const platform = detectPlatformFromUrl\(relayTab\?\.url \|\| ''\)/u);
  assert.match(
    relayBody,
    /const supportedListPlatform =[\s\S]*platform === 'xiaohongshu' \|\| platform === 'douyin'/u,
  );
  const persistentGuardAt = relayBody.indexOf(
    "if (existingDebugSession?.persistent && isListCaptureAction)",
  );
  const eligibleAt = relayBody.indexOf("const debugEligible");
  const relayAt = relayBody.indexOf("relayToContentWithRetry");
  assert.ok(persistentGuardAt >= 0 && persistentGuardAt < eligibleAt);
  assert.ok(eligibleAt < relayAt);
  assert.match(
    relayBody.slice(persistentGuardAt, eligibleAt),
    /capture_task_platform_unsupported[\s\S]*capture_task_platform_mismatch[\s\S]*capture_task_relay_mismatch/u,
  );
});

test("A/B detail preloading requires an explicit persistent task and two remaining items", () => {
  const start = captureSyncSource.indexOf(
    "export async function batchCaptureDetailsForRecords",
  );
  const end = captureSyncSource.indexOf(
    "const shouldStopDetailBatch",
    start,
  );
  const body = captureSyncSource.slice(start, end);
  const firstRegistrationAt = body.indexOf("const taskTabRegistration");
  const remainingAt = body.indexOf("const remainingDetailCount");
  const doubleBufferAt = body.indexOf(
    "remainingDetailCount >= DETAIL_PREFETCH_WORKER_COUNT",
  );
  const standbyAt = body.indexOf("const standbyRegistration");
  assert.ok(firstRegistrationAt >= 0);
  assert.ok(remainingAt > firstRegistrationAt);
  assert.ok(doubleBufferAt > remainingAt);
  assert.ok(standbyAt > doubleBufferAt);
  assert.match(
    body,
    /if \(\s*normalizedCaptureTaskId &&\s*allowDetailDoubleBuffer &&\s*remainingDetailCount >= DETAIL_PREFETCH_WORKER_COUNT\s*\)/u,
  );
});

test("Douyin detail enhancement stays on one worker and delays unavailable failures", () => {
  assert.match(
    captureSyncSource,
    /const allowDetailDoubleBuffer = !detailBatchContainsDouyin/u,
  );
  assert.match(
    captureSyncSource,
    /抖音使用单工作页，避免自动连播导致作品错配/u,
  );
  assert.match(
    captureSyncSource,
    /你要观看的\(\?:图文\|视频\|作品\|内容\)不存在/u,
  );
  assert.match(captureSyncSource, /DOUYIN_CONTENT_UNAVAILABLE/u);
  assert.match(captureSyncSource, /DOUYIN_UNAVAILABLE_GRACE_MS = 4500/u);
  assert.match(
    captureSyncSource,
    /buildDouyinDetailNavigationCandidates\(\s*url,\s*douyinSearchModalUrlByRecordId\.get\(String\(recordId\)\) \|\| '',\s*douyinDetailPathByRecordId\.get\(String\(recordId\)\) \|\| 'unknown',\s*\)/u,
  );
  assert.match(
    captureSyncSource,
    /douyinSearchModalUrlByRecordId\.set\(\s*String\(recordId\),\s*buildDouyinRecordSearchModalUrl\(record, noteId\),\s*\)/u,
  );
  assert.match(
    captureSyncSource,
    /modalId === noteId/u,
  );
  assert.match(
    captureSyncSource,
    /DOUYIN_DETAIL_NAV_CANDIDATE_TIMEOUT_MS = 15000/u,
  );
  assert.match(
    captureSyncSource,
    /error\?\.code === 'DETAIL_NAVIGATION_TIMEOUT'/u,
  );
  assert.match(
    captureSyncSource,
    /error\.code = 'DETAIL_NAVIGATION_TIMEOUT'/u,
  );
  assert.match(
    captureSyncSource,
    /DOUYIN_DETAIL_ROUTE_SETTLE_MS = 1200/u,
  );
});

test("Xiaohongshu and Douyin interrupted detail workers are recreated with finite per-item and per-batch limits", () => {
  assert.match(
    captureSyncSource,
    /DETAIL_RUNNER_RECREATE_MAX_PER_BATCH = 2/u,
  );
  assert.match(
    captureSyncSource,
    /DETAIL_RUNNER_RECREATE_MAX_PER_ITEM = 1/u,
  );
  const helperStart = captureSyncSource.indexOf(
    "const recreateInterruptedDetailRunners",
  );
  const helperEnd = captureSyncSource.indexOf(
    "const discardPrefetchForRecord",
    helperStart,
  );
  const helperBody = captureSyncSource.slice(helperStart, helperEnd);
  assert.match(
    helperBody,
    /normalizedRecordPlatform === 'xiaohongshu'[\s\S]*normalizedRecordPlatform === 'douyin'/u,
  );
  assert.match(
    helperBody,
    /normalizedRecordPlatform === 'douyin' && !normalizedExpectedNoteId/u,
    "a rebuilt Douyin worker must retain a real expected work ID",
  );
  assert.match(helperBody, /previousPipeline\?\.stop/u);
  assert.match(helperBody, /closeOwnedDetailRunnerTabs\(previousContexts\)/u);
  assert.match(helperBody, /prepareDetailBatchRunnerContext/u);
  assert.match(helperBody, /registerCaptureTaskTab/u);
  assert.match(helperBody, /taskId: normalizedCaptureTaskId/u);
  assert.match(helperBody, /detail_runner_recreated/u);

  const recoveryCallStart = captureSyncSource.indexOf(
    "const runnerContextInterrupted",
    helperEnd,
  );
  const recoveryCallEnd = captureSyncSource.indexOf(
    "const terminalTraceState",
    recoveryCallStart,
  );
  const recoveryCallBody = captureSyncSource.slice(
    recoveryCallStart,
    recoveryCallEnd,
  );
  assert.match(recoveryCallBody, /recreateInterruptedDetailRunners/u);
  assert.match(recoveryCallBody, /recordPlatform/u);
  assert.match(recoveryCallBody, /expectedNoteId: expectedDouyinNoteId/u);
  assert.match(recoveryCallBody, /index -= 1;\s*continue;/u);
});

test("Douyin detail core is captured without optional blogger metrics", () => {
  const body = readDetailBatchFunctionSource();
  assert.match(
    body,
    /const shouldCaptureBloggerMetricsForRecord =\s*includeBloggerMetrics \|\| shouldApplyLowFollowerHitFilter/u,
  );
  assert.doesNotMatch(
    body,
    /shouldCaptureBloggerMetricsForRecord =[^;]*recordPlatform === 'douyin'/u,
  );
  const coreCaptureAt = body.indexOf("const captureCurrentNotePayload");
  const coreCaptureEnd = body.indexOf("let noteResult", coreCaptureAt);
  const coreCapture = body.slice(coreCaptureAt, coreCaptureEnd);
  assert.match(coreCapture, /expectedNoteId: expectedDouyinNoteId/u);
  assert.match(coreCapture, /includeBloggerMetrics: false/u);
  assert.match(coreCapture, /preferWorksTabForBloggerMetrics: false/u);

  const optionalMetricsAt = body.indexOf(
    "const metricsResult = await captureBloggerMetricsForDetailPayload",
  );
  const optionalMetricsEnd = body.indexOf(
    "detailPayload = applyBloggerMetricsResultToPayload",
    optionalMetricsAt,
  );
  const optionalMetrics = body.slice(optionalMetricsAt, optionalMetricsEnd);
  assert.match(optionalMetrics, /expectedNoteId: expectedDouyinNoteId/u);
  assert.match(optionalMetrics, /preferWorksTabForBloggerMetrics/u);
});

test("Douyin card identity and detail route are kept consistent", () => {
  assert.match(
    douyinKeywordSearchSource,
    /candidateNoteId !== String\(noteId\)/u,
  );
  assert.match(
    douyinKeywordSearchSource,
    /hasExplicitSearchCardVideoSignal\(card\)[\s\S]*buildDouyinDetailUrl\(candidateNoteId, "video"\)/u,
  );
  assert.match(
    douyinKeywordSearchSource,
    /搜索页的 modal_id 链接携带当前搜索上下文/u,
  );
  assert.match(
    douyinKeywordSearchSource,
    /buildDouyinSearchModalUrl\(\s*noteId,\s*sourceSearchUrl/u,
  );
  assert.match(
    douyinKeywordSearchSource,
    /card\?\.querySelectorAll\?\.\([\s\S]*a\[href\][\s\S]*extractNoteId\(normalizeUrl\(candidate\)\)/u,
  );
});

test("worker registration rolls native grouping back if debug ownership ended", () => {
  const start = backgroundSource.indexOf("async function registerCaptureTaskTab");
  const end = backgroundSource.indexOf("async function endCaptureTask", start);
  const body = backgroundSource.slice(start, end);
  const registerGroupAt = body.indexOf("captureTaskTabGroupManager.register");
  const registerDebugAt = body.indexOf("captureDebugSessionManager.registerWorkerTab");
  const rollbackAt = body.indexOf("captureTaskTabGroupManager.unregister");
  assert.ok(registerGroupAt >= 0);
  assert.ok(registerDebugAt > registerGroupAt);
  assert.ok(rollbackAt > registerDebugAt);
});

test("source removal uses unified task cleanup instead of deleting manager maps independently", () => {
  assert.match(
    backgroundSource,
    /async function handleCaptureRuntimeTabRemoved\(tabId\)[\s\S]*source_tab_removed/u,
  );
  assert.match(
    backgroundSource,
    /handleCaptureRuntimeTabRemoved\(tabId\)[\s\S]*terminalizeCaptureTaskLedgerRun\(session\.taskId/u,
  );
  const removedListener = backgroundSource.slice(
    backgroundSource.indexOf("chrome.tabs.onRemoved.addListener"),
    backgroundSource.indexOf("chrome.tabs.onReplaced?.addListener"),
  );
  assert.match(removedListener, /handleCaptureRuntimeTabRemoved\(tabId\)/u);
  assert.doesNotMatch(removedListener, /captureDebugSessionManager\.handleTabRemoved/u);
});

test("required detail workers fail closed when their explicit task session is missing", () => {
  const registrationAt = captureSyncSource.indexOf(
    "const normalizedCaptureTaskId = normalizeCaptureTaskId(captureTaskId)",
  );
  const navigationAt = captureSyncSource.indexOf(
    "await reportProgressFailSoft(onProgress, {\n    phase: 'detail_batch_start'",
    registrationAt,
  );
  const section = captureSyncSource.slice(registrationAt, navigationAt);
  assert.match(section, /taskTabRegistration\?\.skipped === true/u);
  assert.match(section, /TASK_TAB_GROUP_UNAVAILABLE/u);
  assert.doesNotMatch(section, /getActiveTaskContext\(\)\?\.taskId/u);
});

test("a content CAPTURE_CANCELED result terminates the whole detail batch", () => {
  assert.match(
    captureSyncSource,
    /if \(!noteResult\?\.ok\) \{\s*if \(isCaptureCanceledResult\(noteResult\)\) \{\s*throw new Error\('DETAIL_CAPTURE_CANCELED'\)/u,
  );
});

test("detail, profile and restore navigations share the double-buffer pacer", () => {
  const metricsCallAt = captureSyncSource.indexOf(
    "const metricsResult = await captureBloggerMetricsForDetailPayload",
  );
  const metricsCallEnd = captureSyncSource.indexOf(
    "detailPayload = applyBloggerMetricsResultToPayload",
    metricsCallAt,
  );
  const metricsCall = captureSyncSource.slice(metricsCallAt, metricsCallEnd);
  assert.match(metricsCall, /detailPrefetchPipeline\.runExternalNavigation/u);
  assert.match(metricsCall, /probeDetailPreloadSafety\(navigationTabId\)/u);
  assert.match(
    metricsCall,
    /recordPlatform === 'xiaohongshu'\s*\?\s*\{active: false\}\s*:\s*\{\}/u,
  );

  const metricsHelperAt = captureSyncSource.indexOf(
    "async function captureBloggerMetricsForDetailPayload",
  );
  const metricsHelperEnd = captureSyncSource.indexOf(
    "function normalizeCommentsMaxDetectedItems",
    metricsHelperAt,
  );
  const metricsHelper = captureSyncSource.slice(metricsHelperAt, metricsHelperEnd);
  assert.match(metricsHelper, /navigate = openUrlInTab/u);
  assert.equal((metricsHelper.match(/await navigate\(tabId,/gu) || []).length >= 4, true);
});

test("standby prefetch is queued before current note extraction begins", () => {
  const acquireAt = captureSyncSource.indexOf(
    "detailWorkerLease = await detailPrefetchPipeline.acquire",
  );
  const prefetchAt = captureSyncSource.indexOf(
    "const prefetchResult = detailPrefetchPipeline.prefetch",
    acquireAt,
  );
  const noteCaptureAt = captureSyncSource.indexOf(
    "let noteResult = await captureCurrentNotePayload()",
    acquireAt,
  );
  const persistenceAt = captureSyncSource.indexOf(
    "const latestRecord = (await getRecord(recordId)) || record",
    noteCaptureAt,
  );

  assert.ok(acquireAt >= 0);
  assert.ok(prefetchAt > acquireAt && prefetchAt < noteCaptureAt);
  assert.ok(noteCaptureAt < persistenceAt);
  assert.match(
    captureSyncSource.slice(prefetchAt, noteCaptureAt),
    /detail_item_prefetch_queued/u,
  );
  assert.doesNotMatch(
    captureSyncSource,
    /Standby 只与本地整理和落库重叠/u,
  );
});

test("filtered items still pass the shared post-item safety delay", () => {
  const labeledTryAt = captureSyncSource.indexOf("captureCurrentDetail: try {");
  const itemCatchBodyAt = captureSyncSource.indexOf(
    "const pipelineFatalError = detailPrefetchPipeline.getFatalError()",
    labeledTryAt,
  );
  const itemCatchAt = captureSyncSource.lastIndexOf(
    "} catch (error) {",
    itemCatchBodyAt,
  );
  const itemFinallyAt = captureSyncSource.indexOf("} finally {", itemCatchAt);
  const itemDelayAt = captureSyncSource.indexOf(
    "const itemDelay =",
    itemFinallyAt,
  );
  const itemBody = captureSyncSource.slice(labeledTryAt, itemCatchAt);

  assert.ok(
    labeledTryAt >= 0 &&
      itemCatchBodyAt > labeledTryAt &&
      itemCatchAt > labeledTryAt,
  );
  assert.equal((itemBody.match(/break captureCurrentDetail;/gu) || []).length, 2);
  assert.doesNotMatch(itemBody, /\bcontinue;/u);
  assert.ok(itemFinallyAt > itemCatchAt && itemDelayAt > itemFinallyAt);
});

test("a fatal standby navigation actively cancels the collecting worker", () => {
  const pipelineAt = captureSyncSource.indexOf(
    "const createCurrentDetailPrefetchPipeline = () => createDetailPrefetchPipeline",
  );
  const batchStartAt = captureSyncSource.indexOf(
    "phase: 'detail_batch_start'",
    pipelineAt,
  );
  const section = captureSyncSource.slice(pipelineAt, batchStartAt);

  assert.match(section, /fatalNavigationFailure/u);
  assert.match(section, /const activeTabId = Number\(snapshot\?\.activeTabId\)/u);
  assert.match(section, /requestCaptureCancelInTabFailSoft\(/u);
  assert.match(section, /standby_security_blocked/u);
});

test("a standby fatal during the random delay remains a security stop", () => {
  const delayCatchAt = captureSyncSource.indexOf("} catch (delayError) {");
  const delayCatchEnd = captureSyncSource.indexOf("throw delayError;", delayCatchAt);
  const delayCatch = captureSyncSource.slice(delayCatchAt, delayCatchEnd);
  const fatalAt = delayCatch.indexOf("getFatalError()");
  const canceledAt = delayCatch.indexOf("canceled = true");
  assert.ok(fatalAt >= 0 && fatalAt < canceledAt);
  assert.match(delayCatch, /securityBlocked = true;\s*throw delayFatalError/u);
});

test("comment capture preserves security challenges as whole-batch fatal errors", () => {
  const commentsAt = captureSyncSource.indexOf(
    "async function captureCommentsForCurrentNote",
  );
  const commentsEnd = captureSyncSource.indexOf(
    "function applyCommentResultToSingleNotePayload",
    commentsAt,
  );
  const commentsBody = captureSyncSource.slice(commentsAt, commentsEnd);
  assert.match(commentsBody, /isDetailSecurityBlockError\(result\?\.error\)/u);
  assert.match(commentsBody, /throw error;/u);

  const itemCatchAt = captureSyncSource.indexOf(
    "const pipelineFatalError = detailPrefetchPipeline.getFatalError()",
  );
  const itemCatchEnd = captureSyncSource.indexOf(
    "const effectiveError = pipelineFatalError || error",
    itemCatchAt,
  );
  assert.match(
    captureSyncSource.slice(itemCatchAt, itemCatchEnd),
    /isDetailSecurityBlockError\(error\)[\s\S]*securityBlocked = true/u,
  );
});

test("fresh-worker stale cleanup validates the owned group before touching tab ids", () => {
  const start = backgroundSource.indexOf(
    "async function cleanupStaleCaptureRuntimeSession",
  );
  const end = backgroundSource.indexOf("async function ensureRuntimeState", start);
  const body = backgroundSource.slice(start, end);
  const groupCheckAt = body.indexOf("chrome.tabGroups.get(taskGroupId)");
  const sourceReadAt = body.indexOf("chrome.tabs.get(sourceTabId)");
  const sourceMutationAt = body.indexOf("chrome.debugger.detach");
  const workerMutationAt = body.indexOf("closeCaptureTaskWorkerTabs");
  const restoreMutationAt = body.indexOf("chrome.tabs.group({", sourceMutationAt);
  const ungroupMutationAt = body.indexOf("chrome.tabs.ungroup", sourceMutationAt);
  assert.ok(groupCheckAt >= 0);
  assert.ok(sourceReadAt > groupCheckAt);
  assert.ok(sourceMutationAt > sourceReadAt);
  assert.ok(workerMutationAt > sourceMutationAt);
  assert.ok(
    (restoreMutationAt > workerMutationAt || restoreMutationAt === -1) &&
      ungroupMutationAt > workerMutationAt,
  );
  assert.match(
    backgroundSource,
    /const CAPTURE_TASK_GROUP_TITLE =[\s\S]*'StarVoice 采集任务'/u,
  );
  assert.match(body, /taskGroup\?\.title[\s\S]*CAPTURE_TASK_GROUP_TITLE/u);
  assert.match(body, /workerTab\?\.groupId === taskGroupId/u);
});

test("native detach and source loss close owned detail workers", () => {
  const detachAt = backgroundSource.indexOf("onUnexpectedDetach: async");
  const detachEnd = backgroundSource.indexOf("function createCaptureTaskError", detachAt);
  assert.match(
    backgroundSource.slice(detachAt, detachEnd),
    /handleUnexpectedCaptureDebugDetach/u,
  );
  const unexpectedAt = backgroundSource.indexOf(
    "async function handleUnexpectedCaptureDebugDetach",
  );
  const unexpectedEnd = backgroundSource.indexOf(
    "async function handleAbandonedCaptureTask",
    unexpectedAt,
  );
  assert.match(
    backgroundSource.slice(unexpectedAt, unexpectedEnd),
    /releaseCaptureTaskResources/u,
  );
  const removedAt = backgroundSource.indexOf(
    "async function handleCaptureRuntimeTabRemoved",
  );
  const removedEnd = backgroundSource.indexOf(
    "chrome.runtime.onInstalled.addListener",
    removedAt,
  );
  assert.match(
    backgroundSource.slice(removedAt, removedEnd),
    /releaseCaptureTaskResourcesWithRetry/u,
  );
});

test("tab replacement migrates persistent capture ownership instead of treating it as source removal", () => {
  const replacedAt = backgroundSource.indexOf(
    "async function handleCaptureRuntimeTabReplaced",
  );
  const replacedEnd = backgroundSource.indexOf(
    "async function handleCaptureRuntimeTabRemoved",
    replacedAt,
  );
  const body = backgroundSource.slice(replacedAt, replacedEnd);
  assert.match(body, /captureTaskTabGroupManager\.replaceTab/u);
  assert.match(body, /captureDebugSessionManager\.replaceTab/u);
  assert.match(body, /replaceCaptureExecutionLockTabId/u);
  assert.doesNotMatch(body, /source_tab_removed/u);

  const listenerAt = backgroundSource.indexOf(
    "chrome.tabs.onReplaced?.addListener",
  );
  const listenerBody = backgroundSource.slice(listenerAt, listenerAt + 360);
  assert.match(listenerBody, /handleCaptureRuntimeTabReplaced\(addedTabId, removedTabId\)/u);
  assert.doesNotMatch(listenerBody, /handleCaptureRuntimeTabRemoved/u);
});

test("normal task end also closes any surviving registered worker", () => {
  const start = backgroundSource.indexOf(
    "async function releaseCaptureTaskResources",
  );
  const end = backgroundSource.indexOf("async function endCaptureTask", start);
  const body = backgroundSource.slice(start, end);
  assert.match(
    body,
    /captureDebugSessionManager\.getSessionByTaskId/u,
  );
  assert.match(body, /closeTrackedCaptureTaskWorkerTabs\(taskId, workerTabIds\)/u);
});

test("required owner is verified before and after task mutations", () => {
  const start = backgroundSource.indexOf("async function beginCaptureTask");
  const end = backgroundSource.indexOf("async function updateCaptureTask", start);
  const body = backgroundSource.slice(start, end);
  const firstOwnerCheckAt = body.indexOf("requireConnectedCaptureTaskOwner(taskId)");
  const groupAt = body.indexOf("captureTaskTabGroupManager.begin");
  const lastOwnerCheckAt = body.lastIndexOf("requireConnectedCaptureTaskOwner(taskId)");
  const returnAt = body.indexOf("return {taskId, session, group}");
  assert.ok(firstOwnerCheckAt >= 0 && firstOwnerCheckAt < groupAt);
  assert.ok(lastOwnerCheckAt > groupAt && lastOwnerCheckAt < returnAt);
  assert.match(body, /ownerRequired = request\.ownerRequired === true/u);
});

test("begin rollback uses the same ordered resource release contract", () => {
  const start = backgroundSource.indexOf("async function beginCaptureTask");
  const end = backgroundSource.indexOf("async function updateCaptureTask", start);
  const body = backgroundSource.slice(start, end);
  assert.match(body, /capture_task_begin_rollback/u);
  assert.match(body, /releaseCaptureTaskResourcesWithRetry/u);
  assert.doesNotMatch(body, /captureDebugSessionManager\.stopByTaskId[\s\S]*captureTaskTabGroupManager\.end/u);
});

test("sidebar owner disconnect is a bounded whole-task cancellation", () => {
  assert.match(
    backgroundSource,
    /OnStarvoiceCaptureTaskOwner\.createCoordinator\(\{\s*onAbandoned: handleAbandonedCaptureTask/u,
  );
  assert.match(
    backgroundSource,
    /chrome\.runtime\.onConnect\.addListener\(\(port\) => \{\s*captureTaskOwnerCoordinator\.attachPort\(port\)/u,
  );
  const start = backgroundSource.indexOf(
    "async function handleAbandonedCaptureTask",
  );
  const end = backgroundSource.indexOf(
    "async function setCaptureTaskMinimized",
    start,
  );
  const body = backgroundSource.slice(start, end);
  assert.match(body, /sidebar_owner_disconnected/u);
  assert.match(body, /terminalizeCaptureTaskLedgerRun\(normalizedTaskId/u);
  assert.match(body, /relayCaptureTaskCancellation/u);
  assert.match(body, /releaseCaptureTaskResources/u);
});

test("native Debug cancellation publishes a task tombstone before cleanup", () => {
  const start = backgroundSource.indexOf(
    "async function handleUnexpectedCaptureDebugDetach",
  );
  const end = backgroundSource.indexOf(
    "async function handleAbandonedCaptureTask",
    start,
  );
  const body = backgroundSource.slice(start, end);
  const publishAt = body.indexOf("publishCaptureTaskCancellation");
  const ledgerAt = body.indexOf("terminalizeCaptureTaskLedgerRun", publishAt);
  const relayAt = body.indexOf("relayCaptureTaskCancellation", ledgerAt);
  const releaseAt = body.indexOf("releaseCaptureTaskResources", relayAt);
  assert.ok(publishAt >= 0);
  assert.ok(ledgerAt > publishAt);
  assert.ok(relayAt > ledgerAt);
  assert.ok(releaseAt > relayAt);
  assert.match(backgroundSource, /captureTaskCancellation: cancellation/u);
});

test("batch sync cancellation reaches spacing, retry, content and lead writes", () => {
  const start = captureSyncSource.indexOf("async function runSyncRecordBatch");
  const end = captureSyncSource.indexOf("function buildSyncBatchRecordInput", start);
  const body = captureSyncSource.slice(start, end);
  assert.match(body, /const shouldStop = options\?\.shouldStop/u);
  assert.match(body, /const signal = options\?\.signal \|\| null/u);
  assert.match(body, /syncGroupRecordsWithRetry\(\{[\s\S]*shouldStop,[\s\S]*signal/u);
  assert.match(body, /waitForSyncRequestSlot\([\s\S]*shouldStop,[\s\S]*signal/u);
  assert.match(body, /waitForCancelableSyncDelay\([\s\S]*shouldStop,[\s\S]*signal/u);
  assert.match(body, /syncBatch\([\s\S]*\{shouldStop, signal\}/u);
  assert.match(body, /COMMENT_LEADS_SYNC_CANCELED/u);
});

test("profile recovery lineage survives the final batch request builder", () => {
  const start = captureSyncSource.indexOf("function buildSyncBatchRecordInput");
  const end = captureSyncSource.indexOf("function buildSyncRequestPayload", start);
  const body = captureSyncSource.slice(start, end);
  assert.match(body, /platform: record\.platform \|\| ''/u);
  assert.match(body, /workflow: record\.workflow \|\| ''/u);
  assert.match(
    body,
    /monitorExecutionId: record\.monitorExecutionId \|\| ''/u,
  );
  assert.match(body, /captureTaskId: record\.captureTaskId \|\| ''/u);
  assert.match(
    body,
    /captureTaskItemAttemptId: record\.captureTaskItemAttemptId \|\| ''/u,
  );
  assert.match(
    body,
    /captureTaskItemRequestHash: record\.captureTaskItemRequestHash \|\| ''/u,
  );
});
