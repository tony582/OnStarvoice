import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

const capabilities = {remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, taskStateKnown: true, supportedPlatforms: ['douyin', 'xiaohongshu']};
const keywords = ['别克壁纸', '月兔栖梦'];

test('per-account keyword coverage persists through HTTP, dispatch, receipts and schedules', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {dispatchNextElasticWorkItem, mirrorTaskSnapshot} = await import('../../../server/routes/capture-cloud.js');
  const {normalizeCloudTaskSnapshot} = await import('../../../server/services/capture-cloud.js');
  const {createApp} = await import('../../../server/app.js');
  const {hashPassword} = await import('../../../server/services/auth-service.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);

  async function fixture(st, platform = 'douyin') {
    const tenant = (await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [`Keyword coverage ${randomUUID()}`])).rows[0];
    st.after(() => pool.query('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    const code = (await pool.query(`INSERT INTO auth_codes (tenant_id,code,status,expires_at)
      VALUES ($1,$2,'active',now()+interval '1 day') RETURNING id`, [tenant.id, randomUUID()])).rows[0];
    const agents = [];
    for (let index = 0; index < 3; index++) {
      const binding = (await pool.query('INSERT INTO auth_bindings (code_id,fingerprint) VALUES ($1,$2) RETURNING id',
        [code.id, randomUUID()])).rows[0];
      const agent = (await pool.query(`INSERT INTO capture_agents (tenant_id,client_uuid,display_name,
        browser_name,app_version,allowed_platforms,status,auth_code_id,auth_binding_id,capabilities,
        last_heartbeat_at,last_full_heartbeat_at,last_liveness_at)
        VALUES ($1,$2,$3,'Chrome','0.4.10',ARRAY['douyin','xiaohongshu'],'active',$4,$5,$6,now(),now(),now()) RETURNING *`,
      [tenant.id, randomUUID(), `Coverage node ${index}`, code.id, binding.id, JSON.stringify(capabilities)])).rows[0];
      agents.push(agent);
      await pool.query(`INSERT INTO capture_agent_tokens (agent_id,auth_code_id,auth_binding_id,token_hash)
        VALUES ($1,$2,$3,$4)`, [agent.id, code.id, binding.id, createHash('sha256').update(randomUUID()).digest('hex')]);
      await pool.query(`INSERT INTO social_agent_daily_usage (tenant_id,agent_id,platform,usage_date,searches,failed_events,safety_verifications)
        VALUES ($1,$2,$3,(now() AT TIME ZONE 'Asia/Shanghai')::date,0,0,0)`, [tenant.id, agent.id, platform]);
    }
    const email = `coverage-${randomUUID()}@integration.invalid`;
    const password = 'coverage-integration-only';
    const user = (await pool.query(`INSERT INTO users (email,name,password_hash,status,must_change_password)
      VALUES ($1,'Coverage tester',$2,'active',false) RETURNING id`, [email, hashPassword(password)])).rows[0];
    st.after(() => pool.query('DELETE FROM users WHERE id=$1', [user.id]));
    await pool.query("INSERT INTO user_memberships (user_id,tenant_id,role,status) VALUES ($1,$2,'tenant_admin','active')", [user.id, tenant.id]);
    const server = await new Promise((resolve, reject) => {
      const listening = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
      listening.once('error', reject);
      listening.once('listening', () => resolve(listening));
    });
    st.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const loginResponse = await fetch(`${origin}/api/auth/login`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password})});
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    async function request(path, body, method = 'POST') {
      const response = await fetch(`${origin}/api/capture-cloud/orchestrations${path}`, {method,
        headers: {'content-type': 'application/json', authorization: `Bearer ${login.token}`, 'x-tenant-id': tenant.id},
        body: JSON.stringify(body)});
      return {status: response.status, body: await response.json()};
    }
    const row = async (table, id) => (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
    const items = async id => (await pool.query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal', [id])).rows;
    const agentIds = agents.slice(0, 2).map(agent => agent.id);
    const plan = {requestKey: randomUUID(), title: '壁纸逐账号采集', platform,
      executionMode: 'one_time', distributionMode: 'elastic_pool', keywordCoverage: 'each_agent',
      agentIds, keywords, keywordMaxDetectedItems: 5, searchFilters: {publishTime: 'day'}};
    async function publish(input = plan) {
      const created = await request('', input);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.orchestration.id;
      const preview = await request(`/${id}/allocation-preview`, {agentIds: input.agentIds});
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      const assignments = preview.body.groups.flatMap(group => group.itemIds.map(itemId => ({itemId, agentId: group.agentId})));
      const body = {expectedRevision: 0, eligibleAgentIds: input.agentIds, assignments};
      const dispatched = await request(`/${id}/dispatch`, body);
      assert.equal(dispatched.status, 201, JSON.stringify(dispatched.body));
      return {id, created, preview, body, dispatched};
    }
    const claim = async index => withTransaction(tx => dispatchNextElasticWorkItem(tx, {agent: agents[index], capabilities}));
    async function complete(claimed, {status = 'completed', errorCode = ''} = {}) {
      assert.ok(claimed?.commandId, JSON.stringify(claimed));
      const command = await row('capture_agent_commands', claimed.commandId);
      const child = await row('capture_tasks', claimed.childTaskId);
      const keyword = command.payload.planSnapshot.keywords[0];
      const now = new Date().toISOString();
      const snapshot = normalizeCloudTaskSnapshot({id: child.client_task_id, controlTaskId: child.id,
        attemptId: command.payload.attemptIdentity, attemptNumber: 1, status, platform,
        taskType: 'unattended_keyword_capture', featureKey: 'unattended_keyword_plan', source: 'cloud',
        title: child.title, createdAt: child.created_at.toISOString(), updatedAt: now, startedAt: now,
        finishedAt: now, heartbeatAt: now, progressSeq: 1, progress: {keyword, roundCurrent: 1},
        counts: {success: status === 'completed' ? 1 : 0, total: 1}, checkpoint: {round: 1, activeKeyword: keyword,
          keywordResults: [{keyword, round: 1, status, errorCode, savedCount: 0, attemptCount: 1, finishedAt: now}]},
        error: errorCode ? {code: errorCode, message: 'Fixture search failure'} : {},
        metadata: {planSnapshot: command.payload.planSnapshot}});
      await withTransaction(tx => mirrorTaskSnapshot(tx, agents.find(agent => agent.id === command.agent_id), snapshot));
      await pool.query("UPDATE capture_agent_commands SET admitted_at=now()-interval '11 seconds' WHERE id=$1", [command.id]);
      return keyword;
    }
    return {tenant, agents, agentIds, plan, request, row, items, publish, claim, complete};
  }

  await t.test('every selected account really searches every keyword; the fastest account cannot finish for others', async st => {
    const f = await fixture(st);
    const published = await f.publish();
    assert.equal(published.created.body.items.length, 4);
    assert.deepEqual(published.preview.body.groups.map(group => group.keywords), [keywords, keywords]);
    assert.equal((await f.request('', f.plan)).status, 200, 'create replay does not multiply work');
    assert.equal((await f.request(`/${published.id}/dispatch`, published.body)).status, 200);
    const wrongAssignment = structuredClone(published.body);
    wrongAssignment.assignments[0].agentId = f.agentIds[1];
    assert.equal((await f.request(`/${published.id}/dispatch`, wrongAssignment)).status, 409, 'replay validates each pin');
    assert.equal(await f.claim(2), null, 'an unselected account cannot claim');
    for (const expected of keywords) assert.equal(await f.complete(await f.claim(0)), expected);
    assert.equal(await f.claim(0), null, 'fast account cannot take the second account\'s keywords');
    assert.notEqual((await f.row('capture_tasks', published.id)).status, 'completed');
    const half = await f.items(published.id);
    assert.equal(half.filter(item => item.status === 'completed').length, 2);
    assert.equal(half.filter(item => item.status === 'pending' && item.metadata.pinnedAgentId === f.agentIds[1]).length, 2);
    for (const expected of keywords) assert.equal(await f.complete(await f.claim(1)), expected);
    assert.equal((await f.row('capture_tasks', published.id)).status, 'completed');
    assert.equal(await f.claim(1), null);
  });

  await t.test('preview rejects changing the account pool without recreating the matrix', async st => {
    const f = await fixture(st);
    const created = await f.request('', f.plan);
    assert.equal(created.status, 201);
    const rejected = await f.request(`/${f.plan.requestKey}/allocation-preview`, {agentIds: [f.agentIds[0]]});
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'keyword_coverage_changed');
  });

  await t.test('failure on one account cannot be counted as covered by another account', async st => {
    const f = await fixture(st);
    const published = await f.publish();
    const failed = await f.claim(0);
    await f.complete(failed, {status: 'failed', errorCode: 'stale_unattended_attempt'});
    const item = await f.row('capture_task_items', failed.itemId);
    assert.equal(item.metadata.pinnedAgentId, f.agentIds[0]);
    assert.notEqual(item.status, 'completed');
    for (const expected of keywords) assert.equal(await f.complete(await f.claim(1)), expected);
    assert.equal(await f.claim(1), null, 'peer cannot take fresh or retryable work pinned to another account');
    assert.notEqual((await f.row('capture_tasks', published.id)).status, 'completed');
  });

  await t.test('editing and scheduled runs preserve unique pairs and node pins', async st => {
    const f = await fixture(st);
    const input = {...f.plan, executionMode: 'unattended_plan', schedule: {mode: 'daily', startTime: '05:30'}};
    const published = await f.publish(input);
    const oldItems = await f.items(published.id);
    const edit = {...input, expectedRevision: 1, keywords: [keywords[1], keywords[0], '檐下秋意'], agentIds: [...f.agentIds].reverse()};
    const edited = await f.request(`/${published.id}/schedule`, edit, 'PATCH');
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.itemCount, 6);
    const templateItems = await f.items(published.id);
    assert.equal(templateItems.length, 6);
    for (const before of oldItems) {
      const after = templateItems.find(item => item.keyword === before.keyword && item.metadata.pinnedAgentId === before.metadata.pinnedAgentId);
      assert.equal(after.id, before.id, 'reordering preserves each account/keyword identity');
    }
    const runBody = {requestKey: randomUUID()};
    const started = await f.request(`/${published.id}/schedule/run-now`, runBody);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const runItems = await f.items(started.body.runTaskId);
    assert.equal(runItems.length, 6);
    assert.deepEqual(runItems.map(item => [item.keyword, item.metadata.pinnedAgentId]), templateItems.map(item => [item.keyword, item.metadata.pinnedAgentId]));
    assert.equal((await f.request(`/${published.id}/schedule/run-now`, runBody)).body.runTaskId, started.body.runTaskId);
    const claimed = await f.claim(0);
    assert.equal((await f.row('capture_task_items', claimed.itemId)).metadata.pinnedAgentId, f.agentIds[0]);
    assert.equal((await f.row('capture_agent_commands', claimed.commandId)).payload.planSnapshot.recoveryPolicy.allowIdleAgentHandoff, false);
    // Editing future templates does not alter the already materialized run.
    const shared = await f.request(`/${published.id}/schedule`, {...edit, expectedRevision: 2, keywordCoverage: 'shared'}, 'PATCH');
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal((await f.items(published.id)).length, 3);
    assert.equal((await f.items(started.body.runTaskId)).length, 6);
  });

  for (const platform of ['douyin', 'xiaohongshu']) {
    await t.test(`${platform}: only selected words repeat and shared work can be claimed by either node`, async st => {
      const f = await fixture(st, platform);
      const input = {...f.plan, eachAgentKeywords: [keywords[0]], keywords: [...keywords, '安吉星壁纸']};
      const published = await f.publish(input);
      assert.equal(published.created.body.items.length, 4);
      assert.deepEqual(published.created.body.orchestration.metadata.planSnapshot.eachAgentKeywords, [keywords[0]]);
      assert.deepEqual(published.preview.body.groups.map(group => group.keywords),
        [[keywords[0], keywords[1]], [keywords[0], '安吉星壁纸']]);
      // Either idle node may take the shared work, even when preview balanced it to its peer.
      assert.equal(await f.claim(2), null);
      for (let index = 0; index < 3; index++) {
        const claimed = await f.claim(1);
        const item = await f.row('capture_task_items', claimed.itemId);
        const command = await f.row('capture_agent_commands', claimed.commandId);
        assert.equal(command.payload.planSnapshot.platform, platform);
        assert.equal(command.payload.planSnapshot.recoveryPolicy.allowIdleAgentHandoff,
          item.metadata.pinnedAgentId ? false : true);
        await f.complete(claimed);
      }
      assert.equal(await f.claim(1), null, 'node cannot consume a selected word pinned to its peer');
      assert.notEqual((await f.row('capture_tasks', published.id)).status, 'completed');
      const remaining = (await f.items(published.id)).filter(item => item.status === 'pending');
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].metadata.pinnedAgentId, f.agentIds[0]);
      assert.equal(await f.complete(await f.claim(0)), keywords[0]);
      assert.equal((await f.row('capture_tasks', published.id)).status, 'completed');
    });

    await t.test(`${platform}: editing and materialization preserve a mixed selection without changing old runs`, async st => {
      const f = await fixture(st, platform);
      const input = {...f.plan, executionMode: 'unattended_plan', eachAgentKeywords: [keywords[0]],
        schedule: {mode: 'daily', startTime: '05:30'}};
      const published = await f.publish(input);
      const originalItems = await f.items(published.id);
      assert.equal(originalItems.length, 3);
      const edit = {...input, expectedRevision: 1, eachAgentKeywords: [keywords[1]], keywords: [...keywords, '檐下秋意']};
      const saved = await f.request(`/${published.id}/schedule`, edit, 'PATCH');
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.itemCount, 4);
      const parent = await f.row('capture_tasks', published.id);
      assert.deepEqual(parent.metadata.planSnapshot.eachAgentKeywords, [keywords[1]]);
      const run = await f.request(`/${published.id}/schedule/run-now`, {requestKey: randomUUID()});
      assert.equal(run.status, 201, JSON.stringify(run.body));
      const runItems = await f.items(run.body.runTaskId);
      assert.equal(runItems.length, 4);
      assert.equal(runItems.filter(item => item.metadata.pinnedAgentId).length, 2);
      assert.ok(runItems.filter(item => item.metadata.pinnedAgentId).every(item => item.keyword === keywords[1]));
      // Omitted selection on a schedule-only patch preserves the saved subset.
      const {eachAgentKeywords: omitted, ...scheduleOnly} = edit;
      const preserved = await f.request(`/${published.id}/schedule`, {...scheduleOnly, expectedRevision: 2}, 'PATCH');
      assert.equal(preserved.status, 200, JSON.stringify(preserved.body));
      assert.deepEqual((await f.row('capture_tasks', published.id)).metadata.planSnapshot.eachAgentKeywords, [keywords[1]]);
      const shared = await f.request(`/${published.id}/schedule`, {...edit, expectedRevision: 3,
        keywordCoverage: 'shared', eachAgentKeywords: []}, 'PATCH');
      assert.equal(shared.status, 200, JSON.stringify(shared.body));
      assert.equal((await f.items(published.id)).length, 3);
      assert.equal((await f.items(run.body.runTaskId)).length, 4);
      assert.equal((await f.items(run.body.runTaskId)).filter(item => item.metadata.pinnedAgentId).length, 2);
    });
  }

  await t.test('default shared collection still creates one work item per unique keyword', async st => {
    const f = await fixture(st);
    const created = await f.request('', {...f.plan, keywordCoverage: 'shared', keywords: [...keywords, keywords[0]]});
    assert.equal(created.status, 201);
    assert.equal(created.body.items.length, 2);
    assert.ok(created.body.items.every(item => !item.metadata.pinnedAgentId));
    const invalid = await f.request('', {...f.plan, requestKey: randomUUID(), distributionMode: 'fixed_batch'});
    assert.equal(invalid.status, 400);
  });
});
