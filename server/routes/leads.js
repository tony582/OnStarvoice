import { Router } from 'express';
import { queryAll, queryOne } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

const LEAD_STATUSES = new Set(['new', 'following', 'resolved', 'ignored']);
const LEAD_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const LEAD_TYPES = new Set([
  'complaint', 'renewal_billing', 'app_issue', 'service_quality',
  'safety_privacy', 'brand_risk', 'other',
]);

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
    if (status && LEAD_STATUSES.has(String(status))) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    if (platform) {
      params.push(platform);
      where += ` AND platform = $${params.length}`;
    }
    if (leadType && LEAD_TYPES.has(String(leadType))) {
      params.push(leadType);
      where += ` AND lead_type = $${params.length}`;
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

    const total = (await queryOne(
      `SELECT COUNT(*) AS total FROM comment_leads ${where}`,
      params,
    ))?.total || 0;

    const limit = Math.min(100, Math.max(1, Number(pageSize) || 30));
    const offset = (Math.max(1, Number(page)) - 1) * limit;
    params.push(limit, offset);

    const leads = await queryAll(`
      SELECT *
      FROM comment_leads
      ${where}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        captured_at DESC,
        updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

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
      updatedRows = await queryAll(`
        UPDATE comment_leads
        SET status = COALESCE($3, status),
          priority = COALESCE($4, priority),
          updated_at = now()
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
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

export default router;
