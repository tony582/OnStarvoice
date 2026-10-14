/** Read-only presentation for Creative reports. No collector, storage or network dependencies. */
const TITLES = {opportunity: "赛道机会", benchmark: "对标账号", longtail: "长尾需求"};
const PLATFORMS = {xiaohongshu: "小红书", xhs: "小红书", douyin: "抖音"};
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
const PAGE = {width: 720, height: 1020, minHeight: 420, padding: 40, top: 164, bottom: 954};
const TYPE = {
  heading: {size: 22, weight: 600, height: 34, before: 20, after: 10},
  subheading: {size: 20, weight: 600, height: 31, before: 16, after: 7},
  body: {size: 18, weight: 400, height: 29, before: 0, after: 10},
  meta: {size: 16, weight: 400, height: 26, before: 0, after: 7},
  source: {size: 16, weight: 400, height: 26, before: 0, after: 7},
};
const previews = new WeakMap();
let previewSequence = 0;
const PREVIEW_CSS = `
.sv-share-overlay{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(20,36,55,.4)}
.sv-share-overlay *{box-sizing:border-box}
.sv-share-dialog{display:flex;flex-direction:column;width:min(100%,800px);max-height:calc(100dvh - 24px);margin:0;overflow:hidden;border:1px solid #cdd7e3;border-radius:12px;background:#fff;color:#202d3c;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.sv-share-header,.sv-share-footer{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;flex-shrink:0;padding:12px 16px;background:#fff}
.sv-share-header{border-bottom:1px solid #dbe3eb}.sv-share-footer{border-top:1px solid #dbe3eb}
.sv-share-title{margin:0;font:inherit;font-size:16px;font-weight:600}
.sv-share-body{min-height:0;padding:14px 16px;overflow:auto;background:#f4f7fa;overscroll-behavior:contain}
.sv-share-status{margin:0 0 10px;color:#596b80;font-size:12px}
.sv-share-canvas-viewport{width:100%;overflow:auto;border:1px solid #dbe3eb;background:#e8edf3;overscroll-behavior:contain}
.sv-share-image{display:block;width:100%;max-width:none;height:auto;margin:0 auto;background:#fff}
.sv-share-navigation,.sv-share-actions,.sv-share-zoom{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.sv-share-zoom{margin-bottom:12px}.sv-share-zoom-label,.sv-share-page-count{font-size:12px;color:#596b80;font-variant-numeric:tabular-nums}
.sv-share-button{display:inline-flex;justify-content:center;align-items:center;min-height:34px;padding:6px 10px;border:1px solid #cdd7e3;border-radius:6px;background:#fff;color:#30435b;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.sv-share-button:hover:not(:disabled){background:#edf4ff;border-color:#91b3ec}.sv-share-button:focus-visible,.sv-share-transcript summary:focus-visible{outline:2px solid #2f6fed;outline-offset:2px}
.sv-share-button:disabled{opacity:.45;cursor:default}.sv-share-primary{border-color:#2f6fed;background:#2f6fed;color:#fff}.sv-share-primary:hover:not(:disabled){background:#245ab6;color:#fff}
.sv-share-transcript{margin-top:14px;border-top:1px solid #dbe3eb;padding-top:10px}.sv-share-transcript summary{cursor:pointer;color:#245ab6}
.sv-share-transcript-text{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;line-height:1.7;color:#30435b}
.sv-share-overlay [hidden]{display:none!important}
@media(max-width:420px){.sv-share-header,.sv-share-footer{padding:10px 12px}.sv-share-body{padding:12px}.sv-share-footer>div{width:100%;justify-content:space-between}.sv-share-actions>.sv-share-button{flex:1}.sv-share-zoom{gap:6px}}
`;
const text = value => value == null ? "" : String(value).trim();
const array = value => Array.isArray(value) ? value : [];
const known = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const metric = value => known(value) ? Number(value).toLocaleString("zh-CN", {maximumFractionDigits: 4}) : "未记录";
const percent = value => known(value) ? `${Math.round(Number(value) * 100)}%` : "未记录";
const label = (value, labels) => labels[text(value)] || text(value) || "未记录";

function recordedTime(value) {
  if (value === null || value === undefined || value === "") return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return text(value);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}（北京时间）`;
}

function add(blocks, role, value) {
  const content = text(value);
  if (content) blocks.push({role, text: content});
}

function field(blocks, name, value, role = "body") {
  if (value !== null && value !== undefined && text(value)) add(blocks, role, `${name}：${text(value)}`);
}

function workBlocks(blocks, work, {prefix = "", sourceKeyword = ""} = {}) {
  const title = text(work?.title) || "标题未记录";
  add(blocks, "body", `${prefix}${title}`);
  const stats = [];
  const author = text(work?.author || work?.authorName);
  if (author) stats.push(author);
  for (const [name, key] of [["点赞", "likes"], ["收藏", "collects"], ["评论", "comments"]]) {
    if (known(work?.[key])) stats.push(`${name} ${metric(work[key])}`);
  }
  if (stats.length) add(blocks, "meta", stats.join(" · "));
  if (sourceKeyword) field(blocks, "来源词", sourceKeyword, "source");
  field(blocks, "原文", work?.url || work?.detailPageUrl || work?.noteUrl, "source");
}

function opportunityBlocks(snapshot, blocks) {
  const rule = snapshot.ruleMetrics || {};
  const sources = [...array(snapshot._listItems), ...array(snapshot._representativeSamples)];
  add(blocks, "heading", "样本范围");
  const sampleCount = known(rule.sampleCount) ? rule.sampleCount : snapshot.sampleCount;
  add(blocks, "body", `搜索样本 ${metric(sampleCount)} 条 · 详情样本 ${metric(rule.detailSampleCount)} 条`);
  const sourceName = {rule_fallback: "规则分析", llm_with_rule_metrics: "规则指标与内容分析"};
  if (snapshot.analysisSource) field(blocks, "分析依据", label(snapshot.analysisSource, sourceName), "meta");
  add(blocks, "meta", "结论仅针对本次搜索样本，不代表平台全量表现。点赞不等同于流量或商业转化。");
  add(blocks, "heading", "观察结论");
  add(blocks, "body", snapshot.distributionSummary || "本次未生成结论。");
  add(blocks, "heading", "样本指标");
  const metricFields = [
    ["热度", label(rule.heatLevel, {high: "高", medium: "中", low: "低"})],
    ["高赞区间", known(rule.highBandStart) && known(rule.highBandEnd) ? `${metric(rule.highBandStart)}–${metric(rule.highBandEnd)}` : "未记录"],
    ["高赞区样本数", metric(rule.highBandCount)],
    ["断层跌幅", percent(rule.cliffDropRatio)],
    ["高赞区平均点赞", metric(rule.highBandAvgLikes)],
    ["中位点赞", metric(rule.medianLikes)],
  ];
  for (const [name, value] of metricFields) field(blocks, name, value, "meta");
  for (const [name, key] of [["最高点赞", "maxLikes"], ["前 5 条平均点赞", "top5AvgLikes"], ["前 10 条平均点赞", "top10AvgLikes"], ["中赞区平均点赞", "midBandAvgLikes"], ["P80 点赞", "p80Likes"], ["P90 点赞", "p90Likes"], ["断层位置（原始索引）", "cliffIndex"]]) {
    if (known(rule[key])) field(blocks, name, metric(rule[key]), "meta");
  }
  const subtopics = array(snapshot.coreWinningSubtopics).map(text).filter(Boolean);
  if (subtopics.length) {
    add(blocks, "heading", "相关细分词");
    add(blocks, "body", subtopics.join("、"));
  }
  const directions = array(snapshot.hotTopicDirections);
  if (directions.length) add(blocks, "heading", "内容方向");
  const bands = {high: "高赞区", mid: "中赞区", low: "低赞区", high_mid: "高赞区与中赞区", mid_low: "中赞区与低赞区", all: "各点赞区间"};
  directions.forEach((value, index) => {
    const direction = value && typeof value === "object" ? value : {};
    add(blocks, "subheading", `${index + 1}. ${text(direction?.name) || "方向未命名"}`);
    const stats = [];
    if (known(direction.sampleCount)) stats.push(`${metric(direction.sampleCount)} 篇`);
    if (known(direction.shareRatio)) stats.push(`样本占比 ${percent(direction.shareRatio)}`);
    if (known(direction.avgLikes)) stats.push(`平均点赞 ${metric(direction.avgLikes)}`);
    if (stats.length) add(blocks, "meta", stats.join(" · "));
    if (direction.bandPresence) field(blocks, "分布区间", label(direction.bandPresence, bands), "meta");
    field(blocks, "用户关注", direction.userIntent);
    field(blocks, "内容观察", direction.whyItWorks);
    if (direction.organicViability) field(blocks, "自然流可行性", label(direction.organicViability, {high: "高", medium: "中", low: "低"}), "meta");
    field(blocks, "判断说明", direction.organicNote);
    const titles = array(direction.representativeTitles).map(text).filter(Boolean);
    if (titles.length) add(blocks, "meta", "代表内容");
    titles.forEach(title => {
      const matches = sources.filter(item => text(item?.title) === title);
      const match = matches.find(item => item?.url || item?.detailPageUrl || item?.noteUrl) || matches[0];
      workBlocks(blocks, match ? {...match, title} : {title});
    });
  });
  const angles = array(snapshot.recommendedAngles);
  if (angles.length) add(blocks, "heading", "可尝试的选题");
  angles.forEach((value, index) => {
    const angle = value && typeof value === "object" ? value : {};
    add(blocks, "subheading", `${index + 1}. ${text(angle?.title) || "选题未命名"}`);
    field(blocks, "回应的问题", angle.audiencePainPoint);
    field(blocks, "内容形式", angle.formatSuggestion);
    field(blocks, "执行建议", angle.executionHint);
  });
}

function benchmarkBlocks(snapshot, blocks) {
  const candidates = array(snapshot.candidates);
  add(blocks, "heading", "样本范围");
  const count = known(snapshot.candidateCount) ? snapshot.candidateCount : candidates.length;
  add(blocks, "body", `搜索样本 ${metric(snapshot.sampleCount)} 条 · 候选账号 ${metric(count)} 个`);
  if (known(snapshot.minOccurrence)) field(blocks, "入围条件", `本次样本中出现至少 ${metric(snapshot.minOccurrence)} 次`, "meta");
  if (candidates.length !== Number(count)) add(blocks, "meta", `当前结果包含 ${candidates.length} 个账号的详细信息。`);
  add(blocks, "meta", "排名沿用本次分析结果。搜索样本不代表账号整体表现，需结合主页和原文复核。");
  if (snapshot.aiStatus && snapshot.aiStatus !== "done") {
    field(blocks, "分析状态", label(snapshot.aiStatus, {not_run: "规则结果，尚未完成内容分析", empty: "未返回内容分析结果", error: "内容分析未完成"}), "meta");
  }
  if (snapshot.aiError) field(blocks, "分析说明", snapshot.aiError, "meta");
  add(blocks, "heading", "候选账号");
  if (!candidates.length) add(blocks, "body", "本次没有符合条件的候选账号。");
  candidates.forEach((value, index) => {
    const candidate = value && typeof value === "object" ? value : {};
    const profile = candidate.profile || {};
    const analysis = candidate.analysis || {};
    add(blocks, "subheading", `${index + 1}. ${text(profile.bloggerName || candidate.authorName) || "账号名称未记录"}`);
    if (analysis.growthPotential) field(blocks, "当前判断", label(analysis.growthPotential, {high: "优先对标", medium: "可观察", low: "需复核"}), "meta");
    field(blocks, "观察结论", analysis.recommendationReason);
    field(blocks, "判断依据", analysis.focusAssessment);
    if (array(analysis.tags).length) field(blocks, "相关特征", analysis.tags.map(text).filter(Boolean).join("、"), "meta");
    const metrics = [["样本出现次数", candidate.occurrenceCount], ["最高点赞", candidate.maxLikes], ["平均点赞", candidate.averageLikes], ["平均收藏", candidate.averageCollects], ["平均评论", candidate.averageComments], ["平均互动", candidate.avgEngagement], ["样本总互动", candidate.totalEngagement]];
    for (const [name, value] of metrics) if (known(value)) field(blocks, name, metric(value), "meta");
    // The existing profile normalizer substitutes 0 for absent metrics. Only a completed
    // metrics read or an explicit Known flag can confirm a genuine zero in that payload.
    for (const [name, key, knownKey] of [["粉丝", "followersCount", "followersCountKnown"], ["主页累计赞藏", "likedAndCollectedCount", "likedAndCollectedCountKnown"]]) {
      if (known(profile[key])) field(blocks, name, Number(profile[key]) === 0 && profile.captureStatus !== "done" && profile[knownKey] !== true ? "未确认" : metric(profile[key]), "meta");
    }
    field(blocks, "主页简介", profile.description);
    field(blocks, "主页", candidate.authorProfileUrl || profile.bloggerUrl, "source");
    if (candidate.profileCaptureStatus && candidate.profileCaptureStatus !== "success") field(blocks, "主页资料", label(candidate.profileCaptureStatus, {pending: "尚未补采", missing_url: "缺少主页链接", error: "补采未完成", failed: "补采未完成", done: "已补采"}), "meta");
    field(blocks, "主页说明", candidate.profileCaptureError, "meta");
    const works = array(candidate.topItems);
    if (works.length) add(blocks, "meta", "代表作品");
    works.forEach(work => workBlocks(blocks, work));
  });
}

function longtailBlocks(snapshot, blocks) {
  const categories = array(snapshot.categories);
  add(blocks, "heading", "分析范围");
  add(blocks, "body", `扩展词 ${metric(snapshot.totalKeywords)} 个 · 需求方向 ${categories.length} 个`);
  add(blocks, "meta", "词数反映本次扩词和归类结果，不代表搜索量或真实需求占比。样本仅用于辅助理解。");
  add(blocks, "heading", "需求概览");
  add(blocks, "body", snapshot.summary || "本次未生成需求概览。");
  if (categories.length) add(blocks, "heading", "需求方向");
  categories.forEach((value, index) => {
    const category = value && typeof value === "object" ? value : {};
    add(blocks, "subheading", `${index + 1}. ${text(category?.name) || "方向未命名"}`);
    const keywords = array(category.keywords).map(text).filter(Boolean);
    add(blocks, "meta", `${keywords.length} 个关联词`);
    field(blocks, "需求观察", category.insight);
    if (keywords.length) field(blocks, "关联词", keywords.join("、"));
    const samples = array(category.samples);
    if (category.sampleKeyword) field(blocks, "样本来源词", category.sampleKeyword, "source");
    if (samples.length) {
      add(blocks, "meta", "参考样本");
      samples.forEach(sample => workBlocks(blocks, sample));
    } else add(blocks, "meta", "该方向暂无参考样本。");
  });
}

/** The shared model contains every displayed report paragraph; it never mutates the source result. */
export function buildCreativeShareReport(kind, snapshot = {}) {
  if (!Object.hasOwn(TITLES, kind)) throw new TypeError("未知的创意报告类型");
  snapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
  const keyword = text(kind === "longtail" ? snapshot.seedKeyword : snapshot.keyword) || "关键词未记录";
  const platform = text(snapshot.platformLabel) || PLATFORMS[text(snapshot.platform)] || text(snapshot.platform) || "平台未记录";
  const generatedAt = recordedTime(snapshot.generatedAt ?? snapshot.ts);
  const blocks = [];
  ({opportunity: opportunityBlocks, benchmark: benchmarkBlocks, longtail: longtailBlocks})[kind](snapshot, blocks);
  return {kind, title: TITLES[kind], keyword, platform, generatedAt, brand: "StarVoice 星语", blocks};
}

function reportText(report) {
  return [
    `${report.keyword}｜${report.title}`,
    `${report.platform} · 生成时间：${report.generatedAt}`,
    "",
    ...report.blocks.flatMap(block => [block.text, ""]),
    report.brand,
  ].join("\n").trim();
}

export function buildCreativeShareText(kind, snapshot) {
  return reportText(buildCreativeShareReport(kind, snapshot));
}

/** Character-based wrapping handles unbroken CJK and URLs without dropping text. */
function wrapLines(value, maxWidth, measure, style) {
  const lines = [];
  for (const paragraph of String(value).split("\n")) {
    let line = "";
    for (const char of Array.from(paragraph)) {
      const candidate = line + char;
      if (line && measure(candidate, style) > maxWidth) {
        lines.push(line);
        line = char;
      } else line = candidate;
    }
    lines.push(line);
  }
  return lines;
}

/** Pure measurement output: no canvas allocation or page bitmap is needed for pagination. */
export function layoutCreativeShareReport(report, measure) {
  const pages = [[]];
  let y = PAGE.top;
  let metricsSection = false;
  for (let blockIndex = 0; blockIndex < report.blocks.length; blockIndex++) {
    const block = report.blocks[blockIndex];
    if (block.role === "heading") metricsSection = report.kind === "opportunity" && block.text === "样本指标";
    if (metricsSection && block.role === "meta") {
      const cellWidth = (PAGE.width - PAGE.padding * 2 - 24) / 2;
      const cells = [block];
      if (report.blocks[blockIndex + 1]?.role === "meta") cells.push(report.blocks[blockIndex + 1]);
      const wrapped = cells.map(cell => wrapLines(cell.text, cellWidth, measure, TYPE.meta));
      const rowHeight = Math.max(...wrapped.map(lines => lines.length)) * TYPE.meta.height + 14;
      // Report metrics are short scalar values. Keep each pair on one page and use the
      // ordinary line paginator for an unexpectedly long value instead of cropping it.
      if (rowHeight <= PAGE.bottom - PAGE.top) {
        if (y + rowHeight > PAGE.bottom) { pages.push([]); y = PAGE.top; }
        wrapped.forEach((lines, column) => lines.forEach((line, lineIndex) => {
          pages.at(-1).push({text: line, role: "meta", blockIndex: blockIndex + column, lineIndex,
            x: PAGE.padding + column * (cellWidth + 24), y: y + lineIndex * TYPE.meta.height,
            metricRowTop: y, metricRowBottom: y + rowHeight - 7, metricColumn: column, ...TYPE.meta});
        }));
        y += rowHeight;
        blockIndex += cells.length - 1;
        continue;
      }
    }
    const style = TYPE[block.role] || TYPE.body;
    const lines = wrapLines(block.text, PAGE.width - PAGE.padding * 2, measure, style);
    // Avoid a heading alone at the page foot; the next block still keeps all of its lines.
    const reserve = (block.role === "heading" || block.role === "subheading") ? 50 : 0;
    if (y + style.before + style.height + reserve > PAGE.bottom && pages.at(-1).length) {
      pages.push([]);
      y = PAGE.top;
    }
    y += style.before;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (y + style.height > PAGE.bottom) {
        pages.push([]);
        y = PAGE.top;
      }
      pages.at(-1).push({text: lines[lineIndex], role: block.role, blockIndex, lineIndex, x: PAGE.padding, y, ...style});
      y += style.height;
    }
    y += style.after;
  }
  const pageHeights = pages.map((lines, index) => {
    if (index < pages.length - 1) return PAGE.height;
    const contentBottom = Math.max(PAGE.top, ...lines.map(line => Math.max(line.y + line.height, line.metricRowBottom || 0)));
    return Math.min(PAGE.height, Math.max(PAGE.minHeight, Math.ceil(contentBottom + 68)));
  });
  return {width: PAGE.width, height: PAGE.height, pageHeights, pages};
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("未生成图片")), "image/png");
    } catch (error) { reject(error); }
  });
}

function drawPage(canvas, context, report, layout, pageIndex, scale) {
  const height = layout.pageHeights[pageIndex];
  canvas.width = layout.width * scale;
  canvas.height = height * scale;
  context.scale(scale, scale);
  context.textBaseline = "top";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, layout.width, height);
  context.fillStyle = "#2f6fed";
  context.fillRect(0, 0, layout.width, 5);
  context.font = `600 16px ${FONT}`;
  context.fillText(`${report.brand} / ${report.title}`, PAGE.padding, 28);
  context.fillStyle = "#1d3854";
  context.font = `600 26px ${FONT}`;
  // The full keyword appears in the body model below when it needs more than one header line.
  const headerStyle = {size: 26, weight: 600};
  const keywordLines = wrapLines(report.keyword, PAGE.width - PAGE.padding * 2, (line, style) => {
    context.font = `${style.weight} ${style.size}px ${FONT}`;
    return context.measureText(line).width;
  }, headerStyle);
  const fitHeader = value => {
    if (context.measureText(value).width <= PAGE.width - PAGE.padding * 2) return value;
    const chars = Array.from(value);
    while (chars.length && context.measureText(`${chars.join("")}…`).width > PAGE.width - PAGE.padding * 2) chars.pop();
    return `${chars.join("")}…`;
  };
  const header = keywordLines.length > 1 ? fitHeader(`${keywordLines[0]}…`) : keywordLines[0];
  context.fillText(header, PAGE.padding, 59);
  context.fillStyle = "#66758a";
  context.font = `400 16px ${FONT}`;
  const meta = `${report.platform} · ${report.generatedAt}`;
  context.fillText(fitHeader(meta), PAGE.padding, 103);
  context.strokeStyle = "#dbe3eb";
  context.beginPath(); context.moveTo(PAGE.padding, 136); context.lineTo(PAGE.width - PAGE.padding, 136); context.stroke();
  for (const line of layout.pages[pageIndex]) {
    if (line.role === "heading" && line.lineIndex === 0) {
      context.strokeStyle = "#dbe3eb";
      context.beginPath(); context.moveTo(PAGE.padding, line.y - 7); context.lineTo(PAGE.width - PAGE.padding, line.y - 7); context.stroke();
    }
    if (line.metricColumn === 0 && line.lineIndex === 0) {
      context.strokeStyle = "#e6ebf0";
      context.beginPath(); context.moveTo(PAGE.padding, line.metricRowBottom); context.lineTo(PAGE.width - PAGE.padding, line.metricRowBottom); context.stroke();
    }
    context.font = `${line.weight} ${line.size}px ${FONT}`;
    context.fillStyle = line.role === "heading" ? "#245ab6" : line.role === "meta" || line.role === "source" ? "#596b80" : "#202d3c";
    context.fillText(line.text, line.x, line.y);
  }
  context.strokeStyle = "#dbe3eb";
  context.beginPath(); context.moveTo(PAGE.padding, height - 47); context.lineTo(PAGE.width - PAGE.padding, height - 47); context.stroke();
  context.fillStyle = "#66758a";
  context.font = `400 14px ${FONT}`;
  context.fillText("本次样本分析 · 请结合原文判断", PAGE.padding, height - 31);
  context.textAlign = "right";
  context.fillText(`${pageIndex + 1} / ${layout.pages.length}`, PAGE.width - PAGE.padding, height - 31);
  context.textAlign = "left";
}

/** Opens a local, on-demand preview. Clipboard and downloads require explicit button clicks. */
export function openCreativeSharePreview(kind, snapshot, {document, window, onMessage = () => {}} = {}) {
  if (!document || !window) throw new TypeError("图片预览缺少页面环境");
  previews.get(document)?.close();
  const report = buildCreativeShareReport(kind, snapshot);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) { onMessage("图片生成失败，请复制文字后重试。", "error"); return null; }
  // Normal metadata appears once, in the page header. Only an overlong field that
  // needs a shortened running header is repeated in full in the paginated body.
  const overflowMetadata = [];
  context.font = `600 26px ${FONT}`;
  if (context.measureText(report.keyword).width > PAGE.width - PAGE.padding * 2) overflowMetadata.push({role: "meta", text: `关键词：${report.keyword}`});
  context.font = `400 16px ${FONT}`;
  if (context.measureText(`${report.platform} · ${report.generatedAt}`).width > PAGE.width - PAGE.padding * 2) overflowMetadata.push({role: "meta", text: `平台：${report.platform} · 生成时间：${report.generatedAt}`});
  const layoutReport = {...report, blocks: [...overflowMetadata, ...report.blocks]};
  const layout = layoutCreativeShareReport(layoutReport, (line, style) => {
    context.font = `${style.weight} ${style.size}px ${FONT}`;
    return context.measureText(line).width;
  });
  const previousFocus = document.activeElement;
  const make = (tag, className, content) => {
    const element = document.createElement(tag);
    element.className = className;
    if (content) element.textContent = content;
    return element;
  };
  const overlay = make("div", "sv-share-overlay");
  overlay.append(make("style", "", PREVIEW_CSS));
  const dialog = make("section", "sv-share-dialog");
  dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
  const header = make("header", "sv-share-header");
  const title = make("h2", "sv-share-title", "分享图片");
  title.id = `sv-share-title-${++previewSequence}`;
  dialog.setAttribute("aria-labelledby", title.id);
  const button = (content, className = "") => {
    const element = make("button", `sv-share-button ${className}`.trim(), content);
    element.type = "button";
    return element;
  };
  const closeButton = button("关闭", "sv-share-close");
  const body = make("div", "sv-share-body");
  const zoomTools = make("div", "sv-share-zoom");
  const zoomOut = button("缩小"); const zoomIn = button("放大"); const zoomReset = button("适合宽度");
  const zoomLabel = make("span", "sv-share-zoom-label", "100%"); zoomLabel.setAttribute("aria-live", "polite");
  zoomTools.append(zoomOut, zoomLabel, zoomIn, zoomReset);
  const viewport = make("div", "sv-share-canvas-viewport");
  const image = make("img", "sv-share-image");
  viewport.append(image);
  const status = make("p", "sv-share-status", "正在生成预览…");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const transcript = make("details", "sv-share-transcript");
  transcript.append(make("summary", "", "查看完整文字"), make("pre", "sv-share-transcript-text", reportText(report)));
  const footer = make("footer", "sv-share-footer");
  const navigation = make("div", "sv-share-navigation");
  const previous = button("上一页"); const next = button("下一页");
  const pageLabel = make("span", "sv-share-page-count"); pageLabel.setAttribute("aria-live", "polite");
  const actions = make("div", "sv-share-actions");
  const copy = button("复制本页图片"); const download = button("下载本页", "sv-share-primary");
  const retry = button("重新生成"); retry.hidden = true;
  header.append(title, closeButton); body.append(status, zoomTools, viewport, retry, transcript);
  navigation.append(previous, pageLabel, next); actions.append(copy, download);
  footer.append(navigation, actions); dialog.append(header, body, footer); overlay.append(dialog);
  document.body.append(overlay);
  let index = 0, closed = false, generation = 0, blob = null, blobUrl = "", busy = false;
  let zoom = 1;
  const setZoom = value => {
    zoom = Math.min(3, Math.max(.5, value));
    image.style.width = `${Math.round(zoom * 100)}%`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    zoomOut.disabled = zoom <= .5; zoomIn.disabled = zoom >= 3;
  };
  const scale = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
  const syncButtons = () => {
    previous.disabled = busy || index === 0;
    next.disabled = busy || index >= layout.pages.length - 1;
    copy.disabled = download.disabled = busy || !blob;
    pageLabel.textContent = `${index + 1} / ${layout.pages.length}`;
    body.setAttribute("aria-busy", String(busy));
  };
  const render = async () => {
    const run = ++generation;
    busy = true; blob = null; retry.hidden = true; image.hidden = true;
    status.textContent = `正在生成第 ${index + 1} 页…`; syncButtons();
    try {
      drawPage(canvas, context, report, layout, index, scale);
      const result = await canvasBlob(canvas);
      if (closed || run !== generation) return;
      if (blobUrl) window.URL.revokeObjectURL(blobUrl);
      blob = result;
      blobUrl = window.URL.createObjectURL(result);
      image.src = blobUrl;
      image.hidden = false;
      image.alt = `${report.keyword} · ${report.title} · 第 ${index + 1} 页，共 ${layout.pages.length} 页`;
      status.textContent = layout.pages.length > 1 ? `共 ${layout.pages.length} 页；复制或下载仅保存当前页。` : "复制或下载保存这张图片。";
    } catch {
      if (!closed && run === generation) {
        status.textContent = "图片生成失败。可以重新生成，或查看完整文字。";
        retry.hidden = false;
        onMessage("图片生成失败，请重试或复制文字。", "error");
      }
    } finally {
      if (!closed && run === generation) { busy = false; syncButtons(); }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true; generation++;
    window.removeEventListener("keydown", onKeyDown, true);
    if (blobUrl) window.URL.revokeObjectURL(blobUrl);
    canvas.width = canvas.height = 0;
    blob = null; overlay.remove();
    if (previews.get(document)?.close === close) previews.delete(document);
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
  };
  const onKeyDown = event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button, summary")].filter(element => !element.disabled && !element.hidden);
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
  previous.addEventListener("click", () => { if (!busy && index > 0) { index--; void render(); } });
  next.addEventListener("click", () => { if (!busy && index < layout.pages.length - 1) { index++; void render(); } });
  retry.addEventListener("click", () => { if (!busy) void render(); });
  zoomOut.addEventListener("click", () => setZoom(zoom - .25));
  zoomIn.addEventListener("click", () => setZoom(zoom + .25));
  zoomReset.addEventListener("click", () => setZoom(1));
  image.addEventListener("dblclick", () => setZoom(1));
  copy.addEventListener("click", async () => {
    if (!blob || busy) return;
    if (typeof window.navigator?.clipboard?.write !== "function" || typeof window.ClipboardItem !== "function") {
      onMessage("当前环境不支持复制图片，请下载本页。", "warning"); return;
    }
    const copiedPage = index + 1;
    try {
      await window.navigator.clipboard.write([new window.ClipboardItem({"image/png": blob})]);
      if (!closed) onMessage(`第 ${copiedPage} 页图片已复制`, "success");
    } catch { if (!closed) onMessage("复制图片失败，请下载本页。", "error"); }
  });
  download.addEventListener("click", () => {
    if (!blobUrl || busy) return;
    const anchor = document.createElement("a");
    const keyword = report.keyword.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 64);
    anchor.href = blobUrl;
    anchor.download = `星语-${report.title}-${keyword}-${index + 1}of${layout.pages.length}.png`;
    document.body.append(anchor); anchor.click(); anchor.remove();
  });
  // Window capture runs before the existing document-capture Escape listener.
  // Stopping here closes only this dialog, without also leaving the Creative page.
  window.addEventListener("keydown", onKeyDown, true);
  const controller = {close, report, pageCount: layout.pages.length, ready: null};
  previews.set(document, controller);
  closeButton.focus();
  controller.ready = render();
  return controller;
}
