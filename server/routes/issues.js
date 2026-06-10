import { Router } from 'express';
import { queryAll, queryOne, execute, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

router.get('/', requireTenantAccess, async (req, res, next) => {
  try {
    const { status, severity, limit = 100, page = 1 } = req.query;
    const params = [req.tenantId];
    let where = 'WHERE i.tenant_id = $1';
    if (status) { params.push(status); where += ` AND i.status = $${params.length}`; }
    if (severity) { params.push(severity); where += ` AND i.severity = $${params.length}`; }
    const pageSize = Math.min(200, Math.max(1, Number(limit)));
    const offset = (Math.max(1, Number(page)) - 1) * pageSize;

    const total = (await queryOne(`SELECT COUNT(*) as total FROM issues i ${where}`, params)).total;
    params.push(pageSize, offset);
    const issues = await queryAll(`
      SELECT i.*, r.title AS primary_record_title, r.url AS primary_record_url, r.platform AS primary_record_platform
      FROM issues i
      LEFT JOIN records r ON r.id = i.primary_record_id
      ${where}
      ORDER BY
        CASE i.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        i.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    return res.json({ ok: true, issues, pagination: { page: Number(page), pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (err) {
    return next(err);
  }
});

router.post('/', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const {
      title,
      severity = 'medium',
      summary = '',
      suggestedAction = '',
      ownerName = '',
      ownerEmail = '',
      dueAt = null,
      primaryRecordId = null,
    } = req.body;
    if (!title) return res.status(400).json({ ok: false, error: 'invalid_request', message: '标题不能为空' });

    if (primaryRecordId) {
      const record = await queryOne('SELECT id FROM records WHERE id = $1 AND tenant_id = $2', [primaryRecordId, req.tenantId]);
      if (!record) return res.status(404).json({ ok: false, error: 'record_not_found', message: '关联内容不存在' });
    }

    const result = await execute(`
      INSERT INTO issues (
        tenant_id, title, severity, summary, suggested_action,
        owner_name, owner_email, due_at, primary_record_id, cluster_key, record_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, gen_random_uuid()::text, 0)
      RETURNING id
    `, [req.tenantId, title, severity, summary, suggestedAction, ownerName, ownerEmail, dueAt, primaryRecordId]);

    return res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', requireTenantAccess, async (req, res, next) => {
  try {
    const issue = await queryOne(`
      SELECT i.*, r.title AS primary_record_title, r.url AS primary_record_url, r.platform AS primary_record_platform
      FROM issues i
      LEFT JOIN records r ON r.id = i.primary_record_id
      WHERE i.id = $1 AND i.tenant_id = $2
    `, [req.params.id, req.tenantId]);
    if (!issue) return res.status(404).json({ ok: false, error: 'not_found', message: '问题不存在' });

    const records = await queryAll(`
      SELECT r.id, r.title, r.content, r.url, r.platform, r.author_name, r.likes,
        r.comments_count, r.collects, r.shares, r.sentiment, r.category, r.last_seen_at,
        ir.alert_id, ir.created_at AS linked_at
      FROM issue_records ir
      JOIN records r ON r.id = ir.record_id
      WHERE ir.issue_id = $1 AND ir.tenant_id = $2
      ORDER BY ir.created_at DESC
    `, [req.params.id, req.tenantId]);

    const events = await queryAll(
      'SELECT * FROM issue_events WHERE issue_id = $1 AND tenant_id = $2 ORDER BY created_at DESC',
      [req.params.id, req.tenantId]
    );

    return res.json({ ok: true, issue, records, events });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, severity, ownerName, ownerEmail, dueAt, summary, suggestedAction } = req.body;
    const updates = [];
    const params = [];
    const add = (field, value) => {
      params.push(value);
      updates.push(`${field} = $${params.length}`);
    };
    if (status !== undefined) add('status', status);
    if (severity !== undefined) add('severity', severity);
    if (ownerName !== undefined) add('owner_name', ownerName);
    if (ownerEmail !== undefined) add('owner_email', ownerEmail);
    if (dueAt !== undefined) add('due_at', dueAt || null);
    if (summary !== undefined) add('summary', summary);
    if (suggestedAction !== undefined) add('suggested_action', suggestedAction);
    if (updates.length === 0) return res.json({ ok: false, message: '没有要更新的字段' });
    updates.push('updated_at = now()');
    params.push(id, req.tenantId);

    const result = await withTransaction(async tx => {
      const updated = await tx.queryOne(
        `UPDATE issues SET ${updates.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`,
        params
      );
      if (!updated) return null;
      await tx.execute(`
        INSERT INTO issue_events (tenant_id, issue_id, event_type, body, actor_type, actor_name, metadata)
        VALUES ($1, $2, 'issue_updated', '问题状态已更新', 'user', $3, $4::jsonb)
      `, [req.tenantId, id, req.actorName || req.authCode || '', JSON.stringify(req.body)]);
      return updated;
    });

    return res.json({ ok: Boolean(result), issue: result });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/events', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const issue = await queryOne('SELECT id FROM issues WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!issue) return res.status(404).json({ ok: false, error: 'not_found', message: '问题不存在' });
    const { eventType = 'comment', body = '', metadata = {} } = req.body;
    const result = await execute(`
      INSERT INTO issue_events (tenant_id, issue_id, event_type, body, actor_type, actor_name, metadata)
      VALUES ($1, $2, $3, $4, 'user', $5, $6::jsonb)
      RETURNING id
    `, [req.tenantId, req.params.id, eventType, body, req.actorName || req.authCode || '', JSON.stringify(metadata || {})]);
    return res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/records', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { recordId, alertId = null } = req.body;
    if (!recordId) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'recordId 不能为空' });

    const result = await withTransaction(async tx => {
      const issue = await tx.queryOne('SELECT id FROM issues WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
      const record = await tx.queryOne('SELECT id FROM records WHERE id = $1 AND tenant_id = $2', [recordId, req.tenantId]);
      if (!issue || !record) return null;

      const link = await tx.queryOne(`
        INSERT INTO issue_records (tenant_id, issue_id, record_id, alert_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (issue_id, record_id)
        DO UPDATE SET alert_id = COALESCE(issue_records.alert_id, excluded.alert_id)
        RETURNING id
      `, [req.tenantId, req.params.id, recordId, alertId]);

      await tx.execute(`
        UPDATE issues
        SET record_count = (SELECT COUNT(*) FROM issue_records WHERE issue_id = $1),
          last_seen_at = now(),
          updated_at = now()
        WHERE id = $1
      `, [req.params.id]);
      await tx.execute(`
        INSERT INTO issue_events (tenant_id, issue_id, event_type, body, actor_type, actor_name, metadata)
        VALUES ($1, $2, 'record_linked', '人工关联内容', 'user', $3, $4::jsonb)
      `, [req.tenantId, req.params.id, req.actorName || req.authCode || '', JSON.stringify({ recordId, alertId })]);
      return link;
    });

    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '问题或内容不存在' });
    return res.json({ ok: true, id: result.id });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/events', requireTenantAccess, async (req, res, next) => {
  try {
    const issue = await queryOne('SELECT id FROM issues WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!issue) return res.status(404).json({ ok: false, error: 'not_found', message: '问题不存在' });
    const events = await queryAll(
      'SELECT * FROM issue_events WHERE issue_id = $1 AND tenant_id = $2 ORDER BY created_at DESC',
      [req.params.id, req.tenantId]
    );
    return res.json({ ok: true, events });
  } catch (err) {
    return next(err);
  }
});

export default router;
