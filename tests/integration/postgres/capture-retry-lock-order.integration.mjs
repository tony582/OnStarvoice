import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createApp} from '../../../server/app.js';
import {withTransaction} from '../../../server/db/init.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {closePool, getPool} from '../../../server/db/pool.js';
import {
  dispatchCrossDeviceRetry,
} from '../../../server/modules/capture/infrastructure/postgres-cross-device-retry.js';
import {createSession} from '../../../server/services/auth-service.js';
import {
  enqueueDueProfilePatrolTasks,
  materializeProfilePatrolTask,
} from '../../../server/services/profile-patrol-dispatch.js';

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
const forcedCloseClients = new WeakSet();

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.code = 'P3_RETRY_LOCK_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function destroyClientStream(client) {
  if (client && !forcedCloseClients.has(client)) {
    client.on('error', () => {});
    forcedCloseClients.add(client);
  }
  if (!client?.connection?.stream?.destroyed) {
    client.connection?.stream?.destroy();
  }
}

async function runBoundedClientStep({client, promise, timeoutMs, message}) {
  try {
    return await withTimeout(promise, timeoutMs, message);
  } catch (error) {
    if (error?.code !== 'P3_RETRY_LOCK_TIMEOUT') throw error;
    destroyClientStream(client);
    try {
      await withTimeout(
        Promise.allSettled([promise]),
        timeoutMs,
        `${message}; operation did not settle after stream destroy`,
      );
    } catch (settlementError) {
      throw new AggregateError(
        [error, settlementError],
        `${message}; forced settlement failed`,
      );
    }
    throw error;
  }
}

async function connectBoundedClient(client, timeoutMs, label) {
  const promise = client.connect();
  try {
    await runBoundedClientStep({
      client,
      promise,
      timeoutMs,
      message: `Timed out connecting ${label}`,
    });
  } catch (error) {
    destroyClientStream(client);
    throw error;
  }
}

async function closeBoundedClient(client, timeoutMs, label) {
  if (!client || client.connection?.stream?.destroyed) return;
  const promise = client.end();
  try {
    await runBoundedClientStep({
      client,
      promise,
      timeoutMs,
      message: `Timed out closing ${label}`,
    });
  } catch (error) {
    destroyClientStream(client);
    throw error;
  }
}

async function closeOwnedPoolClients(
  pool,
  poolApplicationName,
  timeoutMs = 5000,
) {
  const clients = Array.isArray(pool?._clients) ? pool._clients : [];
  const ownedClients = clients.filter(client =>
    client?.connectionParameters?.application_name === poolApplicationName,
  );
  const results = await Promise.allSettled(ownedClients.map(async client => {
    if (client._connecting && !client._connected) {
      destroyClientStream(client);
    } else {
      await runBoundedClientStep({
        client,
        promise: client.end(),
        timeoutMs,
        message: `Timed out hard-closing ${poolApplicationName} pool client`,
      });
    }
    const removalDeadline = Date.now() + timeoutMs;
    while (pool._clients.includes(client)) {
      if (Date.now() >= removalDeadline) {
        throw new Error(
          `Timed out removing ${poolApplicationName} pool client`,
        );
      }
      await delay(20);
    }
  }));
  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Failed to hard-close ${poolApplicationName} pool clients`,
    );
  }
  return ownedClients.length;
}

async function withCleanupClient({
  databaseUrl,
  applicationName,
  operation,
  timeoutMs = 5000,
}) {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: applicationName,
    connectionTimeoutMillis: timeoutMs * 2,
    query_timeout: timeoutMs * 2,
  });
  const errors = [];
  let connected = false;
  let result;
  try {
    await connectBoundedClient(client, timeoutMs, applicationName);
    connected = true;
    result = await runBoundedClientStep({
      client,
      promise: Promise.resolve().then(() => operation(client)),
      timeoutMs,
      message: `Timed out running cleanup through ${applicationName}`,
    });
  } catch (error) {
    errors.push(error);
  }
  if (connected) {
    try {
      await closeBoundedClient(client, timeoutMs, applicationName);
    } catch (error) {
      errors.push(error);
    }
  } else {
    destroyClientStream(client);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${applicationName} cleanup client failed`);
  }
  return result;
}

async function terminateApplicationSessions({
  databaseUrl,
  applicationName,
  controlApplicationName,
}) {
  await withCleanupClient({
    databaseUrl,
    applicationName: controlApplicationName,
    async operation(client) {
      const deadline = Date.now() + 4000;
      let stableZeroSnapshots = 0;
      while (Date.now() < deadline) {
        await client.query(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = $1
            AND pid <> pg_backend_pid()
        `, [applicationName]);
        await client.query('SELECT pg_stat_clear_snapshot()');
        const remaining = await client.query(`
          SELECT count(*)::integer AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = $1
            AND pid <> pg_backend_pid()
        `, [applicationName]);
        if (remaining.rows[0].count === 0) {
          stableZeroSnapshots += 1;
          if (stableZeroSnapshots >= 2) return;
        } else {
          stableZeroSnapshots = 0;
        }
        await delay(20);
      }
      throw new Error(
        `Cleanup could not release ${applicationName} database sessions`,
      );
    },
  });
}

function listenOnTemporaryPort(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function closeServerBounded(server, timeoutMs = 5000) {
  if (!server) return;
  const closePromise = new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  server.closeIdleConnections?.();
  try {
    await withTimeout(closePromise, timeoutMs, 'Timed out closing retry HTTP server');
  } catch (error) {
    server.closeAllConnections?.();
    await withTimeout(
      closePromise,
      2000,
      'Retry HTTP server did not close after forcing connections',
    );
    throw error;
  }
}

async function readJson(response) {
  assert.match(
    response.headers.get('content-type') || '',
    /application\/json/u,
  );
  return response.json();
}

async function waitForDirectLockWaiter({
  observerClient,
  poolApplicationName,
  blockerPid,
  excludedPids = [],
  timeoutMs = 5000,
  label,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observerClient.query('SELECT pg_stat_clear_snapshot()');
    const result = await observerClient.query(`
      SELECT activity.pid, activity.query
      FROM pg_stat_activity activity
      WHERE activity.datname = current_database()
        AND activity.application_name = $1
        AND activity.state = 'active'
        AND activity.wait_event_type = 'Lock'
        AND $2::integer = ANY(pg_blocking_pids(activity.pid))
        AND NOT (activity.pid = ANY($3::integer[]))
      ORDER BY activity.pid
    `, [poolApplicationName, blockerPid, excludedPids]);
    if (result.rows.length === 1) return result.rows[0];
    if (result.rows.length > 1) {
      throw new Error(`${label} found multiple direct lock waiters`);
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function assertWaitingOnAdvisoryFence({
  observerClient,
  waiterPid,
  namespace,
  key,
}) {
  await observerClient.query('SELECT pg_stat_clear_snapshot()');
  const result = await observerClient.query(`
    SELECT
      lock.classid::text::bigint =
        ((hashtext($1)::bigint + 4294967296) % 4294967296)
        AS namespace_matches,
      lock.objid::text::bigint =
        ((hashtext($2)::bigint + 4294967296) % 4294967296)
        AS key_matches,
      lock.objsubid = 2 AS two_key_lock
    FROM pg_locks lock
    WHERE lock.pid = $3
      AND lock.locktype = 'advisory'
      AND lock.granted = false
  `, [namespace, key, waiterPid]);
  assert.deepEqual(result.rows, [{
    key_matches: true,
    namespace_matches: true,
    two_key_lock: true,
  }]);
}

async function assertGrantedAdvisoryFence({
  observerClient,
  holderPid,
  namespace,
  key,
}) {
  await observerClient.query('SELECT pg_stat_clear_snapshot()');
  const result = await observerClient.query(`
    SELECT
      lock.classid::text::bigint =
        ((hashtext($1)::bigint + 4294967296) % 4294967296)
        AS namespace_matches,
      lock.objid::text::bigint =
        ((hashtext($2)::bigint + 4294967296) % 4294967296)
        AS key_matches,
      lock.objsubid = 2 AS two_key_lock
    FROM pg_locks lock
    WHERE lock.pid = $3
      AND lock.locktype = 'advisory'
      AND lock.granted = true
  `, [namespace, key, holderPid]);
  assert.ok(
    result.rows.some(row =>
      row.namespace_matches === true &&
      row.key_matches === true &&
      row.two_key_lock === true),
    `${namespace}/${key} was not held by backend ${holderPid}`,
  );
}

async function createRetryRaceFixture(pool, token) {
  const tenant = await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`P3 retry lock ${token}`],
  );
  const tenantId = tenant.rows[0].id;
  const user = await pool.query(`
    INSERT INTO users (
      email, name, password_hash, status, must_change_password
    ) VALUES ($1, $2, $3, 'active', false)
    RETURNING id
  `, [
    `p3-retry-lock-${token}@integration.invalid`,
    'P3 retry lock operator',
    'p3-retry-lock-integration-only',
  ]);
  const userId = user.rows[0].id;
  await pool.query(`
    INSERT INTO user_memberships (user_id, tenant_id, role, status)
    VALUES ($1, $2, 'tenant_analyst', 'active')
  `, [userId, tenantId]);

  const sourceAgent = await pool.query(`
    INSERT INTO capture_agents (
      tenant_id, client_uuid, display_name, status, last_heartbeat_at
    ) VALUES ($1, $2, $3, 'paused', now())
    RETURNING id
  `, [
    tenantId,
    `p3-retry-lock-source-${token}`,
    `P3 retry source ${token}`,
  ]);
  const sourceAgentId = sourceAgent.rows[0].id;
  const authCode = await pool.query(`
    INSERT INTO auth_codes (tenant_id, code, type, status, max_bindings)
    VALUES ($1, $2, 'permanent', 'active', 1)
    RETURNING id
  `, [tenantId, `P3-RETRY-LOCK-${token}`]);
  const authCodeId = authCode.rows[0].id;
  const binding = await pool.query(`
    INSERT INTO auth_bindings (code_id, fingerprint)
    VALUES ($1, $2)
    RETURNING id
  `, [authCodeId, `p3-retry-lock-${token}`]);
  const authBindingId = binding.rows[0].id;
  const targetAgent = await pool.query(`
    INSERT INTO capture_agents (
      tenant_id, auth_code_id, auth_binding_id, client_uuid,
      display_name, allowed_platforms, capabilities,
      status, last_heartbeat_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, ARRAY['douyin']::text[],
      '{"remoteTaskCreate":true,"supportedPlatforms":["douyin"]}'::jsonb,
      'active', now()
    )
    RETURNING id
  `, [
    tenantId,
    authCodeId,
    authBindingId,
    `p3-retry-lock-target-${token}`,
    `P3 retry target ${token}`,
  ]);
  const targetAgentId = targetAgent.rows[0].id;
  await pool.query(`
    INSERT INTO social_agent_daily_usage (
      tenant_id, agent_id, platform, usage_date,
      searches, failed_events, safety_verifications, last_event_at
    ) VALUES (
      $1, $2, 'douyin',
      (now() AT TIME ZONE 'Asia/Shanghai')::date,
      0, 0, 0, now()
    )
  `, [tenantId, targetAgentId]);

  const keyword = `keyword-${token}`;
  const parent = await pool.query(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, progress, counts,
      metadata, orchestration_revision, finished_at
    ) VALUES (
      $1, $2, 'capture_orchestration', 'unattended_keyword_capture', $3,
      'douyin', 'cloud', 'scheduled', 'completed_with_failures',
      '{"current":0,"total":1,"percent":0}'::jsonb,
      '{"total":1,"retryable":1}'::jsonb,
      $4::jsonb, 1, now()
    )
    RETURNING id
  `, [
    tenantId,
    `p3-retry-lock-parent-${token}`,
    `P3 retry lock parent ${token}`,
    JSON.stringify({
      promotedBusinessTaskType: 'unattended_keyword_capture',
      planSnapshot: {
        enabled: true,
        platform: 'douyin',
        keywords: [keyword],
        recoveryPolicy: {allowIdleAgentHandoff: true},
      },
    }),
  ]);
  const parentTaskId = parent.rows[0].id;
  const sourceTask = await pool.query(`
    INSERT INTO capture_tasks (
      tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
      client_task_id, task_type, feature_key, title, platform,
      source, trigger_type, status, metadata, finished_at
    ) VALUES (
      $1, $2, $3, $3,
      $4, 'unattended_keyword_capture', 'unattended_keyword_capture', $5,
      'douyin', 'extension', 'orchestration_source', 'failed',
      jsonb_build_object(
        'orchestrationChild', true,
        'parentTaskId', $2::uuid::text
      ),
      now()
    )
    RETURNING id
  `, [
    tenantId,
    parentTaskId,
    sourceAgentId,
    `p3-retry-lock-source-task-${token}`,
    `P3 retry source task ${token}`,
  ]);
  const sourceTaskId = sourceTask.rows[0].id;
  const item = await pool.query(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, ordinal, keyword,
      platform, item_type, status, attempt_count,
      assigned_agent_id, execution_task_id, assignment_revision,
      error, metadata, assigned_at, dispatched_at, started_at
    ) VALUES (
      $1, $2, $3, 0, $4,
      'douyin', 'keyword', 'retryable', 1,
      $5, $6, 1,
      '{"code":"TRANSIENT_NETWORK"}'::jsonb,
      '{"checkpoint":{"round":1}}'::jsonb,
      now() - interval '2 minutes',
      now() - interval '2 minutes',
      now() - interval '2 minutes'
    )
    RETURNING id
  `, [
    tenantId,
    parentTaskId,
    `p3-retry-lock-item-${token}`,
    keyword,
    sourceAgentId,
    sourceTaskId,
  ]);
  const itemId = item.rows[0].id;
  await pool.query(`
    INSERT INTO capture_task_item_attempts (
      tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      error, assigned_at, dispatched_at, started_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, 1, 1, 'retryable',
      '{"code":"TRANSIENT_NETWORK"}'::jsonb,
      now() - interval '2 minutes',
      now() - interval '2 minutes',
      now() - interval '2 minutes'
    )
  `, [tenantId, itemId, parentTaskId, sourceTaskId, sourceAgentId]);

  return {
    authBindingId,
    authCodeId,
    itemId,
    keyword,
    parentTaskId,
    sourceAgentId,
    sourceTaskId,
    targetAgentId,
    tenantId,
    userId,
  };
}

async function createProfileRetryRaceFixture(pool, token) {
  const tenant = await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`P3 profile retry lock ${token}`],
  );
  const tenantId = tenant.rows[0].id;
  const capabilities = {
    taskStateKnown: true,
    remoteTaskCreate: true,
    remoteTargetedPostCaptureV1: true,
    followedCreatorPostPatrol: true,
    supportedPlatforms: ['douyin'],
  };
  const createAgent = async (label) => {
    const authCode = await pool.query(`
      INSERT INTO auth_codes (
        tenant_id, code, type, status, max_bindings
      ) VALUES ($1, $2, 'permanent', 'active', 1)
      RETURNING id
    `, [tenantId, `P3-PROFILE-LOCK-${label}-${token}`]);
    const authCodeId = authCode.rows[0].id;
    const binding = await pool.query(`
      INSERT INTO auth_bindings (code_id, fingerprint)
      VALUES ($1, $2)
      RETURNING id
    `, [authCodeId, `p3-profile-lock-${label}-${token}`]);
    const authBindingId = binding.rows[0].id;
    const agent = await pool.query(`
      INSERT INTO capture_agents (
        tenant_id, auth_code_id, auth_binding_id, client_uuid,
        display_name, allowed_platforms, capabilities, status,
        last_heartbeat_at, last_liveness_at, last_full_heartbeat_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, ARRAY['douyin']::text[], $6::jsonb, 'active',
        now(), now(), now()
      )
      RETURNING *
    `, [
      tenantId,
      authCodeId,
      authBindingId,
      `p3-profile-lock-${label}-${token}`,
      `P3 profile ${label} ${token}`,
      JSON.stringify(capabilities),
    ]);
    return agent.rows[0];
  };
  const sourceAgent = await createAgent('source');
  const targetAgent = await createAgent('target');
  const subscription = await pool.query(`
    INSERT INTO monitor_subscriptions (
      tenant_id, name, keyword, platform, account_url,
      cadence_minutes, status, next_run_at, subject_type,
      assigned_agent_id
    ) VALUES (
      $1, $2, $3, 'douyin', $4,
      60, 'active', now() - interval '1 minute', 'creator',
      $5
    )
    RETURNING *
  `, [
    tenantId,
    `P3 profile retry lock ${token}`,
    `profile-retry-${token}`,
    `https://www.douyin.com/user/profile-retry-${token}`,
    targetAgent.id,
  ]);
  const subscriptionRow = subscription.rows[0];
  const sourceTaskId = randomUUID();
  const sourceDispatch = await withTransaction(async tx =>
    materializeProfilePatrolTask(tx, {
      tenantId,
      subjectType: 'creator',
      agent: sourceAgent,
      subscriptions: [subscriptionRow],
      requestKey: sourceTaskId,
      title: `P3 Profile lock source ${token}`,
      monitorSettings: {
        publishWindow: '7d',
        timezone: 'Asia/Shanghai',
      },
      captureSettings: {autoSyncAfterDetailCapture: true},
      triggerType: 'profile_scan_manual',
      requestedByName: 'P3 profile lock fixture',
      actorType: 'system',
    }));
  const item = await pool.query(`
    SELECT id, metadata
    FROM capture_task_items
    WHERE tenant_id = $1 AND task_id = $2
  `, [tenantId, sourceTaskId]);
  assert.equal(item.rows.length, 1);
  const itemId = item.rows[0].id;
  const monitorExecutionId = item.rows[0].metadata.monitorExecutionId;
  assert.match(monitorExecutionId, /^[0-9a-f-]{36}$/u);

  await pool.query(`
    UPDATE capture_tasks
    SET status = 'failed',
      error = '{"code":"TRANSIENT_NETWORK"}'::jsonb,
      started_at = COALESCE(started_at, now() - interval '2 minutes'),
      finished_at = now(), updated_at = now(), source_updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [sourceTaskId, tenantId]);
  await pool.query(`
    UPDATE capture_task_items
    SET status = 'retryable', attempt_count = 1,
      error = '{"code":"TRANSIENT_NETWORK"}'::jsonb,
      started_at = COALESCE(started_at, now() - interval '2 minutes'),
      finished_at = now(), updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [itemId, tenantId]);
  await pool.query(`
    UPDATE capture_task_item_attempts
    SET status = 'retryable',
      error = '{"code":"TRANSIENT_NETWORK"}'::jsonb,
      started_at = COALESCE(started_at, now() - interval '2 minutes'),
      finished_at = now(), updated_at = now()
    WHERE item_id = $1 AND tenant_id = $2
  `, [itemId, tenantId]);
  await pool.query(`
    UPDATE capture_agent_commands
    SET status = 'failed',
      result = '{"error":"TRANSIENT_NETWORK"}'::jsonb,
      finished_at = now(), updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [sourceDispatch.commandId, tenantId]);
  await pool.query(`
    UPDATE monitor_executions
    SET status = 'failed',
      error_message = 'P3 profile retry lock fixture',
      finished_at = now(), updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [monitorExecutionId, tenantId]);
  await pool.query(`
    UPDATE capture_agents
    SET status = 'paused', updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [sourceAgent.id, tenantId]);

  return {
    itemId,
    monitorExecutionId,
    sourceAgentId: sourceAgent.id,
    sourceTaskId,
    subscriptionId: subscriptionRow.id,
    targetAgentId: targetAgent.id,
    tenantId,
  };
}

async function readProfileRetryRaceState(pool, fixture) {
  const result = await pool.query(`
    SELECT
      (SELECT task_type
       FROM capture_tasks
       WHERE id = $1::uuid) AS parent_task_type,
      (SELECT status
       FROM capture_tasks
       WHERE id = $1::uuid) AS parent_status,
      (SELECT orchestration_revision
       FROM capture_tasks
       WHERE id = $1::uuid) AS parent_revision,
      (SELECT count(*)::integer
       FROM capture_tasks
       WHERE parent_task_id = $1::uuid
         AND trigger_type = 'cross_device_retry') AS retry_task_count,
      (SELECT count(*)::integer
       FROM capture_tasks scheduled_task
       JOIN capture_task_items scheduled_item
         ON scheduled_item.task_id = scheduled_task.id
        AND scheduled_item.tenant_id = scheduled_task.tenant_id
       WHERE scheduled_task.tenant_id = $2
         AND scheduled_task.trigger_type = 'profile_scan_schedule'
         AND scheduled_item.external_id = $3::uuid::text
       ) AS scheduled_task_count,
      (SELECT count(*)::integer
       FROM capture_agent_commands command
       JOIN capture_tasks child ON child.id = command.task_id
       WHERE child.parent_task_id = $1::uuid
         AND child.trigger_type = 'cross_device_retry'
         AND command.command_type = 'create') AS retry_command_count,
      (SELECT count(*)::integer
       FROM capture_task_events
       WHERE task_id = $1::uuid
         AND event_type = 'cross_device_retry_dispatched') AS retry_event_count,
      (SELECT count(*)::integer
       FROM capture_task_item_attempts
       WHERE item_id = $4::uuid) AS item_attempt_count,
      (SELECT count(*)::integer
       FROM monitor_executions
       WHERE subscription_id = $3::uuid
         AND status IN ('pending', 'running')) AS active_execution_count,
      (SELECT status
       FROM monitor_executions
       WHERE id = $5::uuid) AS source_execution_status,
      (SELECT metadata->>'monitorExecutionId'
       FROM capture_task_items
       WHERE id = $4::uuid) AS current_execution_id,
      (SELECT assigned_agent_id
       FROM capture_task_items
       WHERE id = $4::uuid) AS current_agent_id,
      (SELECT last_error
       FROM monitor_subscriptions
       WHERE id = $3::uuid) AS subscription_last_error
  `, [
    fixture.sourceTaskId,
    fixture.tenantId,
    fixture.subscriptionId,
    fixture.itemId,
    fixture.monitorExecutionId,
  ]);
  return result.rows[0];
}

async function readRetryRaceState(pool, fixture, losingRequestKey) {
  const [
    parent,
    item,
    children,
    commands,
    attempts,
    parentEvents,
    childEvents,
    loser,
  ] =
    await Promise.all([
      pool.query(`
        SELECT id, status, orchestration_revision, progress, counts, metadata
        FROM capture_tasks
        WHERE id = $1
      `, [fixture.parentTaskId]),
      pool.query(`
        SELECT id, status, attempt_count, assigned_agent_id,
          execution_task_id, assignment_revision, request_hash, error
        FROM capture_task_items
        WHERE id = $1
      `, [fixture.itemId]),
      pool.query(`
        SELECT id, assigned_agent_id, trigger_type, status, metadata,
          orchestration_revision
        FROM capture_tasks
        WHERE parent_task_id = $1
          AND trigger_type IN ('orchestration_retry', 'cross_device_retry')
        ORDER BY created_at, id
      `, [fixture.parentTaskId]),
      pool.query(`
        SELECT command.id, command.agent_id, command.task_id,
          command.command_type, command.status, command.payload
        FROM capture_agent_commands command
        JOIN capture_tasks child ON child.id = command.task_id
        WHERE child.parent_task_id = $1
          AND child.trigger_type IN (
            'orchestration_retry', 'cross_device_retry'
          )
        ORDER BY command.created_at, command.id
      `, [fixture.parentTaskId]),
      pool.query(`
        SELECT id, execution_task_id, agent_id, attempt_number,
          assignment_revision, status, request_hash
        FROM capture_task_item_attempts
        WHERE item_id = $1
        ORDER BY attempt_number, id
      `, [fixture.itemId]),
      pool.query(`
        SELECT event_type, status, payload
        FROM capture_task_events
        WHERE task_id = $1
          AND event_type IN (
            'orchestration_retry_dispatched',
            'cross_device_retry_dispatched'
          )
        ORDER BY id
      `, [fixture.parentTaskId]),
      pool.query(`
        SELECT event.event_type, event.status, event.payload
        FROM capture_task_events event
        JOIN capture_tasks child ON child.id = event.task_id
        WHERE child.parent_task_id = $1
          AND child.trigger_type = 'orchestration_retry'
          AND event.event_type = 'orchestration_retry_child_dispatched'
        ORDER BY event.id
      `, [fixture.parentTaskId]),
      pool.query(`
        SELECT
          (SELECT count(*)::integer
           FROM capture_tasks
           WHERE id = $1::uuid) AS task_count,
          (SELECT count(*)::integer
           FROM capture_agent_commands
           WHERE task_id = $1::uuid) AS command_count,
          (SELECT count(*)::integer
           FROM capture_task_item_attempts
           WHERE execution_task_id = $1::uuid) AS attempt_count,
          (SELECT count(*)::integer
           FROM capture_task_events
           WHERE payload->>'retryTaskId' = $1::text
              OR payload->>'requestKey' = $1::text) AS event_count
      `, [losingRequestKey]),
    ]);
  return {
    attempts: attempts.rows,
    childEvents: childEvents.rows,
    children: children.rows,
    commands: commands.rows,
    parentEvents: parentEvents.rows,
    item: item.rows[0],
    loser: loser.rows[0],
    parent: parent.rows[0],
  };
}

function assertSingleExplicitRetryState(
  state,
  fixture,
  explicitRequestKey,
) {
  assert.equal(state.parent.orchestration_revision, 2);
  assert.equal(state.parent.status, 'pending');
  assert.equal(state.children.length, 1);
  assert.equal(state.children[0].id, explicitRequestKey);
  assert.equal(state.children[0].assigned_agent_id, fixture.targetAgentId);
  assert.equal(state.children[0].trigger_type, 'orchestration_retry');
  assert.equal(state.children[0].status, 'pending');
  assert.equal(state.children[0].orchestration_revision, 0);

  assert.equal(state.commands.length, 1);
  assert.equal(state.commands[0].task_id, explicitRequestKey);
  assert.equal(state.commands[0].agent_id, fixture.targetAgentId);
  assert.equal(state.commands[0].command_type, 'create');
  assert.equal(state.commands[0].status, 'pending');

  assert.equal(state.item.status, 'dispatched');
  assert.equal(state.item.attempt_count, 2);
  assert.equal(state.item.assigned_agent_id, fixture.targetAgentId);
  assert.equal(state.item.execution_task_id, explicitRequestKey);
  assert.equal(state.item.assignment_revision, 2);
  assert.match(state.item.request_hash, /^[0-9a-f]{64}$/u);

  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[0].execution_task_id, fixture.sourceTaskId);
  assert.equal(state.attempts[0].attempt_number, 1);
  assert.equal(state.attempts[0].assignment_revision, 1);
  assert.equal(state.attempts[0].status, 'retryable');
  assert.equal(state.attempts[1].execution_task_id, explicitRequestKey);
  assert.equal(state.attempts[1].agent_id, fixture.targetAgentId);
  assert.equal(state.attempts[1].attempt_number, 2);
  assert.equal(state.attempts[1].assignment_revision, 2);
  assert.equal(state.attempts[1].status, 'dispatched');
  assert.equal(state.attempts[1].request_hash, state.item.request_hash);

  assert.equal(state.childEvents.length, 1);
  assert.equal(
    state.childEvents[0].event_type,
    'orchestration_retry_child_dispatched',
  );
  assert.equal(
    state.childEvents[0].payload.parentTaskId,
    fixture.parentTaskId,
  );
  assert.deepEqual(state.childEvents[0].payload.itemIds, [fixture.itemId]);

  assert.equal(state.parentEvents.length, 1);
  assert.equal(
    state.parentEvents[0].event_type,
    'orchestration_retry_dispatched',
  );
  assert.equal(state.parentEvents[0].payload.requestKey, explicitRequestKey);
  assert.equal(
    state.parentEvents[0].payload.executions[0].taskId,
    explicitRequestKey,
  );
  assert.equal(
    state.parentEvents[0].payload.executions[0].agentId,
    fixture.targetAgentId,
  );
  assert.deepEqual(
    state.parentEvents[0].payload.executions[0].itemIds,
    [fixture.itemId],
  );
  assert.deepEqual(state.parentEvents[0].payload.itemIds, [fixture.itemId]);
  assert.deepEqual(state.loser, {
    attempt_count: 0,
    command_count: 0,
    event_count: 0,
    task_count: 0,
  });
}

function errorCode(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.code === 'string') return value.code;
  if ('reason' in value) return errorCode(value.reason);
  return '';
}

test('real PostgreSQL serializes HTTP retry-items with canonical automatic retry', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const applicationPrefix = `p3-retry-lock-${token}`;
  const poolApplicationName = `${applicationPrefix}-pool`;
  const originalApplicationName = process.env.PGAPPNAME;
  const originalPoolMax = process.env.PG_POOL_MAX;
  process.env.PGAPPNAME = poolApplicationName;
  process.env.PG_POOL_MAX = '2';

  let pool;
  let fixture;
  let server;
  let barrierClient;
  let barrierTransactionOpen = false;
  const trackedOperations = [];
  const serverErrors = [];
  const trackOperation = promise => {
    promise.catch(() => {});
    trackedOperations.push(promise);
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

    if (barrierClient && barrierTransactionOpen) {
      await attemptCleanup(() => runBoundedClientStep({
        client: barrierClient,
        promise: barrierClient.query('ROLLBACK'),
        timeoutMs: 5000,
        message: 'Timed out rolling back retry lock barrier',
      }));
      barrierTransactionOpen = false;
    }
    let operationsSettled = false;
    try {
      await withTimeout(
        Promise.allSettled(trackedOperations),
        10000,
        'Timed out settling retry lock operations',
      );
      operationsSettled = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!operationsSettled) {
      await attemptCleanup(() => terminateApplicationSessions({
        databaseUrl: target.rawUrl,
        applicationName: poolApplicationName,
        controlApplicationName: `${applicationPrefix}-termination-control`,
      }));
      try {
        await withTimeout(
          Promise.allSettled(trackedOperations),
          5000,
          'Retry lock operations did not settle after backend termination',
        );
        operationsSettled = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (!operationsSettled) {
        await attemptCleanup(() => closeOwnedPoolClients(
          pool,
          poolApplicationName,
        ));
        await attemptCleanup(() => withTimeout(
          Promise.allSettled(trackedOperations),
          5000,
          'Retry lock operations did not settle after hard close',
        ));
      }
    }
    if (barrierClient) {
      const clientToClose = barrierClient;
      barrierClient = null;
      await attemptCleanup(() => closeBoundedClient(
        clientToClose,
        5000,
        'retry lock barrier client',
      ));
    }
    if (server) {
      const serverToClose = server;
      server = null;
      await attemptCleanup(() => closeServerBounded(serverToClose));
    }

    if (fixture) {
      await attemptCleanup(() => withCleanupClient({
        databaseUrl: target.rawUrl,
        applicationName: `${applicationPrefix}-fixture-cleanup`,
        timeoutMs: 10000,
        async operation(client) {
          await client.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
          await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
        },
      }));
      fixture = null;
    }
    if (pool) {
      const closePoolPromise = closePool();
      closePoolPromise.catch(() => {});
      let poolClosed = false;
      try {
        await withTimeout(
          closePoolPromise,
          5000,
          'Timed out closing retry lock pool',
        );
        poolClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (!poolClosed) {
        await attemptCleanup(() => terminateApplicationSessions({
          databaseUrl: target.rawUrl,
          applicationName: poolApplicationName,
          controlApplicationName: `${applicationPrefix}-pool-close-control`,
        }));
        try {
          await withTimeout(
            closePoolPromise,
            5000,
            'Timed out closing retry lock pool after termination',
          );
          poolClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (!poolClosed) {
        await attemptCleanup(() => closeOwnedPoolClients(
          pool,
          poolApplicationName,
        ));
        await attemptCleanup(() => withTimeout(
          closePoolPromise,
          5000,
          'Timed out closing retry lock pool after hard close',
        ));
      }
      pool = null;
    }
    restoreEnvironment('PGAPPNAME', originalApplicationName);
    restoreEnvironment('PG_POOL_MAX', originalPoolMax);

    await attemptCleanup(() => withCleanupClient({
      databaseUrl: target.rawUrl,
      applicationName: `${applicationPrefix}-residue-verifier`,
      timeoutMs: 5000,
      async operation(verifier) {
        await verifier.query('SELECT pg_stat_clear_snapshot()');
        const residue = await verifier.query(`
          SELECT
            (SELECT count(*)::integer
             FROM pg_stat_activity activity
             WHERE activity.datname = current_database()
               AND activity.application_name LIKE $1
               AND activity.pid <> pg_backend_pid()) AS session_count,
            (SELECT count(*)::integer
             FROM pg_locks lock
             JOIN pg_stat_activity activity ON activity.pid = lock.pid
             WHERE activity.datname = current_database()
               AND activity.application_name LIKE $1
               AND activity.pid <> pg_backend_pid()
               AND lock.locktype = 'advisory') AS advisory_lock_count
        `, [`${applicationPrefix}%`]);
        assert.deepEqual(residue.rows[0], {
          advisory_lock_count: 0,
          session_count: 0,
        });
      },
    }));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'P3 retry lock cleanup failed');
    }
  });

  pool = getPool();
  await runMigrations();
  fixture = await createRetryRaceFixture(pool, token);
  const session = await createSession(fixture.userId, {
    ip: '127.0.0.1',
    headers: {'user-agent': 'p3-retry-lock-integration'},
  });
  const app = createApp({
    logger: {
      log() {},
      error(...args) {
        serverErrors.push(args);
      },
    },
  });
  server = await listenOnTemporaryPort(app);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  barrierClient = new Client({
    connectionString: target.rawUrl,
    application_name: `${applicationPrefix}-barrier`,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  await connectBoundedClient(barrierClient, 5000, 'retry lock barrier client');
  await runBoundedClientStep({
    client: barrierClient,
    promise: barrierClient.query('BEGIN'),
    timeoutMs: 5000,
    message: 'Timed out beginning retry lock barrier transaction',
  });
  barrierTransactionOpen = true;
  const barrierBackend = await barrierClient.query(
    'SELECT pg_backend_pid()::integer AS pid',
  );
  const barrierPid = barrierBackend.rows[0].pid;
  await runBoundedClientStep({
    client: barrierClient,
    promise: barrierClient.query(
      'SELECT id FROM capture_tasks WHERE id = $1 FOR UPDATE',
      [fixture.sourceTaskId],
    ),
    timeoutMs: 5000,
    message: 'Timed out locking retry source task for the barrier',
  });

  const explicitRequestKey = randomUUID();
  const automaticRequestKey = randomUUID();
  assert.notEqual(explicitRequestKey, automaticRequestKey);
  const explicitBody = {
    confirmSafety: false,
    expectedRevision: 1,
    itemIds: [fixture.itemId],
    requestKey: explicitRequestKey,
    targetAgentId: fixture.targetAgentId,
  };
  const explicitOperation = trackOperation(
    fetch(
      `${baseUrl}/api/capture-cloud/orchestrations/${fixture.parentTaskId}/retry-items`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/json',
          'x-tenant-id': fixture.tenantId,
        },
        body: JSON.stringify(explicitBody),
      },
    ).then(async response => ({
      body: await readJson(response),
      status: response.status,
    })),
  );
  const explicitWaiter = await waitForDirectLockWaiter({
    observerClient: barrierClient,
    poolApplicationName,
    blockerPid: barrierPid,
    label: 'HTTP retry-items source-task waiter',
  });
  assert.match(explicitWaiter.query, /FROM capture_tasks source/u);
  assert.match(explicitWaiter.query, /FOR UPDATE/u);

  const automaticOperation = trackOperation(dispatchCrossDeviceRetry({
    tenantId: fixture.tenantId,
    taskId: fixture.parentTaskId,
    requestKey: automaticRequestKey,
    expectedRevision: 1,
    actorType: 'system',
    requestedByName: '自动调度中心',
    automatic: true,
  }));
  const automaticWaiter = await waitForDirectLockWaiter({
    observerClient: barrierClient,
    poolApplicationName,
    blockerPid: explicitWaiter.pid,
    excludedPids: [explicitWaiter.pid],
    label: 'canonical automatic retry parent-control waiter',
  });
  assert.match(automaticWaiter.query, /pg_advisory_xact_lock/u);
  await assertWaitingOnAdvisoryFence({
    observerClient: barrierClient,
    waiterPid: automaticWaiter.pid,
    namespace: 'capture_orchestration_control',
    key: fixture.parentTaskId,
  });

  await runBoundedClientStep({
    client: barrierClient,
    promise: barrierClient.query('COMMIT'),
    timeoutMs: 5000,
    message: 'Timed out releasing retry source-task barrier',
  });
  barrierTransactionOpen = false;
  const outcomes = await withTimeout(
    Promise.allSettled([explicitOperation, automaticOperation]),
    15000,
    'Timed out settling explicit and automatic retry competition',
  );
  for (const outcome of outcomes) {
    assert.equal(
      outcome.status,
      'fulfilled',
      `retry competition rejected with ${errorCode(outcome) || 'unknown error'}`,
    );
  }
  const explicit = outcomes[0].value;
  const automatic = outcomes[1].value;
  assert.equal(explicit.status, 201);
  assert.equal(explicit.body.ok, true);
  assert.equal(explicit.body.idempotent, false);
  assert.equal(explicit.body.action, 'retry_items');
  assert.equal(explicit.body.revision, 2);
  assert.equal(explicit.body.execution.taskId, explicitRequestKey);
  assert.equal(
    automatic.error,
    'task_not_settled_for_retry',
    'the losing automatic dispatch must preserve the existing source-readiness error precedence',
  );
  assert.equal('currentRevision' in automatic, false);
  assert.equal(
    serverErrors.some(args => args.some(value => errorCode(value) === '40P01')),
    false,
  );
  assert.deepEqual(serverErrors, []);

  const afterRace = await withTimeout(
    trackOperation(readRetryRaceState(pool, fixture, automaticRequestKey)),
    5000,
    'Timed out reading retry state after the lock competition',
  );
  assertSingleExplicitRetryState(afterRace, fixture, explicitRequestKey);

  const replayOperation = trackOperation(
    fetch(
      `${baseUrl}/api/capture-cloud/orchestrations/${fixture.parentTaskId}/retry-items`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/json',
          'x-tenant-id': fixture.tenantId,
        },
        body: JSON.stringify(explicitBody),
      },
    ).then(async response => ({
      body: await readJson(response),
      status: response.status,
    })),
  );
  const replay = await withTimeout(
    replayOperation,
    5000,
    'Timed out replaying the explicit retry request',
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.ok, true);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.execution.taskId, explicitRequestKey);
  const stateAfterReplay = await withTimeout(
    trackOperation(readRetryRaceState(pool, fixture, automaticRequestKey)),
    5000,
    'Timed out reading retry state after idempotent replay',
  );
  assert.deepEqual(
    stateAfterReplay,
    afterRace,
    'retry-items replay must not duplicate child, command, attempt, event, or revision state',
  );

  const advisoryResidue = await withTimeout(
    trackOperation(pool.query(`
      SELECT count(*)::integer AS count
      FROM pg_locks lock
      JOIN pg_stat_activity activity ON activity.pid = lock.pid
      WHERE activity.datname = current_database()
        AND activity.application_name = $1
        AND lock.locktype = 'advisory'
    `, [poolApplicationName])),
    5000,
    'Timed out checking retry advisory-lock residue',
  );
  assert.equal(
    advisoryResidue.rows[0].count,
    0,
    'retry competition left a transaction advisory lock behind',
  );
});

test('real PostgreSQL serializes Profile scheduler with canonical retry', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const applicationPrefix = `p3-profile-lock-${token}`;
  const poolApplicationName = `${applicationPrefix}-pool`;
  const originalApplicationName = process.env.PGAPPNAME;
  const originalPoolMax = process.env.PG_POOL_MAX;
  process.env.PGAPPNAME = poolApplicationName;
  process.env.PG_POOL_MAX = '2';

  let pool;
  let fixture;
  let barrierClient;
  let barrierTransactionOpen = false;
  const trackedOperations = [];
  const trackOperation = promise => {
    promise.catch(() => {});
    trackedOperations.push(promise);
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

    if (barrierClient && barrierTransactionOpen) {
      await attemptCleanup(() => runBoundedClientStep({
        client: barrierClient,
        promise: barrierClient.query('ROLLBACK'),
        timeoutMs: 5000,
        message: 'Timed out rolling back Profile subscription barrier',
      }));
      barrierTransactionOpen = false;
    }
    let operationsSettled = false;
    try {
      await withTimeout(
        Promise.allSettled(trackedOperations),
        10000,
        'Timed out settling Profile lock operations',
      );
      operationsSettled = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!operationsSettled) {
      await attemptCleanup(() => terminateApplicationSessions({
        databaseUrl: target.rawUrl,
        applicationName: poolApplicationName,
        controlApplicationName: `${applicationPrefix}-termination-control`,
      }));
      await attemptCleanup(() => withTimeout(
        Promise.allSettled(trackedOperations),
        5000,
        'Profile lock operations did not settle after backend termination',
      ));
    }
    if (barrierClient) {
      const clientToClose = barrierClient;
      barrierClient = null;
      await attemptCleanup(() => closeBoundedClient(
        clientToClose,
        5000,
        'Profile subscription barrier client',
      ));
    }
    if (fixture) {
      await attemptCleanup(() => withCleanupClient({
        databaseUrl: target.rawUrl,
        applicationName: `${applicationPrefix}-fixture-cleanup`,
        timeoutMs: 10000,
        operation: client => client.query(
          'DELETE FROM tenants WHERE id = $1',
          [fixture.tenantId],
        ),
      }));
      fixture = null;
    }
    if (pool) {
      const closePoolPromise = closePool();
      closePoolPromise.catch(() => {});
      let poolClosed = false;
      try {
        await withTimeout(
          closePoolPromise,
          5000,
          'Timed out closing Profile lock pool',
        );
        poolClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (!poolClosed) {
        await attemptCleanup(() => terminateApplicationSessions({
          databaseUrl: target.rawUrl,
          applicationName: poolApplicationName,
          controlApplicationName: `${applicationPrefix}-pool-close-control`,
        }));
        await attemptCleanup(() => withTimeout(
          closePoolPromise,
          5000,
          'Profile lock pool did not close after backend termination',
        ));
      }
      pool = null;
    }
    restoreEnvironment('PGAPPNAME', originalApplicationName);
    restoreEnvironment('PG_POOL_MAX', originalPoolMax);

    await attemptCleanup(() => withCleanupClient({
      databaseUrl: target.rawUrl,
      applicationName: `${applicationPrefix}-residue-verifier`,
      timeoutMs: 5000,
      async operation(verifier) {
        await verifier.query('SELECT pg_stat_clear_snapshot()');
        const residue = await verifier.query(`
          SELECT
            (SELECT count(*)::integer
             FROM pg_stat_activity activity
             WHERE activity.datname = current_database()
               AND activity.application_name LIKE $1
               AND activity.pid <> pg_backend_pid()) AS session_count,
            (SELECT count(*)::integer
             FROM pg_locks lock
             JOIN pg_stat_activity activity ON activity.pid = lock.pid
             WHERE activity.datname = current_database()
               AND activity.application_name LIKE $1
               AND activity.pid <> pg_backend_pid()
               AND lock.locktype = 'advisory') AS advisory_lock_count
        `, [`${applicationPrefix}%`]);
        assert.deepEqual(residue.rows[0], {
          advisory_lock_count: 0,
          session_count: 0,
        });
      },
    }));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'P3 Profile lock cleanup failed');
    }
  });

  pool = getPool();
  await runMigrations();
  fixture = await createProfileRetryRaceFixture(pool, token);
  barrierClient = new Client({
    connectionString: target.rawUrl,
    application_name: `${applicationPrefix}-barrier`,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  await connectBoundedClient(
    barrierClient,
    5000,
    'Profile subscription barrier client',
  );
  await runBoundedClientStep({
    client: barrierClient,
    promise: barrierClient.query('BEGIN'),
    timeoutMs: 5000,
    message: 'Timed out beginning Profile subscription barrier',
  });
  barrierTransactionOpen = true;
  const barrierBackend = await barrierClient.query(
    'SELECT pg_backend_pid()::integer AS pid',
  );
  const barrierPid = barrierBackend.rows[0].pid;
  await runBoundedClientStep({
    client: barrierClient,
    promise: barrierClient.query(`
      SELECT id
      FROM monitor_subscriptions
      WHERE id = $1
      FOR UPDATE
    `, [fixture.subscriptionId]),
    timeoutMs: 5000,
    message: 'Timed out locking the Profile subscription barrier',
  });

  const retryRequestKey = randomUUID();
  const retryOptions = {
    tenantId: fixture.tenantId,
    taskId: fixture.sourceTaskId,
    requestKey: retryRequestKey,
    expectedRevision: 1,
    actorType: 'system',
    requestedByName: 'P3 Profile lock test',
    automatic: true,
  };
  const retryOperation = trackOperation(
    dispatchCrossDeviceRetry(retryOptions),
  );
  const retryWaiter = await waitForDirectLockWaiter({
    observerClient: barrierClient,
    poolApplicationName,
    blockerPid: barrierPid,
    label: 'Profile retry subscription waiter',
  });
  assert.match(retryWaiter.query, /FROM monitor_subscriptions/u);
  assert.match(retryWaiter.query, /FOR UPDATE/u);
  await assertGrantedAdvisoryFence({
    observerClient: barrierClient,
    holderPid: retryWaiter.pid,
    namespace: 'capture_agent_execution_slot',
    key: `${fixture.tenantId}:${fixture.targetAgentId}`,
  });

  const schedulerOperation = trackOperation(enqueueDueProfilePatrolTasks(1));
  const schedulerWaiter = await waitForDirectLockWaiter({
    observerClient: barrierClient,
    poolApplicationName,
    blockerPid: retryWaiter.pid,
    excludedPids: [retryWaiter.pid],
    label: 'Profile scheduler Agent-slot waiter',
  });
  assert.match(schedulerWaiter.query, /pg_advisory_xact_lock/u);
  await assertWaitingOnAdvisoryFence({
    observerClient: barrierClient,
    waiterPid: schedulerWaiter.pid,
    namespace: 'capture_agent_execution_slot',
    key: `${fixture.tenantId}:${fixture.targetAgentId}`,
  });

  await runBoundedClientStep({
    client: barrierClient,
    promise: barrierClient.query('COMMIT'),
    timeoutMs: 5000,
    message: 'Timed out releasing Profile subscription barrier',
  });
  barrierTransactionOpen = false;
  const outcomes = await withTimeout(
    Promise.allSettled([retryOperation, schedulerOperation]),
    15000,
    'Timed out settling Profile scheduler/retry competition',
  );
  for (const outcome of outcomes) {
    assert.equal(
      outcome.status,
      'fulfilled',
      `Profile competition rejected with ${errorCode(outcome) || 'unknown error'}`,
    );
  }
  const retry = outcomes[0].value;
  const scheduler = outcomes[1].value;
  assert.equal(retry.existing, false);
  assert.equal(retry.child.id, retryRequestKey);
  assert.equal(retry.child.assigned_agent_id, fixture.targetAgentId);
  assert.equal(retry.child.trigger_type, 'cross_device_retry');
  assert.deepEqual(scheduler.map(result => result.kind), ['busy']);

  const afterRace = await withTimeout(
    trackOperation(readProfileRetryRaceState(pool, fixture)),
    5000,
    'Timed out reading Profile retry race state',
  );
  assert.equal(afterRace.parent_task_type, 'capture_orchestration');
  assert.equal(afterRace.parent_status, 'pending');
  assert.equal(afterRace.parent_revision, 2);
  assert.equal(afterRace.retry_task_count, 1);
  assert.equal(afterRace.scheduled_task_count, 0);
  assert.equal(afterRace.retry_command_count, 1);
  assert.equal(afterRace.retry_event_count, 1);
  assert.equal(afterRace.item_attempt_count, 2);
  assert.equal(afterRace.active_execution_count, 1);
  assert.equal(afterRace.source_execution_status, 'failed');
  assert.notEqual(
    afterRace.current_execution_id,
    fixture.monitorExecutionId,
  );
  assert.equal(afterRace.current_agent_id, fixture.targetAgentId);
  assert.equal(afterRace.subscription_last_error, '');

  const replay = await withTimeout(
    trackOperation(dispatchCrossDeviceRetry(retryOptions)),
    5000,
    'Timed out replaying the Profile retry winner',
  );
  assert.equal(replay.existing, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.child.id, retryRequestKey);
  const afterReplay = await withTimeout(
    trackOperation(readProfileRetryRaceState(pool, fixture)),
    5000,
    'Timed out reading Profile retry replay state',
  );
  assert.deepEqual(
    afterReplay,
    afterRace,
    'Profile retry replay duplicated lineage or scheduler residue',
  );

  const advisoryResidue = await withTimeout(
    trackOperation(pool.query(`
      SELECT count(*)::integer AS count
      FROM pg_locks lock
      JOIN pg_stat_activity activity ON activity.pid = lock.pid
      WHERE activity.datname = current_database()
        AND activity.application_name = $1
        AND lock.locktype = 'advisory'
    `, [poolApplicationName])),
    5000,
    'Timed out checking Profile advisory-lock residue',
  );
  assert.equal(advisoryResidue.rows[0].count, 0);
});
