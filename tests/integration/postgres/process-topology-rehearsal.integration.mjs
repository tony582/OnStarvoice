import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { loadProcessTopology } from '../../../scripts/check-process-topology.mjs';
import { loadMigrationInventory } from '../../../server/db/migration-inventory.js';
import {
  COMPATIBILITY_STARTUP_TASK_GROUPS,
  createMaintenanceTaskRegistry,
  MAINTENANCE_TASK_IDS,
  STARTUP_RECONCILE_TASK_IDS,
} from '../../../server/maintenance/registry.js';
import {
  assertGuarded,
  assertNoAdvisoryLocks,
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
const entrypointGuard = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'process-role-entrypoint-guard.mjs',
);
const processEntrypoints = Object.freeze({
  all: path.join(repositoryRoot, 'server', 'index.js'),
  api: path.join(repositoryRoot, 'server', 'entrypoints', 'api.js'),
  scheduler: path.join(repositoryRoot, 'server', 'entrypoints', 'scheduler.js'),
  'ai-media': path.join(repositoryRoot, 'server', 'entrypoints', 'ai-media.js'),
});
const processRoles = new Set(Object.keys(processEntrypoints));
const lockOwningRoles = new Set(['all', 'scheduler', 'ai-media']);
const productionTopologyManifest = path.join(
  repositoryRoot,
  'deploy',
  'process-topology.production.json',
);
const splitTopologyManifest = path.join(
  repositoryRoot,
  'deploy',
  'process-topology.split.candidate.json',
);
const startupTaskIds = Object.freeze([
  MAINTENANCE_TASK_IDS.PUBLISH_TS_BACKFILL,
  ...COMPATIBILITY_STARTUP_TASK_GROUPS.flatMap(group => group.taskIds),
]);
assert.equal(new Set(startupTaskIds).size, startupTaskIds.length);
assert.deepEqual([...startupTaskIds].sort(), [...STARTUP_RECONCILE_TASK_IDS].sort());
const maintenanceTaskRegistry = createMaintenanceTaskRegistry();
const onceStartupTaskIds = Object.freeze(
  startupTaskIds.filter(taskId => maintenanceTaskRegistry[taskId]?.kind === 'once'),
);
const repeatableStartupTaskIds = Object.freeze(
  startupTaskIds.filter(taskId => maintenanceTaskRegistry[taskId]?.kind === 'repeatable'),
);
assert.equal(
  onceStartupTaskIds.length + repeatableStartupTaskIds.length,
  startupTaskIds.length,
);

function temporaryPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const { port } = address;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function assertPortCanBeBound(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
}

function assertProcessAlive(pid) {
  assert.doesNotThrow(() => process.kill(pid, 0), `expected child pid ${pid} to be alive`);
}

function assertProcessExited(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    error => error?.code === 'ESRCH',
    `expected child pid ${pid} to be gone`,
  );
}

function expandTopologyRoles(topology) {
  return topology.processes.flatMap(processConfig => (
    Array.from({ length: processConfig.instances }, () => processConfig.role)
  ));
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function migrationSnapshot(pool, schema) {
  const result = await pool.query(`
    SELECT version,
           checksum_sha256,
           checksum_recorded_at::text AS checksum_recorded_at
    FROM "${schema}".schema_migrations
    ORDER BY version
  `);
  return result.rows;
}

async function maintenanceSnapshot(pool, schema) {
  const result = await pool.query(`
    SELECT task_id,
           task_version,
           run_kind,
           status,
           source,
           owner_id,
           result_summary::text AS result_summary,
           error_code,
           error_summary,
           started_at::text AS started_at,
           finished_at::text AS finished_at
    FROM "${schema}".maintenance_runs
    WHERE task_id = ANY($1::text[])
    ORDER BY started_at, id
  `, [startupTaskIds]);
  return result.rows;
}

async function disableScheduledReports(pool, schema) {
  const result = await pool.query(`
    UPDATE "${schema}".tenant_settings
    SET value = 'false'
    WHERE key = ANY($1::text[])
  `, [[
    'report_daily_enabled',
    'report_weekly_enabled',
    'report_monthly_enabled',
  ]]);
  assert.equal(result.rowCount, 3, 'the isolated default tenant report schedule was not disabled');
}

async function assertDedicatedEmptyDatabase(pool) {
  const relations = await pool.query(`
    SELECT namespace.nspname AS schema_name,
           relation.relname AS relation_name,
           relation.relkind
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_%'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    ORDER BY namespace.nspname, relation.relname
  `);
  assert.deepEqual(
    relations.rows,
    [],
    'P2-E-L requires a dedicated database with no pre-existing user relations',
  );

  let consecutiveQuiescentSnapshots = 0;
  const otherSessions = await waitForQuery(
    async () => {
      const result = await pool.query(`
        SELECT pid, application_name
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
        ORDER BY pid
      `);
      consecutiveQuiescentSnapshots = result.rows.length === 0
        ? consecutiveQuiescentSnapshots + 1
        : 0;
      return {
        consecutiveQuiescentSnapshots,
        rows: result.rows,
      };
    },
    result => result.consecutiveQuiescentSnapshots >= 5,
    5000,
  );
  assert.deepEqual(
    otherSessions.rows,
    [],
    'P2-E-L requires a stably quiescent database with no other sessions',
  );

  const advisoryLocks = await pool.query(`
    SELECT locks.pid
    FROM pg_locks AS locks
    JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
    WHERE activity.datname = current_database()
      AND locks.locktype = 'advisory'
    ORDER BY locks.pid
  `);
  assert.deepEqual(
    advisoryLocks.rows,
    [],
    'P2-E-L requires a database with no pre-existing advisory locks',
  );
}

async function startupTaskCounts(pool, schema) {
  const result = await pool.query(`
    SELECT task_id,
           count(*)::integer AS total,
           count(*) FILTER (WHERE status = 'running')::integer AS running,
           count(*) FILTER (WHERE status = 'failed')::integer AS failed
    FROM "${schema}".maintenance_runs
    WHERE task_id = ANY($1::text[])
    GROUP BY task_id
    ORDER BY task_id
  `, [startupTaskIds]);
  return new Map(result.rows.map(row => [row.task_id, row]));
}

async function waitForStartupTaskCounts(pool, schema, expectedCounts, timeoutMs = 60_000) {
  return waitForQuery(
    async () => {
      const counts = await startupTaskCounts(pool, schema);
      for (const taskId of startupTaskIds) {
        const row = counts.get(taskId);
        const expected = expectedCounts.get(taskId);
        if ((row?.failed || 0) > 0) {
          throw new Error(`Compatibility maintenance task failed: ${taskId}`);
        }
        if ((row?.total || 0) > expected) {
          throw new Error(
            `Compatibility maintenance task ran too many times: ${taskId} `
            + `(${row.total} > ${expected})`,
          );
        }
      }
      return {
        counts: Object.fromEntries(counts),
        ready: startupTaskIds.every(taskId => (
          counts.get(taskId)?.total === expectedCounts.get(taskId)
          && counts.get(taskId)?.running === 0
        )),
      };
    },
    result => result.ready,
    timeoutMs,
  );
}

function assertRequiredMigrationChecksums(snapshot, inventory) {
  const applied = new Map(snapshot.map(row => [row.version, row]));
  for (const migration of inventory) {
    const row = applied.get(migration.version);
    assert.ok(row, `required migration ${migration.version} is missing`);
    assert.equal(
      row.checksum_sha256,
      migration.checksumSha256,
      `required migration ${migration.version} checksum drifted`,
    );
    assert.notEqual(
      row.checksum_recorded_at,
      null,
      `required migration ${migration.version} has no checksum timestamp`,
    );
  }
}

function assertInitialMaintenanceLedger(rows) {
  assert.equal(rows.length, startupTaskIds.length);
  const byTaskId = new Map(rows.map(row => [row.task_id, row]));
  for (const taskId of onceStartupTaskIds) {
    const row = byTaskId.get(taskId);
    assert.ok(row, `initial compatibility startup did not audit ${taskId}`);
    assert.equal(row.run_kind, 'once');
    assert.equal(
      row.status,
      'succeeded',
      `fresh rehearsal schema must execute ${taskId} instead of adopting legacy state`,
    );
    assert.equal(row.source, 'compatibility-startup');
    assert.notEqual(row.finished_at, null);
  }
  for (const taskId of repeatableStartupTaskIds) {
    const row = byTaskId.get(taskId);
    assert.ok(row, `initial compatibility startup did not audit ${taskId}`);
    assert.equal(row.run_kind, 'repeatable');
    assert.equal(row.status, 'succeeded');
    assert.equal(row.source, 'compatibility-startup');
    assert.notEqual(row.finished_at, null);
  }
}

function assertFinalMaintenanceLedger(rows, initialRows) {
  assert.equal(
    rows.length,
    onceStartupTaskIds.length + (repeatableStartupTaskIds.length * 2),
  );
  for (const taskId of onceStartupTaskIds) {
    assert.deepEqual(
      rows.filter(row => row.task_id === taskId),
      initialRows.filter(row => row.task_id === taskId),
      `one-shot ${taskId} must not register a second run during rollback`,
    );
  }
  for (const taskId of repeatableStartupTaskIds) {
    const taskRows = rows.filter(row => row.task_id === taskId);
    assert.equal(taskRows.length, 2, `repeatable ${taskId} must run once per all startup`);
    for (const row of taskRows) {
      assert.equal(row.run_kind, 'repeatable');
      assert.equal(row.status, 'succeeded');
      assert.equal(row.source, 'compatibility-startup');
      assert.notEqual(row.finished_at, null);
    }
  }
}

function createChildEnvironment({
  databaseUrl,
  schema,
  role,
  port,
  mediaDirectory,
  poolApplicationName,
  dotenvPath,
}) {
  assert.match(schema, /^p2e_rehearsal_[a-f0-9]+$/u);
  assert.equal(processRoles.has(role), true);
  assert.equal(Number.isSafeInteger(port) && port > 0, true);
  assert.match(poolApplicationName, /^p2e-rehearsal-[a-f0-9]+-[a-z0-9-]+$/u);

  // Deliberately do not spread process.env. Runtime children receive only the
  // explicitly approved local PostgreSQL/HTTP targets and inert integrations.
  // Pointing dotenv at a test-created empty file also prevents repository/user secrets
  // from being loaded by the real entrypoints' `dotenv/config` import.
  return {
    PATH: process.env.PATH || '',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || 'C',
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    TZ: 'Asia/Shanghai',
    NODE_ENV: 'production',
    PROCESS_ROLE: role,
    PROCESS_SHUTDOWN_TIMEOUT_MS: '8000',
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    ALLOW_RESET_MIGRATIONS: '0',
    PG_CONNECT_TIMEOUT_MS: '1000',
    PG_QUERY_TIMEOUT_MS: '5000',
    PG_IDLE_TIMEOUT_MS: '1000',
    PG_POOL_MAX: '2',
    PGAPPNAME: poolApplicationName,
    PGOPTIONS: `-c search_path=${schema}`,
    MIGRATION_LOCK_WAIT_MS: '5000',
    MIGRATION_LOCK_POLL_MS: '50',
    HOST: '127.0.0.1',
    PORT: String(port),
    MEDIA_DIR: mediaDirectory,
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    CORS_ORIGINS: `http://127.0.0.1:${port}`,
    ADMIN_PUBLIC_URL: `http://127.0.0.1:${port}/admin`,
    DOTENV_CONFIG_PATH: dotenvPath,
    BOOTSTRAP_ADMIN_EMAIL: '',
    BOOTSTRAP_ADMIN_PASSWORD: '',
    BOOTSTRAP_ADMIN_NAME: '',
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: '',
    LLM_MODEL: '',
    LLM_API_ENDPOINT: 'http://127.0.0.1:1/v1',
    DASHSCOPE_API_KEY: '',
    DASHSCOPE_ASR_ENDPOINT: 'http://127.0.0.1:1/asr',
    DASHSCOPE_TASK_ENDPOINT: 'http://127.0.0.1:1/tasks',
    QWEN_OCR_API_KEY: '',
    QWEN_OCR_API_ENDPOINT: 'http://127.0.0.1:1/v1',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: '',
    EMAIL_TO: '',
    ONSTARVOICE_TEST_EXIT_DELAY_MS: '0',
  };
}

function spawnRuntime({
  databaseUrl,
  schema,
  role,
  port,
  mediaDirectory,
  runId,
  suffix,
  dotenvPath,
}) {
  const poolApplicationName = `p2e-rehearsal-${runId}-${role}-${suffix}`;
  const runtime = spawnGuardedNode({
    guardPath: entrypointGuard,
    scriptPath: processEntrypoints[role],
    cwd: repositoryRoot,
    env: createChildEnvironment({
      databaseUrl,
      schema,
      role,
      port,
      mediaDirectory,
      poolApplicationName,
      dotenvPath,
    }),
    label: `${role}-${suffix}`,
  });
  const outputClosed = new Promise(resolve => {
    runtime.child.once('close', (code, signal) => resolve({ code, signal }));
  });

  return Object.freeze({
    ...runtime,
    role,
    poolApplicationName,
    lockApplicationName: lockOwningRoles.has(role)
      ? `onstarvoice:${role}:${runtime.child.pid}`
      : null,
    mediaDirectory,
    outputClosed,
  });
}

async function waitForRuntimeOutputClosed(runtime, timeoutMs = 5000) {
  let timeout;
  try {
    return await Promise.race([
      runtime.outputClosed,
      new Promise((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out draining output from ${runtime.label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForRuntimeExit(runtime, timeoutMs) {
  const exit = await waitForChildExit(runtime, timeoutMs);
  await waitForRuntimeOutputClosed(runtime);
  return exit;
}

async function fetchHealth(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    signal: AbortSignal.timeout(1000),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForApiReady(runtime, port, expectedRole, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode != null || runtime.child.signalCode != null) {
      throw new Error(`${runtime.label} exited before readiness:\n${runtime.output()}`);
    }
    try {
      const ready = await fetchHealth(port, '/api/health/ready');
      if (ready.status === 200
          && ready.body.ok === true
          && ready.body.status === 'ready'
          && ready.body.role === expectedRole) {
        return ready.body;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(
    `${runtime.label} did not become ready: ${lastError?.message || 'timeout'}\n`
    + runtime.output(),
  );
}

async function assertHealthContract(port, expectedRole) {
  const legacy = await fetchHealth(port, '/api/health');
  const live = await fetchHealth(port, '/api/health/live');
  const ready = await fetchHealth(port, '/api/health/ready');

  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.ok, true);
  assert.deepEqual(
    { status: live.status, ok: live.body.ok, state: live.body.status, role: live.body.role },
    { status: 200, ok: true, state: 'live', role: expectedRole },
  );
  assert.deepEqual(
    { status: ready.status, ok: ready.body.ok, state: ready.body.status, role: ready.body.role },
    { status: 200, ok: true, state: 'ready', role: expectedRole },
  );
}

function runtimeApplicationNames(runtime) {
  return [runtime.poolApplicationName, runtime.lockApplicationName].filter(Boolean);
}

function runtimeApplicationPatterns(runtime) {
  return runtime.role === 'all'
    ? [`onstarvoice:maintenance-task:%:${runtime.child.pid}`]
    : [];
}

async function runtimeConnections(pool, runtime) {
  const result = await pool.query(`
    SELECT pid, application_name
    FROM pg_stat_activity
    WHERE application_name = ANY($1::text[])
       OR application_name LIKE ANY($2::text[])
    ORDER BY pid
  `, [runtimeApplicationNames(runtime), runtimeApplicationPatterns(runtime)]);
  return result.rows;
}

async function waitForRuntimeConnections(pool, runtime) {
  return waitForQuery(
    () => runtimeConnections(pool, runtime),
    rows => runtime.role === 'api'
      ? rows.some(row => row.application_name === runtime.poolApplicationName)
      : rows.some(row => row.application_name === runtime.lockApplicationName),
    10_000,
  );
}

async function roleLockCount(pool, runtime) {
  const applicationName = runtime.lockApplicationName
    || `onstarvoice:${runtime.role}:${runtime.child.pid}`;
  const result = await pool.query(`
    SELECT count(*)::integer AS count
    FROM pg_locks AS locks
    JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
    WHERE locks.locktype = 'advisory'
      AND locks.granted
      AND activity.application_name = $1
  `, [applicationName]);
  return result.rows[0].count;
}

async function roleLockConnectionCount(pool, runtime) {
  const applicationName = runtime.lockApplicationName
    || `onstarvoice:${runtime.role}:${runtime.child.pid}`;
  const result = await pool.query(`
    SELECT count(*)::integer AS count
    FROM pg_stat_activity
    WHERE application_name = $1
  `, [applicationName]);
  return result.rows[0].count;
}

function assertTopology(runtimes, expectedRoles) {
  const alive = [...runtimes]
    .filter(runtime => runtime.child.exitCode == null && runtime.child.signalCode == null)
    .map(runtime => runtime.role)
    .sort();
  const expected = [...expectedRoles].sort();
  assert.deepEqual(alive, expected, 'OS process topology does not match the rehearsed phase');

  const hasCompatibility = alive.includes('all');
  const hasSplit = alive.some(role => role !== 'all');
  assert.equal(
    hasCompatibility && hasSplit,
    false,
    'compatibility and split processes must never overlap',
  );
  for (const runtime of runtimes) {
    if (runtime.child.exitCode == null && runtime.child.signalCode == null) {
      assertProcessAlive(runtime.child.pid);
    }
  }
}

async function assertRuntimeReleased(pool, runtime, inspectedBackendPids) {
  await waitForQuery(
    async () => (await runtimeConnections(pool, runtime)).length,
    count => count === 0,
    10_000,
  );
  if (inspectedBackendPids.size > 0) {
    await waitForQuery(
      async () => Number((await pool.query(`
        SELECT count(*) AS count
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = ANY($1::integer[])
      `, [[...inspectedBackendPids]])).rows[0].count),
      count => count === 0,
      10_000,
    );
  }
  assertProcessExited(runtime.child.pid);
}

function assertRejectedBeforeBusinessStartup(runtime) {
  const output = runtime.output();
  assert.match(output, /PROCESS_ROLE_LOCK_UNAVAILABLE|process-role lock is already held/u);
  assert.doesNotMatch(output, /\[DB\] PostgreSQL (?:initialized|runtime connection ready)/u);
  assert.doesNotMatch(output, /\[Cron\].*jobs started/u);
  assert.doesNotMatch(output, /\[API\] HTTP listener ready/u);
  assert.doesNotMatch(output, /\[ProcessRuntime\] role=.* ready/u);
  assert.equal(existsSync(runtime.mediaDirectory), false);
}

function assertRuntimeOutputSafe(runtime, { expectedStartupRejection = false } = {}) {
  const output = runtime.output();
  assert.doesNotMatch(
    output,
    /(?:UnhandledPromiseRejection|unhandled rejection|uncaught(?: exception)?|ERR_UNHANDLED_REJECTION)/iu,
    `${runtime.label} emitted an unhandled runtime failure`,
  );
  assert.doesNotMatch(
    output,
    /\b(?:postgres(?:ql)?|https?):\/\/[^\s/:]+:[^@\s]+@/iu,
    `${runtime.label} exposed a credential-bearing URL`,
  );
  if (!expectedStartupRejection) {
    assert.doesNotMatch(
      output,
      /(?:^|\n)[^\n]*(?:\bERROR\b|\bError:|\berror:|\bfailed\b)[^\n]*/iu,
      `${runtime.label} emitted an unexpected error or failure log`,
    );
  }
}

test('real processes rehearse all to split to all without mixed ownership or residue', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const compatibilityTopology = await loadProcessTopology(productionTopologyManifest, {
    requireDeployable: true,
  });
  const splitTopology = await loadProcessTopology(splitTopologyManifest, {
    requireDeployable: false,
  });
  const compatibilityRoles = expandTopologyRoles(compatibilityTopology);
  const splitRoles = expandTopologyRoles(splitTopology);
  assert.deepEqual(compatibilityTopology.roleCounts, { all: 1 });
  assert.deepEqual(splitTopology.roleCounts, { 'ai-media': 1, api: 1, scheduler: 1 });

  const { closePool, getPool } = await import('../../../server/db/pool.js');
  const pool = getPool();
  const runId = randomUUID().replaceAll('-', '');
  const schema = `p2e_rehearsal_${runId}`;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'onstarvoice-p2e-rehearsal-'));
  const dotenvPath = path.join(tempDirectory, 'empty.env');
  await writeFile(dotenvPath, '', { flag: 'wx' });
  const port = await temporaryPort();
  let schedulerPort = await temporaryPort();
  while (schedulerPort === port) schedulerPort = await temporaryPort();
  let aiMediaPort = await temporaryPort();
  while (aiMediaPort === port || aiMediaPort === schedulerPort) {
    aiMediaPort = await temporaryPort();
  }
  const runtimes = new Set();
  const expectedStartupRejections = new Set();
  const inspectedBackendPids = new Set();
  let schemaCreated = false;

  const register = runtime => {
    runtimes.add(runtime);
    return runtime;
  };
  const recordConnections = async runtime => {
    const rows = await waitForRuntimeConnections(pool, runtime);
    for (const row of rows) inspectedBackendPids.add(row.pid);
    return rows;
  };
  const start = (role, suffix, { runtimePort = port } = {}) => register(spawnRuntime({
    databaseUrl: target.rawUrl,
    schema,
    role,
    port: runtimePort,
    mediaDirectory: path.join(tempDirectory, `${role}-${suffix}-media`),
    runId,
    suffix,
    dotenvPath,
  }));

  t.after(async () => {
    const errors = [];
    for (const runtime of runtimes) {
      try { await stopChild(runtime); } catch (error) { errors.push(error); }
      try { await waitForRuntimeOutputClosed(runtime); } catch (error) { errors.push(error); }
      try { assertGuarded(runtime); } catch (error) { errors.push(error); }
      try {
        assertRuntimeOutputSafe(runtime, {
          expectedStartupRejection: expectedStartupRejections.has(runtime),
        });
      } catch (error) {
        errors.push(error);
      }
    }

    const applicationNames = [...runtimes].flatMap(runtimeApplicationNames);
    const applicationPatterns = [...runtimes].flatMap(runtimeApplicationPatterns);
    try {
      if (applicationPatterns.length > 0) {
        const maintenanceConnections = await pool.query(`
          SELECT pid, application_name
          FROM pg_stat_activity
          WHERE application_name LIKE ANY($1::text[])
        `, [applicationPatterns]);
        for (const row of maintenanceConnections.rows) {
          inspectedBackendPids.add(row.pid);
          applicationNames.push(row.application_name);
        }
      }
      const terminatedPids = await terminateApplications(pool, applicationNames);
      for (const pid of terminatedPids) inspectedBackendPids.add(pid);
      const active = applicationNames.length === 0
        ? { rows: [{ count: 0 }] }
        : await pool.query(`
          SELECT count(*)::integer AS count
          FROM pg_stat_activity
          WHERE application_name = ANY($1::text[])
        `, [applicationNames]);
      assert.equal(active.rows[0].count, 0, 'P2-E rehearsal left a PostgreSQL connection open');
      await assertNoAdvisoryLocks(pool, [...inspectedBackendPids]);
    } catch (error) {
      errors.push(error);
    }

    try {
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      schemaCreated = false;
      const namespace = await pool.query('SELECT to_regnamespace($1) AS namespace', [schema]);
      assert.equal(namespace.rows[0].namespace, null, 'P2-E rehearsal left its schema behind');
    } catch (error) {
      errors.push(error);
    }
    try { await closePool(); } catch (error) { errors.push(error); }
    try { await rm(tempDirectory, { recursive: true, force: true }); } catch (error) {
      errors.push(error);
    }
    try { assert.equal(existsSync(tempDirectory), false, 'temporary media was not removed'); } catch (error) {
      errors.push(error);
    }
    for (const runtime of runtimes) {
      try { assertProcessExited(runtime.child.pid); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'P2-E topology rehearsal cleanup failed');
    }
  });

  await assertDedicatedEmptyDatabase(pool);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  const migrationInventory = await loadMigrationInventory();
  const initialTaskCounts = new Map(startupTaskIds.map(taskId => [taskId, 1]));
  const finalTaskCounts = new Map([
    ...onceStartupTaskIds.map(taskId => [taskId, 1]),
    ...repeatableStartupTaskIds.map(taskId => [taskId, 2]),
  ]);

  // Phase 1: the real compatibility entrypoint owns both worker locks and HTTP.
  const initialAll = start('all', 'initial');
  await waitForOutput(initialAll, /\[ProcessRuntime\] role=all ready/u, 45_000);
  await waitForApiReady(initialAll, port, 'all');
  await disableScheduledReports(pool, schema);
  await assertHealthContract(port, 'all');
  const initialAllConnections = await recordConnections(initialAll);
  assert.equal(await roleLockCount(pool, initialAll), 2);
  assert.equal(existsSync(initialAll.mediaDirectory), true);
  assertTopology(runtimes, compatibilityRoles);
  await waitForStartupTaskCounts(pool, schema, initialTaskCounts);
  const initialMaintenanceRows = await maintenanceSnapshot(pool, schema);
  assertInitialMaintenanceLedger(initialMaintenanceRows);
  const frozenMigrationRows = await migrationSnapshot(pool, schema);
  assertRequiredMigrationChecksums(frozenMigrationRows, migrationInventory);
  assert.equal(await roleLockCount(pool, initialAll), 2);
  await assertHealthContract(port, 'all');

  // A split worker cannot overlap the compatibility process: it fails before
  // database/runtime startup and therefore cannot create media or listen HTTP.
  const splitDuringAll = start('scheduler', 'during-all');
  expectedStartupRejections.add(splitDuringAll);
  assert.deepEqual(await waitForRuntimeExit(splitDuringAll), { code: 1, signal: null });
  assertRejectedBeforeBusinessStartup(splitDuringAll);
  assertGuarded(splitDuringAll);
  assertTopology(runtimes, compatibilityRoles);

  initialAll.child.kill('SIGTERM');
  assert.deepEqual(await waitForRuntimeExit(initialAll), { code: 0, signal: null });
  assert.match(initialAll.output(), /SIGTERM received; draining/u);
  await assertRuntimeReleased(pool, initialAll, new Set(initialAllConnections.map(row => row.pid)));
  assert.equal(await roleLockCount(pool, initialAll), 0);
  assertTopology(runtimes, []);
  await assertPortCanBeBound(port);

  // Phase 2: only after compatibility is completely gone do the three real
  // split entrypoints start. API owns no role lock; each worker owns exactly one.
  const api = start('api', 'split');
  const scheduler = start('scheduler', 'split', { runtimePort: schedulerPort });
  const aiMedia = start('ai-media', 'split', { runtimePort: aiMediaPort });
  await Promise.all([
    waitForOutput(api, /\[ProcessRuntime\] role=api ready/u, 30_000),
    waitForOutput(scheduler, /\[ProcessRuntime\] role=scheduler ready/u, 30_000),
    waitForOutput(aiMedia, /\[ProcessRuntime\] role=ai-media ready/u, 30_000),
  ]);
  await waitForApiReady(api, port, 'api');
  const [apiConnections, schedulerConnections, aiMediaConnections] = await Promise.all([
    recordConnections(api),
    recordConnections(scheduler),
    recordConnections(aiMedia),
  ]);
  await assertHealthContract(port, 'api');
  assert.equal(await roleLockCount(pool, api), 0);
  assert.equal(await roleLockConnectionCount(pool, api), 0);
  assert.equal(await roleLockCount(pool, scheduler), 1);
  assert.equal(await roleLockCount(pool, aiMedia), 1);
  assert.equal(existsSync(api.mediaDirectory), true);
  assert.equal(existsSync(scheduler.mediaDirectory), false);
  assert.equal(existsSync(aiMedia.mediaDirectory), false);
  assert.doesNotMatch(scheduler.output(), /HTTP listener ready|EADDRINUSE/u);
  assert.doesNotMatch(aiMedia.output(), /HTTP listener ready|EADDRINUSE/u);
  await assertPortCanBeBound(schedulerPort);
  await assertPortCanBeBound(aiMediaPort);
  assertTopology(runtimes, splitRoles);
  await delay(26_000);
  await assertHealthContract(port, 'api');
  assertTopology(runtimes, splitRoles);
  assert.equal(await roleLockCount(pool, api), 0);
  assert.equal(await roleLockConnectionCount(pool, api), 0);
  assert.equal(await roleLockCount(pool, scheduler), 1);
  assert.equal(await roleLockCount(pool, aiMedia), 1);
  assert.deepEqual(
    await maintenanceSnapshot(pool, schema),
    initialMaintenanceRows,
    'split roles must not run compatibility startup maintenance',
  );
  assert.deepEqual(
    await migrationSnapshot(pool, schema),
    frozenMigrationRows,
    'split readiness must not mutate migration versions or checksums',
  );

  // Repeated worker ownership must fail closed, and rollback to `all` is also
  // fenced until both split workers have fully exited.
  for (const role of ['scheduler', 'ai-media']) {
    const duplicate = start(role, 'duplicate', {
      runtimePort: role === 'scheduler' ? schedulerPort : aiMediaPort,
    });
    expectedStartupRejections.add(duplicate);
    assert.deepEqual(await waitForRuntimeExit(duplicate), { code: 1, signal: null });
    assertRejectedBeforeBusinessStartup(duplicate);
    assertGuarded(duplicate);
  }
  const allDuringSplit = start('all', 'during-split');
  expectedStartupRejections.add(allDuringSplit);
  assert.deepEqual(await waitForRuntimeExit(allDuringSplit), { code: 1, signal: null });
  assertRejectedBeforeBusinessStartup(allDuringSplit);
  assertGuarded(allDuringSplit);
  assertTopology(runtimes, splitRoles);

  // Stop execution workers first. Their two locks and every database session
  // must be gone while API remains healthy; only then may API stop and `all`
  // be considered for rollback.
  scheduler.child.kill('SIGTERM');
  aiMedia.child.kill('SIGTERM');
  assert.deepEqual(await waitForRuntimeExit(scheduler), { code: 0, signal: null });
  assert.deepEqual(await waitForRuntimeExit(aiMedia), { code: 0, signal: null });
  await assertRuntimeReleased(
    pool,
    scheduler,
    new Set(schedulerConnections.map(row => row.pid)),
  );
  await assertRuntimeReleased(
    pool,
    aiMedia,
    new Set(aiMediaConnections.map(row => row.pid)),
  );
  assert.equal(await roleLockCount(pool, scheduler), 0);
  assert.equal(await roleLockCount(pool, aiMedia), 0);
  assertProcessAlive(api.child.pid);
  await assertHealthContract(port, 'api');
  await assertPortCanBeBound(schedulerPort);
  await assertPortCanBeBound(aiMediaPort);
  assertTopology(runtimes, ['api']);

  api.child.kill('SIGTERM');
  assert.deepEqual(await waitForRuntimeExit(api), { code: 0, signal: null });
  await assertRuntimeReleased(pool, api, new Set(apiConnections.map(row => row.pid)));
  assertTopology(runtimes, []);
  await assertPortCanBeBound(port);

  // Phase 3: rollback starts the same real compatibility entrypoint only after
  // all split processes, connections, and locks are gone.
  const finalAll = start('all', 'final');
  await waitForOutput(finalAll, /\[ProcessRuntime\] role=all ready/u, 45_000);
  await waitForApiReady(finalAll, port, 'all');
  const finalAllReadyAt = Date.now();
  await assertHealthContract(port, 'all');
  const finalAllConnections = await recordConnections(finalAll);
  assert.equal(await roleLockCount(pool, finalAll), 2);
  assert.equal(existsSync(finalAll.mediaDirectory), true);
  assertTopology(runtimes, compatibilityRoles);
  try {
    await waitForStartupTaskCounts(pool, schema, finalTaskCounts);
  } catch (error) {
    throw new Error(
      `Rollback compatibility maintenance did not settle: ${error.message}\n${finalAll.output()}`,
      { cause: error },
    );
  }
  const remainingStartupWindowMs = 26_000 - (Date.now() - finalAllReadyAt);
  if (remainingStartupWindowMs > 0) await delay(remainingStartupWindowMs);
  await waitForStartupTaskCounts(pool, schema, finalTaskCounts, 5_000);
  assertFinalMaintenanceLedger(
    await maintenanceSnapshot(pool, schema),
    initialMaintenanceRows,
  );
  assert.deepEqual(
    await migrationSnapshot(pool, schema),
    frozenMigrationRows,
    'rollback compatibility startup must not drift migration versions or checksums',
  );
  assert.equal(await roleLockCount(pool, finalAll), 2);
  await assertHealthContract(port, 'all');

  finalAll.child.kill('SIGTERM');
  assert.deepEqual(await waitForRuntimeExit(finalAll), { code: 0, signal: null });
  await assertRuntimeReleased(pool, finalAll, new Set(finalAllConnections.map(row => row.pid)));
  assert.equal(await roleLockCount(pool, finalAll), 0);
  assertTopology(runtimes, []);
  await assertPortCanBeBound(port);
});
