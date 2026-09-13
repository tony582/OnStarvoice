import { queryAll, withTransaction } from '../db/init.js';

export const COMMENT_LEAD_STATUSES = new Set(['new', 'following', 'ticketed', 'resolved', 'ignored']);
export const COMMENT_LEAD_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
export const COMMENT_LEAD_TYPES = new Set([
  'sales_intent', 'complaint', 'renewal_billing', 'app_issue',
  'service_quality', 'safety_privacy', 'brand_risk', 'other',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_LABELS = { new: '待处理', following: '跟进中', ticketed: '已转工单', resolved: '已处理', ignored: '已忽略' };
const PRIORITY_LABELS = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const TYPE_LABELS = {
  sales_intent: '购买意向', complaint: '投诉维权', renewal_billing: '续费收费', app_issue: 'App 故障',
  service_quality: '服务求助', safety_privacy: '安全隐私', brand_risk: '品牌风险', other: '其他',
};

function failure(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function validateIdentity(tenantId, id) {
  if (!UUID_RE.test(String(tenantId || '')) || !UUID_RE.test(String(id || ''))) {
    throw failure('invalid_id', '线索 ID 无效');
  }
}

function checkedText(value, { name, maxLength, required = false }) {
  if (typeof value !== 'string') throw failure(`invalid_${name}`, '内容需为文字');
  const text = value.trim();
  if (required && !text) {
    throw failure(`${name}_required`, name === 'correction_reason' ? '人工修正分类需填写原因' : '请填写跟进记录');
  }
  if (text.length > maxLength) throw failure(`${name}_too_long`, `内容不能超过 ${maxLength} 字`);
  return text;
}

/** Validates before entering a transaction, also usable by batch route callers. */
export function validateCommentLeadMutation({ status, priority, note, leadType, correctionReason } = {}) {
  if (status !== undefined && (!COMMENT_LEAD_STATUSES.has(status) || status === 'ticketed')) {
    throw failure(status === 'ticketed' ? 'ticketed_via_ticket_only' : 'invalid_status',
      status === 'ticketed' ? '请通过创建工单转交处理' : '线索状态无效');
  }
  if (priority !== undefined && !COMMENT_LEAD_PRIORITIES.has(priority)) throw failure('invalid_priority', '线索优先级无效');
  if (leadType !== undefined && !COMMENT_LEAD_TYPES.has(leadType)) throw failure('invalid_lead_type', '线索分类无效');
  const normalizedNote = note === undefined ? undefined : checkedText(note, { name: 'note', maxLength: 4000, required: true });
  const normalizedReason = leadType === undefined ? undefined : checkedText(correctionReason ?? '', { name: 'correction_reason', maxLength: 2000, required: true });
  if ([status, priority, normalizedNote, leadType].every(value => value === undefined)) {
    throw failure('empty_update', '没有要更新的字段');
  }
  return { status, priority, note: normalizedNote, leadType, correctionReason: normalizedReason };
}

/** Human actions are serialized per tenant/lead; notes are append-only. */
export async function mutateCommentLead({ tenantId, id, actor = {}, ...input }) {
  validateIdentity(tenantId, id);
  const patch = validateCommentLeadMutation(input);
  const actorId = UUID_RE.test(String(actor?.id || '')) ? actor.id : null;
  const actorName = String(actor?.name || actor?.email || '').trim().slice(0, 200);
  return withTransaction(async tx => {
    const previous = await tx.queryOne(
      'SELECT * FROM comment_leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id],
    );
    if (!previous) throw failure('not_found', '线索不存在', 404);

    const changes = [];
    if (patch.status !== undefined && patch.status !== previous.status) {
      changes.push({ action: 'status_changed', body: `状态：${STATUS_LABELS[previous.status] || previous.status} → ${STATUS_LABELS[patch.status]}`,
        metadata: {}, from: previous.status, to: patch.status });
    }
    if (patch.priority !== undefined && patch.priority !== previous.priority) {
      changes.push({ action: 'priority_changed', body: `优先级：${PRIORITY_LABELS[previous.priority] || previous.priority} → ${PRIORITY_LABELS[patch.priority]}`,
        metadata: { priority_from: previous.priority, priority_to: patch.priority } });
    }
    if (patch.leadType !== undefined && (patch.leadType !== previous.manual_lead_type || patch.correctionReason !== previous.manual_reason)) {
      changes.push({ action: 'classification_corrected', body: `人工修正：${TYPE_LABELS[previous.lead_type] || previous.lead_type} → ${TYPE_LABELS[patch.leadType]}。${patch.correctionReason}`,
        metadata: { lead_type_from: previous.lead_type, lead_type_to: patch.leadType, reason: patch.correctionReason } });
    }
    if (patch.note !== undefined) changes.push({ action: 'note_added', body: patch.note, metadata: {} });
    if (!changes.length) return previous;

    const statusChanged = changes.some(change => change.action === 'status_changed');
    const updated = await tx.queryOne(`
      UPDATE comment_leads SET
        status = COALESCE($3, status), priority = COALESCE($4, priority),
        lead_type = COALESCE($5, lead_type),
        manual_lead_type = COALESCE($5, manual_lead_type),
        manual_reason = CASE WHEN $5::text IS NULL THEN manual_reason ELSE $6 END,
        handled_by = CASE WHEN $7 THEN $8::uuid ELSE handled_by END,
        handled_name = CASE WHEN $7 THEN $9 ELSE handled_name END,
        handled_at = CASE WHEN $7 THEN now() ELSE handled_at END,
        updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *
    `, [tenantId, id, patch.status ?? null, patch.priority ?? null, patch.leadType ?? null,
      patch.correctionReason ?? null, statusChanged, actorId, actorName]);

    for (const change of changes) {
      await tx.execute(`
        INSERT INTO comment_lead_activities (
          tenant_id, lead_id, action, status_from, status_to, note, actor_id, actor_name, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `, [tenantId, id, change.action, change.from ?? null, change.to ?? null, change.body,
        actorId, actorName, JSON.stringify(change.metadata)]);
    }
    return updated;
  });
}

export async function getCommentLeadActivities({ tenantId, id, limit = 100 }) {
  validateIdentity(tenantId, id);
  const requestedLimit = Number(limit);
  const boundedLimit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.trunc(requestedLimit))) : 100;
  return queryAll(`
    SELECT id, action, note AS body, actor_name, created_at,
      metadata || jsonb_strip_nulls(jsonb_build_object('status_from', status_from, 'status_to', status_to)) AS metadata
    FROM comment_lead_activities WHERE tenant_id = $1 AND lead_id = $2
    ORDER BY created_at DESC, id DESC LIMIT $3
  `, [tenantId, id, boundedLimit]);
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

/** Local, explicit handling rules: viewing details never invokes an AI model. */
export function buildCommentLeadSuggestion(lead = {}, record = {}) {
  const ai = jsonObject(lead.ai_result);
  const leadType = lead.manual_lead_type || lead.lead_type || 'other';
  const sourceStep = '先查看评论、父帖和上下文，核实评论的对象与实际诉求。';
  const logStep = '在跟进记录中写明联系结果、下一步和负责人，再更新处理状态。';
  const reviewRequired = !lead.manual_lead_type && (
    ai.salesIntentStatus === 'needs_review' || (leadType === 'sales_intent' && (
      ai.salesIntentStatus !== 'confirmed' || ai.salesIntent !== true ||
      ['sarcasm', 'rhetorical', 'negated', 'quoted', 'uncertain'].includes(ai.expressionType)
    ))
  );
  let summary;
  let steps;
  let replyDraft;
  if (reviewRequired) {
    summary = '购买意向尚待核实；先辨别暗讽、反问和抱怨，再决定是否作为销售线索跟进。';
    steps = [sourceStep, '有真实询价、购买或预约需求时再跟进；暗讽或投诉可填写原因修正为对应评论分类。', logStep];
  } else if (leadType === 'sales_intent') {
    summary = '先确认具体购买需求，再安排对应销售人员跟进。';
    steps = [sourceStep, '确认关注的产品或服务、所在城市及计划时间；经对方同意后通过私信沟通联系方式。', '仅使用已核实的报价、权益和可预约信息答复，记录后续联系安排。', logStep];
    replyDraft = '您好，请问您想了解哪款产品或哪项服务？方便的话可以通过私信说明需求，我们再为您提供对应信息。';
  } else if (leadType === 'safety_privacy') {
    summary = '优先核实安全或隐私问题，交由相应负责人处理并跟踪结果。';
    steps = [sourceStep, '确认事件是否仍在发生、涉及的产品或服务及已有处置；必要时创建工单交由专人跟进。', '通过私信等适当渠道补充核查资料，公开回复中不索取电话、车牌或其他个人信息。', logStep];
    replyDraft = '您好，我们关注到您反馈的问题。方便通过私信补充具体情况和发生时间吗？我们会据此核实并跟进。';
  } else if (leadType === 'app_issue') {
    summary = '核实使用故障和复现条件，再安排排查。';
    steps = [sourceStep, '确认发生时间、App 版本、设备系统、报错表现和影响功能；信息齐全后转交排查。', logStep];
    replyDraft = '您好，方便说明遇到问题的具体功能、发生时间以及 App 和手机系统版本吗？我们会根据这些信息协助核实。';
  } else if (leadType === 'renewal_billing') {
    summary = '先核实费用争议或续费体验，避免将投诉当作购买意向。';
    steps = [sourceStep, '确认争议项目、扣费或续费时间和期望处理结果，通过私信补充必要凭据；未核实前不承诺退款或优惠。', logStep];
    replyDraft = '您好，想进一步了解您反馈的费用问题。方便通过私信说明涉及的项目、时间和希望解决的问题吗？';
  } else if (leadType === 'complaint' || leadType === 'service_quality') {
    summary = '围绕实际问题核实诉求，记录处理安排及反馈结果。';
    steps = [sourceStep, '确认问题发生时间、此前联系渠道和期望结果；需要跨部门处理时创建工单。', logStep];
    replyDraft = '您好，看到您的反馈了。方便进一步说明遇到的具体问题及此前的处理情况吗？我们会据此核实和跟进。';
  } else {
    summary = '先复核评论语气和上下文，区分实际问题、暗讽表达与一般讨论。';
    steps = [sourceStep, '有明确问题时按实际诉求转交；缺少具体诉求的调侃或暗讽，先记录判断依据和观察安排。', logStep];
  }
  // Human classification changes invalidate the AI's old sales/customer-service
  // advice. Unverified sales retain the review-first summary and no reply draft.
  let source = 'rules';
  const aiRoutingMatches = leadType === 'sales_intent'
    ? ai.salesIntent === true && ai.salesIntentStatus === 'confirmed'
    : ai.salesIntent !== true && ai.salesIntentStatus !== 'confirmed';
  if (!lead.manual_lead_type && !reviewRequired && aiRoutingMatches) {
    const advice = typeof ai.followUpSuggestion === 'string' ? ai.followUpSuggestion.trim().slice(0, 500) : '';
    const draft = typeof ai.suggestedReply === 'string' ? ai.suggestedReply.trim().slice(0, 800) : '';
    if (advice) {
      summary = advice;
      source = 'ai';
    }
    if (draft) { replyDraft = draft; source = 'ai'; }
  }
  if (lead.priority === 'urgent' && leadType !== 'safety_privacy') steps.splice(1, 0, '当前优先级为紧急，先确认影响范围并安排负责人及时核实。');
  if (lead.status === 'ticketed') steps.push(lead.ticket_status === 'closed'
    ? '关联工单已结案，评论仍保留原处理状态；请核对结案结果后决定是否标记已处理。'
    : '该评论已转工单，请核对关联工单中的负责人和处理进展。');
  if (['resolved', 'ignored'].includes(lead.status)) steps.push('当前已归档；如发现新诉求或新风险，可重新设为待处理并记录原因。');
  if (record.business_visibility && record.business_visibility !== 'eligible') steps.unshift('父帖当前未进入业务展示范围，请先核实是否与监测对象相关。');
  return { summary, steps, source, ...(replyDraft ? { replyDraft } : {}) };
}
