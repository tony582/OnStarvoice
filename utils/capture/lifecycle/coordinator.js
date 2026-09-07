// Single owner of capture-session lifetime. Host storage/lock queues remain host-owned.
(function register(root) {
  const modules = Object.freeze({
    leases: root.OnStarvoiceCaptureLifecycleLeases,
    restore: root.OnStarvoiceCaptureLifecycleRestore,
    admission: root.OnStarvoiceCaptureLifecycleAdmission,
    begin: root.OnStarvoiceCaptureLifecycleBegin,
    progress: root.OnStarvoiceCaptureLifecycleProgress,
    cleanup: root.OnStarvoiceCaptureLifecycleCleanup,
    attempts: root.OnStarvoiceCaptureLifecycleAttempts,
    end: root.OnStarvoiceCaptureLifecycleEnd,
    tabs: root.OnStarvoiceCaptureLifecycleTabs,
  });
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module?.create !== 'function') throw new Error('Missing capture lifecycle module: '+name);
  }
  function create(ports) {
    // Process-local admission barrier only: no new persisted state or queue.
    // Count synchronously, before the first storage/native await, and retain
    // the count until the *real* result settles. Never substitute a timeout.
    let legacyInFlight = 0;
    let strictAdmissionInFlight = false;
    const guardLegacyEntrant = (operation, {asynchronous = false, denied} = {}) => function (...args) {
      if (strictAdmissionInFlight) {
        const result = denied ? denied() : strictAdmissionDenied();
        return asynchronous ? Promise.resolve(result) : result;
      }
      legacyInFlight += 1;
      let released = false;
      const release = () => {
        if (!released) { released = true; legacyInFlight -= 1; }
      };
      try {
        const result = Reflect.apply(operation, this, args);
        if (result && typeof result.then === 'function') {
          // Observe settlement without replacing the original Promise or its
          // rejection: compatible manager facades keep their exact contract.
          Promise.resolve(result).then(release, release);
        } else release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    };
    const strictRetained = async () => {
      if (typeof ports.hasStrictCaptureStopControl !== 'function') return false;
      try { return await ports.hasStrictCaptureStopControl() !== false; } catch { return true; }
    };
    const strictAdmissionDenied = () => ({ok: false, accepted: false,
      resourcesReleased: false, cleanupPending: true, reason: 'legacy_capture_resources_unproven'});
    const state = {
      captureTaskLifecycleQueue: Promise.resolve(),
      captureRuntimeRestorePromise: null,
      captureTaskBeginInFlight: null,
      captureTaskReplacementTabIds: new Map(),
      captureTaskPendingWorkerTabIds: new Map(),
      captureTaskCleanupInProgress: new Set(),
      captureDebugSessionManager: null,
      captureTaskTabGroupManager: null,
      captureTaskOwnerCoordinator: null,
    };
    const operations = Object.create(null);
    operations.runCaptureTaskLifecycleOperation = (operation) => {
      const pending = state.captureTaskLifecycleQueue.then(operation, operation);
      state.captureTaskLifecycleQueue = pending.catch(() => null);
      return pending;
    };
    Object.assign(operations, modules.leases.create({state, ports, operations}));
    Object.assign(operations, modules.restore.create({state, ports, operations}));
    Object.assign(operations, modules.admission.create({state, ports, operations}));
    Object.assign(operations, modules.begin.create({state, ports, operations}));
    Object.assign(operations, modules.progress.create({state, ports, operations}));
    Object.assign(operations, modules.cleanup.create({state, ports, operations}));
    Object.assign(operations, modules.attempts.create({state, ports, operations}));
    Object.assign(operations, modules.end.create({state, ports, operations}));
    Object.assign(operations, modules.tabs.create({state, ports, operations}));
    // Wrap the shared operation table, not only the returned facade. Nested
    // legacy calls are counted but never acquire C a second time for this fence.
    const booleanOperations = new Set([
      'clearPersistedCaptureRuntimeSnapshot', 'publishRestoredCaptureRuntimeSnapshot',
      'replaceCaptureExecutionLockTabId', 'replaceUnattendedRunnerTabId',
      'handleCaptureRuntimeTabReplaced', 'clearCaptureTaskTraceOverlayFailSoft',
      'clearUnattendedCaptureTaskLockBinding',
    ]);
    for (const name of [
      'beginCaptureTask', 'beginCaptureTaskNow', 'endCaptureTask', 'performEndCaptureTask',
      'handleUnexpectedCaptureDebugDetach', 'handleAbandonedCaptureTask',
      'updateCaptureTask', 'registerCaptureTaskTab', 'setCaptureTaskMinimized',
      'cleanupStaleCaptureRuntimeSession', 'clearPersistedCaptureRuntimeSnapshot',
      'publishRestoredCaptureRuntimeSnapshot', 'restorePersistedCaptureRuntimeSession',
      'replaceCaptureExecutionLockTabId', 'replaceUnattendedRunnerTabId',
      'handleCaptureRuntimeTabReplaced', 'handleCaptureRuntimeTabRemoved',
      'closeCaptureTaskWorkerTabs', 'closeTrackedCaptureTaskWorkerTabs',
      'writeCaptureTaskCancellationFailSoft', 'clearCaptureTaskTraceOverlayFailSoft',
      'publishCaptureTaskCancellation', 'relayCaptureTaskCancellation',
      'releaseCaptureTaskResources', 'releaseCaptureTaskResourcesWithRetry',
      'releaseStableUnattendedCaptureTaskResourcesOnly', 'releaseUnattendedCaptureTaskResourcesForRecovery',
      'clearUnattendedCaptureTaskLockBinding', 'recoverUnattendedCaptureTaskInterruption',
      'reclaimSupersededUnattendedCaptureTaskForBegin', 'releaseConfirmedStaleCaptureTaskGroupsForBegin',
    ]) {
      operations[name] = guardLegacyEntrant(operations[name], {
        asynchronous: true, denied: booleanOperations.has(name) ? () => false : strictAdmissionDenied,
      });
    }
    for (const [name, denied] of [
      ['pruneCaptureTaskReplacementTabs', () => undefined],
      ['rememberCaptureTaskReplacementTab', () => false],
      ['resolveCaptureTaskReplacementLease', () => null],
      ['resolveCaptureTaskReplacementTab', () => null],
      ['replaceTrackedCaptureTaskWorkerTab', () => false],
    ]) operations[name] = guardLegacyEntrant(operations[name], {denied});
    // C owns only the synchronous entrant barrier plus idle observation. Leave
    // C before invoking the host callback, whose lock order is Auth -> L -> Q.
    // Holding C or L across that callback would invert the legacy lock order.
    operations.admitStrictCaptureCohort = async (operation) => {
      if (typeof operation !== 'function') {
        return strictAdmissionDenied();
      }
      const idle = async () => {
        if (legacyInFlight !== 0 || state.captureTaskBeginInFlight || state.captureRuntimeRestorePromise ||
            state.captureTaskCleanupInProgress.size || state.captureTaskPendingWorkerTabIds.size ||
            state.captureTaskReplacementTabIds.size ||
            typeof state.captureDebugSessionManager?.getActiveSessions !== 'function' ||
            typeof state.captureTaskTabGroupManager?.getActiveTasks !== 'function') return false;
        const sessions = state.captureDebugSessionManager.getActiveSessions();
        const groups = state.captureTaskTabGroupManager.getActiveTasks();
        if (!Array.isArray(sessions) || sessions.length || !Array.isArray(groups) || groups.length) return false;
        const key = ports.STORAGE_KEYS?.runtime;
        if (typeof key !== 'string' || !key || typeof ports.chrome?.storage?.local?.get !== 'function') return false;
        const stored = await ports.chrome.storage.local.get(key);
        const runtime = stored[key];
        if (runtime != null && (typeof runtime !== 'object' || Array.isArray(runtime) || runtime.captureDebugSession != null)) return false;
        // The storage wait cannot validate an earlier in-memory observation.
        return legacyInFlight === 0 && !state.captureTaskBeginInFlight && !state.captureRuntimeRestorePromise &&
          state.captureTaskCleanupInProgress.size === 0 && state.captureTaskPendingWorkerTabIds.size === 0 &&
          state.captureTaskReplacementTabIds.size === 0 &&
          state.captureDebugSessionManager.getActiveSessions().length === 0 &&
          state.captureTaskTabGroupManager.getActiveTasks().length === 0;
      };
      const admitted = await operations.runCaptureTaskLifecycleOperation(async () => {
        if (strictAdmissionInFlight || legacyInFlight !== 0) return false;
        strictAdmissionInFlight = true;
        try {
          if (await idle()) return true;
          strictAdmissionInFlight = false;
          return false;
        } catch (error) {
          strictAdmissionInFlight = false;
          throw error;
        }
      });
      if (!admitted) return strictAdmissionDenied();
      // No lifecycle/storage queue is held here. The barrier alone prevents
      // legacy work while host authorization, exact lock validation, and the
      // journal CAS wait. Keep it until the callback's real result settles.
      try {
        return await operation();
      } finally {
        strictAdmissionInFlight = false;
      }
    };
    const handleAbandonedCaptureTask = (...args) => operations.handleAbandonedCaptureTask(...args);
    const handleUnexpectedCaptureDebugDetach = (...args) => operations.handleUnexpectedCaptureDebugDetach(...args);
    const inspectUnattendedCaptureTaskAttempt = (...args) => operations.inspectUnattendedCaptureTaskAttempt(...args);
    const {CAPTURE_TASK_GROUP_TITLE, captureRuntimeSnapshotMatches, captureTaskTabGroupApi, chrome, console, debugSessionApi, readRuntimeState, taskOwnerApi, writeRuntimeState} = ports;
    state.captureTaskTabGroupManager =
      captureTaskTabGroupApi.createManager({
        tabsApi: chrome.tabs,
        tabGroupsApi: chrome.tabGroups,
        groupTitle: CAPTURE_TASK_GROUP_TITLE,
      });
    state.captureDebugSessionManager =
      debugSessionApi.createManager({
        debuggerApi: chrome.debugger,
        onStateChange: guardLegacyEntrant(async (session, metadata = {}) => {
          if (await strictRetained()) return;
          if (session?.persistent && session.taskId) {
            const stateFence = await inspectUnattendedCaptureTaskAttempt({
              taskId: session.taskId,
              attemptId: session.attemptId,
            });
            if (await strictRetained()) return;
            if (
              stateFence.unattended &&
              (!stateFence.active || !stateFence.lockMatchesTaskAttempt)
            ) {
              console.warn(
                '[CaptureTask] ignored stale unattended assist state publication',
                {
                  taskId: session.taskId,
                  attemptId: session.attemptId || '',
                  reason: metadata?.reason || '',
                },
              );
              return;
            }
          }
          if (!session && metadata?.previous?.persistent) {
            const currentRuntime = await readRuntimeState();
            if (await strictRetained()) return;
            if (
              !captureRuntimeSnapshotMatches(
                currentRuntime.captureDebugSession,
                metadata.previous,
              )
            ) {
              return;
            }
          }
          if (chrome.action?.setBadgeText) {
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
          if (await strictRetained()) return;
          const previousTaskId = String(metadata?.previous?.taskId || '').trim();
          const preserveCleanupSnapshot = Boolean(
            !session &&
              metadata?.previous?.persistent &&
              previousTaskId &&
              state.captureTaskCleanupInProgress.has(previousTaskId),
          );
          const runtimeSession = preserveCleanupSnapshot
            ? {
                ...metadata.previous,
                state: 'detaching',
                cleanupPending: true,
              }
            : session;
          const patch = {captureDebugSession: runtimeSession};
          if (session?.persistent && session.progress) {
            patch.lastCaptureProgress = session.progress;
          } else if (session && metadata.reason === 'capture_started') {
            patch.lastCaptureProgress = {
              phase: 'debug_session_attached',
              message: `采集辅助运行中 · ${session.label}`,
              ...(session.persistent
                ? {captureTaskId: session.taskId}
                : {listCaptureRunId: session.runId}),
              debugSessionState: session.state,
              debugSessionTabId: session.tabId,
              updatedAt: new Date().toISOString(),
            };
          }
          await writeRuntimeState((current) => {
            if (
              !session &&
              metadata?.previous?.persistent &&
              !captureRuntimeSnapshotMatches(
                current.captureDebugSession,
                metadata.previous,
              )
            ) {
              return {};
            }
            return patch;
          });
        }, {asynchronous: true}),
        onUnexpectedDetach: async ({session, reason}) => {
          await handleUnexpectedCaptureDebugDetach({session, reason});
        },
      });
    state.captureTaskOwnerCoordinator =
      taskOwnerApi.createCoordinator({
        onAbandoned: handleAbandonedCaptureTask,
      });
    Object.freeze(operations);
    return Object.freeze({
      ...operations,
      isCaptureTaskCleanupInProgress: (taskId) => state.captureTaskCleanupInProgress.has(taskId),
      // Explicit compatibility ports for existing host consumers. Keep each call
      // synchronous/asynchronous exactly as its manager method; do not requeue it.
      // Manager instances and their mutable method tables remain private.
      debugSessions: Object.freeze({
        getSessionByTaskId: (...args) => state.captureDebugSessionManager.getSessionByTaskId(...args),
        getSession: (...args) => state.captureDebugSessionManager.getSession(...args),
        getActiveSessions: (...args) => state.captureDebugSessionManager.getActiveSessions(...args),
        stopByTab: guardLegacyEntrant((...args) => typeof ports.hasStrictCaptureStopControl !== 'function'
          ? state.captureDebugSessionManager.stopByTab(...args)
          : strictRetained().then(retained => retained ? strictAdmissionDenied() : state.captureDebugSessionManager.stopByTab(...args))),
        stopByTaskId: guardLegacyEntrant((...args) => typeof ports.hasStrictCaptureStopControl !== 'function'
          ? state.captureDebugSessionManager.stopByTaskId(...args)
          : strictRetained().then(retained => retained ? strictAdmissionDenied() : state.captureDebugSessionManager.stopByTaskId(...args))),
        updateTask: guardLegacyEntrant((...args) => typeof ports.hasStrictCaptureStopControl !== 'function'
          ? state.captureDebugSessionManager.updateTask(...args)
          : strictRetained().then(retained => retained ? strictAdmissionDenied() : state.captureDebugSessionManager.updateTask(...args))),
      }),
      tabGroups: Object.freeze({
        getTask: (...args) => state.captureTaskTabGroupManager.getTask(...args),
      }),
      owners: Object.freeze({
        getOwner: (...args) => state.captureTaskOwnerCoordinator.getOwner(...args),
        clearTask: guardLegacyEntrant((...args) => state.captureTaskOwnerCoordinator.clearTask(...args)),
        attachPort: guardLegacyEntrant((...args) => state.captureTaskOwnerCoordinator.attachPort(...args)),
        bind: guardLegacyEntrant((...args) => state.captureTaskOwnerCoordinator.bind(...args)),
      }),
    });
  }
  root.OnStarvoiceCaptureLifecycle = Object.freeze({create});
})(globalThis);
