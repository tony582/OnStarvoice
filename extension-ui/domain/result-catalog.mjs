import { exactRecordId } from './record-id.mjs';
import { exactReadIdentity } from './read-identity.mjs';
import { readScope, readQuery } from './read-contract.mjs';
import { presentResult } from './result-presenter.mjs';

const ABSENT = Symbol('absent');
const TEXT_FIELDS = { title: 180, author: 80, summary: 240 };
const MAX_ENTRIES = 10000;

function invalid() { throw new TypeError('Invalid result catalog'); }

function object(value) {
  try { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  catch { return false; }
}

function own(value, key, array = false) {
  try {
    if (!object(value) && !(array && Array.isArray(value))) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return ABSENT;
    if (!Object.hasOwn(descriptor, 'value')) return invalid();
    return descriptor.value;
  } catch { return invalid(); }
}

function optional(value) { return value === ABSENT || value === undefined; }

function copyLabel(source, target, key) {
  const value = own(source, key);
  if (optional(value)) return;
  // Keep semantic labels exact: truncation must not invent a recognized status.
  if (typeof value !== 'string' || value.length > 240) return invalid();
  target[key] = value;
}

function copyStatusGroup(source, target, key, fields) {
  const value = own(source, key);
  if (optional(value)) return;
  if (!object(value)) return invalid();
  const group = {};
  for (const field of fields) copyLabel(value, group, field);
  target[key] = Object.freeze(group);
}

function copySummary(source, recordId) {
  if (!object(source) || own(source, 'id') !== recordId) return invalid();
  const result = { id: recordId };
  for (const [key, limit] of Object.entries(TEXT_FIELDS)) {
    const value = own(source, key);
    if (optional(value)) continue;
    if (typeof value !== 'string') return invalid();
    // U1 inspects this exact prefix before trimming or removing display controls.
    // Preserve its ellipsis decision and never split a valid surrogate pair.
    result[key] = value.slice(0, limit + 1)
      .replace(/[\uD800-\uDBFF]$/u, '')
      .replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
  }
  for (const key of ['platform', 'kind']) copyLabel(source, result, key);
  for (const key of ['likes', 'commentsCount']) {
    const value = own(source, key);
    if (optional(value)) continue;
    if (value !== null && !(Number.isSafeInteger(value) && value >= 0)) return invalid();
    result[key] = value;
  }
  copyStatusGroup(source, result, 'capture', ['status']);
  copyStatusGroup(source, result, 'delivery', ['remote', 'local']);
  const reconciliation = own(source, 'reconciliationRequired');
  if (!optional(reconciliation)) {
    // In particular, a malformed hold must not disappear into a success state.
    if (typeof reconciliation !== 'boolean') return invalid();
    result.reconciliationRequired = reconciliation;
  }
  return Object.freeze(result);
}

/**
 * A bounded in-process index over a trusted new manifest, not a stored pool.
 * The manifest supplier owns authorization, provenance and revision truth.
 * No read repairs, detail loading, persistence or historical ownership inference.
 */
export function buildResultCatalog(manifest) {
  const scope = readScope(own(manifest, 'scope'));
  const snapshotId = exactReadIdentity(own(manifest, 'snapshotId'));
  const recordNamespace = own(manifest, 'recordNamespace');
  if (!scope || snapshotId === null || !['client_record', 'server_record'].includes(recordNamespace)) return invalid();
  const entries = own(manifest, 'entries');
  try { if (!Array.isArray(entries)) return invalid(); } catch { return invalid(); }
  const length = own(entries, 'length', true);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ENTRIES) return invalid();
  const identities = new Map();
  const all = [];
  const attention = [];
  for (let index = 0; index < length; index += 1) {
    const entry = own(entries, String(index), true);
    const recordId = exactRecordId(own(entry, 'recordId'));
    const recordVersion = exactReadIdentity(own(entry, 'recordVersion'));
    if (!recordId || recordVersion === null || identities.has(recordId)) return invalid();
    const summary = copySummary(own(entry, 'summary'), recordId);
    identities.set(recordId, Object.freeze({ recordId, recordVersion }));
    all.push(summary);
    if (presentResult(summary).needsAttention) attention.push(summary);
  }
  Object.freeze(all);
  Object.freeze(attention);

  return Object.freeze({
    scope,
    snapshotId,
    recordNamespace,
    readPage(value) {
      const query = readQuery(value);
      if (!query) return invalid();
      const matching = query.filter === 'attention' ? attention : all;
      const items = Object.freeze(matching.slice(query.offset, query.offset + query.limit));
      return Object.freeze({
        scope,
        snapshotId,
        recordNamespace,
        query,
        items,
        counts: Object.freeze({ all: all.length, attention: attention.length, matching: matching.length }),
      });
    },
    lookup(recordId) {
      const id = exactRecordId(recordId);
      return id ? identities.get(id) ?? null : null;
    },
  });
}
