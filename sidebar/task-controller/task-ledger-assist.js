// L3-A task-ledger-assist: original control flow, explicit state and compatibility ports.
export function createTaskLedgerAssistController({controllerState, controllerPorts, controllerOperations}) {
  const {
    OPTIONAL_CAPTURE_ASSIST_SESSION_CODES,
    beginCaptureTaskSession,
    beginTaskContext,
    chrome,
    completeTaskContext,
    console,
    detectPlatformFromUrl,
    endCaptureTaskSession,
    getCurrentRuntime,
    recordDiagnosticError,
    recordDiagnosticTask,
    wait,
  } = controllerPorts;
  const bindCaptureTaskOwner = (...args) => controllerOperations.bindCaptureTaskOwner(...args);
  const releaseCaptureTaskOwner = (...args) => controllerOperations.releaseCaptureTaskOwner(...args);

  function resolveTaskCenterTitle(taskType = "task", featureKey = "") {
    const labels = {
      "capture.single_note": "作品采集",
      "capture.blogger": "博主采集",
      "capture.search": "搜索页采集",
      "capture.keyword_batch": "批量关键词采集",
      "capture.comments": "评论采集",
      "capture.enhancement": "采集增强",
      "sync.lark": "数据同步",
      "benchmark.account_discovery": "对标账号分析",
    };
    return labels[featureKey] ||
      (taskType === "capture"
        ? "采集任务"
        : taskType === "sync"
          ? "同步任务"
          : taskType === "monitor"
            ? "监控任务"
            : "执行任务");
  }

  function normalizeTaskCenterStatus(status = "running") {
    const normalized = String(status || "").trim().toLowerCase();
    if (normalized === "partial") return "completed_with_failures";
    if (normalized === "success") return "completed";
    if (normalized === "error") return "failed";
    return normalized || "running";
  }

  async function reportSidebarTaskRun(run = {}, event = null) {
    if (!run?.id) return null;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:upsert-task-run",
        run,
        event,
      });
      return response?.data || null;
    } catch (error) {
      console.warn("[Sidebar] Update task center ledger failed:", error);
      return null;
    }
  }

  function buildSidebarTaskRun(taskContext, patch = {}) {
    if (!taskContext?.taskId) return null;
    const contextMetadata =
      taskContext.metadata && typeof taskContext.metadata === "object"
        ? taskContext.metadata
        : {};
    const summaryMetadata =
      patch.summary && typeof patch.summary === "object" && !Array.isArray(patch.summary)
        ? patch.summary
        : {};
    const metadata = {...contextMetadata, ...summaryMetadata};
    const runtime = getCurrentRuntime() || {};
    const now = new Date().toISOString();
    const status = normalizeTaskCenterStatus(patch.status || "running");
    return {
      id: taskContext.taskId,
      taskType: String(taskContext.taskType || "task"),
      kind: String(taskContext.taskType || "task"),
      featureKey: String(taskContext.featureKey || ""),
      title: resolveTaskCenterTitle(
        taskContext.taskType,
        taskContext.featureKey,
      ),
      platform: String(metadata.platform || runtime.platform || "unknown"),
      trigger: metadata.retry ? "retry" : "manual",
      status,
      createdAt: String(taskContext.startedAt || now),
      startedAt: String(taskContext.startedAt || now),
      updatedAt: now,
      businessProgressAt: String(patch.businessProgressAt || now),
      counts: {
        total: Math.max(
          0,
          Number(metadata.totalCount ?? metadata.keywordCount ?? patch?.progress?.total) || 0,
        ),
        processed: Math.max(
          0,
          Number(metadata.processedCount ?? patch?.progress?.current) || 0,
        ),
        saved: Math.max(0, Number(metadata.savedCount) || 0),
        success: Math.max(0, Number(metadata.successCount) || 0),
        failed: Math.max(0, Number(metadata.failedCount) || 0),
        skipped: Math.max(0, Number(metadata.skippedCount) || 0),
        retried: Math.max(0, Number(metadata.retryCount) || 0),
        warnings: Math.max(0, Number(metadata.warningCount) || 0),
      },
      finishedAt:
        new Set([
          "completed",
          "completed_with_failures",
          "needs_action",
          "failed",
          "canceled",
        ]).has(status)
          ? now
          : "",
      metadata,
      ...patch,
      status,
    };
  }

  function beginSidebarTask({
    taskType = "task",
    featureKey = "unknown",
    metadata = {},
  } = {}) {
    const taskContext = beginTaskContext({
      taskType,
      featureKey,
      source: "sidebar",
      metadata,
    });

    void recordDiagnosticTask({
      taskContext,
      source: "sidebar",
      action: "task_start",
      status: "started",
      metadata,
    }).catch(() => null);

    const taskRun = buildSidebarTaskRun(taskContext, {status: "running"});
    void reportSidebarTaskRun(taskRun, {
      type: "task_started",
      status: "running",
      message: `${taskRun?.title || "任务"}已开始`,
    });

    return taskContext;
  }

  function finishSidebarTask(
    taskContext,
    {status = "completed", error = null, metadata = {}} = {},
  ) {
    if (!taskContext) return;
    const completedContext =
      completeTaskContext({
        taskType: taskContext.taskType,
        featureKey: taskContext.featureKey,
      }) || taskContext;

    void recordDiagnosticTask({
      taskContext: completedContext,
      source: "sidebar",
      action: "task_finish",
      status,
      metadata,
    }).catch(() => null);

    const taskRun = buildSidebarTaskRun(completedContext, {
      status: normalizeTaskCenterStatus(status),
      summary: metadata,
      error: error
        ? {
            code: String(error?.code || ""),
            message: String(error?.message || error || ""),
            ...(error?.category
              ? {category: String(error.category)}
              : {}),
            ...(error?.securityBlocked === true
              ? {securityBlocked: true}
              : {}),
            ...(error?.requiresManualAction === true
              ? {requiresManualAction: true}
              : {}),
            ...(typeof error?.retryable === "boolean"
              ? {retryable: error.retryable}
              : {}),
          }
        : null,
    });
    void reportSidebarTaskRun(taskRun, {
      type: "task_finished",
      status: taskRun?.status || status,
      message:
        taskRun?.status === "completed"
          ? `${taskRun.title}已完成`
          : `${taskRun?.title || "任务"}已结束`,
    });

    if (error) {
      void recordDiagnosticError({
        taskContext: completedContext,
        source: "sidebar",
        action: "task_finish",
        status: "failed",
        error,
        metadata,
      }).catch(() => null);
    }
  }

  async function resolveCaptureTaskSourceTabId({
    preferredTabId = null,
    platform = "",
  } = {}) {
    const expectedPlatform = String(platform || "").trim().toLowerCase();
    const matchesSourcePage = (tab) => {
      const tabId = Number(tab?.id);
      if (!Number.isSafeInteger(tabId) || tabId <= 0) return false;
      return (
        !expectedPlatform ||
        detectPlatformFromUrl(tab?.url || "") === expectedPlatform
      );
    };
    const visitedTabIds = new Set();
    const readTabById = async (candidateTabId) => {
      const tabId = Number(candidateTabId);
      if (
        !Number.isSafeInteger(tabId) ||
        tabId <= 0 ||
        visitedTabIds.has(tabId)
      ) {
        return null;
      }
      visitedTabIds.add(tabId);
      try {
        const tab = await chrome.tabs.get(tabId);
        return matchesSourcePage(tab) ? tabId : null;
      } catch {
        return null;
      }
    };

    const preferredSourceTabId = await readTabById(preferredTabId);
    if (preferredSourceTabId) return preferredSourceTabId;

    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (matchesSourcePage(activeTab)) {
        return Number(activeTab.id);
      }
    } catch {
      // ignore and fallback to the last supported source tab
    }

    return await readTabById(getCurrentRuntime()?.lastActiveTabId);
  }

  function resolveCaptureTaskTerminalStatus({
    taskStatus = "completed",
    error = null,
    canceled = false,
  } = {}) {
    if (canceled) return {reason: "canceled", status: "canceled"};
    if (taskStatus === "failed") {
      return {reason: "failed", status: "failed"};
    }
    if (taskStatus === "skipped") {
      return {reason: "skipped", status: "skipped"};
    }
    if (taskStatus === "needs_action") {
      return {reason: "needs_action", status: "needs_action"};
    }
    if (
      taskStatus === "partial" ||
      taskStatus === "completed_with_failures"
    ) {
      return {
        reason: "completed_with_failures",
        status: taskStatus,
      };
    }
    if (error) return {reason: "failed", status: "failed"};
    return {reason: "completed", status: "completed"};
  }

  function resolveUnattendedEnhanceCancellation(
    result = {},
    fallbackReason = "",
  ) {
    const candidates = [
      result?.cancellationReason,
      result?.cancelReason,
      result?.reason,
      result?.error?.code,
      result?.error?.reason,
      result?.error?.category,
      result?.category,
      fallbackReason,
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    if (result?.runnerInterrupted === true) {
      candidates.push("runner_interrupted");
    }

    const isRecoverableReason = (value) =>
      /(?:^|_)(?:native_debug(?:_canceled)?|sidebar_owner_disconnected|debugger_detached|runner_interrupted|context_interrupted)(?:$|_)/.test(
        value,
      );
    const isBatchStopReason = (value) =>
      /(?:^|_)(?:user(?:_requested)?_?cancel(?:ed)?|unattended(?:_requested)?_?cancel(?:ed)?|security|safety|captcha|fatal|source_tab_removed)(?:$|_)/.test(
        value,
      );
    const terminalReason = candidates.find(isBatchStopReason) || "";
    const recoverableReason = candidates.find(isRecoverableReason) || "";
    const reason = terminalReason || recoverableReason || candidates[0] || "";
    const stopBatch = Boolean(
      result?.securityBlocked === true ||
        result?.fatal === true ||
        result?.fatalError ||
        terminalReason,
    );

    return {
      reason,
      stopBatch,
      recoverable:
        !stopBatch &&
        Boolean(
          recoverableReason ||
            result?.runnerInterrupted === true ||
            result?.canceled === true,
        ),
    };
  }

  function resolveUnattendedCancellationTerminal(
    reason = "",
    fallbackMessage = "无人值守计划已取消",
  ) {
    const normalizedReason = String(reason || "").trim();
    if (
      normalizedReason === "user_cancel_requested" ||
      normalizedReason === "unattended_cancel_requested" ||
      /用户手动|手动中止/.test(normalizedReason)
    ) {
      return {
        status: "canceled",
        message: fallbackMessage,
        error: null,
      };
    }
    const messages = {
      native_debug_canceled:
        "浏览器采集辅助意外中断，无人值守任务已停止",
      sidebar_owner_disconnected:
        "无人值守控制页连接中断，任务已停止",
      source_tab_removed:
        "采集来源页面已关闭，无人值守任务已停止",
    };
    const message =
      messages[normalizedReason] ||
      (normalizedReason
        ? `无人值守运行环境异常（${normalizedReason}），任务已停止`
        : "无人值守运行状态异常中断（非用户操作）");
    return {
      status: "failed",
      message,
      error: {
        code: normalizedReason
          ? `CAPTURE_TASK_${normalizedReason
              .replace(/[^a-z0-9]+/gi, "_")
              .toUpperCase()}`
          : "CAPTURE_TASK_UNEXPECTED_CANCELLATION",
        message,
      },
    };
  }

  function supportsPersistentCaptureTaskPlatform(platform = "") {
    return new Set(["xiaohongshu", "douyin"]).has(
      String(platform || "").trim().toLowerCase(),
    );
  }

  async function startCaptureAssistSessionStrict(options = {}) {
    const strictClient = controllerPorts.strictCaptureClient;
    if (strictClient && (strictClient.shouldStop() ||
        String(options.attemptId || '') !== strictClient.strictControl.attemptId)) {
      const error = new Error('strict_capture_assist_identity_rejected');
      error.code = 'strict_capture_assist_identity_rejected';
      throw error;
    }
    const taskId = String(options?.taskId || "").trim();
    const platform = String(options?.platform || "").trim().toLowerCase();
    const ownerRequired = options?.ownerRequired !== false;
    if (!supportsPersistentCaptureTaskPlatform(platform)) {
      const error = new Error("当前平台不支持浏览器采集辅助");
      error.code = "capture_task_platform_unsupported";
      throw error;
    }
    if (ownerRequired) {
      bindCaptureTaskOwner(taskId);
    }
    const result = await beginCaptureTaskSession({
      ...options,
      ownerRequired,
    });
    if (strictClient && result?.data?.scopeMode !== 'cooperative') {
      const error = new Error('strict_cooperative_session_confirmation_required');
      error.code = 'strict_cooperative_session_confirmation_required';
      throw error;
    }
    if (result?.ok === true && result?.active === true) {
      return result;
    }
    if (ownerRequired) {
      releaseCaptureTaskOwner(taskId);
    }
    const reason = String(
      result?.response?.error?.message ||
        result?.error?.message ||
        result?.reason ||
        "采集辅助初始化失败",
    ).trim();
    const error = new Error(`无法启动浏览器采集辅助：${reason}`);
    error.code = String(
      result?.response?.error?.code || result?.reason || "capture_task_unavailable",
    );
    if (
      result?.response?.error?.details &&
      typeof result.response.error.details === "object" &&
      !Array.isArray(result.response.error.details)
    ) {
      error.details = {...result.response.error.details};
    }
    throw error;
  }

  async function startOptionalCaptureAssistSession(options = {}) {
    try {
      return await startCaptureAssistSessionStrict(options);
    } catch (error) {
      const code = String(error?.code || "").trim();
      if (controllerPorts.strictCaptureClient) throw error;
      if (!OPTIONAL_CAPTURE_ASSIST_SESSION_CODES.has(code)) {
        // Attempt identity, execution-lock, platform and source-page errors are
        // authoritative task fences rather than optional assist failures. Never
        // let an obsolete or terminal runner continue collection by disguising
        // one of those rejections as a Debug degradation.
        throw error;
      }
      console.warn(
        "[Sidebar] Optional capture assist unavailable; continuing page capture:",
        {
          code,
          message: String(error?.message || ""),
        },
      );
      return {
        ok: true,
        active: false,
        degraded: true,
        reason: code || "capture_assist_unavailable",
        taskId: String(options?.taskId || "").trim(),
        message: "浏览器采集辅助不可用，已继续执行采集",
      };
    }
  }

  async function rebuildCaptureTaskSessionForEnhancementRetry({
    taskId = "",
    preferredTabId = null,
    platform = "",
    label = "采集增强自动恢复",
    unattendedAttemptId = "",
  } = {}) {
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedTaskId) {
      return {ok: true, skipped: true, reason: "no_persistent_task"};
    }

    const normalizedPlatform = String(platform || "")
      .trim()
      .toLowerCase();

    // 无人值守的稳定 taskId 会跨重建保留，但所有 END/BEGIN
    // 必须使用同一个当前 attemptId。否则 background 会将无 attempt
    // 的 END 判为过期请求，旧 Debug 仍然占用来源页。
    const unattendedTask = normalizedTaskId.startsWith("unattended-capture:");
    const scopedUnattendedAttemptId = String(unattendedAttemptId || "").trim();
    if (unattendedTask && !scopedUnattendedAttemptId) {
      const error = new Error("无人值守采集上下文缺少当前执行标识，已拒绝重建");
      error.code = "STALE_UNATTENDED_ATTEMPT";
      throw error;
    }
    const retryAttemptId = unattendedTask
      ? scopedUnattendedAttemptId
      : `context-retry:${Date.now()}:${Math.random()
          .toString(36)
          .slice(2, 8)}`;
    const inspectCaptureTaskEndResult = (result = {}) => {
      const data = result?.data || result?.response?.data || null;
      const terminallyAbsent = Boolean(
        result?.reason === "capture_task_not_found" ||
          result?.response?.error?.code === "capture_task_not_found" ||
          result?.error?.code === "capture_task_not_found",
      );
      return {
        data,
        ignored: data?.ignored === true,
        explicitlyUnreleased: data?.released === false,
        terminallyAbsent,
        accepted: Boolean(
          (result?.ok === true || terminallyAbsent) &&
            data?.ignored !== true &&
            data?.released !== false,
        ),
      };
    };
    const sendDirectCaptureTaskEnd = async ({
      reason = "context_rebuild",
      status = "recovering",
    } = {}) => {
      let response = null;
      let state = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await chrome.runtime.sendMessage({
            type: "onstarvoice:end-capture-task",
            taskId: normalizedTaskId,
            attemptId: retryAttemptId,
            reason,
            status,
          });
        } catch (error) {
          response = {ok: false, error};
        }
        state = inspectCaptureTaskEndResult(response);
        if (state.accepted || attempt === 1) break;
        await wait(120);
      }
      return {response, state};
    };

    const sourceTabId = await resolveCaptureTaskSourceTabId({
      preferredTabId,
      platform: normalizedPlatform,
    });
    if (!Number.isSafeInteger(Number(sourceTabId)) || Number(sourceTabId) <= 0) {
      // 来源页已不存在时也不能留下可被下一轮复用的旧
      // Debug。先让本地 session 自行收尾，再用当前 attemptId
      // 补发幂等 END，确保 recovering ledger 最终结算。
      await endCaptureTaskSession({
        taskId: normalizedTaskId,
        reason: "context_rebuild_failed",
        status: "failed",
      }).catch(() => null);
      await sendDirectCaptureTaskEnd({
        reason: "context_rebuild_failed",
        status: "failed",
      }).catch(() => null);
      const error = new Error("重建采集上下文时未找到原搜索页");
      error.code = "TAB_NOT_FOUND";
      throw error;
    }

    const endResult = await endCaptureTaskSession({
      taskId: normalizedTaskId,
      reason: "context_rebuild",
      status: "recovering",
    });
    const localEndState = inspectCaptureTaskEndResult(endResult);
    let endAccepted = localEndState.accepted;

    // 侧栏刷新后本地 session 可能丢失，或本地 session 携带的已是
    // 过期 attempt。这两种情况都必须使用“当前无人值守 attempt”
    // 补发 END，并确认 background 没有将其 ignored，也没有明确
    // 返回 released:false。
    if (
      endResult?.reason === "no_active_task_session" ||
      localEndState.ignored ||
      localEndState.explicitlyUnreleased
    ) {
      const directEnd = await sendDirectCaptureTaskEnd();
      endAccepted = directEnd.state?.accepted === true;
      if (!endAccepted) {
        endResult.directEndResponse = directEnd.response;
        endResult.directEndState = directEnd.state;
      }
    }
    if (!endAccepted) {
      // 即使首次“释放为 recovering”没有得到确认，也要用
      // 同一 attemptId 再做一次终态收尾，避免任务台永久留在
      // recovering。收尾失败不吞掉下方更准确的原始错误。
      await sendDirectCaptureTaskEnd({
        reason: "context_rebuild_failed",
        status: "failed",
      }).catch(() => null);
      const error = new Error(
        endResult?.directEndResponse?.error?.message ||
          endResult?.directEndState?.data?.reason ||
          endResult?.response?.error?.message ||
          endResult?.error?.message ||
          "旧采集上下文仍在清理，暂时无法重建",
      );
      error.code = String(
        endResult?.directEndResponse?.error?.code ||
          endResult?.directEndState?.data?.reason ||
          endResult?.response?.error?.code ||
          endResult?.reason ||
          "TASK_TAB_GROUP_UNAVAILABLE",
      ).trim();
      throw error;
    }

    const ownerRequired = controllerState.captureTaskOwnerTaskId === normalizedTaskId;
    const retryDelays = [0, 150, 400, 800];
    let lastError = null;
    for (const delayMs of retryDelays) {
      if (delayMs > 0) {
        await wait(delayMs);
      }
      try {
        return await startOptionalCaptureAssistSession({
          taskId: normalizedTaskId,
          tabId: Number(sourceTabId),
          label,
          platform: normalizedPlatform,
          ownerRequired,
          attemptId: retryAttemptId,
        });
      } catch (error) {
        lastError = error;
        const retryable = new Set([
          "capture_task_cleanup_pending",
          "capture_task_not_found",
          "capture_task_already_bound",
          "TASK_TAB_GROUP_UNAVAILABLE",
        ]).has(String(error?.code || "").trim());
        if (!retryable) {
          break;
        }
      }
    }

    // BEGIN 反复失败时，仍可能在 background 留下半初始化的
    // Debug/工作页关系。使用与重建 BEGIN 相同的 attemptId 补发
    // 终态 END，同时将任务台从 recovering 结算为 failed。这是
    // best-effort 收尾，不覆盖原始重建错误。
    const failedRebuildCleanup = await sendDirectCaptureTaskEnd({
      reason: "context_rebuild_failed",
      status: "failed",
    });
    if (failedRebuildCleanup.state?.accepted !== true) {
      console.warn(
        "[Sidebar] Failed to finalize capture context rebuild cleanup:",
        failedRebuildCleanup.response?.error?.message ||
          failedRebuildCleanup.state?.data?.reason ||
          "capture task was not released",
      );
    }

    const error = new Error(
      lastError?.message || "重新建立浏览器采集上下文失败",
    );
    error.code = String(
      lastError?.code || "TASK_TAB_GROUP_UNAVAILABLE",
    ).trim();
    throw error;
  }

  return Object.freeze({
    resolveTaskCenterTitle,
    normalizeTaskCenterStatus,
    reportSidebarTaskRun,
    buildSidebarTaskRun,
    beginSidebarTask,
    finishSidebarTask,
    resolveCaptureTaskSourceTabId,
    resolveCaptureTaskTerminalStatus,
    resolveUnattendedEnhanceCancellation,
    resolveUnattendedCancellationTerminal,
    supportsPersistentCaptureTaskPlatform,
    startCaptureAssistSessionStrict,
    startOptionalCaptureAssistSession,
    rebuildCaptureTaskSessionForEnhancementRetry,
  });
}
