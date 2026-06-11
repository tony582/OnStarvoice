import { Router } from 'express';
import { queryOne, queryAll, execute, getAllSettings, setSettings, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMonitorSubscriptionRow(row = {}) {
  if (!row) return row;
  return {
    ...row,
    accountUrl: row.account_url || '',
    bloggerUrl: row.account_url || '',
    bloggerNameSnapshot: row.name || '',
    bloggerName: row.name || '',
    platformBloggerId: row.keyword || '',
    notifyOnNegative: Boolean(row.notify_on_negative),
    cadenceMinutes: Number(row.cadence_minutes || 0),
    lastCursor: row.last_cursor || '',
    lastRunAt: row.last_run_at || null,
    nextRunAt: row.next_run_at || null,
    lastError: row.last_error || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function resolveSubscriptionInput(body = {}) {
  const platform = normalizeText(body.platform);
  const accountUrl = normalizeText(
    body.accountUrl || body.bloggerUrl || body.profileUrl || body.authorUrl
  );
  const platformBloggerId = normalizeText(
    body.platformBloggerId || body.bloggerId || body.authorId
  );
  const keyword = normalizeText(
    body.keyword || platformBloggerId || body.bloggerNameSnapshot || body.name || accountUrl
  );
  const name = normalizeText(
    body.name || body.bloggerNameSnapshot || body.bloggerName || keyword
  );

  return {
    name,
    keyword,
    platform,
    accountUrl,
    notifyOnNegative: body.notifyOnNegative ?? 1,
    cadenceMinutes: Number(body.cadenceMinutes) || 1440,
  };
}

router.get('/subscriptions', requireTenantAccess, async (req, res, next) => {
  try {
    const { status = 'all', platform = '' } = req.query;
    const params = [req.tenantId];
    let sql = 'SELECT * FROM monitor_subscriptions WHERE tenant_id = $1';
    if (status !== 'all') { params.push(status); sql += ` AND status = $${params.length}`; }
    if (platform) { params.push(platform); sql += ` AND platform = $${params.length}`; }
    sql += ' ORDER BY created_at DESC';
    const subscriptions = (await queryAll(sql, params)).map(normalizeMonitorSubscriptionRow);
    return res.json({
      ok: true,
      subscriptions,
      data: { items: subscriptions },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/subscriptions', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const input = resolveSubscriptionInput(req.body);
    if (!input.keyword) {
      return res.json({ ok: false, error: 'invalid_request', message: '账号 ID 或关键词不能为空' });
    }

    const existing = await queryOne(`
      SELECT * FROM monitor_subscriptions
      WHERE tenant_id = $1
        AND platform = $2
        AND (
          keyword = $3
          OR (account_url <> '' AND account_url = $4)
        )
      ORDER BY status = 'deleted', created_at DESC
      LIMIT 1
    `, [req.tenantId, input.platform, input.keyword, input.accountUrl]);

    if (existing) {
      if (existing.status === 'deleted') {
        const restored = await queryOne(`
          UPDATE monitor_subscriptions
          SET status = 'active',
            name = $1,
            keyword = $2,
            account_url = $3,
            notify_on_negative = $4,
            cadence_minutes = $5,
            next_run_at = now(),
            updated_at = now()
          WHERE id = $6 AND tenant_id = $7
          RETURNING *
        `, [
          input.name || input.keyword,
          input.keyword,
          input.accountUrl,
          Boolean(input.notifyOnNegative),
          input.cadenceMinutes,
          existing.id,
          req.tenantId,
        ]);
        return res.json({
          ok: true,
          id: restored.id,
          data: { restored: true, item: normalizeMonitorSubscriptionRow(restored) },
        });
      }

      return res.json({
        ok: true,
        id: existing.id,
        data: { created: false, item: normalizeMonitorSubscriptionRow(existing) },
      });
    }

    const result = await queryOne(`
      INSERT INTO monitor_subscriptions (
        tenant_id, name, keyword, platform, account_url, notify_on_negative,
        cadence_minutes, auth_code, next_run_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      RETURNING *
    `, [
      req.tenantId, input.name || input.keyword, input.keyword, input.platform, input.accountUrl,
      Boolean(input.notifyOnNegative), input.cadenceMinutes, req.authCode || '',
    ]);
    return res.json({
      ok: true,
      id: result.id,
      data: { created: true, item: normalizeMonitorSubscriptionRow(result) },
    });
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
    const { subscriptionId, platform = '', limit } = req.body;
    const params = [req.tenantId];
    let sql = `
      SELECT *
      FROM monitor_subscriptions
      WHERE tenant_id = $1
        AND status = 'active'
    `;

    if (subscriptionId) {
      params.push(subscriptionId);
      sql += ` AND id = $${params.length}`;
    }
    if (!subscriptionId && platform) {
      params.push(platform);
      sql += ` AND platform = $${params.length}`;
    }

    params.push(Math.min(50, Math.max(1, Number(limit) || 50)));
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const subscriptions = await queryAll(sql, params);
    if (subscriptionId && subscriptions.length === 0) {
      return res.json({ ok: false, error: 'not_found', message: '订阅不存在' });
    }

    const items = [];
    for (const sub of subscriptions) {
      const existing = await queryOne(`
        SELECT id, status
        FROM monitor_executions
        WHERE tenant_id = $1
          AND subscription_id = $2
          AND status IN ('pending', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `, [req.tenantId, sub.id]);

      if (existing) {
        items.push({
          subscriptionId: sub.id,
          executionId: existing.id,
          platform: sub.platform,
          status: 'queued',
          queued: true,
          existing: true,
        });
        continue;
      }

      const result = await queryOne(`
        INSERT INTO monitor_executions (tenant_id, subscription_id, status)
        VALUES ($1, $2, 'pending')
        RETURNING id
      `, [req.tenantId, sub.id]);

      items.push({
        subscriptionId: sub.id,
        executionId: result.id,
        platform: sub.platform,
        status: 'queued',
        queued: true,
        existing: false,
      });
    }

    return res.json({
      ok: true,
      executionId: items[0]?.executionId || null,
      message: items.length > 0 ? `已创建 ${items.length} 个执行任务` : '暂无可执行监控项',
      data: {
        items,
        total: items.length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
