import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {runEnhancementWithSingleRetry} from "../../utils/capture/enhancement-retry.js";

const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);

const WINDOW_START_MS = Date.parse("2026-07-22T00:00:00+08:00");
const WINDOW_END_MS = Date.parse("2026-07-29T00:00:00+08:00");

function readSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function compileFunction({
  source,
  startMarker,
  endMarker,
  functionName,
  context,
}) {
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

function buildRecord(
  id,
  {listPublishTime = "", detailPublishTime = ""} = {},
) {
  const payload = {};
  if (listPublishTime) {
    payload.items = [{publishTimestamp: listPublishTime}];
  }
  if (detailPublishTime) {
    payload.detailPayload = {publishTimestamp: detailPublishTime};
  }
  return {id, payload};
}

function resolvePublishMoment(record) {
  const detailPublishTime = record?.payload?.detailPayload?.publishTimestamp;
  const listPublishTime = record?.payload?.items?.[0]?.publishTimestamp;
  const timestampMs = Date.parse(detailPublishTime || listPublishTime || "");
  return Number.isFinite(timestampMs)
    ? {ok: true, precision: "timestamp", timestampMs}
    : null;
}

function buildPublishWindowHarness({
  beforeRecords,
  afterRecords,
  detailResultFactory = null,
}) {
  const beforeById = new Map(beforeRecords.map((record) => [record.id, record]));
  const afterById = new Map(afterRecords.map((record) => [record.id, record]));
  const detailCalls = [];
  const getRecordCalls = [];
  let detailCaptureStarted = false;
  let detailCallCount = 0;

  const run = compileFunction({
    source: sidebarSource,
    startMarker: "async function resolveMonitorRecordIdsForPublishWindow({",
    endMarker: "async function finishMonitorExecutionSafely(",
    functionName: "resolveMonitorRecordIdsForPublishWindow",
    context: {
      Date,
      Map,
      Math,
      Number,
      Promise,
      Set,
      MONITOR_UNKNOWN_PUBLISH_DETAIL_LIMIT: 8,
      runEnhancementWithSingleRetry,
      reportMonitorRunProgress: (onProgress, progress, fallbackMessage) => {
        if (typeof onProgress === "function") {
          onProgress({
            ...progress,
            message: progress?.message || fallbackMessage || "",
          });
        }
      },
      batchCaptureDetailsForRecords: async (recordIds, options) => {
        detailCallCount += 1;
        detailCalls.push({
          recordIds: [...recordIds],
          includeComments: options.includeComments,
          skipAlreadyCaptured: options.skipAlreadyCaptured,
        });
        detailCaptureStarted = true;
        if (typeof detailResultFactory === "function") {
          return detailResultFactory([...recordIds], detailCallCount);
        }
        return {
          ok: true,
          canceled: false,
          successCount: recordIds.length,
          failedCount: 0,
          results: recordIds.map((recordId) => ({recordId, ok: true})),
        };
      },
      getRecords: async (recordIds) => {
        getRecordCalls.push([...recordIds]);
        const recordsById = detailCaptureStarted ? afterById : beforeById;
        return recordIds
          .map((recordId) => recordsById.get(recordId))
          .filter(Boolean);
      },
      isMonitorPublishMomentInWindow: (moment, bounds) =>
        Boolean(
          moment?.ok &&
            moment.timestampMs >= bounds.startMs &&
            moment.timestampMs < bounds.endMs,
        ),
      resolveMonitorPublishWindowBounds: () => ({
        strict: true,
        key: "custom",
        label: "2026/07/22 至 2026/07/28",
        startMs: WINDOW_START_MS,
        endMs: WINDOW_END_MS,
      }),
      resolveMonitorRecordPublishMoment: resolvePublishMoment,
      showProgress: () => {},
    },
  });

  return {detailCalls, getRecordCalls, run};
}

test("official comment patrol detail-checks every discovered candidate, including more than eight unknown list dates", async () => {
  const recordIds = Array.from({length: 10}, (_, index) => `candidate-${index + 1}`);
  const beforeRecords = recordIds.map((id) => buildRecord(id));
  const afterRecords = recordIds.map((id, index) =>
    buildRecord(id, {
      detailPublishTime: `2026-07-${String(22 + (index % 7)).padStart(2, "0")}T10:00:00+08:00`,
    }),
  );
  const harness = buildPublishWindowHarness({beforeRecords, afterRecords});

  const result = await harness.run({
    recordIds,
    monitorSettings: {
      publishWindow: "custom",
      publishDateFrom: "2026-07-22",
      publishDateTo: "2026-07-28",
      postsLimit: 20,
    },
    captureSettings: {verifyPublishDateFromDetail: true},
    displayName: "上海安吉星信息服务有限公司",
  });

  assert.deepEqual(harness.detailCalls, [
    {
      recordIds,
      includeComments: false,
      skipAlreadyCaptured: false,
    },
  ]);
  assert.deepEqual([...result.recordIds], recordIds);
  assert.equal(result.scannedCount, 10);
  assert.equal(result.filteredCount, 0);
  assert.equal(result.unknownCount, 0);
});

test("official comment patrol resumes unfinished detail candidates once after its worker tab disappears", async () => {
  const recordIds = Array.from(
    {length: 6},
    (_, index) => `candidate-${index + 1}`,
  );
  const afterRecords = recordIds.map((id, index) =>
    buildRecord(id, {
      detailPublishTime: `2026-07-${String(22 + index).padStart(2, "0")}T10:00:00+08:00`,
    }),
  );
  const harness = buildPublishWindowHarness({
    beforeRecords: recordIds.map((id) => buildRecord(id)),
    afterRecords,
    detailResultFactory: (attemptRecordIds, callCount) => {
      if (callCount === 1) {
        return {
          ok: false,
          canceled: false,
          runnerInterrupted: true,
          recoveryRequired: true,
          successCount: 3,
          failedCount: 1,
          results: [
            ...recordIds.slice(0, 3).map((recordId) => ({
              recordId,
              ok: true,
            })),
            {
              recordId: recordIds[3],
              ok: false,
              reason: "CONTEXT_INTERRUPTED",
              category: "context_interrupted",
            },
          ],
        };
      }
      return {
        ok: true,
        canceled: false,
        runnerInterrupted: false,
        recoveryRequired: false,
        successCount: attemptRecordIds.length,
        failedCount: 0,
        results: attemptRecordIds.map((recordId) => ({
          recordId,
          ok: true,
        })),
      };
    },
  });

  const result = await harness.run({
    recordIds,
    monitorSettings: {
      publishWindow: "custom",
      publishDateFrom: "2026-07-22",
      publishDateTo: "2026-07-28",
      postsLimit: 20,
    },
    captureSettings: {verifyPublishDateFromDetail: true},
    displayName: "上海安吉星信息服务有限公司",
  });

  assert.deepEqual(
    harness.detailCalls.map((call) => call.recordIds),
    [recordIds, recordIds.slice(3)],
  );
  assert.equal(result.failed, undefined);
  assert.equal(result.detailResult.autoRetryAttempted, true);
  assert.deepEqual([...result.recordIds], recordIds);
});

test("official comment patrol trusts detail dates over list dates and applies postsLimit after date filtering", async () => {
  const recordIds = [
    "list-out-detail-in",
    "list-in-detail-out",
    "inside-2",
    "inside-3",
  ];
  const beforeRecords = [
    buildRecord("list-out-detail-in", {
      listPublishTime: "2026-07-20T10:00:00+08:00",
    }),
    buildRecord("list-in-detail-out", {
      listPublishTime: "2026-07-25T10:00:00+08:00",
    }),
    buildRecord("inside-2"),
    buildRecord("inside-3"),
  ];
  const afterRecords = [
    buildRecord("list-out-detail-in", {
      listPublishTime: "2026-07-20T10:00:00+08:00",
      detailPublishTime: "2026-07-23T10:00:00+08:00",
    }),
    buildRecord("list-in-detail-out", {
      listPublishTime: "2026-07-25T10:00:00+08:00",
      detailPublishTime: "2026-07-20T10:00:00+08:00",
    }),
    buildRecord("inside-2", {
      detailPublishTime: "2026-07-24T10:00:00+08:00",
    }),
    buildRecord("inside-3", {
      detailPublishTime: "2026-07-26T10:00:00+08:00",
    }),
  ];
  const harness = buildPublishWindowHarness({beforeRecords, afterRecords});

  const result = await harness.run({
    recordIds,
    monitorSettings: {
      publishWindow: "custom",
      publishDateFrom: "2026-07-22",
      publishDateTo: "2026-07-28",
      postsLimit: 2,
    },
    captureSettings: {verifyPublishDateFromDetail: true},
    displayName: "上海安吉星信息服务有限公司",
  });

  assert.deepEqual(harness.detailCalls, [
    {
      recordIds,
      includeComments: false,
      skipAlreadyCaptured: false,
    },
  ]);
  assert.deepEqual([...result.recordIds], [
    "list-out-detail-in",
    "inside-2",
  ]);
  assert.equal(result.scannedCount, 4);
  assert.equal(result.filteredCount, 2);
  assert.equal(result.unknownCount, 0);
});

for (const terminalCase of [
  {
    label: "cancellation",
    patch: {canceled: true},
    errorCode: "capture_canceled",
  },
  {
    label: "security block",
    patch: {securityBlocked: true},
    errorCode: "capture_security_blocked",
  },
  {
    label: "runner interruption",
    patch: {runnerInterrupted: true},
    errorCode: "capture_runner_interrupted",
  },
]) {
  test(`official comment patrol treats detail ${terminalCase.label} as terminal failure`, async () => {
    const recordIds = ["candidate-1"];
    const records = [
      buildRecord("candidate-1", {
        detailPublishTime: "2026-07-24T10:00:00+08:00",
      }),
    ];
    const harness = buildPublishWindowHarness({
      beforeRecords: records,
      afterRecords: records,
      detailResultFactory: () => ({
        ok: false,
        canceled: false,
        securityBlocked: false,
        runnerInterrupted: false,
        successCount: 0,
        failedCount: 0,
        results: [],
        ...terminalCase.patch,
      }),
    });

    const result = await harness.run({
      recordIds,
      monitorSettings: {publishWindow: "custom"},
      captureSettings: {verifyPublishDateFromDetail: true},
      displayName: "上海安吉星信息服务有限公司",
    });

    assert.equal(result.failed, true);
    assert.equal(result.errorCode, terminalCase.errorCode);
    assert.deepEqual([...result.recordIds], []);
    assert.equal(harness.getRecordCalls.length, 0);
  });
}

test("official comment patrol fails the run when any detail read fails and never reuses its stale date", async () => {
  const recordIds = ["fresh-success", "stale-failure"];
  const beforeRecords = recordIds.map((id) => buildRecord(id));
  const afterRecords = [
    buildRecord("fresh-success", {
      detailPublishTime: "2026-07-24T10:00:00+08:00",
    }),
    buildRecord("stale-failure", {
      detailPublishTime: "2026-07-25T10:00:00+08:00",
    }),
  ];
  const harness = buildPublishWindowHarness({
    beforeRecords,
    afterRecords,
    detailResultFactory: () => ({
      ok: false,
      canceled: false,
      successCount: 1,
      failedCount: 1,
      results: [
        {recordId: "fresh-success", ok: true},
        {
          recordId: "stale-failure",
          ok: false,
          message: "详情页未完成加载",
        },
      ],
    }),
  });

  const result = await harness.run({
    recordIds,
    monitorSettings: {publishWindow: "custom"},
    captureSettings: {verifyPublishDateFromDetail: true},
    displayName: "上海安吉星信息服务有限公司",
  });

  assert.equal(result.failed, true);
  assert.equal(result.errorCode, "publish_date_capture_failed");
  assert.match(result.errorMessage, /详情页未完成加载/u);
  assert.deepEqual([...result.recordIds], []);
  assert.equal(result.successfulDetailCount, 1);
  assert.equal(result.failedDetailCount, 1);
  assert.equal(harness.getRecordCalls.length, 0);
});

test("official comment patrol returns publish_date_unknown instead of no-hit when a successful detail has no trustworthy date", async () => {
  const recordIds = ["date-unknown"];
  const harness = buildPublishWindowHarness({
    beforeRecords: [buildRecord("date-unknown")],
    afterRecords: [buildRecord("date-unknown")],
  });

  const result = await harness.run({
    recordIds,
    monitorSettings: {publishWindow: "custom"},
    captureSettings: {verifyPublishDateFromDetail: true},
    displayName: "上海安吉星信息服务有限公司",
  });

  assert.equal(result.failed, true);
  assert.equal(result.errorCode, "publish_date_unknown");
  assert.equal(result.unknownCount, 1);
  assert.deepEqual([...result.recordIds], []);
  assert.deepEqual(harness.getRecordCalls, [["date-unknown"]]);
});

test("official comment patrol caller handles publish-date failures before the no-hit branch", () => {
  const executionSection = readSourceSection(
    sidebarSource,
    "async function executeMonitorRunItem(",
    "async function handleRunMonitorNow(",
  );
  const failedBranchIndex = executionSection.indexOf(
    "if (publishFilterResult.failed)",
  );
  const noHitBranchIndex = executionSection.indexOf(
    "if (hitRecordIds.length === 0)",
  );
  assert.notEqual(failedBranchIndex, -1);
  assert.notEqual(noHitBranchIndex, -1);
  assert.ok(
    failedBranchIndex < noHitBranchIndex,
    "publish-date failures must terminate before zero hits can be reported",
  );
});

test("official comment patrol disables list-page date filtering and discovers beyond postsLimit", () => {
  const resolveCaptureParams = compileFunction({
    source: sidebarSource,
    startMarker: "function resolveMonitorRunnerCaptureParams(",
    endMarker: "function summarizeMonitorSyncResult(",
    functionName: "resolveMonitorRunnerCaptureParams",
    context: {
      Math,
      Number,
      DEFAULT_CAPTURE_SETTINGS: {
        sharedWaitMinMs: 800,
        sharedWaitMaxMs: 1600,
        sharedStallTimeoutMs: 8000,
        sharedMaxDurationMs: 120000,
      },
      DEFAULT_MONITOR_SETTINGS: {
        observeWindowHours: 168,
        likeThreshold: 0,
      },
      MONITOR_OBSERVE_WINDOW_OPTIONS: [24, 72, 168],
      MONITOR_DETAIL_DATE_DISCOVERY_MIN: 20,
      MONITOR_DETAIL_DATE_DISCOVERY_MAX: 60,
      MONITOR_DETAIL_DATE_DISCOVERY_MULTIPLIER: 3,
      MONITOR_PUBLISH_WINDOW: {PREVIOUS_DAY: "previous_day"},
      MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW: {
        24: 20,
        72: 40,
        168: 60,
      },
      resolveMonitorPublishWindowBounds: () => ({
        strict: true,
        key: "custom",
      }),
    },
  });

  const captureParams = resolveCaptureParams(
    {
      observeWindowHours: 168,
      publishWindow: "custom",
      publishDateFrom: "2026-07-22",
      publishDateTo: "2026-07-28",
      postsLimit: 5,
    },
    {verifyPublishDateFromDetail: true},
  );

  assert.equal(
    captureParams.monitorPublishWindow,
    "",
    "the account list cannot enforce a publication-date window",
  );
  assert.equal(
    captureParams.maxDetectedItems,
    20,
    "the strict date window must not shrink the detail-verification discovery pool",
  );
  assert.equal(captureParams.maxScrollTimes, 20);
});

test("official account patrol scans the explicitly requested latest post count without a date window", async () => {
  const resolveCaptureParams = compileFunction({
    source: sidebarSource,
    startMarker: "function resolveMonitorRunnerCaptureParams(",
    endMarker: "function summarizeMonitorSyncResult(",
    functionName: "resolveMonitorRunnerCaptureParams",
    context: {
      Math,
      Number,
      DEFAULT_CAPTURE_SETTINGS: {
        sharedWaitMinMs: 800,
        sharedWaitMaxMs: 1600,
        sharedStallTimeoutMs: 8000,
        sharedMaxDurationMs: 120000,
      },
      DEFAULT_MONITOR_SETTINGS: {
        observeWindowHours: 48,
        likeThreshold: 0,
      },
      MONITOR_OBSERVE_WINDOW_OPTIONS: [24, 48, 72],
      MONITOR_DETAIL_DATE_DISCOVERY_MIN: 20,
      MONITOR_DETAIL_DATE_DISCOVERY_MAX: 60,
      MONITOR_DETAIL_DATE_DISCOVERY_MULTIPLIER: 3,
      MONITOR_LATEST_POSTS_LIMIT_MAX: 100,
      MONITOR_PUBLISH_WINDOW: {PREVIOUS_DAY: "previous_day"},
      MONITOR_RECENT_SCAN_LIMIT_BY_WINDOW: {
        24: 20,
        48: 30,
        72: 40,
      },
      resolveMonitorPublishWindowBounds: () => ({
        strict: true,
        key: "last_24h",
      }),
    },
  });

  const captureParams = resolveCaptureParams(
    {postsLimit: 30},
    {scanLatestPostsByCount: true},
  );
  assert.equal(captureParams.maxDetectedItems, 30);
  assert.equal(captureParams.monitorPublishWindow, "");
  assert.equal(captureParams.maxScrollTimes, 20);

  const resolveRecordIds = compileFunction({
    source: sidebarSource,
    startMarker: "async function resolveMonitorRecordIdsForPublishWindow(",
    endMarker: "async function finishMonitorExecutionSafely(",
    functionName: "resolveMonitorRecordIdsForPublishWindow",
    context: {Number, Set},
  });
  const recordIds = Array.from({length: 35}, (_, index) => `post-${index + 1}`);
  const selected = await resolveRecordIds({
    recordIds,
    monitorSettings: {postsLimit: 30},
    captureSettings: {scanLatestPostsByCount: true},
  });
  assert.deepEqual([...selected.recordIds], recordIds.slice(0, 30));
  assert.equal(selected.scannedCount, 35);
  assert.equal(selected.filteredCount, 5);
  assert.equal(selected.unknownCount, 0);
  assert.equal(selected.windowLabel, "最近 30 篇");
  assert.equal(selected.detailResult, null);
});
