// UNWIRED DESIGN PROTOTYPE. No production route, scheduler or Extension imports
// this module. A plan is not a stored fence, authorization, or a replay grant.
import {hasSyncReconciliationSignal} from '../../utils/capture/sync-reconciliation-state.js';

const SCOPE_TEXT_FIELDS = [
  'tenantId', 'lane', 'parentId', 'resourceId', 'executionId', 'attemptId',
  'agentId', 'requestHash',
];
const RESOURCE_FIELDS = ['tenantId', 'lane', 'parentId', 'resourceId'];
const LANES = new Set(['capture_item', 'monitor_subscription']);
const BLOCKED = {automaticReplayBlocked: true, terminalSuccessAllowed: false};

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function scope(value) {
  if (!object(value)) return null;
  const result = {};
  for (const field of SCOPE_TEXT_FIELDS) {
    const text = value[field];
    if (!exactText(text)) return null;
    result[field] = text;
  }
  const revision = value.assignmentRevision;
  if (!LANES.has(result.lane) || !Number.isSafeInteger(revision) || revision < 1) return null;
  result.assignmentRevision = revision;
  return result;
}

function resource(value) {
  return Object.fromEntries(RESOURCE_FIELDS.map(field => [field, value[field]]));
}

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const deny = reason => ({decision: 'deny', reason, ...BLOCKED});

function normalizeHold(value) {
  if (!object(value)) return null;
  const {protocolVersion, state, eventId, resource: storedResource, originScope: rawScope} = value;
  if (protocolVersion !== 1 || state !== 'held' ||
      !exactText(eventId) || !object(storedResource)) return null;
  const originScope = scope(rawScope);
  if (!originScope) return null;
  const identity = resource(originScope);
  if (!RESOURCE_FIELDS.every(field => storedResource[field] === identity[field])) return null;
  return {protocolVersion: 1, state: 'held', resource: identity,
    originScope, eventId};
}

/**
 * expectedScope and existingHold must come from authoritative state while
 * holding the existing resource/assignment locks, never from the request body.
 * The generic scope is a PROPOSED interface. In particular, legacy monitor
 * executions cannot supply its attempt/assignment fields today; do not invent
 * them from timestamps or a subscription's configured Agent.
 *
 * No release operation exists. A resource fence outlives its origin attempt:
 * a later valid attempt's success, cancellation or generic error cannot clear it.
 */
export function planReconciliationHold(input = {}) {
  try {
    if (!object(input)) return deny('invalid_input');
    const {expectedScope, report, existingHold = null} = input;
    const expected = scope(expectedScope);
    if (!expected) return deny('invalid_expected_scope');
    if (!object(report) || report.protocolVersion !== 1) return deny('unsupported_protocol');
    const eventId = report.eventId;
    if (!exactText(eventId)) return deny('invalid_event_id');
    const reported = scope(report.scope);
    if (!reported) return deny('invalid_report_scope');
    if (!equal(expected, reported)) return deny('stale_report');

    let held = null;
    if (existingHold !== null) {
      held = normalizeHold(existingHold);
      if (!held) return deny('invalid_existing_hold');
      if (!equal(resource(expected), held.resource)) return deny('hold_resource_mismatch');
      if (eventId === held.eventId && !equal(reported, held.originScope)) {
        return deny('event_identity_conflict');
      }
    }
    const requiresHold = hasSyncReconciliationSignal(report.signal);
    if (held) {
      if (eventId === held.eventId && !requiresHold) return deny('event_payload_conflict');
      return {decision: 'retain_hold', hold: held, ...BLOCKED};
    }
    if (!requiresHold) return {decision: 'defer_existing'};
    return {
      decision: 'require_atomic_hold',
      proposedHold: {protocolVersion: 1, state: 'held', resource: resource(expected),
        originScope: expected, eventId},
      ...BLOCKED,
    };
  } catch {
    // Unreadable fields cannot turn into legacy fallback or a success decision.
    return deny('unreadable_input');
  }
}

/**
 * Model the adapter confirmation boundary; NOT a database implementation.
 * persist must recheck assignment + resource fencing under the established
 * lock order and resolve only after COMMIT. It must implement event idempotency
 * and every scheduler barrier together. An echoed object from an untrusted
 * client is NOT a commit receipt; only the injected trusted adapter may supply it.
 *
 * No automatic retry: commit-then-lost-reply is an unknown outcome, not proof
 * that the hold was not saved. A later safe read/receipt lookup is a separate gate.
 */
export async function confirmReconciliationHold(input = {}) {
  const plan = planReconciliationHold(input);
  if (plan.decision === 'defer_existing') return plan;
  if (plan.decision === 'deny') return {...plan, accepted: false};
  const expectedHold = plan.proposedHold || plan.hold;
  const unconfirmed = reason => ({decision: 'hold_commit_unconfirmed', accepted: false,
    reason, ...BLOCKED});
  try {
    const persist = input.persist;
    if (typeof persist !== 'function') return unconfirmed('adapter_required');
    // Isolate adapter mutations from the retained comparison snapshot.
    const receipt = await persist(structuredClone(plan));
    if (!object(receipt) || receipt.committed !== true) return unconfirmed('commit_not_confirmed');
    const held = normalizeHold(receipt.hold);
    if (!held || !equal(held, expectedHold)) return unconfirmed('receipt_mismatch');
    return {decision: 'hold_commit_confirmed', accepted: true, hold: held, ...BLOCKED};
  } catch {
    return unconfirmed('commit_outcome_unknown');
  }
}
