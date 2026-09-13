import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {withTransaction} from '../../../server/db/init.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {ensureCurrentSocialAccount} from '../../../server/services/social-account-usage.js';

test('manual social accounts preserve account facts and require explicit tenant-scoped Agent association', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool();
  const tenantIds = [], userIds = [];
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (userIds.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
    if (tenantIds.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenantIds]);
    await closePool();
  });
  const row = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  async function tenant() {
    const {id} = await row('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Manual account ${randomUUID()}`]);
    tenantIds.push(id); return id;
  }
  const tenantId = await tenant(), otherTenant = await tenant();
  async function agent(platforms = ['douyin'], owner = tenantId) {
    return await row("INSERT INTO capture_agents(tenant_id,client_uuid,display_name,allowed_platforms,last_heartbeat_at) VALUES($1,$2,'测试节点',$3,now()) RETURNING *", [owner, randomUUID(), platforms]);
  }
  const node = await agent(), unsupportedNode = await agent(['xiaohongshu']), foreignNode = await agent(['douyin'], otherTenant);
  const detected = await row(`INSERT INTO social_accounts(tenant_id,platform,platform_account_id,account_handle,display_name,registered_phone,identity_source,agent_binding_mode,
    health_status,rest_until,notes,daily_search_limit,daily_enhancement_limit,daily_capture_limit)
    VALUES($1,'douyin','existing-id','existing-handle','检测昵称','13800000000','extension','auto','resting','2030-01-01T12:34:56Z','已有备注',17,23,41) RETURNING *`, [tenantId]);
  const existingBinding = await row(`INSERT INTO social_account_bindings(tenant_id,agent_id,social_account_id,platform,source,last_login_state,last_seen_at)
    VALUES($1,$2,$3,'douyin','extension','authenticated','2026-09-01T01:02:03Z') RETURNING *`, [tenantId, node.id, detected.id]);
  await pool.query(`INSERT INTO social_agent_daily_usage(tenant_id,agent_id,platform,usage_date,searches,enhancements,captured_items)
    VALUES($1,$2,'douyin',current_date,12,8,39)`, [tenantId, node.id]);
  await pool.query(`INSERT INTO social_account_daily_usage(tenant_id,social_account_id,agent_id,platform,usage_date,searches,enhancements,captured_items)
    VALUES($1,$2,$3,'douyin',current_date,12,8,39)`, [tenantId, detected.id, node.id]);
  const running = await row("INSERT INTO capture_tasks(tenant_id,assigned_agent_id,platform,status,title) VALUES($1,$2,'douyin','running','现有运行任务') RETURNING *", [tenantId, node.id]);
  const getAccount = id => row('SELECT * FROM social_accounts WHERE id=$1', [id]);
  const getBinding = id => row('SELECT * FROM social_account_bindings WHERE id=$1', [id]);
  const activityBefore = {
    agent: await row('SELECT * FROM capture_agents WHERE id=$1', [node.id]),
    task: running,
    accountUsage: await row('SELECT * FROM social_account_daily_usage WHERE tenant_id=$1', [tenantId]),
    agentUsage: await row('SELECT * FROM social_agent_daily_usage WHERE tenant_id=$1', [tenantId]),
  };
  async function user(role) {
    const person = await row("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'账号测试员',$2,'active',false,'',false) RETURNING id,email", [`social-${randomUUID()}@integration.invalid`, hashPassword('test-social-password')]);
    userIds.push(person.id);
    await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,$3,'active')", [person.id, tenantId, role]);
    return person;
  }
  const writer = await user('tenant_analyst'), viewer = await user('tenant_viewer');
  const app = createApp({logger: {log() {}, error() {}}});
  server = await new Promise(resolve => {const value = app.listen(0, '127.0.0.1', () => resolve(value));});
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login(person) {
    const response = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: person.email, password: 'test-social-password'})});
    assert.equal(response.status, 200); return (await response.json()).token;
  }
  const token = await login(writer), readerToken = await login(viewer);
  async function request(path = '', {method = 'GET', body, auth = token} = {}) {
    const response = await fetch(`${base}/api/social-accounts${path}`, {method, headers: {'content-type': 'application/json', authorization: `Bearer ${auth}`, 'x-tenant-id': tenantId}, ...(body ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, data: await response.json()};
  }
  let manual;
  await t.test('nickname and phone create an unbound manual account without platform ID', async () => {
    const result = await request('', {method: 'POST', body: {platform: 'douyin', displayName: '人工登记昵称', registeredPhone: '13900000001', identitySource: 'manual', agentBindingMode: 'manual'}});
    assert.equal(result.status, 201, JSON.stringify(result.data));
    manual = result.data.account;
    assert.equal(manual.platform_account_id, ''); assert.equal(manual.account_handle, '');
    assert.equal(manual.identity_source, 'manual'); assert.equal(manual.agent_binding_mode, 'manual');
    assert.equal(manual.last_agent_id, null); assert.equal(result.data.binding, null);
    assert.equal((await row('SELECT count(*)::int n FROM social_account_bindings WHERE social_account_id=$1', [manual.id])).n, 0);
  });
  await t.test('phone-only patch preserves omitted health, rest, limits and identity fields while confirming manual ownership', async () => {
    const result = await request(`/${detected.id}`, {method: 'PATCH', body: {registeredPhone: '13900000002'}});
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const updated = await getAccount(detected.id);
    for (const key of ['platform', 'platform_account_id', 'account_handle', 'display_name', 'health_status', 'rest_until', 'notes', 'daily_search_limit', 'daily_enhancement_limit', 'daily_capture_limit']) assert.deepEqual(updated[key], detected[key], key);
    assert.equal(updated.registered_phone, '13900000002');
    assert.equal(updated.identity_source, 'manual'); assert.equal(updated.agent_binding_mode, 'manual');
    assert.deepEqual(await getBinding(existingBinding.id), existingBinding, 'identity confirmation must not rebind or fake a login');
  });
  await t.test('explicit identity confirmation works even when nickname and phone do not change', async () => {
    await pool.query("UPDATE social_accounts SET identity_source='extension',agent_binding_mode='auto' WHERE id=$1", [manual.id]);
    const result = await request(`/${manual.id}`, {method: 'PATCH', body: {identitySource: 'manual'}});
    assert.equal(result.status, 200); assert.equal(result.data.account.identity_source, 'manual');
    assert.equal(result.data.account.agent_binding_mode, 'manual');
    const overview = await request('/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.data.accounts.find(account => account.id === manual.id).identity_source, 'manual');
  });
  await t.test('invalid identity updates are atomic and explicit zero/empty operations remain available', async () => {
    const before = await getAccount(detected.id);
    for (const body of [{registeredPhone: 'invalid-phone'}, {platform: 'xiaohongshu'}, {healthStatus: 'invalid'}, {restUntil: 'invalid'}, {dailySearchLimit: -1}, {identitySource: 'extension'}]) {
      const result = await request(`/${detected.id}`, {method: 'PATCH', body});
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.deepEqual(await getAccount(detected.id), before);
    }
    const cleared = await request(`/${manual.id}`, {method: 'PATCH', body: {registeredPhone: '', notes: '', dailySearchLimit: 0}});
    assert.equal(cleared.status, 200); assert.equal(cleared.data.account.registered_phone, '');
    assert.equal(cleared.data.account.daily_search_limit, 0);
  });
  await t.test('manual binding validates agent platform/tenant before mutation and preserves existing login facts on repeat', async () => {
    const before = await getAccount(detected.id);
    for (const [target, status] of [[unsupportedNode, 409], [foreignNode, 404]]) {
      for (const method of ['POST', 'PUT']) {
        const result = await request(`/${detected.id}/bindings`, {method, body: method === 'POST' ? {agentId: target.id} : {agentIds: [target.id], bindingMode: 'manual'}});
        assert.equal(result.status, status, JSON.stringify(result.data));
        assert.deepEqual(await getAccount(detected.id), before);
        assert.deepEqual(await getBinding(existingBinding.id), existingBinding);
      }
    }
    const bound = await request(`/${detected.id}/bindings`, {method: 'PUT', body: {agentIds: [node.id], bindingMode: 'manual'}});
    assert.equal(bound.status, 200, JSON.stringify(bound.data));
    const after = await getBinding(existingBinding.id);
    assert.equal(after.source, 'manual'); assert.equal(after.last_login_state, existingBinding.last_login_state);
    assert.deepEqual(after.last_seen_at, existingBinding.last_seen_at);
    const separate = await request(`/${manual.id}/bindings`, {method: 'PUT', body: {agentIds: [], bindingMode: 'manual'}});
    assert.equal(separate.status, 200); assert.deepEqual(separate.data.bindings, []);
  });
  await t.test('heartbeat cannot overwrite confirmed nickname, phone or manual association', async () => {
    const before = await getAccount(detected.id);
    const same = await withTransaction(tx => ensureCurrentSocialAccount(tx, node, 'douyin', {
      platform: 'douyin', platformAccountId: 'existing-id', accountHandle: 'existing-handle', displayName: '心跳检测新昵称',
      loginState: 'authenticated', confidence: 'high', observedAt: new Date().toISOString(),
    }));
    assert.equal(same.id, detected.id);
    const conflict = await withTransaction(tx => ensureCurrentSocialAccount(tx, node, 'douyin', {
      platform: 'douyin', platformAccountId: 'different-id', accountHandle: 'different-handle', displayName: '另一个账号',
      loginState: 'authenticated', confidence: 'high', observedAt: new Date().toISOString(),
    }));
    assert.equal(conflict, null);
    const after = await getAccount(detected.id);
    for (const key of ['display_name', 'registered_phone', 'platform_account_id', 'account_handle', 'identity_source', 'agent_binding_mode', 'health_status', 'rest_until']) assert.deepEqual(after[key], before[key], key);
    const current = await row("SELECT * FROM social_account_bindings WHERE agent_id=$1 AND platform='douyin' AND status='current'", [node.id]);
    assert.equal(current.social_account_id, detected.id); assert.equal(current.metadata.identityConflict, true);
  });
  await t.test('explicit association is separate from creation and leaves unrelated nodes, statistics and running tasks intact', async () => {
    const bound = await request(`/${manual.id}/bindings`, {method: 'PUT', body: {agentIds: [node.id], bindingMode: 'manual'}});
    assert.equal(bound.status, 200, JSON.stringify(bound.data));
    assert.equal(bound.data.bindings[0].agent_id, node.id);
    assert.equal((await getBinding(existingBinding.id)).status, 'historical');
    assert.deepEqual(await row('SELECT * FROM capture_agents WHERE id=$1', [node.id]), activityBefore.agent);
    assert.deepEqual(await row('SELECT * FROM capture_tasks WHERE id=$1', [running.id]), activityBefore.task);
    assert.deepEqual(await row('SELECT * FROM social_account_daily_usage WHERE tenant_id=$1', [tenantId]), activityBefore.accountUsage);
    assert.deepEqual(await row('SELECT * FROM social_agent_daily_usage WHERE tenant_id=$1', [tenantId]), activityBefore.agentUsage);
  });
  await t.test('read-only users and foreign accounts cannot be changed; rejected create-and-bind creates nothing', async () => {
    assert.equal((await request(`/${manual.id}`, {method: 'PATCH', auth: readerToken, body: {displayName: '不能写'}})).status, 403);
    const foreign = await row("INSERT INTO social_accounts(tenant_id,platform,display_name) VALUES($1,'douyin','外部租户') RETURNING id", [otherTenant]);
    assert.equal((await request(`/${foreign.id}`, {method: 'PATCH', body: {displayName: '不能改'}})).status, 404);
    const before = (await row('SELECT count(*)::int n FROM social_accounts WHERE tenant_id=$1', [tenantId])).n;
    const result = await request('', {method: 'POST', body: {platform: 'douyin', displayName: '平台不支持', registeredPhone: '13900000003', agentId: unsupportedNode.id}});
    assert.equal(result.status, 409);
    assert.equal((await row('SELECT count(*)::int n FROM social_accounts WHERE tenant_id=$1', [tenantId])).n, before);
  });
});
