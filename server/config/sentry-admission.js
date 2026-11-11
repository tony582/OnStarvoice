import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';

const DEFAULT_CONFIG = new URL('./sentry-admission.json', import.meta.url);

// Deployment writes a single actual UTC activation time; an absent or invalid
// value preserves the legacy gate. Never use process start time as the cutoff.
export function parseSentryScopeRetiredAt(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text) || text.startsWith('0000-')) return '';
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return '';
  const normalized = new Date(ms).toISOString();
  return normalized === (text.includes('.') ? text : text.replace('Z', '.000Z')) ? normalized : '';
}

export function getSentryScopeRetiredAt() {
  const configuredPath = String(process.env.SENTRY_ADMISSION_CONFIG_PATH || '').trim();
  if (configuredPath && !isAbsolute(configuredPath)) return '';
  try {
    const value = JSON.parse(readFileSync(configuredPath || DEFAULT_CONFIG, 'utf8'));
    return parseSentryScopeRetiredAt(value?.SENTRY_SCOPE_RETIRED_AT);
  } catch { return ''; }
}

export function recordCreatedAfterSentryRetirement(record, retiredAt = getSentryScopeRetiredAt()) {
  const cutoff = parseSentryScopeRetiredAt(retiredAt);
  if (!cutoff) return false;
  const created = record?.created_at;
  // DB rows are Dates; serialized rows include a timezone. Missing, ambiguous or
  // invalid dates must never opt historical content into the new rule.
  if (!(created instanceof Date)) {
    if (typeof created !== 'string') return false;
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(created);
    if (!match) return false;
    const wallTime = `${match[1]}T${match[2]}`, wallMs = Date.parse(`${wallTime}Z`);
    if (!Number.isFinite(wallMs) || new Date(wallMs).toISOString().slice(0, 19) !== wallTime) return false;
  }
  const timestamp = created instanceof Date ? created.getTime() : Date.parse(created);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(cutoff);
}
