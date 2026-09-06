// Isolated protocol-planning tests only: this module does not authenticate,
// persist a hold, enforce production retries, or grant permission to replay.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import * as protocol from '../../prototypes/extension-sync-confirmation/server-hold-protocol.mjs';
import {hasSyncReconciliationSignal} from '../../utils/capture/sync-reconciliation-state.js';

const {planReconciliationHold} = protocol;
const stringFields = [
  'tenantId', 'parentId', 'resourceId', 'executionId', 'attemptId', 'agentId',
  'requestHash',
];
function scope(overrides = {}) {
  return {
    tenantId: 'tenant-a', lane: 'capture_item', parentId: 'parent-a',
    resourceId: 'item-a', executionId: 'execution-a', attemptId: 'attempt-a',
    agentId: 'agent-a', assignmentRevision: 1, requestHash: 'request-hash-a',
    ...overrides,
  };
}
function report(overrides = {}) {
  return {
    protocolVersion: 1, eventId: 'event-a', scope: scope(),
    signal: {reconciliationRequired: true}, ...overrides,
  };
}
function input(overrides = {}) {
  return {expectedScope: scope(), report: report(), ...overrides};
}
function denied(value, label) {
  const result = planReconciliationHold(value);
  assert.equal(result.decision, 'deny', label);
  assert.equal(result.proposedHold, undefined, 'denial must not propose a write');
  assert.equal(result.automaticReplayBlocked, true);
  assert.equal(result.terminalSuccessAllowed, false);
  return result;
}
function existingHold(overrides = {}) {
  return {
    protocolVersion: 1, state: 'held',
    resource: {tenantId: 'tenant-a', lane: 'capture_item', parentId: 'parent-a', resourceId: 'item-a'},
    originScope: scope(), eventId: 'event-a', ...overrides,
  };
}
function blocked(result) {
  assert.equal(result.automaticReplayBlocked, true);
  assert.equal(result.terminalSuccessAllowed, false);
}

test('server hold protocol exports only its planning and injected confirmation boundaries', () => {
  assert.deepEqual(Object.keys(protocol), ['confirmReconciliationHold', 'planReconciliationHold']);
});

test('both supported lanes may propose an atomic hold only with exact current identity', () => {
  for (const lane of ['capture_item', 'monitor_subscription']) {
    const expectedScope = scope({lane});
    const result = planReconciliationHold(input({
      expectedScope, report: report({scope: {...expectedScope}}),
    }));
    assert.equal(result.decision, 'require_atomic_hold');
    assert.ok(result.proposedHold && typeof result.proposedHold === 'object');
  }
});

test('missing and non-object envelopes cannot become a hold write', () => {
  for (const value of [undefined, null, false, 1, '', [], () => null, {}]) {
    denied(value, `invalid input type ${typeof value}`);
  }
  for (const value of [undefined, null, false, 1, '', [], () => null]) {
    denied(input({expectedScope: value}), 'invalid expected scope');
    denied(input({report: value}), 'invalid report');
    denied(input({report: report({scope: value})}), 'invalid report scope');
  }
});

test('every expected and reported identity string is validated without coercion or trimming', () => {
  const invalid = [undefined, null, false, 0, 1, '', ' ', ' padded', 'padded ',
    'line\nbreak', 'nul\0byte', 'del\x7fbyte', 'c1\u0080byte', 'nel\u0085byte',
    'apc\u009fbyte', 'x'.repeat(241), [], {}, new String('valid')];
  for (const field of stringFields) {
    for (const value of invalid) {
      denied(input({expectedScope: scope({[field]: value})}), `expected ${field}`);
      denied(input({report: report({scope: scope({[field]: value})})}), `report ${field}`);
    }
  }
});

test('identity strings at the size limit are retained exactly', () => {
  const expectedScope = scope(Object.fromEntries(stringFields.map(field => [field, 'x'.repeat(240)])));
  const result = planReconciliationHold(input({expectedScope,
    report: report({eventId: 'e'.repeat(240), scope: {...expectedScope}})}));
  assert.equal(result.decision, 'require_atomic_hold');
});

test('lane and assignment revision never accept aliases, numbers-as-strings or unsafe integers', () => {
  for (const lane of [undefined, null, '', 'capture-item', 'CAPTURE_ITEM', ' capture_item', 'other', []]) {
    denied(input({expectedScope: scope({lane})}));
    denied(input({report: report({scope: scope({lane})})}));
  }
  for (const assignmentRevision of [undefined, null, false, 0, -1, 1.5, '1', NaN,
    Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    denied(input({expectedScope: scope({assignmentRevision})}));
    denied(input({report: report({scope: scope({assignmentRevision})})}));
  }
  const expectedScope = scope({assignmentRevision: Number.MAX_SAFE_INTEGER});
  assert.equal(planReconciliationHold(input({expectedScope,
    report: report({scope: {...expectedScope}})})).decision, 'require_atomic_hold');
});

test('protocol version and event id are explicit bounded values', () => {
  for (const protocolVersion of [undefined, null, false, 0, 2, '1', 1.5]) {
    denied(input({report: report({protocolVersion})}));
  }
  for (const eventId of [undefined, null, false, 0, '', ' ', ' padded', 'padded ',
    'line\nbreak', 'nul\0byte', 'del\x7fbyte', 'c1\u0080byte', 'nel\u0085byte',
    'apc\u009fbyte', 'e'.repeat(241), [], {}]) {
    denied(input({report: report({eventId})}));
  }
});

test('every scope mismatch denies even a genuine signal and never updates current ownership', () => {
  for (const field of stringFields) {
    const candidate = input({report: report({scope: scope({[field]: `other-${field}`})})});
    const before = structuredClone(candidate);
    denied(candidate, field);
    assert.deepEqual(candidate, before);
  }
  denied(input({report: report({scope: scope({lane: 'monitor_subscription'})})}));
  denied(input({report: report({scope: scope({assignmentRevision: 2})})}));
  denied(input({expectedScope: scope({assignmentRevision: 2})}));
});

test('signal inspection has the same bounded strict semantics as the shipping pure classifier', () => {
  const signals = [
    undefined, null, false, 0, '', [], 'SYNC_RECONCILIATION_REQUIRED', {},
    {reconciliationRequired: true}, {requiresReconciliation: true},
    {code: 'SYNC_RECONCILIATION_REQUIRED'},
    {code: 'STREAMING_SYNC_RECONCILIATION_REQUIRED'},
    {code: 'LOCAL_CONFIRMATION_REQUIRED'},
    {error: {requiresReconciliation: true}},
    {error: {code: 'LOCAL_CONFIRMATION_REQUIRED'}},
    {streamingSync: {requiresReconciliation: true}},
    {streamingSync: {code: 'LOCAL_CONFIRMATION_REQUIRED'}},
    {reconciliationRequired: 'true'}, {requiresReconciliation: 1},
    {retryable: false}, {blockAutomaticReplay: true},
    {metadata: {reconciliationRequired: true}},
    {results: [{reconciliationRequired: true}]},
    {error: {error: {reconciliationRequired: true}}},
    {code: 'sync_reconciliation_required'},
    {message: 'SYNC_RECONCILIATION_REQUIRED'},
  ];
  for (const signal of signals) {
    const result = planReconciliationHold(input({report: report({signal})}));
    assert.equal(result.decision,
      hasSyncReconciliationSignal(signal) ? 'require_atomic_hold' : 'defer_existing');
    if (!hasSyncReconciliationSignal(signal)) assert.equal(result.proposedHold, undefined);
  }
});

test('contradictory success, cancellation and safety cannot make a true signal disappear', () => {
  for (const signal of [
    {reconciliationRequired: true, ok: true, status: 'completed', failedCount: 0},
    {requiresReconciliation: true, canceled: true, status: 'canceled'},
    {error: {code: 'LOCAL_CONFIRMATION_REQUIRED', securityBlocked: true}},
    {streamingSync: {reconciliationRequired: true, remainingCount: 0, drainCompleted: true}},
  ]) {
    assert.equal(planReconciliationHold(input({report: report({signal})})).decision,
      'require_atomic_hold');
  }
});

test('scope validation precedes legacy deferral when no signal exists', () => {
  denied(input({expectedScope: scope({tenantId: ''}), report: report({signal: {ok: true}})}));
  denied(input({report: report({scope: scope({attemptId: 'old-attempt'}), signal: {ok: true}})}));
  denied(input({report: report({protocolVersion: 0, signal: {ok: true}})}));
});

test('new hold proposals contain only a canonical resource fence and originating event identity', () => {
  const result = planReconciliationHold(input());
  assert.equal(result.decision, 'require_atomic_hold');
  blocked(result);
  assert.deepEqual(result.proposedHold, existingHold());
  assert.equal(result.hold, undefined);
});

test('same-event exact identity replay retains the existing hold without proposing another write', () => {
  const saved = existingHold();
  const result = planReconciliationHold(input({existingHold: saved}));
  assert.equal(result.decision, 'retain_hold');
  blocked(result);
  assert.deepEqual(result.hold, saved);
  assert.equal(result.proposedHold, undefined);
  assert.notEqual(result.hold, saved);
});

test('same event id cannot change its semantic payload from hold to ordinary success or failure', () => {
  for (const signal of [undefined, null, {}, {ok: true}, {ok: false},
    {reconciliationRequired: false}, {retryable: false}, {message: 'needs verification'}]) {
    const result = denied(input({existingHold: existingHold(), report: report({signal})}));
    assert.equal(result.reason, 'event_payload_conflict');
  }
});

test('same-event hold aliases retain the same semantic hold without storing transport bodies', () => {
  for (const signal of [{requiresReconciliation: true},
    {error: {code: 'LOCAL_CONFIRMATION_REQUIRED'}},
    {streamingSync: {reconciliationRequired: true}}]) {
    const result = planReconciliationHold(input({existingHold: existingHold(), report: report({signal})}));
    assert.equal(result.decision, 'retain_hold');
    blocked(result);
    assert.deepEqual(result.hold, existingHold());
    assert.equal(result.proposedHold, undefined);
  }
});

test('new valid event without a marker cannot clear an already held resource', () => {
  for (const signal of [undefined, null, {}, {ok: true, status: 'completed'},
    {reconciliationRequired: false, requiresReconciliation: false, drainCompleted: true}]) {
    const saved = existingHold();
    const result = planReconciliationHold(input({existingHold: saved,
      report: report({eventId: 'event-b', signal})}));
    assert.equal(result.decision, 'retain_hold');
    blocked(result);
    assert.deepEqual(result.hold, saved);
    assert.equal(result.proposedHold, undefined);
  }
});

test('success on a valid successor attempt retains the original resource fence and evidence identity', () => {
  const expectedScope = scope({executionId: 'execution-b', attemptId: 'attempt-b',
    agentId: 'agent-b', assignmentRevision: 2, requestHash: 'request-hash-b'});
  const saved = existingHold();
  const candidate = input({expectedScope, existingHold: saved,
    report: report({eventId: 'event-b', scope: {...expectedScope}, signal: {ok: true, status: 'completed'}})});
  const before = structuredClone(candidate);
  const result = planReconciliationHold(candidate);
  assert.equal(result.decision, 'retain_hold');
  blocked(result);
  assert.deepEqual(result.hold, saved, 'a successor may not overwrite the original hold identity');
  assert.deepEqual(candidate, before);
});

test('same event id cannot be reused with a different current execution identity', () => {
  for (const field of ['executionId', 'attemptId', 'agentId', 'requestHash', 'assignmentRevision']) {
    const expectedScope = scope({[field]: field === 'assignmentRevision' ? 2 : `new-${field}`});
    const result = denied(input({expectedScope, existingHold: existingHold(),
      report: report({scope: {...expectedScope}, signal: {ok: true}})}), field);
    assert.equal(result.reason, 'event_identity_conflict');
  }
});

test('old-attempt reports never update the current fence even when an old event id matches', () => {
  const expectedScope = scope({attemptId: 'attempt-b', assignmentRevision: 2});
  const saved = existingHold();
  const candidate = input({expectedScope, existingHold: saved});
  const before = structuredClone(candidate);
  const result = denied(candidate);
  assert.equal(result.reason, 'stale_report');
  assert.deepEqual(candidate, before);
});

test('existing hold cannot cross tenant, lane, parent or resource boundaries', () => {
  for (const field of ['tenantId', 'lane', 'parentId', 'resourceId']) {
    const value = field === 'lane' ? 'monitor_subscription' : `other-${field}`;
    const originScope = scope({[field]: value});
    const saved = existingHold({originScope,
      resource: {...existingHold().resource, [field]: value}, eventId: 'other-event'});
    const result = denied(input({existingHold: saved}));
    assert.equal(result.reason, 'hold_resource_mismatch');
  }
});

test('invalid hold envelopes and resource versus origin inconsistencies fail closed', () => {
  for (const value of [false, 1, '', [], {}, {state: 'resolved'},
    existingHold({protocolVersion: 0}), existingHold({state: 'resolved'}),
    existingHold({eventId: ''}), existingHold({originScope: null}),
    existingHold({resource: null}),
    existingHold({resource: {...existingHold().resource, resourceId: 'other-item'}}),
    existingHold({originScope: scope({assignmentRevision: 0})})]) {
    denied(input({existingHold: value}));
  }
});

test('new and retained output objects cannot mutate any caller-owned scope or hold', () => {
  const candidate = input();
  const before = structuredClone(candidate);
  const result = planReconciliationHold(candidate);
  assert.notEqual(result.proposedHold.originScope, candidate.expectedScope);
  assert.notEqual(result.proposedHold.originScope, candidate.report.scope);
  try { result.proposedHold.originScope.attemptId = 'mutated'; } catch (error) {
    assert.ok(error instanceof TypeError);
  }
  try { result.proposedHold.resource.resourceId = 'mutated'; } catch (error) {
    assert.ok(error instanceof TypeError);
  }
  assert.deepEqual(candidate, before);
  const saved = existingHold();
  const savedBefore = structuredClone(saved);
  const retained = planReconciliationHold(input({existingHold: saved}));
  assert.notEqual(retained.hold.originScope, saved.originScope);
  assert.notEqual(retained.hold.resource, saved.resource);
  try { retained.hold.originScope.attemptId = 'mutated'; } catch (error) {
    assert.ok(error instanceof TypeError);
  }
  try { retained.hold.resource.resourceId = 'mutated'; } catch (error) {
    assert.ok(error instanceof TypeError);
  }
  assert.deepEqual(saved, savedBefore);
});

test('planner does not read receipt bodies or generic caller write callbacks', () => {
  const forbidden = () => { throw new Error('forbidden evidence or effect access'); };
  const candidate = input();
  for (const field of ['receipt', 'body', 'rawResponse', 'operations', 'commit', 'write', 'dispatch']) {
    Object.defineProperty(candidate, field, {get: forbidden});
    Object.defineProperty(candidate.report, field, {get: forbidden});
    Object.defineProperty(candidate.report.signal, field, {get: forbidden});
  }
  const result = planReconciliationHold(candidate);
  assert.equal(result.decision, 'require_atomic_hold');
  assert.deepEqual(result.proposedHold, existingHold());
});

test('throwing getters in inspected input fields are denied rather than escaping or granting a write', () => {
  const getter = () => { throw new Error('invalid untrusted getter'); };
  const cases = [
    Object.defineProperty(input(), 'expectedScope', {get: getter}),
    input({expectedScope: Object.defineProperty(scope(), 'tenantId', {get: getter})}),
    input({report: Object.defineProperty(report(), 'protocolVersion', {get: getter})}),
    input({report: report({scope: Object.defineProperty(scope(), 'attemptId', {get: getter})})}),
    input({report: report({signal: Object.defineProperty({}, 'reconciliationRequired', {get: getter})})}),
    input({existingHold: Object.defineProperty(existingHold(), 'state', {get: getter})}),
  ];
  for (const candidate of cases) denied(candidate);
});

test('event identities are snapshotted once so validation and canonical output cannot disagree', () => {
  let reportReads = 0;
  const mutableReport = Object.defineProperty(report(), 'eventId', {
    get() { return ++reportReads === 1 ? 'event-a' : ''; },
  });
  const proposed = planReconciliationHold(input({report: mutableReport}));
  assert.equal(proposed.decision, 'require_atomic_hold');
  assert.equal(proposed.proposedHold.eventId, 'event-a');
  assert.equal(reportReads, 1);

  let holdReads = 0;
  const mutableHold = Object.defineProperty(existingHold(), 'eventId', {
    get() { return ++holdReads === 1 ? 'event-a' : ''; },
  });
  const retained = planReconciliationHold(input({existingHold: mutableHold}));
  assert.equal(retained.decision, 'retain_hold');
  assert.equal(retained.hold.eventId, 'event-a');
  assert.equal(holdReads, 1);
});

test('fresh protocol import and all decisions require no browser, network, storage or clock access', () => {
  const moduleUrl = new URL('../../prototypes/extension-sync-confirmation/server-hold-protocol.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    let accesses = 0;
    for (const key of ['chrome', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch',
      'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'requestAnimationFrame',
      'Date', 'performance', 'crypto']) {
      Object.defineProperty(globalThis, key, {configurable: true, get() {
        accesses += 1; throw new Error('forbidden global ' + key);
      }});
    }
    const {planReconciliationHold: plan} = await import(${JSON.stringify(moduleUrl)});
    const current = ${JSON.stringify(input())};
    const held = plan(current);
    assert.equal(held.decision, 'require_atomic_hold');
    assert.equal(plan({...current, existingHold: held.proposedHold}).decision, 'retain_hold');
    assert.equal(plan({...current, report: {...current.report, signal: {}}}).decision, 'defer_existing');
    assert.equal(plan({}).decision, 'deny');
    assert.equal(accesses, 0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {stdio: 'pipe'});
});
