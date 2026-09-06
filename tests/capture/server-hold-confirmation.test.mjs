import assert from 'node:assert/strict';
import test from 'node:test';
import {confirmSyncOperations} from '../../prototypes/extension-sync-confirmation/contract.mjs';
import {planReconciliationHold, confirmReconciliationHold} from '../../prototypes/extension-sync-confirmation/server-hold-protocol.mjs';
import {planMonitorFinish} from '../../prototypes/extension-sync-confirmation/monitor-finish-contract.mjs';

// In-memory adapter experiments, not a PostgreSQL integration or server release.
// The simulated adapter is responsible for locking/re-reading before a commit.
const clone = value => structuredClone(value);
function scope(overrides = {}) {
  return {tenantId: 'tenant-a', lane: 'capture_item', parentId: 'task-a', resourceId: 'item-a',
    executionId: 'execution-a', attemptId: 'attempt-a', agentId: 'agent-a',
    assignmentRevision: 1, requestHash: 'request-a', ...overrides};
}
function input(overrides = {}) {
  const expectedScope = scope();
  return {expectedScope, report: {protocolVersion: 1, scope: clone(expectedScope),
    eventId: 'event-a', signal: {reconciliationRequired: true}}, ...overrides};
}
const receipt = plan => ({committed: true, hold: clone(plan.proposedHold || plan.hold)});
const blocked = result => {
  assert.equal(result.automaticReplayBlocked, true);
  assert.equal(result.terminalSuccessAllowed, false);
  assert.equal('retryable' in result, false);
};

test('strict adapter confirmation returns a scoped hold receipt, not terminal success', async () => {
  let calls = 0;
  const request = input();
  const before = clone(request);
  const result = await confirmReconciliationHold({...request, persist: async plan => {calls++; return receipt(plan);}});
  assert.equal(calls, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.decision, 'hold_commit_confirmed');
  assert.deepEqual(result.hold.originScope, request.expectedScope);
  blocked(result);
  assert.deepEqual(request, before);
});

test('boolean truthiness, ok, and acknowledged fields are not commit receipts', async () => {
  for (const answer of [undefined, null, false, true, 1, 'true', {}, {ok: true},
    {acknowledged: true}, {committed: 'true'}, {committed: true}, {committed: true, hold: {}}]) {
    let calls = 0;
    const result = await confirmReconciliationHold({...input(), persist: async () => {calls++; return answer;}});
    assert.equal(result.accepted, false);
    assert.equal(result.decision, 'hold_commit_unconfirmed');
    assert.equal(calls, 1, 'the wrapper must not retry an ambiguous commit');
    blocked(result);
  }
});

test('receipt identity must match every scope field, event, and resource', async () => {
  for (const field of ['tenantId', 'lane', 'parentId', 'resourceId', 'executionId',
    'attemptId', 'agentId', 'requestHash', 'assignmentRevision']) {
    const result = await confirmReconciliationHold({...input(), persist: async plan => {
      const answer = receipt(plan);
      answer.hold.originScope[field] = field === 'assignmentRevision' ? 2 : 'different';
      return answer;
    }});
    assert.equal(result.accepted, false, field);
    blocked(result);
  }
  const wrongEvent = await confirmReconciliationHold({...input(), persist: async plan => {
    const answer = receipt(plan); answer.hold.eventId = 'other-event'; return answer;
  }});
  assert.equal(wrongEvent.reason, 'receipt_mismatch');
});

test('adapter mutation cannot rewrite the comparison snapshot or caller input', async () => {
  const request = input();
  const before = clone(request);
  const result = await confirmReconciliationHold({...request, persist: async plan => {
    plan.proposedHold.eventId = 'modified';
    plan.automaticReplayBlocked = false;
    return receipt(plan);
  }});
  assert.equal(result.accepted, false);
  assert.deepEqual(request, before);
  blocked(result);
});

test('commit exceptions and unreadable receipt fields remain ambiguous without replay', async () => {
  for (const persist of [async () => {throw new Error('commit or transport failed');},
    async () => Object.defineProperty({}, 'committed', {get() {throw new Error('unreadable');}})]) {
    const result = await confirmReconciliationHold({...input(), persist});
    assert.equal(result.reason, 'commit_outcome_unknown');
    assert.equal(result.accepted, false);
    blocked(result);
  }
});

test('missing adapter fails closed, but ordinary no-hold reports simply defer without I/O', async () => {
  const missing = await confirmReconciliationHold(input());
  assert.equal(missing.reason, 'adapter_required');
  blocked(missing);
  const request = input();
  request.report.signal = {ok: true};
  Object.defineProperty(request, 'persist', {get() {assert.fail('defer must not read adapter');}});
  assert.deepEqual(await confirmReconciliationHold(request), {decision: 'defer_existing'});
});

test('invalid and stale reports cannot invoke persistence', async () => {
  for (const request of [null, false, [], {}, input({expectedScope: null}),
    input({report: {...input().report, scope: scope({agentId: 'old-agent'})}})]) {
    let calls = 0;
    const withAdapter = request && typeof request === 'object' && !Array.isArray(request)
      ? {...request, persist: async () => {calls++; assert.fail('invalid report wrote state');}}
      : request;
    const result = await confirmReconciliationHold(withAdapter);
    assert.equal(result.accepted, false);
    assert.equal(result.decision, 'deny');
    assert.equal(calls, 0);
    blocked(result);
  }
});

test('irrelevant raw payloads and extra receipt fields never escape the receipt projection', async () => {
  const request = input();
  for (const key of ['rawResponse', 'receiptBody', 'token']) {
    Object.defineProperty(request, key, {get() {assert.fail(`unexpected input read ${key}`);}});
  }
  request.persist = async plan => {
    const answer = receipt(plan);
    Object.defineProperty(answer, 'rawResponse', {get() {assert.fail('unexpected receipt body read');}});
    return answer;
  };
  const result = await confirmReconciliationHold(request);
  assert.equal(result.accepted, true);
  assert.equal('rawResponse' in result, false);
  assert.deepEqual(Object.keys(result.hold).sort(), ['eventId', 'originScope', 'protocolVersion', 'resource', 'state']);
});

test('accepted receipts are independent snapshots on every call', async () => {
  let supplied;
  const first = await confirmReconciliationHold({...input(), persist: async plan => (supplied = receipt(plan))});
  supplied.hold.originScope.agentId = 'mutated-adapter';
  assert.equal(first.hold.originScope.agentId, 'agent-a');
  first.hold.resource.resourceId = 'mutated-consumer';
  const second = await confirmReconciliationHold({...input(), persist: async plan => receipt(plan)});
  assert.equal(second.hold.resource.resourceId, 'item-a');
});

function memoryAdapter({saved = null, assignment = scope(), loseFirstReply = false} = {}) {
  let hold = clone(saved);
  let writes = 0;
  let calls = 0;
  let tail = Promise.resolve();
  const persistFor = report => plan => {
    const turn = tail.then(async () => {
      calls++;
      // Simulated resource lock: re-read the assignment and persisted fence.
      const fresh = planReconciliationHold({expectedScope: assignment, report, existingHold: hold});
      if (fresh.decision === 'deny' || fresh.decision === 'defer_existing') return {committed: false};
      if (fresh.decision === 'require_atomic_hold') {hold = clone(fresh.proposedHold); writes++;}
      if (loseFirstReply && calls === 1) throw new Error('COMMIT succeeded, response lost');
      return {committed: true, hold: clone(hold)};
    });
    tail = turn.catch(() => {});
    return turn;
  };
  return {persistFor, get saved() {return clone(hold);}, get writes() {return writes;},
    get calls() {return calls;}, reassign(value) {assignment = clone(value);}};
}

test('lost post-commit reply never means the hold was not saved; explicit lookup recovers it', async () => {
  const request = input();
  const db = memoryAdapter({loseFirstReply: true});
  const first = await confirmReconciliationHold({...request, persist: db.persistFor(request.report)});
  assert.equal(first.accepted, false);
  assert.equal(first.reason, 'commit_outcome_unknown');
  assert.equal(db.calls, 1);
  assert.equal(db.writes, 1);
  assert.equal(db.saved.state, 'held');
  const afterLookup = await confirmReconciliationHold({...request,
    existingHold: db.saved, persist: db.persistFor(request.report)});
  assert.equal(afterLookup.accepted, true);
  assert.equal(db.writes, 1, 'same semantic event cannot add another side effect');
  blocked(afterLookup);
});

test('two simultaneous same-event reports confirm one simulated write', async () => {
  const db = memoryAdapter();
  const request = input();
  const answers = await Promise.all([1, 2].map(() => confirmReconciliationHold({...request,
    persist: db.persistFor(request.report)})));
  assert.equal(db.writes, 1);
  assert.equal(answers.every(answer => answer.accepted === true), true);
  answers.forEach(blocked);
});

test('competing hold events retain the first fence and never acknowledge a mismatching receipt', async () => {
  const db = memoryAdapter();
  const a = input();
  const b = input({report: {...input().report, eventId: 'event-b'}});
  const answers = await Promise.all([a, b].map(request => confirmReconciliationHold({...request,
    persist: db.persistFor(request.report)})));
  assert.equal(db.writes, 1);
  assert.equal(answers[0].accepted, true);
  assert.equal(answers[1].accepted, false);
  assert.equal(answers[1].reason, 'receipt_mismatch');
  assert.equal(db.saved.eventId, 'event-a');
  answers.forEach(blocked);
});

test('assignment changes between planning and locked persistence cannot confirm an old report', async () => {
  const db = memoryAdapter();
  const request = input();
  const result = await confirmReconciliationHold({...request, persist: plan => {
    db.reassign(scope({agentId: 'agent-b', attemptId: 'attempt-b', assignmentRevision: 2}));
    return db.persistFor(request.report)(plan);
  }});
  assert.equal(result.accepted, false);
  assert.equal(db.writes, 0);
  blocked(result);
});

test('simulated restart retains a resource fence across a new valid execution and successful report', async () => {
  const original = input();
  const beforeRestart = memoryAdapter();
  await confirmReconciliationHold({...original, persist: beforeRestart.persistFor(original.report)});
  const nextScope = scope({executionId: 'execution-b', attemptId: 'attempt-b', agentId: 'agent-b', assignmentRevision: 2});
  const restored = memoryAdapter({saved: beforeRestart.saved, assignment: nextScope});
  const report = {protocolVersion: 1, eventId: 'next-report', scope: nextScope, signal: {ok: true, status: 'succeeded'}};
  const result = await confirmReconciliationHold({expectedScope: nextScope, report,
    existingHold: restored.saved, persist: restored.persistFor(report)});
  assert.equal(result.accepted, true, 'only the retained HOLD receipt is confirmed, not this success');
  assert.equal(result.hold.originScope.attemptId, 'attempt-a');
  assert.equal(restored.writes, 0);
  blocked(result);
});

test('local confirmation failure preserves later remote ACKs before a simulated server hold', async () => {
  const operations = ['a', 'b', 'c'].map(id => ({operationId: `op-${id}`, recordId: id,
    stage: 'content', remoteState: 'acknowledged_success', remoteResult: {receipt: `remote-${id}`}}));
  let localCommits = 0;
  const ledger = await confirmSyncOperations({operations, commit: async () => ++localCommits === 1});
  assert.equal(localCommits, 2);
  assert.equal(ledger.requiresReconciliation, true);
  const request = input();
  request.report.signal = ledger;
  const db = memoryAdapter();
  const answer = await confirmReconciliationHold({...request, persist: db.persistFor(request.report)});
  assert.equal(answer.accepted, true);
  assert.equal(db.writes, 1);
  assert.equal(ledger.operations[2].remoteState, 'acknowledged_success');
  assert.equal(ledger.operations[2].localState, 'not_attempted');
  assert.equal(ledger.operations[2].remoteResult.receipt, 'remote-c');
  blocked(answer);
});

test('monitor finish cannot downgrade either an unconfirmed or confirmed hold receipt to legacy success', async () => {
  for (const loseFirstReply of [false, true]) {
    const monitorScope = scope({lane: 'monitor_subscription', parentId: 'subscription-a', resourceId: 'subscription-a'});
    const request = input({expectedScope: monitorScope,
      report: {...input().report, scope: monitorScope}});
    const db = memoryAdapter({assignment: monitorScope, loseFirstReply});
    const holdDecision = await confirmReconciliationHold({...request, persist: db.persistFor(request.report)});
    assert.equal(holdDecision.accepted, !loseFirstReply);
    for (const supported of [false, true]) {
      const finish = planMonitorFinish({signal: {ok: true}, holdDecision,
        capabilities: {reconciliationProtocolVersion: supported ? 1 : 0}});
      assert.equal(finish.decision, supported ? 'require_server_hold' : 'require_protocol_support');
      assert.equal(finish.legacyFinishAllowed, false);
      blocked(finish);
      assert.equal('accepted' in finish, false);
    }
  }
});
