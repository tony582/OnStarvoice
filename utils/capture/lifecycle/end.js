// L1: end responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const strictPending = () => ({ok: false, accepted: false, released: false,
      resourcesReleased: false, cleanupPending: true, ignored: true,
      reason: 'strict_capture_control_retained'});
    const strictRetained = async () => {
      if (typeof ports.hasStrictCaptureStopControl !== 'function') return false;
      try { return await ports.hasStrictCaptureStopControl() !== false; } catch { return true; }
    };
    const {
      console,
      inspectTargetedPostCaptureTaskAttempt,
      resolveCaptureTaskTabId,
      terminalizeCaptureTaskLedgerRun,
      upsertTaskLedgerRun,
    } = ports;
    const clearCaptureTaskTraceOverlayFailSoft = (...args) => operations.clearCaptureTaskTraceOverlayFailSoft(...args);
    const getCaptureTaskRequest = (...args) => operations.getCaptureTaskRequest(...args);
    const getTrackedCaptureTaskWorkers = (...args) => operations.getTrackedCaptureTaskWorkers(...args);
    const inspectStableUnattendedCaptureTask = (...args) => operations.inspectStableUnattendedCaptureTask(...args);
    const inspectUnattendedCaptureTaskAttempt = (...args) => operations.inspectUnattendedCaptureTaskAttempt(...args);
    const publishCaptureTaskCancellation = (...args) => operations.publishCaptureTaskCancellation(...args);
    const recoverUnattendedCaptureTaskInterruption = (...args) => operations.recoverUnattendedCaptureTaskInterruption(...args);
    const relayCaptureTaskCancellation = (...args) => operations.relayCaptureTaskCancellation(...args);
    const releaseCaptureTaskResourcesWithRetry = (...args) => operations.releaseCaptureTaskResourcesWithRetry(...args);
    const releaseStableUnattendedCaptureTaskResourcesOnly = (...args) => operations.releaseStableUnattendedCaptureTaskResourcesOnly(...args);
    const requireCaptureTaskId = (...args) => operations.requireCaptureTaskId(...args);
    const runCaptureTaskLifecycleOperation = (...args) => operations.runCaptureTaskLifecycleOperation(...args);

    async function endCaptureTask(message) {
      if (await strictRetained()) return strictPending();
      // BEGIN and END share one lifecycle queue. In particular, a replacement
      // attempt cannot create new Debug/group ownership after an older END has
      // passed its attempt fence but before that END finishes its final cleanup.
      return await runCaptureTaskLifecycleOperation(
        () => performEndCaptureTask(message),
      );
    }

    async function performEndCaptureTask(message) {
      if (await strictRetained()) return strictPending();
      const request = getCaptureTaskRequest(message);
      const taskId = requireCaptureTaskId(request);
      const attemptFence = await inspectUnattendedCaptureTaskAttempt({
        taskId,
        attemptId: request.attemptId,
      });
      if (attemptFence.unattended && !attemptFence.current) {
        return {
          taskId,
          released: false,
          ignored: true,
          reason: 'stale_unattended_attempt',
        };
      }
      const targetedAttempt = attemptFence.unattended
        ? {targeted: false, current: false}
        : await inspectTargetedPostCaptureTaskAttempt({
            taskId,
            attemptId: request.attemptId,
          });
      if (await strictRetained()) return strictPending();
      if (targetedAttempt.targeted && !targetedAttempt.current) {
        return {
          taskId,
          released: false,
          ignored: true,
          reason: 'stale_targeted_post_attempt',
        };
      }
      const reason =
        String(request.reason || '').trim() || 'capture_task_finished';
      const status = String(request.status || '').trim().toLowerCase();
      const canceled =
        status === 'canceled' ||
        /(?:^|_)(?:cancel|canceled|cancelled)(?:_|$)/u.test(reason) ||
        reason === 'user_cancel_requested';
      if (canceled) {
        const session = state.captureDebugSessionManager.getSessionByTaskId(taskId);
        await publishCaptureTaskCancellation(taskId, reason);
        if (await strictRetained()) return strictPending();
        await relayCaptureTaskCancellation(session, reason);
      }
      if (await strictRetained()) return strictPending();
      const result = await releaseCaptureTaskResourcesWithRetry({taskId, reason});
      if (await strictRetained()) return strictPending();
      const terminalStatus = status || (canceled ? 'canceled' : 'completed');
      if (terminalStatus === 'recovering') {
        // 无人值守 request root 是唯一公开任务台账；其 Debug wrapper 只管理
        // 浏览器资源。不要再凭 unattended-capture:<id> 创建第二条 recovering
        // 记录，否则作品级进度会和关键词级 counts 混在一起。
        if (!attemptFence.unattended) {
          if (targetedAttempt.current) return result;
          const now = new Date().toISOString();
          await upsertTaskLedgerRun({
            patch: {
              id: taskId,
              status: 'recovering',
              message: '正在重建浏览器采集上下文',
              updatedAt: now,
              businessProgressAt: now,
              finishedAt: '',
              error: null,
              progress: {
                phase: 'recovering',
                message: '正在重建浏览器采集上下文 · 1/1',
                captureTaskId: taskId,
                updatedAt: now,
              },
            },
            event: {
              type: 'task_recovering',
              status: 'recovering',
              message: '旧采集上下文已释放，正在创建新工作页',
            },
          });
        }
        return result;
      }
      // The targeted request root is the sole public task-ledger authority. Its
      // native Debug END only releases tabs/Debug ownership; detail capture can
      // finish before sync, so terminalizing here would absorb a later real sync
      // failure as an update to an already-terminal task-center record.
      if (!attemptFence.unattended && !targetedAttempt.current) {
        await terminalizeCaptureTaskLedgerRun(taskId, {
          reason,
          status: terminalStatus,
          message:
            terminalStatus === 'completed'
              ? '采集任务已完成'
              : terminalStatus === 'skipped'
                ? '采集任务已跳过'
                : terminalStatus === 'completed_with_failures'
                  ? '采集任务已完成，部分内容处理失败'
                  : terminalStatus === 'failed'
                    ? '采集任务执行失败'
                    : '采集任务已停止',
        });
      }
      return result;
    }

    async function handleUnexpectedCaptureDebugDetach({session, reason} = {}) {
      if (await strictRetained()) return strictPending();
      if (!session) return;
      if (!session.persistent || !session.taskId) {
        // Legacy transient assist sessions are observational as well. Losing
        // chrome.debugger must never manufacture a user cancellation for the
        // content-script collection already in progress.
        console.warn(
          '[CaptureAssist] transient assist detached; page capture continues',
          {
            tabId: resolveCaptureTaskTabId(session.tabId),
            reason: String(reason || '').trim() || 'debugger_detached',
          },
        );
        return;
      }
      // Debug/DevTools is only a capture assist. Losing it must not cancel,
      // recover, reassign, or terminalize the authoritative content-script task.
      // The execution lock and task attempt fence remain active independently.
      await clearCaptureTaskTraceOverlayFailSoft({
        tabId: session.tabId,
        taskId: session.taskId,
      });
      console.warn('[CaptureAssist] detached; page capture continues', {
        taskId: session.taskId,
        tabId: session.tabId,
        reason: String(reason || '').trim() || 'debugger_detached',
      });
    }

    async function handleAbandonedCaptureTask({taskId} = {}) {
      if (await strictRetained()) return strictPending();
      const normalizedTaskId = String(taskId || '').trim();
      if (!normalizedTaskId) return;
      const stableUnattended = await inspectStableUnattendedCaptureTask(
        normalizedTaskId,
      );
      if (await strictRetained()) return strictPending();
      if (stableUnattended.active) {
        const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
          taskId: normalizedTaskId,
          reason: 'runner_owner_disconnected',
        });
        if (await strictRetained()) return strictPending();
        if (unattendedRecovery.handled) return;
      }
      if (stableUnattended.unattended) {
        await releaseStableUnattendedCaptureTaskResourcesOnly(stableUnattended, {
          reason: 'sidebar_owner_disconnected',
        });
        return;
      }
      const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
        taskId: normalizedTaskId,
        reason: 'runner_owner_disconnected',
      });
      if (await strictRetained()) return strictPending();
      if (unattendedRecovery.handled) return;
      const session = state.captureDebugSessionManager.getSessionByTaskId(normalizedTaskId);
      const group = state.captureTaskTabGroupManager.getTask(normalizedTaskId);
      const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(normalizedTaskId);
      if (!session && !group && pendingWorkerTabIds.length === 0) {
        await terminalizeCaptureTaskLedgerRun(normalizedTaskId, {
          reason: 'sidebar_owner_disconnected',
          message: '控制面板已关闭，采集任务已停止',
        });
        return;
      }

      await publishCaptureTaskCancellation(
        normalizedTaskId,
        'sidebar_owner_disconnected',
      );
      if (await strictRetained()) return strictPending();
      await terminalizeCaptureTaskLedgerRun(normalizedTaskId, {
        reason: 'sidebar_owner_disconnected',
        message: '控制面板已关闭，采集任务已停止',
      });
      if (await strictRetained()) return strictPending();
      await relayCaptureTaskCancellation(session, 'sidebar_owner_disconnected');
      if (await strictRetained()) return strictPending();
      try {
        await releaseCaptureTaskResourcesWithRetry(
          {
            taskId: normalizedTaskId,
            reason: 'sidebar_owner_disconnected',
            debugSnapshot: session,
          },
          {attempts: 3},
        );
      } catch (error) {
        console.warn(
          '[CaptureTaskOwner] failed to finish abandoned capture task:',
          error,
        );
      }
    }

    return Object.freeze({
      endCaptureTask,
      performEndCaptureTask,
      handleUnexpectedCaptureDebugDetach,
      handleAbandonedCaptureTask,
    });
  }
  root.OnStarvoiceCaptureLifecycleEnd = Object.freeze({create});
})(globalThis);
