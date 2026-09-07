// L1: restore responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const strictPending = () => ({ok: false, accepted: false, restored: false,
      released: false, resourcesReleased: false, cleanupPending: true,
      cleanupCompleted: false, reason: 'strict_capture_control_retained'});
    const strictRetained = async () => {
      if (typeof ports.hasStrictCaptureStopControl !== 'function') return false;
      try { return await ports.hasStrictCaptureStopControl() !== false; } catch { return true; }
    };
    const {
      CAPTURE_TASK_GROUP_TITLE,
      captureRuntimeSnapshotMatches,
      chrome,
      console,
      detectPlatformFromUrl,
      normalizePlatformId,
      resolveCaptureTaskTabId,
      writeRuntimeState,
    } = ports;
    const clearCaptureTaskTraceOverlayFailSoft = (...args) => operations.clearCaptureTaskTraceOverlayFailSoft(...args);
    const closeCaptureTaskWorkerTabs = (...args) => operations.closeCaptureTaskWorkerTabs(...args);
    const closeTrackedCaptureTaskWorkerTabs = (...args) => operations.closeTrackedCaptureTaskWorkerTabs(...args);
    const createCaptureTaskError = (...args) => operations.createCaptureTaskError(...args);
    const inspectUnattendedCaptureTaskAttempt = (...args) => operations.inspectUnattendedCaptureTaskAttempt(...args);
    const matchesUnattendedBeginLease = (...args) => operations.matchesUnattendedBeginLease(...args);

    async function cleanupStaleCaptureRuntimeSession(session) {
      if (await strictRetained()) return strictPending();
      if (!session || typeof session !== 'object') return;
      const sourceTabId = resolveCaptureTaskTabId(
        session.sourceTabId,
        session.tabId,
      );
      const workerTabIds = Array.isArray(session.workerTabIds)
        ? [
            ...new Set(
              session.workerTabIds
                .map((tabId) => resolveCaptureTaskTabId(tabId))
                .filter(Boolean),
            ),
          ]
        : [];
      const taskGroupId =
        session.groupId === null ||
        session.groupId === undefined ||
        session.groupId === ''
          ? -1
          : Number(session.groupId);
      const originalGroupId =
        session.originalGroupId === null ||
        session.originalGroupId === undefined ||
        session.originalGroupId === ''
          ? -1
          : Number(session.originalGroupId);
      const pendingNativeGroupSetup =
        session.nativeGroupSetupPending === true;
      const expectedPlatform = normalizePlatformId(
        session.platform || detectPlatformFromUrl(session.pageUrl || ''),
      );
      const expectedWindowId =
        session.windowId !== null &&
        session.windowId !== undefined &&
        session.windowId !== '' &&
        Number.isSafeInteger(Number(session.windowId))
          ? Number(session.windowId)
          : null;
      let taskGroup = null;
      let verifiedTaskGroup = false;
      if (Number.isSafeInteger(taskGroupId) && taskGroupId >= 0) {
        try {
          taskGroup = await chrome.tabGroups.get(taskGroupId);
          verifiedTaskGroup =
            String(taskGroup?.title || '').trim() === CAPTURE_TASK_GROUP_TITLE;
        } catch (error) {
          const message = String(error?.message || error || '');
          if (
            /no (?:tab )?group with id|not found|does not exist|invalid group id/iu.test(
              message,
            )
          ) {
            verifiedTaskGroup = false;
          } else {
            throw error;
          }
        }
      }

      let sourceTab = null;
      if ((verifiedTaskGroup || pendingNativeGroupSetup) && sourceTabId) {
        try {
          const candidate = await chrome.tabs.get(sourceTabId);
          const candidateWindowId = Number.isSafeInteger(candidate?.windowId)
            ? candidate.windowId
            : null;
          const taskGroupWindowId = Number.isSafeInteger(taskGroup?.windowId)
            ? taskGroup.windowId
            : null;
          const candidatePlatform = detectPlatformFromUrl(candidate?.url || '');
          const exactPendingOwnership = Boolean(
            pendingNativeGroupSetup &&
              taskGroup &&
              candidate?.groupId === taskGroupId &&
              expectedWindowId !== null &&
              candidateWindowId === expectedWindowId &&
              (taskGroupWindowId === null || taskGroupWindowId === expectedWindowId) &&
              new Set(['xiaohongshu', 'douyin']).has(expectedPlatform) &&
              candidatePlatform === expectedPlatform,
          );
          const sourceOwnershipVerified = pendingNativeGroupSetup
            ? exactPendingOwnership
            : verifiedTaskGroup;
          if (candidate?.groupId === taskGroupId && sourceOwnershipVerified) {
            sourceTab = candidate;
            verifiedTaskGroup = true;
          } else {
            // The Tab/group/window/platform identity no longer proves ownership.
            // Fail closed: never ungroup a reused page merely because an old MV3
            // cleanup snapshot still names its numeric ids.
            verifiedTaskGroup = false;
          }
        } catch (error) {
          const message = String(error?.message || error || '');
          if (/no tab with id|not found|does not exist|invalid tab id/iu.test(message)) {
            sourceTab = null;
          } else {
            throw error;
          }
        }
      }

      const verifiedWorkerTabIds = [];
      if (verifiedTaskGroup) {
        for (const workerTabId of workerTabIds) {
          try {
            const workerTab = await chrome.tabs.get(workerTabId);
            if (
              workerTab?.groupId === taskGroupId &&
              (!sourceTab ||
                !Number.isSafeInteger(sourceTab.windowId) ||
                (Number.isSafeInteger(workerTab?.windowId) &&
                  workerTab.windowId === sourceTab.windowId))
            ) {
              verifiedWorkerTabIds.push(workerTabId);
            }
          } catch (error) {
            const message = String(error?.message || error || '');
            if (
              !/no tab with id|not found|does not exist|invalid tab id/iu.test(
                message,
              )
            ) {
              throw error;
            }
          }
        }
      }

      if (await strictRetained()) return strictPending();
      await Promise.allSettled(
        [...new Set([sourceTabId, ...workerTabIds].filter(Boolean))].map((tabId) =>
          clearCaptureTaskTraceOverlayFailSoft({
            taskId: session.taskId,
            tabId,
          }),
        ),
      );

      if (await strictRetained()) return strictPending();
      if (chrome.action?.setBadgeText) {
        await chrome.action.setBadgeText({text: ''}).catch(() => null);
      }
      if (await strictRetained()) return strictPending();
      if (
        sourceTab &&
        !pendingNativeGroupSetup &&
        session.debugCleanupConfirmed !== true
      ) {
        await chrome.debugger.detach({tabId: sourceTab.id}).catch((error) => {
          const message = String(error?.message || error || '');
          if (/not attached|no tab with given id|target closed/iu.test(message)) {
            return;
          }
          throw error;
        });
      }
      if (await strictRetained()) return strictPending();
      if (verifiedWorkerTabIds.length > 0) {
        await closeCaptureTaskWorkerTabs(verifiedWorkerTabIds);
      }
      if (await strictRetained()) return strictPending();
      if (!sourceTab) return;
      if (Number.isSafeInteger(originalGroupId) && originalGroupId >= 0) {
        try {
          await chrome.tabs.group({
            groupId: originalGroupId,
            tabIds: [sourceTab.id],
          });
          return;
        } catch {
          if (await strictRetained()) return strictPending();
          // The user's former group no longer exists; ungroup below.
        }
      }
      try {
        await chrome.tabs.ungroup([sourceTab.id]);
      } catch (error) {
        const message = String(error?.message || error || '');
        if (
          /no tab with id|not found|does not exist|not in a group|invalid tab id/iu.test(
            message,
          )
        ) {
          return;
        }
        throw error;
      }
    }

    async function clearPersistedCaptureRuntimeSnapshot(expected) {
      if (await strictRetained()) return false;
      let cleared = false;
      await writeRuntimeState((current) => {
        if (!captureRuntimeSnapshotMatches(current.captureDebugSession, expected)) {
          return {};
        }
        cleared = true;
        return {captureDebugSession: null};
      });
      return cleared;
    }

    async function publishRestoredCaptureRuntimeSnapshot(expected, session) {
      if (await strictRetained()) return false;
      let published = false;
      await writeRuntimeState((current) => {
        if (!captureRuntimeSnapshotMatches(current.captureDebugSession, expected)) {
          return {};
        }
        published = true;
        return {captureDebugSession: session};
      });
      if (await strictRetained()) return false;
      if (published && chrome.action?.setBadgeText) {
        await Promise.allSettled([
          chrome.action.setBadgeText({
            text: session?.state === 'attached' ? '1' : '',
          }),
          chrome.action.setBadgeBackgroundColor({color: '#6f5cff'}),
          chrome.action.setBadgeTextColor
            ? chrome.action.setBadgeTextColor({color: '#ffffff'})
            : Promise.resolve(),
        ]);
      }
      return published;
    }

    async function restorePersistedCaptureRuntimeSession(runtime) {
      if (await strictRetained()) return strictPending();
      const snapshot = runtime?.captureDebugSession;
      if (
        !snapshot ||
        snapshot.persistent !== true ||
        state.captureDebugSessionManager?.getActiveSessions().length > 0
      ) {
        return {restored: false, reason: 'not_required'};
      }
      if (state.captureTaskBeginInFlight) {
        return {
          restored: false,
          reason: 'capture_begin_in_progress',
          concurrentBegin: true,
          snapshot,
        };
      }
      if (state.captureRuntimeRestorePromise) return await state.captureRuntimeRestorePromise;

      state.captureRuntimeRestorePromise = (async () => {
        if (await strictRetained()) return strictPending();
        const taskId = String(snapshot.taskId || '').trim();
        if (!taskId) return {restored: false, reason: 'missing_task_id'};
        const restoreDetachedAssist =
          snapshot.persistent === true &&
          String(snapshot.state || '').trim().toLowerCase() === 'detached';
        // The persisted session must carry its own attempt identity. Progress is a
        // separate, later-moving record and must never be used to rename an older
        // browser snapshot into the current unattended attempt.
        const attemptId = String(snapshot.attemptId || '').trim();
        const initialFence = await inspectUnattendedCaptureTaskAttempt({
          taskId,
          attemptId,
        });
        if (await strictRetained()) return strictPending();
        const restoreSnapshot = {...snapshot, attemptId};
        const cleanupPending = Boolean(
          restoreSnapshot.cleanupPending === true ||
            String(restoreSnapshot.state || '').trim().toLowerCase() ===
              'detaching',
        );
        const unattendedSnapshotIsStale = Boolean(
          initialFence.unattended &&
            (!attemptId ||
              !initialFence.current ||
              (!cleanupPending &&
                (!initialFence.active || !initialFence.lockMatchesTaskAttempt)) ||
              (cleanupPending &&
                !initialFence.terminal &&
                !initialFence.lockMatchesTaskAttempt)),
        );
        if (unattendedSnapshotIsStale) {
          return {
            restored: false,
            reason: attemptId
              ? 'stale_unattended_attempt'
              : 'missing_unattended_attempt',
            staleAttempt: true,
            snapshot: restoreSnapshot,
          };
        }

        if (cleanupPending) {
          try {
            // Keep cleanup inside the restore fence. BEGIN waits for this promise,
            // so an old attempt cannot close or forget resources after a new
            // attempt has already claimed the same stable task id.
            await cleanupStaleCaptureRuntimeSession(restoreSnapshot);
            if (await strictRetained()) return strictPending();
            const cleanupCompleted =
              await clearPersistedCaptureRuntimeSnapshot(restoreSnapshot);
            return {
              restored: false,
              reason: 'capture_cleanup_completed',
              cleanupPending: true,
              cleanupCompleted,
              snapshot: restoreSnapshot,
            };
          } catch (error) {
            // Leave the exact cleanup snapshot in storage for the next MV3 wake.
            // It must never be revived as a running logical/Debug session.
            console.warn(
              '[CaptureTask] persisted cleanup remains pending:',
              error?.message || error,
            );
            return {
              restored: false,
              reason: 'capture_cleanup_pending',
              cleanupPending: true,
              cleanupCompleted: false,
              snapshot: restoreSnapshot,
              error,
            };
          }
        }

        const restoreFenceStillCurrent = async () => {
          if (await strictRetained()) return false;
          if (!initialFence.unattended) return true;
          const currentFence = await inspectUnattendedCaptureTaskAttempt({
            taskId,
            attemptId,
          });
          if (await strictRetained()) return false;
          return Boolean(
            currentFence.active &&
              currentFence.lockMatchesTaskAttempt &&
              matchesUnattendedBeginLease(currentFence.lock, initialFence.lock, {
                taskId,
                attemptId,
              }),
          );
        };
        const staleRestoreResult = (reason = 'stale_unattended_attempt') => ({
          restored: false,
          reason,
          staleAttempt: true,
          snapshot: restoreSnapshot,
        });
        let group = null;
        let session = null;
        const discardRestoreAttempt = async () => {
          if (await strictRetained()) return false;
          const activeSession =
            state.captureDebugSessionManager.getSessionByTaskId(taskId);
          const exactActiveSession = Boolean(
            activeSession &&
            String(activeSession.runId || '').trim() ===
              String(restoreSnapshot.runId || '').trim() &&
            String(activeSession.attemptId || '').trim() === attemptId
          );
          if (activeSession && !exactActiveSession) {
            return false;
          }
          if (exactActiveSession) {
            const debugResult = await state.captureDebugSessionManager
              .discardRestoredSession({
                taskId,
                attemptId,
                runId: restoreSnapshot.runId,
              })
              .catch((error) => {
                console.warn(
                  '[CaptureTask] failed to discard fenced restore assist:',
                  error?.message || error,
                );
                return {released: false, reason: 'detach_failed'};
              });
            if (
              debugResult?.released !== true &&
              debugResult?.reason !== 'not_attached'
            ) {
              // Do not forget the native group while Chromium may still have the
              // exact Debug attachment. The cleanup snapshot/session remains
              // authoritative for a later retry.
              return false;
            }
          }
          const currentGroup = state.captureTaskTabGroupManager.getTask(taskId);
          if (await strictRetained()) return false;
          if (
            group &&
            currentGroup &&
            String(currentGroup.attemptId || '').trim() === attemptId &&
            Number(currentGroup.sourceTabId) === Number(group.sourceTabId) &&
            Number(currentGroup.groupId) === Number(group.groupId) &&
            Number(currentGroup.windowId) === Number(group.windowId)
          ) {
            try {
              if (Array.isArray(currentGroup.workerTabIds)) {
                await closeTrackedCaptureTaskWorkerTabs(
                  taskId,
                  currentGroup.workerTabIds,
                );
              }
              if (await strictRetained()) return false;
              const groupResult = await state.captureTaskTabGroupManager.end({
                taskId,
                attemptId,
                sourceTabId: group.sourceTabId,
                groupId: group.groupId,
                reason: 'capture_restore_fence_changed',
              });
              if (
                groupResult?.released !== true &&
                groupResult?.reason !== 'not_grouped'
              ) {
                return false;
              }
            } catch (error) {
              console.warn(
                '[CaptureTask] failed to discard fenced restore group:',
                error?.message || error,
              );
              return false;
            }
          }
          return true;
        };
        const discardRestoreOrKeepPending = async (
          reason = 'stale_unattended_attempt',
        ) => {
          if (await strictRetained()) return strictPending();
          if (await discardRestoreAttempt()) return staleRestoreResult(reason);
          return {
            restored: false,
            reason: 'capture_cleanup_pending',
            cleanupPending: true,
            cleanupCompleted: false,
            snapshot: restoreSnapshot,
          };
        };

        const restoreSourceTabId = resolveCaptureTaskTabId(
          restoreSnapshot.sourceTabId,
          restoreSnapshot.tabId,
        );
        const explicitRestorePlatform = normalizePlatformId(
          restoreSnapshot.platform,
        );
        const pageRestorePlatform = detectPlatformFromUrl(
          restoreSnapshot.pageUrl || '',
        );
        if (
          explicitRestorePlatform !== 'unknown' &&
          pageRestorePlatform !== 'unknown' &&
          explicitRestorePlatform !== pageRestorePlatform
        ) {
          return {
            restored: false,
            reason: 'capture_task_snapshot_platform_mismatch',
            error: createCaptureTaskError(
              'capture_task_snapshot_platform_mismatch',
              '待恢复采集快照的平台信息互相冲突',
            ),
          };
        }
        const expectedRestorePlatform =
          explicitRestorePlatform !== 'unknown'
            ? explicitRestorePlatform
            : pageRestorePlatform;
        if (!new Set(['xiaohongshu', 'douyin']).has(expectedRestorePlatform)) {
          return {
            restored: false,
            reason: 'capture_task_snapshot_platform_missing',
            error: createCaptureTaskError(
              'capture_task_snapshot_platform_missing',
              '待恢复采集快照缺少可验证的平台信息',
            ),
          };
        }

        const validateRestoreSource = async () => {
          if (await strictRetained()) throw createCaptureTaskError(
            'strict_capture_control_retained', '严格停止控制记录仍保留，未恢复旧运行资源');
          let restoreSourceTab;
          try {
            restoreSourceTab = await chrome.tabs.get(restoreSourceTabId);
          } catch (error) {
            throw createCaptureTaskError(
              'capture_task_source_tab_missing',
              '找不到待恢复采集任务的来源页面',
              error,
            );
          }
          if (await strictRetained()) throw createCaptureTaskError(
            'strict_capture_control_retained', '严格停止控制记录仍保留，未恢复旧运行资源');
          const restorePlatform = detectPlatformFromUrl(
            restoreSourceTab?.url || '',
          );
          if (!new Set(['xiaohongshu', 'douyin']).has(restorePlatform)) {
            throw createCaptureTaskError(
              'capture_task_platform_unsupported',
              '待恢复采集任务的来源页面已离开支持的平台',
            );
          }
          if (
            expectedRestorePlatform !== 'unknown' &&
            expectedRestorePlatform !== restorePlatform
          ) {
            throw createCaptureTaskError(
              'capture_task_platform_mismatch',
              '待恢复采集任务的平台与当前来源页面不一致',
            );
          }
          return restoreSourceTab;
        };

        try {
          await validateRestoreSource();
        } catch (error) {
          if (await strictRetained()) return strictPending();
          const normalizedError = error?.code
            ? error
            : createCaptureTaskError(
                'capture_task_source_tab_missing',
                '找不到待恢复采集任务的来源页面',
                error,
              );
          console.warn(
            '[CaptureTask] persisted source validation failed:',
            normalizedError?.message || normalizedError,
          );
          return {
            restored: false,
            reason:
              normalizedError?.code || 'capture_task_source_validation_failed',
            error: normalizedError,
          };
        }
        if (!(await restoreFenceStillCurrent())) {
          if (await strictRetained()) return strictPending();
          return staleRestoreResult();
        }

        let assistDegraded = restoreDetachedAssist;
        try {
          try {
            group = await state.captureTaskTabGroupManager.restore(restoreSnapshot);
          } catch (error) {
            const optionalGroupRestoreFailure = new Set([
              'invalid_capture_task_group_restore',
              'capture_task_group_restore_mismatch',
            ]).has(String(error?.code || ''));
            if (!optionalGroupRestoreFailure) throw error;
            assistDegraded = true;
            // A degraded assist snapshot is resource ownership, not permission to
            // turn Debug back on. The native group may also have disappeared while
            // the MV3 worker was asleep; keep the logical task/session so content
            // capture and an explicit END can still settle normally.
            console.warn(
              '[CaptureTask] detached assist group restore unavailable; page capture continues:',
              error?.message || error,
            );
          }
          if (!(await restoreFenceStillCurrent())) {
            return await discardRestoreOrKeepPending();
          }
          await validateRestoreSource();
          if (await strictRetained()) return strictPending();
          const verifiedWorkerTabIds = group?.workerTabIds || [];
          const normalizedRestoreSnapshot = {
            ...restoreSnapshot,
            state: assistDegraded ? 'detached' : restoreSnapshot.state,
            workerTabIds: verifiedWorkerTabIds,
            groupId: group?.groupId ?? null,
            originalGroupId:
              group?.originalGroupId ?? restoreSnapshot.originalGroupId,
          };
          try {
            session = await state.captureDebugSessionManager.restore(
              normalizedRestoreSnapshot,
              {publishState: false},
            );
          } catch (error) {
            if (
              assistDegraded ||
              String(error?.code || '') !== 'debug_session_restore_failed'
            ) {
              throw error;
            }
            // MV3 may wake after Chromium has already dropped the debugger, or
            // DevTools may now own the target. Neither condition invalidates the
            // content-script task. Preserve a detached logical session so normal
            // progress and END cleanup continue without manufacturing a cancel.
            assistDegraded = true;
            if (!(await restoreFenceStillCurrent())) {
              return await discardRestoreOrKeepPending();
            }
            await validateRestoreSource();
            if (await strictRetained()) return strictPending();
            session = await state.captureDebugSessionManager.restore(
              {
                ...normalizedRestoreSnapshot,
                state: 'detached',
              },
              {publishState: false},
            );
          }
          if (!(await restoreFenceStillCurrent())) {
            return await discardRestoreOrKeepPending();
          }
          await validateRestoreSource();
          if (await strictRetained()) return strictPending();
          const published = await publishRestoredCaptureRuntimeSnapshot(
            restoreSnapshot,
            session,
          );
          if (!published || !(await restoreFenceStillCurrent())) {
            if (published) {
              await clearPersistedCaptureRuntimeSnapshot(session);
            }
            return await discardRestoreOrKeepPending(
              'capture_restore_fence_changed',
            );
          }
          return {
            restored: true,
            session,
            group,
            assistDegraded,
          };
        } catch (error) {
          if (await strictRetained()) return strictPending();
          if (!(await discardRestoreAttempt())) {
            return {
              restored: false,
              reason: 'capture_cleanup_pending',
              cleanupPending: true,
              cleanupCompleted: false,
              snapshot: restoreSnapshot,
              error,
            };
          }
          console.warn(
            '[CaptureTask] persisted runtime restore failed:',
            error?.message || error,
          );
          return {
            restored: false,
            reason: error?.code || 'capture_runtime_restore_failed',
            error,
          };
        }
      })();
      try {
        return await state.captureRuntimeRestorePromise;
      } finally {
        state.captureRuntimeRestorePromise = null;
      }
    }

    return Object.freeze({
      cleanupStaleCaptureRuntimeSession,
      clearPersistedCaptureRuntimeSnapshot,
      publishRestoredCaptureRuntimeSnapshot,
      restorePersistedCaptureRuntimeSession,
    });
  }
  root.OnStarvoiceCaptureLifecycleRestore = Object.freeze({create});
})(globalThis);
