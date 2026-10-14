/** Rich, deterministic UI fixtures. Never imports the collector or requests analysis. */
import {
  renderCreativeOpportunity,
  renderCreativeBenchmark,
  renderCreativeInsightSummary,
  renderCreativeInsightCategories,
} from "/sidebar/creative-results.js";
import {buildCreativeShareText, openCreativeSharePreview} from "/sidebar/creative-share.js";

const DEMO_TS = Date.parse("2026-10-14T06:00:00Z");
const demoUrl = (kind, id) => `https://example.invalid/creative-fixture/${kind}/${id}`;
const works = [
  {title: "安吉星紧急救援：一次实际求助经历（演示）", author: "车主甲（演示）", likes: 19000, collects: 14000, url: demoUrl("note", "rescue")},
  {title: "用了五年安吉星，到底要不要续费（演示）", author: "车主乙（演示）", likes: 239, collects: 42, url: demoUrl("note", "renewal")},
  {title: "远程启动、车况查询和碰撞求助，哪些服务在我的车型上能用（演示）", author: "车主丙（演示）", likes: 68, collects: 16, url: demoUrl("note", "features")},
];

function makeSnapshots(platform) {
  const platformLabel = platform === "douyin" ? "抖音" : "小红书";
  const opportunity = {
    keyword: "安吉星（演示）", platformLabel, platform, ts: DEMO_TS, sampleCount: 80,
    distributionSummary: "这组演示样本中，互动集中在真实救援经历。功能介绍和活动内容的互动较低。可以先验证续费决策和实际使用问题，不宜把少数高赞内容当作整体表现。以下数量与内容仅用于界面验收，不是业务结论。",
    ruleMetrics: {heatLevel: "high", highBandStart: 1, highBandEnd: 11, highBandCount: 11, cliffDropRatio: 0.84, highBandAvgLikes: 4280, medianLikes: 8, sampleCount: 80, detailSampleCount: 20, p80Likes: 68, maxLikes: 19000},
    hotTopicDirections: [
      {name: "真实救援经历", bandPresence: "high", organicViability: "medium", sampleCount: 11, shareRatio: 11 / 80, avgLikes: 4280, userIntent: "服务遇到紧急情况时是否有用。", whyItWorks: "具体过程、处理时间和结果能回答用户的疑问。", organicNote: "演示样本较少，不能据此预测下一篇内容的流量。", representativeTitles: [works[0].title]},
      {name: "续费价格与使用频率", bandPresence: "mid_low", organicViability: "medium", sampleCount: 29, shareRatio: 29 / 80, avgLikes: 46, userIntent: "根据自己的使用频率决定是否续费。", whyItWorks: "把价格、权益和真实使用频率放在一起，方便用户自行判断。", organicNote: "需要核对当前套餐和适用车型。", representativeTitles: [works[1].title, "没有可关联原文的标题，也应保留可读文本（演示）"]},
      {name: "不同年款、车型与套餐下的功能边界和操作说明（长标题演示）", bandPresence: "all", organicViability: "low", sampleCount: 40, shareRatio: 40 / 80, avgLikes: 8, userIntent: "确认自己的车是否支持所需功能。", whyItWorks: "按使用场景拆解操作步骤，明确哪些内容需以车型与套餐为准。", organicNote: "", representativeTitles: [works[2].title]},
    ],
    coreWinningSubtopics: ["紧急救援", "续费价值", "远程启动", "不同年款与套餐的功能差异（长词演示）"],
    recommendedAngles: [
      {title: "我这一年用了几次安吉星？（演示）", audiencePainPoint: "不知道续费是否划算。", formatSuggestion: "使用记录与费用对照。", executionHint: "只列本人实际使用记录，套餐价格注明日期。"},
      {title: "遇到事故后，求助过程是怎样的？（演示）", audiencePainPoint: "想知道服务能提供什么、不能提供什么。", formatSuggestion: "按时间顺序记录。", executionHint: "隐去个人与车辆敏感信息，说明资料来源。"},
      {title: "功能是否可用，要先核对哪几项？（演示）", audiencePainPoint: "同一个功能在不同年款车型上的表现不一致。", formatSuggestion: "车型、年款、套餐检查表。", executionHint: ""},
    ],
    _listItems: works, _representativeSamples: works.slice(0, 2),
  };
  const benchmark = {
    keyword: "安吉星（演示）", platformLabel, platform, ts: DEMO_TS,
    sampleCount: 20, candidateCount: 3, minOccurrence: 2,
    candidates: [
      {authorName: "开车记录本（演示）", authorProfileUrl: demoUrl("profile", "owner-a"), occurrenceCount: 3, maxLikes: 6442, averageLikes: 4216,
        profile: {bloggerName: "开车记录本（演示）", followersCount: 8600, likedAndCollectedCount: 52000},
        analysis: {recommendationReason: "多篇内容都在讨论车主的实际使用问题。", focusAssessment: "目前只看了搜索样本，账号整体内容仍需打开主页复核。", growthPotential: "medium", tags: ["车主经验", "多次出现", "方向相关"], decisionAngle: "看它如何记录使用过程与回答评论。"},
        topItems: [works[0], works[1]]},
      {authorName: "关于凯迪拉克日常使用与长途自驾的详细记录（长名称演示）", authorProfileUrl: demoUrl("profile", "owner-b"), occurrenceCount: 2, maxLikes: 318, averageLikes: 194,
        profile: {bloggerName: "关于凯迪拉克日常使用与长途自驾的详细记录（长名称演示）", followersCount: 950, likedAndCollectedCount: 2840},
        analysis: {recommendationReason: "粉丝量不高，但有具体操作类内容获得互动。", focusAssessment: "先复核作品的相关性，再决定是否持续观察。", growthPotential: "high", tags: ["操作说明", "小体量账号", "标题很长的标签也需要正常换行（演示）"], decisionAngle: "关注问题表述、使用条件和操作细节。"},
        topItems: [works[2]]},
      {authorName: "暂未补全主页的账号（演示）", authorProfileUrl: "", occurrenceCount: 2, maxLikes: 8, averageLikes: 4, profile: null,
        analysis: null, topItems: []},
    ],
  };
  const categories = [
    {id: "renewal", name: "续费决策", icon: "🤔", insight: "用户想知道是否需要续费、如何选择套餐。样本中的负面表达不能替代全部用户意见。", keywords: ["安吉星有必要续费吗", "安吉星续费价格", "安吉星不续费还能用哪些功能", "安吉星到期后再续费会不会影响之前的套餐优惠（长词演示）"]},
    {id: "features", name: "功能使用", icon: "🔧", insight: "主要问题是远程启动、定位和车况查询的操作方式，以及不同车型的适用范围。", keywords: ["安吉星远程启动", "安吉星怎么定位车辆", "安吉星车况查询", "安吉星账号怎么绑定", "安吉星怎么连接手机"]},
    {id: "rescue", name: "紧急救援", icon: "🛟", insight: "用户关心何时能求助、服务会如何响应。应以实际服务条款及完整经历为依据。", keywords: ["安吉星紧急救援", "安吉星碰撞自动求助", "安吉星救援收费吗"]},
    {id: "cost", name: "套餐与费用", icon: "💰", insight: "价格问题应结合套餐内容、优惠日期和车型确认，避免只给一个没有条件的数字。", keywords: ["安吉星一年多少钱", "安吉星套餐区别", "安吉星优惠续费"]},
    {id: "account", name: "账号与隐私", icon: "🔒", insight: "", keywords: ["安吉星怎么解绑", "安吉星车辆过户", "安吉星隐私设置"]},
  ];
  const sampleResultsByCategoryId = {
    renewal: {usedKeyword: "安吉星续费价格（演示）", samples: [works[1], {title: "", author: "未记录标题的车主（演示）", likes: 3, url: ""}, {title: "续费前先核对年款、套餐权益和自己的使用频率（长标题演示）", author: "自驾笔记（演示）", likes: 3, url: demoUrl("note", "renewal-checklist")}]},
    features: {usedKeyword: "安吉星远程启动（演示）", samples: [works[2]]},
    rescue: {usedKeyword: "安吉星紧急救援（演示）", samples: [works[0]]},
    cost: {errorMessage: "演示异常：样本暂未获取，已有关键词保留。", samples: []},
    account: {usedKeyword: "安吉星怎么解绑（演示）", samples: []},
  };
  const longtail = {
    seedKeyword: "安吉星（演示）", platformLabel, platform, ts: DEMO_TS,
    totalKeywords: categories.reduce((count, category) => count + category.keywords.length, 0),
    analysis: {summary: "演示扩展词主要围绕续费、功能使用和救援。可以按具体问题组织内容，再用原始样本核对表述；关键词数量只表示本次扩词结果，不代表搜索热度。", categories},
    sampleStatusByCategoryId: {renewal: "success", features: "success", rescue: "loading", cost: "error", account: "success"},
    sampleResultsByCategoryId,
  };
  return {opportunity, benchmark, longtail};
}

export function installCreativeResultsFixture({document, window, scenario, platform, report}) {
  const kinds = new Set(["opportunity", "benchmark", "longtail"]);
  const requested = String(scenario || "").replace(/^creative-/, "");
  if (!String(scenario || "").startsWith("creative-") || !kinds.has(requested)) return null;
  const $ = id => document.getElementById(id);
  const snapshots = makeSnapshots(platform);
  let currentKind = requested;
  const expandedIds = new Set();
  let expandedWordsVisible = false;
  let longtailEdited = false;
  const cleared = new Set();
  const paneIds = {opportunity: "keywordStrategyOpportunityPane", benchmark: "keywordStrategyBenchmarkPane", longtail: "keywordStrategyLongtailPane"};
  const notice = text => {
    window.showMessage?.(text, "info");
    report?.(text);
  };
  const helpers = {
    fallbackAnalysis: () => ({recommendationReason: "主页信息未补全，先核对账号内容。", focusAssessment: "仅有当前搜索样本，不能判断账号整体表现。", growthPotential: "low", tags: ["待复核"]}),
    ruleReason: candidate => `本次演示样本出现 ${candidate.occurrenceCount || 0} 次。`,
    decisionAngle: (_candidate, analysis) => analysis?.decisionAngle || "先打开主页复核内容方向。",
    evidence: candidate => [
      `样本出现 ${candidate.occurrenceCount || 0} 次，最高赞 ${candidate.maxLikes || 0}，均赞 ${candidate.averageLikes || 0}`,
      ...(candidate.profile?.followersCount ? [`主页粉丝 ${candidate.profile.followersCount}，仅为演示数据`] : ["尚无完整主页数据"]),
    ],
    works: (candidate, limit = 3) => (candidate.topItems || []).slice(0, limit),
  };
  const snapshot = kind => {
    if (kind !== "longtail") return snapshots[kind];
    const value = snapshots.longtail;
    return {
      seedKeyword: value.seedKeyword, totalKeywords: value.totalKeywords,
      summary: value.analysis.summary, platformLabel: value.platformLabel, ts: value.ts,
      categories: value.analysis.categories.map(category => ({
        ...category,
        sampleKeyword: value.sampleResultsByCategoryId[category.id]?.usedKeyword || "",
        samples: value.sampleResultsByCategoryId[category.id]?.samples || [],
      })),
    };
  };

  function renderLongtail() {
    const value = snapshots.longtail;
    const hasResult = !cleared.has("longtail");
    $("keywordInsightIntro").hidden = hasResult;
    $("keywordInsightContainer").hidden = !hasResult;
    $("btnRunKeywordInsight").hidden = hasResult;
    $("btnExpandKeywords").hidden = !hasResult;
    $("btnExpandKeywords").textContent = "重新分析";
    $("btnExpandKeywords").classList.remove("btn-danger");
    $("btnClearKeywordInsightResult").hidden = !hasResult;
    $("keywordInsightActionRow").classList.toggle("is-result-mode", hasResult);
    $("keywordInsightError").hidden = !longtailEdited;
    if (longtailEdited) $("keywordInsightErrorMessage").textContent = "演示：扩展词已调整。点击重新分析恢复示例；不会请求后台。";
    $("keywordInsightSummary").innerHTML = hasResult && !longtailEdited ? renderCreativeInsightSummary(value) : "";
    $("keywordInsightCategories").innerHTML = hasResult && !longtailEdited ? renderCreativeInsightCategories({...value, expandedIds}) : "";
    $("expandedKeywordsPanel").hidden = !hasResult || !expandedWordsVisible;
    $("btnViewExpandedKeywords").hidden = !hasResult;
    $("btnViewExpandedKeywords").textContent = expandedWordsVisible ? "收起扩展词" : `查看全部扩展词 (${value.totalKeywords})`;
    $("expandedKeywordsCount").textContent = `扩展词：${value.totalKeywords} 词`;
    if (!longtailEdited) $("textareaExpandedKeywords").value = value.analysis.categories.flatMap(category => category.keywords).join("\n");
  }

  function render(kind = currentKind) {
    if (!kinds.has(kind)) return;
    currentKind = kind;
    for (const button of document.querySelectorAll("[data-strategy-tab]")) {
      const selected = button.dataset.strategyTab === kind;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      $(paneIds[button.dataset.strategyTab]).hidden = !selected;
    }
    for (const [flow, prefix, runId, stopId] of [
      ["opportunity", "keywordOpportunity", "btnRunKeywordOpportunity", "btnCancelKeywordOpportunity"],
      ["benchmark", "keywordBenchmark", "btnRunBenchmarkDiscovery", "btnCancelBenchmarkDiscovery"],
    ]) {
      const hasResult = !cleared.has(flow);
      $(prefix + "IntroText").hidden = hasResult;
      $(prefix + "Error").hidden = true;
      $(stopId).style.display = "none";
      $(runId).style.display = "inline-flex";
      $(runId).disabled = false;
      $(runId).textContent = hasResult ? "重新分析" : flow === "opportunity" ? "开始判断赛道机会" : "开始找对标账号";
      $(flow === "opportunity" ? "btnClearKeywordOpportunityResult" : "btnClearBenchmarkDiscoveryResult").hidden = !hasResult;
      $(prefix + "Result").innerHTML = !hasResult ? "" : flow === "opportunity"
        ? renderCreativeOpportunity(snapshots.opportunity, {resolveTitleUrl: (_result, title) => works.find(work => work.title === title)?.url || ""})
        : renderCreativeBenchmark(snapshots.benchmark, helpers);
    }
    renderLongtail();
    $("progressContainer").style.display = "none";
    $("debugSessionPanel").hidden = true;
    $("debugSessionDock").hidden = true;
    $("keywordStrategyLongtailHint").textContent = "安吉星 · 结果界面演示，所有样本与数字均为虚构，不会执行采集或后台请求。";
    document.dispatchEvent(new window.Event("change"));
  }

  async function copy(text) {
    try {
      await window.navigator.clipboard.writeText(text);
      notice("已复制演示内容。");
    } catch {
      notice("当前预览环境未获剪贴板权限，未复制。可使用图片预览核对内容。");
    }
  }
  function handleResultAction(event) {
    const target = event.target.closest?.("[data-action], a[href]");
    if (!target) return;
    if (target.matches("a[href]")) {
      event.preventDefault();
      notice("隔离演示：原文链接入口正常，未打开外部网页。");
      return;
    }
    const action = target.dataset.action;
    const copyKind = {"copy-opportunity": "opportunity", "copy-benchmark": "benchmark", "copy-insight": "longtail"}[action];
    const imageKind = {"share-opportunity-as-image": "opportunity", "share-benchmark-as-image": "benchmark", "share-as-image": "longtail"}[action];
    if (copyKind) { event.preventDefault(); void copy(buildCreativeShareText(copyKind, snapshot(copyKind))); return; }
    if (imageKind) {
      event.preventDefault();
      void Promise.resolve(openCreativeSharePreview(imageKind, snapshot(imageKind), {document, window, onMessage: notice}))
        .catch(error => notice(`演示图片预览失败：${error.message}`));
      return;
    }
    if (action === "toggle-expand-category") {
      const id = target.dataset.categoryId;
      if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
      renderLongtail();
      return;
    }
    if (action === "toggle-keyword") { void copy(target.dataset.keyword || ""); return; }
    if (["monitor-benchmark-account", "open-benchmark-profile"].includes(action)) {
      event.preventDefault();
      notice("隔离演示：账号操作入口正常，未添加监控或打开主页。");
    }
  }
  for (const id of ["keywordOpportunityResult", "keywordBenchmarkResult", "keywordInsightSummary", "keywordInsightCategories"]) $(id).addEventListener("click", handleResultAction);
  for (const button of document.querySelectorAll("[data-strategy-tab]")) button.addEventListener("click", () => render(button.dataset.strategyTab));
  for (const [id, kind] of [["btnClearKeywordOpportunityResult", "opportunity"], ["btnClearBenchmarkDiscoveryResult", "benchmark"], ["btnClearKeywordInsightResult", "longtail"]]) {
    $(id).onclick = () => { cleared.add(kind); longtailEdited = false; render(kind); };
  }
  for (const [id, kind] of [["btnRunKeywordOpportunity", "opportunity"], ["btnRunBenchmarkDiscovery", "benchmark"], ["btnExpandKeywords", "longtail"], ["btnRunKeywordInsight", "longtail"], ["btnRetryKeywordAnalysis", "longtail"]]) {
    // Replaces only synthetic fixture onClick handlers, never production listeners.
    $(id).onclick = () => {
      cleared.delete(kind);
      longtailEdited = false;
      snapshots.longtail.totalKeywords = snapshots.longtail.analysis.categories.reduce((count, category) => count + category.keywords.length, 0);
      render(kind);
      notice("演示结果已恢复；未执行采样、扩词或 AI 请求。");
    };
  }
  $("btnViewExpandedKeywords").onclick = () => { expandedWordsVisible = !expandedWordsVisible; renderLongtail(); };
  $("textareaExpandedKeywords").addEventListener("input", () => {
    longtailEdited = true;
    const values = [...new Set($("textareaExpandedKeywords").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    snapshots.longtail.totalKeywords = values.length;
    renderLongtail();
  });
  const frame = () => new Promise(resolve => window.requestAnimationFrame(resolve));
  const ready = (async () => {
    if (!document.documentElement.classList.contains("sv-next")) $("menuBtnInterfaceMode")?.click();
    for (let index = 0; index < 120 && !document.documentElement.classList.contains("sv-next"); index++) await frame();
    if (!document.documentElement.classList.contains("sv-next")) throw new Error("演示结果需要先加载新版界面。");
    if (!document.body.classList.contains("sv-ideas-view")) $("btnToggleKeywordStrategy").click();
    render(requested);
    report?.("创意真实渲染演示已就绪。使用完整结果组件与分享组件；采集、后台、监控与真实外链均不执行。");
  })();
  return {ready, render, snapshot, getSnapshots: () => snapshots};
}
