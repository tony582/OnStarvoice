/**
 * AI 标签引擎 — 多 LLM 提供商支持
 */

import { queryOne, queryAll, execute, getSetting } from '../db/init.js';

const DEFAULT_BRAND_CONTEXT = {
  brandName: '安吉星',
  brandAliases: ['OnStar', '安吉星'],
  businessContext: '汽车车联网、车辆安全救援、远程控制、车况检测、客服、续费和车主服务。',
  positiveContextTerms: ['OnStar', '安吉星', '车联网', '车主', '车辆', '汽车', '远程启动', '远程控制', '车况检测', '道路救援', '紧急救援', 'SOS', '续费', '套餐', '客服', 'App', '车机', '定位', '流量', '别克', '凯迪拉克', '雪佛兰'],
  noiseTerms: ['安吉县', '安吉', '地名', '小区', '楼盘', '酒店', '民宿', '景区', '招聘', '店铺', '人名', '谐音', '星座', '明星', '宠物', '餐饮'],
};

function splitSetting(value, fallback = []) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text
    .split(/[,，\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

async function getBrandContext(tenantId) {
  const brandName = (await getSetting('brand_name', tenantId)) || DEFAULT_BRAND_CONTEXT.brandName;
  const brandAliases = splitSetting(await getSetting('brand_aliases', tenantId), DEFAULT_BRAND_CONTEXT.brandAliases);
  const businessContext = (await getSetting('brand_business_context', tenantId)) || DEFAULT_BRAND_CONTEXT.businessContext;
  const positiveContextTerms = splitSetting(
    await getSetting('brand_relevance_terms', tenantId),
    DEFAULT_BRAND_CONTEXT.positiveContextTerms
  );
  const noiseTerms = splitSetting(
    await getSetting('brand_noise_terms', tenantId),
    DEFAULT_BRAND_CONTEXT.noiseTerms
  );
  return { brandName, brandAliases, businessContext, positiveContextTerms, noiseTerms };
}

function buildSystemPrompt(brand) {
  return `你是一个可配置品牌的舆情分析专家。当前品牌：${brand.brandName}。
品牌别名：${brand.brandAliases.join('、') || brand.brandName}。
业务语境：${brand.businessContext}
强相关语境词：${brand.positiveContextTerms.join('、') || '无'}。
常见误命中/噪声：${brand.noiseTerms.join('、') || '无'}。

第一步必须先判断内容是否与当前品牌真实相关。搜索关键词命中不代表相关；如果只是地名、人名、小区、楼盘、店铺、谐音、泛词、无车辆/产品/服务语境，判为 irrelevant。
如果证据不足但可能相关，判为 uncertain，不要强行判负面或正面。
只有 relevant 或 uncertain 的内容才继续判断情绪、意图和主题。

对每条内容，你需要输出以下JSON格式：

{
  "relevance": "relevant|irrelevant|uncertain",
  "relevanceConfidence": 0.0-1.0,
  "relevanceReason": "判断相关或无关的简短原因",
  "noiseType": "none|place_name|person_name|real_estate|store|homophone|generic_word|other",
  "sentiment": "positive|neutral|negative",
  "intent": "inquiry|complaint|share|suggestion|other",
  "category": "safety_rescue|feature_usage|renewal_billing|privacy|app_issue|service_quality|brand_image|other",
  "subcategory": "具体子分类（中文）",
  "sourceType": "ugc|pgc|employee|dealer|other",
  "confidence": 0.0-1.0,
  "summary": "一句话概括核心内容（不超过50字）"
}

分类说明：
- sentiment: positive(推荐、好评、感谢), neutral(普通分享、使用教程), negative(投诉、吐槽、故障)
- intent: inquiry(咨询问题), complaint(投诉维权), share(分享体验), suggestion(建议改进), other
- category:
  - safety_rescue: SOS紧急救援、碰撞自动求助、道路救援
  - feature_usage: 远程启动、车况检测、车辆定位、OTA升级、车机流量
  - renewal_billing: 续费、收费、过期、不续费、费用争议
  - privacy: 信息泄露、数据安全、隐私保护
  - app_issue: App登录、绑定、故障、闪退
  - service_quality: 客服体验、4S店服务、售后
  - brand_image: 品牌评价、竞品对比
  - other: 其他
- sourceType: ugc(真实车主/普通用户), pgc(自媒体/KOL/测评), employee(疑似员工), dealer(4S店/经销商), other

规则：
- irrelevant 内容的 sentiment 固定为 neutral，category 固定为 other，summary 说明为何无关。
- uncertain 内容的 sentiment 尽量保守，能判断再给 positive/negative，不能判断则 neutral。
- 不要因为标题里有品牌词或搜索词就直接判 relevant，必须结合正文、标签、作者、平台和业务语境。
- 只输出JSON，不要其他文字。`;
}

function buildUserMessage(record) {
  let text = '';
  if (record.title) text += `标题：${record.title}\n`;
  if (record.content) text += `正文：${record.content.slice(0, 2000)}\n`;
  if (record.author_name) text += `作者：${record.author_name}\n`;
  if (record.platform) text += `平台：${record.platform}\n`;
  if (record.tags) {
    try {
      const tags = Array.isArray(record.tags) ? record.tags : JSON.parse(record.tags);
      if (tags.length > 0) text += `标签：${tags.join(', ')}\n`;
    } catch {}
  }
  if (record.likes || record.comments_count || record.collects || record.shares) {
    text += `互动：${record.likes}赞 ${record.comments_count}评论 ${record.collects}收藏 ${record.shares || 0}转发\n`;
  }
  return text || '(空内容)';
}

async function callGemini(apiKey, model, systemPrompt, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    }),
  });
  if (!resp.ok) throw new Error(`Gemini API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return JSON.parse(text);
}

async function callOpenAICompatible(apiKey, model, endpoint, systemPrompt, userMessage) {
  const url = `${endpoint}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) throw new Error(`LLM API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '');
}

async function getLLMConfig(tenantId) {
  const provider = ((await getSetting('llm_provider', tenantId)) || process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const apiKey = (await getSetting('llm_api_key', tenantId)) || process.env.LLM_API_KEY || '';
  const model = (await getSetting('llm_model', tenantId)) || process.env.LLM_MODEL || '';
  const endpoint = (await getSetting('llm_api_endpoint', tenantId)) || process.env.LLM_API_ENDPOINT || '';
  const defaults = {
    gemini: { model: 'gemini-2.0-flash', endpoint: '' },
    openai: { model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1' },
    deepseek: { model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1' },
    qianwen: { model: 'qwen-turbo', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  };
  const d = defaults[provider] || defaults.gemini;
  return { provider, apiKey, model: model || d.model, endpoint: endpoint || d.endpoint };
}

async function callLLM(userMessage, tenantId) {
  const config = await getLLMConfig(tenantId);
  if (!config.apiKey) { console.warn('[AI] No API key configured, skipping'); return null; }
  const brand = await getBrandContext(tenantId);
  const systemPrompt = buildSystemPrompt(brand);
  if (config.provider === 'gemini') return await callGemini(config.apiKey, config.model, systemPrompt, userMessage);
  return await callOpenAICompatible(config.apiKey, config.model, config.endpoint, systemPrompt, userMessage);
}

export async function callLLMWithPrompt(tenantId, systemPrompt, userMessage) {
  const config = await getLLMConfig(tenantId);
  if (!config.apiKey) { console.warn('[AI] No API key configured, skipping'); return null; }
  if (config.provider === 'gemini') return await callGemini(config.apiKey, config.model, systemPrompt, userMessage);
  return await callOpenAICompatible(config.apiKey, config.model, config.endpoint, systemPrompt, userMessage);
}

function normalizeRelevance(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['relevant', 'irrelevant', 'uncertain'].includes(normalized)) return normalized;
  return 'relevant';
}

function normalizeResult(result) {
  const relevance = normalizeRelevance(result?.relevance);
  const normalized = {
    ...result,
    relevance,
    relevanceConfidence: Number(result?.relevanceConfidence ?? result?.relevance_confidence ?? result?.confidence ?? 0),
    relevanceReason: String(result?.relevanceReason || result?.relevance_reason || ''),
    noiseType: String(result?.noiseType || result?.noise_type || (relevance === 'irrelevant' ? 'other' : 'none')),
  };
  if (relevance === 'irrelevant') {
    normalized.sentiment = 'neutral';
    normalized.intent = 'other';
    normalized.category = 'other';
    normalized.subcategory = normalized.noiseType || '无关内容';
    normalized.summary = normalized.summary || normalized.relevanceReason || '与当前品牌无关';
  }
  return normalized;
}

function hasRelevanceResult(record) {
  const aiResult = record?.ai_result;
  if (aiResult && typeof aiResult === 'object' && !Array.isArray(aiResult)) return Boolean(aiResult.relevance);
  if (!aiResult || typeof aiResult !== 'string') return false;
  try {
    const parsed = JSON.parse(aiResult);
    return Boolean(parsed?.relevance);
  } catch {
    return false;
  }
}

export async function labelRecord(recordId, options = {}) {
  const record = await queryOne('SELECT * FROM records WHERE id = $1', [recordId]);
  if (!record || (!options.force && record.ai_labeled_at && hasRelevanceResult(record))) return null;

  const userMessage = buildUserMessage(record);
  try {
    const rawResult = await callLLM(userMessage, record.tenant_id);
    if (!rawResult) return null;
    const result = normalizeResult(rawResult);
    await execute(`
      UPDATE records SET sentiment = $1, intent = $2, category = $3, subcategory = $4,
        source_type = $5, ai_summary = $6, ai_confidence = $7,
        ai_result = $8::jsonb,
        ai_labeled_at = now(), updated_at = now()
      WHERE id = $9
    `, [
      result.sentiment || '', result.intent || '', result.category || '', result.subcategory || '',
      result.sourceType || result.source_type || '', result.summary || '', result.confidence || 0,
      JSON.stringify(result),
      recordId,
    ]);
    console.log(`[AI] Record ${recordId} labeled: ${result.relevance}/${result.sentiment}/${result.category}`);
    return result;
  } catch (err) {
    console.error(`[AI] Label error for record ${recordId}:`, err.message);
    return null;
  }
}

export async function labelPendingRecords(limit = 50) {
  const records = await queryAll(
    `SELECT id FROM records
     WHERE ai_labeled_at IS NULL OR ai_result->>'relevance' IS NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  let labeled = 0;
  for (const record of records) {
    const result = await labelRecord(record.id);
    if (result) labeled++;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`[AI] Batch labeled ${labeled}/${records.length} records`);
  return { total: records.length, labeled };
}

function buildCommentSystemPrompt(brand) {
  return `你是一个可配置品牌的社交媒体评论舆情分析专家。当前品牌：${brand.brandName}。
品牌别名：${brand.brandAliases.join('、') || brand.brandName}。
业务语境：${brand.businessContext}

你要判断“评论本身”对当前品牌/产品/服务的态度和风险。注意：
- 不要只按关键词判断。“不续费”“收费”“不能用”“贵”可能是事实说明、价格讨论、使用选择，也可能是投诉，必须结合语气和上下文。
- 只有明确抱怨、投诉、故障、乱扣费、服务不满、安全/隐私风险、强烈负面情绪时，才标记 isNegative=true。
- “不算贵”“免费”“可以”“有用”“不会不提供服务”“开的不多用不了几次”“不用续”这类通常是中性或正向澄清，不应标为负面。
- 如果评论只是客观说明、个人选择、轻微吐槽但没有明确问题或诉求，标为 neutral。
- 如果评论在认可、解释、澄清、推荐，标为 positive 或 neutral。
- salesIntent(是否真实购买/咨询意向):只有评论方在“想买/询价/求购买链接/问哪里买/问价格优惠/要门店或经销商/留联系方式求购/想试驾预约”等明确成交导向时才 true。注意:吐槽里提到“续费/收费/电话/不续费/贵”、抱怨被催续费、要求退费、对价格不满,都是投诉而非购买意向,salesIntent=false。

只输出 JSON：
{
  "sentiment": "positive|neutral|negative",
  "isNegative": true|false,
  "salesIntent": true|false,
  "category": "safety_rescue|feature_usage|renewal_billing|privacy|app_issue|service_quality|brand_image|official_response|other",
  "riskLevel": "none|low|medium|high|critical",
  "confidence": 0.0-1.0,
  "reason": "一句话说明为什么这样判断",
  "summary": "评论要点，不超过40字"
}`;
}

function buildCommentUserMessage({ record = {}, comment = {} }) {
  const lines = [];
  if (record.title) lines.push(`原帖标题：${record.title}`);
  if (record.content) lines.push(`原帖正文：${String(record.content).slice(0, 1200)}`);
  if (record.category) lines.push(`原帖主题：${record.category}`);
  if (record.sentiment) lines.push(`原帖情绪：${record.sentiment}`);
  if (record.platform) lines.push(`平台：${record.platform}`);
  if (comment.author_name) lines.push(`评论作者：${comment.author_name}`);
  if (comment.content) lines.push(`评论内容：${comment.content}`);
  if (comment.like_count) lines.push(`评论点赞：${comment.like_count}`);
  if (comment.ip_location) lines.push(`评论IP：${comment.ip_location}`);
  return lines.join('\n') || '(空评论)';
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(text)) return true;
    if (['false', '0', 'no', 'n'].includes(text)) return false;
  }
  return fallback;
}

function normalizeCommentAiResult(result, fallback) {
  const rawSentiment = ['positive', 'neutral', 'negative'].includes(String(result?.sentiment || '').toLowerCase())
    ? String(result.sentiment).toLowerCase()
    : (fallback?.sentiment || 'neutral');
  const hasExplicitNegative = result?.isNegative !== undefined || result?.is_negative !== undefined;
  const isNegative = normalizeBoolean(
    result?.isNegative ?? result?.is_negative,
    rawSentiment === 'negative'
  );
  const sentiment = isNegative ? 'negative' : (hasExplicitNegative && rawSentiment === 'negative' ? 'neutral' : rawSentiment);
  const riskLevel = ['none', 'low', 'medium', 'high', 'critical'].includes(String(result?.riskLevel || result?.risk_level || '').toLowerCase())
    ? String(result.riskLevel || result.risk_level).toLowerCase()
    : (sentiment === 'negative' ? (fallback?.risk_level || 'low') : 'none');
  const category = String(result?.category || fallback?.category || (sentiment === 'negative' ? 'brand_image' : '')).trim();
  return {
    sentiment,
    category,
    risk_level: isNegative ? riskLevel : 'none',
    is_negative: isNegative && sentiment === 'negative',
    ai_summary: String(result?.summary || result?.reason || '').slice(0, 120),
    ai_result: {
      ...result,
      sentiment,
      isNegative: isNegative && sentiment === 'negative',
      salesIntent: normalizeBoolean(result?.salesIntent ?? result?.sales_intent, false),
      category,
      riskLevel: isNegative ? riskLevel : 'none',
      confidence: Number(result?.confidence ?? fallback?.confidence ?? 0),
      reason: String(result?.reason || ''),
      classifier: 'llm_comment',
    },
  };
}

export async function classifyCommentWithAI({ tenantId, record = {}, comment = {}, isOfficial = false, fallback = null }) {
  if (isOfficial) return null;
  const brand = await getBrandContext(tenantId);
  const systemPrompt = buildCommentSystemPrompt(brand);
  const userMessage = buildCommentUserMessage({ record, comment });
  try {
    const result = await callLLMWithPrompt(tenantId, systemPrompt, userMessage);
    if (!result) return null;
    return normalizeCommentAiResult(result, fallback);
  } catch (err) {
    console.error('[AI] Comment classify error:', err.message);
    return null;
  }
}
