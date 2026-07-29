import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  RECORD_ANALYSIS_PROMPT_VERSION,
  computeRecordAnalysisInputHashFromState,
  isRecordAnalysisCacheCurrent,
  isValidRecordAnalysisCache,
  shouldAutoAnalyzeRecord,
  withRecordAnalysisSingleFlight,
} from '../server/services/opinion-analysis.js';

const BASE_STATE = {
  record: {
    title: '安吉星无法刷新',
    content: '持续多天无法刷新，客服建议续费。',
    sentiment: 'negative',
    ai_summary: '用户投诉 App 无法刷新',
    likes: 10,
    comments_count: 4,
    collects: 2,
    shares: 1,
    negative_comment_count: 2,
    latest_negative_comment_at: '2026-07-29T01:00:00.000Z',
    transcript: '',
    transcript_analysis: null,
  },
  latestObservation: {
    likes: 10,
    comments_count: 4,
    collects: 2,
    shares: 1,
    interaction_total: 17,
  },
  alerts: [{ level: 'warning', reason: '负面评论增加', interaction_total: 17 }],
  negativeComments: {
    negative_count: 2,
    negative_likes: 5,
    critical_count: 0,
    high_count: 1,
    medium_count: 1,
    low_count: 0,
    latest_negative_updated_at: '2026-07-29T01:00:00.000Z',
  },
  ocr: { count: 2, latest_updated_at: '2026-07-29T00:30:00.000Z' },
};

function clone(value) {
  return structuredClone(value);
}

test('单条剖析缓存必须同时匹配 input hash 与 prompt version', () => {
  const inputHash = computeRecordAnalysisInputHashFromState(BASE_STATE);
  const cached = {
    payload: { overview: { summary: '已生成' } },
    analysis_source: 'llm',
    prompt_version: RECORD_ANALYSIS_PROMPT_VERSION,
    input_hash: inputHash,
  };

  assert.equal(isRecordAnalysisCacheCurrent(cached, inputHash), true);
  assert.equal(isValidRecordAnalysisCache(cached, inputHash, { allowRuleFallback: false }), true);
  assert.equal(isRecordAnalysisCacheCurrent({ ...cached, prompt_version: 'record-old' }, inputHash), false);
  assert.equal(isRecordAnalysisCacheCurrent({ ...cached, input_hash: 'old-hash' }, inputHash), false);
  assert.equal(
    isValidRecordAnalysisCache(
      { ...cached, analysis_source: 'rule_fallback' },
      inputHash,
      { allowRuleFallback: false },
    ),
    false,
  );
});

test('自动深度剖析只接受负面内容', () => {
  assert.equal(shouldAutoAnalyzeRecord({ sentiment: 'negative' }), true);
  assert.equal(shouldAutoAnalyzeRecord({ sentiment: ' negative ' }), true);
  assert.equal(shouldAutoAnalyzeRecord({ sentiment: 'neutral' }), false);
  assert.equal(shouldAutoAnalyzeRecord({ sentiment: 'positive' }), false);
  assert.equal(shouldAutoAnalyzeRecord({}), false);
});

test('同一输入并发只执行一次，完成后允许新输入再次执行', async () => {
  let runs = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = async () => {
    runs += 1;
    await gate;
    return 'done';
  };

  const first = withRecordAnalysisSingleFlight('tenant:record:hash', runner);
  const second = withRecordAnalysisSingleFlight('tenant:record:hash', runner);
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(runs, 1);

  release();
  assert.deepEqual(await Promise.all([first, second]), ['done', 'done']);
  assert.equal(runs, 1);

  assert.equal(
    await withRecordAnalysisSingleFlight('tenant:record:new-hash', async () => {
      runs += 1;
      return 'new';
    }),
    'new',
  );
  assert.equal(runs, 2);
});

test('互动快照、风险预警与负面评论变化都会使 input hash 失效', () => {
  const baseHash = computeRecordAnalysisInputHashFromState(BASE_STATE);

  const interactionChanged = clone(BASE_STATE);
  interactionChanged.latestObservation.comments_count = 5;
  interactionChanged.latestObservation.interaction_total = 18;
  assert.notEqual(computeRecordAnalysisInputHashFromState(interactionChanged), baseHash);

  const alertChanged = clone(BASE_STATE);
  alertChanged.alerts[0].level = 'critical';
  assert.notEqual(computeRecordAnalysisInputHashFromState(alertChanged), baseHash);

  const negativeCommentChanged = clone(BASE_STATE);
  negativeCommentChanged.negativeComments.high_count = 2;
  negativeCommentChanged.negativeComments.latest_negative_updated_at = '2026-07-29T02:00:00.000Z';
  assert.notEqual(computeRecordAnalysisInputHashFromState(negativeCommentChanged), baseHash);
});

test('分类落库后异步派生，sync 不再重复触发 alert，手动路由也按新 hash 防旧缓存', async () => {
  const [labeler, syncRoute, analysisRoute] = await Promise.all([
    readFile(new URL('../server/services/ai-labeler.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/routes/sync.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/routes/opinion-analysis.js', import.meta.url), 'utf8'),
  ]);

  assert.match(labeler, /RETURNING tenant_id, sentiment/);
  assert.match(labeler, /sentiment !== 'negative'/);
  assert.match(labeler, /import\('\.\/opinion-analysis\.js'\)/);
  assert.match(labeler, /void queueNegativeRecordAnalysis\(\{ tenantId, recordId \}\)/);
  assert.match(labeler, /setImmediate\(async \(\) =>/);

  assert.doesNotMatch(syncRoute, /checkAlerts/);
  assert.match(syncRoute, /await labelRecord\(id\)/);

  assert.match(analysisRoute, /isValidRecordAnalysisCache/);
  assert.match(analysisRoute, /isRecordAnalysisCacheCurrent/);
  assert.match(analysisRoute, /analyzeOpinionRecordOnce/);
});
