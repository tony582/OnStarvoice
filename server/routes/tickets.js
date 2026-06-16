import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';

const router = Router();

// 客服侧在队列里可见的状态(已 closed 的归档不在队列,只在回执历史)
const QUEUE_STATES = ['pending', 'doing', 'done', 'dismissed'];
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

const TICKET_COLUMNS = `
  id, source_type, source_record_id, source_comment_id,
  platform, title, item_text, author, url, cover_url,
  category, priority, status,
  assignee_name, created_by_name, dispatch_note,
  handle_result, handle_note, handled_by_name, handled_at,
  feedback_status, reviewed_by_name, reviewed_at, review_note,
  created_at, updated_at
`;

const ORDER = `
  ORDER BY
    CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
    created_at DESC
`;

// ==================== 转工单(分诊侧:创建工单 + 把源移出分诊队列)====================
router.post('/', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const sourceType = String(req.body?.sourceType || '');
    const sourceId = String(req.body?.sourceId || '');
    if (!['content', 'comment'].includes(sourceType) || !sourceId) {
      return res.status(400).json({ ok: false, error: 'invalid_source', message: '来源无效' });
    }
    const priority = PRIORITIES.has(String(req.body?.priority)) ? String(req.body.priority) : '';
    const assigneeName = String(req.body?.assigneeName || '').trim();
    const dispatchNote = String(req.body?.note || '');

    // 防重:同一源若已有未关闭工单,直接返回它
    const existing = await queryOne(
      `SELECT ${TICKET_COLUMNS} FROM tickets
       WHERE tenant_id = $1 AND status <> 'closed'
         AND ${sourceType === 'content' ? 'source_record_id' : 'source_comment_id'} = $2
       LIMIT 1`,
      [req.tenantId, sourceId],
    );
    if (existing) return res.json({ ok: true, ticket: existing, existed: true });

    // 取源快照
    let snap;
    if (sourceType === 'content') {
      snap = await queryOne(
        `SELECT platform, COALESCE(NULLIF(title, ''), content) AS title, content AS item_text,
                author_name AS author, url, cover_url, '' AS category, 'normal' AS src_priority
         FROM records WHERE id = $1 AND tenant_id = $2`,
        [sourceId, req.tenantId],
      );
    } else {
      snap = await queryOne(
        `SELECT platform, COALESCE(NULLIF(record_title, ''), '评论') AS title, comment_content AS item_text,
                comment_author_name AS author, record_url AS url, '' AS cover_url,
                lead_type AS category, priority AS src_priority
         FROM comment_leads WHERE id = $1 AND tenant_id = $2`,
        [sourceId, req.tenantId],
      );
    }
    if (!snap) return res.status(404).json({ ok: false, error: 'not_found', message: '来源不存在' });

    const ticket = await withTransaction(async (tx) => {
      const row = await tx.queryOne(
        `INSERT INTO tickets (
           tenant_id, source_type, source_record_id, source_comment_id,
           platform, title, item_text, author, url, cover_url,
           category, priority, assignee_name,
           created_by_user_id, created_by_name, dispatch_note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING ${TICKET_COLUMNS}`,
        [
          req.tenantId, sourceType,
          sourceType === 'content' ? sourceId : null,
          sourceType === 'comment' ? sourceId : null,
          snap.platform || '', snap.title || '', snap.item_text || '', snap.author || '',
          snap.url || '', snap.cover_url || '',
          snap.category || '', priority || snap.src_priority || 'normal', assigneeName,
          req.user?.id || null, req.user?.name || req.user?.email || '', dispatchNote,
        ],
      );
      // 把源移出分诊队列:内容→已转工单(issue_linked),评论→跟进中(following)
      if (sourceType === 'content') {
        await tx.execute(
          `INSERT INTO record_triage (tenant_id, record_id, status, owner_user_id, owner_name, updated_at)
           VALUES ($1, $2, 'issue_linked', $3, $4, now())
           ON CONFLICT (tenant_id, record_id)
           DO UPDATE SET status = 'issue_linked', updated_at = now()`,
          [req.tenantId, sourceId, req.user?.id || null, req.user?.name || req.user?.email || ''],
        );
      } else {
        await tx.execute(
          `UPDATE comment_leads SET status = 'following', updated_at = now()
           WHERE id = $1 AND tenant_id = $2`,
          [sourceId, req.tenantId],
        );
      }
      return row;
    });

    return res.json({ ok: true, ticket });
  } catch (err) { return next(err); }
});

// ==================== 舆情处理(客服侧:工单队列)====================
router.get('/', requireTenantAccess, async (req, res, next) => {
  try {
    const status = QUEUE_STATES.includes(String(req.query.status)) ? String(req.query.status) : '';
    const type = ['content', 'comment'].includes(String(req.query.type)) ? String(req.query.type) : '';
    const platform = String(req.query.platform || '');
    const priority = PRIORITIES.has(String(req.query.priority)) ? String(req.query.priority) : '';
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));

    const params = [req.tenantId];
    let where = `WHERE tenant_id = $1 AND status <> 'closed'`;
    if (type) { params.push(type); where += ` AND source_type = $${params.length}`; }
    if (platform) { params.push(platform); where += ` AND platform = $${params.length}`; }
    if (priority) { params.push(priority); where += ` AND priority = $${params.length}`; }
    if (q) { params.push(`%${q}%`); where += ` AND (item_text ILIKE $${params.length} OR title ILIKE $${params.length} OR author ILIKE $${params.length})`; }

    const countRows = await queryAll(
      `SELECT status, COUNT(*)::int AS n FROM tickets ${where} GROUP BY status`, params,
    );
    const counts = { pending: 0, doing: 0, done: 0, dismissed: 0 };
    countRows.forEach((r) => { if (r.status in counts) counts[r.status] = r.n; });

    const listParams = [...params];
    let listWhere = where;
    if (status) { listParams.push(status); listWhere += ` AND status = $${listParams.length}`; }

    const total = (await queryOne(`SELECT COUNT(*)::int AS total FROM tickets ${listWhere}`, listParams))?.total || 0;
    listParams.push(pageSize, (page - 1) * pageSize);
    const items = await queryAll(
      `SELECT ${TICKET_COLUMNS} FROM tickets ${listWhere} ${ORDER}
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );

    return res.json({ ok: true, items, counts, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (err) { return next(err); }
});

// ==================== 已转工单(分诊侧:看自己转出去的工单进度 + 回执确认)====================
// view: review=待我确认(pending_review) / progress=客服处理中(pending+doing) / 空=全部未关闭
router.get('/dispatched', requireTenantAccess, async (req, res, next) => {
  try {
    const view = String(req.query.view || '');
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));

    const counts = {
      review: (await queryOne(`SELECT COUNT(*)::int AS n FROM tickets WHERE tenant_id = $1 AND feedback_status = 'pending_review'`, [req.tenantId]))?.n || 0,
      progress: (await queryOne(`SELECT COUNT(*)::int AS n FROM tickets WHERE tenant_id = $1 AND status IN ('pending', 'doing')`, [req.tenantId]))?.n || 0,
      total: (await queryOne(`SELECT COUNT(*)::int AS n FROM tickets WHERE tenant_id = $1 AND status <> 'closed'`, [req.tenantId]))?.n || 0,
    };

    const params = [req.tenantId];
    let where = `WHERE tenant_id = $1 AND status <> 'closed'`;
    if (view === 'review') where += ` AND feedback_status = 'pending_review'`;
    else if (view === 'progress') where += ` AND status IN ('pending', 'doing')`;

    const total = (await queryOne(`SELECT COUNT(*)::int AS total FROM tickets ${where}`, params))?.total || 0;
    params.push(pageSize, (page - 1) * pageSize);
    const items = await queryAll(
      `SELECT ${TICKET_COLUMNS} FROM tickets ${where}
       ORDER BY (feedback_status = 'pending_review') DESC,
         CASE status WHEN 'doing' THEN 1 WHEN 'pending' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
         updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.json({ ok: true, items, counts, total, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (err) { return next(err); }
});

// ==================== 工单源详情(原始博文 + AI 分析 + 负面评论)====================
router.get('/:id/source', requireTenantAccess, async (req, res, next) => {
  try {
    const ticket = await queryOne(
      `SELECT id, source_type, source_record_id, source_comment_id FROM tickets WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId],
    );
    if (!ticket) return res.status(404).json({ ok: false, error: 'not_found', message: '工单不存在' });

    let comment = null;
    let recordId = ticket.source_record_id;
    if (ticket.source_type === 'comment' && ticket.source_comment_id) {
      comment = await queryOne(
        `SELECT id, comment_content, comment_author_name, comment_ip_location, comment_like_count,
                reason, ai_result, matched_keywords, lead_type, priority, record_id, record_title, record_url
         FROM comment_leads WHERE id = $1 AND tenant_id = $2`,
        [ticket.source_comment_id, req.tenantId],
      );
      recordId = comment?.record_id || null;
    }

    let record = null;
    let negativeComments = [];
    if (recordId) {
      record = await queryOne(
        `SELECT id, platform, title, content, author_name, url, cover_url, sentiment, category,
                ai_summary, ai_result, negative_comment_count, likes, comments_count, collects, shares
         FROM records WHERE id = $1 AND tenant_id = $2`,
        [recordId, req.tenantId],
      );
      if (ticket.source_type === 'content') {
        negativeComments = await queryAll(
          `SELECT content, author_name, ip_location, sentiment, ai_summary, like_count
           FROM record_comments
           WHERE record_id = $1 AND tenant_id = $2 AND is_negative = true AND is_official = false
           ORDER BY last_seen_at DESC LIMIT 6`,
          [recordId, req.tenantId],
        );
      }
    }
    return res.json({ ok: true, record, comment, negativeComments });
  } catch (err) { return next(err); }
});

// ==================== 客服处理动作 ====================
router.patch('/:id', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const action = String(req.body?.action || '');
    const note = Object.prototype.hasOwnProperty.call(req.body || {}, 'note') ? String(req.body.note || '') : null;
    const result = String(req.body?.result || '');
    const actor = req.user?.name || req.user?.email || '';
    const actorId = req.user?.id || null;

    let sets;
    if (action === 'start') {
      sets = { sql: `status = 'doing', updated_at = now()`, params: [] };
    } else if (action === 'back') {
      sets = { sql: `status = 'pending', updated_at = now()`, params: [] };
    } else if (action === 'done' || action === 'dismiss') {
      const st = action === 'done' ? 'done' : 'dismissed';
      sets = {
        sql: `status = '${st}', feedback_status = 'pending_review',
              handle_result = $P, handle_note = COALESCE($P, handle_note),
              handled_by_user_id = $P, handled_by_name = $P, handled_at = now(), updated_at = now()`,
        params: [result, note, actorId, actor],
      };
    } else {
      return res.status(400).json({ ok: false, error: 'invalid_action', message: '动作无效' });
    }

    // 把 $P 占位替换为 $1..$n
    const vals = [...sets.params, req.params.id, req.tenantId];
    let i = 0;
    const setSql = sets.sql.replace(/\$P/g, () => `$${++i}`);
    const row = await queryOne(
      `UPDATE tickets SET ${setSql} WHERE id = $${i + 1} AND tenant_id = $${i + 2} RETURNING ${TICKET_COLUMNS}`,
      vals,
    );
    if (!row) return res.status(404).json({ ok: false, error: 'not_found', message: '工单不存在' });
    return res.json({ ok: true, ticket: row });
  } catch (err) { return next(err); }
});

// ==================== 分诊回执确认 ====================
router.patch('/:id/review', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '');
    const note = String(req.body?.note || '');
    const actor = req.user?.name || req.user?.email || '';
    const actorId = req.user?.id || null;
    if (!['confirm', 'reopen'].includes(decision)) {
      return res.status(400).json({ ok: false, error: 'invalid_decision', message: '决定无效' });
    }
    const status = decision === 'confirm' ? 'closed' : 'pending';
    const feedback = decision === 'confirm' ? 'confirmed' : 'reopened';
    const row = await queryOne(
      `UPDATE tickets
       SET status = $3, feedback_status = $4, reviewed_by_user_id = $5, reviewed_by_name = $6,
           reviewed_at = now(), review_note = $7, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND feedback_status = 'pending_review'
       RETURNING ${TICKET_COLUMNS}`,
      [req.params.id, req.tenantId, status, feedback, actorId, actor, note],
    );
    if (!row) return res.status(404).json({ ok: false, error: 'not_found', message: '工单不存在或不在待确认状态' });
    return res.json({ ok: true, ticket: row });
  } catch (err) { return next(err); }
});

export default router;
