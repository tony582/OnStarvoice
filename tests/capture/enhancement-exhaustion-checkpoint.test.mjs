import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  findUnattendedResumeKeyword,
  normalizeUnattendedKeywordCheckpoint,
  runUnattendedKeywordAttempts,
  settleUnattendedKeywordCheckpoint,
} from "../../utils/unattended-keyword-run.js";

const EXHAUSTED = "ENHANCEMENT_RETRY_EXHAUSTED";
const keywords = ["至境哨兵", "普通超时", "已完成"];
const backgroundSource = await readFile(new URL("../../background.js", import.meta.url), "utf8");
const start = backgroundSource.indexOf("function normalizeUnattendedEnhancementFailure(");
const end = backgroundSource.indexOf("function buildUnattendedTaskCounts(", start);
assert.ok(start >= 0 && end > start, "the real background checkpoint functions must exist");
const background = vm.createContext({});
vm.runInContext(`${backgroundSource.slice(start, end)}\nthis.checkpoint = buildTaskCenterCheckpointFromUnattendedRequest;\nthis.evidence = normalizeUnattendedEnhancementFailure;`, background);
const plain = value => JSON.parse(JSON.stringify(value));
const project = checkpoint => plain(background.checkpoint({checkpoint}));
const evidence = {
  version: 1,
  failedRecordIds: ["record-2", "record-3"],
  failedTargets: [
    {recordId: "record-2", externalId: "7704843464386924651",
      url: "https://www.douyin.com/video/7704843464386924651", platform: "douyin", stage: "comments"},
  ],
  savedDetailRecordIds: ["record-1", "record-2", "record-3"],
  failureStages: ["comments"],
  autoRetryCount: 1,
  budgetStopReason: "keyword_retry_budget",
};

function settledExhaustion(enhancementFailure = evidence) {
  return settleUnattendedKeywordCheckpoint({
    keywords,
    keyword: keywords[0],
    result: {ok: false, partial: true, enhanceStatus: "failed",
      error: {code: EXHAUSTED, message: "采集增强未完整完成"}, enhancementFailure},
    recordIds: ["record-1", "record-2", "record-3"],
    attempt: 1,
    maxAttempts: 4,
    now: new Date("2026-11-06T02:42:33.000Z"),
  });
}

test("exhausted enhancement keeps its exact code and record evidence through settlement, background and JSON restore", () => {
  const settled = settledExhaustion();
  assert.equal(settled.entry.status, "failed");
  assert.equal(settled.entry.attemptCount, 1);
  assert.equal(settled.entry.retryable, false);
  assert.equal(settled.entry.errorCode, EXHAUSTED);
  assert.deepEqual(settled.entry.enhancementFailure, evidence);

  const wire = project(normalizeUnattendedKeywordCheckpoint(settled.checkpoint, keywords));
  assert.deepEqual(wire.failedKeywords, [keywords[0]]);
  assert.deepEqual(wire.completedKeywords, []);
  assert.deepEqual(wire.keywordResults[0].enhancementFailure, evidence);
  const restored = normalizeUnattendedKeywordCheckpoint({checkpoint: plain(wire)}, keywords);
  const entry = restored.keywordResults[0];
  assert.equal(entry.status, "failed");
  assert.equal(entry.errorCode, EXHAUSTED);
  assert.equal(entry.retryable, false);
  assert.equal(entry.savedCount, 3, "already collected detail evidence must survive the failed enhancement");
  assert.equal(entry.finishedAt, "2026-11-06T02:42:33.000Z");
  assert.deepEqual(entry.enhancementFailure, evidence);
  assert.deepEqual(project(restored).keywordResults, wire.keywordResults, "another report/restore cycle is stable");
  assert.equal(findUnattendedResumeKeyword(restored, keywords, {maxAttempts: 4}), keywords[1]);
});

test("both checkpoint boundaries bound failure evidence and reject non-finite retry counters", () => {
  const oversized = {
    ...evidence,
    failedRecordIds: ["  ", null, "same", "same", ...Array.from({length: 1100}, (_, i) => `${i}-${"x".repeat(300)}`)],
    savedDetailRecordIds: Array.from({length: 1100}, (_, i) => `${i}-${"y".repeat(300)}`),
    failureStages: ["comments".repeat(40)],
    autoRetryCount: Infinity,
    budgetStopReason: "budget".repeat(40),
    unboundedDebugBlob: "discard me",
  };
  const entry = settledExhaustion(oversized).entry;
  const normalized = entry.enhancementFailure;
  assert.equal(normalized.failedRecordIds.length, 1000);
  assert.equal(normalized.savedDetailRecordIds.length, 1000);
  assert.ok(normalized.failedRecordIds.every(id => id.length <= 200));
  assert.ok(normalized.savedDetailRecordIds.every(id => id.length <= 200));
  assert.deepEqual(normalized.failedRecordIds.slice(0, 2), ["same", `0-${"x".repeat(198)}`]);
  assert.equal(normalized.failureStages[0].length, 80);
  assert.equal(normalized.budgetStopReason.length, 80);
  assert.equal(normalized.autoRetryCount, 0);
  assert.equal(normalized.unboundedDebugBlob, undefined);
  assert.deepEqual(plain(background.evidence(oversized)), normalized);
  assert.deepEqual(project({keywordResults: [{...entry, enhancementFailure: oversized}]}).keywordResults[0].enhancementFailure, normalized);
  for (const count of [undefined, NaN, Infinity, -Infinity, -3, "not-a-number", 2.8]) {
    const expected = count === 2.8 ? 2 : 0;
    assert.equal(settledExhaustion({...evidence, autoRetryCount: count}).entry.enhancementFailure.autoRetryCount, expected);
    assert.equal(background.evidence({...evidence, autoRetryCount: count}).autoRetryCount, expected);
  }
});

test("malformed evidence does not create a checkpoint payload or erase the terminal error", () => {
  for (const invalid of [null, "bad", [], {version: 2}, {version: "unsupported"}]) {
    const {checkpoint, entry} = settledExhaustion(invalid);
    assert.equal(entry.enhancementFailure, undefined);
    assert.equal(project(checkpoint).keywordResults[0].enhancementFailure, undefined);
    assert.equal(background.evidence(invalid), null);
    assert.equal(entry.errorCode, EXHAUSTED);
    assert.equal(entry.retryable, false);
  }
  assert.deepEqual(normalizeUnattendedKeywordCheckpoint({keywordResults: [null, undefined, {}]}, keywords).keywordResults, []);
});

test("keyword retry queue never repeats an exhausted enhancement even if a retry selector offers it again", async () => {
  const calls = [];
  const scheduled = [];
  const exhausted = {keyword: keywords[0], ok: false, errorCode: EXHAUSTED, enhancementFailure: evidence};
  const result = await runUnattendedKeywordAttempts({
    allKeywords: keywords,
    maxAttempts: 4,
    runAttempt: async ({keywords: pending}) => {
      calls.push(pending);
      return {results: calls.length === 1
        ? [exhausted, {keyword: keywords[1], ok: false, errorCode: "NAVIGATION_TIMEOUT"}, {keyword: keywords[2], ok: true}]
        : [{keyword: keywords[1], ok: true}]};
    },
    selectRetryKeywords: ({keywords: failed, attempt}) => attempt === 1 ? [...failed, keywords[0]] : failed,
    onRetryScheduled: ({keywords: pending}) => scheduled.push(pending),
  });
  assert.deepEqual(calls, [keywords, [keywords[1]]]);
  assert.deepEqual(scheduled, [[keywords[1]]]);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.result.stats, {total: 3, processed: 3, success: 2, failed: 1});
  assert.deepEqual(result.result.results.find(row => row.keyword === keywords[0]), exhausted);
});

test("only the dedicated exhaustion code suppresses full keyword retry and resume", async () => {
  for (const errorCode of [EXHAUSTED, "ENHANCEMENT_RETRY_EXHAUSTED_OTHER", "DETAIL_TIMEOUT"]) {
    const calls = [];
    const result = await runUnattendedKeywordAttempts({
      allKeywords: [keywords[0]], maxAttempts: 2,
      runAttempt: async ({keywords: pending}) => {
        calls.push(pending);
        return {results: [{keyword: keywords[0], ok: calls.length > 1, error: {code: errorCode}}]};
      },
    });
    assert.equal(calls.length, errorCode === EXHAUSTED ? 1 : 2, errorCode);
    assert.equal(result.result.ok, errorCode !== EXHAUSTED, errorCode);
    const settled = settleUnattendedKeywordCheckpoint({keywords, keyword: keywords[0],
      attempt: 1, maxAttempts: 4, result: {ok: false, error: {code: errorCode}}});
    const restored = normalizeUnattendedKeywordCheckpoint({checkpoint: project(settled.checkpoint)}, keywords);
    assert.equal(findUnattendedResumeKeyword(restored, keywords, {maxAttempts: 4}),
      errorCode === EXHAUSTED ? keywords[1] : keywords[0], errorCode);
  }
});

test("malformed attempt results and null rows cannot crash the exhaustion filter", async () => {
  for (const results of [undefined, null, {}, "bad", [null, undefined]]) {
    let calls = 0;
    await runUnattendedKeywordAttempts({allKeywords: [keywords[0]],
      runAttempt: async () => { calls += 1; return {results}; }});
    assert.equal(calls, 1);
  }
  let calls = 0;
  await runUnattendedKeywordAttempts({allKeywords: [keywords[0]], maxAttempts: 2,
    runAttempt: async () => ({results: [null, {keyword: keywords[0], ok: ++calls > 1, errorCode: "DETAIL_TIMEOUT"}]})});
  assert.equal(calls, 2, "a normal failed row still retries alongside malformed rows");
});
