import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRuntimeSchemaReady,
  connectRuntimeDb,
  probeDbReadiness,
} from '../server/db/init.js';
import { listMigrationVersions } from '../server/db/migrate.js';

test('runtime schema inventory includes current migrations and excludes destructive reset files', async () => {
  const versions = await listMigrationVersions();

  assert.ok(versions.includes('001_initial_postgres.sql'));
  assert.ok(versions.includes('066_tenant_comment_risk_attention.sql'));
  assert.ok(versions.every(version => !/reset/iu.test(version)));
  assert.deepEqual(versions, [...versions].sort());
});

test('runtime schema check rejects an incomplete migration set without exposing connection data', async () => {
  const requiredMigrationVersions = [
    '001_initial_postgres.sql',
    '066_tenant_comment_risk_attention.sql',
  ];

  await assert.rejects(
    assertRuntimeSchemaReady({
      requiredMigrationVersions,
      queryAppliedVersions: async () => [{ version: '001_initial_postgres.sql' }],
    }),
    error => {
      assert.equal(error.code, 'DATABASE_SCHEMA_NOT_READY');
      assert.equal(error.missingMigrationCount, 1);
      assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//u);
      return true;
    },
  );
});

test('independent connection and readiness probe both require connection then schema', async () => {
  for (const operation of [connectRuntimeDb, probeDbReadiness]) {
    const events = [];
    assert.equal(await operation({
      assertConnection: async () => events.push('connection'),
      checkSchema: async () => events.push('schema'),
    }), true);
    assert.deepEqual(events, ['connection', 'schema']);
  }
});
