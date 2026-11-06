import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('command receipts wait for the Agent slot without blocking heartbeat parent projection', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {default: router, refreshOrchestrationParentTask} = await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const pool = getPool();
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const tenantIds = [];
  t.after(async () => {
    try { await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]); }
    finally { await closePool(); }
  });
  const handler = router.stack.find(layer => layer.route?.path === '/agent/commands/:id/complete')
    .route.stack.at(-1).handle;
  const asExecutor = client => ({
    queryOne: async (sql, params = []) => (await client.query(sql, params)).rows[0] || null,
    queryAll: async (sql, params = []) => (await client.query(sql, params)).rows,
    execute: async (sql, params = []) => client.query(sql, params),
  });
  async function fixture(nodes = 1) {
    const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',
      [`Command lock order ${randomUUID()}`]);
    tenantIds.push(tenant.id);
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,task_type,feature_key,title,
      status,metadata,orchestration_revision)
      VALUES($1,'capture_orchestration','keyword_orchestration','Synthetic lock regression',
      'running','{"distributionMode":"elastic_pool"}',1) RETURNING *`, [tenant.id]);
    const agents = [];
    for (let index = 0; index < nodes; index++) {
      const [agent] = await query(`INSERT INTO capture_agents(tenant_id,client_uuid,client_label,
        browser_name,app_version,status,last_heartbeat_at)
        VALUES($1,$2,$3,'Chrome','0.4.29','active',now()) RETURNING *`,
      [tenant.id, randomUUID(), `Synthetic Agent ${index}`]);
      const taskId = randomUUID();
      const commandId = randomUUID();
      const [child] = await query(`INSERT INTO capture_tasks(id,tenant_id,parent_task_id,assigned_agent_id,
        origin_agent_id,client_task_id,task_type,feature_key,title,platform,status,metadata)
        VALUES($1::uuid,$2,$3,$4,$4,$1::uuid::text,'unattended_keyword_capture','unattended_keywords',
        'Synthetic child','xiaohongshu','pending',$5::jsonb) RETURNING *`,
      [taskId, tenant.id, parent.id, agent.id, JSON.stringify({orchestrationChild: true, createCommandId: commandId})]);
      await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,item_type,keyword,platform,
        status,assigned_agent_id,execution_task_id,assignment_revision)
        VALUES($1,$2,$3,'keyword',$3,'xiaohongshu','dispatched',$4,$5,1)`,
      [tenant.id, parent.id, `Synthetic keyword ${index}`, agent.id, child.id]);
      const [command] = await query(`INSERT INTO capture_agent_commands(id,tenant_id,agent_id,task_id,
        command_type,status,payload,acknowledged_at,expires_at)
        VALUES($1,$2,$3,$4,'create','acknowledged',$5::jsonb,now(),now()+interval '10 minutes') RETURNING *`,
      [commandId, tenant.id, agent.id, child.id, JSON.stringify({clientTaskId: child.id, executionMode: 'one_time'})]);
      agents.push({agent, child, command});
    }
    return {tenant, parent, agents};
  }
  async function complete(f, node, {tenantId = f.tenant.id} = {}) {
    let status = 200;
    let body;
    let failure;
    const headers = {};
    await handler({tenantId, captureAgent: node.agent, params: {id: node.command.id},
      body: {success: true, result: {requestId: node.child.id}}}, {
      set(name, value) { headers[name] = value; return this; },
      status(value) { status = value; return this; },
      json(value) { body = value; return this; },
    }, error => { failure = error; });
    return {status, body, failure, headers};
  }
  async function beginHeartbeat(client, f, node) {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '2500ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
      ['capture_agent_execution_slot', `${f.tenant.id}:${node.agent.id}`]);
    await client.query('SELECT id FROM capture_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [node.child.id, f.tenant.id]);
  }
  async function waitForSlotWaiter(f, node) {
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const rows = await query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND classid::bigint=(hashtext($1)::bigint & 4294967295)
        AND objid::bigint=(hashtext($2)::bigint & 4294967295) AND objsubid=2`,
      ['capture_agent_execution_slot', `${f.tenant.id}:${node.agent.id}`]);
      if (rows.length > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('command did not reach the held Agent slot');
  }
  const commandState = async node => (await query(
    'SELECT status,result,finished_at FROM capture_agent_commands WHERE id=$1', [node.command.id]))[0];

  await t.test('real parent projection and two Agents sharing a parent finish without deadlock or lost receipts', async () => {
    const f = await fixture(2);
    const [first, second] = f.agents;
    const heartbeat = await pool.connect();
    let firstReceipt;
    let secondReceipt;
    try {
      await beginHeartbeat(heartbeat, f, first);
      firstReceipt = complete(f, first);
      await waitForSlotWaiter(f, first);
      secondReceipt = complete(f, second);
      // Production failed here: receipt held the parent while waiting for
      // this heartbeat's slot. Use the real projection, not a mock lock order.
      const projection = await refreshOrchestrationParentTask(asExecutor(heartbeat), {
        tenantId: f.tenant.id, parentTaskId: f.parent.id,
      });
      assert.equal(projection.id, f.parent.id);
      await heartbeat.query('COMMIT');
      for (const response of await Promise.all([firstReceipt, secondReceipt])) {
        assert.equal(response.failure, undefined);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.ok, true);
      }
      for (const node of f.agents) {
        assert.equal((await commandState(node)).status, 'completed');
        const replay = await complete(f, node);
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.equal(replay.body.idempotent, true);
        const [{count}] = await query(`SELECT count(*)::int AS count FROM capture_task_events
          WHERE task_id=$1 AND event_type='command_completed'`, [node.child.id]);
        assert.equal(count, 1, 'a replay must not duplicate the receipt event');
      }
    } finally {
      await heartbeat.query('ROLLBACK');
      heartbeat.release();
      await Promise.allSettled([firstReceipt, secondReceipt].filter(Boolean));
    }
  });

  await t.test('a busy slot rolls back without partial receipt writes, and retry succeeds after release', async () => {
    const f = await fixture();
    const [node] = f.agents;
    const holder = await pool.connect();
    const before = await commandState(node);
    try {
      await beginHeartbeat(holder, f, node);
      const busy = await complete(f, node);
      assert.equal(busy.failure, undefined);
      assert.equal(busy.status, 503);
      assert.equal(busy.headers['Retry-After'], '1');
      assert.deepEqual(await commandState(node), before);
      await holder.query('COMMIT');
      const retried = await complete(f, node);
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.equal((await commandState(node)).status, 'completed');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  await t.test('revocation committed while waiting is re-read before any receipt mutation', async () => {
    const f = await fixture();
    const [node] = f.agents;
    const holder = await pool.connect();
    const before = await commandState(node);
    let pending;
    try {
      await beginHeartbeat(holder, f, node);
      pending = complete(f, node);
      await waitForSlotWaiter(f, node);
      await query("UPDATE capture_agents SET status='revoked' WHERE id=$1", [node.agent.id]);
      await holder.query('COMMIT');
      const denied = await pending;
      assert.equal(denied.failure, undefined);
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, 'agent_inactive');
      assert.deepEqual(await commandState(node), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await Promise.allSettled([pending].filter(Boolean));
    }
  });

  await t.test('foreign tenant command references remain inaccessible', async () => {
    const own = await fixture();
    const foreign = await fixture();
    const [node] = own.agents;
    const before = await commandState(node);
    const denied = await complete(own, node, {tenantId: foreign.tenant.id});
    assert.equal(denied.failure, undefined);
    assert.equal(denied.status, 404);
    assert.deepEqual(await commandState(node), before);
  });
});
