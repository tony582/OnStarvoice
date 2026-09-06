// These legacy presentation hints are not task identity or command authority.
// DOM references remain private, including references kept across helper calls.
export function createLegacyProgressVisibilityView({
  document,
  clearKeywordPlanProgressCountdown,
  setCaptureButtonsDisabled,
}) {
  function clearKeywordPlanCountdownForCaptureProgress() {
    if (
      document.getElementById("progressContainer")?.dataset.progressSource ===
      "keyword-plan"
    ) {
      clearKeywordPlanProgressCountdown();
    }
  }

  function showCaptureProgressPresentation({message, showPanel, readActiveUnattendedRunRequestId}) {
    const progressContainer = document.getElementById("progressContainer");
    if (progressContainer) {
      progressContainer.dataset.progressSource = "capture";
      if (readActiveUnattendedRunRequestId()) {
        progressContainer.dataset.unattendedProgressState = "running";
      } else {
        delete progressContainer.dataset.unattendedProgressState;
      }
      progressContainer.style.display = showPanel ? "block" : "none";
    }

    const progressText = document.getElementById("progressText");
    const progressBar = document.getElementById("progressBar");
    if (progressText && showPanel) {
      progressText.textContent = message;
      if (progressBar) {
        progressBar.className = "status-bar capture-recovery-status is-info";
      }
    }

    setCaptureButtonsDisabled(true);

    const btnCancel = document.getElementById("btnCancel");
    if (btnCancel && showPanel) {
      btnCancel.hidden = false;
      btnCancel.disabled = false;
      btnCancel.style.display = "inline-block";
    } else if (btnCancel) {
      btnCancel.style.display = "none";
    }
  }

  function hideCaptureProgressPresentation({force, preserveUnattendedTerminalState}) {
    const progressContainer = document.getElementById("progressContainer");
    if (
      !force &&
      progressContainer?.dataset.progressSource === "capture-recovery" &&
      progressContainer?.dataset.recoveryPinned === "true"
    ) {
      return false;
    }
    const wasRecovery =
      progressContainer?.dataset.progressSource === "capture-recovery";
    const keepUnattendedTerminalState = Boolean(
      preserveUnattendedTerminalState ||
        progressContainer?.dataset?.unattendedProgressState === "terminal",
    );
    if (progressContainer) {
      progressContainer.style.display = "none";
      delete progressContainer.dataset.progressSource;
      if (!keepUnattendedTerminalState) {
        delete progressContainer.dataset.unattendedProgressState;
      }
    }

    const btnCancel = document.getElementById("btnCancel");
    if (btnCancel) {
      btnCancel.hidden = true;
      btnCancel.disabled = true;
      btnCancel.style.display = "none";
    }
    return wasRecovery;
  }

  return Object.freeze({
    clearKeywordPlanCountdownForCaptureProgress,
    showCaptureProgressPresentation,
    hideCaptureProgressPresentation,
  });
}
