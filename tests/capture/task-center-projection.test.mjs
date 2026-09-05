import assert from "node:assert/strict";
import test from "node:test";

await import("../../utils/capture/task-center-projection.js");

const projection = globalThis.OnStarvoiceCaptureTaskCenterProjection;
const {
  buildTaskCenterCheckpointFromUnattendedRequest: checkpoint,
  buildUnattendedTaskCounts: counts,
} = projection;

const emptyCheckpoint = {
  round: 1,
  keywordIndex: 0,
  currentKeyword: "",
  phase: "",
  completedKeywords: [],
  failedKeywords: [],
  skippedKeywords: [],
  keywordResults: [],
  attempts: {},
};
const emptyCounts = {
  total: 0, processed: 0, saved: 0, success: 0,
  failed: 0, skipped: 0, retried: 0, warnings: 0,
};

test("task-center projection exposes exactly the two extracted pure helpers", () => {
  assert.deepEqual(Object.keys(projection).sort(), [
    "buildTaskCenterCheckpointFromUnattendedRequest",
    "buildUnattendedTaskCounts",
  ]);
  assert.equal(typeof checkpoint, "function");
  assert.equal(typeof counts, "function");
});

test("missing or legacy non-object checkpoints and counts preserve the complete default shape", () => {
  for (const request of [undefined, null, {}, {checkpoint: "legacy"}, {checkpoint: null}]) {
    assert.deepEqual(checkpoint(request), emptyCheckpoint);
  }
  for (const request of [undefined, null, {}, {counts: "legacy", summary: false}]) {
    assert.deepEqual(counts(request), emptyCounts);
    assert.deepEqual(counts(request, null), emptyCounts);
  }
});

test("checkpoint position and phase preserve their different nullish and truthy fallback rules", () => {
  const cases = [
    {
      source: {round: "2.5", keywordIndex: "3.5", currentKeyword: "current", phase: "phase"},
      expected: {round: 2.5, keywordIndex: 3.5, currentKeyword: "current", phase: "phase"},
    },
    {
      source: {round: -2, keywordIndex: null, activeKeywordIndex: "7", activeKeyword: "active", activePhase: "active-phase"},
      expected: {round: 1, keywordIndex: 7, currentKeyword: "active", phase: "active-phase"},
    },
    {
      source: {round: "invalid", keywordIndex: 0, activeKeywordIndex: 7, currentKeyword: "", phase: ""},
      expected: {round: 1, keywordIndex: 0, currentKeyword: "progress", phase: "progress-phase"},
    },
    {
      source: {keywordIndex: "invalid", activeKeywordIndex: 7, currentKeyword: " ", phase: " "},
      expected: {round: 1, keywordIndex: 0, currentKeyword: " ", phase: " "},
    },
  ];
  for (const {source, expected} of cases) {
    assert.deepEqual(checkpoint({
      checkpoint: source,
      progress: {keyword: "progress", phase: "progress-phase"},
    }), {...emptyCheckpoint, ...expected});
  }
});

test("each projected keyword result keeps every existing field and normalization rule", () => {
  const entry = Object.freeze({
    round: "2.5",
    index: "3.5",
    keyword: " alpha ",
    status: "partial",
    attemptCount: "4.9",
    savedCount: "5.5",
    noResults: true,
    resultKind: " empty ",
    candidateCount: "6.2",
    scanComplete: true,
    error: " failure ",
    errorCode: " CODE ",
    errorCategory: " category ",
    securityBlocked: true,
    requiresManualAction: true,
    finishedAt: " raw-time ",
    unprojected: "not-part-of-the-ledger-contract",
  });
  const result = checkpoint({checkpoint: {keywordResults: Object.freeze([entry])}});
  assert.deepEqual(result.keywordResults, [{
    round: 2.5,
    index: 3.5,
    keyword: "alpha",
    status: "partial",
    attemptCount: 4.9,
    savedCount: 5.5,
    noResults: true,
    resultKind: "empty",
    candidateCount: 6.2,
    scanComplete: true,
    error: "failure",
    errorCode: "CODE",
    errorCategory: "category",
    securityBlocked: true,
    requiresManualAction: true,
    finishedAt: " raw-time ",
  }]);
  assert.deepEqual(result.failedKeywords, ["alpha"]);
  assert.deepEqual(result.attempts, {alpha: 4.9});
  assert.notEqual(result.keywordResults[0], entry);
  assert.equal(entry.keyword, " alpha ");
});

test("malformed result rows remain bounded defaults and booleans require literal true", () => {
  const result = checkpoint({checkpoint: {keywordResults: [null, {
    round: -1, index: -2, keyword: "beta", status: "failed",
    attemptCount: "invalid", savedCount: -3, candidateCount: -4,
    noResults: "true", scanComplete: 1, securityBlocked: "true", requiresManualAction: 1,
  }]}});
  const defaultRow = {
    round: 1, index: 0, keyword: "", status: "", attemptCount: 0,
    savedCount: 0, noResults: false, resultKind: "", candidateCount: 0,
    scanComplete: false, error: "", errorCode: "", errorCategory: "",
    securityBlocked: false, requiresManualAction: false, finishedAt: "",
  };
  assert.deepEqual(result.keywordResults, [
    defaultRow,
    {...defaultRow, keyword: "beta", status: "failed"},
  ]);
  assert.deepEqual(result.attempts, {beta: 0});
});

test("duplicate keywords deduplicate each outcome list while the last input row owns the attempts value", () => {
  const result = checkpoint({checkpoint: {keywordResults: [
    {keyword: " alpha ", round: 4, status: "completed", attemptCount: 8},
    {keyword: "beta", round: 2, status: "completed", attemptCount: 2},
    {keyword: "alpha", round: 4, status: "partial", attemptCount: 5},
    {keyword: "alpha", round: 1, status: "skipped", attemptCount: 1},
    {keyword: "beta", round: 2, status: "completed", attemptCount: 3},
  ]}});
  assert.deepEqual(result.completedKeywords, ["alpha", "beta"]);
  assert.deepEqual(result.failedKeywords, ["alpha"]);
  assert.deepEqual(result.skippedKeywords, ["alpha"]);
  assert.deepEqual(result.attempts, {alpha: 1, beta: 3});
  assert.deepEqual(result.keywordResults.map(row => row.round), [4, 2, 4, 1, 2]);
});

test("outcome aggregation uses exact original statuses even though displayed row statuses are trimmed", () => {
  const result = checkpoint({checkpoint: {keywordResults: [
    {keyword: "spaced", status: " completed "},
    {keyword: "uppercase", status: "COMPLETED"},
    {keyword: "exact", status: "completed"},
  ]}});
  assert.deepEqual(result.completedKeywords, ["exact"]);
  assert.equal(result.keywordResults[0].status, "completed");
  assert.equal(result.keywordResults[1].status, "COMPLETED");
});

test("the 500-row display cap does not truncate outcome collection or later attempts overwrites", () => {
  const keywordResults = Array.from({length: 500}, (_, index) => ({
    keyword: `keyword-${index}`, status: "pending", attemptCount: 1,
  }));
  keywordResults.push(
    {keyword: "keyword-0", status: "completed", attemptCount: 9},
    {keyword: "after-cap", status: "partial", attemptCount: 7},
    {keyword: "after-cap-skipped", status: "skipped", attemptCount: 2},
  );
  const result = checkpoint({checkpoint: {keywordResults}});
  assert.equal(result.keywordResults.length, 500);
  assert.equal(result.keywordResults[0].attemptCount, 1);
  assert.equal(result.keywordResults.at(-1).keyword, "keyword-499");
  assert.deepEqual(result.completedKeywords, ["keyword-0"]);
  assert.deepEqual(result.failedKeywords, ["after-cap"]);
  assert.deepEqual(result.skippedKeywords, ["after-cap-skipped"]);
  assert.equal(result.attempts["keyword-0"], 9);
  assert.equal(result.attempts["after-cap"], 7);
  assert.equal(result.attempts["after-cap-skipped"], 2);
  assert.equal(Object.keys(result.attempts).length, 502);
  assert.equal(keywordResults.length, 503);
});

test("legacy checkpoint arrays and attempts retain their original references when detailed results are absent", () => {
  const source = Object.freeze({
    keywordResults: Object.freeze([]),
    completedKeywords: Object.freeze([" legacy ", " legacy "]),
    failedKeywords: Object.freeze(["failed"]),
    skippedKeywords: Object.freeze(["skipped"]),
    attempts: Object.freeze({legacy: "3.5"}),
  });
  const result = checkpoint({checkpoint: source});
  for (const field of ["completedKeywords", "failedKeywords", "skippedKeywords", "attempts"]) {
    assert.equal(result[field], source[field], field);
  }
  assert.notEqual(result.keywordResults, source.keywordResults);
  const legacyAttemptsArray = Object.freeze([1, 2]);
  assert.equal(checkpoint({checkpoint: {attempts: legacyAttemptsArray}}).attempts, legacyAttemptsArray);
  assert.deepEqual(checkpoint({checkpoint: {
    completedKeywords: "legacy", failedKeywords: {}, skippedKeywords: false, attempts: null,
  }}), emptyCheckpoint);
});

test("a nonempty detailed-result array supersedes legacy aggregates even when its rows are empty", () => {
  const result = checkpoint({checkpoint: {
    keywordResults: [null],
    completedKeywords: ["old-completed"],
    failedKeywords: ["old-failed"],
    skippedKeywords: ["old-skipped"],
    attempts: {old: 5},
  }});
  assert.deepEqual(result.completedKeywords, []);
  assert.deepEqual(result.failedKeywords, []);
  assert.deepEqual(result.skippedKeywords, []);
  assert.deepEqual(result.attempts, {});
  assert.equal(result.keywordResults.length, 1);
});

test("explicit counts outrank summary aliases and partial results remain warnings", () => {
  const summary = {
    total: 20, processed: 12, saved: 8,
    success: 6, completed: 99, failed: 2, skipped: 1,
    partial: 3, warnings: 99, retries: 4, retried: 99,
  };
  assert.deepEqual(counts({summary}), {
    total: 20, processed: 12, saved: 8, success: 6,
    failed: 2, skipped: 1, retried: 4, warnings: 3,
  });
  assert.deepEqual(counts({
    summary,
    counts: {total: 50, processed: 40, saved: 30, success: 10, failed: 9, skipped: 8, retried: 7, warnings: 6},
  }), {
    total: 50, processed: 40, saved: 30, success: 10,
    failed: 9, skipped: 8, retried: 7, warnings: 6,
  });
  assert.deepEqual(counts({summary: {total: 4, completed: 2, partial: 1, skipped: 1}}), {
    total: 4, processed: 4, saved: 0, success: 2,
    failed: 0, skipped: 1, retried: 0, warnings: 1,
  });
});

test("count conversion preserves numeric priority, legacy null fallbacks and unfloored previous counts", () => {
  const cases = [
    {value: "3.9", summary: 99, previous: 7, expected: 3},
    {value: -3, summary: 99, previous: 7, expected: 0},
    {value: "", summary: 99, previous: 7, expected: 0},
    {value: false, summary: 99, previous: 7, expected: 0},
    {value: true, summary: 99, previous: 7, expected: 1},
    {value: "invalid", summary: "8.9", previous: 7, expected: 8},
    {value: Infinity, summary: NaN, previous: 2.7, expected: 2.7},
    {value: null, summary: 99, previous: 2.7, expected: 2.7},
    {value: undefined, summary: null, previous: 2.7, expected: 2.7},
    {value: undefined, summary: undefined, previous: -2, expected: 0},
    {value: undefined, summary: undefined, previous: "invalid", expected: 0},
  ];
  for (const {value, summary, previous, expected} of cases) {
    assert.equal(counts({counts: {saved: value}, summary: {saved: summary}}, {
      saved: previous,
    }).saved, expected, JSON.stringify({value, summary, previous}));
  }
  assert.equal(counts({summary: {success: null, completed: 99}}, {success: 4}).success, 4);
  assert.equal(counts({summary: {partial: null, warnings: 99}}, {warnings: 5}).warnings, 5);
});

test("processed falls back from zero to outcome totals, caps only the derived value, and treats total zero as unknown", () => {
  const outcomes = {success: 3, failed: 2, skipped: 1, warnings: 1};
  const cases = [
    {total: 10, processed: 0, expected: 7},
    {total: 4, processed: 0, expected: 4},
    {total: 0, processed: 0, expected: 7},
    {total: 4, processed: 50, expected: 50},
    {total: 10, processed: "2.9", expected: 2},
    {total: 10, processed: -2, expected: 7},
  ];
  for (const {total, processed, expected} of cases) {
    assert.equal(counts({counts: {...outcomes, total, processed}}).processed, expected);
  }
  assert.equal(counts({counts: {...outcomes, total: 4}}, {processed: 9.5}).processed, 9.5);
  assert.equal(counts({counts: {...outcomes, total: 4, processed: null}}, {processed: 0}).processed, 4);
});
