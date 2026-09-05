import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';

import {
  isAllowedPostgresIntegrationServerAddress,
  validatePostgresIntegrationTarget,
} from '../../../scripts/lib/postgres-integration-target.mjs';
import {loadMigrationInventory} from '../../../server/db/migration-inventory.js';

const requireFromServer = createRequire(
  new URL('../../../server/package.json', import.meta.url),
);
const {Pool} = requireFromServer('pg');
const capabilities = Object.freeze({
  remoteTaskCreate: true,
  remoteTaskKeywordPostLimit: true,
  singleRelayV1: true,
  supportedPlatforms: ['douyin'],
});

function quoteSchema(schema) {
  assert.match(schema, /^p3_elastic_rounds_[a-f0-9]{20}$/u);
  return `"${schema}"`;
}

function transactionExecutor(client) {
  return {
    client,
    query: (sql, params = []) => client.query(sql, params),
    async queryOne(sql, params = []) {
      return (await client.query(sql, params)).rows[0] || null;
    },
    async queryAll(sql, params = []) {
      return (await client.query(sql, params)).rows;
    },
    async execute(sql, params = []) {
      const result = await client.query(sql, params);
      return {
        changes: result.rowCount,
        rowCount: result.rowCount,
        rows: result.rows,
        lastInsertRowid: result.rows[0]?.id || null,
      };
    },
  };
}

async function inSchema(pool, schema, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${quoteSchema(schema)}, public`);
    const result = await operation(transactionExecutor(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function createFixture(tx, {
  agentCount,
  history = [],
  budgetUsed = history.length,
}) {
  const token = randomUUID();
  const tenant = await tx.queryOne(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`Elastic rounds ${token}`],
  );
  const agents = [];
  for (let index = 0; index < agentCount; index += 1) {
    const authCode = await tx.queryOne(`
      INSERT INTO auth_codes (tenant_id, code, status, expires_at)
      VALUES ($1, $2, 'active', now() + interval '1 day')
      RETURNING id
    `, [tenant.id, `ELASTIC-ROUNDS-${token}-${index}`]);
    const authBinding = await tx.queryOne(`
      INSERT INTO auth_bindings (code_id, fingerprint)
      VALUES ($1, $2) RETURNING id
    `, [authCode.id, `elastic-rounds-${token}-${index}`]);
    agents.push(await tx.queryOne(`
      INSERT INTO capture_agents (
        tenant_id, client_uuid, display_name, browser_name,
        app_version, allowed_platforms, status, last_heartbeat_at,
        last_full_heartbeat_at, auth_code_id, auth_binding_id, capabilities
      ) VALUES (
        $1, $2, $3, 'Edge', '0.4.5', ARRAY['douyin'], 'active', now(),
        now(), $4, $5, $6::jsonb
      ) RETURNING *
    `, [
      tenant.id,
      `elastic-rounds-${token}-${index}`,
      `Elastic rounds Agent ${index}`,
      authCode.id,
      authBinding.id,
      JSON.stringify(capabilities),
    ]));
    await tx.execute(`
      INSERT INTO social_agent_daily_usage (
        tenant_id, agent_id, platform, usage_date,
        searches, failed_events, safety_verifications, last_event_at
      ) VALUES (
        $1, $2, 'douyin', (now() AT TIME ZONE 'Asia/Shanghai')::date,
        0, 0, 0, now()
      )
    `, [tenant.id, agents[index].id]);
  }
  const parent = await tx.queryOne(`
    INSERT INTO capture_tasks (
      tenant_id, client_task_id, task_type, feature_key,
      title, platform, status, metadata
    ) VALUES (
      $1, $2, 'capture_orchestration', 'unattended_keyword_plan',
      $3, 'douyin', 'running', $4::jsonb
    ) RETURNING id
  `, [
    tenant.id,
    `elastic-rounds-parent-${token}`,
    `Elastic rounds parent ${token}`,
    JSON.stringify({
      distributionMode: 'elastic_pool',
      eligibleAgentIds: agents.map(agent => agent.id),
      planSnapshot: {
        enabled: true,
        platform: 'douyin',
        keywordMaxDetectedItems: 5,
        recoveryPolicy: {singleRelayV1: true},
      },
    }),
  ]);
  const item = await tx.queryOne(`
    INSERT INTO capture_task_items (
      tenant_id, task_id, item_key, platform, item_type,
      status, attempt_count, ordinal, keyword, assignment_revision, metadata
    ) VALUES (
      $1, $2, $3, 'douyin', 'keyword',
      $4, $5, 0, $6, $5, $7::jsonb
    ) RETURNING id
  `, [
    tenant.id,
    parent.id,
    `elastic-rounds-item-${token}`,
    history.length ? 'retryable' : 'pending',
    history.length,
    `elastic-rounds-keyword-${token}`,
    JSON.stringify({elasticAttemptBudgetUsed: budgetUsed}),
  ]);
  for (const [index, entry] of history.entries()) {
    const agent = agents[entry.agentIndex];
    assert.ok(agent, 'history must refer to a configured Agent');
    const error = entry.error || {code: 'INTEGRATION_TECHNICAL_FAILURE'};
    const checkpoint = entry.checkpoint || {};
    const child = await tx.queryOne(`
      INSERT INTO capture_tasks (
        tenant_id, parent_task_id, origin_agent_id, assigned_agent_id,
        client_task_id, task_type, feature_key, title, platform,
        status, metadata, error, finished_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $3, $4, 'unattended_keyword_capture',
        'unattended_keyword_plan', $4, 'douyin', 'failed',
        '{"cloudWorkQueue":true}'::jsonb, $5::jsonb,
        now() - interval '1 hour', now() - interval '2 hours',
        now() - interval '1 hour'
      ) RETURNING id
    `, [tenant.id, parent.id, agent.id, `history-${token}-${index}`, JSON.stringify(error)]);
    await tx.execute(`
      INSERT INTO capture_task_item_attempts (
        tenant_id, item_id, parent_task_id, execution_task_id,
        agent_id, attempt_number, assignment_revision, status,
        error, checkpoint, finished_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $6, 'retryable',
        $7::jsonb, $8::jsonb, now() - interval '1 hour',
        now() - interval '2 hours', now() - interval '1 hour'
      )
    `, [
      tenant.id, item.id, parent.id, child.id, agent.id, index + 1,
      JSON.stringify(error), JSON.stringify(checkpoint),
    ]);
    await tx.execute(`
      UPDATE capture_task_items
      SET assigned_agent_id = $1, execution_task_id = $2, error = $3::jsonb
      WHERE id = $4 AND tenant_id = $5
    `, [agent.id, child.id, JSON.stringify(error), item.id, tenant.id]);
  }
  return {tenantId: tenant.id, parentId: parent.id, itemId: item.id, agents};
}

async function assertClaimPersisted(tx, fixture, claim, agentIndex, attemptNumber) {
  assert.ok(claim, `Agent ${agentIndex} should claim attempt ${attemptNumber}`);
  assert.equal(claim.itemId, fixture.itemId);
  const item = await tx.queryOne(`
    SELECT status, attempt_count, assigned_agent_id, execution_task_id,
      assignment_revision, request_hash, metadata
    FROM capture_task_items WHERE id = $1 AND tenant_id = $2
  `, [fixture.itemId, fixture.tenantId]);
  assert.equal(item.status, 'dispatched');
  assert.equal(item.attempt_count, attemptNumber);
  assert.equal(item.assignment_revision, attemptNumber);
  assert.equal(item.assigned_agent_id, fixture.agents[agentIndex].id);
  assert.equal(item.execution_task_id, claim.childTaskId);
  assert.equal(item.metadata.elasticAttemptBudgetUsed, attemptNumber);
  assert.match(item.request_hash, /^[a-f0-9]{64}$/u);
  const attempts = await tx.queryAll(`
    SELECT id, agent_id, attempt_number, assignment_revision, request_hash
    FROM capture_task_item_attempts
    WHERE item_id = $1 AND execution_task_id = $2 AND tenant_id = $3
  `, [fixture.itemId, claim.childTaskId, fixture.tenantId]);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].agent_id, item.assigned_agent_id);
  assert.equal(attempts[0].attempt_number, attemptNumber);
  assert.equal(attempts[0].assignment_revision, item.assignment_revision);
  assert.equal(attempts[0].request_hash, item.request_hash);
  const command = await tx.queryOne(`
    SELECT task_id, payload FROM capture_agent_commands
    WHERE id = $1 AND tenant_id = $2
  `, [claim.commandId, fixture.tenantId]);
  assert.equal(command.task_id, claim.childTaskId);
  assert.equal(command.payload.orchestration.itemAttempts.length, 1);
  assert.equal(command.payload.orchestration.itemAttempts[0].attemptId, attempts[0].id);
  assert.equal(command.payload.orchestration.itemAttempts[0].requestHash, item.request_hash);
}

async function settleTechnicalFailure(tx, fixture, claim) {
  // Simulate an already settled technical outcome. Backdating the terminal
  // evidence excludes cooldown timing from these allocation-policy tests.
  await tx.execute(`
    UPDATE capture_tasks
    SET status = 'failed', error = '{"code":"INTEGRATION_TECHNICAL_FAILURE"}'::jsonb,
      finished_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'
    WHERE id = $1 AND tenant_id = $2
  `, [claim.childTaskId, fixture.tenantId]);
  await tx.execute(`
    UPDATE capture_task_item_attempts
    SET status = 'retryable', error = '{"code":"INTEGRATION_TECHNICAL_FAILURE"}'::jsonb,
      finished_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'
    WHERE item_id = $1 AND execution_task_id = $2 AND tenant_id = $3
  `, [fixture.itemId, claim.childTaskId, fixture.tenantId]);
  await tx.execute(`
    UPDATE capture_agent_commands
    SET status = 'completed', finished_at = now(), updated_at = now()
    WHERE id = $1 AND tenant_id = $2
  `, [claim.commandId, fixture.tenantId]);
  await tx.execute(`
    UPDATE capture_task_items
    SET status = 'retryable', error = '{"code":"INTEGRATION_TECHNICAL_FAILURE"}'::jsonb
    WHERE id = $1 AND tenant_id = $2
  `, [fixture.itemId, fixture.tenantId]);
}

test('real PostgreSQL keeps elastic technical retries bounded to two distinct-Agent pool passes', async t => {
  const target = validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const token = randomUUID().replaceAll('-', '').slice(0, 20);
  const schema = `p3_elastic_rounds_${token}`;
  const pool = new Pool({
    connectionString: target.rawUrl,
    application_name: `p3-elastic-rounds-${token}`,
    connectionTimeoutMillis: 5000,
    query_timeout: 20000,
    statement_timeout: 15000,
    lock_timeout: 5000,
    idleTimeoutMillis: 1000,
    max: 3,
  });
  let schemaCreated = false;
  t.after(async () => {
    try {
      if (schemaCreated) {
        await pool.query(`DROP SCHEMA ${quoteSchema(schema)} CASCADE`);
        const result = await pool.query('SELECT to_regnamespace($1) AS namespace', [schema]);
        assert.equal(result.rows[0].namespace, null);
      }
    } finally {
      await pool.end();
    }
  });
  const physical = (await pool.query(`
    SELECT current_database() AS database_name, inet_server_addr()::text AS server_address
  `)).rows[0];
  assert.equal(physical.database_name, target.databaseName);
  assert.equal(isAllowedPostgresIntegrationServerAddress({
    serverAddress: physical.server_address,
    target,
  }), true, 'elastic retries require a verified local integration server');
  await pool.query(`CREATE SCHEMA ${quoteSchema(schema)}`);
  schemaCreated = true;
  // Match the existing isolated-schema canary harness: pgcrypto stays outside
  // the disposable schema and every table/function is created by real SQL.
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
  const migrations = await loadMigrationInventory();
  await inSchema(pool, schema, async tx => {
    for (const migration of migrations) await tx.query(migration.sql);
  });
  const {dispatchNextElasticWorkItem} = await import('../../../server/routes/capture-cloud.js');
  const run = operation => inSchema(pool, schema, operation);
  const fixture = options => run(tx => createFixture(tx, options));
  const claim = (current, index) => run(tx => dispatchNextElasticWorkItem(tx, {
    agent: current.agents[index], capabilities,
  }));
  const verify = (current, result, index, attempt) => run(tx =>
    assertClaimPersisted(tx, current, result, index, attempt));

  await t.test('an earlier Agent in the current pass cannot repeat before an untried Agent', async () => {
    const current = await fixture({
      agentCount: 3,
      history: [{agentIndex: 0}, {agentIndex: 1}],
    });
    // Agent 0 is not the most recent source, so this proves the round fence
    // independently of the separate consecutive-Agent predicate.
    assert.equal(await claim(current, 0), null);
    await verify(current, await claim(current, 2), 2, 3);
  });

  await t.test('a completed first pass opens the second pass without consecutive reuse', async () => {
    const current = await fixture({
      agentCount: 3,
      history: [{agentIndex: 0}, {agentIndex: 1}, {agentIndex: 2}],
    });
    assert.equal(await claim(current, 2), null, 'the latest source cannot immediately repeat');
    const secondPass = await claim(current, 0);
    await verify(current, secondPass, 0, 4);
    await run(tx => settleTechnicalFailure(tx, current, secondPass));
    assert.equal(await claim(current, 0), null);
    await verify(current, await claim(current, 1), 1, 5);
  });

  await t.test('two full passes stop even if the logical attempt budget was reset', async () => {
    for (const budgetUsed of [4, 0]) {
      const current = await fixture({
        agentCount: 2,
        history: [{agentIndex: 0}, {agentIndex: 1}, {agentIndex: 0}, {agentIndex: 1}],
        budgetUsed,
      });
      assert.equal(await claim(current, 0), null);
      assert.equal(await claim(current, 1), null);
      const count = await run(tx => tx.queryOne(`
        SELECT COUNT(*)::integer AS count FROM capture_agent_commands WHERE tenant_id = $1
      `, [current.tenantId]));
      assert.equal(count.count, 0, 'exhausted retries must not publish another create command');
    }
  });

  await t.test('a historical safety result keeps its Agent excluded across pass boundaries', async () => {
    const safetyEvidence = [
      {error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'}},
      {error: {category: 'login_required'}},
      {checkpoint: {securityBlocked: true}},
    ];
    for (const evidence of safetyEvidence) {
      const current = await fixture({
        agentCount: 3,
        history: [
          {agentIndex: 0, ...evidence},
          {agentIndex: 1},
          {agentIndex: 2},
        ],
      });
      assert.equal(await claim(current, 0), null, JSON.stringify(evidence));
      await verify(current, await claim(current, 1), 1, 4);
    }
  });

  await t.test('a single-Agent pool can run its second attempt but cannot start a third', async () => {
    const current = await fixture({agentCount: 1, history: [{agentIndex: 0}]});
    const secondPass = await claim(current, 0);
    await verify(current, secondPass, 0, 2);
    await run(tx => settleTechnicalFailure(tx, current, secondPass));
    assert.equal(await claim(current, 0), null);
  });

  await t.test('overlapping Agent transactions publish exactly one claim for the same item', async () => {
    const current = await fixture({agentCount: 2});
    let winner;
    await run(async tx => {
      winner = await dispatchNextElasticWorkItem(tx, {agent: current.agents[0], capabilities});
      assert.ok(winner);
      // The first transaction still owns the parent/item row locks. A second
      // real connection must skip them instead of claiming or blocking.
      assert.equal(await claim(current, 1), null);
    });
    await verify(current, winner, 0, 1);
    const counts = await run(tx => tx.queryOne(`
      SELECT
        (SELECT COUNT(*)::integer FROM capture_task_item_attempts WHERE tenant_id = $1) AS attempts,
        (SELECT COUNT(*)::integer FROM capture_agent_commands WHERE tenant_id = $1) AS commands,
        (SELECT COUNT(*)::integer FROM capture_tasks WHERE tenant_id = $1 AND parent_task_id = $2) AS children
    `, [current.tenantId, current.parentId]));
    assert.deepEqual(counts, {attempts: 1, commands: 1, children: 1});
  });
});
