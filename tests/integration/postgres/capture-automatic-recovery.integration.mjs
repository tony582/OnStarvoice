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
  reconcileAutomaticCaptureRetries,
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
const forcedCloseClients = new WeakSet();

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function quoteProbeIdentifier(value) {
  assert.match(value, /^p3_automatic_[a-z0-9_]+$/u);
  return `"${value}"`;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.code = 'P3_AUTOMATIC_TIMEOUT';
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

async function runBoundedClientStep({
  client,
  promise,
  timeoutMs,
  message,
}) {
  try {
    return await withTimeout(promise, timeoutMs, message);
  } catch (error) {
    if (error?.code !== 'P3_AUTOMATIC_TIMEOUT') throw error;
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
  const connectPromise = client.connect();
  try {
    await runBoundedClientStep({
      client,
      promise: connectPromise,
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
  const endPromise = client.end();
  try {
    await runBoundedClientStep({
      client,
      promise: endPromise,
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
      const endPromise = client.end();
      await runBoundedClientStep({
        client,
        promise: endPromise,
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
  let result;
  let connected = false;
  try {
    await connectBoundedClient(client, timeoutMs, applicationName);
    connected = true;
    const operationPromise = Promise.resolve().then(() => operation(client));
    result = await runBoundedClientStep({
      client,
      promise: operationPromise,
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

async function terminateOwnedPoolSessions({
  databaseUrl,
  poolApplicationName,
  controlApplicationName,
}) {
  await withCleanupClient({
    databaseUrl,
    applicationName: controlApplicationName,
    timeoutMs: 5000,
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
        `, [poolApplicationName]);
        await client.query('SELECT pg_stat_clear_snapshot()');
        const remaining = await client.query(`
          SELECT count(*)::integer AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = $1
            AND pid <> pg_backend_pid()
        `, [poolApplicationName]);
        if (remaining.rows[0].count === 0) {
          stableZeroSnapshots += 1;
          if (stableZeroSnapshots >= 2) return;
        } else {
          stableZeroSnapshots = 0;
        }
        await delay(20);
      }
      throw new Error(
        'P3 automatic recovery cleanup could not release its pool sessions',
      );
    },
  });
}

async function waitForRootLockWaiters(
  observerClient,
  applicationPrefix,
  expectedCount = 2,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observerClient.query('SELECT pg_stat_clear_snapshot()');
    const result = await observerClient.query(`
      SELECT count(*)::integer AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name LIKE $1
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query LIKE '%SELECT *%'
        AND query LIKE '%FROM capture_tasks%'
        AND query LIKE '%FOR UPDATE%'
    `, [`${applicationPrefix}%`]);
    if (result.rows[0].count >= expectedCount) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for both automatic recovery root locks');
}

async function createSourceAgent(pool, tenantId, suffix) {
  const result = await pool.query(`
    INSERT INTO capture_agents (
      tenant_id, client_uuid, display_name, status, last_heartbeat_at
    ) VALUES ($1, $2, $3, 'paused', now())
    RETURNING id
  `, [
    tenantId,
    `p3-automatic-source-${suffix}`,
    `P3 automatic source ${suffix}`,
  ]);
  return result.rows[0].id;
}

async function createTargetAgent(pool, tenantId, suffix) {
  const authCode = await pool.query(`
    INSERT INTO auth_codes (tenant_id, code, type, status, max_bindings)
    VALUES ($1, $2, 'permanent', 'active', 1)
    RETURNING id
  `, [tenantId, `P3-AUTOMATIC-${suffix}`]);
  const authCodeId = authCode.rows[0].id;
  const binding = await pool.query(`
    INSERT INTO auth_bindings (code_id, fingerprint)
    VALUES ($1, $2)
    RETURNING id
  `, [authCodeId, `p3-automatic-${suffix}`]);
  const authBindingId = binding.rows[0].id;
  const agent = await pool.query(`
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
    `p3-automatic-target-${suffix}`,
    `P3 automatic target ${suffix}`,
  ]);
  return {
    agentId: agent.rows[0].id,
    authBindingId,
    authCodeId,
  };
}

async function createRecoveryFixture(pool, {
  tenantId,
  sourceAgentId,
  label,
  rootStatus = 'completed_with_failures',
  itemStatus = 'retryable',
  itemError = {code: 'TRANSIENT_NETWORK'},
  metadata = {},
} = {}) {
  const suffix = randomUUID();
  const keyword = `keyword-${label}-${suffix}`;
  const metadataPlan = metadata.planSnapshot || {};
  const rootMetadata = {
    promotedBusinessTaskType: 'unattended_keyword_capture',
    ...metadata,
    planSnapshot: {
      enabled: true,
      platform: 'douyin',
      keywords: [keyword],
      ...metadataPlan,
      recoveryPolicy: {
        allowIdleAgentHandoff: true,
        ...(metadataPlan.recoveryPolicy || {}),
      },
    },
  };
  const root = await pool.query(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key, title,
      platform, source, trigger_type, status, progress, counts,
      metadata, orchestration_revision, finished_at
    ) VALUES (
      $1, $2, 'capture_orchestration', 'unattended_keyword_capture', $3,
      'douyin', 'cloud', 'scheduled', $4,
      '{"current":0,"total":1,"percent":0}'::jsonb,
      '{"total":1,"retryable":1}'::jsonb,
      $5::jsonb, 0,
      CASE WHEN $4 IN ('needs_action', 'failed', 'completed_with_failures')
        THEN now()
        ELSE NULL
      END
    )
    RETURNING id
  `, [
    tenantId,
    `p3-automatic-root-${suffix}`,
    `P3 automatic ${label}`,
    rootStatus,
    JSON.stringify(rootMetadata),
  ]);
  const parentTaskId = root.rows[0].id;
  const source = await pool.query(`
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
    `p3-automatic-source-task-${suffix}`,
    `P3 automatic source ${label}`,
  ]);
  const sourceTaskId = source.rows[0].id;
  const item = await pool.query(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, ordinal, keyword,
      platform, item_type, status, attempt_count,
      assigned_agent_id, execution_task_id, assignment_revision,
      error, metadata, assigned_at, dispatched_at, started_at
    ) VALUES (
      $1, $2, $3, 0, $4,
      'douyin', 'keyword', $5, 1,
      $6, $7, 0,
      $8::jsonb, '{"checkpoint":{"round":1}}'::jsonb,
      now() - interval '2 minutes',
      now() - interval '2 minutes',
      now() - interval '2 minutes'
    )
    RETURNING id
  `, [
    tenantId,
    parentTaskId,
    `p3-automatic-item-${suffix}`,
    keyword,
    itemStatus,
    sourceAgentId,
    sourceTaskId,
    JSON.stringify(itemError),
  ]);
  const itemId = item.rows[0].id;
  const attempt = await pool.query(`
    INSERT INTO capture_task_item_attempts (
      tenant_id, item_id, parent_task_id, execution_task_id,
      agent_id, attempt_number, assignment_revision, status,
      error, assigned_at, dispatched_at, started_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, 1, 0, $6,
      $7::jsonb,
      now() - interval '2 minutes',
      now() - interval '2 minutes',
      now() - interval '2 minutes'
    )
    RETURNING id
  `, [
    tenantId,
    itemId,
    parentTaskId,
    sourceTaskId,
    sourceAgentId,
    itemStatus,
    JSON.stringify(itemError),
  ]);
  return {
    attemptId: attempt.rows[0].id,
    itemId,
    keyword,
    parentTaskId,
    sourceAgentId,
    sourceTaskId,
  };
}

async function dismissFixture(pool, fixture) {
  await pool.query(`
    UPDATE capture_tasks
    SET attention_dismissed_at = now(), updated_at = now()
    WHERE id = $1
  `, [fixture.parentTaskId]);
}

async function pauseTargetAgent(pool, target) {
  await pool.query(`
    UPDATE capture_agents
    SET status = 'paused', updated_at = now()
    WHERE id = $1
  `, [target.agentId]);
}

async function readRecoveryState(pool, fixture) {
  const [parent, item, attempts, children, commands, events] = await Promise.all([
    pool.query(`
      SELECT status, progress, counts, metadata, message,
        orchestration_revision, finished_at::text AS finished_at
      FROM capture_tasks
      WHERE id = $1
    `, [fixture.parentTaskId]),
    pool.query(`
      SELECT status, attempt_count, assigned_agent_id, execution_task_id,
        assignment_revision, request_hash, error, metadata,
        started_at::text AS started_at, finished_at::text AS finished_at
      FROM capture_task_items
      WHERE id = $1
    `, [fixture.itemId]),
    pool.query(`
      SELECT id, execution_task_id, agent_id, attempt_number,
        assignment_revision, status, request_hash, error
      FROM capture_task_item_attempts
      WHERE item_id = $1
      ORDER BY attempt_number, id
    `, [fixture.itemId]),
    pool.query(`
      SELECT id, parent_task_id, assigned_agent_id, task_type, feature_key,
        trigger_type, status, metadata, orchestration_revision
      FROM capture_tasks
      WHERE parent_task_id = $1 AND trigger_type = 'cross_device_retry'
      ORDER BY created_at, id
    `, [fixture.parentTaskId]),
    pool.query(`
      SELECT command.id, command.agent_id, command.task_id,
        command.command_type, command.status, command.payload,
        command.requested_by_name
      FROM capture_agent_commands command
      JOIN capture_tasks child ON child.id = command.task_id
      WHERE child.parent_task_id = $1
        AND child.trigger_type = 'cross_device_retry'
      ORDER BY command.created_at, command.id
    `, [fixture.parentTaskId]),
    pool.query(`
      SELECT event_type, actor_type, actor_name, status, payload
      FROM capture_task_events
      WHERE task_id = $1 AND event_type = 'cross_device_retry_dispatched'
      ORDER BY id
    `, [fixture.parentTaskId]),
  ]);
  return {
    attempts: attempts.rows,
    children: children.rows,
    commands: commands.rows,
    events: events.rows,
    item: item.rows[0],
    parent: parent.rows[0],
  };
}

function assertSingleDispatch(state, fixture, target, retryTaskId) {
  assert.equal(state.parent.status, 'pending');
  assert.equal(state.parent.orchestration_revision, 1);
  assert.equal(state.parent.finished_at, null);
  assert.equal(state.parent.progress.current, 0);
  assert.equal(state.parent.progress.total, 1);
  assert.equal(state.parent.counts.dispatched, 1);
  assert.equal(state.parent.metadata.automaticRecoveryCount, 1);
  assert.equal(state.parent.metadata.lastAutomaticRecoveryTaskId, retryTaskId);
  assert.equal(state.parent.metadata.lastCrossDeviceRetryTaskId, retryTaskId);
  assert.equal(state.parent.metadata.lastCrossDeviceRetryAgentId, target.agentId);

  assert.equal(state.children.length, 1);
  const child = state.children[0];
  assert.equal(child.id, retryTaskId);
  assert.equal(child.parent_task_id, fixture.parentTaskId);
  assert.equal(child.assigned_agent_id, target.agentId);
  assert.equal(child.task_type, 'unattended_keyword_capture');
  assert.equal(child.feature_key, 'unattended_keyword_capture');
  assert.equal(child.trigger_type, 'cross_device_retry');
  assert.equal(child.status, 'pending');
  assert.equal(child.orchestration_revision, 1);
  assert.equal(child.metadata.automaticRecovery, true);
  assert.equal(child.metadata.crossDeviceRetryRequestKey, retryTaskId);
  assert.deepEqual(child.metadata.itemIds, [fixture.itemId]);
  assert.deepEqual(
    child.metadata.crossDeviceRetrySourceExecutionTaskIds,
    [fixture.sourceTaskId],
  );

  assert.equal(state.commands.length, 1);
  const command = state.commands[0];
  assert.equal(command.task_id, retryTaskId);
  assert.equal(command.agent_id, target.agentId);
  assert.equal(command.command_type, 'create');
  assert.equal(command.status, 'pending');
  assert.equal(command.requested_by_name, '自动调度中心');
  assert.equal(command.payload.authCodeId, target.authCodeId);
  assert.equal(command.payload.authBindingId, target.authBindingId);
  assert.equal(command.payload.orchestration.parentTaskId, fixture.parentTaskId);
  assert.equal(command.payload.orchestration.revision, 1);
  assert.deepEqual(command.payload.orchestration.itemIds, [fixture.itemId]);
  assert.deepEqual(
    command.payload.orchestration.sourceExecutionTaskIds,
    [fixture.sourceTaskId],
  );
  assert.deepEqual(command.payload.planSnapshot.keywords, [fixture.keyword]);

  assert.equal(state.item.status, 'dispatched');
  assert.equal(state.item.attempt_count, 2);
  assert.equal(state.item.assigned_agent_id, target.agentId);
  assert.equal(state.item.execution_task_id, retryTaskId);
  assert.equal(state.item.assignment_revision, 1);
  assert.match(state.item.request_hash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(state.item.error, {});
  assert.equal(
    state.item.metadata.crossDeviceRetrySourceExecutionTaskId,
    fixture.sourceTaskId,
  );
  assert.equal(state.item.metadata.crossDeviceRetryRequestKey, retryTaskId);
  assert.equal(state.item.started_at, null);
  assert.equal(state.item.finished_at, null);

  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[0].id, fixture.attemptId);
  assert.equal(state.attempts[0].execution_task_id, fixture.sourceTaskId);
  assert.equal(state.attempts[0].agent_id, fixture.sourceAgentId);
  assert.equal(state.attempts[0].attempt_number, 1);
  assert.equal(state.attempts[0].assignment_revision, 0);
  assert.equal(state.attempts[0].status, 'retryable');
  assert.equal(state.attempts[1].execution_task_id, retryTaskId);
  assert.equal(state.attempts[1].agent_id, target.agentId);
  assert.equal(state.attempts[1].attempt_number, 2);
  assert.equal(state.attempts[1].assignment_revision, 1);
  assert.equal(state.attempts[1].status, 'dispatched');
  assert.equal(state.attempts[1].request_hash, state.item.request_hash);

  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].event_type, 'cross_device_retry_dispatched');
  assert.equal(state.events[0].actor_type, 'system');
  assert.equal(state.events[0].actor_name, '自动调度中心');
  assert.equal(state.events[0].status, 'pending');
  assert.equal(state.events[0].payload.retryTaskId, retryTaskId);
  assert.equal(state.events[0].payload.targetAgentId, target.agentId);
  assert.equal(state.events[0].payload.automatic, true);
  assert.equal(state.events[0].payload.revision, 1);
  assert.deepEqual(state.events[0].payload.itemIds, [fixture.itemId]);
  assert.deepEqual(
    state.events[0].payload.sourceExecutionTaskIds,
    [fixture.sourceTaskId],
  );
}

function assertFirstAutomaticDispatchSummary(summary, fixture) {
  assert.equal(summary.scanned, 1);
  assert.equal(summary.dispatched, 1);
  assert.equal(summary.waitingForAgent, 0);
  assert.equal(summary.manualOnly, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.results.length, 2);
  assert.deepEqual(summary.results[0], {
    taskId: fixture.parentTaskId,
    action: 'dispatched',
    retryTaskId: summary.results[0].retryTaskId,
    itemCount: 1,
  });
  assert.match(
    summary.results[0].retryTaskId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
  assert.deepEqual(summary.results[1], {
    taskId: fixture.parentTaskId,
    action: 'retry_items_not_automatically_recoverable',
  });
  return summary.results[0].retryTaskId;
}

test('real PostgreSQL automatic recovery preserves gates, state, CAS, and rollback', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const applicationPrefix = `p3-automatic-${token}`;
  const poolApplicationName = `${applicationPrefix}-pool`;
  const originalApplicationName = process.env.PGAPPNAME;
  const originalPoolMax = process.env.PG_POOL_MAX;
  process.env.PGAPPNAME = poolApplicationName;
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
      await attemptCleanup(() => runBoundedClientStep({
        client: blockerClient,
        promise: blockerClient.query('ROLLBACK'),
        timeoutMs: 5000,
        message: 'Timed out rolling back the automatic recovery blocker',
      }));
      blockerTransactionOpen = false;
    }
    if (blockerClient) {
      const clientToClose = blockerClient;
      blockerClient = null;
      await attemptCleanup(() => closeBoundedClient(
        clientToClose,
        5000,
        'the automatic recovery blocker client',
      ));
    }
    const closePoolPromise = pool ? closePool() : Promise.resolve();
    closePoolPromise.catch(() => {});
    let reconciliationsSettled = false;
    try {
      await withTimeout(
        Promise.allSettled(reconciliationPromises),
        10000,
        'Timed out settling automatic recovery promises',
      );
      reconciliationsSettled = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!reconciliationsSettled) {
      await attemptCleanup(() => terminateOwnedPoolSessions({
        databaseUrl: target.rawUrl,
        poolApplicationName,
        controlApplicationName: `${applicationPrefix}-settlement-control`,
      }));
      let settledAfterTermination = false;
      try {
        await withTimeout(
          Promise.allSettled(reconciliationPromises),
          5000,
          'Timed out settling automatic recovery promises after termination',
        );
        settledAfterTermination = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (!settledAfterTermination) {
        await attemptCleanup(() => closeOwnedPoolClients(
          pool,
          poolApplicationName,
        ));
        await attemptCleanup(() => withTimeout(
          Promise.allSettled(reconciliationPromises),
          5000,
          'Timed out settling automatic recovery promises after hard close',
        ));
      }
    }

    await attemptCleanup(() => withCleanupClient({
      databaseUrl: target.rawUrl,
      applicationName: `${applicationPrefix}-resource-cleanup`,
      timeoutMs: 10000,
      async operation(client) {
        if (rollbackProbe) {
          await client.query(
            `DROP TRIGGER IF EXISTS ${quoteProbeIdentifier(rollbackProbe.trigger)} ON capture_task_events`,
          );
          await client.query(
            `DROP FUNCTION IF EXISTS ${quoteProbeIdentifier(rollbackProbe.function)}()`,
          );
        }
        if (tenantId) {
          await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
        }
      },
    }));
    rollbackProbe = null;

    if (pool) {
      let poolClosed = false;
      try {
        await withTimeout(
          closePoolPromise,
          5000,
          'Timed out closing the automatic recovery pool',
        );
        poolClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (!poolClosed) {
        await attemptCleanup(() => terminateOwnedPoolSessions({
          databaseUrl: target.rawUrl,
          poolApplicationName,
          controlApplicationName: `${applicationPrefix}-pool-close-control`,
        }));
        try {
          await withTimeout(
            closePoolPromise,
            5000,
            'Timed out closing the automatic recovery pool after termination',
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
          'Timed out closing the automatic recovery pool after hard close',
        ));
      }
    }
    restoreEnvironment('PGAPPNAME', originalApplicationName);
    restoreEnvironment('PG_POOL_MAX', originalPoolMax);

    await attemptCleanup(() => withCleanupClient({
      databaseUrl: target.rawUrl,
      applicationName: `${applicationPrefix}-verifier`,
      timeoutMs: 5000,
      async operation(verifier) {
        const active = await verifier.query(`
          SELECT count(*)::integer AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name LIKE $1
            AND pid <> pg_backend_pid()
        `, [`${applicationPrefix}%`]);
        assert.equal(
          active.rows[0].count,
          0,
          'P3 automatic recovery test left a PostgreSQL session open',
        );
      },
    }));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'P3 automatic recovery cleanup failed',
      );
    }
  });

  pool = getPool();
  await runMigrations();
  const preexistingCandidates = await pool.query(`
    SELECT count(*)::integer AS count
    FROM capture_tasks
    WHERE parent_task_id IS NULL
      AND attention_dismissed_at IS NULL
      AND updated_at > now() - interval '24 hours'
      AND (
        status IN ('needs_action', 'failed', 'completed_with_failures')
        OR (
          status IN ('pending', 'running')
          AND COALESCE(metadata->>'lastAutomaticRecoveryTaskId', '') <> ''
        )
      )
      AND COALESCE(metadata->>'orchestrationTemplate', 'false') <> 'true'
      AND COALESCE(metadata->>'distributionMode', '') <> 'elastic_pool'
      AND COALESCE(metadata->>'automaticRetryDisabled', 'false') <> 'true'
      AND COALESCE(
        metadata #>> '{planSnapshot,recoveryPolicy,allowIdleAgentHandoff}',
        'true'
      ) <> 'false'
      AND (
        task_type IN (
          'unattended_keyword_capture', 'negative_post_patrol',
          'watched_content_patrol', 'official_account_comment_patrol',
          'followed_creator_post_patrol', 'official_account_post_discovery'
        )
        OR (
          task_type = 'capture_orchestration'
          AND COALESCE(
            NULLIF(metadata->>'promotedBusinessTaskType', ''),
            NULLIF(metadata->>'workflow', ''),
            CASE
              WHEN feature_key IN (
                'unattended_keyword_capture', 'negative_post_patrol',
                'watched_content_patrol', 'official_account_comment_patrol',
                'followed_creator_post_patrol',
                'official_account_post_discovery'
              ) THEN feature_key
              ELSE NULL
            END,
            'unattended_keyword_capture'
          ) IN (
            'unattended_keyword_capture', 'negative_post_patrol',
            'watched_content_patrol', 'official_account_comment_patrol',
            'followed_creator_post_patrol', 'official_account_post_discovery'
          )
        )
      )
  `);
  assert.equal(
    preexistingCandidates.rows[0].count,
    0,
    'P3 automatic recovery characterization requires a dedicated database without eligible roots',
  );

  const tenant = await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`P3 automatic recovery ${token}`],
  );
  tenantId = tenant.rows[0].id;
  const sourceAgentId = await createSourceAgent(pool, tenantId, token);

  const disabled = await createRecoveryFixture(pool, {
    tenantId,
    sourceAgentId,
    label: 'disabled',
    metadata: {automaticRetryDisabled: true},
  });
  assert.deepEqual(await reconcileAutomaticCaptureRetries(10), {
    scanned: 0,
    dispatched: 0,
    waitingForAgent: 0,
    manualOnly: 0,
    skipped: 0,
    failed: 0,
    results: [],
  });
  assert.equal((await readRecoveryState(pool, disabled)).children.length, 0);
  await dismissFixture(pool, disabled);

  const manual = await createRecoveryFixture(pool, {
    tenantId,
    sourceAgentId,
    label: 'manual',
    rootStatus: 'needs_action',
    itemStatus: 'needs_action',
    itemError: {
      code: 'DOUYIN_CAPTCHA_REQUIRED',
      category: 'platform_safety_block',
      requiresManualAction: true,
    },
  });
  assert.deepEqual(await reconcileAutomaticCaptureRetries(1), {
    scanned: 1,
    dispatched: 0,
    waitingForAgent: 0,
    manualOnly: 0,
    skipped: 1,
    failed: 0,
    results: [{
      taskId: manual.parentTaskId,
      action: 'retry_requires_manual_safety_action',
    }],
  });
  assert.equal((await readRecoveryState(pool, manual)).children.length, 0);
  await dismissFixture(pool, manual);

  const noAgent = await createRecoveryFixture(pool, {
    tenantId,
    sourceAgentId,
    label: 'no-agent',
  });
  assert.deepEqual(await reconcileAutomaticCaptureRetries(1), {
    scanned: 1,
    dispatched: 0,
    waitingForAgent: 1,
    manualOnly: 0,
    skipped: 0,
    failed: 0,
    results: [{
      taskId: noAgent.parentTaskId,
      action: 'idle_compatible_agent_unavailable',
    }],
  });
  assert.equal((await readRecoveryState(pool, noAgent)).children.length, 0);
  await dismissFixture(pool, noAgent);

  const eligibleTarget = await createTargetAgent(
    pool,
    tenantId,
    `${token}-eligible`,
  );
  const eligible = await createRecoveryFixture(pool, {
    tenantId,
    sourceAgentId,
    label: 'eligible',
  });
  const eligibleSummary = await reconcileAutomaticCaptureRetries(1);
  const eligibleRetryTaskId = assertFirstAutomaticDispatchSummary(
    eligibleSummary,
    eligible,
  );
  const eligibleAfterFirstRun = await readRecoveryState(pool, eligible);
  assertSingleDispatch(
    eligibleAfterFirstRun,
    eligible,
    eligibleTarget,
    eligibleRetryTaskId,
  );
  assert.deepEqual(await reconcileAutomaticCaptureRetries(1), {
    scanned: 1,
    dispatched: 0,
    waitingForAgent: 0,
    manualOnly: 0,
    skipped: 1,
    failed: 0,
    results: [{
      taskId: eligible.parentTaskId,
      action: 'retry_items_not_automatically_recoverable',
    }],
  });
  assert.deepEqual(
    await readRecoveryState(pool, eligible),
    eligibleAfterFirstRun,
  );
  await dismissFixture(pool, eligible);
  await pauseTargetAgent(pool, eligibleTarget);

  const concurrentTarget = await createTargetAgent(
    pool,
    tenantId,
    `${token}-concurrent`,
  );
  const concurrent = await createRecoveryFixture(pool, {
    tenantId,
    sourceAgentId,
    label: 'concurrent',
  });
  blockerClient = new Client({
    connectionString: target.rawUrl,
    application_name: `${applicationPrefix}-blocker`,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  await connectBoundedClient(
    blockerClient,
    5000,
    'the automatic recovery blocker client',
  );
  await runBoundedClientStep({
    client: blockerClient,
    promise: blockerClient.query('BEGIN'),
    timeoutMs: 5000,
    message: 'Timed out starting the automatic recovery blocker transaction',
  });
  blockerTransactionOpen = true;
  await runBoundedClientStep({
    client: blockerClient,
    promise: blockerClient.query(
      'SELECT id FROM capture_tasks WHERE id = $1 FOR UPDATE',
      [concurrent.parentTaskId],
    ),
    timeoutMs: 5000,
    message: 'Timed out acquiring the automatic recovery blocker lock',
  });
  const firstConcurrent = trackReconciliation(
    reconcileAutomaticCaptureRetries(1),
  );
  const secondConcurrent = trackReconciliation(
    reconcileAutomaticCaptureRetries(1),
  );
  await waitForRootLockWaiters(blockerClient, applicationPrefix);
  await runBoundedClientStep({
    client: blockerClient,
    promise: blockerClient.query('COMMIT'),
    timeoutMs: 5000,
    message: 'Timed out committing the automatic recovery blocker',
  });
  blockerTransactionOpen = false;
  const concurrentSummaries = await withTimeout(
    Promise.all([firstConcurrent, secondConcurrent]),
    10000,
    'Timed out settling concurrent automatic recovery runs',
  );
  await closeBoundedClient(
    blockerClient,
    5000,
    'the automatic recovery blocker client',
  );
  blockerClient = null;

  assert.deepEqual(
    concurrentSummaries.map(summary => summary.scanned),
    [1, 1],
  );
  assert.equal(
    concurrentSummaries.reduce((sum, summary) => sum + summary.dispatched, 0),
    1,
  );
  assert.equal(
    concurrentSummaries.reduce((sum, summary) => sum + summary.skipped, 0),
    2,
  );
  assert.equal(
    concurrentSummaries.reduce((sum, summary) => sum + summary.failed, 0),
    0,
  );
  const concurrentActions = concurrentSummaries
    .flatMap(summary => summary.results.map(result => result.action))
    .sort();
  assert.deepEqual(concurrentActions, [
    'dispatched',
    'retry_items_not_automatically_recoverable',
    'revision_conflict',
  ].sort());
  const concurrentRetryTaskId = concurrentSummaries
    .flatMap(summary => summary.results)
    .find(result => result.action === 'dispatched')
    .retryTaskId;
  assertSingleDispatch(
    await readRecoveryState(pool, concurrent),
    concurrent,
    concurrentTarget,
    concurrentRetryTaskId,
  );
  await dismissFixture(pool, concurrent);
  await pauseTargetAgent(pool, concurrentTarget);

  const rollbackTarget = await createTargetAgent(
    pool,
    tenantId,
    `${token}-rollback`,
  );
  const rollback = await createRecoveryFixture(pool, {
    tenantId,
    sourceAgentId,
    label: 'rollback',
  });
  const rollbackBefore = await readRecoveryState(pool, rollback);
  const probeToken = randomUUID().replaceAll('-', '').slice(0, 12);
  rollbackProbe = {
    function: `p3_automatic_${probeToken}_fn`,
    trigger: `p3_automatic_${probeToken}_trg`,
  };
  assert.match(
    rollback.parentTaskId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
  await pool.query(`
    CREATE FUNCTION ${quoteProbeIdentifier(rollbackProbe.function)}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $probe$
    BEGIN
      RAISE EXCEPTION 'P3_AUTOMATIC_ROLLBACK_PROBE';
    END;
    $probe$
  `);
  await pool.query(`
    CREATE TRIGGER ${quoteProbeIdentifier(rollbackProbe.trigger)}
    BEFORE INSERT ON capture_task_events
    FOR EACH ROW
    WHEN (
      NEW.event_type = 'cross_device_retry_dispatched'
      AND NEW.task_id = '${rollback.parentTaskId}'::uuid
    )
    EXECUTE FUNCTION ${quoteProbeIdentifier(rollbackProbe.function)}()
  `);

  const rollbackSummary = await reconcileAutomaticCaptureRetries(1);
  assert.equal(rollbackSummary.scanned, 1);
  assert.equal(rollbackSummary.dispatched, 0);
  assert.equal(rollbackSummary.skipped, 0);
  assert.equal(rollbackSummary.failed, 1);
  assert.equal(rollbackSummary.results.length, 1);
  assert.equal(rollbackSummary.results[0].taskId, rollback.parentTaskId);
  assert.equal(rollbackSummary.results[0].action, 'worker_error');
  assert.match(
    rollbackSummary.results[0].message,
    /P3_AUTOMATIC_ROLLBACK_PROBE/u,
  );
  assert.deepEqual(await readRecoveryState(pool, rollback), rollbackBefore);

  await pool.query(
    `DROP TRIGGER ${quoteProbeIdentifier(rollbackProbe.trigger)} ON capture_task_events`,
  );
  await pool.query(
    `DROP FUNCTION ${quoteProbeIdentifier(rollbackProbe.function)}()`,
  );
  rollbackProbe = null;
  const retryAfterRollback = await reconcileAutomaticCaptureRetries(1);
  const rollbackRetryTaskId = assertFirstAutomaticDispatchSummary(
    retryAfterRollback,
    rollback,
  );
  assertSingleDispatch(
    await readRecoveryState(pool, rollback),
    rollback,
    rollbackTarget,
    rollbackRetryTaskId,
  );
});
