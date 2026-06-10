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
  issue_linked: '已转问题',
  official_responded: '官方已响应',
  archived: '已归档',
  false_positive: '误报',
};

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
  `;
  const periodWhere = `
    FROM records r
    WHERE r.tenant_id = $1
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
        r.author_fans, r.sentiment, r.category, r.intent, r.keyword, r.ai_summary,
        r.likes, r.comments_count, r.collects, r.shares, r.official_response_status,
        r.official_replied, r.negative_comment_count, r.latest_negative_comment_at,
        r.created_at, r.last_seen_at
      ${periodWhere}
    )
  `;

  const total = await scalar(`SELECT COUNT(DISTINCT r.id) as n ${periodWhere}`, params);
  const newRecords = await scalar(
    'SELECT COUNT(*) as n FROM records WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3',
    params
  );
  const updatedRecords = await scalar(
    `SELECT COUNT(DISTINCT r.id) as n ${observedWhere} AND r.created_at < $2`,
    params
  );
  const observations = await scalar(
    'SELECT COUNT(*) as n FROM record_observations WHERE tenant_id = $1 AND captured_at >= $2 AND captured_at < $3',
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
    'SELECT level, COUNT(*) as count FROM alerts WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY level',
    params
  ), ['count']);

  const topAlerts = normalizeRows(await queryAll(
    `SELECT id, level, title, summary, reason, url, interaction_total, created_at
     FROM alerts
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
     ORDER BY CASE level WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
       interaction_total DESC, created_at DESC
     LIMIT 6`,
    params
  ), ['interaction_total']);

  const commentStats = await queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3) as new_comments,
       COUNT(*) FILTER (WHERE is_negative = true AND last_seen_at >= $2 AND last_seen_at < $3) as negative_comments,
       COUNT(*) FILTER (WHERE is_official = true AND last_seen_at >= $2 AND last_seen_at < $3) as official_comments
     FROM record_comments
     WHERE tenant_id = $1`,
    params
  );

  const negativeComments = normalizeRows(await queryAll(
    `SELECT rc.id, rc.record_id, rc.platform, rc.author_name, rc.content, rc.like_count,
       rc.risk_level, rc.sentiment, rc.category, rc.published_at, rc.last_seen_at,
       r.title as record_title, r.url as record_url
     FROM record_comments rc
     JOIN records r ON r.id = rc.record_id AND r.tenant_id = rc.tenant_id
     WHERE rc.tenant_id = $1
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

  const officialPeriod = await queryOne(
    `SELECT COUNT(*) as response_count, COUNT(DISTINCT record_id) as record_count
     FROM official_responses
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
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
       COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'issue_linked') as issue_linked,
       COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'archived') as archived,
       COUNT(*) FILTER (WHERE COALESCE(rt.status, 'unhandled') = 'false_positive') as false_positive
     FROM records r
     LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
     WHERE r.tenant_id = $1`,
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
  const typeName = { daily: '日报', weekly: '周报', monthly: '月报' }[type] || '报表';

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
    dashboardCards,
    executiveSummary,
    actionItems: buildActionItems(current, negativeRate, riskLevel),
    collectionRecommendations: buildCollectionRecommendations(current),
  };
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

function buildReportHTML(title, periodLabel, stats) {
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
          <div style="font-size:12px; color:#CBD5E1; font-weight:700; letter-spacing:0;">OnStarVoice 星语 · 舆情报告</div>
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

async function upsertReportRun({ tenantId, type, periodStart, periodEnd, subject, html, stats, status }) {
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
      JSON.stringify({ stats }),
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

export async function generateReport({ tenantId, type = 'daily', send = true, now = new Date() }) {
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
  const title = `OnStarVoice 星语舆情${typeLabel}`;
  const periodLabel = `${dateLabel(start)} - ${dateLabel(end)}`;
  const subject = `[OnStarVoice 星语${typeLabel}] ${periodLabel} ${stats.riskLabel} · 负面率 ${stats.negativeRate}%`;
  const html = buildReportHTML(title, periodLabel, stats);
  const hasContent = stats.total > 0 || stats.issueStats.open_issues > 0 || stats.workflowStats.active_inbox > 0;
  const status = hasContent ? (send ? 'generating' : 'generated') : 'skipped';

  let run = await upsertReportRun({ tenantId, type, periodStart: start, periodEnd: end, subject, html, stats, status });

  if (!hasContent || !send) return run;

  try {
    await sendReportEmail(subject, html, tenantId);
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
  await sendReportEmail(report.subject, report.html, report.tenant_id);
  await execute('UPDATE report_runs SET sent_at = now(), status = $1, updated_at = now() WHERE id = $2', ['sent', report.id]);
  await execute(`
    INSERT INTO audit_logs (tenant_id, action, target_type, target_id, metadata)
    VALUES ($1, 'report_resend', 'report_run', $2, $3::jsonb)
  `, [report.tenant_id, report.id, JSON.stringify({ reportType: report.report_type })]);
  return { ...report, status: 'sent' };
}
