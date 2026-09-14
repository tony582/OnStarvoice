import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt, normalizeRecordClassificationResult } from '../server/services/ai-labeler.js';
import { findOnstarServiceAdEvidence, normalizeOnstarServiceAdJudgment, ONSTAR_SERVICE_AD_RULE_VERSION } from '../server/services/onstar-service-ad-judgment.js';
import { serviceAdScreenshot as screenshot, screenshotAdRoles, servicePromotionFixture } from './fixtures/onstar-service-ad-fixture.mjs';

const base = { relevance: 'relevant', sentiment: 'negative', sentimentStatus: 'classified', intent: 'complaint', summary: '模型认为隐私担忧是负面', category: 'privacy' };
const asAd = (record, roles, result = base) => ({ ...result, servicePromotion: servicePromotionFixture(record, roles) });
const citations = evidence => [evidence.brand, evidence.service, evidence.offer, ...evidence.statements];

test('screenshot service marketing normalizes conflicting model sentiments to neutral and intent other with original evidence', () => {
  for (const sentiment of ['negative', 'positive', 'neutral']) {
    const record = { content: screenshot };
    const input = asAd(record, screenshotAdRoles, { ...base, sentiment });
    const result = normalizeOnstarServiceAdJudgment(input, record);
    assert.equal(result.sentiment, 'neutral');
    assert.equal(result.intent, 'other');
    assert.equal(result.relevance, 'relevant');
    assert.equal(result.serviceAdJudgment.version, ONSTAR_SERVICE_AD_RULE_VERSION);
    assert.equal(result.serviceAdJudgment.originalModel.sentiment, sentiment);
    assert.equal(result.serviceAdJudgment.originalModel.intent, 'complaint');
    assert.equal(result.serviceAdJudgment.sentimentApplied, true);
    for (const item of citations(result.serviceAdJudgment.evidence)) {
      assert.equal(item.source, 'content');
      assert.ok(screenshot.includes(item.quote));
      assert.ok(!item.quote.includes('#'));
    }
    assert.deepEqual(input, asAd(record, screenshotAdRoles, { ...base, sentiment }));
    assert.equal(record.content, screenshot);
  }
});

for (const [name, record, roles] of [
  ['ordinary merchant removal offer', { content: '本店专业承接安吉星、GPS定位器拆除检测服务，欢迎咨询预约。' }],
  ['OnStar Latin spelling', { content: '我们提供 OnStar 设备拆卸服务，GPS定位检查、出具报告，欢迎到店咨询。' }],
  ['full-width spelling', { content: '本店提供ＯｎＳｔａｒ拆除、ＧＰＳ检测服务，欢迎预约。' }],
  ['brand title and service body', { title: '安吉星设备处理服务', content: '我们提供GPS定位设备排查、检测及拆除服务，预约上门。' }, ['contact_or_header', 'service_offer']],
  ['third-party security system installation', { content: '安吉星车辆服务：我们提供第三方安保系统加装，安装GDCAB安保系统，欢迎咨询。' }],
  ['trusted current transcript', { title: '安吉星设备服务介绍', video_url: 'https://example.test/current.mp4', transcript_source_url: 'https://example.test/current.mp4', transcript_status: 'done', transcript: screenshot }, ['contact_or_header', ...screenshotAdRoles]],
  ['generic buyer privacy marketing pain point', { content: '我们帮您拆除安吉星、清理旧GPS，并提供第三方安保系统安装。买家担心隐私泄露、不敢买二手车？预约检测，出具报告更放心。' }, ['service_offer', 'marketing_pain_point', 'marketing_benefit']],
  ['generic buyer tracking marketing pain point', { content: '我们帮您拆除安吉星、清理旧GPS，并提供第三方安保系统安装。买家怕被跟踪、不敢买二手车？预约检测，出具报告更放心。' }, ['service_offer', 'marketing_pain_point', 'marketing_benefit']],
]) {
  test(`pure service advertisement: ${name}`, () => {
    const result = normalizeOnstarServiceAdJudgment(asAd(record, roles), record);
    assert.equal(result.sentiment, 'neutral');
    assert.equal(result.intent, 'other');
    for (const evidence of citations(result.serviceAdJudgment.evidence)) assert.ok(String(record[evidence.source]).includes(evidence.quote));
  });
}

for (const [name, content] of [
  ['owner complaint', '我的车安吉星定位故障一直修不好，想拆除GPS。商家说我们提供拆除服务，我要维权。'],
  ['owner experience without complaint word', '我花了200元去本店拆除安吉星，GPS检测后还是无法启动。我们提供安装服务这话不可信。'],
  ['quoted ad criticism', '刷到广告说“我们帮你拆除旧GPS、安吉星，安装GDCAB安保系统”，这种广告别信。'],
  ['merchant attack', '本店专业拆除GPS、安吉星。安吉星偷偷监听车主，是垃圾，欢迎咨询。'],
  ['merchant inserts brand failure', '安吉星设备频繁失灵。我们提供GPS检测拆除服务，欢迎预约。'],
  ['merchant inserts plain criticism', '安吉星难用又不靠谱，本店提供GPS定位器拆除服务，欢迎到店。'],
  ['real brand praise', '安吉星非常好用，值得推荐。本店另提供GPS定位器检测拆除服务，欢迎咨询。'],
  ['negated removal', '我们不拆除安吉星，提供GPS定位器检测服务，欢迎咨询。'],
  ['negated service offer', '本店不提供GPS和安吉星拆除服务，欢迎预约其他安保系统加装。'],
  ['prohibition', '请勿拆除安吉星。本店提供GPS定位器检查服务，欢迎到店。'],
  ['other brand ad', '我们提供比亚迪GPS定位器拆除和安保系统加装服务，欢迎咨询。'],
  ['only service with phone', '安吉星拆除 GPS 检查 19153159289'],
  ['genuine inquiry', '安吉星可以拆除吗，怎么找人检测GPS？'],
  ['seller phone unrelated to offered service', '本店出售别克旧车，安吉星使用正常。咨询19153159289，想知道GPS定位器怎样拆除。'],
  ['independent brand criticism not in negative vocabulary', '安吉星就是智商税，花钱买个摆设。本店提供安吉星拆除服务，欢迎到店咨询。'],
  ['reported owner malfunction without fault keyword', '车主反馈安吉星已经三天连不上了，每次打开APP都一直转圈。我们提供安吉星检测服务，欢迎到店咨询。'],
  ['quoted advertisement followed by independent criticism', '“我们提供安吉星和GPS拆除服务，欢迎到店咨询。”这种生意是在制造恐慌，纯粹割韭菜。'],
  ['a merchant offer cannot swallow an independent attack in the same sentence', '本店提供安吉星拆除服务，这东西就是交钱买个摆设，欢迎到店咨询。'],
  ['a service noun cannot swallow a derogatory assessment of the brand', '本店专业拆除安吉星这种交钱买个摆设的东西，欢迎到店咨询。'],
  ['a service benefit cannot disguise derogatory brand language', '本店提供安吉星拆除服务让大家不再交钱买摆设，欢迎到店咨询。'],
]) {
  test(`do not erase source meaning: ${name}`, () => {
    const result = asAd({ content });
    assert.equal(findOnstarServiceAdEvidence({ content }, result), null);
    assert.deepEqual(normalizeOnstarServiceAdJudgment(result, { content }), result);
  });
}

test('keywords, comments, author names and standalone hashtags cannot supply main-post brand evidence', () => {
  const content = '我们提供GPS检测拆除服务，欢迎到店咨询。';
  for (const extra of [
    { keyword: '安吉星', observed_keywords: ['安吉星拆除'] },
    { comments: [{ content: '安吉星可以拆除' }] },
    { author_name: '安吉星设备服务', author: '安吉星' },
    { content: `${content} #安吉星 #OnStar` },
    { content: `${content} ＃安吉星` },
  ]) {
    const record = { content, ...extra };
    const result = asAd(record);
    assert.deepEqual(normalizeOnstarServiceAdJudgment(result, record), result);
  }
});

test('stale or unfinished transcripts cannot supply advertisement evidence', () => {
  for (const extra of [
    { transcript_status: 'done', transcript_source_url: 'https://example.test/old.mp4' },
    { transcript_status: 'pending', transcript_source_url: 'https://example.test/current.mp4' },
    { transcript_status: 'done' },
  ]) {
    const record = { video_url: 'https://example.test/current.mp4', transcript: screenshot, ...extra };
    const result = asAd(record, screenshotAdRoles);
    assert.deepEqual(normalizeOnstarServiceAdJudgment(result, record), result);
  }
});

test('irrelevant posts remain not applicable and uncertain relevance is not upgraded', () => {
  const irrelevant = normalizeRecordClassificationResult({ ...base, relevance: 'irrelevant' });
  assert.deepEqual(normalizeOnstarServiceAdJudgment(irrelevant, { content: screenshot }), irrelevant);
  const uncertain = normalizeOnstarServiceAdJudgment(asAd({ content: screenshot }, screenshotAdRoles, { ...base, relevance: 'uncertain' }), { content: screenshot });
  assert.equal(uncertain.relevance, 'uncertain');
  assert.equal(uncertain.sentiment, 'neutral');
});

test('manual sentiment is protected and raw model judgment remains separately auditable', () => {
  for (const manual_overrides of [{ sentiment: { value: 'negative' } }, JSON.stringify({ sentiment: true })]) {
    const model = asAd({ content: screenshot }, screenshotAdRoles);
    const result = normalizeOnstarServiceAdJudgment({ ...model, sentiment: 'neutral' }, { content: screenshot, sentiment: 'negative', manual_overrides }, model);
    assert.equal(result.sentiment, 'negative');
    assert.equal(result.intent, 'other');
    assert.equal(result.serviceAdJudgment.manualSentimentProtected, true);
    assert.equal(result.serviceAdJudgment.sentimentApplied, false);
    assert.equal(result.serviceAdJudgment.originalModel.sentiment, 'negative');
  }
});

test('source keywords or a model isAd flag alone cannot force neutral', () => {
  assert.deepEqual(normalizeOnstarServiceAdJudgment(base, { content: screenshot }), base);
  const result = { ...base, isAd: true, servicePromotion: { type: 'third_party_service_ad', speaker: 'merchant', brandEvaluation: 'none' } };
  assert.deepEqual(normalizeOnstarServiceAdJudgment(result, { content: screenshot }), result);
});

test('a concrete negative statement outside the ad cannot be omitted from model evidence', () => {
  const ad = '本店提供安吉星拆除服务，欢迎到店咨询。';
  const content = `安吉星就是智商税，花钱买个摆设。${ad}`;
  const result = asAd({ content: ad }, [], { ...base, evidence: ['安吉星就是智商税'] });
  assert.deepEqual(normalizeOnstarServiceAdJudgment(result, { content }), result);
});

test('structured ad claims require exact complete source sentences and bounded size', () => {
  const record = { content: '本店提供安吉星拆除服务，欢迎到店咨询。' };
  for (const mutate of [
    value => { value.servicePromotion.speaker = 'quoted'; },
    value => { value.servicePromotion.brandEvaluation = 'negative'; },
    value => { value.servicePromotion.type = 'mixed'; },
    value => { value.servicePromotion.statements[0].quote = '提供安吉星拆除服务'; },
    value => { value.servicePromotion.statements[0].source = 'comment'; },
    value => { value.servicePromotion.statements[0].role = 'owner_experience'; },
    value => { value.servicePromotion.statements = Array(21).fill(value.servicePromotion.statements[0]); },
    value => { value.servicePromotion.statements[0].quote = '服'.repeat(401); },
  ]) {
    const result = asAd(record);
    mutate(result);
    assert.deepEqual(normalizeOnstarServiceAdJudgment(result, record), result);
  }
});

test('service statements may not swallow another sentence of brand criticism', () => {
  const content = '本店提供安吉星拆除服务，欢迎到店咨询。安吉星就是智商税。';
  const result = { ...base, servicePromotion: { type: 'third_party_service_ad', speaker: 'merchant', brandEvaluation: 'none',
    statements: [{ source: 'content', quote: content, role: 'service_offer' }] } };
  assert.deepEqual(normalizeOnstarServiceAdJudgment(result, { content }), result);
});

test('model-supplied normalization audit claims are discarded', () => {
  const result = normalizeOnstarServiceAdJudgment({ ...base, serviceAdJudgment: { sentimentApplied: true } }, { content: '安吉星不好用' });
  assert.deepEqual(result, base);
});

test('classification prompt distinguishes third-party service ads from complaints and brand sentiment', () => {
  const prompt = buildSystemPrompt({ brandName: '安吉星', brandAliases: [], businessContext: '', positiveContextTerms: [], noiseTerms: [] });
  assert.match(prompt, /第三方商家推广安吉星设备拆除/u);
  assert.match(prompt, /sentiment=neutral、intent=other/u);
  assert.match(prompt, /宣传第三方服务也不是对安吉星的好评/u);
  assert.match(prompt, /商家广告夹带/u);
});
