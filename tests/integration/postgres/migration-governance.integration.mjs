import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import {
  assertGuarded,
  assertNoAdvisoryLocks,
  createGuardedChildEnvironment,
  safeIdentifier,
  spawnGuardedNode,
  stopChild,
  terminateApplications,
  waitForChildExit,
  waitForOutput,
  waitForQuery,
} from './p2d-test-helpers.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const serverRoot = path.join(repositoryRoot, 'server');
const guardPath = path.join(repositoryRoot, 'tests', 'fixtures', 'process-role-entrypoint-guard.mjs');

const slowMigrationName = '999_p2d_migration_lock_probe.sql';
const killedHolderMigrationName = '995_p2d_killed_holder_probe.sql';
const failingMigrationName = '996_p2d_transaction_failure_probe.sql';
const pendingMigrationName = '997_p2d_pending_after_tamper.sql';
const resetProbeName = '998_reset_p2d_forbidden.sql';
const legacyBaselineTargetName = '066_tenant_comment_risk_attention.sql';
const postBaselineMigrationName = '067_maintenance_runs.sql';

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

async function listTableColumns(pool, schema, table) {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    ORDER BY ordinal_position
  `, [schema, table]);
  return result.rows.map(row => row.column_name);
}

test('migration governance serializes processes, rejects drift, and explicitly adopts v066 legacy rows', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const { closePool, getPool } = await import('../../../server/db/pool.js');
  const pool = getPool();
  const runId = randomUUID().replaceAll('-', '');
  const schema = `p2d_migration_${runId}`;
  const legacySchema = `p2d_legacy_${runId}`;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'onstarvoice-p2d-migrations-'));
  const copiedServerRoot = path.join(tempRoot, 'server');
  const copiedMigrations = path.join(copiedServerRoot, 'db', 'migrations');
  const copiedEntrypoint = path.join(copiedServerRoot, 'entrypoints', 'maintenance.js');
  const runtimes = new Set();
  const applicationNames = new Set();
  const observedBackendPids = new Set();
  const schemas = [schema, legacySchema];

  assert.match(schema, /^p2d_migration_[a-f0-9]+$/u);
  assert.match(legacySchema, /^p2d_legacy_[a-f0-9]+$/u);

  const spawnMaintenance = ({ args, suffix, targetSchema = schema, extra = {} }) => {
    const applicationName = `p2d-migration-${runId}-${suffix}`;
    applicationNames.add(applicationName);
    const runtime = spawnGuardedNode({
      guardPath,
      scriptPath: copiedEntrypoint,
      args,
      cwd: copiedServerRoot,
      env: createGuardedChildEnvironment({
        databaseUrl: target.rawUrl,
        schema: targetSchema,
        applicationName,
        extra,
      }),
      label: `migration-${suffix}`,
    });
    runtimes.add(runtime);
    return runtime;
  };

  const observeBackendPids = async () => {
    const active = await pool.query(`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ANY($1::text[])
    `, [[...applicationNames]]);
    for (const row of active.rows) observedBackendPids.add(row.pid);
    return active.rows.map(row => row.pid);
  };

  t.after(async () => {
    const errors = [];
    for (const runtime of runtimes) {
      try { await stopChild(runtime); } catch (error) { errors.push(error); }
      try { assertGuarded(runtime); } catch (error) { errors.push(error); }
    }
    try {
      const terminated = await terminateApplications(pool, [...applicationNames]);
      for (const pid of terminated) observedBackendPids.add(pid);
      await assertNoAdvisoryLocks(pool, [...observedBackendPids]);
    } catch (error) {
      errors.push(error);
    }
    for (const targetSchema of schemas) {
      try { await pool.query(`DROP SCHEMA IF EXISTS ${safeIdentifier(targetSchema)} CASCADE`); } catch (error) {
        errors.push(error);
      }
      try {
        const remaining = await pool.query('SELECT to_regnamespace($1) AS namespace', [targetSchema]);
        assert.equal(remaining.rows[0].namespace, null, `schema ${targetSchema} was not removed`);
      } catch (error) {
        errors.push(error);
      }
    }
    try { await closePool(); } catch (error) { errors.push(error); }
    try { await rm(tempRoot, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    try { assert.equal(existsSync(tempRoot), false, 'temporary server copy was not removed'); } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'P2-D migration-governance cleanup failed');
    }
  });

  await cp(serverRoot, copiedServerRoot, {
    recursive: true,
    filter(source) {
      const name = path.basename(source);
      return name !== 'node_modules' && !name.startsWith('.env');
    },
  });
  assert.equal(existsSync(path.join(serverRoot, 'node_modules')), true, 'server dependencies are required');
  await symlink(path.join(serverRoot, 'node_modules'), path.join(copiedServerRoot, 'node_modules'), 'dir');

  await writeFile(path.join(copiedMigrations, slowMigrationName), `
    SELECT pg_sleep(1.2);
    CREATE TABLE p2d_migration_lock_probe (
      id integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO p2d_migration_lock_probe (id) VALUES (1);
  `, 'utf8');
  await writeFile(path.join(copiedMigrations, resetProbeName), `
    CREATE TABLE p2d_reset_must_never_execute (id integer PRIMARY KEY);
  `, 'utf8');
  await pool.query(`CREATE SCHEMA ${safeIdentifier(schema)}`);
  await pool.query(`CREATE SCHEMA ${safeIdentifier(legacySchema)}`);

  await t.test('two operating-system processes have one migration executor', async () => {
    const first = spawnMaintenance({ args: ['migrate'], suffix: 'first' });
    await waitForOutput(first, new RegExp(`Applying migration ${slowMigrationName}`, 'u'));
    await observeBackendPids();

    const second = spawnMaintenance({ args: ['migrate'], suffix: 'second' });
    await waitForQuery(
      observeBackendPids,
      pids => pids.length >= 2 || second.child.exitCode != null,
      3000,
    );

    const [firstExit, secondExit] = await Promise.all([
      waitForChildExit(first, 25_000),
      waitForChildExit(second, 25_000),
    ]);
    assert.deepEqual(firstExit, { code: 0, signal: null }, first.output());
    if (secondExit.code === 0) {
      assert.deepEqual(secondExit, { code: 0, signal: null }, second.output());
    } else {
      assert.equal(secondExit.signal, null, second.output());
      assert.match(
        second.output(),
        /MIGRATION_LOCK_(?:UNAVAILABLE|TIMEOUT)|migration lock/u,
        second.output(),
      );
    }
    assertGuarded(first);
    assertGuarded(second);

    assert.equal(
      countMatches(`${first.output()}\n${second.output()}`, new RegExp(`Applying migration ${slowMigrationName}`, 'gu')),
      1,
      'the slow migration must have exactly one executor',
    );
    const probe = await pool.query(`
      SELECT count(*)::integer AS count
      FROM ${safeIdentifier(schema)}.p2d_migration_lock_probe
    `);
    assert.equal(probe.rows[0].count, 1);

    const expectedFiles = (await readdir(copiedMigrations))
      .filter(file => file.endsWith('.sql') && !/reset/iu.test(file))
      .sort();
    const applied = await pool.query(`
      SELECT version, checksum_sha256
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version LIKE '%.sql'
      ORDER BY version
    `);
    assert.deepEqual(applied.rows.map(row => row.version), expectedFiles);
    assert.equal(applied.rows.every(row => /^[a-f0-9]{64}$/u.test(row.checksum_sha256)), true);
    assert.equal(applied.rows.some(row => row.version === resetProbeName), false);
    const resetRelation = await pool.query('SELECT to_regclass($1) AS relation', [
      `${schema}.p2d_reset_must_never_execute`,
    ]);
    assert.equal(resetRelation.rows[0].relation, null);
  });

  await t.test('a killed migration holder rolls back its transaction and releases the session lock', async () => {
    const killedMigrationPath = path.join(copiedMigrations, killedHolderMigrationName);
    await writeFile(killedMigrationPath, `
      SELECT pg_sleep(10);
      CREATE TABLE p2d_killed_holder_probe (id integer PRIMARY KEY);
      INSERT INTO p2d_killed_holder_probe (id) VALUES (1);
    `, 'utf8');

    const holder = spawnMaintenance({ args: ['migrate'], suffix: 'killed-holder' });
    await waitForOutput(holder, new RegExp(`Applying migration ${killedHolderMigrationName}`, 'u'));
    await waitForQuery(
      async () => Number((await pool.query(`
        SELECT count(*)::integer AS count
        FROM pg_stat_activity activity
        JOIN pg_locks lock ON lock.pid = activity.pid
        WHERE activity.application_name = $1
          AND activity.query LIKE '%pg_sleep%'
          AND lock.locktype = 'advisory'
          AND lock.granted = true
      `, [`p2d-migration-${runId}-killed-holder`])).rows[0].count),
      count => count > 0,
      5000,
    );
    await observeBackendPids();
    holder.child.kill('SIGKILL');
    const holderExit = await waitForChildExit(holder, 5000);
    assert.equal(holderExit.code, null, holder.output());
    assert.equal(holderExit.signal, 'SIGKILL', holder.output());
    assertGuarded(holder);

    const rolledBackRelation = await pool.query('SELECT to_regclass($1) AS relation', [
      `${schema}.p2d_killed_holder_probe`,
    ]);
    assert.equal(rolledBackRelation.rows[0].relation, null);
    const rolledBackVersion = await pool.query(`
      SELECT 1
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version = $1
    `, [killedHolderMigrationName]);
    assert.equal(rolledBackVersion.rowCount, 0);

    await writeFile(killedMigrationPath, `
      CREATE TABLE p2d_killed_holder_probe (id integer PRIMARY KEY);
      INSERT INTO p2d_killed_holder_probe (id) VALUES (1);
    `, 'utf8');
    const replacement = spawnMaintenance({ args: ['migrate'], suffix: 'killed-replacement' });
    assert.deepEqual(
      await waitForChildExit(replacement, 15_000),
      { code: 0, signal: null },
      replacement.output(),
    );
    assertGuarded(replacement);
    const replacementRows = await pool.query(`
      SELECT count(*)::integer AS count
      FROM ${safeIdentifier(schema)}.p2d_killed_holder_probe
    `);
    assert.equal(replacementRows.rows[0].count, 1);
  });

  await t.test('a failing migration rolls back both schema changes and checksum metadata', async () => {
    const failingMigrationPath = path.join(copiedMigrations, failingMigrationName);
    await writeFile(failingMigrationPath, `
      CREATE TABLE p2d_transaction_failure_probe (id integer PRIMARY KEY);
      INSERT INTO p2d_transaction_failure_probe (id) VALUES (1);
      SELECT definitely_missing_p2d_function();
    `, 'utf8');

    const failed = spawnMaintenance({ args: ['migrate'], suffix: 'transaction-failure' });
    assert.deepEqual(
      await waitForChildExit(failed, 15_000),
      { code: 1, signal: null },
      failed.output(),
    );
    assertGuarded(failed);
    const failedRelation = await pool.query('SELECT to_regclass($1) AS relation', [
      `${schema}.p2d_transaction_failure_probe`,
    ]);
    assert.equal(failedRelation.rows[0].relation, null);
    const failedVersion = await pool.query(`
      SELECT 1
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version = $1
    `, [failingMigrationName]);
    assert.equal(failedVersion.rowCount, 0);

    await writeFile(failingMigrationPath, `
      CREATE TABLE p2d_transaction_failure_probe (id integer PRIMARY KEY);
      INSERT INTO p2d_transaction_failure_probe (id) VALUES (1);
    `, 'utf8');
    const repaired = spawnMaintenance({ args: ['migrate'], suffix: 'transaction-repaired' });
    assert.deepEqual(
      await waitForChildExit(repaired, 15_000),
      { code: 0, signal: null },
      repaired.output(),
    );
    assertGuarded(repaired);
    const repairedMetadata = await pool.query(`
      SELECT checksum_sha256
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version = $1
    `, [failingMigrationName]);
    assert.match(repairedMetadata.rows[0].checksum_sha256, /^[a-f0-9]{64}$/u);
  });

  await t.test('the ordinary migrate path never enables reset files from inherited environment', async () => {
    const hostileReset = spawnMaintenance({
      args: ['migrate'],
      suffix: 'reset-hostile-env',
      extra: { ALLOW_RESET_MIGRATIONS: '1' },
    });
    const exit = await waitForChildExit(hostileReset, 15_000);
    assert.deepEqual(exit, { code: 1, signal: null }, hostileReset.output());
    assert.match(hostileReset.output(), /DATABASE_RESET_MIGRATIONS_DISABLED/u);
    assertGuarded(hostileReset);
    const resetRelation = await pool.query('SELECT to_regclass($1) AS relation', [
      `${schema}.p2d_reset_must_never_execute`,
    ]);
    assert.equal(resetRelation.rows[0].relation, null);
    const resetVersion = await pool.query(`
      SELECT 1
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version = $1
    `, [resetProbeName]);
    assert.equal(resetVersion.rowCount, 0);
  });

  await t.test('tampering an applied temporary SQL file blocks every pending migration', async () => {
    const checksumTarget = path.join(copiedMigrations, postBaselineMigrationName);
    const originalBytes = await readFile(checksumTarget);
    await writeFile(path.join(copiedMigrations, pendingMigrationName), `
      CREATE TABLE p2d_pending_after_checksum_mismatch (id integer PRIMARY KEY);
    `, 'utf8');
    await appendFile(checksumTarget, '\n-- P2-D test-only checksum drift\n', 'utf8');

    const drifted = spawnMaintenance({ args: ['migrate'], suffix: 'checksum-drift' });
    const driftedExit = await waitForChildExit(drifted, 15_000);
    assert.deepEqual(driftedExit, { code: 1, signal: null }, drifted.output());
    assert.match(
      drifted.output(),
      /DATABASE_MIGRATION_CHECKSUM_MISMATCH|checksum mismatch|checksum.*067/iu,
      drifted.output(),
    );
    assertGuarded(drifted);
    const pendingBeforeRestore = await pool.query('SELECT to_regclass($1) AS relation', [
      `${schema}.p2d_pending_after_checksum_mismatch`,
    ]);
    assert.equal(pendingBeforeRestore.rows[0].relation, null);
    const pendingVersionBeforeRestore = await pool.query(`
      SELECT 1
      FROM ${safeIdentifier(schema)}.schema_migrations
      WHERE version = $1
    `, [pendingMigrationName]);
    assert.equal(pendingVersionBeforeRestore.rowCount, 0);

    await writeFile(checksumTarget, originalBytes);
    const restored = spawnMaintenance({ args: ['migrate'], suffix: 'checksum-restored' });
    assert.deepEqual(
      await waitForChildExit(restored, 15_000),
      { code: 0, signal: null },
      restored.output(),
    );
    assertGuarded(restored);
    const pendingAfterRestore = await pool.query('SELECT to_regclass($1) AS relation', [
      `${schema}.p2d_pending_after_checksum_mismatch`,
    ]);
    assert.notEqual(pendingAfterRestore.rows[0].relation, null);
  });

  await t.test('a two-column v066 ledger rejects normal paths until explicit adoption', async () => {
    const postBaselinePath = path.join(copiedMigrations, postBaselineMigrationName);
    const postBaselineBytes = await readFile(postBaselinePath);
    await rm(postBaselinePath);
    await rm(path.join(copiedMigrations, pendingMigrationName));
    await rm(path.join(copiedMigrations, slowMigrationName));
    await rm(path.join(copiedMigrations, killedHolderMigrationName));
    await rm(path.join(copiedMigrations, failingMigrationName));

    const legacySeed = spawnMaintenance({
      args: ['migrate'],
      suffix: 'legacy-seed',
      targetSchema: legacySchema,
    });
    assert.deepEqual(
      await waitForChildExit(legacySeed, 20_000),
      { code: 0, signal: null },
      legacySeed.output(),
    );
    assertGuarded(legacySeed);

    const metadataColumns = await listTableColumns(pool, legacySchema, 'schema_migrations');
    const extraColumns = metadataColumns.filter(column => !['version', 'applied_at'].includes(column));
    assert.ok(extraColumns.length > 0, 'fresh migration ledger must contain checksum metadata');
    for (const column of extraColumns) {
      assert.match(column, /^[a-z_][a-z0-9_]*$/u);
      await pool.query(
        `ALTER TABLE ${safeIdentifier(legacySchema)}.schema_migrations DROP COLUMN "${column}"`,
      );
    }
    await pool.query(`
      INSERT INTO ${safeIdentifier(legacySchema)}.schema_migrations (version)
      VALUES ('p2d_legacy_non_sql_flag')
    `);
    const timestampBeforeAdoption = await pool.query(`
      SELECT applied_at
      FROM ${safeIdentifier(legacySchema)}.schema_migrations
      WHERE version = $1
    `, [legacyBaselineTargetName]);

    await writeFile(postBaselinePath, postBaselineBytes);

    for (const [suffix, args] of [
      ['legacy-verify-rejected', ['verify']],
      ['legacy-migrate-rejected', ['migrate']],
    ]) {
      const rejected = spawnMaintenance({ args, suffix, targetSchema: legacySchema });
      assert.deepEqual(
        await waitForChildExit(rejected, 15_000),
        { code: 1, signal: null },
        rejected.output(),
      );
      assert.match(
        rejected.output(),
        /DATABASE_MIGRATION_CHECKSUMS_NOT_READY|adopt-v066-checksums|legacy.*checksum/iu,
        rejected.output(),
      );
      assertGuarded(rejected);
    }
    assert.deepEqual(
      await listTableColumns(pool, legacySchema, 'schema_migrations'),
      ['version', 'applied_at'],
      'rejected paths must not silently alter the legacy ledger',
    );
    const postBaselineBeforeAdoption = await pool.query(`
      SELECT 1
      FROM ${safeIdentifier(legacySchema)}.schema_migrations
      WHERE version = $1
    `, [postBaselineMigrationName]);
    assert.equal(postBaselineBeforeAdoption.rowCount, 0);

    const adoption = spawnMaintenance({
      args: ['migrate', '--adopt-v066-checksums'],
      suffix: 'legacy-adopt',
      targetSchema: legacySchema,
    });
    assert.deepEqual(
      await waitForChildExit(adoption, 20_000),
      { code: 0, signal: null },
      adoption.output(),
    );
    assertGuarded(adoption);

    const adoptedColumns = await listTableColumns(pool, legacySchema, 'schema_migrations');
    assert.equal(adoptedColumns.includes('checksum_sha256'), true);
    const adoptedRows = await pool.query(`
      SELECT version, checksum_sha256, applied_at
      FROM ${safeIdentifier(legacySchema)}.schema_migrations
      WHERE version = ANY($1::text[])
      ORDER BY version
    `, [[legacyBaselineTargetName, postBaselineMigrationName, 'p2d_legacy_non_sql_flag']]);
    const byVersion = new Map(adoptedRows.rows.map(row => [row.version, row]));
    assert.match(byVersion.get(legacyBaselineTargetName).checksum_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      byVersion.get(legacyBaselineTargetName).applied_at.getTime(),
      timestampBeforeAdoption.rows[0].applied_at.getTime(),
      'adoption must preserve the original applied_at timestamp',
    );
    assert.match(byVersion.get(postBaselineMigrationName).checksum_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(byVersion.get('p2d_legacy_non_sql_flag').checksum_sha256, null);

    const ready = spawnMaintenance({ args: ['verify'], suffix: 'legacy-ready', targetSchema: legacySchema });
    assert.deepEqual(
      await waitForChildExit(ready, 15_000),
      { code: 0, signal: null },
      ready.output(),
    );
    assertGuarded(ready);
  });
});
