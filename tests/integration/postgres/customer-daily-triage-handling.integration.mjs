import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {createCustomerDailyReportService} from '../../../server/services/customer-daily-reports.js';
import {collectCustomerDailyReport} from '../../../server/services/customer-daily-report-data.js';
import {renderCustomerDailyReportHtml, renderCustomerDailyReportText, buildCustomerDailyReportWorkbook} from '../../../server/services/customer-daily-report-render.js';
import {renderCustomerDailySummarySvg} from '../../../server/services/customer-daily-report-image.js';
import {buildFeishuDailyDocumentPlan} from '../../../server/services/feishu-daily-report.js';
import {buildCustomerDailyMetricEvidence} from '../../../server/services/customer-daily-metric-evidence.js';

test('Oct 8 saved daily report matches Content Triage handling-date IDs, exports and immutable versions', async t => {
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
  for (const name of ['处理日期回归', '其他客户']) tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [name])).rows[0].id);
  const tenant = tenants[0], at = (day, hour = 9) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`;
  async function record({status = 'reviewed', sentiment = 'neutral', created = '2026-07-11T00:00:00Z', archived = false,
    visibility = 'eligible', relevance = 'relevant', keyword = '', overrides = {}, owner = tenant, type = 'single_note'} = {}) {
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,url,record_type,sentiment,created_at,first_seen_at,published_ts,business_visibility,ai_result,keyword,manual_overrides)
      VALUES($1::uuid,$2,'douyin',$1::text,'回归原帖','https://www.douyin.com/video/123',$3,$4,$5,$5,$5,$6,$7::jsonb,$8,$9::jsonb)`,
    [id, owner, type, sentiment, created, visibility, JSON.stringify({relevance}), keyword, JSON.stringify(overrides)]);
    await pool.query('INSERT INTO record_triage(tenant_id,record_id,status,archived_at) VALUES($1,$2,$3,$4)', [owner, id, status, archived ? at(8, 11) : null]);
    return id;
  }
  async function event(id, previous = 'unhandled', next = 'reviewed', when = at(8), action = 'record.triage_updated', owner = tenant) {
    await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata,created_at)
      VALUES($1,'system','local-fixture',$2,'record',$3,$4::jsonb,$5)`, [owner, action, id, JSON.stringify({previousStatus: previous, nextStatus: next}), when]);
  }
  const positive = await record({sentiment: 'positive'}); await event(positive);
  const repeated = await record(); await event(repeated, 'unhandled', 'reviewed', at(7));
  await event(repeated, 'reviewed', 'replied', at(8, 8)); await event(repeated, 'replied', 'reviewed', at(8, 10));
  const nonMonitor = await record({status: 'reviewed_non_monitor'}); await event(nonMonitor, 'unhandled', 'reviewed_non_monitor');
  const holiday = await record({sentiment: 'negative', status: 'negative_comment'}); await event(holiday, 'unhandled', 'negative_comment', at(1));
  const watched = await record({relevance: 'irrelevant'}); await event(watched);
  await pool.query('INSERT INTO record_watchlist(tenant_id,record_id) VALUES($1,$2)', [tenant, watched]);
  const admitted = await record({relevance: 'uncertain', keyword: '别克哨兵', overrides: {relevance: 'relevant'}}); await event(admitted);
  const batchA = await record(), batchB = await record({sentiment: 'positive'});
  await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata,created_at)
    VALUES($1,'system','local-fixture','record.triage_batch_updated','record','batch',$2::jsonb,$3)`,
  [tenant, JSON.stringify({recordIds: [batchA, batchB, batchA], status: 'reviewed', previous: {[batchA]: {status: 'unhandled'}, [batchB]: {status: 'unhandled'}}}), at(8, 10)]);
  const ticket = await record({sentiment: 'negative', status: 'negative_feishu'}); await event(ticket, 'unhandled', 'negative_feishu', at(8), 'record.ticket_created');
  const reply = await record({sentiment: 'positive', status: 'replied'}); await event(reply, 'unhandled', 'replied', at(8), 'record.official_response_marked');
  // These all look like current posts, but must not create a handled-day count.
  await record({created: at(8, 1), status: 'unhandled'});
  const sameStatus = await record(); await event(sameStatus, 'reviewed', 'reviewed');
  await pool.query('INSERT INTO record_notes(tenant_id,record_id,body,created_at) VALUES($1,$2,$3,$4)', [tenant, sameStatus, '仅补备注', at(8)]);
  for (const options of [{archived: true}, {visibility: 'filtered_out'}, {relevance: 'irrelevant'},
    {keyword: '别克哨兵', relevance: 'uncertain'}, {overrides: {relevance: 'irrelevant'}}, {type: 'blogger_profile'}, {type: 'official_content'}]) {
    const id = await record(options); await event(id);
  }
  const crossTenant = await record({owner: tenants[1]}); await event(crossTenant, 'unhandled', 'reviewed', at(8), 'record.triage_updated', tenants[1]);
  const later = await record(); await event(later, 'unhandled', 'reviewed', at(9, 0));
  const hot = await record({created: at(7), sentiment: 'negative', status: 'unhandled'});
  const archivedHot = await record({created: at(7), sentiment: 'negative', archived: true});
  const rejectedHot = await record({created: at(7), sentiment: 'negative', keyword: '别克哨兵', relevance: 'uncertain'});
  for (const id of [hot, archivedHot, rejectedHot]) {
    const metrics = {likes: 250, comments_count: 0, collects: 0, shares: 0, capture_timestamp: at(8)};
    await pool.query('INSERT INTO record_observations(tenant_id,record_id,captured_at,likes,comments_count,collects,shares,payload) VALUES($1,$2,$3,250,0,0,0,$4::jsonb)',
      [tenant, id, at(8), JSON.stringify({customerDailyMetricEvidence: buildCustomerDailyMetricEvidence(metrics, {preserved: false}, new Date(at(8)))})]);
  }
  const expected = [positive, repeated, nonMonitor, watched, admitted, batchA, batchB, ticket, reply].sort();
  const service = createCustomerDailyReportService({now: () => new Date(at(9, 1)),
    collect: options => collectCustomerDailyReport({...options, auditCoverageFrom: '2026-08-01T00:00:00Z'})});
  const generated = await service.generate(tenant, {date: '2026-10-08'});
  const snapshot = generated.snapshot;
  assert.equal(snapshot.schemaVersion, 6);
  assert.deepEqual(snapshot.evidence.dayRecordIds.sort(), expected);
  assert.deepEqual([snapshot.summary.day.monitor, snapshot.summary.day.sdb, snapshot.summary.day.positive, snapshot.summary.day.neutral, snapshot.summary.day.negativeProcess], [9, 8, 3, 4, 1]);
  assert.equal(snapshot.summary.mtd.monitor, 10);
  assert.equal(snapshot.summary.rows.reduce((total, row) => total + row.counts.monitor, 0), 11);
  assert.deepEqual(snapshot.commentMarked.map(row => row.recordId), [holiday]);
  assert.equal(snapshot.summary.day.comment, 0);
  assert.equal(snapshot.summary.rows.find(row => row.date === '2026-10-01').counts.comment, 1);
  assert.deepEqual(snapshot.highHeat.map(row => row.recordId), [hot], 'the separate 7-day heat list also respects current triage admission and archive scope');
  const email = `daily-${randomUUID()}@integration.invalid`;
  const user = (await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'本地测试',$2,'active',false,'',false) RETURNING id", [email, hashPassword('local-test-password')])).rows[0].id;
  users.push(user);
  await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_viewer','active')", [user, tenant]);
  server = await new Promise(resolve => { const instance = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password: 'local-test-password'})});
  assert.equal(login.status, 200);
  const {token} = await login.json();
  const response = await fetch(`${base}/api/triage/records?queue=triage&handledFrom=2026-10-08&handledTo=2026-10-08&pageSize=100`, {headers: {authorization: `Bearer ${token}`, 'x-tenant-id': tenant}});
  const triage = await response.json();
  assert.equal(response.status, 200, JSON.stringify(triage));
  assert.deepEqual(triage.records.map(row => row.id).sort(), expected);
  assert.equal(triage.pagination.total, snapshot.summary.day.monitor);
  for (const output of [renderCustomerDailyReportHtml(snapshot), renderCustomerDailyReportText(snapshot), renderCustomerDailySummarySvg(snapshot), JSON.stringify(buildFeishuDailyDocumentPlan(snapshot))]) {
    assert.match(output, /按实际处理日期/);
    assert.doesNotMatch(output, /采集列沿用首次入库/);
  }
  const workbook = await buildCustomerDailyReportWorkbook(snapshot);
  const workbookText = JSON.stringify(workbook.worksheets.map(sheet => sheet.getSheetValues()));
  assert.match(workbookText, /按实际处理日期/);
  assert.doesNotMatch(workbookText, /采集列沿用首次入库/);
  const frozen = structuredClone(snapshot);
  const edited = await service.saveSummary(tenant, generated.id, {summary: {rows: {'2026-10-08': {monitor: 10}}}});
  assert.equal(edited.snapshot.summary.monitoringBasis, snapshot.summary.monitoringBasis);
  assert.equal(edited.snapshot.summary.mtd.monitor, 11);
  await pool.query('UPDATE record_triage SET archived_at=$3 WHERE tenant_id=$1 AND record_id=$2', [tenant, positive, at(9)]);
  const updated = await service.generate(tenant, {date: '2026-10-08'});
  assert.equal(updated.snapshot.summary.day.monitor, 8);
  assert.deepEqual((await service.report(tenant, generated.id)).snapshot, frozen, 'regeneration and archive changes cannot rewrite a saved report');
  assert.equal((await service.report(tenant, edited.id)).snapshot.summary.day.monitor, 10, 'customer edits survive later generated versions');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM customer_daily_deliveries WHERE tenant_id=$1', [tenant])).rows[0].n, 0);

  // User acceptance case: Sep 30–Oct 7 posts are all processed on Oct 8.
  // Their publication/collection days must not create earlier daily rows.
  const backlogTenant = (await pool.query("INSERT INTO tenants(name) VALUES('30号到7号的帖子8号处理') RETURNING id")).rows[0].id;
  tenants.push(backlogTenant);
  const backlogIds = [];
  for (const date of ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']) {
    const id = await record({owner: backlogTenant, created: `${date}T09:00:00+08:00`, sentiment: 'neutral'});
    backlogIds.push(id);
    await event(id, 'unhandled', 'reviewed', at(8, 10), 'record.triage_updated', backlogTenant);
  }
  const backlog = await service.generate(backlogTenant, {date: '2026-10-08'});
  assert.deepEqual(backlog.snapshot.summary.rows.map(row => [row.date, row.counts.monitor]), [['2026-10-08', 8]]);
  assert.deepEqual(backlog.snapshot.evidence.dayRecordIds.sort(), backlogIds.sort());
  assert.equal(backlog.snapshot.summary.day.neutral, 8);
  assert.equal(backlog.snapshot.summary.mtd.monitor, 8);
  assert.deepEqual((await service.list(backlogTenant, '2026-10-08')).map(row => row.reportDate), ['2026-10-08']);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM customer_daily_reports WHERE tenant_id=$1 AND report_date<$2', [backlogTenant, '2026-10-08'])).rows[0].n, 0);
});
