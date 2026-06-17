/**
 * 报表生成器 - 企业舆情日报/周报/月报
 *
 * 参考专业 social listening 报告结构：声量、情绪、主题、风险、处置、行动。
 */

import { queryOne, queryAll, execute, withTransaction, getSetting } from '../db/init.js';
import { sendReportEmail } from './email-notifier.js';

const SENTIMENT_LABEL = { positive: '正面', neutral: '中性', negative: '负面' };
const SENTIMENT_COLOR = { positive: '#059669', neutral: '#6B7280', negative: '#DC2626' };
const CATEGORY_LABEL = {
  safety_rescue: '安全救援',
  feature_usage: '功能使用',
  renewal_billing: '续费收费',
  privacy: '隐私安全',
  app_issue: 'App问题',
  service_quality: '服务质量',
  brand_image: '品牌形象',
  official_response: '官方响应',
  other: '其他',
};
const PLATFORM_LABEL = {
  xiaohongshu: '小红书',
  weibo: '微博',
  douyin: '抖音',
  unknown: '未知平台',
};
const RISK_LEVEL_LABEL = {
  watch: '平稳观察',
  attention: '需要关注',
  warning: '风险预警',
  critical: '重点处置',
};
const RISK_LEVEL_COLOR = {
  watch: '#059669',
  attention: '#2563EB',
  warning: '#D97706',
  critical: '#DC2626',
};
const ISSUE_STATUS_LABEL = {
  new: '新建',
  triage: '分诊中',
  in_progress: '处理中',
  waiting: '等待反馈',
  review: '复核中',
  resolved: '已解决',
  closed: '已关闭',
  ignored: '忽略',
};
const TRIAGE_LABEL = {
  unhandled: '待处理',
  reviewing: '待复核',
  issue_linked: '已转工单',
  ticketed: '已转工单',
  official_responded: '官方已响应',
  archived: '已归档',
  false_positive: '误报',
};
const RELEVANT_RECORD_SQL = "(r.ai_result->>'relevance' IS DISTINCT FROM 'irrelevant')";

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function n0(value) {
  return Math.round(num(value)).toLocaleString('zh-CN');
}

function pct(part, total, digits = 1) {
  const denominator = num(total);
  if (denominator <= 0) return 0;
  return Number((num(part) / denominator * 100).toFixed(digits));
}

function compactText(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function shanghaiStart(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day) - 8 * 3600000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function addMonthsStart(year, month, offset) {
  return new Date(Date.UTC(year, month - 1 + offset, 1) - 8 * 3600000);
}

function periodFor(type, now = new Date()) {
  const parts = shanghaiParts(now);
  const todayStart = shanghaiStart(parts.year, parts.month, parts.day);
  if (type === 'weekly') {
    const localDay = new Date(todayStart.getTime() + 8 * 3600000).getUTCDay();
    const daysSinceMonday = (localDay + 6) % 7;
    const thisMonday = addDays(todayStart, -daysSinceMonday);
    return { start: addDays(thisMonday, -7), end: thisMonday };
  }
  if (type === 'monthly') {
    const thisMonth = addMonthsStart(parts.year, parts.month, 0);
    return { start: addMonthsStart(parts.year, parts.month, -1), end: thisMonth };
  }
  return { start: addDays(todayStart, -1), end: todayStart };
}

function previousPeriod(periodStart, periodEnd) {
  const duration = periodEnd.getTime() - periodStart.getTime();
  return {
    start: new Date(periodStart.getTime() - duration),
    end: periodStart,
  };
}

function dateLabel(date) {
  return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function rowNum(row, key) {
  return num(row?.[key]);
}

async function scalar(sql, params, key = 'n') {
  const row = await queryOne(sql, params);
  return rowNum(row, key);
}

function normalizeRows(rows = [], numberKeys = []) {
  return rows.map(row => {
    const next = { ...row };
    for (const key of numberKeys) next[key] = num(next[key]);
    return next;
  });
}

async function getReportStats(tenantId, periodStart, periodEnd) {
  const params = [tenantId, periodStart.toISOString(), periodEnd.toISOString()];
  const observedWhere = `
    FROM record_observations ro
    JOIN records r ON r.id = ro.record_id AND r.tenant_id = ro.tenant_id
    WHERE ro.tenant_id = $1 AND ro.captured_at >= $2 AND ro.captured_at < $3
      AND ${RELEVANT_RECORD_SQL}
  `;
  const periodWhere = `
    FROM records r
    WHERE r.tenant_id = $1
      AND ${RELEVANT_RECORD_SQL}
      AND (
        (r.created_at >= $2 AND r.created_at < $3)
        OR EXISTS (
          SELECT 1 FROM record_observations ro
          WHERE ro.record_id = r.id
            AND ro.tenant_id = r.tenant_id
            AND ro.captured_at >= $2
            AND ro.captured_at < $3
        )
      )
  `;
  const observedCte = `
    WITH observed AS (
      SELECT DISTINCT
        r.id, r.platform, r.title, r.content, r.url, r.cover_url, r.author_name, r.author_id,
        r.author_avatar, r.author_fans, r.blogger_profile_url, r.note_type, r.source_type,
        r.tags, r.image_urls, r.payload,
        r.sentiment, r.category, r.intent, r.keyword, r.ai_summary,
        r.likes, r.comments_count, r.collects, r.shares, r.official_response_status,
        r.official_replied, r.negative_comment_count, r.latest_negative_comment_at,
        r.created_at, r.last_seen_at
      ${periodWhere}
    )
  `;

  const total = await scalar(`SELECT COUNT(DISTINCT r.id) as n ${periodWhere}`, params);
  const newRecords = await scalar(
    `SELECT COUNT(*) as n FROM records r
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
       AND ${RELEVANT_RECORD_SQL}`,
    params
  );
  const updatedRecords = await scalar(
    `SELECT COUNT(DISTINCT r.id) as n ${observedWhere} AND r.created_at < $2`,
    params
  );
  const observations = await scalar(
    `SELECT COUNT(*) as n
     FROM record_observations ro
     JOIN records r ON r.id = ro.record_id AND r.tenant_id = ro.tenant_id
     WHERE ro.tenant_id = $1 AND ro.captured_at >= $2 AND ro.captured_at < $3
       AND ${RELEVANT_RECORD_SQL}`,
    params
  );
  const pendingLabel = await scalar(
    `${observedCte} SELECT COUNT(*) as n FROM observed WHERE sentiment = ''`,
    params
  );

  const sentiment = normalizeRows(await queryAll(
    `${observedCte}
     SELECT sentiment, COUNT(*) as count
     FROM observed
     WHERE sentiment <> ''
     GROUP BY sentiment
     ORDER BY count DESC`,
    params
  ), ['count']);

  const category = normalizeRows(await queryAll(
    `${observedCte}
     SELECT category,
       COUNT(*) as count,
       COUNT(*) FILTER (WHERE sentiment = 'negative') as negative_count,
       SUM(likes + comments_count + collects + shares) as interaction_total
     FROM observed
     WHERE category <> ''
     GROUP BY category
     ORDER BY count DESC, negative_count DESC`,
    params
  ), ['count', 'negative_count', 'interaction_total']);

  const platform = normalizeRows(await queryAll(
    `${observedCte}
     SELECT platform,
       COUNT(*) as count,
       COUNT(*) FILTER (WHERE sentiment = 'negative') as negative_count,
       SUM(likes + comments_count + collects + shares) as interaction_total
     FROM observed
     GROUP BY platform
     ORDER BY count DESC`,
    params
  ), ['count', 'negative_count', 'interaction_total']);

  const intent = normalizeRows(await queryAll(
    `${observedCte}
     SELECT intent, COUNT(*) as count
     FROM observed
     WHERE intent <> ''
     GROUP BY intent
     ORDER BY count DESC
     LIMIT 8`,
    params
  ), ['count']);

  const keyword = normalizeRows(await queryAll(
    `${observedCte}
     SELECT keyword,
       COUNT(*) as count,
       COUNT(*) FILTER (WHERE sentiment = 'negative') as negative_count,
       SUM(likes + comments_count + collects + shares) as interaction_total
     FROM observed
     WHERE keyword <> ''
     GROUP BY keyword
     ORDER BY count DESC, interaction_total DESC
     LIMIT 10`,
    params
  ), ['count', 'negative_count', 'interaction_total']);

  const volumeTrend = normalizeRows(await queryAll(
    `SELECT
       to_char(ro.captured_at AT TIME ZONE 'Asia/Shanghai', 'MM-DD') as label,
       date_trunc('day', ro.captured_at AT TIME ZONE 'Asia/Shanghai') as day_bucket,
       COUNT(DISTINCT ro.record_id) as total,
       COUNT(DISTINCT ro.record_id) FILTER (WHERE r.sentiment = 'positive') as positive,
       COUNT(DISTINCT ro.record_id) FILTER (WHERE r.sentiment = 'neutral') as neutral,
       COUNT(DISTINCT ro.record_id) FILTER (WHERE r.sentiment = 'negative') as negative,
       COUNT(DISTINCT ro.record_id) FILTER (WHERE r.sentiment = '') as pending
     FROM record_observations ro
     JOIN records r ON r.id = ro.record_id AND r.tenant_id = ro.tenant_id
     WHERE ro.tenant_id = $1 AND ro.captured_at >= $2 AND ro.captured_at < $3
       AND ${RELEVANT_RECORD_SQL}
     GROUP BY day_bucket, label
     ORDER BY day_bucket ASC`,
    params
  ), ['total', 'positive', 'neutral', 'negative', 'pending']);

  const mediaDistribution = normalizeRows(await queryAll(
    `${observedCte}
     SELECT COALESCE(
       NULLIF(payload->>'mediaType', ''),
       NULLIF(payload->>'media_type', ''),
       NULLIF(note_type, ''),
       NULLIF(source_type, ''),
       '未采集'
     ) as media_type,
       COUNT(*) as count,
       COUNT(*) FILTER (WHERE sentiment = 'negative') as negative_count
     FROM observed
     GROUP BY media_type
     ORDER BY count DESC
     LIMIT 8`,
    params
  ), ['count', 'negative_count']);

  // 内容地域:本帖 payload 取不到时,用「该作者在别处已知的属地」回填(博主发的内容沿用博主 IP),
  // 仍取不到才记未采集。OWN_REGION 逐层兜底(顶层/detailPayload/items[0] × publishLocation/region/ipLocation)。
  const OWN_REGION = `COALESCE(
    NULLIF(payload->>'publishLocation', ''),
    NULLIF(payload->>'region', ''),
    NULLIF(payload->>'ipLocation', ''),
    NULLIF(payload->>'ip_location', ''),
    NULLIF(payload->'detailPayload'->>'publishLocation', ''),
    NULLIF(payload->'detailPayload'->>'region', ''),
    NULLIF(payload->'detailPayload'->>'ipLocation', ''),
    NULLIF(payload->'detailPayload'->>'ip_location', ''),
    NULLIF(payload->'items'->0->>'publishLocation', ''),
    NULLIF(payload->'items'->0->>'region', ''),
    NULLIF(payload->'items'->0->>'ipLocation', '')
  )`;
  const regionDistribution = normalizeRows(await queryAll(
    `${observedCte}, author_loc AS (
       SELECT author_id, mode() WITHIN GROUP (ORDER BY own_region) AS region
       FROM (
         SELECT author_id, ${OWN_REGION} AS own_region
         FROM records
         WHERE tenant_id = $1 AND COALESCE(author_id, '') <> ''
       ) s
       WHERE own_region IS NOT NULL AND own_region <> ''
       GROUP BY author_id
     )
     SELECT COALESCE(${OWN_REGION}, al.region, '未采集') AS region,
       COUNT(*) as count,
       COUNT(*) FILTER (WHERE o.sentiment = 'negative') as negative_count
     FROM observed o
     LEFT JOIN author_loc al ON al.author_id = o.author_id AND COALESCE(o.author_id, '') <> ''
     GROUP BY 1
     ORDER BY count DESC
     LIMIT 8`,
    params
  ), ['count', 'negative_count']);

  // 评论地域:评论自带 IP 属地,数据最全,单列一份口径供「内容 / 评论」切换
  const commentRegionDistribution = normalizeRows(await queryAll(
    `${observedCte}
     SELECT COALESCE(NULLIF(rc.ip_location, ''), '未采集') AS region,
       COUNT(*) as count,
       COUNT(*) FILTER (WHERE rc.is_negative) as negative_count
     FROM record_comments rc
     JOIN observed o ON o.id = rc.record_id
     WHERE rc.tenant_id = $1 AND rc.is_official = false
     GROUP BY 1
     ORDER BY count DESC
     LIMIT 8`,
    params
  ), ['count', 'negative_count']);

  const sentimentSamples = normalizeRows(await queryAll(
    `${observedCte}
     SELECT *
     FROM observed
     WHERE sentiment <> ''
     ORDER BY (
       comments_count * 3 + shares * 3 + likes + collects + COALESCE(negative_comment_count, 0) * 20
     ) DESC, last_seen_at DESC
     LIMIT 24`,
    params
  ), ['likes', 'comments_count', 'collects', 'shares', 'negative_comment_count', 'author_fans']);

  const topNegative = normalizeRows(await queryAll(
    `${observedCte}
     SELECT *
     FROM observed
     WHERE sentiment = 'negative'
     ORDER BY (
       comments_count * 3 + shares * 3 + likes + collects + COALESCE(negative_comment_count, 0) * 20
     ) DESC, last_seen_at DESC
     LIMIT 8`,
    params
  ), ['likes', 'comments_count', 'collects', 'shares', 'negative_comment_count', 'author_fans']);

  const topInteraction = normalizeRows(await queryAll(
    `${observedCte}
     SELECT *
     FROM observed
     ORDER BY (likes + comments_count + collects + shares) DESC, last_seen_at DESC
     LIMIT 10`,
    params
  ), ['likes', 'comments_count', 'collects', 'shares', 'negative_comment_count', 'author_fans']);

  const risingRecords = normalizeRows(await queryAll(
    `WITH obs AS (
       SELECT record_id,
         COUNT(*) as snapshots,
         MIN(interaction_total) as min_interaction,
         MAX(interaction_total) as max_interaction,
         MAX(captured_at) as last_captured_at
       FROM record_observations
       WHERE tenant_id = $1 AND captured_at >= $2 AND captured_at < $3
       GROUP BY record_id
     )
     SELECT r.id, r.title, r.url, r.platform, r.author_name, r.sentiment, r.ai_summary,
       r.likes, r.comments_count, r.collects, r.shares,
       obs.snapshots,
       GREATEST(obs.max_interaction - obs.min_interaction, 0) as interaction_growth
     FROM obs
     JOIN records r ON r.id = obs.record_id AND r.tenant_id = $1
     WHERE obs.snapshots > 1
       AND ${RELEVANT_RECORD_SQL}
     ORDER BY interaction_growth DESC, obs.last_captured_at DESC
     LIMIT 8`,
    params
  ), ['likes', 'comments_count', 'collects', 'shares', 'snapshots', 'interaction_growth']);

  const topAuthors = normalizeRows(await queryAll(
    `${observedCte}
     SELECT author_name,
       MAX(author_fans) as author_fans,
       COUNT(*) as count,
       COUNT(*) FILTER (WHERE sentiment = 'negative') as negative_count,
       SUM(likes + comments_count + collects + shares) as interaction_total
     FROM observed
     WHERE author_name <> ''
     GROUP BY author_name
     ORDER BY negative_count DESC, interaction_total DESC
     LIMIT 8`,
    params
  ), ['author_fans', 'count', 'negative_count', 'interaction_total']);

  const issueStats = await queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND first_seen_at < $3) as new_issues,
       COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'closed', 'ignored')) as open_issues,
       COUNT(*) FILTER (WHERE severity IN ('high', 'critical') AND status NOT IN ('resolved', 'closed', 'ignored')) as high_open_issues,
       COUNT(*) FILTER (WHERE status IN ('resolved', 'closed') AND updated_at >= $2 AND updated_at < $3) as resolved_issues
     FROM issues
     WHERE tenant_id = $1`,
    params
  );

  const topIssues = normalizeRows(await queryAll(
    `SELECT id, title, severity, status, owner_name, summary, suggested_action,
       record_count, first_seen_at, last_seen_at, updated_at
     FROM issues
     WHERE tenant_id = $1
       AND (
         first_seen_at >= $2 AND first_seen_at < $3
         OR last_seen_at >= $2 AND last_seen_at < $3
         OR status NOT IN ('resolved', 'closed', 'ignored')
       )
     ORDER BY
       CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
       updated_at DESC
     LIMIT 8`,
    params
  ), ['record_count']);

  const alerts = normalizeRows(await queryAll(
    `SELECT a.level, COUNT(*) as count
     FROM alerts a
     LEFT JOIN records r ON r.id = a.record_id AND r.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.created_at >= $2 AND a.created_at < $3
       AND (a.record_id IS NULL OR ${RELEVANT_RECORD_SQL})
     GROUP BY a.level`,
    params
  ), ['count']);

  const topAlerts = normalizeRows(await queryAll(
    `SELECT a.id, a.level, a.title, a.summary, a.reason, a.url, a.interaction_total, a.created_at
     FROM alerts a
     LEFT JOIN records r ON r.id = a.record_id AND r.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.created_at >= $2 AND a.created_at < $3
       AND (a.record_id IS NULL OR ${RELEVANT_RECORD_SQL})
     ORDER BY CASE a.level WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
       a.interaction_total DESC, a.created_at DESC
     LIMIT 6`,
    params
  ), ['interaction_total']);

  const commentStats = await queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE rc.created_at >= $2 AND rc.created_at < $3) as new_comments,
       COUNT(*) FILTER (WHERE rc.is_negative = true AND rc.last_seen_at >= $2 AND rc.last_seen_at < $3) as negative_comments,
       COUNT(*) FILTER (WHERE rc.is_official = true AND rc.last_seen_at >= $2 AND rc.last_seen_at < $3) as official_comments
     FROM record_comments rc
     JOIN records r ON r.id = rc.record_id AND r.tenant_id = rc.tenant_id
     WHERE rc.tenant_id = $1
       AND ${RELEVANT_RECORD_SQL}`,
    params
  );

  const negativeComments = normalizeRows(await queryAll(
    `SELECT rc.id, rc.record_id, rc.platform, rc.author_name, rc.author_avatar, rc.content, rc.like_count,
       rc.risk_level, rc.sentiment, rc.category, rc.published_at, rc.last_seen_at,
       r.title as record_title, r.url as record_url, r.cover_url as record_cover_url, r.author_name as record_author_name
     FROM record_comments rc
     JOIN records r ON r.id = rc.record_id AND r.tenant_id = rc.tenant_id
     WHERE rc.tenant_id = $1
       AND ${RELEVANT_RECORD_SQL}
       AND rc.is_negative = true
       AND rc.last_seen_at >= $2
       AND rc.last_seen_at < $3
     ORDER BY
       CASE rc.risk_level WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END DESC,
       rc.like_count DESC,
       rc.last_seen_at DESC
     LIMIT 10`,
    params
  ), ['like_count']);

  const officialResponses = normalizeRows(await queryAll(
    `SELECT o.id, o.record_id, o.platform, o.account_name, o.content, o.published_at, o.created_at,
       r.title as record_title, r.url as record_url
     FROM official_responses o
     JOIN records r ON r.id = o.record_id AND r.tenant_id = o.tenant_id
     WHERE o.tenant_id = $1 AND o.created_at >= $2 AND o.created_at < $3
       AND ${RELEVANT_RECORD_SQL}
     ORDER BY o.created_at DESC
     LIMIT 8`,
    params
  ), []);

  const officialPeriod = await queryOne(
    `SELECT COUNT(*) as response_count, COUNT(DISTINCT o.record_id) as record_count
     FROM official_responses o
     JOIN records r ON r.id = o.record_id AND r.tenant_id = o.tenant_id
     WHERE o.tenant_id = $1 AND o.created_at >= $2 AND o.created_at < $3
       AND ${RELEVANT_RECORD_SQL}`,
    params
  );

  const workflowStats = await queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE r.official_response_status = 'responded') as official_responded,
       COUNT(*) FILTER (
         WHERE COALESCE(rt.status, 'unhandled') IN ('unhandled', 'reviewing')
           AND r.record_type <> 'official_content'
           AND NOT (r.official_response_status = 'responded' AND r.negative_comment_count = 0)
       ) as active_inbox,
       COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'unhandled') as unhandled,
       COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'reviewing') as reviewing,
       COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') IN ('issue_linked', 'ticketed')) as issue_linked,
       COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'archived') as archived,
       COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'false_positive') as false_positive
     FROM records r
     LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
     WHERE r.tenant_id = $1
       AND ${RELEVANT_RECORD_SQL}`,
    [tenantId]
  );

  const triagePeriod = normalizeRows(await queryAll(
    `${observedCte}
     SELECT COALESCE(rt.status, 'unhandled') as status, COUNT(*) as count
     FROM observed o
     LEFT JOIN record_triage rt ON rt.record_id = o.id AND rt.tenant_id = $1
     GROUP BY COALESCE(rt.status, 'unhandled')
     ORDER BY count DESC`,
    params
  ), ['count']);

  const collectionStats = await queryOne(
    `${observedCte}
     SELECT
       COUNT(*) FILTER (WHERE sentiment <> '' OR ai_summary <> '') as ai_labeled_records,
       COUNT(*) FILTER (WHERE content <> '') as records_with_content,
       COUNT(*) FILTER (WHERE cover_url <> '') as records_with_cover,
       COUNT(*) FILTER (WHERE negative_comment_count > 0) as records_with_negative_comments
     FROM observed`,
    params
  );

  return {
    total,
    newRecords,
    updatedRecords,
    observations,
    pendingLabel,
    sentiment,
    category,
    platform,
    intent,
    keyword,
    volumeTrend,
    sentimentTrend: volumeTrend,
    mediaDistribution,
    regionDistribution,
    commentRegionDistribution,
    sentimentSamples,
    topNegative,
    topInteraction,
    risingRecords,
    topAuthors,
    issueStats: {
      new_issues: rowNum(issueStats, 'new_issues'),
      open_issues: rowNum(issueStats, 'open_issues'),
      high_open_issues: rowNum(issueStats, 'high_open_issues'),
      resolved_issues: rowNum(issueStats, 'resolved_issues'),
    },
    topIssues,
    alerts,
    topAlerts,
    commentStats: {
      new_comments: rowNum(commentStats, 'new_comments'),
      negative_comments: rowNum(commentStats, 'negative_comments'),
      official_comments: rowNum(commentStats, 'official_comments'),
    },
    negativeComments,
    officialResponses,
    officialPeriod: {
      response_count: rowNum(officialPeriod, 'response_count'),
      record_count: rowNum(officialPeriod, 'record_count'),
    },
    workflowStats: {
      official_responded: rowNum(workflowStats, 'official_responded'),
      active_inbox: rowNum(workflowStats, 'active_inbox'),
      unhandled: rowNum(workflowStats, 'unhandled'),
      reviewing: rowNum(workflowStats, 'reviewing'),
      issue_linked: rowNum(workflowStats, 'issue_linked'),
      archived: rowNum(workflowStats, 'archived'),
      false_positive: rowNum(workflowStats, 'false_positive'),
    },
    triagePeriod,
    collectionStats: {
      ai_labeled_records: rowNum(collectionStats, 'ai_labeled_records'),
      records_with_content: rowNum(collectionStats, 'records_with_content'),
      records_with_cover: rowNum(collectionStats, 'records_with_cover'),
      records_with_negative_comments: rowNum(collectionStats, 'records_with_negative_comments'),
    },
  };
}

function sentimentMap(stats) {
  const map = { positive: 0, neutral: 0, negative: 0 };
  for (const item of stats.sentiment || []) map[item.sentiment] = num(item.count);
  return map;
}

function alertCount(stats, level) {
  return (stats.alerts || []).filter(item => item.level === level).reduce((sum, item) => sum + num(item.count), 0);
}

function delta(current, previous, suffix = '') {
  const cur = num(current);
  const prev = num(previous);
  const diff = cur - prev;
  if (diff === 0) return { value: `持平${suffix}`, tone: 'flat', raw: 0 };
  const sign = diff > 0 ? '+' : '';
  return { value: `${sign}${diff.toFixed(Number.isInteger(diff) ? 0 : 1)}${suffix}`, tone: diff > 0 ? 'up' : 'down', raw: diff };
}

function rateDelta(current, previous) {
  return delta(current, previous, 'pct');
}

function firstNonEmpty(rows = []) {
  return rows.find(row => row && (row.count > 0 || row.negative_count > 0 || row.interaction_total > 0)) || null;
}

function classifyRisk(stats, negativeRate) {
  const criticalAlerts = alertCount(stats, 'critical');
  const warningAlerts = alertCount(stats, 'warning');
  const negativeCount = sentimentMap(stats).negative;
  const negativeComments = stats.commentStats?.negative_comments || 0;
  const highOpenIssues = stats.issueStats?.high_open_issues || 0;
  const activeInbox = stats.workflowStats?.active_inbox || 0;

  let score = 0;
  if (criticalAlerts > 0) score += 4;
  if (highOpenIssues > 0) score += 3;
  if (negativeRate >= 30 && negativeCount >= 3) score += 3;
  else if (negativeRate >= 15 && negativeCount >= 2) score += 2;
  if (negativeComments >= 10) score += 2;
  else if (negativeComments > 0) score += 1;
  if (warningAlerts > 0) score += 1;
  if (activeInbox >= 10) score += 1;

  if (score >= 6) return 'critical';
  if (score >= 4) return 'warning';
  if (score >= 2) return 'attention';
  return 'watch';
}

function buildActionItems(stats, negativeRate, riskLevel) {
  const items = [];
  if (riskLevel === 'critical') {
    items.push('将本周期高风险内容纳入当日处置会，明确负责人、口径、截止时间和复盘节点。');
  }
  if ((stats.workflowStats?.active_inbox || 0) > 0) {
    items.push(`完成舆情收件箱 ${stats.workflowStats.active_inbox} 条待处理/待复核线索分诊。`);
  }
  if ((stats.commentStats?.negative_comments || 0) > 0) {
    items.push(`核查 ${stats.commentStats.negative_comments} 条负面评论，确认是否需要官方回复或转为问题单。`);
  }
  if ((stats.issueStats?.open_issues || 0) > 0) {
    items.push(`更新 ${stats.issueStats.open_issues} 个未关闭问题的处理进展，补齐负责人和下一步动作。`);
  }
  if (negativeRate >= 15) {
    items.push('对负面占比较高的主题补充原因分析，区分真实产品/服务问题、价格认知问题和误解传播。');
  }
  if ((stats.officialPeriod?.record_count || 0) > 0) {
    items.push('复盘官方回复后的评论走势，若回复后仍新增负评，需要重新打开为待复核。');
  }
  if ((stats.pendingLabel || 0) > 0) {
    items.push(`对 ${stats.pendingLabel} 条待标注内容补跑 AI 标签，避免报告结论被空情感/空分类稀释。`);
  }
  if (items.length === 0) {
    items.push('本周期未出现显著风险，继续保持监控任务和日报复盘节奏。');
  }
  return items;
}

function buildCollectionRecommendations(stats) {
  const items = [];
  if (stats.total > 0 && (stats.commentStats?.new_comments || 0) === 0) {
    items.push('建议在重点负面和高互动内容上开启评论采集，日报才能识别“帖子已平稳但评论区发酵”的风险。');
  }
  if (stats.total > 0 && pct(stats.collectionStats?.records_with_content || 0, stats.total) < 80) {
    items.push('正文覆盖率偏低，建议优先补采详情页正文，减少只看标题导致的误判。');
  }
  if (stats.total > 0 && pct(stats.collectionStats?.ai_labeled_records || 0, stats.total) < 90) {
    items.push('AI 标注覆盖率不足，建议在生成报告前补跑情感、分类、摘要和行动建议。');
  }
  if ((stats.platform || []).length <= 1) {
    items.push('当前平台覆盖较窄，可逐步增加微博/抖音/小红书的同主题监控，提升跨平台判断能力。');
  }
  if (items.length === 0) {
    items.push('本周期采集结构完整，可继续沉淀为周报/月报趋势样本。');
  }
  return items;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const HOT_TERM_STOP_WORDS = new Set([
  '安吉星', 'OnStar', 'onstar', '这个', '那个', '因为', '所以', '但是', '就是', '没有', '还是',
  '一个', '一下', '感觉', '什么', '真的', '可以', '已经', '需要', '大家', '自己', '时候',
  '小红书', '微博', '抖音', '平台', '内容', '评论', '官方', '用户',
]);

const DOMAIN_TERMS = [
  '续费', '收费', '不续费', '救援', '安全', '隐私', '客服', '服务', 'APP', '车机',
  '定位', '远程启动', '胎压', '气囊', '事故', '召回', '故障', '无法登录', '连接失败',
  '电话', '到期', '官方回复', '车主', '权益', '价格', '流量', '导航', '被扣费',
];

function addTerm(counter, term, weight = 1) {
  const label = String(term || '').replace(/^#+/, '').trim();
  if (!label || label.length < 2 || HOT_TERM_STOP_WORDS.has(label)) return;
  counter.set(label, (counter.get(label) || 0) + weight);
}

function collectTermsFromText(counter, text, weight = 1) {
  const value = String(text || '');
  if (!value) return;
  for (const term of DOMAIN_TERMS) {
    if (value.toLowerCase().includes(term.toLowerCase())) addTerm(counter, term, weight + 1);
  }
  const hashtagMatches = value.match(/#[^#\s,，。；;:：、]{2,24}/g) || [];
  for (const tag of hashtagMatches) addTerm(counter, tag, weight + 2);
}

function collectTermsFromRow(counter, row, weight = 1) {
  addTerm(counter, row.keyword, weight + num(row.count));
  addTerm(counter, CATEGORY_LABEL[row.category] || row.category, weight);
  collectTermsFromText(counter, row.title, weight);
  collectTermsFromText(counter, row.content, weight);
  collectTermsFromText(counter, row.ai_summary, weight);
  for (const tag of parseJsonArray(row.tags)) {
    addTerm(counter, typeof tag === 'string' ? tag : tag?.name || tag?.text, weight + 2);
  }
  const payload = parseJsonObject(row.payload);
  for (const list of [payload.hashtags, payload.topics, payload.tags]) {
    for (const item of parseJsonArray(list)) addTerm(counter, typeof item === 'string' ? item : item?.name || item?.text, weight + 2);
  }
}

function buildHotTerms(stats) {
  const counter = new Map();
  for (const row of stats.keyword || []) addTerm(counter, row.keyword, Math.max(2, num(row.count) * 3));
  for (const row of stats.category || []) addTerm(counter, CATEGORY_LABEL[row.category] || row.category, Math.max(1, num(row.count)));
  for (const row of [...(stats.topNegative || []), ...(stats.topInteraction || []), ...(stats.sentimentSamples || [])]) {
    collectTermsFromRow(counter, row, row.sentiment === 'negative' ? 3 : 1);
  }
  for (const row of stats.negativeComments || []) {
    collectTermsFromText(counter, row.content, 3 + Math.min(5, num(row.like_count)));
    addTerm(counter, CATEGORY_LABEL[row.category] || row.category, 2);
  }
  return Array.from(counter.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
    .slice(0, 36)
    .map((term, index) => ({
      ...term,
      weight: Math.max(12, Math.min(34, 12 + Math.round(term.count / Math.max(1, counter.size ? Math.max(...counter.values()) : 1) * 22))),
      tone: index % 5,
    }));
}

function buildTopicFocus(stats) {
  const counts = sentimentMap(stats);
  const rows = stats.sentimentSamples || [];
  return ['positive', 'neutral', 'negative'].map(sentiment => {
    const samples = rows.filter(row => row.sentiment === sentiment).slice(0, 5);
    const categoryCounter = new Map();
    for (const row of samples) {
      const label = CATEGORY_LABEL[row.category] || row.category || '未分类';
      categoryCounter.set(label, (categoryCounter.get(label) || 0) + 1);
    }
    return {
      sentiment,
      label: SENTIMENT_LABEL[sentiment],
      count: counts[sentiment] || 0,
      share: pct(counts[sentiment] || 0, stats.total),
      categories: Array.from(categoryCounter.entries()).map(([label, count]) => ({ label, count })).slice(0, 4),
      samples,
    };
  });
}

function reportFocus(type) {
  if (type === 'weekly') return '本周重点看趋势变化、主题演化、重点问题复盘和行动建议。';
  if (type === 'monthly') return '本月重点看管理层复盘、重复问题、处置效率和长期风险。';
  if (type === 'dashboard') return '当前筛选范围内的实时舆情态势、内容风险和处置进展。';
  return '今日重点看新增风险、待处理线索、官方响应和重点样本。';
}

function totalInteraction(rows = []) {
  return rows.reduce((sum, row) => sum + num(row.likes) + num(row.comments_count) + num(row.collects) + num(row.shares), 0);
}

function buildOpinionIndex(stats, previousStats, negativeRate, previousNegativeRate) {
  const currentInteraction = totalInteraction(stats.topInteraction || []);
  const previousInteraction = totalInteraction(previousStats.topInteraction || []);
  const warningAlerts = alertCount(stats, 'warning');
  const criticalAlerts = alertCount(stats, 'critical');
  const previousWarningAlerts = alertCount(previousStats, 'warning');
  const previousCriticalAlerts = alertCount(previousStats, 'critical');
  const heat = Math.round(
    num(stats.total) * 3 +
    currentInteraction / 40 +
    num(stats.commentStats?.new_comments) * 1.2 +
    num(stats.observations) * 0.8
  );
  const previousHeat = Math.round(
    num(previousStats.total) * 3 +
    previousInteraction / 40 +
    num(previousStats.commentStats?.new_comments) * 1.2 +
    num(previousStats.observations) * 0.8
  );
  const risk = Math.min(100, Math.round(
    negativeRate * 1.2 +
    num(stats.commentStats?.negative_comments) * 3 +
    num(stats.issueStats?.high_open_issues) * 18 +
    warningAlerts * 10 +
    criticalAlerts * 24
  ));
  const previousRisk = Math.min(100, Math.round(
    previousNegativeRate * 1.2 +
    num(previousStats.commentStats?.negative_comments) * 3 +
    num(previousStats.issueStats?.high_open_issues) * 18 +
    previousWarningAlerts * 10 +
    previousCriticalAlerts * 24
  ));
  const response = Math.min(100, Math.round(
    pct(stats.workflowStats?.issue_linked || 0, Math.max(1, stats.workflowStats?.active_inbox || 0) + num(stats.workflowStats?.issue_linked)) * 0.55 +
    pct(stats.officialPeriod?.record_count || 0, Math.max(1, stats.total)) * 0.45
  ));
  return {
    heat,
    heatDelta: delta(heat, previousHeat),
    risk,
    riskDelta: delta(risk, previousRisk),
    response,
    status: risk >= 70 ? '重点处置' : risk >= 45 ? '风险抬升' : risk >= 20 ? '持续观察' : '平稳',
  };
}

function buildPlatformMatrix(stats) {
  const total = Math.max(1, num(stats.total));
  return (stats.platform || []).slice(0, 8).map(row => {
    const interactions = num(row.interaction_total);
    const negativeCount = num(row.negative_count);
    const count = num(row.count);
    return {
      platform: row.platform,
      label: PLATFORM_LABEL[row.platform] || row.platform || '未知平台',
      count,
      share: pct(count, total),
      negativeCount,
      negativeRate: pct(negativeCount, Math.max(1, count)),
      interactions,
      heat: Math.round(count * 2 + interactions / 30 + negativeCount * 6),
    };
  }).sort((a, b) => b.heat - a.heat);
}

function buildSentimentStructure(stats, sentimentCounts) {
  const total = Math.max(1, num(stats.total));
  const rows = [
    { key: 'positive', label: '正面', color: '#059669', count: sentimentCounts.positive || 0 },
    { key: 'neutral', label: '中性', color: '#6B7280', count: sentimentCounts.neutral || 0 },
    { key: 'negative', label: '负面', color: '#DC2626', count: sentimentCounts.negative || 0 },
    { key: 'pending', label: '待标注', color: '#CBD5E1', count: stats.pendingLabel || 0 },
  ];
  return rows.map(row => ({ ...row, share: pct(row.count, total) }));
}

function enrichReportData(type, current, previous) {
  const currentSentiment = sentimentMap(current);
  const previousSentiment = sentimentMap(previous);
  const negativeRate = pct(currentSentiment.negative, current.total);
  const previousNegativeRate = pct(previousSentiment.negative, previous.total);
  const riskLevel = classifyRisk(current, negativeRate);
  const dominantPlatform = firstNonEmpty(current.platform);
  const dominantCategory = firstNonEmpty(current.category);
  const negativeCategory = (current.category || [])
    .filter(item => item.negative_count > 0)
    .sort((a, b) => b.negative_count - a.negative_count)[0] || null;
  const topKeyword = firstNonEmpty(current.keyword);
  const typeName = { daily: '日报', weekly: '周报', monthly: '月报', dashboard: '数据看板' }[type] || '报表';

  const dashboardCards = [
    { label: '声量', value: n0(current.total), delta: delta(current.total, previous.total), help: '本周期涉及的帖子/内容量' },
    { label: '新增线索', value: n0(current.newRecords), delta: delta(current.newRecords, previous.newRecords), help: '首次入库内容' },
    { label: '负面率', value: `${negativeRate}%`, delta: rateDelta(negativeRate, previousNegativeRate), tone: negativeRate >= 20 ? 'danger' : 'normal', help: '负面内容 / 已标注内容' },
    { label: '负面评论', value: n0(current.commentStats.negative_comments), delta: delta(current.commentStats.negative_comments, previous.commentStats.negative_comments), tone: current.commentStats.negative_comments > 0 ? 'danger' : 'normal', help: '评论层面的负面线索' },
    { label: '待处理线索', value: n0(current.workflowStats.active_inbox), delta: null, tone: current.workflowStats.active_inbox > 0 ? 'warning' : 'normal', help: '当前收件箱待处理/复核' },
    { label: '未关闭问题', value: n0(current.issueStats.open_issues), delta: delta(current.issueStats.open_issues, previous.issueStats.open_issues), tone: current.issueStats.high_open_issues > 0 ? 'danger' : 'normal', help: '未 resolved/closed 的 issue' },
    { label: '官方响应', value: n0(current.officialPeriod.record_count), delta: delta(current.officialPeriod.record_count, previous.officialPeriod.record_count), help: '本周期出现官方回复的内容' },
    { label: '高危告警', value: n0(alertCount(current, 'critical')), delta: delta(alertCount(current, 'critical'), alertCount(previous, 'critical')), tone: alertCount(current, 'critical') > 0 ? 'danger' : 'normal', help: 'critical 级预警' },
  ];

  const executiveSummary = [
    `本周期舆情风险等级为「${RISK_LEVEL_LABEL[riskLevel]}」，共观察 ${current.total} 条内容，较上一周期${delta(current.total, previous.total).value}。`,
    `负面内容 ${currentSentiment.negative} 条，负面率 ${negativeRate}%（上一周期 ${previousNegativeRate}%）；负面评论 ${current.commentStats.negative_comments} 条。`,
    dominantPlatform
      ? `主要声量来自「${PLATFORM_LABEL[dominantPlatform.platform] || dominantPlatform.platform}」，占本周期内容 ${pct(dominantPlatform.count, current.total)}%。`
      : '本周期暂无明确平台集中度。',
    dominantCategory
      ? `主要主题为「${CATEGORY_LABEL[dominantCategory.category] || dominantCategory.category}」；${negativeCategory ? `负面最集中的主题为「${CATEGORY_LABEL[negativeCategory.category] || negativeCategory.category}」。` : '暂未形成明确负面主题。'}`
      : '本周期暂无明确主题分类。',
    topKeyword ? `高频监控关键词为「${topKeyword.keyword}」，相关内容 ${topKeyword.count} 条。` : '本周期关键词维度样本较少。',
  ];
  const hotTerms = buildHotTerms(current);
  const topicFocus = buildTopicFocus(current);
  const actionItems = buildActionItems(current, negativeRate, riskLevel);
  const collectionRecommendations = buildCollectionRecommendations(current);
  const opinionIndex = buildOpinionIndex(current, previous, negativeRate, previousNegativeRate);
  const platformMatrix = buildPlatformMatrix(current);
  const sentimentStructure = buildSentimentStructure(current, currentSentiment);

  return {
    ...current,
    previous,
    reportKind: type,
    reportName: typeName,
    riskLevel,
    riskLabel: RISK_LEVEL_LABEL[riskLevel],
    riskColor: RISK_LEVEL_COLOR[riskLevel],
    negativeRate,
    previousNegativeRate,
    sentimentMap: currentSentiment,
    previousSentimentMap: previousSentiment,
    dominantPlatform,
    dominantCategory,
    negativeCategory,
    kpis: dashboardCards,
    platformDistribution: current.platform,
    topicFocus,
    hotTerms,
    riskItems: current.topNegative,
    commentRisks: current.negativeComments,
    issueSummary: current.issueStats,
    officialResponseSummary: current.officialPeriod,
    actionRecommendations: actionItems,
    periodFocus: reportFocus(type),
    opinionIndex,
    platformMatrix,
    sentimentStructure,
    dashboardCards,
    executiveSummary,
    actionItems,
    collectionRecommendations,
  };
}

export async function buildAnalyticsDashboard({ tenantId, periodStart, periodEnd }) {
  const previous = previousPeriod(periodStart, periodEnd);
  const currentStats = await getReportStats(tenantId, periodStart, periodEnd);
  const previousStats = await getReportStats(tenantId, previous.start, previous.end);
  return enrichReportData('dashboard', currentStats, previousStats);
}

function styleBlock() {
  return `
    <style>
      @media only screen and (max-width: 640px) {
        .report-grid { display:block !important; }
        .report-card { width:auto !important; margin-bottom:10px !important; }
        .report-shell { padding:12px !important; }
      }
    </style>`;
}

function htmlPill(text, color, background = '#F9FAFB') {
  return `<span style="display:inline-block; padding:3px 8px; border-radius:999px; color:${color}; background:${background}; font-size:12px; font-weight:700;">${escHtml(text)}</span>`;
}

function deltaHtml(item) {
  if (!item) return '';
  const color = item.tone === 'up' ? '#D97706' : item.tone === 'down' ? '#059669' : '#6B7280';
  return `<div style="font-size:12px; color:${color}; margin-top:4px;">较上期 ${escHtml(item.value)}</div>`;
}

function renderDashboard(cards = []) {
  return `
    <div class="report-grid" style="display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; margin:16px 0 22px;">
      ${cards.map(card => `
        <div class="report-card" style="background:#FFFFFF; border:1px solid #E5E7EB; border-radius:8px; padding:13px 14px;">
          <div style="font-size:12px; color:#6B7280;">${escHtml(card.label)}</div>
          <div style="font-size:24px; line-height:1.2; font-weight:800; color:${card.tone === 'danger' ? '#DC2626' : card.tone === 'warning' ? '#D97706' : '#111827'}; margin-top:5px;">${escHtml(card.value)}</div>
          ${deltaHtml(card.delta)}
          <div style="font-size:11px; color:#9CA3AF; margin-top:4px;">${escHtml(card.help || '')}</div>
        </div>
      `).join('')}
    </div>`;
}

function renderBarRows(rows = [], { labelKey, valueKey = 'count', total = 0, labelMap = {}, color = '#2563EB', maxRows = 8 }) {
  const visible = rows.slice(0, maxRows);
  if (visible.length === 0) {
    return '<p style="color:#9CA3AF; font-size:13px;">暂无数据</p>';
  }
  return `<div style="display:grid; gap:8px;">${visible.map(row => {
    const label = labelMap[row[labelKey]] || row[labelKey] || '未识别';
    const value = num(row[valueKey]);
    const denominator = total || Math.max(...visible.map(item => num(item[valueKey])), 1);
    const width = Math.max(4, pct(value, denominator));
    return `<div>
      <div style="display:flex; justify-content:space-between; gap:12px; font-size:13px; color:#374151;">
        <span>${escHtml(label)}</span><strong>${n0(value)}${total ? ` · ${pct(value, total)}%` : ''}</strong>
      </div>
      <div style="height:8px; background:#F3F4F6; border-radius:999px; overflow:hidden; margin-top:5px;">
        <div style="height:100%; width:${width}%; background:${color};"></div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderSection(title, body, subtitle = '') {
  return `
    <section style="margin-top:24px;">
      <div style="border-bottom:1px solid #E5E7EB; padding-bottom:8px; margin-bottom:12px;">
        <h3 style="font-size:16px; color:#111827; margin:0;">${escHtml(title)}</h3>
        ${subtitle ? `<p style="font-size:12px; color:#6B7280; margin:5px 0 0;">${escHtml(subtitle)}</p>` : ''}
      </div>
      ${body}
    </section>`;
}

function renderList(items = [], ordered = false) {
  const tag = ordered ? 'ol' : 'ul';
  if (!items.length) return '<p style="color:#9CA3AF; font-size:13px;">暂无</p>';
  return `<${tag} style="margin:0; padding-left:20px; color:#374151; font-size:13px; line-height:1.8;">
    ${items.map(item => `<li>${escHtml(item)}</li>`).join('')}
  </${tag}>`;
}

function interactionText(row) {
  return `${n0(row.likes)}赞 / ${n0(row.comments_count)}评 / ${n0(row.collects)}藏 / ${n0(row.shares)}转`;
}

function renderEvidenceRows(rows = [], emptyText = '暂无重点样本') {
  if (!rows.length) return `<p style="color:#9CA3AF; font-size:13px;">${escHtml(emptyText)}</p>`;
  return `<div style="display:grid; gap:10px;">${rows.map((row, index) => {
    const url = safeUrl(row.url || row.record_url);
    const title = compactText(row.title || row.record_title || row.content || '无标题', 76);
    const summary = compactText(row.ai_summary || row.content || '', 160);
    return `<div style="border:1px solid #E5E7EB; border-radius:8px; padding:12px; background:#FFFFFF;">
      <div style="font-size:12px; color:#6B7280; margin-bottom:4px;">#${index + 1} ${escHtml(PLATFORM_LABEL[row.platform] || row.platform || '')} · ${escHtml(row.author_name || '未知作者')}</div>
      <div style="font-size:14px; font-weight:800; color:#111827;">
        ${url ? `<a href="${escHtml(url)}" style="color:#111827; text-decoration:none;">${escHtml(title)}</a>` : escHtml(title)}
      </div>
      ${summary ? `<div style="font-size:13px; color:#4B5563; margin-top:6px; line-height:1.6;">${escHtml(summary)}</div>` : ''}
      <div style="font-size:12px; color:#6B7280; margin-top:8px;">${escHtml(interactionText(row))}${row.negative_comment_count ? ` · 负面评论 ${n0(row.negative_comment_count)}` : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

function renderNegativeComments(rows = []) {
  if (!rows.length) return '<p style="color:#9CA3AF; font-size:13px;">暂无负面评论样本</p>';
  return `<div style="display:grid; gap:10px;">${rows.slice(0, 6).map(row => {
    const url = safeUrl(row.record_url);
    return `<div style="border-left:3px solid #DC2626; background:#FEF2F2; padding:10px 12px; border-radius:6px;">
      <div style="font-size:12px; color:#991B1B; font-weight:800;">${escHtml(row.author_name || '匿名评论者')} · ${escHtml(row.risk_level || 'risk')}</div>
      <div style="font-size:13px; color:#111827; line-height:1.65; margin-top:4px;">${escHtml(compactText(row.content, 180))}</div>
      <div style="font-size:12px; color:#6B7280; margin-top:6px;">
        来自：${url ? `<a href="${escHtml(url)}" style="color:#2563EB;">${escHtml(compactText(row.record_title || '原帖', 60))}</a>` : escHtml(compactText(row.record_title || '原帖', 60))}
        · ${n0(row.like_count)}赞
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderIssues(issues = []) {
  if (!issues.length) return '<p style="color:#9CA3AF; font-size:13px;">暂无问题单</p>';
  return `<table style="width:100%; border-collapse:collapse; font-size:13px;">
    <thead><tr style="background:#F9FAFB;">
      <th style="text-align:left; padding:8px; color:#6B7280;">问题</th>
      <th style="text-align:left; padding:8px; color:#6B7280;">级别</th>
      <th style="text-align:left; padding:8px; color:#6B7280;">状态</th>
      <th style="text-align:left; padding:8px; color:#6B7280;">负责人</th>
    </tr></thead>
    <tbody>${issues.map(issue => `
      <tr>
        <td style="padding:9px 8px; border-bottom:1px solid #F3F4F6;">
          <strong>${escHtml(compactText(issue.title || '未命名问题', 58))}</strong>
          ${issue.summary ? `<div style="color:#6B7280; font-size:12px; margin-top:3px;">${escHtml(compactText(issue.summary, 90))}</div>` : ''}
        </td>
        <td style="padding:9px 8px; border-bottom:1px solid #F3F4F6;">${escHtml(issue.severity || '-')}</td>
        <td style="padding:9px 8px; border-bottom:1px solid #F3F4F6;">${escHtml(ISSUE_STATUS_LABEL[issue.status] || issue.status || '-')}</td>
        <td style="padding:9px 8px; border-bottom:1px solid #F3F4F6;">${escHtml(issue.owner_name || '未分配')}</td>
      </tr>`).join('')}</tbody>
  </table>`;
}

function buildLegacyReportHTML(title, periodLabel, stats) {
  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const riskBg = stats.riskLevel === 'critical'
    ? '#FEF2F2'
    : stats.riskLevel === 'warning'
      ? '#FFFBEB'
      : stats.riskLevel === 'attention'
        ? '#EFF6FF'
        : '#ECFDF5';

  const sentimentBody = `
    <div class="report-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">
      <div>${renderBarRows(stats.sentiment, { labelKey: 'sentiment', total: Math.max(stats.sentiment.reduce((sum, item) => sum + item.count, 0), 1), labelMap: SENTIMENT_LABEL, color: '#2563EB' })}</div>
      <div style="background:#F9FAFB; border:1px solid #E5E7EB; border-radius:8px; padding:12px;">
        <div style="font-size:13px; color:#374151; line-height:1.7;">
          负面率 <strong style="color:#DC2626;">${stats.negativeRate}%</strong>，
          上一周期 <strong>${stats.previousNegativeRate}%</strong>；
          待标注 <strong>${n0(stats.pendingLabel)}</strong> 条。
        </div>
        <div style="font-size:12px; color:#6B7280; margin-top:8px;">
          判断原则：声量峰值必须结合情感走势看，不能把高声量自动解读为好事。
        </div>
      </div>
    </div>`;

  const topicBody = `
    <div class="report-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">
      <div>
        <h4 style="margin:0 0 10px; color:#111827;">主题分布</h4>
        ${renderBarRows(stats.category, { labelKey: 'category', total: Math.max(stats.total, 1), labelMap: CATEGORY_LABEL, color: '#0F766E' })}
      </div>
      <div>
        <h4 style="margin:0 0 10px; color:#111827;">平台分布</h4>
        ${renderBarRows(stats.platform, { labelKey: 'platform', total: Math.max(stats.total, 1), labelMap: PLATFORM_LABEL, color: '#7C3AED' })}
      </div>
    </div>
    ${stats.keyword.length ? `<div style="margin-top:16px;">
      <h4 style="margin:0 0 10px; color:#111827;">关键词线索</h4>
      ${renderBarRows(stats.keyword, { labelKey: 'keyword', total: 0, color: '#D97706', maxRows: 6 })}
    </div>` : ''}`;

  const riskBody = `
    <div class="report-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">
      <div>
        <h4 style="margin:0 0 10px; color:#111827;">重点负面内容</h4>
        ${renderEvidenceRows(stats.topNegative, '暂无重点负面内容')}
      </div>
      <div>
        <h4 style="margin:0 0 10px; color:#111827;">负面评论样本</h4>
        ${renderNegativeComments(stats.negativeComments)}
      </div>
    </div>`;

  const handlingBody = `
    <div class="report-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">
      <div>
        <h4 style="margin:0 0 10px; color:#111827;">问题处置</h4>
        ${renderIssues(stats.topIssues)}
      </div>
      <div>
        <h4 style="margin:0 0 10px; color:#111827;">分流状态</h4>
        ${renderBarRows(stats.triagePeriod, { labelKey: 'status', total: Math.max(stats.total, 1), labelMap: TRIAGE_LABEL, color: '#2563EB' })}
        <div style="font-size:12px; color:#6B7280; line-height:1.7; margin-top:12px;">
          本周期官方回复 ${n0(stats.officialPeriod.response_count)} 条，覆盖 ${n0(stats.officialPeriod.record_count)} 条内容；当前全库官方已响应 ${n0(stats.workflowStats.official_responded)} 条。
        </div>
      </div>
    </div>`;

  return `${styleBlock()}
    <div class="report-shell" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; max-width:980px; margin:0 auto; padding:20px; color:#111827; background:#F6F8FB;">
      <div style="background:#FFFFFF; border:1px solid #E5E7EB; border-radius:12px; overflow:hidden;">
        <div style="padding:24px 26px; background:#111827;">
          <div style="font-size:12px; color:#CBD5E1; font-weight:700; letter-spacing:0;">StarVoice 星语 · 舆情报告</div>
          <h2 style="color:#FFFFFF; margin:8px 0 6px; font-size:24px; line-height:1.25;">${escHtml(title)}</h2>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <span style="color:#CBD5E1; font-size:13px;">${escHtml(periodLabel)}</span>
            ${htmlPill(stats.riskLabel, stats.riskColor, riskBg)}
          </div>
        </div>
        <div style="padding:24px 26px;">
          ${renderDashboard(stats.dashboardCards)}

          ${renderSection('管理摘要', renderList(stats.executiveSummary), '面向管理层的结论先行摘要')}
          ${renderSection('今日处置建议', renderList(stats.actionItems, true), '把舆情发现转成可执行动作')}
          ${renderSection('声量与情绪', sentimentBody, '对比上一周期识别异常波动')}
          ${renderSection('主题与渠道', topicBody, '定位风险来源、主题和关键词')}
          ${renderSection('风险样本', riskBody, '保留可追溯证据，方便人工复核')}
          ${renderSection('问题闭环与官方响应', handlingBody, '日报要看处置状态，而不只是内容数量')}
          ${stats.risingRecords.length ? renderSection('互动增长内容', renderEvidenceRows(stats.risingRecords), '重复采集后互动增长较快的内容') : ''}
          ${stats.topAuthors.length ? renderSection('重点账号', renderBarRows(stats.topAuthors, { labelKey: 'author_name', valueKey: 'interaction_total', color: '#0F766E', maxRows: 8 }), '按负面数量和互动量综合排序') : ''}
          ${renderSection('采集质量与补强建议', renderList(stats.collectionRecommendations), '帮助后续把报告越做越准')}

          <div style="margin-top:24px; padding:12px; background:#F9FAFB; border-radius:8px; font-size:12px; color:#6B7280; line-height:1.7;">
            生成时间：${escHtml(generatedAt)}。本报告基于公开内容、采集快照、评论舆情、官方响应、告警和问题单自动生成；建议由运营/公关负责人在发送前复核重点样本和处置建议。
          </div>
        </div>
      </div>
    </div>`;
}

function reportCss() {
  return `<style>
    .osv-report { --bg:#F6F8FB; --surface:#FFFFFF; --text:#111827; --muted:#6B7280; --soft:#9CA3AF; --border:#E5E7EB; --blue:#2563EB; --green:#059669; --red:#DC2626; --orange:#D97706; --teal:#0F766E; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif; background:var(--bg); color:var(--text); padding:24px; }
    .osv-report * { box-sizing:border-box; }
    .osv-report a { color:var(--blue); text-decoration:none; }
    .osv-shell { max-width:1180px; margin:0 auto; display:grid; gap:16px; }
    .osv-hero { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:22px 24px; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:18px; align-items:start; }
    .osv-kicker { color:var(--blue); font-size:12px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; }
    .osv-title { margin:6px 0 8px; font-size:26px; line-height:1.22; letter-spacing:0; }
    .osv-subtitle { color:var(--muted); font-size:13px; line-height:1.7; }
    .osv-risk { min-width:190px; border:1px solid var(--border); border-radius:8px; padding:14px; background:#FAFCFF; }
    .osv-risk strong { display:block; font-size:22px; line-height:1.2; }
    .osv-risk span { display:block; color:var(--muted); font-size:12px; margin-top:6px; }
    .osv-kpis { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .osv-kpi { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:14px; min-height:116px; }
    .osv-kpi label { display:block; color:var(--muted); font-size:12px; font-weight:700; }
    .osv-kpi strong { display:block; margin-top:6px; font-size:26px; line-height:1.15; font-variant-numeric:tabular-nums; }
    .osv-kpi small { display:block; margin-top:6px; color:var(--soft); line-height:1.45; }
    .osv-delta { font-size:12px; font-weight:700; }
    .osv-up { color:var(--orange); } .osv-down { color:var(--green); } .osv-flat { color:var(--muted); }
    .osv-grid { display:grid; grid-template-columns:1.35fr .95fr; gap:16px; }
    .osv-grid-3 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
    .osv-card { background:var(--surface); border:1px solid var(--border); border-radius:8px; overflow:hidden; }
    .osv-card-head { padding:14px 16px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .osv-card-head h3 { margin:0; font-size:15px; }
    .osv-card-head span { color:var(--muted); font-size:12px; }
    .osv-card-body { padding:16px; }
    .osv-index-panel { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:stretch; }
    .osv-index-primary { min-height:190px; border:1px solid var(--border); border-radius:8px; background:#F8FAFC; padding:16px; display:grid; align-content:center; }
    .osv-index-primary span { color:var(--muted); font-size:12px; font-weight:800; }
    .osv-index-value { margin-top:6px; font-size:44px; line-height:1; font-weight:900; font-variant-numeric:tabular-nums; color:var(--blue); }
    .osv-index-status { margin-top:10px; display:inline-flex; width:max-content; min-height:24px; align-items:center; padding:2px 9px; border-radius:999px; background:#EFF6FF; color:var(--blue); font-size:12px; font-weight:800; }
    .osv-index-bars { display:grid; gap:10px; align-content:center; }
    .osv-index-item { display:grid; gap:6px; }
    .osv-index-item header { display:flex; justify-content:space-between; gap:12px; color:#374151; font-size:12px; font-weight:800; }
    .osv-platform-matrix { display:grid; gap:9px; }
    .osv-platform-row { display:grid; grid-template-columns:minmax(70px,.8fr) minmax(0,1.4fr) 54px; gap:9px; align-items:center; font-size:12px; }
    .osv-platform-row strong { color:#111827; }
    .osv-platform-row span { color:var(--muted); text-align:right; font-variant-numeric:tabular-nums; }
    .osv-sentiment-layout { display:grid; grid-template-columns:150px minmax(0,1fr); gap:14px; align-items:center; }
    .osv-donut { width:136px; height:136px; border-radius:50%; display:grid; place-items:center; margin:auto; }
    .osv-donut-inner { width:76px; height:76px; border-radius:50%; background:#fff; display:grid; place-items:center; text-align:center; box-shadow:inset 0 0 0 1px #E5E7EB; }
    .osv-donut-inner strong { display:block; font-size:18px; line-height:1.1; }
    .osv-donut-inner span { display:block; color:var(--muted); font-size:11px; margin-top:3px; }
    .osv-legend { display:grid; gap:8px; }
    .osv-legend-row { display:flex; align-items:center; justify-content:space-between; gap:10px; color:#374151; font-size:12px; }
    .osv-legend-name { display:flex; align-items:center; gap:7px; }
    .osv-dot { width:9px; height:9px; border-radius:999px; flex:0 0 auto; }
    .osv-rank-list { display:grid; gap:8px; }
    .osv-rank-row { display:grid; grid-template-columns:28px minmax(0,1fr) auto; gap:9px; align-items:center; padding:9px 0; border-bottom:1px solid #EEF2F7; font-size:12px; }
    .osv-rank-row:last-child { border-bottom:0; }
    .osv-rank-no { display:grid; place-items:center; width:22px; height:22px; border-radius:6px; background:#EFF6FF; color:#2563EB; font-weight:900; }
    .osv-rank-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#111827; font-weight:700; }
    .osv-rank-metric { color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .osv-summary { margin:0; padding-left:18px; color:#374151; line-height:1.8; font-size:13px; }
    .osv-summary li { margin:4px 0; }
    .osv-chart { width:100%; min-height:240px; display:block; }
    .osv-bars { display:grid; gap:10px; }
    .osv-bar-row { display:grid; gap:5px; }
    .osv-bar-top { display:flex; justify-content:space-between; gap:10px; font-size:13px; color:#374151; }
    .osv-track { height:8px; border-radius:999px; background:#F3F4F6; overflow:hidden; }
    .osv-fill { height:100%; border-radius:999px; background:var(--blue); }
    .osv-cloud { min-height:260px; display:flex; align-content:center; align-items:center; justify-content:center; gap:10px 14px; flex-wrap:wrap; padding:6px 8px; }
    .osv-term { font-weight:800; line-height:1.1; color:#2563EB; }
    .osv-term.t1 { color:#0F766E; } .osv-term.t2 { color:#D97706; } .osv-term.t3 { color:#7C3AED; } .osv-term.t4 { color:#DC2626; }
    .osv-topic { display:grid; gap:12px; }
    .osv-topic-box { border:1px solid var(--border); border-radius:8px; padding:13px; background:#FAFCFF; }
    .osv-topic-box h4 { margin:0 0 8px; font-size:14px; display:flex; justify-content:space-between; gap:12px; }
    .osv-topic-box p { margin:0; color:var(--muted); font-size:12px; line-height:1.65; }
    .osv-sample-list { display:grid; gap:10px; }
    .osv-sample { display:grid; grid-template-columns:58px minmax(0,1fr); gap:12px; padding:12px; border:1px solid var(--border); border-radius:8px; background:#FFFFFF; }
    .osv-thumb { width:58px; height:58px; border:1px solid var(--border); border-radius:8px; background:#F3F4F6; overflow:hidden; display:grid; place-items:center; color:var(--soft); font-size:11px; font-weight:800; }
    .osv-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
    .osv-sample h4 { margin:0; font-size:14px; line-height:1.45; }
    .osv-sample p { margin:5px 0 0; color:#4B5563; font-size:12px; line-height:1.65; }
    .osv-meta { margin-top:7px; color:var(--muted); font-size:12px; display:flex; flex-wrap:wrap; gap:6px 10px; }
    .osv-table { width:100%; border-collapse:collapse; font-size:12px; }
    .osv-table th, .osv-table td { padding:9px 8px; border-bottom:1px solid #EEF2F7; text-align:left; vertical-align:top; }
    .osv-table th { color:var(--muted); background:#F9FAFB; font-weight:800; }
    .osv-pill { display:inline-flex; align-items:center; min-height:22px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:800; background:#F3F4F6; color:#374151; }
    .osv-pill.red { background:#FEF2F2; color:#DC2626; } .osv-pill.green { background:#ECFDF5; color:#059669; } .osv-pill.blue { background:#EFF6FF; color:#2563EB; } .osv-pill.orange { background:#FFFBEB; color:#D97706; }
    .osv-footer { color:var(--muted); font-size:12px; line-height:1.7; padding:12px 2px; }
    .osv-empty { color:var(--soft); font-size:13px; text-align:center; padding:28px; border:1px dashed var(--border); border-radius:8px; background:#FAFCFF; }
    .osv-screen { min-height:760px; background:#F6F8FB; }
    .osv-screen .osv-shell { max-width:1360px; }
    .osv-screen-grid { display:grid; grid-template-columns:340px minmax(0,1fr) 390px; gap:14px; }
    .osv-screen .osv-card-body { padding:14px; }
    @media (max-width: 980px) { .osv-report { padding:14px; } .osv-hero, .osv-grid, .osv-grid-3, .osv-screen-grid, .osv-index-panel, .osv-sentiment-layout { grid-template-columns:1fr; } .osv-kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } .osv-risk { min-width:0; } }
    @media (max-width: 560px) { .osv-kpis { grid-template-columns:1fr; } .osv-title { font-size:22px; } }
  </style>`;
}

function toneClass(item) {
  if (!item) return 'flat';
  if (item.tone === 'up') return 'up';
  if (item.tone === 'down') return 'down';
  return 'flat';
}

function renderReportKpis(cards = []) {
  return `<div class="osv-kpis">${cards.map(card => `
    <article class="osv-kpi">
      <label>${escHtml(card.label)}</label>
      <strong style="color:${card.tone === 'danger' ? '#DC2626' : card.tone === 'warning' ? '#D97706' : '#111827'}">${escHtml(card.value)}</strong>
      ${card.delta ? `<div class="osv-delta osv-${toneClass(card.delta)}">较上期 ${escHtml(card.delta.value)}</div>` : '<div class="osv-delta osv-flat">当前状态</div>'}
      <small>${escHtml(card.help || '')}</small>
    </article>
  `).join('')}</div>`;
}

function renderReportCard(title, body, subtitle = '') {
  return `<section class="osv-card">
    <div class="osv-card-head"><h3>${escHtml(title)}</h3>${subtitle ? `<span>${escHtml(subtitle)}</span>` : ''}</div>
    <div class="osv-card-body">${body}</div>
  </section>`;
}

function renderOpinionIndex(stats) {
  const idx = stats.opinionIndex || { heat: 0, risk: 0, response: 0, status: '平稳', heatDelta: null, riskDelta: null };
  const riskColor = idx.risk >= 70 ? '#DC2626' : idx.risk >= 45 ? '#D97706' : '#2563EB';
  return `<div class="osv-index-panel">
    <div class="osv-index-primary">
      <span>综合舆情热度指数</span>
      <div class="osv-index-value">${n0(idx.heat)}</div>
      <div class="osv-index-status">${escHtml(idx.status)}${idx.heatDelta ? ` · ${escHtml(idx.heatDelta.value)}` : ''}</div>
      <div style="margin-top:12px;color:#6B7280;font-size:12px;line-height:1.7;">综合声量、互动、评论、采集快照和风险信号，作为本周期态势研判入口。</div>
    </div>
    <div class="osv-index-bars">
      <div class="osv-index-item">
        <header><span>风险指数</span><strong style="color:${riskColor}">${n0(idx.risk)}</strong></header>
        <div class="osv-track"><div class="osv-fill" style="width:${Math.min(100, Math.max(3, idx.risk))}%;background:${riskColor};"></div></div>
      </div>
      <div class="osv-index-item">
        <header><span>处置响应指数</span><strong style="color:#059669">${n0(idx.response)}</strong></header>
        <div class="osv-track"><div class="osv-fill" style="width:${Math.min(100, Math.max(3, idx.response))}%;background:#059669;"></div></div>
      </div>
      <div class="osv-index-item">
        <header><span>负面率</span><strong style="color:#DC2626">${stats.negativeRate}%</strong></header>
        <div class="osv-track"><div class="osv-fill" style="width:${Math.min(100, Math.max(3, stats.negativeRate))}%;background:#DC2626;"></div></div>
      </div>
    </div>
  </div>`;
}

function renderTrendSvg(trend = []) {
  if (!trend.length) return '<div class="osv-empty">暂无趋势数据</div>';
  const width = 720;
  const height = 260;
  const pad = { left: 36, right: 16, top: 18, bottom: 34 };
  const maxValue = Math.max(1, ...trend.flatMap(row => [num(row.total), num(row.negative), num(row.positive)]));
  const x = index => {
    if (trend.length === 1) return pad.left + (width - pad.left - pad.right) / 2;
    return pad.left + index * ((width - pad.left - pad.right) / (trend.length - 1));
  };
  const y = value => pad.top + (height - pad.top - pad.bottom) * (1 - num(value) / maxValue);
  const line = key => trend.map((row, index) => `${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(' ');
  const labels = trend.map((row, index) => `<text x="${x(index).toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="11" fill="#6B7280">${escHtml(row.label)}</text>`).join('');
  const grid = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
    const gy = pad.top + (height - pad.top - pad.bottom) * ratio;
    return `<line x1="${pad.left}" y1="${gy}" x2="${width - pad.right}" y2="${gy}" stroke="#EEF2F7"/><text x="4" y="${gy + 4}" font-size="10" fill="#9CA3AF">${Math.round(maxValue * (1 - ratio))}</text>`;
  }).join('');
  return `<svg class="osv-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="声量和情绪趋势">
    ${grid}
    <polyline points="${line('total')}" fill="none" stroke="#2563EB" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${line('negative')}" fill="none" stroke="#DC2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${line('positive')}" fill="none" stroke="#059669" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${trend.map((row, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(row.total).toFixed(1)}" r="3.5" fill="#2563EB"/>`).join('')}
    ${labels}
    <g transform="translate(${pad.left},4)" font-size="11" font-weight="700">
      <text x="0" y="0" fill="#2563EB">● 声量</text>
      <text x="58" y="0" fill="#DC2626">● 负面</text>
      <text x="116" y="0" fill="#059669">● 正面</text>
    </g>
  </svg>`;
}

function renderDistribution(rows = [], { labelKey, valueKey = 'count', total = 0, labelMap = {}, color = '#2563EB', maxRows = 8 }) {
  const visible = rows.slice(0, maxRows);
  if (!visible.length) return '<div class="osv-empty">暂无分布数据</div>';
  const denominator = total || Math.max(1, ...visible.map(row => num(row[valueKey])));
  return `<div class="osv-bars">${visible.map(row => {
    const label = labelMap[row[labelKey]] || row[labelKey] || '未采集';
    const value = num(row[valueKey]);
    const width = Math.max(3, pct(value, denominator));
    return `<div class="osv-bar-row">
      <div class="osv-bar-top"><span>${escHtml(label)}</span><strong>${n0(value)}${total ? ` · ${pct(value, total)}%` : ''}</strong></div>
      <div class="osv-track"><div class="osv-fill" style="width:${width}%; background:${color};"></div></div>
    </div>`;
  }).join('')}</div>`;
}

function renderPlatformMatrix(rows = []) {
  if (!rows.length) return '<div class="osv-empty">暂无平台声量数据</div>';
  const maxHeat = Math.max(1, ...rows.map(row => num(row.heat)));
  return `<div class="osv-platform-matrix">${rows.slice(0, 7).map(row => `
    <div class="osv-platform-row">
      <strong>${escHtml(row.label)}</strong>
      <div class="osv-track"><div class="osv-fill" style="width:${Math.max(4, pct(row.heat, maxHeat))}%;background:${row.negativeRate >= 30 ? '#DC2626' : row.negativeRate >= 12 ? '#D97706' : '#2563EB'};"></div></div>
      <span>${n0(row.count)}条</span>
    </div>
    <div class="osv-platform-row" style="grid-template-columns:minmax(70px,.8fr) minmax(0,1.4fr) 54px;margin-top:-5px;color:#6B7280;">
      <span style="text-align:left;">负面 ${n0(row.negativeCount)}</span>
      <span style="text-align:left;">互动 ${n0(row.interactions)}</span>
      <span>${row.share}%</span>
    </div>
  `).join('')}</div>`;
}

function renderSentimentDonut(stats) {
  const rows = stats.sentimentStructure || [];
  if (!rows.length) return '<div class="osv-empty">暂无情绪结构</div>';
  let cursor = 0;
  const stops = rows.map(row => {
    const start = cursor;
    cursor += row.share;
    return `${row.color} ${start}% ${Math.min(100, cursor)}%`;
  }).join(', ');
  const negative = rows.find(row => row.key === 'negative') || { count: 0, share: 0 };
  return `<div class="osv-sentiment-layout">
    <div class="osv-donut" style="background:conic-gradient(${stops || '#E5E7EB 0 100%'});">
      <div class="osv-donut-inner"><strong>${negative.share}%</strong><span>负面占比</span></div>
    </div>
    <div class="osv-legend">${rows.map(row => `
      <div class="osv-legend-row">
        <span class="osv-legend-name"><i class="osv-dot" style="background:${row.color};"></i>${escHtml(row.label)}</span>
        <strong>${n0(row.count)} · ${row.share}%</strong>
      </div>
    `).join('')}</div>
  </div>`;
}

function renderWordCloud(terms = []) {
  if (!terms.length) return '<div class="osv-empty">暂无热点词，建议补充关键词、正文和评论采集</div>';
  return `<div class="osv-cloud">${terms.map(term => `
    <span class="osv-term t${term.tone}" style="font-size:${num(term.weight, 14)}px" title="${escHtml(`${term.label} · ${term.count}`)}">${escHtml(term.label)}</span>
  `).join('')}</div>`;
}

function renderHotTermRank(terms = []) {
  if (!terms.length) return '<div class="osv-empty">暂无热词指数</div>';
  return `<div class="osv-rank-list">${terms.slice(0, 10).map((term, index) => `
    <div class="osv-rank-row">
      <span class="osv-rank-no">${index + 1}</span>
      <span class="osv-rank-title">${escHtml(term.label)}</span>
      <strong class="osv-rank-metric">${n0(term.count)}</strong>
    </div>
  `).join('')}</div>`;
}

function renderAlertFeed(rows = []) {
  if (!rows.length) return '<div class="osv-empty">本周期暂无预警快报</div>';
  return `<div class="osv-rank-list">${rows.slice(0, 7).map((row, index) => {
    const tone = row.level === 'critical' ? 'red' : row.level === 'warning' ? 'orange' : 'blue';
    return `<div class="osv-rank-row" style="grid-template-columns:28px minmax(0,1fr) auto;">
      <span class="osv-rank-no">${index + 1}</span>
      <span class="osv-rank-title">${escHtml(compactText(row.title || row.summary || row.reason || '未命名预警', 42))}</span>
      <span class="osv-pill ${tone}">${escHtml(row.level || 'info')}</span>
    </div>`;
  }).join('')}</div>`;
}

function renderTopicFocus(focus = []) {
  return `<div class="osv-topic">${focus.map(item => {
    const tone = item.sentiment === 'negative' ? 'red' : item.sentiment === 'positive' ? 'green' : 'blue';
    const samples = item.samples.map(sample => compactText(sample.title || sample.content || sample.ai_summary || '未命名内容', 42)).filter(Boolean).slice(0, 3);
    const categoryText = item.categories.map(row => `${row.label} ${row.count}`).join(' / ') || '暂无明显主题';
    return `<article class="osv-topic-box">
      <h4><span>${escHtml(item.label)}讨论焦点</span><span class="osv-pill ${tone}">${n0(item.count)} · ${item.share}%</span></h4>
      <p>主题：${escHtml(categoryText)}</p>
      <p>样本：${escHtml(samples.join('；') || '暂无代表样本')}</p>
    </article>`;
  }).join('')}</div>`;
}

function renderSampleCards(rows = [], emptyText = '暂无重点样本') {
  if (!rows.length) return `<div class="osv-empty">${escHtml(emptyText)}</div>`;
  return `<div class="osv-sample-list">${rows.slice(0, 6).map(row => {
    const cover = safeUrl(row.cover_url || row.record_cover_url);
    const url = safeUrl(row.url || row.record_url);
    const title = compactText(row.title || row.record_title || row.content || '无标题', 74);
    const summary = compactText(row.ai_summary || row.content || '', 132);
    return `<article class="osv-sample">
      <div class="osv-thumb">${cover ? `<img src="${escHtml(cover)}" alt="cover" loading="lazy" referrerpolicy="no-referrer">` : '无图'}</div>
      <div>
        <h4>${url ? `<a href="${escHtml(url)}">${escHtml(title)}</a>` : escHtml(title)}</h4>
        ${summary ? `<p>${escHtml(summary)}</p>` : ''}
        <div class="osv-meta">
          <span>${escHtml(PLATFORM_LABEL[row.platform] || row.platform || '未知平台')}</span>
          <span>${escHtml(row.author_name || row.record_author_name || '未知作者')}</span>
          <span>${escHtml(interactionText(row))}</span>
          ${row.negative_comment_count ? `<span class="osv-pill red">负评 ${n0(row.negative_comment_count)}</span>` : ''}
        </div>
      </div>
    </article>`;
  }).join('')}</div>`;
}

function renderCommentRiskTable(rows = []) {
  if (!rows.length) return '<div class="osv-empty">暂无负面评论样本</div>';
  return `<table class="osv-table"><thead><tr><th>评论</th><th>风险</th><th>来源</th><th>赞</th></tr></thead><tbody>${rows.slice(0, 8).map(row => `
    <tr>
      <td><strong>${escHtml(row.author_name || '匿名评论者')}</strong><div>${escHtml(compactText(row.content, 92))}</div></td>
      <td><span class="osv-pill red">${escHtml(row.risk_level || 'negative')}</span></td>
      <td>${row.record_url ? `<a href="${escHtml(safeUrl(row.record_url))}">${escHtml(compactText(row.record_title || '原帖', 42))}</a>` : escHtml(compactText(row.record_title || '原帖', 42))}</td>
      <td>${n0(row.like_count)}</td>
    </tr>
  `).join('')}</tbody></table>`;
}

function renderIssueSummary(stats) {
  const rows = [
    ['新增问题', stats.issueStats?.new_issues || 0, 'blue'],
    ['未关闭', stats.issueStats?.open_issues || 0, 'orange'],
    ['高危未关闭', stats.issueStats?.high_open_issues || 0, 'red'],
    ['本期关闭', stats.issueStats?.resolved_issues || 0, 'green'],
  ];
  return `<div class="osv-grid-3" style="grid-template-columns:repeat(4,minmax(0,1fr));">${rows.map(row => `
    <div class="osv-topic-box"><h4><span>${escHtml(row[0])}</span><span class="osv-pill ${row[2]}">${n0(row[1])}</span></h4></div>
  `).join('')}</div>${renderIssues(stats.topIssues || [])}`;
}

function renderOfficialResponseList(rows = []) {
  if (!rows.length) return '<div class="osv-empty">本周期暂无官方响应样本</div>';
  return `<div class="osv-sample-list">${rows.slice(0, 5).map(row => `
    <article class="osv-topic-box">
      <h4><span>${escHtml(row.account_name || '官方账号')}</span><span class="osv-pill green">已响应</span></h4>
      <p>${escHtml(compactText(row.content, 126))}</p>
      <p>来源：${row.record_url ? `<a href="${escHtml(safeUrl(row.record_url))}">${escHtml(compactText(row.record_title || '原帖', 54))}</a>` : escHtml(compactText(row.record_title || '原帖', 54))}</p>
    </article>
  `).join('')}</div>`;
}

function buildManagementReportHTML(title, periodLabel, stats) {
  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return `${reportCss()}
    <main class="osv-report">
      <div class="osv-shell">
        <header class="osv-hero">
          <div>
            <div class="osv-kicker">StarVoice 星语 · Management Report</div>
            <h1 class="osv-title">${escHtml(title)}</h1>
            <div class="osv-subtitle">${escHtml(periodLabel)} · ${escHtml(stats.periodFocus)} · 生成时间 ${escHtml(generatedAt)}</div>
          </div>
          <aside class="osv-risk">
            <span>本周期风险等级</span>
            <strong style="color:${stats.riskColor}">${escHtml(stats.riskLabel)}</strong>
            <span>负面率 ${stats.negativeRate}% · 待处理 ${n0(stats.workflowStats.active_inbox)} · 高危告警 ${n0(alertCount(stats, 'critical'))}</span>
          </aside>
        </header>
        ${renderReportKpis(stats.dashboardCards)}
        <section class="osv-grid">
          ${renderReportCard('舆情态势指数', renderOpinionIndex(stats), '热度 / 风险 / 响应')}
          ${renderReportCard('平台声量矩阵', renderPlatformMatrix(stats.platformMatrix), '声量、互动与负面率综合排序')}
        </section>
        <section class="osv-grid">
          ${renderReportCard('管理摘要', renderList(stats.executiveSummary), '结论先行')}
          ${renderReportCard('行动建议', renderList(stats.actionItems, true), '按处置优先级执行')}
        </section>
        <section class="osv-grid">
          ${renderReportCard('声量与情绪趋势', renderTrendSvg(stats.volumeTrend), '按采集快照聚合')}
          ${renderReportCard('热点词云', renderWordCloud(stats.hotTerms), '关键词 / 正文 / 评论')}
        </section>
        <section class="osv-grid-3">
          ${renderReportCard('平台分布', renderDistribution(stats.platformDistribution, { labelKey: 'platform', total: Math.max(stats.total, 1), labelMap: PLATFORM_LABEL, color: '#2563EB' }))}
          ${renderReportCard('主题分类', renderDistribution(stats.category, { labelKey: 'category', total: Math.max(stats.total, 1), labelMap: CATEGORY_LABEL, color: '#0F766E' }))}
          ${renderReportCard('媒体/来源类型', renderDistribution(stats.mediaDistribution, { labelKey: 'media_type', total: Math.max(stats.total, 1), color: '#7C3AED' }))}
        </section>
        <section class="osv-grid">
          ${renderReportCard('情感与内容焦点', renderTopicFocus(stats.topicFocus), '正 / 中 / 负拆解')}
          ${renderReportCard('地域/发布位置', renderDistribution(stats.regionDistribution, { labelKey: 'region', total: Math.max(stats.total, 1), color: '#D97706' }), '采集不到则显示未采集')}
        </section>
        <section class="osv-grid">
          ${renderReportCard('重点负面内容', renderSampleCards(stats.riskItems, '暂无重点负面内容'), '按风险和互动排序')}
          ${renderReportCard('负面评论舆情', renderCommentRiskTable(stats.commentRisks), '评论同样进入舆情判断')}
        </section>
        <section class="osv-grid">
          ${renderReportCard('问题闭环', renderIssueSummary(stats), '问题状态和负责人')}
          ${renderReportCard('官方响应', renderOfficialResponseList(stats.officialResponses), `本周期覆盖 ${n0(stats.officialPeriod.record_count)} 条内容`)}
        </section>
        <section class="osv-grid">
          ${renderReportCard('互动增长内容', renderSampleCards(stats.risingRecords, '暂无互动明显增长内容'), '重复采集快照识别增长')}
          ${renderReportCard('采集质量与补强', renderList(stats.collectionRecommendations), '用于提升下一期报告准确性')}
        </section>
        <footer class="osv-footer">本报告基于公开内容、采集快照、评论舆情、官方响应、告警和问题单自动生成。发送前建议复核重点样本、官方回复语境和处置建议。</footer>
      </div>
    </main>`;
}

function buildDataDashboardHTML(title, periodLabel, stats) {
  return `${reportCss()}
    <main class="osv-report osv-screen">
      <div class="osv-shell">
        <header class="osv-hero">
          <div>
            <div class="osv-kicker">Public Opinion Intelligence Dashboard</div>
            <h1 class="osv-title">${escHtml(title)} · 报告看板</h1>
            <div class="osv-subtitle">${escHtml(periodLabel)} · ${escHtml(stats.periodFocus)} · 声量、情绪、热词、风险样本与处置闭环统一呈现</div>
          </div>
          <aside class="osv-risk">
            <span>本期舆情总量</span>
            <strong>${n0(stats.total)}</strong>
            <span>新增 ${n0(stats.newRecords)} · 快照 ${n0(stats.observations)} · ${escHtml(stats.riskLabel)}</span>
          </aside>
        </header>
        ${renderReportKpis(stats.dashboardCards)}
        <section class="osv-grid">
          ${renderReportCard('舆情态势指数', renderOpinionIndex(stats), '综合热度 / 风险 / 响应')}
          ${renderReportCard('平台声量矩阵', renderPlatformMatrix(stats.platformMatrix), '声量、互动与负面率综合排序')}
        </section>
        <section class="osv-screen-grid">
          <div style="display:grid;gap:14px;">
            ${renderReportCard('情绪结构', renderSentimentDonut(stats), '正 / 中 / 负 / 待标注')}
            ${renderReportCard('主题分类', renderDistribution(stats.category, { labelKey: 'category', total: Math.max(stats.total, 1), labelMap: CATEGORY_LABEL, color: '#0F766E' }))}
            ${renderReportCard('分流状态', renderDistribution(stats.triagePeriod, { labelKey: 'status', total: Math.max(stats.total, 1), labelMap: TRIAGE_LABEL, color: '#D97706' }))}
          </div>
          <div style="display:grid;gap:14px;">
            ${renderReportCard('声量趋势', renderTrendSvg(stats.volumeTrend), '采集快照趋势')}
            ${renderReportCard('热议方向', renderWordCloud(stats.hotTerms), '热词云')}
            ${renderReportCard('热词指数榜', renderHotTermRank(stats.hotTerms), 'TOP 10')}
          </div>
          <div style="display:grid;gap:14px;">
            ${renderReportCard('预警快报', renderAlertFeed(stats.topAlerts), '告警优先级')}
            ${renderReportCard('高风险内容', renderSampleCards(stats.riskItems.slice(0, 4), '暂无高风险内容'), '帖子/内容样本')}
            ${renderReportCard('负面评论', renderCommentRiskTable(stats.commentRisks.slice(0, 5)), '评论同样进入舆情')}
          </div>
        </section>
        <section class="osv-grid">
          ${renderReportCard('情感与内容焦点', renderTopicFocus(stats.topicFocus), '正 / 中 / 负拆解')}
          ${renderReportCard('地域/发布位置', renderDistribution(stats.regionDistribution, { labelKey: 'region', total: Math.max(stats.total, 1), color: '#0F766E' }), '未采集会显示未采集')}
        </section>
        <section class="osv-grid">
          ${renderReportCard('问题闭环', renderIssueSummary(stats), '新增、未关闭、高危、已关闭')}
          ${renderReportCard('官方响应', renderOfficialResponseList(stats.officialResponses), `本周期覆盖 ${n0(stats.officialPeriod.record_count)} 条内容`)}
        </section>
      </div>
    </main>`;
}

function buildEmailSummaryHTML(title, periodLabel, stats, reportId = '') {
  const kpis = stats.dashboardCards.slice(0, 6);
  return `${styleBlock()}
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif; max-width:760px; margin:0 auto; background:#F6F8FB; padding:18px; color:#111827;">
      <div style="background:#FFFFFF; border:1px solid #E5E7EB; border-radius:10px; overflow:hidden;">
        <div style="padding:22px 24px; border-bottom:1px solid #E5E7EB;">
          <div style="font-size:12px; color:#2563EB; font-weight:800;">StarVoice 星语 · 邮件摘要</div>
          <h1 style="margin:8px 0 8px; font-size:22px; line-height:1.3;">${escHtml(title)}</h1>
          <div style="font-size:13px; color:#6B7280;">${escHtml(periodLabel)} · 风险等级：<strong style="color:${stats.riskColor}">${escHtml(stats.riskLabel)}</strong>${reportId ? ` · 报告ID ${escHtml(reportId)}` : ''}</div>
        </div>
        <div style="padding:20px 24px;">
          <div class="report-grid" style="display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px;">
            ${kpis.map(card => `<div class="report-card" style="border:1px solid #E5E7EB; border-radius:8px; padding:12px;">
              <div style="font-size:12px; color:#6B7280;">${escHtml(card.label)}</div>
              <div style="font-size:22px; font-weight:800; margin-top:4px;">${escHtml(card.value)}</div>
              ${card.delta ? `<div style="font-size:12px; color:#6B7280;">较上期 ${escHtml(card.delta.value)}</div>` : ''}
            </div>`).join('')}
          </div>
          ${renderSection('管理摘要', renderList(stats.executiveSummary), '')}
          ${renderSection('行动建议', renderList(stats.actionItems.slice(0, 5), true), '')}
          ${renderSection('TOP 风险内容', renderEvidenceRows(stats.riskItems.slice(0, 4), '暂无重点风险内容'), '')}
          ${renderSection('待处理问题', renderIssues(stats.topIssues.slice(0, 5)), '')}
          ${renderSection('官方响应概况', `<p style="margin:0;color:#374151;font-size:13px;line-height:1.7;">本周期记录官方响应 ${n0(stats.officialPeriod.response_count)} 条，覆盖 ${n0(stats.officialPeriod.record_count)} 条内容；当前待处理/待复核线索 ${n0(stats.workflowStats.active_inbox)} 条。</p>`, '')}
          <div style="margin-top:22px; padding:12px; background:#F9FAFB; border-radius:8px; color:#6B7280; font-size:12px; line-height:1.7;">完整图表、词云、评论样本和处置看板请在后台「报告中心」打开预览。若邮件发送失败，请检查系统设置中的 SMTP 与收件人配置。</div>
        </div>
      </div>
    </div>`;
}

async function upsertReportRun({ tenantId, type, periodStart, periodEnd, subject, html, dashboardHtml, emailHtml, stats, status, template = 'management' }) {
  return await withTransaction(async tx => {
    const run = await tx.queryOne(`
      INSERT INTO report_runs (
        tenant_id, report_type, period_start, period_end, status, subject, html,
        generated_at, metadata, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8::jsonb, now())
      ON CONFLICT (tenant_id, report_type, period_start, period_end)
      DO UPDATE SET
        status = excluded.status,
        subject = excluded.subject,
        html = excluded.html,
        generated_at = now(),
        metadata = excluded.metadata,
        updated_at = now(),
        error_message = ''
      RETURNING *
    `, [
      tenantId,
      type,
      periodStart.toISOString(),
      periodEnd.toISOString(),
      status,
      subject,
      html,
      JSON.stringify({ stats, dashboardHtml, emailHtml, template }),
    ]);

    await tx.execute('DELETE FROM report_snapshots WHERE report_run_id = $1', [run.id]);
    await tx.execute(
      'INSERT INTO report_snapshots (tenant_id, report_run_id, data) VALUES ($1, $2, $3::jsonb)',
      [tenantId, run.id, JSON.stringify(stats)]
    );
    return run;
  });
}

async function listTenantIds() {
  const tenants = await queryAll("SELECT id FROM tenants WHERE status = 'active'");
  return tenants.map(t => t.id);
}

export async function generateReport({ tenantId, type = 'daily', send = true, now = new Date(), template = 'management' }) {
  const { start, end } = periodFor(type, now);
  const previous = previousPeriod(start, end);
  const existing = await queryOne(`
    SELECT * FROM report_runs
    WHERE tenant_id = $1 AND report_type = $2 AND period_start = $3 AND period_end = $4
  `, [tenantId, type, start.toISOString(), end.toISOString()]);
  if (send && existing?.status === 'sent') return existing;

  const currentStats = await getReportStats(tenantId, start, end);
  const previousStats = await getReportStats(tenantId, previous.start, previous.end);
  const stats = enrichReportData(type, currentStats, previousStats);
  const typeLabel = { daily: '日报', weekly: '周报', monthly: '月报' }[type] || '报表';
  const title = `StarVoice 星语舆情${typeLabel}`;
  const periodLabel = `${dateLabel(start)} - ${dateLabel(end)}`;
  const subject = `[StarVoice 星语${typeLabel}] ${periodLabel} ${stats.riskLabel} · 负面率 ${stats.negativeRate}%`;
  const html = buildManagementReportHTML(title, periodLabel, stats);
  const dashboardHtml = buildDataDashboardHTML(title, periodLabel, stats);
  const emailHtml = buildEmailSummaryHTML(title, periodLabel, stats);
  const hasContent = stats.total > 0 || stats.issueStats.open_issues > 0 || stats.workflowStats.active_inbox > 0;
  const status = hasContent ? (send ? 'generating' : 'generated') : 'skipped';

  let run = await upsertReportRun({ tenantId, type, periodStart: start, periodEnd: end, subject, html, dashboardHtml, emailHtml, stats, status, template });

  if (!hasContent || !send) return run;

  try {
    await sendReportEmail(subject, emailHtml, tenantId);
    await execute("UPDATE report_runs SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1", [run.id]);
    run = { ...run, status: 'sent' };
  } catch (err) {
    await execute("UPDATE report_runs SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2", [err.message, run.id]);
    throw err;
  }

  return run;
}

async function generateForTenants(type, tenantId = null) {
  const tenantIds = tenantId ? [tenantId] : await listTenantIds();
  const runs = [];
  for (const id of tenantIds) {
    const enabled = await getSetting(`report_${type}_enabled`, id);
    if (enabled === 'false') continue;
    runs.push(await generateReport({ tenantId: id, type }));
  }
  return runs;
}

export async function generateDailyReport(tenantId = null) {
  return await generateForTenants('daily', tenantId);
}

export async function generateWeeklyReport(tenantId = null) {
  return await generateForTenants('weekly', tenantId);
}

export async function generateMonthlyReport(tenantId = null) {
  return await generateForTenants('monthly', tenantId);
}

export async function resendReport(reportId, tenantId = null) {
  const params = tenantId ? [reportId, tenantId] : [reportId];
  const where = tenantId ? 'id = $1 AND tenant_id = $2' : 'id = $1';
  const report = await queryOne(`SELECT * FROM report_runs WHERE ${where}`, params);
  if (!report) return null;
  const metadata = parseJsonObject(report.metadata);
  await sendReportEmail(report.subject, metadata.emailHtml || report.html, report.tenant_id);
  await execute('UPDATE report_runs SET sent_at = now(), status = $1, updated_at = now() WHERE id = $2', ['sent', report.id]);
  await execute(`
    INSERT INTO audit_logs (tenant_id, action, target_type, target_id, metadata)
    VALUES ($1, 'report_resend', 'report_run', $2, $3::jsonb)
  `, [report.tenant_id, report.id, JSON.stringify({ reportType: report.report_type })]);
  return { ...report, status: 'sent' };
}
