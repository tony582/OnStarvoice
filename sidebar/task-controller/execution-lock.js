// L3-A execution-lock: original control flow, explicit state and compatibility ports.
export function createExecutionLockController({controllerState, controllerBindings, controllerPorts, controllerOperations}) {
  const {
    CAPTURE_EXECUTION_LOCK_HEARTBEAT_INTERVAL_MS,
    CAPTURE_EXECUTION_LOCK_HOLDER_ID,
    chrome,
    clearInterval,
    console,
    setCancelFlag,
    setInterval,
    setTimeout,
    showMessage,
  } = controllerPorts;
  const requestCaptureCancelSignal = (...args) => controllerOperations.requestCaptureCancelSignal(...args);

  async function acquireCaptureExecutionLock({
    owner = "manual",
    label = "采集任务",
  } = {}) {
    if (controllerState.captureExecutionLockReleasePendingId) {
      const released = await releaseCaptureExecutionLock(
        controllerState.captureExecutionLockReleasePendingId,
      );
      if (!released) {
        showMessage(
          "上一次采集已结束，但执行锁仍在清理中，请稍后重试",
          "warning",
        );
        return null;
      }
    }
    if (
      owner === "unattended_keyword_plan" &&
      controllerState.activeCaptureExecutionLockId &&
      controllerState.adoptedUnattendedCaptureExecutionLockId === controllerState.activeCaptureExecutionLockId
    ) {
      return await validateAdoptedUnattendedCaptureExecutionLock({
        lockId: controllerState.activeCaptureExecutionLockId,
        owner,
        label,
      });
    }
    try {
      let holderTabId = null;
      try {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        holderTabId = activeTab?.id ?? null;
      } catch {
        // MessageSender.tab/documentId 仍会由 background 作为可信持有者信息。
      }
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:acquire-capture-lock",
        owner,
        label,
        holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
        holderTabId,
      });
      if (response?.ok && response.data?.id) {
        controllerState.activeCaptureExecutionLockId = response.data.id;
        controllerState.adoptedUnattendedCaptureExecutionLockId = "";
        startCaptureExecutionLockHeartbeat(response.data.id, holderTabId);
        return response.data;
      }
      const activeLabel = response?.data?.label || "其他采集任务";
      showMessage(
        `${activeLabel}仍在运行，可能位于其他标签页；若长时间没有进度，底部会显示原因和取消入口`,
        "warning",
      );
      return null;
    } catch (error) {
      console.warn("[Sidebar] Acquire capture execution lock failed:", error);
      showMessage("无法确认采集任务状态，请刷新扩展后重试", "error");
      return null;
    }
  }

  function stopCaptureExecutionLockHeartbeat(lockId = "") {
    if (
      lockId &&
      controllerState.captureExecutionLockHeartbeatLockId &&
      controllerState.captureExecutionLockHeartbeatLockId !== lockId
    ) {
      return;
    }
    if (controllerState.captureExecutionLockHeartbeatTimer) {
      clearInterval(controllerState.captureExecutionLockHeartbeatTimer);
      controllerState.captureExecutionLockHeartbeatTimer = null;
    }
    controllerState.captureExecutionLockHeartbeatLockId = "";
    controllerState.captureExecutionLockHeartbeatInFlight = false;
    controllerState.captureExecutionLockInitialHolderTabId = null;
  }

  function resolveCaptureExecutionLockRunnerTabId(fallbackTabId = null) {
    const candidates = [
      controllerState.detailBatchRunnerTabId,
      controllerState.activeBatchRunnerTabId,
      controllerState.activeRecoveryRunnerTabId,
      controllerState.activeCommentsCaptureTabId,
      fallbackTabId,
      controllerState.captureExecutionLockInitialHolderTabId,
    ];
    for (const candidate of candidates) {
      const tabId = Number(candidate);
      if (Number.isFinite(tabId) && tabId > 0) {
        return tabId;
      }
    }
    return null;
  }

  function handleCaptureExecutionLockLost(lockId) {
    if (!lockId || controllerState.activeCaptureExecutionLockId !== lockId) {
      return;
    }
    const relayTabId = resolveCaptureExecutionLockRunnerTabId();
    stopCaptureExecutionLockHeartbeat(lockId);
    if (controllerState.adoptedUnattendedCaptureExecutionLockId === lockId) {
      controllerState.adoptedUnattendedCaptureExecutionLockId = "";
    }
    controllerState.activeCaptureExecutionLockId = "";
    if (controllerState.activeUnattendedRunRequestId) {
      controllerState.activeCaptureTaskCancellationReason = "capture_lock_lost";
    }
    setCancelFlag(true);
    controllerState.searchCaptureCancelRequested = true;
    controllerState.batchKeywordCancelRequested = true;
    controllerState.batchUrlCancelRequested = true;
    controllerState.detailBatchCancelRequested = true;
    if (!controllerState.activeUnattendedRunRequestId) {
      void requestCaptureCancelSignal(relayTabId).catch((error) => {
        console.warn("[Sidebar] Relay cancel after capture lock loss failed:", error);
      });
    }
    showMessage("采集任务锁已失效，本次任务正在停止，请重新启动", "error");
  }

  async function renewCaptureExecutionLock(lockId, holderTabId = null) {
    if (
      !lockId ||
      controllerState.activeCaptureExecutionLockId !== lockId ||
      controllerState.captureExecutionLockHeartbeatInFlight
    ) {
      return;
    }
    controllerState.captureExecutionLockHeartbeatInFlight = true;
    try {
      const currentRunnerTabId = resolveCaptureExecutionLockRunnerTabId(
        holderTabId,
      );
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:renew-capture-lock",
        lockId,
        holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
        holderTabId: currentRunnerTabId,
      });
      if (!response?.ok) {
        console.warn("[Sidebar] Capture execution lock renewal rejected:", {
          lockId,
          reason: response?.reason || "unknown",
        });
        handleCaptureExecutionLockLost(lockId);
      }
    } catch (error) {
      // service worker 被唤醒或短暂重启时保留本地任务，下一次心跳会重试；
      // 真正失联的锁会由 background 的租约期限回收。
      console.warn("[Sidebar] Renew capture execution lock failed:", error);
    } finally {
      controllerState.captureExecutionLockHeartbeatInFlight = false;
    }
  }

  function startCaptureExecutionLockHeartbeat(lockId, holderTabId = null) {
    stopCaptureExecutionLockHeartbeat();
    controllerState.captureExecutionLockHeartbeatLockId = lockId;
    const normalizedHolderTabId = Number(holderTabId);
    controllerState.captureExecutionLockInitialHolderTabId =
      Number.isFinite(normalizedHolderTabId) && normalizedHolderTabId > 0
        ? normalizedHolderTabId
        : null;
    controllerState.captureExecutionLockHeartbeatTimer = setInterval(() => {
      void renewCaptureExecutionLock(lockId);
    }, CAPTURE_EXECUTION_LOCK_HEARTBEAT_INTERVAL_MS);
  }

  async function validateAdoptedUnattendedCaptureExecutionLock({
    lockId,
    owner,
    label,
  }) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:renew-capture-lock",
        lockId,
        holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
        holderTabId: resolveCaptureExecutionLockRunnerTabId(),
      });
      if (
        !response?.ok ||
        controllerState.activeCaptureExecutionLockId !== lockId ||
        controllerState.adoptedUnattendedCaptureExecutionLockId !== lockId
      ) {
        handleCaptureExecutionLockLost(lockId);
        return null;
      }
      return {
        ...(response.data || {}),
        id: lockId,
        owner,
        label,
        holderTabId:
          response.data?.holderTabId ?? controllerState.captureExecutionLockInitialHolderTabId,
      };
    } catch (error) {
      console.warn("[Sidebar] Validate adopted capture lock failed:", error);
      handleCaptureExecutionLockLost(lockId);
      return null;
    }
  }

  function adoptUnattendedCaptureExecutionLock(lock = null) {
    const lockId = String(lock?.id || "").trim();
    if (!lockId) {
      return false;
    }
    controllerState.activeCaptureExecutionLockId = lockId;
    controllerState.adoptedUnattendedCaptureExecutionLockId = lockId;
    startCaptureExecutionLockHeartbeat(lockId, lock?.holderTabId);
    return true;
  }

  async function releaseCaptureExecutionLock(lockId = controllerState.activeCaptureExecutionLockId) {
    if (!lockId) {
      return false;
    }
    stopCaptureExecutionLockHeartbeat(lockId);
    let released = false;
    for (const delayMs of [0, 120, 360]) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        const response = await chrome.runtime.sendMessage({
          type: "onstarvoice:release-capture-lock",
          lockId,
          holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
        });
        if (response?.ok) {
          released = true;
          break;
        }
        console.warn("[Sidebar] Capture execution lock release rejected:", lockId);
      } catch (error) {
        console.warn("[Sidebar] Release capture execution lock failed:", error);
      }
    }

    if (released) {
      if (controllerState.adoptedUnattendedCaptureExecutionLockId === lockId) {
        controllerState.adoptedUnattendedCaptureExecutionLockId = "";
      }
      if (controllerState.activeCaptureExecutionLockId === lockId) {
        controllerState.activeCaptureExecutionLockId = "";
      }
      if (controllerState.captureExecutionLockReleasePendingId === lockId) {
        controllerState.captureExecutionLockReleasePendingId = "";
      }
    } else {
      controllerState.captureExecutionLockReleasePendingId = lockId;
    }
    return released;
  }

  return Object.freeze({
    acquireCaptureExecutionLock,
    stopCaptureExecutionLockHeartbeat,
    resolveCaptureExecutionLockRunnerTabId,
    handleCaptureExecutionLockLost,
    renewCaptureExecutionLock,
    startCaptureExecutionLockHeartbeat,
    validateAdoptedUnattendedCaptureExecutionLock,
    adoptUnattendedCaptureExecutionLock,
    releaseCaptureExecutionLock,
  });
}
