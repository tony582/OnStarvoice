import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { persistRecordClassification } from '../../../server/services/ai-labeler.js';
import { resolveMonitoringIntent, resolveTenantMonitoringScope } from '../../../server/services/monitoring-intent.js';
import { serviceAdScreenshot as screenshot, screenshotAdRoles, servicePromotionFixture } from '../../fixtures/onstar-service-ad-fixture.mjs';


test('third-party OnStar service advertisements persist neutral without erasing genuine complaints or manual decisions', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`第三方服务广告验证 ${randomUUID()}`])).rows[0].id;
  t.after(async () => { await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]); await closePool(); });
  const base = { relevance: 'relevant', sentiment: 'negative', intent: 'complaint', intentReason: '原模型把广告担忧当作投诉', category: 'privacy', summary: '原模型负面结论', confidence: .94,
    servicePromotion: servicePromotionFixture({ content: screenshot }, screenshotAdRoles) };
  const labeled = result => ({ result, provider: 'fixture', model: 'synthetic', intent: resolveMonitoringIntent('安吉星'), tenantScope: resolveTenantMonitoringScope({ brandName: '安吉星' }) });
  async function source(content = screenshot) {
    const id = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,content,keyword)
      VALUES($1,$2,'douyin',$4,'',$3,'安吉星')`, [id, tenant, content, id]);
    return (await pool.query('SELECT *,ai_labeled_at::text AS classification_version FROM records WHERE id=$1', [id])).rows[0];
  }
  const persisted = async id => (await pool.query('SELECT * FROM records WHERE id=$1', [id])).rows[0];

  await t.test('screenshot is neutral for negative and positive model outputs with source and original judgment preserved', async () => {
    for (const sentiment of ['negative', 'positive']) {
      const record = await source();
      const modelResult = { ...base, sentiment };
      const saved = await persistRecordClassification({ record, labeled: labeled(modelResult) });
      assert.equal(saved.result.sentiment, 'neutral');
      const row = await persisted(record.id);
      assert.equal(row.sentiment, 'neutral');
      assert.equal(row.intent, 'advertising');
      assert.equal(row.ai_result.relevance, 'relevant');
      assert.equal(row.ai_result.sentimentStatus, 'classified');
      assert.equal(row.ai_result.classifierMetadata.promptVersion, 'record-topic-v7');
      assert.equal(row.ai_result.serviceAdJudgment.originalModel.sentiment, sentiment);
      assert.equal(row.ai_result.serviceAdJudgment.originalModel.summary, base.summary);
      const evidence = row.ai_result.serviceAdJudgment.evidence;
      for (const item of [evidence.brand, evidence.service, evidence.offer, ...evidence.statements]) assert.ok(row[item.source].includes(item.quote));
      assert.equal(row.content, screenshot);
      assert.equal(row.business_visibility, record.business_visibility);
      assert.deepEqual(row.manual_overrides, record.manual_overrides);
    }
  });
  await t.test('generic privacy fears in marketing do not become a real brand complaint', async () => {
    for (const pain of ['买家担心隐私泄露、不敢买二手车？', '买家怕被跟踪、不敢买二手车？']) {
      const content = `我们帮您拆除安吉星、清理旧GPS，并提供第三方安保系统安装。${pain}预约检测，出具报告更放心。`;
      const record = await source(content);
      await persistRecordClassification({ record, labeled: labeled({ ...base,
        servicePromotion: servicePromotionFixture({ content }, ['service_offer', 'marketing_pain_point', 'marketing_benefit']) }) });
      const row = await persisted(record.id);
      assert.equal(row.sentiment, 'neutral');
      assert.equal(row.intent, 'advertising');
      assert.equal(row.ai_result.serviceAdJudgment.originalModel.sentiment, 'negative');
    }
  });
  await t.test('merchant attacks, owner complaints and quoted criticism retain negative sentiment', async () => {
    for (const content of [
      '我的安吉星总是定位失败，想拆除GPS，商家说我们提供拆除服务。我要投诉。',
      '本店专业拆除GPS、安吉星，安吉星偷偷监听车主，欢迎咨询。',
      '刷到广告“我们帮你拆除安吉星，提供GPS检测服务”，这种商家真是坑人。',
      '安吉星就是智商税，花钱买个摆设。本店提供安吉星拆除服务，欢迎到店咨询。',
      '车主反馈安吉星已经三天连不上了，每次打开APP都一直转圈。我们提供安吉星检测服务，欢迎到店咨询。',
      '本店提供安吉星拆除服务，这东西就是交钱买个摆设，欢迎到店咨询。',
      '本店专业拆除安吉星这种交钱买个摆设的东西，欢迎到店咨询。',
      '本店提供安吉星拆除服务让大家不再交钱买摆设，欢迎到店咨询。',
    ]) {
      const record = await source(content);
      await persistRecordClassification({ record, labeled: labeled({ ...base, servicePromotion: servicePromotionFixture({ content }) }) });
      const row = await persisted(record.id);
      assert.equal(row.sentiment, 'negative');
      assert.equal(row.intent, 'complaint');
      assert.equal(row.ai_result.serviceAdJudgment, undefined);
    }
  });
  await t.test('keyword-only OnStar and explicitly unrelated ads do not get the normalization', async () => {
    const unrelated = await source('我们提供比亚迪GPS检测拆除服务，欢迎咨询。');
    await persistRecordClassification({ record: unrelated, labeled: labeled({ ...base, relevance: 'irrelevant' }) });
    const unrelatedRow = await persisted(unrelated.id);
    assert.equal(unrelatedRow.sentiment, '');
    assert.equal(unrelatedRow.ai_result.sentimentStatus, 'not_applicable');
    assert.equal(unrelatedRow.ai_result.serviceAdJudgment, undefined);
    const noBrand = await source('我们提供GPS定位器检测拆除服务，欢迎到店咨询。#安吉星');
    await persistRecordClassification({ record: noBrand, labeled: labeled(base), observedKeywords: ['安吉星'] });
    assert.equal((await persisted(noBrand.id)).sentiment, 'negative');
  });
  await t.test('manual sentiment changed while the model ran remains authoritative', async () => {
    const record = await source();
    await pool.query(`UPDATE records SET sentiment='negative',manual_overrides='{"sentiment":{"value":"negative","reason":"人工复核"}}' WHERE id=$1`, [record.id]);
    await persistRecordClassification({ record, labeled: labeled({ ...base, sentiment: 'positive' }) });
    const row = await persisted(record.id);
    assert.equal(row.sentiment, 'negative');
    assert.equal(row.ai_result.sentiment, 'negative');
    assert.equal(row.ai_result.serviceAdJudgment.sentimentApplied, false);
    assert.equal(row.ai_result.serviceAdJudgment.manualSentimentProtected, true);
    assert.equal(row.ai_result.serviceAdJudgment.originalModel.sentiment, 'positive');
    assert.equal(row.manual_overrides.sentiment.reason, '人工复核');
  });
  await t.test('manual irrelevant decision keeps sentiment not applicable', async () => {
    const record = await source();
    await pool.query(`UPDATE records SET manual_overrides='{"relevance":{"value":"irrelevant"}}' WHERE id=$1`, [record.id]);
    await persistRecordClassification({ record, labeled: labeled(base) });
    const row = await persisted(record.id);
    assert.equal(row.ai_result.relevance, 'irrelevant');
    assert.equal(row.sentiment, '');
    assert.equal(row.ai_result.sentimentStatus, 'not_applicable');
  });
  await t.test('source changed to a complaint after the model ran cannot be rewritten as a neutral ad', async () => {
    const record = await source();
    await pool.query('UPDATE records SET content=$2 WHERE id=$1', [record.id, '我的安吉星故障一直没有解决，我要投诉。']);
    assert.equal(await persistRecordClassification({ record, labeled: labeled(base) }), null);
    const row = await persisted(record.id);
    assert.equal(row.ai_labeled_at, null);
    assert.equal(row.content, '我的安吉星故障一直没有解决，我要投诉。');
  });
});
