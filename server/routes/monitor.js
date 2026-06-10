import { Router } from 'express';
import { queryOne, queryAll, execute, getAllSettings, setSettings, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

router.get('/subscriptions', requireTenantAccess, async (req, res, next) => {
  try {
    const { status = 'all' } = req.query;
    const params = [req.tenantId];
    let sql = 'SELECT * FROM monitor_subscriptions WHERE tenant_id = $1';
    if (status !== 'all') { params.push(status); sql += ` AND status = $${params.length}`; }
    sql += ' ORDER BY created_at DESC';
    return res.json({ ok: true, subscriptions: await queryAll(sql, params) });
  } catch (err) {
    return next(err);
  }
});

router.post('/subscriptions', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { name, keyword, platform = '', accountUrl = '', notifyOnNegative = 1, cadenceMinutes = 1440 } = req.body;
    if (!keyword) return res.json({ ok: false, error: 'invalid_request', message: '关键词不能为空' });
    const result = await execute(`
      INSERT INTO monitor_subscriptions (
        tenant_id, name, keyword, platform, account_url, notify_on_negative,
        cadence_minutes, auth_code, next_run_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      RETURNING id
    `, [
      req.tenantId, name || keyword, keyword, platform, accountUrl,
      Boolean(notifyOnNegative), Number(cadenceMinutes) || 1440, req.authCode || '',
    ]);
    return res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    return next(err);
  }
});

router.patch('/subscriptions/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, name, keyword, platform, accountUrl, notifyOnNegative, cadenceMinutes } = req.body;
    const updates = [];
    const params = [];
    const add = (field, value) => {
      params.push(value);
      updates.push(`${field} = $${params.length}`);
    };

    if (status !== undefined) add('status', status);
    if (name !== undefined) add('name', name);
    if (keyword !== undefined) add('keyword', keyword);
    if (platform !== undefined) add('platform', platform);
    if (accountUrl !== undefined) add('account_url', accountUrl);
    if (notifyOnNegative !== undefined) add('notify_on_negative', Boolean(notifyOnNegative));
    if (cadenceMinutes !== undefined) add('cadence_minutes', Number(cadenceMinutes) || 1440);
    if (updates.length === 0) return res.json({ ok: false, message: '没有要更新的字段' });
    updates.push('updated_at = now()');
    params.push(id, req.tenantId);

    const result = await execute(
      `UPDATE monitor_subscriptions SET ${updates.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
      params
    );
    return res.json({ ok: result.rowCount > 0 });
  } catch (err) {
    return next(err);
  }
});

router.get('/executions', requireTenantAccess, async (req, res, next) => {
  try {
    const { subscriptionId, limit = 50 } = req.query;
    const params = [req.tenantId];
    let sql = 'SELECT * FROM monitor_executions WHERE tenant_id = $1';
    if (subscriptionId) { params.push(subscriptionId); sql += ` AND subscription_id = $${params.length}`; }
    params.push(Number(limit));
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    return res.json({ ok: true, executions: await queryAll(sql, params) });
  } catch (err) {
    return next(err);
  }
});

router.get('/due', requireTenantAccess, async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const executions = await queryAll(`
      SELECT
        me.*,
        ms.name,
        ms.keyword,
        ms.platform,
        ms.account_url,
        ms.cadence_minutes,
        ms.last_cursor
      FROM monitor_executions me
      JOIN monitor_subscriptions ms ON ms.id = me.subscription_id
      WHERE me.tenant_id = $1
        AND me.status = 'pending'
        AND ms.status = 'active'
      ORDER BY me.created_at ASC
      LIMIT $2
    `, [req.tenantId, limit]);

    return res.json({ ok: true, executions });
  } catch (err) {
    return next(err);
  }
});

router.post('/executions/:id/start', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const result = await execute(`
      UPDATE monitor_executions
      SET status = 'running', started_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
      RETURNING id
    `, [req.params.id, req.tenantId]);
    return res.json({ ok: result.rowCount > 0, executionId: result.rows[0]?.id || null });
  } catch (err) {
    return next(err);
  }
});

router.post('/executions/:id/finish', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const {
      status = 'succeeded',
      recordsFound = 0,
      newRecords = 0,
      updatedRecords = 0,
      negativeCount = 0,
      errorMessage = '',
      nextCursor = '',
    } = req.body;

    const finalStatus = status === 'failed' ? 'failed' : 'succeeded';
    const result = await withTransaction(async tx => {
      const execution = await tx.queryOne(`
        UPDATE monitor_executions
        SET status = $1,
          records_found = $2,
          new_records = $3,
          updated_records = $4,
          negative_count = $5,
          error_message = $6,
          finished_at = now(),
          updated_at = now()
        WHERE id = $7 AND tenant_id = $8 AND status IN ('pending', 'running')
        RETURNING *
      `, [
        finalStatus,
        Number(recordsFound) || 0,
        Number(newRecords) || 0,
        Number(updatedRecords) || 0,
        Number(negativeCount) || 0,
        errorMessage || '',
        req.params.id,
        req.tenantId,
      ]);

      if (!execution) return null;

      await tx.execute(`
        UPDATE monitor_subscriptions
        SET last_run_at = now(),
          next_run_at = CASE
            WHEN $1 = 'succeeded' THEN now() + make_interval(mins => cadence_minutes)
            ELSE now() + interval '15 minutes'
          END,
          last_cursor = COALESCE(NULLIF($2, ''), last_cursor),
          last_error = $3,
          updated_at = now()
        WHERE id = $4 AND tenant_id = $5
      `, [finalStatus, nextCursor || '', finalStatus === 'failed' ? errorMessage : '', execution.subscription_id, req.tenantId]);

      return execution;
    });

    return res.json({ ok: Boolean(result), execution: result });
  } catch (err) {
    return next(err);
  }
});

router.get('/settings', requireTenantAccess, async (req, res, next) => {
  try {
    const all = await getAllSettings(req.tenantId);
    const settings = {};
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('alert_') || key.startsWith('report_')) settings[key] = value;
    }
    return res.json({ ok: true, settings });
  } catch (err) {
    return next(err);
  }
});

router.put('/settings', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    await setSettings(req.body, req.tenantId);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.post('/run-now', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { subscriptionId } = req.body;
    const sub = await queryOne(
      'SELECT * FROM monitor_subscriptions WHERE id = $1 AND tenant_id = $2',
      [subscriptionId, req.tenantId]
    );
    if (!sub) return res.json({ ok: false, error: 'not_found', message: '订阅不存在' });

    const result = await execute(`
      INSERT INTO monitor_executions (tenant_id, subscription_id, status)
      VALUES ($1, $2, 'pending')
      RETURNING id
    `, [req.tenantId, subscriptionId]);

    return res.json({ ok: true, executionId: result.lastInsertRowid, message: '已创建执行任务' });
  } catch (err) {
    return next(err);
  }
});

export default router;
