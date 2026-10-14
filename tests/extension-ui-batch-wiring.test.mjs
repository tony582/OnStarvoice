import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";

// Execute the current original handlers, NOT fixture substitutes. Every IO
// dependency is an in-memory stub: no browser, collector, API or storage runs.
const source = await readFile(new URL("../sidebar/sidebar-logic.js", import.meta.url), "utf8");
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source boundary changed: ${startMarker}`);
  return source.slice(start, end);
}
const originalFunctions = [
  section("function getCaptureCommentsChecked(", "function getSkipOfficialAccountsChecked("),
  section("function getCaptureBloggerMetricsChecked(", "function collectBatchRecordIds("),
  section("function collectBatchRecordIds(", "function syncBloggerMetricsCaptureControls("),
  section("function getActiveDetailCaptureInput(", "function syncAutoDetailCaptureControls("),
  section("function resolveCurrentDetailCaptureSettings(", "function readSyncScopeFromInput("),
  section("function readBloggerMinLikesFromInput(", "function updateBloggerKeywordFilterHint("),
  section("async function handleRunBatchLinks()", "let batchProgressCountdownTimer ="),
].join("\n");

function runtime({page = "bloggerTab", authorized = true, lock = true, fail = false} = {}) {
  const observed = {calls: [], locks: [], releases: [], enhancements: [], messages: [], cancels: [], tabReads: 0};
  const controls = new Map();
  const input = (value = "", checked = false) => ({value, checked});
  const button = () => ({textContent: "开始批量采集", classList: {add() {}, remove() {}}});
  controls.set("btnRunBatchLinks", button());
  controls.set("btnRunBatchBloggers", button());
  controls.set("textareaBatchLinks", input(" https://example.org/note/1\n\nhttps://example.org/note/2 "));
  controls.set("textareaBatchBloggers", input(" https://example.org/profile/1\n\nhttps://example.org/profile/2 "));
  controls.set("inputBloggerMinLikes", input("17"));
  controls.set("inputBloggerMaxDetectedItems", input("31"));
  controls.set("inputBloggerKeywordFilter", input(" 汽车 "));
  controls.set("checkboxCaptureComments", input("", true));
  controls.set("checkboxCaptureBloggerMetrics", input("", true));
  controls.set("checkboxEnableCommentLeadsFilter", input("", false));
  const makePanel = (enabled, limit) => ({
    auto: input("", enabled), "auto-sync": input("", enabled),
    comments: input("", enabled), "comments-max-detected-items": input(String(limit)),
    metrics: input("", enabled), "skip-captured": input("", true),
    "comment-leads": input("", false), "low-follower-hit": input("", false),
    "low-follower-hit-threshold": input("10000"),
  });
  const panels = {bloggerTab: makePanel(true, 23), searchTab: makePanel(false, 77)};
  panels.searchTab["ai-relevance-prefilter"] = input("", true);
  const settings = {
    autoDetailCaptureAfterListCapture: false, enableAiRelevancePrefilter: false,
    bloggerMaxDetectedItems: 50, commentsMaxDetectedItems: 11,
    detailCommentsMaxDetectedItems: 50, sharedWaitMinMs: 700, sharedWaitMaxMs: 1300,
    sharedStallTimeoutMs: 30000, sharedMaxDurationMs: 120000,
    detailNavTimeoutMs: 90000, profileAfterNavWaitMs: 3500,
  };
  const context = vm.createContext({
    console: {error() {}, warn() {}},
    document: {
      getElementById: id => controls.get(id) || null,
      querySelector: selector => panels[page]?.[/data-detail-setting="([^"]+)"/.exec(selector)?.[1]] || null,
    },
    DEFAULT_CAPTURE_SETTINGS: settings,
    PAGE_TYPE: {SEARCH_RESULTS: "search_results"},
    PAGE_ENHANCE_AUTH_REQUIRED_MESSAGE: "需要授权",
    getCurrentRuntime: () => ({pageType: "search_results"}),
    getViewPlatform: () => "xiaohongshu",
    getPlatformCapabilities: () => ({captureComments: true, bloggerMetrics: true}),
    getCaptureSettings: async () => ({...settings}),
    readRequiredCommentsMaxDetectedItemsFromInput: () => 19,
    ensureAuthVerifiedOrWarn: () => authorized,
    acquireCaptureExecutionLock: async options => { observed.locks.push(options); return lock ? {id: "mock-lock"} : null; },
    releaseCaptureExecutionLock: async id => observed.releases.push(id),
    chrome: {tabs: {query: async () => {observed.tabReads++; return [{id: 88}];}}},
    batchCaptureByUrls: async options => {
      observed.calls.push(JSON.parse(JSON.stringify(options)));
      if (fail) throw new Error("simulated failure");
      return {stats: {total: 2, processed: 2, success: 2, failed: 0}, results: [{recordIds: ["r1", "r2", "r1"]}]};
    },
    maybeRunAutoDetailCaptureAfterListCapture: async (options, target) => observed.enhancements.push(JSON.parse(JSON.stringify({options, target}))),
    refreshDataPool: async () => {}, setBatchProgressVisible() {}, updateBatchProgress() {},
    showMessage: (...args) => observed.messages.push(args),
    requestCaptureCancelSignal: async id => observed.cancels.push(id),
    batchUrlCaptureInFlight: false, batchUrlCancelRequested: false,
    batchKeywordCaptureInFlight: false, batchUrlCaptureMode: "", activeBatchRunnerTabId: null,
  });
  vm.runInContext(originalFunctions, context);
  return {context, observed, controls};
}

test("the original enhancement reader is page-scoped, so moving batch entry must restore its owner page", () => {
  const owner = runtime({page: "bloggerTab"});
  const search = runtime({page: "searchTab"});
  const original = owner.context.resolveCurrentDetailCaptureSettings({});
  const wrongPage = search.context.resolveCurrentDetailCaptureSettings({});
  assert.equal(original.autoDetailCaptureAfterListCapture, true);
  assert.equal(original.detailCommentsMaxDetectedItems, 23);
  assert.equal(wrongPage.autoDetailCaptureAfterListCapture, false);
  assert.equal(wrongPage.detailCommentsMaxDetectedItems, 77);
});

test("original batch blogger handler retains limits, filters, profile capture and owner-page enhancement", async () => {
  const {context, observed} = runtime();
  await context.handleRunBatchBloggers();
  assert.equal(observed.calls.length, 1);
  assert.deepEqual(observed.calls[0], {
    urls: ["https://example.org/profile/1", "https://example.org/profile/2"], mode: "blogger_notes",
    captureParams: {includeBloggerProfileRecord: true, minLikes: 17, maxDetectedItems: 31, keywordFilter: "汽车", waitMinMs: 700, waitMaxMs: 1300, stallTimeoutMs: 30000, maxDurationMs: 120000},
  });
  assert.equal(observed.enhancements[0].options.detailCommentsMaxDetectedItems, 23);
  assert.equal(observed.enhancements[0].options.includeCommentsOnDetailCapture, true);
  assert.equal(observed.enhancements[0].options.enableAiRelevancePrefilter, false);
  assert.deepEqual(observed.enhancements[0].target.recordIds, ["r1", "r2"]);
  assert.deepEqual(observed.releases, ["mock-lock"]);
  assert.equal(context.batchUrlCaptureInFlight, false);
});

test("original batch works handler retains note comments, metrics and timeouts", async () => {
  const {context, observed} = runtime({page: "noteTab"});
  await context.handleRunBatchLinks();
  assert.deepEqual(observed.calls, [{
    urls: ["https://example.org/note/1", "https://example.org/note/2"], mode: "single",
    captureParams: {includeComments: true, includeBloggerMetrics: true, enableCommentLeadsFilter: false, commentsMaxDetectedItems: 19, detailNavTimeoutMs: 90000, profileAfterNavWaitMs: 3500},
  }]);
  assert.deepEqual(observed.releases, ["mock-lock"]);
});

for (const [mode, handler] of [["links", "handleRunBatchLinks"], ["bloggers", "handleRunBatchBloggers"]]) {
  test(`${mode}: original handler does not dispatch when execution lock is denied`, async () => {
    const {context, observed} = runtime({lock: false});
    await context[handler]();
    assert.equal(observed.calls.length, 0);
    assert.equal(observed.tabReads, 0);
    assert.equal(observed.releases.length, 0);
  });
  test(`${mode}: original stop action signals the same runner without starting a second batch`, async () => {
    const {context, observed} = runtime();
    Object.assign(context, {batchUrlCaptureInFlight: true, batchUrlCaptureMode: mode, activeBatchRunnerTabId: 88});
    await context[handler]();
    assert.deepEqual(observed.cancels, [88]);
    assert.equal(observed.calls.length, 0);
    assert.equal(observed.locks.length, 0);
    assert.equal(context.batchUrlCancelRequested, true);
  });
  test(`${mode}: original handler releases its lock after a failed capture`, async () => {
    const {context, observed} = runtime({fail: true});
    await context[handler]();
    assert.equal(observed.calls.length, 1);
    assert.deepEqual(observed.releases, ["mock-lock"]);
    assert.equal(context.batchUrlCaptureInFlight, false);
    assert.equal(context.activeBatchRunnerTabId, null);
    assert.equal(observed.messages.at(-1)[1], "error");
  });
}

test("original enhanced blogger batch still enforces authorization before tab access", async () => {
  const {context, observed} = runtime({authorized: false});
  await context.handleRunBatchBloggers();
  assert.equal(observed.calls.length, 0);
  assert.equal(observed.tabReads, 0);
  assert.deepEqual(observed.releases, ["mock-lock"]);
});
