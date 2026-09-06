// L3-A recovery: original control flow, explicit state and compatibility ports.
export function createRecoveryController({controllerState, controllerPorts, controllerOperations}) {
  const {
    CAPTURE_RECOVERY_PHASES,
    CAPTURE_RECOVERY_UI_STALE_MS,
    MESSAGE_TYPE,
    chrome,
    clearKeywordPlanProgressCountdown,
    clearTimeout,
    console,
    taskView,
    isUnsupportedPlatformCoverVisible,
    resolveCaptureRecoveryView,
    setTimeout,
  } = controllerPorts;
  const handleRetryCommentsCapture = (...args) => controllerOperations.handleRetryCommentsCapture(...args);

  function isCaptureRecoveryPhase(phase) {
    return CAPTURE_RECOVERY_PHASES.has(String(phase || "").trim().toLowerCase());
  }

  function buildCaptureRecoverySuppressionKey(progress = {}) {
    const phase = String(progress?.phase || "").trim().toLowerCase();
    const recordId = String(progress?.recordId || "").trim();
    const captureRequestId = String(progress?.captureRequestId || "").trim();
    if (!phase || !recordId) return "";
    return `${phase}|${recordId}|${captureRequestId}`;
  }

  function clearSuppressedCaptureRecoveryForRecord(recordId) {
    const normalizedRecordId = String(recordId || "").trim();
    if (!normalizedRecordId) return;
    for (const key of controllerState.suppressedCaptureRecoveryKeys) {
      if (key.split("|")[1] === normalizedRecordId) {
        controllerState.suppressedCaptureRecoveryKeys.delete(key);
      }
    }
  }

  function updateActiveCommentCaptureIdentity(progress = {}) {
    const recordId = String(progress?.recordId || "").trim();
    if (!recordId) return;
    if (
      controllerState.activeCommentsCaptureRecordId &&
      controllerState.activeCommentsCaptureRecordId !== recordId
    ) {
      controllerState.activeCommentsCaptureTabId = null;
      controllerState.activeCommentsCaptureRequestId = "";
    }
    controllerState.activeCommentsCaptureRecordId = recordId;

    const runnerTabId = Number(progress?.runnerTabId);
    if (Number.isFinite(runnerTabId) && runnerTabId > 0) {
      controllerState.activeCommentsCaptureTabId = runnerTabId;
    }
    const captureRequestId = String(progress?.captureRequestId || "").trim();
    if (captureRequestId) {
      controllerState.activeCommentsCaptureRequestId = captureRequestId;
    }
  }

  function resetCaptureRecoveryUI({hidePanel = false, clearState = true} = {}) {
    if (controllerState.captureRecoveryFreshnessTimer) {
      clearTimeout(controllerState.captureRecoveryFreshnessTimer);
      controllerState.captureRecoveryFreshnessTimer = null;
    }
    taskView.resetCaptureRecoveryPresentation({hidePanel});

    if (clearState) {
      controllerState.activeRecoveryProgress = null;
      controllerState.activeRecoveryRunnerTabId = null;
    }
  }

  function renderCaptureRecoveryUI(progress) {
    const source = progress && typeof progress === "object" ? progress : {};
    const sourceRecordId = String(source.recordId || "").trim();
    const previousRecordId = String(
      controllerState.activeRecoveryProgress?.recordId || "",
    ).trim();
    const canReuseIdentity =
      Boolean(sourceRecordId) && sourceRecordId === previousRecordId;
    const canReuseCommentIdentity =
      Boolean(sourceRecordId) &&
      sourceRecordId === controllerState.activeCommentsCaptureRecordId;
    const normalizedProgress = {
      ...source,
      captureRequestId:
        String(source.captureRequestId || "").trim() ||
        (canReuseIdentity
          ? String(controllerState.activeRecoveryProgress?.captureRequestId || "").trim()
          : "") ||
        (canReuseCommentIdentity
          ? String(controllerState.activeCommentsCaptureRequestId || "").trim()
          : ""),
      runnerTabId:
        Number(source.runnerTabId) ||
        (canReuseIdentity ? Number(controllerState.activeRecoveryRunnerTabId) || null : null) ||
        (canReuseCommentIdentity
          ? Number(controllerState.activeCommentsCaptureTabId) || null
          : null),
      captureAction:
        String(source.captureAction || "").trim() ||
        (canReuseIdentity
          ? String(controllerState.activeRecoveryProgress?.captureAction || "").trim()
          : ""),
    };
    const phase = String(normalizedProgress.phase || "").trim().toLowerCase();
    const suppressionKey = buildCaptureRecoverySuppressionKey(
      normalizedProgress,
    );
    if (suppressionKey && controllerState.suppressedCaptureRecoveryKeys.has(suppressionKey)) {
      return false;
    }
    const canRetry =
      (phase === "comments_partial" ||
        phase === "comments_failed" ||
        phase === "interrupted_repaired") &&
      Boolean(String(normalizedProgress.recordId || "").trim());
    const view = resolveCaptureRecoveryView(normalizedProgress, {canRetry});
    if (!view.visible || isUnsupportedPlatformCoverVisible()) {
      return false;
    }
    if (controllerState.captureRecoveryFreshnessTimer) {
      clearTimeout(controllerState.captureRecoveryFreshnessTimer);
      controllerState.captureRecoveryFreshnessTimer = null;
    }

    const presentation = taskView.openCaptureRecoveryPresentation();
    if (!presentation) {
      return false;
    }
    if (presentation.isKeywordPlanPresentation()) {
      clearKeywordPlanProgressCountdown();
    }
    presentation.render(view);

    controllerState.activeRecoveryProgress = {...normalizedProgress, ...view};
    const runnerTabId = Number(
      view.runnerTabId || normalizedProgress.runnerTabId,
    );
    controllerState.activeRecoveryRunnerTabId =
      Number.isFinite(runnerTabId) && runnerTabId > 0 ? runnerTabId : null;
    const isCommentRecovery =
      phase.startsWith("comments_") ||
      String(normalizedProgress.captureAction || "") === "captureComments";
    if (isCommentRecovery && view.recordId) {
      updateActiveCommentCaptureIdentity({
        ...normalizedProgress,
        recordId: view.recordId,
        runnerTabId: controllerState.activeRecoveryRunnerTabId,
        captureRequestId: view.captureRequestId,
      });
    }
    const numericUpdatedAt = Number(normalizedProgress.updatedAt);
    const parsedUpdatedAt = Date.parse(String(normalizedProgress.updatedAt || ""));
    const updatedAt =
      Number.isFinite(numericUpdatedAt) && numericUpdatedAt > 0
        ? numericUpdatedAt
        : parsedUpdatedAt;
    if (Number.isFinite(updatedAt) && updatedAt > 0) {
      controllerState.activeRecoveryProgress.updatedAt = updatedAt;
      const identity = [
        phase,
        view.recordId,
        view.captureRequestId,
        String(updatedAt),
      ].join("|");
      controllerState.captureRecoveryFreshnessTimer = setTimeout(() => {
        const activeIdentity = [
          String(controllerState.activeRecoveryProgress?.phase || ""),
          String(controllerState.activeRecoveryProgress?.recordId || ""),
          String(controllerState.activeRecoveryProgress?.captureRequestId || ""),
          String(Number(controllerState.activeRecoveryProgress?.updatedAt) || 0),
        ].join("|");
        if (activeIdentity === identity) {
          resetCaptureRecoveryUI({hidePanel: true, clearState: true});
        }
      }, Math.min(
        CAPTURE_RECOVERY_UI_STALE_MS,
        Math.max(50, updatedAt + CAPTURE_RECOVERY_UI_STALE_MS - Date.now()),
      ));
    }
    return true;
  }

  async function handleRetryRecovery() {
    const presentation = taskView.openCaptureProgressPresentation();
    const recordId = String(
      controllerState.activeRecoveryProgress?.recordId ||
        presentation.readRecoveryRecordId() ||
        "",
    ).trim();
    if (!recordId) {
      taskView.showMissingRecoveryRecordNotice();
      return;
    }
    const snapshot = controllerState.activeRecoveryProgress
      ? {...controllerState.activeRecoveryProgress}
      : null;
    const suppressionKey = buildCaptureRecoverySuppressionKey(snapshot);
    if (suppressionKey) {
      controllerState.suppressedCaptureRecoveryKeys.add(suppressionKey);
    }
    const started = await handleRetryCommentsCapture(recordId);
    if (started === false && suppressionKey) {
      controllerState.suppressedCaptureRecoveryKeys.delete(suppressionKey);
      if (snapshot) {
        renderCaptureRecoveryUI({...snapshot, updatedAt: Date.now()});
      }
    }
  }

  function handleDismissRecovery() {
    const snapshot = controllerState.activeRecoveryProgress
      ? {...controllerState.activeRecoveryProgress}
      : null;
    const suppressionKey = buildCaptureRecoverySuppressionKey(snapshot);
    if (suppressionKey) {
      controllerState.suppressedCaptureRecoveryKeys.add(suppressionKey);
      while (controllerState.suppressedCaptureRecoveryKeys.size > 200) {
        const oldestKey = controllerState.suppressedCaptureRecoveryKeys.values().next().value;
        if (!oldestKey) break;
        controllerState.suppressedCaptureRecoveryKeys.delete(oldestKey);
      }
    }
    resetCaptureRecoveryUI({hidePanel: true, clearState: true});
    if (!snapshot) return;

    const clearPersistedProgress = (updatedAt = 0) =>
      Promise.resolve(
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPE.CLEAR_CAPTURE_PROGRESS,
          phase: String(snapshot.phase || ""),
          recordId: String(snapshot.recordId || ""),
          captureRequestId: String(snapshot.captureRequestId || ""),
          updatedAt,
        }),
      );
    void clearPersistedProgress(Number(snapshot.updatedAt) || 0).catch((error) => {
      console.warn("[Sidebar] Clear dismissed recovery progress failed:", error);
    });
    if (String(snapshot.captureRequestId || "").trim()) {
      setTimeout(() => {
        void clearPersistedProgress(0).catch(() => null);
      }, 250);
    }
  }

  return Object.freeze({
    isCaptureRecoveryPhase,
    buildCaptureRecoverySuppressionKey,
    clearSuppressedCaptureRecoveryForRecord,
    updateActiveCommentCaptureIdentity,
    resetCaptureRecoveryUI,
    renderCaptureRecoveryUI,
    handleRetryRecovery,
    handleDismissRecovery,
  });
}
