(function installCaptureDebugSession(root, factory) {
  const api = factory();
  if (typeof module === "object" && module?.exports) {
    module.exports = api;
  }
  root.OnStarvoiceCaptureDebugSession = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function createCaptureDebugSessionApi() {
    const PROTOCOL_VERSION = "1.3";
    const LIST_CAPTURE_ACTIONS = new Set([
      "captureBloggerNotes",
      "captureKeywordNotes",
    ]);

    function cleanText(value, maxLength = 320) {
      return String(value || "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
    }

    function normalizeTabId(value) {
      const tabId = Number(value);
      return Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null;
    }

    function normalizeGroupId(value) {
      if (value === null || value === undefined || value === "") return null;
      const groupId = Number(value);
      return Number.isSafeInteger(groupId) && groupId >= 0 ? groupId : null;
    }

    function normalizeWorkerTabIds(value, sourceTabId = null) {
      if (!Array.isArray(value)) return [];
      return Array.from(
        new Set(
          value
            .map(normalizeTabId)
            .filter((tabId) => tabId && tabId !== sourceTabId),
        ),
      );
    }

    function normalizeProgress(value) {
      if (value == null) return null;
      if (typeof value !== "object") {
        return {message: cleanText(value, 320)};
      }
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return null;
      }
    }

    function resolveListRelayRunId(value, createId) {
      const requestedRunId = String(value || "").trim();
      if (requestedRunId && requestedRunId.length <= 320) {
        return requestedRunId;
      }
      const generatedId = cleanText(
        typeof createId === "function" ? createId() : "",
        280,
      );
      if (!generatedId) {
        throw createError(
          "list_capture_run_id_unavailable",
          "无法为列表采集创建独立的子运行编号",
        );
      }
      return `capture-debug:${generatedId}`;
    }

    function createError(code, message, cause = null) {
      const error = new Error(message);
      error.code = code;
      if (cause) error.cause = cause;
      return error;
    }

    function publicSession(session, overrides = {}) {
      if (!session) return null;
      const result = {
        version: 1,
        tabId: session.tabId,
        runId: session.runId,
        label: session.label,
        state: session.state,
        startedAt: session.startedAt,
        ...(session.pageTitle ? {pageTitle: session.pageTitle} : {}),
        ...(session.pageUrl ? {pageUrl: session.pageUrl} : {}),
        ...(session.platform ? {platform: session.platform} : {}),
      };
      if (session.persistent) {
        result.persistent = true;
        result.taskId = session.taskId;
        result.progress = normalizeProgress(session.progress);
        result.workerTabIds = [...session.workerTabIds];
        result.groupId = session.groupId;
        result.originalGroupId = session.originalGroupId;
        result.minimized = Boolean(session.minimized);
        result.activeListRunId = session.activeListRunId || "";
      }
      return {...result, ...overrides};
    }

    function isListCaptureAction(action) {
      return LIST_CAPTURE_ACTIONS.has(cleanText(action, 80));
    }

    function createManager({
      debuggerApi,
      now = () => Date.now(),
      onStateChange = null,
      onUnexpectedDetach = null,
      replacementGraceMs = 1200,
      setTimeoutFn = (...args) => setTimeout(...args),
      clearTimeoutFn = (timerId) => clearTimeout(timerId),
    } = {}) {
      if (
        !debuggerApi ||
        typeof debuggerApi.attach !== "function" ||
        typeof debuggerApi.detach !== "function" ||
        typeof debuggerApi.sendCommand !== "function"
      ) {
        throw createError(
          "debug_api_unavailable",
          "当前浏览器没有提供 AI Debug Session 能力",
        );
      }

      const sessionsByTab = new Map();
      const pendingAttachesByTab = new Map();
      const pendingReplacementDetachesByTab = new Map();
      const expectedDetachTabs = new Set();
      let mutationQueue = Promise.resolve();

      function enqueue(task) {
        const next = mutationQueue.then(task, task);
        mutationQueue = next.catch(() => undefined);
        return next;
      }

      async function publish(session, metadata = {}) {
        if (typeof onStateChange !== "function") return;
        try {
          await Promise.resolve(
            onStateChange(
              session ? publicSession(session, metadata) : null,
              metadata,
            ),
          );
        } catch (error) {
          console.warn(
            "[CaptureDebugSession] state publication failed (ignored):",
            error?.message || error,
          );
        }
      }

      async function applyFocusEmulation(tabId, enabled) {
        await debuggerApi.sendCommand(
          {tabId},
          "Emulation.setFocusEmulationEnabled",
          {enabled: Boolean(enabled)},
        );
      }

      function dispatchUnexpectedDetach(event) {
        if (typeof onUnexpectedDetach !== "function") return;
        // Do not await the owner cleanup while holding mutationQueue. Persistent
        // cleanup calls stopByTaskId(), which must be allowed to enqueue behind
        // the current detach mutation instead of waiting on itself forever.
        void Promise.resolve()
          .then(() => onUnexpectedDetach(event))
          .catch((error) => {
            console.warn(
              "[CaptureDebugSession] unexpected detach callback failed:",
              error?.message || error,
            );
          });
      }

      function findSessionByTaskId(taskId) {
        const normalizedTaskId = cleanText(taskId, 320);
        if (!normalizedTaskId) return null;
        for (const session of sessionsByTab.values()) {
          if (session.persistent && session.taskId === normalizedTaskId) {
            return session;
          }
        }
        return null;
      }

      function cancelPendingReplacementDetach(tabId) {
        const normalizedTabId = normalizeTabId(tabId);
        const pending = normalizedTabId
          ? pendingReplacementDetachesByTab.get(normalizedTabId)
          : null;
        if (!pending) return false;
        clearTimeoutFn(pending.timerId);
        pendingReplacementDetachesByTab.delete(normalizedTabId);
        return true;
      }

      async function finalizeUnexpectedDetach(
        session,
        normalizedReason,
        {notifyUnexpected = true} = {},
      ) {
        if (!session) return false;
        session.state = "detached";
        const detachedSnapshot = publicSession(session, {state: "detached"});
        await publish(session, {
          reason: normalizedReason,
          cleanupPending: Boolean(session.persistent),
        });
        if (
          !session.persistent &&
          sessionsByTab.get(session.tabId) === session
        ) {
          sessionsByTab.delete(session.tabId);
          await publish(null, {
            reason: normalizedReason,
            previous: detachedSnapshot,
          });
        }
        if (notifyUnexpected) {
          dispatchUnexpectedDetach({
            reason: normalizedReason,
            session: detachedSnapshot,
          });
        }
        return true;
      }

      async function recoverSourceOnSameTab(
        session,
        normalizedReason,
      ) {
        const sessionTabId = normalizeTabId(session?.tabId);
        if (
          !session ||
          !sessionTabId ||
          sessionsByTab.get(sessionTabId) !== session
        ) {
          return false;
        }

        const debuggee = {tabId: sessionTabId};
        const pendingAttach = {detached: false, reason: ""};
        let attached = false;
        pendingAttachesByTab.set(sessionTabId, pendingAttach);
        try {
          await debuggerApi.attach(debuggee, PROTOCOL_VERSION);
          attached = true;
          await applyFocusEmulation(sessionTabId, true);
          if (pendingAttach.detached) {
            throw createError(
              "debug_session_detached_during_recovery",
              "浏览器页面仍在切换，AI Debug 暂未恢复",
            );
          }
          session.state = "attached";
          await publish(session, {
            reason: "capture_task_source_target_recovered",
            detachReason: normalizedReason,
          });
          return true;
        } catch (error) {
          if (attached) {
            expectedDetachTabs.add(sessionTabId);
            try {
              await debuggerApi.detach(debuggee).catch(() => null);
            } finally {
              expectedDetachTabs.delete(sessionTabId);
            }
          }
          return false;
        } finally {
          if (pendingAttachesByTab.get(sessionTabId) === pendingAttach) {
            pendingAttachesByTab.delete(sessionTabId);
          }
        }
      }

      function scheduleSourceDetachRecovery(
        session,
        normalizedReason,
      ) {
        const sessionTabId = normalizeTabId(session?.tabId);
        if (!sessionTabId) return false;
        cancelPendingReplacementDetach(sessionTabId);
        const graceMs = Math.max(0, Number(replacementGraceMs) || 0);
        const pending = {
          session,
          reason: normalizedReason,
          timerId: null,
        };
        pending.timerId = setTimeoutFn(() => {
          void enqueue(async () => {
            if (
              pendingReplacementDetachesByTab.get(sessionTabId) !== pending
            ) {
              return false;
            }
            pendingReplacementDetachesByTab.delete(sessionTabId);
            if (sessionsByTab.get(sessionTabId) !== session) {
              return false;
            }
            if (
              await recoverSourceOnSameTab(
                session,
                normalizedReason,
              )
            ) {
              return true;
            }
            if (!session.persistent) {
              // A renderer target can disappear while the visible profile Tab
              // and its content script keep running. Losing focus emulation is
              // recoverable for a one-off list relay; relaying cancelCapture
              // here would turn Edge's internal target rebuild into a fake
              // user stop and discard the account scan.
              return await finalizeUnexpectedDetach(
                session,
                "target_closed_debug_degraded",
                {notifyUnexpected: false},
              );
            }
            return await finalizeUnexpectedDetach(
              session,
              normalizedReason,
            );
          });
        }, graceMs);
        pendingReplacementDetachesByTab.set(sessionTabId, pending);
        return true;
      }

      async function start({
        tabId,
        runId,
        label = "列表采集",
        pageTitle = "",
        pageUrl = "",
        platform = "",
        persistent = false,
        taskId = "",
        progress = null,
        workerTabIds = [],
        groupId = null,
        originalGroupId = null,
        minimized = false,
        activeListRunId = "",
      } = {}) {
        return enqueue(async () => {
          const normalizedTabId = normalizeTabId(tabId);
          const normalizedRunId = cleanText(runId, 320);
          const normalizedLabel = cleanText(label, 120) || "列表采集";
          const normalizedPageTitle = cleanText(pageTitle, 180);
          const normalizedPageUrl = cleanText(pageUrl, 800);
          const normalizedPlatform = cleanText(platform, 40).toLowerCase();
          const normalizedPersistent = Boolean(persistent);
          const normalizedTaskId = cleanText(taskId, 320);
          if (!normalizedTabId || !normalizedRunId) {
            throw createError(
              "invalid_debug_session",
              "AI Debug Session 缺少有效的 Tab 或任务编号",
            );
          }
          if (normalizedPersistent && !normalizedTaskId) {
            throw createError(
              "invalid_capture_task",
              "持久 AI Debug Session 缺少采集任务编号",
            );
          }

          const current = sessionsByTab.get(normalizedTabId);
          if (current?.runId === normalizedRunId) {
            if (
              current.persistent !== normalizedPersistent ||
              (normalizedPersistent && current.taskId !== normalizedTaskId)
            ) {
              throw createError(
                "debug_session_tab_busy",
                "当前页面已经由另一个 AI 采集任务接管",
              );
            }
            return publicSession(current, {reused: true});
          }
          if (current) {
            throw createError(
              "debug_session_tab_busy",
              "当前页面已经由另一个 AI 采集任务接管",
            );
          }
          if (sessionsByTab.size > 0) {
            throw createError(
              "debug_session_busy",
              "已有页面处于 AI Debug Session，请先结束当前采集",
            );
          }

          const debuggee = {tabId: normalizedTabId};
          const pendingAttach = {detached: false, reason: ""};
          pendingAttachesByTab.set(normalizedTabId, pendingAttach);
          try {
            await debuggerApi.attach(debuggee, PROTOCOL_VERSION);
          } catch (error) {
            pendingAttachesByTab.delete(normalizedTabId);
            throw createError(
              "debug_session_attach_failed",
              "无法接管当前页面；请先关闭该页面的 DevTools 或其他调试任务后重试",
              error,
            );
          }

          try {
            await applyFocusEmulation(normalizedTabId, true);
            if (pendingAttach.detached) {
              throw createError(
                "debug_session_detached_during_start",
                "浏览器接管刚建立就被取消，采集任务未启动",
              );
            }
          } catch (error) {
            expectedDetachTabs.add(normalizedTabId);
            try {
              await debuggerApi.detach(debuggee);
            } catch {
              // The attach is already unusable; cleanup remains best-effort.
            } finally {
              expectedDetachTabs.delete(normalizedTabId);
              pendingAttachesByTab.delete(normalizedTabId);
            }
            if (error?.code === "debug_session_detached_during_start") {
              throw error;
            }
            throw createError(
              "debug_session_command_failed",
              "浏览器已连接，但无法建立完整的 AI Debug Session",
              error,
            );
          }
          pendingAttachesByTab.delete(normalizedTabId);

          const session = {
            tabId: normalizedTabId,
            runId: normalizedRunId,
            label: normalizedLabel,
            state: "attached",
            startedAt: new Date(now()).toISOString(),
            ...(normalizedPageTitle ? {pageTitle: normalizedPageTitle} : {}),
            ...(normalizedPageUrl ? {pageUrl: normalizedPageUrl} : {}),
            ...(normalizedPlatform ? {platform: normalizedPlatform} : {}),
            persistent: normalizedPersistent,
            ...(normalizedPersistent
              ? {
                  taskId: normalizedTaskId,
                  progress: normalizeProgress(progress),
                  workerTabIds: normalizeWorkerTabIds(
                    workerTabIds,
                    normalizedTabId,
                  ),
                  groupId: normalizeGroupId(groupId),
                  originalGroupId: normalizeGroupId(originalGroupId),
                  minimized: Boolean(minimized),
                  activeListRunId: cleanText(activeListRunId, 320),
                }
              : {}),
          };
          sessionsByTab.set(normalizedTabId, session);
          await publish(session, {reason: "capture_started"});
          return publicSession(session);
        });
      }

      async function updateTask(input = {}) {
        const {
          taskId,
          progress,
          label,
          groupId,
          minimized,
          workerTabIds,
          activeListRunId,
        } = input;
        return enqueue(async () => {
          const session = findSessionByTaskId(taskId);
          if (!session) {
            throw createError(
              "capture_task_not_found",
              "没有找到正在运行的持久采集任务",
            );
          }
          if (Object.prototype.hasOwnProperty.call(input, "progress")) {
            session.progress = normalizeProgress(progress);
          }
          if (Object.prototype.hasOwnProperty.call(input, "label")) {
            session.label = cleanText(label, 120) || session.label;
          }
          if (Object.prototype.hasOwnProperty.call(input, "groupId")) {
            session.groupId = normalizeGroupId(groupId);
          }
          if (Object.prototype.hasOwnProperty.call(input, "minimized")) {
            session.minimized = Boolean(minimized);
          }
          if (Object.prototype.hasOwnProperty.call(input, "activeListRunId")) {
            session.activeListRunId = cleanText(activeListRunId, 320);
          }
          if (
            Object.prototype.hasOwnProperty.call(input, "workerTabIds")
          ) {
            session.workerTabIds = normalizeWorkerTabIds(
              workerTabIds,
              session.tabId,
            );
          }
          await publish(session, {reason: "capture_task_updated"});
          return publicSession(session);
        });
      }

      async function registerWorkerTab({taskId, tabId, groupId} = {}) {
        return enqueue(async () => {
          const session = findSessionByTaskId(taskId);
          if (!session) {
            throw createError(
              "capture_task_not_found",
              "没有找到正在运行的持久采集任务",
            );
          }
          const workerTabId = normalizeTabId(tabId);
          if (!workerTabId || workerTabId === session.tabId) {
            throw createError(
              "invalid_capture_worker_tab",
              "采集工作页缺少有效的 Tab",
            );
          }
          if (!session.workerTabIds.includes(workerTabId)) {
            session.workerTabIds = [...session.workerTabIds, workerTabId];
          }
          if (groupId !== undefined) {
            session.groupId = normalizeGroupId(groupId);
          }
          await publish(session, {
            reason: "capture_worker_tab_registered",
            workerTabId,
          });
          return publicSession(session);
        });
      }

      function setMinimized({taskId, minimized} = {}) {
        return updateTask({taskId, minimized: Boolean(minimized)});
      }

      async function stop({
        tabId,
        taskId = "",
        runId = "",
        reason = "capture_finished",
        force = false,
      } = {}) {
        return enqueue(async () => {
          const normalizedTabId = normalizeTabId(tabId);
          const normalizedTaskId = cleanText(taskId, 320);
          const session = normalizedTabId
            ? sessionsByTab.get(normalizedTabId)
            : findSessionByTaskId(normalizedTaskId);
          if (!normalizedTabId && !normalizedTaskId) {
            return {released: false, reason: "invalid_tab"};
          }
          if (!session) {
            return {released: false, reason: "not_attached"};
          }
          const sessionTabId = session.tabId;
          cancelPendingReplacementDetach(sessionTabId);
          const normalizedRunId = cleanText(runId, 320);
          if (!force && normalizedRunId && normalizedRunId !== session.runId) {
            return {released: false, reason: "run_mismatch"};
          }

          session.state = "detaching";
          expectedDetachTabs.add(sessionTabId);
          try {
            await applyFocusEmulation(sessionTabId, false).catch(() => null);
            await debuggerApi.detach({tabId: sessionTabId}).catch((error) => {
              const message = cleanText(error?.message || error, 240);
              if (!/not attached|no tab with given id|target closed/iu.test(message)) {
                throw error;
              }
            });
          } catch (error) {
            session.state = "attached";
            await applyFocusEmulation(sessionTabId, true).catch(() => null);
            await publish(session, {
              reason: "capture_detach_failed",
              error: cleanText(error?.message || error, 240),
            });
            throw createError(
              "debug_session_detach_failed",
              "浏览器接管尚未释放，请稍后重试停止任务",
              error,
            );
          } finally {
            expectedDetachTabs.delete(sessionTabId);
          }
          if (sessionsByTab.get(sessionTabId) === session) {
            sessionsByTab.delete(sessionTabId);
            await publish(null, {
              reason: cleanText(reason, 120) || "capture_finished",
              previous: publicSession(session, {state: "detached"}),
            });
          }
          return {
            released: true,
            reason: cleanText(reason, 120) || "capture_finished",
            session: publicSession(session, {state: "detached"}),
          };
        });
      }

      async function handleDetach(source, reason = "canceled_by_user") {
        const tabId = normalizeTabId(source?.tabId);
        if (!tabId) return false;
        const session = sessionsByTab.get(tabId);
        if (!session) return false;
        const expected = expectedDetachTabs.has(tabId);
        const normalizedReason = cleanText(reason, 120) || "canceled_by_user";
        if (expected) {
          cancelPendingReplacementDetach(tabId);
          sessionsByTab.delete(tabId);
          await publish(null, {
            reason: "expected_detach",
            previous: publicSession(session, {state: "detached"}),
          });
          return true;
        }

        // Chromium/Edge can briefly rebuild the renderer target while keeping
        // the same visible Tab alive. This happens during ordinary Douyin
        // profile scrolling too, not only during persistent detail tasks.
        // Give every list session a short same-tab reattach window. Persistent
        // sessions may additionally be migrated by tabs.onReplaced.
        if (normalizedReason === "target_closed") {
          return scheduleSourceDetachRecovery(
            session,
            normalizedReason,
          );
        }
        return await finalizeUnexpectedDetach(session, normalizedReason);
      }

      async function replaceTab({
        removedTabId,
        addedTabId,
        pageTitle = "",
        pageUrl = "",
      } = {}) {
        return enqueue(async () => {
          const oldTabId = normalizeTabId(removedTabId);
          const newTabId = normalizeTabId(addedTabId);
          if (!oldTabId || !newTabId || oldTabId === newTabId) {
            return {replaced: false, reason: "invalid_tab"};
          }

          const sourceSession = sessionsByTab.get(oldTabId);
          if (sourceSession?.persistent) {
            cancelPendingReplacementDetach(oldTabId);
            const debuggee = {tabId: newTabId};
            try {
              await debuggerApi.attach(debuggee, PROTOCOL_VERSION);
              await applyFocusEmulation(newTabId, true);
            } catch (error) {
              expectedDetachTabs.add(newTabId);
              await debuggerApi.detach(debuggee).catch(() => null);
              expectedDetachTabs.delete(newTabId);
              throw createError(
                "debug_session_replace_failed",
                "浏览器替换了采集页面，但 AI Debug 未能迁移到新页面",
                error,
              );
            }

            sessionsByTab.delete(oldTabId);
            sourceSession.tabId = newTabId;
            sourceSession.state = "attached";
            const normalizedPageTitle = cleanText(pageTitle, 180);
            const normalizedPageUrl = cleanText(pageUrl, 800);
            if (normalizedPageTitle) sourceSession.pageTitle = normalizedPageTitle;
            if (normalizedPageUrl) sourceSession.pageUrl = normalizedPageUrl;
            sourceSession.workerTabIds = normalizeWorkerTabIds(
              sourceSession.workerTabIds,
              newTabId,
            );
            sessionsByTab.set(newTabId, sourceSession);
            await publish(sourceSession, {
              reason: "capture_task_source_tab_replaced",
              removedTabId: oldTabId,
              addedTabId: newTabId,
            });
            return {
              replaced: true,
              role: "source",
              session: publicSession(sourceSession),
            };
          }

          for (const session of sessionsByTab.values()) {
            if (
              !session.persistent ||
              !session.workerTabIds.includes(oldTabId)
            ) {
              continue;
            }
            session.workerTabIds = normalizeWorkerTabIds(
              session.workerTabIds.map((workerTabId) =>
                workerTabId === oldTabId ? newTabId : workerTabId,
              ),
              session.tabId,
            );
            await publish(session, {
              reason: "capture_worker_tab_replaced",
              removedTabId: oldTabId,
              addedTabId: newTabId,
            });
            return {
              replaced: true,
              role: "worker",
              session: publicSession(session),
            };
          }
          return {replaced: false, reason: "not_tracked"};
        });
      }

      async function handleTabRemoved(tabId) {
        const normalizedTabId = normalizeTabId(tabId);
        if (!normalizedTabId) return false;
        cancelPendingReplacementDetach(normalizedTabId);
        const session = sessionsByTab.get(normalizedTabId);
        if (session) {
          sessionsByTab.delete(normalizedTabId);
          await publish(null, {
            reason: "tab_removed",
            previous: publicSession(session, {state: "detached"}),
          });
          return true;
        }
        for (const activeSession of sessionsByTab.values()) {
          if (!activeSession.persistent) continue;
          if (!activeSession.workerTabIds.includes(normalizedTabId)) continue;
          activeSession.workerTabIds = activeSession.workerTabIds.filter(
            (workerTabId) => workerTabId !== normalizedTabId,
          );
          await publish(activeSession, {
            reason: "capture_worker_tab_removed",
            workerTabId: normalizedTabId,
          });
          return true;
        }
        return false;
      }

      const detachListener = (source, reason) => {
        const tabId = normalizeTabId(source?.tabId);
        const pendingAttach = pendingAttachesByTab.get(tabId);
        if (pendingAttach) {
          pendingAttach.detached = true;
          pendingAttach.reason = cleanText(reason, 120);
          return;
        }
        void handleDetach(source, reason);
      };
      debuggerApi.onDetach?.addListener?.(detachListener);

      return Object.freeze({
        start,
        stop,
        stopByTab(tabId, reason = "capture_cancelled") {
          return stop({tabId, reason, force: true});
        },
        stopByTaskId(taskId, reason = "capture_task_finished") {
          return stop({taskId, reason, force: true});
        },
        updateTask,
        registerWorkerTab,
        replaceTab,
        setMinimized,
        handleDetach,
        handleTabRemoved,
        getSession(tabId) {
          return publicSession(sessionsByTab.get(normalizeTabId(tabId)));
        },
        getSessionByTaskId(taskId) {
          return publicSession(findSessionByTaskId(taskId));
        },
        getActiveSessions() {
          return Array.from(sessionsByTab.values(), (session) =>
            publicSession(session),
          );
        },
      });
    }

    return Object.freeze({
      PROTOCOL_VERSION,
      createManager,
      isListCaptureAction,
      resolveListRelayRunId,
    });
  },
);
