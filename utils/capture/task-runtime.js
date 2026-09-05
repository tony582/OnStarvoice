(function installCaptureTaskRuntime(root, factory) {
  const api = factory();
  if (typeof module === "object" && module?.exports) {
    module.exports = api;
  }
  root.OnStarvoiceCaptureTaskRuntime = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function createCaptureTaskRuntimeApi() {
    function normalizeTabId(value) {
      const tabId = Number(value);
      return Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null;
    }

    function collectWorkerTabIds(...snapshots) {
      const workerTabIds = [];
      for (const snapshot of snapshots) {
        if (!Array.isArray(snapshot?.workerTabIds)) continue;
        for (const candidate of snapshot.workerTabIds) {
          const tabId = normalizeTabId(candidate);
          if (tabId) workerTabIds.push(tabId);
        }
      }
      return Array.from(new Set(workerTabIds));
    }

    function debugOwnershipReleased(result) {
      return Boolean(
        result?.released === true || result?.reason === "not_attached",
      );
    }

    function isBenignTabRemovalError(error) {
      const message = String(error?.message || error || "");
      return /no tab with id|not found|does not exist|invalid tab id/iu.test(
        message,
      );
    }

    async function closeWorkerTabsIndividually(
      workerTabIds,
      {removeTab, attempts = 2, retryDelayMs = 120, wait = null} = {},
    ) {
      if (typeof removeTab !== "function") {
        throw new TypeError("removeTab must be a function");
      }
      const normalizedTabIds = collectWorkerTabIds({workerTabIds});
      const waitForRetry =
        typeof wait === "function"
          ? wait
          : (delayMs) =>
              new Promise((resolve) => setTimeout(resolve, delayMs));
      const maxAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
      const settled = await Promise.allSettled(
        normalizedTabIds.map(async (tabId) => {
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            try {
              await removeTab(tabId);
              return {tabId, closed: true};
            } catch (error) {
              if (isBenignTabRemovalError(error)) {
                return {tabId, closed: false, alreadyMissing: true};
              }
              if (attempt + 1 >= maxAttempts) {
                const failure = new Error(
                  `无法关闭采集工作页 ${tabId}: ${String(
                    error?.message || error,
                  )}`,
                );
                failure.cause = error;
                failure.tabId = tabId;
                throw failure;
              }
              await waitForRetry(retryDelayMs);
            }
          }
          return {tabId, closed: false};
        }),
      );
      const failedTabIds = settled
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason?.tabId)
        .filter(Boolean);
      if (failedTabIds.length > 0) {
        const error = new Error("部分采集工作页仍未关闭，请重试停止任务");
        error.code = "capture_worker_close_failed";
        error.failedTabIds = failedTabIds;
        throw error;
      }
      return settled.map((result) => result.value);
    }

    async function publishCancellationFailSoft({
      cancellation,
      notify = null,
      writeState,
      patch,
      onError = null,
    } = {}) {
      if (typeof notify === "function") {
        try {
          notify(cancellation);
        } catch (error) {
          if (typeof onError === "function") onError(error, "notify");
        }
      }
      if (typeof writeState !== "function") {
        return {published: false, cancellation, reason: "writer_unavailable"};
      }
      try {
        await writeState(patch);
        return {published: true, cancellation};
      } catch (error) {
        if (typeof onError === "function") onError(error, "storage");
        return {
          published: false,
          cancellation,
          reason: "storage_write_failed",
          error,
        };
      }
    }

    /**
     * Release one capture task in an order that keeps native Debug ownership
     * authoritative. Worker ids are snapshotted before any await. Workers are
     * closed while the native task group still owns them, so a close failure
     * leaves enough ownership state for a later retry instead of orphaning a
     * live detail page after the group has already been released.
     */
    async function endTaskResources({
      taskId,
      reason = "capture_task_finished",
      debugSnapshot = null,
      groupSnapshot = null,
      stopDebug,
      endGroup,
      closeWorkerTabs,
    } = {}) {
      if (typeof stopDebug !== "function") {
        throw new TypeError("stopDebug must be a function");
      }
      if (typeof endGroup !== "function") {
        throw new TypeError("endGroup must be a function");
      }
      if (typeof closeWorkerTabs !== "function") {
        throw new TypeError("closeWorkerTabs must be a function");
      }

      const workerTabIds = collectWorkerTabIds(
        debugSnapshot,
        groupSnapshot,
      );
      let debugResult = null;
      let groupResult = null;
      let debugReleased = false;

      debugResult = await stopDebug({taskId, reason});
      debugReleased = debugOwnershipReleased(debugResult);
      if (!debugReleased) {
        const error = new Error(
          "采集辅助仍处于活动状态，原生标签组暂不释放",
        );
        error.code = "capture_task_debug_not_released";
        error.result = debugResult;
        throw error;
      }

      if (workerTabIds.length > 0) {
        await closeWorkerTabs(workerTabIds);
      }

      groupResult = await endGroup({taskId, reason});
      return {
        taskId,
        debug: debugResult,
        group: groupResult,
        workerTabIds,
      };
    }

    return Object.freeze({
      collectWorkerTabIds,
      debugOwnershipReleased,
      closeWorkerTabsIndividually,
      publishCancellationFailSoft,
      endTaskResources,
    });
  },
);
