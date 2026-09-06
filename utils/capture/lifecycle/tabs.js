// L1: tabs responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const {
      STORAGE_KEYS,
      chrome,
      console,
      detectPlatformFromUrl,
      isTerminalUnattendedRunStatus,
      normalizeCaptureExecutionLock,
      normalizePlatformId,
      persistUnattendedRunMutation,
      readUnattendedKeywordRunRequest,
      resolveCaptureTaskTabId,
      runCaptureExecutionLockOperation,
      runUnattendedRunMutation,
      terminalizeCaptureTaskLedgerRun,
      waitForTabReady,
    } = ports;
    const clearCaptureTaskTraceOverlayFailSoft = (...args) => operations.clearCaptureTaskTraceOverlayFailSoft(...args);
    const createCaptureTaskError = (...args) => operations.createCaptureTaskError(...args);
    const getTrackedCaptureTaskWorkers = (...args) => operations.getTrackedCaptureTaskWorkers(...args);
    const inspectStableUnattendedCaptureTask = (...args) => operations.inspectStableUnattendedCaptureTask(...args);
    const publishCaptureTaskCancellation = (...args) => operations.publishCaptureTaskCancellation(...args);
    const recoverUnattendedCaptureTaskInterruption = (...args) => operations.recoverUnattendedCaptureTaskInterruption(...args);
    const relayCaptureTaskCancellation = (...args) => operations.relayCaptureTaskCancellation(...args);
    const releaseCaptureTaskResourcesWithRetry = (...args) => operations.releaseCaptureTaskResourcesWithRetry(...args);
    const releaseStableUnattendedCaptureTaskResourcesOnly = (...args) => operations.releaseStableUnattendedCaptureTaskResourcesOnly(...args);
    const rememberCaptureTaskReplacementTab = (...args) => operations.rememberCaptureTaskReplacementTab(...args);
    const replaceTrackedCaptureTaskWorkerTab = (...args) => operations.replaceTrackedCaptureTaskWorkerTab(...args);

    async function replaceCaptureExecutionLockTabId(removedTabId, addedTabId) {
      return await runCaptureExecutionLockOperation(async () => {
        const stored = await chrome.storage.local.get(
          STORAGE_KEYS.captureExecutionLock,
        );
        const lock = normalizeCaptureExecutionLock(
          stored[STORAGE_KEYS.captureExecutionLock],
          {allowExpired: true},
        );
        if (!lock || Number(lock.holderTabId) !== Number(removedTabId)) {
          return false;
        }
        await chrome.storage.local.set({
          [STORAGE_KEYS.captureExecutionLock]: {
            ...lock,
            holderTabId: Number(addedTabId),
            updatedAt: new Date().toISOString(),
          },
        });
        return true;
      });
    }

    async function replaceUnattendedRunnerTabId(removedTabId, addedTabId) {
      return await runUnattendedRunMutation(async () => {
        const request = await readUnattendedKeywordRunRequest();
        if (
          !request ||
          isTerminalUnattendedRunStatus(request.status) ||
          Number(request.runnerTabId) !== Number(removedTabId)
        ) {
          return false;
        }
        const now = new Date().toISOString();
        const nextRequest = {
          ...request,
          runnerTabId: Number(addedTabId),
          updatedAt: now,
        };
        await persistUnattendedRunMutation(nextRequest, {
          previousRequest: request,
          event: {
            type: 'runner_replaced',
            message: '浏览器已替换运行页，任务继续执行',
            at: now,
          },
        });
        return true;
      });
    }

    async function handleCaptureRuntimeTabReplaced(addedTabId, removedTabId) {
      const normalizedAddedTabId = resolveCaptureTaskTabId(addedTabId);
      const normalizedRemovedTabId = resolveCaptureTaskTabId(removedTabId);
      if (!normalizedAddedTabId || !normalizedRemovedTabId) return false;

      const previousDebugSession =
        state.captureDebugSessionManager.getSession(normalizedRemovedTabId);
      const previousGroup = state.captureTaskTabGroupManager
        .getActiveTasks()
        .find(
          (group) =>
            Number(group?.sourceTabId) === normalizedRemovedTabId ||
            group?.workerTabIds?.includes(normalizedRemovedTabId),
        );
      const pendingBegin =
        state.captureTaskBeginInFlight &&
        resolveCaptureTaskTabId(state.captureTaskBeginInFlight.sourceTabId) ===
          normalizedRemovedTabId
          ? state.captureTaskBeginInFlight
          : null;
      const taskId = String(
        previousDebugSession?.taskId ||
          previousGroup?.taskId ||
          pendingBegin?.taskId ||
          '',
      ).trim();
      const attemptId = String(
        previousDebugSession?.attemptId || pendingBegin?.attemptId || '',
      ).trim();
      const replacementRole =
        Number(previousGroup?.sourceTabId) === normalizedRemovedTabId
          ? 'source'
          : previousGroup?.workerTabIds?.includes(normalizedRemovedTabId)
            ? 'worker'
            : previousDebugSession?.persistent
              ? 'source'
              : pendingBegin
                ? 'source'
                : '';

      if (!taskId) {
        const unattendedRequest = await readUnattendedKeywordRunRequest();
        const replacesUnattendedRunner = Boolean(
          unattendedRequest &&
            !isTerminalUnattendedRunStatus(unattendedRequest.status) &&
            Number(unattendedRequest.runnerTabId) === normalizedRemovedTabId,
        );
        if (!replacesUnattendedRunner) return false;
        const expectedPlatform = normalizePlatformId(
          unattendedRequest?.planSnapshot?.platform || unattendedRequest?.platform,
        );
        let replacementTab;
        try {
          replacementTab = await waitForTabReady(normalizedAddedTabId, {
            timeoutMs: 10000,
            pollMs: 100,
          });
        } catch {
          return false;
        }
        if (
          expectedPlatform === 'unknown' ||
          String(replacementTab?.status || '').trim().toLowerCase() !== 'complete' ||
          detectPlatformFromUrl(replacementTab?.url || '') !== expectedPlatform
        ) {
          return false;
        }
        await Promise.all([
          replaceCaptureExecutionLockTabId(
            normalizedRemovedTabId,
            normalizedAddedTabId,
          ),
          replaceUnattendedRunnerTabId(
            normalizedRemovedTabId,
            normalizedAddedTabId,
          ),
        ]);
        return false;
      }

      const failAuthoritativeReplacement = async (error) => {
        const message = `浏览器替换采集页面后任务迁移失败：${String(
          error?.message || error || '未知错误',
        )}`;
        const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
          taskId,
          reason: 'source_tab_replace_failed',
        });
        if (unattendedRecovery.handled) {
          return Boolean(unattendedRecovery.recovery?.recovered);
        }
        await publishCaptureTaskCancellation(
          taskId,
          'source_tab_replace_failed',
        );
        await terminalizeCaptureTaskLedgerRun(taskId, {
          reason: 'source_tab_replace_failed',
          message,
        });
        const latestSession =
          state.captureDebugSessionManager.getSessionByTaskId(taskId) ||
          previousDebugSession;
        await relayCaptureTaskCancellation(
          latestSession,
          'source_tab_replace_failed',
        );
        try {
          await releaseCaptureTaskResourcesWithRetry(
            {
              taskId,
              reason: 'source_tab_replace_failed',
              debugSnapshot: latestSession,
            },
            {attempts: 3},
          );
        } catch (cleanupError) {
          console.warn(
            '[CaptureTask] replaced-tab cleanup remains pending:',
            cleanupError,
          );
        }
        return false;
      };

      let replacementTab = null;
      try {
        replacementTab = await chrome.tabs.get(normalizedAddedTabId);
        if (
          replacementRole === 'source' &&
          String(replacementTab?.status || '').trim().toLowerCase() &&
          String(replacementTab?.status || '').trim().toLowerCase() !== 'complete'
        ) {
          replacementTab = await waitForTabReady(normalizedAddedTabId, {
            timeoutMs: 10000,
            pollMs: 100,
          });
        }
      } catch (error) {
        // Unlike Debug and native grouping, a missing replacement page means the
        // content-script execution target itself is gone. Keep the existing
        // unattended/manual recovery semantics for that authoritative failure.
        return await failAuthoritativeReplacement(error);
      }
      if (replacementRole === 'source') {
        const explicitExpectedPlatform = normalizePlatformId(
          previousDebugSession?.platform || pendingBegin?.platform,
        );
        const pageExpectedPlatform = detectPlatformFromUrl(
          previousDebugSession?.pageUrl || '',
        );
        const expectedPlatform =
          explicitExpectedPlatform !== 'unknown'
            ? explicitExpectedPlatform
            : pageExpectedPlatform;
        const replacementPlatform = detectPlatformFromUrl(
          replacementTab?.url || '',
        );
        const replacementPageSettled =
          String(replacementTab?.status || '').trim().toLowerCase() ===
          'complete';
        if (
          expectedPlatform === 'unknown' ||
          !replacementPageSettled ||
          replacementPlatform !== expectedPlatform
        ) {
          return await failAuthoritativeReplacement(
            createCaptureTaskError(
              !replacementPageSettled
                ? 'capture_task_replacement_unsettled'
                : replacementPlatform === 'unknown'
                ? 'capture_task_platform_unsupported'
                : 'capture_task_platform_mismatch',
              !replacementPageSettled
                ? '浏览器替换后的来源页面尚未稳定，未迁移采集任务'
                : replacementPlatform === 'unknown'
                ? '浏览器替换后的来源页面已离开支持的平台'
                : '浏览器替换后的来源页面与原任务平台不一致',
            ),
          );
        }
      }

      if (pendingBegin) {
        rememberCaptureTaskReplacementTab({
          removedTabId: normalizedRemovedTabId,
          addedTabId: normalizedAddedTabId,
          taskId,
          attemptId,
        });
        pendingBegin.sourceTabId = normalizedAddedTabId;
      }
      if (pendingBegin && !previousDebugSession && !previousGroup) {
        try {
          await Promise.all([
            replaceCaptureExecutionLockTabId(
              normalizedRemovedTabId,
              normalizedAddedTabId,
            ),
            replaceUnattendedRunnerTabId(
              normalizedRemovedTabId,
              normalizedAddedTabId,
            ),
          ]);
        } catch (error) {
          return await failAuthoritativeReplacement(error);
        }
        return true;
      }

      let groupResult = null;
      let groupMigrationError = null;
      if (previousGroup) {
        try {
          groupResult = await state.captureTaskTabGroupManager.replaceTab({
            removedTabId: normalizedRemovedTabId,
            addedTabId: normalizedAddedTabId,
          });
          if (groupResult?.replaced !== true) {
            throw createCaptureTaskError(
              'capture_task_replacement_not_rebound',
              '浏览器替换了采集页面，但任务标签组未能重新绑定',
            );
          }
        } catch (error) {
          groupMigrationError = error;
        }
      }

      let debugResult = null;
      let debugMigrationError = null;
      let debugAssistDegraded =
        String(previousDebugSession?.state || '').trim().toLowerCase() ===
        'detached';
      if (previousDebugSession && !debugAssistDegraded) {
        try {
          debugResult = await state.captureDebugSessionManager.replaceTab({
            removedTabId: normalizedRemovedTabId,
            addedTabId: normalizedAddedTabId,
            pageTitle: replacementTab?.title || '',
            pageUrl: replacementTab?.url || '',
          });
          if (debugResult?.replaced !== true) {
            throw createCaptureTaskError(
              'capture_task_replacement_not_rebound',
              '浏览器替换了采集页面，但采集辅助未能重新绑定',
            );
          }
        } catch (error) {
          debugMigrationError = error;
          debugAssistDegraded = true;
        }
      }

      const replacementWorkerTabIds = getTrackedCaptureTaskWorkers(
        taskId,
        previousDebugSession,
        previousGroup,
      ).map((tabId) =>
        Number(tabId) === normalizedRemovedTabId
          ? normalizedAddedTabId
          : Number(tabId),
      );

      if (groupMigrationError) {
        // Native grouping is organizational UI only. Forget the stale native
        // binding but retain every worker id for explicit END cleanup.
        const forgottenGroup =
          state.captureTaskTabGroupManager.forget(taskId)?.group || previousGroup;
        if (replacementWorkerTabIds.length > 0) {
          state.captureTaskPendingWorkerTabIds.set(
            taskId,
            Array.from(new Set(replacementWorkerTabIds)),
          );
        }
        if (
          replacementRole === 'source' &&
          forgottenGroup?.originalGroupId !== null &&
          forgottenGroup?.originalGroupId !== undefined &&
          Number.isSafeInteger(Number(forgottenGroup?.originalGroupId)) &&
          Number(forgottenGroup.originalGroupId) >= 0
        ) {
          await chrome.tabs
            .group({
              groupId: Number(forgottenGroup.originalGroupId),
              tabIds: [normalizedAddedTabId],
            })
            .catch(() =>
              chrome.tabs.ungroup([normalizedAddedTabId]).catch(() => null),
            );
        } else {
          await chrome.tabs.ungroup([normalizedAddedTabId]).catch(() => null);
        }
      }

      if (previousDebugSession && debugAssistDegraded) {
        try {
          debugResult = await state.captureDebugSessionManager.degradeTabReplacement({
            removedTabId: normalizedRemovedTabId,
            addedTabId: normalizedAddedTabId,
            pageTitle: replacementTab?.title || '',
            pageUrl: replacementTab?.url || '',
            groupId: groupMigrationError
              ? null
              : groupResult?.group?.groupId,
          });
        } catch (error) {
          console.warn(
            '[CaptureAssist] failed to persist replacement degradation; page capture continues:',
            error?.message || error,
          );
        }
      } else if (groupMigrationError && previousDebugSession) {
        await state.captureDebugSessionManager
          .updateTask({
            taskId,
            groupId: null,
            workerTabIds: replacementWorkerTabIds,
          })
          .catch((error) => {
            console.warn(
              '[CaptureAssist] failed to record native-group degradation:',
              error?.message || error,
            );
          });
      }

      if (
        replacementRole === 'worker' ||
        groupResult?.role === 'worker' ||
        debugResult?.role === 'worker'
      ) {
        replaceTrackedCaptureTaskWorkerTab(
          taskId,
          normalizedRemovedTabId,
          normalizedAddedTabId,
        );
      }

      try {
        await Promise.all([
          replaceCaptureExecutionLockTabId(
            normalizedRemovedTabId,
            normalizedAddedTabId,
          ),
          replaceUnattendedRunnerTabId(
            normalizedRemovedTabId,
            normalizedAddedTabId,
          ),
        ]);
      } catch (error) {
        return await failAuthoritativeReplacement(error);
      }

      rememberCaptureTaskReplacementTab({
        removedTabId: normalizedRemovedTabId,
        addedTabId: normalizedAddedTabId,
        taskId,
        attemptId,
      });

      if (debugAssistDegraded && replacementRole === 'source') {
        await clearCaptureTaskTraceOverlayFailSoft({
          taskId,
          tabId: normalizedAddedTabId,
        });
      }
      if (groupMigrationError || debugMigrationError) {
        console.warn('[CaptureAssist] replacement migration degraded; page capture continues', {
          taskId,
          removedTabId: normalizedRemovedTabId,
          addedTabId: normalizedAddedTabId,
          groupError: groupMigrationError?.message || '',
          debugError: debugMigrationError?.message || '',
        });
      }
      return true;
    }

    async function handleCaptureRuntimeTabRemoved(tabId) {
      const session = state.captureDebugSessionManager.getSession(tabId);
      if (session?.persistent && session.taskId) {
        const stableUnattended = await inspectStableUnattendedCaptureTask(
          session.taskId,
        );
        if (stableUnattended.active) {
          const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
            taskId: session.taskId,
            reason: 'source_tab_removed',
          });
          if (unattendedRecovery.handled) return;
        }
        if (stableUnattended.unattended) {
          await releaseStableUnattendedCaptureTaskResourcesOnly(
            stableUnattended,
            {
              reason: 'source_tab_removed',
              debugSnapshot: session,
            },
          );
          return;
        }
        await publishCaptureTaskCancellation(session.taskId, 'source_tab_removed');
        await terminalizeCaptureTaskLedgerRun(session.taskId, {
          reason: 'source_tab_removed',
          message: '采集来源页面已关闭，任务已停止',
        });
        await relayCaptureTaskCancellation(session, 'source_tab_removed');
        try {
          await releaseCaptureTaskResourcesWithRetry(
            {
              taskId: session.taskId,
              reason: 'source_tab_removed',
              debugSnapshot: session,
            },
            {attempts: 3},
          );
        } catch (error) {
          console.warn('[CaptureTask] source-tab cleanup remains pending:', error);
        }
        return;
      }
      await state.captureDebugSessionManager.handleTabRemoved(tabId);
      await state.captureTaskTabGroupManager.handleTabRemoved(tabId);
    }

    return Object.freeze({
      replaceCaptureExecutionLockTabId,
      replaceUnattendedRunnerTabId,
      handleCaptureRuntimeTabReplaced,
      handleCaptureRuntimeTabRemoved,
    });
  }
  root.OnStarvoiceCaptureLifecycleTabs = Object.freeze({create});
})(globalThis);
