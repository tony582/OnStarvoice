import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sidebarSource = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);
const backgroundSource = await readFile(
  new URL("../../background.js", import.meta.url),
  "utf8",
);

function readSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function evaluateSidebarProgressProjector() {
  const source = readSection(
    sidebarSource,
    "function readFiniteProgressNumber(",
    "function rememberCaptureTaskProgressContext(",
  );
  const context = {
    activeCaptureTaskProgressContext: null,
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}
this.projectCaptureTaskProgress = projectCaptureTaskProgress;`,
    context,
  );
  return context.projectCaptureTaskProgress;
}

function evaluateBackgroundProgressNormalizer() {
  const source = readSection(
    backgroundSource,
    "function normalizeUnattendedRunProgress(",
    "function parseDateList(",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source}
this.normalizeUnattendedRunProgress = normalizeUnattendedRunProgress;`,
    context,
  );
  return context.normalizeUnattendedRunProgress;
}

function evaluateSyntheticSessionBuilder() {
  const source = readSection(
    sidebarSource,
    "function buildUnattendedSyntheticDebugSession(",
    "function renderCaptureDebugSession(runtime = {})",
  );
  const context = {
    keywordPlanState: null,
    isKeywordPlanRunning: () => true,
    getPagePlatform: () => "xiaohongshu",
    supportsPersistentCaptureTaskPlatform: () => true,
    KEYWORD_PLAN_TERMINAL_STATUSES: new Set([
      "completed",
      "completed_with_failures",
      "failed",
      "canceled",
    ]),
    DEBUG_SESSION_TERMINAL_SUMMARY_MS: 20_000,
    debugSessionDismissedTerminalRunAt: "",
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}
this.buildUnattendedSyntheticDebugSession =
  buildUnattendedSyntheticDebugSession;`,
    context,
  );
  return context.buildUnattendedSyntheticDebugSession;
}

function evaluateUnattendedTaskCountsBuilder() {
  const source = readSection(
    sidebarSource,
    "function buildUnattendedTaskCounts(",
    "function createUnattendedKeywordCheckpointReporter(",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source}
this.buildUnattendedTaskCounts = buildUnattendedTaskCounts;`,
    context,
  );
  return context.buildUnattendedTaskCounts;
}

function evaluateCaptureTaskProgressLabels() {
  const statsSource = readSection(
    sidebarSource,
    "function buildCaptureTaskStats(progress = {})",
    "function parseCaptureTaskTime(",
  );
  const scopeSource = readSection(
    sidebarSource,
    "function buildCaptureTaskScopeMeta(progress = {})",
    "function buildCaptureTaskActivityMessage(",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${statsSource}\n${scopeSource}
this.buildCaptureTaskStats = buildCaptureTaskStats;
this.buildCaptureTaskScopeMeta = buildCaptureTaskScopeMeta;`,
    context,
  );
  return context;
}

function evaluateUnattendedEnhanceCancellationClassifier() {
  const source = readSection(
    sidebarSource,
    "function resolveUnattendedEnhanceCancellation(",
    "function resolveUnattendedCancellationTerminal(",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source}
this.resolveUnattendedEnhanceCancellation =
  resolveUnattendedEnhanceCancellation;`,
    context,
  );
  return context.resolveUnattendedEnhanceCancellation;
}

function assertProgressFieldContract(section, label) {
  for (const field of [
    "roundCurrent",
    "roundTotal",
    "keywordCurrent",
    "keywordTotal",
    "itemCurrent",
    "itemTotal",
    "taskMeta",
    "runStartedAt",
    "phaseStartedAt",
    "updatedAt",
    "remainingMs",
    "waitUntil",
  ]) {
    assert.match(
      section,
      new RegExp(`\\b${field}\\s*(?::|,)`),
      `${label} must forward ${field}`,
    );
  }
}

test("detail callbacks preserve current keyword and map raw 44/50 to item progress", () => {
  const projectCaptureTaskProgress = evaluateSidebarProgressProjector();
  const runStartedAt = "2026-07-16T09:00:00.000Z";
  const projected = projectCaptureTaskProgress(
    {
      phase: "detail_collecting",
      current: 44,
      total: 50,
      message: "正在补采笔记详情",
    },
    {
      keyword: "别克壁纸",
      keywordCurrent: 2,
      keywordTotal: 4,
      roundCurrent: 1,
      roundTotal: 3,
      runStartedAt,
      taskMeta: {
        keywordList: ["别克车机", "别克壁纸", "君威", "昂科威"],
        enhancementEnabled: true,
      },
    },
  );

  assert.equal(projected.keyword, "别克壁纸");
  assert.equal(projected.keywordCurrent, 2);
  assert.equal(projected.keywordTotal, 4);
  assert.equal(projected.roundCurrent, 1);
  assert.equal(projected.roundTotal, 3);
  assert.equal(projected.itemCurrent, 44);
  assert.equal(projected.itemTotal, 50);
  assert.equal(projected.runStartedAt, runStartedAt);
  assert.deepEqual(
    JSON.parse(JSON.stringify(projected.taskMeta)),
    {
      keywordList: ["别克车机", "别克壁纸", "君威", "昂科威"],
      enhancementEnabled: true,
    },
  );
});

test("a new keyword overrides stale 1/13 context without treating detail items as keywords", () => {
  const projectCaptureTaskProgress = evaluateSidebarProgressProjector();
  const context = {
    keyword: "关键词一",
    keywordCurrent: 1,
    keywordTotal: 13,
    taskMeta: {
      keywordList: Array.from({length: 13}, (_, index) => `关键词${index + 1}`),
    },
  };

  const listProgress = projectCaptureTaskProgress(
    {
      phase: "capturing",
      keyword: "关键词2",
      current: 2,
      total: 13,
    },
    context,
  );
  assert.equal(listProgress.keywordCurrent, 2);
  assert.equal(listProgress.keywordTotal, 13);

  const detailProgress = projectCaptureTaskProgress(
    {
      phase: "detail_collecting",
      keyword: "关键词2",
      current: 44,
      total: 50,
    },
    context,
  );
  assert.equal(detailProgress.keywordCurrent, 2);
  assert.equal(detailProgress.keywordTotal, 13);
  assert.equal(detailProgress.itemCurrent, 44);
  assert.equal(detailProgress.itemTotal, 50);
});

test("raw detail 44/50 never becomes an invented overall percentage", () => {
  const source = readSection(
    sidebarSource,
    "function resolveCaptureTaskPercent(progress = {})",
    "function buildCaptureTaskStats(progress = {})",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source}
this.resolveCaptureTaskPercent = resolveCaptureTaskPercent;`,
    context,
  );

  assert.equal(
    context.resolveCaptureTaskPercent({
      phase: "detail_collecting",
      current: 44,
      total: 50,
      itemCurrent: 44,
      itemTotal: 50,
    }),
    null,
  );
  assert.equal(
    context.resolveCaptureTaskPercent({
      phase: "detail_collecting",
      itemCurrent: 44,
      itemTotal: 50,
      progressPercent: 63,
    }),
    63,
  );
});

test("unattended counts keep the planned keyword total while processing checkpoints", () => {
  const buildUnattendedTaskCounts = evaluateUnattendedTaskCountsBuilder();
  const checkpoint = {
    keywordResults: [
      {round: 1, keyword: "关键词一", status: "failed"},
      {round: 1, keyword: "关键词二", status: "completed"},
    ],
  };
  const summary = {
    saved: 12,
    completed: 1,
    failed: 1,
    skipped: 0,
    retries: 1,
    partial: 0,
  };

  const counts = buildUnattendedTaskCounts(checkpoint, summary, {
    total: 13 * 2,
  });

  assert.equal(counts.total, 26, "two rounds of 13 keywords stay visible");
  assert.equal(
    counts.processed,
    2,
    "only settled keywords count as processed; planned work is not fake progress",
  );
  assert.equal(counts.success, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.retried, 1);
});

test("task labels distinguish the keyword plan from items inside the current keyword", () => {
  const {buildCaptureTaskStats, buildCaptureTaskScopeMeta} =
    evaluateCaptureTaskProgressLabels();
  const progress = {
    keyword: "别克壁纸",
    keywordCurrent: 2,
    keywordTotal: 13,
    itemCurrent: 44,
    itemTotal: 50,
  };

  assert.match(
    buildCaptureTaskStats(progress),
    /关键词 2\/13：别克壁纸/,
  );
  assert.match(
    buildCaptureTaskStats(progress),
    /当前词内作品 44\/50/,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildCaptureTaskScopeMeta(progress))),
    ["关键词 2/13：别克壁纸", "当前词内作品 44/50"],
  );
});

test("temporary Debug interruptions do not become whole-batch user cancellation", () => {
  const classify = evaluateUnattendedEnhanceCancellationClassifier();

  for (const reason of [
    "native_debug_canceled",
    "sidebar_owner_disconnected",
  ]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(classify({canceled: true, reason}))),
      {reason, stopBatch: false, recoverable: true},
    );
  }

  for (const reason of [
    "user_cancel_requested",
    "unattended_cancel_requested",
  ]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(classify({canceled: true, reason}))),
      {reason, stopBatch: true, recoverable: false},
    );
  }

  assert.equal(
    classify({canceled: true, securityBlocked: true}).stopBatch,
    true,
  );
  assert.equal(
    classify({canceled: true, error: {code: "fatal_navigation_failure"}})
      .stopBatch,
    true,
  );
});

test("unattended reporters forward hierarchy, task metadata and timing fields", () => {
  const planReporter = readSection(
    sidebarSource,
    "function createUnattendedKeywordProgressReporter(",
    "function resolveUnattendedProtectedWaitUntilMs(",
  );
  assert.match(
    planReporter,
    /const projectedProgress = projectCaptureTaskProgress\(progress\)/,
  );
  assertProgressFieldContract(
    planReporter,
    "createUnattendedKeywordProgressReporter",
  );

  const protectedWaitReporter = readSection(
    sidebarSource,
    "async function reportUnattendedProtectedWaitState(",
    "async function waitForUnattendedProtectedStart(",
  );
  assert.match(protectedWaitReporter, /reportPatch\.counts = counts/);
  assert.match(protectedWaitReporter, /keywordCurrent:/);
  assert.match(protectedWaitReporter, /keywordTotal:/);
  assert.match(protectedWaitReporter, /roundTotal:/);

  const protectedWait = readSection(
    sidebarSource,
    "async function waitForUnattendedProtectedStart(",
    "async function acquireCaptureExecutionLock(",
  );
  assert.match(
    protectedWait,
    /const plannedTaskTotal = plannedKeywords\.length \* plannedRounds/,
  );
  assert.match(
    protectedWait,
    /buildUnattendedTaskCounts\(checkpoint, checkpointSummary, \{\s*total: plannedTaskTotal/,
  );
  assert.match(protectedWait, /\.\.\.waitProgress/);

  const contentReporter = readSection(
    sidebarSource,
    "function reportActiveUnattendedContentProgress(progress = {})",
    "function handleProgress(progress)",
  );
  assert.match(
    contentReporter,
    /progress = projectCaptureTaskProgress\(progress\)/,
  );
  assertProgressFieldContract(
    contentReporter,
    "reportActiveUnattendedContentProgress",
  );
});

test("background normalization preserves hierarchy, task metadata and timing fields", () => {
  const normalizeUnattendedRunProgress =
    evaluateBackgroundProgressNormalizer();
  const input = {
    current: 44,
    total: 50,
    roundCurrent: 2,
    roundTotal: 3,
    keyword: "别克壁纸",
    keywordCurrent: 2,
    keywordTotal: 4,
    itemCurrent: 44,
    itemTotal: 50,
    progressScope: "detail_item",
    phase: "detail_collecting",
    runStartedAt: "2026-07-16T09:00:00.000Z",
    phaseStartedAt: "2026-07-16T09:03:00.000Z",
    updatedAt: "2026-07-16T09:04:00.000Z",
    remainingMs: 2_000,
    waitUntil: "2026-07-16T09:04:02.000Z",
    taskMeta: {
      keywordList: ["别克车机", "别克壁纸"],
      searchFilters: {
        publishTime: "month",
        sortDimension: "latest",
      },
      enhancementEnabled: true,
      commentsEnabled: true,
      bloggerMetricsEnabled: true,
    },
  };

  const normalized = normalizeUnattendedRunProgress(input);
  for (const field of [
    "roundCurrent",
    "roundTotal",
    "keywordCurrent",
    "keywordTotal",
    "itemCurrent",
    "itemTotal",
    "runStartedAt",
    "phaseStartedAt",
    "updatedAt",
    "remainingMs",
    "waitUntil",
  ]) {
    assert.equal(normalized[field], input[field], `lost ${field}`);
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.taskMeta)),
    input.taskMeta,
  );
});

test("synthetic and native dark task surfaces consume the same progress contract", () => {
  const buildUnattendedSyntheticDebugSession =
    evaluateSyntheticSessionBuilder();
  const progress = {
    current: 44,
    total: 50,
    roundCurrent: 2,
    roundTotal: 3,
    keyword: "别克壁纸",
    keywordCurrent: 2,
    keywordTotal: 4,
    itemCurrent: 44,
    itemTotal: 50,
    runStartedAt: "2026-07-16T09:00:00.000Z",
    phaseStartedAt: "2026-07-16T09:03:00.000Z",
    updatedAt: "2026-07-16T09:04:00.000Z",
    remainingMs: 2_000,
    waitUntil: "2026-07-16T09:04:02.000Z",
    taskMeta: {
      keywordList: ["别克车机", "别克壁纸"],
      enhancementEnabled: true,
    },
  };
  const session = buildUnattendedSyntheticDebugSession(
    {
      lastActiveTabId: 88,
      lastPageUrl: "https://www.xiaohongshu.com/search_result",
    },
    {
      enabled: true,
      platform: "xiaohongshu",
      keywords: ["别克车机", "别克壁纸"],
      lastRunProgress: progress,
    },
  );

  for (const [field, value] of Object.entries(progress)) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(session.progress[field])),
      JSON.parse(JSON.stringify(value)),
      `synthetic surface lost ${field}`,
    );
  }

  const renderSection = readSection(
    sidebarSource,
    "function renderCaptureDebugSession(runtime = {})",
    "function setupDebugSessionPanelControls()",
  );
  assert.match(
    renderSection,
    /const session = nativeActive \? nativeSession : syntheticSession/,
  );
  assert.match(
    renderSection,
    /session\?\.progress && typeof session\.progress === "object"\s+\? session\.progress/,
  );
  const clockSection = readSection(
    sidebarSource,
    "function updateDebugSessionClock()",
    "function startDebugSessionClock(",
  );
  assert.match(
    clockSection,
    /progress\.runStartedAt[\s\S]*?session\.startedAt/,
    "native task timer must fall back to session.startedAt",
  );
});

test("detail step text uses item progress rather than ambiguous legacy current/total", () => {
  const renderSection = readSection(
    sidebarSource,
    "function renderCaptureDebugSession(runtime = {})",
    "function setupDebugSessionPanelControls()",
  );
  const detailStart = renderSection.indexOf(
    'const detailLabel = document.getElementById("debugSessionDetailLabel")',
  );
  assert.ok(detailStart > -1);
  const detailSection = renderSection.slice(detailStart);
  assert.match(detailSection, /progress\?\.itemCurrent/);
  assert.match(detailSection, /progress\?\.itemTotal/);
  assert.doesNotMatch(
    detailSection,
    /Number\(progress\?\.current\)|Number\(progress\?\.total\)/,
  );
});

test("recent unattended terminal state remains visible as a completed summary", () => {
  const buildUnattendedSyntheticDebugSession =
    evaluateSyntheticSessionBuilder();
  const lastRunAt = new Date().toISOString();
  const session = buildUnattendedSyntheticDebugSession(
    {
      lastActiveTabId: 88,
      lastPageUrl: "https://www.douyin.com/search/test",
    },
    {
      enabled: true,
      platform: "douyin",
      keywords: ["吉事桔香茶", "桔香茶"],
      lastRunStatus: "completed",
      lastRunAt,
      lastRunMessage: "2 个关键词采集完成",
      lastRunProgress: {
        keywordCurrent: 2,
        keywordTotal: 2,
      },
    },
  );

  assert.equal(session.terminal, true);
  assert.equal(session.terminalRunAt, lastRunAt);
  assert.equal(session.progress.phase, "unattended_completed");
  assert.equal(session.progress.progressPercent, 100);
});
