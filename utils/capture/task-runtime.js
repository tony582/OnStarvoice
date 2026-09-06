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

    function snapshotStrictResourceExpectation(value, taskId) {
      const fields = [
        "version", "taskId", "attemptId", "runId", "debug", "group",
        "owner", "runtime", "workerTabIds",
      ];
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const expected = {};
      try {
        for (const key of fields) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
          expected[key] = descriptor.value;
        }
        const workersLength = Array.isArray(expected.workerTabIds)
          ? Object.getOwnPropertyDescriptor(expected.workerTabIds, "length")
          : null;
        if (!workersLength || workersLength.value !== 0) return null;
      } catch {
        return null;
      }
      if (
        expected.version !== 1 ||
        !["taskId", "attemptId", "runId"].every((key) =>
          typeof expected[key] === "string" && expected[key].trim() === expected[key] &&
          expected[key].length > 0,
        ) ||
        expected.taskId !== taskId ||
        expected.debug !== null || expected.group !== null ||
        expected.owner !== null || expected.runtime !== null
      ) return null;
      return Object.freeze({...expected, workerTabIds: Object.freeze([])});
    }

    // A pure, task-scoped resource observation, not permission to mutate or a
    // lease spanning awaits, and not proof that every page has no collection.
    // Native detach/ungroup/remove have no atomic document identity condition.
    function inspectStrictResourceAbsence({
      taskId,
      strictResources,
      debugSnapshot,
      groupSnapshot,
      ownerSnapshot,
      runtimeSnapshot,
      pendingWorkerTabIds,
      cleanupInProgress,
    } = {}) {
      const reject = (reason) => ({
        observed: false, released: false, rejected: true,
        strict: true, mutated: false, reason,
      });
      const expected = snapshotStrictResourceExpectation(strictResources, taskId);
      if (!expected) return reject("strict_resource_identity_invalid");
      if (
        !runtimeSnapshot || typeof runtimeSnapshot !== "object" ||
        Array.isArray(runtimeSnapshot) || !Array.isArray(pendingWorkerTabIds) ||
        typeof cleanupInProgress !== "boolean" ||
        debugSnapshot === undefined || groupSnapshot === undefined ||
        ownerSnapshot === undefined
      ) return reject("strict_resource_inspection_unavailable");
      let runtimeSession;
      try {
        runtimeSession = Object.getOwnPropertyDescriptor(runtimeSnapshot, "captureDebugSession");
      } catch {
        return reject("strict_resource_inspection_unavailable");
      }
      if (!runtimeSession || !Object.hasOwn(runtimeSession, "value") ||
          runtimeSession.value === undefined) {
        return reject("strict_resource_inspection_unavailable");
      }
      if (
        debugSnapshot !== null || groupSnapshot !== null || ownerSnapshot !== null ||
        runtimeSession.value !== null ||
        pendingWorkerTabIds.length !== 0 || cleanupInProgress
      ) return reject("strict_active_resource_cleanup_unavailable");
      return {
        observed: true, released: false, rejected: false,
        strict: true, mutated: false, reason: "strict_resources_absent",
        taskId, attemptId: expected.attemptId, runId: expected.runId,
      };
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
      if (Object.hasOwn(arguments[1] || {}, "strictResources")) {
        return {released: false, rejected: true, strict: true, mutated: false,
          reason: "strict_document_bound_tab_removal_unavailable"};
      }
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
      if (Object.hasOwn(arguments[0] || {}, "strictResources")) {
        return {released: false, rejected: true, strict: true, mutated: false,
          reason: "strict_active_resource_cleanup_unavailable"};
      }
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
      snapshotStrictResourceExpectation,
      inspectStrictResourceAbsence,
      closeWorkerTabsIndividually,
      publishCancellationFailSoft,
      endTaskResources,
    });
  },
);
