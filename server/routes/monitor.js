import { Router } from 'express';
import { queryOne, queryAll, execute } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/subscriptions', requireAuth, (req, res) => {
  const { status = 'all' } = req.query;
  let sql = 'SELECT * FROM monitor_subscriptions WHERE 1=1';
  const params = [];
  if (status !== 'all') { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  return res.json({ ok: true, subscriptions: queryAll(sql, params) });
});

router.post('/subscriptions', requireAuth, (req, res) => {
  const { name, keyword, platform = '', accountUrl = '', notifyOnNegative = 1 } = req.body;
  if (!keyword) return res.json({ ok: false, error: 'invalid_request', message: '关键词不能为空' });
  const result = execute(
    'INSERT INTO monitor_subscriptions (name, keyword, platform, account_url, notify_on_negative, auth_code) VALUES (?, ?, ?, ?, ?, ?)',
    [name || keyword, keyword, platform, accountUrl, notifyOnNegative ? 1 : 0, req.authCode]
  );
  return res.json({ ok: true, id: result.lastInsertRowid });
});

router.patch('/subscriptions/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { status, name, keyword, platform, notifyOnNegative } = req.body;
  const updates = []; const params = [];
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (keyword !== undefined) { updates.push('keyword = ?'); params.push(keyword); }
  if (platform !== undefined) { updates.push('platform = ?'); params.push(platform); }
  if (notifyOnNegative !== undefined) { updates.push('notify_on_negative = ?'); params.push(notifyOnNegative ? 1 : 0); }
  if (updates.length === 0) return res.json({ ok: false, message: '没有要更新的字段' });
  updates.push("updated_at = datetime('now')");
  params.push(id);
  execute(`UPDATE monitor_subscriptions SET ${updates.join(', ')} WHERE id = ?`, params);
  return res.json({ ok: true });
});

router.get('/executions', requireAuth, (req, res) => {
  const { subscriptionId, limit = 50 } = req.query;
  let sql = 'SELECT * FROM monitor_executions WHERE 1=1';
  const params = [];
  if (subscriptionId) { sql += ' AND subscription_id = ?'; params.push(subscriptionId); }
  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(Number(limit));
  return res.json({ ok: true, executions: queryAll(sql, params) });
});

router.get('/settings', requireAuth, (req, res) => {
  const rows = queryAll("SELECT key, value FROM settings WHERE key LIKE 'alert_%' OR key LIKE 'report_%'");
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return res.json({ ok: true, settings });
});

router.put('/settings', requireAuth, (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    execute(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value ?? '')]
    );
  }
  return res.json({ ok: true });
});

router.post('/run-now', requireAuth, (req, res) => {
  const { subscriptionId } = req.body;
  const sub = queryOne('SELECT * FROM monitor_subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) return res.json({ ok: false, error: 'not_found', message: '订阅不存在' });
  const result = execute(
    "INSERT INTO monitor_executions (subscription_id, status) VALUES (?, 'pending')",
    [subscriptionId]
  );
  return res.json({ ok: true, executionId: result.lastInsertRowid, message: '已创建执行任务' });
});

export default router;
