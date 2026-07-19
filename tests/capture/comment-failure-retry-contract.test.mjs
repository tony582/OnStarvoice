import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);

test("a failed non-empty comment load becomes a retryable detail failure", () => {
  const applyIndex = source.indexOf("applyCommentResultToSingleNotePayload(");
  const failedIndex = source.indexOf(
    "commentsResult.status === COMMENT_CAPTURE_STATUS.FAILED",
    applyIndex,
  );
  const throwIndex = source.indexOf("throw commentsError", failedIndex);
  const doneIndex = source.indexOf(
    "status: DETAIL_CAPTURE_STATUS.DONE",
    failedIndex,
  );

  assert.ok(applyIndex >= 0);
  assert.ok(failedIndex > applyIndex);
  assert.ok(throwIndex > failedIndex);
  assert.ok(doneIndex > throwIndex);
  assert.match(
    source.slice(failedIndex, throwIndex),
    /DETAIL_CAPTURE_FAILURE_CODE\.COMMENTS_CAPTURE_FAILED/,
  );
});

test("comment retry failure preserves the detail snapshot and distinct failure stage", () => {
  assert.match(source, /commentsError\.partialDetailPayload\s*=\s*detailPayload/);
  assert.match(
    source,
    /detailPayload:[\s\S]*?effectiveError\?\.partialDetailPayload[\s\S]*?sanitizeMediaFieldsForStorage/,
  );
  assert.match(
    source,
    /normalizedStage === 'comments_capture'[\s\S]*?DETAIL_CAPTURE_FAILURE_CODE\.COMMENTS_CAPTURE_FAILED/,
  );
});

test("direct comment throws and identity failures retain the current detail snapshot", () => {
  assert.match(
    source,
    /function attachPartialDetailPayload\(error, detailPayload\)[\s\S]*?effectiveError\.partialDetailPayload = detailPayload/,
  );
  assert.match(
    source,
    /commentCaptureIdentity = await ensureCommentCaptureIdentity\([\s\S]*?catch \(error\) \{[\s\S]*?throw attachPartialDetailPayload\(error, detailPayload\)/,
  );
  assert.match(
    source,
    /commentsResult = await captureCommentsForCurrentNote\([\s\S]*?catch \(error\) \{[\s\S]*?throw attachPartialDetailPayload\(error, detailPayload\)/,
  );
  assert.match(
    source,
    /if \(commentIdentityFailure\) \{[\s\S]*?error\.code = commentIdentityFailure\.code;[\s\S]*?throw attachPartialDetailPayload\(error, detailPayload\)/,
  );
});

test("Douyin permanent unavailability and identity mismatch are non-retryable content failures", () => {
  assert.match(
    source,
    /noteCaptureError\.code = String\(noteResult\?\.error\?\.code \|\| ''\)\.trim\(\)/,
  );
  assert.match(
    source,
    /targetItemId !== capturedItemId\)[\s\S]*?DETAIL_CAPTURE_FAILURE_CODE\.CONTENT_UNAVAILABLE/,
  );
  for (const code of [
    "DOUYIN_CONTENT_UNAVAILABLE",
    "DOUYIN_DETAIL_ID_MISMATCH",
    "DOUYIN_COMMENT_ID_MISMATCH",
  ]) {
    assert.match(
      source,
      new RegExp(`rawCode === '${code}'`),
      `${code} must classify as CONTENT_UNAVAILABLE`,
    );
  }
  assert.match(
    source,
    /rawCode === 'DOUYIN_COMMENT_ID_MISMATCH'[\s\S]*?buildDetailCaptureFailure\([\s\S]*?DETAIL_CAPTURE_FAILURE_CODE\.CONTENT_UNAVAILABLE/,
  );
});
