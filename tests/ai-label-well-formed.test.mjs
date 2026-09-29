import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRecordClassificationResult,
  sanitizePromptText,
  truncatePromptText,
} from '../server/services/ai-labeler.js';
import { normalizeMonitoringKeyword, resolveMonitoringIntent } from '../server/services/monitoring-intent.js';
import { isWellFormed } from '../server/utils/well-formed-text.js';

// ai_result is jsonb. JSON.stringify writes a lone surrogate as a \udXXX escape and
// PostgreSQL rejects the whole document (22P02), so the label write fails and the
// record stays pending. Every string that reaches ai_result must therefore be whole text.
const loneSurrogateEscape = json => /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(json);

test('分类结果里被限长的理由和主题：限制正好落在 emoji 中间时整字丢弃', () => {
  const reason = `${'因'.repeat(499)}💰后面还有很长的说明`; // emoji 占 499、500 两个位置
  assert.equal(isWellFormed(reason.slice(0, 500)), false, '夹具：旧的 slice(0, 500) 会留下半个 emoji');
  const topic = `${'题'.repeat(99)}💰`;
  assert.equal(isWellFormed(topic.slice(0, 100)), false, '夹具：旧的 slice(0, 100) 会留下半个 emoji');

  const result = normalizeRecordClassificationResult({
    relevance: 'relevant', sentiment: 'neutral',
    contentTopicReason: reason, intentReason: reason,
    matchedTopics: [topic, '正常主题', '', null],
  });
  for (const value of [result.contentTopicReason, result.intentReason, ...result.matchedTopics]) {
    assert.equal(isWellFormed(value), true);
  }
  assert.equal(result.contentTopicReason, '因'.repeat(499));
  assert.equal(result.intentReason, '因'.repeat(499));
  assert.deepEqual(result.matchedTopics, ['题'.repeat(99), '正常主题']);
  assert.equal(loneSurrogateEscape(JSON.stringify(result)), false);
});

test('分类结果里没有 emoji 的文本，限长行为与以前完全一致', () => {
  const result = normalizeRecordClassificationResult({
    relevance: 'relevant', sentiment: 'neutral',
    contentTopicReason: `  ${'甲'.repeat(600)}  `,
    intentReason: '短理由',
    matchedTopics: ['乙'.repeat(150), ' 丙 '],
  });
  assert.equal(result.contentTopicReason, '甲'.repeat(500));
  assert.equal(result.intentReason, '短理由');
  assert.deepEqual(result.matchedTopics, ['乙'.repeat(100), '丙']);
  const wide = normalizeRecordClassificationResult({
    relevance: 'relevant', matchedTopics: Array.from({ length: 40 }, (_, i) => `主题${i}`),
  });
  assert.equal(wide.matchedTopics.length, 30);
});

test('监控意图 ID 来自租户关键词的 200 code unit 截断，不能带出孤立代理项', () => {
  const keyword = `${'k'.repeat(199)}💰`;
  assert.equal(isWellFormed(keyword.slice(0, 200)), false, '夹具：旧的 slice(0, 200) 会留下半个 emoji');
  const intent = resolveMonitoringIntent(keyword);
  assert.equal(isWellFormed(intent.intentId), true);
  assert.equal(isWellFormed(normalizeMonitoringKeyword(keyword)), true);
  assert.equal(loneSurrogateEscape(JSON.stringify(intent)), false);
  // 同一个关键词的意图 ID 必须稳定，否则会被当成新的监控意图。
  assert.equal(resolveMonitoringIntent(keyword).intentId, intent.intentId);
  assert.equal(normalizeMonitoringKeyword('  别克 哨兵  '), '别克哨兵');
});

test('提示词清洗沿用同一个 well-formed 实现，行为不变', () => {
  assert.equal(sanitizePromptText(`prefix\uD83D`), 'prefix\uFFFD');
  assert.equal(sanitizePromptText(`\uDCB0suffix`), '\uFFFDsuffix');
  assert.equal(sanitizePromptText('a💰b'), 'a💰b');
  assert.equal(sanitizePromptText(null), '');
  assert.equal(truncatePromptText('123👇', 4), '123👇');
  assert.equal(truncatePromptText('123👇', 3), '123');
});
