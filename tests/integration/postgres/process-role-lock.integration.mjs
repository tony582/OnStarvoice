import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const holderFixture = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'process-role-lock-holder.mjs',
);

function waitForChildExit(child, timeoutMs = 5000) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child process ${child.pid} to exit`));
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

async function waitForValue(query, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await query();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL value; last=${JSON.stringify(value)}`);
}

function spawnLockHolder({ role, applicationName }) {
  const child = spawn(process.execPath, [holderFixture, role, applicationName], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const events = [];
  const waiters = new Set();
  let stdoutBuffer = '';
  let stderr = '';

  const dispatch = event => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.eventName !== event.event) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    }
  };

  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        dispatch(JSON.parse(line));
      } catch {
        dispatch({ event: 'invalid-json', line });
      }
    }
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  const waitForEvent = (eventName, timeoutMs = 5000) => {
    const existing = events.find(event => event.event === eventName);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = {
        eventName,
        resolve,
        reject,
        timeout: null,
      };
      waiter.timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(
          `Timed out waiting for ${eventName} from child ${child.pid}; stderr=${stderr.trim()}`,
        ));
      }, timeoutMs);
      waiters.add(waiter);
    });
  };

  return {
    child,
    events,
    waitForEvent,
    getStderr: () => stderr,
  };
}

async function stopChild(holder) {
  const { child } = holder;
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  try {
    await waitForChildExit(child, 3000);
  } catch {
    child.kill('SIGKILL');
    await waitForChildExit(child, 3000);
  }
}

test('PostgreSQL session locks fence process roles and fail closed on lock loss', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const { closePool, getPool } = await import('../../../server/db/pool.js');
  const {
    acquireProcessRoleLocks,
    ProcessRoleLockUnavailableError,
  } = await import('../../../server/runtime/process-role-locks.js');

  const runId = randomUUID();
  const applicationPrefix = `p2b-lock-${runId}`;
  const handles = new Set();
  const holders = new Set();
  const inspectedPids = new Set();
  const pool = getPool();

  const acquire = async (role, suffix) => {
    const handle = await acquireProcessRoleLocks({
      role,
      databaseUrl: target.rawUrl,
      applicationName: `${applicationPrefix}-${suffix}`,
      logger: { error() {} },
      onLockLost() {},
    });
    handles.add(handle);
    if (handle.backendPid) inspectedPids.add(handle.backendPid);
    return handle;
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
    const cleanupErrors = [];
    for (const holder of holders) {
      try {
        await stopChild(holder);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const handle of handles) {
      try {
        await handle.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      const lingering = await pool.query(`
        SELECT pid
        FROM pg_stat_activity
        WHERE application_name LIKE $1
          AND pid <> pg_backend_pid()
      `, [`${applicationPrefix}%`]);
      for (const row of lingering.rows) {
        inspectedPids.add(row.pid);
        await pool.query('SELECT pg_terminate_backend($1)', [row.pid]);
      }

      const active = await pool.query(`
        SELECT count(*)::integer AS count
        FROM pg_stat_activity
        WHERE application_name LIKE $1
      `, [`${applicationPrefix}%`]);
      assert.equal(active.rows[0].count, 0, 'test left a role-lock connection open');

      if (inspectedPids.size > 0) {
        const locks = await pool.query(`
          SELECT count(*)::integer AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = ANY($1::integer[])
        `, [[...inspectedPids]]);
        assert.equal(locks.rows[0].count, 0, 'test left an advisory role lock behind');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      await closePool();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'P2-B process-role lock cleanup failed');
    }
  });

  await t.test('only one holder can own a role and release is idempotent', async () => {
    const noLockApi = await acquire('api', 'api');
    const noLockMaintenance = await acquire('maintenance', 'maintenance');
    assert.equal(noLockApi.backendPid, null);
    assert.deepEqual(noLockApi.heldRoles, []);
    assert.equal(noLockMaintenance.backendPid, null);
    assert.deepEqual(noLockMaintenance.heldRoles, []);
    await assert.rejects(
      acquireProcessRoleLocks({
        role: 'scheduler',
        databaseUrl: target.rawUrl,
      }),
      /onLockLost is required for process role scheduler/u,
    );
    await assert.rejects(
      acquireProcessRoleLocks({
        role: 'scheduler',
        databaseUrl: target.rawUrl,
        connectionTimeoutMillis: 0,
        onLockLost() {},
      }),
      /connectionTimeoutMillis must be a positive integer/u,
    );

    const first = await acquire('scheduler', 'scheduler-first');
    assert.equal(first.role, 'scheduler');
    assert.deepEqual(first.heldRoles, ['scheduler']);
    assert.equal(Number.isInteger(first.backendPid), true);
    assert.equal(await advisoryLockCount(first.backendPid), 1);

    const startedAt = Date.now();
    await assert.rejects(
      acquire('scheduler', 'scheduler-contender'),
      error => {
        assert.equal(error instanceof ProcessRoleLockUnavailableError, true);
        assert.equal(error.code, 'PROCESS_ROLE_LOCK_UNAVAILABLE');
        assert.equal(error.requestedRole, 'scheduler');
        assert.equal(error.contendedRole, 'scheduler');
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2000, 'lock competition must be non-blocking');

    const firstRelease = first.release();
    assert.equal(first.release(), firstRelease);
    await firstRelease;
    assert.equal(await advisoryLockCount(first.backendPid), 0);

    const replacement = await acquire('scheduler', 'scheduler-replacement');
    await replacement.release();

    let normalReleaseLockLosses = 0;
    const defaultApplicationName = await acquireProcessRoleLocks({
      role: 'scheduler',
      logger: { error() {} },
      onLockLost() {
        normalReleaseLockLosses += 1;
      },
    });
    handles.add(defaultApplicationName);
    inspectedPids.add(defaultApplicationName.backendPid);
    const defaultConnection = await pool.query(`
      SELECT application_name
      FROM pg_stat_activity
      WHERE pid = $1
    `, [defaultApplicationName.backendPid]);
    assert.equal(
      defaultConnection.rows[0].application_name,
      `onstarvoice:scheduler:${process.pid}`,
    );
    await defaultApplicationName.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(normalReleaseLockLosses, 0);

    await noLockApi.release();
    await noLockMaintenance.release();
  });

  await t.test('all uses one session and rolls back its first lock if the second conflicts', async () => {
    const blocker = await acquire('ai-media', 'ai-blocker');
    await assert.rejects(
      acquire('all', 'all-conflict'),
      error => {
        assert.equal(error.code, 'PROCESS_ROLE_LOCK_UNAVAILABLE');
        assert.equal(error.contendedRole, 'ai-media');
        assert.deepEqual(error.heldRoles, ['scheduler']);
        return true;
      },
    );

    const schedulerAfterFailure = await acquire('scheduler', 'scheduler-after-all-failure');
    assert.equal(await advisoryLockCount(schedulerAfterFailure.backendPid), 1);
    await schedulerAfterFailure.release();
    await blocker.release();

    const all = await acquire('all', 'all-success');
    assert.deepEqual(all.heldRoles, ['scheduler', 'ai-media']);
    assert.equal(await advisoryLockCount(all.backendPid), 2);
    await all.release();
  });

  await t.test('the dedicated session heartbeats and normal release stops it cleanly', async () => {
    let lockLosses = 0;
    const heartbeat = await acquireProcessRoleLocks({
      role: 'scheduler',
      databaseUrl: target.rawUrl,
      applicationName: `${applicationPrefix}-heartbeat`,
      connectionTimeoutMillis: 1000,
      queryTimeoutMillis: 1000,
      heartbeatIntervalMillis: 20,
      keepAliveInitialDelayMillis: 20,
      logger: { error() {} },
      onLockLost() {
        lockLosses += 1;
      },
    });
    handles.add(heartbeat);
    inspectedPids.add(heartbeat.backendPid);

    const lastQuery = await waitForValue(
      async () => (await pool.query(`
        SELECT query
        FROM pg_stat_activity
        WHERE pid = $1
      `, [heartbeat.backendPid])).rows[0]?.query || '',
      query => /process_role_lock_heartbeat/u.test(query),
    );
    assert.match(lastQuery, /process_role_lock_heartbeat/u);
    assert.equal(await advisoryLockCount(heartbeat.backendPid), 1);

    await heartbeat.release();
    await waitForValue(
      async () => (await pool.query(`
        SELECT count(*)::integer AS count
        FROM pg_stat_activity
        WHERE pid = $1
      `, [heartbeat.backendPid])).rows[0].count,
      count => count === 0,
    );
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(lockLosses, 0);
  });

  await t.test('SIGTERM keeps the child lock until exit before another process takes over', async () => {
    const holder = spawnLockHolder({
      role: 'scheduler',
      applicationName: `${applicationPrefix}-sigterm-child`,
    });
    holders.add(holder);
    const acquired = await holder.waitForEvent('acquired');
    inspectedPids.add(acquired.backendPid);
    assert.deepEqual(acquired.heldRoles, ['scheduler']);
    assert.equal(await advisoryLockCount(acquired.backendPid), 1);

    holder.child.kill('SIGTERM');
    await holder.waitForEvent('shutdown-started');
    assert.equal(holder.child.exitCode, null);
    assert.equal(holder.child.signalCode, null);
    assert.equal(await advisoryLockCount(acquired.backendPid), 1);
    await assert.rejects(
      acquire('scheduler', 'scheduler-during-sigterm'),
      error => {
        assert.equal(error.code, 'PROCESS_ROLE_LOCK_UNAVAILABLE');
        assert.equal(error.contendedRole, 'scheduler');
        return true;
      },
    );
    const exit = await waitForChildExit(holder.child);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(await advisoryLockCount(acquired.backendPid), 0);

    const replacement = await acquire('scheduler', 'scheduler-after-sigterm');
    await replacement.release();
  });

  await t.test('terminating the lock backend notifies once and the child exits', async () => {
    const holder = spawnLockHolder({
      role: 'ai-media',
      applicationName: `${applicationPrefix}-terminated-child`,
    });
    holders.add(holder);
    const acquired = await holder.waitForEvent('acquired');
    inspectedPids.add(acquired.backendPid);
    assert.equal(await advisoryLockCount(acquired.backendPid), 1);

    const terminated = await pool.query(
      'SELECT pg_terminate_backend($1) AS terminated',
      [acquired.backendPid],
    );
    assert.equal(terminated.rows[0].terminated, true);
    const lockLost = await holder.waitForEvent('lock-lost');
    assert.equal(lockLost.count, 1);
    assert.equal(lockLost.backendPid, acquired.backendPid);
    const exit = await waitForChildExit(holder.child);
    assert.deepEqual(exit, { code: 73, signal: null });
    assert.equal(
      holder.events.filter(event => event.event === 'lock-lost').length,
      1,
    );
    assert.equal(await advisoryLockCount(acquired.backendPid), 0);

    const replacement = await acquire('ai-media', 'ai-after-termination');
    await replacement.release();
  });
});
