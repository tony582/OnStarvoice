import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {collectCustomerDailyReport} from '../../../server/services/customer-daily-report-data.js';
import {customerDailyBusinessPeriod} from '../../../server/services/customer-daily-business-period.js';

test('real PostgreSQL reproduces cold 14 to 7, audits every negative bucket, and joins reply notes with tenant isolation', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool(), tenants = [];
  t.after(async () => { if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]); await closePool(); });
  for (const name of ['有效处理回归', '不得混入的客户']) tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [name])).rows[0].id);
  const tenantId = tenants[0], period = customerDailyBusinessPeriod('2026-09-28', new Date('2026-09-28T17:00:00+08:00'));
  const at = hour => `2026-09-28T${String(hour).padStart(2, '0')}:00:00+08:00`;
  const db = {queryAll: async (sql, params) => (await pool.query(sql, params)).rows, queryOne: async (sql, params) => (await pool.query(sql, params)).rows[0]};
  const options = {tenantId, db, businessPeriod: period, auditCoverageFrom: '2026-08-01T00:00:00Z'};
  async function transition(id, previous, next, hour = 10, note = '', tenant = tenantId) {
    await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata,created_at)
      VALUES($1,'system','local-test','record.triage_updated','record',$2,$3::jsonb,$4)`, [tenant, id, JSON.stringify({previousStatus: previous, nextStatus: next, note}), at(hour)]);
    if (tenant === tenantId) await pool.query('UPDATE record_triage SET status=$2 WHERE tenant_id=$3 AND record_id=$1', [id, next, tenantId]);
  }
  async function record(status, sentiment = 'negative', created = at(8)) {
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,url,record_type,sentiment,created_at,first_seen_at,published_ts,business_visibility,ai_result)
      VALUES($1::uuid,$2,'douyin',$1::text,$3,'https://www.douyin.com/video/123','single_note',$4,$5,$5,$5,'eligible','{"relevance":"relevant"}')`, [id, tenantId, `测试 ${status}`, sentiment, created]);
    await pool.query('INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,$3)', [tenantId, id, status]);
    await transition(id, 'unhandled', status);
    return id;
  }
  const groups = {};
  for (const [status, size] of [['negative_cold', 14], ['negative_comment', 4], ['negative_feishu', 4], ['unavailable', 4], ['privacy_unreachable', 4]]) {
    groups[status] = [];
    for (let i = 0; i < size; i++) groups[status].push(await record(status));
  }
  const replyPositive = await record('replied', 'positive', '2026-08-01T01:00:00Z');
  await record('replied', 'neutral'); await record('replied', 'negative');
  const before = await collectCustomerDailyReport(options);
  assert.equal(before.summary.day.cold, 14); assert.equal(before.coldMarked.length, 14);
  assert.deepEqual([before.summary.day.comment, before.summary.day.negativeProcess, before.summary.day.negativeOther], [4, 4, 8]);
  const frozen = structuredClone(before);
  await pool.query("UPDATE records SET sentiment='neutral' WHERE id=ANY($1::uuid[])", [groups.negative_cold.slice(0, 3)]);
  for (const id of groups.negative_cold.slice(3, 6)) await transition(id, 'negative_cold', 'reviewed_non_monitor', 11);
  await transition(groups.negative_cold[6], 'negative_cold', 'unavailable', 11);
  for (const status of ['negative_comment', 'negative_feishu', 'unavailable', 'privacy_unreachable']) {
    await pool.query("UPDATE records SET sentiment='neutral' WHERE id=$1", [groups[status][0]]);
    await transition(groups[status][1], status, 'reviewed_non_monitor', 11);
  }
  // A cycle and a duplicate save are still one effective post, not extra actions.
  await transition(groups.negative_comment[2], 'negative_comment', 'negative_cold', 12);
  await transition(groups.negative_comment[2], 'negative_cold', 'negative_comment', 13, '评论回复\n第二行😀');
  await transition(groups.negative_comment[2], 'negative_comment', 'negative_comment', 14, '同状态追加');
  await transition(replyPositive, 'replied', 'reviewed', 11, '旧阶段');
  await transition(replyPositive, 'reviewed', 'replied', 12, '您没事就是对我们最大的认可~~\n注意安全哦~~😀');
  await pool.query('INSERT INTO record_notes(tenant_id,record_id,body,created_at) VALUES($1,$2,$3,$4)', [tenantId, replyPositive, '独立补充\n保留换行', at(13)]);
  await pool.query('INSERT INTO record_notes(tenant_id,record_id,body,created_at) VALUES($1,$2,$3,$4)', [tenants[1], replyPositive, '跨租户备注不得出现', at(13)]);
  await transition(replyPositive, 'replied', 'replied', 14, '跨租户审计不得出现', tenants[1]);
  const after = await collectCustomerDailyReport(options);
  assert.deepEqual([after.summary.day.cold, after.summary.day.comment, after.summary.day.negativeProcess, after.summary.day.negativeOther], [7, 2, 2, 5]);
  assert.equal(after.coldMarked.length, 7); assert.equal(after.commentMarked.length, 2); assert.equal(after.repliedMarked.length, 3);
  for (const key of ['cold', 'comment', 'negativeProcess', 'negativeOther']) assert.equal(after.summary.mtd[key], after.summary.day[key]);
  assert.equal(after.summary.day.monitor, before.summary.day.monitor, 'processing does not re-collect records');
  assert.equal(after.summary.mtd.monitor, before.summary.mtd.monitor, 'collection MTD retains its distinct first-insertion cohort');
  assert.equal(after.summary.day.nonMonitor, 7); assert.equal(after.summary.day.neutral, 8);
  assert.equal(after.summary.day.positive, 0, 'an older-month positive reply appears in the reply list, not new collection');
  const reply = after.repliedMarked.find(row => row.recordId === replyPositive);
  assert.equal(reply.replyContent, '您没事就是对我们最大的认可~~\n注意安全哦~~😀');
  assert.deepEqual(reply.supplementalNotes.map(row => row.body), ['独立补充\n保留换行']);
  assert.equal(reply.isHistorical, true);
  assert.equal(after.commentMarked.find(row => row.recordId === groups.negative_comment[2]).replyContent, '评论回复\n第二行😀');
  assert.deepEqual(after.commentMarked.find(row => row.recordId === groups.negative_comment[2]).supplementalNotes.map(row => row.body), ['同状态追加']);
  assert.deepEqual(before, frozen, 'regenerating cannot alter the prior version');
  assert.doesNotMatch(JSON.stringify(after), /跨租户/);
});
