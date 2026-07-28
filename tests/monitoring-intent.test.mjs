import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatMonitoringIntentForPrompt,
  listKnownMonitoringIntents,
  normalizeMonitoringKeyword,
  resolveMonitoringIntent,
} from '../server/services/monitoring-intent.js';
import {
  RECORD_CLASSIFICATION_PROMPT_VERSION,
  buildSystemPrompt,
  buildUserMessage,
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
  assert.match(standard, /优先级高于宽泛品牌背景/);
});

test('后台最终标注显式携带采集关键词并使用同一任务标准', () => {
  assert.equal(RECORD_CLASSIFICATION_PROMPT_VERSION, 'record-topic-v2');
  const intent = resolveMonitoringIntent('凯迪拉克OTA');
  const prompt = buildSystemPrompt(BRAND, intent);
  const userMessage = buildUserMessage({
    keyword: '凯迪拉克OTA',
    title: '凯迪拉克碰撞测试',
    content: '只介绍碰撞表现，没有软件升级内容。',
  });

  assert.match(prompt, /必须同时核对“目标对象”和“目标主题”/);
  assert.match(prompt, /与OTA或软件升级无关的凯迪拉克车辆问题/);
  assert.match(prompt, /“凯迪拉克碰撞测试”在“凯迪拉克OTA”任务中 irrelevant/);
  assert.match(prompt, /“安全感”“安全配置可靠”等正向表达不能据此生成风险或负面结论/);
  assert.match(userMessage, /采集关键词（仅表示召回入口，不代表一定相关）：凯迪拉克OTA/);
});

test('未知关键词保留租户实体但不做宽泛品牌扩展', () => {
  const intent = resolveMonitoringIntent('临时测试主题', { brand: BRAND });
  assert.equal(intent.source, 'server_keyword_fallback');
  assert.deepEqual(intent.targetContent, ['临时测试主题']);
  assert.match(intent.notes, /不进行宽泛品牌扩展/);
});
