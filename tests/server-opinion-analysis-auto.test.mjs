import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  RECORD_ANALYSIS_PROMPT_VERSION,
  applyRecordCommentRiskAttentionPolicy,
  buildTopicFallback,
  classifyTopicRisk,
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

test('关闭评论舆情关注后，评论变化不再污染剖析缓存与风险证据', () => {
  const disabled = clone(BASE_STATE);
  disabled.commentRiskAttentionEnabled = false;
  const disabledHash = computeRecordAnalysisInputHashFromState(disabled);

  const commentsChanged = clone(disabled);
  commentsChanged.record.negative_comment_count = 99;
  commentsChanged.record.latest_negative_comment_at = '2026-07-30T03:00:00.000Z';
  commentsChanged.negativeComments.negative_count = 99;
  commentsChanged.negativeComments.critical_count = 99;
  commentsChanged.negativeComments.latest_negative_updated_at = '2026-07-30T03:00:00.000Z';
  assert.equal(computeRecordAnalysisInputHashFromState(commentsChanged), disabledHash);
  assert.notEqual(disabledHash, computeRecordAnalysisInputHashFromState(BASE_STATE));

  const rawRecord = { id: 'record-1', negative_comment_count: 9, latest_negative_comment_at: '2026-07-30T03:00:00.000Z' };
  const rawComments = [{ content: '不会进入剖析样本', is_negative: true }];
  const projected = applyRecordCommentRiskAttentionPolicy({ record: rawRecord, comments: rawComments }, false);
  assert.equal(projected.record.negative_comment_count, 0);
  assert.equal(projected.record.latest_negative_comment_at, null);
  assert.deepEqual(projected.comments, []);
  assert.equal(rawRecord.negative_comment_count, 9);
  assert.equal(rawComments.length, 1);
});

test('关闭评论关注后，话题定级、摘要和行动建议只消费内容风险', () => {
  const withComments = {
    alertCounts: {}, negativeRate: 0, negativeCount: 0, negativeComments: 10,
    lowFansHighSpreadCount: 0, scopedIssueCount: 0, cliffPct: 0,
    sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
    total: 0, commentRiskAttentionEnabled: true,
  };
  const withoutComments = { ...withComments, commentRiskAttentionEnabled: false };
  assert.equal(classifyTopicRisk(withComments), 'attention');
  assert.equal(classifyTopicRisk(withoutComments), 'watch');

  const fallback = buildTopicFallback({
    stats: {
      commentRiskAttentionEnabled: false,
      topNegative: [], negativeComments: [], keyword: [], platform: [],
      risingRecords: [], volumeTrend: [], trailingTrend: [],
    },
    metrics: withoutComments,
    samples: [],
    sampleMap: {},
    keywords: [],
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-02T00:00:00.000Z'),
  });
  assert.equal(fallback.meta.commentRiskAttentionEnabled, false);
  assert.doesNotMatch(fallback.riskAssessment.riskSummary, /负面评论/u);
  assert.deepEqual(fallback.opinionBreakdown.representativeVoices, []);
  assert.doesNotMatch(fallback.responseStrategy.actions.join('\n'), /负面评论/u);
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
  assert.match(labeler, /await queueNegativeRecordAnalysis\(\{ tenantId, recordId \}\)/);
  assert.match(labeler, /scheduleProcessBackgroundWork\(async \(\) =>/);

  assert.doesNotMatch(syncRoute, /checkAlerts/);
  assert.match(syncRoute, /await labelRecord\(job\.id, \{ force: job\.force === true \}\)/);

  assert.match(analysisRoute, /isValidRecordAnalysisCache/);
  assert.match(analysisRoute, /isRecordAnalysisCacheCurrent/);
  assert.match(analysisRoute, /analyzeOpinionRecordOnce/);
});
