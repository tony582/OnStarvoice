import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);
const contentSource = await readFile(
  new URL("../../content-v2.js", import.meta.url),
  "utf8",
);
const douyinKeywordSearchSource = await readFile(
  new URL(
    "../../utils/capture/douyin-keyword-search.js",
    import.meta.url,
  ),
  "utf8",
);

function readBatchFunctionSource() {
  const startMarker = "export async function batchCaptureByKeywords({";
  const endMarker = "export async function lightSampleByKeywords({";
  const start = captureSyncSource.indexOf(startMarker);
  const end = captureSyncSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, "batch keyword function start marker missing");
  assert.notEqual(end, -1, "batch keyword function end marker missing");
  return captureSyncSource.slice(start, end).replace(/^export\s+/u, "");
}

function readKeywordSearchPageUrlInspectorSource() {
  const startMarker = "function inspectKeywordSearchPageUrl(";
  const endMarker = "async function waitForKeywordSearchResultsInTab(";
  const start = captureSyncSource.indexOf(startMarker);
  const end = captureSyncSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, "keyword search URL inspector start marker missing");
  assert.notEqual(end, -1, "keyword search URL inspector end marker missing");
  return captureSyncSource.slice(start, end);
}

function inspectKeywordSearchPageUrl(pageUrl, platform, keyword) {
  const sandbox = vm.createContext({URL});
  vm.runInContext(
    `${readKeywordSearchPageUrlInspectorSource()}\nglobalThis.__inspect = inspectKeywordSearchPageUrl;`,
    sandbox,
  );
  return sandbox.__inspect(pageUrl, platform, keyword);
}

test("Douyin result readiness keeps waiting for a slow result page by default", () => {
  const start = captureSyncSource.indexOf(
    "async function waitForKeywordSearchResultsInTab(",
  );
  const end = captureSyncSource.indexOf(
    "async function closeKeywordSearchFilterPanelInTab(",
    start,
  );
  const block = captureSyncSource.slice(start, end);
  assert.ok(start >= 0);
  assert.match(
    captureSyncSource,
    /DOUYIN_KEYWORD_RESULTS_READY_TIMEOUT_MS = 45000/u,
  );
  assert.match(block, /timeoutMs = null/u);
  assert.match(
    block,
    /String\(platform \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'douyin'[\s\S]*?DOUYIN_KEYWORD_RESULTS_READY_TIMEOUT_MS/u,
  );
  assert.match(
    block,
    /hasExplicitTimeout \? Number\(timeoutMs\) \|\| 0 : defaultTimeout/u,
    "tests and callers may still request an explicit bounded timeout",
  );
});

function createBatchHarness({
  captureKeyword,
  afterKeywordCapture = null,
  switchDouyinKeyword = null,
  waitForResults = null,
  hasActiveFilters = false,
  assertNoSecurityChallenge = null,
} = {}) {
  const captureCalls = [];
  const filterCalls = [];
  const navigationCalls = [];
  const submitCalls = [];
  const settled = [];
  const progress = [];
  const pacingCalls = [];
  const liveTabs = new Map([
    [101, {id: 101, windowId: 7, groupId: 9, url: "https://www.xiaohongshu.com/search_result"}],
  ]);
  const replacementListeners = new Set();

  const chrome = {
    tabs: {
      get: async (tabId) => {
        const tab = liveTabs.get(Number(tabId));
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return {...tab};
      },
      update: async (tabId, update = {}) => {
        const tab = liveTabs.get(Number(tabId));
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        Object.assign(tab, update);
        return {...tab};
      },
      onReplaced: {
        addListener(listener) {
          replacementListeners.add(listener);
        },
        removeListener(listener) {
          replacementListeners.delete(listener);
        },
      },
    },
  };

  const replaceRunnerTab = (addedTabId, removedTabId) => {
    const removed = liveTabs.get(Number(removedTabId));
    liveTabs.delete(Number(removedTabId));
    liveTabs.set(Number(addedTabId), {
      ...(removed || {}),
      id: Number(addedTabId),
    });
    for (const listener of replacementListeners) {
      listener(Number(addedTabId), Number(removedTabId));
    }
  };

  const context = {
    BATCH_INTER_KEYWORD_DELAY_MAX_MS: 0,
    BATCH_INTER_KEYWORD_DELAY_MIN_MS: 0,
    BATCH_KEYWORD_AFTER_NAV_WAIT_MS: 0,
    BATCH_KEYWORD_EMPTY_RETRY_WAIT_MS: 0,
    DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE:
      "DOUYIN_SEARCH_SECURITY_CHALLENGE",
    Math,
    activateTabForReliableTimer: async () => {},
    buildInterKeywordDelayMessage: ({keyword}) => `next:${keyword}`,
    buildKeywordSearchUrl: (keyword, platform) =>
      platform === "douyin"
        ? `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`
        : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
    captureAndSaveInTab: async (options) => {
      captureCalls.push({
        keyword: options.captureParams.keyword,
        tabId: options.tabId,
      });
      return await captureKeyword(options, captureCalls.length);
    },
    chrome,
    closeKeywordSearchFilterPanelInTab: async () => {},
    createCaptureRequestId: () => "list-run-test",
    formatEnhanceSkipReason: (reason) => reason || "",
    getCurrentActiveTab: async () => liveTabs.get(101),
    hasActiveBatchSearchFilters: () => hasActiveFilters,
    assertNoDouyinSearchSecurityChallengeInTab: async (tabId) => {
      if (typeof assertNoSecurityChallenge === "function") {
        await assertNoSecurityChallenge({tabId});
      }
    },
    isBatchCaptureCanceledError: (error) =>
      ["BATCH_CAPTURE_CANCELED", "DETAIL_CAPTURE_CANCELED"].includes(
        String(error?.message || ""),
      ),
    isCaptureCanceledResult: (result) =>
      Boolean(
        result?.canceled ||
          ["CAPTURE_CANCELED", "BATCH_CAPTURE_CANCELED"].includes(
            String(result?.error?.code || ""),
          ),
      ),
    isDouyinPlatform: (platform) => platform === "douyin",
    isDouyinSearchSecurityChallengeError: (error) =>
      String(error?.code || "").toUpperCase() ===
      "DOUYIN_SEARCH_SECURITY_CHALLENGE",
    isEmptyKeywordCaptureResult: (result) =>
      Boolean(result?.ok && Array.isArray(result?.data?.items) && result.data.items.length === 0),
    isUnattendedSafetyBlock: (value) =>
      Boolean(
        value?.securityBlocked ||
          value?.platformSafetyBlocked,
      ),
    applySearchFiltersInTab: async (tabId, filters, applyOptions = {}) => {
      filterCalls.push({tabId, filters, applyOptions});
      return {applied: true};
    },
    navigateToSearchUrl: async (tabId, url) => {
      navigationCalls.push({tabId, url});
    },
    normalizeUrlWithoutHash: (url) => String(url || "").split("#")[0],
    prepareDetailBatchRunnerContext: async () => ({
      runnerTabId: 101,
      sourceTabId: 101,
      shouldRestoreSourcePage: false,
      sourcePageUrl: "",
    }),
    setCaptureTaskTakeoverStateInTab: async () => {},
    submitKeywordSearchInTab: async (tabId, platform, keyword) => {
      submitCalls.push({tabId, platform, keyword});
    },
    switchDouyinKeywordSearchInTab: async (tabId, keyword, url) => {
      navigationCalls.push({tabId, keyword, url, platform: "douyin"});
      if (typeof switchDouyinKeyword === "function") {
        await switchDouyinKeyword({tabId, keyword, url});
      }
    },
    waitForKeywordSearchResultsInTab: async (tabId, platform, shouldStop, options) =>
      typeof waitForResults === "function"
        ? await waitForResults({tabId, platform, shouldStop, ...(options || {})})
        : true,
    waitForDouyinSearchPacingWindow: async (tabId, shouldStop, options = {}) => {
      pacingCalls.push({tabId, phase: options.phase || "search"});
    },
    waitMsWithStop: async () => {},
    waitMsWithStopAndTick: async () => {},
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(
    `${readBatchFunctionSource()}\nglobalThis.__runBatch = batchCaptureByKeywords;`,
    sandbox,
  );

  const run = (options = {}) =>
    sandbox.__runBatch({
      keywords: options.keywords || [],
      platform: options.platform || "xiaohongshu",
      sourceTabId: 101,
      baseSearchUrl: "https://www.xiaohongshu.com/search_result",
      afterKeywordCapture: options.afterKeywordCapture ?? afterKeywordCapture,
      onKeywordSettled: async (payload) => settled.push(payload),
      onProgress: (payload) => progress.push(payload),
      searchFilters: options.searchFilters || null,
      disableAutomaticSearchRetry:
        options.disableAutomaticSearchRetry === true,
      requireVerifiedFilters: options.requireVerifiedFilters === true,
      shouldStop: options.shouldStop || (() => false),
    });

  return {
    captureCalls,
    filterCalls,
    navigationCalls,
    pacingCalls,
    progress,
    getReplacementListenerCount: () => replacementListeners.size,
    replaceRunnerTab,
    run,
    settled,
    submitCalls,
  };
}

function successCapture(keyword) {
  return {
    ok: true,
    captureResult: {ok: true, data: {items: [{id: `${keyword}-item`}]}},
    recordIds: [`${keyword}-record`],
    savedRecords: [],
  };
}

test("Douyin restores a paced settle window after search and filtering", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    hasActiveFilters: true,
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1"],
    searchFilters: {sort: "latest", publishTime: "day"},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    harness.pacingCalls.map((entry) => entry.phase),
    ["search", "filter"],
  );
});

test("one empty keyword retry does not truncate the remaining 12 keyword plan", async () => {
  const attempts = new Map();
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => {
      const keyword = captureParams.keyword;
      const attempt = (attempts.get(keyword) || 0) + 1;
      attempts.set(keyword, attempt);
      if (keyword === "词1") {
        return {
          ok: true,
          captureResult: {ok: true, data: {items: []}},
          recordIds: [],
          savedRecords: [],
        };
      }
      return successCapture(keyword);
    },
  });
  const keywords = Array.from({length: 13}, (_, index) => `词${index + 1}`);

  const result = await harness.run({keywords});

  assert.equal(attempts.get("词1"), 2, "the empty first keyword must retry exactly once");
  assert.equal(result.stats.total, 13);
  assert.equal(result.stats.processed, 13);
  assert.equal(result.results.length, 13);
  assert.equal(result.results[0].ok, false);
  assert.equal(
    Array.from(result.results.slice(1), (item) => item.keyword).join("\n"),
    keywords.slice(1).join("\n"),
  );
  assert.equal(harness.settled.length, 13, "every keyword must reach the checkpoint reporter");
  assert.equal(result.canceled, false);
});

test("a strict sequential patrol never repeats an empty search and still settles later keywords", async () => {
  const attempts = new Map();
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => {
      const keyword = captureParams.keyword;
      attempts.set(keyword, (attempts.get(keyword) || 0) + 1);
      if (keyword === "词1") {
        return {
          ok: true,
          captureResult: {ok: true, data: {items: []}},
          recordIds: [],
          savedRecords: [],
        };
      }
      return successCapture(keyword);
    },
    hasActiveFilters: true,
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
    searchFilters: {contentType: "image"},
    disableAutomaticSearchRetry: true,
    requireVerifiedFilters: true,
  });

  assert.equal(attempts.get("词1"), 1);
  assert.equal(attempts.get("词2"), 1);
  assert.equal(harness.submitCalls.length, 0, "no hidden search submit is allowed");
  assert.equal(harness.filterCalls.length, 2);
  assert.ok(harness.filterCalls.every(call =>
    call.applyOptions.requireVerifiedFilters === true));
  assert.equal(result.stats.processed, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.canceled, false);
});

test("verified sequential-patrol filters fail closed instead of falling through to capture", () => {
  const filterStart = captureSyncSource.indexOf(
    "function createSearchFilterApplicationError(",
  );
  const filterEnd = captureSyncSource.indexOf(
    "async function waitForKeywordSearchResultsInTab(",
    filterStart,
  );
  const filterSource = captureSyncSource.slice(filterStart, filterEnd);

  assert.match(filterSource, /SEARCH_FILTER_APPLICATION_FAILED/u);
  assert.match(filterSource, /error\.fatal = true/u);
  assert.match(filterSource, /error\.stopBatch = true/u);
  assert.match(filterSource, /error\.requiresManualAction = true/u);
  assert.match(filterSource, /result\?\.complete !== true/u);
  assert.match(captureSyncSource, /verifyDefaults: requireVerifiedFilters/u);
  assert.match(contentSource, /verifyDefaults: request\?\.verifyDefaults === true/u);
  assert.match(contentSource, /verifyDefaults[\s\S]*item\.platforms\.includes\(platform\)/u);
  assert.match(contentSource, /const alreadyActive = isBatchFilterOptionActive/u);
  assert.match(contentSource, /changed: ok && !alreadyActive/u);
});

test("a drifted Douyin search page fails only the current keyword and continues", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    waitForResults: async ({keyword}) => keyword !== "词1",
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
  });

  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词2"],
    "a stale /jingxuan page must never be captured as the failed keyword",
  );
  assert.equal(result.canceled, false);
  assert.equal(result.stats.processed, 2);
  assert.equal(result.stats.success, 1);
  assert.equal(result.stats.failed, 1);
  assert.equal(harness.settled.length, 2);
  assert.equal(harness.settled[0].keyword, "词1");
  assert.equal(harness.settled[0].result.ok, false);
  assert.equal(harness.settled[1].keyword, "词2");
  assert.equal(harness.settled[1].result.ok, true);
});

test("a confirmed empty Douyin result settles as a successful zero-result keyword", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    waitForResults: async ({keyword}) =>
      keyword === "词1"
        ? {
            ready: false,
            confirmedEmpty: true,
            emptyMessage: "暂无相关内容",
            pageUrl: "https://www.douyin.com/search/%E8%AF%8D1?type=general",
          }
        : {ready: true, confirmedEmpty: false},
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.canceled, false);
  assert.equal(result.stats.success, 2);
  assert.equal(result.stats.failed, 0);
  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词2"],
    "an explicitly empty keyword must not enter list capture",
  );
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].noResults, true);
  assert.equal(result.results[0].resultKind, "no_matching_results");
  assert.equal(harness.settled[0].result.noResults, true);
  assert.equal(
    harness.progress.some(
      (entry) =>
        entry.keyword === "词1" &&
        entry.phase === "no_matching_results",
    ),
    true,
  );
});

test("Douyin service-abnormal state fails the current keyword and continues the next", async () => {
  let readinessChecks = 0;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    hasActiveFilters: true,
    waitForResults: async () => {
      readinessChecks += 1;
      if (readinessChecks === 2) {
        const error = new Error(
          "抖音当前关键词搜索暂时不可用，已结束本词并继续下一个关键词",
        );
        error.code = "DOUYIN_SEARCH_SERVICE_ABNORMAL";
        error.category = "platform_service_abnormal";
        error.retryable = true;
        throw error;
      }
      return true;
    },
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
    searchFilters: {sort: "latest", publishTime: "day"},
  });

  assert.equal(result.canceled, false);
  assert.equal(result.securityBlocked, false);
  assert.equal(result.requiresManualAction, false);
  assert.equal(result.blockingError, null);
  assert.deepEqual(
    harness.captureCalls.map((entry) => entry.keyword),
    ["词2"],
  );
  assert.equal(harness.filterCalls.length, 2);
  assert.equal(
    harness.submitCalls.length,
    0,
    "the service-abnormal word must fail before the generic filter retry path",
  );
  assert.deepEqual(
    harness.navigationCalls.map((entry) => entry.keyword),
    ["词1", "词2"],
    "the second keyword must start after the first search request fails",
  );
  assert.equal(harness.settled.length, 2);
  assert.equal(harness.settled[0].keyword, "词1");
  assert.equal(harness.settled[0].securityBlocked, false);
  assert.equal(
    harness.settled[0].result.errorCode,
    "DOUYIN_SEARCH_SERVICE_ABNORMAL",
  );
  assert.equal(harness.settled[1].keyword, "词2");
  assert.equal(harness.settled[1].result.ok, true);
  assert.equal(result.stats.success, 1);
  assert.equal(result.stats.failed, 1);
  assert.equal(harness.progress.at(-1)?.phase, "done");
});

test("Douyin security challenge stops the whole keyword batch for human action", async () => {
  let readinessChecks = 0;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    waitForResults: async () => {
      readinessChecks += 1;
      if (readinessChecks === 1) {
        const error = new Error(
          "检测到抖音图片安全验证，已停止后续搜索并保留已发现结果",
        );
        error.code = "DOUYIN_SEARCH_SECURITY_CHALLENGE";
        error.category = "platform_safety_block";
        error.securityBlocked = true;
        error.platformSafetyBlocked = true;
        error.requiresManualAction = true;
        error.stopBatch = true;
        error.fatal = true;
        error.retryable = false;
        throw error;
      }
      return true;
    },
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
  });

  assert.equal(result.canceled, true);
  assert.equal(result.securityBlocked, true);
  assert.equal(result.platformSafetyBlocked, true);
  assert.equal(result.requiresManualAction, true);
  assert.equal(
    result.blockingError?.code,
    "DOUYIN_SEARCH_SECURITY_CHALLENGE",
  );
  assert.deepEqual(harness.captureCalls, []);
  assert.deepEqual(
    harness.navigationCalls.map((entry) => entry.keyword),
    ["词1"],
  );
  assert.equal(harness.settled.length, 1);
  assert.equal(harness.progress.at(-1)?.phase, "needs_action");
});

test("a challenge appearing during the safety delay preserves the settled keyword and never searches the next", async () => {
  let safetyChecks = 0;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) =>
      successCapture(captureParams.keyword),
    assertNoSecurityChallenge: async () => {
      safetyChecks += 1;
      if (safetyChecks === 2) {
        const error = new Error(
          "检测到抖音图片安全验证，已停止后续搜索并保留已发现结果",
        );
        error.code = "DOUYIN_SEARCH_SECURITY_CHALLENGE";
        error.category = "platform_safety_block";
        error.securityBlocked = true;
        error.platformSafetyBlocked = true;
        error.requiresManualAction = true;
        error.stopBatch = true;
        error.fatal = true;
        error.retryable = false;
        throw error;
      }
    },
  });

  const result = await harness.run({
    platform: "douyin",
    keywords: ["词1", "词2"],
  });

  assert.equal(result.canceled, true);
  assert.equal(result.securityBlocked, true);
  assert.equal(result.stats.success, 1);
  assert.equal(result.stats.failed, 0);
  assert.deepEqual(
    harness.captureCalls.map((entry) => entry.keyword),
    ["词1"],
  );
  assert.deepEqual(
    harness.navigationCalls.map((entry) => entry.keyword),
    ["词1"],
  );
  assert.equal(harness.settled.length, 1);
  assert.equal(harness.settled[0].result.ok, true);
});

test("a blocked list capture persists its partial payload before returning the safety error", () => {
  const start = captureSyncSource.indexOf(
    "async function captureAndSaveInTab({",
  );
  const end = captureSyncSource.indexOf(
    "async function captureBatchByUrls(",
    start,
  );
  const source = captureSyncSource.slice(start, end);
  assert.match(
    source,
    /captureResult\?\.partial === true[\s\S]*saveCaptureResultRecords[\s\S]*recordIds: partialRecordIds/u,
  );
});

test("a challenge race harvests only same-keyword mounted links before returning the partial result", () => {
  assert.match(
    douyinKeywordSearchSource,
    /const preserveMountedResultsAfterSecurityChallenge = \(\) => \{[\s\S]*!mountedKeyword[\s\S]*mountedKeyword !== expectedKeyword[\s\S]*extractDouyinSearchCards\(searchRoot\)[\s\S]*recoveredFromMountedResults: true/u,
  );
  assert.match(
    douyinKeywordSearchSource,
    /if \(securityChallenge\) \{\s*try \{\s*preserveMountedResultsAfterSecurityChallenge\(\);[\s\S]*Preservation is best-effort[\s\S]*\}[\s]*\}[\s\S]*const partialPayload/u,
  );
  assert.match(
    douyinKeywordSearchSource,
    /if \(outcome\?\.error\) \{[\s\S]*Safety must win the race[\s\S]*assertNoSecurityChallenge\(\);[\s\S]*throw outcome\.error;/u,
  );
});

test("Douyin checks the service-abnormal guard before clicking search or filters", () => {
  const submitStart = captureSyncSource.indexOf(
    "async function submitKeywordSearchInTab(",
  );
  const submitEnd = captureSyncSource.indexOf(
    "async function switchDouyinKeywordSearchInTab(",
    submitStart,
  );
  const submitSource = captureSyncSource.slice(submitStart, submitEnd);
  const guardIndex = submitSource.indexOf(
    "action: 'assertNoDouyinSearchServiceAbnormal'",
  );
  const clickScriptIndex = submitSource.indexOf(
    "const result = await chrome.scripting",
  );
  assert.ok(guardIndex > -1);
  assert.ok(clickScriptIndex > guardIndex);

  assert.match(
    contentSource,
    /case "assertNoDouyinSearchServiceAbnormal":[\s\S]*handleAssertNoDouyinSearchServiceAbnormal/u,
  );
  assert.match(
    contentSource,
    /function handleAssertNoDouyinSearchServiceAbnormal[\s\S]*assertNoDouyinSearchSecurityChallengePage\(\);[\s\S]*assertNoDouyinSearchServiceAbnormalPage\(\);/u,
  );
  assert.match(
    submitSource,
    /isDouyinSearchSecurityChallengeError\(guardError\)[\s\S]*createDouyinSearchSecurityChallengeError/u,
  );
  const filterStart = contentSource.indexOf(
    "async function applyBatchSearchFilters({",
  );
  const filterEnd = contentSource.indexOf(
    "async function prepareKeywordStrategyCapture()",
    filterStart,
  );
  const filterSource = contentSource.slice(filterStart, filterEnd);
  const filterGuardIndex = filterSource.indexOf(
    "assertNoDouyinSearchServiceAbnormalPage();",
  );
  const filterRequestsIndex = filterSource.indexOf("const filterRequests =");
  assert.ok(filterGuardIndex > -1);
  assert.ok(filterRequestsIndex > filterGuardIndex);

  assert.match(
    captureSyncSource,
    /async function waitForKeywordSearchTargetReadyInTab[\s\S]*isDouyinPlatform\(navigationContext\?\.platform\)[\s\S]*assertNoDouyinSearchSecurityChallengeInTab\(tabId\)[\s\S]*isKeywordSearchTargetReadyInTab/u,
  );
});

test("Douyin readiness rejects recommendation, detail, modal, and another keyword URLs", () => {
  assert.deepEqual(
    {...inspectKeywordSearchPageUrl(
      "https://www.douyin.com/search/%E5%87%AF%E8%BF%AA%E6%8B%89%E5%85%8B?type=general",
      "douyin",
      "凯迪拉克",
    )},
    {searchPathReady: true, keywordConflict: false},
  );
  assert.deepEqual(
    {...inspectKeywordSearchPageUrl(
      "https://www.douyin.com/jingxuan",
      "douyin",
      "凯迪拉克",
    )},
    {searchPathReady: false, keywordConflict: false},
  );
  assert.equal(
    inspectKeywordSearchPageUrl(
      "https://www.douyin.com/search/%E5%87%AF%E8%BF%AA%E6%8B%89%E5%85%8B?modal_id=123",
      "douyin",
      "凯迪拉克",
    ).searchPathReady,
    false,
  );
  assert.equal(
    inspectKeywordSearchPageUrl(
      "https://www.douyin.com/video/123",
      "douyin",
      "凯迪拉克",
    ).searchPathReady,
    false,
  );
  assert.deepEqual(
    {...inspectKeywordSearchPageUrl(
      "https://www.douyin.com/search/%E5%88%AB%E5%85%8B?type=general",
      "douyin",
      "凯迪拉克",
    )},
    {searchPathReady: true, keywordConflict: true},
  );
});

test("the Douyin fail-closed guard does not make XHS slow readiness fail early", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    waitForResults: async () => false,
  });

  const result = await harness.run({
    platform: "xiaohongshu",
    keywords: ["词1"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1"],
  );
});

test("Douyin filter reapply must prove results are ready before recapture", () => {
  assert.match(
    readBatchFunctionSource(),
    /const refilteredResultsReady =[\s\S]*?if \(!refilteredResultsReady\) \{[\s\S]*?重挂筛选后搜索结果页仍未就绪/,
  );
});

test("keyword three uses the replacement runner tab id after keyword two", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current}) => {
      if (current === 2) harness.replaceRunnerTab(202, 101);
      return {ok: true};
    },
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.equal(result.ok, true);
  assert.deepEqual(
    harness.captureCalls.map((call) => call.tabId),
    [101, 101, 202],
  );
  assert.equal(harness.settled[2].runnerTabId, 202);
});

test("non-user detail cancellation marks the keyword partial and continues", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current}) =>
      current === 1
        ? {
            ok: false,
            canceled: true,
            runnerInterrupted: true,
            error: {code: "RUNNER_TAB_UNAVAILABLE", message: "temporary runner lost"},
          }
        : {ok: true},
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1", "词2", "词3"],
  );
  assert.equal(result.canceled, false);
  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].canceled, false);
  assert.equal(harness.settled[0].canceled, false);
});

test("nonempty keyword records cannot silently settle an anomalous no-target enhancement skip", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current, recordIds}) =>
      current === 1
        ? {
            skipped: true,
            reason: "no_target_records",
          }
        : {
            ok: true,
            canceled: false,
            successCount: recordIds.length,
            failedCount: 0,
            results: recordIds.map((recordId) => ({recordId, ok: true})),
          },
  });

  const result = await harness.run({keywords: ["词1", "词2"]});

  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1", "词2"],
    "a defensive partial settlement must not truncate the remaining plan",
  );
  assert.equal(result.results[0].enhanceStatus, "failed");
  assert.equal(result.results[0].partial, true);
  assert.equal(harness.settled[0].result.partial, true);
  assert.equal(result.results[1].enhanceStatus, "done");
  assert.equal(
    harness.progress.some(
      (entry) => entry.keyword === "词1" && entry.phase === "enhance_skipped",
    ),
    false,
    "a nonempty explicit batch must not be reported as an ordinary skip",
  );
});

test("runner interruption without canceled flag is checkpointed and continues to the next keyword", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current}) =>
      current === 1
        ? {
            ok: false,
            canceled: false,
            runnerInterrupted: true,
            results: [
              {
                recordId: "词1-record",
                ok: false,
                reason: "CONTEXT_INTERRUPTED",
                category: "context_interrupted",
                runnerInterrupted: true,
              },
            ],
          }
        : {ok: true},
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1", "词2", "词3"],
  );
  assert.equal(result.canceled, false);
  assert.equal(result.recoveryRequired, false);
  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].enhanceStatus, "failed");
  assert.equal(result.results[0].enhanceResult.runnerInterrupted, true);
  assert.equal(harness.settled.length, 3);
  assert.equal(harness.settled[0].canceled, false);
  assert.equal(harness.progress.at(-1)?.phase, "done");
});

test("an explicit user stop still terminates the keyword plan", async () => {
  let stopped = false;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async () => {
      stopped = true;
      return {ok: false, canceled: true, userCanceled: true};
    },
  });

  const result = await harness.run({
    keywords: ["词1", "词2", "词3"],
    shouldStop: () => stopped,
  });

  assert.equal(result.canceled, true);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1"]);
});

test("an explicit fatal detail failure stops after the current keyword", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async () => ({
      ok: false,
      fatal: true,
      error: {code: "FATAL_CAPTURE_STATE", message: "identity contract lost"},
    }),
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.equal(result.canceled, false);
  assert.equal(result.fatal, true);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1"]);
  assert.equal(result.results[0].partial, true);
});

test("a thrown non-user detail cancellation is checkpointed and the plan continues", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async ({current}) => {
      if (current === 1) throw new Error("DETAIL_CAPTURE_CANCELED");
      return {ok: true};
    },
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.equal(result.canceled, false);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1", "词2", "词3"]);
  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].recoverableInterruption, true);
  assert.equal(harness.settled[0].canceled, false);
});

test("an explicit fatal list capture failure stops after its checkpoint", async () => {
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => ({
      ok: false,
      captureResult: {
        ok: false,
        error: {code: "FATAL_WORK_IDENTITY", message: "work identity contract lost"},
      },
      recordIds: [],
      error: {code: "FATAL_WORK_IDENTITY", message: "work identity contract lost"},
    }),
  });

  const result = await harness.run({keywords: ["词1", "词2", "词3"]});

  assert.equal(result.canceled, false);
  assert.equal(result.fatal, true);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1"]);
  assert.equal(result.results[0].fatal, true);
  assert.equal(harness.settled.length, 1);
});

test("runner loss with an invalidated stop predicate requests checkpoint recovery, not user cancel", async () => {
  let runnerLost = false;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => successCapture(captureParams.keyword),
    afterKeywordCapture: async () => {
      runnerLost = true;
      return {
        ok: false,
        canceled: true,
        runnerInterrupted: true,
        error: {code: "RUNNER_TAB_UNAVAILABLE", message: "runner replaced mid-detail"},
      };
    },
  });

  const result = await harness.run({
    keywords: ["词1", "词2", "词3"],
    shouldStop: () => runnerLost,
  });

  assert.equal(result.canceled, false);
  assert.equal(result.recoveryRequired, true);
  assert.deepEqual(harness.captureCalls.map((call) => call.keyword), ["词1"]);
  assert.equal(result.results[0].recoveryRequired, true);
  assert.equal(harness.settled[0].canceled, false);
});

test("a mixed 13-keyword unattended plan settles every keyword in order", async () => {
  const attempts = new Map();
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => {
      const keyword = captureParams.keyword;
      attempts.set(keyword, (attempts.get(keyword) || 0) + 1);
      if (keyword === "词1") {
        return {
          ok: true,
          captureResult: {ok: true, data: {items: []}},
          recordIds: [],
          savedRecords: [],
        };
      }
      return successCapture(keyword);
    },
    afterKeywordCapture: async ({current, keyword, recordIds}) => {
      if (current === 5) {
        return {
          ok: false,
          canceled: false,
          successCount: 0,
          failedCount: 1,
          results: [
            {
              recordId: recordIds[0],
              ok: false,
              reason: "DETAIL_OPEN_TIMEOUT",
            },
          ],
        };
      }
      if (current === 8) {
        return {
          ok: false,
          canceled: false,
          runnerInterrupted: true,
          recoveryRequired: true,
          successCount: 0,
          failedCount: 1,
          results: [
            {
              recordId: recordIds[0],
              ok: false,
              reason: "RUNNER_TAB_UNAVAILABLE",
              category: "context_interrupted",
              runnerInterrupted: true,
            },
          ],
        };
      }
      return {
        ok: true,
        canceled: false,
        successCount: 1,
        failedCount: 0,
        results: [{recordId: recordIds[0], ok: true, keyword}],
      };
    },
  });
  const keywords = Array.from({length: 13}, (_, index) => `词${index + 1}`);

  const result = await harness.run({keywords});

  assert.equal(attempts.get("词1"), 2, "an empty keyword retries exactly once");
  assert.deepEqual(
    harness.captureCalls.map((call) => call.keyword),
    ["词1", ...keywords],
    "the empty retry must not reorder or truncate the remaining keywords",
  );
  assert.deepEqual(
    harness.settled.map((entry) => entry.keyword),
    keywords,
    "all 13 checkpoints must be persisted in plan order",
  );
  assert.deepEqual(
    Array.from(result.results, (entry) => entry.keyword),
    keywords,
    "the terminal result must include one settlement for every keyword",
  );
  assert.equal(result.stats.total, 13);
  assert.equal(result.stats.processed, 13);
  assert.equal(result.canceled, false);
  assert.equal(result.results[0].ok, false, "the no-result keyword is explicit");
  assert.equal(result.results[4].enhanceStatus, "failed");
  assert.equal(result.results[4].partial, true);
  assert.equal(result.results[7].enhanceStatus, "failed");
  assert.equal(result.results[7].partial, true);
  assert.equal(result.results[7].enhanceResult.runnerInterrupted, true);
  assert.equal(harness.progress.at(-1)?.phase, "done");
  assert.equal(
    harness.getReplacementListenerCount(),
    0,
    "the run must release its tab replacement listener",
  );
});

test("two consecutive unattended rounds do not reuse results or listeners", async () => {
  let activeRound = 1;
  const harness = createBatchHarness({
    captureKeyword: async ({captureParams}) => ({
      ...successCapture(captureParams.keyword),
      recordIds: [`round-${activeRound}-${captureParams.keyword}`],
    }),
    afterKeywordCapture: async ({recordIds}) => ({
      ok: true,
      canceled: false,
      successCount: 1,
      failedCount: 0,
      results: [{recordId: recordIds[0], ok: true}],
    }),
  });
  const keywords = Array.from({length: 13}, (_, index) => `词${index + 1}`);

  const first = await harness.run({keywords});
  assert.equal(harness.getReplacementListenerCount(), 0);
  activeRound = 2;
  const second = await harness.run({keywords});

  assert.equal(first.stats.processed, 13);
  assert.equal(second.stats.processed, 13);
  assert.equal(first.results.length, 13);
  assert.equal(second.results.length, 13);
  assert.ok(
    first.results.every((entry) => entry.recordIds[0].startsWith("round-1-")),
  );
  assert.ok(
    second.results.every((entry) => entry.recordIds[0].startsWith("round-2-")),
  );
  assert.deepEqual(
    harness.settled.map((entry) => entry.keyword),
    [...keywords, ...keywords],
    "both rounds must independently checkpoint all 13 keywords",
  );
  assert.equal(
    harness.getReplacementListenerCount(),
    0,
    "a completed round must leave no listener that can receive stale tab events",
  );
  assert.equal(
    harness.progress.filter((entry) => entry.phase === "done").length,
    2,
    "each round owns exactly one root terminal event",
  );
  const firstDoneAt = harness.progress.findIndex(
    (entry) => entry.phase === "done",
  );
  assert.ok(
    harness.progress
      .slice(firstDoneAt + 1)
      .some(
        (entry) =>
          entry.keyword === "词1" &&
          ["navigating", "submitting_search"].includes(entry.phase),
      ),
    "round two must start from its own first-keyword progress after round one",
  );
  assert.doesNotMatch(
    JSON.stringify({first, second}),
    /(?:still cleaning|cleanup pending|group busy|仍在清理|已绑定.*Tab)/i,
    "a clean second round must not inherit stale cleanup or task-group errors",
  );
});
