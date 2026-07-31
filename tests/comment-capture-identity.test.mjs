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
  assert.match(currentNoteBlock, /verifiedNoteId = ''/);
  assert.match(
    currentNoteBlock,
    /expectedNoteId,\s*\n\s*verifiedNoteId,\s*\n\s*},\s*\n\s*}\);/,
  );
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
    captureSyncSource,
    /verifiedNoteId: String\(captureParams\.verifiedNoteId \|\| ''\)/,
  );
  assert.match(
    contentSource,
    /expectedNoteId: String\(request\.expectedNoteId \|\| ""\)/,
  );
  assert.match(
    contentSource,
    /verifiedNoteId: String\(request\.verifiedNoteId \|\| ""\)/,
  );
  assert.match(
    captureSyncSource,
    /resolveVerifiedDouyinDetailNoteId\(\s*detailPayload,\s*expectedCommentNoteId/,
  );

  const singleRecordBlock = sourceBlock(
    captureSyncSource,
    "async function captureCommentsForSingleNoteRecord",
    "async function captureBloggerMetricsForSingleNoteRecord",
  );
  assert.match(
    singleRecordBlock,
    /verifiedNoteId:\s*providedVerifiedNoteId = ''/,
  );
  assert.doesNotMatch(
    singleRecordBlock,
    /resolveVerifiedDouyinDetailNoteId\(/,
  );
  assert.doesNotMatch(
    singleRecordBlock,
    /record\.payload\?\.detailPayload\s*\|\|\s*record\.payload/,
  );

  const hydratedRecordBlock = sourceBlock(
    captureSyncSource,
    "async function captureCommentsForHydratedDetailRecord",
    "export function applyCommentResultToSingleNotePayload",
  );
  assert.match(
    hydratedRecordBlock,
    /verifiedNoteId:\s*providedVerifiedNoteId = ''/,
  );
  assert.doesNotMatch(
    hydratedRecordBlock,
    /resolveVerifiedDouyinDetailNoteId\(/,
  );
  assert.doesNotMatch(
    hydratedRecordBlock,
    /resolveVerifiedDouyinDetailNoteId\(\s*latestDetailPayload/,
  );

  assert.match(
    captureSyncSource,
    /capturedIds\.size === 1 \? \[\.\.\.capturedIds\]\[0\] : ''/,
  );
});

test("Douyin comment identity mismatch fails closed at capture start and finish", async () => {
  assert.match(
    douyinCommentsSource,
    /assertDouyinCommentTargetIdentity\(\s*normalizedExpectedNoteId,\s*noteId,\s*"开始采集评论前"/,
  );
  assert.match(
    douyinCommentsSource,
    /verifyCurrentCommentIdentity\("返回评论结果前"/,
  );
  assert.match(
    douyinCommentsSource,
    /verifyCurrentCommentIdentity\("返回评论结果前",\s*\{\s*allowVerifiedFallback:\s*false,/u,
  );
  assert.match(
    douyinCommentsSource,
    /verifyCurrentCommentIdentity\("评论滚动采集期间",\s*\{\s*deferFailure:\s*true,/,
  );
  assert.match(
    douyinCommentsSource,
    /verifyCurrentCommentIdentity\("评论滚动操作前",[\s\S]*?allowVerifiedFallback:\s*false[\s\S]*?verifyCurrentCommentIdentity\("评论滚动操作后",[\s\S]*?allowVerifiedFallback:\s*false[\s\S]*?verifyCurrentCommentIdentity\("评论加载更多后",[\s\S]*?allowVerifiedFallback:\s*false/,
  );
  assert.match(
    douyinCommentsSource,
    /error\?\.code \|\|\s*\(isCanceled\(\) \? "CAPTURE_CANCELED" : "CAPTURE_FAILED"\)/,
  );

  const {
    assertDouyinCommentTargetIdentity,
    assertCurrentDouyinCommentTargetIdentity,
    inspectDouyinCommentTargetIdentity,
    resolveVerifiedDouyinCommentNoteId,
  } = await import(
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
  assert.equal(
    resolveVerifiedDouyinCommentNoteId(expected, expected),
    expected,
  );
  assert.equal(
    resolveVerifiedDouyinCommentNoteId(
      expected,
      "766193585000000001",
    ),
    "",
  );
  assert.equal(resolveVerifiedDouyinCommentNoteId(expected, ""), "");

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  try {
    globalThis.window = {
      location: {href: `https://www.douyin.com/video/${expected}`},
      getComputedStyle() {
        return {
          display: "block",
          visibility: "visible",
          opacity: "1",
        };
      },
    };
    globalThis.document = {
      querySelectorAll() {
        return [];
      },
    };

    assert.equal(
      assertCurrentDouyinCommentTargetIdentity(expected, {
        verifiedNoteId: expected,
        stage: "评论滚动操作前",
      }),
      expected,
    );

    globalThis.window.location.href =
      "https://www.douyin.com/video/766193585000000001";
    const evidence = inspectDouyinCommentTargetIdentity(expected);
    assert.equal(evidence.hasConflict, true);
    assert.equal(evidence.source, "route");
    assert.throws(
      () =>
        assertCurrentDouyinCommentTargetIdentity(expected, {
          verifiedNoteId: expected,
          stage: "评论滚动操作后",
        }),
      (error) =>
        error?.code === "DOUYIN_COMMENT_ID_MISMATCH" &&
        error?.expectedNoteId === expected &&
        error?.actualNoteId === "766193585000000001" &&
        error?.identitySource === "route",
      "a previously verified ID must not hide a route that moved to another work",
    );
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test("Douyin comment identity rejects an expected route when another work is active", async () => {
  const {
    assertCurrentDouyinCommentTargetIdentity,
    inspectDouyinCommentTargetIdentity,
    resolveDouyinCommentNoteId,
  } = await import(
    `../utils/capture/douyin-comments.js?comment-route-identity=${Date.now()}`
  );
  const expected = "766193585000000099";
  const other = "766193585000000101";
  const activeOtherNode = {
    closest() {
      return this;
    },
    getAttribute(name) {
      return name === "data-item-id" ? other : "";
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return {top: 0, bottom: 100, width: 100, height: 100};
    },
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  try {
    globalThis.window = {
      location: {
        href: `https://www.douyin.com/video/${expected}`,
      },
      getComputedStyle() {
        return {
          display: "block",
          visibility: "visible",
          opacity: "1",
        };
      },
    };
    globalThis.document = {
      querySelectorAll(selector) {
        return selector.includes("swiper-slide-active")
          ? [activeOtherNode]
          : [];
      },
    };

    const evidence = inspectDouyinCommentTargetIdentity(expected);
    assert.match(
      douyinCommentsSource,
      /\.swiper-slide-active\[data-item-id\][\s\S]*?\.swiper-slide-active \[data-item-id\]/u,
    );
    assert.equal(evidence.routeNoteId, expected);
    assert.equal(evidence.hasConflict, true);
    assert.equal(evidence.ambiguous, true);
    assert.deepEqual(evidence.activeNoteIds, [other]);
    assert.deepEqual(evidence.conflictingNoteIds, [other]);
    assert.equal(
      resolveDouyinCommentNoteId(expected),
      "",
      "a matching URL must not mask an active slide that already belongs to another work",
    );

    for (const stage of ["评论滚动操作前", "返回评论结果前"]) {
      assert.throws(
        () =>
          assertCurrentDouyinCommentTargetIdentity(expected, {
            verifiedNoteId: expected,
            stage,
          }),
        (error) =>
          error?.code === "DOUYIN_COMMENT_ID_MISMATCH" &&
          error?.expectedNoteId === expected &&
          error?.actualNoteId === other &&
          error?.conflictingNoteIds?.includes(other),
        `${stage} must fail immediately once the active slide moves to another work`,
      );
    }
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test("Douyin comment startup can wait for an expected-route transition to settle", async () => {
  const identityLogicSource = sourceBlock(
    douyinCommentsSource,
    "function normalizeDouyinCommentNoteId",
    "function resolveNoteTitle",
  ).replace(/\bexport\s+(?=function\b)/g, "");
  const expected = "766193585000000099";
  const other = "766193585000000101";
  let activeNoteId = other;
  let waitCount = 0;
  const activeNode = {
    closest() {
      return this;
    },
    getAttribute(name) {
      return name === "data-e2e-aweme-id" ? activeNoteId : "";
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return {top: 0, bottom: 100, width: 100, height: 100};
    },
  };
  const identityContext = vm.createContext({
    Array,
    Date,
    Error,
    Object,
    Set,
    String,
    extractNoteId(value) {
      const normalized = String(value || "");
      return (
        normalized.match(/[?&]modal_id=(\d{8,})/u)?.[1] ||
        normalized.match(/\/(?:video|note)\/(\d{8,})/u)?.[1] ||
        null
      );
    },
    window: {
      location: {href: `https://www.douyin.com/video/${expected}`},
      getComputedStyle() {
        return {
          display: "block",
          visibility: "visible",
          opacity: "1",
        };
      },
    },
    document: {
      querySelectorAll(selector) {
        if (selector.includes("swiper-slide-active")) {
          return [activeNode];
        }
        return [];
      },
    },
    isElementVisible() {
      return true;
    },
    async wait() {
      waitCount += 1;
      activeNoteId = expected;
    },
  });
  vm.runInContext(
    `${identityLogicSource}
globalThis.__douyinCommentWaitApi = {waitForDouyinCommentNoteId};`,
    identityContext,
    {filename: "utils/capture/douyin-comments-identity-wait.js"},
  );

  const settledNoteId =
    await identityContext.__douyinCommentWaitApi.waitForDouyinCommentNoteId(
      expected,
      "",
      {timeoutMs: 500},
    );

  assert.equal(settledNoteId, expected);
  assert.equal(
    waitCount,
    1,
    "startup should wait for the stale active slide to converge instead of accepting or failing it immediately",
  );
});

test("ambiguous current Douyin work IDs cannot be masked by an older verified ID", async () => {
  const {
    assertCurrentDouyinCommentTargetIdentity,
    inspectDouyinCommentTargetIdentity,
  } = await import(
    `../utils/capture/douyin-comments.js?comment-ambiguous-identity=${Date.now()}`
  );
  const expected = "766193585000000099";
  const other = "766193585000000101";
  const makeVisibleWorkNode = (noteId) => ({
    closest() {
      return this;
    },
    getAttribute(name) {
      return name === "data-e2e-aweme-id" ? noteId : "";
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return {top: 0, bottom: 100, width: 100, height: 100};
    },
  });
  const activeNodes = [
    makeVisibleWorkNode(expected),
    makeVisibleWorkNode(other),
  ];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  try {
    globalThis.window = {
      location: {href: "https://www.douyin.com/"},
      getComputedStyle() {
        return {
          display: "block",
          visibility: "visible",
          opacity: "1",
        };
      },
    };
    globalThis.document = {
      querySelectorAll(selector) {
        if (selector.includes("swiper-slide-active")) {
          return activeNodes;
        }
        return [];
      },
    };

    const evidence = inspectDouyinCommentTargetIdentity(expected);
    assert.equal(evidence.hasConflict, true);
    assert.equal(evidence.ambiguous, true);
    assert.equal(evidence.source, "active_dom_conflict");
    assert.deepEqual(
      evidence.conflictingNoteIds,
      [other],
    );
    assert.throws(
      () =>
        assertCurrentDouyinCommentTargetIdentity(expected, {
          verifiedNoteId: expected,
          stage: "评论滚动采集期间",
        }),
      (error) =>
        error?.code === "DOUYIN_COMMENT_ID_MISMATCH" &&
        error?.expectedNoteId === expected &&
        error?.actualNoteId === other &&
        error?.identitySource === "active_dom_conflict",
    );
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test("strict final identity rejects a page that becomes blank after verification", async () => {
  const {
    assertCurrentDouyinCommentTargetIdentity,
    inspectDouyinCommentTargetIdentity,
  } = await import(
    `../utils/capture/douyin-comments.js?comment-blank-identity=${Date.now()}`
  );
  const expected = "766193585000000099";
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  try {
    globalThis.window = {
      location: {href: `https://www.douyin.com/video/${expected}`},
      getComputedStyle() {
        return {
          display: "block",
          visibility: "visible",
          opacity: "1",
        };
      },
    };
    globalThis.document = {
      querySelectorAll() {
        return [];
      },
    };

    assert.equal(
      assertCurrentDouyinCommentTargetIdentity(expected, {
        verifiedNoteId: expected,
        stage: "评论开始前",
      }),
      expected,
    );

    globalThis.window.location.href = "https://www.douyin.com/";
    const evidence = inspectDouyinCommentTargetIdentity(expected);
    assert.equal(evidence.hasConflict, false);
    assert.equal(evidence.source, "none");
    assert.equal(
      assertCurrentDouyinCommentTargetIdentity(expected, {
        verifiedNoteId: expected,
        stage: "评论区切换瞬间",
      }),
      expected,
    );
    assert.throws(
      () =>
        assertCurrentDouyinCommentTargetIdentity(expected, {
          verifiedNoteId: expected,
          stage: "禁止回退验证",
          allowVerifiedFallback: false,
        }),
      (error) =>
        error?.code === "DOUYIN_COMMENT_ID_MISMATCH" &&
        error?.actualNoteId === "",
    );
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test("conflicting Douyin work IDs fail closed instead of selecting the first ID", () => {
  const guardSource = sourceBlock(
    captureSyncSource,
    "function extractDouyinDetailGuardItemId",
    "function buildDouyinCommentIdentityFailure",
  );
  const guardContext = vm.createContext({Set, String, Object, Array});
  vm.runInContext(
    `${guardSource}
globalThis.__douyinGuardApi = {
  resolveCapturedDouyinCommentNoteId,
  resolveVerifiedDouyinDetailNoteId,
};`,
    guardContext,
    {filename: "utils/capture-sync-douyin-identity.js"},
  );
  const {
    resolveCapturedDouyinCommentNoteId,
    resolveVerifiedDouyinDetailNoteId,
  } = guardContext.__douyinGuardApi;
  const expected = "766193585000000099";
  const other = "766193585000000101";

  assert.equal(
    resolveCapturedDouyinCommentNoteId({
      noteId: expected,
      data: {noteId: expected, url: `https://www.douyin.com/video/${expected}`},
    }),
    expected,
  );
  assert.equal(
    resolveCapturedDouyinCommentNoteId({
      noteId: expected,
      data: {url: `https://www.douyin.com/video/${other}`},
    }),
    "",
  );
  assert.equal(
    resolveVerifiedDouyinDetailNoteId(
      {
        noteId: expected,
        url: `https://www.douyin.com/video/${other}`,
      },
      expected,
    ),
    "",
  );
});
