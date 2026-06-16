import { Router } from 'express';
import { queryAll, queryOne } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

// MECE 四状态:待处理 / 处理中 / 已处理 / 已忽略
const STATES = new Set(['pending', 'doing', 'done', 'dismissed']);

// 统一"舆情项":内容(负面 / 有负评的帖子)+ 评论(非销售意向的风险评论)
const ITEMS_CTE = `
  WITH items AS (
    SELECT
      'content'::text AS item_type, r.id::text AS id, r.platform,
      r.opinion_state, r.opinion_result, r.opinion_note,
      r.opinion_handled_name, r.opinion_handled_at,
      COALESCE(NULLIF(r.title, ''), r.content) AS item_text,
      r.author_name AS author, ''::text AS ip, r.sentiment,
      r.url, r.cover_url,
      r.negative_comment_count AS neg_comments,
      (r.likes + r.comments_count + r.collects + r.shares) AS interactions,
      ''::text AS lead_type, ''::text AS priority, ''::text AS record_title,
      r.created_at AS ts
    FROM records r
    WHERE r.tenant_id = $1
      AND (r.sentiment = 'negative' OR r.negative_comment_count > 0)
    UNION ALL
    SELECT
      'comment'::text AS item_type, cl.id::text AS id, cl.platform,
      cl.opinion_state, cl.opinion_result, cl.opinion_note,
      cl.opinion_handled_name, cl.opinion_handled_at,
      cl.comment_content AS item_text,
      cl.comment_author_name AS author, cl.comment_ip_location AS ip, ''::text AS sentiment,
      cl.record_url AS url, ''::text AS cover_url,
      0 AS neg_comments, cl.comment_like_count AS interactions,
      cl.lead_type, cl.priority, cl.record_title,
      cl.captured_at AS ts
    FROM comment_leads cl
    WHERE cl.tenant_id = $1
      AND cl.lead_type <> 'sales_intent'
  )
`;

router.get('/', requireTenantAccess, async (req, res, next) => {
  try {
    const state = STATES.has(String(req.query.state)) ? String(req.query.state) : '';
    const type = ['content', 'comment'].includes(String(req.query.type)) ? String(req.query.type) : '';
    const platform = String(req.query.platform || '');
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));

    // 通用筛选(类型/平台/搜索),状态单列以便统计每个 tab 的数量
    const baseParams = [req.tenantId];
    let baseFilt = ' WHERE 1=1';
    if (type) { baseParams.push(type); baseFilt += ` AND item_type = $${baseParams.length}`; }
    if (platform) { baseParams.push(platform); baseFilt += ` AND platform = $${baseParams.length}`; }
    if (q) { baseParams.push(`%${q}%`); baseFilt += ` AND (item_text ILIKE $${baseParams.length} OR author ILIKE $${baseParams.length})`; }

    const countRows = await queryAll(
      `${ITEMS_CTE} SELECT opinion_state, COUNT(*)::int AS n FROM items ${baseFilt} GROUP BY opinion_state`,
      baseParams,
    );
    const counts = { pending: 0, doing: 0, done: 0, dismissed: 0 };
    countRows.forEach((r) => { if (r.opinion_state in counts) counts[r.opinion_state] = r.n; });

    const params = [...baseParams];
    let filt = baseFilt;
    if (state) { params.push(state); filt += ` AND opinion_state = $${params.length}`; }

    const total = (await queryOne(`${ITEMS_CTE} SELECT COUNT(*)::int AS total FROM items ${filt}`, params))?.total || 0;
    params.push(pageSize, (page - 1) * pageSize);
    const items = await queryAll(
      `${ITEMS_CTE} SELECT * FROM items ${filt}
       ORDER BY (opinion_state = 'pending') DESC,
         CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         ts DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return res.json({
      ok: true,
      items,
      counts,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) { return next(err); }
});

router.patch('/:type/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const state = String(req.body?.state || '');
    if (!STATES.has(state)) return res.status(400).json({ ok: false, error: 'invalid_state', message: '状态无效' });
    const table = type === 'content' ? 'records' : type === 'comment' ? 'comment_leads' : null;
    if (!table) return res.status(400).json({ ok: false, error: 'invalid_type', message: '类型无效' });

    const result = String(req.body?.result || '');
    const vals = [req.tenantId, id, state, result, req.user?.id || null, req.user?.name || req.user?.email || ''];
    const sets = [
      'opinion_state = $3', 'opinion_result = $4',
      'opinion_handled_by = $5', 'opinion_handled_name = $6', 'opinion_handled_at = now()',
    ];
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) {
      vals.push(String(req.body.note || ''));
      sets.push(`opinion_note = $${vals.length}`);
    }
    const row = await queryOne(
      `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $2 AND tenant_id = $1 RETURNING id`,
      vals,
    );
    if (!row) return res.status(404).json({ ok: false, error: 'not_found', message: '舆情项不存在' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

export default router;
