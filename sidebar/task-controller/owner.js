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
    postCaptureTaskOwnerMessage,
    bindCaptureTaskOwner,
    releaseCaptureTaskOwner,
    applyCaptureTaskCancellation,
    syncCaptureTaskOwnerFromRuntime,
    connectCaptureTaskOwnerPort,
  });
}
