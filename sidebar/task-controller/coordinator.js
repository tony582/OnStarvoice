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

// Own task state once per Sidebar. These 8 named compatibility reads preserve
// original values (including object identity); they are not deep immutable DTOs.
export function createSidebarTaskController(controllerPorts, controllerBindings = Object.freeze({})) {
  const controllerState = {
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
  Object.assign(controllerOperations, createTaskLedgerAssistController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createOwnerController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createUnattendedControlController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createProgressProjectionController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createManualCaptureController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createCancelAndStreamingQueueController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createBatchKeywordController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createUnattendedReportingAndClosureController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createExecutionLockController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createTargetedController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createUnattendedRunController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createCaptureActionCancelController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createMonitorExecutionController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createDetailSyncController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createRecordRetryController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createRecoveryController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createProgressController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  Object.assign(controllerOperations, createUrlBatchController({controllerState, controllerBindings, controllerPorts, controllerOperations}));
  function shutdownCaptureTaskOwner() {
    controllerState.captureTaskOwnerClosing = true;
    controllerState.captureTaskOwnerPort?.disconnect?.();
    controllerState.captureTaskOwnerPort = null;
  }
  return Object.freeze({
    ...controllerOperations,
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
