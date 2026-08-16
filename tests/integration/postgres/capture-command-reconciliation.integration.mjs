import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool, getPool} from '../../../server/db/pool.js';
import {
  reconcilePendingCaptureCommands,
} from '../../../server/routes/capture-cloud.js';

async function waitForReconciliationLock(
  observerClient,
  blockerPid,
  timeoutMs = 3000,
) {
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
    `, [blockerPid]);
    if (result.rows[0].blocked > 0) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for command reconciliation task lock');
}

async function insertTask(pool, {
  tenantId,
  agentId,
  status,
  metadata = {},
}) {
  const result = await pool.query(`
    INSERT INTO capture_tasks (
      tenant_id, origin_agent_id, assigned_agent_id,
      client_task_id, task_type, platform, status, metadata
    ) VALUES ($1, $2, $2, $3, 'capture', 'douyin', $4, $5::jsonb)
    RETURNING id
  `, [
    tenantId,
    agentId,
    `p3-command-${randomUUID()}`,
    status,
    JSON.stringify(metadata),
  ]);
  return result.rows[0].id;
}

async function insertCommand(pool, {
  tenantId,
  agentId,
  taskId,
  commandType,
  payload = {},
  expired = false,
}) {
  const result = await pool.query(`
    INSERT INTO capture_agent_commands (
      tenant_id, agent_id, task_id, command_type, payload, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5::jsonb,
      CASE WHEN $6::boolean
        THEN now() - interval '1 minute'
        ELSE now() + interval '1 hour'
      END
    )
    RETURNING id
  `, [
    tenantId,
    agentId,
    taskId,
    commandType,
    JSON.stringify(payload),
    expired,
  ]);
  return result.rows[0].id;
}

test('real PostgreSQL command reconciliation preserves expiry, agent availability, and lock ordering', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  await runMigrations();
  const pool = getPool();
  let tenantId;
  let lockClient;
  let lockTransactionOpen = false;
  let racedReconciliation;
  t.after(async () => {
    const cleanupErrors = [];
    const attempt = async callback => {
      try {
        await callback();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (lockClient) {
      if (lockTransactionOpen) await attempt(() => lockClient.query('ROLLBACK'));
      lockClient.release();
    }
    if (racedReconciliation) {
      await attempt(() => racedReconciliation);
    }
    if (tenantId) {
      await attempt(() => pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
    }
    await attempt(closePool);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'P3 command reconciliation cleanup failed',
      );
    }
  });
  const preexistingCommands = await pool.query(`
    SELECT count(*)::integer AS count
    FROM capture_agent_commands
    WHERE status IN ('pending', 'acknowledged')
  `);
  assert.equal(
    preexistingCommands.rows[0].count,
    0,
    'P3 reconciliation characterization requires a dedicated database without pending commands',
  );

  const suffix = randomUUID();
  const tenant = await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`P3 command reconciliation ${suffix}`],
  );
  tenantId = tenant.rows[0].id;
  const authCode = await pool.query(`
    INSERT INTO auth_codes (tenant_id, code, type, status, max_bindings)
    VALUES ($1, $2, 'permanent', 'active', 1)
    RETURNING id
  `, [tenantId, `P3-COMMAND-${suffix}`]);
  const authCodeId = authCode.rows[0].id;
  const binding = await pool.query(`
    INSERT INTO auth_bindings (code_id, fingerprint)
    VALUES ($1, $2)
    RETURNING id
  `, [authCodeId, `p3-command-${suffix}`]);
  const authBindingId = binding.rows[0].id;
  const agent = await pool.query(`
    INSERT INTO capture_agents (
      tenant_id, auth_code_id, auth_binding_id, client_uuid,
      allowed_platforms, capabilities, status
    ) VALUES (
      $1, $2, $3, $4,
      ARRAY['douyin']::text[],
      '{"remoteTaskCreate":true,"supportedPlatforms":["douyin"]}'::jsonb,
      'active'
    )
    RETURNING id
  `, [tenantId, authCodeId, authBindingId, `p3-agent-${suffix}`]);
  const agentId = agent.rows[0].id;

  const resumeTaskId = await insertTask(pool, {
    tenantId,
    agentId,
    status: 'resume_requested',
  });
  const resumeCommandId = await insertCommand(pool, {
    tenantId,
    agentId,
    taskId: resumeTaskId,
    commandType: 'resume',
    payload: {previousStatus: 'failed'},
    expired: true,
  });
  await pool.query(`
    UPDATE capture_tasks
    SET metadata = jsonb_build_object('resumeCommandId', $1::text)
    WHERE id = $2
  `, [resumeCommandId, resumeTaskId]);

  assert.deepEqual(await reconcilePendingCaptureCommands(), {
    tenantCount: 1,
    commandCount: 1,
  });
  const expiredResume = await pool.query(`
    SELECT c.status AS command_status, c.result,
      t.status AS task_status, t.metadata,
      array_agg(e.event_type ORDER BY e.id) AS events
    FROM capture_agent_commands c
    JOIN capture_tasks t ON t.id = c.task_id
    LEFT JOIN capture_task_events e ON e.task_id = t.id
    WHERE c.id = $1
    GROUP BY c.status, c.result, t.status, t.metadata
  `, [resumeCommandId]);
  assert.equal(expiredResume.rows[0].command_status, 'expired');
  assert.equal(expiredResume.rows[0].result.reason, 'expired');
  assert.equal(expiredResume.rows[0].task_status, 'failed');
  assert.equal('resumeCommandId' in expiredResume.rows[0].metadata, false);
  assert.deepEqual(expiredResume.rows[0].events, ['command_expired']);
  assert.deepEqual(await reconcilePendingCaptureCommands(), {
    tenantCount: 0,
    commandCount: 0,
  });
  const resumeEventCount = await pool.query(`
    SELECT count(*)::integer AS count
    FROM capture_task_events
    WHERE task_id = $1 AND event_type = 'command_expired'
  `, [resumeTaskId]);
  assert.equal(resumeEventCount.rows[0].count, 1);

  const unavailableTaskId = await insertTask(pool, {
    tenantId,
    agentId,
    status: 'pending',
  });
  const unavailableCommandId = await insertCommand(pool, {
    tenantId,
    agentId,
    taskId: unavailableTaskId,
    commandType: 'create',
    payload: {
      authCodeId,
      authBindingId,
      platform: 'douyin',
    },
  });
  await pool.query(`
    UPDATE capture_tasks
    SET metadata = jsonb_build_object('createCommandId', $1::text)
    WHERE id = $2
  `, [unavailableCommandId, unavailableTaskId]);
  await pool.query(
    "UPDATE capture_agents SET status = 'paused' WHERE id = $1",
    [agentId],
  );

  assert.deepEqual(await reconcilePendingCaptureCommands(), {
    tenantCount: 1,
    commandCount: 1,
  });
  const unavailableCreate = await pool.query(`
    SELECT c.status AS command_status, c.result,
      t.status AS task_status,
      array_agg(e.event_type ORDER BY e.id) AS events
    FROM capture_agent_commands c
    JOIN capture_tasks t ON t.id = c.task_id
    LEFT JOIN capture_task_events e ON e.task_id = t.id
    WHERE c.id = $1
    GROUP BY c.status, c.result, t.status
  `, [unavailableCommandId]);
  assert.equal(unavailableCreate.rows[0].command_status, 'expired');
  assert.equal(unavailableCreate.rows[0].result.reason, 'agent_inactive');
  assert.equal(unavailableCreate.rows[0].task_status, 'needs_action');
  assert.deepEqual(
    unavailableCreate.rows[0].events,
    ['create_command_canceled_agent_unavailable'],
  );
  await pool.query(
    "UPDATE capture_agents SET status = 'active' WHERE id = $1",
    [agentId],
  );

  const racedTaskId = await insertTask(pool, {
    tenantId,
    agentId,
    status: 'resume_requested',
  });
  const racedCommandId = await insertCommand(pool, {
    tenantId,
    agentId,
    taskId: racedTaskId,
    commandType: 'resume',
    payload: {
      previousStatus: 'failed',
      authCodeId,
      authBindingId,
      platform: 'douyin',
    },
  });
  await pool.query(`
    UPDATE capture_tasks
    SET metadata = jsonb_build_object('resumeCommandId', $1::text)
    WHERE id = $2
  `, [racedCommandId, racedTaskId]);

  lockClient = await pool.connect();
  await lockClient.query('BEGIN');
  lockTransactionOpen = true;
  const blocker = await lockClient.query(
    'SELECT pg_backend_pid()::integer AS pid',
  );
  const blockerPid = blocker.rows[0].pid;
  await lockClient.query(
    'SELECT id FROM capture_tasks WHERE id = $1 FOR UPDATE',
    [racedTaskId],
  );
  await lockClient.query(`
    UPDATE capture_tasks
    SET status = 'canceled', updated_at = now()
    WHERE id = $1
  `, [racedTaskId]);
  racedReconciliation = reconcilePendingCaptureCommands();
  await waitForReconciliationLock(lockClient, blockerPid);
  await lockClient.query('COMMIT');
  lockTransactionOpen = false;
  lockClient.release();
  lockClient = null;

  assert.deepEqual(await racedReconciliation, {
    tenantCount: 1,
    commandCount: 1,
  });
  racedReconciliation = null;
  const raced = await pool.query(`
    SELECT c.status AS command_status, c.result,
      t.status AS task_status,
      array_agg(e.event_type ORDER BY e.id) AS events
    FROM capture_agent_commands c
    JOIN capture_tasks t ON t.id = c.task_id
    LEFT JOIN capture_task_events e ON e.task_id = t.id
    WHERE c.id = $1
    GROUP BY c.status, c.result, t.status
  `, [racedCommandId]);
  assert.equal(raced.rows[0].command_status, 'expired');
  assert.equal(raced.rows[0].result.reason, 'task_state_changed');
  assert.equal(raced.rows[0].task_status, 'canceled');
  assert.deepEqual(raced.rows[0].events, ['command_canceled_task_changed']);
});
