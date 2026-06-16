import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

const TRIAGE_STATUSES = new Set(['unhandled', 'reviewing', 'issue_linked', 'official_responded', 'archived', 'false_positive']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 收件箱「待处理队列」条件(别名约定: records r / record_triage rt)。
// workspace.js 的 /badges 计数 import 此常量,保证侧边栏徽标与收件箱列表数字一致。
export const ACTIVE_QUEUE_CONDITION = `
  r.record_type <> 'official_content'
  AND (r.ai_result->>'relevance' IS DISTINCT FROM 'irrelevant')
  AND COALESCE(rt.status, 'unhandled') IN ('unhandled', 'reviewing')
  AND NOT (r.official_response_status = 'responded' AND r.negative_comment_count = 0)
`;

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
      where += ` AND (${ACTIVE_QUEUE_CONDITION})`;
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
        r.ai_result, r.seen_count, r.created_at,
        COALESCE(rt.status, 'unhandled') AS triage_status,
        COALESCE(rt.priority, 'normal') AS triage_priority,
        COALESCE(rt.owner_name, '') AS triage_owner_name,
        COALESCE(rt.note, '') AS triage_note,
        rt.updated_at AS triage_updated_at,
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

// 批量分诊更新。注意:必须注册在 '/records/:recordId' 之前,否则 'batch' 会被当作 recordId 解析。
router.patch('/records/batch', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const rawIds = req.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100) {
      return res.status(400).json({ ok: false, error: 'invalid_ids', message: 'ids 需为 1-100 个内容ID' });
    }
    const ids = [...new Set(rawIds.map(id => String(id || '').trim().toLowerCase()).filter(Boolean))];
    const validIds = ids.filter(id => UUID_RE.test(id));

    const status = req.body?.status ? String(req.body.status) : null;
    const priority = req.body?.priority ? String(req.body.priority) : null;
    if (status !== null && !validateStatus(status)) {
      return res.status(400).json({ ok: false, error: 'invalid_status', message: '分诊状态无效' });
    }
    if (priority !== null && !validatePriority(priority)) {
      return res.status(400).json({ ok: false, error: 'invalid_priority', message: '优先级无效' });
    }
    if (status === null && priority === null) {
      return res.status(400).json({ ok: false, error: 'empty_update', message: '没有要更新的字段' });
    }

    let updatedIds = [];
    if (validIds.length) {
      updatedIds = await withTransaction(async tx => {
        const rows = await tx.queryAll(`
          INSERT INTO record_triage (tenant_id, record_id, status, priority, owner_user_id, owner_name, updated_at)
          SELECT r.tenant_id, r.id, COALESCE($3, 'unhandled'), COALESCE($4, 'normal'), $5, $6, now()
          FROM records r
          WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])
          ON CONFLICT (tenant_id, record_id)
          DO UPDATE SET
            status = CASE WHEN $3::text IS NOT NULL THEN excluded.status ELSE record_triage.status END,
            priority = CASE WHEN $4::text IS NOT NULL THEN excluded.priority ELSE record_triage.priority END,
            owner_user_id = excluded.owner_user_id,
            owner_name = excluded.owner_name,
            updated_at = now()
          RETURNING record_id
        `, [req.tenantId, validIds, status, priority, req.user?.id || null, req.actorName || '']);
        await tx.execute(`
          INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
          VALUES ($1, $2, $3, $4, 'record.triage_batch_updated', 'record', '', $5::jsonb)
        `, [
          req.tenantId,
          req.actorType || 'system',
          req.user?.id || req.authCode || '',
          req.user?.id || null,
          JSON.stringify({ recordIds: validIds, status, priority, updated: rows.length }),
        ]);
        return rows.map(row => String(row.record_id).toLowerCase());
      });
    }

    const updatedSet = new Set(updatedIds);
    const skipped = ids.filter(id => !updatedSet.has(id));
    return res.json({ ok: true, updated: updatedSet.size, skipped });
  } catch (err) {
    return next(err);
  }
});

router.patch('/records/:recordId', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    // 部分更新语义:仅更新请求里携带的字段。
    // 旧实现会把缺省字段重置(只传 priority 时 status 被打回 unhandled),已修复。
    const body = req.body || {};
    const status = body.status ? String(body.status) : null;
    const priority = body.priority ? String(body.priority) : null;
    if (status !== null && !validateStatus(status)) {
      return res.status(400).json({ ok: false, error: 'invalid_status', message: '分诊状态无效' });
    }
    if (priority !== null && !validatePriority(priority)) {
      return res.status(400).json({ ok: false, error: 'invalid_priority', message: '优先级无效' });
    }
    const ownerName = Object.prototype.hasOwnProperty.call(body, 'ownerName') ? String(body.ownerName || '') : null;
    const note = Object.prototype.hasOwnProperty.call(body, 'note') ? String(body.note || '') : null;

    const result = await withTransaction(async tx => {
      const record = await tx.queryOne('SELECT id FROM records WHERE id = $1 AND tenant_id = $2', [req.params.recordId, req.tenantId]);
      if (!record) return null;
      const triage = await tx.queryOne(`
        INSERT INTO record_triage (tenant_id, record_id, status, priority, owner_user_id, owner_name, note, updated_at)
        VALUES ($1, $2, COALESCE($3, 'unhandled'), COALESCE($4, 'normal'), $5, COALESCE($6, ''), COALESCE($7, ''), now())
        ON CONFLICT (tenant_id, record_id)
        DO UPDATE SET
          status = CASE WHEN $3::text IS NOT NULL THEN excluded.status ELSE record_triage.status END,
          priority = CASE WHEN $4::text IS NOT NULL THEN excluded.priority ELSE record_triage.priority END,
          owner_user_id = excluded.owner_user_id,
          owner_name = CASE WHEN $6::text IS NOT NULL THEN excluded.owner_name ELSE record_triage.owner_name END,
          note = CASE WHEN $7::text IS NOT NULL THEN excluded.note ELSE record_triage.note END,
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
