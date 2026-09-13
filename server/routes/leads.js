import { Router } from 'express';
import { queryAll, queryOne } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { mutateCommentLead, getCommentLeadActivities, buildCommentLeadSuggestion, validateCommentLeadMutation } from '../services/comment-lead-followup.js';
import { rejudgeSalesLeadBatch } from '../services/comment-lead-rejudge.js';
import { formatPublishDate } from '../services/publish-date.js';
import { sendXlsx, fmtTs } from '../services/xlsx-export.js';

const router = Router();

const LEAD_DETAIL_COLUMNS = `comment_leads.*,
  (SELECT content FROM records source WHERE source.id = comment_leads.record_id AND source.tenant_id = comment_leads.tenant_id) AS record_content,
  (SELECT ai_summary FROM records source WHERE source.id = comment_leads.record_id AND source.tenant_id = comment_leads.tenant_id) AS record_ai_summary,
  (SELECT sentiment FROM records source WHERE source.id = comment_leads.record_id AND source.tenant_id = comment_leads.tenant_id) AS record_sentiment,
  (SELECT url FROM records source WHERE source.id = comment_leads.record_id AND source.tenant_id = comment_leads.tenant_id) AS record_current_url,
  (SELECT canonical_url FROM records source WHERE source.id = comment_leads.record_id AND source.tenant_id = comment_leads.tenant_id) AS record_canonical_url,
  (SELECT external_id FROM records source WHERE source.id = comment_leads.record_id AND source.tenant_id = comment_leads.tenant_id) AS record_external_id,
  (SELECT title FROM records source WHERE source.id = comment_leads.record_id AND source.tenant_id = comment_leads.tenant_id) AS record_current_title,
  (SELECT published_at FROM record_comments source WHERE source.id = comment_leads.comment_id AND source.tenant_id = comment_leads.tenant_id) AS comment_published_at,
  (SELECT source_type FROM record_comments source WHERE source.id = comment_leads.comment_id AND source.tenant_id = comment_leads.tenant_id) AS comment_source_type,
  (SELECT first_seen_at FROM record_comments source WHERE source.id = comment_leads.comment_id AND source.tenant_id = comment_leads.tenant_id) AS comment_first_seen_at,
  (SELECT last_seen_at FROM record_comments source WHERE source.id = comment_leads.comment_id AND source.tenant_id = comment_leads.tenant_id) AS comment_last_seen_at,
  (SELECT seen_count FROM record_comments source WHERE source.id = comment_leads.comment_id AND source.tenant_id = comment_leads.tenant_id) AS comment_seen_count,
  (SELECT COUNT(*)::int FROM comment_lead_activities a WHERE a.lead_id = comment_leads.id AND a.tenant_id = comment_leads.tenant_id) AS progress_count,
  (SELECT note FROM comment_lead_activities a WHERE a.lead_id = comment_leads.id AND a.tenant_id = comment_leads.tenant_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS progress_latest_body,
  (SELECT created_at FROM comment_lead_activities a WHERE a.lead_id = comment_leads.id AND a.tenant_id = comment_leads.tenant_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS progress_latest_at,
  (SELECT actor_name FROM comment_lead_activities a WHERE a.lead_id = comment_leads.id AND a.tenant_id = comment_leads.tenant_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS progress_latest_author,
  (SELECT t.id FROM tickets t WHERE t.source_type = 'comment' AND t.source_comment_id = comment_leads.id AND t.tenant_id = comment_leads.tenant_id ORDER BY (t.status <> 'closed') DESC, t.created_at DESC, t.id DESC LIMIT 1) AS ticket_id,
  (SELECT t.status FROM tickets t WHERE t.source_type = 'comment' AND t.source_comment_id = comment_leads.id AND t.tenant_id = comment_leads.tenant_id ORDER BY (t.status <> 'closed') DESC, t.created_at DESC, t.id DESC LIMIT 1) AS ticket_status`;

// 导出用中文标签映射(MAP[v]||v||'')
const PLATFORM_CN = { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博' };
const PRIORITY_CN = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const LEAD_STATUS_CN = { new: '新线索', following: '跟进中', ticketed: '已转工单', resolved: '已处理', ignored: '已忽略' };
const LEAD_TYPE_CN = { complaint: '投诉维权', renewal_billing: '续费收费', app_issue: 'App故障', service_quality: '服务求助', safety_privacy: '安全隐私', brand_risk: '品牌风险', sales_intent: '购买意向', other: '其他' };

// A bounded, cursor-based pass; model calls never hold database locks.
router.post('/comments/rejudge-sales', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const result = await rejudgeSalesLeadBatch({ tenantId: req.tenantId, limit: req.body?.limit, cursor: req.body?.cursor, actor: req.user });
    return res.json({ ok: true, ...result });
  } catch (err) { return leadError(res, next, err); }
});

function leadError(res, next, err) {
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ ok: false, error: err.code || 'invalid_request', message: err.message });
  return next(err);
}

const LEAD_STATUSES = new Set(['new', 'following', 'ticketed', 'resolved', 'ignored']);
const LEAD_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const LEAD_TYPES = new Set([
  'sales_intent',
  'complaint', 'renewal_billing', 'app_issue', 'service_quality',
  'safety_privacy', 'brand_risk', 'other',
]);

// 评论分诊列表排序:发布时间 / 首次发现 / 最近采集 可点表头升降序;默认走优先级+时间。
function leadsOrderSql(sort, dir) {
  const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const tail = `CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, captured_at DESC, updated_at DESC`;
  if (sort === 'publish') return `comment_published_ts ${d} NULLS LAST, ${tail}`;
  if (sort === 'first_seen') return `comment_first_seen_at ${d} NULLS LAST, ${tail}`;
  if (sort === 'last_seen') return `comment_last_seen_at ${d} NULLS LAST, ${tail}`;
  return tail;
}

// 评论日期区间过滤(可切维度)。FROM comment_leads:
//   发布时间(publish,默认)→ comment_leads.comment_published_ts(直列)
//   最近采集(recent)/ 首次采集(first)→ record_comments.last_seen_at / first_seen_at(EXISTS 子查询)
// 列名取自白名单,无注入。
function appendCommentDateRangeFilter(where, params, query) {
  const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(query.dateFrom || '')) ? query.dateFrom : '';
  const dTo = /^\d{4}-\d{2}-\d{2}$/.test(String(query.dateTo || '')) ? query.dateTo : '';
  if (!dFrom && !dTo) return where;
  const basis = String(query.dateBasis || 'publish');
  if (basis === 'publish') {
    if (dFrom) { params.push(dFrom); where += ` AND comment_published_ts >= $${params.length}::date`; }
    if (dTo) { params.push(dTo); where += ` AND comment_published_ts < ($${params.length}::date + INTERVAL '1 day')`; }
    return where;
  }
  const col = basis === 'recent' ? 'rc.last_seen_at' : 'rc.first_seen_at';
  const conds = [];
  if (dFrom) { params.push(dFrom); conds.push(`${col} >= $${params.length}::date`); }
  if (dTo) { params.push(dTo); conds.push(`${col} < ($${params.length}::date + INTERVAL '1 day')`); }
  where += ` AND EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.tenant_id = comment_leads.tenant_id AND ${conds.join(' AND ')})`;
  return where;
}

router.get('/comments', requireTenantAccess, async (req, res, next) => {
  try {
    const {
      status = '',
      platform = '',
      leadType = '',
      priority = '',
      keyword = '',
      page = 1,
      pageSize = 30,
    } = req.query;

    const params = [req.tenantId];
    let where = 'WHERE tenant_id = $1';
    // 工作中保留新线索、跟进中及已转工单，状态筛选在桶内叠加。
    const bucket = String(req.query.bucket || '');
    if (bucket === 'pending' || bucket === 'active') {
      where += ` AND status IN ('new', 'following', 'ticketed')`;
    } else if (bucket === 'archived') {
      where += ` AND status IN ('resolved', 'ignored')`;
    }
    if (status && LEAD_STATUSES.has(String(status))) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    if (platform) {
      params.push(platform);
      where += ` AND platform = $${params.length}`;
    }
    const leadTypes = (Array.isArray(req.query.leadType) ? req.query.leadType : String(req.query.leadType || '').split(','))
      .map((s) => String(s).trim()).filter((s) => LEAD_TYPES.has(s));
    if (leadTypes.length) {
      params.push(leadTypes);
      where += ` AND lead_type = ANY($${params.length}::text[])`;
    }
    // 大类:sales=销售客资(购买意向),opinion=舆情评论(其余风险类)
    const category = String(req.query.category || '');
    if (category === 'sales') {
      where += ` AND lead_type = 'sales_intent'`;
    } else if (category === 'opinion') {
      where += ` AND lead_type <> 'sales_intent'`;
    }
    if (priority && LEAD_PRIORITIES.has(String(priority))) {
      params.push(priority);
      where += ` AND priority = $${params.length}`;
    }
    if (keyword) {
      const kw = `%${String(keyword).trim()}%`;
      params.push(kw, kw, kw, kw);
      where += ` AND (
        record_title ILIKE $${params.length - 3}
        OR comment_content ILIKE $${params.length - 2}
        OR comment_author_name ILIKE $${params.length - 1}
        OR comment_ip_location ILIKE $${params.length}
      )`;
    }
    // 采集关键词多选(每个关键词=一次采集 session):matched_keywords 命中任一即可
    const captureKeywords = (Array.isArray(req.query.captureKeyword) ? req.query.captureKeyword : String(req.query.captureKeyword || '').split(','))
      .map(s => String(s).trim()).filter(Boolean);
    if (captureKeywords.length) {
      params.push(captureKeywords);
      where += ` AND matched_keywords ?| $${params.length}::text[]`;
    }
    // 疑似KOE(作者名命中品牌/车型词 → record_comments.source_type):only=只看,hide=隐藏
    const koe = String(req.query.koe || '');
    if (koe === 'only') {
      where += ` AND EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.tenant_id = comment_leads.tenant_id AND rc.source_type IN ('dealer','employee'))`;
    } else if (koe === 'hide') {
      where += ` AND NOT EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.tenant_id = comment_leads.tenant_id AND rc.source_type IN ('dealer','employee'))`;
    }
    // 评论分诊只看「相关帖」的评论:父帖被判 irrelevant 的评论不算 lead
    // (否则竞品/跑题帖——如安吉星里命中关键词实为零跑、吉事桔香茶里误采的凯迪拉克——其评论会冒进客资)
    where += ` AND NOT EXISTS (SELECT 1 FROM records r WHERE r.id = comment_leads.record_id AND r.tenant_id = comment_leads.tenant_id AND (r.ai_result->>'relevance' = 'irrelevant' OR r.business_visibility <> 'eligible'))`;
    where = appendCommentDateRangeFilter(where, params, req.query);

    const total = (await queryOne(
      `SELECT COUNT(*) AS total FROM comment_leads ${where}`,
      params,
    ))?.total || 0;

    const limit = Math.min(100, Math.max(1, Number(pageSize) || 30));
    const offset = (Math.max(1, Number(page)) - 1) * limit;
    params.push(limit, offset);

    const leads = await queryAll(`
      SELECT ${LEAD_DETAIL_COLUMNS}
      FROM comment_leads
      ${where}
      ORDER BY ${leadsOrderSql(req.query.sort, req.query.dir)}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    leads.forEach(l => { l.publish_display = formatPublishDate(l.comment_published_at, l.captured_at); });

    return res.json({
      ok: true,
      leads,
      pagination: {
        page: Number(page),
        pageSize: limit,
        total: Number(total || 0),
        totalPages: Math.ceil(Number(total || 0) / limit),
      },
    });
  } catch (err) {
    return next(err);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Literal batch/export routes precede the parameterized detail route.
router.patch('/comments/batch', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const rawIds = req.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100) {
      return res.status(400).json({ ok: false, error: 'invalid_ids', message: 'ids 需为 1-100 个线索ID' });
    }
    const ids = [...new Set(rawIds.map(id => String(id || '').trim().toLowerCase()))];
    const { status, priority, note } = req.body;
    if (status !== undefined && (!LEAD_STATUSES.has(status) || status === 'ticketed')) {
      return res.status(400).json({ ok: false, error: 'invalid_status', message: '线索状态无效，转工单请使用专用入口' });
    }
    if (priority !== undefined && !LEAD_PRIORITIES.has(priority)) {
      return res.status(400).json({ ok: false, error: 'invalid_priority', message: '线索优先级无效' });
    }
    // Validate the shared note before the first row is changed: an invalid note
    // must never produce a partially applied batch or silently lose its text.
    validateCommentLeadMutation({ status, priority, note });
    const skipped = [];
    let updated = 0;
    for (const id of ids) {
      if (!UUID_RE.test(id)) { skipped.push(id); continue; }
      try {
        await mutateCommentLead({ tenantId: req.tenantId, id, status, priority, note, actor: req.user });
        updated += 1;
      } catch (err) {
        if (err.status === 404 || err.status === 409) skipped.push(id);
        else throw err;
      }
    }
    return res.json({ ok: true, updated, skipped });
  } catch (err) { return leadError(res, next, err); }
});

router.patch('/comments/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id', message: '线索ID无效' });
    const { status, priority, note, leadType, correctionReason } = req.body || {};
    const lead = await mutateCommentLead({ tenantId: req.tenantId, id: req.params.id, status, priority, note, leadType, correctionReason, actor: req.user });
    return res.json({ ok: true, lead });
  } catch (err) { return leadError(res, next, err); }
});

router.post('/comments/:id/notes', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id', message: '线索ID无效' });
    const body = req.body?.body;
    if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ ok: false, error: 'empty_note', message: '请填写跟进记录' });
    const lead = await mutateCommentLead({ tenantId: req.tenantId, id: req.params.id, note: body, actor: req.user });
    const activity = await getCommentLeadActivities({ tenantId: req.tenantId, id: req.params.id });
    return res.json({ ok: true, lead, note: activity[0], activity });
  } catch (err) { return leadError(res, next, err); }
});

// 导出当前筛选结果为 Excel(与 /comments 列表用同一套 where/params,但不分页)
router.get('/comments/export', requireTenantAccess, async (req, res, next) => {
  try {
    const {
      status = '',
      platform = '',
      leadType = '',
      priority = '',
      keyword = '',
    } = req.query;

    const params = [req.tenantId];
    let where = 'WHERE tenant_id = $1';
    const bucket = String(req.query.bucket || '');
    if (bucket === 'pending' || bucket === 'active') {
      where += ` AND status IN ('new', 'following', 'ticketed')`;
    } else if (bucket === 'archived') {
      where += ` AND status IN ('resolved', 'ignored')`;
    }
    if (status && LEAD_STATUSES.has(String(status))) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    if (platform) {
      params.push(platform);
      where += ` AND platform = $${params.length}`;
    }
    const leadTypes = (Array.isArray(req.query.leadType) ? req.query.leadType : String(req.query.leadType || '').split(','))
      .map((s) => String(s).trim()).filter((s) => LEAD_TYPES.has(s));
    if (leadTypes.length) {
      params.push(leadTypes);
      where += ` AND lead_type = ANY($${params.length}::text[])`;
    }
    const category = String(req.query.category || '');
    if (category === 'sales') {
      where += ` AND lead_type = 'sales_intent'`;
    } else if (category === 'opinion') {
      where += ` AND lead_type <> 'sales_intent'`;
    }
    if (priority && LEAD_PRIORITIES.has(String(priority))) {
      params.push(priority);
      where += ` AND priority = $${params.length}`;
    }
    if (keyword) {
      const kw = `%${String(keyword).trim()}%`;
      params.push(kw, kw, kw, kw);
      where += ` AND (
        record_title ILIKE $${params.length - 3}
        OR comment_content ILIKE $${params.length - 2}
        OR comment_author_name ILIKE $${params.length - 1}
        OR comment_ip_location ILIKE $${params.length}
      )`;
    }
    const captureKeywords = (Array.isArray(req.query.captureKeyword) ? req.query.captureKeyword : String(req.query.captureKeyword || '').split(','))
      .map(s => String(s).trim()).filter(Boolean);
    if (captureKeywords.length) {
      params.push(captureKeywords);
      where += ` AND matched_keywords ?| $${params.length}::text[]`;
    }
    const koe = String(req.query.koe || '');
    if (koe === 'only') {
      where += ` AND EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.tenant_id = comment_leads.tenant_id AND rc.source_type IN ('dealer','employee'))`;
    } else if (koe === 'hide') {
      where += ` AND NOT EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.tenant_id = comment_leads.tenant_id AND rc.source_type IN ('dealer','employee'))`;
    }
    // 与列表一致:父帖被判 irrelevant 的评论不导出
    where += ` AND NOT EXISTS (SELECT 1 FROM records r WHERE r.id = comment_leads.record_id AND r.tenant_id = comment_leads.tenant_id AND (r.ai_result->>'relevance' = 'irrelevant' OR r.business_visibility <> 'eligible'))`;
    where = appendCommentDateRangeFilter(where, params, req.query);

    const leads = await queryAll(`
      SELECT *,
        (SELECT published_at FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.tenant_id = comment_leads.tenant_id) AS comment_published_at,
        (SELECT source_type FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.tenant_id = comment_leads.tenant_id) AS comment_source_type
      FROM comment_leads
      ${where}
      ORDER BY captured_at DESC
      LIMIT 5000
    `, params);

    leads.forEach(l => { l.publish_display = formatPublishDate(l.comment_published_at, l.captured_at); });

    const rows = leads.map(l => ({
      keyword: Array.isArray(l.matched_keywords) ? l.matched_keywords.join('、') : '',
      platform: PLATFORM_CN[l.platform] || l.platform || '',
      record_title: l.record_title,
      record_url: l.record_url,
      comment_content: l.comment_content,
      comment_author_name: l.comment_author_name,
      koe: (['dealer', 'employee'].includes(l.comment_source_type) ? '是' : '否'),
      comment_ip_location: l.comment_ip_location,
      comment_like_count: l.comment_like_count,
      lead_type: LEAD_TYPE_CN[l.lead_type] || l.lead_type || '',
      priority: PRIORITY_CN[l.priority] || l.priority || '',
      status: LEAD_STATUS_CN[l.status] || l.status || '',
      reason: l.reason,
      publish: l.publish_display,
      captured: fmtTs(l.captured_at),
    }));

    const columns = [
      { header: '采集关键词', key: 'keyword', width: 18 },
      { header: '平台', key: 'platform', width: 10 },
      { header: '原帖标题', key: 'record_title', width: 30 },
      { header: '原帖链接', key: 'record_url', width: 30 },
      { header: '评论内容', key: 'comment_content', width: 50 },
      { header: '评论作者', key: 'comment_author_name', width: 16 },
      { header: '疑似KOE', key: 'koe', width: 8 },
      { header: 'IP', key: 'comment_ip_location', width: 10 },
      { header: '点赞', key: 'comment_like_count', width: 8 },
      { header: '类型', key: 'lead_type', width: 12 },
      { header: '优先级', key: 'priority', width: 8 },
      { header: '状态', key: 'status', width: 10 },
      { header: 'AI理由', key: 'reason', width: 40 },
      { header: '发布时间', key: 'publish', width: 18 },
      { header: '采集时间', key: 'captured', width: 18 },
    ];

    const exportNoun = String(req.query.category || '') === 'sales' ? '销售客资' : '评论分诊';
    await sendXlsx(res, { sheetName: exportNoun, columns, rows, filename: `${exportNoun}_${fmtTs(new Date()).slice(0, 10)}.xlsx` });
  } catch (err) {
    return next(err);
  }
});

router.get('/comments/:id', requireTenantAccess, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id', message: '线索ID无效' });
    const lead = await queryOne(`SELECT ${LEAD_DETAIL_COLUMNS} FROM comment_leads WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.tenantId]);
    if (!lead) return res.status(404).json({ ok: false, error: 'not_found', message: '线索不存在' });
    const record = await queryOne('SELECT * FROM records WHERE id = $1 AND tenant_id = $2', [lead.record_id, req.tenantId]);
    lead.publish_display = formatPublishDate(lead.comment_published_at, lead.captured_at);
    const activity = await getCommentLeadActivities({ tenantId: req.tenantId, id: lead.id });
    const ticket = lead.ticket_id ? await queryOne(`SELECT * FROM tickets
      WHERE id = $1 AND tenant_id = $2 AND source_type = 'comment' AND source_comment_id = $3`,
    [lead.ticket_id, req.tenantId, lead.id]) : null;
    return res.json({ ok: true, lead, record, ticket, activity, suggestion: buildCommentLeadSuggestion(lead, record || {}) });
  } catch (err) { return leadError(res, next, err); }
});

export default router;
