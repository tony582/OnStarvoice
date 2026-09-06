// L1: leases responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const {
      CAPTURE_TASK_REPLACEMENT_TAB_TTL_MS,
      resolveCaptureTaskTabId,
    } = ports;


    function pruneCaptureTaskReplacementTabs(now = Date.now()) {
      for (const [tabId, replacement] of state.captureTaskReplacementTabIds) {
        if (Number(replacement?.expiresAt) <= now) {
          state.captureTaskReplacementTabIds.delete(tabId);
        }
      }
    }

    function rememberCaptureTaskReplacementTab({
      removedTabId,
      addedTabId,
      taskId,
      attemptId = '',
    } = {}) {
      const oldTabId = resolveCaptureTaskTabId(removedTabId);
      const newTabId = resolveCaptureTaskTabId(addedTabId);
      const normalizedTaskId = String(taskId || '').trim();
      if (!oldTabId || !newTabId || !normalizedTaskId) return false;
      pruneCaptureTaskReplacementTabs();
      state.captureTaskReplacementTabIds.set(oldTabId, {
        tabId: newTabId,
        taskId: normalizedTaskId,
        attemptId: String(attemptId || '').trim(),
        expiresAt: Date.now() + CAPTURE_TASK_REPLACEMENT_TAB_TTL_MS,
      });
      return true;
    }

    function resolveCaptureTaskReplacementLease(
      tabId,
      {taskId = '', attemptId = ''} = {},
    ) {
      const originalTabId = resolveCaptureTaskTabId(tabId);
      const requestedTaskId = String(taskId || '').trim();
      const requestedAttemptId = String(attemptId || '').trim();
      if (!originalTabId) return null;
      pruneCaptureTaskReplacementTabs();

      let replacementTabId = originalTabId;
      let replacementTaskId = requestedTaskId;
      let replacementAttemptId = requestedAttemptId;
      const visited = new Set([originalTabId]);
      for (let depth = 0; depth < 8; depth += 1) {
        const replacement = state.captureTaskReplacementTabIds.get(replacementTabId);
        if (!replacement) break;
        if (
          replacementTaskId &&
          replacement.taskId !== replacementTaskId
        ) {
          return null;
        }
        if (
          replacementAttemptId &&
          String(replacement.attemptId || '').trim() !== replacementAttemptId
        ) {
          return null;
        }
        replacementTaskId = replacementTaskId || replacement.taskId;
        replacementAttemptId =
          replacementAttemptId || String(replacement.attemptId || '').trim();
        replacementTabId = resolveCaptureTaskTabId(replacement.tabId);
        if (!replacementTabId || visited.has(replacementTabId)) return null;
        visited.add(replacementTabId);
      }
      if (replacementTabId === originalTabId || !replacementTaskId) return null;

      return {
        tabId: replacementTabId,
        taskId: replacementTaskId,
        attemptId: replacementAttemptId,
      };
    }

    function resolveCaptureTaskReplacementTab(tabId, taskId = '') {
      const replacement = resolveCaptureTaskReplacementLease(tabId, {taskId});
      if (!replacement) return null;

      const group = state.captureTaskTabGroupManager?.getTask(replacement.taskId);
      if (
        !group ||
        (
          Number(group.sourceTabId) !== replacement.tabId &&
          !group.workerTabIds?.includes(replacement.tabId)
        )
      ) {
        return null;
      }
      return replacement;
    }

    return Object.freeze({
      pruneCaptureTaskReplacementTabs,
      rememberCaptureTaskReplacementTab,
      resolveCaptureTaskReplacementLease,
      resolveCaptureTaskReplacementTab,
    });
  }
  root.OnStarvoiceCaptureLifecycleLeases = Object.freeze({create});
})(globalThis);
