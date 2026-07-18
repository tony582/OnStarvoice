import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireSessionUser, requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { FEEDBACK_REVIEW_STATUSES, FEEDBACK_TYPES, normalizeReviewStatus } from '../services/record-feedback.js';
import { fmtTs, sendXlsx } from '../services/xlsx-export.js';
import { identityLabel } from './triage.js';

const router = Router();

router.use(requireTenantAccess, requireSessionUser);

const TYPE_LABELS = { false_positive: '误报', manual_correction: '人工修正' };
const STATUS_LABELS = { pending: '待复核', reviewed: '已复核', summarized: '已总结', dismissed: '已忽略' };

export function normalizeFeedbackFilters(query = {}) {
  const status = String(query.status || query.reviewStatus || '').trim();
  const type = String(query.type || query.feedbackType || '').trim();
  const keyword = String(query.keyword || '').trim().slice(0, 200);
  if (status && !FEEDBACK_REVIEW_STATUSES.has(status)) {
    return { ok: false, error: 'invalid_status', message: '反馈复核状态无效' };
  }
  if (type && !FEEDBACK_TYPES.has(type)) {
    return { ok: false, error: 'invalid_type', message: '反馈类型无效' };
  }
  return { ok: true, status, type, keyword };
}

function buildFeedbackWhere(tenantId, filters) {
  const params = [tenantId];
  let where = 'WHERE rf.tenant_id = $1';
  if (filters.status) {
    params.push(filters.status);
    where += ` AND rf.review_status = $${params.length}`;
  }
  if (filters.type) {
    params.push(filters.type);
    where += ` AND rf.feedback_type = $${params.length}`;
  }
  if (filters.keyword) {
    const kw = `%${filters.keyword}%`;
    params.push(kw, kw, kw, kw, kw);
    where += ` AND (
      rf.reason ILIKE $${params.length - 4}
      OR rf.submitted_by_name ILIKE $${params.length - 3}
      OR COALESCE(r.title, rf.record_snapshot->>'title', '') ILIKE $${params.length - 2}
      OR COALESCE(r.author_name, rf.record_snapshot->>'author_name', '') ILIKE $${params.length - 1}
      OR COALESCE(r.platform, rf.record_snapshot->>'platform', '') ILIKE $${params.length}
    )`;
  }
  return { where, params };
}

const FEEDBACK_SELECT = `
  SELECT
    rf.*,
    COALESCE(r.title, rf.record_snapshot->>'title', '') AS record_title,
    COALESCE(r.author_name, rf.record_snapshot->>'author_name', '') AS record_author_name,
    COALESCE(r.platform, rf.record_snapshot->>'platform', '') AS record_platform,
    COALESCE(r.url, rf.record_snapshot->>'url', '') AS record_url,
    r.sentiment AS current_sentiment,
    r.category AS current_category,
    r.identity_override AS current_identity_override,
    r.source_type AS current_source_type,
    r.author_fans AS current_author_fans,
    r.publish_time AS current_publish_time
  FROM record_feedback rf
  LEFT JOIN records r ON r.id = rf.record_id AND r.tenant_id = rf.tenant_id
`;

router.get('/', async (req, res, next) => {
  try {
    const filters = normalizeFeedbackFilters(req.query);
    if (!filters.ok) return res.status(400).json({ ok: false, error: filters.error, message: filters.message });

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));
    const offset = (page - 1) * pageSize;
    const { where, params } = buildFeedbackWhere(req.tenantId, filters);
    const total = (await queryOne(`
      SELECT COUNT(*) AS total
      FROM record_feedback rf
      LEFT JOIN records r ON r.id = rf.record_id AND r.tenant_id = rf.tenant_id
      ${where}
    `, params))?.total || 0;

    const listParams = [...params, pageSize, offset];
    const feedback = await queryAll(`
      ${FEEDBACK_SELECT}
      ${where}
      ORDER BY rf.submitted_at DESC, rf.id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `, listParams);

    const countsRow = await queryOne(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE review_status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE review_status = 'reviewed') AS reviewed,
        COUNT(*) FILTER (WHERE review_status = 'summarized') AS summarized,
        COUNT(*) FILTER (WHERE review_status = 'dismissed') AS dismissed,
        COUNT(*) FILTER (WHERE feedback_type = 'false_positive') AS false_positive,
        COUNT(*) FILTER (WHERE feedback_type = 'manual_correction') AS manual_correction
      FROM record_feedback
      WHERE tenant_id = $1
    `, [req.tenantId]);

    return res.json({
      ok: true,
      feedback,
      pagination: { page, pageSize, total: Number(total), totalPages: Math.ceil(Number(total) / pageSize) },
      counts: {
        total: Number(countsRow?.total || 0),
        pending: Number(countsRow?.pending || 0),
        reviewed: Number(countsRow?.reviewed || 0),
        summarized: Number(countsRow?.summarized || 0),
        dismissed: Number(countsRow?.dismissed || 0),
        falsePositive: Number(countsRow?.false_positive || 0),
        manualCorrection: Number(countsRow?.manual_correction || 0),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/export', async (req, res, next) => {
  try {
    const filters = normalizeFeedbackFilters(req.query);
    if (!filters.ok) return res.status(400).json({ ok: false, error: filters.error, message: filters.message });
    const { where, params } = buildFeedbackWhere(req.tenantId, filters);
    const feedback = await queryAll(`
      ${FEEDBACK_SELECT}
      ${where}
      ORDER BY rf.submitted_at DESC, rf.id DESC
      LIMIT 5000
    `, params);

    const rows = feedback.map(item => ({
      type: TYPE_LABELS[item.feedback_type] || item.feedback_type,
      status: STATUS_LABELS[item.review_status] || item.review_status,
      platform: item.record_platform || '',
      title: item.record_title || '',
      author: item.record_author_name || '',
      url: item.record_url || '',
      reason: item.reason || '',
      current_sentiment: item.current_sentiment || '',
      current_category: item.current_category || '',
      current_identity: identityLabel(
        item.current_source_type,
        item.current_author_fans,
        item.record_author_name,
        item.current_identity_override,
      ),
      current_publish_time: item.current_publish_time || '',
      original_values: JSON.stringify(item.original_values || {}),
      corrected_values: JSON.stringify(item.corrected_values || {}),
      ai_snapshot: JSON.stringify(item.ai_snapshot || {}),
      record_snapshot: JSON.stringify(item.record_snapshot || {}),
      submitted_by: item.submitted_by_name || '',
      submitted_at: fmtTs(item.submitted_at),
      reviewed_by: item.reviewed_by_name || '',
      reviewed_at: fmtTs(item.reviewed_at),
      review_note: item.review_note || '',
    }));

    const columns = [
      { header: '反馈类型', key: 'type', width: 12 },
      { header: '复核状态', key: 'status', width: 12 },
      { header: '平台', key: 'platform', width: 10 },
      { header: '标题', key: 'title', width: 36 },
      { header: '作者', key: 'author', width: 16 },
      { header: '原文链接', key: 'url', width: 36 },
      { header: '原因', key: 'reason', width: 40 },
      { header: '当前情感', key: 'current_sentiment', width: 12 },
      { header: '当前分类', key: 'current_category', width: 18 },
      { header: '当前身份', key: 'current_identity', width: 12 },
      { header: '当前发布日期', key: 'current_publish_time', width: 16 },
      { header: '修改前', key: 'original_values', width: 48 },
      { header: '修改后', key: 'corrected_values', width: 48 },
      { header: 'AI判断快照', key: 'ai_snapshot', width: 48 },
      { header: '记录快照', key: 'record_snapshot', width: 60 },
      { header: '提交人', key: 'submitted_by', width: 16 },
      { header: '提交时间', key: 'submitted_at', width: 20 },
      { header: '复核人', key: 'reviewed_by', width: 16 },
      { header: '复核时间', key: 'reviewed_at', width: 20 },
      { header: '复核说明', key: 'review_note', width: 40 },
    ];

    return await sendXlsx(res, {
      sheetName: '反馈台账',
      columns,
      rows,
      filename: `反馈台账_${fmtTs(new Date()).slice(0, 10)}.xlsx`,
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', requireTenantWriter, async (req, res, next) => {
  try {
    const reviewStatus = normalizeReviewStatus(req.body?.reviewStatus ?? req.body?.status);
    if (!reviewStatus) {
      return res.status(400).json({ ok: false, error: 'invalid_status', message: '反馈复核状态无效' });
    }
    const reviewNote = String(req.body?.reviewNote ?? req.body?.note ?? '').trim().slice(0, 4000);
    if (reviewStatus === 'summarized' && !reviewNote) {
      return res.status(400).json({
        ok: false,
        error: 'summary_note_required',
        message: '纳入总结前请填写总结结论',
      });
    }
    const actorUserId = req.user?.id || null;
    const actorName = req.actorName || req.user?.name || req.user?.email || '';

    const feedback = await withTransaction(async tx => {
      const updated = await tx.queryOne(`
        UPDATE record_feedback
        SET review_status = $3,
          review_note = $4,
          reviewed_by_user_id = CASE WHEN $3 = 'pending' THEN NULL ELSE $5 END,
          reviewed_by_name = CASE WHEN $3 = 'pending' THEN '' ELSE $6 END,
          reviewed_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END,
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *
      `, [req.params.id, req.tenantId, reviewStatus, reviewNote, actorUserId, actorName]);
      if (!updated) return null;

      await tx.execute(`
        INSERT INTO audit_logs (
          tenant_id, actor_type, actor_id, actor_user_id,
          action, target_type, target_id, metadata
        ) VALUES ($1, 'user', $2, $3, 'record_feedback.reviewed', 'record_feedback', $4, $5::jsonb)
      `, [
        req.tenantId,
        actorUserId || '',
        actorUserId,
        updated.id,
        JSON.stringify({
          recordId: updated.record_id,
          feedbackType: updated.feedback_type,
          reviewStatus,
          reviewNote,
        }),
      ]);
      return updated;
    });

    if (!feedback) return res.status(404).json({ ok: false, error: 'not_found', message: '反馈不存在' });
    return res.json({ ok: true, feedback });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'pending_feedback_exists', message: '该内容已有待复核误报' });
    }
    return next(err);
  }
});

export default router;
