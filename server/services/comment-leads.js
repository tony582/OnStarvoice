const LEAD_TYPE_KEYWORDS = {
  // 销售客资:购买意向 / 询价 / 留联系方式(优先识别,归到「销售客资」)
  sales_intent: [
    '多少钱', '价格', '报价', '怎么买', '哪里买', '哪买', '在哪买', '求链接',
    '优惠', '团购', '想买', '入手', '下单', '购买', '试驾', '预约', '门店', '经销商',
    '4s', '加微信', 'vx', 'v信', '联系方式',
  ],
  complaint: ['投诉', '维权', '差评', '坑人', '被骗', '垃圾', '恶心'],
  renewal_billing: ['续费', '收费', '不续费', '乱扣', '扣费', '贵', '年费'],
  app_issue: ['闪退', '打不开', '连不上', '不能用', '故障', '坏了', '无法使用', 'app'],
  service_quality: ['客服', '没人管', '服务', '售后', '解决'],
  safety_privacy: ['安全', '事故', '召回', '失控', '泄露', '隐私', '刹车', '起火'],
  brand_risk: ['失望', '无语', '拉黑', '避雷', '品牌', '口碑'],
};

// 销售客资 vs 舆情评论 的归类
export function isSalesLeadType(leadType) {
  return String(leadType || '') === 'sales_intent';
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeAiResult(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function hasAnyKeyword(text, keywords = []) {
  return keywords.some(keyword => text.includes(keyword.toLowerCase()));
}

function matchedKeywordsFor(comment, record = {}) {
  const text = normalizeText([
    comment.content,
    record.title,
    record.content,
    record.keyword,
  ].filter(Boolean).join(' ')).toLowerCase();
  const matched = new Set();
  for (const keywords of Object.values(LEAD_TYPE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) matched.add(keyword);
    }
  }
  if (record.keyword) matched.add(String(record.keyword));
  return Array.from(matched).slice(0, 12);
}

export function resolveLeadType(comment) {
  const text = normalizeText(comment.content).toLowerCase();
  // 购买意向以 AI 判断为准(salesIntent);AI 未判过时才退回(已收紧的)关键词。
  // 这样"客服打电话让续费""不续费给我关闭"这类投诉不会被误收进销售客资。
  const ai = normalizeAiResult(comment.ai_result);
  const aiJudged = ai && typeof ai === 'object' && Object.prototype.hasOwnProperty.call(ai, 'salesIntent');
  const isSales = aiJudged ? ai.salesIntent === true : hasAnyKeyword(text, LEAD_TYPE_KEYWORDS.sales_intent);
  if (isSales) return 'sales_intent';

  const category = normalizeText(comment.category);
  if (category === 'safety_rescue' || category === 'privacy') return 'safety_privacy';
  if (category === 'app_issue') return 'app_issue';
  if (category === 'renewal_billing') return 'renewal_billing';
  if (category === 'service_quality') return 'service_quality';
  if (category === 'brand_image') return 'brand_risk';

  if (hasAnyKeyword(text, LEAD_TYPE_KEYWORDS.complaint)) return 'complaint';
  if (hasAnyKeyword(text, LEAD_TYPE_KEYWORDS.safety_privacy)) return 'safety_privacy';
  if (hasAnyKeyword(text, LEAD_TYPE_KEYWORDS.app_issue)) return 'app_issue';
  if (hasAnyKeyword(text, LEAD_TYPE_KEYWORDS.renewal_billing)) return 'renewal_billing';
  if (hasAnyKeyword(text, LEAD_TYPE_KEYWORDS.service_quality)) return 'service_quality';
  if (hasAnyKeyword(text, LEAD_TYPE_KEYWORDS.brand_risk)) return 'brand_risk';
  return 'other';
}

export function resolvePriority(comment) {
  const risk = normalizeText(comment.risk_level);
  const likes = cleanNumber(comment.like_count);
  if (risk === 'critical' || risk === 'high') return 'urgent';
  if (risk === 'medium' || likes >= 20) return 'high';
  if (risk === 'low' || likes >= 5) return 'normal';
  return 'low';
}

function shouldCreateLead(comment) {
  if (!comment || comment.is_official) return false;
  // 真实购买意向也要建线索(进销售客资),即便情绪正向/中性
  const ai = normalizeAiResult(comment.ai_result);
  if (ai && ai.salesIntent === true) return true;
  const risk = normalizeText(comment.risk_level);
  return Boolean(
    comment.is_negative ||
    comment.sentiment === 'negative' ||
    ['low', 'medium', 'high', 'critical'].includes(risk)
  );
}

export function leadReason(comment) {
  const aiResult = normalizeAiResult(comment.ai_result);
  return normalizeText(
    comment.ai_summary ||
    aiResult.reason ||
    aiResult.summary ||
    '评论存在舆情跟进价值'
  ).slice(0, 240);
}

export async function upsertCommentLeadForComment(tx, { tenantId, record = {}, comment = {} }) {
  if (!shouldCreateLead(comment)) return null;

  const leadType = resolveLeadType(comment);
  const priority = resolvePriority(comment);
  const matchedKeywords = matchedKeywordsFor(comment, record);
  const aiResult = normalizeAiResult(comment.ai_result);
  const recordTitle = normalizeText(record.title || record.content || '').slice(0, 240);

  return await tx.queryOne(`
    INSERT INTO comment_leads (
      tenant_id, record_id, comment_id, platform, lead_type, priority, status,
      record_title, record_url, comment_author_name, comment_author_id,
      comment_ip_location, comment_content, comment_like_count,
      matched_keywords, reason, ai_result, captured_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, 'new',
      $7, $8, $9, $10,
      $11, $12, $13,
      $14::jsonb, $15, $16::jsonb, COALESCE($17::timestamptz, now())
    )
    ON CONFLICT (tenant_id, comment_id)
    DO UPDATE SET
      record_id = excluded.record_id,
      platform = excluded.platform,
      lead_type = excluded.lead_type,
      -- 复发:已归档(resolved/ignored)或已转工单(ticketed,且无在途工单)的评论,
      -- 二次采集时点赞较上次明显上涨(>+10),自动回到待处理(new)并记复发时间
      status = CASE
        WHEN comment_leads.status IN ('resolved', 'ignored', 'ticketed')
          AND excluded.comment_like_count > comment_leads.comment_like_count + 10
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.tenant_id = comment_leads.tenant_id AND t.source_comment_id = comment_leads.id AND t.status <> 'closed')
        THEN 'new'
        ELSE comment_leads.status
      END,
      last_risk_reopened_at = CASE
        WHEN comment_leads.status IN ('resolved', 'ignored', 'ticketed')
          AND excluded.comment_like_count > comment_leads.comment_like_count + 10
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.tenant_id = comment_leads.tenant_id AND t.source_comment_id = comment_leads.id AND t.status <> 'closed')
        THEN now()
        ELSE comment_leads.last_risk_reopened_at
      END,
      priority = CASE
        WHEN comment_leads.status IN ('new', 'following', 'ticketed') THEN excluded.priority
        ELSE comment_leads.priority
      END,
      record_title = excluded.record_title,
      record_url = excluded.record_url,
      comment_author_name = excluded.comment_author_name,
      comment_author_id = excluded.comment_author_id,
      comment_ip_location = excluded.comment_ip_location,
      comment_content = excluded.comment_content,
      comment_like_count = excluded.comment_like_count,
      matched_keywords = excluded.matched_keywords,
      reason = excluded.reason,
      ai_result = excluded.ai_result,
      captured_at = excluded.captured_at,
      updated_at = now()
    RETURNING *
  `, [
    tenantId,
    record.id,
    comment.id,
    comment.platform || record.platform || 'unknown',
    leadType,
    priority,
    recordTitle,
    record.url || '',
    comment.author_name || '',
    comment.author_id || '',
    comment.ip_location || '',
    comment.content || '',
    cleanNumber(comment.like_count),
    JSON.stringify(matchedKeywords),
    leadReason(comment),
    JSON.stringify(aiResult),
    comment.last_seen_at || comment.created_at || null,
  ]);
}
