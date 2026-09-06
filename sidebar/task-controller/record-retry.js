// L3-A record-retry: original control flow, explicit state and compatibility ports.
export function createRecordRetryController({controllerState, controllerPorts, controllerOperations}) {
  const {
    ACTIVE_COMMENT_PROGRESS_PHASES,
    ERROR_MESSAGE_MAP,
    buildDetailCaptureFailureSummaryText,
    confirm,
    console,
    getAuthRequiredMessage,
    getBatchRetryDetailRecordIds,
    getCaptureSettings,
    getCurrentAuth,
    getCurrentRuntime,
    hideProgress,
    isAuthVerified,
    loadStorageModule,
    readCommentsMaxDetectedItemsFromInput,
    refreshDataPool,
    repairInterruptedCommentPayload,
    retryCommentsForRecord,
    showMessage,
    showProgress,
  } = controllerPorts;
  const acquireCaptureExecutionLock = (...args) => controllerOperations.acquireCaptureExecutionLock(...args);
  const beginSidebarTask = (...args) => controllerOperations.beginSidebarTask(...args);
  const finishSidebarTask = (...args) => controllerOperations.finishSidebarTask(...args);
  const handleCancel = (...args) => controllerOperations.handleCancel(...args);
  const handleProgress = (...args) => controllerOperations.handleProgress(...args);
  const releaseCaptureExecutionLock = (...args) => controllerOperations.releaseCaptureExecutionLock(...args);
  const runDetailCaptureForRecordIds = (...args) => controllerOperations.runDetailCaptureForRecordIds(...args);
  const updateActiveCommentCaptureIdentity = (...args) => controllerOperations.updateActiveCommentCaptureIdentity(...args);

  async function repairStaleCommentCaptureCard(recordId) {
    const {getRecord, updateRecord} = await loadStorageModule();
    const record = await getRecord(recordId);
    if (!record) return false;
    const payload =
      record.payload && typeof record.payload === "object" ? record.payload : {};
    let nextPayload = payload;
    let changed = false;

    if (record.type === "single_note") {
      const repaired = repairInterruptedCommentPayload(payload);
      nextPayload = repaired.payload;
      changed = repaired.changed;
    } else if (
      payload.detailPayload &&
      typeof payload.detailPayload === "object"
    ) {
      const repaired = repairInterruptedCommentPayload(payload.detailPayload);
      if (repaired.changed) {
        nextPayload = {...payload, detailPayload: repaired.payload};
        changed = true;
      }
    }

    if (changed) {
      await updateRecord(recordId, {payload: nextPayload});
      await refreshDataPool();
    }
    return changed;
  }

  async function handleStopCommentsCapture(recordId) {
    const runtimeProgress = getCurrentRuntime()?.lastCaptureProgress || {};
    const runtimePhase = String(runtimeProgress?.phase || "")
      .trim()
      .toLowerCase();
    const runtimeIsCommentCapture =
      runtimePhase.startsWith("comments_") ||
      runtimePhase === "detail_comments_capturing" ||
      String(runtimeProgress?.captureAction || "") === "captureComments";
    const runtimeRecordId = String(runtimeProgress?.recordId || "").trim();
    const runtimeAction = String(runtimeProgress?.captureAction || "").trim();
    const runtimeMatches =
      runtimeRecordId === recordId &&
      ACTIVE_COMMENT_PROGRESS_PHASES.has(runtimePhase) &&
      runtimeIsCommentCapture;
    const runtimeExplicitlyConflicts = Boolean(
      runtimePhase &&
        ((runtimeRecordId && runtimeRecordId !== recordId) ||
          (runtimeAction && runtimeAction !== "captureComments")),
    );
    const localMatches =
      controllerState.activeCommentsCaptureRecordId === recordId &&
      !runtimeExplicitlyConflicts;

    if (!runtimeMatches && !localMatches) {
      await repairStaleCommentCaptureCard(recordId).catch((error) => {
        console.warn("[Sidebar] Repair stale comment card failed:", error);
      });
      showMessage(
        "这条记录的运行状态已经过期，已转为可继续状态；当前其他任务不会被取消",
        "warning",
      );
      return;
    }

    if (runtimeMatches) {
      updateActiveCommentCaptureIdentity(runtimeProgress);
    }
    await handleCancel();
  }

  async function handleRetryCommentsCapture(recordId) {
    const settings = await getCaptureSettings();
    const commentsMaxDetectedItems = readCommentsMaxDetectedItemsFromInput(
      settings.commentsMaxDetectedItems,
    );

    const executionLock = await acquireCaptureExecutionLock({
      owner: "manual_comments_retry",
      label: "评论采集",
    });
    if (!executionLock) {
      return false;
    }

    const taskContext = beginSidebarTask({
      taskType: "capture",
      featureKey: "capture.comments",
      metadata: {
        recordId,
        commentsMaxDetectedItems,
        retry: true,
      },
    });
    let taskStatus = "completed";
    let taskError = null;

    showProgress("正在打开对应作品并继续评论采集...", false);
    controllerState.activeCommentsCaptureRecordId = recordId;

    try {
      const result = await retryCommentsForRecord(recordId, {
        commentsMaxDetectedItems,
        onProgress: handleProgress,
      });

      if (result.ok) {
        if (result.phase === "comments_partial") {
          taskStatus = "partial";
          showMessage(
            result.stoppedByNetwork
              ? "网络中断超过 2 分钟，已保留当前评论；联网后可继续当前项"
              : result.stoppedByStall
                ? "检测到页面卡顿，已保留当前评论；可继续当前项"
              : "评论采集已手动停止并合并",
            "warning",
          );
        } else {
          showMessage("评论采集已完成并合并", "success");
        }
      } else {
        const errorMsg =
          ERROR_MESSAGE_MAP[result.error?.code] ||
          result.error?.message ||
          "评论采集失败";
        showMessage(errorMsg, "error");
        taskStatus = "failed";
      }

      await refreshDataPool();
    } catch (error) {
      console.error("[Sidebar] Retry comments failed:", error);
      taskStatus = "failed";
      taskError = error;
      showMessage("重试评论失败: " + error.message, "error");
    } finally {
      controllerState.activeCommentsCaptureRecordId = "";
      controllerState.activeCommentsCaptureTabId = null;
      controllerState.activeCommentsCaptureRequestId = "";
      finishSidebarTask(taskContext, {
        status: taskStatus,
        error: taskError,
        metadata: {
          recordId,
          retry: true,
        },
      });
      hideProgress();
      await releaseCaptureExecutionLock(executionLock.id);
    }
    return true;
  }

  async function handleRetryDetailCapture(recordId) {
    if (controllerState.detailBatchCaptureInFlight) {
      showMessage("采集增强任务进行中，请稍候...", "info");
      return;
    }

    const auth = getCurrentAuth() || {};
    if (!isAuthVerified(auth)) {
      showMessage(getAuthRequiredMessage(), "warning");
      return;
    }

    const settings = await getCaptureSettings();
    const batchRetryRecordIds = getBatchRetryDetailRecordIds(recordId);
    const shouldOfferBatchRetry = batchRetryRecordIds.length > 1;
    const targetRecordIds =
      shouldOfferBatchRetry &&
      confirm(
        `检测到当前页面还有 ${batchRetryRecordIds.length - 1} 条未完成采集增强，是否改为批量重试这 ${batchRetryRecordIds.length} 条？`,
      )
        ? batchRetryRecordIds
        : [recordId];
    const isBatchRetry = targetRecordIds.length > 1;
    const taskContext = beginSidebarTask({
      taskType: "capture",
      featureKey: "capture.enhancement",
      metadata: {
        recordId,
        targetCount: targetRecordIds.length,
        retry: true,
      },
    });
    let taskStatus = "completed";
    let taskError = null;

    try {
      const result = await runDetailCaptureForRecordIds(
        targetRecordIds,
        settings,
        {
          progressMessage: isBatchRetry
            ? `正在批量重试采集增强（0/${targetRecordIds.length}）...`
            : "正在重试采集增强（0/1）...",
        },
      );

      if (result.canceled) {
        taskStatus = "partial";
        const filterMsg =
          result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
        const failureSummary = buildDetailCaptureFailureSummaryText(result);
        showMessage(
          `采集增强已中止：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
          "warning",
        );
      } else if (result.ok) {
        const filterMsg =
          result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
        showMessage(
          `采集增强完成：成功 ${result.successCount} 条${filterMsg}`,
          "success",
        );
      } else {
        const filterMsg =
          result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
        const failureSummary = buildDetailCaptureFailureSummaryText(result);
        taskStatus = "completed_with_failures";
        showMessage(
          `采集增强完成：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
          "warning",
        );
      }
    } catch (error) {
      console.error("[Sidebar] Retry detail capture failed:", error);
      taskStatus = "failed";
      taskError = error;
      showMessage("采集增强失败: " + error.message, "error");
    } finally {
      finishSidebarTask(taskContext, {
        status: taskStatus,
        error: taskError,
        metadata: {
          recordId,
          targetCount: targetRecordIds.length,
          retry: true,
        },
      });
      hideProgress();
    }
  }

  return Object.freeze({
    repairStaleCommentCaptureCard,
    handleStopCommentsCapture,
    handleRetryCommentsCapture,
    handleRetryDetailCapture,
  });
}
