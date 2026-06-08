/**
 * 用户端 API — 激活码鉴权，仅查看自己的数据
 */
import { Router } from 'express';
import { queryAll, queryOne } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// 用户登录验证
router.post('/login', requireAuth, (req, res) => {
  const row = req.authCodeRow;
  return res.json({
    ok: true,
    owner: row.owner_name || '',
    type: row.type,
    expiresAt: row.expires_at || null,
  });
});

// 用户数据统计
router.get('/stats', requireAuth, (req, res) => {
  const code = req.authCode;
  const days = Number(req.query.days) || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const totalRecords = queryOne('SELECT COUNT(*) as n FROM records WHERE auth_code = ?', [code]).n;
  const recentRecords = queryOne('SELECT COUNT(*) as n FROM records WHERE auth_code = ? AND created_at >= ?', [code, since]).n;
  const sentimentDist = queryAll(
    "SELECT sentiment, COUNT(*) as count FROM records WHERE auth_code = ? AND created_at >= ? AND sentiment != '' GROUP BY sentiment",
    [code, since]
  );
  const categoryDist = queryAll(
    "SELECT category, COUNT(*) as count FROM records WHERE auth_code = ? AND created_at >= ? AND category != '' GROUP BY category ORDER BY count DESC",
    [code, since]
  );
  const platformDist = queryAll(
    'SELECT platform, COUNT(*) as count FROM records WHERE auth_code = ? AND created_at >= ? GROUP BY platform',
    [code, since]
  );
  const topInteraction = queryAll(
    'SELECT id, title, url, platform, likes, comments_count, collects, sentiment, author_name, author_fans FROM records WHERE auth_code = ? AND created_at >= ? ORDER BY (likes + comments_count + collects) DESC LIMIT 10',
    [code, since]
  );

  return res.json({
    ok: true,
    stats: { totalRecords, recentRecords, sentimentDist, categoryDist, platformDist, topInteraction },
  });
});

// 用户数据浏览
router.get('/records', requireAuth, (req, res) => {
  const code = req.authCode;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));
  const { platform, sentiment, category, keyword, sort } = req.query;

  let where = ' WHERE auth_code = ?';
  const params = [code];
  if (platform) { where += ' AND platform = ?'; params.push(platform); }
  if (sentiment) { where += ' AND sentiment = ?'; params.push(sentiment); }
  if (category) { where += ' AND category = ?'; params.push(category); }
  if (keyword) { where += ' AND (title LIKE ? OR content LIKE ? OR keyword LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }

  const sortOptions = { newest: 'created_at DESC', oldest: 'created_at ASC', likes: 'likes DESC', interaction: '(likes + comments_count + collects) DESC' };
  const sortCol = sortOptions[sort] || 'created_at DESC';

  const total = queryOne(`SELECT COUNT(*) as total FROM records${where}`, params).total;
  const offset = (page - 1) * pageSize;
  const records = queryAll(
    `SELECT * FROM records${where} ORDER BY ${sortCol} LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return res.json({
    ok: true,
    records,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
});

export default router;
