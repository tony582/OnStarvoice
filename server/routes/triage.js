import { Router } from 'express';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { requireTenantAccess, requireTenantWriter } from '../middleware/auth.js';
import { formatPublishDate } from '../services/publish-date.js';
import {
  appendCustomTagFilter,
  customTagsSelectSql,
  normalizeCustomTagFilter,
} from '../services/record-custom-tags.js';
import { sendXlsx, fmtTs } from '../services/xlsx-export.js';
import {
  getRecordLifecycle,
  getRecordLifecycles,
  sendRecordArchived,
} from '../services/record-lifecycle.js';

const router = Router();

// 导出用中文标签映射(MAP[v]||v||'')
const PLATFORM_CN = { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博' };
const SENTIMENT_CN = { positive: '正面', neutral: '中性', negative: '负面' };
const TRIAGE_STATUS_CN = {
  unhandled: '待处理',
  replied: '已回复',
  reviewed: '已复核',
  reviewed_non_monitor: '已复核-非监控内容',
  unavailable: '已不可见',
  privacy_unreachable: '隐私限制-无法触达',
  negative_feishu: '负面-飞书表',
  negative_cold: '负面-冷处理',
  // 仅用于历史导出与审计展示；059 迁移后不会再作为当前状态写入。
  reviewing: '负面流程',
  issue_linked: '已关联事件',
  ticketed: '已转工单',
  no_action: '无需操作',
  false_positive: '误报',
  official_responded: '官方已评',
};
const PRIORITY_CN = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const CATEGORY_CN = { safety_rescue: '安全救援', feature_usage: '功能使用', renewal_billing: '续费收费', privacy: '隐私安全', app_issue: 'App问题', service_quality: '服务质量', brand_image: '品牌形象', other: '其他' };
const NOTE_TYPE_CN = { image: '图文', video: '视频', normal: '图文' };
// 账号名带品牌/车型(全称·简称)= 品牌关联号(非真实车主)。⚠ 与 web/admin utils.ts 的同名正则保持一致。
const BRAND_MODEL_RE = /(安吉星|onstar|别克|凯迪拉克|凯迪|雪佛兰|buick|cadillac|chevrolet|上汽通用|君越|君威|昂科威|昂科拉|昂科旗|gl8|gl6|英朗|威朗|凯越|微蓝|velite|阅朗|ct4|ct5|ct6|xt4|xt5|xt6|锐歌|lyriq|凯雷德|科鲁兹|科沃兹|迈锐宝|创酷|创界|探界者|开拓者|沃兰多|星迈罗|赛欧|畅巡|景程)/i;
const DEALER_NAME_RE = /(4s|旗舰店|体验中心|服务中心|销售服务|特约|经销|汽贸)/i;

function kolIdentityLabel(fans) {
  const f = Number(fans);
  if (!Number.isFinite(f) || f <= 0) return 'KOL';
  if (f < 50000) return 'KOC';
  if (f < 500000) return '初级KOL';
  if (f < 3000000) return '中级KOL';
  return '头部KOL';
}

// 人工身份优先;未人工覆盖时才按作者名 + AI source_type 推导。
export function identityLabel(sourceType, fans, name, identityOverride = '') {
  const override = String(identityOverride || '');
  if (override === 'dealer') return '4S店';
  if (override === 'koe') return 'KOE';
  if (override === 'user') return '用户';
  if (override === 'other') return '其他';
  if (override === 'kol') return kolIdentityLabel(fans);

  const nm = String(name || '');
  const st = String(sourceType || '');
  if (BRAND_MODEL_RE.test(nm)) {
    return (DEALER_NAME_RE.test(nm) || st === 'dealer') ? '4S店' : 'KOE';
  }
  if (st === 'dealer') return '4S店';
  if (st === 'employee') return 'KOE';
  if (st === 'ugc') return '用户';
  if (st === 'other') return '其他';
  if (st === 'pgc') return kolIdentityLabel(fans);
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
// 小红书笔记链接缺非空 xsec_source 会被判 300013(访问频繁)。导出/原文链接补上 pc_search,
// token 不动即可正常打开(与采集端 ensureXhsNoteUrlSource 同理)。
function fixXhsNoteSource(u) {
  const raw = String(u || '');
  if (!/xiaohongshu\.com/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.searchParams.get('xsec_token') && !parsed.searchParams.get('xsec_source')) {
      parsed.searchParams.set('xsec_source', 'pc_search');
    }
    return parsed.toString();
  } catch { return raw; }
}
function postUrl(r) {
  if (isNoteUrl(r.url)) return fixXhsNoteSource(r.url);
  const id = String(r.external_id || '').trim();
  if (!id) return r.url || '';
  if (r.platform === 'xiaohongshu') return `https://www.xiaohongshu.com/explore/${id}`;
  if (r.platform === 'douyin') return r.note_type === 'image' ? `https://www.douyin.com/note/${id}` : `https://www.douyin.com/video/${id}`;
  if (r.platform === 'weibo') return `https://weibo.com/detail/${id}`;
  return r.url || '';
}

const TRIAGE_STATUSES = new Set([
  'unhandled',
  'replied',
  'reviewed',
  'reviewed_non_monitor',
  'unavailable',
  'privacy_unreachable',
  'negative_feishu',
  'negative_cold',
]);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 收件箱「待处理队列」条件(别名约定: records r / record_triage rt)。
// workspace.js 的 /badges 计数 import 此常量,保证侧边栏徽标与收件箱列表数字一致。
export const ACTIVE_QUEUE_CONDITION = `
  r.record_type NOT IN ('official_content', 'blogger_profile')
  AND (r.ai_result->>'relevance' IS DISTINCT FROM 'irrelevant')
  AND COALESCE(rt.status, 'unhandled') = 'unhandled'
  AND rt.archived_at IS NULL
`;

// 处理状态和归档生命周期相互独立。两个列表共享状态范围，只按 archived_at 分组。
const TRIAGE_CONTENT_CONDITION = `
  r.record_type NOT IN ('official_content', 'blogger_profile')
  AND (r.ai_result->>'relevance' IS DISTINCT FROM 'irrelevant')
  AND COALESCE(rt.status, 'unhandled') IN (
    'unhandled', 'replied', 'reviewed', 'reviewed_non_monitor',
    'unavailable', 'privacy_unreachable', 'negative_feishu', 'negative_cold'
  )
`;

const TRIAGE_QUEUE_CONDITION = `
  ${TRIAGE_CONTENT_CONDITION}
  AND rt.archived_at IS NULL
`;

const TRIAGE_ARCHIVE_CONDITION = `
  ${TRIAGE_CONTENT_CONDITION}
  AND rt.archived_at IS NOT NULL
`;

// 一条内容可有多张历史工单。列表只展示“在途优先，否则最新结案”的一张，
// 避免普通 JOIN 导致内容重复、分页总数膨胀。评论工单也会带 source_record_id，
// 所以这里必须明确 source_type='content'。
const LATEST_CONTENT_TICKET_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      t.id AS ticket_id,
      t.external_ticket_no AS ticket_number,
      t.status AS ticket_status,
      t.priority AS ticket_priority,
      t.assignee_name AS ticket_assignee_name,
      t.created_at AS ticket_created_at,
      t.updated_at AS ticket_updated_at,
      COALESCE(ticket_note.notes_count, 0)::int AS ticket_notes_count,
      ticket_note.body AS ticket_latest_note,
      ticket_note.author_name AS ticket_latest_note_author,
      ticket_note.created_at AS ticket_latest_note_at,
      ticket_note.event_type AS ticket_latest_note_type
    FROM tickets t
    LEFT JOIN LATERAL (
      SELECT
        tn.body,
        tn.author_name,
        tn.created_at,
        tn.event_type,
        COUNT(*) OVER ()::int AS notes_count
      FROM ticket_notes tn
      WHERE tn.tenant_id = t.tenant_id
        AND tn.ticket_id = t.id
      ORDER BY tn.created_at DESC, tn.id DESC
      LIMIT 1
    ) ticket_note ON true
    WHERE t.tenant_id = r.tenant_id
      AND t.source_type = 'content'
      AND t.source_record_id = r.id
    ORDER BY (t.status <> 'closed') DESC, t.created_at DESC, t.id DESC
    LIMIT 1
  ) ticket ON true
`;

// 列表备注统计独立内容备注与状态变更时填写的备注。旧工单过程记录仍保留在详情历史中，
// 但不再驱动当前处置入口。这里只取最近一条和总数；完整时间线按需加载。
const LATEST_CONTENT_PROGRESS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      progress.body,
      progress.author_name,
      progress.created_at,
      progress.event_type,
      COUNT(*) OVER ()::int AS notes_count
    FROM (
      SELECT
        rn.id::text AS activity_id,
        rn.body,
        rn.author_name,
        rn.created_at,
        'note'::text AS event_type
      FROM record_notes rn
      WHERE rn.tenant_id = r.tenant_id
        AND rn.record_id = r.id

      UNION ALL

      SELECT
        al.id::text AS activity_id,
        al.metadata->>'note' AS body,
        COALESCE(NULLIF(u.name, ''), u.email, NULLIF(al.actor_id, ''), '系统') AS author_name,
        al.created_at,
        'status_note'::text AS event_type
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_user_id
      WHERE al.tenant_id = r.tenant_id
        AND al.action IN ('record.triage_updated', 'record.triage_batch_updated')
        AND btrim(COALESCE(al.metadata->>'note', '')) <> ''
        AND (
          al.target_id = r.id::text
          OR COALESCE(al.metadata->'recordIds', '[]'::jsonb) ? r.id::text
        )
    ) progress
    ORDER BY progress.created_at DESC, progress.activity_id DESC
    LIMIT 1
  ) latest_progress ON true
`;

function appendTicketFilter(where, query = {}) {
  const ticketFilter = String(query.ticket || '');
  if (ticketFilter !== 'with' && ticketFilter !== 'without') return where;
  const existsSql = `EXISTS (
    SELECT 1 FROM tickets tf
    WHERE tf.tenant_id = r.tenant_id
      AND tf.source_type = 'content'
      AND tf.source_record_id = r.id
  )`;
  if (ticketFilter === 'with') return `${where} AND ${existsSql}`;
  if (ticketFilter === 'without') return `${where} AND NOT ${existsSql}`;
  return where;
}

// 工单状态筛选与列表展示使用同一张“当前工单”：在途优先，否则取最近结案。
// 标量子查询在没有内容工单时返回 NULL，active/closed 两种比较都会自然排除该记录。
export function appendTicketLifecycleFilter(where, query = {}) {
  const ticketStatus = String(query.ticketStatus || '');
  if (ticketStatus !== 'active' && ticketStatus !== 'closed') return where;
  const currentTicketStatusSql = `(
    SELECT tfs.status
    FROM tickets tfs
    WHERE tfs.tenant_id = r.tenant_id
      AND tfs.source_type = 'content'
      AND tfs.source_record_id = r.id
    ORDER BY (tfs.status <> 'closed') DESC, tfs.created_at DESC, tfs.id DESC
    LIMIT 1
  )`;
  return `${where} AND ${currentTicketStatusSql} ${ticketStatus === 'closed' ? '=' : '<>'} 'closed'`;
}

function appendKeywordFilter(where, params, keyword) {
  const normalized = String(keyword || '').trim();
  if (!normalized) return { where, matchedTicketSql: `NULL::text` };
  params.push(`%${normalized}%`);
  const p = `$${params.length}`;
  return {
    where: `${where} AND (
    r.title ILIKE ${p}
    OR r.content ILIKE ${p}
    OR r.keyword ILIKE ${p}
    OR r.author_name ILIKE ${p}
    OR r.author_account_no ILIKE ${p}
    OR r.author_id ILIKE ${p}
    OR rt.feishu_table_no ILIKE ${p}
    OR EXISTS (
      SELECT 1 FROM tickets ts
      WHERE ts.tenant_id = r.tenant_id
        AND ts.source_type = 'content'
        AND ts.source_record_id = r.id
        AND ts.external_ticket_no ILIKE ${p}
    )
  )`,
    matchedTicketSql: `(
      SELECT ts.external_ticket_no
      FROM tickets ts
      WHERE ts.tenant_id = r.tenant_id
        AND ts.source_type = 'content'
        AND ts.source_record_id = r.id
        AND ts.external_ticket_no ILIKE ${p}
      ORDER BY (ts.status <> 'closed') DESC, ts.created_at DESC, ts.id DESC
      LIMIT 1
    )`,
  };
}

function validateStatus(status) {
  return TRIAGE_STATUSES.has(status || '') ? status : null;
}

function validatePriority(priority) {
  return PRIORITIES.has(priority || '') ? priority : null;
}

function riskOrderSql() {
  return `
    CASE
      WHEN r.negative_comment_count > 0 AND COALESCE(rt.status, 'unhandled') = 'unhandled' THEN 0
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

// 列表排序：发布时间、互动量、评论、点赞、采集时间均可切换升降序。
function orderBySql(sort, dir) {
  const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (sort === 'publish') return `r.published_ts ${d} NULLS LAST, r.last_seen_at DESC`;
  if (sort === 'interactions') return `(r.likes + r.comments_count + r.collects + r.shares) ${d} NULLS LAST, r.published_ts DESC NULLS LAST`;
  if (sort === 'comments') return `r.comments_count ${d} NULLS LAST, r.published_ts DESC NULLS LAST`;
  if (sort === 'likes') return `r.likes ${d} NULLS LAST, r.published_ts DESC NULLS LAST`;
  if (sort === 'first_seen') return `r.first_seen_at ${d} NULLS LAST, r.last_seen_at DESC`;
  if (sort === 'last_seen') return `r.last_seen_at ${d} NULLS LAST, r.first_seen_at DESC`;
  return riskOrderSql();
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMBINED_DATE_FILTERS = [
  { from: 'publishFrom', to: 'publishTo', column: 'r.published_ts' },
  { from: 'recentFrom', to: 'recentTo', column: 'r.last_seen_at' },
  { from: 'firstFrom', to: 'firstTo', column: 'r.first_seen_at' },
];

function validDateQueryValue(value) {
  const normalized = String(value || '');
  return DATE_ONLY_RE.test(normalized) ? normalized : '';
}

function appendDateBounds(where, params, query, { from, to, column }) {
  const dateFrom = validDateQueryValue(query[from]);
  const dateTo = validDateQueryValue(query[to]);
  if (dateFrom) {
    params.push(dateFrom);
    where += ` AND ${column} >= $${params.length}::date`;
  }
  if (dateTo) {
    params.push(dateTo);
    where += ` AND ${column} < ($${params.length}::date + INTERVAL '1 day')`;
  }
  return where;
}

// 发布时间、最近采集、首次采集可分别设置区间；多个已设置区间按 AND 组合。
// dateFrom/dateTo/dateBasis 是旧客户端参数，只有未携带新组合参数时才使用。
export function appendTriageDateFilters(where, params, query = {}) {
  const hasCombinedParams = COMBINED_DATE_FILTERS.some(({ from, to }) => (
    Object.prototype.hasOwnProperty.call(query, from)
    || Object.prototype.hasOwnProperty.call(query, to)
  ));
  if (hasCombinedParams) {
    return COMBINED_DATE_FILTERS.reduce(
      (nextWhere, definition) => appendDateBounds(nextWhere, params, query, definition),
      where,
    );
  }

  const basis = String(query.dateBasis || 'publish');
  const column = basis === 'first'
    ? 'r.first_seen_at'
    : basis === 'recent'
      ? 'r.last_seen_at'
      : 'r.published_ts';
  return appendDateBounds(where, params, query, {
    from: 'dateFrom',
    to: 'dateTo',
    column,
  });
}

function appendPlatformFilter(where, params, platform) {
  if (!platform) return where;
  if (platform === 'unknown') {
    return `${where} AND COALESCE(NULLIF(r.platform, ''), 'unknown') = 'unknown'`;
  }
  params.push(platform);
  return `${where} AND r.platform = $${params.length}`;
}

function appendSentimentFilter(where, params, sentiment) {
  if (!sentiment) return where;
  if (sentiment === 'pending') {
    return `${where} AND COALESCE(r.sentiment, '') = ''`;
  }
  params.push(sentiment);
  return `${where} AND r.sentiment = $${params.length}`;
}

function appendStatusFilter(where, params, rawStatus) {
  const requested = (Array.isArray(rawStatus) ? rawStatus : [rawStatus])
    .flatMap(value => String(value || '').split(','))
    .map(value => value.trim())
    .filter(Boolean);
  const invalid = requested.filter(value => !TRIAGE_STATUSES.has(value));
  if (invalid.length > 0) {
    const error = new Error('处理状态筛选包含无效值');
    error.status = 400;
    error.code = 'invalid_status_filter';
    throw error;
  }
  const statuses = [...new Set(requested)];
  if (!statuses.length) return where;
  params.push(statuses);
  return `${where} AND COALESCE(rt.status, 'unhandled') = ANY($${params.length}::text[])`;
}

// 风险信号多选筛选(有预警 / 有负评 / 已删帖),命中任一即入选(OR)。条件为字面 SQL,不绑定参数。
// 注:作者身份(原"疑似KOE")已从风险信号拆出,改为独立的「疑似身份」维度(见 identityWhereClause)。
function riskWhereClause(reqRisk) {
  const risks = (Array.isArray(reqRisk) ? reqRisk : String(reqRisk || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  const clauses = [];
  if (risks.includes('alert')) clauses.push(`EXISTS (SELECT 1 FROM alerts a WHERE a.record_id = r.id AND a.tenant_id = r.tenant_id)`);
  if (risks.includes('negative')) clauses.push(`r.negative_comment_count > 0`);
  if (risks.includes('deleted')) clauses.push(`r.content_availability_status = 'deleted'`);
  return clauses.length ? ` AND (${clauses.join(' OR ')})` : '';
}

// 疑似身份多选筛选:与 identityLabel 同口径,SQL 里按 (author_name, source_type) 推导。
// 正则是字面 SQL(无用户输入),id 经白名单映射,无注入风险。
function identityWhereClause(reqIdentity) {
  const ids = (Array.isArray(reqIdentity) ? reqIdentity : String(reqIdentity || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  const brand = `(COALESCE(r.author_name,'') ~* '${BRAND_MODEL_RE.source}')`;
  const dealerName = `(COALESCE(r.author_name,'') ~* '${DEALER_NAME_RE.source}')`;
  const noOverride = `(COALESCE(r.identity_override, '') = '')`;
  const SQL = {
    dealer: `(r.identity_override = 'dealer' OR (${noOverride} AND ((${brand} AND (${dealerName} OR r.source_type = 'dealer')) OR (NOT ${brand} AND r.source_type = 'dealer'))))`,
    koe: `(r.identity_override = 'koe' OR (${noOverride} AND ((${brand} AND NOT (${dealerName} OR r.source_type = 'dealer')) OR (NOT ${brand} AND r.source_type = 'employee'))))`,
    user: `(r.identity_override = 'user' OR (${noOverride} AND NOT ${brand} AND r.source_type = 'ugc'))`,
    kol: `(r.identity_override = 'kol' OR (${noOverride} AND NOT ${brand} AND r.source_type = 'pgc'))`,
    other: `(r.identity_override = 'other' OR (${noOverride} AND NOT ${brand} AND r.source_type = 'other'))`,
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
    const customTagFilter = normalizeCustomTagFilter(req.query.customTag, req.query.customTagMode);
    if (!customTagFilter.ok) {
      return res.status(400).json({
        ok: false,
        error: customTagFilter.error,
        message: customTagFilter.message,
      });
    }
    const params = [req.tenantId];
    let where = 'WHERE r.tenant_id = $1';
    where = appendPlatformFilter(where, params, platform);
    where = appendSentimentFilter(where, params, sentiment);
    const bucket = String(req.query.bucket || '');
    // 先按 bucket/queue 圈定大范围,再叠加具体处置状态(status)与风险(risk)筛选。
    // 关键:bucket/queue 与 status 必须叠加而非互斥 —— 否则按状态筛选会丢掉 active 队列
    // 自带的相关性 / 已响应过滤,把无关内容也漏进来。
    if (queue === 'triage') {
      where += ` AND (${TRIAGE_QUEUE_CONDITION})`;
    } else if (bucket === 'archived') {
      where += ` AND (${TRIAGE_ARCHIVE_CONDITION})`;
    } else if (queue === 'active') {
      where += ` AND (${ACTIVE_QUEUE_CONDITION})`;
    }
    where = appendStatusFilter(where, params, status);
    // 风险信号只包含预警与负评；身份、处理状态分别使用独立筛选。
    where += riskWhereClause(req.query.risk);
    if (priority) { params.push(priority); where += ` AND COALESCE(rt.priority, 'normal') = $${params.length}`; }
    const keywordFilter = appendKeywordFilter(where, params, keyword);
    where = keywordFilter.where;
    where = appendTicketFilter(where, req.query);
    where = appendTicketLifecycleFilter(where, req.query);
    // 采集关键词多选(每个关键词=一次采集 session)
    const captureKeywords = (Array.isArray(req.query.captureKeyword) ? req.query.captureKeyword : String(req.query.captureKeyword || '').split(','))
      .map(s => String(s).trim()).filter(Boolean);
    if (captureKeywords.length) {
      params.push(captureKeywords);
      where += ` AND r.keyword = ANY($${params.length}::text[])`;
    }
    where = appendCustomTagFilter(where, params, customTagFilter, 'r');
    where += identityWhereClause(req.query.identity);
    where = appendTriageDateFilters(where, params, req.query);

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
        r.author_fans, r.url, r.cover_url, r.cover_local, r.image_urls, r.image_local_urls, r.note_type,
        r.publish_time, r.published_ts, r.publish_location, r.blogger_profile_url,
        r.likes, r.comments_count, r.collects, r.shares,
        r.comments_capture_status, r.comments_total_captured,
        r.official_replied, r.official_response_status, r.negative_comment_count,
        r.latest_negative_comment_at, r.last_risk_reopened_at,
        r.content_availability_status, r.content_availability_checked_at,
        r.content_availability_reason, r.content_availability_evidence,
        r.sentiment, r.category, r.source_type, r.identity_override, r.intent, r.ai_summary, r.keyword, r.first_seen_at, r.last_seen_at,
        r.ai_result, r.manual_overrides, ${customTagsSelectSql('r')} AS custom_tags,
        r.seen_count, r.created_at,
        COALESCE(rt.status, 'unhandled') AS triage_status,
        COALESCE(rt.priority, 'normal') AS triage_priority,
        COALESCE(rt.owner_name, '') AS triage_owner_name,
        COALESCE(rt.note, '') AS triage_note,
        COALESCE(rt.feishu_table_no, '') AS feishu_table_no,
        rt.updated_at AS triage_updated_at,
        rt.archived_at,
        COALESCE(rt.archived_by_name, '') AS archived_by_name,
        (ticket.ticket_id IS NOT NULL) AS has_ticket,
        ticket.ticket_id,
        ticket.ticket_number,
        ticket.ticket_status,
        ticket.ticket_priority,
        ticket.ticket_assignee_name,
        ticket.ticket_created_at,
        ticket.ticket_updated_at,
        ticket.ticket_notes_count,
        ticket.ticket_latest_note,
        ticket.ticket_latest_note_author,
        ticket.ticket_latest_note_at,
        ticket.ticket_latest_note_type,
        COALESCE(latest_progress.notes_count, 0)::int AS progress_count,
        latest_progress.body AS progress_latest_body,
        latest_progress.author_name AS progress_latest_author,
        latest_progress.created_at AS progress_latest_at,
        latest_progress.event_type AS progress_latest_type,
        ${keywordFilter.matchedTicketSql} AS matched_ticket_number,
        EXISTS (
          SELECT 1
          FROM record_feedback rf
          WHERE rf.tenant_id = r.tenant_id
            AND rf.record_id = r.id
            AND rf.feedback_type = 'false_positive'
            AND rf.review_status = 'pending'
        ) AS false_positive_pending,
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
      ${LATEST_CONTENT_TICKET_JOIN}
      ${LATEST_CONTENT_PROGRESS_JOIN}
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
    if (err.status && err.code) {
      return res.status(err.status).json({ ok: false, error: err.code, message: err.message });
    }
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
    const note = String(req.body?.note || '').trim();
    const requestedFeishuTableNo = Object.prototype.hasOwnProperty.call(req.body || {}, 'feishuTableNo')
      ? String(req.body.feishuTableNo || '').trim()
      : null;
    if (note.length > 2000) {
      return res.status(400).json({ ok: false, error: 'note_too_long', message: '备注最多 2000 个字符' });
    }
    if (requestedFeishuTableNo !== null && requestedFeishuTableNo.length > 100) {
      return res.status(400).json({ ok: false, error: 'feishu_table_no_too_long', message: '飞书表号最多 100 个字符' });
    }
    if (status === 'false_positive') {
      return res.status(400).json({
        ok: false,
        error: 'false_positive_is_feedback_only',
        message: '误报只能提交给平台管理员复核，不会改变内容处理状态',
      });
    }
    if (status !== null && !validateStatus(status)) {
      return res.status(400).json({ ok: false, error: 'invalid_status', message: '分诊状态无效' });
    }
    if (status === 'negative_feishu' && !requestedFeishuTableNo) {
      return res.status(400).json({
        ok: false,
        error: 'feishu_table_no_required',
        message: '请选择负面-飞书表时填写飞书表号',
      });
    }
    if (priority !== null && !validatePriority(priority)) {
      return res.status(400).json({ ok: false, error: 'invalid_priority', message: '优先级无效' });
    }
    if (status === null && priority === null) {
      return res.status(400).json({ ok: false, error: 'empty_update', message: '没有要更新的字段' });
    }

    let updatedIds = [];
    let archivedIds = [];
    if (validIds.length) {
      const mutation = await withTransaction(async tx => {
        const lifecycles = await getRecordLifecycles({
          tenantId: req.tenantId,
          recordIds: validIds,
          tx,
          lock: true,
        });
        const sealedIds = lifecycles
          .filter(row => row.archived_at)
          .map(row => String(row.id).toLowerCase());
        if (sealedIds.length) return { updatedIds: [], archivedIds: sealedIds };

        const previousRows = await tx.queryAll(`
          SELECT r.id AS record_id,
            COALESCE(rt.status, 'unhandled') AS status,
            COALESCE(rt.priority, 'normal') AS priority,
            COALESCE(rt.feishu_table_no, '') AS feishu_table_no
          FROM records r
          LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])
        `, [req.tenantId, validIds]);
        const rows = await tx.queryAll(`
          INSERT INTO record_triage (
            tenant_id, record_id, status, priority, owner_user_id, owner_name,
            feishu_table_no, updated_at
          )
          SELECT r.tenant_id, r.id, COALESCE($3, 'unhandled'), COALESCE($4, 'normal'), $5, $6,
            COALESCE($7, ''), now()
          FROM records r
          WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])
          ON CONFLICT (tenant_id, record_id)
          DO UPDATE SET
            status = CASE WHEN $3::text IS NOT NULL THEN excluded.status ELSE record_triage.status END,
            priority = CASE WHEN $4::text IS NOT NULL THEN excluded.priority ELSE record_triage.priority END,
            owner_user_id = excluded.owner_user_id,
            owner_name = excluded.owner_name,
            feishu_table_no = CASE WHEN $7::text IS NOT NULL THEN excluded.feishu_table_no ELSE record_triage.feishu_table_no END,
            updated_at = now()
          RETURNING record_id
        `, [
          req.tenantId,
          validIds,
          status,
          priority,
          req.user?.id || null,
          req.actorName || '',
          status === 'negative_feishu' ? requestedFeishuTableNo : null,
        ]);
        await tx.execute(`
          INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
          VALUES ($1, $2, $3, $4, 'record.triage_batch_updated', 'record', '', $5::jsonb)
        `, [
          req.tenantId,
          req.actorType || 'system',
          req.user?.id || req.authCode || '',
          req.user?.id || null,
          JSON.stringify({
            recordIds: rows.map(row => row.record_id),
            status,
            priority,
            note,
            feishuTableNo: status === 'negative_feishu' ? requestedFeishuTableNo : '',
            previous: Object.fromEntries(previousRows.map(row => [row.record_id, {
              status: row.status,
              priority: row.priority,
              feishuTableNo: row.feishu_table_no,
            }])),
            updated: rows.length,
          }),
        ]);
        return {
          updatedIds: rows.map(row => String(row.record_id).toLowerCase()),
          archivedIds: [],
        };
      });
      updatedIds = mutation.updatedIds;
      archivedIds = mutation.archivedIds;
    }

    if (archivedIds.length) return sendRecordArchived(res, archivedIds);

    const updatedSet = new Set(updatedIds);
    const skipped = ids.filter(id => !updatedSet.has(id));
    return res.json({ ok: true, updated: updatedSet.size, updatedIds: [...updatedSet], skipped });
  } catch (err) {
    return next(err);
  }
});

// 归档是独立生命周期：只更新 archived_* 字段，绝不改处理状态 status。
router.patch('/records/archive', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const rawIds = req.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100) {
      return res.status(400).json({ ok: false, error: 'invalid_ids', message: 'ids 需为 1-100 个内容ID' });
    }
    if (typeof req.body?.archived !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_archived', message: 'archived 必须为布尔值' });
    }

    const archived = req.body.archived;
    const ids = [...new Set(rawIds.map(id => String(id || '').trim().toLowerCase()).filter(Boolean))];
    const validIds = ids.filter(id => UUID_RE.test(id));
    let updatedIds = [];

    if (validIds.length) {
      const mutation = await withTransaction(async tx => {
        // 与其它处理写操作共用 records 行锁，保证“归档”与“处理中”不会并发穿透。
        await getRecordLifecycles({
          tenantId: req.tenantId,
          recordIds: validIds,
          tx,
          lock: true,
        });

        const targetIds = validIds;

        let rows = [];
        if (targetIds.length && archived) {
          rows = await tx.queryAll(`
              INSERT INTO record_triage (
                tenant_id, record_id, status, priority, owner_user_id, owner_name,
                archived_at, archived_by_user_id, archived_by_name, updated_at
              )
              SELECT r.tenant_id, r.id, 'unhandled', 'normal', NULL, '',
                now(), $3, $4, now()
              FROM records r
              WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])
              ON CONFLICT (tenant_id, record_id)
              DO UPDATE SET
                archived_at = now(),
                archived_by_user_id = $3,
                archived_by_name = $4,
                updated_at = now()
              RETURNING record_id
            `, [req.tenantId, targetIds, req.user?.id || null, req.actorName || '']);
        } else if (targetIds.length) {
          rows = await tx.queryAll(`
              UPDATE record_triage rt
              SET archived_at = NULL,
                archived_by_user_id = NULL,
                archived_by_name = '',
                updated_at = now()
              FROM records r
              WHERE r.id = rt.record_id
                AND r.tenant_id = rt.tenant_id
                AND rt.tenant_id = $1
                AND rt.record_id = ANY($2::uuid[])
                AND rt.archived_at IS NOT NULL
              RETURNING rt.record_id
            `, [req.tenantId, targetIds]);
        }

        const changedIds = rows.map(row => String(row.record_id).toLowerCase());
        if (changedIds.length) {
          await tx.execute(`
            INSERT INTO audit_logs (
              tenant_id, actor_type, actor_id, actor_user_id,
              action, target_type, target_id, metadata
            )
            VALUES ($1, $2, $3, $4, $5, 'record', '', $6::jsonb)
          `, [
            req.tenantId,
            req.actorType || 'system',
            req.user?.id || req.authCode || '',
            req.user?.id || null,
            archived ? 'record.archived' : 'record.unarchived',
            JSON.stringify({
              recordIds: changedIds,
              archived,
              updated: changedIds.length,
            }),
          ]);
        }
        return { changedIds };
      });
      updatedIds = mutation.changedIds;
    }

    const updatedSet = new Set(updatedIds);
    const skipped = ids.filter(id => !updatedSet.has(id));
    return res.json({
      ok: true,
      updated: updatedSet.size,
      skipped,
    });
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
    const hasFeishuTableNo = Object.prototype.hasOwnProperty.call(body, 'feishuTableNo');
    const feishuTableNo = hasFeishuTableNo ? String(body.feishuTableNo || '').trim() : null;
    if (status === 'false_positive') {
      return res.status(400).json({
        ok: false,
        error: 'false_positive_is_feedback_only',
        message: '误报只能提交给平台管理员复核，不会改变内容处理状态',
      });
    }
    if (status !== null && !validateStatus(status)) {
      return res.status(400).json({ ok: false, error: 'invalid_status', message: '分诊状态无效' });
    }
    if (priority !== null && !validatePriority(priority)) {
      return res.status(400).json({ ok: false, error: 'invalid_priority', message: '优先级无效' });
    }
    if (feishuTableNo !== null && feishuTableNo.length > 100) {
      return res.status(400).json({ ok: false, error: 'feishu_table_no_too_long', message: '飞书表号最多 100 个字符' });
    }
    const ownerName = Object.prototype.hasOwnProperty.call(body, 'ownerName') ? String(body.ownerName || '') : null;
    const requestedNote = Object.prototype.hasOwnProperty.call(body, 'note') ? String(body.note || '').trim() : null;
    if (requestedNote !== null && requestedNote.length > 2000) {
      return res.status(400).json({ ok: false, error: 'note_too_long', message: '备注最多 2000 个字符' });
    }
    const note = requestedNote;

    const result = await withTransaction(async tx => {
      const lifecycle = await getRecordLifecycle({
        tenantId: req.tenantId,
        recordId: req.params.recordId,
        tx,
        lock: true,
      });
      if (!lifecycle) return null;
      if (lifecycle.archived_at) return { archived: true };
      const currentTriage = await tx.queryOne(
        'SELECT * FROM record_triage WHERE tenant_id = $1 AND record_id = $2',
        [req.tenantId, req.params.recordId],
      );
      const triageNote = note;
      const effectiveStatus = status || currentTriage?.status || 'unhandled';
      const effectiveFeishuTableNo = feishuTableNo !== null
        ? feishuTableNo
        : String(currentTriage?.feishu_table_no || '').trim();
      if (
        (status === 'negative_feishu' || (hasFeishuTableNo && effectiveStatus === 'negative_feishu'))
        && !effectiveFeishuTableNo
      ) {
        return { feishuTableNoRequired: true };
      }

      const triage = await tx.queryOne(`
        INSERT INTO record_triage (
          tenant_id, record_id, status, priority, owner_user_id, owner_name, note,
          feishu_table_no, updated_at
        )
        VALUES (
          $1, $2, COALESCE($3, 'unhandled'), COALESCE($4, 'normal'), $5,
          COALESCE($6, ''), COALESCE($7, ''), COALESCE($8, ''), now()
        )
        ON CONFLICT (tenant_id, record_id)
        DO UPDATE SET
          status = CASE WHEN $3::text IS NOT NULL THEN excluded.status ELSE record_triage.status END,
          priority = CASE WHEN $4::text IS NOT NULL THEN excluded.priority ELSE record_triage.priority END,
          owner_user_id = excluded.owner_user_id,
          owner_name = CASE WHEN $6::text IS NOT NULL THEN excluded.owner_name ELSE record_triage.owner_name END,
          note = CASE WHEN $7::text IS NOT NULL THEN excluded.note ELSE record_triage.note END,
          feishu_table_no = CASE WHEN $8::text IS NOT NULL THEN excluded.feishu_table_no ELSE record_triage.feishu_table_no END,
          updated_at = now()
        RETURNING *
      `, [
        req.tenantId,
        req.params.recordId,
        status,
        priority,
        req.user?.id || null,
        ownerName,
        triageNote,
        feishuTableNo,
      ]);
      await tx.execute(`
        INSERT INTO audit_logs (tenant_id, actor_type, actor_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES ($1, $2, $3, $4, 'record.triage_updated', 'record', $5, $6::jsonb)
      `, [
        req.tenantId,
        req.actorType || 'system',
        req.user?.id || req.authCode || '',
        req.user?.id || null,
        req.params.recordId,
        JSON.stringify({
          previousStatus: currentTriage?.status || 'unhandled',
          nextStatus: status || currentTriage?.status || 'unhandled',
          previousPriority: currentTriage?.priority || 'normal',
          nextPriority: priority || currentTriage?.priority || 'normal',
          note: triageNote || '',
          previousFeishuTableNo: currentTriage?.feishu_table_no || '',
          nextFeishuTableNo: effectiveFeishuTableNo,
        }),
      ]);
      return { triage };
    });

    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '内容不存在' });
    if (result.archived) return sendRecordArchived(res, [req.params.recordId]);
    if (result.feishuTableNoRequired) {
      return res.status(400).json({
        ok: false,
        error: 'feishu_table_no_required',
        message: '请选择负面-飞书表时填写飞书表号',
      });
    }
    return res.json({ ok: true, ...result });
  } catch (err) {
    return next(err);
  }
});

router.post('/records/:recordId/issues', requireTenantAccess, requireTenantWriter, async (req, res, next) => {
  try {
    const { issueId = '', title = '', severity = 'medium', summary = '', suggestedAction = '' } = req.body || {};

    const result = await withTransaction(async tx => {
      const lifecycle = await getRecordLifecycle({
        tenantId: req.tenantId,
        recordId: req.params.recordId,
        tx,
        lock: true,
      });
      if (!lifecycle) return null;
      if (lifecycle.archived_at) return { archived: true };
      const record = await tx.queryOne('SELECT * FROM records WHERE id = $1 AND tenant_id = $2', [req.params.recordId, req.tenantId]);

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
      return issue;
    });

    if (!result) return res.status(404).json({ ok: false, error: 'not_found', message: '内容或问题不存在' });
    if (result.archived) return sendRecordArchived(res, [req.params.recordId]);
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
    const customTagFilter = normalizeCustomTagFilter(req.query.customTag, req.query.customTagMode);
    if (!customTagFilter.ok) {
      return res.status(400).json({
        ok: false,
        error: customTagFilter.error,
        message: customTagFilter.message,
      });
    }
    const params = [req.tenantId];
    let where = 'WHERE r.tenant_id = $1';
    where = appendPlatformFilter(where, params, platform);
    where = appendSentimentFilter(where, params, sentiment);
    const bucket = String(req.query.bucket || '');
    if (queue === 'triage') {
      where += ` AND (${TRIAGE_QUEUE_CONDITION})`;
    } else if (bucket === 'archived') {
      where += ` AND (${TRIAGE_ARCHIVE_CONDITION})`;
    } else if (queue === 'active') {
      where += ` AND (${ACTIVE_QUEUE_CONDITION})`;
    }
    where = appendStatusFilter(where, params, status);
    where += riskWhereClause(req.query.risk);
    if (priority) { params.push(priority); where += ` AND COALESCE(rt.priority, 'normal') = $${params.length}`; }
    const keywordFilter = appendKeywordFilter(where, params, keyword);
    where = keywordFilter.where;
    where = appendTicketFilter(where, req.query);
    where = appendTicketLifecycleFilter(where, req.query);
    const captureKeywords = (Array.isArray(req.query.captureKeyword) ? req.query.captureKeyword : String(req.query.captureKeyword || '').split(','))
      .map(s => String(s).trim()).filter(Boolean);
    if (captureKeywords.length) {
      params.push(captureKeywords);
      where += ` AND r.keyword = ANY($${params.length}::text[])`;
    }
    where = appendCustomTagFilter(where, params, customTagFilter, 'r');
    where += identityWhereClause(req.query.identity);
    where = appendTriageDateFilters(where, params, req.query);

    const records = await queryAll(`
      SELECT
        r.keyword, r.platform, r.title, r.content, r.author_name, r.author_fans,
        r.author_id, r.author_account_no, r.blogger_profile_url, r.note_type, r.source_type, r.identity_override,
        r.url, r.external_id,
        COALESCE(
          NULLIF(r.payload->>'bloggerUserId',''), NULLIF(r.payload->>'redId',''),
          NULLIF(r.payload->>'douyinId',''), NULLIF(r.payload->>'bloggerId',''),
          NULLIF(r.payload->'detailPayload'->>'bloggerUserId',''), NULLIF(r.payload->'detailPayload'->>'redId',''),
          NULLIF(r.payload->'detailPayload'->>'douyinId',''), NULLIF(r.payload->'detailPayload'->>'bloggerId','')
        ) AS payload_account_no,
        r.likes, r.comments_count, r.collects, r.shares, r.sentiment, r.category, r.ai_summary,
        r.negative_comment_count, r.publish_time, r.published_ts, r.publish_location,
        r.manual_overrides, ${customTagsSelectSql('r')} AS custom_tags,
        COALESCE((
          SELECT string_agg(
            processing.line,
            E'\n' ORDER BY processing.created_at ASC, processing.activity_id ASC
          )
          FROM (
            SELECT
              rn.created_at,
              rn.id::text AS activity_id,
              to_char(rn.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI')
                || ' ' || COALESCE(NULLIF(rn.author_name, ''), '未知用户')
                || ' 内容备注：' || rn.body AS line
            FROM record_notes rn
            WHERE rn.record_id = r.id AND rn.tenant_id = r.tenant_id

            UNION ALL

            SELECT
              al.created_at,
              al.id::text AS activity_id,
              to_char(al.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI')
                || ' ' || COALESCE(NULLIF(u.name, ''), u.email, NULLIF(al.actor_id, ''), '系统')
                || ' 状态备注：' || (al.metadata->>'note') AS line
            FROM audit_logs al
            LEFT JOIN users u ON u.id = al.actor_user_id
            WHERE al.tenant_id = r.tenant_id
              AND al.action IN ('record.triage_updated', 'record.triage_batch_updated')
              AND btrim(COALESCE(al.metadata->>'note', '')) <> ''
              AND (
                al.target_id = r.id::text
                OR COALESCE(al.metadata->'recordIds', '[]'::jsonb) ? r.id::text
              )

            UNION ALL

            SELECT
              tn.created_at,
              tn.id::text AS activity_id,
              to_char(tn.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI')
                || ' ' || COALESCE(NULLIF(tn.author_name, ''), '未知用户')
                || ' 工单' || CASE WHEN t.external_ticket_no <> '' THEN ' ' || t.external_ticket_no ELSE '' END
                || CASE tn.event_type
                     WHEN 'closed' THEN ' 结案'
                     WHEN 'reopened' THEN ' 重开'
                     WHEN 'done' THEN ' 完成处理'
                     WHEN 'dismissed' THEN ' 忽略'
                     ELSE ' 处理进展'
                   END
                || CASE WHEN tn.body <> '' THEN '：' || tn.body ELSE '' END AS line
            FROM ticket_notes tn
            JOIN tickets t ON t.id = tn.ticket_id AND t.tenant_id = tn.tenant_id
            WHERE t.tenant_id = r.tenant_id
              AND t.source_type = 'content'
              AND t.source_record_id = r.id
          ) processing
        ), '') AS processing_records,
        r.first_seen_at, r.last_seen_at, r.seen_count, r.created_at,
        COALESCE(rt.status, 'unhandled') AS triage_status,
        COALESCE(rt.priority, 'normal') AS triage_priority,
        COALESCE(rt.feishu_table_no, '') AS feishu_table_no,
        rt.archived_at,
        COALESCE(rt.archived_by_name, '') AS archived_by_name,
        (ticket.ticket_id IS NOT NULL) AS has_ticket,
        ticket.ticket_number,
        ticket.ticket_status,
        ${keywordFilter.matchedTicketSql} AS matched_ticket_number
      FROM records r
      LEFT JOIN record_triage rt ON rt.record_id = r.id AND rt.tenant_id = r.tenant_id
      ${LATEST_CONTENT_TICKET_JOIN}
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
      identity: identityLabel(r.source_type, r.author_fans, r.author_name, r.identity_override),
      note_type: NOTE_TYPE_CN[r.note_type] || '',
      url: postUrl(r),
      likes: r.likes,
      comments_count: r.comments_count,
      collects: r.collects,
      shares: r.shares,
      sentiment: SENTIMENT_CN[r.sentiment] || r.sentiment || '',
      category: CATEGORY_CN[r.category] || r.category || '',
      custom_tags: (Array.isArray(r.custom_tags) ? r.custom_tags : [])
        .map(tag => String(tag?.name || '').trim())
        .filter(Boolean)
        .join('、'),
      processing_records: r.processing_records || '',
      ai_summary: r.ai_summary,
      negative_comment_count: r.negative_comment_count,
      triage_status: TRIAGE_STATUS_CN[r.triage_status] || r.triage_status || '',
      triage_priority: PRIORITY_CN[r.triage_priority] || r.triage_priority || '',
      feishu_table_no: r.feishu_table_no || '',
      archived_at: fmtTs(r.archived_at),
      archived_by_name: r.archived_by_name || '',
      publish: formatPublishDate(r.publish_time, r.created_at),
      publish_location: r.publish_location || '',
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
      { header: '自定义标签', key: 'custom_tags', width: 28 },
      { header: '处理记录', key: 'processing_records', width: 50, style: { alignment: { wrapText: true, vertical: 'top' } } },
      { header: 'AI摘要', key: 'ai_summary', width: 40 },
      { header: '负评数', key: 'negative_comment_count', width: 8 },
      { header: '处理状态', key: 'triage_status', width: 24 },
      { header: '飞书表号', key: 'feishu_table_no', width: 20 },
      { header: '优先级', key: 'triage_priority', width: 8 },
      { header: '归档时间', key: 'archived_at', width: 18 },
      { header: '归档人', key: 'archived_by_name', width: 14 },
      { header: '发布时间', key: 'publish', width: 18 },
      { header: '发布位置', key: 'publish_location', width: 10 },
      { header: '首次发现', key: 'first_seen', width: 18 },
      { header: '最近采集', key: 'last_seen', width: 18 },
      { header: '采集次数', key: 'seen_count', width: 8 },
    ];

    await sendXlsx(res, { sheetName: '内容分诊', columns, rows, filename: `内容分诊_${fmtTs(new Date()).slice(0, 10)}.xlsx` });
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ ok: false, error: err.code, message: err.message });
    }
    return next(err);
  }
});

export default router;
