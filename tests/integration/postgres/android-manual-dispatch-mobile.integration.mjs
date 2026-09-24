import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// The manual one-time fixed-batch dispatch route assigns a phone group to a
// mobile child task with no create command; the phone then claims each keyword.
test('manual fixed-batch dispatch to a phone creates a command-less mobile child', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {createApp} = await import('../../../server/app.js');
  const {createAndroidControlService} = await import('../../../server/services/android-control/service.js');
  const {hashPassword} = await import('../../../server/services/auth-service.js');
  await runMigrations();
  const pool = getPool();
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;

  const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`android-manual-${randomUUID()}`]);
  const code = randomUUID();
  await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4)', [tenant.id, code]);
  const androidService = createAndroidControlService({enabledTenants: () => new Set([tenant.id])});
  const registration = {code, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
  const registered = await androidService.register(registration);
  const [phone] = await query('SELECT * FROM capture_agents WHERE id=$1', [registered.agent.id]);

  const email = `android-manual-${randomUUID()}@example.invalid`;
  const password = 'local-test-only';
  const [user] = await query("INSERT INTO users(email,name,password_hash,status,must_change_password) VALUES($1,'Manual test',$2,'active',false) RETURNING id", [email, hashPassword(password)]);
  await query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_admin','active')", [user.id, tenant.id]);
  const server = await new Promise((resolve, reject) => {
    const srv = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
    srv.once('listening', () => resolve(srv));
    srv.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
    await query('DELETE FROM capture_task_item_attempts WHERE tenant_id=$1', [tenant.id]);
    await query('DELETE FROM capture_task_items WHERE tenant_id=$1', [tenant.id]);
    await query('DELETE FROM capture_agent_commands WHERE tenant_id=$1', [tenant.id]);
    await query('DELETE FROM capture_tasks WHERE tenant_id=$1', [tenant.id]);
    await query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    await query('DELETE FROM users WHERE id=$1', [user.id]);
    await closePool();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
  assert.equal(login.status, 200);
  const {token} = await login.json();

  // Seed a draft one-time fixed-batch orchestration parent with two pending douyin keywords.
  const parentId = randomUUID();
  const keywords = ['威朗壁纸', '英朗壁纸'];
  const planSnapshot = {platform: 'douyin', searchFilters: {sort: 'latest', publishTime: 'day', contentType: 'video'}, keywordMaxDetectedItems: 25, mobileKeywordMaxMinutes: 8, recoveryPolicy: {}};
  await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,status,metadata,orchestration_revision,counts,progress)
    VALUES($1::uuid,$2,$1::text,'capture_orchestration','keyword_orchestration','手机手动','douyin','cloud','manual','pending',$3::jsonb,0,$4::jsonb,'{}'::jsonb)`,
  [parentId, tenant.id, JSON.stringify({executionMode: 'one_time', distributionMode: 'fixed_batch', draft: true, planSnapshot}), JSON.stringify({total: keywords.length})]);
  const itemIds = [];
  for (const [ordinal, keyword] of keywords.entries()) {
    const [item] = await query(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,assignment_revision)
      VALUES($1,$2,$3,$4,$5,$6,'douyin','keyword','pending',0) RETURNING id`, [randomUUID(), tenant.id, parentId, `keyword:${ordinal}`, ordinal, keyword]);
    itemIds.push(item.id);
  }

  const dispatch = await fetch(`${origin}/api/capture-cloud/orchestrations/${parentId}/dispatch`, {
    method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-tenant-id': tenant.id},
    body: JSON.stringify({expectedRevision: 0, assignments: itemIds.map(itemId => ({itemId, agentId: phone.id}))}),
  });
  const body = await dispatch.json();
  assert.ok([200, 201].includes(dispatch.status), JSON.stringify(body));
  assert.equal(body.executions.length, 1);
  assert.equal(body.executions[0].commandId, null, 'phone execution carries no command');

  const [child] = await query(`SELECT * FROM capture_tasks WHERE tenant_id=$1 AND parent_task_id=$2 AND metadata->>'workflow'='douyin_mobile_discovery'`, [tenant.id, parentId]);
  assert.ok(child, 'a mobile child task was created');
  assert.equal(child.assigned_agent_id, phone.id);
  assert.equal(child.metadata.distributionMode, 'fixed_batch');
  assert.equal(child.metadata.budgets.keywordMs, 8 * 60000);
  assert.deepEqual(child.metadata.filters, {sort: 'latest', publishTime: 'day', contentType: 'video'});
  assert.equal((await query('SELECT id FROM capture_agent_commands WHERE task_id=$1', [child.id])).length, 0);
  const bound = await query('SELECT status,assigned_agent_id FROM capture_task_items WHERE execution_task_id=$1', [child.id]);
  assert.equal(bound.length, keywords.length);
  assert.ok(bound.every(item => item.status === 'pending' && item.assigned_agent_id === phone.id));

  // The phone claims one of its assigned keywords onto that child.
  const principal = {tenantId: tenant.id, agentId: phone.id, authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id};
  const claim = await androidService.poll(principal, {sessionId: randomUUID(), deviceId: registration.deviceId, readyForSearch: true});
  assert.ok(claim.task);
  assert.equal(claim.task.identity.taskId, child.id);
  assert.ok(keywords.includes(claim.task.keyword));
});
