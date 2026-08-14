import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
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
});
