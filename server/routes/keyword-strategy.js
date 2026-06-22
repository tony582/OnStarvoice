import { Router } from 'express';
import { requireTenantAccess, requireAuthCodeFirst } from '../middleware/auth.js';
import { callLLMWithPrompt } from '../services/ai-labeler.js';
import { execute } from '../db/init.js';

const keywordOpportunityRouter = Router();
export const keywordAnalysisRouter = Router();

// ── 内容创意面持久化:算完顺手落库,失败不影响响应(fire-and-forget)──
function persistTrackStrategy(tenantId, keyword, platform, sampleCount, data) {
  const m = data?.ruleMetrics || data?.metrics || {};
  execute(`
    INSERT INTO track_strategies (tenant_id, keyword, platform, heat_level, cliff_drop_ratio, sample_count, direction_count, angle_count, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
  `, [tenantId, keyword, platform, String(m.heatLevel || ''), Number(m.cliffDropRatio || 0),
      sampleCount, (data?.hotTopicDirections || []).length, (data?.recommendedAngles || []).length, JSON.stringify(data || {})])
    .catch(err => console.warn('[ContentStudio] persist track_strategy failed:', err.message));
}

function persistBenchmark(tenantId, keyword, platform, candidateCount, data) {
  execute(`
    INSERT INTO benchmark_results (tenant_id, keyword, platform, candidate_count, payload)
    VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [tenantId, keyword, platform, candidateCount, JSON.stringify(data || {})])
    .catch(err => console.warn('[ContentStudio] persist benchmark failed:', err.message));
}

function persistKeywordExpansion(tenantId, seedKeyword, platform, keywordCount, data) {
  execute(`
    INSERT INTO keyword_expansions (tenant_id, seed_keyword, platform, keyword_count, payload)
    VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [tenantId, seedKeyword, platform, keywordCount, JSON.stringify(data || {})])
    .catch(err => console.warn('[ContentStudio] persist keyword_expansion failed:', err.message));
}

const TOPIC_DEFINITIONS = [
  {
    id: 'billing',
    name: '价格/续费/套餐价值',
    terms: ['续费', '收费', '价格', '套餐', '到期', '流量', '会员', '贵', '免费', '年费', '订阅', '权益'],
    userIntent: '用户想判断这项服务值不值得继续付费，以及不同套餐到底差在哪里。',
    whyItWorks: '价格和续费内容天然带有决策压力，容易引发车主讨论、对比和真实经验补充。',
    organicNote: '适合用真实账单、权益清单和使用频率做自然流量内容。',
  },
  {
    id: 'feature',
    name: '功能教程/远程控制',
    terms: ['远程', '启动', '解锁', '上锁', '车况', '定位', '车机', '互联', '蓝牙', '钥匙', 'app', 'APP', '教程', '使用'],
    userIntent: '用户想知道某个功能怎么开、怎么用、为什么偶尔失效。',
    whyItWorks: '功能教程能直接解决使用问题，搜索意图明确，也容易沉淀为长期流量。',
    organicNote: '适合做步骤化教程、异常排查和真实场景演示。',
  },
  {
    id: 'trouble',
    name: '故障排查/不能用',
    terms: ['不能用', '用不了', '失效', '打不开', '登录', '绑定', '报错', '故障', '闪退', '没反应', '失败', '异常'],
    userIntent: '用户遇到具体问题，想快速确认原因和解决办法。',
    whyItWorks: '故障类内容痛点强，评论区也容易补充更多场景，是舆情和选题都需要关注的方向。',
    organicNote: '适合用“现象-原因-解决办法-仍不行怎么办”的结构。',
  },
  {
    id: 'safety',
    name: '安全救援/隐私风险',
    terms: ['救援', 'SOS', 'sos', '事故', '碰撞', '安全', '道路救援', '紧急', '隐私', '定位', '泄露', '数据'],
    userIntent: '用户关注关键时刻是否可靠，以及定位和数据是否安全。',
    whyItWorks: '安全和隐私属于高信任议题，少量真实案例也会带来较高关注。',
    organicNote: '适合做事实澄清、案例复盘和官方能力解释。',
  },
  {
    id: 'brand',
    name: '车型/品牌/官方信息',
    terms: ['别克', '凯迪拉克', '雪佛兰', '官方', '品牌', '新车', '升级', '车主', '服务商', '客服', '售后'],
    userIntent: '用户想确认品牌官方动作、车型适配、售后服务和真实口碑。',
    whyItWorks: '品牌和车型语境有利于聚拢精准人群，适合承接官方答疑和口碑管理。',
    organicNote: '适合做车型适配清单、服务边界说明和口碑回应。',
  },
  {
    id: 'experience',
    name: '真实体验/车主故事',
    terms: ['体验', '分享', '车主', '自驾', '用车', '日常', '真实', '测评', '对比', '好用', '值不值'],
    userIntent: '用户想看真实车主怎么评价，而不是只看官方功能说明。',
    whyItWorks: '体验型内容门槛低，容易带出评论互动，也能承接更泛的种草和避坑需求。',
    organicNote: '适合用短故事、前后对比和真实使用频率展开。',
  },
];

const LONGTAIL_CATEGORIES = [
  { id: 'problem', icon: '!', name: '问题排查', terms: ['不能', '失败', '报错', '故障', '失效', '打不开', '登录', '绑定', '闪退', '没反应'] },
  { id: 'howto', icon: '?', name: '使用教程', terms: ['怎么', '如何', '教程', '设置', '打开', '关闭', '绑定', '激活', '使用'] },
  { id: 'billing', icon: '¥', name: '价格续费', terms: ['收费', '续费', '价格', '套餐', '免费', '到期', '会员', '贵', '流量'] },
  { id: 'compare', icon: '=', name: '对比决策', terms: ['对比', '区别', '哪个好', '值不值', '有用吗', '必要吗', '推荐'] },
  { id: 'scenario', icon: '#', name: '场景需求', terms: ['远程启动', '定位', '救援', '车况', '车机', '钥匙', '隐私', '安全'] },
];

function cleanText(value, maxLength = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return value.split(/[,，、\s]+/).map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeItem(item = {}, index = 0) {
  const tags = normalizeArray(item.tags).map(tag => cleanText(tag, 24)).filter(Boolean);
  return {
    key: cleanText(item.noteId || item.id || item.url || item.title || `item-${index}`, 220),
    noteId: cleanText(item.noteId || item.id || '', 120),
    url: cleanText(item.url || item.link || '', 500),
    title: cleanText(item.title || item.noteTitle || '', 180),
    authorName: cleanText(item.authorName || item.author || item.nickname || '', 80),
    publishTime: cleanText(item.publishTime || item.publishDate || item.lastEditedAt || '', 80),
    likes: numberValue(item.likes ?? item.likeCount ?? item.like_count),
    comments: numberValue(item.comments ?? item.commentCount ?? item.comments_count),
    collects: numberValue(item.collects ?? item.collectCount ?? item.collects_count),
    noteType: cleanText(item.noteType || item.type || '', 40),
    content: cleanText(item.content || item.desc || item.description || '', 1600),
    tags,
    authorFollowerCount: numberValue(item.authorFollowerCount || item.bloggerFollowersCount),
  };
}

function normalizeItems(listItems = [], representativeSamples = []) {
  const seen = new Set();
  const merged = [];
  [...normalizeArray(representativeSamples), ...normalizeArray(listItems)].forEach((raw, index) => {
    const item = normalizeItem(raw, index);
    const key = item.noteId || item.url || item.title;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

function average(values = []) {
  const valid = values.map(numberValue).filter(value => value > 0);
  if (!valid.length) return 0;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

function percentile(values = [], p = 0.5) {
  const valid = values.map(numberValue).sort((left, right) => left - right);
  if (!valid.length) return 0;
  const index = Math.min(valid.length - 1, Math.max(0, Math.ceil(valid.length * p) - 1));
  return valid[index] || 0;
}

function computeRuleMetrics(items = []) {
  const sortedItems = [...items].sort((left, right) => {
    const leftScore = left.likes + left.comments * 2 + left.collects;
    const rightScore = right.likes + right.comments * 2 + right.collects;
    return rightScore - leftScore;
  });
  const likes = sortedItems.map(item => item.likes);
  const medianLikes = percentile(likes, 0.5);
  const p80Likes = percentile(likes, 0.8);
  const p90Likes = percentile(likes, 0.9);
  const maxLikes = likes[likes.length - 1] || likes[0] || 0;
  let cliffIndex = 0;
  let cliffDropRatio = 0;

  sortedItems.slice(0, Math.min(20, sortedItems.length) - 1).forEach((item, index) => {
    const current = numberValue(item.likes);
    const next = numberValue(sortedItems[index + 1]?.likes);
    if (current <= 0 || index < 2) return;
    const dropRatio = (current - next) / current;
    if (dropRatio >= 0.25 && dropRatio > cliffDropRatio) {
      cliffDropRatio = dropRatio;
      cliffIndex = index + 1;
    }
  });

  const fallbackHighBandCount = Math.min(12, Math.max(5, Math.ceil(sortedItems.length * 0.1)));
  const highBandCount = Math.min(sortedItems.length, cliffIndex > 0 ? cliffIndex : fallbackHighBandCount);
  const highBandAvgLikes = average(sortedItems.slice(0, highBandCount).map(item => item.likes));
  const top10AvgLikes = average(sortedItems.slice(0, 10).map(item => item.likes));
  const heatLevel = top10AvgLikes >= 1000 || p90Likes >= 2000 ? 'high' : top10AvgLikes >= 200 || p80Likes >= 400 ? 'medium' : 'low';

  sortedItems.forEach((item, index) => {
    item.rank = index + 1;
    item.band = index < highBandCount ? 'high' : index < Math.max(highBandCount + 1, Math.ceil(sortedItems.length / 2)) ? 'mid' : 'low';
  });

  return {
    sortedItems,
    heatLevel,
    highBandStart: sortedItems.length ? 1 : 0,
    highBandEnd: highBandCount,
    highBandCount,
    cliffIndex,
    cliffDropRatio,
    maxLikes: sortedItems[0]?.likes || 0,
    top5AvgLikes: average(sortedItems.slice(0, 5).map(item => item.likes)),
    top10AvgLikes,
    medianLikes,
    p80Likes,
    p90Likes,
    highBandAvgLikes,
    midBandAvgLikes: average(sortedItems.slice(highBandCount, Math.max(highBandCount + 1, highBandCount * 2)).map(item => item.likes)),
  };
}

function itemText(item) {
  return `${item.title} ${item.content} ${item.tags.join(' ')}`.toLowerCase();
}

function classifyTopic(item) {
  const text = itemText(item);
  let best = null;
  let bestScore = 0;
  for (const definition of TOPIC_DEFINITIONS) {
    const score = definition.terms.reduce((sum, term) => sum + (text.includes(String(term).toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) {
      best = definition;
      bestScore = score;
    }
  }
  return best || {
    id: 'general',
    name: '综合搜索结果',
    terms: [],
    userIntent: '用户仍在泛搜索阶段，可能需要更明确的内容角度来判断。',
    whyItWorks: '这类内容覆盖面较广，适合作为长尾需求下钻前的基础样本。',
    organicNote: '建议继续拆成更具体的问题、场景和对比词。',
  };
}

function resolveBandPresence(items = []) {
  const bands = new Set(items.map(item => item.band).filter(Boolean));
  if (bands.has('high') && bands.has('mid') && bands.has('low')) return 'all';
  if (bands.has('high') && bands.has('mid')) return 'high_mid';
  if (bands.has('mid') && bands.has('low')) return 'mid_low';
  if (bands.has('high')) return 'high';
  if (bands.has('mid')) return 'mid';
  if (bands.has('low')) return 'low';
  return 'all';
}

function resolveOrganicViability(direction, metrics) {
  const presence = direction.bandPresence;
  if ((presence === 'all' || presence === 'high_mid' || presence === 'mid_low') && direction.sampleCount >= 3) {
    return 'high';
  }
  if (direction.avgLikes >= Math.max(metrics.medianLikes, 100) || direction.sampleCount >= 2) {
    return 'medium';
  }
  return 'low';
}

function buildTopicDirections(sortedItems, metrics) {
  const groups = new Map();
  sortedItems.forEach(item => {
    const topic = classifyTopic(item);
    if (!groups.has(topic.id)) groups.set(topic.id, { topic, items: [] });
    groups.get(topic.id).items.push(item);
  });

  return [...groups.values()]
    .map(group => {
      const groupItems = group.items.sort((left, right) => right.likes - left.likes);
      const avgLikes = average(groupItems.map(item => item.likes));
      const direction = {
        name: group.topic.name,
        bandPresence: resolveBandPresence(groupItems),
        sampleCount: groupItems.length,
        shareRatio: sortedItems.length ? groupItems.length / sortedItems.length : 0,
        avgLikes,
        userIntent: group.topic.userIntent,
        whyItWorks: group.topic.whyItWorks,
        organicNote: group.topic.organicNote,
        representativeTitles: groupItems.slice(0, 4).map(item => item.title).filter(Boolean),
      };
      direction.organicViability = resolveOrganicViability(direction, metrics);
      return direction;
    })
    .sort((left, right) => (right.avgLikes * right.sampleCount) - (left.avgLikes * left.sampleCount))
    .slice(0, 6);
}

function buildCoreSubtopics(keyword, items = []) {
  const stopWords = new Set(['视频', '笔记', '分享', '教程', '官方', '一个', '这个', '怎么', '如何', keyword]);
  const scores = new Map();
  const add = (text, weight = 1) => {
    const value = cleanText(text, 24);
    if (!value || value.length < 2 || value.length > 16 || stopWords.has(value)) return;
    scores.set(value, (scores.get(value) || 0) + weight);
  };

  items.forEach(item => {
    item.tags.forEach(tag => add(tag, 8 + Math.log10(item.likes + 10)));
    TOPIC_DEFINITIONS.flatMap(topic => topic.terms).forEach(term => {
      if (itemText(item).includes(String(term).toLowerCase())) add(term, 5 + Math.log10(item.likes + 10));
    });
    cleanText(item.title, 120)
      .split(/[｜|,，。！!？?、:：/\s]+/)
      .forEach(part => add(part, 2));
  });

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([text]) => text)
    .slice(0, 12);
}

function buildRecommendedAngles(keyword, directions = []) {
  const topDirections = directions.slice(0, 3);
  const angles = topDirections.map(direction => ({
    title: `围绕「${direction.name}」做一篇真实场景答疑`,
    audiencePainPoint: direction.userIntent,
    formatSuggestion: '问题开头 + 真实场景 + 结论清单 + 评论区补充收集',
    executionHint: `优先引用当前搜索里高赞内容的共性，但标题要切到更具体的用户问题，不要只重复「${keyword}」。`,
  }));

  if (angles.length < 3) {
    angles.push({
      title: `做「${keyword}」值不值得用的对比清单`,
      audiencePainPoint: '用户想用最短时间判断功能价值、收费边界和适用人群。',
      formatSuggestion: '表格/清单型内容，按功能、费用、适合人群、常见问题分段。',
      executionHint: '把争议点写清楚，比单纯夸产品更容易获得真实互动。',
    });
  }

  if (angles.length < 3) {
    angles.push({
      title: `整理「${keyword}」新手最容易踩的 5 个坑`,
      audiencePainPoint: '新用户缺少上下文，容易在开通、绑定、续费或使用步骤上卡住。',
      formatSuggestion: '避坑清单 + 截图步骤 + 失败原因解释。',
      executionHint: '每个坑后面给一个可执行动作，方便后续承接客服或官方回应。',
    });
  }

  return angles.slice(0, 5);
}

function buildDistributionSummary(keyword, metrics, directions) {
  const heat = metrics.heatLevel === 'high' ? '高热' : metrics.heatLevel === 'medium' ? '中等热度' : '低热度';
  const topNames = directions.slice(0, 3).map(item => item.name).join('、') || '泛搜索内容';
  const cliff = metrics.cliffDropRatio > 0.25
    ? `前排存在约 ${Math.round(metrics.cliffDropRatio * 100)}% 的断层，说明流量集中在少数强内容上`
    : '前排没有特别明显的断层，说明中腰部仍有切入空间';
  return `「${keyword}」当前样本呈现${heat}，主要集中在${topNames}。${cliff}。建议先从更具体的问题场景和对比/答疑型内容切入。`;
}

function buildOpportunityFallback({ keyword, platform, listItems, representativeSamples }) {
  const normalizedItems = normalizeItems(listItems, representativeSamples);
  const metrics = computeRuleMetrics(normalizedItems);
  const directions = buildTopicDirections(metrics.sortedItems, metrics);
  const coreWinningSubtopics = buildCoreSubtopics(keyword, metrics.sortedItems);
  const recommendedAngles = buildRecommendedAngles(keyword, directions);

  return {
    keyword,
    platform: cleanText(platform, 40),
    generatedAt: new Date().toISOString(),
    distributionSummary: buildDistributionSummary(keyword, metrics, directions),
    ruleMetrics: {
      heatLevel: metrics.heatLevel,
      highBandStart: metrics.highBandStart,
      highBandEnd: metrics.highBandEnd,
      highBandCount: metrics.highBandCount,
      cliffIndex: metrics.cliffIndex,
      cliffDropRatio: Number(metrics.cliffDropRatio.toFixed(4)),
      maxLikes: metrics.maxLikes,
      top5AvgLikes: metrics.top5AvgLikes,
      top10AvgLikes: metrics.top10AvgLikes,
      medianLikes: metrics.medianLikes,
      p80Likes: metrics.p80Likes,
      p90Likes: metrics.p90Likes,
      highBandAvgLikes: metrics.highBandAvgLikes,
      midBandAvgLikes: metrics.midBandAvgLikes,
      sampleCount: normalizedItems.length,
      detailSampleCount: normalizeArray(representativeSamples).length,
    },
    hotTopicDirections: directions,
    coreWinningSubtopics,
    recommendedAngles,
    analysisSource: 'rule_fallback',
  };
}

function safeArrayOfStrings(value, fallback = []) {
  const arr = normalizeArray(value).map(item => cleanText(item, 40)).filter(Boolean);
  return arr.length ? arr : fallback;
}

function mergeOpportunityAiResult(fallback, aiResult) {
  if (!aiResult || typeof aiResult !== 'object') return fallback;
  return {
    ...fallback,
    distributionSummary: cleanText(aiResult.distributionSummary || aiResult.summary || fallback.distributionSummary, 600),
    hotTopicDirections: Array.isArray(aiResult.hotTopicDirections)
      ? aiResult.hotTopicDirections.slice(0, 6).map((item, index) => ({
          ...fallback.hotTopicDirections[index],
          ...item,
          name: cleanText(item.name || fallback.hotTopicDirections[index]?.name || '未命名方向', 60),
          representativeTitles: safeArrayOfStrings(item.representativeTitles, fallback.hotTopicDirections[index]?.representativeTitles || []),
        }))
      : fallback.hotTopicDirections,
    coreWinningSubtopics: safeArrayOfStrings(aiResult.coreWinningSubtopics, fallback.coreWinningSubtopics),
    recommendedAngles: Array.isArray(aiResult.recommendedAngles)
      ? aiResult.recommendedAngles.slice(0, 5).map((item, index) => ({
          ...fallback.recommendedAngles[index],
          ...item,
          title: cleanText(item.title || fallback.recommendedAngles[index]?.title || '未命名选题', 80),
        }))
      : fallback.recommendedAngles,
    analysisSource: 'llm_with_rule_metrics',
  };
}

async function enhanceOpportunityWithAI(tenantId, fallback, payload) {
  const samples = normalizeItems(payload.listItems, payload.representativeSamples)
    .slice(0, 24)
    .map(item => ({
      title: item.title,
      content: item.content.slice(0, 260),
      tags: item.tags,
      likes: item.likes,
      comments: item.comments,
      collects: item.collects,
      authorName: item.authorName,
    }));
  const systemPrompt = `你是社交媒体选题策略分析师。请基于搜索结果样本判断主词机会，只输出 JSON，不要解释。字段必须包含：distributionSummary、hotTopicDirections、coreWinningSubtopics、recommendedAngles。hotTopicDirections 每项包含 name、userIntent、whyItWorks、organicNote、representativeTitles。recommendedAngles 每项包含 title、audiencePainPoint、formatSuggestion、executionHint。`;
  const userMessage = JSON.stringify({
    keyword: payload.keyword,
    platform: payload.platform,
    ruleMetrics: fallback.ruleMetrics,
    samples,
  });

  try {
    const aiResult = await callLLMWithPrompt(tenantId, systemPrompt, userMessage);
    return mergeOpportunityAiResult(fallback, aiResult);
  } catch (err) {
    console.warn('[KeywordStrategy] Opportunity AI enhance failed:', err.message);
    return fallback;
  }
}

function categorizeLongtailKeyword(keyword) {
  const text = cleanText(keyword, 80).toLowerCase();
  let best = null;
  let score = 0;
  for (const category of LONGTAIL_CATEGORIES) {
    const nextScore = category.terms.reduce((sum, term) => sum + (text.includes(String(term).toLowerCase()) ? 1 : 0), 0);
    if (nextScore > score) {
      best = category;
      score = nextScore;
    }
  }
  return best || { id: 'general', icon: '+', name: '泛需求扩展', terms: [] };
}

function buildKeywordAnalysisFallback({ seedKeyword, keywords, platform }) {
  const uniqueKeywords = [...new Set(normalizeArray(keywords).map(item => cleanText(item, 60)).filter(Boolean))];
  const groups = new Map();
  uniqueKeywords.forEach(keyword => {
    const category = categorizeLongtailKeyword(keyword);
    if (!groups.has(category.id)) groups.set(category.id, { category, keywords: [] });
    groups.get(category.id).keywords.push(keyword);
  });
  const categories = [...groups.values()]
    .sort((left, right) => right.keywords.length - left.keywords.length)
    .map((group, index) => ({
      id: group.category.id || `cat-${index}`,
      icon: group.category.icon || '+',
      name: group.category.name || '需求方向',
      insight: `这组词围绕「${seedKeyword}」的${group.category.name}展开，适合用作搜索页采集、选题拆分和评论线索观察。`,
      keywords: group.keywords.slice(0, 80),
      sampleCandidateKeywords: group.keywords.slice(0, 3),
    }));

  return {
    seedKeyword,
    platform: cleanText(platform, 40),
    generatedAt: new Date().toISOString(),
    summary: `围绕「${seedKeyword}」共识别 ${uniqueKeywords.length} 个长尾词，主要分布在 ${categories.slice(0, 3).map(item => item.name).join('、') || '泛需求扩展'}。建议优先采集问题排查、价格续费和高频功能场景。`,
    categories,
    analysisSource: 'rule_fallback',
  };
}

function mergeKeywordAnalysisAiResult(fallback, aiResult) {
  if (!aiResult || typeof aiResult !== 'object') return fallback;
  const aiCategories = Array.isArray(aiResult.categories) ? aiResult.categories : [];
  return {
    ...fallback,
    summary: cleanText(aiResult.summary || fallback.summary, 600),
    categories: aiCategories.length
      ? aiCategories.slice(0, 8).map((item, index) => ({
          ...fallback.categories[index],
          ...item,
          id: cleanText(item.id || fallback.categories[index]?.id || `cat-${index}`, 40),
          icon: cleanText(item.icon || fallback.categories[index]?.icon || '+', 4),
          name: cleanText(item.name || fallback.categories[index]?.name || '需求方向', 40),
          insight: cleanText(item.insight || fallback.categories[index]?.insight || '', 240),
          keywords: safeArrayOfStrings(item.keywords, fallback.categories[index]?.keywords || []),
          sampleCandidateKeywords: safeArrayOfStrings(item.sampleCandidateKeywords, fallback.categories[index]?.sampleCandidateKeywords || []),
        }))
      : fallback.categories,
    analysisSource: 'llm_with_rule_fallback',
  };
}

async function enhanceKeywordAnalysisWithAI(tenantId, fallback, payload) {
  const systemPrompt = `你是社交媒体关键词需求分析师。请把扩展词按用户需求聚类，只输出 JSON：{ "summary": "...", "categories": [{"id":"", "icon":"", "name":"", "insight":"", "keywords":[], "sampleCandidateKeywords":[]}] }。分类要适合内容采集和舆情运营，不要输出 Markdown。`;
  const userMessage = JSON.stringify({
    seedKeyword: payload.seedKeyword,
    platform: payload.platform,
    keywords: normalizeArray(payload.keywords).slice(0, 160),
  });
  try {
    const aiResult = await callLLMWithPrompt(tenantId, systemPrompt, userMessage);
    return mergeKeywordAnalysisAiResult(fallback, aiResult);
  } catch (err) {
    console.warn('[KeywordStrategy] Keyword analysis AI enhance failed:', err.message);
    return fallback;
  }
}

keywordOpportunityRouter.post('/', requireAuthCodeFirst, async (req, res, next) => {
  try {
    const keyword = cleanText(req.body?.keyword || req.body?.seedKeyword || '', 80);
    const platform = cleanText(req.body?.platform || '', 40);
    const listItems = normalizeArray(req.body?.listItems);
    const representativeSamples = normalizeArray(req.body?.representativeSamples);
    const normalizedItems = normalizeItems(listItems, representativeSamples);

    if (!keyword) {
      return res.json({ ok: false, reason: 'invalid_request', message: '缺少主词' });
    }
    if (normalizedItems.length < 5) {
      return res.json({ ok: false, reason: 'insufficient_samples', message: '有效搜索结果不足，暂时无法判断主词机会' });
    }

    const fallback = buildOpportunityFallback({ keyword, platform, listItems, representativeSamples });
    const data = await enhanceOpportunityWithAI(req.tenantId, fallback, { keyword, platform, listItems, representativeSamples });
    persistTrackStrategy(req.tenantId, keyword, platform, normalizedItems.length, data);
    return res.json({ ok: true, data });
  } catch (err) {
    return next(err);
  }
});

keywordAnalysisRouter.post('/', requireAuthCodeFirst, async (req, res, next) => {
  try {
    const seedKeyword = cleanText(req.body?.seedKeyword || req.body?.keyword || '', 80);
    const platform = cleanText(req.body?.platform || '', 40);
    const keywords = normalizeArray(req.body?.keywords);
    if (!seedKeyword) {
      return res.json({ ok: false, reason: 'invalid_request', message: '缺少种子关键词' });
    }
    if (!keywords.length) {
      return res.json({ ok: false, reason: 'insufficient_keywords', message: '缺少扩展词，无法生成长尾词需求分析' });
    }

    const fallback = buildKeywordAnalysisFallback({ seedKeyword, keywords, platform });
    const data = await enhanceKeywordAnalysisWithAI(req.tenantId, fallback, { seedKeyword, keywords, platform });
    persistKeywordExpansion(req.tenantId, seedKeyword, platform, keywords.length, data);
    return res.json({ ok: true, data });
  } catch (err) {
    return next(err);
  }
});

// ==================== 找对标账号 benchmark-discovery ====================
// 契约对齐扩展端 utils/api.js#analyzeBenchmarkDiscovery + sidebar mergeBenchmarkAiAnalysisIntoResult：
// 请求 { code, keyword, platform, candidates:[{key,authorName,...,profile,topItems}] }
// 响应 { ok:true, data:{ candidateAnalyses:[{key,recommendationReason,focusAssessment,growthPotential,tags}] } }
export const benchmarkDiscoveryRouter = Router();

const BENCHMARK_CANDIDATE_LIMIT = 8;
const GROWTH_LEVELS = ['high', 'medium', 'low'];

function cleanNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function normalizeBenchmarkGrowth(value, fallback = 'medium') {
  const normalized = String(value || '').trim().toLowerCase();
  return GROWTH_LEVELS.includes(normalized) ? normalized : fallback;
}

// 仅取后台需要的字段，控制 payload 体积；过滤无效候选
function normalizeBenchmarkCandidates(rawCandidates) {
  return normalizeArray(rawCandidates)
    .filter(item => item && typeof item === 'object')
    .slice(0, BENCHMARK_CANDIDATE_LIMIT)
    .map(item => {
      const profile = item.profile && typeof item.profile === 'object' ? item.profile : null;
      return {
        key: cleanText(item.key || item.authorProfileUrl || item.authorName || '', 200),
        authorName: cleanText(item.authorName || profile?.bloggerName || '', 80),
        occurrenceCount: cleanNumber(item.occurrenceCount),
        maxLikes: cleanNumber(item.maxLikes),
        averageLikes: cleanNumber(item.averageLikes),
        averageComments: cleanNumber(item.averageComments),
        averageCollects: cleanNumber(item.averageCollects),
        avgEngagement: cleanNumber(item.avgEngagement),
        totalEngagement: cleanNumber(item.totalEngagement),
        performanceDensity: cleanText(item.performanceDensity || '', 40),
        ruleReason: cleanText(item.ruleReason || '', 240),
        profile: profile
          ? {
              bloggerName: cleanText(profile.bloggerName || '', 80),
              description: cleanText(profile.description || '', 300),
              followersCount: cleanNumber(profile.followersCount),
              likedAndCollectedCount: cleanNumber(profile.likedAndCollectedCount),
              bloggerAccountType: cleanText(profile.bloggerAccountType || '', 40),
            }
          : null,
        topItems: normalizeArray(item.topItems)
          .slice(0, 4)
          .map(topItem => ({
            title: cleanText(topItem?.title || '', 120),
            likes: cleanNumber(topItem?.likes),
            comments: cleanNumber(topItem?.comments),
            collects: cleanNumber(topItem?.collects),
          })),
      };
    })
    .filter(item => item.key);
}

// 无 LLM / LLM 失败时的规则兜底：用候选自身指标产出可用判断
function buildBenchmarkRuleAnalysis(candidate) {
  const tags = [];
  if (candidate.occurrenceCount >= 3) tags.push('高频上榜');
  else if (candidate.occurrenceCount === 2) tags.push('多次出现');
  if (candidate.profile?.bloggerAccountType) tags.push(candidate.profile.bloggerAccountType);
  if (candidate.averageLikes >= 5000) tags.push('高赞稳定');
  else if (candidate.averageLikes >= 1000) tags.push('互动良好');
  if (candidate.performanceDensity) tags.push(candidate.performanceDensity);

  let growthPotential = 'low';
  if (candidate.averageLikes >= 5000 || candidate.avgEngagement >= 8000) growthPotential = 'high';
  else if (candidate.averageLikes >= 1000 || candidate.avgEngagement >= 1500) growthPotential = 'medium';

  const recommendationReason =
    candidate.ruleReason ||
    `该账号围绕主词出现 ${candidate.occurrenceCount} 次，平均点赞约 ${Math.round(candidate.averageLikes)}，互动表现${growthPotential === 'high' ? '突出' : growthPotential === 'medium' ? '稳定' : '一般'}，适合作为对标参考。`;

  const focusAssessment =
    candidate.profile?.description ||
    (candidate.topItems[0]?.title
      ? `代表内容方向：${candidate.topItems[0].title}`
      : '内容方向需进一步观察其代表作品。');

  return {
    key: candidate.key,
    authorName: cleanText(candidate.authorName || candidate.author || '', 80),
    recommendationReason: cleanText(recommendationReason, 240),
    focusAssessment: cleanText(focusAssessment, 240),
    growthPotential,
    tags: tags.slice(0, 4),
  };
}

function buildBenchmarkFallback(candidates) {
  return { candidateAnalyses: candidates.map(buildBenchmarkRuleAnalysis) };
}

function mergeBenchmarkAiResult(fallback, aiResult) {
  if (!aiResult || typeof aiResult !== 'object') return fallback;
  const aiAnalyses = Array.isArray(aiResult.candidateAnalyses) ? aiResult.candidateAnalyses : [];
  const aiByKey = new Map(
    aiAnalyses.filter(item => item && item.key).map(item => [String(item.key), item]),
  );
  return {
    candidateAnalyses: fallback.candidateAnalyses.map(base => {
      const ai = aiByKey.get(String(base.key));
      if (!ai) return base;
      return {
        key: base.key,
        authorName: base.authorName,
        recommendationReason: cleanText(ai.recommendationReason, 240) || base.recommendationReason,
        focusAssessment: cleanText(ai.focusAssessment, 240) || base.focusAssessment,
        growthPotential: normalizeBenchmarkGrowth(ai.growthPotential, base.growthPotential),
        tags: Array.isArray(ai.tags) && ai.tags.length
          ? safeArrayOfStrings(ai.tags, base.tags).slice(0, 4)
          : base.tags,
      };
    }),
  };
}

async function enhanceBenchmarkWithAI(tenantId, fallback, payload) {
  const systemPrompt = `你是社交媒体对标账号分析师。请基于候选账号在某主词下的表现数据，判断每个账号是否值得作为对标参考，只输出 JSON，不要解释或 Markdown。格式：{ "candidateAnalyses": [{ "key": "与输入一致", "recommendationReason": "为什么值得对标，结合数据", "focusAssessment": "该账号的内容聚焦方向", "growthPotential": "high|medium|low", "tags": ["标签", "最多4个"] }] }。key 必须与输入候选的 key 完全一致。`;
  const userMessage = JSON.stringify({
    keyword: payload.keyword,
    platform: payload.platform,
    candidates: payload.candidates,
  });
  try {
    const aiResult = await callLLMWithPrompt(tenantId, systemPrompt, userMessage);
    return mergeBenchmarkAiResult(fallback, aiResult);
  } catch (err) {
    console.warn('[KeywordStrategy] Benchmark discovery AI enhance failed:', err.message);
    return fallback;
  }
}

benchmarkDiscoveryRouter.post('/', requireAuthCodeFirst, async (req, res, next) => {
  try {
    const keyword = cleanText(req.body?.keyword || '', 80);
    const platform = cleanText(req.body?.platform || '', 40);
    const candidates = normalizeBenchmarkCandidates(req.body?.candidates);

    if (!keyword) {
      return res.json({ ok: false, reason: 'invalid_request', message: '缺少主词' });
    }
    if (!candidates.length) {
      return res.json({ ok: false, reason: 'insufficient_candidates', message: '候选账号不足，暂时无法判断对标价值' });
    }

    const fallback = buildBenchmarkFallback(candidates);
    const data = await enhanceBenchmarkWithAI(req.tenantId, fallback, { keyword, platform, candidates });
    persistBenchmark(req.tenantId, keyword, platform, candidates.length, data);
    return res.json({ ok: true, data });
  } catch (err) {
    return next(err);
  }
});

export default keywordOpportunityRouter;
