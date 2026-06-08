/**
 * AI 标签引擎 — 多 LLM 提供商支持
 */

import { queryOne, queryAll, execute, getSetting } from '../db/init.js';

const SYSTEM_PROMPT = `你是安吉星（OnStar）品牌的舆情分析专家。你的任务是对社交媒体上与安吉星相关的内容进行标签分类。

对每条内容，你需要输出以下JSON格式：

{
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

只输出JSON，不要其他文字。`;

function buildUserMessage(record) {
  let text = '';
  if (record.title) text += `标题：${record.title}\n`;
  if (record.content) text += `正文：${record.content.slice(0, 2000)}\n`;
  if (record.author_name) text += `作者：${record.author_name}\n`;
  if (record.platform) text += `平台：${record.platform}\n`;
  if (record.tags) {
    try {
      const tags = JSON.parse(record.tags);
      if (tags.length > 0) text += `标签：${tags.join(', ')}\n`;
    } catch {}
  }
  if (record.likes || record.comments_count || record.collects) {
    text += `互动：${record.likes}赞 ${record.comments_count}评论 ${record.collects}收藏\n`;
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

function getLLMConfig() {
  const provider = (getSetting('llm_provider') || process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const apiKey = getSetting('llm_api_key') || process.env.LLM_API_KEY || '';
  const model = getSetting('llm_model') || process.env.LLM_MODEL || '';
  const endpoint = getSetting('llm_api_endpoint') || process.env.LLM_API_ENDPOINT || '';
  const defaults = {
    gemini: { model: 'gemini-2.0-flash', endpoint: '' },
    openai: { model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1' },
    deepseek: { model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1' },
    qianwen: { model: 'qwen-turbo', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  };
  const d = defaults[provider] || defaults.gemini;
  return { provider, apiKey, model: model || d.model, endpoint: endpoint || d.endpoint };
}

async function callLLM(userMessage) {
  const config = getLLMConfig();
  if (!config.apiKey) { console.warn('[AI] No API key configured, skipping'); return null; }
  if (config.provider === 'gemini') return await callGemini(config.apiKey, config.model, SYSTEM_PROMPT, userMessage);
  return await callOpenAICompatible(config.apiKey, config.model, config.endpoint, SYSTEM_PROMPT, userMessage);
}

export async function labelRecord(recordId) {
  const record = queryOne('SELECT * FROM records WHERE id = ?', [recordId]);
  if (!record || record.ai_labeled_at) return null;

  const userMessage = buildUserMessage(record);
  try {
    const result = await callLLM(userMessage);
    if (!result) return null;
    execute(`
      UPDATE records SET sentiment = ?, intent = ?, category = ?, subcategory = ?,
        source_type = ?, ai_summary = ?, ai_confidence = ?,
        ai_labeled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `, [
      result.sentiment || '', result.intent || '', result.category || '', result.subcategory || '',
      result.sourceType || result.source_type || '', result.summary || '', result.confidence || 0,
      recordId,
    ]);
    console.log(`[AI] Record ${recordId} labeled: ${result.sentiment}/${result.category}`);
    return result;
  } catch (err) {
    console.error(`[AI] Label error for record ${recordId}:`, err.message);
    return null;
  }
}

export async function labelPendingRecords(limit = 50) {
  const records = queryAll(
    'SELECT id FROM records WHERE ai_labeled_at IS NULL ORDER BY created_at DESC LIMIT ?', [limit]
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
