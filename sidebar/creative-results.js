/** Read-only result presentation. No collection, analysis, storage or timers. */
const list = value => Array.isArray(value) ? value : [];
const records = value => list(value).filter(item => item && typeof item === "object");
export const escapeCreativeText = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const e = escapeCreativeText;
const text = value => String(value ?? "").trim();
const known = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const metric = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? "未获取" : Number(value).toLocaleString("zh-CN", {maximumFractionDigits: 1});
const safeURL = value => { try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } };
const link = (title, url) => safeURL(url) ? `<a href="${e(safeURL(url))}" target="_blank" rel="noopener noreferrer">${e(title)}</a>` : `<span>${e(title)}</span>`;
const field = (label, value) => text(value) ? `<p class="cr-field"><span>${e(label)}</span>${e(value)}</p>` : "";
const plainTags = values => list(values).filter(Boolean).join(" · ");

function narrative(value, label = "查看完整分析") {
  const full = text(value);
  if (!full) return "";
  const match = full.match(/^([\s\S]*?[。！？])([\s\S]+)$/u);
  if (full.length <= 120 || !match) return `<p class="cr-copy">${e(full)}</p>`;
  return `<p class="cr-copy">${e(match[1])}</p><details class="cr-disclosure"><summary>${e(label)}</summary><p class="cr-copy">${e(match[2].trim())}</p></details>`;
}

function shareActions(kind) {
  const actions = {opportunity:["copy-opportunity","share-opportunity-as-image"],benchmark:["copy-benchmark","share-benchmark-as-image"],longtail:["copy-insight","share-as-image"]}[kind];
  return `<div class="cr-share-actions" aria-label="分享结果"><button type="button" data-action="${actions[0]}">复制文字</button><button type="button" data-action="${actions[1]}">导出图片</button></div>`;
}

function header(keyword, eyebrow, metadata, kind) {
  return `<header class="cr-report-head"><div class="cr-report-title"><span class="cr-eyebrow">${e(eyebrow)}</span><h2>${e(keyword || "分析结果")}</h2></div>${shareActions(kind)}<p class="cr-meta cr-report-scope">${e(metadata)}</p></header>`;
}

function section(title, body, hint = "") {
  return `<section class="cr-section"><div class="cr-section-heading"><h3>${e(title)}</h3>${hint ? `<span class="cr-meta">${e(hint)}</span>` : ""}</div>${body}</section>`;
}

export function renderCreativeOpportunity(result, {resolveTitleUrl = () => ""} = {}) {
  if (!result) return "";
  const rules = result.ruleMetrics || {};
  const count = rules.sampleCount ?? result.sampleCount ?? (result._listItems ? list(result._listItems).length : null);
  const heat = {high:"高",medium:"中",low:"低"}[rules.heatLevel] || "未识别";
  const measures = [
    ["样本热度", heat, "原分析对样本高赞区的热度判断，不代表全平台表现。"],
    ["高赞区间", Number(rules.highBandEnd) > 0 ? `第 ${rules.highBandStart}–${rules.highBandEnd} 名` : "未识别", "在样本点赞排序中，表现明显较高的排名区间。"],
    ["点赞落差", known(rules.cliffDropRatio) ? `${Math.round(rules.cliffDropRatio * 100)}%` : "未获取", "原分析识别的相邻分层点赞跌幅。"],
    ["高赞区均赞", metric(rules.highBandAvgLikes), "高赞区间内样本的平均点赞数。"],
    ["样本中位赞", metric(rules.medianLikes), "全部样本按点赞排序后处于中间位置的点赞数。"],
  ];
  const stats = `<dl class="cr-metrics">${measures.map(([label,value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl><details class="cr-disclosure cr-method"><summary>指标说明与样本边界</summary><dl>${measures.map(([label,,description]) => `<div><dt>${e(label)}</dt><dd>${e(description)}</dd></div>`).join("")}</dl><p>结果只描述本次搜索样本，不等于全平台流量或收益预测。</p></details>`;
  const bands = {high:"高赞区",mid:"中赞区",low:"低赞区",high_mid:"高赞与中赞区",mid_low:"中赞与低赞区",all:"各点赞区间"};
  const viability = {high:"较高",medium:"中等",low:"较低"};
  const topics = records(result.hotTopicDirections).map(direction => {
    const titles = list(direction.representativeTitles);
    return `<article class="cr-row"><h4>${e(direction.name || "未命名方向")}</h4><p class="cr-meta">${metric(direction.sampleCount)} 篇 · 样本占比 ${known(direction.shareRatio) ? `${Math.round(Number(direction.shareRatio) * 100)}%` : "未获取"}${direction.avgLikes != null ? ` · 均赞 ${metric(direction.avgLikes)}` : ""}</p>${field("用户关注", direction.userIntent)}${narrative(direction.whyItWorks)}<details class="cr-disclosure"><summary>查看判断依据${titles.length ? `与 ${titles.length} 个代表标题` : ""}</summary>${field("分布区间", bands[direction.bandPresence])}${field("自然流判断", viability[direction.organicViability])}${field("说明", direction.organicNote)}${titles.length ? `<ul class="cr-source-list">${titles.map(title => `<li>${link(title, resolveTitleUrl(result,title))}</li>`).join("")}</ul>` : ""}</details></article>`;
  }).join("");
  const subtopics = list(result.coreWinningSubtopics);
  const angles = records(result.recommendedAngles).map(angle => `<article class="cr-row"><h4>${e(angle.title || "未命名选题")}</h4>${field("要回应的问题", angle.audiencePainPoint)}${field("内容形式", angle.formatSuggestion)}${field("怎么做", angle.executionHint)}</article>`).join("");
  return `<div class="cr-report">${header(result.keyword,"赛道机会",`${known(count) ? `${metric(count)} 条搜索样本` : "样本数量未记录"} · 仅供本次选题参考`,"opportunity")}${section("样本表现",`${narrative(result.distributionSummary)}${stats}`)}${section("内容方向",topics || `<p class="cr-empty">样本不足，暂未形成清晰的内容方向。</p>`,`${records(result.hotTopicDirections).length} 个方向`)}${subtopics.length ? section("相关细分词",`<p class="cr-wordline">${subtopics.map(e).join("、")}</p>`) : ""}${section("可尝试的选题",angles || `<p class="cr-empty">暂无选题建议，可结合长尾需求继续查看。</p>`)}</div>`;
}

export function renderCreativeBenchmark(result, helpers = {}) {
  if (!result) return "";
  const candidates = records(result.candidates);
  const rows = candidates.map(candidate => {
    const profile = candidate.profile || {};
    const analysis = candidate.analysis || helpers.fallbackAnalysis?.(candidate) || {};
    const name = profile.bloggerName || candidate.authorName || "未获取账号名称";
    const reason = analysis.recommendationReason || helpers.ruleReason?.(candidate) || "";
    const angle = text(helpers.decisionAngle?.(candidate, analysis) || analysis.decisionAngle).replace(/^判断角度[：:]\s*/, "");
    const works = list(helpers.works ? helpers.works(candidate, 3) : list(candidate.topItems).slice(0,3));
    const evidence = list(helpers.evidence?.(candidate)).map(value => {
      if (/最高赞约为粉丝[数量]/.test(value) && Number(profile.followersCount) > 0 && known(candidate.maxLikes)) {
        return `最高赞 / 粉丝量：${(Number(candidate.maxLikes) / Number(profile.followersCount)).toLocaleString("zh-CN", {maximumFractionDigits: 2})} 倍（仅作样本参考）`;
      }
      return value;
    });
    const profileReady = profile.captureStatus === "done" || candidate.profileCaptureStatus === "done";
    const profileMetric = value => Number(value) > 0 || (profileReady && known(value)) ? metric(value) : "未获取";
    const url = safeURL(candidate.authorProfileUrl);
    const potential = {high:"优先查看",medium:"可观察",low:"谨慎参考"}[analysis.growthPotential];
    return `<article class="cr-account"><h4>${e(name)}</h4><p class="cr-meta">样本出现 ${metric(candidate.occurrenceCount)} 次 · 最高赞 ${metric(candidate.maxLikes)} · 均赞 ${metric(candidate.averageLikes)}</p>${profile.followersCount != null ? `<p class="cr-meta">粉丝 ${profileMetric(profile.followersCount)}${profile.likedAndCollectedCount != null ? ` · 主页赞藏 ${profileMetric(profile.likedAndCollectedCount)}` : ""}</p>` : `<p class="cr-meta">主页数据未获取，需打开主页核实</p>`}${narrative(reason)}<div class="cr-account-actions">${url ? `<button type="button" data-action="open-benchmark-profile" data-url="${e(url)}">打开主页</button><button type="button" data-action="monitor-benchmark-account" data-url="${e(url)}" data-name="${e(name)}">纳入监控</button>` : `<span class="cr-meta">暂无可用主页链接</span>`}</div><details class="cr-disclosure"><summary>查看判断依据${works.length ? "与代表作品" : ""}</summary>${field("判断角度", angle)}${field("关注建议", potential)}${field("参考标签", plainTags(analysis.tags))}${narrative(analysis.focusAssessment)}${evidence.length ? `<ul class="cr-evidence-list">${evidence.map(value=>`<li>${e(value)}</li>`).join("")}</ul>` : ""}${works.length ? `<ul class="cr-source-list">${works.map(work=>`<li>${link(work.title || "查看原作品",work.url)}<span class="cr-meta">点赞 ${metric(work.likes)}${work.collects != null ? ` · 收藏 ${metric(work.collects)}` : ""}</span></li>`).join("")}</ul>` : ""}</details></article>`;
  }).join("");
  return `<div class="cr-report">${header(result.keyword,"对标账号",`${metric(result.sampleCount)} 条搜索样本 · ${metric(result.candidateCount ?? candidates.length)} 个候选账号`,"benchmark")}<p class="cr-boundary-note">同一账号在样本中出现至少 ${metric(result.minOccurrence ?? 2)} 次。候选不等于推荐，建议先看主页和代表作品。</p>${section("候选账号",rows || `<p class="cr-empty">本次没有符合条件的候选账号。</p>`)}</div>`;
}

export function renderCreativeInsightSummary({seedKeyword,totalKeywords,analysis} = {}) {
  if (!analysis) return "";
  return `<div class="cr-report cr-longtail-summary">${header(seedKeyword,"长尾需求",`${metric(totalKeywords)} 个扩展词 · ${records(analysis.categories).length} 个需求方向`,"longtail")}${narrative(analysis.summary)}<p class="cr-boundary-note">展开方向查看关键词，点击词语可复制；样本用于核对，不代表全量用户需求。</p></div>`;
}

export function renderCreativeInsightCategories({analysis,totalKeywords,expandedIds = new Set(),sampleStatusByCategoryId = {},sampleResultsByCategoryId = {}} = {}) {
  return records(analysis?.categories).map(category => {
    const id = text(category.id), words = list(category.keywords), expanded = expandedIds.has(id);
    const status = sampleStatusByCategoryId?.[id], result = sampleResultsByCategoryId?.[id] || {};
    const samples = records(result.samples);
    let evidence = `<p class="cr-meta">暂无样本</p>`;
    if (status === "loading") evidence = `<p class="cr-meta" role="status">正在读取样本…</p>`;
    else if (status === "error") evidence = `<p class="cr-error">${e(result.errorMessage || "样本读取失败，可重试分析后查看。")}</p>`;
    else if (samples.length) evidence = `<details class="cr-disclosure"><summary>查看 ${samples.length} 条样本</summary>${field("来源词", result.usedKeyword)}<ul class="cr-source-list">${samples.map(sample=>`<li>${link(sample.title || "查看原作品（无标题）",sample.url)}<span class="cr-meta">${e(sample.author || "作者未获取")} · 点赞 ${metric(sample.likes)}</span></li>`).join("")}</ul></details>`;
    return `<article class="cr-demand"><div class="cr-demand-head"><div><h3>${e(category.name || "未命名方向")}</h3><p class="cr-meta">${words.length} 个词${Number(totalKeywords) > 0 ? ` · 占扩展词 ${Math.round(words.length / Number(totalKeywords) * 100)}%` : ""}</p></div><button type="button" class="cr-text-button" data-action="toggle-expand-category" data-category-id="${e(id)}" aria-expanded="${expanded}">${expanded ? "收起词语" : "查看词语"}</button></div>${narrative(category.insight)}${expanded ? `<div class="cr-keywords" aria-label="点击关键词复制">${words.map(word=>`<button type="button" data-action="toggle-keyword" data-keyword="${e(word)}" title="复制关键词">${e(word)}</button>`).join("")}</div>` : ""}${evidence}</article>`;
  }).join("");
}
