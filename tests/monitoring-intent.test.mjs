import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatMonitoringIntentForPrompt,
  formatTenantMonitoringScopeForPrompt,
  listKnownMonitoringIntents,
  normalizeMonitoringKeyword,
  resolveMonitoringIntent,
  resolveTenantMonitoringScope,
} from '../server/services/monitoring-intent.js';
import {
  RECORD_CLASSIFICATION_PROMPT_VERSION,
  applyManualRelevanceOverride,
  buildSystemPrompt,
  buildUserMessage,
  normalizeRecordClassificationResult,
} from '../server/services/ai-labeler.js';

const CUSTOMER_KEYWORDS = [
  '别克壁纸',
  '凯迪拉克壁纸',
  '安吉星',
  '上汽通用客服',
  '别克哨兵',
  '至境哨兵',
  'ibuick',
  '别克远控',
  '别克APP',
  '别克车机',
  '凯迪拉克车机',
  '别克OTA',
  '凯迪拉克OTA',
];

const BRAND = {
  brandName: '安吉星',
  brandAliases: ['OnStar', '别克', '凯迪拉克'],
  businessContext: '上汽通用品牌家族和车联网服务',
  positiveContextTerms: ['车联网', '远程控制'],
  noiseTerms: ['地名', '谐音'],
};

test('统一监测标准完整覆盖客户的 13 个关键词', () => {
  const actual = listKnownMonitoringIntents().map(intent => normalizeMonitoringKeyword(intent.keyword));
  const expected = CUSTOMER_KEYWORDS.map(normalizeMonitoringKeyword);
  assert.deepEqual(new Set(actual), new Set(expected));
  assert.equal(actual.length, 13);

  const scope = resolveTenantMonitoringScope(BRAND);
  assert.deepEqual(new Set(scope.keywords.map(normalizeMonitoringKeyword)), new Set(expected));
  assert.ok(scope.targetEntity.includes('安吉星'));
  assert.ok(scope.targetEntity.includes('别克'));
  assert.ok(scope.targetEntity.includes('凯迪拉克'));
  assert.ok(scope.targetContent.includes('道路或紧急救援'));
  assert.match(formatTenantMonitoringScopeForPrompt(scope), /全部监测关键词/);
});

test('关键词标准忽略空格和大小写，并要求对象与主题同时命中', () => {
  const intent = resolveMonitoringIntent(' 别克 OTA ');
  assert.equal(intent.intentId, 'monitoring-topic:buick-ota');
  assert.equal(intent.objective, 'feature_monitoring');
  assert.ok(intent.targetEntity.includes('别克'));
  assert.ok(intent.targetContent.includes('OTA升级'));
  assert.ok(intent.exclusions.some(item => item.includes('机械故障')));
});

test('壁纸是内容发现任务，安全感不是风险结论', () => {
  const intent = resolveMonitoringIntent('凯迪拉克壁纸');
  assert.equal(intent.objective, 'content_discovery');
  assert.ok(intent.targetContent.includes('车机壁纸'));

  const prompt = buildSystemPrompt(BRAND, intent);
  assert.match(prompt, /内容相关与内容负面是两个独立结论/);
  assert.match(prompt, /“安全”“安全感”“隐私”等普通词本身不代表负面或风险/);
});

test('至境哨兵不会扩展为所有至境车型舆情', () => {
  const intent = resolveMonitoringIntent('至境哨兵');
  const standard = formatMonitoringIntentForPrompt(intent);
  assert.match(standard, /目标对象：至境、别克至境/);
  assert.match(standard, /目标主题：哨兵模式、驻车监控/);
  assert.match(standard, /胎噪/);
  assert.match(standard, /只用于判断 currentKeywordMatch/);
});

test('后台最终标注以整体范围为准并保留当前关键词归属', () => {
  assert.equal(RECORD_CLASSIFICATION_PROMPT_VERSION, 'record-topic-v4');
  const intent = resolveMonitoringIntent('凯迪拉克OTA');
  const prompt = buildSystemPrompt(BRAND, intent);
  const userMessage = buildUserMessage({
    keyword: '凯迪拉克OTA',
    observed_keywords: ['凯迪拉克OTA', '安吉星'],
    title: '凯迪拉克碰撞测试',
    content: '只介绍碰撞表现，没有软件升级内容。',
    comments_text: '评论只是讨论碰撞成绩。',
  });

  assert.match(prompt, /租户整体监控范围/);
  assert.match(prompt, /currentKeywordMatch/);
  assert.match(prompt, /与OTA或软件升级无关的凯迪拉克车辆问题/);
  assert.match(prompt, /凯迪拉克CT5经常莫名拨打紧急救援电话/);
  assert.match(prompt, /昂科威plus远程失败/);
  assert.match(prompt, /安吉星，一生黑/);
  assert.match(prompt, /“安全感”“安全配置可靠”等正向表达不能据此生成风险或负面结论/);
  assert.match(prompt, /评论区不属于主贴判断证据/);
  assert.match(prompt, /不能反向把中性或正向主贴判为 negative/);
  assert.match(userMessage, /当前记录关键词（仅表示最近召回入口）：凯迪拉克OTA/);
  assert.match(userMessage, /全部召回关键词[\s\S]*安吉星/);
  assert.doesNotMatch(userMessage, /评论只是讨论碰撞成绩/);
  assert.doesNotMatch(userMessage, /评论上下文/);
});

test('整体无关不再伪装成中性，整体相关投诉保持负面', () => {
  const irrelevant = normalizeRecordClassificationResult({
    relevance: 'irrelevant',
    currentKeywordMatch: 'irrelevant',
    sentiment: 'negative',
    category: 'brand_image',
  });
  assert.equal(irrelevant.sentiment, '');
  assert.equal(irrelevant.sentimentStatus, 'not_applicable');
  assert.equal(irrelevant.category, 'other');

  const complaint = normalizeRecordClassificationResult({
    relevance: 'relevant',
    currentKeywordMatch: 'irrelevant',
    matchedTopics: ['安吉星', '续费套餐', '官方客服体验'],
    sentiment: 'negative',
    sentimentStatus: 'classified',
    intent: 'complaint',
    category: 'renewal_billing',
  });
  assert.equal(complaint.relevance, 'relevant');
  assert.equal(complaint.currentKeywordMatch, 'irrelevant');
  assert.equal(complaint.sentiment, 'negative');
  assert.equal(complaint.category, 'renewal_billing');
});

test('人工确认整体相关时先保护相关性，再保留模型识别出的负面情感', () => {
  const protectedResult = normalizeRecordClassificationResult(
    applyManualRelevanceOverride({
      relevance: 'irrelevant',
      currentKeywordMatch: 'irrelevant',
      relevanceReason: '旧模型只按当前关键词判断',
      sentiment: 'negative',
      intent: 'complaint',
      category: 'service_quality',
    }, {
      relevance: {
        value: 'relevant',
        reason: '人工确认属于上汽通用整体监测范围',
      },
    }),
  );

  assert.equal(protectedResult.relevance, 'relevant');
  assert.equal(protectedResult.manualRelevanceOverride, true);
  assert.equal(protectedResult.sentiment, 'negative');
  assert.equal(protectedResult.sentimentStatus, 'classified');
  assert.equal(protectedResult.category, 'service_quality');
});

test('未知关键词保留租户实体但不做宽泛品牌扩展', () => {
  const intent = resolveMonitoringIntent('临时测试主题', { brand: BRAND });
  assert.equal(intent.source, 'server_keyword_fallback');
  assert.deepEqual(intent.targetContent, ['临时测试主题']);
  assert.match(intent.notes, /不进行宽泛品牌扩展/);
});
