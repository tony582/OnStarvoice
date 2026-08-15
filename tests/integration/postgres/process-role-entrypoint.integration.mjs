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

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const serverEntrypoint = path.join(repositoryRoot, 'server', 'index.js');
const entrypointGuard = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'process-role-entrypoint-guard.mjs',
);

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
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

async function stopChild(server) {
  if (!server || server.child.exitCode != null || server.child.signalCode != null) return;
  server.child.kill('SIGTERM');
  try {
    await waitForChildExit(server.child, 5000);
  } catch {
    server.child.kill('SIGKILL');
    await waitForChildExit(server.child, 3000);
  }
}

function spawnServer({
  databaseUrl,
  port,
  mediaDirectory,
  guardSchema,
  exitDelayMs = 0,
}) {
  assert.match(guardSchema, /^p2b_guard_[a-f0-9]+$/u);
  const env = {
    PATH: process.env.PATH || '',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || 'C',
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    TZ: 'Asia/Shanghai',
    NODE_ENV: 'production',
    PROCESS_ROLE: 'all',
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    ALLOW_RESET_MIGRATIONS: '0',
    PG_CONNECT_TIMEOUT_MS: '1000',
    PGOPTIONS: `-c search_path=${guardSchema}`,
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
    ONSTARVOICE_TEST_EXIT_DELAY_MS: String(exitDelayMs),
  };

  const child = spawn(process.execPath, [
    '--import',
    pathToFileURL(entrypointGuard).href,
    serverEntrypoint,
  ], {
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
    child,
    output: () => `${stdout}\n${stderr}`,
  };
}

async function waitForOutput(server, pattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = server.output();
    if (pattern.test(output)) return output;
    if (server.child.exitCode != null || server.child.signalCode != null) {
      throw new Error(`Server exited before output matched ${pattern}:\n${output}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server output did not match ${pattern}:\n${server.output()}`);
}

function assertServerGuarded(server) {
  const output = server.output();
  assert.match(output, /\[P2BTestGuard\] active/u);
  assert.doesNotMatch(output, /\[P2BTestGuard\] BLOCKED_NONLOCAL_OUTBOUND/u);
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

async function waitForHealth(server, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (server.child.exitCode != null || server.child.signalCode != null) {
      throw new Error(`Server exited before health check:\n${server.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200 && (await response.json()).ok === true) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Server did not become healthy: ${lastError?.message || 'timeout'}\n${server.output()}`,
  );
}

async function waitForQuery(query, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await query();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Database condition was not met; last value=${JSON.stringify(value)}`);
}

test('real compatibility entrypoint fences all startup work and exits when its locks are lost', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const { closePool, getPool } = await import('../../../server/db/pool.js');
  const { acquireProcessRoleLocks } = await import(
    '../../../server/runtime/process-role-locks.js'
  );
  const pool = getPool();
  const runId = randomUUID().replaceAll('-', '');
  const guardSchema = `p2b_guard_${runId}`;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'onstarvoice-p2b-index-'));
  const handles = new Set();
  const servers = new Set();
  let healthyEntrypointStarted = false;

  const acquire = async (role, suffix) => {
    const handle = await acquireProcessRoleLocks({
      role,
      databaseUrl: target.rawUrl,
      applicationName: `p2b-entrypoint-${runId}-${suffix}`,
      logger: { error() {} },
      onLockLost() {},
    });
    handles.add(handle);
    return handle;
  };

  t.after(async () => {
    const errors = [];
    for (const server of servers) {
      try { await stopChild(server); } catch (error) { errors.push(error); }
      try { assertServerGuarded(server); } catch (error) { errors.push(error); }
    }
    for (const handle of handles) {
      try { await handle.release(); } catch (error) { errors.push(error); }
    }
    if (healthyEntrypointStarted) {
      try {
        const guardMigration = await pool.query(
          'SELECT to_regclass($1) AS relation',
          [`${guardSchema}.schema_migrations`],
        );
        assert.notEqual(
          guardMigration.rows[0].relation,
          null,
          'healthy entrypoint must initialize only its isolated guard schema',
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${guardSchema}" CASCADE`);
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
      throw new AggregateError(errors, 'P2-B entrypoint integration cleanup failed');
    }
  });

  await pool.query(`CREATE SCHEMA "${guardSchema}"`);

  await t.test('lock contention fails before migrations, media, Cron, or HTTP', async () => {
    const blocker = await acquire('scheduler', 'startup-blocker');
    const mediaDirectory = path.join(tempDirectory, 'blocked-media');
    const port = await temporaryPort();
    const contender = spawnServer({
      databaseUrl: target.rawUrl,
      port,
      mediaDirectory,
      guardSchema,
    });
    servers.add(contender);
    const exit = await waitForChildExit(contender.child);
    const output = contender.output();

    assert.deepEqual(exit, { code: 1, signal: null });
    assert.match(output, /PROCESS_ROLE_LOCK_UNAVAILABLE|process-role lock is already held/u);
    assert.doesNotMatch(output, /\[DB\]|\[Cron\]|Backend Server|\[Reprocess\]/u);
    assert.equal(existsSync(mediaDirectory), false);
    assert.match(output, /\[P2BTestGuard\] active/u);
    assert.doesNotMatch(output, /\[P2BTestGuard\] BLOCKED_NONLOCAL_OUTBOUND/u);
    const migrationTable = await pool.query(
      'SELECT to_regclass($1) AS relation',
      [`${guardSchema}.schema_migrations`],
    );
    assert.equal(migrationTable.rows[0].relation, null);
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) }),
    );
    await blocker.release();
  });

  await t.test('SIGTERM keeps execution locks until the compatibility process exits', async () => {
    const mediaDirectory = path.join(tempDirectory, 'sigterm-media');
    const port = await temporaryPort();
    const server = spawnServer({
      databaseUrl: target.rawUrl,
      port,
      mediaDirectory,
      guardSchema,
      exitDelayMs: 2000,
    });
    servers.add(server);
    await waitForHealth(server, port);
    healthyEntrypointStarted = true;

    const roleConnection = await waitForQuery(
      async () => (await pool.query(`
        SELECT pid
        FROM pg_stat_activity
        WHERE application_name = $1
      `, [`onstarvoice:all:${server.child.pid}`])).rows,
      rows => rows.length === 1,
    );
    const roleBackendPid = roleConnection[0].pid;
    const heldLocks = await pool.query(`
      SELECT count(*)::integer AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND pid = $1
    `, [roleBackendPid]);
    assert.equal(heldLocks.rows[0].count, 2);

    server.child.kill('SIGTERM');
    await waitForOutput(server, /\[P2BTestGuard\] exit-delayed/u);
    assert.equal(server.child.exitCode, null);
    assert.equal(server.child.signalCode, null);
    const locksDuringShutdown = await pool.query(`
      SELECT count(*)::integer AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND pid = $1
    `, [roleBackendPid]);
    assert.equal(locksDuringShutdown.rows[0].count, 2);
    await assert.rejects(
      acquire('all', 'during-sigterm'),
      error => {
        assert.equal(error.code, 'PROCESS_ROLE_LOCK_UNAVAILABLE');
        assert.equal(error.contendedRole, 'scheduler');
        return true;
      },
    );
    assert.deepEqual(await waitForChildExit(server.child), { code: 0, signal: null });
    await waitForQuery(
      async () => (await pool.query(
        'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid = $1',
        [roleBackendPid],
      )).rows[0].count,
      count => count === 0,
    );

    const replacement = await acquire('all', 'after-sigterm');
    await replacement.release();
  });

  await t.test('terminating the dedicated lock connection fail-fast exits the real server', async () => {
    const mediaDirectory = path.join(tempDirectory, 'lock-loss-media');
    const port = await temporaryPort();
    const server = spawnServer({
      databaseUrl: target.rawUrl,
      port,
      mediaDirectory,
      guardSchema,
    });
    servers.add(server);
    await waitForHealth(server, port);
    healthyEntrypointStarted = true;

    const roleConnection = await waitForQuery(
      async () => (await pool.query(`
        SELECT pid
        FROM pg_stat_activity
        WHERE application_name = $1
      `, [`onstarvoice:all:${server.child.pid}`])).rows,
      rows => rows.length === 1,
    );
    const roleBackendPid = roleConnection[0].pid;
    const terminated = await pool.query(
      'SELECT pg_terminate_backend($1) AS terminated',
      [roleBackendPid],
    );
    assert.equal(terminated.rows[0].terminated, true);
    assert.deepEqual(await waitForChildExit(server.child), { code: 1, signal: null });
    assert.match(server.output(), /Lost all execution authority; exiting immediately/u);

    const replacement = await acquire('all', 'after-lock-loss');
    await replacement.release();
  });
});
