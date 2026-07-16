const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

const ACTIVE_RECOVERY_PHASES = new Set([
  "network_paused",
  "network_resumed",
  "system_resumed",
  "capture_recovering",
  "capture_canceling",
]);

const RETRYABLE_RECOVERY_PHASES = new Set([
  "network_timeout",
  "capture_stalled",
  "comments_partial",
  "comments_failed",
  "interrupted_repaired",
]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizePhase(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeCount(...values) {
  for (const value of values) {
    const count = Number(value);
    if (Number.isFinite(count)) {
      return Math.max(0, Math.floor(count));
    }
  }
  return 0;
}

function normalizeTimestamp(value) {
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function createAction(id, label, title = label) {
  return {id, label, title, enabled: true};
}

function resolveProgressIdentity(source = {}) {
  return {
    recordId: normalizeText(source.recordId),
    runnerTabId:
      Number.isFinite(Number(source.runnerTabId)) && Number(source.runnerTabId) > 0
        ? Number(source.runnerTabId)
        : null,
    captureRequestId: normalizeText(source.captureRequestId),
  };
}

/**
 * 只包含需要重新播报给用户的语义字段。updatedAt/heartbeatAt 等心跳字段
 * 不参与签名，避免 aria-live 在文案没有变化时反复朗读。
 */
export function buildCaptureRecoveryAnnouncementKey(view = {}) {
  const source = view && typeof view === "object" ? view : {};
  return JSON.stringify([
    normalizePhase(source.phase),
    normalizeText(source.state),
    normalizeText(source.tone),
    normalizeText(source.title),
    normalizeText(source.statusLabel),
    normalizeText(source.detail),
    normalizeText(source.nextStep),
    Boolean(source.showCancel),
    normalizeText(source.cancelLabel),
    Boolean(source.showRetry),
    normalizeText(source.retryLabel),
    Boolean(source.showDismiss),
    normalizeText(source.dismissLabel),
    normalizeText(source.recordId),
    normalizeText(source.captureRequestId),
  ]);
}

function createHiddenView(phase, reason = "not_recovery", source = {}) {
  return {
    visible: false,
    phase,
    state: "hidden",
    tone: "info",
    title: "",
    detail: "",
    nextStep: "",
    statusLabel: "",
    showCancel: false,
    cancelLabel: "取消任务",
    showRetry: false,
    retryLabel: "重试",
    showDismiss: false,
    dismissLabel: "关闭",
    pinned: false,
    actions: [],
    reason,
    ...resolveProgressIdentity(source),
  };
}

/**
 * 将底层采集进度转换为稳定的恢复提示视图模型。
 *
 * 该函数不读取 DOM、Chrome API 或全局状态。调用方只负责渲染 actions，
 * 并将 retry/cancel 事件接到现有业务处理器。
 */
export function resolveCaptureRecoveryView(
  progress,
  {
    now = Date.now(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    canRetry,
  } = {},
) {
  const source = progress && typeof progress === "object" ? progress : {};
  const phase = normalizePhase(source.phase);
  const isRecoveryPhase =
    ACTIVE_RECOVERY_PHASES.has(phase) || RETRYABLE_RECOVERY_PHASES.has(phase);
  if (!isRecoveryPhase) {
    return createHiddenView(phase, "not_recovery", source);
  }

  const updatedAt = normalizeTimestamp(source.updatedAt ?? source.heartbeatAt);
  const currentTime = Number(now);
  const maxAge = Number(staleAfterMs);
  if (
    updatedAt > 0 &&
    Number.isFinite(currentTime) &&
    Number.isFinite(maxAge) &&
    maxAge >= 0 &&
    currentTime - updatedAt > maxAge
  ) {
    return createHiddenView(phase, "stale", source);
  }

  const identity = resolveProgressIdentity(source);
  const {recordId} = identity;
  const retryAllowed =
    typeof canRetry === "boolean" ? canRetry : Boolean(recordId);
  const batchTotal = normalizeCount(source.total);
  const cancelLabel =
    batchTotal > 1
      ? "取消整个任务并保留"
      : recordId
        ? "取消并保留"
        : "取消任务";
  const cancelAction = createAction("cancel", cancelLabel, "取消本次采集任务");
  const dismissAction = createAction("dismiss", "保留结果", "关闭本条提示");
  const retryActions = retryAllowed
    ? [createAction("retry", "重试", "重新采集当前步骤")]
    : [];
  const terminalActions = [...retryActions, dismissAction];
  const count = normalizeCount(
    source.savedCount,
    source.collectedCount,
    source.commentsTotalCaptured,
  );

  const base = {
    visible: true,
    phase,
    nextStep: "",
    statusLabel: "",
    showCancel: false,
    cancelLabel,
    showRetry: false,
    retryLabel: "重试",
    showDismiss: false,
    dismissLabel: "保留结果",
    pinned: true,
    ...identity,
    reason: "",
  };

  if (phase === "network_paused") {
    return {
      ...base,
      state: "paused",
      tone: "warning",
      title: "网络已断开，采集已暂停",
      detail: "联网后会自动继续；如果暂时不想等待，可以取消本次任务。",
      nextStep: "等待网络恢复，系统会自动继续",
      statusLabel: "等待网络",
      showCancel: true,
      pinned: false,
      actions: [cancelAction],
    };
  }

  if (phase === "network_resumed") {
    return {
      ...base,
      state: "resuming",
      tone: "success",
      title: "网络已恢复",
      detail: "正在继续采集，请保持当前页面打开。",
      nextStep: "保持目标页面打开",
      statusLabel: "继续采集中",
      showCancel: true,
      pinned: false,
      actions: [cancelAction],
    };
  }

  if (phase === "system_resumed") {
    return {
      ...base,
      state: "resuming",
      tone: "info",
      title: "检测到电脑已从休眠中恢复",
      detail: "正在重新连接页面；电脑休眠的时间不会计入采集超时。",
      nextStep: "保持目标页面打开，等待状态检查完成",
      statusLabel: "恢复检查中",
      showCancel: true,
      pinned: false,
      actions: [cancelAction],
    };
  }

  if (phase === "capture_recovering") {
    const attempt = normalizeCount(source.recoveryAttempt);
    const maxAttempts = Math.max(1, normalizeCount(source.recoveryMaxAttempts));
    return {
      ...base,
      state: "recovering",
      tone: "warning",
      title: "页面 90 秒没有新进度",
      detail: attempt > 0
        ? `可能是网络、电脑休眠或页面卡住；正在刷新原页面并自动重试（${attempt}/${maxAttempts}）。`
        : "可能是网络、电脑休眠或页面卡住；正在刷新原页面并自动重试。",
      nextStep: "等待自动恢复完成，或取消本次任务",
      statusLabel: "自动恢复中",
      showCancel: true,
      pinned: false,
      actions: [cancelAction],
    };
  }

  if (phase === "capture_canceling") {
    return {
      ...base,
      state: "canceling",
      tone: "warning",
      title: "正在取消并保存可用结果",
      detail: "正在结束当前页面步骤，请不要重复点击。",
      nextStep: "保存完成后会显示可用的继续方式",
      statusLabel: "正在停止",
      pinned: false,
      actions: [],
    };
  }

  if (phase === "network_timeout") {
    return {
      ...base,
      state: "finishing",
      tone: "error",
      title: "断网时间较长，正在结束当前步骤",
      detail: "系统正在保存已经采集到的数据，暂时无需重复操作。",
      nextStep: "保存完成后，可继续当前项或重新点击原采集入口",
      statusLabel: "正在保存",
      pinned: false,
      actions: [],
    };
  }

  if (phase === "capture_stalled") {
    return {
      ...base,
      state: "finishing",
      tone: "error",
      title: "当前页面步骤仍无响应",
      detail: "正在停止旧步骤并保存可用结果，暂时无需重复操作。",
      nextStep: "保存完成后，可继续当前项或重新点击原采集入口",
      statusLabel: "正在保存",
      pinned: false,
      actions: [],
    };
  }

  if (phase === "comments_partial") {
    const stoppedByUser = Boolean(source.stoppedByUser);
    const stoppedByNetwork = Boolean(source.stoppedByNetwork);
    const stoppedByStall = Boolean(source.stoppedByStall);
    const errorText = normalizeText(source.errorMessage || source.message);
    return {
      ...base,
      state: "retryable",
      tone: "warning",
      title: stoppedByUser
        ? "评论采集已由你停止"
        : stoppedByNetwork
          ? "网络中断，评论采集已停止"
          : stoppedByStall
            ? "页面卡住，评论采集已停止"
            : "评论采集中断",
      detail:
        count > 0
          ? `已保留 ${count} 条评论，可以继续采集。`
          : errorText || "已保存可用数据，可以继续采集评论。",
      nextStep: "点击重试继续采集当前作品的评论",
      statusLabel: "部分完成",
      showRetry: retryAllowed,
      retryLabel: "继续采集",
      showDismiss: true,
      actions: terminalActions,
    };
  }

  if (phase === "comments_failed") {
    const errorText = normalizeText(
      source.errorMessage || source.error?.message || source.message,
    );
    return {
      ...base,
      state: "retryable",
      tone: "error",
      title: "评论采集未完成",
      detail:
        errorText || "页面或网络可能发生了中断，可以重试当前作品的评论采集。",
      nextStep: "确认网络和目标页面正常后点击重试",
      statusLabel: "采集失败",
      showRetry: retryAllowed,
      showDismiss: true,
      actions: terminalActions,
    };
  }

  const interruptedCount = normalizeCount(source.interruptedCount);
  return {
    ...base,
    state: "retryable",
    tone: "warning",
    title: "检测到上次任务意外中断",
    detail: interruptedCount > 1
      ? `${interruptedCount} 条评论记录已结束旧的等待状态；可先继续当前项，也可在各记录卡片分别处理。`
      : count > 0
      ? `已结束旧的等待状态，并保留 ${count} 条评论；可以重试继续采集。`
      : "已结束旧的等待状态；可以从当前作品重新采集。",
    nextStep: "点击重试重新进入当前作品的评论采集",
    statusLabel: "任务已恢复为可重试",
    showRetry: retryAllowed,
    retryLabel: count > 0 ? "继续采集" : "重新采集",
    showDismiss: true,
    actions: terminalActions,
  };
}

/**
 * 将评论采集字段转换为卡片展示模型。action 只会是 cancel、retry 或空串。
 */
export function resolveCommentCaptureStatusView(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const status = normalizePhase(source.commentsCaptureStatus ?? source.status) ||
    "not_started";
  const total = normalizeCount(
    source.commentsTotalCaptured,
    source.collectedCount,
  );
  const errorText = normalizeText(
    source.commentsCaptureError ?? source.errorMessage,
  );
  const observedBeforeInterrupt = normalizeCount(
    source.commentsObservedBeforeInterrupt,
  );

  if (status === "capturing") {
    return {
      title: `评论采集中（${total}条）`,
      detail: "请保持目标页面打开；如暂时不想等待，可以停止并保留已采集评论。",
      tone: "info",
      action: "cancel",
      actionLabel: "停止并保留",
    };
  }

  if (status === "partial") {
    const stoppedByUser = Boolean(source.commentsCaptureStoppedByUser);
    const observedDetail =
      observedBeforeInterrupt > total
        ? `中断前检测到 ${observedBeforeInterrupt} 条，实际已保存 ${total} 条。`
        : "";
    return {
      title: stoppedByUser
        ? `已停止并保存 ${total} 条评论`
        : `评论采集中断，已保存 ${total} 条`,
      detail: [errorText || "已保存现有评论，可以继续采集。", observedDetail]
        .filter(Boolean)
        .join(" "),
      tone: "warning",
      action: "retry",
      actionLabel: "继续采集",
    };
  }

  if (status === "failed") {
    return {
      title: "评论采集未完成",
      detail: errorText || "请检查网络和目标页面后重试。",
      tone: "error",
      action: "retry",
      actionLabel: "重试",
    };
  }

  if (status === "done") {
    return {
      title: `评论已合并（${total}条）`,
      detail: "评论采集已经完成。",
      tone: "success",
      action: "",
      actionLabel: "",
    };
  }

  return {
    title: "评论未采集",
    detail: "",
    tone: "neutral",
    action: "",
    actionLabel: "",
  };
}

/**
 * 解析评论卡片的操作按钮。运行态只允许停止，终态只允许重试，
 * 避免同一卡片同时出现会造成并发采集的两个动作。
 */
export function resolveCommentCaptureActions(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const view = resolveCommentCaptureStatusView(source);
  const recordId = normalizeText(source.recordId ?? source.id);
  if (!recordId) {
    return [];
  }

  if (view.action === "cancel") {
    return [
      createAction("cancel", view.actionLabel, "停止当前作品的评论采集"),
    ];
  }
  if (view.action === "retry") {
    return [
      createAction("retry", view.actionLabel, "重新采集当前作品的评论"),
    ];
  }
  return [];
}
