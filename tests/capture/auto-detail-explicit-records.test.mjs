import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);
const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);

function readSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function compileFunction({source, startMarker, endMarker, functionName, context}) {
  const section = readSourceSection(source, startMarker, endMarker).replace(
    /^export\s+/,
    "",
  );
  const sandbox = vm.createContext({...context});
  vm.runInContext(
    `${section}\nglobalThis.__compiledFunction = ${functionName};`,
    sandbox,
  );
  return sandbox.__compiledFunction;
}

function buildDetailCaptureRecord(id, {done = false} = {}) {
  return {
    id,
    type: "keyword_notes",
    payload: done
      ? {detailCaptureStatus: "done", detailPayload: {title: id}}
      : {detailCaptureStatus: "not_started"},
  };
}

function buildAutoDetailHarness() {
  const records = [
    buildDetailCaptureRecord("already-done", {done: true}),
    buildDetailCaptureRecord("pending"),
  ];
  const detailRuns = [];
  const observedScopes = [];

  const run = compileFunction({
    source: sidebarSource,
    startMarker: "async function maybeRunAutoDetailCaptureAfterListCapture(",
    endMarker: "async function maybeRunAutoSyncAfterDetailCapture(",
    functionName: "maybeRunAutoDetailCaptureAfterListCapture",
    context: {
      Boolean,
      DETAIL_CAPTURE_SCOPE_ALL: "all",
      buildDetailCaptureFailureSummaryText: () => "",
      getCurrentAuth: () => ({verified: true}),
      getCurrentDataPool: () => ({records}),
      getCurrentPageRecords: () => records,
      getCurrentRuntime: () => ({platform: "douyin"}),
      getDetailCaptureTargetRecords: (inputRecords, {scope}) => {
        observedScopes.push(scope);
        return inputRecords.filter(
          (record) =>
            scope === "all" || record.payload.detailCaptureStatus !== "done",
        );
      },
      getPlatformCapabilities: () => ({batchDetailCapture: true}),
      getRecordPrimaryNoteUrl: (record) =>
        `https://www.douyin.com/note/${record.id}`,
      getViewPlatform: () => "douyin",
      isAuthVerified: () => true,
      readDetailCaptureScopeFromInput: (scope) => scope || "pending",
      runDetailCaptureForRecordIds: async (recordIds) => {
        detailRuns.push([...recordIds]);
        return {
          ok: true,
          canceled: false,
          successCount: recordIds.length,
          failedCount: 0,
          filteredCount: 0,
        };
      },
      showMessage: () => {},
    },
  });

  return {detailRuns, observedScopes, records, run};
}

test("explicit record ids recapture already-done records when skip is disabled", async () => {
  const harness = buildAutoDetailHarness();

  const result = await harness.run(
    {
      autoDetailCaptureAfterListCapture: true,
      detailCaptureScope: "pending",
      skipAlreadyCapturedOnDetailCapture: false,
    },
    {recordIds: ["already-done", "pending"]},
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.detailRuns, [["already-done", "pending"]]);
  assert.deepEqual(
    harness.observedScopes,
    ["all"],
    "an explicit keyword result must not be narrowed by the panel's pending scope",
  );
});

test("explicit record ids remain pending-only when skip is enabled", async () => {
  const harness = buildAutoDetailHarness();

  const result = await harness.run(
    {
      autoDetailCaptureAfterListCapture: true,
      detailCaptureScope: "pending",
      skipAlreadyCapturedOnDetailCapture: true,
    },
    {recordIds: ["already-done", "pending"]},
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.detailRuns, [["pending"]]);
  assert.deepEqual(harness.observedScopes, ["pending"]);
});

test("each keyword invokes enhancement even when its record ids duplicate an already-done item", async () => {
  const captureCalls = [];
  const enhancementCalls = [];

  const run = compileFunction({
    source: captureSyncSource,
    startMarker: "export async function batchCaptureByKeywords({",
    endMarker: "export async function lightSampleByKeywords({",
    functionName: "batchCaptureByKeywords",
    context: {
      BATCH_INTER_KEYWORD_DELAY_MAX_MS: 0,
      BATCH_INTER_KEYWORD_DELAY_MIN_MS: 0,
      BATCH_KEYWORD_AFTER_NAV_WAIT_MS: 0,
      BATCH_KEYWORD_EMPTY_RETRY_WAIT_MS: 0,
      Math,
      activateTabForReliableTimer: async () => {},
      buildKeywordSearchUrl: (keyword) =>
        `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
      captureAndSaveInTab: async ({captureParams}) => {
        captureCalls.push(captureParams.keyword);
        return {
          ok: true,
          captureResult: {ok: true, data: {items: [{id: "already-done"}]}},
          savedRecords: [],
          recordIds: ["already-done"],
        };
      },
      chrome: {
        tabs: {
          get: async (tabId) => ({
            id: tabId,
            url: "https://www.xiaohongshu.com/search_result",
          }),
          update: async () => {},
        },
      },
      closeKeywordSearchFilterPanelInTab: async () => {},
      createCaptureRequestId: () => "list-run-test",
      formatEnhanceSkipReason: (reason) => reason || "",
      getCurrentActiveTab: async () => ({id: 41}),
      hasActiveBatchSearchFilters: () => false,
      isBatchCaptureCanceledError: () => false,
      isCaptureCanceledResult: () => false,
      isDouyinPlatform: () => false,
      isEmptyKeywordCaptureResult: () => false,
      isUnattendedSafetyBlock: () => false,
      navigateToSearchUrl: async () => {},
      normalizeUrlWithoutHash: (url) => String(url || "").split("#")[0],
      prepareDetailBatchRunnerContext: async () => ({
        runnerTabId: 41,
        shouldRestoreSourcePage: false,
        sourcePageUrl: "",
      }),
      setCaptureTaskTakeoverStateInTab: async () => {},
      submitKeywordSearchInTab: async () => {},
      waitForKeywordSearchResultsInTab: async () => true,
      waitMsWithStop: async () => {},
      waitMsWithStopAndTick: async () => {},
    },
  });

  const result = await run({
    keywords: ["品牌词", "竞品词"],
    platform: "xiaohongshu",
    sourceTabId: 41,
    afterKeywordCapture: async (payload) => {
      enhancementCalls.push({
        keyword: payload.keyword,
        recordIds: [...payload.recordIds],
      });
      return {skipped: true, reason: "no_target_records"};
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(captureCalls, ["品牌词", "竞品词"]);
  assert.deepEqual(enhancementCalls, [
    {keyword: "品牌词", recordIds: ["already-done"]},
    {keyword: "竞品词", recordIds: ["already-done"]},
  ]);
  assert.deepEqual([...result.results].map(({keyword}) => keyword), [
    "品牌词",
    "竞品词",
  ]);
});
