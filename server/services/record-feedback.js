export const FEEDBACK_TYPES = new Set(['false_positive', 'manual_correction']);
export const FEEDBACK_REVIEW_STATUSES = new Set(['pending', 'reviewed', 'summarized', 'dismissed']);

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeFeedbackReason(value, { required = false, maxLength = 2000 } = {}) {
  const reason = String(value ?? '').trim();
  if (required && !reason) {
    return { ok: false, error: 'reason_required', message: '请填写原因', value: '' };
  }
  if (reason.length > maxLength) {
    return { ok: false, error: 'reason_too_long', message: `原因不能超过 ${maxLength} 字`, value: reason };
  }
  return { ok: true, value: reason };
}

export function normalizeReviewStatus(value) {
  const status = String(value || '').trim();
  return FEEDBACK_REVIEW_STATUSES.has(status) ? status : '';
}

export function buildRecordSnapshot(record = {}, triage = null) {
  return {
    id: record.id || null,
    external_id: record.external_id || '',
    platform: record.platform || '',
    record_type: record.record_type || '',
    title: record.title || '',
    content: record.content || '',
    author_name: record.author_name || '',
    author_id: record.author_id || '',
    author_fans: Number(record.author_fans || 0),
    url: record.url || '',
    sentiment: record.sentiment || '',
    category: record.category || '',
    source_type: record.source_type || '',
    identity_override: record.identity_override || '',
    publish_time: record.publish_time || '',
    published_ts: record.published_ts || null,
    ai_summary: record.ai_summary || '',
    keyword: record.keyword || '',
    created_at: record.created_at || null,
    updated_at: record.updated_at || null,
    triage_status: triage?.status || record.triage_status || 'unhandled',
    triage_priority: triage?.priority || record.triage_priority || 'normal',
    triage_note: triage?.note || record.triage_note || '',
  };
}

export function buildAiSnapshot(record = {}) {
  const aiResult = jsonObject(record.ai_result);
  const textValue = (...values) => {
    const value = values.find(item => item !== undefined && item !== null && String(item).trim() !== '');
    return value === undefined ? '' : String(value);
  };
  return {
    ai_result: aiResult,
    sentiment: textValue(aiResult.sentiment, record.sentiment),
    category: textValue(aiResult.category, record.category),
    source_type: textValue(aiResult.source_type, aiResult.sourceType, record.source_type),
    ai_summary: textValue(aiResult.summary, aiResult.ai_summary, record.ai_summary),
    ai_confidence: Number(aiResult.confidence ?? aiResult.ai_confidence ?? record.ai_confidence ?? 0),
    ai_labeled_at: record.ai_labeled_at || null,
  };
}

export async function insertRecordFeedback(tx, {
  tenantId,
  record,
  triage = null,
  feedbackType,
  reason = '',
  originalValues = {},
  correctedValues = {},
  actorUserId = null,
  actorName = '',
}) {
  if (!FEEDBACK_TYPES.has(feedbackType)) {
    throw new Error(`Unsupported feedback type: ${feedbackType}`);
  }
  const checkedReason = normalizeFeedbackReason(reason, { required: feedbackType === 'false_positive' });
  if (!checkedReason.ok) {
    const err = new Error(checkedReason.message);
    err.code = checkedReason.error;
    throw err;
  }

  return await tx.queryOne(`
    INSERT INTO record_feedback (
      tenant_id, record_id, feedback_type, review_status, reason,
      original_values, corrected_values, ai_snapshot, record_snapshot,
      submitted_by_user_id, submitted_by_name
    ) VALUES (
      $1, $2, $3, 'pending', $4,
      $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
      $9, $10
    )
    RETURNING *
  `, [
    tenantId,
    record?.id || null,
    feedbackType,
    checkedReason.value,
    JSON.stringify(originalValues || {}),
    JSON.stringify(correctedValues || {}),
    JSON.stringify(buildAiSnapshot(record)),
    JSON.stringify(buildRecordSnapshot(record, triage)),
    actorUserId,
    actorName,
  ]);
}
