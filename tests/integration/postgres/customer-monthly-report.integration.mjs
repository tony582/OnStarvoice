import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {createCustomerMonthlyReportService} from '../../../server/services/customer-monthly-reports.js';

test('September monthly report counts triage posts by publish time, freezes detail per version, exports and mails the saved version', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool(), tenants = [], users = [];
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
  });
  for (const name of ['月报回归客户', '其他客户']) tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [name])).rows[0].id);
  const tenant = tenants[0];
  const at = (day, hour = 9, month = '09') => `2026-${month}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`;
  async function record({published = at(5), created = at(6), status = 'reviewed', sentiment = 'neutral', archived = false, visibility = 'eligible', relevance = 'relevant',
    keyword = '安吉星', overrides = {}, owner = tenant, type = 'single_note', topic = 'onstar', platform = 'xiaohongshu', title = '回归原帖', metrics = {}, watched = false} = {}) {
    const id = randomUUID();
    const {likes = 10, comments = 2, collects = 1, shares = 0} = metrics;
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,url,author_name,record_type,sentiment,created_at,first_seen_at,published_ts,business_visibility,ai_result,keyword,manual_overrides,content_topic,likes,comments_count,collects,shares)
      VALUES($1::uuid,$2,$3,$1::text,$4,$5,'回归作者',$6,$7,$8,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17,$18)`,
    [id, owner, platform, title, `https://www.xiaohongshu.com/explore/${id}`, type, sentiment, created, published, visibility, JSON.stringify({relevance}), keyword, JSON.stringify(overrides), topic, likes, comments, collects, shares]);
    await pool.query('INSERT INTO record_triage(tenant_id,record_id,status,archived_at,feishu_table_no) VALUES($1,$2,$3,$4,$5)', [owner, id, status, archived ? at(20) : null, status === 'negative_feishu' ? '26090901' : '']);
    if (watched) await pool.query('INSERT INTO record_watchlist(tenant_id,record_id) VALUES($1,$2)', [owner, id]);
    return id;
  }
  const positive = await record({sentiment: 'positive', published: at(1, 0)});
  const neutralLate = await record({published: at(30, 23), created: at(2, 9, '10'), topic: 'gm_other', platform: 'douyin'});
  const hot = await record({sentiment: 'negative', status: 'negative_cold', topic: 'infotainment', metrics: {likes: 400, comments: 30, collects: 5, shares: 2}, title: '车机黑屏'});
  const feishu = await record({sentiment: 'negative', status: 'negative_feishu', topic: 'wallpaper', metrics: {likes: 150, comments: 60, collects: 0, shares: 0}, title: '壁纸丢失'});
  const comment = await record({sentiment: 'negative', status: 'negative_comment', topic: null, metrics: {likes: 1}});
  const nonMonitor = await record({sentiment: 'negative', status: 'reviewed_non_monitor', metrics: {likes: 999, comments: 999, collects: 999, shares: 999}});
  const watched = await record({relevance: 'irrelevant', watched: true, topic: 'brand_app'});
  const admitted = await record({relevance: 'uncertain', keyword: '别克哨兵', overrides: {relevance: 'relevant'}, topic: 'sentry'});
  const unhandled = await record({status: 'unhandled', sentiment: 'negative', topic: 'gm_customer_service', metrics: {likes: 250}});
  const excluded = [];
  for (const options of [{archived: true}, {visibility: 'filtered_out'}, {relevance: 'irrelevant'}, {keyword: '别克哨兵', relevance: 'uncertain'},
    {overrides: {relevance: 'irrelevant'}}, {type: 'blogger_profile'}, {type: 'official_content'}, {published: at(31, 23, '08')}, {published: at(1, 0, '10')},
    {owner: tenants[1]}]) excluded.push(await record(options));
  const missingPublished = await record({published: null, created: at(12)});
  excluded.push(missingPublished);
  await pool.query(`INSERT INTO customer_daily_report_settings(tenant_id,config) VALUES($1,$2::jsonb)`, [tenant, JSON.stringify({emailRecipients: 'customer@example.test, lead@example.test'})]);
  const sent = [];
  const service = createCustomerMonthlyReportService({now: () => new Date(at(8, 11, '10')),
    emailOptions: {readiness: async () => ({ready: true}), send: async message => { sent.push(message); return {accepted: ['customer@example.test', 'lead@example.test'], rejected: [], messageId: 'smtp-monthly'}; }}});
  const generated = await service.generate(tenant, {month: '2026-09'});
  assert.equal(generated.version, 1);
  assert.equal(generated.mode, 'formal');
  assert.equal(generated.reportMonth, '2026-09');
  const snapshot = generated.snapshot;
  assert.equal(snapshot.records, undefined, 'the API view omits the frozen detail rows');
  assert.equal(snapshot.recordCount, 9);
  const total = snapshot.summary.total;
  assert.deepEqual([total.monitor, total.sdb, total.nonMonitor, total.positive, total.neutral, total.negative], [9, 8, 1, 1, 3, 4]);
  assert.deepEqual([total.cold, total.comment, total.negativeProcess, total.negativeOther], [1, 1, 1, 0]);
  assert.equal(snapshot.summary.rows.length, 30);
  assert.equal(snapshot.summary.rows.find(row => row.date === '2026-09-01').counts.positive, 1, 'midnight Beijing belongs to September 1');
  assert.equal(snapshot.summary.rows.find(row => row.date === '2026-09-30').counts.monitor, 1, 'a September post captured in October still belongs to September');
  assert.deepEqual(snapshot.summary.byTopic.map(row => [row.label, row.counts.monitor]), [['安吉星', 2], ['车机', 1], ['壁纸', 1], ['品牌APP', 1], ['哨兵', 1], ['上汽通用客服', 1], ['其它通用相关', 1], ['主题生成中', 1]]);
  assert.deepEqual(snapshot.summary.byPlatform.map(row => [row.label, row.counts.monitor]), [['小红书', 8], ['抖音', 1]]);
  assert.deepEqual(snapshot.topNegative.map(post => [post.recordId, post.heat]), [[hot, 437], [unhandled, 253], [feishu, 210]], 'non-monitor negatives never rank');
  assert.equal(snapshot.topNegative[2].feishuTableNo, '26090901');
  assert.equal(snapshot.evidence.missingPublishedCount, 1);
  assert.ok(snapshot.warnings.some(warning => warning.code === 'published_time_missing'));
  assert.ok(snapshot.warnings.some(warning => warning.code === 'topic_pending'));
  const full = await service.report(tenant, generated.id, {includeRecords: true});
  assert.deepEqual(full.snapshot.records.map(row => row.recordId).sort(), [positive, neutralLate, hot, feishu, comment, nonMonitor, watched, admitted, unhandled].sort());
  assert.ok(full.snapshot.records.every(row => !excluded.includes(row.recordId)));
  assert.equal(full.snapshot.records.find(row => row.recordId === watched).watched, true);
  assert.deepEqual((await service.list(tenant, '2026-09')).map(row => [row.version, row.emailDelivery.status]), [[1, 'none']]);
  assert.deepEqual(await service.list(tenant, '2026-08'), []);
  assert.deepEqual(await service.list(tenants[1]), []);
  await assert.rejects(service.generate(tenant, {month: '2026-11'}), {code: 'invalid_report_month'});
  const settings = await service.settings(tenant);
  assert.equal(settings.emailRecipients, 'customer@example.test, lead@example.test');
  assert.equal(settings.emailReady, true);

  await pool.query('UPDATE record_triage SET archived_at=$3 WHERE tenant_id=$1 AND record_id=$2', [tenant, positive, at(8, 10, '10')]);
  const again = await service.generate(tenant, {month: '2026-09'});
  assert.equal(again.version, 2);
  assert.equal(again.snapshot.summary.total.monitor, 8);
  assert.equal((await service.report(tenant, generated.id)).snapshot.summary.total.monitor, 9, 'earlier versions stay frozen');
  const repeated = await service.generate(tenant, {month: '2026-09', requestId: 'monthly-request-1'});
  assert.equal((await service.generate(tenant, {month: '2026-09', requestId: 'monthly-request-1'})).id, repeated.id, 'request ids are idempotent');
  await assert.rejects(service.generate(tenant, {month: '2026-08', requestId: 'monthly-request-1'}), {message: '同一生成请求不能用于不同月份'});

  const queued = await service.sendEmail(tenant, generated.id);
  assert.equal(queued.emailDelivery.status, 'queued');
  assert.equal(queued.emailDelivery.recipients, 'customer@example.test, lead@example.test');
  assert.deepEqual(await service.processDue(), {processed: 1});
  assert.equal((await service.report(tenant, generated.id)).emailDelivery.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, '月报回归客户舆情月报 · 2026-09 · v1');
  assert.equal(sent[0].to, 'customer@example.test, lead@example.test');
  assert.equal(sent[0].messageId, `<monthly-report-${queued.emailDelivery.sendId}@starvoice.local>`);
  assert.deepEqual(sent[0].attachments.map(item => item.filename), ['客户月报_2026-09_v1.xlsx', '客户月报明细_2026-09_v1.xlsx']);
  assert.match(sent[0].html, /舆情月报 2026-09/);
  assert.match(sent[0].html, /车机黑屏/);
  assert.doesNotMatch(sent[0].html + sent[0].text, /缺少发布时间/, 'internal warnings stay out of the customer email');
  const stored = await pool.query('SELECT status,subject FROM customer_monthly_email_deliveries WHERE tenant_id=$1 AND report_id=$2', [tenant, generated.id]);
  assert.deepEqual(stored.rows, [{status: 'sent', subject: '月报回归客户舆情月报 · 2026-09 · v1'}]);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM customer_daily_email_deliveries WHERE tenant_id=$1', [tenant])).rows[0].n, 0, 'the daily queue is untouched');

  const email = `monthly-${randomUUID()}@integration.invalid`;
  const user = (await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'本地测试',$2,'active',false,'',false) RETURNING id", [email, hashPassword('local-test-password')])).rows[0].id;
  users.push(user);
  await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_viewer','active')", [user, tenant]);
  server = await new Promise(resolve => { const instance = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password: 'local-test-password'})});
  assert.equal(login.status, 200);
  const {token} = await login.json();
  const headers = {authorization: `Bearer ${token}`, 'x-tenant-id': tenant};
  const list = await (await fetch(`${base}/api/customer-monthly-reports/?month=2026-09`, {headers})).json();
  assert.deepEqual(list.reports.map(row => row.version), [3, 2, 1]);
  const detail = await fetch(`${base}/api/customer-monthly-reports/${generated.id}`, {headers});
  assert.equal(detail.status, 200);
  const payload = await detail.json();
  assert.equal(payload.report.snapshot.records, undefined);
  assert.match(payload.html, /二、内容主题分布/);
  assert.match(payload.text, /安吉星\t2/);
  for (const [path, name] of [['excel', '客户月报_2026-09_v1.xlsx'], ['detail.xlsx', '客户月报明细_2026-09_v1.xlsx']]) {
    const response = await fetch(`${base}/api/customer-monthly-reports/${generated.id}/${path}`, {headers});
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(decodeURIComponent(response.headers.get('content-disposition').split("''")[1]), name);
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  }
  assert.equal((await fetch(`${base}/api/customer-monthly-reports/settings`, {headers})).status, 200);
  assert.equal((await fetch(`${base}/api/customer-monthly-reports/generate`, {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify({month: '2026-09'})})).status, 403, 'viewers cannot generate');
  assert.equal((await fetch(`${base}/api/customer-monthly-reports/${generated.id}/email`, {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: '{}'})).status, 403, 'viewers cannot send');
  assert.equal((await fetch(`${base}/api/customer-monthly-reports/${generated.id}`, {headers: {...headers, 'x-tenant-id': tenants[1]}})).status, 403, 'no membership in the other tenant');
  assert.equal((await fetch(`${base}/api/customer-monthly-reports/not-a-report`, {headers})).status, 404);
});
