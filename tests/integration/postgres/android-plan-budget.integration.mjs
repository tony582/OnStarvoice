import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

// Exercise the actual admin create / dispatch / edit routes, not manually
// inserted plan snapshots. All fixtures and the HTTP server are local only.
test('a phone schedule keeps its five minute limit through create, edit, scheduling and claim', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {createApp} = await import('../../../server/app.js');
  const {createAndroidControlService} = await import('../../../server/services/android-control/service.js');
  const {runCaptureOrchestrationScheduleNow} = await import('../../../server/services/capture-orchestration-scheduler.js');
  const {hashPassword} = await import('../../../server/services/auth-service.js');
  await runMigrations();
  const pool = getPool();
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const [tenant] = await query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`android-budget-${randomUUID()}`]);
  let server;
  let userId;
  t.after(async () => {
    if (server) await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
    try {
      await query('DELETE FROM capture_task_item_attempts WHERE tenant_id=$1', [tenant.id]);
      await query('DELETE FROM capture_task_items WHERE tenant_id=$1', [tenant.id]);
      await query('DELETE FROM capture_agent_commands WHERE tenant_id=$1', [tenant.id]);
      await query('DELETE FROM capture_tasks WHERE tenant_id=$1', [tenant.id]);
      await query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
      if (userId) await query('DELETE FROM users WHERE id=$1', [userId]);
    } finally {
      await closePool();
    }
  });

  const code = randomUUID();
  await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,4)', [tenant.id, code]);
  const android = createAndroidControlService({enabledTenants: () => new Set([tenant.id])});
  const registration = {code, clientUuid: randomUUID(), deviceId: `test-${randomUUID()}`};
  const registered = await android.register(registration);
  const [phone] = await query('SELECT * FROM capture_agents WHERE id=$1', [registered.agent.id]);
  const principal = {
    tenantId: tenant.id, agentId: phone.id,
    authCodeId: phone.auth_code_id, authBindingId: phone.auth_binding_id,
  };
  const pollInput = {
    sessionId: randomUUID(), deviceId: registration.deviceId,
    readyForSearch: true, platforms: ['wechat_channels'], features: ['wechat_search_filters'],
  };
  assert.equal((await android.poll(principal, pollInput)).task, null);

  const email = `android-budget-${randomUUID()}@example.invalid`;
  const password = 'local-test-only';
  const [user] = await query(`INSERT INTO users(email,name,password_hash,status,must_change_password)
    VALUES($1,'Budget test',$2,'active',false) RETURNING id`, [email, hashPassword(password)]);
  userId = user.id;
  await query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_admin','active')", [user.id, tenant.id]);
  server = await new Promise((resolve, reject) => {
    const srv = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
    srv.once('listening', () => resolve(srv));
    srv.once('error', reject);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password}),
  });
  assert.equal(login.status, 200);
  const {token} = await login.json();
  const request = async (method, path, input) => {
    const response = await fetch(`${origin}/api/capture-cloud${path}`, {
      method, headers: {'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-tenant-id': tenant.id},
      body: JSON.stringify(input),
    });
    const body = await response.json();
    assert.ok([200, 201].includes(response.status), `${method} ${path}: ${JSON.stringify(body)}`);
    return body;
  };
  const plan = {
    requestKey: randomUUID(), title: '五分钟手机计划', platform: 'wechat_channels',
    executionMode: 'unattended_plan', distributionMode: 'fixed_batch', agentIds: [phone.id],
    keywords: ['安吉星续费', '安吉星车机'], mode: 'daily', startTime: '20:30',
    searchFilters: {sort: 'latest', publishTime: 'day'}, mobileKeywordMaxMinutes: 5,
  };
  const created = await request('POST', '/orchestrations', plan);
  assert.equal(created.orchestration.metadata.planSnapshot.mobileKeywordMaxMinutes, 5);
  const parentId = created.orchestration.id;
  const [storedDraft] = await query('SELECT metadata FROM capture_tasks WHERE id=$1 AND tenant_id=$2', [parentId, tenant.id]);
  assert.equal(storedDraft.metadata.planSnapshot.mobileKeywordMaxMinutes, 5);
  const originalRequestHash = storedDraft.metadata.orchestrationRequestHash;
  const repeated = await request('POST', '/orchestrations', plan);
  assert.equal(repeated.existing, true, 'identical create remains idempotent');
  const dispatched = await request('POST', `/orchestrations/${parentId}/dispatch`, {
    expectedRevision: 0, assignments: created.items.map(item => ({itemId: item.id, agentId: phone.id})),
  });
  const scheduleId = dispatched.schedule.id;
  const [storedSchedule] = await query('SELECT plan_snapshot FROM capture_orchestration_schedules WHERE id=$1 AND tenant_id=$2', [scheduleId, tenant.id]);
  assert.equal(storedSchedule.plan_snapshot.mobileKeywordMaxMinutes, 5, 'activation persists the created time limit');

  let revision = 1;
  // Change away from five, then save five again so this checks an actual edit,
  // not just preservation of the creation value or a manually seeded snapshot.
  for (const minutes of [9, 5]) {
    const edited = await request('PATCH', `/orchestrations/${parentId}/schedule`, {
      ...plan, expectedRevision: revision, mobileKeywordMaxMinutes: minutes,
    });
    revision += 1;
    assert.equal(edited.revision, revision);
    assert.equal(edited.schedule.plan_snapshot.mobileKeywordMaxMinutes, minutes);
    const [stored] = await query(`SELECT s.plan_snapshot,t.metadata
      FROM capture_orchestration_schedules s JOIN capture_tasks t ON t.id=s.template_task_id AND t.tenant_id=s.tenant_id
      WHERE s.id=$1 AND s.tenant_id=$2`, [scheduleId, tenant.id]);
    assert.equal(stored.plan_snapshot.mobileKeywordMaxMinutes, minutes);
    assert.equal(stored.metadata.planSnapshot.mobileKeywordMaxMinutes, minutes);
    assert.equal(stored.metadata.orchestrationRequestHash, originalRequestHash, 'edit preserves the creation idempotency hash');
  }

  const run = await runCaptureOrchestrationScheduleNow({tenantId: tenant.id, scheduleId, requestKey: randomUUID()});
  assert.equal(run.kind, 'created', JSON.stringify(run));
  const [child] = await query(`SELECT * FROM capture_tasks WHERE tenant_id=$1 AND parent_task_id=$2
    AND metadata->>'workflow'='wechat_channels_mobile_capture'`, [tenant.id, run.runTaskId]);
  assert.ok(child, 'edited schedule materializes its phone child');
  assert.equal(child.metadata.budgets.keywordMs, 300_000);
  assert.equal(child.metadata.budgets.batchMs, 900_000, 'two five minute keywords plus five minute batch tail');
  const claim = await android.poll(principal, pollInput);
  assert.ok(claim.task, 'phone claims the scheduled keyword');
  assert.equal(claim.task.identity.taskId, child.id);
  assert.equal(claim.task.budgets.keywordMs, 300_000);
  assert.equal(claim.task.budgets.batchMs, 900_000);
});
