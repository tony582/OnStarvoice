import { callLLMWithPrompt } from './ai-labeler.js';

function clean(text, max = 400) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseTags(record) {
  const raw = record.tags;
  if (Array.isArray(raw)) return raw.map(t => clean(t, 30)).filter(Boolean);
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.map(t => clean(typeof t === 'string' ? t : t?.name, 30)).filter(Boolean) : [];
  } catch { return []; }
}

// 规则兜底:LLM 不可用时,给一个基础但有用的拆解骨架
function buildHitFallback(record) {
  const title = clean(record.title || record.content, 120);
  const tags = parseTags(record);
  const inter = Number(record.likes || 0) + Number(record.comments_count || 0) + Number(record.collects || 0) + Number(record.shares || 0);
  return {
    hook: title ? `开篇用「${title.slice(0, 18)}…」直给冲突/结果,3 秒抓住注意力` : '需观察开篇钩子',
    titleFormula: title.length > 0
      ? `「场景/痛点 + 结果反转 + 话题标签」——本条标题约 ${title.length} 字,信息密度高`
      : '标题信息不足',
    structure: [
      { part: '开头', desc: '抛出冲突或结果,制造好奇' },
      { part: '主体', desc: '用真实场景/案例展开,增强代入感' },
      { part: '结尾', desc: '引导互动(提问/共鸣),促评论转发' },
    ],
    tagStrategy: tags.length
      ? `共 ${tags.length} 个标签,混用「品牌词 + 场景词 + 热点词」扩大曝光:${tags.slice(0, 5).join(' ')}`
      : '未使用标签,建议补品牌词 + 场景词',
    template: title ? `仿写模板:【${title.slice(0, 12)}…】+【你的场景】+【结果反转】+【${tags.slice(0, 2).join(' ') || '#话题'}】` : '样本信息不足以生成模板',
    whyItWorks: `累计互动约 ${inter}:${inter >= 5000 ? '强情绪 + 强场景双驱动' : inter >= 1000 ? '场景共鸣带动互动' : '互动一般,可作参考'}`,
  };
}

function mergeHitAi(fallback, ai) {
  if (!ai || typeof ai !== 'object') return fallback;
  const structure = Array.isArray(ai.structure) && ai.structure.length
    ? ai.structure.slice(0, 6).map(s => ({ part: clean(s.part, 20) || '段落', desc: clean(s.desc, 160) }))
    : fallback.structure;
  return {
    hook: clean(ai.hook, 200) || fallback.hook,
    titleFormula: clean(ai.titleFormula, 200) || fallback.titleFormula,
    structure,
    tagStrategy: clean(ai.tagStrategy, 240) || fallback.tagStrategy,
    template: clean(ai.template, 400) || fallback.template,
    whyItWorks: clean(ai.whyItWorks, 240) || fallback.whyItWorks,
  };
}

const SYSTEM_PROMPT = `你是爆款内容拆解专家。基于一条社媒内容的标题/正文/标签/互动数据,反编译出可复刻的爆款要素,只输出 JSON,不要解释或 Markdown。格式:{ "hook": "黄金3秒钩子是什么、怎么抓人", "titleFormula": "标题用了什么公式/套路", "structure": [{"part":"段落名","desc":"这段在干什么"}], "tagStrategy": "标签布局策略", "template": "给运营的可复刻仿写模板(带占位符)", "whyItWorks": "为什么能火,结合数据" }。`;

/**
 * 拆解一条爆款内容。优先 LLM,失败回退规则骨架。返回 { ...analysis, source }。
 */
export async function analyzeHit(tenantId, record) {
  const fallback = buildHitFallback(record);
  try {
    const userMessage = JSON.stringify({
      title: clean(record.title, 200),
      content: clean(record.content, 1200),
      tags: parseTags(record),
      platform: record.platform,
      likes: record.likes, comments: record.comments_count, collects: record.collects, shares: record.shares,
    });
    const ai = await callLLMWithPrompt(tenantId, SYSTEM_PROMPT, userMessage);
    if (ai && typeof ai === 'object') return { ...mergeHitAi(fallback, ai), source: 'ai' };
  } catch (err) {
    console.warn('[HitAnalyzer] AI analyze failed:', err.message);
  }
  return { ...fallback, source: 'rule_fallback' };
}
