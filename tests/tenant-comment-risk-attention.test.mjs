import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COMMENT_RISK_ATTENTION_SETTING,
  createCommentRiskAttentionPolicy,
  exposeCommentAttentionCount,
  getCommentRiskAttentionPolicy,
  normalizeCommentRiskAttentionSetting,
  parseCommentRiskAttentionEnabled,
} from '../server/services/comment-risk-attention.js';
import {
  __reportGeneratorInternals,
  applyCommentRiskAttentionPolicy,
  buildInsightSamplePool,
} from '../server/services/report-generator.js';
import { compactAnalyticsDashboard } from '../server/services/analytics-dashboard-payload.js';

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('comment risk attention is tenant-scoped, defaults on, and only explicit off values disable it', async () => {
  assert.equal(COMMENT_RISK_ATTENTION_SETTING, 'comment_risk_attention_enabled');
  assert.equal(parseCommentRiskAttentionEnabled(undefined), true);
  assert.equal(parseCommentRiskAttentionEnabled(''), true);
  assert.equal(parseCommentRiskAttentionEnabled('true'), true);
  assert.equal(parseCommentRiskAttentionEnabled(' FALSE '), false);
  assert.equal(parseCommentRiskAttentionEnabled('0'), false);
  assert.equal(parseCommentRiskAttentionEnabled('off'), false);

  assert.deepEqual(createCommentRiskAttentionPolicy('true'), {
    enabled: true,
  });
  assert.deepEqual(createCommentRiskAttentionPolicy('false'), {
    enabled: false,
  });

  const calls = [];
  const policy = await getCommentRiskAttentionPolicy('tenant-b', async (key, tenantId) => {
    calls.push([key, tenantId]);
    return 'false';
  });
  assert.deepEqual(calls, [[COMMENT_RISK_ATTENTION_SETTING, 'tenant-b']]);
  assert.equal(policy.enabled, false);
});

test('only canonical booleans can be saved and hidden attention counts do not mutate source values', () => {
  assert.equal(normalizeCommentRiskAttentionSetting(' TRUE '), 'true');
  assert.equal(normalizeCommentRiskAttentionSetting(false), 'false');
  assert.equal(normalizeCommentRiskAttentionSetting('off'), null);
  assert.equal(normalizeCommentRiskAttentionSetting(''), null);

  assert.equal(exposeCommentAttentionCount('12', true), 12);
  assert.equal(exposeCommentAttentionCount('12', false), 0);
});

test('migration and settings UI preserve existing tenants and explain the data boundary', async () => {
  const [migration, adminRoute, settingsPage] = await Promise.all([
    source('server/db/migrations/066_tenant_comment_risk_attention.sql'),
    source('server/routes/admin.js'),
    source('web/admin/src/pages/AdminPages.tsx'),
  ]);

  assert.match(migration, /INSERT INTO tenant_settings \(tenant_id, key, value\)[\s\S]*SELECT id, 'comment_risk_attention_enabled', 'true'[\s\S]*FROM tenants/u);
  assert.match(migration, /ON CONFLICT \(tenant_id, key\) DO NOTHING/u);
  assert.match(adminRoute, /normalizeCommentRiskAttentionSetting\(settings\[COMMENT_RISK_ATTENTION_SETTING\]\)/u);
  assert.match(adminRoute, /invalid_comment_risk_attention_setting/u);
  assert.match(adminRoute, /评论值守默认开启[\s\S]*ON CONFLICT \(tenant_id, key\)[\s\S]*DO UPDATE SET value = 'true'/u);

  assert.match(settingsPage, /title="舆情值守范围"/u);
  assert.match(settingsPage, /评论纳入舆情关注/u);
  assert.match(settingsPage, /仍持续采集、AI 标注并保留评论分诊/u);
  assert.match(settingsPage, /settings\.comment_risk_attention_enabled !== 'false'/u);
  assert.match(settingsPage, /group === 'comment-risk'[\s\S]*comment_risk_attention_enabled/u);
});

test('workspace masks comment attention while leaving comment data and explicit issues intact', async () => {
  const workspace = await source('server/routes/workspace.js');

  assert.match(workspace, /getCommentRiskAttentionPolicy\(req\.tenantId\)/u);
  assert.match(workspace, /leadsNew: exposeCommentAttentionCount\(row\?\.leads_new, commentRiskPolicy\.enabled\)/u);
  assert.match(workspace, /commentRiskAttentionEnabled: commentRiskPolicy\.enabled/u);
  assert.match(workspace, /today_comment_leads: exposeCommentAttentionCount/u);
  assert.match(workspace, /period_comment_leads: exposeCommentAttentionCount/u);
  assert.match(workspace, /原始评论线索仍可供评论分诊读取/u);
  assert.match(workspace, /const latestCommentLeads = await queryAll\(`[\s\S]*FROM comment_leads/u);

  assert.match(workspace, /FROM comment_leads cl[\s\S]*cl\.lead_type <> 'sales_intent'/u);
  assert.match(workspace, /FROM issues[\s\S]*status NOT IN \('resolved', 'closed', 'ignored'\)/u);
  assert.doesNotMatch(workspace, /DELETE FROM (?:record_comments|comment_leads)/u);
});

test('mobile removes comment noise from duty surfaces but keeps a neutral route to comment triage', async () => {
  const [badges, mobile] = await Promise.all([
    source('web/admin/src/lib/badges.tsx'),
    source('web/admin/src/mobile/MobileApp.tsx'),
  ]);

  assert.match(badges, /scope: badgeScope,[\s\S]*features:/u);
  assert.match(badges, /badgeState\.scope === badgeScope \? badgeState\.features : EMPTY_FEATURES/u);
  assert.match(badges, /data\.features\?\.commentRiskAttentionEnabled !== false/u);
  assert.match(badges, /loaded: true/u);

  assert.match(mobile, /features\.commentRiskAttentionEnabled \? badges\.leadsNew : 0/u);
  assert.match(mobile, /<TodayPage key=\{tenantId\} openPage=\{openPage\}/u);
  assert.match(mobile, /commentRiskAttentionEnabled \? \[[\s\S]*风险评论待跟进[\s\S]*\] : \[\]/u);
  assert.match(mobile, /commentRiskAttentionEnabled \? \[[\s\S]*title: '评论分诊'[\s\S]*\] : \[\]/u);
  assert.match(mobile, /commentRiskAttentionLoaded && !commentRiskAttentionEnabled[\s\S]*持续采集和标注，不计入当前值守待办/u);
  assert.match(mobile, /近 7 日内容负面[\s\S]*k\.negative_period/u);
});

test('desktop command center keeps content metrics separate and shows comment risk only when enabled', async () => {
  const overview = await source('web/admin/src/pages/OverviewPage.tsx');

  assert.match(overview, /评论风险提醒 · \{commentRiskAttentionEnabled \? '已开启' : '已关闭'\}/u);
  assert.match(overview, /commentRiskAttentionEnabled && \([\s\S]*label="风险评论"[\s\S]*queue: 'leads'/u);
  assert.match(overview, /labeledTotal[\s\S]*sb\.negative[\s\S]*sb\.neutral[\s\S]*sb\.positive/u);
  assert.match(overview, /commentRiskAttentionEnabled \? 'lg:grid-cols-3 xl:grid-cols-5' : 'lg:grid-cols-4'/u);
  assert.match(overview, /label="内容负面"/u);
  assert.match(overview, />内容情感结构</u);
  assert.match(overview, />内容分平台风险</u);
});

test('disabled policy preserves raw comment facts but removes them from risk projections', () => {
  const raw = {
    commentStats: { new_comments: 30, negative_comments: 10, official_comments: 2 },
    negativeComments: [{ id: 'comment-1', content: '风险评论' }],
    commentRegionDistribution: [{ region: '上海', count: 12, negative_count: 6 }],
    sentimentSamples: [{ id: 'record-1', likes: 1, comments_count: 2, collects: 0, shares: 0, negative_comment_count: 8 }],
    topNegative: [{ id: 'record-1', likes: 1, comments_count: 2, collects: 0, shares: 0, negative_comment_count: 8 }],
    topInteraction: [{ id: 'record-1', likes: 1, comments_count: 2, collects: 0, shares: 0, negative_comment_count: 8 }],
    collectionStats: { records_with_negative_comments: 1 },
    sentiment: [],
    alerts: [],
    issueStats: { high_open_issues: 0 },
    workflowStats: { active_inbox: 0, handled_total: 1, status_total: 2 },
    officialPeriod: { record_count: 1 },
    observations: 0,
    total: 1,
  };

  const projected = applyCommentRiskAttentionPolicy(raw, false);
  assert.equal(projected.commentRiskAttentionEnabled, false);
  assert.deepEqual(projected.commentStats, { new_comments: 30, negative_comments: 0, official_comments: 2 });
  assert.deepEqual(projected.negativeComments, []);
  assert.equal(projected.commentRegionDistribution[0].count, 12);
  assert.equal(projected.commentRegionDistribution[0].negative_count, 0);
  assert.equal(projected.topNegative[0].negative_comment_count, 0);
  assert.equal(projected.collectionStats.records_with_negative_comments, 0);

  // 投影不能回写或删除采集、AI 标注后的原始事实。
  assert.equal(raw.commentStats.negative_comments, 10);
  assert.equal(raw.negativeComments.length, 1);
  assert.equal(raw.topNegative[0].negative_comment_count, 8);

  assert.equal(__reportGeneratorInternals.classifyRisk(raw, 0), 'attention');
  assert.equal(__reportGeneratorInternals.classifyRisk(projected, 0), 'watch');
  const rawIndex = __reportGeneratorInternals.buildOpinionIndex(raw, raw, 0, 0);
  const projectedIndex = __reportGeneratorInternals.buildOpinionIndex(projected, projected, 0, 0);
  assert.equal(rawIndex.risk, 30);
  assert.equal(projectedIndex.risk, 0);
  assert.ok(rawIndex.heat > projectedIndex.heat);
  assert.ok(rawIndex.response > projectedIndex.response);
  assert.match(__reportGeneratorInternals.buildActionItems(raw, 0, 'attention').join('\n'), /负面评论/u);
  assert.doesNotMatch(__reportGeneratorInternals.buildActionItems(projected, 0, 'watch').join('\n'), /负面评论|新增负评/u);
  assert.equal(Object.hasOwn(buildInsightSamplePool(projected).samples[0], 'negComments'), false);

  const compact = compactAnalyticsDashboard(projected);
  assert.equal(compact.commentRiskAttentionEnabled, false);
  assert.equal(compact.commentStats.negative_comments, 0);
  assert.deepEqual(compact.commentRisks, []);
});

test('reports, analytics cache, and opinion analysis consume the same tenant policy', async () => {
  const [reportGenerator, analyticsRoute, opinionAnalysis] = await Promise.all([
    source('server/services/report-generator.js'),
    source('server/routes/analytics.js'),
    source('server/services/opinion-analysis.js'),
  ]);

  assert.match(reportGenerator, /getCommentRiskAttentionPolicy\(tenantId\)/u);
  assert.match(reportGenerator, /if \(send && existing\?\.status === 'sent'\) return existing;[\s\S]*getCommentRiskAttentionPolicy\(tenantId\)/u);
  assert.match(reportGenerator, /negativeCommentWeightSql[\s\S]*commentRiskAttentionEnabled/u);
  assert.match(reportGenerator, /applyCommentRiskAttentionPolicy\(rawStats, commentRiskAttentionEnabled\)/u);
  assert.match(reportGenerator, /includeCommentRisk \? renderReportCard\('负面评论/u);
  assert.match(reportGenerator, /禁止把评论作为风险判断、用户诉求或处置建议的依据/u);

  assert.match(analyticsRoute, /dashboardCacheKey\(tenantId, period, keywords, commentRiskAttentionEnabled\)/u);
  assert.match(analyticsRoute, /commentRiskAttentionEnabled \? 'comment-risk:on' : 'comment-risk:off'/u);
  assert.match(analyticsRoute, /buildAnalyticsDashboard\([\s\S]*commentRiskAttentionEnabled/u);
  assert.match(analyticsRoute, /features: \{[\s\S]*commentRiskAttentionEnabled: dashboard\.commentRiskAttentionEnabled/u);

  assert.match(opinionAnalysis, /applyRecordCommentRiskAttentionPolicy/u);
  assert.match(opinionAnalysis, /commentRiskAttentionEnabled \? await queryAll\(/u);
  assert.match(opinionAnalysis, /commentRiskAttentionEnabled: commentRiskPolicy\.enabled/u);
  assert.match(opinionAnalysis, /commentRiskAttentionEnabled && cm/u);
  assert.match(opinionAnalysis, /禁止把评论作为定级、研判或关注点的依据/u);
});
