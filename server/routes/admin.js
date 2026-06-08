import { Router } from 'express';
import { queryAll, queryOne, execute, getAllSettings, setSettings } from '../db/init.js';
import { requireAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
router.use(requireAdmin);

// ==================== 激活码管理 ====================

router.get('/auth-codes', (req, res) => {
  const codes = queryAll(`
    SELECT ac.*,
      (SELECT COUNT(*) FROM auth_bindings WHERE code_id = ac.id) as binding_count
    FROM auth_codes ac ORDER BY ac.created_at DESC
  `);
  return res.json({ ok: true, codes });
});

router.post('/auth-codes', (req, res) => {
  const { type = 'trial', ownerEmail = '', ownerName = '', maxBindings = 3, durationDays, notes = '' } = req.body;
  const code = `OSV-${type.toUpperCase().slice(0, 1)}-${uuidv4().slice(0, 8).toUpperCase()}`;
  const expiresAt = new Date();
  if (type === 'trial') expiresAt.setDate(expiresAt.getDate() + (durationDays || 7));
  else if (type === 'annual') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  else expiresAt.setFullYear(expiresAt.getFullYear() + 100);

  const result = execute(
    'INSERT INTO auth_codes (code, type, owner_email, owner_name, max_bindings, expires_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [code, type, ownerEmail, ownerName, maxBindings, expiresAt.toISOString(), notes]
  );
  return res.json({ ok: true, id: result.lastInsertRowid, code, expiresAt: expiresAt.toISOString() });
});

router.patch('/auth-codes/:id', (req, res) => {
  const { id } = req.params;
  const { status, ownerEmail, ownerName, maxBindings, expiresAt, notes } = req.body;
  const updates = []; const params = [];
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (ownerEmail !== undefined) { updates.push('owner_email = ?'); params.push(ownerEmail); }
  if (ownerName !== undefined) { updates.push('owner_name = ?'); params.push(ownerName); }
  if (maxBindings !== undefined) { updates.push('max_bindings = ?'); params.push(maxBindings); }
  if (expiresAt !== undefined) { updates.push('expires_at = ?'); params.push(expiresAt); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  if (updates.length === 0) return res.json({ ok: false, message: '没有要更新的字段' });
  params.push(id);
  execute(`UPDATE auth_codes SET ${updates.join(', ')} WHERE id = ?`, params);
  return res.json({ ok: true });
});

router.post('/auth-codes/:id/renew', (req, res) => {
  const { id } = req.params;
  const { durationDays = 365 } = req.body;
  const code = queryOne('SELECT * FROM auth_codes WHERE id = ?', [id]);
  if (!code) return res.json({ ok: false, message: '激活码不存在' });
  const baseDate = code.expires_at && new Date(code.expires_at) > new Date()
    ? new Date(code.expires_at) : new Date();
  baseDate.setDate(baseDate.getDate() + durationDays);
  execute("UPDATE auth_codes SET expires_at = ?, status = 'active' WHERE id = ?", [baseDate.toISOString(), id]);
  return res.json({ ok: true, newExpiresAt: baseDate.toISOString() });
});

router.get('/auth-codes/:id/bindings', (req, res) => {
  const bindings = queryAll(
    'SELECT * FROM auth_bindings WHERE code_id = ? ORDER BY last_seen_at DESC', [req.params.id]
  );
  return res.json({ ok: true, bindings });
});

router.delete('/auth-codes/:id/bindings/:bindingId', (req, res) => {
  execute('DELETE FROM auth_bindings WHERE id = ? AND code_id = ?', [req.params.bindingId, req.params.id]);
  return res.json({ ok: true });
});

// ==================== 数据管理 ====================

router.get('/records', (req, res) => {
  const { platform, sentiment, category, keyword, page = 1, pageSize = 50, startDate, endDate, sort = 'created_at', order = 'DESC' } = req.query;

  let where = ' WHERE 1=1';
  const params = [];

  if (platform) { where += ' AND platform = ?'; params.push(platform); }
  if (sentiment) { where += ' AND sentiment = ?'; params.push(sentiment); }
  if (category) { where += ' AND category = ?'; params.push(category); }
  if (keyword) {
    const kw = `%${keyword}%`;
    where += ' AND (title LIKE ? OR content LIKE ? OR keyword LIKE ?)';
    params.push(kw, kw, kw);
  }
  if (startDate) { where += ' AND created_at >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND created_at <= ?'; params.push(endDate); }

  const total = queryOne(`SELECT COUNT(*) as total FROM records${where}`, params).total;

  const allowedSorts = ['created_at', 'likes', 'comments_count', 'collects'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
  const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const offset = (Math.max(1, Number(page)) - 1) * Number(pageSize);

  const records = queryAll(
    `SELECT * FROM records${where} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), offset]
  );

  return res.json({
    ok: true, records,
    pagination: { page: Number(page), pageSize: Number(pageSize), total, totalPages: Math.ceil(total / Number(pageSize)) },
  });
});

// ==================== 仪表盘统计 ====================

router.get('/stats', (req, res) => {
  const { days = 7 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - Number(days));
  const sinceStr = since.toISOString();

  const totalRecords = queryOne('SELECT COUNT(*) as n FROM records').n;
  const recentRecords = queryOne('SELECT COUNT(*) as n FROM records WHERE created_at >= ?', [sinceStr]).n;
  const sentimentDist = queryAll("SELECT sentiment, COUNT(*) as count FROM records WHERE created_at >= ? AND sentiment != '' GROUP BY sentiment", [sinceStr]);
  const categoryDist = queryAll("SELECT category, COUNT(*) as count FROM records WHERE created_at >= ? AND category != '' GROUP BY category ORDER BY count DESC", [sinceStr]);
  const platformDist = queryAll('SELECT platform, COUNT(*) as count FROM records WHERE created_at >= ? GROUP BY platform', [sinceStr]);
  const recentAlerts = queryAll('SELECT level, COUNT(*) as count FROM alerts WHERE created_at >= ? GROUP BY level', [sinceStr]);
  const topInteraction = queryAll(
    'SELECT id, title, url, platform, likes, comments_count, collects, sentiment, author_name FROM records WHERE created_at >= ? ORDER BY (likes + comments_count + collects) DESC LIMIT 10',
    [sinceStr]
  );
  const activeCodes = queryOne("SELECT COUNT(*) as n FROM auth_codes WHERE status = 'active'").n;

  return res.json({
    ok: true,
    stats: { totalRecords, recentRecords, sentimentDist, categoryDist, platformDist, recentAlerts, topInteraction, activeCodes },
  });
});

// ==================== 预警管理 ====================

router.get('/alerts', (req, res) => {
  const { level, limit = 100 } = req.query;
  let sql = 'SELECT a.*, r.title as record_title, r.url as record_url, r.platform FROM alerts a LEFT JOIN records r ON a.record_id = r.id WHERE 1=1';
  const params = [];
  if (level) { sql += ' AND a.level = ?'; params.push(level); }
  sql += ' ORDER BY a.created_at DESC LIMIT ?';
  params.push(Number(limit));
  return res.json({ ok: true, alerts: queryAll(sql, params) });
});

// ==================== 系统设置 ====================

router.get('/settings', (req, res) => {
  const settings = getAllSettings();
  const masked = { ...settings };
  if (masked.llm_api_key) masked.llm_api_key = masked.llm_api_key.slice(0, 8) + '***';
  if (masked.smtp_pass) masked.smtp_pass = '***';
  return res.json({ ok: true, settings: masked, raw: settings });
});

router.put('/settings', (req, res) => {
  setSettings(req.body);
  return res.json({ ok: true });
});

router.post('/login', (req, res) => {
  return res.json({ ok: true, message: '登录成功' });
});

export default router;
