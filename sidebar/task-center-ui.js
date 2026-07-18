/**
 * Task center UI
 * 统一聚合任务账本与升级前只读历史，并负责窄侧栏的筛选、卡片和详情抽屉。
 */

import "../utils/task-center.js";

const taskCenterItemsById = new Map();
let activeTaskCenterDetailId = "";
let taskCenterDetailReturnFocus = null;
let lastTaskCenterStatusAnnouncementKey = "";
let lastTaskCenterStatusById = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTaskCenterPlatform(platform) {
  const normalized = String(platform || "").trim().toLowerCase();
  return {
    xiaohongshu: "小红书",
    douyin: "抖音",
    weibo: "微博",
    mixed: "多平台",
  }[normalized] || "未知";
}

function getTaskCenterMonitorStatusLabel(status) {
  return {
    active: "启用中",
    paused: "已暂停",
    paused_insufficient_balance: "配额不足",
    success: "执行成功",
    completed: "执行成功",
    no_hit: "无命中",
    failed: "执行失败",
    skipped_no_balance: "配额不足跳过",
    skipped: "已跳过",
    running: "执行中",
  }[String(status || "").trim()] || "状态未知";
}

function setTextIfChanged(element, value) {
  const nextValue = String(value);
  if (element && element.textContent !== nextValue) {
    element.textContent = nextValue;
  }
}

function getTaskCenterCore() {
  const core = globalThis.OnStarvoiceTaskCenterCore;
  return core && typeof core === "object" ? core : {};
}

function readTaskField(source, ...names) {
  for (const name of names) {
    if (source && Object.prototype.hasOwnProperty.call(source, name)) {
      const value = source[name];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

function normalizeTaskCenterTimestamp(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTaskCenterStatus(value) {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  if (["running", "active", "started", "pending", "queued", "capturing", "syncing"].includes(status)) {
    return "running";
  }
  if (["recovering", "retrying", "resuming", "paused_offline", "network_recovered"].includes(status)) {
    return "recovering";
  }
  if (["needs_action", "needs_attention", "attention", "blocked", "stale", "paused", "interrupted"].includes(status)) {
    return "attention";
  }
  if (["partial", "partially_completed", "completed_with_failures", "completed_with_warnings", "warning"].includes(status)) {
    return "partial";
  }
  if (["completed", "success", "succeeded", "done", "no_hit"].includes(status)) {
    return "completed";
  }
  if (["failed", "failure", "error", "timed_out", "timeout"].includes(status)) {
    return "failed";
  }
  if (["canceled", "cancelled", "stopped", "skipped", "deferred"].includes(status)) {
    return "canceled";
  }
  return status || "completed";
}

function getTaskCenterStatusGroup(status) {
  if (status === "running" || status === "recovering") {
    return "running";
  }
  if (status === "attention" || status === "partial" || status === "failed") {
    return "attention";
  }
  return "history";
}

function getTaskCenterStatusLabel(status) {
  return {
    running: "进行中",
    recovering: "正在恢复",
    attention: "需要处理",
    partial: "部分完成",
    completed: "已完成",
    failed: "执行失败",
    canceled: "已结束",
    pending: "等待执行",
  }[status] || "已结束";
}

function normalizeTaskCenterType(value) {
  const type = String(value || "")
    .trim()
    .toLowerCase();
  if (type.includes("monitor")) return "monitor";
  if (type.includes("sync")) return "sync";
  if (type.includes("comment")) return "comment";
  if (type.includes("keyword") || type.includes("search") || type.includes("unattended")) {
    return "keyword";
  }
  return "capture";
}

function getTaskCenterTypeLabel(type) {
  return {
    capture: "采集",
    keyword: "关键词",
    comment: "评论",
    sync: "同步",
    monitor: "监控",
  }[type] || "采集";
}

function getTaskCenterTriggerLabel(value, type) {
  const trigger = String(value || "")
    .trim()
    .toLowerCase();
  if (trigger.includes("unattended") || trigger.includes("schedule") || trigger === "automatic") {
    return "定时无人值守";
  }
  if (trigger === "monitor_run_now") return "手动监控";
  if (trigger.includes("monitor")) return "后端监控";
  if (trigger === "current_page") return "当前页面";
  if (trigger === "single") return "单条手动";
  if (trigger === "manual") return "手动";
  if (type === "monitor") return "后端执行";
  if (type === "sync") return "批量同步";
  return "手动";
}

function normalizeTaskCenterCounts(source, progress = {}) {
  const counts =
    source?.counts && typeof source.counts === "object" ? source.counts : {};
  const number = (...names) => {
    const raw = readTaskField(counts, ...names) ?? readTaskField(source, ...names);
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    saved: number("saved", "savedCount", "saved_count", "capturedCount", "captured_count"),
    success: number("success", "successCount", "success_count", "completedCount", "completed_count"),
    failed: number("failed", "failedCount", "failed_count"),
    skipped: number("skipped", "skippedCount", "skipped_count"),
    total: number("total", "totalCount", "total_count") || Number(progress.total || 0),
  };
}

function normalizeTaskCenterProgress(source) {
  const progress =
    source?.progress && typeof source.progress === "object"
      ? source.progress
      : source?.lastRunProgress && typeof source.lastRunProgress === "object"
        ? source.lastRunProgress
        : {};
  const current = Number(readTaskField(progress, "current", "currentIndex", "current_index") || 0);
  const total = Number(readTaskField(progress, "total", "totalCount", "total_count") || 0);
  const explicitPercent = Number(readTaskField(progress, "percent", "percentage"));
  const percent = Number.isFinite(explicitPercent)
    ? Math.max(0, Math.min(100, explicitPercent))
    : total > 0
      ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
      : 0;
  const checkpoint =
    source?.checkpoint && typeof source.checkpoint === "object"
      ? source.checkpoint
      : {};
  return {
    current: Number.isFinite(current) && current >= 0 ? current : 0,
    total: Number.isFinite(total) && total >= 0 ? total : 0,
    percent,
    keyword: String(
      readTaskField(progress, "keyword", "currentKeyword", "current_keyword") ||
        checkpoint.currentKeyword ||
        "",
    ).trim(),
    phase: String(
      readTaskField(progress, "phase", "stage") || checkpoint.phase || "",
    ).trim(),
    message: String(readTaskField(progress, "message", "lastMessage", "last_message") || "").trim(),
    updatedAt: normalizeTaskCenterTimestamp(
      readTaskField(progress, "updatedAt", "updated_at", "lastBusinessProgressAt", "last_business_progress_at"),
    ),
  };
}

export function normalizeTaskCenterItem(source, index = 0) {
  const raw = source && typeof source === "object" ? source : {};
  const type = normalizeTaskCenterType(
    readTaskField(raw, "type", "taskType", "task_type", "kind", "source"),
  );
  const status = normalizeTaskCenterStatus(
    readTaskField(raw, "status", "runStatus", "run_status", "lastRunStatus", "last_run_status"),
  );
  const progress = normalizeTaskCenterProgress(raw);
  const startedAt = normalizeTaskCenterTimestamp(
    readTaskField(raw, "startedAt", "started_at", "createdAt", "created_at", "scheduledAt", "scheduled_at"),
  );
  const finishedAt = normalizeTaskCenterTimestamp(
    readTaskField(raw, "finishedAt", "finished_at", "completedAt", "completed_at", "endedAt", "ended_at"),
  );
  const updatedAt = normalizeTaskCenterTimestamp(
    readTaskField(raw, "updatedAt", "updated_at", "heartbeatAt", "heartbeat_at"),
  );
  const id = String(
    readTaskField(raw, "id", "runId", "run_id", "requestId", "request_id", "batchId", "batch_id") ||
      `task-${type}-${startedAt || finishedAt || updatedAt || index}-${index}`,
  );
  const platform = String(readTaskField(raw, "platform", "platformId", "platform_id") || "unknown")
    .trim()
    .toLowerCase();
  const trigger = readTaskField(raw, "trigger", "triggerType", "trigger_type", "source");
  const name = String(
    readTaskField(raw, "name", "title", "taskName", "task_name", "displayName", "display_name") ||
      `${getTaskCenterTypeLabel(type)}任务`,
  ).trim();
  const lastProgressAt =
    normalizeTaskCenterTimestamp(
      readTaskField(
        raw,
        "businessProgressAt",
        "business_progress_at",
        "lastBusinessProgressAt",
        "last_business_progress_at",
        "lastProgressAt",
        "last_progress_at",
      ),
    ) || progress.updatedAt;
  let errorValue = readTaskField(
    raw,
    "lastError",
    "last_error",
    "errorMessage",
    "error_message",
    "error",
  );
  if (!errorValue && ["attention", "partial", "failed"].includes(status)) {
    errorValue = readTaskField(raw, "lastRunMessage", "last_run_message");
  }
  const error =
    errorValue && typeof errorValue === "object"
      ? [errorValue.message, errorValue.reason, errorValue.code]
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .join(" · ")
      : String(errorValue || "").trim();
  return {
    id,
    actionTaskId: String(
      readTaskField(raw, "controlTaskId", "control_task_id", "requestId", "request_id") || id,
    ),
    type,
    status,
    statusGroup: getTaskCenterStatusGroup(status),
    name,
    platform: platform || "unknown",
    trigger: String(trigger || ""),
    triggerLabel: getTaskCenterTriggerLabel(trigger, type),
    startedAt,
    finishedAt,
    updatedAt,
    lastProgressAt,
    progress,
    counts: normalizeTaskCenterCounts(raw, progress),
    error,
    legacy: Boolean(raw.legacy || raw.isLegacy || raw.is_legacy),
    incomplete: Boolean(raw.incomplete || raw.isIncomplete || raw.is_incomplete),
    timeline: Array.isArray(raw.timeline)
      ? raw.timeline
      : Array.isArray(raw.events)
        ? raw.events
        : Array.isArray(raw.history)
          ? raw.history
          : [],
    keywords: normalizeTaskCenterKeywords(raw, progress),
    raw,
  };
}

function normalizeTaskCenterKeywords(source, progress) {
  const toStringSet = (value) =>
    new Set((Array.isArray(value) ? value : []).map((item) => String(item)));
  const checkpoint =
    source?.checkpoint && typeof source.checkpoint === "object"
      ? source.checkpoint
      : {};
  const completed = toStringSet(
    source?.completedKeywords || source?.completed_keywords || checkpoint.completedKeywords,
  );
  const failed = toStringSet(
    source?.failedKeywords || source?.failed_keywords || checkpoint.failedKeywords,
  );
  const skipped = toStringSet(
    source?.skippedKeywords || source?.skipped_keywords || checkpoint.skippedKeywords,
  );
  const checkpointKeywords = [...new Set([...completed, ...failed, ...skipped])];
  if (progress.keyword && !checkpointKeywords.includes(progress.keyword)) {
    checkpointKeywords.push(progress.keyword);
  }
  const rawKeywords =
    (Array.isArray(source?.keywordStates) && source.keywordStates) ||
    (Array.isArray(source?.keyword_states) && source.keyword_states) ||
    (Array.isArray(checkpoint.keywordResults) && checkpoint.keywordResults) ||
    (Array.isArray(source?.keywords) && source.keywords) ||
    (Array.isArray(source?.metadata?.keywords) && source.metadata.keywords) ||
    checkpointKeywords ||
    [];
  return rawKeywords.slice(0, 200).map((item) => {
    const keyword = String(
      item && typeof item === "object"
        ? readTaskField(item, "keyword", "name", "value") || ""
        : item,
    ).trim();
    const rawStatus =
      item && typeof item === "object"
        ? String(readTaskField(item, "status", "state") || "").trim().toLowerCase()
        : "";
    let status = rawStatus === "pending" || rawStatus === "queued"
      ? "pending"
      : rawStatus
        ? normalizeTaskCenterStatus(rawStatus)
        : "";
    if (!status) {
      if (failed.has(keyword)) status = "failed";
      else if (skipped.has(keyword)) status = "canceled";
      else if (completed.has(keyword)) status = "completed";
      else if (keyword && keyword === progress.keyword) status = "running";
      else status = "pending";
    }
    return {keyword, status};
  }).filter((item) => item.keyword);
}

function normalizeMonitorExecutionEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  return {
    ...source,
    id: readTaskField(source, "id", "executionId", "execution_id"),
    batchId: readTaskField(source, "batchId", "batch_id"),
    subscriptionId: readTaskField(source, "subscriptionId", "subscription_id"),
    bloggerName: readTaskField(source, "bloggerName", "blogger_name"),
    bloggerUrl: readTaskField(source, "bloggerUrl", "blogger_url"),
    startedAt: readTaskField(source, "startedAt", "started_at"),
    finishedAt: readTaskField(source, "finishedAt", "finished_at"),
    hitCount: readTaskField(source, "hitCount", "hit_count"),
    scannedCount: readTaskField(source, "scannedCount", "scanned_count"),
    costCredits: readTaskField(source, "costCredits", "cost_credits"),
    errorMessage: readTaskField(source, "errorMessage", "error_message"),
  };
}

export function extractMonitorExecutionEntries(monitorConfig) {
  const source = monitorConfig && typeof monitorConfig === "object" ? monitorConfig : {};
  const candidates = [
    source.executions,
    source.data?.executions,
    source.data?.items,
    source.result?.executions,
    source.result?.data?.executions,
    source.result?.items,
    source.result?.data?.items,
  ];
  const entries = candidates.find(Array.isArray) || [];
  return entries.map(normalizeMonitorExecutionEntry);
}

function buildFallbackLegacyTaskItems({syncEntries, monitorExecutions, plan, request}) {
  const items = [];
  syncEntries.forEach((entry, index) => {
    const isMonitor = String(entry?.trigger || "") === "monitor_run_now";
    const failed = Number(readTaskField(entry, "failedCount", "failed_count") || 0);
    const skipped = Number(readTaskField(entry, "skippedCount", "skipped_count") || 0);
    items.push({
      ...entry,
      id: entry?.id || `legacy-${isMonitor ? "monitor" : "sync"}-${index}`,
      type: isMonitor ? "monitor" : "sync",
      name: isMonitor
        ? String(entry?.monitorBloggerName || "监控立即执行")
        : "数据同步",
      status: failed > 0 ? "failed" : skipped > 0 ? "partial" : "completed",
      startedAt: entry?.startedAt || entry?.createdAt || entry?.finishedAt,
      legacy: true,
      incomplete: true,
    });
  });

  const monitorGroups = new Map();
  monitorExecutions.forEach((entry, index) => {
    const key = String(entry?.batchId || entry?.id || `monitor-${index}`);
    if (!monitorGroups.has(key)) monitorGroups.set(key, []);
    monitorGroups.get(key).push(entry);
  });
  for (const [key, group] of monitorGroups) {
    const first = group[0] || {};
    const failedCount = group.filter((entry) =>
      ["failed", "error"].includes(String(entry?.status || "")),
    ).length;
    const successCount = group.length - failedCount;
    items.push({
      id: `legacy-monitor-${key}`,
      type: "monitor",
      name: group.length > 1 ? `博主监控批次（${group.length} 个账号）` : String(first.bloggerName || "博主监控"),
      status: failedCount === group.length ? "failed" : failedCount > 0 ? "partial" : "completed",
      platform: first.platform || "unknown",
      trigger: "monitor_backend",
      startedAt: first.startedAt,
      finishedAt: group.reduce((latest, entry) => {
        const time = normalizeTaskCenterTimestamp(entry?.finishedAt || entry?.startedAt);
        return time > normalizeTaskCenterTimestamp(latest) ? entry?.finishedAt || entry?.startedAt : latest;
      }, ""),
      counts: {
        saved: group.reduce((sum, entry) => sum + Number(entry?.hitCount || 0), 0),
        success: successCount,
        failed: failedCount,
        total: group.length,
      },
      timeline: group.map((entry) => ({
        at: entry.finishedAt || entry.startedAt,
        message: `${entry.bloggerName || "监控账号"}：${getTaskCenterMonitorStatusLabel(entry.status)}`,
      })),
      error: group.map((entry) => entry?.errorMessage).filter(Boolean).join("\n"),
      legacy: true,
      incomplete: true,
    });
  }

  const unattendedSource = request || (plan?.lastRunStatus ? plan : null);
  if (unattendedSource) {
    items.push({
      ...unattendedSource,
      id: unattendedSource.id || unattendedSource.requestId || `legacy-unattended-${plan?.lastRunAt || "latest"}`,
      type: "keyword",
      name: "无人值守关键词采集",
      status: unattendedSource.status || plan?.lastRunStatus,
      platform: unattendedSource.platform || plan?.platform || "unknown",
      trigger: "unattended",
      startedAt: unattendedSource.startedAt || unattendedSource.createdAt || plan?.lastRunAt,
      finishedAt: unattendedSource.finishedAt,
      progress: unattendedSource.progress || plan?.lastRunProgress,
      keywords: unattendedSource.keywords || plan?.keywords || [],
      error: unattendedSource.error || plan?.lastRunMessage || "",
      legacy: true,
      incomplete: true,
    });
  }
  return items;
}

export function buildTaskCenterItems({
  ledgerState = {runs: []},
  historyConfig = {entries: []},
  monitorConfig = {},
  legacyState = {},
} = {}) {
  const core = getTaskCenterCore();
  let ledgerRuns = Array.isArray(ledgerState.runs) ? ledgerState.runs : [];
  if (typeof core.normalizeTaskLedger === "function") {
    try {
      const normalized = core.normalizeTaskLedger(ledgerState);
      ledgerRuns = Array.isArray(normalized)
        ? normalized
        : Array.isArray(normalized?.runs)
          ? normalized.runs
          : ledgerRuns;
    } catch (error) {
      console.warn("[TaskCenter] normalize ledger failed:", error);
    }
  }

  const syncEntries = Array.isArray(historyConfig.entries) ? historyConfig.entries : [];
  const monitorExecutions = extractMonitorExecutionEntries(monitorConfig);
  let legacyItems = [];
  if (typeof core.buildLegacyTaskCenterItems === "function") {
    try {
      const result = core.buildLegacyTaskCenterItems({
        syncEntries,
        monitorExecutions,
        plan: legacyState.plan,
        request: legacyState.request,
      });
      legacyItems = Array.isArray(result)
        ? result
        : Array.isArray(result?.items)
          ? result.items
          : [];
      legacyItems = legacyItems.map((item) => {
        const taskType = String(item?.taskType || item?.type || "");
        if (taskType.includes("unattended")) {
          return {
            ...item,
            controlTaskId:
              legacyState.request?.id || legacyState.request?.requestId || item.id,
            keywords: Array.isArray(item?.keywords)
              ? item.keywords
              : Array.isArray(legacyState.plan?.keywords)
                ? legacyState.plan.keywords
                : [],
          };
        }
        return item;
      });
    } catch (error) {
      console.warn("[TaskCenter] build legacy items failed:", error);
    }
  }
  if (legacyItems.length === 0) {
    legacyItems = buildFallbackLegacyTaskItems({
      syncEntries,
      monitorExecutions,
      plan: legacyState.plan,
      request: legacyState.request,
    });
  }

  const normalizedLedger = ledgerRuns.map(normalizeTaskCenterItem);
  const clearedAt = normalizeTaskCenterTimestamp(ledgerState.clearedAt);
  const activeLegacyRequestId = String(
    legacyState.request?.id || legacyState.request?.requestId || "",
  ).trim();
  const normalizedLegacy = legacyItems
    .map(normalizeTaskCenterItem)
    .filter((legacyItem) => {
      const legacyTime =
        legacyItem.finishedAt || legacyItem.updatedAt || legacyItem.startedAt;
      if (
        clearedAt &&
        (!legacyTime || legacyTime <= clearedAt)
      ) {
        return false;
      }
      if (
        activeLegacyRequestId &&
        legacyItem.type === "keyword" &&
        normalizedLedger.some((run) => run.id === activeLegacyRequestId)
      ) {
        return false;
      }
      if (legacyItem.type !== "sync") return true;
      return !normalizedLedger.some((run) => {
        if (run.type !== "sync" || !legacyTime) return false;
        const compatiblePlatform =
          run.platform === legacyItem.platform ||
          run.platform === "unknown" ||
          legacyItem.platform === "unknown" ||
          run.platform === "mixed" ||
          legacyItem.platform === "mixed";
        if (!compatiblePlatform) return false;
        const start = run.startedAt || run.updatedAt || run.finishedAt;
        const end = run.finishedAt || run.updatedAt || start;
        return legacyTime >= start - 15000 && legacyTime <= end + 15000;
      });
    });
  const normalized = [...normalizedLedger, ...normalizedLegacy];
  const byId = new Map();
  for (const item of normalized) {
    const existing = byId.get(item.id);
    if (!existing || (item.updatedAt || item.finishedAt) > (existing.updatedAt || existing.finishedAt)) {
      byId.set(item.id, item);
    }
  }
  return Array.from(byId.values()).map((item) => ({
    ...item,
    canControlKeywordRun: Boolean(
      activeLegacyRequestId &&
        item.type === "keyword" &&
        (item.id === activeLegacyRequestId ||
          item.actionTaskId === activeLegacyRequestId),
    ),
  })).sort((left, right) => {
    const groupPriority = {running: 0, attention: 1, history: 2};
    const groupDiff = groupPriority[left.statusGroup] - groupPriority[right.statusGroup];
    if (groupDiff !== 0) return groupDiff;
    const leftTime = left.updatedAt || left.finishedAt || left.startedAt;
    const rightTime = right.updatedAt || right.finishedAt || right.startedAt;
    return rightTime - leftTime;
  });
}

function getTaskCenterFilters() {
  return {
    status: String(document.getElementById("taskCenterStatusFilter")?.value || "all"),
    type: String(document.getElementById("taskCenterTypeFilter")?.value || "all"),
    platform: String(document.getElementById("taskCenterPlatformFilter")?.value || "all"),
    time: String(document.getElementById("taskCenterTimeFilter")?.value || "all"),
  };
}

function taskCenterItemMatchesFilters(item, filters) {
  if (filters.status !== "all" && item.statusGroup !== filters.status) return false;
  if (filters.type !== "all" && item.type !== filters.type) return false;
  if (filters.platform !== "all" && item.platform !== filters.platform) return false;
  if (filters.time === "all") return true;
  const taskTime = item.finishedAt || item.updatedAt || item.startedAt;
  if (!taskTime) return false;
  const now = new Date();
  let threshold = 0;
  if (filters.time === "today") {
    threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  } else if (filters.time === "7d") {
    threshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
  } else if (filters.time === "30d") {
    threshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
  }
  return taskTime >= threshold;
}

function formatTaskCenterTime(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN");
}

function formatTaskCenterDuration(item) {
  const end = item.finishedAt || (item.statusGroup === "running" ? Date.now() : item.updatedAt);
  if (!item.startedAt || !end || end < item.startedAt) return "耗时未知";
  const seconds = Math.max(0, Math.round((end - item.startedAt) / 1000));
  if (seconds < 60) return `耗时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `耗时 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `耗时 ${hours} 小时${restMinutes ? ` ${restMinutes} 分钟` : ""}`;
}

function formatTaskCenterRelativeTime(value) {
  if (!value) return "暂无业务进展时间";
  const delta = Math.max(0, Date.now() - value);
  if (delta < 60 * 1000) return "刚刚有业务进展";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 60) return `${minutes} 分钟前有业务进展`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前有业务进展`;
  return `${Math.floor(hours / 24)} 天前有业务进展`;
}

function renderTaskCenterCountChips(counts) {
  const chips = [];
  if (counts.saved > 0) chips.push(`已保存 ${counts.saved}`);
  if (counts.success > 0) chips.push(`成功 ${counts.success}`);
  if (counts.failed > 0) chips.push(`失败 ${counts.failed}`);
  if (counts.skipped > 0) chips.push(`跳过 ${counts.skipped}`);
  if (chips.length === 0 && counts.total > 0) chips.push(`共 ${counts.total}`);
  return chips
    .map((label) => `<span class="task-center-count-chip">${escapeHtml(label)}</span>`)
    .join("");
}

function getTaskCenterActions(item) {
  if (item.type === "monitor" || (item.legacy && item.type !== "keyword")) {
    return [];
  }
  const rawTaskType = String(
    item?.raw?.taskType || item?.raw?.type || item?.raw?.featureKey || "",
  ).toLowerCase();
  const isUnattendedKeyword =
    item.type === "keyword" &&
    (rawTaskType.includes("unattended") ||
      String(item.trigger || "").toLowerCase().includes("unattended") ||
      String(item.trigger || "").toLowerCase().includes("schedule"));
  if (
    item.type === "keyword" &&
    (isUnattendedKeyword || ["attention", "failed", "partial"].includes(item.status)) &&
    !item.canControlKeywordRun
  ) {
    // 后台只允许控制当前 request；旧任务保留为只读，避免按钮必然 not_found。
    return [];
  }
  if (
    ["attention", "failed", "partial"].includes(item.status) &&
    isTaskCenterCircuitBreaker(item)
  ) {
    return item.type === "keyword"
      ? [{id: "keep_results", label: "结束并保留"}]
      : [];
  }
  if (item.status === "running" || item.status === "recovering") {
    return [{id: "stop_keep", label: "停止并保留"}];
  }
  if (item.status === "attention") {
    if (item.type !== "keyword") return [];
    return [
      {id: "resume_remaining", label: "继续剩余任务", primary: true},
      {id: "skip_current", label: "跳过当前项"},
      {id: "keep_results", label: "结束并保留"},
    ];
  }
  if (item.status === "failed" || item.status === "partial") {
    if (item.type !== "keyword") return [];
    return [
      {id: "retry_failed", label: "仅重试失败项", primary: true},
      {id: "keep_results", label: "保留结果"},
    ];
  }
  if (item.status === "completed") {
    return item.legacy || item.type !== "keyword"
      ? []
      : [{id: "view_results", label: "查看采集结果"}];
  }
  return [];
}

function isTaskCenterCircuitBreaker(item) {
  if (
    item?.raw?.requiresManualIntervention === true ||
    item?.raw?.requires_manual_intervention === true ||
    item?.raw?.circuitBreaker === true ||
    item?.raw?.circuit_breaker === true
  ) {
    return true;
  }
  const text = [
    item?.error,
    item?.raw?.message,
    item?.raw?.error?.code,
    item?.raw?.error?.message,
    item?.raw?.error?.reason,
    item?.raw?.metadata?.reason,
  ]
    .map((value) => String(value || ""))
    .join(" ")
    .toLowerCase();
  return /验证码|人机验证|登录失效|请(?:先|重新)?登录|需要登录|账号异常|账号限制|安全限制|安全验证|访问受限|风控|captcha|login[_\s-]?required|auth[_\s-]?required|account[_\s-]?(?:forbidden|restricted)|security[_\s-]?(?:block|check)|risk[_\s-]?control/.test(text);
}

function renderTaskCenterActions(item, limit = Infinity) {
  return getTaskCenterActions(item)
    .slice(0, limit)
    .map(
      (action) => `<button
        class="${action.primary ? "btn btn-primary" : "task-center-card-action"}"
        type="button"
        data-task-action="${escapeHtml(action.id)}"
        data-task-id="${escapeHtml(item.actionTaskId)}"
        data-task-ref-id="${escapeHtml(item.id)}">${escapeHtml(action.label)}</button>`,
    )
    .join("");
}

function renderTaskCenterCard(item) {
  const progress = item.progress;
  const progressLabel = progress.keyword || progress.message || progress.phase || "执行进度";
  const progressCount = progress.total > 0 ? `${progress.current}/${progress.total}` : `${progress.percent}%`;
  const shouldShowProgress = progress.total > 0 || progress.percent > 0 || Boolean(progressLabel !== "执行进度");
  const actions = renderTaskCenterActions(item, 2);
  const ariaSummary = [
    `查看${item.name}详情`,
    `状态${getTaskCenterStatusLabel(item.status)}`,
    item.counts.saved > 0 ? `已保存${item.counts.saved}` : "",
    item.counts.success > 0 ? `成功${item.counts.success}` : "",
    item.counts.failed > 0 ? `失败${item.counts.failed}` : "",
    progress.total > 0 ? `进度${progress.current}/${progress.total}` : "",
  ].filter(Boolean).join("，");
  return `
    <article class="task-center-card is-${escapeHtml(item.status)}" data-task-id="${escapeHtml(item.id)}">
      <button
        class="task-center-card-open"
        type="button"
        data-task-open="${escapeHtml(item.id)}"
        aria-label="${escapeHtml(ariaSummary)}">
        <div class="task-center-card-head">
          <span class="task-center-card-title">${escapeHtml(item.name)}</span>
          <span class="task-center-status-badge is-${escapeHtml(item.status)}">${escapeHtml(getTaskCenterStatusLabel(item.status))}</span>
        </div>
        <div class="task-center-card-meta">
          <span>${escapeHtml(getTaskCenterTypeLabel(item.type))}</span>
          <span>${escapeHtml(formatTaskCenterPlatform(item.platform))}</span>
          <span>${escapeHtml(item.triggerLabel)}</span>
          <span>${escapeHtml(formatTaskCenterTime(item.startedAt || item.finishedAt))}</span>
        </div>
        ${
          shouldShowProgress
            ? `<div class="task-center-card-progress">
                <div class="task-center-progress-copy">
                  <span>${escapeHtml(progressLabel)}</span>
                  <span>${escapeHtml(progressCount)}</span>
                </div>
                <div class="task-center-progress-track" aria-hidden="true">
                  <span class="task-center-progress-bar" style="width:${progress.percent}%"></span>
                </div>
              </div>`
            : ""
        }
        <div class="task-center-card-foot">
          <div class="task-center-card-counts">${renderTaskCenterCountChips(item.counts)}</div>
          <div class="task-center-card-tags">
            ${item.legacy ? '<span class="task-center-card-tag is-legacy">旧版记录</span>' : ""}
            ${item.incomplete ? '<span class="task-center-card-tag">信息不完整</span>' : ""}
          </div>
        </div>
        <div class="task-center-card-last-progress">${escapeHtml(formatTaskCenterRelativeTime(item.lastProgressAt))} · ${escapeHtml(formatTaskCenterDuration(item))}</div>
      </button>
      ${actions ? `<div class="task-center-card-actions">${actions}</div>` : ""}
    </article>`;
}

export function renderTaskCenterPanel(state = {}) {
  const stats = document.getElementById("syncHistoryStatsText");
  const empty = document.getElementById("syncHistoryEmpty");
  const list = document.getElementById("syncHistoryList");
  if (!stats || !empty || !list) return;

  const allItems = buildTaskCenterItems({
    ledgerState: state.taskLedger || window.getSidebarTaskLedgerState?.() || {runs: []},
    historyConfig: state.syncHistory || window.getSidebarSyncHistoryState?.() || {entries: []},
    monitorConfig: state.monitor || window.getSidebarMonitorState?.() || {},
    legacyState: state.legacy || window.getSidebarTaskCenterLegacyState?.() || {},
  });
  taskCenterItemsById.clear();
  allItems.forEach((item) => taskCenterItemsById.set(item.id, item));
  const counts = allItems.reduce(
    (result, item) => ({...result, [item.statusGroup]: result[item.statusGroup] + 1}),
    {running: 0, attention: 0, history: 0},
  );
  const filters = getTaskCenterFilters();
  const filteredItems = allItems.filter((item) => taskCenterItemMatchesFilters(item, filters));

  const runningCount = document.getElementById("taskCenterRunningCount");
  const attentionCount = document.getElementById("taskCenterAttentionCount");
  const historyCount = document.getElementById("taskCenterHistoryCount");
  setTextIfChanged(runningCount, counts.running);
  setTextIfChanged(attentionCount, counts.attention);
  setTextIfChanged(historyCount, counts.history);
  const statusLive = document.getElementById("taskCenterStatusLive");
  const nextTaskCenterStatusById = new Map(
    allItems.map((item) => [item.id, item.status]),
  );
  const statusAnnouncementKey = JSON.stringify(
    Array.from(nextTaskCenterStatusById.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  if (
    statusLive &&
    statusAnnouncementKey !== lastTaskCenterStatusAnnouncementKey
  ) {
    const changedItems = allItems.filter((item) => {
      const previousStatus = lastTaskCenterStatusById.get(item.id);
      return previousStatus && previousStatus !== item.status;
    });
    const changeSummary = changedItems
      .slice(0, 3)
      .map(
        (item) =>
          `${item.name}变为${getTaskCenterStatusLabel(item.status)}`,
      )
      .join("，");
    lastTaskCenterStatusAnnouncementKey = statusAnnouncementKey;
    lastTaskCenterStatusById = nextTaskCenterStatusById;
    statusLive.textContent = `任务状态更新：${changeSummary ? `${changeSummary}。` : ""}进行中 ${counts.running} 个，需处理 ${counts.attention} 个，历史 ${counts.history} 个`;
  }
  document.querySelectorAll("[data-task-summary-filter]").forEach((button) => {
    const selected = filters.status === button.dataset.taskSummaryFilter;
    const count = counts[button.dataset.taskSummaryFilter] || 0;
    const label = {
      running: "进行中",
      attention: "需处理",
      history: "历史",
    }[button.dataset.taskSummaryFilter] || "任务";
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    button.setAttribute("aria-label", `筛选${label}任务，${count} 个`);
  });

  const detailModal = document.getElementById("taskCenterDetailModal");
  if (activeTaskCenterDetailId && detailModal?.classList.contains("is-active")) {
    const activeDetailItem = taskCenterItemsById.get(activeTaskCenterDetailId);
    if (activeDetailItem) {
      const detailActions = document.getElementById("taskCenterDetailActions");
      const focusWasInActions = detailActions?.contains(document.activeElement);
      const focusedDetailAction = focusWasInActions
        ? String(document.activeElement?.dataset?.taskAction || "")
        : "";
      renderTaskCenterDetail(activeDetailItem);
      if (focusWasInActions) {
        requestAnimationFrame(() => {
          const stillValidAction = focusedDetailAction
            ? document
                .getElementById("taskCenterDetailActions")
                ?.querySelector(
                  `[data-task-action="${CSS.escape(focusedDetailAction)}"]`,
                )
            : null;
          (stillValidAction || document.getElementById("btnTaskCenterDetailDone"))
            ?.focus();
        });
      }
    } else {
      closeTaskCenterDetail();
    }
  }

  const statsText =
    filteredItems.length === allItems.length
      ? `共 ${allItems.length} 个任务`
      : `显示 ${filteredItems.length} / ${allItems.length} 个任务`;
  setTextIfChanged(stats, statsText);
  if (filteredItems.length === 0) {
    empty.style.display = "block";
    list.style.display = "none";
    list.innerHTML = "";
    return;
  }
  empty.style.display = "none";
  list.style.display = "flex";
  const activeElement = document.activeElement;
  const focusedTaskId =
    activeElement instanceof Element && list.contains(activeElement)
      ? String(activeElement.dataset.taskId || activeElement.dataset.taskOpen || "")
      : "";
  const focusedAction =
    activeElement instanceof Element
      ? String(activeElement.dataset.taskAction || "")
      : "";
  const nextHtml = filteredItems.map(renderTaskCenterCard).join("");
  if (list.innerHTML !== nextHtml) {
    list.innerHTML = nextHtml;
    if (focusedTaskId) {
      const selector = focusedAction
        ? `[data-task-action="${CSS.escape(focusedAction)}"][data-task-id="${CSS.escape(focusedTaskId)}"]`
        : `[data-task-open="${CSS.escape(focusedTaskId)}"]`;
      list.querySelector(selector)?.focus();
    }
  }
}

function normalizeTaskCenterTimeline(item) {
  const events = item.timeline.map((event) => {
    const source = event && typeof event === "object" ? event : {message: event};
    return {
      at: normalizeTaskCenterTimestamp(readTaskField(source, "at", "time", "timestamp", "createdAt", "created_at")),
      message: String(readTaskField(source, "message", "label", "title", "event") || "任务状态更新"),
    };
  });
  if (events.length === 0 && item.startedAt) {
    events.push({at: item.startedAt, message: "任务开始"});
  }
  if (item.finishedAt) {
    events.push({at: item.finishedAt, message: getTaskCenterStatusLabel(item.status)});
  } else if (item.lastProgressAt && item.lastProgressAt !== item.startedAt) {
    events.push({at: item.lastProgressAt, message: item.progress.message || "最后一次业务进展"});
  }
  return events
    .filter((event) => event.message)
    .sort((left, right) => left.at - right.at)
    .slice(-100);
}

function renderTaskCenterDetail(item) {
  const status = document.getElementById("taskCenterDetailStatus");
  const title = document.getElementById("taskCenterDetailTitle");
  const subtitle = document.getElementById("taskCenterDetailSubtitle");
  const overview = document.getElementById("taskCenterDetailOverview");
  const progressSection = document.getElementById("taskCenterDetailProgressSection");
  const progressContainer = document.getElementById("taskCenterDetailProgress");
  const timelineSection = document.getElementById("taskCenterDetailTimelineSection");
  const timelineContainer = document.getElementById("taskCenterDetailTimeline");
  const keywordsSection = document.getElementById("taskCenterDetailKeywordsSection");
  const keywordsContainer = document.getElementById("taskCenterDetailKeywords");
  const errorSection = document.getElementById("taskCenterDetailErrorSection");
  const errorContainer = document.getElementById("taskCenterDetailError");
  const incomplete = document.getElementById("taskCenterDetailIncomplete");
  const actions = document.getElementById("taskCenterDetailActions");
  if (!status || !title || !subtitle || !overview || !actions) return;

  status.className = `task-center-status-badge is-${item.status}`;
  status.textContent = getTaskCenterStatusLabel(item.status);
  title.textContent = item.name;
  subtitle.textContent = `${getTaskCenterTypeLabel(item.type)} · ${formatTaskCenterPlatform(item.platform)} · ${item.triggerLabel}`;
  const stats = [
    ["开始时间", formatTaskCenterTime(item.startedAt)],
    ["耗时", formatTaskCenterDuration(item).replace(/^耗时\s*/, "")],
    ["最后业务进展", formatTaskCenterRelativeTime(item.lastProgressAt)],
    ["任务编号", item.id],
  ];
  overview.innerHTML = stats
    .map(
      ([label, value]) => `<div class="task-center-detail-stat">
        <span class="task-center-detail-stat-label">${escapeHtml(label)}</span>
        <span class="task-center-detail-stat-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
      </div>`,
    )
    .join("");

  const hasProgress = item.progress.total > 0 || item.progress.percent > 0 || item.progress.message || item.progress.keyword;
  if (progressSection && progressContainer) {
    progressSection.hidden = !hasProgress;
    progressContainer.innerHTML = hasProgress
      ? `<div class="task-center-detail-progress-copy">${escapeHtml(item.progress.message || item.progress.keyword || item.progress.phase || "任务执行中")}</div>
         <div class="task-center-card-progress">
           <div class="task-center-progress-copy"><span>${escapeHtml(item.progress.keyword || item.progress.phase || "总体进度")}</span><span>${item.progress.total > 0 ? `${item.progress.current}/${item.progress.total}` : `${item.progress.percent}%`}</span></div>
           <div class="task-center-progress-track"><span class="task-center-progress-bar" style="width:${item.progress.percent}%"></span></div>
         </div>
         <div class="task-center-detail-counts">${renderTaskCenterCountChips(item.counts)}</div>`
      : "";
  }

  const timeline = normalizeTaskCenterTimeline(item);
  if (timelineSection && timelineContainer) {
    timelineSection.hidden = timeline.length === 0;
    timelineContainer.innerHTML = timeline
      .map(
        (event) => `<li class="task-center-timeline-item">
          <time class="task-center-timeline-time">${escapeHtml(event.at ? new Date(event.at).toLocaleString("zh-CN", {month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"}) : "时间未知")}</time>
          <span>${escapeHtml(event.message)}</span>
        </li>`,
      )
      .join("");
  }

  if (keywordsSection && keywordsContainer) {
    keywordsSection.hidden = item.keywords.length === 0;
    keywordsContainer.innerHTML = item.keywords
      .map(
        (keyword) => `<div class="task-center-keyword-item">
          <span title="${escapeHtml(keyword.keyword)}">${escapeHtml(keyword.keyword)}</span>
          <span class="task-center-status-badge is-${escapeHtml(keyword.status)}">${escapeHtml(getTaskCenterStatusLabel(keyword.status))}</span>
        </div>`,
      )
      .join("");
  }

  if (errorSection && errorContainer) {
    errorSection.hidden = !item.error;
    errorContainer.textContent = item.error;
  }
  if (incomplete) incomplete.hidden = !(item.legacy || item.incomplete);
  actions.innerHTML = `${renderTaskCenterActions(item)}<button class="btn btn-secondary" id="btnTaskCenterDetailDone" type="button">关闭</button>`;
}

function closeTaskCenterDetail() {
  const modal = document.getElementById("taskCenterDetailModal");
  if (!modal) return;
  modal.classList.remove("is-active");
  modal.setAttribute("aria-hidden", "true");
  activeTaskCenterDetailId = "";
  if (taskCenterDetailReturnFocus instanceof HTMLElement && taskCenterDetailReturnFocus.isConnected) {
    taskCenterDetailReturnFocus.focus();
  }
  taskCenterDetailReturnFocus = null;
}

function openTaskCenterDetail(taskId, trigger) {
  const item = taskCenterItemsById.get(String(taskId || ""));
  const modal = document.getElementById("taskCenterDetailModal");
  if (!item || !modal) return;
  activeTaskCenterDetailId = item.id;
  taskCenterDetailReturnFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  renderTaskCenterDetail(item);
  modal.classList.add("is-active");
  modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => document.getElementById("btnCloseTaskCenterDetail")?.focus());
}

function dispatchTaskCenterAction(button) {
  const referenceId = String(
    button?.dataset?.taskRefId || activeTaskCenterDetailId || "",
  );
  const action = String(button?.dataset?.taskAction || "");
  const item = taskCenterItemsById.get(referenceId);
  const taskId = String(button?.dataset?.taskId || item?.actionTaskId || referenceId);
  if (!taskId || !action || !item) return;
  document.dispatchEvent(
    new CustomEvent("onstarvoice:task-center-action", {
      detail: {action, taskId, task: item.raw},
    }),
  );
}

export function initializeTaskCenterInteractions(render = renderTaskCenterPanel) {
  const panel = document.getElementById("historyTab");
  if (!panel || panel.dataset.taskCenterBound === "true") return;
  panel.dataset.taskCenterBound = "true";

  panel.querySelectorAll("#taskCenterStatusFilter, #taskCenterTypeFilter, #taskCenterPlatformFilter, #taskCenterTimeFilter")
    .forEach((select) => select.addEventListener("change", render));
  panel.querySelectorAll("[data-task-summary-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const statusFilter = document.getElementById("taskCenterStatusFilter");
      if (!statusFilter) return;
      const value = String(button.dataset.taskSummaryFilter || "all");
      statusFilter.value = statusFilter.value === value ? "all" : value;
      render();
    });
  });

  document.getElementById("syncHistoryList")?.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-task-action]");
    if (actionButton) {
      dispatchTaskCenterAction(actionButton);
      return;
    }
    const openButton = event.target.closest("[data-task-open]");
    if (openButton) openTaskCenterDetail(openButton.dataset.taskOpen, openButton);
  });

  const modal = document.getElementById("taskCenterDetailModal");
  modal?.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("#btnCloseTaskCenterDetail, #btnTaskCenterDetailDone")) {
      closeTaskCenterDetail();
      return;
    }
    const actionButton = event.target.closest("[data-task-action]");
    if (actionButton) dispatchTaskCenterAction(actionButton);
  });
  modal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTaskCenterDetail();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      modal.querySelectorAll('button:not([disabled]), [href], select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
