// Local-only failure notes for the `diagnose` command. They stay in the private runner database
// (state directory, 0600) and are never uploaded; uploaded completion details remain PII-free.
export const DIAGNOSTICS_KEY = 'diagnostics:recent';
export const DIAGNOSTICS_LIMIT = 200;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  if (typeof value === 'boolean') return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 40).map(item => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key.slice(0, 40), sanitize(item, depth + 1)]));
  }
  return null;
}

/** Append one note to a bounded ring. A diagnostic never interrupts or fails a run. */
export function recordDiagnostic(store, entry, {limit = DIAGNOSTICS_LIMIT} = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const saved = store.loadCheckpoint(DIAGNOSTICS_KEY);
      const entries = [...(saved?.value?.entries ?? []), sanitize(entry)].slice(-limit);
      store.saveCheckpoint(DIAGNOSTICS_KEY, {entries}, saved?.revision ?? 0);
      return true;
    } catch { /* Retry once on a concurrent write, then give up silently. */ }
  }
  return false;
}

export function readDiagnostics(store) {
  try { return store.loadCheckpoint(DIAGNOSTICS_KEY)?.value?.entries ?? []; } catch { return []; }
}
