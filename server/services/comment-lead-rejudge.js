import { queryAll, queryOne, withTransaction } from '../db/init.js';
import { classifyCommentWithAI } from './ai-labeler.js';
import { resolveLeadType, upsertCommentLeadForComment } from './comment-leads.js';
import { aggregateRecordComments, finalizeRecordAggregate } from './comment-workflow.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeSalesReviewCursor(cursor, tenantId) {
  if (!cursor) return { lastId: null, until: null };
  try {
    if (typeof cursor !== 'string' || cursor.length > 512) throw new Error();
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (value.tenantId !== tenantId || !UUID_RE.test(value.lastId) || typeof value.until !== 'string' || value.until.length > 64 || !Number.isFinite(Date.parse(value.until))) throw new Error();
    // Preserve the database's microseconds across pages; JS Date truncates them.
    return { lastId: value.lastId, until: value.until };
  } catch {
    throw Object.assign(new Error('重判进度已失效，请重新开始'), { status: 400, code: 'invalid_cursor' });
  }
}

// Model calls happen outside transactions. UUID keyset pagination is unaffected
// when reviewed rows leave sales, unlike OFFSET or repeatedly taking the newest N.
export async function rejudgeSalesLeadBatch({ tenantId, limit = 3, cursor, actor, classify = classifyCommentWithAI }) {
  const size = Math.max(1, Math.min(5, Math.floor(Number(limit)) || 3));
  const decoded = decodeSalesReviewCursor(cursor, tenantId);
  const lastId = decoded.lastId;
  // Using the database clock also avoids app/DB clock skew on the first page.
  const until = decoded.until || (await queryOne('SELECT clock_timestamp()::text AS until')).until;
  const eligible = `cl.tenant_id = $1 AND cl.lead_type = 'sales_intent'
    AND cl.manual_lead_type IS NULL AND cl.created_at <= $2::timestamptz
    AND r.business_visibility = 'eligible' AND COALESCE(r.ai_result->>'relevance', '') <> 'irrelevant'`;
  const total = Number((await queryOne(`SELECT COUNT(*)::int AS n FROM comment_leads cl
    JOIN records r ON r.id = cl.record_id AND r.tenant_id = cl.tenant_id WHERE ${eligible}`, [tenantId, until]))?.n || 0);
  const rows = await queryAll(`SELECT cl.id AS lead_id, cl.lead_type, rc.*, rc.updated_at::text AS review_version, to_jsonb(r) AS record,
      (SELECT parent.content FROM record_comments parent WHERE parent.tenant_id = rc.tenant_id
        AND parent.record_id = rc.record_id AND parent.external_comment_id = rc.parent_comment_id
        AND rc.parent_comment_id <> '' LIMIT 1) AS parent_content
    FROM comment_leads cl JOIN records r ON r.id = cl.record_id AND r.tenant_id = cl.tenant_id
    JOIN record_comments rc ON rc.id = cl.comment_id AND rc.tenant_id = cl.tenant_id
    WHERE ${eligible} AND ($3::uuid IS NULL OR cl.id > $3::uuid)
    ORDER BY cl.id LIMIT $4`, [tenantId, until, lastId, size + 1]);
  const hasMore = rows.length > size;
  const batch = rows.slice(0, size);
  let changed = 0, retained = 0, failed = 0, skipped = 0;
  for (const comment of batch) {
    let ai;
    try {
      ai = await classify({ tenantId, record: comment.record, comment: { ...comment, parent_comment_content: comment.parent_content || '' } });
    } catch { failed += 1; continue; }
    if (!ai || !ai.ai_result) { failed += 1; continue; }
    let outcome;
    try { outcome = await withTransaction(async tx => {
      // Ordinary ingestion/refinement updates comments and leads before it
      // updates aggregate facts on records. Match that order to avoid deadlock.
      const current = await tx.queryOne('SELECT * FROM record_comments WHERE id = $1 AND tenant_id = $2 AND updated_at = $3::timestamptz FOR UPDATE', [comment.id, tenantId, comment.review_version]);
      if (!current) return 'skipped';
      const lead = await tx.queryOne('SELECT *, last_risk_reopened_at::text AS previous_reopened_at FROM comment_leads WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [comment.lead_id, tenantId]);
      if (!lead || lead.manual_lead_type || lead.lead_type !== 'sales_intent') return 'skipped';
      const record = await tx.queryOne('SELECT * FROM records WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [comment.record_id, tenantId]);
      if (!record || record.business_visibility !== 'eligible' || record.ai_result?.relevance === 'irrelevant') return 'skipped';
      if (['title', 'content', 'platform', 'keyword', 'record_type'].some(key => String(record[key] || '') !== String(comment.record[key] || ''))) return 'skipped';
      if (current.parent_comment_id) {
        const parent = await tx.queryOne(`SELECT content FROM record_comments WHERE tenant_id = $1
          AND record_id = $2 AND external_comment_id = $3 LIMIT 1`, [tenantId, current.record_id, current.parent_comment_id]);
        if (String(parent?.content || '') !== String(comment.parent_content || '')) return 'skipped';
      }
      const previousAggregate = await aggregateRecordComments(tx, tenantId, record.id);
      await tx.execute(`UPDATE record_comments SET is_negative = $3, sentiment = $4,
        category = $5, risk_level = $6, ai_summary = $7, ai_result = $8::jsonb,
        ai_classified_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [current.id, tenantId, ai.is_negative, ai.sentiment, ai.category, ai.risk_level, ai.ai_summary || '', JSON.stringify(ai.ai_result)]);
      const next = { ...current, ...ai };
      await upsertCommentLeadForComment(tx, { tenantId, record, comment: next });
      // Reviewing AI classification is not a new capture or a human workflow
      // action: preserve the latest priority and status, including edits made
      // while the model was running, and do not trigger capture recurrence.
      await tx.execute(`UPDATE comment_leads SET status = $3, priority = $4,
        last_risk_reopened_at = $5::timestamptz WHERE id = $1 AND tenant_id = $2`,
      [lead.id, tenantId, lead.status, lead.priority, lead.previous_reopened_at]);
      const newType = resolveLeadType(next);
      // Audit both retained and rerouted decisions. Human status/notes are intact.
      await tx.execute(`INSERT INTO comment_lead_activities
        (tenant_id, lead_id, action, note, actor_name, metadata, actor_id)
        VALUES ($1, $2, 'ai_review', $3, $4, $5::jsonb, $6)`,
      [tenantId, lead.id, ai.ai_summary || ai.ai_result.salesIntentReason || '已重新核验购买意向', actor?.name || actor?.email || '',
        JSON.stringify({ previousLeadType: lead.lead_type, leadType: newType, salesIntentStatus: ai.ai_result.salesIntentStatus }), actor?.id || null]);
      await finalizeRecordAggregate(tx, { tenantId, recordId: record.id, previousAggregate });
      return newType === 'sales_intent' ? 'retained' : 'changed';
    }); } catch (error) {
      // Earlier committed rows remain accounted for; a failed write must not
      // discard this page's cursor and cause an unbounded replay of its head.
      console.warn('[CommentLeadReview] Row failed', { leadId: comment.lead_id, code: error?.code || 'review_write_failed' });
      failed += 1;
      continue;
    }
    if (outcome === 'changed') changed += 1;
    else if (outcome === 'retained') retained += 1;
    else skipped += 1;
  }
  const last = batch.at(-1);
  return {
    scanned: batch.length, changed, retained, failed, skipped, total, hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ tenantId, until, lastId: last.lead_id })).toString('base64url') : null,
  };
}
