/**
 * 舆情剖析 — 话题级(关键词/时间范围圈定,聚合多帖+评论,追加留痕)与单条级(帖子深剖,唯一缓存)。
 * 范式同内容创意:规则先行算兜底骨架 → LLM 覆盖文字层 → merge 后落 JSONB,LLM 失败无缝回退。
 * 风险等级全模块统一四级枚举 critical|warning|attention|watch(与报告线同值域),落库前归一。
 */

import crypto from 'crypto';
import { queryOne, queryAll, execute, getSetting } from '../db/init.js';
import { getReportStats, RELEVANT_RECORD_SQL, RISK_LEVEL_LABEL, buildInsightSamplePool } from './report-generator.js';
import { ALERT_REASON_PREFIXES } from './alert-engine.js';
import { getBrandContext, callLLMWithPrompt } from './ai-labeler.js';

const RISK_LEVELS = ['critical', 'warning', 'attention', 'watch']; // 越靠前越严重
const PLATFORM_TEXT = { xiaohongshu: '小红书', weibo: '微博', douyin: '抖音', unknown: '未知平台' };
const TOPIC_PROMPT_VERSION = 'topic-v1';
const RECORD_PROMPT_VERSION = 'record-v1';
const RECORD_RISK_BY_ALERT_LEVEL = { critical: 'critical', warning: 'warning', info: 'attention' };
const INFLIGHT = new Set(); // analysisId,防并发重复执行(同 transcription.js 的转写防重)

export function normalizeRiskLevel(value, fallback = 'watch') {
  const normalized = String(value || '').trim().toLowerCase();
  return RISK_LEVELS.includes(normalized) ? normalized : fallback;
}

export function normalizeKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : [])
    .map(k => String(k || '').trim())
    .filter(Boolean);
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pctOf(part, total) {
  return num(total) > 0 ? Number((num(part) / num(total) * 100).toFixed(1)) : 0;
}

function compact(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function parseKeywordsColumn(value) {
  if (Array.isArray(value)) return normalizeKeywords(value);
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return normalizeKeywords(parsed);
  } catch {
    return [];
  }
}

/**
 * 品牌预检:getBrandContext(ai-labeler.js)在租户未配置时会逐字段落到 DEFAULT_BRAND_CONTEXT 硬编码兜底,
 * 而剖析产出的回应话术是客户可见交付物,绝不能拿别家品牌语境生成 ——
 * 因此判定标准是 tenant_settings 里品牌名与业务语境两项都真实存在,任一缺失即拒绝生成。
 */
export async function hasBrandContextConfigured(tenantId) {
  const brandName = String((await getSetting('brand_name', tenantId)) || '').trim();
  const businessContext = String((await getSetting('brand_business_context', tenantId)) || '').trim();
  return Boolean(brandName && businessContext);
}

/** 预检/圈定共用口径:与 getReportStats 的 periodWhere 一致(周期内新增 或 周期内有观测快照)。 */
export async function countScopedRecords(tenantId, periodStart, periodEnd, keywords = []) {
  const kw = normalizeKeywords(keywords);
  const recordFilter = RELEVANT_RECORD_SQL + (kw.length ? ' AND r.keyword = ANY($4::text[])' : '');
  const params = [tenantId, periodStart.toISOString(), periodEnd.toISOString(), ...(kw.length ? [kw] : [])];
  const row = await queryOne(
    `SELECT COUNT(DISTINCT r.id) AS n
     FROM records r
     WHERE r.tenant_id = $1
       AND ${recordFilter}
       AND (
         (r.created_at >= $2 AND r.created_at < $3)
         OR EXISTS (
           SELECT 1 FROM record_observations ro
           WHERE ro.record_id = r.id AND ro.tenant_id = r.tenant_id
             AND ro.captured_at >= $2 AND ro.captured_at < $3
         )
       )`,
    params
  );
  return num(row?.n);
}

/** 圈定口径内统计:getReportStats 出主体(kw 过滤后 alerts/评论等已同口径),再补两条 scoped 查询。 */
export async function collectTopicStats(tenantId, periodStart, periodEnd, keywords = []) {
  const kw = normalizeKeywords(keywords);
  const stats = await getReportStats(tenantId, periodStart, periodEnd, kw);

  const recordFilter = RELEVANT_RECORD_SQL + (kw.length ? ' AND r.keyword = ANY($4::text[])' : '');
  const params = [tenantId, periodStart.toISOString(), periodEnd.toISOString(), ...(kw.length ? [kw] : [])];

  // 低粉高扩散命中数:只消费 alert-engine 已沉淀的预警(LIKE 前缀同引 ALERT_REASON_PREFIXES,不重算)
  const lowFansRow = await queryOne(
    `SELECT COUNT(*) AS n
     FROM alerts a
     JOIN records r ON r.id = a.record_id AND r.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.created_at >= $2 AND a.created_at < $3
       AND ${recordFilter}
       AND a.reason LIKE $${params.length + 1}`,
    [...params, `${ALERT_REASON_PREFIXES.lowFansHighSpread}%`]
  );

  // 话题关联问题单:经 issue_records 关联到圈定记录、且活跃期与周期有交集(只入 ruleMetrics 展示,不进定级)
  const issueRow = await queryOne(
    `SELECT COUNT(DISTINCT i.id) AS n
     FROM issues i
     JOIN issue_records ir ON ir.issue_id = i.id AND ir.tenant_id = i.tenant_id
     JOIN records r ON r.id = ir.record_id AND r.tenant_id = i.tenant_id
     WHERE i.tenant_id = $1
       AND i.first_seen_at < $3 AND i.last_seen_at >= $2
       AND ${recordFilter}`,
    params
  );

  // 分层抽样池+头部断层比:与报告线共用 buildInsightSamplePool(头10/中5/尾5 ∪ 重点负面 ∪ 增长样本,
  // ≤30 条去重),保证两处样本口径与 cliffPct 永远一致;samples 为压缩样本(id/情感/互动/摘要),直接可喂 LLM
  const { samples, sampleMap, cliffPct } = buildInsightSamplePool(stats);

  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  for (const row of stats.sentiment || []) {
    if (row.sentiment in sentimentCounts) sentimentCounts[row.sentiment] = num(row.count);
  }
  const alertCounts = { critical: 0, warning: 0, info: 0 };
  for (const row of stats.alerts || []) {
    alertCounts[row.level] = (alertCounts[row.level] || 0) + num(row.count);
  }

  const metrics = {
    total: num(stats.total),
    sentimentCounts,
    negativeCount: sentimentCounts.negative,
    negativeRate: pctOf(sentimentCounts.negative, stats.total),
    negativeComments: num(stats.commentStats?.negative_comments),
    alertCounts,
    lowFansHighSpreadCount: num(lowFansRow?.n),
    scopedIssueCount: num(issueRow?.n),
    cliffPct,
  };
  return { stats, metrics, samples, sampleMap };
}

/**
 * 话题口径内四级定级:阈值结构借 report-generator 的 classifyRisk(同一枚举),但只喂圈定口径内
 * 信号 —— 不用其全租户不分时段的 high_open_issues / active_inbox,那会被几个月前的无关遗留
 * issue 把专题定级抬到 critical(口径污染)。调打分时与 classifyRisk 两边对照。
 */
export function classifyTopicRisk(metrics) {
  let score = 0;
  if (num(metrics.alertCounts?.critical) > 0) score += 4;
  if (num(metrics.lowFansHighSpreadCount) > 0) score += 2;
  if (metrics.negativeRate >= 30 && metrics.negativeCount >= 3) score += 3;
  else if (metrics.negativeRate >= 15 && metrics.negativeCount >= 2) score += 2;
  if (metrics.negativeComments >= 10) score += 2;
  else if (metrics.negativeComments > 0) score += 1;
  if (num(metrics.alertCounts?.warning) > 0) score += 1;
  if (metrics.cliffPct >= 70 && metrics.negativeCount > 0) score += 1; // 负面被单一爆款主导,易引导易反转

  if (score >= 6) return 'critical';
  if (score >= 4) return 'warning';
  if (score >= 2) return 'attention';
  return 'watch';
}

function judgeTrend(stats) {
  const trend = stats.trailingTrend || [];
  if (trend.length < 4) return '周期内数据点不足,暂无法判断走势。';
  const half = Math.floor(trend.length / 2);
  const sum = rows => rows.reduce((acc, row) => acc + num(row.total), 0);
  const front = sum(trend.slice(0, half));
  const back = sum(trend.slice(-half));
  if (front === 0 && back === 0) return '近期几乎无声量,处于静默期。';
  if (back >= front * 1.5) return '近半程声量明显抬升,需关注是否持续发酵。';
  if (back * 1.5 <= front) return '近半程声量回落,热度趋于消退。';
  return '声量整体平稳,未见明显抬升或消退。';
}

/** 规则兜底:四块骨架全部由圈定口径内统计生成,LLM 只在其上覆盖文字层。 */
export function buildTopicFallback({ stats, metrics, samples, sampleMap, keywords, periodStart, periodEnd }) {
  const ruleRiskLevel = classifyTopicRisk(metrics);
  const alertTotal = num(metrics.alertCounts?.critical) + num(metrics.alertCounts?.warning);

  const keyDrivers = (stats.topNegative || []).slice(0, 3).map(row => ({
    driver: compact(row.title || row.ai_summary || row.content, 60),
    evidence: compact(row.ai_summary || row.content, 120),
    sampleIds: [row.id],
  }));

  const watchPoints = [];
  if (num(metrics.alertCounts?.critical) > 0) {
    watchPoints.push(`周期内有 ${metrics.alertCounts.critical} 条重点预警,建议优先人工复核。`);
  }
  if (metrics.lowFansHighSpreadCount > 0) {
    watchPoints.push(`命中 ${metrics.lowFansHighSpreadCount} 条低粉高扩散预警,警惕水军或突发负面种子扩散。`);
  }
  if (metrics.cliffPct >= 70) {
    watchPoints.push(`热度被少数爆款主导(Top1 占 Top5 互动 ${metrics.cliffPct}%),走向易被头部内容引导。`);
  }
  if (!watchPoints.length) watchPoints.push('暂无突出风险信号,保持常规监控节奏即可。');

  const viewpointClusters = (stats.keyword || []).slice(0, 5).map(row => {
    const negShare = pctOf(row.negative_count, row.count);
    return {
      viewpoint: `围绕「${row.keyword}」的讨论`,
      stance: negShare >= 50 ? 'negative' : negShare >= 20 ? 'mixed' : 'neutral',
      share: pctOf(row.count, metrics.total),
      summary: `共 ${num(row.count)} 条,其中负面 ${num(row.negative_count)} 条,总互动 ${num(row.interaction_total)}。`,
      sampleIds: [],
    };
  });

  const emotionTones = ['positive', 'neutral', 'negative'].map(key => ({
    tone: key,
    count: num(metrics.sentimentCounts?.[key]),
    share: pctOf(metrics.sentimentCounts?.[key], metrics.total),
  }));

  const representativeVoices = (stats.negativeComments || []).slice(0, 5).map(row => ({
    content: compact(row.content, 100),
    likeCount: num(row.like_count),
    recordId: row.record_id,
    recordTitle: compact(row.record_title, 60),
  }));

  const platforms = (stats.platform || []).map(row => ({
    platform: row.platform,
    label: PLATFORM_TEXT[row.platform] || row.platform || '未知平台',
    count: num(row.count),
    negativeCount: num(row.negative_count),
    interactionTotal: num(row.interaction_total),
  }));
  const topPlatform = platforms[0] || null;
  const spreadSummary = topPlatform
    ? `声量集中在${topPlatform.label}(${topPlatform.count} 条,占 ${pctOf(topPlatform.count, metrics.total)}%);` +
      `Top1 内容占 Top5 互动 ${metrics.cliffPct}%,${metrics.cliffPct >= 70 ? '呈爆款主导态势(易引导易反转)' : '呈普遍发酵态势(更接近真实民意)'}。`
    : '周期内无可统计的平台分布。';

  const keyNodes = (stats.risingRecords || []).slice(0, 5).map(row => ({
    recordId: row.id,
    title: compact(row.title, 60),
    sentiment: row.sentiment || '',
    interactionGrowth: num(row.interaction_growth),
  }));

  const actions = [];
  if (num(metrics.alertCounts?.critical) > 0) {
    actions.push(`优先复核 ${metrics.alertCounts.critical} 条重点预警内容,明确处置负责人与对外口径。`);
  }
  if (metrics.negativeComments > 0) {
    actions.push(`核查 ${metrics.negativeComments} 条负面评论,确认是否需要官方回复或转为问题单。`);
  }
  if (metrics.scopedIssueCount > 0) {
    actions.push(`跟进话题关联的 ${metrics.scopedIssueCount} 个问题单,补齐处理进展与负责人。`);
  }
  if (!actions.length) actions.push('本话题周期内风险可控,保持既定监控与复盘节奏。');

  return {
    meta: {
      promptVersion: TOPIC_PROMPT_VERSION,
      keywords,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      sampleCount: samples.length,
      insufficientSamples: samples.length < 3,
      generatedAt: new Date().toISOString(),
    },
    ruleMetrics: metrics,
    riskAssessment: {
      riskLevel: ruleRiskLevel,
      ruleRiskLevel,
      riskLevelLabel: RISK_LEVEL_LABEL[ruleRiskLevel],
      riskSummary: `圈定范围内共 ${metrics.total} 条内容,负面 ${metrics.negativeCount} 条(负面率 ${metrics.negativeRate}%),` +
        `周期内预警 ${alertTotal} 条,负面评论 ${metrics.negativeComments} 条。`,
      trendJudgment: judgeTrend(stats),
      keyDrivers,
      watchPoints,
    },
    opinionBreakdown: { viewpointClusters, emotionTones, representativeVoices },
    // 数据字段(platforms/trend/keyNodes)永远来自规则统计,LLM 只覆盖 summary 叙事
    spreadNarrative: {
      summary: spreadSummary,
      platforms,
      trend: (stats.volumeTrend || []).map(row => ({ label: row.label, total: num(row.total), negative: num(row.negative) })),
      keyNodes,
    },
    responseStrategy: {
      actions,
      // 回应话术是客户可见交付物,只能由带品牌语境的 LLM 生成;规则兜底不产话术
      responseDraft: { statement: '', qa: [], channelNotes: [] },
      contentIdeas: [],
    },
    sampleMap,
  };
}

const VIEWPOINT_STANCES = ['negative', 'mixed', 'neutral', 'positive'];
const RISK_LEVEL_ENUM_TEXT = RISK_LEVELS.map(level => `${level}(${RISK_LEVEL_LABEL[level]})`).join('|');

function cleanText(value, max = 300) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value).trim().slice(0, max);
}

function cleanList(value, max, itemMax = 200) {
  return (Array.isArray(value) ? value : [])
    .map(item => cleanText(item, itemMax))
    .filter(Boolean)
    .slice(0, max);
}

/** sampleIds 幻觉过滤:LLM 引用的样本 id 必须真实存在于喂入的 sampleMap,其余丢弃。 */
function filterSampleIds(value, sampleMap) {
  return (Array.isArray(value) ? value : [])
    .map(id => cleanText(id, 64))
    .filter(id => id && sampleMap[id]);
}

function pctClamp(value) {
  return Math.max(0, Math.min(100, Math.round(num(value))));
}

function sampleLines(samples) {
  return samples
    .map(x => `- id=${x.id} | ${x.sentiment || '未标'} | 赞${x.likes}评${x.comments}负评${x.negComments} | ${x.title} | ${x.summary}`)
    .join('\n');
}

/**
 * LLM①(风险研判+观点拆解):喂圈定口径统计 + 分层抽样样本(≤30 条,与报告线同池),
 * 覆盖 riskAssessment 文字层与 viewpointClusters。失败/未配 key 返回 null,该部分回落规则。
 */
async function enhanceRiskAndOpinion(tenantId, { metrics, samples, fallback }) {
  try {
    const brand = await getBrandContext(tenantId);
    const systemPrompt = `你是「${brand.brandName}」的资深舆情分析师。业务语境:${brand.businessContext}
下面给你一个圈定话题的统计概览 + 一批代表样本(每条含 id/情感/互动/摘要)。请做跨样本的风险研判与观点拆解,只输出 JSON:
{
  "riskAssessment": {
    "riskLevel": "critical|warning|attention|watch",
    "riskSummary": "结论先行的风险摘要(2-3句,点明主要矛盾、是否需介入)",
    "trendJudgment": "走势研判(1-2句)",
    "keyDrivers": [{"driver":"风险驱动因素","evidence":"依据","sampleIds":["命中样本id"]}],
    "watchPoints": ["后续需要盯防的风险点"]
  },
  "opinionBreakdown": {
    "viewpointClusters": [{"viewpoint":"观点","stance":"negative|mixed|neutral|positive","share":0到100的数字,"summary":"该观点在讲什么/集中在哪","sampleIds":["..."]}]
  }
}
要求:riskLevel 只能取四级枚举 ${RISK_LEVEL_ENUM_TEXT} 之一;sampleIds 只能引用我给的样本 id,不得编造;聚类要跨样本归纳而非逐条复述;基于事实不臆造;空字段用空数组/空串;简洁中文。`;
    const userMessage = `【话题概览】圈定 ${metrics.total} 条内容,负面 ${metrics.negativeCount} 条(负面率 ${metrics.negativeRate}%),负面评论 ${metrics.negativeComments} 条;周期内预警 critical ${num(metrics.alertCounts?.critical)} 条/warning ${num(metrics.alertCounts?.warning)} 条,低粉高扩散 ${metrics.lowFansHighSpreadCount} 条。
【热度结构】Top1 内容占 Top5 互动的 ${metrics.cliffPct}%(越高=越被少数爆款主导/易引导易反转,越低=普遍发酵/更接近真实民意)。
【规则走势】${fallback.riskAssessment.trendJudgment}
【代表样本】(${samples.length} 条)
${sampleLines(samples)}`;
    const result = await callLLMWithPrompt(tenantId, systemPrompt, userMessage);
    if (!result || typeof result !== 'object') return null;
    // 空壳/跑题 JSON 视同失败,让对应块干净地回落规则
    return (result.riskAssessment || result.opinionBreakdown) ? result : null;
  } catch (err) {
    console.warn('[OpinionAnalysis] LLM①(风险/观点)失败,该部分回落规则:', err?.message || err);
    return null;
  }
}

/**
 * LLM②(传播叙事+应对建议):吃①的风险结论与主要观点写话术;①失败则用规则骨架的结论顶上。
 * 回应话术是客户可见交付物,口径依据只来自系统提示词注入的品牌业务语境。
 */
async function enhanceSpreadAndResponse(tenantId, { metrics, fallback, riskOpinion }) {
  try {
    const brand = await getBrandContext(tenantId);
    const riskLevel = normalizeRiskLevel(riskOpinion?.riskAssessment?.riskLevel, fallback.riskAssessment.ruleRiskLevel);
    const riskSummary = cleanText(riskOpinion?.riskAssessment?.riskSummary, 500) || fallback.riskAssessment.riskSummary;
    const clusterLines = (riskOpinion?.opinionBreakdown?.viewpointClusters || fallback.opinionBreakdown.viewpointClusters || [])
      .slice(0, 3)
      .map(c => `- ${cleanText(c?.viewpoint, 120)}(${cleanText(c?.stance, 20) || 'neutral'}):${cleanText(c?.summary, 200)}`);
    const spread = fallback.spreadNarrative;
    const platformLine = (spread.platforms || [])
      .map(p => `${p.label} ${p.count} 条(负面 ${p.negativeCount})`)
      .join('、') || '无平台分布数据';
    const nodeLines = (spread.keyNodes || [])
      .map(node => `- ${node.title}(${node.sentiment || '未标'},互动增长 ${node.interactionGrowth})`)
      .join('\n') || '无';
    const systemPrompt = `你是「${brand.brandName}」的舆情应对策略顾问。业务语境:${brand.businessContext}
基于给出的风险结论、主要观点与传播统计,产出传播叙事与应对建议,只输出 JSON:
{
  "spreadSummary": "传播面叙事(2-3句:平台结构/扩散节奏/是爆款主导还是普遍发酵)",
  "responseStrategy": {
    "actions": ["按优先级排列的具体处置动作"],
    "responseDraft": {
      "statement": "对外统一回应口径",
      "qa": [{"q":"高频追问","a":"建议答复"}],
      "channelNotes": ["分渠道注意事项(评论区/私信/官方账号等)"]
    },
    "contentIdeas": [{"title":"承接性内容选题","angle":"切入角度"}]
  }
}
要求:话术必须贴合上述业务语境,克制、基于事实,不承诺无法兑现的事,不编造数据;简洁中文;空字段用空数组/空串。`;
    const userMessage = `【风险结论】等级 ${riskLevel}(${RISK_LEVEL_LABEL[riskLevel]});${riskSummary}
【主要观点】
${clusterLines.join('\n') || '无'}
【传播统计】共 ${metrics.total} 条;平台分布:${platformLine};Top1 占 Top5 互动 ${metrics.cliffPct}%;低粉高扩散预警 ${metrics.lowFansHighSpreadCount} 条。
【关键节点】
${nodeLines}`;
    const result = await callLLMWithPrompt(tenantId, systemPrompt, userMessage);
    if (!result || typeof result !== 'object') return null;
    return (result.spreadSummary || result.responseStrategy) ? result : null;
  } catch (err) {
    console.warn('[OpinionAnalysis] LLM②(传播/应对)失败,该部分回落规则:', err?.message || err);
    return null;
  }
}

/**
 * 字段级 merge:规则骨架打底,LLM 成功的部分覆盖对应块并标记 source='llm'(前端按块显示来源角标)。
 * emotionTones/representativeVoices 与 spreadNarrative 的数据字段(platforms/trend/keyNodes)永远保留
 * 规则统计——情绪构成是真实计数、代表言论是真实评论,而 LLM① 只见过帖子样本没见过评论原文,
 * 放开覆盖等于邀请编造引语;sampleIds 一律过 sampleMap 存在性过滤。
 */
export function mergeTopicResult({ fallback, riskOpinion = null, spreadResponse = null }) {
  const payload = fallback;
  const sampleMap = payload.sampleMap || {};
  for (const key of ['riskAssessment', 'opinionBreakdown', 'spreadNarrative', 'responseStrategy']) {
    payload[key].source = 'rule';
  }

  const risk = riskOpinion?.riskAssessment;
  if (risk && typeof risk === 'object') {
    const target = payload.riskAssessment;
    // 枚举校验:非法值回落规则定级;合法但与规则不同以 LLM 为准,ruleRiskLevel 保留对照
    target.riskLevel = normalizeRiskLevel(risk.riskLevel, target.ruleRiskLevel);
    target.riskSummary = cleanText(risk.riskSummary, 600) || target.riskSummary;
    target.trendJudgment = cleanText(risk.trendJudgment, 300) || target.trendJudgment;
    const keyDrivers = (Array.isArray(risk.keyDrivers) ? risk.keyDrivers : [])
      .map(d => ({
        driver: cleanText(d?.driver, 120),
        evidence: cleanText(d?.evidence, 300),
        sampleIds: filterSampleIds(d?.sampleIds, sampleMap),
      }))
      .filter(d => d.driver)
      .slice(0, 5);
    if (keyDrivers.length) target.keyDrivers = keyDrivers;
    const watchPoints = cleanList(risk.watchPoints, 6, 200);
    if (watchPoints.length) target.watchPoints = watchPoints;
    target.source = 'llm';
  }

  const clusters = (Array.isArray(riskOpinion?.opinionBreakdown?.viewpointClusters)
    ? riskOpinion.opinionBreakdown.viewpointClusters : [])
    .map(c => ({
      viewpoint: cleanText(c?.viewpoint, 120),
      stance: VIEWPOINT_STANCES.includes(String(c?.stance || '').trim().toLowerCase())
        ? String(c.stance).trim().toLowerCase() : 'neutral',
      share: pctClamp(c?.share),
      summary: cleanText(c?.summary, 300),
      sampleIds: filterSampleIds(c?.sampleIds, sampleMap),
    }))
    .filter(c => c.viewpoint)
    .slice(0, 6);
  if (clusters.length) {
    payload.opinionBreakdown.viewpointClusters = clusters;
    payload.opinionBreakdown.source = 'llm';
  }

  const spreadSummary = cleanText(spreadResponse?.spreadSummary, 600);
  if (spreadSummary) {
    // platforms/trend/keyNodes 数据永远来自规则统计,LLM 只覆盖叙事
    payload.spreadNarrative.summary = spreadSummary;
    payload.spreadNarrative.source = 'llm';
  }

  const strategy = spreadResponse?.responseStrategy;
  if (strategy && typeof strategy === 'object') {
    const target = payload.responseStrategy;
    const actions = cleanList(strategy.actions, 8, 200);
    if (actions.length) target.actions = actions;
    const draft = strategy.responseDraft;
    if (draft && typeof draft === 'object') {
      target.responseDraft = {
        statement: cleanText(draft.statement, 1200),
        qa: (Array.isArray(draft.qa) ? draft.qa : [])
          .map(item => ({ q: cleanText(item?.q, 200), a: cleanText(item?.a, 600) }))
          .filter(item => item.q && item.a)
          .slice(0, 8),
        channelNotes: cleanList(draft.channelNotes, 6, 200),
      };
    }
    target.contentIdeas = (Array.isArray(strategy.contentIdeas) ? strategy.contentIdeas : [])
      .map(item => ({ title: cleanText(item?.title, 80), angle: cleanText(item?.angle, 200) }))
      .filter(item => item.title)
      .slice(0, 6);
    target.source = 'llm';
  }

  const llmHits = (riskOpinion ? 1 : 0) + (spreadResponse ? 1 : 0);
  const analysisSource = llmHits === 2 ? 'llm_with_rule_metrics' : llmHits === 1 ? 'partial_llm' : 'rule_fallback';

  const riskLevel = normalizeRiskLevel(payload.riskAssessment.riskLevel, payload.riskAssessment.ruleRiskLevel);
  payload.riskAssessment.riskLevel = riskLevel;
  payload.riskAssessment.riskLevelLabel = RISK_LEVEL_LABEL[riskLevel];
  return { payload, analysisSource };
}

const JSONB_FIELDS = new Set(['progress', 'payload']);

async function updateAnalysis(analysisId, tenantId, fields) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    params.push(value);
    sets.push(`${key} = $${params.length}${JSONB_FIELDS.has(key) ? '::jsonb' : ''}`);
  }
  sets.push('updated_at = now()');
  params.push(analysisId, tenantId);
  await execute(
    `UPDATE opinion_topic_analyses SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
    params
  );
}

function stageJson(stage, message) {
  return JSON.stringify({ stage, message, updatedAt: new Date().toISOString() });
}

/** 后台主流程(setImmediate 调用,不阻塞 HTTP):状态机 pending→running→done|failed,逐阶段写 progress。 */
export async function runTopicAnalysis({ tenantId, analysisId }) {
  if (INFLIGHT.has(analysisId)) return;
  INFLIGHT.add(analysisId);
  try {
    const row = await queryOne(
      `SELECT id, status, keywords, period_start, period_end FROM opinion_topic_analyses WHERE id = $1 AND tenant_id = $2`,
      [analysisId, tenantId]
    );
    if (!row || row.status !== 'pending') return; // 重跑走新行,done/failed/running 的不再执行

    const keywords = parseKeywordsColumn(row.keywords);
    const periodStart = new Date(row.period_start);
    const periodEnd = new Date(row.period_end);

    await updateAnalysis(analysisId, tenantId, {
      status: 'running',
      progress: stageJson('collect', '正在圈定样本并统计声量/情绪/预警…'),
    });
    const { stats, metrics, samples, sampleMap } = await collectTopicStats(tenantId, periodStart, periodEnd, keywords);

    const fallback = buildTopicFallback({ stats, metrics, samples, sampleMap, keywords, periodStart, periodEnd });

    // 样本不足不算失败:预检通过后数据仍可能被过滤到 <3 条 → 跳过 LLM 落纯规则,meta.insufficientSamples 已标记
    let riskOpinion = null;
    let spreadResponse = null;
    if (samples.length >= 3) {
      // 两次 LLM 各自独立降级,②吃①的结论写话术;事务里绝不放 LLM 调用
      await updateAnalysis(analysisId, tenantId, {
        progress: stageJson('analyze', '正在生成风险研判与观点拆解…(1/2)'),
      });
      riskOpinion = await enhanceRiskAndOpinion(tenantId, { metrics, samples, fallback });
      await updateAnalysis(analysisId, tenantId, {
        progress: stageJson('analyze', '正在生成传播叙事与应对建议…(2/2)'),
      });
      spreadResponse = await enhanceSpreadAndResponse(tenantId, { metrics, fallback, riskOpinion });
    }
    const { payload, analysisSource } = mergeTopicResult({ fallback, riskOpinion, spreadResponse });

    await updateAnalysis(analysisId, tenantId, {
      progress: stageJson('finalize', '正在汇总剖析结果…'),
    });
    await updateAnalysis(analysisId, tenantId, {
      status: 'done',
      payload: JSON.stringify(payload),
      sample_count: samples.length,
      analysis_source: analysisSource,
      error: '',
      progress: stageJson('done', '剖析完成'),
    });
  } catch (err) {
    await updateAnalysis(analysisId, tenantId, {
      status: 'failed',
      error: String(err?.message || err || '剖析失败').slice(0, 500),
      progress: stageJson('failed', '剖析失败'),
    }).catch(() => {});
  } finally {
    INFLIGHT.delete(analysisId);
  }
}

/** 启动收尸:重启会丢内存里的 setImmediate 任务,遗留 pending/running 永远转不完 → 置 failed。 */
export async function failStaleAnalyses() {
  // 逐租户执行,遵守「新增 SQL 一律带 tenant_id 条件」的多租户红线
  const tenants = await queryAll(`SELECT id FROM tenants`);
  let total = 0;
  for (const tenant of tenants) {
    const result = await execute(
      `UPDATE opinion_topic_analyses
       SET status = 'failed', error = '服务重启导致剖析中断,请重新发起', updated_at = now()
       WHERE tenant_id = $1 AND status IN ('pending', 'running')`,
      [tenant.id]
    );
    total += num(result.rowCount);
  }
  if (total) console.log(`[OpinionAnalysis] 启动收尸:${total} 个中断任务置为 failed`);
  return total;
}

const RECORD_STANCES = ['positive', 'neutral', 'negative'];

/**
 * 单条深剖 LLM(一次调用):喂正文+互动+逐字稿(截4000)+逐字稿分析 JSONB+OCR 图文(截1500)+
 * 负面优先评论样本(≤50)+命中预警,覆盖 overview 文字层/contentInsights/commentInsights/回应话术。
 * 回应话术是客户可见交付物,口径依据只来自系统提示词注入的品牌业务语境。失败/未配 key 返回 null 回落规则。
 */
async function enhanceRecordAnalysis(tenantId, { record, comments, ocrText, transcript, transcriptAnalysis, alerts }) {
  try {
    const brand = await getBrandContext(tenantId);
    const systemPrompt = `你是「${brand.brandName}」的资深舆情分析师。业务语境:${brand.businessContext}
下面给你一条社媒内容的正文/口播逐字稿/图文文字/评论摘录及其已命中的预警。请做单条深度剖析,只输出 JSON:
{
  "overview": {
    "stance": "positive|neutral|negative",
    "summary": "一句话:这条内容在讲什么、对品牌是什么态度、风险几何"
  },
  "contentInsights": {
    "corePoints": ["博主/正文的核心观点或主张"],
    "issues": ["提到的具体槽点/问题点(如年费贵、功能鸡肋、信号差)"]
  },
  "commentInsights": {
    "summary": "评论区整体氛围与主要分歧(1-2句)",
    "points": [{"viewpoint":"评论区的一类观点","stance":"negative|mixed|neutral|positive","summary":"这类评论在说什么"}]
  },
  "suggestedResponse": {
    "action": "建议的处置动作(一句)",
    "replyDraft": "面向该内容评论区/私信的建议回应话术(克制、基于事实、不承诺无法兑现的事;无需回应则空串)",
    "escalation": "需要升级或跨部门协同的事项(无则空串)"
  }
}
要求:stance 只能取三值枚举;评论观点要跨评论归纳而非逐条复述;话术必须贴合上述业务语境,不编造数据;简洁中文;空字段用空数组/空串。`;
    const parts = [
      `【标题】${record.title || ''}`,
      `【正文】${compact(record.content, 2000) || '(无正文)'}`,
      `【互动】赞${num(record.likes)} 评${num(record.comments_count)} 藏${num(record.collects)} 转${num(record.shares)};负面评论 ${num(record.negative_comment_count)} 条`,
    ];
    if (transcript) parts.push(`【视频口播逐字稿】\n${transcript}`);
    if (transcriptAnalysis && typeof transcriptAnalysis === 'object') {
      const ta = transcriptAnalysis;
      parts.push(`【逐字稿既有AI分析】立场 ${cleanText(ta.stance, 20) || '未标'};${cleanText(ta.summary, 200)};槽点:${cleanList(ta.issues, 5, 80).join('、') || '无'}`);
    }
    if (ocrText) parts.push(`【图文提取文字】${ocrText}`);
    if (alerts.length) parts.push(`【已命中预警】${alerts.map(a => cleanText(a.reason, 120)).filter(Boolean).join(';') || '无'}`);
    if (comments.length) {
      parts.push(`【评论摘录】(${comments.length} 条,负面优先)\n` + comments
        .map(c => `- ${c.is_negative ? `负面/${c.risk_level || 'low'}` : (c.sentiment || '中性')} | 赞${num(c.like_count)} | ${compact(c.content, 100)}`)
        .join('\n'));
    } else {
      parts.push('【评论摘录】无评论数据');
    }
    const result = await callLLMWithPrompt(tenantId, systemPrompt, parts.join('\n'));
    if (!result || typeof result !== 'object') return null;
    return (result.overview || result.contentInsights || result.commentInsights || result.suggestedResponse) ? result : null;
  } catch (err) {
    console.warn('[OpinionAnalysis] 单条深剖 LLM 失败,回落规则:', err?.message || err);
    return null;
  }
}
/**
 * 单条深剖(只读消费已有沉淀,不触发 ASR/OCR):规则先算兜底骨架,再一次 LLM 覆盖文字层,失败无缝回落。
 * 兜底/降级结果同样落缓存 —— 抽屉重开有内容;POST 读到 rule_fallback 缓存会隐式再试一次(防一次超时永久钉死)。
 */
export async function analyzeOpinionRecord({ tenantId, recordId }) {
  const record = await queryOne(
    `SELECT id, title, content, sentiment, ai_summary, likes, comments_count, collects, shares,
            negative_comment_count, transcript, transcript_analysis
     FROM records WHERE id = $1 AND tenant_id = $2`,
    [recordId, tenantId]
  );
  if (!record) return null;

  const alerts = await queryAll(
    `SELECT level, reason FROM alerts WHERE tenant_id = $1 AND record_id = $2 ORDER BY created_at DESC`,
    [tenantId, recordId]
  );
  // 评论样本:负面优先 + 高风险 + 高赞 + 最新,排除官方回复,≤50 条(与报告线负评排序同口径)
  const comments = await queryAll(
    `SELECT content, like_count, is_negative, risk_level, sentiment
     FROM record_comments
     WHERE tenant_id = $1 AND record_id = $2 AND is_official = false AND content <> ''
     ORDER BY is_negative DESC,
       CASE risk_level WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END DESC,
       like_count DESC, last_seen_at DESC
     LIMIT 50`,
    [tenantId, recordId]
  );
  // OCR 只消费 done 行的可见文字,拼到 1500 字上限(不触发新的图片识别)
  const ocrRows = await queryAll(
    `SELECT text FROM record_image_ocr
     WHERE tenant_id = $1 AND record_id = $2 AND status = 'done' AND text <> ''
     ORDER BY updated_at DESC`,
    [tenantId, recordId]
  );
  const ocrText = ocrRows.map(row => String(row.text || '').trim()).filter(Boolean).join('\n').slice(0, 1500);
  const transcript = String(record.transcript || '').trim().slice(0, 4000);

  let riskLevel = 'watch';
  for (const alert of alerts) {
    const mapped = RECORD_RISK_BY_ALERT_LEVEL[alert.level] || 'watch';
    if (RISK_LEVELS.indexOf(mapped) < RISK_LEVELS.indexOf(riskLevel)) riskLevel = mapped;
  }
  riskLevel = normalizeRiskLevel(riskLevel);
  const interactionTotal = num(record.likes) + num(record.comments_count) + num(record.collects) + num(record.shares);

  // evidenceSources 由规则确定性给出(用了哪些沉淀),不交给 LLM 编造
  const evidenceSources = [];
  if (record.content) evidenceSources.push('正文');
  if (transcript) evidenceSources.push('视频逐字稿');
  if (record.transcript_analysis && typeof record.transcript_analysis === 'object') evidenceSources.push('逐字稿AI分析');
  if (ocrText) evidenceSources.push('图文提取文字');
  if (comments.length) evidenceSources.push(`评论 ${comments.length} 条`);
  if (alerts.length) evidenceSources.push(`预警 ${alerts.length} 条`);

  // 规则兜底骨架:corePoints/issues 借逐字稿既有分析(若有),commentInsights 用真实负评摘录顶上
  const ta = record.transcript_analysis && typeof record.transcript_analysis === 'object' ? record.transcript_analysis : null;
  const fallbackPoints = comments.slice(0, 5).map(c => ({
    viewpoint: compact(c.content, 60),
    stance: c.is_negative ? 'negative' : (RECORD_STANCES.includes(c.sentiment) ? c.sentiment : 'neutral'),
    summary: '',
  }));
  const payload = {
    meta: { promptVersion: RECORD_PROMPT_VERSION, generatedAt: new Date().toISOString(), evidenceSources },
    overview: {
      stance: RECORD_STANCES.includes(record.sentiment) ? record.sentiment : 'neutral',
      riskLevel,
      riskLevelLabel: RISK_LEVEL_LABEL[riskLevel],
      summary: compact(ta?.summary || record.ai_summary || record.content || record.title, 160),
    },
    contentInsights: {
      corePoints: ta ? cleanList(ta.keyPoints, 6, 120) : [],
      issues: ta ? cleanList(ta.issues, 6, 120) : [],
    },
    commentInsights: {
      summary: comments.length ? `共采样 ${comments.length} 条评论,其中负面 ${comments.filter(c => c.is_negative).length} 条。` : '',
      points: fallbackPoints,
    },
    spreadRisk: {
      interactionTotal,
      negativeCommentCount: num(record.negative_comment_count),
      alertReasons: alerts.map(alert => alert.reason),
    },
    suggestedResponse: {
      action: riskLevel === 'critical'
        ? '优先人工复核并升级处置,明确负责人与对外口径。'
        : record.sentiment === 'negative'
          ? '进入舆情待办池,补充事实核查与处理记录。'
          : '保留观察,互动量上升时再升级处理。',
      // 回应话术是客户可见交付物,只能由带品牌语境的 LLM 生成;规则兜底不产话术
      replyDraft: '',
      escalation: '',
    },
  };
  // LLM 覆盖文字层(事务外),失败则整体保留规则兜底
  const llm = await enhanceRecordAnalysis(tenantId, {
    record, comments, ocrText, transcript, transcriptAnalysis: ta, alerts,
  });
  let analysisSource = 'rule_fallback';
  if (llm) {
    analysisSource = 'llm';
    const ov = llm.overview;
    if (ov && typeof ov === 'object') {
      if (RECORD_STANCES.includes(String(ov.stance || '').trim().toLowerCase())) {
        payload.overview.stance = String(ov.stance).trim().toLowerCase();
      }
      const summary = cleanText(ov.summary, 300);
      if (summary) payload.overview.summary = summary;
    }
    const ci = llm.contentInsights;
    if (ci && typeof ci === 'object') {
      const corePoints = cleanList(ci.corePoints, 8, 160);
      if (corePoints.length) payload.contentInsights.corePoints = corePoints;
      const issues = cleanList(ci.issues, 8, 160);
      if (issues.length) payload.contentInsights.issues = issues;
    }
    const cm = llm.commentInsights;
    if (cm && typeof cm === 'object') {
      const summary = cleanText(cm.summary, 400);
      if (summary) payload.commentInsights.summary = summary;
      const points = (Array.isArray(cm.points) ? cm.points : [])
        .map(p => ({
          viewpoint: cleanText(p?.viewpoint, 120),
          stance: VIEWPOINT_STANCES.includes(String(p?.stance || '').trim().toLowerCase())
            ? String(p.stance).trim().toLowerCase() : 'neutral',
          summary: cleanText(p?.summary, 300),
        }))
        .filter(p => p.viewpoint)
        .slice(0, 6);
      if (points.length) payload.commentInsights.points = points;
    }
    const sr = llm.suggestedResponse;
    if (sr && typeof sr === 'object') {
      const action = cleanText(sr.action, 300);
      if (action) payload.suggestedResponse.action = action;
      payload.suggestedResponse.replyDraft = cleanText(sr.replyDraft, 1200);
      payload.suggestedResponse.escalation = cleanText(sr.escalation, 600);
    }
  }
  payload.meta.analysisSource = analysisSource;

  const inputHash = await computeRecordInputHash(tenantId, record);
  await execute(
    `INSERT INTO opinion_record_analyses (tenant_id, record_id, payload, analysis_source, prompt_version, input_hash)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     ON CONFLICT (tenant_id, record_id)
     DO UPDATE SET payload = excluded.payload, analysis_source = excluded.analysis_source,
       prompt_version = excluded.prompt_version, input_hash = excluded.input_hash, updated_at = now()`,
    [tenantId, recordId, JSON.stringify(payload), analysisSource, RECORD_PROMPT_VERSION, inputHash]
  );
  return { payload, source: analysisSource, inputHash };
}

/** input_hash = sha1(正文摘要+评论数+逐字稿长度+OCR 条数):读缓存时不一致 → 提示 stale 可重剖。 */
export async function computeRecordInputHash(tenantId, record) {
  const ocr = await queryOne(
    `SELECT COUNT(*) AS n FROM record_image_ocr
     WHERE tenant_id = $1 AND record_id = $2 AND status = 'done'`,
    [tenantId, record.id]
  );
  const basis = [
    String(record.content || '').slice(0, 2000),
    String(num(record.comments_count)),
    String(String(record.transcript || '').length),
    String(num(ocr?.n)),
  ].join('|');
  return crypto.createHash('sha1').update(basis).digest('hex');
}
