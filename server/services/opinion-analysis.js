/**
 * 舆情剖析 — 话题级(关键词/时间范围圈定,聚合多帖+评论,追加留痕)与单条级(帖子深剖,唯一缓存)。
 * 范式同内容创意:规则先行算兜底骨架 → LLM 覆盖文字层 → merge 后落 JSONB,LLM 失败无缝回退。
 * 风险等级全模块统一四级枚举 critical|warning|attention|watch(与报告线同值域),落库前归一。
 */

import crypto from 'crypto';
import { queryOne, queryAll, execute, getSetting } from '../db/init.js';
import { getReportStats, RELEVANT_RECORD_SQL, RISK_LEVEL_LABEL } from './report-generator.js';
import { ALERT_REASON_PREFIXES } from './alert-engine.js';

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

  // 分层抽样池:与报告线 buildAiOpinionInsight 同规则(头10/中5/尾5 ∪ 重点负面 ∪ 增长样本,≤30 条去重)
  const ss = stats.sentimentSamples || [];
  const mid = Math.floor(ss.length / 2);
  const pool = [
    ...(stats.topNegative || []),
    ...(stats.risingRecords || []),
    ...ss.slice(0, 10), ...ss.slice(mid, mid + 5), ...ss.slice(-5),
  ];
  const seen = new Set();
  const samples = [];
  const sampleMap = {};
  for (const row of pool) {
    const id = row.id || row.record_id;
    if (!id) continue;
    if (!sampleMap[id]) sampleMap[id] = { title: String(row.title || '').slice(0, 80), url: row.url || row.record_url || '' };
    if (seen.has(id)) continue;
    seen.add(id);
    samples.push(row);
    if (samples.length >= 30) break;
  }

  // 头部断层比:Top1 占 Top5 互动比例(越高=被少数爆款主导/易引导易反转)
  const interOf = row => num(row.likes) + num(row.comments_count) + num(row.collects) + num(row.shares);
  const tops = (stats.topInteraction || []).map(interOf).sort((a, b) => b - a).slice(0, 5);
  const topSum = tops.reduce((a, b) => a + b, 0);
  const cliffPct = topSum > 0 ? Math.round((tops[0] || 0) / topSum * 100) : 0;

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

// LLM①(风险研判+观点拆解)。增强层尚未接入:恒返回 null → runTopicAnalysis 落纯规则兜底。
async function enhanceRiskAndOpinion() {
  return null;
}

// LLM②(传播叙事+应对建议,吃①的结论写话术)。增强层尚未接入:恒返回 null。
async function enhanceSpreadAndResponse() {
  return null;
}

// merge:增强层接入后做字段级覆盖 + sampleIds 幻觉过滤 + LLM/规则来源标记。
// 当前直接返回规则兜底,只保证落库前 riskLevel 枚举归一。
function mergeTopicResult({ fallback }) {
  const riskLevel = normalizeRiskLevel(fallback.riskAssessment?.riskLevel);
  fallback.riskAssessment.riskLevel = riskLevel;
  fallback.riskAssessment.riskLevelLabel = RISK_LEVEL_LABEL[riskLevel];
  return { payload: fallback, analysisSource: 'rule_fallback' };
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

    await updateAnalysis(analysisId, tenantId, {
      progress: stageJson('analyze', '正在生成风险研判与观点拆解…'),
    });
    const fallback = buildTopicFallback({ stats, metrics, samples, sampleMap, keywords, periodStart, periodEnd });

    // 样本不足不算失败:预检通过后数据仍可能被过滤到 <3 条 → 降级纯规则,meta.insufficientSamples 已标记
    let payload = fallback;
    let analysisSource = 'rule_fallback';
    if (samples.length >= 3) {
      // 两次 LLM 各自独立降级,②吃①的结论写话术;事务里绝不放 LLM 调用
      const riskOpinion = await enhanceRiskAndOpinion(tenantId, { stats, metrics, samples, fallback });
      const spreadResponse = await enhanceSpreadAndResponse(tenantId, { stats, metrics, samples, fallback, riskOpinion });
      ({ payload, analysisSource } = mergeTopicResult({ fallback, riskOpinion, spreadResponse }));
    }

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

/**
 * 单条深剖(只读消费已有沉淀,不触发 ASR/OCR)。当前为规则兜底桩:stance 取 sentiment、
 * riskLevel 按该记录已命中的预警映射,LLM 深剖与 stale 检测后续接入。
 * 兜底结果同样落缓存 —— 抽屉重开有内容,POST 读到 rule_fallback 缓存会自动再试一次。
 */
export async function analyzeOpinionRecord({ tenantId, recordId }) {
  const record = await queryOne(
    `SELECT id, title, content, sentiment, ai_summary, likes, comments_count, collects, shares,
            negative_comment_count, transcript
     FROM records WHERE id = $1 AND tenant_id = $2`,
    [recordId, tenantId]
  );
  if (!record) return null;

  const alerts = await queryAll(
    `SELECT level, reason FROM alerts WHERE tenant_id = $1 AND record_id = $2 ORDER BY created_at DESC`,
    [tenantId, recordId]
  );
  let riskLevel = 'watch';
  for (const alert of alerts) {
    const mapped = RECORD_RISK_BY_ALERT_LEVEL[alert.level] || 'watch';
    if (RISK_LEVELS.indexOf(mapped) < RISK_LEVELS.indexOf(riskLevel)) riskLevel = mapped;
  }
  riskLevel = normalizeRiskLevel(riskLevel);

  const interactionTotal = num(record.likes) + num(record.comments_count) + num(record.collects) + num(record.shares);
  const payload = {
    meta: { promptVersion: RECORD_PROMPT_VERSION, generatedAt: new Date().toISOString() },
    overview: {
      stance: record.sentiment || 'neutral',
      riskLevel,
      riskLevelLabel: RISK_LEVEL_LABEL[riskLevel],
      summary: compact(record.ai_summary || record.content || record.title, 160),
    },
    contentInsights: { corePoints: [], issues: [], evidenceSources: [] },
    commentInsights: { summary: '', points: [] },
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

  const inputHash = await computeRecordInputHash(tenantId, record);
  await execute(
    `INSERT INTO opinion_record_analyses (tenant_id, record_id, payload, analysis_source, prompt_version, input_hash)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     ON CONFLICT (tenant_id, record_id)
     DO UPDATE SET payload = excluded.payload, analysis_source = excluded.analysis_source,
       prompt_version = excluded.prompt_version, input_hash = excluded.input_hash, updated_at = now()`,
    [tenantId, recordId, JSON.stringify(payload), 'rule_fallback', RECORD_PROMPT_VERSION, inputHash]
  );
  return { payload, source: 'rule_fallback', inputHash };
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
