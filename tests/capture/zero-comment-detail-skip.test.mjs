import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {resolveKnownCommentsCountForDetailCapture} from "../../utils/capture-sync.js";

const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);

function listRecord(platform, item = {}, payload = {}) {
  return {
    id: `${platform}-record`,
    platform,
    type: "keyword_notes",
    payload: {
      ...payload,
      items: [item],
    },
  };
}

test("XHS explicit zero comments from either detail or list skips comment capture", () => {
  assert.equal(
    resolveKnownCommentsCountForDetailCapture(
      listRecord("xiaohongshu", {
        comments: 0,
        commentsCountKnown: true,
      }),
      {},
    ),
    0,
  );
  assert.equal(
    resolveKnownCommentsCountForDetailCapture(
      listRecord("xiaohongshu", {
        comments: 19,
        commentsCountKnown: true,
      }),
      {commentCount: 0, commentsCountKnown: true},
    ),
    0,
    "a confirmed detail count takes precedence over the older list count",
  );
});

test("Douyin explicit zero comments from either detail or list skips comment capture", () => {
  assert.equal(
    resolveKnownCommentsCountForDetailCapture(
      listRecord("douyin", {
        commentsCount: "0",
        commentsCountKnown: true,
      }),
      {},
    ),
    0,
  );
  assert.equal(
    resolveKnownCommentsCountForDetailCapture(
      listRecord("douyin", {
        comment_count: 8,
        commentsCountKnown: true,
      }),
      {comments_count: 0, commentsCountKnown: true},
    ),
    0,
  );
});

test("placeholder zero counts without provenance stay unknown", () => {
  for (const platform of ["xiaohongshu", "douyin"]) {
    assert.equal(
      resolveKnownCommentsCountForDetailCapture(
        listRecord(platform, {comments: 0}),
        {comments: 0},
      ),
      null,
      `${platform} placeholder zero must not suppress real comment capture`,
    );
  }
});

test("invalid or loading text cannot become a proven zero", () => {
  for (const value of ["--", "加载中", "", null, undefined]) {
    assert.equal(
      resolveKnownCommentsCountForDetailCapture(
        listRecord("douyin", {}),
        {comments: value, commentsCountKnown: true},
      ),
      null,
    );
  }
});

test("missing comment fields remain unknown so XHS and Douyin still attempt capture", () => {
  for (const platform of ["xiaohongshu", "douyin"]) {
    assert.equal(
      resolveKnownCommentsCountForDetailCapture(
        listRecord(platform, {likes: 7}),
        {title: "field intentionally absent"},
      ),
      null,
      `${platform} must distinguish an absent field from an explicit zero`,
    );
  }
});

test("detail batch zero-count branch precedes and guards the comment relay", () => {
  const gateStart = captureSyncSource.indexOf(
    "const knownCommentsCount = includeComments",
  );
  const nextStage = captureSyncSource.indexOf(
    "throwIfDetailPrefetchFatal();",
    gateStart,
  );
  assert.ok(gateStart >= 0, "missing known comments gate");
  assert.ok(nextStage > gateStart, "missing end of comment capture gate");

  const block = captureSyncSource.slice(gateStart, nextStage);
  const resolverIndex = block.indexOf(
    "resolveKnownCommentsCountForDetailCapture(record, detailPayload)",
  );
  const zeroCheckIndex = block.indexOf("knownCommentsCount === 0");
  const skippedProgressIndex = block.indexOf(
    "phase: 'detail_comments_skipped_empty'",
  );
  const captureGuardIndex = block.indexOf(
    "!shouldSkipConfirmedEmptyComments",
  );
  const captureCallIndex = block.indexOf(
    "await captureCommentsForCurrentNote({",
  );

  assert.ok(resolverIndex >= 0);
  assert.ok(zeroCheckIndex > resolverIndex);
  assert.ok(skippedProgressIndex > zeroCheckIndex);
  assert.ok(captureGuardIndex > skippedProgressIndex);
  assert.ok(captureCallIndex > captureGuardIndex);
  assert.equal(
    block.slice(0, captureGuardIndex).includes("captureCommentsForCurrentNote"),
    false,
    "confirmed-zero handling must not relay a comment-capture request",
  );
});
