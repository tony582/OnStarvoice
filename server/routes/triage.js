import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

const TRIAGE_STATUSES = new Set(['unhandled', 'reviewing', 'issue_linked', 'official_responded', 'archived', 'false_positive']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

function validateStatus(status) {
  return TRIAGE_STATUSES.has(status || '') ? status : null;
}

function validatePriority(priority) {
  return PRIORITIES.has(priority || '') ? priority : null;
}

function riskOrderSql() {
  return `
    CASE
      WHEN r.negative_comment_count > 0 AND COALESCE(rt.status, 'unhandled') IN ('unhandled', 'reviewing') THEN 0
      WHEN r.sentiment = 'negative' AND (r.likes + r.comments_count + r.collects + r.shares) >= 500 THEN 1
      WHEN r.sentiment = 'negative' THEN 2
      WHEN EXISTS (SELECT 1 FROM alerts a WHERE a.record_id = r.id) THEN 3
      WHEN (r.likes + r.comments_count + r.collects + r.shares) >= 500 THEN 4
      ELSE 5
    END ASC,
    r.negative_comment_count DESC,
    (r.likes + r.comments_count + r.collects + r.shares) DESC,
    r.last_seen_at DESC
  `;
}

router.get('/records', requireTenantAccess, async (req, res, next) => {
  try {
    const {
      status = '',
      priority = '',
      platform = '',
      sentiment = '',
      keyword = '',
      queue = '',
      page = 1,
      pageSize = 30,
    } = req.query;
    const params = [req.tenantId];
    let where = 'WHERE r.tenant_id = $1';
    if (platform) { params.push(platform); where += ` AND r.platform = $${params.length}`; }
    if (sentiment) { params.push(sentiment); where += ` AND r.sentiment = $${params.length}`; }
    if (status) {
      params.push(status);
      where += ` AND COALESCE(rt.status, 'unhandled') = $${params.length}`;
    } else if (queue === 'active') {
      where += `
        AND r.record_type <> 'official_content'
        AND COALESCE(rt.status, 'unhandled') IN ('unhandled', 'reviewing')
        AND NOT (r.official_response_status = 'responded' AND r.negative_comment_count = 0)
      `;
    }
    if (priority) { params.push(priority); where += ` AND COALESCE(rt.priority, 'normal') = $${params.length}`; }
    if (keyword) {
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
      where += ` AND (r.title ILIKE $${params.length - 2} OR r.content ILIKE $${params.length - 1} OR r.keyword ILIKE $${params.length})`;
    }

    const total = (await queryOne(`
      SELECT COUNT(*) AS total
      FROM records r
      LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
      ${where}
    `, params)).total;

    const limit = Math.min(100, Math.max(1, Number(pageSize) || 30));
    const offset = (Math.max(1, Number(page)) - 1) * limit;
    params.push(limit, offset);
    const records = await queryAll(`
      SELECT
        r.id, r.platform, r.title, r.content, r.author_name, r.author_avatar,
        r.author_fans, r.url, r.cover_url, r.image_urls, r.note_type,
        r.publish_time, r.blogger_profile_url,
        r.likes, r.comments_count, r.collects, r.shares,
        r.comments_capture_status, r.comments_total_captured,
        r.official_replied, r.official_response_status, r.negative_comment_count,
        r.latest_negative_comment_at, r.last_risk_reopened_at,
        r.sentiment, r.category, r.ai_summary, r.keyword, r.first_seen_at, r.last_seen_at,
        r.seen_count, r.created_at,
        COALESCE(rt.status, 'unhandled') AS triage_status,
        COALESCE(rt.priority, 'normal') AS triage_priority,
        COALESCE(rt.owner_name, '') AS triage_owner_name,
        COALESCE(rt.note, '') AS triage_note,
        (SELECT COUNT(*) FROM alerts a WHERE a.record_id = r.id AND a.tenant_id = r.tenant_id) AS alert_count,
        (SELECT COUNT(*) FROM issue_records ir WHERE ir.record_id = r.id AND ir.tenant_id = r.tenant_id) AS issue_count,
        (
          SELECT rc.content
          FROM record_comments rc
          WHERE rc.record_id = r.id AND rc.tenant_id = r.tenant_id AND rc.is_negative = true AND rc.is_official = false
          ORDER BY rc.last_seen_at DESC
          LIMIT 1
        ) AS latest_negative_comment
      FROM records r
      LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
      ${where}
      ORDER BY ${riskOrderSql()}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    return res.json({
      ok: true,
      records,
      pagination: { page: Number(page), pageSize: limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/records/:recordId', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const status = validateStatus(req.body?.status) || 'unhandled';
    const priority = validatePriority(req.body?.priority) || 'normal';
    const ownerName = String(req.body?.ownerName || '');
    const note = String(req.body?.note || '');

    const result = await withTransaction(async tx => {
      const record = await tx.queryOne('SELECT id FROM records WHERE id = $1 AND tenant_id = $2', [req.params.recordId, req.tenantId]);
      if (!record) return null;
      const triage = await tx.queryOne(`
        INSERT INTO record_triage (tenant_id, record_id, status, priority, owner_user_id, owner_name, note, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        ON CONFLICT (tenant_id, record_id)
        DO UPDATE SET
          status = excluded.status,
          priority = excluded.priority,
          owner_user_id = excluded.owner_user_id,
          owner_name = excluded.owner_name,
          note = excluded.note,
          updated_at = now()
        RETURNING *
      `, [req.tenantId, req.params.recordId, status, priority, req.user?.id || null, ownerName, note]);
      await tx.execute(`
        INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES ($1, $2, $3, $4, 'record.triage_updated', 'record', $5, $6::jsonb)
      `, [req.tenantId, req.actorType || 'system', req.user?.id || req.authCode || '', req.user?.id || null, req.params.recordId, JSON.stringify({ status, priority })]);
      return triage;
    });

    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    return res.json({ ok: true, triage: result });
  } catch (err) {
    return next(err);
  }
});

router.post('/records/:recordId/issues', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { issueId = '', title = '', severity = 'medium', summary = '', suggestedAction = '' } = req.body || {};

    const result = await withTransaction(async tx => {
      const record = await tx.queryOne('SELECT * FROM records WHERE id = $1 AND tenant_id = $2', [req.params.recordId, req.tenantId]);
      if (!record) return null;

      let issue;
      if (issueId) {
        issue = await tx.queryOne('SELECT * FROM issues WHERE id = $1 AND tenant_id = $2', [issueId, req.tenantId]);
        if (!issue) return null;
      } else {
        issue = await tx.queryOne(`
          INSERT INTO issues (
            tenant_id, title, severity, status, summary, suggested_action,
            primary_record_id, cluster_key, record_count
          ) VALUES ($1, $2, $3, 'triage', $4, $5, $6, gen_random_uuid()::text, 0)
          RETURNING *
        `, [
          req.tenantId,
          title || record.title || record.content.slice(0, 80) || '未命名舆情问题',
          severity,
          summary || record.ai_summary || '',
          suggestedAction || '',
          record.id,
        ]);
      }

      await tx.execute(`
        INSERT INTO issue_records (tenant_id, issue_id, record_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (issue_id, record_id) DO NOTHING
      `, [req.tenantId, issue.id, record.id]);
      await tx.execute(`
        UPDATE issues
        SET record_count = (SELECT COUNT(*) FROM issue_records WHERE issue_id = $1),
          last_seen_at = now(),
          updated_at = now()
        WHERE id = $1
      `, [issue.id]);
      await tx.execute(`
        INSERT INTO issue_events (tenant_id, issue_id, event_type, body, actor_type, actor_name, metadata)
        VALUES ($1, $2, 'record_linked', '从舆情收件箱关联内容', 'user', $3, $4::jsonb)
      `, [req.tenantId, issue.id, req.actorName || '', JSON.stringify({ recordId: record.id })]);
      await tx.execute(`
        INSERT INTO record_triage (tenant_id, record_id, status, priority, owner_user_id, owner_name, updated_at)
        VALUES ($1, $2, 'issue_linked', 'high', $3, $4, now())
        ON CONFLICT (tenant_id, record_id)
        DO UPDATE SET status = 'issue_linked', priority = 'high', owner_user_id = excluded.owner_user_id,
          owner_name = excluded.owner_name, updated_at = now()
      `, [req.tenantId, record.id, req.user?.id || null, req.actorName || '']);

      return issue;
    });

    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '内容或问题不存在' });
    return res.json({ ok: true, issue: result });
  } catch (err) {
    return next(err);
  }
});

export default router;
