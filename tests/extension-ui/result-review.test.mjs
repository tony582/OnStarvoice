import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewResultSignals, RESULT_FILTERS, matchesResultFilter } from '../../extension-ui/domain/result-review.mjs';
import { presentResult } from '../../extension-ui/domain/result-presenter.mjs';
import { adaptStoredSummary } from '../../extension-ui/adapters/stored-result.mjs';

const NORMAL = Object.freeze({ unverified: false, hasIssue: false, interventionReported: false, reasons: Object.freeze([]) });
const FILTERS = ['all', 'attention', 'unverified', 'issues', 'intervention'];

function summary(overrides = {}) {
  return { id: 'record-1', title: '合成结果', capture: { status: 'completed' }, delivery: { remote: 'confirmed', local: 'confirmed' }, ...overrides };
}

function review(overrides = {}) {
  const input = { id: 'record-1', captureKey: 'completed', remote: 'confirmed', local: 'confirmed', reconciliation: undefined, ...overrides };
  return reviewResultSignals(input.id, input.captureKey, input.remote, input.local, input.reconciliation);
}

function expectation(flags = {}, reasons = []) {
  return { ...NORMAL, ...flags, reasons };
}

function accessor(target, key, reads) {
  Object.defineProperty(target, key, { configurable: true, get() { reads.count += 1; throw new Error('must not inspect'); } });
  return target;
}

test('review has an exact frozen display-only shape and deterministic empty reasons', () => {
  const result = review();
  assert.deepEqual(result, NORMAL);
  assert.deepEqual(Object.keys(result), ['unverified', 'hasIssue', 'interventionReported', 'reasons']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.throws(() => { result.hasIssue = true; }, TypeError);
  assert.throws(() => { result.reasons.push('command'); }, TypeError);
  for (const key of ['allowed', 'allowedActions', 'retry', 'sync', 'captureAllowed', 'needsUserAction']) assert.equal(Object.hasOwn(result, key), false);
});

for (const captureKey of ['pending', 'running', 'completed', 'stopped']) {
  test(`normalized ${captureKey} does not itself create a problem or current to-do`, () => {
    assert.deepEqual(review({ captureKey }), NORMAL);
  });
}

for (const captureKey of ['partial', 'failed', 'needs_action']) {
  test(`normalized ${captureKey} exposes only its explicitly reported result issue`, () => {
    const interventionReported = captureKey === 'needs_action';
    const reason = interventionReported ? 'capture_intervention_reported' : `capture_${captureKey}`;
    assert.deepEqual(review({ captureKey }), expectation({ hasIssue: true, interventionReported }, [reason]));
  });
}

test('unrecognized normalized capture signals remain unverified without coercion', () => {
  for (const captureKey of ['unknown', 'success', 'completed ', 'NEEDS_ACTION', 'constructor', '__proto__', undefined, null, 1, {}, Symbol('private')]) {
    assert.deepEqual(review({ captureKey }), expectation({ unverified: true }, ['capture_unverified']));
  }
});

test('invalid record identities remain unverified without authorizing intervention', () => {
  for (const id of ['', 'with space', ' leading', 'trailing ', 'x'.repeat(129), '\u0000', '\u202E', '\uD800', null, undefined, 1, {}, []]) {
    assert.deepEqual(review({ id }), expectation({ unverified: true }, ['invalid_record_identity']));
  }
});

test('exact Unicode and prototype-looking IDs remain identities rather than review states', () => {
  for (const id of ['记录-😀', 'é', 'e\u0301', '__proto__', 'constructor', 'x'.repeat(128)]) assert.deepEqual(review({ id }), NORMAL);
});

for (const side of ['remote', 'local']) {
  for (const state of ['confirmed', 'pending']) {
    test(`${side} ${state} is not itself a failure or missing evidence`, () => {
      assert.deepEqual(review({ [side]: state }), NORMAL);
    });
  }
  test(`${side} failed is a known issue, not an implied user action`, () => {
    assert.deepEqual(review({ [side]: 'failed' }), expectation({ hasIssue: true }, [`${side}_failure_reported`]));
  });
  test(`${side} missing and malformed signals cannot imply success, failure, or intervention`, () => {
    for (const state of ['unknown', '', 'confirmed ', 'FAILED', '__proto__', 'constructor', undefined, null, true, 1, {}, [], Symbol('private')]) {
      assert.deepEqual(review({ [side]: state }), expectation({ unverified: true }, [`${side}_unverified`]));
    }
  });
}

test('unknown remote evidence does not hide an independently reported local failure', () => {
  const input = summary({ delivery: { remote: 'unknown', local: 'failed' } });
  const result = presentResult(input);
  assert.equal(result.delivery.key, 'remote_unconfirmed');
  assert.deepEqual(result.review, expectation({ unverified: true, hasIssue: true }, ['remote_unverified', 'local_failure_reported']));
  assert.equal(matchesResultFilter(result, 'unverified'), true);
  assert.equal(matchesResultFilter(result, 'issues'), true);
  assert.equal(matchesResultFilter(result, 'intervention'), false);
});

test('remote receipt with local persistence pending differs from local persistence failure', () => {
  const pending = presentResult(summary({ delivery: { remote: 'confirmed', local: 'pending' } }));
  const failed = presentResult(summary({ delivery: { remote: 'confirmed', local: 'failed' } }));
  assert.equal(pending.needsAttention, true);
  assert.equal(failed.needsAttention, true);
  assert.deepEqual(pending.review, NORMAL);
  assert.deepEqual(failed.review, expectation({ hasIssue: true }, ['local_failure_reported']));
  assert.equal(failed.review.interventionReported, false);
});

test('explicit reconciliation requires review but grants no retry or upload instruction', () => {
  assert.deepEqual(review({ reconciliation: true }), expectation({ hasIssue: true }, ['reconciliation_required']));
  for (const reconciliation of [undefined, false]) assert.deepEqual(review({ reconciliation }), NORMAL);
  for (const reconciliation of [null, 0, 1, 'true', 'false', {}, [], Symbol('private')]) {
    assert.deepEqual(review({ reconciliation }), expectation({ unverified: true }, ['reconciliation_unverified']));
  }
});

test('independent reasons coexist in a fixed identity/capture/remote/local/reconciliation order', () => {
  assert.deepEqual(review({ id: '', captureKey: 'needs_action', remote: 'unknown', local: 'failed', reconciliation: true }), {
    unverified: true, hasIssue: true, interventionReported: true,
    reasons: ['invalid_record_identity', 'capture_intervention_reported', 'remote_unverified', 'local_failure_reported', 'reconciliation_required'],
  });
});

test('presentation normalizes legacy capture aliases before deriving review', () => {
  for (const status of ['queued', 'succeeded', 'success', 'cancelled']) assert.deepEqual(presentResult(summary({ capture: { status } })).review, NORMAL);
  const stopped = presentResult(summary({ capture: { status: 'cancelled' } }));
  assert.equal(stopped.capture.key, 'stopped');
  assert.equal(stopped.needsAttention, true);
  assert.equal(matchesResultFilter(stopped, 'attention'), true);
  for (const filter of FILTERS.slice(2)) assert.equal(matchesResultFilter(stopped, filter), false);
});

test('source-provided review, action, and permission claims cannot replace derived review', () => {
  const result = presentResult(summary({ review: { unverified: true, hasIssue: true, interventionReported: true }, needsAttention: true, needsUserAction: true, captureAllowed: true, allowedActions: ['retry'] }));
  assert.deepEqual(result.review, NORMAL);
  assert.equal(result.needsAttention, false);
  for (const field of ['needsUserAction', 'captureAllowed', 'allowedActions']) assert.equal(Object.hasOwn(result, field), false);
});

test('presentation reads delivery primitives once and never executes selected or irrelevant getters', () => {
  const reads = { count: 0 }; const descriptors = { remote: 0, local: 0 };
  const delivery = new Proxy({ remote: 'unknown', local: 'failed' }, { getOwnPropertyDescriptor(target, key) {
    if (Object.hasOwn(descriptors, key)) descriptors[key] += 1;
    return Object.getOwnPropertyDescriptor(target, key);
  } });
  const input = summary({ delivery });
  for (const key of ['body', 'comments', 'review', 'needsUserAction', 'captureAllowed', 'allowedActions']) accessor(input, key, reads);
  accessor(input, 'reconciliationRequired', reads);
  const result = presentResult(input);
  assert.deepEqual(result.review, expectation({ unverified: true, hasIssue: true }, ['remote_unverified', 'local_failure_reported', 'reconciliation_unverified']));
  assert.deepEqual(descriptors, { remote: 1, local: 1 });
  assert.equal(reads.count, 0);
});

test('unknown evidence is safe for revoked proxies and non-coercible primitive inputs', () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const dangerous = { toString() { throw new Error('coerced'); }, valueOf() { throw new Error('coerced'); } };
  for (const value of [revoked.proxy, dangerous, Symbol('private')]) {
    assert.deepEqual(review({ id: value, captureKey: value, remote: value, local: value, reconciliation: value }), {
      unverified: true, hasIssue: false, interventionReported: false,
      reasons: ['invalid_record_identity', 'capture_unverified', 'remote_unverified', 'local_unverified', 'reconciliation_unverified'],
    });
  }
});

test('filter vocabulary is frozen, exact and independent from prototype lookup keys', () => {
  assert.deepEqual(RESULT_FILTERS, FILTERS);
  assert.equal(Object.isFrozen(RESULT_FILTERS), true);
  for (const filter of ['', 'ALL', 'constructor', '__proto__', 'toString', 'issues ', null, undefined, 1, {}, Symbol('private')]) assert.equal(matchesResultFilter(presentResult(summary()), filter), false);
});

test('filter matching accepts only explicit own-data true flags without running accessors', () => {
  const reads = { count: 0 };
  for (const [filter, flag] of [['unverified', 'unverified'], ['issues', 'hasIssue'], ['intervention', 'interventionReported']]) {
    assert.equal(matchesResultFilter({ review: { [flag]: true } }, filter), true);
    assert.equal(matchesResultFilter({ review: Object.create({ [flag]: true }) }, filter), false);
    assert.equal(matchesResultFilter(Object.create({ review: { [flag]: true } }), filter), false);
    assert.equal(matchesResultFilter({ review: accessor({}, flag, reads) }, filter), false);
    assert.equal(matchesResultFilter(accessor({}, 'review', reads), filter), false);
    for (const value of [false, 'true', 1, {}, null, undefined]) assert.equal(matchesResultFilter({ review: { [flag]: value } }, filter), false);
  }
  assert.equal(matchesResultFilter({ needsAttention: true }, 'attention'), true);
  assert.equal(matchesResultFilter(Object.create({ needsAttention: true }), 'attention'), false);
  assert.equal(matchesResultFilter(accessor({}, 'needsAttention', reads), 'attention'), false);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const filter of FILTERS.slice(1)) assert.equal(matchesResultFilter(revoked.proxy, filter), false);
  assert.equal(reads.count, 0);
});

for (const legacyStatus of ['draft', 'synced', 'failed']) {
  test(`historical ${legacyStatus} is unverified, not revived as a present failure or instruction`, () => {
    const adapted = adaptStoredSummary({ id: 'legacy-1', recordType: 'single_note', platform: 'xiaohongshu', status: legacyStatus,
      normalizedPayload: { title: '合成旧记录' }, capture: { status: 'needs_action' }, delivery: { remote: 'confirmed', local: 'failed' }, needsUserAction: true });
    const result = presentResult(adapted.summary);
    assert.deepEqual(result.review, expectation({ unverified: true }, ['capture_unverified', 'remote_unverified', 'local_unverified']));
    assert.equal(result.needsAttention, true);
    assert.equal(result.review.interventionReported, false);
    assert.equal(result.review.hasIssue, false);
  });
}

test('review matrix preserves legacy attention and every new filter remains its subset', () => {
  const captureStatuses = ['pending', 'queued', 'running', 'completed', 'succeeded', 'success', 'partial', 'failed', 'needs_action', 'stopped', 'cancelled', 'unknown', undefined, null];
  const deliveryStatuses = ['confirmed', 'pending', 'failed', 'unknown', undefined, null];
  for (const id of ['record-1', '']) for (const status of captureStatuses) for (const remote of deliveryStatuses) for (const local of deliveryStatuses) for (const reconciliationRequired of [undefined, false, true, null]) {
    const item = presentResult(summary({ id, capture: { status }, delivery: { remote, local }, reconciliationRequired }));
    const expectedLegacyAttention = !item.id || !['pending', 'running', 'completed'].includes(item.capture.key) || ['warning', 'danger'].includes(item.delivery.tone);
    assert.equal(item.needsAttention, expectedLegacyAttention);
    for (const filter of FILTERS.slice(2)) if (matchesResultFilter(item, filter)) assert.equal(item.needsAttention, true, filter);
    assert.equal(item.review.interventionReported, status === 'needs_action');
    if (item.review.interventionReported) assert.equal(item.review.hasIssue, true);
    assert.ok(item.review.reasons.length <= 5);
    assert.equal(new Set(item.review.reasons).size, item.review.reasons.length);
  }
});
