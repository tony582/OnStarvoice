import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPendingOrchestrationRetryReconciler,
} from '../server/modules/capture/application/pending-orchestration-retry.js';

function dependencies(overrides = {}) {
  return {
    async withTransaction(callback) {
      return callback({kind: 'fake-transaction'});
    },
    async dispatchOnePendingRetry() {
      return {kind: 'empty'};
    },
    ...overrides,
  };
}

test('pending retry reconciler requires both application ports', () => {
  for (const dependency of ['withTransaction', 'dispatchOnePendingRetry']) {
    const ports = dependencies();
    delete ports[dependency];
    assert.throws(
      () => createPendingOrchestrationRetryReconciler(ports),
      new RegExp(`${dependency} must be a function`, 'u'),
    );
  }
});

test('pending retry reconciler preserves bounded limit normalization', async () => {
  const calls = [];
  for (const [input, expectedLimit] of [
    [undefined, 10],
    [0, 1],
    [Number.NaN, 10],
    [-8, 1],
    [800, 100],
    ['12', 12],
    [{limit: 7}, 7],
  ]) {
    const reconcile = createPendingOrchestrationRetryReconciler(
      dependencies({
        async dispatchOnePendingRetry(tx, options) {
          calls.push({tx, options});
          return {kind: 'empty'};
        },
      }),
    );
    assert.deepEqual(await reconcile(input), {
      inspected: 0,
      dispatched: 0,
      waitingForAgent: 0,
      stale: 0,
      invalidated: 0,
      failed: 0,
      results: [],
    });
    const call = calls.at(-1);
    assert.equal(call.tx.kind, 'fake-transaction');
    assert.equal(call.options.scanLimit, Math.max(20, expectedLimit));
    assert.deepEqual(call.options.excludedItemIds, []);
  }
});

test('pending retry reconciler keeps serial transactions and waiting exclusions', async () => {
  const responses = [
    {
      kind: 'waiting_for_agent',
      waitingCount: 2,
      checkedCount: 2,
      checkedItemIds: ['item-a', 'item-b'],
    },
    {kind: 'dispatched', taskId: 'retry-task'},
    {kind: 'stale', staleCount: 3, invalidatedCount: 2},
    {kind: 'empty'},
  ];
  const sequence = [];
  let transactionNumber = 0;
  const reconcile = createPendingOrchestrationRetryReconciler({
    async withTransaction(callback) {
      transactionNumber += 1;
      sequence.push(`tx:${transactionNumber}:start`);
      const result = await callback({transactionNumber});
      sequence.push(`tx:${transactionNumber}:end`);
      return result;
    },
    async dispatchOnePendingRetry(tx, options) {
      sequence.push({tx: tx.transactionNumber, ...options});
      return responses.shift();
    },
  });

  assert.deepEqual(await reconcile(10), {
    inspected: 3,
    dispatched: 1,
    waitingForAgent: 2,
    stale: 3,
    invalidated: 2,
    failed: 0,
    results: [
      {
        kind: 'waiting_for_agent',
        waitingCount: 2,
        checkedCount: 2,
        checkedItemIds: ['item-a', 'item-b'],
      },
      {kind: 'dispatched', taskId: 'retry-task'},
      {kind: 'stale', staleCount: 3, invalidatedCount: 2},
    ],
  });
  assert.deepEqual(sequence, [
    'tx:1:start',
    {tx: 1, scanLimit: 20, excludedItemIds: []},
    'tx:1:end',
    'tx:2:start',
    {tx: 2, scanLimit: 20, excludedItemIds: ['item-a', 'item-b']},
    'tx:2:end',
    'tx:3:start',
    {tx: 3, scanLimit: 20, excludedItemIds: ['item-a', 'item-b']},
    'tx:3:end',
    'tx:4:start',
    {tx: 4, scanLimit: 20, excludedItemIds: ['item-a', 'item-b']},
    'tx:4:end',
  ]);
});

test('pending retry reconciler isolates one worker failure and keeps scanning', async () => {
  let calls = 0;
  const reconcile = createPendingOrchestrationRetryReconciler(
    dependencies({
      async dispatchOnePendingRetry() {
        calls += 1;
        if (calls === 1) {
          const error = new Error('database message must not win');
          error.code = 'retry_worker_conflict';
          throw error;
        }
        return {kind: 'empty'};
      },
    }),
  );

  assert.deepEqual(await reconcile(2), {
    inspected: 0,
    dispatched: 0,
    waitingForAgent: 0,
    stale: 0,
    invalidated: 0,
    failed: 1,
    results: [{kind: 'failed', error: 'retry_worker_conflict'}],
  });
  assert.equal(calls, 2);
});
