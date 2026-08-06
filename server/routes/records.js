import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import {
  isTenantWriter,
  requireSessionUser,
  requireTenantAccess,
  requireTenantWriter,
} from '../middleware/auth.js';
import { getOfficialResponses, getRecordComments } from '../services/comment-workflow.js';
import { collectRecordMediaUrls, isAllowedMediaHost, streamMediaToResponse } from '../services/media-proxy.js';
import {
  applyRecordCustomTagPatch,
  validateCustomTagPatch,
} from '../services/record-custom-tags.js';
import { insertRecordFeedback, normalizeFeedbackReason } from '../services/record-feedback.js';
import { startTranscription } from '../services/transcription.js';
import { analyzeTranscript } from '../services/transcript-analysis.js';
import {
  extractRecordImageText,
  ImageTextExtractionError,
  validateImageTextRequest,
} from '../services/image-text-extraction.js';
import { formatPublishDate } from '../services/publish-date.js';
import { getRecordLifecycle, sendRecordArchived } from '../services/record-lifecycle.js';

const router = Router();

const MANUAL_SENTIMENTS = new Set(['positive', 'neutral', 'negative']);
const MANUAL_CATEGORIES = new Set([
  'safety_rescue', 'feature_usage', 'renewal_billing', 'privacy',
  'app_issue', 'service_quality', 'brand_image', 'other',
]);
const MANUAL_IDENTITIES = new Set(['', 'user', 'kol', 'dealer', 'koe', 'other']);
const MANUAL_INPUT_KEYS = new Set(['sentiment', 'category', 'identityOverride', 'publishTime', 'reason']);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validDateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateManualFields(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_request', message: '请求内容无效' };
  }
  const unknown = Object.keys(body).filter(key => !MANUAL_INPUT_KEYS.has(key));
  if (unknown.length) {
    return { ok: false, error: 'unsupported_fields', message: `不支持修改字段: ${unknown.join(', ')}` };
  }

  const values = {};
  const providedFields = [];
  if (hasOwn(body, 'sentiment')) {
    const sentiment = String(body.sentiment || '').trim();
    if (!MANUAL_SENTIMENTS.has(sentiment)) {
      return { ok: false, error: 'invalid_sentiment', message: '情感值无效' };
    }
    values.sentiment = sentiment;
    providedFields.push('sentiment');
  }
  if (hasOwn(body, 'category')) {
    const category = String(body.category || '').trim();
    if (!MANUAL_CATEGORIES.has(category)) {
      return { ok: false, error: 'invalid_category', message: '内容分类无效' };
    }
    values.category = category;
    providedFields.push('category');
  }
  if (hasOwn(body, 'identityOverride')) {
    const identityOverride = String(body.identityOverride ?? '').trim();
    if (!MANUAL_IDENTITIES.has(identityOverride)) {
      return { ok: false, error: 'invalid_identity', message: '身份值无效' };
    }
    values.identityOverride = identityOverride;
    providedFields.push('identityOverride');
  }
  if (hasOwn(body, 'publishTime')) {
    const publishTime = String(body.publishTime ?? '').trim();
    if (publishTime && !validDateOnly(publishTime)) {
      return { ok: false, error: 'invalid_publish_time', message: '发布日期需为 YYYY-MM-DD 格式' };
    }
    values.publishTime = publishTime;
    providedFields.push('publishTime');
  }
  if (providedFields.length === 0) {
    return { ok: false, error: 'empty_update', message: '没有要更新的字段' };
  }

  const reasonResult = normalizeFeedbackReason(body.reason, { required: false });
  if (!reasonResult.ok) return reasonResult;
  return { ok: true, values, providedFields, reason: reasonResult.value };
}

export function publishTimestampFromDate(value) {
  const date = String(value || '').trim();
  return date ? new Date(`${date}T00:00:00+08:00`).toISOString() : null;
}

// 人工判断保存只回传页面需要的轻量字段。records.payload / ai_result / 图片等字段
// 可能达到数十 KB，写入已经提交后若大响应在客户端中断，会让页面误以为保存失败。
export function manualFieldsRecordResponse(record = {}) {
  return {
    id: record.id || null,
    sentiment: String(record.sentiment || ''),
    category: String(record.category || ''),
    identity_override: String(record.identity_override || ''),
    publish_time: String(record.publish_time || ''),
    published_ts: record.published_ts || null,
    publish_display: formatPublishDate(record.publish_time, record.created_at),
    manual_updated_by: record.manual_updated_by || null,
    manual_updated_name: String(record.manual_updated_name || ''),
    manual_updated_at: record.manual_updated_at || null,
    updated_at: record.updated_at || null,
  };
}

const RECORD_TABLE_TYPES = {
  single_notes: ['single_note', ''],
  keyword_notes: ['keyword_notes', 'keyword'],
  blogger_profiles: ['blogger_profile'],
  blogger_notes: ['blogger_notes'],
};

function tablePagination(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function appendCommonRecordFilters({ where, params, query }) {
  if (query.platform) {
    params.push(query.platform);
    where += ` AND platform = $${params.length}`;
  }
  if (query.keyword) {
    const kw = `%${String(query.keyword).trim()}%`;
    params.push(kw, kw, kw, kw);
    where += ` AND (
      title ILIKE $${params.length - 3}
      OR content ILIKE $${params.length - 2}
      OR author_name ILIKE $${params.length - 1}
      OR keyword ILIKE $${params.length}
    )`;
  }
  return where;
}

// 日期区间过滤(可切维度)。cols 给出三档对应的列表达式(已含别名),取自白名单,无注入。
//   basis: publish(默认) / recent(最近采集) / first(首次采集)
function appendDateRangeFilter({ where, params, query, cols }) {
  const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(query.dateFrom || '')) ? query.dateFrom : '';
  const dTo = /^\d{4}-\d{2}-\d{2}$/.test(String(query.dateTo || '')) ? query.dateTo : '';
  if (!dFrom && !dTo) return where;
  const basis = String(query.dateBasis || 'publish');
  const col = basis === 'first' ? cols.first : basis === 'recent' ? cols.recent : cols.publish;
  if (dFrom) { params.push(dFrom); where += ` AND ${col} >= $${params.length}::date`; }
  if (dTo) { params.push(dTo); where += ` AND ${col} < ($${params.length}::date + INTERVAL '1 day')`; }
  return where;
}

async function listRecordTable(req, table) {
  const types = RECORD_TABLE_TYPES[table];
  const { page, pageSize, offset } = tablePagination(req.query);
  const params = [req.tenantId, types];
  let where = "WHERE tenant_id = $1 AND COALESCE(record_type, '') = ANY($2)";
  where = appendCommonRecordFilters({ where, params, query: req.query });
  where = appendDateRangeFilter({ where, params, query: req.query, cols: { publish: 'published_ts', first: 'first_seen_at', recent: 'last_seen_at' } });
  const total = (await queryOne(`SELECT COUNT(*) AS total FROM records ${where}`, params))?.total || 0;
  params.push(pageSize, offset);
  const rows = await queryAll(`
    SELECT *
    FROM records
    ${where}
    ORDER BY created_at DESC, last_seen_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  return { rows, pagination: { page, pageSize, total: Number(total || 0), totalPages: Math.ceil(Number(total || 0) / pageSize) } };
}

async function listCommentLeadTable(req) {
  const { page, pageSize, offset } = tablePagination(req.query);
  const params = [req.tenantId];
  let where = 'WHERE cl.tenant_id = $1';
  if (req.query.platform) {
    params.push(req.query.platform);
    where += ` AND cl.platform = $${params.length}`;
  }
  if (req.query.keyword) {
    const kw = `%${String(req.query.keyword).trim()}%`;
    params.push(kw, kw, kw, kw);
    where += ` AND (
      cl.record_title ILIKE $${params.length - 3}
      OR cl.comment_content ILIKE $${params.length - 2}
      OR cl.comment_author_name ILIKE $${params.length - 1}
      OR cl.comment_ip_location ILIKE $${params.length}
    )`;
  }
  where = appendDateRangeFilter({ where, params, query: req.query, cols: { publish: 'cl.comment_published_ts', first: 'rc.first_seen_at', recent: 'rc.last_seen_at' } });
  const joins = `
    FROM comment_leads cl
    LEFT JOIN record_comments rc ON rc.id = cl.comment_id AND rc.tenant_id = cl.tenant_id
    LEFT JOIN records r ON r.id = cl.record_id AND r.tenant_id = cl.tenant_id
  `;
  const total = (await queryOne(`SELECT COUNT(*) AS total ${joins} ${where}`, params))?.total || 0;
  params.push(pageSize, offset);
  const rows = await queryAll(`
    SELECT
      cl.*,
      rc.payload AS comment_payload,
      rc.author_avatar AS comment_author_avatar,
      r.blogger_profile_url,
      r.keyword AS record_keyword,
      r.payload AS record_payload
    ${joins}
    ${where}
    ORDER BY cl.captured_at DESC, cl.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  return { rows, pagination: { page, pageSize, total: Number(total || 0), totalPages: Math.ceil(Number(total || 0) / pageSize) } };
}

async function listMonitorContentTable(req) {
  const { page, pageSize, offset } = tablePagination(req.query);
  const params = [req.tenantId];
  let where = `
    WHERE ro.tenant_id = $1
      AND ro.monitor_execution_id IS NOT NULL
  `;
  if (req.query.platform) {
    params.push(req.query.platform);
    where += ` AND r.platform = $${params.length}`;
  }
  if (req.query.keyword) {
    const kw = `%${String(req.query.keyword).trim()}%`;
    params.push(kw, kw, kw, kw);
    where += ` AND (
      r.title ILIKE $${params.length - 3}
      OR r.content ILIKE $${params.length - 2}
      OR r.author_name ILIKE $${params.length - 1}
      OR COALESCE(ms.keyword, ro.keyword, r.keyword, '') ILIKE $${params.length}
    )`;
  }
  where = appendDateRangeFilter({ where, params, query: req.query, cols: { publish: 'r.published_ts', first: 'r.first_seen_at', recent: 'r.last_seen_at' } });
  const joins = `
    FROM record_observations ro
    JOIN records r ON r.id = ro.record_id AND r.tenant_id = ro.tenant_id
    LEFT JOIN monitor_executions me ON me.id = ro.monitor_execution_id AND me.tenant_id = ro.tenant_id
    LEFT JOIN monitor_subscriptions ms ON ms.id = me.subscription_id AND ms.tenant_id = ro.tenant_id
  `;
  const rankedCte = `
    WITH ranked_monitor_content AS (
      SELECT
        r.*,
        ro.id AS observation_id,
        ro.captured_at AS monitor_captured_at,
        ro.keyword AS monitor_hit_keyword,
        ro.rank_position AS monitor_rank_position,
        ro.interaction_total AS monitor_interaction_total,
        ms.id AS monitor_subscription_id,
        ms.name AS monitor_name,
        ms.keyword AS monitor_keyword,
        ms.account_url AS monitor_account_url,
        ROW_NUMBER() OVER (
          PARTITION BY ro.tenant_id, ro.record_id, me.subscription_id
          ORDER BY ro.captured_at DESC, ro.id DESC
        ) AS monitor_observation_rank
      ${joins}
      ${where}
    )
  `;
  const total = (await queryOne(`
    ${rankedCte}
    SELECT COUNT(*) AS total
    FROM ranked_monitor_content
    WHERE monitor_observation_rank = 1
  `, params))?.total || 0;
  params.push(pageSize, offset);
  const rows = await queryAll(`
    ${rankedCte}
    SELECT *
    FROM ranked_monitor_content
    WHERE monitor_observation_rank = 1
    ORDER BY monitor_captured_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  return { rows, pagination: { page, pageSize, total: Number(total || 0), totalPages: Math.ceil(Number(total || 0) / pageSize) } };
}

async function ensureRecord(req, res) {
  const record = await queryOne(
    'SELECT id FROM records WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (!record) {
    res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    return false;
  }
  return true;
}

router.get('/:id/observations', requireTenantAccess, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const observations = await queryAll(
      'SELECT * FROM record_observations WHERE record_id = $1 AND tenant_id = $2 ORDER BY captured_at DESC',
      [req.params.id, req.tenantId]
    );
    return res.json({ ok: true, observations });
  } catch (err) {
    return next(err);
  }
});

router.get('/tables/:table', requireTenantAccess, async (req, res, next) => {
  try {
    const table = String(req.params.table || '');
    let result;
    if (RECORD_TABLE_TYPES[table]) {
      result = await listRecordTable(req, table);
    } else if (table === 'comment_leads') {
      result = await listCommentLeadTable(req);
    } else if (table === 'monitor_content') {
      result = await listMonitorContentTable(req);
    } else {
      return res.status(404).json({ ok: false, error: 'unknown_table', message: '数据表不存在' });
    }
    return res.json({ ok: true, table, ...result });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/versions', requireTenantAccess, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const versions = await queryAll(
      'SELECT * FROM record_versions WHERE record_id = $1 AND tenant_id = $2 ORDER BY created_at DESC',
      [req.params.id, req.tenantId]
    );
    return res.json({ ok: true, versions });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/manual-history', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const history = await queryAll(`
      SELECT
        rf.id,
        rf.original_values,
        rf.corrected_values,
        COALESCE(NULLIF(rf.submitted_by_name, ''), NULLIF(u.name, ''), u.email, '未知用户') AS submitted_by_name,
        rf.submitted_at
      FROM record_feedback rf
      LEFT JOIN users u ON u.id = rf.submitted_by_user_id
      WHERE rf.record_id = $1
        AND rf.tenant_id = $2
        AND rf.feedback_type = 'manual_correction'
      ORDER BY rf.submitted_at DESC, rf.id DESC
      LIMIT 100
    `, [req.params.id, req.tenantId]);
    return res.json({ ok: true, history });
  } catch (err) {
    return next(err);
  }
});

// 保存响应途中断线时，前端用当前轻量状态确认事务是否已经提交，避免重复修改。
router.get('/:id/manual-fields', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  try {
    const record = await queryOne(`
      SELECT
        id, sentiment, category, identity_override,
        publish_time, published_ts, created_at,
        manual_updated_by, manual_updated_name, manual_updated_at, updated_at
      FROM records
      WHERE id = $1 AND tenant_id = $2
    `, [req.params.id, req.tenantId]);
    if (!record) {
      return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    }
    return res.json({ ok: true, record: manualFieldsRecordResponse(record) });
  } catch (err) {
    return next(err);
  }
});

// 内容处理时间线：只汇总人工判断、模式、归档、标签、工单等客户处置记录与追加备注。
// 系统事件继续保留在 audit_logs 供内部审计，但不混入客户处理记录；采集快照另留 observations。
router.get('/:id/activity', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const [audits, notes, ticketActivities, legacyTriage] = await Promise.all([
      queryAll(`
        SELECT
          al.id,
          al.action,
          al.metadata,
          COALESCE(NULLIF(u.name, ''), u.email, NULLIF(al.actor_id, ''), '系统') AS actor_name,
          al.created_at
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.actor_user_id
        WHERE al.tenant_id = $2
          AND al.target_type = 'record'
          AND al.actor_type = 'user'
          AND al.action <> 'record.note_added'
          AND (
            al.target_id = $1
            OR COALESCE(al.metadata->'recordIds', '[]'::jsonb) ? $1
          )
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT 200
      `, [req.params.id, req.tenantId]),
      queryAll(`
        SELECT
          rn.id,
          rn.body,
          COALESCE(NULLIF(rn.author_name, ''), NULLIF(u.name, ''), u.email, '未知用户') AS actor_name,
          rn.created_at
        FROM record_notes rn
        LEFT JOIN users u ON u.id = rn.author_user_id
        WHERE rn.record_id = $1 AND rn.tenant_id = $2
        ORDER BY rn.created_at DESC, rn.id DESC
        LIMIT 200
      `, [req.params.id, req.tenantId]),
      queryAll(`
        SELECT
          tn.id,
          tn.event_type,
          tn.body,
          COALESCE(NULLIF(tn.author_name, ''), NULLIF(u.name, ''), u.email, '未知用户') AS actor_name,
          tn.created_at,
          t.id AS ticket_id,
          t.external_ticket_no,
          t.status AS ticket_status
        FROM ticket_notes tn
        JOIN tickets t
          ON t.id = tn.ticket_id
          AND t.tenant_id = tn.tenant_id
        LEFT JOIN users u ON u.id = tn.author_user_id
        WHERE t.source_record_id = $1
          AND t.tenant_id = $2
          AND t.source_type = 'content'
        ORDER BY tn.created_at DESC, tn.id DESC
        LIMIT 200
      `, [req.params.id, req.tenantId]),
      queryOne(`
        SELECT id, note, owner_name, updated_at
        FROM record_triage
        WHERE record_id = $1 AND tenant_id = $2 AND btrim(note) <> ''
      `, [req.params.id, req.tenantId]),
    ]);

    const legacyNoteCovered = legacyTriage && audits.some(item => {
      const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
      return [metadata.note, metadata.reason].some(value => String(value || '').trim() === String(legacyTriage.note || '').trim());
    });
    const activity = [
      ...audits.map(item => ({ ...item, metadata: item.metadata || {} })),
      ...notes.map(item => ({
        id: item.id,
        action: 'record.note_added',
        metadata: { body: item.body },
        actor_name: item.actor_name,
        created_at: item.created_at,
      })),
      ...ticketActivities.map(item => ({
        id: `ticket-${item.id}`,
        action: item.event_type === 'closed'
          ? 'record.ticket_closed'
          : item.event_type === 'reopened'
            ? 'record.ticket_reopened'
            : item.event_type === 'done'
              ? 'record.ticket_done'
              : item.event_type === 'dismissed'
                ? 'record.ticket_dismissed'
            : 'record.ticket_progress_added',
        metadata: {
          body: item.body,
          ticketId: item.ticket_id,
          externalTicketNo: item.external_ticket_no,
          ticketStatus: item.ticket_status,
        },
        actor_name: item.actor_name,
        created_at: item.created_at,
      })),
      ...(legacyTriage && !legacyNoteCovered ? [{
        id: `legacy-${legacyTriage.id}`,
        action: 'record.legacy_triage_note',
        metadata: { body: legacyTriage.note },
        actor_name: legacyTriage.owner_name || '历史处理人',
        created_at: legacyTriage.updated_at,
      }] : []),
    ]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 200);

    return res.json({ ok: true, activity });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/notes', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ ok: false, error: 'empty_body', message: '备注内容不能为空' });
    }
    if (body.length > 2000) {
      return res.status(400).json({ ok: false, error: 'body_too_long', message: '备注最多 2000 个字符' });
    }

    const note = await withTransaction(async tx => {
      const lifecycle = await getRecordLifecycle({
        tenantId: req.tenantId,
        recordId: req.params.id,
        tx,
        lock: true,
      });
      if (!lifecycle) return null;
      if (lifecycle.archived_at) return { archived: true };
      const inserted = await tx.queryOne(`
        INSERT INTO record_notes (
          tenant_id, record_id, body, author_user_id, author_name
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id, body, author_user_id, author_name, created_at
      `, [
        req.tenantId,
        lifecycle.id,
        body,
        req.user?.id || null,
        req.actorName || req.user?.name || req.user?.email || '',
      ]);
      await tx.execute(`
        INSERT INTO audit_logs (
          tenant_id, actor_type, actor_id, actor_user_id,
          action, target_type, target_id, metadata
        ) VALUES ($1, 'user', $2, $3, 'record.note_added', 'record', $4, $5::jsonb)
      `, [
        req.tenantId,
        req.user?.id || '',
        req.user?.id || null,
        lifecycle.id,
        JSON.stringify({ noteId: inserted.id }),
      ]);
      return inserted;
    });

    if (!note) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    if (note.archived) return sendRecordArchived(res, [req.params.id]);
    return res.json({ ok: true, note });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/comments', requireTenantAccess, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const comments = await getRecordComments(req.tenantId, req.params.id);
    const officialResponses = await getOfficialResponses(req.tenantId, req.params.id);
    comments.forEach(c => { c.publish_display = formatPublishDate(c.published_at, c.created_at); });
    return res.json({ ok: true, comments, officialResponses });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/manual-fields', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const validated = validateManualFields(req.body || {});
    if (!validated.ok) {
      return res.status(400).json({ ok: false, error: validated.error, message: validated.message });
    }

    const actorUserId = req.user?.id || null;
    const actorName = req.actorName || req.user?.name || req.user?.email || '';
    const updatedAt = new Date().toISOString();

    const result = await withTransaction(async tx => {
      const lifecycle = await getRecordLifecycle({
        tenantId: req.tenantId,
        recordId: req.params.id,
        tx,
        lock: true,
      });
      if (!lifecycle) return null;
      if (lifecycle.archived_at) return { archived: true };
      const record = await tx.queryOne(
        'SELECT * FROM records WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.tenantId],
      );

      const changedFields = [];
      const originalValues = {};
      const correctedValues = {};
      const overridePatch = {};
      const values = validated.values;

      const addChange = (field, before, after) => {
        changedFields.push(field);
        originalValues[field] = before ?? null;
        correctedValues[field] = after ?? null;
        overridePatch[field] = {
          value: after ?? null,
          updatedByUserId: actorUserId,
          updatedByName: actorName,
          updatedAt,
          reason: validated.reason,
        };
      };

      if (validated.providedFields.includes('sentiment') && String(record.sentiment || '') !== values.sentiment) {
        addChange('sentiment', record.sentiment || '', values.sentiment);
      }
      if (validated.providedFields.includes('category') && String(record.category || '') !== values.category) {
        addChange('category', record.category || '', values.category);
      }
      if (validated.providedFields.includes('identityOverride')
        && String(record.identity_override || '') !== values.identityOverride) {
        addChange('identity_override', record.identity_override || '', values.identityOverride);
      }

      let publishedTs = record.published_ts || null;
      if (validated.providedFields.includes('publishTime')) {
        publishedTs = publishTimestampFromDate(values.publishTime);
        const currentPublishedTs = record.published_ts ? new Date(record.published_ts).toISOString() : null;
        if (String(record.publish_time || '') !== values.publishTime || currentPublishedTs !== publishedTs) {
          addChange('publish_time', record.publish_time || '', values.publishTime);
          changedFields.push('published_ts');
          originalValues.published_ts = record.published_ts || null;
          correctedValues.published_ts = publishedTs;
        }
      }

      if (changedFields.length === 0) {
        return { record, feedbackId: null, changedFields: [], unchanged: true };
      }

      const updateSentiment = changedFields.includes('sentiment');
      const updateCategory = changedFields.includes('category');
      const updateIdentity = changedFields.includes('identity_override');
      const updatePublish = changedFields.includes('publish_time');
      const clearIdentityOverride = updateIdentity && values.identityOverride === '';
      if (clearIdentityOverride) delete overridePatch.identity_override;
      const updated = await tx.queryOne(`
        UPDATE records
        SET sentiment = CASE WHEN $3 THEN $4 ELSE sentiment END,
          category = CASE WHEN $5 THEN $6 ELSE category END,
          identity_override = CASE WHEN $7 THEN $8 ELSE identity_override END,
          publish_time = CASE WHEN $9 THEN $10 ELSE publish_time END,
          published_ts = CASE WHEN $9 THEN $11::timestamptz ELSE published_ts END,
          manual_overrides = (
            CASE
              WHEN $15 THEN COALESCE(manual_overrides, '{}'::jsonb) - 'identity_override'
              ELSE COALESCE(manual_overrides, '{}'::jsonb)
            END
          ) || $12::jsonb,
          manual_updated_by = $13,
          manual_updated_name = $14,
          manual_updated_at = now(),
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *
      `, [
        req.params.id,
        req.tenantId,
        updateSentiment,
        values.sentiment || '',
        updateCategory,
        values.category || '',
        updateIdentity,
        values.identityOverride ?? '',
        updatePublish,
        values.publishTime ?? '',
        publishedTs,
        JSON.stringify(overridePatch),
        actorUserId,
        actorName,
        clearIdentityOverride,
      ]);

      await tx.execute(`
        INSERT INTO record_versions (tenant_id, record_id, changed_fields, before_data, after_data)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      `, [
        req.tenantId,
        record.id,
        changedFields,
        JSON.stringify(originalValues),
        JSON.stringify(correctedValues),
      ]);

      const feedback = await insertRecordFeedback(tx, {
        tenantId: req.tenantId,
        record,
        feedbackType: 'manual_correction',
        reason: validated.reason,
        originalValues,
        correctedValues,
        actorUserId,
        actorName,
      });

      await tx.execute(`
        INSERT INTO audit_logs (
          tenant_id, actor_type, actor_id, actor_user_id,
          action, target_type, target_id, metadata
        ) VALUES ($1, 'user', $2, $3, 'record.manual_fields_updated', 'record', $4, $5::jsonb)
      `, [
        req.tenantId,
        actorUserId || '',
        actorUserId,
        record.id,
        JSON.stringify({
          changedFields,
          originalValues,
          correctedValues,
          reason: validated.reason,
          feedbackId: feedback.id,
        }),
      ]);

      return { record: updated, feedbackId: feedback.id, changedFields, unchanged: false };
    });

    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    if (result.archived) return sendRecordArchived(res, [req.params.id]);
    return res.json({
      ok: true,
      ...result,
      record: manualFieldsRecordResponse(result.record),
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/custom-tags', requireTenantAccess, requireSessionUser, requireTenantWriter, async (req, res, next) => {
  try {
    const patch = validateCustomTagPatch(req.body || {});
    if (!patch.ok) {
      return res.status(400).json({ ok: false, error: patch.error, message: patch.message });
    }

    const actorUserId = req.user?.id || null;
    const actorName = req.actorName || req.user?.name || req.user?.email || '';
    const result = await withTransaction(async tx => {
      const lifecycle = await getRecordLifecycle({
        tenantId: req.tenantId,
        recordId: req.params.id,
        tx,
        lock: true,
      });
      if (!lifecycle) return null;
      if (lifecycle.archived_at) return { archived: true };

      const changed = await applyRecordCustomTagPatch(tx, {
        tenantId: req.tenantId,
        recordId: lifecycle.id,
        patch,
        actorUserId,
        actorName,
      });

      if (!changed.unchanged) {
        await tx.execute(`
          INSERT INTO record_versions (
            tenant_id, record_id, changed_fields, before_data, after_data
          ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
        `, [
          req.tenantId,
          lifecycle.id,
          ['custom_tags'],
          JSON.stringify({ custom_tags: changed.before }),
          JSON.stringify({ custom_tags: changed.after }),
        ]);

        await tx.execute(`
          INSERT INTO audit_logs (
            tenant_id, actor_type, actor_id, actor_user_id,
            action, target_type, target_id, metadata
          ) VALUES ($1, 'user', $2, $3, 'record.custom_tags_updated', 'record', $4, $5::jsonb)
        `, [
          req.tenantId,
          actorUserId || '',
          actorUserId,
          lifecycle.id,
          JSON.stringify({
            added: changed.added,
            removed: changed.removed,
            before: changed.before,
            after: changed.after,
          }),
        ]);
      }

      return changed;
    });

    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    if (result.archived) return sendRecordArchived(res, [req.params.id]);
    return res.json({
      ok: true,
      custom_tags: result.after,
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
    });
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ ok: false, error: err.code, message: err.message });
    }
    return next(err);
  }
});

router.patch('/:id/official-response', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const status = String(req.body?.status || 'responded');
    const note = String(req.body?.note || '');
    const nextStatus = status === 'needs_followup' ? 'needs_followup' : 'responded';
    const result = await withTransaction(async tx => {
      const lifecycle = await getRecordLifecycle({
        tenantId: req.tenantId,
        recordId: req.params.id,
        tx,
        lock: true,
      });
      if (!lifecycle) return { notFound: true };
      if (lifecycle.archived_at) return { archived: true };
      const activeTicket = await tx.queryOne(`
        SELECT id, external_ticket_no
        FROM tickets
        WHERE tenant_id = $1
          AND source_type = 'content'
          AND source_record_id = $2
          AND status <> 'closed'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [req.tenantId, req.params.id]);
      if (activeTicket) return { activeTicket };
      const previous = await tx.queryOne(`
        SELECT r.official_response_status,
          COALESCE(rt.status, 'unhandled') AS triage_status
        FROM records r
        LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
        WHERE r.id = $1 AND r.tenant_id = $2
      `, [req.params.id, req.tenantId]);
      await tx.execute(`
        UPDATE records
        SET official_replied = true,
          official_response_status = $1,
          updated_at = now()
        WHERE id = $2 AND tenant_id = $3
      `, [nextStatus, req.params.id, req.tenantId]);
      await tx.execute(`
        INSERT INTO record_triage (tenant_id, record_id, status, priority, owner_user_id, owner_name, note, updated_at)
        VALUES ($1, $2, 'official_responded', 'normal', $3, $4, $5, now())
        ON CONFLICT (tenant_id, record_id)
        DO UPDATE SET status = 'official_responded',
          owner_user_id = excluded.owner_user_id,
          owner_name = excluded.owner_name,
          note = excluded.note,
          updated_at = now()
      `, [req.tenantId, req.params.id, req.user?.id || null, req.actorName || '', note]);
      await tx.execute(`
        INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES ($1, 'user', $2, $3, 'record.official_response_marked', 'record', $4, $5::jsonb)
      `, [req.tenantId, req.user?.id || '', req.user?.id || null, req.params.id, JSON.stringify({
        previousStatus: previous?.triage_status || 'unhandled',
        nextStatus: 'official_responded',
        previousOfficialStatus: previous?.official_response_status || 'none',
        nextOfficialStatus: nextStatus,
        note,
      })]);
      return { updated: true };
    });
    if (result.notFound) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    if (result.archived) return sendRecordArchived(res, [req.params.id]);
    if (result.activeTicket) {
      return res.status(409).json({
        ok: false,
        error: 'content_ticket_active',
        message: '工单结案前，处理模式须保留为“已转工单”',
        ticketId: result.activeTicket.id,
        externalTicketNo: result.activeTicket.external_ticket_no || '',
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * 媒体透明代理下载：server 带 Referer 抓取直链并流式转发，不落盘。
 * GET /api/records/:id/media-proxy?url=<媒体直链>&filename=<保存文件名>
 * 安全：校验记录属于当前租户、url 确实属于该记录、host 在白名单内（防 SSRF/越权）。
 */
router.get('/:id/media-proxy', requireTenantAccess, async (req, res, next) => {
  try {
    const url = String(req.query.url || '').trim();
    const filename = String(req.query.filename || 'attachment').trim() || 'attachment';
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: 'invalid_url', message: '缺少有效的媒体直链' });
    }
    if (!isAllowedMediaHost(url)) {
      return res.status(403).json({ ok: false, error: 'host_not_allowed', message: '该域名不在允许下载的列表内' });
    }

    const record = await queryOne(
      `SELECT id, platform, cover_url, image_urls, video_url, audio_url, payload
       FROM records WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (!record) {
      return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    }

    const allowed = collectRecordMediaUrls(record);
    if (!allowed.has(url)) {
      return res.status(403).json({ ok: false, error: 'url_not_in_record', message: '该直链不属于这条记录' });
    }

    return streamMediaToResponse({ url, filename, platform: record.platform, res });
  } catch (err) {
    return next(err);
  }
});

/**
 * 按需提取某一张内容图片（封面或正文图）里的文字。
 * 客户端只提交画廊提供的稳定图片标识，服务端按 tenant + record 重新校验归属，
 * 禁止任意 URL / Key / 模型透传。
 * 登录成员可使用；结果按图片内容哈希缓存，refresh=true 时才重新调用模型。
 */
router.post('/:id/image-text', requireTenantAccess, requireSessionUser, async (req, res, next) => {
  const input = validateImageTextRequest(req.body);
  if (!input.ok) {
    return res.status(400).json({
      ok: false,
      error: input.error,
      message: input.message,
    });
  }
  if (input.refresh && !isTenantWriter(req)) {
    return res.status(403).json({
      ok: false,
      error: 'refresh_forbidden',
      message: '当前账号不能重新识别图片',
    });
  }
  try {
    const result = await extractRecordImageText({
      tenantId: req.tenantId,
      recordId: req.params.id,
      imageRef: input.imageRef,
      refresh: input.refresh,
      actorUserId: req.user?.id || null,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof ImageTextExtractionError) {
      return res.status(error.status).json({
        ok: false,
        error: error.code,
        message: error.message,
      });
    }
    return next(error);
  }
});

/** 逐字稿状态查询(供前端轮询)。GET /api/records/:id/transcript */
router.get('/:id/transcript', requireTenantAccess, async (req, res, next) => {
  try {
    const row = await queryOne(
      `SELECT transcript_status, transcript, transcript_lang, transcript_error, transcript_updated_at,
              transcript_analysis, transcript_analysis_at
       FROM records WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId],
    );
    if (!row) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    return res.json({ ok: true, ...row });
  } catch (err) {
    return next(err);
  }
});

/**
 * 触发视频逐字稿转写(异步)。POST /api/records/:id/transcribe
 * 置 pending 并后台调百炼转写,前端轮询记录状态字段(transcript_status/transcript)。
 * 权限:与「下载附件」(media-proxy)一致用 requireTenantAccess——同为"从记录派生内容",
 * 任何能查看该记录的成员都可生成(非敏感写操作)。
 */
router.post('/:id/transcribe', requireTenantAccess, async (req, res, next) => {
  try {
    const lifecycle = await getRecordLifecycle({ tenantId: req.tenantId, recordId: req.params.id });
    if (!lifecycle) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    if (lifecycle.archived_at) return sendRecordArchived(res, [req.params.id]);
    const result = await startTranscription({ tenantId: req.tenantId, recordId: req.params.id });
    if (!result.ok && result.error === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * 对逐字稿做 AI 舆情分析(同步)。POST /api/records/:id/analyze-transcript
 * 需先有逐字稿;结果存 records.transcript_analysis,GET /transcript 一并返回。
 */
router.post('/:id/analyze-transcript', requireTenantAccess, async (req, res, next) => {
  try {
    const lifecycle = await getRecordLifecycle({ tenantId: req.tenantId, recordId: req.params.id });
    if (!lifecycle) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    if (lifecycle.archived_at) return sendRecordArchived(res, [req.params.id]);
    const result = await analyzeTranscript({ tenantId: req.tenantId, recordId: req.params.id });
    if (!result.ok && result.error === 'not_found') return res.status(404).json(result);
    if (!result.ok && result.error === 'no_transcript') return res.status(400).json(result);
    if (!result.ok) return res.status(502).json(result);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
