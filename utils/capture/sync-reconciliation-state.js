// Consume explicit local-confirmation signals only. Text, HTTP payloads and
// per-record results are not authority to change a task's recovery policy.
const RECONCILIATION_CODES = new Set([
  "SYNC_RECONCILIATION_REQUIRED",
  "STREAMING_SYNC_RECONCILIATION_REQUIRED",
  "LOCAL_CONFIRMATION_REQUIRED",
]);

function hasDirectSignal(value, includeCode = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return value.reconciliationRequired === true ||
    value.requiresReconciliation === true ||
    (includeCode && RECONCILIATION_CODES.has(value.code));
}

export function hasSyncReconciliationSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return hasDirectSignal(value) || hasDirectSignal(value.error) ||
    hasDirectSignal(value.streamingSync, false);
}

export function buildSyncReconciliationError() {
  return {
    code: "SYNC_RECONCILIATION_REQUIRED",
    message: "同步结果需要核对，本地自动处理已暂停",
    retryable: false,
    reconciliationRequired: true,
    category: "local_confirmation",
  };
}
