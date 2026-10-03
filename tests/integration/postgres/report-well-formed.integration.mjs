import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { generateReport } from '../../../server/services/report-generator.js';
import { isWellFormed } from '../../../server/utils/well-formed-text.js';

// Production 2026-09-12 and 09-13 09:00: "[Cron] Report scheduler error: invalid input syntax for type json",
// PostgreSQL context `…副驾妹妹着实吓一跳\ud83e…`. compactText cut a sample title/summary inside an emoji
// (slice(0, max - 1) + '…'); the dashboard and email HTML carrying that half character are stored in
// report_runs.metadata (jsonb), so the whole report write failed and that day's report was never generated.
const now = new Date('2026-09-24T01:00:30Z'); // 09:00:30 Shanghai: the daily report for 09-23
const REPLACEMENT = String.fromCharCode(0xFFFD);

test('a report whose samples are cut through an emoji is still generated and stored', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool();
  const originalEnv = { key: process.env.LLM_API_KEY, provider: process.env.LLM_PROVIDER };
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_PROVIDER;
  const tenants = [];
  t.after(async () => {
    if (originalEnv.key !== undefined) process.env.LLM_API_KEY = originalEnv.key;
    if (originalEnv.provider !== undefined) process.env.LLM_PROVIDER = originalEnv.provider;
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
    await closePool();
  });

  async function tenantWith(records) {
    const tenant = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`报告代理项验证 ${randomUUID()}`])).rows[0].id;
    tenants.push(tenant);
    for (const [index, record] of records.entries()) {
      const sentiment = record.sentiment ?? 'negative';
      await pool.query(`INSERT INTO records(id, tenant_id, platform, external_id, title, content, keyword, created_at,
          ai_result, sentiment, ai_summary, likes, comments_count)
        VALUES ($1::uuid, $2, 'douyin', $3, $4, $5, '车机', '2026-09-23T10:00:00+08', $6::jsonb, $7, $8, $9, $9)`, [
        randomUUID(), tenant, randomUUID(), record.title, record.content || '正文', JSON.stringify({ sentiment, relevance: 'relevant' }),
        sentiment, record.summary || '', 100 * (records.length - index),
      ]);
    }
    return tenant;
  }
  async function stored(run) {
    const row = (await pool.query('SELECT status, html, metadata FROM report_runs WHERE id=$1', [run.id])).rows[0];
    const snapshots = (await pool.query('SELECT data FROM report_snapshots WHERE report_run_id=$1', [run.id])).rows;
    return { ...row, snapshots };
  }

  await t.test('control: plain samples generate a stored report', async () => {
    const tenant = await tenantWith([{ title: '车机升级后黑屏', summary: '车主反映升级后黑屏' }]);
    const run = await generateReport({ tenantId: tenant, type: 'daily', send: false, now });
    const row = await stored(run);
    assert.equal(row.status, 'generated');
    assert.match(row.metadata.dashboardHtml, /车机升级后黑屏/);
    assert.equal(row.snapshots.length, 1);
  });

  await t.test('titles and summaries cut inside an emoji keep whole characters in the stored HTML', async () => {
    // compactText keeps max - 1 units: the dashboard cuts titles at 74 and 42 and summaries at 132, the email
    // cuts titles at 76 and summaries at 160. Each of those limits falls inside a 🤯 here.
    const title = `${'题'.repeat(40)}🤯${'题'.repeat(30)}🤯🤯${'尾'.repeat(20)}`;
    const summary = `${'摘'.repeat(130)}🤯${'摘'.repeat(26)}🤯${'尾'.repeat(30)}`;
    const tenant = await tenantWith([{ title, summary }]);
    const run = await generateReport({ tenantId: tenant, type: 'daily', send: false, now });
    const row = await stored(run);
    assert.equal(row.status, 'generated', 'the report write committed');
    assert.equal(row.snapshots.length, 1, 'the snapshot was written');
    const { dashboardHtml, emailHtml } = row.metadata;
    assert.equal(isWellFormed(dashboardHtml), true);
    assert.equal(isWellFormed(emailHtml), true);
    assert.ok(dashboardHtml.includes(`${'题'.repeat(40)}🤯${'题'.repeat(30)}…`), 'title at 74: the split emoji is dropped whole');
    assert.ok(dashboardHtml.includes(`${'题'.repeat(40)}…`), 'title at 42');
    assert.ok(dashboardHtml.includes(`${'摘'.repeat(130)}…`), 'summary at 132');
    assert.ok(emailHtml.includes(`${'题'.repeat(40)}🤯${'题'.repeat(30)}🤯…`), 'title at 76');
    assert.ok(emailHtml.includes(`${'摘'.repeat(130)}🤯${'摘'.repeat(26)}…`), 'summary at 160');
    assert.ok(!row.html.includes(REPLACEMENT), 'the text column did not get a replacement character either');
  });

  await t.test('a hashtag whose 24-unit match ends inside an emoji does not poison the hot terms', async () => {
    const tenant = await tenantWith([{ title: '车机讨论', content: `求助 #${'车'.repeat(23)}🤯后面 还有正文` }]);
    const run = await generateReport({ tenantId: tenant, type: 'daily', send: false, now });
    const row = await stored(run);
    assert.equal(row.status, 'generated');
    const labels = row.metadata.stats.hotTerms.map(term => term.label);
    assert.ok(labels.includes('车'.repeat(23)), labels.join(','));
    assert.ok(labels.every(isWellFormed));
    assert.deepEqual(row.snapshots[0].data.hotTerms.map(term => term.label), labels);
  });
});
