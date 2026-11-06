export const ENHANCEMENT_RETRY_EXHAUSTED = 'ENHANCEMENT_RETRY_EXHAUSTED';
export const ENHANCEMENT_RETRY_WINDOW_MS = 10 * 60 * 1000;

// Deliberately invocation-local: neither another keyword nor a later patrol can
// treat an old detail snapshot as evidence gathered by its current attempt.
export function createEnhancementRetrySession({
  now = Date.now,
  maxRetryDurationMs = ENHANCEMENT_RETRY_WINDOW_MS,
} = {}) {
  const checkpoints = new Map();
  const commentAttempts = new Map();
  const windowMs = Math.min(ENHANCEMENT_RETRY_WINDOW_MS,
    Math.max(1, Number(maxRetryDurationMs) || ENHANCEMENT_RETRY_WINDOW_MS));
  let retryStartedAt = null;
  const clone = value => JSON.parse(JSON.stringify(value));
  const remainingMs = () => retryStartedAt === null
    ? Infinity : Math.max(0, windowMs - Math.max(0, now() - retryStartedAt));
  return Object.freeze({
    beginRetry() {
      if (retryStartedAt === null) retryStartedAt = now();
    },
    remainingMs,
    remember(recordId, scopeKey, detailPayload) {
      if (!recordId || !scopeKey || !detailPayload || typeof detailPayload !== 'object') return;
      checkpoints.set(recordId, {scopeKey, detailPayload: clone(detailPayload)});
    },
    read(recordId, scopeKey) {
      const checkpoint = checkpoints.get(recordId);
      return checkpoint && checkpoint.scopeKey === scopeKey
        ? clone(checkpoint.detailPayload) : null;
    },
    forget(recordId) { checkpoints.delete(recordId); },
    savedRecordIds() { return [...checkpoints.keys()]; },
    beginComments(recordId) {
      const attempts = commentAttempts.get(recordId) || 0;
      if (remainingMs() <= 0) return {ok: false, reason: 'retry_time_budget'};
      // A failed comment stage gets one compensation. A runner rebuild and an
      // outer item retry share this counter instead of multiplying the budget.
      if (attempts >= 2) return {ok: false, reason: 'comment_attempt_budget'};
      commentAttempts.set(recordId, attempts + 1);
      return {ok: true, remainingMs: remainingMs()};
    },
  });
}
