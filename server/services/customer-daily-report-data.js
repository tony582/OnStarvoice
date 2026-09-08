import {resolveMetricUpdateFromPayload} from '../utils/metrics.js';

export {
  renderCustomerDailyReportHtml,
  renderCustomerDailyReportText,
  buildCustomerDailyReportWorkbook,
} from './customer-daily-report-render.js';

const DAY = 86_400_000;
const ZONE_OFFSET = 8 * 3_600_000;
const SENTIMENTS = new Set(['positive', 'neutral', 'negative']);
const NEGATIVE_STATES = new Set(['negative_cold', 'negative_feishu', 'privacy_unreachable']);
const NON_POST_TYPES = new Set(['official_content', 'blogger_profile', 'comment', 'comments', 'record_comment', 'comment_detail']);
const POST_SQL = "r.record_type NOT IN ('official_content', 'blogger_profile', 'comment', 'comments', 'record_comment', 'comment_detail')";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_CAPTURE = new Set(['pending', 'waiting_device', 'claimed', 'running', 'recovering', 'interrupted', 'resume_requested', 'needs_action']);
const PATROL_WORKFLOWS = new Set(['negative_post_patrol', 'watched_content_patrol', 'followed_creator_post_patrol', 'official_account_comment_patrol', 'official_account_post_discovery']);
const METRICS = {
  likes: ['likes', 'likeCount', 'like_count', 'diggCount', 'digg_count', 'attitudes_count', 'attitudesCount'],
  comments_count: ['comments', 'commentCount', 'comment_count', 'commentsCount', 'comments_count'],
  collects: ['collects', 'collectCount', 'collect_count', 'collectsCount', 'collects_count'],
  shares: ['shares', 'shareCount', 'share_count', 'reposts', 'repostCount', 'repost_count', 'repostsCount', 'reposts_count'],
};
const PROJECTION_KEYS = [...new Set([
  ...Object.values(METRICS).flat(), 'syncType', 'detailCaptureStatus', 'captureTimestamp',
  'displayMetricDimension', 'displayMetricCount', 'displayMetricKnown', 'metricKnown',
  'likesKnown', 'likeCountKnown', 'commentsKnown', 'commentsCountKnown', 'commentCountKnown',
  'collectsKnown', 'collectsCountKnown', 'collectCountKnown', 'sharesKnown', 'sharesCountKnown',
  'shareCountKnown', 'commentsCountSource', 'commentCountSource', 'comments_count_source',
  'comment_count_source', 'customerDailyMetricEvidence',
])];

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { /* Invalid legacy payload. */ } }
  return {};
}
function ms(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return new Date(value).getTime();
}
function iso(value) { const n = ms(value); return Number.isFinite(n) ? new Date(n).toISOString() : null; }
function shanghaiDate(value) { return new Date(ms(value) + ZONE_OFFSET).toISOString().slice(0, 10); }
function number(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; }
function mainPost(row) { return !NON_POST_TYPES.has(row.record_type); }
function status(row) { return row.status || row.triage_status || 'unhandled'; }
function safeUrl(value) {
  try { const url = new URL(String(value || '')); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}
function reportError(message) { return Object.assign(new Error(message), {statusCode: 400, code: 'invalid_report_date'}); }

export function dailyPeriod(date, now = new Date()) {
  const timestamp = ms(now);
  if (!Number.isFinite(timestamp)) throw reportError('生成时间无效');
  const today = shanghaiDate(now);
  const reportDate = date == null || date === '' ? shanghaiDate(timestamp - DAY) : String(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw reportError('日报日期须为 YYYY-MM-DD');
  const start = Date.parse(`${reportDate}T00:00:00+08:00`);
  if (!Number.isFinite(start) || shanghaiDate(start) !== reportDate) throw reportError('日报日期无效');
  if (reportDate > today) throw reportError('不能生成未来日期日报');
  const cutoff = reportDate === today ? timestamp : start + DAY;
  return {
    reportDate, periodStart: new Date(start).toISOString(), cutoffAt: new Date(cutoff).toISOString(),
    assessedAt: new Date(timestamp).toISOString(), monthStart: new Date(`${reportDate.slice(0, 7)}-01T00:00:00+08:00`).toISOString(),
    heatStart: new Date(cutoff - 7 * DAY).toISOString(), mode: reportDate === today ? 'realtime' : 'formal',
  };
}

function emptyCounts() {
  return {monitor: 0, sdb: 0, positive: 0, neutral: 0, negative: 0, cold: 0, inProgress: null, processed: null, unclassified: 0, nonMonitor: 0};
}
function count(rows) {
  const c = emptyCounts();
  for (const row of rows) {
    c.monitor++;
    if (status(row) === 'reviewed_non_monitor') { c.nonMonitor++; continue; }
    c.sdb++;
    if (SENTIMENTS.has(row.sentiment)) c[row.sentiment]++;
    else c.unclassified++;
    if (row.sentiment === 'negative' && status(row) === 'negative_cold') c.cold++;
  }
  return c;
}

function projectedObjectSql(ref) {
  return `jsonb_strip_nulls(jsonb_build_object(${PROJECTION_KEYS.map(key => `'${key}', ${ref}->'${key}'`).join(', ')}))`;
}
function observationPayloadSql() {
  return `(${projectedObjectSql('ro.payload')} || jsonb_build_object('detailPayload', ${projectedObjectSql("(ro.payload->'detailPayload')")}, 'items', jsonb_build_array(${projectedObjectSql("(ro.payload->'items'->0)")} || jsonb_build_object('detailPayload', ${projectedObjectSql("(ro.payload->'items'->0->'detailPayload')")}))))`;
}

/** Only service-stamped, completely measured metrics can support daily change.
 * Legacy snapshots can supply an explicitly labelled stored total, never a real-time claim. */
export function assessCustomerDailyObservation(row = {}) {
  const payload = object(row.payload);
  const stamp = object(payload.customerDailyMetricEvidence);
  const values = Object.fromEntries(Object.keys(METRICS).map(key => [key, number(row[key])]));
  const ingestedAt = iso(row.captured_at);
  const result = {observationId: row.id, ingestedAt, observedAt: null, timeSource: 'ingested_at', metrics: values, heat: null, quality: 'unusable', comparable: false};
  if (!ingestedAt || Object.values(values).some(value => value === null)) return result;
  if (stamp.version === 1) {
    const fields = object(stamp.metrics);
    if (stamp.allMeasured !== true || Object.keys(METRICS).some(key => {
      const field = object(fields[key]);
      return field.measured !== true || number(field.value) !== values[key];
    })) return {...result, reason: 'partial_or_preserved_metrics'};
    const observedAt = iso(stamp.observedAt);
    const trustedTime = stamp.timeSource === 'capture_timestamp' && observedAt && ms(observedAt) <= ms(ingestedAt);
    return {...result, heat: Object.values(values).reduce((a, b) => a + b, 0),
      observedAt: trustedTime ? observedAt : ingestedAt,
      timeSource: trustedTime ? 'capture_timestamp' : 'ingested_at',
      quality: trustedTime ? 'measured' : 'measured_ingestion_time', comparable: Boolean(trustedTime)};
  }
  // The existing metric resolver distinguishes proven zero from a list placeholder.
  // Guarded old payloads can contain preserved values, hence even full legacy data
  // are explicitly unverified and must never generate a percentage change.
  const resolved = Object.fromEntries(Object.entries(METRICS).map(([key, keys]) => [key,
    resolveMetricUpdateFromPayload(payload, key === 'comments_count' ? 'comments' : key, keys, {syncType: payload.syncType}),
  ]));
  if (Object.keys(METRICS).some(key => resolved[key] === null || resolved[key] !== values[key])) return {...result, reason: 'legacy_missing_or_mismatched_metrics'};
  return {...result, heat: Object.values(values).reduce((a, b) => a + b, 0), observedAt: ingestedAt, quality: 'legacy_unverified'};
}

function compareObservations(today, yesterday) {
  if (!today?.comparable) return '暂无可比数据';
  if (!yesterday?.comparable) return '暂无昨日数据';
  if (yesterday.heat === 0) return today.heat === 0 ? '持平' : `由0增至${today.heat}`;
  const change = (today.heat - yesterday.heat) / yesterday.heat * 100;
  if (change === 0) return '持平';
  return `${change > 0 ? '↑' : '↓'}${Number(Math.abs(change).toFixed(1))}%`;
}
function post(row) {
  return {recordId: row.id, title: String(row.title || '未命名帖子'), platform: row.platform || 'unknown',
    url: safeUrl(row.url) || safeUrl(row.canonical_url), status: status(row)};
}
function currentCold(row) {
  return row && mainPost(row) && row.sentiment === 'negative' && status(row) === 'negative_cold';
}

export function parseCustomerDailyColdEvents(events = []) {
  const transitions = [];
  const malformed = [];
  for (const event of events) {
    const metadata = object(event.metadata);
    if (event.action === 'record.triage_updated') {
      if (metadata.nextStatus !== 'negative_cold') continue;
      if (!UUID.test(String(event.target_id)) || typeof metadata.previousStatus !== 'string') { malformed.push(event.id); continue; }
      if (metadata.previousStatus !== 'negative_cold') transitions.push({recordId: event.target_id, eventId: event.id, markedAt: iso(event.created_at), previousStatus: metadata.previousStatus});
    } else if (event.action === 'record.triage_batch_updated' && metadata.status === 'negative_cold') {
      if (!Array.isArray(metadata.recordIds)) { malformed.push(event.id); continue; }
      const previous = object(metadata.previous);
      for (const recordId of metadata.recordIds) {
        const previousStatus = object(previous[recordId]).status;
        if (!UUID.test(String(recordId)) || typeof previousStatus !== 'string') { malformed.push(event.id); continue; }
        if (previousStatus !== 'negative_cold') transitions.push({recordId, eventId: event.id, markedAt: iso(event.created_at), previousStatus});
      }
    }
  }
  return {transitions: transitions.filter(t => t.markedAt), malformed: [...new Set(malformed)]};
}

export function assessCustomerDailyCaptureReadiness(task) {
  const metadata = object(task.metadata);
  const workflow = metadata.promotedBusinessTaskType || metadata.businessTaskType || metadata.workflow || task.task_type || 'capture';
  if (PATROL_WORKFLOWS.has(workflow) || PATROL_WORKFLOWS.has(task.feature_key) || ['capture.comments', 'capture.enhancement', 'capture.shared_policy'].includes(task.feature_key)) return null;
  if (task.task_type === 'capture_orchestration') {
    // A keyword plan can now contain a separate patrol module. Once all keyword
    // items have settled, that patrol must not delay a report of new posts.
    if (Number(task.keyword_item_count) > 0 && Number(task.unsettled_keyword_items) === 0) return null;
    if (!Number(task.keyword_item_count) && task.feature_key !== 'keyword_orchestration') return null;
  }
  const progress = object(task.progress);
  const reasons = [];
  if (task.task_type === 'capture_orchestration' && Number(task.unsettled_keyword_items) > 0) reasons.push('keyword_items_incomplete');
  if (ACTIVE_CAPTURE.has(task.status)) reasons.push('capture_active');
  if (['failed', 'completed_with_failures'].includes(task.status)) reasons.push('capture_failed');
  const known = progress.streamingSyncEvidenceKnown === true || progress.streamingSyncEnabled === true;
  const pendingFields = ['streamingSyncPendingCount', 'streamingSyncActiveCount', 'streamingSyncRemainingCount', 'streamingSyncFailedCount'];
  if (pendingFields.some(key => number(progress[key]) > 0) || progress.streamingSyncBlocked === true ||
    (known && progress.streamingSyncDrainCompleted === false)) reasons.push('sync_incomplete');
  const enqueued = number(progress.streamingSyncEnqueuedUniqueCount);
  const succeeded = number(progress.streamingSyncSucceededUniqueCount);
  if (known && enqueued !== null && succeeded !== null && succeeded < enqueued) reasons.push('sync_count_gap');
  return reasons.length ? {id: task.id, status: task.status, taskType: task.task_type || 'capture', reasons: [...new Set(reasons)]} : null;
}

export async function collectCustomerDailyReport({tenantId, date, now = new Date(), db, auditCoverageFrom = null}) {
  if (!tenantId) throw Object.assign(new Error('缺少租户'), {statusCode: 400});
  if (!db?.queryAll || !db?.queryOne) throw new TypeError('日报聚合需要数据库事务');
  const period = dailyPeriod(date, now);
  const {periodStart, cutoffAt, monthStart, heatStart} = period;
  const tenant = await db.queryOne('/* customer_daily:tenant */ SELECT name FROM tenants WHERE id = $1', [tenantId]);
  if (!tenant) throw Object.assign(new Error('租户不存在'), {statusCode: 404});
  const monthRows = await db.queryAll(`/* customer_daily:month */
    SELECT r.id, r.created_at AS first_seen_at, r.record_type, r.sentiment, r.business_visibility,
      COALESCE(rt.status, 'unhandled') AS status
    FROM records r LEFT JOIN record_triage rt ON rt.tenant_id = r.tenant_id AND rt.record_id = r.id
    WHERE r.tenant_id = $1 AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz AND ${POST_SQL}
    ORDER BY r.created_at, r.id`, [tenantId, monthStart, cutoffAt]);
  const uniqueRows = [...new Map(monthRows.filter(row => mainPost(row) && ms(row.first_seen_at) >= ms(monthStart) && ms(row.first_seen_at) < ms(cutoffAt)).map(row => [row.id, row])).values()];
  const dayRows = uniqueRows.filter(row => ms(row.first_seen_at) >= ms(periodStart));
  const warnings = [];
  const warn = (code, message, blocking = false) => warnings.push({code, message, blocking});
  const summary = {day: count(dayRows), mtd: count(uniqueRows)};
  const conflicts = uniqueRows.filter(row => NEGATIVE_STATES.has(status(row)) && row.sentiment !== 'negative' && status(row) !== 'reviewed_non_monitor');
  if (summary.mtd.unclassified) warn('unclassified', `本月截至报表日有${summary.mtd.unclassified}条SDB内容尚未完成情感识别（日新增${summary.day.unclassified}条），未自动归为中性。`, true);
  if (conflicts.length) warn('sentiment_status_conflict', `本月内容中${conflicts.length}条情感结论与负面处理状态不一致，按有效情感统计，需核对。`, true);
  const hiddenRows = uniqueRows.filter(row => row.business_visibility && row.business_visibility !== 'eligible');
  if (hiddenRows.length) warn('audit_visible_posts_included', `${hiddenRows.length}条已入库主帖暂未进入普通业务列表，仍计入监控数量；SDB只扣除已复核-非监控内容。`);

  const heatRows = await db.queryAll(`/* customer_daily:heat_posts */
    SELECT r.id, r.title, r.platform, r.url, r.canonical_url, r.record_type, r.sentiment,
      r.published_ts, r.created_at AS first_seen_at, COALESCE(rt.status, 'unhandled') AS status
    FROM records r LEFT JOIN record_triage rt ON rt.tenant_id = r.tenant_id AND rt.record_id = r.id
    WHERE r.tenant_id = $1 AND r.published_ts >= $2::timestamptz AND r.published_ts < $3::timestamptz
      AND r.created_at < $3::timestamptz AND r.sentiment = 'negative' AND ${POST_SQL}
      AND COALESCE(rt.status, 'unhandled') <> 'reviewed_non_monitor'
    ORDER BY r.published_ts DESC, r.id`, [tenantId, heatStart, cutoffAt]);
  const heatCandidates = heatRows.filter(row => mainPost(row) && row.sentiment === 'negative' && status(row) !== 'reviewed_non_monitor' && ms(row.first_seen_at) < ms(cutoffAt) && ms(row.published_ts) >= ms(heatStart) && ms(row.published_ts) < ms(cutoffAt));
  const observations = heatCandidates.length ? await db.queryAll(`/* customer_daily:observations */
    SELECT ro.id, ro.record_id, ro.captured_at, ro.likes, ro.comments_count, ro.collects, ro.shares,
      ${observationPayloadSql()} AS payload
    FROM record_observations ro
    WHERE ro.tenant_id = $1 AND ro.captured_at >= $2::timestamptz AND ro.captured_at < $3::timestamptz
      AND ro.record_id = ANY($4::uuid[]) ORDER BY ro.captured_at DESC, ro.id DESC`, [tenantId, heatStart, cutoffAt, heatCandidates.map(row => row.id)]) : [];
  const byRecord = new Map();
  for (const row of observations) {
    if (ms(row.captured_at) < ms(heatStart) || ms(row.captured_at) >= ms(cutoffAt)) continue;
    const observation = assessCustomerDailyObservation(row);
    if (observation.heat === null || ms(observation.observedAt) >= ms(cutoffAt)) continue;
    if (!byRecord.has(row.record_id)) byRecord.set(row.record_id, []);
    byRecord.get(row.record_id).push(observation);
  }
  const highHeat = [];
  const heatEvidence = [];
  const missingHeat = [];
  for (const row of heatCandidates) {
    const candidates = (byRecord.get(row.id) || []).sort((a, b) => ms(b.observedAt) - ms(a.observedAt) || String(b.observationId).localeCompare(String(a.observationId)));
    if (!candidates.length) { missingHeat.push(row.id); continue; }
    const latest = candidates[0];
    const current = candidates.find(o => o.comparable && ms(o.observedAt) >= ms(periodStart));
    const yesterday = candidates.find(o => o.comparable && ms(o.observedAt) >= ms(periodStart) - DAY && ms(o.observedAt) < ms(periodStart));
    const sameMeasuredCurrent = latest.comparable && current?.observationId === latest.observationId;
    const stale = ms(latest.observedAt) < ms(periodStart);
    heatEvidence.push({recordId: row.id, selected: latest, yesterday: sameMeasuredCurrent ? yesterday || null : null});
    if (latest.heat < 200) continue;
    highHeat.push({...post(row), heat: latest.heat, observedAt: latest.observedAt, ingestedAt: latest.ingestedAt,
      quality: latest.quality, timeSource: latest.timeSource, stale,
      comparisonText: stale ? '暂无本日数据' : sameMeasuredCurrent ? compareObservations(latest, yesterday) : '暂无可比数据',
      previousHeat: !stale && sameMeasuredCurrent && yesterday ? yesterday.heat : null,
      previousObservedAt: !stale && sameMeasuredCurrent && yesterday ? yesterday.observedAt : null,
      publishedAt: iso(row.published_ts), observationId: latest.observationId});
  }
  highHeat.sort((a, b) => b.heat - a.heat || ms(b.publishedAt) - ms(a.publishedAt) || String(a.recordId).localeCompare(String(b.recordId)));
  if (missingHeat.length) warn('heat_missing', `${missingHeat.length}篇近7天发布的负面帖子缺少完整可核实互动观测，未按0处理，暂未进入榜单。`);
  const legacyHeat = highHeat.filter(row => row.quality !== 'measured');
  if (legacyHeat.length) warn('heat_time_unverified', `上榜${legacyHeat.length}篇使用历史入库记录或仅可确认入库时间，实测时间未核实，不计算较昨日。`);
  const staleCount = highHeat.filter(row => row.stale).length;
  if (staleCount) warn('heat_stale', `上榜${staleCount}篇本日无新有效互动观测，保留最近热度并注明更新时间。`);
  const missingPublished = await db.queryOne(`/* customer_daily:missing_published */
    SELECT COUNT(*)::int AS count FROM records r
    LEFT JOIN record_triage rt ON rt.tenant_id = r.tenant_id AND rt.record_id = r.id
    WHERE r.tenant_id = $1 AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz
      AND r.published_ts IS NULL AND r.sentiment = 'negative' AND ${POST_SQL}
      AND COALESCE(rt.status, 'unhandled') <> 'reviewed_non_monitor'`, [tenantId, heatStart, cutoffAt]);
  if (Number(missingPublished?.count) > 0) warn('published_time_missing', `近7天入库的负面帖子中${Number(missingPublished.count)}篇缺少发布时间，无法确认是否落在热度窗口。`);

  const auditRows = await db.queryAll(`/* customer_daily:cold_events */
    SELECT id, action, target_id, created_at,
      jsonb_build_object('previousStatus', metadata->'previousStatus', 'nextStatus', metadata->'nextStatus',
        'status', metadata->'status', 'recordIds', metadata->'recordIds', 'previous', metadata->'previous') AS metadata
    FROM audit_logs
    WHERE tenant_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
      AND action IN ('record.triage_updated', 'record.triage_batch_updated')
      AND (metadata->>'nextStatus' = 'negative_cold' OR metadata->>'status' = 'negative_cold')
    ORDER BY created_at, id`, [tenantId, periodStart, cutoffAt]);
  const {transitions, malformed} = parseCustomerDailyColdEvents(auditRows.filter(row => ms(row.created_at) >= ms(periodStart) && ms(row.created_at) < ms(cutoffAt)));
  const ids = [...new Set(transitions.map(t => t.recordId))];
  const coldRows = ids.length ? await db.queryAll(`/* customer_daily:cold_posts */
    SELECT r.id, r.title, r.platform, r.url, r.canonical_url, r.record_type, r.sentiment,
      COALESCE(rt.status, 'unhandled') AS status
    FROM records r LEFT JOIN record_triage rt ON rt.tenant_id = r.tenant_id AND rt.record_id = r.id
    WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])`, [tenantId, ids]) : [];
  const coldById = new Map(coldRows.map(row => [row.id, row]));
  const latestTransition = new Map();
  for (const t of transitions) {
    const old = latestTransition.get(t.recordId);
    if (!old || ms(t.markedAt) >= ms(old.markedAt)) latestTransition.set(t.recordId, t);
  }
  const coldMarked = [...latestTransition.values()].filter(t => currentCold(coldById.get(t.recordId)))
    .sort((a, b) => ms(a.markedAt) - ms(b.markedAt) || String(a.recordId).localeCompare(String(b.recordId)))
    .map(t => ({...post(coldById.get(t.recordId)), markedAt: t.markedAt, eventId: t.eventId}));
  const withdrawn = [...latestTransition.values()].filter(t => !currentCold(coldById.get(t.recordId))).map(t => t.recordId);
  if (withdrawn.length) warn('cold_withdrawn_or_corrected', `${withdrawn.length}篇当日曾标冷处理的帖子已撤销、更正或不再属于有效负面范围，本版主清单不再列出。`);
  const coverage = auditCoverageFrom || (await db.queryOne(`/* customer_daily:audit_coverage */
    SELECT applied_at FROM schema_migrations WHERE version = $1`, ['081_customer_daily_reports.sql']))?.applied_at;
  const coverageComplete = Boolean(iso(coverage) && ms(coverage) <= ms(periodStart) && malformed.length === 0);
  if (!coverageComplete) warn('cold_history_incomplete', `${coldMarked.length ? '历史标记记录不完整，以下为可核实内容。' : '暂未检出，历史标记记录不完整。'}${malformed.length ? `有${malformed.length}条旧审计事件缺少变更前状态。` : ''}`);
  const missingLinks = [...highHeat, ...coldMarked].filter(row => !row.url);
  if (missingLinks.length) warn('source_link_missing', `${new Set(missingLinks.map(row => row.recordId)).size}篇清单帖子缺少可用原帖链接，需补齐。`, true);
  const captureRows = await db.queryAll(`/* customer_daily:pending_capture */
    SELECT t.id, t.status, t.task_type, t.feature_key,
      jsonb_build_object('workflow', t.metadata->'workflow', 'businessTaskType', t.metadata->'businessTaskType',
        'promotedBusinessTaskType', t.metadata->'promotedBusinessTaskType') AS metadata,
      jsonb_build_object('streamingSyncEvidenceKnown', t.progress->'streamingSyncEvidenceKnown',
        'streamingSyncEnabled', t.progress->'streamingSyncEnabled', 'streamingSyncDrainCompleted', t.progress->'streamingSyncDrainCompleted',
        'streamingSyncPendingCount', t.progress->'streamingSyncPendingCount', 'streamingSyncActiveCount', t.progress->'streamingSyncActiveCount',
        'streamingSyncRemainingCount', t.progress->'streamingSyncRemainingCount', 'streamingSyncFailedCount', t.progress->'streamingSyncFailedCount',
        'streamingSyncBlocked', t.progress->'streamingSyncBlocked', 'streamingSyncEnqueuedUniqueCount', t.progress->'streamingSyncEnqueuedUniqueCount',
        'streamingSyncSucceededUniqueCount', t.progress->'streamingSyncSucceededUniqueCount') AS progress,
      keyword_items.keyword_item_count, keyword_items.unsettled_keyword_items
    FROM capture_tasks t
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS keyword_item_count,
        COUNT(*) FILTER (WHERE i.status NOT IN ('completed', 'completed_with_warnings', 'skipped', 'canceled'))::int AS unsettled_keyword_items
      FROM capture_task_items i WHERE t.task_type = 'capture_orchestration'
        AND i.tenant_id = t.tenant_id AND i.task_id = t.id AND i.item_type = 'keyword'
    ) keyword_items ON true
    WHERE t.tenant_id = $1 AND t.created_at >= $2::timestamptz AND t.created_at < $3::timestamptz
      AND t.task_type IN ('capture', 'keyword_capture', 'unattended_keyword_capture', 'capture_orchestration')`, [tenantId, periodStart, cutoffAt]);
  const activeCaptures = captureRows.map(assessCustomerDailyCaptureReadiness).filter(Boolean);
  if (activeCaptures.length) warn('capture_not_settled', `报表日创建的${activeCaptures.length}个普通采集任务存在未完成、失败或同步缺口，监控数量仅包含已成功入库主帖。`, true);
  return {
    schemaVersion: 1, tenantId, tenantName: tenant.name || '', ...period, summary, highHeat, coldMarked, warnings,
    evidence: {
      scope: '当前租户首次成功入库的普通主帖；不计官方内容、博主资料、评论和复采次数；SDB只扣除已复核-非监控内容',
      firstSeenField: 'records.created_at', timeZone: 'Asia/Shanghai', reviewBasis: '本版生成时有效情感及人工处理状态',
      monthRecords: uniqueRows.map(row => ({recordId: row.id, firstSeenAt: iso(row.first_seen_at), sentiment: row.sentiment || '', status: status(row), businessVisibility: row.business_visibility || 'eligible'})),
      dayRecordIds: dayRows.map(row => row.id), conflictRecordIds: conflicts.map(row => row.id),
      heat: {candidateCount: heatCandidates.length, selected: heatEvidence, missingRecordIds: missingHeat, missingPublishedCount: Number(missingPublished?.count) || 0,
        updatedCount: highHeat.filter(row => !row.stale && row.quality === 'measured').length, staleCount, unverifiedCount: legacyHeat.length},
      cold: {coverageFrom: iso(coverage), coverageComplete, transitions, malformedEventIds: malformed, withdrawnRecordIds: withdrawn},
      pendingCaptureTasks: activeCaptures,
    },
  };
}
