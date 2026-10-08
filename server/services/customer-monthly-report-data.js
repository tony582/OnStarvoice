import {CUSTOMER_ACTIVE_TRIAGE_SQL, isActiveDailyTriagePost} from './customer-daily-triage-scope.js';
import {countCustomerDailyPosts as count} from './customer-daily-report-data.js';
import {CONTENT_TOPIC_LABELS, normalizeContentTopic} from './content-topic.js';
import {customerDailyPostPlatform} from './customer-daily-report-presentation.js';

export const CUSTOMER_MONTHLY_SCHEMA_VERSION = 1;
export const CUSTOMER_MONTHLY_KIND = 'customer_monthly_v1';
export const CUSTOMER_MONTHLY_BASIS = 'published_ts_triage_scope_v1';
export const CUSTOMER_MONTHLY_HEAT_THRESHOLD = 200;
export const CUSTOMER_MONTHLY_TOP_NEGATIVE_LIMIT = 20;
export const CUSTOMER_MONTHLY_TOPIC_UNCLASSIFIED = 'unclassified';

const ZONE_OFFSET = 8 * 3_600_000;
const NON_POST_TYPES = new Set(['official_content', 'blogger_profile', 'comment', 'comments', 'record_comment', 'comment_detail']);
const NEGATIVE_STATES = new Set(['negative_cold', 'negative_comment', 'negative_feishu', 'privacy_unreachable']);
const SENTIMENT_LABELS = Object.freeze({positive: '正面', neutral: '中性', negative: '负面'});

function ms(value) { return value === null || value === undefined || value === '' ? NaN : new Date(value).getTime(); }
function iso(value) { const n = ms(value); return Number.isFinite(n) ? new Date(n).toISOString() : null; }
function shanghaiDate(value) { return new Date(ms(value) + ZONE_OFFSET).toISOString().slice(0, 10); }
function status(row) { return row.status || row.triage_status || 'unhandled'; }
function metric(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null; }
function safeUrl(value) {
  try { const url = new URL(String(value || '')); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}
function text(value) { return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(); }
function reportError(message, code = 'invalid_report_month') { return Object.assign(new Error(message), {statusCode: 400, status: 400, code}); }

export function customerMonthlySentimentLabel(value) { return SENTIMENT_LABELS[value] || '待识别'; }
export function customerMonthlyTopicLabel(topic) {
  return topic === CUSTOMER_MONTHLY_TOPIC_UNCLASSIFIED || !topic ? '主题生成中' : CONTENT_TOPIC_LABELS[topic] || '主题生成中';
}

/** Report months are Beijing calendar months; the current month is month-to-date. */
export function customerMonthlyPeriod(month, now = new Date()) {
  const timestamp = ms(now);
  if (!Number.isFinite(timestamp)) throw reportError('生成时间无效');
  const reportMonth = month == null || month === '' ? shanghaiDate(timestamp).slice(0, 7) : String(month);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(reportMonth)) throw reportError('月报月份须为 YYYY-MM');
  const [year, monthNumber] = reportMonth.split('-').map(Number);
  const next = monthNumber === 12 ? `${year + 1}-01` : `${year}-${String(monthNumber + 1).padStart(2, '0')}`;
  const periodStart = Date.parse(`${reportMonth}-01T00:00:00+08:00`);
  const periodEnd = Date.parse(`${next}-01T00:00:00+08:00`);
  if (periodStart > timestamp) throw reportError('不能生成未来月份的月报');
  const complete = timestamp >= periodEnd;
  const cutoff = complete ? periodEnd : timestamp;
  return {reportMonth, periodStart: new Date(periodStart).toISOString(), periodEnd: new Date(periodEnd).toISOString(),
    cutoffAt: new Date(cutoff).toISOString(), assessedAt: new Date(timestamp).toISOString(), complete, mode: complete ? 'formal' : 'realtime'};
}

function monthDates(period) {
  const dates = [];
  const last = period.complete ? new Date(Date.parse(period.periodEnd) - 1 + ZONE_OFFSET).getUTCDate() : Number(shanghaiDate(period.cutoffAt).slice(-2));
  for (let day = 1; day <= last; day++) dates.push(`${period.reportMonth}-${String(day).padStart(2, '0')}`);
  return dates;
}

function detailRow(row) {
  const likes = metric(row.likes), comments = metric(row.comments_count), collects = metric(row.collects), shares = metric(row.shares);
  const topic = normalizeContentTopic(row.content_topic);
  return {recordId: row.id, publishedAt: iso(row.published_ts), publishedDate: shanghaiDate(row.published_ts), firstSeenAt: iso(row.first_seen_at),
    platform: row.platform || 'unknown', platformLabel: customerDailyPostPlatform({platform: row.platform}), title: text(row.title) || '未命名帖子',
    url: safeUrl(row.url) || safeUrl(row.canonical_url), authorName: text(row.author_name), sentiment: row.sentiment || '',
    status: status(row), feishuTableNo: text(row.feishu_table_no), topic: topic || CUSTOMER_MONTHLY_TOPIC_UNCLASSIFIED, topicLabel: customerMonthlyTopicLabel(topic),
    keyword: text(row.keyword), watched: row.watched === true, likes, comments, collects, shares,
    heat: [likes, comments, collects, shares].reduce((sum, value) => sum + (value ?? 0), 0), metricsKnown: [likes, comments, collects, shares].every(value => value !== null)};
}

export function buildCustomerMonthlySummary(records, period) {
  const byDate = new Map();
  for (const record of records) {
    if (!byDate.has(record.publishedDate)) byDate.set(record.publishedDate, []);
    byDate.get(record.publishedDate).push(record);
  }
  const rows = monthDates(period).map(date => ({date, counts: count(byDate.get(date) || [])}));
  const topics = [...Object.keys(CONTENT_TOPIC_LABELS), CUSTOMER_MONTHLY_TOPIC_UNCLASSIFIED];
  const byTopic = topics.map(topic => ({topic, label: customerMonthlyTopicLabel(topic), counts: count(records.filter(record => record.topic === topic))}))
    .filter(row => row.topic !== CUSTOMER_MONTHLY_TOPIC_UNCLASSIFIED || row.counts.monitor > 0);
  const platforms = new Map();
  for (const record of records) {
    const key = record.platformLabel;
    if (!platforms.has(key)) platforms.set(key, {platform: record.platform, label: key, records: []});
    platforms.get(key).records.push(record);
  }
  const byPlatform = [...platforms.values()].map(entry => ({platform: entry.platform, label: entry.label, counts: count(entry.records)}))
    .sort((a, b) => b.counts.monitor - a.counts.monitor || a.label.localeCompare(b.label, 'zh-Hans-CN'));
  return {basis: CUSTOMER_MONTHLY_BASIS, dateField: 'records.published_ts', reportMonth: period.reportMonth, rows, total: count(records), byTopic, byPlatform};
}

export function selectCustomerMonthlyTopNegative(records, {threshold = CUSTOMER_MONTHLY_HEAT_THRESHOLD, limit = CUSTOMER_MONTHLY_TOP_NEGATIVE_LIMIT} = {}) {
  return records.filter(record => record.sentiment === 'negative' && record.status !== 'reviewed_non_monitor' && record.heat >= threshold)
    .sort((a, b) => b.heat - a.heat || ms(b.publishedAt) - ms(a.publishedAt) || a.recordId.localeCompare(b.recordId))
    .slice(0, limit)
    .map(record => ({recordId: record.recordId, title: record.title, platform: record.platform, url: record.url, heat: record.heat, heatIsLowerBound: !record.metricsKnown,
      likes: record.likes, comments: record.comments, collects: record.collects, shares: record.shares, publishedAt: record.publishedAt,
      status: record.status, feishuTableNo: record.feishuTableNo, topic: record.topic, topicLabel: record.topicLabel}));
}

export async function collectCustomerMonthlyReport({tenantId, month, now = new Date(), db, period = null}) {
  if (!tenantId) throw Object.assign(new Error('缺少租户'), {statusCode: 400, status: 400});
  if (!db?.queryAll || !db?.queryOne) throw new TypeError('月报聚合需要数据库事务');
  const current = period || customerMonthlyPeriod(month, now);
  const tenant = await db.queryOne('/* customer_monthly:tenant */ SELECT name FROM tenants WHERE id = $1', [tenantId]);
  if (!tenant) throw Object.assign(new Error('租户不存在'), {statusCode: 404, status: 404});
  const rows = await db.queryAll(`/* customer_monthly:posts */
    SELECT r.id, r.platform, r.title, r.url, r.canonical_url, r.author_name, r.published_ts, r.created_at AS first_seen_at,
      r.record_type, r.business_visibility, r.sentiment, r.keyword, r.content_topic,
      r.likes, r.comments_count, r.collects, r.shares,
      COALESCE(rt.status, 'unhandled') AS status, rt.archived_at, rt.feishu_table_no, true AS admission_allowed,
      EXISTS (SELECT 1 FROM record_watchlist w WHERE w.tenant_id=r.tenant_id AND w.record_id=r.id) AS watched
    FROM records r LEFT JOIN record_triage rt ON rt.tenant_id = r.tenant_id AND rt.record_id = r.id
    WHERE r.tenant_id = $1 AND r.published_ts >= $2::timestamptz AND r.published_ts < $3::timestamptz
      AND ${CUSTOMER_ACTIVE_TRIAGE_SQL}
    ORDER BY r.published_ts, r.id`, [tenantId, current.periodStart, current.cutoffAt]);
  const unique = new Map();
  for (const row of rows) {
    if (NON_POST_TYPES.has(row.record_type) || row.business_visibility !== 'eligible' || !isActiveDailyTriagePost(row)) continue;
    if (!(ms(row.published_ts) >= ms(current.periodStart) && ms(row.published_ts) < ms(current.cutoffAt))) continue;
    const key = String(row.id).toLowerCase();
    if (!unique.has(key)) unique.set(key, detailRow(row));
  }
  const records = [...unique.values()];
  const missingPublished = await db.queryOne(`/* customer_monthly:missing_published */
    SELECT COUNT(*)::int AS count FROM records r
    LEFT JOIN record_triage rt ON rt.tenant_id = r.tenant_id AND rt.record_id = r.id
    WHERE r.tenant_id = $1 AND r.published_ts IS NULL AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz
      AND ${CUSTOMER_ACTIVE_TRIAGE_SQL}`, [tenantId, current.periodStart, current.cutoffAt]);
  const summary = buildCustomerMonthlySummary(records, current);
  const topNegative = selectCustomerMonthlyTopNegative(records);
  const warnings = [];
  const warn = (code, message, blocking = false) => warnings.push({code, message, blocking});
  const missingCount = Number(missingPublished?.count) || 0;
  if (missingCount > 0) warn('published_time_missing', `本月采集入库的内容分诊帖子中${missingCount}条缺少发布时间，无法按发帖时间归入月报。`);
  if (summary.total.unclassified) warn('unclassified', `本月${summary.total.unclassified}条SDB内容尚未完成情感识别，未自动归为中性。`, true);
  const conflicts = records.filter(record => NEGATIVE_STATES.has(record.status) && record.sentiment !== 'negative');
  if (conflicts.length) warn('sentiment_status_conflict', `本月${conflicts.length}条帖子的情感结论与负面处理状态不一致，按有效情感统计，需核对。`, true);
  const pendingTopics = records.filter(record => record.topic === CUSTOMER_MONTHLY_TOPIC_UNCLASSIFIED).length;
  if (pendingTopics) warn('topic_pending', `本月${pendingTopics}条帖子的内容主题尚未生成，暂列为“主题生成中”。`);
  const unverifiedHeat = topNegative.filter(post => post.heatIsLowerBound).length;
  if (unverifiedHeat) warn('heat_lower_bound', `${unverifiedHeat}篇高热负面帖子有互动项未取得，热度按已知项合计，标为至少。`);
  if (!current.complete) warn('month_in_progress', `本月尚未结束，月报仅统计截至${shanghaiDate(current.cutoffAt)}发布的帖子。`);
  const missingLinks = records.filter(record => !record.url).length;
  if (missingLinks) warn('source_link_missing', `${missingLinks}篇帖子缺少可用原帖链接，明细中链接留空。`);
  return {
    schemaVersion: CUSTOMER_MONTHLY_SCHEMA_VERSION, kind: CUSTOMER_MONTHLY_KIND, tenantId, tenantName: tenant.name || '', ...current,
    summary, topNegative, records, warnings,
    evidence: {
      scope: '当前租户内容分诊未归档主帖：业务可见、符合分诊准入和有效相关性（含客户关注帖），按北京时间发帖时间归入月份；同帖只计一次；SDB扣除已复核-非监控内容；情感、处理状态与内容主题取本版生成时的有效结论',
      basis: CUSTOMER_MONTHLY_BASIS, dateField: 'records.published_ts', timeZone: 'Asia/Shanghai', recordCount: records.length,
      missingPublishedCount: missingCount, conflictRecordIds: conflicts.map(record => record.recordId),
      heat: {source: 'records.current_metrics', threshold: CUSTOMER_MONTHLY_HEAT_THRESHOLD, limit: CUSTOMER_MONTHLY_TOP_NEGATIVE_LIMIT},
    },
  };
}
