// Completion telemetry is numeric only. Card text belongs in the local diagnostic ring, never this wire payload.
// Keep this protocol allowlist aligned with server/services/android-control/completion-stats.js.
const FIELDS = Object.freeze(['links', 'cards', 'swipes', 'skippedCards', 'keywordElapsedMs', 'batchElapsedMs',
  'prefilterSkipped', 'prefilterJudged', 'prefilterUnjudged', 'posts', 'previewFailed', 'previewUnavailable',
  'outsideWindow', 'comments', 'partialBodies', 'unavailableBodies', 'timeUnverified', 'pageFailures',
  'cardsSeen', 'opened', 'stopReason', 'screens']);
export function completionStats(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  return Object.fromEntries(FIELDS.filter(key => Object.hasOwn(source, key)
    && Number.isFinite(source[key]) && source[key] >= 0
    && (key !== 'stopReason' || Number.isSafeInteger(source[key]))).map(key => [key, source[key]]));
}
