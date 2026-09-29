import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { labelPendingRecords, persistRecordClassification } from '../../../server/services/ai-labeler.js';
import { resolveMonitoringIntent, resolveTenantMonitoringScope } from '../../../server/services/monitoring-intent.js';
import { getProcessBackgroundWorkSnapshot } from '../../../server/runtime/process-background-work.js';
import { isWellFormed } from '../../../server/utils/well-formed-text.js';

// Production incident 2026-09-29: "[AI] Label error for record <uuid>: invalid input syntax for type
// json" 1,097 times for one record. A text window cut through an emoji left a lone surrogate in the
// evidence quote; JSON.stringify wrote it as \ud83e; jsonb rejected the whole UPDATE (22P02), so the
// label never landed and the 10-minute batch called the paid model again every time.
const REPLACEMENT = String.fromCharCode(0xFFFD);
const HALF_EMOJI = '\uD83D';
const SENTRY_KEYWORD = '别克哨兵';

test('label write survives text cut through an emoji, and the batch does not loop on the record', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`标签代理项验证 ${randomUUID()}`])).rows[0].id;
  const originalFetch = globalThis.fetch;
  const originalEnv = { key: process.env.LLM_API_KEY, provider: process.env.LLM_PROVIDER };
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_PROVIDER;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalEnv.key !== undefined) process.env.LLM_API_KEY = originalEnv.key;
    if (originalEnv.provider !== undefined) process.env.LLM_PROVIDER = originalEnv.provider;
    // A successful label schedules alert checks in the background; they use the pool.
    for (let i = 0; i < 200 && getProcessBackgroundWorkSnapshot().inFlight > 0; i += 1) await new Promise(r => setTimeout(r, 25));
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
    await closePool();
  });

  async function record(content, { keyword = SENTRY_KEYWORD, title = '' } = {}) {
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,content,keyword)
      VALUES($1::uuid,$2,'douyin',$1::text,$3,$4,$5)`, [id, tenant, title, content, keyword]);
    return (await pool.query('SELECT *, ai_labeled_at::text AS classification_version FROM records WHERE id=$1', [id])).rows[0];
  }
  const persisted = async id => (await pool.query('SELECT * FROM records WHERE id=$1', [id])).rows[0];
  const baseResult = { relevance: 'relevant', sentiment: 'neutral', intent: 'inquiry', category: 'feature_usage', confidence: .9, relevanceConfidence: .9, summary: '咨询哨兵录像' };
  const labeled = (result = baseResult, keyword = SENTRY_KEYWORD) => ({
    result, provider: 'fixture', model: 'synthetic',
    intent: resolveMonitoringIntent(keyword), tenantScope: resolveTenantMonitoringScope({ brandName: '安吉星' }),
  });
  const persist = (source, result, keyword) => persistRecordClassification({ record: source, labeled: labeled(result, keyword), observedKeywords: [source.keyword] });

  await t.test('evidence quote whose window edge falls inside an emoji is stored whole', async () => {
    for (const [name, content] of [
      ['end edge', `别克${'，'.repeat(59)}💰谁看谁心动`],
      ['start edge', `💰${'，'.repeat(24)}别克哨兵昨晚没有录像`],
      ['both edges', `💰${'，'.repeat(24)}别克${'，'.repeat(59)}💰后面`],
    ]) {
      const source = await record(content);
      const outcome = await persist(source, baseResult);
      assert.ok(outcome, `${name}: the label must be written`);
      const row = await persisted(source.id);
      assert.ok(row.ai_labeled_at, `${name}: ai_labeled_at set`);
      assert.equal(row.ai_result.relevance, 'relevant', name);
      const evidence = row.ai_result.monitoringEvidence.evidence;
      assert.ok(evidence.length > 0, `${name}: evidence kept`);
      for (const item of evidence) {
        assert.equal(isWellFormed(item.quote), true, name);
        assert.ok(content.includes(item.quote), `${name}: the quote is still an exact excerpt`);
        assert.ok(item.quote.includes(item.entity), name);
      }
    }
  });

  await t.test('fancy-font brand spelling keeps its whole first and last character', async () => {
    for (const [content, entity] of [['𝐁𝐮𝐢𝐜𝐤哨兵没录像', '𝐁𝐮𝐢𝐜𝐤'], ['🄱🅄🄸🄲🄺哨兵怎么开', '🄱🅄🄸🄲🄺']]) {
      const source = await record(content);
      assert.ok(await persist(source, baseResult), content);
      const evidence = (await persisted(source.id)).ai_result.monitoringEvidence.evidence;
      assert.equal(evidence[0].entity, entity);
    }
  });

  await t.test('a lone surrogate in the model reply is replaced instead of failing the write', async () => {
    const source = await record('车机升级后哨兵找不到录像', { keyword: '车机咨询' });
    const dirty = {
      ...baseResult,
      summary: `摘要${HALF_EMOJI}`,
      relevanceReason: `\uDCB0理由`,
      evidence: [{ quote: `引用${HALF_EMOJI}`, note: 'ok' }],
      [`键${HALF_EMOJI}`]: 1,
    };
    assert.ok(await persist(source, dirty, '车机咨询'));
    const row = await persisted(source.id);
    assert.equal(row.ai_summary, `摘要${REPLACEMENT}`);
    assert.equal(row.ai_result.summary, `摘要${REPLACEMENT}`);
    assert.equal(row.ai_result.relevanceReason, `${REPLACEMENT}理由`);
    assert.deepEqual(row.ai_result.evidence, [{ quote: `引用${REPLACEMENT}`, note: 'ok' }]);
    assert.equal(row.ai_result[`键${REPLACEMENT}`], 1);
  });

  await t.test('reason and topic limits that fall inside an emoji drop the whole character', async () => {
    const source = await record('哨兵没有录像', { keyword: '车机咨询' });
    const reason = `${'因'.repeat(499)}💰后面还有说明`;
    assert.ok(await persist(source, { ...baseResult, contentTopicReason: reason, intentReason: reason, matchedTopics: [`${'题'.repeat(99)}💰`] }, '车机咨询'));
    const stored = (await persisted(source.id)).ai_result;
    assert.equal(stored.contentTopicReason, '因'.repeat(499));
    assert.equal(stored.intentReason, '因'.repeat(499));
    assert.deepEqual(stored.matchedTopics, ['题'.repeat(99)]);
  });

  await t.test('keyword cut at 200 units inside an emoji does not poison the monitoring intent id', async () => {
    const keyword = `${'k'.repeat(199)}💰`;
    const source = await record('哨兵没有录像', { keyword });
    assert.ok(await persist(source, baseResult, keyword));
    const stored = (await persisted(source.id)).ai_result;
    // The persist-level guard would also turn a lone surrogate into U+FFFD, so pin the exact value:
    // the emoji is dropped whole and nothing is substituted.
    assert.equal(stored.classifierMetadata.monitoringIntentId, `monitoring-keyword:${'k'.repeat(199)}`);
  });

  await t.test('batch labelling: the poisoned record is labelled with one model call and is not selected again', async () => {
    await pool.query(`INSERT INTO tenant_settings (tenant_id, key, value)
      VALUES ($1,'llm_provider','deepseek'),($1,'llm_api_key','sk-test-not-real'),
             ($1,'llm_model','deepseek-chat'),($1,'llm_api_endpoint','https://llm.invalid/v1')
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = now()`, [tenant]);
    const calls = [];
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /^https:\/\/llm\.invalid\//, 'the stub must be the only model endpoint');
      calls.push(JSON.parse(init.body).messages.at(-1).content);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(baseResult) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    const marker = `标记${randomUUID()}`;
    let poison;
    let control;
    try {
      poison = await record(`别克${'，'.repeat(59)}💰谁看谁心动`, { title: `${marker}-poison` });
      control = await record('车机升级后哨兵找不到录像', { keyword: '车机咨询', title: `${marker}-control` });
      const callsFor = suffix => calls.filter(message => message.includes(`${marker}-${suffix}`)).length;

      await labelPendingRecords(50);
      assert.equal((await persisted(poison.id)).ai_result.relevance, 'relevant', 'poisoned record labelled on the first pass');
      assert.equal((await persisted(control.id)).ai_result.relevance, 'relevant');
      assert.deepEqual([callsFor('poison'), callsFor('control')], [1, 1], 'one paid call each');

      await labelPendingRecords(50);
      await labelPendingRecords(50);
      assert.deepEqual([callsFor('poison'), callsFor('control')], [1, 1], 'labelled records are not sent to the model again');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(errors.filter(line => line.includes('[AI] Label error')), []);
  });
});
