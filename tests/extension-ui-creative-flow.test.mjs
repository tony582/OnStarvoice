import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";
import {normalizeCreativePresentationEngine} from "../scripts/creative-presentation-boundary.mjs";

const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const [adapter, css, engine] = await Promise.all([
  read("sidebar/ui-next.js"), read("sidebar/ui-next.css"), read("sidebar/sidebar-logic.js"),
]);
function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source boundary changed: ${startMarker}`);
  return source.slice(start, end);
}
const cssRules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, declarations]) => ({selector: selector.trim(), declarations}));

test("automatic capture-page navigation no longer dismisses the selected creative view", () => {
  const subscriptions = [...adapter.matchAll(/listen\(document, "starvoice:sidebar-tab",([\s\S]*?)\);/g)];
  assert.ok(subscriptions.length > 0);
  for (const [, listener] of subscriptions) assert.doesNotMatch(listener, /closeIdeas\s*\(/);
  assert.ok(subscriptions.some(([, listener]) => /updateNav/.test(listener)));
  assert.match(adapter, /let ideasSelected\s*=\s*ideas\.classList\.contains\("is-active"\)/);
  assert.match(adapter, /const view\s*=\s*ideasSelected\s*\?\s*"ideas"/);
});

test("explicit close clears local presentation intent without canceling an analysis", () => {
  const close = adapter.match(/const closeIdeas = \(\) => \{([\s\S]*?)\n    \};/)?.[1];
  assert.ok(close, "explicit creative close handler exists");
  assert.match(close, /ideasSelected\s*=\s*false/);
  assert.match(close, /btnKeywordStrategyModalClose/);
  assert.doesNotMatch(close, /Cancel|setCurrent|requestCapture|keywordOpportunityInFlight|keywordBenchmarkInFlight/);
  assert.match(adapter, /event\.key === "Escape"/);
});

test("leaving Creative while its old surface is temporarily hidden still clears original panel intent", () => {
  const close = adapter.match(/const closeIdeas = \(\) => \{[\s\S]*?\n    \};/)?.[0];
  assert.ok(close);
  let closes = 0;
  const context = vm.createContext({
    ideas: {classList: {contains: () => false}},
    $: selector => {
      assert.equal(selector, "#btnKeywordStrategyModalClose");
      return {click: () => { closes++; }};
    },
  });
  vm.runInContext(`let ideasSelected = true; ${close}\ncloseIdeas(); globalThis.selected = ideasSelected;`, context);
  assert.equal(context.selected, false);
  assert.equal(closes, 1, "original hidden panel must not reopen on a later runtime update");
});

test("creative task actions reuse the dedicated original stop nodes without dispatch proxies", () => {
  assert.match(adapter, /element\("(?:section|div)", "sv-creative-task"/);
  assert.match(adapter, /element\("(?:section|div)", "sv-creative-task-actions"/);
  for (const id of ["btnCancelKeywordOpportunity", "btnCancelBenchmarkDiscovery"]) {
    assert.match(adapter, new RegExp(id));
    assert.doesNotMatch(adapter, new RegExp(`${id}["']\\)\\.click\\(`));
  }
  assert.match(adapter, /for \(const id of \["btnCancelKeywordOpportunity", "btnCancelBenchmarkDiscovery"\]\) move\(\$\("#" \+ id\), taskActions\)/);
  assert.doesNotMatch(adapter, /handleCancelKeywordOpportunity|handleCancelBenchmarkDiscovery|requestCaptureCancelSignal|keywordOpportunityCancelRequested\s*=|keywordBenchmarkCancelRequested\s*=/);
  assert.doesNotMatch(adapter, /\.cloneNode\s*\(|\.innerHTML\s*=/);
});

test("shared progress reserves a bounded flex row for every new-UI page, not an overlay", () => {
  const rule = cssRules.find(({selector, declarations}) =>
    selector === ".sv-next #progressContainer" && /position\s*:\s*static/.test(declarations));
  assert.ok(rule, "all new-UI capture pages share the reserved progress row");
  assert.doesNotMatch(rule.declarations, /display\s*:|visibility\s*:|position\s*:\s*(?:fixed|sticky)/);
  const wrapper = cssRules.find(({selector}) => selector === ".sv-next .sv-feedback");
  assert.ok(wrapper, "feedback wrapper owns layout but not original progress visibility");
  assert.match(wrapper.declarations, /flex-shrink\s*:\s*0/);
  assert.match(wrapper.declarations, /max-height\s*:\s*min\(40dvh,\s*340px\)/);
  assert.match(wrapper.declarations, /overflow(?:-y)?\s*:\s*auto/);
  assert.doesNotMatch(wrapper.declarations, /position\s*:\s*(?:fixed|sticky)/);
  assert.match(adapter, /const progress = \$\("#progressContainer"\)/);
  assert.match(adapter, /const feedback = add\(\$\("\.container"\), element\("div", "sv-feedback"\)\)/);
  const feedbackAt = adapter.indexOf('const feedback = add(');
  const moveAt = adapter.indexOf('move(progress, feedback)');
  const navAt = adapter.indexOf('const nav = add($(".container"), element("nav", "sv-bottom-nav"))');
  assert.ok(feedbackAt > 0 && moveAt > feedbackAt && navAt > moveAt, "one feedback row with original progress is placed before bottom navigation");
});

test("creative stop has an independent sibling region when a child capture hides shared progress", () => {
  assert.match(adapter, /const task = add\(feedback, element\("section", "sv-creative-task"\)\)/);
  assert.match(adapter, /move\(progress, feedback\)/);
  assert.doesNotMatch(adapter, /add\(progress, element\("section", "sv-creative-task"\)/);
  const visibleFeedback = cssRules.flatMap(({selector, declarations}) =>
    /display\s*:\s*block/.test(declarations) ? selector.split(/,\s*(?=\.sv-next)/) : []);
  const independentStop = visibleFeedback.find(selector =>
    /\.sv-ideas-view\s+\.sv-feedback:has\(\.sv-creative-task-actions > button\[style\*="display: inline-flex"\]\)/.test(selector));
  assert.ok(independentStop, "analysis stop independently keeps its reserved row visible");
  assert.doesNotMatch(independentStop, /#progressContainer/);
  for (const {selector, declarations} of cssRules) {
    if (selector.trim().endsWith("#progressContainer")) {
      assert.doesNotMatch(declarations, /display\s*:\s*(?:block|flex|grid)/, "presentation must never force a child capture's progress back open");
    }
  }
});

test("all three original capture action rows stay in normal document flow without a bottom dock spacer", () => {
  const actionRules = cssRules.filter(({selector}) => /\.action-row\b/.test(selector));
  const rows = actionRules.filter(({selector, declarations}) => selector.endsWith(".action-row") && /position\s*:\s*static/.test(declarations));
  assert.ok(rows.length > 0, "capture rows must explicitly stay in normal flow");
  for (const id of ["noteTab", "bloggerTab", "searchTab"]) {
    assert.ok(rows.some(({selector}) => selector.includes(`#${id}`)), `${id} must use the in-flow row`);
  }
  for (const {declarations} of actionRules) {
    assert.doesNotMatch(declarations, /position\s*:\s*(?:fixed|sticky|absolute)|(?:^|;)\s*(?:bottom|left|transform)\s*:/, "no viewport docking may override the original action row");
  }
  const content = cssRules.find(({selector}) => selector === ".sv-next .tab-content");
  assert.ok(content);
  assert.match(content.declarations, /(?:^|;)\s*padding\s*:\s*14px\s*(?:;|$)/);
  assert.match(content.declarations, /scroll-padding-(?:block|bottom)\s*:\s*14px/);
  for (const {selector, declarations} of cssRules.filter(({selector}) => /\.tab-content|#mainTabContent/.test(selector))) {
    assert.doesNotMatch(declarations, /(?:padding|scroll-padding)[^:]*:[^;]*(?:94|100)px/, `${selector}: no reservation for a removed fixed action bar`);
  }
  assert.doesNotMatch(css, /bottom\s*:\s*138px/);
  const dock = cssRules.find(({selector}) => selector === ".sv-next .debug-session-dock");
  assert.ok(dock);
  assert.match(dock.declarations, /bottom\s*:\s*74px/, "minimized running task only clears the four-tab navigation");
  assert.doesNotMatch(adapter, /(?:move|add)\(\$\("#btnCapture(?:Note|Blogger|Search)"\)/, "do not clone or relocate existing capture buttons");
});

test("original visible progress hides the in-flow capture rows without rewriting engine availability", () => {
  const dockRules = cssRules.filter(({selector, declarations}) =>
    /#progressContainer/.test(selector) && /\.action-row/.test(selector) && /display\s*:\s*none/.test(declarations));
  assert.ok(dockRules.length > 0);
  const selectors = dockRules.map(({selector}) => selector).join("\n");
  for (const id of ["noteTab", "bloggerTab", "searchTab"]) assert.match(selectors, new RegExp(`#${id}\\b`));
  for (const {selector} of dockRules) {
    assert.match(selector, /^\.sv-next/);
    assert.match(selector, /#progressContainer\[style\*="display: block"\]/);
    assert.doesNotMatch(selector, /disabled|progressText|data-state/);
  }
  assert.doesNotMatch(adapter, /progress\.(?:style|hidden)\s*[.=]|progress\.dataset\.[\w]+\s*=|(?:setCaptureButtonsDisabled|setPrimaryCaptureButtonDisabled|setCurrentCapture|setCurrentRuntime)\s*\(/);
  const content = cssRules.find(({selector}) => selector === ".sv-next .tab-content");
  assert.match(content.declarations, /(?:^|;)\s*padding\s*:\s*14px\s*(?:;|$)/, "running and idle views share ordinary content padding, not a fixed-action spacer");
  assert.ok(!cssRules.some(({selector}) => /#progressContainer\[style\*="display: block"\]/.test(selector) && /mainTabContent|\.tab-content/.test(selector)), "showing progress must not need a second padding mode");
});

test("the UI fix leaves the engine outside exact reviewed presentation insertions and all capture modules unchanged", async () => {
  for (const file of ["sidebar/sidebar-logic.js", "sidebar/state.js", "utils/capture-sync.js", "background.js"]) {
    const current = await read(file), shipping = await read(`extension-build/${file}`);
    assert.equal(file === "sidebar/sidebar-logic.js" ? normalizeCreativePresentationEngine(current, {requireIntegrated: true}) : current,
      file === "sidebar/sidebar-logic.js" ? normalizeCreativePresentationEngine(shipping) : shipping, file);
  }
});

test("generic stop is suppressed only beside dedicated creative stop, never for recovery or keyword plans", () => {
  const suppression = cssRules.filter(({selector, declarations}) =>
    /#btnCancel\s*$/.test(selector) && /display\s*:\s*none/.test(declarations));
  assert.ok(suppression.length > 0);
  for (const {selector} of suppression) {
    assert.match(selector, /\.sv-ideas-view/);
    assert.match(selector, /sv-creative-task-actions/);
    assert.match(selector, /display:\s*inline-flex/);
    assert.match(selector, /:not\(\[data-progress-source=["']capture-recovery["']\]\)/);
    assert.match(selector, /:not\(\[data-progress-source=["']keyword-plan["']\]\)/);
  }
  for (const {selector, declarations} of cssRules) {
    if (/#btnExpandKeywords\b|#btnRunKeywordInsight\b/.test(selector)) {
      assert.doesNotMatch(declarations, /display\s*:\s*none|visibility\s*:\s*hidden/);
    }
  }
});

test("the original opportunity and benchmark await chains and results remain engine-owned", () => {
  const opportunity = section(engine, "async function handleRunKeywordOpportunity()", "function handleOpenKeywordLongtail()");
  assert.match(opportunity, /await captureKeywordOpportunitySamples\(/);
  assert.match(opportunity, /await analyzeKeywordOpportunity\(/);
  assert.match(opportunity, /keywordOpportunityResult = response\.data/);
  assert.match(opportunity, /finally\s*\{\s*keywordOpportunityInFlight = false;[\s\S]*hideProgress\(\);[\s\S]*renderKeywordStrategyPanel\(\)/);
  const benchmark = section(engine, "async function handleRunBenchmarkDiscovery()", "async function handleRunKeywordOpportunity()");
  assert.match(benchmark, /await captureBenchmarkCandidateProfiles\(/);
  assert.match(benchmark, /await enrichBenchmarkDiscoveryWithAi\(/);
  assert.match(benchmark, /finally\s*\{\s*keywordBenchmarkInFlight = false;/);
  const samples = section(engine, "async function captureKeywordOpportunitySamples(", "async function handleCancelKeywordOpportunity()");
  assert.match(samples, /finally\s*\{[\s\S]*await chrome\.tabs\.update\(sourceTabId,\s*\{\s*url: sourceTabUrl/);
  assert.doesNotMatch(adapter, /renderKeywordStrategyPanel\s*\(|renderKeywordOpportunityResult\s*\(|renderBenchmarkDiscoveryResult\s*\(|analyzeKeywordOpportunity\s*\(/);
});

// Execute only original renderer/cancel functions. No initialization, browser,
// storage, collector or API is imported; all cancellation IO is an inert stub.
const originalRenderer = section(engine, "function renderKeywordStrategyPanel()", "function buildKeywordOpportunityInputItems(");
const originalCancels = section(engine, "async function handleCancelKeywordOpportunity()", "async function captureBenchmarkCandidateProfiles(");
const originalHideProgress = section(engine, "function hideProgressPanelOnly(", "function isTerminalProgressPhase(");

test("the original child-progress hide leaves analysis stopping available for the later AI await", () => {
  const controls = new Map([
    ["progressContainer", {style: {display: "block"}, dataset: {progressSource: "capture"}}],
    ["btnCancel", {style: {display: "inline-flex"}, hidden: false, disabled: false}],
    ["btnCancelKeywordOpportunity", {style: {display: "inline-flex"}}],
  ]);
  const context = vm.createContext({document: {getElementById: id => controls.get(id)}});
  vm.runInContext(originalHideProgress, context);
  context.hideProgressPanelOnly();
  assert.equal(controls.get("progressContainer").style.display, "none");
  assert.equal(controls.get("btnCancel").hidden, true);
  assert.equal(controls.get("btnCancelKeywordOpportunity").style.display, "inline-flex");
});

function rendererRuntime() {
  const controls = new Map();
  const control = id => {
    if (!controls.has(id)) {
      const classes = new Set();
      controls.set(id, {
        style: {}, hidden: false, disabled: false, textContent: "", innerHTML: "",
        classList: {
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
          contains: name => classes.has(name),
        },
        setAttribute(name, value) { this[name] = value; },
      });
    }
    return controls.get(id);
  };
  const context = vm.createContext({
    document: {getElementById: control},
    runtime: {pageType: "search_results"},
    PAGE_TYPE: {SEARCH_RESULTS: "search_results"},
    getCurrentRuntime: () => context.runtime,
    getCurrentSearchKeyword: () => "安吉星",
    getPagePlatform: () => "xiaohongshu", getViewPlatform: () => "xiaohongshu",
    getPlatformCapabilities: () => ({captureSearch: true}), getKeywordOpportunityKeyword: () => "安吉星",
    keywordStrategyPanelVisible: true, keywordStrategyActiveTab: "opportunity",
    keywordOpportunityInFlight: true, keywordOpportunityResult: null, keywordOpportunityErrorMessage: "",
    keywordBenchmarkInFlight: false, keywordBenchmarkResult: null, keywordBenchmarkErrorMessage: "",
    keywordBenchmarkAnalysisStatus: "idle",
    renderBenchmarkDiscoveryResult: () => "original benchmark result",
    renderKeywordOpportunityResult: () => "original opportunity result",
    renderKeywordStrategyLoadingState: ({title}) => `original loading: ${title}`,
  });
  vm.runInContext(originalRenderer, context);
  return {context, control};
}

test("original renderer keeps opportunity stop visible during analysis and restores result controls on completion", () => {
  const {context, control} = rendererRuntime();
  context.renderKeywordStrategyPanel();
  assert.equal(control("btnRunKeywordOpportunity").style.display, "none");
  assert.equal(control("btnCancelKeywordOpportunity").style.display, "inline-flex");
  assert.match(control("keywordOpportunityResult").innerHTML, /original loading/);
  context.keywordOpportunityInFlight = false;
  context.keywordOpportunityResult = {keyword: "安吉星"};
  context.renderKeywordStrategyPanel();
  assert.equal(control("btnRunKeywordOpportunity").style.display, "inline-flex");
  assert.equal(control("btnCancelKeywordOpportunity").style.display, "none");
  assert.equal(control("keywordOpportunityResult").innerHTML, "original opportunity result");
});

test("original detail navigation hides the old surface but retains results and lifecycle for its return", () => {
  const {context, control} = rendererRuntime();
  context.renderKeywordStrategyPanel();
  const before = control("keywordOpportunityResult").innerHTML;
  context.runtime.pageType = "note_detail";
  context.renderKeywordStrategyPanel();
  assert.equal(control("keywordStrategyModalOverlay").ariaHidden, "true");
  assert.equal(control("btnToggleKeywordStrategy").disabled, true);
  assert.equal(control("keywordOpportunityResult").innerHTML, before);
  assert.equal(context.keywordStrategyPanelVisible, true);
  context.runtime.pageType = "search_results";
  context.keywordOpportunityInFlight = false;
  context.keywordOpportunityErrorMessage = "原分析错误";
  context.renderKeywordStrategyPanel();
  assert.equal(control("keywordStrategyModalOverlay").ariaHidden, "false");
  assert.equal(control("keywordOpportunityError").hidden, false);
  assert.equal(control("keywordOpportunityError").textContent, "原分析错误");
  assert.equal(control("btnCancelKeywordOpportunity").style.display, "none");
});

test("benchmark stop remains independently owned by the original renderer", () => {
  const {context, control} = rendererRuntime();
  context.keywordOpportunityInFlight = false;
  context.keywordBenchmarkInFlight = true;
  context.keywordStrategyActiveTab = "benchmark";
  context.renderKeywordStrategyPanel();
  assert.equal(control("btnCancelKeywordOpportunity").style.display, "none");
  assert.equal(control("btnCancelBenchmarkDiscovery").style.display, "inline-flex");
  assert.equal(control("btnRunBenchmarkDiscovery").style.display, "none");
  assert.equal(control("keywordStrategyBenchmarkPane").hidden, false);
  context.keywordBenchmarkInFlight = false;
  context.renderKeywordStrategyPanel();
  assert.equal(control("btnCancelBenchmarkDiscovery").style.display, "none");
  assert.equal(control("btnRunBenchmarkDiscovery").style.display, "inline-flex");
});

for (const [name, handler, inFlight, cancelFlag] of [
  ["opportunity", "handleCancelKeywordOpportunity", "keywordOpportunityInFlight", "keywordOpportunityCancelRequested"],
  ["benchmark", "handleCancelBenchmarkDiscovery", "keywordBenchmarkInFlight", "keywordBenchmarkCancelRequested"],
]) {
  test(`${name}: original stop sets its own flag and awaits the existing cancel signal`, async () => {
    const calls = [];
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const context = vm.createContext({
      keywordOpportunityInFlight: false, keywordBenchmarkInFlight: false,
      keywordOpportunityCancelRequested: false, keywordBenchmarkCancelRequested: false,
      requestCaptureCancelSignal: () => { calls.push("signal"); return pending; },
      showProgress: message => calls.push(message),
    });
    vm.runInContext(originalCancels, context);
    await context[handler]();
    assert.deepEqual(calls, [], "idle stop is inert");
    context[inFlight] = true;
    const stopped = context[handler]();
    assert.equal(context[cancelFlag], true);
    assert.deepEqual(calls, ["signal"], "existing async cancel remains awaited");
    release();
    await stopped;
    assert.equal(calls.length, 2);
    assert.match(calls[1], /正在停止/);
    assert.equal(context[inFlight], true, "the cancel button must not prematurely mark analysis complete");
  });
}
