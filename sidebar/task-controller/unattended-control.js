// L3-A unattended-control: original control flow, explicit state and compatibility ports.
export function createUnattendedControlController({controllerState, controllerBindings, controllerPorts, controllerOperations}) {
  const {
    buildKeywordRunDisplayPlan,
    chrome,
    console,
    document,
    isExplicitUserUnattendedCancellationMessage,
    loadActiveKeywordRunState,
    loadKeywordPlanUI,
    setCancelFlag,
    showMessage,
  } = controllerPorts;
  const getUnattendedRunRequestIdFromUrl = (...args) => controllerOperations.getUnattendedRunRequestIdFromUrl(...args);

  async function cancelUnattendedKeywordPlanFromSidebar(requestId = "") {
    const displayPlan = buildKeywordRunDisplayPlan(controllerBindings.keywordPlanState);
    const progress =
      displayPlan?.lastRunProgress &&
      typeof displayPlan.lastRunProgress === "object"
        ? displayPlan.lastRunProgress
        : {};
    const exactRequestId = String(
      requestId ||
        progress.unattendedRequestId ||
        displayPlan?.lastRunRequestId ||
        controllerBindings.activeKeywordRunState?.id ||
        "",
    ).trim();
    const runnerTabId = Number(progress.runnerTabId);
    const progressText = document.getElementById("progressText");
    const btnCancel = document.getElementById("btnCancel");
    if (progressText) {
      progressText.textContent = "正在中止当前采集任务...";
    }
    if (btnCancel) {
      btnCancel.textContent = "停止中...";
      btnCancel.disabled = true;
    }

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
      controllerBindings.activeKeywordRunState = response?.data?.request || controllerBindings.activeKeywordRunState;
      await Promise.all([
        loadKeywordPlanUI({preserveInputs: true}),
        loadActiveKeywordRunState(),
      ]);
      showMessage("正在中止当前采集任务...", "warning");
    } catch (error) {
      console.warn("[Sidebar] Cancel active keyword run failed:", error);
      showMessage("中止当前采集任务失败: " + error.message, "error");
    } finally {
      if (btnCancel) {
        btnCancel.disabled = false;
        btnCancel.textContent = "中止任务";
      }
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
