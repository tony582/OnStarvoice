// Local-only failure notes for the `diagnose` command. They stay in the private runner database
// (state directory, 0600) and are never uploaded; uploaded completion details remain PII-free.
export const DIAGNOSTICS_KEY = 'diagnostics:recent';
export const DIAGNOSTICS_LIMIT = 200;
// AI card prefilter notes (one per request, card-prefilter.mjs) keep a ring of their own: a busy round would otherwise
// push the failure notes out of the main one.
export const PREFILTER_DIAGNOSTICS_KEY = 'diagnostics:prefilter';

function stderrTail(value) {
  const bytes = Buffer.from(value);
  let start = Math.max(0, bytes.length - 2048);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

/** OCR helper details are retained only in the local diagnostic ring, never completion uploads. */
export function localOcrDetails(error) {
  return error?.code?.startsWith('ocr_') ? error.details ?? null : null;
}

function sanitize(value, depth = 0, key = '') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return key === 'stderr' ? stderrTail(value) : value.slice(0, 300);
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  if (typeof value === 'boolean') return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 40).map(item => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key.slice(0, 40), sanitize(item, depth + 1, key)]));
  }
  return null;
}

/** Append one note to a bounded ring. A diagnostic never interrupts or fails a run. */
export function recordDiagnostic(store, entry, {limit = DIAGNOSTICS_LIMIT, key = DIAGNOSTICS_KEY} = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const saved = store.loadCheckpoint(key);
      const entries = [...(saved?.value?.entries ?? []), sanitize(entry)].slice(-limit);
      store.saveCheckpoint(key, {entries}, saved?.revision ?? 0);
      return true;
    } catch { /* Retry once on a concurrent write, then give up silently. */ }
  }
  return false;
}

export function readDiagnostics(store, {key = DIAGNOSTICS_KEY} = {}) {
  try { return store.loadCheckpoint(key)?.value?.entries ?? []; } catch { return []; }
}
