import { queryAll, queryOne } from '../db/init.js';
import { PUBLISHED_RECORD_PERIOD_SQL, RELEVANT_RECORD_SQL } from './report-generator.js';

const DIMENSION_VALUES = {
  platform: new Set(['xiaohongshu', 'douyin', 'weibo', 'unknown']),
  sentiment: new Set(['positive', 'neutral', 'negative', 'pending']),
  status: new Set([
    'unhandled',
    'replied',
    'reviewed',
    'reviewed_non_monitor',
    'unavailable',
    'privacy_unreachable',
    'negative_feishu',
    'negative_cold',
  ]),
};

const DIMENSION_LABELS = { platform: '平台', sentiment: '情感', status: '处理模式' };
const VALUE_LABELS = {
  platform: { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博', unknown: '未知平台' },
  sentiment: { positive: '正面', neutral: '中性', negative: '负面', pending: '待标注' },
  status: {
    unhandled: '待处理',
    replied: '已回复',
    reviewed: '已复核',
    reviewed_non_monitor: '已复核-非监控内容',
    unavailable: '已不可见',
    privacy_unreachable: '隐私限制-无法触达',
    negative_feishu: '负面-飞书表',
    negative_cold: '负面-冷处理',
  },
};

const STATUS_SQL = `(
  'unhandled', 'replied', 'reviewed', 'reviewed_non_monitor',
  'unavailable', 'privacy_unreachable', 'negative_feishu', 'negative_cold'
)`;

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeBreakdown(rows, total) {
  return (rows || []).map(row => ({
    key: String(row.key || ''),
    count: num(row.count),
    share: total ? Math.round(num(row.count) / total * 1000) / 10 : 0,
    interactions: num(row.interactions),
    negativeCount: num(row.negative_count),
  }));
}

export function isValidAnalyticsDrilldownSelection(dimension, value) {
  return Boolean(DIMENSION_VALUES[dimension]?.has(value));
}

export async function buildAnalyticsDrilldown({
  tenantId,
  periodStart,
  periodEnd,
  keywords = [],
  dimension,
  value,
}) {
  if (!isValidAnalyticsDrilldownSelection(dimension, value)) {
    throw new Error('invalid analytics drilldown selection');
  }

  const keywordList = (Array.isArray(keywords) ? keywords : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  const params = [tenantId, periodStart.toISOString(), periodEnd.toISOString()];
  const keywordSql = keywordList.length
    ? `AND r.keyword = ANY($${params.push(keywordList)}::text[])`
    : '';
  const selectionParam = `$${params.push(value)}`;
  const selectionSql = {
    platform: `platform = ${selectionParam}`,
    sentiment: `sentiment = ${selectionParam}`,
    status: `status = ${selectionParam}`,
  }[dimension];
  const cte = `
    WITH base AS (
      SELECT DISTINCT
        r.id,
        COALESCE(NULLIF(r.platform, ''), 'unknown') AS platform,
        COALESCE(NULLIF(r.sentiment, ''), 'pending') AS sentiment,
        COALESCE(rt.status, 'unhandled') AS status,
        COALESCE(r.likes, 0) + COALESCE(r.comments_count, 0)
          + COALESCE(r.collects, 0) + COALESCE(r.shares, 0) AS interactions
      FROM records r
      LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
        AND ${RELEVANT_RECORD_SQL}
        AND COALESCE(rt.status, 'unhandled') IN ${STATUS_SQL}
        ${keywordSql}
        AND ${PUBLISHED_RECORD_PERIOD_SQL}
    ), selected AS (
      SELECT * FROM base WHERE ${selectionSql}
    )
  `;

  const [summaryRow, platformRows, sentimentRows, statusRows] = await Promise.all([
    queryOne(`${cte}
      SELECT
        (SELECT COUNT(*) FROM base) AS period_total,
        COUNT(*) AS count,
        COALESCE(SUM(interactions), 0) AS interactions,
        COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative_count
      FROM selected
    `, params),
    queryAll(`${cte}
      SELECT platform AS key, COUNT(*) AS count,
        COALESCE(SUM(interactions), 0) AS interactions,
        COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative_count
      FROM selected GROUP BY platform ORDER BY count DESC, interactions DESC
    `, params),
    queryAll(`${cte}
      SELECT sentiment AS key, COUNT(*) AS count,
        COALESCE(SUM(interactions), 0) AS interactions,
        COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative_count
      FROM selected GROUP BY sentiment ORDER BY count DESC, interactions DESC
    `, params),
    queryAll(`${cte}
      SELECT status AS key, COUNT(*) AS count,
        COALESCE(SUM(interactions), 0) AS interactions,
        COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative_count
      FROM selected GROUP BY status ORDER BY count DESC, interactions DESC
    `, params),
  ]);

  const count = num(summaryRow?.count);
  const periodTotal = num(summaryRow?.period_total);
  const negativeCount = num(summaryRow?.negative_count);
  return {
    selection: {
      dimension,
      dimensionLabel: DIMENSION_LABELS[dimension],
      value,
      label: VALUE_LABELS[dimension][value],
    },
    summary: {
      count,
      shareOfPeriod: periodTotal ? Math.round(count / periodTotal * 1000) / 10 : 0,
      interactions: num(summaryRow?.interactions),
      negativeCount,
      negativeRate: count ? Math.round(negativeCount / count * 1000) / 10 : 0,
    },
    breakdowns: {
      platform: normalizeBreakdown(platformRows, count),
      sentiment: normalizeBreakdown(sentimentRows, count),
      status: normalizeBreakdown(statusRows, count),
    },
  };
}
