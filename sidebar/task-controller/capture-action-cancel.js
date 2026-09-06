// L3-A capture-action-cancel: original control flow, explicit state and compatibility ports.
export function createCaptureActionCancelController({controllerState, controllerPorts, controllerOperations}) {
  const {
    captureAndSync,
    chrome,
    console,
    taskView,
    getCurrentRuntime,
    hideProgress,
    hideProgressPanelOnly,
    refreshDataPool,
    setCancelFlag,
    showProgress,
  } = controllerPorts;
  const cancelUnattendedKeywordPlanFromSidebar = (...args) => controllerOperations.cancelUnattendedKeywordPlanFromSidebar(...args);
  const finalizeInterruptedDetailCaptureAfterCancel = (...args) => controllerOperations.finalizeInterruptedDetailCaptureAfterCancel(...args);
  const handleProgress = (...args) => controllerOperations.handleProgress(...args);
  const renderCaptureRecoveryUI = (...args) => controllerOperations.renderCaptureRecoveryUI(...args);
  const requestCaptureCancelSignal = (...args) => controllerOperations.requestCaptureCancelSignal(...args);
  const resetCaptureRecoveryUI = (...args) => controllerOperations.resetCaptureRecoveryUI(...args);

  async function runCaptureAction({
    mode,
    progressMessage,
    successMessage,
    captureParams = {},
    keepProgressOpen = false,
  }) {
    showProgress(progressMessage);

    try {
      const result = await captureAndSync({
        mode,
        onProgress: handleProgress,
        autoSync: false,
        captureParams,
      });

      if (result.ok) {
        const savedCount = Array.isArray(result.recordIds)
          ? result.recordIds.length
          : result.recordId
            ? 1
            : 0;
        if (savedCount === 0) {
          taskView.showEmptyCaptureResult(result);
        } else {
          taskView.showCaptureSuccess(successMessage);
        }
        await refreshDataPool();
        return {
          ok: true,
          result,
          savedCount,
          recordIds: Array.isArray(result.recordIds) ? result.recordIds : [],
        };
      } else {
        taskView.showCaptureActionError(result);
        return {
          ok: false,
          result,
          savedCount: 0,
        };
      }
    } catch (error) {
      console.error("[Sidebar] Capture action failed:", error);
      taskView.showCaptureActionException(error);
      return {
        ok: false,
        result: null,
        savedCount: 0,
        error,
      };
    } finally {
      if (!keepProgressOpen) {
        hideProgress();
      }
    }
  }

  async function handleCancel() {
    console.log("[Sidebar] Cancel clicked");
    const presentation = taskView.openCaptureProgressPresentation();
    if (presentation.isKeywordPlanPresentation()) {
      await cancelUnattendedKeywordPlanFromSidebar();
      return;
    }
    const isRecoveryCancel =
      presentation.isRecoveryPresentation() &&
      presentation.isRecoveryCancelable();
    const recoveryRequestId = isRecoveryCancel
      ? String(
          controllerState.activeRecoveryProgress?.captureRequestId ||
            presentation.readRecoveryRequestId() ||
            "",
        ).trim()
      : "";
    const cancelRequestId =
      recoveryRequestId ||
      (controllerState.activeCommentsCaptureRecordId
        ? String(controllerState.activeCommentsCaptureRequestId || "").trim()
        : "");
    const isRequestScopedCommentCancel = Boolean(
      !isRecoveryCancel &&
        cancelRequestId &&
        controllerState.activeCommentsCaptureRecordId,
    );
    const shouldShowCancelingProgress =
      isRecoveryCancel || isRequestScopedCommentCancel;
    const recoverySnapshot = isRecoveryCancel
      ? {...controllerState.activeRecoveryProgress}
      : isRequestScopedCommentCancel
        ? {
            phase: "comments_capturing",
            recordId: controllerState.activeCommentsCaptureRecordId,
            runnerTabId: controllerState.activeCommentsCaptureTabId,
            captureRequestId: cancelRequestId,
            captureAction: "captureComments",
          }
        : null;
    const captureTaskSession = getCurrentRuntime()?.captureDebugSession;
    setCancelFlag(true);
    controllerState.searchCaptureCancelRequested = true;
    if (shouldShowCancelingProgress) {
      renderCaptureRecoveryUI({
        ...recoverySnapshot,
        phase: "capture_canceling",
        message: taskView.readCaptureCancelingMessage(),
        updatedAt: Date.now(),
      });
    } else {
      hideProgressPanelOnly();
    }
    let relayTabId = isRecoveryCancel ? controllerState.activeRecoveryRunnerTabId : null;
    let shouldFinalizeDetailCapture = false;
    if (controllerState.detailBatchCaptureInFlight) {
      controllerState.detailBatchCancelRequested = true;
      shouldFinalizeDetailCapture = true;
      if (Number.isFinite(Number(controllerState.detailBatchRunnerTabId))) {
        relayTabId = Number(controllerState.detailBatchRunnerTabId);
      }
    }
    if (controllerState.batchUrlCaptureInFlight) {
      controllerState.batchUrlCancelRequested = true;
      relayTabId = relayTabId || controllerState.activeBatchRunnerTabId;
    }
    if (controllerState.batchKeywordCaptureInFlight) {
      controllerState.batchKeywordCancelRequested = true;
      relayTabId = relayTabId || controllerState.activeBatchRunnerTabId;
    }
    if (controllerState.monitorRunInFlight) {
      controllerState.monitorRunCancelRequested = true;
      relayTabId = relayTabId || controllerState.activeBatchRunnerTabId;
    }
    if (
      controllerState.activeCommentsCaptureRecordId &&
      Number.isFinite(Number(controllerState.activeCommentsCaptureTabId))
    ) {
      relayTabId = relayTabId || Number(controllerState.activeCommentsCaptureTabId);
    }

    if (!relayTabId) {
      const taskWorkerTabIds = Array.isArray(captureTaskSession?.workerTabIds)
        ? captureTaskSession.workerTabIds
        : [];
      relayTabId = Number(
        taskWorkerTabIds[taskWorkerTabIds.length - 1] ??
          captureTaskSession?.sourceTabId ??
          captureTaskSession?.tabId,
      );
      if (!Number.isSafeInteger(relayTabId) || relayTabId <= 0) {
        relayTabId = null;
      }
    }

    try {
      if (relayTabId) {
        await requestCaptureCancelSignal(relayTabId, cancelRequestId);
      } else {
        await requestCaptureCancelSignal(null, cancelRequestId);
      }
    } catch (error) {
      console.warn("[Sidebar] Cancel relay failed:", error);
      if (shouldShowCancelingProgress) {
        if (isRecoveryCancel) {
          renderCaptureRecoveryUI({
            ...recoverySnapshot,
            updatedAt: Date.now(),
          });
        } else {
          resetCaptureRecoveryUI({hidePanel: true, clearState: true});
        }
        taskView.showCaptureCancelSignalFailure();
      }
    }

    const captureTaskId = String(captureTaskSession?.taskId || "").trim();
    if (captureTaskSession?.persistent && captureTaskId) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "onstarvoice:end-capture-task",
          taskId: captureTaskId,
          reason: "user_cancel_requested",
          status: "canceled",
        });
        if (response?.ok === false) {
          throw new Error(response?.error?.message || "停止采集辅助失败");
        }
      } catch (error) {
        console.warn("[Sidebar] Persistent capture task stop failed:", error);
        taskView.showPersistentCaptureReleaseWarning();
      }
    }

    if (shouldFinalizeDetailCapture) {
      await finalizeInterruptedDetailCaptureAfterCancel();
    } else if (!shouldShowCancelingProgress) {
      taskView.showCaptureCancelPending();
    }
  }

  return Object.freeze({
    runCaptureAction,
    handleCancel,
  });
}
