import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { loadMigrationInventory } from '../../../server/db/migration-inventory.js';

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
const roleEntrypoints = Object.freeze({
  api: path.join(repositoryRoot, 'server', 'entrypoints', 'api.js'),
  scheduler: path.join(repositoryRoot, 'server', 'entrypoints', 'scheduler.js'),
  'ai-media': path.join(repositoryRoot, 'server', 'entrypoints', 'ai-media.js'),
});
const splitRoles = new Set(Object.keys(roleEntrypoints));
const guardActiveMarker = /\[P2BTestGuard\] active/u;
const guardBlockedMarker = /\[P2BTestGuard\] BLOCKED_NONLOCAL_OUTBOUND/u;
const controlledDrainMarker = /\[P2CSplitTest\] drain-waiting/u;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function waitForChildExit(child, timeoutMs = 8000) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child ${child.pid} to exit`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopChild(runtime) {
  if (!runtime || runtime.child.exitCode != null || runtime.child.signalCode != null) return;
  runtime.child.kill('SIGTERM');
  try {
    await waitForChildExit(runtime.child, 7000);
  } catch {
    runtime.child.kill('SIGKILL');
    await waitForChildExit(runtime.child, 3000);
  }
}

async function waitForOutput(runtime, pattern, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = runtime.output();
    if (pattern.test(output)) return output;
    if (runtime.child.exitCode != null || runtime.child.signalCode != null) {
      throw new Error(
        `${runtime.label} exited before output matched ${pattern}:\n${output}`,
      );
    }
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for ${pattern} from ${runtime.label}:\n${runtime.output()}`,
  );
}

async function waitForQuery(query, predicate, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await query();
    if (predicate(value)) return value;
    await delay(40);
  }
  throw new Error(`Database condition was not met; last value=${JSON.stringify(value)}`);
}

function assertGuarded(runtime) {
  const output = runtime.output();
  assert.match(output, guardActiveMarker, `${runtime.label} did not load the outbound guard`);
  assert.doesNotMatch(
    output,
    guardBlockedMarker,
    `${runtime.label} attempted a non-loopback outbound connection`,
  );
}

function createChildEnvironment({
  databaseUrl,
  guardSchema,
  role,
  port,
  mediaDirectory,
  pgApplicationName,
  drainDelayMs = 0,
}) {
  assert.match(guardSchema, /^p2c_split_[a-f0-9]+$/u);
  assert.equal(splitRoles.has(role), true);
  assert.equal(Number.isSafeInteger(port) && port > 0, true);
  assert.match(pgApplicationName, /^p2c-split-[a-f0-9]+-[a-z0-9-]+$/u);

  // Deliberately do not inherit process.env. Every child receives only local
  // PostgreSQL/HTTP targets plus inert external integrations.
  return {
    PATH: process.env.PATH || '',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || 'C',
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    TZ: 'Asia/Shanghai',
    NODE_ENV: 'production',
    PROCESS_ROLE: role,
    PROCESS_SHUTDOWN_TIMEOUT_MS: '5000',
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    ALLOW_RESET_MIGRATIONS: '0',
    PG_CONNECT_TIMEOUT_MS: '1000',
    PG_IDLE_TIMEOUT_MS: '1000',
    PG_POOL_MAX: '2',
    PGAPPNAME: pgApplicationName,
    PGOPTIONS: `-c search_path=${guardSchema}`,
    HOST: '127.0.0.1',
    PORT: String(port),
    MEDIA_DIR: mediaDirectory,
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    CORS_ORIGINS: `http://127.0.0.1:${port}`,
    ADMIN_PUBLIC_URL: `http://127.0.0.1:${port}/admin`,
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
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: '',
    EMAIL_TO: '',
    ONSTARVOICE_TEST_EXIT_DELAY_MS: '0',
    P2C_TEST_DRAIN_DELAY_MS: String(drainDelayMs),
  };
}

function controlledSchedulerSource() {
  const entrypointRuntimeUrl = pathToFileURL(
    path.join(repositoryRoot, 'server', 'runtime', 'process-entrypoint.js'),
  ).href;
  const processRuntimeUrl = pathToFileURL(
    path.join(repositoryRoot, 'server', 'runtime', 'process-runtime.js'),
  ).href;
  const schedulerRuntimeUrl = pathToFileURL(
    path.join(repositoryRoot, 'server', 'runtime', 'scheduler-runtime.js'),
  ).href;

  return [
    `import { runProcessEntrypoint } from ${JSON.stringify(entrypointRuntimeUrl)};`,
    `import { startRoleProcess } from ${JSON.stringify(processRuntimeUrl)};`,
    `import { startSchedulerRuntime } from ${JSON.stringify(schedulerRuntimeUrl)};`,
    'const drainDelayMs = Number(process.env.P2C_TEST_DRAIN_DELAY_MS);',
    "if (!Number.isSafeInteger(drainDelayMs) || drainDelayMs < 1) throw new Error('invalid controlled drain delay');",
    'await runProcessEntrypoint({',
    "  expectedRole: 'scheduler',",
    "  entrypoint: 'server/entrypoints/scheduler.js',",
    '  startProcess(options) {',
    '    return startRoleProcess({',
    '      ...options,',
    '      runtimeStarters: {',
    '        scheduler: async runtimeOptions => {',
    '          const worker = startSchedulerRuntime(runtimeOptions);',
    '          return Object.freeze({',
    '            kind: worker.kind,',
    '            responsibilities: worker.responsibilities,',
    '            stopNewWork: () => worker.stopNewWork(),',
    '            async drain(drainOptions) {',
    "              process.stderr.write('[P2CSplitTest] drain-waiting\\n');",
    '              await new Promise(resolve => setTimeout(resolve, drainDelayMs));',
    '              return worker.drain(drainOptions);',
    '            },',
    '          });',
    '        },',
    '      },',
    '    });',
    '  },',
    '});',
  ].join('\n');
}

function spawnRole({
  databaseUrl,
  guardSchema,
  role,
  port,
  mediaDirectory,
  runId,
  suffix,
  controlledDrain = false,
}) {
  const pgApplicationName = `p2c-split-${runId}-${role}-${suffix}`;
  const env = createChildEnvironment({
    databaseUrl,
    guardSchema,
    role,
    port,
    mediaDirectory,
    pgApplicationName,
    drainDelayMs: controlledDrain ? 1800 : 0,
  });
  const args = [
    '--import',
    pathToFileURL(entrypointGuard).href,
  ];
  if (controlledDrain) {
    assert.equal(role, 'scheduler');
    args.push('--input-type=module', '--eval', controlledSchedulerSource());
  } else {
    args.push(roleEntrypoints[role]);
  }

  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  return {
    role,
    label: `${role}-${suffix}`,
    child,
    pgApplicationName,
    dedicatedApplicationName: `onstarvoice:${role}:${child.pid}`,
    mediaDirectory,
    output: () => `${stdout}\n${stderr}`,
  };
}

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

async function waitForApiReady(runtime, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode != null || runtime.child.signalCode != null) {
      throw new Error(`API exited before readiness:\n${runtime.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
        signal: AbortSignal.timeout(600),
      });
      const body = await response.json();
      if (response.status === 200 && body.ok === true && body.role === 'api') return body;
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  throw new Error(
    `API did not become ready: ${lastError?.message || 'timeout'}\n${runtime.output()}`,
  );
}

async function fetchHealth(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    signal: AbortSignal.timeout(1000),
  });
  return { status: response.status, body: await response.json() };
}

function assertRejectedBeforeBusinessStartup(runtime) {
  const output = runtime.output();
  assert.match(output, /PROCESS_ROLE_LOCK_UNAVAILABLE|process-role lock is already held/u);
  assert.doesNotMatch(output, /\[DB\] PostgreSQL runtime connection ready/u);
  assert.doesNotMatch(output, /\[Cron\].*jobs started/u);
  assert.doesNotMatch(output, /\[API\] HTTP listener ready/u);
  assert.doesNotMatch(output, /\[ProcessRuntime\] role=.* ready/u);
  assert.equal(existsSync(runtime.mediaDirectory), false);
}

test('real split API, scheduler, and ai-media processes keep exclusive PostgreSQL ownership', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const { closePool, getPool } = await import('../../../server/db/pool.js');
  const pool = getPool();
  const runId = randomUUID().replaceAll('-', '');
  const guardSchema = `p2c_split_${runId}`;
  assert.match(guardSchema, /^p2c_split_[a-f0-9]+$/u);
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'onstarvoice-p2c-split-'));
  const port = await temporaryPort();
  const runtimes = new Set();
  const inspectedBackendPids = new Set();
  let schemaCreated = false;

  const register = runtime => {
    runtimes.add(runtime);
    return runtime;
  };

  const roleConnection = async runtime => {
    const rows = await waitForQuery(
      async () => (await pool.query(`
        SELECT pid
        FROM pg_stat_activity
        WHERE application_name = $1
      `, [runtime.dedicatedApplicationName])).rows,
      value => value.length === 1,
    );
    inspectedBackendPids.add(rows[0].pid);
    return rows[0].pid;
  };

  const advisoryLockCount = async backendPid => {
    const result = await pool.query(`
      SELECT count(*)::integer AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted
        AND pid = $1
    `, [backendPid]);
    return result.rows[0].count;
  };

  t.after(async () => {
    const errors = [];
    for (const runtime of runtimes) {
      try { await stopChild(runtime); } catch (error) { errors.push(error); }
      try { assertGuarded(runtime); } catch (error) { errors.push(error); }
    }

    const applicationNames = [...runtimes].flatMap(runtime => [
      runtime.pgApplicationName,
      runtime.dedicatedApplicationName,
    ]);
    try {
      const lingering = applicationNames.length === 0
        ? { rows: [] }
        : await pool.query(`
          SELECT pid, application_name
          FROM pg_stat_activity
          WHERE application_name = ANY($1::text[])
            AND pid <> pg_backend_pid()
        `, [applicationNames]);
      for (const row of lingering.rows) {
        inspectedBackendPids.add(row.pid);
        await pool.query('SELECT pg_terminate_backend($1)', [row.pid]);
      }
      if (applicationNames.length > 0) {
        await waitForQuery(
          async () => (await pool.query(`
            SELECT count(*)::integer AS count
            FROM pg_stat_activity
            WHERE application_name = ANY($1::text[])
          `, [applicationNames])).rows[0].count,
          count => count === 0,
        );
      }
      if (inspectedBackendPids.size > 0) {
        const locks = await pool.query(`
          SELECT count(*)::integer AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = ANY($1::integer[])
        `, [[...inspectedBackendPids]]);
        assert.equal(locks.rows[0].count, 0, 'split test left an advisory lock behind');
      }
    } catch (error) {
      errors.push(error);
    }

    try {
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${guardSchema}" CASCADE`);
      const namespace = await pool.query('SELECT to_regnamespace($1) AS namespace', [guardSchema]);
      assert.equal(namespace.rows[0].namespace, null, 'split test left its schema behind');
    } catch (error) {
      errors.push(error);
    }
    try { await closePool(); } catch (error) { errors.push(error); }
    try { await rm(tempDirectory, { recursive: true, force: true }); } catch (error) {
      errors.push(error);
    }
    try { assert.equal(existsSync(tempDirectory), false); } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'P2-C split PostgreSQL integration cleanup failed');
    }
  });

  await pool.query(`CREATE SCHEMA "${guardSchema}"`);
  schemaCreated = true;
  await pool.query(`
    CREATE TABLE "${guardSchema}".schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum_sha256 text,
      checksum_recorded_at timestamptz
    )
  `);
  const requiredMigrations = await loadMigrationInventory();
  const requiredMigrationVersions = requiredMigrations.map(migration => migration.version);

  const staleSchemaApi = register(spawnRole({
    databaseUrl: target.rawUrl,
    guardSchema,
    role: 'api',
    port,
    mediaDirectory: path.join(tempDirectory, 'stale-schema-api-media'),
    runId,
    suffix: 'stale-schema',
  }));
  assert.deepEqual(await waitForChildExit(staleSchemaApi.child), { code: 1, signal: null });
  assert.match(staleSchemaApi.output(), /DATABASE_SCHEMA_NOT_READY|missing \d+ required migration/u);
  assert.doesNotMatch(staleSchemaApi.output(), /\[API\] HTTP listener ready|\[Cron\]/u);
  assert.equal(existsSync(staleSchemaApi.mediaDirectory), false);

  await pool.query(
    `INSERT INTO "${guardSchema}".schema_migrations (
       version,
       checksum_sha256,
       checksum_recorded_at
     )
     SELECT migration.version, migration.checksum_sha256, now()
     FROM unnest($1::text[], $2::text[])
       AS migration(version, checksum_sha256)`,
    [
      requiredMigrationVersions,
      requiredMigrations.map(migration => migration.checksumSha256),
    ],
  );

  const api = register(spawnRole({
    databaseUrl: target.rawUrl,
    guardSchema,
    role: 'api',
    port,
    mediaDirectory: path.join(tempDirectory, 'api-media'),
    runId,
    suffix: 'primary',
  }));
  const scheduler = register(spawnRole({
    databaseUrl: target.rawUrl,
    guardSchema,
    role: 'scheduler',
    port,
    mediaDirectory: path.join(tempDirectory, 'scheduler-media'),
    runId,
    suffix: 'primary',
  }));
  const aiMedia = register(spawnRole({
    databaseUrl: target.rawUrl,
    guardSchema,
    role: 'ai-media',
    port,
    mediaDirectory: path.join(tempDirectory, 'ai-media-primary'),
    runId,
    suffix: 'primary',
  }));

  await Promise.all([
    waitForOutput(api, /\[ProcessRuntime\] role=api ready/u, 15000),
    waitForOutput(scheduler, /\[ProcessRuntime\] role=scheduler ready/u, 15000),
    waitForOutput(aiMedia, /\[ProcessRuntime\] role=ai-media ready/u, 15000),
  ]);
  await waitForApiReady(api, port);

  const legacyHealth = await fetchHealth(port, '/api/health');
  const liveness = await fetchHealth(port, '/api/health/live');
  const readiness = await fetchHealth(port, '/api/health/ready');
  assert.equal(legacyHealth.status, 200);
  assert.equal(legacyHealth.body.ok, true);
  assert.deepEqual(
    { status: liveness.status, ok: liveness.body.ok, state: liveness.body.status, role: liveness.body.role },
    { status: 200, ok: true, state: 'live', role: 'api' },
  );
  assert.deepEqual(
    { status: readiness.status, ok: readiness.body.ok, state: readiness.body.status, role: readiness.body.role },
    { status: 200, ok: true, state: 'ready', role: 'api' },
  );

  assert.equal(scheduler.child.exitCode, null);
  assert.equal(aiMedia.child.exitCode, null);
  assert.doesNotMatch(scheduler.output(), /HTTP listener ready|EADDRINUSE/u);
  assert.doesNotMatch(aiMedia.output(), /HTTP listener ready|EADDRINUSE/u);
  assert.equal(existsSync(api.mediaDirectory), true);
  assert.equal(existsSync(scheduler.mediaDirectory), false);
  assert.equal(existsSync(aiMedia.mediaDirectory), false);

  const schedulerBackendPid = await roleConnection(scheduler);
  const aiMediaBackendPid = await roleConnection(aiMedia);
  assert.equal(await advisoryLockCount(schedulerBackendPid), 1);
  assert.equal(await advisoryLockCount(aiMediaBackendPid), 1);
  const apiRoleConnection = await pool.query(`
    SELECT count(*)::integer AS count
    FROM pg_stat_activity
    WHERE application_name = $1
  `, [api.dedicatedApplicationName]);
  assert.equal(apiRoleConnection.rows[0].count, 0, 'API must not own a role-lock session');

  const isolatedTables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
    ORDER BY table_name
  `, [guardSchema]);
  assert.deepEqual(
    isolatedTables.rows.map(row => row.table_name),
    ['schema_migrations'],
    'split entrypoints must not run migrations',
  );

  for (const role of ['scheduler', 'ai-media']) {
    const duplicate = register(spawnRole({
      databaseUrl: target.rawUrl,
      guardSchema,
      role,
      port,
      mediaDirectory: path.join(tempDirectory, `${role}-duplicate-media`),
      runId,
      suffix: 'duplicate',
    }));
    assert.deepEqual(await waitForChildExit(duplicate.child), { code: 1, signal: null });
    assertRejectedBeforeBusinessStartup(duplicate);
  }

  api.child.kill('SIGTERM');
  assert.deepEqual(await waitForChildExit(api.child), { code: 0, signal: null });
  assert.equal(scheduler.child.exitCode, null);
  assert.equal(aiMedia.child.exitCode, null);
  await assertPortCanBeBound(port);

  scheduler.child.kill('SIGTERM');
  assert.deepEqual(await waitForChildExit(scheduler.child), { code: 0, signal: null });
  await waitForQuery(
    () => advisoryLockCount(schedulerBackendPid),
    count => count === 0,
  );

  const controlledScheduler = register(spawnRole({
    databaseUrl: target.rawUrl,
    guardSchema,
    role: 'scheduler',
    port,
    mediaDirectory: path.join(tempDirectory, 'scheduler-controlled-media'),
    runId,
    suffix: 'controlled',
    controlledDrain: true,
  }));
  await waitForOutput(controlledScheduler, /\[ProcessRuntime\] role=scheduler ready/u);
  const controlledBackendPid = await roleConnection(controlledScheduler);
  assert.equal(await advisoryLockCount(controlledBackendPid), 1);

  controlledScheduler.child.kill('SIGTERM');
  await waitForOutput(controlledScheduler, controlledDrainMarker);
  assert.equal(controlledScheduler.child.exitCode, null);
  assert.equal(await advisoryLockCount(controlledBackendPid), 1);

  const duringDrain = register(spawnRole({
    databaseUrl: target.rawUrl,
    guardSchema,
    role: 'scheduler',
    port,
    mediaDirectory: path.join(tempDirectory, 'scheduler-during-drain-media'),
    runId,
    suffix: 'during-drain',
  }));
  assert.deepEqual(await waitForChildExit(duringDrain.child), { code: 1, signal: null });
  assertRejectedBeforeBusinessStartup(duringDrain);
  assert.equal(await advisoryLockCount(controlledBackendPid), 1);

  assert.deepEqual(
    await waitForChildExit(controlledScheduler.child, 8000),
    { code: 0, signal: null },
  );
  await waitForQuery(
    () => advisoryLockCount(controlledBackendPid),
    count => count === 0,
  );

  const replacementScheduler = register(spawnRole({
    databaseUrl: target.rawUrl,
    guardSchema,
    role: 'scheduler',
    port,
    mediaDirectory: path.join(tempDirectory, 'scheduler-replacement-media'),
    runId,
    suffix: 'replacement',
  }));
  await waitForOutput(replacementScheduler, /\[ProcessRuntime\] role=scheduler ready/u);
  const replacementBackendPid = await roleConnection(replacementScheduler);
  assert.equal(await advisoryLockCount(replacementBackendPid), 1);
  replacementScheduler.child.kill('SIGTERM');
  assert.deepEqual(
    await waitForChildExit(replacementScheduler.child),
    { code: 0, signal: null },
  );

  aiMedia.child.kill('SIGTERM');
  assert.deepEqual(await waitForChildExit(aiMedia.child), { code: 0, signal: null });
  await waitForQuery(
    () => advisoryLockCount(aiMediaBackendPid),
    count => count === 0,
  );

  const migrationRows = await pool.query(
    `SELECT version FROM "${guardSchema}".schema_migrations ORDER BY version`,
  );
  assert.deepEqual(
    migrationRows.rows.map(row => row.version),
    requiredMigrationVersions,
    'split entrypoints must validate but not mutate the frozen migration set',
  );

  for (const runtime of runtimes) assertGuarded(runtime);
});
