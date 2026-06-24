import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { getOfficialResponses, getRecordComments } from '../services/comment-workflow.js';
import { collectRecordMediaUrls, isAllowedMediaHost, streamMediaToResponse } from '../services/media-proxy.js';
import { startTranscription } from '../services/transcription.js';
import { analyzeTranscript } from '../services/transcript-analysis.js';
import { formatPublishDate } from '../services/publish-date.js';

const router = Router();

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

router.patch('/:id/official-response', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    if (!await ensureRecord(req, res)) return;
    const status = String(req.body?.status || 'responded');
    const note = String(req.body?.note || '');
    const nextStatus = status === 'needs_followup' ? 'needs_followup' : 'responded';
    await withTransaction(async tx => {
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
      `, [req.tenantId, req.user?.id || '', req.user?.id || null, req.params.id, JSON.stringify({ status: nextStatus, note })]);
    });
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
