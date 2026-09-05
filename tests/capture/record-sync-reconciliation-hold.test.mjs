import assert from 'node:assert/strict';
import test from 'node:test';
import {createRecordSyncQueue} from '../../utils/record-sync-queue.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('held drain did not return')), 2000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(options = {}) {
  const active = deferred();
  const calls = [];
  const events = [];
  const queue = createRecordSyncQueue({
    processRecord: ({recordId}) => {
      calls.push(recordId);
      return active.promise;
    },
    shouldHoldForReconciliation: () => true,
    shouldRetry: () => true,
    retryDelaysMs: [0, 0],
    onStateChange: state => events.push(state),
    ...options,
  });
  return {queue, active, calls, events};
}

const receipt = () => ({ok: false, receipt: {acceptedIds: ['A', 'B']}});

test('held active/dirty/pending IDs remain unique and previously completed work stays settled', async () => {
  const {queue, active, calls, events} = fixture({
    processRecord: ({recordId}) => {
      calls.push(recordId);
      return recordId === 'P' ? {ok: true} : active.promise;
    },
    shouldHoldForReconciliation: result => result.ok === false,
  });
  queue.registerCaptured(['P', 'A', 'B']);
  queue.enqueue('P');
  await bounded(queue.drain());
  events.length = 0;
  queue.enqueue('A');
  queue.enqueue('B');
  queue.enqueue('A', {revision: 2});
  active.resolve(receipt());
  const stats = await bounded(queue.drain());
  assert.deepEqual(calls, ['P', 'A']);
  assert.deepEqual(stats.heldRecordIds, ['A', 'B']);
  assert.equal(stats.heldUniqueCount, 2);
  assert.equal(stats.remainingCount, 2);
  assert.equal(stats.activeCount, 0);
  assert.equal(stats.pendingCount, 1);
  assert.equal(stats.processedCount, 1);
  assert.equal(stats.successCount, 1);
  assert.equal(stats.succeededUniqueCount, 1);
  assert.equal(stats.failedCount, 0);
  assert.equal(stats.skippedCount, 0);
  assert.equal(stats.retryCount, 0);
  assert.equal(stats.reconciliationRequired, true);
  assert.equal(stats.drainCompleted, false);
  assert.equal(events.some(({phase}) => ['settled', 'drained', 'retry_wait', 'retrying'].includes(phase)), false);
  assert.equal(events.filter(({phase}) => phase === 'reconciliation_required').length, 1);
});

test('drain waits for in-flight result, then returns a hold instead of waiting on preserved pending work', async () => {
  const {queue, active} = fixture();
  queue.enqueue('A');
  queue.enqueue('B');
  let returned = false;
  const draining = queue.drain().then(stats => { returned = true; return stats; });
  await Promise.resolve();
  assert.equal(returned, false);
  active.resolve(receipt());
  assert.equal((await bounded(draining)).remainingCount, 2);
  assert.deepEqual(await bounded(queue.drain()), queue.getStats());
});

test('hold then cancellation retains receipt and all unresolved identities', async () => {
  const {queue, active, calls} = fixture();
  queue.enqueue('A');
  queue.enqueue('B');
  queue.enqueue('A');
  active.resolve(receipt());
  await bounded(queue.drain());
  assert.equal(queue.cancel('user stop'), true);
  assert.equal(queue.cancel('second stop'), false);
  const stats = await bounded(queue.drain());
  assert.equal(stats.canceled, true);
  assert.equal(stats.cancelReason, 'user stop');
  assert.equal(stats.remainingCount, 2);
  assert.deepEqual(queue.getReconciliationSnapshot().result, receipt());
  assert.deepEqual(calls, ['A']);
});

test('cancellation before late receipt retains IDs cleared by the legacy cancel path', async () => {
  const {queue, active, calls} = fixture();
  queue.enqueue('A');
  queue.enqueue('B');
  queue.enqueue('A');
  queue.cancel();
  assert.equal(queue.getStats().pendingCount, 0);
  active.resolve(receipt());
  const stats = await bounded(queue.drain());
  assert.equal(stats.canceled, true);
  assert.equal(stats.remainingCount, 2);
  assert.deepEqual(queue.getReconciliationSnapshot().heldRecordIds, ['A', 'B']);
  assert.equal(stats.processedCount, 0);
  assert.deepEqual(calls, ['A']);
});

test('AbortSignal before late receipt also retains canceled pending IDs', async () => {
  const controller = new AbortController();
  const {queue, active} = fixture({signal: controller.signal});
  queue.enqueue('A');
  queue.enqueue('B');
  controller.abort();
  active.resolve(receipt());
  const stats = await bounded(queue.drain());
  assert.equal(stats.cancelReason, 'aborted');
  assert.deepEqual(stats.heldRecordIds, ['A', 'B']);
});

test('held enqueue registers later captures without dispatch or exclusion', async () => {
  const {queue, active, calls} = fixture();
  queue.enqueue('A');
  active.resolve(receipt());
  await bounded(queue.drain());
  queue.registerCaptured(['A', 'B', 'C']);
  assert.equal(queue.enqueue('A'), false);
  assert.equal(queue.enqueue('B'), true);
  assert.equal(queue.enqueue('B'), false);
  assert.equal(queue.enqueueMissing(['B', 'C']), 1);
  assert.equal(queue.hasSeen('C'), true);
  assert.equal(queue.markExcluded('C'), false);
  const stats = await bounded(queue.drain());
  assert.deepEqual(stats.heldRecordIds, ['A', 'B', 'C']);
  assert.equal(stats.remainingCount, 3);
  assert.equal(stats.excludedUniqueCount, 0);
  assert.equal(stats.enqueuedUniqueCount, 3);
  assert.deepEqual(calls, ['A']);
});

test('guard, caller, progress callback and snapshot readers cannot mutate the held evidence', async () => {
  const result = receipt();
  const meta = {nested: {revision: 1}};
  const {queue, active} = fixture({
    shouldHoldForReconciliation: (input, context) => {
      input.receipt.acceptedIds.length = 0;
      context.meta.nested.revision = 999;
      return true;
    },
    onStateChange: state => { state.heldRecordIds?.splice(0); },
  });
  assert.equal(queue.getReconciliationSnapshot(), null);
  queue.enqueue('A', meta);
  active.resolve(result);
  await bounded(queue.drain());
  assert.equal(meta.nested.revision, 1);
  result.receipt.acceptedIds.length = 0;
  const snapshot = queue.getReconciliationSnapshot();
  snapshot.result.receipt.acceptedIds.length = 0;
  snapshot.heldRecordIds.length = 0;
  queue.getStats().heldRecordIds.length = 0;
  assert.deepEqual(queue.getReconciliationSnapshot().result, receipt());
  assert.deepEqual(queue.getStats().heldRecordIds, ['A']);
});

test('high frequency stats and hold events contain no full receipt', async () => {
  const {queue, active, events} = fixture();
  queue.enqueue('A');
  active.resolve({ok: false, receipt: {body: 'x'.repeat(100_000)}});
  await bounded(queue.drain());
  assert.ok(JSON.stringify(queue.getStats()).length < 1000);
  assert.ok(JSON.stringify(events).length < 5000);
  assert.equal(queue.getReconciliationSnapshot().result.receipt.body.length, 100_000);
});

test('guard receives one-based attempt after ordinary retry, then prevents further retries', async () => {
  const attempts = [];
  let calls = 0;
  const queue = createRecordSyncQueue({
    processRecord: async () => { calls += 1; return {ok: false}; },
    shouldRetry: () => true,
    retryDelaysMs: [0, 0],
    shouldHoldForReconciliation: (_, context) => {
      attempts.push(context);
      return context.attempt === 2;
    },
  });
  queue.enqueue('A', {revision: 7});
  const stats = await bounded(queue.drain());
  assert.deepEqual(attempts, [1, 2].map(attempt => ({recordId: 'A', meta: {revision: 7}, attempt})));
  assert.equal(calls, 2);
  assert.equal(stats.retryCount, 1);
  assert.equal(stats.processedCount, 0);
  assert.equal(queue.getReconciliationSnapshot().attempt, 2);
});

test('guard exception fails closed without settling or retrying', async () => {
  const {queue, active} = fixture({shouldHoldForReconciliation: () => { throw new Error('broken'); }});
  queue.enqueue('A');
  active.resolve(receipt());
  assert.equal((await bounded(queue.drain())).processedCount, 0);
  assert.equal(queue.getReconciliationSnapshot().guardError, 'RECONCILIATION_GUARD_FAILED');
});

for (const [label, guard] of [
  ['undefined', () => undefined],
  ['truthy object', () => ({hold: true})],
  ['resolved Promise', async () => false],
  ['rejected Promise', async () => { throw new Error('not a synchronous guard'); }],
]) {
  test(`invalid ${label} guard result fails closed`, async () => {
    const {queue, active} = fixture({shouldHoldForReconciliation: guard});
    queue.enqueue('A');
    active.resolve(receipt());
    const stats = await bounded(queue.drain());
    assert.equal(stats.reconciliationRequired, true);
    assert.equal(stats.retryCount, 0);
    assert.equal(queue.getReconciliationSnapshot().guardError, 'RECONCILIATION_GUARD_INVALID_RESULT');
  });
}

test('uncloneable evidence remains held and is explicitly unavailable, not reported as complete', async () => {
  let guardCalls = 0;
  const {queue, active} = fixture({shouldHoldForReconciliation: () => { guardCalls += 1; return false; }});
  queue.enqueue('A');
  active.resolve({ok: false, receipt: () => 'uncloneable'});
  assert.equal((await bounded(queue.drain())).remainingCount, 1);
  const snapshot = queue.getReconciliationSnapshot();
  assert.equal(snapshot.evidenceUnavailable, true);
  assert.equal(snapshot.result, null);
  assert.equal(guardCalls, 0);
});

test('invalid constructor guards throw before processing starts', () => {
  for (const value of [false, true, {}, 1, 'guard']) {
    assert.throws(() => createRecordSyncQueue({
      processRecord: async () => ({ok: true}), shouldHoldForReconciliation: value,
    }), /guard must be a function or null/);
  }
});

test('absent/null guards keep the legacy API and stats shape, without inspecting proposed new fields', async () => {
  for (const options of [{}, {shouldHoldForReconciliation: null}]) {
    const queue = createRecordSyncQueue({
      processRecord: async () => ({ok: true, reconciliationRequired: true}),
      ...options,
    });
    assert.equal('getReconciliationSnapshot' in queue, false);
    queue.enqueue('A');
    const stats = await bounded(queue.drain());
    assert.equal(stats.successCount, 1);
    assert.equal(stats.remainingCount, 0);
    assert.equal('reconciliationRequired' in stats, false);
    assert.equal('drainCompleted' in stats, false);
  }
});

test('false guard preserves normal settlement and isolates guard mutations from the result', async () => {
  const queue = createRecordSyncQueue({
    processRecord: async () => ({ok: true}),
    shouldHoldForReconciliation: result => { result.ok = false; return false; },
  });
  queue.enqueue('A');
  const stats = await bounded(queue.drain());
  assert.equal(stats.successCount, 1);
  assert.equal('reconciliationRequired' in stats, false);
  assert.equal(queue.getReconciliationSnapshot(), null);
});

test('cancel then non-held settlement does not expose temporary canceled IDs as hold evidence', async () => {
  const {queue, active} = fixture({shouldHoldForReconciliation: () => false});
  queue.enqueue('A');
  queue.enqueue('B');
  queue.cancel();
  active.resolve({ok: true});
  const stats = await bounded(queue.drain());
  assert.equal(stats.remainingCount, 0);
  assert.equal(stats.successCount, 1);
  assert.equal(queue.getReconciliationSnapshot(), null);
  assert.equal('heldRecordIds' in stats, false);
});
