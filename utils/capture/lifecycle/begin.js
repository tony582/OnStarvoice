// L1: begin responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const {
      CAPTURE_TASK_GROUP_TITLE,
      bindCaptureExecutionLockToTask,
      captureRuntimeSnapshotMatches,
      chrome,
      console,
      debugSessionApi,
      detectPlatformFromUrl,
      normalizePlatformId,
      readRuntimeState,
      resolveCaptureTaskTabId,
      setTimeout,
      writeRuntimeState,
    } = ports;
    const clearCaptureTaskTraceOverlayFailSoft = (...args) => operations.clearCaptureTaskTraceOverlayFailSoft(...args);
    const closeTrackedCaptureTaskWorkerTabs = (...args) => operations.closeTrackedCaptureTaskWorkerTabs(...args);
    const createCaptureTaskDebugOwnershipError = (...args) => operations.createCaptureTaskDebugOwnershipError(...args);
    const createCaptureTaskError = (...args) => operations.createCaptureTaskError(...args);
    const describeUnattendedBeginFenceMismatch = (...args) => operations.describeUnattendedBeginFenceMismatch(...args);
    const getCaptureTaskRequest = (...args) => operations.getCaptureTaskRequest(...args);
    const getTrackedCaptureTaskWorkers = (...args) => operations.getTrackedCaptureTaskWorkers(...args);
    const inspectUnattendedCaptureTaskAttempt = (...args) => operations.inspectUnattendedCaptureTaskAttempt(...args);
    const matchesUnattendedBeginLease = (...args) => operations.matchesUnattendedBeginLease(...args);
    const reclaimSupersededUnattendedCaptureTaskForBegin = (...args) => operations.reclaimSupersededUnattendedCaptureTaskForBegin(...args);
    const releaseConfirmedStaleCaptureTaskGroupsForBegin = (...args) => operations.releaseConfirmedStaleCaptureTaskGroupsForBegin(...args);
    const requireCaptureTaskId = (...args) => operations.requireCaptureTaskId(...args);
    const requireConnectedCaptureTaskOwner = (...args) => operations.requireConnectedCaptureTaskOwner(...args);
    const resolveCaptureTaskReplacementLease = (...args) => operations.resolveCaptureTaskReplacementLease(...args);
    const restorePersistedCaptureRuntimeSession = (...args) => operations.restorePersistedCaptureRuntimeSession(...args);
    const runCaptureTaskLifecycleOperation = (...args) => operations.runCaptureTaskLifecycleOperation(...args);

    async function beginCaptureTask(message, sender) {
      if (ports.strictLifecycleGuard) {
        const strict = await ports.strictLifecycleGuard('begin', message, sender);
        if (strict) return strict;
      }
      return await runCaptureTaskLifecycleOperation(async () => {
        const restoreResult = state.captureRuntimeRestorePromise
          ? await state.captureRuntimeRestorePromise
          : await restorePersistedCaptureRuntimeSession(await readRuntimeState());
        if (
          restoreResult?.cleanupPending &&
          restoreResult?.cleanupCompleted !== true
        ) {
          throw createCaptureTaskError(
            'capture_task_cleanup_pending',
            '上一采集任务仍在安全清理工作页，请稍后重试',
          );
        }
        const request = getCaptureTaskRequest(message);
        const marker = {
          taskId: requireCaptureTaskId(request),
          attemptId: String(request.attemptId || '').trim(),
          platform: normalizePlatformId(request.platform),
          sourceTabId: resolveCaptureTaskTabId(
            request.sourceTabId,
            request.tabId,
            sender?.tab?.id,
          ),
        };
        state.captureTaskBeginInFlight = marker;
        try {
          return await beginCaptureTaskNow(message, sender);
        } finally {
          if (state.captureTaskBeginInFlight === marker) {
            state.captureTaskBeginInFlight = null;
          }
        }
      });
    }

    async function beginCaptureTaskNow(message, sender) {
      if (ports.strictLifecycleGuard) {
        const strict = await ports.strictLifecycleGuard('begin', message, sender);
        if (strict) return strict;
      }
      const request = getCaptureTaskRequest(message);
      const taskId = requireCaptureTaskId(request);
      const ownerRequired = request.ownerRequired === true;
      const attemptId = String(request.attemptId || '').trim();
      let sourceTabId = resolveCaptureTaskTabId(
        state.captureTaskBeginInFlight?.taskId === taskId &&
            state.captureTaskBeginInFlight?.attemptId === attemptId
          ? state.captureTaskBeginInFlight.sourceTabId
          : null,
        request.sourceTabId,
        request.tabId,
        sender?.tab?.id,
      );
      if (!sourceTabId) {
        throw createCaptureTaskError(
          'invalid_capture_task_source_tab',
          '采集任务缺少有效的来源 Tab',
        );
      }
      let sourceTab = null;
      try {
        sourceTab = await chrome.tabs.get(sourceTabId);
      } catch (error) {
        const replacement = resolveCaptureTaskReplacementLease(sourceTabId, {
          taskId,
          attemptId,
        });
        const replacementTabId = resolveCaptureTaskTabId(
          state.captureTaskBeginInFlight?.taskId === taskId &&
              state.captureTaskBeginInFlight?.attemptId === attemptId
            ? state.captureTaskBeginInFlight.sourceTabId
            : null,
          replacement?.tabId,
        );
        if (!replacementTabId || replacementTabId === sourceTabId) {
          throw error;
        }
        sourceTabId = replacementTabId;
        sourceTab = await chrome.tabs.get(sourceTabId);
      }
      let sourcePlatform = detectPlatformFromUrl(sourceTab?.url || '');
      const requestedPlatform = normalizePlatformId(request.platform);
      if (!new Set(['xiaohongshu', 'douyin']).has(sourcePlatform)) {
        throw createCaptureTaskError(
          'capture_task_platform_unsupported',
          '当前平台不支持浏览器采集辅助',
        );
      }
      if (
        requestedPlatform !== 'unknown' &&
        requestedPlatform !== sourcePlatform
      ) {
        throw createCaptureTaskError(
          'capture_task_platform_mismatch',
          '任务平台与来源页面不一致，已拒绝启动采集辅助',
        );
      }
      if (
        state.captureTaskBeginInFlight?.taskId === taskId &&
        state.captureTaskBeginInFlight?.attemptId === attemptId
      ) {
        state.captureTaskBeginInFlight.platform = sourcePlatform;
      }

      // Fence before consulting the execution lock. Recovery deliberately has a
      // short window where the old lock is gone and the replacement runner has not
      // acquired its lock yet; a late BEGIN from the old document must not use
      // that window to resurrect the previous attempt as a manual task.
      const beginAttemptFence = await inspectUnattendedCaptureTaskAttempt({
        taskId,
        attemptId: request.attemptId,
      });
      if (beginAttemptFence.unattended && !beginAttemptFence.current) {
        throw createCaptureTaskError(
          'stale_unattended_attempt',
          '旧无人值守运行页已失效，已忽略其采集辅助请求',
        );
      }
      if (beginAttemptFence.unattended && !beginAttemptFence.active) {
        throw createCaptureTaskError(
          'unattended_request_terminal',
          '无人值守任务已结束，未启动采集辅助',
        );
      }
      if (
        beginAttemptFence.unattended &&
        !beginAttemptFence.hasUnattendedLock
      ) {
        throw createCaptureTaskError(
          'unattended_capture_lock_missing',
          '无人值守任务执行锁已失效，未启动采集辅助',
        );
      }

      if (ownerRequired) {
        await requireConnectedCaptureTaskOwner(taskId);
      }

      const unattendedBegin = await reclaimSupersededUnattendedCaptureTaskForBegin({
        taskId,
        sourceTabId,
        attemptId: request.attemptId,
        sender,
      });
      let boundExecutionLock = await bindCaptureExecutionLockToTask(
        taskId,
        sourceTabId,
        {
          allowUnattendedRebind: unattendedBegin?.unattended === true,
          attemptId: request.attemptId,
          expectedLockId: beginAttemptFence.lock?.id,
          expectedHolderId: beginAttemptFence.lock?.holderId,
          expectedHolderDocumentId:
            beginAttemptFence.lock?.holderDocumentId,
        },
      );
      if (
        beginAttemptFence.unattended &&
        (!boundExecutionLock ||
          String(boundExecutionLock.owner || '') !== 'unattended_keyword_plan' ||
          String(boundExecutionLock.captureTaskId || '').trim() !== taskId ||
          String(boundExecutionLock.captureTaskAttemptId || '').trim() !==
            String(request.attemptId || '').trim())
      ) {
        throw createCaptureTaskError(
          'unattended_capture_lock_bind_failed',
          '无人值守任务执行锁未能绑定，未启动采集辅助',
        );
      }

      const reconcileUnattendedBeginFence = async ({rollback = false} = {}) => {
        const fence = await inspectUnattendedCaptureTaskAttempt({
          taskId,
          attemptId,
        });
        const leaseMatches = !fence.unattended || matchesUnattendedBeginLease(
          fence.lock,
          boundExecutionLock,
          {taskId, attemptId},
        );
        if (
          fence.unattended &&
          (!fence.current ||
            !fence.active ||
            !fence.lockMatchesTaskAttempt ||
            !leaseMatches)
        ) {
          const details = describeUnattendedBeginFenceMismatch(
            fence,
            boundExecutionLock,
          );
          console.warn('[CaptureTask] unattended BEGIN fence changed:', details);
          throw createCaptureTaskError(
            'unattended_begin_fence_changed',
            rollback
              ? '无人值守任务状态已经变化，已撤销采集辅助'
              : '无人值守任务状态已经变化，未启动采集辅助',
            details,
          );
        }
        const inFlightReplacementTabId = resolveCaptureTaskTabId(
          state.captureTaskBeginInFlight?.taskId === taskId &&
              state.captureTaskBeginInFlight?.attemptId === attemptId
            ? state.captureTaskBeginInFlight.sourceTabId
            : null,
        );
        const replacementTabId = resolveCaptureTaskTabId(
          inFlightReplacementTabId !== sourceTabId
            ? inFlightReplacementTabId
            : fence.unattended
              ? fence.lock?.holderTabId
              : null,
        );
        if (replacementTabId && replacementTabId !== sourceTabId) {
          const replacement = resolveCaptureTaskReplacementLease(sourceTabId, {
            taskId,
            attemptId,
          });
          if (!replacement || replacement.tabId !== replacementTabId) {
            const details = describeUnattendedBeginFenceMismatch(
              fence,
              boundExecutionLock,
            );
            throw createCaptureTaskError(
              'unattended_begin_fence_changed',
              '无人值守任务页面发生了未经确认的切换，未启动采集辅助',
              details,
            );
          }
          const replacementTab = await chrome.tabs.get(replacementTabId);
          const replacementPlatform = detectPlatformFromUrl(
            replacementTab?.url || '',
          );
          if (
            replacementPlatform !== sourcePlatform ||
            (requestedPlatform !== 'unknown' &&
              replacementPlatform !== requestedPlatform)
          ) {
            throw createCaptureTaskError(
              'capture_task_platform_mismatch',
              '浏览器替换后的任务页面与原任务平台不一致，已拒绝迁移采集任务',
            );
          }
          sourceTabId = replacementTabId;
          sourceTab = replacementTab;
          sourcePlatform = replacementPlatform;
          if (
            state.captureTaskBeginInFlight?.taskId === taskId &&
            state.captureTaskBeginInFlight?.attemptId === attemptId
          ) {
            state.captureTaskBeginInFlight.sourceTabId = replacementTabId;
          }
        }
        if (fence.unattended) {
          boundExecutionLock = fence.lock;
        }
        return fence;
      };

      const staleRecovery =
        await releaseConfirmedStaleCaptureTaskGroupsForBegin();
      await reconcileUnattendedBeginFence();

      let existingSession =
        state.captureDebugSessionManager.getSessionByTaskId(taskId);
      let existingGroup = state.captureTaskTabGroupManager.getTask(taskId);
      let staleAssistWorkerTabIds = [];
      let staleAssistDegraded = false;
      const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(taskId);
      if (
        (!existingSession && existingGroup) ||
        pendingWorkerTabIds.length > 0
      ) {
        throw createCaptureTaskError(
          'capture_task_cleanup_pending',
          '上一采集任务仍在安全清理工作页，请稍后重试',
        );
      }
      if (existingSession && existingSession.tabId !== sourceTabId) {
        const staleSession = existingSession;
        const staleGroup = existingGroup;
        const staleSourceTabId = resolveCaptureTaskTabId(staleSession.tabId);
        const staleAttemptId = String(staleSession.attemptId || '').trim();
        const stalePlatform = normalizePlatformId(
          staleSession.platform || detectPlatformFromUrl(staleSession.pageUrl || ''),
        );
        const replacementLease = resolveCaptureTaskReplacementLease(
          staleSourceTabId,
          {taskId, attemptId},
        );
        const exactReplacementLease = Boolean(
          replacementLease &&
            replacementLease.tabId === sourceTabId &&
            replacementLease.taskId === taskId &&
            String(replacementLease.attemptId || '').trim() === attemptId,
        );
        const exactExecutionLock = Boolean(
          unattendedBegin?.unattended === true &&
            boundExecutionLock &&
            String(boundExecutionLock.owner || '') ===
              'unattended_keyword_plan' &&
            String(boundExecutionLock.captureTaskId || '').trim() === taskId &&
            String(boundExecutionLock.captureTaskAttemptId || '').trim() ===
              attemptId &&
            resolveCaptureTaskTabId(boundExecutionLock.holderTabId) === sourceTabId,
        );
        const exactGroupOwnership = Boolean(
          !staleGroup ||
            (resolveCaptureTaskTabId(staleGroup.sourceTabId) ===
              staleSourceTabId &&
              String(staleGroup.attemptId || '').trim() === attemptId &&
              (staleSession.groupId === null ||
                staleSession.groupId === undefined ||
                Number(staleSession.groupId) === Number(staleGroup.groupId))),
        );
        const exactStaleAssist = Boolean(
          staleSourceTabId &&
            attemptId &&
            staleAttemptId === attemptId &&
            stalePlatform !== 'unknown' &&
            stalePlatform === sourcePlatform &&
            exactGroupOwnership &&
            (exactReplacementLease || exactExecutionLock),
        );
        if (!exactStaleAssist) {
          throw createCaptureTaskError(
            'capture_task_source_mismatch',
            '该采集任务已经绑定到另一个来源 Tab，且没有同一执行轮次的页面替换凭证',
          );
        }

        // The content task is authoritative; Debug and native grouping are only
        // assistance. If an exact task+attempt replacement reaches BEGIN before the
        // asynchronous tabs.onReplaced migration settles, close only that old
        // assist identity and rebuild it as detached on the verified source. Never
        // make a generic source mismatch optional: a different attempt/platform (or
        // a source change without an authoritative lock/lease) remains a hard fence.
        await reconcileUnattendedBeginFence();
        staleAssistWorkerTabIds = getTrackedCaptureTaskWorkers(
          taskId,
          staleSession,
          staleGroup,
        );
        const stoppedStaleSession = await state.captureDebugSessionManager.stop({
          tabId: staleSourceTabId,
          taskId,
          attemptId,
          runId: staleSession.runId,
          reason: 'capture_assist_source_stale',
          force: false,
          publishState: false,
          bestEffort: true,
        });
        if (stoppedStaleSession?.released !== true) {
          throw createCaptureTaskError(
            'capture_task_source_mismatch',
            '旧采集辅助已由其他执行轮次替换，未改动当前任务',
          );
        }
        await clearCaptureTaskTraceOverlayFailSoft({
          taskId,
          tabId: staleSourceTabId,
        });
        existingSession = null;

        await reconcileUnattendedBeginFence();
        let reboundGroup = staleGroup;
        let groupOwnershipRetained = Boolean(staleGroup);
        if (staleGroup) {
          if (exactReplacementLease) {
            try {
              const groupResult = await state.captureTaskTabGroupManager.replaceTab({
                removedTabId: staleSourceTabId,
                addedTabId: sourceTabId,
              });
              if (groupResult?.replaced !== true) {
                throw createCaptureTaskError(
                  'capture_task_replacement_not_rebound',
                  '旧采集标签组未能迁移到已验证的替换页面',
                );
              }
              reboundGroup = groupResult.group;
            } catch (error) {
              console.warn(
                '[CaptureAssist] exact stale group migration degraded:',
                error?.message || error,
              );
              groupOwnershipRetained = false;
            }
          } else {
            // A transferred unattended execution lock proves the new source but
            // does not prove Chromium removed the old Tab. Release the old native
            // group instead of silently leaving that still-live Tab grouped.
            groupOwnershipRetained = false;
          }

          if (!groupOwnershipRetained) {
            const latestGroup = state.captureTaskTabGroupManager.getTask(taskId);
            const exactLatestGroup = Boolean(
              latestGroup &&
                String(latestGroup.attemptId || '').trim() === attemptId &&
                Number(latestGroup.sourceTabId) === Number(staleGroup.sourceTabId) &&
                Number(latestGroup.groupId) === Number(staleGroup.groupId),
            );
            if (latestGroup && !exactLatestGroup) {
              throw createCaptureTaskError(
                'capture_task_source_mismatch',
                '采集标签组已由其他执行轮次替换，未改动当前任务',
              );
            }
            if (exactLatestGroup) {
              try {
                await state.captureTaskTabGroupManager.end({
                  taskId,
                  attemptId,
                  sourceTabId: staleGroup.sourceTabId,
                  groupId: staleGroup.groupId,
                  reason: 'capture_assist_source_stale',
                });
              } catch (error) {
                console.warn(
                  '[CaptureAssist] exact stale group cleanup remains pending:',
                  error?.message || error,
                );
                const pendingCleanupSnapshot = {
                  ...staleGroup,
                  taskId,
                  runId: staleSession.runId,
                  attemptId,
                  platform: stalePlatform,
                  persistent: true,
                  tabId: staleSourceTabId,
                  sourceTabId: staleSourceTabId,
                  workerTabIds: staleAssistWorkerTabIds,
                  state: 'detaching',
                  cleanupPending: true,
                  debugCleanupConfirmed: true,
                  cleanupReason: 'capture_assist_source_stale',
                };
                await writeRuntimeState((current) => {
                  const currentSnapshot = current.captureDebugSession;
                  if (
                    currentSnapshot &&
                    !captureRuntimeSnapshotMatches(
                      currentSnapshot,
                      pendingCleanupSnapshot,
                    )
                  ) {
                    return {};
                  }
                  return {captureDebugSession: pendingCleanupSnapshot};
                });
                throw createCaptureTaskError(
                  'capture_task_begin_cleanup_failed',
                  '旧采集标签组尚未确认释放，请稍后重试',
                  {
                    retryable: true,
                    cleanupError: String(error?.message || error || '').slice(
                      0,
                      320,
                    ),
                  },
                );
              }
            }
            reboundGroup = null;
            if (staleAssistWorkerTabIds.length > 0) {
              state.captureTaskPendingWorkerTabIds.set(
                taskId,
                Array.from(new Set(staleAssistWorkerTabIds)),
              );
            }
          }
        }

        await reconcileUnattendedBeginFence();
        try {
          existingSession = await state.captureDebugSessionManager.restore(
            {
              ...staleSession,
              tabId: sourceTabId,
              sourceTabId,
              state: 'detached',
              pageTitle: sourceTab?.title || staleSession.pageTitle || '',
              pageUrl: sourceTab?.url || staleSession.pageUrl || '',
              platform: sourcePlatform,
              groupId: reboundGroup?.groupId ?? null,
              workerTabIds: staleAssistWorkerTabIds,
            },
            {publishState: true},
          );
        } catch (error) {
          // The exact old assist has already been closed. A fresh optional assist
          // start below may still succeed; otherwise the caller degrades without
          // blocking the content-script collection.
          existingSession = null;
          console.warn(
            '[CaptureAssist] exact stale session restore degraded:',
            error?.message || error,
          );
        }
        existingGroup = state.captureTaskTabGroupManager.getTask(taskId);
        staleAssistDegraded = true;
      }
      const activeDebugSession = state.captureDebugSessionManager
        .getActiveSessions()
        .find(Boolean);
      if (
        activeDebugSession &&
        (!activeDebugSession.persistent ||
          activeDebugSession.taskId !== taskId ||
          activeDebugSession.tabId !== sourceTabId)
      ) {
        const ownership =
          debugSessionApi.classifyDebugOwnership({
            requestedTaskId: taskId,
            requestedTabId: sourceTabId,
            activeSession: activeDebugSession,
            staleReleasedTaskIds: staleRecovery.releasedTaskIds,
        });
        throw createCaptureTaskDebugOwnershipError(ownership);
      }
      const conflictingGroup = state.captureTaskTabGroupManager
        .getActiveTasks()
        .find((candidate) => candidate?.taskId !== taskId);
      if (conflictingGroup) {
        throw createCaptureTaskError(
          'capture_task_group_busy',
          '已有采集标签组正在运行，请先结束当前任务',
          {
            debugOwnership: 'starvoice_active',
            retryable: true,
            automaticReroute: true,
            safeToDetach: false,
            ownerTaskId: String(conflictingGroup.taskId || '').trim(),
          },
        );
      }
      let debugOwnership =
        debugSessionApi.classifyDebugOwnership({
          requestedTaskId: taskId,
          requestedTabId: sourceTabId,
          activeSession: existingSession,
          staleReleasedTaskIds: staleRecovery.releasedTaskIds,
        });
      if (!existingSession) {
        if (typeof chrome.debugger?.getTargets !== 'function') {
          debugOwnership =
            debugSessionApi.classifyDebugOwnership({
              requestedTaskId: taskId,
              requestedTabId: sourceTabId,
              staleReleasedTaskIds: staleRecovery.releasedTaskIds,
              preflightAvailable: false,
            });
          throw createCaptureTaskDebugOwnershipError(debugOwnership);
        }
        let targets = [];
        try {
          targets = await chrome.debugger.getTargets();
        } catch (error) {
          debugOwnership =
            debugSessionApi.classifyDebugOwnership({
              requestedTaskId: taskId,
              requestedTabId: sourceTabId,
              staleReleasedTaskIds: staleRecovery.releasedTaskIds,
              preflightError: error,
            });
          throw createCaptureTaskDebugOwnershipError(debugOwnership);
        }
        const occupied = (Array.isArray(targets) ? targets : []).some(
          (target) =>
            target?.attached === true &&
            Number(target?.tabId) === sourceTabId,
        );
        if (occupied) {
          debugOwnership =
            debugSessionApi.classifyDebugOwnership({
              requestedTaskId: taskId,
              requestedTabId: sourceTabId,
              staleReleasedTaskIds: staleRecovery.releasedTaskIds,
              targetAttached: true,
            });
          throw createCaptureTaskDebugOwnershipError(debugOwnership);
        }
      }
      await reconcileUnattendedBeginFence();
      const beginRunId =
        String(request.runId || '').trim() ||
        existingSession?.runId ||
        `capture-task:${taskId}`;
      // A repeated/idempotent BEGIN may arrive after its first response was lost.
      // Only resources first created by this invocation may be rolled back.
      const preBeginSession = existingSession;
      const preBeginGroup = existingGroup;
      let group = null;
      let session = null;

      try {
        group = await state.captureTaskTabGroupManager.begin({
          taskId,
          attemptId,
          sourceTabId,
          title: CAPTURE_TASK_GROUP_TITLE,
        });
        await reconcileUnattendedBeginFence();
        const activeGroupAfterFence =
          state.captureTaskTabGroupManager.getTask(taskId) || group;
        if (activeGroupAfterFence.sourceTabId !== sourceTabId) {
          const groupReplacement = resolveCaptureTaskReplacementLease(
            activeGroupAfterFence.sourceTabId,
            {taskId, attemptId},
          );
          if (!groupReplacement || groupReplacement.tabId !== sourceTabId) {
            throw createCaptureTaskError(
              'capture_task_replacement_not_rebound',
              '浏览器替换了采集页面，但任务标签组未能重新绑定',
            );
          }
          const groupResult = await state.captureTaskTabGroupManager.replaceTab({
            removedTabId: activeGroupAfterFence.sourceTabId,
            addedTabId: sourceTabId,
          });
          if (groupResult?.replaced !== true) {
            throw createCaptureTaskError(
              'capture_task_replacement_not_rebound',
              '浏览器替换了采集页面，但任务标签组未能重新绑定',
            );
          }
          group = groupResult.group;
        } else {
          group = activeGroupAfterFence;
        }
        try {
          session = await state.captureDebugSessionManager.start({
            tabId: sourceTabId,
            runId: beginRunId,
            label: String(request.label || '').trim() || '采集任务',
            pageTitle: sourceTab?.title || '',
            pageUrl: sourceTab?.url || '',
            platform: sourcePlatform,
            persistent: true,
            taskId,
            attemptId: request.attemptId,
            progress: request.progress ?? null,
            workerTabIds:
              existingSession?.workerTabIds || staleAssistWorkerTabIds,
            groupId: group.groupId,
            originalGroupId: group.originalGroupId,
            minimized: Boolean(request.minimized),
          });
        } catch (error) {
          if (error?.code !== 'debug_session_attach_failed') throw error;
          debugOwnership =
            debugSessionApi.classifyDebugOwnership({
              requestedTaskId: taskId,
              requestedTabId: sourceTabId,
              staleReleasedTaskIds: staleRecovery.releasedTaskIds,
              attachError: error?.cause || error,
            });
          throw createCaptureTaskDebugOwnershipError(debugOwnership);
        }

        const update = {taskId, groupId: group.groupId};
        if (Object.prototype.hasOwnProperty.call(request, 'progress')) {
          update.progress = request.progress;
        }
        if (Object.prototype.hasOwnProperty.call(request, 'minimized')) {
          update.minimized = Boolean(request.minimized);
        }
        if (Object.prototype.hasOwnProperty.call(request, 'label')) {
          update.label = request.label;
        }
        session = await state.captureDebugSessionManager.updateTask(update);
        if (ownerRequired) {
          await requireConnectedCaptureTaskOwner(taskId);
        }
        await writeRuntimeState({captureTaskCancellation: null});
        await reconcileUnattendedBeginFence({rollback: true});
        const reusedDetachedAssist = session?.state === 'detached';
        return {
          taskId,
          session,
          group,
          debugOwnership,
          ...(staleAssistDegraded || reusedDetachedAssist
            ? {
                assistDegraded: true,
                assistReason: staleAssistDegraded
                  ? 'capture_assist_source_stale'
                  : 'capture_assist_detached',
              }
            : {}),
        };
      } catch (error) {
        const currentDebugSnapshot =
          state.captureDebugSessionManager.getSessionByTaskId(taskId);
        const currentGroupSnapshot = state.captureTaskTabGroupManager.getTask(taskId);
        const rollbackDebugSnapshot =
          !preBeginSession &&
          currentDebugSnapshot &&
          String(currentDebugSnapshot.taskId || '').trim() === taskId &&
          String(currentDebugSnapshot.runId || '').trim() === beginRunId &&
          String(currentDebugSnapshot.attemptId || '').trim() === attemptId &&
          resolveCaptureTaskTabId(
            currentDebugSnapshot.sourceTabId,
            currentDebugSnapshot.tabId,
          ) === sourceTabId
            ? currentDebugSnapshot
            : null;
        const rollbackGroupSnapshot =
          !preBeginGroup &&
          currentGroupSnapshot &&
          String(currentGroupSnapshot.taskId || '').trim() === taskId &&
          String(currentGroupSnapshot.attemptId || '').trim() === attemptId &&
          resolveCaptureTaskTabId(currentGroupSnapshot.sourceTabId) === sourceTabId
            ? currentGroupSnapshot
            : null;
        if (rollbackDebugSnapshot || rollbackGroupSnapshot) {
          try {
            let exactCleanupError = null;
            for (let cleanupAttempt = 0; cleanupAttempt < 3; cleanupAttempt += 1) {
              try {
                if (rollbackDebugSnapshot) {
                  const debugResult = await state.captureDebugSessionManager.stop({
                    tabId: rollbackDebugSnapshot.tabId,
                    taskId,
                    attemptId,
                    runId: beginRunId,
                    reason: 'capture_task_begin_rollback',
                    force: false,
                  });
                  if (
                    debugResult?.released !== true &&
                    debugResult?.reason !== 'not_attached'
                  ) {
                    throw createCaptureTaskError(
                      'capture_task_begin_debug_cleanup_mismatch',
                      '采集辅助初始化资源已由其他执行轮次替换',
                    );
                  }
                }
                if (rollbackGroupSnapshot) {
                  const latestGroup = state.captureTaskTabGroupManager.getTask(taskId);
                  const exactGroup = Boolean(
                    latestGroup &&
                      String(latestGroup.attemptId || '').trim() === attemptId &&
                      resolveCaptureTaskTabId(latestGroup.sourceTabId) ===
                        sourceTabId &&
                      Number(latestGroup.groupId) ===
                        Number(rollbackGroupSnapshot.groupId),
                  );
                  if (!exactGroup) {
                    throw createCaptureTaskError(
                      'capture_task_begin_group_cleanup_mismatch',
                      '采集标签组已由其他执行轮次替换',
                    );
                  }
                  const rollbackWorkerTabIds = getTrackedCaptureTaskWorkers(
                    taskId,
                    rollbackDebugSnapshot,
                    latestGroup,
                  );
                  if (rollbackWorkerTabIds.length > 0) {
                    await closeTrackedCaptureTaskWorkerTabs(
                      taskId,
                      rollbackWorkerTabIds,
                    );
                  }
                  const groupResult = await state.captureTaskTabGroupManager.end({
                    taskId,
                    attemptId,
                    sourceTabId,
                    groupId: rollbackGroupSnapshot.groupId,
                    reason: 'capture_task_begin_rollback',
                  });
                  if (
                    groupResult?.released !== true &&
                    groupResult?.reason !== 'not_grouped'
                  ) {
                    throw createCaptureTaskError(
                      'capture_task_begin_group_cleanup_mismatch',
                      '采集标签组已由其他执行轮次替换',
                    );
                  }
                }
                exactCleanupError = null;
                break;
              } catch (candidate) {
                exactCleanupError = candidate;
                if (cleanupAttempt + 1 < 3) {
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
              }
            }
            if (exactCleanupError) throw exactCleanupError;
          } catch (cleanupError) {
            const latestDebugSnapshot =
              state.captureDebugSessionManager.getSessionByTaskId(taskId);
            const latestGroupSnapshot = state.captureTaskTabGroupManager.getTask(taskId);
            const pendingDebugSnapshot =
              rollbackDebugSnapshot &&
              latestDebugSnapshot &&
              String(latestDebugSnapshot.runId || '').trim() === beginRunId &&
              String(latestDebugSnapshot.attemptId || '').trim() === attemptId &&
              resolveCaptureTaskTabId(
                latestDebugSnapshot.sourceTabId,
                latestDebugSnapshot.tabId,
              ) === sourceTabId
                ? latestDebugSnapshot
                : null;
            const pendingGroupSnapshot =
              rollbackGroupSnapshot &&
              latestGroupSnapshot &&
              String(latestGroupSnapshot.attemptId || '').trim() === attemptId &&
              resolveCaptureTaskTabId(latestGroupSnapshot.sourceTabId) ===
                sourceTabId &&
              Number(latestGroupSnapshot.groupId) ===
                Number(rollbackGroupSnapshot.groupId)
                ? latestGroupSnapshot
                : null;
            const pendingWorkerTabIds =
              pendingDebugSnapshot || pendingGroupSnapshot
                ? getTrackedCaptureTaskWorkers(
                    taskId,
                    pendingDebugSnapshot,
                    pendingGroupSnapshot,
                  )
                : [];
            if (
              pendingDebugSnapshot ||
              pendingGroupSnapshot ||
              pendingWorkerTabIds.length > 0
            ) {
              const pendingCleanupSnapshot = {
                ...(pendingGroupSnapshot || {}),
                ...(pendingDebugSnapshot || {}),
                taskId,
                runId:
                  String(
                    pendingDebugSnapshot?.runId || request.runId || '',
                  ).trim() || `capture-task:${taskId}`,
                attemptId: String(
                  pendingDebugSnapshot?.attemptId || attemptId || '',
                ).trim(),
                platform: sourcePlatform,
                persistent: true,
                tabId:
                  resolveCaptureTaskTabId(
                    pendingDebugSnapshot?.tabId,
                    pendingGroupSnapshot?.sourceTabId,
                    sourceTabId,
                  ) || null,
                sourceTabId:
                  resolveCaptureTaskTabId(
                    pendingDebugSnapshot?.sourceTabId,
                    pendingDebugSnapshot?.tabId,
                    pendingGroupSnapshot?.sourceTabId,
                    sourceTabId,
                  ) || null,
                workerTabIds: pendingWorkerTabIds,
                state: 'detaching',
                cleanupPending: true,
                cleanupReason: 'capture_task_begin_rollback',
              };
              await writeRuntimeState((current) => {
                const currentSnapshot = current.captureDebugSession;
                if (
                  currentSnapshot &&
                  !captureRuntimeSnapshotMatches(
                    currentSnapshot,
                    pendingCleanupSnapshot,
                  )
                ) {
                  return {};
                }
                return {captureDebugSession: pendingCleanupSnapshot};
              }).catch((persistError) => {
                console.warn(
                  '[CaptureTask] failed to persist begin cleanup ownership:',
                  persistError,
                );
              });
              throw createCaptureTaskError(
                'capture_task_begin_cleanup_failed',
                '采集辅助初始化失败，且任务资源仍在清理中',
                {
                  retryable: true,
                  assistFailureCode: String(
                    error?.assistFailureCode || error?.code || '',
                  ).trim(),
                  cleanupError: String(
                    cleanupError?.message || cleanupError || '',
                  ).slice(0, 320),
                },
              );
            }
            // A newer exact attempt won the ownership race. Do not persist or
            // clean its resources on behalf of this failed BEGIN.
          }
        }
        const recoveredAssistFailureCode = String(
          error?.assistFailureCode || '',
        ).trim();
        if (
          new Set([
            'debug_session_start_cleanup_failed',
            'capture_task_group_cleanup_failed',
          ]).has(String(error?.code || '')) &&
          new Set([
            'capture_task_group_create_failed',
            'debug_session_command_failed',
            'debug_session_detached_during_start',
          ]).has(recoveredAssistFailureCode)
        ) {
          throw createCaptureTaskError(
            recoveredAssistFailureCode,
            String(error?.setupError?.message || '采集辅助初始化失败'),
            {cleanupConfirmed: true},
          );
        }
        throw error;
      }
    }

    return Object.freeze({
      beginCaptureTask,
      beginCaptureTaskNow,
    });
  }
  root.OnStarvoiceCaptureLifecycleBegin = Object.freeze({create});
})(globalThis);
