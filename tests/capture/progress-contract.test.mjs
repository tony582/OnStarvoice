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

function evaluateSyntheticSessionBuilder({dismissedTerminalRunAt = ""} = {}) {
  const source = readSection(
    sidebarSource,
    "function buildUnattendedSyntheticDebugSession(",
    "function renderCaptureDebugSession(runtime = {})",
  );
  const context = {
    keywordPlanState: null,
    isKeywordPlanRunning: (plan = {}) =>
      ["started", "running", "recovering"].includes(
        String(plan?.lastRunStatus || ""),
      ),
    getPagePlatform: () => "xiaohongshu",
    supportsPersistentCaptureTaskPlatform: () => true,
    KEYWORD_PLAN_TERMINAL_STATUSES: new Set([
      "completed",
      "completed_with_failures",
      "failed",
      "canceled",
    ]),
    debugSessionDismissedUnattendedTerminalRunAt: dismissedTerminalRunAt,
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

function evaluateKeywordPlanRunning() {
  const source = readSection(
    sidebarSource,
    "function isKeywordPlanRunning(plan = {})",
    "function clearKeywordPlanProgressCountdown()",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.isKeywordPlanRunning = isKeywordPlanRunning;`,
    context,
  );
  return context.isKeywordPlanRunning;
}

function evaluateKeywordPlanProgressText() {
  const copySource = readSection(
    sidebarSource,
    "function getKeywordExecutionCopy(source = {})",
    "function buildKeywordRunDisplayPlan(",
  );
  const source = readSection(
    sidebarSource,
    "function buildKeywordPlanProgressText(plan = {})",
    "function renderKeywordPlanProgressText(progressText, plan = {})",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${copySource}\n${source}\nthis.buildKeywordPlanProgressText = buildKeywordPlanProgressText;`,
    context,
  );
  return context.buildKeywordPlanProgressText;
}

function evaluateTerminalProgressPhase() {
  const source = readSection(
    sidebarSource,
    "function isTerminalProgressPhase(phase)",
    "/**\n * 隐藏进度",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.isTerminalProgressPhase = isTerminalProgressPhase;`,
    context,
  );
  return context.isTerminalProgressPhase;
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
    "function isTerminalCaptureTaskView(progress = {}, session = {})",
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

test("recovering remains an active unattended state and progress copy is hierarchical", () => {
  const isKeywordPlanRunning = evaluateKeywordPlanRunning();
  assert.equal(isKeywordPlanRunning({lastRunStatus: "recovering"}), true);
  assert.equal(isKeywordPlanRunning({lastRunStatus: "completed"}), false);

  const buildKeywordPlanProgressText = evaluateKeywordPlanProgressText();
  const text = buildKeywordPlanProgressText({
    enabled: true,
    keywords: ["别克车机", "别克 OTA", "君威"],
    lastRunProgress: {
      keyword: "别克 OTA",
      keywordCurrent: 2,
      keywordTotal: 13,
      itemCurrent: 4,
      itemTotal: 50,
      current: 1,
      total: 2,
      message: "正在完善作品详情",
    },
  });
  assert.match(text, /关键词 2\/13/);
  assert.match(text, /「别克 OTA」/);
  assert.match(text, /当前词内作品 4\/50/);
  assert.doesNotMatch(text, /(?:^| · )1\/2(?: · |：)/);

  const oneTimeText = buildKeywordPlanProgressText({
    executionMode: "one_time",
    keywords: ["新店开业"],
    lastRunProgress: {
      keyword: "新店开业",
      keywordCurrent: 1,
      keywordTotal: 1,
      message: "正在采集列表",
    },
  });
  assert.match(oneTimeText, /^一次性采集 · /u);
  assert.doesNotMatch(oneTimeText, /无人值守/u);
});

test("streaming sync completion is a terminal progress phase", () => {
  const isTerminalProgressPhase = evaluateTerminalProgressPhase();
  assert.equal(isTerminalProgressPhase("streaming_sync_done"), true);
  assert.equal(isTerminalProgressPhase("streaming_sync_drain"), false);
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
  assert.match(
    planReporter,
    /next\.noEnhancement = Math\.max\(next\.noEnhancement, noEnhancement\)/,
    "a retry that reports zero must not erase already-settled no-enhancement items",
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
    candidateCount: 5,
    evaluatedCount: 3,
    failedOpenCount: 2,
    retryCount: 2,
    retriedItemCount: 5,
    timeoutCount: 2,
    taskMeta: {
      keywordList: ["别克车机", "别克壁纸"],
      searchFilters: {
        publishTime: "month",
        sortDimension: "latest",
      },
      enhancementEnabled: true,
      aiRelevancePrefilterEnabled: true,
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
    "candidateCount",
    "evaluatedCount",
    "failedOpenCount",
    "retryCount",
    "retriedItemCount",
    "timeoutCount",
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
      lastRunStatus: "running",
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
    /const session = usingTargetedSyntheticSession[\s\S]*?\? targetedSyntheticSession[\s\S]*?: usingUnattendedSyntheticSession[\s\S]*?\? unattendedSyntheticSession[\s\S]*?: nativeSession/,
  );
  assert.match(
    renderSection,
    /unattendedSyntheticSession &&[\s\S]*?\(!nativeVisible \|\| unattendedSyntheticSession\.terminal\)/,
  );
  assert.match(
    renderSection,
    /dismissedUnattendedNative[\s\S]*startsWith\("unattended-capture:"\)/,
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

test("unattended terminal state remains visible until explicitly dismissed", () => {
  const buildUnattendedSyntheticDebugSession =
    evaluateSyntheticSessionBuilder();
  const lastRunAt = "2026-01-01T00:00:00.000Z";
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

  const buildDismissedSession = evaluateSyntheticSessionBuilder({
    dismissedTerminalRunAt: lastRunAt,
  });
  assert.equal(
    buildDismissedSession(
      {lastActiveTabId: 88},
      {
        enabled: true,
        platform: "douyin",
        keywords: ["吉事桔香茶", "桔香茶"],
        lastRunStatus: "completed",
        lastRunAt,
      },
    ),
    null,
  );
});

test("terminal progress preserves final timing, sync and enhancement statistics", () => {
  const normalizeUnattendedRunProgress =
    evaluateBackgroundProgressNormalizer();
  const input = {
    current: 4,
    total: 4,
    phase: "unattended_completed_with_failures",
    captureTaskId: "unattended-capture:req-1",
    unattendedRequestId: "req-1",
    unattendedAttemptId: "attempt-2",
    finishedAt: "2026-07-19T04:40:00.000Z",
    keywordCompletedCount: 3,
    keywordPartialCount: 1,
    keywordFailedCount: 0,
    detailSuccessCount: 24,
    detailFailedCount: 1,
    aiFilteredCount: 5,
    noEnhancementCount: 2,
    syncSuccessCount: 30,
    syncFailedCount: 0,
    syncSkippedCount: 0,
    syncRemainingCount: 0,
    progressPercent: 100,
    taskMeta: {aiRelevancePrefilterEnabled: true},
  };
  const normalized = normalizeUnattendedRunProgress(input);
  for (const field of [
    "captureTaskId",
    "unattendedRequestId",
    "unattendedAttemptId",
    "finishedAt",
    "keywordCompletedCount",
    "keywordPartialCount",
    "keywordFailedCount",
    "detailSuccessCount",
    "detailFailedCount",
    "aiFilteredCount",
    "noEnhancementCount",
    "syncSuccessCount",
    "syncFailedCount",
    "syncSkippedCount",
    "syncRemainingCount",
    "progressPercent",
  ]) {
    assert.equal(normalized[field], input[field], `lost terminal field ${field}`);
  }
  assert.equal(normalized.taskMeta.aiRelevancePrefilterEnabled, true);

  const {buildCaptureTaskStats} = evaluateCaptureTaskProgressLabels();
  const stats = buildCaptureTaskStats(input);
  assert.match(stats, /完整完成 3 个词/);
  assert.match(stats, /部分完成 1 个词/);
  assert.doesNotMatch(stats, /失败 1 个词/);
  assert.match(stats, /作品失败 1 条/);
  assert.match(stats, /AI 跳过 5 条/);
  assert.match(stats, /无需增强 2 条/);
  assert.match(stats, /最终同步 30\/30 条/);
});

test("terminal synthetic session has stable identity and freezes at finishedAt", () => {
  const buildUnattendedSyntheticDebugSession =
    evaluateSyntheticSessionBuilder();
  const startedAt = "2026-07-19T04:00:00.000Z";
  const finishedAt = "2026-07-19T04:12:30.000Z";
  const session = buildUnattendedSyntheticDebugSession(
    {lastActiveTabId: 88},
    {
      enabled: true,
      platform: "xiaohongshu",
      keywords: ["词一", "词二"],
      lastRunStatus: "completed",
      lastRunAt: finishedAt,
      lastRunProgress: {
        captureTaskId: "unattended-capture:req-1",
        unattendedRequestId: "req-1",
        runStartedAt: startedAt,
        finishedAt,
        keywordCurrent: 2,
        keywordTotal: 2,
      },
    },
  );
  assert.equal(session.taskId, "unattended-capture:req-1");
  assert.equal(session.runId, "unattended-capture:req-1");
  assert.equal(session.startedAt, startedAt);
  assert.equal(session.finishedAt, finishedAt);
  assert.equal(session.progress.finishedAt, finishedAt);
  assert.equal(session.progress.itemCurrent, null);
  assert.equal(session.progress.nextKeyword, "");

  const clockSection = readSection(
    sidebarSource,
    "function updateDebugSessionClock()",
    "function stopDebugSessionClock()",
  );
  assert.match(clockSection, /const clockNow = terminal/);
  assert.match(clockSection, /parseCaptureTaskTime\(progress\.finishedAt\)/);
  assert.match(
    clockSection,
    /isTerminalCaptureTaskView\(progress, session\)[\s\S]*?clearInterval/,
  );
  const healthSection = readSection(
    sidebarSource,
    "function resolveCaptureTaskHealth(",
    "function resolveCaptureTaskActionCopy(",
  );
  assert.match(healthSection, /label: "已完成"/);
  assert.match(healthSection, /label: "已停止"/);
});

test("unattended terminal report owns the final structured progress snapshot", () => {
  const runSection = readSection(
    sidebarSource,
    "async function runUnattendedKeywordPlanRequest(request)",
    "async function runCaptureAction(",
  );
  assert.match(runSection, /progress: createTerminalProgress\(/);
  assert.match(
    runSection,
    /updateCaptureTaskSession\(\{[\s\S]*?progress: unattendedCaptureTaskTerminalProgress/,
  );
  assert.match(runSection, /warnings: stats\.partial/);
  assert.match(runSection, /processed:\s*stats\.success \+ stats\.partial/);

  const drainSection = readSection(
    sidebarSource,
    "async function drainStreamingDetailSyncQueue(",
    "async function handleBatchKeywordCapture(",
  );
  for (const field of [
    "syncSuccessCount",
    "syncFailedCount",
    "syncSkippedCount",
    "syncRemainingCount",
  ]) {
    assert.match(drainSection, new RegExp(`\\b${field}:`));
  }
});

test("terminal progress fences late unattended UI updates without blocking a new manual start", () => {
  const progressSection = readSection(
    sidebarSource,
    "function handleProgress(progress)",
    "async function syncRuntimeCommentProgress(",
  );
  assert.match(
    progressSection,
    /unattendedProgressState === "terminal" && !isTerminalPhase/,
  );
  assert.match(progressSection, /!suppressLateUnattendedUi/);

  const showSection = readSection(
    sidebarSource,
    "function showProgress(message, showUI = true)",
    "function hideProgressPanelOnly(",
  );
  assert.match(
    showSection,
    /if \(activeUnattendedRunRequestId\)[\s\S]*unattendedProgressState = "running"[\s\S]*else \{[\s\S]*delete progressContainer\.dataset\.unattendedProgressState/,
  );

  const planCleanupSection = readSection(
    sidebarSource,
    "function hideKeywordPlanProgressPanelIfOwned(",
    "function syncKeywordPlanProgressPanel(",
  );
  assert.match(
    planCleanupSection,
    /unattendedState === "running"[\s\S]*unattendedState === "terminal"/,
  );
  assert.match(planCleanupSection, /btnCancel\.hidden = true/);
  assert.match(planCleanupSection, /btnCancel\.disabled = true/);

  const genericCleanupSection = readSection(
    sidebarSource,
    "function hideProgressPanelOnly(",
    "function isTerminalProgressPhase(",
  );
  assert.match(
    genericCleanupSection,
    /preserveUnattendedTerminalState[\s\S]*unattendedProgressState === "terminal"/,
  );
  assert.match(genericCleanupSection, /btnCancel\.hidden = true/);
  assert.match(genericCleanupSection, /btnCancel\.disabled = true/);
});
