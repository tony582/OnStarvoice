import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  beginCaptureTaskSession,
  endCaptureTaskSession,
  registerCaptureTaskTab,
} from "../../utils/capture-sync.js";

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

test("one-time cloud runs keep one-time copy and never enable a hidden extra round", () => {
  const progressSection = readFunctionSection(
    "function buildKeywordPlanProgressText(",
    "function renderKeywordPlanProgressText(",
  );
  assert.match(progressSection, /getKeywordExecutionCopy\(plan\)/u);
  assert.match(progressSection, /parts = \[executionCopy\.captureLabel\]/u);

  const runnerSection = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(request)",
    "async function runCaptureAction({",
  );
  assert.match(runnerSection, /getKeywordExecutionCopy\(request\)/u);
  assert.match(
    runnerSection,
    /autoLoopInput\.checked = plannedRounds > 1/u,
  );
  assert.match(
    runnerSection,
    /captureExecutionLabel:\s*executionCopy\.captureLabel/u,
  );
  assert.match(runnerSection, /executionLockLabel:\s*executionCopy\.taskLabel/u);
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

test("targeted patrol owns the dark task surface and exact stop binding", () => {
  const renderSection = readFunctionSection(
    "function renderCaptureDebugSession(runtime = {})",
    "function setupDebugSessionPanelControls()",
  );
  assert.match(renderSection, /buildTargetedPostSyntheticDebugSession/u);
  assert.match(
    renderSection,
    /usingTargetedSyntheticSession[\s\S]*?targetedSyntheticSession/u,
  );
  assert.match(renderSection, /targeted-post-synthetic/u);
  assert.match(renderSection, /data-targeted-post-request-id/u);

  const controlsSection = readFunctionSection(
    "function setupDebugSessionPanelControls()",
    "function setupAuthCodeInputListeners()",
  );
  assert.match(
    controlsSection,
    /cancelTargetedPostRunFromSidebar\([\s\S]*?targetedPostRequestId/u,
  );

  const runnerSection = readFunctionSection(
    "async function maybeClaimAndRunTargetedPostWorkflow()",
    "async function maybeClaimAndRunUnattendedKeywordPlan(",
  );
  assert.match(
    runnerSection,
    /detectUnavailableTargetPage:[\s\S]*?negative_post_patrol/u,
  );
  assert.match(runnerSection, /runnerTabId:\s*targetTabId/u);
  assert.match(
    runnerSection,
    /rawPhase\.startsWith\("target_"\)[\s\S]*?: `target_\$\{rawPhase\}`/u,
  );
  assert.doesNotMatch(runnerSection, /phase:\s*`target_\$\{String\(progress\.phase/u);
  assert.match(
    runnerSection,
    /const localRecordIds = collectTargetedPostRecordIds\(batchResult\);[\s\S]*?getRecords\(localRecordIds\)/u,
  );
  assert.doesNotMatch(runnerSection, /getRecords\(\)/u);

  const batchSection = readSourceSection(
    captureSyncSource,
    "export async function batchCaptureByUrls({",
    "/**\n * 批量关键词采集",
  );
  assert.match(
    batchSection,
    /runnerTabId:\s*explicitRunnerTabId\s*=\s*null/u,
  );
  assert.match(
    batchSection,
    /chrome\.tabs\.get\(normalizedExplicitRunnerTabId\)[\s\S]*?: await getCurrentActiveTab\(\)/u,
  );
});

test("targeted patrol heartbeat keeps long profile scans alive as business progress", async () => {
  const heartbeatSection = readFunctionSection(
    "function startTargetedPostRunHeartbeat(",
    "async function cancelTargetedPostRunFromSidebar(",
  );
  const calls = [];
  let intervalHandler = null;
  let clearedTimer = null;
  const token = {requestId: "task-1", attemptId: "attempt-1"};
  const request = {
    id: token.requestId,
    attemptId: token.attemptId,
    status: "running",
    progress: {
      phase: "target_profile_publish_date_verification",
      current: 1,
      total: 1,
    },
  };
  const context = {
    TARGETED_POST_RUN_HEARTBEAT_INTERVAL_MS: 20_000,
    setInterval: (handler, intervalMs) => {
      intervalHandler = handler;
      assert.equal(intervalMs, 20_000);
      return 91;
    },
    clearInterval: (timer) => {
      clearedTimer = timer;
    },
    isActiveTargetedPostInvocation: () => true,
    getTargetedPostInvocationTokenFromRequest: (value) => ({
      requestId: value.id,
      attemptId: value.attemptId,
    }),
    isSameTargetedPostInvocationToken: (left, right) =>
      left?.requestId === right?.requestId &&
      left?.attemptId === right?.attemptId,
    cloudTargetedPostApi: {
      isTerminalRunStatus: (status) =>
        ["completed", "failed", "canceled"].includes(status),
    },
    updateTargetedPostRun: async (...args) => {
      calls.push(args);
    },
    console,
  };
  vm.runInNewContext(
    `${heartbeatSection}
globalThis.__startTargetedPostRunHeartbeat = startTargetedPostRunHeartbeat;`,
    context,
  );

  const stop = context.__startTargetedPostRunHeartbeat(
    token,
    () => request,
  );
  intervalHandler();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], request);
  assert.equal(calls[0][2], token);
  assert.equal(
    calls[0][1].heartbeatAt,
    calls[0][1].businessProgressAt,
  );
  assert.equal(
    calls[0][1].progress.updatedAt,
    calls[0][1].heartbeatAt,
  );
  assert.equal(
    calls[0][1].progress.phase,
    "target_profile_publish_date_verification",
  );

  stop();
  assert.equal(clearedTimer, 91);
});

test("targeted runner is fenced by its URL attempt before adopting cloud state", () => {
  assert.match(
    sidebarSource,
    /TARGETED_POST_RUN_ATTEMPT_QUERY_KEY = "targetedPostAttempt"/u,
  );

  const urlSection = readFunctionSection(
    "function getTargetedPostRunRequestIdFromUrl()",
    "async function loadTargetedPostRunStateForDisplay()",
  );
  assert.match(
    urlSection,
    /function getTargetedPostRunAttemptIdFromUrl\(\)[\s\S]*?TARGETED_POST_RUN_ATTEMPT_QUERY_KEY/u,
  );

  const displaySection = readFunctionSection(
    "async function loadTargetedPostRunStateForDisplay()",
    "async function updateTargetedPostRun(",
  );
  assert.match(
    displaySection,
    /\.\.\.\(requestId \? \{requestId, attemptId\} : \{\}\)/u,
  );
  assert.match(
    displaySection,
    /if \(requestId && !attemptId\)[\s\S]*?targeted_post_attempt_required/u,
  );
  assert.match(
    displaySection,
    /resolveTargetedPostRunBinding\([\s\S]*?if \(!binding\.accepted\)[\s\S]*?return null/u,
  );

  const runnerSection = readFunctionSection(
    "async function maybeClaimAndRunTargetedPostWorkflow()",
    "async function maybeClaimAndRunUnattendedKeywordPlan(",
  );
  assert.match(
    runnerSection,
    /onstarvoice:get-targeted-post-run-state[\s\S]*?requestId,\s*attemptId/u,
  );
  const requiredAttemptIndex = runnerSection.indexOf(
    "if (!invocationToken)",
  );
  const firstStateReadIndex = runnerSection.indexOf(
    'type: "onstarvoice:get-targeted-post-run-state"',
  );
  const bindingIndex = runnerSection.indexOf(
    "const binding = resolveTargetedPostRunBinding(",
  );
  const rejectedBindingIndex = runnerSection.indexOf(
    "if (!binding.accepted)",
    bindingIndex,
  );
  const stateAdoptionIndex = runnerSection.indexOf(
    "targetedPostRunState = request",
    rejectedBindingIndex,
  );
  assert.ok(
    requiredAttemptIndex > -1 && requiredAttemptIndex < firstStateReadIndex,
  );
  assert.ok(bindingIndex > firstStateReadIndex);
  assert.ok(rejectedBindingIndex > bindingIndex);
  assert.ok(stateAdoptionIndex > rejectedBindingIndex);

  const bindingSection = readFunctionSection(
    "function resolveTargetedPostRunBinding(",
    "function stopTargetedPostRunnerForInvalidBinding(",
  );
  const context = {};
  vm.runInNewContext(
    `${bindingSection}
globalThis.__resolveTargetedPostRunBinding = resolveTargetedPostRunBinding;`,
    context,
  );
  const resolveBinding = context.__resolveTargetedPostRunBinding;

  const missingAttempt = resolveBinding(
    {ok: true, data: {id: "request-1", attemptId: "attempt-new"}},
    "request-1",
    "",
  );
  assert.equal(missingAttempt.accepted, false);
  assert.equal(missingAttempt.reason, "targeted_post_attempt_required");
  assert.equal(missingAttempt.request, null);

  const staleAttempt = resolveBinding(
    {ok: true, data: {id: "request-1", attemptId: "attempt-new"}},
    "request-1",
    "attempt-old",
  );
  assert.equal(staleAttempt.accepted, false);
  assert.equal(staleAttempt.reason, "stale_targeted_post_attempt");
  assert.equal(staleAttempt.request, null);

  const rejectedAttempt = resolveBinding(
    {
      ok: false,
      accepted: false,
      reason: "stale_targeted_post_attempt",
      data: {id: "request-1", attemptId: "attempt-new"},
    },
    "request-1",
    "attempt-old",
  );
  assert.equal(rejectedAttempt.accepted, false);
  assert.equal(rejectedAttempt.reason, "stale_targeted_post_attempt");
  assert.equal(rejectedAttempt.request, null);

  const matchingAttempt = resolveBinding(
    {
      ok: true,
      accepted: true,
      data: {
        id: "request-1",
        attemptId: "attempt-current",
      },
    },
    "request-1",
    "attempt-current",
  );
  assert.equal(matchingAttempt.accepted, true);
  assert.equal(matchingAttempt.reason, "");
  assert.equal(matchingAttempt.request.id, "request-1");
  assert.equal(matchingAttempt.request.attemptId, "attempt-current");
});

test("storage handoff from attempt A to B fences late A progress and cleanup", () => {
  const helperSection = readFunctionSection(
    "function createTargetedPostInvocationToken(",
    "function resolveTargetedPostRunBinding(",
  );
  const stopReasons = [];
  const context = {
    activeTargetedPostInvocationToken: null,
    targetedPostRunInFlightOwnerToken: null,
    targetedPostBatchStateOwnerToken: null,
    targetedPostRunnerTabOwnerToken: null,
    targetedPostRunState: null,
    targetedPostCancelRequested: false,
    batchUrlCancelRequested: false,
    activeBatchRunnerTabId: 77,
    getTargetedPostRunRequestIdFromUrl: () => "request-1",
    getTargetedPostRunAttemptIdFromUrl: () => "attempt-a",
    stopTargetedPostRunnerForInvalidBinding: (reason) => {
      stopReasons.push(reason);
    },
    renderCaptureDebugSession: () => {},
    getCurrentRuntime: () => ({}),
    requestCaptureCancelSignal: async () => true,
    console,
  };
  vm.runInNewContext(
    `${helperSection}
globalThis.__targetedAttemptHelpers = {
  createTargetedPostInvocationToken,
  activateTargetedPostInvocation,
  getTargetedPostInvocationOwnership,
  handleTargetedPostRunRequestStorageChange,
};`,
    context,
  );
  const helpers = context.__targetedAttemptHelpers;
  const attemptA = helpers.createTargetedPostInvocationToken(
    "request-1",
    "attempt-a",
  );
  helpers.activateTargetedPostInvocation(attemptA);
  context.targetedPostRunInFlightOwnerToken = attemptA;
  context.targetedPostBatchStateOwnerToken = attemptA;
  context.targetedPostRunnerTabOwnerToken = attemptA;
  context.targetedPostRunState = {
    id: "request-1",
    attemptId: "attempt-a",
    status: "running",
  };

  helpers.handleTargetedPostRunRequestStorageChange({
    id: "request-1",
    attemptId: "attempt-b",
    status: "running",
  });

  assert.equal(Object.isFrozen(attemptA), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.activeTargetedPostInvocationToken)),
    {requestId: "request-1", attemptId: "attempt-b"},
  );
  assert.equal(context.targetedPostRunState, null);
  assert.deepEqual(stopReasons, ["stale_targeted_post_attempt"]);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        helpers.getTargetedPostInvocationOwnership(attemptA),
      ),
    ),
    {active: false, run: true, batch: true, runnerTab: true},
  );

  const attemptB = helpers.createTargetedPostInvocationToken(
    "request-1",
    "attempt-b",
  );
  context.targetedPostRunInFlightOwnerToken = attemptB;
  context.targetedPostBatchStateOwnerToken = attemptB;
  context.targetedPostRunnerTabOwnerToken = attemptB;
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        helpers.getTargetedPostInvocationOwnership(attemptA),
      ),
    ),
    {active: false, run: false, batch: false, runnerTab: false},
  );

  const runnerSection = readFunctionSection(
    "async function maybeClaimAndRunTargetedPostWorkflow()",
    "async function maybeClaimAndRunUnattendedKeywordPlan(",
  );
  const progressIndex = runnerSection.indexOf(
    "onProgress: (progress = {}) =>",
  );
  const progressFenceIndex = runnerSection.indexOf(
    "if (!isActiveTargetedPostInvocation(invocationToken))",
    progressIndex,
  );
  const progressWriteIndex = runnerSection.indexOf(
    "targetedPostRunState = cloudTargetedPostApi.mergeRunPatch(",
    progressFenceIndex,
  );
  assert.ok(progressIndex > -1);
  assert.ok(progressFenceIndex > progressIndex);
  assert.ok(progressWriteIndex > progressFenceIndex);

  const finallyIndex = runnerSection.lastIndexOf("} finally {");
  const confirmBindingIndex = runnerSection.indexOf(
    "await confirmTargetedPostInvocationBinding(invocationToken)",
    finallyIndex,
  );
  const settleRunnerIndex = runnerSection.indexOf(
    "await settleTargetedPostRunnerTab(",
    confirmBindingIndex,
  );
  assert.ok(finallyIndex > -1);
  assert.ok(confirmBindingIndex > finallyIndex);
  assert.ok(settleRunnerIndex > confirmBindingIndex);
  assert.match(
    runnerSection.slice(finallyIndex),
    /if \(latestOwnership\.batch\)[\s\S]*?targetedPostBatchStateOwnerToken = null;/u,
  );
  assert.match(
    runnerSection.slice(finallyIndex),
    /if \(latestOwnership\.runnerTab\)[\s\S]*?targetedPostRunnerTabOwnerToken = null;/u,
  );
  assert.match(
    runnerSection.slice(finallyIndex),
    /if \(latestOwnership\.run\)[\s\S]*?targetedPostRunInFlightOwnerToken = null;/u,
  );
  assert.match(
    runnerSection.slice(finallyIndex),
    /if \(latestOwnership\.active\)[\s\S]*?activeTargetedPostInvocationToken = null;/u,
  );
});

test("targeted patrol reads only the records returned by the current batch", () => {
  const collectSection = readFunctionSection(
    "function collectTargetedPostRecordIds(",
    "async function maybeClaimAndRunTargetedPostWorkflow()",
  );
  const context = {};
  vm.runInNewContext(
    `${collectSection}
globalThis.__collectTargetedPostRecordIds = collectTargetedPostRecordIds;`,
    context,
  );

  assert.deepEqual(
    [...context.__collectTargetedPostRecordIds({
      results: [
        {recordIds: ["record-a", "record-b", "record-a", ""]},
        {recordIds: [" record-c "]},
        {recordIds: null},
      ],
    })],
    ["record-a", "record-b", "record-c"],
  );
  assert.deepEqual(
    [...context.__collectTargetedPostRecordIds({results: []})],
    [],
  );
});

test("official comment patrol starts one attempt-fenced task session before detail workers on both platforms", async (t) => {
  const contextBuilderSection = readFunctionSection(
    "function buildTargetedProfileCaptureTaskContext(",
    "async function maybeClaimAndRunTargetedPostWorkflow()",
  );
  const commentSessionSection = readFunctionSection(
    "async function runMonitorCommentPatrolWithCaptureTaskSession(",
    "async function executeMonitorRunItem(",
  );
  const monitorRunSection = readFunctionSection(
    "async function executeMonitorRunItem(",
    "async function handleRunMonitorNow()",
  );

  for (const [platform, sourceTabId, workerTabId] of [
    ["douyin", 731, 732],
    ["xiaohongshu", 741, 742],
  ]) {
    await t.test(platform, async () => {
      const requestId = `official-${platform}-task`;
      const attemptId = `official-${platform}-attempt`;
      const physicalTaskId = `${requestId}::${attemptId}`;
      const events = [];
      const lifecycleMessages = [];
      const releasedOwners = [];
      const finishedExecutions = [];
      const chromeApi = {
        runtime: {
          async sendMessage(message) {
            lifecycleMessages.push(JSON.parse(JSON.stringify(message)));
            return {ok: true, data: {taskId: message.taskId}};
          },
        },
      };
      const lifecycleOptions = {chromeApi};
      const context = {
        console,
        getTargetedPostInvocationTokenFromRequest: (request) => ({
          requestId: String(request?.id || ""),
          attemptId: String(request?.attemptId || ""),
        }),
        isSameTargetedPostInvocationToken: (left, right) =>
          left?.requestId === right?.requestId &&
          left?.attemptId === right?.attemptId,
        createTargetedPostInvocationError: () => {
          const error = new Error("stale targeted attempt");
          error.code = "stale_targeted_post_attempt";
          return error;
        },
        getTargetedWorkflowLabel: () => "官方账号评论巡查",
        supportsPersistentCaptureTaskPlatform: (value) =>
          value === "douyin" || value === "xiaohongshu",
        startRequiredCaptureTaskSession: async (options) => {
          events.push("session_begin");
          const begun = await beginCaptureTaskSession(
            options,
            lifecycleOptions,
          );
          assert.equal(begun.ok, true);
          assert.equal(begun.active, true);
          return begun;
        },
        endCaptureTaskSession: async (options) => {
          events.push("session_end");
          return await endCaptureTaskSession(options, lifecycleOptions);
        },
        releaseCaptureTaskOwner: (taskId) => {
          events.push("owner_release");
          releasedOwners.push(taskId);
        },
        resolveCaptureTaskTerminalStatus: ({taskStatus, canceled}) =>
          canceled
            ? {reason: "canceled", status: "canceled"}
            : {
                reason:
                  taskStatus === "completed" ? "completed" : taskStatus,
                status: taskStatus,
              },
        normalizeMonitorRunnerPlatform: (value) => String(value || ""),
        resolveMonitorRunnerAccountUrl: (runItem) => runItem.accountUrl,
        resolveMonitorRunnerName: (runItem) => runItem.title,
        reportMonitorRunProgress: (onProgress, progress, message) => {
          onProgress?.({...progress, message});
          return message;
        },
        startMonitorExecution: async () => ({ok: true}),
        batchCaptureByUrls: async () => {
          events.push("profile_list");
          return {
            ok: true,
            results: [{recordIds: [`${platform}-record`]}],
          };
        },
        resolveMonitorRunnerCaptureParams: () => ({}),
        collectBatchRecordIds: (result) =>
          result.results.flatMap((item) => item.recordIds || []),
        resolveMonitorRecordIdsForPublishWindow: async ({recordIds}) => ({
          recordIds,
          scannedCount: recordIds.length,
          filteredCount: 0,
          unknownCount: 0,
          windowLabel: `最近 ${recordIds.length} 篇`,
          detailResult: null,
        }),
        runEnhancementWithSingleRetry: async ({recordIds, runAttempt}) =>
          await runAttempt(recordIds, {isRetry: false}),
        batchCaptureDetailsForRecords: async (recordIds, options) => {
          events.push("comment_detail");
          assert.deepEqual(recordIds, [`${platform}-record`]);
          assert.equal(options.captureTaskId, physicalTaskId);
          const registration = await registerCaptureTaskTab(
            {
              taskId: options.captureTaskId,
              tabId: workerTabId,
              role: "detail_worker",
            },
            lifecycleOptions,
          );
          assert.equal(registration.ok, true);
          assert.notEqual(registration.skipped, true);
          return {
            ok: true,
            canceled: false,
            successCount: recordIds.length,
            failedCount: 0,
            results: recordIds.map((recordId) => ({recordId, ok: true})),
          };
        },
        syncRecordBatch: async (recordIds) => {
          events.push("sync");
          return {
            ok: true,
            results: recordIds.map(() => ({
              success: true,
              rawResponse: {action: "updated"},
            })),
          };
        },
        summarizeMonitorSyncResult: (syncResult) => ({
          successCount: syncResult.results.filter((item) => item.success)
            .length,
          failedCount: 0,
          insertedCount: 0,
          updatedCount: syncResult.results.length,
          negativeCount: 0,
        }),
        buildCommentLeadsConfigFromSettings: () => ({}),
        finishMonitorExecutionSafely: async (executionId, result) => {
          finishedExecutions.push({executionId, result});
          return {ok: true};
        },
        showProgress: () => {},
      };

      vm.runInNewContext(
        `${contextBuilderSection}\n${commentSessionSection}\n${monitorRunSection}\n` +
          `globalThis.__officialPatrolHarness = {\n` +
          `  buildContext: buildTargetedProfileCaptureTaskContext,\n` +
          `  execute: executeMonitorRunItem,\n` +
          `};`,
        context,
      );
      const invocationToken = {requestId, attemptId};
      const captureTaskContext =
        context.__officialPatrolHarness.buildContext(
          {
            id: requestId,
            attemptId,
            workflow: "official_account_comment_patrol",
          },
          invocationToken,
        );
      assert.deepEqual(
        JSON.parse(JSON.stringify(captureTaskContext)),
        {
          taskId: physicalTaskId,
          attemptId,
          label: "官方账号评论巡查",
          ownerRequired: true,
        },
      );

      const result = await context.__officialPatrolHarness.execute({
        runItem: {
          subscriptionId: `${platform}-subscription`,
          executionId: `${platform}-execution`,
          platform,
          accountUrl:
            platform === "douyin"
              ? "https://www.douyin.com/user/test"
              : "https://www.xiaohongshu.com/user/profile/test",
          title: `${platform} 官方账号`,
        },
        monitorSettings: {postsLimit: 1},
        captureSettings: {
          includeComments: true,
          commentsMaxDetectedItems: 100,
        },
        runnerTabId: sourceTabId,
        executionPreclaimed: true,
        captureTaskContext,
        shouldStop: () => false,
      });

      assert.equal(result.status, "success");
      assert.deepEqual(events, [
        "profile_list",
        "session_begin",
        "comment_detail",
        "session_end",
        "owner_release",
        "sync",
      ]);
      assert.deepEqual(releasedOwners, [physicalTaskId]);
      assert.equal(finishedExecutions.length, 1);
      assert.equal(finishedExecutions[0].result.status, "succeeded");

      const taskMessages = lifecycleMessages.filter(
        (message) =>
          message.type !== "onstarvoice:relay-to-content",
      );
      assert.deepEqual(
        taskMessages.map((message) => ({
          type: message.type,
          taskId: message.taskId,
          attemptId: message.attemptId,
          tabId: message.tabId,
          role: message.role,
        })),
        [
          {
            type: "onstarvoice:begin-capture-task",
            taskId: physicalTaskId,
            attemptId,
            tabId: sourceTabId,
            role: undefined,
          },
          {
            type: "onstarvoice:register-capture-task-tab",
            taskId: physicalTaskId,
            attemptId,
            tabId: workerTabId,
            role: "detail_worker",
          },
          {
            type: "onstarvoice:end-capture-task",
            taskId: physicalTaskId,
            attemptId,
            tabId: undefined,
            role: undefined,
          },
        ],
      );
    });
  }
});

test("official comment patrol cancellation ends and releases its exact native task session", async () => {
  const commentSessionSection = readFunctionSection(
    "async function runMonitorCommentPatrolWithCaptureTaskSession(",
    "async function executeMonitorRunItem(",
  );
  const calls = [];
  const context = {
    supportsPersistentCaptureTaskPlatform: () => true,
    startRequiredCaptureTaskSession: async (options) => {
      calls.push({type: "begin", options});
      return {ok: true, active: true};
    },
    endCaptureTaskSession: async (options) => {
      calls.push({type: "end", options});
      return {ok: true};
    },
    releaseCaptureTaskOwner: (taskId) => {
      calls.push({type: "release", taskId});
    },
    resolveCaptureTaskTerminalStatus: ({canceled}) =>
      canceled
        ? {reason: "canceled", status: "canceled"}
        : {reason: "completed", status: "completed"},
  };
  vm.runInNewContext(
    `${commentSessionSection}\n` +
      `globalThis.__runCommentPatrol = runMonitorCommentPatrolWithCaptureTaskSession;`,
    context,
  );

  const result = await context.__runCommentPatrol({
    platform: "douyin",
    runnerTabId: 751,
    captureTaskContext: {
      taskId: "official-task::attempt-current",
      attemptId: "attempt-current",
      label: "官方账号评论巡查",
    },
    shouldStop: () => true,
    run: async () => ({ok: false, canceled: true, failedCount: 0}),
  });

  assert.equal(result.canceled, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [
      {
        type: "begin",
        options: {
          taskId: "official-task::attempt-current",
          attemptId: "attempt-current",
          tabId: 751,
          label: "官方账号评论巡查",
          platform: "douyin",
          ownerRequired: true,
        },
      },
      {
        type: "end",
        options: {
          taskId: "official-task::attempt-current",
          reason: "canceled",
          status: "canceled",
        },
      },
      {
        type: "release",
        taskId: "official-task::attempt-current",
      },
    ],
  );
});

test("a completed Douyin targeted patrol pauses its owned media and returns its runner home", async () => {
  const cleanupSection = readFunctionSection(
    "async function settleTargetedPostRunnerTab(",
    "async function waitForTargetedPostRunnerTab(",
  );
  const scriptCalls = [];
  const tabUpdates = [];
  const context = {
    chrome: {
      tabs: {
        get: async () => ({
          id: 77,
          url: "https://www.douyin.com/video/766193585000000001",
        }),
        update: async (tabId, patch) => {
          tabUpdates.push({tabId, patch});
          return {id: tabId, ...patch};
        },
      },
      scripting: {
        executeScript: async (payload) => {
          scriptCalls.push(payload);
          return [{result: 1}];
        },
      },
    },
    detectPlatformFromUrl: (url) =>
      String(url || "").includes("douyin.com") ? "douyin" : "unknown",
    TARGETED_POST_RUNNER_HOME_URLS: {
      douyin: "https://www.douyin.com/jingxuan",
    },
    console,
  };
  vm.runInNewContext(
    `${cleanupSection}
globalThis.__settleTargetedPostRunnerTab = settleTargetedPostRunnerTab;`,
    context,
  );

  assert.equal(
    await context.__settleTargetedPostRunnerTab(77, "douyin"),
    true,
  );
  assert.equal(scriptCalls.length, 1);
  assert.equal(scriptCalls[0].target.tabId, 77);
  assert.deepEqual(
    JSON.parse(JSON.stringify(tabUpdates)),
    [{
      tabId: 77,
      patch: {
        url: "https://www.douyin.com/jingxuan",
        active: true,
      },
    }],
  );

  const runnerSection = readFunctionSection(
    "async function maybeClaimAndRunTargetedPostWorkflow()",
    "async function maybeClaimAndRunUnattendedKeywordPlan(",
  );
  const settleIndex = runnerSection.lastIndexOf(
    "await settleTargetedPostRunnerTab(targetTabId, request?.platform, {",
  );
  const clearIndex = runnerSection.lastIndexOf(
    "activeBatchRunnerTabId = null",
  );
  assert.ok(settleIndex > -1);
  assert.ok(clearIndex > settleIndex);
});

test("targeted patrol cleanup never redirects a non-Douyin runner", async () => {
  const cleanupSection = readFunctionSection(
    "async function settleTargetedPostRunnerTab(",
    "async function waitForTargetedPostRunnerTab(",
  );
  const scriptCalls = [];
  const tabUpdates = [];
  const context = {
    chrome: {
      tabs: {
        get: async () => ({
          id: 88,
          url: "https://www.xiaohongshu.com/explore/note-1",
        }),
        update: async (tabId, patch) => {
          tabUpdates.push({tabId, patch});
          return {id: tabId, ...patch};
        },
      },
      scripting: {
        executeScript: async (payload) => {
          scriptCalls.push(payload);
          return [];
        },
      },
    },
    detectPlatformFromUrl: (url) =>
      String(url || "").includes("xiaohongshu.com")
        ? "xiaohongshu"
        : "unknown",
    TARGETED_POST_RUNNER_HOME_URLS: {
      douyin: "https://www.douyin.com/jingxuan",
    },
    console,
  };
  vm.runInNewContext(
    `${cleanupSection}
globalThis.__settleTargetedPostRunnerTab = settleTargetedPostRunnerTab;`,
    context,
  );

  assert.equal(
    await context.__settleTargetedPostRunnerTab(88, "douyin"),
    false,
  );
  assert.equal(scriptCalls.length, 0);
  assert.equal(tabUpdates.length, 0);
});

test("targeted patrol safety intervention pauses media without leaving the page", async () => {
  const cleanupSection = readFunctionSection(
    "async function settleTargetedPostRunnerTab(",
    "async function waitForTargetedPostRunnerTab(",
  );
  const scriptCalls = [];
  const tabUpdates = [];
  const context = {
    chrome: {
      tabs: {
        get: async () => ({
          id: 99,
          url: "https://www.douyin.com/video/766193585000000002",
        }),
        update: async (tabId, patch) => {
          tabUpdates.push({tabId, patch});
          return {id: tabId, ...patch};
        },
      },
      scripting: {
        executeScript: async (payload) => {
          scriptCalls.push(payload);
          return [{result: 1}];
        },
      },
    },
    detectPlatformFromUrl: () => "douyin",
    TARGETED_POST_RUNNER_HOME_URLS: {
      douyin: "https://www.douyin.com/jingxuan",
    },
    console,
  };
  vm.runInNewContext(
    `${cleanupSection}
globalThis.__settleTargetedPostRunnerTab = settleTargetedPostRunnerTab;`,
    context,
  );

  assert.equal(
    await context.__settleTargetedPostRunnerTab(99, "douyin", {
      returnHome: false,
    }),
    true,
  );
  assert.equal(scriptCalls.length, 1);
  assert.equal(tabUpdates.length, 0);
});

test("a normal side panel without a runner query renders shared targeted state and stops that exact request", async () => {
  const syntheticSection = readFunctionSection(
    "function buildTargetedPostSyntheticDebugSession(",
    "function resolveDisplayedUnattendedSessionBinding(",
  );
  const sharedRequest = {
    id: "shared-targeted-request",
    attemptId: "shared-targeted-attempt",
    workflow: "negative_post_patrol",
    status: "running",
    platform: "xiaohongshu",
    createdAt: "2026-07-27T01:00:00.000Z",
    targets: [{
      itemId: "item-1",
      title: "待巡查帖子",
      url: "https://www.xiaohongshu.com/explore/note-1",
      ordinal: 1,
    }],
    targetResults: [],
    progress: {current: 1, total: 1, itemId: "item-1"},
    checkpoint: {processedCount: 0},
  };
  const syntheticContext = {
    targetedPostRunState: sharedRequest,
    getTargetedPostRunRequestIdFromUrl: () => "",
    cloudTargetedPostApi: {isTerminalRunStatus: () => false},
    debugSessionDismissedTargetedTerminalRunAt: "",
    activeBatchRunnerTabId: null,
    getPagePlatform: () => "xiaohongshu",
  };
  vm.runInNewContext(
    `${syntheticSection}\nglobalThis.__buildTargeted = buildTargetedPostSyntheticDebugSession;`,
    syntheticContext,
  );
  const session = syntheticContext.__buildTargeted({});
  assert.equal(session.targetedPost, true);
  assert.equal(session.taskId, "targeted-post:shared-targeted-request");
  assert.equal(session.progress.currentTargetTitle, "待巡查帖子");

  const cancelSection = readFunctionSection(
    "async function cancelTargetedPostRunFromSidebar(",
    "async function waitForTargetedPostRunnerTab(",
  );
  const updateCalls = [];
  const cancelContext = {
    targetedPostRunState: sharedRequest,
    cloudTargetedPostApi: {isTerminalRunStatus: () => false},
    targetedPostCancelRequested: false,
    batchUrlCancelRequested: false,
    activeBatchRunnerTabId: null,
    targetedPostRunnerTabOwnerToken: null,
    getTargetedPostInvocationTokenFromRequest: (request) =>
      request?.id && request?.attemptId
        ? {
            requestId: request.id,
            attemptId: request.attemptId,
          }
        : null,
    getTargetedPostRunRequestIdFromUrl: () => "",
    getTargetedPostRunAttemptIdFromUrl: () => "",
    createTargetedPostInvocationToken: () => null,
    isSameTargetedPostInvocationToken: (left, right) =>
      Boolean(
        left &&
          right &&
          left.requestId === right.requestId &&
          left.attemptId === right.attemptId,
      ),
    isActiveTargetedPostInvocation: () => false,
    updateTargetedPostRun: async (request, patch) => {
      updateCalls.push({request, patch});
      return {...request, ...patch};
    },
    requestCaptureCancelSignal: async () => true,
    console,
  };
  vm.runInNewContext(
    `${cancelSection}\nglobalThis.__cancelTargeted = cancelTargetedPostRunFromSidebar;`,
    cancelContext,
  );
  assert.equal(await cancelContext.__cancelTargeted("another-request"), false);
  assert.equal(updateCalls.length, 0);
  assert.equal(
    await cancelContext.__cancelTargeted("shared-targeted-request"),
    true,
  );
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].request.id, "shared-targeted-request");
  assert.equal(updateCalls[0].patch.cancelRequested, true);

  const initSection = readFunctionSection(
    "export async function initSidebar()",
    "// ==================== 状态订阅",
  );
  assert.match(initSection, /loadTargetedPostRunStateForDisplay\(\)/u);
});

test("closing a terminal status page dismisses both current terminal task families", () => {
  const dismissSection = readFunctionSection(
    "function dismissAllTerminalCaptureSummaries()",
    "function setupDebugSessionPanelControls()",
  );
  const context = {
    keywordPlanState: {},
    buildKeywordRunDisplayPlan: () => ({
      lastRunStatus: "completed",
      lastRunAt: "2026-07-27T12:00:00.000Z",
      lastRunProgress: {},
      lastRunMessage: "一次性采集已完成",
    }),
    KEYWORD_PLAN_TERMINAL_STATUSES: new Set(["completed"]),
    targetedPostRunState: {
      id: "targeted-close-test",
      status: "completed",
      finishedAt: "2026-07-27T12:01:00.000Z",
      message: "负面帖子巡查已完成",
    },
    cloudTargetedPostApi: {
      isTerminalRunStatus: (status) => status === "completed",
    },
    debugSessionDismissedUnattendedTerminalRunAt: "",
    debugSessionDismissedTargetedTerminalRunAt: "",
  };
  vm.runInNewContext(
    `${dismissSection}
globalThis.__dismissAll = dismissAllTerminalCaptureSummaries;`,
    context,
  );

  context.__dismissAll();

  assert.equal(
    context.debugSessionDismissedUnattendedTerminalRunAt,
    "2026-07-27T12:00:00.000Z",
  );
  assert.equal(
    context.debugSessionDismissedTargetedTerminalRunAt,
    "2026-07-27T12:01:00.000Z",
  );

  const controlsSection = readFunctionSection(
    "function setupDebugSessionPanelControls()",
    "function setupAuthCodeInputListeners()",
  );
  assert.match(
    controlsSection,
    /dataset\?\.terminal === "true"[\s\S]*?dismissAllTerminalCaptureSummaries\(\)/u,
  );
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

  const runtimeSection = readFunctionSection(
    "async function waitForRuntimeSearchPage(",
    "function resolveUnattendedBootstrapStartGate(",
  );
  assert.match(runtimeSection, /platform === "douyin"/);
  assert.match(runtimeSection, /chrome\.scripting[\s\S]*?executeScript/);
  assert.match(runtimeSection, /keywordMatched &&[\s\S]*?hasSearchShell/);
  assert.match(runtimeSection, /pathname\.startsWith\("\/search\/"\)/);

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
    UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS: 4,
    UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS: [0, 0],
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
    sleepWithStop: async () => {},
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
    tabReadiness: [false, false, false, false],
  });

  await assert.rejects(harness.navigate(), (error) => {
    assert.equal(error.code, "UNATTENDED_SEARCH_BOOTSTRAP_FAILED");
    assert.equal(error.attempts, 4);
    return true;
  });
  assert.equal(harness.updates.length, 4);
  assert.equal(harness.retries.length, 3);
  assert.equal(harness.runtimeChecks(), 0);
});

test("unattended Douyin bootstrap accepts the bound search shell while global runtime lags", async () => {
  const runtimeSection = readFunctionSection(
    "async function waitForRuntimeSearchPage(",
    "function resolveUnattendedBootstrapStartGate(",
  );
  let probeCount = 0;
  const sandbox = vm.createContext({
    PAGE_TYPE: {SEARCH_RESULTS: "search_results"},
    chrome: {
      scripting: {
        executeScript: async () => {
          probeCount += 1;
          return [{result: true}];
        },
      },
    },
    getCurrentRuntime: () => ({
      platform: "douyin",
      pageType: "note_detail",
      lastActiveTabId: 101,
      lastPageUrl: "https://www.douyin.com/video/123456789",
    }),
    getPagePlatform: (runtime) => runtime?.platform || "",
    setTimeout: (resolve) => resolve(),
  });
  vm.runInContext(
    `${runtimeSection}\nglobalThis.__wait = waitForRuntimeSearchPage;`,
    sandbox,
  );

  const ready = await sandbox.__wait({
    platform: "douyin",
    tabId: 101,
    expectedUrl:
      "https://www.douyin.com/search/%E5%87%AF%E8%BF%AA%E6%8B%89%E5%85%8B?type=general",
    expectedKeyword: "凯迪拉克",
    timeoutMs: 1000,
  });

  assert.equal(ready, true);
  assert.equal(probeCount, 1);
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
  assert.equal(harness.retries.length, 3);
});

test("elastic unattended starts obey a bounded soft gate and healthy manual runs do not wait", () => {
  const gateSection = readFunctionSection(
    "function resolveUnattendedBootstrapStartGate(request = {}, now = Date.now())",
    "async function navigateActiveTabToKeywordSearchForPlan({",
  );
  const sandbox = vm.createContext({
    UNATTENDED_BOOTSTRAP_GATE_MAX_WAIT_MS: 60_000,
  });
  vm.runInContext(
    `${gateSection}\nglobalThis.__resolveGate = resolveUnattendedBootstrapStartGate;`,
    sandbox,
  );
  const now = Date.parse("2026-08-24T00:00:00.000Z");
  const manual = sandbox.__resolveGate({}, now);
  assert.equal(manual.delayed, false);
  assert.equal(manual.waitMs, 0);

  const delayed = sandbox.__resolveGate({
    orchestrationContext: {
      distributionMode: "elastic_pool",
      bootstrapStartNotBefore: "2026-08-24T00:00:25.000Z",
      bootstrapPacingReason: "staggered_start",
    },
  }, now);
  assert.equal(delayed.delayed, true);
  assert.equal(delayed.waitMs, 25_000);
  assert.equal(delayed.reason, "staggered_start");

  const bounded = sandbox.__resolveGate({
    orchestrationContext: {
      distributionMode: "elastic_pool",
      bootstrapStartNotBefore: "2026-08-24T00:05:00.000Z",
      bootstrapPacingReason: "recent_technical_congestion",
    },
  }, now);
  assert.equal(bounded.waitMs, 60_000);
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
  const gateIndex = section.indexOf(
    "const bootstrapGate = resolveUnattendedBootstrapStartGate(request)",
  );
  const switchIndex = section.indexOf("let switchResult = null");
  const retryIndex = section.indexOf("onRetry: async ({nextAttempt, maxAttempts, retryDelayMs, waitUntil})", navigationIndex);
  const batchIndex = section.indexOf("batchRunResult = await handleBatchKeywordCapture({", retryIndex);
  const terminalCatchIndex = section.indexOf(
    'console.error("[Sidebar] Unattended keyword plan failed:", error)',
  );

  assert.ok(gateIndex > -1);
  assert.ok(switchIndex > gateIndex);
  assert.ok(navigationIndex > switchIndex);
  assert.ok(retryIndex > navigationIndex);
  assert.ok(batchIndex > retryIndex);
  assert.ok(terminalCatchIndex > batchIndex);
  assert.match(section.slice(retryIndex, batchIndex), /phase: "waiting_search_page_retry"/);
  assert.match(section.slice(retryIndex, batchIndex), /waitUntil,/);
  assert.match(section.slice(retryIndex, batchIndex), /retried: Math\.max\(0, Number\(nextAttempt\) - 1\)/);
  assert.match(section.slice(gateIndex, switchIndex), /phase: "waiting_bootstrap_slot"/);
  assert.match(
    section.slice(terminalCatchIndex),
    /const bootstrapCanceled =\s+error\?\.code === "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED"/,
  );
  assert.match(
    section,
    /const bootstrapFailed =\s+error\?\.code === "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"/,
  );
  assert.match(
    section,
    /const terminalStatus = cancellation\?\.status \|\|\s*\(needsAction \? "needs_action" : "failed"\)/,
  );
});

test("unattended keyword failures use four spaced attempts with a durable countdown", () => {
  assert.match(sidebarSource, /const UNATTENDED_KEYWORD_MAX_ATTEMPTS = 4/u);
  assert.match(
    sidebarSource,
    /const UNATTENDED_KEYWORD_RETRY_DELAYS_MS = Object\.freeze\(\[\s*30 \* 1000,\s*2 \* 60 \* 1000,\s*5 \* 60 \* 1000,/u,
  );
  const handlerSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  assert.match(handlerSection, /Math\.min\(4, Number\(runOptions\.maxKeywordAttempts\) \|\| 1\)/u);
  assert.match(handlerSection, /UNATTENDED_KEYWORD_RETRY_DELAYS_MS\[/u);
  assert.match(handlerSection, /"keyword_retry_wait"/u);
  assert.match(handlerSection, /waitUntil,/u);
  assert.match(handlerSection, /attemptTotal: maxKeywordAttempts/u);
});

test("elastic keyword cooldown releases the work item, pauses the source Agent, and leaves the loading page", () => {
  const handlerSection = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  const unattendedSection = readFunctionSection(
    "async function runUnattendedKeywordPlanRequest(request)",
    "async function runCaptureAction({",
  );
  const cooldownHomeSection = readFunctionSection(
    "async function returnUnattendedAgentToCooldownHome({",
    "function buildSidebarKeywordSearchUrl(",
  );

  assert.match(handlerSection, /releaseElasticItemOnLongRetry/u);
  assert.match(handlerSection, /UNATTENDED_ELASTIC_RELEASE_MIN_DELAY_MS/u);
  assert.match(handlerSection, /UNATTENDED_ELASTIC_ITEM_RELEASED/u);
  assert.match(handlerSection, /itemLockReleased = true/u);
  assert.match(
    unattendedSection,
    /request\?\.orchestrationContext\?\.distributionMode === "elastic_pool"/u,
  );
  assert.match(unattendedSection, /returnUnattendedAgentToCooldownHome/u);
  assert.match(
    unattendedSection,
    /elasticQueueAssigned && \(elasticItemReleased \|\| bootstrapFailed\)/u,
  );
  assert.match(unattendedSection, /cooldownHomeRestored/u);
  assert.match(cooldownHomeSection, /chrome\.tabs\.update\(normalizedTabId/u);
  assert.match(cooldownHomeSection, /url: homeUrl/u);
  assert.match(sidebarSource, /https:\/\/www\.douyin\.com\/jingxuan/u);
  assert.match(sidebarSource, /https:\/\/www\.xiaohongshu\.com\/explore/u);
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
  const interruptionAt = section.indexOf(
    "const resultInterruption = resolveUnattendedEnhanceCancellation",
  );
  const terminalStopAt = section.indexOf(
    "if (resultInterruption.stopBatch)",
    interruptionAt,
  );
  const recoverableAt = section.indexOf(
    "if (enhanceResult?.canceled || resultInterruption.recoverable)",
    interruptionAt,
  );
  const autoSyncAt = section.indexOf(
    "await maybeRunAutoSyncAfterDetailCapture",
    interruptionAt,
  );
  const enqueueMissingAt = section.indexOf(
    "streamingSyncQueue.enqueueMissing(recordIds",
    interruptionAt,
  );
  assert.ok(terminalStopAt > interruptionAt);
  assert.ok(recoverableAt > terminalStopAt);
  assert.ok(enqueueMissingAt > recoverableAt);
  assert.ok(autoSyncAt > terminalStopAt);
  assert.match(
    section.slice(terminalStopAt, recoverableAt),
    /batchKeywordCancelRequested = true[\s\S]*?stopBatch: true/u,
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

test("streaming sync waits for a safe terminal decision before queuing failed details", () => {
  const router = readFunctionSection(
    "function routeDetailItemToStreamingSync(",
    "function formatStreamingSyncSummary(",
  );
  const batch = readFunctionSection(
    "async function handleBatchKeywordCapture(options = {})",
    "async function reportUnattendedKeywordRun(",
  );
  const stopAt = batch.indexOf("if (resultInterruption.stopBatch)");
  const recoverableAt = batch.indexOf(
    "if (enhanceResult?.canceled || resultInterruption.recoverable)",
    stopAt,
  );
  const enqueueMissingAt = batch.indexOf(
    "streamingSyncQueue.enqueueMissing(recordIds",
    recoverableAt,
  );

  assert.match(
    router,
    /phase !== "detail_item_done"[\s\S]*?return;[\s\S]*?streamingSyncQueue\.enqueue\(recordId/u,
  );
  assert.match(
    router,
    /phase === "detail_item_filtered"[\s\S]*?phase === "detail_item_skipped"[\s\S]*?markSeen/u,
  );
  assert.ok(stopAt >= 0);
  assert.ok(recoverableAt > stopAt);
  assert.ok(enqueueMissingAt > recoverableAt);
  assert.doesNotMatch(
    batch.slice(0, stopAt),
    /streamingSyncQueue\.enqueueMissing\(recordIds/u,
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
    /const unattendedSyntheticSession = buildUnattendedSyntheticDebugSession\(\s*runtime,\s*displayPlan,\s*\)/,
  );
  assert.match(
    renderSection,
    /nativeVisible \|\|[\s\S]*?Boolean\(targetedSyntheticSession\) \|\|[\s\S]*?Boolean\(unattendedSyntheticSession\)/,
  );
  assert.match(
    renderSection,
    /usingUnattendedSyntheticSession[\s\S]*?"unattended-synthetic"[\s\S]*?"native-debug"/,
  );
  assert.match(
    renderSection,
    /unattendedSyntheticSession &&[\s\S]*?\(!nativeVisible \|\| unattendedSyntheticSession\.terminal\)/,
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
