(function installCaptureExecutionIdentity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module?.exports) {
    module.exports = api;
  }
  root.OnStarvoiceCaptureExecutionIdentity = api;
})(
  typeof globalThis !== 'undefined' ? globalThis : self,
  function createCaptureExecutionIdentityApi() {
    function resolveCaptureTaskTabId(...values) {
      for (const value of values) {
        const tabId = Number(value);
        if (Number.isSafeInteger(tabId) && tabId > 0) return tabId;
      }
      return null;
    }

    function buildUnattendedCaptureTaskId(requestId = '') {
      const normalizedRequestId = String(requestId || '').trim();
      return normalizedRequestId ? `unattended-capture:${normalizedRequestId}` : '';
    }

    function parseStableUnattendedCaptureTaskId(taskId = '') {
      const normalizedTaskId = String(taskId || '').trim();
      const prefix = 'unattended-capture:';
      if (!normalizedTaskId.startsWith(prefix)) {
        return {unattended: false, taskId: normalizedTaskId, requestId: ''};
      }
      const requestId = normalizedTaskId.slice(prefix.length).trim();
      return {
        unattended: Boolean(requestId),
        taskId: normalizedTaskId,
        requestId,
      };
    }

    function isCaptureExecutionLockOwnedByUnattendedAttempt(
      lock,
      request,
    ) {
      if (
        !lock ||
        typeof lock !== 'object' ||
        String(lock.owner || '') !== 'unattended_keyword_plan'
      ) {
        return false;
      }
      const requestId = String(request?.id || '').trim();
      const attemptId = String(request?.attemptId || '').trim();
      if (!requestId || !attemptId) return false;

      const stableTaskId = buildUnattendedCaptureTaskId(requestId);
      const lockTaskId = String(lock.captureTaskId || '').trim();
      const lockAttemptId = String(lock.captureTaskAttemptId || '').trim();
      if (lockTaskId === stableTaskId) {
        return !lockAttemptId || lockAttemptId === attemptId;
      }
      // Older task wrappers could bind a generated child task id while retaining
      // the authoritative unattended attempt id.
      if (lockAttemptId) return lockAttemptId === attemptId;
      if (lockTaskId) return false;

      // A reservation can become terminal before BEGIN binds its stable task id.
      // In that narrow window the exact runner tab is the remaining ownership
      // fence. Do not infer ownership from the global lock alone.
      const holderTabId = resolveCaptureTaskTabId(lock.holderTabId);
      const runnerTabIds = new Set(
        [request.runnerTabId, request.progress?.runnerTabId]
          .map((tabId) => resolveCaptureTaskTabId(tabId))
          .filter(Boolean),
      );
      return Boolean(holderTabId && runnerTabIds.has(holderTabId));
    }

    function buildCaptureExecutionLockStopIdentity(lock) {
      if (!lock || typeof lock !== 'object') return null;
      return {
        id: String(lock.id || ''),
        owner: String(lock.owner || ''),
        holderId: String(lock.holderId || ''),
        holderDocumentId: String(lock.holderDocumentId || ''),
        holderTabId: resolveCaptureTaskTabId(lock.holderTabId),
        captureTaskId: String(lock.captureTaskId || '').trim(),
        captureTaskAttemptId: String(lock.captureTaskAttemptId || '').trim(),
      };
    }

    function captureExecutionLockMatchesStopIdentity(lock, identity) {
      if (!identity) return !lock;
      const actual = buildCaptureExecutionLockStopIdentity(lock);
      return Boolean(
        actual &&
        actual.id === identity.id &&
        actual.owner === identity.owner &&
        actual.holderId === identity.holderId &&
        actual.holderDocumentId === identity.holderDocumentId &&
        actual.holderTabId === identity.holderTabId &&
        actual.captureTaskId === identity.captureTaskId &&
        actual.captureTaskAttemptId === identity.captureTaskAttemptId
      );
    }

    function captureRuntimeSnapshotMatches(current, expected) {
      if (!current || !expected) return false;
      return Boolean(
        String(current.taskId || '').trim() ===
          String(expected.taskId || '').trim() &&
          String(current.runId || '').trim() ===
            String(expected.runId || '').trim() &&
          String(current.attemptId || '').trim() ===
            String(expected.attemptId || '').trim() &&
          resolveCaptureTaskTabId(current.sourceTabId, current.tabId) ===
            resolveCaptureTaskTabId(expected.sourceTabId, expected.tabId),
      );
    }

    return {
      resolveCaptureTaskTabId,
      buildUnattendedCaptureTaskId,
      parseStableUnattendedCaptureTaskId,
      isCaptureExecutionLockOwnedByUnattendedAttempt,
      buildCaptureExecutionLockStopIdentity,
      captureExecutionLockMatchesStopIdentity,
      captureRuntimeSnapshotMatches,
    };
  },
);
