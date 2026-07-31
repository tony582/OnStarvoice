import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

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

test("a partial comment load is never promoted to completed detail", () => {
  const partialIndex = source.indexOf(
    "commentsResult.status === COMMENT_CAPTURE_STATUS.PARTIAL",
  );
  const partialThrowIndex = source.indexOf("throw partialError", partialIndex);
  const doneIndex = source.indexOf(
    "status: DETAIL_CAPTURE_STATUS.DONE",
    partialIndex,
  );

  assert.ok(partialIndex >= 0);
  assert.ok(partialThrowIndex > partialIndex);
  assert.ok(doneIndex > partialThrowIndex);
  assert.match(
    source.slice(partialIndex, partialThrowIndex),
    /partialError\.partialDetailPayload = detailPayload/u,
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

test("Douyin detail capture and final persistence both require the expected work ID", () => {
  assert.match(
    source,
    /mode: 'single',[\s\S]*?captureParams: \{[\s\S]*?expectedNoteId: expectedDouyinNoteId/u,
  );
  assert.match(
    source,
    /activeStage = 'commit_guard'[\s\S]*?resolveVerifiedDouyinDetailNoteId\([\s\S]*?expectedDouyinNoteId[\s\S]*?probeDouyinTargetRouteSafety\([\s\S]*?verifiedNoteId: expectedDouyinNoteId,[\s\S]*?requireVerifiedNoteId: true/u,
  );
  const commitGuardIndex = source.indexOf("activeStage = 'commit_guard'");
  const finalWriteIndex = source.indexOf("await updateRecord(recordId", commitGuardIndex);
  assert.ok(commitGuardIndex >= 0);
  assert.ok(finalWriteIndex > commitGuardIndex);
});

test("Douyin permanent unavailability stays item-scoped while identity mismatch blocks the batch", () => {
  assert.match(
    source,
    /noteCaptureError\.code = String\(noteResult\?\.error\?\.code \|\| ''\)\.trim\(\)/,
  );
  assert.match(
    source,
    /rawCode === 'DOUYIN_CONTENT_UNAVAILABLE'[\s\S]*?DETAIL_CAPTURE_FAILURE_CODE\.CONTENT_UNAVAILABLE/,
  );
  for (const code of [
    "DOUYIN_DETAIL_ID_MISMATCH",
    "DOUYIN_COMMENT_ID_MISMATCH",
    "DOUYIN_COMMENT_ID_CONFLICT",
  ]) {
    assert.match(
      source,
      new RegExp(`rawCode === '${code}'`),
      `${code} must be recognized as an integrity failure`,
    );
  }
  assert.match(
    source,
    /rawCode === 'DOUYIN_COMMENT_ID_MISMATCH'[\s\S]*?buildDetailCaptureFailure\([\s\S]*?DETAIL_CAPTURE_FAILURE_CODE\.IDENTITY_MISMATCH/,
  );
  assert.match(
    source,
    /if \(isDouyinIdentityIntegrityError\(effectiveError\)\) \{\s*integrityBlocked = true;/u,
  );
  assert.match(
    source,
    /if \(integrityBlocked\) \{[\s\S]*?break;/u,
  );
  assert.match(source, /fatal: integrityBlocked/u);
  assert.match(source, /stopBatch: integrityBlocked/u);
  assert.match(source, /FATAL_DOUYIN_IDENTITY_MISMATCH/u);
});

test("a fresh detail payload inherits saved comments before Douyin comment preflight", () => {
  const batchBlock = sourceBlock(
    "export async function batchCaptureDetailsForRecords",
    "export async function syncRecord",
  );
  const inheritedItemsAt = batchBlock.indexOf(
    "const previouslySavedCommentItems",
  );
  const newPayloadAt = batchBlock.indexOf(
    "let detailPayload = applyCommentStatusToPayload(",
    inheritedItemsAt,
  );
  const preflightAt = batchBlock.indexOf(
    "await ensureDouyinCommentTargetReadyInTab",
    newPayloadAt,
  );
  const inheritanceBlock = batchBlock.slice(inheritedItemsAt, preflightAt);

  assert.ok(inheritedItemsAt >= 0);
  assert.ok(newPayloadAt > inheritedItemsAt);
  assert.ok(preflightAt > newPayloadAt);
  assert.match(
    inheritanceBlock,
    /record\.payload\?\.detailPayload\?\.commentsCleanedItems/u,
  );
  assert.match(
    inheritanceBlock,
    /applyCommentStatusToPayload\(\s*noteResult\.data/u,
  );
  assert.match(
    inheritanceBlock,
    /cleanedItems:\s*previouslySavedCommentItems/u,
  );
  assert.match(
    inheritanceBlock,
    /mergedText:\s*buildCommentsMergedText\(\s*previouslySavedCommentItems/u,
  );
});

test("a thrown comment-only retry marks both layers failed and retains saved comments", () => {
  const retryBlock = sourceBlock(
    "async function captureCommentsForHydratedDetailRecord",
    "export function applyCommentResultToSingleNotePayload",
  );
  const captureAt = retryBlock.indexOf(
    "result = await captureCommentsForCurrentNote(",
  );
  const catchAt = retryBlock.indexOf("} catch (error) {", captureAt);
  const throwAt = retryBlock.indexOf("throw error;", catchAt);
  const failureBlock = retryBlock.slice(catchAt, throwAt);

  assert.ok(captureAt >= 0);
  assert.ok(catchAt > captureAt);
  assert.ok(throwAt > catchAt);
  assert.match(
    failureBlock,
    /status:\s*COMMENT_CAPTURE_STATUS\.FAILED/u,
  );
  assert.match(
    failureBlock,
    /cleanedItems:\s*capturingDetailPayload\.commentsCleanedItems/u,
  );
  assert.match(
    failureBlock,
    /mergedText:\s*buildCommentsMergedText\(\s*capturingDetailPayload\.commentsCleanedItems/u,
  );
  assert.match(
    failureBlock,
    /status:\s*DETAIL_CAPTURE_STATUS\.FAILED/u,
  );
  assert.match(failureBlock, /detailPayload:\s*failedDetailPayload/u);
  assert.ok(
    retryBlock.indexOf("await updateRecord(recordId", catchAt) < throwAt,
  );
});

test("comment-only retry restores detail done only after a complete result", () => {
  const retryBlock = sourceBlock(
    "async function captureCommentsForHydratedDetailRecord",
    "export function applyCommentResultToSingleNotePayload",
  );
  const statusAt = retryBlock.indexOf(
    "const failed = mergeResult.status === COMMENT_CAPTURE_STATUS.FAILED",
  );
  const writeAt = retryBlock.indexOf("await updateRecord(recordId", statusAt);
  const persistenceBlock = retryBlock.slice(statusAt, writeAt);

  assert.ok(statusAt >= 0);
  assert.ok(writeAt > statusAt);
  assert.match(
    persistenceBlock,
    /const partial = mergeResult\.status === COMMENT_CAPTURE_STATUS\.PARTIAL/u,
  );
  assert.match(
    persistenceBlock,
    /status:\s*failed \|\| partial\s*\?\s*DETAIL_CAPTURE_STATUS\.FAILED\s*:\s*DETAIL_CAPTURE_STATUS\.DONE/u,
  );
  assert.match(persistenceBlock, /detailPayload:\s*nextDetailPayload/u);
});

test("Douyin commit guard rejects either an active-work conflict or a real route mismatch", () => {
  const batchBlock = sourceBlock(
    "export async function batchCaptureDetailsForRecords",
    "export async function syncRecord",
  );
  const commitAt = batchBlock.indexOf("activeStage = 'commit_guard'");
  const finalWriteAt = batchBlock.indexOf(
    "const latestRecord = (await getRecord(recordId)) || record",
    commitAt,
  );
  const commitBlock = batchBlock.slice(commitAt, finalWriteAt);
  const compactCommitBlock = commitBlock.replace(/\s+/gu, " ");
  const identityHelper = sourceBlock(
    "function buildDouyinDetailIdentityError",
    "function isDouyinIdentityIntegrityError",
  );

  assert.ok(commitAt >= 0);
  assert.ok(finalWriteAt > commitAt);
  assert.match(
    commitBlock,
    /extractDouyinDetailGuardItemId\(\s*finalReady\?\.currentNoteId\s*\)/u,
  );
  assert.match(
    commitBlock,
    /extractDouyinDetailGuardItemId\(\s*error\?\.currentNoteId\s*\)\s*\|\|\s*extractDouyinDetailGuardItemId\(\s*error\?\.currentUrl\s*\)/u,
  );
  assert.match(
    commitBlock,
    /error\?\.activeWorkIdentityConflict === true \|\|\s*\(observedCurrentNoteId &&\s*observedCurrentNoteId !== expectedDouyinNoteId\)/u,
    "an exact URL must not hide a real active-work conflict or route mismatch",
  );
  assert.match(
    compactCommitBlock,
    /throw buildDouyinDetailIdentityError\( expectedDouyinNoteId,/u,
  );
  assert.match(identityHelper, /error\.code = 'DOUYIN_DETAIL_ID_MISMATCH'/u);
});
