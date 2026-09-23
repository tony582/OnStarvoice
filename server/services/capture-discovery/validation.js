import {createHash} from 'node:crypto';
import {normalizeUiBinding} from './ui-binding.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

export class DiscoveryError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'DiscoveryError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

export function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new DiscoveryError(`INVALID_${field.toUpperCase()}`);
  }
  return value.toLowerCase();
}

function text(value, field, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new DiscoveryError(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function stableJson(value, depth = 0) {
  if (depth > 8) throw new DiscoveryError('PAYLOAD_TOO_DEEP');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => stableJson(item, depth + 1));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key], depth + 1)]));
  }
  throw new DiscoveryError('INVALID_JSON_VALUE');
}

function filters(value) {
  const output = stableJson(value ?? {});
  if (!output || Array.isArray(output) || typeof output !== 'object'
      || JSON.stringify(output).length > 4096) throw new DiscoveryError('INVALID_FILTERS');
  return output;
}

export function validatePrincipal(input) {
  if (!input) throw new DiscoveryError('AGENT_AUTH_REQUIRED', 401);
  return Object.fromEntries(['tenantId', 'agentId', 'authCodeId', 'authBindingId']
    .map(key => [key, requireUuid(input[key], key)]));
}

export function normalizeBatch(batch, principal, now = Date.now()) {
  const uploadBatchId = requireUuid(batch?.uploadBatchId, 'uploadBatchId');
  if (!Array.isArray(batch?.events) || batch.events.length < 1 || batch.events.length > 5) {
    throw new DiscoveryError('BATCH_SIZE_MUST_BE_1_TO_5');
  }
  const events = batch.events.map(input => {
    const event = {};
    for (const key of ['eventId', 'discoveryRunId', 'taskId', 'itemId', 'attemptId', 'agentId']) {
      event[key] = requireUuid(input?.[key], key);
    }
    if (event.agentId !== principal.agentId) throw new DiscoveryError('AGENT_ID_MISMATCH', 403);
    if (event.discoveryRunId !== event.taskId) throw new DiscoveryError('RUN_TASK_MISMATCH');
    if (!HASH.test(input.requestHash)) throw new DiscoveryError('INVALID_REQUEST_HASH');
    if (!Number.isSafeInteger(input.assignmentRevision) || input.assignmentRevision < 1) {
      throw new DiscoveryError('INVALID_ASSIGNMENT_REVISION');
    }
    const discovered = Date.parse(input.discoveredAt);
    if (typeof input.discoveredAt !== 'string' || !Number.isFinite(discovered)
        || discovered > now + 300_000) throw new DiscoveryError('INVALID_DISCOVERED_AT');
    if (!['verified', 'ui_bound', 'link_unverified'].includes(input.verification)) {
      throw new DiscoveryError('INVALID_VERIFICATION');
    }
    if (input.deliveryMode != null && !['normal', 'late_audit'].includes(input.deliveryMode)) {
      throw new DiscoveryError('INVALID_DELIVERY_MODE');
    }
    Object.assign(event, {
      requestHash: input.requestHash, assignmentRevision: input.assignmentRevision,
      discoveredAt: new Date(discovered).toISOString(), verification: input.verification,
      deliveryMode: input.deliveryMode || 'normal',
      keyword: text(input.keyword, 'keyword', 256, true),
      rawShareUrl: text(input.rawShareUrl, 'rawShareUrl', 4096),
      titleHint: text(input.titleHint, 'titleHint', 2000),
      authorHint: text(input.authorHint, 'authorHint', 512),
      publishTimeRaw: text(input.publishTimeRaw, 'publishTimeRaw', 128),
      evidenceRef: text(input.evidenceRef, 'evidenceRef', 512),
      verifiedExternalId: text(input.verifiedExternalId, 'verifiedExternalId', 32),
      reason: text(input.reason, 'reason', 256),
      requestedFilters: filters(input.requestedFilters), observedFilters: filters(input.observedFilters),
    });
    if (event.verification === 'ui_bound') {
      event.uiBinding = normalizeUiBinding(input.uiBinding);
      if (!event.titleHint.trim() || !event.authorHint.trim() || event.verifiedExternalId) {
        throw new DiscoveryError('INVALID_UI_BOUND_EVIDENCE');
      }
    }
    const payloadHash = createHash('sha256').update(JSON.stringify(stableJson(event))).digest('hex');
    return {...event, payloadHash, uploadBatchId};
  });
  if (new Set(events.map(event => event.eventId)).size !== events.length) {
    throw new DiscoveryError('DUPLICATE_EVENT_IN_BATCH');
  }
  // Freeze the complete batch, including not-yet-accepted events. Reordering is
  // harmless, but changing membership or any event's evidence requires refusal.
  const uploadBatchHash = createHash('sha256').update(JSON.stringify(events
    .map(event => [event.eventId, event.payloadHash]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
  return {uploadBatchId, uploadBatchHash, events: events.map(event => ({...event, uploadBatchHash}))};
}
