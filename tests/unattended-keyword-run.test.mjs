import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  advanceUnattendedCheckpointRound,
  findUnattendedResumeKeyword,
  isUnattendedSafetyBlock,
  mergeKeywordAttemptResults,
  normalizeUnattendedKeywordCheckpoint,
  reconcileEnhancementRetryCheckpoint,
  settleUnattendedKeywordCheckpoint,
  summarizeUnattendedKeywordCheckpoint,
} from "../utils/unattended-keyword-run.js";

const keywords = ["品牌", "竞品", "口碑"];

test("legacy checkpoint is normalized without inventing unknown keywords", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      checkpoint: {
        round: 2,
        keywordResults: [
          {round: 1, keyword: "品牌", status: "completed", attemptCount: 1},
          {round: 1, keyword: "不存在", status: "completed"},
        ],
      },
    },
    keywords,
  );

  assert.equal(checkpoint.round, 2);
  assert.deepEqual(checkpoint.keywordResults.map((entry) => entry.keyword), ["品牌"]);
});

test("checkpoint round and indexes are bounded by the current plan", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      round: 999,
      activeKeyword: "竞品",
      activeKeywordIndex: 999,
      keywordResults: [
        {round: 999, keyword: "品牌", status: "completed", index: 999},
        {round: 1, keyword: "竞品", status: "completed", index: 999},
      ],
    },
    keywords,
    {maxRounds: 1},
  );

  assert.equal(checkpoint.round, 1);
  assert.equal(checkpoint.activeKeywordIndex, 1);
  assert.deepEqual(checkpoint.keywordResults, [
    {
      round: 1,
      index: 1,
      keyword: "竞品",
      status: "completed",
      attemptCount: 0,
      savedCount: 0,
      error: "",
      finishedAt: "",
    },
  ]);
});

test("resume re-searches the first unfinished keyword instead of using a DOM index", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      checkpoint: {
        round: 1,
        keywordResults: [
          {round: 1, keyword: "品牌", status: "completed", attemptCount: 1},
          {round: 1, keyword: "竞品", status: "partial", attemptCount: 1},
        ],
      },
    },
    keywords,
  );

  assert.equal(findUnattendedResumeKeyword(checkpoint, keywords), "竞品");
});

test("exhausted failed keyword is skipped when selecting a resume boundary", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      checkpoint: {
        round: 1,
        keywordResults: [
          {round: 1, keyword: "品牌", status: "completed", attemptCount: 1},
          {round: 1, keyword: "竞品", status: "failed", attemptCount: 2},
        ],
      },
    },
    keywords,
  );

  assert.equal(findUnattendedResumeKeyword(checkpoint, keywords), "口碑");
});

test("resume selector returns empty when every keyword is settled", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      round: 1,
      keywordResults: [
        {round: 1, keyword: "品牌", status: "completed", attemptCount: 1},
        {round: 1, keyword: "竞品", status: "failed", attemptCount: 2},
        {round: 1, keyword: "口碑", status: "completed", attemptCount: 1},
      ],
    },
    keywords,
  );

  assert.equal(findUnattendedResumeKeyword(checkpoint, keywords), "");
});

test("a completed round advances the durable resume boundary before its gap", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      round: 1,
      keywordResults: keywords.map((keyword, index) => ({
        round: 1,
        index,
        keyword,
        status: "completed",
        attemptCount: 1,
      })),
    },
    keywords,
    {maxRounds: 3},
  );

  assert.equal(findUnattendedResumeKeyword(checkpoint, keywords), "");
  const advanced = advanceUnattendedCheckpointRound({
    checkpoint,
    keywords,
    completedRound: 1,
    maxRounds: 3,
    now: new Date("2026-07-16T02:00:00.000Z"),
  });

  assert.equal(advanced.round, 2);
  assert.equal(advanced.activePhase, "waiting_next_round");
  assert.equal(findUnattendedResumeKeyword(advanced, keywords), "品牌");
  assert.equal(
    advanced.keywordResults.filter((entry) => entry.round === 1).length,
    keywords.length,
  );
});

test("settled checkpoint advances only after a keyword result is available", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint({}, keywords);
  const settled = settleUnattendedKeywordCheckpoint({
    checkpoint,
    keywords,
    round: 1,
    originalIndex: 0,
    keyword: "品牌",
    result: {ok: true},
    recordIds: ["record-1", "record-2"],
    attempt: 1,
    now: new Date("2026-07-16T01:00:00.000Z"),
  });

  assert.equal(settled.entry.status, "completed");
  assert.equal(settled.entry.savedCount, 2);
  assert.equal(settled.checkpoint.activeKeyword, "品牌");
  assert.equal(settled.summary.completed, 1);
});

test("a later failed attempt does not erase an earlier saved count", () => {
  const first = settleUnattendedKeywordCheckpoint({
    checkpoint: normalizeUnattendedKeywordCheckpoint({}, keywords),
    keywords,
    keyword: "品牌",
    result: {ok: false, error: "temporary"},
    recordIds: ["record-1", "record-2"],
    attempt: 1,
    maxAttempts: 2,
  });
  const second = settleUnattendedKeywordCheckpoint({
    checkpoint: first.checkpoint,
    keywords,
    keyword: "品牌",
    result: {ok: false, error: "still failing"},
    recordIds: [],
    attempt: 2,
    maxAttempts: 2,
  });

  assert.equal(second.entry.savedCount, 2);
});

test("partial comments remain retryable instead of becoming completed", () => {
  const settled = settleUnattendedKeywordCheckpoint({
    checkpoint: normalizeUnattendedKeywordCheckpoint({}, keywords),
    keywords,
    keyword: "品牌",
    result: {
      ok: true,
      commentsResult: {phase: "comments_partial"},
    },
    recordIds: ["record-1"],
  });

  assert.equal(settled.entry.status, "partial");
  assert.equal(findUnattendedResumeKeyword(settled.checkpoint, keywords), "品牌");
});

test("partial work becomes bounded failure after the retry budget", () => {
  const first = settleUnattendedKeywordCheckpoint({
    checkpoint: normalizeUnattendedKeywordCheckpoint({}, keywords),
    keywords,
    keyword: "品牌",
    result: {ok: true, partial: true},
    attempt: 1,
    maxAttempts: 2,
  });
  const second = settleUnattendedKeywordCheckpoint({
    checkpoint: first.checkpoint,
    keywords,
    keyword: "品牌",
    result: {ok: true, partial: true},
    attempt: 2,
    maxAttempts: 2,
  });

  assert.equal(first.entry.status, "partial");
  assert.equal(second.entry.status, "failed");
  assert.equal(findUnattendedResumeKeyword(second.checkpoint, keywords), "竞品");
});

test("a legacy or user-canceled partial checkpoint stays manually resumable", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      round: 1,
      keywordResults: [
        {round: 1, keyword: "品牌", status: "partial", attemptCount: 2},
      ],
    },
    keywords,
  );

  assert.equal(findUnattendedResumeKeyword(checkpoint, keywords), "品牌");
});

test("failed keyword becomes terminal for the keyword only after retry budget", () => {
  const first = settleUnattendedKeywordCheckpoint({
    checkpoint: normalizeUnattendedKeywordCheckpoint({}, keywords),
    keywords,
    keyword: "品牌",
    result: {ok: false, error: "timeout"},
    attempt: 1,
    maxAttempts: 2,
  });
  const second = settleUnattendedKeywordCheckpoint({
    checkpoint: first.checkpoint,
    keywords,
    keyword: "品牌",
    result: {ok: false, error: "timeout"},
    attempt: 2,
    maxAttempts: 2,
  });

  assert.equal(first.entry.status, "retrying");
  assert.equal(second.entry.status, "failed");
  assert.equal(second.entry.attemptCount, 2);
  assert.equal(summarizeUnattendedKeywordCheckpoint(second.checkpoint).retries, 1);
});

test("retry merge keeps a successful result even if a stale failure follows", () => {
  const merged = mergeKeywordAttemptResults({
    previous: {results: [{keyword: "品牌", ok: true}]},
    next: {results: [{keyword: "品牌", ok: false, error: "late"}]},
    allKeywords: ["品牌"],
  });

  assert.equal(merged.stats.success, 1);
  assert.equal(merged.stats.failed, 0);
  assert.equal(merged.results[0].ok, true);
});

test("successful enhancement retry reconciles partial keyword without consuming another keyword attempt", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      round: 1,
      keywordResults: [
        {
          round: 1,
          keyword: "品牌",
          status: "partial",
          attemptCount: 1,
          savedCount: 2,
        },
      ],
    },
    keywords,
  );
  const batchResults = [
    {
      keyword: "品牌",
      ok: true,
      partial: true,
      enhanceStatus: "failed",
      recordIds: ["record-1", "record-2"],
      enhanceResult: {
        results: [{recordId: "record-2", ok: false}],
      },
    },
  ];

  const reconciled = reconcileEnhancementRetryCheckpoint({
    checkpoint,
    keywords,
    round: 1,
    batchResults,
    successRecordIds: ["record-2"],
    now: new Date("2026-07-16T02:00:00.000Z"),
  });

  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.checkpoint.keywordResults[0].status, "completed");
  assert.equal(reconciled.checkpoint.keywordResults[0].attemptCount, 1);
  assert.equal(batchResults[0].enhanceStatus, "done");
  assert.equal(batchResults[0].partial, false);
});

test("enhancement retry keeps checkpoint partial when any failed record remains", () => {
  const checkpoint = normalizeUnattendedKeywordCheckpoint(
    {
      round: 1,
      keywordResults: [
        {round: 1, keyword: "品牌", status: "partial", attemptCount: 1},
      ],
    },
    keywords,
  );
  const reconciled = reconcileEnhancementRetryCheckpoint({
    checkpoint,
    keywords,
    round: 1,
    batchResults: [
      {
        keyword: "品牌",
        enhanceStatus: "failed",
        enhanceResult: {
          results: [
            {recordId: "record-1", ok: false},
            {recordId: "record-2", ok: false},
          ],
        },
      },
    ],
    successRecordIds: ["record-1"],
  });

  assert.equal(reconciled.changed, false);
  assert.equal(reconciled.checkpoint.keywordResults[0].status, "partial");
});

test("platform safety signals are circuit breakers", () => {
  assert.equal(isUnattendedSafetyBlock("请完成验证码后继续"), true);
  assert.equal(isUnattendedSafetyBlock({message: "login required"}), true);
  assert.equal(isUnattendedSafetyBlock("请重新登录后继续"), true);
  assert.equal(isUnattendedSafetyBlock("账号触发安全验证"), true);
  assert.equal(isUnattendedSafetyBlock({code: "ACCOUNT_FORBIDDEN"}), true);
  assert.equal(isUnattendedSafetyBlock("导航超时"), false);
});

test("round-level orchestration cannot start a second enhancement retry budget", async () => {
  const source = await readFile(
    new URL("../sidebar/sidebar-logic.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /retryFailedEnhancementsAfterRound|collectFailedEnhanceRecordIds/,
    "all enhancement retries must stay inside runEnhancementWithSingleRetry",
  );
  assert.match(source, /runEnhancementWithSingleRetry\(\{/);
});

test("a stale attempt never emits an unscoped content cancel that can hit its successor", async () => {
  const source = await readFile(
    new URL("../sidebar/sidebar-logic.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function stopRejectedUnattendedAttempt");
  const end = source.indexOf("async function reportUnattendedKeywordRun", start);
  const functionSource = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(functionSource, /requestCaptureCancelSignal/);
  assert.match(functionSource, /batchKeywordCancelRequested = true/);
});

test("content capture progress refreshes the active unattended business clock", async () => {
  const source = await readFile(
    new URL("../sidebar/sidebar-logic.js", import.meta.url),
    "utf8",
  );
  const handlerStart = source.indexOf("function handleProgress(progress)");
  const handlerEnd = source.indexOf("\n}", handlerStart) + 2;
  const handlerSource = source.slice(handlerStart, handlerEnd);

  assert.match(source, /function reportActiveUnattendedContentProgress/);
  assert.match(handlerSource, /reportActiveUnattendedContentProgress\(progress\)/);
  assert.match(source, /progressSeq: activeUnattendedProgressSeq/);
});

test("unattended lock loss never emits an unscoped cancel into a successor attempt", async () => {
  const source = await readFile(
    new URL("../sidebar/sidebar-logic.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function handleCaptureExecutionLockLost");
  const end = source.indexOf("async function renewCaptureExecutionLock", start);
  const functionSource = source.slice(start, end);

  assert.match(functionSource, /if \(!activeUnattendedRunRequestId\)/);
  assert.match(functionSource, /requestCaptureCancelSignal/);
});

test("attempt replacement between navigation and delegation stops before batch capture", async () => {
  const source = await readFile(
    new URL("../sidebar/sidebar-logic.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const delegatedReport = await reportUnattendedKeywordRun[\s\S]*if \(!delegatedReport\?\.accepted\)/,
  );
  assert.match(
    source,
    /executionLockOwner === "unattended_keyword_plan" &&\s*activeUnattendedAttemptRejected/,
  );
});

test("runner refresh honors the durable wait boundary before restarting the batch", async () => {
  const source = await readFile(
    new URL("../sidebar/sidebar-logic.js", import.meta.url),
    "utf8",
  );
  const claimStart = source.indexOf("async function maybeClaimAndRunUnattendedKeywordPlan");
  const claimEnd = source.indexOf("function buildSidebarKeywordSearchUrl", claimStart);
  const claimSource = source.slice(claimStart, claimEnd);

  assert.match(source, /async function waitForUnattendedProtectedStart/);
  assert.match(claimSource, /await waitForUnattendedProtectedStart\(response\.data/);
  assert.match(source, /waitUntil:\s*Number\.isFinite/);
  assert.match(source, /phase: "protected_wait_complete"/);
  assert.match(
    claimSource,
    /holderId:\s*CAPTURE_EXECUTION_LOCK_HOLDER_ID/,
  );
  assert.match(
    claimSource,
    /adoptUnattendedCaptureExecutionLock\(response\.lock\)/,
  );
  const acquireStart = source.indexOf("async function acquireCaptureExecutionLock");
  const acquireEnd = source.indexOf(
    "function stopCaptureExecutionLockHeartbeat",
    acquireStart,
  );
  const acquireSource = source.slice(acquireStart, acquireEnd);
  assert.match(
    acquireSource,
    /adoptedUnattendedCaptureExecutionLockId === activeCaptureExecutionLockId/,
  );
  assert.match(
    acquireSource,
    /validateAdoptedUnattendedCaptureExecutionLock/,
  );
  assert.match(
    claimSource,
    /previous_capture_stop_unconfirmed/,
  );
  assert.match(claimSource, /capture_lock_conflict/);
});

test("canceled request storage changes only stop local orchestration", async () => {
  const source = await readFile(
    new URL("../sidebar/sidebar-logic.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function handleUnattendedRunRequestStorageChange");
  const end = source.indexOf("async function handleSaveKeywordPlan", start);
  const functionSource = source.slice(start, end);

  assert.match(functionSource, /batchKeywordCancelRequested = true/);
  assert.doesNotMatch(functionSource, /requestCaptureCancelSignal/);
});
