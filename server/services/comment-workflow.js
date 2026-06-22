import crypto from 'crypto';
import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { classifyCommentWithAI, classifyCommentsBatch } from './ai-labeler.js';
import { upsertCommentLeadForComment } from './comment-leads.js';

const NEGATIVE_KEYWORDS = [
  '投诉', '维权', '差评', '垃圾', '失望', '被骗', '坑', '故障', '坏了', '崩溃',
  '闪退', '打不开', '连不上', '不能用', '不续费', '收费', '乱扣', '贵', '恶心',
  '安全', '事故', '召回', '失控', '泄露', '隐私', '客服', '没人管', '气死',
];

const CRITICAL_KEYWORDS = ['事故', '失控', '刹车', '起火', '死亡', '伤亡', '泄露', '隐私', '召回'];
const POSITIVE_PATTERNS = [
  /不算贵/, /不贵/, /不收费/, /免费/, /可以/, /有用/, /挺有用/, /好用/, /不会不提供服务/,
  /一直免费/, /没问题/, /还行/, /划算/, /值得/, /正常/, /能用/, /可以用/,
];
const LOW_SIGNAL_RENEWAL_PATTERNS = [
  /没必要续费/, /不用续/, /不续$/, /不续了?$/, /不买了?$/, /用不了几次/, /开的不多/,
  /一年\d+多.*不算贵/, /不算贵.*救援/, /只是.*不能用.*救援.*免费/,
];
const HARD_NEGATIVE_PATTERNS = [
  /乱扣/, /扣费/, /被骗/, /坑人?/, /垃圾/, /恶心/, /气死/, /投诉/, /维权/, /没人管/,
  /打不开/, /连不上/, /闪退/, /崩溃/, /故障/, /坏了/, /无法使用/, /完全不能用/,
  /泄露/, /隐私/, /事故/, /失控/, /起火/, /召回/, /刹车/,
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase();
}

function cleanNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = normalizeComparable(value);
  if (!text) return false;
  return !['false', '0', 'no', 'off'].includes(text);
}

function hasPattern(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function commentContent(item) {
  return normalizeText(item?.content || item?.text || item?.commentText || item?.body || '');
}

function normalizeComment(item, index) {
  const content = commentContent(item);
  const authorName = normalizeText(item?.authorName || item?.author || item?.userName || item?.nickname || '');
  const authorId = normalizeText(item?.authorId || item?.userId || item?.uid || '');
  const publishedAt = normalizeText(item?.publishedAt || item?.publishTime || item?.time || item?.date || '');
  const externalCommentId = normalizeText(item?.commentId || item?.id || item?.cid || '');
  return {
    external_comment_id: externalCommentId,
    parent_comment_id: normalizeText(item?.parentCommentId || item?.parentId || ''),
    author_name: authorName,
    author_id: authorId,
    author_avatar: normalizeText(item?.authorAvatar || item?.avatarUrl || item?.avatar || ''),
    content,
    like_count: cleanNumber(item?.likes ?? item?.likeCount),
    published_at: publishedAt,
    ip_location: normalizeText(item?.ipLocation || ''),
    floor_index: Number.isFinite(Number(item?.floorIndex ?? item?.index)) ? Number(item?.floorIndex ?? item?.index) : index + 1,
    payload: item || {},
  };
}

export function classifyComment(comment, isOfficial) {
  if (isOfficial) {
    return { sentiment: 'neutral', category: 'official_response', risk_level: 'none', is_negative: false };
  }
  const text = normalizeComparable(comment.content);
  const matchedCritical = CRITICAL_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  const matchedHardNegative = matchedCritical || hasPattern(text, HARD_NEGATIVE_PATTERNS);
  const matchedNegativeWord = NEGATIVE_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  const matchedPositive = hasPattern(text, POSITIVE_PATTERNS);
  const lowSignalRenewal = hasPattern(text, LOW_SIGNAL_RENEWAL_PATTERNS);

  if (lowSignalRenewal && !matchedHardNegative) {
    return { sentiment: 'neutral', category: 'renewal_billing', risk_level: 'none', is_negative: false };
  }
  if (matchedPositive && !matchedHardNegative) {
    return { sentiment: matchedNegativeWord ? 'neutral' : 'positive', category: '', risk_level: 'none', is_negative: false };
  }
  if (!matchedNegativeWord && !matchedHardNegative) {
    return { sentiment: 'neutral', category: '', risk_level: 'none', is_negative: false };
  }
  const riskLevel = matchedCritical ? 'high' : (comment.like_count >= 20 ? 'medium' : 'low');
  let category = 'brand_image';
  if (/续费|收费|不续费|乱扣|贵/.test(text)) category = 'renewal_billing';
  else if (/闪退|打不开|连不上|不能用|故障|坏了|app/.test(text)) category = 'app_issue';
  else if (/客服|没人管|服务/.test(text)) category = 'service_quality';
  else if (/安全|事故|召回|失控|泄露|隐私/.test(text)) category = 'safety_rescue';
  return { sentiment: 'negative', category, risk_level: riskLevel, is_negative: true };
}

function ruleClassificationWithMetadata(ruleClassification) {
  return {
    ...ruleClassification,
    ai_summary: '',
    ai_result: { ...ruleClassification, classifier: 'rule_comment' },
  };
}

function classificationSummary(classification) {
  return classification.ai_summary || classification.ai_result?.summary || classification.ai_result?.reason || '';
}

function classificationChanged(comment, next, includeAiResult = false) {
  const baseChanged =
    Boolean(comment.is_negative) !== Boolean(next.is_negative) ||
    comment.sentiment !== next.sentiment ||
    comment.category !== next.category ||
    comment.risk_level !== next.risk_level;
  if (baseChanged) return true;
  if (!includeAiResult) return false;
  return normalizeText(comment.ai_summary) !== normalizeText(classificationSummary(next)) ||
    JSON.stringify(comment.ai_result || {}) !== JSON.stringify(next.ai_result || {});
}

async function classifyCommentForWorkflow({ tenantId, record = {}, comment, isOfficial }) {
  const ruleClassification = classifyComment(comment, isOfficial);
  if (isOfficial) return ruleClassificationWithMetadata(ruleClassification);
  const aiClassification = await classifyCommentWithAI({
    tenantId,
    record,
    comment,
    isOfficial,
    fallback: ruleClassification,
  });
  return aiClassification || ruleClassificationWithMetadata(ruleClassification);
}

function officialAliases(account) {
  return [
    account.account_name,
    ...parseJsonArray(account.aliases).map(value => typeof value === 'string' ? value : value?.name),
  ].map(normalizeComparable).filter(Boolean);
}

function matchesOfficialAccount(subject, account) {
  if (!account || account.status !== 'active') return false;
  if (account.platform && subject.platform && account.platform !== subject.platform) return false;
  const subjectId = normalizeComparable(subject.author_id || subject.account_id || '');
  const accountId = normalizeComparable(account.account_id || '');
  if (subjectId && accountId && subjectId === accountId) return true;
  const subjectName = normalizeComparable(subject.author_name || subject.account_name || '');
  if (!subjectName) return false;
  return officialAliases(account).some(alias => alias && subjectName === alias);
}

async function loadOfficialAccounts(tx, tenantId) {
  return await tx.queryAll(
    "SELECT * FROM official_accounts WHERE tenant_id = $1 AND status = 'active'",
    [tenantId]
  );
}

function isOfficialSubject(subject, accounts) {
  return accounts.find(account => matchesOfficialAccount(subject, account)) || null;
}

function buildCommentHash(recordId, comment) {
  const base = [
    recordId,
    comment.author_id || comment.author_name,
    comment.content,
    comment.published_at,
  ].join('|');
  return sha256(base);
}

// classification:入库用的(规则)分类。aiClassified:是否已是终判(官方评论)。
// 评论入库不调 LLM —— 新评论先存规则分类、ai_classified_at 留 NULL,由后台 refineCommentsWithAI 精炼。
async function upsertComment(tx, { tenantId, recordId, platform, comment, officialAccount, classification = null, aiClassified = false }) {
  const contentHash = buildCommentHash(recordId, comment);
  if (!classification) classification = ruleClassificationWithMetadata(classifyComment(comment, Boolean(officialAccount)));
  let existing = null;
  if (comment.external_comment_id) {
    existing = await tx.queryOne(
      'SELECT * FROM record_comments WHERE tenant_id = $1 AND record_id = $2 AND external_comment_id = $3',
      [tenantId, recordId, comment.external_comment_id]
    );
  }
  if (!existing) {
    existing = await tx.queryOne(
      'SELECT * FROM record_comments WHERE tenant_id = $1 AND record_id = $2 AND content_hash = $3',
      [tenantId, recordId, contentHash]
    );
  }

  if (existing) {
    // 已存在:只刷新元数据(点赞/内容/最近见到),不动已有分类与 ai_classified_at ——
    // 否则重采会把后台已 AI 精炼的结果降级回规则、并把它重新标成待精炼。
    const row = await tx.queryOne(`
      UPDATE record_comments SET
        author_name = COALESCE(NULLIF($1, ''), author_name),
        author_id = COALESCE(NULLIF($2, ''), author_id),
        author_avatar = COALESCE(NULLIF($3, ''), author_avatar),
        content = COALESCE(NULLIF($4, ''), content),
        like_count = $5,
        published_at = COALESCE(NULLIF($6, ''), published_at),
        ip_location = COALESCE(NULLIF($7, ''), ip_location),
        is_official = $8,
        last_seen_at = now(),
        seen_count = seen_count + 1,
        updated_at = now()
      WHERE id = $9
      RETURNING *
    `, [
      comment.author_name, comment.author_id, comment.author_avatar, comment.content,
      comment.like_count, comment.published_at, comment.ip_location,
      Boolean(officialAccount), existing.id,
    ]);
    return { row, inserted: false, officialAccount };
  }

  const row = await tx.queryOne(`
    INSERT INTO record_comments (
      tenant_id, record_id, platform, external_comment_id, parent_comment_id,
      author_name, author_id, author_avatar, content, like_count, published_at,
      ip_location, floor_index, is_official, is_negative, sentiment, category,
      risk_level, ai_summary, ai_result, content_hash, payload, ai_classified_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17,
      $18, $19, $20::jsonb, $21, $22::jsonb,
      CASE WHEN $23 THEN now() ELSE NULL END
    )
    RETURNING *
  `, [
    tenantId, recordId, platform || 'unknown', comment.external_comment_id, comment.parent_comment_id,
    comment.author_name, comment.author_id, comment.author_avatar, comment.content, comment.like_count,
    comment.published_at, comment.ip_location, comment.floor_index, Boolean(officialAccount),
    classification.is_negative, classification.sentiment, classification.category,
    classification.risk_level,
    classificationSummary(classification),
    JSON.stringify(classification.ai_result || {}),
    contentHash,
    JSON.stringify(comment.payload || {}),
    aiClassified,
  ]);
  return { row, inserted: true, officialAccount };
}

async function upsertOfficialResponse(tx, { tenantId, recordId, platform, comment, commentId, officialAccount }) {
  const contentHash = sha256([recordId, officialAccount?.id || '', comment.content, comment.published_at].join('|'));
  await tx.execute(`
    INSERT INTO official_responses (
      tenant_id, record_id, comment_id, official_account_id, platform,
      account_name, account_id, content, published_at, content_hash, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
    ON CONFLICT (tenant_id, record_id, content_hash) WHERE content_hash <> '' DO NOTHING
  `, [
    tenantId, recordId, commentId, officialAccount?.id || null, platform || '',
    comment.author_name || officialAccount?.account_name || '',
    comment.author_id || officialAccount?.account_id || '',
    comment.content, comment.published_at, contentHash,
    JSON.stringify(comment.payload || {}),
  ]);
}

async function aggregateRecordComments(tx, tenantId, recordId) {
  const aggregate = await tx.queryOne(`
    SELECT
      COUNT(*) FILTER (WHERE is_negative AND NOT is_official) AS negative_count,
      MAX(last_seen_at) FILTER (WHERE is_negative AND NOT is_official) AS latest_negative_at,
      COUNT(*) FILTER (WHERE is_official) AS official_count
    FROM record_comments
    WHERE tenant_id = $1 AND record_id = $2
  `, [tenantId, recordId]);
  return {
    negativeCount: Number(aggregate?.negative_count || 0),
    latestNegativeAt: aggregate?.latest_negative_at || null,
    officialCount: Number(aggregate?.official_count || 0),
  };
}

async function applyTriageWorkflow(tx, { tenantId, recordId, officialRecord, previousNegativeCount, aggregate }) {
  const current = await tx.queryOne(
    "SELECT status FROM record_triage WHERE tenant_id = $1 AND record_id = $2",
    [tenantId, recordId]
  );
  const currentStatus = current?.status || 'unhandled';
  let nextStatus = '';
  let auditAction = '';

  // 已转工单(ticketed/旧 issue_linked)只有在关联工单已关闭时才允许复发,避免在途工单被搅动
  let dispatchedReopenable = false;
  if (['ticketed', 'issue_linked'].includes(currentStatus)) {
    const openTicket = await tx.queryOne(
      "SELECT 1 FROM tickets WHERE tenant_id = $1 AND source_record_id = $2 AND status <> 'closed' LIMIT 1",
      [tenantId, recordId]
    );
    dispatchedReopenable = !openTicket;
  }

  if (officialRecord) {
    nextStatus = 'official_responded';
    auditAction = 'record.official_content_hidden';
  } else if (aggregate.negativeCount > previousNegativeCount && (['archived', 'official_responded', 'false_positive'].includes(currentStatus) || dispatchedReopenable)) {
    nextStatus = 'reviewing';
    auditAction = 'record.reopened_by_comment_risk';
    await tx.execute(
      'UPDATE records SET last_risk_reopened_at = now() WHERE id = $1 AND tenant_id = $2',
      [recordId, tenantId]
    );
  } else if (aggregate.officialCount > 0 && aggregate.negativeCount === 0 && ['unhandled', 'reviewing', 'official_responded'].includes(currentStatus)) {
    nextStatus = 'official_responded';
    auditAction = 'record.official_responded';
  }

  if (!nextStatus) return;
  await tx.execute(`
    INSERT INTO record_triage (tenant_id, record_id, status, priority, note, updated_at)
    VALUES ($1, $2, $3, 'normal', '', now())
    ON CONFLICT (tenant_id, record_id)
    DO UPDATE SET status = excluded.status, updated_at = now()
  `, [tenantId, recordId, nextStatus]);
  await tx.execute(`
    INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, target_type, target_id, metadata)
    VALUES ($1, 'system', 'comment-workflow', $2, 'record', $3, $4::jsonb)
  `, [tenantId, auditAction, recordId, JSON.stringify({ previousStatus: currentStatus, nextStatus })]);
}

// ── 抖音过采兜底(服务端,不动扩展 → 不受 MediaClaw 上游更新影响)─────────────
// 抖音"评论"会混入【非评论内容】:推荐视频(数十万~百万赞、带话题标签)、页面版权页脚、
// 视频赞数文本碎片("380.5万 用户名")、UI 碎片。入库前剔掉。依据平台机制:抖音评论结构上
// 不带话题标签 # ,点赞也到不了视频量级。仅对 douyin 生效,不动小红书/微博。
const DY_FOOTER_RE = /ICP备|feedback@douyin\.com|增值电信业务经营许可证|网络文化经营许可证|互联网新闻信息服务许可证|算法推荐专项举报/;
const DY_TOPIC_RE = /#[一-龥a-zA-Z][^#\s）)]{0,29}/;
const DY_LIKETEXT_RE = /^\d+(\.\d+)?万[\s ]/;
const DY_UI_FRAG_RE = /^(条回复|@|展开\d+条回复|收起|相关推荐|大家都在搜)$/;
function isDouyinNonComment(item) {
  const text = String(item?.content || item?.text || item?.commentText || '').trim();
  if (!text) return true;
  if (DY_FOOTER_RE.test(text) || DY_TOPIC_RE.test(text) || DY_LIKETEXT_RE.test(text) || DY_UI_FRAG_RE.test(text)) return true;
  if (cleanNumber(item?.likes ?? item?.likeCount) > 50000) return true;
  return false;
}

// 评论分类提速:逐条 LLM 调用(deepseek-chat 单次慢)是大帖卡死的根因。这里把同帖评论
// 分批(每批 BATCH_SIZE 条)、限并发(BATCH_CONCURRENCY 批同时跑)走批量分类,且全部在事务之外
// 算好,再进事务快速入库。AI 精度不变(仍逐条判定),只是把"几百次串行慢调用"压成"几十次并行调用"。
const BATCH_SIZE = 12;
const BATCH_CONCURRENCY = 4;

// 限并发 map:最多 limit 个 worker 并行消费 items,按下标顺序写回 results。
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// 评论写库后:重算负面数/官方回复状态、更新记录、跑分诊流转。
// Phase A(规则入库后)与 Phase B(AI 精炼后)共用 —— AI 精炼可能改变 is_negative,需重算并可能复发。
async function finalizeRecordAggregate(tx, { tenantId, recordId, officialRecord, previousNegativeCount }) {
  const aggregate = await aggregateRecordComments(tx, tenantId, recordId);
  const responseStatus = aggregate.officialCount > 0
    ? (aggregate.negativeCount > 0 ? 'needs_followup' : 'responded')
    : (officialRecord ? 'responded' : 'none');
  await tx.execute(`
    UPDATE records
    SET official_replied = $1,
      official_response_status = $2,
      negative_comment_count = $3,
      latest_negative_comment_at = $4,
      updated_at = now()
    WHERE id = $5 AND tenant_id = $6
  `, [
    aggregate.officialCount > 0 || officialRecord,
    responseStatus,
    aggregate.negativeCount,
    aggregate.latestNegativeAt,
    recordId,
    tenantId,
  ]);
  await applyTriageWorkflow(tx, { tenantId, recordId, officialRecord, previousNegativeCount, aggregate });
  return { aggregate, responseStatus };
}

export async function upsertRecordComments(recordId, record, context) {
  const tenantId = context.tenantId;
  const platform = record.platform || 'unknown';
  let comments = [
    ...parseJsonArray(record.comments_cleaned_items),
    ...parseJsonArray(record.official_reply_items),
  ].filter(item => commentContent(item));
  if (platform === 'douyin') {
    const before = comments.length;
    comments = comments.filter(item => !isDouyinNonComment(item));
    if (before > comments.length) {
      console.log(`[CommentWorkflow] 抖音过采过滤:剔除 ${before - comments.length}/${before} 条非评论(推荐视频/页脚/碎片) record=${recordId}`);
    }
  }

  // PHASE 0:只读加载放在事务之外(官方账号表、当前记录),不占用事务连接。
  const accounts = await loadOfficialAccounts({ queryAll }, tenantId);
  const currentRecord = await queryOne(
    'SELECT id, title, content, url, keyword, author_name, author_id, platform, record_type, sentiment, category, negative_comment_count FROM records WHERE id = $1 AND tenant_id = $2',
    [recordId, tenantId]
  );
  if (!currentRecord) return { inserted: 0, updated: 0, negative: 0, officialResponses: 0, officialContent: false };

  const officialRecordAccount = isOfficialSubject({
    platform,
    author_name: record.author_name || currentRecord.author_name,
    author_id: record.author_id || currentRecord.author_id,
  }, accounts);
  const shouldSkipOfficialAccounts = record.skip_official_accounts !== false;
  const officialRecord = Boolean(
    shouldSkipOfficialAccounts &&
      officialRecordAccount &&
      officialRecordAccount.skip_content !== false,
  );

  // PHASE 1(规则快速分类,不调 LLM):评论以规则分类立即入库、马上可见;
  // 非官方评论标 aiClassified=false,留给后台 refineCommentsWithAI 批量 AI 精炼。
  const prepared = comments.map((raw, index) => {
    const comment = normalizeComment(raw, index);
    const officialAccount = isOfficialSubject({
      platform,
      author_name: comment.author_name,
      author_id: comment.author_id,
    }, accounts);
    const classification = ruleClassificationWithMetadata(classifyComment(comment, Boolean(officialAccount)));
    return { comment, officialAccount, classification, aiClassified: Boolean(officialAccount) };
  });

  // PHASE 2:事务里只做快速写库(无 LLM)。大帖不再把事务开着等几十分钟、也不会因 LLM 超时整篇回滚。
  return await withTransaction(async tx => {
    let inserted = 0;
    let updated = 0;
    let officialResponses = 0;

    if (officialRecord) {
      await tx.execute(`
        UPDATE records
        SET record_type = 'official_content',
          official_replied = true,
          official_response_status = 'responded',
          updated_at = now()
        WHERE id = $1 AND tenant_id = $2
      `, [recordId, tenantId]);
    }

    for (const { comment, officialAccount, classification, aiClassified } of prepared) {
      const result = await upsertComment(tx, { tenantId, recordId, platform, comment, officialAccount, classification, aiClassified });
      if (result.inserted) inserted += 1;
      else updated += 1;
      if (officialAccount) {
        officialResponses += 1;
        await upsertOfficialResponse(tx, {
          tenantId,
          recordId,
          platform,
          comment,
          commentId: result.row.id,
          officialAccount,
        });
      }
      // 客资生成移到后台 AI 精炼之后(refineCommentsWithAI):用 AI 判定的购买意向,避免规则误判产生假客资。
    }

    const { aggregate, responseStatus } = await finalizeRecordAggregate(tx, {
      tenantId,
      recordId,
      officialRecord,
      previousNegativeCount: Number(currentRecord.negative_comment_count || 0),
    });

    return {
      inserted,
      updated,
      negative: aggregate.negativeCount,
      officialResponses,
      officialContent: officialRecord,
      officialResponseStatus: responseStatus,
    };
  });
}

// Phase B(后台 AI 精炼):捞出待精炼(ai_classified_at IS NULL)的非官方评论,按帖分组、
// 分批并发走批量 LLM,精炼结果回填评论,据此生成客资 + 重算该帖负面数/分诊。
// LLM 整批失败 → 这批保持 NULL,下轮重试;评论早已入库可见,绝不会因 AI 失败丢成 0 条。
export async function refineCommentsWithAI({ limit = 300 } = {}) {
  const pending = await queryAll(`
    SELECT rc.id, rc.record_id, rc.tenant_id, rc.content, rc.author_name, rc.like_count, rc.ip_location,
           r.title AS r_title, r.content AS r_content, r.platform AS r_platform,
           r.sentiment AS r_sentiment, r.category AS r_category, r.record_type AS r_type,
           r.negative_comment_count AS r_neg
    FROM record_comments rc
    JOIN records r ON r.id = rc.record_id AND r.tenant_id = rc.tenant_id
    WHERE rc.ai_classified_at IS NULL AND rc.is_official = false
    ORDER BY rc.record_id, rc.id
    LIMIT $1
  `, [limit]);
  if (!pending.length) return 0;

  const groups = new Map();
  for (const c of pending) {
    if (!groups.has(c.record_id)) groups.set(c.record_id, []);
    groups.get(c.record_id).push(c);
  }

  let refined = 0;
  for (const [recordId, rows] of groups) {
    const tenantId = rows[0].tenant_id;
    const record = {
      title: rows[0].r_title, content: rows[0].r_content, platform: rows[0].r_platform,
      sentiment: rows[0].r_sentiment, category: rows[0].r_category,
    };
    const batches = [];
    for (let k = 0; k < rows.length; k += BATCH_SIZE) batches.push(rows.slice(k, k + BATCH_SIZE));

    // LLM 调用在事务之外,分批并发
    const done = await mapLimit(batches, BATCH_CONCURRENCY, async (batch) => {
      let ai = null;
      try {
        ai = await classifyCommentsBatch({
          tenantId, record,
          comments: batch.map(c => ({ author_name: c.author_name, content: c.content, like_count: c.like_count, ip_location: c.ip_location })),
        });
      } catch (err) {
        console.error('[CommentRefine] 批量分类失败,留待下轮:', err.message);
        ai = null;
      }
      return { batch, ai };
    });

    // 写库在一个快事务里(无 LLM)
    let changed = 0;
    await withTransaction(async tx => {
      const recForLead = await tx.queryOne(
        'SELECT id, title, content, url, keyword, author_name, author_id, platform, record_type FROM records WHERE id = $1 AND tenant_id = $2',
        [recordId, tenantId]
      );
      for (const { batch, ai } of done) {
        if (!ai) continue; // 整批失败:保持待精炼,下轮再来
        for (let j = 0; j < batch.length; j++) {
          const cls = ai[j];
          if (!cls) continue; // 单条缺失:留待下轮
          const updatedRow = await tx.queryOne(`
            UPDATE record_comments
            SET sentiment = $1, is_negative = $2, category = $3, risk_level = $4,
                ai_summary = $5, ai_result = $6::jsonb, ai_classified_at = now(), updated_at = now()
            WHERE id = $7
            RETURNING *
          `, [cls.sentiment, cls.is_negative, cls.category, cls.risk_level, classificationSummary(cls), JSON.stringify(cls.ai_result || {}), batch[j].id]);
          if (updatedRow && recForLead) {
            await upsertCommentLeadForComment(tx, { tenantId, record: recForLead, comment: updatedRow });
          }
          changed += 1;
        }
      }
      if (changed > 0) {
        await finalizeRecordAggregate(tx, {
          tenantId, recordId,
          officialRecord: rows[0].r_type === 'official_content',
          previousNegativeCount: Number(rows[0].r_neg || 0),
        });
      }
    });
    refined += changed;
  }
  return refined;
}

// 自愈:把"payload 里有评论、但 record_comments 还没入库"的记录重新走一遍入库。
// 评论数据本就安全存在 records.payload(关键词采集嵌在 items[0].commentsCleanedItems,
// 单篇在顶层)。给"异步队列因 LLM 挂死卡死 / 进程重启丢失内存队列"兜底。
// 由 index.js 启动后非阻塞调用;LLM 调用已加超时,不会再卡死。
export async function reprocessPendingComments({ limit = 2000 } = {}) {
  const rows = await queryAll(`
    SELECT r.id, r.tenant_id, r.platform, r.title, r.content, r.author_name, r.author_id,
           r.url, r.keyword,
           COALESCE(
             CASE WHEN jsonb_typeof(r.payload->'items'->0->'commentsCleanedItems') = 'array'
                  THEN r.payload->'items'->0->'commentsCleanedItems' END,
             CASE WHEN jsonb_typeof(r.payload->'commentsCleanedItems') = 'array'
                  THEN r.payload->'commentsCleanedItems' END,
             '[]'::jsonb) AS cleaned,
           COALESCE(
             CASE WHEN jsonb_typeof(r.payload->'items'->0->'officialReplyItems') = 'array'
                  THEN r.payload->'items'->0->'officialReplyItems' END,
             CASE WHEN jsonb_typeof(r.payload->'officialReplyItems') = 'array'
                  THEN r.payload->'officialReplyItems' END,
             '[]'::jsonb) AS official_reply
    FROM records r
    WHERE NOT EXISTS (SELECT 1 FROM record_comments rc WHERE rc.record_id = r.id)
      AND (
        (jsonb_typeof(r.payload->'items'->0->'commentsCleanedItems') = 'array'
           AND jsonb_array_length(r.payload->'items'->0->'commentsCleanedItems') > 0)
        OR (jsonb_typeof(r.payload->'commentsCleanedItems') = 'array'
           AND jsonb_array_length(r.payload->'commentsCleanedItems') > 0)
      )
    ORDER BY r.created_at DESC
    LIMIT $1
  `, [limit]);
  if (!rows.length) return 0;
  console.log(`[Reprocess] 自愈:发现 ${rows.length} 条积压记录待补评论入库`);
  let fixed = 0;
  for (const r of rows) {
    try {
      await upsertRecordComments(r.id, {
        platform: r.platform, title: r.title, content: r.content,
        author_name: r.author_name, author_id: r.author_id, url: r.url, keyword: r.keyword,
        comments_cleaned_items: JSON.stringify(r.cleaned || []),
        official_reply_items: JSON.stringify(r.official_reply || []),
      }, { tenantId: r.tenant_id, authCode: '' });
      fixed += 1;
    } catch (err) {
      console.error(`[Reprocess] record ${r.id} 失败:`, err.message);
    }
  }
  console.log(`[Reprocess] 自愈补回 ${fixed}/${rows.length} 条记录的评论`);
  return fixed;
}

export async function getRecordComments(tenantId, recordId) {
  return await queryAll(
    'SELECT * FROM record_comments WHERE tenant_id = $1 AND record_id = $2 ORDER BY is_negative DESC, last_seen_at DESC, floor_index NULLS LAST',
    [tenantId, recordId]
  );
}

export async function getOfficialResponses(tenantId, recordId) {
  return await queryAll(
    'SELECT * FROM official_responses WHERE tenant_id = $1 AND record_id = $2 ORDER BY created_at DESC',
    [tenantId, recordId]
  );
}

export async function getComment(tenantId, commentId) {
  return await queryOne(
    'SELECT * FROM record_comments WHERE tenant_id = $1 AND id = $2',
    [tenantId, commentId]
  );
}

export async function reclassifyComments(tenantId = null, options = {}) {
  const config = typeof options === 'boolean' ? { useAI: options } : (options || {});
  const useAI = Boolean(config.useAI);
  const onlyWithoutAI = Boolean(config.onlyWithoutAI);
  const limit = Math.max(0, Math.floor(Number(config.limit || 0)));
  const params = [];
  let where = 'WHERE 1=1';
  if (tenantId) {
    params.push(tenantId);
    where += ` AND rc.tenant_id = $${params.length}`;
  }
  if (config.recordId) {
    params.push(config.recordId);
    where += ` AND rc.record_id = $${params.length}`;
  }
  if (onlyWithoutAI) {
    where += " AND (rc.ai_result->>'classifier' IS DISTINCT FROM 'llm_comment')";
  }
  let limitSql = '';
  if (limit > 0) {
    params.push(limit);
    limitSql = `LIMIT $${params.length}`;
  }
  const comments = await queryAll(`
    SELECT rc.*,
      r.title AS record_title,
      r.content AS record_content,
      r.platform AS record_platform,
      r.sentiment AS record_sentiment,
      r.category AS record_category
    FROM record_comments rc
    LEFT JOIN records r ON r.id = rc.record_id AND r.tenant_id = rc.tenant_id
    ${where}
    ORDER BY rc.last_seen_at DESC, rc.created_at DESC
    ${limitSql}
  `, params);
  const updates = [];
  let aiUsed = 0;
  let ruleFallback = 0;

  for (const comment of comments) {
    const recordContext = {
      title: comment.record_title,
      content: comment.record_content,
      platform: comment.record_platform || comment.platform,
      sentiment: comment.record_sentiment,
      category: comment.record_category,
    };
    const next = useAI
      ? await classifyCommentForWorkflow({
          tenantId: comment.tenant_id,
          record: recordContext,
          comment,
          isOfficial: Boolean(comment.is_official),
        })
      : ruleClassificationWithMetadata(classifyComment(comment, comment.is_official));
    if (next.ai_result?.classifier === 'llm_comment') aiUsed += 1;
    else ruleFallback += 1;
    if (!classificationChanged(comment, next, useAI)) continue;
    updates.push({
      id: comment.id,
      tenantId: comment.tenant_id,
      recordId: comment.record_id,
      next,
    });
  }

  await withTransaction(async tx => {
    for (const update of updates) {
      const next = update.next;
      await tx.execute(`
        UPDATE record_comments
        SET is_negative = $1,
          sentiment = $2,
          category = $3,
          risk_level = $4,
          ai_summary = $5,
          ai_result = $6::jsonb,
          updated_at = now()
        WHERE id = $7 AND tenant_id = $8
      `, [
        next.is_negative,
        next.sentiment,
        next.category,
        next.risk_level,
        classificationSummary(next),
        JSON.stringify(next.ai_result || {}),
        update.id,
        update.tenantId,
      ]);
    }

    const recordPairs = new Map();
    for (const update of updates) {
      if (update.recordId && update.tenantId) recordPairs.set(update.recordId, update.tenantId);
    }
    for (const [recordId, recordTenantId] of recordPairs.entries()) {
      const aggregate = await aggregateRecordComments(tx, recordTenantId, recordId);
      const responseStatus = aggregate.negativeCount > 0
        ? 'needs_followup'
        : (aggregate.officialCount > 0 ? 'responded' : 'none');
      await tx.execute(`
        UPDATE records
        SET official_replied = $1,
          official_response_status = $2,
          negative_comment_count = $3,
          latest_negative_comment_at = $4,
          updated_at = now()
        WHERE id = $5 AND tenant_id = $6
      `, [
        aggregate.officialCount > 0,
        responseStatus,
        aggregate.negativeCount,
        aggregate.latestNegativeAt,
        recordId,
        recordTenantId,
      ]);
    }
  });

  return { total: comments.length, changed: updates.length, ai: useAI, aiUsed, ruleFallback };
}
