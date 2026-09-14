import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { persistRecordClassification } from '../../../server/services/ai-labeler.js';
import { resolveMonitoringIntent, resolveTenantMonitoringScope } from '../../../server/services/monitoring-intent.js';

test('post intent classification persists grounded evidence and fences stale model responses', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`发帖判断验证 ${randomUUID()}`])).rows[0].id;
  t.after(async () => { await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]); await closePool(); });
  async function record(content = '车被剐蹭了，哨兵竟然没触发，太失望了', keyword = '别克哨兵') {
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,content,keyword)
      VALUES($1,$2,'douyin',$5,$3,$4)`, [id, tenant, content, keyword, id]);
    return (await pool.query('SELECT *, ai_labeled_at::text AS classification_version FROM records WHERE id=$1', [id])).rows[0];
  }
  const baseResult = { relevance: 'relevant', sentiment: 'negative', intent: 'complaint', intentReason: '抱怨哨兵功能未触发', category: 'feature_usage', confidence: .9, relevanceConfidence: .9, summary: '反馈哨兵未触发' };
  function labeled(result = baseResult) { return { result, provider: 'fixture', model: 'synthetic', intent: resolveMonitoringIntent('别克哨兵'), tenantScope: resolveTenantMonitoringScope({ brandName: '安吉星' }) }; }
  const persisted = async id => (await pool.query('SELECT * FROM records WHERE id=$1', [id])).rows[0];

  await t.test('anonymous sentry complaint remains stored and is marked uncertain without brand proof', async () => {
    const source = await record();
    const outcome = await persistRecordClassification({ record: source, labeled: labeled() });
    assert.equal(outcome.result.relevance, 'uncertain');
    assert.equal(outcome.result.intent, 'complaint');
    assert.equal(outcome.result.monitoringEvidence.status, 'needs_review');
    const row = await persisted(source.id);
    assert.equal(row.business_visibility, 'eligible');
    assert.equal(row.content, source.content);
    assert.equal(row.ai_result.classifierMetadata.promptVersion, 'record-topic-v6');
  });
  await t.test('unambiguous model identity protects relevant posts even without a brand word', async () => {
    const source = await record('昂科威Plus哨兵没触发，车被刮了。');
    const outcome = await persistRecordClassification({ record: source, labeled: labeled() });
    assert.equal(outcome.result.relevance, 'relevant');
    assert.equal(outcome.result.monitoringEvidence.status, 'confirmed');
    assert.ok(outcome.result.monitoringEvidence.evidence.some(item => item.quote.includes('昂科威')));
  });
  await t.test('model shorthand is retained and cropped citations are repaired from the current source', async () => {
    for (const model of ['L7', 'E5', 'CT50']) {
      const source = await record(`${model}的哨兵功能没触发`);
      const outcome = await persistRecordClassification({ record: source, labeled: labeled({ ...baseResult,
        monitoringEvidence: { status: 'needs_review', evidence: [{ source: 'content', quote: model === 'CT50' ? 'CT5' : model }] },
      }) });
      assert.equal(outcome.result.relevance, 'relevant', model);
      const row = await persisted(source.id);
      assert.equal(row.ai_result.monitoringEvidence.status, 'confirmed');
      assert.equal(row.ai_result.monitoringEvidence.evidence[0].entity, model);
      assert.equal(row.ai_result.monitoringEvidence.evidence[0].quote, source.content);
      assert.equal(row.content, source.content);
    }
  });
  await t.test('model shorthand does not override an uncertain or explicitly unrelated overall judgment', async () => {
    for (const [content, relevance] of [['理想L7哨兵没录像', 'irrelevant'], ['E5驻车监控异常', 'uncertain']]) {
      const source = await record(content);
      const outcome = await persistRecordClassification({ record: source, labeled: labeled({ ...baseResult, relevance }) });
      assert.equal(outcome.result.relevance, relevance);
      assert.equal((await persisted(source.id)).ai_result.relevance, relevance);
    }
  });
  await t.test('expanded Chinese and English aliases and spelling variants persist without losing source spelling', async () => {
    for (const name of ['SAIC-GM', 'GM', 'Chevy', 'LaCrosse', 'Regal', '科鲁泽', 'Monza', 'E4', 'OPTIQ', '傲歌', 'VISTIQ', 'ATS-L', 'CT 5', 'CT–5', 'ＣＴ５']) {
      const source = await record(`${name}的驻车录像无法保存`);
      const outcome = await persistRecordClassification({ record: source, labeled: labeled() });
      assert.equal(outcome.result.relevance, 'relevant', name);
      const row = await persisted(source.id);
      assert.ok(row.ai_result.monitoringEvidence.evidence.some(item => item.entity === name), name);
      assert.equal(row.content, source.content);
    }
  });
  await t.test('known English model names can take vehicle context from another current post field', async () => {
    const source = await record('哨兵昨晚没有录像');
    await pool.query('UPDATE records SET title=$2 WHERE id=$1', [source.id, 'LaCrosse']);
    const current = (await pool.query('SELECT *,ai_labeled_at::text AS classification_version FROM records WHERE id=$1', [source.id])).rows[0];
    const outcome = await persistRecordClassification({ record: current, labeled: labeled() });
    assert.equal(outcome.result.relevance, 'relevant');
    assert.equal(outcome.result.monitoringEvidence.evidence[0].entity, 'LaCrosse');
    assert.equal(outcome.result.monitoringEvidence.evidence[0].source, 'title');
  });
  await t.test('a literal typed model citation preserves an uncatalogued name and remains valid after persistence', async () => {
    // Synthetic vehicle name: exercises attribution transport, not model accuracy.
    const source = await record('穹曜Z9的驻车录像无法保存');
    const evidence = { source: 'content', quote: source.content, entity: '穹曜Z9', entityType: 'model', manufacturer: 'saic_gm' };
    const outcome = await persistRecordClassification({ record: source, labeled: labeled({ ...baseResult, monitoringEvidence: { status: 'needs_review', evidence: [evidence] } }) });
    assert.equal(outcome.result.relevance, 'relevant');
    assert.deepEqual(outcome.result.monitoringEvidence.evidence, [evidence]);
    const row = await persisted(source.id);
    assert.equal(row.ai_result.monitoringEvidence.status, 'confirmed');
    assert.equal(row.ai_result.monitoringEvidence.evidence[0].manufacturer, 'saic_gm');
    assert.equal(row.content, source.content);
  });
  await t.test('an uncatalogued name cannot be invented from a wrong quote or vague noun', async () => {
    for (const [content, entity, quote] of [
      ['穹曜Z9的驻车录像无法保存', '穹曜Z9', '穹曜Z9的录像正常'],
      ['我的车的驻车录像无法保存', '我的车', '我的车的驻车录像无法保存'],
      ['上汽通用五菱的驻车录像', '上汽通用', '上汽通用五菱的驻车录像'],
    ]) {
      const source = await record(content);
      const outcome = await persistRecordClassification({ record: source, labeled: labeled({ ...baseResult,
        monitoringEvidence: { evidence: [{ source: 'content', quote, entity, entityType: 'model', manufacturer: 'saic_gm' }] },
      }) });
      assert.equal(outcome.result.relevance, 'uncertain', content);
      assert.equal((await persisted(source.id)).content, content);
    }
  });
  await t.test('other tasks retain their relevance and do not acquire a sentry gate', async () => {
    const source = await record('车机不能登录了，怎么恢复？', '车机咨询');
    const outcome = await persistRecordClassification({ record: source, labeled: labeled({ ...baseResult, intent: 'inquiry' }) });
    assert.equal(outcome.result.relevance, 'relevant');
    assert.equal((await persisted(source.id)).ai_result.monitoringEvidence, undefined);
  });
  await t.test('post intent stays independent from relevance', async () => {
    const source = await record('小米汽车的哨兵模式怎么设置？');
    const outcome = await persistRecordClassification({ record: source, labeled: labeled({ ...baseResult, relevance: 'irrelevant', intent: 'inquiry' }) });
    assert.equal(outcome.result.relevance, 'irrelevant');
    assert.equal(outcome.result.intent, 'inquiry');
    assert.equal(outcome.result.sentiment, '');
  });
  await t.test('a manual relevance decision made during model work wins', async () => {
    const source = await record();
    await pool.query(`UPDATE records SET manual_overrides='{"relevance":{"value":"relevant","reason":"人工查看原图确认属于别克"}}', updated_at=now() WHERE id=$1`, [source.id]);
    const outcome = await persistRecordClassification({ record: source, labeled: labeled({ ...baseResult, relevance: 'irrelevant' }) });
    assert.equal(outcome.result.relevance, 'relevant');
    assert.equal(outcome.result.manualRelevanceOverride, true);
    assert.equal(outcome.result.relevanceReason, '人工查看原图确认属于别克');
    assert.equal((await persisted(source.id)).manual_overrides.relevance.value, 'relevant');
  });
  await t.test('changed post text rejects the stale response without marking it labeled', async () => {
    const source = await record('别克哨兵有问题');
    await pool.query('UPDATE records SET content=$2 WHERE id=$1', [source.id, '更新说明：讨论的是其它品牌的哨兵']);
    assert.equal(await persistRecordClassification({ record: source, labeled: labeled() }), null);
    assert.equal((await persisted(source.id)).ai_labeled_at, null);
  });
  await t.test('a newer classification result cannot be replaced by an older response', async () => {
    const source = await record('别克哨兵有问题');
    await pool.query(`UPDATE records SET ai_labeled_at=clock_timestamp(),ai_result='{"relevance":"irrelevant","summary":"新的判断"}' WHERE id=$1`, [source.id]);
    assert.equal(await persistRecordClassification({ record: source, labeled: labeled() }), null);
    assert.equal((await persisted(source.id)).ai_result.summary, '新的判断');
  });
  await t.test('persistence is tenant scoped', async () => {
    const source = await record('别克哨兵有问题');
    assert.equal(await persistRecordClassification({ record: { ...source, tenant_id: randomUUID() }, labeled: labeled() }), null);
    assert.equal((await persisted(source.id)).ai_labeled_at, null);
  });
});
