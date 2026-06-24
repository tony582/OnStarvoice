import { Router } from 'express';
import { queryAll, queryOne, execute } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { resolveLeadType, resolvePriority, leadReason } from '../services/comment-leads.js';
import { classifyCommentWithAI } from '../services/ai-labeler.js';
import { formatPublishDate } from '../services/publish-date.js';
import { sendXlsx, fmtTs } from '../services/xlsx-export.js';

const router = Router();

// 导出用中文标签映射(MAP[v]||v||'')
const PLATFORM_CN = { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博' };
const PRIORITY_CN = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const LEAD_STATUS_CN = { new: '新线索', following: '跟进中', resolved: '已处理', ignored: '已忽略' };
const LEAD_TYPE_CN = { complaint: '投诉维权', renewal_billing: '续费收费', app_issue: 'App故障', service_quality: '服务求助', safety_privacy: '安全隐私', brand_risk: '品牌风险', sales_intent: '购买意向', other: '其他' };

// AI 一键重判:对现有「销售客资」逐条重跑 AI 判购买意向,非购买的移回对应舆情类型。
router.post('/comments/rejudge-sales', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const limit = Math.min(300, Math.max(1, Number(req.body?.limit) || 100));
    const totalRow = await queryOne(`SELECT COUNT(*)::int AS n FROM comment_leads WHERE tenant_id = $1 AND lead_type = 'sales_intent'`, [req.tenantId]);
    const leads = await queryAll(`
      SELECT cl.id, cl.platform, cl.comment_content, cl.comment_author_name, cl.comment_ip_location, cl.comment_like_count,
             r.title AS record_title, r.content AS record_content
      FROM comment_leads cl
      LEFT JOIN records r ON r.id = cl.record_id AND r.tenant_id = cl.tenant_id
      WHERE cl.tenant_id = $1 AND cl.lead_type = 'sales_intent'
      ORDER BY cl.captured_at DESC
      LIMIT $2
    `, [req.tenantId, limit]);

    let changed = 0;
    for (const lead of leads) {
      const comment = { content: lead.comment_content, author_name: lead.comment_author_name, ip_location: lead.comment_ip_location, like_count: lead.comment_like_count };
      const record = { title: lead.record_title, content: lead.record_content, platform: lead.platform };
      let ai = null;
      try { ai = await classifyCommentWithAI({ tenantId: req.tenantId, record, comment }); } catch { ai = null; }
      if (!ai) continue;
      const newType = resolveLeadType({ content: lead.comment_content, category: ai.category, ai_result: ai.ai_result });
      if (newType === 'sales_intent') continue; // AI 确认仍是购买意向 → 保留
      await execute(
        `UPDATE comment_leads SET lead_type = $3, priority = $4, ai_result = $5::jsonb, reason = $6, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [
          lead.id, req.tenantId, newType,
          resolvePriority({ risk_level: ai.risk_level, like_count: lead.comment_like_count }),
          JSON.stringify(ai.ai_result || {}),
          leadReason({ ai_summary: ai.ai_summary, ai_result: ai.ai_result }),
        ],
      );
      changed += 1;
    }
    return res.json({ ok: true, scanned: leads.length, changed, total: totalRow?.n || 0 });
  } catch (err) { return next(err); }
});

const LEAD_STATUSES = new Set(['new', 'following', 'resolved', 'ignored']);
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
  where += ` AND EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND ${conds.join(' AND ')})`;
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
    // 评论分诊与内容分诊同构的两个 MECE 桶:待处理(new) / 已归档(resolved+ignored)。
    // 已转工单(following)不在分诊视图,在工单系统里跟踪。
    const bucket = String(req.query.bucket || '');
    if (bucket === 'pending') {
      where += ` AND status = 'new'`;
    } else if (bucket === 'archived') {
      where += ` AND status IN ('resolved', 'ignored')`;
    } else if (status && LEAD_STATUSES.has(String(status))) {
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
      where += ` AND EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.source_type IN ('dealer','employee'))`;
    } else if (koe === 'hide') {
      where += ` AND NOT EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.source_type IN ('dealer','employee'))`;
    }
    where = appendCommentDateRangeFilter(where, params, req.query);

    const total = (await queryOne(
      `SELECT COUNT(*) AS total FROM comment_leads ${where}`,
      params,
    ))?.total || 0;

    const limit = Math.min(100, Math.max(1, Number(pageSize) || 30));
    const offset = (Math.max(1, Number(page)) - 1) * limit;
    params.push(limit, offset);

    const leads = await queryAll(`
      SELECT *,
        (SELECT content FROM records r WHERE r.id = comment_leads.record_id) AS record_content,
        (SELECT ai_summary FROM records r WHERE r.id = comment_leads.record_id) AS record_ai_summary,
        (SELECT sentiment FROM records r WHERE r.id = comment_leads.record_id) AS record_sentiment,
        (SELECT published_at FROM record_comments rc WHERE rc.id = comment_leads.comment_id) AS comment_published_at,
        (SELECT source_type FROM record_comments rc WHERE rc.id = comment_leads.comment_id) AS comment_source_type,
        (SELECT first_seen_at FROM record_comments rc WHERE rc.id = comment_leads.comment_id) AS comment_first_seen_at,
        (SELECT last_seen_at FROM record_comments rc WHERE rc.id = comment_leads.comment_id) AS comment_last_seen_at,
        (SELECT seen_count FROM record_comments rc WHERE rc.id = comment_leads.comment_id) AS comment_seen_count
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

// 批量更新评论线索。注意:必须注册在 '/comments/:id' 之前,否则 'batch' 会被当作 id 解析。
router.patch('/comments/batch', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const rawIds = req.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100) {
      return res.status(400).json({ ok: false, error: 'invalid_ids', message: 'ids 需为 1-100 个线索ID' });
    }
    const ids = [...new Set(rawIds.map(id => String(id || '').trim().toLowerCase()).filter(Boolean))];
    const validIds = ids.filter(id => UUID_RE.test(id));

    const status = req.body?.status ? String(req.body.status) : null;
    const priority = req.body?.priority ? String(req.body.priority) : null;
    if (status !== null && !LEAD_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: 'invalid_status', message: '线索状态无效' });
    }
    if (priority !== null && !LEAD_PRIORITIES.has(priority)) {
      return res.status(400).json({ ok: false, error: 'invalid_priority', message: '线索优先级无效' });
    }
    if (status === null && priority === null) {
      return res.status(400).json({ ok: false, error: 'empty_update', message: '没有要更新的字段' });
    }

    let updatedRows = [];
    if (validIds.length) {
      // following = 已转工单,批量置 following 仅对销售客资生效,舆情评论跳过(应走转工单)
      const followingGuard = status === 'following' ? ` AND lead_type = 'sales_intent'` : '';
      updatedRows = await queryAll(`
        UPDATE comment_leads
        SET status = COALESCE($3, status),
          priority = COALESCE($4, priority),
          updated_at = now()
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])${followingGuard}
        RETURNING id
      `, [req.tenantId, validIds, status, priority]);
    }

    const updatedSet = new Set(updatedRows.map(row => String(row.id).toLowerCase()));
    const skipped = ids.filter(id => !updatedSet.has(id));
    return res.json({ ok: true, updated: updatedSet.size, skipped });
  } catch (err) {
    return next(err);
  }
});

router.patch('/comments/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const status = String(req.body?.status || '');
    const priority = String(req.body?.priority || '');
    const updates = [];
    const params = [];
    if (status) {
      if (!LEAD_STATUSES.has(status)) {
        return res.status(400).json({ ok: false, error: 'invalid_status', message: '线索状态无效' });
      }
      // following = 已转工单,只能由 POST /tickets 设置;舆情评论不允许手动置 following
      if (status === 'following') {
        const row = await queryOne('SELECT lead_type FROM comment_leads WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
        if (row && row.lead_type !== 'sales_intent') {
          return res.status(400).json({ ok: false, error: 'following_via_ticket_only', message: '舆情评论请用「转工单」流转,不要用跟进' });
        }
      }
      params.push(status);
      updates.push(`status = $${params.length}`);
    }
    if (priority) {
      if (!LEAD_PRIORITIES.has(priority)) {
        return res.status(400).json({ ok: false, error: 'invalid_priority', message: '线索优先级无效' });
      }
      params.push(priority);
      updates.push(`priority = $${params.length}`);
    }
    // 处理备注留痕(选填):写入 note + 处理人 + 处理时间
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) {
      params.push(String(req.body.note || ''));
      updates.push(`note = $${params.length}`);
    }
    if (status) {
      params.push(req.user?.id || null);
      updates.push(`handled_by = $${params.length}`);
      params.push(req.user?.name || req.user?.email || '');
      updates.push(`handled_name = $${params.length}`);
      updates.push('handled_at = now()');
    }
    if (!updates.length) {
      return res.status(400).json({ ok: false, error: 'empty_update', message: '没有要更新的字段' });
    }
    updates.push('updated_at = now()');
    params.push(req.params.id, req.tenantId);
    const lead = await queryOne(`
      UPDATE comment_leads
      SET ${updates.join(', ')}
      WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
      RETURNING *
    `, params);
    if (!lead) return res.status(404).json({ ok: false, error: 'not_found', message: '线索不存在' });
    return res.json({ ok: true, lead });
  } catch (err) {
    return next(err);
  }
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
    if (bucket === 'pending') {
      where += ` AND status = 'new'`;
    } else if (bucket === 'archived') {
      where += ` AND status IN ('resolved', 'ignored')`;
    } else if (status && LEAD_STATUSES.has(String(status))) {
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
      where += ` AND EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.source_type IN ('dealer','employee'))`;
    } else if (koe === 'hide') {
      where += ` AND NOT EXISTS (SELECT 1 FROM record_comments rc WHERE rc.id = comment_leads.comment_id AND rc.source_type IN ('dealer','employee'))`;
    }
    where = appendCommentDateRangeFilter(where, params, req.query);

    const leads = await queryAll(`
      SELECT *,
        (SELECT published_at FROM record_comments rc WHERE rc.id = comment_leads.comment_id) AS comment_published_at,
        (SELECT source_type FROM record_comments rc WHERE rc.id = comment_leads.comment_id) AS comment_source_type
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

export default router;
