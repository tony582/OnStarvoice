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
        onStateChange: async (session, metadata = {}) => {
          if (session?.persistent && session.taskId) {
            const stateFence = await inspectUnattendedCaptureTaskAttempt({
              taskId: session.taskId,
              attemptId: session.attemptId,
            });
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
        },
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
        stopByTab: (...args) => state.captureDebugSessionManager.stopByTab(...args),
        stopByTaskId: (...args) => state.captureDebugSessionManager.stopByTaskId(...args),
        updateTask: (...args) => state.captureDebugSessionManager.updateTask(...args),
      }),
      tabGroups: Object.freeze({
        getTask: (...args) => state.captureTaskTabGroupManager.getTask(...args),
      }),
      owners: Object.freeze({
        getOwner: (...args) => state.captureTaskOwnerCoordinator.getOwner(...args),
        clearTask: (...args) => state.captureTaskOwnerCoordinator.clearTask(...args),
        attachPort: (...args) => state.captureTaskOwnerCoordinator.attachPort(...args),
        bind: (...args) => state.captureTaskOwnerCoordinator.bind(...args),
      }),
    });
  }
  root.OnStarvoiceCaptureLifecycle = Object.freeze({create});
})(globalThis);
