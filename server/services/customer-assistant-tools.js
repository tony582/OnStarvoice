import {queryOne,queryAll,execute,withTransaction} from '../db/init.js';
import {customerDailyReports} from './customer-daily-reports.js';
import {createCustomerAssistantEmailService} from './customer-assistant-email.js';

const defaultDb = {queryOne,queryAll,execute,withTransaction};
const DAY = 86400000;
const PLATFORMS = new Set(['all','douyin','xiaohongshu','weibo','bilibili','zhihu']);
const fail = (code,message,status = 400) => Object.assign(new Error(message),{code,status,safeMessage:message});
const localDate = date => new Date(new Date(date).getTime()+8*3600000).toISOString().slice(0,10);
const iso = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const clean = (value,length = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,length) : '';
const num = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const safeUrl = value => { try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch {return null;} };
const documentUrl = value => { const url = safeUrl(value); return url && /^https:\/\/[a-z0-9-]+\.(?:feishu\.cn|larksuite\.com)\/docx\/[a-zA-Z0-9_-]+$/.test(url) ? url : null; };

function argsOnly(args,keys) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))) throw fail('assistant_arguments_invalid','请求参数不受支持。');
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00+08:00`)) || localDate(`${value}T00:00:00+08:00`) !== value) {
    throw fail('assistant_date_invalid','日期应为有效的 YYYY-MM-DD。');
  }
  return value;
}
function counts(row) {
  const result = {};
  for (const key of ['monitor','sdb','positive','neutral','negative','cold','comment','negativeProcess','negativeOther','inProgress','processed','unclassified']) {
    if (row?.[key] !== undefined) result[key] = row[key] === null ? null : num(row[key]);
  }
  return result;
}

export function createCustomerAssistantTools({db = defaultDb,dailyReports = customerDailyReports,email,now = () => new Date()} = {}) {
  const emailService = email || createCustomerAssistantEmailService({db,now});
  async function getDailyReport(args,context) {
    argsOnly(args,['date']);
    if (args.date !== undefined) validDate(args.date);
    const calendar = await dailyReports.calendar(context.tenantId,args.date);
    const date = args.date || calendar.defaultReportDate;
    validDate(date);
    const reports = (await dailyReports.list(context.tenantId,date)).filter(row => row.reportDate === date).sort((a,b) => num(b.version)-num(a.version));
    if (!reports.length) return {status:'not_generated',reportDate:date,isWorkingDay:calendar.isWorkingDay,nextWorkingDate:calendar.nextWorkingDate || null,message:`${date}的日报尚未生成。`,generated:false};
    // Preserve the identity of the delivered customer document when a newer draft exists.
    const selected = reports.find(row => row.delivery?.status === 'sent' && documentUrl(row.delivery?.documentUrl))
      || reports.find(row => row.delivery?.status === 'document_ready' && documentUrl(row.delivery?.documentUrl)) || reports[0];
    const report = await dailyReports.report(context.tenantId,selected.id);
    if (!report || report.reportDate !== date || (report.snapshot?.tenantId && report.snapshot.tenantId !== context.tenantId)) throw fail('assistant_report_not_found','当前客户下没有这份日报。',404);
    const snapshot = report.snapshot || {};
    const url = ['sent','document_ready'].includes(report.delivery?.status) ? documentUrl(report.delivery?.documentUrl) : null;
    return {status:'available',reportId:report.id,reportDate:report.reportDate,version:num(report.version),latestVersion:num(reports[0].version),
      newerSnapshotAvailable:num(reports[0].version)>num(report.version),source:url ? 'feishu_document' : 'saved_snapshot',documentUrl:url,
      generatedAt:iso(report.generatedAt),summary:{day:counts(snapshot.summary?.day),mtd:counts(snapshot.summary?.mtd)},
      scope:{timeZone:'Asia/Shanghai',basis:clean(snapshot.reportBasis || 'saved_snapshot',80),collectionStartAt:iso(snapshot.collectionStartAt || snapshot.periodStart),
        collectionEndAt:iso(snapshot.collectionEndAt || snapshot.cutoffAt),cutoffAt:iso(snapshot.collectionCutoffAt || snapshot.cutoffAt),assessedAt:iso(snapshot.assessedAt),
        reviewBasis:'系统保存版本中的有效情感及处理状态'},
      incomplete:!!snapshot.warnings?.some(item => item.blocking),
      snapshotNotice:'汇总来自系统保存版本；飞书文档中后续的客户修改以文档为准。'};
  }

  async function queryNegative(args,context) {
    argsOnly(args,['dateFrom','dateTo','platform','limit']);
    const timestamp = new Date(now());
    const today = localDate(timestamp);
    const dateFrom = validDate(args.dateFrom ?? args.dateTo ?? today),dateTo = validDate(args.dateTo ?? args.dateFrom ?? today);
    const start = Date.parse(`${dateFrom}T00:00:00+08:00`),end = Date.parse(`${dateTo}T00:00:00+08:00`)+DAY;
    if (end <= start || (end-start)/DAY > 31 || dateTo > today) throw fail('assistant_range_invalid','仅支持截至今天、连续最多 31 个自然日的统计。');
    const platform = args.platform ?? 'all',limit = args.limit ?? 5;
    if (!PLATFORMS.has(platform)) throw fail('assistant_platform_invalid','不支持这个平台筛选。');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw fail('assistant_limit_invalid','明细数量应为 1 至 20。');
    const cutoff = new Date(Math.min(end,timestamp.getTime())).toISOString();
    // Apply reporting limits to the transaction; queryOne's third argument is a client, not options.
    // One statement gives counts and examples the same database snapshot. EXISTS avoids watchlist duplicates.
    const row = await db.withTransaction(tx => tx.queryOne(`WITH scoped AS MATERIALIZED (
      SELECT r.id,r.platform,r.title,r.url,r.canonical_url,r.created_at,r.sentiment
      FROM records r LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id
      WHERE r.tenant_id=$1 AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz
        AND ($4::text='all' OR r.platform=$4)
        AND r.record_type NOT IN ('official_content','blogger_profile','comment','comments','record_comment','comment_detail')
        AND r.business_visibility='eligible' AND COALESCE(rt.status,'unhandled')<>'reviewed_non_monitor'
        AND (r.ai_result->>'relevance' IS DISTINCT FROM 'irrelevant' OR EXISTS (
          SELECT 1 FROM record_watchlist w WHERE w.tenant_id=r.tenant_id AND w.record_id=r.id))
    ), platform_counts AS (
      SELECT platform,COUNT(*) FILTER (WHERE sentiment='negative') AS negative,
        COUNT(*) FILTER (WHERE sentiment IS NULL OR sentiment NOT IN ('positive','neutral','negative')) AS pending_analysis
      FROM scoped GROUP BY platform
    ), recent AS (
      SELECT id,platform,title,url,canonical_url,created_at FROM scoped
      WHERE sentiment='negative' ORDER BY created_at DESC,id DESC LIMIT $5
    ) SELECT COUNT(*) FILTER (WHERE sentiment='negative') AS total,COUNT(*) AS monitored,
      COUNT(*) FILTER (WHERE sentiment IS NULL OR sentiment NOT IN ('positive','neutral','negative')) AS pending_analysis,
      COALESCE((SELECT jsonb_agg(platform_counts ORDER BY platform) FROM platform_counts),'[]'::jsonb) AS by_platform,
      COALESCE((SELECT jsonb_agg(recent ORDER BY created_at DESC,id DESC) FROM recent),'[]'::jsonb) AS details
      FROM scoped`,[context.tenantId,new Date(start).toISOString(),cutoff,platform,limit]),
      {category:'reporting',readOnly:true,statementTimeoutMs:15000,lockTimeoutMs:1000,jitOff:true});
    return {status:'available',total:num(row?.total),monitored:num(row?.monitored),pendingAnalysis:num(row?.pending_analysis),
      dateFrom,dateTo,platform,cutoffAt:cutoff,assessedAt:timestamp.toISOString(),timeZone:'Asia/Shanghai',
      basis:'首次入库自然日内的有效监控主帖，按当前有效情感统计；排除非监控内容，同帖复采不重复计数。',
      byPlatform:(Array.isArray(row?.by_platform) ? row.by_platform : []).map(item => ({platform:clean(item.platform,40),negative:num(item.negative),pendingAnalysis:num(item.pending_analysis)})),
      details:(Array.isArray(row?.details) ? row.details : []).slice(0,limit).map(item => ({id:clean(item.id,80),title:clean(item.title),platform:clean(item.platform,40),url:safeUrl(item.url)||safeUrl(item.canonical_url),firstSeenAt:iso(item.created_at)}))};
  }

  async function executeTool(name,args = {},context) {
    if (typeof context?.tenantId !== 'string' || !context.tenantId.trim()) throw fail('assistant_context_invalid','机器人未绑定客户。',403);
    let result;
    if (name === 'get_daily_report') result = await getDailyReport(args,context);
    else if (name === 'query_negative') result = await queryNegative(args,context);
    else if (name === 'email_daily_report') {
      argsOnly(args,['reportId']);
      result = await emailService.enqueue(context,args.reportId);
    } else throw fail('assistant_tool_unsupported','暂不支持这个操作。');
    return {ok:true,tool:name,...result};
  }
  return {executeTool};
}
