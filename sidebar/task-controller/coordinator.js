import {createKeywordTaskState} from './keyword-state.js';
import {createProgressVisibilityController} from './progress-visibility.js';
import {createKeywordDraftsController} from './keyword-drafts.js';
import {createKeywordPlanController} from './keyword-plan.js';
import {createKeywordStrategyController} from './keyword-strategy.js';
import {createKeywordAnalysisController} from './keyword-analysis.js';
import {createMonitorSubscriptionsController} from './monitor-subscriptions.js';
import {createMonitorPolicyController} from './monitor-policy.js';
import {createKeywordSortController} from './keyword-sort.js';
import {createTaskLedgerAssistController} from './task-ledger-assist.js';
import {createOwnerController} from './owner.js';
import {createUnattendedControlController} from './unattended-control.js';
import {createProgressProjectionController} from './progress-projection.js';
import {createManualCaptureController} from './manual-capture.js';
import {createCancelAndStreamingQueueController} from './cancel-and-streaming-queue.js';
import {createBatchKeywordController} from './batch-keyword.js';
import {createUnattendedReportingAndClosureController} from './unattended-reporting-and-closure.js';
import {createExecutionLockController} from './execution-lock.js';
import {createTargetedController} from './targeted.js';
import {createUnattendedRunController} from './unattended-run.js';
import {createCaptureActionCancelController} from './capture-action-cancel.js';
import {createMonitorExecutionController} from './monitor-execution.js';
import {createDetailSyncController} from './detail-sync.js';
import {createRecordRetryController} from './record-retry.js';
import {createRecoveryController} from './recovery.js';
import {createProgressController} from './progress.js';
import {createUrlBatchController} from './url-batch.js';

// Own task state once per Sidebar. Named legacy compatibility reads preserve
// original values (including object identity); they are not deep immutable DTOs
// and must not be exported as trusted new-UI command or identity capabilities.
export function createSidebarTaskController(controllerPorts) {
  const controllerState = {
    ...createKeywordTaskState(),
    activeCommentsCaptureRecordId: "",
    activeCommentsCaptureTabId: null,
    activeCommentsCaptureRequestId: "",
    activeRecoveryProgress: null,
    activeRecoveryRunnerTabId: null,
    captureRecoveryFreshnessTimer: null,
    suppressedCaptureRecoveryKeys: new Set(),
    commentCaptureTerminalStatusByRecordId: new Map(),
    detailBatchCaptureInFlight: false,
    detailBatchCancelRequested: false,
    activeDetailCaptureInvocationToken: null,
    detailBatchRunnerTabId: null,
    detailBatchRunnerTabIds: new Set(),
    detailBatchWorkerStates: [],
    detailBatchWorkerMode: "",
    detailBatchWorkerRevision: 0,
    lastProgressSyncAt: 0,
    lastPoolRefreshAt: 0,
    lastTaskLedgerProgressAt: 0,
    activeCaptureTaskProgressContext: null,
    batchUrlCaptureInFlight: false,
    batchUrlCancelRequested: false,
    batchUrlCaptureMode: "",
    targetedPostCancelRequested: false,
    targetedPostRunInFlight: false,
    targetedPostRunState: null,
    targetedPostRunBindingStopReason: "",
    activeTargetedPostInvocationToken: null,
    targetedPostRunInFlightOwnerToken: null,
    targetedPostBatchStateOwnerToken: null,
    targetedPostRunnerTabOwnerToken: null,
    batchKeywordCaptureInFlight: false,
    batchKeywordCancelRequested: false,
    activeBatchKeywordInvocationToken: null,
    searchCaptureCancelRequested: false,
    activeBatchRunnerTabId: null,
    captureTaskOwnerPort: null,
    captureTaskOwnerClosing: false,
    captureTaskOwnerTaskId: "",
    lastCaptureTaskCancellationKey: "",
    activeCaptureTaskCancellationReason: "",
    monitorRunInFlight: false,
    monitorRunCancelRequested: false,
    activeCaptureExecutionLockId: "",
    adoptedUnattendedCaptureExecutionLockId: "",
    captureExecutionLockHeartbeatTimer: null,
    captureExecutionLockHeartbeatLockId: "",
    captureExecutionLockHeartbeatInFlight: false,
    captureExecutionLockInitialHolderTabId: null,
    captureExecutionLockReleasePendingId: "",
    activeUnattendedRunRequestId: "",
    activeUnattendedRunAttemptId: "",
    pendingUnattendedCancellationRequestId: "",
    pendingUnattendedCancellationAttemptId: "",
    activeUnattendedTerminalProgressKey: "",
    activeUnattendedProgressSeq: 0,
    activeUnattendedAttemptRejected: false,
    lastUnattendedContentProgressAt: 0,
    lastUnattendedContentProgressFingerprint: "",
    unattendedFinalFlushRetryTimersByIdentity: new Map(),
    unattendedFinalFlushInFlightByIdentity: new Map(),
    unattendedCheckpointOutboxFlushPromise: null,
  };
  const controllerOperations = Object.create(null);
  Object.assign(controllerOperations, createProgressVisibilityController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createTaskLedgerAssistController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createOwnerController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createUnattendedControlController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createProgressProjectionController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createManualCaptureController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createCancelAndStreamingQueueController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createBatchKeywordController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createUnattendedReportingAndClosureController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createExecutionLockController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createTargetedController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createUnattendedRunController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createCaptureActionCancelController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createMonitorExecutionController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createDetailSyncController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createRecordRetryController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createRecoveryController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createProgressController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createUrlBatchController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createKeywordDraftsController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createKeywordPlanController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createKeywordStrategyController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createKeywordAnalysisController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createMonitorSubscriptionsController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createMonitorPolicyController({controllerState, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createKeywordSortController({controllerState, controllerPorts, controllerOperations}));
  function shutdownCaptureTaskOwner() {
    controllerState.captureTaskOwnerClosing = true;
    controllerState.captureTaskOwnerPort?.disconnect?.();
    controllerState.captureTaskOwnerPort = null;
  }
  return Object.freeze({
    ...controllerOperations,
    readExpandedKeywordsBuffer: () => controllerState.expandedKeywordsBuffer,
    readKeywordAnalysisInFlight: () => controllerState.keywordAnalysisInFlight,
    readKeywordBenchmarkAnalysisStatus: () => controllerState.keywordBenchmarkAnalysisStatus,
    readKeywordBenchmarkErrorMessage: () => controllerState.keywordBenchmarkErrorMessage,
    readKeywordBenchmarkInFlight: () => controllerState.keywordBenchmarkInFlight,
    readKeywordBenchmarkLoadingMeta: () => controllerState.keywordBenchmarkLoadingMeta,
    readKeywordBenchmarkLoadingTitle: () => controllerState.keywordBenchmarkLoadingTitle,
    readKeywordBenchmarkResult: () => controllerState.keywordBenchmarkResult,
    readKeywordExpandCancelRequested: () => controllerState.keywordExpandCancelRequested,
    readKeywordExpandInFlight: () => controllerState.keywordExpandInFlight,
    readKeywordOpportunityErrorMessage: () => controllerState.keywordOpportunityErrorMessage,
    readKeywordOpportunityInFlight: () => controllerState.keywordOpportunityInFlight,
    readKeywordOpportunityResult: () => controllerState.keywordOpportunityResult,
    readKeywordPlanState: () => controllerState.keywordPlanState,
    readKeywordSortDimension: () => controllerState.keywordSortDimension,
    readLastRuntimePageTypeForKeywordSort: () => controllerState.lastRuntimePageTypeForKeywordSort,
    readLastRuntimePageUrlForKeywordSort: () => controllerState.lastRuntimePageUrlForKeywordSort,
    replaceBatchDraftByPlatform: value => (controllerState.batchDraftByPlatform = value),
    replaceExpandedKeywordsBuffer: value => (controllerState.expandedKeywordsBuffer = value),
    replaceKeywordSortDimension: value => (controllerState.keywordSortDimension = value),
    replaceLastRuntimePageTypeForKeywordSort: value => (controllerState.lastRuntimePageTypeForKeywordSort = value),
    replaceLastRuntimePageUrlForKeywordSort: value => (controllerState.lastRuntimePageUrlForKeywordSort = value),
    shutdownCaptureTaskOwner,
    readActiveRecoveryProgress: () => controllerState.activeRecoveryProgress,
    readDetailBatchCaptureInFlight: () => controllerState.detailBatchCaptureInFlight,
    readBatchUrlCaptureInFlight: () => controllerState.batchUrlCaptureInFlight,
    readTargetedPostRunState: () => controllerState.targetedPostRunState,
    readBatchKeywordCaptureInFlight: () => controllerState.batchKeywordCaptureInFlight,
    readActiveBatchRunnerTabId: () => controllerState.activeBatchRunnerTabId,
    readMonitorRunInFlight: () => controllerState.monitorRunInFlight,
    readActiveUnattendedRunRequestId: () => controllerState.activeUnattendedRunRequestId,
  });
}
