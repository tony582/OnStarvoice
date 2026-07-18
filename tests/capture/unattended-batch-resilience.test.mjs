import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
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

function createBatchHarness({captureKeyword, afterKeywordCapture = null} = {}) {
  const captureCalls = [];
  const navigationCalls = [];
  const settled = [];
  const progress = [];
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
    Math,
    activateTabForReliableTimer: async () => {},
    buildInterKeywordDelayMessage: ({keyword}) => `next:${keyword}`,
    buildKeywordSearchUrl: (keyword) =>
      `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
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
    hasActiveBatchSearchFilters: () => false,
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
    isDouyinPlatform: () => false,
    isEmptyKeywordCaptureResult: (result) =>
      Boolean(result?.ok && Array.isArray(result?.data?.items) && result.data.items.length === 0),
    isUnattendedSafetyBlock: (value) => Boolean(value?.securityBlocked),
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
    submitKeywordSearchInTab: async () => {},
    switchDouyinKeywordSearchInTab: async () => {},
    waitForKeywordSearchResultsInTab: async () => true,
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
      shouldStop: options.shouldStop || (() => false),
    });

  return {
    captureCalls,
    navigationCalls,
    progress,
    replaceRunnerTab,
    run,
    settled,
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
