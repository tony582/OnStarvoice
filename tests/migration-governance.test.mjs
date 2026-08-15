import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MIGRATION_BASELINE_PATH,
  loadMigrationBaseline,
  loadMigrationInventory,
} from '../server/db/migration-inventory.js';
import {
  acquireMigrationAdvisoryLock,
  prepareMigrationTracker,
  runMigrations,
} from '../server/db/migrate.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function trackerClient({ columns, rows }) {
  const state = {
    columns: new Set(columns),
    rows: rows.map(row => ({ ...row })),
    queries: [],
  };
  return {
    state,
    async query(sql, values = []) {
      const text = String(sql).replace(/\s+/gu, ' ').trim();
      state.queries.push({ text, values });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('SELECT to_regclass')) {
        return { rows: [{ relation: 'schema_migrations' }] };
      }
      if (text.includes('FROM pg_attribute')) {
        return { rows: [...state.columns].map(name => ({ name })) };
      }
      if (text.startsWith('ALTER TABLE schema_migrations')) {
        state.columns.add('checksum_sha256');
        state.columns.add('checksum_recorded_at');
        return { rows: [] };
      }
      if (text.startsWith('SELECT version, applied_at, checksum_sha256')) {
        return { rows: state.rows.map(row => ({ ...row })) };
      }
      if (text.startsWith('UPDATE schema_migrations')) {
        const row = state.rows.find(candidate => candidate.version === values[0]);
        if (!row || row.checksum_sha256 != null || row.checksum_recorded_at != null) {
          return { rows: [], rowCount: 0 };
        }
        row.checksum_sha256 = values[1];
        row.checksum_recorded_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected tracker query: ${text}`);
    },
  };
}

function restoreEnvironment(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test('frozen v066 manifest anchors exact SQL bytes while reset stays out of runtime inventory', async () => {
  const [baseline, schemaMigrations, allMigrations, attributes] = await Promise.all([
    loadMigrationBaseline(),
    loadMigrationInventory(),
    loadMigrationInventory({ includeReset: true }),
    readFile(path.join(repositoryRoot, '.gitattributes'), 'utf8'),
  ]);

  assert.equal(baseline.baselineId, 'v066-main-c47800f');
  assert.equal(baseline.migrations.length, 65);
  assert.equal(baseline.migrations.filter(migration => migration.kind === 'reset').length, 5);
  assert.equal(baseline.migrations.at(-1).version, '066_tenant_comment_risk_attention.sql');
  assert.equal(
    baseline.migrations.at(-1).checksumSha256,
    '5e9050519a84913764cd6dfc0c0516138dbb3ab3e46a7da55bf4b669f8bae7f6',
  );
  assert.ok(schemaMigrations.every(migration => migration.kind === 'schema'));
  assert.equal(allMigrations.length - schemaMigrations.length, 5);
  assert.ok(Object.isFrozen(schemaMigrations));
  assert.ok(schemaMigrations.every(migration => Object.isFrozen(migration)));
  assert.match(attributes, /server\/db\/migrations\/\*\.sql text eol=lf/u);
  assert.match(attributes, /server\/db\/migration-baseline-v066\.json text eol=lf/u);
});

test('inventory rejects a changed frozen checksum and invalid SQL artifact name', async t => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'onstarvoice-p2d-unit-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const baseline = JSON.parse(await readFile(DEFAULT_MIGRATION_BASELINE_PATH, 'utf8'));
  baseline.migrations.at(-1).checksumSha256 = '0'.repeat(64);
  const changedBaselinePath = path.join(temporaryDirectory, 'baseline.json');
  await writeFile(changedBaselinePath, JSON.stringify(baseline), 'utf8');
  await assert.rejects(
    loadMigrationInventory({ baselinePath: changedBaselinePath }),
    error => error.code === 'DATABASE_MIGRATION_BASELINE_MISMATCH'
      && error.version === '066_tenant_comment_risk_attention.sql',
  );

  const invalidDirectory = path.join(temporaryDirectory, 'invalid-migrations');
  await mkdir(invalidDirectory);
  await writeFile(path.join(invalidDirectory, '._066_tenant_comment_risk_attention.sql'), '', 'utf8');
  await assert.rejects(
    loadMigrationInventory({ migrationsDir: invalidDirectory }),
    error => error.code === 'DATABASE_MIGRATION_FILENAME_INVALID',
  );

  const missingDirectory = path.join(temporaryDirectory, 'missing-frozen-migration');
  await cp(path.join(repositoryRoot, 'server', 'db', 'migrations'), missingDirectory, {
    recursive: true,
  });
  await rm(path.join(missingDirectory, '066_tenant_comment_risk_attention.sql'));
  await assert.rejects(
    loadMigrationInventory({ migrationsDir: missingDirectory }),
    error => error.code === 'DATABASE_MIGRATION_BASELINE_MISSING_FILE'
      && error.version === '066_tenant_comment_risk_attention.sql',
  );
});

test('migration advisory lock waits boundedly and times out without other queries', async () => {
  let clock = 0;
  const successfulQueries = [];
  const successfulClient = {
    async query(sql) {
      successfulQueries.push(String(sql));
      return { rows: [{ acquired: successfulQueries.length >= 2 }] };
    },
  };
  await acquireMigrationAdvisoryLock(successfulClient, {
    waitMs: 20,
    pollMs: 5,
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; },
  });
  assert.equal(successfulQueries.length, 2);
  assert.ok(successfulQueries.every(sql => /pg_try_advisory_lock/u.test(sql)));

  clock = 0;
  const timedOutQueries = [];
  const timedOutClient = {
    async query(sql) {
      timedOutQueries.push(String(sql));
      return { rows: [{ acquired: false }] };
    },
  };
  await assert.rejects(
    acquireMigrationAdvisoryLock(timedOutClient, {
      waitMs: 12,
      pollMs: 5,
      now: () => clock,
      sleep: async milliseconds => { clock += milliseconds; },
    }),
    error => error.code === 'DATABASE_MIGRATION_LOCK_TIMEOUT' && error.lockWaitMs === 12,
  );
  assert.ok(timedOutQueries.every(sql => /pg_try_advisory_lock/u.test(sql)));
});

test('legacy ledger is unchanged without adoption and adopts only frozen SQL rows explicitly', async () => {
  const checksum = '6'.repeat(64);
  const migrations = [{
    version: '066_tenant_comment_risk_attention.sql',
    kind: 'schema',
    checksumSha256: checksum,
    legacyBaseline: true,
    sql: '',
  }];
  const appliedAt = new Date('2026-08-01T00:00:00.000Z');
  const rows = [
    {
      version: migrations[0].version,
      applied_at: appliedAt,
      checksum_sha256: null,
      checksum_recorded_at: null,
    },
    {
      version: 'publish_ts_backfill_v1',
      applied_at: appliedAt,
      checksum_sha256: null,
      checksum_recorded_at: null,
    },
  ];

  const rejected = trackerClient({ columns: ['version', 'applied_at'], rows });
  await assert.rejects(
    prepareMigrationTracker(rejected, migrations),
    error => error.code === 'DATABASE_MIGRATION_CHECKSUMS_NOT_READY',
  );
  assert.equal(rejected.state.queries.some(query => query.text.startsWith('ALTER TABLE')), false);
  assert.equal(rejected.state.queries.at(-1).text, 'ROLLBACK');

  const adopted = trackerClient({ columns: ['version', 'applied_at'], rows });
  const result = await prepareMigrationTracker(adopted, migrations, {
    adoptLegacyChecksums: true,
  });
  assert.deepEqual(result.adoptedVersions, [migrations[0].version]);
  assert.equal(adopted.state.rows[0].checksum_sha256, checksum);
  assert.equal(adopted.state.rows[0].applied_at, appliedAt);
  assert.equal(adopted.state.rows[1].checksum_sha256, null);
  assert.equal(adopted.state.queries.at(-1).text, 'COMMIT');
});

test('tracker rejects checksum drift before adopting or applying anything', async () => {
  const migration = {
    version: '066_tenant_comment_risk_attention.sql',
    kind: 'schema',
    checksumSha256: '6'.repeat(64),
    legacyBaseline: true,
    sql: '',
  };
  const client = trackerClient({
    columns: ['version', 'applied_at', 'checksum_sha256', 'checksum_recorded_at'],
    rows: [{
      version: migration.version,
      applied_at: new Date(),
      checksum_sha256: '0'.repeat(64),
      checksum_recorded_at: new Date(),
    }],
  });

  await assert.rejects(
    prepareMigrationTracker(client, [migration], { adoptLegacyChecksums: true }),
    error => error.code === 'DATABASE_MIGRATION_CHECKSUM_MISMATCH'
      && error.version === migration.version,
  );
  assert.equal(client.state.queries.some(query => query.text.startsWith('UPDATE')), false);
  assert.equal(client.state.queries.at(-1).text, 'ROLLBACK');
});

test('invalid lock configuration and reset override fail before any database connection', async t => {
  const previousWait = process.env.MIGRATION_LOCK_WAIT_MS;
  const previousReset = process.env.ALLOW_RESET_MIGRATIONS;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousConnectTimeout = process.env.PG_CONNECT_TIMEOUT_MS;
  t.after(() => {
    restoreEnvironment('MIGRATION_LOCK_WAIT_MS', previousWait);
    restoreEnvironment('ALLOW_RESET_MIGRATIONS', previousReset);
    restoreEnvironment('DATABASE_URL', previousDatabaseUrl);
    restoreEnvironment('PG_CONNECT_TIMEOUT_MS', previousConnectTimeout);
  });

  process.env.DATABASE_URL = 'postgres://onstarvoice_test:onstarvoice_test@127.0.0.1:1/onstarvoice_test';
  process.env.PG_CONNECT_TIMEOUT_MS = '50';
  process.env.ALLOW_RESET_MIGRATIONS = '0';
  process.env.MIGRATION_LOCK_WAIT_MS = '0';
  await assert.rejects(runMigrations(), /lockWaitMs must be a positive integer/u);

  process.env.MIGRATION_LOCK_WAIT_MS = '10';
  process.env.ALLOW_RESET_MIGRATIONS = '1';
  await assert.rejects(
    runMigrations(),
    error => error.code === 'DATABASE_RESET_MIGRATIONS_DISABLED',
  );
});

test('direct db/migrate.js execution is disabled before database access', () => {
  const result = spawnSync(process.execPath, ['server/db/migrate.js'], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH || '',
      DATABASE_URL: 'postgres://onstarvoice_test:onstarvoice_test@127.0.0.1:1/onstarvoice_test',
      PG_CONNECT_TIMEOUT_MS: '50',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /DATABASE_MIGRATION_DIRECT_ENTRYPOINT_DISABLED/u);
  assert.doesNotMatch(result.stderr, /ENOTFOUND|ECONNREFUSED|password/iu);
});
