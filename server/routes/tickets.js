import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { sendXlsx, fmtTs } from '../services/xlsx-export.js';
import { getRecordLifecycle, sendRecordArchived } from '../services/record-lifecycle.js';
import { getOfficialResponses, getRecordComments } from '../services/comment-workflow.js';
import { formatPublishDate } from '../services/publish-date.js';

const router = Router();

// 客服侧在队列里可见的状态(已 closed 的归档不在队列,只在回执历史)
const QUEUE_STATES = ['pending', 'doing', 'done', 'dismissed'];
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

const TICKET_COLUMNS = `
  id, source_type, source_record_id, source_comment_id,
  platform, title, item_text, author, url, cover_url,
  category, priority, status,
  assignee_user_id, assignee_name, created_by_name, dispatch_note,
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
    const dispatchNote = String(req.body?.note || '');
    if (sourceType === 'content') {
      const lifecycle = await getRecordLifecycle({ tenantId: req.tenantId, recordId: sourceId });
      if (!lifecycle) return res.status(404).json({ ok: false, error: 'not_found', message: '来源不存在' });
      if (lifecycle.archived_at) return sendRecordArchived(res, [sourceId]);
    }

    // 指派:优先用 assigneeUserId(下拉选人),校验是本租户在职成员后反查姓名作快照
    let assigneeUserId = String(req.body?.assigneeUserId || '').trim() || null;
    let assigneeName = String(req.body?.assigneeName || '').trim();
    if (assigneeUserId) {
      const member = await queryOne(
        `SELECT COALESCE(NULLIF(u.name, ''), u.email) AS display
         FROM users u JOIN user_memberships m ON m.user_id = u.id
         WHERE u.id = $1 AND m.tenant_id = $2 AND u.status = 'active' AND m.status = 'active'`,
        [assigneeUserId, req.tenantId],
      );
      if (!member) return res.status(400).json({ ok: false, error: 'invalid_assignee', message: '指派对象不在本租户' });
      assigneeName = member.display;
    } else {
      // 未指派 → 默认派给转单人本人(转工单即自办)
      assigneeUserId = req.user?.id || null;
      assigneeName = req.user?.name || req.user?.email || '';
    }

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

    const ticketResult = await withTransaction(async (tx) => {
      if (sourceType === 'content') {
        const lifecycle = await getRecordLifecycle({
          tenantId: req.tenantId,
          recordId: sourceId,
          tx,
          lock: true,
        });
        if (!lifecycle) return { notFound: true };
        if (lifecycle.archived_at) return { archived: true };
      }
      const row = await tx.queryOne(
        `INSERT INTO tickets (
           tenant_id, source_type, source_record_id, source_comment_id,
           platform, title, item_text, author, url, cover_url,
           category, priority, assignee_user_id, assignee_name,
           created_by_user_id, created_by_name, dispatch_note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${TICKET_COLUMNS}`,
        [
          req.tenantId, sourceType,
          sourceType === 'content' ? sourceId : null,
          sourceType === 'comment' ? sourceId : null,
          snap.platform || '', snap.title || '', snap.item_text || '', snap.author || '',
          snap.url || '', snap.cover_url || '',
          snap.category || '', priority || snap.src_priority || 'normal', assigneeUserId, assigneeName,
          req.user?.id || null, req.user?.name || req.user?.email || '', dispatchNote,
        ],
      );
      // 把源移出分诊队列:内容与评论统一标记为 ticketed(已转工单)
      if (sourceType === 'content') {
        const previousTriage = await tx.queryOne(
          `SELECT COALESCE(status, 'unhandled') AS status
           FROM record_triage WHERE tenant_id = $1 AND record_id = $2`,
          [req.tenantId, sourceId],
        );
        await tx.execute(
          `INSERT INTO record_triage (tenant_id, record_id, status, owner_user_id, owner_name, updated_at)
           VALUES ($1, $2, 'ticketed', $3, $4, now())
           ON CONFLICT (tenant_id, record_id)
           DO UPDATE SET status = 'ticketed', updated_at = now()`,
          [req.tenantId, sourceId, req.user?.id || null, req.user?.name || req.user?.email || ''],
        );
        await tx.execute(`
          INSERT INTO audit_logs (
            tenant_id, actor_type, actor_id, actor_user_id,
            action, target_type, target_id, metadata
          ) VALUES ($1, 'user', $2, $3, 'record.ticket_created', 'record', $4, $5::jsonb)
        `, [
          req.tenantId,
          req.user?.id || '',
          req.user?.id || null,
          sourceId,
          JSON.stringify({
            ticketId: row.id,
            previousStatus: previousTriage?.status || 'unhandled',
            nextStatus: 'ticketed',
            priority: row.priority,
            assigneeName: row.assignee_name,
            note: dispatchNote,
          }),
        ]);
      } else {
        await tx.execute(
          `UPDATE comment_leads SET status = 'ticketed', updated_at = now()
           WHERE id = $1 AND tenant_id = $2`,
          [sourceId, req.tenantId],
        );
      }
      return { ticket: row };
    });

    if (ticketResult.notFound) return res.status(404).json({ ok: false, error: 'not_found', message: '来源不存在' });
    if (ticketResult.archived) return sendRecordArchived(res, [sourceId]);
    return res.json({ ok: true, ticket: ticketResult.ticket });
  } catch (err) { return next(err); }
});

// ==================== 舆情处理(客服侧:工单队列)====================
router.get('/', requireTenantAccess, async (req, res, next) => {
  try {
    // status: 'open'=待处理(pending+doing 合并) / 'done' / 'dismissed';兼容单值
    const rawStatus = String(req.query.status || '');
    const status = rawStatus === 'open' ? 'open' : QUEUE_STATES.includes(rawStatus) ? rawStatus : '';
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
    if (status === 'open') { listWhere += ` AND status IN ('pending', 'doing')`; }
    else if (status) { listParams.push(status); listWhere += ` AND status = $${listParams.length}`; }

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
// view: progress=待处理(pending+doing) / closed=已结案 / 空=全部未关闭(review=旧版待确认,保留兼容)
router.get('/dispatched', requireTenantAccess, async (req, res, next) => {
  try {
    const view = String(req.query.view || '');
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));

    const counts = {
      review: (await queryOne(`SELECT COUNT(*)::int AS n FROM tickets WHERE tenant_id = $1 AND feedback_status = 'pending_review'`, [req.tenantId]))?.n || 0,
      progress: (await queryOne(`SELECT COUNT(*)::int AS n FROM tickets WHERE tenant_id = $1 AND status IN ('pending', 'doing')`, [req.tenantId]))?.n || 0,
      total: (await queryOne(`SELECT COUNT(*)::int AS n FROM tickets WHERE tenant_id = $1 AND status <> 'closed'`, [req.tenantId]))?.n || 0,
      closed: (await queryOne(`SELECT COUNT(*)::int AS n FROM tickets WHERE tenant_id = $1 AND status = 'closed'`, [req.tenantId]))?.n || 0,
    };

    const params = [req.tenantId];
    let where = `WHERE tenant_id = $1 AND status <> 'closed'`;
    if (view === 'closed') where = `WHERE tenant_id = $1 AND status = 'closed'`;
    else if (view === 'review') where += ` AND feedback_status = 'pending_review'`;
    else if (view === 'progress') where += ` AND status IN ('pending', 'doing')`;

    const total = (await queryOne(`SELECT COUNT(*)::int AS total FROM tickets ${where}`, params))?.total || 0;
    params.push(pageSize, (page - 1) * pageSize);
    const items = await queryAll(
      `SELECT ${TICKET_COLUMNS},
         (SELECT COUNT(*)::int FROM ticket_notes tn
          WHERE tn.ticket_id = tickets.id AND tn.tenant_id = tickets.tenant_id) AS notes_count,
         (SELECT tn.body FROM ticket_notes tn
          WHERE tn.ticket_id = tickets.id AND tn.tenant_id = tickets.tenant_id
          ORDER BY tn.created_at DESC, tn.id DESC LIMIT 1) AS latest_note,
         (SELECT tn.author_name FROM ticket_notes tn
          WHERE tn.ticket_id = tickets.id AND tn.tenant_id = tickets.tenant_id
          ORDER BY tn.created_at DESC, tn.id DESC LIMIT 1) AS latest_note_author,
         (SELECT tn.created_at FROM ticket_notes tn
          WHERE tn.ticket_id = tickets.id AND tn.tenant_id = tickets.tenant_id
          ORDER BY tn.created_at DESC, tn.id DESC LIMIT 1) AS latest_note_at
       FROM tickets ${where}
       ORDER BY (feedback_status = 'pending_review') DESC,
         CASE status WHEN 'doing' THEN 1 WHEN 'pending' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
         updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.json({ ok: true, items, counts, total, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (err) { return next(err); }
});

// ==================== 已转工单导出 Excel(按 view 过滤,与列表一致)====================
router.get('/export', requireTenantAccess, async (req, res, next) => {
  try {
    const view = String(req.query.view || '');
    let where = `WHERE t.tenant_id = $1 AND t.status <> 'closed'`;
    if (view === 'closed') where = `WHERE t.tenant_id = $1 AND t.status = 'closed'`;
    else if (view === 'progress') where += ` AND t.status IN ('pending', 'doing')`;
    // 关联原贴(评论工单经 comment_leads 回溯到 record),补点赞/评论数/发布时间作参考
    const items = await queryAll(
      `SELECT t.*, r.title AS post_title, r.author_name AS post_author,
              r.likes AS post_likes, r.comments_count AS post_comments, r.publish_time AS post_publish_time
       FROM tickets t
       LEFT JOIN comment_leads cl ON cl.id = t.source_comment_id AND cl.tenant_id = t.tenant_id
       LEFT JOIN records r ON r.tenant_id = t.tenant_id AND r.id = COALESCE(t.source_record_id, cl.record_id)
       ${where}
       ORDER BY (t.status = 'closed'), CASE t.status WHEN 'doing' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, t.updated_at DESC`,
      [req.tenantId],
    );
    // 过程备注:一次取全、按工单分组(与抽屉同源,时间正序),完整还原处理过程
    const ids = items.map((t) => t.id);
    const notesByTicket = {};
    if (ids.length) {
      const allNotes = await queryAll(
        `SELECT ticket_id, event_type, author_name, body, created_at FROM ticket_notes
         WHERE ticket_id = ANY($1::uuid[]) AND tenant_id = $2 ORDER BY created_at ASC`,
        [ids, req.tenantId],
      );
      const eventLabel = { note: '过程备注', closed: '结案', reopened: '重开' };
      for (const n of allNotes) {
        const label = eventLabel[n.event_type] || '过程记录';
        const body = n.body ? `：${n.body}` : '';
        (notesByTicket[n.ticket_id] ||= []).push(`${fmtTs(n.created_at)} ${n.author_name || ''} ${label}${body}`);
      }
    }
    const STATUS_CN = { pending: '待处理', doing: '处理中', done: '已处理', dismissed: '已忽略', closed: '已结案' };
    const PRIORITY_CN = { urgent: '紧急', high: '高', normal: '普通', low: '低' };
    const PLATFORM_CN = { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博' };
    const columns = [
      { header: '类型', key: 'type', width: 8 },
      { header: '平台', key: 'platform', width: 10 },
      { header: '工单内容', key: 'content', width: 44 },
      { header: '作者', key: 'author', width: 16 },
      { header: '原贴标题', key: 'postTitle', width: 28 },
      { header: '原贴点赞', key: 'postLikes', width: 9 },
      { header: '原贴评论', key: 'postComments', width: 9 },
      { header: '发布时间', key: 'publishTime', width: 16 },
      { header: '原文链接', key: 'url', width: 36 },
      { header: '优先级', key: 'priority', width: 8 },
      { header: '状态', key: 'status', width: 10 },
      { header: '处理人', key: 'assignee', width: 14 },
      { header: '转单人', key: 'dispatcher', width: 14 },
      { header: '转单说明', key: 'dispatchNote', width: 26 },
      { header: '处理过程', key: 'process', width: 50 },
      { header: '结案说明', key: 'closeNote', width: 28 },
      { header: '结案时间', key: 'closedAt', width: 18 },
      { header: '创建时间', key: 'createdAt', width: 18 },
    ];
    const rows = items.map((t) => ({
      type: t.source_type === 'comment' ? '评论' : '内容',
      platform: PLATFORM_CN[t.platform] || t.platform || '',
      content: t.item_text || t.title || '',
      author: t.author || '',
      postTitle: t.post_title || (t.source_type === 'content' ? t.title : '') || '',
      postLikes: t.post_likes ?? '',
      postComments: t.post_comments ?? '',
      publishTime: t.post_publish_time || '',
      url: t.url || '',
      priority: PRIORITY_CN[t.priority] || t.priority || '',
      status: STATUS_CN[t.status] || t.status || '',
      assignee: t.assignee_name || t.handled_by_name || t.created_by_name || '',
      dispatcher: t.created_by_name || '',
      dispatchNote: t.dispatch_note || '',
      process: (notesByTicket[t.id] || []).join('\n'),
      closeNote: t.handle_note || '',
      closedAt: t.status === 'closed' ? fmtTs(t.reviewed_at || t.handled_at) : '',
      createdAt: fmtTs(t.created_at),
    }));
    await sendXlsx(res, { sheetName: '已转工单', columns, rows, filename: `已转工单_${fmtTs(new Date()).slice(0, 10)}.xlsx` });
  } catch (err) { return next(err); }
});

// ==================== 可指派成员(本租户在职、有写权限的成员)====================
router.get('/assignees', requireTenantAccess, async (req, res, next) => {
  try {
    const items = await queryAll(
      `SELECT u.id AS "userId", COALESCE(NULLIF(u.name, ''), u.email) AS name, u.email, m.role
       FROM user_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND m.status = 'active' AND u.status = 'active'
         AND m.role IN ('tenant_admin', 'tenant_analyst')
       ORDER BY u.name`,
      [req.tenantId],
    );
    return res.json({ ok: true, items });
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
    let comments = [];
    let officialResponses = [];
    let observations = [];
    if (recordId) {
      record = await queryOne(
        `SELECT id, platform, record_type, title, content, author_name, author_fans, blogger_profile_url,
                url, cover_url, cover_local, image_urls, image_local_urls, note_type, video_url,
                sentiment, category, source_type, identity_override, ai_summary, ai_result,
                negative_comment_count, latest_negative_comment_at, official_response_status,
                likes, comments_count, collects, shares, publish_time, publish_location, keyword,
                first_seen_at, last_seen_at, seen_count, created_at
         FROM records WHERE id = $1 AND tenant_id = $2`,
        [recordId, req.tenantId],
      );
      if (record) {
        record.publish_display = formatPublishDate(record.publish_time, record.created_at);
        [comments, officialResponses, observations] = await Promise.all([
          getRecordComments(req.tenantId, recordId),
          getOfficialResponses(req.tenantId, recordId),
          queryAll(
            `SELECT id, likes, comments_count, collects, shares, captured_at
             FROM record_observations
             WHERE record_id = $1 AND tenant_id = $2
             ORDER BY captured_at DESC LIMIT 20`,
            [recordId, req.tenantId],
          ),
        ]);
        comments.forEach(item => {
          item.publish_display = formatPublishDate(item.published_at, item.created_at);
        });
      }
    }
    // 过程记录(备注 / 结案 / 重开),按时间正序
    const notes = await queryAll(
      `SELECT id, event_type, body, author_name, created_at FROM ticket_notes
       WHERE ticket_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [req.params.id, req.tenantId],
    );
    return res.json({ ok: true, record, comment, comments, officialResponses, observations, notes });
  } catch (err) { return next(err); }
});

// ==================== 过程备注(就地处理留痕)====================
router.post('/:id/notes', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ ok: false, error: 'empty_body', message: '备注内容不能为空' });
    if (body.length > 2000) return res.status(400).json({ ok: false, error: 'body_too_long', message: '备注最多 2000 个字符' });
    const actor = req.user?.name || req.user?.email || '';
    const actorId = req.user?.id || null;

    const result = await withTransaction(async tx => {
      // 与结案动作串行化，避免状态检查后、写入前被另一请求结案。
      const ticket = await tx.queryOne(
        `SELECT id, status FROM tickets WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.tenantId],
      );
      if (!ticket) return { notFound: true };
      if (ticket.status === 'closed') return { closed: true };

      const note = await tx.queryOne(
        `INSERT INTO ticket_notes (tenant_id, ticket_id, event_type, body, author_user_id, author_name)
         VALUES ($1, $2, 'note', $3, $4, $5)
         RETURNING id, event_type, body, author_name, created_at`,
        [req.tenantId, req.params.id, body, actorId, actor],
      );

      // 首次留痕即视为开始处理:pending → doing
      if (ticket.status === 'pending') {
        await tx.execute(
          `UPDATE tickets SET status = 'doing', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [req.params.id, req.tenantId],
        );
      }
      return { note };
    });

    if (result.notFound) return res.status(404).json({ ok: false, error: 'not_found', message: '工单不存在' });
    if (result.closed) {
      return res.status(409).json({ ok: false, error: 'ticket_closed', message: '工单已结案，请重开后再添加进展' });
    }
    return res.json({ ok: true, note: result.note });
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
    } else if (action === 'close') {
      // 结案:就地一步到底(任何非 closed 状态都可结案)。
      // handled_* 只在尚未有处理人时落本人,已有则保留(不覆盖原始处理人/时间);
      // reviewed_* 与结案动作一起落本人。
      sets = {
        sql: `status = 'closed', feedback_status = 'confirmed',
              handle_note = COALESCE($P, handle_note),
              handle_result = COALESCE(NULLIF($P, ''), NULLIF(handle_result, ''), '已结案'),
              handled_by_user_id = CASE WHEN handled_at IS NULL THEN $P ELSE handled_by_user_id END,
              handled_by_name = CASE WHEN handled_at IS NULL THEN $P ELSE handled_by_name END,
              handled_at = COALESCE(handled_at, now()),
              reviewed_by_user_id = $P, reviewed_by_name = $P, reviewed_at = now(),
              updated_at = now()`,
        params: [note, result, actorId, actor, actorId, actor],
      };
    } else if (action === 'reopen') {
      // 重开后恢复为处理中。上一次结案会先固化到 ticket_notes,再清空当前结案快照。
      sets = {
        sql: `status = 'doing', feedback_status = 'reopened',
              review_note = COALESCE($P, ''),
              handle_result = '', handle_note = '',
              handled_by_user_id = NULL, handled_by_name = '', handled_at = NULL,
              reviewed_by_user_id = NULL, reviewed_by_name = '', reviewed_at = NULL,
              updated_at = now()`,
        params: [note],
      };
    } else {
      return res.status(400).json({ ok: false, error: 'invalid_action', message: '动作无效' });
    }

    const outcome = await withTransaction(async tx => {
      const current = await tx.queryOne(
        `SELECT ${TICKET_COLUMNS}, handled_by_user_id, reviewed_by_user_id
         FROM tickets WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.tenantId],
      );
      if (!current) return { notFound: true };
      if (action === 'reopen' && current.status !== 'closed') return { invalidState: 'not_closed' };
      if (action !== 'reopen' && current.status === 'closed') return { invalidState: 'closed' };

      // 兼容迁移前已经结案的工单:首次重开时补一条历史结案事件,避免清空快照后丢记录。
      if (action === 'reopen') {
        const closeEvent = await tx.queryOne(
          `SELECT id FROM ticket_notes
           WHERE ticket_id = $1 AND tenant_id = $2 AND event_type = 'closed'
           ORDER BY created_at DESC LIMIT 1`,
          [req.params.id, req.tenantId],
        );
        if (!closeEvent) {
          const closeBody = current.handle_note || (current.handle_result === '已结案' ? '' : current.handle_result) || '';
          await tx.queryOne(
            `INSERT INTO ticket_notes (
               tenant_id, ticket_id, event_type, body, author_user_id, author_name, created_at
             ) VALUES ($1, $2, 'closed', $3, $4, $5, COALESCE($6::timestamptz, now()))
             RETURNING id`,
            [
              req.tenantId,
              req.params.id,
              closeBody,
              current.reviewed_by_user_id || current.handled_by_user_id || null,
              current.reviewed_by_name || current.handled_by_name || '',
              current.reviewed_at || current.handled_at || current.updated_at || null,
            ],
          );
        }
      }

      // 把 $P 占位替换为 $1..$n
      const vals = [...sets.params, req.params.id, req.tenantId];
      let i = 0;
      const setSql = sets.sql.replace(/\$P/g, () => `$${++i}`);
      const row = await tx.queryOne(
        `UPDATE tickets SET ${setSql}
         WHERE id = $${i + 1} AND tenant_id = $${i + 2}
         RETURNING ${TICKET_COLUMNS}`,
        vals,
      );

      if (action === 'close' || action === 'reopen') {
        const eventType = action === 'close' ? 'closed' : 'reopened';
        const eventBody = action === 'close'
          ? (note || (result && result !== '已结案' ? result : '') || '')
          : (note || '');
        await tx.queryOne(
          `INSERT INTO ticket_notes (tenant_id, ticket_id, event_type, body, author_user_id, author_name)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [req.tenantId, req.params.id, eventType, eventBody, actorId, actor],
        );
      }
      return { row };
    });

    if (outcome.notFound) return res.status(404).json({ ok: false, error: 'not_found', message: '工单不存在' });
    if (outcome.invalidState === 'not_closed') {
      return res.status(409).json({ ok: false, error: 'ticket_not_closed', message: '只有已结案工单可以重开' });
    }
    if (outcome.invalidState === 'closed') {
      return res.status(409).json({ ok: false, error: 'ticket_closed', message: '工单已结案，请先重开' });
    }
    return res.json({ ok: true, ticket: outcome.row });
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
