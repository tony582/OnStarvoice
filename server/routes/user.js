/**
 * 用户端 API — 激活码鉴权，仅查看自己的租户数据
 */
import { Router } from 'express';
import { queryAll, queryOne } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { serializeRecords } from '../services/record-store.js';

const router = Router();

router.post('/login', requireAuth, (req, res) => {
  const row = req.authCodeRow;
  return res.json({
    ok: true,
    owner: row.owner_name || '',
    type: row.type,
    expiresAt: row.expires_at || null,
    tenant: { id: req.tenantId, name: req.tenantName },
  });
});

router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const days = Number(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const totalRecords = (await queryOne('SELECT COUNT(*) as n FROM records WHERE tenant_id = $1', [req.tenantId])).n;
    const recentRecords = (await queryOne('SELECT COUNT(*) as n FROM records WHERE tenant_id = $1 AND created_at >= $2', [req.tenantId, since])).n;
    const sentimentDist = await queryAll(
      "SELECT sentiment, COUNT(*) as count FROM records WHERE tenant_id = $1 AND created_at >= $2 AND sentiment <> '' GROUP BY sentiment",
      [req.tenantId, since]
    );
    const categoryDist = await queryAll(
      "SELECT category, COUNT(*) as count FROM records WHERE tenant_id = $1 AND created_at >= $2 AND category <> '' GROUP BY category ORDER BY count DESC",
      [req.tenantId, since]
    );
    const platformDist = await queryAll(
      'SELECT platform, COUNT(*) as count FROM records WHERE tenant_id = $1 AND created_at >= $2 GROUP BY platform',
      [req.tenantId, since]
    );
    const topInteraction = await queryAll(
      'SELECT id, title, url, platform, likes, comments_count, collects, shares, sentiment, author_name, author_fans FROM records WHERE tenant_id = $1 AND created_at >= $2 ORDER BY (likes + comments_count + collects + shares) DESC LIMIT 10',
      [req.tenantId, since]
    );

    return res.json({
      ok: true,
      stats: { totalRecords, recentRecords, sentimentDist, categoryDist, platformDist, topInteraction },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/records', requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));
    const { platform, sentiment, category, keyword, sort } = req.query;

    let where = ' WHERE tenant_id = $1';
    const params = [req.tenantId];
    if (platform) { params.push(platform); where += ` AND platform = $${params.length}`; }
    if (sentiment) { params.push(sentiment); where += ` AND sentiment = $${params.length}`; }
    if (category) { params.push(category); where += ` AND category = $${params.length}`; }
    if (keyword) {
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
      where += ` AND (title ILIKE $${params.length - 2} OR content ILIKE $${params.length - 1} OR keyword ILIKE $${params.length})`;
    }

    const sortOptions = {
      newest: 'created_at DESC',
      oldest: 'created_at ASC',
      likes: 'likes DESC',
      shares: 'shares DESC',
      interaction: '(likes + comments_count + collects + shares) DESC',
    };
    const sortCol = sortOptions[sort] || 'created_at DESC';

    const total = (await queryOne(`SELECT COUNT(*) as total FROM records${where}`, params)).total;
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);
    const records = await queryAll(
      `SELECT * FROM records${where} ORDER BY ${sortCol} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      ok: true,
      records: serializeRecords(records),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
