import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRuntimeSchemaReady,
  closeDb,
  connectRuntimeDb,
  initDb,
  probeDbReadiness,
} from '../server/db/init.js';
import { loadMigrationInventory } from '../server/db/migration-inventory.js';
import { listMigrationVersions } from '../server/db/migrate.js';

test('runtime schema inventory includes current migrations and excludes destructive reset files', async () => {
  const versions = await listMigrationVersions();

  assert.ok(versions.includes('001_initial_postgres.sql'));
  assert.ok(versions.includes('066_tenant_comment_risk_attention.sql'));
  assert.ok(versions.every(version => !/reset/iu.test(version)));
  assert.deepEqual(versions, [...versions].sort());

  const inventory = await loadMigrationInventory();
  assert.deepEqual(inventory.map(migration => migration.version), versions);
  assert.ok(inventory.every(migration => /^[a-f0-9]{64}$/u.test(migration.checksumSha256)));
});

test('runtime schema check rejects an incomplete migration set without exposing connection data', async () => {
  const requiredMigrations = [
    { version: '001_initial_postgres.sql', checksumSha256: '1'.repeat(64) },
    { version: '066_tenant_comment_risk_attention.sql', checksumSha256: '6'.repeat(64) },
  ];

  await assert.rejects(
    assertRuntimeSchemaReady({
      requiredMigrations,
      queryAppliedMigrations: async () => [{
        version: '001_initial_postgres.sql',
        checksum_sha256: '1'.repeat(64),
        checksum_recorded_at: new Date(),
      }],
    }),
    error => {
      assert.equal(error.code, 'DATABASE_SCHEMA_NOT_READY');
      assert.equal(error.missingMigrationCount, 1);
      assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//u);
      return true;
    },
  );
});

test('runtime schema check rejects missing and mismatched checksum metadata', async () => {
  const requiredMigrations = [
    { version: '066_tenant_comment_risk_attention.sql', checksumSha256: '6'.repeat(64) },
  ];

  await assert.rejects(
    assertRuntimeSchemaReady({
      requiredMigrations,
      queryAppliedMigrations: async () => [{
        version: requiredMigrations[0].version,
        checksum_sha256: null,
        checksum_recorded_at: null,
      }],
    }),
    error => error.code === 'DATABASE_SCHEMA_CHECKSUMS_NOT_READY'
      && error.missingChecksumCount === 1,
  );

  await assert.rejects(
    assertRuntimeSchemaReady({
      requiredMigrations,
      queryAppliedMigrations: async () => [{
        version: requiredMigrations[0].version,
        checksum_sha256: '0'.repeat(64),
        checksum_recorded_at: new Date(),
      }],
    }),
    error => error.code === 'DATABASE_MIGRATION_CHECKSUM_MISMATCH'
      && error.mismatchedMigrationCount === 1,
  );
});

test('runtime schema check maps a legacy two-column ledger to an adoption error', async () => {
  const legacyColumnError = Object.assign(new Error('column does not exist'), { code: '42703' });
  await assert.rejects(
    assertRuntimeSchemaReady({
      requiredMigrations: [
        { version: '001_initial_postgres.sql', checksumSha256: '1'.repeat(64) },
      ],
      queryAppliedMigrations: async () => { throw legacyColumnError; },
    }),
    error => error.code === 'DATABASE_SCHEMA_CHECKSUMS_NOT_READY'
      && error.cause === legacyColumnError,
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

test('compatibility initialization migrates, runs audited database maintenance, then bootstraps once', async t => {
  await closeDb();
  t.after(closeDb);
  const events = [];
  const options = {
    migrate: async () => events.push('migrate'),
    databaseMaintenance: async () => events.push('database-maintenance'),
    bootstrap: async () => events.push('bootstrap'),
  };

  assert.equal(await initDb(options), true);
  assert.equal(await initDb(options), true);
  assert.deepEqual(events, ['migrate', 'database-maintenance', 'bootstrap']);
});
