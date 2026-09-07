// L1: admission responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const strictPending = () => ({ok: false, accepted: false, released: false,
      resourcesReleased: false, cleanupPending: true, releasedTaskIds: [],
      protectedTasks: [{reason: 'strict_capture_control_retained'}],
      reason: 'strict_capture_control_retained'});
    const strictRetained = async () => {
      if (typeof ports.hasStrictCaptureStopControl !== 'function') return false;
      try { return await ports.hasStrictCaptureStopControl() !== false; } catch { return true; }
    };
    const {
      STORAGE_KEYS,
      TASK_LEDGER_STALE_ACTIVE_MS,
      chrome,
      console,
      getUnattendedTaskCenterCore,
      isUnattendedRunRequestActive,
      readActiveCaptureExecutionLock,
      resolveCaptureTaskTabId,
      setTimeout,
      taskRunActivityAt,
    } = ports;
    const releaseCaptureTaskResourcesWithRetry = (...args) => operations.releaseCaptureTaskResourcesWithRetry(...args);

    function createCaptureTaskError(code, message, details = null) {
      const error = new Error(message);
      error.code = code;
      if (details && typeof details === 'object' && !Array.isArray(details)) {
        error.details = details;
      }
      return error;
    }

    function createCaptureTaskDebugOwnershipError(ownership = {}) {
      const kind = String(ownership?.kind || '').trim();
      const messages = {
        starvoice_active:
          '当前 Agent 已有 StarVoice 采集会话运行，本任务将交给其他空闲 Agent',
        external_debugger:
          '当前页面正被 DevTools 或外部调试器占用，本任务将交给其他空闲 Agent',
        unknown_occupancy:
          '当前 Agent 无法确认浏览器调试占用来源，本任务将交给其他空闲 Agent',
      };
      return createCaptureTaskError(
        String(ownership?.code || 'capture_task_debug_ownership_unknown'),
        messages[kind] || messages.unknown_occupancy,
        {
          debugOwnership: kind || 'unknown_occupancy',
          retryable: ownership?.retryable !== false,
          automaticReroute: ownership?.automaticReroute !== false,
          safeToDetach: false,
          ...(Number.isSafeInteger(Number(ownership?.tabId))
            ? {tabId: Number(ownership.tabId)}
            : {}),
          ...(String(ownership?.taskId || '').trim()
            ? {ownerTaskId: String(ownership.taskId).trim()}
            : {}),
          ...(String(ownership?.state || '').trim()
            ? {ownerState: String(ownership.state).trim()}
            : {}),
          ...(String(ownership?.reason || '').trim()
            ? {reason: String(ownership.reason).trim().slice(0, 320)}
            : {}),
        },
      );
    }

    function getCaptureTaskRequest(message) {
      const payload =
        message?.payload && typeof message.payload === 'object'
          ? message.payload
          : {};
      return {...message, ...payload};
    }

    function requireCaptureTaskId(request) {
      const taskId = String(request?.taskId || '').trim();
      if (!taskId) {
        throw createCaptureTaskError(
          'invalid_capture_task',
          '采集任务缺少 taskId',
        );
      }
      return taskId;
    }

    async function requireConnectedCaptureTaskOwner(
      taskId,
      {attempts = 8, delayMs = 50} = {},
    ) {
      const normalizedTaskId = String(taskId || '').trim();
      const maxAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const owner = state.captureTaskOwnerCoordinator?.getOwner(normalizedTaskId);
        if (owner?.connected === true) return owner;
        if (attempt + 1 < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      throw createCaptureTaskError(
        'capture_task_owner_disconnected',
        '控制面板未连接，已取消启动采集任务',
      );
    }

    function isRecentActiveCaptureTaskLedgerRun(run, now = Date.now()) {
      const status = String(run?.status || '').trim().toLowerCase();
      if (!new Set(['pending', 'running', 'recovering']).has(status)) {
        return false;
      }
      const activityAt = taskRunActivityAt(run);
      return Boolean(
        activityAt && now - activityAt < TASK_LEDGER_STALE_ACTIVE_MS,
      );
    }

    async function inspectCaptureTaskGroupLiveness(group) {
      const taskId = String(group?.taskId || '').trim();
      if (!taskId) {
        return {active: true, reason: 'invalid_task_group'};
      }
      if (state.captureTaskCleanupInProgress.has(taskId)) {
        return {active: true, reason: 'cleanup_in_progress'};
      }

      const debugSession = state.captureDebugSessionManager.getSessionByTaskId(taskId);
      const debugSessionState = String(debugSession?.state || '')
        .trim()
        .toLowerCase();
      // A detached persistent snapshot exists only so ordered cleanup can still
      // find its task/workers. It is not proof that capture is alive. Continue
      // through the ledger/request/owner/lock checks so a terminal task can be
      // reclaimed instead of blocking every later begin forever.
      if (debugSession && debugSessionState !== 'detached') {
        return {active: true, reason: 'debug_session', debugSession};
      }

      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.taskLedger,
        STORAGE_KEYS.unattendedKeywordRunRequest,
      ]);
      const core = getUnattendedTaskCenterCore();
      const now = Date.now();
      const ledger = core?.normalizeTaskLedger
        ? core.normalizeTaskLedger(stored[STORAGE_KEYS.taskLedger], {now})
        : stored[STORAGE_KEYS.taskLedger];
      const ledgerRun = Array.isArray(ledger?.runs)
        ? ledger.runs.find((run) => String(run?.id || '').trim() === taskId)
        : null;
      const ledgerStatus = String(ledgerRun?.status || '').trim().toLowerCase();
      const ledgerTerminal = Boolean(
        ledgerRun &&
          (core?.isTerminalTaskStatus?.(ledgerStatus) ||
            new Set([
              'completed',
              'completed_with_warnings',
              'completed_with_failures',
              'failed',
              'canceled',
              'cancelled',
              'skipped',
              'needs_action',
            ]).has(ledgerStatus)),
      );
      if (isRecentActiveCaptureTaskLedgerRun(ledgerRun, now)) {
        return {active: true, reason: 'task_ledger', ledgerRun};
      }

      const unattendedRequest =
        stored[STORAGE_KEYS.unattendedKeywordRunRequest] &&
        typeof stored[STORAGE_KEYS.unattendedKeywordRunRequest] === 'object'
          ? stored[STORAGE_KEYS.unattendedKeywordRunRequest]
          : null;
      if (
        String(unattendedRequest?.id || '').trim() === taskId &&
        (await isUnattendedRunRequestActive(unattendedRequest))
      ) {
        return {
          active: true,
          reason: 'unattended_run_request',
          unattendedRequest,
        };
      }

      // A connected sidebar can briefly survive after its task has already written
      // a terminal tombstone. In that state the owner is cleanup residue, not proof
      // that capture is still running. Without a terminal record, fail closed and
      // keep the owner-owned group intact.
      const owner = state.captureTaskOwnerCoordinator?.getOwner(taskId);
      if (
        !ledgerTerminal &&
        (owner?.connected === true || owner?.abandoning === true)
      ) {
        return {active: true, reason: 'task_owner', owner};
      }

      const activeLock = await readActiveCaptureExecutionLock();
      const groupTabIds = new Set(
        [
          group?.sourceTabId,
          ...(Array.isArray(group?.workerTabIds) ? group.workerTabIds : []),
        ]
          .map((tabId) => resolveCaptureTaskTabId(tabId))
          .filter(Boolean),
      );
      if (
        activeLock &&
        (activeLock.captureTaskId === taskId ||
          (!activeLock.captureTaskId &&
            groupTabIds.has(resolveCaptureTaskTabId(activeLock.holderTabId))))
      ) {
        return {active: true, reason: 'execution_lock', activeLock};
      }

      return {
        active: false,
        reason: 'confirmed_stale',
        debugSession,
        ledgerRun,
      };
    }

    async function releaseConfirmedStaleCaptureTaskGroupsForBegin() {
      if (await strictRetained()) return strictPending();
      const releasedTaskIds = [];
      const protectedTasks = [];
      const candidatesByTaskId = new Map(
        state.captureTaskTabGroupManager
          .getActiveTasks()
          .map((group) => [String(group?.taskId || '').trim(), group]),
      );
      for (const session of state.captureDebugSessionManager.getActiveSessions()) {
        const taskId = String(session?.taskId || '').trim();
        if (!session?.persistent || !taskId || candidatesByTaskId.has(taskId)) {
          continue;
        }
        candidatesByTaskId.set(taskId, {
          taskId,
          sourceTabId: resolveCaptureTaskTabId(session.sourceTabId, session.tabId),
          workerTabIds: Array.isArray(session.workerTabIds)
            ? session.workerTabIds
            : [],
          groupId: session.groupId ?? null,
          originalGroupId: session.originalGroupId ?? null,
        });
      }
      const candidates = [...candidatesByTaskId.values()].filter(
        (candidate) => String(candidate?.taskId || '').trim(),
      );
      for (const group of candidates) {
        const liveness = await inspectCaptureTaskGroupLiveness(group);
        if (await strictRetained()) return strictPending();
        if (liveness.active) {
          protectedTasks.push({
            taskId: group.taskId,
            reason: liveness.reason,
          });
          continue;
        }

        try {
          await releaseCaptureTaskResourcesWithRetry(
            {
              taskId: group.taskId,
              reason: 'stale_capture_task_recovered',
              debugSnapshot: liveness.debugSession,
            },
            {attempts: 3},
          );
          if (await strictRetained()) return strictPending();
          releasedTaskIds.push(group.taskId);
        } catch (error) {
          if (await strictRetained()) return strictPending();
          console.warn(
            '[CaptureTask] confirmed stale group cleanup remains pending:',
            {
              taskId: group.taskId,
              error: String(error?.message || error || ''),
            },
          );
          protectedTasks.push({
            taskId: group.taskId,
            reason: 'cleanup_failed',
          });
        }
      }
      return {releasedTaskIds, protectedTasks};
    }

    return Object.freeze({
      createCaptureTaskError,
      createCaptureTaskDebugOwnershipError,
      getCaptureTaskRequest,
      requireCaptureTaskId,
      requireConnectedCaptureTaskOwner,
      isRecentActiveCaptureTaskLedgerRun,
      inspectCaptureTaskGroupLiveness,
      releaseConfirmedStaleCaptureTaskGroupsForBegin,
    });
  }
  root.OnStarvoiceCaptureLifecycleAdmission = Object.freeze({create});
})(globalThis);
