// Legacy progress/recovery presentation owns DOM nodes and focus transitions.
// Controllers receive only scalar queries and frozen semantic sessions.
export function createLegacyCaptureProgressView({
  document,
  buildCaptureRecoveryAnnouncementKey,
  getKeywordSortDimensionLabel,
  normalizeKeywordSortDimension,
  ERROR_MESSAGE_MAP,
  showMessage,
}) {
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

  function resetCaptureRecoveryPresentation({hidePanel = false} = {}) {
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
  }

  function openCaptureRecoveryPresentation() {
    const progressContainer = document.getElementById("progressContainer");
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    if (!progressContainer || !progressBar || !progressText) {
      return null;
    }
    return Object.freeze({
      isKeywordPlanPresentation: () =>
        progressContainer.dataset.progressSource === "keyword-plan",
      render(view) {
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
      },
    });
  }

  function openCaptureProgressPresentation() {
    const progressContainer = document.getElementById("progressContainer");
    return Object.freeze({
      hasPanel: Boolean(progressContainer),
      readUnattendedState: () => progressContainer?.dataset?.unattendedProgressState,
      isKeywordPlanPresentation: () => progressContainer?.dataset.progressSource === "keyword-plan",
      isRecoveryPresentation: () => progressContainer?.dataset.progressSource === "capture-recovery",
      isRecoveryCancelable: () => progressContainer?.dataset.recoveryCancelable === "true",
      readRecoveryRequestId: () => progressContainer?.dataset.captureRequestId,
      readRecoveryRecordId: () => progressContainer?.dataset.recordId,
      markUnattendedTerminal() {
        progressContainer.dataset.unattendedProgressState = "terminal";
      },
      markUnattendedRunning() {
        progressContainer.dataset.unattendedProgressState = "running";
      },
      useCaptureSource() {
        progressContainer.dataset.progressSource = "capture";
      },
      hideCaptureProgress() {
        progressContainer.style.display = "none";
      },
      showCaptureProgress() {
        progressContainer.style.display = "block";
      },
      isPanelHidden: () => progressContainer.style.display === "none",
      showCancelActionIfPanelVisible() {
        const btnCancel = document.getElementById("btnCancel");
        if (btnCancel && progressContainer?.style.display !== "none") {
          btnCancel.hidden = false;
          btnCancel.disabled = false;
          btnCancel.textContent = "中止任务";
          btnCancel.style.display = "inline-flex";
        }
      },
      openMessagePresentation() {
        const progressText = document.getElementById("progressText");
        const progressBar = document.getElementById("progressBar");
        return Object.freeze({
          render(nextMessage) {
            if (progressText && nextMessage) {
              progressText.textContent = nextMessage;
              if (progressBar) {
                progressBar.className = "status-bar is-info";
              }
            }
          },
        });
      },
      openRuntimeMessagePresentation() {
        const progressText = document.getElementById("progressText");
        if (!progressContainer || !progressText) {
          return null;
        }
        return Object.freeze({
          render(nextMessage) {
            progressText.textContent = nextMessage;
            const btnCancel = document.getElementById("btnCancel");
            if (btnCancel) {
              btnCancel.hidden = false;
              btnCancel.disabled = false;
              btnCancel.textContent = "中止任务";
              btnCancel.style.display = "inline-flex";
            }
            const progressBar = document.getElementById("progressBar");
            if (progressBar) {
              progressBar.className = "status-bar is-info";
            }
          },
        });
      },
    });
  }

  function buildCaptureProgressText(progress) {
    const message = String(progress?.message || "").trim();
    const detectedCount = normalizeProgressCount(progress?.detectedCount);
    const filteredCount = normalizeProgressCount(progress?.filteredCount);
    const minLikes = normalizeProgressCount(progress?.minLikes);
    const sortDimension = normalizeKeywordSortDimension(progress?.sortDimension);
    const sortLabel = getKeywordSortDimensionLabel(sortDimension);
    const maxDetectedItems = normalizeProgressCount(
      progress?.maxDetectedItems ?? progress?.maxItems,
    );
    const markedCount = normalizeProgressCount(progress?.markedCount);

    if (detectedCount === null || filteredCount === null) {
      if (markedCount === null) {
        return message;
      }
      const markedText = `页面已标记 ${markedCount} 条`;
      return message ? `${message} · ${markedText}` : markedText;
    }

    const detailParts = [];
    if (minLikes !== null) {
      detailParts.push(`${sortLabel}≥${minLikes}`);
    }
    if (maxDetectedItems !== null) {
      detailParts.push(`探测上限 ${maxDetectedItems}`);
    }

    const statsText = `已探测 ${detectedCount} 条，已筛选 ${filteredCount} 条${
      markedCount !== null ? `，页面已标记 ${markedCount} 条` : ""
    }${detailParts.length > 0 ? `（${detailParts.join("，")}）` : ""}`;

    if (!message) {
      return statsText;
    }
    return `${message} · ${statsText}`;
  }

  function normalizeProgressCount(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return null;
    }
    return Math.max(0, Math.floor(num));
  }

  function showEmptyCaptureResult(result) {
    const payload = result.captureResult?.data || {};
    const detectedCount = Number(payload.rawTotalCount || 0);
    const filteredBeforeLimitCount = Number(payload.filteredBeforeLimitCount || 0);
    const minLikes = Number(payload.minLikes || 0);
    const sortDimension = normalizeKeywordSortDimension(payload.sortDimension);
    const sortLabel = getKeywordSortDimensionLabel(sortDimension);
    if (detectedCount > 0 && filteredBeforeLimitCount <= 0) {
      showMessage(
        `已探测 ${detectedCount} 条，但按${sortLabel}阈值（≥${minLikes}）筛选后为 0 条，请降低筛选阈值后重试`,
        "warning",
      );
    } else {
      showMessage(
        "采集完成，但未获取到可入池数据（可能因筛选条件过高或当前页暂无结果）",
        "warning",
      );
    }
  }

  function showCaptureSuccess(message) {
    showMessage(message, "success");
  }

  function showCaptureActionError(result) {
    const rawErrorCode = String(result.error?.code || "").trim();
    const rawErrorMessage = String(result.error?.message || "").trim();
    const errorMsg =
      (rawErrorCode === "UNEXPECTED_ERROR" && rawErrorMessage) ||
      ERROR_MESSAGE_MAP[rawErrorCode] ||
      rawErrorMessage ||
      "采集失败";
    showMessage(errorMsg, "error");
  }

  function showCaptureActionException(error) {
    showMessage("操作失败: " + error.message, "error");
  }

  function showMissingRecoveryRecordNotice() {
    showMessage("当前提示没有可继续的评论记录，请从记录卡片重试", "warning");
  }

  function readCaptureCancelingMessage() {
    return "正在取消当前任务并保存可用结果…";
  }

  function showCaptureCancelSignalFailure() {
    showMessage("取消请求发送失败，请检查网络后再试", "error");
  }

  function showPersistentCaptureReleaseWarning() {
    showMessage("采集取消信号已发送，但采集辅助仍在释放，请再点一次停止", "warning");
  }

  function showCaptureCancelPending() {
    showMessage("正在取消...", "info");
  }

  return Object.freeze({
    resetCaptureRecoveryPresentation,
    openCaptureRecoveryPresentation,
    openCaptureProgressPresentation,
    buildCaptureProgressText,
    normalizeProgressCount,
    showEmptyCaptureResult,
    showCaptureSuccess,
    showCaptureActionError,
    showCaptureActionException,
    showMissingRecoveryRecordNotice,
    readCaptureCancelingMessage,
    showCaptureCancelSignalFailure,
    showPersistentCaptureReleaseWarning,
    showCaptureCancelPending,
  });
}
