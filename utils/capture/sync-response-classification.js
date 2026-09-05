import {ERROR_REASON} from '../constants.js';

const RATE_LIMIT_SYNC_REASONS = new Set([
  'rate_limited',
  'too_many_requests',
  '429',
]);
const INDETERMINATE_SYNC_REASONS = new Set([
  'timeout',
  'network_error',
  'coze_timeout',
  'timeout_budget_exceeded',
  ERROR_REASON.TIMEOUT,
  ERROR_REASON.NETWORK_ERROR,
]);

function normalizeBatchFailureReason(batchResult) {
  return String(
    batchResult?.reason ||
      batchResult?.error?.reason ||
      batchResult?.error?.code ||
      batchResult?.data?.reason ||
      '',
  )
    .trim()
    .toLowerCase();
}

function normalizeBatchFailureMessage(batchResult) {
  return String(
    batchResult?.message ||
      batchResult?.error?.message ||
      batchResult?.data?.message ||
      '',
  )
    .trim()
    .toLowerCase();
}

function normalizeSyncItemFailureReason(item, batchResult) {
  return String(
    item?.reason ||
      item?.error?.reason ||
      item?.error?.code ||
      normalizeBatchFailureReason(batchResult) ||
      '',
  )
    .trim()
    .toLowerCase();
}

function normalizeSyncItemFailureMessage(item, batchResult) {
  return String(
    item?.message ||
      item?.error?.message ||
      normalizeBatchFailureMessage(batchResult) ||
      '',
  )
    .trim()
    .toLowerCase();
}

function isRateLimitedBatchResult(batchResult) {
  if (!batchResult || batchResult?.ok === true) {
    return false;
  }
  return isRateLimitedSyncReason(
    normalizeBatchFailureReason(batchResult),
    normalizeBatchFailureMessage(batchResult),
    batchResult?.error?.httpStatus || batchResult?.httpStatus,
  );
}

function isRateLimitedSyncItem(item, batchResult) {
  if (item?.ok === true) {
    return false;
  }
  return isRateLimitedSyncReason(
    normalizeSyncItemFailureReason(item, batchResult),
    normalizeSyncItemFailureMessage(item, batchResult),
    item?.httpStatus ||
      item?.error?.httpStatus ||
      batchResult?.error?.httpStatus ||
      batchResult?.httpStatus,
  );
}

function isRateLimitedSyncReason(reason, message = '', httpStatus = null) {
  if (Number(httpStatus) === 429) {
    return true;
  }
  const normalizedReason = String(reason || '').trim().toLowerCase();
  if (normalizedReason && RATE_LIMIT_SYNC_REASONS.has(normalizedReason)) {
    return true;
  }
  const searchable = `${normalizedReason} ${String(message || '').toLowerCase()}`;
  return /(^|\s)429(\s|$)|too many requests|rate limit|rate_limited/.test(searchable);
}

function isIndeterminateBatchResult(batchResult) {
  if (!batchResult || batchResult?.ok === true || isRateLimitedBatchResult(batchResult)) {
    return false;
  }
  return isIndeterminateSyncReason(
    normalizeBatchFailureReason(batchResult),
    normalizeBatchFailureMessage(batchResult),
  );
}

function isIndeterminateSyncItem(item, batchResult) {
  if (item?.ok === true || isRateLimitedSyncItem(item, batchResult)) {
    return false;
  }
  return isIndeterminateSyncReason(
    normalizeSyncItemFailureReason(item, batchResult),
    normalizeSyncItemFailureMessage(item, batchResult),
  );
}

function isIndeterminateSyncReason(reason, message = '') {
  const normalizedReason = String(reason || '').trim().toLowerCase();
  if (normalizedReason && INDETERMINATE_SYNC_REASONS.has(normalizedReason)) {
    return true;
  }

  const searchable = `${normalizedReason} ${String(message || '').toLowerCase()}`;
  return /timeout|timed out|abort|aborted|network|fetch failed/.test(searchable);
}

export {
  normalizeBatchFailureReason,
  normalizeSyncItemFailureReason,
  isRateLimitedBatchResult,
  isRateLimitedSyncItem,
  isIndeterminateBatchResult,
  isIndeterminateSyncItem,
};
