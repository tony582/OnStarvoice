// L3-A unattended-control: original control flow, explicit state and compatibility ports.
export function createUnattendedControlController({controllerState, controllerPorts, controllerOperations}) {
  const {
    buildKeywordRunDisplayPlan,
    chrome,
    console,
    taskView,
    isExplicitUserUnattendedCancellationMessage,
    loadActiveKeywordRunState,
    loadKeywordPlanUI,
    setCancelFlag,
    showMessage,
  } = controllerPorts;
  const getUnattendedRunRequestIdFromUrl = (...args) => controllerOperations.getUnattendedRunRequestIdFromUrl(...args);

  async function cancelUnattendedKeywordPlanFromSidebar(requestId = "") {
    const displayPlan = buildKeywordRunDisplayPlan(controllerState.keywordPlanState);
    const progress =
      displayPlan?.lastRunProgress &&
      typeof displayPlan.lastRunProgress === "object"
        ? displayPlan.lastRunProgress
        : {};
    const exactRequestId = String(
      requestId ||
        progress.unattendedRequestId ||
        displayPlan?.lastRunRequestId ||
        controllerState.activeKeywordRunState?.id ||
        "",
    ).trim();
    const runnerTabId = Number(progress.runnerTabId);
    const presentation = taskView.beginUnattendedCancelPresentation();

    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:cancel-unattended-keyword-run",
        requestId: exactRequestId,
        message: "用户手动中止当前采集任务",
        tabId: Number.isFinite(runnerTabId) && runnerTabId > 0 ? runnerTabId : null,
      });
      if (!response?.ok) {
        throw new Error(response?.error?.message || "中止无人值守任务失败");
      }
      controllerState.activeCaptureTaskCancellationReason = "unattended_cancel_requested";
      controllerState.activeKeywordRunState = response?.data?.request || controllerState.activeKeywordRunState;
      await Promise.all([
        loadKeywordPlanUI({preserveInputs: true}),
        loadActiveKeywordRunState(),
      ]);
      showMessage("正在中止当前采集任务...", "warning");
    } catch (error) {
      console.warn("[Sidebar] Cancel active keyword run failed:", error);
      showMessage("中止当前采集任务失败: " + error.message, "error");
    } finally {
      presentation.finish();
    }
  }

  function handleUnattendedRunRequestStorageChange(request) {
    const requestId = getUnattendedRunRequestIdFromUrl();
    if (!requestId || !request || request.id !== requestId) {
      return;
    }
    const requestAttemptId = String(request?.attemptId || "").trim();
    if (
      controllerState.activeUnattendedRunRequestId &&
      (String(request.id || "").trim() !== controllerState.activeUnattendedRunRequestId ||
        !requestAttemptId ||
        requestAttemptId !== controllerState.activeUnattendedRunAttemptId)
    ) {
      return;
    }
    if (String(request.status || "") !== "canceled") {
      return;
    }

    controllerState.pendingUnattendedCancellationRequestId = String(request.id || "").trim();
    controllerState.pendingUnattendedCancellationAttemptId = requestAttemptId;
    controllerState.activeCaptureTaskCancellationReason =
      isExplicitUserUnattendedCancellationMessage(request.message)
        ? "unattended_cancel_requested"
        : "unattended_request_canceled_without_user_action";
    setCancelFlag(true);
    controllerState.batchKeywordCancelRequested = true;
    controllerState.detailBatchCancelRequested = true;
    controllerState.searchCaptureCancelRequested = true;
    // background 在状态切换前已捕获旧 lock holder 并精确转发取消。这里仅停止
    // 本地编排；若再发送无 captureRequestId 的全页取消，迟到消息可能误伤新 attempt。
  }

  return Object.freeze({
    cancelUnattendedKeywordPlanFromSidebar,
    handleUnattendedRunRequestStorageChange,
  });
}
