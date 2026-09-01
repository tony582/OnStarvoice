import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createElasticCaptureLeaseReconciler,
} from '../server/modules/capture/application/lease-reconciliation.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise, resolve, reject};
}

function successfulDependencies(overrides = {}) {
  return {
    async listCandidates() {
      return [];
    },
    async withTransaction(callback) {
      return callback({id: 'tx'});
    },
    async settleCandidate() {
      return false;
    },
    ...overrides,
  };
}

test('elastic lease reconciler requires every application port', () => {
  for (const dependency of [
    'listCandidates',
    'withTransaction',
    'settleCandidate',
  ]) {
    const dependencies = successfulDependencies();
    delete dependencies[dependency];
    assert.throws(
      () => createElasticCaptureLeaseReconciler(dependencies),
      new RegExp(`${dependency} must be a function`, 'u'),
    );
  }
});

test('elastic lease reconciler can adapt a richer production reconciliation', async () => {
  const inputs = [];
  const reconcile = createElasticCaptureLeaseReconciler({
    async reconcileLeases(input) {
      inputs.push(input);
      return {
        scanned: 2,
        requeued: 1,
        skipped: 0,
        sourceClosureBlocked: 1,
      };
    },
  });
  const scope = {
    limit: 25,
    tenantId: 'tenant-a',
    parentTaskIds: ['task-a'],
  };
  assert.deepEqual(await reconcile(scope), {
    scanned: 2,
    requeued: 1,
    skipped: 0,
    sourceClosureBlocked: 1,
  });
  assert.deepEqual(inputs, [scope]);
});

test('elastic lease reconciler preserves candidate limit normalization', async () => {
  const limits = [];
  const reconcile = createElasticCaptureLeaseReconciler(
    successfulDependencies({
      async listCandidates(limit) {
        limits.push(limit);
        return [];
      },
    }),
  );

  for (const limit of [
    undefined,
    0,
    Number.NaN,
    -8,
    800,
    '12',
  ]) {
    assert.deepEqual(await reconcile(limit), {
      scanned: 0,
      requeued: 0,
      skipped: 0,
    });
  }
  assert.deepEqual(limits, [50, 50, 50, 1, 200, 12]);
});

test('elastic lease reconciler processes candidates serially in separate transactions', async () => {
  const sequence = [];
  const candidates = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
  let transactionNumber = 0;
  const reconcile = createElasticCaptureLeaseReconciler({
    async listCandidates(limit) {
      sequence.push(`list:${limit}`);
      return candidates;
    },
    async withTransaction(callback) {
      transactionNumber += 1;
      const tx = {id: `tx-${transactionNumber}`};
      sequence.push(`begin:${tx.id}`);
      const result = await callback(tx);
      sequence.push(`commit:${tx.id}`);
      return result;
    },
    async settleCandidate(tx, candidate) {
      sequence.push(`settle:${tx.id}:${candidate.id}`);
      return candidate.id !== 'b';
    },
  });

  assert.deepEqual(await reconcile(3), {
    scanned: 3,
    requeued: 2,
    skipped: 1,
  });
  assert.deepEqual(sequence, [
    'list:3',
    'begin:tx-1',
    'settle:tx-1:a',
    'commit:tx-1',
    'begin:tx-2',
    'settle:tx-2:b',
    'commit:tx-2',
    'begin:tx-3',
    'settle:tx-3:c',
    'commit:tx-3',
  ]);
});

test('failed lease reconciliation preserves earlier commits and stops later candidates', async () => {
  const sequence = [];
  let run = 0;
  const reconcile = createElasticCaptureLeaseReconciler({
    async listCandidates() {
      run += 1;
      return run === 1
        ? [{id: 'a'}, {id: 'b'}, {id: 'c'}]
        : [];
    },
    async withTransaction(callback) {
      const transactionNumber =
        sequence.filter(item => item.startsWith('begin:')).length + 1;
      const tx = {id: `tx-${transactionNumber}`};
      sequence.push(`begin:${tx.id}`);
      try {
        const result = await callback(tx);
        sequence.push(`commit:${tx.id}`);
        return result;
      } catch (error) {
        sequence.push(`rollback:${tx.id}`);
        throw error;
      }
    },
    async settleCandidate(tx, candidate) {
      sequence.push(`settle:${tx.id}:${candidate.id}`);
      if (candidate.id === 'b') throw new Error('candidate-b failed');
      return true;
    },
  });

  await assert.rejects(reconcile(), /candidate-b failed/u);
  assert.deepEqual(sequence, [
    'begin:tx-1',
    'settle:tx-1:a',
    'commit:tx-1',
    'begin:tx-2',
    'settle:tx-2:b',
    'rollback:tx-2',
  ]);
  assert.deepEqual(await reconcile(), {
    scanned: 0,
    requeued: 0,
    skipped: 0,
  });
  assert.equal(run, 2);
});

test('overlapping lease reconciliations remain independent', async () => {
  const firstCandidates = deferred();
  const limits = [];
  const reconcile = createElasticCaptureLeaseReconciler(
    successfulDependencies({
      async listCandidates(limit) {
        limits.push(limit);
        return limits.length === 1 ? firstCandidates.promise : [];
      },
    }),
  );

  const first = reconcile(7);
  const overlapping = reconcile(42);
  await Promise.resolve();
  assert.deepEqual(limits, [7, 42]);
  firstCandidates.resolve([]);
  assert.deepEqual(await Promise.all([first, overlapping]), [
    {scanned: 0, requeued: 0, skipped: 0},
    {scanned: 0, requeued: 0, skipped: 0},
  ]);
});

test('lease reconciliation module is route and Express independent', () => {
  const source = readFileSync(
    path.join(
      repositoryRoot,
      'server',
      'modules',
      'capture',
      'application',
      'lease-reconciliation.js',
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"][^'"]*routes\//u);
  assert.doesNotMatch(source, /from ['"]express['"]/u);
  assert.doesNotMatch(source, /\bRouter\s*\(/u);
  assert.doesNotMatch(source, /\b(?:req|res)\s*\./u);
});
