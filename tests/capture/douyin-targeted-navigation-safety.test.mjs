import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  hasDouyinCommentsTabLabel,
  isExactDouyinCommentsTabLabel,
  normalizeDouyinCommentsTabText,
} from "../../utils/capture/douyin-comments.js";

const commentsSource = await readFile(
  new URL("../../utils/capture/douyin-comments.js", import.meta.url),
  "utf8",
);
const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);
const singleNoteSource = await readFile(
  new URL("../../utils/capture/douyin-single-note.js", import.meta.url),
  "utf8",
);

test("Douyin comment tab matching accepts only the exact comment label", () => {
  assert.equal(normalizeDouyinCommentsTabText("评论（82）"), "评论");
  assert.equal(normalizeDouyinCommentsTabText("评论 82"), "评论");
  assert.equal(isExactDouyinCommentsTabLabel("评论", "评论"), true);
  assert.equal(isExactDouyinCommentsTabLabel("评论（82）", "评论"), true);
  assert.equal(
    isExactDouyinCommentsTabLabel(
      "详情 TA的作品 评论 AI抖音 相关推荐",
      "评论",
    ),
    false,
  );
  assert.equal(
    hasDouyinCommentsTabLabel(["AI抖音", "相关推荐"], "评论"),
    false,
  );
});

test("Douyin comment click candidates reject a combined tab wrapper", () => {
  assert.match(commentsSource, /"AI抖音"/u);
  assert.match(
    commentsSource,
    /if \(normalizedText !== "评论"\) \{\s+return 0;\s+\}/u,
  );
  assert.match(
    commentsSource,
    /isVerifiedCommentTriggerCandidate\(node\)/u,
  );
  assert.match(
    commentsSource,
    /\.filter\(isVerifiedCommentTriggerCandidate\)/u,
  );
  assert.match(
    commentsSource,
    /\^\(\?:AI\|AI抖音\|问AI\)\$/u,
  );
  assert.doesNotMatch(
    commentsSource,
    /return cluster\[1\]\.node/u,
  );
  assert.doesNotMatch(
    commentsSource,
    /normalizedText\.includes\("评论"\)/u,
  );
});

test("targeted single-note batches verify the requested Douyin identity before capture", () => {
  const start = captureSyncSource.indexOf(
    "export async function batchCaptureByUrls({",
  );
  const end = captureSyncSource.indexOf(
    "async function applySearchFiltersInTab",
    start,
  );
  assert.ok(start >= 0);
  assert.ok(end > start);
  const batchBranch = captureSyncSource.slice(start, end);

  const openIndex = batchBranch.indexOf("await openUrlInTab(runnerTabId, url");
  const readyIndex = batchBranch.indexOf(
    "await probeDouyinDetailPreloadBeforeCapture(runnerTabId",
  );
  const captureIndex = batchBranch.indexOf(
    "let captureResult = await captureInTab(runnerTabId",
  );

  assert.ok(openIndex >= 0, "target navigation must wait for the requested ID");
  assert.ok(readyIndex > openIndex, "Douyin detail readiness follows navigation");
  assert.ok(captureIndex > readyIndex, "capture starts only after identity readiness");
  assert.match(
    batchBranch,
    /expectedNoteId:\s*detectPlatformFromUrl\(url\) === "douyin"/u,
  );
  assert.match(
    batchBranch,
    /DOUYIN_CONTENT_UNAVAILABLE[\s\S]*DOUYIN_DETAIL_ID_MISMATCH[\s\S]*DOUYIN_DETAIL_NOT_READY/u,
  );
  assert.match(
    batchBranch,
    /buildUnavailableBatchCaptureResult\(/u,
  );
});

test("Douyin deleted image-post copy stops before the autoplay countdown", () => {
  assert.match(
    captureSyncSource,
    /你要观看的\(\?:图文\|视频\|作品\|内容\)不存在/u,
  );
  assert.match(captureSyncSource, /immediateUnavailable/u);
  assert.match(captureSyncSource, /douyin_content_unavailable/u);
  assert.match(
    captureSyncSource,
    /接下来播放\|去精选页查看更多\(\?:视频\|内容\)\|返回精选/u,
  );
  assert.match(
    singleNoteSource,
    /directUnavailableCopy && autoPlayOrExitAction/u,
  );
});
