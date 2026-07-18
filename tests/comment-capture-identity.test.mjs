import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identitySource = (await readFile(
  resolve(repoRoot, "utils/capture-request.js"),
  "utf8",
)).replace(/\bexport\s+(?=(?:async\s+)?function\b)/g, "");
const captureSyncSource = await readFile(
  resolve(repoRoot, "utils/capture-sync.js"),
  "utf8",
);
const sidebarSource = await readFile(
  resolve(repoRoot, "sidebar/sidebar-logic.js"),
  "utf8",
);
const contentSource = await readFile(
  resolve(repoRoot, "content-v2.js"),
  "utf8",
);
const douyinCommentsSource = await readFile(
  resolve(repoRoot, "utils/capture/douyin-comments.js"),
  "utf8",
);

let uuidCounter = 0;
const context = vm.createContext({
  Date,
  Math,
  Object,
  crypto: {
    randomUUID() {
      uuidCounter += 1;
      return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
    },
  },
});
vm.runInContext(
  `${identitySource}\n;globalThis.__commentCaptureIdentityApi = {ensureCommentCaptureIdentity};`,
  context,
  {filename: "utils/capture-request.js"},
);
const {ensureCommentCaptureIdentity} = context.__commentCaptureIdentityApi;

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("a comment runner stays bound when the active tab changes", async () => {
  let activeTabId = 41;
  let resolveCount = 0;
  const identity = await ensureCommentCaptureIdentity({
    resolveRunnerTab: async () => {
      resolveCount += 1;
      return {id: activeTabId};
    },
  });

  activeTabId = 99;
  const reusedIdentity = await ensureCommentCaptureIdentity({
    ...identity,
    resolveRunnerTab: async () => {
      resolveCount += 1;
      return {id: activeTabId};
    },
  });

  assert.equal(identity.runnerTabId, 41);
  assert.equal(reusedIdentity.runnerTabId, 41);
  assert.equal(reusedIdentity.captureRequestId, identity.captureRequestId);
  assert.equal(resolveCount, 1);
});

test("opening and capturing progress expose the relay identity before the task starts", () => {
  const retryBlock = sourceBlock(
    captureSyncSource,
    "export async function retryCommentsForRecord",
    "export async function retryDetailCaptureForRecord",
  );
  assert.ok(
    retryBlock.indexOf("ensureCommentCaptureIdentity") <
      retryBlock.indexOf("phase: 'comments_opening'"),
  );
  assert.match(
    retryBlock,
    /captureRequestId:\s*commentCaptureIdentity\.captureRequestId/,
  );
  assert.match(
    retryBlock,
    /runnerTabId:\s*commentCaptureIdentity\.runnerTabId/,
  );

  const singleBlock = sourceBlock(
    captureSyncSource,
    "async function captureCommentsForSingleNoteRecord",
    "async function captureBloggerMetricsForSingleNoteRecord",
  );
  assert.ok(
    singleBlock.indexOf("ensureCommentCaptureIdentity") <
      singleBlock.indexOf("phase: 'comments_capturing'"),
  );
  assert.doesNotMatch(singleBlock, /captureInActiveTab\s*\(/);
  assert.match(
    singleBlock,
    /captureInTab\(commentCaptureIdentity\.runnerTabId/,
  );
  assert.match(
    singleBlock,
    /captureRequestId:\s*commentCaptureIdentity\.captureRequestId/,
  );
});

test("detail comments and card stop reuse the bound request instead of the active tab", () => {
  const detailProgressAt = captureSyncSource.indexOf(
    "phase: 'detail_comments_capturing'",
  );
  const detailBlockStart = captureSyncSource.lastIndexOf(
    "activeStage = 'comments_capture'",
    detailProgressAt,
  );
  const detailBlock = captureSyncSource.slice(
    detailBlockStart,
    captureSyncSource.indexOf("detailPayload = applyCommentResult", detailProgressAt),
  );
  assert.ok(detailBlockStart >= 0);
  assert.ok(
    detailBlock.indexOf("ensureCommentCaptureIdentity") <
      detailBlock.indexOf("phase: 'detail_comments_capturing'"),
  );
  assert.match(
    detailBlock,
    /captureRequestId:\s*commentCaptureIdentity\.captureRequestId/,
  );

  const cancelBlock = sourceBlock(
    sidebarSource,
    "async function handleCancel()",
    "/**\n * 处理鉴权",
  );
  assert.match(
    cancelBlock,
    /requestCaptureCancelSignal\(relayTabId, cancelRequestId\)/,
  );
});

test("Douyin comment capture carries and checks the expected work identity before merging", () => {
  const currentNoteBlock = sourceBlock(
    captureSyncSource,
    "async function captureCommentsForCurrentNote",
    "async function captureCommentsForHydratedDetailRecord",
  );
  assert.match(currentNoteBlock, /expectedNoteId = ''/);
  assert.match(currentNoteBlock, /expectedNoteId,\s*\n\s*},\s*\n\s*}\);/);
  assert.match(
    currentNoteBlock,
    /buildDouyinCommentIdentityFailure\(\s*expectedNoteId,\s*capturedNoteId/,
  );
  assert.ok(
    currentNoteBlock.indexOf("buildDouyinCommentIdentityFailure") <
      currentNoteBlock.indexOf("const rawItems ="),
  );

  const batchMergeAt = captureSyncSource.indexOf(
    "detailPayload = applyCommentResultToSingleNotePayload",
  );
  const batchIdentityAt = captureSyncSource.lastIndexOf(
    "buildDouyinCommentIdentityFailure",
    batchMergeAt,
  );
  assert.ok(batchIdentityAt >= 0 && batchIdentityAt < batchMergeAt);
  assert.match(
    captureSyncSource,
    /expectedNoteId: String\(captureParams\.expectedNoteId \|\| ''\)/,
  );
  assert.match(
    contentSource,
    /expectedNoteId: String\(request\.expectedNoteId \|\| ""\)/,
  );
});

test("Douyin comment identity mismatch fails closed at capture start and finish", async () => {
  assert.match(
    douyinCommentsSource,
    /assertDouyinCommentTargetIdentity\(\s*normalizedExpectedNoteId,\s*noteId,\s*"开始采集评论前"/,
  );
  assert.match(
    douyinCommentsSource,
    /assertDouyinCommentTargetIdentity\(\s*normalizedExpectedNoteId,\s*finalNoteId,\s*"返回评论结果前"/,
  );
  assert.match(
    douyinCommentsSource,
    /error\?\.code \|\|\s*\(isCanceled\(\) \? "CAPTURE_CANCELED" : "CAPTURE_FAILED"\)/,
  );

  const {assertDouyinCommentTargetIdentity} = await import(
    `../utils/capture/douyin-comments.js?comment-identity=${Date.now()}`
  );
  const expected = "766193585000000099";
  assert.equal(
    assertDouyinCommentTargetIdentity(expected, expected, "测试"),
    expected,
  );
  assert.throws(
    () =>
      assertDouyinCommentTargetIdentity(
        expected,
        "766193585000000001",
        "返回评论结果前",
      ),
    (error) =>
      error?.code === "DOUYIN_COMMENT_ID_MISMATCH" &&
      error?.expectedNoteId === expected &&
      error?.actualNoteId === "766193585000000001",
  );
  assert.throws(
    () => assertDouyinCommentTargetIdentity(expected, "", "开始采集评论前"),
    (error) => error?.code === "DOUYIN_COMMENT_ID_MISMATCH",
  );
});
