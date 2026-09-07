import {createPageOperationClient} from '../../utils/capture/page-operation-client.js';
import {createCaptureSyncScope} from '../../utils/capture-sync.js';
import {createTaskLedgerAssistController} from './task-ledger-assist.js';
import {createBatchKeywordController} from './batch-keyword.js';
import {createDetailSyncController} from './detail-sync.js';
import {createCancelAndStreamingQueueController} from './cancel-and-streaming-queue.js';
import {createMonitorExecutionController} from './monitor-execution.js';
import {createProgressController} from './progress.js';
import {createExecutionLockController} from './execution-lock.js';
import {createUnattendedReportingAndClosureController} from './unattended-reporting-and-closure.js';
import {createKeywordStrategyController} from './keyword-strategy.js';
import {createKeywordSortController} from './keyword-sort.js';
import {createTargetedController} from './targeted.js';
import {createUnattendedRunController} from './unattended-run.js';

// L3-A owner: original control flow, explicit state and compatibility ports.
export function createOwnerController({controllerState, controllerPorts, controllerOperations}) {
  const {
    CAPTURE_TASK_OWNER_PORT_NAME,
    chrome,
    console,
    getCurrentRuntime,
    setCancelFlag,
    setTimeout,
    showMessage,
  } = controllerPorts;
  const requestDetailRunnerCancelSignals = (...args) => controllerOperations.requestDetailRunnerCancelSignals(...args);
  let strictOwner = null;

  function strictError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function createStrictProducerScope(client, continuation = null) {
    const captureSync = createCaptureSyncScope({
      chromeApi: client.chromeApi, pageOperations: client,
    });
    const operations = Object.create(controllerOperations);
    const persistencePorts = Object.create(null);
    for (const name of [
      'flushUnattendedCheckpointReportOutbox', 'enqueueUnattendedCheckpointReport',
      'discardUnattendedCheckpointReports', 'ensureControlStorageReserve',
      'releaseControlStorageReserve',
    ]) {
      const callback = controllerPorts[name];
      if (typeof callback !== 'function') continue;
      persistencePorts[name] = (...args) => {
        // Existing background flushes can be intentionally fire-and-forget.
        // Track their real persistence work without changing call count/order,
        // synchronous values, or allowing stop to truncate an admitted save.
        const result = callback(...args);
        return result?.then ? client.track(result) : result;
      };
    }
    const ports = Object.freeze({
      ...controllerPorts, ...captureSync, ...persistencePorts,
      chrome: client.chromeApi,
      strictCaptureClient: client,
      strictCaptureScopeMode: 'cooperative',
      strictCaptureContinuation: continuation,
      syncKeywordSortDimensionFromPage: (...args) => operations.syncKeywordSortDimensionFromPage(...args),
    });
    // These factories only compose existing functions against the SAME state.
    // They create no second UI listener, task state, runner or queue here.
    for (const factory of [
      createTaskLedgerAssistController, createKeywordSortController, createBatchKeywordController,
      createDetailSyncController, createCancelAndStreamingQueueController,
      createMonitorExecutionController, createProgressController,
      createExecutionLockController, createUnattendedReportingAndClosureController,
      createKeywordStrategyController, createTargetedController,
      createUnattendedRunController,
    ]) {
      Object.assign(operations, factory({
        controllerState, controllerPorts: ports, controllerOperations: operations,
      }));
    }
    // Release is owned by the outer producer's real finally, never by a nested
    // task helper which still has a save/checkpoint or worker Promise in flight.
    operations.bindCaptureTaskOwner = () => undefined;
    operations.releaseCaptureTaskOwner = () => undefined;
    return Object.freeze({ports, operations, captureSync, client});
  }

  async function settleStrictCaptureOwner(owner) {
    if (owner.settling) return owner.settling;
    owner.settling = (async () => {
      const receipt = await owner.client.drain();
      const response = await chrome.runtime.sendMessage({
        type: 'onstarvoice:strict-owner-settled',
        strictControl: owner.client.strictControl,
        ...receipt,
        pendingUploads: null,
      });
      if (response?.ok !== true) throw strictError(
        response?.error?.code || 'strict_owner_settlement_unconfirmed',
      );
      return {...receipt, response};
    })();
    try { return await owner.settling; }
    finally { owner.settling = null; }
  }

  async function bindStrictCaptureOwner(request = {}, continuation = null) {
    if (request.strictControlCandidate !== true) {
      throw strictError('strict_capture_candidate_required');
    }
    const requestId = String(request.id || '').trim();
    const attemptId = String(request.attemptId || '').trim();
    if (!requestId || !attemptId || strictOwner) {
      throw strictError(strictOwner ? 'strict_owner_already_bound' : 'strict_owner_identity_required');
    }
    const port = chrome.runtime.connect({name: 'onstarvoice:strict-capture-owner-v1'});
    const owner = {port, client: null, scope: null, disconnected: false, settling: null, pendingStop: null};
    // Reserve locally before waiting for admission. A concurrent producer cannot
    // obtain a second owner while the first bind is awaiting its exact source.
    strictOwner = owner;
    port.onMessage.addListener((message) => {
      if (message?.type !== 'capture-owner:strict-stop') return;
      if (!owner.client) { owner.pendingStop = message; return; }
      if (!owner.client.stop(message.strictControl, message.reason)) return;
      void settleStrictCaptureOwner(owner).catch((error) => {
        console.warn('[Sidebar] Strict owner drain remains unconfirmed:', error);
      });
    });
    port.onDisconnect.addListener(() => {
      owner.disconnected = true;
      owner.client?.markDisconnected();
      // Reconnection is not adoption. Never bind this generation on a new port
      // or replay a legacy bind after losing the original connection.
    });
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'onstarvoice:strict-owner-bind', requestId, attemptId,
      });
      if (response?.ok !== true || owner.disconnected) {
        throw strictError(response?.error?.code || 'strict_owner_bind_unconfirmed');
      }
      const strictControl = response.data?.strictControl || response.strictControl;
      if ((response.data?.scopeMode || response.scopeMode) !== 'cooperative') {
        throw strictError('strict_cooperative_scope_confirmation_required');
      }
      if (strictControl?.requestId !== requestId || strictControl?.attemptId !== attemptId) {
        throw strictError('strict_owner_bind_identity_mismatch');
      }
      owner.client = createPageOperationClient({
        strictControl, chromeApi: chrome,
        relayType: controllerPorts.MESSAGE_TYPE?.RELAY_TO_CONTENT,
      });
      owner.scope = createStrictProducerScope(owner.client, continuation);
      if (owner.pendingStop) {
        owner.client.stop(owner.pendingStop.strictControl, owner.pendingStop.reason);
      }
      return owner;
    } catch (error) {
      // The remote journal may exist after a lost response. Preserve the local
      // disconnected reservation; no fallback collection is permitted.
      owner.disconnected = true;
      port.disconnect?.();
      throw error;
    }
  }

  async function runStrictCaptureProducer(request, producer, kind = 'capture-producer', continuation = null) {
    if (typeof producer !== 'function') throw strictError('strict_producer_required');
    const owner = await bindStrictCaptureOwner(request, continuation);
    try {
      return await owner.client.runProducer(kind, () => producer(owner.scope));
    } finally {
      const receipt = await settleStrictCaptureOwner(owner);
      if (receipt.runnerQuiesced) {
        const response = await chrome.runtime.sendMessage({
          type: 'onstarvoice:strict-owner-release',
          strictControl: owner.client.strictControl,
          runnerQuiesced: receipt.runnerQuiesced,
          pendingUploads: null,
          retainedTabs: receipt.retainedTabs,
        });
        if (response?.ok === true && strictOwner === owner) {
          strictOwner = null;
          owner.port.disconnect?.();
        }
      }
    }
  }

  function postCaptureTaskOwnerMessage(message) {
    if (!controllerState.captureTaskOwnerPort) return false;
    try {
      controllerState.captureTaskOwnerPort.postMessage(message);
      return true;
    } catch (error) {
      console.warn("[Sidebar] Capture task owner message failed:", error);
      return false;
    }
  }

  function bindCaptureTaskOwner(taskId) {
    if (strictOwner) return;
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedTaskId) return;
    controllerState.captureTaskOwnerTaskId = normalizedTaskId;
    if (!controllerState.captureTaskOwnerPort && !controllerState.captureTaskOwnerClosing) {
      connectCaptureTaskOwnerPort();
    }
    postCaptureTaskOwnerMessage({
      type: "capture-owner:bind",
      taskId: normalizedTaskId,
    });
  }

  function releaseCaptureTaskOwner(taskId) {
    if (strictOwner) return;
    const normalizedTaskId = String(taskId || controllerState.captureTaskOwnerTaskId || "").trim();
    if (!normalizedTaskId) return;
    postCaptureTaskOwnerMessage({
      type: "capture-owner:unbind",
      taskId: normalizedTaskId,
    });
    if (controllerState.captureTaskOwnerTaskId === normalizedTaskId) {
      controllerState.captureTaskOwnerTaskId = "";
    }
  }

  function applyCaptureTaskCancellation(cancellation = {}) {
    // A task-id-only legacy signal cannot mutate strict cancellation flags or
    // cancel workers belonging to the current or any successor generation.
    if (strictOwner) return;
    const taskId = String(cancellation?.taskId || "").trim();
    if (!taskId || taskId !== controllerState.captureTaskOwnerTaskId) return;
    const cancellationKey = `${taskId}:${String(
      cancellation?.requestedAt || cancellation?.reason || "canceled",
    )}`;
    if (cancellationKey === controllerState.lastCaptureTaskCancellationKey) return;
    controllerState.lastCaptureTaskCancellationKey = cancellationKey;
    controllerState.activeCaptureTaskCancellationReason = String(
      cancellation?.reason || "capture_task_canceled",
    ).trim();

    setCancelFlag(true);
    controllerState.searchCaptureCancelRequested = true;
    controllerState.batchKeywordCancelRequested = true;
    controllerState.detailBatchCancelRequested = true;
    controllerState.batchUrlCancelRequested = true;
    controllerState.monitorRunCancelRequested = true;
    const taskWorkerTabIds = Array.isArray(
      getCurrentRuntime()?.captureDebugSession?.workerTabIds,
    )
      ? getCurrentRuntime().captureDebugSession.workerTabIds
      : [];
    const fallbackTabId =
      (Number.isSafeInteger(Number(controllerState.activeBatchRunnerTabId)) &&
        Number(controllerState.activeBatchRunnerTabId)) ||
      null;
    requestDetailRunnerCancelSignals({
      extraTabIds: taskWorkerTabIds,
      fallbackTabId,
    }).catch((error) => {
      console.warn("[Sidebar] Relay native Debug cancellation failed:", error);
    });
    showMessage(
      cancellation?.reason === "sidebar_owner_disconnected"
        ? "控制面板已关闭，采集任务已安全停止"
        : "采集任务已取消，整项采集正在停止",
      "warning",
    );
  }

  function syncCaptureTaskOwnerFromRuntime(runtime = {}) {
    const cancellation = runtime?.captureTaskCancellation;
    if (cancellation && typeof cancellation === "object") {
      applyCaptureTaskCancellation(cancellation);
    }
  }

  function connectCaptureTaskOwnerPort() {
    if (strictOwner) return;
    if (controllerState.captureTaskOwnerClosing || controllerState.captureTaskOwnerPort) return;
    let port;
    try {
      port = chrome.runtime.connect({name: CAPTURE_TASK_OWNER_PORT_NAME});
    } catch (error) {
      console.warn("[Sidebar] Capture task owner port unavailable:", error);
      return;
    }
    controllerState.captureTaskOwnerPort = port;
    port.onMessage.addListener((message) => {
      if (message?.type !== "capture-owner:canceled") return;
      applyCaptureTaskCancellation({
        ...(message?.payload && typeof message.payload === "object"
          ? message.payload
          : {}),
        ...message,
      });
    });
    port.onDisconnect.addListener(() => {
      if (controllerState.captureTaskOwnerPort === port) {
        controllerState.captureTaskOwnerPort = null;
      }
      if (!controllerState.captureTaskOwnerClosing) {
        setTimeout(() => {
          if (controllerState.captureTaskOwnerClosing || controllerState.captureTaskOwnerPort) return;
          connectCaptureTaskOwnerPort();
          if (controllerState.captureTaskOwnerTaskId) {
            bindCaptureTaskOwner(controllerState.captureTaskOwnerTaskId);
          }
        }, 150);
      }
    });
    if (controllerState.captureTaskOwnerTaskId) {
      postCaptureTaskOwnerMessage({
        type: "capture-owner:bind",
        taskId: controllerState.captureTaskOwnerTaskId,
      });
    }
  }

  return Object.freeze({
    bindStrictCaptureOwner,
    runStrictCaptureProducer,
    getStrictCaptureOwnerControl: () => strictOwner?.client?.strictControl || null,
    isStrictCaptureOwnerStopped: () => Boolean(strictOwner?.client?.shouldStop()),
    postCaptureTaskOwnerMessage,
    bindCaptureTaskOwner,
    releaseCaptureTaskOwner,
    applyCaptureTaskCancellation,
    syncCaptureTaskOwnerFromRuntime,
    connectCaptureTaskOwnerPort,
  });
}
