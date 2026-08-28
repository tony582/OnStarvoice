/**
 * onstarvoice V2.0 Sidebar Business Logic
 * 侧边栏业务逻辑层
 *
 * 本模块负责：
 * 1. 连接 UI 层（Gemini 的新 sidebar）和数据层（采集模块、存储层）
 * 2. 处理用户交互事件
 * 3. 更新 UI 状态
 * 4. 调用采集和同步功能
 */

import "../utils/cloud-targeted-post.js";

import {
  initAllStates,
  subscribe,
  getCurrentRuntime,
  getCurrentAuth,
  getCurrentTarget,
  getCurrentCapture,
  getCurrentSync,
  getCurrentMonitor,
  getCurrentDataPool,
  setCurrentAuth,
  setCurrentMonitor,
  resetCurrentMonitor,
  setCurrentTarget,
  refreshDataPool,
  refreshSyncHistory,
  refreshTaskLedger,
} from "./state.js";

import {
  captureAndSync,
  captureNoteWithOptionalComments,
  retryCommentsForRecord,
  batchCaptureDetailsForRecords,
  repairInterruptedDetailCaptureRecords,
  repairInterruptedCommentCaptureRecords,
  resolveSyncInputForRecord,
  syncRecordBatch,
  checkBeforeSync,
  buildCommentLeadsConfigFromSettings,
  buildCommentLeadsPayloadForRecord,
  batchCaptureByKeywords,
  batchCaptureByUrls,
  lightSampleByKeywords,
  captureTabContent,
  beginDouyinSearchResultTransitionInTab,
  readDouyinSearchDocumentGenerationInTab,
  beginCaptureTaskSession,
  updateCaptureTaskSession,
  endCaptureTaskSession,
} from "../utils/capture-sync.js";
import {
  getCaptureSettings,
  saveCaptureSettings,
  DEFAULT_CAPTURE_SETTINGS,
} from "../utils/capture-settings.js";
import {createRecordSyncQueue} from "../utils/record-sync-queue.js";
import {
  discardUnattendedCheckpointReports,
  enqueueUnattendedCheckpointReport,
  flushUnattendedCheckpointReportOutbox,
} from "../utils/unattended-report-outbox.js";
import {runEnhancementWithSingleRetry} from "../utils/capture/enhancement-retry.js";
import {
  addSyncHistoryEntry,
  ensureControlStorageReserve,
  getAuth,
  getRecords,
  isStorageQuotaError,
  releaseControlStorageReserve,
} from "../utils/storage.js";

import {
  verify,
  getTargetConfig,
  saveTargetConfig,
  getUpdateManifest,
  analyzeKeywords,
  analyzeKeywordOpportunity,
  analyzeBenchmarkDiscovery,
  listMonitorSubscriptions,
  listMonitorExecutions,
  startMonitorExecution,
  finishMonitorExecution,
  getMonitorSettings,
  saveMonitorSettings,
  createMonitorSubscription,
  updateMonitorSubscription,
  runMonitorNow,
} from "../utils/api.js";
import {
  PAGE_TYPE,
  ERROR_REASON,
  ERROR_MESSAGE_MAP,
  AUTH_STATUS,
  SYNC_TYPE,
  MESSAGE_TYPE,
  DEFAULT_CONFIG,
  UNCLAIMED_CREDENTIAL_OWNER_EMAIL,
  UNCLAIMED_CREDENTIAL_OWNER_NAME,
  CREDENTIAL_CLAIM_PAGE_URL,
} from "../utils/constants.js";
import {setCancelFlag, wait} from "../utils/scroll.js";
import {repairInterruptedCommentPayload} from "../utils/capture-recovery.js";
import {
  buildDiagnosticsText,
  recordDiagnosticAction,
  recordDiagnosticError,
  recordDiagnosticTask,
} from "../utils/diagnostics.js";
import {
  beginTaskContext,
  completeTaskContext,
  getActiveTaskContext,
} from "../utils/task-context.js";
import {
  advanceUnattendedCheckpointRound,
  findUnattendedResumeKeyword,
  isUnattendedSafetyBlock,
  normalizeUnattendedKeywordCheckpoint,
  resolveCompletedCheckpointKeywords,
  runUnattendedKeywordAttempts,
  settleUnattendedKeywordCheckpoint,
  summarizeUnattendedKeywordCheckpoint,
} from "../utils/unattended-keyword-run.js";
import {
  AUTH_CODE_VIEW_MODE,
  ensureEncryptedAuthCode,
  ensurePlainAuthCode,
  isEncryptedAuthCode,
  normalizeAuthCodeInput,
} from "../utils/auth-code.js";
import {extractNoteId} from "../utils/helpers.js";
import {detectPlatformFromUrl} from "../utils/platform/page-routing.js";
import {
  buildCaptureRecoveryAnnouncementKey,
  resolveCaptureRecoveryView,
} from "../utils/capture-recovery-ui.js";
import {
  getPlatformCapabilities,
  getPlatformCopy,
  getRecordTypesForTab,
  resolveRecordPlatform,
} from "./platform-registry.js";

let activeCommentsCaptureRecordId = "";
let activeCommentsCaptureTabId = null;
let activeCommentsCaptureRequestId = "";
let activeRecoveryProgress = null;
let activeRecoveryRunnerTabId = null;
let captureRecoveryFreshnessTimer = null;
const suppressedCaptureRecoveryKeys = new Set();
const commentCaptureTerminalStatusByRecordId = new Map();
let detailBatchCaptureInFlight = false;
let detailBatchCancelRequested = false;
let activeDetailCaptureInvocationToken = null;
let detailBatchRunnerTabId = null;
const detailBatchRunnerTabIds = new Set();
let detailBatchWorkerStates = [];
let detailBatchWorkerMode = "";
let detailBatchWorkerRevision = 0;
let lastProgressSyncAt = 0;
let lastPoolRefreshAt = 0;
const DEFAULT_BLOGGER_PROFILE_TABLE_NAME = "博主信息表";
const DEFAULT_BLOGGER_NOTES_TABLE_NAME = "博主笔记采集";
const DEFAULT_KEYWORD_NOTES_TABLE_NAME = "关键词笔记采集";
const DEFAULT_COMMENT_LEADS_TABLE_NAME = "评论区客资采集";
const DEFAULT_MONITOR_TABLE_NAME = "监控内容表";
const DEFAULT_SINGLE_NOTE_TABLE_NAME = "单笔记采集";
const NOTE_DETAIL_LOADING_TEXT = "正在等待笔记内容加载完成，请等页面不再显示“加载中”后再采集";
const MAX_SYNC_RECORDS_PER_BATCH = 500;
const SYNC_SCOPE_PENDING = "pending";
const SYNC_SCOPE_ALL = "all";
const DETAIL_CAPTURE_SCOPE_PENDING = "pending";
const DETAIL_CAPTURE_SCOPE_ALL = "all";
const SYNC_BATCH_LIMIT_MESSAGE =
  "单次同步上限为 500 条，请分批操作，本次同步前 500 条数据";
const AUTH_CODE_AUTO_ENCRYPT_DELAY = 600;
const AUTH_REQUIRED_MESSAGE =
  "当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。";
const MONITOR_REQUIRED_MESSAGE = AUTH_REQUIRED_MESSAGE;
const PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE = AUTH_REQUIRED_MESSAGE;
const MONITOR_PUBLISH_WINDOW = Object.freeze({
  LAST_24H: "last_24h",
  PREVIOUS_DAY: "previous_day",
});
const MONITOR_PUBLISH_WINDOW_OPTIONS = new Set(
  Object.values(MONITOR_PUBLISH_WINDOW),
);
const MONITOR_DAY_MS = 24 * 60 * 60 * 1000;
const MONITOR_SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
let lastTaskLedgerProgressAt = 0;

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
      "浏览器 AI Debug 接管意外中断，无人值守任务已停止",
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

async function startRequiredCaptureTaskSession(options = {}) {
  const taskId = String(options?.taskId || "").trim();
  const platform = String(options?.platform || "").trim().toLowerCase();
  const ownerRequired = options?.ownerRequired !== false;
  if (!supportsPersistentCaptureTaskPlatform(platform)) {
    const error = new Error("任务级 AI Debug 当前仅支持小红书和抖音");
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
      "任务接管初始化失败",
  ).trim();
  const error = new Error(`无法启动 AI Debug 任务：${reason}`);
  error.code = String(
    result?.response?.error?.code || result?.reason || "capture_task_unavailable",
  );
  throw error;
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

  const ownerRequired = captureTaskOwnerTaskId === normalizedTaskId;
  const retryDelays = [0, 150, 400, 800];
  let lastError = null;
  for (const delayMs of retryDelays) {
    if (delayMs > 0) {
      await wait(delayMs);
    }
    try {
      return await startRequiredCaptureTaskSession({
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
        "capture_task_source_mismatch",
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

const DEFAULT_MONITOR_SETTINGS = Object.freeze({
  publishWindow: MONITOR_PUBLISH_WINDOW.LAST_24H,
  likeThreshold: 0,
  runTimes: ["10:00"],
  observeWindowHours: 48,
  timezone: "Asia/Shanghai",
});
const MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW = Object.freeze({
  24: 20,
  48: 30,
  72: 40,
});
const MONITOR_DETAIL_DATE_DISCOVERY_MIN = 20;
const MONITOR_DETAIL_DATE_DISCOVERY_MAX = 60;
const MONITOR_DETAIL_DATE_DISCOVERY_MULTIPLIER = 3;
const MONITOR_LATEST_POSTS_LIMIT_MAX = 100;
const MONITOR_OBSERVE_WINDOW_OPTIONS = Object.freeze([24, 48, 72]);
const MONITOR_RUN_TIME_OPTIONS = Object.freeze(
  Array.from({length: 24}, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
);
const KEYWORD_INSIGHT_ANALYSIS_COST_CREDITS = 3;
const KEYWORD_OPPORTUNITY_ANALYSIS_COST_CREDITS = 3;
const BENCHMARK_DISCOVERY_ANALYSIS_COST_CREDITS = 3;
const BENCHMARK_DISCOVERY_PROFILE_LIMIT = 8;
const BENCHMARK_DISCOVERY_RESULT_LIMIT = 12;
const MONITOR_STATUS = Object.freeze({
  ALL: "all",
  ACTIVE: "active",
  PAUSED: "paused",
  PAUSED_INSUFFICIENT_BALANCE: "paused_insufficient_balance",
  DELETED: "deleted",
});
const MONITOR_SUBJECT_TYPE = Object.freeze({
  CREATOR: "creator",
  OFFICIAL: "official",
});
const KEYWORD_SORT_DIMENSION = {
  LIKES: "likes",
  COLLECTS: "collects",
  COMMENTS: "comments",
};
const KEYWORD_SORT_DIMENSION_LABEL = {
  [KEYWORD_SORT_DIMENSION.LIKES]: "点赞",
  [KEYWORD_SORT_DIMENSION.COLLECTS]: "收藏",
  [KEYWORD_SORT_DIMENSION.COMMENTS]: "评论",
};
const SEARCH_KEYWORD_QUERY_KEYS = new Set([
  "keyword",
  "query",
  "q",
  "search_keyword",
  "searchkey",
  "search_word",
]);
const COMMENT_PHASE_TO_TERMINAL_STATUS = Object.freeze({
  comments_done: "done",
  comments_partial: "partial",
  comments_failed: "failed",
});
const KEYWORD_SORT_SYNC_INTERVAL_MS = 1800;
const EXTENSION_UPDATE_MODAL_STATE_KEY = "onstarvoice.updateModalState";
const RISK_NOTICE_ACKNOWLEDGED_KEY = "onstarvoice.riskNoticeAcknowledged";
const MEMBER_GROUP_PROMPT_STATE_KEY = "onstarvoice.memberGroupPromptState";
const TERMINAL_SUMMARY_ACK_STORAGE_KEY =
  "onstarvoice.terminalSummaryAcknowledgements";
const DEFAULT_UPDATE_DOWNLOAD_URL = "https://voice.minilife.online/about";
const DEFAULT_UPDATE_CHANGELOG_URL = "https://voice.minilife.online/about#changelog";
const EXTENSION_MANAGEMENT_URL = `chrome://extensions/?id=${chrome.runtime.id}`;
const EXTENSION_INSTALL_TYPE = Object.freeze({
  NORMAL: "normal",
  DEVELOPMENT: "development",
  SIDELOAD: "sideload",
  ADMIN: "admin",
  OTHER: "other",
});
const UPDATE_ACTION_MODE = Object.freeze({
  USE_NOW: "use_now",
  OPEN_EXTENSION_MANAGER: "open_extension_manager",
  OPEN_DOWNLOAD_PAGE: "open_download_page",
});

let authCodeViewMode = AUTH_CODE_VIEW_MODE.ENCRYPTED;
let authCodeEncryptTimer = null;
let authCodePersistPromise = Promise.resolve();
let authCodeRenderToken = 0;
let authCodeRevision = 0;
let authVerifyInFlight = false;
let authVerifyQueue = Promise.resolve();
let authVerifyPromise = null;
let authRefreshPromise = null;
let contactModalListenersBound = false;
let memberGroupModalListenersBound = false;
let riskModalListenersBound = false;
let debugSessionPanelMinimized = false;
let debugSessionPanelListenersBound = false;
let debugSessionDismissedUnattendedTerminalRunAt = "";
let debugSessionDismissedTargetedTerminalRunAt = "";
let activeCaptureTaskProgressContext = null;
let debugSessionClockTimer = null;
let debugSessionClockSnapshot = null;
let debugSessionActivityTaskId = "";
let debugSessionActivityEvents = [];
let debugSessionLastActivitySignature = "";
let debugSessionTerminalizedActivityId = "";
let updateModalListenersBound = false;
let updateGuideModalListenersBound = false;
let keywordSortDimension = KEYWORD_SORT_DIMENSION.LIKES;
let keywordSortSyncTimer = null;
let lastRuntimePageUrlForKeywordSort = "";
let expandedKeywordsBuffer = [];
let keywordExpandInFlight = false;
let keywordExpandCancelRequested = false;
let batchUrlCaptureInFlight = false;
let batchUrlCancelRequested = false;
let batchUrlCaptureMode = "";
let targetedPostCancelRequested = false;
let targetedPostRunInFlight = false;
let targetedPostRunState = null;
let targetedPostRunBindingStopReason = "";
let activeTargetedPostInvocationToken = null;
let targetedPostRunInFlightOwnerToken = null;
let targetedPostBatchStateOwnerToken = null;
let targetedPostRunnerTabOwnerToken = null;
let batchKeywordCaptureInFlight = false;
let batchKeywordCancelRequested = false;
let activeBatchKeywordInvocationToken = null;
let searchCaptureCancelRequested = false;
let activeBatchRunnerTabId = null;
const CAPTURE_TASK_OWNER_PORT_NAME = "osv.capture.sidebar-owner.v1";
let captureTaskOwnerPort = null;
let captureTaskOwnerClosing = false;
let captureTaskOwnerTaskId = "";
let lastCaptureTaskCancellationKey = "";
let activeCaptureTaskCancellationReason = "";
let monitorRunInFlight = false;
let monitorRunCancelRequested = false;
let keywordAnalysisInFlight = false;
let keywordInsightSampleInFlight = false;
let keywordInsightRunToken = 0;
let keywordAnalysisStartedAt = 0;
let keywordStrategyPanelVisible = false;
let keywordStrategyActiveTab = "opportunity";
let keywordBenchmarkInFlight = false;
let keywordBenchmarkCancelRequested = false;
let keywordBenchmarkStartedAt = 0;
let keywordBenchmarkResult = null;
let keywordBenchmarkErrorMessage = "";
let keywordBenchmarkAnalysisStatus = "idle";
let keywordBenchmarkLoadingTitle = "";
let keywordBenchmarkLoadingMeta = "";
let keywordOpportunityInFlight = false;
let keywordOpportunityCancelRequested = false;
let keywordOpportunityStartedAt = 0;
let keywordOpportunityResult = null;
let keywordOpportunityErrorMessage = "";
let expandedKeywordsPanelVisible = false;
const expandedKeywordInsightCategoryIds = new Set();
let lastRuntimePageTypeForKeywordSort = PAGE_TYPE.UNKNOWN;
let manualSelectedPlatform = "";
let lastKnownPagePlatform = "unknown";
let currentUpdateNoticeState = null;
let activeCaptureExecutionLockId = "";
let adoptedUnattendedCaptureExecutionLockId = "";
let captureExecutionLockHeartbeatTimer = null;
let captureExecutionLockHeartbeatLockId = "";
let captureExecutionLockHeartbeatInFlight = false;
let captureExecutionLockInitialHolderTabId = null;
let captureExecutionLockReleasePendingId = "";
const CAPTURE_EXECUTION_LOCK_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const TARGETED_POST_RUN_HEARTBEAT_INTERVAL_MS = 20 * 1000;
const CAPTURE_EXECUTION_LOCK_HOLDER_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `sidebar-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const KEYWORD_ANALYSIS_STALE_LOCK_MS =
  DEFAULT_CONFIG.KEYWORD_ANALYSIS_TIMEOUT + 5000;
const MAX_BATCH_KEYWORDS = 30;
const EYE_ICON = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
  <circle cx="12" cy="12" r="3"></circle>
</svg>
`;
const EYE_OFF_ICON = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
  <circle cx="12" cy="12" r="3"></circle>
  <path d="M3 3l18 18"></path>
</svg>
`;

function postCaptureTaskOwnerMessage(message) {
  if (!captureTaskOwnerPort) return false;
  try {
    captureTaskOwnerPort.postMessage(message);
    return true;
  } catch (error) {
    console.warn("[Sidebar] Capture task owner message failed:", error);
    return false;
  }
}

function bindCaptureTaskOwner(taskId) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return;
  captureTaskOwnerTaskId = normalizedTaskId;
  if (!captureTaskOwnerPort && !captureTaskOwnerClosing) {
    connectCaptureTaskOwnerPort();
  }
  postCaptureTaskOwnerMessage({
    type: "capture-owner:bind",
    taskId: normalizedTaskId,
  });
}

function releaseCaptureTaskOwner(taskId) {
  const normalizedTaskId = String(taskId || captureTaskOwnerTaskId || "").trim();
  if (!normalizedTaskId) return;
  postCaptureTaskOwnerMessage({
    type: "capture-owner:unbind",
    taskId: normalizedTaskId,
  });
  if (captureTaskOwnerTaskId === normalizedTaskId) {
    captureTaskOwnerTaskId = "";
  }
}

function applyCaptureTaskCancellation(cancellation = {}) {
  const taskId = String(cancellation?.taskId || "").trim();
  if (!taskId || taskId !== captureTaskOwnerTaskId) return;
  const cancellationKey = `${taskId}:${String(
    cancellation?.requestedAt || cancellation?.reason || "canceled",
  )}`;
  if (cancellationKey === lastCaptureTaskCancellationKey) return;
  lastCaptureTaskCancellationKey = cancellationKey;
  activeCaptureTaskCancellationReason = String(
    cancellation?.reason || "capture_task_canceled",
  ).trim();

  setCancelFlag(true);
  searchCaptureCancelRequested = true;
  batchKeywordCancelRequested = true;
  detailBatchCancelRequested = true;
  batchUrlCancelRequested = true;
  monitorRunCancelRequested = true;
  const taskWorkerTabIds = Array.isArray(
    getCurrentRuntime()?.captureDebugSession?.workerTabIds,
  )
    ? getCurrentRuntime().captureDebugSession.workerTabIds
    : [];
  const fallbackTabId =
    (Number.isSafeInteger(Number(activeBatchRunnerTabId)) &&
      Number(activeBatchRunnerTabId)) ||
    null;
  requestDetailRunnerCancelSignals({
    extraTabIds: taskWorkerTabIds,
    fallbackTabId,
  }).catch((error) => {
    console.warn("[Sidebar] Relay native Debug cancellation failed:", error);
  });
  showMessage(
    cancellation?.reason === "sidebar_owner_disconnected"
      ? "控制面板已关闭，采集任务已安全停止"
      : "浏览器 Debug 接管已取消，整项采集正在停止",
    "warning",
  );
}

function syncCaptureTaskOwnerFromRuntime(runtime = {}) {
  const cancellation = runtime?.captureTaskCancellation;
  if (cancellation && typeof cancellation === "object") {
    applyCaptureTaskCancellation(cancellation);
  }
}

function connectCaptureTaskOwnerPort() {
  if (captureTaskOwnerClosing || captureTaskOwnerPort) return;
  let port;
  try {
    port = chrome.runtime.connect({name: CAPTURE_TASK_OWNER_PORT_NAME});
  } catch (error) {
    console.warn("[Sidebar] Capture task owner port unavailable:", error);
    return;
  }
  captureTaskOwnerPort = port;
  port.onMessage.addListener((message) => {
    if (message?.type !== "capture-owner:canceled") return;
    applyCaptureTaskCancellation({
      ...(message?.payload && typeof message.payload === "object"
        ? message.payload
        : {}),
      ...message,
    });
  });
  port.onDisconnect.addListener(() => {
    if (captureTaskOwnerPort === port) {
      captureTaskOwnerPort = null;
    }
    if (!captureTaskOwnerClosing) {
      setTimeout(() => {
        if (captureTaskOwnerClosing || captureTaskOwnerPort) return;
        connectCaptureTaskOwnerPort();
        if (captureTaskOwnerTaskId) {
          bindCaptureTaskOwner(captureTaskOwnerTaskId);
        }
      }, 150);
    }
  });
  if (captureTaskOwnerTaskId) {
    postCaptureTaskOwnerMessage({
      type: "capture-owner:bind",
      taskId: captureTaskOwnerTaskId,
    });
  }
}

// ==================== 批量操作弹窗逻辑 ====================

const BATCH_MODE_META = {
  links: {title: "批量采集作品"},
  bloggers: {title: "批量采集博主"},
  keywords: {title: "批量关键词操作"},
};
const BATCH_DRAFT_SESSION_KEY = "onstarvoice.batchDraftByPlatform";
const BATCH_DRAFT_LEGACY_KEYS = ["expandedKeywords", "expandedSeedKeyword"];
const BATCH_DRAFT_PLATFORMS = new Set(["xiaohongshu", "douyin", "unknown"]);
const UNATTENDED_RUN_QUERY_KEY = "unattendedRun";
const UNATTENDED_RUN_ATTEMPT_QUERY_KEY = "unattendedAttempt";
const TARGETED_POST_RUN_QUERY_KEY = "targetedPostRun";
const TARGETED_POST_RUN_ATTEMPT_QUERY_KEY = "targetedPostAttempt";
const TARGETED_POST_RUN_REQUEST_STORAGE_KEY =
  "onstarvoice.targetedPostRunRequest";
const cloudTargetedPostApi = globalThis.OnStarvoiceCloudTargetedPost;
const KEYWORD_PLAN_STORAGE_KEY = "onstarvoice.unattendedKeywordPlan";
const KEYWORD_RUN_REQUEST_STORAGE_KEY = "onstarvoice.unattendedKeywordRunRequest";
const KEYWORD_PLAN_RECONCILE_INTERVAL_MS = 5 * 1000;
const UNATTENDED_RUN_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const UNATTENDED_PROTECTED_WAIT_TICK_MS = 30 * 1000;
const UNATTENDED_CONTENT_PROGRESS_MIN_INTERVAL_MS = 1500;
const UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS = [0, 500, 1500];
const UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS = [0, 500, 1500];
const UNATTENDED_TERMINAL_CONFIRM_RETRY_MAX_MS = 30 * 1000;
const UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS = 10 * 1000;
const UNATTENDED_KEYWORD_MAX_ATTEMPTS = 4;
const UNATTENDED_KEYWORD_RETRY_DELAYS_MS = Object.freeze([
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
]);
const UNATTENDED_AGENT_COOLDOWN_HOME_URLS = Object.freeze({
  xiaohongshu:
    "https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend",
  douyin: "https://www.douyin.com/jingxuan",
});
const UNATTENDED_ELASTIC_RELEASE_MIN_DELAY_MS = 2 * 60 * 1000;
const UNATTENDED_KEYWORD_RETRY_MIN_MS = 8 * 1000;
const UNATTENDED_KEYWORD_RETRY_MAX_MS = 18 * 1000;
// 首次把平台页切到关键词时，弱网、平台改写页面或标签替换都可能让短时
// 就绪检查错过目标页。优先给当前 Agent 足够时间等待同一页面完成加载；
// 只有绑定页始终无法就绪才交给其它 Agent，避免多台设备反复搜索同一词。
const UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS = 4;
const UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS = Object.freeze([
  20 * 1000,
  60 * 1000,
  3 * 60 * 1000,
]);
const UNATTENDED_BOOTSTRAP_GATE_MAX_WAIT_MS = 60 * 1000;
const UNATTENDED_CAPTURE_SESSION_MAX_ATTEMPTS = 4;
const UNATTENDED_CAPTURE_SESSION_RETRY_DELAYS_MS = Object.freeze([
  15 * 1000,
  45 * 1000,
  2 * 60 * 1000,
]);
const UNATTENDED_CAPTURE_SESSION_RETRYABLE_CODES = new Set([
  "capture_task_group_busy",
  "capture_task_cleanup_pending",
  "capture_task_debug_busy",
]);
let activeUnattendedRunRequestId = "";
let activeUnattendedRunAttemptId = "";
let pendingUnattendedCancellationRequestId = "";
let pendingUnattendedCancellationAttemptId = "";
let activeUnattendedTerminalProgressKey = "";
let activeUnattendedProgressSeq = 0;
let activeUnattendedAttemptRejected = false;
let lastUnattendedContentProgressAt = 0;
let lastUnattendedContentProgressFingerprint = "";
const KEYWORD_PLAN_MODES = new Set([
  "daily",
  "custom_dates",
]);
const KEYWORD_PLAN_MODE_LABELS = {
  daily: "每天",
  custom_dates: "指定日期清单",
};
const KEYWORD_PLAN_STATUS_LABELS = {
  started: "已启动",
  running: "运行中",
  recovering: "自动恢复中",
  completed: "已完成",
  completed_with_failures: "部分完成",
  needs_action: "需要处理",
  failed: "失败",
  canceled: "已取消",
  skipped: "已跳过",
  deferred: "等待重试",
};
const KEYWORD_PLAN_TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_failures",
  "needs_action",
  "failed",
  "canceled",
  "skipped",
]);
const KEYWORD_PLAN_CONTROL_IDS = {
  modal: {
    enabled: "chkKeywordPlanEnabled",
    mode: "selectKeywordPlanMode",
    startTime: "inputKeywordPlanStartTime",
    jitter: "inputKeywordPlanJitterMin",
    customDates: "textareaKeywordPlanCustomDates",
    customGroup: "keywordPlanCustomDatesGroup",
    status: "keywordPlanStatus",
    sort: "selectBatchSort",
    publishTime: "selectBatchPublishTime",
    contentType: "selectBatchContentType",
    searchScope: "selectBatchScope",
    distance: "selectBatchDistance",
    videoDuration: "selectBatchVideoDuration",
    autoLoop: "chkAutoLoop",
    roundGap: "inputLoopGapMin",
    maxRounds: "inputLoopRounds",
    keywords: "textareaBatchKeywords",
  },
  search: {
    enabled: "chkSearchKeywordPlanEnabled",
    mode: "selectSearchKeywordPlanMode",
    startTime: "inputSearchKeywordPlanStartTime",
    jitter: "inputSearchKeywordPlanJitterMin",
    customDates: "textareaSearchKeywordPlanCustomDates",
    customGroup: "searchKeywordPlanCustomDatesGroup",
    status: "searchKeywordPlanStatus",
    sort: "selectSearchSort",
    publishTime: "selectSearchPublishTime",
    contentType: "selectSearchContentType",
    searchScope: "selectSearchScope",
    distance: "selectSearchDistance",
    videoDuration: "selectSearchVideoDuration",
    autoLoop: "chkSearchAutoLoop",
    roundGap: "inputSearchLoopGapMin",
    maxRounds: "inputSearchLoopRounds",
    keywords: "textareaSearchBatchKeywords",
  },
};
const SEARCH_FILTER_FIELD_META = {
  sort: {
    defaultValue: "comprehensive",
    storageDefault: "",
  },
  publishTime: {
    defaultValue: "all",
    storageDefault: "",
  },
  contentType: {
    defaultValue: "all",
    storageDefault: "",
  },
  searchScope: {
    defaultValue: "all",
    storageDefault: "",
  },
  distance: {
    defaultValue: "all",
    storageDefault: "",
  },
  videoDuration: {
    defaultValue: "all",
    storageDefault: "",
  },
};
const SEARCH_FILTER_SCOPE_META = {
  search: {
    hint: "searchFilterPlatformHint",
    contentTypeField: "searchContentTypeField",
    contentTypeLabel: "searchContentTypeLabel",
    searchScopeField: "searchScopeField",
    distanceField: "searchDistanceField",
    videoDurationField: "searchVideoDurationField",
  },
  modal: {
    hint: "batchFilterPlatformHint",
    contentTypeField: "batchContentTypeField",
    contentTypeLabel: "batchContentTypeLabel",
    searchScopeField: "batchScopeField",
    distanceField: "batchDistanceField",
    videoDurationField: "batchVideoDurationField",
  },
};
const PLATFORM_SEARCH_FILTER_OPTIONS = {
  xiaohongshu: {
    platformLabel: "小红书",
    contentTypeLabel: "笔记类型",
    sort: [
      {value: "comprehensive", label: "综合(默认)"},
      {value: "latest", label: "最新"},
      {value: "likes", label: "最多点赞"},
      {value: "comments", label: "最多评论"},
      {value: "collects", label: "最多收藏"},
    ],
    publishTime: [
      {value: "all", label: "不限(默认)"},
      {value: "day", label: "一天内"},
      {value: "week", label: "一周内"},
      {value: "halfyear", label: "半年内"},
    ],
    contentType: [
      {value: "all", label: "不限(默认)"},
      {value: "video", label: "视频"},
      {value: "image", label: "图文"},
    ],
    searchScope: [
      {value: "all", label: "不限(默认)"},
      {value: "viewed", label: "已看过"},
      {value: "unviewed", label: "未看过"},
      {value: "followed", label: "已关注"},
    ],
    distance: [
      {value: "all", label: "不限(默认)"},
      {value: "city", label: "同城"},
      {value: "nearby", label: "附近"},
    ],
    videoDuration: [],
  },
  douyin: {
    platformLabel: "抖音",
    contentTypeLabel: "内容形式",
    sort: [
      {value: "comprehensive", label: "综合排序(默认)"},
      {value: "latest", label: "最新发布"},
      {value: "likes", label: "最多点赞"},
    ],
    publishTime: [
      {value: "all", label: "不限(默认)"},
      {value: "day", label: "一天内"},
      {value: "week", label: "一周内"},
      {value: "halfyear", label: "半年内"},
    ],
    contentType: [
      {value: "all", label: "不限(默认)"},
      {value: "video", label: "视频"},
      {value: "image", label: "图文"},
    ],
    searchScope: [
      {value: "all", label: "不限(默认)"},
      {value: "followed", label: "关注的人"},
      {value: "viewed", label: "最近看过"},
      {value: "unviewed", label: "还未看过"},
    ],
    distance: [],
    videoDuration: [
      {value: "all", label: "不限(默认)"},
      {value: "under_1m", label: "1分钟以下"},
      {value: "1_5m", label: "1-5分钟"},
      {value: "over_5m", label: "5分钟以上"},
    ],
  },
};
let batchDraftByPlatform = {};
let activeBatchDraftPlatform = "";
let keywordPlanState = null;
let activeKeywordRunState = null;
let keywordPlanReconcileTimer = null;
let keywordPlanReconcileInFlight = false;
let keywordPlanProgressCountdownTimer = null;
let keywordPlanProgressCountdownToken = 0;

function createEmptyKeywordInsightState() {
  return {
    analysisVersion: 0,
    analysisStatus: "idle",
    analysisErrorMessage: "",
    analysisResult: null,
    selectedCategoryIds: [],
    selectedKeywords: [],
    sampleStatusByCategoryId: {},
    sampleResultsByCategoryId: {},
  };
}

function createEmptyKeywordOpportunityDraft() {
  return {
    keyword: "",
    sourceTabUrl: "",
    listItems: [],
    sampleItems: [],
    representativeSamples: [],
  };
}

function normalizeKeywordOpportunitySampleItems(items = []) {
  return buildKeywordOpportunityInputItems(items);
}

function normalizeRepresentativeSampleItems(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => ({
      noteId: String(item?.noteId || "").trim(),
      url: String(item?.url || "").trim(),
      title: String(item?.title || "").trim(),
      authorName: String(item?.authorName || item?.author || "").trim(),
      publishTime: String(
        item?.publishTime || item?.publishDate || item?.lastEditedAt || "",
      ).trim(),
      likes: Number(item?.likes) || 0,
      comments: Number(item?.comments) || 0,
      collects: Number(item?.collects) || 0,
      noteType: String(item?.noteType || "").trim(),
      cover: String(item?.cover || item?.coverImageUrl || "").trim(),
      content: String(item?.content || "").trim(),
      tags: Array.isArray(item?.tags)
        ? item.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
        : [],
      authorFollowerCount: Number(item?.authorFollowerCount) || 0,
    }))
    .filter((item) => item.url);
}

function normalizeKeywordOpportunityDraft(entry = {}) {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  return {
    keyword: String(safeEntry.keyword || "").trim(),
    sourceTabUrl: String(safeEntry.sourceTabUrl || "").trim(),
    listItems: normalizeKeywordOpportunitySampleItems(safeEntry.listItems),
    sampleItems: normalizeKeywordOpportunitySampleItems(safeEntry.sampleItems),
    representativeSamples: normalizeRepresentativeSampleItems(
      safeEntry.representativeSamples,
    ),
  };
}

function normalizeBatchDraftPlatform(platform) {
  const normalized = String(platform || "")
    .trim()
    .toLowerCase();
  return BATCH_DRAFT_PLATFORMS.has(normalized) ? normalized : "unknown";
}

function createEmptyBatchDraft() {
  return {
    links: "",
    bloggers: "",
    batchKeywordsText: "",
    seedKeyword: "",
    expandedKeywords: [],
    keywordOpportunityDraft: createEmptyKeywordOpportunityDraft(),
    ...createEmptyKeywordInsightState(),
  };
}

function normalizeBatchDraftEntry(entry = {}) {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  const links = String(safeEntry.links || "");
  const bloggers = String(safeEntry.bloggers || "");
  const batchKeywordsText = String(safeEntry.batchKeywordsText || "");
  const seedKeyword = String(safeEntry.seedKeyword || "");
  const expandedKeywords = Array.isArray(safeEntry.expandedKeywords)
    ? safeEntry.expandedKeywords
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  const defaultInsightState = createEmptyKeywordInsightState();
  const rawAnalysisResult =
    safeEntry.analysisResult && typeof safeEntry.analysisResult === "object"
      ? safeEntry.analysisResult
      : null;
  const selectedCategoryIds = Array.isArray(safeEntry.selectedCategoryIds)
    ? safeEntry.selectedCategoryIds
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  const selectedKeywords = Array.isArray(safeEntry.selectedKeywords)
    ? safeEntry.selectedKeywords
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  const sampleStatusByCategoryId =
    safeEntry.sampleStatusByCategoryId &&
    typeof safeEntry.sampleStatusByCategoryId === "object"
      ? Object.fromEntries(
          Object.entries(safeEntry.sampleStatusByCategoryId).map(
            ([key, value]) => [
              String(key || "").trim(),
              String(value || "").trim() || "idle",
            ],
          ),
        )
      : {};
  const sampleResultsByCategoryId =
    safeEntry.sampleResultsByCategoryId &&
    typeof safeEntry.sampleResultsByCategoryId === "object"
      ? safeEntry.sampleResultsByCategoryId
      : {};
  const keywordOpportunityDraft = normalizeKeywordOpportunityDraft(
    safeEntry.keywordOpportunityDraft,
  );

  return {
    links,
    bloggers,
    batchKeywordsText,
    seedKeyword,
    expandedKeywords,
    analysisVersion:
      Number.isInteger(safeEntry.analysisVersion) &&
      safeEntry.analysisVersion >= 0
        ? safeEntry.analysisVersion
        : defaultInsightState.analysisVersion,
    analysisStatus:
      typeof safeEntry.analysisStatus === "string" && safeEntry.analysisStatus
        ? safeEntry.analysisStatus
        : defaultInsightState.analysisStatus,
    analysisErrorMessage: String(safeEntry.analysisErrorMessage || ""),
    analysisResult: rawAnalysisResult,
    selectedCategoryIds,
    selectedKeywords,
    sampleStatusByCategoryId,
    sampleResultsByCategoryId,
    keywordOpportunityDraft,
  };
}

function normalizeBatchDraftStore(rawStore = {}) {
  const safeStore = rawStore && typeof rawStore === "object" ? rawStore : {};
  const normalizedStore = {};
  Object.entries(safeStore).forEach(([platform, entry]) => {
    const normalizedPlatform = normalizeBatchDraftPlatform(platform);
    normalizedStore[normalizedPlatform] = normalizeBatchDraftEntry(entry);
  });
  return normalizedStore;
}

function getCurrentBatchDraftPlatform() {
  const runtime = getCurrentRuntime();
  return normalizeBatchDraftPlatform(getViewPlatform(runtime));
}

function resolveBatchDraftPlatform(platform = "") {
  const raw = String(platform || "").trim();
  if (!raw) {
    return getCurrentBatchDraftPlatform();
  }
  return normalizeBatchDraftPlatform(raw);
}

function getBatchDraftForPlatform(platform = "") {
  const normalizedPlatform = resolveBatchDraftPlatform(platform);
  const current = batchDraftByPlatform[normalizedPlatform];
  if (current) {
    return normalizeBatchDraftEntry(current);
  }
  return createEmptyBatchDraft();
}

function getKeywordInsightState(platform = "") {
  const draft = getBatchDraftForPlatform(platform);
  return {
    analysisVersion: draft.analysisVersion,
    analysisStatus: draft.analysisStatus,
    analysisErrorMessage: draft.analysisErrorMessage,
    analysisResult: draft.analysisResult,
    selectedCategoryIds: [...draft.selectedCategoryIds],
    selectedKeywords: [...(draft.selectedKeywords || [])],
    sampleStatusByCategoryId: {
      ...(draft.sampleStatusByCategoryId || {}),
    },
    sampleResultsByCategoryId: {
      ...(draft.sampleResultsByCategoryId || {}),
    },
  };
}

function updateKeywordInsightState(updates = {}, platform = "") {
  const normalizedPlatform = resolveBatchDraftPlatform(platform);
  const currentDraft = getBatchDraftForPlatform(normalizedPlatform);
  batchDraftByPlatform[normalizedPlatform] = normalizeBatchDraftEntry({
    ...currentDraft,
    ...updates,
  });
  return batchDraftByPlatform[normalizedPlatform];
}

function getKeywordOpportunityDraft(platform = "") {
  const draft = getBatchDraftForPlatform(platform);
  return normalizeKeywordOpportunityDraft(draft.keywordOpportunityDraft);
}

function updateKeywordOpportunityDraft(updates = {}, platform = "") {
  const normalizedPlatform = resolveBatchDraftPlatform(platform);
  const currentDraft = getBatchDraftForPlatform(normalizedPlatform);
  const nextOpportunityDraft = normalizeKeywordOpportunityDraft({
    ...currentDraft.keywordOpportunityDraft,
    ...updates,
  });
  batchDraftByPlatform[normalizedPlatform] = normalizeBatchDraftEntry({
    ...currentDraft,
    keywordOpportunityDraft: nextOpportunityDraft,
  });
  return nextOpportunityDraft;
}

function clearKeywordOpportunityDraft(platform = "") {
  return updateKeywordOpportunityDraft(
    createEmptyKeywordOpportunityDraft(),
    platform,
  );
}

async function persistBatchDraftStore() {
  await chrome.storage.session.set({
    [BATCH_DRAFT_SESSION_KEY]: batchDraftByPlatform,
  });
}

async function loadBatchDraftStore() {
  const session = await chrome.storage.session.get([
    BATCH_DRAFT_SESSION_KEY,
    ...BATCH_DRAFT_LEGACY_KEYS,
  ]);

  batchDraftByPlatform = normalizeBatchDraftStore(
    session[BATCH_DRAFT_SESSION_KEY],
  );

  const legacyExpandedKeywords = Array.isArray(session.expandedKeywords)
    ? session.expandedKeywords
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  const legacySeedKeyword = String(session.expandedSeedKeyword || "").trim();
  const hasLegacyDraft = legacyExpandedKeywords.length > 0 || legacySeedKeyword;

  if (!hasLegacyDraft) {
    return;
  }

  const currentPlatform = getCurrentBatchDraftPlatform();
  const currentDraft = getBatchDraftForPlatform(currentPlatform);
  const shouldMigrate =
    currentDraft.expandedKeywords.length === 0 && !currentDraft.seedKeyword;
  if (!shouldMigrate) {
    return;
  }

  batchDraftByPlatform[currentPlatform] = normalizeBatchDraftEntry({
    ...currentDraft,
    seedKeyword: legacySeedKeyword || currentDraft.seedKeyword,
    expandedKeywords:
      legacyExpandedKeywords.length > 0
        ? legacyExpandedKeywords
        : currentDraft.expandedKeywords,
  });

  await persistBatchDraftStore();
  await chrome.storage.session.remove(BATCH_DRAFT_LEGACY_KEYS);
}

async function persistBatchDraftForPlatform(platform = "") {
  const normalizedPlatform = resolveBatchDraftPlatform(platform);
  const textareaLinks = document.getElementById("textareaBatchLinks");
  const textareaBloggers = document.getElementById("textareaBatchBloggers");
  const textareaBatchKeywords = document.getElementById(
    "textareaBatchKeywords",
  );
  const currentDraft = getBatchDraftForPlatform(normalizedPlatform);
  const runtime = getCurrentRuntime();
  const seedKeyword = getKeywordInsightSeedKeyword({
    runtime,
    preferStored: true,
    platform: normalizedPlatform,
  });

  const nextDraft = normalizeBatchDraftEntry({
    links: textareaLinks?.value || "",
    bloggers: textareaBloggers?.value || "",
    batchKeywordsText: textareaBatchKeywords?.value || "",
    seedKeyword,
    expandedKeywords: [...expandedKeywordsBuffer],
    analysisVersion: currentDraft.analysisVersion,
    analysisStatus: currentDraft.analysisStatus,
    analysisErrorMessage: currentDraft.analysisErrorMessage,
    analysisResult: currentDraft.analysisResult,
    selectedCategoryIds: currentDraft.selectedCategoryIds,
    selectedKeywords: currentDraft.selectedKeywords,
    sampleStatusByCategoryId: currentDraft.sampleStatusByCategoryId,
    sampleResultsByCategoryId: currentDraft.sampleResultsByCategoryId,
    keywordOpportunityDraft: currentDraft.keywordOpportunityDraft,
  });
  const prevDraft = currentDraft;

  if (JSON.stringify(prevDraft) === JSON.stringify(nextDraft)) {
    return;
  }

  batchDraftByPlatform[normalizedPlatform] = nextDraft;
  await persistBatchDraftStore();
}

function applyBatchDraftToInputs(platform = "", {force = false} = {}) {
  const normalizedPlatform = resolveBatchDraftPlatform(platform);
  if (!force && normalizedPlatform === activeBatchDraftPlatform) {
    return;
  }

  const draft = getBatchDraftForPlatform(normalizedPlatform);
  const textareaLinks = document.getElementById("textareaBatchLinks");
  const textareaBloggers = document.getElementById("textareaBatchBloggers");
  const textareaBatchKeywords = document.getElementById(
    "textareaBatchKeywords",
  );

  if (textareaLinks && textareaLinks.value !== draft.links) {
    textareaLinks.value = draft.links;
  }
  if (textareaBloggers && textareaBloggers.value !== draft.bloggers) {
    textareaBloggers.value = draft.bloggers;
  }
  if (
    textareaBatchKeywords &&
    textareaBatchKeywords.value !== draft.batchKeywordsText
  ) {
    textareaBatchKeywords.value = draft.batchKeywordsText;
  }

  expandedKeywordsBuffer = [...draft.expandedKeywords];
  renderExpandedKeywords();
  renderKeywordInsightState();
  updateBatchKeywordInputState();
  updateExpandKeywordsButtonState();
  activeBatchDraftPlatform = normalizedPlatform;
}

function syncBatchDraftForPlatform(platform = "") {
  const nextPlatform = resolveBatchDraftPlatform(platform);
  const previousPlatform = activeBatchDraftPlatform;

  if (previousPlatform && previousPlatform !== nextPlatform) {
    void persistBatchDraftForPlatform(previousPlatform).catch((error) => {
      console.warn(
        "[Sidebar] Persist batch draft before platform switch failed:",
        error,
      );
    });
  }

  applyBatchDraftToInputs(nextPlatform, {
    force: previousPlatform !== nextPlatform,
  });
}

function persistCurrentBatchDraft() {
  const platform = activeBatchDraftPlatform || getCurrentBatchDraftPlatform();
  void persistBatchDraftForPlatform(platform).catch((error) => {
    console.warn("[Sidebar] Persist batch draft failed:", error);
  });
}

function getCurrentSearchKeyword(runtime = getCurrentRuntime()) {
  if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
    return "";
  }
  return extractKeywordFromUrl(runtime?.lastPageUrl || "");
}

function getStoredKeywordInsightSeedKeyword(platform = "") {
  return String(
    getBatchDraftForPlatform(resolveBatchDraftPlatform(platform)).seedKeyword ||
      "",
  ).trim();
}

function getKeywordInsightSeedKeyword({
  runtime = getCurrentRuntime(),
  preferStored = false,
  platform = "",
} = {}) {
  const currentKeyword = getCurrentSearchKeyword(runtime);
  if (currentKeyword) {
    return currentKeyword;
  }
  return preferStored ? getStoredKeywordInsightSeedKeyword(platform) : "";
}

function clearKeywordOpportunityState(
  {preservePanel = false, preserveDraft = false} = {},
) {
  keywordOpportunityInFlight = false;
  keywordOpportunityStartedAt = 0;
  keywordOpportunityResult = null;
  keywordOpportunityErrorMessage = "";
  if (!preserveDraft) {
    clearKeywordOpportunityDraft();
    persistCurrentBatchDraft();
  }
  if (!preservePanel) {
    keywordStrategyPanelVisible = false;
  }
}

function getKeywordOpportunityKeyword() {
  return String(keywordOpportunityResult?.keyword || "").trim();
}

function clearBenchmarkDiscoveryState({preservePanel = false} = {}) {
  keywordBenchmarkInFlight = false;
  keywordBenchmarkStartedAt = 0;
  keywordBenchmarkResult = null;
  keywordBenchmarkErrorMessage = "";
  keywordBenchmarkAnalysisStatus = "idle";
  keywordBenchmarkLoadingTitle = "";
  keywordBenchmarkLoadingMeta = "";
  if (!preservePanel) {
    keywordStrategyPanelVisible = false;
  }
}

function clearBenchmarkDiscoveryResult({showFeedback = true} = {}) {
  const hasAnything =
    !!keywordBenchmarkResult ||
    !!String(keywordBenchmarkErrorMessage || "").trim() ||
    keywordBenchmarkAnalysisStatus === "loading";
  if (!hasAnything) {
    return;
  }

  clearBenchmarkDiscoveryState({preservePanel: true});
  renderKeywordStrategyPanel();
  if (showFeedback) {
    showMessage("已清空找对标账号结果", "success");
  }
}

function clearKeywordOpportunityResult({showFeedback = true} = {}) {
  const hasAnything =
    !!keywordOpportunityResult ||
    !!String(keywordOpportunityErrorMessage || "").trim();
  if (!hasAnything) {
    return;
  }

  clearKeywordOpportunityState({preservePanel: true});
  renderKeywordStrategyPanel();
  if (showFeedback) {
    showMessage("已清空判断赛道机会结果", "success");
  }
}

function maybeResetKeywordOpportunityForCurrentSearch(
  runtime = getCurrentRuntime(),
) {
  const currentKeyword = getCurrentSearchKeyword(runtime);
  const draftKeyword = String(getKeywordOpportunityDraft().keyword || "").trim();
  if (draftKeyword && currentKeyword && draftKeyword !== currentKeyword) {
    clearKeywordOpportunityDraft();
    persistCurrentBatchDraft();
  }
  if (keywordOpportunityResult) {
    renderKeywordStrategyPanel();
  }
}

function syncSeedKeywordFromCurrentSearch(
  keyword = "",
  {autoFillOnly = true} = {},
) {
  const nextKeyword = String(keyword || "").trim();
  if (!nextKeyword) {
    updateExpandKeywordsButtonState();
    return {seedKeyword: "", changed: false};
  }
  const currentDraft = getBatchDraftForPlatform();
  const prevKeyword = String(currentDraft.seedKeyword || "").trim();
  const hasStoredResults =
    currentDraft.expandedKeywords.length > 0 ||
    Boolean(currentDraft.analysisResult) ||
    currentDraft.analysisStatus === "loading" ||
    currentDraft.analysisStatus === "success";
  if (autoFillOnly && prevKeyword && hasStoredResults) {
    updateExpandKeywordsButtonState();
    return {seedKeyword: prevKeyword, changed: false, skipped: true};
  }
  const changed = prevKeyword !== nextKeyword;

  if (changed) {
    expandedKeywordsBuffer = [];
    expandedKeywordsPanelVisible = false;
    invalidateKeywordInsightDraft();
  }

  updateExpandKeywordsButtonState();
  renderKeywordInsightState();
  persistCurrentBatchDraft();

  return {seedKeyword: nextKeyword, changed};
}

function getBatchKeywordsFromTextarea() {
  const textarea = document.getElementById("textareaBatchKeywords");
  return parseKeywordsFromMultilineInput(textarea?.value || "");
}

function normalizeKeywordPlanMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "holidays") {
    return "custom_dates";
  }
  return KEYWORD_PLAN_MODES.has(normalized) ? normalized : "daily";
}

function normalizeKeywordPlanScope(scope = "modal") {
  return scope === "search" ? "search" : "modal";
}

function getKeywordPlanControl(scope, name) {
  const normalizedScope = normalizeKeywordPlanScope(scope);
  const id = KEYWORD_PLAN_CONTROL_IDS[normalizedScope]?.[name];
  return id ? document.getElementById(id) : null;
}

function normalizeSearchFilterPlatform(platform = "") {
  const normalized = String(platform || "").trim().toLowerCase();
  return normalized === "douyin" ? "douyin" : "xiaohongshu";
}

function getSearchFilterConfig(platform = "") {
  return PLATFORM_SEARCH_FILTER_OPTIONS[normalizeSearchFilterPlatform(platform)] ||
    PLATFORM_SEARCH_FILTER_OPTIONS.xiaohongshu;
}

function isDefaultSearchFilterValue(field, value) {
  const meta = SEARCH_FILTER_FIELD_META[field] || {};
  const normalized = String(value || "").trim();
  return (
    !normalized ||
    normalized === String(meta.defaultValue || "") ||
    normalized === String(meta.storageDefault || "")
  );
}

function normalizeSearchFilterValueForStorage(field, value) {
  return isDefaultSearchFilterValue(field, value)
    ? ""
    : String(value || "").trim().toLowerCase();
}

function renderSearchFilterSelectOptions(select, options = [], preferredValue = "") {
  if (!select) {
    return "";
  }
  const safeOptions = Array.isArray(options) ? options : [];
  const fallbackValue = safeOptions[0]?.value || "";
  const preferred = String(preferredValue || "").trim();
  const hasPreferred = safeOptions.some((option) => option.value === preferred);
  const nextValue = hasPreferred ? preferred : fallbackValue;

  select.textContent = "";
  safeOptions.forEach((option) => {
    const optionEl = document.createElement("option");
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    select.appendChild(optionEl);
  });
  select.value = nextValue;
  return nextValue;
}

function getSearchFilterSelectValue(scope, field) {
  const control = getKeywordPlanControl(scope, field);
  const meta = SEARCH_FILTER_FIELD_META[field] || {};
  return String(control?.value || meta.defaultValue || "").trim();
}

function collectSearchFiltersFromControls(scope = "modal") {
  const normalizedScope = normalizeKeywordPlanScope(scope);
  return Object.keys(SEARCH_FILTER_FIELD_META).reduce((filters, field) => {
    const value = normalizeSearchFilterValueForStorage(
      field,
      getSearchFilterSelectValue(normalizedScope, field),
    );
    if (value) {
      filters[field] = value;
    }
    return filters;
  }, {});
}

function populateSearchFilterControlsFromFilters(
  scope = "modal",
  filters = {},
  platform = "",
) {
  syncSearchFilterControlsForPlatform(platform, {
    scope,
    values: filters,
  });
}

function syncSearchFilterControlsForPlatform(
  platform = "",
  {scope = null, values = null} = {},
) {
  const runtime = getCurrentRuntime();
  const normalizedPlatform = normalizeSearchFilterPlatform(
    platform || getViewPlatform(runtime),
  );
  const config = getSearchFilterConfig(normalizedPlatform);
  const scopes = typeof scope === "string" ? [normalizeKeywordPlanScope(scope)] : ["search", "modal"];

  scopes.forEach((itemScope) => {
    const currentValues = values || {};
    Object.keys(SEARCH_FILTER_FIELD_META).forEach((field) => {
      const options = config[field] || [];
      const control = getKeywordPlanControl(itemScope, field);
      const preferred =
        currentValues[field] ||
        control?.value ||
        SEARCH_FILTER_FIELD_META[field]?.defaultValue ||
        "";
      renderSearchFilterSelectOptions(control, options, preferred);
    });

    const meta = SEARCH_FILTER_SCOPE_META[itemScope] || {};
    const hintEl = meta.hint ? document.getElementById(meta.hint) : null;
    if (hintEl) {
      hintEl.textContent = `${config.platformLabel}筛选项 · 采集前自动切换`;
    }
    const contentTypeLabel = meta.contentTypeLabel
      ? document.getElementById(meta.contentTypeLabel)
      : null;
    if (contentTypeLabel) {
      contentTypeLabel.textContent = config.contentTypeLabel || "内容类型";
    }

    [
      ["contentTypeField", config.contentType],
      ["searchScopeField", config.searchScope],
      ["distanceField", config.distance],
      ["videoDurationField", config.videoDuration],
    ].forEach(([metaKey, options]) => {
      const fieldEl = meta[metaKey] ? document.getElementById(meta[metaKey]) : null;
      if (fieldEl) {
        fieldEl.hidden = !Array.isArray(options) || options.length === 0;
      }
    });
  });
}

function forEachKeywordPlanScope(callback) {
  ["search", "modal"].forEach((scope) => callback(scope));
}

function normalizeCalendarDate(value) {
  const match = String(value || "").trim().match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
  );
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return "";
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (day > daysInMonth) return "";
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDateListText(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(/[\s,，;；]+/g)
        .map(normalizeCalendarDate)
        .filter(Boolean),
    ),
  ).join("\n");
}

function getDateListFromText(value) {
  const normalized = normalizeDateListText(value);
  return normalized ? normalized.split("\n").filter(Boolean) : [];
}

function renderSearchKeywordPlanDateChips() {
  const chipsEl = document.getElementById("searchKeywordPlanDateChips");
  const textarea = getKeywordPlanControl("search", "customDates");
  if (!chipsEl || !textarea) {
    return;
  }
  const dates = getDateListFromText(textarea.value);
  chipsEl.textContent = "";
  if (dates.length === 0) {
    const empty = document.createElement("span");
    empty.className = "keyword-plan-date-empty";
    empty.textContent = "暂无指定日期";
    chipsEl.appendChild(empty);
    return;
  }
  dates.forEach((date) => {
    const chip = document.createElement("span");
    chip.className = "keyword-plan-date-chip";
    chip.textContent = date;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.dataset.keywordPlanDateRemove = date;
    removeButton.setAttribute("aria-label", `移除 ${date}`);
    removeButton.textContent = "×";
    chip.appendChild(removeButton);
    chipsEl.appendChild(chip);
  });
}

function setSearchKeywordPlanDateList(dates = []) {
  const textarea = getKeywordPlanControl("search", "customDates");
  if (!textarea) {
    return;
  }
  textarea.value = normalizeDateListText(dates.join("\n"));
  renderSearchKeywordPlanDateChips();
  renderKeywordPlanStatus(keywordPlanState, "search");
}

function addSearchKeywordPlanDateFromPicker() {
  const input = document.getElementById("inputSearchKeywordPlanDatePicker");
  const value = String(input?.value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    showMessage("请选择要加入无人值守计划的运行日期", "warning");
    return;
  }
  const textarea = getKeywordPlanControl("search", "customDates");
  const dates = getDateListFromText(textarea?.value || "");
  setSearchKeywordPlanDateList([...dates, value]);
  if (input) {
    input.value = "";
  }
}

function handleSearchKeywordPlanDateChipClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const button = target.closest("[data-keyword-plan-date-remove]");
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const removeDate = String(button.dataset.keywordPlanDateRemove || "").trim();
  const textarea = getKeywordPlanControl("search", "customDates");
  const dates = getDateListFromText(textarea?.value || "").filter(
    (date) => date !== removeDate,
  );
  setSearchKeywordPlanDateList(dates);
}

function parseSearchManualScheduledStart(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const timeOnlyMatch = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnlyMatch) {
    const hours = Number(timeOnlyMatch[1]);
    const minutes = Number(timeOnlyMatch[2]);
    const seconds = Number(timeOnlyMatch[3] || 0);
    if (
      hours >= 0 &&
      hours <= 23 &&
      minutes >= 0 &&
      minutes <= 59 &&
      seconds >= 0 &&
      seconds <= 59
    ) {
      const target = new Date();
      target.setHours(hours, minutes, seconds, 0);
      return {
        targetMs: target.getTime(),
        label: `今天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
      };
    }
  }

  const targetMs = new Date(raw).getTime();
  if (!Number.isFinite(targetMs)) {
    return {targetMs: NaN, label: raw};
  }
  return {
    targetMs,
    label: new Date(targetMs).toLocaleString("zh-CN"),
  };
}

function setSearchExecutionMode(mode = "manual") {
  const normalizedMode = mode === "plan" ? "plan" : "manual";
  document
    .querySelectorAll("[data-search-execution-mode]")
    .forEach((tab) => {
      const isActive = tab.getAttribute("data-search-execution-mode") === normalizedMode;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  const manualPane = document.getElementById("searchManualExecutionPane");
  const planPane = document.getElementById("searchPlanExecutionPane");
  const manualActionRow = document.getElementById("searchManualActionRow");
  if (manualPane) {
    manualPane.hidden = normalizedMode !== "manual";
  }
  if (planPane) {
    planPane.hidden = normalizedMode !== "plan";
  }
  if (manualActionRow) {
    manualActionRow.hidden = normalizedMode !== "manual";
  }
}

function readNonNegativeNumberInput(inputId, fallback = 0) {
  const raw = document.getElementById(inputId)?.value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readPositiveNumberInput(inputId, fallback = 1) {
  const raw = document.getElementById(inputId)?.value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function collectKeywordPlanFromInputs(scope = "modal") {
  const normalizedScope = normalizeKeywordPlanScope(scope);
  const runtime = getCurrentRuntime();
  const selectedPlatform = getViewPlatform(runtime);
  const roundGapMin = readNonNegativeNumberInput(
    KEYWORD_PLAN_CONTROL_IDS[normalizedScope].roundGap,
    10,
  );
  const maxRounds = readPositiveNumberInput(
    KEYWORD_PLAN_CONTROL_IDS[normalizedScope].maxRounds,
    1,
  );
  const keywords =
    normalizedScope === "search"
      ? dedupeKeywords(getSearchBatchKeywordsFromTextarea())
      : dedupeKeywords(getBatchKeywordsFromTextarea());
  return {
    enabled: Boolean(
      getKeywordPlanControl(normalizedScope, "enabled")?.checked,
    ),
    platform:
      selectedPlatform && selectedPlatform !== "unknown"
        ? selectedPlatform
        : "xiaohongshu",
    mode: normalizeKeywordPlanMode(
      getKeywordPlanControl(normalizedScope, "mode")?.value,
    ),
    startTime:
      getKeywordPlanControl(normalizedScope, "startTime")?.value || "09:00",
    randomOffsetMin: readNonNegativeNumberInput(
      KEYWORD_PLAN_CONTROL_IDS[normalizedScope].jitter,
      20,
    ),
    keywords: keywords.slice(0, MAX_BATCH_KEYWORDS),
    searchFilters: collectSearchFiltersFromControls(normalizedScope),
    autoLoop: maxRounds > 1,
    roundGapMin,
    maxRounds,
    holidayDates: "",
    customDates: normalizeDateListText(
      getKeywordPlanControl(normalizedScope, "customDates")?.value,
    ),
  };
}

function syncKeywordPlanDateFields(scope = null) {
  const scopes = typeof scope === "string" ? [scope] : ["search", "modal"];
  scopes.forEach((itemScope) => {
    const normalizedScope = normalizeKeywordPlanScope(itemScope);
    const mode = normalizeKeywordPlanMode(
      getKeywordPlanControl(normalizedScope, "mode")?.value,
    );
    const customGroup = getKeywordPlanControl(normalizedScope, "customGroup");
    if (customGroup) {
      customGroup.hidden = mode !== "custom_dates";
    }
    if (normalizedScope === "search") {
      renderSearchKeywordPlanDateChips();
    }
  });
}

function formatKeywordPlanRunTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isExplicitUserUnattendedCancellationMessage(message = "") {
  return /用户手动|手动中止/.test(String(message || "").trim());
}

function renderKeywordPlanStatus(plan = keywordPlanState, scope = null) {
  const scopes = typeof scope === "string" ? [scope] : ["search", "modal"];
  scopes.forEach((itemScope) => {
    const normalizedScope = normalizeKeywordPlanScope(itemScope);
    const statusEl = getKeywordPlanControl(normalizedScope, "status");
    if (!statusEl) {
      return;
    }
    const checked = Boolean(
      getKeywordPlanControl(normalizedScope, "enabled")?.checked,
    );
    if (checked !== Boolean(plan?.enabled)) {
      statusEl.textContent = checked ? "保存后启用计划" : "保存后关闭计划";
      return;
    }
    if (!plan?.enabled) {
      statusEl.textContent = "计划未启用";
      return;
    }
    const keywordCount = Array.isArray(plan.keywords) ? plan.keywords.length : 0;
    const modeLabel =
      KEYWORD_PLAN_MODE_LABELS[normalizeKeywordPlanMode(plan.mode)] || "每天";
    const lastRunStatus = String(plan.lastRunStatus || "");
    const isRunningPlan = ["started", "running", "recovering"].includes(
      lastRunStatus,
    );
    const nextRunText = isRunningPlan
      ? ""
      : formatKeywordPlanRunTime(plan.nextRunAt);
    const nextPart = isRunningPlan
      ? "当前运行中"
      : nextRunText
        ? `下次 ${nextRunText}`
        : "暂无可运行日期";
    const ambiguousCanceled =
      lastRunStatus === "canceled" &&
      !isExplicitUserUnattendedCancellationMessage(plan.lastRunMessage);
    const lastRunStatusLabel = ambiguousCanceled
      ? "异常中断"
      : KEYWORD_PLAN_STATUS_LABELS[lastRunStatus] || lastRunStatus;
    const lastRunMessage = ambiguousCanceled
      ? "运行状态异常中断（非用户操作）"
      : String(plan.lastRunMessage || "");
    const lastPart = plan.lastRunStatus
      ? `；${isRunningPlan ? "当前" : "上次"} ${lastRunStatusLabel}${lastRunMessage ? `：${lastRunMessage}` : ""}`
      : "";
    statusEl.textContent = `已启用 · ${modeLabel} · ${keywordCount} 个关键词 · ${nextPart}${lastPart}`;
  });
  syncKeywordPlanProgressPanel(buildKeywordRunDisplayPlan(plan));
  // 无人值守的暗色任务页不能依赖 native Debug 已经 attach。计划一进入
  // started/running，就先用计划进度渲染启动态；后台接管成功后 runtime 中
  // 的真实 captureDebugSession 会无缝替换该启动态。
  renderCaptureDebugSession(getCurrentRuntime() || {});
}

function isKeywordPlanRunning(plan = {}) {
  const status = String(plan?.lastRunStatus || "").trim();
  return ["pending", "claimed", "started", "running", "recovering"].includes(
    status,
  );
}

function getKeywordExecutionCopy(source = {}) {
  const executionMode =
    String(source?.executionMode || "").trim() === "one_time"
      ? "one_time"
      : "unattended_plan";
  const oneTime = executionMode === "one_time";
  return {
    executionMode,
    taskLabel: oneTime ? "一次性采集任务" : "无人值守计划",
    captureLabel: oneTime ? "一次性采集" : "无人值守采集",
  };
}

function normalizeUnattendedSearchPasses(plan = {}) {
  const allowed = new Set(["all", "image", "video"]);
  const fallback = allowed.has(String(plan?.searchFilters?.contentType || ""))
    ? String(plan.searchFilters.contentType)
    : "all";
  const requested = [];
  const seen = new Set();
  for (const rawValue of Array.isArray(plan?.searchPasses)
    ? plan.searchPasses
    : []) {
    const value = String(rawValue || "").trim().toLowerCase();
    if (!allowed.has(value) || seen.has(value)) continue;
    seen.add(value);
    requested.push(value);
    if (requested.length >= 3) break;
  }
  if (requested.length === 0) return [fallback];
  if (requested.length === 1) return requested;
  if (requested.includes("all")) {
    const supplement = requested.find(
      (value) => value === "image" || value === "video",
    );
    return supplement ? ["all", supplement] : ["all"];
  }
  return [requested[0]];
}

function unattendedSearchPassLabel(value = "") {
  return {
    all: "综合巡检",
    image: "图文巡检",
    video: "视频巡检",
  }[String(value || "").trim()] || "巡检";
}

function buildKeywordRunDisplayPlan(
  plan = keywordPlanState,
  request = activeKeywordRunState,
) {
  if (!request || typeof request !== "object") {
    return plan;
  }
  const requestId = String(request.id || "").trim();
  const status = String(request.status || "").trim().toLowerCase();
  const shouldDisplayRequest = Boolean(
    requestId &&
      (isKeywordPlanRunning({lastRunStatus: status}) ||
        KEYWORD_PLAN_TERMINAL_STATUSES.has(status)),
  );
  if (!shouldDisplayRequest) {
    return plan;
  }
  const snapshot =
    request.planSnapshot && typeof request.planSnapshot === "object"
      ? request.planSnapshot
      : {};
  const progress =
    request.progress && typeof request.progress === "object"
      ? request.progress
      : {};
  const executionMode =
    String(request.executionMode || "").trim() === "one_time"
      ? "one_time"
      : "unattended_plan";
  return {
    ...snapshot,
    enabled: true,
    lastRunStatus: status,
    lastRunMessage:
      String(request.message || progress.message || "").trim() ||
      (status === "pending" || status === "claimed"
        ? "任务已领取，正在准备采集页面"
        : "当前采集任务运行中"),
    lastRunAt: String(
      request.finishedAt ||
        request.updatedAt ||
        request.startedAt ||
        request.claimedAt ||
        request.createdAt ||
        "",
    ),
    lastRunRequestId: requestId,
    lastRunProgress: {
      ...progress,
      unattendedRequestId: requestId,
      unattendedAttemptId: String(request.attemptId || "").trim(),
      runnerTabId: progress.runnerTabId ?? request.runnerTabId ?? null,
      updatedAt: String(
        progress.updatedAt || request.updatedAt || request.createdAt || "",
      ),
    },
    executionMode,
    cloudAssigned: request.cloudAssigned === true,
  };
}

function clearKeywordPlanProgressCountdown() {
  keywordPlanProgressCountdownToken += 1;
  if (keywordPlanProgressCountdownTimer) {
    clearInterval(keywordPlanProgressCountdownTimer);
    keywordPlanProgressCountdownTimer = null;
  }
}

function buildKeywordPlanProgressText(plan = {}) {
  const progress =
    plan?.lastRunProgress && typeof plan.lastRunProgress === "object"
      ? plan.lastRunProgress
      : {};
  const executionCopy = getKeywordExecutionCopy(plan);
  const message =
    String(progress.message || plan?.lastRunMessage || "").trim() ||
    `${executionCopy.taskLabel}运行中`;
  const round = Number(progress.round);
  const maxRounds = Number(plan?.maxRounds);
  const keyword = String(progress.keyword || "").trim();
  const keywords = Array.isArray(plan?.keywords)
    ? plan.keywords.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const explicitKeywordCurrent = Number(progress.keywordCurrent);
  const explicitKeywordTotal = Number(progress.keywordTotal);
  const keywordIndex = keyword ? keywords.indexOf(keyword) : -1;
  const keywordTotal =
    Number.isFinite(explicitKeywordTotal) && explicitKeywordTotal > 0
      ? Math.floor(explicitKeywordTotal)
      : keywords.length;
  const keywordCurrent =
    Number.isFinite(explicitKeywordCurrent) && explicitKeywordCurrent > 0
      ? Math.floor(explicitKeywordCurrent)
      : keywordIndex >= 0
        ? keywordIndex + 1
        : 0;
  const itemCurrent = Number(progress.itemCurrent);
  const itemTotal = Number(progress.itemTotal);
  const parts = [executionCopy.captureLabel];
  const shouldShowRound =
    Number.isFinite(round) &&
    round > 0 &&
    ((Number.isFinite(maxRounds) && maxRounds > 1) || round > 1);

  if (shouldShowRound) {
    parts.push(`第 ${round} 轮`);
  }
  if (keywordTotal > 0) {
    parts.push(
      `关键词 ${Math.min(Math.max(0, keywordCurrent), keywordTotal)}/${keywordTotal}`,
    );
  }
  if (keyword) {
    parts.push(`「${keyword}」`);
  }
  if (Number.isFinite(itemTotal) && itemTotal > 0) {
    const normalizedItemCurrent =
      Number.isFinite(itemCurrent) && itemCurrent > 0
        ? Math.min(Math.floor(itemCurrent), Math.floor(itemTotal))
        : 0;
    parts.push(
      `当前词内作品 ${normalizedItemCurrent}/${Math.floor(itemTotal)}`,
    );
  }

  return `${parts.join(" · ")}：${message}`;
}

function renderKeywordPlanProgressText(progressText, plan = {}) {
  const text = buildKeywordPlanProgressText(plan);
  const progress =
    plan?.lastRunProgress && typeof plan.lastRunProgress === "object"
      ? plan.lastRunProgress
      : {};
  const remainingMs = Number(progress.remainingMs);
  const canCountdown =
    Number.isFinite(remainingMs) &&
    remainingMs > 0 &&
    /秒后/.test(text);

  clearKeywordPlanProgressCountdown();
  if (!canCountdown) {
    progressText.textContent = text;
    return;
  }

  const token = keywordPlanProgressCountdownToken;
  // 以「上报时刻」为锚(updatedAt 是测得 remainingMs 的时刻),得到绝对截止时刻;
  // 这样即便 5 秒一次的 reconcile / storage 用陈旧的相对 remainingMs 反复重调,
  // deadline 也恒指向同一真实时刻——底部条平滑走到 0、不再循环(词2也不再"假卡")。
  // updatedAt 缺失/非法时回退旧行为,绝不更差。
  const reportedAt = Date.parse(progress.updatedAt);
  const deadline =
    (Number.isFinite(reportedAt) ? reportedAt : Date.now()) + remainingMs;
  const render = () => {
    if (token !== keywordPlanProgressCountdownToken) {
      return;
    }
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (seconds > 0) {
      progressText.textContent = text.replace(/\d+\s*秒后/g, `${seconds} 秒后`);
      return;
    }
    progressText.textContent = text.replace(
      /\d+\s*秒后再搜下一个关键词\(防风控·随机间隔\)[…\.]*/g,
      "正在切换到下一个关键词...",
    );
    clearKeywordPlanProgressCountdown();
  };
  render();
  keywordPlanProgressCountdownTimer = setInterval(render, 1000);
}

function hasVisibleLocalCaptureProgress() {
  return (
    batchKeywordCaptureInFlight ||
    batchUrlCaptureInFlight ||
    detailBatchCaptureInFlight ||
    monitorRunInFlight ||
    keywordBenchmarkInFlight ||
    keywordOpportunityInFlight ||
    keywordExpandInFlight ||
    [
      "network_paused",
      "network_resumed",
      "system_resumed",
      "capture_recovering",
      "capture_canceling",
    ].includes(String(activeRecoveryProgress?.phase || ""))
  );
}

function hideKeywordPlanProgressPanelIfOwned(plan = keywordPlanState) {
  const progressContainer = document.getElementById("progressContainer");
  if (!progressContainer) {
    return;
  }
  const status = String(plan?.lastRunStatus || "").trim().toLowerCase();
  const terminal = KEYWORD_PLAN_TERMINAL_STATUSES.has(status);
  const progressSource = String(
    progressContainer.dataset.progressSource || "",
  );
  const unattendedState = String(
    progressContainer.dataset.unattendedProgressState || "",
  );
  const ownedByKeywordPlan =
    progressSource === "keyword-plan" ||
    unattendedState === "running" ||
    unattendedState === "terminal" ||
    (terminal && Boolean(activeUnattendedRunRequestId));
  if (!ownedByKeywordPlan) {
    return;
  }
  clearKeywordPlanProgressCountdown();
  progressContainer.style.display = "none";
  delete progressContainer.dataset.progressSource;
  if (terminal) {
    progressContainer.dataset.unattendedProgressState = "terminal";
  } else {
    delete progressContainer.dataset.unattendedProgressState;
  }
  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.textContent = "中止任务";
    btnCancel.hidden = true;
    btnCancel.disabled = true;
    btnCancel.style.display = "none";
  }
}

function syncKeywordPlanProgressPanel(plan = keywordPlanState) {
  // runner tab(无人值守聚焦页,URL 带 unattendedRun=xxx):它自身就是批量采集执行页,
  // 「词间随机延迟」阶段全局底部条(#progressContainer)是空闲的,需要用它显示倒计时,
  // 故不再对 runner tab 整体提前 return。观察侧栏(无该 query)行为完全不变。
  const isUnattendedRunnerTab = Boolean(getUnattendedRunRequestIdFromUrl());
  if (!plan?.enabled || !isKeywordPlanRunning(plan)) {
    hideKeywordPlanProgressPanelIfOwned(plan);
    return;
  }
  // 观察侧栏:本地有可见采集进度时让位给本地进度条;
  // runner tab 的本地采集就是这次计划本身,不让位(否则又整轮不显示)。
  if (
    (!isUnattendedRunnerTab && hasVisibleLocalCaptureProgress()) ||
    isUnsupportedPlatformCoverVisible()
  ) {
    return;
  }

  const progressContainer = document.getElementById("progressContainer");
  const progressText = document.getElementById("progressText");
  if (!progressContainer || !progressText) {
    return;
  }
  resetCaptureRecoveryUI({hidePanel: false, clearState: true});
  progressContainer.dataset.progressSource = "keyword-plan";
  progressContainer.dataset.unattendedProgressState = "running";
  progressContainer.style.display = "block";
  renderKeywordPlanProgressText(progressText, plan);
  const progressBar = document.getElementById("progressBar");
  if (progressBar) {
    progressBar.className = "status-bar is-info";
  }
  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.textContent = "中止任务";
    btnCancel.hidden = false;
    btnCancel.disabled = false;
    btnCancel.style.display = "inline-block";
  }
}

async function cancelUnattendedKeywordPlanFromSidebar(requestId = "") {
  const displayPlan = buildKeywordRunDisplayPlan(keywordPlanState);
  const progress =
    displayPlan?.lastRunProgress &&
    typeof displayPlan.lastRunProgress === "object"
      ? displayPlan.lastRunProgress
      : {};
  const exactRequestId = String(
    requestId ||
      progress.unattendedRequestId ||
      displayPlan?.lastRunRequestId ||
      activeKeywordRunState?.id ||
      "",
  ).trim();
  const runnerTabId = Number(progress.runnerTabId);
  const progressText = document.getElementById("progressText");
  const btnCancel = document.getElementById("btnCancel");
  if (progressText) {
    progressText.textContent = "正在中止当前采集任务...";
  }
  if (btnCancel) {
    btnCancel.textContent = "停止中...";
    btnCancel.disabled = true;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:cancel-unattended-keyword-run",
      requestId: exactRequestId,
      message: "用户手动中止当前采集任务",
      tabId: Number.isFinite(runnerTabId) && runnerTabId > 0 ? runnerTabId : null,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "中止无人值守任务失败");
    }
    activeCaptureTaskCancellationReason = "unattended_cancel_requested";
    activeKeywordRunState = response?.data?.request || activeKeywordRunState;
    await Promise.all([
      loadKeywordPlanUI({preserveInputs: true}),
      loadActiveKeywordRunState(),
    ]);
    showMessage("正在中止当前采集任务...", "warning");
  } catch (error) {
    console.warn("[Sidebar] Cancel active keyword run failed:", error);
    showMessage("中止当前采集任务失败: " + error.message, "error");
  } finally {
    if (btnCancel) {
      btnCancel.disabled = false;
      btnCancel.textContent = "中止任务";
    }
  }
}

function populateKeywordPlanUI(plan = {}) {
  keywordPlanState = plan || null;
  forEachKeywordPlanScope((scope) => {
    const enabledInput = getKeywordPlanControl(scope, "enabled");
    if (enabledInput) {
      enabledInput.checked = Boolean(plan?.enabled);
    }
    const modeInput = getKeywordPlanControl(scope, "mode");
    if (modeInput) {
      modeInput.value = normalizeKeywordPlanMode(plan?.mode);
    }
    const startInput = getKeywordPlanControl(scope, "startTime");
    if (startInput) {
      startInput.value = String(plan?.startTime || "09:00");
    }
    const jitterInput = getKeywordPlanControl(scope, "jitter");
    if (jitterInput) {
      jitterInput.value = String(Number(plan?.randomOffsetMin) || 0);
    }
    const autoLoopInput = getKeywordPlanControl(scope, "autoLoop");
    if (autoLoopInput) {
      autoLoopInput.checked = true;
    }
    const roundGapInput = getKeywordPlanControl(scope, "roundGap");
    if (roundGapInput) {
      roundGapInput.value = String(Math.max(0, Number(plan?.roundGapMin) || 10));
    }
    const maxRoundsInput = getKeywordPlanControl(scope, "maxRounds");
    if (maxRoundsInput) {
      maxRoundsInput.value = String(Math.max(1, Number(plan?.maxRounds) || 1));
    }
    const customTextarea = getKeywordPlanControl(scope, "customDates");
    if (customTextarea) {
      customTextarea.value = normalizeDateListText(
        plan?.customDates || plan?.holidayDates,
      );
    }
  });

  const keywords = Array.isArray(plan?.keywords) ? plan.keywords : [];
  const planPlatform =
    plan?.platform ||
    getViewPlatform(getCurrentRuntime()) ||
    "xiaohongshu";
  forEachKeywordPlanScope((scope) => {
    const textarea = getKeywordPlanControl(scope, "keywords");
    if (textarea && !textarea.value.trim() && keywords.length > 0) {
      textarea.value = keywords.join("\n");
    }
    populateSearchFilterControlsFromFilters(
      scope,
      plan?.searchFilters || {},
      planPlatform,
    );
  });
  updateBatchKeywordInputState();

  syncKeywordPlanDateFields();
  renderKeywordPlanStatus(plan);
}

async function loadKeywordPlanUI({preserveInputs = false} = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:get-unattended-keyword-plan",
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "读取计划失败");
    }
    const plan = response.data || {};
    if (preserveInputs) {
      keywordPlanState = plan;
      renderKeywordPlanStatus(plan);
    } else {
      populateKeywordPlanUI(plan);
    }
    return plan;
  } catch (error) {
    console.warn("[Sidebar] Load unattended keyword plan failed:", error);
    renderKeywordPlanStatus(null);
    return null;
  }
}

function renderActiveKeywordRunState(request) {
  activeKeywordRunState =
    request && typeof request === "object" ? request : null;
  const displayPlan = buildKeywordRunDisplayPlan(keywordPlanState);
  syncKeywordPlanProgressPanel(displayPlan);
  renderCaptureDebugSession(getCurrentRuntime() || {});
}

async function loadActiveKeywordRunState() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:get-unattended-keyword-run-state",
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "读取当前采集任务失败");
    }
    renderActiveKeywordRunState(response.data || null);
    return activeKeywordRunState;
  } catch (error) {
    console.warn("[Sidebar] Load active keyword run failed:", error);
    return activeKeywordRunState;
  }
}

function shouldRefreshDataPoolForKeywordPlan(plan = {}) {
  const status = String(plan?.lastRunStatus || "").trim();
  return (
    status === "started" ||
    status === "running" ||
    status === "recovering" ||
    status === "completed" ||
    status === "completed_with_failures" ||
    status === "needs_action" ||
    status === "failed" ||
    status === "canceled"
  );
}

async function reconcileKeywordPlanFromSidebar() {
  if (
    keywordPlanReconcileInFlight ||
    getUnattendedRunRequestIdFromUrl() ||
    getTargetedPostRunRequestIdFromUrl()
  ) {
    return;
  }
  keywordPlanReconcileInFlight = true;
  try {
    const [plan] = await Promise.all([
      loadKeywordPlanUI({preserveInputs: true}),
      loadActiveKeywordRunState(),
    ]);
    if (shouldRefreshDataPoolForKeywordPlan(plan)) {
      await refreshDataPoolThrottled();
    }
    await maybeClaimAndRunUnattendedKeywordPlan({allowPending: true});
  } finally {
    keywordPlanReconcileInFlight = false;
  }
}

function startKeywordPlanReconcileTimer() {
  stopKeywordPlanReconcileTimer();
  if (
    getUnattendedRunRequestIdFromUrl() ||
    getTargetedPostRunRequestIdFromUrl()
  ) {
    return;
  }
  keywordPlanReconcileTimer = setInterval(() => {
    reconcileKeywordPlanFromSidebar().catch((error) => {
      console.warn("[Sidebar] Reconcile unattended keyword plan failed:", error);
    });
  }, KEYWORD_PLAN_RECONCILE_INTERVAL_MS);
}

function stopKeywordPlanReconcileTimer() {
  if (keywordPlanReconcileTimer) {
    clearInterval(keywordPlanReconcileTimer);
    keywordPlanReconcileTimer = null;
  }
}

function setupKeywordPlanStorageListener() {
  if (!chrome?.storage?.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes?.[KEYWORD_PLAN_STORAGE_KEY]) {
      const plan = changes[KEYWORD_PLAN_STORAGE_KEY].newValue || null;
      keywordPlanState = plan;
      renderKeywordPlanStatus(plan);
      if (shouldRefreshDataPoolForKeywordPlan(plan)) {
        refreshDataPoolThrottled().catch((error) => {
          console.warn(
            "[Sidebar] Failed to refresh pool during keyword plan update:",
            error,
          );
        });
      }
    }
    if (changes?.[KEYWORD_RUN_REQUEST_STORAGE_KEY]) {
      const request =
        changes[KEYWORD_RUN_REQUEST_STORAGE_KEY].newValue || null;
      renderActiveKeywordRunState(request);
      handleUnattendedRunRequestStorageChange(request);
    }
    if (changes?.[TARGETED_POST_RUN_REQUEST_STORAGE_KEY]) {
      const request =
        changes[TARGETED_POST_RUN_REQUEST_STORAGE_KEY].newValue || null;
      handleTargetedPostRunRequestStorageChange(request);
    }
  });
}

function handleUnattendedRunRequestStorageChange(request) {
  const requestId = getUnattendedRunRequestIdFromUrl();
  if (!requestId || !request || request.id !== requestId) {
    return;
  }
  const requestAttemptId = String(request?.attemptId || "").trim();
  if (
    activeUnattendedRunRequestId &&
    (String(request.id || "").trim() !== activeUnattendedRunRequestId ||
      !requestAttemptId ||
      requestAttemptId !== activeUnattendedRunAttemptId)
  ) {
    return;
  }
  if (String(request.status || "") !== "canceled") {
    return;
  }

  pendingUnattendedCancellationRequestId = String(request.id || "").trim();
  pendingUnattendedCancellationAttemptId = requestAttemptId;
  activeCaptureTaskCancellationReason =
    isExplicitUserUnattendedCancellationMessage(request.message)
      ? "unattended_cancel_requested"
      : "unattended_request_canceled_without_user_action";
  setCancelFlag(true);
  batchKeywordCancelRequested = true;
  detailBatchCancelRequested = true;
  searchCaptureCancelRequested = true;
  // background 在状态切换前已捕获旧 lock holder 并精确转发取消。这里仅停止
  // 本地编排；若再发送无 captureRequestId 的全页取消，迟到消息可能误伤新 attempt。
}

async function handleSaveKeywordPlan(scope = "modal") {
  try {
    const plan = collectKeywordPlanFromInputs(scope);
    if (plan.enabled && plan.keywords.length === 0) {
      showMessage("启用无人值守计划前，请先填写至少一个关键词", "warning");
      return;
    }
    if (plan.enabled && plan.mode === "custom_dates" && !plan.customDates) {
      showMessage("指定日期清单需要填写至少一个运行日期", "warning");
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:save-unattended-keyword-plan",
      plan,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "保存计划失败");
    }
    populateKeywordPlanUI(response.data || plan);
    showMessage(plan.enabled ? "无人值守计划已保存" : "无人值守计划已关闭", "success");
  } catch (error) {
    console.error("[Sidebar] Save unattended keyword plan failed:", error);
    showMessage("保存无人值守计划失败: " + error.message, "error");
  }
}

function updateBatchKeywordInputState() {
  const hintEl = document.getElementById("batchKeywordLimitHint");
  const btn = document.getElementById("btnRunBatchKeywords");
  const keywords = getBatchKeywordsFromTextarea();
  const overLimit = keywords.length > MAX_BATCH_KEYWORDS;

  if (hintEl) {
    hintEl.textContent = `${keywords.length} / ${MAX_BATCH_KEYWORDS}`;
    hintEl.classList.toggle("is-over", overLimit);
  }

  if (btn && !batchKeywordCaptureInFlight) {
    const shouldDisable = keywords.length === 0 || overLimit;
    btn.disabled = shouldDisable;
    btn.classList.toggle("is-disabled", shouldDisable);
  }
}

function openBatchModal(mode = "links") {
  const overlay = document.getElementById("batchModalOverlay");
  if (!overlay) return;

  syncBatchDraftForPlatform(getCurrentBatchDraftPlatform());

  // Set title
  const titleEl = document.getElementById("batchModalTitle");
  if (titleEl) titleEl.textContent = BATCH_MODE_META[mode]?.title ?? "批量采集";

  // Show only the relevant pane
  document.getElementById("batchPaneLinks").hidden = mode !== "links";
  document.getElementById("batchPaneBloggers").hidden = mode !== "bloggers";
  document.getElementById("batchPaneKeywords").hidden = mode !== "keywords";
  overlay
    .querySelector(".batch-modal-card")
    ?.classList.toggle("is-keyword-mode", mode === "keywords");

  overlay.classList.add("is-active");
  overlay.ariaHidden = "false";
}

function closeBatchModal() {
  const overlay = document.getElementById("batchModalOverlay");
  if (!overlay) return;

  persistCurrentBatchDraft();
  overlay.classList.remove("is-active");
  overlay.ariaHidden = "true";
}

async function writeTextToClipboard(text) {
  if (
    navigator?.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function handleCopyDiagnostics() {
  try {
    const text = await buildDiagnosticsText({
      trigger: "execution_details",
    });
    await writeTextToClipboard(text);
    void recordDiagnosticAction({
      featureKey: "diagnostics.copy",
      source: "execution_details",
      action: "copy_diagnostics",
      status: "completed",
    }).catch(() => null);
    showMessage("诊断信息已复制，可直接贴给协作者排查", "success");
  } catch (error) {
    console.error("[Sidebar] Copy diagnostics failed:", error);
    showMessage("复制诊断信息失败: " + error.message, "error");
  }
}

// ==================== 初始化 ====================

/**
 * 初始化侧边栏
 */
export async function initSidebar() {
  console.log("[Sidebar] Initializing...");

  // 先恢复用户已经确认关闭的终态摘要，避免 initAllStates 首屏短暂复活旧任务。
  await loadTerminalCaptureSummaryAcknowledgements();
  // 在任务状态开始写入前建立控制面保留区；建立失败不会阻断启动，但后续
  // quota 路径仍会明确失败而不是把控制写入误报为成功。
  await ensureControlStorageReserve();
  // 初始化所有状态
  await initAllStates();
  void flushPendingUnattendedCheckpointReports({quiet: true});
  connectCaptureTaskOwnerPort();
  syncCaptureTaskOwnerFromRuntime(getCurrentRuntime() || {});

  let repairedDetailCapture = {count: 0, recordIds: []};
  let repairedCommentCapture = {count: 0, recordIds: []};
  let canRepairInterruptedCapture = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:get-capture-lock",
    });
    // 另一个仍存活的侧栏/标签页持有任务锁时，不能把它正在跑的记录误判中断。
    canRepairInterruptedCapture = Boolean(response?.ok && !response?.data);
  } catch (error) {
    console.warn("[Sidebar] inspect capture lock before repair failed:", error);
  }
  if (canRepairInterruptedCapture) {
    try {
      repairedDetailCapture = await repairInterruptedDetailCaptureRecords();
    } catch (error) {
      console.warn(
        "[Sidebar] repair interrupted detail capture records failed:",
        error,
      );
    }
    try {
      repairedCommentCapture = await repairInterruptedCommentCaptureRecords();
    } catch (error) {
      console.warn(
        "[Sidebar] repair interrupted comment capture records failed:",
        error,
      );
    }
    if (
      repairedDetailCapture.count > 0 ||
      repairedCommentCapture.count > 0
    ) {
      await refreshDataPool();
    }
  }

  // 订阅状态变化
  setupStateSubscriptions();

  // 绑定 UI 事件
  setupUIEventListeners();
  setupDebugSessionPanelControls();
  setupKeywordPlanStorageListener();

  await showRiskNoticeIfNeeded();

  // 初始化采集偏好设置 UI
  await initCaptureSettingsUI();

  try {
    await loadBatchDraftStore();
  } catch (error) {
    console.warn("[Sidebar] Load batch drafts failed:", error);
    batchDraftByPlatform = {};
  }

  // 更新 UI
  updateUI();
  syncRuntimeCaptureProgress(getCurrentRuntime());
  await syncRuntimeCommentProgress(getCurrentRuntime());
  syncSearchFilterControlsForPlatform(getViewPlatform(getCurrentRuntime()));
  await Promise.all([
    loadKeywordPlanUI(),
    loadActiveKeywordRunState(),
    loadTargetedPostRunStateForDisplay(),
  ]);
  startKeywordPlanReconcileTimer();
  if (repairedDetailCapture.count > 0) {
    showMessage(
      `${repairedDetailCapture.count} 条采集增强任务因页面或插件中断已标记为失败，可点击 ↻ 重试`,
      "warning",
    );
  }
  if (repairedCommentCapture.count > 0) {
    showMessage(
      `${repairedCommentCapture.count} 条评论采集因断网、休眠或页面中断已停止等待；可在提示或记录卡片中继续，已落盘数据不会丢失`,
      "warning",
    );
    renderCaptureRecoveryUI({
      phase: "interrupted_repaired",
      recordId: String(repairedCommentCapture.recordIds?.[0] || ""),
      interruptedCount: repairedCommentCapture.count,
      captureAction: "captureComments",
      updatedAt: Date.now(),
    });
  }
  checkExtensionUpdate({trigger: "auto"}).catch((error) => {
    console.warn("[Sidebar] Initial update check failed:", error);
  });

  updateExpandKeywordsButtonState();

  const runtime = getCurrentRuntime();
  lastRuntimePageTypeForKeywordSort = runtime?.pageType || PAGE_TYPE.UNKNOWN;
  lastRuntimePageUrlForKeywordSort = String(runtime?.lastPageUrl || "");
  syncKeywordSortDimensionByRuntime(runtime).catch((error) => {
    console.warn("[Sidebar] Initial keyword sort sync failed:", error);
  });

  const auth = getCurrentAuth() || {};
  if (auth.verified) {
    syncTargetConfigAfterVerify().catch((error) => {
      console.warn("[Sidebar] Initial target sync failed:", error);
    });
    loadMonitorSettings().catch((error) => {
      console.warn("[Sidebar] Initial monitor settings sync failed:", error);
    });
  }

  if (isMonitorAuthReady()) {
    Promise.all([loadMonitorSubscriptions()]).catch((error) => {
      console.warn("[Sidebar] Initial monitor refresh failed:", error);
    });
  } else {
    populateMonitorSettingsForm(DEFAULT_MONITOR_SETTINGS);
  }

  void maybeClaimAndRunUnattendedKeywordPlan({allowPending: true}).catch((error) => {
    console.error("[Sidebar] Initial unattended keyword plan failed:", error);
  });
  void maybeClaimAndRunTargetedPostWorkflow().catch((error) => {
    console.error("[Sidebar] Initial targeted post workflow failed:", error);
  });

  console.log("[Sidebar] Initialized");
}

// ==================== 状态订阅 ====================

function buildPublicSidebarAuthState(auth) {
  const source = auth && typeof auth === "object" ? auth : {};
  const credential =
    source.credential && typeof source.credential === "object"
      ? source.credential
      : null;
  return {
    verified: source.verified === true,
    status: String(source.status || ""),
    reason: String(source.reason || ""),
    message: String(source.message || ""),
    user: source.user
      ? {name: String(source.user.name || ""), email: String(source.user.email || "")}
      : null,
    tenant: source.tenant
      ? {id: String(source.tenant.id || ""), name: String(source.tenant.name || "")}
      : null,
    credential: credential
      ? {
          type: String(credential.type || ""),
          status: String(credential.status || ""),
          expiresAt: credential.expiresAt || null,
          daysRemaining: credential.daysRemaining ?? null,
          maxBindings: credential.maxBindings ?? null,
          currentBindings: credential.currentBindings ?? null,
        }
      : null,
  };
}

/**
 * 设置状态订阅
 */
function setupStateSubscriptions() {
  // 订阅运行时状态变化
  subscribe("runtime", (runtime) => {
    console.log("[Sidebar] Runtime updated:", runtime);
    window.getSidebarRuntimeState = () => runtime;
    updatePlatformUI(runtime);
    syncSearchFilterControlsForPlatform(getViewPlatform(runtime));
    updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
    const currentPageType = runtime?.pageType || PAGE_TYPE.UNKNOWN;
    const currentPageUrl = String(runtime?.lastPageUrl || "");
    const shouldSyncKeywordSort =
      currentPageType !== lastRuntimePageTypeForKeywordSort ||
      currentPageUrl !== lastRuntimePageUrlForKeywordSort;
    lastRuntimePageTypeForKeywordSort = currentPageType;
    lastRuntimePageUrlForKeywordSort = currentPageUrl;
    if (shouldSyncKeywordSort) {
      syncKeywordSortDimensionByRuntime(runtime).catch((error) => {
        console.warn("[Sidebar] Failed to sync keyword sort dimension:", error);
      });
    }
    syncRuntimeCaptureProgress(runtime);
    renderCaptureDebugSession(runtime);
    syncCaptureTaskOwnerFromRuntime(runtime);
    syncRuntimeCommentProgress(runtime).catch((error) => {
      console.warn("[Sidebar] Failed to sync runtime comment progress:", error);
    });
  });

  // 订阅鉴权状态变化
  subscribe("auth", (auth) => {
    console.log("[Sidebar] Auth updated:", {
      status: auth?.status,
      verified: auth?.verified === true,
      tenantId: auth?.tenant?.id || "",
      cloudAgentReady: Boolean(auth?.captureAgent?.id && auth?.captureAgent?.token),
    });
    const publicAuth = buildPublicSidebarAuthState(auth);
    window.getSidebarAuthState = () => publicAuth;
    updateAuthUI(auth);
    updateDataPoolUI(getCurrentDataPool());
  });

  // 订阅目标配置变化
  subscribe("target", (target) => {
    console.log("[Sidebar] Target updated:", target);
    updateTargetUI(target);
  });

  // 订阅采集状态变化
  subscribe("capture", (capture) => {
    console.log("[Sidebar] Capture updated:", capture);
    updateCaptureUI(capture);
  });

  // 订阅同步状态变化
  subscribe("sync", (sync) => {
    console.log("[Sidebar] Sync updated:", sync);
    updateSyncUI(sync);
  });

  // 订阅数据池变化
  subscribe("dataPool", (dataPool) => {
    console.log(
      "[Sidebar] DataPool updated:",
      dataPool.records.length,
      "records",
    );
    updateDataPoolUI(dataPool);
  });

  subscribe("monitor", (monitor) => {
    console.log(
      "[Sidebar] Monitor updated:",
      Array.isArray(monitor?.items) ? monitor.items.length : 0,
      "subscriptions",
    );
    window.getSidebarMonitorState = () => monitor;
    updateDataPoolUI(getCurrentDataPool());
  });
}

function readFiniteProgressNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function readProgressText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function isCaptureTaskWaitPhase(phase = "") {
  const normalized = String(phase || "").trim().toLowerCase();
  return (
    normalized === "scheduled-waiting" ||
    normalized === "waiting_next_round" ||
    normalized === "starting_next_round" ||
    normalized === "keyword_retry_wait" ||
    normalized === "inter_keyword_delay" ||
    normalized === "detail_item_delay" ||
    normalized.includes("backoff") ||
    normalized.includes("safe_wait")
  );
}

function isCaptureTaskDetailPhase(phase = "") {
  const normalized = String(phase || "").trim().toLowerCase();
  return (
    normalized.startsWith("detail_") ||
    normalized.startsWith("comments_") ||
    normalized.includes("enhanc")
  );
}

function isCaptureTaskSyncPhase(phase = "") {
  const normalized = String(phase || "").trim().toLowerCase();
  return (
    normalized.includes("sync") ||
    normalized.includes("upload") ||
    normalized.includes("saving")
  );
}

function projectCaptureTaskProgress(
  progress = {},
  context = activeCaptureTaskProgressContext,
) {
  const safeProgress =
    progress && typeof progress === "object" && !Array.isArray(progress)
      ? progress
      : {};
  const safeContext =
    context && typeof context === "object" && !Array.isArray(context)
      ? context
      : {};
  const phase = readProgressText(safeProgress.phase, safeContext.phase);
  const keyword = readProgressText(
    safeProgress.keyword,
    safeContext.keyword,
  );
  const legacyCurrent = readFiniteProgressNumber(safeProgress.current);
  const legacyTotal = readFiniteProgressNumber(safeProgress.total);
  const detailPhase = isCaptureTaskDetailPhase(phase);
  const waitPhase = isCaptureTaskWaitPhase(phase);
  const syncPhase = isCaptureTaskSyncPhase(phase);
  const targetedPost = safeProgress.targetedPost === true;
  const taskMeta = {
    ...(safeContext.taskMeta &&
    typeof safeContext.taskMeta === "object" &&
    !Array.isArray(safeContext.taskMeta)
      ? safeContext.taskMeta
      : {}),
    ...(safeProgress.taskMeta &&
    typeof safeProgress.taskMeta === "object" &&
    !Array.isArray(safeProgress.taskMeta)
      ? safeProgress.taskMeta
      : {}),
  };
  const keywordList = Array.isArray(taskMeta.keywordList)
    ? taskMeta.keywordList.map((value) => String(value || "").trim())
    : [];
  const plannedKeywordIndex = keyword ? keywordList.indexOf(keyword) : -1;

  let keywordCurrent = readFiniteProgressNumber(safeProgress.keywordCurrent);
  let keywordTotal = readFiniteProgressNumber(safeProgress.keywordTotal);
  if (plannedKeywordIndex >= 0) {
    if (keywordCurrent === null) keywordCurrent = plannedKeywordIndex + 1;
    if (keywordTotal === null) keywordTotal = keywordList.length;
  }
  if (
    !detailPhase &&
    !waitPhase &&
    !syncPhase &&
    keyword &&
    (keywordCurrent === null || keywordTotal === null)
  ) {
    if (keywordCurrent === null && legacyCurrent !== null) {
      keywordCurrent = legacyCurrent;
    }
    if (keywordTotal === null && legacyTotal !== null) {
      keywordTotal = legacyTotal;
    }
  }
  if (keywordCurrent === null) {
    keywordCurrent = readFiniteProgressNumber(safeContext.keywordCurrent);
  }
  if (keywordTotal === null) {
    keywordTotal = readFiniteProgressNumber(safeContext.keywordTotal);
  }

  let itemCurrent = readFiniteProgressNumber(safeProgress.itemCurrent);
  let itemTotal = readFiniteProgressNumber(safeProgress.itemTotal);
  if (
    detailPhase &&
    itemCurrent === null &&
    itemTotal === null &&
    legacyCurrent !== null &&
    legacyTotal !== null
  ) {
    itemCurrent = legacyCurrent;
    itemTotal = legacyTotal;
  }

  const roundCurrent = readFiniteProgressNumber(
    safeProgress.roundCurrent,
    safeProgress.round,
    safeContext.roundCurrent,
    safeContext.round,
  );
  const roundTotal = readFiniteProgressNumber(
    safeProgress.roundTotal,
    safeContext.roundTotal,
  );
  const attemptCurrent = readFiniteProgressNumber(
    safeProgress.attemptCurrent,
    safeProgress.attempt,
    safeContext.attemptCurrent,
    safeContext.attempt,
  );
  const attemptTotal = readFiniteProgressNumber(
    safeProgress.attemptTotal,
    safeProgress.maxAttempts,
    safeContext.attemptTotal,
    safeContext.maxAttempts,
  );
  const progressScope = readProgressText(
    safeProgress.progressScope,
    waitPhase
      ? "wait"
      : detailPhase
        ? "detail_item"
        : syncPhase
          ? "sync_item"
          : keyword
            ? "keyword"
            : safeContext.progressScope,
  );
  return {
    ...safeProgress,
    captureTaskId: readProgressText(
      safeProgress.captureTaskId,
      safeContext.captureTaskId,
    ),
    unattendedRequestId: readProgressText(
      safeProgress.unattendedRequestId,
      safeContext.unattendedRequestId,
    ),
    unattendedAttemptId: readProgressText(
      safeProgress.unattendedAttemptId,
      safeContext.unattendedAttemptId,
    ),
    phase,
    keyword,
    keywordCurrent,
    keywordTotal,
    itemCurrent: detailPhase || targetedPost ? itemCurrent : null,
    itemTotal: detailPhase || targetedPost ? itemTotal : null,
    round: roundCurrent,
    roundCurrent,
    roundTotal,
    attempt: attemptCurrent,
    attemptCurrent,
    attemptTotal,
    maxAttempts: attemptTotal,
    nextKeyword: readProgressText(
      safeProgress.nextKeyword,
      safeContext.nextKeyword,
    ),
    runStartedAt: readProgressText(
      safeProgress.runStartedAt,
      safeContext.runStartedAt,
    ),
    progressScope,
    taskMeta,
  };
}

function rememberCaptureTaskProgressContext(progress = {}) {
  const projected = projectCaptureTaskProgress(progress);
  activeCaptureTaskProgressContext = {
    captureTaskId: projected.captureTaskId,
    unattendedRequestId: projected.unattendedRequestId,
    unattendedAttemptId: projected.unattendedAttemptId,
    phase: projected.phase,
    keyword: projected.keyword,
    keywordCurrent: projected.keywordCurrent,
    keywordTotal: projected.keywordTotal,
    round: projected.roundCurrent,
    roundCurrent: projected.roundCurrent,
    roundTotal: projected.roundTotal,
    attempt: projected.attemptCurrent,
    attemptCurrent: projected.attemptCurrent,
    attemptTotal: projected.attemptTotal,
    maxAttempts: projected.attemptTotal,
    nextKeyword: projected.nextKeyword,
    runStartedAt: projected.runStartedAt,
    progressScope: projected.progressScope,
    taskMeta: projected.taskMeta,
  };
  return projected;
}

function clearCaptureTaskProgressContext() {
  activeCaptureTaskProgressContext = null;
}

function resolveCaptureTaskStep(progress = {}) {
  const phase = String(progress?.phase || "debug_session_attached").toLowerCase();
  if (
    /^(?:unattended|targeted)_/.test(phase) &&
    /completed|failed|canceled|skipped|needs_action/.test(phase)
  ) {
    return 5;
  }
  if (progress?.targetedPost === true) {
    return phase.includes("settled") || phase.includes("unavailable") ? 2 : 1;
  }
  if (isCaptureTaskWaitPhase(phase)) {
    return 1;
  }
  if (
    phase.includes("sync") ||
    phase.includes("upload") ||
    phase.includes("check_before")
  ) {
    return 4;
  }
  if (phase.startsWith("detail_") || phase.includes("enhanc")) {
    return 3;
  }
  if (
    phase.includes("saving") ||
    phase === "saved" ||
    phase.includes("marked") ||
    phase.includes("binding") ||
    phase === "completed"
  ) {
    return 2;
  }
  if (
    phase === "debug_session_attached" ||
    phase.includes("initial") ||
    phase.includes("analy")
  ) {
    return 0;
  }
  return 1;
}

function resolveCaptureTaskPercent(progress = {}) {
  const explicit = Number(progress?.progressPercent);
  if (!Number.isFinite(explicit)) return null;
  return Math.max(0, Math.min(100, Math.round(explicit)));
}

function isTerminalCaptureTaskView(progress = {}, session = {}) {
  if (session?.terminal === true) return true;
  const phase = String(progress?.phase || "").trim().toLowerCase();
  return Boolean(
    /^(?:unattended|targeted)_/.test(phase) &&
      /(?:completed(?:_with_(?:failures|warnings))?|failed|canceled|cancelled|needs_action)$/.test(
        phase,
      ),
  );
}

function buildCaptureTaskStats(progress = {}) {
  const parts = [];
  if (progress?.targetedPost === true) {
    const completed = Math.max(
      0,
      Number(progress?.completedTargetCount) || 0,
    );
    const unavailable = Math.max(
      0,
      Number(progress?.unavailableTargetCount) || 0,
    );
    const deleted = Math.max(
      0,
      Number(progress?.deletedTargetCount) || 0,
    );
    const pageUnavailable = Math.max(
      0,
      Number(progress?.pageUnavailableTargetCount) || 0,
    );
    const failed = Math.max(0, Number(progress?.failedTargetCount) || 0);
    const current = Math.max(
      0,
      Number(progress?.itemCurrent ?? progress?.current) || 0,
    );
    const total = Math.max(
      0,
      Number(progress?.itemTotal ?? progress?.total) || 0,
    );
    if (completed > 0) parts.push(`已采集 ${completed} 条`);
    if (deleted > 0) parts.push(`已删除 ${deleted} 条`);
    if (pageUnavailable > 0) {
      parts.push(`暂不可用 ${pageUnavailable} 条`);
    }
    if (
      unavailable > 0 &&
      deleted === 0 &&
      pageUnavailable === 0
    ) {
      parts.push(`已删除或不可用 ${unavailable} 条`);
    }
    if (failed > 0) parts.push(`失败 ${failed} 条`);
    if (parts.length === 0 && total > 0) {
      parts.push(`巡查进度 ${Math.min(current, total)}/${total}`);
    }
    return parts.join(" · ");
  }
  const keyword = String(progress?.keyword || "").trim();
  const detectedCount = Number(progress?.detectedCount);
  const markedCount = Number(progress?.markedCount ?? progress?.filteredCount);
  const itemCurrent = Number(progress?.itemCurrent);
  const itemTotal = Number(progress?.itemTotal);
  const keywordCurrent = Number(progress?.keywordCurrent);
  const keywordTotal = Number(progress?.keywordTotal);
  const roundCurrent = Number(progress?.roundCurrent ?? progress?.round);
  const roundTotal = Number(progress?.roundTotal);
  if (isTerminalCaptureTaskView(progress)) {
    const completed = Math.max(
      0,
      Number(progress?.keywordCompletedCount) || 0,
    );
    const partial = Math.max(
      0,
      Number(progress?.keywordPartialCount) || 0,
    );
    const failed = Math.max(
      0,
      Number(progress?.keywordFailedCount) || 0,
    );
    const skipped = Math.max(
      0,
      Number(progress?.keywordSkippedCount) || 0,
    );
    const detailFailed = Math.max(
      0,
      Number(progress?.detailFailedCount) || 0,
    );
    const aiFiltered = Math.max(
      0,
      Number(progress?.aiFilteredCount) || 0,
    );
    const noEnhancement = Math.max(
      0,
      Number(progress?.noEnhancementCount) || 0,
    );
    const syncSuccess = Math.max(
      0,
      Number(progress?.syncSuccessCount) || 0,
    );
    const syncFailed = Math.max(
      0,
      Number(progress?.syncFailedCount) || 0,
    );
    const syncSkipped = Math.max(
      0,
      Number(progress?.syncSkippedCount) || 0,
    );
    const syncRemaining = Math.max(
      0,
      Number(progress?.syncRemainingCount) || 0,
    );
    if (completed > 0) parts.push(`完整完成 ${completed} 个词`);
    if (partial > 0) parts.push(`部分完成 ${partial} 个词`);
    if (failed > 0) parts.push(`失败 ${failed} 个词`);
    if (skipped > 0) parts.push(`跳过 ${skipped} 个词`);
    if (
      completed + partial + failed + skipped === 0 &&
      Number.isFinite(keywordCurrent) &&
      Number.isFinite(keywordTotal) &&
      keywordTotal > 0
    ) {
      parts.push(
        `关键词 ${Math.min(Math.floor(keywordCurrent), Math.floor(keywordTotal))}/${Math.floor(keywordTotal)}`,
      );
    }
    if (detailFailed > 0) parts.push(`作品失败 ${detailFailed} 条`);
    if (aiFiltered > 0) parts.push(`AI 跳过 ${aiFiltered} 条`);
    if (noEnhancement > 0) parts.push(`无需增强 ${noEnhancement} 条`);
    const syncTotal =
      syncSuccess + syncFailed + syncSkipped + syncRemaining;
    if (syncTotal > 0) {
      parts.push(`最终同步 ${syncSuccess}/${syncTotal} 条`);
      if (syncFailed > 0) parts.push(`同步失败 ${syncFailed} 条`);
      if (syncRemaining > 0) parts.push(`待上传 ${syncRemaining} 条`);
    }
    return parts.join(" · ");
  }
  if (
    Number.isFinite(roundCurrent) &&
    Number.isFinite(roundTotal) &&
    roundCurrent > 0 &&
    roundTotal > 1
  ) {
    parts.push(
      `第 ${Math.min(Math.floor(roundCurrent), Math.floor(roundTotal))}/${Math.floor(roundTotal)} 轮`,
    );
  }
  if (Number.isFinite(detectedCount) && detectedCount > 0) {
    parts.push(`已读取 ${Math.floor(detectedCount)} 条`);
  }
  if (Number.isFinite(markedCount) && markedCount > 0) {
    parts.push(`已标记 ${Math.floor(markedCount)} 条`);
  }
  if (
    Number.isFinite(keywordCurrent) &&
    Number.isFinite(keywordTotal) &&
    keywordTotal > 0 &&
    keywordCurrent >= 0
  ) {
    parts.push(
      `关键词 ${Math.min(Math.floor(keywordCurrent), Math.floor(keywordTotal))}/${Math.floor(keywordTotal)}${keyword ? `：${keyword}` : ""}`,
    );
  }
  if (
    Number.isFinite(itemCurrent) &&
    Number.isFinite(itemTotal) &&
    itemTotal > 0 &&
    itemCurrent >= 0
  ) {
    parts.push(
      `当前词内作品 ${Math.min(Math.floor(itemCurrent), Math.floor(itemTotal))}/${Math.floor(itemTotal)}`,
    );
  }
  return parts.join(" · ");
}

function parseCaptureTaskTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed =
    typeof value === "number" ? Number(value) : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatCaptureTaskDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function formatCaptureTaskRelativeTime(timestamp, now = Date.now()) {
  const parsed = parseCaptureTaskTime(timestamp);
  if (!parsed) return "刚刚";
  const elapsedSeconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (elapsedSeconds < 5) return "刚刚";
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

function resolveCaptureTaskWaitDeadline(progress = {}) {
  const explicit = parseCaptureTaskTime(progress?.waitUntil);
  if (explicit) return explicit;
  const remainingMs = Number(progress?.remainingMs);
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
  const reportedAt =
    parseCaptureTaskTime(progress?.updatedAt) || Date.now();
  return reportedAt + remainingMs;
}

function resolveCaptureTaskHealth(progress = {}, session = {}, now = Date.now()) {
  const phase = String(progress?.phase || "").trim().toLowerCase();
  if (isTerminalCaptureTaskView(progress, session)) {
    const terminalState = String(
      session?.state || phase.replace(/^(?:unattended|targeted)_/, ""),
    )
      .trim()
      .toLowerCase();
    if (/cancel|stop/.test(terminalState)) {
      return {key: "stopped", label: "已停止"};
    }
    if (/completed/.test(terminalState)) {
      return {key: "completed", label: "已完成"};
    }
    return {key: "ended", label: "已结束"};
  }
  const waitDeadline = resolveCaptureTaskWaitDeadline(progress);
  if (
    isCaptureTaskWaitPhase(phase) &&
    (!waitDeadline || waitDeadline > now)
  ) {
    return {key: "waiting", label: "安全等待"};
  }
  const lastProgressAt =
    parseCaptureTaskTime(progress?.updatedAt) ||
    parseCaptureTaskTime(session?.startedAt) ||
    now;
  const idleMs = Math.max(0, now - lastProgressAt);
  const slowAfterMs = phase.startsWith("comments_")
    ? 90_000
    : isCaptureTaskDetailPhase(phase)
      ? 60_000
      : 35_000;
  if (idleMs >= slowAfterMs) {
    return {key: "slow", label: "页面响应较慢"};
  }
  return {key: "active", label: "运行正常"};
}

function resolveCaptureTaskActionCopy(progress = {}) {
  const phase = String(progress?.phase || "").trim().toLowerCase();
  const profileDiscovery =
    progress?.targetedPost === true &&
    isTargetedProfileDiscoveryWorkflow(
      progress?.workflow,
      progress?.targetMode || progress?.taskMeta?.targetMode,
    );
  const itemCurrent = Math.max(
    0,
    Number(progress?.itemCurrent ?? progress?.current) || 0,
  );
  const itemTotal = Math.max(
    0,
    Number(progress?.itemTotal ?? progress?.total) || 0,
  );
  const itemLabel =
    itemCurrent > 0
      ? `第 ${itemCurrent}${itemTotal > 0 ? `/${itemTotal}` : ""} ${profileDiscovery ? "个账号" : "条作品"}`
      : profileDiscovery
        ? "当前账号"
        : "当前作品";
  const taskMeta =
    progress?.taskMeta && typeof progress.taskMeta === "object"
      ? progress.taskMeta
      : {};
  const executionCopy = getKeywordExecutionCopy({
    executionMode:
      progress?.executionMode || taskMeta.executionMode || "unattended_plan",
  });
  const detailFields = ["正文、作者、发布时间和互动数据"];
  if (taskMeta.commentsEnabled) detailFields.push("评论");
  if (taskMeta.bloggerMetricsEnabled) detailFields.push("作者粉丝等账号信息");

  if (progress?.targetedPost === true) {
    const workflowLabel = getTargetedWorkflowLabel(progress?.workflow);
    const currentTitle = readProgressText(
      progress?.currentTargetTitle,
      progress?.title,
    );
    if (phase === "target_unavailable") {
      return {
        title: "帖子已删除或当前不可用",
        explanation:
          readProgressText(progress?.message) ||
          "平台已明确返回帖子不可访问，系统已记录状态",
        nextAction: "该结果不会重试，将自动继续下一条帖子",
      };
    }
    if (phase.startsWith("targeted_completed")) {
      return {
        title: `${workflowLabel}已完成`,
        explanation:
          readProgressText(progress?.message) ||
          (profileDiscovery
            ? "全部账号已完成扫描并记录结果"
            : "全部目标帖子已完成巡查并记录结果"),
        nextAction: profileDiscovery
          ? "可在关注账号页面和调度中心查看结果"
          : "可在负面帖子列表和调度中心查看结果",
      };
    }
    if (phase.startsWith("targeted_canceled")) {
      return {
        title: `${workflowLabel}已停止`,
        explanation:
          readProgressText(progress?.message) || "已停止并保留现有巡查结果",
        nextAction: `可在调度中心继续处理剩余${profileDiscovery ? "账号" : "帖子"}`,
      };
    }
    if (phase.startsWith("targeted_")) {
      return {
        title: `${workflowLabel}已结束`,
        explanation:
          readProgressText(progress?.message) || "本次巡查已经结束",
        nextAction: "可在调度中心查看结果和需要处理的原因",
      };
    }
    if (phase.includes("opening") || phase.includes("navigating")) {
      return {
        title: `正在打开${itemLabel}`,
        explanation: currentTitle
          ? `正在检查「${currentTitle}」${profileDiscovery ? "主页" : ""}是否仍可访问`
          : profileDiscovery
            ? "正在检查目标账号主页是否仍可访问"
            : "正在检查目标帖子是否仍可访问",
        nextAction: profileDiscovery
          ? "主页就绪后会扫描发布时间范围内的作品"
          : "页面就绪后会采集内容，已删除帖子将直接标记",
      };
    }
    if (phase.includes("settled")) {
      return {
        title: `${itemLabel}巡查完成`,
        explanation:
          readProgressText(progress?.message) ||
          `当前${profileDiscovery ? "账号扫描" : "帖子"}结果已保存`,
        nextAction:
          itemTotal > itemCurrent
            ? `继续${profileDiscovery ? "扫描" : "巡查"}第 ${itemCurrent + 1}/${itemTotal} ${profileDiscovery ? "个账号" : "条帖子"}`
            : "正在汇总本次巡查结果",
      };
    }
    return {
      title: `正在巡查${itemLabel}`,
      explanation: currentTitle
        ? `正在采集「${currentTitle}」`
        : `正在执行${workflowLabel}`,
      nextAction: `当前${profileDiscovery ? "账号" : "帖子"}完成后会自动继续下一个`,
    };
  }

  if (phase.startsWith("unattended_completed")) {
    return {
      title: phase.includes("with_failures") ? "任务已完成，部分作品需处理" : "任务已完成",
      explanation:
        readProgressText(progress?.message) ||
        `本次${executionCopy.captureLabel}已经收口`,
      nextAction: "结果已保留，可在列表和任务中心查看",
    };
  }
  if (phase.startsWith("unattended_canceled")) {
    return {
      title: "任务已停止",
      explanation: readProgressText(progress?.message) || "本次采集已停止并保留现有结果",
      nextAction: "可在任务中心查看停止原因和已保存数据",
    };
  }
  if (phase.startsWith("unattended_")) {
    return {
      title: "任务已结束",
      explanation:
        readProgressText(progress?.message) ||
        `本次${executionCopy.captureLabel}已经结束`,
      nextAction: "可在任务中心查看结果与需要处理的原因",
    };
  }

  if (phase.includes("initial")) {
    return {
      title: "正在接管浏览器",
      explanation: "确认平台页面、登录状态和搜索环境",
      nextAction: "接管完成后会自动开始当前关键词",
    };
  }
  if (
    phase === "navigating" ||
    phase === "submitting_search" ||
    phase === "waiting_results"
  ) {
    return {
      title: "正在打开当前关键词的搜索结果",
      explanation: "等待页面内容和筛选条件稳定",
      nextAction: "页面就绪后会自动读取搜索结果",
    };
  }
  if (phase === "filtering" || phase === "capturing") {
    return {
      title: "正在读取并筛选搜索结果",
      explanation: "识别符合关键词、发布时间和内容条件的作品",
      nextAction: taskMeta.enhancementEnabled
        ? "列表完成后会逐条完善作品详情"
        : "列表完成后会安全保存采集结果",
    };
  }
  if (phase === "detail_ai_prefilter_start") {
    const candidateCount = Math.max(
      0,
      Number(progress?.candidateCount ?? progress?.total) || 0,
    );
    return {
      title: "AI 正在判断搜索结果相关性",
      explanation:
        candidateCount > 0
          ? `正在根据当前关键词预判 ${candidateCount} 条列表结果`
          : "正在根据当前关键词预判列表结果",
      nextAction: "只会高置信度跳过无关项，其余结果继续正常增强",
    };
  }
  if (phase === "detail_ai_prefilter_done") {
    const filteredCount = Math.max(
      0,
      Number(progress?.aiFilteredCount ?? progress?.filteredCount) || 0,
    );
    const failedOpenCount = Math.max(
      0,
      Number(progress?.failedOpenCount) || 0,
    );
    const retryCount = Math.max(0, Number(progress?.retryCount) || 0);
    return {
      title:
        failedOpenCount > 0
          ? `AI 筛选完成 · ${failedOpenCount} 条超时或异常后继续采集`
          : filteredCount > 0
          ? `AI 筛选完成 · 已跳过 ${filteredCount} 条无关结果`
          : retryCount > 0
            ? `AI 筛选完成 · 拆批重试 ${retryCount} 次`
          : "AI 筛选完成 · 本批全部继续采集",
      explanation:
        readProgressText(progress?.message) || "相关性判断已经完成",
      nextAction:
        failedOpenCount > 0
          ? "超时或异常条目不会被 AI 跳过，仍会继续采集详情"
          : "接下来只为需要保留的结果采集详情、评论和博主信息",
    };
  }
  if (phase === "detail_item_filtered") {
    const confidenceValue = Number(progress?.aiRelevanceConfidence);
    const confidence = Number.isFinite(confidenceValue)
      ? `${Math.round(Math.min(1, Math.max(0, confidenceValue)) * 100)}%`
      : "";
    const reason = readProgressText(progress?.aiRelevanceReason);
    const isAiFiltered = Boolean(
      reason || confidence || /AI/.test(progress?.message || ""),
    );
    return {
      title: isAiFiltered
        ? `AI 已跳过${itemLabel}无关结果`
        : `${itemLabel}不符合条件，已跳过增强`,
      explanation:
        [confidence ? `置信度 ${confidence}` : "", reason]
          .filter(Boolean)
          .join(" · ") ||
        readProgressText(progress?.message) ||
        "该条已保留列表信息，不再进入详情增强",
      nextAction:
        itemCurrent > 0 && itemTotal > itemCurrent
          ? `继续处理第 ${itemCurrent + 1}/${itemTotal} 条作品`
          : "本词处理完成后会进入同步或下一个关键词",
    };
  }
  if (
    phase.includes("item_open") ||
    phase.includes("opening") ||
    phase.includes("navigation")
  ) {
    return {
      title: `正在打开${itemLabel}`,
      explanation: "确认作品可访问并等待详情内容加载",
      nextAction: `页面就绪后读取${detailFields.join("、")}`,
    };
  }
  if (phase.includes("blogger") || phase.includes("profile")) {
    return {
      title: "正在补充作者信息",
      explanation: "读取作者名称、粉丝数和账号指标",
      nextAction: "完成后继续处理当前作品的其余数据",
    };
  }
  if (phase.startsWith("comments_") || phase.includes("comments")) {
    const commentsCount = Math.max(
      0,
      Number(progress?.commentsCount ?? progress?.collectedCount) || 0,
    );
    return {
      title:
        commentsCount > 0
          ? `正在采集评论 · 已读取 ${commentsCount} 条`
          : "正在采集评论",
      explanation: "滚动读取评论，并按设置识别可用客资信息",
      nextAction: "评论完成后会合并保存到当前作品",
    };
  }
  if (isCaptureTaskDetailPhase(phase)) {
    return {
      title: `正在完善${itemLabel}详情`,
      explanation: `读取${detailFields.join("、")}`,
      nextAction:
        itemCurrent > 0 && itemTotal > itemCurrent
          ? `完成后继续第 ${itemCurrent + 1}/${itemTotal} 条作品`
          : "本词详情完成后会进入同步或下一个关键词",
    };
  }
  if (isCaptureTaskSyncPhase(phase)) {
    return {
      title: "正在同步已完成的数据",
      explanation: "采集结果正在分批安全保存",
      nextAction: "同步完成后会继续剩余任务",
    };
  }
  if (isCaptureTaskWaitPhase(phase)) {
    return {
      title:
        phase === "waiting_next_round"
          ? "本轮已完成，正在等待下一轮"
          : phase === "keyword_retry_wait"
            ? "失败关键词即将自动重试"
            : "正在进行防风控安全等待",
      explanation: "这是计划内等待，不是卡住",
      nextAction: progress?.nextKeyword
        ? `接下来处理「${progress.nextKeyword}」`
        : "倒计时结束后系统会自动继续",
    };
  }
  return {
    title:
      readProgressText(progress?.message) || "采集任务持续运行中",
    explanation: "系统正在处理当前页面返回的数据",
    nextAction: "完成当前步骤后会自动继续",
  };
}

function resolveSearchFilterDisplayLabel(platform, field, value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return "";
  const options =
    PLATFORM_SEARCH_FILTER_OPTIONS[
      String(platform || "").trim().toLowerCase()
    ]?.[field];
  if (!Array.isArray(options)) return normalizedValue;
  return (
    options.find((option) => option.value === normalizedValue)?.label ||
    normalizedValue
  );
}

function buildCaptureTaskMetaChips(progress = {}, platform = "") {
  const taskMeta =
    progress?.taskMeta && typeof progress.taskMeta === "object"
      ? progress.taskMeta
      : {};
  const chips = [];
  if (progress?.targetedPost === true) {
    const total = Math.max(
      0,
      Number(progress?.itemTotal ?? progress?.total) || 0,
    );
    const profileDiscovery =
      isTargetedProfileDiscoveryWorkflow(
        progress?.workflow,
        progress?.targetMode || progress?.taskMeta?.targetMode,
      );
    if (total > 0) {
      chips.push(`${total} ${profileDiscovery ? "个账号" : "条帖子"}`);
    }
    chips.push(getTargetedWorkflowLabel(progress?.workflow));
    if (taskMeta.commentsEnabled) chips.push("附加评论");
    if (taskMeta.bloggerMetricsEnabled) chips.push("作者指标");
    return chips;
  }
  const keywordList = Array.isArray(taskMeta.keywordList)
    ? taskMeta.keywordList.filter(Boolean)
    : [];
  if (keywordList.length > 0) chips.push(`${keywordList.length} 个关键词`);
  const roundTotal = Math.max(0, Number(progress?.roundTotal) || 0);
  if (roundTotal > 1) chips.push(`${roundTotal} 轮`);
  const searchFilters =
    taskMeta.searchFilters && typeof taskMeta.searchFilters === "object"
      ? taskMeta.searchFilters
      : {};
  [
    ["sort", "排序"],
    ["publishTime", "发布"],
    ["contentType", "内容"],
    ["searchScope", "范围"],
    ["distance", "距离"],
    ["videoDuration", "时长"],
  ].forEach(([field, prefix]) => {
    const label = resolveSearchFilterDisplayLabel(
      platform,
      field,
      searchFilters[field],
    );
    if (label && !/默认|不限/.test(label)) {
      chips.push(`${prefix}：${label}`);
    }
  });
  if (taskMeta.enhancementEnabled) chips.push("增强采集");
  if (taskMeta.aiRelevancePrefilterEnabled) chips.push("AI 精准筛选");
  if (taskMeta.commentsEnabled) chips.push("附加评论");
  if (taskMeta.bloggerMetricsEnabled) chips.push("作者指标");
  return chips.slice(0, 8);
}

function buildCaptureTaskScopeMeta(progress = {}) {
  const parts = [];
  const keyword = String(progress?.keyword || "").trim();
  const roundCurrent = Math.max(
    0,
    Number(progress?.roundCurrent ?? progress?.round) || 0,
  );
  const roundTotal = Math.max(0, Number(progress?.roundTotal) || 0);
  const keywordCurrent = Math.max(0, Number(progress?.keywordCurrent) || 0);
  const keywordTotal = Math.max(0, Number(progress?.keywordTotal) || 0);
  const itemCurrent = Math.max(0, Number(progress?.itemCurrent) || 0);
  const itemTotal = Math.max(0, Number(progress?.itemTotal) || 0);
  if (progress?.targetedPost === true) {
    const current = Math.max(
      0,
      Number(progress?.itemCurrent ?? progress?.current) || 0,
    );
    const total = Math.max(
      0,
      Number(progress?.itemTotal ?? progress?.total) || 0,
    );
    if (current > 0 && total > 0) {
      parts.push(
        `${isTargetedProfileDiscoveryWorkflow(
          progress?.workflow,
          progress?.targetMode || progress?.taskMeta?.targetMode,
        ) ? "账号" : "帖子"} ${Math.min(current, total)}/${total}`,
      );
    }
    return parts;
  }
  if (roundCurrent > 0 && roundTotal > 1) {
    parts.push(`第 ${Math.min(roundCurrent, roundTotal)}/${roundTotal} 轮`);
  }
  if (keywordCurrent > 0 && keywordTotal > 0) {
    parts.push(
      `关键词 ${Math.min(keywordCurrent, keywordTotal)}/${keywordTotal}${keyword ? `：${keyword}` : ""}`,
    );
  }
  if (itemCurrent > 0 && itemTotal > 0) {
    parts.push(
      `当前词内作品 ${Math.min(itemCurrent, itemTotal)}/${itemTotal}`,
    );
  }
  const attemptCurrent = Math.max(
    0,
    Number(progress?.attemptCurrent ?? progress?.attempt) || 0,
  );
  const attemptTotal = Math.max(
    0,
    Number(progress?.attemptTotal ?? progress?.maxAttempts) || 0,
  );
  if (attemptCurrent > 1 && attemptTotal > 1) {
    parts.push(`重试 ${Math.min(attemptCurrent, attemptTotal)}/${attemptTotal}`);
  }
  return parts;
}

function buildCaptureTaskActivityMessage(progress = {}, actionCopy = {}) {
  const phase = String(progress?.phase || "").trim().toLowerCase();
  const itemCurrent = Math.max(0, Number(progress?.itemCurrent) || 0);
  const commentsCount = Math.max(
    0,
    Number(progress?.commentsCount ?? progress?.collectedCount) || 0,
  );
  const followersCount = Math.max(
    0,
    Number(
      progress?.bloggerFollowersCount ?? progress?.followersCount,
    ) || 0,
  );
  const savedCount = Math.max(0, Number(progress?.savedCount) || 0);
  if (progress?.targetedPost === true && phase === "target_unavailable") {
    return "当前帖子已标记为删除或不可用";
  }
  if (phase.includes("item_done") || phase.includes("item_complete")) {
    return itemCurrent > 0
      ? `第 ${itemCurrent} 条作品详情已完成`
      : "一条作品详情已完成";
  }
  if (phase.startsWith("comments_") && commentsCount > 0) {
    return `已读取评论 ${commentsCount} 条`;
  }
  if (
    (phase.includes("blogger") || phase.includes("profile")) &&
    followersCount > 0
  ) {
    return `作者粉丝数 ${followersCount.toLocaleString("zh-CN")} 已回填`;
  }
  if (savedCount > 0) return `已安全保存 ${savedCount} 条数据`;
  return readProgressText(actionCopy.title, progress?.message);
}

function recordCaptureTaskActivity(taskId, progress = {}, actionCopy = {}) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return;
  if (debugSessionActivityTaskId !== normalizedTaskId) {
    debugSessionActivityTaskId = normalizedTaskId;
    debugSessionActivityEvents = [];
    debugSessionLastActivitySignature = "";
    debugSessionTerminalizedActivityId = "";
  }
  const message = buildCaptureTaskActivityMessage(progress, actionCopy);
  if (!message) return;
  const signature = JSON.stringify({
    phase: progress?.phase,
    keyword: progress?.keyword,
    itemCurrent: progress?.itemCurrent,
    commentsCount:
      progress?.commentsCount ?? progress?.collectedCount ?? null,
    followersCount:
      progress?.bloggerFollowersCount ?? progress?.followersCount ?? null,
    savedCount: progress?.savedCount ?? null,
    message,
  });
  if (signature === debugSessionLastActivitySignature) return;
  debugSessionLastActivitySignature = signature;
  debugSessionActivityEvents.unshift({
    message,
    at: parseCaptureTaskTime(progress?.updatedAt) || Date.now(),
  });
  debugSessionActivityEvents = debugSessionActivityEvents.slice(0, 4);
}

function terminalizeCaptureTaskActivityMessage(message = "") {
  const text = String(message || "").trim();
  if (!text) return "";
  if (/正在同步/.test(text)) return text.replace(/正在同步[^：·]*/u, "数据同步已完成");
  if (/正在(?:完善|补采).*(?:详情|作品)/.test(text)) {
    return text.replace(/^正在/u, "已结束").replace(/采集$/u, "采集步骤");
  }
  if (/正在采集评论/.test(text)) return text.replace("正在采集评论", "评论采集步骤已结束");
  if (/正在补充作者信息/.test(text)) return "作者信息采集步骤已结束";
  if (/正在|等待/.test(text)) {
    return `${text.replace(/^正在/u, "").replace(/^等待/u, "")} · 步骤已结束`;
  }
  return text;
}

function finalizeCaptureTaskActivityEvents(taskId, progress = {}, session = {}) {
  if (!isTerminalCaptureTaskView(progress, session)) return;
  const finishedAt =
    parseCaptureTaskTime(progress?.finishedAt) ||
    parseCaptureTaskTime(session?.finishedAt) ||
    parseCaptureTaskTime(session?.terminalRunAt) ||
    Date.now();
  const terminalId = `${String(taskId || "")}:${finishedAt}:${String(progress?.phase || "")}`;
  if (debugSessionTerminalizedActivityId === terminalId) return;
  debugSessionTerminalizedActivityId = terminalId;
  const terminalMessages = [];
  const syncSuccess = Math.max(0, Number(progress?.syncSuccessCount) || 0);
  const syncFailed = Math.max(0, Number(progress?.syncFailedCount) || 0);
  const syncRemaining = Math.max(0, Number(progress?.syncRemainingCount) || 0);
  if (syncSuccess + syncFailed + syncRemaining > 0) {
    terminalMessages.push(
      `最终同步已结算：成功 ${syncSuccess}，失败 ${syncFailed}，待上传 ${syncRemaining}`,
    );
  }
  const aiFiltered = Math.max(0, Number(progress?.aiFilteredCount) || 0);
  const noEnhancement = Math.max(0, Number(progress?.noEnhancementCount) || 0);
  if (aiFiltered > 0 || noEnhancement > 0) {
    terminalMessages.push(
      `增强筛选已结算：AI 跳过 ${aiFiltered}，无需增强 ${noEnhancement}`,
    );
  }
  const targetedPost = progress?.targetedPost === true;
  terminalMessages.push(
    session?.state === "canceled"
      ? targetedPost
        ? "帖子巡查任务已停止"
        : "无人值守任务已停止"
      : targetedPost
        ? "帖子巡查任务已结算"
        : "无人值守任务已结算",
  );
  const historical = debugSessionActivityEvents.map((event) => ({
    ...event,
    message: terminalizeCaptureTaskActivityMessage(event.message),
  }));
  const merged = [
    ...terminalMessages.map((message) => ({message, at: finishedAt})),
    ...historical,
  ].filter(
    (event, index, events) =>
      event.message &&
      events.findIndex((candidate) => candidate.message === event.message) === index,
  );
  debugSessionActivityEvents = merged.slice(0, 4);
  debugSessionLastActivitySignature = "";
}

function renderCaptureTaskActivityEvents(now = Date.now()) {
  const panel = document.getElementById("debugSessionActivity");
  const list = document.getElementById("debugSessionActivityList");
  if (!panel || !list) return;
  panel.hidden = debugSessionActivityEvents.length === 0;
  list.replaceChildren();
  debugSessionActivityEvents.forEach((event) => {
    const item = document.createElement("li");
    item.className = "debug-session-activity-item";
    const message = document.createElement("span");
    message.textContent = event.message;
    const time = document.createElement("time");
    time.setAttribute("aria-live", "off");
    time.textContent = formatCaptureTaskRelativeTime(event.at, now);
    item.append(message, time);
    list.appendChild(item);
  });
}

function updateDebugSessionClock() {
  const snapshot = debugSessionClockSnapshot;
  if (!snapshot) return;
  const now = Date.now();
  const progress = snapshot.progress || {};
  const session = snapshot.session || {};
  const terminal = isTerminalCaptureTaskView(progress, session);
  const finishedAt =
    parseCaptureTaskTime(progress.finishedAt) ||
    parseCaptureTaskTime(session.finishedAt) ||
    parseCaptureTaskTime(session.terminalRunAt);
  const clockNow = terminal
    ? finishedAt || parseCaptureTaskTime(progress.updatedAt) || now
    : now;
  const runStartedAt =
    parseCaptureTaskTime(progress.runStartedAt) ||
    parseCaptureTaskTime(session.startedAt) ||
    now;
  const phaseStartedAt =
    parseCaptureTaskTime(progress.phaseStartedAt) ||
    parseCaptureTaskTime(progress.updatedAt) ||
    runStartedAt;
  const lastProgressAt =
    parseCaptureTaskTime(progress.updatedAt) || phaseStartedAt;
  const elapsed = document.getElementById("debugSessionElapsed");
  const stepElapsed = document.getElementById("debugSessionStepElapsed");
  const progressAge = document.getElementById("debugSessionLastProgressAge");
  if (elapsed) {
    elapsed.textContent = `${terminal ? "总耗时" : "已运行"} ${formatCaptureTaskDuration(clockNow - runStartedAt)}`;
  }
  if (stepElapsed) {
    stepElapsed.textContent = `本步骤 ${formatCaptureTaskDuration(clockNow - phaseStartedAt)}`;
  }
  if (progressAge) {
    progressAge.textContent = formatCaptureTaskRelativeTime(lastProgressAt, now);
  }

  const health = resolveCaptureTaskHealth(progress, session, now);
  const healthEl = document.getElementById("debugSessionHealth");
  const healthLabel = document.getElementById("debugSessionStateLabel");
  if (healthEl) healthEl.dataset.health = health.key;
  if (healthLabel) healthLabel.textContent = health.label;

  const waitCard = document.getElementById("debugSessionWaitCard");
  const waitCountdown = document.getElementById("debugSessionWaitCountdown");
  const waitDeadline = resolveCaptureTaskWaitDeadline(progress);
  const waiting =
    !terminal &&
    isCaptureTaskWaitPhase(progress?.phase) &&
    Number.isFinite(waitDeadline) &&
    waitDeadline > now;
  if (waitCard) waitCard.hidden = !waiting;
  if (waitCountdown && waiting) {
    waitCountdown.textContent = formatCaptureTaskDuration(waitDeadline - now);
  }

  const dockStatus = document.getElementById("debugSessionDockStatus");
  if (dockStatus) {
    const keyword = String(progress?.keyword || "").trim();
    const itemCurrent = Math.max(0, Number(progress?.itemCurrent) || 0);
    const itemTotal = Math.max(0, Number(progress?.itemTotal) || 0);
    dockStatus.textContent = [
      health.label,
      keyword ? `「${keyword}」` : "",
      itemCurrent > 0 && itemTotal > 0
        ? `${itemCurrent}/${itemTotal}`
        : "",
      formatCaptureTaskDuration(clockNow - runStartedAt),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  renderCaptureTaskActivityEvents(now);
}

function startDebugSessionClock(session, progress) {
  debugSessionClockSnapshot = {session, progress};
  updateDebugSessionClock();
  if (isTerminalCaptureTaskView(progress, session)) {
    if (debugSessionClockTimer) {
      clearInterval(debugSessionClockTimer);
      debugSessionClockTimer = null;
    }
    return;
  }
  if (debugSessionClockTimer) return;
  debugSessionClockTimer = setInterval(updateDebugSessionClock, 1000);
}

function stopDebugSessionClock() {
  if (debugSessionClockTimer) {
    clearInterval(debugSessionClockTimer);
    debugSessionClockTimer = null;
  }
  debugSessionClockSnapshot = null;
}

async function setCaptureTaskPanelMinimized(minimized) {
  debugSessionPanelMinimized = Boolean(minimized);
  renderCaptureDebugSession(getCurrentRuntime() || {});
  const session = getCurrentRuntime()?.captureDebugSession;
  const taskId = String(session?.taskId || session?.runId || "").trim();
  if (!taskId) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:set-capture-task-minimized",
      taskId,
      minimized: Boolean(minimized),
    });
    if (response?.ok === false) {
      throw new Error(response?.error?.message || "更新任务状态页失败");
    }
  } catch (error) {
    console.warn("[Sidebar] Persist task surface visibility failed:", error);
  }
}

function renderCaptureTaskWorkers(progress = {}) {
  const panel = document.getElementById("debugSessionWorkers");
  const modeLabel = document.getElementById("debugSessionWorkerMode");
  if (!panel) return;
  const workerStates = Array.isArray(progress?.workerStates)
    ? progress.workerStates.slice(0, 2)
    : [];
  panel.hidden = workerStates.length === 0;
  if (workerStates.length === 0) return;

  if (modeLabel) {
    modeLabel.textContent =
      progress?.workerMode === "double_buffer" && workerStates.length > 1
        ? "双页面加速"
        : "单页面采集";
  }

  const current = Math.max(0, Number(progress?.itemCurrent) || 0);
  const total = Math.max(0, Number(progress?.itemTotal) || 0);
  panel.querySelectorAll("[data-worker-index]").forEach((row) => {
    const index = Number(row.getAttribute("data-worker-index"));
    const worker = workerStates[index];
    row.hidden = !worker;
    if (!worker) return;
    const state = String(worker.state || "idle").trim().toLowerCase();
    const safeState = [
      "idle",
      "queued",
      "loading",
      "ready",
      "collecting",
      "failed",
    ].includes(state)
      ? state
      : "idle";
    row.setAttribute("data-state", safeState);
    const title = row.querySelector(".debug-session-worker-copy strong");
    const detail = row.querySelector(".debug-session-worker-copy small");
    const hasCollectingPeer = workerStates.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        String(candidate?.state || "").trim().toLowerCase() === "collecting",
    );
    if (title) title.textContent = worker.label || `工作页 ${index + 1}`;
    if (detail) {
      const statusText = {
        idle: "等待下一条",
        queued:
          worker.mode === "prefetch" ? "已排队，等待安全导航间隔" : "准备打开当前详情",
        loading:
          worker.mode === "prefetch" ? "正在预加载下一条" : "正在打开当前详情",
        ready: hasCollectingPeer
          ? "下一条已加载，等待当前条完成"
          : "下一条已加载，等待安全切换",
        collecting:
          total > 0
            ? `正在读取第 ${Math.min(current, total)}/${total} 条`
            : "正在读取作品详情",
        failed: "页面加载失败，任务正在停止",
      }[safeState];
      detail.textContent = statusText;
    }
    row.setAttribute(
      "aria-label",
      `${worker.label || `工作页 ${index + 1}`}：${detail?.textContent || "等待任务"}`,
    );
  });
}

function buildUnattendedSyntheticDebugSession(
  runtime = {},
  plan = buildKeywordRunDisplayPlan(keywordPlanState),
) {
  const status = String(plan?.lastRunStatus || "").trim().toLowerCase();
  const running = isKeywordPlanRunning(plan);
  const terminal = KEYWORD_PLAN_TERMINAL_STATUSES.has(status);
  const terminalRunAt = String(plan?.lastRunAt || "").trim();
  const terminalSummaryId =
    terminalRunAt ||
    String(plan?.lastRunProgress?.updatedAt || "").trim() ||
    `${status}:${String(plan?.lastRunMessage || "").trim()}`;
  // 终态摘要不能依赖一个很短的时间窗。原生 Debug 的释放本身可能超过
  // 20 秒，旧逻辑会让用户在摘要第一次可见前就失去整个状态页。
  // 现在由用户显式点击“关闭”后，才按本次终态标识隐藏。
  const visibleTerminal = Boolean(
    terminal &&
      terminalSummaryId &&
      terminalSummaryId !==
        debugSessionDismissedUnattendedTerminalRunAt,
  );
  if (!plan?.enabled || (!running && !visibleTerminal)) {
    return null;
  }
  const platform = String(plan?.platform || getPagePlatform(runtime) || "")
    .trim()
    .toLowerCase();
  if (!supportsPersistentCaptureTaskPlatform(platform)) {
    return null;
  }
  const keywords = Array.isArray(plan?.keywords)
    ? plan.keywords.map((keyword) => String(keyword || "").trim()).filter(Boolean)
    : [];
  const storedProgress =
    plan?.lastRunProgress && typeof plan.lastRunProgress === "object"
      ? plan.lastRunProgress
      : {};
  const storedRequestId = String(
    storedProgress.unattendedRequestId || plan?.lastRunRequestId || "",
  ).trim();
  const captureTaskId =
    String(storedProgress.captureTaskId || "").trim() ||
    (storedRequestId ? `unattended-capture:${storedRequestId}` : "");
  const startedAt = String(storedProgress.runStartedAt || "").trim();
  const finishedAt = visibleTerminal
    ? String(storedProgress.finishedAt || terminalRunAt || "").trim()
    : "";
  const keywordTotal = Math.max(
    0,
    Number(storedProgress.keywordTotal) || keywords.length,
  );
  const sourceTabId = Number(
    storedProgress.runnerTabId ?? runtime?.lastActiveTabId,
  );
  const executionMode =
    String(plan?.executionMode || "").trim() === "one_time"
      ? "one_time"
      : "unattended_plan";
  const taskLabel =
    executionMode === "one_time" ? "一次性采集" : "无人值守采集";
  const message =
    String(
      visibleTerminal
        ? plan?.lastRunMessage || storedProgress.message || ""
        : storedProgress.message || plan?.lastRunMessage || "",
    ).trim() ||
    (visibleTerminal ? `${taskLabel}已结束` : `正在启动${taskLabel}…`);
  const terminalLabel =
    status === "completed"
      ? `${taskLabel}已完成`
      : status === "completed_with_failures"
        ? `${taskLabel}部分完成`
        : status === "canceled"
          ? `${taskLabel}已停止`
          : `${taskLabel}已结束`;
  return {
    synthetic: true,
    unattended: true,
    terminal: visibleTerminal,
    taskId: captureTaskId,
    runId: captureTaskId,
    startedAt,
    finishedAt,
    terminalRunAt: visibleTerminal ? terminalSummaryId : "",
    state: visibleTerminal ? status : "starting",
    platform,
    label: visibleTerminal
      ? terminalLabel
      : `${taskLabel} · ${keywords.length} 个关键词`,
    pageTitle: visibleTerminal
      ? terminalLabel
      : `${taskLabel} · ${keywords.length} 个关键词`,
    pageUrl: String(runtime?.lastPageUrl || ""),
    sourceTabId:
      Number.isSafeInteger(sourceTabId) && sourceTabId > 0
        ? sourceTabId
        : null,
    progress: {
      ...storedProgress,
      current: visibleTerminal
        ? Math.max(
            0,
            Number(storedProgress.keywordCurrent) || keywordTotal,
          )
        : Math.max(0, Number(storedProgress.current) || 0),
      total: visibleTerminal
        ? keywordTotal
        : Math.max(0, Number(storedProgress.total) || keywordTotal),
      phase: visibleTerminal
        ? `unattended_${status}`
        : String(storedProgress.phase || "initializing_unattended"),
      finishedAt,
      itemCurrent: visibleTerminal ? null : storedProgress.itemCurrent,
      itemTotal: visibleTerminal ? null : storedProgress.itemTotal,
      nextKeyword: visibleTerminal ? "" : storedProgress.nextKeyword,
      progressPercent: visibleTerminal ? 100 : storedProgress.progressPercent,
      message,
      executionMode,
    },
  };
}

function buildTargetedPostSyntheticDebugSession(
  runtime = {},
  request = targetedPostRunState,
) {
  const queryRequestId = getTargetedPostRunRequestIdFromUrl();
  const sharedRequestId = String(request?.id || "").trim();
  const requestId = queryRequestId || sharedRequestId;
  if (
    !requestId ||
    !request ||
    typeof request !== "object" ||
    !sharedRequestId ||
    (queryRequestId && sharedRequestId !== queryRequestId)
  ) {
    return null;
  }
  const status = String(request.status || "pending").trim().toLowerCase();
  const terminal = Boolean(
    cloudTargetedPostApi?.isTerminalRunStatus?.(status),
  );
  const terminalSummaryId =
    String(request.finishedAt || request.updatedAt || "").trim() ||
    `${requestId}:${status}:${String(request.message || "").trim()}`;
  if (
    terminal &&
    terminalSummaryId === debugSessionDismissedTargetedTerminalRunAt
  ) {
    return null;
  }

  const targets = Array.isArray(request.targets) ? request.targets : [];
  const targetResults = Array.isArray(request.targetResults)
    ? request.targetResults
    : [];
  const storedProgress =
    request.progress && typeof request.progress === "object"
      ? request.progress
      : {};
  const checkpoint =
    request.checkpoint && typeof request.checkpoint === "object"
      ? request.checkpoint
      : {};
  const workflow = String(
    request.workflow || "negative_post_patrol",
  ).trim();
  const targetMode = String(request.targetMode || "").trim().toLowerCase();
  const workflowLabel = getTargetedWorkflowLabel(workflow);
  const unavailableResults = targetResults.filter(
    (result) =>
      result?.businessOutcome === "post_unavailable" ||
      result?.availability?.status === "unavailable",
  );
  const completedTargetCount = targetResults.filter((result) =>
    ["completed", "completed_with_warnings"].includes(
      String(result?.status || ""),
    ),
  ).length;
  const failedTargetCount = targetResults.filter(
    (result) => String(result?.status || "") === "failed",
  ).length;
  const deletedTargetCount = unavailableResults.filter(
    (result) =>
      String(
        result?.availabilityStatus ||
          result?.availability?.availabilityStatus ||
          "",
      ) === "deleted",
  ).length;
  const pageUnavailableTargetCount =
    unavailableResults.length - deletedTargetCount;
  const processedCount = Math.max(
    targetResults.length,
    Number(checkpoint.processedCount) || 0,
  );
  const total = Math.max(targets.length, Number(storedProgress.total) || 0);
  const current = terminal
    ? processedCount
    : Math.max(
        1,
        Number(storedProgress.current) ||
          Math.min(processedCount + 1, Math.max(total, 1)),
      );
  const currentTarget =
    targets.find(
      (target) =>
        String(target?.itemId || "") ===
        String(storedProgress.itemId || ""),
    ) ||
    targets[Math.max(0, Math.min(current - 1, targets.length - 1))] ||
    {};
  const sourceTabId = Number(
    storedProgress.targetTabId ??
      activeBatchRunnerTabId ??
      runtime?.lastActiveTabId,
  );
  const message =
    String(request.message || storedProgress.message || "").trim() ||
    (terminal ? `${workflowLabel}已结束` : `正在启动${workflowLabel}`);
  const captureSettings =
    request.captureSettings && typeof request.captureSettings === "object"
      ? request.captureSettings
      : {};

  return {
    synthetic: true,
    targetedPost: true,
    terminal,
    taskId: `targeted-post:${requestId}`,
    runId: `targeted-post:${requestId}`,
    startedAt: String(request.startedAt || request.createdAt || ""),
    finishedAt: terminal ? String(request.finishedAt || "") : "",
    terminalRunAt: terminal ? terminalSummaryId : "",
    state: status,
    platform: String(request.platform || getPagePlatform(runtime) || ""),
    label: workflowLabel,
    pageTitle: currentTarget.title
      ? `${workflowLabel} · ${currentTarget.title}`
      : workflowLabel,
    pageUrl: String(currentTarget.url || runtime?.lastPageUrl || ""),
    sourceTabId:
      Number.isSafeInteger(sourceTabId) && sourceTabId > 0
        ? sourceTabId
        : null,
    progress: {
      ...storedProgress,
      current,
      total,
      itemCurrent: current,
      itemTotal: total,
      progressPercent: terminal
        ? 100
        : total > 0
          ? Math.round((Math.min(processedCount, total) / total) * 100)
          : null,
      phase: terminal
        ? `targeted_${status}`
        : String(storedProgress.phase || "target_initializing"),
      message,
      targetedPost: true,
      workflow,
      targetMode,
      currentTargetTitle: String(
        storedProgress.title || currentTarget.title || "",
      ),
      completedTargetCount,
      unavailableTargetCount: unavailableResults.length,
      deletedTargetCount,
      pageUnavailableTargetCount,
      failedTargetCount,
      runStartedAt: String(
        storedProgress.runStartedAt ||
          request.startedAt ||
          request.createdAt ||
          "",
      ),
      taskMeta: {
        targetedPost: true,
        workflow,
        targetMode,
        commentsEnabled: captureSettings.includeComments === true,
        bloggerMetricsEnabled:
          captureSettings.includeBloggerMetrics === true,
      },
    },
  };
}

function isTargetedProfileDiscoveryWorkflow(workflow = "", targetMode = "") {
  const normalizedWorkflow = String(workflow || "").trim();
  return (
    [
      "followed_creator_post_patrol",
      "official_account_post_discovery",
    ].includes(normalizedWorkflow) ||
    (normalizedWorkflow === "official_account_comment_patrol" &&
      String(targetMode || "").trim().toLowerCase() === "profile")
  );
}

function getTargetedWorkflowLabel(workflow = "") {
  const normalized = String(workflow || "").trim();
  if (normalized === "watched_content_patrol") {
    return "关注内容巡查";
  }
  if (normalized === "official_account_comment_patrol") {
    return "官方账号评论巡查";
  }
  if (normalized === "followed_creator_post_patrol") {
    return "关注博主作品扫描";
  }
  if (normalized === "official_account_post_discovery") {
    return "官方账号作品发现";
  }
  return "负面帖子巡查";
}

function resolveDisplayedUnattendedSessionBinding({
  usingSyntheticSession = false,
  session = null,
  nativeSession = null,
  displayPlan = null,
} = {}) {
  const selectedSession =
    session && typeof session === "object" ? session : {};
  if (usingSyntheticSession) {
    const syntheticTaskId = String(
      selectedSession.taskId || selectedSession.runId || "",
    ).trim();
    const syntheticTaskRequestId = syntheticTaskId.startsWith(
      "unattended-capture:",
    )
      ? syntheticTaskId.slice("unattended-capture:".length)
      : "";
    return {
      unattended: true,
      requestId: String(
        selectedSession.progress?.unattendedRequestId ||
          syntheticTaskRequestId ||
          displayPlan?.lastRunRequestId ||
          "",
      ).trim(),
    };
  }

  const selectedNative =
    nativeSession && typeof nativeSession === "object"
      ? nativeSession
      : selectedSession;
  const nativeTaskId = String(
    selectedNative.taskId || selectedNative.runId || "",
  ).trim();
  const nativeTaskRequestId = nativeTaskId.startsWith("unattended-capture:")
    ? nativeTaskId.slice("unattended-capture:".length)
    : "";
  const nativeProgressRequestId = String(
    selectedNative.progress?.unattendedRequestId || "",
  ).trim();
  return {
    unattended: Boolean(nativeTaskRequestId || nativeProgressRequestId),
    // The native task identity is authoritative. A newer active cloud request
    // may already be visible in displayPlan while this older Debug session is
    // still detaching, and must never become the target of this panel's Stop.
    requestId: nativeTaskRequestId || nativeProgressRequestId,
  };
}

function renderCaptureDebugSession(runtime = {}) {
  const panel = document.getElementById("debugSessionPanel");
  const dock = document.getElementById("debugSessionDock");
  if (!panel) return;
  const nativeSession = runtime?.captureDebugSession;
  const nativeSessionTabId = Number(
    nativeSession?.sourceTabId ?? nativeSession?.tabId,
  );
  const nativeActive =
    nativeSession?.state === "attached" &&
    Number.isSafeInteger(nativeSessionTabId) &&
    nativeSessionTabId > 0;
  const displayPlan = buildKeywordRunDisplayPlan(keywordPlanState);
  const planStatus = String(
    displayPlan?.lastRunStatus || "",
  ).trim().toLowerCase();
  const planTerminalSummaryId =
    String(displayPlan?.lastRunAt || "").trim() ||
    String(displayPlan?.lastRunProgress?.updatedAt || "").trim() ||
    `${planStatus}:${String(displayPlan?.lastRunMessage || "").trim()}`;
  const dismissedUnattendedNative = Boolean(
    nativeActive &&
      KEYWORD_PLAN_TERMINAL_STATUSES.has(planStatus) &&
      planTerminalSummaryId &&
      planTerminalSummaryId ===
        debugSessionDismissedUnattendedTerminalRunAt &&
      String(nativeSession?.taskId || "").startsWith("unattended-capture:"),
  );
  const targetedStatus = String(
    targetedPostRunState?.status || "",
  ).trim().toLowerCase();
  const targetedTerminalSummaryId =
    String(
      targetedPostRunState?.finishedAt ||
        targetedPostRunState?.updatedAt ||
        "",
    ).trim() ||
    `${String(targetedPostRunState?.id || "")}:${targetedStatus}:${String(targetedPostRunState?.message || "").trim()}`;
  const dismissedTargetedNative = Boolean(
    nativeActive &&
      getTargetedPostRunRequestIdFromUrl() &&
      cloudTargetedPostApi?.isTerminalRunStatus?.(targetedStatus) &&
      targetedTerminalSummaryId &&
      targetedTerminalSummaryId ===
        debugSessionDismissedTargetedTerminalRunAt,
  );
  const nativeVisible =
    nativeActive &&
    !dismissedUnattendedNative &&
    !dismissedTargetedNative;
  const targetedSyntheticSession =
    buildTargetedPostSyntheticDebugSession(runtime);
  const unattendedSyntheticSession = buildUnattendedSyntheticDebugSession(
    runtime,
    displayPlan,
  );
  // 计划已经结算时，终态摘要优先于仍处于异步 detach/清理中的 native
  // Debug。运行态仍由 native 数据覆盖合成启动态。
  const usingTargetedSyntheticSession = Boolean(targetedSyntheticSession);
  const usingUnattendedSyntheticSession = Boolean(
    !usingTargetedSyntheticSession &&
      unattendedSyntheticSession &&
      (!nativeVisible || unattendedSyntheticSession.terminal),
  );
  const usingSyntheticSession =
    usingTargetedSyntheticSession || usingUnattendedSyntheticSession;
  const session = usingTargetedSyntheticSession
    ? targetedSyntheticSession
    : usingUnattendedSyntheticSession
      ? unattendedSyntheticSession
      : nativeSession;
  const sessionTabId = Number(session?.sourceTabId ?? session?.tabId);
  const active =
    nativeVisible ||
    Boolean(targetedSyntheticSession) ||
    Boolean(unattendedSyntheticSession);
  if (!active) debugSessionPanelMinimized = false;
  if (usingSyntheticSession && session?.terminal) {
    debugSessionPanelMinimized = false;
  }
  if (!usingSyntheticSession && typeof session?.minimized === "boolean") {
    debugSessionPanelMinimized = session.minimized;
  }
  panel.hidden = !active || debugSessionPanelMinimized;
  panel.setAttribute(
    "data-minimized",
    String(active && debugSessionPanelMinimized),
  );
  if (dock) {
    dock.hidden = !active || !debugSessionPanelMinimized;
    dock.setAttribute(
      "data-tab-id",
      active && Number.isSafeInteger(sessionTabId) && sessionTabId > 0
        ? String(sessionTabId)
        : "",
    );
  }
  if (!active) {
    stopDebugSessionClock();
    debugSessionActivityTaskId = "";
    debugSessionActivityEvents = [];
    debugSessionLastActivitySignature = "";
    debugSessionTerminalizedActivityId = "";
    panel.removeAttribute("data-run-id");
    panel.removeAttribute("data-task-id");
    panel.removeAttribute("data-tab-id");
    panel.removeAttribute("data-active-step");
    panel.removeAttribute("data-session-source");
    panel.removeAttribute("data-targeted-post");
    panel.removeAttribute("data-targeted-post-request-id");
    panel.removeAttribute("data-unattended");
    panel.removeAttribute("data-unattended-request-id");
    panel.removeAttribute("data-terminal");
    panel.removeAttribute("data-terminal-run-at");
    return;
  }
  panel.setAttribute("data-run-id", String(session.runId || ""));
  panel.setAttribute("data-task-id", String(session.taskId || session.runId || ""));
  panel.setAttribute(
    "data-tab-id",
    Number.isSafeInteger(sessionTabId) && sessionTabId > 0
      ? String(sessionTabId)
      : "",
  );
  panel.setAttribute(
    "data-session-source",
    usingTargetedSyntheticSession
      ? "targeted-post-synthetic"
      : usingUnattendedSyntheticSession
        ? "unattended-synthetic"
        : "native-debug",
  );
  const unattendedBinding = resolveDisplayedUnattendedSessionBinding({
    usingSyntheticSession: usingUnattendedSyntheticSession,
    session,
    nativeSession,
    displayPlan,
  });
  panel.setAttribute(
    "data-targeted-post",
    String(usingTargetedSyntheticSession),
  );
  panel.setAttribute(
    "data-targeted-post-request-id",
    usingTargetedSyntheticSession
      ? String(targetedPostRunState?.id || "")
      : "",
  );
  panel.setAttribute(
    "data-unattended",
    String(unattendedBinding.unattended),
  );
  panel.setAttribute(
    "data-unattended-request-id",
    unattendedBinding.requestId,
  );
  panel.setAttribute("data-terminal", String(Boolean(session?.terminal)));
  panel.setAttribute(
    "data-terminal-run-at",
    session?.terminal ? String(session?.terminalRunAt || "") : "",
  );
  const stopButton = document.getElementById("btnDebugSessionStop");
  const minimizeButton = document.getElementById("btnDebugSessionMinimize");
  if (stopButton) {
    stopButton.hidden = Boolean(session?.terminal);
    stopButton.style.display = session?.terminal ? "none" : "";
    stopButton.disabled = Boolean(session?.terminal);
  }
  if (minimizeButton) {
    minimizeButton.textContent = session?.terminal ? "关闭" : "隐藏";
  }

  const platform = String(
    session.platform || detectPlatformFromUrl(session.pageUrl || runtime.lastPageUrl || ""),
  ).trim() || "xiaohongshu";
  const sessionProgress =
    session?.progress && typeof session.progress === "object"
      ? session.progress
      : {};
  const runtimeProgress =
    runtime?.lastCaptureProgress &&
    typeof runtime.lastCaptureProgress === "object"
      ? runtime.lastCaptureProgress
      : {};
  const activeListRunId = String(session?.activeListRunId || "").trim();
  const runtimeListRunId = String(runtimeProgress.listCaptureRunId || "").trim();
  const sessionProgressAt = parseCaptureTaskTime(sessionProgress.updatedAt);
  const runtimeProgressAt = parseCaptureTaskTime(runtimeProgress.updatedAt);
  const canUseLiveListProgress = Boolean(
    activeListRunId &&
      runtimeListRunId === activeListRunId &&
      runtimeProgressAt > sessionProgressAt,
  );
  // Content keeps reporting scrolling/marked counts while the debug session is
  // waiting for the relay response. Merge only the exact active list run and
  // only when it is newer, so stale progress from a previous keyword cannot
  // overwrite the current task.
  const progress = projectCaptureTaskProgress(
    canUseLiveListProgress
      ? {...sessionProgress, ...runtimeProgress}
      : Object.keys(sessionProgress).length > 0
        ? sessionProgress
        : runtimeProgress,
  );
  const logo = document.getElementById("debugSessionLogo");
  if (logo) {
    logo.className = `debug-session-logo platform-logo ${getPlatformLogoClass(platform)}`;
    logo.innerHTML = getPlatformLogoInnerMarkup(platform);
  }
  const title = document.getElementById("debugSessionPageTitle");
  const url = document.getElementById("debugSessionPageUrl");
  const currentKeyword = String(progress?.keyword || "").trim();
  const platformLabel =
    PLATFORM_SEARCH_FILTER_OPTIONS[platform]?.platformLabel ||
    (platform === "douyin" ? "抖音" : "小红书");
  if (title) {
    title.textContent = currentKeyword
      ? `${currentKeyword} · ${platformLabel}采集`
      : String(session.pageTitle || session.label || "当前采集页面");
  }
  if (url) url.textContent = String(session.pageUrl || runtime.lastPageUrl || "");

  const markedCount = Math.max(
    0,
    Number(progress.markedCount ?? progress.filteredCount) || 0,
  );
  const activeStep = resolveCaptureTaskStep(progress);
  const percent = resolveCaptureTaskPercent(progress);
  const actionCopy = resolveCaptureTaskActionCopy(progress);
  const taskId = String(session.taskId || session.runId || "").trim();
  recordCaptureTaskActivity(taskId, progress, actionCopy);
  finalizeCaptureTaskActivityEvents(taskId, progress, session);
  panel.setAttribute("data-active-step", String(activeStep));

  const progressTrack = panel.querySelector(".debug-session-progress-track");
  const progressBar = document.getElementById("debugSessionProgressBar");
  const progressPercent = document.getElementById("debugSessionProgressPercent");
  const currentMessage = document.getElementById("debugSessionCurrentMessage");
  const actionExplanation = document.getElementById(
    "debugSessionActionExplanation",
  );
  const nextAction = document.getElementById("debugSessionNextAction");
  const stats = document.getElementById("debugSessionStats");
  const message = actionCopy.title;
  if (progressTrack) {
    progressTrack.classList.toggle("is-indeterminate", percent === null);
    if (percent === null) {
      progressTrack.removeAttribute("aria-valuenow");
      progressTrack.setAttribute("aria-valuetext", message || "任务进行中");
    } else {
      progressTrack.setAttribute("aria-valuenow", String(percent));
      progressTrack.setAttribute("aria-valuetext", `${percent}%`);
    }
  }
  if (progressBar) {
    progressBar.style.width = percent === null ? "" : `${percent}%`;
  }
  if (progressPercent) {
    progressPercent.hidden = percent === null;
    progressPercent.textContent = percent === null ? "—" : `${percent}%`;
  }
  if (currentMessage) currentMessage.textContent = message;
  if (actionExplanation) {
    actionExplanation.textContent = actionCopy.explanation;
  }
  if (nextAction) nextAction.textContent = actionCopy.nextAction;
  if (stats) {
    const statsText = buildCaptureTaskStats(progress);
    stats.textContent = statsText;
    stats.hidden = !statsText;
  }

  const scopeLabel = document.querySelector(".debug-session-scope-label");
  const keywordEl = document.getElementById("debugSessionKeyword");
  const scopeMeta = document.getElementById("debugSessionScopeMeta");
  if (scopeLabel) {
    const profileDiscovery =
      progress?.targetedPost === true &&
      isTargetedProfileDiscoveryWorkflow(
        progress?.workflow,
        progress?.targetMode || progress?.taskMeta?.targetMode,
      );
    scopeLabel.textContent =
      progress?.targetedPost === true
        ? profileDiscovery
          ? "当前账号"
          : "当前帖子"
        : currentKeyword
          ? "当前关键词"
          : "当前任务";
  }
  if (keywordEl) {
    keywordEl.textContent =
      currentKeyword ||
      String(
        progress?.targetedPost === true
          ? progress?.currentTargetTitle || session.label
          : session.label || "正在准备采集任务",
      );
  }
  if (scopeMeta) {
    scopeMeta.replaceChildren();
    buildCaptureTaskScopeMeta(progress).forEach((part) => {
      const item = document.createElement("span");
      item.textContent = part;
      scopeMeta.appendChild(item);
    });
  }

  const waitReason = document.getElementById("debugSessionWaitReason");
  const waitNext = document.getElementById("debugSessionWaitNext");
  const waitPhase = String(progress?.phase || "").trim().toLowerCase();
  if (waitReason) {
    waitReason.textContent =
      waitPhase === "waiting_next_round"
        ? "轮次间隔"
        : waitPhase === "keyword_retry_wait"
          ? "自动重试等待"
          : waitPhase === "scheduled-waiting"
            ? "等待计划开始"
            : waitPhase === "detail_item_delay"
              ? "下一条安全间隔"
              : "防风控随机间隔";
  }
  if (waitNext) waitNext.textContent = actionCopy.nextAction;

  const meta = document.getElementById("debugSessionMeta");
  const metaChips = document.getElementById("debugSessionMetaChips");
  const chips = buildCaptureTaskMetaChips(progress, platform);
  if (meta) meta.hidden = chips.length === 0;
  if (metaChips) {
    metaChips.replaceChildren();
    chips.forEach((chip) => {
      const item = document.createElement("span");
      item.className = "debug-session-meta-chip";
      item.textContent = chip;
      metaChips.appendChild(item);
    });
  }

  const recentMessage = document.getElementById("debugSessionRecentMessage");
  if (recentMessage) {
    recentMessage.textContent =
      debugSessionActivityEvents[0]?.message || actionCopy.title;
  }
  startDebugSessionClock(session, progress);
  renderCaptureTaskWorkers(progress);

  const numberingLabel = document.getElementById("debugSessionNumberingLabel");
  if (numberingLabel) {
    const profileDiscovery =
      progress?.targetedPost === true &&
      isTargetedProfileDiscoveryWorkflow(
        progress?.workflow,
        progress?.targetMode || progress?.taskMeta?.targetMode,
      );
    numberingLabel.textContent =
      progress?.targetedPost === true
        ? profileDiscovery
          ? "记录账号扫描结果"
          : "记录帖子巡查结果"
        : markedCount > 0
          ? `正在标记采集结果 · ${markedCount} 条`
          : "正在标记采集结果";
  }
  const detailLabel = document.getElementById("debugSessionDetailLabel");
  if (detailLabel) {
    const current = Math.max(0, Number(progress?.itemCurrent) || 0);
    const total = Math.max(0, Number(progress?.itemTotal) || 0);
    const keyword = String(progress?.keyword || "").trim();
    const keywordLabel = keyword
      ? keyword.length > 14
        ? `${keyword.slice(0, 14)}…`
        : keyword
      : "";
    const profileDiscovery =
      progress?.targetedPost === true &&
      isTargetedProfileDiscoveryWorkflow(
        progress?.workflow,
        progress?.targetMode || progress?.taskMeta?.targetMode,
      );
    const detailStepText =
      progress?.targetedPost === true
        ? profileDiscovery
          ? "扫描当前账号作品"
          : "采集当前帖子详情"
        : keywordLabel
          ? `完善「${keywordLabel}」作品详情`
          : "完善作品详情";
    detailLabel.textContent =
      activeStep === 3 && total > 0
        ? `${detailStepText} · ${Math.min(current, total)}/${total}`
        : detailStepText;
  }
  panel.querySelectorAll("[data-debug-step]").forEach((step) => {
    const index = Number(step.getAttribute("data-debug-step"));
    step.classList.toggle("is-complete", index < activeStep);
    step.classList.toggle("is-active", index === activeStep);
    step.classList.toggle("is-pending", index > activeStep);
  });
}

async function loadTerminalCaptureSummaryAcknowledgements() {
  try {
    const stored = await chrome.storage.local.get(
      TERMINAL_SUMMARY_ACK_STORAGE_KEY,
    );
    const acknowledgements =
      stored?.[TERMINAL_SUMMARY_ACK_STORAGE_KEY] &&
      typeof stored[TERMINAL_SUMMARY_ACK_STORAGE_KEY] === "object"
        ? stored[TERMINAL_SUMMARY_ACK_STORAGE_KEY]
        : {};
    debugSessionDismissedUnattendedTerminalRunAt = String(
      acknowledgements.unattendedTerminalSummaryId || "",
    ).trim();
    debugSessionDismissedTargetedTerminalRunAt = String(
      acknowledgements.targetedTerminalSummaryId || "",
    ).trim();
    return true;
  } catch (error) {
    console.warn("[Sidebar] Load terminal summary acknowledgements failed:", error);
    return false;
  }
}

async function persistTerminalCaptureSummaryAcknowledgements() {
  const acknowledgements = {
    schemaVersion: 1,
    unattendedTerminalSummaryId:
      debugSessionDismissedUnattendedTerminalRunAt,
    targetedTerminalSummaryId:
      debugSessionDismissedTargetedTerminalRunAt,
    updatedAt: new Date().toISOString(),
  };
  try {
    await chrome.storage.local.set({
      [TERMINAL_SUMMARY_ACK_STORAGE_KEY]: acknowledgements,
    });
    return true;
  } catch (error) {
    if (isStorageQuotaError(error)) {
      await releaseControlStorageReserve();
      try {
        await chrome.storage.local.set({
          [TERMINAL_SUMMARY_ACK_STORAGE_KEY]: acknowledgements,
        });
        void ensureControlStorageReserve();
        return true;
      } catch (retryError) {
        console.warn(
          "[Sidebar] Persist terminal acknowledgement after reserve release failed:",
          retryError,
        );
      }
    }
    console.warn(
      "[Sidebar] Persist terminal summary acknowledgements failed:",
      error,
    );
    return false;
  }
}

async function dismissAllTerminalCaptureSummaries() {
  const displayPlan = buildKeywordRunDisplayPlan(keywordPlanState);
  const planStatus = String(
    displayPlan?.lastRunStatus || "",
  ).trim().toLowerCase();
  if (KEYWORD_PLAN_TERMINAL_STATUSES.has(planStatus)) {
    debugSessionDismissedUnattendedTerminalRunAt =
      String(displayPlan?.lastRunAt || "").trim() ||
      String(displayPlan?.lastRunProgress?.updatedAt || "").trim() ||
      `${planStatus}:${String(displayPlan?.lastRunMessage || "").trim()}`;
  }

  const targetedStatus = String(
    targetedPostRunState?.status || "",
  ).trim().toLowerCase();
  if (
    cloudTargetedPostApi?.isTerminalRunStatus?.(targetedStatus)
  ) {
    debugSessionDismissedTargetedTerminalRunAt =
      String(
        targetedPostRunState?.finishedAt ||
          targetedPostRunState?.updatedAt ||
          "",
      ).trim() ||
      `${String(targetedPostRunState?.id || "")}:${targetedStatus}:${String(targetedPostRunState?.message || "").trim()}`;
  }
  return await persistTerminalCaptureSummaryAcknowledgements();
}

function setupDebugSessionPanelControls() {
  if (debugSessionPanelListenersBound) return;
  const minimize = document.getElementById("btnDebugSessionMinimize");
  const dock = document.getElementById("debugSessionDock");
  const focus = document.getElementById("btnDebugSessionFocusTab");
  const stop = document.getElementById("btnDebugSessionStop");
  if (!minimize || !dock || !focus || !stop) return;

  minimize.addEventListener("click", async () => {
    const panel = document.getElementById("debugSessionPanel");
    if (panel?.dataset?.terminal === "true") {
      // 一个页面可能同时保留“一次性/无人值守”和“定向巡查”的终态。
      // 关闭应退出任务状态视图，而不是只隐藏当前一张卡后露出另一张。
      await dismissAllTerminalCaptureSummaries();
      debugSessionPanelMinimized = false;
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return;
    }
    await setCaptureTaskPanelMinimized(true);
  });
  dock.addEventListener("click", async () => {
    await setCaptureTaskPanelMinimized(false);
  });
  focus.addEventListener("click", async () => {
    const session = getCurrentRuntime()?.captureDebugSession;
    const panelTabId = Number(
      document.getElementById("debugSessionPanel")?.dataset?.tabId,
    );
    const workerTabIds = Array.isArray(session?.workerTabIds)
      ? session.workerTabIds
      : [];
    const tabId = Number(
      workerTabIds[workerTabIds.length - 1] ??
        session?.sourceTabId ??
        session?.tabId ??
        panelTabId,
    );
    if (!Number.isSafeInteger(tabId) || tabId <= 0) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, {active: true});
      if (Number.isSafeInteger(Number(tab.windowId))) {
        await chrome.windows.update(Number(tab.windowId), {focused: true});
      }
    } catch (error) {
      showMessage(`无法定位采集页：${error?.message || error}`, "error");
    }
  });
  stop.addEventListener("click", async () => {
    if (stop.disabled) return;
    if (
      document.getElementById("debugSessionPanel")?.dataset?.terminal === "true"
    ) {
      stop.hidden = true;
      stop.style.display = "none";
      return;
    }
    stop.disabled = true;
    stop.textContent = "正在停止…";
    try {
      const panel = document.getElementById("debugSessionPanel");
      if (panel?.dataset?.targetedPost === "true") {
        await cancelTargetedPostRunFromSidebar(
          panel?.dataset?.targetedPostRequestId || "",
        );
        return;
      }
      const stoppingUnattended =
        panel?.dataset?.unattended === "true" ||
        isKeywordPlanRunning(buildKeywordRunDisplayPlan(keywordPlanState));
      if (stoppingUnattended) {
        await cancelUnattendedKeywordPlanFromSidebar(
          panel?.dataset?.unattendedRequestId || "",
        );
      } else {
        await handleCancel();
      }
    } finally {
      setTimeout(() => {
        stop.disabled = false;
        stop.textContent = "停止";
      }, 1200);
    }
  });
  debugSessionPanelListenersBound = true;
}

function setupAuthCodeInputListeners() {
  updateAuthCodeVisibilityButton();

  const btnCodeVisibility = document.getElementById("btnCodeVisibility");
  if (btnCodeVisibility) {
    btnCodeVisibility.addEventListener("click", handleToggleCodeVisibility);
  }

  const inputCode = document.getElementById("inputCode");
  if (!inputCode) return;

  inputCode.addEventListener("input", () => {
    scheduleAuthCodeAutoEncrypt();
  });

  inputCode.addEventListener("blur", () => {
    scheduleAuthCodeAutoEncrypt({immediate: true});
  });
}

function handleToggleCodeVisibility() {
  authCodeViewMode =
    authCodeViewMode === AUTH_CODE_VIEW_MODE.ENCRYPTED
      ? AUTH_CODE_VIEW_MODE.PLAINTEXT
      : AUTH_CODE_VIEW_MODE.ENCRYPTED;
  updateAuthCodeVisibilityButton();
  void renderAuthCodeInput(getCurrentAuth());
}

function updateAuthCodeVisibilityButton() {
  const btn = document.getElementById("btnCodeVisibility");
  const input = document.getElementById("inputCode");
  const encryptedView = authCodeViewMode === AUTH_CODE_VIEW_MODE.ENCRYPTED;

  if (input) {
    input.type = encryptedView ? "password" : "text";
  }

  if (!btn) return;

  if (encryptedView) {
    btn.innerHTML = EYE_OFF_ICON;
    btn.setAttribute("aria-label", "显示明文");
    btn.setAttribute("title", "显示明文");
  } else {
    btn.innerHTML = EYE_ICON;
    btn.setAttribute("aria-label", "切换到密文");
    btn.setAttribute("title", "切换到密文");
  }
}

function getContactModalElements() {
  const overlay = document.getElementById("contactModal");
  const card = overlay?.querySelector(".contact-modal-card");
  const btnClose = document.getElementById("btnContactModalClose");

  if (!overlay || !card || !btnClose) {
    return null;
  }

  return {
    overlay,
    card,
    btnClose,
  };
}

function normalizeMemberGroupPromptCode(value) {
  return String(value || "").trim();
}

async function getMemberGroupPromptState() {
  try {
    const stored = await chrome.storage.local.get(
      MEMBER_GROUP_PROMPT_STATE_KEY,
    );
    const state = stored?.[MEMBER_GROUP_PROMPT_STATE_KEY];
    return state && typeof state === "object" ? state : {};
  } catch (error) {
    console.warn("[Sidebar] Failed to load member group prompt state:", error);
    return {};
  }
}

async function saveMemberGroupPromptState(state) {
  await chrome.storage.local.set({
    [MEMBER_GROUP_PROMPT_STATE_KEY]: state,
  });
}

async function hasAcknowledgedMemberGroupPrompt(auth = getCurrentAuth()) {
  const authCode = normalizeMemberGroupPromptCode(auth?.code);
  if (!authCode) {
    return false;
  }

  const state = await getMemberGroupPromptState();
  return normalizeMemberGroupPromptCode(state?.acknowledgedCode) === authCode;
}

async function updateMemberGroupEntryVisibility(auth = getCurrentAuth()) {
  const entry = document.getElementById("btnMemberGroupEntry");
  if (!entry) {
    return;
  }

  // The group QR prompt is no longer part of the activation success flow.
  // Keep this entry hidden so activation finishes as a clean success notice.
  entry.hidden = true;
}

function getMemberGroupModalElements() {
  const overlay = document.getElementById("memberGroupModal");
  const card = overlay?.querySelector(".member-group-modal-card");
  const checkbox = document.getElementById("checkboxMemberGroupAdded");
  const btnLater = document.getElementById("btnMemberGroupLater");
  const btnConfirm = document.getElementById("btnMemberGroupConfirm");

  if (!overlay || !card || !checkbox || !btnLater || !btnConfirm) {
    return null;
  }

  return {
    overlay,
    card,
    checkbox,
    btnLater,
    btnConfirm,
  };
}

function openMemberGroupModal() {
  const elements = getMemberGroupModalElements();
  if (!elements) {
    console.error("[Sidebar] Member group modal elements not found");
    return;
  }

  const {overlay, checkbox, btnConfirm} = elements;
  checkbox.checked = false;
  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");
  btnConfirm.focus();
}

function closeMemberGroupModal() {
  const elements = getMemberGroupModalElements();
  if (!elements) {
    return;
  }

  const {overlay, checkbox} = elements;
  checkbox.checked = false;
  overlay.classList.remove("is-active");
  overlay.setAttribute("aria-hidden", "true");
}

async function handleConfirmMemberGroupAdded() {
  const elements = getMemberGroupModalElements();
  if (!elements) {
    return;
  }

  const {checkbox} = elements;
  if (!checkbox.checked) {
    showMessage("勾选“我已添加”后，这个提醒才会收起", "info");
    return;
  }

  const auth = getCurrentAuth() || {};
  const authCode = normalizeMemberGroupPromptCode(auth.code);
  if (!authCode) {
    closeMemberGroupModal();
    return;
  }

  await saveMemberGroupPromptState({
    acknowledgedCode: authCode,
    acknowledgedAt: new Date().toISOString(),
  });
  closeMemberGroupModal();
  await updateMemberGroupEntryVisibility(auth);
  showMessage("已收起交流群提醒入口", "success");
}

async function maybeOpenMemberGroupModalAfterVerify(auth = getCurrentAuth()) {
  if (!isAuthVerified(auth)) {
    return;
  }

  const authCode = normalizeMemberGroupPromptCode(auth?.code);
  if (authCode && !(await hasAcknowledgedMemberGroupPrompt(auth))) {
    await saveMemberGroupPromptState({
      acknowledgedCode: authCode,
      acknowledgedAt: new Date().toISOString(),
      suppressed: true,
    });
  }

  await updateMemberGroupEntryVisibility(auth);
  closeMemberGroupModal();
}

function setupMemberGroupModalListeners() {
  if (memberGroupModalListenersBound) {
    return;
  }

  const entry = document.getElementById("btnMemberGroupEntry");
  if (entry) {
    entry.addEventListener("click", () => {
      openMemberGroupModal();
    });
  }

  const elements = getMemberGroupModalElements();
  if (!elements) {
    return;
  }

  const {overlay, btnLater, btnConfirm} = elements;
  btnLater.addEventListener("click", () => {
    closeMemberGroupModal();
  });
  btnConfirm.addEventListener("click", () => {
    void handleConfirmMemberGroupAdded();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeMemberGroupModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !overlay.classList.contains("is-active")) {
      return;
    }
    event.preventDefault();
    closeMemberGroupModal();
  });

  memberGroupModalListenersBound = true;
}

function openContactModal() {
  const elements = getContactModalElements();
  if (!elements) {
    console.error("[Sidebar] Contact modal elements not found");
    showMessage("无法打开联系我们窗口，请刷新后重试", "error");
    return;
  }

  const {overlay, btnClose} = elements;
  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");
  btnClose.focus();
}

function closeContactModal() {
  const elements = getContactModalElements();
  if (!elements) {
    return;
  }

  const {overlay} = elements;
  overlay.classList.remove("is-active");
  overlay.setAttribute("aria-hidden", "true");
}

function setupContactModalListeners() {
  if (contactModalListenersBound) {
    return;
  }

  const elements = getContactModalElements();
  if (!elements) {
    return;
  }

  const {overlay, btnClose} = elements;

  btnClose.addEventListener("click", () => {
    closeContactModal();
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeContactModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !overlay.classList.contains("is-active")) {
      return;
    }
    event.preventDefault();
    closeContactModal();
  });

  // 二维码图加载失败时隐藏整个二维码框。原来用内联 onerror= 会违反扩展 CSP(script-src 'self')
  // 被拦下并刷错,改成 JS 绑定既消错又能真正生效。
  const qrImage = overlay.querySelector(".contact-qr-image");
  if (qrImage) {
    qrImage.addEventListener("error", () => {
      const frame = qrImage.closest(".contact-qr-frame");
      if (frame) frame.style.display = "none";
    });
  }

  contactModalListenersBound = true;
}

function getRiskModalElements() {
  const overlay = document.getElementById("riskNoticeModal");
  const card = overlay?.querySelector(".risk-modal-card");
  const btnClose = document.getElementById("btnRiskModalClose");

  if (!overlay || !card || !btnClose) {
    return null;
  }

  return {
    overlay,
    card,
    btnClose,
  };
}

function openRiskModal() {
  const elements = getRiskModalElements();
  if (!elements) {
    console.error("[Sidebar] Risk modal elements not found");
    showMessage("无法打开风险提示，请刷新后重试", "error");
    return;
  }

  const {overlay, btnClose} = elements;
  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");
  btnClose.focus();
}

function closeRiskModal() {
  const elements = getRiskModalElements();
  if (!elements) {
    return;
  }

  const {overlay, btnClose} = elements;
  overlay.classList.remove("is-active");
  overlay.setAttribute("aria-hidden", "true");

  if (riskNoticeForceOpen) {
    riskNoticeForceOpen = false;
    markRiskNoticeAcknowledged();
    const checkboxLabel = document.getElementById("riskNoticeCheckboxLabel");
    if (checkboxLabel) checkboxLabel.hidden = true;
  }
  btnClose.textContent = "关闭";
  btnClose.disabled = false;
}

function setupRiskModalListeners() {
  if (riskModalListenersBound) {
    return;
  }

  const elements = getRiskModalElements();
  if (!elements) {
    return;
  }

  const {overlay, btnClose} = elements;

  btnClose.addEventListener("click", () => {
    closeRiskModal();
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !riskNoticeForceOpen) {
      closeRiskModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !overlay.classList.contains("is-active")) {
      return;
    }
    if (riskNoticeForceOpen) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeRiskModal();
  });

  riskModalListenersBound = true;
}

async function hasAcknowledgedRiskNotice() {
  try {
    const stored = await chrome.storage.local.get(RISK_NOTICE_ACKNOWLEDGED_KEY);
    return Boolean(stored?.[RISK_NOTICE_ACKNOWLEDGED_KEY]);
  } catch (error) {
    console.warn("[Sidebar] Failed to read risk notice state:", error);
    return false;
  }
}

async function markRiskNoticeAcknowledged() {
  try {
    await chrome.storage.local.set({[RISK_NOTICE_ACKNOWLEDGED_KEY]: true});
  } catch (error) {
    console.warn("[Sidebar] Failed to save risk notice state:", error);
  }
}

let riskNoticeForceOpen = false;

async function showRiskNoticeIfNeeded() {
  const acknowledged = await hasAcknowledgedRiskNotice();
  if (acknowledged) {
    return;
  }

  const elements = getRiskModalElements();
  if (!elements) {
    return;
  }

  const {btnClose} = elements;
  const checkboxLabel = document.getElementById("riskNoticeCheckboxLabel");
  const checkbox = document.getElementById("riskNoticeCheckbox");

  btnClose.textContent = "我已知晓";
  btnClose.disabled = true;
  if (checkboxLabel) checkboxLabel.hidden = false;
  if (checkbox) {
    checkbox.checked = false;
    checkbox.addEventListener("change", () => {
      btnClose.disabled = !checkbox.checked;
    });
  }
  riskNoticeForceOpen = true;

  openRiskModal();
}

function parseVersionString(version) {
  return String(version || "")
    .trim()
    .split(".")
    .map((segment) => Number.parseInt(segment, 10))
    .map((value) => (Number.isFinite(value) && value >= 0 ? value : 0));
}

function compareVersion(left, right) {
  const leftParts = parseVersionString(left);
  const rightParts = parseVersionString(right);
  const maxLength = Math.max(leftParts.length, rightParts.length, 3);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

function getLocalExtensionVersion() {
  return String(chrome.runtime.getManifest()?.version || "").trim();
}

async function getExtensionInstallType() {
  try {
    if (!chrome.management?.getSelf) {
      return EXTENSION_INSTALL_TYPE.OTHER;
    }

    const info = await chrome.management.getSelf();
    const installType = String(info?.installType || "")
      .trim()
      .toLowerCase();
    if (
      installType === EXTENSION_INSTALL_TYPE.NORMAL ||
      installType === EXTENSION_INSTALL_TYPE.DEVELOPMENT ||
      installType === EXTENSION_INSTALL_TYPE.SIDELOAD ||
      installType === EXTENSION_INSTALL_TYPE.ADMIN
    ) {
      return installType;
    }
  } catch (error) {
    console.warn("[Sidebar] Failed to read install type:", error);
  }

  return EXTENSION_INSTALL_TYPE.OTHER;
}

async function readUpdateModalState() {
  try {
    const stored = await chrome.storage.local.get(
      EXTENSION_UPDATE_MODAL_STATE_KEY,
    );
    const value = stored?.[EXTENSION_UPDATE_MODAL_STATE_KEY];
    if (!value || typeof value !== "object") {
      return {
        dismissedVersion: "",
        skipExtensionUpdateGuide: false,
      };
    }
    return {
      dismissedVersion: String(value.dismissedVersion || "").trim(),
      skipExtensionUpdateGuide: Boolean(value.skipExtensionUpdateGuide),
    };
  } catch (error) {
    console.warn("[Sidebar] Failed to read update modal state:", error);
    return {
      dismissedVersion: "",
      skipExtensionUpdateGuide: false,
    };
  }
}

async function writeUpdateModalState(nextState = {}) {
  try {
    const currentState = await readUpdateModalState();
    const mergedState = {
      ...currentState,
      ...nextState,
    };
    await chrome.storage.local.set({
      [EXTENSION_UPDATE_MODAL_STATE_KEY]: {
        dismissedVersion: String(mergedState.dismissedVersion || "").trim(),
        skipExtensionUpdateGuide: Boolean(mergedState.skipExtensionUpdateGuide),
      },
    });
  } catch (error) {
    console.warn("[Sidebar] Failed to save update modal state:", error);
  }
}

function normalizeUpdateManifestResult(result) {
  const rawManifest =
    result?.data?.updateManifest &&
    typeof result.data.updateManifest === "object"
      ? result.data.updateManifest
      : {};

  const latestVersion = String(rawManifest.latestVersion || "").trim();
  const minSupportedVersion = String(
    rawManifest.minSupportedVersion || "",
  ).trim();
  const downloadUrl =
    String(rawManifest.downloadUrl || "").trim() || DEFAULT_UPDATE_DOWNLOAD_URL;
  const changelogUrl =
    String(rawManifest.changelogUrl || "").trim() ||
    DEFAULT_UPDATE_CHANGELOG_URL;
  const releases = normalizeReleaseEntries(rawManifest);
  const latestRelease =
    releases.find((release) => release.version === latestVersion) ||
    releases[0] ||
    null;
  const releaseDate = String(latestRelease?.releaseDate || "").trim();

  return {
    latestVersion,
    minSupportedVersion,
    downloadUrl,
    changelogUrl,
    releaseDate,
    releases,
  };
}

function normalizeReleaseNoteTag(tag) {
  const normalized = String(tag || "").trim();
  if (normalized === "新增") return "新增";
  if (normalized === "修复") return "修复";
  if (normalized === "优化") return "优化";
  return "其他";
}

function getReleaseGroupTagClass(tag) {
  const normalized = normalizeReleaseNoteTag(tag);
  if (normalized === "新增") return "update-group-tag is-add";
  if (normalized === "优化") return "update-group-tag is-opt";
  if (normalized === "修复") return "update-group-tag is-fix";
  return "update-group-tag";
}

function normalizeReleaseNoteGroups(rawReleaseNotes) {
  if (!Array.isArray(rawReleaseNotes)) {
    return [];
  }

  const hasGroupedShape = rawReleaseNotes.some((item) => {
    if (!item || typeof item !== "object") return false;
    return Array.isArray(item.notes) || Array.isArray(item.items);
  });

  if (hasGroupedShape) {
    return rawReleaseNotes
      .map((group) => {
        if (!group || typeof group !== "object") return null;
        const tag = normalizeReleaseNoteTag(group.tag || "优化");
        const rawNotes = Array.isArray(group.notes)
          ? group.notes
          : Array.isArray(group.items)
            ? group.items
            : [];
        const notes = rawNotes
          .map((note) => {
            const title = String(note?.title || "").trim();
            const desc = String(note?.desc || "").trim();
            if (!title || !desc) return null;
            return {title, desc};
          })
          .filter(Boolean);
        if (notes.length === 0) return null;
        return {tag, notes};
      })
      .filter(Boolean);
  }

  const buckets = new Map();
  rawReleaseNotes.forEach((note) => {
    const title = String(note?.title || "").trim();
    const desc = String(note?.desc || "").trim();
    if (!title || !desc) return;
    const tag = normalizeReleaseNoteTag(note?.tag || "优化");
    if (!buckets.has(tag)) buckets.set(tag, []);
    buckets.get(tag).push({title, desc});
  });

  return Array.from(buckets.entries()).map(([tag, notes]) => ({tag, notes}));
}

function normalizeReleaseEntries(rawManifest) {
  const rawReleases = Array.isArray(rawManifest?.releases)
    ? rawManifest.releases
    : [];

  const normalizedFromReleases = rawReleases
    .map((release) => {
      if (!release || typeof release !== "object") return null;
      const version = String(release.version || "").trim();
      const releaseDate = String(release.releaseDate || "").trim();
      const releaseNotes = normalizeReleaseNoteGroups(release.releaseNotes);
      if (!version || !releaseDate || releaseNotes.length === 0) {
        return null;
      }
      return {
        version,
        releaseDate,
        releaseNotes,
      };
    })
    .filter(Boolean);

  if (normalizedFromReleases.length > 0) {
    return normalizedFromReleases;
  }

  // Backward compatibility with single-release format
  const legacyVersion = String(rawManifest?.latestVersion || "").trim();
  const legacyReleaseDate = String(rawManifest?.releaseDate || "").trim();
  const legacyReleaseNotes = normalizeReleaseNoteGroups(
    rawManifest?.releaseNotes,
  );
  if (!legacyVersion || !legacyReleaseDate || legacyReleaseNotes.length === 0) {
    return [];
  }
  return [
    {
      version: legacyVersion,
      releaseDate: legacyReleaseDate,
      releaseNotes: legacyReleaseNotes,
    },
  ];
}

function getUpdateModalElements() {
  const overlay = document.getElementById("updateNoticeModal");
  const subtitle = document.getElementById("updateNoticeSubtitle");
  const currentVersion = document.getElementById("updateNoticeCurrentVersion");
  const latestVersion = document.getElementById("updateNoticeLatestVersion");
  const summary = document.getElementById("updateNoticeSummary");
  const releaseNotes = document.getElementById("updateNoticeReleaseNotes");
  const changelogLink = document.getElementById("updateNoticeChangelog");
  const btnClose = document.getElementById("btnUpdateNoticeClose");
  const btnAction = document.getElementById("btnUpdateNoticeAction");

  if (
    !overlay ||
    !subtitle ||
    !currentVersion ||
    !latestVersion ||
    !summary ||
    !releaseNotes ||
    !changelogLink ||
    !btnClose ||
    !btnAction
  ) {
    return null;
  }

  return {
    overlay,
    subtitle,
    currentVersion,
    latestVersion,
    summary,
    releaseNotes,
    changelogLink,
    btnClose,
    btnAction,
  };
}

function renderUpdateNoticeReleaseNotes(releaseNotes = []) {
  if (!Array.isArray(releaseNotes) || releaseNotes.length === 0) {
    return `<div class="update-notice-release-item"><p class="update-notice-release-title">版本说明</p><p class="update-notice-release-desc">本次主要包含稳定性优化和体验改进。</p></div>`;
  }

  const groupOrder = ["新增", "优化", "修复"];
  const withOrder = [...releaseNotes].sort((left, right) => {
    const leftTag = normalizeReleaseNoteTag(left?.tag || "其他");
    const rightTag = normalizeReleaseNoteTag(right?.tag || "其他");
    const leftIndex = groupOrder.indexOf(leftTag);
    const rightIndex = groupOrder.indexOf(rightTag);
    const normalizedLeftIndex = leftIndex === -1 ? 999 : leftIndex;
    const normalizedRightIndex = rightIndex === -1 ? 999 : rightIndex;
    return normalizedLeftIndex - normalizedRightIndex;
  });

  return withOrder
    .map((group) => {
      const groupTag = escapeHtml(
        normalizeReleaseNoteTag(group?.tag || "其他"),
      );
      const notes = Array.isArray(group?.notes) ? group.notes : [];
      if (notes.length === 0) {
        return "";
      }
      const items = notes
        .map((note) => {
          const title = escapeHtml(note?.title || "版本说明");
          const desc = escapeHtml(note?.desc || "");
          return `<div class="update-notice-release-item"><p class="update-notice-release-title">${title}</p><p class="update-notice-release-desc">${desc}</p></div>`;
        })
        .join("");
      const groupTagClass = getReleaseGroupTagClass(groupTag);
      return `<div class="update-notice-release-group"><p class="update-notice-release-group-title"><span class="${groupTagClass}">${groupTag}</span></p>${items}</div>`;
    })
    .filter(Boolean)
    .join("");
}

function renderVersionReleaseEntries(releases = []) {
  if (!Array.isArray(releases) || releases.length === 0) {
    return `<div class="update-notice-release-item"><p class="update-notice-release-title">版本说明</p><p class="update-notice-release-desc">本次主要包含稳定性优化和体验改进。</p></div>`;
  }

  return releases
    .map((release) => {
      const version = escapeHtml(String(release?.version || "-"));
      const releaseDate = escapeHtml(String(release?.releaseDate || ""));
      const notes = renderUpdateNoticeReleaseNotes(release?.releaseNotes || []);
      return `<div class="update-release-version-block"><p class="update-release-version-heading">v${version}${releaseDate ? ` · ${releaseDate}` : ""}</p>${notes}</div>`;
    })
    .join("");
}

function resolveUpdateActionConfig({installType, isLatest}) {
  const normalizedInstallType = String(installType || "")
    .trim()
    .toLowerCase();
  const devLike =
    normalizedInstallType === EXTENSION_INSTALL_TYPE.DEVELOPMENT ||
    normalizedInstallType === EXTENSION_INSTALL_TYPE.SIDELOAD;

  if (devLike) {
    return {
      label: "立即更新",
      mode: UPDATE_ACTION_MODE.OPEN_DOWNLOAD_PAGE,
    };
  }

  if (isLatest) {
    return {
      label: "立即使用",
      mode: UPDATE_ACTION_MODE.USE_NOW,
    };
  }

  return {
    label: "去扩展页检查更新",
    mode: UPDATE_ACTION_MODE.OPEN_EXTENSION_MANAGER,
  };
}

function openUpdateNoticeModal() {
  const elements = getUpdateModalElements();
  if (!elements) return;
  elements.overlay.classList.add("is-active");
  elements.overlay.setAttribute("aria-hidden", "false");
}

function closeUpdateNoticeModal() {
  const elements = getUpdateModalElements();
  if (!elements) return;
  elements.overlay.classList.remove("is-active");
  elements.overlay.setAttribute("aria-hidden", "true");
}

function getUpdateGuideModalElements() {
  const overlay = document.getElementById("updateGuideModal");
  const checkboxSkip = document.getElementById("checkboxUpdateGuideSkip");
  const btnCancel = document.getElementById("btnUpdateGuideCancel");
  const btnConfirm = document.getElementById("btnUpdateGuideConfirm");

  if (!overlay || !checkboxSkip || !btnCancel || !btnConfirm) {
    return null;
  }

  return {
    overlay,
    checkboxSkip,
    btnCancel,
    btnConfirm,
  };
}

function openUpdateGuideModal() {
  const elements = getUpdateGuideModalElements();
  if (!elements) return;
  elements.checkboxSkip.checked = false;
  elements.overlay.classList.add("is-active");
  elements.overlay.setAttribute("aria-hidden", "false");
}

function closeUpdateGuideModal() {
  const elements = getUpdateGuideModalElements();
  if (!elements) return;
  elements.overlay.classList.remove("is-active");
  elements.overlay.setAttribute("aria-hidden", "true");
}

async function openExtensionManagerWithFallback() {
  try {
    await chrome.tabs.create({url: EXTENSION_MANAGEMENT_URL});
    return true;
  } catch (error) {
    console.warn("[Sidebar] Failed to open extension manager:", error);
    showMessage("请手动打开 chrome://extensions 并点击“更新”", "warning");
    return false;
  }
}

async function handleUpdateGuideConfirmClick() {
  const elements = getUpdateGuideModalElements();
  const skipNextTime = Boolean(elements?.checkboxSkip?.checked);
  if (skipNextTime) {
    await writeUpdateModalState({skipExtensionUpdateGuide: true});
  }

  if (currentUpdateNoticeState?.latestVersion) {
    await writeUpdateModalState({
      dismissedVersion: currentUpdateNoticeState.latestVersion,
    });
  }

  const opened = await openExtensionManagerWithFallback();
  if (!opened) {
    return;
  }

  closeUpdateGuideModal();
  closeUpdateNoticeModal();
}

function handleUpdateGuideCancelClick() {
  closeUpdateGuideModal();
  openUpdateNoticeModal();
}

function setupUpdateGuideModalListeners() {
  if (updateGuideModalListenersBound) {
    return;
  }

  const elements = getUpdateGuideModalElements();
  if (!elements) {
    return;
  }

  elements.btnConfirm.addEventListener("click", () => {
    void handleUpdateGuideConfirmClick();
  });
  elements.btnCancel.addEventListener("click", () => {
    handleUpdateGuideCancelClick();
  });
  elements.overlay.addEventListener("click", (event) => {
    if (event.target === elements.overlay) {
      handleUpdateGuideCancelClick();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      !elements.overlay.classList.contains("is-active")
    ) {
      return;
    }
    event.preventDefault();
    handleUpdateGuideCancelClick();
  });

  updateGuideModalListenersBound = true;
}

function renderUpdateNoticeModal(state) {
  const elements = getUpdateModalElements();
  if (!elements) return;

  const {
    localVersion,
    latestVersion,
    minSupportedVersion,
    releaseDate,
    releases,
    changelogUrl,
    installType,
    isLatest,
    isForceUpdate,
    actionConfig,
  } = state;

  elements.currentVersion.textContent = `v${localVersion || "-"}`;
  elements.latestVersion.textContent = `v${latestVersion || "-"}`;

  const releaseDateText = releaseDate ? `（${releaseDate}）` : "";
  if (isLatest) {
    elements.subtitle.textContent = `当前已是最新版本${releaseDateText}`;
    elements.summary.textContent = "版本状态正常，可立即继续使用。";
    elements.btnClose.textContent = "关闭";
  } else if (isForceUpdate) {
    elements.subtitle.textContent = `检测到关键更新${releaseDateText}`;
    elements.summary.textContent =
      minSupportedVersion &&
      compareVersion(localVersion, minSupportedVersion) < 0
        ? `当前版本过低（最低支持 v${minSupportedVersion}），请立即升级后继续使用。`
        : "当前版本已落后，建议立即升级。";
    elements.btnClose.textContent = "稍后";
  } else {
    elements.subtitle.textContent = `发现新版本${releaseDateText}`;
    elements.summary.textContent = "可升级到最新版本，获取新功能和稳定性优化。";
    elements.btnClose.textContent = "稍后";
  }

  elements.releaseNotes.innerHTML = renderVersionReleaseEntries(releases);
  elements.changelogLink.setAttribute(
    "href",
    changelogUrl || DEFAULT_UPDATE_CHANGELOG_URL,
  );
  elements.changelogLink.style.display = "inline-flex";

  elements.btnAction.textContent = actionConfig.label;
  elements.btnAction.dataset.actionMode = actionConfig.mode;
  elements.btnAction.dataset.installType = installType;
}

async function handleUpdateNoticeActionClick() {
  if (!currentUpdateNoticeState) {
    closeUpdateNoticeModal();
    return;
  }

  const {actionConfig, latestVersion, downloadUrl} = currentUpdateNoticeState;
  const actionMode = actionConfig?.mode;

  if (actionMode === UPDATE_ACTION_MODE.OPEN_EXTENSION_MANAGER) {
    if (!currentUpdateNoticeState?.skipExtensionUpdateGuide) {
      closeUpdateNoticeModal();
      openUpdateGuideModal();
      return;
    }

    const opened = await openExtensionManagerWithFallback();
    if (!opened) {
      return;
    }
    await writeUpdateModalState({dismissedVersion: latestVersion});
    closeUpdateNoticeModal();
    return;
  }

  if (actionMode === UPDATE_ACTION_MODE.OPEN_DOWNLOAD_PAGE) {
    try {
      await chrome.tabs.create({
        url: downloadUrl || DEFAULT_UPDATE_DOWNLOAD_URL,
      });
      await writeUpdateModalState({dismissedVersion: latestVersion});
      closeUpdateNoticeModal();
      return;
    } catch (error) {
      console.warn("[Sidebar] Failed to open download page:", error);
      showMessage("打开下载页失败，请稍后重试", "error");
      return;
    }
  }

  closeUpdateNoticeModal();
}

async function handleUpdateNoticeCloseClick() {
  if (currentUpdateNoticeState && !currentUpdateNoticeState.isLatest) {
    await writeUpdateModalState({
      dismissedVersion: currentUpdateNoticeState.latestVersion,
    });
  }
  closeUpdateNoticeModal();
}

function setupUpdateModalListeners() {
  if (updateModalListenersBound) {
    return;
  }

  const elements = getUpdateModalElements();
  if (!elements) {
    return;
  }

  elements.btnAction.addEventListener("click", () => {
    void handleUpdateNoticeActionClick();
  });
  elements.btnClose.addEventListener("click", () => {
    void handleUpdateNoticeCloseClick();
  });
  elements.overlay.addEventListener("click", (event) => {
    if (event.target === elements.overlay) {
      void handleUpdateNoticeCloseClick();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      !elements.overlay.classList.contains("is-active")
    ) {
      return;
    }
    event.preventDefault();
    void handleUpdateNoticeCloseClick();
  });

  updateModalListenersBound = true;
}

async function checkExtensionUpdate({
  trigger = "auto",
  openModalWhenLatest = false,
} = {}) {
  const localVersion = getLocalExtensionVersion();
  const [manifestResult, installType, modalState] = await Promise.all([
    getUpdateManifest(),
    getExtensionInstallType(),
    readUpdateModalState(),
  ]);

  if (!manifestResult?.ok) {
    if (trigger !== "auto") {
      showMessage(
        manifestResult?.message || "检查更新失败，请稍后重试",
        "error",
      );
    }
    return null;
  }

  const normalized = normalizeUpdateManifestResult(manifestResult);
  if (!normalized.latestVersion) {
    if (trigger !== "auto") {
      showMessage("更新配置缺少 latestVersion", "error");
    }
    return null;
  }

  const compareToLatest = compareVersion(
    localVersion,
    normalized.latestVersion,
  );
  const isLatest = compareToLatest >= 0;
  const isOutdated = compareToLatest < 0;
  const isForceUpdate =
    normalized.minSupportedVersion &&
    compareVersion(localVersion, normalized.minSupportedVersion) < 0;

  const actionConfig = resolveUpdateActionConfig({
    installType,
    isLatest,
  });

  const nextState = {
    localVersion,
    latestVersion: normalized.latestVersion,
    minSupportedVersion: normalized.minSupportedVersion,
    downloadUrl: normalized.downloadUrl,
    changelogUrl: normalized.changelogUrl,
    releaseDate: normalized.releaseDate,
    releases: normalized.releases,
    installType,
    isLatest,
    isOutdated,
    isForceUpdate,
    actionConfig,
    dismissedVersion: modalState.dismissedVersion,
    skipExtensionUpdateGuide: modalState.skipExtensionUpdateGuide,
  };

  const dismissedSameVersion =
    nextState.dismissedVersion &&
    nextState.dismissedVersion === nextState.latestVersion;
  const shouldShowAutomatically = isOutdated && !dismissedSameVersion;

  const releasesInRange = (normalized.releases || []).filter((release) => {
    const releaseVersion = String(release?.version || "").trim();
    if (!releaseVersion) return false;
    return (
      compareVersion(releaseVersion, localVersion) > 0 &&
      compareVersion(releaseVersion, normalized.latestVersion) <= 0
    );
  });
  releasesInRange.sort((left, right) =>
    compareVersion(String(right?.version || ""), String(left?.version || "")),
  );
  nextState.releases =
    releasesInRange.length > 0
      ? releasesInRange
      : (normalized.releases || []).slice(0, 1);
  const shouldOpenModal =
    trigger !== "auto"
      ? isOutdated || openModalWhenLatest
      : shouldShowAutomatically;

  if (!shouldOpenModal) {
    if (trigger !== "auto") {
      showMessage("当前已是最新版本", "success");
    }
    return nextState;
  }

  currentUpdateNoticeState = nextState;
  renderUpdateNoticeModal(nextState);
  openUpdateNoticeModal();
  return nextState;
}

function scheduleAuthCodeAutoEncrypt({immediate = false} = {}) {
  if (authCodeEncryptTimer) {
    clearTimeout(authCodeEncryptTimer);
    authCodeEncryptTimer = null;
  }

  if (immediate) {
    void persistAuthCodeFromInput();
    return;
  }

  authCodeEncryptTimer = setTimeout(() => {
    authCodeEncryptTimer = null;
    void persistAuthCodeFromInput();
  }, AUTH_CODE_AUTO_ENCRYPT_DELAY);
}

function createAuthMutationId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function persistAuthCodeFromInput() {
  const operation = () => persistAuthCodeFromInputNow();
  const pending = authCodePersistPromise.then(operation, operation);
  authCodePersistPromise = pending.catch(() => null);
  return pending;
}

async function persistAuthCodeFromInputNow() {
  const inputCode = document.getElementById("inputCode");
  if (!inputCode) return;

  const rawCode = normalizeAuthCodeInput(inputCode.value);
  const currentAuth = getCurrentAuth() || {};
  const previousCode = normalizeAuthCodeInput(currentAuth.code);
  let previousPlainCode = "";

  if (previousCode) {
    try {
      previousPlainCode = normalizeAuthCodeInput(
        await ensurePlainAuthCode(previousCode),
      );
    } catch (error) {
      console.warn("[Sidebar] Failed to decode previous auth code:", error);
      previousPlainCode = previousCode;
    }
  }

  if (!rawCode) {
    if (previousPlainCode) {
      authCodeRevision += 1;
      await setCurrentAuth({
        code: "",
        verified: false,
        status: AUTH_STATUS.IDLE,
        reason: "none",
        message: "",
        user: null,
        credentialCredit: null,
        captureAgent: null,
        credential: null,
        binding: null,
        authMutationId: createAuthMutationId(),
      });
      await resetCurrentMonitor();
    } else if (inputCode.value) {
      inputCode.value = "";
    }
    return;
  }

  let encryptedCode = "";
  try {
    encryptedCode = await ensureEncryptedAuthCode(rawCode);
  } catch (error) {
    console.error("[Sidebar] Failed to encrypt auth code:", error);
    window.showMessage?.("激活码加密失败，请重试", "error");
    return;
  }

  const codeChanged = rawCode !== previousPlainCode;
  const needsMutationId = !String(currentAuth.authMutationId || "").trim();
  if (!codeChanged && !needsMutationId && isEncryptedAuthCode(previousCode)) {
    return;
  }

  const updates = {code: encryptedCode};

  if (codeChanged || needsMutationId) {
    updates.authMutationId = createAuthMutationId();
  }

  if (codeChanged) {
    authCodeRevision += 1;
    Object.assign(updates, {
      verified: false,
      status: AUTH_STATUS.IDLE,
      reason: "none",
      message: "",
      user: null,
      credentialCredit: null,
      captureAgent: null,
      credential: null,
      binding: null,
    });
  }

  await setCurrentAuth(updates);
  if (codeChanged) {
    await resetCurrentMonitor();
  }
}

async function renderAuthCodeInput(auth = getCurrentAuth()) {
  const inputCode = document.getElementById("inputCode");
  if (!inputCode) return;

  const currentToken = ++authCodeRenderToken;
  const rawCode = normalizeAuthCodeInput(auth?.code);
  if (!rawCode) {
    if (inputCode.value) inputCode.value = "";
    return;
  }

  let encryptedCode = rawCode;
  let plainCode = rawCode;

  if (!isEncryptedAuthCode(rawCode)) {
    try {
      encryptedCode = await ensureEncryptedAuthCode(rawCode);
    } catch (error) {
      console.error(
        "[Sidebar] Failed to migrate auth code to encrypted value:",
        error,
      );
      encryptedCode = rawCode;
    }
  } else {
    try {
      plainCode = await ensurePlainAuthCode(rawCode);
    } catch (error) {
      console.error("[Sidebar] Failed to decode auth code:", error);
      plainCode = "";
    }
  }

  if (currentToken !== authCodeRenderToken) return;

  if (encryptedCode !== rawCode) {
    await setCurrentAuth(
      {code: encryptedCode},
      {expectedMutationId: auth?.authMutationId},
    );
    if (currentToken !== authCodeRenderToken) return;
  }

  if (inputCode.value !== plainCode) {
    inputCode.value = plainCode;
  }
}

// ==================== UI 事件监听 ====================

async function handleTaskCenterAction(event) {
  const detail = event?.detail && typeof event.detail === "object"
    ? event.detail
    : {};
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
    window.activateSidebarTab?.("searchTab");
    return;
  }

  if (action === "keep_results") {
    if (!taskId) {
      showMessage("未找到要保留的任务，请刷新任务中心后重试", "warning");
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:cancel-unattended-keyword-run",
        requestId: taskId,
        message: "用户选择保留已有结果，不再自动恢复",
      });
      if (!response?.ok) {
        throw new Error(response?.reason || response?.error?.message || "任务状态更新失败");
      }
      showMessage("已保留当前结果，任务不会自动重试", "success");
    } catch (error) {
      showMessage("保留结果失败: " + error.message, "error");
    }
    return;
  }

  if (action === "stop") {
    if (taskId) {
      try {
        const unattendedResponse = await chrome.runtime.sendMessage({
          type: "onstarvoice:cancel-unattended-keyword-run",
          requestId: taskId,
          message: "用户从任务中心停止任务并保留已有结果",
        });
        if (unattendedResponse?.ok) {
          showMessage("正在停止任务并保留已有结果...", "warning");
          return;
        }
      } catch (error) {
        console.warn("[Sidebar] Cancel task center unattended run failed:", error);
      }
    }
    const activeTask = getActiveTaskContext();
    if (!taskId || activeTask?.taskId === taskId) {
      await handleCancel();
      showMessage("正在停止任务并保留已有结果...", "warning");
      return;
    }
    showMessage("这条任务已不在当前页面执行，已刷新任务状态", "warning");
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
    !window.confirm(
      "请先在抖音页面人工完成安全验证。确认页面已经恢复正常后，再继续剩余关键词。",
    )
  ) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:recover-unattended-keyword-run",
      requestId: taskId,
      mode,
    });
    if (!response?.ok) {
      throw new Error(response?.reason || response?.error?.message || "无法恢复任务");
    }
    showMessage(
      mode === "failed"
        ? "已安排仅重试失败关键词"
        : mode === "skip_current"
          ? "已跳过当前项并继续剩余任务"
          : "已从检查点继续剩余任务",
      "success",
    );
    await loadKeywordPlanUI();
  } catch (error) {
    showMessage("恢复任务失败: " + error.message, "error");
  }
}

/**
 * 设置 UI 事件监听
 */
function setupUIEventListeners() {
  document.addEventListener(
    "onstarvoice:task-center-action",
    handleTaskCenterAction,
  );
  const btnCaptureNote = document.getElementById("btnCaptureNote");
  if (btnCaptureNote) {
    btnCaptureNote.addEventListener("click", handleCaptureNoteData);
  }

  const checkboxCaptureComments = document.getElementById(
    "checkboxCaptureComments",
  );
  if (checkboxCaptureComments) {
    checkboxCaptureComments.addEventListener(
      "change",
      handleCaptureCommentsToggleChange,
    );
  }
  const checkboxCaptureBloggerMetrics = document.getElementById(
    "checkboxCaptureBloggerMetrics",
  );
  if (checkboxCaptureBloggerMetrics) {
    checkboxCaptureBloggerMetrics.addEventListener(
      "change",
      handleCaptureBloggerMetricsToggleChange,
    );
  }
  const checkboxEnableCommentLeadsFilter = document.getElementById(
    "checkboxEnableCommentLeadsFilter",
  );
  if (checkboxEnableCommentLeadsFilter) {
    checkboxEnableCommentLeadsFilter.addEventListener(
      "change",
      handleCommentLeadsFilterToggleChange,
    );
  }

  const commentsToggleWrap = document.querySelector(
    'label[for="checkboxCaptureComments"]',
  );
  if (commentsToggleWrap) {
    commentsToggleWrap.addEventListener(
      "click",
      handleCaptureCommentsToggleGuardClick,
    );
  }
  const bloggerMetricsToggleWrap = document.querySelector(
    'label[for="checkboxCaptureBloggerMetrics"]',
  );
  if (bloggerMetricsToggleWrap) {
    bloggerMetricsToggleWrap.addEventListener(
      "click",
      handleCaptureBloggerMetricsToggleGuardClick,
    );
  }
  document.querySelectorAll('[data-detail-setting="auto"]').forEach((input) => {
    input.addEventListener("change", handleAutoDetailCaptureToggleChange);
  });
  document
    .querySelectorAll('[data-detail-setting="auto-sync"]')
    .forEach((input) => {
      input.addEventListener("change", handleDetailCaptureAutoSyncToggleChange);
    });
  document
    .querySelectorAll('[data-detail-setting="ai-relevance-prefilter"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureAiRelevancePrefilterToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="comments"]')
    .forEach((input) => {
      input.addEventListener("change", handleDetailCaptureCommentsToggleChange);
    });
  document
    .querySelectorAll('[data-detail-setting="metrics"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureBloggerMetricsToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="skip-captured"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureSkipCapturedToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="comment-leads"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureCommentLeadsToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="comments-max-detected-items"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureCommentsMaxDetectedItemsChange,
      );
      input.addEventListener(
        "blur",
        handleDetailCaptureCommentsMaxDetectedItemsChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="low-follower-hit"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureLowFollowerHitToggleChange,
      );
    });
  document
    .querySelectorAll('[data-detail-setting="low-follower-hit-threshold"]')
    .forEach((input) => {
      input.addEventListener(
        "change",
        handleDetailCaptureLowFollowerHitThresholdChange,
      );
      input.addEventListener(
        "blur",
        handleDetailCaptureLowFollowerHitThresholdChange,
      );
    });

  const btnCaptureBlogger = document.getElementById("btnCaptureBlogger");
  if (btnCaptureBlogger) {
    btnCaptureBlogger.addEventListener("click", handleCaptureBloggerData);
  }

  const btnCaptureSearch = document.getElementById("btnCaptureSearch");
  if (btnCaptureSearch) {
    btnCaptureSearch.addEventListener("click", handleCaptureSearchData);
  }
  document
    .querySelectorAll("[data-search-execution-mode]")
    .forEach((tab) => {
      tab.addEventListener("click", () =>
        setSearchExecutionMode(tab.getAttribute("data-search-execution-mode")),
      );
    });
  setSearchExecutionMode("manual");
  document
    .getElementById("btnToggleKeywordStrategy")
    ?.addEventListener("click", () => toggleKeywordStrategyPanel());
  document
    .getElementById("btnKeywordStrategyTabBenchmark")
    ?.addEventListener("click", () => setKeywordStrategyTab("benchmark"));
  document
    .getElementById("btnKeywordStrategyTabOpportunity")
    ?.addEventListener("click", () => setKeywordStrategyTab("opportunity"));
  document
    .getElementById("btnKeywordStrategyTabLongtail")
    ?.addEventListener("click", () => setKeywordStrategyTab("longtail"));
  document
    .getElementById("btnRunKeywordOpportunity")
    ?.addEventListener("click", () => void handleRunKeywordOpportunity());
  document
    .getElementById("btnCancelKeywordOpportunity")
    ?.addEventListener("click", () => void handleCancelKeywordOpportunity());
  document
    .getElementById("btnClearKeywordOpportunityResult")
    ?.addEventListener("click", () => clearKeywordOpportunityResult());
  document
    .getElementById("keywordOpportunityResult")
    ?.addEventListener("click", handleKeywordOpportunityResultActions);
  document
    .getElementById("btnRunBenchmarkDiscovery")
    ?.addEventListener("click", () => void handleRunBenchmarkDiscovery());
  document
    .getElementById("btnCancelBenchmarkDiscovery")
    ?.addEventListener("click", () => void handleCancelBenchmarkDiscovery());
  document
    .getElementById("btnClearBenchmarkDiscoveryResult")
    ?.addEventListener("click", () => clearBenchmarkDiscoveryResult());
  document
    .getElementById("keywordBenchmarkResult")
    ?.addEventListener("click", handleBenchmarkDiscoveryResultActions);
  document
    .getElementById("btnKeywordStrategyModalClose")
    ?.addEventListener("click", () => toggleKeywordStrategyPanel(false));
  document
    .getElementById("keywordStrategyModalOverlay")
    ?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        toggleKeywordStrategyPanel(false);
      }
    });

  // ---- 批量操作弹窗唤起 ----
  document
    .getElementById("btnOpenBatchNote")
    ?.addEventListener("click", () => openBatchModal("links"));
  document
    .getElementById("btnOpenBatchBlogger")
    ?.addEventListener("click", () => openBatchModal("bloggers"));
  document
    .getElementById("btnOpenBatchSearch")
    ?.addEventListener("click", () => openBatchModal("keywords"));

  document
    .getElementById("btnBatchModalClose")
    ?.addEventListener("click", closeBatchModal);
  document
    .getElementById("batchModalOverlay")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeBatchModal();
    });

  // ---- 批量采集执行 ----
  document
    .getElementById("btnRunBatchLinks")
    ?.addEventListener("click", handleRunBatchLinks);
  document
    .getElementById("btnRunBatchBloggers")
    ?.addEventListener("click", handleRunBatchBloggers);

  document
    .getElementById("textareaBatchLinks")
    ?.addEventListener("input", persistCurrentBatchDraft);
  document
    .getElementById("textareaBatchBloggers")
    ?.addEventListener("input", persistCurrentBatchDraft);
  document
    .getElementById("textareaBatchKeywords")
    ?.addEventListener("input", () => {
      updateBatchKeywordInputState();
      persistCurrentBatchDraft();
    });

  // ---- 关键词裂变内部逻辑 ----
  document
    .getElementById("btnExpandKeywords")
    ?.addEventListener("click", handleExpandKeywords);
  document
    .getElementById("btnRunKeywordInsight")
    ?.addEventListener("click", handleExpandKeywords);

  document
    .getElementById("btnRunBatchKeywords")
    ?.addEventListener("click", handleBatchKeywordCapture);
  document
    .getElementById("btnSaveKeywordPlan")
    ?.addEventListener("click", () => handleSaveKeywordPlan("modal"));
  document
    .getElementById("btnSaveSearchKeywordPlan")
    ?.addEventListener("click", () => handleSaveKeywordPlan("search"));
  document
    .getElementById("btnAddSearchKeywordPlanDate")
    ?.addEventListener("click", addSearchKeywordPlanDateFromPicker);
  document
    .getElementById("inputSearchKeywordPlanDatePicker")
    ?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      addSearchKeywordPlanDateFromPicker();
    });
  document
    .getElementById("searchKeywordPlanDateChips")
    ?.addEventListener("click", handleSearchKeywordPlanDateChipClick);
  document
    .getElementById("selectKeywordPlanMode")
    ?.addEventListener("change", () => syncKeywordPlanDateFields("modal"));
  document
    .getElementById("selectSearchKeywordPlanMode")
    ?.addEventListener("change", () => syncKeywordPlanDateFields("search"));
  document
    .getElementById("chkKeywordPlanEnabled")
    ?.addEventListener("change", () =>
      renderKeywordPlanStatus(keywordPlanState, "modal"),
    );
  document
    .getElementById("chkSearchKeywordPlanEnabled")
    ?.addEventListener("change", () =>
      renderKeywordPlanStatus(keywordPlanState, "search"),
    );
  // 轮次设置已合并进「无人值守计划」:执行轮数 > 1 即循环,不再单独暴露第二个开关。
  const bindAutoLoopFields = (chkId, fieldsId) => {
    const chk = document.getElementById(chkId);
    const sync = () =>
      document
        .getElementById(fieldsId)
        ?.classList.toggle("is-disabled", chk && !chk.checked && !chk.hidden);
    chk?.addEventListener("change", sync);
    sync();
  };
  bindAutoLoopFields("chkAutoLoop", "batchLoopFields");
  bindAutoLoopFields("chkSearchAutoLoop", "searchLoopFields");
  // 搜索页「批量多个关键词」开关:切换 单词自动读取 / 多词文本框 + 按钮文案
  const chkSearchBatchEl = document.getElementById("chkSearchBatchMode");
  const syncSearchBatchMode = () => {
    const on = !!chkSearchBatchEl?.checked;
    document.getElementById("searchSingleKeywordGroup")?.toggleAttribute("hidden", on);
    document.getElementById("searchBatchKeywordGroup")?.toggleAttribute("hidden", !on);
    const capBtn = document.getElementById("btnCaptureSearch");
    if (capBtn) capBtn.textContent = on ? "开始批量采集" : "采集当前搜索结果";
  };
  chkSearchBatchEl?.addEventListener("change", syncSearchBatchMode);
  syncSearchBatchMode();
  document
    .getElementById("keywordInsightError")
    ?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (!target.closest("#btnRetryKeywordAnalysis")) {
        return;
      }
      event.preventDefault();
      void retryKeywordAnalysis();
    });
  document
    .getElementById("btnViewExpandedKeywords")
    ?.addEventListener("click", toggleExpandedKeywordsVisibility);
  document
    .getElementById("btnClearKeywordInsightResult")
    ?.addEventListener("click", () => clearKeywordInsightResult());
  document
    .getElementById("keywordInsightCategories")
    ?.addEventListener("click", handleKeywordInsightCategoryActions);
  document
    .getElementById("keywordInsightCategories")
    ?.addEventListener("change", handleKeywordInsightCategoryActions);
  document
    .getElementById("keywordInsightSummary")
    ?.addEventListener("click", handleKeywordInsightSummaryActions);

  document
    .getElementById("textareaExpandedKeywords")
    ?.addEventListener("input", () => {
      expandedKeywordsBuffer = parseKeywordsFromMultilineInput(
        document.getElementById("textareaExpandedKeywords")?.value || "",
      );
      updateExpandedKeywordsSummary();
      invalidateKeywordInsightDraft();
      renderKeywordInsightState();
      persistCurrentBatchDraft();
    });

  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.addEventListener("click", handleCancel);
  }
  document
    .getElementById("btnRetryRecovery")
    ?.addEventListener("click", handleRetryRecovery);
  document
    .getElementById("btnDismissRecovery")
    ?.addEventListener("click", handleDismissRecovery);

  const btnVerify = document.getElementById("btnVerify");
  if (btnVerify) {
    btnVerify.addEventListener("click", handleVerify);
  }

  for (const id of ["btnGoClaim", "btnGoClaimConfig"]) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        void handleGoClaim();
      });
    }
  }

  setupAuthCodeInputListeners();
  setupMemberGroupModalListeners();

  const targetInputs = [
    "inputFeishuAppToken",
    "inputTableId",
    "inputKeywordNotesTableName",
    "inputBloggerProfileTableName",
    "inputBloggerNotesTableName",
    "inputCommentLeadsTableName",
    "inputMonitorTableName",
    "inputReportWebhookUrl",
  ];
  targetInputs.forEach((id) => {
    const el = document.getElementById(id);
    // Listen to changes for auto-save
    if (el) {
      el.addEventListener("change", handleSaveTarget);
      el.addEventListener("blur", handleSaveTarget);
    }
  });

  const prefInputs = [
    "inputSyncScope",
    "inputDetailCaptureScope",
    "checkboxSkipOfficialAccounts",
    "inputCommentsMaxDetectedItems",
    "inputCommentLeadsKeywords",
    "inputCommentLeadsIps",
    "inputSharedWaitMinSec",
    "inputSharedWaitMaxSec",
    "inputSharedStallTimeoutSec",
    "inputSharedMaxDurationSec",
    "inputDetailNavTimeoutMs",
    "inputDetailAfterNavWaitMs",
    "inputProfileAfterNavWaitMs",
    "inputBloggerMinLikes",
    "inputBloggerMaxDetectedItems",
    "inputBloggerKeywordFilter",
    "inputKeywordMinLikes",
    "inputKeywordMaxDetectedItems",
  ];
  prefInputs.forEach((id) => {
    const el = document.getElementById(id);
    // Listen to changes for auto-save
    if (el) {
      el.addEventListener("change", handleSaveCaptureSettings);
      el.addEventListener("blur", handleSaveCaptureSettings);
    }
  });

  // Init More Menu Dropdown
  const btnMoreMenu = document.getElementById("btnMoreMenu");
  const dropdownMoreMenu = document.getElementById("dropdownMoreMenu");
  const getMoreMenuItems = () =>
    dropdownMoreMenu
      ? Array.from(dropdownMoreMenu.querySelectorAll(".dropdown-item"))
      : [];
  const setMoreMenuOpen = (
    open,
    {restoreFocus = false, focusEdge = ""} = {},
  ) => {
    if (!btnMoreMenu || !dropdownMoreMenu) return;
    const nextOpen = Boolean(open);
    dropdownMoreMenu.classList.toggle("is-active", nextOpen);
    btnMoreMenu.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    if (restoreFocus) {
      btnMoreMenu.focus();
    } else if (nextOpen && focusEdge) {
      requestAnimationFrame(() => {
        const items = getMoreMenuItems();
        const target = focusEdge === "last" ? items.at(-1) : items[0];
        target?.focus();
      });
    }
  };
  if (btnMoreMenu && dropdownMoreMenu) {
    dropdownMoreMenu
      .querySelectorAll(".dropdown-item")
      .forEach((item) => item.setAttribute("role", "menuitem"));
    btnMoreMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      const nextOpen = !dropdownMoreMenu.classList.contains("is-active");
      setMoreMenuOpen(nextOpen, {focusEdge: nextOpen ? "first" : ""});
    });
    dropdownMoreMenu.addEventListener("click", (event) => {
      if (event.target.closest(".dropdown-item")) {
        setMoreMenuOpen(false, {restoreFocus: true});
      }
    });
    dropdownMoreMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMoreMenuOpen(false, {restoreFocus: true});
        return;
      }
      if (!new Set(["ArrowDown", "ArrowUp", "Home", "End"]).has(event.key)) {
        return;
      }
      const items = getMoreMenuItems();
      if (items.length === 0) return;
      event.preventDefault();
      const activeIndex = items.indexOf(document.activeElement);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowUp"
              ? (activeIndex <= 0 ? items.length : activeIndex) - 1
              : (activeIndex + 1) % items.length;
      items[nextIndex]?.focus();
    });
    btnMoreMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMoreMenuOpen(false, {restoreFocus: true});
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMoreMenuOpen(true, {
          focusEdge: event.key === "ArrowUp" ? "last" : "first",
        });
      }
    });
    document.addEventListener("click", (e) => {
      if (
        !dropdownMoreMenu.contains(e.target) &&
        !btnMoreMenu.contains(e.target)
      ) {
        setMoreMenuOpen(false);
      }
    });
  }

  const btnPlatformMenu = document.getElementById("btnPlatformMenu");
  const dropdownPlatformMenu = document.getElementById("dropdownPlatformMenu");
  if (btnPlatformMenu && dropdownPlatformMenu) {
    btnPlatformMenu.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextOpenState =
        !dropdownPlatformMenu.classList.contains("is-active");
      setPlatformMenuOpen(nextOpenState);
    });

    dropdownPlatformMenu
      .querySelectorAll(".platform-menu-item[data-platform]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const targetPlatform = String(button.dataset.platform || "").trim();
          void handlePlatformMenuSwitch(targetPlatform);
        });
      });

    document.addEventListener("click", (event) => {
      if (
        !dropdownPlatformMenu.contains(event.target) &&
        !btnPlatformMenu.contains(event.target)
      ) {
        setPlatformMenuOpen(false);
      }
    });
  }

  const menuBtnSettings = document.getElementById("menuBtnSettings");
  if (menuBtnSettings) {
    menuBtnSettings.addEventListener("click", () => {
      window.activateSidebarTab("settingsTab");
      setMoreMenuOpen(false);
    });
  }

  const menuBtnHistory = document.getElementById("menuBtnHistory");
  if (menuBtnHistory) {
    menuBtnHistory.addEventListener("click", () => {
      window.activateSidebarTab("historyTab");
      setMoreMenuOpen(false);
    });
  }

  const menuBtnCheckUpdate = document.getElementById("menuBtnCheckUpdate");
  if (menuBtnCheckUpdate) {
    menuBtnCheckUpdate.addEventListener("click", () => {
      void checkExtensionUpdate({
        trigger: "manual",
        openModalWhenLatest: true,
      });
      setMoreMenuOpen(false);
    });
  }

  const menuBtnContact = document.getElementById("menuBtnContact");
  if (menuBtnContact) {
    menuBtnContact.addEventListener("click", () => {
      openContactModal();
      setMoreMenuOpen(false);
    });
  }
  setupContactModalListeners();

  const btnOpenRiskModal = document.getElementById("btnOpenRiskModal");
  if (btnOpenRiskModal) {
    btnOpenRiskModal.addEventListener("click", () => {
      openRiskModal();
    });
  }
  setupRiskModalListeners();
  setupUpdateModalListeners();
  setupUpdateGuideModalListeners();

  document.querySelectorAll(".monitor-subject-option").forEach((button) => {
    button.addEventListener("click", () => {
      setMonitorSubjectType(button.dataset.subjectType);
    });
  });
  setMonitorSubjectType(getMonitorSubjectType());

  const btnMonitorAddCurrent = document.getElementById("btnMonitorAddCurrent");
  if (btnMonitorAddCurrent) {
    btnMonitorAddCurrent.addEventListener("click", () => {
      void handleAddCurrentMonitor();
    });
  }
  const btnMonitorRunNow = document.getElementById("btnMonitorRunNow");
  if (btnMonitorRunNow) {
    btnMonitorRunNow.addEventListener("click", () => {
      void handleRunMonitorNow();
    });
  }

  const monitorStatusFilter = document.getElementById("monitorStatusFilter");
  if (monitorStatusFilter) {
    monitorStatusFilter.addEventListener("change", (event) => {
      const nextStatus = String(
        event.target?.value || MONITOR_STATUS.ALL,
      ).trim();
      void setCurrentMonitor({
        filters: {
          ...(getCurrentMonitor()?.filters || {}),
          status: nextStatus || MONITOR_STATUS.ALL,
        },
      }).then(() => loadMonitorSubscriptions({force: true}));
    });
  }

  const monitorSubscriptionList = document.getElementById(
    "monitorSubscriptionList",
  );
  if (monitorSubscriptionList) {
    monitorSubscriptionList.addEventListener("click", handleMonitorListClick);
  }

  [
    "inputMonitorPublishWindow",
    "inputMonitorLikeThreshold",
    "inputMonitorRunTimes",
    "inputMonitorObserveWindowHours",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      void handleSaveMonitorSettings();
    });
    el.addEventListener("blur", () => {
      void handleSaveMonitorSettings();
    });
  });

  const btnSyncAll = document.getElementById("btnSyncAll");
  if (btnSyncAll) {
    btnSyncAll.addEventListener("click", handleSyncAll);
  }

  const btnExport = document.getElementById("btnExport");
  if (btnExport) {
    btnExport.addEventListener("click", handleExport);
  }

  const btnClearPool = document.getElementById("btnClearPool");
  if (btnClearPool) {
    btnClearPool.addEventListener("click", handleClearPool);
  }

  const btnClearSyncHistory = document.getElementById("btnClearSyncHistory");
  if (btnClearSyncHistory) {
    btnClearSyncHistory.addEventListener("click", handleClearSyncHistory);
  }

  const btnCopyDiagnostics = document.getElementById("btnCopyDiagnostics");
  if (btnCopyDiagnostics) {
    btnCopyDiagnostics.addEventListener("click", () => {
      void handleCopyDiagnostics();
    });
  }

  const recordList = document.getElementById("recordList");
  if (recordList) {
    recordList.addEventListener("click", handleRecordListClick);
  }

  window.requestMonitorRefresh = () => {
    void Promise.all([loadMonitorSettings(), loadMonitorSubscriptions()]);
  };

  window.requestExecutionDetailRefresh = () => {
    void loadExecutionDetails({force: true});
  };

  window.requestAuthRefresh = (options = {}) => {
    void refreshVerifiedAuthSnapshot({
      showFeedback: Boolean(options?.showFeedback),
    });
  };
}

async function handlePlatformMenuSwitch(targetPlatform) {
  const normalizedTargetPlatform = String(targetPlatform || "").trim();
  if (!normalizedTargetPlatform) {
    setPlatformMenuOpen(false);
    return;
  }

  const runtime = getCurrentRuntime();
  const pagePlatform = getPagePlatform(runtime);
  const selectedPlatform = resolveSelectedPlatform(runtime, pagePlatform);

  if (normalizedTargetPlatform === pagePlatform) {
    if (manualSelectedPlatform || selectedPlatform !== pagePlatform) {
      manualSelectedPlatform = "";
      updatePlatformUI(runtime);
      syncSearchFilterControlsForPlatform(getViewPlatform(runtime));
      updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
      await refreshDataPool();
    }
    setPlatformMenuOpen(false);
    return;
  }

  const platformCopy = getPlatformCopy(normalizedTargetPlatform);
  setPlatformMenuOpen(false);
  showMessage(`正在打开${platformCopy.label}主页...`, "info");

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.SWITCH_PLATFORM_TAB,
      platform: normalizedTargetPlatform,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "打开平台页面失败");
    }
    manualSelectedPlatform = "";
  } catch (error) {
    console.error("[Sidebar] Platform switch failed:", error);
    showMessage(`打开${platformCopy.label}主页失败: ${error.message}`, "error");
  }
}

// ==================== 事件处理器 ====================

async function handleCaptureNoteData() {
  const runtime = getCurrentRuntime();
  const bootstrapEvidenceTabId = Number(bootstrapInitialSearchEvidence?.tabId);
  const bootstrapEvidenceAccepted = Boolean(
    bootstrapInitialSearchEvidence?.ready === true &&
      String(bootstrapInitialSearchEvidence?.platform || "").trim() &&
      (!preferredSourceTabId ||
        bootstrapEvidenceTabId === Number(preferredSourceTabId)),
  );
  const selectedPlatform = getViewPlatform(runtime);
  const pagePlatform = bootstrapEvidenceAccepted
    ? String(bootstrapInitialSearchEvidence.platform || "").trim()
    : getPagePlatform(runtime);
  if (selectedPlatform !== pagePlatform) {
    const platformCopy = getPlatformCopy(selectedPlatform);
    showMessage(
      `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再采集`,
      "error",
    );
    return;
  }
  if (runtime?.pageType !== PAGE_TYPE.NOTE_DETAIL) {
    showMessage("请先切换到笔记/作品详情页", "error");
    return;
  }
  if (isNoteDetailPending(runtime)) {
    showMessage(resolveNoteDetailPendingText(runtime), "warning");
    return;
  }

  const settings = await getCaptureSettings();
  const currentPlatform = pagePlatform;
  const platformCapabilities = getPlatformCapabilities(currentPlatform);
  const hideBloggerMetricsToggle =
    shouldHideNoteBloggerMetricsToggle(selectedPlatform);
  const commentsConfigured = getCaptureCommentsChecked(settings);
  const includeComments = platformCapabilities.captureComments
    ? commentsConfigured
    : false;
  const enableCommentLeadsFilter =
    includeComments && getCommentLeadsFilterChecked(settings);
  const includeBloggerMetrics =
    !hideBloggerMetricsToggle && platformCapabilities.bloggerMetrics
      ? getCaptureBloggerMetricsChecked(settings)
      : false;
  let commentsMaxDetectedItems = settings.commentsMaxDetectedItems;
  if (includeComments) {
    commentsMaxDetectedItems = readRequiredCommentsMaxDetectedItemsFromInput();
    if (!commentsMaxDetectedItems) {
      showMessage("开启评论采集时，请填写评论探测上限（正整数）", "error");
      return;
    }
  }

  const taskContext = beginSidebarTask({
    taskType: "capture",
    featureKey: "capture.single_note",
    metadata: {
      platform: currentPlatform,
      pageType: runtime?.pageType || "",
      includeComments,
      includeBloggerMetrics,
      enableCommentLeadsFilter,
    },
  });
  let taskStatus = "completed";
  let taskError = null;

  showProgress(
    includeComments ? "正在采集笔记并准备评论任务..." : "正在采集笔记数据...",
  );

  try {
    const result = await captureNoteWithOptionalComments({
      includeComments,
      includeBloggerMetrics,
      enableCommentLeadsFilter,
      commentsMaxDetectedItems,
      detailNavTimeoutMs: settings.detailNavTimeoutMs,
      profileAfterNavWaitMs: settings.profileAfterNavWaitMs,
      onProgress: handleProgress,
    });

    if (result.recordId) {
      activeCommentsCaptureRecordId = result.recordId;
    }

    if (result.ok) {
      if (result.phase === "note_ready") {
        showMessage("笔记采集成功，已加入缓存池", "success");
      } else if (result.phase === "comments_partial") {
        taskStatus = "partial";
        renderCaptureRecoveryUI({
          ...(result.commentsResult || {}),
          phase: "comments_partial",
          recordId: result.recordId,
          collectedCount: Number(result.commentsResult?.commentsCount || 0),
          captureAction: "captureComments",
          updatedAt: Date.now(),
        });
        showMessage(
          includeBloggerMetrics
            ? "笔记已入池，评论已手动停止并合并，博主指标已回填"
            : "笔记已入池，评论已手动停止并合并",
          "warning",
        );
      } else if (includeComments && includeBloggerMetrics) {
        showMessage(
          "笔记、评论与博主指标采集完成，已合并到同一条记录",
          "success",
        );
      } else if (includeBloggerMetrics) {
        showMessage("笔记与博主指标采集完成，已加入缓存池", "success");
      } else {
        showMessage("笔记与评论采集完成，已合并到同一条记录", "success");
      }
      await refreshDataPool();
      return;
    }

    if (result.noteReady || result.phase === "comments_failed") {
      taskStatus = "partial";
      const commentsFailed = Boolean(
        result.commentsResult && result.commentsResult.ok === false,
      );
      const metricsFailed = Boolean(
        result.bloggerMetricsResult && result.bloggerMetricsResult.ok === false,
      );
      if (commentsFailed) {
        renderCaptureRecoveryUI({
          phase: "comments_failed",
          recordId: result.recordId,
          captureAction: "captureComments",
          error: result.commentsResult?.error || null,
          updatedAt: Date.now(),
        });
      }
      if (commentsFailed && metricsFailed) {
        showMessage(
          "笔记已入池，评论与博主指标采集失败（可在记录卡片继续评论）",
          "warning",
        );
      } else if (commentsFailed) {
        showMessage("笔记已入池，评论采集失败，可在记录卡片继续评论", "warning");
      } else if (metricsFailed) {
        showMessage("笔记已入池，博主指标采集失败，不影响主流程", "warning");
      } else {
        showMessage("笔记已入池，存在可选增强项失败", "warning");
      }
      await refreshDataPool();
      return;
    }

    const rawErrorCode = String(result.error?.code || "").trim();
    const rawErrorMessage = String(result.error?.message || "").trim();
    const errorMsg =
      (rawErrorCode === "CAPTURE_FAILED" && rawErrorMessage) ||
      ERROR_MESSAGE_MAP[result.error?.code] ||
      rawErrorMessage ||
      "采集失败";
    taskStatus = "failed";
    showMessage(errorMsg, "error");
  } catch (error) {
    console.error(
      "[Sidebar] Capture note with optional comments failed:",
      error,
    );
    taskStatus = "failed";
    taskError = error;
    showMessage("操作失败: " + error.message, "error");
  } finally {
    activeCommentsCaptureRecordId = "";
    activeCommentsCaptureTabId = null;
    activeCommentsCaptureRequestId = "";
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        includeComments,
        includeBloggerMetrics,
      },
    });
    hideProgress();
  }
}

async function handleCaptureBloggerData() {
  const runtime = getCurrentRuntime();
  const selectedPlatform = getViewPlatform(runtime);
  const pagePlatform = getPagePlatform(runtime);
  if (selectedPlatform !== pagePlatform) {
    const platformCopy = getPlatformCopy(selectedPlatform);
    showMessage(
      `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再采集`,
      "error",
    );
    return;
  }
  if (runtime?.pageType !== PAGE_TYPE.BLOGGER_PROFILE) {
    showMessage("请先切换到博主主页", "error");
    return;
  }
  const taskContext = beginSidebarTask({
    taskType: "capture",
    featureKey: "capture.blogger",
    metadata: {
      platform: pagePlatform,
      pageType: runtime?.pageType || "",
    },
  });
  let taskStatus = "completed";
  let taskError = null;
  let captureTaskSessionStarted = false;
  showProgress("正在采集博主信息...");

  try {
    if (supportsPersistentCaptureTaskPlatform(pagePlatform)) {
      const sourceTabId = await resolveCaptureTaskSourceTabId({
        platform: pagePlatform,
      });
      await startRequiredCaptureTaskSession({
        taskId: taskContext.taskId,
        tabId: sourceTabId,
        label: "博主主页采集",
        platform: pagePlatform,
      });
      captureTaskSessionStarted = true;
    }

    const profileResult = await captureAndSync({
      mode: "blogger_profile",
      onProgress: handleProgress,
      autoSync: false,
    });

    if (!profileResult.ok) {
      const errorMsg =
        ERROR_MESSAGE_MAP[profileResult.error?.code] ||
        profileResult.error?.message ||
        "博主信息采集失败";
      showMessage(errorMsg, "error");
      taskStatus = "failed";
      return;
    }

    showProgress("正在采集博主笔记...");
    const settings = resolveCurrentDetailCaptureSettings(
      await getCaptureSettings(),
    );
    const bloggerMinLikes = readBloggerMinLikesFromInput(
      settings.bloggerMinLikes,
    );
    const bloggerMaxDetectedItems = readBloggerMaxDetectedItemsFromInput(
      settings.bloggerMaxDetectedItems,
    );
    const bloggerKeywordFilter = readBloggerKeywordFilterFromInput();

    const notesResult = await captureAndSync({
      mode: "blogger_notes",
      onProgress: handleProgress,
      autoSync: false,
      captureParams: {
        profileMetrics: profileResult.captureResult?.data || {},
        minLikes: bloggerMinLikes,
        maxDetectedItems: bloggerMaxDetectedItems,
        keywordFilter: bloggerKeywordFilter,
        waitMinMs: settings.sharedWaitMinMs,
        waitMaxMs: settings.sharedWaitMaxMs,
        stallTimeoutMs: settings.sharedStallTimeoutMs,
        maxDurationMs: settings.sharedMaxDurationMs,
      },
    });

    if (!notesResult.ok) {
      const errorMsg =
        ERROR_MESSAGE_MAP[notesResult.error?.code] ||
        notesResult.error?.message ||
        "博主笔记采集失败";
      showMessage(errorMsg, "error");
      taskStatus = "failed";
      return;
    }

    const notesPayload = notesResult.captureResult?.data || {};
    const filteredCount = Number(notesPayload.filteredCount || 0);
    const rawCount = Number(notesPayload.rawTotalCount || filteredCount);
    let successMsg = `博主信息与笔记采集成功：滚动探测 ${rawCount} 条，入池 ${filteredCount} 条（点赞≥${bloggerMinLikes}`;
    if (bloggerKeywordFilter) {
      successMsg += `，关键词"${bloggerKeywordFilter}"`;
    }
    successMsg += `，探测上限 ${bloggerMaxDetectedItems}）`;
    showMessage(successMsg, "success");
    await refreshDataPool();
    const enhanceResult = await maybeRunAutoDetailCaptureAfterListCapture(
      resolveCurrentDetailCaptureSettings(await getCaptureSettings()),
      {
        sourceLabel: "博主笔记",
        recordIds: notesResult.recordIds,
        captureTaskId: captureTaskSessionStarted ? taskContext.taskId : "",
      },
    );
    if (enhanceResult?.securityBlocked || enhanceResult?.canceled) {
      taskStatus = "partial";
    } else if (enhanceResult && enhanceResult.ok === false) {
      taskStatus = "completed_with_failures";
    }
  } catch (error) {
    console.error("[Sidebar] Capture blogger failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("操作失败: " + error.message, "error");
  } finally {
    const terminal = resolveCaptureTaskTerminalStatus({
      taskStatus,
      error: taskError,
    });
    if (captureTaskSessionStarted) {
      const captureTaskEnd = await endCaptureTaskSession({
        taskId: taskContext.taskId,
        ...terminal,
      });
      if (captureTaskEnd?.ok === true) {
        releaseCaptureTaskOwner(taskContext.taskId);
      }
    }
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        platform: pagePlatform,
      },
    });
    hideProgress();
  }
}

// 搜索页:在当前激活 tab 应用排序/范围筛选(复用 content 的 applyBatchSearchFilters,失败不阻断采集)
function hasActiveSearchFilters(searchFilters = {}) {
  return Object.values(searchFilters || {}).some((value) =>
    Boolean(String(value || "").trim()),
  );
}

async function applySearchFiltersOnActiveTab(tabId, searchFilters = {}) {
  if (!hasActiveSearchFilters(searchFilters) || !Number.isFinite(Number(tabId))) return;
  try {
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: Number(tabId),
      payload: { action: "applyBatchSearchFilters", ...searchFilters },
    });
  } catch (error) {
    console.warn("[Sidebar] 搜索页筛选切换失败(不影响采集):", error);
  }
}

function getSearchBatchKeywordsFromTextarea() {
  return String(document.getElementById("textareaSearchBatchKeywords")?.value || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function handleCaptureSearchData() {
  const runtime = getCurrentRuntime();
  const selectedPlatform = getViewPlatform(runtime);
  const pagePlatform = getPagePlatform(runtime);
  if (selectedPlatform !== pagePlatform) {
    const platformCopy = getPlatformCopy(selectedPlatform);
    showMessage(
      `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再采集`,
      "error",
    );
    return;
  }
  if (
    runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS &&
    !bootstrapEvidenceAccepted
  ) {
    showMessage("请先切换到搜索页", "error");
    return;
  }

  const platformCapabilities = getPlatformCapabilities(pagePlatform);
  if (!platformCapabilities.captureSearch) {
    showMessage("当前平台暂不支持搜索结果采集", "warning");
    return;
  }

  let activeTabUrl = runtime?.lastPageUrl || "";
  let searchActiveTabId = null;
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.url) {
      activeTabUrl = tab.url;
    }
    if (tab?.id != null) searchActiveTabId = tab.id;
  } catch {
    // ignore and fallback to runtime url
  }

  // 批量多词模式:从文本框读多个关键词;否则单词:从当前搜索页读
  const searchBatchMode = !!document.getElementById("chkSearchBatchMode")?.checked;
  let searchKeywords = [];
  let keyword = "";
  if (searchBatchMode) {
    const rawKw = getSearchBatchKeywordsFromTextarea();
    if (rawKw.length === 0) {
      showMessage("请输入至少一个关键词（每行一个）", "warning");
      return;
    }
    if (rawKw.length > MAX_BATCH_KEYWORDS) {
      showMessage(`单次最多批量采集 ${MAX_BATCH_KEYWORDS} 个关键词`, "warning");
      return;
    }
    searchKeywords = dedupeKeywords(rawKw);
    keyword = searchKeywords[0];
  } else {
    keyword = extractKeywordFromUrl(activeTabUrl);
    if (!keyword) {
      showMessage(
        "当前页面未检测到关键词。请先在搜索页输入关键词并点击搜索后再采集",
        "warning",
      );
      return;
    }
    searchKeywords = [keyword];
  }

  const taskContext = beginSidebarTask({
    taskType: "capture",
    featureKey: "capture.search",
    metadata: {
      platform: pagePlatform,
      pageType: runtime?.pageType || "",
      keyword,
    },
  });
  let taskStatus = "completed";
  let taskError = null;
  let executionLock = null;
  let streamingSyncQueue = null;
  let streamingSyncResult = null;
  let streamingSyncDrained = false;
  let captureTaskSessionStarted = false;
  let persistentCaptureTaskId = "";

  try {
    const settings = resolveCurrentDetailCaptureSettings(
      await getCaptureSettings(),
    );
    streamingSyncQueue = createStreamingDetailAutoSyncQueue(settings, {
      shouldStop: () => searchCaptureCancelRequested,
    });
    if (
      settings.autoDetailCaptureAfterListCapture &&
      !ensureAuthVerifiedOrWarn({
        message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
      })
    ) {
      taskStatus = "skipped";
      return;
    }
    executionLock = await acquireCaptureExecutionLock({
      owner: "manual_search_capture",
      label: searchBatchMode ? "手动批量关键词采集" : "手动搜索页采集",
    });
    if (!executionLock) {
      taskStatus = "skipped";
      return;
    }
    const sortContext = await syncKeywordSortDimensionFromPage({
      force: true,
      fallbackDimension: keywordSortDimension,
    });
    const sortLabel = getKeywordSortDimensionLabel(sortContext.dimension);
    const keywordMinLikes = readKeywordMinLikesFromInput(
      settings.keywordMinLikes,
    );
    const keywordMaxDetectedItems = readKeywordMaxDetectedItemsFromInput(
      settings.keywordMaxDetectedItems,
    );

    // 搜索页手动采集只负责本次执行；无人值守轮次由计划流程读取。
    searchCaptureCancelRequested = false;
    const searchFilters = collectSearchFiltersFromControls("search");
    const searchAutoLoop = false;

    // 手动延迟启动:只支持今天的 HH:mm,老版本 datetime-local 值仍兼容。
    const searchScheduledStr = document.getElementById("inputSearchScheduledStart")?.value || "";
    const scheduledStart = parseSearchManualScheduledStart(searchScheduledStr);
    if (scheduledStart) {
      const {targetMs, label: targetLabel} = scheduledStart;
      if (!Number.isFinite(targetMs)) {
        taskStatus = "skipped";
        showMessage("当天延迟启动时间格式不正确", "warning");
        return;
      }
      if (targetMs <= Date.now()) {
        taskStatus = "skipped";
        showMessage("当天延迟启动时间已过，请选择稍后的时间或留空立即采集", "warning");
        return;
      }
      if (targetMs > Date.now()) {
        let lastSec = -1;
        await sleepWithStop(targetMs - Date.now(), () => {
          if (searchCaptureCancelRequested) return true;
          const remain = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
          if (remain !== lastSec) {
            lastSec = remain;
            const h = Math.floor(remain / 3600);
            const m = Math.floor((remain % 3600) / 60);
            const s = remain % 60;
            showProgress(`⏰ 定时采集:将于 ${targetLabel} 开始(还剩 ${h > 0 ? h + "时" : ""}${m}分${s}秒)`, "info");
          }
          return false;
        });
        if (searchCaptureCancelRequested) {
          taskStatus = "skipped";
          showMessage("已取消定时采集", "warning");
          return;
        }
      }
    }

    if (supportsPersistentCaptureTaskPlatform(pagePlatform)) {
      const sourceTabId = await resolveCaptureTaskSourceTabId({
        preferredTabId: searchActiveTabId,
        platform: pagePlatform,
      });
      await startRequiredCaptureTaskSession({
        taskId: taskContext.taskId,
        tabId: sourceTabId,
        label: searchBatchMode
          ? `批量搜索采集 · ${searchKeywords.length} 个关键词`
          : `搜索「${keyword}」`,
        platform: pagePlatform,
      });
      captureTaskSessionStarted = true;
      persistentCaptureTaskId = taskContext.taskId;
    }

    let searchRound = 0;
    do {
      searchRound += 1;
      if (searchBatchMode) {
        // 批量多词:逐词在 runner tab(=当前 tab)采,排序/发布时间由 batchCaptureByKeywords 内部逐词应用
        activeBatchRunnerTabId = searchActiveTabId ? Number(searchActiveTabId) : null;
        const runSearchBatchAttempt = (attemptKeywords) =>
          batchCaptureByKeywords({
          keywords: [...attemptKeywords],
          platform: pagePlatform,
          baseSearchUrl: activeTabUrl,
          captureTaskId: persistentCaptureTaskId,
          searchFilters,
          captureParams: {
            minLikes: keywordMinLikes,
            sortDimension: sortContext.dimension,
            maxDetectedItems: keywordMaxDetectedItems,
            waitMinMs: settings.sharedWaitMinMs,
            waitMaxMs: settings.sharedWaitMaxMs,
            stallTimeoutMs: settings.sharedStallTimeoutMs,
            maxDurationMs: settings.sharedMaxDurationMs,
          },
          afterKeywordCapture: settings.autoDetailCaptureAfterListCapture
            ? async ({keyword: capturedKeyword, recordIds}) => {
                await refreshDataPool();
                const currentDetailSettings =
                  resolveCurrentDetailCaptureSettings(
                    await getCaptureSettings(),
                  );
                let enhanceResult = null;
                try {
                  enhanceResult = await maybeRunAutoDetailCaptureAfterListCapture(
                    currentDetailSettings,
                    {
                      sourceLabel: `关键词「${capturedKeyword}」搜索结果`,
                      recordIds,
                      relevanceKeyword: capturedKeyword,
                      captureTaskId: persistentCaptureTaskId,
                      onItemSettled: streamingSyncQueue?.enabled
                        ? (progress) =>
                            routeDetailItemToStreamingSync(
                              streamingSyncQueue,
                              progress,
                              {
                                sourceLabel: `关键词「${capturedKeyword}」笔记`,
                              },
                            )
                        : null,
                    },
                  );
                } finally {
                  if (streamingSyncQueue?.enabled) {
                    streamingSyncQueue.enqueueMissing(recordIds, {
                      sourceLabel: `关键词「${capturedKeyword}」笔记`,
                    });
                  }
                }
                if (enhanceResult?.securityBlocked) {
                  // 撞小红书风控:停掉整轮无人值守,别再往下跑(越跑越死)
                  searchCaptureCancelRequested = true;
                  taskStatus = "partial";
                  showMessage(
                    "⚠️ 触发小红书安全限制(访问频繁),已停止无人值守。建议隔较长时间(数小时)再跑。",
                    "warning",
                  );
                  return {...enhanceResult, canceled: true};
                }
                if (enhanceResult?.canceled) {
                  searchCaptureCancelRequested = true;
                  taskStatus = "partial";
                  return enhanceResult;
                }
                if (enhanceResult && enhanceResult.ok === false) {
                  taskStatus = "completed_with_failures";
                }
                const syncResult = streamingSyncQueue?.enabled
                  ? null
                  : await maybeRunAutoSyncAfterDetailCapture(
                      currentDetailSettings,
                      {
                        sourceLabel: `关键词「${capturedKeyword}」搜索结果`,
                        recordIds,
                        shouldStop: () => searchCaptureCancelRequested,
                      },
                    );
                if (syncResult && syncResult.ok === false) {
                  taskStatus = "completed_with_failures";
                }
                return enhanceResult;
              }
            : null,
          onProgress: (p) => {
            handleProgress(p);
            showProgress(
              searchAutoLoop
                ? appendStreamingSyncSummary(
                    `第 ${searchRound} 轮 · ${p?.message || ""}`,
                    streamingSyncQueue,
                  )
                : appendStreamingSyncSummary(
                    p?.message || "正在批量采集...",
                    streamingSyncQueue,
                  ),
              "info",
            );
          },
          shouldStop: () => searchCaptureCancelRequested,
        });
        const searchBatchAttemptRun = await runUnattendedKeywordAttempts({
          allKeywords: [...searchKeywords],
          initialPendingKeywords: [...searchKeywords],
          maxAttempts: pagePlatform === "douyin" ? 2 : 1,
          runAttempt: ({keywords: attemptKeywords}) =>
            runSearchBatchAttempt(attemptKeywords),
          onRetryScheduled:
            pagePlatform === "douyin"
              ? async ({keywords: retryKeywords, attempt}) => {
                  const retryDelay =
                    UNATTENDED_KEYWORD_RETRY_MIN_MS +
                    Math.random() *
                      (UNATTENDED_KEYWORD_RETRY_MAX_MS -
                        UNATTENDED_KEYWORD_RETRY_MIN_MS);
                  showProgress(
                    `${Math.ceil(retryDelay / 1000)} 秒后重试 ${retryKeywords.length} 个搜索失败的关键词（第 ${attempt}/2 次）`,
                    "info",
                  );
                  await sleepWithStop(
                    retryDelay,
                    () => searchCaptureCancelRequested,
                  );
                }
              : null,
          shouldStop: () => searchCaptureCancelRequested,
        });
        const batchResult = searchBatchAttemptRun.result;
        await refreshDataPool();
        if (batchResult?.canceled) {
          taskStatus = "partial";
          searchCaptureCancelRequested = true;
        } else {
          if ((batchResult?.stats?.failed || 0) > 0) {
            taskStatus = "completed_with_failures";
          }
        }
      } else {
        // 单词:在当前页切筛选 + 单次采集
        if (hasActiveSearchFilters(searchFilters)) {
          await applySearchFiltersOnActiveTab(searchActiveTabId, searchFilters);
          await sleepWithStop(1500, () => searchCaptureCancelRequested);
        }
        const actionResult = await runCaptureAction({
          mode: "keyword",
          captureParams: {
            keyword,
            minLikes: keywordMinLikes,
            sortDimension: sortContext.dimension,
            maxDetectedItems: keywordMaxDetectedItems,
            waitMinMs: settings.sharedWaitMinMs,
            waitMaxMs: settings.sharedWaitMaxMs,
            stallTimeoutMs: settings.sharedStallTimeoutMs,
            maxDurationMs: settings.sharedMaxDurationMs,
          },
          progressMessage: searchAutoLoop
            ? `第 ${searchRound} 轮 · 正在采集搜索结果（关键词：${keyword}）...`
            : `正在采集搜索结果（关键词：${keyword}）...`,
          successMessage: `搜索笔记采集成功，已加入缓存池（${sortLabel}≥${keywordMinLikes}，探测上限 ${keywordMaxDetectedItems}）`,
          keepProgressOpen: true,
        });

        if (actionResult?.ok) {
          const currentDetailSettings = resolveCurrentDetailCaptureSettings(
            await getCaptureSettings(),
          );
          let enhanceResult = null;
          try {
            enhanceResult = await maybeRunAutoDetailCaptureAfterListCapture(
              currentDetailSettings,
              {
                sourceLabel: "搜索结果",
                recordIds: actionResult.recordIds,
                relevanceKeyword: keyword,
                captureTaskId: persistentCaptureTaskId,
                onItemSettled: streamingSyncQueue?.enabled
                  ? (progress) =>
                      routeDetailItemToStreamingSync(
                        streamingSyncQueue,
                        progress,
                        {sourceLabel: "搜索结果笔记"},
                      )
                  : null,
              },
            );
          } finally {
            if (streamingSyncQueue?.enabled) {
              streamingSyncQueue.enqueueMissing(actionResult.recordIds, {
                sourceLabel: "搜索结果笔记",
              });
            }
          }
          if (enhanceResult?.securityBlocked) {
            searchCaptureCancelRequested = true;
            taskStatus = "partial";
            showMessage("⚠️ 触发小红书安全限制(访问频繁),已停止无人值守。建议隔较长时间(数小时)再跑。", "warning");
          } else if (enhanceResult?.canceled) {
            taskStatus = "partial";
            searchCaptureCancelRequested = true;
          } else if (enhanceResult && enhanceResult.ok === false) {
            taskStatus = "completed_with_failures";
          }
          if (!enhanceResult?.securityBlocked && !enhanceResult?.canceled) {
            const syncResult = streamingSyncQueue?.enabled
              ? null
              : await maybeRunAutoSyncAfterDetailCapture(
                  currentDetailSettings,
                  {
                    sourceLabel: "搜索结果",
                    recordIds: actionResult.recordIds,
                    shouldStop: () => searchCaptureCancelRequested,
                  },
                );
            if (syncResult && syncResult.ok === false) {
              taskStatus = "completed_with_failures";
            }
          }
        } else if (searchCaptureCancelRequested) {
          taskStatus = "partial";
        } else {
          taskStatus = "failed";
        }
      }

      // 手动采集只跑一次；批量多词的逐词执行由 batchCaptureByKeywords 负责。
      if (searchCaptureCancelRequested || !searchAutoLoop) {
        break;
      }
    } while (!searchCaptureCancelRequested);

    streamingSyncResult = await drainStreamingDetailSyncQueue(
      streamingSyncQueue,
      {
        round: searchRound,
        updateProgress: (progress) => showProgress(progress.message, "info"),
      },
    );
    streamingSyncDrained = true;
    if (Number(streamingSyncResult?.failedCount || 0) > 0) {
      taskStatus = "completed_with_failures";
    } else if (
      streamingSyncQueue?.enabled &&
      Number(streamingSyncResult?.enqueuedCount || 0) > 0 &&
      !streamingSyncResult?.blocked
    ) {
      showMessage(
        `已采数据已同步后台：成功 ${Number(streamingSyncResult?.successCount || 0)} 条，跳过 ${Number(streamingSyncResult?.skippedCount || 0)} 条`,
        "success",
      );
    }

    if (searchAutoLoop) {
      showMessage(
        `无人值守搜索采集${searchCaptureCancelRequested ? "已停止" : "结束"}:共跑 ${searchRound} 轮`,
        searchCaptureCancelRequested ? "warning" : "success",
      );
    }
  } catch (error) {
    console.error("[Sidebar] Capture search failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("操作失败: " + error.message, "error");
  } finally {
    if (streamingSyncQueue?.enabled && !streamingSyncDrained) {
      streamingSyncResult = await drainStreamingDetailSyncQueue(
        streamingSyncQueue,
      ).catch((error) => {
        console.warn("[Sidebar] Drain manual streaming sync failed:", error);
        return streamingSyncQueue.getStats();
      });
    }
    if (streamingSyncResult?.canceled && taskStatus === "completed") {
      taskStatus = "partial";
    }
    const streamingSyncTaskIssue = buildStreamingSyncTaskIssue(
      streamingSyncResult,
    );
    if (
      streamingSyncTaskIssue &&
      !searchCaptureCancelRequested &&
      taskStatus !== "failed"
    ) {
      taskStatus = "completed_with_failures";
      taskError = taskError || streamingSyncTaskIssue;
    }
    const terminal = resolveCaptureTaskTerminalStatus({
      taskStatus,
      error: taskError,
      canceled: searchCaptureCancelRequested,
    });
    if (captureTaskSessionStarted) {
      const captureTaskEnd = await endCaptureTaskSession({
        taskId: taskContext.taskId,
        ...terminal,
      });
      if (captureTaskEnd?.ok === true) {
        releaseCaptureTaskOwner(taskContext.taskId);
      }
    }
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        platform: pagePlatform,
        keyword,
        ...buildStreamingSyncTaskMetadata(streamingSyncResult),
      },
    });
    hideProgress();
    searchCaptureCancelRequested = false;
    activeBatchRunnerTabId = null;
    if (executionLock) {
      await releaseCaptureExecutionLock(executionLock.id);
    }
  }
}

function setKeywordStrategyTab(tab = "opportunity") {
  keywordStrategyActiveTab =
    tab === "longtail" || tab === "benchmark" ? tab : "opportunity";
  if (keywordStrategyActiveTab === "longtail") {
    const runtime = getCurrentRuntime();
    const pagePlatform = getPagePlatform(runtime);
    const selectedPlatform = getViewPlatform(runtime);
    if (
      runtime?.pageType === PAGE_TYPE.SEARCH_RESULTS &&
      selectedPlatform === pagePlatform &&
      getPlatformCapabilities(pagePlatform).captureSearch
    ) {
      syncSeedKeywordFromCurrentSearch(getCurrentSearchKeyword(runtime));
    } else {
      updateExpandKeywordsButtonState();
    }
    renderKeywordInsightState();
  }
  renderKeywordStrategyPanel();
}

function toggleKeywordStrategyPanel(forceVisible) {
  keywordStrategyPanelVisible =
    typeof forceVisible === "boolean"
      ? forceVisible
      : !keywordStrategyPanelVisible;
  renderKeywordStrategyPanel();
}

function formatOpportunityMetric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0";
  }
  if (numeric >= 10000) {
    return `${(numeric / 10000).toFixed(numeric >= 100000 ? 0 : 1)}w`;
  }
  return `${Math.round(numeric)}`;
}

function normalizeKeywordOpportunityTitleForMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[【】\[\]()（）"'“”‘’`]/g, "")
    .replace(/[，。！？、；：,.!?;:|｜/\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildKeywordOpportunityTitleCandidates(result) {
  const candidates = [];
  const append = (title, url) => {
    const normalizedTitle = normalizeKeywordOpportunityTitleForMatch(title);
    const normalizedUrl = String(url || "").trim();
    if (!normalizedTitle || !normalizedUrl) {
      return;
    }
    candidates.push({
      title: String(title || "").trim(),
      normalizedTitle,
      url: normalizedUrl,
    });
  };

  const storedListItems = Array.isArray(result?._listItems) ? result._listItems : [];
  storedListItems.forEach((item) => {
    append(item?.title, item?.url || item?.detailPageUrl || item?.noteUrl);
  });

  const representativeSamples = Array.isArray(result?._representativeSamples)
    ? result._representativeSamples
    : [];
  representativeSamples.forEach((item) => {
    append(item?.title, item?.url || item?.detailPageUrl || item?.noteUrl);
  });

  return candidates;
}

function resolveKeywordOpportunityTitleUrl(result, title) {
  const normalizedTitle = normalizeKeywordOpportunityTitleForMatch(title);
  if (!normalizedTitle) {
    return "";
  }

  const candidates = buildKeywordOpportunityTitleCandidates(result);
  const exactMatch = candidates.find(
    (item) => item.normalizedTitle === normalizedTitle,
  );
  if (exactMatch?.url) {
    return exactMatch.url;
  }

  const inclusiveMatch = candidates.find(
    (item) =>
      item.normalizedTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(item.normalizedTitle),
  );
  return inclusiveMatch?.url || "";
}

function normalizeBenchmarkDiscoveryItems(items = []) {
  return items
    .map((item) => {
      const authorName = String(
        item?.authorName || item?.author || item?.nickname || "",
      ).trim();
      return {
        noteId: String(item?.noteId || "").trim(),
        url: String(item?.url || item?.noteUrl || item?.detailPageUrl || "").trim(),
        title: String(item?.title || "").trim(),
        summary: String(
          item?.summary ||
            item?.desc ||
            item?.description ||
            item?.content ||
            item?.text ||
            "",
        )
          .trim()
          .slice(0, 240),
        authorName,
        authorProfileUrl: String(
          item?.authorProfileUrl ||
            item?.profileUrl ||
            item?.authorUrl ||
            item?.bloggerUrl ||
            "",
        ).trim(),
        publishTime: String(
          item?.publishTime || item?.publishDate || item?.lastEditedAt || "",
        ).trim(),
        likes: Number(item?.likes) || 0,
        comments: Number(item?.comments) || 0,
        collects: Number(item?.collects) || 0,
        noteType: String(item?.noteType || "").trim(),
        cover: String(item?.cover || item?.coverImageUrl || "").trim(),
      };
    })
    .filter((item) => item.url && item.authorName);
}

function calculateBenchmarkEngagement(item) {
  return (
    (Number(item?.likes) || 0) +
    (Number(item?.comments) || 0) +
    (Number(item?.collects) || 0)
  );
}

function averageBenchmarkValues(values = []) {
  return values.length === 0
    ? 0
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function normalizeBenchmarkProfilePayload(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }
  const followersCount =
    Number(profile.followersCount ?? profile.bloggerFollowersCount) || 0;
  const likedAndCollectedCount =
    Number(
      profile.likedAndCollectedCount ??
        profile.bloggerLikedAndCollectedCount,
    ) || 0;
  const normalized = {
    bloggerName: String(profile.bloggerName || "").trim(),
    bloggerId: String(profile.bloggerId || "").trim(),
    bloggerUrl: String(
      profile.bloggerUrl || profile.bloggerProfileUrl || "",
    ).trim(),
    avatarUrl: String(profile.avatarUrl || "").trim(),
    description: String(profile.description || "").trim(),
    followersCount,
    likedAndCollectedCount,
    bloggerAccountType: String(profile.bloggerAccountType || "").trim(),
    captureStatus: String(profile.bloggerMetricsCaptureStatus || "").trim(),
    captureError: String(profile.bloggerMetricsCaptureError || "").trim(),
  };

  if (
    !normalized.description &&
    !normalized.followersCount &&
    !normalized.likedAndCollectedCount &&
    !normalized.bloggerName
  ) {
    return null;
  }
  return normalized;
}

function buildBenchmarkDiscoveryRuleReason(candidate) {
  const followersCount = Number(candidate.profile?.followersCount) || 0;
  const isLowFollower = followersCount > 0 && followersCount <= 50000;
  const hasHighPerformance =
    candidate.maxLikes >= 5000 || candidate.averageLikes >= 800;
  const likeFollowerRatio =
    followersCount > 0 ? candidate.maxLikes / followersCount : 0;
  const isLowFollowerBreakout =
    isLowFollower && (hasHighPerformance || likeFollowerRatio >= 0.1);
  let judgment = "可作为观察对象";
  if (isLowFollowerBreakout) {
    judgment = "有低粉爆款信号，适合优先对标它的选题切口";
  } else if (candidate.performanceDensity === "stable") {
    judgment = "多篇内容表现稳定，适合看它如何持续切同一类需求";
  } else if (candidate.performanceDensity === "spike") {
    judgment = "有明显爆款样本，适合拆解单篇选题为什么成立";
  } else {
    judgment = "在当前搜索词下重复露出，可以先作为备选对标";
  }

  return `${judgment}。`;
}

function buildBenchmarkDiscoveryFocusAssessment(candidate) {
  const description = String(candidate.profile?.description || "").trim();
  const titles = Array.isArray(candidate.topItems)
    ? candidate.topItems.map((item) => item.title).filter(Boolean)
    : [];
  if (!description) {
    return titles.length > 1
      ? "当前先按代表内容判断方向关联，主页资料不足时需要打开主页复核。"
      : "当前只能按搜索样本判断，方向关联需要打开主页复核。";
  }
  if (titles.length > 1) {
    return "已结合主页定位和代表内容判断账号是否围绕同一类需求持续产出。";
  }
  return "已结合主页定位判断账号是否适合作为这个方向的对标。";
}

function buildBenchmarkDiscoveryDecisionAngle(candidate, analysis = {}) {
  const followersCount = Number(candidate.profile?.followersCount) || 0;
  const likeFollowerRatio =
    followersCount > 0 && Number(candidate.maxLikes) > 0
      ? candidate.maxLikes / followersCount
      : 0;
  const isLowFollowerBreakout =
    followersCount > 0 &&
    followersCount <= 50000 &&
    (candidate.maxLikes >= 5000 ||
      candidate.averageLikes >= 800 ||
      likeFollowerRatio >= 0.1);
  if (analysis.growthPotential === "high" || isLowFollowerBreakout) {
    return "判断角度：低粉爆款信号、普通账号可复制性";
  }
  if (candidate.performanceDensity === "stable") {
    return "判断角度：持续产出能力、赛道聚焦度";
  }
  if (candidate.performanceDensity === "spike") {
    return "判断角度：单篇爆款选题、内容切口可拆解性";
  }
  return "判断角度：方向相关性、是否值得持续观察";
}

function buildBenchmarkDiscoveryFallbackAnalysis(candidate) {
  return {
    key: candidate.key,
    recommendationReason: buildBenchmarkDiscoveryRuleReason(candidate),
    focusAssessment: buildBenchmarkDiscoveryFocusAssessment(candidate),
    growthPotential:
      (Number(candidate.profile?.followersCount) || 0) > 0 &&
      (Number(candidate.profile?.followersCount) || 0) <= 50000 &&
      candidate.averageLikes >= 800
        ? "high"
        : candidate.performanceDensity === "stable"
          ? "medium"
          : "low",
    tags: [
      candidate.performanceDensity === "stable" ? "多篇稳定" : "样本重复",
      (Number(candidate.profile?.followersCount) || 0) > 0 &&
      (Number(candidate.profile?.followersCount) || 0) <= 50000
        ? "低粉爆款观察"
        : "方向相关",
    ],
  };
}

function buildBenchmarkDiscoveryCandidates(
  items = [],
  {keyword = "", platform = ""} = {},
) {
  const normalizedItems = normalizeBenchmarkDiscoveryItems(items);
  const groups = new Map();

  normalizedItems.forEach((item) => {
    const key = String(item.authorProfileUrl || item.authorName).trim();
    if (!key) {
      return;
    }
    const previous = groups.get(key) || {
      key,
      authorName: item.authorName,
      authorProfileUrl: item.authorProfileUrl,
      items: [],
    };
    if (!previous.authorProfileUrl && item.authorProfileUrl) {
      previous.authorProfileUrl = item.authorProfileUrl;
    }
    previous.items.push(item);
    groups.set(key, previous);
  });

  const grouped = Array.from(groups.values());
  const twoPlusCount = grouped.filter((group) => group.items.length >= 2).length;
  let minOccurrence = twoPlusCount > BENCHMARK_DISCOVERY_RESULT_LIMIT ? 3 : 2;
  if (!grouped.some((group) => group.items.length >= minOccurrence)) {
    minOccurrence = 2;
  }

  const candidates = grouped
    .filter((group) => group.items.length >= minOccurrence)
    .map((group) => {
      const sortedItems = [...group.items].sort(
        (left, right) =>
          calculateBenchmarkEngagement(right) -
          calculateBenchmarkEngagement(left),
      );
      const likes = sortedItems.map((item) => Number(item.likes) || 0);
      const comments = sortedItems.map((item) => Number(item.comments) || 0);
      const collects = sortedItems.map((item) => Number(item.collects) || 0);
      const totalEngagement = sortedItems.reduce(
        (sum, item) => sum + calculateBenchmarkEngagement(item),
        0,
      );
      const avgEngagement = Math.round(totalEngagement / sortedItems.length);
      const maxLikes = Math.max(...likes, 0);
      const averageLikes = averageBenchmarkValues(likes);
      const averageComments = averageBenchmarkValues(comments);
      const averageCollects = averageBenchmarkValues(collects);
      const performanceDensity =
        sortedItems.length >= 3 && averageLikes >= 100
          ? "stable"
          : maxLikes >= Math.max(averageLikes * 2, 200)
            ? "spike"
            : "observed";
      const score =
        sortedItems.length * 1000000 +
        Math.min(maxLikes, 999999) +
        avgEngagement * 0.2 +
        (performanceDensity === "stable" ? 50000 : 0);
      const candidate = {
        key: group.key,
        keyword,
        platform,
        authorName: group.authorName,
        authorProfileUrl: group.authorProfileUrl,
        occurrenceCount: sortedItems.length,
        minOccurrence,
        maxLikes,
        averageLikes,
        averageComments,
        averageCollects,
        avgEngagement,
        totalEngagement,
        performanceDensity,
        profile: null,
        profileCaptureStatus: group.authorProfileUrl ? "pending" : "missing_url",
        profileCaptureError: "",
        topItems: sortedItems.slice(0, 4),
        score,
      };
      return {
        ...candidate,
        analysis: buildBenchmarkDiscoveryFallbackAnalysis(candidate),
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, BENCHMARK_DISCOVERY_RESULT_LIMIT);

  return {
    keyword,
    platform,
    sampleCount: normalizedItems.length,
    candidateCount: candidates.length,
    minOccurrence,
    profileLimit: BENCHMARK_DISCOVERY_PROFILE_LIMIT,
    generatedAt: Date.now(),
    aiStatus: "not_run",
    aiError: "",
    candidates,
  };
}

function mergeBenchmarkProfilesIntoResult(result, profileByKey) {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  return {
    ...result,
    candidates: candidates.map((candidate) => {
      const patch = profileByKey.get(candidate.key);
      const next = patch
        ? {
            ...candidate,
            ...patch,
          }
        : candidate;
      return {
        ...next,
        analysis: buildBenchmarkDiscoveryFallbackAnalysis(next),
      };
    }),
  };
}

function mergeBenchmarkAiAnalysisIntoResult(result, aiData) {
  const analyses = Array.isArray(aiData?.candidateAnalyses)
    ? aiData.candidateAnalyses
    : [];
  const analysisByKey = new Map(
    analyses
      .filter((item) => item?.key)
      .map((item) => [String(item.key), item]),
  );

  return {
    ...result,
    aiStatus: analyses.length > 0 ? "done" : "empty",
    aiError: "",
    candidates: (Array.isArray(result?.candidates) ? result.candidates : []).map(
      (candidate) => {
        const ai = analysisByKey.get(candidate.key);
        if (!ai) {
          return candidate;
        }
        return {
          ...candidate,
          analysis: {
            ...candidate.analysis,
            recommendationReason:
              String(ai.recommendationReason || "").trim() ||
              candidate.analysis?.recommendationReason ||
              buildBenchmarkDiscoveryRuleReason(candidate),
            focusAssessment:
              String(ai.focusAssessment || "").trim() ||
              candidate.analysis?.focusAssessment ||
              buildBenchmarkDiscoveryFocusAssessment(candidate),
            growthPotential:
              ai.growthPotential === "high" ||
              ai.growthPotential === "medium" ||
              ai.growthPotential === "low"
                ? ai.growthPotential
                : candidate.analysis?.growthPotential || "medium",
            tags: Array.isArray(ai.tags) && ai.tags.length > 0
              ? ai.tags.slice(0, 4)
              : candidate.analysis?.tags || [],
          },
        };
      },
    ),
  };
}

function renderKeywordStrategyLoadingState({
  title = "正在分析",
  meta = "正在整理数据并生成判断，请稍候",
} = {}) {
  return `
    <div class="keyword-insight-summary-card keyword-strategy-loading-card is-loading">
      <div class="keyword-insight-summary-title">
        <span class="keyword-insight-loading-spinner" aria-hidden="true"></span>
        ${escapeHtml(title)}
      </div>
      <div class="keyword-insight-summary-meta">${escapeHtml(meta)}</div>
    </div>
  `;
}

function setKeywordBenchmarkLoading(title, meta) {
  keywordBenchmarkAnalysisStatus = "loading";
  keywordBenchmarkLoadingTitle = title;
  keywordBenchmarkLoadingMeta = meta;
  renderKeywordStrategyPanel();
}

function renderBenchmarkDiscoveryResult() {
  if (keywordBenchmarkAnalysisStatus === "loading") {
    return renderKeywordStrategyLoadingState({
      title: keywordBenchmarkLoadingTitle || "正在找对标账号",
      meta:
        keywordBenchmarkLoadingMeta ||
        "正在采集样本、补采账号主页并生成推荐判断",
    });
  }

  const result = keywordBenchmarkResult;
  if (!result) {
    return "";
  }
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const potentialLabels = {
    high: "优先对标",
    medium: "可观察",
    low: "先复核",
  };
  const candidateHtml =
    candidates.length > 0
      ? candidates
          .map((candidate, index) => {
            const profile = candidate.profile || null;
            const analysis = candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
            const recommendationReason =
              analysis.recommendationReason ||
              buildBenchmarkDiscoveryRuleReason(candidate);
            const decisionAngle = buildBenchmarkDiscoveryDecisionAngle(
              candidate,
              analysis,
            );
            const evidenceItems = buildBenchmarkDiscoveryCandidateEvidence(
              candidate,
            );
            const representativeWorks =
              buildBenchmarkDiscoveryRepresentativeWorks(candidate, 3);
            return `
              <div class="keyword-benchmark-card">
                <div class="keyword-benchmark-card-head">
                  <div class="keyword-benchmark-rank">#${index + 1}</div>
                  <div class="keyword-benchmark-account">
                    <div class="keyword-benchmark-name">${escapeHtml(profile?.bloggerName || candidate.authorName || "未知账号")}</div>
                    <div class="keyword-benchmark-conclusion">${escapeHtml(recommendationReason)}</div>
                    <div class="keyword-benchmark-angle">${escapeHtml(decisionAngle)}</div>
                  </div>
                </div>
                <div class="keyword-benchmark-tags">
                  <span class="keyword-benchmark-potential keyword-benchmark-potential-${escapeHtml(analysis.growthPotential || "medium")}">${escapeHtml(potentialLabels[analysis.growthPotential] || "观察")}</span>
                  ${(Array.isArray(analysis.tags) ? analysis.tags : [])
                    .map((tag) => `<span>${escapeHtml(tag)}</span>`)
                    .join("")}
                </div>
                <div class="keyword-benchmark-evidence">
                  <div class="keyword-benchmark-section-title">判断依据</div>
                  ${analysis.focusAssessment ? `<p>${escapeHtml(analysis.focusAssessment)}</p>` : ""}
                  <ul>
                    ${evidenceItems
                      .map((item) => `<li>${escapeHtml(item)}</li>`)
                      .join("")}
                  </ul>
                </div>
                ${
                  representativeWorks.length > 0
                    ? `<div class="keyword-benchmark-work-list">
                        <div class="keyword-benchmark-section-title">代表作品</div>
                        <ul>
                          ${representativeWorks
                            .map(
                              (item) => `
                                <li>
                                  ${
                                    item.url
                                      ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>`
                                      : `<span>${escapeHtml(item.title)}</span>`
                                  }
                                  <em>赞 ${escapeHtml(formatOpportunityMetric(item.likes))}${item.collects ? ` · 藏 ${escapeHtml(formatOpportunityMetric(item.collects))}` : ""}</em>
                                </li>
                              `,
                            )
                            .join("")}
                        </ul>
                      </div>`
                    : ""
                }
                <div class="keyword-benchmark-actions">
                  ${
                    candidate.authorProfileUrl
                      ? `<button type="button" class="keyword-benchmark-action keyword-benchmark-action-primary" data-action="monitor-benchmark-account" data-url="${escapeHtml(candidate.authorProfileUrl)}" data-name="${escapeHtml(profile?.bloggerName || candidate.authorName || "")}">纳入监控</button>`
                      : ""
                  }
                  ${
                    candidate.authorProfileUrl
                      ? `<button type="button" class="keyword-benchmark-action" data-action="open-benchmark-profile" data-url="${escapeHtml(candidate.authorProfileUrl)}">打开主页</button>`
                      : ""
                  }
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="keyword-benchmark-empty">当前样本里还没有出现 ${Number(result.minOccurrence) || 2} 次以上的账号。可以换一个更明确的主词，或扩大采样后再试。</div>`;

  return `
    <section class="keyword-benchmark-summary">
      <div class="keyword-benchmark-summary-head">
        <div>
          <div class="keyword-opportunity-keyword">${escapeHtml(result.keyword || "")}</div>
          <div class="keyword-benchmark-summary-text">
            已从 ${Number(result.sampleCount) || 0} 条搜索结果中筛出 ${Number(result.candidateCount) || 0} 个候选账号；当前入围门槛为样本出现 ${Number(result.minOccurrence) || 2} 次，优先结合账号主页、粉丝量级和代表内容判断是否值得对标。
          </div>
        </div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-benchmark">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-benchmark-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">候选账号</div>
      <div class="keyword-benchmark-list">${candidateHtml}</div>
    </section>
  `;
}

function renderKeywordOpportunityResult() {
  const result = keywordOpportunityResult;
  if (!result) {
    return "";
  }

  const ruleMetrics = result.ruleMetrics || {};
  const topicDirections = Array.isArray(result.hotTopicDirections)
    ? result.hotTopicDirections
    : [];
  const recommendedAngles = Array.isArray(result.recommendedAngles)
    ? result.recommendedAngles
    : [];
  const subtopics = Array.isArray(result.coreWinningSubtopics)
    ? result.coreWinningSubtopics
    : [];

  const metrics = [
    {
      label: "热度",
      value:
        ruleMetrics.heatLevel === "high"
          ? "高"
          : ruleMetrics.heatLevel === "medium"
            ? "中"
            : "低",
      desc:
        "看这个词里最能打的一批内容，整体大概能冲到多高。越高，说明这个词更容易出大爆款。",
    },
    {
      label: "高位区间",
      value:
        ruleMetrics.highBandEnd > 0
          ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
          : "未识别",
      desc:
        "表示前几名内容明显更强，通常是第几名到第几名。比如 1-6，就是前 6 条表现特别突出。",
    },
    {
      label: "断层跌幅",
      value:
        ruleMetrics.cliffDropRatio > 0
          ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
          : "不明显",
      desc:
        "看前排内容和后面内容差得有多大。越大，说明流量越集中在少数几条爆款上。",
    },
    {
      label: "高位均赞",
      value: formatOpportunityMetric(ruleMetrics.highBandAvgLikes),
      desc:
        "前排爆款内容的平均点赞数，可以理解为这个词做得好的内容，通常能拿到多少赞。",
    },
    {
      label: "中位赞",
      value: formatOpportunityMetric(ruleMetrics.medianLikes),
      desc:
        "把所有内容按点赞从高到低排，取中间那条的点赞数。可以理解为普通内容大概是什么水平。",
    },
  ];

  const bandPresenceLabels = {
    high: "高赞区",
    mid: "中赞区",
    low: "低赞区",
    high_mid: "高赞区+中赞区",
    mid_low: "中赞区+低赞区",
    all: "高赞区+中赞区+低赞区",
  };

  const organicViabilityLabels = {
    high: "自然流可行性高",
    medium: "自然流可行性中",
    low: "自然流可行性低",
  };

  const topicHtml =
    topicDirections.length > 0
      ? topicDirections
          .map((direction) => {
            const titles = Array.isArray(direction.representativeTitles)
              ? direction.representativeTitles
              : [];
            const bandLabel = bandPresenceLabels[direction.bandPresence] || "";
            const viability = direction.organicViability || "medium";
            const viabilityLabel = organicViabilityLabels[viability] || "";
            const avgLikesValue = Number(direction.avgLikes) || 0;
            return `
              <div class="keyword-opportunity-topic-card">
                <div class="keyword-opportunity-topic-name">${escapeHtml(direction.name || "未命名类目")}</div>
                <div class="keyword-opportunity-topic-meta">
                  ${bandLabel ? `<span class="keyword-opportunity-band-tag keyword-opportunity-band-${escapeHtml(direction.bandPresence || "all")}">${escapeHtml(bandLabel)}</span>` : ""}
                  <span class="keyword-opportunity-organic-tag keyword-opportunity-organic-${escapeHtml(viability)}">${escapeHtml(viabilityLabel)}</span>
                  <span class="keyword-opportunity-topic-stats">${Number(direction.sampleCount) || 0} 篇 · ${Math.round((Number(direction.shareRatio) || 0) * 100)}%${avgLikesValue > 0 ? ` · 均赞 ${formatOpportunityMetric(avgLikesValue)}` : ""}</span>
                </div>
                ${direction.userIntent ? `<div class="keyword-opportunity-topic-intent"><span class="keyword-opportunity-topic-intent-label">用户意图</span>${escapeHtml(direction.userIntent)}</div>` : ""}
                <div class="keyword-opportunity-topic-reason">${escapeHtml(direction.whyItWorks || "")}</div>
                ${direction.organicNote ? `<div class="keyword-opportunity-topic-organic-note">${escapeHtml(direction.organicNote)}</div>` : ""}
                ${
                  titles.length > 0
                    ? `<div class="keyword-opportunity-topic-titles">
                        <div class="keyword-opportunity-topic-titles-label">代表标题</div>
                        <ul class="keyword-opportunity-topic-title-list">
                          ${titles
                            .map((t) => {
                              const matchUrl = resolveKeywordOpportunityTitleUrl(
                                result,
                                t,
                              );
                              return matchUrl
                                ? `<li><a href="${escapeHtml(matchUrl)}" class="keyword-opportunity-title-link" target="_blank" rel="noopener">${escapeHtml(t)}</a></li>`
                                : `<li>${escapeHtml(t)}</li>`;
                            })
                            .join("")}
                        </ul>
                      </div>`
                    : ""
                }
              </div>
            `;
          })
          .join("")
      : `<div class="keyword-opportunity-topic-card"><div class="keyword-opportunity-topic-reason">当前样本中还没有稳定聚合出足够清晰的内容类目，建议结合长尾词继续下钻。</div></div>`;

  const angleHtml =
    recommendedAngles.length > 0
      ? recommendedAngles
          .map(
            (angle) => `
              <div class="keyword-opportunity-angle-card">
                <div class="keyword-opportunity-angle-head">
                  <div class="keyword-opportunity-angle-title">${escapeHtml(angle.title || "未命名选题")}</div>
                </div>
                <div class="keyword-opportunity-angle-body">
                  ${angle.audiencePainPoint ? `<div class="keyword-opportunity-angle-field">${escapeHtml(angle.audiencePainPoint)}</div>` : ""}
                  ${angle.formatSuggestion ? `<div class="keyword-opportunity-angle-field"><span class="keyword-opportunity-angle-field-label">形式建议</span>${escapeHtml(angle.formatSuggestion)}</div>` : ""}
                  ${angle.executionHint ? `<div class="keyword-opportunity-angle-field"><span class="keyword-opportunity-angle-field-label">执行提示</span>${escapeHtml(angle.executionHint)}</div>` : ""}
                </div>
              </div>
            `,
          )
          .join("")
      : `<div class="keyword-opportunity-angle-card"><div class="keyword-opportunity-angle-body">当前还没有生成可执行选题，建议先用分析长尾需求验证更具体的切口。</div></div>`;

  const subtopicHtml =
    subtopics.length > 0
      ? subtopics
          .map(
            (item) =>
              `<span class="keyword-opportunity-chip">${escapeHtml(item)}</span>`,
          )
          .join("")
      : `<span class="keyword-opportunity-chip">暂无明确细分切口</span>`;

  return `
    <section class="keyword-opportunity-summary">
      <div class="keyword-opportunity-summary-head">
        <div class="keyword-opportunity-summary-head-left">
          <div class="keyword-opportunity-keyword">${escapeHtml(result.keyword || "")}</div>
        </div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-opportunity">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-opportunity-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="keyword-opportunity-summary-distribution">${escapeHtml(result.distributionSummary || "")}</div>
      <div class="keyword-opportunity-metrics">
        ${metrics
          .map(
            (metric) => `
              <div class="keyword-opportunity-metric">
                <div class="keyword-opportunity-metric-label-row">
                  <div class="keyword-opportunity-metric-label">${escapeHtml(metric.label)}</div>
                  <span class="auth-help-popover-wrap keyword-opportunity-help-wrap">
                    <button
                      type="button"
                      class="auth-help-trigger keyword-opportunity-help-trigger"
                      aria-label="查看${escapeHtml(metric.label)}说明">
                      ?
                    </button>
                    <span
                      class="auth-help-popover keyword-opportunity-help-popover"
                      role="tooltip">
                      ${escapeHtml(metric.desc)}
                    </span>
                  </span>
                </div>
                <div class="keyword-opportunity-metric-value">${escapeHtml(metric.value)}</div>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">内容分布全景</div>
      <div class="keyword-opportunity-topic-list">${topicHtml}</div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">核心爆款细分词</div>
      <div class="keyword-opportunity-chip-list">${subtopicHtml}</div>
    </section>
    <section class="keyword-opportunity-block">
      <div class="keyword-opportunity-block-title">新号优先选题</div>
      <div class="keyword-opportunity-angle-list">${angleHtml}</div>
    </section>
  `;
}

function renderKeywordStrategyPanel() {
  const overlay = document.getElementById("keywordStrategyModalOverlay");
  const btnToggle = document.getElementById("btnToggleKeywordStrategy");
  const btnRun = document.getElementById("btnRunKeywordOpportunity");
  const btnBenchmarkRun = document.getElementById("btnRunBenchmarkDiscovery");
  const btnBenchmarkTab = document.getElementById(
    "btnKeywordStrategyTabBenchmark",
  );
  const btnOpportunityTab = document.getElementById(
    "btnKeywordStrategyTabOpportunity",
  );
  const btnLongtailTab = document.getElementById(
    "btnKeywordStrategyTabLongtail",
  );
  const opportunityPane = document.getElementById(
    "keywordStrategyOpportunityPane",
  );
  const benchmarkPane = document.getElementById("keywordStrategyBenchmarkPane");
  const longtailPane = document.getElementById("keywordStrategyLongtailPane");
  const longtailHint = document.getElementById("keywordStrategyLongtailHint");
  const benchmarkErrorEl = document.getElementById("keywordBenchmarkError");
  const benchmarkResultEl = document.getElementById("keywordBenchmarkResult");
  const errorEl = document.getElementById("keywordOpportunityError");
  const resultEl = document.getElementById("keywordOpportunityResult");
  if (!overlay) {
    return;
  }

  const runtime = getCurrentRuntime();
  const currentKeyword = getCurrentSearchKeyword(runtime);
  const pagePlatform = getPagePlatform(runtime);
  const selectedPlatform = getViewPlatform(runtime);
  const visible =
    keywordStrategyPanelVisible &&
    runtime?.pageType === PAGE_TYPE.SEARCH_RESULTS &&
    selectedPlatform === pagePlatform &&
    getPlatformCapabilities(pagePlatform).captureSearch;
  overlay.classList.toggle("is-active", visible);
  overlay.ariaHidden = visible ? "false" : "true";

  if (btnToggle) {
    btnToggle.disabled =
      runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS ||
      selectedPlatform !== pagePlatform ||
      !getPlatformCapabilities(pagePlatform).captureSearch;
    btnToggle.classList.toggle("is-disabled", btnToggle.disabled);
    btnToggle.title = "赛道策略";
  }

  if (!visible) {
    return;
  }

  const isBenchmark = keywordStrategyActiveTab === "benchmark";
  const isOpportunity = keywordStrategyActiveTab === "opportunity";
  const isLongtail = keywordStrategyActiveTab === "longtail";
  if (btnBenchmarkTab) {
    btnBenchmarkTab.classList.toggle("is-active", isBenchmark);
    btnBenchmarkTab.setAttribute(
      "aria-selected",
      isBenchmark ? "true" : "false",
    );
  }
  if (btnOpportunityTab) {
    btnOpportunityTab.classList.toggle("is-active", isOpportunity);
    btnOpportunityTab.setAttribute(
      "aria-selected",
      isOpportunity ? "true" : "false",
    );
  }
  if (btnLongtailTab) {
    btnLongtailTab.classList.toggle("is-active", isLongtail);
    btnLongtailTab.setAttribute(
      "aria-selected",
      isLongtail ? "true" : "false",
    );
  }
  if (benchmarkPane) {
    benchmarkPane.hidden = !isBenchmark;
  }
  if (opportunityPane) {
    opportunityPane.hidden = !isOpportunity;
  }
  if (longtailPane) {
    longtailPane.hidden = !isLongtail;
  }

  if (longtailHint) {
    const resultKeyword = getKeywordOpportunityKeyword();
    if (currentKeyword && resultKeyword && currentKeyword !== resultKeyword) {
      longtailHint.textContent = `当前搜索词是「${currentKeyword}」，当前判断结果保留自「${resultKeyword}」。`;
    } else if (isBenchmark && currentKeyword) {
      longtailHint.textContent = `当前搜索词「${currentKeyword}」可用来找对标账号，也可以继续判断赛道机会和分析长尾需求。`;
    } else if (currentKeyword) {
      longtailHint.textContent = `当前搜索词「${currentKeyword}」可以判断赛道机会、找对标账号和分析长尾需求。`;
    } else if (resultKeyword) {
      longtailHint.textContent = `当前判断结果保留自「${resultKeyword}」，切回搜索页后可重新分析。`;
    } else {
      longtailHint.textContent = "先判断赛道机会，再找对标账号和分析长尾需求。";
    }
  }
  const btnBenchmarkCancel = document.getElementById("btnCancelBenchmarkDiscovery");
  const btnBenchmarkClear = document.getElementById(
    "btnClearBenchmarkDiscoveryResult",
  );
  if (btnBenchmarkRun) {
    btnBenchmarkRun.disabled =
      keywordBenchmarkInFlight || keywordOpportunityInFlight || !currentKeyword;
    btnBenchmarkRun.classList.toggle("is-disabled", btnBenchmarkRun.disabled);
    btnBenchmarkRun.textContent = keywordBenchmarkInFlight
      ? "查找中..."
      : "开始找对标账号";
    btnBenchmarkRun.style.display = keywordBenchmarkInFlight
      ? "none"
      : "inline-flex";
  }
  if (btnBenchmarkCancel) {
    btnBenchmarkCancel.style.display = keywordBenchmarkInFlight
      ? "inline-flex"
      : "none";
  }
  if (btnBenchmarkClear) {
    btnBenchmarkClear.hidden =
      (!keywordBenchmarkResult &&
        !String(keywordBenchmarkErrorMessage || "").trim() &&
        keywordBenchmarkAnalysisStatus !== "loading") ||
      keywordBenchmarkInFlight;
  }
  if (benchmarkErrorEl) {
    benchmarkErrorEl.hidden = !keywordBenchmarkErrorMessage;
    benchmarkErrorEl.textContent = keywordBenchmarkErrorMessage;
  }
  const benchmarkIntroTextEl = document.getElementById(
    "keywordBenchmarkIntroText",
  );
  if (benchmarkIntroTextEl) {
    benchmarkIntroTextEl.hidden =
      !!keywordBenchmarkResult || keywordBenchmarkAnalysisStatus === "loading";
  }
  if (benchmarkResultEl) {
    benchmarkResultEl.innerHTML = renderBenchmarkDiscoveryResult();
  }
  const btnCancel = document.getElementById("btnCancelKeywordOpportunity");
  const btnClear = document.getElementById("btnClearKeywordOpportunityResult");
  if (btnRun) {
    btnRun.disabled = keywordOpportunityInFlight || !currentKeyword;
    btnRun.classList.toggle("is-disabled", btnRun.disabled);
    btnRun.textContent = keywordOpportunityInFlight
      ? "分析中..."
      : "开始判断赛道机会";
    btnRun.style.display = keywordOpportunityInFlight ? "none" : "inline-flex";
  }
  if (btnCancel) {
    btnCancel.style.display = keywordOpportunityInFlight
      ? "inline-flex"
      : "none";
  }
  if (btnClear) {
    btnClear.hidden =
      (!keywordOpportunityResult &&
        !String(keywordOpportunityErrorMessage || "").trim()) ||
      keywordOpportunityInFlight;
  }
  if (errorEl) {
    errorEl.hidden = !keywordOpportunityErrorMessage;
    errorEl.textContent = keywordOpportunityErrorMessage;
  }
  const introTextEl = document.getElementById("keywordOpportunityIntroText");
  if (introTextEl) {
    introTextEl.hidden = !!keywordOpportunityResult || keywordOpportunityInFlight;
  }
  if (resultEl) {
    resultEl.innerHTML =
      keywordOpportunityInFlight && !keywordOpportunityResult
        ? renderKeywordStrategyLoadingState({
            title: "正在判断赛道机会",
            meta:
              "正在采集主词样本并生成内容机会判断，通常需要 1-2 分钟",
          })
        : renderKeywordOpportunityResult();
  }
}

function buildKeywordOpportunityInputItems(items = []) {
  return items
    .map((item) => ({
      noteId: String(item?.noteId || "").trim(),
      url: String(item?.url || "").trim(),
      title: String(item?.title || "").trim(),
      authorName: String(
        item?.authorName || item?.author || item?.nickname || "",
      ).trim(),
      publishTime: String(
        item?.publishTime || item?.publishDate || item?.lastEditedAt || "",
      ).trim(),
      likes: Number(item?.likes) || 0,
      comments: Number(item?.comments) || 0,
      collects: Number(item?.collects) || 0,
      noteType: String(item?.noteType || "").trim(),
      cover: String(item?.cover || item?.coverImageUrl || "").trim(),
    }))
    .filter((item) => item.url);
}

function analyzeKeywordOpportunityRules(items = []) {
  const normalizedItems = buildKeywordOpportunityInputItems(items).sort(
    (left, right) => right.likes - left.likes,
  );
  const likes = normalizedItems.map((item) =>
    Math.max(0, Number(item.likes) || 0),
  );
  const average = (values) =>
    values.length === 0
      ? 0
      : Math.round(
          values.reduce((sum, value) => sum + value, 0) / values.length,
        );
  const percentile = (values, p) => {
    if (values.length === 0) {
      return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * p) - 1),
    );
    return sorted[index] || 0;
  };

  const maxLikes = likes[0] || 0;
  const top5AvgLikes = average(likes.slice(0, 5));
  const top10AvgLikes = average(likes.slice(0, 10));
  const medianLikes = percentile(likes, 0.5);
  const p80Likes = percentile(likes, 0.8);
  const p90Likes = percentile(likes, 0.9);

  let cliffIndex = 0;
  let cliffDropRatio = 0;
  likes.slice(0, Math.min(20, likes.length) - 1).forEach((current, index) => {
    const next = likes[index + 1] || 0;
    if (current <= 0) {
      return;
    }
    const dropRatio = (current - next) / current;
    const prefixCount = index + 1;
    const prefixAvg = average(likes.slice(0, prefixCount));
    if (prefixCount < 3) {
      return;
    }
    if (prefixAvg < Math.max(medianLikes * 1.5, 200)) {
      return;
    }
    if (dropRatio >= 0.25 && dropRatio > cliffDropRatio) {
      cliffDropRatio = dropRatio;
      cliffIndex = prefixCount;
    }
  });

  const fallbackHighBandCount = Math.min(
    12,
    Math.max(5, Math.ceil(normalizedItems.length * 0.1)),
  );
  const highBandCount =
    cliffIndex > 0
      ? cliffIndex
      : Math.min(normalizedItems.length, fallbackHighBandCount);

  return {
    sortedItems: normalizedItems,
    highBandCount,
    cliffIndex,
    cliffDropRatio,
    maxLikes,
    top5AvgLikes,
    top10AvgLikes,
    medianLikes,
    p80Likes,
    p90Likes,
    highBandAvgLikes: average(likes.slice(0, highBandCount)),
    midBandAvgLikes: average(
      likes.slice(
        highBandCount,
        Math.min(normalizedItems.length, highBandCount * 2),
      ),
    ),
  };
}

function selectKeywordOpportunitySamples(items = []) {
  const analysis = analyzeKeywordOpportunityRules(items);
  const all = analysis.sortedItems;
  const highEnd = analysis.highBandCount;
  const midEnd = Math.max(highEnd, Math.ceil(all.length / 2));

  const highBand = all.slice(0, highEnd);
  const midBand = all.slice(highEnd, midEnd);
  const lowBand = all.slice(midEnd);

  const selectedIndexes = new Set();
  const selected = [];
  const pick = (item) => {
    const key = item?.noteId || item?.url || "";
    if (!key || selectedIndexes.has(key)) {
      return;
    }
    selectedIndexes.add(key);
    selected.push(item);
  };

  for (let i = 0; i < Math.min(5, highBand.length); i += 1) {
    pick(highBand[i]);
  }
  if (highBand.length > 6) {
    pick(highBand[Math.floor(highBand.length / 2)]);
    pick(highBand[highBand.length - 1]);
  }

  for (let i = 0; i < Math.min(3, midBand.length); i += 1) {
    pick(midBand[i]);
  }
  if (midBand.length > 4) {
    pick(midBand[Math.floor(midBand.length / 2)]);
  }

  for (let i = 0; i < Math.min(2, lowBand.length); i += 1) {
    pick(lowBand[i]);
  }
  if (lowBand.length > 3) {
    pick(lowBand[Math.floor(lowBand.length / 2)]);
  }

  return selected.slice(0, 15);
}

async function waitForTabComplete(
  tabId,
  {timeoutMs = 15000, settleMs = 1200} = {},
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === "complete") {
      if (settleMs > 0) {
        await wait(settleMs);
      }
      return tab;
    }
    await wait(250);
  }
  throw new Error("页面加载超时，请稍后重试");
}

async function prepareKeywordStrategyCapture(tabId) {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.RELAY_TO_CONTENT,
    tabId,
    payload: {
      action: "prepareKeywordStrategyCapture",
    },
  });

  const result =
    response?.data && typeof response.data === "object" && "ok" in response.data
      ? response.data
      : response;

  if (!response?.ok || !result?.ok) {
    throw new Error(
      result?.error?.message ||
        response?.error?.message ||
        "页面筛选条件切换失败",
    );
  }

  return result?.data || {};
}

async function captureKeywordOpportunitySamples({
  sourceTabId,
  sourceTabUrl,
  sampleItems,
  initialSamples = [],
  onSampleCaptured = null,
  shouldStop = null,
}) {
  if (!sourceTabUrl) {
    throw new Error("未找到当前搜索页链接");
  }
  if (!Number.isFinite(Number(sourceTabId)) || Number(sourceTabId) <= 0) {
    throw new Error("未找到当前搜索页标签");
  }

  const sampleKeyFor = (item) => String(item?.noteId || item?.url || "").trim();
  const samples = normalizeRepresentativeSampleItems(initialSamples);
  const completedSampleKeys = new Set(samples.map((item) => sampleKeyFor(item)));
  try {
    for (let index = 0; index < sampleItems.length; index += 1) {
      const item = sampleItems[index];
      if (typeof shouldStop === "function" && shouldStop()) {
        throw new Error("已取消判断赛道机会");
      }
      const sampleKey = sampleKeyFor(item);
      if (sampleKey && completedSampleKeys.has(sampleKey)) {
        continue;
      }
      const completedCount = completedSampleKeys.size;
      showProgress(
        `正在当前页面采集代表爆款详情（${completedCount + 1}/${sampleItems.length}）...`,
      );
      await chrome.tabs.update(sourceTabId, {
        url: item.url,
        active: true,
      });
      await waitForTabComplete(sourceTabId, {
        timeoutMs: 20000,
        settleMs: 1800,
      });
      const result = await captureTabContent(sourceTabId, {
        mode: "single",
        captureParams: {},
      });
      const detail =
        result?.data && typeof result.data === "object" ? result.data : null;
      if (!detail) {
        continue;
      }
      const normalizedSample = {
        noteId: String(detail.noteId || item.noteId || "").trim(),
        url: String(detail.url || item.url || "").trim(),
        title: String(detail.title || item.title || "").trim(),
        authorName: String(detail.author || item.authorName || "").trim(),
        publishTime: String(
          detail.lastEditedAt || detail.publishDate || item.publishTime || "",
        ).trim(),
        likes: Number(detail.likes ?? item.likes) || 0,
        comments: Number(detail.comments ?? item.comments) || 0,
        collects: Number(detail.collects ?? item.collects) || 0,
        noteType: String(detail.noteType || item.noteType || "").trim(),
        cover: String(detail.coverImageUrl || item.cover || "").trim(),
        content: String(detail.content || "").trim(),
        tags: Array.isArray(detail.tags)
          ? detail.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
          : [],
        authorFollowerCount:
          Number(detail.bloggerFollowersCount || detail.authorFollowerCount) ||
          0,
      };
      samples.push(normalizedSample);
      if (sampleKey) {
        completedSampleKeys.add(sampleKey);
      }
      if (typeof onSampleCaptured === "function") {
        onSampleCaptured([...samples], normalizedSample);
      }
      await wait(500);
    }
  } finally {
    try {
      await chrome.tabs.update(sourceTabId, {
        url: sourceTabUrl,
        active: true,
      });
      await waitForTabComplete(sourceTabId, {
        timeoutMs: 20000,
        settleMs: 1500,
      });
    } catch (error) {
      console.warn(
        "[Sidebar] Restore keyword strategy search page failed:",
        error,
      );
    }
  }

  return samples;
}

async function handleCancelKeywordOpportunity() {
  if (!keywordOpportunityInFlight) {
    return;
  }
  keywordOpportunityCancelRequested = true;
  await requestCaptureCancelSignal();
  showProgress("正在停止判断赛道机会...", "warning");
}

async function handleCancelBenchmarkDiscovery() {
  if (!keywordBenchmarkInFlight) {
    return;
  }
  keywordBenchmarkCancelRequested = true;
  await requestCaptureCancelSignal();
  showProgress("正在停止找对标账号...", "warning");
}

async function captureBenchmarkCandidateProfiles({
  sourceTabId,
  sourceTabUrl,
  candidates = [],
  shouldStop = null,
}) {
  const profileTargets = candidates
    .filter((candidate) => candidate.authorProfileUrl)
    .slice(0, BENCHMARK_DISCOVERY_PROFILE_LIMIT);
  const profileByKey = new Map();

  if (!profileTargets.length) {
    return profileByKey;
  }

  try {
    for (let index = 0; index < profileTargets.length; index += 1) {
      if (typeof shouldStop === "function" && shouldStop()) {
        throw new Error("已取消找对标账号");
      }
      const candidate = profileTargets[index];
      showProgress(
        `正在补采候选账号主页（${index + 1}/${profileTargets.length}）...`,
      );
      try {
        await chrome.tabs.update(sourceTabId, {
          url: candidate.authorProfileUrl,
          active: true,
        });
        await waitForTabComplete(sourceTabId, {
          timeoutMs: 20000,
          settleMs: 1600,
        });
        const result = await captureTabContent(sourceTabId, {
          mode: "blogger_profile",
          captureParams: {},
        });
        const profile = normalizeBenchmarkProfilePayload(result?.data);
        if (!result?.ok || !profile) {
          throw new Error(
            result?.error?.message || "账号主页资料采集失败",
          );
        }
        profileByKey.set(candidate.key, {
          profile,
          profileCaptureStatus: "done",
          profileCaptureError: "",
          authorProfileUrl:
            profile.bloggerUrl || candidate.authorProfileUrl || "",
          authorName:
            profile.bloggerName || candidate.authorName || "",
        });
      } catch (error) {
        profileByKey.set(candidate.key, {
          profile: null,
          profileCaptureStatus: "failed",
          profileCaptureError:
            error?.message || "账号主页资料采集失败",
        });
      }
      await wait(400);
    }
  } finally {
    try {
      await chrome.tabs.update(sourceTabId, {
        url: sourceTabUrl,
        active: true,
      });
      await waitForTabComplete(sourceTabId, {
        timeoutMs: 20000,
        settleMs: 1200,
      });
    } catch (error) {
      console.warn("[Sidebar] Restore benchmark search page failed:", error);
    }
  }

  return profileByKey;
}

function buildBenchmarkDiscoveryAiCandidates(result) {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  return candidates.slice(0, BENCHMARK_DISCOVERY_PROFILE_LIMIT).map((candidate) => ({
    key: candidate.key,
    authorName: candidate.profile?.bloggerName || candidate.authorName || "",
    authorProfileUrl: candidate.authorProfileUrl || "",
    occurrenceCount: Number(candidate.occurrenceCount) || 0,
    maxLikes: Number(candidate.maxLikes) || 0,
    averageLikes: Number(candidate.averageLikes) || 0,
    averageComments: Number(candidate.averageComments) || 0,
    averageCollects: Number(candidate.averageCollects) || 0,
    avgEngagement: Number(candidate.avgEngagement) || 0,
    totalEngagement: Number(candidate.totalEngagement) || 0,
    performanceDensity: candidate.performanceDensity || "",
    ruleReason:
      candidate.analysis?.recommendationReason ||
      buildBenchmarkDiscoveryRuleReason(candidate),
    profile: candidate.profile
      ? {
          bloggerName: candidate.profile.bloggerName || "",
          description: candidate.profile.description || "",
          followersCount: Number(candidate.profile.followersCount) || 0,
          likedAndCollectedCount:
            Number(candidate.profile.likedAndCollectedCount) || 0,
          bloggerAccountType: candidate.profile.bloggerAccountType || "",
        }
      : null,
    topItems: (Array.isArray(candidate.topItems) ? candidate.topItems : [])
      .slice(0, 4)
      .map((item) => ({
        title: item.title || "",
        summary: item.summary || "",
        url: item.url || "",
        likes: Number(item.likes) || 0,
        comments: Number(item.comments) || 0,
        collects: Number(item.collects) || 0,
      })),
  }));
}

async function enrichBenchmarkDiscoveryWithAi({
  keyword,
  platform,
  result,
  taskContext = null,
}) {
  if (!isAuthVerified(getCurrentAuth())) {
    void recordDiagnosticAction({
      taskContext,
      source: "sidebar",
      action: "benchmark_ai_skipped",
      status: "skipped",
      metadata: {
        reason: "auth_not_verified",
        keyword,
        platform,
      },
    }).catch(() => null);
    return {
      ...result,
      aiStatus: "skipped",
      aiError: "auth_not_verified",
    };
  }

  const candidates = buildBenchmarkDiscoveryAiCandidates(result);
  if (!candidates.length) {
    void recordDiagnosticAction({
      taskContext,
      source: "sidebar",
      action: "benchmark_ai_skipped",
      status: "skipped",
      metadata: {
        reason: "empty_candidates",
        keyword,
        platform,
      },
    }).catch(() => null);
    return {
      ...result,
      aiStatus: "empty",
      aiError: "",
    };
  }

  try {
    showProgress("正在判断账号对标价值...");
    void recordDiagnosticAction({
      taskContext,
      source: "sidebar",
      action: "benchmark_ai_start",
      status: "started",
      metadata: {
        keyword,
        platform,
        candidateCount: candidates.length,
      },
    }).catch(() => null);
    const response = await analyzeBenchmarkDiscovery({
      keyword,
      platform,
      candidates,
    });
    if (!response?.ok || !response?.data) {
      const error = new Error(
        response?.error?.message ||
          response?.message ||
          "对标账号判断暂时不可用",
      );
      error.reason = response?.error?.reason || response?.reason || "";
      error.data = response?.error?.data || response?.data || null;
      throw error;
    }
    void recordDiagnosticAction({
      taskContext,
      source: "sidebar",
      action: "benchmark_ai_finish",
      status: "completed",
      metadata: {
        keyword,
        platform,
        candidateCount: candidates.length,
        analysisCount: Array.isArray(response.data?.candidateAnalyses)
          ? response.data.candidateAnalyses.length
          : 0,
      },
    }).catch(() => null);
    return mergeBenchmarkAiAnalysisIntoResult(result, response.data);
  } catch (error) {
    const reason = String(
      error?.reason || error?.error?.reason || "",
    ).toLowerCase();
    if (reason === "insufficient_balance") {
      void refreshVerifiedAuthSnapshot();
    }
    void recordDiagnosticError({
      taskContext,
      source: "sidebar",
      action: "benchmark_ai_finish",
      status: "failed",
      error: {
        reason: reason || "benchmark_ai_failed",
        message: error?.message || "benchmark ai analysis failed",
      },
      metadata: {
        keyword,
        platform,
        candidateCount: candidates.length,
      },
    }).catch(() => null);
    return {
      ...result,
      aiStatus: "failed",
      aiError: error?.message || reason || "benchmark_ai_failed",
    };
  }
}

async function handleRunBenchmarkDiscovery() {
  const runtime = getCurrentRuntime();
  const selectedPlatform = getViewPlatform(runtime);
  const pagePlatform = getPagePlatform(runtime);
  if (selectedPlatform !== pagePlatform) {
    const platformCopy = getPlatformCopy(selectedPlatform);
    showMessage(
      `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再发现`,
      "error",
    );
    return;
  }
  if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
    showMessage("请先切换到搜索页", "error");
    return;
  }
  if (
    !ensureAuthVerifiedOrWarn({
      message: getBenchmarkDiscoveryAuthRequiredMessage(),
    })
  ) {
    return;
  }

  const keyword = getCurrentSearchKeyword(runtime);
  if (!keyword) {
    showMessage("未检测到当前搜索词，请先完成搜索后再发现", "warning");
    return;
  }
  if (keywordBenchmarkInFlight || keywordOpportunityInFlight) {
    showMessage("赛道策略分析进行中，请稍候", "warning");
    return;
  }

  keywordStrategyPanelVisible = true;
  keywordStrategyActiveTab = "benchmark";
  keywordBenchmarkInFlight = true;
  keywordBenchmarkCancelRequested = false;
  keywordBenchmarkStartedAt = Date.now();
  keywordBenchmarkErrorMessage = "";
  keywordBenchmarkResult = null;
  keywordBenchmarkAnalysisStatus = "loading";
  keywordBenchmarkLoadingTitle = "正在查找候选账号";
  keywordBenchmarkLoadingMeta =
    "会先采集前 80 条搜索结果，再补采入围账号主页";
  renderKeywordStrategyPanel();

  const taskContext = beginSidebarTask({
    taskType: "analysis",
    featureKey: "benchmark.account_discovery",
    metadata: {
      platform: pagePlatform,
      pageType: runtime?.pageType || "",
      keyword,
    },
  });
  let taskStatus = "completed";
  let taskError = null;

  try {
    const [sourceTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!sourceTab?.id || !sourceTab.url) {
      throw new Error("未找到当前搜索页标签");
    }

    const settings = await getCaptureSettings();
    setKeywordBenchmarkLoading(
      "正在整理搜索样本",
      "正在切换到最近半年和最多点赞，准备采集高表现内容",
    );
    showProgress("正在切换到最近半年 + 最多点赞...");
    await prepareKeywordStrategyCapture(sourceTab.id);
    if (keywordBenchmarkCancelRequested) {
      throw new Error("已取消找对标账号");
    }

    const refreshedSourceTab = await chrome.tabs.get(sourceTab.id);
    const sourceTabUrl = String(
      refreshedSourceTab?.url || sourceTab.url || "",
    ).trim();
    setKeywordBenchmarkLoading(
      "正在筛选候选账号",
      "正在采集主词前 80 条高表现搜索结果",
    );
    showProgress("正在采集主词前 80 条搜索结果...");
    const captureResult = await captureTabContent(sourceTab.id, {
      mode: "keyword",
      captureParams: {
        keyword,
        minLikes: 0,
        sortDimension: "likes",
        maxDetectedItems: 80,
        maxScrollTimes: 40,
        waitMinMs: settings.sharedWaitMinMs,
        waitMaxMs: settings.sharedWaitMaxMs,
        stallTimeoutMs: settings.sharedStallTimeoutMs,
        maxDurationMs: settings.sharedMaxDurationMs,
      },
    });
    if (keywordBenchmarkCancelRequested) {
      throw new Error("已取消找对标账号");
    }

    const payload =
      captureResult?.data && typeof captureResult.data === "object"
        ? captureResult.data
        : null;
    const listItems = normalizeBenchmarkDiscoveryItems(payload?.items || []);
    if (listItems.length < 5) {
      throw new Error("有效搜索结果不足，暂时无法找对标账号");
    }

    let result = buildBenchmarkDiscoveryCandidates(listItems, {
      keyword,
      platform: pagePlatform,
    });
    if (result.candidateCount === 0) {
      keywordBenchmarkResult = result;
      keywordBenchmarkErrorMessage = "";
      keywordBenchmarkAnalysisStatus = "success";
      keywordBenchmarkLoadingTitle = "";
      keywordBenchmarkLoadingMeta = "";
      renderKeywordStrategyPanel();
      showMessage("当前样本暂未发现重复出现的候选账号", "warning");
      return;
    }

    setKeywordBenchmarkLoading(
      "正在补采账号主页",
      `已筛出 ${result.candidateCount} 个候选账号，正在补充简介、粉丝数和赞藏数据`,
    );
    const profileByKey = await captureBenchmarkCandidateProfiles({
      sourceTabId: sourceTab.id,
      sourceTabUrl,
      candidates: result.candidates,
      shouldStop: () => keywordBenchmarkCancelRequested,
    });
    if (keywordBenchmarkCancelRequested) {
      throw new Error("已取消找对标账号");
    }
    result = mergeBenchmarkProfilesIntoResult(result, profileByKey);

    setKeywordBenchmarkLoading(
      "正在生成对标账号判断",
      "正在结合账号主页、粉丝量级和代表作品生成推荐理由",
    );
    result = await enrichBenchmarkDiscoveryWithAi({
      keyword,
      platform: pagePlatform,
      result,
      taskContext,
    });
    keywordBenchmarkResult = result;
    keywordBenchmarkErrorMessage = "";
    keywordBenchmarkAnalysisStatus = "success";
    keywordBenchmarkLoadingTitle = "";
    keywordBenchmarkLoadingMeta = "";
    renderKeywordStrategyPanel();

    showMessage(`已发现 ${result.candidateCount} 个候选对标账号`, "success");
  } catch (error) {
    const message =
      error?.message || "找对标账号失败，请稍后重试";
    keywordBenchmarkErrorMessage = message;
    keywordBenchmarkAnalysisStatus = "error";
    keywordBenchmarkLoadingTitle = "";
    keywordBenchmarkLoadingMeta = "";
    taskStatus = "failed";
    taskError = error;
    showMessage(message, "warning");
    renderKeywordStrategyPanel();
  } finally {
    keywordBenchmarkInFlight = false;
    keywordBenchmarkStartedAt = 0;
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        platform: pagePlatform,
        keyword,
        candidateCount: keywordBenchmarkResult?.candidateCount || 0,
        aiStatus: keywordBenchmarkResult?.aiStatus || "unknown",
        aiError: keywordBenchmarkResult?.aiError || "",
      },
    });
    hideProgress();
    renderKeywordStrategyPanel();
  }
}

async function handleRunKeywordOpportunity() {
  const runtime = getCurrentRuntime();
  const selectedPlatform = getViewPlatform(runtime);
  const pagePlatform = getPagePlatform(runtime);
  if (selectedPlatform !== pagePlatform) {
    const platformCopy = getPlatformCopy(selectedPlatform);
    showMessage(
      `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再分析`,
      "error",
    );
    return;
  }
  if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
    showMessage("请先切换到搜索页", "error");
    return;
  }
  if (
    !ensureAuthVerifiedOrWarn({
      message: getKeywordOpportunityAuthRequiredMessage(),
    })
  ) {
    return;
  }

  const keyword = getCurrentSearchKeyword(runtime);
  if (!keyword) {
    showMessage("未检测到当前搜索词，请先完成搜索后再分析", "warning");
    return;
  }
  if (keywordOpportunityInFlight) {
    showMessage("赛道策略分析进行中，请稍候", "warning");
    return;
  }

  keywordStrategyPanelVisible = true;
  keywordStrategyActiveTab = "opportunity";
  keywordOpportunityInFlight = true;
  keywordOpportunityCancelRequested = false;
  keywordOpportunityStartedAt = Date.now();
  keywordOpportunityErrorMessage = "";
  keywordOpportunityResult = null;
  renderKeywordStrategyPanel();

  try {
    const existingDraft = getKeywordOpportunityDraft();
    const canResumeDraft =
      existingDraft.keyword === keyword &&
      existingDraft.listItems.length >= 10 &&
      existingDraft.sampleItems.length > 0 &&
      existingDraft.representativeSamples.length <=
        existingDraft.sampleItems.length;

    const [sourceTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!sourceTab?.id || !sourceTab.url) {
      throw new Error("未找到当前搜索页标签");
    }

    const settings = await getCaptureSettings();
    let sourceTabUrl = String(sourceTab.url || "").trim();
    let listItems = [];
    let sampleItems = [];
    let representativeSamples = [];

    if (canResumeDraft) {
      sourceTabUrl = existingDraft.sourceTabUrl || sourceTabUrl;
      listItems = [...existingDraft.listItems];
      sampleItems = [...existingDraft.sampleItems];
      representativeSamples = [...existingDraft.representativeSamples];
      const remainingSampleCount = Math.max(
        0,
        sampleItems.length - representativeSamples.length,
      );
      showMessage(
        remainingSampleCount > 0
          ? `已恢复上次进度，继续采集剩余 ${remainingSampleCount} 条代表爆款`
          : "已恢复上次进度，直接继续生成赛道机会建议",
        "success",
      );
    } else {
      clearKeywordOpportunityDraft();
      persistCurrentBatchDraft();
      showProgress("正在切换到最近半年 + 最多点赞...");
      await prepareKeywordStrategyCapture(sourceTab.id);
      const refreshedSourceTab = await chrome.tabs.get(sourceTab.id);
      sourceTabUrl = String(refreshedSourceTab?.url || sourceTab.url || "").trim();
      showProgress("正在采集主词前 80 条搜索结果...");
      const captureResult = await captureTabContent(sourceTab.id, {
        mode: "keyword",
        captureParams: {
          keyword,
          minLikes: 0,
          sortDimension: "likes",
          maxDetectedItems: 80,
          maxScrollTimes: 40,
          waitMinMs: settings.sharedWaitMinMs,
          waitMaxMs: settings.sharedWaitMaxMs,
          stallTimeoutMs: settings.sharedStallTimeoutMs,
          maxDurationMs: settings.sharedMaxDurationMs,
        },
      });
      const payload =
        captureResult?.data && typeof captureResult.data === "object"
          ? captureResult.data
          : null;
      listItems = buildKeywordOpportunityInputItems(payload?.items || []);
      if (listItems.length < 10) {
        throw new Error("有效搜索结果不足，暂时无法判断赛道机会");
      }

      sampleItems = selectKeywordOpportunitySamples(listItems);
      if (sampleItems.length === 0) {
        throw new Error("未找到可用于详情采样的代表爆款");
      }
      updateKeywordOpportunityDraft({
        keyword,
        sourceTabUrl,
        listItems,
        sampleItems,
        representativeSamples: [],
      });
      persistCurrentBatchDraft();
    }

    showProgress("正在采集代表爆款详情...");
    representativeSamples = await captureKeywordOpportunitySamples({
      sourceTabId: sourceTab.id,
      sourceTabUrl,
      sampleItems,
      initialSamples: representativeSamples,
      onSampleCaptured: (nextSamples) => {
        updateKeywordOpportunityDraft({
          keyword,
          sourceTabUrl,
          listItems,
          sampleItems,
          representativeSamples: nextSamples,
        });
        persistCurrentBatchDraft();
      },
      shouldStop: () => keywordOpportunityCancelRequested,
    });
    if (representativeSamples.length === 0) {
      throw new Error("代表爆款详情采集失败，请稍后重试");
    }
    updateKeywordOpportunityDraft({
      keyword,
      sourceTabUrl,
      listItems,
      sampleItems,
      representativeSamples,
    });
    persistCurrentBatchDraft();

    showProgress("正在生成赛道机会建议...");
    const response = await analyzeKeywordOpportunity({
      keyword,
      listItems,
      representativeSamples,
      platform: pagePlatform,
    });
    if (!response?.ok || !response?.data) {
      const requestError = new Error(
        response?.error?.message ||
          response?.message ||
          "判断赛道机会暂时不可用",
      );
      requestError.reason =
        response?.error?.reason || response?.reason || "server_error";
      requestError.data = response?.error?.data || response?.data || null;
      throw requestError;
    }

    keywordOpportunityResult = response.data;
    keywordOpportunityResult._listItems = listItems;
    keywordOpportunityResult._representativeSamples = representativeSamples;
    keywordOpportunityErrorMessage = "";
    clearKeywordOpportunityDraft();
    persistCurrentBatchDraft();
    renderKeywordStrategyPanel();
    showMessage("判断赛道机会已完成", "success");
  } catch (error) {
    const errorReason = String(
      error?.reason || error?.error?.reason || "",
    )
      .trim()
      .toLowerCase();
    if (errorReason === "insufficient_balance") {
      const requiredCredits = Number(error?.data?.requiredCredits);
      const requiredCreditsLabel =
        Number.isInteger(requiredCredits) && requiredCredits > 0
          ? requiredCredits
          : KEYWORD_OPPORTUNITY_ANALYSIS_COST_CREDITS;
      keywordOpportunityErrorMessage = "";
      showMessage(
        `配额不足：关键词策略完整分析需 ${requiredCreditsLabel} 配额。获取更多配额后可继续分析。`,
        "warning",
      );
      void refreshVerifiedAuthSnapshot();
    } else {
      const formattedError = formatKeywordStrategyAccessError(
        error,
        getKeywordOpportunityAuthRequiredMessage(),
      );
      const message =
        formattedError.message || "判断赛道机会失败，请稍后重试";
      keywordOpportunityErrorMessage = message;
      showMessage(message, "warning");
    }
    renderKeywordStrategyPanel();
  } finally {
    keywordOpportunityInFlight = false;
    keywordOpportunityStartedAt = 0;
    hideProgress();
    renderKeywordStrategyPanel();
  }
}

function handleOpenKeywordLongtail() {
  const currentKeyword = getCurrentSearchKeyword(getCurrentRuntime());
  syncSeedKeywordFromCurrentSearch(currentKeyword, {autoFillOnly: true});
  keywordStrategyPanelVisible = true;
  setKeywordStrategyTab("longtail");
}

function handleBenchmarkDiscoveryResultActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const actionTarget = target.closest("[data-action]");
  const action = actionTarget?.dataset?.action || "";
  const url = String(actionTarget?.dataset?.url || "").trim();

  if (action === "copy-benchmark") {
    handleCopyBenchmarkDiscovery(actionTarget);
    return;
  }

  if (action === "share-benchmark-as-image") {
    handleShareBenchmarkDiscoveryAsImage();
    return;
  }

  if (action === "open-benchmark-profile") {
    if (!url) {
      showMessage("暂未找到可打开的链接", "warning");
      return;
    }
    chrome.tabs.create({url}).catch((error) => {
      console.warn("[Sidebar] Open benchmark url failed:", error);
      showMessage("打开链接失败，请稍后重试", "warning");
    });
    return;
  }

  if (action === "monitor-benchmark-account") {
    if (!isMonitorAuthReady()) {
      showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
      return;
    }
    if (!url) {
      showMessage("候选账号缺少主页链接，暂时无法纳入监控", "warning");
      return;
    }
    const platform = getPagePlatform(getCurrentRuntime());
    const platformBloggerId = extractPlatformMonitorBloggerId(platform, url, "");
    if (!platformBloggerId) {
      showMessage("候选账号缺少主页 ID，暂时无法纳入监控", "warning");
      return;
    }
    addMonitorSubscriptionByCandidate({
      platform,
      platformBloggerId,
      bloggerNameSnapshot: String(actionTarget?.dataset?.name || "").trim(),
      bloggerUrl: url,
      bloggerAvatarSnapshot: "",
    }).catch((error) => {
      showMessage(`纳入监控失败：${error.message}`, "error");
    });
  }
}

function buildBenchmarkDiscoveryCandidateEvidence(candidate) {
  const profile = candidate?.profile || null;
  const followersCount = Number(profile?.followersCount) || 0;
  const maxLikes = Number(candidate?.maxLikes) || 0;
  const likeFollowerRatio =
    followersCount > 0 && maxLikes > 0 ? maxLikes / followersCount : 0;
  const evidenceItems = [
    `样本出现 ${Number(candidate?.occurrenceCount) || 0} 次，最高赞 ${formatOpportunityMetric(maxLikes)}，均赞 ${formatOpportunityMetric(candidate?.averageLikes)}`,
  ];
  if (followersCount > 0) {
    evidenceItems.push(
      likeFollowerRatio >= 0.1
        ? `粉丝 ${formatOpportunityMetric(followersCount)}，最高赞约为粉丝数 ${Math.max(1, Math.round(likeFollowerRatio * 10) / 10)} 倍，有低粉高表现信号`
        : `粉丝 ${formatOpportunityMetric(followersCount)}，可结合代表内容判断是否适合普通账号学习`,
    );
  }
  if (Number(profile?.likedAndCollectedCount) > 0) {
    evidenceItems.push(
      `主页累计赞藏 ${formatOpportunityMetric(profile.likedAndCollectedCount)}`,
    );
  }
  return evidenceItems;
}

function buildBenchmarkDiscoveryRepresentativeWorks(candidate, limit = 3) {
  return (Array.isArray(candidate?.topItems) ? candidate.topItems : [])
    .map((item) => ({
      title: String(item?.title || "").trim(),
      url: String(item?.url || "").trim(),
      likes: Number(item?.likes) || 0,
      collects: Number(item?.collects) || 0,
    }))
    .filter((item) => item.title)
    .slice(0, limit);
}

function buildBenchmarkDiscoveryShareText() {
  const result = keywordBenchmarkResult;
  if (!result) {
    return "";
  }
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const lines = [
    `【找对标账号】${String(result.keyword || "").trim()}`,
    `从 ${Number(result.sampleCount) || 0} 条搜索结果中筛出 ${Number(result.candidateCount) || 0} 个候选账号，入围门槛为样本出现 ${Number(result.minOccurrence) || 2} 次。`,
  ];

  candidates.slice(0, 5).forEach((candidate, index) => {
    const profile = candidate.profile || null;
    const analysis =
      candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
    const name =
      String(profile?.bloggerName || candidate.authorName || "").trim() ||
      `候选账号 ${index + 1}`;
    const works = buildBenchmarkDiscoveryRepresentativeWorks(candidate, 3);
    lines.push("");
    lines.push(`${index + 1}. ${name}`);
    if (analysis.recommendationReason) {
      lines.push(String(analysis.recommendationReason).trim());
    }
    if (analysis.focusAssessment) {
      lines.push(`判断依据：${String(analysis.focusAssessment).trim()}`);
    }
    buildBenchmarkDiscoveryCandidateEvidence(candidate).forEach((item) => {
      lines.push(`- ${item}`);
    });
    if (works.length > 0) {
      lines.push("代表作品：");
      works.forEach((work) => {
        lines.push(
          `- ${work.title}（赞 ${formatOpportunityMetric(work.likes)}）${work.url ? ` ${work.url}` : ""}`,
        );
      });
    }
    if (candidate.authorProfileUrl) {
      lines.push(`主页：${candidate.authorProfileUrl}`);
    }
  });

  return lines.join("\n").trim();
}

function handleCopyBenchmarkDiscovery(btn) {
  const text = buildBenchmarkDiscoveryShareText();
  if (!text || !btn) {
    showMessage("暂无对标账号结果可复制", "warning");
    return;
  }

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        btn.innerHTML = original;
      }, 1500);
    })
    .catch(() => {
      showMessage("复制失败，请稍后重试", "error");
    });
}

function buildBenchmarkDiscoveryShareData() {
  const result = keywordBenchmarkResult;
  if (!result) {
    return null;
  }
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  return {
    keyword: String(result.keyword || "").trim(),
    sampleCount: Number(result.sampleCount) || 0,
    candidateCount: Number(result.candidateCount) || 0,
    minOccurrence: Number(result.minOccurrence) || 2,
    candidates: candidates.slice(0, 4).map((candidate, index) => {
      const profile = candidate.profile || null;
      const analysis =
        candidate.analysis || buildBenchmarkDiscoveryFallbackAnalysis(candidate);
      return {
        rank: index + 1,
        name:
          String(profile?.bloggerName || candidate.authorName || "").trim() ||
          `候选账号 ${index + 1}`,
        recommendationReason: String(
          analysis.recommendationReason || "",
        ).trim(),
        focusAssessment: String(analysis.focusAssessment || "").trim(),
        growthPotential: String(analysis.growthPotential || "medium").trim(),
        tags: Array.isArray(analysis.tags)
          ? analysis.tags.filter(Boolean).slice(0, 4).map((item) => String(item))
          : [],
        evidence: buildBenchmarkDiscoveryCandidateEvidence(candidate),
        works: buildBenchmarkDiscoveryRepresentativeWorks(candidate, 2),
      };
    }),
    ts: Date.now(),
  };
}

function handleShareBenchmarkDiscoveryAsImage() {
  const data = buildBenchmarkDiscoveryShareData();
  if (!data) {
    showMessage("暂无对标账号结果可分享", "warning");
    return;
  }
  renderBenchmarkDiscoveryCardToImage(data);
}

function handleKeywordOpportunityResultActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action =
    target.dataset?.action ||
    target.closest("[data-action]")?.dataset?.action ||
    "";

  if (action === "copy-opportunity") {
    handleCopyKeywordOpportunity(target.closest("[data-action]"));
    return;
  }
  if (action === "share-opportunity-as-image") {
    handleShareKeywordOpportunityAsImage();
    return;
  }
}

function handleCopyKeywordOpportunity(btn) {
  const text = buildKeywordOpportunityShareText();
  if (!text || !btn) {
    return;
  }

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        btn.innerHTML = original;
      }, 1500);
    })
    .catch(() => {});
}

function buildKeywordOpportunityShareText() {
  const result = keywordOpportunityResult;
  if (!result) {
    return "";
  }

  const topicDirections = Array.isArray(result.hotTopicDirections)
    ? result.hotTopicDirections
    : [];
  const recommendedAngles = Array.isArray(result.recommendedAngles)
    ? result.recommendedAngles
    : [];
  const subtopics = Array.isArray(result.coreWinningSubtopics)
    ? result.coreWinningSubtopics
    : [];
  const ruleMetrics = result.ruleMetrics || {};
  const metrics = [
    `热度：${ruleMetrics.heatLevel === "high" ? "高" : ruleMetrics.heatLevel === "medium" ? "中" : "低"}`,
    `高位区间：${
      ruleMetrics.highBandEnd > 0
        ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
        : "未识别"
    }`,
    `断层跌幅：${
      ruleMetrics.cliffDropRatio > 0
        ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
        : "不明显"
    }`,
    `高位均赞：${formatOpportunityMetric(ruleMetrics.highBandAvgLikes)}`,
    `中位赞：${formatOpportunityMetric(ruleMetrics.medianLikes)}`,
  ];

  const lines = [
    `【判断赛道机会】${String(result.keyword || "").trim()}`,
  ];
  if (result.distributionSummary) {
    lines.push(`分布：${String(result.distributionSummary).trim()}`);
  }
  lines.push(`指标：${metrics.join("｜")}`);

  if (subtopics.length > 0) {
    lines.push("");
    lines.push("【核心爆款细分词】");
    lines.push(subtopics.join("、"));
  }

  if (topicDirections.length > 0) {
    lines.push("");
    lines.push("【爆款主题方向】");
    const bandLabels = {
      high: "高赞区",
      mid: "中赞区",
      low: "低赞区",
      high_mid: "高赞区+中赞区",
      mid_low: "中赞区+低赞区",
      all: "高赞区+中赞区+低赞区",
    };
    topicDirections.forEach((direction, index) => {
      const name = String(direction?.name || "").trim() || `方向 ${index + 1}`;
      const sampleCount = Number(direction?.sampleCount) || 0;
      const shareRatio = `${Math.round((Number(direction?.shareRatio) || 0) * 100)}%`;
      const bandLabel = bandLabels[direction?.bandPresence] || "";
      const titles = Array.isArray(direction?.representativeTitles)
        ? direction.representativeTitles.filter(Boolean)
        : [];
      lines.push(
        `${index + 1}. ${name}${bandLabel ? `【${bandLabel}】` : ""}｜${sampleCount} 篇｜占比 ${shareRatio}`,
      );
      if (direction?.whyItWorks) {
        lines.push(String(direction.whyItWorks).trim());
      }
      if (titles.length > 0) {
        titles.forEach((t) => lines.push(`  · ${String(t).trim()}`));
      }
    });
  }

  if (recommendedAngles.length > 0) {
    lines.push("");
    lines.push("【新号优先选题】");
    recommendedAngles.forEach((angle, index) => {
      lines.push(
        `${index + 1}. ${String(angle?.title || "").trim() || `选题 ${index + 1}`}`,
      );
      if (angle?.audiencePainPoint) {
        lines.push(`  ${String(angle.audiencePainPoint).trim()}`);
      }
      if (angle?.formatSuggestion) {
        lines.push(`  形式建议：${String(angle.formatSuggestion).trim()}`);
      }
      if (angle?.executionHint) {
        lines.push(`  执行提示：${String(angle.executionHint).trim()}`);
      }
    });
  }

  return lines.join("\n").trim();
}

function buildKeywordOpportunityShareData() {
  const result = keywordOpportunityResult;
  if (!result) {
    return null;
  }

  const ruleMetrics = result.ruleMetrics || {};
  return {
    keyword: String(result.keyword || "").trim(),
    distributionSummary: String(result.distributionSummary || "").trim(),
    metrics: [
      {
        label: "热度",
        value:
          ruleMetrics.heatLevel === "high"
            ? "高"
            : ruleMetrics.heatLevel === "medium"
              ? "中"
              : "低",
      },
      {
        label: "高位区间",
        value:
          ruleMetrics.highBandEnd > 0
            ? `${ruleMetrics.highBandStart}-${ruleMetrics.highBandEnd}`
            : "未识别",
      },
      {
        label: "断层跌幅",
        value:
          ruleMetrics.cliffDropRatio > 0
            ? `${Math.round(ruleMetrics.cliffDropRatio * 100)}%`
            : "不明显",
      },
      {
        label: "高位均赞",
        value: formatOpportunityMetric(ruleMetrics.highBandAvgLikes),
      },
      {
        label: "中位赞",
        value: formatOpportunityMetric(ruleMetrics.medianLikes),
      },
    ],
    subtopics: Array.isArray(result.coreWinningSubtopics)
      ? result.coreWinningSubtopics.filter(Boolean).map((item) => String(item))
      : [],
    directions: Array.isArray(result.hotTopicDirections)
      ? result.hotTopicDirections.map((direction) => ({
          name: String(direction?.name || "").trim(),
          shareRatio: Math.round((Number(direction?.shareRatio) || 0) * 100),
          sampleCount: Number(direction?.sampleCount) || 0,
          whyItWorks: String(direction?.whyItWorks || "").trim(),
          bandPresence: String(direction?.bandPresence || "all").trim(),
        }))
      : [],
    angles: Array.isArray(result.recommendedAngles)
      ? result.recommendedAngles.map((angle) => ({
          title: String(angle?.title || "").trim(),
          audiencePainPoint: String(angle?.audiencePainPoint || "").trim(),
          formatSuggestion: String(angle?.formatSuggestion || "").trim(),
          executionHint: String(angle?.executionHint || "").trim(),
        }))
      : [],
    ts: Date.now(),
  };
}

function handleShareKeywordOpportunityAsImage() {
  const data = buildKeywordOpportunityShareData();
  if (!data) {
    showMessage("暂无判断赛道机会结果可分享", "warning");
    return;
  }
  renderKeywordOpportunityCardToImage(data);
}

// ==================== 关键词裂变 ====================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSelectedRecommendedKeywords(draft = getKeywordInsightState()) {
  return Array.isArray(draft.selectedKeywords)
    ? [...draft.selectedKeywords]
    : [];
}

function invalidateKeywordInsightDraft(platform = "") {
  keywordInsightRunToken += 1;
  keywordAnalysisInFlight = false;
  keywordAnalysisStartedAt = 0;
  keywordInsightSampleInFlight = false;
  const currentDraft = getBatchDraftForPlatform(platform);
  updateKeywordInsightState(
    {
      ...createEmptyKeywordInsightState(),
      analysisVersion: (currentDraft.analysisVersion || 0) + 1,
    },
    platform,
  );
}

function toggleExpandedKeywordsVisibility() {
  expandedKeywordsPanelVisible = !expandedKeywordsPanelVisible;
  renderExpandedKeywords();
  if (expandedKeywordsPanelVisible) {
    document
      .getElementById("expandedKeywordsPanel")
      ?.scrollIntoView({behavior: "smooth", block: "nearest"});
  }
}

function renderExpandedKeywords() {
  const panel = document.getElementById("expandedKeywordsPanel");
  const countEl = document.getElementById("expandedKeywordsCount");
  const textarea = document.getElementById("textareaExpandedKeywords");
  const btnView = document.getElementById("btnViewExpandedKeywords");
  const btnClear = document.getElementById("btnClearKeywordInsightResult");
  const introEl = document.getElementById("keywordInsightIntro");
  const btnHeaderRun = document.getElementById("btnExpandKeywords");
  const btnIntroRun = document.getElementById("btnRunKeywordInsight");
  const actionRowEl = document.getElementById("keywordInsightActionRow");

  if (!panel) return;

  const hasKeywords = expandedKeywordsBuffer.length > 0;
  panel.hidden = !hasKeywords || !expandedKeywordsPanelVisible;
  if (introEl) {
    introEl.hidden = hasKeywords;
  }

  if (countEl) {
    countEl.textContent = `扩展词: ${expandedKeywordsBuffer.length} 词`;
  }

  if (btnView) {
    btnView.hidden = !hasKeywords;
    btnView.textContent = expandedKeywordsPanelVisible
      ? "收起扩展词"
      : `查看全部扩展词 (${expandedKeywordsBuffer.length})`;
  }
  if (btnClear) {
    btnClear.hidden = !hasKeywords;
  }
  if (btnHeaderRun) {
    btnHeaderRun.hidden = !hasKeywords;
  }
  if (btnIntroRun) {
    btnIntroRun.hidden = hasKeywords;
  }
  if (actionRowEl) {
    actionRowEl.classList.toggle("is-result-mode", hasKeywords);
  }

  if (textarea) {
    const nextValue = expandedKeywordsBuffer.join("\n");
    if (textarea.value !== nextValue) {
      textarea.value = nextValue;
    }
  }
}

function updateExpandedKeywordsSummary() {
  renderExpandedKeywords();
}

function clearKeywordInsightResult({showFeedback = true} = {}) {
  const hasAnything = expandedKeywordsBuffer.length > 0;
  if (!hasAnything) {
    return;
  }

  expandedKeywordsBuffer = [];
  expandedKeywordsPanelVisible = false;
  invalidateKeywordInsightDraft();
  renderKeywordInsightState();
  persistCurrentBatchDraft();
  updateExpandKeywordsButtonState();
  if (showFeedback) {
    showMessage("已清空扩展词和分析结果", "success");
  }
}

function renderInsightLoadingState() {
  return `
    <div class="keyword-insight-summary-card is-loading">
      <div class="keyword-insight-summary-title">
        <span class="keyword-insight-loading-spinner" aria-hidden="true"></span>
        正在分析需求方向
      </div>
      <div class="keyword-insight-summary-meta">已扩展 ${expandedKeywordsBuffer.length} 个关键词，通常需要 1-2 分钟</div>
    </div>
  `;
}

function renderInsightSummaryCard(draft) {
  const analysis = draft.analysisResult;
  if (!analysis) {
    return "";
  }

  const categoryCount = Array.isArray(analysis.categories)
    ? analysis.categories.length
    : 0;
  const selectedKeywords = getSelectedRecommendedKeywords(draft);
  return `
    <div class="keyword-insight-summary-card">
      <div class="keyword-insight-summary-header">
        <div class="keyword-insight-summary-title">需求洞察</div>
        <div class="keyword-insight-share-wrap">
          <button type="button" class="keyword-insight-share-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            去分享
          </button>
          <div class="keyword-insight-share-menu">
            <div class="keyword-insight-share-menu-inner">
              <button type="button" class="keyword-insight-share-menu-item" data-action="copy-insight">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                复制文本
              </button>
              <button type="button" class="keyword-insight-share-menu-item" data-action="share-as-image">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                分享图片
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="keyword-insight-summary-meta">共 ${expandedKeywordsBuffer.length} 词 · ${categoryCount} 个方向 · 已选 ${selectedKeywords.length}/10 个词采集</div>
      <div class="keyword-insight-summary-text">${escapeHtml(analysis.summary || "")}</div>
    </div>
  `;
}

function renderInsightSampleBlock(sampleStatus, sampleResult) {
  if (sampleStatus === "loading") {
    return `<div class="keyword-insight-sample-hint">正在抓取该方向样本...</div>`;
  }
  if (sampleStatus === "error") {
    return `<div class="keyword-insight-sample-hint is-error">${escapeHtml(sampleResult?.errorMessage || "样本获取失败，可重试分析后再次查看")}</div>`;
  }
  const samples = Array.isArray(sampleResult?.samples)
    ? sampleResult.samples
    : [];
  if (samples.length === 0) {
    return `<div class="keyword-insight-sample-hint">暂无样本</div>`;
  }

  const sourceLabel = sampleResult?.usedKeyword
    ? `<div class="keyword-insight-sample-source">样本来自：${escapeHtml(sampleResult.usedKeyword)}</div>`
    : "";
  const itemsHtml = samples
    .map((sample) => {
      const title = escapeHtml(sample?.title || "未命名样本");
      const author = escapeHtml(sample?.author || "未知作者");
      const likes = Number(sample?.likes) || 0;
      const titleHtml = sample?.url
        ? `<a href="${escapeHtml(sample.url)}" target="_blank" style="color: inherit; text-decoration: underline;">${title}</a>`
        : `<span class="sample-title">${title}</span>`;
      return `<li>${titleHtml}<span class="sample-meta">${author} · ❤️ ${likes}</span></li>`;
    })
    .join("");
  return `${sourceLabel}<ul class="keyword-insight-sample-list">${itemsHtml}</ul>`;
}

function renderInsightCategories(draft) {
  const analysis = draft.analysisResult;
  const categories = Array.isArray(analysis?.categories)
    ? analysis.categories
    : [];
  const selectedKeywordSet = new Set(draft.selectedKeywords || []);

  if (categories.length === 0) {
    return "";
  }

  const totalKeywords = expandedKeywordsBuffer.length || 1;

  return categories
    .map((category) => {
      const categoryId = String(category?.id || "").trim();
      const isExpanded = expandedKeywordInsightCategoryIds.has(categoryId);
      const sampleStatus =
        draft.sampleStatusByCategoryId?.[categoryId] || "idle";
      const sampleResult =
        draft.sampleResultsByCategoryId?.[categoryId] || null;
      const keywordList = Array.isArray(category?.keywords)
        ? category.keywords
        : [];
      const pct = Math.round((keywordList.length / totalKeywords) * 100);

      return `
        <article class="keyword-insight-category-card">
          <div class="keyword-insight-category-head">
            <span class="keyword-insight-category-title">${escapeHtml(category?.icon || "📌")} ${escapeHtml(category?.name || "未命名方向")}</span>
            <button type="button" class="btn-text" data-action="toggle-expand-category" data-category-id="${escapeHtml(categoryId)}">
              ${isExpanded ? "收起" : "展开"}
            </button>
          </div>
          <div class="keyword-insight-category-meta">
            <span>${keywordList.length} 词</span>
            <span class="keyword-density-pct">${pct}%</span>
            <span class="keyword-density-bar-wrap"><span class="keyword-density-bar-fill" style="width:${Math.min(pct, 100)}%"></span></span>
          </div>
          <div class="keyword-insight-category-insight">${escapeHtml(category?.insight || "")}</div>
          <div class="keyword-insight-category-samples">
            ${renderInsightSampleBlock(sampleStatus, sampleResult)}
          </div>
          ${
            isExpanded
              ? `<div class="keyword-insight-keywords">${keywordList
                  .map((keyword) => {
                    return `<span class="keyword-chip" data-action="toggle-keyword" data-keyword="${escapeHtml(keyword)}" title="点击复制">${escapeHtml(keyword)}</span>`;
                  })
                  .join("")}</div>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function renderKeywordInsightState() {
  const draft = getKeywordInsightState();
  const insightContainer = document.getElementById("keywordInsightContainer");
  const summaryEl = document.getElementById("keywordInsightSummary");
  const categoriesEl = document.getElementById("keywordInsightCategories");
  const errorEl = document.getElementById("keywordInsightError");
  const errorMessageEl = document.getElementById("keywordInsightErrorMessage");
  const btnRetry = document.getElementById("btnRetryKeywordAnalysis");
  const btnCapture = document.getElementById("btnInsightBatchCapture");
  const introEl = document.getElementById("keywordInsightIntro");

  renderExpandedKeywords();

  if (
    !insightContainer ||
    !summaryEl ||
    !categoriesEl ||
    !errorEl
  ) {
    return;
  }

  const hasKeywords = expandedKeywordsBuffer.length > 0;
  const analysisStatus = draft.analysisStatus || "idle";
  insightContainer.hidden = !hasKeywords;
  if (introEl) {
    introEl.hidden = hasKeywords;
  }

  if (!hasKeywords) {
    summaryEl.innerHTML = "";
    categoriesEl.innerHTML = "";
    errorEl.hidden = true;
    return;
  }

  if (analysisStatus === "loading") {
    summaryEl.innerHTML = renderInsightLoadingState();
    categoriesEl.innerHTML = "";
    errorEl.hidden = true;
    if (btnRetry) {
      btnRetry.disabled = true;
    }
    return;
  }

  if (analysisStatus === "error") {
    summaryEl.innerHTML = "";
    categoriesEl.innerHTML = "";
    errorEl.hidden = false;
    if (errorMessageEl) {
      errorMessageEl.textContent =
        draft.analysisErrorMessage ||
        "当前智能分析暂时不可用，已保留扩展词，可稍后重试或先查看扩展词。";
    }
    if (btnRetry) {
      btnRetry.disabled =
        keywordAnalysisInFlight && !isKeywordAnalysisLockStale();
    }
    return;
  }

  if (analysisStatus === "success" && draft.analysisResult) {
    summaryEl.innerHTML = renderInsightSummaryCard(draft);
    categoriesEl.innerHTML = renderInsightCategories(draft);
    errorEl.hidden = true;
    return;
  }

  summaryEl.innerHTML = "";
  categoriesEl.innerHTML = "";
  errorEl.hidden = true;
  btnCapture.hidden = true;
}

function isKeywordAnalysisLockStale() {
  if (!keywordAnalysisInFlight || keywordAnalysisStartedAt <= 0) {
    return false;
  }
  return Date.now() - keywordAnalysisStartedAt > KEYWORD_ANALYSIS_STALE_LOCK_MS;
}

function releaseKeywordAnalysisLock() {
  keywordAnalysisInFlight = false;
  keywordAnalysisStartedAt = 0;
}

function updateCategorySampleResult(categoryId, result) {
  const draft = getKeywordInsightState();
  updateKeywordInsightState({
    sampleStatusByCategoryId: {
      ...draft.sampleStatusByCategoryId,
      [categoryId]: result?.status === "success" ? "success" : "error",
    },
    sampleResultsByCategoryId: {
      ...draft.sampleResultsByCategoryId,
      [categoryId]: result,
    },
  });
  renderKeywordInsightState();
  persistCurrentBatchDraft();
}

async function runKeywordInsightSampling({
  analysisResult,
  baseSearchUrl,
  runToken,
}) {
  const categories = Array.isArray(analysisResult?.categories)
    ? analysisResult.categories
    : [];
  if (categories.length === 0) {
    return;
  }

  keywordInsightSampleInFlight = true;
  const sampleStatusByCategoryId = {};
  categories.forEach((category) => {
    sampleStatusByCategoryId[category.id] = "loading";
  });
  updateKeywordInsightState({
    sampleStatusByCategoryId,
    sampleResultsByCategoryId: {},
  });
  renderKeywordInsightState();
  persistCurrentBatchDraft();

  try {
    const runtime = getCurrentRuntime();
    const pagePlatform = getPagePlatform(runtime);
    await lightSampleByKeywords({
      categorySamples: categories.map((category) => {
        const candidates =
          Array.isArray(category.sampleCandidateKeywords) &&
          category.sampleCandidateKeywords.length > 0
            ? category.sampleCandidateKeywords
            : Array.isArray(category.keywords) && category.keywords.length > 0
              ? [category.keywords[0]]
              : [];
        return {
          categoryId: category.id,
          candidateKeywords: candidates,
        };
      }),
      platform: pagePlatform,
      baseSearchUrl,
      onProgress: (progress) => {
        if (runToken !== keywordInsightRunToken) {
          return;
        }
        if (progress?.phase === "category_done" && progress?.result) {
          updateCategorySampleResult(progress.categoryId, progress.result);
        }
      },
      shouldStop: () => runToken !== keywordInsightRunToken,
    });
  } catch (error) {
    console.warn("[Sidebar] Keyword insight sampling failed:", error);
  } finally {
    if (runToken === keywordInsightRunToken) {
      keywordInsightSampleInFlight = false;
      renderKeywordInsightState();
    }
  }
}

async function startKeywordAnalysis({force = false} = {}) {
  if (keywordAnalysisInFlight) {
    if (force && isKeywordAnalysisLockStale()) {
      console.warn(
        "[Sidebar] Keyword analysis lock stale, force releasing lock",
      );
      releaseKeywordAnalysisLock();
      renderKeywordInsightState();
    } else {
      return;
    }
  }

  const seedKeyword = getKeywordInsightSeedKeyword({preferStored: true});
  if (!seedKeyword) {
    if (force) {
      showMessage(
        "未检测到页面回填关键词，请先进入搜索结果页后再重试",
        "warning",
      );
    }
    return;
  }
  if (expandedKeywordsBuffer.length === 0) {
    if (force) {
      showMessage("未检测到扩展词，请先扩词后再重试", "warning");
    }
    return;
  }
  if (
    !ensureAuthVerifiedOrWarn({
      message: getKeywordInsightAuthRequiredMessage(),
    })
  ) {
    return;
  }

  const draft = getKeywordInsightState();
  if (!force && draft.analysisStatus === "success" && draft.analysisResult) {
    renderKeywordInsightState();
    return;
  }

  keywordAnalysisInFlight = true;
  keywordAnalysisStartedAt = Date.now();
  keywordInsightRunToken += 1;
  const runToken = keywordInsightRunToken;

  updateKeywordInsightState({
    analysisVersion: (draft.analysisVersion || 0) + 1,
    analysisStatus: "loading",
    analysisErrorMessage: "",
    analysisResult: null,
    selectedCategoryIds: [],
    sampleStatusByCategoryId: {},
    sampleResultsByCategoryId: {},
  });
  renderKeywordInsightState();
  persistCurrentBatchDraft();

  try {
    const runtime = getCurrentRuntime();
    const pagePlatform = getPagePlatform(runtime);
    let baseSearchUrl = runtime?.lastPageUrl || "";
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.url) {
        baseSearchUrl = tab.url;
      }
    } catch {
      // ignore
    }

    const analysisKeywords = dedupeKeywords(
      expandedKeywordsBuffer
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    );
    const dedupedCount =
      expandedKeywordsBuffer.length - analysisKeywords.length;
    if (dedupedCount > 0) {
      showMessage(
        `分析前已去重 ${dedupedCount} 个重复词，实际分析 ${analysisKeywords.length} 个词`,
        "warning",
      );
    }

    const response = await analyzeKeywords({
      seedKeyword,
      keywords: analysisKeywords,
      platform: pagePlatform,
    });
    if (!response?.ok || !response?.data) {
      const requestError = new Error(
        response?.error?.message || response?.message || "智能分析暂时不可用",
      );
      requestError.reason =
        response?.error?.reason || response?.reason || "server_error";
      requestError.data = response?.error?.data || response?.data || null;
      throw requestError;
    }
    if (runToken !== keywordInsightRunToken) {
      return;
    }

    const analysisResult = response.data;

    updateKeywordInsightState({
      analysisStatus: "success",
      analysisErrorMessage: "",
      analysisResult,
      selectedCategoryIds: [],
      selectedKeywords: [],
      sampleStatusByCategoryId: {},
      sampleResultsByCategoryId: {},
    });
    renderKeywordInsightState();
    persistCurrentBatchDraft();

    if (runToken === keywordInsightRunToken) {
      await runKeywordInsightSampling({
        analysisResult,
        baseSearchUrl,
        runToken,
      });
    }
  } catch (error) {
    if (runToken !== keywordInsightRunToken) {
      return;
    }
    const errorReason = String(error?.reason || "")
      .trim()
      .toLowerCase();
    if (errorReason === "insufficient_balance") {
      const requiredCredits = Number(error?.data?.requiredCredits);
      const requiredCreditsLabel =
        Number.isInteger(requiredCredits) && requiredCredits > 0
          ? requiredCredits
          : KEYWORD_INSIGHT_ANALYSIS_COST_CREDITS;
      updateKeywordInsightState({
        analysisStatus: "idle",
        analysisErrorMessage: "",
        analysisResult: null,
        selectedCategoryIds: [],
        selectedKeywords: [],
        sampleStatusByCategoryId: {},
        sampleResultsByCategoryId: {},
      });
      renderKeywordInsightState();
      persistCurrentBatchDraft();
      showMessage(
        `配额不足：不影响采集扩展词，但智能分析需 ${requiredCreditsLabel} 配额。获取更多配额后可继续完整分析。`,
        "warning",
      );
      void refreshVerifiedAuthSnapshot();
      return;
    }
    const formattedError = formatKeywordStrategyAccessError(
      error,
      getKeywordInsightAuthRequiredMessage(),
    );
    const rawErrorMessage =
      formattedError.message || "智能分析暂时不可用，已保留扩展词，可稍后重试";
    const isTimeoutError =
      formattedError.kind === "generic" &&
      /timeout/i.test(String(rawErrorMessage));
    const displayMessage = isTimeoutError
      ? "请求超时（模型响应较慢或服务繁忙），可稍后重试"
      : rawErrorMessage;
    updateKeywordInsightState({
      analysisStatus: "error",
      analysisErrorMessage: displayMessage,
      analysisResult: null,
      selectedCategoryIds: [],
      sampleStatusByCategoryId: {},
      sampleResultsByCategoryId: {},
    });
    renderKeywordInsightState();
    persistCurrentBatchDraft();
    showMessage(`智能分析不可用：${displayMessage}`, "warning");
  } finally {
    if (runToken === keywordInsightRunToken) {
      releaseKeywordAnalysisLock();
      renderKeywordInsightState();
    }
  }
}

async function retryKeywordAnalysis() {
  if (keywordAnalysisInFlight && !isKeywordAnalysisLockStale()) {
    showMessage("智能分析进行中，请稍候", "warning");
    return;
  }
  if (keywordAnalysisInFlight && isKeywordAnalysisLockStale()) {
    releaseKeywordAnalysisLock();
  }
  await startKeywordAnalysis({force: true});
}

function handleKeywordInsightSummaryActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const actionEl = target.closest("[data-action]");
  const action = actionEl?.dataset?.action || "";

  if (action === "copy-insight") {
    handleCopyInsight(actionEl);
    return;
  }
  if (action === "share-as-image") {
    handleShareAsImage();
    return;
  }
}

function handleCopyInsight(btn) {
  const draft = getKeywordInsightState();
  const analysis = draft.analysisResult;
  if (!analysis || !btn) return;

  const lines = [];
  const summary = String(analysis.summary || "").trim();
  if (summary) {
    lines.push("【需求洞察】");
    lines.push(summary);
  }
  const categories = Array.isArray(analysis.categories)
    ? analysis.categories
    : [];
  for (const category of categories) {
    const name = String(category?.name || "").trim();
    const icon = String(category?.icon || "").trim();
    const insight = String(category?.insight || "").trim();
    const keywords = Array.isArray(category?.keywords) ? category.keywords : [];
    lines.push("");
    lines.push(`${icon} ${name}`.trim());
    if (insight) lines.push(insight);
    if (keywords.length > 0) lines.push(keywords.join("、"));
  }

  const text = lines.join("\n").trim();
  if (!text) return;

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        btn.innerHTML = original;
      }, 1500);
    })
    .catch(() => {});
}

function buildInsightShareData() {
  const draft = getKeywordInsightState();
  const batchDraft = getBatchDraftForPlatform();
  const analysis = draft.analysisResult;
  if (!analysis) return null;
  const categories = Array.isArray(analysis.categories)
    ? analysis.categories
    : [];
  return {
    seedKeyword: batchDraft.seedKeyword || "",
    totalKeywords: expandedKeywordsBuffer.length,
    summary: analysis.summary || "",
    categories: categories.map((cat) => {
      const result = {
        id: cat.id || "",
        icon: cat.icon || "",
        name: cat.name || "",
        insight: cat.insight || "",
        keywords: Array.isArray(cat.keywords) ? cat.keywords : [],
      };
      const sampleResult = draft.sampleResultsByCategoryId?.[cat.id];
      if (sampleResult?.samples?.length) {
        result.sampleKeyword = sampleResult.usedKeyword || "";
        result.samples = sampleResult.samples.map((s) => ({
          title: s.title || "",
          author: s.author || "",
          likes: s.likes || 0,
        }));
      }
      return result;
    }),
    ts: Date.now(),
  };
}

function handleShareAsImage() {
  const data = buildInsightShareData();
  if (!data) {
    showMessage("暂无洞察结果可分享", "warning");
    return;
  }

  renderInsightCardToImage(data);
}

function renderInsightCardToImage(data) {
  const dpr = window.devicePixelRatio || 2;
  const W = 640;
  const PAD = 32;
  const CONTENT_W = W - PAD * 2;

  const catColors = [
    {
      accent: "#4F8BF5",
      light: "#eef3ff",
      chip: "#dbeafe",
      chipText: "#2563eb",
      bar: ["#4F8BF5", "#93bbfd"],
    },
    {
      accent: "#8B5CF6",
      light: "#f0eeff",
      chip: "#ede9fe",
      chipText: "#6d28d9",
      bar: ["#8B5CF6", "#c4b5fd"],
    },
    {
      accent: "#EC4899",
      light: "#fdf2f8",
      chip: "#fce7f3",
      chipText: "#be185d",
      bar: ["#EC4899", "#f9a8d4"],
    },
    {
      accent: "#F97316",
      light: "#fff7ed",
      chip: "#ffedd5",
      chipText: "#c2410c",
      bar: ["#F97316", "#fdba74"],
    },
  ];

  const logoImg = new Image();
  logoImg.src = chrome.runtime.getURL("images/icon128.png");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.textBaseline = "top";

  function measureLines(text, fontSize, maxWidth) {
    ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const words = text.split("");
    const lines = [];
    let currentLine = "";
    for (const char of words) {
      const test = currentLine + char;
      if (ctx.measureText(test).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  function preCalcHeight() {
    let h = 0;
    h += 100;
    const summaryLines = measureLines(data.summary || "", 14, CONTENT_W);
    h += 30 + summaryLines.length * 22 + 20;
    h += 24;
    for (const cat of data.categories) {
      h += 44;
      const insightLines = measureLines(cat.insight || "", 13, CONTENT_W - 24);
      h += insightLines.length * 20 + 8;
      const keywords = cat.keywords || [];
      if (keywords.length > 0) {
        let rowW = 0;
        let rows = 1;
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        for (const kw of keywords) {
          const chipW = ctx.measureText(kw).width + 22;
          if (rowW + chipW + 6 > CONTENT_W - 24 && rowW > 0) {
            rows++;
            rowW = chipW + 6;
          } else {
            rowW += chipW + 6;
          }
        }
        h += rows * 28 + 10;
      }
      h += 16;
    }
    h += 36;
    return h;
  }

  function drawCard() {
    const H = preCalcHeight();
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.textBaseline = "top";

    const gradient = ctx.createLinearGradient(0, 0, W, H);
    gradient.addColorStop(0, "#f8f6ff");
    gradient.addColorStop(0.4, "#fdf2f8");
    gradient.addColorStop(0.7, "#eef3ff");
    gradient.addColorStop(1, "#fff7ed");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 16, 16, W - 32, H - 32, 16);
    ctx.fill();
    ctx.save();
    ctx.shadowColor = "rgba(99,102,241,0.08)";
    ctx.shadowBlur = 24;
    ctx.restore();

    let y = 16;

    const headerH = 88;
    const hGrad = ctx.createLinearGradient(16, y, W - 16, y);
    hGrad.addColorStop(0, "#4F8BF5");
    hGrad.addColorStop(0.4, "#8B5CF6");
    hGrad.addColorStop(0.75, "#EC4899");
    hGrad.addColorStop(1, "#F43F5E");
    ctx.fillStyle = hGrad;
    roundRectTop(ctx, 16, y, W - 32, headerH, 16);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.2)";
    const seedText = `🔍 ${data.seedKeyword}`;
    ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
    const seedW = ctx.measureText(seedText).width + 24;
    roundRect(ctx, PAD, y + 16, seedW, 28, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(seedText, PAD + 12, y + 22);

    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 20px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("关键词需求洞察", PAD, y + 56);

    const totalKw = data.categories.reduce(
      (s, c) => s + (c.keywords?.length || 0),
      0,
    );
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `500 12px -apple-system, "PingFang SC", sans-serif`;
    const statsText = `${totalKw} 个关联词 · ${data.categories.length} 个需求方向`;
    const statsW = ctx.measureText(statsText).width;
    ctx.fillText(statsText, W - PAD - 16 - statsW, y + 60);

    y += headerH + 20;

    ctx.fillStyle = "#8B5CF6";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("洞察摘要", PAD, y);
    y += 20;

    ctx.fillStyle = "#374151";
    ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
    const summaryLines = measureLines(data.summary || "", 14, CONTENT_W);
    for (const line of summaryLines) {
      ctx.fillText(line, PAD, y);
      y += 22;
    }
    y += 16;

    ctx.fillStyle = "#EC4899";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("需求方向", PAD, y);
    y += 24;

    for (let ci = 0; ci < data.categories.length; ci++) {
      const cat = data.categories[ci];
      const cc = catColors[ci % catColors.length];
      const keywords = cat.keywords || [];
      const pct =
        totalKw > 0 ? Math.round((keywords.length / totalKw) * 100) : 0;

      ctx.fillStyle = "#1a1a2e";
      ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(`${cat.icon || "📌"} ${cat.name}`, PAD + 4, y);

      ctx.fillStyle = cc.accent;
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      const pctText = `${keywords.length} 词 · ${pct}%`;
      const pctW = ctx.measureText(pctText).width;
      ctx.fillText(pctText, W - PAD - 16 - pctW, y + 2);
      y += 22;

      ctx.fillStyle = "#f3f4f6";
      roundRect(ctx, PAD + 4, y, CONTENT_W - 8, 4, 2);
      ctx.fill();
      const barGrad = ctx.createLinearGradient(
        PAD + 4,
        y,
        PAD + 4 + (CONTENT_W - 8),
        y,
      );
      barGrad.addColorStop(0, cc.bar[0]);
      barGrad.addColorStop(1, cc.bar[1]);
      ctx.fillStyle = barGrad;
      roundRect(
        ctx,
        PAD + 4,
        y,
        Math.max(((CONTENT_W - 8) * pct) / 100, 2),
        4,
        2,
      );
      ctx.fill();
      y += 12;

      if (cat.insight) {
        ctx.fillStyle = "#6b7280";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        const insightLines = measureLines(cat.insight, 13, CONTENT_W - 24);
        for (const line of insightLines) {
          ctx.fillText(line, PAD + 12, y);
          y += 20;
        }
        y += 4;
      }

      if (keywords.length > 0) {
        let rowX = PAD + 12;
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        for (const kw of keywords) {
          const chipW = ctx.measureText(kw).width + 22;
          if (rowX + chipW > W - PAD - 12 && rowX > PAD + 12) {
            rowX = PAD + 12;
            y += 28;
          }
          ctx.fillStyle = cc.chip;
          roundRect(ctx, rowX, y, chipW, 24, 12);
          ctx.fill();
          ctx.fillStyle = cc.chipText;
          ctx.fillText(kw, rowX + 11, y + 6);
          rowX += chipW + 6;
        }
        y += 34;
      }

      y += 8;
    }

    y += 8;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(PAD, y, CONTENT_W, 0.5);
    y += 36;

    const logoSize = 16;
    const gap = 6;
    const brandText = "StarVoice 星语";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    const brandTW = ctx.measureText(brandText).width;
    const urlText = "https://voice.minilife.online";
    ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
    const urlTW = ctx.measureText(urlText).width;
    const pillPadX = 8;
    const pillPadY = 3;
    const pillW = urlTW + pillPadX * 2;
    const pillH = 16;
    const urlGap = 10;
    const line1W = logoSize + gap + brandTW + urlGap + pillW;
    const line1X = (W - line1W) / 2;

    ctx.globalAlpha = 0.8;
    if (logoImg.complete && logoImg.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, line1X, y - 1, logoSize, logoSize, 3);
      ctx.clip();
      ctx.drawImage(logoImg, line1X, y - 1, logoSize, logoSize);
      ctx.restore();
    }

    ctx.fillStyle = "#9ca3af";
    ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(brandText, line1X + logoSize + gap, y);

    const pillX = line1X + logoSize + gap + brandTW + urlGap;
    const pillY = y - 1;
    ctx.fillStyle = "#f5f3ff";
    roundRect(ctx, pillX, pillY, pillW, pillH, 8);
    ctx.fill();
    ctx.fillStyle = "#a78bfa";
    ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(urlText, pillX + pillPadX, pillY + pillPadY);

    y += 20;
    const features =
      "账号监控｜低粉爆款筛选｜搜索词洞察｜数据采集｜评论分析｜客资线索";
    ctx.fillStyle = "#c0c0c0";
    ctx.font = `400 9px -apple-system, "PingFang SC", sans-serif`;
    ctx.globalAlpha = 1.0;
    const featW = ctx.measureText(features).width;
    ctx.fillText(features, (W - featW) / 2, y);

    canvas.toBlob((blob) => {
      if (!blob) {
        showMessage("图片生成失败", "error");
        return;
      }
      showInsightImagePreview(blob, data.seedKeyword || "share");
    }, "image/png");
  }

  if (logoImg.complete) {
    drawCard();
  } else {
    logoImg.onload = drawCard;
    logoImg.onerror = drawCard;
  }
}

function renderKeywordOpportunityCardToImage(data) {
  const dpr = window.devicePixelRatio || 2;
  const W = 640;
  const PAD = 32;
  const CONTENT_W = W - PAD * 2;
  const logoImg = new Image();
  logoImg.src = chrome.runtime.getURL("images/icon128.png");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.textBaseline = "top";

  function measureLines(text, fontSize, maxWidth) {
    ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const chars = String(text || "").split("");
    const lines = [];
    let currentLine = "";
    for (const char of chars) {
      const test = currentLine + char;
      if (ctx.measureText(test).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }

  function calcChipRows(items, maxWidth, baseX, gap = 6) {
    if (!Array.isArray(items) || items.length === 0) {
      return 0;
    }
    let rows = 1;
    let rowX = baseX;
    ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
    for (const item of items) {
      const text = String(item || "").trim();
      if (!text) continue;
      const chipW = ctx.measureText(text).width + 22;
      if (rowX + chipW > W - PAD - 12 && rowX > baseX) {
        rows += 1;
        rowX = baseX + chipW + gap;
      } else {
        rowX += chipW + gap;
      }
    }
    return rows;
  }

  function preCalcHeight() {
    let h = 0;
    h += 122;
    const distributionLines = measureLines(
      data.distributionSummary || "",
      14,
      CONTENT_W,
    );
    h += distributionLines.length * 22 + 30;
    h += Math.ceil((data.metrics.length || 0) / 2) * 82 + 22;
    h += 28;
    const subtopicRows = calcChipRows(data.subtopics || [], CONTENT_W, PAD);
    h += Math.max(subtopicRows, 1) * 30 + 24;
    h += 24;
    if (Array.isArray(data.directions) && data.directions.length > 0) {
      for (const direction of data.directions || []) {
        h += 52;
        const whyLines = measureLines(
          direction.whyItWorks || "",
          13,
          CONTENT_W - 24,
        );
        h += whyLines.length * 20 + 14;
      }
    } else {
      h += 34;
    }
    h += 24;
    if (Array.isArray(data.angles) && data.angles.length > 0) {
      for (const angle of data.angles || []) {
        const body = [
          directionSafeText(angle.audiencePainPoint),
          angle.formatSuggestion
            ? `形式建议：${directionSafeText(angle.formatSuggestion)}`
            : "",
          angle.executionHint
            ? `执行提示：${directionSafeText(angle.executionHint)}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const titleLines = measureLines(angle.title || "", 14, CONTENT_W - 24);
        const bodyLines = measureLines(body, 13, CONTENT_W - 24);
        h += 34 + titleLines.length * 20 + bodyLines.length * 19 + 18;
      }
    } else {
      h += 34;
    }
    h += 68;
    return h;
  }

  function directionSafeText(value) {
    return String(value || "").trim();
  }

  function drawCard() {
    const H = preCalcHeight();
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.textBaseline = "top";

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#fff8ef");
    bg.addColorStop(0.4, "#fffdf7");
    bg.addColorStop(0.75, "#f4f7ff");
    bg.addColorStop(1, "#eef9ff");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 16, 16, W - 32, H - 32, 18);
    ctx.fill();

    let y = 16;
    const headerH = 104;
    const headerGrad = ctx.createLinearGradient(16, y, W - 16, y);
    headerGrad.addColorStop(0, "#F97316");
    headerGrad.addColorStop(0.55, "#F59E0B");
    headerGrad.addColorStop(1, "#FB7185");
    ctx.fillStyle = headerGrad;
    roundRectTop(ctx, 16, y, W - 32, headerH, 18);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
    const keywordText = `主词 ${data.keyword || "未命名"}`;
    const keywordW = ctx.measureText(keywordText).width + 24;
    roundRect(ctx, PAD, y + 18, keywordW, 28, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(keywordText, PAD + 12, y + 24);

    ctx.font = `bold 22px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("判断赛道机会", PAD, y + 58);

    y += headerH + 24;

    if (data.distributionSummary) {
      ctx.fillStyle = "#6b7280";
      ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
      const summaryLines = measureLines(
        data.distributionSummary,
        14,
        CONTENT_W,
      );
      for (const line of summaryLines) {
        ctx.fillText(line, PAD, y);
        y += 22;
      }
      y += 16;
    }

    const metricCols = 2;
    const metricGap = 12;
    const metricW = (CONTENT_W - metricGap) / metricCols;
    const metricH = 70;
    (data.metrics || []).forEach((metric, index) => {
      const col = index % metricCols;
      const row = Math.floor(index / metricCols);
      const x = PAD + col * (metricW + metricGap);
      const my = y + row * (metricH + 12);
      ctx.fillStyle = "#fff7ed";
      roundRect(ctx, x, my, metricW, metricH, 16);
      ctx.fill();
      ctx.fillStyle = "#9a3412";
      ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(metric.label || "", x + 16, my + 14);
      ctx.fillStyle = "#111827";
      ctx.font = `bold 18px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(metric.value || "-", x + 16, my + 34);
    });
    y +=
      Math.ceil((data.metrics.length || 0) / metricCols) * (metricH + 12) + 8;

    ctx.fillStyle = "#f59e0b";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("核心爆款细分词", PAD, y);
    y += 22;

    if (Array.isArray(data.subtopics) && data.subtopics.length > 0) {
      let rowX = PAD;
      ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
      for (const item of data.subtopics) {
        const text = String(item || "").trim();
        if (!text) continue;
        const chipW = ctx.measureText(text).width + 22;
        if (rowX + chipW > W - PAD && rowX > PAD) {
          rowX = PAD;
          y += 30;
        }
        ctx.fillStyle = "#ffedd5";
        roundRect(ctx, rowX, y, chipW, 24, 12);
        ctx.fill();
        ctx.fillStyle = "#c2410c";
        ctx.fillText(text, rowX + 11, y + 6);
        rowX += chipW + 6;
      }
      y += 34;
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("暂无明确细分切口", PAD, y);
      y += 26;
    }

    ctx.fillStyle = "#ef4444";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("爆款主题方向", PAD, y);
    y += 24;

    if (Array.isArray(data.directions) && data.directions.length > 0) {
      for (const direction of data.directions || []) {
        ctx.fillStyle = "#fffaf5";
        roundRect(ctx, PAD, y, CONTENT_W, 72, 16);
        ctx.fill();
        ctx.fillStyle = "#111827";
        ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText(direction.name || "未命名方向", PAD + 14, y + 14);
        const metaText = `${direction.sampleCount || 0} 篇 · ${direction.shareRatio || 0}%`;
        ctx.fillStyle = "#f97316";
        ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
        const metaW = ctx.measureText(metaText).width;
        ctx.fillText(metaText, PAD + CONTENT_W - 14 - metaW, y + 16);
        const whyLines = measureLines(
          direction.whyItWorks || "",
          13,
          CONTENT_W - 28,
        );
        ctx.fillStyle = "#6b7280";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        let innerY = y + 38;
        for (const line of whyLines) {
          ctx.fillText(line, PAD + 14, innerY);
          innerY += 20;
        }
        y = Math.max(y + 72, innerY + 12);
      }
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("当前样本中还没有稳定聚合出足够清晰的主题方向", PAD, y);
      y += 26;
    }

    y += 8;
    ctx.fillStyle = "#6366f1";
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("新号优先选题", PAD, y);
    y += 24;

    if (Array.isArray(data.angles) && data.angles.length > 0) {
      for (const angle of data.angles || []) {
        const body = [
          directionSafeText(angle.audiencePainPoint),
          angle.formatSuggestion
            ? `形式建议：${directionSafeText(angle.formatSuggestion)}`
            : "",
          angle.executionHint
            ? `执行提示：${directionSafeText(angle.executionHint)}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const titleLines = measureLines(angle.title || "", 14, CONTENT_W - 28);
        const bodyLines = measureLines(body, 13, CONTENT_W - 28);
        const cardH =
          18 + titleLines.length * 20 + 8 + bodyLines.length * 19 + 16;
        ctx.fillStyle = "#f5f3ff";
        roundRect(ctx, PAD, y, CONTENT_W, cardH, 16);
        ctx.fill();
        ctx.fillStyle = "#312e81";
        ctx.font = `600 14px -apple-system, "PingFang SC", sans-serif`;
        let innerY = y + 14;
        for (const line of titleLines) {
          ctx.fillText(line, PAD + 14, innerY);
          innerY += 20;
        }
        ctx.fillStyle = "#5b5f97";
        ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
        innerY += 4;
        for (const line of bodyLines) {
          ctx.fillText(line, PAD + 14, innerY);
          innerY += 19;
        }
        y += cardH + 10;
      }
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = `13px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("当前还没有生成可直接执行的主词选题", PAD, y);
      y += 26;
    }

    y += 8;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(PAD, y, CONTENT_W, 0.5);
    y += 18;

    const brandText = "StarVoice 星语";
    const urlText = "https://voice.minilife.online";
    const logoSize = 16;
    const gap = 6;
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    const brandW = ctx.measureText(brandText).width;
    ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
    const urlW = ctx.measureText(urlText).width;
    const pillW = urlW + 16;
    const lineW = logoSize + gap + brandW + 10 + pillW;
    const startX = (W - lineW) / 2;

    if (logoImg.complete && logoImg.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, startX, y - 1, logoSize, logoSize, 3);
      ctx.clip();
      ctx.drawImage(logoImg, startX, y - 1, logoSize, logoSize);
      ctx.restore();
    }
    ctx.fillStyle = "#9ca3af";
    ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(brandText, startX + logoSize + gap, y);
    const pillX = startX + logoSize + gap + brandW + 10;
    ctx.fillStyle = "#eef2ff";
    roundRect(ctx, pillX, y - 1, pillW, 16, 8);
    ctx.fill();
    ctx.fillStyle = "#818cf8";
    ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(urlText, pillX + 8, y + 2);

    canvas.toBlob((blob) => {
      if (!blob) {
        showMessage("图片生成失败", "error");
        return;
      }
      showInsightImagePreview(blob, data.keyword || "opportunity");
    }, "image/png");
  }

  if (logoImg.complete) {
    drawCard();
  } else {
    logoImg.onload = drawCard;
    logoImg.onerror = drawCard;
  }
}

function renderBenchmarkDiscoveryCardToImage(data) {
  const dpr = window.devicePixelRatio || 2;
  const W = 640;
  const PAD = 32;
  const CONTENT_W = W - PAD * 2;
  const logoImg = new Image();
  logoImg.src = chrome.runtime.getURL("images/icon128.png");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.textBaseline = "top";

  function measureLines(text, fontSize, maxWidth) {
    ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const chars = String(text || "").split("");
    const lines = [];
    let currentLine = "";
    for (const char of chars) {
      const test = currentLine + char;
      if (ctx.measureText(test).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }

  function measureChipRows(tags, maxWidth) {
    if (!Array.isArray(tags) || tags.length === 0) {
      return 0;
    }
    let rows = 1;
    let rowW = 0;
    ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
    tags.forEach((tag) => {
      const text = String(tag || "").trim();
      if (!text) return;
      const chipW = ctx.measureText(text).width + 22;
      if (rowW + chipW + 6 > maxWidth && rowW > 0) {
        rows += 1;
        rowW = chipW + 6;
      } else {
        rowW += chipW + 6;
      }
    });
    return rows;
  }

  function candidateHeight(candidate) {
    const innerW = CONTENT_W - 28;
    const reasonLines = measureLines(
      candidate.recommendationReason || "",
      14,
      innerW,
    );
    const focusLines = measureLines(candidate.focusAssessment || "", 12, innerW);
    const tagRows = measureChipRows(candidate.tags || [], innerW);
    const evidenceLines = (candidate.evidence || [])
      .slice(0, 3)
      .flatMap((item) => measureLines(item, 12, innerW - 12));
    const workLines = (candidate.works || [])
      .slice(0, 2)
      .flatMap((item) =>
        measureLines(
          `${item.title}  赞 ${formatOpportunityMetric(item.likes)}`,
          12,
          innerW - 12,
        ),
      );
    return (
      52 +
      reasonLines.length * 21 +
      focusLines.length * 19 +
      Math.max(tagRows, 1) * 25 +
      28 +
      evidenceLines.length * 18 +
      (workLines.length > 0 ? 28 + workLines.length * 18 : 0) +
      24
    );
  }

  function preCalcHeight() {
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    let h = 0;
    h += 122;
    const summaryLines = measureLines(
      `从 ${data.sampleCount || 0} 条搜索结果中筛出 ${data.candidateCount || 0} 个候选账号，入围门槛为样本出现 ${data.minOccurrence || 2} 次。`,
      14,
      CONTENT_W,
    );
    h += summaryLines.length * 22 + 28;
    candidates.forEach((candidate) => {
      h += candidateHeight(candidate) + 12;
    });
    h += 68;
    return h;
  }

  function drawPill(text, x, y, color, bg) {
    const safeText = String(text || "").trim();
    if (!safeText) return 0;
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    const w = ctx.measureText(safeText).width + 22;
    ctx.fillStyle = bg;
    roundRect(ctx, x, y, w, 23, 12);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(safeText, x + 11, y + 6);
    return w;
  }

  function drawCard() {
    const H = preCalcHeight();
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.textBaseline = "top";

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#f0fdfa");
    bg.addColorStop(0.46, "#ffffff");
    bg.addColorStop(1, "#eef2ff");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 16, 16, W - 32, H - 32, 18);
    ctx.fill();

    let y = 16;
    const headerH = 104;
    const headerGrad = ctx.createLinearGradient(16, y, W - 16, y);
    headerGrad.addColorStop(0, "#0F766E");
    headerGrad.addColorStop(0.58, "#14B8A6");
    headerGrad.addColorStop(1, "#6366F1");
    ctx.fillStyle = headerGrad;
    roundRectTop(ctx, 16, y, W - 32, headerH, 18);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.font = `500 14px -apple-system, "PingFang SC", sans-serif`;
    const keywordText = `关键词 ${data.keyword || "未命名"}`;
    const keywordW = ctx.measureText(keywordText).width + 24;
    roundRect(ctx, PAD, y + 18, keywordW, 28, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(keywordText, PAD + 12, y + 24);

    ctx.font = `bold 22px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText("对标账号推荐", PAD, y + 58);
    y += headerH + 24;

    const summary = `从 ${data.sampleCount || 0} 条搜索结果中筛出 ${data.candidateCount || 0} 个候选账号，入围门槛为样本出现 ${data.minOccurrence || 2} 次。`;
    ctx.fillStyle = "#4b5563";
    ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
    measureLines(summary, 14, CONTENT_W).forEach((line) => {
      ctx.fillText(line, PAD, y);
      y += 22;
    });
    y += 18;

    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    candidates.forEach((candidate) => {
      const cardH = candidateHeight(candidate);
      ctx.fillStyle = "#f8fafc";
      roundRect(ctx, PAD, y, CONTENT_W, cardH, 16);
      ctx.fill();

      let innerY = y + 16;
      const rankBg =
        candidate.growthPotential === "high"
          ? "#dcfce7"
          : candidate.growthPotential === "low"
            ? "#e5e7eb"
            : "#fef3c7";
      const rankColor =
        candidate.growthPotential === "high"
          ? "#047857"
          : candidate.growthPotential === "low"
            ? "#475569"
            : "#92400e";
      ctx.fillStyle = rankBg;
      roundRect(ctx, PAD + 14, innerY, 34, 34, 10);
      ctx.fill();
      ctx.fillStyle = rankColor;
      ctx.font = `bold 15px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(`#${candidate.rank || ""}`, PAD + 21, innerY + 8);

      ctx.fillStyle = "#111827";
      ctx.font = `700 17px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(candidate.name || "未知账号", PAD + 58, innerY + 3);
      innerY += 46;

      ctx.fillStyle = "#111827";
      ctx.font = `14px -apple-system, "PingFang SC", sans-serif`;
      measureLines(
        candidate.recommendationReason || "",
        14,
        CONTENT_W - 28,
      ).forEach((line) => {
        ctx.fillText(line, PAD + 14, innerY);
        innerY += 21;
      });

      if (candidate.focusAssessment) {
        ctx.fillStyle = "#6b7280";
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        measureLines(candidate.focusAssessment, 12, CONTENT_W - 28).forEach(
          (line) => {
            ctx.fillText(line, PAD + 14, innerY + 2);
            innerY += 19;
          },
        );
      }

      innerY += 8;
      let chipX = PAD + 14;
      (candidate.tags || []).forEach((tag) => {
        const text = String(tag || "").trim();
        if (!text) return;
        ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
        const w = ctx.measureText(text).width + 22;
        if (chipX + w > W - PAD - 14) {
          chipX = PAD + 14;
          innerY += 25;
        }
        drawPill(text, chipX, innerY, "#0f766e", "#ccfbf1");
        chipX += w + 6;
      });
      innerY += 32;

      ctx.fillStyle = "#0f766e";
      ctx.font = `700 12px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText("判断依据", PAD + 14, innerY);
      innerY += 20;
      ctx.fillStyle = "#4b5563";
      ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
      (candidate.evidence || []).slice(0, 3).forEach((item) => {
        measureLines(item, 12, CONTENT_W - 40).forEach((line, index) => {
          ctx.fillText(index === 0 ? `- ${line}` : `  ${line}`, PAD + 18, innerY);
          innerY += 18;
        });
      });

      const works = Array.isArray(candidate.works) ? candidate.works : [];
      if (works.length > 0) {
        innerY += 8;
        ctx.fillStyle = "#6366f1";
        ctx.font = `700 12px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText("代表作品", PAD + 14, innerY);
        innerY += 20;
        ctx.fillStyle = "#4b5563";
        ctx.font = `12px -apple-system, "PingFang SC", sans-serif`;
        works.slice(0, 2).forEach((work) => {
          const text = `${work.title}  赞 ${formatOpportunityMetric(work.likes)}`;
          measureLines(text, 12, CONTENT_W - 40).forEach((line, index) => {
            ctx.fillText(index === 0 ? `- ${line}` : `  ${line}`, PAD + 18, innerY);
            innerY += 18;
          });
        });
      }

      y += cardH + 12;
    });

    y += 6;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(PAD, y, CONTENT_W, 0.5);
    y += 18;

    const brandText = "StarVoice（社媒虾）";
    const urlText = "https://voice.minilife.online";
    const logoSize = 16;
    const gap = 6;
    ctx.font = `600 12px -apple-system, "PingFang SC", sans-serif`;
    const brandW = ctx.measureText(brandText).width;
    ctx.font = `500 10px -apple-system, "PingFang SC", sans-serif`;
    const urlW = ctx.measureText(urlText).width;
    const pillW = urlW + 16;
    const lineW = logoSize + gap + brandW + 10 + pillW;
    const startX = (W - lineW) / 2;

    if (logoImg.complete && logoImg.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, startX, y - 1, logoSize, logoSize, 3);
      ctx.clip();
      ctx.drawImage(logoImg, startX, y - 1, logoSize, logoSize);
      ctx.restore();
    }
    ctx.fillStyle = "#9ca3af";
    ctx.font = `500 11px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(brandText, startX + logoSize + gap, y);
    const pillX = startX + logoSize + gap + brandW + 10;
    ctx.fillStyle = "#ecfeff";
    roundRect(ctx, pillX, y - 1, pillW, 16, 8);
    ctx.fill();
    ctx.fillStyle = "#14b8a6";
    ctx.font = `400 10px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText(urlText, pillX + 8, y + 2);

    canvas.toBlob((blob) => {
      if (!blob) {
        showMessage("图片生成失败", "error");
        return;
      }
      showInsightImagePreview(blob, data.keyword || "benchmark");
    }, "image/png");
  }

  if (logoImg.complete) {
    drawCard();
  } else {
    logoImg.onload = drawCard;
    logoImg.onerror = drawCard;
  }
}

function showInsightImagePreview(blob, seedKeyword) {
  const existing = document.getElementById("insightImagePreviewOverlay");
  if (existing) existing.remove();

  const blobUrl = URL.createObjectURL(blob);

  const overlay = document.createElement("div");
  overlay.id = "insightImagePreviewOverlay";
  overlay.className = "insight-preview-overlay";
  overlay.innerHTML = `
    <div class="insight-preview-dialog">
      <div class="insight-preview-header">
        <span class="insight-preview-title">图片预览</span>
        <button type="button" class="insight-preview-close" id="insightPreviewClose" title="关闭">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
        </button>
      </div>
      <div class="insight-preview-body" id="insightPreviewBody">
        <img src="${blobUrl}" class="insight-preview-img" id="insightPreviewImg" alt="洞察分享图片" />
      </div>
      <div class="insight-preview-footer">
        <span class="insight-preview-zoom-hint">滚轮缩放 · 双击还原</span>
        <div class="insight-preview-actions">
          <button type="button" class="btn btn-secondary" id="insightPreviewCopy">复制</button>
          <button type="button" class="btn btn-secondary" id="insightPreviewDownload">下载</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const body = overlay.querySelector("#insightPreviewBody");
  const img = overlay.querySelector("#insightPreviewImg");
  let scale = 1;
  let tx = 0,
    ty = 0;
  let dragging = false,
    startX = 0,
    startY = 0,
    startTx = 0,
    startTy = 0;

  const applyTransform = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const resetZoom = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
  };

  body.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      scale = Math.min(5, Math.max(0.5, scale + delta));
      if (scale <= 1) {
        tx = 0;
        ty = 0;
      }
      applyTransform();
    },
    {passive: false},
  );

  body.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (scale !== 1) {
      resetZoom();
    } else {
      scale = 2.5;
      applyTransform();
    }
  });

  body.addEventListener("mousedown", (e) => {
    if (scale <= 1) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startTx = tx;
    startTy = ty;
    body.classList.add("is-dragging");
    e.preventDefault();
  });

  const onMouseMove = (e) => {
    if (!dragging) return;
    tx = startTx + (e.clientX - startX);
    ty = startTy + (e.clientY - startY);
    applyTransform();
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    body.classList.remove("is-dragging");
  };

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  const close = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    overlay.remove();
    URL.revokeObjectURL(blobUrl);
  };

  overlay
    .querySelector("#insightPreviewClose")
    .addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay
    .querySelector("#insightPreviewDownload")
    .addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `onstarvoice-insight-${seedKeyword}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showMessage("图片已保存", "success");
    });

  overlay
    .querySelector("#insightPreviewCopy")
    .addEventListener("click", async () => {
      if (
        typeof navigator === "undefined" ||
        !navigator.clipboard ||
        typeof navigator.clipboard.write !== "function" ||
        typeof window.ClipboardItem !== "function"
      ) {
        showMessage("当前环境暂不支持复制图片，请使用下载", "warning");
        return;
      }

      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            [blob.type || "image/png"]: blob,
          }),
        ]);
        showMessage("图片已复制到剪贴板", "success");
      } catch (error) {
        console.warn("[Sidebar] Failed to copy image", error);
        showMessage("复制图片失败，请尝试下载", "error");
      }
    });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function roundRectTop(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function handleKeywordInsightCategoryActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action =
    target.dataset?.action ||
    target.closest("[data-action]")?.dataset?.action ||
    "";

  if (action === "toggle-expand-category") {
    const categoryId = String(
      target.dataset?.categoryId ||
        target.closest("[data-category-id]")?.dataset?.categoryId ||
        "",
    ).trim();
    if (!categoryId) return;
    if (expandedKeywordInsightCategoryIds.has(categoryId)) {
      expandedKeywordInsightCategoryIds.delete(categoryId);
    } else {
      expandedKeywordInsightCategoryIds.add(categoryId);
    }
    renderKeywordInsightState();
    return;
  }

  if (action === "toggle-keyword") {
    const chip = target.closest("[data-keyword]");
    const keyword = String(
      chip?.dataset?.keyword || target.dataset?.keyword || "",
    ).trim();
    if (!keyword) return;

    navigator.clipboard.writeText(keyword).then(() => {
      showMessage(`已复制: ${keyword}`, "success");
    }).catch((err) => {
      console.error("[Sidebar] copy failed:", err);
      showMessage("复制失败", "error");
    });
  }
}



async function handleExpandKeywords() {
  if (keywordExpandInFlight) {
    await requestKeywordExpandCancel();
    return;
  }

  const runtime = getCurrentRuntime();
  const seedKeyword = getKeywordInsightSeedKeyword({runtime});
  if (!seedKeyword) {
    showMessage(
      "仅支持分析当前页面回填的关键词，请先进入搜索结果页",
      "warning",
    );
    return;
  }

  if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
    showMessage("请先切换到搜索页", "error");
    return;
  }

  keywordExpandInFlight = true;
  keywordExpandCancelRequested = false;
  updateExpandKeywordsButtonState();

  // 扩词期间暂停排序检测轮询，避免频繁消息影响搜索框状态。
  stopKeywordSortSyncTimer();

  try {
    showProgress(`正在扩展关键词「${seedKeyword}」...`);

    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id) {
      showMessage("未找到当前活动标签页", "error");
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: tab.id,
      payload: {
        action: "expandKeywordSuggestions",
        seedKeyword,
        platform: detectPlatformFromUrl(tab.url || ""),
      },
    });

    const expandResult =
      response?.data &&
      typeof response.data === "object" &&
      "ok" in response.data
        ? response.data
        : response;

    if (!response?.ok || !expandResult?.ok) {
      throw new Error(
        expandResult?.error?.message ||
          response?.error?.message ||
          response?.data?.error?.message ||
          "扩词失败，请确认当前页面是搜索页",
      );
    }

    const data = expandResult?.data || {};
    expandedKeywordsBuffer = Array.isArray(data.expandedKeywords)
      ? data.expandedKeywords
      : [];
    expandedKeywordsPanelVisible = false;
    invalidateKeywordInsightDraft();
    console.info("[Sidebar] Expand keyword result received", {
      totalFound: data?.stats?.totalFound ?? 0,
      uniqueCount: expandedKeywordsBuffer.length,
    });

    await persistBatchDraftForPlatform();

    const stats = data?.stats || {totalFound: 0, duplicatesRemoved: 0};
    renderExpandedKeywords();
    showMessage(
      `扩词完成：共发现 ${stats.totalFound} 个联想词，去重后 ${expandedKeywordsBuffer.length} 个`,
      "success",
    );
    void startKeywordAnalysis({force: true});
  } catch (error) {
    console.error("[Sidebar] Expand keywords failed:", error);
    if (String(error?.message || "") === "扩词已取消") {
      showMessage("扩词已取消", "warning");
    } else {
      showMessage("扩词失败: " + error.message, "error");
    }
  } finally {
    hideProgress();
    keywordExpandInFlight = false;
    keywordExpandCancelRequested = false;
    updateExpandKeywordsButtonState();
    syncKeywordSortDimensionByRuntime(getCurrentRuntime()).catch((error) => {
      console.warn("[Sidebar] Resume keyword sort sync failed:", error);
    });
  }
}

function updateExpandKeywordsButtonState() {
  const btnExpand = document.getElementById("btnExpandKeywords");
  const btnIntroRun = document.getElementById("btnRunKeywordInsight");
  const currentKeyword = getKeywordInsightSeedKeyword();
  const hasResult = expandedKeywordsBuffer.length > 0;
  if (!btnExpand) {
    return;
  }

  if (keywordExpandInFlight) {
    btnExpand.disabled = false;
    btnExpand.textContent = keywordExpandCancelRequested
      ? "停止中..."
      : "停止分析";
    btnExpand.classList.remove("btn-secondary");
    btnExpand.classList.add("btn-danger");
    if (btnIntroRun) {
      btnIntroRun.disabled = false;
      btnIntroRun.textContent = keywordExpandCancelRequested
        ? "停止中..."
        : "停止分析";
      btnIntroRun.classList.remove("btn-primary");
      btnIntroRun.classList.add("btn-danger");
    }
    return;
  }

  btnExpand.disabled = !currentKeyword;
  btnExpand.textContent = hasResult ? "重新分析" : "开始分析长尾需求";
  btnExpand.classList.add("btn-secondary");
  btnExpand.classList.remove("btn-danger");
  if (btnIntroRun) {
    btnIntroRun.disabled = !currentKeyword;
    btnIntroRun.textContent = "开始分析长尾需求";
    btnIntroRun.classList.add("btn-primary");
    btnIntroRun.classList.remove("btn-danger");
  }
}

async function requestKeywordExpandCancel() {
  if (keywordExpandCancelRequested) {
    return;
  }

  keywordExpandCancelRequested = true;
  updateExpandKeywordsButtonState();

  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.id) {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.RELAY_TO_CONTENT,
        tabId: tab.id,
        payload: {action: "cancelCapture"},
      });
    }
  } catch (error) {
    console.warn("[Sidebar] Expand keyword cancel failed:", error);
  }

  showMessage("正在停止扩词...", "warning");
}

async function requestCaptureCancelSignal(
  preferTabId = null,
  captureRequestId = "",
) {
  let relayTabId = Number(preferTabId);
  if (!Number.isFinite(relayTabId) || relayTabId <= 0) {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    relayTabId = Number(tab?.id);
  }

  if (!Number.isFinite(relayTabId) || relayTabId <= 0) {
    return false;
  }

  const normalizedRequestId = String(captureRequestId || "").trim();
  const response = normalizedRequestId
    ? await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.CANCEL_CAPTURE,
        tabId: relayTabId,
        captureRequestId: normalizedRequestId,
      })
    : await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.RELAY_TO_CONTENT,
        tabId: relayTabId,
        payload: {action: "cancelCapture"},
      });
  if (response?.ok === false) {
    throw new Error(response?.error?.message || "取消请求发送失败");
  }
  return true;
}

function getKnownDetailRunnerTabIds(extraTabIds = []) {
  const tabIds = new Set(detailBatchRunnerTabIds);
  const activeTabId = Number(detailBatchRunnerTabId);
  if (Number.isSafeInteger(activeTabId) && activeTabId > 0) {
    tabIds.add(activeTabId);
  }
  for (const value of Array.isArray(extraTabIds) ? extraTabIds : []) {
    const tabId = Number(value);
    if (Number.isSafeInteger(tabId) && tabId > 0) tabIds.add(tabId);
  }
  return [...tabIds];
}

async function requestDetailRunnerCancelSignals({
  extraTabIds = [],
  fallbackTabId = null,
} = {}) {
  const runnerTabIds = getKnownDetailRunnerTabIds(extraTabIds);
  if (runnerTabIds.length === 0) {
    return await requestCaptureCancelSignal(fallbackTabId);
  }
  const settled = await Promise.allSettled(
    runnerTabIds.map((tabId) => requestCaptureCancelSignal(tabId)),
  );
  return settled.some(
    (result) => result.status === "fulfilled" && result.value === true,
  );
}

function parseKeywordsFromMultilineInput(rawText = "") {
  return String(rawText || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupeKeywords(keywords = []) {
  const seen = new Set();
  const unique = [];
  for (const keyword of keywords) {
    if (seen.has(keyword)) {
      continue;
    }
    seen.add(keyword);
    unique.push(keyword);
  }
  return unique;
}

function getExpandedKeywordsFromTextarea({dedupe = false} = {}) {
  const textarea = document.getElementById("textareaExpandedKeywords");
  const keywords = textarea
    ? parseKeywordsFromMultilineInput(textarea.value)
    : [...expandedKeywordsBuffer];
  return dedupe ? dedupeKeywords(keywords) : keywords;
}

// 可中断睡眠:每秒检查 shouldStop,用于循环采集的轮次间隔
function sleepWithStop(
  ms,
  shouldStop,
  {onTick = null, tickEveryMs = 30 * 1000} = {},
) {
  return new Promise((resolve) => {
    const start = Date.now();
    const finishAt = start + Math.max(0, Number(ms) || 0);
    let lastTickAt = 0;
    const id = setInterval(() => {
      const now = Date.now();
      if ((shouldStop && shouldStop()) || now >= finishAt) {
        clearInterval(id);
        resolve();
        return;
      }
      if (
        typeof onTick === "function" &&
        (lastTickAt === 0 || now - lastTickAt >= Math.max(1000, tickEveryMs))
      ) {
        lastTickAt = now;
        try {
          onTick(Math.max(0, finishAt - now));
        } catch (error) {
          console.warn("[Sidebar] Wait progress callback failed:", error);
        }
      }
    }, 1000);
  });
}

function createStreamingDetailAutoSyncQueue(
  settings,
  {
    shouldStop = null,
    signal = null,
    captureTaskId = "",
    resolveCaptureTaskItemAttempt = null,
  } = {},
) {
  return createRecordSyncQueue({
    enabled: Boolean(
      settings?.autoDetailCaptureAfterListCapture &&
        settings?.autoSyncAfterDetailCapture,
    ),
    shouldStop,
    signal,
    retryDelaysMs: [1000, 3000, 8000],
    shouldRetry: isTransientStreamingSyncFailure,
    processRecord: async ({recordId, meta = {}, signal: jobSignal = null}) => {
      const captureAttempt =
        typeof resolveCaptureTaskItemAttempt === "function"
          ? resolveCaptureTaskItemAttempt(meta)
          : null;
      const result = await maybeRunAutoSyncAfterDetailCapture(settings, {
        sourceLabel: String(meta?.sourceLabel || "当前笔记"),
        recordIds: [recordId],
        silent: true,
        refreshAfter: false,
        shouldStop,
        signal: jobSignal || signal,
        captureTaskId,
        captureTaskItemAttemptId: String(
          captureAttempt?.attemptId || "",
        ).trim(),
        captureTaskItemRequestHash: String(
          captureAttempt?.requestHash || "",
        ).trim(),
      });
      return {
        ...result,
        blocked: result?.phase === "check",
        skipped:
          Boolean(result?.skipped) ||
          (Number(result?.successCount || 0) === 0 &&
            Number(result?.skippedCount || 0) > 0),
      };
    },
  });
}

function isTransientStreamingSyncFailure(result = {}) {
  if (
    result?.ok !== false ||
    result?.blocked ||
    result?.skipped ||
    result?.canceled ||
    result?.phase === "check"
  ) {
    return false;
  }
  const fragments = [
    result?.phase,
    result?.reason,
    result?.message,
    result?.pausedReason,
    result?.pausedMessage,
    result?.error?.code,
    result?.error?.message,
    ...(Array.isArray(result?.results)
      ? result.results.flatMap((item) => [
          item?.reason,
          item?.message,
          item?.error?.code,
          item?.error?.message,
        ])
      : []),
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const failureText = fragments.join(" ");
  return /(?:timeout|timed out|network|fetch|offline|rate.?limit|too many requests|econn|enet|eai_again|socket|connection|http[_ ]?5\d\d|\b(?:429|500|502|503|504)\b|网络|超时|限流|请求失败|服务繁忙|连接(?:失败|中断|重置))/i.test(
    failureText,
  );
}

function routeDetailItemToStreamingSync(
  streamingSyncQueue,
  progress = {},
  {sourceLabel = "当前笔记", keyword = ""} = {},
) {
  if (!streamingSyncQueue?.enabled) {
    return;
  }
  const recordId = String(progress?.recordId || "").trim();
  if (!recordId) {
    return;
  }
  const phase = String(progress?.phase || "");
  if (
    phase === "detail_item_filtered" ||
    phase === "detail_item_skipped"
  ) {
    streamingSyncQueue.markExcluded(recordId);
    return;
  }
  // Failed detail items must wait until the whole enhancement result is known.
  // Non-terminal failures are picked up by enqueueMissing below; an identity
  // or safety stop returns before that point, so unverified data never starts
  // syncing while the terminal decision is still in flight.
  if (phase !== "detail_item_done") {
    return;
  }
  streamingSyncQueue.enqueue(recordId, {sourceLabel, keyword});
}

function formatStreamingSyncSummary(stats = {}) {
  if (!stats?.enabled || Number(stats.enqueuedCount || 0) === 0) {
    return "";
  }
  const retryNote =
    Number(stats.retryCount || 0) > 0
      ? `，瞬时重试 ${Number(stats.retryCount || 0)}`
      : "";
  return `同步成功 ${Number(stats.successCount || 0)}，失败 ${Number(stats.failedCount || 0)}，待上传 ${Number(stats.remainingCount || 0)}${retryNote}`;
}

function buildStreamingSyncTaskIssue(stats = {}) {
  if (!stats?.enabled) return null;
  const failedCount = Number(stats.failedCount || 0);
  const remainingCount = Number(stats.remainingCount || 0);
  const blocked = Boolean(stats.blocked);
  if (!blocked && failedCount === 0 && remainingCount === 0) {
    return null;
  }
  const successCount = Number(stats.successCount || 0);
  const blockedReason = String(stats?.error?.message || "").trim();
  return {
    code: blocked ? "STREAMING_SYNC_BLOCKED" : "STREAMING_SYNC_INCOMPLETE",
    message: [
      blockedReason ? `数据同步未完成：${blockedReason}` : "数据同步未全部完成",
      `成功 ${successCount}，失败 ${failedCount}，待上传 ${remainingCount}`,
    ].join("；"),
  };
}

function buildStreamingSyncTaskMetadata(stats = {}) {
  return {
    syncSuccessCount: Number(stats?.successCount || 0),
    syncFailedCount: Number(stats?.failedCount || 0),
    syncSkippedCount: Number(stats?.skippedCount || 0),
    syncRemainingCount: Number(stats?.remainingCount || 0),
    syncRetryCount: Number(stats?.retryCount || 0),
    syncBlocked: Boolean(stats?.blocked),
  };
}

function appendStreamingSyncSummary(message, streamingSyncQueue) {
  const summary = formatStreamingSyncSummary(streamingSyncQueue?.getStats?.());
  return summary ? `${String(message || "").trim()} · ${summary}` : message;
}

async function drainStreamingDetailSyncQueue(
  streamingSyncQueue,
  {round = null, updateProgress = null, notifyProgress = null} = {},
) {
  if (!streamingSyncQueue?.enabled) {
    const disabledStats = streamingSyncQueue?.getStats?.();
    return disabledStats && typeof disabledStats === "object"
      ? {...disabledStats, drainCompleted: true}
      : null;
  }

  const before = streamingSyncQueue.getStats();
  if (Number(before.remainingCount || 0) > 0) {
    const waitingProgress = {
      current: Number(before.processedCount || 0),
      total: Number(before.enqueuedCount || 0),
      round,
      phase: "streaming_sync_drain",
      message: `采集已结束，正在上传剩余 ${Number(before.remainingCount || 0)} 条数据...`,
    };
    updateProgress?.(waitingProgress);
    notifyProgress?.(waitingProgress);
  }

  const result = await streamingSyncQueue.drain();
  await Promise.all([refreshDataPool(), refreshSyncHistory()]).catch(
    () => null,
  );
  const doneProgress = {
    current: Number(result.processedCount || 0),
    total: Number(result.enqueuedCount || 0),
    round,
    phase: "streaming_sync_done",
    syncSuccessCount: Number(result.successCount || 0),
    syncFailedCount: Number(result.failedCount || 0),
    syncSkippedCount: Number(result.skippedCount || 0),
    syncRemainingCount: Number(result.remainingCount || 0),
    syncRetryCount: Number(result.retryCount || 0),
    message: `边采边同步完成：成功 ${Number(result.successCount || 0)}，失败 ${Number(result.failedCount || 0)}，跳过 ${Number(result.skippedCount || 0)}${Number(result.retryCount || 0) > 0 ? `，瞬时重试 ${Number(result.retryCount || 0)}` : ""}`,
  };
  updateProgress?.(doneProgress);
  notifyProgress?.(doneProgress);

  if (result.blocked) {
    showMessage(
      `边采边同步未执行：${result.error?.message || "同步前检查失败"}`,
      "warning",
    );
  } else if (Number(result.failedCount || 0) > 0) {
    showMessage(
      `边采边同步部分失败：成功 ${Number(result.successCount || 0)}，失败 ${Number(result.failedCount || 0)}`,
      "warning",
    );
  }
  return {
    ...result,
    // This bit is set only by the awaited terminal drain path. A bare queue
    // snapshot, a missing result, or a progress payload with defaulted zeroes
    // must never be treated as proof that task-owned uploads are gone.
    drainCompleted: true,
  };
}

async function handleBatchKeywordCapture(options = {}) {
  const runOptions =
    options && typeof options === "object" && typeof options.preventDefault !== "function"
      ? options
      : {};
  const externalNotifyProgress =
    typeof runOptions.onProgress === "function" ? runOptions.onProgress : null;
  const externalCaptureTaskContext =
    runOptions.captureTaskContext &&
    typeof runOptions.captureTaskContext === "object"
      ? runOptions.captureTaskContext
      : null;
  const captureTaskLifecycleOwnedByCaller =
    runOptions.captureTaskLifecycleOwnedByCaller === true;
  const waitForegroundTabId = Number.isFinite(
    Number(runOptions.waitForegroundTabId),
  )
    ? Number(runOptions.waitForegroundTabId)
    : null;
  const preferredSourceTabId = Number.isFinite(
    Number(runOptions.sourceTabId),
  )
    ? Number(runOptions.sourceTabId)
    : null;
  const executionLockOwner =
    String(runOptions.executionLockOwner || "").trim() ||
    "manual_batch_keyword_capture";
  const executionLockLabel =
    String(runOptions.executionLockLabel || "").trim() ||
    "手动批量关键词采集";
  const captureExecutionLabel =
    String(runOptions.captureExecutionLabel || "").trim() ||
    (executionLockOwner === "unattended_keyword_plan"
      ? "无人值守采集"
      : "批量搜索采集");
  const executionMode =
    String(runOptions.executionMode || "").trim() === "one_time"
      ? "one_time"
      : executionLockOwner === "unattended_keyword_plan"
        ? "unattended_plan"
        : "manual";
  const releaseElasticItemOnLongRetry =
    runOptions.releaseElasticItemOnLongRetry === true;
  const disableAutomaticSearchRetry =
    runOptions.disableAutomaticSearchRetry === true;
  const requireVerifiedFilters =
    runOptions.requireVerifiedFilters === true;
  let bootstrapInitialSearchEvidence =
    runOptions.initialSearchEvidence &&
    typeof runOptions.initialSearchEvidence === "object" &&
    !Array.isArray(runOptions.initialSearchEvidence)
      ? runOptions.initialSearchEvidence
      : null;
  const sequentialSearchPasses = normalizeUnattendedSearchPasses({
    searchPasses: runOptions.searchPasses,
    searchFilters: runOptions.searchFilters,
  });
  const sequentialSearchEnabled = sequentialSearchPasses.length > 1;
  // Unattended identity belongs to this invocation, not to the mutable global
  // claim slot.  A delayed callback from a previous runner must never be
  // relabeled with the request/attempt that happens to be active later.
  const scopedUnattendedRequestId = String(
    runOptions.unattendedRequestId || "",
  ).trim();
  const scopedUnattendedAttemptId = String(
    runOptions.unattendedAttemptId || "",
  ).trim();
  const captureTaskItemAttempts = (Array.isArray(
    runOptions.captureTaskItemAttempts,
  )
    ? runOptions.captureTaskItemAttempts
    : [])
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry
        : {},
    )
    .filter(
      (entry) =>
        String(entry.attemptId || "").trim() &&
        String(entry.keyword || "").trim(),
    );
  const resolveCaptureTaskItemAttempt = (value = {}) => {
    const keyword = String(value?.keyword || "").trim();
    if (!keyword) return null;
    const matches = captureTaskItemAttempts.filter(
      (entry) => String(entry.keyword || "").trim() === keyword,
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const isCurrentUnattendedInvocation = () =>
    !scopedUnattendedRequestId ||
    (scopedUnattendedRequestId ===
      String(activeUnattendedRunRequestId || "").trim() &&
      (!scopedUnattendedAttemptId ||
        scopedUnattendedAttemptId ===
          String(activeUnattendedRunAttemptId || "").trim()));
  const shouldStopBatchInvocation = () =>
    batchKeywordCancelRequested || !isCurrentUnattendedInvocation();
  if (
    executionLockOwner === "unattended_keyword_plan" &&
    activeUnattendedAttemptRejected
  ) {
    return {started: false, canceled: true, reason: "当前执行已被新的恢复任务接管"};
  }

  if (batchKeywordCaptureInFlight) {
    if (batchKeywordCancelRequested) {
      showMessage("正在取消批量采集...", "warning");
      return {started: false, canceled: true, reason: "正在取消批量采集"};
    }
    batchKeywordCancelRequested = true;
    // 取消时若正在「采集增强」逐条補采(用 detailBatch 标志 + 独立 runner tab),也要一并停,
    // 否则在增强阶段点终止会继续補采、停不下来。
    if (detailBatchCaptureInFlight) {
      detailBatchCancelRequested = true;
    }
    const btnBatch = document.getElementById("btnRunBatchKeywords");
    if (btnBatch) {
      btnBatch.textContent = "停止中...";
    }
    try {
      if (detailBatchCaptureInFlight) {
        await requestDetailRunnerCancelSignals({
          extraTabIds: getCurrentRuntime()?.captureDebugSession?.workerTabIds,
          fallbackTabId: activeBatchRunnerTabId,
        });
      } else {
        await requestCaptureCancelSignal(activeBatchRunnerTabId);
      }
    } catch (error) {
      console.warn("[Sidebar] Batch keyword cancel failed:", error);
    }
    showMessage("正在取消批量采集...", "warning");
    return {started: false, canceled: true, reason: "正在取消批量采集"};
  }

  if (batchUrlCaptureInFlight) {
    showMessage("已有批量任务执行中，请先停止当前任务", "warning");
    return {started: false, reason: "已有批量任务执行中"};
  }

  const runtime = getCurrentRuntime();
  const selectedPlatform = getViewPlatform(runtime);
  const pagePlatform = getPagePlatform(runtime);
  const captureTaskDebugSupported =
    supportsPersistentCaptureTaskPlatform(pagePlatform);
  if (selectedPlatform !== pagePlatform) {
    const platformCopy = getPlatformCopy(selectedPlatform);
    showMessage(
      `当前数据视图是${platformCopy.label}，请切换到对应平台页面后再采集`,
      "error",
    );
    return {started: false, reason: "当前数据视图与页面平台不一致"};
  }
  if (runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS) {
    showMessage("请先切换到搜索页", "error");
    return {started: false, reason: "当前页面不是搜索结果页"};
  }
  if (!getPlatformCapabilities(pagePlatform).captureSearch) {
    showMessage("当前平台暂不支持搜索结果采集", "warning");
    return {started: false, reason: "当前平台暂不支持搜索结果采集"};
  }

  const rawKeywords = getBatchKeywordsFromTextarea();
  if (rawKeywords.length === 0) {
    showMessage("请输入至少一个关键词（每行一个）", "warning");
    return {started: false, reason: "未填写关键词"};
  }
  if (rawKeywords.length > MAX_BATCH_KEYWORDS) {
    showMessage(`单次最多批量采集 ${MAX_BATCH_KEYWORDS} 个关键词`, "warning");
    return {started: false, reason: `关键词超过 ${MAX_BATCH_KEYWORDS} 个`};
  }

  const keywords = dedupeKeywords(rawKeywords);
  updateBatchKeywordInputState();
  persistCurrentBatchDraft();

  let executionLock = null;
  let streamingSyncQueue = null;
  let streamingSyncResult = null;
  let streamingSyncDrained = false;
  let failureOutcome = null;
  let caughtError = null;
  let sidebarTaskContext = null;
  let captureTaskContext = null;
  let captureTaskContextNeedsCompletion = false;
  let captureTaskSessionStarted = Boolean(
    captureTaskDebugSupported &&
      externalCaptureTaskContext &&
      runOptions.captureTaskSessionStarted === true,
  );
  let captureTaskSessionOwnedHere = false;
  let persistentCaptureTaskId = "";
  let sidebarTaskStatus = "failed";
  let sidebarTaskError = null;
  let sidebarTaskMetadata = {
    platform: pagePlatform,
    keywordCount: keywords.length,
  };
  let captureTaskRoundTotal = 1;
  let captureTaskDisplayMeta = {
    keywordList: [...keywords],
    executionMode,
    searchFilters:
      runOptions.searchFilters && typeof runOptions.searchFilters === "object"
        ? {...runOptions.searchFilters}
        : {},
    enhancementEnabled: false,
    aiRelevancePrefilterEnabled: false,
    commentsEnabled: false,
    bloggerMetricsEnabled: false,
  };
  const notifyProgress = (progress = {}) => {
    if (!isCurrentUnattendedInvocation()) {
      return projectCaptureTaskProgress({
        ...progress,
        ...(persistentCaptureTaskId
          ? {captureTaskId: persistentCaptureTaskId}
          : {}),
        ...(scopedUnattendedRequestId
          ? {unattendedRequestId: scopedUnattendedRequestId}
          : {}),
        ...(scopedUnattendedAttemptId
          ? {unattendedAttemptId: scopedUnattendedAttemptId}
          : {}),
      });
    }
    const projectedProgress = rememberCaptureTaskProgressContext({
      ...progress,
      ...(persistentCaptureTaskId
        ? {captureTaskId: persistentCaptureTaskId}
        : {}),
      ...(scopedUnattendedRequestId
        ? {unattendedRequestId: scopedUnattendedRequestId}
        : {}),
      ...(scopedUnattendedAttemptId
        ? {unattendedAttemptId: scopedUnattendedAttemptId}
        : {}),
      roundTotal:
        readFiniteProgressNumber(progress?.roundTotal, captureTaskRoundTotal) ||
        captureTaskRoundTotal,
      taskMeta: {
        ...captureTaskDisplayMeta,
        ...(progress?.taskMeta &&
        typeof progress.taskMeta === "object" &&
        !Array.isArray(progress.taskMeta)
          ? progress.taskMeta
          : {}),
      },
    });
    if (captureTaskSessionStarted && persistentCaptureTaskId) {
      void updateCaptureTaskSession({
        taskId: persistentCaptureTaskId,
        progress: projectedProgress,
      });
    }
    externalNotifyProgress?.(projectedProgress);
    return projectedProgress;
  };
  const batchInvocationToken = Symbol("batch-keyword-capture");
  activeBatchKeywordInvocationToken = batchInvocationToken;
  try {
    const storedCaptureSettings = await getCaptureSettings();
    const taskCaptureSettings =
      runOptions.captureSettings &&
      typeof runOptions.captureSettings === "object" &&
      !Array.isArray(runOptions.captureSettings) &&
      Object.keys(runOptions.captureSettings).length > 0
        ? resolveTaskCaptureSettingsOverrides(
            storedCaptureSettings,
            runOptions.captureSettings,
          )
        : null;
    const settings = taskCaptureSettings ||
      resolveCurrentDetailCaptureSettings(storedCaptureSettings);
    streamingSyncQueue = createStreamingDetailAutoSyncQueue(settings, {
      shouldStop: shouldStopBatchInvocation,
      captureTaskId: scopedUnattendedRequestId,
      resolveCaptureTaskItemAttempt,
    });
    if (
      settings.autoDetailCaptureAfterListCapture &&
      !ensureAuthVerifiedOrWarn({
        message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
      })
    ) {
      return {started: false, reason: "采集增强需要先完成授权验证"};
    }
    executionLock = await acquireCaptureExecutionLock({
      owner: executionLockOwner,
      label: executionLockLabel,
    });
    if (!executionLock) {
      return {started: false, reason: "已有采集任务运行中"};
    }
    if (
      executionLockOwner === "unattended_keyword_plan" &&
      (activeUnattendedAttemptRejected || !isCurrentUnattendedInvocation())
    ) {
      return {started: false, canceled: true, reason: "当前执行已被新的恢复任务接管"};
    }
    if (executionLockOwner !== "unattended_keyword_plan") {
      sidebarTaskContext = beginSidebarTask({
        taskType: "capture",
        featureKey: "capture.keyword_batch",
        metadata: sidebarTaskMetadata,
      });
      captureTaskContext = sidebarTaskContext;
    } else if (externalCaptureTaskContext) {
      captureTaskContext = externalCaptureTaskContext;
    } else {
      captureTaskContext = beginTaskContext({
        taskType: "capture",
        featureKey: "capture.unattended_keyword",
        source: "unattended",
        metadata: sidebarTaskMetadata,
      });
      captureTaskContextNeedsCompletion = true;
    }

    const sortContext = await syncKeywordSortDimensionFromPage({
      force: true,
      fallbackDimension: keywordSortDimension,
    });
    const keywordMinLikes = readKeywordMinLikesFromInput(
      settings.keywordMinLikes,
    );
    const hasTaskKeywordMaxDetectedItems =
      runOptions.keywordMaxDetectedItems !== null &&
      runOptions.keywordMaxDetectedItems !== undefined &&
      runOptions.keywordMaxDetectedItems !== "";
    const keywordMaxDetectedItems = hasTaskKeywordMaxDetectedItems
      ? resolveTaskKeywordMaxDetectedItems(
          settings.keywordMaxDetectedItems,
          runOptions.keywordMaxDetectedItems,
        )
      : readKeywordMaxDetectedItemsFromInput(
          settings.keywordMaxDetectedItems,
        );
    captureTaskDisplayMeta.keywordMaxDetectedItems =
      keywordMaxDetectedItems;

    let baseSearchUrl = runtime?.lastPageUrl || "";
    try {
      let tab = null;
      if (preferredSourceTabId) {
        tab = await chrome.tabs.get(preferredSourceTabId);
      } else {
        [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
      }
      if (tab?.url) {
        baseSearchUrl = tab.url;
      }
      activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
    } catch (error) {
      if (preferredSourceTabId) {
        throw new Error(
          `指定的${captureExecutionLabel}页面不可用，已停止以免误采其它标签页：${String(
            error?.message || error || "页面不存在",
          )}`,
        );
      }
      // Manual capture can still resolve its current active tab below.
      activeBatchRunnerTabId = null;
    }

    const sourceTabId = captureTaskDebugSupported
      ? await resolveCaptureTaskSourceTabId({
          preferredTabId: activeBatchRunnerTabId,
          platform: pagePlatform,
        })
      : null;
    persistentCaptureTaskId = captureTaskDebugSupported
      ? String(captureTaskContext?.taskId || "").trim()
      : "";
    const ensurePersistentCaptureTaskSession = async () => {
      if (!captureTaskDebugSupported) return;
      if (captureTaskSessionStarted) return;
      await startRequiredCaptureTaskSession({
        taskId: persistentCaptureTaskId,
        tabId: sourceTabId,
        label:
          executionLockOwner === "unattended_keyword_plan"
            ? `${captureExecutionLabel} · ${keywords.length} 个关键词`
            : `批量搜索采集 · ${keywords.length} 个关键词`,
        platform: pagePlatform,
      });
      captureTaskSessionStarted = true;
      captureTaskSessionOwnedHere = true;
    };

    if (
      executionLockOwner === "unattended_keyword_plan" &&
      (!isCurrentUnattendedInvocation() ||
        activeCaptureTaskCancellationReason)
    ) {
      return {
        started: true,
        canceled: true,
        reason:
          activeCaptureTaskCancellationReason ||
          "unattended_attempt_replaced",
      };
    }
    batchKeywordCaptureInFlight = true;
    batchKeywordCancelRequested = false;

    const btnBatch = document.getElementById("btnRunBatchKeywords");
    if (btnBatch) {
      btnBatch.textContent = "取消批量采集";
      btnBatch.classList.remove("btn-primary");
      btnBatch.classList.add("btn-danger");
      btnBatch.disabled = false;
      btnBatch.classList.remove("is-disabled");
    }

    setBatchProgressVisible("modal", true);

    // 执行轮数:1 轮即普通采集,大于 1 才按轮次间隔继续跑。
    const roundGapMin = Math.max(0, Number(document.getElementById("inputLoopGapMin")?.value) || 0);
    const maxRounds = Math.max(1, Math.floor(Number(document.getElementById("inputLoopRounds")?.value)) || 1); // 留空/0 = 1 轮(不做无限,防风控)
    captureTaskRoundTotal = maxRounds;
    const autoLoop = maxRounds > 1;
    const roundGapMs = roundGapMin * 60 * 1000;
    // 采集排序 / 范围(默认值归一为空 → 不触发筛选点击);复用「找对标账号」的筛选点击能力
    // 无人值守直接用计划里已归一化的 searchFilters,绕开"设控件→回读"的回环
    // (避免重渲染扰动/平台专属字段被抹);手动批量不传该项 → 仍回读 modal 控件。
    const searchFilters =
      runOptions.searchFilters && typeof runOptions.searchFilters === "object"
        ? runOptions.searchFilters
        : collectSearchFiltersFromControls("modal");
    captureTaskDisplayMeta = {
      ...captureTaskDisplayMeta,
      searchFilters: {...(searchFilters || {})},
      ...(sequentialSearchEnabled
        ? {searchPasses: [...sequentialSearchPasses]}
        : {}),
      enhancementEnabled: Boolean(settings.autoDetailCaptureAfterListCapture),
      aiRelevancePrefilterEnabled: Boolean(
        settings.enableAiRelevancePrefilter,
      ),
      commentsEnabled: Boolean(settings.includeCommentsOnDetailCapture),
      bloggerMetricsEnabled: Boolean(
        settings.includeBloggerMetricsOnDetailCapture,
      ),
    };
    const resumeCheckpoint =
      runOptions.resumeCheckpoint &&
      typeof runOptions.resumeCheckpoint === "object"
        ? runOptions.resumeCheckpoint
        : null;
    const onKeywordSettled =
      typeof runOptions.onKeywordSettled === "function"
        ? runOptions.onKeywordSettled
        : null;
    const maxKeywordAttempts = Math.max(
      1,
      Math.min(4, Number(runOptions.maxKeywordAttempts) || 1),
    );

    let result;
    const resumeRound = resumeCheckpoint
      ? Math.min(maxRounds, Math.max(1, Number(resumeCheckpoint.round) || 1))
      : 1;
    let round = resumeRound - 1;
    const previousKeywordResults = Array.isArray(resumeCheckpoint?.keywordResults)
      ? resumeCheckpoint.keywordResults
      : [];
    let totalSuccess = previousKeywordResults.filter(
      (entry) =>
        Math.max(1, Number(entry?.round) || 1) < resumeRound &&
        String(entry?.status || "") === "completed",
    ).length;
    let totalFailed = previousKeywordResults.filter(
      (entry) =>
        Math.max(1, Number(entry?.round) || 1) < resumeRound &&
        String(entry?.status || "") === "failed",
    ).length;

    // 定时启动:指定了开始时刻则等到那一刻再开跑(可中断),等待期间显示倒计时
    const scheduledStartStr = document.getElementById("inputBatchScheduledStart")?.value || "";
    if (scheduledStartStr) {
      const targetMs = new Date(scheduledStartStr).getTime();
      if (Number.isFinite(targetMs) && targetMs > Date.now()) {
        const targetLabel = new Date(scheduledStartStr).toLocaleString("zh-CN");
        setBatchProgressVisible("modal", true);
        let lastShownSec = -1;
        await sleepWithStop(targetMs - Date.now(), () => {
          if (shouldStopBatchInvocation()) return true;
          const remainSec = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
          if (remainSec !== lastShownSec) {
            lastShownSec = remainSec;
            const h = Math.floor(remainSec / 3600);
            const m = Math.floor((remainSec % 3600) / 60);
            const s = remainSec % 60;
            updateBatchProgress(
              {
                current: 0,
                total: keywords.length,
                keywordCurrent: 0,
                keywordTotal: keywords.length,
                nextKeyword: keywords[0] || "",
                progressScope: "wait",
                roundCurrent: 1,
                roundTotal: maxRounds,
                phase: "scheduled-waiting",
                remainingMs: Math.max(0, targetMs - Date.now()),
                message: `⏰ 定时采集:将于 ${targetLabel} 开始(还剩 ${h > 0 ? h + "时" : ""}${m}分${s}秒)`,
              },
              "modal",
            );
            notifyProgress?.({
              current: 0,
              total: keywords.length,
              keywordCurrent: 0,
              keywordTotal: keywords.length,
              nextKeyword: keywords[0] || "",
              progressScope: "wait",
              roundCurrent: 1,
              roundTotal: maxRounds,
              phase: "scheduled-waiting",
              remainingMs: Math.max(0, targetMs - Date.now()),
              message: `定时采集:将于 ${targetLabel} 开始(还剩 ${h > 0 ? h + "时" : ""}${m}分${s}秒)`,
            });
          }
          return false;
        });
        if (shouldStopBatchInvocation()) {
          showMessage("已取消定时采集", "warning");
          return {started: true, canceled: true, reason: "已取消定时采集"}; // finally 会复位状态/按钮
        }
      }
    }

    await ensurePersistentCaptureTaskSession();

    do {
      round += 1;
      const activeSearchPass = sequentialSearchEnabled
        ? sequentialSearchPasses[Math.min(round - 1, sequentialSearchPasses.length - 1)]
        : "";
      const activeSearchPassLabel = unattendedSearchPassLabel(activeSearchPass);
      const roundSearchFilters = activeSearchPass
        ? {...searchFilters, contentType: activeSearchPass}
        : searchFilters;
      if (activeSearchPass) {
        captureTaskDisplayMeta = {
          ...captureTaskDisplayMeta,
          searchFilters: {...roundSearchFilters},
          searchPassCurrent: round,
          searchPassTotal: sequentialSearchPasses.length,
          searchPassLabel: activeSearchPassLabel,
        };
      }
      const completedBeforeRun = resolveCompletedCheckpointKeywords(
        resumeCheckpoint,
        round,
      );
      const exhaustedBeforeRun = previousKeywordResults.filter(
        (entry) =>
          Math.max(1, Number(entry?.round) || 1) === round &&
          String(entry?.status || "") === "failed" &&
          Math.max(0, Number(entry?.attemptCount) || 0) >= maxKeywordAttempts,
      );
      const exhaustedKeywords = new Set(
        exhaustedBeforeRun.map((entry) => String(entry?.keyword || "").trim()),
      );
      let pendingKeywords = keywords.filter(
        (keyword) =>
          !completedBeforeRun.has(keyword) && !exhaustedKeywords.has(keyword),
      );
      let keywordAttempt = 1;
      const baseBatchOptions = {
        keywords: [...pendingKeywords],
        platform: pagePlatform,
        baseSearchUrl,
        sourceTabId: activeBatchRunnerTabId,
        captureTaskId: persistentCaptureTaskId,
        searchFilters: roundSearchFilters,
        disableAutomaticSearchRetry,
        requireVerifiedFilters,
        captureParams: {
          minLikes: keywordMinLikes,
          sortDimension: sortContext.dimension,
          maxDetectedItems: keywordMaxDetectedItems,
          waitMinMs: settings.sharedWaitMinMs,
          waitMaxMs: settings.sharedWaitMaxMs,
          stallTimeoutMs: settings.sharedStallTimeoutMs,
          maxDurationMs: settings.sharedMaxDurationMs,
        },
        waitForegroundTabId,
        onKeywordSettled: onKeywordSettled
          ? async (settled = {}) => {
              if (!isCurrentUnattendedInvocation()) {
                return;
              }
              const originalIndex = Math.max(
                0,
                keywords.indexOf(String(settled.keyword || "").trim()),
              );
              await onKeywordSettled({
                ...settled,
                current: originalIndex + 1,
                total: keywords.length,
                originalIndex,
                round,
                attempt: keywordAttempt,
                maxAttempts: maxKeywordAttempts,
              });
            }
          : null,
        afterKeywordCapture: settings.autoDetailCaptureAfterListCapture
          ? async ({
              keyword: capturedKeyword,
              recordIds,
              runnerTabId,
            }) => {
              streamingSyncQueue?.registerCaptured?.(recordIds);
              if (!isCurrentUnattendedInvocation()) {
                return {
                  ok: false,
                  canceled: true,
                  reason: "unattended_attempt_replaced",
                };
              }
              const keywordPlanIndex = keywords.indexOf(
                String(capturedKeyword || "").trim(),
              );
              const keywordPlanProgress =
                keywordPlanIndex >= 0
                  ? {
                      keywordCurrent: keywordPlanIndex + 1,
                      keywordTotal: keywords.length,
                      nextKeyword: keywords[keywordPlanIndex + 1] || "",
                    }
                  : {};
              rememberCaptureTaskProgressContext({
                phase: "detail_preparing",
                progressScope: "detail_item",
                keyword: capturedKeyword,
                ...keywordPlanProgress,
                round,
                roundCurrent: round,
                roundTotal: maxRounds,
                attempt: keywordAttempt,
                attemptCurrent: keywordAttempt,
                attemptTotal: maxKeywordAttempts,
                taskMeta: captureTaskDisplayMeta,
              });
              await refreshDataPool();
              const enhanceResult =
                await maybeRunAutoDetailCaptureAfterListCapture(
                  settings,
                  {
                    sourceLabel: `关键词「${capturedKeyword}」搜索结果`,
                    recordIds,
                    relevanceKeyword: capturedKeyword,
                    waitForegroundTabId,
                    captureTaskId: persistentCaptureTaskId,
                    unattendedRequestId: scopedUnattendedRequestId,
                    unattendedAttemptId: scopedUnattendedAttemptId,
                    onItemSettled: streamingSyncQueue?.enabled
                      ? (progress) =>
                          routeDetailItemToStreamingSync(
                            streamingSyncQueue,
                            progress,
                            {
                              sourceLabel: `关键词「${capturedKeyword}」笔记`,
                              keyword: capturedKeyword,
                            },
                          )
                      : null,
                    onProgress: notifyProgress
                      ? (detailProgress = {}) =>
                          notifyProgress({
                            ...detailProgress,
                            keyword: capturedKeyword,
                            ...keywordPlanProgress,
                            itemCurrent: readFiniteProgressNumber(
                              detailProgress.itemCurrent,
                              detailProgress.current,
                            ),
                            itemTotal: readFiniteProgressNumber(
                              detailProgress.itemTotal,
                              detailProgress.total,
                            ),
                            progressScope: "detail_item",
                            round,
                            roundCurrent: round,
                            roundTotal: maxRounds,
                            attempt: keywordAttempt,
                            attemptCurrent: keywordAttempt,
                            attemptTotal: maxKeywordAttempts,
                            phase: detailProgress.phase || "enhancing",
                            message:
                              detailProgress.message ||
                              `正在增强关键词「${capturedKeyword}」的采集结果`,
                            runnerTabId:
                              detailProgress.runnerTabId || runnerTabId || null,
                          })
                      : null,
                  },
                );
              if (enhanceResult?.securityBlocked) {
                batchKeywordCancelRequested = true;
                showMessage(
                  "⚠️ 触发小红书安全限制(访问频繁),已停止无人值守。建议隔较长时间(数小时)再跑。",
                  "warning",
                );
                return {...enhanceResult, canceled: true};
              }
              const resultInterruption = resolveUnattendedEnhanceCancellation(
                enhanceResult,
              );
              if (resultInterruption.stopBatch) {
                batchKeywordCancelRequested = true;
                if (enhanceResult?.integrityBlocked === true) {
                  showMessage(
                    "⚠️ 无法确认当前抖音作品身份，已停止无人值守，且未同步未验证数据。",
                    "warning",
                  );
                }
                return {
                  ...enhanceResult,
                  fatal: enhanceResult?.fatal === true,
                  stopBatch: true,
                  cancellationReason:
                    resultInterruption.reason ||
                    (enhanceResult?.integrityBlocked
                      ? "fatal_douyin_identity_mismatch"
                      : "fatal_detail_capture"),
                };
              }
              if (enhanceResult?.canceled || resultInterruption.recoverable) {
                const interruptionReason = activeUnattendedAttemptRejected
                  ? "fatal_attempt_replaced"
                  : activeUnattendedRunRequestId &&
                      !activeCaptureExecutionLockId
                    ? "fatal_capture_lock_lost"
                    : activeCaptureTaskCancellationReason;
                const cancellation = resolveUnattendedEnhanceCancellation(
                  enhanceResult,
                  interruptionReason,
                );
                if (cancellation.stopBatch) {
                  batchKeywordCancelRequested = true;
                  return {
                    ...enhanceResult,
                    cancellationReason: cancellation.reason,
                  };
                }
                // Debug/侧栏工作页的临时断开只影响当前关键词的增强结果。
                // 把它保存为 partial，交给检查点恢复；不能让 shouldStop
                // 把后续所有关键词误判成“用户取消”。
                batchKeywordCancelRequested = false;
                if (
                  resolveUnattendedEnhanceCancellation(
                    {},
                    activeCaptureTaskCancellationReason,
                  ).recoverable
                ) {
                  activeCaptureTaskCancellationReason = "";
                }
                return {
                  ...enhanceResult,
                  ok: false,
                  canceled: false,
                  partial: true,
                  recoverable: true,
                  cancellationReason:
                    cancellation.reason || "detail_capture_interrupted",
                  reason:
                    enhanceResult.reason ||
                    cancellation.reason ||
                    "detail_capture_interrupted",
                };
              }
              if (streamingSyncQueue?.enabled) {
                streamingSyncQueue.enqueueMissing(recordIds, {
                  sourceLabel: `关键词「${capturedKeyword}」笔记`,
                  keyword: capturedKeyword,
                });
              }
              if (!streamingSyncQueue?.enabled) {
                const captureAttempt = resolveCaptureTaskItemAttempt({
                  keyword: capturedKeyword,
                });
                await maybeRunAutoSyncAfterDetailCapture(settings, {
                  sourceLabel: `关键词「${capturedKeyword}」搜索结果`,
                  recordIds,
                  shouldStop: shouldStopBatchInvocation,
                  captureTaskId: scopedUnattendedRequestId,
                  captureTaskItemAttemptId: String(
                    captureAttempt?.attemptId || "",
                  ).trim(),
                  captureTaskItemRequestHash: String(
                    captureAttempt?.requestHash || "",
                  ).trim(),
                });
              }
              return enhanceResult;
            }
          : null,
        onProgress: (progress) => {
          if (!isCurrentUnattendedInvocation()) {
            return;
          }
          // 进入「导航 / 切筛选 / 等待」阶段时清掉上一条采集明细,等本条列表采集再刷新
          if (progress.phase && progress.phase !== "capturing") {
            setBatchProgressDetail("");
          }
          const progressKeyword = String(progress?.keyword || "").trim();
          const originalIndex = progressKeyword
            ? keywords.indexOf(progressKeyword)
            : -1;
          const normalizedProgress = {
            ...progress,
            current: originalIndex >= 0 ? originalIndex + 1 : progress.current,
            total: keywords.length,
            keywordCurrent:
              originalIndex >= 0 ? originalIndex + 1 : progress.current,
            keywordTotal: keywords.length,
            itemCurrent: null,
            itemTotal: null,
            nextKeyword:
              originalIndex >= 0 ? keywords[originalIndex + 1] || "" : "",
            progressScope: "keyword",
            roundCurrent: round,
            roundTotal: maxRounds,
            attempt: keywordAttempt,
            attemptCurrent: keywordAttempt,
            attemptTotal: maxKeywordAttempts,
            maxAttempts: maxKeywordAttempts,
          };
          const progressForUi = autoLoop
            ? {
                ...normalizedProgress,
                round,
                message: sequentialSearchEnabled
                  ? `${activeSearchPassLabel} · ${progress.message || ""}`
                  : `第 ${round} 轮 · ${progress.message || ""}`,
              }
            : { ...normalizedProgress, round };
          if (sequentialSearchEnabled) {
            progressForUi.searchPass = activeSearchPass;
            progressForUi.searchPassCurrent = round;
            progressForUi.searchPassTotal = sequentialSearchPasses.length;
            progressForUi.searchPassLabel = activeSearchPassLabel;
          }
          progressForUi.message = appendStreamingSyncSummary(
            progressForUi.message,
            streamingSyncQueue,
          );
          updateBatchProgress(
            progressForUi,
            "modal",
          );
          notifyProgress?.(progressForUi);
        },
        shouldStop: shouldStopBatchInvocation,
      };

      let mergedAttemptResult = {
        ok: exhaustedBeforeRun.length === 0,
        canceled: false,
        securityBlocked: false,
        results: exhaustedBeforeRun.map((entry) => ({
          keyword: String(entry?.keyword || ""),
          ok: false,
          error: String(entry?.error || "已达自动重试上限"),
          retryExhausted: true,
        })),
        stats: {
          total: keywords.length,
          processed: completedBeforeRun.size + exhaustedBeforeRun.length,
          success: completedBeforeRun.size,
          failed: exhaustedBeforeRun.length,
        },
      };

      const attemptRun = await runUnattendedKeywordAttempts({
        allKeywords: keywords,
        initialPendingKeywords: pendingKeywords,
        initialResult: mergedAttemptResult,
        completedBeforeRun,
        maxAttempts: maxKeywordAttempts,
        runAttempt: async ({keywords: attemptKeywords, attempt}) => {
          keywordAttempt = attempt;
          const attemptInitialSearchEvidence =
            attempt === 1 ? bootstrapInitialSearchEvidence : null;
          // A bootstrap navigation proves exactly one search operation. Never
          // let a later local retry or search pass reuse that old page proof.
          bootstrapInitialSearchEvidence = null;
          const attemptResult = await batchCaptureByKeywords({
            ...baseBatchOptions,
            keywords: attemptKeywords,
            initialSearchEvidence: attemptInitialSearchEvidence,
          });
          return attemptResult;
        },
        selectRetryKeywords: ({keywords: failedKeywords}) => {
          if (!resumeCheckpoint || !onKeywordSettled) {
            return failedKeywords;
          }
          return failedKeywords.filter((keyword) => {
            const checkpointEntry = (Array.isArray(resumeCheckpoint.keywordResults)
              ? resumeCheckpoint.keywordResults
              : []
            ).find(
              (entry) =>
                Math.max(1, Number(entry?.round) || 1) === round &&
                String(entry?.keyword || "").trim() === keyword,
            );
            return (
              !checkpointEntry ||
              Math.max(0, Number(checkpointEntry.attemptCount) || 0) <
                maxKeywordAttempts
            );
          });
        },
        onRetryScheduled: async ({keywords: failedKeywords, attempt}) => {
          keywordAttempt = attempt;
          const retryDelay = Math.max(
            0,
            Number(
              UNATTENDED_KEYWORD_RETRY_DELAYS_MS[
                Math.max(0, Number(attempt) - 2)
              ] ?? UNATTENDED_KEYWORD_RETRY_DELAYS_MS.at(-1),
            ) || 0,
          );
          const waitUntil = new Date(Date.now() + retryDelay).toISOString();
          const releaseElasticItem = Boolean(
            releaseElasticItemOnLongRetry &&
              failedKeywords.length > 0 &&
              retryDelay >= UNATTENDED_ELASTIC_RELEASE_MIN_DELAY_MS,
          );
          const retryProgress = {
            current: 0,
            total: keywords.length,
            keywordCurrent: 0,
            keywordTotal: keywords.length,
            nextKeyword: failedKeywords[0] || "",
            progressScope: "wait",
            round,
            roundCurrent: round,
            roundTotal: maxRounds,
            attempt,
            attemptCurrent: attempt,
            attemptTotal: maxKeywordAttempts,
            maxAttempts: maxKeywordAttempts,
            phase: releaseElasticItem
              ? "releasing_elastic_keyword"
              : "keyword_retry_wait",
            remainingMs: retryDelay,
            waitUntil,
            updatedAt: new Date().toISOString(),
            message: releaseElasticItem
              ? `关键词「${failedKeywords[0]}」已解除当前 Agent 锁定，正在交回云端；当前 Agent 进入 ${Math.ceil(retryDelay / 1000)} 秒冷却`
              : `${Math.ceil(retryDelay / 1000)} 秒后自动重试 ${failedKeywords.length} 个失败关键词（第 ${attempt}/${maxKeywordAttempts} 次）`,
          };
          updateBatchProgress(retryProgress, "modal");
          notifyProgress?.(retryProgress);
          if (releaseElasticItem) {
            const releaseError = new Error(retryProgress.message);
            releaseError.code = "UNATTENDED_ELASTIC_ITEM_RELEASED";
            releaseError.keyword = failedKeywords[0] || "";
            releaseError.retryAfterMs = retryDelay;
            releaseError.retryAt = waitUntil;
            releaseError.itemLockReleased = true;
            releaseError.requiresManualAction = false;
            releaseError.retryable = true;
            throw releaseError;
          }
          await sleepWithStop(retryDelay, shouldStopBatchInvocation);
        },
        shouldStop: shouldStopBatchInvocation,
      });
      mergedAttemptResult = attemptRun.result;
      pendingKeywords = attemptRun.pendingKeywords;

      result = mergedAttemptResult;

      await refreshDataPool();
      totalSuccess += result.stats.success;
      totalFailed += result.stats.failed;

      // 终止:被取消 / 没开循环 / 已到指定轮数
      if (
        shouldStopBatchInvocation() ||
        result.canceled ||
        result.fatal ||
        result.recoveryRequired ||
        !autoLoop ||
        round >= maxRounds
      ) {
        break;
      }

      // 进入等待前先把检查点推进到下一轮。这样在间隔中休眠、断网或关页后，
      // 恢复会直接从下一轮首词继续，不会重放已经完成的轮次或再等一整段间隔。
      if (resumeCheckpoint) {
        Object.assign(
          resumeCheckpoint,
          advanceUnattendedCheckpointRound({
            checkpoint: resumeCheckpoint,
            keywords,
            completedRound: round,
            maxRounds,
          }),
        );
      }

      // 轮次间隔:歇 roundGapMin 分钟再跑下一轮(睡眠中可中断)
      if (roundGapMs > 0) {
        const waitUntil = new Date(Date.now() + roundGapMs).toISOString();
        const buildWaitProgress = (remainingMs) => ({
          current: 0,
          total: keywords.length,
          keywordCurrent: keywords.length,
          keywordTotal: keywords.length,
          nextKeyword: keywords[0] || "",
          progressScope: "wait",
          phase: "waiting_next_round",
          remainingMs,
          message: `第 ${round} 轮完成（累计成功 ${totalSuccess}），约 ${Math.max(1, Math.ceil(remainingMs / 60000))} 分钟后开始第 ${round + 1} 轮…`,
          round,
          roundCurrent: round,
          roundTotal: maxRounds,
        });
        const waitProgress = buildWaitProgress(roundGapMs);
        updateBatchProgress(waitProgress, "modal");
        notifyProgress?.(waitProgress);
        if (typeof onKeywordSettled?.persist === "function") {
          await onKeywordSettled.persist({
            message: waitProgress.message,
            waitUntil,
          });
        }
        await sleepWithStop(
          roundGapMs,
          shouldStopBatchInvocation,
          {
            onTick: (remainingMs) => {
              const progress = buildWaitProgress(remainingMs);
              updateBatchProgress(progress, "modal");
              notifyProgress?.(progress);
            },
          },
        );
        if (!shouldStopBatchInvocation()) {
          const nextRoundProgress = {
            current: 0,
            total: keywords.length,
            keywordCurrent: 0,
            keywordTotal: keywords.length,
            nextKeyword: keywords[0] || "",
            progressScope: "wait",
            phase: "starting_next_round",
            message: `第 ${round + 1} 轮准备开始`,
            round: round + 1,
            roundCurrent: round + 1,
            roundTotal: maxRounds,
          };
          updateBatchProgress(nextRoundProgress, "modal");
          notifyProgress?.(nextRoundProgress);
        }
        if (
          !shouldStopBatchInvocation() &&
          typeof onKeywordSettled?.persist === "function"
        ) {
          await onKeywordSettled.persist({
            message: `第 ${round + 1} 轮准备开始`,
            waitUntil: "",
          });
        }
      } else if (typeof onKeywordSettled?.persist === "function") {
        await onKeywordSettled.persist({
          message: `第 ${round + 1} 轮准备开始`,
          waitUntil: "",
        });
      }
    } while (!shouldStopBatchInvocation());

    streamingSyncResult = await drainStreamingDetailSyncQueue(
      streamingSyncQueue,
      {
        round,
        updateProgress: (progress) => updateBatchProgress(progress, "modal"),
        notifyProgress,
      },
    );
    streamingSyncDrained = true;

    const stats = result.stats;
    const syncSummary = formatStreamingSyncSummary(streamingSyncResult);
    const streamingSyncTaskIssue = buildStreamingSyncTaskIssue(
      streamingSyncResult,
    );
    if (result?.securityBlocked) {
      showMessage(
        result?.blockingError?.message ||
          "检测到平台异常，已立即停止整批任务，请人工确认后再继续",
        "warning",
      );
    } else if (autoLoop) {
      const stopped = result.canceled || batchKeywordCancelRequested;
      showMessage(
        sequentialSearchEnabled
          ? `无人值守采集${stopped ? "已停止" : "结束"}：已执行 ${round}/${sequentialSearchPasses.length} 个巡检步骤，累计成功 ${totalSuccess}，失败 ${totalFailed}${syncSummary ? `；${syncSummary}` : ""}`
          : `无人值守采集${stopped ? "已停止" : "结束"}：共跑 ${round} 轮，累计成功 ${totalSuccess}，失败 ${totalFailed}${syncSummary ? `；${syncSummary}` : ""}`,
        stopped ? "warning" : "success",
      );
    } else if (result.canceled) {
      showMessage(
        `批量采集已停止：已处理 ${stats.processed}/${stats.total} 个关键词，成功 ${stats.success}，失败 ${stats.failed}${syncSummary ? `；${syncSummary}` : ""}`,
        "warning",
      );
    } else {
      showMessage(
        `批量采集完成：共 ${stats.total} 个关键词，成功 ${stats.success}，失败 ${stats.failed}${syncSummary ? `；${syncSummary}` : ""}`,
        stats.failed > 0 ? "warning" : "success",
      );
    }
    sidebarTaskStatus = result?.securityBlocked
      ? "needs_action"
      : result?.canceled || batchKeywordCancelRequested
        ? "canceled"
        : totalFailed > 0 || streamingSyncTaskIssue
          ? "completed_with_failures"
          : "completed";
    if (
      result?.securityBlocked &&
      result?.blockingError &&
      typeof result.blockingError === "object"
    ) {
      sidebarTaskError = {...result.blockingError};
    }
    if (streamingSyncTaskIssue && !sidebarTaskError) {
      sidebarTaskError = streamingSyncTaskIssue;
    }
    sidebarTaskMetadata = {
      ...sidebarTaskMetadata,
      rounds: round,
      successCount: totalSuccess,
      failedCount: totalFailed,
      ...buildStreamingSyncTaskMetadata(streamingSyncResult),
    };
    return {
      started: true,
      ok:
        !result?.canceled &&
        !result?.securityBlocked &&
        totalFailed === 0 &&
        !streamingSyncTaskIssue,
      canceled: Boolean(result?.canceled || batchKeywordCancelRequested),
      securityBlocked: Boolean(result?.securityBlocked),
      requiresManualAction: Boolean(result?.requiresManualAction),
      fatal: Boolean(result?.fatal),
      blockingError:
        result?.blockingError &&
        typeof result.blockingError === "object"
          ? {...result.blockingError}
          : null,
      result,
      rounds: round,
      totalSuccess,
      totalFailed,
      streamingSync: streamingSyncResult,
    };
  } catch (error) {
    console.error("[Sidebar] Batch keyword capture failed:", error);
    sidebarTaskStatus = "failed";
    sidebarTaskError = error;
    caughtError = error;
    if (error?.code === "UNATTENDED_ELASTIC_ITEM_RELEASED") {
      throw error;
    }
    showMessage("批量采集失败: " + error.message, "error");
    failureOutcome = {
      started: true,
      ok: false,
      error: error.message,
    };
    return failureOutcome;
  } finally {
    const ownsBatchInvocation = () =>
      activeBatchKeywordInvocationToken === batchInvocationToken;
    const ownsCurrentBatchInvocation = () =>
      ownsBatchInvocation() && isCurrentUnattendedInvocation();
    if (
      ownsCurrentBatchInvocation() &&
      streamingSyncQueue &&
      !streamingSyncDrained
    ) {
      streamingSyncResult = await drainStreamingDetailSyncQueue(
        streamingSyncQueue,
        {notifyProgress},
      ).catch((error) => {
        console.warn("[Sidebar] Drain streaming sync after batch failed:", error);
        return streamingSyncQueue.getStats();
      });
      streamingSyncDrained = true;
    }
    // The terminal drain happens in finally so every exceptional exit uses the
    // same queue. Preserve that result on the already-returned object/error;
    // otherwise the outer unattended runner cannot prove the source attempt is
    // locally closed and a safe relay waits forever.
    if (streamingSyncResult) {
      if (failureOutcome) {
        failureOutcome.streamingSync = streamingSyncResult;
      }
      if (caughtError && typeof caughtError === "object") {
        caughtError.streamingSync = streamingSyncResult;
      }
    }
    const shouldEndCaptureTaskSession =
      ownsCurrentBatchInvocation() &&
      captureTaskSessionStarted &&
      !captureTaskLifecycleOwnedByCaller &&
      (captureTaskSessionOwnedHere || !externalCaptureTaskContext);
    if (shouldEndCaptureTaskSession) {
      const terminal = resolveCaptureTaskTerminalStatus({
        taskStatus: sidebarTaskStatus,
        error: sidebarTaskError,
        canceled:
          batchKeywordCancelRequested || sidebarTaskStatus === "canceled",
      });
      const captureTaskEnd = await endCaptureTaskSession({
        taskId: persistentCaptureTaskId,
        ...terminal,
      });
      const captureTaskEnded =
        captureTaskEnd?.ok === true ||
        captureTaskEnd?.reason === "capture_task_not_found" ||
        captureTaskEnd?.response?.error?.code === "capture_task_not_found";
      if (captureTaskEnded) {
        releaseCaptureTaskOwner(persistentCaptureTaskId);
      }
    }
    if (ownsCurrentBatchInvocation() && sidebarTaskContext) {
      finishSidebarTask(sidebarTaskContext, {
        status: sidebarTaskStatus,
        error: sidebarTaskError,
        metadata: sidebarTaskMetadata,
      });
    } else if (
      ownsCurrentBatchInvocation() &&
      captureTaskContextNeedsCompletion &&
      captureTaskContext
    ) {
      completeTaskContext({
        taskType: captureTaskContext.taskType,
        featureKey: captureTaskContext.featureKey,
      });
    }
    if (ownsCurrentBatchInvocation()) {
      clearCaptureTaskProgressContext();
      if (executionLock) {
        await releaseCaptureExecutionLock(executionLock.id);
      }
    }
    if (ownsCurrentBatchInvocation()) {
      setBatchProgressDetail("");

      const btnBatch = document.getElementById("btnRunBatchKeywords");
      if (btnBatch) {
        btnBatch.textContent = "开始批量采集";
        btnBatch.classList.add("btn-primary");
        btnBatch.classList.remove("btn-danger");
      }
      updateBatchKeywordInputState();
    }
    if (ownsBatchInvocation()) {
      batchKeywordCaptureInFlight = false;
      batchKeywordCancelRequested = false;
      activeBatchRunnerTabId = null;
      activeBatchKeywordInvocationToken = null;
    }
  }
}

function activateUnattendedRunRequest(request = {}) {
  const nextRequestId = String(request?.id || "").trim();
  const nextAttemptId = String(request?.attemptId || "").trim();
  const preserveClaimRaceCancellation = Boolean(
    nextRequestId &&
      nextAttemptId &&
      pendingUnattendedCancellationRequestId === nextRequestId &&
      pendingUnattendedCancellationAttemptId === nextAttemptId,
  );
  // A recovered request reuses this long-lived sidebar document. Clear only
  // the previous attempt's local stop state synchronously, before the first
  // await (including a protected round-gap wait). Any cancellation delivered
  // after activation therefore belongs to the new attempt and must survive.
  if (!preserveClaimRaceCancellation) {
    activeCaptureTaskCancellationReason = "";
    batchKeywordCancelRequested = false;
    detailBatchCancelRequested = false;
    searchCaptureCancelRequested = false;
  }
  activeUnattendedRunRequestId = nextRequestId;
  activeUnattendedRunAttemptId = nextAttemptId;
  pendingUnattendedCancellationRequestId = "";
  pendingUnattendedCancellationAttemptId = "";
  activeUnattendedTerminalProgressKey = "";
  activeUnattendedProgressSeq = Math.max(0, Number(request?.progressSeq) || 0);
  activeUnattendedAttemptRejected = false;
  lastUnattendedContentProgressAt = 0;
  lastUnattendedContentProgressFingerprint = "";
}

function clearActiveUnattendedRunRequest(requestId = "", attemptId = "") {
  if (
    requestId &&
    activeUnattendedRunRequestId &&
    activeUnattendedRunRequestId !== requestId
  ) {
    return;
  }
  if (
    attemptId &&
    activeUnattendedRunAttemptId &&
    activeUnattendedRunAttemptId !== attemptId
  ) {
    return;
  }
  activeUnattendedRunRequestId = "";
  activeUnattendedRunAttemptId = "";
  // Keep the terminal fence after local cleanup. Detail/comment workers can
  // emit late events after the root request has already settled. A new root
  // run clears this fence in activateUnattendedRunRequest().
  activeUnattendedProgressSeq = 0;
  activeUnattendedAttemptRejected = false;
  lastUnattendedContentProgressAt = 0;
  lastUnattendedContentProgressFingerprint = "";
}

function stopRejectedUnattendedAttempt(reason = "attempt_mismatch") {
  if (activeUnattendedAttemptRejected) {
    return;
  }
  activeUnattendedAttemptRejected = true;
  batchKeywordCancelRequested = true;
  detailBatchCancelRequested = true;
  // attempt 已由 background 换代时，只停止旧侧栏本地编排。后台会在启动新 attempt
  // 前按旧 runner 精确取消；这里若再发不带 captureRequestId 的全页取消，迟到回包
  // 可能误伤复用同一平台标签页的新 attempt。
  console.warn("[Sidebar] Stopping stale unattended attempt:", reason);
}

async function reportUnattendedKeywordRun(
  requestId,
  patch = {},
  {
    attemptId = activeUnattendedRunAttemptId,
    quiet = false,
    durableCheckpoint = false,
  } = {},
) {
  if (!requestId) {
    return {ok: false, accepted: false, reason: "missing_request_id", data: null};
  }
  try {
    const response = await sendUnattendedRuntimeMessage({
      type: "onstarvoice:update-unattended-keyword-run",
      requestId,
      attemptId: String(attemptId || ""),
      patch,
    });
    const hasExplicitAcceptance = typeof response?.accepted === "boolean";
    const accepted = response?.accepted === true && response?.ok !== false;
    const reason = String(
      response?.reason || (hasExplicitAcceptance ? "" : "transport_error"),
    );
    if (
      !accepted &&
      (reason === "attempt_mismatch" || reason === "terminal")
    ) {
      stopRejectedUnattendedAttempt(reason);
    }
    if (
      !accepted &&
      ["attempt_mismatch", "not_found", "terminal"].includes(reason)
    ) {
      await discardUnattendedCheckpointReports({requestId, attemptId});
    }
    if (!accepted && !hasExplicitAcceptance && durableCheckpoint) {
      const queued = await enqueueUnattendedCheckpointReport({
        requestId,
        attemptId,
        patch,
      });
      if (queued.ok) {
        return {
          ok: true,
          accepted: true,
          reason: "queued_durable",
          data: null,
          durable: true,
        };
      }
    }
    // Do not delete a queued checkpoint merely because this direct report was
    // accepted: a newer report for the same attempt may have been queued while
    // this message was in flight. Flush below preserves revision fencing, and
    // the task ledger rejects an older replay as stale_progress.
    if (accepted) {
      void flushPendingUnattendedCheckpointReports({quiet: true});
    }
    return {
      ok: hasExplicitAcceptance && response?.ok !== false,
      accepted,
      reason,
      data: response?.data || null,
    };
  } catch (error) {
    if (durableCheckpoint) {
      const queued = await enqueueUnattendedCheckpointReport({
        requestId,
        attemptId,
        patch,
      });
      if (queued.ok) {
        return {
          ok: true,
          accepted: true,
          reason: "queued_durable",
          data: null,
          durable: true,
        };
      }
    }
    if (!quiet) {
      console.warn("[Sidebar] Update unattended keyword run failed:", error);
    }
    return {
      ok: false,
      accepted: false,
      reason: "transport_error",
      data: null,
      error,
    };
  }
}

let unattendedCheckpointOutboxFlushPromise = null;

function flushPendingUnattendedCheckpointReports({quiet = false} = {}) {
  if (unattendedCheckpointOutboxFlushPromise) {
    return unattendedCheckpointOutboxFlushPromise;
  }
  unattendedCheckpointOutboxFlushPromise =
    flushUnattendedCheckpointReportOutbox({
      send: sendUnattendedRuntimeMessage,
    })
      .catch((error) => {
        if (!quiet) {
          console.warn(
            "[Sidebar] Flush unattended checkpoint outbox failed:",
            error,
          );
        }
        return {ok: false, reason: "flush_error", error};
      })
      .finally(() => {
        unattendedCheckpointOutboxFlushPromise = null;
      });
  return unattendedCheckpointOutboxFlushPromise;
}

async function reportInitialUnattendedKeywordRun(
  requestId,
  patch = {},
  {attemptId = activeUnattendedRunAttemptId} = {},
) {
  let lastResult = null;
  for (const delayMs of UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    lastResult = await reportUnattendedKeywordRun(requestId, patch, {
      attemptId,
      quiet: delayMs < UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS.at(-1),
    });
    if (lastResult.accepted || lastResult.reason !== "transport_error") {
      return lastResult;
    }
  }
  return lastResult;
}

async function sendUnattendedRuntimeMessage(message) {
  let timeoutId = null;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error("无人值守状态上报超时");
          error.code = "UNATTENDED_RUNTIME_MESSAGE_TIMEOUT";
          reject(error);
        }, UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

async function reportUnattendedTerminalRun(
  requestId,
  patch = {},
  {attemptId = activeUnattendedRunAttemptId} = {},
) {
  const normalizedRequestId = String(requestId || "").trim();
  const normalizedAttemptId = String(attemptId || "").trim();
  const terminalProgressKey = `${normalizedRequestId}:${normalizedAttemptId}`;
  const commitTerminalFence = () => {
    if (
      normalizedRequestId &&
      normalizedRequestId ===
        String(activeUnattendedRunRequestId || "").trim() &&
      (!normalizedAttemptId ||
        normalizedAttemptId ===
          String(activeUnattendedRunAttemptId || "").trim())
    ) {
      // 只有后台确认终态（或确认当前 attempt 已被替换）后才立终态栅栏。
      // 若传输短暂失败，runner 仍需继续心跳并允许后台从检查点恢复。
      activeUnattendedTerminalProgressKey = terminalProgressKey;
    }
  };
  let lastResult = null;
  let attemptIndex = 0;
  while (true) {
    const delayMs =
      attemptIndex < UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS.length
        ? UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS[attemptIndex]
        : Math.min(
            UNATTENDED_TERMINAL_CONFIRM_RETRY_MAX_MS,
            3000 *
              2 **
                Math.min(
                  4,
                  attemptIndex - UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS.length,
                ),
          );
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    lastResult = await reportUnattendedKeywordRun(requestId, patch, {
      attemptId,
      quiet: delayMs < UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS.at(-1),
    });
    if (
      lastResult.accepted ||
      lastResult.reason === "terminal" ||
      lastResult.reason === "attempt_mismatch"
    ) {
      commitTerminalFence();
      return lastResult;
    }
    // 只有传输层错误需要持续确认。后台明确拒绝时把结果交还调用方，
    // 避免不存在的任务在旧 runner 中无限重试。
    if (lastResult.reason !== "transport_error") {
      return lastResult;
    }
    attemptIndex += 1;
  }
}

function startUnattendedKeywordRunHeartbeat(
  requestId,
  attemptId = activeUnattendedRunAttemptId,
) {
  if (!requestId) {
    return () => {};
  }

  let stopped = false;
  let reportInFlight = false;
  const reportHeartbeat = async () => {
    if (stopped || reportInFlight) {
      return;
    }
    reportInFlight = true;
    try {
      const result = await reportUnattendedKeywordRun(
        requestId,
        {
          heartbeatAt: new Date().toISOString(),
        },
        {attemptId},
      );
      if (
        result?.reason === "attempt_mismatch" ||
        result?.reason === "terminal"
      ) {
        stopped = true;
      }
    } finally {
      reportInFlight = false;
    }
  };

  void reportHeartbeat();
  const timerId = setInterval(
    reportHeartbeat,
    UNATTENDED_RUN_HEARTBEAT_INTERVAL_MS,
  );
  return () => {
    stopped = true;
    clearInterval(timerId);
  };
}

function createUnattendedKeywordProgressReporter(
  requestId,
  {
    checkpoint = null,
    taskTotal = 0,
    attemptId = activeUnattendedRunAttemptId,
    executionMode = "unattended_plan",
  } = {},
) {
  const executionCopy = getKeywordExecutionCopy({executionMode});
  let lastFingerprint = "";
  let lastReportedAt = 0;
  let lastSnapshot = null;
  const detailTotalsByKeyword = new Map();
  const readCount = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
  };
  const sumDetailField = (field) =>
    Array.from(detailTotalsByKeyword.values()).reduce(
      (total, item) => total + Math.max(0, Number(item?.[field]) || 0),
      0,
    );
  const reporter = (progress = {}) => {
    if (
      !requestId ||
      requestId !== String(activeUnattendedRunRequestId || "").trim() ||
      (attemptId &&
        attemptId !== String(activeUnattendedRunAttemptId || "").trim())
    ) {
      return;
    }
    const projectedProgress = projectCaptureTaskProgress(progress);
    const message = String(
      projectedProgress?.message || `${executionCopy.taskLabel}运行中`,
    ).trim();
    const phase = String(projectedProgress?.phase || "").trim();
    const detailKeyword = String(projectedProgress?.keyword || "").trim();
    if (detailKeyword && isCaptureTaskDetailPhase(phase)) {
      const round = Math.max(
        1,
        Number(
          projectedProgress?.roundCurrent ?? projectedProgress?.round,
        ) || 1,
      );
      const key = `${round}:${detailKeyword}`;
      const previous = detailTotalsByKeyword.get(key) || {
        success: 0,
        failed: 0,
        aiFiltered: 0,
        noEnhancement: 0,
      };
      const next = {...previous};
      const terminalDetailPhase = /^detail_batch_(?:done|failed|canceled|interrupted)$/u.test(
        phase,
      );
      const success = readCount(projectedProgress?.successCount);
      const failed = readCount(projectedProgress?.failedCount);
      const aiFiltered = readCount(projectedProgress?.aiFilteredCount);
      const noEnhancement = readCount(projectedProgress?.skippedCount);
      if (success !== null) {
        next.success = terminalDetailPhase
          ? success
          : Math.max(next.success, success);
      }
      if (failed !== null) {
        next.failed = terminalDetailPhase
          ? failed
          : Math.max(next.failed, failed);
      }
      if (aiFiltered !== null) {
        next.aiFiltered = Math.max(next.aiFiltered, aiFiltered);
      }
      if (noEnhancement !== null) {
        next.noEnhancement = Math.max(next.noEnhancement, noEnhancement);
      }
      detailTotalsByKeyword.set(key, next);
    }
    const now = Date.now();
    const remainingMs = Number.isFinite(Number(projectedProgress?.remainingMs))
      ? Math.max(0, Number(projectedProgress.remainingMs))
      : null;
    const updatedAt = new Date().toISOString();
    const checkpointSummary = summarizeUnattendedKeywordCheckpoint(
      checkpoint || {},
    );
    const progressSnapshot = {
      current: Number.isFinite(Number(projectedProgress?.current))
        ? Number(projectedProgress.current)
        : 0,
      total: Number.isFinite(Number(projectedProgress?.total))
        ? Number(projectedProgress.total)
        : 0,
      captureTaskId: String(projectedProgress?.captureTaskId || ""),
      unattendedRequestId: String(
        projectedProgress?.unattendedRequestId || requestId || "",
      ),
      unattendedAttemptId: String(
        projectedProgress?.unattendedAttemptId || attemptId || "",
      ),
      keyword: String(projectedProgress?.keyword || ""),
      keywordCurrent: readFiniteProgressNumber(
        projectedProgress?.keywordCurrent,
      ),
      keywordTotal: readFiniteProgressNumber(
        projectedProgress?.keywordTotal,
      ),
      itemCurrent: readFiniteProgressNumber(projectedProgress?.itemCurrent),
      itemTotal: readFiniteProgressNumber(projectedProgress?.itemTotal),
      nextKeyword: String(projectedProgress?.nextKeyword || ""),
      runStartedAt: String(projectedProgress?.runStartedAt || ""),
      finishedAt: String(projectedProgress?.finishedAt || ""),
      progressScope: String(projectedProgress?.progressScope || ""),
      phase,
      message,
      recordId: String(projectedProgress?.recordId || ""),
      runnerTabId: Number.isFinite(Number(projectedProgress?.runnerTabId))
        ? Number(projectedProgress.runnerTabId)
        : null,
      remainingMs,
      waitUntil:
        remainingMs !== null
          ? new Date(Date.now() + remainingMs).toISOString()
          : String(projectedProgress?.waitUntil || ""),
      round: readFiniteProgressNumber(
        projectedProgress?.roundCurrent,
        projectedProgress?.round,
      ),
      roundCurrent: readFiniteProgressNumber(
        projectedProgress?.roundCurrent,
        projectedProgress?.round,
      ),
      roundTotal: readFiniteProgressNumber(projectedProgress?.roundTotal),
      attemptCurrent: readFiniteProgressNumber(
        projectedProgress?.attemptCurrent,
        projectedProgress?.attempt,
      ),
      attemptTotal: readFiniteProgressNumber(
        projectedProgress?.attemptTotal,
        projectedProgress?.maxAttempts,
      ),
      phaseStartedAt: String(projectedProgress?.phaseStartedAt || ""),
      workerMode: String(projectedProgress?.workerMode || ""),
      workerStates: Array.isArray(projectedProgress?.workerStates)
        ? projectedProgress.workerStates.slice(0, 2)
        : [],
      taskMeta:
        projectedProgress?.taskMeta &&
        typeof projectedProgress.taskMeta === "object"
          ? projectedProgress.taskMeta
          : {},
      detectedCount: readFiniteProgressNumber(
        projectedProgress?.detectedCount,
      ),
      markedCount: readFiniteProgressNumber(projectedProgress?.markedCount),
      filteredCount: readFiniteProgressNumber(
        projectedProgress?.filteredCount,
      ),
      collectedCount: readFiniteProgressNumber(
        projectedProgress?.collectedCount,
      ),
      savedCount: readFiniteProgressNumber(projectedProgress?.savedCount),
      commentsCount: readFiniteProgressNumber(
        projectedProgress?.commentsCount,
        projectedProgress?.collectedCount,
      ),
      followersCount: readFiniteProgressNumber(
        projectedProgress?.followersCount,
        projectedProgress?.bloggerFollowersCount,
      ),
      detailSuccessCount: sumDetailField("success"),
      detailFailedCount: sumDetailField("failed"),
      aiFilteredCount: sumDetailField("aiFiltered"),
      noEnhancementCount: sumDetailField("noEnhancement"),
      syncSuccessCount: readCount(projectedProgress?.syncSuccessCount),
      syncFailedCount: readCount(projectedProgress?.syncFailedCount),
      syncSkippedCount: readCount(projectedProgress?.syncSkippedCount),
      syncRemainingCount: readCount(projectedProgress?.syncRemainingCount),
      progressPercent: readFiniteProgressNumber(
        projectedProgress?.progressPercent,
      ),
      updatedAt,
    };
    lastSnapshot = progressSnapshot;
    const fingerprint = JSON.stringify({
      message,
      phase,
      current: progressSnapshot.current,
      total: progressSnapshot.total,
      detailSuccessCount: progressSnapshot.detailSuccessCount,
      detailFailedCount: progressSnapshot.detailFailedCount,
      aiFilteredCount: progressSnapshot.aiFilteredCount,
      noEnhancementCount: progressSnapshot.noEnhancementCount,
      syncSuccessCount: progressSnapshot.syncSuccessCount,
      syncFailedCount: progressSnapshot.syncFailedCount,
      syncRemainingCount: progressSnapshot.syncRemainingCount,
    });
    if (fingerprint === lastFingerprint && now - lastReportedAt < 1500) {
      return;
    }
    lastFingerprint = fingerprint;
    lastReportedAt = now;
    activeUnattendedProgressSeq += 1;
    void reportUnattendedKeywordRun(
      requestId,
      {
        status: "running",
        message,
        progressSeq: activeUnattendedProgressSeq,
        businessProgressAt: updatedAt,
        counts: buildUnattendedTaskCounts(checkpoint || {}, checkpointSummary, {
          total: taskTotal,
        }),
        waitUntil:
          remainingMs !== null
            ? new Date(Date.now() + remainingMs).toISOString()
            : "",
        progress: progressSnapshot,
      },
      {attemptId},
    ).catch(() => null);
  };
  reporter.getSnapshot = () => (lastSnapshot ? {...lastSnapshot} : null);
  return reporter;
}

function resolveUnattendedProtectedWaitUntilMs(
  request = {},
  fallbackNotBeforeMs = 0,
) {
  const candidates = [
    request?.recoveryWaitUntil,
    request?.waitUntil,
    request?.progress?.waitUntil,
  ]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value));
  const fallback = Number(fallbackNotBeforeMs);
  if (Number.isFinite(fallback) && fallback > 0) {
    candidates.push(fallback);
  }
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

async function reportUnattendedProtectedWaitState(
  requestId,
  {
    waitUntilMs = 0,
    remainingMs = 0,
    phase = "waiting_next_round",
    message = "等待下一轮采集",
    round = null,
    roundTotal = null,
    keyword = "",
    keywordCurrent = null,
    keywordTotal = null,
    counts = null,
    attemptId = "",
  } = {},
) {
  let lastResult = null;
  for (const delayMs of [0, 300, 900]) {
    if (delayMs > 0) await sleep(delayMs);
    if (
      activeUnattendedAttemptRejected ||
      batchKeywordCancelRequested ||
      detailBatchCancelRequested ||
      requestId !== String(activeUnattendedRunRequestId || "").trim() ||
      (attemptId &&
        attemptId !== String(activeUnattendedRunAttemptId || "").trim())
    ) {
      return false;
    }
    activeUnattendedProgressSeq += 1;
    const updatedAt = new Date().toISOString();
    const reportPatch = {
      status: "running",
      progressSeq: activeUnattendedProgressSeq,
      waitUntil:
        Number.isFinite(Number(waitUntilMs)) && Number(waitUntilMs) > 0
          ? new Date(Number(waitUntilMs)).toISOString()
          : "",
      message,
      progress: {
        current: 0,
        total: 0,
        keyword: String(keyword || ""),
        keywordCurrent: readFiniteProgressNumber(keywordCurrent),
        keywordTotal: readFiniteProgressNumber(keywordTotal),
        itemCurrent: null,
        itemTotal: null,
        phase,
        message,
        remainingMs: Math.max(0, Number(remainingMs) || 0),
        round: Number.isFinite(Number(round)) ? Number(round) : null,
        roundCurrent: readFiniteProgressNumber(round),
        roundTotal: readFiniteProgressNumber(roundTotal),
        updatedAt,
      },
    };
    if (counts && typeof counts === "object") {
      reportPatch.counts = counts;
    }
    lastResult = await reportUnattendedKeywordRun(
      requestId,
      reportPatch,
      {attemptId},
    );
    if (lastResult?.accepted) return true;
    if (
      lastResult?.reason === "attempt_mismatch" ||
      lastResult?.reason === "terminal"
    ) {
      return false;
    }
  }
  const error = new Error("无法确认无人值守等待边界，已停止本次执行");
  error.code = "UNATTENDED_WAIT_STATE_WRITE_FAILED";
  throw error;
}

async function waitForUnattendedProtectedStart(
  request,
  {fallbackNotBeforeMs = 0, round = null} = {},
) {
  const requestId = String(request?.id || "").trim();
  const requestAttemptId = String(request?.attemptId || "").trim();
  if (!requestId) return false;
  const plannedKeywords = dedupeKeywords(
    Array.isArray(request?.planSnapshot?.keywords)
      ? request.planSnapshot.keywords
      : [],
  ).slice(0, MAX_BATCH_KEYWORDS);
  const plannedRounds = Math.max(
    1,
    Number(request?.planSnapshot?.maxRounds) || 1,
  );
  const plannedTaskTotal = plannedKeywords.length * plannedRounds;
  const checkpoint =
    request?.checkpoint && typeof request.checkpoint === "object"
      ? request.checkpoint
      : {};
  const checkpointSummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
  const waitCounts = buildUnattendedTaskCounts(checkpoint, checkpointSummary, {
    total: plannedTaskTotal,
  });
  const activeKeywordIndex = Math.max(
    0,
    Math.min(
      plannedKeywords.length - 1,
      Number(checkpoint?.activeKeywordIndex) || 0,
    ),
  );
  const activeKeyword = String(
    checkpoint?.activeKeyword || plannedKeywords[activeKeywordIndex] || "",
  ).trim();
  const waitProgress = {
    roundTotal: plannedRounds,
    keyword: activeKeyword,
    keywordCurrent:
      plannedKeywords.length > 0 ? activeKeywordIndex + 1 : null,
    keywordTotal: plannedKeywords.length || null,
    counts: waitCounts,
  };
  const waitUntilMs = resolveUnattendedProtectedWaitUntilMs(
    request,
    fallbackNotBeforeMs,
  );
  const hadWaitMarker = Boolean(
    String(request?.recoveryWaitUntil || request?.waitUntil || request?.progress?.waitUntil || "").trim(),
  );

  while (waitUntilMs > Date.now()) {
    if (
      activeUnattendedAttemptRejected ||
      batchKeywordCancelRequested ||
      detailBatchCancelRequested
    ) {
      return false;
    }
    const remainingMs = Math.max(0, waitUntilMs - Date.now());
    const message = `上一轮已完成，约 ${Math.max(1, Math.ceil(remainingMs / 60000))} 分钟后继续采集`;
    const accepted = await reportUnattendedProtectedWaitState(requestId, {
      waitUntilMs,
      remainingMs,
      message,
      round,
      attemptId: requestAttemptId,
      ...waitProgress,
    });
    if (!accepted) return false;
    await sleepWithStop(
      Math.min(remainingMs, UNATTENDED_PROTECTED_WAIT_TICK_MS),
      () =>
        activeUnattendedAttemptRejected ||
        batchKeywordCancelRequested ||
        detailBatchCancelRequested,
    );
  }

  if (
    activeUnattendedAttemptRejected ||
    batchKeywordCancelRequested ||
    detailBatchCancelRequested
  ) {
    return false;
  }
  if (!hadWaitMarker && !(Number(fallbackNotBeforeMs) > 0)) {
    return true;
  }
  return await reportUnattendedProtectedWaitState(requestId, {
    waitUntilMs: 0,
    remainingMs: 0,
    phase: "protected_wait_complete",
    message: "防风控等待已结束，准备继续采集",
    round,
    attemptId: requestAttemptId,
    ...waitProgress,
  });
}

async function acquireCaptureExecutionLock({
  owner = "manual",
  label = "采集任务",
} = {}) {
  if (captureExecutionLockReleasePendingId) {
    const released = await releaseCaptureExecutionLock(
      captureExecutionLockReleasePendingId,
    );
    if (!released) {
      showMessage(
        "上一次采集已结束，但执行锁仍在清理中，请稍后重试",
        "warning",
      );
      return null;
    }
  }
  if (
    owner === "unattended_keyword_plan" &&
    activeCaptureExecutionLockId &&
    adoptedUnattendedCaptureExecutionLockId === activeCaptureExecutionLockId
  ) {
    return await validateAdoptedUnattendedCaptureExecutionLock({
      lockId: activeCaptureExecutionLockId,
      owner,
      label,
    });
  }
  try {
    let holderTabId = null;
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      holderTabId = activeTab?.id ?? null;
    } catch {
      // MessageSender.tab/documentId 仍会由 background 作为可信持有者信息。
    }
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:acquire-capture-lock",
      owner,
      label,
      holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
      holderTabId,
    });
    if (response?.ok && response.data?.id) {
      activeCaptureExecutionLockId = response.data.id;
      adoptedUnattendedCaptureExecutionLockId = "";
      startCaptureExecutionLockHeartbeat(response.data.id, holderTabId);
      return response.data;
    }
    const activeLabel = response?.data?.label || "其他采集任务";
    showMessage(
      `${activeLabel}仍在运行，可能位于其他标签页；若长时间没有进度，底部会显示原因和取消入口`,
      "warning",
    );
    return null;
  } catch (error) {
    console.warn("[Sidebar] Acquire capture execution lock failed:", error);
    showMessage("无法确认采集任务状态，请刷新扩展后重试", "error");
    return null;
  }
}

function stopCaptureExecutionLockHeartbeat(lockId = "") {
  if (
    lockId &&
    captureExecutionLockHeartbeatLockId &&
    captureExecutionLockHeartbeatLockId !== lockId
  ) {
    return;
  }
  if (captureExecutionLockHeartbeatTimer) {
    clearInterval(captureExecutionLockHeartbeatTimer);
    captureExecutionLockHeartbeatTimer = null;
  }
  captureExecutionLockHeartbeatLockId = "";
  captureExecutionLockHeartbeatInFlight = false;
  captureExecutionLockInitialHolderTabId = null;
}

function resolveCaptureExecutionLockRunnerTabId(fallbackTabId = null) {
  const candidates = [
    detailBatchRunnerTabId,
    activeBatchRunnerTabId,
    activeRecoveryRunnerTabId,
    activeCommentsCaptureTabId,
    fallbackTabId,
    captureExecutionLockInitialHolderTabId,
  ];
  for (const candidate of candidates) {
    const tabId = Number(candidate);
    if (Number.isFinite(tabId) && tabId > 0) {
      return tabId;
    }
  }
  return null;
}

function handleCaptureExecutionLockLost(lockId) {
  if (!lockId || activeCaptureExecutionLockId !== lockId) {
    return;
  }
  const relayTabId = resolveCaptureExecutionLockRunnerTabId();
  stopCaptureExecutionLockHeartbeat(lockId);
  if (adoptedUnattendedCaptureExecutionLockId === lockId) {
    adoptedUnattendedCaptureExecutionLockId = "";
  }
  activeCaptureExecutionLockId = "";
  if (activeUnattendedRunRequestId) {
    activeCaptureTaskCancellationReason = "capture_lock_lost";
  }
  setCancelFlag(true);
  searchCaptureCancelRequested = true;
  batchKeywordCancelRequested = true;
  batchUrlCancelRequested = true;
  detailBatchCancelRequested = true;
  if (!activeUnattendedRunRequestId) {
    void requestCaptureCancelSignal(relayTabId).catch((error) => {
      console.warn("[Sidebar] Relay cancel after capture lock loss failed:", error);
    });
  }
  showMessage("采集任务锁已失效，本次任务正在停止，请重新启动", "error");
}

async function renewCaptureExecutionLock(lockId, holderTabId = null) {
  if (
    !lockId ||
    activeCaptureExecutionLockId !== lockId ||
    captureExecutionLockHeartbeatInFlight
  ) {
    return;
  }
  captureExecutionLockHeartbeatInFlight = true;
  try {
    const currentRunnerTabId = resolveCaptureExecutionLockRunnerTabId(
      holderTabId,
    );
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:renew-capture-lock",
      lockId,
      holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
      holderTabId: currentRunnerTabId,
    });
    if (!response?.ok) {
      console.warn("[Sidebar] Capture execution lock renewal rejected:", {
        lockId,
        reason: response?.reason || "unknown",
      });
      handleCaptureExecutionLockLost(lockId);
    }
  } catch (error) {
    // service worker 被唤醒或短暂重启时保留本地任务，下一次心跳会重试；
    // 真正失联的锁会由 background 的租约期限回收。
    console.warn("[Sidebar] Renew capture execution lock failed:", error);
  } finally {
    captureExecutionLockHeartbeatInFlight = false;
  }
}

function startCaptureExecutionLockHeartbeat(lockId, holderTabId = null) {
  stopCaptureExecutionLockHeartbeat();
  captureExecutionLockHeartbeatLockId = lockId;
  const normalizedHolderTabId = Number(holderTabId);
  captureExecutionLockInitialHolderTabId =
    Number.isFinite(normalizedHolderTabId) && normalizedHolderTabId > 0
      ? normalizedHolderTabId
      : null;
  captureExecutionLockHeartbeatTimer = setInterval(() => {
    void renewCaptureExecutionLock(lockId);
  }, CAPTURE_EXECUTION_LOCK_HEARTBEAT_INTERVAL_MS);
}

async function validateAdoptedUnattendedCaptureExecutionLock({
  lockId,
  owner,
  label,
}) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:renew-capture-lock",
      lockId,
      holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
      holderTabId: resolveCaptureExecutionLockRunnerTabId(),
    });
    if (
      !response?.ok ||
      activeCaptureExecutionLockId !== lockId ||
      adoptedUnattendedCaptureExecutionLockId !== lockId
    ) {
      handleCaptureExecutionLockLost(lockId);
      return null;
    }
    return {
      ...(response.data || {}),
      id: lockId,
      owner,
      label,
      holderTabId:
        response.data?.holderTabId ?? captureExecutionLockInitialHolderTabId,
    };
  } catch (error) {
    console.warn("[Sidebar] Validate adopted capture lock failed:", error);
    handleCaptureExecutionLockLost(lockId);
    return null;
  }
}

function adoptUnattendedCaptureExecutionLock(lock = null) {
  const lockId = String(lock?.id || "").trim();
  if (!lockId) {
    return false;
  }
  activeCaptureExecutionLockId = lockId;
  adoptedUnattendedCaptureExecutionLockId = lockId;
  startCaptureExecutionLockHeartbeat(lockId, lock?.holderTabId);
  return true;
}

async function releaseCaptureExecutionLock(lockId = activeCaptureExecutionLockId) {
  if (!lockId) {
    return false;
  }
  stopCaptureExecutionLockHeartbeat(lockId);
  let released = false;
  for (const delayMs of [0, 120, 360]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:release-capture-lock",
        lockId,
        holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
      });
      if (response?.ok) {
        released = true;
        break;
      }
      console.warn("[Sidebar] Capture execution lock release rejected:", lockId);
    } catch (error) {
      console.warn("[Sidebar] Release capture execution lock failed:", error);
    }
  }

  if (released) {
    if (adoptedUnattendedCaptureExecutionLockId === lockId) {
      adoptedUnattendedCaptureExecutionLockId = "";
    }
    if (activeCaptureExecutionLockId === lockId) {
      activeCaptureExecutionLockId = "";
    }
    if (captureExecutionLockReleasePendingId === lockId) {
      captureExecutionLockReleasePendingId = "";
    }
  } else {
    captureExecutionLockReleasePendingId = lockId;
  }
  return released;
}

function getUnattendedRunRequestIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get(
      UNATTENDED_RUN_QUERY_KEY,
    );
  } catch {
    return "";
  }
}

function getUnattendedRunAttemptIdFromUrl() {
  try {
    return (
      new URLSearchParams(window.location.search).get(
        UNATTENDED_RUN_ATTEMPT_QUERY_KEY,
      ) || ""
    ).trim();
  } catch {
    return "";
  }
}

function getTargetedPostRunRequestIdFromUrl() {
  try {
    return (
      new URLSearchParams(window.location.search).get(
        TARGETED_POST_RUN_QUERY_KEY,
      ) || ""
    ).trim();
  } catch {
    return "";
  }
}

function getTargetedPostRunAttemptIdFromUrl() {
  try {
    return (
      new URLSearchParams(window.location.search).get(
        TARGETED_POST_RUN_ATTEMPT_QUERY_KEY,
      ) || ""
    ).trim();
  } catch {
    return "";
  }
}

function createTargetedPostInvocationToken(requestId = "", attemptId = "") {
  const normalizedRequestId = String(requestId || "").trim();
  const normalizedAttemptId = String(attemptId || "").trim();
  if (!normalizedRequestId || !normalizedAttemptId) {
    return null;
  }
  return Object.freeze({
    requestId: normalizedRequestId,
    attemptId: normalizedAttemptId,
  });
}

function getTargetedPostInvocationTokenFromRequest(request) {
  return createTargetedPostInvocationToken(
    request?.id,
    request?.attemptId,
  );
}

function isSameTargetedPostInvocationToken(left, right) {
  return Boolean(
    left &&
      right &&
      left.requestId === right.requestId &&
      left.attemptId === right.attemptId,
  );
}

function isActiveTargetedPostInvocation(token) {
  return isSameTargetedPostInvocationToken(
    activeTargetedPostInvocationToken,
    token,
  );
}

function activateTargetedPostInvocation(token) {
  const normalizedToken = createTargetedPostInvocationToken(
    token?.requestId,
    token?.attemptId,
  );
  activeTargetedPostInvocationToken = normalizedToken;
  return normalizedToken;
}

function getTargetedPostInvocationOwnership(token) {
  return Object.freeze({
    active: isActiveTargetedPostInvocation(token),
    run: isSameTargetedPostInvocationToken(
      targetedPostRunInFlightOwnerToken,
      token,
    ),
    batch: isSameTargetedPostInvocationToken(
      targetedPostBatchStateOwnerToken,
      token,
    ),
    runnerTab: isSameTargetedPostInvocationToken(
      targetedPostRunnerTabOwnerToken,
      token,
    ),
  });
}

function createTargetedPostInvocationError(
  reason = "stale_targeted_post_attempt",
) {
  const normalizedReason = String(reason || "").trim();
  const error = new Error(
    normalizedReason === "targeted_post_attempt_required"
      ? "定向作品任务缺少运行批次"
      : "定向作品任务已由新的运行批次接管",
  );
  error.code = normalizedReason || "stale_targeted_post_attempt";
  return error;
}

function handleTargetedPostRunRequestStorageChange(request) {
  const runnerRequestId = getTargetedPostRunRequestIdFromUrl();
  if (!runnerRequestId) {
    targetedPostRunState = request;
    renderCaptureDebugSession(getCurrentRuntime() || {});
    return;
  }

  const runnerToken = createTargetedPostInvocationToken(
    runnerRequestId,
    getTargetedPostRunAttemptIdFromUrl(),
  );
  if (!runnerToken) {
    activeTargetedPostInvocationToken = null;
    targetedPostRunState = null;
    stopTargetedPostRunnerForInvalidBinding(
      "targeted_post_attempt_required",
    );
    renderCaptureDebugSession(getCurrentRuntime() || {});
    return;
  }

  const requestToken = getTargetedPostInvocationTokenFromRequest(request);
  if (
    activeTargetedPostInvocationToken &&
    activeTargetedPostInvocationToken.requestId === runnerRequestId &&
    !isSameTargetedPostInvocationToken(
      activeTargetedPostInvocationToken,
      requestToken,
    )
  ) {
    activateTargetedPostInvocation(requestToken);
    targetedPostRunState = null;
    stopTargetedPostRunnerForInvalidBinding(
      requestToken
        ? "stale_targeted_post_attempt"
        : "targeted_post_attempt_required",
    );
    renderCaptureDebugSession(getCurrentRuntime() || {});
    return;
  }

  if (!isSameTargetedPostInvocationToken(requestToken, runnerToken)) {
    return;
  }
  if (
    activeTargetedPostInvocationToken &&
    !isSameTargetedPostInvocationToken(
      activeTargetedPostInvocationToken,
      runnerToken,
    )
  ) {
    return;
  }
  if (!activeTargetedPostInvocationToken) {
    activateTargetedPostInvocation(runnerToken);
  }
  targetedPostRunState = request;
  renderCaptureDebugSession(getCurrentRuntime() || {});
  if (request?.cancelRequested === true) {
    targetedPostCancelRequested = true;
    batchUrlCancelRequested = true;
    if (
      activeBatchRunnerTabId &&
      isSameTargetedPostInvocationToken(
        targetedPostRunnerTabOwnerToken,
        runnerToken,
      )
    ) {
      void requestCaptureCancelSignal(activeBatchRunnerTabId).catch(
        (error) => {
          console.warn(
            "[Sidebar] Targeted post cancellation signal failed:",
            error,
          );
        },
      );
    }
  }
}

function resolveTargetedPostRunBinding(
  response,
  requestId = "",
  attemptId = "",
) {
  const normalizedRequestId = String(requestId || "").trim();
  const normalizedAttemptId = String(attemptId || "").trim();
  if (!normalizedAttemptId) {
    return {
      accepted: false,
      reason: "targeted_post_attempt_required",
      request: null,
    };
  }

  if (!response?.ok || response?.accepted === false) {
    return {
      accepted: false,
      reason: String(
        response?.reason || "targeted_post_run_binding_rejected",
      ),
      request: null,
    };
  }

  const request =
    response?.data && typeof response.data === "object"
      ? response.data
      : null;
  if (
    !request ||
    String(request.id || "").trim() !== normalizedRequestId ||
    String(request.attemptId || "").trim() !== normalizedAttemptId
  ) {
    return {
      accepted: false,
      reason: "stale_targeted_post_attempt",
      request: null,
    };
  }

  return {accepted: true, reason: "", request};
}

function stopTargetedPostRunnerForInvalidBinding(reason = "") {
  const normalizedReason = String(reason || "").trim();
  if (targetedPostRunBindingStopReason === normalizedReason) {
    return;
  }
  targetedPostRunBindingStopReason = normalizedReason;
  const message =
    normalizedReason === "targeted_post_attempt_required"
      ? "定向作品任务链接缺少运行批次，已停止执行"
      : "当前定向作品任务运行批次已失效，旧页面已停止执行";
  console.warn("[Sidebar] Targeted post runner stopped:", normalizedReason);
  showMessage(message, "warning");
}

async function loadTargetedPostRunStateForDisplay() {
  try {
    const requestId = getTargetedPostRunRequestIdFromUrl();
    const attemptId = getTargetedPostRunAttemptIdFromUrl();
    const invocationToken = createTargetedPostInvocationToken(
      requestId,
      attemptId,
    );
    if (requestId && !attemptId) {
      targetedPostRunState = null;
      stopTargetedPostRunnerForInvalidBinding(
        "targeted_post_attempt_required",
      );
      renderCaptureDebugSession(getCurrentRuntime() || {});
      return null;
    }

    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:get-targeted-post-run-state",
      ...(requestId ? {requestId, attemptId} : {}),
    });
    if (requestId) {
      const binding = resolveTargetedPostRunBinding(
        response,
        requestId,
        attemptId,
      );
      if (!binding.accepted) {
        targetedPostRunState = null;
        stopTargetedPostRunnerForInvalidBinding(binding.reason);
        renderCaptureDebugSession(getCurrentRuntime() || {});
        return null;
      }
      if (
        activeTargetedPostInvocationToken &&
        !isSameTargetedPostInvocationToken(
          activeTargetedPostInvocationToken,
          invocationToken,
        )
      ) {
        stopTargetedPostRunnerForInvalidBinding(
          "stale_targeted_post_attempt",
        );
        return null;
      }
      if (!activeTargetedPostInvocationToken) {
        activateTargetedPostInvocation(invocationToken);
      }
      if (!isActiveTargetedPostInvocation(invocationToken)) {
        return null;
      }
      targetedPostRunState = binding.request;
    } else {
      targetedPostRunState =
        response?.ok && response.data && typeof response.data === "object"
          ? response.data
          : null;
    }
    renderCaptureDebugSession(getCurrentRuntime() || {});
    return targetedPostRunState;
  } catch (error) {
    console.warn(
      "[Sidebar] Load targeted post run state for display failed:",
      error,
    );
    return null;
  }
}

async function updateTargetedPostRun(
  request,
  patch = {},
  invocationToken = null,
) {
  const requestToken = getTargetedPostInvocationTokenFromRequest(request);
  if (!requestToken) {
    throw createTargetedPostInvocationError(
      "targeted_post_attempt_required",
    );
  }
  if (
    invocationToken &&
    (!isSameTargetedPostInvocationToken(requestToken, invocationToken) ||
      !isActiveTargetedPostInvocation(invocationToken))
  ) {
    throw createTargetedPostInvocationError();
  }
  const response = await chrome.runtime.sendMessage({
    type: "onstarvoice:update-targeted-post-run",
    requestId: requestToken.requestId,
    attemptId: requestToken.attemptId,
    patch,
  });
  if (invocationToken && !isActiveTargetedPostInvocation(invocationToken)) {
    throw createTargetedPostInvocationError();
  }
  const binding = resolveTargetedPostRunBinding(
    response,
    requestToken.requestId,
    requestToken.attemptId,
  );
  if (!binding.accepted) {
    const error =
      binding.reason === "stale_targeted_post_attempt"
        ? createTargetedPostInvocationError(binding.reason)
        : new Error("定向作品任务状态更新失败");
    error.code = String(
      binding.reason || "TARGETED_POST_STATE_UPDATE_FAILED",
    );
    throw error;
  }
  if (invocationToken && !isActiveTargetedPostInvocation(invocationToken)) {
    throw createTargetedPostInvocationError();
  }
  targetedPostRunState = binding.request;
  renderCaptureDebugSession(getCurrentRuntime() || {});
  return binding.request;
}

function startTargetedPostRunHeartbeat(invocationToken, getCurrentRequest) {
  let stopped = false;
  let inFlight = false;

  const publish = async () => {
    if (
      stopped ||
      inFlight ||
      !isActiveTargetedPostInvocation(invocationToken)
    ) {
      return;
    }
    const current =
      typeof getCurrentRequest === "function" ? getCurrentRequest() : null;
    const currentToken = getTargetedPostInvocationTokenFromRequest(current);
    if (
      !current ||
      !isSameTargetedPostInvocationToken(currentToken, invocationToken) ||
      cloudTargetedPostApi?.isTerminalRunStatus?.(current.status)
    ) {
      return;
    }

    inFlight = true;
    const now = new Date().toISOString();
    try {
      await updateTargetedPostRun(
        current,
        {
          heartbeatAt: now,
        },
        invocationToken,
      );
    } catch (error) {
      if (
        isActiveTargetedPostInvocation(invocationToken) &&
        String(error?.code || "") !== "targeted_post_run_terminal"
      ) {
        console.warn("[Sidebar] Targeted post heartbeat failed:", error);
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void publish();
  }, TARGETED_POST_RUN_HEARTBEAT_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function cancelTargetedPostRunFromSidebar(requestId = "") {
  const current =
    targetedPostRunState && typeof targetedPostRunState === "object"
      ? targetedPostRunState
      : null;
  if (
    !current ||
    (requestId && String(current.id || "") !== String(requestId))
  ) {
    return false;
  }
  if (cloudTargetedPostApi?.isTerminalRunStatus(current.status)) {
    return true;
  }
  const currentToken = getTargetedPostInvocationTokenFromRequest(current);
  if (!currentToken) {
    return false;
  }
  const runnerRequestId = getTargetedPostRunRequestIdFromUrl();
  const runnerToken = createTargetedPostInvocationToken(
    runnerRequestId,
    getTargetedPostRunAttemptIdFromUrl(),
  );
  if (
    runnerRequestId &&
    (!isSameTargetedPostInvocationToken(currentToken, runnerToken) ||
      !isActiveTargetedPostInvocation(runnerToken))
  ) {
    return false;
  }
  targetedPostCancelRequested = true;
  batchUrlCancelRequested = true;
  const workflowLabel =
    current.workflow === "official_account_comment_patrol"
      ? "官方账号评论巡查"
      : current.workflow === "followed_creator_post_patrol"
        ? "关注博主作品扫描"
        : current.workflow === "official_account_post_discovery"
          ? "官方账号作品发现"
          : "负面帖子巡查";
  await updateTargetedPostRun(current, {
    status:
      String(current.status || "") === "pending"
        ? "canceled"
        : "cancel_requested",
    cancelRequested: true,
    finishedAt:
      String(current.status || "") === "pending"
        ? new Date().toISOString()
        : "",
    message:
      String(current.status || "") === "pending"
        ? `${workflowLabel}已在执行前停止`
        : `正在停止${workflowLabel}并保留已有结果`,
  }, runnerRequestId ? runnerToken : null);
  if (
    activeBatchRunnerTabId &&
    (!runnerRequestId ||
      isSameTargetedPostInvocationToken(
        targetedPostRunnerTabOwnerToken,
        runnerToken,
      ))
  ) {
    await requestCaptureCancelSignal(activeBatchRunnerTabId).catch(
      (error) => {
        console.warn(
          "[Sidebar] Targeted post cancellation signal failed:",
          error,
        );
      },
    );
  }
  return true;
}

async function confirmTargetedPostInvocationBinding(invocationToken) {
  if (!isActiveTargetedPostInvocation(invocationToken)) {
    return false;
  }
  const response = await chrome.runtime.sendMessage({
    type: "onstarvoice:get-targeted-post-run-state",
    requestId: invocationToken.requestId,
    attemptId: invocationToken.attemptId,
  });
  const binding = resolveTargetedPostRunBinding(
    response,
    invocationToken.requestId,
    invocationToken.attemptId,
  );
  return binding.accepted && isActiveTargetedPostInvocation(invocationToken);
}

async function settleTargetedPostRunnerTab(
  tabId,
  platform = "",
  {returnHome = true} = {},
) {
  const normalizedTabId = Number(tabId);
  if (!Number.isSafeInteger(normalizedTabId) || normalizedTabId <= 0) {
    return false;
  }

  let runnerTab = null;
  try {
    runnerTab = await chrome.tabs.get(normalizedTabId);
  } catch {
    return false;
  }

  // 这个标签页由当前定向任务自己创建，可以安全收尾。先停止当前作品的
  // 音视频；正常终态直接关闭，避免每个巡检任务在浏览器里留下一个平台
  // 首页。needs_action 保留现场供用户处理，但同样停止媒体播放。
  try {
    await chrome.scripting.executeScript({
      target: {tabId: normalizedTabId},
      func: () => {
        let pausedCount = 0;
        document.querySelectorAll("video, audio").forEach((media) => {
          try {
            media.pause?.();
            media.autoplay = false;
            media.loop = false;
            media.removeAttribute?.("autoplay");
            media.removeAttribute?.("loop");
            pausedCount += 1;
          } catch {
            // 单个媒体节点不可控时继续处理其他节点。
          }
        });
        return pausedCount;
      },
    });
  } catch (error) {
    console.warn("[Sidebar] Pause targeted runner media failed:", error);
  }

  if (!returnHome) {
    return true;
  }

  try {
    await chrome.tabs.remove(normalizedTabId);
    return true;
  } catch (error) {
    console.warn("[Sidebar] Close targeted runner tab failed:", error);
    return false;
  }
}

async function waitForTargetedPostRunnerTab(tabId, shouldStop) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20 * 1000) {
    if (shouldStop()) {
      const error = new Error("定向作品任务已停止");
      error.code = "TARGET_CAPTURE_CANCELED";
      throw error;
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      if (String(tab?.status || "") === "complete") {
        return tab;
      }
    } catch (error) {
      const wrapped = new Error(error?.message || "定向作品采集页已关闭");
      wrapped.code = "TARGET_RUNNER_TAB_CLOSED";
      throw wrapped;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const error = new Error("定向作品采集页打开超时");
  error.code = "TARGET_RUNNER_TAB_TIMEOUT";
  throw error;
}

function collectTargetedPostRecordIds(batchResult = {}) {
  const results = Array.isArray(batchResult?.results)
    ? batchResult.results
    : [];
  return [
    ...new Set(
      results.flatMap((result) =>
        Array.isArray(result?.recordIds)
          ? result.recordIds
              .map((recordId) => String(recordId || "").trim())
              .filter(Boolean)
          : [],
      ),
    ),
  ];
}

function buildTargetedProfileCaptureTaskContext(
  request = {},
  invocationToken = null,
) {
  const requestToken = getTargetedPostInvocationTokenFromRequest(request);
  if (
    !requestToken ||
    !invocationToken ||
    !isSameTargetedPostInvocationToken(requestToken, invocationToken)
  ) {
    throw createTargetedPostInvocationError(
      "stale_targeted_post_attempt",
    );
  }

  const officialCommentPatrol =
    String(request?.workflow || "").trim() ===
    "official_account_comment_patrol";
  // Native Debug resources for comment patrol use the physical run identity,
  // while server evidence always uses the UUID cloud task identity.
  return Object.freeze({
    taskId: officialCommentPatrol
      ? `${requestToken.requestId}::${requestToken.attemptId}`
      : "",
    captureTaskId: String(request.taskId || request.id || "").trim(),
    attemptId: requestToken.attemptId,
    label: getTargetedWorkflowLabel(request.workflow),
    ownerRequired: true,
  });
}

async function maybeClaimAndRunTargetedPostWorkflow() {
  const requestId = getTargetedPostRunRequestIdFromUrl();
  if (!requestId) {
    return;
  }
  const attemptId = getTargetedPostRunAttemptIdFromUrl();
  const invocationToken = createTargetedPostInvocationToken(
    requestId,
    attemptId,
  );
  if (!invocationToken) {
    targetedPostRunState = null;
    stopTargetedPostRunnerForInvalidBinding(
      "targeted_post_attempt_required",
    );
    renderCaptureDebugSession(getCurrentRuntime() || {});
    return;
  }
  if (targetedPostRunInFlight) {
    return;
  }
  if (!cloudTargetedPostApi?.normalizeCommandPayload) {
    throw new Error("当前扩展缺少定向作品采集协议");
  }

  const stateResponse = await chrome.runtime.sendMessage({
    type: "onstarvoice:get-targeted-post-run-state",
    requestId,
    attemptId,
  });
  const binding = resolveTargetedPostRunBinding(
    stateResponse,
    requestId,
    attemptId,
  );
  if (!binding.accepted) {
    targetedPostRunState = null;
    stopTargetedPostRunnerForInvalidBinding(binding.reason);
    renderCaptureDebugSession(getCurrentRuntime() || {});
    return;
  }
  if (
    activeTargetedPostInvocationToken &&
    !isSameTargetedPostInvocationToken(
      activeTargetedPostInvocationToken,
      invocationToken,
    )
  ) {
    stopTargetedPostRunnerForInvalidBinding(
      "stale_targeted_post_attempt",
    );
    return;
  }
  if (!activeTargetedPostInvocationToken) {
    activateTargetedPostInvocation(invocationToken);
  }
  if (!isActiveTargetedPostInvocation(invocationToken)) {
    return;
  }
  let request = binding.request;
  targetedPostRunBindingStopReason = "";
  targetedPostRunState = request;
  renderCaptureDebugSession(getCurrentRuntime() || {});
  if (
    cloudTargetedPostApi.isTerminalRunStatus(request.status)
  ) {
    return;
  }

  targetedPostRunInFlight = true;
  targetedPostRunInFlightOwnerToken = invocationToken;
  targetedPostCancelRequested = request.cancelRequested === true;
  batchUrlCancelRequested = targetedPostCancelRequested;
  let executionLock = null;
  let targetTabId = null;
  let stopTargetedPostHeartbeat = () => {};
  let targetedBusinessProgressTimer = null;
  let pendingTargetedBusinessProgress = null;
  let targetedBusinessProgressInFlight = Promise.resolve();
  const publishTargetedBusinessProgress = () => {
    if (targetedBusinessProgressTimer !== null) {
      clearTimeout(targetedBusinessProgressTimer);
      targetedBusinessProgressTimer = null;
    }
    const patch = pendingTargetedBusinessProgress;
    pendingTargetedBusinessProgress = null;
    if (!patch) return targetedBusinessProgressInFlight;
    targetedBusinessProgressInFlight = targetedBusinessProgressInFlight
      .then(async () => {
        if (!isActiveTargetedPostInvocation(invocationToken)) return;
        request = await updateTargetedPostRun(
          targetedPostRunState || request,
          patch,
          invocationToken,
        );
      })
      .catch((error) => {
        if (isActiveTargetedPostInvocation(invocationToken)) {
          console.warn(
            "[Sidebar] Targeted business progress persistence failed:",
            error,
          );
        }
      });
    return targetedBusinessProgressInFlight;
  };
  const queueTargetedBusinessProgress = (progress = {}, message = "") => {
    const updatedAt =
      String(progress?.updatedAt || "").trim() || new Date().toISOString();
    pendingTargetedBusinessProgress = {
      progress: {...progress, updatedAt},
      message: String(message || progress?.message || "").trim(),
      businessProgressAt: updatedAt,
    };
    if (targetedBusinessProgressTimer === null) {
      targetedBusinessProgressTimer = setTimeout(() => {
        void publishTargetedBusinessProgress();
      }, 1000);
    }
  };
  const flushTargetedBusinessProgress = async () => {
    await publishTargetedBusinessProgress();
    await targetedBusinessProgressInFlight;
  };
  const shouldStop = () =>
    !isActiveTargetedPostInvocation(invocationToken) ||
    (isSameTargetedPostInvocationToken(
      targetedPostRunInFlightOwnerToken,
      invocationToken,
    ) &&
      (targetedPostCancelRequested || batchUrlCancelRequested));
  const targetedWorkflow = String(
    request.workflow || "negative_post_patrol",
  ).trim();
  const isProfileDiscovery =
    isTargetedProfileDiscoveryWorkflow(
      targetedWorkflow,
      request.targetMode,
    );
  const targetedProfileCaptureTaskContext = isProfileDiscovery
    ? buildTargetedProfileCaptureTaskContext(request, invocationToken)
    : null;
  const workflowLabel = getTargetedWorkflowLabel(targetedWorkflow);
  try {
    executionLock = await acquireCaptureExecutionLock({
      owner: "cloud_targeted_post_capture",
      label: workflowLabel,
    });
    if (!executionLock) {
      request = await updateTargetedPostRun(request, {
        status: "needs_action",
        finishedAt: new Date().toISOString(),
        message: "其他采集任务正在占用当前浏览器，请稍后接力",
        error: {
          code: "CAPTURE_LOCK_CONFLICT",
          message: "其他采集任务正在占用当前浏览器",
          retryable: true,
        },
      }, invocationToken);
      return;
    }
    request = await updateTargetedPostRun(request, {
      status: "running",
      startedAt: request.startedAt || new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      message: isProfileDiscovery
        ? `正在逐个扫描${request.subjectType === "official" ? "官方账号" : "关注博主"}`
        : "正在逐条采集指定作品",
    }, invocationToken);
    stopTargetedPostHeartbeat = startTargetedPostRunHeartbeat(
      invocationToken,
      () => targetedPostRunState || request,
    );

    const settledItemIds = new Set(
      (Array.isArray(request.targetResults) ? request.targetResults : []).map(
        (result) => String(result?.itemId || ""),
      ),
    );
    const pendingTargets = (Array.isArray(request.targets)
      ? request.targets
      : []
    ).filter((target) => !settledItemIds.has(String(target?.itemId || "")));
    if (pendingTargets.length > 0 && !shouldStop()) {
      const targetTab = await chrome.tabs.create({
        url: pendingTargets[0].url,
        active: true,
      });
      if (!targetTab?.id) {
        const error = new Error("无法创建定向作品采集页");
        error.code = "TARGET_RUNNER_TAB_CREATE_FAILED";
        throw error;
      }
      targetTabId = Number(targetTab.id);
      if (!isActiveTargetedPostInvocation(invocationToken)) {
        throw createTargetedPostInvocationError();
      }
      activeBatchRunnerTabId = targetTabId;
      targetedPostRunnerTabOwnerToken = invocationToken;
      await waitForTargetedPostRunnerTab(targetTabId, shouldStop);
    }

    if (!isActiveTargetedPostInvocation(invocationToken)) {
      throw createTargetedPostInvocationError();
    }
    batchUrlCaptureInFlight = true;
    targetedPostBatchStateOwnerToken = invocationToken;
    batchUrlCaptureMode = isProfileDiscovery
      ? "profile_discovery"
      : "targeted_posts";
    const storedCaptureSettings = await getCaptureSettings();
    const captureSettings = {
      ...(storedCaptureSettings &&
      typeof storedCaptureSettings === "object"
        ? storedCaptureSettings
        : {}),
      ...(request.captureSettings &&
      typeof request.captureSettings === "object"
        ? request.captureSettings
        : {}),
    };
    const monitorSettings =
      request.monitorSettings && typeof request.monitorSettings === "object"
        ? request.monitorSettings
        : {};
    let targetResults = Array.isArray(request.targetResults)
      ? request.targetResults.slice()
      : [];

    for (const target of pendingTargets) {
      if (shouldStop()) break;
      const startedAt = new Date().toISOString();
      request = await updateTargetedPostRun(request, {
        status: "running",
        heartbeatAt: startedAt,
        progress: {
          current: Number(target.ordinal) || targetResults.length + 1,
          total: request.targets.length,
          itemId: target.itemId,
          recordId: target.recordId,
          title: target.title,
          url: target.url,
          targetTabId,
          phase: "target_opening",
        },
        message: isProfileDiscovery
          ? `正在打开第 ${target.ordinal}/${request.targets.length} 个账号主页`
          : `正在打开第 ${target.ordinal}/${request.targets.length} 条指定作品`,
      }, invocationToken);
      let batchResult = null;
      let targetResult = null;
      if (isProfileDiscovery) {
        const monitorResult = await executeMonitorRunItem({
          runItem: target,
          monitorItem: target,
          index: Math.max(0, Number(target.ordinal) - 1),
          total: request.targets.length,
          monitorSettings,
          captureSettings,
          runnerTabId: targetTabId,
          // The cloud task command is already leased to this Agent. Calling
          // the legacy monitor-start endpoint would correctly reject this
          // execution because it is linked to a cloud task item.
          executionPreclaimed: true,
          captureTaskContext: {
            ...targetedProfileCaptureTaskContext,
            captureTaskItemAttemptId: String(
              target.captureTaskItemAttemptId || "",
            ).trim(),
            captureTaskItemRequestHash: String(
              target.captureTaskItemRequestHash || "",
            ).trim(),
          },
          shouldStop,
          onProgress: (progress = {}) => {
            if (!isActiveTargetedPostInvocation(invocationToken)) {
              return;
            }
            const displayedToken =
              getTargetedPostInvocationTokenFromRequest(
                targetedPostRunState,
              );
            if (
              displayedToken &&
              !isSameTargetedPostInvocationToken(
                displayedToken,
                invocationToken,
              )
            ) {
              return;
            }
            const rawPhase = String(progress.phase || "profile_scan");
            const nextProgress = {
              ...(targetedPostRunState?.progress &&
              typeof targetedPostRunState.progress === "object"
                ? targetedPostRunState.progress
                : request?.progress &&
                    typeof request.progress === "object"
                  ? request.progress
                  : {}),
              current: Number(target.ordinal) || targetResults.length + 1,
              total: request.targets.length,
              itemId: target.itemId,
              recordId: target.recordId,
              title: target.title,
              url: target.url,
              targetTabId,
              phase: rawPhase.startsWith("target_")
                ? rawPhase
                : `target_${rawPhase}`,
              message: String(
                progress.message ||
                  `正在扫描第 ${target.ordinal}/${request.targets.length} 个账号`,
              ),
              updatedAt:
                String(progress.updatedAt || "").trim() ||
                new Date().toISOString(),
            };
            targetedPostRunState = cloudTargetedPostApi.mergeRunPatch(
              targetedPostRunState || request,
              {
                progress: nextProgress,
                message: nextProgress.message,
              },
            );
            queueTargetedBusinessProgress(
              nextProgress,
              nextProgress.message,
            );
            renderCaptureDebugSession(getCurrentRuntime() || {});
          },
        });
        const monitorStatus = String(monitorResult?.status || "");
        const canceled =
          shouldStop() ||
          String(monitorResult?.errorCode || "") === "capture_canceled";
        targetResult = {
          workflow: targetedWorkflow,
          itemId: String(target.itemId || ""),
          recordId: String(target.recordId || target.subscriptionId || ""),
          externalId: String(
            target.externalId || target.subscriptionId || "",
          ),
          subscriptionId: String(target.subscriptionId || ""),
          executionId: String(target.executionId || ""),
          ordinal: Number(target.ordinal) || targetResults.length + 1,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: canceled
            ? "canceled"
            : ["success", "no_hit"].includes(monitorStatus)
              ? "completed"
              : "failed",
          businessOutcome:
            monitorStatus === "no_hit"
              ? "profile_scan_no_new_posts"
              : monitorStatus === "success"
                ? "profile_scan_completed"
                : "profile_scan_failed",
          scanComplete: monitorResult?.scanComplete === true,
          partial: monitorResult?.partial === true,
          incompleteReason: String(monitorResult?.incompleteReason || ""),
          ...(monitorStatus === "no_hit"
            ? {
                noResults: true,
                resultKind: "profile_scan_no_new_posts",
                qualifyingCount: 0,
                scanComplete: true,
              }
            : {}),
          scannedCount: Math.max(
            0,
            Number(monitorResult?.scannedCount) || 0,
          ),
          hitCount: Math.max(0, Number(monitorResult?.hitCount) || 0),
          filteredCount: Math.max(
            0,
            Number(monitorResult?.filteredCount) || 0,
          ),
          unknownPublishTimeCount: Math.max(
            0,
            Number(monitorResult?.unknownPublishTimeCount) || 0,
          ),
          publishWindowLabel: String(
            monitorResult?.publishWindowLabel || "",
          ),
          ...(monitorStatus === "failed"
            ? {
                error: cloudTargetedPostApi.projectCaptureFailure(
                  [monitorResult?.error, monitorResult],
                  {
                    fallbackCode: "PROFILE_SCAN_FAILED",
                    stage: "profile_scan",
                    fallbackMessage: "账号作品扫描失败",
                  },
                ),
              }
            : {}),
        };
      } else {
        batchResult = await batchCaptureByUrls({
          urls: [target.url],
          mode: "single",
          runnerTabId: targetTabId,
          captureParams: {
            detectUnavailableTargetPage:
              [
                "negative_post_patrol",
                "watched_content_patrol",
              ].includes(targetedWorkflow),
            includeComments: captureSettings.includeComments === true,
            includeBloggerMetrics:
              captureSettings.includeBloggerMetrics === true,
            enableCommentLeadsFilter:
              captureSettings.enableCommentLeadsFilter === true,
            commentsMaxDetectedItems:
              captureSettings.commentsMaxDetectedItems || 50,
          },
          onProgress: (progress = {}) => {
            if (!isActiveTargetedPostInvocation(invocationToken)) {
              return;
            }
            const displayedToken =
              getTargetedPostInvocationTokenFromRequest(
                targetedPostRunState,
              );
            if (
              displayedToken &&
              !isSameTargetedPostInvocationToken(
                displayedToken,
                invocationToken,
              )
            ) {
              return;
            }
            const rawPhase = String(progress.phase || "capturing");
            const nextProgress = {
              ...(request?.progress && typeof request.progress === "object"
                ? request.progress
                : {}),
              current: Number(target.ordinal) || targetResults.length + 1,
              total: request.targets.length,
              itemId: target.itemId,
              recordId: target.recordId,
              title: target.title,
              url: target.url,
              targetTabId,
              phase: rawPhase.startsWith("target_")
                ? rawPhase
                : `target_${rawPhase}`,
              businessOutcome: String(progress.businessOutcome || ""),
              message: String(
                progress.message ||
                  `正在采集第 ${target.ordinal}/${request.targets.length} 条指定作品`,
              ),
              updatedAt: new Date().toISOString(),
            };
            targetedPostRunState = cloudTargetedPostApi.mergeRunPatch(
              targetedPostRunState || request,
              {
                progress: nextProgress,
                message: nextProgress.message,
              },
            );
            queueTargetedBusinessProgress(
              nextProgress,
              nextProgress.message,
            );
            renderCaptureDebugSession(getCurrentRuntime() || {});
          },
          shouldStop,
        });
        if (!isActiveTargetedPostInvocation(invocationToken)) {
          throw createTargetedPostInvocationError();
        }
        const localRecordIds = collectTargetedPostRecordIds(batchResult);
        const localRecords = await getRecords(localRecordIds);
        targetResult = cloudTargetedPostApi.buildTargetResult({
          target,
          batchResult,
          records: localRecords,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        if (
          ["completed", "completed_with_warnings"].includes(
            String(targetResult?.status || ""),
          ) &&
          targetResult?.businessOutcome !== "post_unavailable"
        ) {
          if (captureSettings.autoSyncAfterDetailCapture === false) {
            targetResult = cloudTargetedPostApi.applySyncResult(targetResult, {
              ok: false,
              successCount: 0,
              failedCount: targetResult.recordIds?.length || 0,
              pausedCount: 0,
              error: {
                code: "TARGET_SYNC_DISABLED",
                message: "定向作品已在本地采集，但任务未启用后台同步",
              },
            });
          } else {
            let syncResult = null;
            let syncError = null;
            try {
              syncResult = await syncRecordBatch(
                Array.isArray(targetResult.recordIds)
                  ? targetResult.recordIds
                  : [],
                null,
                {
                  trigger: targetedWorkflow,
                  syncScope: "all",
                  captureTaskId: String(request.taskId || request.id || ""),
                  captureTaskItemAttemptId: String(
                    target.captureTaskItemAttemptId || "",
                  ).trim(),
                  captureTaskItemRequestHash: String(
                    target.captureTaskItemRequestHash || "",
                  ).trim(),
                  captureSettings: {
                    ...captureSettings,
                    autoSyncAfterDetailCapture: true,
                  },
                  commentLeadsConfig:
                    buildCommentLeadsConfigFromSettings(captureSettings),
                  shouldStop,
                },
              );
            } catch (error) {
              syncError = error;
            }
            targetResult = cloudTargetedPostApi.applySyncResult(
              targetResult,
              syncResult,
              syncError,
            );
          }
        }
      }
      await flushTargetedBusinessProgress();
      if (!isActiveTargetedPostInvocation(invocationToken)) {
        throw createTargetedPostInvocationError();
      }
      targetResults.push(targetResult);
      const canceled =
        shouldStop() ||
        batchResult?.canceled ||
        targetResult.status === "canceled";
      request = await updateTargetedPostRun(request, {
        status: canceled ? "cancel_requested" : "running",
        cancelRequested: canceled,
        heartbeatAt: new Date().toISOString(),
        targetResults,
        progress: {
          current: targetResults.length,
          total: request.targets.length,
          itemId: target.itemId,
          recordId: target.recordId,
          title: target.title,
          url: target.url,
          targetTabId,
          businessOutcome: String(targetResult?.businessOutcome || ""),
          availabilityStatus: String(
            targetResult?.availabilityStatus || "",
          ),
          phase: canceled
            ? "target_canceling"
            : targetResult?.businessOutcome === "post_unavailable"
              ? "target_unavailable"
              : "target_settled",
        },
        message: canceled
          ? `${workflowLabel}正在停止并保留已有结果`
          : targetResult?.businessOutcome === "post_unavailable"
            ? `第 ${target.ordinal}/${request.targets.length} 条帖子已确认删除或不可用`
            : isProfileDiscovery
              ? `第 ${target.ordinal}/${request.targets.length} 个账号扫描已收口`
              : `第 ${target.ordinal}/${request.targets.length} 条指定作品已收口`,
      }, invocationToken);
      targetResults = Array.isArray(request.targetResults)
        ? request.targetResults.slice()
        : targetResults;
      if (canceled) break;
    }

    if (!isActiveTargetedPostInvocation(invocationToken)) {
      throw createTargetedPostInvocationError();
    }
    const checkpoint = cloudTargetedPostApi.buildCheckpoint(
      request.targets,
      targetResults,
    );
    const canceled = shouldStop() || request.cancelRequested === true;
    const finalStatus = canceled
      ? "canceled"
      : checkpoint.failedCount === 0 && checkpoint.warningCount === 0
        ? "completed"
        : checkpoint.successCount > 0 || checkpoint.warningCount > 0
          ? "completed_with_warnings"
          : "failed";
    stopTargetedPostHeartbeat();
    await flushTargetedBusinessProgress();
    request = await updateTargetedPostRun(request, {
      status: finalStatus,
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      targetResults,
      progress: {
        current: checkpoint.processedCount,
        total: checkpoint.total,
        phase: finalStatus,
        targetedPost: true,
        workflow: targetedWorkflow,
        completedTargetCount: checkpoint.capturedCount,
        unavailableTargetCount: checkpoint.unavailableCount,
        failedTargetCount: checkpoint.failedCount,
      },
      message:
        isProfileDiscovery && finalStatus === "completed"
          ? `${workflowLabel}完成：已扫描 ${checkpoint.capturedCount} 个账号`
          : isProfileDiscovery && finalStatus === "completed_with_warnings"
            ? `${workflowLabel}部分完成：成功 ${checkpoint.capturedCount} 个，失败 ${checkpoint.failedCount} 个`
            : finalStatus === "completed"
              ? `${workflowLabel}完成：采集 ${checkpoint.capturedCount} 条，已删除或不可用 ${checkpoint.unavailableCount} 条`
              : finalStatus === "completed_with_warnings"
                ? `${workflowLabel}部分完成：采集 ${checkpoint.capturedCount} 条，已删除或不可用 ${checkpoint.unavailableCount} 条，警告 ${checkpoint.warningCount} 条，失败 ${checkpoint.failedCount} 条`
            : finalStatus === "canceled"
              ? `${workflowLabel}已停止，已保留 ${checkpoint.processedCount} 条结果`
              : `${workflowLabel}失败，共 ${checkpoint.failedCount} 条`,
    }, invocationToken);
    await refreshDataPool();
  } catch (error) {
    stopTargetedPostHeartbeat();
    await flushTargetedBusinessProgress();
    console.error("[Sidebar] Targeted post workflow failed:", error);
    const staleInvocation =
      String(error?.code || "") === "stale_targeted_post_attempt" ||
      !isActiveTargetedPostInvocation(invocationToken);
    if (
      !staleInvocation &&
      request &&
      !cloudTargetedPostApi.isTerminalRunStatus(request.status)
    ) {
      try {
        await updateTargetedPostRun(request, {
          status:
            shouldStop() || error?.code === "TARGET_CAPTURE_CANCELED"
              ? "canceled"
              : "failed",
          finishedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          message:
            shouldStop() || error?.code === "TARGET_CAPTURE_CANCELED"
              ? `${workflowLabel}已停止并保留已有结果`
              : String(error?.message || `${workflowLabel}失败`),
          error: {
            code: String(error?.code || "TARGET_CAPTURE_FAILED"),
            message: String(error?.message || "定向作品采集失败").slice(
              0,
              1000,
            ),
            retryable:
              ![
                "TARGET_IDENTITY_MISMATCH",
                "TARGET_URL_NOT_ALLOWED",
              ].includes(String(error?.code || "")),
          },
        }, invocationToken);
      } catch (reportError) {
        console.error(
          "[Sidebar] Targeted post terminal report failed:",
          reportError,
        );
      }
    }
  } finally {
    stopTargetedPostHeartbeat();
    if (targetedBusinessProgressTimer !== null) {
      clearTimeout(targetedBusinessProgressTimer);
      targetedBusinessProgressTimer = null;
    }
    const cleanupOwnership =
      getTargetedPostInvocationOwnership(invocationToken);
    if (
      cleanupOwnership.active &&
      cleanupOwnership.runnerTab &&
      (await confirmTargetedPostInvocationBinding(invocationToken).catch(
        () => false,
      ))
    ) {
      await settleTargetedPostRunnerTab(targetTabId, request?.platform, {
        returnHome: String(request?.status || "") !== "needs_action",
      });
    }
    const latestOwnership =
      getTargetedPostInvocationOwnership(invocationToken);
    if (latestOwnership.batch) {
      batchUrlCaptureInFlight = false;
      batchUrlCaptureMode = "";
      batchUrlCancelRequested = false;
      targetedPostBatchStateOwnerToken = null;
    }
    if (latestOwnership.runnerTab) {
      activeBatchRunnerTabId = null;
      targetedPostRunnerTabOwnerToken = null;
    }
    if (latestOwnership.run) {
      targetedPostCancelRequested = false;
      targetedPostRunInFlight = false;
      targetedPostRunInFlightOwnerToken = null;
    }
    if (latestOwnership.active) {
      activeTargetedPostInvocationToken = null;
    }
    if (executionLock) {
      await releaseCaptureExecutionLock(executionLock.id);
    }
  }
}

async function maybeClaimAndRunUnattendedKeywordPlan({allowPending = false} = {}) {
  if (getTargetedPostRunRequestIdFromUrl()) {
    return;
  }
  const requestId = getUnattendedRunRequestIdFromUrl();
  const requestAttemptId = getUnattendedRunAttemptIdFromUrl();
  if (!requestId && !allowPending) {
    return;
  }
  if (!requestId && (batchKeywordCaptureInFlight || batchUrlCaptureInFlight)) {
    return;
  }

  let stopHeartbeat = () => {};
  let claimedRequestId = requestId;
  let claimedAttemptId = "";
  let claimedAdoptedLockId = "";
  let claimedExecutionCopy = getKeywordExecutionCopy();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "onstarvoice:claim-unattended-keyword-run",
      requestId,
      attemptId: requestAttemptId,
      holderId: CAPTURE_EXECUTION_LOCK_HOLDER_ID,
    });
    if (
      response?.accepted === false &&
      response?.reason === "previous_capture_stop_unconfirmed"
    ) {
      if (response.lock) {
        adoptUnattendedCaptureExecutionLock(response.lock);
      }
      showMessage(
        "旧采集页面未能安全停止，已阻止自动继续；请在任务中心取消任务或检查页面后重试",
        "error",
      );
      return;
    }
    if (
      response?.accepted === false &&
      response?.reason === "capture_lock_conflict"
    ) {
      claimedExecutionCopy = getKeywordExecutionCopy(response?.data || {});
      showMessage(
        `其他采集任务已占用执行锁，${claimedExecutionCopy.taskLabel}恢复已暂停；请等待当前任务结束后从任务中心重试`,
        "warning",
      );
      return;
    }
    if (!response?.ok || response?.accepted === false || !response.data) {
      if (requestId) {
        showMessage("未找到可执行的采集任务", "warning");
      }
      return;
    }
    claimedExecutionCopy = getKeywordExecutionCopy(response.data);
    claimedRequestId = String(response.data.id || requestId || "").trim();
    claimedAttemptId = String(response.data?.attemptId || "").trim();
    activateUnattendedRunRequest(response.data);
    if (response.lock && adoptUnattendedCaptureExecutionLock(response.lock)) {
      claimedAdoptedLockId = String(response.lock.id || "").trim();
    }
    stopHeartbeat = startUnattendedKeywordRunHeartbeat(
      claimedRequestId,
      claimedAttemptId,
    );
    const ready = await waitForUnattendedProtectedStart(response.data, {
      round: response.data?.checkpoint?.round,
    });
    if (!ready) {
      return;
    }
    await runUnattendedKeywordPlanRequest(response.data);
  } catch (error) {
    console.error("[Sidebar] Claim unattended keyword run failed:", error);
    if (
      !activeUnattendedAttemptRejected &&
      !error?.unattendedTerminalReported
    ) {
      showMessage(
        `启动${claimedExecutionCopy.taskLabel}失败: ${error.message}`,
        "error",
      );
      await reportUnattendedTerminalRun(
        claimedRequestId,
        {
          status: "failed",
          finishedAt: new Date().toISOString(),
          message: error.message,
          error: {
            message: error.message,
          },
        },
        {attemptId: claimedAttemptId},
      );
    }
  } finally {
    stopHeartbeat();
    clearActiveUnattendedRunRequest(claimedRequestId, claimedAttemptId);
    if (
      claimedAdoptedLockId &&
      activeCaptureExecutionLockId === claimedAdoptedLockId
    ) {
      await releaseCaptureExecutionLock(claimedAdoptedLockId);
    }
    // Closure is a separate, fail-closed phase after terminal persistence,
    // task-session cleanup and lock release. Drain this attempt's durable
    // checkpoints before asking background to close the exact task runner and
    // attest that no task-owned browser resource remains.
    await flushPendingUnattendedCheckpointReports({quiet: true}).catch(
      () => null,
    );
    await sendUnattendedRuntimeMessage({
      type: "onstarvoice:finalize-unattended-local-closure",
      requestId: claimedRequestId,
      attemptId: claimedAttemptId,
    }).catch(() => null);
  }
}

async function returnUnattendedAgentToCooldownHome({
  tabId = null,
  platform = "",
} = {}) {
  const normalizedTabId = Number(tabId);
  const normalizedPlatform = String(platform || "").trim().toLowerCase();
  const homeUrl =
    UNATTENDED_AGENT_COOLDOWN_HOME_URLS[normalizedPlatform] || "";
  if (
    !Number.isSafeInteger(normalizedTabId) ||
    normalizedTabId <= 0 ||
    !homeUrl
  ) {
    return {ok: false, homeUrl, reason: "cooldown_home_unavailable"};
  }
  try {
    await chrome.tabs.update(normalizedTabId, {
      url: homeUrl,
      active: true,
    });
    return {ok: true, homeUrl, reason: "cooldown_home_opened"};
  } catch (error) {
    console.warn("[Sidebar] Restore unattended cooldown home failed:", error);
    return {
      ok: false,
      homeUrl,
      reason: "cooldown_home_navigation_failed",
      message: String(error?.message || error || "页面导航失败"),
    };
  }
}

function buildSidebarKeywordSearchUrl(keyword, platform, baseSearchUrl = "") {
  const encodedKeyword = encodeURIComponent(keyword);
  if (platform === "douyin") {
    return `https://www.douyin.com/search/${encodedKeyword}?type=general`;
  }
  if (platform === "weibo") {
    return `https://s.weibo.com/weibo?q=${encodedKeyword}`;
  }

  const xhsDefaultSearchUrl = new URL("https://www.xiaohongshu.com/search_result");
  xhsDefaultSearchUrl.searchParams.set("source", "web_explore_feed");
  xhsDefaultSearchUrl.searchParams.set("type", "51");
  if (baseSearchUrl) {
    try {
      const parsed = new URL(baseSearchUrl);
      const pathname = String(parsed.pathname || "").toLowerCase();
      const isXhsSearchPath =
        pathname.includes("/search_result") ||
        pathname.includes("/web/search_result") ||
        pathname.includes("/search/result");
      if (isXhsSearchPath) {
        parsed.searchParams.set("keyword", keyword);
        return parsed.toString();
      }
      const nextSearchUrl = new URL(xhsDefaultSearchUrl.toString());
      const source = String(parsed.searchParams.get("source") || "").trim();
      const type = String(parsed.searchParams.get("type") || "").trim();
      if (source) nextSearchUrl.searchParams.set("source", source);
      if (type) nextSearchUrl.searchParams.set("type", type);
      nextSearchUrl.searchParams.set("keyword", keyword);
      return nextSearchUrl.toString();
    } catch {
      // fallback below
    }
  }
  xhsDefaultSearchUrl.searchParams.set("keyword", keyword);
  return xhsDefaultSearchUrl.toString();
}

async function waitForActiveTabReady(
  tabId,
  timeoutMs = 15000,
  {
    windowId = null,
    platform = "",
    expectedUrl = "",
    expectedKeyword = "",
    shouldStop = null,
  } = {},
) {
  const startedAt = Date.now();
  let currentTabId = Number(tabId);
  const normalizedExpectedUrl = String(expectedUrl || "").trim();
  const expectedPlatform = String(
    platform || detectPlatformFromUrl(normalizedExpectedUrl) || "",
  )
    .trim()
    .toLowerCase();
  const normalizedExpectedKeyword = String(expectedKeyword || "").trim();
  const matchesExpectedSearch = (tab) => {
    const tabUrl = String(tab?.url || "").trim();
    if (!tabUrl) return false;
    if (
      expectedPlatform &&
      detectPlatformFromUrl(tabUrl) !== expectedPlatform
    ) {
      return false;
    }
    if (!normalizedExpectedKeyword) {
      return !normalizedExpectedUrl || tabUrl === normalizedExpectedUrl;
    }
    try {
      return decodeURIComponent(tabUrl.replace(/\+/gu, "%20")).includes(
        normalizedExpectedKeyword,
      );
    } catch {
      return tabUrl.includes(encodeURIComponent(normalizedExpectedKeyword));
    }
  };
  while (Date.now() - startedAt < timeoutMs) {
    if (typeof shouldStop === "function" && shouldStop()) {
      const error = new Error("无人值守搜索页恢复已取消");
      error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
      throw error;
    }
    try {
      const tab = await chrome.tabs.get(currentTabId);
      if (
        String(tab?.status || "") === "complete" &&
        matchesExpectedSearch(tab)
      ) {
        if (typeof shouldStop === "function" && shouldStop()) {
          const error = new Error("无人值守搜索页恢复已取消");
          error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
          throw error;
        }
        return {ready: true, tabId: Number(tab.id), tab};
      }
    } catch (error) {
      if (error?.code === "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED") {
        throw error;
      }
      const query = {active: true};
      if (Number.isFinite(Number(windowId)) && Number(windowId) >= 0) {
        query.windowId = Number(windowId);
      } else {
        query.currentWindow = true;
      }
      const candidates = await chrome.tabs.query(query).catch(() => []);
      const replacement = candidates.find(
        (tab) =>
          tab?.id &&
          (!expectedPlatform ||
            detectPlatformFromUrl(tab?.url || "") === expectedPlatform),
      );
      if (
        replacement?.id &&
        String(replacement.status || "") === "complete" &&
        matchesExpectedSearch(replacement)
      ) {
        const replacementTabId = Number(replacement.id);
        if (typeof shouldStop === "function" && shouldStop()) {
          const error = new Error("无人值守搜索页恢复已取消");
          error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
          throw error;
        }
        return {
          ready: true,
          tabId: replacementTabId,
          tab: replacement,
          replaced: replacementTabId !== Number(tabId),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return {ready: false, tabId: currentTabId, tab: null};
}

async function waitForRuntimeSearchPage({
  platform = "",
  tabId = null,
  expectedUrl = "",
  expectedKeyword = "",
  timeoutMs = 8000,
  shouldStop = null,
} = {}) {
  const startedAt = Date.now();
  const expectedTabId = Number(tabId);
  const normalizedExpectedKeyword = String(expectedKeyword || "").trim();
  const normalizedExpectedUrl = String(expectedUrl || "").trim();
  while (Date.now() - startedAt < timeoutMs) {
    if (typeof shouldStop === "function" && shouldStop()) {
      const error = new Error("无人值守搜索页恢复已取消");
      error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
      throw error;
    }
    const runtime = getCurrentRuntime();
    const runtimeUrl = String(runtime?.lastPageUrl || "");
    let keywordMatches = !normalizedExpectedKeyword;
    if (!keywordMatches) {
      try {
        keywordMatches = decodeURIComponent(
          runtimeUrl.replace(/\+/gu, "%20"),
        ).includes(normalizedExpectedKeyword);
      } catch {
        keywordMatches = runtimeUrl.includes(
          encodeURIComponent(normalizedExpectedKeyword),
        );
      }
    } else if (normalizedExpectedUrl) {
      keywordMatches = runtimeUrl === normalizedExpectedUrl;
    }
    if (
      getPagePlatform(runtime) === platform &&
      runtime?.pageType === PAGE_TYPE.SEARCH_RESULTS &&
      (!Number.isFinite(expectedTabId) ||
        expectedTabId <= 0 ||
        Number(runtime?.lastActiveTabId) === expectedTabId) &&
      keywordMatches
    ) {
      if (typeof shouldStop === "function" && shouldStop()) {
        const error = new Error("无人值守搜索页恢复已取消");
        error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
        throw error;
      }
      return true;
    }
    // 平台页面在慢加载时，全局 runtime 可能晚于已绑定标签页更新。
    // 直接核验任务绑定的 tab，只接受“正确搜索词 + 搜索页骨架已出现”；
    // 结果卡片由后续的长等待检查负责，这里不因结果还在加载而刷新页面。
    if (
      (platform === "douyin" || platform === "xiaohongshu") &&
      Number.isFinite(expectedTabId) &&
      expectedTabId > 0
    ) {
      const boundTabReady = await chrome.scripting
        .executeScript({
          target: {tabId: expectedTabId},
          args: [normalizedExpectedKeyword, platform],
          func: (expectedKeywordValue, expectedPlatform) => {
            const normalize = (value) =>
              String(value || "")
                .trim()
                .toLowerCase()
                .replace(/\s+/gu, "");
            const decode = (value) => {
              try {
                return decodeURIComponent(String(value || ""));
              } catch {
                return String(value || "");
              }
            };
            const expected = normalize(expectedKeywordValue);
            const url = new URL(window.location.href);
            const hostname = String(url.hostname || "").toLowerCase();
            const pathname = String(url.pathname || "");
            if (expectedPlatform === "xiaohongshu") {
              const queryKeyword = decode(
                url.searchParams.get("keyword") ||
                  url.searchParams.get("q") ||
                  "",
              );
              const inputKeyword =
                Array.from(
                  document.querySelectorAll(
                    'input[type="search"], input[placeholder*="搜索"], input.search-input',
                  ),
                )
                  .map((node) => node.value || node.textContent || "")
                  .map((value) => String(value || "").trim())
                  .find(Boolean) || "";
              const keywordMatched =
                Boolean(expected) &&
                (normalize(queryKeyword) === expected ||
                  normalize(inputKeyword).includes(expected));
              const bodyText = String(document.body?.innerText || "");
              const hasSearchShell = Boolean(
                document.querySelector(
                  '.feeds-container, section.note-item, .note-item, [class*="feeds"]',
                ) ||
                  (/全部/u.test(bodyText) &&
                    /图文/u.test(bodyText) &&
                    /视频/u.test(bodyText)),
              );
              return Boolean(
                (hostname === "xiaohongshu.com" ||
                  hostname.endsWith(".xiaohongshu.com")) &&
                  (pathname === "/search_result" ||
                    pathname === "/web/search_result") &&
                  document.readyState !== "loading" &&
                  keywordMatched &&
                  hasSearchShell,
              );
            }
            const urlKeyword = decode(
              pathname.split("/search/")[1]?.split("/")[0] || "",
            );
            const inputKeyword =
              Array.from(
                document.querySelectorAll(
                  '[data-e2e="searchbar-input"], input[type="search"], input[placeholder*="搜索"]',
                ),
              )
                .map((node) => node.value || node.textContent || "")
                .map((value) => String(value || "").trim())
                .find(Boolean) || "";
            const keywordMatched =
              Boolean(expected) &&
              (normalize(urlKeyword) === expected ||
                normalize(inputKeyword).includes(expected));
            const bodyText = String(document.body?.innerText || "");
            const hasSearchShell = Boolean(
              document.querySelector(
                '[data-e2e="searchbar-input"], #search-result-container, #waterFallScrollContainer, [data-e2e="scroll-list"]',
              ) || (/综合/u.test(bodyText) && /视频|用户|直播/u.test(bodyText)),
            );
            return Boolean(
              (hostname === "douyin.com" ||
                hostname.endsWith(".douyin.com")) &&
                pathname.startsWith("/search/") &&
                document.readyState !== "loading" &&
                keywordMatched &&
                hasSearchShell,
            );
          },
        })
        .then(([result]) => Boolean(result?.result))
        .catch(() => false);
      if (boundTabReady) {
        if (typeof shouldStop === "function" && shouldStop()) {
          const error = new Error("无人值守搜索页恢复已取消");
          error.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
          throw error;
        }
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function resolveUnattendedBootstrapStartGate(request = {}, now = Date.now()) {
  const orchestrationContext =
    request?.orchestrationContext &&
    typeof request.orchestrationContext === "object"
      ? request.orchestrationContext
      : {};
  if (orchestrationContext.distributionMode !== "elastic_pool") {
    return {delayed: false, waitMs: 0, waitUntil: "", reason: ""};
  }
  const notBeforeMs = Date.parse(
    String(orchestrationContext.bootstrapStartNotBefore || ""),
  );
  if (!Number.isFinite(notBeforeMs)) {
    return {delayed: false, waitMs: 0, waitUntil: "", reason: ""};
  }
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const waitMs = Math.min(
    UNATTENDED_BOOTSTRAP_GATE_MAX_WAIT_MS,
    Math.max(0, notBeforeMs - nowMs),
  );
  return {
    delayed: waitMs > 0,
    waitMs,
    waitUntil: new Date(nowMs + waitMs).toISOString(),
    reason: String(
      orchestrationContext.bootstrapPacingReason || "staggered_start",
    ).trim(),
  };
}

async function navigateActiveTabToKeywordSearchForPlan({
  keyword = "",
  platform = "xiaohongshu",
  baseSearchUrl = "",
  tabId = null,
  maxAttempts = UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS,
  retryDelaysMs = UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS,
  retryDelayMs = null,
  shouldStop = null,
  onAttempt = null,
  onRetry = null,
} = {}) {
  const searchUrl = buildSidebarKeywordSearchUrl(keyword, platform, baseSearchUrl);
  const boundedMaxAttempts = Math.max(
    1,
    Math.min(4, Math.floor(Number(maxAttempts) || 1)),
  );
  const resolveRetryDelayMs = (attempt) => {
    if (retryDelayMs !== null && retryDelayMs !== undefined) {
      return Math.max(0, Number(retryDelayMs) || 0);
    }
    const schedule = Array.isArray(retryDelaysMs)
      ? retryDelaysMs
      : UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS;
    return Math.max(
      0,
      Number(schedule[Math.max(0, attempt - 1)] ?? schedule.at(-1)) || 0,
    );
  };
  let preferredTabId =
    Number.isFinite(Number(tabId)) && Number(tabId) > 0
      ? Number(tabId)
      : null;
  const hasExplicitSourceTab = preferredTabId !== null;
  let preferredWindowId = null;
  let lastError = null;

  for (let attempt = 1; attempt <= boundedMaxAttempts; attempt += 1) {
    if (typeof shouldStop === "function" && shouldStop()) {
      const stoppedError = new Error("无人值守搜索页恢复已取消");
      stoppedError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
      throw stoppedError;
    }
    if (typeof onAttempt === "function") {
      await onAttempt({
        attempt,
        maxAttempts: boundedMaxAttempts,
        keyword,
        platform,
        tabId: preferredTabId,
      });
    }

    let targetTab = null;
    if (preferredTabId) {
      try {
        targetTab = await chrome.tabs.get(preferredTabId);
        if (Number.isFinite(Number(targetTab?.windowId))) {
          preferredWindowId = Number(targetTab.windowId);
        }
      } catch {
        targetTab = null;
      }
    }
    if (!targetTab?.id) {
      if (!hasExplicitSourceTab) {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        targetTab =
          activeTab &&
          (!platform || detectPlatformFromUrl(activeTab.url || "") === platform)
            ? activeTab
            : null;
      } else {
        const query = Number.isFinite(preferredWindowId)
          ? {windowId: preferredWindowId}
          : {currentWindow: true};
        const candidates = await chrome.tabs.query(query).catch(() => []);
        const platformCandidates = candidates.filter(
          (candidate) =>
            candidate?.id &&
            (!platform ||
              detectPlatformFromUrl(candidate.url || "") === platform),
        );
        const identityCandidate = platformCandidates.find((candidate) => {
          const candidateUrl = String(candidate?.url || "");
          if (!keyword) return candidateUrl === searchUrl;
          try {
            return decodeURIComponent(candidateUrl.replace(/\+/gu, "%20")).includes(
              keyword,
            );
          } catch {
            return candidateUrl.includes(encodeURIComponent(keyword));
          }
        });
        // 已绑定来源页时绝不能退回任意 active tab；即使同窗口里只剩一个
        // 同平台页，也必须先确认它就是当前任务的搜索页。
        targetTab = identityCandidate || null;
      }
    }

    if (!targetTab?.id) {
      lastError = new Error("未找到可用于无人值守采集的标签页");
    } else {
      const originalTargetTabId = Number(targetTab.id);
      preferredTabId = originalTargetTabId;
      if (Number.isFinite(Number(targetTab.windowId))) {
        preferredWindowId = Number(targetTab.windowId);
      }
      try {
        const [previousDocumentGeneration, douyinSearchTransition] =
          platform === "douyin"
            ? await Promise.all([
                readDouyinSearchDocumentGenerationInTab(originalTargetTabId),
                beginDouyinSearchResultTransitionInTab(
                  originalTargetTabId,
                  keyword,
                ),
              ])
            : [null, null];
        if (
          Number.isFinite(Number(targetTab.windowId)) &&
          Number(targetTab.windowId) >= 0
        ) {
          await chrome.windows.update(Number(targetTab.windowId), {
            focused: true,
          });
        }
        const updatedTab = await chrome.tabs.update(originalTargetTabId, {
          url: searchUrl,
          active: true,
        });
        if (updatedTab?.id) {
          targetTab = updatedTab;
          preferredTabId = Number(updatedTab.id);
        }
        const readyState = await waitForActiveTabReady(
          preferredTabId,
          platform === "douyin" ? 45000 : 15000,
          {
            windowId: targetTab.windowId,
            platform,
            expectedUrl: searchUrl,
            expectedKeyword: keyword,
            shouldStop,
          },
        );
        if (Number.isFinite(Number(readyState.tabId)) && Number(readyState.tabId) > 0) {
          preferredTabId = Number(readyState.tabId);
        }
        if (typeof shouldStop === "function" && shouldStop()) {
          const stoppedError = new Error("无人值守搜索页恢复已取消");
          stoppedError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
          throw stoppedError;
        }
        // Tab identity 都没通过时不再白等额外 8 秒；下一轮会强制重开同一搜索词。
        const isSearchRuntimeReady = readyState.ready
          ? await waitForRuntimeSearchPage({
              platform,
              tabId: preferredTabId,
              expectedUrl: searchUrl,
              expectedKeyword: keyword,
              timeoutMs: platform === "douyin" ? 15000 : 8000,
              shouldStop,
            })
          : false;
        if (readyState.ready && isSearchRuntimeReady) {
          if (typeof shouldStop === "function" && shouldStop()) {
            const stoppedError = new Error("无人值守搜索页恢复已取消");
            stoppedError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
            throw stoppedError;
          }
          const currentDocumentGeneration =
            platform === "douyin"
              ? await readDouyinSearchDocumentGenerationInTab(preferredTabId)
              : null;
          const navigationTransitionAccepted = Boolean(
            platform === "douyin" &&
              Number(previousDocumentGeneration?.timeOrigin) > 0 &&
              Number(currentDocumentGeneration?.timeOrigin) > 0 &&
              Number(previousDocumentGeneration.timeOrigin) !==
                Number(currentDocumentGeneration.timeOrigin) &&
              currentDocumentGeneration?.readyState === "complete",
          );
          const submitAccepted = Boolean(
            platform === "douyin" &&
              String(douyinSearchTransition?.submissionNonce || "").trim(),
          );
          if (
            platform === "douyin" &&
            !navigationTransitionAccepted &&
            !submitAccepted
          ) {
            const proofError = new Error(
              "抖音搜索页已打开，但无法确认这次搜索操作，已停止以免重复搜索或误采旧结果",
            );
            proofError.code = "UNATTENDED_SEARCH_BOOTSTRAP_PROOF_MISSING";
            throw proofError;
          }
          return {
            tabId: preferredTabId,
            tab: readyState.tab,
            replaced: preferredTabId !== originalTargetTabId,
            url: String(readyState.tab?.url || searchUrl),
            attemptCount: attempt,
            recovered: attempt > 1,
            initialSearchEvidence: {
              ready: true,
              keyword: String(keyword || "").trim(),
              platform,
              tabId: preferredTabId,
              pageUrl: String(readyState.tab?.url || searchUrl),
              baselineCaptured:
                douyinSearchTransition?.baselineCaptured === true,
              previousWorkIds: Array.isArray(
                douyinSearchTransition?.previousWorkIds,
              )
                ? douyinSearchTransition.previousWorkIds
                : [],
              submissionNonce: String(
                douyinSearchTransition?.submissionNonce || "",
              ).trim(),
              submitAccepted,
              navigationTransitionAccepted,
            },
          };
        }
        lastError = new Error("搜索结果页尚未就绪，无法启动无人值守采集");
      } catch (error) {
        if (
          error?.code === "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED" ||
          error?.code === "UNATTENDED_ATTEMPT_REPLACED"
        ) {
          throw error;
        }
        lastError = error;
      }
    }

    if (attempt >= boundedMaxAttempts) {
      break;
    }
    const nextRetryDelayMs = resolveRetryDelayMs(attempt);
    const waitUntil = new Date(Date.now() + nextRetryDelayMs).toISOString();
    if (typeof onRetry === "function") {
      await onRetry({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: boundedMaxAttempts,
        retryDelayMs: nextRetryDelayMs,
        waitUntil,
        keyword,
        platform,
        tabId: preferredTabId,
        error: lastError,
      });
    }
    if (typeof shouldStop === "function" && shouldStop()) {
      const stoppedError = new Error("无人值守搜索页恢复已取消");
      stoppedError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
      throw stoppedError;
    }
    await sleepWithStop(nextRetryDelayMs, shouldStop);
  }

  const error = new Error(
    lastError?.message || "搜索结果页尚未就绪，无法启动无人值守采集",
  );
  error.code = "UNATTENDED_SEARCH_BOOTSTRAP_FAILED";
  error.cause = lastError;
  error.attempts = boundedMaxAttempts;
  throw error;
}

function buildUnattendedTaskCounts(
  checkpoint = {},
  summary = summarizeUnattendedKeywordCheckpoint(checkpoint),
  overrides = {},
) {
  const settledCount = Array.isArray(checkpoint?.keywordResults)
    ? checkpoint.keywordResults.length
    : 0;
  const overrideTotal = Number(overrides.total);
  const total = Math.max(
    settledCount,
    Number.isFinite(overrideTotal) ? Math.floor(overrideTotal) : 0,
  );
  const overrideProcessed = Number(overrides.processed);
  const processed = Math.min(
    total,
    Math.max(
      0,
      Number.isFinite(overrideProcessed)
        ? Math.floor(overrideProcessed)
        : settledCount,
    ),
  );
  return {
    total,
    processed,
    saved: Math.max(0, Number(overrides.saved ?? summary.saved) || 0),
    success: Math.max(
      0,
      Number(overrides.success ?? summary.completed) || 0,
    ),
    failed: Math.max(0, Number(overrides.failed ?? summary.failed) || 0),
    skipped: Math.max(0, Number(overrides.skipped ?? summary.skipped) || 0),
    retried: Math.max(0, Number(overrides.retried ?? summary.retries) || 0),
    warnings: Math.max(0, Number(overrides.warnings ?? summary.partial) || 0),
  };
}

function buildUnattendedTerminalProgress({
  previousProgress = null,
  status = "completed",
  finishedAt = new Date().toISOString(),
  message = "无人值守采集已结束",
  summary = {},
  taskTotal = 0,
  keyword = "",
  keywords = [],
  roundTotal = 1,
  streamingSync = null,
  captureTaskId = "",
  requestId = "",
  attemptId = "",
  runStartedAt = "",
} = {}) {
  const previous =
    previousProgress && typeof previousProgress === "object"
      ? previousProgress
      : {};
  const completed = Math.max(0, Number(summary?.completed) || 0);
  const partial = Math.max(0, Number(summary?.partial) || 0);
  const failed = Math.max(0, Number(summary?.failed) || 0);
  const skipped = Math.max(0, Number(summary?.skipped) || 0);
  const processed = Math.min(
    Math.max(0, Number(taskTotal) || 0),
    completed + partial + failed + skipped,
  );
  const sync =
    streamingSync && typeof streamingSync === "object" ? streamingSync : {};
  const syncInteger = (value) =>
    Number.isSafeInteger(Number(value)) && Number(value) >= 0
      ? Number(value)
      : null;
  const streamingSyncEvidenceKnown = Boolean(
    streamingSync &&
      typeof streamingSync === "object" &&
      typeof sync.enabled === "boolean" &&
      sync.drainCompleted === true &&
      syncInteger(sync.enqueuedCount) !== null &&
      syncInteger(sync.processedCount) !== null &&
      syncInteger(sync.successCount) !== null &&
      syncInteger(sync.failedCount) !== null &&
      syncInteger(sync.skippedCount) !== null &&
      syncInteger(sync.pendingCount) !== null &&
      syncInteger(sync.activeCount) !== null &&
      syncInteger(sync.remainingCount) !== null &&
      syncInteger(sync.capturedUniqueCount) !== null &&
      syncInteger(sync.enqueuedUniqueCount) !== null &&
      syncInteger(sync.excludedUniqueCount) !== null &&
      syncInteger(sync.succeededUniqueCount) !== null &&
      typeof sync.blocked === "boolean" &&
      typeof sync.canceled === "boolean"
  );
  const capturedRecordCount = Math.max(0, Number(summary?.saved) || 0);
  return {
    ...previous,
    captureTaskId:
      String(captureTaskId || previous.captureTaskId || "").trim() ||
      (requestId ? `unattended-capture:${requestId}` : ""),
    unattendedRequestId: String(
      requestId || previous.unattendedRequestId || "",
    ),
    unattendedAttemptId: String(
      attemptId || previous.unattendedAttemptId || "",
    ),
    current: processed,
    total: Math.max(0, Number(taskTotal) || 0),
    keyword: String(keyword || previous.keyword || ""),
    keywordCurrent: processed,
    keywordTotal: Math.max(0, Number(taskTotal) || 0),
    itemCurrent: null,
    itemTotal: null,
    nextKeyword: "",
    progressScope: "terminal",
    phase: `unattended_${String(status || "completed").trim()}`,
    lastBusinessPhase: "streaming_sync_done",
    progressPercent: 100,
    remainingMs: 0,
    waitUntil: "",
    round: Math.max(1, Number(roundTotal) || 1),
    roundCurrent: Math.max(1, Number(roundTotal) || 1),
    roundTotal: Math.max(1, Number(roundTotal) || 1),
    runStartedAt: String(runStartedAt || previous.runStartedAt || ""),
    finishedAt: String(finishedAt || ""),
    message: String(message || "无人值守采集已结束"),
    keywordCompletedCount: completed,
    keywordPartialCount: partial,
    keywordFailedCount: failed,
    keywordSkippedCount: skipped,
    detailSuccessCount: Math.max(
      0,
      Number(previous.detailSuccessCount) || 0,
    ),
    detailFailedCount: Math.max(
      0,
      Number(previous.detailFailedCount) || 0,
    ),
    aiFilteredCount: Math.max(0, Number(previous.aiFilteredCount) || 0),
    noEnhancementCount: Math.max(
      0,
      Number(previous.noEnhancementCount) || 0,
    ),
    syncSuccessCount: Math.max(
      0,
      Number(sync.successCount ?? previous.syncSuccessCount) || 0,
    ),
    syncFailedCount: Math.max(
      0,
      Number(sync.failedCount ?? previous.syncFailedCount) || 0,
    ),
    syncSkippedCount: Math.max(
      0,
      Number(sync.skippedCount ?? previous.syncSkippedCount) || 0,
    ),
    syncRemainingCount: Math.max(
      0,
      Number(sync.remainingCount ?? previous.syncRemainingCount) || 0,
    ),
    // Closure evidence consumes only these explicit attempt-local fields. The
    // legacy sync* values above remain UI counters and may be defaulted for
    // backwards compatibility; they are intentionally not authoritative.
    streamingSyncEvidenceKnown,
    streamingSyncDrainCompleted:
      streamingSyncEvidenceKnown && sync.drainCompleted === true,
    streamingSyncEnabled:
      streamingSyncEvidenceKnown ? sync.enabled === true : null,
    streamingSyncEnqueuedCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.enqueuedCount) : null,
    streamingSyncProcessedCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.processedCount) : null,
    streamingSyncSuccessCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.successCount) : null,
    streamingSyncFailedCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.failedCount) : null,
    streamingSyncSkippedCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.skippedCount) : null,
    streamingSyncPendingCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.pendingCount) : null,
    streamingSyncActiveCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.activeCount) : null,
    streamingSyncRemainingCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.remainingCount) : null,
    streamingSyncCapturedUniqueCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.capturedUniqueCount) : null,
    streamingSyncEnqueuedUniqueCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.enqueuedUniqueCount) : null,
    streamingSyncExcludedUniqueCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.excludedUniqueCount) : null,
    streamingSyncSucceededUniqueCount:
      streamingSyncEvidenceKnown ? syncInteger(sync.succeededUniqueCount) : null,
    streamingSyncBlocked:
      streamingSyncEvidenceKnown ? sync.blocked === true : null,
    streamingSyncCanceled:
      streamingSyncEvidenceKnown ? sync.canceled === true : null,
    capturedRecordCount,
    updatedAt: String(finishedAt || new Date().toISOString()),
  };
}

function createUnattendedKeywordCheckpointReporter({
  requestId,
  attemptId = activeUnattendedRunAttemptId,
  checkpoint,
  keywords,
  taskTotal = 0,
} = {}) {
  const persist = async ({
    summary = null,
    message = "",
    waitUntil,
  } = {}) => {
    const checkpointSummary =
      summary || summarizeUnattendedKeywordCheckpoint(checkpoint);
    // Checkpoints participate in the same monotonic task fence as visible
    // progress. If this report is queued locally and a newer direct report is
    // accepted first, background will reject the old replay as stale_progress
    // instead of letting it roll the durable checkpoint backwards.
    activeUnattendedProgressSeq += 1;
    const checkpointProgressSeq = activeUnattendedProgressSeq;
    let reportResult = null;
    for (const delayMs of [0, 300, 900]) {
      if (delayMs > 0) await sleep(delayMs);
      const reportPatch = {
        checkpoint: {
          ...checkpoint,
          keywordResults: checkpoint.keywordResults.map((entry) => ({...entry})),
        },
        summary: checkpointSummary,
        counts: buildUnattendedTaskCounts(checkpoint, checkpointSummary, {
          total: taskTotal,
        }),
        message,
        progressSeq: checkpointProgressSeq,
        businessProgressAt: checkpoint.updatedAt,
      };
      if (waitUntil !== undefined) {
        reportPatch.waitUntil = String(waitUntil || "");
      }
      reportResult = await reportUnattendedKeywordRun(
        requestId,
        reportPatch,
        {attemptId, durableCheckpoint: true},
      );
      if (
        reportResult?.accepted ||
        reportResult?.reason === "attempt_mismatch" ||
        reportResult?.reason === "terminal"
      ) {
        break;
      }
    }
    if (!reportResult?.accepted) {
      const error = new Error(
        reportResult?.reason === "attempt_mismatch"
          ? "当前执行已被新的恢复任务接管"
          : "无法保存无人值守检查点，已停止继续执行",
      );
      error.code =
        reportResult?.reason === "attempt_mismatch"
          ? "UNATTENDED_ATTEMPT_REPLACED"
          : "UNATTENDED_CHECKPOINT_WRITE_FAILED";
      throw error;
    }
    return reportResult;
  };

  const reportSettled = async ({
    round = 1,
    originalIndex = 0,
    keyword = "",
    result = {},
    recordIds = [],
    attempt = 1,
    maxAttempts = UNATTENDED_KEYWORD_MAX_ATTEMPTS,
    securityBlocked = false,
    canceled = false,
  } = {}) => {
    const normalizedKeyword = String(keyword || "").trim();
    if (!normalizedKeyword) {
      return;
    }
    const settled = settleUnattendedKeywordCheckpoint({
      checkpoint,
      keywords,
      round,
      originalIndex,
      keyword: normalizedKeyword,
      result,
      recordIds,
      attempt,
      maxAttempts,
      securityBlocked,
      canceled,
    });
    Object.assign(checkpoint, settled.checkpoint);
    const status = settled.entry?.status || "failed";
    const summary = settled.summary;
    await persist({
      summary,
      message:
        status === "completed"
          ? `已保存关键词「${normalizedKeyword}」的任务检查点`
          : status === "retrying"
            ? `关键词「${normalizedKeyword}」暂时失败，准备有界重试`
            : `关键词「${normalizedKeyword}」已收口为${status === "partial" ? "部分完成" : "失败"}`,
    });
  };
  reportSettled.persist = persist;
  return reportSettled;
}

async function runUnattendedKeywordPlanRequest(request) {
  const requestId = String(request?.id || "").trim();
  const requestAttemptId = String(request?.attemptId || "").trim();
  const executionCopy = getKeywordExecutionCopy(request);
  const executionMode = executionCopy.executionMode;
  const isCurrentRequestAttempt = () =>
    requestId === String(activeUnattendedRunRequestId || "").trim() &&
    (!requestAttemptId ||
      requestAttemptId ===
        String(activeUnattendedRunAttemptId || "").trim());
  const plan = request?.planSnapshot || {};
  // The single-relay contract limits complete business runs, not technical
  // page/session recovery inside one run. Under shared-machine or weak-network
  // load those bounded recoveries remain necessary and do not duplicate the
  // keyword capture.
  const singleRelayMode =
    request?.cloudAssigned === true &&
    request?.orchestrationContext?.distributionMode === "elastic_pool" &&
    plan.recoveryPolicy?.singleRelayV1 === true &&
    plan.recoveryPolicy?.disableAutomaticSearchRetry === true;
  const localKeywordMaxAttempts = singleRelayMode
    ? 1
    : UNATTENDED_KEYWORD_MAX_ATTEMPTS;
  const localBootstrapMaxAttempts = UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS;
  const localCaptureSessionMaxAttempts =
    UNATTENDED_CAPTURE_SESSION_MAX_ATTEMPTS;
  const keywords = dedupeKeywords(
    Array.isArray(plan.keywords) ? plan.keywords : [],
  ).slice(0, MAX_BATCH_KEYWORDS);
  const platform = String(plan.platform || "xiaohongshu").trim();
  const searchPasses = normalizeUnattendedSearchPasses(plan);
  const sequentialSearchEnabled =
    platform === "douyin" && searchPasses.length > 1;
  const captureTaskDebugSupported =
    supportsPersistentCaptureTaskPlatform(platform);
  const plannedRounds = sequentialSearchEnabled
    ? searchPasses.length
    : Math.max(1, Number(plan.maxRounds) || 1);
  const plannedTaskTotal = keywords.length * plannedRounds;
  const checkpoint = normalizeUnattendedKeywordCheckpoint(request, keywords, {
    maxRounds: plannedRounds,
  });
  let resumeKeyword = findUnattendedResumeKeyword(checkpoint, keywords);
  let unattendedCaptureTaskContext = null;
  let unattendedCaptureTaskSessionStarted = false;
  let unattendedCaptureTaskStatus = "failed";
  let unattendedCaptureTaskError = null;
  let reportKeywordProgress = null;
  let batchRunResult = null;
  let capturePipelineStarted = false;
  let unattendedCaptureTaskTerminalProgress = null;
  let unattendedSourceTabId = null;

  if (keywords.length === 0) {
    throw new Error(`${executionCopy.taskLabel}没有可执行关键词`);
  }
  if (!resumeKeyword && Math.max(1, Number(checkpoint.round) || 1) < plannedRounds) {
    // 兼容旧版本在「本轮完成、下一轮尚未落盘」窗口留下的检查点。
    // 以检查点/业务时钟中的较晚者作为保守间隔起点，避免崩溃窗口直接跳过
    // 防风控 roundGap；若已有显式 waitUntil，则沿用更晚的那个边界。
    const roundGapMs = Math.max(0, Number(plan.roundGapMin) || 0) * 60 * 1000;
    const checkpointUpdatedAt = Date.parse(String(checkpoint.updatedAt || ""));
    const businessProgressAt = Date.parse(String(request?.businessProgressAt || ""));
    const legacyWaitBase = Math.max(
      Number.isFinite(checkpointUpdatedAt) ? checkpointUpdatedAt : 0,
      Number.isFinite(businessProgressAt) ? businessProgressAt : 0,
    );
    const ready = await waitForUnattendedProtectedStart(request, {
      fallbackNotBeforeMs:
        legacyWaitBase > 0 && roundGapMs > 0
          ? legacyWaitBase + roundGapMs
          : 0,
      round: checkpoint.round,
    });
    if (!ready) return;
    // 等待边界确认后再推进恢复边界，避免恢复后重复上一轮或再次导航旧轮次。
    Object.assign(
      checkpoint,
      advanceUnattendedCheckpointRound({
        checkpoint,
        keywords,
        completedRound: checkpoint.round,
        maxRounds: plannedRounds,
      }),
    );
    resumeKeyword = findUnattendedResumeKeyword(checkpoint, keywords);
  }
  if (!resumeKeyword) {
    const summary = summarizeUnattendedKeywordCheckpoint(checkpoint);
    const status =
      summary.failed > 0 || summary.partial > 0
        ? "completed_with_failures"
        : "completed";
    const finishedAt = new Date().toISOString();
    const message =
      status === "completed"
        ? "检查点显示全部关键词均已完成，无需重复采集"
        : "检查点显示剩余关键词均已达到重试上限，已保留现有结果";
    await reportUnattendedTerminalRun(
      requestId,
      {
        status,
        finishedAt,
        checkpoint,
        summary,
        counts: buildUnattendedTaskCounts(checkpoint, summary, {
          total: plannedTaskTotal,
        }),
        message,
        progress: buildUnattendedTerminalProgress({
          previousProgress: request?.progress,
          status,
          finishedAt,
          message,
          summary,
          taskTotal: plannedTaskTotal,
          keyword: checkpoint.activeKeyword || "",
          keywords,
          roundTotal: plannedRounds,
          requestId,
          attemptId: requestAttemptId,
          runStartedAt: request?.startedAt || "",
        }),
      },
      {attemptId: requestAttemptId},
    );
    return;
  }
  if (batchKeywordCaptureInFlight || batchUrlCaptureInFlight) {
    throw new Error(
      `已有批量任务执行中，无法启动${executionCopy.taskLabel}`,
    );
  }

  const startingMessage =
    checkpoint.keywordResults.length > 0
      ? `${executionCopy.taskLabel}正在从关键词「${resumeKeyword}」恢复`
      : `${executionCopy.taskLabel}已触发，正在启动浏览器接管`;
  const startingKeywordIndex = Math.max(0, keywords.indexOf(resumeKeyword));
  const startingProgress = {
    unattendedRequestId: requestId,
    unattendedAttemptId: requestAttemptId,
    current: startingKeywordIndex + 1,
    total: keywords.length,
    keyword: resumeKeyword,
    keywordCurrent: startingKeywordIndex + 1,
    keywordTotal: keywords.length,
    itemCurrent: null,
    itemTotal: null,
    nextKeyword: keywords[startingKeywordIndex + 1] || "",
    progressScope: "keyword",
    round: Math.max(1, Number(checkpoint.round) || 1),
    roundCurrent: Math.max(1, Number(checkpoint.round) || 1),
    roundTotal: plannedRounds,
    phase: "initializing_unattended",
    message: startingMessage,
    executionMode,
    taskMeta: {
      keywordList: [...keywords],
      searchFilters: {...(plan.searchFilters || {})},
      ...(sequentialSearchEnabled ? {searchPasses: [...searchPasses]} : {}),
      executionMode,
      ...(Object.prototype.hasOwnProperty.call(
        plan,
        "keywordMaxDetectedItems",
      )
        ? {keywordMaxDetectedItems: plan.keywordMaxDetectedItems}
        : {}),
    },
  };
  const runStartedAt = new Date().toISOString();
  startingProgress.runStartedAt = runStartedAt;
  const createTerminalProgress = ({
    status,
    finishedAt,
    message,
    summary,
    streamingSync = null,
  }) => {
    unattendedCaptureTaskTerminalProgress = buildUnattendedTerminalProgress({
      previousProgress:
        reportKeywordProgress?.getSnapshot?.() || startingProgress,
      status,
      finishedAt,
      message,
      summary,
      taskTotal: plannedTaskTotal,
      keyword: checkpoint.activeKeyword || startingProgress.keyword,
      keywords,
      roundTotal: plannedRounds,
      streamingSync,
      captureTaskId: unattendedCaptureTaskContext?.taskId || "",
      requestId,
      attemptId: requestAttemptId,
      runStartedAt,
    });
    return unattendedCaptureTaskTerminalProgress;
  };
  if (!isCurrentRequestAttempt()) {
    const error = new Error("当前执行已被新的恢复任务接管");
    error.code = "UNATTENDED_ATTEMPT_REPLACED";
    throw error;
  }
  rememberCaptureTaskProgressContext(startingProgress);
  const startReport = await reportInitialUnattendedKeywordRun(
    requestId,
    {
      status: "running",
      startedAt: runStartedAt,
      checkpoint,
      counts: buildUnattendedTaskCounts(
        checkpoint,
        summarizeUnattendedKeywordCheckpoint(checkpoint),
        {total: plannedTaskTotal},
      ),
      message: startingMessage,
      progress: startingProgress,
    },
    {attemptId: requestAttemptId},
  );
  const startReportAlreadyApplied = Boolean(
    startReport?.reason === "stale_progress" &&
      String(startReport?.data?.id || "") === requestId &&
      String(startReport?.data?.attemptId || "") === requestAttemptId &&
      ["started", "running"].includes(
        String(startReport?.data?.status || ""),
      ),
  );
  if (!startReport?.accepted && !startReportAlreadyApplied) {
    const rejectionReason = String(startReport?.reason || "unknown");
    const replaced = ["attempt_mismatch", "terminal"].includes(
      rejectionReason,
    );
    const transportFailure = rejectionReason === "transport_error";
    const error = new Error(
      replaced
        ? `${executionCopy.taskLabel}已被新的恢复尝试接管`
        : transportFailure
          ? `${executionCopy.taskLabel}状态上报连续超时，尚未开始平台搜索`
          : `${executionCopy.taskLabel}状态上报被拒绝（${rejectionReason}）`,
    );
    error.code = replaced
      ? "UNATTENDED_ATTEMPT_REPLACED"
      : transportFailure
        ? "UNATTENDED_STATUS_REPORT_TIMEOUT"
        : rejectionReason === "not_found"
          ? "UNATTENDED_REQUEST_NOT_FOUND"
          : "UNATTENDED_STATUS_REPORT_REJECTED";
    error.details = {
      reportReason: rejectionReason,
      requestId,
      attemptId: requestAttemptId,
      platformSearchStarted: false,
    };
    throw error;
  }
  keywordPlanState = {
    ...(keywordPlanState && typeof keywordPlanState === "object"
      ? keywordPlanState
      : {}),
    ...plan,
    executionMode,
    enabled: true,
    lastRunStatus: "running",
    lastRunMessage: startingMessage,
    lastRunProgress: {
      ...startingProgress,
      updatedAt: new Date().toISOString(),
    },
  };
  renderCaptureDebugSession(getCurrentRuntime() || {});

  const reportAutomaticRecoveryStage = async ({
    phase,
    message,
    attemptCurrent = null,
    attemptTotal = null,
    waitUntil = "",
    remainingMs = null,
    retried = 0,
  }) => {
    const recoveryProgress = {
      ...startingProgress,
      phase,
      message,
      attempt: attemptCurrent,
      attemptCurrent,
      attemptTotal,
      maxAttempts: attemptTotal,
      waitUntil,
      remainingMs,
      phaseStartedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    rememberCaptureTaskProgressContext(recoveryProgress);
    showMessage(message, waitUntil ? "warning" : "info");
    return await reportUnattendedKeywordRun(
      requestId,
      {
        status: "running",
        waitUntil,
        checkpoint,
        counts: buildUnattendedTaskCounts(
          checkpoint,
          summarizeUnattendedKeywordCheckpoint(checkpoint),
          {
            total: plannedTaskTotal,
            retried,
          },
        ),
        message,
        progress: recoveryProgress,
      },
      {attemptId: requestAttemptId},
    );
  };

  try {
    const bootstrapGate = resolveUnattendedBootstrapStartGate(request);
    if (bootstrapGate.delayed) {
      const waitSeconds = Math.max(
        1,
        Math.ceil(bootstrapGate.waitMs / 1000),
      );
      await reportAutomaticRecoveryStage({
        phase: "waiting_bootstrap_slot",
        message:
          bootstrapGate.reason === "recent_technical_congestion"
            ? `检测到多个节点刚发生技术卡顿，${waitSeconds} 秒后错峰打开搜索页`
            : `正在错峰启动，${waitSeconds} 秒后打开搜索页`,
        waitUntil: bootstrapGate.waitUntil,
        remainingMs: bootstrapGate.waitMs,
      });
      await sleepWithStop(bootstrapGate.waitMs, () =>
        activeUnattendedAttemptRejected ||
        !isCurrentRequestAttempt() ||
        batchKeywordCancelRequested ||
        Boolean(activeCaptureTaskCancellationReason),
      );
      if (
        activeUnattendedAttemptRejected ||
        !isCurrentRequestAttempt() ||
        batchKeywordCancelRequested ||
        Boolean(activeCaptureTaskCancellationReason)
      ) {
        const canceledError = new Error("无人值守错峰启动已取消");
        canceledError.code = "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
        throw canceledError;
      }
    }

    let switchResult = null;
    try {
      switchResult = await chrome.runtime.sendMessage({
        type: "onstarvoice:switch-platform-tab",
        platform,
      });
      if (!switchResult?.ok) {
        throw new Error(
          switchResult?.error?.message || "打开平台页面失败，无法执行计划",
        );
      }
    } catch (error) {
      throw new Error(`打开平台页面失败：${error.message}`);
    }

    unattendedSourceTabId = await resolveCaptureTaskSourceTabId({
      preferredTabId: switchResult?.data?.tabId,
      platform,
    });
    unattendedCaptureTaskContext = beginTaskContext({
      taskType: "capture",
      featureKey: "capture.unattended_keyword",
      source: "unattended",
      metadata: {
        requestId,
        platform,
        keywordCount: keywords.length,
        executionMode,
      },
    });
    // 同一无人值守 request 跨 runner reload / recovery attempt 复用稳定的
    // Debug taskId。控制页只是观察与编排 UI，不再拥有任务生命周期。
    unattendedCaptureTaskContext.taskId = `unattended-capture:${requestId}`;
    const startUnattendedCaptureTaskSession = async (sourceTabId) => {
      let lastError = null;
      for (
        let attempt = 1;
        attempt <= localCaptureSessionMaxAttempts;
        attempt += 1
      ) {
        const attemptMessage =
          attempt === 1
            ? "正在建立浏览器采集接管"
            : `正在第 ${attempt}/${localCaptureSessionMaxAttempts} 次建立浏览器采集接管`;
        await reportAutomaticRecoveryStage({
          phase: "starting_capture_session",
          message: attemptMessage,
          attemptCurrent: attempt,
          attemptTotal: localCaptureSessionMaxAttempts,
          retried: Math.max(0, attempt - 1),
        });
        try {
          await startRequiredCaptureTaskSession({
            taskId: unattendedCaptureTaskContext.taskId,
            tabId: sourceTabId,
            label: `${executionCopy.captureLabel} · ${keywords.length} 个关键词`,
            platform,
            ownerRequired: false,
            attemptId: requestAttemptId,
          });
          unattendedCaptureTaskSessionStarted = true;
          return;
        } catch (error) {
          lastError = error;
          const code = String(error?.code || "").trim();
          const retryable = UNATTENDED_CAPTURE_SESSION_RETRYABLE_CODES.has(code);
          if (
            !retryable ||
            attempt >= localCaptureSessionMaxAttempts
          ) {
            break;
          }
          const delayMs = Math.max(
            0,
            Number(
              UNATTENDED_CAPTURE_SESSION_RETRY_DELAYS_MS[attempt - 1] ??
                UNATTENDED_CAPTURE_SESSION_RETRY_DELAYS_MS.at(-1),
            ) || 0,
          );
          const waitUntil = new Date(Date.now() + delayMs).toISOString();
          const nextAttempt = attempt + 1;
          const waitMessage = `浏览器采集资源暂时占用，第 ${nextAttempt}/${localCaptureSessionMaxAttempts} 次接管将在倒计时结束后开始`;
          await reportAutomaticRecoveryStage({
            phase: "waiting_capture_session_retry",
            message: waitMessage,
            attemptCurrent: nextAttempt,
            attemptTotal: localCaptureSessionMaxAttempts,
            waitUntil,
            remainingMs: delayMs,
            retried: attempt,
          });
          await sleepWithStop(delayMs, () =>
            activeUnattendedAttemptRejected ||
            !isCurrentRequestAttempt() ||
            batchKeywordCancelRequested ||
            Boolean(activeCaptureTaskCancellationReason),
          );
          if (
            activeUnattendedAttemptRejected ||
            !isCurrentRequestAttempt() ||
            batchKeywordCancelRequested ||
            Boolean(activeCaptureTaskCancellationReason)
          ) {
            const canceledError = new Error("无人值守浏览器接管恢复已取消");
            canceledError.code = "UNATTENDED_ATTEMPT_CANCELED";
            throw canceledError;
          }
        }
      }
      const code =
        String(lastError?.code || "").trim() ||
        "CAPTURE_TASK_START_FAILED";
      const message = String(
        lastError?.message || "无法启动浏览器 AI Debug 接管",
      ).trim();
      const startError = new Error(
        `AI Debug 启动失败（${code}）：${message}`,
      );
      startError.code = code;
      startError.cause = lastError;
      throw startError;
    };
    // 抖音首个 /jingxuan -> /search 导航可能触发 Chrome Tab replacement。
    // 先让合成状态页保持可见，等拿到 replacement 后的最终 Tab id 再建立
    // 原生 Debug；小红书仍保留原来的“导航前接管”时机。
    if (captureTaskDebugSupported && platform !== "douyin") {
      await startUnattendedCaptureTaskSession(unattendedSourceTabId);
    }

    await sleepWithStop(1200, () => false);
    closeBatchModal();

    const textarea = document.getElementById("textareaBatchKeywords");
    if (textarea) {
      textarea.value = keywords.join("\n");
      updateBatchKeywordInputState();
    }
    syncSearchFilterControlsForPlatform(platform, {
      scope: "modal",
      values: plan.searchFilters || {},
    });
    syncDetailCaptureControlsFromStoredSettings(await getCaptureSettings(), {
      platform,
    });

    const autoLoopInput = document.getElementById("chkAutoLoop");
    if (autoLoopInput) {
      autoLoopInput.checked = plannedRounds > 1;
      document
        .getElementById("batchLoopFields")
        ?.classList.toggle("is-disabled", plannedRounds <= 1);
    }
    const loopGapInput = document.getElementById("inputLoopGapMin");
    if (loopGapInput) {
      loopGapInput.value = String(
        sequentialSearchEnabled ? 0 : Math.max(0, Number(plan.roundGapMin) || 0),
      );
    }
    const loopRoundsInput = document.getElementById("inputLoopRounds");
    if (loopRoundsInput) {
      loopRoundsInput.value = String(plannedRounds);
    }
    const scheduledInput = document.getElementById("inputBatchScheduledStart");
    if (scheduledInput) {
      scheduledInput.value = "";
    }

    const navigationResult = await navigateActiveTabToKeywordSearchForPlan({
      keyword: resumeKeyword,
      platform,
      tabId: switchResult?.data?.tabId,
      baseSearchUrl: String(
        switchResult?.data?.url || getCurrentRuntime()?.lastPageUrl || "",
      ).trim(),
      maxAttempts: localBootstrapMaxAttempts,
      shouldStop: () =>
        activeUnattendedAttemptRejected ||
        !isCurrentRequestAttempt() ||
        batchKeywordCancelRequested ||
        Boolean(activeCaptureTaskCancellationReason),
      onAttempt: async ({attempt, maxAttempts}) => {
        await reportAutomaticRecoveryStage({
          phase: "opening_search_page",
          message:
            attempt === 1
              ? `正在打开关键词「${resumeKeyword}」的搜索页`
              : `正在第 ${attempt}/${maxAttempts} 次打开关键词「${resumeKeyword}」的搜索页`,
          attemptCurrent: attempt,
          attemptTotal: maxAttempts,
          retried: Math.max(0, Number(attempt) - 1),
        });
      },
      onRetry: async ({nextAttempt, maxAttempts, retryDelayMs, waitUntil}) => {
        await reportAutomaticRecoveryStage({
          phase: "waiting_search_page_retry",
          message: `搜索页被切走或尚未就绪，第 ${nextAttempt}/${maxAttempts} 次打开将在倒计时结束后开始`,
          attemptCurrent: nextAttempt,
          attemptTotal: maxAttempts,
          waitUntil,
          remainingMs: retryDelayMs,
          retried: Math.max(0, Number(nextAttempt) - 1),
        });
      },
    });
    const finalSourceTabId = Number(navigationResult?.tabId);
    const sourceTabWasReplaced =
      Number.isSafeInteger(finalSourceTabId) &&
      finalSourceTabId > 0 &&
      finalSourceTabId !== unattendedSourceTabId;
    if (Number.isSafeInteger(finalSourceTabId) && finalSourceTabId > 0) {
      unattendedSourceTabId = finalSourceTabId;
    }
    if (
      activeUnattendedAttemptRejected ||
      !isCurrentRequestAttempt() ||
      batchKeywordCancelRequested ||
      detailBatchCancelRequested ||
      Boolean(activeCaptureTaskCancellationReason)
    ) {
      const canceledError = new Error(
        `${executionCopy.taskLabel}已停止，未启动浏览器接管`,
      );
      canceledError.code = "UNATTENDED_ATTEMPT_CANCELED";
      throw canceledError;
    }
    if (captureTaskDebugSupported && !unattendedCaptureTaskSessionStarted) {
      await startUnattendedCaptureTaskSession(unattendedSourceTabId);
    } else if (unattendedCaptureTaskSessionStarted && sourceTabWasReplaced) {
      const rebound = await beginCaptureTaskSession({
        taskId: unattendedCaptureTaskContext.taskId,
        tabId: unattendedSourceTabId,
        label: `${executionCopy.captureLabel} · ${keywords.length} 个关键词`,
        platform,
        ownerRequired: false,
        attemptId: requestAttemptId,
      });
      if (rebound?.ok !== true || rebound?.active !== true) {
        const error = new Error(
          rebound?.response?.error?.message ||
            rebound?.error?.message ||
            "浏览器替换页面后未能恢复 AI Debug 接管",
        );
        error.code =
          String(
            rebound?.response?.error?.code ||
              rebound?.reason ||
              "CAPTURE_TASK_REBIND_FAILED",
          ).trim() || "CAPTURE_TASK_REBIND_FAILED";
        throw error;
      }
    }

    const delegatedReport = await reportUnattendedKeywordRun(
      requestId,
      {
        status: "running",
        message:
          sequentialSearchEnabled
            ? `已交给同一 Agent 串行执行：${searchPasses.map(unattendedSearchPassLabel).join(" → ")}`
            : plannedRounds > 1
              ? "已交给多轮采集流程执行"
            : "已交给采集流程执行",
        checkpoint,
        counts: buildUnattendedTaskCounts(
          checkpoint,
          summarizeUnattendedKeywordCheckpoint(checkpoint),
          {total: plannedTaskTotal},
        ),
        progress: {
          current: startingKeywordIndex + 1,
          total: keywords.length,
          keyword: resumeKeyword,
          keywordCurrent: startingKeywordIndex + 1,
          keywordTotal: keywords.length,
          itemCurrent: null,
          itemTotal: null,
          nextKeyword: keywords[startingKeywordIndex + 1] || "",
          progressScope: "keyword",
          round: Math.max(1, Number(checkpoint.round) || 1),
          roundCurrent: Math.max(1, Number(checkpoint.round) || 1),
          roundTotal: plannedRounds,
          phase: "delegated_to_batch_loop",
        },
      },
      {attemptId: requestAttemptId},
    );
    if (!delegatedReport?.accepted) {
      const error = new Error("当前执行已被新的恢复任务接管");
      error.code = "UNATTENDED_ATTEMPT_REPLACED";
      throw error;
    }

    reportKeywordProgress = createUnattendedKeywordProgressReporter(
      requestId,
      {
        checkpoint,
        taskTotal: plannedTaskTotal,
        attemptId: requestAttemptId,
        executionMode,
      },
    );
    const reportKeywordCheckpoint =
      createUnattendedKeywordCheckpointReporter({
        requestId,
        attemptId: requestAttemptId,
        checkpoint,
        keywords,
        taskTotal: plannedTaskTotal,
      });
    capturePipelineStarted = true;
    batchRunResult = await handleBatchKeywordCapture({
      onProgress: reportKeywordProgress,
      onKeywordSettled: reportKeywordCheckpoint,
      initialSearchEvidence: navigationResult?.initialSearchEvidence || null,
      resumeCheckpoint: checkpoint,
      maxKeywordAttempts: localKeywordMaxAttempts,
      waitForegroundTabId: null,
      sourceTabId: unattendedSourceTabId,
      executionLockOwner: "unattended_keyword_plan",
      executionLockLabel: executionCopy.taskLabel,
      captureExecutionLabel: executionCopy.captureLabel,
      executionMode,
      unattendedRequestId: requestId,
      unattendedAttemptId: requestAttemptId,
      captureTaskItemAttempts: Array.isArray(
        request?.orchestrationContext?.itemAttempts,
      )
        ? request.orchestrationContext.itemAttempts
        : [],
      searchPasses: sequentialSearchEnabled ? searchPasses : null,
      searchFilters: plan.searchFilters || {},
      disableAutomaticSearchRetry:
        plan.recoveryPolicy?.disableAutomaticSearchRetry === true,
      requireVerifiedFilters:
        plan.recoveryPolicy?.requireVerifiedFilters === true,
      keywordMaxDetectedItems:
        Object.prototype.hasOwnProperty.call(
          plan,
          "keywordMaxDetectedItems",
        )
          ? plan.keywordMaxDetectedItems
          : null,
      captureSettings:
        plan.captureSettings && typeof plan.captureSettings === "object"
          ? plan.captureSettings
          : null,
      captureTaskContext: unattendedCaptureTaskContext,
      captureTaskSessionStarted: unattendedCaptureTaskSessionStarted,
      captureTaskLifecycleOwnedByCaller:
        unattendedCaptureTaskSessionStarted,
      releaseElasticItemOnLongRetry: Boolean(
        request?.cloudAssigned === true &&
          request?.orchestrationContext?.distributionMode === "elastic_pool",
      ),
    });
    if (!batchRunResult?.started) {
      throw new Error(batchRunResult?.reason || "采集流程未启动");
    }
    if (batchRunResult?.ok === false && batchRunResult?.error) {
      throw new Error(batchRunResult.error);
    }
    if (batchRunResult?.securityBlocked) {
      unattendedCaptureTaskStatus = "completed_with_failures";
      const blockingError =
        batchRunResult?.blockingError &&
        typeof batchRunResult.blockingError === "object"
          ? batchRunResult.blockingError
          : {};
      const blockingCode =
        String(blockingError?.code || "").trim().toUpperCase() ||
        "PLATFORM_SAFETY_BLOCK";
      const safetyMessage =
        String(blockingError?.message || "").trim() ||
        "检测到验证码、登录失效或平台安全限制，已暂停整批任务且不会自动连续重试";
      const safetySummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
      const finishedAt = new Date().toISOString();
      await reportUnattendedTerminalRun(
        requestId,
        {
          status: "needs_action",
          finishedAt,
          checkpoint,
          summary: safetySummary,
          counts: buildUnattendedTaskCounts(checkpoint, safetySummary, {
            total: plannedTaskTotal,
          }),
          message: safetyMessage,
          progress: createTerminalProgress({
            status: "needs_action",
            finishedAt,
            message: safetyMessage,
            summary: safetySummary,
            streamingSync: batchRunResult?.streamingSync,
          }),
          error: {
            code: blockingCode,
            message: safetyMessage,
            category: String(blockingError?.category || ""),
            securityBlocked: true,
            platformSafetyBlocked: Boolean(
              blockingError?.platformSafetyBlocked,
            ),
            requiresManualAction: true,
            retryable: false,
          },
        },
        {attemptId: requestAttemptId},
      );
      return;
    }
    if (batchRunResult?.canceled) {
      const cancellation = resolveUnattendedCancellationTerminal(
        activeCaptureTaskCancellationReason,
        batchRunResult.reason || `${executionCopy.taskLabel}已取消`,
      );
      unattendedCaptureTaskStatus = cancellation.status;
      const canceledSummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
      const finishedAt = new Date().toISOString();
      await reportUnattendedTerminalRun(
        requestId,
        {
          status: cancellation.status,
          finishedAt,
          checkpoint,
          summary: canceledSummary,
          counts: buildUnattendedTaskCounts(checkpoint, canceledSummary, {
            total: plannedTaskTotal,
          }),
          message: cancellation.message,
          progress: createTerminalProgress({
            status: cancellation.status,
            finishedAt,
            message: cancellation.message,
            summary: canceledSummary,
            streamingSync: batchRunResult?.streamingSync,
          }),
          error: cancellation.error,
        },
        {attemptId: requestAttemptId},
      );
      return;
    }

    const checkpointSummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
    const checkpointProcessed =
      Math.max(0, Number(checkpointSummary.completed) || 0) +
      Math.max(0, Number(checkpointSummary.failed) || 0) +
      Math.max(0, Number(checkpointSummary.partial) || 0) +
      Math.max(0, Number(checkpointSummary.skipped) || 0);
    const stats = {
      total: plannedTaskTotal,
      success:
        checkpointProcessed > 0
          ? Math.max(0, Number(checkpointSummary.completed) || 0)
          : Math.max(0, Number(batchRunResult?.totalSuccess) || 0),
      failed:
        checkpointProcessed > 0
          ? Math.max(0, Number(checkpointSummary.failed) || 0)
          : Math.max(0, Number(batchRunResult?.totalFailed) || 0),
      partial:
        checkpointProcessed > 0
          ? Math.max(0, Number(checkpointSummary.partial) || 0)
          : 0,
      skipped:
        checkpointProcessed > 0
          ? Math.max(0, Number(checkpointSummary.skipped) || 0)
          : 0,
    };
    const summary = {
      ...checkpointSummary,
      total: stats.total,
      success: stats.success,
      failed: stats.failed,
    };
    const status =
      stats.failed > 0 || stats.partial > 0
        ? "completed_with_failures"
        : "completed";
    unattendedCaptureTaskStatus = status;
    const message = `${executionCopy.taskLabel}${status === "completed_with_failures" ? "部分" : ""}完成：共 ${stats.total} 个${sequentialSearchEnabled ? "巡检步骤" : "关键词次"}，完整完成 ${stats.success}，部分完成 ${stats.partial}，失败 ${stats.failed}`;
    const finishedAt = new Date().toISOString();
    await reportUnattendedTerminalRun(
      requestId,
      {
        status,
        finishedAt,
        checkpoint,
        summary,
        counts: buildUnattendedTaskCounts(checkpoint, summary, {
          total: stats.total,
          processed:
            stats.success + stats.partial + stats.failed + stats.skipped,
          success: stats.success,
          failed: stats.failed,
          skipped: stats.skipped,
          warnings: stats.partial,
        }),
        message,
        progress: createTerminalProgress({
          status,
          finishedAt,
          message,
          summary,
          streamingSync: batchRunResult?.streamingSync,
        }),
      },
      {attemptId: requestAttemptId},
    );
  } catch (error) {
    console.error("[Sidebar] Unattended keyword plan failed:", error);
    unattendedCaptureTaskError = error;
    if (!activeUnattendedAttemptRejected) {
      const safetyBlocked = isUnattendedSafetyBlock(error);
      const elasticItemReleased =
        error?.code === "UNATTENDED_ELASTIC_ITEM_RELEASED";
      const bootstrapFailed =
        error?.code === "UNATTENDED_SEARCH_BOOTSTRAP_FAILED";
      const bootstrapCanceled =
        error?.code === "UNATTENDED_SEARCH_BOOTSTRAP_CANCELED";
      const cancellation = bootstrapCanceled
        ? resolveUnattendedCancellationTerminal(
            activeCaptureTaskCancellationReason,
            `${executionCopy.taskLabel}已取消`,
          )
        : null;
      const elasticQueueAssigned = Boolean(
        request?.cloudAssigned === true &&
          request?.orchestrationContext?.distributionMode === "elastic_pool",
      );
      const elasticCooldownRelease = Boolean(
        elasticQueueAssigned && (elasticItemReleased || bootstrapFailed),
      );
      let cooldownHomeResult = null;
      if (elasticCooldownRelease) {
        if (
          unattendedCaptureTaskSessionStarted &&
          unattendedCaptureTaskContext
        ) {
          const captureTaskEnd = await endCaptureTaskSession({
            taskId: unattendedCaptureTaskContext.taskId,
            status: "failed",
            reason: "elastic_item_released_for_handoff",
          }).catch(() => null);
          const captureTaskEnded =
            captureTaskEnd?.ok === true ||
            captureTaskEnd?.reason === "capture_task_not_found" ||
            captureTaskEnd?.response?.error?.code ===
              "capture_task_not_found";
          if (captureTaskEnded) {
            releaseCaptureTaskOwner(unattendedCaptureTaskContext.taskId);
            unattendedCaptureTaskSessionStarted = false;
          }
        }
        cooldownHomeResult = await returnUnattendedAgentToCooldownHome({
          tabId: unattendedSourceTabId,
          platform,
        });
        const releasedKeyword = String(
          error?.keyword || resumeKeyword || "",
        ).trim();
        const releasedEntry = (
          Array.isArray(checkpoint?.keywordResults)
            ? checkpoint.keywordResults
            : []
        ).find(
          (entry) => String(entry?.keyword || "").trim() === releasedKeyword,
        );
        if (releasedEntry) {
          Object.assign(releasedEntry, {
            itemLockReleased: true,
            sourceAgentCooling: true,
            cooldownHomeRestored: cooldownHomeResult?.ok === true,
            cooldownHomeUrl: String(cooldownHomeResult?.homeUrl || ""),
          });
        }
      }
      const cloudTechnicalRecovery = Boolean(
        request?.cloudAssigned === true &&
          (bootstrapFailed || elasticItemReleased),
      );
      const needsAction =
        safetyBlocked || (bootstrapFailed && !cloudTechnicalRecovery);
      const terminalStatus = cancellation?.status ||
        (needsAction ? "needs_action" : "failed");
      unattendedCaptureTaskStatus =
        terminalStatus === "canceled"
          ? "canceled"
          : terminalStatus === "needs_action"
            ? "completed_with_failures"
            : "failed";
      const failureSummary = summarizeUnattendedKeywordCheckpoint(checkpoint);
      const bootstrapAttemptCount = Math.max(1, Number(error?.attempts) || 1);
      const bootstrapRecoveryCount = Math.max(0, bootstrapAttemptCount - 1);
      const bootstrapFailureCopy = bootstrapRecoveryCount > 0
        ? `搜索页首次打开并经过 ${bootstrapRecoveryCount} 次恢复仍未就绪`
        : "搜索页首次打开仍未就绪";
      const noCaptureBootstrapSync =
        bootstrapFailed &&
        capturePipelineStarted === false &&
        Math.max(0, Number(failureSummary?.saved) || 0) === 0
          ? {
              enabled: false,
              enqueuedCount: 0,
              processedCount: 0,
              successCount: 0,
              failedCount: 0,
              skippedCount: 0,
              pendingCount: 0,
              activeCount: 0,
              remainingCount: 0,
              blocked: false,
              canceled: false,
              drainCompleted: true,
            }
          : null;
      const terminalStreamingSync =
        error?.streamingSync ??
        batchRunResult?.streamingSync ??
        noCaptureBootstrapSync;
      const terminalMessage = elasticItemReleased
        ? `关键词「${String(error?.keyword || resumeKeyword || "").trim()}」已解除当前 Agent 锁定并交回云端；其它空闲 Agent 可立即接力，当前 Agent 进入冷却${cooldownHomeResult?.ok ? "并已返回平台首页" : ""}`
        : cloudTechnicalRecovery
        ? `${bootstrapFailureCopy}，当前关键词已交回云端等待其它 Agent 接力${cooldownHomeResult?.ok ? "；当前 Agent 已返回平台首页并进入冷却" : ""}`
        : bootstrapFailed
          ? `${bootstrapFailureCopy}，请检查设备网络后继续`
        : cancellation?.message || error.message;
      showMessage(
        terminalStatus === "canceled"
          ? `${executionCopy.taskLabel}已取消`
          : `${executionCopy.taskLabel}${needsAction ? "需要处理" : "失败"}: ${terminalMessage}`,
        terminalStatus === "canceled" || needsAction ? "warning" : "error",
      );
      const finishedAt = new Date().toISOString();
      await reportUnattendedTerminalRun(
        requestId,
        {
          status: terminalStatus,
          finishedAt,
          checkpoint,
          summary: failureSummary,
          counts: buildUnattendedTaskCounts(checkpoint, failureSummary, {
            total: plannedTaskTotal,
          }),
          message: terminalMessage,
          progress: createTerminalProgress({
            status: terminalStatus,
            finishedAt,
            message: terminalMessage,
            summary: failureSummary,
            streamingSync: terminalStreamingSync,
          }),
          error:
            terminalStatus === "canceled"
              ? cancellation?.error || null
              : {
                  code: safetyBlocked
                    ? "PLATFORM_SAFETY_BLOCK"
                    : error?.code || "",
                  message: terminalMessage,
                  ...(cloudTechnicalRecovery
                    ? {
                        retryable: true,
                        requiresManualAction: false,
                        category: elasticItemReleased
                          ? "elastic_item_handoff"
                          : "temporary_page_readiness",
                        ...(elasticCooldownRelease
                          ? {
                              itemLockReleased: true,
                              sourceAgentCooling: true,
                              retryAfterMs: Math.max(
                                0,
                                Number(error?.retryAfterMs) || 0,
                              ),
                              retryAt: String(error?.retryAt || ""),
                              cooldownHomeRestored:
                                cooldownHomeResult?.ok === true,
                              cooldownHomeUrl: String(
                                cooldownHomeResult?.homeUrl || "",
                              ),
                            }
                          : {}),
                      }
                    : {}),
                },
        },
        {attemptId: requestAttemptId},
      );
      error.unattendedTerminalReported = true;
    }
    throw error;
  } finally {
    const stillOwnsRequestAttempt = isCurrentRequestAttempt();
    if (
      stillOwnsRequestAttempt &&
      unattendedCaptureTaskSessionStarted &&
      unattendedCaptureTaskContext
    ) {
      if (unattendedCaptureTaskTerminalProgress) {
        await updateCaptureTaskSession({
          taskId: unattendedCaptureTaskContext.taskId,
          progress: unattendedCaptureTaskTerminalProgress,
        }).catch(() => null);
      }
      const terminal = resolveCaptureTaskTerminalStatus({
        taskStatus: unattendedCaptureTaskStatus,
        error: unattendedCaptureTaskError,
        canceled:
          unattendedCaptureTaskStatus === "canceled" ||
          activeUnattendedAttemptRejected,
      });
      const captureTaskEnd = await endCaptureTaskSession({
        taskId: unattendedCaptureTaskContext.taskId,
        ...terminal,
      });
      const captureTaskEnded =
        captureTaskEnd?.ok === true ||
        captureTaskEnd?.reason === "capture_task_not_found" ||
        captureTaskEnd?.response?.error?.code === "capture_task_not_found";
      if (captureTaskEnded) {
        releaseCaptureTaskOwner(unattendedCaptureTaskContext.taskId);
      }
    }
    if (stillOwnsRequestAttempt && unattendedCaptureTaskContext) {
      completeTaskContext({
        taskType: unattendedCaptureTaskContext.taskType,
        featureKey: unattendedCaptureTaskContext.featureKey,
      });
    }
    closeBatchModal();
    await loadKeywordPlanUI();
  }
}

async function runCaptureAction({
  mode,
  progressMessage,
  successMessage,
  captureParams = {},
  keepProgressOpen = false,
}) {
  showProgress(progressMessage);

  try {
    const result = await captureAndSync({
      mode,
      onProgress: handleProgress,
      autoSync: false,
      captureParams,
    });

    if (result.ok) {
      const savedCount = Array.isArray(result.recordIds)
        ? result.recordIds.length
        : result.recordId
          ? 1
          : 0;
      if (savedCount === 0) {
        const payload = result.captureResult?.data || {};
        const detectedCount = Number(payload.rawTotalCount || 0);
        const filteredBeforeLimitCount = Number(
          payload.filteredBeforeLimitCount || 0,
        );
        const minLikes = Number(payload.minLikes || 0);
        const sortDimension = normalizeKeywordSortDimension(
          payload.sortDimension,
        );
        const sortLabel = getKeywordSortDimensionLabel(sortDimension);
        if (detectedCount > 0 && filteredBeforeLimitCount <= 0) {
          showMessage(
            `已探测 ${detectedCount} 条，但按${sortLabel}阈值（≥${minLikes}）筛选后为 0 条，请降低筛选阈值后重试`,
            "warning",
          );
        } else {
          showMessage(
            "采集完成，但未获取到可入池数据（可能因筛选条件过高或当前页暂无结果）",
            "warning",
          );
        }
      } else {
        showMessage(successMessage, "success");
      }
      await refreshDataPool();
      return {
        ok: true,
        result,
        savedCount,
        recordIds: Array.isArray(result.recordIds) ? result.recordIds : [],
      };
    } else {
      const rawErrorCode = String(result.error?.code || "").trim();
      const rawErrorMessage = String(result.error?.message || "").trim();
      const errorMsg =
        (rawErrorCode === "UNEXPECTED_ERROR" && rawErrorMessage) ||
        ERROR_MESSAGE_MAP[rawErrorCode] ||
        rawErrorMessage ||
        "采集失败";
      showMessage(errorMsg, "error");
      return {
        ok: false,
        result,
        savedCount: 0,
      };
    }
  } catch (error) {
    console.error("[Sidebar] Capture action failed:", error);
    showMessage("操作失败: " + error.message, "error");
    return {
      ok: false,
      result: null,
      savedCount: 0,
      error,
    };
  } finally {
    if (!keepProgressOpen) {
      hideProgress();
    }
  }
}

/**
 * 处理取消操作
 */
async function handleCancel() {
  console.log("[Sidebar] Cancel clicked");
  const progressContainer = document.getElementById("progressContainer");
  if (progressContainer?.dataset.progressSource === "keyword-plan") {
    await cancelUnattendedKeywordPlanFromSidebar();
    return;
  }
  const isRecoveryCancel =
    progressContainer?.dataset.progressSource === "capture-recovery" &&
    progressContainer?.dataset.recoveryCancelable === "true";
  const recoveryRequestId = isRecoveryCancel
    ? String(
        activeRecoveryProgress?.captureRequestId ||
          progressContainer?.dataset.captureRequestId ||
          "",
      ).trim()
    : "";
  const cancelRequestId =
    recoveryRequestId ||
    (activeCommentsCaptureRecordId
      ? String(activeCommentsCaptureRequestId || "").trim()
      : "");
  const isRequestScopedCommentCancel = Boolean(
    !isRecoveryCancel &&
      cancelRequestId &&
      activeCommentsCaptureRecordId,
  );
  const shouldShowCancelingProgress =
    isRecoveryCancel || isRequestScopedCommentCancel;
  const recoverySnapshot = isRecoveryCancel
    ? {...activeRecoveryProgress}
    : isRequestScopedCommentCancel
      ? {
          phase: "comments_capturing",
          recordId: activeCommentsCaptureRecordId,
          runnerTabId: activeCommentsCaptureTabId,
          captureRequestId: cancelRequestId,
          captureAction: "captureComments",
        }
      : null;
  const captureTaskSession = getCurrentRuntime()?.captureDebugSession;
  setCancelFlag(true);
  searchCaptureCancelRequested = true;
  if (shouldShowCancelingProgress) {
    renderCaptureRecoveryUI({
      ...recoverySnapshot,
      phase: "capture_canceling",
      message: "正在取消当前任务并保存可用结果…",
      updatedAt: Date.now(),
    });
  } else {
    hideProgressPanelOnly();
  }
  let relayTabId = isRecoveryCancel ? activeRecoveryRunnerTabId : null;
  let shouldFinalizeDetailCapture = false;
  if (detailBatchCaptureInFlight) {
    detailBatchCancelRequested = true;
    shouldFinalizeDetailCapture = true;
    if (Number.isFinite(Number(detailBatchRunnerTabId))) {
      relayTabId = Number(detailBatchRunnerTabId);
    }
  }
  if (batchUrlCaptureInFlight) {
    batchUrlCancelRequested = true;
    relayTabId = relayTabId || activeBatchRunnerTabId;
  }
  if (batchKeywordCaptureInFlight) {
    batchKeywordCancelRequested = true;
    relayTabId = relayTabId || activeBatchRunnerTabId;
  }
  if (monitorRunInFlight) {
    monitorRunCancelRequested = true;
    relayTabId = relayTabId || activeBatchRunnerTabId;
  }
  if (
    activeCommentsCaptureRecordId &&
    Number.isFinite(Number(activeCommentsCaptureTabId))
  ) {
    relayTabId = relayTabId || Number(activeCommentsCaptureTabId);
  }

  if (!relayTabId) {
    const taskWorkerTabIds = Array.isArray(captureTaskSession?.workerTabIds)
      ? captureTaskSession.workerTabIds
      : [];
    relayTabId = Number(
      taskWorkerTabIds[taskWorkerTabIds.length - 1] ??
        captureTaskSession?.sourceTabId ??
        captureTaskSession?.tabId,
    );
    if (!Number.isSafeInteger(relayTabId) || relayTabId <= 0) {
      relayTabId = null;
    }
  }

  try {
    if (relayTabId) {
      await requestCaptureCancelSignal(relayTabId, cancelRequestId);
    } else {
      await requestCaptureCancelSignal(null, cancelRequestId);
    }
  } catch (error) {
    console.warn("[Sidebar] Cancel relay failed:", error);
    if (shouldShowCancelingProgress) {
      if (isRecoveryCancel) {
        renderCaptureRecoveryUI({
          ...recoverySnapshot,
          updatedAt: Date.now(),
        });
      } else {
        resetCaptureRecoveryUI({hidePanel: true, clearState: true});
      }
      showMessage("取消请求发送失败，请检查网络后再试", "error");
    }
  }

  const captureTaskId = String(captureTaskSession?.taskId || "").trim();
  if (captureTaskSession?.persistent && captureTaskId) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "onstarvoice:end-capture-task",
        taskId: captureTaskId,
        reason: "user_cancel_requested",
        status: "canceled",
      });
      if (response?.ok === false) {
        throw new Error(response?.error?.message || "停止 AI Debug 任务失败");
      }
    } catch (error) {
      console.warn("[Sidebar] Persistent capture task stop failed:", error);
      showMessage("采集取消信号已发送，但浏览器接管仍在释放，请再点一次停止", "warning");
    }
  }

  if (shouldFinalizeDetailCapture) {
    await finalizeInterruptedDetailCaptureAfterCancel();
  } else if (!shouldShowCancelingProgress) {
    showMessage("正在取消...", "info");
  }
}

/**
 * 处理鉴权
 */
function queueAuthVerification(operation) {
  const run = () => operation();
  const pending = authVerifyQueue.then(run, run);
  authVerifyQueue = pending.catch(() => null);
  return pending;
}

async function isAuthVerificationRequestCurrent({
  plainCode,
  revision,
  mutationId,
  input = null,
}) {
  const expectedCode = normalizeAuthCodeInput(plainCode);
  const expectedMutationId = String(mutationId || "");
  const inputMatches = () =>
    !input || normalizeAuthCodeInput(input.value) === expectedCode;
  if (!expectedCode || revision !== authCodeRevision || !inputMatches()) return false;

  const currentAuth = getCurrentAuth() || {};
  const currentCode = normalizeAuthCodeInput(currentAuth.code);
  if (!currentCode) return false;
  try {
    const storedAuth = await getAuth();
    const storedCode = normalizeAuthCodeInput(storedAuth?.code);
    const [currentPlainCode, storedPlainCode] = await Promise.all([
      ensurePlainAuthCode(currentCode),
      ensurePlainAuthCode(storedCode),
    ]);
    if (revision !== authCodeRevision || !inputMatches()) return false;
    const latestAuth = getCurrentAuth() || {};
    return (
      normalizeAuthCodeInput(latestAuth.code) === currentCode &&
      String(latestAuth.authMutationId || "") === expectedMutationId &&
      String(storedAuth?.authMutationId || "") === expectedMutationId &&
      normalizeAuthCodeInput(currentPlainCode) === expectedCode &&
      normalizeAuthCodeInput(storedPlainCode) === expectedCode
    );
  } catch {
    return false;
  }
}

function handleVerify() {
  if (authVerifyPromise) return authVerifyPromise;
  const pending = queueAuthVerification(handleVerifyImpl);
  const tracked = pending.finally(() => {
    if (authVerifyPromise === tracked) authVerifyPromise = null;
  });
  authVerifyPromise = tracked;
  return tracked;
}

async function handleVerifyImpl() {
  if (authVerifyInFlight) {
    showMessage("正在验证中，请稍候...", "info");
    return;
  }

  const input = document.getElementById("inputCode");
  if (!input) return;

  if (authCodeEncryptTimer) {
    clearTimeout(authCodeEncryptTimer);
    authCodeEncryptTimer = null;
  }
  await persistAuthCodeFromInput();

  const rawCode = normalizeAuthCodeInput(input.value);

  if (!rawCode) {
    showMessage("请输入激活码或订单号", "error");
    return;
  }

  let encryptedCode = "";
  let plainCode = "";
  try {
    encryptedCode = await ensureEncryptedAuthCode(rawCode);
    plainCode = await ensurePlainAuthCode(encryptedCode);
  } catch (error) {
    console.error("[Sidebar] Prepare verify code failed:", error);
    showMessage("激活码加密失败，请重试", "error");
    return;
  }

  if (!plainCode) {
    showMessage("激活码格式无效，请重新输入", "error");
    return;
  }
  const requestRevision = authCodeRevision;

  const currentAuth = getCurrentAuth() || {};
  const requestMutationId = String(currentAuth.authMutationId || "");
  const previousStoredCode = normalizeAuthCodeInput(currentAuth.code);
  if (isEncryptedAuthCode(previousStoredCode)) {
    try {
      const previousPlainCode = normalizeAuthCodeInput(
        await ensurePlainAuthCode(previousStoredCode),
      );
      if (previousPlainCode === plainCode) {
        encryptedCode = previousStoredCode;
      }
    } catch (error) {
      console.warn(
        "[Sidebar] Failed to decode previous auth code before verify:",
        error,
      );
    }
  }

  authVerifyInFlight = true;
  showProgress("正在验证凭证...");

  try {
    if (!(await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    }))) {
      showMessage("激活码已更改，未发送旧验证请求", "info");
      return {ok: false, skipped: true, reason: "auth_changed"};
    }
    const verifyingWrite = await setCurrentAuth(
      {
        status: AUTH_STATUS.VERIFYING,
        code: encryptedCode,
        message: "",
        reason: "none",
      },
      {expectedMutationId: requestMutationId},
    );
    if (!verifyingWrite?.accepted) {
      showMessage("激活码已更改，未发送旧验证请求", "info");
      return {ok: false, skipped: true, reason: "auth_changed"};
    }

    let result = await verify(plainCode);

    if (!result.ok && result.reason === ERROR_REASON.BINDING_LIMIT_REACHED) {
      hideProgress();
      const candidates = Array.isArray(result.data?.replaceCandidates)
        ? result.data.replaceCandidates
        : [];
      const selectedBindingId = await pickBindingForReplacement(candidates);

      if (!selectedBindingId) {
        result = {
          ok: false,
          reason: ERROR_REASON.BINDING_LIMIT_REACHED,
          message: "已取消环境替换",
          data: result.data || null,
        };
      } else {
        showProgress("正在替换旧环境...");
        if (!(await isAuthVerificationRequestCurrent({
          plainCode,
          revision: requestRevision,
          mutationId: requestMutationId,
          input,
        }))) {
          return {ok: false, skipped: true, reason: "auth_changed"};
        }
        result = await verify(plainCode, {
          replaceBindingId: selectedBindingId,
        });
      }
    }

    if (!(await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    }))) {
      showMessage("激活码已更改，旧验证结果已忽略", "info");
      return {ok: false, skipped: true, reason: "auth_changed"};
    }

    if (result.ok) {
      const authSnapshot = authSnapshotFromVerifyResult(result);
      const verifiedWrite = await setCurrentAuth(
        {
          verified: true,
          status: AUTH_STATUS.VERIFIED,
          code: encryptedCode,
          lastVerifiedAt: new Date().toISOString(),
          message: result.message,
          reason: "none",
          ...authSnapshot,
        },
        {expectedMutationId: requestMutationId},
      );
      if (!verifiedWrite?.accepted) {
        return {ok: false, skipped: true, reason: "auth_changed"};
      }

      try {
        await syncTargetConfigAfterVerify();
      } catch (error) {
        console.warn("[Sidebar] Target sync after verify failed:", error);
      }

      try {
        await loadMonitorSettings();
      } catch (error) {
        console.warn(
          "[Sidebar] Monitor settings sync after verify failed:",
          error,
        );
      }

      if (
        document
          .querySelector("#mainTabNav .tab-btn.is-active")
          ?.getAttribute("data-target") === "monitorTab"
      ) {
        await loadMonitorSubscriptions({force: true});
      }

      if (
        document
          .querySelector("#mainTabNav .tab-btn.is-active")
          ?.getAttribute("data-target") === "historyTab"
      ) {
        await loadExecutionDetails({force: true});
      }

      if (result.data?.replacedBinding) {
        showMessage("激活成功，已替换旧环境并完成后台绑定", "success");
      } else {
        showMessage("激活成功，已完成后台绑定", "success");
      }
      await maybeOpenMemberGroupModalAfterVerify(getCurrentAuth());
    } else {
      const failedWrite = await setCurrentAuth(
        {
          verified: false,
          status: AUTH_STATUS.FAILED,
          code: encryptedCode,
          message: result.message,
          reason: result.reason,
          user: null,
          credentialCredit: null,
          captureAgent: null,
        },
        {expectedMutationId: requestMutationId},
      );
      if (!failedWrite?.accepted) {
        return {ok: false, skipped: true, reason: "auth_changed"};
      }
      await resetCurrentMonitor();

      const isReplaceCanceled = result.message === "已取消环境替换";
      const errorMsg =
        (isReplaceCanceled ? result.message : null) ||
        result.message ||
        ERROR_MESSAGE_MAP[result.reason || result.error?.reason] ||
        "激活失败";
      showMessage(errorMsg, isReplaceCanceled ? "warning" : "error");
    }
  } catch (error) {
    console.error("[Sidebar] Verify failed:", error);
    if (await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    })) {
      await resetCurrentMonitor();
      showMessage("验证失败: " + error.message, "error");
    }
  } finally {
    authVerifyInFlight = false;
    hideProgress();
  }
}

function formatBindingTime(value) {
  if (!value) return "未知";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "未知" : parsed.toLocaleString();
}

function escapeHtmlText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getBindingReplaceModalElements() {
  const overlay = document.getElementById("bindingReplaceModal");
  const subtitle = document.getElementById("bindingReplaceSubtitle");
  const list = document.getElementById("bindingReplaceList");
  const btnCancel = document.getElementById("btnBindingReplaceCancel");
  const btnConfirm = document.getElementById("btnBindingReplaceConfirm");

  if (!overlay || !subtitle || !list || !btnCancel || !btnConfirm) {
    return null;
  }

  return {
    overlay,
    subtitle,
    list,
    btnCancel,
    btnConfirm,
  };
}

function renderBindingReplaceCandidates(
  listElement,
  candidates,
  selectedBindingId,
) {
  listElement.innerHTML = candidates
    .map((candidate, index) => {
      const bindingId = String(candidate.id || "");
      const label = escapeHtmlText(
        candidate.clientLabel || candidate.clientUuid || "未知环境",
      );
      const firstBoundAt = formatBindingTime(candidate.firstBoundAt);
      const lastVerifiedAt = formatBindingTime(candidate.lastVerifiedAt);
      const checked = bindingId === selectedBindingId ? "checked" : "";

      return `
        <label class="binding-replace-item" for="bindingReplaceOption${index}">
          <input
            type="radio"
            name="bindingReplaceOption"
            id="bindingReplaceOption${index}"
            value="${escapeHtmlText(bindingId)}"
            ${checked}
          />
          <span class="binding-replace-item-main">
            <div class="binding-replace-item-label">${label}</div>
            <div class="binding-replace-item-meta">首次绑定：${escapeHtmlText(firstBoundAt)}</div>
            <div class="binding-replace-item-meta">最近验证：${escapeHtmlText(lastVerifiedAt)}</div>
          </span>
        </label>
      `;
    })
    .join("");
}

async function pickBindingForReplacement(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    showMessage("当前没有可替换的环境，请联系运营处理", "warning");
    return null;
  }

  const elements = getBindingReplaceModalElements();
  if (!elements) {
    console.error("[Sidebar] Binding replace modal elements not found");
    showMessage("无法打开环境替换窗口，请刷新后重试", "error");
    return null;
  }

  const {overlay, subtitle, list, btnCancel, btnConfirm} = elements;
  let selectedBindingId = "";

  subtitle.textContent = `当前激活码已占满 ${candidates.length}/${candidates.length} 个环境，被替换环境将立即失效。`;
  renderBindingReplaceCandidates(list, candidates, selectedBindingId);
  btnConfirm.disabled = !selectedBindingId;

  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");

  const firstInput = list.querySelector('input[name="bindingReplaceOption"]');
  if (firstInput) {
    firstInput.focus();
  } else {
    btnCancel.focus();
  }

  return await new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.remove("is-active");
      overlay.setAttribute("aria-hidden", "true");
      btnCancel.removeEventListener("click", onCancel);
      btnConfirm.removeEventListener("click", onConfirm);
      list.removeEventListener("change", onChange);
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeyDown);
      list.innerHTML = "";
    };

    const done = (bindingId) => {
      cleanup();
      resolve(bindingId);
    };

    const onCancel = () => done(null);

    const onConfirm = () => {
      if (!selectedBindingId) {
        showMessage("请选择一个要替换的环境", "warning");
        return;
      }
      done(selectedBindingId);
    };

    const onChange = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.name !== "bindingReplaceOption") return;
      selectedBindingId = target.value;
      btnConfirm.disabled = !selectedBindingId;
    };

    const onOverlayClick = (event) => {
      if (event.target === overlay) {
        done(null);
      }
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        done(null);
      }
    };

    btnCancel.addEventListener("click", onCancel);
    btnConfirm.addEventListener("click", onConfirm);
    list.addEventListener("change", onChange);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeyDown);
  });
}

function isMonitorAuthReady() {
  const auth = getCurrentAuth() || {};
  return auth.status === AUTH_STATUS.VERIFIED && Boolean(auth.credential?.code);
}

async function loadMonitorSubscriptions({force = false} = {}) {
  const currentMonitor = getCurrentMonitor() || {};
  if (currentMonitor.isLoading && !force) {
    return currentMonitor.items || [];
  }

  if (!isMonitorAuthReady()) {
    await resetCurrentMonitor();
    return [];
  }

  const runtime = getCurrentRuntime();
  const runtimePlatform = runtime?.platform || "douyin";
  const datasetSelectedPlatform = document.body.dataset.selectedPlatform;
  const platform =
    datasetSelectedPlatform && datasetSelectedPlatform !== "unknown"
      ? datasetSelectedPlatform
      : runtimePlatform;

  const status = MONITOR_STATUS.ALL;
  await setCurrentMonitor({
    isLoading: true,
    error: null,
    filters: {
      ...(currentMonitor.filters || {}),
      status,
      platform,
    },
  });

  const result = await listMonitorSubscriptions({status, platform});
  if (!result?.ok) {
    const monitorErrorMsg =
      ERROR_MESSAGE_MAP[result?.reason] ||
      result?.message ||
      "加载监控列表失败";
    await setCurrentMonitor({
      items: [],
      isLoading: false,
      error: monitorErrorMsg,
    });
    showMessage(monitorErrorMsg, "error");
    return [];
  }

  const items = Array.isArray(result.data?.items) ? result.data.items : [];

  await setCurrentMonitor({
    items,
    isLoading: false,
    error: null,
    lastFetchedAt: Date.now(),
    filters: {
      ...(currentMonitor.filters || {}),
      status,
      platform,
    },
  });

  return items;
}

async function loadMonitorExecutions({force = false, limit = 50} = {}) {
  const currentMonitor = getCurrentMonitor() || {};
  if (currentMonitor.isLoadingExecutions && !force) {
    return currentMonitor.executions || [];
  }

  if (!isMonitorAuthReady()) {
    await setCurrentMonitor({
      executions: [],
      isLoadingExecutions: false,
      executionsError: null,
      executionsLastFetchedAt: null,
    });
    return [];
  }

  await setCurrentMonitor({
    isLoadingExecutions: true,
    executionsError: null,
  });

  const result = await listMonitorExecutions({limit});
  if (!result?.ok) {
    const monitorErrorMsg =
      ERROR_MESSAGE_MAP[result?.reason] ||
      result?.message ||
      "加载监控执行记录失败";
    await setCurrentMonitor({
      executions: [],
      isLoadingExecutions: false,
      executionsError: monitorErrorMsg,
    });
    return [];
  }

  const items = Array.isArray(result.data?.items)
    ? result.data.items
    : Array.isArray(result.data?.executions)
      ? result.data.executions
      : Array.isArray(result.executions)
        ? result.executions
        : Array.isArray(result.items)
          ? result.items
          : [];
  await setCurrentMonitor({
    executions: items,
    isLoadingExecutions: false,
    executionsError: null,
    executionsLastFetchedAt: Date.now(),
  });

  return items;
}

async function loadExecutionDetails({force = false} = {}) {
  if (!isMonitorAuthReady()) {
    await setCurrentMonitor({
      executions: [],
      isLoadingExecutions: false,
      executionsError: null,
      executionsLastFetchedAt: null,
    });
    return [];
  }

  await Promise.all([
    loadMonitorSubscriptions({force}),
    loadMonitorExecutions({force}),
  ]);
  return getCurrentMonitor()?.executions || [];
}

function getMonitorSettingsElements() {
  const publishWindow = document.getElementById("inputMonitorPublishWindow");
  const likeThreshold = document.getElementById("inputMonitorLikeThreshold");
  const runTimes = document.getElementById("inputMonitorRunTimes");
  const observeWindowHours = document.getElementById(
    "inputMonitorObserveWindowHours",
  );

  if (!publishWindow || !likeThreshold || !runTimes || !observeWindowHours) {
    return null;
  }

  return {
    publishWindow,
    likeThreshold,
    runTimes,
    observeWindowHours,
  };
}

function normalizeMonitorSettingsInput(input = {}) {
  const likeThreshold = Number(
    input.likeThreshold ?? DEFAULT_MONITOR_SETTINGS.likeThreshold,
  );
  const observeWindowHours = Number(
    input.observeWindowHours ?? DEFAULT_MONITOR_SETTINGS.observeWindowHours,
  );
  const rawPublishWindow = String(
    input.publishWindow || DEFAULT_MONITOR_SETTINGS.publishWindow,
  ).trim();
  const normalizedPublishWindow =
    rawPublishWindow === "recent_activity"
      ? DEFAULT_MONITOR_SETTINGS.publishWindow
      : rawPublishWindow;
  const publishWindow = MONITOR_PUBLISH_WINDOW_OPTIONS.has(normalizedPublishWindow)
    ? normalizedPublishWindow
    : DEFAULT_MONITOR_SETTINGS.publishWindow;
  const runTimes = (
    Array.isArray(input.runTimes)
      ? input.runTimes
      : String(input.runTimes || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
  ).filter((item) => MONITOR_RUN_TIME_OPTIONS.includes(item));

  const normalizedObserveWindowHours =
    Number.isFinite(observeWindowHours) && observeWindowHours > 0
      ? Math.trunc(observeWindowHours)
      : DEFAULT_MONITOR_SETTINGS.observeWindowHours;
  const safeObserveWindowHours = MONITOR_OBSERVE_WINDOW_OPTIONS.includes(
    normalizedObserveWindowHours,
  )
    ? normalizedObserveWindowHours
    : DEFAULT_MONITOR_SETTINGS.observeWindowHours;

  return {
    publishWindow,
    likeThreshold:
      Number.isFinite(likeThreshold) && likeThreshold >= 0
        ? Math.trunc(likeThreshold)
        : DEFAULT_MONITOR_SETTINGS.likeThreshold,
    runTimes:
      runTimes.length > 0 ? runTimes : [...DEFAULT_MONITOR_SETTINGS.runTimes],
    observeWindowHours: safeObserveWindowHours,
    timezone: DEFAULT_MONITOR_SETTINGS.timezone,
  };
}

function populateMonitorSettingsForm(settings = {}) {
  const elements = getMonitorSettingsElements();
  if (!elements) {
    return;
  }

  const normalized = normalizeMonitorSettingsInput(settings);
  elements.publishWindow.value = normalized.publishWindow;
  elements.likeThreshold.value = String(normalized.likeThreshold);
  elements.runTimes.value =
    normalized.runTimes[0] || DEFAULT_MONITOR_SETTINGS.runTimes[0];
  elements.observeWindowHours.value = String(normalized.observeWindowHours);
}

function readMonitorSettingsForm() {
  const elements = getMonitorSettingsElements();
  if (!elements) {
    return {...DEFAULT_MONITOR_SETTINGS};
  }

  return normalizeMonitorSettingsInput({
    publishWindow: elements.publishWindow.value,
    likeThreshold: elements.likeThreshold.value,
    runTimes: elements.runTimes.value,
    observeWindowHours: elements.observeWindowHours.value,
  });
}

async function loadMonitorSettings() {
  if (!isMonitorAuthReady()) {
    await setCurrentMonitor({
      settings: {...DEFAULT_MONITOR_SETTINGS},
    });
    populateMonitorSettingsForm(DEFAULT_MONITOR_SETTINGS);
    return DEFAULT_MONITOR_SETTINGS;
  }

  const result = await getMonitorSettings();
  if (!result?.ok) {
    populateMonitorSettingsForm(DEFAULT_MONITOR_SETTINGS);
    await setCurrentMonitor({
      settings: {...DEFAULT_MONITOR_SETTINGS},
    });
    return DEFAULT_MONITOR_SETTINGS;
  }

  const settings = normalizeMonitorSettingsInput(result.data?.settings || {});
  await setCurrentMonitor({
    settings,
  });
  populateMonitorSettingsForm(settings);
  return settings;
}

function resolveMonitorDisplayName(item) {
  return (
    String(
      item?.displayName ||
        item?.display_name ||
        item?.bloggerNameSnapshot ||
        item?.bloggerName ||
        "",
    ).trim() ||
    String(
      item?.accountNo ||
        item?.account_no ||
        item?.profileInternalId ||
        item?.profile_internal_id ||
        item?.platformBloggerId ||
        "",
    ).trim() ||
    "未命名博主"
  );
}

function normalizeMonitorSubjectType(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === MONITOR_SUBJECT_TYPE.OFFICIAL
    ? MONITOR_SUBJECT_TYPE.OFFICIAL
    : MONITOR_SUBJECT_TYPE.CREATOR;
}

function getMonitorSubjectType() {
  const selectedButton = document.querySelector(
    '.monitor-subject-option[aria-pressed="true"]',
  );
  return normalizeMonitorSubjectType(selectedButton?.dataset?.subjectType);
}

function getMonitorSubjectLabel(subjectType) {
  return normalizeMonitorSubjectType(subjectType) ===
    MONITOR_SUBJECT_TYPE.OFFICIAL
    ? "官方账号"
    : "关注博主";
}

function setMonitorSubjectType(subjectType) {
  const normalized = normalizeMonitorSubjectType(subjectType);
  document.querySelectorAll(".monitor-subject-option").forEach((button) => {
    const isSelected =
      normalizeMonitorSubjectType(button.dataset.subjectType) === normalized;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  });
  window.getMonitorSubjectType = () => normalized;
  window.refreshMonitorSubjectAction?.();
}

function extractPlatformMonitorBloggerId(platform, url, fallbackId = "") {
  const normalizedPlatform = String(platform || "")
    .trim()
    .toLowerCase();
  const normalizedUrl = String(url || "").trim();

  if (normalizedPlatform === "xiaohongshu" && normalizedUrl) {
    const profileMatch = normalizedUrl.match(
      /\/user\/profile\/([a-zA-Z0-9_-]+)/i,
    );
    if (profileMatch?.[1]) {
      return profileMatch[1];
    }
  }

  if (normalizedPlatform === "weibo" && normalizedUrl) {
    const weiboMatch =
      normalizedUrl.match(/weibo\.com\/u\/(\d+)/i) ||
      normalizedUrl.match(/weibo\.com\/(\d{5,})(?:[/?#]|$)/i);
    if (weiboMatch?.[1]) {
      return weiboMatch[1];
    }
  }

  if (normalizedPlatform === "douyin" && normalizedUrl) {
    const douyinMatch = normalizedUrl.match(
      /\/user\/([a-zA-Z0-9._-]+)(?:[/?#]|$)/i,
    );
    if (douyinMatch?.[1]) {
      return douyinMatch[1];
    }
  }

  return String(fallbackId || "").trim();
}

function resolveMonitorAccountNo(platform, payload = {}, profileInternalId = "") {
  const normalizedPlatform = String(platform || "")
    .trim()
    .toLowerCase();
  const candidates =
    normalizedPlatform === "xiaohongshu"
      ? [
          payload.accountNo,
          payload.account_no,
          payload.bloggerUserId,
          payload.redId,
          payload.xiaohongshuId,
          payload.bloggerId,
        ]
      : normalizedPlatform === "douyin"
        ? [
            payload.accountNo,
            payload.account_no,
            payload.douyinId,
            payload.uniqueId,
            payload.authorUsername,
          ]
        : normalizedPlatform === "weibo"
          ? [
              payload.accountNo,
              payload.account_no,
              payload.weiboId,
              payload.bloggerId,
            ]
          : [payload.accountNo, payload.account_no, payload.bloggerId];

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized) continue;
    if (
      normalizedPlatform !== "weibo" &&
      normalized === String(profileInternalId || "").trim()
    ) {
      continue;
    }
    return normalized;
  }
  return "";
}

function buildMonitorSubjectCandidate({
  platform,
  subjectType = MONITOR_SUBJECT_TYPE.CREATOR,
  profileInternalId = "",
  accountNo = "",
  displayName = "",
  profileUrl = "",
  avatarUrl = "",
  assignedAgentId = "",
} = {}) {
  const normalizedSubjectType = normalizeMonitorSubjectType(subjectType);
  const normalizedProfileInternalId = String(profileInternalId || "").trim();
  const normalizedAccountNo = String(accountNo || "").trim();
  const normalizedDisplayName = String(displayName || "").trim();
  const normalizedProfileUrl = String(profileUrl || "").trim();
  const normalizedAvatarUrl = String(avatarUrl || "").trim();
  const normalizedAssignedAgentId = String(assignedAgentId || "").trim();
  const platformBloggerId =
    normalizedProfileInternalId || normalizedAccountNo;

  if (!platformBloggerId) {
    return null;
  }

  return {
    platform: String(platform || "")
      .trim()
      .toLowerCase(),
    subjectType: normalizedSubjectType,
    profileInternalId: normalizedProfileInternalId,
    accountNo: normalizedAccountNo,
    displayName: normalizedDisplayName,
    profileUrl: normalizedProfileUrl,
    avatarUrl: normalizedAvatarUrl,
    assignedAgentId: normalizedAssignedAgentId,
    // Backward-compatible fields consumed by the existing monitor API.
    platformBloggerId,
    bloggerNameSnapshot: normalizedDisplayName,
    bloggerUrl: normalizedProfileUrl,
    bloggerAvatarSnapshot: normalizedAvatarUrl,
  };
}

function buildMonitorCandidateFromRecord(
  record,
  subjectType = MONITOR_SUBJECT_TYPE.CREATOR,
) {
  if (!record || record.type !== "blogger_profile") {
    return null;
  }

  const platform = resolveRecordPlatform(record);
  if (
    platform !== "douyin" &&
    platform !== "xiaohongshu" &&
    platform !== "weibo"
  ) {
    return null;
  }

  const payload = record.payload || {};
  const profileUrl = String(
    payload.profileUrl ||
      payload.bloggerUrl ||
      payload.bloggerProfileUrl ||
      "",
  ).trim();
  const profileInternalId = extractPlatformMonitorBloggerId(
    platform,
    profileUrl,
    payload.profileInternalId || payload.bloggerId,
  );
  const accountNo = resolveMonitorAccountNo(
    platform,
    payload,
    profileInternalId,
  );
  return buildMonitorSubjectCandidate({
    platform,
    subjectType,
    profileInternalId,
    accountNo,
    displayName: payload.displayName || payload.bloggerName,
    profileUrl,
    avatarUrl: payload.avatarUrl || payload.bloggerAvatarSnapshot,
    assignedAgentId: getCurrentAuth()?.captureAgent?.id || "",
  });
}

async function addMonitorSubscriptionByCandidate(candidate) {
  const result = await createMonitorSubscription(candidate);

  if (!result?.ok) {
    throw new Error(result?.message || "纳入监控失败");
  }

  await loadMonitorSubscriptions({force: true});

  const subjectType = normalizeMonitorSubjectType(candidate?.subjectType);
  const isOfficial = subjectType === MONITOR_SUBJECT_TYPE.OFFICIAL;
  if (result.data?.created) {
    showMessage(
      isOfficial ? "已登记为官方账号" : "已将当前账号加入关注博主",
      "success",
    );
  } else if (result.data?.restored) {
    showMessage(
      isOfficial ? "已恢复官方账号登记" : "当前账号已恢复到关注博主",
      "success",
    );
  } else {
    showMessage(
      isOfficial ? "该官方账号已登记" : "当前账号已在关注博主中",
      "info",
    );
  }
}

async function captureCurrentMonitorCandidate(
  subjectType = getMonitorSubjectType(),
) {
  const runtime = getCurrentRuntime();
  const pageUrl = String(runtime?.lastPageUrl || "").trim();
  const pagePlatform = detectPlatformFromUrl(pageUrl);

  if (
    (pagePlatform !== "douyin" &&
      pagePlatform !== "xiaohongshu" &&
      pagePlatform !== "weibo") ||
    runtime?.pageType !== PAGE_TYPE.BLOGGER_PROFILE
  ) {
    throw new Error("请先切换到抖音、小红书或微博账号主页");
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab?.id) {
    throw new Error("未找到当前活动页");
  }

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.RELAY_TO_CONTENT,
    tabId: tab.id,
    payload: {
      action: "captureBloggerProfile",
    },
  });

  const captureResult = response?.data;
  if (!response?.ok || !captureResult?.ok || !captureResult?.data) {
    const errorText =
      captureResult?.error?.message ||
      response?.error?.message ||
      "账号主页识别失败";
    throw new Error(errorText);
  }

  const profile = captureResult.data || {};
  const profileUrl = String(
    profile.profileUrl ||
      profile.bloggerUrl ||
      profile.bloggerProfileUrl ||
      pageUrl,
  ).trim();
  const profileInternalId = extractPlatformMonitorBloggerId(
    pagePlatform,
    profileUrl,
    profile.profileInternalId || profile.bloggerId,
  );
  const accountNo = resolveMonitorAccountNo(
    pagePlatform,
    profile,
    profileInternalId,
  );
  const candidate = buildMonitorSubjectCandidate({
    platform: pagePlatform,
    subjectType,
    profileInternalId,
    accountNo,
    displayName: profile.displayName || profile.bloggerName,
    profileUrl,
    avatarUrl: profile.avatarUrl || profile.bloggerAvatarSnapshot,
    assignedAgentId: getCurrentAuth()?.captureAgent?.id || "",
  });

  if (!candidate) {
    throw new Error("未识别到账号唯一 ID");
  }

  return candidate;
}

async function handleAddCurrentMonitor() {
  if (!isMonitorAuthReady()) {
    showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
    return;
  }

  const subjectType = getMonitorSubjectType();
  const subjectLabel = getMonitorSubjectLabel(subjectType);
  showProgress(`正在识别并登记${subjectLabel}...`);

  try {
    const candidate = await captureCurrentMonitorCandidate(subjectType);
    await addMonitorSubscriptionByCandidate(candidate);
  } catch (error) {
    console.error("[Sidebar] Add current monitor failed:", error);
    showMessage(`${subjectLabel}登记失败: ${error.message}`, "error");
  } finally {
    hideProgress();
  }
}

function resolveMonitorRunHistoryState(item) {
  const status = String(item?.status || "")
    .trim()
    .toLowerCase();
  const hitCount = Math.max(0, Number(item?.hitCount || 0));
  const scannedCount = Math.max(0, Number(item?.scannedCount || 0));
  const errorCode = String(item?.errorCode || "").trim();
  const errorMessage = String(item?.errorMessage || "").trim();

  if (status === "skipped_no_balance") {
    return {
      monitorStatus: "credit_insufficient",
      monitorStatusLabel: "配额不足",
      monitorSyncLabel: "",
      monitorSummary: "未执行扫描（配额不足）",
      isSuccess: false,
      reason: errorCode || "insufficient_balance",
      message: errorMessage || "insufficient credential credits",
    };
  }

  if (status === "queued" || status === "pending" || status === "running") {
    return {
      monitorStatus: "queued",
      monitorStatusLabel: "已排队",
      monitorSyncLabel: "",
      monitorSummary: status === "running" ? "扫描任务执行中" : "扫描任务已排队",
      isSuccess: true,
      reason: ERROR_REASON.NONE,
      message: status === "running" ? "监控任务执行中" : "已创建监控执行任务",
    };
  }

  if (status === "no_hit") {
    return {
      monitorStatus: "no_hit",
      monitorStatusLabel: "未命中",
      monitorSyncLabel: "",
      monitorSummary: `已扫描 ${scannedCount} / 命中 0`,
      isSuccess: true,
      reason: ERROR_REASON.NONE,
      message: "监控执行完成",
    };
  }

  if (status === "success") {
    return {
      monitorStatus: "hit_synced",
      monitorStatusLabel: "已命中",
      monitorSyncLabel: "已同步",
      monitorSummary: `命中 ${hitCount} / 已同步`,
      isSuccess: true,
      reason: ERROR_REASON.NONE,
      message: "监控执行完成",
    };
  }

  if (status === "failed" && hitCount > 0) {
    return {
      monitorStatus: "hit_sync_failed",
      monitorStatusLabel: "已命中",
      monitorSyncLabel: "同步失败",
      monitorSummary: `命中 ${hitCount} / 同步失败`,
      isSuccess: false,
      reason: errorCode || "sync_failed",
      message: errorMessage || "监控同步失败",
    };
  }

  return {
    monitorStatus: "execution_failed",
    monitorStatusLabel: "执行失败",
    monitorSyncLabel: "",
    monitorSummary: errorMessage || "扫描失败",
    isSuccess: false,
    reason: errorCode || "provider_request_failed",
    message: errorMessage || "监控执行失败",
  };
}

function normalizeMonitorRunnerPlatform(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "douyin" ||
    normalized === "xiaohongshu" ||
    normalized === "weibo"
    ? normalized
    : "unknown";
}

function resolveMonitorRunnerAccountUrl(runItem = {}, monitorItem = {}) {
  return String(
    runItem.bloggerUrl ||
      runItem.monitorBloggerUrl ||
      runItem.accountUrl ||
      monitorItem.bloggerUrl ||
      monitorItem.monitorBloggerUrl ||
      monitorItem.accountUrl ||
      "",
  ).trim();
}

function resolveMonitorRunnerName(runItem = {}, monitorItem = {}) {
  return (
    String(
      runItem.monitorBloggerName ||
        runItem.bloggerNameSnapshot ||
        runItem.bloggerName ||
        monitorItem.bloggerNameSnapshot ||
        monitorItem.bloggerName ||
        monitorItem.platformBloggerId ||
        "",
    ).trim() || "未命名博主"
  );
}

function resolveMonitorRunnerCaptureParams(
  monitorSettings = {},
  captureSettings = {},
) {
  const observeWindowHours =
    MONITOR_OBSERVE_WINDOW_OPTIONS.includes(
      Number(monitorSettings.observeWindowHours),
    )
      ? Number(monitorSettings.observeWindowHours)
      : DEFAULT_MONITOR_SETTINGS.observeWindowHours;
  const defaultMaxDetectedItems =
    MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW[observeWindowHours] ||
    MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW[
      DEFAULT_MONITOR_SETTINGS.observeWindowHours
    ];
  const requestedPostsLimit = Number(monitorSettings.postsLimit);
  const normalizedPostsLimit =
    Number.isSafeInteger(requestedPostsLimit) && requestedPostsLimit > 0
      ? requestedPostsLimit
      : defaultMaxDetectedItems;
  const verifyPublishDateFromDetail =
    captureSettings.verifyPublishDateFromDetail === true;
  const scanLatestPostsByCount =
    captureSettings.scanLatestPostsByCount === true;
  const maxDetectedItems =
    scanLatestPostsByCount
      ? Math.min(MONITOR_LATEST_POSTS_LIMIT_MAX, normalizedPostsLimit)
      : verifyPublishDateFromDetail
      ? Math.min(
          MONITOR_DETAIL_DATE_DISCOVERY_MAX,
          Math.max(
            MONITOR_DETAIL_DATE_DISCOVERY_MIN,
            normalizedPostsLimit * MONITOR_DETAIL_DATE_DISCOVERY_MULTIPLIER,
          ),
        )
      : Math.min(defaultMaxDetectedItems, normalizedPostsLimit);
  const publishBounds = resolveMonitorPublishWindowBounds(monitorSettings);
  const publishWindow = publishBounds.key;
  const isStrictPublishWindow = publishBounds.strict === true;
  const monitorScanLimit = scanLatestPostsByCount
    ? maxDetectedItems
    : verifyPublishDateFromDetail
    ? maxDetectedItems
    : isStrictPublishWindow
      ? Math.min(
          maxDetectedItems,
          publishWindow === MONITOR_PUBLISH_WINDOW.PREVIOUS_DAY ? 20 : 12,
        )
      : maxDetectedItems;
  const likeThreshold = Math.max(
    0,
    Number(monitorSettings.likeThreshold) ||
      DEFAULT_MONITOR_SETTINGS.likeThreshold,
  );

  return {
    includeBloggerProfileRecord: false,
    // 监控先纳入最近动态；点赞阈值用于后续判断，不在采集阶段过滤。
    minLikes: 0,
    maxDetectedItems: Math.floor(monitorScanLimit),
    monitorLikeThreshold: Math.floor(likeThreshold),
    // 账号作品列表不一定提供可信发布时间。官方账号评论巡查先把列表当作
    // 候选来源，进入详情页核实日期后再筛选，避免在列表阶段误判。
    monitorPublishWindow:
      verifyPublishDateFromDetail || scanLatestPostsByCount
        ? ""
        : publishWindow,
    monitorObserveWindowHours: observeWindowHours,
    waitMinMs:
      Number(captureSettings.sharedWaitMinMs) ||
      DEFAULT_CAPTURE_SETTINGS.sharedWaitMinMs,
    waitMaxMs:
      Number(captureSettings.sharedWaitMaxMs) ||
      DEFAULT_CAPTURE_SETTINGS.sharedWaitMaxMs,
    stallTimeoutMs:
      Number(captureSettings.sharedStallTimeoutMs) ||
      DEFAULT_CAPTURE_SETTINGS.sharedStallTimeoutMs,
    maxDurationMs:
      Number(captureSettings.sharedMaxDurationMs) ||
      DEFAULT_CAPTURE_SETTINGS.sharedMaxDurationMs,
    maxScrollTimes:
      scanLatestPostsByCount
        ? Math.max(
            20,
            Math.min(60, Math.ceil(Math.floor(monitorScanLimit) / 2)),
          )
        : verifyPublishDateFromDetail || !isStrictPublishWindow
          ? 20
          : 6,
  };
}

function summarizeMonitorSyncResult(syncResult = {}) {
  const results = Array.isArray(syncResult.results) ? syncResult.results : [];
  const successCount = results.filter((item) => item?.success).length;
  const failedCount = results.length - successCount;
  const actionCounts = results.reduce(
    (acc, item) => {
      const raw = item?.rawResponse || {};
      const action = String(raw.action || item?.action || "")
        .trim()
        .toLowerCase();
      if (action === "inserted") {
        acc.inserted += 1;
      } else if (action === "updated") {
        acc.updated += 1;
      }
      const negative = Number(raw?.commentStats?.negative || 0);
      if (Number.isFinite(negative) && negative > 0) {
        acc.negative += negative;
      }
      return acc;
    },
    {inserted: 0, updated: 0, negative: 0},
  );

  return {
    successCount,
    failedCount,
    insertedCount: actionCounts.inserted,
    updatedCount: actionCounts.updated,
    negativeCount: actionCounts.negative,
  };
}

function getShanghaiDayStartMs(timestamp = Date.now()) {
  const normalized = Number(timestamp);
  const safeTimestamp = Number.isFinite(normalized) ? normalized : Date.now();
  return (
    Math.floor((safeTimestamp + MONITOR_SHANGHAI_OFFSET_MS) / MONITOR_DAY_MS) *
      MONITOR_DAY_MS -
    MONITOR_SHANGHAI_OFFSET_MS
  );
}

function getShanghaiDateParts(timestamp = Date.now()) {
  const date = new Date(Number(timestamp) + MONITOR_SHANGHAI_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function buildShanghaiTimestamp({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
}) {
  const timestamp =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millisecond),
    ) - MONITOR_SHANGHAI_OFFSET_MS;
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function parseMonitorCalendarDateStartMs(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return NaN;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = buildShanghaiTimestamp({year, month, day});
  if (!Number.isFinite(timestamp)) {
    return NaN;
  }
  const parts = getShanghaiDateParts(timestamp);
  return parts.year === year && parts.month === month && parts.day === day
    ? timestamp
    : NaN;
}

function resolveMonitorPublishWindowBounds(
  publishWindowOrSettings,
  nowMs = Date.now(),
) {
  const settings =
    publishWindowOrSettings &&
    typeof publishWindowOrSettings === "object" &&
    !Array.isArray(publishWindowOrSettings)
      ? publishWindowOrSettings
      : {publishWindow: publishWindowOrSettings};
  const publishDateFrom = String(settings.publishDateFrom || "").trim();
  const publishDateTo = String(settings.publishDateTo || "").trim();
  const customStartMs = parseMonitorCalendarDateStartMs(publishDateFrom);
  const customEndStartMs = parseMonitorCalendarDateStartMs(publishDateTo);
  if (
    Number.isFinite(customStartMs) &&
    Number.isFinite(customEndStartMs) &&
    customStartMs <= customEndStartMs
  ) {
    return {
      key: "custom",
      label:
        publishDateFrom === publishDateTo
          ? `${publishDateFrom} 发布`
          : `${publishDateFrom} 至 ${publishDateTo} 发布`,
      strict: true,
      startMs: customStartMs,
      endMs: customEndStartMs + MONITOR_DAY_MS,
    };
  }

  const normalized = MONITOR_PUBLISH_WINDOW_OPTIONS.has(settings.publishWindow)
    ? settings.publishWindow
    : DEFAULT_MONITOR_SETTINGS.publishWindow;

  if (normalized === MONITOR_PUBLISH_WINDOW.PREVIOUS_DAY) {
    const todayStartMs = getShanghaiDayStartMs(nowMs);
    return {
      key: normalized,
      label: "昨天发布",
      strict: true,
      startMs: todayStartMs - MONITOR_DAY_MS,
      endMs: todayStartMs,
    };
  }

  if (normalized === MONITOR_PUBLISH_WINDOW.LAST_24H) {
    return {
      key: normalized,
      label: "最近 24 小时发布",
      strict: true,
      startMs: nowMs - MONITOR_DAY_MS,
      endMs: nowMs,
    };
  }

  return resolveMonitorPublishWindowBounds(
    DEFAULT_MONITOR_SETTINGS.publishWindow,
    nowMs,
  );
}

function cleanMonitorPublishText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^发布时间[:：]?\s*/i, "")
    .replace(/^发布于[:：]?\s*/i, "")
    .replace(/^编辑于\s*/i, "")
    .replace(/^·\s*/, "")
    .trim();
}

function createMonitorPublishMoment(
  timestamp,
  {precision = "exact", raw = ""} = {},
) {
  const normalized = Number(timestamp);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  if (precision === "date") {
    const startMs = getShanghaiDayStartMs(normalized);
    return {
      ok: true,
      raw,
      precision: "date",
      timestampMs: startMs,
      startMs,
      endMs: startMs + MONITOR_DAY_MS,
    };
  }
  return {
    ok: true,
    raw,
    precision: "exact",
    timestampMs: normalized,
    startMs: normalized,
    endMs: normalized,
  };
}

function parseMonitorNumericPublishMoment(value, raw = "") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const timestampMs = numeric < 100000000000 ? numeric * 1000 : numeric;
  return createMonitorPublishMoment(timestampMs, {raw});
}

function resolveYearForMonthDay(month, day, nowMs, hour = 0, minute = 0) {
  const {year} = getShanghaiDateParts(nowMs);
  const timestamp = buildShanghaiTimestamp({year, month, day, hour, minute});
  if (Number.isFinite(timestamp) && timestamp > nowMs + MONITOR_DAY_MS) {
    return year - 1;
  }
  return year;
}

function parseMonitorPublishMoment(value, nowMs = Date.now()) {
  if (value instanceof Date) {
    return createMonitorPublishMoment(value.getTime(), {
      raw: value.toISOString(),
    });
  }
  if (typeof value === "number") {
    return parseMonitorNumericPublishMoment(value, String(value));
  }

  const text = cleanMonitorPublishText(value);
  if (!text) {
    return null;
  }

  if (/^\d{10,13}$/.test(text)) {
    return parseMonitorNumericPublishMoment(text, text);
  }

  if (/^\d{4}-\d{2}-\d{2}T/i.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return createMonitorPublishMoment(parsed, {raw: text});
    }
  }

  let match = text.match(
    /(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?(?:\s+|T)?(\d{1,2})[:：](\d{2})/,
  );
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day, hour, minute}),
      {raw: text},
    );
  }

  match = text.match(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?/);
  if (match) {
    const [, year, month, day] = match;
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day}),
      {precision: "date", raw: text},
    );
  }

  match = text.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, month, day, hour, minute] = match;
    const year = resolveYearForMonthDay(month, day, nowMs, hour, minute);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day, hour, minute}),
      {raw: text},
    );
  }

  match = text.match(/(\d{1,2})[-/.](\d{1,2})\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, month, day, hour, minute] = match;
    const year = resolveYearForMonthDay(month, day, nowMs, hour, minute);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day, hour, minute}),
      {raw: text},
    );
  }

  match = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (match) {
    const [, month, day] = match;
    const year = resolveYearForMonthDay(month, day, nowMs);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day}),
      {precision: "date", raw: text},
    );
  }

  match = text.match(/(\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    const [, month, day] = match;
    const year = resolveYearForMonthDay(month, day, nowMs);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day}),
      {precision: "date", raw: text},
    );
  }

  match = text.match(/今天\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, hour, minute] = match;
    const {year, month, day} = getShanghaiDateParts(nowMs);
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day, hour, minute}),
      {raw: text},
    );
  }

  match = text.match(/昨天\s*(?:(\d{1,2})[:：](\d{2}))?/);
  if (match) {
    const {year, month, day} = getShanghaiDateParts(nowMs);
    const hour = match[1] || 0;
    const minute = match[2] || 0;
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day: day - 1, hour, minute}),
      {precision: match[1] ? "exact" : "date", raw: text},
    );
  }

  match = text.match(/前天\s*(?:(\d{1,2})[:：](\d{2}))?/);
  if (match) {
    const {year, month, day} = getShanghaiDateParts(nowMs);
    const hour = match[1] || 0;
    const minute = match[2] || 0;
    return createMonitorPublishMoment(
      buildShanghaiTimestamp({year, month, day: day - 2, hour, minute}),
      {precision: match[1] ? "exact" : "date", raw: text},
    );
  }

  match = text.match(/(\d+)\s*分钟前/);
  if (match) {
    return createMonitorPublishMoment(nowMs - Number(match[1]) * 60 * 1000, {
      raw: text,
    });
  }

  match = text.match(/(\d+)\s*小时前/);
  if (match) {
    return createMonitorPublishMoment(nowMs - Number(match[1]) * 60 * 60 * 1000, {
      raw: text,
    });
  }

  match = text.match(/(\d+)\s*天前\s*(?:(\d{1,2})[:：](\d{2}))?/);
  if (match) {
    const days = Number(match[1]) || 0;
    if (match[2]) {
      const {year, month, day} = getShanghaiDateParts(nowMs);
      return createMonitorPublishMoment(
        buildShanghaiTimestamp({
          year,
          month,
          day: day - days,
          hour: match[2],
          minute: match[3] || 0,
        }),
        {raw: text},
      );
    }
    const dayStartMs = getShanghaiDayStartMs(nowMs - days * MONITOR_DAY_MS);
    return createMonitorPublishMoment(dayStartMs, {
      precision: "date",
      raw: text,
    });
  }

  if (/刚刚|刚才|现在/.test(text)) {
    return createMonitorPublishMoment(nowMs, {raw: text});
  }

  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    return createMonitorPublishMoment(parsed, {raw: text});
  }

  return null;
}

function collectMonitorPublishCandidates(
  record = {},
  {detailOnly = false} = {},
) {
  const payload =
    record?.payload && typeof record.payload === "object" ? record.payload : {};
  const item =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const detail =
    payload.detailPayload && typeof payload.detailPayload === "object"
      ? payload.detailPayload
      : {};

  const detailCandidates = [
    {value: detail.publishTimestamp, source: "detail.publishTimestamp"},
    {value: detail.publishTime, source: "detail.publishTime"},
    {value: detail.publishDateRaw, source: "detail.publishDateRaw"},
    {value: detail.lastEditedAt, source: "detail.lastEditedAt"},
    {value: detail.publishDate, source: "detail.publishDate"},
  ];
  if (detailOnly) {
    return detailCandidates;
  }

  return [
    ...detailCandidates,
    {value: item.publishTimestamp, source: "item.publishTimestamp"},
    {value: item.publishTime, source: "item.publishTime"},
    {value: item.publishDateRaw, source: "item.publishDateRaw"},
    {value: item.lastEditedAt, source: "item.lastEditedAt"},
    {value: item.publishDate, source: "item.publishDate"},
    {value: payload.publishTimestamp, source: "payload.publishTimestamp"},
    {value: payload.publishTime, source: "payload.publishTime"},
    {value: payload.publishDateRaw, source: "payload.publishDateRaw"},
    {value: payload.lastEditedAt, source: "payload.lastEditedAt"},
    {value: payload.publishDate, source: "payload.publishDate"},
  ];
}

function isLikelyFallbackCaptureTime(
  record,
  candidate,
  moment,
  {detailOnly = false} = {},
) {
  const source = String(candidate?.source || "");
  if (!/lastEditedAt/i.test(source) || !moment?.timestampMs) {
    return false;
  }

  const rawDateSignals = collectMonitorPublishCandidates(record, {
    detailOnly,
  }).some((item) => {
    const candidateSource = String(item.source || "");
    return (
      !/lastEditedAt/i.test(candidateSource) &&
      cleanMonitorPublishText(item.value)
    );
  });
  if (rawDateSignals) {
    return false;
  }

  const payload =
    record?.payload && typeof record.payload === "object" ? record.payload : {};
  const detail =
    payload.detailPayload && typeof payload.detailPayload === "object"
      ? payload.detailPayload
      : {};
  const captureTimestamp = Number(
    detail.captureTimestamp ||
      payload.detailCaptureFinishedAt ||
      payload.captureTimestamp ||
      record.updatedAt ||
      0,
  );
  return (
    Number.isFinite(captureTimestamp) &&
    captureTimestamp > 0 &&
    Math.abs(moment.timestampMs - captureTimestamp) <= 2 * 60 * 1000
  );
}

function resolveMonitorRecordPublishMoment(
  record,
  nowMs = Date.now(),
  {detailOnly = false} = {},
) {
  const candidates = collectMonitorPublishCandidates(record, {detailOnly});
  for (const candidate of candidates) {
    const moment = parseMonitorPublishMoment(candidate.value, nowMs);
    if (!moment) {
      continue;
    }
    if (
      isLikelyFallbackCaptureTime(record, candidate, moment, {detailOnly})
    ) {
      continue;
    }
    return {
      ...moment,
      source: candidate.source,
    };
  }
  return null;
}

function isMonitorPublishMomentInWindow(moment, bounds) {
  if (!bounds?.strict) {
    return true;
  }
  if (!moment?.ok) {
    return false;
  }
  if (moment.precision === "date") {
    return moment.startMs >= bounds.startMs && moment.endMs <= bounds.endMs;
  }
  return moment.timestampMs >= bounds.startMs && moment.timestampMs < bounds.endMs;
}

function reportMonitorRunProgress(
  onProgress,
  progress = {},
  fallbackMessage = "",
) {
  const message =
    String(progress?.message || fallbackMessage || "").trim() ||
    "正在处理账号巡查...";
  showProgress(message);
  if (typeof onProgress === "function") {
    Promise.resolve(
      onProgress({
        ...progress,
        message,
        updatedAt: new Date().toISOString(),
      }),
    ).catch((error) => {
      console.warn("[Sidebar] Monitor progress callback failed:", error);
    });
  }
  return message;
}

async function resolveMonitorRecordIdsForPublishWindow({
  recordIds = [],
  monitorSettings = {},
  captureSettings = {},
  displayName = "",
  index = 0,
  total = 1,
  shouldStop = null,
  onProgress = null,
} = {}) {
  const uniqueRecordIds = [...new Set(recordIds.filter(Boolean))];
  const verifyPublishDateFromDetail =
    captureSettings.verifyPublishDateFromDetail === true;
  const scanLatestPostsByCount =
    captureSettings.scanLatestPostsByCount === true;
  if (scanLatestPostsByCount) {
    const requestedPostsLimit = Number(monitorSettings.postsLimit);
    const selectedIds =
      Number.isSafeInteger(requestedPostsLimit) && requestedPostsLimit > 0
        ? uniqueRecordIds.slice(0, requestedPostsLimit)
        : uniqueRecordIds;
    return {
      recordIds: selectedIds,
      scannedCount: uniqueRecordIds.length,
      filteredCount: Math.max(0, uniqueRecordIds.length - selectedIds.length),
      unknownCount: 0,
      windowLabel: `最近 ${selectedIds.length} 篇`,
      detailResult: null,
    };
  }
  const bounds = resolveMonitorPublishWindowBounds(monitorSettings);

  if (!bounds.strict || uniqueRecordIds.length === 0) {
    return {
      recordIds: uniqueRecordIds,
      scannedCount: uniqueRecordIds.length,
      filteredCount: 0,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult: null,
    };
  }

  let detailCandidateIds = uniqueRecordIds;
  if (!verifyPublishDateFromDetail) {
    const preRecords = await getRecords(uniqueRecordIds);
    const preRecordById = new Map(
      preRecords.map((record) => [record.id, record]),
    );
    const prefilterNowMs = Date.now();
    detailCandidateIds = uniqueRecordIds.filter((recordId) => {
      const moment = resolveMonitorRecordPublishMoment(
        preRecordById.get(recordId),
        prefilterNowMs,
      );
      return (
        !moment || isMonitorPublishMomentInWindow(moment, bounds)
      );
    });
  }

  if (detailCandidateIds.length === 0) {
    return {
      recordIds: [],
      scannedCount: uniqueRecordIds.length,
      filteredCount: uniqueRecordIds.length,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult: null,
    };
  }

  if (typeof shouldStop === "function" && shouldStop()) {
    return {
      recordIds: [],
      scannedCount: uniqueRecordIds.length,
      filteredCount: uniqueRecordIds.length,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult: {canceled: true},
      canceled: true,
    };
  }

  reportMonitorRunProgress(
    onProgress,
    {
      phase: "profile_publish_date_verification",
      current: 0,
      total: detailCandidateIds.length,
    },
    `正在读取发布时间 (${index + 1}/${total})：${displayName} · ${bounds.label}`,
  );
  const detailResult = await runEnhancementWithSingleRetry({
    recordIds: detailCandidateIds,
    shouldStop,
    onRetryScheduled: ({recordIds: retryRecordIds, retryCount, maxRetries}) => {
      reportMonitorRunProgress(
        onProgress,
        {
          phase: "profile_publish_date_retry_waiting",
          current: 0,
          total: retryRecordIds.length,
          autoRetryCount: retryCount,
          autoRetryMaxRetries: maxRetries,
        },
        `发布时间读取工作页中断，正在续跑剩余 ${retryRecordIds.length} 条`,
      );
    },
    runAttempt: async (attemptRecordIds, attemptContext = {}) => {
      const isRetry = attemptContext.isRetry === true;
      const retryLabel = isRetry
        ? `${attemptContext.retryCount}/${attemptContext.maxRetries}`
        : "";
      return await batchCaptureDetailsForRecords(attemptRecordIds, {
        shouldStop,
        onProgress: (progress = {}) => {
          const detailMessage =
            String(progress.message || "").trim() || "正在补采作品详情...";
          reportMonitorRunProgress(
            onProgress,
            {
              ...progress,
              phase: isRetry
                ? "profile_publish_date_retry"
                : String(
                    progress.phase ||
                      "profile_publish_date_verification",
                  ),
              autoRetryCount: isRetry ? attemptContext.retryCount : 0,
              autoRetryMaxRetries: isRetry
                ? attemptContext.maxRetries
                : 0,
            },
            `正在读取发布时间 (${index + 1}/${total})：${displayName} · ${
              isRetry ? `续跑 ${retryLabel} · ` : ""
            }${detailMessage}`,
          );
        },
        includeComments: false,
        includeBloggerMetrics: false,
        // 发布时间必须来自本轮真实进入详情页后的结果。即使此前采过详情，
        // 也不能复用旧快照，否则会把旧日期误当作本轮巡查证据。
        skipAlreadyCaptured: false,
        detailNavTimeoutMs: captureSettings.detailNavTimeoutMs,
        detailAfterNavWaitMs: captureSettings.detailAfterNavWaitMs,
        profileAfterNavWaitMs: captureSettings.profileAfterNavWaitMs,
      });
    },
  });

  const stoppedByCaller =
    typeof shouldStop === "function" && shouldStop();
  const terminalError = detailResult?.canceled || stoppedByCaller
    ? {
        errorCode: "capture_canceled",
        errorMessage: "发布时间读取已取消",
        canceled: true,
      }
    : detailResult?.securityBlocked
      ? {
          errorCode: "capture_security_blocked",
          errorMessage: "发布时间读取遇到安全验证，已停止巡查",
        }
      : detailResult?.runnerInterrupted
        ? {
            errorCode: "capture_runner_interrupted",
            errorMessage: "发布时间读取工作页已关闭或中断",
          }
        : null;
  if (terminalError) {
    return {
      recordIds: [],
      scannedCount: uniqueRecordIds.length,
      filteredCount: uniqueRecordIds.length,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult,
      failed: true,
      ...terminalError,
    };
  }

  const detailItems = Array.isArray(detailResult?.results)
    ? detailResult.results
    : [];
  const successfulDetailRecordIds = detailItems
    .filter(
      (item) =>
        item?.ok === true &&
        item?.filtered !== true &&
        item?.reason !== "already_captured",
    )
    .map((item) => item?.recordId)
    .filter((recordId) => detailCandidateIds.includes(recordId));
  const successfulDetailRecordIdSet = new Set(successfulDetailRecordIds);
  const failedDetailCount = detailCandidateIds.filter(
    (recordId) => !successfulDetailRecordIdSet.has(recordId),
  ).length;
  if (detailResult?.ok === false || failedDetailCount > 0) {
    const firstFailure = detailItems.find((item) => item?.ok === false);
    const failureMessage =
      String(
        firstFailure?.diagnosticMessage ||
          firstFailure?.message ||
          detailResult?.error?.message ||
          "",
      ).trim() || "部分作品未能完成发布时间读取";
    return {
      recordIds: [],
      scannedCount: uniqueRecordIds.length,
      filteredCount: uniqueRecordIds.length,
      unknownCount: 0,
      windowLabel: bounds.label,
      detailResult,
      failed: true,
      errorCode: "publish_date_capture_failed",
      errorMessage: failureMessage,
      successfulDetailCount: successfulDetailRecordIds.length,
      failedDetailCount,
    };
  }

  // 只读取本轮明确成功的详情记录；不得让失败项沿用数据库里的旧详情日期。
  const records = await getRecords(successfulDetailRecordIds);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const selectedIds = [];
  let unknownCount = 0;
  const nowMs = Date.now();

  successfulDetailRecordIds.forEach((recordId) => {
    const record = recordById.get(recordId);
    const moment = resolveMonitorRecordPublishMoment(record, nowMs, {
      detailOnly: verifyPublishDateFromDetail,
    });
    if (!moment) {
      unknownCount += 1;
      return;
    }
    if (isMonitorPublishMomentInWindow(moment, bounds)) {
      selectedIds.push(recordId);
    }
  });

  if (unknownCount > 0) {
    return {
      recordIds: [],
      scannedCount: uniqueRecordIds.length,
      filteredCount: uniqueRecordIds.length,
      unknownCount,
      windowLabel: bounds.label,
      detailResult,
      failed: true,
      errorCode: "publish_date_unknown",
      errorMessage: `${unknownCount} 篇作品未能读取到可信的发布时间`,
      successfulDetailCount: successfulDetailRecordIds.length,
      failedDetailCount: 0,
    };
  }

  const requestedPostsLimit = Number(monitorSettings.postsLimit);
  const limitedSelectedIds =
    Number.isSafeInteger(requestedPostsLimit) && requestedPostsLimit > 0
      ? selectedIds.slice(0, requestedPostsLimit)
      : selectedIds;

  return {
    recordIds: limitedSelectedIds,
    scannedCount: uniqueRecordIds.length,
    filteredCount: Math.max(
      0,
      uniqueRecordIds.length - limitedSelectedIds.length,
    ),
    unknownCount,
    windowLabel: bounds.label,
    detailResult,
  };
}

async function finishMonitorExecutionSafely(executionId, result = {}) {
  if (!executionId) {
    return {ok: false, message: "missing execution id"};
  }

  try {
    return await finishMonitorExecution(executionId, result);
  } catch (error) {
    console.warn("[Sidebar] Finish monitor execution failed:", error);
    return {
      ok: false,
      message: error?.message || "finish monitor execution failed",
    };
  }
}

async function runMonitorCommentPatrolWithCaptureTaskSession({
  platform = "",
  runnerTabId = null,
  captureTaskContext = null,
  shouldStop = null,
  run = null,
} = {}) {
  if (typeof run !== "function") {
    const error = new Error("评论巡查缺少详情采集执行器");
    error.code = "COMMENT_PATROL_RUNNER_REQUIRED";
    throw error;
  }

  const taskId = String(captureTaskContext?.taskId || "").trim();
  if (!taskId) {
    return await run();
  }

  const normalizedPlatform = String(platform || "")
    .trim()
    .toLowerCase();
  const normalizedRunnerTabId = Number(runnerTabId);
  if (!supportsPersistentCaptureTaskPlatform(normalizedPlatform)) {
    const error = new Error("官方账号评论巡查仅支持小红书和抖音");
    error.code = "capture_task_platform_unsupported";
    throw error;
  }
  if (
    !Number.isSafeInteger(normalizedRunnerTabId) ||
    normalizedRunnerTabId <= 0
  ) {
    const error = new Error("官方账号评论巡查缺少有效的账号页面");
    error.code = "invalid_capture_task_source_tab";
    throw error;
  }

  await startRequiredCaptureTaskSession({
    taskId,
    attemptId: String(captureTaskContext?.attemptId || "").trim(),
    tabId: normalizedRunnerTabId,
    label:
      String(captureTaskContext?.label || "").trim() ||
      "官方账号评论巡查",
    platform: normalizedPlatform,
    ownerRequired: captureTaskContext?.ownerRequired !== false,
  });

  let result = null;
  let runError = null;
  try {
    result = await run();
  } catch (error) {
    runError = error;
  }

  let stopped = false;
  try {
    stopped = typeof shouldStop === "function" && shouldStop() === true;
  } catch {
    stopped = true;
  }
  const canceled = stopped || result?.canceled === true;
  const taskStatus = runError
    ? "failed"
    : canceled
      ? "canceled"
      : result?.ok === false || Number(result?.failedCount || 0) > 0
        ? "completed_with_failures"
        : "completed";
  const terminal = resolveCaptureTaskTerminalStatus({
    taskStatus,
    error: runError,
    canceled,
  });

  let captureTaskEnd = null;
  try {
    captureTaskEnd = await endCaptureTaskSession({
      taskId,
      ...terminal,
    });
  } catch (error) {
    captureTaskEnd = {ok: false, error};
  }
  const captureTaskEnded =
    captureTaskEnd?.ok === true ||
    captureTaskEnd?.reason === "capture_task_not_found" ||
    captureTaskEnd?.response?.error?.code === "capture_task_not_found";
  if (captureTaskEnded) {
    releaseCaptureTaskOwner(taskId);
  } else {
    const cleanupError = new Error(
      captureTaskEnd?.response?.error?.message ||
        captureTaskEnd?.error?.message ||
        "评论巡查结束后浏览器接管未能安全释放",
    );
    cleanupError.code = String(
      captureTaskEnd?.response?.error?.code ||
        captureTaskEnd?.reason ||
        "CAPTURE_TASK_CLEANUP_FAILED",
    ).trim();
    if (runError) cleanupError.cause = runError;
    throw cleanupError;
  }

  if (runError) throw runError;
  return result;
}

async function executeMonitorRunItem({
  runItem = {},
  monitorItem = {},
  index = 0,
  total = 1,
  monitorSettings = {},
  captureSettings = {},
  runnerTabId = null,
  executionPreclaimed = false,
  captureTaskContext = null,
  shouldStop = null,
  onProgress = null,
} = {}) {
  const subscriptionId = String(
    runItem.subscriptionId || monitorItem.id || "",
  ).trim();
  const executionId = String(runItem.executionId || "").trim();
  const platform = normalizeMonitorRunnerPlatform(
    runItem.platform || monitorItem.platform,
  );
  const accountUrl = resolveMonitorRunnerAccountUrl(runItem, monitorItem);
  const displayName = resolveMonitorRunnerName(runItem, monitorItem);
  const baseResult = {
    ...runItem,
    subscriptionId,
    executionId,
    platform,
    monitorBloggerName: displayName,
    monitorBloggerUrl: accountUrl,
    bloggerUrl: accountUrl,
    scannedCount: 0,
    hitCount: 0,
  };

  if (!executionId) {
    return {
      ...baseResult,
      status: "failed",
      errorCode: "missing_execution_id",
      errorMessage: "缺少监控执行任务 ID",
    };
  }

  if (!accountUrl) {
    await finishMonitorExecutionSafely(executionId, {
      status: "failed",
      errorMessage: "监控账号主页链接为空",
    });
    return {
      ...baseResult,
      status: "failed",
      errorCode: "missing_account_url",
      errorMessage: "监控账号主页链接为空",
    };
  }

  if (typeof shouldStop === "function" && shouldStop()) {
    await finishMonitorExecutionSafely(executionId, {
      status: "failed",
      errorMessage: "采集已取消",
    });
    return {
      ...baseResult,
      status: "failed",
      errorCode: "capture_canceled",
      errorMessage: "采集已取消",
    };
  }

  try {
    reportMonitorRunProgress(
      onProgress,
      {
        phase: "profile_scan_start",
        current: 0,
        total,
      },
      `正在扫描监控账号 (${index + 1}/${total})：${displayName}`,
    );

    if (!executionPreclaimed) {
      const startResult = await startMonitorExecution(executionId);
      if (!startResult?.ok) {
        const errorMessage =
          String(startResult?.message || "").trim() ||
          "该账号扫描已被其他执行端领取或已结束";
        console.warn(
          "[Sidebar] Monitor execution is no longer claimable:",
          startResult,
        );
        return {
          ...baseResult,
          status: "failed",
          errorCode: "monitor_execution_not_claimable",
          errorMessage,
        };
      }
    }

    const captureResult = await batchCaptureByUrls({
      urls: [accountUrl],
      mode: "blogger_notes",
      ...(Number.isSafeInteger(Number(runnerTabId)) &&
      Number(runnerTabId) > 0
        ? {runnerTabId: Number(runnerTabId)}
        : {}),
      captureParams: resolveMonitorRunnerCaptureParams(
        monitorSettings,
        captureSettings,
      ),
      onProgress: (progress = {}) => {
        const captureMessage =
          String(progress.message || "").trim() || "正在采集账号作品...";
        reportMonitorRunProgress(
          onProgress,
          {
            ...progress,
            phase: String(progress.phase || "profile_list_capture"),
          },
          `正在扫描监控账号 (${index + 1}/${total})：${displayName} · ${captureMessage}`,
        );
      },
      shouldStop,
    });
    const recordIds = collectBatchRecordIds(captureResult);
    const captureFailure = cloudTargetedPostApi.projectCaptureFailure(
      [
        captureResult,
        ...(Array.isArray(captureResult?.results)
          ? captureResult.results
          : []),
      ],
      {
        fallbackCode: "CAPTURE_FAILED",
        stage: "profile_scan",
        fallbackMessage: "采集账号作品失败",
      },
    );
    const incompleteCaptureEntries = Array.isArray(captureResult?.results)
      ? captureResult.results.filter(
          (entry) => entry?.partial === true || entry?.scanComplete === false,
        )
      : [];
    const profileScanComplete = Boolean(
      captureResult?.scanComplete === true &&
        captureResult?.partial !== true &&
        incompleteCaptureEntries.length === 0,
    );

    if (captureFailure.requiresManualAction === true) {
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        recordsFound: recordIds.length,
        errorMessage: captureFailure.message,
      });
      return {
        ...baseResult,
        status: "failed",
        scannedCount: recordIds.length,
        hitCount: 0,
        errorCode: captureFailure.code,
        errorCategory: captureFailure.category || "platform_safety_block",
        errorMessage: captureFailure.message,
        securityBlocked: captureFailure.securityBlocked === true,
        platformSafetyBlocked:
          captureFailure.platformSafetyBlocked === true,
        requiresManualAction: true,
        retryable: false,
        securityEvidence: captureFailure.securityEvidence || null,
        error: captureFailure,
      };
    }

    if (captureResult?.canceled) {
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        recordsFound: recordIds.length,
        errorMessage: "采集已取消",
      });
      return {
        ...baseResult,
        status: "failed",
        scannedCount: recordIds.length,
        hitCount: 0,
        errorCode: "capture_canceled",
        errorMessage: "采集已取消",
      };
    }

    if (!profileScanComplete) {
      const incompleteFailure = cloudTargetedPostApi.projectCaptureFailure(
        [
          ...incompleteCaptureEntries.map((entry) => entry?.error),
          ...incompleteCaptureEntries,
          captureResult?.error,
          captureResult,
        ],
        {
          fallbackCode: "PROFILE_SCAN_INCOMPLETE",
          stage: "profile_scan",
          fallbackMessage:
            "账号作品列表未完整采集，已保留本轮结果并等待重试",
        },
      );
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        recordsFound: recordIds.length,
        errorMessage: incompleteFailure.message,
      });
      return {
        ...baseResult,
        status: "failed",
        partial: true,
        scanComplete: false,
        incompleteReason: String(
          captureResult?.incompleteReason || "partial_capture",
        ),
        scannedCount: recordIds.length,
        hitCount: 0,
        errorCode: incompleteFailure.code,
        errorCategory: incompleteFailure.category || "capture_incomplete",
        errorMessage: incompleteFailure.message,
        retryable: incompleteFailure.retryable !== false,
        error: incompleteFailure,
        captureResult,
      };
    }

    if (!captureResult?.ok && recordIds.length === 0) {
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        errorMessage: captureFailure.message,
      });
      return {
        ...baseResult,
        status: "failed",
        errorCode: captureFailure.code,
        errorCategory: captureFailure.category || "",
        errorMessage: captureFailure.message,
        retryable: captureFailure.retryable,
        error: captureFailure,
      };
    }

    if (recordIds.length === 0) {
      await finishMonitorExecutionSafely(executionId, {
        status: "succeeded",
        recordsFound: 0,
        newRecords: 0,
        updatedRecords: 0,
        negativeCount: 0,
      });
      return {
        ...baseResult,
        status: "no_hit",
        noResults: true,
        resultKind: "profile_scan_no_new_posts",
        businessOutcome: "profile_scan_no_new_posts",
        qualifyingCount: 0,
        scanComplete: true,
        scannedCount: 0,
        hitCount: 0,
      };
    }

    const publishFilterResult = await resolveMonitorRecordIdsForPublishWindow({
      recordIds,
      monitorSettings,
      captureSettings,
      displayName,
      index,
      total,
      shouldStop,
      onProgress,
    });

    if (publishFilterResult.canceled) {
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        recordsFound: recordIds.length,
        errorMessage: "采集已取消",
      });
      return {
        ...baseResult,
        status: "failed",
        scannedCount: publishFilterResult.scannedCount,
        hitCount: 0,
        errorCode: "capture_canceled",
        errorMessage: "采集已取消",
        captureResult,
        detailResult: publishFilterResult.detailResult,
      };
    }
    if (publishFilterResult.failed) {
      const errorCode =
        String(publishFilterResult.errorCode || "").trim() ||
        "publish_date_capture_failed";
      const errorMessage =
        String(publishFilterResult.errorMessage || "").trim() ||
        "作品发布时间核验失败";
      await finishMonitorExecutionSafely(executionId, {
        status: "failed",
        recordsFound: 0,
        errorMessage,
      });
      return {
        ...baseResult,
        status: "failed",
        scannedCount: publishFilterResult.scannedCount,
        hitCount: 0,
        filteredCount: publishFilterResult.filteredCount,
        unknownPublishTimeCount: publishFilterResult.unknownCount,
        publishWindowLabel: publishFilterResult.windowLabel,
        errorCode,
        errorMessage,
        captureResult,
        detailResult: publishFilterResult.detailResult,
      };
    }
    const hitRecordIds = publishFilterResult.recordIds;

    if (hitRecordIds.length === 0) {
      await finishMonitorExecutionSafely(executionId, {
        status: "succeeded",
        recordsFound: 0,
        newRecords: 0,
        updatedRecords: 0,
        negativeCount: 0,
      });
      return {
        ...baseResult,
        status: "no_hit",
        noResults: true,
        resultKind: "profile_scan_no_new_posts",
        businessOutcome: "profile_scan_no_new_posts",
        qualifyingCount: 0,
        scanComplete: true,
        scannedCount: publishFilterResult.scannedCount,
        hitCount: 0,
        filteredCount: publishFilterResult.filteredCount,
        unknownPublishTimeCount: publishFilterResult.unknownCount,
        publishWindowLabel: publishFilterResult.windowLabel,
        captureResult,
        detailResult: publishFilterResult.detailResult,
      };
    }

    const shouldCaptureComments =
      captureSettings.includeComments === true ||
      captureSettings.includeCommentsOnDetailCapture === true;
    let commentDetailResult = null;
    if (shouldCaptureComments) {
      reportMonitorRunProgress(
        onProgress,
        {
          phase: "profile_comment_patrol",
          current: 0,
          total: hitRecordIds.length,
        },
        `正在巡查账号评论 (${index + 1}/${total})：${displayName} · ${hitRecordIds.length} 条作品`,
      );
      commentDetailResult =
        await runMonitorCommentPatrolWithCaptureTaskSession({
          platform,
          runnerTabId,
          captureTaskContext,
          shouldStop,
          run: async () =>
            await runEnhancementWithSingleRetry({
              recordIds: hitRecordIds,
              shouldStop,
              onRetryScheduled: ({
                recordIds: retryRecordIds,
                retryCount,
                maxRetries,
              }) => {
                reportMonitorRunProgress(
                  onProgress,
                  {
                    phase: "profile_comment_retry_waiting",
                    current: 0,
                    total: retryRecordIds.length,
                    autoRetryCount: retryCount,
                    autoRetryMaxRetries: maxRetries,
                  },
                  `评论巡查工作页中断，正在续跑剩余 ${retryRecordIds.length} 条`,
                );
              },
              runAttempt: async (attemptRecordIds, attemptContext = {}) => {
                const isRetry = attemptContext.isRetry === true;
                const retryLabel = isRetry
                  ? `${attemptContext.retryCount}/${attemptContext.maxRetries}`
                  : "";
                return await batchCaptureDetailsForRecords(attemptRecordIds, {
                  shouldStop,
                  onProgress: (progress = {}) => {
                    const commentMessage =
                      String(progress.message || "").trim() ||
                      "正在采集作品评论...";
                    reportMonitorRunProgress(
                      onProgress,
                      {
                        ...progress,
                        phase: isRetry
                          ? "profile_comment_retry"
                          : String(
                              progress.phase || "profile_comment_patrol",
                            ),
                        autoRetryCount: isRetry
                          ? attemptContext.retryCount
                          : 0,
                        autoRetryMaxRetries: isRetry
                          ? attemptContext.maxRetries
                          : 0,
                      },
                      `正在巡查账号评论 (${index + 1}/${total})：${displayName} · ${
                        isRetry ? `续跑 ${retryLabel} · ` : ""
                      }${commentMessage}`,
                    );
                  },
                  includeComments: true,
                  includeBloggerMetrics: false,
                  // 官方账号评论巡查每次都要重新进入命中作品采评论，不能被
                  // “已采过详情”的增量规则跳过。
                  skipAlreadyCaptured: false,
                  enableAiRelevancePrefilter: false,
                  commentsMaxDetectedItems:
                    captureSettings.detailCommentsMaxDetectedItems ??
                    captureSettings.commentsMaxDetectedItems ??
                    50,
                  detailNavTimeoutMs: captureSettings.detailNavTimeoutMs,
                  detailAfterNavWaitMs: captureSettings.detailAfterNavWaitMs,
                  profileAfterNavWaitMs: captureSettings.profileAfterNavWaitMs,
                  waitForegroundTabId:
                    Number.isSafeInteger(Number(runnerTabId)) &&
                    Number(runnerTabId) > 0
                      ? Number(runnerTabId)
                      : null,
                  captureTaskId: String(
                    captureTaskContext?.taskId || "",
                  ).trim(),
                });
              },
            }),
        });

      if (
        commentDetailResult?.canceled ||
        (typeof shouldStop === "function" && shouldStop())
      ) {
        await finishMonitorExecutionSafely(executionId, {
          status: "failed",
          recordsFound: hitRecordIds.length,
          errorMessage: "评论巡查已取消",
        });
        return {
          ...baseResult,
          status: "failed",
          scannedCount: publishFilterResult.scannedCount,
          hitCount: 0,
          filteredCount: publishFilterResult.filteredCount,
          unknownPublishTimeCount: publishFilterResult.unknownCount,
          publishWindowLabel: publishFilterResult.windowLabel,
          errorCode: "capture_canceled",
          errorMessage: "评论巡查已取消",
          captureResult,
          publishDetailResult: publishFilterResult.detailResult,
          detailResult: commentDetailResult,
        };
      }
    }

    showProgress(
      `正在同步监控命中 (${index + 1}/${total})：${displayName} · ${hitRecordIds.length}/${publishFilterResult.scannedCount} 条符合${publishFilterResult.windowLabel}`,
    );
    const syncResult = await syncRecordBatch(
      hitRecordIds,
      (progress = {}) => {
        const message =
          String(progress.message || "").trim() || "正在同步监控命中...";
        showProgress(
          `正在同步监控命中 (${index + 1}/${total})：${displayName} · ${message}`,
        );
      },
      {
        trigger: "monitor_run_now",
        syncScope: "all",
        monitorExecutionId: executionId,
        captureTaskId: String(
          captureTaskContext?.captureTaskId || "",
        ).trim(),
        captureTaskItemAttemptId: String(
          captureTaskContext?.captureTaskItemAttemptId || "",
        ).trim(),
        captureTaskItemRequestHash: String(
          captureTaskContext?.captureTaskItemRequestHash || "",
        ).trim(),
        captureSettings,
        commentLeadsConfig: buildCommentLeadsConfigFromSettings(captureSettings),
        shouldStop,
      },
    );
    const syncStats = summarizeMonitorSyncResult(syncResult);
    const hasSyncFailure =
      !syncResult?.ok || syncStats.failedCount > 0 || syncStats.successCount === 0;
    const hasCommentCaptureFailure =
      shouldCaptureComments &&
      (commentDetailResult?.ok === false ||
        Number(commentDetailResult?.failedCount || 0) > 0);
    const hasTaskFailure = hasSyncFailure || hasCommentCaptureFailure;
    const errorMessage = hasCommentCaptureFailure
      ? `评论巡查部分失败：成功 ${Math.max(
          0,
          Number(commentDetailResult?.successCount) || 0,
        )}，失败 ${Math.max(
          0,
          Number(commentDetailResult?.failedCount) || 0,
        )}`
      : hasSyncFailure
        ? syncResult?.message ||
        syncResult?.error?.message ||
        `监控命中同步失败 ${syncStats.failedCount} 条`
        : "";

    await finishMonitorExecutionSafely(executionId, {
      status: hasTaskFailure ? "failed" : "succeeded",
      recordsFound: hitRecordIds.length,
      newRecords: syncStats.insertedCount,
      updatedRecords: syncStats.updatedCount,
      negativeCount: syncStats.negativeCount,
      errorMessage,
    });

    return {
      ...baseResult,
      status: hasTaskFailure ? "failed" : "success",
      partial: hasTaskFailure,
      scanComplete: !hasTaskFailure,
      incompleteReason: hasTaskFailure
        ? "profile_postprocessing_failed"
        : "",
      scannedCount: publishFilterResult.scannedCount,
      hitCount: syncStats.successCount,
      filteredCount: publishFilterResult.filteredCount,
      unknownPublishTimeCount: publishFilterResult.unknownCount,
      publishWindowLabel: publishFilterResult.windowLabel,
      errorCode: hasCommentCaptureFailure
        ? "comment_capture_failed"
        : hasSyncFailure
          ? "sync_failed"
          : "",
      errorMessage,
      syncResult,
      captureResult,
      publishDetailResult: publishFilterResult.detailResult,
      detailResult: commentDetailResult || publishFilterResult.detailResult,
    };
  } catch (error) {
    const errorMessage = error?.message || "监控执行失败";
    await finishMonitorExecutionSafely(executionId, {
      status: "failed",
      errorMessage,
    });
    return {
      ...baseResult,
      status: "failed",
      errorCode: "runner_failed",
      errorMessage,
    };
  }
}

async function handleRunMonitorNow() {
  if (!isMonitorAuthReady()) {
    showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
    return;
  }

  if (batchUrlCaptureInFlight || batchKeywordCaptureInFlight || monitorRunInFlight) {
    showMessage("已有采集任务执行中，请完成后再执行监控扫描", "warning");
    return;
  }

  const monitor = getCurrentMonitor() || {};
  const activeItems = Array.isArray(monitor.items)
    ? monitor.items.filter(
        (item) =>
          String(item?.status || "").trim() === MONITOR_STATUS.ACTIVE &&
          normalizeMonitorSubjectType(
            item?.subjectType || item?.subject_type,
          ) === MONITOR_SUBJECT_TYPE.CREATOR,
      )
    : [];

  if (activeItems.length === 0) {
    showMessage("暂无启用中的监控项可执行", "info");
    return;
  }

  const startedAt = Date.now();
  monitorRunInFlight = true;
  monitorRunCancelRequested = false;
  showProgress(`正在立即执行 ${activeItems.length} 个监控账号...`);
  try {
    const runtime = getCurrentRuntime() || {};
    let activeTabUrl = "";
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      activeTabUrl = String(activeTab?.url || "").trim();
    } catch {
      activeTabUrl = "";
    }
    const pageUrl = activeTabUrl || String(runtime?.lastPageUrl || "").trim();
    const pagePlatform = detectPlatformFromUrl(pageUrl);
    const filterPlatform = String(monitor?.filters?.platform || "")
      .trim()
      .toLowerCase();
    const currentPlatform =
      pagePlatform === "douyin" ||
      pagePlatform === "xiaohongshu" ||
      pagePlatform === "weibo"
        ? pagePlatform
        : filterPlatform;
    const result = await runMonitorNow({
      subjectType: MONITOR_SUBJECT_TYPE.CREATOR,
      platform:
        currentPlatform === "douyin" ||
        currentPlatform === "xiaohongshu" ||
        currentPlatform === "weibo"
          ? currentPlatform
          : "",
    });
    if (!result?.ok) {
      throw new Error(result?.message || "立即执行失败");
    }

    const data = result.data || {};
    await loadMonitorSubscriptions({force: true});
    const latestMonitor = getCurrentMonitor() || monitor;
    const monitorById = new Map(
      (Array.isArray(latestMonitor.items) ? latestMonitor.items : []).map(
        (item) => [String(item?.id || "").trim(), item],
      ),
    );
    const queuedItems = Array.isArray(data.items) ? data.items : [];
    const captureSettings = await getCaptureSettings();
    const monitorSettings = normalizeMonitorSettingsInput(
      latestMonitor.settings || monitor.settings || DEFAULT_MONITOR_SETTINGS,
    );
    const runItems = [];

    for (let i = 0; i < queuedItems.length; i += 1) {
      if (monitorRunCancelRequested) {
        break;
      }
      const queuedItem = queuedItems[i];
      const subscriptionId = String(queuedItem?.subscriptionId || "").trim();
      const monitorItem = monitorById.get(subscriptionId) || {};
      const runResult = await executeMonitorRunItem({
        runItem: queuedItem,
        monitorItem,
        index: i,
        total: queuedItems.length,
        monitorSettings,
        captureSettings,
        shouldStop: () => monitorRunCancelRequested,
      });
      runItems.push(runResult);
      if (monitorRunCancelRequested) {
        break;
      }
    }

    const finishedAt = Date.now();
    await loadMonitorSubscriptions({force: true});
    const targetTableName = String(
      getCurrentTarget()?.monitorTableName || "",
    ).trim();
    const normalizedRuns = runItems.map((item) => {
      const subscriptionId = String(item?.subscriptionId || "").trim();
      const monitorItem = monitorById.get(subscriptionId) || {};
      const normalizedPlatform = String(
        item?.platform || monitorItem?.platform || "",
      )
        .trim()
        .toLowerCase();
      const state = resolveMonitorRunHistoryState(item);
      const executionId = String(item?.executionId || "").trim();
      const debugUrl = String(item?.debugUrl || "").trim();

      return {
        item,
        state,
        subscriptionId,
        executionId,
        debugUrl,
        platform:
          normalizedPlatform === "douyin" ||
          normalizedPlatform === "xiaohongshu" ||
          normalizedPlatform === "weibo"
            ? normalizedPlatform
            : "unknown",
        monitorBloggerName: String(
          item?.monitorBloggerName ||
            monitorItem?.bloggerNameSnapshot ||
            monitorItem?.bloggerName ||
            "",
        ).trim(),
        monitorBloggerUrl: String(
          item?.monitorBloggerUrl || monitorItem?.bloggerUrl || "",
        ).trim(),
      };
    });

    const counts = normalizedRuns.reduce(
      (acc, current) => {
        if (current.state.monitorStatus === "queued") {
          acc.queued += 1;
        } else if (current.state.monitorStatus === "hit_synced") {
          acc.hitSynced += 1;
        } else if (current.state.monitorStatus === "hit_sync_failed") {
          acc.hitSyncFailed += 1;
        } else if (current.state.monitorStatus === "no_hit") {
          acc.noHit += 1;
        } else if (current.state.monitorStatus === "credit_insufficient") {
          acc.creditInsufficient += 1;
        } else {
          acc.executionFailed += 1;
        }
        return acc;
      },
      {
        queued: 0,
        hitSynced: 0,
        hitSyncFailed: 0,
        noHit: 0,
        creditInsufficient: 0,
        executionFailed: 0,
      },
    );
    const monitorStatus =
      counts.executionFailed > 0
        ? "execution_failed"
        : counts.hitSyncFailed > 0
          ? "hit_sync_failed"
          : counts.hitSynced > 0
            ? "hit_synced"
            : counts.noHit > 0
              ? "no_hit"
              : counts.queued > 0
                ? "queued"
                : counts.creditInsufficient > 0
                  ? "credit_insufficient"
                  : "no_hit";
    const monitorStatusLabel =
      monitorStatus === "execution_failed"
        ? "执行失败"
        : monitorStatus === "hit_sync_failed"
          ? "已命中"
          : monitorStatus === "hit_synced"
            ? "已命中"
            : monitorStatus === "credit_insufficient"
              ? "配额不足"
              : monitorStatus === "queued"
                ? "已排队"
                : "未命中";
    const monitorSyncLabel =
      monitorStatus === "hit_sync_failed"
        ? "同步失败"
        : monitorStatus === "hit_synced"
          ? "已同步"
          : "";
    const monitorSummaryParts = [];
    if (counts.hitSynced > 0) {
      monitorSummaryParts.push(`已命中并同步 ${counts.hitSynced}`);
    }
    if (counts.hitSyncFailed > 0) {
      monitorSummaryParts.push(`已命中但同步失败 ${counts.hitSyncFailed}`);
    }
    if (counts.noHit > 0) {
      monitorSummaryParts.push(`未命中 ${counts.noHit}`);
    }
    if (counts.creditInsufficient > 0) {
      monitorSummaryParts.push(`配额不足 ${counts.creditInsufficient}`);
    }
    if (counts.queued > 0) {
      monitorSummaryParts.push(`已排队 ${counts.queued}`);
    }
    if (counts.executionFailed > 0) {
      monitorSummaryParts.push(`执行失败 ${counts.executionFailed}`);
    }
    const monitorSummary =
      monitorSummaryParts.join(" / ") ||
      (runItems.length === 0 ? "无可执行监控项" : "监控执行完成");
    const platforms = Array.from(
      new Set(normalizedRuns.map((item) => item.platform)),
    );
    const historyPlatform =
      platforms.length === 1 &&
      (platforms[0] === "douyin" ||
        platforms[0] === "xiaohongshu" ||
        platforms[0] === "weibo")
        ? platforms[0]
        : "unknown";

    await addSyncHistoryEntry({
      trigger: "monitor_run_now",
      syncScope: "all",
      startedAt,
      finishedAt,
      totalCount: runItems.length,
      requestedTotalCount: runItems.length,
      noHitCount: counts.noHit,
      skippedCount: counts.creditInsufficient,
      successCount: counts.hitSynced + counts.noHit + counts.queued,
      failedCount: counts.hitSyncFailed + counts.executionFailed,
      debugUrl:
        normalizedRuns.find((item) => Boolean(item.debugUrl))?.debugUrl || null,
      platform: historyPlatform,
      syncType: "monitor_hits",
      workflow: "monitor_runner",
      target: {
        tableName: targetTableName,
      },
      recordIds: normalizedRuns.map((item) => item.executionId).filter(Boolean),
      skippedRecordIds: [],
      monitorStatus,
      monitorStatusLabel,
      monitorSyncLabel,
      monitorSummary,
      monitorSubscriptionId: "",
      monitorBloggerName: "",
      monitorBloggerUrl: "",
      items: normalizedRuns.map((item) => ({
        recordId: item.executionId,
        platform: item.platform,
        type: "monitor_hits",
        workflow: "monitor_runner",
        success: item.state.isSuccess,
        reason: item.state.reason,
        message: item.state.message,
        debugUrl: item.debugUrl || null,
        rawResponse: {
          ...item.item,
          monitorBloggerName: item.monitorBloggerName,
          monitorBloggerUrl: item.monitorBloggerUrl,
        },
        error:
          item.state.reason !== ERROR_REASON.NONE
            ? {
                code: item.state.reason,
                message: item.state.message,
              }
            : null,
      })),
    });

    await refreshSyncHistory();
    await refreshVerifiedAuthSnapshot();

    if (runItems.length === 0) {
      showMessage(
        monitorRunCancelRequested
          ? "已取消本次监控扫描"
          : "立即执行完成：无可执行监控项",
        "info",
      );
    } else {
      const hasWarning = runItems.some((item) => {
        const state = resolveMonitorRunHistoryState(item);
        return (
          state.monitorStatus === "credit_insufficient" ||
          state.monitorStatus === "execution_failed" ||
          state.monitorStatus === "hit_sync_failed"
        );
      });
      if (counts.creditInsufficient > 0) {
        showMessage(
          `本次有 ${counts.creditInsufficient} 个监控项因配额不足未执行。获取更多配额后可立即重试。`,
          "warning",
        );
      } else {
        const hitRecords = runItems.reduce(
          (sum, item) => sum + Math.max(0, Number(item?.hitCount || 0)),
          0,
        );
        showMessage(
          `立即执行完成：扫描 ${runItems.length} 个监控项，采集并同步 ${hitRecords} 条内容`,
          hasWarning ? "warning" : "success",
        );
      }
    }
  } catch (error) {
    console.error("[Sidebar] Run monitor now failed:", error);
    showMessage(`立即执行失败: ${error.message}`, "error");
  } finally {
    monitorRunInFlight = false;
    monitorRunCancelRequested = false;
    hideProgress();
  }
}

function refreshVerifiedAuthSnapshot(options = {}) {
  if (authRefreshPromise) return authRefreshPromise;
  const pending = queueAuthVerification(() => refreshVerifiedAuthSnapshotImpl(options));
  const tracked = pending.finally(() => {
    if (authRefreshPromise === tracked) authRefreshPromise = null;
  });
  authRefreshPromise = tracked;
  return tracked;
}

async function refreshVerifiedAuthSnapshotImpl({showFeedback = false} = {}) {
  const auth = getCurrentAuth() || {};
  if (!isAuthVerified(auth) || !auth.code) {
    return {ok: false, skipped: true};
  }

  let plainCode = "";
  try {
    plainCode = normalizeAuthCodeInput(await ensurePlainAuthCode(auth.code));
  } catch {
    return {ok: false, skipped: true, reason: "invalid_auth_code"};
  }
  const requestRevision = authCodeRevision;
  const requestMutationId = String(auth.authMutationId || "");
  const input = document.getElementById("inputCode");
  if (!(await isAuthVerificationRequestCurrent({
    plainCode,
    revision: requestRevision,
    mutationId: requestMutationId,
    input,
  }))) {
    return {ok: false, skipped: true, reason: "auth_changed"};
  }

  try {
    const result = await verify(auth.code);
    if (!(await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    }))) {
      return {ok: false, skipped: true, reason: "auth_changed"};
    }
    if (!result?.ok) {
      if (showFeedback) {
        showMessage(result?.message || "刷新授权信息失败", "warning");
      }
      return {
        ok: false,
        error: result?.error || {
          message: result?.message || "refresh auth failed",
        },
      };
    }

    const authSnapshot = authSnapshotFromVerifyResult(result, auth);
    const refreshedWrite = await setCurrentAuth(
      {
        verified: true,
        status: AUTH_STATUS.VERIFIED,
        code: auth.code,
        lastVerifiedAt: new Date().toISOString(),
        message: result.message || auth.message || "",
        reason: "none",
        ...authSnapshot,
      },
      {expectedMutationId: requestMutationId},
    );
    if (!refreshedWrite?.accepted) {
      return {ok: false, skipped: true, reason: "auth_changed"};
    }

    if (showFeedback) {
      showMessage("授权信息已刷新", "success");
    }

    return {ok: true, data: result.data || null};
  } catch (error) {
    console.error("[Sidebar] Refresh auth snapshot failed:", error);
    if (showFeedback && await isAuthVerificationRequestCurrent({
      plainCode,
      revision: requestRevision,
      mutationId: requestMutationId,
      input,
    })) {
      showMessage(`刷新授权信息失败: ${error.message}`, "error");
    }
    return {
      ok: false,
      error: {
        message: error?.message || "refresh auth snapshot failed",
      },
    };
  }
}

async function handleAddMonitorFromRecord(recordId) {
  if (!isMonitorAuthReady()) {
    showMessage(MONITOR_REQUIRED_MESSAGE, "warning");
    return;
  }

  const dataPool = getCurrentDataPool();
  const records = Array.isArray(dataPool?.records) ? dataPool.records : [];
  const record = records.find((item) => item?.id === recordId) || null;
  const candidate = buildMonitorCandidateFromRecord(record);

  if (!candidate) {
    showMessage("当前博主卡缺少可用信息，无法纳入监控", "error");
    return;
  }

  showProgress("正在将博主卡纳入监控...");

  try {
    await addMonitorSubscriptionByCandidate(candidate);
  } catch (error) {
    console.error("[Sidebar] Add monitor from record failed:", error);
    showMessage(`纳入监控失败: ${error.message}`, "error");
  } finally {
    hideProgress();
  }
}

function resolveMonitorSettingsSaveErrorMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) {
    return "保存监控规则失败";
  }

  if (raw.includes("monitor tables are missing in database")) {
    return "保存失败：本地数据库缺少监控相关表，请先执行数据库迁移。";
  }

  if (raw.includes("monitor table columns are out of date")) {
    return "保存失败：本地数据库表结构版本过旧，请执行最新数据库迁移。";
  }

  if (raw.includes("credential owner user is missing in database")) {
    return "保存失败：当前激活码关联用户不存在，请重新验证激活码。";
  }

  if (raw.includes("failed to save monitor settings")) {
    return "保存失败：后端未能写入监控设置，请检查本地后端日志。";
  }

  return raw;
}

function authResponseValue(result, key, fallback = null) {
  if (result?.data && Object.prototype.hasOwnProperty.call(result.data, key)) {
    return result.data[key];
  }
  if (result && Object.prototype.hasOwnProperty.call(result, key)) {
    return result[key];
  }
  return fallback;
}

function authSnapshotFromVerifyResult(result, currentAuth = {}) {
  return {
    user: authResponseValue(result, "user", currentAuth.user ?? null),
    tenant: authResponseValue(result, "tenant", currentAuth.tenant ?? null),
    credentialCredit: authResponseValue(result, "credentialCredit", null),
    credential: authResponseValue(result, "credential", currentAuth.credential ?? null),
    binding: authResponseValue(result, "binding", currentAuth.binding ?? null),
    captureAgent: authResponseValue(result, "captureAgent", currentAuth.captureAgent ?? null),
  };
}

async function handleSaveMonitorSettings() {
  const settings = readMonitorSettingsForm();
  if (!isMonitorAuthReady()) {
    await setCurrentMonitor({
      settings,
    });
    return;
  }

  await setCurrentMonitor({isSavingSettings: true});
  const result = await saveMonitorSettings(settings);
  await setCurrentMonitor({isSavingSettings: false});

  if (!result?.ok) {
    showMessage(
      resolveMonitorSettingsSaveErrorMessage(result?.message),
      "error",
    );
    return;
  }

  const savedSettings = normalizeMonitorSettingsInput(
    result.data?.settings || settings,
  );
  await setCurrentMonitor({
    settings: savedSettings,
  });
  populateMonitorSettingsForm(savedSettings);
  await loadMonitorSubscriptions({force: true});
  showMessage("监控规则已保存", "success");
}

async function handleMonitorListClick(event) {
  const actionButton = event.target.closest(
    ".btn-monitor-toggle, .btn-monitor-delete",
  );
  if (!actionButton) {
    return;
  }

  const subscriptionId = String(actionButton.dataset.id || "").trim();
  if (!subscriptionId) {
    return;
  }

  const monitor = getCurrentMonitor() || {};
  const subscription = Array.isArray(monitor.items)
    ? monitor.items.find((item) => item.id === subscriptionId)
    : null;

  if (!subscription) {
    showMessage("监控项不存在，请刷新后重试", "error");
    return;
  }

  if (actionButton.classList.contains("btn-monitor-toggle")) {
    const nextStatus = String(
      actionButton.dataset.nextStatus || MONITOR_STATUS.PAUSED,
    ).trim();
    const result = await updateMonitorSubscription(subscription.id, {
      status: nextStatus,
    });
    if (!result?.ok) {
      showMessage(result?.message || "更新监控状态失败", "error");
      return;
    }
    await loadMonitorSubscriptions({force: true});
    showMessage(
      nextStatus === MONITOR_STATUS.ACTIVE ? "监控已恢复" : "监控已暂停",
      "success",
    );
    return;
  }

  if (actionButton.classList.contains("btn-monitor-delete")) {
    const confirmed = window.confirm?.(
      "删除后该监控项将从当前列表移除，是否继续？",
    );
    if (!confirmed) {
      return;
    }

    const result = await updateMonitorSubscription(subscription.id, {
      status: MONITOR_STATUS.DELETED,
    });
    if (!result?.ok) {
      showMessage(result?.message || "删除监控失败", "error");
      return;
    }

    await loadMonitorSubscriptions({force: true});
    showMessage("监控已删除", "success");
  }
}

/**
 * 处理保存目标配置
 */
async function handleSaveTarget() {
  const feishuAppToken = document
    .getElementById("inputFeishuAppToken")
    ?.value.trim();
  const tableId =
    document.getElementById("inputTableId")?.value.trim() ||
    DEFAULT_SINGLE_NOTE_TABLE_NAME;
  const keywordNotesTableName =
    document.getElementById("inputKeywordNotesTableName")?.value.trim() ||
    DEFAULT_KEYWORD_NOTES_TABLE_NAME;
  const bloggerProfileTableName =
    document.getElementById("inputBloggerProfileTableName")?.value.trim() ||
    DEFAULT_BLOGGER_PROFILE_TABLE_NAME;
  const bloggerNotesTableName =
    document.getElementById("inputBloggerNotesTableName")?.value.trim() ||
    DEFAULT_BLOGGER_NOTES_TABLE_NAME;
  const commentLeadsTableName =
    document.getElementById("inputCommentLeadsTableName")?.value.trim() ||
    DEFAULT_COMMENT_LEADS_TABLE_NAME;
  const monitorTableName =
    document.getElementById("inputMonitorTableName")?.value.trim() ||
    DEFAULT_MONITOR_TABLE_NAME;
  const reportWebhookUrl =
    document.getElementById("inputReportWebhookUrl")?.value.trim() || "";

  if (!feishuAppToken) {
    showMessage("请填写 App Token", "error");
    return;
  }

  try {
    const nextTarget = {
      feishuAppToken,
      tableId,
      keywordNotesTableName,
      bloggerProfileTableName,
      bloggerNotesTableName,
      commentLeadsTableName,
      monitorTableName,
      reportWebhookUrl,
    };
    await setCurrentTarget(nextTarget);

    const auth = getCurrentAuth() || {};
    if (auth.verified) {
      const saveResult = await saveTargetConfig({
        ...nextTarget,
        isConfigured: true,
      });
      if (!saveResult?.ok) {
        throw new Error(saveResult?.message || "后端保存失败");
      }
      if (saveResult.data?.target) {
        await setCurrentTarget(saveResult.data.target);
      }
    }

    showMessage("配置保存成功！", "success");
  } catch (error) {
    console.error("[Sidebar] Save target failed:", error);
    showMessage("保存失败: " + error.message, "error");
  }
}

async function syncTargetConfigAfterVerify() {
  const localTarget = getCurrentTarget() || {};
  const hasLocalTarget =
    localTarget &&
    typeof localTarget === "object" &&
    Boolean(localTarget.feishuAppToken);

  const remoteTarget = await getTargetConfig();
  if (remoteTarget?.ok && remoteTarget.data?.target) {
    const remoteConfig = remoteTarget.data.target;
    const hasRemoteTarget =
      remoteConfig &&
      typeof remoteConfig === "object" &&
      Boolean(remoteConfig.feishuAppToken);

    if (hasRemoteTarget || !hasLocalTarget) {
      await setCurrentTarget(remoteConfig);
      return;
    }
  }

  if (hasLocalTarget) {
    const saveResult = await saveTargetConfig({
      ...localTarget,
      isConfigured: true,
    });
    if (saveResult?.ok && saveResult.data?.target) {
      await setCurrentTarget(saveResult.data.target);
    }
  }
}

async function initCaptureSettingsUI() {
  try {
    const settings = await getCaptureSettings();
    const auth = getCurrentAuth() || {};
    const authVerified = isAuthVerified(auth);
    const includeComments = Boolean(settings.includeCommentsOnNoteCapture);
    const includeBloggerMetrics = Boolean(
      settings.includeBloggerMetricsOnNoteCapture,
    );
    const autoDetailCaptureAfterListCapture =
      authVerified && Boolean(settings.autoDetailCaptureAfterListCapture);
    const enableAiRelevancePrefilter =
      authVerified && Boolean(settings.enableAiRelevancePrefilter);
    const autoSyncAfterDetailCapture =
      authVerified && Boolean(settings.autoSyncAfterDetailCapture);
    const includeCommentsOnDetailCapture =
      authVerified && Boolean(settings.includeCommentsOnDetailCapture);
    const detailCommentsMaxDetectedItems = Number(
      settings.detailCommentsMaxDetectedItems ||
        settings.commentsMaxDetectedItems,
    );
    const enableCommentLeadsFilterOnDetailCapture =
      authVerified && Boolean(settings.enableCommentLeadsFilterOnDetailCapture);
    const includeBloggerMetricsOnDetailCapture =
      authVerified && Boolean(settings.includeBloggerMetricsOnDetailCapture);

    if (
      !authVerified &&
      (settings.autoDetailCaptureAfterListCapture ||
        settings.enableAiRelevancePrefilter ||
        settings.autoSyncAfterDetailCapture ||
        settings.includeCommentsOnDetailCapture ||
        settings.enableCommentLeadsFilterOnDetailCapture ||
        settings.includeBloggerMetricsOnDetailCapture)
    ) {
      await saveCaptureSettings({
        autoDetailCaptureAfterListCapture: false,
        enableAiRelevancePrefilter: false,
        autoSyncAfterDetailCapture: false,
        includeCommentsOnDetailCapture: false,
        enableCommentLeadsFilterOnDetailCapture: false,
        includeBloggerMetricsOnDetailCapture: false,
      });
    }

    const inputSyncScope = document.getElementById("inputSyncScope");
    if (inputSyncScope) {
      inputSyncScope.value = readSyncScopeFromInput(settings.syncScope);
    }
    const inputDetailCaptureScope = document.getElementById(
      "inputDetailCaptureScope",
    );
    if (inputDetailCaptureScope) {
      inputDetailCaptureScope.value = readDetailCaptureScopeFromInput(
        settings.detailCaptureScope,
      );
    }
    const checkboxSkipOfficialAccounts = document.getElementById(
      "checkboxSkipOfficialAccounts",
    );
    if (checkboxSkipOfficialAccounts) {
      checkboxSkipOfficialAccounts.checked =
        settings.skipOfficialAccounts !== false;
    }

    const checkbox = document.getElementById("checkboxCaptureComments");
    if (checkbox) {
      checkbox.checked = includeComments;
    }
    const checkboxEnableCommentLeadsFilter = document.getElementById(
      "checkboxEnableCommentLeadsFilter",
    );
    if (checkboxEnableCommentLeadsFilter) {
      checkboxEnableCommentLeadsFilter.checked = Boolean(
        includeComments && settings.enableCommentLeadsFilter,
      );
    }
    syncBloggerMetricsCaptureControls({
      includeBloggerMetrics,
    });
    syncAutoDetailCaptureControls({
      autoDetailCapture: autoDetailCaptureAfterListCapture,
      enableAiRelevancePrefilter,
      autoSync: autoSyncAfterDetailCapture,
      includeComments: includeCommentsOnDetailCapture,
      commentsMaxDetectedItems: detailCommentsMaxDetectedItems,
      enableCommentLeadsFilter: enableCommentLeadsFilterOnDetailCapture,
      includeBloggerMetrics: includeBloggerMetricsOnDetailCapture,
    });
    // 「增量采集」勾选已挪到「点赞数」下面,不在 detail 面板内,单独按 settings 回填(document 级)
    document
      .querySelectorAll('[data-detail-setting="skip-captured"]')
      .forEach((el) => {
        el.checked = settings.skipAlreadyCapturedOnDetailCapture !== false;
      });
    const inputCommentsMaxDetectedItems = document.getElementById(
      "inputCommentsMaxDetectedItems",
    );
    if (inputCommentsMaxDetectedItems) {
      inputCommentsMaxDetectedItems.value = String(
        settings.commentsMaxDetectedItems,
      );
    }
    const inputCommentLeadsKeywords = document.getElementById(
      "inputCommentLeadsKeywords",
    );
    if (inputCommentLeadsKeywords) {
      inputCommentLeadsKeywords.value = String(
        settings.commentLeadsKeywords || "",
      );
    }
    const inputCommentLeadsIps = document.getElementById(
      "inputCommentLeadsIps",
    );
    if (inputCommentLeadsIps) {
      inputCommentLeadsIps.value = String(settings.commentLeadsIps || "");
    }
    syncCommentsCaptureControls({
      includeComments,
      forceDisabled: false,
    });

    const inputSharedWaitMinSec = document.getElementById(
      "inputSharedWaitMinSec",
    );
    if (inputSharedWaitMinSec) {
      inputSharedWaitMinSec.value = String(
        Math.floor(settings.sharedWaitMinMs / 1000),
      );
    }

    const inputSharedWaitMaxSec = document.getElementById(
      "inputSharedWaitMaxSec",
    );
    if (inputSharedWaitMaxSec) {
      inputSharedWaitMaxSec.value = String(
        Math.floor(settings.sharedWaitMaxMs / 1000),
      );
    }

    const inputSharedStallTimeoutSec = document.getElementById(
      "inputSharedStallTimeoutSec",
    );
    if (inputSharedStallTimeoutSec) {
      inputSharedStallTimeoutSec.value = String(
        Math.floor(settings.sharedStallTimeoutMs / 1000),
      );
    }

    const inputSharedMaxDurationSec = document.getElementById(
      "inputSharedMaxDurationSec",
    );
    if (inputSharedMaxDurationSec) {
      inputSharedMaxDurationSec.value = String(
        Math.floor(settings.sharedMaxDurationMs / 1000),
      );
    }

    const inputDetailAfterNavWaitMs = document.getElementById(
      "inputDetailAfterNavWaitMs",
    );
    if (inputDetailAfterNavWaitMs) {
      inputDetailAfterNavWaitMs.value = formatMillisecondsAsSeconds(
        settings.detailAfterNavWaitMs,
      );
    }
    const inputDetailNavTimeoutMs = document.getElementById(
      "inputDetailNavTimeoutMs",
    );
    if (inputDetailNavTimeoutMs) {
      inputDetailNavTimeoutMs.value = formatMillisecondsAsSeconds(
        settings.detailNavTimeoutMs,
      );
    }
    const inputProfileAfterNavWaitMs = document.getElementById(
      "inputProfileAfterNavWaitMs",
    );
    if (inputProfileAfterNavWaitMs) {
      inputProfileAfterNavWaitMs.value = formatMillisecondsAsSeconds(
        settings.profileAfterNavWaitMs,
      );
    }

    const inputBloggerMinLikes = document.getElementById(
      "inputBloggerMinLikes",
    );
    if (inputBloggerMinLikes) {
      inputBloggerMinLikes.value = String(settings.bloggerMinLikes);
    }

    const inputBloggerMaxDetectedItems = document.getElementById(
      "inputBloggerMaxDetectedItems",
    );
    if (inputBloggerMaxDetectedItems) {
      inputBloggerMaxDetectedItems.value = String(
        settings.bloggerMaxDetectedItems,
      );
    }

    const inputBloggerKeywordFilter = document.getElementById(
      "inputBloggerKeywordFilter",
    );
    if (inputBloggerKeywordFilter) {
      inputBloggerKeywordFilter.value = settings.bloggerKeywordFilter || "";
    }
    updateBloggerKeywordFilterHint();

    const inputKeywordMinLikes = document.getElementById(
      "inputKeywordMinLikes",
    );
    if (inputKeywordMinLikes) {
      inputKeywordMinLikes.value = String(settings.keywordMinLikes);
    }
    applyKeywordSortDimensionToUI(keywordSortDimension);

    const inputKeywordMaxDetectedItems = document.getElementById(
      "inputKeywordMaxDetectedItems",
    );
    if (inputKeywordMaxDetectedItems) {
      inputKeywordMaxDetectedItems.value = String(
        settings.keywordMaxDetectedItems,
      );
    }
  } catch (error) {
    console.warn("[Sidebar] Init capture settings UI failed:", error);
  }
}

async function handleCaptureCommentsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    syncCommentsCaptureControls({includeComments: checked});
    if (checked && !readRequiredCommentsMaxDetectedItemsFromInput()) {
      showMessage("请填写评论探测上限（正整数）", "warning");
      document.getElementById("inputCommentsMaxDetectedItems")?.focus();
    }
    const updates = {
      includeCommentsOnNoteCapture: checked,
    };
    if (!checked) {
      const leadsCheckbox = document.getElementById(
        "checkboxEnableCommentLeadsFilter",
      );
      if (leadsCheckbox?.checked) {
        leadsCheckbox.checked = false;
      }
      updates.enableCommentLeadsFilter = false;
    }
    await saveCaptureSettings(updates);
  } catch (error) {
    console.warn("[Sidebar] Save capture toggle failed:", error);
  }
}

async function handleCommentLeadsFilterToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    const commentsCheckbox = document.getElementById("checkboxCaptureComments");
    const updates = {
      enableCommentLeadsFilter: checked,
    };
    if (checked && commentsCheckbox && !commentsCheckbox.checked) {
      commentsCheckbox.checked = true;
      updates.includeCommentsOnNoteCapture = true;
      syncCommentsCaptureControls({includeComments: true});
    }

    await saveCaptureSettings(updates);
  } catch (error) {
    console.warn("[Sidebar] Save comment leads toggle failed:", error);
  }
}

async function handleCaptureBloggerMetricsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    syncBloggerMetricsCaptureControls({includeBloggerMetrics: checked});
    await saveCaptureSettings({
      includeBloggerMetricsOnNoteCapture: checked,
    });
  } catch (error) {
    console.warn("[Sidebar] Save blogger metrics toggle failed:", error);
  }
}

async function handleAutoDetailCaptureToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({
        autoDetailCapture: false,
        autoSync: false,
      });
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    syncAutoDetailCaptureControls({
      autoDetailCapture: checked,
      autoSync: checked ? null : false,
    });
    updateBloggerKeywordFilterHint();
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save auto detail capture toggle failed:", error);
  }
}

async function handleDetailCaptureAutoSyncToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({autoSync: false});
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({
        autoDetailCapture: true,
        autoSync: true,
      });
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save detail auto sync toggle failed:", error);
  }
}

async function handleDetailCaptureAiRelevancePrefilterToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({enableAiRelevancePrefilter: false});
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({
        autoDetailCapture: true,
        enableAiRelevancePrefilter: true,
      });
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save AI relevance prefilter toggle failed:", error);
  }
}

async function handleDetailCaptureCommentsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({includeComments: false});
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({autoDetailCapture: true});
      if (!readRequiredDetailCaptureCommentsMaxDetectedItemsFromInput()) {
        showMessage("请填写评论探测上限（正整数）", "warning");
        getActiveDetailCaptureCommentsMaxDetectedItemsInput()?.focus();
      }
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save detail comments toggle failed:", error);
  }
}

async function handleDetailCaptureBloggerMetricsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({includeBloggerMetrics: false});
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({autoDetailCapture: true});
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save detail blogger metrics toggle failed:", error);
  }
}

async function handleDetailCaptureSkipCapturedToggleChange() {
  try {
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save skip-captured toggle failed:", error);
  }
}

async function handleDetailCaptureLowFollowerHitToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked) {
      syncAutoDetailCaptureControls({
        autoDetailCapture: true,
        includeBloggerMetrics: true,
      });
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn(
      "[Sidebar] Save detail low follower hit toggle failed:",
      error,
    );
  }
}

async function handleDetailCaptureLowFollowerHitThresholdChange(event) {
  try {
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn(
      "[Sidebar] Save detail low follower hit threshold failed:",
      error,
    );
  }
}

async function handleDetailCaptureCommentLeadsToggleChange(event) {
  try {
    const checked = Boolean(event?.target?.checked);
    if (checked && !ensureAuthVerifiedOrWarn()) {
      if (event?.target) {
        event.target.checked = false;
      }
      syncAutoDetailCaptureControls({
        enableCommentLeadsFilter: false,
      });
      await persistDetailCaptureSettingsFromInputs();
      return;
    }
    if (checked) {
      syncAutoDetailCaptureControls({
        autoDetailCapture: true,
        includeComments: true,
      });
      if (!readRequiredDetailCaptureCommentsMaxDetectedItemsFromInput()) {
        showMessage("请填写评论探测上限（正整数）", "warning");
        getActiveDetailCaptureCommentsMaxDetectedItemsInput()?.focus();
      }
    }
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn("[Sidebar] Save detail comment leads toggle failed:", error);
  }
}

async function handleDetailCaptureCommentsMaxDetectedItemsChange() {
  try {
    await persistDetailCaptureSettingsFromInputs();
  } catch (error) {
    console.warn(
      "[Sidebar] Save detail comments max detected items failed:",
      error,
    );
  }
}

function handleCaptureCommentsToggleGuardClick(event) {
  const runtime = getCurrentRuntime();
  if (runtime?.pageType !== PAGE_TYPE.NOTE_DETAIL) {
    return;
  }
}

function handleCaptureBloggerMetricsToggleGuardClick() {
  // 单笔记采集条件开关不再受激活码鉴权限制。
  return;
}

async function handleSaveCaptureSettings() {
  try {
    const current = await getCaptureSettings();
    const commentsMaxDetectedItems = readCommentsMaxDetectedItemsFromInput(
      current.commentsMaxDetectedItems,
    );
    const syncScope = readSyncScopeFromInput(current.syncScope);
    const detailCaptureScope = readDetailCaptureScopeFromInput(
      current.detailCaptureScope,
    );
    const autoDetailCaptureAfterListCapture =
      getAutoDetailCaptureChecked(current);
    const enableAiRelevancePrefilter =
      getDetailCaptureAiRelevancePrefilterChecked(current);
    const autoSyncAfterDetailCapture =
      autoDetailCaptureAfterListCapture &&
      getDetailCaptureAutoSyncChecked(current);
    const includeCommentsOnNoteCapture = getCaptureCommentsChecked(current);
    const includeCommentsOnDetailCapture =
      getDetailCaptureCommentsChecked(current);
    const detailCommentsMaxDetectedItems =
      getDetailCaptureCommentsMaxDetectedItems(current);
    const enableCommentLeadsFilter = getCommentLeadsFilterChecked(current);
    const enableCommentLeadsFilterOnDetailCapture =
      getDetailCaptureCommentLeadsFilterChecked(current);
    const normalizedEnableCommentLeadsFilter =
      includeCommentsOnNoteCapture && enableCommentLeadsFilter;
    const normalizedEnableCommentLeadsFilterOnDetailCapture =
      includeCommentsOnDetailCapture && enableCommentLeadsFilterOnDetailCapture;
    const skipOfficialAccounts = getSkipOfficialAccountsChecked(current);
    const commentLeadsKeywords = readCommaSeparatedRulesFromInput(
      "inputCommentLeadsKeywords",
      current.commentLeadsKeywords,
    );
    const commentLeadsIps = readCommaSeparatedRulesFromInput(
      "inputCommentLeadsIps",
      current.commentLeadsIps,
    );
    const includeBloggerMetricsOnNoteCapture =
      getCaptureBloggerMetricsChecked(current);
    const includeBloggerMetricsOnDetailCapture =
      getDetailCaptureBloggerMetricsChecked(current);
    const sharedWaitMinMs =
      readSecondsInput(
        "inputSharedWaitMinSec",
        current.sharedWaitMinMs / 1000,
      ) * 1000;
    const sharedWaitMaxMs =
      readSecondsInput(
        "inputSharedWaitMaxSec",
        current.sharedWaitMaxMs / 1000,
      ) * 1000;
    const sharedStallTimeoutMs =
      readSecondsInput(
        "inputSharedStallTimeoutSec",
        current.sharedStallTimeoutMs / 1000,
      ) * 1000;
    const sharedMaxDurationMs =
      readSecondsInput(
        "inputSharedMaxDurationSec",
        current.sharedMaxDurationMs / 1000,
      ) * 1000;
    const detailAfterNavWaitMs = readSecondsAsMillisecondsInput(
      "inputDetailAfterNavWaitMs",
      current.detailAfterNavWaitMs,
      0.1,
    );
    const detailNavTimeoutMs = readSecondsAsMillisecondsInput(
      "inputDetailNavTimeoutMs",
      current.detailNavTimeoutMs,
      1,
    );
    const profileAfterNavWaitMs = readSecondsAsMillisecondsInput(
      "inputProfileAfterNavWaitMs",
      current.profileAfterNavWaitMs,
      0.1,
    );
    const bloggerMinLikes = readBloggerMinLikesFromInput(
      current.bloggerMinLikes,
    );
    const bloggerMaxDetectedItems = readBloggerMaxDetectedItemsFromInput(
      current.bloggerMaxDetectedItems,
    );
    const bloggerKeywordFilter = readBloggerKeywordFilterFromInput();
    const keywordMinLikes = readKeywordMinLikesFromInput(
      current.keywordMinLikes,
    );
    const keywordMaxDetectedItems = readKeywordMaxDetectedItemsFromInput(
      current.keywordMaxDetectedItems,
    );

    await saveCaptureSettings({
      autoDetailCaptureAfterListCapture,
      enableAiRelevancePrefilter,
      autoSyncAfterDetailCapture,
      commentsMaxDetectedItems,
      syncScope,
      detailCaptureScope,
      includeCommentsOnNoteCapture,
      includeCommentsOnDetailCapture,
      detailCommentsMaxDetectedItems,
      enableCommentLeadsFilter: normalizedEnableCommentLeadsFilter,
      enableCommentLeadsFilterOnDetailCapture:
        normalizedEnableCommentLeadsFilterOnDetailCapture,
      skipOfficialAccounts,
      commentLeadsKeywords,
      commentLeadsIps,
      includeBloggerMetricsOnNoteCapture,
      includeBloggerMetricsOnDetailCapture,
      sharedWaitMinMs,
      sharedWaitMaxMs,
      sharedStallTimeoutMs,
      sharedMaxDurationMs,
      detailNavTimeoutMs,
      detailAfterNavWaitMs,
      profileAfterNavWaitMs,
      bloggerMinLikes,
      bloggerMaxDetectedItems,
      bloggerKeywordFilter,
      keywordMinLikes,
      keywordMaxDetectedItems,
    });

    showMessage("采集配置已保存", "success");
  } catch (error) {
    console.error("[Sidebar] Save capture settings failed:", error);
    showMessage("保存采集配置失败: " + error.message, "error");
  }
}

/**
 * 处理同步全部记录
 */
async function handleSyncAll() {
  if (detailBatchCaptureInFlight) {
    const shouldStopAndSync = confirm(
      "当前正在执行采集增强。是否立即中止采集增强，并同步已经采到的数据？\n\n未完成增强的记录会标记为“任务中断”，后续可再次重试增强。",
    );
    if (!shouldStopAndSync) {
      showMessage("正在执行采集增强，请等待完成后再同步", "warning");
      return;
    }
    await stopDetailCaptureAndReleaseForSync();
  }

  const settings = await getCaptureSettings();
  const syncScope = readSyncScopeFromInput(settings.syncScope);
  const commentLeadsConfig = buildCommentLeadsConfigFromSettings(settings);
  const commentLeadsEnabled = Boolean(commentLeadsConfig.enabled);
  let pageRecords = getCurrentPageRecords();
  const repairedInterruptedDetails =
    await repairInterruptedDetailCaptureRecordsBeforeSync(pageRecords);
  if (repairedInterruptedDetails.count > 0) {
    pageRecords = getCurrentPageRecords();
  }
  const orderedAllRecords = prioritizeRecordsForSync(pageRecords);
  const pendingRecords = pageRecords.filter(
    (record) => record.status !== "synced",
  );
  const orderedPendingRecords = prioritizeRecordsForSync(pendingRecords);
  const targetRecords =
    syncScope === SYNC_SCOPE_ALL ? orderedAllRecords : orderedPendingRecords;
  const targetIds = targetRecords.map((record) => record.id);
  const limitedTargetIds = targetIds.slice(0, MAX_SYNC_RECORDS_PER_BATCH);
  const limitedTargetRecords = targetRecords.slice(
    0,
    MAX_SYNC_RECORDS_PER_BATCH,
  );
  const remainingCount = targetIds.length - limitedTargetIds.length;

  if (targetIds.length === 0) {
    if (syncScope === SYNC_SCOPE_ALL) {
      showMessage("当前页面暂无可同步数据", "info");
    } else {
      showMessage("当前页面没有未同步数据", "info");
    }
    return;
  }

  const detailCaptureBlockers = summarizeDetailCaptureBlockers(targetRecords);
  if (detailCaptureBlockers.capturing > 0) {
    showMessage(
      buildDetailCaptureBlockerMessage(detailCaptureBlockers),
      "warning",
    );
    return;
  }

  // 确认
  const scopeText = syncScope === SYNC_SCOPE_ALL ? "全部数据" : "未同步数据";
  let confirmMessage =
    targetIds.length > MAX_SYNC_RECORDS_PER_BATCH
      ? `确定要同步当前页面的${scopeText} ${targetIds.length} 条吗？\n${SYNC_BATCH_LIMIT_MESSAGE}`
      : `确定要同步当前页面的${scopeText} ${targetIds.length} 条吗？`;
  if (detailCaptureBlockers.total > 0) {
    confirmMessage = `${buildDetailCaptureSyncWarningMessage(
      detailCaptureBlockers,
    )}\n\n${confirmMessage}`;
  }
  if (!confirm(confirmMessage)) {
    return;
  }

  if (targetIds.length > MAX_SYNC_RECORDS_PER_BATCH) {
    showMessage(SYNC_BATCH_LIMIT_MESSAGE, "warning");
  }

  const taskContext = beginSidebarTask({
    taskType: "sync",
    featureKey: "sync.lark",
    metadata: {
      syncScope,
      targetCount: limitedTargetIds.length,
      requestedCount: targetIds.length,
      commentLeadsEnabled,
    },
  });
  let taskStatus = "completed";
  let taskError = null;

  showProgress("正在校验授权与同步配置...");
  try {
    // 同步前检查
    const requiredTypes = limitedTargetRecords.map(
      (record) => resolveSyncInputForRecord(record)?.syncType || record.type,
    );
    if (
      commentLeadsEnabled &&
      requiredTypes.some(
        (syncType) =>
          syncType === SYNC_TYPE.SINGLE_NOTE ||
          syncType === SYNC_TYPE.COMMENTS ||
          syncType === SYNC_TYPE.BLOGGER_NOTES ||
          syncType === SYNC_TYPE.KEYWORD_NOTES,
      )
    ) {
      requiredTypes.push(SYNC_TYPE.COMMENT_LEADS);
    }
    const checkResult = await checkBeforeSync(requiredTypes, {
      onProgress: handleProgress,
    });
    if (!checkResult.ok) {
      const errorMsg =
        ERROR_MESSAGE_MAP[checkResult.error?.code] ||
        checkResult.error?.message;
      showMessage(errorMsg, "error");
      taskStatus = "failed";
      return;
    }

    showProgress(`正在同步 ${limitedTargetIds.length} 条记录...`);

    const result = await syncRecordBatch(limitedTargetIds, handleProgress, {
      trigger: "current_page",
      syncScope,
      captureSettings: settings,
      commentLeadsConfig,
    });

    const leadsSyncedCount = Number(result.commentLeadsSyncedCount || 0);
    const leadsSkippedCount = Number(result.commentLeadsSkippedCount || 0);
    const leadsFailedCount = Number(result.commentLeadsFailedCount || 0);
    const hasLeadsActivity =
      leadsSyncedCount > 0 || leadsSkippedCount > 0 || leadsFailedCount > 0;
    const hasLeadsSkippedOnly =
      hasLeadsActivity &&
      leadsSyncedCount === 0 &&
      leadsFailedCount === 0 &&
      leadsSkippedCount > 0;
    const hasLeadsFailure = hasLeadsActivity && leadsFailedCount > 0;
    const contentSuccessCount =
      Number(result.successCount || 0) +
      (hasLeadsFailure ? leadsFailedCount : 0);
    const leadsSummary = hasLeadsActivity
      ? `（客资：成功 ${leadsSyncedCount} / 跳过 ${leadsSkippedCount} / 失败 ${leadsFailedCount}）`
      : "";

    if (result.ok && remainingCount <= 0) {
      const successMessage = hasLeadsSkippedOnly
        ? `全部同步成功！共 ${result.successCount} 条。客资 0 条，已跳过${leadsSummary}`
        : `全部同步成功！共 ${result.successCount} 条${leadsSummary}`;
      showMessage(successMessage, "success");
    } else if (result.ok && remainingCount > 0) {
      showMessage(
        `本次已同步 ${result.successCount} 条，剩余 ${remainingCount} 条，请再次点击“同步后台”继续同步${
          hasLeadsSkippedOnly ? "（客资 0 条，已跳过）" : leadsSummary
        }`,
        "warning",
      );
    } else {
      const baseFailureMessage = `部分同步失败：成功 ${result.successCount}，失败 ${result.failedCount}${
        remainingCount > 0 ? `，剩余 ${remainingCount} 条待执行` : ""
      }`;
      const partialLeadsMessage = hasLeadsFailure
        ? `部分成功：内容表已成功 ${contentSuccessCount} 条，客资失败 ${leadsFailedCount} 条，可再次点击“同步后台”仅重试失败记录`
        : "";
      showMessage(partialLeadsMessage || baseFailureMessage, "warning");
      taskStatus = "completed_with_failures";
    }

    await Promise.all([refreshDataPool(), refreshSyncHistory()]);
  } catch (error) {
    console.error("[Sidebar] Sync all failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("同步失败: " + error.message, "error");
  } finally {
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        syncScope,
        targetCount: limitedTargetIds.length,
        requestedCount: targetIds.length,
      },
    });
    hideProgress();
  }
}

async function repairInterruptedDetailCaptureRecordsBeforeSync(records = []) {
  const hasCapturingRecord = (Array.isArray(records) ? records : []).some(
    (record) => {
      if (!isDetailCaptureRecord(record) || isDetailCaptureDone(record)) {
        return false;
      }
      const status = String(record?.payload?.detailCaptureStatus || "")
        .trim()
        .toLowerCase();
      return status === "capturing";
    },
  );
  if (!hasCapturingRecord) {
    return {count: 0, recordIds: []};
  }

  try {
    const result = await repairInterruptedDetailCaptureRecords();
    if (Number(result?.count || 0) > 0) {
      await refreshDataPool();
      showMessage(
        `已恢复 ${result.count} 条异常中断的采集增强记录，可继续同步`,
        "warning",
      );
    }
    return result || {count: 0, recordIds: []};
  } catch (error) {
    console.warn(
      "[Sidebar] Repair interrupted detail capture before sync failed:",
      error,
    );
    return {count: 0, recordIds: []};
  }
}

async function stopDetailCaptureAndReleaseForSync() {
  detailBatchCancelRequested = true;

  try {
    await requestDetailRunnerCancelSignals({
      extraTabIds: getCurrentRuntime()?.captureDebugSession?.workerTabIds,
    });
  } catch (error) {
    console.warn("[Sidebar] Stop detail capture before sync failed:", error);
  }

  const startedAt = Date.now();
  while (detailBatchCaptureInFlight && Date.now() - startedAt < 3000) {
    await sleep(200);
  }

  const result = await finalizeInterruptedDetailCaptureAfterCancel();
  detailBatchCaptureInFlight = false;
  detailBatchCancelRequested = false;
  detailBatchRunnerTabId = null;
  activeCommentsCaptureRecordId = "";
  activeCommentsCaptureTabId = null;
  activeCommentsCaptureRequestId = "";
  if (activeCaptureExecutionLockId) {
    void renewCaptureExecutionLock(activeCaptureExecutionLockId);
  }
  updateDataPoolUI(getCurrentDataPool());
  updatePageTypeUI(getCurrentRuntime()?.pageType || PAGE_TYPE.UNKNOWN);
  return result;
}

async function finalizeInterruptedDetailCaptureAfterCancel() {
  try {
    const result = await repairInterruptedDetailCaptureRecords();
    if (Number(result?.count || 0) > 0) {
      await refreshDataPool();
      showMessage(
        `已中止采集增强，并保留已采到的数据；${result.count} 条进行中记录已标记为中断，可继续同步`,
        "warning",
      );
      return result;
    }
  } catch (error) {
    console.warn(
      "[Sidebar] Finalize interrupted detail capture after cancel failed:",
      error,
    );
  }

  showMessage("正在取消...", "info");
  return {count: 0, recordIds: []};
}

function prioritizeRecordsForSync(records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const bloggerProfiles = [];
  const others = [];

  records.forEach((record) => {
    if (record?.type === "blogger_profile") {
      bloggerProfiles.push(record);
      return;
    }
    others.push(record);
  });

  return [...bloggerProfiles, ...others];
}

const DETAIL_ITEM_SETTLED_PHASES = new Set([
  "detail_item_done",
  "detail_item_failed",
  "detail_item_skipped",
  "detail_item_filtered",
]);

async function maybeRunAutoDetailCaptureAfterListCapture(
  settings,
  {
    sourceLabel = "当前列表",
    recordIds = null,
    onProgress = null,
    onItemSettled = null,
    waitForegroundTabId = null,
    captureTaskId = "",
    relevanceKeyword = "",
    unattendedRequestId = "",
    unattendedAttemptId = "",
  } = {},
) {
  if (!Boolean(settings?.autoDetailCaptureAfterListCapture)) {
    return {
      skipped: true,
      reason: "disabled",
    };
  }

  const auth = getCurrentAuth() || {};
  if (!isAuthVerified(auth)) {
    showMessage(
      `${sourceLabel}已入池，当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。`,
      "warning",
    );
    return {
      skipped: true,
      reason: "auth_required",
    };
  }

  const runtime = getCurrentRuntime();
  const platform = getViewPlatform(runtime);
  if (!getPlatformCapabilities(platform).batchDetailCapture) {
    return {
      skipped: true,
      reason: "unsupported_platform",
    };
  }

  const skipAlreadyCaptured =
    settings?.skipAlreadyCapturedOnDetailCapture !== false;
  // “跳过已增强笔记”是用户可见的最终开关。关闭时必须让本轮明确
  // recordIds 中的已增强记录重新进入详情采集，不能再被旧的
  // detailCaptureScope=pending 预先过滤掉，否则会出现第一关键词只补少量、
  // 后续关键词完全不增强的假完成。
  const detailCaptureScope = skipAlreadyCaptured
    ? readDetailCaptureScopeFromInput(settings?.detailCaptureScope)
    : DETAIL_CAPTURE_SCOPE_ALL;

  const explicitRecordIds = Array.isArray(recordIds)
    ? [
        ...new Set(
          recordIds
            .filter((recordId) => typeof recordId === "string")
            .map((recordId) => recordId.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const createTargetResolutionFailure = ({
    code = "DETAIL_TARGETS_UNRESOLVED",
    reason = "record_ids_unresolved",
    message = "采集结果尚未写入本地数据池，无法启动采集增强",
    failedRecordIds = explicitRecordIds,
  } = {}) => {
    const normalizedFailedRecordIds = Array.isArray(failedRecordIds)
      ? [...new Set(failedRecordIds.filter(Boolean))]
      : [];
    const failureCount = Math.max(
      1,
      normalizedFailedRecordIds.length || explicitRecordIds.length,
    );
    return {
      ok: false,
      canceled: false,
      partial: true,
      recoverable: reason === "record_ids_unresolved",
      recoveryRequired: reason === "record_ids_unresolved",
      skipped: false,
      reason,
      total: Math.max(explicitRecordIds.length, failureCount),
      processedCount: failureCount,
      successCount: 0,
      failedCount: failureCount,
      filteredCount: 0,
      skippedCount: 0,
      unresolvedRecordIds: normalizedFailedRecordIds,
      results: normalizedFailedRecordIds.map((recordId) => ({
        recordId,
        ok: false,
        reason,
        code,
        message,
        recoveryRequired: reason === "record_ids_unresolved",
      })),
      error: {code, message},
    };
  };

  // 明确的 recordIds 是列表采集刚落盘的权威结果。这里必须直接读取
  // 持久化数据池，不能依赖可能被并发 refresh 覆盖的侧栏 UI 快照。
  // 否则最后一个关键词会被误判为 no_target_records，基础数据照常同步，
  // 但详情增强静默跳过。
  let pageRecords = [];
  let unresolvedRecordIds = [];
  if (explicitRecordIds.length > 0) {
    const persistedRecords = await getRecords(explicitRecordIds);
    const persistedRecordById = new Map(
      persistedRecords.map((record) => [record.id, record]),
    );
    pageRecords = explicitRecordIds
      .map((recordId) => persistedRecordById.get(recordId))
      .filter(Boolean);
    unresolvedRecordIds = explicitRecordIds.filter(
      (recordId) => !persistedRecordById.has(recordId),
    );
  } else {
    pageRecords = getCurrentPageRecords();
  }

  const targetRecords = getDetailCaptureTargetRecords(pageRecords, {
    scope: detailCaptureScope,
  });

  if (targetRecords.length === 0) {
    if (
      explicitRecordIds.length > 0 &&
      unresolvedRecordIds.length === 0 &&
      pageRecords.length === explicitRecordIds.length &&
      pageRecords.every((record) => isDetailCaptureDone(record))
    ) {
      return {
        ok: true,
        skipped: true,
        reason: "all_targets_settled",
        total: explicitRecordIds.length,
        processedCount: explicitRecordIds.length,
        successCount: 0,
        failedCount: 0,
        filteredCount: 0,
        skippedCount: explicitRecordIds.length,
        results: [],
      };
    }
    if (explicitRecordIds.length > 0) {
      return createTargetResolutionFailure({
        code:
          unresolvedRecordIds.length > 0
            ? "DETAIL_RECORD_IDS_UNRESOLVED"
            : "DETAIL_TARGETS_UNRESOLVED",
        reason:
          unresolvedRecordIds.length > 0
            ? "record_ids_unresolved"
            : "no_target_records",
        message:
          unresolvedRecordIds.length > 0
            ? `有 ${unresolvedRecordIds.length} 条采集结果尚未写入本地数据池，已保留为部分完成并等待恢复`
            : `已收到 ${explicitRecordIds.length} 条列表记录，但没有解析出可增强作品，任务不能按完整完成结算`,
        failedRecordIds:
          unresolvedRecordIds.length > 0
            ? unresolvedRecordIds
            : explicitRecordIds,
      });
    }
    return {
      skipped: true,
      reason: "no_target_records",
    };
  }

  const targetRecordIds = targetRecords
    .filter((record) => Boolean(getRecordPrimaryNoteUrl(record)))
    .map((record) => record.id);

  const targetRecordIdSet = new Set(targetRecordIds);
  const missingNoteUrlRecordIds = targetRecords
    .map((record) => record.id)
    .filter((recordId) => !targetRecordIdSet.has(recordId));
  if (missingNoteUrlRecordIds.length > 0) {
    showMessage("当前记录缺少可访问的笔记链接，无法执行采集增强", "warning");
  }

  const preflightFailureRecordIds = [
    ...new Set([...unresolvedRecordIds, ...missingNoteUrlRecordIds]),
  ];
  if (targetRecordIds.length === 0 && preflightFailureRecordIds.length > 0) {
    const onlyMissingUrls = unresolvedRecordIds.length === 0;
    return createTargetResolutionFailure({
      code: onlyMissingUrls
        ? "DETAIL_NOTE_URL_MISSING"
        : "DETAIL_RECORD_IDS_UNRESOLVED",
      reason: onlyMissingUrls ? "missing_note_url" : "record_ids_unresolved",
      message: onlyMissingUrls
        ? `有 ${missingNoteUrlRecordIds.length} 条记录缺少可访问的作品链接，未按完整增强结算`
        : `有 ${unresolvedRecordIds.length} 条采集结果尚未写入本地数据池，已保留为部分完成并等待恢复`,
      failedRecordIds: preflightFailureRecordIds,
    });
  }

  const detailResult = await runDetailCaptureForRecordIds(
    targetRecordIds,
    settings,
    {
      progressMessage: `正在执行采集增强（0/${targetRecordIds.length}）...`,
      onProgress,
      onItemSettled,
      waitForegroundTabId,
      captureTaskId,
      relevanceKeyword,
      unattendedRequestId,
      unattendedAttemptId,
    },
  );
  const preflightFailures = [];
  if (unresolvedRecordIds.length > 0) {
    preflightFailures.push(
      ...createTargetResolutionFailure({
        code: "DETAIL_RECORD_IDS_UNRESOLVED",
        reason: "record_ids_unresolved",
        message: "采集结果尚未写入本地数据池，无法启动采集增强",
        failedRecordIds: unresolvedRecordIds,
      }).results,
    );
  }
  if (missingNoteUrlRecordIds.length > 0) {
    preflightFailures.push(
      ...createTargetResolutionFailure({
        code: "DETAIL_NOTE_URL_MISSING",
        reason: "missing_note_url",
        message: "记录缺少可访问的作品链接，无法启动采集增强",
        failedRecordIds: missingNoteUrlRecordIds,
      }).results,
    );
  }
  const result =
    preflightFailures.length === 0
      ? detailResult
      : {
          ...detailResult,
          ok: false,
          partial: true,
          recoveryRequired:
            Boolean(detailResult?.recoveryRequired) ||
            unresolvedRecordIds.length > 0,
          total:
            Math.max(
              Number(detailResult?.total) || 0,
              targetRecordIds.length,
            ) + preflightFailures.length,
          processedCount:
            Math.max(
              Number(detailResult?.processedCount) || 0,
              targetRecordIds.length,
            ) + preflightFailures.length,
          failedCount:
            Math.max(0, Number(detailResult?.failedCount) || 0) +
            preflightFailures.length,
          results: [
            ...(Array.isArray(detailResult?.results)
              ? detailResult.results
              : []),
            ...preflightFailures,
          ],
          unresolvedRecordIds,
          error:
            detailResult?.error ||
            {
              code:
                unresolvedRecordIds.length > 0
                  ? "DETAIL_RECORD_IDS_UNRESOLVED"
                  : "DETAIL_NOTE_URL_MISSING",
              message: `有 ${preflightFailures.length} 条记录未能进入采集增强`,
            },
        };

  if (result.canceled) {
    const filterMsg =
      result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
    const failureSummary = buildDetailCaptureFailureSummaryText(result);
    showMessage(
      `采集增强已中止：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
      "warning",
    );
  } else if (result.ok) {
    const filterMsg =
      result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
    showMessage(
      `采集增强完成：成功 ${result.successCount} 条${filterMsg}`,
      "success",
    );
  } else {
    const filterMsg =
      result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
    const failureSummary = buildDetailCaptureFailureSummaryText(result);
    showMessage(
      `采集增强完成：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
      "warning",
    );
  }

  return result;
}

async function maybeRunAutoSyncAfterDetailCapture(
  settings,
  {
    sourceLabel = "当前列表",
    recordIds = null,
    silent = false,
    refreshAfter = true,
    syncProgress = null,
    shouldStop = null,
    signal = null,
    captureTaskId = "",
    captureTaskItemAttemptId = "",
    captureTaskItemRequestHash = "",
  } = {},
) {
  const stopRequested = () => {
    if (signal?.aborted === true) return true;
    if (typeof shouldStop !== "function") return false;
    try {
      return shouldStop() === true;
    } catch {
      return true;
    }
  };
  const canceledResult = () => ({
    ok: false,
    canceled: true,
    skipped: true,
    reason: "capture_task_canceled",
    message: "任务已取消，未继续同步",
  });

  if (!Boolean(settings?.autoSyncAfterDetailCapture)) {
    return {
      skipped: true,
      reason: "disabled",
    };
  }

  const normalizedRecordIds = Array.isArray(recordIds)
    ? [
        ...new Set(
          recordIds
            .filter((recordId) => typeof recordId === "string")
            .map((recordId) => recordId.trim())
            .filter(Boolean),
        ),
      ]
    : [];

  if (normalizedRecordIds.length === 0) {
    return {
      skipped: true,
      reason: "no_records",
    };
  }

  const progressHandler =
    typeof syncProgress === "function"
      ? syncProgress
      : silent
        ? null
        : handleProgress;

  try {
    const records = await getRecords(normalizedRecordIds);
    if (stopRequested()) return canceledResult();
    const recordMap = new Map(records.map((record) => [record.id, record]));
    const targetRecordIds = normalizedRecordIds.filter((recordId) =>
      recordMap.has(recordId),
    );

    if (targetRecordIds.length === 0) {
      return {
        skipped: true,
        reason: "records_missing",
      };
    }

    const targetRecords = targetRecordIds.map((recordId) =>
      recordMap.get(recordId),
    );
    const commentLeadsConfig = buildCommentLeadsConfigFromSettings(settings);
    const requiredTypes = targetRecords
      .map(
        (record) =>
          resolveSyncInputForRecord(record)?.syncType ||
          record?.type ||
          record?.recordType,
      )
      .filter(Boolean);

    if (
      commentLeadsConfig.enabled &&
      requiredTypes.some(
        (syncType) =>
          syncType === SYNC_TYPE.SINGLE_NOTE ||
          syncType === SYNC_TYPE.COMMENTS ||
          syncType === SYNC_TYPE.BLOGGER_NOTES ||
          syncType === SYNC_TYPE.KEYWORD_NOTES,
      )
    ) {
      requiredTypes.push(SYNC_TYPE.COMMENT_LEADS);
    }

    if (!silent) {
      showProgress(`${sourceLabel}采集增强完成，正在自动同步后台...`);
    }
    const checkResult = await checkBeforeSync(requiredTypes, {
      onProgress: progressHandler,
    });
    if (stopRequested()) return canceledResult();
    if (!checkResult.ok) {
      const errorMsg =
        ERROR_MESSAGE_MAP[checkResult.error?.code] ||
        checkResult.error?.message ||
        "自动同步前检查失败";
      if (!silent) {
        showMessage(`${sourceLabel}自动同步未执行：${errorMsg}`, "warning");
      }
      return {
        ok: false,
        phase: "check",
        error: checkResult.error,
      };
    }

    const result = await syncRecordBatch(targetRecordIds, progressHandler, {
      trigger: "detail_auto",
      syncScope: SYNC_SCOPE_PENDING,
      captureSettings: settings,
      commentLeadsConfig,
      shouldStop: stopRequested,
      signal,
      captureTaskId,
      captureTaskItemAttemptId,
      captureTaskItemRequestHash,
    });

    if (result?.canceled) return canceledResult();

    if (refreshAfter) {
      await Promise.all([refreshDataPool(), refreshSyncHistory()]);
    }

    const leadsSyncedCount = Number(result.commentLeadsSyncedCount || 0);
    const leadsSkippedCount = Number(result.commentLeadsSkippedCount || 0);
    const leadsFailedCount = Number(result.commentLeadsFailedCount || 0);
    const leadsSummary =
      leadsSyncedCount > 0 || leadsSkippedCount > 0 || leadsFailedCount > 0
        ? `（客资：成功 ${leadsSyncedCount} / 跳过 ${leadsSkippedCount} / 失败 ${leadsFailedCount}）`
        : "";
    const skippedMessage =
      Number(result.skippedCount || 0) > 0
        ? `，剩余 ${result.skippedCount} 条待再次同步`
        : "";

    if (!silent) {
      if (result.ok) {
        showMessage(
          `${sourceLabel}已自动同步后台：${result.successCount} 条${skippedMessage}${leadsSummary}`,
          "success",
        );
      } else {
        showMessage(
          `${sourceLabel}自动同步部分失败：成功 ${result.successCount}，失败 ${result.failedCount}${skippedMessage}${leadsSummary}`,
          "warning",
        );
      }
    }

    return result;
  } catch (error) {
    if (stopRequested()) return canceledResult();
    console.error("[Sidebar] Auto sync after detail capture failed:", error);
    if (!silent) {
      showMessage(`${sourceLabel}自动同步失败: ${error.message}`, "warning");
    }
    if (refreshAfter) {
      await Promise.all([refreshDataPool(), refreshSyncHistory()]).catch(
        () => null,
      );
    }
    return {
      ok: false,
      phase: "sync",
      error,
    };
  }
}

async function runDetailCaptureForRecordIds(
  recordIds,
  settings,
  {
    progressMessage = "",
    onProgress = null,
    onItemSettled = null,
    waitForegroundTabId = null,
    captureTaskId = "",
    relevanceKeyword = "",
    unattendedRequestId = "",
    unattendedAttemptId = "",
  } = {},
) {
  const normalizedRecordIds = Array.isArray(recordIds)
    ? [
        ...new Set(
          recordIds.filter(
            (recordId) => typeof recordId === "string" && recordId.trim(),
          ),
        ),
      ]
    : [];

  if (normalizedRecordIds.length === 0) {
    return {
      ok: false,
      canceled: false,
      successCount: 0,
      failedCount: 0,
      results: [],
    };
  }

  const scopedUnattendedRequestId = String(
    unattendedRequestId || "",
  ).trim();
  const scopedUnattendedAttemptId = String(
    unattendedAttemptId || "",
  ).trim();
  const isCurrentDetailInvocation = () =>
    !scopedUnattendedRequestId ||
    (scopedUnattendedRequestId ===
      String(activeUnattendedRunRequestId || "").trim() &&
      (!scopedUnattendedAttemptId ||
        scopedUnattendedAttemptId ===
          String(activeUnattendedRunAttemptId || "").trim()));
  const detailInvocationToken = Symbol("detail-capture");
  activeDetailCaptureInvocationToken = detailInvocationToken;
  const ownsDetailInvocation = () =>
    activeDetailCaptureInvocationToken === detailInvocationToken;

  detailBatchCaptureInFlight = true;
  detailBatchCancelRequested = false;
  detailBatchRunnerTabId = null;
  detailBatchRunnerTabIds.clear();
  detailBatchWorkerStates = [];
  detailBatchWorkerMode = "";
  detailBatchWorkerRevision = 0;
  updateDataPoolUI(getCurrentDataPool());
  updatePageTypeUI(getCurrentRuntime()?.pageType || PAGE_TYPE.UNKNOWN);
  showProgress(
    progressMessage || `正在执行采集增强（0/${normalizedRecordIds.length}）...`,
  );

  try {
    // 每次新的增强批次都从“尚未自动重试”开始，避免上一次任务留下的
    // 重试次数误导当前卡片。真正开始补偿尝试时再写入当前次数。
    try {
      const initialRecords = await getRecords(normalizedRecordIds);
      const {updateRecord} = await import("../utils/storage.js");
      await Promise.all(
        initialRecords.map((record) =>
          updateRecord(record.id, {
            payload: {
              ...(record?.payload || {}),
              detailCaptureAutoRetryCount: 0,
              detailCaptureLastAutoRetryAt: "",
            },
          }),
        ),
      );
    } catch (error) {
      console.warn(
        "[Sidebar] Reset detail auto-retry metadata failed:",
        error,
      );
    }

    const deferredFirstFailureProgress = new Map();
    const settledOnRetryRecordIds = new Set();
    const handleDetailProgress = (
      progress = {},
      {attempt = 1, isRetry = false, retryCount = 0, maxRetries = 1} = {},
    ) => {
      const taskScopedProgress = {
        ...progress,
        ...(captureTaskId ? {captureTaskId} : {}),
        ...(scopedUnattendedRequestId
          ? {unattendedRequestId: scopedUnattendedRequestId}
          : {}),
        ...(scopedUnattendedAttemptId
          ? {unattendedAttemptId: scopedUnattendedAttemptId}
          : {}),
      };
      const normalizedProgress = isRetry
        ? {
            ...taskScopedProgress,
            captureTaskId: String(
              taskScopedProgress?.captureTaskId || captureTaskId || "",
            ).trim(),
            autoRetryAttempt: attempt,
            autoRetryCount: retryCount,
            autoRetryMaxRetries: maxRetries,
            message: `自动重试 ${retryCount}/${maxRetries}：${taskScopedProgress?.message || "正在重新采集增强"}`,
          }
        : {
            ...taskScopedProgress,
            captureTaskId: String(
              taskScopedProgress?.captureTaskId || captureTaskId || "",
            ).trim(),
          };
      if (!isCurrentDetailInvocation()) {
        return normalizedProgress;
      }
      const mergedProgress = handleProgress(normalizedProgress);
      if (typeof onProgress === "function") {
        onProgress(mergedProgress);
      }
      if (
        typeof onItemSettled === "function" &&
        DETAIL_ITEM_SETTLED_PHASES.has(
          String(mergedProgress?.phase || ""),
        ) &&
        String(mergedProgress?.recordId || "").trim()
      ) {
        const settledRecordId = String(mergedProgress.recordId).trim();
        if (
          !isRetry &&
          String(mergedProgress?.phase || "") === "detail_item_failed"
        ) {
          deferredFirstFailureProgress.set(settledRecordId, mergedProgress);
          return;
        }
        if (isRetry) {
          settledOnRetryRecordIds.add(settledRecordId);
        }
        Promise.resolve(onItemSettled(mergedProgress)).catch((error) => {
          console.warn("[Sidebar] Detail item settled callback failed:", error);
        });
      }
    };
    const result = await runEnhancementWithSingleRetry({
      recordIds: normalizedRecordIds,
      shouldStop: () =>
        detailBatchCancelRequested ||
        !ownsDetailInvocation() ||
        !isCurrentDetailInvocation(),
      onRetryScheduled: async ({
        recordIds: retryRecordIds,
        retryCount,
        maxRetries,
      }) => {
        const retryProgress = {
          phase: "enhance_retry_waiting",
          current: 0,
          total: retryRecordIds.length,
          autoRetryAttempt: retryCount + 1,
          autoRetryCount: retryCount,
          autoRetryMaxRetries: maxRetries,
          message: `采集增强有 ${retryRecordIds.length} 条临时失败，3 秒后自动重试 ${retryCount}/${maxRetries}...`,
        };
        handleDetailProgress(retryProgress, {
          attempt: retryCount + 1,
          isRetry: false,
        });
        showProgress(retryProgress.message, "info");
      },
      onRetryStarted: async ({
        recordIds: retryRecordIds,
        requiresContextRebuild = false,
        retryCount,
        maxRetries,
      }) => {
        const retryProgress = {
          phase: requiresContextRebuild
            ? "enhance_retry_rebuilding"
            : "enhance_retry_starting",
          current: 0,
          total: retryRecordIds.length,
          autoRetryAttempt: retryCount + 1,
          autoRetryCount: retryCount,
          autoRetryMaxRetries: maxRetries,
          message: requiresContextRebuild
            ? `正在重建采集上下文 · ${retryCount}/${maxRetries}（${retryRecordIds.length} 条）...`
            : `正在自动重试当前作品 · ${retryCount}/${maxRetries}（${retryRecordIds.length} 条）...`,
        };
        handleDetailProgress(retryProgress, {
          attempt: retryCount + 1,
          isRetry: false,
        });
        showProgress(retryProgress.message, "info");
        try {
          const retryRecords = await getRecords(retryRecordIds);
          const {updateRecord} = await import("../utils/storage.js");
          await Promise.all(
            retryRecords.map((record) =>
              updateRecord(record.id, {
                payload: {
                  ...(record?.payload || {}),
                  detailCaptureAutoRetryCount: Math.max(
                    retryCount,
                    Number(record?.payload?.detailCaptureAutoRetryCount) || 0,
                  ),
                  detailCaptureLastAutoRetryAt: new Date().toISOString(),
                },
              }),
            ),
          );
        } catch (error) {
          console.warn(
            "[Sidebar] Persist detail auto-retry metadata failed:",
            error,
          );
        }
      },
      prepareRetry: async ({
        requiresContextRebuild = false,
        retryCount,
        maxRetries,
      }) => {
        if (!requiresContextRebuild || !captureTaskId) {
          return;
        }
        if (!ownsDetailInvocation() || !isCurrentDetailInvocation()) {
          const error = new Error(
            "当前执行已被新的恢复任务接管，已停止旧上下文重建",
          );
          error.code = "STALE_UNATTENDED_ATTEMPT";
          throw error;
        }
        const runtime = getCurrentRuntime() || {};
        const preferredSourceTabId =
          Number(waitForegroundTabId) ||
          Number(runtime?.captureDebugSession?.sourceTabId) ||
          Number(runtime?.captureDebugSession?.tabId) ||
          Number(runtime?.lastActiveTabId) ||
          null;
        await rebuildCaptureTaskSessionForEnhancementRetry({
          taskId: captureTaskId,
          preferredTabId: preferredSourceTabId,
          platform: getPagePlatform(runtime) || getViewPlatform(runtime),
          label: `采集增强自动恢复 · ${retryCount}/${maxRetries}`,
          unattendedAttemptId: scopedUnattendedAttemptId,
        });
      },
      waitBeforeRetry: () =>
        sleepWithStop(3000, () => detailBatchCancelRequested),
      runAttempt: async (attemptRecordIds, attemptContext = {}) => {
        const isRetry = attemptContext.isRetry === true;
        if (isRetry) {
          showProgress(
            `正在自动重试采集增强 ${attemptContext.retryCount}/${attemptContext.maxRetries}（0/${attemptRecordIds.length}）...`,
            "info",
          );
        }
        return await batchCaptureDetailsForRecords(attemptRecordIds, {
          onProgress: (progress) =>
            handleDetailProgress(progress, attemptContext),
          shouldStop: () =>
            detailBatchCancelRequested ||
            !ownsDetailInvocation() ||
            !isCurrentDetailInvocation(),
          includeComments: Boolean(settings?.includeCommentsOnDetailCapture),
          includeBloggerMetrics: Boolean(
            settings?.includeBloggerMetricsOnDetailCapture,
          ),
          skipAlreadyCaptured:
            settings?.skipAlreadyCapturedOnDetailCapture !== false,
          enableCommentLeadsFilter: Boolean(
            settings?.enableCommentLeadsFilterOnDetailCapture,
          ),
          enableLowFollowerHitFilter: Boolean(
            settings?.enableLowFollowerHitFilterOnDetailCapture,
          ),
          lowFollowerHitThreshold:
            settings?.lowFollowerHitThresholdOnDetailCapture,
          commentsMaxDetectedItems:
            settings?.detailCommentsMaxDetectedItems ??
            settings?.commentsMaxDetectedItems,
          detailNavTimeoutMs: settings?.detailNavTimeoutMs,
          detailAfterNavWaitMs: settings?.detailAfterNavWaitMs,
          profileAfterNavWaitMs: settings?.profileAfterNavWaitMs,
          waitForegroundTabId,
          captureTaskId,
          enableAiRelevancePrefilter: Boolean(
            settings?.enableAiRelevancePrefilter,
          ),
          relevanceKeyword: String(relevanceKeyword || "").trim(),
        });
      },
    });

    if (typeof onItemSettled === "function") {
      const retriedRecordIds = new Set(result?.autoRetryRecordIds || []);
      for (const [recordId, progress] of deferredFirstFailureProgress) {
        if (result?.autoRetryAttempted && retriedRecordIds.has(recordId)) {
          continue;
        }
        Promise.resolve(onItemSettled(progress)).catch((error) => {
          console.warn("[Sidebar] Deferred detail settlement failed:", error);
        });
      }
      if (result?.autoRetryAttempted) {
        for (const recordId of retriedRecordIds) {
          if (settledOnRetryRecordIds.has(recordId)) continue;
          const item = (result?.results || []).find(
            (candidate) => String(candidate?.recordId || "").trim() === recordId,
          );
          if (!item) continue;
          Promise.resolve(
            onItemSettled({
              ...item,
              phase: item.ok ? "detail_item_done" : "detail_item_failed",
              recordId,
              autoRetryAttempt: Number(result.autoRetryCount || 0) + 1,
              autoRetryCount: Number(result.autoRetryCount || 0),
              autoRetryMaxRetries: Number(result.autoRetryMaxRetries || 1),
              message: item.ok
                ? `自动重试 ${result.autoRetryCount}/${result.autoRetryMaxRetries} 成功`
                : `自动重试 ${result.autoRetryCount}/${result.autoRetryMaxRetries} 后仍失败`,
            }),
          ).catch((error) => {
            console.warn("[Sidebar] Retry detail settlement failed:", error);
          });
        }
      }
    }

    await refreshDataPool();
    return result;
  } finally {
    const ownsInvocation = ownsDetailInvocation();
    const ownsCurrentInvocation =
      ownsInvocation && isCurrentDetailInvocation();
    if (ownsInvocation) {
      detailBatchCaptureInFlight = false;
      detailBatchCancelRequested = false;
      detailBatchRunnerTabId = null;
      detailBatchRunnerTabIds.clear();
      detailBatchWorkerStates = [];
      detailBatchWorkerMode = "";
      detailBatchWorkerRevision = 0;
      activeCommentsCaptureRecordId = "";
      activeCommentsCaptureTabId = null;
      activeCommentsCaptureRequestId = "";
      activeDetailCaptureInvocationToken = null;
    }
    if (ownsCurrentInvocation) {
      if (activeCaptureExecutionLockId) {
        void renewCaptureExecutionLock(activeCaptureExecutionLockId);
      }
      updateDataPoolUI(getCurrentDataPool());
      updatePageTypeUI(getCurrentRuntime()?.pageType || PAGE_TYPE.UNKNOWN);
    }
  }
}

/**
 * 处理导出
 */
async function handleExport() {
  if (detailBatchCaptureInFlight) {
    showMessage("正在执行采集增强，请等待完成后再导出", "warning");
    return;
  }

  const records = getCurrentPageRecords();

  if (records.length === 0) {
    showMessage("当前页面没有可导出的数据", "info");
    return;
  }

  try {
    const settings = await getCaptureSettings();
    const commentLeadsConfig = buildCommentLeadsConfigFromSettings(settings);
    const dateTag = new Date().toISOString().split("T")[0];
    const contentFilename = `onstarvoice-content-${dateTag}.csv`;
    const rows = buildCurrentPageCsvRows(records);
    await downloadCsvRowsByChrome(rows, contentFilename);

    let exportedLeadsCount = 0;
    if (commentLeadsConfig.enabled) {
      const normalizedRecords = normalizeRecordsToSingleNoteCsv(records);
      const leadsRows = buildCommentLeadsCsvRows(normalizedRecords, settings);
      exportedLeadsCount = Math.max(0, leadsRows.length - 1);
      if (exportedLeadsCount > 0) {
        await sleep(120);
        await downloadCsvRowsByChrome(
          leadsRows,
          `onstarvoice-comment-leads-${dateTag}.csv`,
        );
      }
    }

    if (commentLeadsConfig.enabled && exportedLeadsCount === 0) {
      showMessage(
        `已导出 ${records.length} 条记录，客资 0 条，已跳过`,
        "success",
      );
      return;
    }
    if (commentLeadsConfig.enabled && exportedLeadsCount > 0) {
      showMessage(
        `已导出 ${records.length} 条记录，客资 ${exportedLeadsCount} 条`,
        "success",
      );
      return;
    }
    showMessage(`已导出 ${records.length} 条记录`, "success");
  } catch (error) {
    console.error("[Sidebar] Export failed:", error);
    showMessage("导出失败: " + error.message, "error");
  }
}

/**
 * 处理清空数据池
 */
async function handleClearPool() {
  if (detailBatchCaptureInFlight) {
    showMessage("正在执行采集增强，请先停止或等待任务完成", "warning");
    return;
  }

  const records = getCurrentPageRecords();
  if (records.length === 0) {
    showMessage("当前页面缓存为空", "info");
    return;
  }

  if (!confirm("确定要清空当前页面缓存吗？此操作不可恢复！")) {
    return;
  }

  try {
    const {deleteRecords} = await import("../utils/storage.js");
    await deleteRecords(records.map((record) => record.id));
    await refreshDataPool();

    showMessage("当前页面缓存已清空", "success");
  } catch (error) {
    console.error("[Sidebar] Clear pool failed:", error);
    showMessage("清空失败: " + error.message, "error");
  }
}

async function handleClearSyncHistory() {
  if (
    !confirm(
      "确定要清空任务中心记录吗？真实仍在运行的任务会保留，历史、已结束和陈旧任务记录会被清除。",
    )
  ) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.CLEAR_TASK_CENTER,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "后台未能清空任务中心");
    }
    await Promise.all([refreshSyncHistory(), refreshTaskLedger()]);
    const preservedActiveCount = Number(
      response?.data?.preservedActiveCount || 0,
    );
    showMessage(
      preservedActiveCount > 0
        ? `任务中心已清理，保留 ${preservedActiveCount} 个真实运行中的任务`
        : "任务中心已清空",
      "success",
    );
  } catch (error) {
    console.error("[Sidebar] Clear task center failed:", error);
    showMessage("清空任务中心失败: " + error.message, "error");
  }
}

async function handleRecordListClick(event) {
  const monitorButton = event.target.closest(".btn-monitor-record");
  if (monitorButton) {
    const recordId = monitorButton.dataset.recordId;
    if (recordId) {
      await handleAddMonitorFromRecord(recordId);
    }
    return;
  }

  const stopButton = event.target.closest(".btn-stop-comments");
  if (stopButton) {
    const recordId = stopButton.dataset.id;
    if (recordId) {
      await handleStopCommentsCapture(recordId);
    }
    return;
  }

  const retryButton = event.target.closest(".btn-retry-comments");
  if (retryButton) {
    const recordId = retryButton.dataset.id;
    if (recordId) {
      await handleRetryCommentsCapture(recordId);
    }
    return;
  }

  const retryDetailButton = event.target.closest(".btn-retry-detail");
  if (retryDetailButton) {
    const recordId = retryDetailButton.dataset.id;
    if (recordId) {
      await handleRetryDetailCapture(recordId);
    }
    return;
  }

  const deleteButton = event.target.closest(".btn-del-record");
  if (deleteButton) {
    const recordId = deleteButton.dataset.id;
    if (recordId) {
      await handleDeleteRecord(recordId);
    }
    return;
  }

  const downloadButton = event.target.closest(".btn-download-record-media");
  if (downloadButton) {
    const recordId = downloadButton.dataset.id;
    if (recordId) {
      await handleDownloadRecordMedia(recordId);
    }
  }
}

async function repairStaleCommentCaptureCard(recordId) {
  const {getRecord, updateRecord} = await import("../utils/storage.js");
  const record = await getRecord(recordId);
  if (!record) return false;
  const payload =
    record.payload && typeof record.payload === "object" ? record.payload : {};
  let nextPayload = payload;
  let changed = false;

  if (record.type === "single_note") {
    const repaired = repairInterruptedCommentPayload(payload);
    nextPayload = repaired.payload;
    changed = repaired.changed;
  } else if (
    payload.detailPayload &&
    typeof payload.detailPayload === "object"
  ) {
    const repaired = repairInterruptedCommentPayload(payload.detailPayload);
    if (repaired.changed) {
      nextPayload = {...payload, detailPayload: repaired.payload};
      changed = true;
    }
  }

  if (changed) {
    await updateRecord(recordId, {payload: nextPayload});
    await refreshDataPool();
  }
  return changed;
}

async function handleStopCommentsCapture(recordId) {
  const runtimeProgress = getCurrentRuntime()?.lastCaptureProgress || {};
  const runtimePhase = String(runtimeProgress?.phase || "")
    .trim()
    .toLowerCase();
  const runtimeIsCommentCapture =
    runtimePhase.startsWith("comments_") ||
    runtimePhase === "detail_comments_capturing" ||
    String(runtimeProgress?.captureAction || "") === "captureComments";
  const runtimeRecordId = String(runtimeProgress?.recordId || "").trim();
  const runtimeAction = String(runtimeProgress?.captureAction || "").trim();
  const runtimeMatches =
    runtimeRecordId === recordId &&
    ACTIVE_COMMENT_PROGRESS_PHASES.has(runtimePhase) &&
    runtimeIsCommentCapture;
  const runtimeExplicitlyConflicts = Boolean(
    runtimePhase &&
      ((runtimeRecordId && runtimeRecordId !== recordId) ||
        (runtimeAction && runtimeAction !== "captureComments")),
  );
  const localMatches =
    activeCommentsCaptureRecordId === recordId &&
    !runtimeExplicitlyConflicts;

  if (!runtimeMatches && !localMatches) {
    await repairStaleCommentCaptureCard(recordId).catch((error) => {
      console.warn("[Sidebar] Repair stale comment card failed:", error);
    });
    showMessage(
      "这条记录的运行状态已经过期，已转为可继续状态；当前其他任务不会被取消",
      "warning",
    );
    return;
  }

  if (runtimeMatches) {
    updateActiveCommentCaptureIdentity(runtimeProgress);
  }
  await handleCancel();
}

async function handleRetryCommentsCapture(recordId) {
  const settings = await getCaptureSettings();
  const commentsMaxDetectedItems = readCommentsMaxDetectedItemsFromInput(
    settings.commentsMaxDetectedItems,
  );

  const executionLock = await acquireCaptureExecutionLock({
    owner: "manual_comments_retry",
    label: "评论采集",
  });
  if (!executionLock) {
    return false;
  }

  const taskContext = beginSidebarTask({
    taskType: "capture",
    featureKey: "capture.comments",
    metadata: {
      recordId,
      commentsMaxDetectedItems,
      retry: true,
    },
  });
  let taskStatus = "completed";
  let taskError = null;

  showProgress("正在打开对应作品并继续评论采集...", false);
  activeCommentsCaptureRecordId = recordId;

  try {
    const result = await retryCommentsForRecord(recordId, {
      commentsMaxDetectedItems,
      onProgress: handleProgress,
    });

    if (result.ok) {
      if (result.phase === "comments_partial") {
        taskStatus = "partial";
        showMessage(
          result.stoppedByNetwork
            ? "网络中断超过 2 分钟，已保留当前评论；联网后可继续当前项"
            : result.stoppedByStall
              ? "检测到页面卡顿，已保留当前评论；可继续当前项"
            : "评论采集已手动停止并合并",
          "warning",
        );
      } else {
        showMessage("评论采集已完成并合并", "success");
      }
    } else {
      const errorMsg =
        ERROR_MESSAGE_MAP[result.error?.code] ||
        result.error?.message ||
        "评论采集失败";
      showMessage(errorMsg, "error");
      taskStatus = "failed";
    }

    await refreshDataPool();
  } catch (error) {
    console.error("[Sidebar] Retry comments failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("重试评论失败: " + error.message, "error");
  } finally {
    activeCommentsCaptureRecordId = "";
    activeCommentsCaptureTabId = null;
    activeCommentsCaptureRequestId = "";
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        recordId,
        retry: true,
      },
    });
    hideProgress();
    await releaseCaptureExecutionLock(executionLock.id);
  }
  return true;
}

async function handleRetryDetailCapture(recordId) {
  if (detailBatchCaptureInFlight) {
    showMessage("采集增强任务进行中，请稍候...", "info");
    return;
  }

  const auth = getCurrentAuth() || {};
  if (!isAuthVerified(auth)) {
    showMessage(getAuthRequiredMessage(), "warning");
    return;
  }

  const settings = await getCaptureSettings();
  const batchRetryRecordIds = getBatchRetryDetailRecordIds(recordId);
  const shouldOfferBatchRetry = batchRetryRecordIds.length > 1;
  const targetRecordIds =
    shouldOfferBatchRetry &&
    confirm(
      `检测到当前页面还有 ${batchRetryRecordIds.length - 1} 条未完成采集增强，是否改为批量重试这 ${batchRetryRecordIds.length} 条？`,
    )
      ? batchRetryRecordIds
      : [recordId];
  const isBatchRetry = targetRecordIds.length > 1;
  const taskContext = beginSidebarTask({
    taskType: "capture",
    featureKey: "capture.enhancement",
    metadata: {
      recordId,
      targetCount: targetRecordIds.length,
      retry: true,
    },
  });
  let taskStatus = "completed";
  let taskError = null;

  try {
    const result = await runDetailCaptureForRecordIds(
      targetRecordIds,
      settings,
      {
        progressMessage: isBatchRetry
          ? `正在批量重试采集增强（0/${targetRecordIds.length}）...`
          : "正在重试采集增强（0/1）...",
      },
    );

    if (result.canceled) {
      taskStatus = "partial";
      const filterMsg =
        result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
      const failureSummary = buildDetailCaptureFailureSummaryText(result);
      showMessage(
        `采集增强已中止：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
        "warning",
      );
    } else if (result.ok) {
      const filterMsg =
        result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
      showMessage(
        `采集增强完成：成功 ${result.successCount} 条${filterMsg}`,
        "success",
      );
    } else {
      const filterMsg =
        result.filteredCount > 0 ? `，过滤 ${result.filteredCount}` : "";
      const failureSummary = buildDetailCaptureFailureSummaryText(result);
      taskStatus = "completed_with_failures";
      showMessage(
        `采集增强完成：成功 ${result.successCount}，失败 ${result.failedCount}${filterMsg}${failureSummary}`,
        "warning",
      );
    }
  } catch (error) {
    console.error("[Sidebar] Retry detail capture failed:", error);
    taskStatus = "failed";
    taskError = error;
    showMessage("采集增强失败: " + error.message, "error");
  } finally {
    finishSidebarTask(taskContext, {
      status: taskStatus,
      error: taskError,
      metadata: {
        recordId,
        targetCount: targetRecordIds.length,
        retry: true,
      },
    });
    hideProgress();
  }
}

async function handleDeleteRecord(recordId) {
  try {
    const {deleteRecord} = await import("../utils/storage.js");
    await deleteRecord(recordId);
    await refreshDataPool();
    showMessage("记录已移除", "success");
  } catch (error) {
    console.error("[Sidebar] Delete record failed:", error);
    showMessage("移除失败: " + error.message, "error");
  }
}

async function handleDownloadRecordMedia(recordId) {
  const dataPool = getCurrentDataPool();
  const records = dataPool?.records || [];
  const record = records.find((item) => item.id === recordId);
  if (!record) {
    showMessage("记录不存在", "error");
    return;
  }

  const mediaTasks = buildMediaDownloadTasks([record]);
  if (mediaTasks.length === 0) {
    showMessage("该记录没有可下载附件", "info");
    return;
  }

  const expectsVideo =
    record.type === "single_note" && isVideoNotePayload(record?.payload || {});
  const hasVideoTask = mediaTasks.some((task) => task.kind === "video");

  showProgress(`准备下载 ${mediaTasks.length} 个附件...`);
  try {
    let successCount = 0;
    let failedCount = 0;

    for (const task of mediaTasks) {
      try {
        await downloadByChrome(task.url, task.filename);
        successCount += 1;
      } catch (error) {
        console.warn("[Sidebar] Download media failed:", task.url, error);
        failedCount += 1;
      }
    }

    if (expectsVideo && !hasVideoTask) {
      showMessage(
        `附件下载完成，共 ${successCount} 个文件（未找到视频直链，仅下载封面/图片）`,
        "warning",
      );
    } else if (failedCount === 0) {
      showMessage(`附件下载完成，共 ${successCount} 个文件`, "success");
    } else {
      showMessage(
        `附件下载完成：成功 ${successCount}，失败 ${failedCount}`,
        "warning",
      );
    }
  } finally {
    hideProgress();
  }
}

const CAPTURE_RECOVERY_PHASES = new Set([
  "network_paused",
  "network_resumed",
  "network_timeout",
  "system_resumed",
  "capture_recovering",
  "capture_canceling",
  "capture_stalled",
  "comments_partial",
  "comments_failed",
  "interrupted_repaired",
]);
const CAPTURE_RECOVERY_UI_STALE_MS = 5 * 60 * 1000;
const ACTIVE_COMMENT_PROGRESS_PHASES = new Set([
  "comments_opening",
  "comments_collecting",
  "comments_capturing",
  "detail_comments_capturing",
  "network_paused",
  "network_resumed",
  "system_resumed",
  "capture_recovering",
  "capture_canceling",
]);

function isCaptureRecoveryPhase(phase) {
  return CAPTURE_RECOVERY_PHASES.has(String(phase || "").trim().toLowerCase());
}

function buildCaptureRecoverySuppressionKey(progress = {}) {
  const phase = String(progress?.phase || "").trim().toLowerCase();
  const recordId = String(progress?.recordId || "").trim();
  const captureRequestId = String(progress?.captureRequestId || "").trim();
  if (!phase || !recordId) return "";
  return `${phase}|${recordId}|${captureRequestId}`;
}

function clearSuppressedCaptureRecoveryForRecord(recordId) {
  const normalizedRecordId = String(recordId || "").trim();
  if (!normalizedRecordId) return;
  for (const key of suppressedCaptureRecoveryKeys) {
    if (key.split("|")[1] === normalizedRecordId) {
      suppressedCaptureRecoveryKeys.delete(key);
    }
  }
}

function updateActiveCommentCaptureIdentity(progress = {}) {
  const recordId = String(progress?.recordId || "").trim();
  if (!recordId) return;
  if (
    activeCommentsCaptureRecordId &&
    activeCommentsCaptureRecordId !== recordId
  ) {
    activeCommentsCaptureTabId = null;
    activeCommentsCaptureRequestId = "";
  }
  activeCommentsCaptureRecordId = recordId;

  const runnerTabId = Number(progress?.runnerTabId);
  if (Number.isFinite(runnerTabId) && runnerTabId > 0) {
    activeCommentsCaptureTabId = runnerTabId;
  }
  const captureRequestId = String(progress?.captureRequestId || "").trim();
  if (captureRequestId) {
    activeCommentsCaptureRequestId = captureRequestId;
  }
}

function setRecoveryCopy(elementId, value) {
  const element = document.getElementById(elementId);
  if (!element) return;
  const text = String(value || "").trim();
  if (element.textContent !== text) {
    element.textContent = text;
  }
  const shouldHide = !text;
  if (element.hidden !== shouldHide) {
    element.hidden = shouldHide;
  }
}

function isRecoveryActionAvailable(button) {
  return Boolean(
    button &&
      !button.hidden &&
      !button.disabled &&
      button.style.display !== "none",
  );
}

function handoffRecoveryFocus({
  previousActiveElement,
  progressContainer,
  btnRetry,
  btnDismiss,
  btnCancel,
}) {
  const recoveryActions = [btnRetry, btnDismiss, btnCancel].filter(Boolean);
  if (!recoveryActions.includes(previousActiveElement)) return;
  if (isRecoveryActionAvailable(previousActiveElement)) return;

  const nextAction = [btnRetry, btnDismiss, btnCancel].find(
    isRecoveryActionAvailable,
  );
  const nextFocus = nextAction || progressContainer;
  try {
    nextFocus?.focus({preventScroll: true});
  } catch {
    nextFocus?.focus();
  }
}

function resetCaptureRecoveryUI({hidePanel = false, clearState = true} = {}) {
  if (captureRecoveryFreshnessTimer) {
    clearTimeout(captureRecoveryFreshnessTimer);
    captureRecoveryFreshnessTimer = null;
  }
  const progressContainer = document.getElementById("progressContainer");
  if (progressContainer) {
    if (
      hidePanel &&
      progressContainer.dataset.progressSource === "capture-recovery"
    ) {
      progressContainer.style.display = "none";
      delete progressContainer.dataset.progressSource;
    }
    delete progressContainer.dataset.recoveryPinned;
    delete progressContainer.dataset.recoveryCancelable;
    delete progressContainer.dataset.recordId;
    delete progressContainer.dataset.captureRequestId;
    delete progressContainer.dataset.recoveryAnnouncementKey;
  }

  setRecoveryCopy("progressBadge", "");
  setRecoveryCopy("progressReason", "");
  setRecoveryCopy("progressNextStep", "");

  for (const id of ["btnRetryRecovery", "btnDismissRecovery"]) {
    const button = document.getElementById(id);
    if (button) {
      button.hidden = true;
      button.disabled = false;
    }
  }

  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.hidden = false;
    btnCancel.textContent = "中止任务";
    btnCancel.disabled = false;
  }

  if (clearState) {
    activeRecoveryProgress = null;
    activeRecoveryRunnerTabId = null;
  }
}

function renderCaptureRecoveryUI(progress) {
  const source = progress && typeof progress === "object" ? progress : {};
  const sourceRecordId = String(source.recordId || "").trim();
  const previousRecordId = String(
    activeRecoveryProgress?.recordId || "",
  ).trim();
  const canReuseIdentity =
    Boolean(sourceRecordId) && sourceRecordId === previousRecordId;
  const canReuseCommentIdentity =
    Boolean(sourceRecordId) &&
    sourceRecordId === activeCommentsCaptureRecordId;
  const normalizedProgress = {
    ...source,
    captureRequestId:
      String(source.captureRequestId || "").trim() ||
      (canReuseIdentity
        ? String(activeRecoveryProgress?.captureRequestId || "").trim()
        : "") ||
      (canReuseCommentIdentity
        ? String(activeCommentsCaptureRequestId || "").trim()
        : ""),
    runnerTabId:
      Number(source.runnerTabId) ||
      (canReuseIdentity ? Number(activeRecoveryRunnerTabId) || null : null) ||
      (canReuseCommentIdentity
        ? Number(activeCommentsCaptureTabId) || null
        : null),
    captureAction:
      String(source.captureAction || "").trim() ||
      (canReuseIdentity
        ? String(activeRecoveryProgress?.captureAction || "").trim()
        : ""),
  };
  const phase = String(normalizedProgress.phase || "").trim().toLowerCase();
  const suppressionKey = buildCaptureRecoverySuppressionKey(
    normalizedProgress,
  );
  if (suppressionKey && suppressedCaptureRecoveryKeys.has(suppressionKey)) {
    return false;
  }
  const canRetry =
    (phase === "comments_partial" ||
      phase === "comments_failed" ||
      phase === "interrupted_repaired") &&
    Boolean(String(normalizedProgress.recordId || "").trim());
  const view = resolveCaptureRecoveryView(normalizedProgress, {canRetry});
  if (!view.visible || isUnsupportedPlatformCoverVisible()) {
    return false;
  }
  if (captureRecoveryFreshnessTimer) {
    clearTimeout(captureRecoveryFreshnessTimer);
    captureRecoveryFreshnessTimer = null;
  }

  const progressContainer = document.getElementById("progressContainer");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  if (!progressContainer || !progressBar || !progressText) {
    return false;
  }
  if (progressContainer.dataset.progressSource === "keyword-plan") {
    clearKeywordPlanProgressCountdown();
  }

  const tone = ["info", "success", "warning", "error", "danger"].includes(
    view.tone,
  )
    ? view.tone
    : "info";
  const announcementKey = buildCaptureRecoveryAnnouncementKey(view);
  const shouldUpdateAnnouncement =
    progressContainer.dataset.recoveryAnnouncementKey !== announcementKey;
  const previousActiveElement = document.activeElement;
  progressContainer.dataset.progressSource = "capture-recovery";
  progressContainer.dataset.recoveryPinned = view.pinned ? "true" : "false";
  progressContainer.dataset.recoveryCancelable = view.showCancel
    ? "true"
    : "false";
  if (view.recordId) {
    progressContainer.dataset.recordId = view.recordId;
  } else {
    delete progressContainer.dataset.recordId;
  }
  if (view.captureRequestId) {
    progressContainer.dataset.captureRequestId = view.captureRequestId;
  } else {
    delete progressContainer.dataset.captureRequestId;
  }
  progressContainer.style.display = "block";

  const btnRetry = document.getElementById("btnRetryRecovery");
  const btnDismiss = document.getElementById("btnDismissRecovery");
  const btnCancel = document.getElementById("btnCancel");
  if (shouldUpdateAnnouncement) {
    progressContainer.dataset.recoveryAnnouncementKey = announcementKey;
    progressBar.className = `status-bar capture-recovery-status is-${tone}`;
    if (progressText.textContent !== view.title) {
      progressText.textContent = view.title;
    }
    progressText.hidden = false;
    setRecoveryCopy("progressBadge", view.statusLabel);
    setRecoveryCopy("progressReason", view.detail);
    setRecoveryCopy("progressNextStep", view.nextStep);

    if (btnRetry) {
      btnRetry.hidden = !view.showRetry;
      btnRetry.disabled = !view.showRetry;
      btnRetry.textContent = view.retryLabel || "继续当前项";
    }
    if (btnDismiss) {
      btnDismiss.hidden = !view.showDismiss;
      btnDismiss.disabled = false;
      btnDismiss.textContent = view.dismissLabel || "保留结果";
    }
    if (btnCancel) {
      btnCancel.hidden = !view.showCancel;
      btnCancel.style.display = view.showCancel ? "inline-flex" : "none";
      btnCancel.disabled = false;
      btnCancel.textContent = view.cancelLabel || "取消并保留";
    }
    handoffRecoveryFocus({
      previousActiveElement,
      progressContainer,
      btnRetry,
      btnDismiss,
      btnCancel,
    });
  }

  activeRecoveryProgress = {...normalizedProgress, ...view};
  const runnerTabId = Number(
    view.runnerTabId || normalizedProgress.runnerTabId,
  );
  activeRecoveryRunnerTabId =
    Number.isFinite(runnerTabId) && runnerTabId > 0 ? runnerTabId : null;
  const isCommentRecovery =
    phase.startsWith("comments_") ||
    String(normalizedProgress.captureAction || "") === "captureComments";
  if (isCommentRecovery && view.recordId) {
    updateActiveCommentCaptureIdentity({
      ...normalizedProgress,
      recordId: view.recordId,
      runnerTabId: activeRecoveryRunnerTabId,
      captureRequestId: view.captureRequestId,
    });
  }
  const numericUpdatedAt = Number(normalizedProgress.updatedAt);
  const parsedUpdatedAt = Date.parse(String(normalizedProgress.updatedAt || ""));
  const updatedAt =
    Number.isFinite(numericUpdatedAt) && numericUpdatedAt > 0
      ? numericUpdatedAt
      : parsedUpdatedAt;
  if (Number.isFinite(updatedAt) && updatedAt > 0) {
    activeRecoveryProgress.updatedAt = updatedAt;
    const identity = [
      phase,
      view.recordId,
      view.captureRequestId,
      String(updatedAt),
    ].join("|");
    captureRecoveryFreshnessTimer = setTimeout(() => {
      const activeIdentity = [
        String(activeRecoveryProgress?.phase || ""),
        String(activeRecoveryProgress?.recordId || ""),
        String(activeRecoveryProgress?.captureRequestId || ""),
        String(Number(activeRecoveryProgress?.updatedAt) || 0),
      ].join("|");
      if (activeIdentity === identity) {
        resetCaptureRecoveryUI({hidePanel: true, clearState: true});
      }
    }, Math.min(
      CAPTURE_RECOVERY_UI_STALE_MS,
      Math.max(50, updatedAt + CAPTURE_RECOVERY_UI_STALE_MS - Date.now()),
    ));
  }
  return true;
}

async function handleRetryRecovery() {
  const progressContainer = document.getElementById("progressContainer");
  const recordId = String(
    activeRecoveryProgress?.recordId ||
      progressContainer?.dataset.recordId ||
      "",
  ).trim();
  if (!recordId) {
    showMessage("当前提示没有可继续的评论记录，请从记录卡片重试", "warning");
    return;
  }
  const snapshot = activeRecoveryProgress
    ? {...activeRecoveryProgress}
    : null;
  const suppressionKey = buildCaptureRecoverySuppressionKey(snapshot);
  if (suppressionKey) {
    suppressedCaptureRecoveryKeys.add(suppressionKey);
  }
  const started = await handleRetryCommentsCapture(recordId);
  if (started === false && suppressionKey) {
    suppressedCaptureRecoveryKeys.delete(suppressionKey);
    if (snapshot) {
      renderCaptureRecoveryUI({...snapshot, updatedAt: Date.now()});
    }
  }
}

function handleDismissRecovery() {
  const snapshot = activeRecoveryProgress
    ? {...activeRecoveryProgress}
    : null;
  const suppressionKey = buildCaptureRecoverySuppressionKey(snapshot);
  if (suppressionKey) {
    suppressedCaptureRecoveryKeys.add(suppressionKey);
    while (suppressedCaptureRecoveryKeys.size > 200) {
      const oldestKey = suppressedCaptureRecoveryKeys.values().next().value;
      if (!oldestKey) break;
      suppressedCaptureRecoveryKeys.delete(oldestKey);
    }
  }
  resetCaptureRecoveryUI({hidePanel: true, clearState: true});
  if (!snapshot) return;

  const clearPersistedProgress = (updatedAt = 0) =>
    Promise.resolve(
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.CLEAR_CAPTURE_PROGRESS,
        phase: String(snapshot.phase || ""),
        recordId: String(snapshot.recordId || ""),
        captureRequestId: String(snapshot.captureRequestId || ""),
        updatedAt,
      }),
    );
  void clearPersistedProgress(Number(snapshot.updatedAt) || 0).catch((error) => {
    console.warn("[Sidebar] Clear dismissed recovery progress failed:", error);
  });
  if (String(snapshot.captureRequestId || "").trim()) {
    setTimeout(() => {
      void clearPersistedProgress(0).catch(() => null);
    }, 250);
  }
}

function publishCommentProgressToRuntime(progress) {
  const phase = String(progress?.phase || "").trim();
  if (!phase.startsWith("comments_")) {
    return;
  }
  const recordId = String(progress?.recordId || "").trim();
  if (!recordId) {
    return;
  }
  const sameRecoveryRecord =
    String(activeRecoveryProgress?.recordId || "").trim() === recordId;
  const payload = {
    ...progress,
    recordId,
    captureAction: "captureComments",
    captureRequestId:
      String(progress?.captureRequestId || "").trim() ||
      (sameRecoveryRecord
        ? String(activeRecoveryProgress?.captureRequestId || "").trim()
        : ""),
    runnerTabId:
      Number(progress?.runnerTabId) ||
      (sameRecoveryRecord ? Number(activeRecoveryRunnerTabId) || null : null),
    updatedAt: Date.now(),
  };
  void Promise.resolve(
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.CAPTURE_PROGRESS,
      payload,
    }),
  )
    .catch((error) => {
      console.warn("[Sidebar] Publish comment progress failed:", error);
    });
}

/**
 * 处理进度回调
 */
function reportActiveSidebarTaskProgress(progress = {}) {
  const taskContext = getActiveTaskContext();
  if (!taskContext?.taskId) return;
  // 无人值守已有 request root 作为唯一公开任务台账；内部 Debug wrapper
  // 只负责浏览器接管。若把作品级 current/total 再写成关键词任务，会产生
  // processed=8,total=4 的双记录和陈旧 detail_item_* 终态。
  if (taskContext.featureKey === "capture.unattended_keyword") return;
  const now = Date.now();
  if (now - lastTaskLedgerProgressAt < 1500) return;
  lastTaskLedgerProgressAt = now;
  const phase = String(progress?.phase || "");
  const status =
    phase === "network_paused"
      ? "paused"
      : phase.includes("recover") || phase === "system_resumed"
        ? "recovering"
        : "running";
  const progressPatch = {
    current: Number.isFinite(Number(progress?.current))
      ? Number(progress.current)
      : 0,
    total: Number.isFinite(Number(progress?.total))
      ? Number(progress.total)
      : 0,
    phase,
    message: String(progress?.message || ""),
    recordId: String(progress?.recordId || ""),
    keyword: String(progress?.keyword || ""),
    savedCount: Number.isFinite(Number(progress?.savedCount))
      ? Number(progress.savedCount)
      : Number.isFinite(Number(progress?.collectedCount))
        ? Number(progress.collectedCount)
        : null,
  };
  const taskRun = buildSidebarTaskRun(taskContext, {
    status,
    progress: progressPatch,
    businessProgressAt: new Date(now).toISOString(),
  });
  void reportSidebarTaskRun(taskRun, {
    type: "progress",
    status,
    phase,
    message: progressPatch.message,
  });
}

function reportActiveUnattendedContentProgress(progress = {}) {
  if (
    !activeUnattendedRunRequestId ||
    !activeUnattendedRunAttemptId ||
    activeUnattendedAttemptRejected
  ) {
    return;
  }
  const activeTerminalKey = `${String(activeUnattendedRunRequestId || "").trim()}:${String(activeUnattendedRunAttemptId || "").trim()}`;
  if (
    activeUnattendedTerminalProgressKey &&
    activeUnattendedTerminalProgressKey === activeTerminalKey
  ) {
    return;
  }
  progress = projectCaptureTaskProgress(progress);
  const phase = String(progress?.phase || "").trim();
  const message = String(progress?.message || "").trim();
  const fingerprint = JSON.stringify({
    phase,
    message,
    captureRequestId: String(progress?.captureRequestId || ""),
    recordId: String(progress?.recordId || ""),
    keyword: String(progress?.keyword || ""),
    current: Number(progress?.current) || 0,
    count: Number(progress?.count) || 0,
    detectedCount: Number(progress?.detectedCount) || 0,
    qualifiedCount: Number(progress?.qualifiedCount) || 0,
    filteredCount: Number(progress?.filteredCount) || 0,
    collectedCount: Number(progress?.collectedCount) || 0,
    savedCount: Number(progress?.savedCount) || 0,
  });
  if (!phase && !message) return;
  if (fingerprint === lastUnattendedContentProgressFingerprint) return;
  const now = Date.now();
  if (
    now - lastUnattendedContentProgressAt <
    UNATTENDED_CONTENT_PROGRESS_MIN_INTERVAL_MS
  ) {
    return;
  }
  lastUnattendedContentProgressAt = now;
  lastUnattendedContentProgressFingerprint = fingerprint;
  activeUnattendedProgressSeq += 1;
  void reportUnattendedKeywordRun(activeUnattendedRunRequestId, {
    status: "running",
    progressSeq: activeUnattendedProgressSeq,
    progress: {
      current: Number.isFinite(Number(progress?.current))
        ? Number(progress.current)
        : Number(progress?.detectedCount) || Number(progress?.collectedCount) || 0,
      total: Number.isFinite(Number(progress?.total)) ? Number(progress.total) : 0,
      keyword: String(progress?.keyword || ""),
      keywordCurrent: readFiniteProgressNumber(progress?.keywordCurrent),
      keywordTotal: readFiniteProgressNumber(progress?.keywordTotal),
      itemCurrent: readFiniteProgressNumber(progress?.itemCurrent),
      itemTotal: readFiniteProgressNumber(progress?.itemTotal),
      nextKeyword: String(progress?.nextKeyword || ""),
      runStartedAt: String(progress?.runStartedAt || ""),
      progressScope: String(progress?.progressScope || ""),
      round: readFiniteProgressNumber(progress?.roundCurrent, progress?.round),
      roundCurrent: readFiniteProgressNumber(
        progress?.roundCurrent,
        progress?.round,
      ),
      roundTotal: readFiniteProgressNumber(progress?.roundTotal),
      attemptCurrent: readFiniteProgressNumber(
        progress?.attemptCurrent,
        progress?.attempt,
      ),
      attemptTotal: readFiniteProgressNumber(
        progress?.attemptTotal,
        progress?.maxAttempts,
      ),
      remainingMs: readFiniteProgressNumber(progress?.remainingMs),
      waitUntil: String(progress?.waitUntil || ""),
      phase,
      message: message || "采集内容持续更新中",
      recordId: String(progress?.recordId || ""),
      savedCount: Number.isFinite(Number(progress?.savedCount))
        ? Number(progress.savedCount)
        : Number.isFinite(Number(progress?.collectedCount))
          ? Number(progress.collectedCount)
          : null,
      phaseStartedAt: String(progress?.phaseStartedAt || ""),
      workerMode: String(progress?.workerMode || ""),
      workerStates: Array.isArray(progress?.workerStates)
        ? progress.workerStates.slice(0, 2)
        : [],
      taskMeta:
        progress?.taskMeta && typeof progress.taskMeta === "object"
          ? progress.taskMeta
          : {},
      updatedAt: new Date(now).toISOString(),
    },
  }).catch(() => null);
}

function handleProgress(progress) {
  const incomingCaptureTaskId = String(
    progress?.captureTaskId || progress?.taskId || "",
  ).trim();
  const currentCaptureTaskId = String(
    captureTaskOwnerTaskId ||
      activeCaptureTaskProgressContext?.captureTaskId ||
      "",
  ).trim();
  if (
    incomingCaptureTaskId &&
    currentCaptureTaskId &&
    incomingCaptureTaskId !== currentCaptureTaskId
  ) {
    return progress;
  }
  const incomingUnattendedRequestId = String(
    progress?.unattendedRequestId || "",
  ).trim();
  if (
    activeUnattendedRunRequestId &&
    incomingUnattendedRequestId !== activeUnattendedRunRequestId
  ) {
    return progress;
  }
  const incomingUnattendedAttemptId = String(
    progress?.unattendedAttemptId || progress?.attemptId || "",
  ).trim();
  const currentUnattendedAttemptId =
    typeof activeUnattendedRunAttemptId === "undefined"
      ? ""
      : String(activeUnattendedRunAttemptId || "").trim();
  if (
    currentUnattendedAttemptId &&
    incomingUnattendedAttemptId !== currentUnattendedAttemptId
  ) {
    return progress;
  }
  const incomingTerminalKey = `${incomingUnattendedRequestId || String(activeUnattendedRunRequestId || "").trim()}:${incomingUnattendedAttemptId || currentUnattendedAttemptId}`;
  if (
    activeUnattendedTerminalProgressKey &&
    activeUnattendedTerminalProgressKey === incomingTerminalKey
  ) {
    return progress;
  }
  progress = rememberCaptureTaskProgressContext(progress);
  const incomingPhase = String(progress?.phase || "");
  const incomingWorkerRevision = Number(progress?.workerRevision);
  const hasWorkerRevision =
    Number.isSafeInteger(incomingWorkerRevision) && incomingWorkerRevision >= 0;
  if (
    Array.isArray(progress?.workerStates) &&
    (!hasWorkerRevision || incomingWorkerRevision >= detailBatchWorkerRevision)
  ) {
    detailBatchWorkerStates = progress.workerStates.map((state) => ({...state}));
    if (hasWorkerRevision) {
      detailBatchWorkerRevision = incomingWorkerRevision;
    }
  }
  if (typeof progress?.workerMode === "string" && progress.workerMode.trim()) {
    detailBatchWorkerMode = progress.workerMode.trim();
  }
  if (incomingPhase.startsWith("detail_") && detailBatchWorkerStates.length > 0) {
    progress = {
      ...progress,
      workerStates: detailBatchWorkerStates.map((state) => ({...state})),
      workerMode: progress?.workerMode || detailBatchWorkerMode,
      workerRevision: Math.max(
        detailBatchWorkerRevision,
        hasWorkerRevision ? incomingWorkerRevision : 0,
      ),
      runnerTabIds:
        Array.isArray(progress?.runnerTabIds) && progress.runnerTabIds.length > 0
          ? progress.runnerTabIds
          : getKnownDetailRunnerTabIds(),
    };
  }
  console.log("[Sidebar] Progress:", progress);
  void updateCaptureTaskSession({
    taskId: incomingCaptureTaskId || captureTaskOwnerTaskId,
    progress,
  });
  reportActiveUnattendedContentProgress(progress);
  reportActiveSidebarTaskProgress(progress);

  // 如果进入了单项的评论采集阶段，全局进度条无需显示，因为卡片上已有进度和停止按钮
  const phase = incomingPhase;
  const progressRecordId =
    typeof progress?.recordId === "string" ? progress.recordId.trim() : "";
  if (progressRecordId && ACTIVE_COMMENT_PROGRESS_PHASES.has(phase)) {
    clearSuppressedCaptureRecoveryForRecord(progressRecordId);
  }
  const progressContainer = document.getElementById("progressContainer");
  const unattendedScoped = Boolean(
    activeUnattendedRunRequestId ||
      progress?.unattendedRequestId ||
      progressContainer?.dataset?.unattendedProgressState,
  );
  const isTerminalPhase = unattendedScoped
    ? isUnattendedTerminalProgressPhase(phase)
    : isTerminalProgressPhase(phase);
  const unattendedProgressState = String(
    progressContainer?.dataset?.unattendedProgressState || "",
  );
  const suppressLateUnattendedUi =
    unattendedProgressState === "terminal" && !isTerminalPhase;
  const recoveryRendered = suppressLateUnattendedUi
    ? false
    : renderCaptureRecoveryUI(progress);
  publishCommentProgressToRuntime(progress);
  if (
    isTerminalPhase &&
    progressContainer &&
    (activeUnattendedRunRequestId || unattendedProgressState === "running")
  ) {
    progressContainer.dataset.unattendedProgressState = "terminal";
  }
  if (isTerminalPhase && !recoveryRendered) {
    hideProgressPanelOnly({
      force: true,
      preserveUnattendedTerminalState: true,
    });
  }

  if (phase.startsWith("detail_")) {
    if (Number.isFinite(Number(progress?.runnerTabId))) {
      const nextRunnerTabId = Number(progress.runnerTabId);
      const runnerChanged = detailBatchRunnerTabId !== nextRunnerTabId;
      detailBatchRunnerTabId = nextRunnerTabId;
      if (runnerChanged && activeCaptureExecutionLockId) {
        void renewCaptureExecutionLock(
          activeCaptureExecutionLockId,
          nextRunnerTabId,
        );
      }
    }
  }

  if (phase.startsWith("comments_") && !recoveryRendered) {
    if (progressContainer?.dataset.progressSource === "capture-recovery") {
      resetCaptureRecoveryUI({hidePanel: true, clearState: true});
    } else if (progressContainer) {
      progressContainer.style.display = "none";
    }
  } else if (
    !recoveryRendered &&
    !isTerminalPhase &&
    !suppressLateUnattendedUi
  ) {
    if (progressContainer?.dataset.progressSource === "capture-recovery") {
      resetCaptureRecoveryUI({hidePanel: false, clearState: true});
      progressContainer.dataset.progressSource = "capture";
    }
    if (progressContainer && !isUnsupportedPlatformCoverVisible()) {
      if (activeUnattendedRunRequestId) {
        progressContainer.dataset.unattendedProgressState = "running";
      }
      progressContainer.style.display = "block";
    }
    const btnCancel = document.getElementById("btnCancel");
    if (btnCancel && progressContainer?.style.display !== "none") {
      btnCancel.hidden = false;
      btnCancel.disabled = false;
      btnCancel.textContent = "中止任务";
      btnCancel.style.display = "inline-flex";
    }
    // 否则正常更新全局进度消息
    const progressText = document.getElementById("progressText");
    const progressBar = document.getElementById("progressBar");
    const nextMessage = buildCaptureProgressText(progress);
    if (progressText && nextMessage) {
      progressText.textContent = nextMessage;
      if (progressBar) {
        progressBar.className = "status-bar is-info";
      }
    }
  }

  const isCommentProgress =
    phase.startsWith("comments_") ||
    phase === "detail_comments_capturing" ||
    ((phase === "network_paused" ||
      phase === "network_resumed" ||
      phase === "network_timeout" ||
      phase === "system_resumed") &&
      Boolean(progressRecordId));

  if (progressRecordId && isCommentProgress) {
    updateActiveCommentCaptureIdentity(progress);
  }

  if (phase === "comments_capturing" && progressRecordId) {
    clearCommentCaptureTerminalStatus(progressRecordId);
  }

  const terminalCommentStatus = resolveCommentTerminalStatusFromPhase(phase);
  if (terminalCommentStatus && progressRecordId) {
    markCommentCaptureTerminalStatus(progressRecordId, terminalCommentStatus);
    reconcileCommentCaptureTerminalState(progressRecordId, {
      status: terminalCommentStatus,
      collectedCount: progress?.collectedCount,
      errorMessage:
        terminalCommentStatus === "failed"
          ? String(progress?.error?.message || progress?.message || "")
          : "",
    }).catch((error) => {
      console.warn(
        "[Sidebar] Failed to reconcile terminal comment status:",
        error,
      );
    });
  }

  if (
    activeCommentsCaptureRecordId &&
    Number.isFinite(Number(progress?.collectedCount))
  ) {
    const nextCount = Number(progress.collectedCount);
    if (!isCommentCaptureTerminal(activeCommentsCaptureRecordId)) {
      syncCommentProgressToRecord(
        activeCommentsCaptureRecordId,
        nextCount,
      ).catch((error) => {
        console.warn("[Sidebar] Failed to sync comment progress:", error);
      });
    }
  }

  if (phase.startsWith("comments_")) {
    refreshDataPoolThrottled().catch((error) => {
      console.warn(
        "[Sidebar] Failed to refresh pool during comments capture:",
        error,
      );
    });
  } else if (phase.startsWith("detail_")) {
    refreshDataPoolThrottled().catch((error) => {
      console.warn(
        "[Sidebar] Failed to refresh pool during detail capture:",
        error,
      );
    });
  }
  if (
    terminalCommentStatus &&
    activeCommentsCaptureRecordId === progressRecordId
  ) {
    activeCommentsCaptureRecordId = "";
    activeCommentsCaptureTabId = null;
    activeCommentsCaptureRequestId = "";
  }
  return progress;
}

async function syncRuntimeCommentProgress(runtime) {
  const progress = runtime?.lastCaptureProgress;
  if (!progress) {
    return;
  }
  const phase = String(progress.phase || "");
  if (!phase.startsWith("comments_")) {
    return;
  }
  const progressRecordId = String(progress?.recordId || "").trim();
  if (progressRecordId) {
    updateActiveCommentCaptureIdentity(progress);
  }
  if (!activeCommentsCaptureRecordId) {
    return;
  }
  if (phase === "comments_collecting" || phase === "comments_capturing") {
    hideProgressPanelOnly({force: true});
  }
  if (phase === "comments_capturing") {
    clearCommentCaptureTerminalStatus(activeCommentsCaptureRecordId);
  }
  const terminalCommentStatus = resolveCommentTerminalStatusFromPhase(phase);
  if (terminalCommentStatus) {
    markCommentCaptureTerminalStatus(
      activeCommentsCaptureRecordId,
      terminalCommentStatus,
    );
    await reconcileCommentCaptureTerminalState(activeCommentsCaptureRecordId, {
      status: terminalCommentStatus,
      collectedCount: progress?.collectedCount,
      errorMessage:
        terminalCommentStatus === "failed"
          ? String(progress?.error?.message || progress?.message || "")
          : "",
    });
    activeCommentsCaptureRecordId = "";
    activeCommentsCaptureTabId = null;
    activeCommentsCaptureRequestId = "";
    return;
  }
  if (!Number.isFinite(Number(progress.collectedCount))) {
    return;
  }
  if (isCommentCaptureTerminal(activeCommentsCaptureRecordId)) {
    return;
  }

  await syncCommentProgressToRecord(
    activeCommentsCaptureRecordId,
    Number(progress.collectedCount),
  );
}

function syncRuntimeCaptureProgress(runtime) {
  const progress = runtime?.lastCaptureProgress;
  if (!progress) {
    const progressContainer = document.getElementById("progressContainer");
    if (
      progressContainer?.dataset.progressSource === "capture-recovery" &&
      String(activeRecoveryProgress?.phase || "") !== "interrupted_repaired"
    ) {
      resetCaptureRecoveryUI({hidePanel: true, clearState: true});
    }
    return;
  }

  const incomingCaptureTaskId = String(
    progress?.captureTaskId || progress?.taskId || "",
  ).trim();
  const currentCaptureTaskId = String(
    captureTaskOwnerTaskId ||
      activeCaptureTaskProgressContext?.captureTaskId ||
      runtime?.captureDebugSession?.taskId ||
      "",
  ).trim();
  const incomingUnattendedRequestId = String(
    progress?.unattendedRequestId || "",
  ).trim();
  const incomingUnattendedAttemptId = String(
    progress?.unattendedAttemptId || progress?.attemptId || "",
  ).trim();
  if (
    (incomingCaptureTaskId &&
      currentCaptureTaskId &&
      incomingCaptureTaskId !== currentCaptureTaskId) ||
    (activeUnattendedRunRequestId &&
      incomingUnattendedRequestId !== activeUnattendedRunRequestId) ||
    (activeUnattendedRunAttemptId &&
      incomingUnattendedAttemptId !== activeUnattendedRunAttemptId)
  ) {
    return;
  }

  const phase = String(progress.phase || "");
  if (ACTIVE_COMMENT_PROGRESS_PHASES.has(phase)) {
    clearSuppressedCaptureRecoveryForRecord(progress?.recordId);
  }
  const isRecoveryPhase = isCaptureRecoveryPhase(phase);
  const recoveryRendered = isRecoveryPhase
    ? renderCaptureRecoveryUI(progress)
    : false;
  if (isRecoveryPhase && !recoveryRendered) {
    resetCaptureRecoveryUI({hidePanel: true, clearState: true});
  }
  if (recoveryRendered) {
    return;
  }
  if (detailBatchCaptureInFlight && !isRecoveryPhase) {
    return;
  }
  if (!phase) {
    return;
  }
  const progressContainer = document.getElementById("progressContainer");
  const unattendedScoped = Boolean(
    activeUnattendedRunRequestId ||
      progress?.unattendedRequestId ||
      progressContainer?.dataset?.unattendedProgressState,
  );
  const terminalForCurrentScope = unattendedScoped
    ? isUnattendedTerminalProgressPhase(phase)
    : isTerminalProgressPhase(phase);
  if (
    progressContainer?.dataset?.unattendedProgressState === "terminal" &&
    !terminalForCurrentScope
  ) {
    return;
  }
  if (phase.startsWith("comments_")) {
    hideProgressPanelOnly({force: true});
    return;
  }
  if (terminalForCurrentScope) {
    if (
      progressContainer &&
      (activeUnattendedRunRequestId ||
        progressContainer.dataset.unattendedProgressState === "running")
    ) {
      progressContainer.dataset.unattendedProgressState = "terminal";
    }
    hideProgressPanelOnly({
      force: true,
      preserveUnattendedTerminalState: true,
    });
    if (batchKeywordCaptureInFlight) {
      setBatchProgressDetail("");
    }
    return;
  }

  // 批量关键词采集进行中:把底层细粒度进度(探测/筛选/防反爬等待)镜像到弹窗明细行,
  // 并收起外部蓝色进度条 + 中止按钮(统一并入弹窗,避免重复)
  if (batchKeywordCaptureInFlight) {
    setBatchProgressDetail(buildCaptureProgressText(progress));
    hideProgressPanelOnly();
    return;
  }

  const progressText = document.getElementById("progressText");
  if (!progressContainer || !progressText) {
    return;
  }

  if (isUnsupportedPlatformCoverVisible()) {
    hideProgressPanelOnly({force: true});
    return;
  }

  // 仅在本次会话已经主动展示进度面板时，才继续用 runtime 进度刷新。
  // 避免旧任务遗留的 progress 在空闲状态下重新弹出。
  if (progressContainer.style.display === "none" && !isRecoveryPhase) {
    return;
  }

  const nextMessage = buildCaptureProgressText(progress);
  if (!nextMessage) {
    return;
  }

  if (progressContainer.dataset.progressSource === "capture-recovery") {
    resetCaptureRecoveryUI({hidePanel: false, clearState: true});
  }
  progressContainer.dataset.progressSource = "capture";
  if (activeUnattendedRunRequestId) {
    progressContainer.dataset.unattendedProgressState = "running";
  }
  progressContainer.style.display = "block";
  progressText.textContent = nextMessage;
  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.hidden = false;
    btnCancel.disabled = false;
    btnCancel.textContent = "中止任务";
    btnCancel.style.display = "inline-flex";
  }
  const progressBar = document.getElementById("progressBar");
  if (progressBar) {
    progressBar.className = "status-bar is-info";
  }
}

function buildCaptureProgressText(progress) {
  const message = String(progress?.message || "").trim();
  const detectedCount = normalizeProgressCount(progress?.detectedCount);
  const filteredCount = normalizeProgressCount(progress?.filteredCount);
  const minLikes = normalizeProgressCount(progress?.minLikes);
  const sortDimension = normalizeKeywordSortDimension(progress?.sortDimension);
  const sortLabel = getKeywordSortDimensionLabel(sortDimension);
  const maxDetectedItems = normalizeProgressCount(
    progress?.maxDetectedItems ?? progress?.maxItems,
  );
  const markedCount = normalizeProgressCount(progress?.markedCount);

  if (detectedCount === null || filteredCount === null) {
    if (markedCount === null) {
      return message;
    }
    const markedText = `页面已标记 ${markedCount} 条`;
    return message ? `${message} · ${markedText}` : markedText;
  }

  const detailParts = [];
  if (minLikes !== null) {
    detailParts.push(`${sortLabel}≥${minLikes}`);
  }
  if (maxDetectedItems !== null) {
    detailParts.push(`探测上限 ${maxDetectedItems}`);
  }

  const statsText = `已探测 ${detectedCount} 条，已筛选 ${filteredCount} 条${
    markedCount !== null ? `，页面已标记 ${markedCount} 条` : ""
  }${detailParts.length > 0 ? `（${detailParts.join("，")}）` : ""}`;

  if (!message) {
    return statsText;
  }
  return `${message} · ${statsText}`;
}

function normalizeProgressCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.max(0, Math.floor(num));
}

async function syncCommentProgressToRecord(recordId, collectedCount) {
  if (isCommentCaptureTerminal(recordId)) {
    return;
  }

  const now = Date.now();
  if (now - lastProgressSyncAt < 800) {
    return;
  }
  lastProgressSyncAt = now;

  const {getRecord, updateRecord} = await import("../utils/storage.js");
  const record = await getRecord(recordId);
  if (!record || record.type !== "single_note") {
    return;
  }

  const payload = record.payload || {};
  const currentStatus = String(payload.commentsCaptureStatus || "");
  const currentCount = Number(payload.commentsTotalCaptured || 0);
  if (currentStatus !== "capturing" || collectedCount <= currentCount) {
    return;
  }
  if (isCommentCaptureTerminal(recordId)) {
    return;
  }

  // 避免并发覆盖终态：在落盘前再次读取最新记录，防止旧快照把 done/partial/failed 回写成 capturing
  const latestRecord = await getRecord(recordId);
  if (!latestRecord || latestRecord.type !== "single_note") {
    return;
  }
  const latestPayload = latestRecord.payload || {};
  const latestStatus = String(latestPayload.commentsCaptureStatus || "");
  const latestCount = Number(latestPayload.commentsTotalCaptured || 0);
  if (latestStatus !== "capturing" || collectedCount <= latestCount) {
    return;
  }
  if (isCommentCaptureTerminal(recordId)) {
    return;
  }

  await updateRecord(recordId, {
    payload: {
      ...latestPayload,
      commentsTotalCaptured: collectedCount,
    },
  });

  await refreshDataPoolThrottled();
}

function resolveCommentTerminalStatusFromPhase(phase) {
  const normalized = String(phase || "")
    .trim()
    .toLowerCase();
  return COMMENT_PHASE_TO_TERMINAL_STATUS[normalized] || "";
}

function markCommentCaptureTerminalStatus(recordId, status) {
  if (!recordId || !status) {
    return;
  }
  commentCaptureTerminalStatusByRecordId.set(recordId, status);
}

function clearCommentCaptureTerminalStatus(recordId) {
  if (!recordId) {
    return;
  }
  commentCaptureTerminalStatusByRecordId.delete(recordId);
}

function isCommentCaptureTerminal(recordId) {
  if (!recordId) {
    return false;
  }
  return commentCaptureTerminalStatusByRecordId.has(recordId);
}

async function reconcileCommentCaptureTerminalState(
  recordId,
  {status, collectedCount = null, errorMessage = ""} = {},
) {
  if (!recordId || !status) {
    return;
  }

  const normalizedStatus = String(status).trim().toLowerCase();
  if (!["done", "partial", "failed"].includes(normalizedStatus)) {
    return;
  }

  const normalizedCount = Number(collectedCount);
  const hasCount = Number.isFinite(normalizedCount);
  const nextCollectedCount = hasCount
    ? Math.max(0, Math.floor(normalizedCount))
    : 0;
  const nextError =
    normalizedStatus === "failed" ? String(errorMessage || "").trim() : "";

  const {getRecord, updateRecord} = await import("../utils/storage.js");
  const record = await getRecord(recordId);
  if (!record || record.type !== "single_note") {
    return;
  }

  const payload = record.payload || {};
  const currentStatus = String(payload.commentsCaptureStatus || "")
    .trim()
    .toLowerCase();
  const currentCount = Number(payload.commentsTotalCaptured || 0);
  const finalCount = hasCount
    ? Math.max(currentCount, nextCollectedCount)
    : currentCount;
  const currentError = String(payload.commentsCaptureError || "").trim();

  if (
    currentStatus === normalizedStatus &&
    currentCount === finalCount &&
    currentError === nextError
  ) {
    return;
  }

  await updateRecord(recordId, {
    payload: {
      ...payload,
      commentsCaptureStatus: normalizedStatus,
      commentsTotalCaptured: finalCount,
      commentsCaptureError: nextError,
    },
  });

  await refreshDataPoolThrottled();
}

async function refreshDataPoolThrottled() {
  const now = Date.now();
  if (now - lastPoolRefreshAt < 500) {
    return;
  }
  lastPoolRefreshAt = now;
  await refreshDataPool();
}

function isAuthVerified(auth) {
  return Boolean(auth?.status === AUTH_STATUS.VERIFIED || auth?.verified);
}

function isUnclaimedCredentialOwner(auth) {
  if (!isAuthVerified(auth)) {
    return false;
  }

  const ownerEmail = String(auth?.user?.email || "")
    .trim()
    .toLowerCase();
  const ownerName = String(auth?.user?.name || "")
    .trim()
    .toLowerCase();

  return (
    ownerEmail === UNCLAIMED_CREDENTIAL_OWNER_EMAIL.toLowerCase() ||
    ownerName === UNCLAIMED_CREDENTIAL_OWNER_NAME.toLowerCase()
  );
}

async function openCredentialClaimPage() {
  try {
    await chrome.tabs.create({url: CREDENTIAL_CLAIM_PAGE_URL});
    return true;
  } catch (error) {
    console.warn("[Sidebar] Open claim page in tab failed:", error);
  }

  try {
    window.open(CREDENTIAL_CLAIM_PAGE_URL, "_blank", "noopener,noreferrer");
    return true;
  } catch (error) {
    console.error("[Sidebar] Open claim page fallback failed:", error);
    return false;
  }
}

async function handleGoClaim() {
  const opened = await openCredentialClaimPage();
  if (!opened) {
    showMessage("打开绑定页失败，请稍后重试", "error");
    return;
  }

  showMessage("已打开绑定页，绑定完成后请回到插件重新验证。", "info");
}

function getAuthRequiredMessage() {
  return AUTH_REQUIRED_MESSAGE;
}

function formatCreditsLabel(credits) {
  return Number.isInteger(credits) && credits > 0 ? `${credits} 配额` : "配额";
}

function getKeywordOpportunityAuthRequiredMessage() {
  return `当前功能需要先验证激活码，判断赛道机会将消耗 ${formatCreditsLabel(
    KEYWORD_OPPORTUNITY_ANALYSIS_COST_CREDITS,
  )}。已有激活码请先在设置中完成验证；还没有请联系管理员获取。`;
}

function getBenchmarkDiscoveryAuthRequiredMessage() {
  return `当前功能需要先验证激活码，找对标账号将消耗 ${formatCreditsLabel(
    BENCHMARK_DISCOVERY_ANALYSIS_COST_CREDITS,
  )}。已有激活码请先在设置中完成验证；还没有请点击购买。`;
}

function getKeywordInsightAuthRequiredMessage() {
  return `当前功能需要先验证激活码。长尾扩词可先免费使用，继续生成分析长尾需求结果将消耗 ${formatCreditsLabel(
    KEYWORD_INSIGHT_ANALYSIS_COST_CREDITS,
  )}。已有激活码请先在设置中完成验证；还没有请联系管理员获取。`;
}

function formatKeywordStrategyAccessError(error, fallbackMessage) {
  const errorReason = String(
    error?.reason || error?.error?.reason || "",
  )
    .trim()
    .toLowerCase();
  const rawMessage = String(
    error?.message || error?.error?.message || "",
  ).trim();
  const normalizedMessage = rawMessage.toLowerCase();

  if (
    errorReason === ERROR_REASON.VERIFY_FAILED ||
    /no auth code found/i.test(rawMessage)
  ) {
    return {
      kind: "auth_required",
      message: fallbackMessage,
    };
  }

  if (errorReason === ERROR_REASON.EXPIRED) {
    return {
      kind: "auth_expired",
      message:
        "当前激活码已过期，请先续费或获取新激活码，并在设置中重新验证后再使用此功能。",
    };
  }

  if (errorReason === ERROR_REASON.FROZEN) {
    return {
      kind: "auth_frozen",
      message:
        "当前激活码已被冻结，请联系管理员处理。",
    };
  }

  if (errorReason === ERROR_REASON.BINDING_LIMIT_REACHED) {
    return {
      kind: "binding_limit",
      message:
        "当前激活码绑定环境已满，请先在设置中替换旧环境，或联系管理员获取新激活码。",
    };
  }

  if (
    normalizedMessage.includes("receiving end does not exist") ||
    normalizedMessage.includes("message port closed") ||
    normalizedMessage.includes("message channel closed before a response was received") ||
    normalizedMessage.includes("extension context invalidated") ||
    normalizedMessage.includes("frame with id 0 was removed")
  ) {
    return {
      kind: "page_connection_interrupted",
      message:
        "页面刚刚发生刷新或切换，导致分析连接中断。请留在当前搜索页后重试一次。",
    };
  }

  return {
    kind: "generic",
    message: rawMessage || fallbackMessage,
  };
}

function ensureAuthVerifiedOrWarn({message = AUTH_REQUIRED_MESSAGE} = {}) {
  const auth = getCurrentAuth() || {};
  if (isAuthVerified(auth)) {
    return true;
  }
  showMessage(message, "warning");
  return false;
}

function getCaptureCommentsChecked(settings) {
  const checkbox = document.getElementById("checkboxCaptureComments");
  if (!checkbox) {
    return settings?.includeCommentsOnNoteCapture || false;
  }
  return Boolean(checkbox.checked);
}

function getCommentLeadsFilterChecked(settings) {
  const checkbox = document.getElementById("checkboxEnableCommentLeadsFilter");
  if (!checkbox) {
    return Boolean(settings?.enableCommentLeadsFilter);
  }
  return Boolean(checkbox.checked);
}

function getSkipOfficialAccountsChecked(settings) {
  const checkbox = document.getElementById("checkboxSkipOfficialAccounts");
  if (!checkbox) {
    return settings?.skipOfficialAccounts !== false;
  }
  return Boolean(checkbox.checked);
}

function getCaptureBloggerMetricsChecked(settings) {
  const noteTabCheckbox = document.getElementById(
    "checkboxCaptureBloggerMetrics",
  );
  if (noteTabCheckbox) {
    return Boolean(noteTabCheckbox.checked);
  }
  return Boolean(settings?.includeBloggerMetricsOnNoteCapture);
}

async function resolveNoteBatchCaptureSettings() {
  const settings = await getCaptureSettings();
  const runtime = getCurrentRuntime();
  const platform = getViewPlatform(runtime);
  const capabilities = getPlatformCapabilities(platform);
  const hideBloggerMetricsToggle = shouldHideNoteBloggerMetricsToggle(platform);
  const includeComments = capabilities.captureComments
    ? getCaptureCommentsChecked(settings)
    : false;
  const includeBloggerMetrics =
    !hideBloggerMetricsToggle && capabilities.bloggerMetrics
      ? getCaptureBloggerMetricsChecked(settings)
      : false;

  let commentsMaxDetectedItems = settings.commentsMaxDetectedItems;
  if (includeComments) {
    commentsMaxDetectedItems = readRequiredCommentsMaxDetectedItemsFromInput();
    if (!commentsMaxDetectedItems) {
      throw new Error("开启评论采集时，请填写评论探测上限（正整数）");
    }
  }

  return {
    settings,
    includeComments,
    includeBloggerMetrics,
    commentsMaxDetectedItems,
    enableCommentLeadsFilter:
      includeComments && getCommentLeadsFilterChecked(settings),
  };
}

function collectBatchRecordIds(batchResult = {}) {
  if (!Array.isArray(batchResult?.results)) {
    return [];
  }

  return [
    ...new Set(
      batchResult.results
        .flatMap((entry) =>
          Array.isArray(entry?.recordIds) ? entry.recordIds : [],
        )
        .filter((recordId) => typeof recordId === "string" && recordId.trim()),
    ),
  ];
}

function shouldHideNoteBloggerMetricsToggle(platform) {
  return (
    String(platform || "")
      .trim()
      .toLowerCase() === "douyin"
  );
}

function syncBloggerMetricsCaptureControls({
  includeBloggerMetrics = false,
} = {}) {
  const noteTabCheckbox = document.getElementById(
    "checkboxCaptureBloggerMetrics",
  );
  if (noteTabCheckbox) {
    noteTabCheckbox.checked = Boolean(includeBloggerMetrics);
  }
}

/* first definition removed — consolidated into the panel-based version below */

function getActiveDetailCaptureInput(setting) {
  return document.querySelector(
    `#mainTabContent .tab-pane.is-active [data-detail-setting="${setting}"]`,
  );
}

function getActiveDetailCaptureCommentsMaxDetectedItemsInput() {
  return getActiveDetailCaptureInput("comments-max-detected-items");
}

function readPositiveIntegerFromRawValue(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readRequiredPositiveIntegerFromRawValue(rawValue) {
  const normalized = String(rawValue ?? "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function getAutoDetailCaptureChecked(settings) {
  const input = getActiveDetailCaptureInput("auto");
  if (!input) {
    return Boolean(settings?.autoDetailCaptureAfterListCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureAutoSyncChecked(settings) {
  const input = getActiveDetailCaptureInput("auto-sync");
  if (!input) {
    return Boolean(settings?.autoSyncAfterDetailCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureAiRelevancePrefilterChecked(settings) {
  const input = getActiveDetailCaptureInput("ai-relevance-prefilter");
  if (!input) {
    return Boolean(settings?.enableAiRelevancePrefilter);
  }
  return Boolean(input.checked);
}

function getDetailCaptureCommentsChecked(settings) {
  const input = getActiveDetailCaptureInput("comments");
  if (!input) {
    return Boolean(settings?.includeCommentsOnDetailCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureCommentsMaxDetectedItems(settings) {
  const defaultValue = Number(
    DEFAULT_CAPTURE_SETTINGS.detailCommentsMaxDetectedItems ||
      DEFAULT_CAPTURE_SETTINGS.commentsMaxDetectedItems ||
      100,
  );
  const fallback = readPositiveIntegerFromRawValue(
    settings?.detailCommentsMaxDetectedItems ??
      settings?.commentsMaxDetectedItems,
    defaultValue,
  );
  const input = getActiveDetailCaptureCommentsMaxDetectedItemsInput();
  if (!input) {
    return fallback;
  }
  return readPositiveIntegerFromRawValue(input.value?.trim(), fallback);
}

function readRequiredDetailCaptureCommentsMaxDetectedItemsFromInput() {
  const input = getActiveDetailCaptureCommentsMaxDetectedItemsInput();
  if (!input) {
    return null;
  }
  return readRequiredPositiveIntegerFromRawValue(input.value?.trim());
}

function getDetailCaptureCommentLeadsFilterChecked(settings) {
  const input = getActiveDetailCaptureInput("comment-leads");
  if (!input) {
    return Boolean(settings?.enableCommentLeadsFilterOnDetailCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureBloggerMetricsChecked(settings) {
  const input = getActiveDetailCaptureInput("metrics");
  if (!input) {
    return Boolean(settings?.includeBloggerMetricsOnDetailCapture);
  }
  return Boolean(input.checked);
}

// 增量采集(跳过已采过的)。无勾选输入时回落 settings,默认 true。
function getDetailCaptureSkipCapturedChecked(settings) {
  const input = getActiveDetailCaptureInput("skip-captured");
  if (!input) {
    return settings?.skipAlreadyCapturedOnDetailCapture !== false;
  }
  return Boolean(input.checked);
}

function getDetailCaptureLowFollowerHitFilterChecked(settings) {
  const input = getActiveDetailCaptureInput("low-follower-hit");
  if (!input) {
    return Boolean(settings?.enableLowFollowerHitFilterOnDetailCapture);
  }
  return Boolean(input.checked);
}

function getDetailCaptureLowFollowerHitThreshold(settings) {
  const defaultValue = Number(
    DEFAULT_CAPTURE_SETTINGS.lowFollowerHitThreshold || 10000,
  );
  const fallback = readNonNegativeIntegerFromRawValue(
    settings?.lowFollowerHitThresholdOnDetailCapture ??
      settings?.lowFollowerHitThreshold,
    defaultValue,
  );
  const input = getActiveDetailCaptureInput("low-follower-hit-threshold");
  if (!input) {
    return fallback;
  }
  return readNonNegativeIntegerFromRawValue(input.value?.trim(), fallback);
}

function readNonNegativeIntegerFromRawValue(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function syncAutoDetailCaptureControls({
  autoDetailCapture = null,
  enableAiRelevancePrefilter = null,
  autoSync = null,
  includeComments = null,
  commentsMaxDetectedItems = null,
  enableCommentLeadsFilter = null,
  includeBloggerMetrics = null,
  skipAlreadyCaptured = null,
  enableLowFollowerHitFilter = null,
  lowFollowerHitThreshold = null,
  forceDisabled = false,
  platform = "",
} = {}) {
  const runtime = getCurrentRuntime();
  const resolvedPlatform = platform || getViewPlatform(runtime);
  const capabilities = getPlatformCapabilities(resolvedPlatform);
  const detailCaptureSupported = Boolean(capabilities.batchDetailCapture);

  document.querySelectorAll("[data-auto-detail-panel]").forEach((panel) => {
    panel.hidden = !detailCaptureSupported;

    const autoInput = panel.querySelector('[data-detail-setting="auto"]');
    const autoSyncInput = panel.querySelector(
      '[data-detail-setting="auto-sync"]',
    );
    const aiRelevancePrefilterInput = panel.querySelector(
      '[data-detail-setting="ai-relevance-prefilter"]',
    );
    const commentsInput = panel.querySelector(
      '[data-detail-setting="comments"]',
    );
    const commentsMaxInput = panel.querySelector(
      '[data-detail-setting="comments-max-detected-items"]',
    );
    const commentLeadsInput = panel.querySelector(
      '[data-detail-setting="comment-leads"]',
    );
    const metricsInput = panel.querySelector('[data-detail-setting="metrics"]');
    const skipCapturedInput = panel.querySelector(
      '[data-detail-setting="skip-captured"]',
    );
    const lowFollowerHitInput = panel.querySelector(
      '[data-detail-setting="low-follower-hit"]',
    );
    const lowFollowerHitThresholdInput = panel.querySelector(
      '[data-detail-setting="low-follower-hit-threshold"]',
    );
    const options = panel.querySelector(
      '[data-detail-setting-group="options"]',
    );
    const commentSettings = panel.querySelector(
      '[data-detail-setting-group="comments-options"]',
    );
    const metricsOptions = panel.querySelector(
      '[data-detail-setting-group="metrics-options"]',
    );
    const lowFollowerHitThresholdGroup = panel.querySelector(
      '[data-detail-setting-group="low-follower-hit-threshold-group"]',
    );

    if (!detailCaptureSupported) {
      if (options) options.hidden = true;
      if (commentSettings) commentSettings.hidden = true;
      if (metricsOptions) metricsOptions.hidden = true;
      if (lowFollowerHitThresholdGroup) {
        lowFollowerHitThresholdGroup.hidden = true;
      }
      return;
    }

    if (autoInput && autoDetailCapture !== null) {
      autoInput.checked = Boolean(autoDetailCapture);
    }
    if (autoSyncInput && autoSync !== null) {
      autoSyncInput.checked = Boolean(autoSync);
    }
    if (
      aiRelevancePrefilterInput &&
      enableAiRelevancePrefilter !== null
    ) {
      aiRelevancePrefilterInput.checked = Boolean(
        enableAiRelevancePrefilter,
      );
    }
    if (commentsInput && includeComments !== null) {
      commentsInput.checked = Boolean(includeComments);
    }
    if (commentsMaxInput && commentsMaxDetectedItems !== null) {
      commentsMaxInput.value = String(commentsMaxDetectedItems);
    }
    if (commentLeadsInput && enableCommentLeadsFilter !== null) {
      commentLeadsInput.checked = Boolean(enableCommentLeadsFilter);
    }
    if (metricsInput && includeBloggerMetrics !== null) {
      metricsInput.checked = Boolean(includeBloggerMetrics);
    }
    if (skipCapturedInput && skipAlreadyCaptured !== null) {
      skipCapturedInput.checked = Boolean(skipAlreadyCaptured);
    }
    if (lowFollowerHitInput && enableLowFollowerHitFilter !== null) {
      lowFollowerHitInput.checked = Boolean(enableLowFollowerHitFilter);
    }
    if (lowFollowerHitThresholdInput && lowFollowerHitThreshold !== null) {
      lowFollowerHitThresholdInput.value = String(lowFollowerHitThreshold);
    }
    if (lowFollowerHitThresholdGroup) {
      lowFollowerHitThresholdGroup.hidden = !Boolean(
        lowFollowerHitInput?.checked,
      );
    }

    const autoChecked = Boolean(autoInput?.checked);
    const commentsChecked = Boolean(commentsInput?.checked);
    const metricsChecked = Boolean(metricsInput?.checked);
    const commentsSupported =
      capabilities.batchDetailCapture && capabilities.captureComments;
    const metricsSupported =
      capabilities.batchDetailCapture && capabilities.bloggerMetrics;

    if (options) {
      options.hidden = !autoChecked;
    }
    if (commentSettings) {
      commentSettings.hidden =
        !autoChecked || !commentsChecked || !commentsSupported;
    }
    if (metricsOptions) {
      metricsOptions.hidden =
        !autoChecked || !metricsChecked || !metricsSupported;
    }

    if (autoInput) {
      autoInput.disabled = forceDisabled || !capabilities.batchDetailCapture;
    }
    if (autoSyncInput) {
      autoSyncInput.disabled =
        forceDisabled || !autoChecked || !capabilities.batchDetailCapture;
    }
    if (aiRelevancePrefilterInput) {
      aiRelevancePrefilterInput.disabled =
        forceDisabled || !autoChecked || !capabilities.batchDetailCapture;
    }
    const commentsControlDisabled =
      forceDisabled ||
      !autoChecked ||
      !capabilities.batchDetailCapture ||
      !capabilities.captureComments;
    if (commentsInput) {
      commentsInput.disabled = commentsControlDisabled;
    }
    const commentSettingsDisabled = commentsControlDisabled || !commentsChecked;
    if (commentsMaxInput) {
      commentsMaxInput.disabled = commentSettingsDisabled;
    }
    if (commentLeadsInput) {
      commentLeadsInput.disabled = commentSettingsDisabled;
    }
    if (commentSettings) {
      commentSettings.classList.toggle("is-disabled", commentSettingsDisabled);
    }
    if (metricsInput) {
      metricsInput.disabled =
        forceDisabled ||
        !autoChecked ||
        !capabilities.batchDetailCapture ||
        !capabilities.bloggerMetrics;
    }
  });

  document
    .querySelectorAll('[data-detail-setting="skip-captured"]')
    .forEach((input) => {
      if (skipAlreadyCaptured !== null) {
        input.checked = Boolean(skipAlreadyCaptured);
      }
      input.disabled = forceDisabled || !detailCaptureSupported;
    });

}

function syncDetailCaptureControlsFromStoredSettings(settings = {}, {platform = ""} = {}) {
  const autoDetailCapture = Boolean(settings?.autoDetailCaptureAfterListCapture);
  const defaultCommentsMaxDetectedItems = Number(
    DEFAULT_CAPTURE_SETTINGS.detailCommentsMaxDetectedItems ||
      DEFAULT_CAPTURE_SETTINGS.commentsMaxDetectedItems ||
      100,
  );
  const defaultLowFollowerHitThreshold = Number(
    DEFAULT_CAPTURE_SETTINGS.lowFollowerHitThreshold || 10000,
  );

  syncAutoDetailCaptureControls({
    autoDetailCapture,
    enableAiRelevancePrefilter: Boolean(
      settings?.enableAiRelevancePrefilter,
    ),
    autoSync:
      autoDetailCapture && Boolean(settings?.autoSyncAfterDetailCapture),
    includeComments: Boolean(settings?.includeCommentsOnDetailCapture),
    commentsMaxDetectedItems: readPositiveIntegerFromRawValue(
      settings?.detailCommentsMaxDetectedItems ??
        settings?.commentsMaxDetectedItems,
      defaultCommentsMaxDetectedItems,
    ),
    enableCommentLeadsFilter: Boolean(
      settings?.enableCommentLeadsFilterOnDetailCapture,
    ),
    includeBloggerMetrics: Boolean(
      settings?.includeBloggerMetricsOnDetailCapture,
    ),
    skipAlreadyCaptured: settings?.skipAlreadyCapturedOnDetailCapture !== false,
    enableLowFollowerHitFilter: Boolean(
      settings?.enableLowFollowerHitFilterOnDetailCapture,
    ),
    lowFollowerHitThreshold: readNonNegativeIntegerFromRawValue(
      settings?.lowFollowerHitThresholdOnDetailCapture ??
        settings?.lowFollowerHitThreshold,
      defaultLowFollowerHitThreshold,
    ),
    platform,
  });
}

async function persistDetailCaptureSettingsFromInputs() {
  const current = await getCaptureSettings();
  const autoDetailCaptureAfterListCapture =
    getAutoDetailCaptureChecked(current);
  const enableAiRelevancePrefilter =
    getDetailCaptureAiRelevancePrefilterChecked(current);
  const autoSyncAfterDetailCapture =
    autoDetailCaptureAfterListCapture &&
    getDetailCaptureAutoSyncChecked(current);
  const includeCommentsOnDetailCapture =
    getDetailCaptureCommentsChecked(current);
  const detailCommentsMaxDetectedItems =
    getDetailCaptureCommentsMaxDetectedItems(current);
  const enableCommentLeadsFilterOnDetailCapture =
    getDetailCaptureCommentLeadsFilterChecked(current);
  const normalizedEnableCommentLeadsFilterOnDetailCapture =
    includeCommentsOnDetailCapture && enableCommentLeadsFilterOnDetailCapture;
  const includeBloggerMetricsOnDetailCapture =
    getDetailCaptureBloggerMetricsChecked(current);
  const skipAlreadyCapturedOnDetailCapture =
    getDetailCaptureSkipCapturedChecked(current);
  const enableLowFollowerHitFilterOnDetailCapture =
    getDetailCaptureLowFollowerHitFilterChecked(current);
  const lowFollowerHitThresholdOnDetailCapture =
    getDetailCaptureLowFollowerHitThreshold(current);

  syncAutoDetailCaptureControls({
    autoDetailCapture: autoDetailCaptureAfterListCapture,
    enableAiRelevancePrefilter,
    autoSync: autoSyncAfterDetailCapture,
    includeComments: includeCommentsOnDetailCapture,
    commentsMaxDetectedItems: detailCommentsMaxDetectedItems,
    enableCommentLeadsFilter: normalizedEnableCommentLeadsFilterOnDetailCapture,
    includeBloggerMetrics: includeBloggerMetricsOnDetailCapture,
    skipAlreadyCaptured: skipAlreadyCapturedOnDetailCapture,
    enableLowFollowerHitFilter: enableLowFollowerHitFilterOnDetailCapture,
    lowFollowerHitThreshold: lowFollowerHitThresholdOnDetailCapture,
  });

  await saveCaptureSettings({
    autoDetailCaptureAfterListCapture,
    enableAiRelevancePrefilter,
    autoSyncAfterDetailCapture,
    includeCommentsOnDetailCapture,
    detailCommentsMaxDetectedItems,
    enableCommentLeadsFilterOnDetailCapture:
      normalizedEnableCommentLeadsFilterOnDetailCapture,
    includeBloggerMetricsOnDetailCapture,
    skipAlreadyCapturedOnDetailCapture,
    enableLowFollowerHitFilterOnDetailCapture,
    lowFollowerHitThresholdOnDetailCapture,
  });
}

function resolveTaskCaptureSettingsOverrides(baseSettings = {}, input = {}) {
  const base =
    baseSettings && typeof baseSettings === "object" ? baseSettings : {};
  const source = input && typeof input === "object" ? input : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(source, key);
  const booleanValue = (key, fallback = false) => {
    if (!has(key)) return Boolean(fallback);
    if (source[key] === true || source[key] === "true") return true;
    if (source[key] === false || source[key] === "false") return false;
    return Boolean(fallback);
  };
  const boundedIntegerValue = (key, fallback, minimum, maximum) => {
    const parsed = Math.floor(Number(has(key) ? source[key] : fallback));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
  };
  const enhancementEnabled = booleanValue(
    "autoDetailCaptureAfterListCapture",
    base.autoDetailCaptureAfterListCapture,
  );
  const includeComments =
    enhancementEnabled &&
    booleanValue(
      "includeCommentsOnDetailCapture",
      base.includeCommentsOnDetailCapture,
    );
  const includeBloggerMetrics =
    enhancementEnabled &&
    booleanValue(
      "includeBloggerMetricsOnDetailCapture",
      base.includeBloggerMetricsOnDetailCapture,
    );
  return {
    ...base,
    autoDetailCaptureAfterListCapture: enhancementEnabled,
    autoSyncAfterDetailCapture:
      enhancementEnabled &&
      booleanValue(
        "autoSyncAfterDetailCapture",
        base.autoSyncAfterDetailCapture,
      ),
    enableAiRelevancePrefilter:
      enhancementEnabled &&
      booleanValue(
        "enableAiRelevancePrefilter",
        base.enableAiRelevancePrefilter,
      ),
    includeBloggerMetricsOnDetailCapture: includeBloggerMetrics,
    enableLowFollowerHitFilterOnDetailCapture:
      includeBloggerMetrics &&
      booleanValue(
        "enableLowFollowerHitFilterOnDetailCapture",
        base.enableLowFollowerHitFilterOnDetailCapture,
      ),
    lowFollowerHitThresholdOnDetailCapture: boundedIntegerValue(
      "lowFollowerHitThresholdOnDetailCapture",
      Number(base.lowFollowerHitThresholdOnDetailCapture) || 10000,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    includeCommentsOnDetailCapture: includeComments,
    detailCommentsMaxDetectedItems: boundedIntegerValue(
      "detailCommentsMaxDetectedItems",
      Number(base.detailCommentsMaxDetectedItems) || 50,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    enableCommentLeadsFilterOnDetailCapture:
      includeComments &&
      booleanValue(
        "enableCommentLeadsFilterOnDetailCapture",
        base.enableCommentLeadsFilterOnDetailCapture,
      ),
    skipAlreadyCapturedOnDetailCapture:
      enhancementEnabled &&
      booleanValue(
        "skipAlreadyCapturedOnDetailCapture",
        base.skipAlreadyCapturedOnDetailCapture !== false,
      ),
  };
}

function resolveTaskKeywordMaxDetectedItems(
  localValue = DEFAULT_CAPTURE_SETTINGS.keywordMaxDetectedItems,
  taskValue = null,
) {
  const localParsed = Math.floor(Number(localValue));
  const fallback =
    Number.isSafeInteger(localParsed) && localParsed > 0
      ? localParsed
      : DEFAULT_CAPTURE_SETTINGS.keywordMaxDetectedItems;
  if (taskValue === null || taskValue === undefined || taskValue === "") {
    return fallback;
  }
  const taskParsed = Number(taskValue);
  return Number.isSafeInteger(taskParsed) && taskParsed > 0
    ? taskParsed
    : fallback;
}

function resolveCurrentDetailCaptureSettings(settings = {}) {
  const autoDetailCaptureAfterListCapture =
    getAutoDetailCaptureChecked(settings);
  const aiRelevancePrefilterInput = getActiveDetailCaptureInput(
    "ai-relevance-prefilter",
  );
  const relevancePrefilterSupported =
    getCurrentRuntime()?.pageType === PAGE_TYPE.SEARCH_RESULTS;
  return {
    ...settings,
    autoDetailCaptureAfterListCapture,
    // 该能力只属于搜索页采集增强。博主页没有这个控件，即使保留了
    // 搜索页偏好，也不能把 AI 预筛带入博主笔记增强流程。
    enableAiRelevancePrefilter:
      autoDetailCaptureAfterListCapture &&
      relevancePrefilterSupported &&
      Boolean(
        aiRelevancePrefilterInput
          ? aiRelevancePrefilterInput.checked
          : settings?.enableAiRelevancePrefilter,
      ),
    autoSyncAfterDetailCapture:
      autoDetailCaptureAfterListCapture &&
      getDetailCaptureAutoSyncChecked(settings),
    includeCommentsOnDetailCapture: getDetailCaptureCommentsChecked(settings),
    detailCommentsMaxDetectedItems:
      getDetailCaptureCommentsMaxDetectedItems(settings),
    enableCommentLeadsFilterOnDetailCapture:
      getDetailCaptureCommentLeadsFilterChecked(settings),
    includeBloggerMetricsOnDetailCapture:
      getDetailCaptureBloggerMetricsChecked(settings),
    skipAlreadyCapturedOnDetailCapture:
      getDetailCaptureSkipCapturedChecked(settings),
    enableLowFollowerHitFilterOnDetailCapture:
      getDetailCaptureLowFollowerHitFilterChecked(settings),
    lowFollowerHitThresholdOnDetailCapture:
      getDetailCaptureLowFollowerHitThreshold(settings),
  };
}

function readSyncScopeFromInput(fallback = DEFAULT_CAPTURE_SETTINGS.syncScope) {
  const input = document.getElementById("inputSyncScope");
  const rawValue = String(input?.value || fallback || "")
    .trim()
    .toLowerCase();
  if (rawValue === SYNC_SCOPE_ALL || rawValue === SYNC_SCOPE_PENDING) {
    return rawValue;
  }
  return SYNC_SCOPE_PENDING;
}

function readDetailCaptureScopeFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.detailCaptureScope,
) {
  const input = document.getElementById("inputDetailCaptureScope");
  const rawValue = String(input?.value || fallback || "")
    .trim()
    .toLowerCase();
  if (
    rawValue === DETAIL_CAPTURE_SCOPE_ALL ||
    rawValue === DETAIL_CAPTURE_SCOPE_PENDING
  ) {
    return rawValue;
  }
  return DETAIL_CAPTURE_SCOPE_PENDING;
}

function readCommentsMaxDetectedItemsFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.commentsMaxDetectedItems,
) {
  const input = document.getElementById("inputCommentsMaxDetectedItems");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readRequiredCommentsMaxDetectedItemsFromInput() {
  const input = document.getElementById("inputCommentsMaxDetectedItems");
  const rawValue = input?.value?.trim();
  if (!rawValue) {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizeCommaSeparatedRules(value, fallback = "") {
  const source = String(value ?? fallback ?? "");
  const normalized = source
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).join(",");
}

function readCommaSeparatedRulesFromInput(inputId, fallback = "") {
  const input = document.getElementById(inputId);
  const normalized = normalizeCommaSeparatedRules(input?.value, fallback);
  if (input) {
    input.value = normalized;
  }
  return normalized;
}

function syncCommentsCaptureControls({
  includeComments = null,
  forceDisabled = false,
} = {}) {
  const checkbox = document.getElementById("checkboxCaptureComments");
  const leadsCheckbox = document.getElementById(
    "checkboxEnableCommentLeadsFilter",
  );
  const input = document.getElementById("inputCommentsMaxDetectedItems");
  const group = document.getElementById("commentsMaxDetectedItemsGroup");
  const leadsGroup = document.getElementById("commentLeadsFilterGroup");
  const checked =
    includeComments === null
      ? Boolean(checkbox?.checked)
      : Boolean(includeComments);

  if (checkbox && includeComments !== null) {
    checkbox.checked = checked;
  }

  const shouldDisableLeads = forceDisabled || !checked;
  if (leadsCheckbox) {
    leadsCheckbox.disabled = shouldDisableLeads;
    if (!checked) {
      leadsCheckbox.checked = false;
    }
  }
  if (leadsGroup) {
    leadsGroup.hidden = !checked;
    leadsGroup.classList.toggle("is-disabled", shouldDisableLeads);
  }

  const shouldDisableInput = forceDisabled || !checked;
  if (input) {
    input.disabled = shouldDisableInput;
  }
  if (group) {
    group.hidden = !checked;
    group.classList.toggle("is-disabled", shouldDisableInput);
  }
}

function readSecondsInput(inputId, fallbackSeconds) {
  const input = document.getElementById(inputId);
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Math.floor(Number(fallbackSeconds) || 1));
  }
  return Math.max(1, Math.floor(parsed));
}

function readSecondsAsMillisecondsInput(inputId, fallbackMs, minSeconds = 0.1) {
  const input = document.getElementById(inputId);
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  const normalizedMinSeconds = Math.max(0.1, Number(minSeconds) || 0.1);
  const normalizedMinMs = Math.max(
    100,
    Math.round(normalizedMinSeconds * 1000),
  );
  if (!Number.isFinite(parsed) || parsed < normalizedMinSeconds) {
    const fallback = Math.round(Number(fallbackMs) || normalizedMinMs);
    return Math.max(normalizedMinMs, fallback);
  }
  return Math.max(normalizedMinMs, Math.round(parsed * 1000));
}

function formatMillisecondsAsSeconds(milliseconds) {
  const parsed = Number(milliseconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "1";
  }

  const seconds = parsed / 1000;
  if (Number.isInteger(seconds)) {
    return String(seconds);
  }

  return String(Number(seconds.toFixed(2)));
}

function readBloggerMinLikesFromInput(fallback = 0) {
  const input = document.getElementById("inputBloggerMinLikes");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.floor(parsed);
}

function readBloggerMaxDetectedItemsFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.bloggerMaxDetectedItems,
) {
  const input = document.getElementById("inputBloggerMaxDetectedItems");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function readBloggerKeywordFilterFromInput() {
  const input = document.getElementById("inputBloggerKeywordFilter");
  return (input?.value || "").trim();
}

function updateBloggerKeywordFilterHint() {
  const hintEl = document.getElementById("bloggerKeywordFilterHint");
  if (!hintEl) return;
  const bloggerPanel = document.getElementById("bloggerTab");
  const autoToggle = bloggerPanel?.querySelector(
    '[data-detail-setting="auto"]',
  );
  const isEnhanceOn = autoToggle?.checked ?? false;
  hintEl.textContent = isEnhanceOn
    ? "将匹配标题、正文和标签，留空不过滤"
    : "仅匹配标题，留空不过滤。开启采集增强可同时匹配正文和标签";
}

function readKeywordMinLikesFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.keywordMinLikes,
) {
  const input = document.getElementById("inputKeywordMinLikes");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.floor(parsed);
}

function readKeywordMaxDetectedItemsFromInput(
  fallback = DEFAULT_CAPTURE_SETTINGS.keywordMaxDetectedItems,
) {
  const input = document.getElementById("inputKeywordMaxDetectedItems");
  const rawValue = input?.value?.trim();
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeKeywordSortDimension(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === KEYWORD_SORT_DIMENSION.COLLECTS) {
    return KEYWORD_SORT_DIMENSION.COLLECTS;
  }
  if (normalized === KEYWORD_SORT_DIMENSION.COMMENTS) {
    return KEYWORD_SORT_DIMENSION.COMMENTS;
  }
  return KEYWORD_SORT_DIMENSION.LIKES;
}

function getKeywordSortDimensionLabel(dimension) {
  const normalized = normalizeKeywordSortDimension(dimension);
  return KEYWORD_SORT_DIMENSION_LABEL[normalized] || "点赞";
}

function applyKeywordSortDimensionToUI(dimension) {
  const normalized = normalizeKeywordSortDimension(dimension);
  const label = getKeywordSortDimensionLabel(normalized);
  const labelNode = document.getElementById("labelKeywordMinThreshold");
  if (labelNode) {
    labelNode.textContent = `达到以下${label}数才会被采集`;
  }

  const inputNode = document.getElementById("inputKeywordMinLikes");
  if (inputNode && !String(inputNode.placeholder || "").trim()) {
    inputNode.placeholder = "例如 0";
  }
}

async function syncKeywordSortDimensionByRuntime(runtime = null) {
  const pageType = runtime?.pageType || getCurrentRuntime()?.pageType;
  const pageUrl =
    runtime?.lastPageUrl || getCurrentRuntime()?.lastPageUrl || "";
  const pagePlatform = detectPlatformFromUrl(pageUrl);
  if (
    pageType !== PAGE_TYPE.SEARCH_RESULTS ||
    !getPlatformCapabilities(pagePlatform).captureSearch
  ) {
    keywordSortDimension = KEYWORD_SORT_DIMENSION.LIKES;
    applyKeywordSortDimensionToUI(keywordSortDimension);
    stopKeywordSortSyncTimer();
    return {
      dimension: keywordSortDimension,
      source: "default",
    };
  }

  startKeywordSortSyncTimer();
  return await syncKeywordSortDimensionFromPage({
    fallbackDimension: keywordSortDimension,
  });
}

function startKeywordSortSyncTimer() {
  if (keywordSortSyncTimer) {
    return;
  }

  keywordSortSyncTimer = setInterval(() => {
    const runtime = getCurrentRuntime();
    const pagePlatform = detectPlatformFromUrl(runtime?.lastPageUrl || "");
    if (
      runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS ||
      !getPlatformCapabilities(pagePlatform).captureSearch
    ) {
      stopKeywordSortSyncTimer();
      return;
    }

    syncKeywordSortDimensionFromPage({
      fallbackDimension: keywordSortDimension,
    }).catch((error) => {
      console.warn("[Sidebar] Keyword sort sync tick failed:", error);
    });
  }, KEYWORD_SORT_SYNC_INTERVAL_MS);
}

function stopKeywordSortSyncTimer() {
  if (!keywordSortSyncTimer) {
    return;
  }
  clearInterval(keywordSortSyncTimer);
  keywordSortSyncTimer = null;
}

async function syncKeywordSortDimensionFromPage({
  force = false,
  fallbackDimension = KEYWORD_SORT_DIMENSION.LIKES,
} = {}) {
  const runtime = getCurrentRuntime();
  const pagePlatform = detectPlatformFromUrl(runtime?.lastPageUrl || "");
  if (
    runtime?.pageType !== PAGE_TYPE.SEARCH_RESULTS ||
    !getPlatformCapabilities(pagePlatform).captureSearch
  ) {
    const fallback = normalizeKeywordSortDimension(fallbackDimension);
    keywordSortDimension = fallback;
    applyKeywordSortDimensionToUI(fallback);
    return {
      dimension: fallback,
      source: "default",
    };
  }

  try {
    const detected = await detectKeywordSortDimensionFromActiveTab();
    const normalized = normalizeKeywordSortDimension(
      detected?.dimension || fallbackDimension,
    );
    if (force || normalized !== keywordSortDimension) {
      keywordSortDimension = normalized;
      applyKeywordSortDimensionToUI(normalized);
    }
    return {
      dimension: normalized,
      source: detected?.source || "default",
    };
  } catch (error) {
    console.warn("[Sidebar] Detect keyword sort dimension failed:", error);
    const fallback = normalizeKeywordSortDimension(fallbackDimension);
    if (force) {
      keywordSortDimension = fallback;
      applyKeywordSortDimensionToUI(fallback);
    }
    return {
      dimension: fallback,
      source: "fallback",
    };
  }
}

async function detectKeywordSortDimensionFromActiveTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id) {
    return {
      dimension: KEYWORD_SORT_DIMENSION.LIKES,
      source: "default",
    };
  }

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.RELAY_TO_CONTENT,
    tabId: tab.id,
    payload: {
      action: "detectSearchSortDimension",
    },
  });

  if (!response?.ok || !response?.data?.ok) {
    return {
      dimension: KEYWORD_SORT_DIMENSION.LIKES,
      source: "default",
    };
  }

  return (
    response.data.data || {
      dimension: KEYWORD_SORT_DIMENSION.LIKES,
      source: "default",
    }
  );
}

function extractKeywordFromUrl(url) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return "";

  try {
    const parsed = new URL(normalizedUrl);
    const keyword = extractKeywordFromSearchParams(parsed.searchParams);
    if (keyword) return keyword;

    const pathname = decodeURIComponentSafe(parsed.pathname || "");
    const douyinPathMatch = pathname.match(
      /\/(?:jingxuan\/search|search)\/([^/?#]+)/i,
    );
    if (douyinPathMatch?.[1]) {
      return decodeURIComponentSafe(douyinPathMatch[1]).trim();
    }

    const hashMatch = String(parsed.hash || "").match(
      /(?:^#|#\/).*search_result\?[^#]*\bkeyword=([^&]+)/i,
    );
    if (hashMatch) {
      return decodeURIComponentSafe(hashMatch[1]).trim();
    }
  } catch {
    // ignore
  }

  const exactMatch = normalizedUrl.match(
    /[?&](?:keyword|search_keyword|searchkey|search_word)=([^&]+)/i,
  );
  if (exactMatch) {
    return decodeURIComponentSafe(exactMatch[1]).trim();
  }

  const qMatch = normalizedUrl.match(/[?&](?:query|q)=([^&]+)/i);
  if (qMatch) {
    return decodeURIComponentSafe(qMatch[1]).trim();
  }

  const douyinFallbackMatch = normalizedUrl.match(
    /\/(?:jingxuan\/search|search)\/([^/?#]+)/i,
  );
  if (douyinFallbackMatch?.[1]) {
    return decodeURIComponentSafe(douyinFallbackMatch[1]).trim();
  }

  return "";
}

function extractKeywordFromSearchParams(searchParams) {
  if (!searchParams || typeof searchParams.entries !== "function") {
    return "";
  }

  const priorityKeys = ["keyword", "search_keyword", "searchkey", "search_word", "query", "q"];
  for (const key of priorityKeys) {
    const value = searchParams.get(key);
    if (value) {
      const decoded = decodeURIComponentSafe(value).trim();
      if (decoded) {
        return decoded;
      }
    }
  }

  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase();
    if (!SEARCH_KEYWORD_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }

    const decoded = decodeURIComponentSafe(value).trim();
    if (decoded) {
      return decoded;
    }
  }

  return "";
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
  } catch {
    return String(value || "");
  }
}

function buildMediaDownloadTasks(records) {
  const tasks = [];
  const seenUrls = new Set();

  records.forEach((record) => {
    const payload = record?.payload || {};
    const prefix = sanitizeFilename(record.title || "record");
    const primaryVideoOnly = shouldDownloadPrimaryVideoOnly(record, payload);

    if (record.type === "single_note") {
      appendTask(
        tasks,
        seenUrls,
        payload.coverImageUrl,
        `${prefix}_cover.jpg`,
        "image",
      );
      if (!primaryVideoOnly) {
        (payload.imageUrls || []).forEach((url, index) => {
          appendTask(
            tasks,
            seenUrls,
            url,
            `${prefix}_image_${index + 1}${getUrlExtension(url, ".jpg")}`,
            "image",
          );
        });
      }
      collectDownloadVideoUrls(record, payload).forEach((url, index) => {
        const suffix = index === 0 ? "" : `_${index + 1}`;
        appendTask(
          tasks,
          seenUrls,
          url,
          `${prefix}_video${suffix}${getUrlExtension(url, ".mp4")}`,
          "video",
        );
      });
      collectDownloadAudioUrls(record, payload).forEach((url, index) => {
        const suffix = index === 0 ? "" : `_${index + 1}`;
        appendTask(
          tasks,
          seenUrls,
          url,
          `${prefix}_audio${suffix}${getUrlExtension(url, ".m4a")}`,
          "audio",
        );
      });
      return;
    }

    if (record.type === "blogger_notes" || record.type === "keyword_notes") {
      const detailPayload = getHydratedDetailPayload(record);
      if (detailPayload) {
        const detailPrimaryVideoOnly = shouldDownloadPrimaryVideoOnly(
          record,
          detailPayload,
        );
        appendTask(
          tasks,
          seenUrls,
          detailPayload.coverImageUrl,
          `${prefix}_cover${getUrlExtension(detailPayload.coverImageUrl, ".jpg")}`,
          "image",
        );
        if (!detailPrimaryVideoOnly) {
          (detailPayload.imageUrls || []).forEach((url, index) => {
            appendTask(
              tasks,
              seenUrls,
              url,
              `${prefix}_image_${index + 1}${getUrlExtension(url, ".jpg")}`,
              "image",
            );
          });
        }
        collectDownloadVideoUrls(record, detailPayload).forEach(
          (url, index) => {
            const suffix = index === 0 ? "" : `_${index + 1}`;
            appendTask(
              tasks,
              seenUrls,
              url,
              `${prefix}_video${suffix}${getUrlExtension(url, ".mp4")}`,
              "video",
            );
          },
        );
        collectDownloadAudioUrls(record, detailPayload).forEach(
          (url, index) => {
            const suffix = index === 0 ? "" : `_${index + 1}`;
            appendTask(
              tasks,
              seenUrls,
              url,
              `${prefix}_audio${suffix}${getUrlExtension(url, ".m4a")}`,
              "audio",
            );
          },
        );
        return;
      }

      (payload.items || []).forEach((item, index) => {
        appendTask(
          tasks,
          seenUrls,
          item.coverImageUrl,
          `${prefix}_note_${index + 1}${getUrlExtension(item.coverImageUrl, ".jpg")}`,
          "image",
        );
      });
      return;
    }

    if (record.type === "blogger_profile") {
      appendTask(
        tasks,
        seenUrls,
        payload.avatarUrl,
        `${prefix}_avatar${getUrlExtension(payload.avatarUrl, ".jpg")}`,
        "image",
      );
    }
  });

  return tasks;
}

function getHydratedDetailPayload(record) {
  if (
    !record ||
    (record.type !== "blogger_notes" && record.type !== "keyword_notes")
  ) {
    return null;
  }
  const payload = record.payload || {};
  const detailStatus = String(payload.detailCaptureStatus || "")
    .trim()
    .toLowerCase();
  if (detailStatus !== "done") return null;
  if (!payload.detailPayload || typeof payload.detailPayload !== "object") {
    return null;
  }
  return payload.detailPayload;
}

function appendTask(tasks, seenUrls, url, filename, kind = "media") {
  const normalizedUrl = normalizeDownloadUrl(url);
  if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
    return;
  }
  seenUrls.add(normalizedUrl);
  tasks.push({url: normalizedUrl, filename, kind});
}

function normalizeDownloadUrl(url) {
  if (!url || typeof url !== "string") {
    return "";
  }
  let normalized = url.trim();
  if (!normalized) {
    return "";
  }

  normalized = normalized.replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  } else if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, "https://");
  }

  if (!/^https?:\/\//i.test(normalized)) {
    return "";
  }

  return normalized;
}

function getUrlExtension(url, fallback = ".jpg") {
  if (!url || typeof url !== "string") {
    return fallback;
  }
  try {
    const cleanUrl = url.split("?")[0].split("#")[0];
    const match = cleanUrl.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match ? `.${match[1].toLowerCase()}` : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeFilename(name) {
  const safe = String(name || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .trim();
  return safe.slice(0, 60) || `record_${Date.now()}`;
}

function downloadByChrome(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: `onstarvoice/${filename}`,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(
            new Error(chrome.runtime.lastError?.message || "download failed"),
          );
          return;
        }
        resolve(downloadId);
      },
    );
  });
}

async function downloadCsvRowsByChrome(rows, filename) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const csv = safeRows.map((row) => row.join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], {
    type: "text/csv;charset=utf-8;",
  });
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await downloadByChrome(objectUrl, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
  }
}

function sleep(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function buildCurrentPageCsvRows(records) {
  const tab = getActiveCaptureTab();

  if (tab === "noteTab") {
    return buildNotePageCsvRows(records);
  }
  if (tab === "bloggerTab") {
    const normalized = normalizeRecordsToSingleNoteCsv(records);
    if (normalized.length > 0) {
      return buildNotePageCsvRows(normalized);
    }
    return buildBloggerPageCsvRows(records);
  }
  if (tab === "searchTab") {
    const normalized = normalizeRecordsToSingleNoteCsv(records);
    if (normalized.length > 0) {
      return buildNotePageCsvRows(normalized);
    }
    return buildSearchPageCsvRows(records);
  }

  return [["类型"].map(csvCell)];
}

function buildCommentLeadsCsvRows(records, configInput = {}) {
  const config = buildCommentLeadsConfigFromSettings(configInput);
  const header = [
    "platform",
    "noteUrl",
    "noteTitle",
    "content",
    "userName",
    "ipLocation",
    "likes",
    "userUrl",
    "userId",
    "matchedKeywords",
  ];

  if (!config.enabled || !Array.isArray(records) || records.length === 0) {
    return [header.map(csvCell)];
  }

  const rows = [];
  records.forEach((record) => {
    if (record?.type !== "single_note") {
      return;
    }
    const result = buildCommentLeadsPayloadForRecord(record, config);
    const payload = result?.payload;
    if (
      !payload ||
      !Array.isArray(payload.items) ||
      payload.items.length === 0
    ) {
      return;
    }
    const noteUrl = String(
      payload.noteUrl || record?.payload?.url || record?.payload?.noteUrl || "",
    ).trim();
    const platformLabel = getCsvPlatformLabel(record);
    const noteTitle = String(
      payload.noteTitle ||
        record?.payload?.title ||
        record?.payload?.noteTitle ||
        "",
    ).trim();
    payload.items.forEach((item) => {
      const hasLikes = item?.likes !== undefined && item?.likes !== null;
      const userName = pickFirstLeadString([
        item?.userName,
        item?.nickname,
        item?.name,
        item?.authorName,
      ]);
      const ipLocation = pickFirstLeadString([
        item?.ipLocation,
        item?.ip,
        item?.location,
        item?.region,
        item?.["ip属地"],
      ]);
      rows.push([
        platformLabel,
        noteUrl,
        noteTitle,
        String(item?.content || ""),
        userName,
        ipLocation,
        formatCsvMetricValue(item?.likes, {captured: hasLikes}),
        String(item?.userUrl || ""),
        String(item?.userId || ""),
        Array.isArray(item?.matchedKeywords)
          ? item.matchedKeywords.join(",")
          : "",
      ]);
    });
  });

  return [header.map(csvCell), ...rows.map((row) => row.map(csvCell))];
}

function buildNotePageCsvRows(records) {
  const header = [
    "采集平台",
    "博主",
    "博主主页",
    "封面链接",
    "标题",
    "笔记链接",
    "正文",
    "话题标签",
    "图片链接",
    "评论内容",
    "笔记类型",
    "采集时间",
    "笔记最近编辑时间",
    "点赞数",
    "收藏数",
    "评论数",
    "转发数",
    "粉丝数",
    "点赞与收藏数",
    "账号属性",
    "视频链接",
    "音频链接",
    "视频时长",
    "评论采集状态",
    "评论采集条数",
  ];

  const rows = [];
  records.forEach((record) => {
    if (record.type === "single_note") {
      const p = record.payload || {};
      const platform = resolveRecordPlatform(record);
      const bloggerMetricsCaptured = isCaptureStatusDone(
        p.bloggerMetricsCaptureStatus,
      );
      const hasLikes = p.likes !== undefined && p.likes !== null;
      const hasCollects = p.collects !== undefined && p.collects !== null;
      const hasComments = p.comments !== undefined && p.comments !== null;
      const hasShares = p.shares !== undefined && p.shares !== null;
      const commentsCaptureDone =
        isCaptureStatusDone(p.commentsCaptureStatus) ||
        String(p.commentsCaptureStatus || "")
          .trim()
          .toLowerCase() === "partial";
      const tags = Array.isArray(p.tags)
        ? p.tags
        : Array.isArray(p.noteTags)
          ? p.noteTags
          : [];

      rows.push([
        getCsvPlatformLabel(record),
        p.author || "",
        p.bloggerProfileUrl || p.authorUrl || "",
        p.coverImageUrl || (p.imageUrls || [])[0] || "",
        p.title || p.noteTitle || "",
        p.url || p.noteUrl || "",
        p.content || p.noteContent || "",
        formatCsvTagList(tags),
        formatCsvUrlList(p.imageUrls || []),
        p.commentsMergedText || "",
        isVideoNotePayload(p) ? "视频" : "图文",
        formatDateTime(p.captureTimestamp || record.createdAt),
        resolveNotePublishCsvValue(p),
        formatCsvMetricValue(p.likes, {captured: hasLikes}),
        formatCsvMetricValue(p.collects, {captured: hasCollects}),
        formatCsvMetricValue(p.comments, {captured: hasComments}),
        platform === "douyin"
          ? formatCsvMetricValue(p.shares, {captured: hasShares})
          : "",
        formatCsvMetricValue(p.bloggerFollowersCount, {
          captured: bloggerMetricsCaptured,
        }),
        formatCsvMetricValue(p.bloggerLikedAndCollectedCount, {
          captured: bloggerMetricsCaptured,
        }),
        mapBloggerAccountTypeLabel(p.bloggerAccountType || p.accountType || ""),
        p.videoUrl || p.videoLink || p.video_url || "",
        getPrimaryAudioUrl(p),
        formatCsvVideoDuration(
          firstDefinedMetricValue(p.videoDuration, p.videoTime, p.duration),
        ),
        p.commentsCaptureStatus || "",
        formatCsvMetricValue(p.commentsTotalCaptured, {
          captured: commentsCaptureDone,
        }),
      ]);
      return;
    }

    if (record.type === "comments") {
      const p = record.payload || {};
      const hasTotalCount = p.totalCount !== undefined && p.totalCount !== null;
      rows.push([
        getCsvPlatformLabel(record),
        "",
        "",
        "",
        p.noteTitle || "",
        p.noteUrl || "",
        "",
        "",
        "",
        (p.items || [])
          .map(
            (item, index) =>
              `${index + 1}：${item.content || ""}（${formatCsvMetricValue(item?.likes, {captured: item?.likes !== undefined && item?.likes !== null})}个赞）`,
          )
          .join("\n"),
        "",
        formatDateTime(p.captureTimestamp || record.createdAt),
        "",
        "未采集",
        "未采集",
        formatCsvMetricValue(p.totalCount, {captured: hasTotalCount}),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        p.captureStatus || "",
        formatCsvMetricValue(p.totalCount, {captured: hasTotalCount}),
      ]);
    }
  });

  return [header.map(csvCell), ...rows.map((row) => row.map(csvCell))];
}

function normalizeRecordsToSingleNoteCsv(records = []) {
  const normalized = [];
  records.forEach((record) => {
    if (record?.type === "single_note") {
      normalized.push(record);
      return;
    }
    if (record?.type !== "blogger_notes" && record?.type !== "keyword_notes") {
      return;
    }

    const payload = record?.payload || {};
    const detailStatus = String(payload.detailCaptureStatus || "")
      .trim()
      .toLowerCase();
    const detailPayload =
      detailStatus === "done" &&
      payload.detailPayload &&
      typeof payload.detailPayload === "object"
        ? payload.detailPayload
        : null;

    if (detailPayload) {
      normalized.push({
        ...record,
        type: "single_note",
        payload: detailPayload,
      });
      return;
    }

    const item = (payload.items || [])[0] || {};
    const fallbackImageUrls = collectRecordItemImageUrls(item);
    const fallbackCoverImageUrl =
      String(item.coverImageUrl || fallbackImageUrls[0] || "").trim();
    const fallbackPayload = {
      noteType: item.noteType || item.type || "image",
      title: item.title || record.title || "",
      url: item.url || item.noteUrl || payload.detailCaptureNoteUrl || "",
      author: item.author || payload.bloggerName || "",
      content: item.content || item.noteContent || item.fullContent || item.body || "",
      likes: firstDefinedMetricValue(item.likes, item.likeCount),
      collects: firstDefinedMetricValue(item.collects, item.collectCount),
      comments: firstDefinedMetricValue(item.comments, item.commentCount),
      shares: firstDefinedMetricValue(item.shares, item.shareCount),
      bloggerFollowersCount: firstDefinedMetricValue(
        item.bloggerFollowersCount,
        payload.bloggerFollowersCount,
        payload.followersCount,
      ),
      bloggerLikedAndCollectedCount: firstDefinedMetricValue(
        item.bloggerLikedAndCollectedCount,
        payload.bloggerLikedAndCollectedCount,
        payload.likedAndCollectedCount,
      ),
      bloggerProfileUrl:
        item.bloggerProfileUrl || item.authorUrl || payload.bloggerUrl || "",
      bloggerMetricsCaptureStatus:
        item.bloggerMetricsCaptureStatus ||
        payload.bloggerMetricsCaptureStatus ||
        "not_started",
      bloggerMetricsCaptureError:
        item.bloggerMetricsCaptureError ||
        payload.bloggerMetricsCaptureError ||
        "",
      bloggerAccountType:
        item.bloggerAccountType || payload.bloggerAccountType || "",
      commentsCaptureStatus: "not_started",
      commentsTotalCaptured: null,
      commentsMergedText: "",
      coverImageUrl: fallbackCoverImageUrl,
      imageUrls: fallbackImageUrls,
      videoUrl: item.videoUrl || "",
      audioUrl:
        item.audioUrl ||
        item.musicUrl ||
        item.audio_url ||
        item.music_url ||
        "",
      videoDuration: firstDefinedMetricValue(
        item.videoDuration,
        item.videoTime,
        item.duration,
      ),
      captureTimestamp:
        payload.captureTimestamp || record.createdAt || Date.now(),
    };

    normalized.push({
      ...record,
      type: "single_note",
      payload: fallbackPayload,
    });
  });

  return normalized;
}

function collectRecordItemImageUrls(item = {}) {
  if (!item || typeof item !== "object") {
    return [];
  }

  const candidates = [];
  const append = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized) {
        candidates.push(normalized);
      }
      return;
    }
    if (typeof value === "object") {
      append(
        value.url ||
          value.src ||
          value.imageUrl ||
          value.image_url ||
          value.coverImageUrl ||
          value.cover_image_url ||
          "",
      );
    }
  };

  append(item.imageUrls);
  append(item.images);
  append(item.imageList);
  append(item.image_list);
  append(item.photoUrls);
  append(item.photo_urls);
  append(item.photos);
  append(item.media?.images);
  append(item.media?.imageUrls);
  append(item.media?.photos);
  append(item.coverImageUrl);

  return Array.from(
    new Set(
      candidates
        .map((url) => String(url || "").trim())
        .filter(Boolean),
    ),
  );
}

function isVideoNotePayload(payload) {
  const noteType = String(payload?.noteType || payload?.type || "")
    .trim()
    .toLowerCase();
  if (noteType === "video" || noteType === "视频") {
    return true;
  }
  if (
    noteType === "image" ||
    noteType === "img" ||
    noteType === "图文" ||
    noteType === "normal"
  ) {
    return false;
  }

  return Boolean(payload?.videoUrl || payload?.videoLink || payload?.video_url);
}

function shouldDownloadPrimaryVideoOnly(record, payload) {
  return (
    resolveRecordPlatform(record) === "douyin" && isVideoNotePayload(payload)
  );
}

function shouldDownloadDouyinAudio(record, payload) {
  if (resolveRecordPlatform(record) !== "douyin") {
    return true;
  }
  return isVideoNotePayload(payload);
}

function collectDownloadVideoUrls(record, payload) {
  if (!shouldDownloadPrimaryVideoOnly(record, payload)) {
    return collectVideoUrls(payload);
  }

  const primaryVideoUrl = getPrimaryVideoUrl(payload);
  return primaryVideoUrl ? [primaryVideoUrl] : [];
}

function collectDownloadAudioUrls(record, payload) {
  if (!shouldDownloadDouyinAudio(record, payload)) {
    return [];
  }

  if (!shouldDownloadPrimaryVideoOnly(record, payload)) {
    return collectAudioUrls(payload);
  }

  const primaryAudioUrl = getPrimaryAudioUrl(payload);
  return primaryAudioUrl ? [primaryAudioUrl] : [];
}

function getPrimaryVideoUrl(payload) {
  const candidates = [
    payload?.videoUrl,
    payload?.videoURL,
    payload?.video_url,
    payload?.videoLink,
    payload?.video_link,
    payload?.playUrl,
    payload?.play_url,
    payload?.media?.videoUrl,
    payload?.media?.playUrl,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeDownloadUrl(
      typeof candidate === "string" ? candidate : "",
    );
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function getPrimaryAudioUrl(payload) {
  const candidates = [
    payload?.audioUrl,
    payload?.audioURL,
    payload?.audio_url,
    payload?.musicUrl,
    payload?.musicURL,
    payload?.music_url,
    payload?.bgmUrl,
    payload?.bgmURL,
    payload?.bgm_url,
    payload?.music?.playUrl,
    payload?.music?.play_url,
    payload?.media?.audioUrl,
    payload?.media?.musicUrl,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeDownloadUrl(
      typeof candidate === "string" ? candidate : "",
    );
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function collectVideoUrls(payload) {
  const candidates = [
    payload?.videoUrl,
    payload?.videoURL,
    payload?.video_url,
    payload?.videoLink,
    payload?.video_link,
    payload?.playUrl,
    payload?.play_url,
    payload?.media?.videoUrl,
    payload?.media?.playUrl,
  ];

  const arrays = [payload?.videoUrls, payload?.videoList, payload?.videos];
  arrays.forEach((list) => {
    if (Array.isArray(list)) {
      list.forEach((item) => candidates.push(item));
    }
  });

  const seen = new Set();
  const results = [];
  candidates.forEach((item) => {
    const normalized = normalizeDownloadUrl(
      typeof item === "string" ? item : "",
    );
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    results.push(normalized);
  });

  return results;
}

function collectAudioUrls(payload) {
  const candidates = [
    payload?.audioUrl,
    payload?.audioURL,
    payload?.audio_url,
    payload?.musicUrl,
    payload?.musicURL,
    payload?.music_url,
    payload?.bgmUrl,
    payload?.bgmURL,
    payload?.bgm_url,
    payload?.music?.playUrl,
    payload?.music?.play_url,
    payload?.media?.audioUrl,
    payload?.media?.musicUrl,
  ];

  const arrays = [
    payload?.audioUrls,
    payload?.musicUrls,
    payload?.bgmUrls,
    payload?.audios,
  ];
  arrays.forEach((list) => {
    if (Array.isArray(list)) {
      list.forEach((item) => candidates.push(item));
    }
  });

  const seen = new Set();
  const results = [];
  candidates.forEach((item) => {
    const normalized = normalizeDownloadUrl(
      typeof item === "string" ? item : "",
    );
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    results.push(normalized);
  });

  return results;
}

function buildBloggerPageCsvRows(records) {
  const header = [
    "采集平台",
    "博主名称",
    "头像链接",
    "博主ID",
    "简介",
    "IP属地",
    "主页链接",
    "采集时间",
    "关注数",
    "粉丝数",
    "点赞与收藏数",
    "账号属性",
  ];

  const rows = [];
  records.forEach((record) => {
    const p = record.payload || {};
    if (record.type === "blogger_profile") {
      const profileMetricsCaptured = isCaptureStatusDone(
        p.bloggerMetricsCaptureStatus,
      );
      rows.push([
        getCsvPlatformLabel(record),
        p.bloggerName || "",
        p.avatarUrl || "",
        p.bloggerId || p.douyinId || "",
        p.description || "",
        p.ipLocation || "",
        p.bloggerUrl || "",
        formatDateTime(p.captureTimestamp || record.createdAt),
        formatCsvMetricValue(p.followingCount, {
          captured: profileMetricsCaptured,
        }),
        formatCsvMetricValue(p.followersCount, {
          captured: profileMetricsCaptured,
        }),
        formatCsvMetricValue(p.likedAndCollectedCount, {
          captured: profileMetricsCaptured,
        }),
        mapBloggerAccountTypeLabel(p.bloggerAccountType || p.accountType || ""),
      ]);
    }
  });

  return [header.map(csvCell), ...rows.map((row) => row.map(csvCell))];
}

function buildSearchPageCsvRows(records) {
  const header = [
    "平台",
    "关键词",
    "标题",
    "正文",
    "链接",
    "作者",
    "笔记最近编辑时间",
    "点赞数",
    "收藏数",
    "评论数",
    "转发数",
    "粉丝数",
    "点赞与收藏数",
    "账号属性",
    "封面",
    "音频链接",
    "视频时长",
    "采集时间",
  ];

  const rows = [];
  records.forEach((record) => {
    const p = record.payload || {};
    if (record.type !== "keyword_notes") return;
    const item = (p.items || [])[0] || {};
    const platform = resolveRecordPlatform(record);
    const itemMetricsCaptured = isCaptureStatusDone(
      item.bloggerMetricsCaptureStatus || p.bloggerMetricsCaptureStatus,
    );
    const hasLikes = item.likes !== undefined && item.likes !== null;
    const hasCollects = item.collects !== undefined && item.collects !== null;
    const hasComments = item.comments !== undefined && item.comments !== null;
    const hasShares = item.shares !== undefined && item.shares !== null;
    rows.push([
      getCsvPlatformLabel(record),
      p.keyword || "",
      item.title || "",
      item.content || item.noteContent || item.fullContent || item.body || "",
      item.url || "",
      item.author || "",
      item.publishDate || item.publishDateRaw || "",
      formatCsvMetricValue(item.likes, {captured: hasLikes}),
      formatCsvMetricValue(item.collects, {captured: hasCollects}),
      formatCsvMetricValue(item.comments, {captured: hasComments}),
      platform === "douyin" || platform === "weibo"
        ? formatCsvMetricValue(item.shares, {captured: hasShares})
        : "",
      formatCsvMetricValue(item.bloggerFollowersCount, {
        captured: itemMetricsCaptured,
      }),
      formatCsvMetricValue(item.bloggerLikedAndCollectedCount, {
        captured: itemMetricsCaptured,
      }),
      mapBloggerAccountTypeLabel(item.bloggerAccountType || ""),
      item.coverImageUrl || "",
      getPrimaryAudioUrl(item),
      formatCsvVideoDuration(
        firstDefinedMetricValue(
          item.videoDuration,
          item.videoTime,
          item.duration,
        ),
      ),
      formatDateTime(p.captureTimestamp || record.createdAt),
    ]);
  });

  return [header.map(csvCell), ...rows.map((row) => row.map(csvCell))];
}

function formatDateTime(timestamp) {
  if (!timestamp) return "";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function resolveNotePublishCsvValue(payload = {}) {
  const rawPublishText = pickFirstLeadString([
    payload.publishTime,
    payload.publishDateRaw,
  ]);
  if (rawPublishText) return rawPublishText;

  const lastEditedAt = firstDefinedMetricValue(payload.lastEditedAt);
  if (
    lastEditedAt &&
    !isLikelyCaptureDateFallback(lastEditedAt, payload.captureTimestamp)
  ) {
    return formatDateTime(lastEditedAt);
  }

  return pickFirstLeadString([payload.publishDate]);
}

function isLikelyCaptureDateFallback(timestamp, captureTimestamp) {
  if (!timestamp || !captureTimestamp) return false;
  const edited = new Date(timestamp);
  const captured = new Date(captureTimestamp);
  if (
    Number.isNaN(edited.getTime()) ||
    Number.isNaN(captured.getTime())
  ) {
    return false;
  }
  return (
    edited.getFullYear() === captured.getFullYear() &&
    edited.getMonth() === captured.getMonth() &&
    edited.getDate() === captured.getDate() &&
    edited.getHours() === 0 &&
    edited.getMinutes() === 0 &&
    edited.getSeconds() === 0
  );
}

function getCsvPlatformLabel(record) {
  return getPlatformCopy(resolveRecordPlatform(record)).label;
}

function normalizeMetricNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function pickFirstLeadString(candidates = []) {
  for (const candidate of candidates) {
    const text = String(candidate || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function firstDefinedMetricValue(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") {
      continue;
    }
    return candidate;
  }
  return null;
}

function formatCsvTagList(tags = []) {
  if (!Array.isArray(tags)) {
    return "";
  }
  const normalized = tags
    .map((tag) => String(tag || "").trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).join(",");
}

function formatCsvUrlList(urls = []) {
  if (!Array.isArray(urls)) {
    return "";
  }
  const normalized = urls
    .map((url) => String(url || "").trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).join(" | ");
}

function formatCsvVideoDuration(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      return trimmed;
    }
    value = numeric;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }

  const totalSeconds = Math.max(
    0,
    Math.floor(value >= 1000 ? value / 1000 : value),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  }

  return `${mm}:${ss}`;
}

function formatCsvMetricValue(value, {captured = true} = {}) {
  if (!captured) {
    return "未采集";
  }
  const normalized = normalizeMetricNumber(value);
  if (normalized === null) {
    return "未采集";
  }
  return normalized;
}

function isCaptureStatusDone(status) {
  return (
    String(status || "")
      .trim()
      .toLowerCase() === "done"
  );
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function resolveBloggerNoteTypeLabel(item) {
  const raw = String(item?.noteType || item?.type || "")
    .trim()
    .toLowerCase();
  return raw === "video" || raw === "视频" ? "视频" : "图文";
}

function mapBloggerAccountTypeLabel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "famous" || normalized === "红v") return "红V";
  if (normalized === "company" || normalized === "蓝v") return "蓝V";
  return "普通";
}

// ==================== UI 更新函数 ====================

/**
 * 更新整体 UI
 */
function updateUI() {
  const runtime = getCurrentRuntime();
  const auth = getCurrentAuth();
  const target = getCurrentTarget();
  const capture = getCurrentCapture();
  const sync = getCurrentSync();
  const dataPool = getCurrentDataPool();

  const publicAuth = buildPublicSidebarAuthState(auth);
  window.getSidebarAuthState = () => publicAuth;
  window.getSidebarRuntimeState = () => runtime;
  updatePlatformUI(runtime);
  updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
  updateAuthUI(auth);
  updateTargetUI(target);
  updateCaptureUI(capture);
  updateSyncUI(sync);
  updateDataPoolUI(dataPool);
}

function updatePlatformUI(runtimeOrUrl) {
  const runtime =
    runtimeOrUrl && typeof runtimeOrUrl === "object"
      ? runtimeOrUrl
      : getCurrentRuntime();
  const runtimeUrl =
    typeof runtimeOrUrl === "string"
      ? runtimeOrUrl
      : runtime?.lastPageUrl || "";
  const urlPlatform = detectPlatformFromUrl(runtimeUrl);
  const runtimePlatform = String(runtime?.platform || "").trim();
  const normalizedPagePlatform =
    urlPlatform && urlPlatform !== "unknown"
      ? urlPlatform
      : runtimePlatform && runtimePlatform !== "unknown"
        ? runtimePlatform
        : "unknown";
  if (
    normalizedPagePlatform &&
    normalizedPagePlatform !== "unknown" &&
    normalizedPagePlatform !== lastKnownPagePlatform
  ) {
    lastKnownPagePlatform = normalizedPagePlatform;
    manualSelectedPlatform = "";
  } else if (!lastKnownPagePlatform || lastKnownPagePlatform === "unknown") {
    lastKnownPagePlatform = normalizedPagePlatform || "unknown";
  }
  const selectedPlatform = resolveSelectedPlatform(
    runtime,
    normalizedPagePlatform,
  );
  syncBatchDraftForPlatform(selectedPlatform);

  document.body.dataset.pagePlatform = normalizedPagePlatform || "unknown";
  document.body.dataset.selectedPlatform = selectedPlatform;
  document.body.dataset.activePlatform = selectedPlatform;
  window.renderPlatformCaptureTabs?.(selectedPlatform);

  syncPlatformMenuUI({
    selectedPlatform,
    pagePlatform: normalizedPagePlatform || "unknown",
  });
  syncPlatformSettingsCapabilityUI(selectedPlatform);
}

function setPrimaryCaptureButtonDisabled(button, disabled) {
  if (!button) {
    return;
  }
  const nextDisabled = Boolean(disabled);
  button.disabled = nextDisabled;
  button.classList.toggle("is-disabled", nextDisabled);
}

function isNoteDetailPending(runtime) {
  return (
    runtime?.pageType === PAGE_TYPE.NOTE_DETAIL &&
    runtime?.detailReady === false
  );
}

function resolveNoteDetailPendingText(runtime = {}) {
  const reason = String(runtime.detailReadyReason || "").trim();
  if (reason === "loading") {
    return NOTE_DETAIL_LOADING_TEXT;
  }
  return "正在等待笔记标题、正文或素材加载完成，加载完成后即可采集";
}

/**
 * 更新页面类型 UI
 */
function updatePageTypeUI(pageType) {
  const isNote = pageType === PAGE_TYPE.NOTE_DETAIL;
  const isBlogger = pageType === PAGE_TYPE.BLOGGER_PROFILE;
  const isSearch = pageType === PAGE_TYPE.SEARCH_RESULTS;
  const runtime = getCurrentRuntime();
  const pagePlatform = getPagePlatform(runtime);
  const selectedPlatform = getViewPlatform(runtime);
  const selectedCapabilities = getPlatformCapabilities(selectedPlatform);
  const isPlatformMatched = selectedPlatform === pagePlatform;
  const inDetailBatch = detailBatchCaptureInFlight;
  const noteDetailPending = isPlatformMatched && isNote && isNoteDetailPending(runtime);
  const allowCommentsToggle =
    !noteDetailPending && !inDetailBatch && selectedCapabilities.captureComments;
  const platformCopy = getPlatformCopy(selectedPlatform);

  const btnCaptureNote = document.getElementById("btnCaptureNote");
  const checkboxCaptureBloggerMetrics = document.getElementById(
    "checkboxCaptureBloggerMetrics",
  );
  const captureBloggerMetricsSwitchWrap = document.getElementById(
    "captureBloggerMetricsSwitchWrap",
  );
  const checkboxCaptureComments = document.getElementById(
    "checkboxCaptureComments",
  );
  const inputCommentsMaxDetectedItems = document.getElementById(
    "inputCommentsMaxDetectedItems",
  );
  const btnCaptureBlogger = document.getElementById("btnCaptureBlogger");
  const inputBloggerMinLikes = document.getElementById("inputBloggerMinLikes");
  const inputBloggerMaxDetectedItems = document.getElementById(
    "inputBloggerMaxDetectedItems",
  );
  const btnCaptureSearch = document.getElementById("btnCaptureSearch");
  const btnToggleKeywordStrategy = document.getElementById(
    "btnToggleKeywordStrategy",
  );
  const currentSearchKeywordText = document.getElementById(
    "currentSearchKeywordText",
  );
  const inputKeywordMinLikes = document.getElementById("inputKeywordMinLikes");
  const inputKeywordMaxDetectedItems = document.getElementById(
    "inputKeywordMaxDetectedItems",
  );
  const labelKeywordMinThreshold = document.getElementById(
    "labelKeywordMinThreshold",
  );

  setPrimaryCaptureButtonDisabled(
    btnCaptureNote,
    !isNote || noteDetailPending || inDetailBatch || !isPlatformMatched,
  );
  if (checkboxCaptureBloggerMetrics) {
    checkboxCaptureBloggerMetrics.disabled =
      inDetailBatch || !selectedCapabilities.bloggerMetrics;
  }
  if (captureBloggerMetricsSwitchWrap) {
    captureBloggerMetricsSwitchWrap.hidden =
      shouldHideNoteBloggerMetricsToggle(selectedPlatform);
  }
  if (checkboxCaptureComments)
    checkboxCaptureComments.disabled = !allowCommentsToggle;
  if (inputCommentsMaxDetectedItems) {
    syncCommentsCaptureControls({forceDisabled: !allowCommentsToggle});
  }
  setPrimaryCaptureButtonDisabled(
    btnCaptureBlogger,
    !isBlogger || inDetailBatch || !isPlatformMatched,
  );
  if (inputBloggerMinLikes) inputBloggerMinLikes.disabled = inDetailBatch;
  if (inputBloggerMaxDetectedItems)
    inputBloggerMaxDetectedItems.disabled = inDetailBatch;
  const inputBloggerKeywordFilter = document.getElementById(
    "inputBloggerKeywordFilter",
  );
  if (inputBloggerKeywordFilter)
    inputBloggerKeywordFilter.disabled = inDetailBatch;
  setPrimaryCaptureButtonDisabled(
    btnCaptureSearch,
    !isSearch ||
      inDetailBatch ||
      !isPlatformMatched ||
      !selectedCapabilities.captureSearch,
  );
  if (btnToggleKeywordStrategy) {
    btnToggleKeywordStrategy.disabled =
      !isSearch ||
      inDetailBatch ||
      !isPlatformMatched ||
      !selectedCapabilities.captureSearch;
    btnToggleKeywordStrategy.classList.toggle(
      "is-disabled",
      btnToggleKeywordStrategy.disabled,
    );
  }
  const currentSearchKeyword = getCurrentSearchKeyword(runtime);
  if (inputKeywordMinLikes)
    inputKeywordMinLikes.disabled =
      inDetailBatch || !selectedCapabilities.captureSearch;
  if (inputKeywordMaxDetectedItems)
    inputKeywordMaxDetectedItems.disabled =
      inDetailBatch || !selectedCapabilities.captureSearch;
  if (btnCaptureNote) {
    btnCaptureNote.textContent = platformCopy.captureNoteButtonText;
  }
  if (btnCaptureBlogger) {
    btnCaptureBlogger.textContent = platformCopy.captureBloggerButtonText;
  }
  if (btnCaptureSearch) {
    const isSearchBatchMode = Boolean(
      document.getElementById("chkSearchBatchMode")?.checked,
    );
    btnCaptureSearch.textContent = isSearchBatchMode
      ? "开始批量采集"
      : platformCopy.captureSearchButtonText;
  }
  if (currentSearchKeywordText) {
    if (currentSearchKeyword) {
      currentSearchKeywordText.textContent = currentSearchKeyword;
      currentSearchKeywordText.classList.remove("is-empty");
    } else {
      currentSearchKeywordText.textContent = "未检测到关键词";
      currentSearchKeywordText.classList.add("is-empty");
    }
  }
  if (labelKeywordMinThreshold && !selectedCapabilities.captureSearch) {
    labelKeywordMinThreshold.textContent = "当前平台搜索采集将在后续版本开放";
  } else if (labelKeywordMinThreshold) {
    labelKeywordMinThreshold.textContent = "高于以下点赞数才会被采集";
  }
  syncAutoDetailCaptureControls({
    forceDisabled: inDetailBatch,
    platform: selectedPlatform,
  });

  if (isSearch && selectedCapabilities.captureSearch) {
    applyKeywordSortDimensionToUI(keywordSortDimension);
    startKeywordSortSyncTimer();
  } else {
    stopKeywordSortSyncTimer();
    keywordSortDimension = KEYWORD_SORT_DIMENSION.LIKES;
    applyKeywordSortDimensionToUI(keywordSortDimension);
  }
  maybeResetKeywordOpportunityForCurrentSearch(runtime);
  renderKeywordStrategyPanel();
}

/**
 * 更新鉴权 UI
 */
function updateAuthUI(auth) {
  const status = auth?.status;
  const isVerified = isAuthVerified(auth);
  const isUnclaimedOwner = isUnclaimedCredentialOwner(auth);

  // 更新鉴权状态指示器
  const authStatus = document.getElementById("authStatus");
  if (authStatus) {
    if (status === AUTH_STATUS.VERIFYING) {
      authStatus.textContent = "验证中";
      authStatus.style.color = "var(--status-info)";
    } else if (isVerified && isUnclaimedOwner) {
      authStatus.textContent = "未绑定";
      authStatus.style.color = "var(--status-warning)";
    } else if (isVerified) {
      authStatus.textContent = "已激活";
      authStatus.style.color = "var(--status-success)";
    } else {
      authStatus.textContent = "未激活";
      authStatus.style.color = "var(--status-warning)";
    }
  }

  const runtime = getCurrentRuntime();
  updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);

  updateAuthCodeVisibilityButton();
  void renderAuthCodeInput(auth);
  void updateMemberGroupEntryVisibility(auth);
}

/**
 * 更新目标配置 UI
 */
function updateTargetUI(target) {
  const inputFeishuAppToken = document.getElementById("inputFeishuAppToken");
  const inputTableId = document.getElementById("inputTableId");
  const inputKeywordNotesTableName = document.getElementById(
    "inputKeywordNotesTableName",
  );
  const inputBloggerProfileTableName = document.getElementById(
    "inputBloggerProfileTableName",
  );
  const inputBloggerNotesTableName = document.getElementById(
    "inputBloggerNotesTableName",
  );
  const inputCommentLeadsTableName = document.getElementById(
    "inputCommentLeadsTableName",
  );
  const inputMonitorTableName = document.getElementById(
    "inputMonitorTableName",
  );
  const inputReportWebhookUrl = document.getElementById(
    "inputReportWebhookUrl",
  );

  if (inputFeishuAppToken) {
    inputFeishuAppToken.value = target.feishuAppToken || "";
  }

  if (inputTableId) {
    inputTableId.value = target.tableId || DEFAULT_SINGLE_NOTE_TABLE_NAME;
  }

  if (inputKeywordNotesTableName) {
    inputKeywordNotesTableName.value =
      target.keywordNotesTableName || DEFAULT_KEYWORD_NOTES_TABLE_NAME;
  }

  if (inputBloggerProfileTableName) {
    inputBloggerProfileTableName.value =
      target.bloggerProfileTableName || DEFAULT_BLOGGER_PROFILE_TABLE_NAME;
  }

  if (inputBloggerNotesTableName) {
    inputBloggerNotesTableName.value =
      target.bloggerNotesTableName || DEFAULT_BLOGGER_NOTES_TABLE_NAME;
  }

  if (inputCommentLeadsTableName) {
    inputCommentLeadsTableName.value =
      target.commentLeadsTableName || DEFAULT_COMMENT_LEADS_TABLE_NAME;
  }

  if (inputMonitorTableName) {
    inputMonitorTableName.value =
      target.monitorTableName || DEFAULT_MONITOR_TABLE_NAME;
  }

  if (inputReportWebhookUrl) {
    inputReportWebhookUrl.value = target.reportWebhookUrl || "";
  }
}

/**
 * 更新采集状态 UI
 */
function updateCaptureUI(capture) {
  // 根据 Gemini 的新 UI 结构更新
  // TODO: 根据实际 HTML 结构调整
}

/**
 * 更新同步状态 UI
 */
function updateSyncUI(sync) {
  // 根据 Gemini 的新 UI 结构更新
  // TODO: 根据实际 HTML 结构调整
}

/**
 * 更新数据池 UI
 */
function updateDataPoolUI(dataPool) {
  const records = getCurrentPageRecords(dataPool?.records || []);
  const statsText = document.getElementById("poolStatsText");
  if (statsText) {
    statsText.textContent = `共 ${records.length} 条数据`;
  }

  const btnExport = document.getElementById("btnExport");
  const btnSyncAll = document.getElementById("btnSyncAll");
  const btnClearPool = document.getElementById("btnClearPool");

  const hasRecords = records.length > 0;

  if (btnExport) btnExport.disabled = !hasRecords || detailBatchCaptureInFlight;
  if (btnSyncAll)
    btnSyncAll.disabled = !hasRecords || detailBatchCaptureInFlight;
  if (btnClearPool)
    btnClearPool.disabled = !hasRecords || detailBatchCaptureInFlight;
}

// ==================== 辅助函数 ====================

function getActiveCaptureTab() {
  const activeMainTab = document.querySelector(
    "#mainTabNav .tab-btn.is-active",
  );
  return activeMainTab?.dataset?.target || "noteTab";
}

function getCurrentPageRecordTypes() {
  const tab = getActiveCaptureTab();
  const activePlatform =
    document.body.dataset.selectedPlatform ||
    getViewPlatform(getCurrentRuntime());
  return getRecordTypesForTab(activePlatform, tab);
}

function getCurrentPageRecords(inputRecords = null) {
  const records = inputRecords || getCurrentDataPool()?.records || [];
  const currentTypes = new Set(getCurrentPageRecordTypes());
  const activePlatform =
    document.body.dataset.selectedPlatform ||
    getViewPlatform(getCurrentRuntime());
  return records.filter((record) => {
    const recordType = String(record?.type || record?.recordType || "").trim();
    if (!currentTypes.has(recordType)) {
      return false;
    }
    if (activePlatform === "unknown") {
      return true;
    }
    const recordPlatform = resolveRecordPlatform(record);
    return recordPlatform === activePlatform || recordPlatform === "unknown";
  });
}

function getPagePlatform(runtime = null) {
  const nextRuntime = runtime || getCurrentRuntime() || {};
  const urlPlatform = detectPlatformFromUrl(nextRuntime?.lastPageUrl || "");
  if (urlPlatform && urlPlatform !== "unknown") {
    return urlPlatform;
  }
  const directPlatform = String(nextRuntime?.platform || "").trim();
  if (directPlatform && directPlatform !== "unknown") {
    return directPlatform;
  }
  return "unknown";
}

function getViewPlatform(runtime = null) {
  return resolveSelectedPlatform(runtime);
}

function resolveSelectedPlatform(runtime = null, pagePlatform = "") {
  const nextRuntime = runtime || getCurrentRuntime() || {};
  const resolvedPagePlatform = pagePlatform || getPagePlatform(nextRuntime);
  if (manualSelectedPlatform && manualSelectedPlatform !== "unknown") {
    return manualSelectedPlatform;
  }
  if (resolvedPagePlatform && resolvedPagePlatform !== "unknown") {
    return resolvedPagePlatform;
  }
  return "unknown";
}

function setPlatformMenuOpen(isOpen) {
  const dropdownPlatformMenu = document.getElementById("dropdownPlatformMenu");
  const btnPlatformMenu = document.getElementById("btnPlatformMenu");
  if (dropdownPlatformMenu) {
    dropdownPlatformMenu.classList.toggle("is-active", Boolean(isOpen));
  }
  if (btnPlatformMenu) {
    btnPlatformMenu.classList.toggle("is-active", Boolean(isOpen));
    btnPlatformMenu.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }
}

function syncPlatformMenuUI({
  selectedPlatform = "unknown",
  pagePlatform = "unknown",
}) {
  const displayPlatform =
    pagePlatform && pagePlatform !== "unknown"
      ? pagePlatform
      : selectedPlatform || "unknown";
  const currentPlatformCopy = getPlatformCopy(displayPlatform);
  const pagePlatformCopy = getPlatformCopy(pagePlatform || "unknown");
  const selectedPlatformCopy = getPlatformCopy(selectedPlatform || "unknown");
  const currentPlatformName = document.getElementById("currentPlatformName");
  const currentPlatformLogo = document.getElementById("currentPlatformLogo");
  const btnPlatformMenu = document.getElementById("btnPlatformMenu");

  if (currentPlatformName) {
    currentPlatformName.textContent = currentPlatformCopy.label;
  }
  if (currentPlatformLogo) {
    currentPlatformLogo.className = `platform-trigger-logo platform-logo ${getPlatformLogoClass(displayPlatform)}`;
    currentPlatformLogo.innerHTML = getPlatformLogoInnerMarkup(displayPlatform);
  }
  if (btnPlatformMenu) {
    btnPlatformMenu.title =
      selectedPlatform === pagePlatform ||
      !selectedPlatform ||
      selectedPlatform === "unknown"
        ? `当前页面平台：${pagePlatformCopy.label}`
        : `当前页面平台：${pagePlatformCopy.label}；当前视图：${selectedPlatformCopy.label}`;
  }

  document
    .querySelectorAll(".platform-menu-item[data-platform]")
    .forEach((button) => {
      const buttonPlatform = String(button.dataset.platform || "").trim();
      const isSelected = buttonPlatform === selectedPlatform;
      const isPagePlatform = buttonPlatform === pagePlatform;
      button.classList.toggle("is-active", isSelected);
      button.classList.toggle("is-page-platform", isPagePlatform);
      button.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });
}

function syncPlatformSettingsCapabilityUI(platform = "unknown") {
  const capabilities = getPlatformCapabilities(platform);
  const platformCopy = getPlatformCopy(platform);

  const commentRelatedControls = [
    document.getElementById("checkboxEnableCommentLeadsFilter"),
    document.getElementById("inputCommentLeadsKeywords"),
    document.getElementById("inputCommentLeadsIps"),
    document.getElementById("inputCommentLeadsTableName"),
    ...Array.from(
      document.querySelectorAll(
        '[data-detail-setting="comments-max-detected-items"], [data-detail-setting="comment-leads"]',
      ),
    ),
    document.getElementById("batchDetailIncludeComments"),
    document.getElementById("batchDetailCommentsLimit"),
    document.getElementById("batchDetailEnableCommentLeadsFilter"),
  ];
  const searchRelatedControls = [
    document.getElementById("inputKeywordNotesTableName"),
  ];

  const commentDisabledReason = capabilities.captureComments
    ? ""
    : `${platformCopy.label}当前版本暂不支持评论采集`;
  const bloggerMetricsDisabledReason = capabilities.bloggerMetrics
    ? ""
    : `${platformCopy.label}当前版本暂不支持单作品博主指标增强`;
  const searchDisabledReason = capabilities.captureSearch
    ? ""
    : `${platformCopy.label}当前版本暂不支持搜索采集`;

  commentRelatedControls.forEach((control) => {
    if (!control) return;
    control.disabled = !capabilities.captureComments;
    control.title = commentDisabledReason;
  });

  searchRelatedControls.forEach((control) => {
    if (!control) return;
    control.disabled = !capabilities.captureSearch;
    control.title = searchDisabledReason;
  });
}

function getPlatformLogoClass(platform) {
  if (platform === "unknown") {
    return "platform-logo-unknown";
  }
  if (platform === "xiaohongshu") {
    return "platform-logo-xiaohongshu";
  }
  if (platform === "weibo") {
    return "platform-logo-weibo";
  }
  return "platform-logo-douyin";
}

function getPlatformLogoInnerMarkup(platform) {
  if (platform === "unknown") {
    return "?";
  }
  if (platform === "xiaohongshu") {
    return '<span class="platform-logo-xiaohongshu-inner">小红书</span>';
  }
  if (platform === "weibo") {
    return '<span class="platform-logo-weibo-inner">W</span>';
  }
  return '<span class="platform-logo-douyin-inner">♪</span>';
}

function getDetailCaptureTargetRecords(records = [], options = {}) {
  const scope =
    options?.scope === DETAIL_CAPTURE_SCOPE_ALL
      ? DETAIL_CAPTURE_SCOPE_ALL
      : DETAIL_CAPTURE_SCOPE_PENDING;
  return records.filter((record) => {
    if (!isDetailCaptureRecord(record)) {
      return false;
    }
    if (scope === DETAIL_CAPTURE_SCOPE_ALL) {
      return true;
    }
    return !isDetailCaptureDone(record);
  });
}

function isDetailCaptureRecord(record) {
  return Boolean(
    record &&
    (record.type === "blogger_notes" || record.type === "keyword_notes"),
  );
}

function isAiRelevanceFilteredPayload(payload = {}) {
  const audit =
    payload.aiRelevancePrefilter &&
    typeof payload.aiRelevancePrefilter === "object"
      ? payload.aiRelevancePrefilter
      : {};
  const executionDisposition = String(audit.executionDisposition || "")
    .trim()
    .toLowerCase();
  const modelExecutionDisposition = String(
    audit.modelExecutionDisposition || "",
  )
    .trim()
    .toLowerCase();
  const modelDecision = String(audit.modelDecision || audit.decision || "")
    .trim()
    .toLowerCase();
  const traceState = String(payload?.captureTrace?.state || "")
    .trim()
    .toLowerCase();

  return (
    executionDisposition === "skip_expensive" ||
    (modelExecutionDisposition === "skip_full_capture" &&
      modelDecision === "skip") ||
    (traceState === "filtered" && modelDecision === "skip")
  );
}

function isDetailCaptureFiltered(record) {
  const payload = record?.payload || {};
  const detailStatus = String(payload.detailCaptureStatus || "")
    .trim()
    .toLowerCase();
  const traceState = String(payload?.captureTrace?.state || "")
    .trim()
    .toLowerCase();
  return (
    detailStatus === "filtered" ||
    isAiRelevanceFilteredPayload(payload) ||
    traceState === "filtered"
  );
}

function isDetailCaptureDone(record) {
  const payload = record?.payload || {};
  const detailStatus = String(payload.detailCaptureStatus || "")
    .trim()
    .toLowerCase();
  return (
    isDetailCaptureFiltered(record) ||
    (detailStatus === "done" &&
      payload.detailPayload &&
      typeof payload.detailPayload === "object")
  );
}

function isDetailCaptureRetryable(record) {
  if (!isDetailCaptureRecord(record) || isDetailCaptureDone(record)) {
    return false;
  }
  const payload = record?.payload || {};
  const status = String(payload.detailCaptureStatus || "not_started")
    .trim()
    .toLowerCase();
  return status !== "capturing";
}

function getBatchRetryDetailRecordIds(triggerRecordId = "") {
  const pageRecords = getCurrentPageRecords();
  const retryableRecords = pageRecords.filter((record) =>
    isDetailCaptureRetryable(record),
  );
  if (retryableRecords.length === 0) {
    return [];
  }

  const ids = retryableRecords.map((record) => record.id);
  if (!triggerRecordId || !ids.includes(triggerRecordId)) {
    return ids;
  }

  return [
    triggerRecordId,
    ...ids.filter((recordId) => recordId !== triggerRecordId),
  ];
}

function summarizeDetailCaptureBlockers(records = []) {
  const summary = {
    total: 0,
    notStarted: 0,
    capturing: 0,
    failed: 0,
    linkMissing: 0,
    pageFailed: 0,
    contextInterrupted: 0,
  };

  records.forEach((record) => {
    if (!isDetailCaptureRecord(record) || isDetailCaptureDone(record)) {
      return;
    }

    summary.total += 1;
    const payload = record?.payload || {};
    const status = String(payload.detailCaptureStatus || "not_started")
      .trim()
      .toLowerCase();
    const category = String(payload.detailCaptureFailureCategory || "")
      .trim()
      .toLowerCase();

    if (status === "capturing") {
      summary.capturing += 1;
      return;
    }
    if (status === "failed") {
      summary.failed += 1;
      if (category === "link_missing") {
        summary.linkMissing += 1;
      } else if (category === "context_interrupted") {
        summary.contextInterrupted += 1;
      } else {
        summary.pageFailed += 1;
      }
      return;
    }

    summary.notStarted += 1;
  });

  return summary;
}

function buildDetailCaptureBlockerMessage(summary) {
  const parts = [];
  if (summary.capturing > 0) {
    parts.push(`进行中 ${summary.capturing} 条`);
  }

  const reasonParts = [];
  if (summary.contextInterrupted > 0) {
    reasonParts.push(`任务中断 ${summary.contextInterrupted} 条`);
  }
  if (summary.pageFailed > 0) {
    reasonParts.push(`页面失败 ${summary.pageFailed} 条`);
  }
  if (summary.linkMissing > 0) {
    reasonParts.push(`链接缺失 ${summary.linkMissing} 条`);
  }

  return `当前有 ${summary.capturing} 条记录正在执行采集增强（${parts.join("，")}），暂不允许同步后台，避免同步过程中数据被覆盖${
    reasonParts.length > 0 ? `。原因分布：${reasonParts.join("，")}` : ""
  }。请等待采集增强完成后再同步。`;
}

function buildDetailCaptureSyncWarningMessage(summary) {
  const parts = [];
  if (summary.notStarted > 0) {
    parts.push(`未执行 ${summary.notStarted} 条`);
  }
  if (summary.failed > 0) {
    parts.push(`失败 ${summary.failed} 条`);
  }

  const reasonParts = [];
  if (summary.linkMissing > 0) {
    reasonParts.push(`链接缺失 ${summary.linkMissing} 条`);
  }
  if (summary.pageFailed > 0) {
    reasonParts.push(`页面失败 ${summary.pageFailed} 条`);
  }
  if (summary.contextInterrupted > 0) {
    reasonParts.push(`任务中断 ${summary.contextInterrupted} 条`);
  }

  return `当前有 ${summary.total} 条记录未完成采集增强（${parts.join("，")}）。继续同步将只同步当前已采集到的基础字段，正文、标签、评论、图片/视频链接等增强字段可能为空，后续完成采集增强后可再次同步补齐${
    reasonParts.length > 0 ? `。原因分布：${reasonParts.join("，")}` : ""
  }。`;
}

function summarizeDetailCaptureFailures(results = []) {
  const summary = {
    linkMissing: 0,
    pageFailed: 0,
    contextInterrupted: 0,
    otherFailed: 0,
  };

  results.forEach((item) => {
    if (!item || item.ok) {
      return;
    }
    const category = String(item.category || "")
      .trim()
      .toLowerCase();
    if (category === "link_missing") {
      summary.linkMissing += 1;
    } else if (category === "page_failed") {
      summary.pageFailed += 1;
    } else if (
      category === "context_interrupted" ||
      category === "user_canceled"
    ) {
      summary.contextInterrupted += 1;
    } else {
      summary.otherFailed += 1;
    }
  });

  return summary;
}

function buildDetailCaptureFailureSummaryText(result) {
  const summary = summarizeDetailCaptureFailures(result?.results || []);
  const parts = [];
  if (summary.linkMissing > 0) {
    parts.push(`链接缺失 ${summary.linkMissing}`);
  }
  if (summary.pageFailed > 0) {
    parts.push(`页面失败 ${summary.pageFailed}`);
  }
  if (summary.contextInterrupted > 0) {
    parts.push(`任务中断 ${summary.contextInterrupted}`);
  }
  if (summary.otherFailed > 0) {
    parts.push(`其他失败 ${summary.otherFailed}`);
  }
  return parts.length > 0 ? `（${parts.join("，")}）` : "";
}

function getRecordPrimaryNoteUrl(record) {
  if (!record || typeof record !== "object") {
    return "";
  }
  const payload = record.payload || {};
  const firstItem = Array.isArray(payload.items) ? payload.items[0] : null;
  const expectedNoteId = resolveRecordDetailNoteId(record);
  const candidates = [
    buildDouyinRecordSearchModalUrl(record, expectedNoteId),
    firstItem?.url,
    firstItem?.noteUrl,
    payload?.detailCaptureNoteUrl,
    payload?.url,
    payload?.noteUrl,
    buildFallbackDetailNoteUrl(record),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeNoteUrl(candidate);
    if (normalized) {
      const candidateNoteId = extractNoteId(normalized);
      if (
        expectedNoteId &&
        candidateNoteId &&
        candidateNoteId !== expectedNoteId
      ) {
        continue;
      }
      return normalizeDouyinDetailUrlAgainstRecord(record, normalized);
    }
  }
  return "";
}

function buildFallbackDetailNoteUrl(record) {
  const noteId = resolveRecordDetailNoteId(record);
  if (!noteId) {
    return "";
  }

  const platform = resolveRecordPlatform(record);
  if (platform === "douyin") {
    const contextualUrl = buildDouyinRecordSearchModalUrl(record, noteId);
    if (contextualUrl) return contextualUrl;
    return `https://www.douyin.com/${resolveRecordDetailNotePath(record)}/${noteId}`;
  }

  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function buildDouyinRecordSearchModalUrl(record, noteId) {
  if (!/^\d{8,}$/.test(String(noteId || ""))) {
    return "";
  }
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const candidates = [
    firstItem.searchUrl,
    payload.searchUrl,
    record?.meta?.sourceUrl,
    record?.sourceUrl,
  ];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(String(candidate || ""));
      const hostname = parsed.hostname.toLowerCase();
      if (
        (hostname !== "douyin.com" && !hostname.endsWith(".douyin.com")) ||
        !/\/search\//i.test(parsed.pathname)
      ) {
        continue;
      }
      parsed.searchParams.set("modal_id", String(noteId));
      return parsed.toString();
    } catch {
      // Try the next captured search context.
    }
  }
  return "";
}

function resolveRecordDetailNoteId(record) {
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const urlCandidates = [
    firstItem.url,
    firstItem.noteUrl,
    payload.detailCaptureNoteUrl,
    payload.url,
    payload.noteUrl,
  ];
  const isDouyinRecord =
    resolveRecordPlatform(record) === "douyin" ||
    urlCandidates.some((value) => {
      try {
        const parsed = new URL(String(value || ""));
        return (
          parsed.hostname === "douyin.com" ||
          parsed.hostname.endsWith(".douyin.com")
        );
      } catch {
        return false;
      }
    });
  const candidates = [
    firstItem.noteId,
    payload.noteId,
    firstItem.id,
    payload.id,
    ...urlCandidates.map(extractNoteId),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || normalized.startsWith("synthetic_")) {
      continue;
    }
    if (isDouyinRecord && !/^\d{8,}$/.test(normalized)) {
      continue;
    }
    if (/^[a-zA-Z0-9_-]{6,}$/.test(normalized)) {
      return normalized;
    }
  }

  return "";
}

function resolveRecordDetailNotePath(record) {
  const payload = record?.payload || {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === "object"
      ? payload.items[0]
      : {};
  const duration = String(
    firstItem.duration ||
      firstItem.videoDuration ||
      payload.duration ||
      payload.videoDuration ||
      "",
  ).trim();
  if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(duration)) {
    return "video";
  }
  const rawType = String(
    firstItem.noteType ||
      firstItem.type ||
      payload.noteType ||
      payload.type ||
      "",
  )
    .trim()
    .toLowerCase();

  if (rawType === "image" || rawType === "图文") {
    return "note";
  }

  return "video";
}

function normalizeDouyinDetailUrlAgainstRecord(record, url) {
  const normalized = String(url || "").trim();
  if (
    resolveRecordPlatform(record) !== "douyin" ||
    resolveRecordDetailNotePath(record) !== "video"
  ) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    const match = parsed.pathname.match(/^\/note\/([^/?#]+)/i);
    if (!match?.[1]) return normalized;
    parsed.pathname = `/video/${match[1]}`;
    return parsed.toString();
  } catch {
    return normalized.replace(
      /^(https?:\/\/(?:www\.)?douyin\.com)\/note\//i,
      "$1/video/",
    );
  }
}

function normalizeNoteUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  let normalized = raw;
  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  }
  if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, "https://");
  }

  try {
    const parsed = new URL(normalized);
    const hostname = String(parsed.hostname || "").toLowerCase();
    const supportedHost =
      hostname === "xiaohongshu.com" ||
      hostname.endsWith(".xiaohongshu.com") ||
      hostname === "douyin.com" ||
      hostname.endsWith(".douyin.com");
    if (!supportedHost) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * 显示消息
 */
function showMessage(message, type = "info") {
  console.log(`[Sidebar] Message (${type}):`, message);

  if (
    typeof window.showMessage === "function" &&
    window.showMessage !== showMessage
  ) {
    window.showMessage(message, type);
    return;
  }

  alert(message);
}

function isUnsupportedPlatformCoverVisible() {
  return document.body.classList.contains(
    "is-unsupported-platform-cover-visible",
  );
}

/**
 * 显示进度
 */
function showProgress(message, showUI = true) {
  if (
    document.getElementById("progressContainer")?.dataset.progressSource ===
    "keyword-plan"
  ) {
    clearKeywordPlanProgressCountdown();
  }
  resetCaptureRecoveryUI({hidePanel: false, clearState: true});
  const showPanel = Boolean(showUI) && !isUnsupportedPlatformCoverVisible();
  const progressContainer = document.getElementById("progressContainer");
  if (progressContainer) {
    progressContainer.dataset.progressSource = "capture";
    if (activeUnattendedRunRequestId) {
      progressContainer.dataset.unattendedProgressState = "running";
    } else {
      delete progressContainer.dataset.unattendedProgressState;
    }
    progressContainer.style.display = showPanel ? "block" : "none";
  }

  const progressText = document.getElementById("progressText");
  const progressBar = document.getElementById("progressBar");
  if (progressText && showPanel) {
    progressText.textContent = message;
    if (progressBar) {
      progressBar.className = "status-bar capture-recovery-status is-info";
    }
  }

  setCaptureButtonsDisabled(true);

  // 显示取消按钮
  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel && showPanel) {
    btnCancel.hidden = false;
    btnCancel.disabled = false;
    btnCancel.style.display = "inline-block";
  } else if (btnCancel) {
    btnCancel.style.display = "none";
  }
}

function hideProgressPanelOnly({
  force = false,
  preserveUnattendedTerminalState = false,
} = {}) {
  const progressContainer = document.getElementById("progressContainer");
  if (
    !force &&
    progressContainer?.dataset.progressSource === "capture-recovery" &&
    progressContainer?.dataset.recoveryPinned === "true"
  ) {
    return;
  }
  const wasRecovery =
    progressContainer?.dataset.progressSource === "capture-recovery";
  const keepUnattendedTerminalState = Boolean(
    preserveUnattendedTerminalState ||
      progressContainer?.dataset?.unattendedProgressState === "terminal",
  );
  if (progressContainer) {
    progressContainer.style.display = "none";
    delete progressContainer.dataset.progressSource;
    if (!keepUnattendedTerminalState) {
      delete progressContainer.dataset.unattendedProgressState;
    }
  }

  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.hidden = true;
    btnCancel.disabled = true;
    btnCancel.style.display = "none";
  }
  if (wasRecovery) {
    resetCaptureRecoveryUI({hidePanel: false, clearState: true});
  }
}

function isTerminalProgressPhase(phase) {
  const normalized = String(phase || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized === "canceled" ||
    normalized === "cancelled" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "detail_batch_done" ||
    normalized === "detail_batch_canceled" ||
    normalized === "detail_batch_interrupted" ||
    normalized === "blogger_metrics_done" ||
    normalized === "blogger_metrics_failed" ||
    normalized === "batch_done" ||
    normalized === "streaming_sync_done" ||
    normalized === "sync_failed" ||
    normalized === "synced"
  );
}

function isUnattendedTerminalProgressPhase(phase) {
  const normalized = String(phase || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  // Generic done/error/failed events can belong to the current keyword,
  // detail worker or comment step.  Only the final streaming drain and phases
  // explicitly emitted by the unattended root are allowed to close the plan.
  if (normalized === "streaming_sync_done") {
    return true;
  }

  return (
    normalized.startsWith("unattended_") &&
    /(?:completed(?:_with_failures)?|failed|canceled|cancelled|needs_action)$/.test(
      normalized,
    )
  );
}

/**
 * 隐藏进度
 */
function hideProgress() {
  hideProgressPanelOnly();

  const runtime = getCurrentRuntime();
  updatePageTypeUI(runtime?.pageType || PAGE_TYPE.UNKNOWN);
}

function setCaptureButtonsDisabled(disabled) {
  const buttonIds = ["btnCaptureNote", "btnCaptureBlogger", "btnCaptureSearch"];

  buttonIds.forEach((id) => {
    const button = document.getElementById(id);
    setPrimaryCaptureButtonDisabled(button, disabled);
  });

  const checkboxCaptureComments = document.getElementById(
    "checkboxCaptureComments",
  );
  if (checkboxCaptureComments) {
    checkboxCaptureComments.disabled = disabled;
  }
  syncCommentsCaptureControls({forceDisabled: disabled});

  const inputBloggerMinLikes = document.getElementById("inputBloggerMinLikes");
  if (inputBloggerMinLikes) {
    inputBloggerMinLikes.disabled = disabled;
  }

  const inputBloggerMaxDetectedItems = document.getElementById(
    "inputBloggerMaxDetectedItems",
  );
  if (inputBloggerMaxDetectedItems) {
    inputBloggerMaxDetectedItems.disabled = disabled;
  }

  const inputKeywordMinLikes = document.getElementById("inputKeywordMinLikes");
  if (inputKeywordMinLikes) {
    inputKeywordMinLikes.disabled = disabled;
  }

  const inputKeywordMaxDetectedItems = document.getElementById(
    "inputKeywordMaxDetectedItems",
  );
  if (inputKeywordMaxDetectedItems) {
    inputKeywordMaxDetectedItems.disabled = disabled;
  }
}

// ==================== 导出 ====================

// 自动初始化
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSidebar);
} else {
  initSidebar();
}

window.addEventListener("beforeunload", () => {
  captureTaskOwnerClosing = true;
  captureTaskOwnerPort?.disconnect?.();
  captureTaskOwnerPort = null;
  stopKeywordSortSyncTimer();
  stopKeywordPlanReconcileTimer();
  stopCaptureExecutionLockHeartbeat();
});

window.addEventListener("pagehide", () => {
  stopCaptureExecutionLockHeartbeat();
});

/* ==================== 批量采集操作执行 ==================== */

async function handleRunBatchLinks() {
  const textarea = document.getElementById("textareaBatchLinks");
  if (!textarea) return;

  const btn = document.getElementById("btnRunBatchLinks");
  if (!btn) return;
  if (batchUrlCaptureInFlight) {
    if (batchUrlCaptureMode !== "links") {
      showMessage("已有批量任务执行中，请先停止当前任务", "warning");
      return;
    }
    if (batchUrlCancelRequested) {
      showMessage("正在取消批量采集...", "warning");
      return;
    }
    batchUrlCancelRequested = true;
    btn.textContent = "停止中...";
    try {
      await requestCaptureCancelSignal(activeBatchRunnerTabId);
    } catch (error) {
      console.warn("[Sidebar] Batch links cancel failed:", error);
    }
    showMessage("正在取消批量采集...", "warning");
    return;
  }

  if (batchKeywordCaptureInFlight) {
    showMessage("已有批量任务执行中，请先停止当前任务", "warning");
    return;
  }

  const urls = textarea.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    showMessage("请输入至少一个作品链接（每行一个）", "warning");
    return;
  }

  let executionLock = null;
  try {
    executionLock = await acquireCaptureExecutionLock({
      owner: "manual_batch_links_capture",
      label: "手动批量作品采集",
    });
    if (!executionLock) {
      return;
    }
    const noteBatchSettings = await resolveNoteBatchCaptureSettings();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
    batchUrlCaptureInFlight = true;
    batchUrlCancelRequested = false;
    batchUrlCaptureMode = "links";
    btn.textContent = "停止批量采集";
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-danger");
    setBatchProgressVisible("modal", true);

    const res = await batchCaptureByUrls({
      urls,
      mode: "single",
      captureParams: {
        includeComments: noteBatchSettings.includeComments,
        includeBloggerMetrics: noteBatchSettings.includeBloggerMetrics,
        enableCommentLeadsFilter: noteBatchSettings.enableCommentLeadsFilter,
        commentsMaxDetectedItems: noteBatchSettings.commentsMaxDetectedItems,
        detailNavTimeoutMs: noteBatchSettings.settings.detailNavTimeoutMs,
        profileAfterNavWaitMs: noteBatchSettings.settings.profileAfterNavWaitMs,
      },
      onProgress: (p) => updateBatchProgress(p, "modal"),
      shouldStop: () => batchUrlCancelRequested,
    });

    await refreshDataPool();
    if (res.canceled) {
      showMessage(
        `批量采集已停止：已处理 ${res.stats.processed}/${res.stats.total} 条，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
        "warning",
      );
    } else {
      showMessage(
        `批量采集完成：共 ${res.stats.total} 条，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
        res.stats.failed > 0 ? "warning" : "success",
      );
    }
  } catch (error) {
    console.error("[Batch] Links failed:", error);
    showMessage("批量采集失败: " + error.message, "error");
  } finally {
    batchUrlCaptureInFlight = false;
    batchUrlCancelRequested = false;
    batchUrlCaptureMode = "";
    activeBatchRunnerTabId = null;
    if (executionLock) {
      await releaseCaptureExecutionLock(executionLock.id);
    }
    btn.textContent = "启动批量采集";
    btn.classList.add("btn-primary");
    btn.classList.remove("btn-danger");
  }
}

async function handleRunBatchBloggers() {
  const textarea = document.getElementById("textareaBatchBloggers");
  if (!textarea) return;

  const btn = document.getElementById("btnRunBatchBloggers");
  if (!btn) return;
  if (batchUrlCaptureInFlight) {
    if (batchUrlCaptureMode !== "bloggers") {
      showMessage("已有批量任务执行中，请先停止当前任务", "warning");
      return;
    }
    if (batchUrlCancelRequested) {
      showMessage("正在取消批量采集...", "warning");
      return;
    }
    batchUrlCancelRequested = true;
    btn.textContent = "停止中...";
    try {
      await requestCaptureCancelSignal(activeBatchRunnerTabId);
    } catch (error) {
      console.warn("[Sidebar] Batch bloggers cancel failed:", error);
    }
    showMessage("正在取消批量采集...", "warning");
    return;
  }

  if (batchKeywordCaptureInFlight) {
    showMessage("已有批量任务执行中，请先停止当前任务", "warning");
    return;
  }

  const urls = textarea.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    showMessage("请输入至少一个博主 ID 或主页链接（每行一个）", "warning");
    return;
  }

  let executionLock = null;
  try {
    executionLock = await acquireCaptureExecutionLock({
      owner: "manual_batch_bloggers_capture",
      label: "手动批量博主采集",
    });
    if (!executionLock) {
      return;
    }
    const settings = resolveCurrentDetailCaptureSettings(
      await getCaptureSettings(),
    );
    if (
      settings.autoDetailCaptureAfterListCapture &&
      !ensureAuthVerifiedOrWarn({
        message: PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE,
      })
    ) {
      return;
    }
    const bloggerMinLikes = readBloggerMinLikesFromInput(
      settings.bloggerMinLikes,
    );
    const bloggerMaxDetectedItems = readBloggerMaxDetectedItemsFromInput(
      settings.bloggerMaxDetectedItems,
    );
    const bloggerKeywordFilter = readBloggerKeywordFilterFromInput();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    activeBatchRunnerTabId = tab?.id ? Number(tab.id) : null;
    batchUrlCaptureInFlight = true;
    batchUrlCancelRequested = false;
    batchUrlCaptureMode = "bloggers";
    btn.textContent = "停止批量采集";
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-danger");
    setBatchProgressVisible("modal", true);

    const res = await batchCaptureByUrls({
      urls,
      mode: "blogger_notes",
      captureParams: {
        includeBloggerProfileRecord: true,
        minLikes: bloggerMinLikes,
        maxDetectedItems: bloggerMaxDetectedItems,
        keywordFilter: bloggerKeywordFilter,
        waitMinMs: settings.sharedWaitMinMs,
        waitMaxMs: settings.sharedWaitMaxMs,
        stallTimeoutMs: settings.sharedStallTimeoutMs,
        maxDurationMs: settings.sharedMaxDurationMs,
      },
      onProgress: (p) => updateBatchProgress(p, "modal"),
      shouldStop: () => batchUrlCancelRequested,
    });

    await refreshDataPool();
    if (res.canceled) {
      showMessage(
        `批量采集已停止：已处理 ${res.stats.processed}/${res.stats.total} 个博主，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
        "warning",
      );
    } else {
      showMessage(
        `批量采集完成：共 ${res.stats.total} 个博主，成功 ${res.stats.success}，失败 ${res.stats.failed}`,
        res.stats.failed > 0 ? "warning" : "success",
      );
      await maybeRunAutoDetailCaptureAfterListCapture(settings, {
        sourceLabel: "批量博主笔记",
        recordIds: collectBatchRecordIds(res),
      });
    }
  } catch (error) {
    console.error("[Batch] Bloggers failed:", error);
    showMessage("批量采集失败: " + error.message, "error");
  } finally {
    batchUrlCaptureInFlight = false;
    batchUrlCancelRequested = false;
    batchUrlCaptureMode = "";
    activeBatchRunnerTabId = null;
    if (executionLock) {
      await releaseCaptureExecutionLock(executionLock.id);
    }
    btn.textContent = "启动批量采集";
    btn.classList.add("btn-primary");
    btn.classList.remove("btn-danger");
  }
}

let batchProgressCountdownTimer = null;
let batchProgressCountdownToken = 0;

function clearBatchProgressCountdown() {
  batchProgressCountdownToken += 1;
  if (batchProgressCountdownTimer) {
    clearInterval(batchProgressCountdownTimer);
    batchProgressCountdownTimer = null;
  }
}

function getBatchProgressElements(scope = "modal") {
  return {
    container: document.getElementById("batchProgressContainer"),
    fillEl: document.getElementById("batchProgressFill"),
    textEl: document.getElementById("batchProgressText"),
  };
}

// 弹窗内细粒度采集明细行:空则隐藏
function setBatchProgressDetail(text) {
  const el = document.getElementById("batchProgressDetail");
  if (!el) {
    return;
  }
  const t = String(text || "").trim();
  el.textContent = t;
  el.hidden = !t;
}

function setBatchProgressVisible(scope = "modal", visible = true) {
  const {container, fillEl, textEl} = getBatchProgressElements(scope);
  if (!visible) {
    clearBatchProgressCountdown();
  }
  if (container) {
    container.hidden = !visible;
  }
  if (visible && fillEl) {
    fillEl.style.width = "0%";
  }
  if (visible && textEl) {
    textEl.textContent = "准备就绪";
  }
}

function updateBatchProgress(progress, scope = "modal") {
  const {container, fillEl, textEl} = getBatchProgressElements(scope);
  clearBatchProgressCountdown();

  if (container) {
    container.hidden = false;
  }

  if (fillEl && progress.total > 0) {
    const pct = Math.round((progress.current / progress.total) * 100);
    fillEl.style.width = `${pct}%`;
  }

  if (textEl) {
    const message = String(progress.message || "执行中...");
    const remainingMs = Number(progress.remainingMs);
    const canLocalCountdown =
      Number.isFinite(remainingMs) &&
      remainingMs > 0 &&
      /秒后/.test(message);
    if (!canLocalCountdown) {
      textEl.textContent = message;
      return;
    }

    const token = batchProgressCountdownToken;
    const deadline = Date.now() + remainingMs;
    const render = () => {
      if (token !== batchProgressCountdownToken) {
        return;
      }
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      textEl.textContent = message.replace(/\d+\s*秒后/g, `${seconds} 秒后`);
      if (seconds <= 0) {
        clearBatchProgressCountdown();
      }
    };
    render();
    batchProgressCountdownTimer = setInterval(render, 1000);
  }
}
