import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

const DAY = 24 * 60 * 60 * 1000;
const KEYWORD = '集成测试品牌';
const CAPABILITIES = {
  remoteTaskCreate: true, remoteTaskKeywordPostLimit: true,
  remoteTaskEnhancementOptions: true, singleRelayV1: true,
  remoteSequentialSearchPassesV1: true, remoteTargetedPostCaptureV1: true,
  negativePostPatrol: true, negativePatrolTerminalReceiptV1: true,
  watchedContentPatrol: true, remoteStop: true, taskStateKnown: true,
  supportedPlatforms: ['douyin', 'xiaohongshu'],
};

// The 1000-unit cut in both patrol paths lands between the halves of the emoji:
// units 0-998 are CJK, the emoji is units 999-1000.
const SPLIT_CONTENT = `${'甲'.repeat(999)}😀${'乙'.repeat(20)}`;
const SPLIT_EXPECTED = '甲'.repeat(999);
// Control: the whole emoji ends at unit 999, so a plain cut at 1000 is already clean.
const WHOLE_CONTENT = `${'甲'.repeat(997)}😀${'乙'.repeat(20)}`;
const WHOLE_EXPECTED = `${'甲'.repeat(997)}😀乙`;

const loneSurrogate = value => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

test('negative patrol dispatch keeps a post whose content is cut through an emoji out of a jsonb failure', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);

  async function fixture(st) {
    const tenant = (await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [`Patrol well-formed ${randomUUID()}`])).rows[0];
    st.after(async () => {
      await pool.query('DELETE FROM capture_orchestration_schedule_agents WHERE tenant_id=$1', [tenant.id]);
      await pool.query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    });
    const code = (await pool.query(`INSERT INTO auth_codes (tenant_id, code, status, expires_at)
      VALUES ($1, $2, 'active', now()+interval '1 day') RETURNING id`,
    [tenant.id, `WELLFORMED-${randomUUID()}`])).rows[0];
    const binding = (await pool.query('INSERT INTO auth_bindings (code_id,fingerprint) VALUES ($1,$2) RETURNING id',
      [code.id, randomUUID()])).rows[0];
    const agent = (await pool.query(`INSERT INTO capture_agents (
      tenant_id,client_uuid,display_name,browser_name,app_version,allowed_platforms,status,
      auth_code_id,auth_binding_id,capabilities,last_heartbeat_at,last_full_heartbeat_at,last_liveness_at
    ) VALUES ($1,$2,'Well-formed node','Chrome','0.4.7',ARRAY['douyin','xiaohongshu'],'active',$3,$4,$5,now(),now(),now()) RETURNING *`,
    [tenant.id, randomUUID(), code.id, binding.id, JSON.stringify(CAPABILITIES)])).rows[0];
    await pool.query(`INSERT INTO capture_agent_tokens (agent_id,auth_code_id,auth_binding_id,token_hash)
      VALUES ($1,$2,$3,$4)`, [agent.id, code.id, binding.id, createHash('sha256').update(randomUUID()).digest('hex')]);
    async function record(label, content, {createdAt, publishedAt} = {}) {
      return (await pool.query(`INSERT INTO records (
        tenant_id,external_id,platform,title,content,keyword,sentiment,publish_time,published_ts,
        created_at,business_visibility
      ) VALUES ($1,$2,'douyin',$3,$4,$5,'negative',$6,$7,$8,'eligible') RETURNING *`,
      [tenant.id, `${7100000000000000000n + BigInt(Math.floor(Math.random() * 1e9))}`, label, content, KEYWORD,
        publishedAt.slice(0, 10), publishedAt, createdAt])).rows[0];
    }
    const user = await (async () => {
      const {hashPassword} = await import('../../../server/services/auth-service.js');
      const password = 'well-formed-integration-only';
      const email = `well-formed-${randomUUID()}@integration.invalid`;
      const row = (await pool.query(`INSERT INTO users (email,name,password_hash,status,must_change_password)
        VALUES ($1,'Patrol test user',$2,'active',false) RETURNING id`, [email, hashPassword(password)])).rows[0];
      st.after(() => pool.query('DELETE FROM users WHERE id=$1', [row.id]));
      await pool.query("INSERT INTO user_memberships (user_id,tenant_id,role,status) VALUES ($1,$2,'tenant_admin','active')", [row.id, tenant.id]);
      return {email, password};
    })();
    const {createApp} = await import('../../../server/app.js');
    const server = await new Promise((resolve, reject) => {
      const listening = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
      listening.once('error', reject);
      listening.once('listening', () => resolve(listening));
    });
    st.after(() => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const loginResponse = await fetch(`${origin}/api/auth/login`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify(user)});
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    const headers = {'content-type': 'application/json', authorization: `Bearer ${login.token}`, 'x-tenant-id': tenant.id};
    const http = {
      async post(path, body) {
        const response = await fetch(`${origin}${path}`, {method: 'POST', headers, body: JSON.stringify(body)});
        return {status: response.status, body: await response.json()};
      },
    };
    return {tenant, agent, record, http};
  }

  async function itemContents(taskId) {
    return (await pool.query(`SELECT record_id, metadata FROM capture_task_items
      WHERE task_id=$1 ORDER BY ordinal`, [taskId])).rows
      .map(row => ({recordId: row.record_id, content: row.metadata.sourceRecord.content}));
  }

  await t.test('manual dispatch: whole batch inserts when one candidate straddles the 1000-unit cut (jsonb_to_recordset)', async st => {
    const f = await fixture(st);
    const created = new Date(Date.now() - 3 * DAY).toISOString();
    const published = '2026-09-07T04:00:00.000Z';
    const whole = await f.record('whole emoji', WHOLE_CONTENT, {createdAt: created, publishedAt: published});
    const split = await f.record('split emoji', SPLIT_CONTENT, {createdAt: created, publishedAt: published});
    const plain = await f.record('plain', '普通内容', {createdAt: created, publishedAt: published});
    const dispatch = recordIds => f.http.post('/api/capture-cloud/negative-patrol/tasks', {
      publishDateFrom: '2026-09-07', publishDateTo: '2026-09-07', platform: 'douyin',
      recordIds, agentIds: [f.agent.id], distributionMode: 'elastic_pool', requestKey: randomUUID(),
    });

    // Control: the same route and fixture accept a whole emoji and plain text, so a
    // failure in the next request can only come from the cut.
    const control = await dispatch([whole.id, plain.id]);
    assert.equal(control.status, 201, JSON.stringify(control.body));
    const controlContents = new Map((await itemContents(control.body.taskId))
      .map(item => [item.recordId, item.content]));
    assert.equal(controlContents.get(whole.id), WHOLE_EXPECTED);
    assert.equal(controlContents.get(plain.id), '普通内容');

    const response = await dispatch([split.id, whole.id, plain.id]);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const contents = await itemContents(response.body.taskId);
    assert.equal(contents.length, 3, 'one candidate must not take the other two down with it');
    const byRecord = new Map(contents.map(item => [item.recordId, item.content]));
    assert.equal(byRecord.get(split.id), SPLIT_EXPECTED,
      'the emoji that a cut would split is dropped whole, not left half-written');
    assert.equal(byRecord.get(whole.id), WHOLE_EXPECTED);
    assert.equal(byRecord.get(plain.id), '普通内容');
    for (const item of contents) assert.equal(loneSurrogate(item.content), false);
  });

  async function runNowWithRecord(f, label, content) {
    const created = new Date(Date.now() - DAY).toISOString();
    const source = await f.record(label, content, {createdAt: created, publishedAt: created});
    const template = (await pool.query(`INSERT INTO capture_tasks (
      tenant_id,client_task_id,task_type,feature_key,platform,status,title,metadata,counts
    ) VALUES ($1,$2,'capture_orchestration','keyword_orchestration','douyin','pending','Well-formed patrol fixture',$3,'{"total":0}') RETURNING *`,
    [f.tenant.id, randomUUID(), JSON.stringify({distributionMode: 'elastic_pool',
      eligibleAgentIds: [f.agent.id], orchestrationTemplate: true, executionMode: 'unattended_plan',
      planSnapshot: {platform: 'douyin', keywords: [KEYWORD], keywordMaxDetectedItems: 2, maxRounds: 1,
        negativePatrol: {enabled: true, lookbackDays: 7}}})])).rows[0];
    await pool.query(`INSERT INTO capture_task_items (tenant_id,task_id,item_key,item_type,keyword,ordinal,platform,
      external_id,url_snapshot,status,metadata) VALUES ($1,$2,$3,'keyword',$4,0,'douyin','','','pending','{}')`,
    [f.tenant.id, template.id, `keyword:0:${KEYWORD}`, KEYWORD]);
    const schedule = (await pool.query(`INSERT INTO capture_orchestration_schedules (
      tenant_id,template_task_id,title,platform,status,schedule_mode,timezone,start_time,
      plan_snapshot,distribution_mode,next_run_at
    ) VALUES ($1,$2,'Well-formed patrol plan','douyin','active','daily','Asia/Shanghai','09:00',$3,'elastic_pool',now()+interval '1 day') RETURNING *`,
    [f.tenant.id, template.id, {platform: 'douyin', keywords: [KEYWORD], maxRounds: 1,
      keywordMaxDetectedItems: 2, negativePatrol: {enabled: true, lookbackDays: 7}}])).rows[0];
    await pool.query('UPDATE capture_tasks SET orchestration_schedule_id=$2 WHERE id=$1', [template.id, schedule.id]);
    await pool.query(`INSERT INTO capture_orchestration_schedule_agents
      (schedule_id,tenant_id,agent_id,ordinal) VALUES ($1,$2,$3,0)`, [schedule.id, f.tenant.id, f.agent.id]);
    const run = await f.http.post(`/api/capture-cloud/orchestrations/${template.id}/schedule/run-now`,
      {requestKey: randomUUID()});
    return {source, run};
  }

  await t.test('unattended run-now control: a whole emoji inside the 1000-unit limit is queued unchanged', async st => {
    const f = await fixture(st);
    const {source, run} = await runNowWithRecord(f, 'whole emoji patrol', WHOLE_CONTENT);
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const items = (await pool.query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal',
      [run.body.runTaskId])).rows;
    assert.deepEqual(items.map(item => item.item_type), ['keyword', 'negative_post']);
    assert.equal(items[1].record_id, source.id);
    assert.equal(items[1].metadata.sourceRecord.content, WHOLE_EXPECTED);
  });

  await t.test('unattended run-now: a negative post whose content straddles the cut is queued (::jsonb metadata)', async st => {
    const f = await fixture(st);
    const {source, run} = await runNowWithRecord(f, 'split emoji patrol', SPLIT_CONTENT);
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const items = (await pool.query('SELECT * FROM capture_task_items WHERE task_id=$1 ORDER BY ordinal',
      [run.body.runTaskId])).rows;
    assert.deepEqual(items.map(item => item.item_type), ['keyword', 'negative_post']);
    assert.equal(items[1].record_id, source.id);
    assert.equal(items[1].metadata.sourceRecord.content, SPLIT_EXPECTED);
    assert.equal(loneSurrogate(items[1].metadata.sourceRecord.content), false);
  });
});
