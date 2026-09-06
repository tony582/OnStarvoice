import { exactRecordId } from '../domain/record-id.mjs';

// Read supplied snapshots only. A saved historical status is not a current receipt.
const ABSENT = Symbol('absent');
const UNREADABLE = Symbol('unreadable');
const RECORD_TYPES = new Set(['single_note', 'blogger_notes', 'keyword_notes', 'blogger_profile', 'comments', 'comment_leads']);
const HOLD_CODES = new Set(['SYNC_RECONCILIATION_REQUIRED', 'STREAMING_SYNC_RECONCILIATION_REQUIRED', 'LOCAL_CONFIRMATION_REQUIRED']);

function object(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function own(value, key, allowArray = false) {
  try {
    if (!object(value) && !(allowArray && Array.isArray(value))) return ABSENT;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return ABSENT;
    return Object.hasOwn(descriptor, 'value') ? descriptor.value : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

function text(value, limit) {
  if (typeof value !== 'string') return '';
  const prefix = value.slice(0, limit);
  return value.length > limit ? prefix.replace(/[\uD800-\uDBFF]$/u, '') : prefix;
}

function firstText(values, limit) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return text(value, limit);
  }
  return '';
}

function payloadOf(record) {
  for (const field of ['normalizedPayload', 'payload', 'data']) {
    const value = own(record, field);
    if (value === ABSENT) continue;
    // A present but unusable preferred payload must not revive an older copy.
    return object(value) ? value : null;
  }
  return null;
}

function typeOf(record) {
  const preferred = own(record, 'recordType');
  const type = preferred === ABSENT ? own(record, 'type') : preferred;
  return RECORD_TYPES.has(type) ? type : 'unknown';
}

function firstItem(payload) {
  const items = own(payload, 'items');
  try {
    return Array.isArray(items) ? own(items, '0', true) : ABSENT;
  } catch {
    return UNREADABLE;
  }
}

function kindOf(type) {
  if (type === 'blogger_profile') return 'profile';
  if (type === 'comments') return 'comments';
  if (['single_note', 'blogger_notes', 'keyword_notes'].includes(type)) return 'note';
  return 'unknown';
}

function platformOf(record, payload) {
  const direct = own(record, 'platform');
  const value = direct === ABSENT ? own(payload, 'platform') : direct;
  return value === 'xiaohongshu' || value === 'douyin' || value === 'weibo' ? value : 'unknown';
}

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function metric(source, field) {
  const value = count(own(source, field));
  if (value === null) return null;
  const knownGroup = own(source, 'metricKnown');
  if (knownGroup !== ABSENT && !object(knownGroup)) return null;
  const signals = [own(knownGroup, field), own(source, `${field}Known`)];
  if (field === 'comments') signals.push(own(source, 'commentsCountKnown'));
  if (own(source, 'displayMetricDimension') === field) signals.push(own(source, 'displayMetricKnown'));
  const explicit = signals.filter(signal => signal !== ABSENT && signal !== undefined);
  // A numeric fallback does not override explicit uncertainty or contradictory flags.
  if (explicit.some(signal => signal !== true)) return null;
  return value > 0 || explicit.length > 0 ? value : null;
}

function hasHold(value, includeCode = true) {
  return own(value, 'reconciliationRequired') === true || own(value, 'requiresReconciliation') === true ||
    (includeCode && HOLD_CODES.has(own(value, 'code')));
}

function reconciliationRequired(record) {
  return hasHold(record) || hasHold(own(record, 'error')) || hasHold(own(record, 'streamingSync'), false);
}

function commentCaptureStatus(payload) {
  switch (own(payload, 'captureStatus')) {
    case 'done': return 'completed';
    case 'partial': return 'partial';
    case 'failed': return 'failed';
    case 'capturing': return 'running';
    case 'not_started': return 'pending';
    default: return 'unknown';
  }
}

/** No body, comment entries, browser state, historical normalization or write-back. */
export function adaptStoredSummary(record) {
  const payload = payloadOf(record);
  const type = typeOf(record);
  const kind = kindOf(type);
  const item = type === 'blogger_notes' || type === 'keyword_notes' ? firstItem(payload) : null;
  const source = item === null ? payload : item;
  const legacy = own(record, 'status');
  const summary = {
    id: exactRecordId(own(record, 'id')),
    title: firstText([own(record, 'title'), own(source, 'title'), kind === 'profile' ? own(payload, 'bloggerName') : ABSENT, kind === 'comments' ? own(payload, 'noteTitle') : ABSENT], 180),
    platform: platformOf(record, payload),
    kind,
    author: firstText([own(source, 'author'), own(payload, 'bloggerName')], 80),
    summary: firstText([own(record, 'summary'), own(payload, 'summary')], 240),
    likes: kind === 'note' ? metric(source, 'likes') : null,
    commentsCount: kind === 'comments' ? count(own(payload, 'totalCount')) : kind === 'note' ? metric(source, 'comments') : null,
    capture: { status: kind === 'comments' ? commentCaptureStatus(payload) : 'unknown' },
    delivery: { remote: 'unknown', local: 'unknown' },
  };
  if (reconciliationRequired(record)) summary.reconciliationRequired = true;
  const provenance = {
    recordType: type,
    legacyStatus: ['draft', 'synced', 'failed'].includes(legacy) ? legacy : 'unknown',
    confirmation: 'unverified',
  };
  if (kind === 'comments') provenance.captureScope = 'comment_record';
  return { summary, provenance };
}

function detailSource(payload, type) {
  if (type !== 'blogger_notes' && type !== 'keyword_notes') return payload;
  const detail = own(payload, 'detailPayload');
  if (detail !== ABSENT && detail !== null) return object(detail) ? detail : null;
  return firstItem(payload);
}

function commentPreview(value) {
  try {
    if (!Array.isArray(value)) return { comments: [], truncated: false };
  } catch {
    return { comments: [], truncated: false };
  }
  const comments = [];
  let truncated = count(own(value, 'length', true)) > 50;
  for (let index = 0; index < 50; index += 1) {
    const entry = own(value, String(index), true);
    const preferred = own(entry, 'content');
    const body = preferred === ABSENT ? own(entry, 'commentContent') : preferred;
    if (typeof body !== 'string' || body.length === 0) continue;
    const author = own(entry, 'userName');
    if (body.length > 1600 || (typeof author === 'string' && author.length > 80)) truncated = true;
    comments.push({ author: text(author, 80), text: text(body, 1600) });
  }
  return { comments, truncated };
}

/** Explicit bounded detail projection; commentsCount is never inferred from this preview. */
export function adaptStoredDetail(record) {
  const payload = payloadOf(record);
  const type = typeOf(record);
  const source = detailSource(payload, type);
  const body = type === 'blogger_profile' ? own(source, 'description') : kindOf(type) === 'note' ? own(source, 'content') : ABSENT;
  const entries = type === 'comments' ? own(payload, 'items') : kindOf(type) === 'note' ? own(source, 'commentsCleanedItems') : ABSENT;
  const preview = commentPreview(entries);
  return {
    body: text(body, 12000),
    comments: preview.comments,
    truncated: { body: typeof body === 'string' && body.length > 12000, comments: preview.truncated },
  };
}
