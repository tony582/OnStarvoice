import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CONTENT_TOPIC_LABELS, CONTENT_TOPIC_PROMPT_RULES, normalizeContentTopic, appendContentTopicFilter } from '../server/services/content-topic.js';
import { normalizeRecordClassificationResult } from '../server/services/ai-labeler.js';
import { validateManualFields } from '../server/routes/records.js';

test('content topics are seven single values; missing, unrelated and malformed results stay unclassified', () => {
  assert.equal(Object.keys(CONTENT_TOPIC_LABELS).length, 7);
  for (const topic of Object.keys(CONTENT_TOPIC_LABELS)) {
    assert.equal(normalizeContentTopic(topic), topic);
    assert.equal(validateManualFields({ contentTopic: topic }).values.contentTopic, topic);
  }
  for (const topic of [undefined, null, '', [], {}, ['onstar'], 'other', 'onstar,wallpaper', '__proto__']) {
    assert.equal(normalizeContentTopic(topic), null);
  }
  for (const topic of [false, {}, ['onstar'], 'other']) assert.equal(validateManualFields({ contentTopic: topic }).ok, false);
  assert.equal(validateManualFields({ contentTopic: null }).values.contentTopic, null);
  assert.equal(validateManualFields({ contentTopic: '' }).values.contentTopic, null);
});

test('topic does not change overall relevance or intent, and outside monitoring can still have a GM topic', () => {
  for (const relevance of ['relevant', 'uncertain', 'irrelevant']) {
    const result = normalizeRecordClassificationResult({ relevance, intent: 'inquiry', sentiment: 'negative', contentTopic: 'gm_other', contentTopicReason: '主要咨询别克购车价格' });
    assert.equal(result.contentTopic, 'gm_other');
    assert.equal(result.relevance, relevance);
    assert.equal(result.intent, 'inquiry');
  }
  assert.equal(normalizeRecordClassificationResult({ relevance: 'irrelevant' }).contentTopic, null);
});

test('topic SQL preserves tenant parameters and rejects invalid filters instead of exporting all rows', () => {
  const params = ['tenant'];
  assert.equal(appendContentTopicFilter('WHERE r.tenant_id = $1', params, 'wallpaper'), 'WHERE r.tenant_id = $1 AND r.content_topic = $2');
  assert.deepEqual(params, ['tenant', 'wallpaper']);
  assert.match(appendContentTopicFilter('WHERE r.tenant_id = $1', ['tenant'], 'unclassified'), /content_topic IS NULL/);
  for (const bad of ['other', ['wallpaper'], "' OR true --", {}]) {
    assert.throws(() => appendContentTopicFilter('WHERE r.tenant_id = $1', ['tenant'], bad), error => error.status === 400 && error.code === 'invalid_content_topic');
  }
});

test('frontend and backend agree on all labels and the prompt specifies evidence-based main-object selection', () => {
  const ui = readFileSync(new URL('../web/admin/src/lib/content-topic.ts', import.meta.url), 'utf8');
  for (const [value, label] of Object.entries(CONTENT_TOPIC_LABELS)) assert.ok(ui.includes(`{ value: '${value}', label: '${label}' }`));
  assert.match(CONTENT_TOPIC_PROMPT_RULES, /核心诉求/);
  assert.match(CONTENT_TOPIC_PROMPT_RULES, /标题重心/);
  assert.match(CONTENT_TOPIC_PROMPT_RULES, /OTA后壁纸消失/);
  assert.match(CONTENT_TOPIC_PROMPT_RULES, /监控范围外/);
  assert.match(CONTENT_TOPIC_PROMPT_RULES, /上汽通用五菱/);
});
