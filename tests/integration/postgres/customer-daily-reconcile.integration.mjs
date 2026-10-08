import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {planCustomerDailyReconcile, applyCustomerDailyReconcile, summarizeReconcilePlan, RECONCILE_NOTE} from '../../../server/scripts/reconcile-customer-daily-scope.mjs';
import {createCustomerDailyReportService} from '../../../server/services/customer-daily-reports.js';
import {collectCustomerDailyReport} from '../../../server/services/customer-daily-report-data.js';
import {collectCustomerMonthlyReport} from '../../../server/services/customer-monthly-report-data.js';

test('sent September daily cohort posts are admitted with handling records on their report dates, invisible to October work', async t => {
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
  const tenant = (await pool.query("INSERT INTO tenants(name) VALUES('对齐回归客户') RETURNING id")).rows[0].id;
  tenants.push(tenant);
  await pool.query('INSERT INTO customer_daily_report_settings(tenant_id,config) VALUES($1,$2::jsonb)', [tenant, JSON.stringify({collectionBoundaryTime: '18:00', emailRecipients: 'c@example.test'})]);
  async function record({firstSeen, published = '2026-09-05T10:00:00+08:00', keyword = '别克哨兵', relevance = 'uncertain', status = null, archived = false, handledAt = null, overrides = {}} = {}) {
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,url,record_type,sentiment,created_at,first_seen_at,published_ts,business_visibility,ai_result,keyword,manual_overrides)
      VALUES($1::uuid,$2,'xiaohongshu',$1::text,'哨兵录像怎么导出','https://www.xiaohongshu.com/explore/1','single_note','neutral',$3,$3,$4,'eligible',$5::jsonb,$6,$7::jsonb)`,
    [id, tenant, firstSeen, published, JSON.stringify({relevance}), keyword, JSON.stringify(overrides)]);
    if (status) {
      await pool.query('INSERT INTO record_triage(tenant_id,record_id,status,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', [tenant, id, status, archived ? handledAt : null, handledAt]);
      await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata,created_at) VALUES($1,'user','staff','record.triage_updated','record',$2,$3::jsonb,$4)`,
        [tenant, id, JSON.stringify({previousStatus: 'unhandled', nextStatus: status}), handledAt]);
    }
    return id;
  }
  // Out of scope today: sentry keyword, uncertain relevance, no brand evidence.
  const eveningPost = await record({firstSeen: '2026-09-08T20:37:19+08:00'});            // counted in the 9/9 report
  const weekendPost = await record({firstSeen: '2026-09-12T03:00:00+08:00'});            // counted in the 9/14 report
  const earlyPost = await record({firstSeen: '2026-08-31T21:21:32+08:00', published: '2026-08-20T10:00:00+08:00'}); // before the first daily report
  const staffNonMonitor = await record({firstSeen: '2026-09-10T04:00:00+08:00', status: 'reviewed_non_monitor', handledAt: '2026-09-10T11:00:00+08:00'});
  const staffReviewed = await record({firstSeen: '2026-09-10T04:10:00+08:00', status: 'reviewed', handledAt: '2026-09-10T11:05:00+08:00'});
  const archivedPost = await record({firstSeen: '2026-09-02T04:00:00+08:00', status: 'reviewed', archived: true, handledAt: '2026-09-07T15:59:00+08:00'});
  // In scope already: a normal admitted post, and a sentry post staff confirmed relevant.
  const normalPost = await record({firstSeen: '2026-09-15T04:00:00+08:00', keyword: '安吉星', relevance: 'relevant'});
  const manualRelevant = await record({firstSeen: '2026-09-16T04:00:00+08:00', overrides: {relevance: {value: 'relevant'}}});
  // Never reported: must stay untouched even though it looks identical.
  const unreported = await record({firstSeen: '2026-09-20T04:00:00+08:00'});
  const cohort = [eveningPost, weekendPost, earlyPost, staffNonMonitor, staffReviewed, archivedPost, normalPost, manualRelevant];
  async function dailyReport(date, version, {sent, dayIds = [], monthIds = []} = {}) {
    const id = randomUUID();
    const snapshot = {schemaVersion: 5, tenantId: tenant, reportDate: date, summary: {}, evidence: {dayRecordIds: dayIds, monthRecords: monthIds.map(recordId => ({recordId, firstSeenAt: null, sentiment: 'neutral', status: 'unhandled'}))}};
    await pool.query(`INSERT INTO customer_daily_reports(id,tenant_id,report_date,mode,version,request_key,snapshot) VALUES($1,$2,$3,'formal',$4,$5,$6::jsonb)`, [id, tenant, date, version, `fixture-${id}`, JSON.stringify(snapshot)]);
    if (sent) await pool.query(`INSERT INTO customer_daily_email_deliveries(id,tenant_id,report_id,recipients,subject,snapshot,status,sent_at) VALUES($1,$2,$3,'c@example.test','s','{}'::jsonb,'sent',now())`, [randomUUID(), tenant, id]);
    return id;
  }
  await dailyReport('2026-09-09', 1, {sent: true, dayIds: [eveningPost]});
  await dailyReport('2026-09-14', 1, {sent: false, dayIds: [weekendPost]});
  await dailyReport('2026-09-14', 2, {sent: true, dayIds: [weekendPost]});
  await dailyReport('2026-09-29', 1, {sent: true, monthIds: cohort});
  await dailyReport('2026-09-29', 2, {sent: false, monthIds: [...cohort, unreported]}, 'an unsent later version is not the customer cohort');

  const plan = await planCustomerDailyReconcile(pool, {tenant: '对齐回归客户', month: '2026-09'});
  assert.equal(plan.cohortReport.version, 1);
  assert.equal(plan.cohortReport.reportDate, '2026-09-29');
  const summary = summarizeReconcilePlan(plan);
  assert.deepEqual(summary, {cohortSize: 8, inScope: 2, outOfScope: 6, missingRecords: 0,
    byAction: {import_non_monitor: 3, override_only: 2, skip_archived: 1},
    byDate: {'2026-09-09': {import_non_monitor: 1, override_only: 0}, '2026-09-14': {import_non_monitor: 1, override_only: 0}, '2026-09-01': {import_non_monitor: 1, override_only: 0}, '2026-09-10': {import_non_monitor: 0, override_only: 2}}});
  const byId = new Map(plan.items.map(item => [item.recordId, item]));
  assert.deepEqual([byId.get(eveningPost).reportDate, byId.get(eveningPost).reportDateSource, byId.get(eveningPost).handledAt], ['2026-09-09', 'daily_snapshot', '2026-09-09T01:30:00.000Z']);
  assert.deepEqual([byId.get(weekendPost).reportDate, byId.get(weekendPost).reportDateSource], ['2026-09-14', 'daily_snapshot']);
  assert.deepEqual([byId.get(earlyPost).reportDate, byId.get(earlyPost).reportDateSource, byId.get(earlyPost).handledAt], ['2026-09-01', 'workday_window', '2026-09-01T01:30:00.000Z']);
  assert.equal(byId.get(staffReviewed).action, 'override_only');
  assert.equal(byId.get(archivedPost).action, 'skip_archived');
  assert.equal(byId.has(unreported), false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM records WHERE tenant_id=$1 AND manual_overrides ? 'triage_admission'", [tenant])).rows[0].n, 0, 'planning writes nothing');

  const applied = await applyCustomerDailyReconcile(pool, plan, {now: new Date('2026-10-08T06:00:00Z')});
  assert.deepEqual(applied, {overrides: 5, imported: 3, auditEvents: 3});
  const rows = (await pool.query(`SELECT r.id, r.manual_overrides->'triage_admission'->>'value' AS included, rt.status, rt.archived_at, (rt.updated_at AT TIME ZONE 'Asia/Shanghai')::text AS updated
    FROM records r LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id WHERE r.tenant_id=$1`, [tenant])).rows;
  const state = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.deepEqual([state[eveningPost].included, state[eveningPost].status, state[eveningPost].updated], ['included', 'reviewed_non_monitor', '2026-09-09 09:30:00']);
  assert.deepEqual([state[weekendPost].status, state[weekendPost].updated], ['reviewed_non_monitor', '2026-09-14 09:30:00']);
  assert.deepEqual([state[earlyPost].status, state[earlyPost].updated], ['reviewed_non_monitor', '2026-09-01 09:30:00']);
  assert.deepEqual([state[staffNonMonitor].included, state[staffNonMonitor].status, state[staffNonMonitor].updated], ['included', 'reviewed_non_monitor', '2026-09-10 11:00:00'], 'staff handling is kept as is');
  assert.deepEqual([state[staffReviewed].included, state[staffReviewed].status], ['included', 'reviewed']);
  assert.equal(state[archivedPost].included, null, 'archived posts are untouched');
  assert.ok(state[archivedPost].archived_at);
  assert.equal(state[normalPost].included, null);
  assert.equal(state[manualRelevant].included, null);
  assert.equal(state[unreported].included, null);
  assert.equal(state[unreported].status, null);
  const events = (await pool.query(`SELECT target_id, metadata, (created_at AT TIME ZONE 'Asia/Shanghai')::text AS at FROM audit_logs WHERE tenant_id=$1 AND action='record.triage_updated' AND actor_id='' ORDER BY created_at`, [tenant])).rows;
  assert.deepEqual(events.map(event => [event.target_id, event.at]), [[earlyPost, '2026-09-01 09:30:00'], [eveningPost, '2026-09-09 09:30:00'], [weekendPost, '2026-09-14 09:30:00']]);
  assert.equal(events[0].metadata.note, RECONCILE_NOTE);
  assert.equal(events[0].metadata.reconcile.reportDate, '2026-09-01');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='customer_daily_reconcile'", [tenant])).rows[0].n, 1);

  const again = await planCustomerDailyReconcile(pool, {tenant, month: '2026-09'});
  assert.deepEqual(summarizeReconcilePlan(again).byAction, {skip_archived: 1}, 'everything else is now in scope, so a rerun has nothing to do');
  assert.deepEqual(await applyCustomerDailyReconcile(pool, again), {overrides: 0, imported: 0, auditEvents: 0});

  // The October daily report (handling-date basis) must not see any of this as new work.
  const daily = createCustomerDailyReportService({now: () => new Date('2026-10-08T09:00:00Z'), collect: options => collectCustomerDailyReport({...options, auditCoverageFrom: '2026-08-01T00:00:00Z'})});
  const october = await daily.generate(tenant, {date: '2026-10-08'});
  assert.equal(october.snapshot.summary.day.monitor, 0);
  assert.equal(october.snapshot.summary.mtd.monitor, 0);
  assert.deepEqual(october.snapshot.evidence.dayRecordIds, []);
  // The September monthly (publish-time basis) now counts the imported September posts as non-monitor.
  const monthly = await collectCustomerMonthlyReport({tenantId: tenant, month: '2026-09', now: new Date('2026-10-08T09:00:00Z'), db: {queryAll: async (sql, params) => (await pool.query(sql, params)).rows, queryOne: async (sql, params) => (await pool.query(sql, params)).rows[0]}});
  const total = monthly.summary.total;
  assert.deepEqual([total.monitor, total.nonMonitor, total.sdb], [6, 3, 3], 'evening, weekend and staff non-monitor are outside SDB; staff reviewed, normal and manual-relevant count; the August-published early post is out by publish time');
  assert.deepEqual(monthly.records.map(row => row.recordId).sort(), [eveningPost, weekendPost, staffNonMonitor, staffReviewed, normalPost, manualRelevant].sort());

  // Content Triage lists the imported posts under their September handling dates, never under today.
  const email = `reconcile-${randomUUID()}@integration.invalid`;
  const user = (await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'本地测试',$2,'active',false,'',false) RETURNING id", [email, hashPassword('local-test-password')])).rows[0].id;
  users.push(user);
  await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_viewer','active')", [user, tenant]);
  server = await new Promise(resolve => { const instance = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password: 'local-test-password'})});
  const {token} = await login.json();
  const headers = {authorization: `Bearer ${token}`, 'x-tenant-id': tenant};
  const triage = async query => (await (await fetch(`${base}/api/triage/records?queue=triage&pageSize=100&${query}`, {headers})).json()).records.map(row => row.id).sort();
  assert.deepEqual(await triage('handledFrom=2026-09-09&handledTo=2026-09-09'), [eveningPost]);
  assert.deepEqual(await triage('handledFrom=2026-09-14&handledTo=2026-09-14'), [weekendPost]);
  assert.deepEqual(await triage('handledFrom=2026-10-08&handledTo=2026-10-08'), []);
  assert.deepEqual(await triage('status=reviewed_non_monitor'), [eveningPost, weekendPost, earlyPost, staffNonMonitor].sort());
  const listed = (await (await fetch(`${base}/api/triage/records?queue=triage&pageSize=100`, {headers})).json()).records;
  assert.deepEqual(listed.map(row => row.id).sort(), [eveningPost, weekendPost, earlyPost, staffNonMonitor, staffReviewed, normalPost, manualRelevant].sort(), 'archived and unreported sentry posts stay out of the main list');
  const imported = listed.find(row => row.id === eveningPost);
  assert.equal(imported.monitoring_evidence_status, 'customer_included');
  assert.equal(imported.ai_result.monitoringEvidence.reason, RECONCILE_NOTE);
  assert.equal(imported.ai_result.relevance, 'uncertain', 'AI analysis travels with the post unchanged');
});
