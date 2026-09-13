// This contract controls sales routing only. It must never filter captured comments.
export const COMMENT_SALES_PROMPT_VERSION = 'comment-sales-v2';
export const SALES_INTENT_MIN_CONFIDENCE = 0.75;

export const COMMENT_SALES_PROMPT_RULES = `销售客资判断（与评论情绪、风险独立）：
- 先识别发言主体 salesActor：buyer=评论者本人正在求购或咨询，seller=卖家报价/广告/引导私聊，third_party=转述他人或促销话术，unknown=不明。卖家的销售行为不等于买家的购买意向。
- 再识别实际购买对象 salesIntentTarget 与租户业务的关系 salesTargetMatch：relevant/irrelevant/uncertain。不得把任何品牌的购车、价格讨论都算当前品牌的客资；仅原帖相关或关键词命中不足以证明评论的购买对象相关。
- 结合原帖和被回复评论识别 expressionType：literal=真实直接表达，sarcasm=暗讽/反讽，rhetorical=反问，negated=否定购买，quoted=引用转述，uncertain=语境不足。正面措辞、询价、想买、求链接等词也可能是暗讽；先理解整句话，再判断成交意向。不要仅凭表情、问号或原帖负面否定真实需求。
- salesIntent=true 只用于评论者本人对目标业务的真实、当前购买/咨询/试驾/预约需求；必须同时提供 salesIntentEvidence（逐字摘录评论原文中的意向证据）、salesIntentConfidence（0到1）和 salesIntentReason（说明主体、对象、语气为何支持结论）。信心不足或缺关键上下文时 salesIntent=false，salesIntentStatus=needs_review，不能硬猜。
- 暗讽、反问、否定购买、卖方推广、转述邀约、已经购买后的故障/退款/续费投诉不等于当前求购，salesIntent=false。对真实投诉或暗讽的风险仍按语义判断，不得因移出销售客资而删掉或忽略评论。
- 评论对价格/旧产品有不满，但同时明确表达新的购买请求时，可保留真实意向；情绪 negative 本身不能否决购买意向。
- 校准：\"私。这里发不出来。有检测报告\"是卖家引导私聊；\"185包牌落地价\"是报价，均不是评论者本人求购。转述\"好消息！车机升级，您看要预留一个名额吗？\"是推广话术，不是本人预约。
- 校准：\"多少钱一年的智商税？\"、\"就这质量还想我下单？\"是质疑/反问，不是客资。\"2.1卖我吧[偷笑R]\"要结合原帖与回复对象判断议价还是调侃，信息不足待核实；不能仅凭表情判暗讽。\"价格有点高，但有优惠我想订，怎么联系？\"有真实咨询证据，不因负面词拒绝。
- followUpSuggestion 给出针对这条评论的下一步建议；suggestedReply 只提供供人工编辑的回复草稿。不编造价格、优惠、库存、联系方式或承诺，不声称已经联系用户。暗讽/投诉应先核实诉求和事实，避免推荐销售话术。`;

function text(value, limit = 500) {
  return String(value || '').trim().slice(0, limit);
}

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function truth(value) {
  return value === true || value === 1 || String(value).trim().toLowerCase() === 'true';
}

function choice(value, choices, fallback) {
  const normalized = text(value).toLowerCase();
  return choices.includes(normalized) ? normalized : fallback;
}

export function normalizeSalesLeadJudgment(result, {comment = {}} = {}) {
  const raw = object(result);
  const content = String(comment.content || comment.comment_content || '');
  const candidate = truth(raw.salesIntent ?? raw.sales_intent)
    || truth(raw.salesIntentCandidate)
    || raw.salesIntentStatus === 'needs_review';
  const expressionType = choice(raw.expressionType,
    ['literal', 'sarcasm', 'rhetorical', 'negated', 'quoted', 'uncertain'], 'uncertain');
  const salesActor = choice(raw.salesActor, ['buyer', 'seller', 'third_party', 'unknown'], 'unknown');
  const salesTargetMatch = choice(raw.salesTargetMatch, ['relevant', 'irrelevant', 'uncertain'], 'uncertain');
  const reportedConfidence = raw.salesIntentConfidence;
  const confidenceNumber = reportedConfidence === null || reportedConfidence === undefined || reportedConfidence === ''
    ? NaN : Number(reportedConfidence);
  const salesIntentConfidence = Number.isFinite(confidenceNumber) && confidenceNumber >= 0 && confidenceNumber <= 1
    ? confidenceNumber : null;
  const rawEvidence = Array.isArray(raw.salesIntentEvidence) ? raw.salesIntentEvidence : [];
  // Evidence must come from this comment, never the post, another commenter or invented text.
  const salesIntentEvidence = [...new Set(rawEvidence.map(value => text(value, 300)))]
    .filter(value => value && content.includes(value)).slice(0, 4);
  const disqualified = Boolean(comment.is_official) || raw.salesIntentStatus === 'rejected'
    || ['sarcasm', 'rhetorical', 'negated', 'quoted'].includes(expressionType)
    || ['seller', 'third_party'].includes(salesActor)
    || salesTargetMatch === 'irrelevant';
  const confirmed = candidate && raw.salesIntentStatus === 'confirmed'
    && !disqualified && expressionType === 'literal'
    && salesActor === 'buyer' && salesTargetMatch === 'relevant'
    && salesIntentConfidence !== null && salesIntentConfidence >= SALES_INTENT_MIN_CONFIDENCE
    && salesIntentEvidence.length > 0;
  const salesIntentStatus = confirmed ? 'confirmed'
    : disqualified ? 'rejected'
      : candidate ? 'needs_review' : 'none';
  const defaultReason = confirmed ? '评论者本人对目标业务表达了可核验的购买咨询需求'
    : disqualified ? '评论的主体、对象或语气不支持本人真实购买意向'
      : candidate ? '购买主体、目标对象、语境、置信度或原文证据不足，需人工核实'
        : '未识别评论者本人明确的购买咨询需求';
  return {
    salesIntent: confirmed,
    salesIntentCandidate: candidate,
    salesIntentStatus,
    salesIntentConfidence,
    salesIntentEvidence,
    salesIntentReason: salesIntentStatus === 'needs_review' && !text(raw.salesIntentReason).startsWith(defaultReason)
      ? `${defaultReason}${raw.salesIntentReason ? `；模型说明：${text(raw.salesIntentReason, 180)}` : ''}`
      : text(raw.salesIntentReason, 300) || defaultReason,
    salesIntentTarget: text(raw.salesIntentTarget, 120),
    salesActor,
    salesTargetMatch,
    expressionType,
    salesClassifierVersion: COMMENT_SALES_PROMPT_VERSION,
    followUpSuggestion: text(raw.followUpSuggestion, 500),
    suggestedReply: text(raw.suggestedReply, 800),
  };
}
