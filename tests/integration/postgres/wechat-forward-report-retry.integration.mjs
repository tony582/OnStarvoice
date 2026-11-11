import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('forward-only reporting exclusion and no-retry gates use real tenant-scoped PostgreSQL rows', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {collectCustomerDailyReport} = await import('../../../server/services/customer-daily-report-data.js');
  const {createSession} = await import('../../../server/services/auth-service.js');
  const {hashOrchestrationRequest} = await import('../../../server/services/capture-orchestration.js');
  const {default: orchestrationRouter} = await import('../../../server/routes/capture-orchestrations.js');
  await runMigrations();
  const pool = getPool();
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const tenants = [], users = [];
  const require = createRequire(new URL('../../../server/package.json', import.meta.url));
  const express = require('express'), app = express();
  app.use(express.json());
  app.use('/api/capture-cloud', orchestrationRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({error: error.code || error.message}));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (users.length) await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) {
      await query('DELETE FROM capture_tasks WHERE tenant_id=ANY($1::uuid[])', [tenants]);
      await query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    }
    await closePool();
  });
  async function tenant() {
    const [row] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', ['Forward regression ' + randomUUID()]);
    tenants.push(row.id); return row.id;
  }
  async function batch(tenantId, {status = 'failed', items = [], metadata = {}} = {}) {
    const [parent] = await query(`INSERT INTO capture_tasks(tenant_id,client_task_id,task_type,feature_key,title,platform,
      source,trigger_type,status,metadata,orchestration_revision,created_at)
      VALUES($1,$2,'capture_orchestration','keyword_orchestration','转发回归','wechat_channels','cloud','manual',$3,$4,1,
        '2026-09-07T03:00:00Z') RETURNING *`, [tenantId, randomUUID(), status, metadata]);
    const children = [];
    for (const [ordinal, item] of items.entries()) {
      const [child] = await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status)
        VALUES($1,$2,$3,$4,$5,'wechat_channels',$6,$7) RETURNING *`,
      [tenantId, parent.id, `item:${ordinal}`, ordinal, `关键词或接收人${ordinal}`, item.type, item.status]);
      children.push(child);
    }
    return {parent, items: children};
  }
  async function report(tenantId, date = '2026-09-07') {
    const pendingQueries = [];
    const db = {
      queryOne: async (sql, values) => (await query(sql, values))[0] || null,
      queryAll: async (sql, values) => {
        const rows = await query(sql, values);
        if (sql.includes('customer_daily:pending_capture')) pendingQueries.push({values, rows});
        return rows;
      },
    };
    const result = await collectCustomerDailyReport({tenantId, date, now: new Date('2026-11-11T08:00:00Z'),
      auditCoverageFrom: '2026-08-01T00:00:00Z', db});
    return {result, pendingQueries};
  }
  async function writer(tenantId) {
    const [user] = await query(`INSERT INTO users(email,name,password_hash,status,must_change_password)
      VALUES($1,'转发回归','offline-only','active',false) RETURNING id`, [`${randomUUID()}@integration.invalid`]);
    users.push(user.id);
    await query(`INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_admin','active')`, [user.id, tenantId]);
    return (await createSession(user.id, {headers: {}})).token;
  }
  async function retry(tenantId, token, parent, items, requestKey = randomUUID()) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/capture-cloud/orchestrations/${parent.id}/retry-items`, {
      method: 'POST', headers: {authorization: `Bearer ${token}`, 'x-tenant-id': tenantId, 'content-type': 'application/json'},
      body: JSON.stringify({requestKey, expectedRevision: parent.orchestration_revision, itemIds: items.map(item => item.id)}),
    });
    return {status: response.status, body: await response.json()};
  }
  async function state(tenantId) {
    const result = {};
    for (const table of ['capture_tasks', 'capture_task_items', 'capture_task_item_attempts', 'capture_agent_commands', 'capture_task_events']) {
      result[table] = await query(`SELECT * FROM ${table} WHERE tenant_id=$1 ORDER BY id`, [tenantId]);
    }
    return result;
  }

  await t.test('failed and queued pure forwards plus a completed keyword produce no capture_not_settled', async () => {
    const own = await tenant(), foreign = await tenant();
    const failed = await batch(own, {items: [{type: 'wechat_forward', status: 'failed'}, {type: 'wechat_forward', status: 'failed'}]});
    const queued = await batch(own, {status: 'pending', items: [{type: 'wechat_forward', status: 'pending'}]});
    const completed = await batch(own, {status: 'completed', items: [{type: 'keyword', status: 'completed'}]});
    await batch(foreign, {status: 'running', items: [{type: 'keyword', status: 'pending'}]});
    const {result, pendingQueries} = await report(own);
    assert.equal(pendingQueries.length, 1, 'the real pre-Oct-8 pending_capture SQL must execute');
    const rows = pendingQueries[0].rows;
    assert.deepEqual(rows.map(row => row.id).sort(), [failed.parent.id, queued.parent.id, completed.parent.id].sort());
    const projected = rows.find(row => row.id === failed.parent.id);
    assert.deepEqual([projected.total_item_count, projected.wechat_forward_item_count, projected.keyword_item_count], [2, 2, 0]);
    assert.deepEqual(result.evidence.pendingCaptureTasks, []);
    assert.ok(!result.warnings.some(warning => warning.code === 'capture_not_settled'));
    assert.ok(rows.every(row => row.feature_key === 'keyword_orchestration'), 'stored feature keys remain unchanged');
  });

  await t.test('mixed unfinished keywords still block, then settling the keyword alone removes the warning', async () => {
    const own = await tenant();
    const mixed = await batch(own, {status: 'running', items: [{type: 'wechat_forward', status: 'failed'}, {type: 'keyword', status: 'pending'}]});
    const before = await report(own);
    assert.equal(before.pendingQueries.length, 1);
    assert.deepEqual(before.result.evidence.pendingCaptureTasks.map(row => row.id), [mixed.parent.id]);
    assert.ok(before.result.evidence.pendingCaptureTasks[0].reasons.includes('keyword_items_incomplete'));
    assert.ok(before.result.warnings.some(warning => warning.code === 'capture_not_settled' && warning.blocking));
    await query("UPDATE capture_task_items SET status='completed' WHERE id=$1", [mixed.items[1].id]);
    assert.deepEqual((await report(own)).result.evidence.pendingCaptureTasks, []);
  });

  await t.test('empty and forwarding-plus-other-item batches do not gain the pure-forward exemption', async () => {
    const own = await tenant();
    const empty = await batch(own);
    const mixed = await batch(own, {items: [{type: 'wechat_forward', status: 'failed'}, {type: 'negative_post', status: 'failed'}]});
    const {result, pendingQueries} = await report(own);
    assert.equal(pendingQueries.length, 1);
    assert.deepEqual(result.evidence.pendingCaptureTasks.map(row => row.id).sort(), [empty.parent.id, mixed.parent.id].sort());
    const current = await report(own, '2026-11-10');
    assert.equal(current.pendingQueries.length, 0, 'current triage-handling reports retain their existing scope');
  });

  await t.test('manual retry rejects a failed forward without an execution and any mixed selection without mutation', async () => {
    const own = await tenant(), token = await writer(own);
    const pure = await batch(own, {items: [{type: 'wechat_forward', status: 'failed'}]});
    const mixed = await batch(own, {items: [{type: 'keyword', status: 'failed'}, {type: 'wechat_forward', status: 'failed'}]});
    for (const current of [pure, mixed]) {
      const before = await state(own);
      const response = await retry(own, token, current.parent, current.items);
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.error, 'retry_items_wechat_forward');
      assert.deepEqual(response.body.itemIds, current.items.filter(item => item.item_type === 'wechat_forward').map(item => item.id));
      assert.deepEqual(await state(own), before, 'no parent/item/attempt/command/event is changed');
    }
  });

  await t.test('a legacy idempotent retry response cannot bypass the forward refusal', async () => {
    const own = await tenant(), token = await writer(own);
    const current = await batch(own, {items: [{type: 'wechat_forward', status: 'failed'}]});
    const requestKey = randomUUID();
    const retryRequestHash = hashOrchestrationRequest({action: 'retry_items_atomic_shard', orchestrationId: current.parent.id,
      expectedRevision: 1, itemIds: [current.items[0].id], assignments: [], confirmSafety: false});
    await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,parent_task_id,task_type,feature_key,title,platform,status,metadata)
      VALUES($1,$2,$1::uuid::text,$3,'wechat_forward','keyword_orchestration','旧转发执行','wechat_channels','failed',$4)`,
    [requestKey, own, current.parent.id, {retryRequestHash, retryRequestKey: requestKey}]);
    const before = await state(own);
    const response = await retry(own, token, current.parent, current.items, requestKey);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error, 'retry_items_wechat_forward');
    assert.deepEqual(await state(own), before);
  });
});
