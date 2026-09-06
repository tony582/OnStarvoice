// L3-A progress: original control flow, explicit state and compatibility ports.
export function createProgressController({controllerState, controllerPorts, controllerOperations}) {
  const {
    ACTIVE_COMMENT_PROGRESS_PHASES,
    COMMENT_PHASE_TO_TERMINAL_STATUS,
    MESSAGE_TYPE,
    UNATTENDED_CONTENT_PROGRESS_MIN_INTERVAL_MS,
    chrome,
    console,
    taskView,
    getActiveTaskContext,
    hideProgressPanelOnly,
    isTerminalProgressPhase,
    isUnattendedTerminalProgressPhase,
    isUnsupportedPlatformCoverVisible,
    loadStorageModule,
    refreshDataPool,
    setBatchProgressDetail,
    updateCaptureTaskSession,
  } = controllerPorts;
  const buildSidebarTaskRun = (...args) => controllerOperations.buildSidebarTaskRun(...args);
  const clearSuppressedCaptureRecoveryForRecord = (...args) => controllerOperations.clearSuppressedCaptureRecoveryForRecord(...args);
  const getKnownDetailRunnerTabIds = (...args) => controllerOperations.getKnownDetailRunnerTabIds(...args);
  const isCaptureRecoveryPhase = (...args) => controllerOperations.isCaptureRecoveryPhase(...args);
  const projectCaptureTaskProgress = (...args) => controllerOperations.projectCaptureTaskProgress(...args);
  const readFiniteProgressNumber = (...args) => controllerOperations.readFiniteProgressNumber(...args);
  const rememberCaptureTaskProgressContext = (...args) => controllerOperations.rememberCaptureTaskProgressContext(...args);
  const renderCaptureRecoveryUI = (...args) => controllerOperations.renderCaptureRecoveryUI(...args);
  const renewCaptureExecutionLock = (...args) => controllerOperations.renewCaptureExecutionLock(...args);
  const reportSidebarTaskRun = (...args) => controllerOperations.reportSidebarTaskRun(...args);
  const reportUnattendedKeywordRun = (...args) => controllerOperations.reportUnattendedKeywordRun(...args);
  const resetCaptureRecoveryUI = (...args) => controllerOperations.resetCaptureRecoveryUI(...args);
  const updateActiveCommentCaptureIdentity = (...args) => controllerOperations.updateActiveCommentCaptureIdentity(...args);

  function publishCommentProgressToRuntime(progress) {
    const phase = String(progress?.phase || "").trim();
    if (!phase.startsWith("comments_")) {
      return;
    }
    const recordId = String(progress?.recordId || "").trim();
    if (!recordId) {
      return;
    }
    const sameRecoveryRecord =
      String(controllerState.activeRecoveryProgress?.recordId || "").trim() === recordId;
    const payload = {
      ...progress,
      recordId,
      captureAction: "captureComments",
      captureRequestId:
        String(progress?.captureRequestId || "").trim() ||
        (sameRecoveryRecord
          ? String(controllerState.activeRecoveryProgress?.captureRequestId || "").trim()
          : ""),
      runnerTabId:
        Number(progress?.runnerTabId) ||
        (sameRecoveryRecord ? Number(controllerState.activeRecoveryRunnerTabId) || null : null),
      updatedAt: Date.now(),
    };
    void Promise.resolve(
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.CAPTURE_PROGRESS,
        payload,
      }),
    )
      .catch((error) => {
        console.warn("[Sidebar] Publish comment progress failed:", error);
      });
  }

  function reportActiveSidebarTaskProgress(progress = {}) {
    const taskContext = getActiveTaskContext();
    if (!taskContext?.taskId) return;
    // 无人值守已有 request root 作为唯一公开任务台账；内部 Debug wrapper
    // 只负责浏览器采集辅助。若把作品级 current/total 再写成关键词任务，会产生
    // processed=8,total=4 的双记录和陈旧 detail_item_* 终态。
    if (taskContext.featureKey === "capture.unattended_keyword") return;
    const now = Date.now();
    if (now - controllerState.lastTaskLedgerProgressAt < 1500) return;
    controllerState.lastTaskLedgerProgressAt = now;
    const phase = String(progress?.phase || "");
    const status =
      phase === "network_paused"
        ? "paused"
        : phase.includes("recover") || phase === "system_resumed"
          ? "recovering"
          : "running";
    const progressPatch = {
      current: Number.isFinite(Number(progress?.current))
        ? Number(progress.current)
        : 0,
      total: Number.isFinite(Number(progress?.total))
        ? Number(progress.total)
        : 0,
      phase,
      message: String(progress?.message || ""),
      recordId: String(progress?.recordId || ""),
      keyword: String(progress?.keyword || ""),
      savedCount: Number.isFinite(Number(progress?.savedCount))
        ? Number(progress.savedCount)
        : Number.isFinite(Number(progress?.collectedCount))
          ? Number(progress.collectedCount)
          : null,
    };
    const taskRun = buildSidebarTaskRun(taskContext, {
      status,
      progress: progressPatch,
      businessProgressAt: new Date(now).toISOString(),
    });
    void reportSidebarTaskRun(taskRun, {
      type: "progress",
      status,
      phase,
      message: progressPatch.message,
    });
  }

  function reportActiveUnattendedContentProgress(progress = {}) {
    if (
      !controllerState.activeUnattendedRunRequestId ||
      !controllerState.activeUnattendedRunAttemptId ||
      controllerState.activeUnattendedAttemptRejected
    ) {
      return;
    }
    const activeTerminalKey = `${String(controllerState.activeUnattendedRunRequestId || "").trim()}:${String(controllerState.activeUnattendedRunAttemptId || "").trim()}`;
    if (
      controllerState.activeUnattendedTerminalProgressKey &&
      controllerState.activeUnattendedTerminalProgressKey === activeTerminalKey
    ) {
      return;
    }
    progress = projectCaptureTaskProgress(progress);
    const phase = String(progress?.phase || "").trim();
    const message = String(progress?.message || "").trim();
    const fingerprint = JSON.stringify({
      phase,
      message,
      captureRequestId: String(progress?.captureRequestId || ""),
      recordId: String(progress?.recordId || ""),
      keyword: String(progress?.keyword || ""),
      current: Number(progress?.current) || 0,
      count: Number(progress?.count) || 0,
      detectedCount: Number(progress?.detectedCount) || 0,
      qualifiedCount: Number(progress?.qualifiedCount) || 0,
      filteredCount: Number(progress?.filteredCount) || 0,
      collectedCount: Number(progress?.collectedCount) || 0,
      savedCount: Number(progress?.savedCount) || 0,
    });
    if (!phase && !message) return;
    if (fingerprint === controllerState.lastUnattendedContentProgressFingerprint) return;
    const now = Date.now();
    if (
      now - controllerState.lastUnattendedContentProgressAt <
      UNATTENDED_CONTENT_PROGRESS_MIN_INTERVAL_MS
    ) {
      return;
    }
    controllerState.lastUnattendedContentProgressAt = now;
    controllerState.lastUnattendedContentProgressFingerprint = fingerprint;
    controllerState.activeUnattendedProgressSeq += 1;
    void reportUnattendedKeywordRun(controllerState.activeUnattendedRunRequestId, {
      status: "running",
      progressSeq: controllerState.activeUnattendedProgressSeq,
      progress: {
        current: Number.isFinite(Number(progress?.current))
          ? Number(progress.current)
          : Number(progress?.detectedCount) || Number(progress?.collectedCount) || 0,
        total: Number.isFinite(Number(progress?.total)) ? Number(progress.total) : 0,
        keyword: String(progress?.keyword || ""),
        keywordCurrent: readFiniteProgressNumber(progress?.keywordCurrent),
        keywordTotal: readFiniteProgressNumber(progress?.keywordTotal),
        itemCurrent: readFiniteProgressNumber(progress?.itemCurrent),
        itemTotal: readFiniteProgressNumber(progress?.itemTotal),
        nextKeyword: String(progress?.nextKeyword || ""),
        runStartedAt: String(progress?.runStartedAt || ""),
        progressScope: String(progress?.progressScope || ""),
        round: readFiniteProgressNumber(progress?.roundCurrent, progress?.round),
        roundCurrent: readFiniteProgressNumber(
          progress?.roundCurrent,
          progress?.round,
        ),
        roundTotal: readFiniteProgressNumber(progress?.roundTotal),
        attemptCurrent: readFiniteProgressNumber(
          progress?.attemptCurrent,
          progress?.attempt,
        ),
        attemptTotal: readFiniteProgressNumber(
          progress?.attemptTotal,
          progress?.maxAttempts,
        ),
        remainingMs: readFiniteProgressNumber(progress?.remainingMs),
        waitUntil: String(progress?.waitUntil || ""),
        phase,
        message: message || "采集内容持续更新中",
        recordId: String(progress?.recordId || ""),
        savedCount: Number.isFinite(Number(progress?.savedCount))
          ? Number(progress.savedCount)
          : Number.isFinite(Number(progress?.collectedCount))
            ? Number(progress.collectedCount)
            : null,
        phaseStartedAt: String(progress?.phaseStartedAt || ""),
        workerMode: String(progress?.workerMode || ""),
        workerStates: Array.isArray(progress?.workerStates)
          ? progress.workerStates.slice(0, 2)
          : [],
        taskMeta:
          progress?.taskMeta && typeof progress.taskMeta === "object"
            ? progress.taskMeta
            : {},
        updatedAt: new Date(now).toISOString(),
      },
    }).catch(() => null);
  }

  function handleProgress(progress) {
    const incomingCaptureTaskId = String(
      progress?.captureTaskId || progress?.taskId || "",
    ).trim();
    const currentCaptureTaskId = String(
      controllerState.captureTaskOwnerTaskId ||
        controllerState.activeCaptureTaskProgressContext?.captureTaskId ||
        "",
    ).trim();
    if (
      incomingCaptureTaskId &&
      currentCaptureTaskId &&
      incomingCaptureTaskId !== currentCaptureTaskId
    ) {
      return progress;
    }
    const incomingUnattendedRequestId = String(
      progress?.unattendedRequestId || "",
    ).trim();
    if (
      controllerState.activeUnattendedRunRequestId &&
      incomingUnattendedRequestId !== controllerState.activeUnattendedRunRequestId
    ) {
      return progress;
    }
    const incomingUnattendedAttemptId = String(
      progress?.unattendedAttemptId || progress?.attemptId || "",
    ).trim();
    const currentUnattendedAttemptId =
      typeof controllerState.activeUnattendedRunAttemptId === "undefined"
        ? ""
        : String(controllerState.activeUnattendedRunAttemptId || "").trim();
    if (
      currentUnattendedAttemptId &&
      incomingUnattendedAttemptId !== currentUnattendedAttemptId
    ) {
      return progress;
    }
    const incomingTerminalKey = `${incomingUnattendedRequestId || String(controllerState.activeUnattendedRunRequestId || "").trim()}:${incomingUnattendedAttemptId || currentUnattendedAttemptId}`;
    if (
      controllerState.activeUnattendedTerminalProgressKey &&
      controllerState.activeUnattendedTerminalProgressKey === incomingTerminalKey
    ) {
      return progress;
    }
    progress = rememberCaptureTaskProgressContext(progress);
    const incomingPhase = String(progress?.phase || "");
    const incomingWorkerRevision = Number(progress?.workerRevision);
    const hasWorkerRevision =
      Number.isSafeInteger(incomingWorkerRevision) && incomingWorkerRevision >= 0;
    if (
      Array.isArray(progress?.workerStates) &&
      (!hasWorkerRevision || incomingWorkerRevision >= controllerState.detailBatchWorkerRevision)
    ) {
      controllerState.detailBatchWorkerStates = progress.workerStates.map((state) => ({...state}));
      if (hasWorkerRevision) {
        controllerState.detailBatchWorkerRevision = incomingWorkerRevision;
      }
    }
    if (typeof progress?.workerMode === "string" && progress.workerMode.trim()) {
      controllerState.detailBatchWorkerMode = progress.workerMode.trim();
    }
    if (incomingPhase.startsWith("detail_") && controllerState.detailBatchWorkerStates.length > 0) {
      progress = {
        ...progress,
        workerStates: controllerState.detailBatchWorkerStates.map((state) => ({...state})),
        workerMode: progress?.workerMode || controllerState.detailBatchWorkerMode,
        workerRevision: Math.max(
          controllerState.detailBatchWorkerRevision,
          hasWorkerRevision ? incomingWorkerRevision : 0,
        ),
        runnerTabIds:
          Array.isArray(progress?.runnerTabIds) && progress.runnerTabIds.length > 0
            ? progress.runnerTabIds
            : getKnownDetailRunnerTabIds(),
      };
    }
    console.log("[Sidebar] Progress:", progress);
    void updateCaptureTaskSession({
      taskId: incomingCaptureTaskId || controllerState.captureTaskOwnerTaskId,
      progress,
    });
    reportActiveUnattendedContentProgress(progress);
    reportActiveSidebarTaskProgress(progress);

    // 如果进入了单项的评论采集阶段，全局进度条无需显示，因为卡片上已有进度和停止按钮
    const phase = incomingPhase;
    const progressRecordId =
      typeof progress?.recordId === "string" ? progress.recordId.trim() : "";
    if (progressRecordId && ACTIVE_COMMENT_PROGRESS_PHASES.has(phase)) {
      clearSuppressedCaptureRecoveryForRecord(progressRecordId);
    }
    const presentation = taskView.openCaptureProgressPresentation();
    const unattendedScoped = Boolean(
      controllerState.activeUnattendedRunRequestId ||
        progress?.unattendedRequestId ||
        presentation.readUnattendedState(),
    );
    const isTerminalPhase = unattendedScoped
      ? isUnattendedTerminalProgressPhase(phase)
      : isTerminalProgressPhase(phase);
    const unattendedProgressState = String(
      presentation.readUnattendedState() || "",
    );
    const suppressLateUnattendedUi =
      unattendedProgressState === "terminal" && !isTerminalPhase;
    const recoveryRendered = suppressLateUnattendedUi
      ? false
      : renderCaptureRecoveryUI(progress);
    publishCommentProgressToRuntime(progress);
    if (
      isTerminalPhase &&
      presentation.hasPanel &&
      (controllerState.activeUnattendedRunRequestId || unattendedProgressState === "running")
    ) {
      presentation.markUnattendedTerminal();
    }
    if (isTerminalPhase && !recoveryRendered) {
      hideProgressPanelOnly({
        force: true,
        preserveUnattendedTerminalState: true,
      });
    }

    if (phase.startsWith("detail_")) {
      if (Number.isFinite(Number(progress?.runnerTabId))) {
        const nextRunnerTabId = Number(progress.runnerTabId);
        const runnerChanged = controllerState.detailBatchRunnerTabId !== nextRunnerTabId;
        controllerState.detailBatchRunnerTabId = nextRunnerTabId;
        if (runnerChanged && controllerState.activeCaptureExecutionLockId) {
          void renewCaptureExecutionLock(
            controllerState.activeCaptureExecutionLockId,
            nextRunnerTabId,
          );
        }
      }
    }

    if (phase.startsWith("comments_") && !recoveryRendered) {
      if (presentation.isRecoveryPresentation()) {
        resetCaptureRecoveryUI({hidePanel: true, clearState: true});
      } else if (presentation.hasPanel) {
        presentation.hideCaptureProgress();
      }
    } else if (
      !recoveryRendered &&
      !isTerminalPhase &&
      !suppressLateUnattendedUi
    ) {
      if (presentation.isRecoveryPresentation()) {
        resetCaptureRecoveryUI({hidePanel: false, clearState: true});
        presentation.useCaptureSource();
      }
      if (presentation.hasPanel && !isUnsupportedPlatformCoverVisible()) {
        if (controllerState.activeUnattendedRunRequestId) {
          presentation.markUnattendedRunning();
        }
        presentation.showCaptureProgress();
      }
      presentation.showCancelActionIfPanelVisible();
      // 否则正常更新全局进度消息
      const messagePresentation = presentation.openMessagePresentation();
      const nextMessage = buildCaptureProgressText(progress);
      messagePresentation.render(nextMessage);
    }

    const isCommentProgress =
      phase.startsWith("comments_") ||
      phase === "detail_comments_capturing" ||
      ((phase === "network_paused" ||
        phase === "network_resumed" ||
        phase === "network_timeout" ||
        phase === "system_resumed") &&
        Boolean(progressRecordId));

    if (progressRecordId && isCommentProgress) {
      updateActiveCommentCaptureIdentity(progress);
    }

    if (phase === "comments_capturing" && progressRecordId) {
      clearCommentCaptureTerminalStatus(progressRecordId);
    }

    const terminalCommentStatus = resolveCommentTerminalStatusFromPhase(phase);
    if (terminalCommentStatus && progressRecordId) {
      markCommentCaptureTerminalStatus(progressRecordId, terminalCommentStatus);
      reconcileCommentCaptureTerminalState(progressRecordId, {
        status: terminalCommentStatus,
        collectedCount: progress?.collectedCount,
        errorMessage:
          terminalCommentStatus === "failed"
            ? String(progress?.error?.message || progress?.message || "")
            : "",
      }).catch((error) => {
        console.warn(
          "[Sidebar] Failed to reconcile terminal comment status:",
          error,
        );
      });
    }

    if (
      controllerState.activeCommentsCaptureRecordId &&
      Number.isFinite(Number(progress?.collectedCount))
    ) {
      const nextCount = Number(progress.collectedCount);
      if (!isCommentCaptureTerminal(controllerState.activeCommentsCaptureRecordId)) {
        syncCommentProgressToRecord(
          controllerState.activeCommentsCaptureRecordId,
          nextCount,
        ).catch((error) => {
          console.warn("[Sidebar] Failed to sync comment progress:", error);
        });
      }
    }

    if (phase.startsWith("comments_")) {
      refreshDataPoolThrottled().catch((error) => {
        console.warn(
          "[Sidebar] Failed to refresh pool during comments capture:",
          error,
        );
      });
    } else if (phase.startsWith("detail_")) {
      refreshDataPoolThrottled().catch((error) => {
        console.warn(
          "[Sidebar] Failed to refresh pool during detail capture:",
          error,
        );
      });
    }
    if (
      terminalCommentStatus &&
      controllerState.activeCommentsCaptureRecordId === progressRecordId
    ) {
      controllerState.activeCommentsCaptureRecordId = "";
      controllerState.activeCommentsCaptureTabId = null;
      controllerState.activeCommentsCaptureRequestId = "";
    }
    return progress;
  }

  async function syncRuntimeCommentProgress(runtime) {
    const progress = runtime?.lastCaptureProgress;
    if (!progress) {
      return;
    }
    const phase = String(progress.phase || "");
    if (!phase.startsWith("comments_")) {
      return;
    }
    const progressRecordId = String(progress?.recordId || "").trim();
    if (progressRecordId) {
      updateActiveCommentCaptureIdentity(progress);
    }
    if (!controllerState.activeCommentsCaptureRecordId) {
      return;
    }
    if (phase === "comments_collecting" || phase === "comments_capturing") {
      hideProgressPanelOnly({force: true});
    }
    if (phase === "comments_capturing") {
      clearCommentCaptureTerminalStatus(controllerState.activeCommentsCaptureRecordId);
    }
    const terminalCommentStatus = resolveCommentTerminalStatusFromPhase(phase);
    if (terminalCommentStatus) {
      markCommentCaptureTerminalStatus(
        controllerState.activeCommentsCaptureRecordId,
        terminalCommentStatus,
      );
      await reconcileCommentCaptureTerminalState(controllerState.activeCommentsCaptureRecordId, {
        status: terminalCommentStatus,
        collectedCount: progress?.collectedCount,
        errorMessage:
          terminalCommentStatus === "failed"
            ? String(progress?.error?.message || progress?.message || "")
            : "",
      });
      controllerState.activeCommentsCaptureRecordId = "";
      controllerState.activeCommentsCaptureTabId = null;
      controllerState.activeCommentsCaptureRequestId = "";
      return;
    }
    if (!Number.isFinite(Number(progress.collectedCount))) {
      return;
    }
    if (isCommentCaptureTerminal(controllerState.activeCommentsCaptureRecordId)) {
      return;
    }

    await syncCommentProgressToRecord(
      controllerState.activeCommentsCaptureRecordId,
      Number(progress.collectedCount),
    );
  }

  function syncRuntimeCaptureProgress(runtime) {
    const progress = runtime?.lastCaptureProgress;
    if (!progress) {
      const presentation = taskView.openCaptureProgressPresentation();
      if (
        presentation.isRecoveryPresentation() &&
        String(controllerState.activeRecoveryProgress?.phase || "") !== "interrupted_repaired"
      ) {
        resetCaptureRecoveryUI({hidePanel: true, clearState: true});
      }
      return;
    }

    const incomingCaptureTaskId = String(
      progress?.captureTaskId || progress?.taskId || "",
    ).trim();
    const currentCaptureTaskId = String(
      controllerState.captureTaskOwnerTaskId ||
        controllerState.activeCaptureTaskProgressContext?.captureTaskId ||
        runtime?.captureDebugSession?.taskId ||
        "",
    ).trim();
    const incomingUnattendedRequestId = String(
      progress?.unattendedRequestId || "",
    ).trim();
    const incomingUnattendedAttemptId = String(
      progress?.unattendedAttemptId || progress?.attemptId || "",
    ).trim();
    if (
      (incomingCaptureTaskId &&
        currentCaptureTaskId &&
        incomingCaptureTaskId !== currentCaptureTaskId) ||
      (controllerState.activeUnattendedRunRequestId &&
        incomingUnattendedRequestId !== controllerState.activeUnattendedRunRequestId) ||
      (controllerState.activeUnattendedRunAttemptId &&
        incomingUnattendedAttemptId !== controllerState.activeUnattendedRunAttemptId)
    ) {
      return;
    }

    const phase = String(progress.phase || "");
    if (ACTIVE_COMMENT_PROGRESS_PHASES.has(phase)) {
      clearSuppressedCaptureRecoveryForRecord(progress?.recordId);
    }
    const isRecoveryPhase = isCaptureRecoveryPhase(phase);
    const recoveryRendered = isRecoveryPhase
      ? renderCaptureRecoveryUI(progress)
      : false;
    if (isRecoveryPhase && !recoveryRendered) {
      resetCaptureRecoveryUI({hidePanel: true, clearState: true});
    }
    if (recoveryRendered) {
      return;
    }
    if (controllerState.detailBatchCaptureInFlight && !isRecoveryPhase) {
      return;
    }
    if (!phase) {
      return;
    }
    const presentation = taskView.openCaptureProgressPresentation();
    const unattendedScoped = Boolean(
      controllerState.activeUnattendedRunRequestId ||
        progress?.unattendedRequestId ||
        presentation.readUnattendedState(),
    );
    const terminalForCurrentScope = unattendedScoped
      ? isUnattendedTerminalProgressPhase(phase)
      : isTerminalProgressPhase(phase);
    if (
      presentation.readUnattendedState() === "terminal" &&
      !terminalForCurrentScope
    ) {
      return;
    }
    if (phase.startsWith("comments_")) {
      hideProgressPanelOnly({force: true});
      return;
    }
    if (terminalForCurrentScope) {
      if (
        presentation.hasPanel &&
        (controllerState.activeUnattendedRunRequestId ||
          presentation.readUnattendedState() === "running")
      ) {
        presentation.markUnattendedTerminal();
      }
      hideProgressPanelOnly({
        force: true,
        preserveUnattendedTerminalState: true,
      });
      if (controllerState.batchKeywordCaptureInFlight) {
        setBatchProgressDetail("");
      }
      return;
    }

    // 批量关键词采集进行中:把底层细粒度进度(探测/筛选/防反爬等待)镜像到弹窗明细行,
    // 并收起外部蓝色进度条 + 中止按钮(统一并入弹窗,避免重复)
    if (controllerState.batchKeywordCaptureInFlight) {
      setBatchProgressDetail(buildCaptureProgressText(progress));
      hideProgressPanelOnly();
      return;
    }

    const messagePresentation = presentation.openRuntimeMessagePresentation();
    if (!messagePresentation) {
      return;
    }

    if (isUnsupportedPlatformCoverVisible()) {
      hideProgressPanelOnly({force: true});
      return;
    }

    // 仅在本次会话已经主动展示进度面板时，才继续用 runtime 进度刷新。
    // 避免旧任务遗留的 progress 在空闲状态下重新弹出。
    if (presentation.isPanelHidden() && !isRecoveryPhase) {
      return;
    }

    const nextMessage = buildCaptureProgressText(progress);
    if (!nextMessage) {
      return;
    }

    if (presentation.isRecoveryPresentation()) {
      resetCaptureRecoveryUI({hidePanel: false, clearState: true});
    }
    presentation.useCaptureSource();
    if (controllerState.activeUnattendedRunRequestId) {
      presentation.markUnattendedRunning();
    }
    presentation.showCaptureProgress();
    messagePresentation.render(nextMessage);
  }

  function buildCaptureProgressText(progress) {
    return taskView.buildCaptureProgressText(progress);
  }

  function normalizeProgressCount(value) {
    return taskView.normalizeProgressCount(value);
  }

  async function syncCommentProgressToRecord(recordId, collectedCount) {
    if (isCommentCaptureTerminal(recordId)) {
      return;
    }

    const now = Date.now();
    if (now - controllerState.lastProgressSyncAt < 800) {
      return;
    }
    controllerState.lastProgressSyncAt = now;

    const {getRecord, updateRecord} = await loadStorageModule();
    const record = await getRecord(recordId);
    if (!record || record.type !== "single_note") {
      return;
    }

    const payload = record.payload || {};
    const currentStatus = String(payload.commentsCaptureStatus || "");
    const currentCount = Number(payload.commentsTotalCaptured || 0);
    if (currentStatus !== "capturing" || collectedCount <= currentCount) {
      return;
    }
    if (isCommentCaptureTerminal(recordId)) {
      return;
    }

    // 避免并发覆盖终态：在落盘前再次读取最新记录，防止旧快照把 done/partial/failed 回写成 capturing
    const latestRecord = await getRecord(recordId);
    if (!latestRecord || latestRecord.type !== "single_note") {
      return;
    }
    const latestPayload = latestRecord.payload || {};
    const latestStatus = String(latestPayload.commentsCaptureStatus || "");
    const latestCount = Number(latestPayload.commentsTotalCaptured || 0);
    if (latestStatus !== "capturing" || collectedCount <= latestCount) {
      return;
    }
    if (isCommentCaptureTerminal(recordId)) {
      return;
    }

    await updateRecord(recordId, {
      payload: {
        ...latestPayload,
        commentsTotalCaptured: collectedCount,
      },
    });

    await refreshDataPoolThrottled();
  }

  function resolveCommentTerminalStatusFromPhase(phase) {
    const normalized = String(phase || "")
      .trim()
      .toLowerCase();
    return COMMENT_PHASE_TO_TERMINAL_STATUS[normalized] || "";
  }

  function markCommentCaptureTerminalStatus(recordId, status) {
    if (!recordId || !status) {
      return;
    }
    controllerState.commentCaptureTerminalStatusByRecordId.set(recordId, status);
  }

  function clearCommentCaptureTerminalStatus(recordId) {
    if (!recordId) {
      return;
    }
    controllerState.commentCaptureTerminalStatusByRecordId.delete(recordId);
  }

  function isCommentCaptureTerminal(recordId) {
    if (!recordId) {
      return false;
    }
    return controllerState.commentCaptureTerminalStatusByRecordId.has(recordId);
  }

  async function reconcileCommentCaptureTerminalState(
    recordId,
    {status, collectedCount = null, errorMessage = ""} = {},
  ) {
    if (!recordId || !status) {
      return;
    }

    const normalizedStatus = String(status).trim().toLowerCase();
    if (!["done", "partial", "failed"].includes(normalizedStatus)) {
      return;
    }

    const normalizedCount = Number(collectedCount);
    const hasCount = Number.isFinite(normalizedCount);
    const nextCollectedCount = hasCount
      ? Math.max(0, Math.floor(normalizedCount))
      : 0;
    const nextError =
      normalizedStatus === "failed" ? String(errorMessage || "").trim() : "";

    const {getRecord, updateRecord} = await loadStorageModule();
    const record = await getRecord(recordId);
    if (!record || record.type !== "single_note") {
      return;
    }

    const payload = record.payload || {};
    const currentStatus = String(payload.commentsCaptureStatus || "")
      .trim()
      .toLowerCase();
    const currentCount = Number(payload.commentsTotalCaptured || 0);
    const finalCount = hasCount
      ? Math.max(currentCount, nextCollectedCount)
      : currentCount;
    const currentError = String(payload.commentsCaptureError || "").trim();

    if (
      currentStatus === normalizedStatus &&
      currentCount === finalCount &&
      currentError === nextError
    ) {
      return;
    }

    await updateRecord(recordId, {
      payload: {
        ...payload,
        commentsCaptureStatus: normalizedStatus,
        commentsTotalCaptured: finalCount,
        commentsCaptureError: nextError,
      },
    });

    await refreshDataPoolThrottled();
  }

  async function refreshDataPoolThrottled() {
    const now = Date.now();
    if (now - controllerState.lastPoolRefreshAt < 500) {
      return;
    }
    controllerState.lastPoolRefreshAt = now;
    await refreshDataPool();
  }

  return Object.freeze({
    publishCommentProgressToRuntime,
    reportActiveSidebarTaskProgress,
    reportActiveUnattendedContentProgress,
    handleProgress,
    syncRuntimeCommentProgress,
    syncRuntimeCaptureProgress,
    buildCaptureProgressText,
    normalizeProgressCount,
    syncCommentProgressToRecord,
    resolveCommentTerminalStatusFromPhase,
    markCommentCaptureTerminalStatus,
    clearCommentCaptureTerminalStatus,
    isCommentCaptureTerminal,
    reconcileCommentCaptureTerminalState,
    refreshDataPoolThrottled,
  });
}
