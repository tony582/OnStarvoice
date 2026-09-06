// L3-A recovery: original control flow, explicit state and compatibility ports.
export function createRecoveryController({controllerState, controllerBindings, controllerPorts, controllerOperations}) {
  const {
    CAPTURE_RECOVERY_PHASES,
    CAPTURE_RECOVERY_UI_STALE_MS,
    MESSAGE_TYPE,
    buildCaptureRecoveryAnnouncementKey,
    chrome,
    clearKeywordPlanProgressCountdown,
    clearTimeout,
    console,
    document,
    isUnsupportedPlatformCoverVisible,
    resolveCaptureRecoveryView,
    setTimeout,
    showMessage,
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

  function setRecoveryCopy(elementId, value) {
    const element = document.getElementById(elementId);
    if (!element) return;
    const text = String(value || "").trim();
    if (element.textContent !== text) {
      element.textContent = text;
    }
    const shouldHide = !text;
    if (element.hidden !== shouldHide) {
      element.hidden = shouldHide;
    }
  }

  function isRecoveryActionAvailable(button) {
    return Boolean(
      button &&
        !button.hidden &&
        !button.disabled &&
        button.style.display !== "none",
    );
  }

  function handoffRecoveryFocus({
    previousActiveElement,
    progressContainer,
    btnRetry,
    btnDismiss,
    btnCancel,
  }) {
    const recoveryActions = [btnRetry, btnDismiss, btnCancel].filter(Boolean);
    if (!recoveryActions.includes(previousActiveElement)) return;
    if (isRecoveryActionAvailable(previousActiveElement)) return;

    const nextAction = [btnRetry, btnDismiss, btnCancel].find(
      isRecoveryActionAvailable,
    );
    const nextFocus = nextAction || progressContainer;
    try {
      nextFocus?.focus({preventScroll: true});
    } catch {
      nextFocus?.focus();
    }
  }

  function resetCaptureRecoveryUI({hidePanel = false, clearState = true} = {}) {
    if (controllerState.captureRecoveryFreshnessTimer) {
      clearTimeout(controllerState.captureRecoveryFreshnessTimer);
      controllerState.captureRecoveryFreshnessTimer = null;
    }
    const progressContainer = document.getElementById("progressContainer");
    if (progressContainer) {
      if (
        hidePanel &&
        progressContainer.dataset.progressSource === "capture-recovery"
      ) {
        progressContainer.style.display = "none";
        delete progressContainer.dataset.progressSource;
      }
      delete progressContainer.dataset.recoveryPinned;
      delete progressContainer.dataset.recoveryCancelable;
      delete progressContainer.dataset.recordId;
      delete progressContainer.dataset.captureRequestId;
      delete progressContainer.dataset.recoveryAnnouncementKey;
    }

    setRecoveryCopy("progressBadge", "");
    setRecoveryCopy("progressReason", "");
    setRecoveryCopy("progressNextStep", "");

    for (const id of ["btnRetryRecovery", "btnDismissRecovery"]) {
      const button = document.getElementById(id);
      if (button) {
        button.hidden = true;
        button.disabled = false;
      }
    }

    const btnCancel = document.getElementById("btnCancel");
    if (btnCancel) {
      btnCancel.hidden = false;
      btnCancel.textContent = "中止任务";
      btnCancel.disabled = false;
    }

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

    const progressContainer = document.getElementById("progressContainer");
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    if (!progressContainer || !progressBar || !progressText) {
      return false;
    }
    if (progressContainer.dataset.progressSource === "keyword-plan") {
      clearKeywordPlanProgressCountdown();
    }

    const tone = ["info", "success", "warning", "error", "danger"].includes(
      view.tone,
    )
      ? view.tone
      : "info";
    const announcementKey = buildCaptureRecoveryAnnouncementKey(view);
    const shouldUpdateAnnouncement =
      progressContainer.dataset.recoveryAnnouncementKey !== announcementKey;
    const previousActiveElement = document.activeElement;
    progressContainer.dataset.progressSource = "capture-recovery";
    progressContainer.dataset.recoveryPinned = view.pinned ? "true" : "false";
    progressContainer.dataset.recoveryCancelable = view.showCancel
      ? "true"
      : "false";
    if (view.recordId) {
      progressContainer.dataset.recordId = view.recordId;
    } else {
      delete progressContainer.dataset.recordId;
    }
    if (view.captureRequestId) {
      progressContainer.dataset.captureRequestId = view.captureRequestId;
    } else {
      delete progressContainer.dataset.captureRequestId;
    }
    progressContainer.style.display = "block";

    const btnRetry = document.getElementById("btnRetryRecovery");
    const btnDismiss = document.getElementById("btnDismissRecovery");
    const btnCancel = document.getElementById("btnCancel");
    if (shouldUpdateAnnouncement) {
      progressContainer.dataset.recoveryAnnouncementKey = announcementKey;
      progressBar.className = `status-bar capture-recovery-status is-${tone}`;
      if (progressText.textContent !== view.title) {
        progressText.textContent = view.title;
      }
      progressText.hidden = false;
      setRecoveryCopy("progressBadge", view.statusLabel);
      setRecoveryCopy("progressReason", view.detail);
      setRecoveryCopy("progressNextStep", view.nextStep);

      if (btnRetry) {
        btnRetry.hidden = !view.showRetry;
        btnRetry.disabled = !view.showRetry;
        btnRetry.textContent = view.retryLabel || "继续当前项";
      }
      if (btnDismiss) {
        btnDismiss.hidden = !view.showDismiss;
        btnDismiss.disabled = false;
        btnDismiss.textContent = view.dismissLabel || "保留结果";
      }
      if (btnCancel) {
        btnCancel.hidden = !view.showCancel;
        btnCancel.style.display = view.showCancel ? "inline-flex" : "none";
        btnCancel.disabled = false;
        btnCancel.textContent = view.cancelLabel || "取消并保留";
      }
      handoffRecoveryFocus({
        previousActiveElement,
        progressContainer,
        btnRetry,
        btnDismiss,
        btnCancel,
      });
    }

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
    const progressContainer = document.getElementById("progressContainer");
    const recordId = String(
      controllerState.activeRecoveryProgress?.recordId ||
        progressContainer?.dataset.recordId ||
        "",
    ).trim();
    if (!recordId) {
      showMessage("当前提示没有可继续的评论记录，请从记录卡片重试", "warning");
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
    setRecoveryCopy,
    isRecoveryActionAvailable,
    handoffRecoveryFocus,
    resetCaptureRecoveryUI,
    renderCaptureRecoveryUI,
    handleRetryRecovery,
    handleDismissRecovery,
  });
}
