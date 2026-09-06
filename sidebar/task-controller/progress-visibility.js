// Application cleanup remains outside the legacy progress presentation.
export function createProgressVisibilityController({controllerState, controllerPorts, controllerOperations}) {
  function showProgress(message, showUI = true) {
    controllerPorts.taskView.clearKeywordPlanCountdownForCaptureProgress();
    controllerOperations.resetCaptureRecoveryUI({hidePanel: false, clearState: true});
    const showPanel = Boolean(showUI) &&
      !controllerPorts.taskView.isUnsupportedPlatformCoverVisible();
    controllerPorts.taskView.showCaptureProgressPresentation({
      message,
      showPanel,
      // The legacy view reads this only after its captured container has been
      // marked as capture-owned, exactly where the old host read it.
      readActiveUnattendedRunRequestId: () => controllerState.activeUnattendedRunRequestId,
    });
  }

  function hideProgressPanelOnly({
    force = false,
    preserveUnattendedTerminalState = false,
  } = {}) {
    const wasRecovery = controllerPorts.taskView.hideCaptureProgressPresentation({
      force,
      preserveUnattendedTerminalState,
    });
    if (wasRecovery) {
      controllerOperations.resetCaptureRecoveryUI({hidePanel: false, clearState: true});
    }
  }

  return Object.freeze({showProgress, hideProgressPanelOnly});
}
