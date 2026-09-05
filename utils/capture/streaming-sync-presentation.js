// Pure local presentation only. These projections do not enable a queue hold,
// authorize a replay, or change the server's recovery/terminal-state protocol.
export function isStreamingSyncReconciliationRequired(stats) {
  return stats?.reconciliationRequired === true;
}

export function formatStreamingSyncSummary(stats = {}) {
  if (isStreamingSyncReconciliationRequired(stats)) {
    return `同步待核对（本地队列已挂起）：已同步 ${Number(stats.successCount || 0)}，待核对 ${Number(stats.remainingCount || 0)}`;
  }
  if (!stats?.enabled || Number(stats.enqueuedCount || 0) === 0) {
    return "";
  }
  const retryNote =
    Number(stats.retryCount || 0) > 0
      ? `，瞬时重试 ${Number(stats.retryCount || 0)}`
      : "";
  return `同步成功 ${Number(stats.successCount || 0)}，失败 ${Number(stats.failedCount || 0)}，待上传 ${Number(stats.remainingCount || 0)}${retryNote}`;
}

export function buildStreamingSyncTaskIssue(stats = {}) {
  if (isStreamingSyncReconciliationRequired(stats)) {
    return {
      code: "STREAMING_SYNC_RECONCILIATION_REQUIRED",
      message: formatStreamingSyncSummary(stats),
      reconciliationRequired: true,
      // Local descriptive metadata, not a server-side no-redispatch fence.
      retryable: false,
    };
  }
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

export function buildStreamingSyncTaskMetadata(stats = {}) {
  return {
    syncSuccessCount: Number(stats?.successCount || 0),
    syncFailedCount: Number(stats?.failedCount || 0),
    syncSkippedCount: Number(stats?.skippedCount || 0),
    syncRemainingCount: Number(stats?.remainingCount || 0),
    syncRetryCount: Number(stats?.retryCount || 0),
    syncBlocked: Boolean(stats?.blocked),
    ...(isStreamingSyncReconciliationRequired(stats) ? {
      syncReconciliationRequired: true,
      syncDrainCompleted: false,
    } : {}),
  };
}

export function buildStreamingSyncCompletionNotice(stats = {}, {enabled = false} = {}) {
  if (!enabled) return null;
  if (isStreamingSyncReconciliationRequired(stats)) {
    return {message: formatStreamingSyncSummary(stats), tone: "warning"};
  }
  // Preserve the old manual toast predicate, including legacy coercions.
  if (
    Number(stats?.failedCount || 0) > 0 ||
    !(Number(stats?.enqueuedCount || 0) > 0) ||
    stats?.blocked
  ) {
    return null;
  }
  return {
    message: `已采数据已同步后台：成功 ${Number(stats?.successCount || 0)} 条，跳过 ${Number(stats?.skippedCount || 0)} 条`,
    tone: "success",
  };
}
