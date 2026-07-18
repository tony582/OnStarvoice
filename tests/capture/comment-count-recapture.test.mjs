import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const sidebarHtml = await readFile(
  new URL("../../sidebar/sidebar.html", import.meta.url),
  "utf8",
);
const sidebarLogic = await readFile(
  new URL("../../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);
const captureSettings = await readFile(
  new URL("../../utils/capture-settings.js", import.meta.url),
  "utf8",
);
const captureSync = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);
const serverSync = await readFile(
  new URL("../../server/routes/sync.js", import.meta.url),
  "utf8",
);

test("obsolete comment-count recapture setting stays fully removed", () => {
  for (const source of [sidebarHtml, sidebarLogic, captureSettings, captureSync]) {
    assert.doesNotMatch(source, /comment-count-recheck/);
    assert.doesNotMatch(source, /recaptureCommentsOnCountIncrease/);
    assert.doesNotMatch(source, /RECAPTURE_COMMENTS_ON_COUNT_INCREASE/);
    assert.doesNotMatch(source, /评论数增加时重采评论/);
  }
});

test("skip-captured precheck has no comment-growth exception", () => {
  const start = captureSync.indexOf(
    "export async function batchCaptureDetailsForRecords",
  );
  const end = captureSync.indexOf("const results = [];", start);
  const precheck = captureSync.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(precheck, /nextSkipRecordIds\.push\(p\.recordId\)/);
  assert.doesNotMatch(precheck, /hasCommentCountIncreasedSinceLastCapture/);
  assert.doesNotMatch(precheck, /recaptureCommentRecordIdSet/);
  assert.doesNotMatch(precheck, /nextRecaptureCommentRecordIds/);
});

test("comment-count baseline remains compatibility metadata only", () => {
  assert.match(
    captureSync,
    /nextPayloadBase\.detailCommentCountBaseline = nextCommentBaseline/,
  );
  assert.match(
    captureSync,
    /existingRecord\.payload\.detailCommentCountBaseline = previous/,
  );
  assert.match(serverSync, /detail_comment_count_baseline/);
  assert.doesNotMatch(captureSync, /resolveCapturedCommentBaseline/);
  assert.doesNotMatch(captureSync, /buildCapturedCommentStatus/);
});
