import { exactRecordId } from './record-id.mjs';
import { presentResult, presentResultDetail } from './result-presenter.mjs';

// Proposed read-side envelope only. Matching these fields is not authorization.
const ABSENT = Symbol('absent');
const UNREADABLE = Symbol('unreadable');
const SCOPE_KEYS = ['tenantId', 'taskId', 'executionId'];
const QUERY_KEYS = ['filter', 'offset', 'limit'];

function object(value) {
  try { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  catch { return false; }
}

function own(value, key, array = false) {
  try {
    if (!object(value) && !(array && Array.isArray(value))) return UNREADABLE;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return ABSENT;
    return Object.hasOwn(descriptor, 'value') ? descriptor.value : UNREADABLE;
  } catch { return UNREADABLE; }
}

function identity(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return null;
  if (/[\s\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]/u.test(value)) return null;
  return value;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Only call on fresh, bounded projection trees constructed in this module or U1.
function freezeProjection(value) {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeProjection(nested);
    Object.freeze(value);
  }
  return value;
}

/** Exact new-contract identities; no coercion, repair, inherited fields or getters. */
export function readScope(value) {
  if (!object(value)) return null;
  const scope = {};
  for (const key of SCOPE_KEYS) {
    const entry = identity(own(value, key));
    if (entry === null) return null;
    scope[key] = entry;
  }
  return Object.freeze(scope);
}

/** Omitted fields use defaults. Explicit malformed values never broaden a query. */
export function readQuery(value = undefined) {
  if (value === undefined) return Object.freeze({ filter: 'all', offset: 0, limit: 50 });
  if (!object(value)) return null;
  const supplied = Object.fromEntries(QUERY_KEYS.map(key => [key, own(value, key)]));
  const filter = supplied.filter === ABSENT ? 'all' : supplied.filter;
  const offset = supplied.offset === ABSENT ? 0 : supplied.offset;
  const limit = supplied.limit === ABSENT ? 50 : supplied.limit;
  if ((filter !== 'all' && filter !== 'attention') || !count(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return null;
  return Object.freeze({ filter, offset, limit });
}

function sameScope(response, expected) {
  const scope = readScope(own(response, 'scope'));
  return scope !== null && SCOPE_KEYS.every(key => scope[key] === expected[key]);
}

function sameQuery(value, expected) {
  // Echoes must be complete, even when the originating request used defaults.
  return object(value) && QUERY_KEYS.every(key => own(value, key) === expected[key]);
}

/** Decode one source-sliced summary page; no full-pool reads or business actions. */
export function decodeResultPage(response, expectedScope, query) {
  const scope = readScope(expectedScope);
  const request = readQuery(query);
  if (!scope || !request || !object(response) || !sameScope(response, scope)) return null;
  const snapshotId = identity(own(response, 'snapshotId'));
  if (snapshotId === null || !sameQuery(own(response, 'query'), request)) return null;
  const sourceCounts = own(response, 'counts');
  const all = own(sourceCounts, 'all');
  const attention = own(sourceCounts, 'attention');
  const matching = own(sourceCounts, 'matching');
  if (![all, attention, matching].every(count) || attention > all || matching !== (request.filter === 'attention' ? attention : all)) return null;
  const sourceItems = own(response, 'items');
  try { if (!Array.isArray(sourceItems)) return null; } catch { return null; }
  const length = own(sourceItems, 'length', true);
  if (!count(length) || length > 50 || length !== Math.min(request.limit, Math.max(0, matching - request.offset))) return null;
  const items = [];
  let visibleAttention = 0;
  for (let index = 0; index < length; index += 1) {
    const sourceItem = own(sourceItems, String(index), true);
    if (!object(sourceItem)) return null;
    const item = presentResult(sourceItem);
    if (item.needsAttention) visibleAttention += 1;
    else if (request.filter === 'attention') return null;
    items.push(item);
  }
  // These are necessary page-local constraints, not verification of unseen rows.
  if (visibleAttention > attention || (request.filter === 'all' && attention > all - (length - visibleAttention))) return null;
  return freezeProjection({
    snapshotId,
    page: {
      items,
      counts: { all, attention, matching },
      page: {
        ...request,
        hasPrevious: request.offset > 0 && matching > 0,
        hasNext: request.offset < matching && matching - request.offset > length,
      },
    },
  });
}

/** Check identity before touching a bounded detail, then drop all envelope extras. */
export function decodeResultDetail(response, expectedScope, snapshotId, recordId) {
  const scope = readScope(expectedScope);
  const snapshot = identity(snapshotId);
  const record = exactRecordId(recordId);
  if (!scope || snapshot === null || !record || !object(response) || !sameScope(response, scope)) return null;
  if (own(response, 'snapshotId') !== snapshot || own(response, 'recordId') !== record) return null;
  const detail = own(response, 'detail');
  if (!object(detail)) return null;
  return freezeProjection({ recordId: record, detail: presentResultDetail(detail) });
}
