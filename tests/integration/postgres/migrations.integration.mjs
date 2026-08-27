import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

test('all non-reset migrations apply idempotently to an isolated PostgreSQL database', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });

  const { runMigrations } = await import('../../../server/db/migrate.js');
  const { closePool, getPool } = await import('../../../server/db/pool.js');
  t.after(closePool);

  await runMigrations();
  await runMigrations();

  const pool = getPool();
  const current = await pool.query('SELECT current_database() AS name');
  assert.match(current.rows[0].name, /^onstarvoice_(?:ci|test)(?:_|$)/u);

  const migrationDirectory = path.join(repositoryRoot, 'server', 'db', 'migrations');
  const migrationFiles = (await readdir(migrationDirectory))
    .filter(file => file.endsWith('.sql'))
    .sort();
  const expectedApplied = migrationFiles.filter(file => !/reset/iu.test(file));
  const expectedSkipped = migrationFiles.filter(file => /reset/iu.test(file));

  const applied = await pool.query(
    "SELECT version FROM schema_migrations WHERE version LIKE '%.sql' ORDER BY version",
  );
  const appliedVersions = applied.rows.map(row => row.version);

  assert.deepEqual(appliedVersions, expectedApplied);
  for (const resetMigration of expectedSkipped) {
    assert.equal(appliedVersions.includes(resetMigration), false);
  }

  const coreTables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [[
    'capture_agents',
    'capture_tasks',
    'records',
    'schema_migrations',
    'tenants',
  ]]);

  assert.deepEqual(
    coreTables.rows.map(row => row.table_name),
    ['capture_agents', 'capture_tasks', 'records', 'schema_migrations', 'tenants'],
  );

  const heartbeatColumns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'capture_agents'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [[
    'last_full_heartbeat_at',
    'last_heartbeat_at',
    'last_liveness_at',
  ]]);
  assert.deepEqual(
    heartbeatColumns.rows.map(row => row.column_name),
    [
      'last_full_heartbeat_at',
      'last_heartbeat_at',
      'last_liveness_at',
    ],
  );

  const legacyTenant = await pool.query(`
    INSERT INTO tenants (name)
    VALUES ($1)
    RETURNING id
  `, [`Heartbeat migration ${Date.now()}`]);
  const legacyHeartbeatAt = '2026-08-27T01:02:03.000Z';
  const legacyAgent = await pool.query(`
    INSERT INTO capture_agents (
      tenant_id, client_uuid, status, last_heartbeat_at,
      last_liveness_at, last_full_heartbeat_at
    ) VALUES ($1, $2, 'active', $3, NULL, NULL)
    RETURNING id
  `, [
    legacyTenant.rows[0].id,
    `legacy-heartbeat-${Date.now()}`,
    legacyHeartbeatAt,
  ]);
  const heartbeatMigration = await readFile(
    path.join(
      repositoryRoot,
      'server',
      'db',
      'migrations',
      '076_capture_agent_heartbeat_semantics.sql',
    ),
    'utf8',
  );
  await pool.query(heartbeatMigration);
  const backfilled = await pool.query(`
    SELECT last_heartbeat_at, last_liveness_at, last_full_heartbeat_at
    FROM capture_agents
    WHERE id = $1
  `, [legacyAgent.rows[0].id]);
  assert.equal(
    new Date(backfilled.rows[0].last_liveness_at).toISOString(),
    legacyHeartbeatAt,
  );
  assert.equal(
    new Date(backfilled.rows[0].last_full_heartbeat_at).toISOString(),
    legacyHeartbeatAt,
  );

  const livenessOnlyAt = '2026-08-27T01:04:00.000Z';
  await pool.query(`
    UPDATE capture_agents
    SET last_liveness_at = $2, updated_at = $2
    WHERE id = $1
  `, [legacyAgent.rows[0].id, livenessOnlyAt]);
  const afterLiveness = await pool.query(`
    SELECT last_heartbeat_at, last_liveness_at, last_full_heartbeat_at
    FROM capture_agents
    WHERE id = $1
  `, [legacyAgent.rows[0].id]);
  assert.equal(
    new Date(afterLiveness.rows[0].last_liveness_at).toISOString(),
    livenessOnlyAt,
  );
  assert.equal(
    new Date(afterLiveness.rows[0].last_heartbeat_at).toISOString(),
    legacyHeartbeatAt,
  );
  assert.equal(
    new Date(afterLiveness.rows[0].last_full_heartbeat_at).toISOString(),
    legacyHeartbeatAt,
  );

  const fullHeartbeatAt = '2026-08-27T01:05:00.000Z';
  await pool.query(`
    UPDATE capture_agents
    SET app_version = '0.3.94-test',
      last_liveness_at = $2,
      last_full_heartbeat_at = $2,
      last_heartbeat_at = $2,
      updated_at = $2
    WHERE id = $1
  `, [legacyAgent.rows[0].id, fullHeartbeatAt]);
  const afterFull = await pool.query(`
    SELECT app_version, last_heartbeat_at,
      last_liveness_at, last_full_heartbeat_at
    FROM capture_agents
    WHERE id = $1
  `, [legacyAgent.rows[0].id]);
  assert.equal(afterFull.rows[0].app_version, '0.3.94-test');
  for (const column of [
    'last_heartbeat_at',
    'last_liveness_at',
    'last_full_heartbeat_at',
  ]) {
    assert.equal(
      new Date(afterFull.rows[0][column]).toISOString(),
      fullHeartbeatAt,
    );
  }
  await pool.query('DELETE FROM tenants WHERE id = $1', [
    legacyTenant.rows[0].id,
  ]);
});
