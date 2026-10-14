import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import * as views from "../sidebar/creative-results.js";
import {buildCreativeShareText} from "../sidebar/creative-share.js";

const engine = await readFile(new URL("../sidebar/sidebar-logic.js", import.meta.url), "utf8");
// Read the actual named declarations only. Never import/evaluate the sidebar module,
// its initialization, runtime subscriptions, or any collection implementation.
function declaration(name) {
  const start = engine.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `missing real function ${name}`);
  const end = engine.indexOf("\n}\n", start);
  assert.ok(end > start, `missing top-level function boundary ${name}`);
  const source = engine.slice(start, end + 2);
  assert.doesNotMatch(source, /^import\s|initSidebar\(|captureAndSync\(|lightSampleByKeywords\(/m);
  return source;
}

const declarations = [
  "isCreativePresentation", "getCreativeLongtailSnapshot", "creativeShareSnapshot", "copyCreativeResult", "showCreativeResultImage",
  "renderBenchmarkDiscoveryResult", "renderKeywordOpportunityResult", "renderInsightSummaryCard", "renderInsightCategories",
  "handleCopyBenchmarkDiscovery", "handleCopyKeywordOpportunity", "handleCopyInsight",
  "handleShareBenchmarkDiscoveryAsImage", "handleShareKeywordOpportunityAsImage", "handleShareAsImage",
  "escapeHtml", "formatOpportunityMetric", "buildBenchmarkDiscoveryRuleReason", "buildBenchmarkDiscoveryFocusAssessment",
  "buildBenchmarkDiscoveryDecisionAngle", "buildBenchmarkDiscoveryFallbackAnalysis", "buildBenchmarkDiscoveryCandidateEvidence",
  "buildBenchmarkDiscoveryRepresentativeWorks", "renderKeywordStrategyLoadingState", "normalizeKeywordOpportunityTitleForMatch",
  "buildKeywordOpportunityTitleCandidates", "resolveKeywordOpportunityTitleUrl", "renderInsightSampleBlock", "getSelectedRecommendedKeywords",
].map(declaration).join("\n\n");

function fixture({next = true, rejectClipboard = false} = {}) {
  const calls = {views: [], copies: [], previews: [], legacy: [], messages: [], timers: [], events: new Map()};
  const mode = {next};
  const analysis = {summary: "需求概览", categories: [{id: "a", name: "续费", insight: "需要确认价格", keywords: ["续费价格", "免费功能"]}]};
  const draft = {analysisResult: analysis, selectedKeywords: [], sampleStatusByCategoryId: {a: "done"}, sampleResultsByCategoryId: {a: {usedKeyword: "续费价格", samples: [{title: "是否还需要续费", author: "车主甲", likes: 0, url: "https://example.test/longtail"}]}}};
  const opportunity = {keyword: "安吉星", platform: "xiaohongshu", generatedAt: "2026-10-14T01:00:00Z", distributionSummary: "搜索样本结论。", ruleMetrics: {sampleCount: 80, heatLevel: "high", highBandStart: 1, highBandEnd: 11, highBandAvgLikes: 4280, cliffDropRatio: .84, medianLikes: 8}, hotTopicDirections: [{name: "救援经历", sampleCount: 10, shareRatio: .125, userIntent: "关心响应时间", representativeTitles: ["救援记录"]}], coreWinningSubtopics: ["紧急救援"], recommendedAngles: [{title: "救援经过", executionHint: "附时间线"}], _listItems: [{title: "救援记录", url: "https://example.test/note"}], _representativeSamples: [{title: "详情样本", url: "https://example.test/detail"}]};
  const candidate = {key: "author", authorName: "作者甲", authorProfileUrl: "https://example.test/author", occurrenceCount: 3, maxLikes: 100, averageLikes: 60, performanceDensity: "stable", profile: {bloggerName: "作者主页名", followersCount: 500, likedAndCollectedCount: 0, captureStatus: "done"}, topItems: [{title: "代表作品", url: "https://example.test/work", likes: 0, collects: 0}]};
  const benchmark = {keyword: "安吉星", platform: "xiaohongshu", sampleCount: 20, candidateCount: 1, minOccurrence: 2, candidates: [candidate]};
  const document = {documentElement: {classList: {contains: name => name === "sv-next" && mode.next}}};
  const window = {addEventListener: (event, callback) => calls.events.set(event, callback)};
  const context = vm.createContext({
    document, window, console,
    keywordBenchmarkAnalysisStatus: "idle", keywordBenchmarkLoadingTitle: "", keywordBenchmarkLoadingMeta: "",
    keywordBenchmarkResult: benchmark, keywordOpportunityResult: opportunity,
    expandedKeywordsBuffer: ["续费价格", "免费功能"], expandedKeywordInsightCategoryIds: new Set(["a"]),
    getKeywordInsightState: () => draft, getBatchDraftForPlatform: () => ({seedKeyword: "安吉星"}),
    getCurrentBatchDraftPlatform: () => "douyin",
    getPlatformCopy: platform => ({label: {xiaohongshu: "小红书", douyin: "抖音"}[platform] || "未识别"}),
    showMessage: (...args) => calls.messages.push(args),
    navigator: {clipboard: {async writeText(value) { if (rejectClipboard) throw new Error("fixture clipboard denial"); calls.copies.push(value); }}},
    setTimeout: (callback, delay) => { calls.timers.push(delay); callback(); },
    buildCreativeShareText,
    openCreativeSharePreview: (kind, snapshot, options) => { calls.previews.push({kind, snapshot, options}); return {kind, pageCount: 1}; },
    buildBenchmarkDiscoveryShareText: () => { calls.legacy.push("benchmark-text"); return "legacy benchmark text"; },
    buildKeywordOpportunityShareText: () => { calls.legacy.push("opportunity-text"); return "legacy opportunity text"; },
    buildBenchmarkDiscoveryShareData: () => { calls.legacy.push("benchmark-data"); return {classic: "benchmark"}; },
    buildKeywordOpportunityShareData: () => { calls.legacy.push("opportunity-data"); return {classic: "opportunity"}; },
    buildInsightShareData: () => { calls.legacy.push("longtail-data"); return {classic: "longtail"}; },
    renderBenchmarkDiscoveryCardToImage: data => calls.legacy.push(data.classic + "-image"),
    renderKeywordOpportunityCardToImage: data => calls.legacy.push(data.classic + "-image"),
    renderInsightCardToImage: data => calls.legacy.push(data.classic + "-image"),
  });
  for (const [name, renderer] of Object.entries(views)) {
    if (name.startsWith("renderCreative")) context[name] = (...args) => { calls.views.push({name, args}); return renderer(...args); };
  }
  vm.runInContext(declarations, context, {timeout: 1000});
  return {context, calls, draft, opportunity, benchmark, mode, document, window};
}

const button = () => ({textContent: "复制文字", innerHTML: "复制文本", disabled: false});
const flush = () => new Promise(resolve => setImmediate(resolve));

test("all four actual new-UI renderer bridges execute real presentation modules with complete arguments", () => {
  const {context, calls, draft, opportunity, benchmark} = fixture();
  for (const html of [context.renderKeywordOpportunityResult(), context.renderBenchmarkDiscoveryResult(), context.renderInsightSummaryCard(draft), context.renderInsightCategories(draft)]) assert.match(html, /\bcr-/);
  assert.deepEqual(calls.views.map(call => call.name), ["renderCreativeOpportunity", "renderCreativeBenchmark", "renderCreativeInsightSummary", "renderCreativeInsightCategories"]);
  assert.equal(calls.views[0].args[0], opportunity);
  assert.equal(calls.views[1].args[0], benchmark);
  const helpers = calls.views[1].args[1];
  assert.equal(helpers.evidence, context.buildBenchmarkDiscoveryCandidateEvidence);
  assert.equal(helpers.works, context.buildBenchmarkDiscoveryRepresentativeWorks);
  assert.equal(helpers.fallbackAnalysis, context.buildBenchmarkDiscoveryFallbackAnalysis);
  assert.equal(calls.views[3].args[0].sampleResultsByCategoryId, draft.sampleResultsByCategoryId);
  assert.equal(calls.views[3].args[0].expandedIds, context.expandedKeywordInsightCategoryIds);
});

test("classic mode runs the real pre-existing renderer branches rather than the new templates", () => {
  const {context, calls, draft} = fixture({next: false});
  assert.match(context.renderKeywordOpportunityResult(), /keyword-opportunity-summary/);
  assert.match(context.renderBenchmarkDiscoveryResult(), /keyword-benchmark-summary/);
  assert.match(context.renderInsightSummaryCard(draft), /keyword-insight-summary-card/);
  assert.match(context.renderInsightCategories(draft), /keyword-insight-category-card/);
  assert.equal(calls.views.length, 0);
});

test("benchmark loading still takes precedence over result rendering and null results stay safe", () => {
  for (const next of [true, false]) {
    const {context, calls} = fixture({next});
    context.keywordBenchmarkAnalysisStatus = "loading";
    context.keywordBenchmarkLoadingTitle = "正在补采主页";
    assert.match(context.renderBenchmarkDiscoveryResult(), /正在补采主页/);
    assert.equal(calls.views.length, 0);
    context.keywordBenchmarkAnalysisStatus = "idle";
    context.keywordBenchmarkResult = context.keywordOpportunityResult = null;
    assert.equal(context.renderBenchmarkDiscoveryResult(), "");
    assert.equal(context.renderKeywordOpportunityResult(), "");
    assert.equal(context.renderInsightSummaryCard({analysisResult: null}), "");
    assert.equal(context.renderInsightCategories({analysisResult: null}), "");
  }
});

test("new copy handlers route all three complete snapshots into the shared text model", async () => {
  const {context, calls} = fixture();
  for (const name of ["handleCopyKeywordOpportunity", "handleCopyBenchmarkDiscovery", "handleCopyInsight"]) {
    const target = button(); await context[name](target);
    assert.equal(target.disabled, false); assert.equal(target.textContent, "复制文字");
  }
  assert.equal(calls.copies.length, 3);
  assert.match(calls.copies[0], /安吉星｜赛道机会/);
  assert.match(calls.copies[0], /https:\/\/example\.test\/note/);
  assert.match(calls.copies[1], /安吉星｜对标账号/);
  assert.match(calls.copies[1], /https:\/\/example\.test\/author/);
  assert.match(calls.copies[2], /安吉星｜长尾需求/);
  assert.match(calls.copies[2], /https:\/\/example\.test\/longtail/);
  assert.equal(calls.legacy.length, 0);
  assert.equal(calls.timers.length, 0);
});

test("classic copy handlers retain their original text builders and original longtail copy", async () => {
  const {context, calls} = fixture({next: false});
  context.handleCopyKeywordOpportunity(button()); context.handleCopyBenchmarkDiscovery(button()); context.handleCopyInsight(button());
  await flush();
  assert.deepEqual(calls.legacy, ["opportunity-text", "benchmark-text"]);
  assert.equal(calls.copies[0], "legacy opportunity text");
  assert.equal(calls.copies[1], "legacy benchmark text");
  assert.match(calls.copies[2], /【需求洞察】/);
  assert.equal(calls.timers.length, 3);
});

test("new image bridges preserve source arrays and pass only the intended preview environment", () => {
  const {context, calls, opportunity, benchmark, draft, document, window} = fixture();
  context.handleShareKeywordOpportunityAsImage(); context.handleShareBenchmarkDiscoveryAsImage(); context.handleShareAsImage();
  assert.deepEqual(calls.previews.map(call => call.kind), ["opportunity", "benchmark", "longtail"]);
  assert.equal(calls.previews[0].snapshot._listItems, opportunity._listItems);
  assert.equal(calls.previews[0].snapshot._representativeSamples, opportunity._representativeSamples);
  assert.equal(calls.previews[1].snapshot.candidates, benchmark.candidates);
  assert.equal(calls.previews[2].snapshot.categories[0].samples, draft.sampleResultsByCategoryId.a.samples);
  assert.equal(calls.previews[2].snapshot.categories[0].sampleKeyword, "续费价格");
  for (const call of calls.previews) { assert.equal(call.options.document, document); assert.equal(call.options.window, window); assert.equal(typeof call.options.onMessage, "function"); }
  assert.equal(calls.legacy.length, 0);
});

test("classic image bridges still use all three original data builders and canvas entry points", () => {
  const {context, calls} = fixture({next: false});
  context.handleShareKeywordOpportunityAsImage(); context.handleShareBenchmarkDiscoveryAsImage(); context.handleShareAsImage();
  assert.deepEqual(calls.legacy, ["opportunity-data", "opportunity-image", "benchmark-data", "benchmark-image", "longtail-data", "longtail-image"]);
  assert.equal(calls.previews.length, 0);
});

test("snapshot bridge trusts original result platform before the current browser selection", () => {
  const {context, opportunity} = fixture();
  assert.equal(context.creativeShareSnapshot(opportunity).platformLabel, "小红书");
  assert.equal(context.creativeShareSnapshot({platformLabel: "原平台"}).platformLabel, "原平台");
  assert.equal(context.creativeShareSnapshot({}).platformLabel, "抖音");
  assert.equal(context.creativeShareSnapshot(null), null);
});

test("longtail snapshot bridge tolerates malformed cached categories without losing valid source URLs", () => {
  const {context, draft} = fixture();
  const snapshot = context.getCreativeLongtailSnapshot();
  assert.equal(snapshot.categories[0].samples[0].url, "https://example.test/longtail");
  assert.equal(snapshot.categories[0].samples[0].likes, 0);
  draft.analysisResult.categories = [null, {id: "a", keywords: ["续费价格"]}];
  assert.equal(context.getCreativeLongtailSnapshot().categories.length, 1);
  draft.analysisResult.categories = {unexpected: true};
  assert.equal(context.getCreativeLongtailSnapshot().categories.length, 0);
  draft.analysisResult = null;
  assert.equal(context.getCreativeLongtailSnapshot(), null);
});

test("new null-share and clipboard denial paths give feedback and never leave a button disabled", async () => {
  const {context, calls, draft} = fixture({rejectClipboard: true});
  const target = button(); await context.handleCopyKeywordOpportunity(target);
  assert.equal(target.disabled, false);
  assert.ok(calls.messages.some(([message]) => message.includes("复制失败")));
  context.keywordOpportunityResult = context.keywordBenchmarkResult = null; draft.analysisResult = null;
  for (const name of ["handleCopyKeywordOpportunity", "handleCopyBenchmarkDiscovery", "handleCopyInsight"]) await context[name](button());
  for (const name of ["handleShareKeywordOpportunityAsImage", "handleShareBenchmarkDiscoveryAsImage", "handleShareAsImage"]) context[name]();
  assert.equal(calls.copies.length, 0); assert.equal(calls.previews.length, 0);
});

test("the actual mode listener only rerenders views; it never starts or resets a collector", () => {
  const match = engine.match(/\/\/ @creative-view:start mode-render-listener\n([\s\S]*?)\/\/ @creative-view:end mode-render-listener/);
  assert.ok(match);
  const events = new Map(); const calls = [];
  const draft = {analysisStatus: "success", analysisResult: {summary: "结果"}};
  const context = vm.createContext({window: {addEventListener: (name, callback) => events.set(name, callback)}, getKeywordInsightState: () => draft, renderKeywordStrategyPanel: () => calls.push("strategy"), renderKeywordInsightState: () => calls.push("insight")});
  vm.runInContext(match[1], context, {timeout: 1000});
  assert.deepEqual([...events.keys()], ["starvoice:presentation-mode"]);
  events.get("starvoice:presentation-mode")();
  assert.deepEqual(calls, ["strategy", "insight"]);
  for (const status of ["idle", "loading", "error", "success"]) {
    draft.analysisStatus = status;
    draft.analysisResult = status === "success" ? null : {summary: "旧结果"};
    calls.length = 0;
    events.get("starvoice:presentation-mode")();
    assert.deepEqual(calls, ["strategy"], `${status} must keep the existing non-result presentation`);
  }
  assert.doesNotMatch(match[1], /(?:capture|cancel|start|reset|setCurrent|chrome|fetch|initSidebar)\s*\(/i);
});

test("mode switch skips real idle insight renderer with words and absent capture button, but rerenders successful results", () => {
  const {context, calls, draft, mode, document} = fixture();
  const nodes = new Map(["keywordInsightContainer", "keywordInsightSummary", "keywordInsightCategories", "keywordInsightError", "keywordInsightErrorMessage", "btnRetryKeywordAnalysis", "keywordInsightIntro"].map(id => [id, {innerHTML: "unchanged", hidden: false}]));
  document.getElementById = id => nodes.get(id) || null;
  let expandedRenders = 0, strategyRenders = 0;
  context.renderExpandedKeywords = () => { expandedRenders++; };
  context.renderKeywordStrategyPanel = () => { strategyRenders++; };
  vm.runInContext(declaration("renderKeywordInsightState"), context, {timeout: 1000});
  const listener = engine.match(/\/\/ @creative-view:start mode-render-listener\n([\s\S]*?)\/\/ @creative-view:end mode-render-listener/);
  vm.runInContext(listener[1], context, {timeout: 1000});
  const onModeChange = calls.events.get("starvoice:presentation-mode");
  const analysis = draft.analysisResult;
  draft.analysisStatus = "idle"; draft.analysisResult = null;
  assert.equal(document.getElementById("btnInsightBatchCapture"), null);
  assert.throws(() => context.renderKeywordInsightState(), /Cannot set properties of null/);
  expandedRenders = 0;
  assert.doesNotThrow(onModeChange);
  assert.equal(expandedRenders, 0, "mode-only change must not enter the pre-existing idle branch");
  draft.analysisStatus = "success"; draft.analysisResult = analysis;
  assert.doesNotThrow(onModeChange);
  assert.equal(expandedRenders, 1);
  assert.match(nodes.get("keywordInsightSummary").innerHTML, /cr-longtail-summary/);
  mode.next = false;
  assert.doesNotThrow(onModeChange);
  assert.equal(expandedRenders, 2);
  assert.match(nodes.get("keywordInsightSummary").innerHTML, /keyword-insight-summary-card/);
  assert.equal(strategyRenders, 3);
});
