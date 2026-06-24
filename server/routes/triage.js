import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { formatPublishDate } from '../services/publish-date.js';
import { sendXlsx, fmtTs } from '../services/xlsx-export.js';

const router = Router();

// 导出用中文标签映射(MAP[v]||v||'')
const PLATFORM_CN = { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博' };
const SENTIMENT_CN = { positive: '正面', neutral: '中性', negative: '负面' };
const TRIAGE_STATUS_CN = { unhandled: '待处理', reviewing: '处理中', issue_linked: '已关联事件', archived: '已归档', false_positive: '误报', official_responded: '官方已响应' };
const PRIORITY_CN = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const CATEGORY_CN = { safety_rescue: '安全救援', feature_usage: '功能使用', renewal_billing: '续费收费', privacy: '隐私安全', app_issue: 'App问题', service_quality: '服务质量', brand_image: '品牌形象', other: '其他' };
const NOTE_TYPE_CN = { image: '图文', video: '视频', normal: '图文' };
// 账号名带品牌/车型(全称·简称)= 品牌关联号(非真实车主)。⚠ 与 web/admin utils.ts 的同名正则保持一致。
const BRAND_MODEL_RE = /(安吉星|onstar|别克|凯迪拉克|凯迪|雪佛兰|buick|cadillac|chevrolet|上汽通用|君越|君威|昂科威|昂科拉|昂科旗|gl8|gl6|英朗|威朗|凯越|微蓝|velite|阅朗|ct4|ct5|ct6|xt4|xt5|xt6|锐歌|lyriq|凯雷德|科鲁兹|科沃兹|迈锐宝|创酷|创界|探界者|开拓者|沃兰多|星迈罗|赛欧|畅巡|景程)/i;
const DEALER_NAME_RE = /(4s|旗舰店|体验中心|服务中心|销售服务|特约|经销|汽贸)/i;

// 疑似身份:① 账号名带品牌/车型 → 像门店/经销(或 LLM 判经销)=4S店,否则 =KOE;
//          ② 名字不带品牌 → 按 LLM source_type;pgc(KOL)按粉丝分级(KOC<5万/初级<50万/中级<300万/头部≥300万)。空值导出「未判定」。
function identityLabel(sourceType, fans, name) {
  const nm = String(name || '');
  const st = String(sourceType || '');
  if (BRAND_MODEL_RE.test(nm)) {
    return (DEALER_NAME_RE.test(nm) || st === 'dealer') ? '4S店' : 'KOE';
  }
  if (st === 'dealer') return '4S店';
  if (st === 'employee') return 'KOE';
  if (st === 'ugc') return '用户';
  if (st === 'other') return '其他';
  if (st === 'pgc') {
    const f = Number(fans);
    if (!Number.isFinite(f) || f <= 0) return 'KOL';
    if (f < 50000) return 'KOC';
    if (f < 500000) return '初级KOL';
    if (f < 3000000) return '中级KOL';
    return '头部KOL';
  }
  return '未判定';
}

// 内部 ID(非「人看的号」):小红书 24 位 hex user_id / 抖音 sec_uid(MS4w 开头)。
// 这些不是小红书号/抖音号,导出绝不能冒充成用户ID(此前 bug:存量记录把它们当号导出)。
// 微博 /u/{uid} 是纯数字公开 uid(人能搜),保留。
function isInternalUid(v) {
  const s = String(v || '').trim();
  if (!s) return true;
  if (/^[0-9a-f]{24}$/i.test(s)) return true; // 小红书内部 user_id
  if (/^MS4w/i.test(s)) return true; // 抖音 sec_uid
  return false;
}

// 平台用户ID:只显示「人看的真号」(小红书号/抖音号)——可能在 account_no 列,也可能在
// payload 的 bloggerId/douyinId/redId 里。没有真号就留空,绝不退回内部 hex/sec_uid 假ID。
// (按用户要求:只留真ID,假ID一律不显示。)author_id / profileUrl 参数保留兼容调用,不再用作兜底。
function platformUserId(authorId, profileUrl, accountNo, payloadNo) {
  for (const cand of [accountNo, payloadNo]) {
    const v = String(cand || '').trim();
    if (v && !isInternalUid(v)) return v; // 真·人看的号(最准)
  }
  return ''; // 没有真号 → 空,不显示假ID
}

// 帖子链接:优先用采到的真实帖子URL(含 xsec_token,可直接打开);若那其实是主页/缺失,用 external_id 按平台重建。
function isNoteUrl(u) {
  const s = String(u || '');
  if (/\/user\/profile\/|\/user\//.test(s)) return false; // 主页不是帖子
  return /\/explore\/|\/discovery\/item\/|\/note\/|\/video\/|weibo\.com\/detail\/|m\.weibo\.cn\/|\/search_result\//.test(s);
}
function postUrl(r) {
  if (isNoteUrl(r.url)) return r.url;
  const id = String(r.external_id || '').trim();
  if (!id) return r.url || '';
  if (r.platform === 'xiaohongshu') return `https://www.xiaohongshu.com/explore/${id}`;
  if (r.platform === 'douyin') return r.note_type === 'image' ? `https://www.douyin.com/note/${id}` : `https://www.douyin.com/video/${id}`;
  if (r.platform === 'weibo') return `https://weibo.com/detail/${id}`;
  return r.url || '';
}

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

// 列表排序:发布时间 / 互动量可点表头切换升降序;默认(空 sort)走风险优先序。
function orderBySql(sort, dir) {
  const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (sort === 'publish') return `r.published_ts ${d} NULLS LAST, r.last_seen_at DESC`;
  if (sort === 'interactions') return `(r.likes + r.comments_count + r.collects + r.shares) ${d} NULLS LAST, r.published_ts DESC NULLS LAST`;
  if (sort === 'first_seen') return `r.first_seen_at ${d} NULLS LAST, r.last_seen_at DESC`;
  if (sort === 'last_seen') return `r.last_seen_at ${d} NULLS LAST, r.first_seen_at DESC`;
  return riskOrderSql();
}

// 风险信号多选筛选(有预警 / 有负评),命中任一即入选(OR)。条件为字面 SQL,不绑定参数。
// 注:作者身份(原"疑似KOE")已从风险信号拆出,改为独立的「疑似身份」维度(见 identityWhereClause)。
function riskWhereClause(reqRisk) {
  const risks = (Array.isArray(reqRisk) ? reqRisk : String(reqRisk || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  const clauses = [];
  if (risks.includes('alert')) clauses.push(`EXISTS (SELECT 1 FROM alerts a WHERE a.record_id = r.id AND a.tenant_id = r.tenant_id)`);
  if (risks.includes('negative')) clauses.push(`r.negative_comment_count > 0`);
  return clauses.length ? ` AND (${clauses.join(' OR ')})` : '';
}

// 疑似身份多选筛选:与 identityLabel 同口径,SQL 里按 (author_name, source_type) 推导。
// 正则是字面 SQL(无用户输入),id 经白名单映射,无注入风险。
function identityWhereClause(reqIdentity) {
  const ids = (Array.isArray(reqIdentity) ? reqIdentity : String(reqIdentity || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  const brand = `(COALESCE(r.author_name,'') ~* '${BRAND_MODEL_RE.source}')`;
  const dealerName = `(COALESCE(r.author_name,'') ~* '${DEALER_NAME_RE.source}')`;
  const SQL = {
    dealer: `((${brand} AND (${dealerName} OR r.source_type = 'dealer')) OR (NOT ${brand} AND r.source_type = 'dealer'))`,
    koe: `((${brand} AND NOT (${dealerName} OR r.source_type = 'dealer')) OR (NOT ${brand} AND r.source_type = 'employee'))`,
    user: `(NOT ${brand} AND r.source_type = 'ugc')`,
    kol: `(NOT ${brand} AND r.source_type = 'pgc')`,
    other: `(NOT ${brand} AND r.source_type = 'other')`,
  };
  const clauses = ids.map((id) => SQL[id]).filter(Boolean);
  return clauses.length ? ` AND (${clauses.join(' OR ')})` : '';
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
      sort = '',
      dir = '',
      page = 1,
      pageSize = 30,
    } = req.query;
    const params = [req.tenantId];
    let where = 'WHERE r.tenant_id = $1';
    if (platform) { params.push(platform); where += ` AND r.platform = $${params.length}`; }
    if (sentiment) { params.push(sentiment); where += ` AND r.sentiment = $${params.length}`; }
    const bucket = String(req.query.bucket || '');
    // 先按 bucket/queue 圈定大范围,再叠加具体处置状态(status)与风险(risk)筛选。
    // 关键:bucket/queue 与 status 必须叠加而非互斥 —— 否则按状态筛选会丢掉 active 队列
    // 自带的相关性 / 已响应过滤,把无关内容也漏进来。
    if (bucket === 'archived') {
      // 已归档:误报 / 已归档 / 已响应(已转工单 ticketed 不在分诊视图,在工单系统里跟踪)
      where += ` AND COALESCE(rt.status, 'unhandled') IN ('archived', 'false_positive', 'official_responded')`;
    } else if (queue === 'active') {
      where += ` AND (${ACTIVE_QUEUE_CONDITION})`;
    }
    if (status) {
      params.push(status);
      where += ` AND COALESCE(rt.status, 'unhandled') = $${params.length}`;
    }
    // 风险信号多选筛选(B 端:圈出有预警 / 有负评 / 疑似 KOE 的内容,命中任一即入选)
    where += riskWhereClause(req.query.risk);
    if (priority) { params.push(priority); where += ` AND COALESCE(rt.priority, 'normal') = $${params.length}`; }
    if (keyword) {
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
      where += ` AND (r.title ILIKE $${params.length - 2} OR r.content ILIKE $${params.length - 1} OR r.keyword ILIKE $${params.length})`;
    }
    // 采集关键词多选(每个关键词=一次采集 session)
    const captureKeywords = (Array.isArray(req.query.captureKeyword) ? req.query.captureKeyword : String(req.query.captureKeyword || '').split(','))
      .map(s => String(s).trim()).filter(Boolean);
    if (captureKeywords.length) {
      params.push(captureKeywords);
      where += ` AND r.keyword = ANY($${params.length}::text[])`;
    }
    where += identityWhereClause(req.query.identity);
    // 按采集时间(首次发现)区间导出/筛选,避免 Excel 越积越大;仅接受 YYYY-MM-DD
    const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || '')) ? req.query.dateFrom : '';
    const dTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || '')) ? req.query.dateTo : '';
    // 日期维度可切换:发布时间(published_ts,默认)/ 最近采集(last_seen_at)/ 首次采集(first_seen_at)。列名白名单,无注入
    const dbasis = String(req.query.dateBasis || 'publish');
    const dateCol = dbasis === 'first' ? 'r.first_seen_at' : dbasis === 'recent' ? 'r.last_seen_at' : 'r.published_ts';
    if (dFrom) { params.push(dFrom); where += ` AND ${dateCol} >= $${params.length}::date`; }
    if (dTo) { params.push(dTo); where += ` AND ${dateCol} < ($${params.length}::date + INTERVAL '1 day')`; }

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
        r.author_fans, r.url, r.cover_url, r.cover_local, r.image_urls, r.note_type,
        r.publish_time, r.blogger_profile_url,
        r.likes, r.comments_count, r.collects, r.shares,
        r.comments_capture_status, r.comments_total_captured,
        r.official_replied, r.official_response_status, r.negative_comment_count,
        r.latest_negative_comment_at, r.last_risk_reopened_at,
        r.sentiment, r.category, r.source_type, r.intent, r.ai_summary, r.keyword, r.first_seen_at, r.last_seen_at,
        r.ai_result, r.seen_count, r.created_at,
        COALESCE(rt.status, 'unhandled') AS triage_status,
        COALESCE(rt.priority, 'normal') AS triage_priority,
        COALESCE(rt.owner_name, '') AS triage_owner_name,
        COALESCE(rt.note, '') AS triage_note,
        rt.updated_at AS triage_updated_at,
        (SELECT COUNT(*) FROM alerts a WHERE a.record_id = r.id AND a.tenant_id = r.tenant_id) AS alert_count,
        (SELECT string_agg(DISTINCT a.reason, ' · ') FROM alerts a WHERE a.record_id = r.id AND a.tenant_id = r.tenant_id) AS alert_reasons,
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
      ORDER BY ${orderBySql(sort, dir)}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    records.forEach(r => { r.publish_display = formatPublishDate(r.publish_time, r.created_at); });

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

// 导出当前筛选结果为 Excel(与 /records 列表用同一套 where/params,但不分页;排除封面/图片等重字段)
router.get('/records/export', requireTenantAccess, async (req, res, next) => {
  try {
    const {
      status = '',
      priority = '',
      platform = '',
      sentiment = '',
      keyword = '',
      queue = '',
    } = req.query;
    const params = [req.tenantId];
    let where = 'WHERE r.tenant_id = $1';
    if (platform) { params.push(platform); where += ` AND r.platform = $${params.length}`; }
    if (sentiment) { params.push(sentiment); where += ` AND r.sentiment = $${params.length}`; }
    const bucket = String(req.query.bucket || '');
    if (bucket === 'archived') {
      where += ` AND COALESCE(rt.status, 'unhandled') IN ('archived', 'false_positive', 'official_responded')`;
    } else if (queue === 'active') {
      where += ` AND (${ACTIVE_QUEUE_CONDITION})`;
    }
    if (status) {
      params.push(status);
      where += ` AND COALESCE(rt.status, 'unhandled') = $${params.length}`;
    }
    where += riskWhereClause(req.query.risk);
    if (priority) { params.push(priority); where += ` AND COALESCE(rt.priority, 'normal') = $${params.length}`; }
    if (keyword) {
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
      where += ` AND (r.title ILIKE $${params.length - 2} OR r.content ILIKE $${params.length - 1} OR r.keyword ILIKE $${params.length})`;
    }
    const captureKeywords = (Array.isArray(req.query.captureKeyword) ? req.query.captureKeyword : String(req.query.captureKeyword || '').split(','))
      .map(s => String(s).trim()).filter(Boolean);
    if (captureKeywords.length) {
      params.push(captureKeywords);
      where += ` AND r.keyword = ANY($${params.length}::text[])`;
    }
    where += identityWhereClause(req.query.identity);
    // 按采集时间(首次发现)区间导出/筛选,避免 Excel 越积越大;仅接受 YYYY-MM-DD
    const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || '')) ? req.query.dateFrom : '';
    const dTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || '')) ? req.query.dateTo : '';
    // 日期维度可切换:发布时间(published_ts,默认)/ 最近采集(last_seen_at)/ 首次采集(first_seen_at)。列名白名单,无注入
    const dbasis = String(req.query.dateBasis || 'publish');
    const dateCol = dbasis === 'first' ? 'r.first_seen_at' : dbasis === 'recent' ? 'r.last_seen_at' : 'r.published_ts';
    if (dFrom) { params.push(dFrom); where += ` AND ${dateCol} >= $${params.length}::date`; }
    if (dTo) { params.push(dTo); where += ` AND ${dateCol} < ($${params.length}::date + INTERVAL '1 day')`; }

    const records = await queryAll(`
      SELECT
        r.keyword, r.platform, r.title, r.content, r.author_name, r.author_fans,
        r.author_id, r.author_account_no, r.blogger_profile_url, r.note_type, r.source_type, r.url, r.external_id,
        COALESCE(NULLIF(r.payload->>'bloggerUserId',''), NULLIF(r.payload->>'redId',''), NULLIF(r.payload->>'douyinId',''), NULLIF(r.payload->>'bloggerId','')) AS payload_account_no,
        r.likes, r.comments_count, r.collects, r.shares, r.sentiment, r.category, r.ai_summary,
        r.negative_comment_count, r.publish_time, r.first_seen_at, r.last_seen_at, r.seen_count, r.created_at,
        COALESCE(rt.status, 'unhandled') AS triage_status,
        COALESCE(rt.priority, 'normal') AS triage_priority
      FROM records r
      LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
      ${where}
      ORDER BY ${orderBySql(req.query.sort, req.query.dir)}
      LIMIT 5000
    `, params);

    const rows = records.map(r => ({
      keyword: r.keyword,
      platform: PLATFORM_CN[r.platform] || r.platform || '',
      title: r.title || String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      content: String(r.content || '').slice(0, 1000),
      author_name: r.author_name,
      author_fans: r.author_fans,
      author_uid: platformUserId(r.author_id, r.blogger_profile_url, r.author_account_no, r.payload_account_no),
      blogger_url: r.blogger_profile_url || '',
      identity: identityLabel(r.source_type, r.author_fans, r.author_name),
      note_type: NOTE_TYPE_CN[r.note_type] || '',
      url: postUrl(r),
      likes: r.likes,
      comments_count: r.comments_count,
      collects: r.collects,
      shares: r.shares,
      sentiment: SENTIMENT_CN[r.sentiment] || r.sentiment || '',
      category: CATEGORY_CN[r.category] || r.category || '',
      ai_summary: r.ai_summary,
      negative_comment_count: r.negative_comment_count,
      triage_status: TRIAGE_STATUS_CN[r.triage_status] || r.triage_status || '',
      triage_priority: PRIORITY_CN[r.triage_priority] || r.triage_priority || '',
      publish: formatPublishDate(r.publish_time, r.created_at),
      first_seen: fmtTs(r.first_seen_at),
      last_seen: fmtTs(r.last_seen_at),
      seen_count: r.seen_count,
    }));

    const columns = [
      { header: '采集关键词', key: 'keyword', width: 18 },
      { header: '平台', key: 'platform', width: 10 },
      { header: '发布形式', key: 'note_type', width: 10 },
      { header: '标题', key: 'title', width: 40 },
      { header: '正文', key: 'content', width: 50 },
      { header: '博主', key: 'author_name', width: 16 },
      { header: '粉丝数', key: 'author_fans', width: 10 },
      { header: '用户ID', key: 'author_uid', width: 22 },
      { header: '博主主页', key: 'blogger_url', width: 32 },
      { header: '疑似身份', key: 'identity', width: 12 },
      { header: '帖子链接', key: 'url', width: 34 },
      { header: '点赞', key: 'likes', width: 8 },
      { header: '评论数', key: 'comments_count', width: 8 },
      { header: '收藏', key: 'collects', width: 8 },
      { header: '转发', key: 'shares', width: 8 },
      { header: '情感', key: 'sentiment', width: 8 },
      { header: '分类', key: 'category', width: 12 },
      { header: 'AI摘要', key: 'ai_summary', width: 40 },
      { header: '负评数', key: 'negative_comment_count', width: 8 },
      { header: '处置状态', key: 'triage_status', width: 12 },
      { header: '优先级', key: 'triage_priority', width: 8 },
      { header: '发布时间', key: 'publish', width: 18 },
      { header: '首次发现', key: 'first_seen', width: 18 },
      { header: '最近采集', key: 'last_seen', width: 18 },
      { header: '采集次数', key: 'seen_count', width: 8 },
    ];

    await sendXlsx(res, { sheetName: '内容分诊', columns, rows, filename: `内容分诊_${fmtTs(new Date()).slice(0, 10)}.xlsx` });
  } catch (err) {
    return next(err);
  }
});

export default router;
