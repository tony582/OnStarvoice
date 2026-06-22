/**
 * 视频逐字稿的 AI 舆情分析:基于口播逐字稿 + 标题,用 LLM 产出结构化洞察,
 * 让视频内容也参与舆情判断(标题/文案看不到的口播槽点能被捕捉)。
 * 复用 ai-labeler 的 callLLMWithPrompt(强制 JSON 输出、按租户 LLM 配置)。
 * 同步执行(LLM 一次调用,数秒),结果存 records.transcript_analysis(JSONB)持久化。
 */

import { queryOne, execute, getSetting } from '../db/init.js';
import { callLLMWithPrompt } from './ai-labeler.js';

function buildAnalysisPrompt(brandName, businessContext) {
  return `你是「${brandName || '目标品牌'}」的舆情分析专家。${businessContext ? `业务背景:${businessContext}。` : ''}
下面给你一条社交媒体视频的「口播逐字稿」(博主在视频里说的话)及其标题/正文。请站在品牌舆情角度做结构化分析,**只输出 JSON**,字段如下:
{
  "stance": "positive | neutral | negative",
  "summary": "一句话:这条视频在讲什么、对品牌是什么态度",
  "keyPoints": ["博主的核心观点/主张", "..."],
  "issues": ["提到的具体槽点/问题点(如年费贵、功能鸡肋、信号差等)", "..."],
  "risk": "对品牌口碑的潜在影响与风险判断(含高/中/低)",
  "userNeeds": ["从口播反映出的用户诉求/建议", "..."]
}
要求:严格基于逐字稿事实,不臆造;没有的字段用空数组/空字符串;简洁中文。`;
}

export async function analyzeTranscript({ tenantId, recordId }) {
  const record = await queryOne(
    `SELECT id, title, content, platform, transcript FROM records WHERE id = $1 AND tenant_id = $2`,
    [recordId, tenantId],
  );
  if (!record) return { ok: false, error: 'not_found', message: '内容不存在' };

  const transcript = String(record.transcript || '').trim();
  if (!transcript) return { ok: false, error: 'no_transcript', message: '请先生成逐字稿,再做 AI 分析' };

  const brandName = (await getSetting('brand_name', tenantId)) || '';
  const businessContext = (await getSetting('brand_business_context', tenantId)) || '';
  const systemPrompt = buildAnalysisPrompt(brandName, businessContext);
  const userMessage = [
    `标题:${record.title || ''}`,
    `正文:${record.content || ''}`,
    `平台:${record.platform || ''}`,
    '',
    '【视频口播逐字稿】',
    transcript.slice(0, 8000),
  ].join('\n');

  let result;
  try {
    result = await callLLMWithPrompt(tenantId, systemPrompt, userMessage);
  } catch (err) {
    return { ok: false, error: 'llm_error', message: String(err?.message || 'AI 分析失败').slice(0, 300) };
  }
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'no_api_key', message: '未配置 LLM API Key 或返回为空' };
  }

  await execute(
    `UPDATE records SET transcript_analysis = $3::jsonb, transcript_analysis_at = now() WHERE id = $1 AND tenant_id = $2`,
    [recordId, tenantId, JSON.stringify(result)],
  );
  return { ok: true, analysis: result };
}
