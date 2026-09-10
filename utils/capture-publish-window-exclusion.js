export const CAPTURE_PUBLISH_WINDOW_EXCLUSION = 'capture_publish_time_out_of_range';

// Only this explicit backend decision is a terminal business exclusion.
// Other skipped/error responses must retain their existing retry behavior.
export function isCapturePublishWindowExclusion(result = {}) {
  return result?.reason === CAPTURE_PUBLISH_WINDOW_EXCLUSION &&
    (result.ok === false || result.success === false || result.excluded === true);
}

function captureTimestampMillis(value) {
  if (typeof value !== 'number' &&
      !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

export function hasNewCaptureAfterPublishWindowExclusion(record = {}, payload = record?.payload) {
  if (record?.lastSyncReason !== CAPTURE_PUBLISH_WINDOW_EXCLUSION) return false;
  const capturedAt = captureTimestampMillis(payload?.captureTimestamp);
  const excludedAt = captureTimestampMillis(record?.lastSyncedAt);
  return capturedAt !== null && excludedAt !== null && capturedAt > excludedAt;
}

// Re-uploading the same payload must not bypass the server's decision. A new
// scoped task or a fresh capture can ask the backend to evaluate the new scope.
// updatedAt is deliberately excluded: ordinary sync state writes change it.
export function isStoredCapturePublishWindowExclusion(record = {}, captureTaskId = '') {
  return !String(captureTaskId || '').trim() &&
    record?.lastSyncReason === CAPTURE_PUBLISH_WINDOW_EXCLUSION &&
    !hasNewCaptureAfterPublishWindowExclusion(record);
}
