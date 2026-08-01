/**
 * AI 标签引擎 — 多 LLM 提供商支持
 */

import { queryOne, queryAll, getSetting } from '../db/init.js';
import {runWithTenantAiAdmission} from './ai-admission.js';
import { parsePublishTimestamp } from './publish-date.js';
import {
  formatMonitoringIntentForPrompt,
  resolveMonitoringIntent,
} from './monitoring-intent.js';

export const RECORD_CLASSIFICATION_PROMPT_VERSION = 'record-topic-v2';
const RETRYABLE_MODEL_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

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

export async function getBrandContext(tenantId) {
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

export function buildSystemPrompt(brand, intent = {}) {
  return `你是一个可配置品牌的舆情分析专家。当前品牌：${brand.brandName}。
品牌别名：${brand.brandAliases.join('、') || brand.brandName}。
业务语境：${brand.businessContext}
强相关语境词：${brand.positiveContextTerms.join('、') || '无'}。
常见误命中/噪声：${brand.noiseTerms.join('、') || '无'}。

${formatMonitoringIntentForPrompt(intent)}

第一步判断内容是否符合【本次采集任务标准】，不是判断它是否宽泛涉及租户品牌家族：
- relevant：内容有证据同时指向本次任务的目标对象和目标主题。
- irrelevant：内容只涉及关联车型/品牌，却没有本次功能主题；或只是相似功能、泛行业话题、搜索词/标签/作者名巧合命中。
- uncertain：已经出现目标对象或目标功能的直接线索，但列表或正文信息残缺，暂时无法确认两者关系。不能因为“功能相似”就判 uncertain。

第二步先识别“内容实际评价的对象”，再判断情绪：
- sentiment 必须表示内容对本次监控对象/主题的态度，而不是整段文字里最强烈的情绪。
- 负面表达若指向其它品牌、其它产品或泛行业现象，不得判为对本次监控对象的 negative。
- 客观询问、故障确认、经验交流，且没有明显抱怨、指责或维权诉求时，判 neutral + inquiry。
- 内容相关与内容负面是两个独立结论；壁纸、教程、咨询可以 relevant 但 sentiment=neutral。
- “安全”“安全感”“隐私”等普通词本身不代表负面或风险；必须有明确的故障、隐患、泄露、威胁、抱怨等上下文证据。

校准样例：
- “别克威朗车轮抱死”在“别克哨兵”任务中 irrelevant：它是机械故障，不是哨兵/驻车监控。
- “至境E7胎噪”在“至境哨兵”任务中 irrelevant：它是车辆体验，不是哨兵功能。
- “凯迪拉克碰撞测试”在“凯迪拉克OTA”任务中 irrelevant：它没有软件升级主题。
- “安吉星反复提示更换空调滤芯，怎么关闭”可 relevant；若只是客观询问，则 sentiment=neutral、intent=inquiry。
- “安全感”“安全配置可靠”等正向表达不能据此生成风险或负面结论。

对每条内容，你需要输出以下JSON格式：

{
  "relevance": "relevant|irrelevant|uncertain",
  "relevanceConfidence": 0.0-1.0,
  "relevanceReason": "判断相关或无关的简短原因",
  "noiseType": "none|place_name|person_name|real_estate|store|homophone|generic_word|other",
  "targetEntity": "内容实际讨论或评价的对象",
  "sentimentTarget": "情绪实际指向的对象",
  "evidence": ["支持判断的原文短语"],
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
  · 重点识别「软文/KOE」:若内容像经销商或员工发的促销软文——例如过度正面无吐槽、含门店/优惠/试驾/报价/留微信电话等营销话术、强调"本店/到店"、像广告而非真实车主体验,优先判 dealer 或 employee(而非 ugc/pgc)。
  · 账号名信号:若作者账号名带本品牌或其别名/子品牌/产品/门店词，且像围绕该品牌运营(如带"官方""客服""旗舰店""XX店""服务中心""4S"等字样),多为经销商/员工/官方相关,优先判 dealer 或 employee。

规则：
- irrelevant 内容的 sentiment 固定为 neutral，category 固定为 other，summary 说明为何无关。
- uncertain 内容的 sentiment 尽量保守，能判断再给 positive/negative，不能判断则 neutral。
- 租户品牌背景只能帮助理解实体，不能覆盖本次采集任务的目标主题和排除项。
- 搜索关键词、话题标签和作者名称是召回线索，不是相关性结论。
- 只输出JSON，不要其他文字。`;
}

export function buildUserMessage(record) {
  let text = '';
  if (record.keyword) text += `采集关键词（仅表示召回入口，不代表一定相关）：${record.keyword}\n`;
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

export function modelRetryDelayMs(attempt, retryAfter = '') {
  const raw = String(retryAfter || '').trim();
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    return Math.max(100, Math.min(10000, Math.round(Number(raw) * 1000)));
  }
  const retryAt = Date.parse(raw);
  if (Number.isFinite(retryAt)) {
    return Math.max(100, Math.min(10000, retryAt - Date.now()));
  }
  return Math.min(5000, 500 * (2 ** Math.max(0, Number(attempt) || 0)));
}

async function requestModelResponse(url, buildRequest, errorPrefix) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, buildRequest());
    if (response.ok) return response;
    const responseText = await response.text();
    if (
      RETRYABLE_MODEL_HTTP_STATUSES.has(response.status) &&
      attempt < 2
    ) {
      const waitMs = modelRetryDelayMs(
        attempt,
        response.headers?.get?.('retry-after') || '',
      );
      console.warn('[AI] transient upstream response, retrying in slot', {
        status: response.status,
        attempt: attempt + 1,
        waitMs,
      });
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }
    const error = new Error(
      `${errorPrefix} ${response.status}: ${responseText}`,
    );
    error.status = response.status;
    error.code = response.status === 429
      ? 'LLM_RATE_LIMITED'
      : 'LLM_HTTP_ERROR';
    throw error;
  }
  throw new Error(`${errorPrefix}: retry exhausted`);
}

async function callGemini(apiKey, model, systemPrompt, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await requestModelResponse(url, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(40000), // 防止 LLM 请求挂死冻住整个评论入库串行队列
  }), 'Gemini API error');
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return JSON.parse(text);
}

async function callOpenAICompatible(apiKey, model, endpoint, systemPrompt, userMessage, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.min(40000, Number(options.timeoutMs)))
    : 40000;
  const maxTokens = Number.isFinite(Number(options.maxTokens))
    ? Math.max(256, Math.min(8192, Number(options.maxTokens)))
    : undefined;
  const url = `${endpoint}/chat/completions`;
  const resp = await requestModelResponse(url, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs), // 前置筛选使用更短预算；现有标注默认仍为 40 秒
  }), 'LLM API error');
  const data = await resp.json();
  const content = String(data.choices?.[0]?.message?.content || '');
  const finishReason = String(data.choices?.[0]?.finish_reason || '');
  const metadata = {
    finishReason,
    responseLength: content.length,
    promptTokens: Math.max(0, Number(data.usage?.prompt_tokens) || 0),
    completionTokens: Math.max(0, Number(data.usage?.completion_tokens) || 0),
    totalTokens: Math.max(0, Number(data.usage?.total_tokens) || 0),
  };
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    const error = new Error(
      `LLM JSON 解析失败（finish_reason=${finishReason || 'unknown'}，响应 ${content.length} 字符）`,
    );
    error.code = 'LLM_JSON_PARSE_FAILED';
    error.finishReason = finishReason;
    error.responseLength = content.length;
    error.usage = data.usage || {};
    error.cause = cause;
    throw error;
  }
  return options.returnMetadata
    ? {data: parsed, ...metadata}
    : parsed;
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

/**
 * 前置相关性筛选只允许使用服务端保存的 DeepSeek 配置。
 * 扩展只提交待判断的最小文字字段，永远不会取得或传入模型 Key。
 */
export async function getDeepSeekConfig(tenantId) {
  const config = await getLLMConfig(tenantId);
  if (config.provider !== 'deepseek') {
    const err = new Error('AI 前置筛选要求租户后台将 LLM 提供商配置为 DeepSeek');
    err.code = 'DEEPSEEK_PROVIDER_REQUIRED';
    throw err;
  }
  if (!config.apiKey) {
    const err = new Error('租户后台尚未配置 DeepSeek API Key');
    err.code = 'DEEPSEEK_API_KEY_MISSING';
    throw err;
  }
  return {
    provider: 'deepseek',
    apiKey: config.apiKey,
    model: config.model || 'deepseek-chat',
    endpoint: String(config.endpoint || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
  };
}

export async function callDeepSeekWithPrompt(tenantId, systemPrompt, userMessage, options = {}) {
  const config = await getDeepSeekConfig(tenantId);
  const data = await runWithTenantAiAdmission(
    tenantId,
    () => callOpenAICompatible(
      config.apiKey,
      config.model,
      config.endpoint,
      systemPrompt,
      userMessage,
      {
        timeoutMs: options.timeoutMs,
        maxTokens: options.maxTokens,
        returnMetadata: options.returnMetadata === true,
      },
    ),
    {
      priority: options.priority || 'capture',
      kind: options.kind || 'relevance_prefilter',
      queueTimeoutMs: options.queueTimeoutMs,
    },
  );
  if (options.returnMetadata) {
    return {
      data: data.data,
      provider: config.provider,
      model: config.model,
      finishReason: data.finishReason,
      responseLength: data.responseLength,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      totalTokens: data.totalTokens,
    };
  }
  return data;
}

async function callLLM(userMessage, tenantId, keyword = '', options = {}) {
  const config = await getLLMConfig(tenantId);
  if (!config.apiKey) { console.warn('[AI] No API key configured, skipping'); return null; }
  const brand = await getBrandContext(tenantId);
  const intent = resolveMonitoringIntent(keyword, { brand });
  const systemPrompt = buildSystemPrompt(brand, intent);
  const result = await runWithTenantAiAdmission(
    tenantId,
    () => config.provider === 'gemini'
      ? callGemini(config.apiKey, config.model, systemPrompt, userMessage)
      : callOpenAICompatible(
        config.apiKey,
        config.model,
        config.endpoint,
        systemPrompt,
        userMessage,
      ),
    {
      priority: options.priority || 'normal',
      kind: options.kind || 'record_classification',
      queueTimeoutMs: options.queueTimeoutMs,
    },
  );
  return { result, intent, provider: config.provider, model: config.model };
}

export async function callLLMWithPrompt(tenantId, systemPrompt, userMessage, options = {}) {
  const config = await getLLMConfig(tenantId);
  if (!config.apiKey) { console.warn('[AI] No API key configured, skipping'); return null; }
  return await runWithTenantAiAdmission(
    tenantId,
    () => config.provider === 'gemini'
      ? callGemini(config.apiKey, config.model, systemPrompt, userMessage)
      : callOpenAICompatible(
        config.apiKey,
        config.model,
        config.endpoint,
        systemPrompt,
        userMessage,
        options,
      ),
    {
      priority: options.priority || 'normal',
      kind: options.kind || 'llm_prompt',
      queueTimeoutMs: options.queueTimeoutMs,
    },
  );
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

/**
 * 分类落库后的派生任务统一从这里异步触发。
 * 动态导入避免 ai-labeler ↔ opinion-analysis 的静态循环依赖；任何失败只记日志，
 * 不影响分类主链路，也不会让同步接口因深度剖析失败而失败。
 */
function queuePostClassificationTasks({ recordId, tenantId, relevance, sentiment }) {
  setImmediate(async () => {
    try {
      if (relevance !== 'irrelevant' || sentiment === 'negative') {
        const { checkAlerts } = await import('./alert-engine.js');
        await checkAlerts(recordId);
      }
    } catch (err) {
      console.error(`[AI] Alert check failed for record ${recordId}:`, err?.message || err);
    }

    if (sentiment !== 'negative') return;
    try {
      const { queueNegativeRecordAnalysis } = await import('./opinion-analysis.js');
      void queueNegativeRecordAnalysis({ tenantId, recordId });
    } catch (err) {
      console.error(`[AI] Negative analysis dispatch failed for record ${recordId}:`, err?.message || err);
    }
  });
}

export async function labelRecord(recordId, options = {}) {
  const record = await queryOne('SELECT * FROM records WHERE id = $1', [recordId]);
  if (['official_content', 'blogger_profile'].includes(record?.record_type)) return null;
  if (!record || (!options.force && record.ai_labeled_at && hasRelevanceResult(record))) return null;

  const userMessage = buildUserMessage(record);
  try {
    const labeled = await callLLM(
      userMessage,
      record.tenant_id,
      record.keyword,
      {priority: 'normal', kind: 'record_classification'},
    );
    if (!labeled?.result) return null;
    const result = {
      ...normalizeResult(labeled.result),
      classifierMetadata: {
        promptVersion: RECORD_CLASSIFICATION_PROMPT_VERSION,
        provider: labeled.provider,
        model: labeled.model,
        monitoringIntentId: labeled.intent.intentId,
        monitoringIntentVersion: labeled.intent.intentVersion,
        monitoringObjective: labeled.intent.objective,
      },
    };
    const publishedTs = String(record.publish_time || '').trim() ? parsePublishTimestamp(record.publish_time, record.created_at) : null;
    const persisted = await queryOne(`
      UPDATE records SET
        sentiment = CASE
          WHEN COALESCE(manual_overrides, '{}'::jsonb) ? 'sentiment' THEN sentiment
          ELSE $1
        END,
        intent = $2,
        category = CASE
          WHEN COALESCE(manual_overrides, '{}'::jsonb) ? 'category' THEN category
          ELSE $3
        END,
        subcategory = $4,
        source_type = $5, ai_summary = $6, ai_confidence = $7,
        ai_result = $8::jsonb,
        published_ts = CASE
          WHEN COALESCE(manual_overrides, '{}'::jsonb) ? 'publish_time' THEN published_ts
          ELSE COALESCE($9, published_ts)
        END,
        ai_labeled_at = now(), updated_at = now()
      WHERE id = $10
      RETURNING tenant_id, sentiment
    `, [
      result.sentiment || '', result.intent || '', result.category || '', result.subcategory || '',
      result.sourceType || result.source_type || '', result.summary || '', result.confidence || 0,
      JSON.stringify(result),
      publishedTs,
      recordId,
    ]);
    console.log(`[AI] Record ${recordId} labeled: ${result.relevance}/${result.sentiment}/${result.category}`);
    if (persisted) {
      queuePostClassificationTasks({
        recordId,
        tenantId: persisted.tenant_id,
        relevance: result.relevance,
        sentiment: persisted.sentiment,
      });
    }
    return result;
  } catch (err) {
    console.error(`[AI] Label error for record ${recordId}:`, err.message);
    return null;
  }
}

export async function labelPendingRecords(limit = 50) {
  const records = await queryAll(
    `SELECT id FROM records
     WHERE record_type NOT IN ('official_content', 'blogger_profile')
       AND (ai_labeled_at IS NULL OR ai_result->>'relevance' IS NULL)
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

export function buildCommentSystemPrompt(brand) {
  return `你是一个可配置品牌的社交媒体评论舆情分析专家。当前品牌：${brand.brandName}。
品牌别名：${brand.brandAliases.join('、') || brand.brandName}。
业务语境：${brand.businessContext}

你要判断“评论本身”对当前品牌/产品/服务的态度和风险。注意：
- 不要只按关键词判断。“不续费”“收费”“不能用”“贵”可能是事实说明、价格讨论、使用选择，也可能是投诉，必须结合语气和上下文。
- 不能根据“安全”等单个词或固定短语直接定性，必须结合完整句意、原帖上下文和评价对象做语义判断。例如“安全感满满/安全感时刻在线”通常是正向，“安全座椅”本身是中性；“开着总提心吊胆，一点安全感都没有”才可能是负面。
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

export function buildCommentBatchSystemPrompt(brand) {
  return `你是可配置品牌的社交媒体评论舆情分析专家。当前品牌：${brand.brandName}。
品牌别名：${brand.brandAliases.join('、') || brand.brandName}。
业务语境：${brand.businessContext}

你会收到同一篇帖子下的一批评论(JSON 数组,每条带序号 i)。请逐条判断每条评论本身对该品牌/产品/服务的态度与风险。判断要点:
- 不要只按关键词。“不续费/收费/不能用/贵”可能是事实说明、价格讨论或使用选择,也可能是投诉,要结合语气与上下文。
- 不能根据“安全”等单个词或固定短语直接定性,必须结合完整句意、原帖上下文和评价对象做语义判断。例如“安全感满满/安全感时刻在线”通常是正向,“安全座椅”本身是中性;“开着总提心吊胆,一点安全感都没有”才可能是负面。
- 只有明确抱怨、投诉、故障、乱扣费、服务不满、安全/隐私风险、强烈负面情绪时,isNegative=true。
- “不算贵/免费/可以/有用/不会不提供服务/开的不多用不了几次/不用续”通常中性或正向,不应判负面。
- 仅客观说明、个人选择、轻微吐槽且无明确诉求 → neutral;认可、解释、澄清、推荐 → positive 或 neutral。
- salesIntent:仅当评论方明确“想买/询价/求购买链接/问哪里买/问优惠/要门店或经销商/留联系方式求购/想试驾预约”等成交导向时才 true;吐槽续费/收费/退费/价格不满都是投诉,salesIntent=false。

只输出一个 JSON 对象(顶层不要是数组),格式:
{"results":[{"i":0,"sentiment":"positive|neutral|negative","isNegative":true|false,"salesIntent":true|false,"category":"safety_rescue|feature_usage|renewal_billing|privacy|app_issue|service_quality|brand_image|official_response|other","riskLevel":"none|low|medium|high|critical","summary":"不超过30字"}]}
必须为输入里每一条 i 都返回一个对应结果,不得遗漏或改变 i。`;
}

function buildCommentBatchUserMessage({ record = {}, comments = [] }) {
  const head = [];
  if (record.title) head.push(`原帖标题：${record.title}`);
  if (record.content) head.push(`原帖正文：${String(record.content).slice(0, 800)}`);
  if (record.category) head.push(`原帖主题：${record.category}`);
  if (record.sentiment) head.push(`原帖情绪：${record.sentiment}`);
  if (record.platform) head.push(`平台：${record.platform}`);
  const arr = comments.map((c, i) => ({
    i,
    author: String(c.author_name || '').slice(0, 40),
    content: String(c.content || '').slice(0, 300),
    likes: Number(c.like_count || 0),
    ip: String(c.ip_location || '').slice(0, 20),
  }));
  return `${head.join('\n')}\n\n评论数组(逐条判断,按 i 一一对应返回):\n${JSON.stringify(arr)}`;
}

// 批量评论分类:一次 LLM 调用判一整批同帖评论,把"逐条一调用"压成"一批一调用"。
// 返回与输入等长的数组,元素为归一化结果或 null(该条 LLM 没返回→由调用方回退规则)。
// 抛错(超时/接口错)由调用方 catch,整批回退规则。
export async function classifyCommentsBatch({ tenantId, record = {}, comments = [] }) {
  if (!comments.length) return [];
  const brand = await getBrandContext(tenantId);
  const systemPrompt = buildCommentBatchSystemPrompt(brand);
  const userMessage = buildCommentBatchUserMessage({ record, comments });
  const parsed = await callLLMWithPrompt(
    tenantId,
    systemPrompt,
    userMessage,
    {priority: 'background', kind: 'comment_batch_classification'},
  );
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.results) ? parsed.results : []);
  const byIndex = new Map();
  for (const item of list) {
    const idx = Number(item?.i ?? item?.index);
    if (Number.isInteger(idx)) byIndex.set(idx, item);
  }
  return comments.map((_, i) => {
    const raw = byIndex.get(i);
    return raw ? normalizeCommentAiResult(raw, null) : null;
  });
}

export async function classifyCommentWithAI({ tenantId, record = {}, comment = {}, isOfficial = false, fallback = null }) {
  if (isOfficial) return null;
  const brand = await getBrandContext(tenantId);
  const systemPrompt = buildCommentSystemPrompt(brand);
  const userMessage = buildCommentUserMessage({ record, comment });
  try {
    const result = await callLLMWithPrompt(
      tenantId,
      systemPrompt,
      userMessage,
      {priority: 'background', kind: 'comment_classification'},
    );
    if (!result) return null;
    return normalizeCommentAiResult(result, fallback);
  } catch (err) {
    console.error('[AI] Comment classify error:', err.message);
    return null;
  }
}
