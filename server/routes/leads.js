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
