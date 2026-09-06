// L1: cleanup responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const {
      chrome,
      console,
      relayToContentWithRetry,
      resolveCaptureTaskTabId,
      setTimeout,
      taskRuntimeApi,
      writeRuntimeState,
    } = ports;


    async function closeCaptureTaskWorkerTabs(workerTabIds = []) {
      return await taskRuntimeApi.closeWorkerTabsIndividually(
        workerTabIds,
        {
          removeTab: (tabId) => chrome.tabs.remove(tabId),
        },
      );
    }

    async function closeTrackedCaptureTaskWorkerTabs(taskId, workerTabIds = []) {
      try {
        const result = await closeCaptureTaskWorkerTabs(workerTabIds);
        state.captureTaskPendingWorkerTabIds.delete(taskId);
        return result;
      } catch (error) {
        const failedTabIds = Array.isArray(error?.failedTabIds)
          ? error.failedTabIds
          : workerTabIds;
        state.captureTaskPendingWorkerTabIds.set(taskId, failedTabIds);
        throw error;
      }
    }

    function getTrackedCaptureTaskWorkers(taskId, ...snapshots) {
      return taskRuntimeApi.collectWorkerTabIds(
        ...snapshots,
        {
          workerTabIds: state.captureTaskPendingWorkerTabIds.get(taskId) || [],
        },
      );
    }

    function replaceTrackedCaptureTaskWorkerTab(
      taskId,
      removedTabId,
      addedTabId,
    ) {
      const pending = state.captureTaskPendingWorkerTabIds.get(taskId);
      if (!pending?.length || !pending.includes(removedTabId)) return false;
      state.captureTaskPendingWorkerTabIds.set(
        taskId,
        Array.from(
          new Set(
            pending.map((tabId) =>
              Number(tabId) === Number(removedTabId) ? Number(addedTabId) : tabId,
            ),
          ),
        ),
      );
      return true;
    }

    function buildCaptureTaskWorkerSnapshot(taskId, debugSnapshot, groupSnapshot) {
      return {
        ...(groupSnapshot || {}),
        workerTabIds: getTrackedCaptureTaskWorkers(
          taskId,
          debugSnapshot,
          groupSnapshot,
        ),
      };
    }

    function reportCaptureTaskCancellationPublishError(error, stage) {
      console.warn(
        `[CaptureTask] cancellation ${stage} failed; cleanup continues:`,
        error,
      );
    }

    async function writeCaptureTaskCancellationFailSoft(cancellation, patch) {
      return await taskRuntimeApi.publishCancellationFailSoft({
        cancellation,
        notify: (value) => {
          state.captureTaskOwnerCoordinator?.notifyCanceled(value.taskId, value);
        },
        writeState: writeRuntimeState,
        patch,
        onError: reportCaptureTaskCancellationPublishError,
      });
    }

    async function clearCaptureTaskTraceOverlayFailSoft({
      taskId = '',
      tabId = null,
    } = {}) {
      const normalizedTabId = resolveCaptureTaskTabId(tabId);
      if (!normalizedTabId) return false;
      try {
        const response = await chrome.tabs.sendMessage(normalizedTabId, {
          action: 'setCaptureTaskTakeover',
          taskId: String(taskId || '').trim(),
          active: false,
          clearTrace: true,
          label: '采集辅助运行中',
        });
        return response?.ok !== false;
      } catch (error) {
        console.debug(
          '[CaptureTask] page trace cleanup unavailable (ignored):',
          error?.message || error,
        );
        return false;
      }
    }

    function buildCaptureTaskCancellation(taskId, reason) {
      return {
        taskId: String(taskId || '').trim(),
        reason: String(reason || 'capture_task_canceled').trim(),
        requestedAt: new Date().toISOString(),
      };
    }

    async function publishCaptureTaskCancellation(taskId, reason) {
      const cancellation = buildCaptureTaskCancellation(taskId, reason);
      await writeCaptureTaskCancellationFailSoft(cancellation, {
        captureTaskCancellation: cancellation,
        lastCaptureProgress: {
          phase: 'canceled',
          message:
            cancellation.reason === 'sidebar_owner_disconnected'
              ? '控制面板已关闭，采集任务已安全停止'
              : '浏览器采集辅助已取消，整项采集正在停止',
          captureTaskId: cancellation.taskId,
          updatedAt: cancellation.requestedAt,
        },
      });
      return cancellation;
    }

    async function relayCaptureTaskCancellation(session, reason) {
      if (!session) return [];
      const cancelListRunId = session.persistent
        ? session.activeListRunId
        : session.runId;
      const cancelPayload = {
        action: 'cancelCapture',
        debugDetachReason: reason,
        ...(cancelListRunId ? {listCaptureRunId: cancelListRunId} : {}),
      };
      const targetTabIds = [
        session.tabId,
        ...(Array.isArray(session.workerTabIds) ? session.workerTabIds : []),
      ]
        .map((tabId) => resolveCaptureTaskTabId(tabId))
        .filter(Boolean);
      return await Promise.allSettled(
        [...new Set(targetTabIds)].map((tabId) =>
          Promise.race([
            relayToContentWithRetry(tabId, cancelPayload),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('capture task cancel relay timeout')),
                1500,
              ),
            ),
          ]),
        ),
      );
    }

    async function releaseCaptureTaskResources({
      taskId,
      reason,
      debugSnapshot = null,
    } = {}) {
      const activeDebugSnapshot =
        debugSnapshot || state.captureDebugSessionManager.getSessionByTaskId(taskId);
      const groupSnapshot = state.captureTaskTabGroupManager.getTask(taskId);
      const workerSnapshot = buildCaptureTaskWorkerSnapshot(
        taskId,
        activeDebugSnapshot,
        groupSnapshot,
      );
      const cleanupSnapshot = {
        ...(groupSnapshot || {}),
        ...(activeDebugSnapshot || {}),
        taskId,
        persistent: true,
        tabId:
          resolveCaptureTaskTabId(
            activeDebugSnapshot?.tabId,
            groupSnapshot?.sourceTabId,
          ) || null,
        sourceTabId:
          resolveCaptureTaskTabId(
            activeDebugSnapshot?.sourceTabId,
            activeDebugSnapshot?.tabId,
            groupSnapshot?.sourceTabId,
          ) || null,
        workerTabIds: workerSnapshot.workerTabIds,
        state: 'detaching',
        cleanupPending: true,
        cleanupReason: String(reason || 'capture_task_finished').trim(),
      };
      state.captureTaskCleanupInProgress.add(taskId);
      if (activeDebugSnapshot || groupSnapshot || workerSnapshot.workerTabIds.length > 0) {
        await writeRuntimeState({captureDebugSession: cleanupSnapshot}).catch(
          (error) => {
            console.warn(
              '[CaptureTask] failed to persist cleanup ownership snapshot:',
              error,
            );
          },
        );
      }
      await clearCaptureTaskTraceOverlayFailSoft({
        taskId,
        tabId: cleanupSnapshot.sourceTabId,
      });

      try {
        const result = await taskRuntimeApi.endTaskResources({
          taskId,
          reason,
          debugSnapshot: activeDebugSnapshot,
          groupSnapshot: workerSnapshot,
          stopDebug: ({taskId: activeTaskId, reason: stopReason}) =>
            state.captureDebugSessionManager.stopByTaskId(activeTaskId, stopReason),
          endGroup: ({taskId: activeTaskId, reason: stopReason}) =>
            state.captureTaskTabGroupManager.end({
              taskId: activeTaskId,
              reason: stopReason,
            }),
          closeWorkerTabs: (workerTabIds) =>
            closeTrackedCaptureTaskWorkerTabs(taskId, workerTabIds),
        });
        state.captureTaskPendingWorkerTabIds.delete(taskId);
        state.captureTaskOwnerCoordinator?.clearTask(taskId);
        await writeRuntimeState({captureDebugSession: null}).catch((error) => {
          console.warn('[CaptureTask] failed to clear cleanup snapshot:', error);
        });
        return result;
      } finally {
        state.captureTaskCleanupInProgress.delete(taskId);
      }
    }

    async function releaseCaptureTaskResourcesWithRetry(
      options,
      {attempts = 2, retryDelayMs = 250} = {},
    ) {
      const maxAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
      let lastError = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await releaseCaptureTaskResources(options);
        } catch (error) {
          lastError = error;
          if (attempt + 1 < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      }
      throw lastError;
    }

    return Object.freeze({
      closeCaptureTaskWorkerTabs,
      closeTrackedCaptureTaskWorkerTabs,
      getTrackedCaptureTaskWorkers,
      replaceTrackedCaptureTaskWorkerTab,
      buildCaptureTaskWorkerSnapshot,
      reportCaptureTaskCancellationPublishError,
      writeCaptureTaskCancellationFailSoft,
      clearCaptureTaskTraceOverlayFailSoft,
      buildCaptureTaskCancellation,
      publishCaptureTaskCancellation,
      relayCaptureTaskCancellation,
      releaseCaptureTaskResources,
      releaseCaptureTaskResourcesWithRetry,
    });
  }
  root.OnStarvoiceCaptureLifecycleCleanup = Object.freeze({create});
})(globalThis);
