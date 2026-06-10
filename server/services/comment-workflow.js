import crypto from 'crypto';
import { queryAll, queryOne, withTransaction } from '../db/init.js';

const NEGATIVE_KEYWORDS = [
  '投诉', '维权', '差评', '垃圾', '失望', '被骗', '坑', '故障', '坏了', '崩溃',
  '闪退', '打不开', '连不上', '不能用', '不续费', '收费', '乱扣', '贵', '恶心',
  '安全', '事故', '召回', '失控', '泄露', '隐私', '客服', '没人管', '气死',
];

const CRITICAL_KEYWORDS = ['事故', '失控', '刹车', '起火', '死亡', '伤亡', '泄露', '隐私', '召回'];

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

function classifyComment(comment, isOfficial) {
  if (isOfficial) {
    return { sentiment: 'neutral', category: 'official_response', risk_level: 'none', is_negative: false };
  }
  const text = normalizeComparable(comment.content);
  const matchedCritical = CRITICAL_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  const matchedNegative = matchedCritical || NEGATIVE_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  if (!matchedNegative) {
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

async function upsertComment(tx, { tenantId, recordId, platform, comment, officialAccount }) {
  const contentHash = buildCommentHash(recordId, comment);
  const classification = classifyComment(comment, Boolean(officialAccount));
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
        is_negative = $9,
        sentiment = $10,
        category = $11,
        risk_level = $12,
        payload = $13::jsonb,
        last_seen_at = now(),
        seen_count = seen_count + 1,
        updated_at = now()
      WHERE id = $14
      RETURNING *
    `, [
      comment.author_name, comment.author_id, comment.author_avatar, comment.content,
      comment.like_count, comment.published_at, comment.ip_location,
      Boolean(officialAccount), classification.is_negative, classification.sentiment,
      classification.category, classification.risk_level, JSON.stringify(comment.payload || {}),
      existing.id,
    ]);
    return { row, inserted: false, officialAccount };
  }

  const row = await tx.queryOne(`
    INSERT INTO record_comments (
      tenant_id, record_id, platform, external_comment_id, parent_comment_id,
      author_name, author_id, author_avatar, content, like_count, published_at,
      ip_location, floor_index, is_official, is_negative, sentiment, category,
      risk_level, content_hash, payload
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17,
      $18, $19, $20::jsonb
    )
    RETURNING *
  `, [
    tenantId, recordId, platform || 'unknown', comment.external_comment_id, comment.parent_comment_id,
    comment.author_name, comment.author_id, comment.author_avatar, comment.content, comment.like_count,
    comment.published_at, comment.ip_location, comment.floor_index, Boolean(officialAccount),
    classification.is_negative, classification.sentiment, classification.category,
    classification.risk_level, contentHash, JSON.stringify(comment.payload || {}),
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
    ON CONFLICT (tenant_id, record_id, content_hash) DO NOTHING
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

  if (officialRecord) {
    nextStatus = 'official_responded';
    auditAction = 'record.official_content_hidden';
  } else if (aggregate.negativeCount > previousNegativeCount && ['archived', 'official_responded', 'false_positive'].includes(currentStatus)) {
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

export async function upsertRecordComments(recordId, record, context) {
  const tenantId = context.tenantId;
  const platform = record.platform || 'unknown';
  const comments = [
    ...parseJsonArray(record.comments_cleaned_items),
    ...parseJsonArray(record.official_reply_items),
  ].filter(item => commentContent(item));

  return await withTransaction(async tx => {
    const accounts = await loadOfficialAccounts(tx, tenantId);
    const currentRecord = await tx.queryOne(
      'SELECT id, author_name, author_id, platform, record_type, negative_comment_count FROM records WHERE id = $1 AND tenant_id = $2',
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

    for (let index = 0; index < comments.length; index++) {
      const comment = normalizeComment(comments[index], index);
      const officialAccount = isOfficialSubject({
        platform,
        author_name: comment.author_name,
        author_id: comment.author_id,
      }, accounts);
      const result = await upsertComment(tx, { tenantId, recordId, platform, comment, officialAccount });
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
    }

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

    await applyTriageWorkflow(tx, {
      tenantId,
      recordId,
      officialRecord,
      previousNegativeCount: Number(currentRecord.negative_comment_count || 0),
      aggregate,
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
