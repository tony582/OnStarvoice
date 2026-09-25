import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {isXhsPublishTimeWindow} from "../../utils/capture/xhs-publish-window.js";
import {createXhsSearchTimeFilterError, isXhsSearchTimeFilterVerified} from "../../utils/capture/xhs-search-filter-evidence.js";
import {createXhsSecurityBlockError} from "../../utils/capture/xiaohongshu-security.js";
import {settleUnattendedKeywordCheckpoint} from "../../utils/unattended-keyword-run.js";

const syncSource = await readFile(new URL("../../utils/capture-sync.js", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("../../sidebar/sidebar-logic.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../../content-v2.js", import.meta.url), "utf8");
const adminLibSource = await readFile(new URL("../../web/admin/src/pages/dispatch/cloud-tasks/lib.ts", import.meta.url), "utf8");

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} missing`);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

const routeHelpersSource = slice(syncSource, "function classifyXhsSearchPathname(", "function formatKeywordFailureMessage(");
const failureMessageSource = slice(syncSource, "function formatKeywordFailureMessage(", "export async function lightSampleByKeywords({");
const syncBuilderSource = slice(syncSource, "function buildKeywordSearchUrl(", "function isDouyinPlatform(");

function loadSyncBuilder() {
  const context = vm.createContext({URL});
  vm.runInContext(`${routeHelpersSource}\n${syncBuilderSource}\nglobalThis.build = buildKeywordSearchUrl;`, context);
  return context.build;
}

function loadSidebarBuilder() {
  const context = vm.createContext({URL});
  vm.runInContext(`${slice(sidebarSource, "function buildSidebarKeywordSearchUrl(", "async function waitForActiveTabReady(")}\nglobalThis.build = buildSidebarKeywordSearchUrl;`, context);
  return context.build;
}

function loadFailureMessage() {
  const context = vm.createContext({});
  vm.runInContext(`${failureMessageSource}\nglobalThis.format = formatKeywordFailureMessage;`, context);
  return context.format;
}

const buildSync = loadSyncBuilder();
const buildSidebar = loadSidebarBuilder();
const formatFailure = loadFailureMessage();
const STANDARD_DEFAULT = (keyword) =>
  `https://www.xiaohongshu.com/search_result?source=web_explore_feed&type=51&keyword=${encodeURIComponent(keyword).replace(/%20/gu, "+")}`;
const BASE_MESSAGE = "无法确认小红书时间筛选及结果刷新已生效，已跳过本关键词";
const RELAY_CODES = [
  "CONTENT_RELAY_TIMEOUT",
  "RELOAD_REQUIRED",
  "LOGIN_REQUIRED",
  "XHS_SECURITY_BLOCK",
  "CAPTCHA_PAGE",
  "NETWORK_ERROR",
  "runtime_error",
  "bad code with spaces",
  "页面异常",
  "A".repeat(49),
];

// The admin console classifies keyword failures by matching their text.
function loadAdminFailureClassifiers() {
  const signature = "export function taskKeywordFailureKind(item: TaskKeywordResult): TaskKeywordFailureKind {";
  const kindSource = slice(adminLibSource, signature, "\n}\n");
  const patternSource = slice(adminLibSource, "const PLATFORM_SAFETY_EVIDENCE_PATTERN =", "\n\n");
  const context = vm.createContext({});
  vm.runInContext(
    `${patternSource}\n${kindSource.replace(signature, "function taskKeywordFailureKind(item) {")}\n}\n` +
      "globalThis.kind = taskKeywordFailureKind; globalThis.safety = PLATFORM_SAFETY_EVIDENCE_PATTERN;",
    context,
  );
  return context;
}

test("XHS standard search route keeps reusing its own search parameters", () => {
  for (const build of [buildSync, buildSidebar]) {
    const reused = new URL(build("新词", "xiaohongshu", "https://www.xiaohongshu.com/search_result?source=x&type=y&keyword=%E6%97%A7"));
    assert.equal(reused.pathname, "/search_result");
    assert.equal(reused.searchParams.get("source"), "x");
    assert.equal(reused.searchParams.get("type"), "y");
    assert.equal(reused.searchParams.get("keyword"), "新词");
    const trailing = new URL(build("新词", "xiaohongshu", "https://www.xiaohongshu.com/search_result/?source=x&type=y"));
    assert.equal(trailing.pathname, "/search_result/");
    assert.equal(trailing.searchParams.get("source"), "x");
    assert.equal(trailing.searchParams.get("keyword"), "新词");
  }
});

test("XHS AI search and other non-standard search routes rebuild the standard URL without copying page parameters", () => {
  const bases = [
    "https://www.xiaohongshu.com/search_result_ai?source=ai_entry&type=99&keyword=%E6%97%A7&search_id=abc",
    "https://www.xiaohongshu.com/search_result_ai/?keyword=%E6%97%A7",
    "https://www.xiaohongshu.com/SEARCH_RESULT_AI?source=ai_entry",
    "https://www.xiaohongshu.com/web/search_result?source=legacy&type=3",
    "https://www.xiaohongshu.com/search/result?source=legacy&type=3",
    "https://www.xiaohongshu.com/search_result/665df0000000000000000001?xsec_token=t&source=note",
  ];
  for (const build of [buildSync, buildSidebar]) {
    for (const base of bases) {
      const url = build("关键词 A", "xiaohongshu", base);
      assert.equal(url, STANDARD_DEFAULT("关键词 A"), base);
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/search_result");
      assert.deepEqual([...parsed.searchParams.keys()], ["source", "type", "keyword"]);
    }
  }
});

test("XHS non-search pages, missing bases and invalid bases keep today's URL behaviour", () => {
  for (const build of [buildSync, buildSidebar]) {
    assert.equal(
      build("词", "xiaohongshu", "https://www.xiaohongshu.com/explore?source=explore_src&type=7&channel_id=homefeed"),
      "https://www.xiaohongshu.com/search_result?source=explore_src&type=7&keyword=%E8%AF%8D",
    );
    assert.equal(
      build("词", "xiaohongshu", "https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend"),
      STANDARD_DEFAULT("词"),
    );
    assert.equal(build("词", "xiaohongshu", ""), STANDARD_DEFAULT("词"));
    assert.equal(build("词", "xiaohongshu", "not a url"), STANDARD_DEFAULT("词"));
  }
});

test("Douyin and Weibo URLs ignore the XHS route rule", () => {
  for (const build of [buildSync, buildSidebar]) {
    for (const base of ["", "https://www.xiaohongshu.com/search_result_ai?keyword=x", "https://www.douyin.com/search/x?type=video"]) {
      assert.equal(build("词 1", "douyin", base), "https://www.douyin.com/search/%E8%AF%8D%201?type=general");
      assert.equal(build("词 1", "weibo", base), "https://s.weibo.com/weibo?q=%E8%AF%8D%201");
    }
  }
});

test("capture-sync and sidebar keyword URL builders agree for the same inputs", () => {
  const bases = [
    "",
    "not a url",
    "https://www.xiaohongshu.com/search_result?source=x&type=y",
    "https://www.xiaohongshu.com/search_result/?source=x",
    "https://www.xiaohongshu.com/search_result_ai?source=ai&type=1&keyword=old",
    "https://www.xiaohongshu.com/web/search_result?source=w",
    "https://www.xiaohongshu.com/search/result?type=2",
    "https://www.xiaohongshu.com/explore?source=s&type=t",
    "https://www.xiaohongshu.com/explore",
    "https://www.xiaohongshu.com/user/profile/abc?source=p",
    "https://www.xiaohongshu.com/#/search_result?keyword=old",
  ];
  for (const platform of ["xiaohongshu", "douyin", "weibo"]) {
    for (const keyword of ["词", "a b&c", "安吉星 车机"]) {
      for (const base of bases) {
        assert.equal(buildSidebar(keyword, platform, base), buildSync(keyword, platform, base), `${platform} ${keyword} ${base}`);
      }
    }
  }
});

test("only the exact XHS /search_result path is classified as the standard search route", () => {
  const context = vm.createContext({});
  vm.runInContext(`${routeHelpersSource}\nglobalThis.classify = classifyXhsSearchPathname;`, context);
  assert.equal(context.classify("/search_result"), "standard");
  assert.equal(context.classify("/SEARCH_RESULT/"), "standard");
  for (const pathname of ["/search_result_ai", "/search_result_ai/", "/web/search_result", "/search/result", "/search_result/665df0000000000000000001"]) {
    assert.equal(context.classify(pathname), "non_standard", pathname);
  }
  for (const pathname of ["/explore", "/", "", undefined]) {
    assert.equal(context.classify(pathname), "none", String(pathname));
  }
});

function createBootstrapHarness({redirectToAi = false} = {}) {
  const aiUrl = (keyword) => `https://www.xiaohongshu.com/search_result_ai?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;
  const tab = {id: 41, windowId: 3, active: true, status: "complete", url: aiUrl("旧词")};
  const updates = [];
  let domChecks = 0;
  const context = vm.createContext({
    URL,
    setTimeout,
    PAGE_TYPE: {SEARCH_RESULTS: "search_results"},
    UNATTENDED_SEARCH_BOOTSTRAP_MAX_ATTEMPTS: 4,
    UNATTENDED_SEARCH_BOOTSTRAP_RETRY_DELAYS_MS: [0],
    detectPlatformFromUrl: (url) => (/xiaohongshu\.com/u.test(String(url || "")) ? "xiaohongshu" : ""),
    getPagePlatform: (runtime) => runtime?.platform,
    // Background page-type detection calls every /search_result* path a search page.
    getCurrentRuntime: () => ({platform: "xiaohongshu", pageType: "search_results", lastActiveTabId: tab.id, lastPageUrl: tab.url}),
    readDouyinSearchDocumentGenerationInTab: async () => null,
    beginDouyinSearchResultTransitionInTab: async () => null,
    sleepWithStop: async () => {},
    chrome: {
      tabs: {
        get: async () => ({...tab}),
        query: async () => [{...tab}],
        update: async (tabId, update = {}) => {
          updates.push({tabId, ...update});
          if (update.url) tab.url = redirectToAi ? aiUrl(new URL(update.url).searchParams.get("keyword")) : update.url;
          return {...tab};
        },
      },
      windows: {update: async () => {}},
      scripting: {executeScript: async () => { domChecks += 1; return [{result: false}]; }},
    },
  });
  vm.runInContext(
    `${slice(sidebarSource, "function buildSidebarKeywordSearchUrl(", "function resolveUnattendedBootstrapStartGate(")}\n${slice(sidebarSource, "async function navigateActiveTabToKeywordSearchForPlan({", "function buildUnattendedTaskCounts(")}\nglobalThis.bootstrap = navigateActiveTabToKeywordSearchForPlan;`,
    context,
  );
  const run = () => context.bootstrap({keyword: "安吉星", platform: "xiaohongshu", baseSearchUrl: aiUrl("旧词"), tabId: 41, maxAttempts: 1});
  return {updates, domChecks: () => domChecks, run};
}

test("the unattended bootstrap leaves an XHS AI search tab for the standard search route with a single navigation", async () => {
  const harness = createBootstrapHarness();
  const navigation = await harness.run();
  assert.deepEqual(harness.updates, [{tabId: 41, url: STANDARD_DEFAULT("安吉星"), active: true}]);
  assert.equal(navigation.initialSearchEvidence.ready, true);
  assert.equal(navigation.initialSearchEvidence.pageUrl, STANDARD_DEFAULT("安吉星"));
});

test("bootstrap readiness is keyword-based, so a tab that still ends on the AI route is accepted as before", async () => {
  // Known limit kept on purpose: readiness does not reject /search_result_ai, and the batch
  // reuses that bootstrap exactly like 0.4.14 (no extra search). If XHS itself redirects to
  // the AI route, the keyword's time-filter failure names the AI page instead.
  const harness = createBootstrapHarness({redirectToAi: true});
  const navigation = await harness.run();
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.updates[0].url, STANDARD_DEFAULT("安吉星"));
  assert.equal(navigation.initialSearchEvidence.ready, true);
  assert.equal(new URL(navigation.initialSearchEvidence.pageUrl).pathname, "/search_result_ai");
  assert.equal(harness.domChecks(), 0);
});

function createBatchHarness({applyFilters = null} = {}) {
  const captureCalls = [];
  const filterCalls = [];
  const navigationCalls = [];
  const settled = [];
  const tab = {id: 101, windowId: 7, groupId: 9, url: "https://www.xiaohongshu.com/search_result_ai?keyword=x"};
  const chrome = {
    tabs: {
      get: async () => ({...tab}),
      update: async (tabId, update = {}) => { Object.assign(tab, update); return {...tab}; },
      onReplaced: {addListener() {}, removeListener() {}},
    },
  };
  const context = {
    URL,
    BATCH_INTER_KEYWORD_DELAY_MAX_MS: 0,
    BATCH_INTER_KEYWORD_DELAY_MIN_MS: 0,
    BATCH_KEYWORD_AFTER_NAV_WAIT_MS: 0,
    BATCH_KEYWORD_EMPTY_RETRY_WAIT_MS: 0,
    DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE: "DOUYIN_SEARCH_SECURITY_CHALLENGE",
    DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE: "DOUYIN_SEARCH_SERVICE_ABNORMAL",
    Math,
    activateTabForReliableTimer: async () => {},
    buildInterKeywordDelayMessage: ({keyword}) => `next:${keyword}`,
    buildKeywordSearchUrl: buildSync,
    captureAndSaveInTab: async (options) => {
      captureCalls.push(options.captureParams.keyword);
      return {
        ok: true,
        captureResult: {ok: true, data: {items: [{id: `${options.captureParams.keyword}-item`}]}},
        recordIds: [`${options.captureParams.keyword}-record`],
        savedRecords: [],
      };
    },
    chrome,
    closeKeywordSearchFilterPanelInTab: async () => {},
    createCaptureRequestId: () => "list-run-test",
    formatEnhanceSkipReason: (reason) => reason || "",
    getCurrentActiveTab: async () => ({...tab}),
    hasActiveBatchSearchFilters: (filters) => Boolean(filters?.publishTime),
    assertNoDouyinSearchSecurityChallengeInTab: async () => {},
    isBatchCaptureCanceledError: (error) => ["BATCH_CAPTURE_CANCELED", "DETAIL_CAPTURE_CANCELED"].includes(String(error?.message || "")),
    isCaptureCanceledResult: (result) => Boolean(result?.canceled),
    isDouyinPlatform: (platform) => platform === "douyin",
    isXhsPublishTimeWindow,
    createXhsSearchTimeFilterError,
    isXhsSearchTimeFilterVerified,
    isDouyinSearchSecurityChallengeError: (error) => String(error?.code || "").toUpperCase() === "DOUYIN_SEARCH_SECURITY_CHALLENGE",
    isEmptyKeywordCaptureResult: (result) => Boolean(result?.ok && Array.isArray(result?.data?.items) && result.data.items.length === 0),
    isUnattendedSafetyBlock: (value) => Boolean(value?.securityBlocked || value?.platformSafetyBlocked),
    applySearchFiltersInTab: async (tabId, filters, applyOptions = {}) => {
      filterCalls.push({tabId, filters, applyOptions});
      if (typeof applyFilters === "function") return await applyFilters({call: filterCalls.length});
      return {
        applied: true,
        complete: true,
        results: [{field: "publishTime", value: filters.publishTime, applied: true, changed: true}],
        xhsTimeFilterEvidence: {verified: true, active: true, confirmedEmpty: false},
      };
    },
    beginDouyinSearchResultTransitionInTab: async () => null,
    navigateToSearchUrl: async (tabId, url) => { navigationCalls.push({tabId, url}); },
    normalizeUrlWithoutHash: (url) => String(url || "").split("#")[0],
    prepareDetailBatchRunnerContext: async () => ({runnerTabId: 101, sourceTabId: 101, shouldRestoreSourcePage: false, sourcePageUrl: ""}),
    setCaptureTaskTakeoverStateInTab: async () => {},
    submitKeywordSearchInTab: async () => { throw new Error("XHS must not resubmit"); },
    switchDouyinKeywordSearchInTab: async () => { throw new Error("not douyin"); },
    waitForKeywordSearchResultsInTab: async () => true,
    waitForDouyinSearchPacingWindow: async () => {},
    waitMsWithStop: async () => {},
    waitMsWithStopAndTick: async () => {},
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(
    `${slice(syncSource, "export async function batchCaptureByKeywords({", "export async function lightSampleByKeywords({").replace(/^export\s+/u, "")}\n${routeHelpersSource}\n${failureMessageSource}\nglobalThis.__runBatch = batchCaptureByKeywords;`,
    sandbox,
  );
  const run = ({keywords = ["词1"], baseSearchUrl = "https://www.xiaohongshu.com/search_result", initialSearchEvidence = null, searchFilters = null} = {}) =>
    sandbox.__runBatch({
      keywords,
      platform: "xiaohongshu",
      sourceTabId: 101,
      baseSearchUrl,
      onKeywordSettled: async (payload) => settled.push(payload),
      initialSearchEvidence,
      searchFilters,
      shouldStop: () => false,
    });
  return {captureCalls, filterCalls, navigationCalls, settled, run};
}

const bootstrapEvidence = (pageUrl) => ({
  ready: true,
  keyword: "词1",
  platform: "xiaohongshu",
  tabId: 101,
  ...(pageUrl === undefined ? {} : {pageUrl}),
});

test("a bootstrap is reused exactly once whatever route it reports, so no search is added", async () => {
  for (const pageUrl of [
    "https://www.xiaohongshu.com/search_result?keyword=%E8%AF%8D1&source=web_explore_feed",
    "https://www.xiaohongshu.com/search_result_ai?keyword=%E8%AF%8D1",
    undefined,
  ]) {
    const harness = createBatchHarness();
    const result = await harness.run({keywords: ["词1", "词2"], initialSearchEvidence: bootstrapEvidence(pageUrl)});
    assert.equal(result.ok, true);
    assert.equal(harness.navigationCalls.length, 1);
    assert.equal(new URL(harness.navigationCalls[0].url).searchParams.get("keyword"), "词2");
    assert.deepEqual(harness.captureCalls, ["词1", "词2"]);
  }
});

test("later automatic keywords leave an AI search base for the standard search route", async () => {
  const harness = createBatchHarness();
  await harness.run({
    keywords: ["词1", "词2"],
    baseSearchUrl: "https://www.xiaohongshu.com/search_result_ai?source=ai&type=9",
  });
  assert.deepEqual(harness.navigationCalls.map((call) => call.url), [STANDARD_DEFAULT("词1"), STANDARD_DEFAULT("词2")]);
});

function unverified(filterResult) {
  return createXhsSearchTimeFilterError(filterResult);
}

test("time-filter failure message names each known reason", () => {
  const cases = [
    [{reason: "content_message_failed", relayCode: "CONTENT_RELAY_TIMEOUT", relayMessage: "timeout"}, "（原因：页面脚本调用失败）"],
    [{reason: "content_message_failed", relayCode: "", relayMessage: ""}, "（原因：页面脚本调用失败）"],
    [{reason: "panel_not_opened", pageRoute: "search_result"}, "（原因：未找到筛选面板）"],
    [{reason: "not_search_page", pageRoute: "other"}, "（原因：当前不是搜索页）"],
    [{pageRoute: "search_result", xhsTimeFilterEvidence: {verified: false, active: false, reason: "time_option_unverified"}}, "（原因：时间选项未保持选中）"],
    [{pageRoute: "search_result", xhsTimeFilterEvidence: {verified: false, active: true, reason: "result_transition_unconfirmed", cardCount: 20, baselineCardCount: 20, elapsedMs: 8000, polls: 41}}, "（原因：筛选后结果未刷新；结果卡片 20/基线 20；等待 8 秒）"],
    [{pageRoute: "search_result", xhsTimeFilterEvidence: {verified: false, active: true, reason: "result_ids_changed", cardCount: 0, baselineCardCount: 12, elapsedMs: 3400}}, "（结果卡片 0/基线 12；等待 3.4 秒）"],
    [{reason: "panel_not_opened", pageRoute: "search_result_ai"}, "（原因：未找到筛选面板；页面：AI 搜索页）"],
    [{reason: "panel_not_opened", pageRoute: "other"}, "（原因：未找到筛选面板；页面：非标准搜索页）"],
  ];
  for (const [filterResult, suffix] of cases) {
    assert.equal(formatFailure(unverified(filterResult)), `${BASE_MESSAGE}${suffix}`);
  }
  assert.equal(
    formatFailure(unverified({reason: "panel_not_opened", pageRoute: "search_result_ai"})),
    "无法确认小红书时间筛选及结果刷新已生效，已跳过本关键词（原因：未找到筛选面板；页面：AI 搜索页）",
  );
});

test("time-filter failure message omits unknown or missing reasons and never shows relay codes", () => {
  assert.equal(formatFailure(unverified(null)), BASE_MESSAGE);
  assert.equal(formatFailure(unverified({reason: "something_new"})), BASE_MESSAGE);
  assert.equal(formatFailure(unverified({complete: false, results: []})), BASE_MESSAGE);
  for (const relayCode of RELAY_CODES) {
    assert.equal(
      formatFailure(unverified({reason: "content_message_failed", relayCode, relayMessage: `${relayCode} message`})),
      `${BASE_MESSAGE}（原因：页面脚本调用失败）`,
      relayCode,
    );
  }
});

test("time-filter failure message stays bounded and never rewrites other errors", () => {
  const noisy = unverified({
    reason: "content_message_failed",
    relayCode: "C".repeat(48),
    pageRoute: "search_result_ai",
    xhsTimeFilterEvidence: {cardCount: 1e9, baselineCardCount: -4, elapsedMs: 9e9},
  });
  const text = formatFailure(noisy);
  assert.ok(text.startsWith(`${BASE_MESSAGE}（原因：页面脚本调用失败；`));
  assert.doesNotMatch(text, /CCC/u);
  assert.ok(text.length <= 160, `${text.length}`);
  assert.match(text, /结果卡片 9999；等待 600 秒；页面：AI 搜索页）$/u);

  const longBase = unverified({reason: "panel_not_opened"});
  longBase.message = "长".repeat(170);
  assert.equal(formatFailure(longBase), "长".repeat(170));

  const other = new Error("  列表采集失败  ");
  other.code = "LIST_CAPTURE_FAILED";
  other.filterResult = {reason: "panel_not_opened"};
  assert.equal(formatFailure(other), "  列表采集失败  ");
  assert.equal(formatFailure({code: "XHS_SEARCH_TIME_FILTER_UNVERIFIED"}), undefined);
  assert.equal(formatFailure(null), undefined);
});

test("time-filter failure message does not change the error code or flags", () => {
  const error = unverified({reason: "panel_not_opened", pageRoute: "search_result_ai"});
  const before = {...error, message: error.message};
  formatFailure(error);
  assert.deepEqual({...error, message: error.message}, before);
  assert.equal(error.code, "XHS_SEARCH_TIME_FILTER_UNVERIFIED");
  assert.equal(error.category, "filter_verification");
  assert.equal(error.fatal, false);
  assert.equal(error.stopBatch, false);
  assert.equal(error.requiresManualAction, false);
  assert.equal(error.retryable, false);
  assert.equal(error.message, BASE_MESSAGE);
});

test("the reason suffix never changes how the admin console classifies a time-filter failure", () => {
  const admin = loadAdminFailureClassifiers();
  const kindOf = (message) => admin.kind({errorCode: "XHS_SEARCH_TIME_FILTER_UNVERIFIED", errorCategory: "filter_verification", error: message});
  const baseKind = kindOf(BASE_MESSAGE);
  assert.equal(baseKind, "other");
  assert.equal(admin.safety.test(BASE_MESSAGE), false);
  const filterResults = [
    ...RELAY_CODES.map((relayCode) => ({
      reason: "content_message_failed",
      relayCode,
      relayMessage: `${relayCode} timeout network required captcha 验证码`,
      pageRoute: "search_result_ai",
    })),
    {reason: "panel_not_opened", pageRoute: "search_result_ai"},
    {reason: "panel_not_opened", pageRoute: "other"},
    {reason: "not_search_page", pageRoute: "other"},
    {pageRoute: "search_result", xhsTimeFilterEvidence: {reason: "time_option_unverified"}},
    {pageRoute: "search_result", xhsTimeFilterEvidence: {reason: "result_transition_unconfirmed", cardCount: 20, baselineCardCount: 20, elapsedMs: 8000}},
  ];
  for (const filterResult of filterResults) {
    const message = formatFailure(unverified(filterResult));
    assert.notEqual(message, BASE_MESSAGE, JSON.stringify(filterResult));
    assert.equal(kindOf(message), baseKind, message);
    assert.equal(admin.safety.test(message), false, message);
    // Only fixed Chinese labels, numbers and the AI route name are appended:
    // no relay code or other ASCII word a text classifier could match.
    assert.doesNotMatch(message.slice(BASE_MESSAGE.length).replace(/AI 搜索页/gu, ""), /[A-Za-z]/u, message);
  }
});

test("the reason reaches the keyword result and the unattended checkpoint without changing its code or flags", async () => {
  const harness = createBatchHarness({
    applyFilters: async ({call}) => {
      if (call === 1) throw unverified({reason: "panel_not_opened", pageRoute: "search_result_ai"});
      return {
        applied: true,
        complete: true,
        results: [{field: "publishTime", value: "day", applied: true, changed: true}],
        xhsTimeFilterEvidence: {verified: true, active: true, confirmedEmpty: false},
      };
    },
  });
  const result = await harness.run({keywords: ["词1", "词2"], searchFilters: {publishTime: "day"}});
  const expected = `${BASE_MESSAGE}（原因：未找到筛选面板；页面：AI 搜索页）`;
  const failed = result.results[0];
  assert.equal(failed.ok, false);
  assert.equal(failed.error, expected);
  assert.equal(failed.errorCode, "XHS_SEARCH_TIME_FILTER_UNVERIFIED");
  assert.equal(failed.errorCategory, "filter_verification");
  assert.equal(failed.fatal, false);
  assert.equal(failed.securityBlocked, false);
  assert.equal(failed.requiresManualAction, false);
  assert.equal(result.fatal, false);
  assert.equal(result.securityBlocked, false);
  assert.equal(result.canceled, false);
  assert.deepEqual(harness.captureCalls, ["词2"]);
  assert.equal(harness.filterCalls.length, 2);
  assert.equal(harness.settled[0].result.error, expected);

  const {entry} = settleUnattendedKeywordCheckpoint({
    checkpoint: {},
    keywords: ["词1", "词2"],
    keyword: "词1",
    result: harness.settled[0].result,
    attempt: 2,
    maxAttempts: 2,
    now: new Date("2026-09-25T00:00:00Z"),
  });
  assert.equal(entry.error, expected);
  assert.equal(entry.errorCode, "XHS_SEARCH_TIME_FILTER_UNVERIFIED");
  assert.equal(entry.errorCategory, "filter_verification");
  assert.equal(entry.status, "failed");
  assert.equal(entry.securityBlocked, undefined);
  assert.equal(entry.requiresManualAction, undefined);
});

function filterRelay(sendMessage) {
  const context = vm.createContext({
    chrome: {runtime: {sendMessage}}, MESSAGE_TYPE: {RELAY_TO_CONTENT: "relay"},
    isXhsPublishTimeWindow, isXhsSearchTimeFilterVerified, createXhsSearchTimeFilterError, createXhsSecurityBlockError,
    assertNoDouyinSearchSecurityChallengeInTab: async () => {},
    isDouyinSearchServiceAbnormalError: (error) => error?.code === "DOUYIN_SEARCH_SERVICE_ABNORMAL",
    isDouyinSearchSecurityChallengeError: (error) => error?.code === "DOUYIN_SEARCH_SECURITY_CHALLENGE",
    createDouyinSearchServiceAbnormalError: (value) => value,
    createDouyinSearchSecurityChallengeError: (value) => value,
  });
  vm.runInContext(`${slice(syncSource, "function createSearchFilterApplicationError(", "function formatEnhanceSkipReason(")}\nglobalThis.run = applySearchFiltersInTab;`, context);
  return context.run;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected rejection");
}

function assertUnverifiedFlags(error) {
  assert.equal(error.code, "XHS_SEARCH_TIME_FILTER_UNVERIFIED");
  assert.equal(error.category, "filter_verification");
  assert.equal(error.fatal, false);
  assert.equal(error.stopBatch, false);
  assert.equal(error.requiresManualAction, false);
  assert.equal(error.retryable, false);
  assert.equal(error.message, BASE_MESSAGE);
}

test("relay, content and thrown failures keep the original code and a bounded message in filterResult", async () => {
  const relayFailure = await rejection(filterRelay(async () => ({ok: false, error: {code: "CONTENT_RELAY_TIMEOUT", message: "x".repeat(500)}}))(1, {publishTime: "day"}, {platform: "xiaohongshu"}));
  assertUnverifiedFlags(relayFailure);
  assert.deepEqual({...relayFailure.filterResult}, {reason: "content_message_failed", relayCode: "CONTENT_RELAY_TIMEOUT", relayMessage: "x".repeat(200)});

  const contentFailure = await rejection(filterRelay(async () => ({ok: true, data: {ok: false, error: {code: "APPLY_FILTER_FAILED", message: "应用搜索筛选失败"}}}))(1, {publishTime: "day"}, {platform: "xiaohongshu"}));
  assertUnverifiedFlags(contentFailure);
  assert.deepEqual({...contentFailure.filterResult}, {reason: "content_message_failed", relayCode: "APPLY_FILTER_FAILED", relayMessage: "应用搜索筛选失败"});

  const thrown = new Error("Could not establish connection. Receiving end does not exist.");
  thrown.code = "ERR_NO_RECEIVER";
  const thrownFailure = await rejection(filterRelay(async () => { throw thrown; })(1, {publishTime: "day"}, {platform: "xiaohongshu"}));
  assertUnverifiedFlags(thrownFailure);
  assert.deepEqual({...thrownFailure.filterResult}, {reason: "content_message_failed", relayCode: "ERR_NO_RECEIVER", relayMessage: thrown.message});

  const emptyFailure = await rejection(filterRelay(async () => undefined)(1, {publishTime: "day"}, {platform: "xiaohongshu"}));
  assertUnverifiedFlags(emptyFailure);
  assert.deepEqual({...emptyFailure.filterResult}, {reason: "content_message_failed", relayCode: "", relayMessage: ""});
  assert.equal(formatFailure(emptyFailure), `${BASE_MESSAGE}（原因：页面脚本调用失败）`);
  assert.equal(formatFailure(relayFailure), `${BASE_MESSAGE}（原因：页面脚本调用失败）`);

  const panel = {applied: false, complete: false, reason: "panel_not_opened", results: [{field: "publishTime", value: "day", applied: false}], pageRoute: "search_result_ai"};
  const panelFailure = await rejection(filterRelay(async () => ({ok: true, data: {ok: true, data: panel}}))(1, {publishTime: "day"}, {platform: "xiaohongshu"}));
  assertUnverifiedFlags(panelFailure);
  assert.equal(panelFailure.filterResult.pageRoute, "search_result_ai");
  assert.equal(formatFailure(panelFailure), `${BASE_MESSAGE}（原因：未找到筛选面板；页面：AI 搜索页）`);
});

test("confirmed XHS security evidence and non-XHS filters are still handled exactly as before", async () => {
  const securityError = createXhsSecurityBlockError({confirmed: true, reason: "rate_limit", variant: "cn_rate_limit_300013", language: "zh-CN"});
  const security = await rejection(filterRelay(async () => ({ok: true, data: {ok: false, error: securityError}}))(1, {publishTime: "day"}, {platform: "xiaohongshu"}));
  assert.equal(security.code, "XHS_SECURITY_BLOCK");
  assert.equal(security.securityBlocked, true);
  const failed = filterRelay(async () => { throw new Error("disconnected"); });
  assert.equal(await failed(1, {publishTime: "all"}, {platform: "xiaohongshu"}), null);
  assert.equal(await failed(1, {publishTime: "day"}, {platform: "douyin"}), null);
});

function runContentFilters({href, pathname, opened = true, pageType = "search_results", options = {publishTime: "day", verifyXhsTimeFilter: true}}) {
  const location = pathname === undefined ? {href} : {href, pathname};
  const context = vm.createContext({
    window: {location},
    detectPageType: () => pageType, isXhsPublishTimeWindow,
    assertNoDouyinSearchSecurityChallengePage() {}, assertNoDouyinSearchServiceAbnormalPage() {},
    assertNoXhsSearchFilterSecurityPage() {},
    shouldApplyBatchFilter: (value, defaultValue) => Boolean(value && value !== defaultValue && value !== "all"),
    ensureKeywordStrategyFilterPanelOpen: async () => opened,
    isBatchFilterOptionActive: () => true,
    applyBatchFilterOption: async () => true,
    closeKeywordStrategyFilterPanel: async () => true,
    waitForKeywordStrategyUi: async () => {},
    beginXhsSearchFilterEvidence: () => ({waitForSettled: async () => ({verified: true}), disconnect() {}}),
  });
  const constants = slice(contentSource, "const BATCH_SORT_LABELS", "async function handleApplyBatchSearchFilters");
  const fn = slice(contentSource, "async function applyBatchSearchFilters(", "async function prepareKeywordStrategyCapture(");
  vm.runInContext(`${constants}\n${fn}\nglobalThis.run = applyBatchSearchFilters;`, context);
  return context.run(options);
}

test("content filter results report only a sanitized route kind", async () => {
  const ai = await runContentFilters({href: "https://www.xiaohongshu.com/search_result_ai?keyword=%E7%A7%98%E5%AF%86", pathname: "/search_result_ai", opened: false});
  assert.equal(ai.reason, "panel_not_opened");
  assert.equal(ai.pageRoute, "search_result_ai");
  const fromHref = await runContentFilters({href: "https://www.xiaohongshu.com/search_result_ai/?keyword=x", opened: false});
  assert.equal(fromHref.pageRoute, "search_result_ai");
  const standard = await runContentFilters({href: "https://www.xiaohongshu.com/search_result?keyword=x", pathname: "/search_result"});
  assert.equal(standard.pageRoute, "search_result");
  assert.equal(standard.xhsTimeFilterEvidence.active, true);
  const notSearch = await runContentFilters({href: "https://www.xiaohongshu.com/explore", pathname: "/explore", pageType: "discovery"});
  assert.equal(notSearch.reason, "not_search_page");
  assert.equal(notSearch.pageRoute, "other");
  const noFilter = await runContentFilters({href: "https://www.xiaohongshu.com/search_result?keyword=x", pathname: "/search_result", options: {}});
  assert.equal(noFilter.reason, "no_filter");
  assert.equal(noFilter.pageRoute, "search_result");
  for (const result of [ai, fromHref, standard, notSearch, noFilter]) {
    assert.ok(["search_result", "search_result_ai", "other"].includes(result.pageRoute));
  }
});
