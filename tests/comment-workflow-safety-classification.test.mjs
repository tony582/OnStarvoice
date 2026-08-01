import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildCommentBatchSystemPrompt,
  buildCommentSystemPrompt,
} from '../server/services/ai-labeler.js';
import { classifyComment } from '../server/services/comment-workflow.js';

const SCREENSHOT_COMMENTS = [
  '我的车内第三空间是副驾的小香薰和后排的毛绒靠垫，每次开车都像在自己的小世界里，安全感满满～希望能被幸运砸中，黄金加身，闪闪发光✨',
  '车里第三空间是我宝宝的安全座椅',
  '新年有安吉星相伴，安全感时刻在线',
  '我的车内第三空间是可爱的帕恰狗装饰，每次开车都像在自己的小世界里，安全感满满～希望能被幸运砸中，黄金加身，闪闪发光✨',
];

const BRAND = {
  brandName: '安吉星',
  brandAliases: ['OnStar', '安吉星'],
  businessContext: '汽车车联网和车主服务',
};

test('截图里的普通安全表达不会被评论 fallback 判为负面', () => {
  for (const content of SCREENSHOT_COMMENTS) {
    const result = classifyComment({ content, like_count: 0 }, false);
    assert.equal(result.is_negative, false, content);
    assert.notEqual(result.sentiment, 'negative', content);
    assert.equal(result.risk_level, 'none', content);
  }
});

test('安全相关措辞本身不由 fallback 定性，等待 AI 做语义判断', () => {
  const cases = [
    '这个功能让人觉得很不安全',
    '车辆存在严重安全隐患',
  ];

  for (const content of cases) {
    const result = classifyComment({ content, like_count: 0 }, false);
    assert.equal(result.is_negative, false, content);
    assert.equal(result.sentiment, 'neutral', content);
    assert.equal(result.risk_level, 'none', content);
  }
});

test('独立且明确的事故故障证据仍可由 fallback 保守拦截', () => {
  const result = classifyComment({ content: '刹车失效，已经影响行车安全', like_count: 0 }, false);
  assert.equal(result.is_negative, true);
  assert.equal(result.sentiment, 'negative');
  assert.equal(result.category, 'safety_rescue');
});

test('单条和批量评论 AI 提示都禁止按“安全”裸词判负面', () => {
  const prompts = [
    buildCommentSystemPrompt(BRAND),
    buildCommentBatchSystemPrompt(BRAND),
  ];

  for (const prompt of prompts) {
    assert.match(prompt, /安全感/);
    assert.match(prompt, /安全座椅/);
    assert.match(prompt, /完整句意/);
    assert.match(prompt, /原帖上下文/);
    assert.match(prompt, /评价对象/);
    assert.match(prompt, /一点安全感都没有/);
  }
});

test('启动回填只筛选历史候选，并重新排队给 AI 语义分类', async () => {
  const [serverSource, workflowSource] = await Promise.all([
    readFile(new URL('../server/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/comment-workflow.js', import.meta.url), 'utf8'),
  ]);

  assert.match(serverSource, /comment_safety_semantic_reclassify_v1/);
  assert.match(serverSource, /safetySemanticReviewCandidatesOnly:\s*true/);
  assert.match(serverSource, /queueForAI:\s*true/);
  assert.match(workflowSource, /rc\.is_official = false AND rc\.is_negative = true AND rc\.content LIKE '%安全%'/);
  assert.match(workflowSource, /is_negative = CASE WHEN \$7 THEN is_negative ELSE \$1 END/);
  assert.match(workflowSource, /ai_classified_at = CASE WHEN \$7 THEN NULL ELSE ai_classified_at END/);
  assert.match(workflowSource, /WHERE rc\.ai_classified_at IS NULL/);
});
