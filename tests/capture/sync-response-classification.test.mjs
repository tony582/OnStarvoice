import assert from "node:assert/strict";
import test from "node:test";
import * as classification from "../../utils/capture/sync-response-classification.js";

const {
  normalizeBatchFailureReason: batchReason,
  normalizeSyncItemFailureReason: itemReason,
  isRateLimitedBatchResult: batchRate,
  isRateLimitedSyncItem: itemRate,
  isIndeterminateBatchResult: batchUnknown,
  isIndeterminateSyncItem: itemUnknown,
} = classification;

test("sync receipt classification exports only the six caller entrypoints", () => {
  assert.deepEqual(Object.keys(classification).sort(), [
    "isIndeterminateBatchResult", "isIndeterminateSyncItem",
    "isRateLimitedBatchResult", "isRateLimitedSyncItem",
    "normalizeBatchFailureReason", "normalizeSyncItemFailureReason",
  ]);
  for (const entrypoint of Object.values(classification)) {
    assert.equal(typeof entrypoint, "function");
  }
});

test("reason normalization preserves every truthy fallback and whitespace masking", () => {
  const batchCases = [
    [undefined, ""], [null, ""], [false, ""], ["legacy", ""], [{}, ""],
    [{reason: " PRIMARY ", error: {reason: "secondary", code: "code"}, data: {reason: "data"}}, "primary"],
    [{reason: "", error: {reason: " SECONDARY ", code: "code"}, data: {reason: "data"}}, "secondary"],
    [{reason: 0, error: {reason: false, code: " CODE "}, data: {reason: "data"}}, "code"],
    [{error: {code: ""}, data: {reason: " DATA "}}, "data"],
    [{reason: " \t ", error: {reason: "timeout"}}, ""],
    [{error: {reason: " ", code: "timeout"}}, ""],
    [{reason: 429}, "429"],
  ];
  for (const [batch, expected] of batchCases) {
    assert.equal(batchReason(batch), expected, JSON.stringify(batch));
    assert.equal(itemReason(undefined, batch), expected, "missing item inherits batch");
  }
  const fallback = {reason: " BATCH "};
  for (const [item, expected] of [
    [null, "batch"], [{}, "batch"],
    [{reason: " ITEM ", error: {reason: "nested", code: "code"}}, "item"],
    [{reason: false, error: {reason: " NESTED ", code: "code"}}, "nested"],
    [{reason: 0, error: {reason: "", code: " CODE "}}, "code"],
    [{reason: " \t ", error: {reason: "timeout"}}, ""],
    [{error: {code: " "}}, ""],
  ]) {
    assert.equal(itemReason(item, fallback), expected, JSON.stringify(item));
  }
});

test("only strict boolean success suppresses failure classification, independently per item", () => {
  for (const [failure, rate, unknown] of [
    [{reason: "rate_limited", httpStatus: 429}, true, false],
    [{reason: "timeout"}, false, true],
  ]) {
    for (const ok of [undefined, false, null, 0, 1, "true"]) {
      assert.equal(batchRate({...failure, ok}), rate, `batch ok=${String(ok)}`);
      assert.equal(batchUnknown({...failure, ok}), unknown);
      assert.equal(itemRate({...failure, ok}, {}), rate, `item ok=${String(ok)}`);
      assert.equal(itemUnknown({...failure, ok}, {}), unknown);
    }
    assert.equal(batchRate({...failure, ok: true}), false);
    assert.equal(batchUnknown({...failure, ok: true}), false);
    assert.equal(itemRate({ok: true}, failure), false);
    assert.equal(itemUnknown({ok: true}, failure), false);
    // Batch success is not an item ACK: a missing item still inherits its error fields.
    assert.equal(itemRate(undefined, {...failure, ok: true}), rate);
    assert.equal(itemUnknown(undefined, {...failure, ok: true}), unknown);
  }
});

test("rate classification preserves reason aliases, HTTP conversion and text boundaries", () => {
  const cases = [
    [{reason: " RATE_LIMITED "}, true], [{reason: "too_many_requests"}, true],
    [{reason: 429}, true], [{httpStatus: "429"}, true],
    [{error: {httpStatus: 429}}, true], [{message: "Too Many Requests"}, true],
    [{message: "rate limit exceeded"}, true], [{message: "rate_limited"}, true],
    [{message: "HTTP 429 retry"}, true], [{message: "429"}, true],
    [{message: "HTTP 429:"}, false], [{message: "(429)"}, false],
    [{message: "1429"}, false], [{reason: "invalid_payload"}, false],
    [{error: {message: "rate limit"}}, true],
    [{data: {message: "rate limit"}}, true],
    [{message: " ", error: {message: "rate limit"}}, false],
    [{reason: " ", error: {reason: "rate_limited"}}, false],
    [null, false], [undefined, false], [{}, false],
  ];
  for (const [batch, expected] of cases) {
    assert.equal(batchRate(batch), expected, JSON.stringify(batch));
    assert.equal(itemRate(undefined, batch), expected, "missing item follows batch error");
  }
  assert.equal(itemRate({message: " "}, {message: "rate limit"}), false);
  assert.equal(itemRate({error: {message: "too many requests"}}, {}), true);
});

test("HTTP priority preserves truthy masking rather than combining all status fields", () => {
  for (const [batch, expected] of [
    [{httpStatus: 429, error: {httpStatus: 500}}, false],
    [{httpStatus: 500, error: {httpStatus: "429"}}, true],
    [{httpStatus: 429, error: {httpStatus: 0}}, true],
    [{httpStatus: 429, error: {httpStatus: " "}}, false],
  ]) assert.equal(batchRate(batch), expected, JSON.stringify(batch));
  for (const [item, batch, expected] of [
    [{httpStatus: 500, error: {httpStatus: 429}}, {httpStatus: 429}, false],
    [{httpStatus: 429, error: {httpStatus: 500}}, {httpStatus: 500}, true],
    [{httpStatus: 0, error: {httpStatus: "429"}}, {httpStatus: 500}, true],
    [{error: {httpStatus: 500}}, {error: {httpStatus: 429}, httpStatus: 429}, false],
    [{}, {error: {httpStatus: 500}, httpStatus: 429}, false],
    [{}, {error: {httpStatus: 0}, httpStatus: 429}, true],
  ]) assert.equal(itemRate(item, batch), expected, JSON.stringify({item, batch}));
});

test("unknown results preserve timeout/network/abort aliases and message fallback", () => {
  for (const reason of ["timeout", "network_error", "coze_timeout", "timeout_budget_exceeded"]) {
    assert.equal(batchUnknown({reason: ` ${reason.toUpperCase()} `}), true, reason);
    assert.equal(itemUnknown({reason}, {}), true, reason);
  }
  for (const [batch, expected] of [
    [{message: "Request timed out"}, true], [{message: "fetch failed"}, true],
    [{message: "ABORTED"}, true], [{reason: "abort"}, true],
    [{error: {message: "network disconnected"}}, true],
    [{data: {message: "timeout"}}, true],
    [{message: " ", error: {message: "timeout"}}, false],
    [{reason: " ", error: {reason: "timeout"}}, false],
    [{reason: "invalid_payload"}, false], [{reason: "unauthorized"}, false],
    [null, false], [undefined, false], [{}, false],
  ]) {
    assert.equal(batchUnknown(batch), expected, JSON.stringify(batch));
    assert.equal(itemUnknown(undefined, batch), expected);
  }
  assert.equal(itemUnknown({message: " "}, {message: "timeout"}), false);
  assert.equal(itemUnknown({error: {message: "fetch failed"}}, {}), true);
  // An abort-shaped error is unknown here, not the caller's explicit canceled result.
  assert.equal(batchUnknown({canceled: true, reason: "aborted"}), true);
});

test("rate limiting takes precedence over an otherwise indeterminate result", () => {
  for (const batch of [
    {reason: "timeout", httpStatus: 429},
    {reason: "network_error", message: "too many requests"},
    {reason: "rate_limited", message: "fetch failed"},
  ]) {
    assert.equal(batchRate(batch), true);
    assert.equal(batchUnknown(batch), false);
    assert.equal(itemRate(undefined, batch), true);
    assert.equal(itemUnknown(undefined, batch), false);
    assert.equal(itemRate({...batch}, {}), true);
    assert.equal(itemUnknown({...batch}, {}), false);
  }
});
