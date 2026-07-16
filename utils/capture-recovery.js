const COMMENT_CAPTURE_STATUS = Object.freeze({
  CAPTURING: "capturing",
  PARTIAL: "partial",
  FAILED: "failed",
});

const INTERRUPTED_COMMENT_MESSAGE =
  "任务因断网、电脑休眠或页面中断而停止；可继续采集当前项";

/**
 * 上一次中断时“页面曾观察到的数量”只用于解释当次中断。
 * 新一轮采集开始或产生新终态后，必须丢弃这个历史值。
 */
export function clearInterruptedCommentObservation(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  if (
    !Object.prototype.hasOwnProperty.call(
      source,
      "commentsObservedBeforeInterrupt",
    )
  ) {
    return source;
  }

  const next = {...source};
  delete next.commentsObservedBeforeInterrupt;
  return next;
}

/**
 * 将已失去执行上下文的评论采集状态收口为可重试终态。
 * 已落盘的评论会保留为 partial；没有评论快照时标记 failed。
 */
export function repairInterruptedCommentPayload(
  payload,
  {
    finishedAt = Date.now(),
    message = INTERRUPTED_COMMENT_MESSAGE,
  } = {},
) {
  const source = payload && typeof payload === "object" ? payload : {};
  const status = String(source.commentsCaptureStatus || "")
    .trim()
    .toLowerCase();
  if (status !== COMMENT_CAPTURE_STATUS.CAPTURING) {
    return {changed: false, payload: source};
  }

  const items = Array.isArray(source.commentsCleanedItems)
    ? source.commentsCleanedItems
    : [];
  const observedBeforeInterrupt = Number.isFinite(
    Number(source.commentsTotalCaptured),
  )
    ? Math.max(0, Math.floor(Number(source.commentsTotalCaptured)))
    : 0;
  // 进度心跳只会落“已看到的数量”，页面进程一旦丢失，不能把这个数量
  // 当成正文已保存。只有 commentsCleanedItems 才是可恢复的真实检查点。
  const total = items.length;
  const nextStatus =
    total > 0 ? COMMENT_CAPTURE_STATUS.PARTIAL : COMMENT_CAPTURE_STATUS.FAILED;
  const sourceWithoutPreviousObservation =
    clearInterruptedCommentObservation(source);

  return {
    changed: true,
    payload: {
      ...sourceWithoutPreviousObservation,
      commentsCaptureStatus: nextStatus,
      commentsCaptureStoppedByUser: false,
      commentsCaptureFinishedAt: Number(finishedAt) || Date.now(),
      commentsCaptureError: String(message || INTERRUPTED_COMMENT_MESSAGE),
      commentsCleanedItems: items,
      commentsTotalCaptured: total,
      ...(observedBeforeInterrupt > total
        ? {commentsObservedBeforeInterrupt: observedBeforeInterrupt}
        : {}),
    },
  };
}
