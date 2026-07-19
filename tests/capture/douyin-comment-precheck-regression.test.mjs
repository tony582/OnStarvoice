import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {resolveKnownCommentsCountForDetailCapture} from "../../utils/capture-sync.js";

const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);

function douyinRecord(item = {}) {
  return {
    id: "douyin-comment-precheck-record",
    platform: "douyin",
    type: "keyword_notes",
    payload: {
      items: [
        {
          noteId: "766193585000000088",
          url:
            "https://www.douyin.com/jingxuan/search/test?type=general&modal_id=766193585000000088",
          ...item,
        },
      ],
    },
  };
}

function readDetailCommentBranch() {
  const start = captureSyncSource.indexOf(
    "const knownCommentsCount = includeComments",
  );
  const end = captureSyncSource.indexOf(
    "throwIfDetailPrefetchFatal();",
    start,
  );
  assert.ok(start >= 0, "missing detail comment-count gate");
  assert.ok(end > start, "missing end of detail comment branch");
  return captureSyncSource.slice(start, end);
}

test("Douyin nonzero and unknown comment counts remain eligible for real comment capture", () => {
  assert.equal(
    resolveKnownCommentsCountForDetailCapture(
      douyinRecord({comments: 25, commentsCountKnown: true}),
      {comments: 25, commentsCountKnown: true},
    ),
    25,
  );
  assert.equal(
    resolveKnownCommentsCountForDetailCapture(
      douyinRecord({comments: 0}),
      {title: "comment count is not proven"},
    ),
    null,
    "an unproven list placeholder must still enter the real capture path",
  );
});

test("only a confirmed zero may short-circuit the detail comment relay", () => {
  assert.equal(
    resolveKnownCommentsCountForDetailCapture(
      douyinRecord({comments: 0, commentsCountKnown: true}),
      {comments: 0, commentsCountKnown: true},
    ),
    0,
  );

  const branch = readDetailCommentBranch();
  const zeroGate = branch.indexOf("knownCommentsCount === 0");
  const zeroSkip = branch.indexOf("phase: 'detail_comments_skipped_empty'");
  const nonzeroGuard = branch.indexOf("!shouldSkipConfirmedEmptyComments");
  const realCapture = branch.indexOf("await captureCommentsForCurrentNote({");

  assert.ok(zeroGate >= 0);
  assert.ok(zeroSkip > zeroGate);
  assert.ok(nonzeroGuard > zeroSkip);
  assert.ok(realCapture > nonzeroGuard);
  assert.equal(
    branch.slice(0, nonzeroGuard).includes("captureCommentsForCurrentNote"),
    false,
    "confirmed-zero handling must never invoke the comment content action",
  );
});

test("Douyin batch capture reaches the real collector before any readiness recovery", () => {
  const branch = readDetailCommentBranch();
  assert.doesNotMatch(
    branch,
    /ensureDouyinCommentTargetReadyInTab\(\{/u,
    "batch capture must not reject a usable Douyin comment surface with a narrower precheck",
  );
  assert.match(
    branch,
    /const expectedCommentNoteId\s*=\s*recordPlatform === 'douyin'[\s\S]*?resolveExpectedDouyinCommentNoteId\(record, noteUrl\)/u,
    "the real collector must retain the expected Douyin work ID guard",
  );

  const resultStart = branch.indexOf(
    "commentsResult = await captureCommentsForCurrentNote({",
  );
  const resultEnd = branch.indexOf(
    "const commentIdentityFailure =",
    resultStart,
  );
  assert.ok(resultStart >= 0, "missing real comment collector assignment");
  assert.ok(resultEnd > resultStart, "missing comment identity validation");
  const resultBlock = branch.slice(resultStart, resultEnd);

  assert.match(
    resultBlock,
    /await captureCommentsForCurrentNote\(\{[\s\S]*?expectedNoteId:\s*expectedCommentNoteId,[\s\S]*?\}\);/u,
    "nonzero/unknown Douyin items must call the real comment capture action with the expected ID",
  );
  assert.doesNotMatch(
    resultBlock,
    /commentTargetReadyError/u,
    "a best-effort readiness diagnostic must not gate the real comment capture action",
  );
  assert.doesNotMatch(
    resultBlock,
    /status:\s*COMMENT_CAPTURE_STATUS\.FAILED/u,
    "the batch runner must not manufacture a failed comment result before content capture runs",
  );
});
