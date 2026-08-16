import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createPendingCaptureCommandReconciler,
} from '../server/modules/capture/application/command-lifecycle.js';

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
    async listPendingTenants() {
      return [];
    },
    async withTransaction(callback) {
      return callback({id: 'tx'});
    },
    async expireTenantCommands() {
      return [];
    },
    ...overrides,
  };
}

test('pending command reconciler requires every application port', () => {
  for (const dependency of [
    'listPendingTenants',
    'withTransaction',
    'expireTenantCommands',
  ]) {
    const dependencies = successfulDependencies();
    delete dependencies[dependency];
    assert.throws(
      () => createPendingCaptureCommandReconciler(dependencies),
      new RegExp(`${dependency} must be a function`, 'u'),
    );
  }
});

test('pending command reconciler preserves tenant limit normalization', async () => {
  const limits = [];
  const reconcile = createPendingCaptureCommandReconciler(
    successfulDependencies({
      async listPendingTenants(limit) {
        limits.push(limit);
        return [];
      },
    }),
  );

  for (const options of [
    undefined,
    {tenantLimit: 0},
    {tenantLimit: Number.NaN},
    {tenantLimit: -8},
    {tenantLimit: 800},
    {tenantLimit: '12'},
  ]) {
    assert.deepEqual(await reconcile(options), {
      tenantCount: 0,
      commandCount: 0,
    });
  }
  assert.deepEqual(limits, [100, 100, 100, 1, 500, 12]);
});

test('pending command reconciler processes tenants serially in separate transactions', async () => {
  const sequence = [];
  const tenants = [{tenant_id: 'tenant-a'}, {tenant_id: 'tenant-b'}];
  let transactionNumber = 0;
  const reconcile = createPendingCaptureCommandReconciler({
    async listPendingTenants(limit) {
      sequence.push(`list:${limit}`);
      return tenants;
    },
    async withTransaction(callback) {
      transactionNumber += 1;
      const tx = {id: `tx-${transactionNumber}`};
      sequence.push(`begin:${tx.id}`);
      const result = await callback(tx);
      sequence.push(`commit:${tx.id}`);
      return result;
    },
    async expireTenantCommands(tx, tenantId) {
      sequence.push(`expire:${tx.id}:${tenantId}`);
      return tenantId === 'tenant-a' ? [{id: 1}, {id: 2}] : [{id: 3}];
    },
  });

  assert.deepEqual(await reconcile({tenantLimit: 2}), {
    tenantCount: 2,
    commandCount: 3,
  });
  assert.deepEqual(sequence, [
    'list:2',
    'begin:tx-1',
    'expire:tx-1:tenant-a',
    'commit:tx-1',
    'begin:tx-2',
    'expire:tx-2:tenant-b',
    'commit:tx-2',
  ]);
});

test('concurrent pending command reconciliation shares the first in-flight run', async () => {
  const tenantList = deferred();
  const limits = [];
  const reconcile = createPendingCaptureCommandReconciler(
    successfulDependencies({
      async listPendingTenants(limit) {
        limits.push(limit);
        if (limits.length === 1) return tenantList.promise;
        return [];
      },
    }),
  );

  const first = reconcile({tenantLimit: 7});
  const overlapping = reconcile({tenantLimit: 42});
  await Promise.resolve();
  assert.deepEqual(limits, [7]);
  tenantList.resolve([]);
  assert.deepEqual(await Promise.all([first, overlapping]), [
    {tenantCount: 0, commandCount: 0},
    {tenantCount: 0, commandCount: 0},
  ]);

  assert.deepEqual(await reconcile({tenantLimit: 9}), {
    tenantCount: 0,
    commandCount: 0,
  });
  assert.deepEqual(limits, [7, 9]);
});

test('failed reconciliation preserves earlier commits and resets single-flight state', async () => {
  const sequence = [];
  let run = 0;
  const reconcile = createPendingCaptureCommandReconciler({
    async listPendingTenants() {
      run += 1;
      return run === 1
        ? [{tenant_id: 'tenant-a'}, {tenant_id: 'tenant-b'}, {tenant_id: 'tenant-c'}]
        : [];
    },
    async withTransaction(callback) {
      const tenantRun = sequence.filter(item => item.startsWith('begin:')).length + 1;
      const tx = {id: `tx-${tenantRun}`};
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
    async expireTenantCommands(tx, tenantId) {
      sequence.push(`expire:${tx.id}:${tenantId}`);
      if (tenantId === 'tenant-b') throw new Error('tenant-b failed');
      return [{tenantId}];
    },
  });

  await assert.rejects(reconcile(), /tenant-b failed/u);
  assert.deepEqual(sequence, [
    'begin:tx-1',
    'expire:tx-1:tenant-a',
    'commit:tx-1',
    'begin:tx-2',
    'expire:tx-2:tenant-b',
    'rollback:tx-2',
  ]);
  assert.deepEqual(await reconcile(), {tenantCount: 0, commandCount: 0});
  assert.equal(run, 2);
});

test('command lifecycle module is route and Express independent', () => {
  const source = readFileSync(
    path.join(
      repositoryRoot,
      'server',
      'modules',
      'capture',
      'application',
      'command-lifecycle.js',
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"][^'"]*routes\//u);
  assert.doesNotMatch(source, /from ['"]express['"]/u);
  assert.doesNotMatch(source, /\bRouter\s*\(/u);
  assert.doesNotMatch(source, /\b(?:req|res)\s*\./u);
});
