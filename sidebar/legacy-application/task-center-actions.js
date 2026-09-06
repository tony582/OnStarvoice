// Compatibility-only application adapter for the existing task-center event.
// Historical task IDs, raw items and diagnostic fallback are NOT command authority.
// Do not expose this adapter to the new UI or call it from a strict command route.
export function createLegacyTaskCenterActions({
  sendRuntimeMessage,
  getActiveTaskContext,
  handleCancel,
  isUnattendedSafetyBlock,
  loadKeywordPlanUI,
  presentation,
  warnCancelFailure,
}) {
  async function executeLegacyTaskCenterAction(detail) {
    const rawAction = String(detail.action || "").trim();
    const action =
      rawAction === "stop_keep"
        ? "stop"
        : rawAction === "resume_remaining"
          ? "continue_remaining"
          : rawAction;
    const taskId = String(detail.taskId || detail.id || "").trim();
    if (!action) return;

    if (action === "view_results") {
      presentation.activateResultsTab();
      return;
    }

    if (action === "keep_results") {
      if (!taskId) {
        presentation.notify("未找到要保留的任务，请刷新任务中心后重试", "warning");
        return;
      }
      try {
        const response = await sendRuntimeMessage({
          type: "onstarvoice:cancel-unattended-keyword-run",
          requestId: taskId,
          message: "用户选择保留已有结果，不再自动恢复",
        });
        if (!response?.ok) {
          throw new Error(response?.reason || response?.error?.message || "任务状态更新失败");
        }
        presentation.notify("已保留当前结果，任务不会自动重试", "success");
      } catch (error) {
        presentation.notify("保留结果失败: " + error.message, "error");
      }
      return;
    }

    if (action === "stop") {
      if (taskId) {
        try {
          const unattendedResponse = await sendRuntimeMessage({
            type: "onstarvoice:cancel-unattended-keyword-run",
            requestId: taskId,
            message: "用户从任务中心停止任务并保留已有结果",
          });
          if (unattendedResponse?.ok) {
            presentation.notify("正在停止任务并保留已有结果...", "warning");
            return;
          }
        } catch (error) {
          warnCancelFailure(error);
        }
      }
      const activeTask = getActiveTaskContext();
      if (!taskId || activeTask?.taskId === taskId) {
        await handleCancel();
        presentation.notify("正在停止任务并保留已有结果...", "warning");
        return;
      }
      presentation.notify("这条任务已不在当前页面执行，已刷新任务状态", "warning");
      return;
    }

    const recoveryModeByAction = {
      continue_remaining: "remaining",
      retry_failed: "failed",
      skip_current: "skip_current",
    };
    const mode = recoveryModeByAction[action];
    if (!mode || !taskId) return;
    if (
      action === "continue_remaining" &&
      isUnattendedSafetyBlock(detail.task || {}) &&
      !presentation.confirmSafetyBlock()
    ) {
      return;
    }

    try {
      const response = await sendRuntimeMessage({
        type: "onstarvoice:recover-unattended-keyword-run",
        requestId: taskId,
        mode,
      });
      if (!response?.ok) {
        throw new Error(response?.reason || response?.error?.message || "无法恢复任务");
      }
      presentation.notify(
        mode === "failed"
          ? "已安排仅重试失败关键词"
          : mode === "skip_current"
            ? "已跳过当前项并继续剩余任务"
            : "已从检查点继续剩余任务",
        "success",
      );
      await loadKeywordPlanUI();
    } catch (error) {
      presentation.notify("恢复任务失败: " + error.message, "error");
    }
  }

  return Object.freeze({executeLegacyTaskCenterAction});
}
