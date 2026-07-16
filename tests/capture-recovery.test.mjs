import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (await readFile(
  resolve(repoRoot, "utils/capture-recovery.js"),
  "utf8",
)).replace(/\bexport\s+(?=function\b)/g, "");
const context = vm.createContext({Date});
vm.runInContext(
  `${source}\n;globalThis.__captureRecoveryApi = {clearInterruptedCommentObservation, repairInterruptedCommentPayload};`,
  context,
  {filename: "utils/capture-recovery.js"},
);
const {
  clearInterruptedCommentObservation,
  repairInterruptedCommentPayload,
} = context.__captureRecoveryApi;

test("interrupted comments with a checkpoint become partial and keep data", () => {
  const items = [{commentId: "c1", content: "hello"}];
  const result = repairInterruptedCommentPayload(
    {
      commentsCaptureStatus: "capturing",
      commentsCleanedItems: items,
      commentsTotalCaptured: 1,
      commentsCaptureStartedAt: 100,
    },
    {finishedAt: 500},
  );

  assert.equal(result.changed, true);
  assert.equal(result.payload.commentsCaptureStatus, "partial");
  assert.equal(result.payload.commentsCaptureFinishedAt, 500);
  assert.equal(result.payload.commentsCaptureStoppedByUser, false);
  assert.deepEqual(result.payload.commentsCleanedItems, items);
  assert.match(result.payload.commentsCaptureError, /继续采集/);
});

test("interrupted comments without saved items become retryable failures", () => {
  const result = repairInterruptedCommentPayload(
    {
      commentsCaptureStatus: "capturing",
      // 心跳数量不代表正文已落盘，不能据此声称“已保留”。
      commentsTotalCaptured: 12,
    },
    {finishedAt: 800},
  );

  assert.equal(result.changed, true);
  assert.equal(result.payload.commentsCaptureStatus, "failed");
  assert.equal(result.payload.commentsTotalCaptured, 0);
  assert.equal(result.payload.commentsObservedBeforeInterrupt, 12);
  assert.equal(result.payload.commentsCaptureFinishedAt, 800);
});

test("repair removes a stale observed count when the new observation is not larger than saved data", () => {
  const result = repairInterruptedCommentPayload(
    {
      commentsCaptureStatus: "capturing",
      commentsCleanedItems: [
        {commentId: "c1", content: "one"},
        {commentId: "c2", content: "two"},
      ],
      commentsTotalCaptured: 2,
      commentsObservedBeforeInterrupt: 20,
    },
    {finishedAt: 850},
  );

  assert.equal(result.changed, true);
  assert.equal(result.payload.commentsCaptureStatus, "partial");
  assert.equal(result.payload.commentsTotalCaptured, 2);
  assert.equal(
    Object.hasOwn(result.payload, "commentsObservedBeforeInterrupt"),
    false,
  );
});

test("starting a new capture explicitly clears the previous interruption observation", () => {
  const payload = {
    commentsCaptureStatus: "partial",
    commentsTotalCaptured: 3,
    commentsObservedBeforeInterrupt: 18,
  };
  const result = clearInterruptedCommentObservation(payload);

  assert.equal(
    Object.hasOwn(result, "commentsObservedBeforeInterrupt"),
    false,
  );
  assert.equal(result.commentsTotalCaptured, 3);
  assert.equal(payload.commentsObservedBeforeInterrupt, 18);
});

test("terminal comment state is left untouched", () => {
  const payload = {commentsCaptureStatus: "done", commentsTotalCaptured: 8};
  const result = repairInterruptedCommentPayload(payload, {finishedAt: 900});
  assert.equal(result.changed, false);
  assert.equal(result.payload, payload);
});
