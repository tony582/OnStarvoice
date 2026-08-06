(function installCaptureTaskTabGroup(root, factory) {
  const api = factory();
  if (typeof module === "object" && module?.exports) {
    module.exports = api;
  }
  root.OnStarvoiceCaptureTaskTabGroup = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function createCaptureTaskTabGroupApi() {
    const DEFAULT_GROUP_TITLE = "StarVoice 采集任务";

    function cleanText(value, maxLength = 320) {
      return String(value || "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
    }

    function normalizeTabId(value) {
      const tabId = Number(value);
      return Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null;
    }

    function normalizeGroupId(value) {
      const groupId = Number(value);
      return Number.isSafeInteger(groupId) && groupId >= 0 ? groupId : null;
    }

    function normalizeTaskTabRole(value) {
      const role = cleanText(value, 40).toLowerCase();
      if (!role || role === "worker" || role === "detail_worker") {
        return "worker";
      }
      return null;
    }

    function createError(code, message, cause = null) {
      const error = new Error(message);
      error.code = code;
      if (cause) error.cause = cause;
      return error;
    }

    function isBenignUngroupError(error) {
      const message = cleanText(error?.message || error, 240);
      return /no tab with id|not found|does not exist|not in a group|invalid tab id/iu.test(
        message,
      );
    }

    function publicTaskGroup(group, overrides = {}) {
      if (!group) return null;
      return {
        version: 1,
        taskId: group.taskId,
        sourceTabId: group.sourceTabId,
        workerTabIds: [...group.workerTabIds],
        groupId: group.groupId,
        originalGroupId: group.originalGroupId,
        windowId: group.windowId,
        title: group.title,
        ...overrides,
      };
    }

    function createManager({
      tabsApi,
      tabGroupsApi,
      groupTitle = DEFAULT_GROUP_TITLE,
    } = {}) {
      if (
        !tabsApi ||
        typeof tabsApi.get !== "function" ||
        typeof tabsApi.group !== "function" ||
        typeof tabsApi.ungroup !== "function" ||
        !tabGroupsApi ||
        typeof tabGroupsApi.update !== "function"
      ) {
        throw createError(
          "task_tab_group_api_unavailable",
          "当前浏览器没有提供原生采集标签组能力",
        );
      }

      const groupsByTaskId = new Map();
      let mutationQueue = Promise.resolve();

      function enqueue(task) {
        const next = mutationQueue.then(task, task);
        mutationQueue = next.catch(() => undefined);
        return next;
      }

      async function releaseGroupedTabs(tabIds) {
        const uniqueTabIds = Array.from(
          new Set(tabIds.map(normalizeTabId).filter(Boolean)),
        );
        const results = await Promise.allSettled(
          uniqueTabIds.map(async (tabId) => {
            try {
              await tabsApi.ungroup([tabId]);
              return {tabId, released: true};
            } catch (error) {
              if (isBenignUngroupError(error)) {
                return {tabId, released: false, benign: true};
              }
              throw error;
            }
          }),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return results;
      }

      async function restoreSourceTabGroup(sourceTabId, originalGroupId) {
        if (Number.isSafeInteger(originalGroupId) && originalGroupId >= 0) {
          try {
            await tabsApi.group({
              groupId: originalGroupId,
              tabIds: [sourceTabId],
            });
            return true;
          } catch {
            // The former group may have been removed while the task ran.
          }
        }
        await releaseGroupedTabs([sourceTabId]);
        return false;
      }

      async function begin({taskId, sourceTabId, title = groupTitle} = {}) {
        return enqueue(async () => {
          const normalizedTaskId = cleanText(taskId, 320);
          const normalizedSourceTabId = normalizeTabId(sourceTabId);
          const normalizedTitle =
            cleanText(title, 25) || DEFAULT_GROUP_TITLE;
          if (!normalizedTaskId || !normalizedSourceTabId) {
            throw createError(
              "invalid_capture_task_group",
              "创建采集标签组时缺少任务编号或来源 Tab",
            );
          }

          const current = groupsByTaskId.get(normalizedTaskId);
          if (current) {
            if (current.sourceTabId !== normalizedSourceTabId) {
              throw createError(
                "capture_task_group_busy",
                "该采集任务已经绑定到另一个来源 Tab",
              );
            }
            return publicTaskGroup(current, {reused: true});
          }

          let sourceTab;
          try {
            sourceTab = await tabsApi.get(normalizedSourceTabId);
          } catch (error) {
            throw createError(
              "capture_task_source_tab_missing",
              "找不到采集任务的来源 Tab",
              error,
            );
          }

          let groupId;
          try {
            groupId = await tabsApi.group({tabIds: [normalizedSourceTabId]});
            await tabGroupsApi.update(groupId, {
              title: normalizedTitle,
              collapsed: false,
            });
          } catch (error) {
            if (groupId !== undefined) {
              await restoreSourceTabGroup(
                normalizedSourceTabId,
                Number.isSafeInteger(sourceTab?.groupId) &&
                  sourceTab.groupId >= 0
                  ? sourceTab.groupId
                  : null,
              ).catch(() => null);
            }
            throw createError(
              "capture_task_group_create_failed",
              "无法创建原生采集标签组",
              error,
            );
          }

          const group = {
            taskId: normalizedTaskId,
            sourceTabId: normalizedSourceTabId,
            workerTabIds: [],
            groupId,
            originalGroupId:
              Number.isSafeInteger(sourceTab?.groupId) && sourceTab.groupId >= 0
                ? sourceTab.groupId
                : null,
            windowId: Number.isSafeInteger(sourceTab?.windowId)
              ? sourceTab.windowId
              : null,
            title: normalizedTitle,
          };
          groupsByTaskId.set(normalizedTaskId, group);
          return publicTaskGroup(group);
        });
      }

      async function restore(snapshot = {}) {
        return enqueue(async () => {
          const normalizedTaskId = cleanText(snapshot?.taskId, 320);
          const normalizedSourceTabId = normalizeTabId(
            snapshot?.sourceTabId || snapshot?.tabId,
          );
          const normalizedGroupId = normalizeGroupId(snapshot?.groupId);
          if (
            !normalizedTaskId ||
            !normalizedSourceTabId ||
            normalizedGroupId === null
          ) {
            throw createError(
              "invalid_capture_task_group_restore",
              "采集标签组恢复快照不完整",
            );
          }

          const current = groupsByTaskId.get(normalizedTaskId);
          if (current) {
            if (
              current.sourceTabId !== normalizedSourceTabId ||
              current.groupId !== normalizedGroupId
            ) {
              throw createError(
                "capture_task_group_restore_conflict",
                "采集标签组已经由另一个页面恢复",
              );
            }
            return publicTaskGroup(current, {restored: true, reused: true});
          }
          if (groupsByTaskId.size > 0) {
            throw createError(
              "capture_task_group_busy",
              "已有其它采集标签组正在运行",
            );
          }

          let sourceTab;
          try {
            sourceTab = await tabsApi.get(normalizedSourceTabId);
          } catch (error) {
            throw createError(
              "capture_task_source_tab_missing",
              "找不到待恢复采集任务的来源 Tab",
              error,
            );
          }
          if (normalizeGroupId(sourceTab?.groupId) !== normalizedGroupId) {
            throw createError(
              "capture_task_group_restore_mismatch",
              "来源页面已不在原采集标签组中",
            );
          }

          const sourceWindowId = Number.isSafeInteger(sourceTab?.windowId)
            ? sourceTab.windowId
            : null;
          const workerTabIds = [];
          const missingWorkerTabIds = [];
          for (const candidate of Array.isArray(snapshot?.workerTabIds)
            ? snapshot.workerTabIds
            : []) {
            const workerTabId = normalizeTabId(candidate);
            if (!workerTabId || workerTabId === normalizedSourceTabId) continue;
            try {
              const workerTab = await tabsApi.get(workerTabId);
              if (
                normalizeGroupId(workerTab?.groupId) === normalizedGroupId &&
                (sourceWindowId === null ||
                  !Number.isSafeInteger(workerTab?.windowId) ||
                  workerTab.windowId === sourceWindowId)
              ) {
                workerTabIds.push(workerTabId);
              } else {
                missingWorkerTabIds.push(workerTabId);
              }
            } catch {
              missingWorkerTabIds.push(workerTabId);
            }
          }

          const group = {
            taskId: normalizedTaskId,
            sourceTabId: normalizedSourceTabId,
            workerTabIds: Array.from(new Set(workerTabIds)),
            groupId: normalizedGroupId,
            originalGroupId: normalizeGroupId(snapshot?.originalGroupId),
            windowId: sourceWindowId,
            title: cleanText(snapshot?.title, 25) ||
              cleanText(groupTitle, 25) || DEFAULT_GROUP_TITLE,
          };
          groupsByTaskId.set(normalizedTaskId, group);
          return publicTaskGroup(group, {
            restored: true,
            missingWorkerTabIds,
          });
        });
      }

      function forget(taskId) {
        const normalizedTaskId = cleanText(taskId, 320);
        const group = groupsByTaskId.get(normalizedTaskId);
        if (!group) return {forgotten: false, reason: "not_grouped"};
        groupsByTaskId.delete(normalizedTaskId);
        return {forgotten: true, group: publicTaskGroup(group)};
      }

      async function register({taskId, tabId, role = "worker"} = {}) {
        return enqueue(async () => {
          const normalizedTaskId = cleanText(taskId, 320);
          const workerTabId = normalizeTabId(tabId);
          const normalizedRole = normalizeTaskTabRole(role);
          if (!normalizedTaskId || !workerTabId || !normalizedRole) {
            throw createError(
              "invalid_capture_worker_tab",
              "注册采集工作页时缺少有效的任务、Tab 或角色",
            );
          }
          const group = groupsByTaskId.get(normalizedTaskId);
          if (!group) {
            throw createError(
              "capture_task_group_not_found",
              "没有找到采集任务对应的原生标签组",
            );
          }
          if (workerTabId === group.sourceTabId) {
            return publicTaskGroup(group, {
              reused: true,
              role: normalizedRole,
            });
          }
          if (group.workerTabIds.includes(workerTabId)) {
            return publicTaskGroup(group, {
              reused: true,
              role: normalizedRole,
            });
          }

          let workerTab;
          try {
            workerTab = await tabsApi.get(workerTabId);
          } catch (error) {
            throw createError(
              "capture_worker_tab_missing",
              "找不到要加入采集组的工作页",
              error,
            );
          }
          if (
            group.windowId !== null &&
            Number.isSafeInteger(workerTab?.windowId) &&
            workerTab.windowId !== group.windowId
          ) {
            throw createError(
              "capture_worker_window_mismatch",
              "来源页与采集工作页必须位于同一个浏览器窗口",
            );
          }

          try {
            await tabsApi.group({
              groupId: group.groupId,
              tabIds: [workerTabId],
            });
          } catch (error) {
            throw createError(
              "capture_worker_group_failed",
              "无法把采集工作页加入原生标签组",
              error,
            );
          }
          group.workerTabIds = [...group.workerTabIds, workerTabId];
          return publicTaskGroup(group, {role: normalizedRole});
        });
      }

      async function unregister({taskId, tabId} = {}) {
        return enqueue(async () => {
          const normalizedTaskId = cleanText(taskId, 320);
          const workerTabId = normalizeTabId(tabId);
          if (!normalizedTaskId || !workerTabId) {
            return {released: false, reason: "invalid_worker"};
          }
          const group = groupsByTaskId.get(normalizedTaskId);
          if (!group || !group.workerTabIds.includes(workerTabId)) {
            return {released: false, reason: "not_registered"};
          }
          await releaseGroupedTabs([workerTabId]);
          group.workerTabIds = group.workerTabIds.filter(
            (candidateTabId) => candidateTabId !== workerTabId,
          );
          return {
            released: true,
            group: publicTaskGroup(group),
          };
        });
      }

      async function replaceTab({removedTabId, addedTabId} = {}) {
        return enqueue(async () => {
          const oldTabId = normalizeTabId(removedTabId);
          const newTabId = normalizeTabId(addedTabId);
          if (!oldTabId || !newTabId || oldTabId === newTabId) {
            return {replaced: false, reason: "invalid_tab"};
          }

          for (const group of groupsByTaskId.values()) {
            const sourceReplacement = group.sourceTabId === oldTabId;
            const workerReplacement = group.workerTabIds.includes(oldTabId);
            if (!sourceReplacement && !workerReplacement) continue;

            let replacementTab;
            try {
              replacementTab = await tabsApi.get(newTabId);
            } catch (error) {
              throw createError(
                "capture_replacement_tab_missing",
                "找不到浏览器替换后的采集页面",
                error,
              );
            }
            if (
              group.windowId !== null &&
              Number.isSafeInteger(replacementTab?.windowId) &&
              replacementTab.windowId !== group.windowId
            ) {
              throw createError(
                "capture_replacement_window_mismatch",
                "浏览器替换后的采集页面不在原任务窗口",
              );
            }

            try {
              await tabsApi.group({
                groupId: group.groupId,
                tabIds: [newTabId],
              });
            } catch (error) {
              throw createError(
                "capture_replacement_group_failed",
                "无法把浏览器替换后的页面保留在采集标签组",
                error,
              );
            }

            if (sourceReplacement) {
              group.sourceTabId = newTabId;
            } else {
              group.workerTabIds = Array.from(
                new Set(
                  group.workerTabIds.map((workerTabId) =>
                    workerTabId === oldTabId ? newTabId : workerTabId,
                  ),
                ),
              ).filter((workerTabId) => workerTabId !== group.sourceTabId);
            }
            return {
              replaced: true,
              role: sourceReplacement ? "source" : "worker",
              group: publicTaskGroup(group),
            };
          }
          return {replaced: false, reason: "not_tracked"};
        });
      }

      async function end({taskId, reason = "capture_task_finished"} = {}) {
        return enqueue(async () => {
          const normalizedTaskId = cleanText(taskId, 320);
          if (!normalizedTaskId) {
            return {released: false, reason: "invalid_task"};
          }
          const group = groupsByTaskId.get(normalizedTaskId);
          if (!group) {
            return {released: false, reason: "not_grouped"};
          }
          await releaseGroupedTabs(group.workerTabIds);
          await restoreSourceTabGroup(
            group.sourceTabId,
            group.originalGroupId,
          );
          groupsByTaskId.delete(normalizedTaskId);
          return {
            released: true,
            reason: cleanText(reason, 120) || "capture_task_finished",
            group: publicTaskGroup(group),
          };
        });
      }

      async function handleTabRemoved(tabId) {
        return enqueue(async () => {
          const normalizedTabId = normalizeTabId(tabId);
          if (!normalizedTabId) return false;
          for (const [taskId, group] of groupsByTaskId.entries()) {
            if (group.sourceTabId === normalizedTabId) {
              await releaseGroupedTabs(group.workerTabIds);
              groupsByTaskId.delete(taskId);
              return true;
            }
            if (group.workerTabIds.includes(normalizedTabId)) {
              group.workerTabIds = group.workerTabIds.filter(
                (workerTabId) => workerTabId !== normalizedTabId,
              );
              return true;
            }
          }
          return false;
        });
      }

      return Object.freeze({
        begin,
        restore,
        forget,
        register,
        unregister,
        replaceTab,
        end,
        handleTabRemoved,
        getTask(taskId) {
          return publicTaskGroup(groupsByTaskId.get(cleanText(taskId, 320)));
        },
        getActiveTasks() {
          return Array.from(groupsByTaskId.values(), (group) =>
            publicTaskGroup(group),
          );
        },
      });
    }

    return Object.freeze({
      DEFAULT_GROUP_TITLE,
      createManager,
      normalizeTaskTabRole,
    });
  },
);
