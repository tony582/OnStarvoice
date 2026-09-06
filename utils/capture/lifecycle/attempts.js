// L1: attempts responsibility. Existing behavior, explicit host ports, one shared lifecycle owner.
(function register(root) {
  function create({state, ports, operations}) {
    const {
      STORAGE_KEYS,
      UNATTENDED_RUNNER_QUERY_KEY,
      buildUnattendedCaptureTaskId,
      chrome,
      isTerminalUnattendedRunStatus,
      normalizeCaptureExecutionLock,
      normalizeUnattendedRunRequest,
      parseStableUnattendedCaptureTaskId,
      readStoredCaptureExecutionLock,
      readUnattendedKeywordRunRequest,
      recoverUnattendedKeywordRunRequest,
      resolveCaptureTaskTabId,
      runAuthoritativeControlStorageMutation,
      runCaptureExecutionLockOperation,
      terminalizeCaptureTaskLedgerRun,
    } = ports;
    const createCaptureTaskError = (...args) => operations.createCaptureTaskError(...args);
    const getTrackedCaptureTaskWorkers = (...args) => operations.getTrackedCaptureTaskWorkers(...args);
    const releaseCaptureTaskResourcesWithRetry = (...args) => operations.releaseCaptureTaskResourcesWithRetry(...args);
    const resolveCaptureTaskReplacementLease = (...args) => operations.resolveCaptureTaskReplacementLease(...args);

    async function inspectStableUnattendedCaptureTask(taskId = '') {
      const identity = parseStableUnattendedCaptureTaskId(taskId);
      if (!identity.unattended) {
        return {...identity, current: false, active: false, terminal: false, request: null};
      }
      const request = await readUnattendedKeywordRunRequest();
      const current = Boolean(request && String(request.id || '').trim() === identity.requestId);
      const terminal = Boolean(current && isTerminalUnattendedRunStatus(request.status));
      return {
        ...identity,
        current,
        active: Boolean(current && !terminal),
        terminal,
        request: current ? request : null,
      };
    }

    async function releaseStableUnattendedCaptureTaskResourcesOnly(
      inspection,
      {reason = 'unattended_wrapper_cleanup', debugSnapshot = null} = {},
    ) {
      // STRICT_RESOURCE_FENCE_BEGIN: the pinned legacy tail below is unchanged.
      if (Object.hasOwn(arguments[1] || {}, 'strictResources')) {
        return await releaseCaptureTaskResourcesWithRetry({
          taskId: inspection?.taskId, reason,
          strictResources: arguments[1].strictResources,
        }, {attempts: 1});
      }
      // STRICT_RESOURCE_FENCE_END
      if (!inspection?.unattended || !inspection?.taskId) {
        return {released: false, reason: 'not_unattended_stable_task'};
      }
      const taskId = inspection.taskId;
      const storedLock = await readStoredCaptureExecutionLock();
      const lockOwnsTask = Boolean(
        storedLock &&
          String(storedLock.owner || '') === 'unattended_keyword_plan' &&
          String(storedLock.captureTaskId || '').trim() === taskId,
      );
      if (lockOwnsTask) {
        return await releaseUnattendedCaptureTaskResourcesForRecovery(
          storedLock,
          {
            reason,
            request: inspection.request || {id: inspection.requestId},
          },
        );
      }

      const session =
        debugSnapshot || state.captureDebugSessionManager.getSessionByTaskId(taskId);
      const group = state.captureTaskTabGroupManager.getTask(taskId);
      const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(taskId);
      if (session || group || pendingWorkerTabIds.length > 0) {
        return await releaseCaptureTaskResourcesWithRetry(
          {taskId, reason, debugSnapshot: session},
          {attempts: 3},
        );
      }
      state.captureTaskOwnerCoordinator?.clearTask(taskId);
      return {released: true, taskId, reason: 'already_absent'};
    }

    async function readUnattendedParentForCaptureTask(taskId = '') {
      const normalizedTaskId = String(taskId || '').trim();
      if (!normalizedTaskId) return null;
      const [lock, request] = await Promise.all([
        readStoredCaptureExecutionLock(),
        readUnattendedKeywordRunRequest(),
      ]);
      if (
        String(lock?.owner || '') !== 'unattended_keyword_plan' ||
        !request ||
        isTerminalUnattendedRunStatus(request.status)
      ) {
        return null;
      }
      const stableTaskId = buildUnattendedCaptureTaskId(request.id);
      if (
        String(lock.captureTaskId || '').trim() !== normalizedTaskId &&
        stableTaskId !== normalizedTaskId
      ) {
        return null;
      }
      return {lock, request, stableTaskId};
    }

    async function inspectUnattendedCaptureTaskAttempt({
      taskId = '',
      attemptId = '',
    } = {}) {
      const normalizedTaskId = String(taskId || '').trim();
      const incomingAttemptId = String(attemptId || '').trim();
      const stableIdentity = parseStableUnattendedCaptureTaskId(normalizedTaskId);
      if (!stableIdentity.unattended) {
        return {unattended: false, current: true};
      }
      const [lock, request] = await Promise.all([
        readStoredCaptureExecutionLock(),
        readUnattendedKeywordRunRequest(),
      ]);
      const requestMatches = Boolean(
        request && String(request.id || '').trim() === stableIdentity.requestId,
      );
      const terminal = Boolean(
        requestMatches && isTerminalUnattendedRunStatus(request.status),
      );
      const unattendedLock = Boolean(
        lock && String(lock.owner || '') === 'unattended_keyword_plan',
      );
      const boundAttemptId =
        unattendedLock &&
        String(lock?.captureTaskId || '').trim() === normalizedTaskId
          ? String(lock?.captureTaskAttemptId || '').trim()
          : '';
      const currentAttemptId =
        boundAttemptId ||
        (requestMatches ? String(request.attemptId || '').trim() : '');
      const current = Boolean(
        requestMatches &&
          incomingAttemptId &&
          currentAttemptId &&
          incomingAttemptId === currentAttemptId
      );
      const lockMatchesTaskAttempt = Boolean(
        unattendedLock &&
          String(lock?.captureTaskId || '').trim() === normalizedTaskId &&
          String(lock?.captureTaskAttemptId || '').trim() === incomingAttemptId
      );
      return {
        unattended: true,
        current,
        active: Boolean(current && !terminal),
        terminal,
        hasUnattendedLock: unattendedLock,
        lockMatchesTaskAttempt,
        lock,
        incomingAttemptId,
        currentAttemptId,
        request: requestMatches ? request : null,
        requestId: stableIdentity.requestId,
      };
    }

    function matchesUnattendedBeginLease(
      actualLock,
      expectedLock,
      {taskId = '', attemptId = ''} = {},
    ) {
      const stableLeaseMatches = Boolean(
        actualLock &&
          expectedLock &&
          String(actualLock.id || '') === String(expectedLock.id || '') &&
          String(actualLock.owner || '') === String(expectedLock.owner || '') &&
          String(actualLock.holderId || '') ===
            String(expectedLock.holderId || '') &&
          String(actualLock.holderDocumentId || '') ===
            String(expectedLock.holderDocumentId || '') &&
          String(actualLock.captureTaskId || '').trim() ===
            String(expectedLock.captureTaskId || '').trim() &&
          String(actualLock.captureTaskAttemptId || '').trim() ===
            String(expectedLock.captureTaskAttemptId || '').trim()
      );
      if (!stableLeaseMatches) return false;

      const actualTabId = resolveCaptureTaskTabId(actualLock.holderTabId);
      const expectedTabId = resolveCaptureTaskTabId(expectedLock.holderTabId);
      if (actualTabId === expectedTabId) return true;
      const replacement = resolveCaptureTaskReplacementLease(expectedTabId, {
        taskId:
          String(taskId || '').trim() ||
          String(expectedLock.captureTaskId || '').trim(),
        attemptId:
          String(attemptId || '').trim() ||
          String(expectedLock.captureTaskAttemptId || '').trim(),
      });
      return Boolean(replacement && replacement.tabId === actualTabId);
    }

    function describeUnattendedBeginFenceMismatch(actualFence, expectedLock) {
      const actualLock = actualFence?.lock || null;
      return {
        current: actualFence?.current === true,
        active: actualFence?.active === true,
        lockMatchesTaskAttempt: actualFence?.lockMatchesTaskAttempt === true,
        expected: {
          lockId: String(expectedLock?.id || ''),
          owner: String(expectedLock?.owner || ''),
          holderId: String(expectedLock?.holderId || ''),
          holderDocumentId: String(expectedLock?.holderDocumentId || ''),
          holderTabId: resolveCaptureTaskTabId(expectedLock?.holderTabId),
          captureTaskId: String(expectedLock?.captureTaskId || ''),
          attemptId: String(expectedLock?.captureTaskAttemptId || ''),
        },
        actual: {
          lockId: String(actualLock?.id || ''),
          owner: String(actualLock?.owner || ''),
          holderId: String(actualLock?.holderId || ''),
          holderDocumentId: String(actualLock?.holderDocumentId || ''),
          holderTabId: resolveCaptureTaskTabId(actualLock?.holderTabId),
          captureTaskId: String(actualLock?.captureTaskId || ''),
          attemptId: String(actualLock?.captureTaskAttemptId || ''),
        },
      };
    }

    async function clearUnattendedCaptureTaskLockBinding(
      lockId,
      taskId,
      {
        expectedHolderId = '',
        expectedHolderDocumentId = '',
        expectedHolderTabId = null,
      } = {},
    ) {
      const normalizedLockId = String(lockId || '').trim();
      const normalizedTaskId = String(taskId || '').trim();
      if (!normalizedLockId || !normalizedTaskId) return false;
      const clearBinding = () => runCaptureExecutionLockOperation(async () => {
        const stored = await chrome.storage.local.get(
          STORAGE_KEYS.captureExecutionLock,
        );
        const lock = normalizeCaptureExecutionLock(
          stored[STORAGE_KEYS.captureExecutionLock],
          {allowExpired: true},
        );
        if (
          !lock ||
          lock.id !== normalizedLockId ||
          String(lock.owner || '') !== 'unattended_keyword_plan' ||
          String(lock.captureTaskId || '').trim() !== normalizedTaskId ||
          (expectedHolderId &&
            String(lock.holderId || '') !== String(expectedHolderId)) ||
          (expectedHolderDocumentId &&
            String(lock.holderDocumentId || '') !==
              String(expectedHolderDocumentId)) ||
          (resolveCaptureTaskTabId(expectedHolderTabId) &&
            resolveCaptureTaskTabId(lock.holderTabId) !==
              resolveCaptureTaskTabId(expectedHolderTabId))
        ) {
          return false;
        }
        await chrome.storage.local.set({
          [STORAGE_KEYS.captureExecutionLock]: {
            ...lock,
            captureTaskId: '',
            captureTaskAttemptId: '',
            updatedAt: new Date().toISOString(),
          },
        });
        return true;
      });
      return await runAuthoritativeControlStorageMutation(clearBinding);
    }

    async function releaseUnattendedCaptureTaskResourcesForRecovery(
      lock,
      {
        reason = 'unattended_runtime_recovery',
        request = null,
        preserveLockBinding = false,
      } = {},
    ) {
      // STRICT_RESOURCE_FENCE_BEGIN: the pinned legacy tail below is unchanged.
      if (Object.hasOwn(arguments[1] || {}, 'strictResources')) {
        return await releaseCaptureTaskResourcesWithRetry({
          taskId: lock?.captureTaskId, reason,
          strictResources: arguments[1].strictResources,
        }, {attempts: 1});
      }
      // STRICT_RESOURCE_FENCE_END
      // Recovery can clear the persisted lock binding before every asynchronous
      // Debug/group/worker cleanup callback has finished.  The replacement runner
      // still uses the stable request task id, so an empty captureTaskId must not
      // make those residual resources invisible to the next recovery attempt.
      const stableTaskId = buildUnattendedCaptureTaskId(request?.id);
      const taskId = String(lock?.captureTaskId || stableTaskId || '').trim();
      if (!taskId) return {released: false, reason: 'no_capture_task'};
      const debugSnapshot = state.captureDebugSessionManager.getSessionByTaskId(taskId);
      const groupSnapshot = state.captureTaskTabGroupManager.getTask(taskId);
      const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(taskId);
      if (debugSnapshot || groupSnapshot || pendingWorkerTabIds.length > 0) {
        await releaseCaptureTaskResourcesWithRetry(
          {taskId, reason, debugSnapshot},
          {attempts: 3},
        );
      } else {
        state.captureTaskOwnerCoordinator?.clearTask(taskId);
      }
      if (!preserveLockBinding) {
        await clearUnattendedCaptureTaskLockBinding(lock?.id, taskId, {
          expectedHolderId: lock?.holderId,
          expectedHolderDocumentId: lock?.holderDocumentId,
          expectedHolderTabId: lock?.holderTabId,
        });
      }

      // 0.3.43 及更早版本为每次 runner 生成随机 child task。只收口这类
      // 旧记录；新版使用同一 request 的稳定 taskId，恢复后仍是同一项任务。
      if (!stableTaskId || taskId !== stableTaskId) {
        await terminalizeCaptureTaskLedgerRun(taskId, {
          reason: 'unattended_attempt_replaced',
          status: 'canceled',
          message: '无人值守运行页已迁移，旧采集辅助会话已释放',
        });
      }
      return {released: true, taskId};
    }

    async function recoverUnattendedCaptureTaskInterruption({
      taskId = '',
      reason = 'runtime_interrupted',
    } = {}) {
      const parent = await readUnattendedParentForCaptureTask(taskId);
      if (!parent) return {handled: false, reason: 'not_unattended'};
      const recovery = await recoverUnattendedKeywordRunRequest(parent.request, {
        healthy: false,
        reason,
      });
      return {handled: true, recovery};
    }

    function readUnattendedRequestIdFromSender(sender = null) {
      const candidateUrls = [sender?.url, sender?.tab?.url];
      for (const candidate of candidateUrls) {
        try {
          const url = new URL(String(candidate || ''));
          const requestId = String(
            url.searchParams.get(UNATTENDED_RUNNER_QUERY_KEY) || '',
          ).trim();
          if (requestId) return requestId;
        } catch {
          // Ignore non-URL sender metadata.
        }
      }
      return '';
    }

    async function assertUnattendedBeginCleanupFence({
      expectedLock = null,
      requestId = '',
      attemptId = '',
    } = {}) {
      const normalizedRequestId = String(requestId || '').trim();
      const normalizedAttemptId = String(attemptId || '').trim();
      return await runCaptureExecutionLockOperation(async () => {
        const stored = await chrome.storage.local.get([
          STORAGE_KEYS.captureExecutionLock,
          STORAGE_KEYS.unattendedKeywordRunRequest,
        ]);
        const lock = normalizeCaptureExecutionLock(
          stored[STORAGE_KEYS.captureExecutionLock],
          {allowExpired: true},
        );
        const request = normalizeUnattendedRunRequest(
          stored[STORAGE_KEYS.unattendedKeywordRunRequest],
        );
        const expectedHolderTabId = resolveCaptureTaskTabId(
          expectedLock?.holderTabId,
        );
        const holderSnapshotMatches = Boolean(
          lock &&
            expectedLock &&
            String(lock.owner || '') === 'unattended_keyword_plan' &&
            lock.id === String(expectedLock.id || '') &&
            String(lock.holderId || '') ===
              String(expectedLock.holderId || '') &&
            String(lock.holderDocumentId || '') ===
              String(expectedLock.holderDocumentId || '') &&
            resolveCaptureTaskTabId(lock.holderTabId) === expectedHolderTabId &&
            String(lock.captureTaskId || '').trim() ===
              String(expectedLock.captureTaskId || '').trim() &&
            String(lock.captureTaskAttemptId || '').trim() ===
              String(expectedLock.captureTaskAttemptId || '').trim()
        );
        const requestSnapshotMatches = Boolean(
          request &&
            String(request.id || '').trim() === normalizedRequestId &&
            (!normalizedAttemptId ||
              String(request.attemptId || '').trim() === normalizedAttemptId) &&
            !isTerminalUnattendedRunStatus(request.status)
        );
        if (!holderSnapshotMatches || !requestSnapshotMatches) {
          throw createCaptureTaskError(
            'unattended_runner_mismatch',
            '无人值守运行页凭证已更换，已忽略旧页面的采集辅助请求',
          );
        }
        return {lock, request};
      });
    }

    async function reclaimSupersededUnattendedCaptureTaskForBegin({
      taskId,
      sourceTabId,
      attemptId,
      sender,
    } = {}) {
      const normalizedTaskId = String(taskId || '').trim();
      const normalizedSourceTabId = resolveCaptureTaskTabId(sourceTabId);
      const [lock, request] = await Promise.all([
        readStoredCaptureExecutionLock(),
        readUnattendedKeywordRunRequest(),
      ]);
      if (
        !normalizedTaskId ||
        !normalizedSourceTabId ||
        String(lock?.owner || '') !== 'unattended_keyword_plan' ||
        !request ||
        isTerminalUnattendedRunStatus(request.status)
      ) {
        return {unattended: false, reclaimed: false};
      }

      const senderRequestId = readUnattendedRequestIdFromSender(sender);
      const senderDocumentId = String(sender?.documentId || '').trim();
      const senderRunnerTabId = resolveCaptureTaskTabId(sender?.tab?.id);
      const authorizedRunner = Boolean(
        (senderRequestId && senderRequestId === String(request.id || '').trim()) &&
          ((!lock.holderDocumentId ||
            senderDocumentId === String(lock.holderDocumentId || '').trim()) ||
            (!senderDocumentId &&
              senderRunnerTabId === resolveCaptureTaskTabId(request.runnerTabId))),
      );
      const stableTaskId = buildUnattendedCaptureTaskId(request.id);
      const attemptFence = await inspectUnattendedCaptureTaskAttempt({
        taskId: normalizedTaskId,
        attemptId,
      });
      if (attemptFence.unattended && !attemptFence.current) {
        throw createCaptureTaskError(
          'stale_unattended_attempt',
          '旧无人值守运行页已失效，已忽略其采集辅助请求',
        );
      }
      if (!authorizedRunner) {
        if (normalizedTaskId === stableTaskId) {
          throw createCaptureTaskError(
            'unattended_runner_mismatch',
            '无人值守运行页凭证已更换，已忽略旧页面的采集辅助请求',
          );
        }
        return {unattended: false, reclaimed: false};
      }

      const previousTaskId = String(lock.captureTaskId || '').trim();
      const recoveryTaskId = previousTaskId || stableTaskId;
      const previousSession = recoveryTaskId
        ? state.captureDebugSessionManager.getSessionByTaskId(recoveryTaskId)
        : null;
      const previousGroup = recoveryTaskId
        ? state.captureTaskTabGroupManager.getTask(recoveryTaskId)
        : null;
      const previousWorkerTabIds = recoveryTaskId
        ? getTrackedCaptureTaskWorkers(recoveryTaskId)
        : [];
      const sourceChanged = Boolean(
        previousSession &&
          resolveCaptureTaskTabId(previousSession.tabId) !== normalizedSourceTabId,
      );
      const groupSourceChanged = Boolean(
        previousGroup &&
          resolveCaptureTaskTabId(previousGroup.sourceTabId) !==
            normalizedSourceTabId,
      );
      const attemptChanged = Boolean(
        previousSession &&
          recoveryTaskId === normalizedTaskId &&
          String(previousSession.attemptId || '').trim() !==
            String(attemptId || '').trim(),
      );
      const residualCleanupPending = Boolean(
        recoveryTaskId === normalizedTaskId &&
          // getTrackedCaptureTaskWorkers() without snapshots only exposes worker
          // tabs whose earlier close failed; live session/group workers are not in
          // this set and must not cause a healthy duplicate BEGIN to be released.
          ((!previousSession && previousGroup) ||
            previousWorkerTabIds.length > 0),
      );
      if (
        recoveryTaskId &&
        (recoveryTaskId !== normalizedTaskId ||
          sourceChanged ||
          groupSourceChanged ||
          attemptChanged ||
          residualCleanupPending)
      ) {
        const cleanupFence = await assertUnattendedBeginCleanupFence({
          expectedLock: lock,
          requestId: request.id,
          attemptId,
        });
        await releaseUnattendedCaptureTaskResourcesForRecovery(
          {...cleanupFence.lock, captureTaskId: recoveryTaskId},
          {
            reason: 'unattended_runner_rebound',
            request: cleanupFence.request,
            // The caller already proved the new attempt owns this stable lock.
            // Releasing the old attempt's browser resources must not erase the
            // replacement attempt binding while BEGIN continues.
            preserveLockBinding: true,
          },
        );
      }
      return {
        unattended: true,
        reclaimed: Boolean(previousTaskId),
        request,
      };
    }

    return Object.freeze({
      inspectStableUnattendedCaptureTask,
      releaseStableUnattendedCaptureTaskResourcesOnly,
      readUnattendedParentForCaptureTask,
      inspectUnattendedCaptureTaskAttempt,
      matchesUnattendedBeginLease,
      describeUnattendedBeginFenceMismatch,
      clearUnattendedCaptureTaskLockBinding,
      releaseUnattendedCaptureTaskResourcesForRecovery,
      recoverUnattendedCaptureTaskInterruption,
      readUnattendedRequestIdFromSender,
      assertUnattendedBeginCleanupFence,
      reclaimSupersededUnattendedCaptureTaskForBegin,
    });
  }
  root.OnStarvoiceCaptureLifecycleAttempts = Object.freeze({create});
})(globalThis);
