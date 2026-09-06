// L1: progress responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const {
      chrome,
      console,
      resolveCaptureTaskTabId,
      taskTabGroupApi,
    } = ports;
    const createCaptureTaskError = (...args) => operations.createCaptureTaskError(...args);
    const getCaptureTaskRequest = (...args) => operations.getCaptureTaskRequest(...args);
    const inspectUnattendedCaptureTaskAttempt = (...args) => operations.inspectUnattendedCaptureTaskAttempt(...args);
    const requireCaptureTaskId = (...args) => operations.requireCaptureTaskId(...args);

    async function updateCaptureTask(message) {
      const request = getCaptureTaskRequest(message);
      const taskId = requireCaptureTaskId(request);
      const attemptFence = await inspectUnattendedCaptureTaskAttempt({
        taskId,
        attemptId: request.attemptId,
      });
      if (attemptFence.unattended && !attemptFence.current) {
        return {
          taskId,
          ignored: true,
          reason: 'stale_unattended_attempt',
        };
      }
      const update = {taskId};
      for (const field of ['progress', 'label', 'minimized']) {
        if (Object.prototype.hasOwnProperty.call(request, field)) {
          update[field] = request[field];
        }
      }
      const session = await state.captureDebugSessionManager.updateTask(update);
      const sourceTabId = resolveCaptureTaskTabId(
        session?.sourceTabId,
        session?.tabId,
      );
      if (
        sourceTabId &&
        session?.state === 'attached' &&
        Object.prototype.hasOwnProperty.call(update, 'progress')
      ) {
        chrome.tabs
          .sendMessage(sourceTabId, {
            action: 'setCaptureTaskTakeover',
            taskId,
            active: true,
            label: String(session?.label || '采集辅助运行中'),
            progress: session?.progress || update.progress || {},
          })
          .catch((error) => {
            console.debug(
              '[CaptureTask] page progress overlay unavailable (ignored):',
              error?.message || error,
            );
          });
      }
      return {taskId, session};
    }

    async function registerCaptureTaskTab(message, sender) {
      const request = getCaptureTaskRequest(message);
      const taskId = requireCaptureTaskId(request);
      const attemptFence = await inspectUnattendedCaptureTaskAttempt({
        taskId,
        attemptId: request.attemptId,
      });
      if (attemptFence.unattended && !attemptFence.current) {
        return {
          taskId,
          ignored: true,
          reason: 'stale_unattended_attempt',
        };
      }
      const role = taskTabGroupApi.normalizeTaskTabRole(
        request.role,
      );
      if (!role) {
        throw createCaptureTaskError(
          'invalid_capture_task_tab_role',
          '采集工作页角色仅支持 worker 或 detail_worker',
        );
      }
      const workerTabId = resolveCaptureTaskTabId(
        request.workerTabId,
        request.tabId,
        sender?.tab?.id,
      );
      if (!workerTabId) {
        throw createCaptureTaskError(
          'invalid_capture_worker_tab',
          '采集任务缺少有效的工作 Tab',
        );
      }
      if (!state.captureDebugSessionManager.getSessionByTaskId(taskId)) {
        throw createCaptureTaskError(
          'capture_task_not_found',
          '没有找到正在运行的持久采集任务',
        );
      }

      const group = await state.captureTaskTabGroupManager.register({
        taskId,
        tabId: workerTabId,
        role,
      });
      let session;
      try {
        session = await state.captureDebugSessionManager.registerWorkerTab({
          taskId,
          tabId: workerTabId,
          groupId: group.groupId,
        });
      } catch (error) {
        await state.captureTaskTabGroupManager.unregister({
          taskId,
          tabId: workerTabId,
        }).catch(() => null);
        throw error;
      }
      return {taskId, role, session, group};
    }

    async function setCaptureTaskMinimized(message) {
      const request = getCaptureTaskRequest(message);
      const taskId = requireCaptureTaskId(request);
      const session = await state.captureDebugSessionManager.setMinimized({
        taskId,
        minimized: Boolean(request.minimized),
      });
      return {taskId, session};
    }

    return Object.freeze({
      updateCaptureTask,
      registerCaptureTaskTab,
      setCaptureTaskMinimized,
    });
  }
  root.OnStarvoiceCaptureLifecycleProgress = Object.freeze({create});
})(globalThis);
