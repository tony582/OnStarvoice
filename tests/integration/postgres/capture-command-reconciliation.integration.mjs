import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {withTransaction} from '../../../server/db/init.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool, getPool} from '../../../server/db/pool.js';
import {
  expireStaleCommands,
  reconcilePendingCaptureCommands,
} from '../../../server/modules/capture/infrastructure/postgres-command-reconciliation.js';

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

async function createProfileCommandFixture(pool, {
  tenantId,
  agentId,
  authCodeId,
  authBindingId,
  label,
  expired,
}) {
  const suffix = randomUUID();
  const subscription = await pool.query(`
    INSERT INTO monitor_subscriptions (
      tenant_id, name, keyword, platform, cadence_minutes,
      status, next_run_at
    ) VALUES (
      $1, $2, $3, 'douyin', 60,
      'active', now() - interval '1 minute'
    )
    RETURNING id
  `, [
    tenantId,
    `P3 command profile ${label}`,
    `profile-${label}-${suffix}`,
  ]);
  const subscriptionId = subscription.rows[0].id;
  const execution = await pool.query(`
    INSERT INTO monitor_executions (
      tenant_id, subscription_id, status, started_at
    ) VALUES ($1, $2, 'running', now() - interval '1 minute')
    RETURNING id
  `, [tenantId, subscriptionId]);
  const monitorExecutionId = execution.rows[0].id;
  const parent = await pool.query(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key,
      title, platform, source, trigger_type, status,
      progress, counts, metadata, started_at
    ) VALUES (
      $1, $2, 'capture_orchestration', 'followed_creator_post_patrol',
      $3, 'douyin', 'cloud', 'profile_patrol', 'running',
      '{"current":0,"total":1,"percent":0}'::jsonb,
      '{"total":1,"waitingDevice":1}'::jsonb,
      '{"promotedBusinessTaskType":"followed_creator_post_patrol"}'::jsonb,
      now() - interval '1 minute'
    )
    RETURNING id
  `, [
    tenantId,
    `p3-command-profile-parent-${suffix}`,
    `P3 command profile parent ${label}`,
  ]);
  const parentTaskId = parent.rows[0].id;
  const child = await pool.query(`
    INSERT INTO capture_tasks (
      tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, task_type, feature_key, title, platform,
      source, trigger_type, status, metadata
    ) VALUES (
      $1, $2, $3, $3,
      $4, 'followed_creator_post_patrol',
      'followed_creator_post_patrol', $5, 'douyin',
      'extension', 'orchestration_child', 'pending', '{}'::jsonb
    )
    RETURNING id
  `, [
    tenantId,
    parentTaskId,
    agentId,
    `p3-command-profile-child-${suffix}`,
    `P3 command profile child ${label}`,
  ]);
  const childTaskId = child.rows[0].id;
  const item = await pool.query(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type,
      status, attempt_count, ordinal, keyword,
      assigned_agent_id, execution_task_id, assignment_revision,
      metadata, assigned_at, dispatched_at, started_at
    ) VALUES (
      $1, $2, $3, 'douyin', 'profile',
      'waiting_device', 1, 0, $4,
      $5, $6, 1,
      jsonb_build_object('monitorExecutionId', $7::uuid::text),
      now() - interval '1 minute', now() - interval '1 minute', NULL
    )
    RETURNING id
  `, [
    tenantId,
    parentTaskId,
    `p3-command-profile-item-${suffix}`,
    `profile-${label}-${suffix}`,
    agentId,
    childTaskId,
    monitorExecutionId,
  ]);
  const itemId = item.rows[0].id;
  const attempt = await pool.query(`
    INSERT INTO capture_task_item_attempts (
      tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      assigned_at, dispatched_at, started_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, 1, 1, 'waiting_device',
      now() - interval '1 minute', now() - interval '1 minute',
      NULL
    )
    RETURNING id
  `, [tenantId, itemId, parentTaskId, childTaskId, agentId]);
  const attemptId = attempt.rows[0].id;
  const commandId = await insertCommand(pool, {
    tenantId,
    agentId,
    taskId: childTaskId,
    commandType: 'create',
    payload: {
      authCodeId,
      authBindingId,
      platform: 'douyin',
      workflow: 'followed_creator_post_patrol',
    },
    expired,
  });
  await pool.query(`
    UPDATE capture_tasks
    SET metadata = jsonb_build_object('createCommandId', $1::text)
    WHERE id = $2
  `, [commandId, childTaskId]);

  return {
    attemptId,
    childTaskId,
    commandId,
    itemId,
    monitorExecutionId,
    parentTaskId,
    subscriptionId,
  };
}

async function readProfileCommandState(pool, fixture) {
  const [command, child, parent, item, attempt, execution, subscription, events] =
    await Promise.all([
      pool.query(`
        SELECT status, result, finished_at::text AS finished_at
        FROM capture_agent_commands
        WHERE id = $1
      `, [fixture.commandId]),
      pool.query(`
        SELECT status, error, message, metadata,
          finished_at::text AS finished_at
        FROM capture_tasks
        WHERE id = $1
      `, [fixture.childTaskId]),
      pool.query(`
        SELECT status, progress, counts, message,
          finished_at::text AS finished_at
        FROM capture_tasks
        WHERE id = $1
      `, [fixture.parentTaskId]),
      pool.query(`
        SELECT status, error, finished_at::text AS finished_at
        FROM capture_task_items
        WHERE id = $1
      `, [fixture.itemId]),
      pool.query(`
        SELECT status, error, finished_at::text AS finished_at
        FROM capture_task_item_attempts
        WHERE id = $1
      `, [fixture.attemptId]),
      pool.query(`
        SELECT status, error_message,
          finished_at::text AS finished_at
        FROM monitor_executions
        WHERE id = $1
      `, [fixture.monitorExecutionId]),
      pool.query(`
        SELECT last_error,
          last_run_at::text AS last_run_at,
          next_run_at::text AS next_run_at
        FROM monitor_subscriptions
        WHERE id = $1
      `, [fixture.subscriptionId]),
      pool.query(`
        SELECT task_id::text, event_type, status, payload
        FROM capture_task_events
        WHERE task_id = ANY($1::uuid[])
        ORDER BY id
      `, [[fixture.childTaskId, fixture.parentTaskId]]),
    ]);
  return {
    attempt: attempt.rows[0],
    child: child.rows[0],
    command: command.rows[0],
    events: events.rows,
    execution: execution.rows[0],
    item: item.rows[0],
    parent: parent.rows[0],
    subscription: subscription.rows[0],
  };
}

function assertProfileCommandSettled(state, fixture, {
  childStatus,
  childMessage,
  code,
  commandReason,
  commandEvent,
  message,
}) {
  assert.equal(state.command.status, 'expired');
  assert.equal(state.command.result.reason, commandReason);
  assert.ok(state.command.finished_at);
  assert.equal(state.child.status, childStatus);
  assert.equal(state.child.error.code, code);
  assert.equal(state.child.error.message, message);
  assert.equal(state.child.message, childMessage);
  assert.equal(
    state.child.metadata.createCommandId,
    fixture.commandId,
  );
  if (childStatus === 'failed') assert.ok(state.child.finished_at);
  else assert.equal(state.child.finished_at, null);

  assert.equal(state.item.status, 'failed');
  assert.equal(state.item.error.code, code);
  assert.equal(state.item.error.message, message);
  assert.ok(state.item.finished_at);
  assert.equal(state.attempt.status, 'failed');
  assert.equal(state.attempt.error.code, code);
  assert.equal(state.attempt.error.message, message);
  assert.ok(state.attempt.finished_at);

  assert.equal(state.execution.status, 'failed');
  assert.equal(state.execution.error_message, message);
  assert.ok(state.execution.finished_at);
  assert.equal(state.subscription.last_error, message);
  assert.equal(state.subscription.last_run_at, state.execution.finished_at);
  const retryDelayMs = Date.parse(state.subscription.next_run_at) -
    Date.parse(state.subscription.last_run_at);
  assert.equal(retryDelayMs, 15 * 60 * 1000);

  assert.equal(state.parent.status, 'completed_with_failures');
  assert.deepEqual(state.parent.progress, {
    current: 1,
    total: 1,
    percent: 100,
  });
  assert.equal(state.parent.counts.total, 1);
  assert.equal(state.parent.counts.failed, 1);
  assert.equal(state.parent.counts.settled, 1);
  assert.equal(state.parent.message, '账号巡查任务已结算');
  assert.ok(state.parent.finished_at);
  assert.equal(state.events.length, 2);
  const [commandEventRow, parentEventRow] = state.events;
  assert.equal(commandEventRow.task_id, fixture.childTaskId);
  assert.equal(commandEventRow.event_type, commandEvent);
  assert.equal(commandEventRow.status, childStatus);
  assert.equal(commandEventRow.payload.commandId, fixture.commandId);
  assert.equal(commandEventRow.payload.commandType, 'create');
  assert.equal(parentEventRow.task_id, fixture.parentTaskId);
  assert.equal(parentEventRow.event_type, 'orchestration_status_changed');
  assert.equal(parentEventRow.status, 'completed_with_failures');
  assert.equal(parentEventRow.payload.previousStatus, 'running');
  assert.equal(parentEventRow.payload.childTaskId, fixture.childTaskId);
  assert.deepEqual(parentEventRow.payload.progress, state.parent.progress);
}

test('real PostgreSQL command reconciliation preserves expiry, agent availability, profile projection, rollback, and lock ordering', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  assert.ok(
    Number(process.env.PG_POOL_MAX || 10) >= 2,
    'P3 command reconciliation lock race requires PG_POOL_MAX >= 2',
  );
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

  const expiredProfile = await createProfileCommandFixture(pool, {
    tenantId,
    agentId,
    authCodeId,
    authBindingId,
    label: 'expired',
    expired: true,
  });
  const expiredProfileBefore = await readProfileCommandState(
    pool,
    expiredProfile,
  );
  const rollbackSentinel = new Error('forced profile command rollback');
  await assert.rejects(
    withTransaction(async tx => {
      const settled = await expireStaleCommands(
        tx,
        tenantId,
        expiredProfile.childTaskId,
        agentId,
      );
      assert.equal(settled.length, 1);
      throw rollbackSentinel;
    }),
    error => error === rollbackSentinel,
  );
  assert.deepEqual(
    await readProfileCommandState(pool, expiredProfile),
    expiredProfileBefore,
  );

  assert.deepEqual(await reconcilePendingCaptureCommands(), {
    tenantCount: 1,
    commandCount: 1,
  });
  const expiredProfileSettled = await readProfileCommandState(
    pool,
    expiredProfile,
  );
  assertProfileCommandSettled(expiredProfileSettled, expiredProfile, {
    childStatus: 'failed',
    childMessage: '设备创建指令已过期，任务未执行',
    code: 'create_command_expired',
    commandReason: 'expired',
    commandEvent: 'create_command_expired',
    message: '设备未在指令有效期内领取并创建任务',
  });
  assert.deepEqual(await reconcilePendingCaptureCommands(), {
    tenantCount: 0,
    commandCount: 0,
  });
  assert.deepEqual(
    await readProfileCommandState(pool, expiredProfile),
    expiredProfileSettled,
  );

  const unavailableProfile = await createProfileCommandFixture(pool, {
    tenantId,
    agentId,
    authCodeId,
    authBindingId,
    label: 'agent-unavailable',
    expired: false,
  });
  await pool.query(
    "UPDATE capture_agents SET status = 'paused' WHERE id = $1",
    [agentId],
  );

  assert.deepEqual(await reconcilePendingCaptureCommands(), {
    tenantCount: 1,
    commandCount: 1,
  });
  const unavailableProfileSettled = await readProfileCommandState(
    pool,
    unavailableProfile,
  );
  assertProfileCommandSettled(unavailableProfileSettled, unavailableProfile, {
    childStatus: 'needs_action',
    childMessage: '目标节点授权或平台职责已变化，任务未执行',
    code: 'create_agent_unavailable',
    commandReason: 'agent_inactive',
    commandEvent: 'create_command_canceled_agent_unavailable',
    message: '目标节点授权或平台职责已变化',
  });
  assert.deepEqual(
    await reconcilePendingCaptureCommands(),
    {tenantCount: 0, commandCount: 0},
  );
  assert.deepEqual(
    await readProfileCommandState(pool, unavailableProfile),
    unavailableProfileSettled,
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
