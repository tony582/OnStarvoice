import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateNegativePatrolDelta,
  getNegativePatrolAnalytics,
  getNegativePatrolPostTimeline,
  summarizeNegativePatrolRows,
} from '../server/services/negative-patrol-analytics.js';
import {
  __negativePatrolRouteInternals,
} from '../server/routes/negative-patrol.js';
import {
  __reportGeneratorInternals,
} from '../server/services/report-generator.js';

const PERIOD_START = new Date('2026-07-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-07-08T00:00:00.000Z');

function analyticsRow(overrides = {}) {
  return {
    record_id: '11111111-1111-4111-8111-111111111111',
    title: '负面帖子',
    platform: 'douyin',
    keyword: '安吉星',
    category: 'product',
    url: 'https://www.douyin.com/video/123',
    activity_at: '2026-07-04T12:00:00.000Z',
    availability_status: 'available',
    availability_reason: '',
    baseline_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    baseline_captured_at: '2026-07-04T11:00:00.000Z',
    baseline_likes: 10,
    baseline_comments: 5,
    baseline_collects: 2,
    baseline_shares: 1,
    baseline_interaction_total: 18,
    endpoint_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    endpoint_captured_at: '2026-07-04T12:00:00.000Z',
    endpoint_likes: 14,
    endpoint_comments: 8,
    endpoint_collects: 4,
    endpoint_shares: 2,
    endpoint_interaction_total: 28,
    ...overrides,
  };
}

test('first patrol without a task baseline is unmeasured, never fake zero', () => {
  assert.equal(
    calculateNegativePatrolDelta(null, {
      likes: 10,
      comments: 5,
      collects: 2,
      shares: 1,
      interactionTotal: 18,
    }),
    null,
  );
  const result = summarizeNegativePatrolRows([
    analyticsRow({
      baseline_id: null,
      baseline_captured_at: null,
      baseline_likes: null,
      baseline_comments: null,
      baseline_collects: null,
      baseline_shares: null,
      baseline_interaction_total: null,
    }),
  ]);
  assert.equal(result.summary.measuredPosts, 0);
  assert.equal(result.summary.unmeasuredPosts, 1);
  assert.equal(result.summary.interactionDelta, null);
  assert.equal(result.rows[0].patrolStatus, 'baseline_pending');
});

test('a genuine unchanged before-and-after pair reports real zero deltas', () => {
  const snapshot = {
    likes: 10,
    comments_count: 5,
    collects: 2,
    shares: 1,
    interaction_total: 18,
  };
  assert.deepEqual(calculateNegativePatrolDelta(snapshot, snapshot), {
    likes: 0,
    comments: 0,
    collects: 0,
    shares: 0,
    interactionTotal: 0,
    comments_count: 0,
    interaction_total: 0,
  });
});

test('platform and patrol status constrain every returned aggregate', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const rows = [
    analyticsRow(),
    analyticsRow({
      record_id: '22222222-2222-4222-8222-222222222222',
      title: '待形成基线',
      activity_at: '2026-07-05T12:00:00.000Z',
      baseline_id: null,
      endpoint_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }),
    analyticsRow({
      record_id: '33333333-3333-4333-8333-333333333333',
      title: '已删除',
      platform: 'xiaohongshu',
      keyword: '别克',
      availability_status: 'deleted',
    }),
  ];
  const result = await getNegativePatrolAnalytics({
    tenantId: 'tenant-a',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    platform: 'douyin',
    status: 'baseline_pending',
    db: {
      async queryAll(sql, params) {
        capturedSql = sql;
        capturedParams = params;
        return rows;
      },
    },
  });

  assert.match(capturedSql, /metadata->'baseline'->>'observationId'/u);
  assert.match(capturedSql, /latest\.result_observation_id/u);
  assert.match(capturedSql, /\$5::text = '' OR record\.platform = \$5/u);
  assert.doesNotMatch(capturedSql, /captured_at\s*<\s*\$2/u);
  assert.equal(capturedParams[4], 'douyin');
  assert.equal(result.summary.negativePostVolume, 1);
  assert.equal(result.summary.measuredPosts, 0);
  assert.equal(result.summary.unmeasuredPosts, 1);
  assert.equal(result.summary.interactionDelta, null);
  assert.equal(result.trend.reduce((sum, row) => sum + row.negativePostVolume, 0), 1);
  assert.deepEqual(result.platforms.map(row => row.platform), ['douyin']);
  assert.deepEqual(result.topics.map(row => row.keyword), ['安吉星']);
  assert.equal(result.risingRecords.length, 1);
  assert.equal(result.risingRecords[0].patrolStatus, 'baseline_pending');
});

test('deleted content is unavailable even when it has comparable snapshots', async () => {
  const result = await getNegativePatrolAnalytics({
    tenantId: 'tenant-a',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    status: 'unavailable',
    db: {
      async queryAll() {
        return [
          analyticsRow({availability_status: 'deleted'}),
          analyticsRow({
            record_id: '44444444-4444-4444-8444-444444444444',
            availability_status: 'available',
          }),
        ];
      },
    },
  });
  assert.equal(result.summary.negativePostVolume, 1);
  assert.equal(result.summary.unavailableCurrent, 1);
  assert.equal(result.risingRecords[0].patrolStatus, 'unavailable');
});

test('trend and KPI count each record only at its latest patrol in the period', async () => {
  let capturedSql = '';
  const result = await getNegativePatrolAnalytics({
    tenantId: 'tenant-a',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    db: {
      async queryAll(sql) {
        capturedSql = sql;
        return [
          analyticsRow({
            activity_at: '2026-07-02T12:00:00.000Z',
            endpoint_likes: 11,
            endpoint_interaction_total: 19,
          }),
          analyticsRow({
            activity_at: '2026-07-06T12:00:00.000Z',
            endpoint_likes: 15,
            endpoint_interaction_total: 23,
          }),
          analyticsRow({
            record_id: '22222222-2222-4222-8222-222222222222',
            activity_at: '2026-07-03T12:00:00.000Z',
          }),
        ];
      },
    },
  });

  assert.match(capturedSql, /DISTINCT ON \(scoped_record_id\)/u);
  assert.equal(result.summary.negativePostVolume, 2);
  assert.deepEqual(
    result.trend.map(row => [row.date, row.negativePostVolume]),
    [
      ['2026-07-03', 1],
      ['2026-07-06', 1],
    ],
  );
  assert.equal(result.summary.interactionDelta.interactionTotal, 15);
});

test('timeline uses task baseline and result snapshot with UI-compatible fields', async () => {
  const calls = [];
  const result = await getNegativePatrolPostTimeline({
    tenantId: 'tenant-a',
    recordId: '11111111-1111-4111-8111-111111111111',
    db: {
      async queryOne(sql) {
        calls.push(sql);
        return {
          id: '11111111-1111-4111-8111-111111111111',
          title: '负面帖子',
          platform: 'douyin',
          keyword: '安吉星',
          category: 'product',
          url: 'https://www.douyin.com/video/123',
          content_availability_status: 'available',
        };
      },
      async queryAll(sql) {
        calls.push(sql);
        return [{
          ...analyticsRow(),
          item_id: '55555555-5555-4555-8555-555555555555',
          task_id: '66666666-6666-4666-8666-666666666666',
          execution_task_id: null,
          agent_id: '77777777-7777-4777-8777-777777777777',
          agent_name: 'Chrome · macOS',
          status: 'completed',
          created_at: '2026-07-04T11:00:00.000Z',
          updated_at: '2026-07-04T12:00:00.000Z',
          started_at: '2026-07-04T11:30:00.000Z',
          finished_at: '2026-07-04T12:00:00.000Z',
          error_message: null,
        }];
      },
    },
  });

  const timelineSql = calls[1];
  assert.match(timelineSql, /item\.error->>'message'/u);
  assert.doesNotMatch(timelineSql, /item\.error_message/u);
  assert.match(timelineSql, /agent\.display_name/u);
  assert.match(timelineSql, /agent\.client_label/u);
  assert.doesNotMatch(timelineSql, /agent\.name/u);
  assert.equal(result.summary.patrolCount, 1);
  assert.equal(result.runs[0].agent_name, 'Chrome · macOS');
  assert.equal(result.runs[0].started_at, '2026-07-04T11:30:00.000Z');
  assert.equal(result.runs[0].delta.comments_count, 3);
  assert.equal(result.snapshots.length, 2);
});

test('analytics route validates supported filters and explicitly rejects high-risk', () => {
  const {normalizeAnalyticsPeriod} = __negativePatrolRouteInternals;
  const valid = normalizeAnalyticsPeriod({
    periodStart: PERIOD_START.toISOString(),
    periodEnd: PERIOD_END.toISOString(),
    platform: 'douyin',
    status: 'baseline_pending',
  });
  assert.equal(valid.platform, 'douyin');
  assert.equal(valid.status, 'baseline_pending');
  assert.equal(
    normalizeAnalyticsPeriod({platform: 'unknown'}).failure.error,
    'invalid_analytics_platform',
  );
  assert.equal(
    normalizeAnalyticsPeriod({status: 'high_risk'}).failure.error,
    'unsupported_analytics_status',
  );
});

test('management report renders negative patrol volume and preserves unmeasured state', () => {
  const stats = {
    reportKind: 'daily',
    total: 0,
    riskColor: '#059669',
    riskLabel: '平稳',
    negativeRate: 0,
    previousNegativeRate: 0,
    dashboardCards: [],
    platformMatrix: [],
    executiveSummary: [],
    actionItems: [],
    volumeTrend: [],
    trailingTrend: [],
    hotTerms: [],
    platformDistribution: [],
    mediaDistribution: [],
    topicFocus: [],
    regionDistribution: [],
    riskItems: [],
    commentRisks: [],
    alerts: [],
    category: [],
    sentimentMap: {},
    previousSentimentMap: {},
    issueStats: {
      open_issues: 0,
      created_issues: 0,
      closed_issues: 0,
      high_risk_open: 0,
    },
    topIssues: [],
    officialResponses: [],
    officialPeriod: {
      record_count: 0,
      response_count: 0,
    },
    workflowStats: {
      active_inbox: 0,
      issue_linked: 0,
    },
    risingRecords: [],
    collectionRecommendations: [],
    negativePatrol: {
      summary: {
        negativePostVolume: 1,
        measuredPosts: 0,
        unmeasuredPosts: 1,
        unavailableCurrent: 0,
        baselinePending: 1,
        interactionDelta: null,
      },
      trend: [{
        date: '2026-07-06',
        negativePostVolume: 1,
        measuredPosts: 0,
        unmeasuredPosts: 1,
        interactionDelta: null,
      }],
      risingRecords: [{
        recordId: '11111111-1111-4111-8111-111111111111',
        title: '首次负面巡查',
        platform: 'douyin',
        measured: false,
        patrolStatus: 'baseline_pending',
        delta: null,
      }],
    },
  };
  const html = __reportGeneratorInternals.buildManagementReportHTML(
    '测试报告',
    '2026-07-01 - 2026-07-08',
    stats,
  );

  assert.match(html, /负面巡查态势/u);
  assert.match(html, /负面帖子声量/u);
  assert.match(html, /首次负面巡查/u);
  assert.match(html, /未测量/u);
  assert.doesNotMatch(html, />\+0</u);
});
