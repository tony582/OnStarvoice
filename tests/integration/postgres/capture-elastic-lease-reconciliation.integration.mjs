import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool, getPool} from '../../../server/db/pool.js';
import {
  reconcileElasticCaptureLeases,
} from '../../../server/routes/capture-cloud.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const requireFromServer = createRequire(
  path.join(repositoryRoot, 'server', 'package.json'),
);
const {Client} = requireFromServer('pg');

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function quoteProbeIdentifier(value) {
  assert.match(value, /^p3_elastic_[a-z0-9_]+$/u);
  return `"${value}"`;
}

async function waitForItemLock(observerClient, blockerPid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observerClient.query('SELECT pg_stat_clear_snapshot()');
    const result = await observerClient.query(`
      SELECT count(*)::integer AS blocked
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND $1::integer = ANY(pg_blocking_pids(pid))
        AND query LIKE '%FROM capture_task_items%'
        AND query LIKE '%FOR UPDATE%'
    `, [blockerPid]);
    if (result.rows[0].blocked > 0) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for elastic lease item lock');
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createLeaseFixture(pool, {
  tenantId,
  distributionMode = 'elastic_pool',
  agentHeartbeatAge = '30 minutes',
  childHeartbeatAge = '30 minutes',
  childUpdatedAge = '30 minutes',
} = {}) {
  const suffix = randomUUID();
  const agent = await pool.query(`
    INSERT INTO capture_agents (
      tenant_id, client_uuid, display_name, status, last_heartbeat_at
    ) VALUES (
      $1, $2, $3, 'active', now() - $4::interval
    )
    RETURNING id
  `, [
    tenantId,
    `p3-elastic-agent-${suffix}`,
    `P3 elastic Agent ${suffix}`,
    agentHeartbeatAge,
  ]);
  const agentId = agent.rows[0].id;
  const parent = await pool.query(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key,
      title, platform, status, metadata
    ) VALUES (
      $1, $2, 'capture_orchestration', 'unattended_keyword_plan',
      $3, 'douyin', 'running', $4::jsonb
    )
    RETURNING id
  `, [
    tenantId,
    `p3-elastic-parent-${suffix}`,
    `P3 elastic parent ${suffix}`,
    JSON.stringify({distributionMode}),
  ]);
  const parentTaskId = parent.rows[0].id;
  const child = await pool.query(`
    INSERT INTO capture_tasks (
      tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, task_type, feature_key, title, platform,
      status, metadata, heartbeat_at, started_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $3,
      $4, 'unattended_keyword_capture', 'unattended_keyword_plan', $5, 'douyin',
      'running', '{"cloudWorkQueue":true}'::jsonb,
      now() - $6::interval, now() - $6::interval,
      now() - $7::interval, now() - $7::interval
    )
    RETURNING id
  `, [
    tenantId,
    parentTaskId,
    agentId,
    `p3-elastic-child-${suffix}`,
    `P3 elastic child ${suffix}`,
    childHeartbeatAge,
    childUpdatedAge,
  ]);
  const childTaskId = child.rows[0].id;
  const item = await pool.query(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type,
      status, attempt_count, ordinal, keyword,
      assigned_agent_id, execution_task_id, assignment_revision,
      metadata, assigned_at, dispatched_at, started_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, 'douyin', 'keyword',
      'running', 1, 0, $4,
      $5, $6, 1,
      '{"elasticAttemptBudgetUsed":1}'::jsonb,
      now() - interval '30 minutes', now() - interval '30 minutes',
      now() - interval '30 minutes', now() - interval '30 minutes',
      now() - interval '30 minutes'
    )
    RETURNING id
  `, [
    tenantId,
    parentTaskId,
    `p3-elastic-item-${suffix}`,
    `keyword-${suffix}`,
    agentId,
    childTaskId,
  ]);
  const itemId = item.rows[0].id;
  const attempt = await pool.query(`
    INSERT INTO capture_task_item_attempts (
      tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      started_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, 1, 1, 'running',
      now() - interval '30 minutes',
      now() - interval '30 minutes', now() - interval '30 minutes'
    )
    RETURNING id
  `, [tenantId, itemId, parentTaskId, childTaskId, agentId]);

  return {
    agentId,
    attemptId: attempt.rows[0].id,
    childTaskId,
    itemId,
    parentTaskId,
  };
}

async function readLeaseState(pool, fixture) {
  const [task, item, attempt, events] = await Promise.all([
    pool.query(`
      SELECT child.status AS child_status, child.error AS child_error,
        child.finished_at::text AS child_finished_at,
        child.updated_at::text AS child_updated_at,
        parent.status AS parent_status, parent.progress AS parent_progress,
        parent.counts AS parent_counts,
        parent.updated_at::text AS parent_updated_at
      FROM capture_tasks child
      JOIN capture_tasks parent ON parent.id = child.parent_task_id
      WHERE child.id = $1
    `, [fixture.childTaskId]),
    pool.query(`
      SELECT status, error, metadata,
        finished_at::text AS finished_at,
        updated_at::text AS updated_at
      FROM capture_task_items
      WHERE id = $1
    `, [fixture.itemId]),
    pool.query(`
      SELECT status, error,
        finished_at::text AS finished_at,
        updated_at::text AS updated_at
      FROM capture_task_item_attempts
      WHERE id = $1
    `, [fixture.attemptId]),
    pool.query(`
      SELECT event_type, status, payload
      FROM capture_task_events
      WHERE task_id = $1
      ORDER BY id
    `, [fixture.childTaskId]),
  ]);
  return {
    attempt: attempt.rows[0],
    events: events.rows,
    item: item.rows[0],
    task: task.rows[0],
  };
}

function assertRequeued(state, timeoutCode) {
  assert.equal(state.task.child_status, 'failed');
  assert.equal(state.task.child_error.code, timeoutCode);
  assert.equal(state.task.child_error.retryable, true);
  assert.ok(state.task.child_finished_at);
  assert.equal(state.task.parent_status, 'running');
  assert.equal(state.task.parent_counts.retryable, 1);

  assert.equal(state.item.status, 'retryable');
  assert.equal(state.item.error.code, timeoutCode);
  assert.equal(state.item.error.automaticRetry, true);
  assert.equal(state.item.metadata.elasticAttemptBudgetUsed, 1);
  assert.equal(state.item.finished_at, null);

  assert.equal(state.attempt.status, 'retryable');
  assert.equal(state.attempt.error.code, timeoutCode);
  assert.equal(state.attempt.finished_at, null);
  assert.deepEqual(
    state.events.map(event => [event.event_type, event.payload.timeoutCode]),
    [['elastic_work_item_requeued', timeoutCode]],
  );
}

test('real PostgreSQL elastic lease reconciliation preserves eligibility, rollback, and locking', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const applicationPrefix = `p3-elastic-${token}`;
  const originalApplicationName = process.env.PGAPPNAME;
  const originalPoolMax = process.env.PG_POOL_MAX;
  process.env.PGAPPNAME = `${applicationPrefix}-pool`;
  process.env.PG_POOL_MAX = '2';

  let pool;
  let tenantId;
  let blockerClient;
  let blockerTransactionOpen = false;
  let rollbackProbe;
  const reconciliationPromises = [];
  const trackReconciliation = promise => {
    promise.catch(() => {});
    reconciliationPromises.push(promise);
    return promise;
  };

  t.after(async () => {
    const cleanupErrors = [];
    const attemptCleanup = async callback => {
      try {
        await callback();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    if (blockerClient && blockerTransactionOpen) {
      await attemptCleanup(() => blockerClient.query('ROLLBACK'));
      blockerTransactionOpen = false;
    }
    if (blockerClient) {
      const clientToClose = blockerClient;
      blockerClient = null;
      await attemptCleanup(() => withTimeout(
        clientToClose.end(),
        5000,
        'Timed out closing the elastic lease blocker client',
      ));
      if (!clientToClose.connection?.stream?.destroyed) {
        clientToClose.connection?.stream?.destroy();
      }
    }
    await attemptCleanup(() => withTimeout(
      Promise.allSettled(reconciliationPromises),
      10000,
      'Timed out settling elastic lease reconciliation promises',
    ));
    if (pool && rollbackProbe) {
      await attemptCleanup(() => pool.query(
        `DROP TRIGGER IF EXISTS ${quoteProbeIdentifier(rollbackProbe.trigger)} ON capture_task_events`,
      ));
      await attemptCleanup(() => pool.query(
        `DROP FUNCTION IF EXISTS ${quoteProbeIdentifier(rollbackProbe.function)}()`,
      ));
      rollbackProbe = null;
    }
    if (pool && tenantId) {
      await attemptCleanup(() => pool.query(
        'DELETE FROM tenants WHERE id = $1',
        [tenantId],
      ));
    }
    await attemptCleanup(closePool);
    restoreEnvironment('PGAPPNAME', originalApplicationName);
    restoreEnvironment('PG_POOL_MAX', originalPoolMax);

    const verifier = new Client({
      connectionString: target.rawUrl,
      application_name: `${applicationPrefix}-cleanup`,
      query_timeout: 5000,
    });
    try {
      await verifier.connect();
      const active = await verifier.query(`
        SELECT count(*)::integer AS count
        FROM pg_stat_activity
        WHERE application_name LIKE $1
          AND pid <> pg_backend_pid()
      `, [`${applicationPrefix}%`]);
      assert.equal(active.rows[0].count, 0, 'P3 elastic lease test left a PostgreSQL session open');
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        await verifier.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'P3 elastic lease reconciliation cleanup failed',
      );
    }
  });

  pool = getPool();
  await runMigrations();
  const preexistingElasticChildren = await pool.query(`
    SELECT count(*)::integer AS count
    FROM capture_tasks child
    JOIN capture_tasks parent
      ON parent.id = child.parent_task_id
      AND parent.tenant_id = child.tenant_id
    WHERE child.status IN (
      'pending', 'claimed', 'running', 'recovering', 'waiting_device'
    )
      AND COALESCE(parent.metadata->>'distributionMode', '') = 'elastic_pool'
  `);
  assert.equal(
    preexistingElasticChildren.rows[0].count,
    0,
    'P3 elastic lease characterization requires a dedicated database without active elastic children',
  );

  const tenant = await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`P3 elastic lease ${token}`],
  );
  tenantId = tenant.rows[0].id;

  const offline = await createLeaseFixture(pool, {tenantId});
  const taskHeartbeat = await createLeaseFixture(pool, {
    tenantId,
    agentHeartbeatAge: '1 minute',
    childHeartbeatAge: '30 minutes',
    childUpdatedAge: '1 minute',
  });
  const fixed = await createLeaseFixture(pool, {
    tenantId,
    distributionMode: 'fixed_batch',
  });
  const fixedBefore = await readLeaseState(pool, fixed);

  assert.deepEqual(await reconcileElasticCaptureLeases(20), {
    scanned: 2,
    requeued: 2,
    skipped: 0,
  });
  assertRequeued(
    await readLeaseState(pool, offline),
    'elastic_agent_offline_timeout',
  );
  assertRequeued(
    await readLeaseState(pool, taskHeartbeat),
    'elastic_task_heartbeat_timeout',
  );
  assert.deepEqual(await readLeaseState(pool, fixed), fixedBefore);
  assert.deepEqual(await reconcileElasticCaptureLeases(20), {
    scanned: 0,
    requeued: 0,
    skipped: 0,
  });
  const eligibleEventCount = await pool.query(`
    SELECT count(*)::integer AS count
    FROM capture_task_events
    WHERE task_id = ANY($1::uuid[])
      AND event_type = 'elastic_work_item_requeued'
  `, [[offline.childTaskId, taskHeartbeat.childTaskId]]);
  assert.equal(eligibleEventCount.rows[0].count, 2);

  const commandFenced = await createLeaseFixture(pool, {tenantId});
  const commandFencedBefore = await readLeaseState(pool, commandFenced);
  await pool.query(`
    INSERT INTO capture_agent_commands (
      tenant_id, agent_id, task_id, command_type, payload, expires_at
    ) VALUES (
      $1, $2, $3, 'stop', '{}'::jsonb, now() + interval '1 hour'
    )
  `, [
    tenantId,
    commandFenced.agentId,
    commandFenced.childTaskId,
  ]);
  assert.deepEqual(await reconcileElasticCaptureLeases(20), {
    scanned: 0,
    requeued: 0,
    skipped: 0,
  });
  assert.deepEqual(
    await readLeaseState(pool, commandFenced),
    commandFencedBefore,
  );

  const concurrent = await createLeaseFixture(pool, {tenantId});
  blockerClient = new Client({
    connectionString: target.rawUrl,
    application_name: `${applicationPrefix}-blocker`,
    query_timeout: 5000,
  });
  await blockerClient.connect();
  await blockerClient.query('BEGIN');
  blockerTransactionOpen = true;
  const blocker = await blockerClient.query(
    'SELECT pg_backend_pid()::integer AS pid',
  );
  await blockerClient.query(
    'SELECT id FROM capture_task_items WHERE id = $1 FOR UPDATE',
    [concurrent.itemId],
  );
  const firstConcurrent = trackReconciliation(
    reconcileElasticCaptureLeases(1),
  );
  await waitForItemLock(blockerClient, blocker.rows[0].pid);
  const secondConcurrent = trackReconciliation(
    reconcileElasticCaptureLeases(1),
  );
  try {
    assert.deepEqual(
      await withTimeout(
        secondConcurrent,
        5000,
        'Concurrent elastic lease reconciliation did not honor SKIP LOCKED',
      ),
      {scanned: 1, requeued: 0, skipped: 1},
    );
    await blockerClient.query('COMMIT');
    blockerTransactionOpen = false;
  } finally {
    if (blockerTransactionOpen) {
      await blockerClient.query('ROLLBACK');
      blockerTransactionOpen = false;
    }
  }
  assert.deepEqual(await firstConcurrent, {
    scanned: 1,
    requeued: 1,
    skipped: 0,
  });
  assertRequeued(
    await readLeaseState(pool, concurrent),
    'elastic_agent_offline_timeout',
  );

  const childLocked = await createLeaseFixture(pool, {tenantId});
  const childLockedBefore = await readLeaseState(pool, childLocked);
  await blockerClient.query('BEGIN');
  blockerTransactionOpen = true;
  await blockerClient.query(
    'SELECT id FROM capture_tasks WHERE id = $1 FOR UPDATE',
    [childLocked.childTaskId],
  );
  const childLockReconciliation = trackReconciliation(
    reconcileElasticCaptureLeases(1),
  );
  try {
    assert.deepEqual(
      await withTimeout(
        childLockReconciliation,
        5000,
        'Elastic lease reconciliation blocked on a locked child row',
      ),
      {scanned: 1, requeued: 0, skipped: 1},
    );
    await blockerClient.query('COMMIT');
    blockerTransactionOpen = false;
  } finally {
    if (blockerTransactionOpen) {
      await blockerClient.query('ROLLBACK');
      blockerTransactionOpen = false;
    }
  }
  assert.deepEqual(await readLeaseState(pool, childLocked), childLockedBefore);
  assert.deepEqual(await reconcileElasticCaptureLeases(1), {
    scanned: 1,
    requeued: 1,
    skipped: 0,
  });
  assertRequeued(
    await readLeaseState(pool, childLocked),
    'elastic_agent_offline_timeout',
  );

  const rollback = await createLeaseFixture(pool, {tenantId});
  const rollbackBefore = await readLeaseState(pool, rollback);
  const probeToken = randomUUID().replaceAll('-', '').slice(0, 12);
  rollbackProbe = {
    function: `p3_elastic_${probeToken}_fn`,
    trigger: `p3_elastic_${probeToken}_trg`,
  };
  assert.match(
    rollback.childTaskId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
  await pool.query(`
    CREATE FUNCTION ${quoteProbeIdentifier(rollbackProbe.function)}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $probe$
    BEGIN
      RAISE EXCEPTION 'P3_ELASTIC_ROLLBACK_PROBE';
    END;
    $probe$
  `);
  await pool.query(`
    CREATE TRIGGER ${quoteProbeIdentifier(rollbackProbe.trigger)}
    BEFORE INSERT ON capture_task_events
    FOR EACH ROW
    WHEN (
      NEW.event_type = 'elastic_work_item_requeued'
      AND NEW.task_id = '${rollback.childTaskId}'::uuid
    )
    EXECUTE FUNCTION ${quoteProbeIdentifier(rollbackProbe.function)}()
  `);
  await assert.rejects(
    reconcileElasticCaptureLeases(1),
    /P3_ELASTIC_ROLLBACK_PROBE/u,
  );
  assert.deepEqual(await readLeaseState(pool, rollback), rollbackBefore);

  await pool.query(
    `DROP TRIGGER ${quoteProbeIdentifier(rollbackProbe.trigger)} ON capture_task_events`,
  );
  await pool.query(
    `DROP FUNCTION ${quoteProbeIdentifier(rollbackProbe.function)}()`,
  );
  rollbackProbe = null;
  assert.deepEqual(await reconcileElasticCaptureLeases(1), {
    scanned: 1,
    requeued: 1,
    skipped: 0,
  });
  assertRequeued(
    await readLeaseState(pool, rollback),
    'elastic_agent_offline_timeout',
  );
});
