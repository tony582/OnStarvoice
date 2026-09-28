import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { createApp } from '../../../server/app.js';
import { hashPassword } from '../../../server/services/auth-service.js';
import { persistRecordClassification } from '../../../server/services/ai-labeler.js';
import { CONTENT_TOPIC_LABELS, CONTENT_TOPIC_VERSION } from '../../../server/services/content-topic.js';
import {persistInitializedContentTopic, recordContentTopicInitializationAudit} from '../../../server/services/content-topic-initialization.js';
import { resolveMonitoringIntent, resolveTenantMonitoringScope } from '../../../server/services/monitoring-intent.js';
const ExcelJS = createRequire(new URL('../../../server/package.json', import.meta.url))('exceljs');

test('content topics persist, filter and export independently, with audited manual overrides and tenant isolation', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool(), tenants = [], users = [];
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
  });
  for (let i = 0; i < 2; i++) tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`主题验证 ${randomUUID()}`])).rows[0].id);
  const [tenant, otherTenant] = tenants;
  const getRecord = async id => (await pool.query('SELECT *, ai_labeled_at::text AS classification_version FROM records WHERE id=$1', [id])).rows[0];
  async function insert(topic, tenantId = tenant) {
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,content,record_type,category,content_topic,ai_result,business_visibility)
      VALUES($1::uuid,$2,'xiaohongshu',$1::text,$3,'别克车主内容','keyword_notes','feature_usage',$4,'{"relevance":"relevant"}','eligible')`, [id, tenantId, topic || '历史未分类', topic]);
    return id;
  }
  const ids = {};
  for (const topic of Object.keys(CONTENT_TOPIC_LABELS)) ids[topic] = await insert(topic);
  ids.unclassified = await insert(null);
  await insert('wallpaper', otherTenant);
  await pool.query("INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed_non_monitor')", [tenant, ids.gm_other]);
  const email = `topic-${randomUUID()}@integration.invalid`;
  const user = (await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'主题测试',$2,'active',false,'',false) RETURNING id", [email, hashPassword('topic-test-password')])).rows[0].id;
  users.push(user);
  await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')", [user, tenant]);
  server = await new Promise(resolve => { const instance = createApp({ logger: { log() {}, error() {} } }).listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'topic-test-password' }) });
  assert.equal(login.status, 200);
  const headers = { authorization: `Bearer ${(await login.json()).token}`, 'x-tenant-id': tenant, 'content-type': 'application/json' };
  const request = (path, options = {}) => fetch(`${base}${path}`, { headers, ...options });
  const patch = (id, body) => request(`/records/${id}/manual-fields`, { method: 'PATCH', body: JSON.stringify(body) });
  const label = contentTopic => ({ result: { relevance: 'irrelevant', sentiment: 'negative', intent: 'inquiry', contentTopic, contentTopicReason: '主帖主要对象', category: 'feature_usage' }, provider: 'fixture', model: 'synthetic', intent: resolveMonitoringIntent('安吉星'), tenantScope: resolveTenantMonitoringScope({ brandName: '安吉星' }) });

  await t.test('list and XLSX share the seven topic filters, null filter and existing status filter', async () => {
    for (const topic of [...Object.keys(CONTENT_TOPIC_LABELS), 'unclassified']) {
      const params = new URLSearchParams({ queue: 'triage', contentTopic: topic });
      const response = await request(`/triage/records?${params}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.pagination.total, 1);
      assert.equal(body.records[0].id, ids[topic]);
      assert.equal(body.records[0].content_topic, topic === 'unclassified' ? null : topic);
      const exported = await request(`/triage/records/export?${params}`);
      assert.equal(exported.status, 200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()));
      const sheet = workbook.worksheets[0];
      assert.equal(sheet.rowCount, 2);
      const column = sheet.getRow(1).values.indexOf('内容主题');
      assert.ok(column > 0);
      assert.equal(sheet.getRow(2).getCell(column).value, CONTENT_TOPIC_LABELS[topic] || '主题生成中');
      assert.ok(sheet.getRow(1).values.includes('分类'));
    }
    const selected = await (await request('/triage/records?queue=triage&contentTopic=gm_other&status=reviewed_non_monitor')).json();
    assert.equal(selected.pagination.total, 1);
    assert.equal((await getRecord(ids.gm_other)).category, 'feature_usage');
    for (const route of ['records', 'records/export']) {
      assert.equal((await request(`/triage/${route}?contentTopic=bad`)).status, 400);
      assert.equal((await request(`/triage/${route}?contentTopic=wallpaper&contentTopic=onstar`)).status, 400);
      assert.equal((await request(`/triage/${route}?contentTopic=wallpaper`, { headers: { ...headers, 'x-tenant-id': otherTenant } })).status, 403);
    }
  });
  await t.test('manual topics are audited, protected against later AI and returned by the lightweight verification endpoint', async () => {
    const before = await getRecord(ids.unclassified);
    const response = await patch(before.id, { contentTopic: 'brand_app' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).record.content_topic, 'brand_app');
    const verification = await (await request(`/records/${before.id}/manual-fields`)).json();
    assert.equal(verification.record.content_topic, 'brand_app');
    const outcome = await persistRecordClassification({ record: before, labeled: label('gm_other') });
    assert.ok(outcome);
    const row = await getRecord(before.id);
    assert.equal(row.content_topic, 'brand_app');
    assert.equal(row.ai_result.contentTopic, 'gm_other');
    assert.equal(row.ai_result.classifierMetadata.contentTopicVersion, CONTENT_TOPIC_VERSION);
    assert.equal(row.manual_overrides.content_topic.value, 'brand_app');
    const history = (await pool.query('SELECT changed_fields,after_data FROM record_versions WHERE record_id=$1', [before.id])).rows;
    assert.ok(history.some(item => item.changed_fields.includes('content_topic') && item.after_data.content_topic === 'brand_app'));
    assert.equal((await patch(before.id, { contentTopic: 'not_a_topic' })).status, 400);
    assert.equal((await patch(before.id, { contentTopic: null })).status, 400);
    const cleared = await getRecord(before.id);
    await persistRecordClassification({ record: cleared, labeled: label('onstar') });
    assert.equal((await getRecord(before.id)).content_topic, 'brand_app');
  });
  await t.test('AI writes a topic even outside monitoring, without changing triage state or inventing legacy topics', async () => {
    const source = await getRecord(ids.gm_other);
    await persistRecordClassification({ record: source, labeled: label('gm_other') });
    const row = await getRecord(source.id);
    assert.equal(row.content_topic, 'gm_other');
    assert.equal(row.ai_result.relevance, 'irrelevant');
    assert.equal((await pool.query('SELECT status FROM record_triage WHERE record_id=$1', [source.id])).rows[0].status, 'reviewed_non_monitor');
    const id = await insert(null);
    await persistRecordClassification({ record: await getRecord(id), labeled: label(undefined) });
    assert.equal((await getRecord(id)).content_topic, 'gm_other');
    await assert.rejects(pool.query('UPDATE records SET content_topic=$2 WHERE id=$1', [id, 'invented']), /records_content_topic_check/);
    const snapshot = await getRecord(id);
    await pool.query('UPDATE records SET content=$2 WHERE id=$1', [id, '正文已变更']);
    assert.equal(await persistRecordClassification({ record: snapshot, labeled: label('wallpaper') }), null);
  });
  await t.test('historical initialization only fills a classified topic and preserves manual decisions and concurrent content edits', async () => {
    const id = await insert(null), original = await getRecord(id);
    await pool.query("INSERT INTO record_triage(tenant_id,record_id,status,note) VALUES($1,$2,'reviewed','客户备注保持')", [tenant,id]);
    const db = {queryOne: async(sql,params) => (await pool.query(sql,params)).rows[0]};
    const result = {topic:'wallpaper',reason:'正文主要讨论壁纸',version:CONTENT_TOPIC_VERSION};
    assert.ok(await persistInitializedContentTopic(db,tenant,original,result,'local-test'));
    const saved = await getRecord(id);
    assert.equal(saved.content_topic,'wallpaper');
    for(const field of ['sentiment','category','content','title']) assert.equal(saved[field],original[field]);
    assert.equal(saved.ai_result.relevance,original.ai_result.relevance);
    assert.equal((await pool.query('SELECT status,note FROM record_triage WHERE record_id=$1',[id])).rows[0].note,'客户备注保持');
    assert.equal(await persistInitializedContentTopic(db,tenant,original,result,'retry'),undefined);
    assert.equal(await persistInitializedContentTopic(db,tenant,saved,result,'recheck',{recheckRunId:'wrong-run'}),undefined);
    assert.ok(await persistInitializedContentTopic(db,tenant,saved,{...result,topic:'gm_other'},'recheck',{recheckRunId:'local-test'}));
    assert.equal((await getRecord(id)).content_topic,'gm_other');
    assert.equal(await persistInitializedContentTopic(db,tenant,saved,result,'stale-recheck',{recheckRunId:'local-test'}),undefined);
    const rechecked = await getRecord(id);
    await patch(id,{contentTopic:'brand_app'});
    assert.equal(await persistInitializedContentTopic(db,tenant,rechecked,result,'manual-recheck',{recheckRunId:'recheck'}),undefined);
    const audit = {runId:'local-test',total:1,updated:1,failed:0};
    assert.ok(await recordContentTopicInitializationAudit(db,tenant,audit));
    assert.equal(await recordContentTopicInitializationAudit(db,tenant,audit),undefined);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id=$1 AND action='records.content_topics_initialized' AND metadata->>'runId'='local-test'",[tenant])).rows[0].count,1);
    const manualId=await insert(null), manual=await getRecord(manualId);
    await patch(manualId,{contentTopic:'onstar'});
    assert.equal(await persistInitializedContentTopic(db,tenant,manual,result,'race'),undefined);
    const changedId=await insert(null), changed=await getRecord(changedId);
    await pool.query('UPDATE records SET content=$2 WHERE id=$1',[changedId,'新的正文']);
    assert.equal(await persistInitializedContentTopic(db,tenant,changed,result,'stale'),undefined);
    assert.equal(await persistInitializedContentTopic(db,otherTenant,changed,result,'other-tenant'),undefined);
  });
});
