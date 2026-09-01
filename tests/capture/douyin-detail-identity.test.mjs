import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const captureSyncSource = await readFile(
  new URL("../../utils/capture-sync.js", import.meta.url),
  "utf8",
);
const singleNoteSource = await readFile(
  new URL("../../utils/capture/douyin-single-note.js", import.meta.url),
  "utf8",
);

test("Douyin search modal readiness accepts identity-bound visible modal but never generic search DOM", () => {
  assert.match(
    captureSyncSource,
    /const modalIdentityFallbackRoot = isSearchModalContext/,
  );
  assert.match(
    captureSyncSource,
    /targetModalRoot \|\|\s+linkedModalRoot \|\|\s+modalIdentityFallbackRoot/,
  );
  assert.match(
    captureSyncSource,
    /\[data-e2e="comment-list"\]/,
  );
  assert.match(
    captureSyncSource,
    /isSearchModalContext\s+\?\s+Boolean\(boundDetailRoot\) &&/,
  );
  assert.doesNotMatch(
    captureSyncSource,
    /const detailRoot = targetRoot \|\| document/,
  );
  assert.match(
    captureSyncSource,
    /usedModalIdentityFallback: Boolean/,
  );
  assert.match(
    captureSyncSource,
    /hasBoundDetailRoot: Boolean\(boundDetailRoot\)/,
  );
  assert.match(
    captureSyncSource,
    /DOUYIN_SEARCH_MODAL_BIND_GRACE_MS = 2500/,
  );
  assert.match(
    captureSyncSource,
    /result\.isSearchModalContext && !result\.hasBoundDetailRoot/,
  );
});

test("Douyin DOM capture rejects an unopened search modal before reading a card", () => {
  assert.match(
    singleNoteSource,
    /const detailRoot = resolveActiveDouyinDetailRoot\(urlNoteId\)/,
  );
  assert.match(
    singleNoteSource,
    /if \(isStrictSearchModalContext\) \{\s+return findDouyinTargetBoundModalRoot\(realNoteId\);\s+\}/,
  );
  assert.match(
    singleNoteSource,
    /抖音搜索页未真正打开目标作品详情/,
  );
  assert.match(
    singleNoteSource,
    /resolveDouyinNoteId\(detailRoot, urlNoteId\)/,
  );
});

test("slow Douyin details remain recoverable until the target work is hydrated", () => {
  assert.match(
    captureSyncSource,
    /DOUYIN_DETAIL_READY_PROBE_TIMEOUT_MS = 20000/u,
  );

  assert.match(
    singleNoteSource,
    /DOUYIN_DETAIL_DOM_READY_TIMEOUT_MS = 25000/u,
  );
  assert.match(
    singleNoteSource,
    /ensureDetailPageReady\(DOUYIN_DOM_PROFILE,[\s\S]*?timeout: DOUYIN_DETAIL_DOM_READY_TIMEOUT_MS/u,
  );
  assert.match(
    singleNoteSource,
    /notReadyError\.code = "DOUYIN_DETAIL_NOT_READY"/u,
    "a slow DOM must enter the existing alternate-entry retry path",
  );
});

test("Douyin DOM identity wins over a misleading modal_id URL", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: {
      href:
        "https://www.douyin.com/jingxuan/search/test?modal_id=766193585000000099",
    },
  };
  try {
    const {resolveDouyinNoteId} = await import(
      `../../utils/capture/douyin-single-note.js?detail-identity=${Date.now()}`
    );
    const detailRoot = {
      matches() {
        return false;
      },
      querySelector() {
        return null;
      },
      getAttribute(name) {
        return name === "data-e2e-aweme-id"
          ? "766193585000000001"
          : "";
      },
    };
    assert.equal(
      resolveDouyinNoteId(detailRoot, "766193585000000099"),
      "766193585000000001",
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Douyin search modal capture stores a canonical direct work URL", async () => {
  const previousWindow = globalThis.window;
  const noteId = "766193585000000111";
  globalThis.window = {
    location: {
      href:
        `https://www.douyin.com/jingxuan/search/canonical?modal_id=${noteId}`,
    },
  };
  try {
    const {resolveDouyinNoteUrl} = await import(
      `../../utils/capture/douyin-single-note.js?canonical-modal-url=${Date.now()}`
    );
    const externalWorkLink = {
      getAttribute(name) {
        return name === "href"
          ? `https://example.com/video/${noteId}`
          : "";
      },
    };
    const detailRoot = {
      querySelector(selector) {
        return selector.includes('a[href*="/video/"]')
          ? externalWorkLink
          : null;
      },
    };

    assert.equal(
      resolveDouyinNoteUrl(detailRoot, noteId),
      `https://www.douyin.com/video/${noteId}`,
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Douyin direct note URL remains the return target after profile capture", async () => {
  const previousWindow = globalThis.window;
  const noteId = "766193585000000112";
  globalThis.window = {
    location: {
      href: `https://www.douyin.com/note/${noteId}?from=search_result`,
    },
  };
  try {
    const {resolveDouyinNoteUrl} = await import(
      `../../utils/capture/douyin-single-note.js?canonical-direct-url=${Date.now()}`
    );
    assert.equal(
      resolveDouyinNoteUrl({querySelector() { return null; }}, noteId),
      `https://www.douyin.com/note/${noteId}?from=search_result`,
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Douyin CDN /video/tos/ href never overrides the numeric modal identity", async () => {
  const previousWindow = globalThis.window;
  const noteId = "7662443795690278611";
  globalThis.window = {
    location: {
      href: `https://www.douyin.com/jingxuan/search/test?modal_id=${noteId}`,
    },
  };
  try {
    const {resolveDouyinNoteId} = await import(
      `../../utils/capture/douyin-single-note.js?cdn-href-identity=${Date.now()}`
    );
    const cdnLink = {
      getAttribute(name) {
        return name === "href"
          ? "https://v3-web.douyinvod.com/video/tos/cn/tos-cn-ve-15/o123"
          : "";
      },
    };
    const detailRoot = {
      matches() {
        return false;
      },
      querySelector(selector) {
        return selector.includes('a[href*="/video/"]') ? cdnLink : null;
      },
      getAttribute() {
        return "";
      },
    };

    assert.equal(resolveDouyinNoteId(detailRoot), noteId);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Douyin CDN /video/tos/ media src never overrides the numeric direct-route identity", async () => {
  const previousWindow = globalThis.window;
  const noteId = "7662443795690278622";
  globalThis.window = {
    location: {
      href: `https://www.douyin.com/video/${noteId}`,
    },
  };
  try {
    const {resolveDouyinNoteId} = await import(
      `../../utils/capture/douyin-single-note.js?cdn-video-identity=${Date.now()}`
    );
    const video = {
      currentSrc: "",
      getAttribute(name) {
        return name === "src"
          ? "https://v3-web.douyinvod.com/video/tos/cn/tos-cn-ve-15/o456"
          : "";
      },
      querySelector() {
        return null;
      },
    };
    const emptyDetailLink = {
      getAttribute() {
        return "";
      },
    };
    const detailRoot = {
      matches() {
        return false;
      },
      querySelector(selector) {
        if (selector.includes('a[href*="/video/"]')) {
          return emptyDetailLink;
        }
        return selector === "video" ? video : null;
      },
      getAttribute() {
        return "";
      },
    };

    assert.equal(resolveDouyinNoteId(detailRoot), noteId);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Douyin href identity candidates must contain at least eight numeric digits", async () => {
  const previousWindow = globalThis.window;
  const noteId = "7662443795690278633";
  globalThis.window = {
    location: {
      href: `https://www.douyin.com/jingxuan/search/test?modal_id=${noteId}`,
    },
  };
  try {
    const {resolveDouyinNoteId} = await import(
      `../../utils/capture/douyin-single-note.js?short-href-identity=${Date.now()}`
    );
    const shortIdLink = {
      getAttribute(name) {
        return name === "href" ? "https://www.douyin.com/video/1234567" : "";
      },
    };
    const detailRoot = {
      matches() {
        return false;
      },
      querySelector(selector) {
        return selector.includes('a[href*="/video/"]') ? shortIdLink : null;
      },
      getAttribute() {
        return "";
      },
    };

    assert.equal(resolveDouyinNoteId(detailRoot), noteId);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Douyin image records use the matched note route before their search modal", async () => {
  const {
    buildDouyinDetailNavigationCandidates,
    resolveRecordDetailNotePath,
  } = await import(
    `../../utils/capture-sync.js?image-modal-fallback=${Date.now()}`
  );
  const noteId = "766193585000000077";
  const sourceUrl =
    "https://www.douyin.com/jingxuan/search/test?type=general";
  const modalUrl = `${sourceUrl}&modal_id=${noteId}`;
  const record = {
    platform: "douyin",
    payload: {
      items: [
        {
          noteId,
          noteType: "image",
          type: "image",
          url: modalUrl,
        },
      ],
    },
  };

  assert.equal(resolveRecordDetailNotePath(record), "note");
  assert.deepEqual(
    buildDouyinDetailNavigationCandidates(modalUrl, sourceUrl, "note"),
    [
      `https://www.douyin.com/note/${noteId}`,
      modalUrl,
    ],
  );
});

test("Douyin unknown records try both direct routes before their own search modal", async () => {
  const {
    buildDouyinDetailNavigationCandidates,
    resolveRecordDetailNotePath,
  } = await import(
    `../../utils/capture-sync.js?unknown-direct-routes=${Date.now()}`
  );
  const noteId = "766193585000000078";
  const recordSourceUrl =
    "https://www.douyin.com/jingxuan/search/record-keyword?type=general";
  const unrelatedActiveSourceUrl =
    "https://www.douyin.com/jingxuan/search/another-keyword?type=general";
  const recordModalUrl = `${recordSourceUrl}&modal_id=${noteId}`;
  const record = {
    platform: "douyin",
    payload: {
      searchUrl: recordSourceUrl,
      items: [
        {
          noteId,
          url: recordModalUrl,
        },
      ],
    },
  };

  assert.equal(resolveRecordDetailNotePath(record), "unknown");
  assert.deepEqual(
    buildDouyinDetailNavigationCandidates(
      recordModalUrl,
      unrelatedActiveSourceUrl,
      "unknown",
    ),
    [
      `https://www.douyin.com/video/${noteId}`,
      `https://www.douyin.com/note/${noteId}`,
      recordModalUrl,
    ],
  );
});

test("Douyin records fail closed when stored IDs disagree", async () => {
  const {
    inspectDouyinRecordDetailIdentity,
    resolveRecordDetailNoteId,
  } = await import(
    `../../utils/capture-sync.js?record-id-conflict=${Date.now()}`
  );
  const explicitId = "766193585000000078";
  const urlId = "766193585000000079";
  const record = {
    platform: "douyin",
    payload: {
      items: [
        {
          noteId: explicitId,
          url: `https://www.douyin.com/video/${urlId}`,
        },
      ],
    },
  };

  assert.equal(resolveRecordDetailNoteId(record), "");
  assert.deepEqual(inspectDouyinRecordDetailIdentity(record), {
    isDouyin: true,
    noteId: "",
    noteIds: [explicitId, urlId],
    conflicting: true,
  });
  assert.match(
    captureSyncSource,
    /recordIdentityConflict[\s\S]*?integrityBlocked = true[\s\S]*?fatal: recordIdentityConflict[\s\S]*?stopBatch: recordIdentityConflict/u,
  );
});

test("an explicit Douyin note route wins over a misleading duration field", async () => {
  const {resolveRecordDetailNotePath} = await import(
    `../../utils/capture-sync.js?note-route-priority=${Date.now()}`
  );
  const noteId = "766193585000000080";

  assert.equal(
    resolveRecordDetailNotePath({
      platform: "douyin",
      payload: {
        items: [
          {
            noteId,
            duration: "00:15",
            url: `https://www.douyin.com/note/${noteId}`,
          },
        ],
      },
    }),
    "note",
  );
});

test("Douyin comment recovery prefers an identity-bound direct route", async () => {
  const {buildDouyinCommentRecoveryCandidates} = await import(
    `../../utils/capture-sync.js?comment-recovery=${Date.now()}`
  );
  const noteId = "766193585000000088";
  const sourceUrl =
    "https://www.douyin.com/jingxuan/search/test?type=general";
  const modalUrl = `${sourceUrl}&modal_id=${noteId}`;
  const record = {
    platform: "douyin",
    payload: {
      items: [
        {
          noteId,
          noteType: "video",
          duration: "00:19",
          url: modalUrl,
          searchUrl: sourceUrl,
        },
      ],
    },
  };

  const candidates = buildDouyinCommentRecoveryCandidates(
    record,
    modalUrl,
    sourceUrl,
  );
  assert.equal(candidates[0], `https://www.douyin.com/video/${noteId}`);
  assert.ok(candidates.includes(modalUrl));
});

test("Douyin comment readiness trusts a verified direct route but keeps search modals visible-bound", () => {
  assert.match(
    captureSyncSource,
    /\(!requireVisibleRoot && apiDetailReady\) \|\|/u,
  );
  const helperStart = captureSyncSource.indexOf(
    "async function ensureDouyinCommentTargetReadyInTab",
  );
  const helperEnd = captureSyncSource.indexOf(
    "function isDetailSecurityBlockError",
    helperStart,
  );
  const helperBlock = captureSyncSource.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0);
  assert.match(helperBlock, /probeDouyinTargetRouteSafety\(tabId/u);
  assert.match(
    helperBlock,
    /verifiedNoteId,[\s\S]*?requireVerifiedNoteId: true/u,
    "comment preflight and recovery must require the already verified detail payload ID",
  );
  assert.match(helperBlock, /buildDouyinCommentRecoveryCandidates/u);

  const routeProbeStart = captureSyncSource.indexOf(
    "async function probeDouyinTargetRouteSafety",
  );
  const routeProbeEnd = captureSyncSource.indexOf(
    "async function probeDouyinNavigationEntry",
    routeProbeStart,
  );
  const routeProbeBlock = captureSyncSource.slice(
    routeProbeStart,
    routeProbeEnd,
  );
  assert.ok(routeProbeStart >= 0);
  assert.match(
    routeProbeBlock,
    /const currentUrl = String\(snapshot\?\.currentUrl \|\| ''\)/u,
    "route classification must use the actual tab URL",
  );
  assert.match(
    routeProbeBlock,
    /isDouyinDirectDetailEntryUrl\(currentUrl\)/u,
  );
  assert.match(
    routeProbeBlock,
    /if \(snapshot\?\.activeWorkIdentityConflict === true\) \{[\s\S]*?buildDouyinTargetRouteNotReadyError/u,
    "a verified payload removes only the visible-DOM gate, not a real active-work conflict",
  );
  assert.match(
    routeProbeBlock,
    /snapshot\?\.immediateUnavailable === true \|\|\s*\(requireVerifiedNoteId && snapshot\?\.unavailable === true\)/u,
    "a verified direct route must still fail closed on an unavailable work",
  );
  assert.match(
    routeProbeBlock,
    /snapshot\?\.isSearchModalContext === true[\s\S]*?probeDetailPreloadSafety\(tabId,[\s\S]*?waitForDouyinReady: true,[\s\S]*?requireVisibleDetailRoot: true/u,
    "search modal readiness must remain bound to visible target detail DOM",
  );

  const probeStart = captureSyncSource.indexOf(
    "async function probeDetailPreloadSafety",
  );
  const probeEnd = captureSyncSource.indexOf(
    "async function ensureDouyinCommentTargetReadyInTab",
    probeStart,
  );
  const probeBlock = captureSyncSource.slice(probeStart, probeEnd);
  assert.ok(
    probeBlock.indexOf("if (result.unavailable)") <
      probeBlock.indexOf("if (result.targetMatched && result.detailReady)"),
  );
  assert.match(
    probeBlock,
    /document\.visibilityState === 'hidden'/u,
    "a hidden work tab must not satisfy visible-DOM readiness",
  );
  assert.match(
    probeBlock,
    /douyinRateLimited[\s\S]*?'RATE_LIMITED'/u,
    "Douyin rate-limit pages must stop the batch",
  );
  assert.match(
    probeBlock,
    /const visibleRateLimitSurface[\s\S]*?visibleRateLimitSurface \|\|\s*\(douyinRateLimitCopy && !hasVisibleDetailSignal\)/u,
    "a visible rate-limit overlay must win even when detail remains rendered underneath",
  );
  assert.doesNotMatch(
    probeBlock,
    /(?:^|\|)\s*\\b429\\b/u,
    "a bare 429 in normal post text must not be treated as a rate-limit page",
  );
  assert.match(
    probeBlock,
    /embeddedIds\.every\(\(value\) => value === targetNoteId\)/u,
    "API readiness cache must be bound to the requested work ID",
  );
});

test("Douyin extractor failure continues only from the next verified entry", () => {
  const batchStart = captureSyncSource.indexOf(
    "export async function batchCaptureDetailsForRecords",
  );
  const batchEnd = captureSyncSource.indexOf(
    "export async function syncRecord",
    batchStart,
  );
  const batchBlock = captureSyncSource.slice(batchStart, batchEnd);

  assert.match(batchBlock, /const douyinReadyEntryUrlByRecordId = new Map\(\)/u);
  assert.match(
    batchBlock,
    /douyinReadyEntryUrlByRecordId\.set\(\s*String\(recordId\),\s*candidateUrl/u,
  );
  assert.match(
    batchBlock,
    /code === 'DOUYIN_DETAIL_NOT_READY' \|\|\s*code === 'DOUYIN_CONTENT_UNAVAILABLE'/u,
  );
  assert.match(
    batchBlock,
    /const readyEntryIndex = fallbackCandidates\.indexOf\(readyEntryUrl\)[\s\S]*?fallbackCandidates\.slice\(readyEntryIndex \+ 1\)/u,
  );
  assert.match(
    batchBlock,
    /detailPrefetchPipeline\.runExternalNavigation[\s\S]*?active: true[\s\S]*?probeDouyinNavigationEntry[\s\S]*?noteResult = await captureCurrentNotePayload\(\)/u,
  );
  assert.doesNotMatch(
    batchBlock,
    /readyEntryIndex < 0[\s\S]{0,160}fallbackCandidates/u,
    "an unknown cursor must not replay the first candidate",
  );
});

test("Douyin initial direct entry remains conflict-strict until the payload ID is verified", () => {
  const routeProbeStart = captureSyncSource.indexOf(
    "async function probeDouyinTargetRouteSafety",
  );
  const navigationProbeStart = captureSyncSource.indexOf(
    "async function probeDouyinNavigationEntry",
    routeProbeStart,
  );
  const navigationProbeEnd = captureSyncSource.indexOf(
    "async function ensureDouyinCommentTargetReadyInTab",
    navigationProbeStart,
  );
  const routeProbeBlock = captureSyncSource.slice(
    routeProbeStart,
    navigationProbeStart,
  );
  const navigationProbeBlock = captureSyncSource.slice(
    navigationProbeStart,
    navigationProbeEnd,
  );

  assert.ok(routeProbeStart >= 0);
  assert.ok(navigationProbeStart > routeProbeStart);
  assert.match(
    navigationProbeBlock,
    /probeDouyinTargetRouteSafety\(tabId,[\s\S]*?targetUrl,[\s\S]*?shouldStop,[\s\S]*?timeoutMs/u,
  );
  assert.doesNotMatch(
    navigationProbeBlock,
    /verifiedNoteId/u,
    "initial navigation must not claim a payload identity that has not been captured",
  );
  assert.match(
    routeProbeBlock,
    /if \(snapshot\?\.activeWorkIdentityConflict === true\)/u,
  );
  assert.match(
    routeProbeBlock,
    /directRouteNoteId !== expectedNoteId \|\|[\s\S]*?currentNoteId && currentNoteId !== expectedNoteId/u,
    "a real direct-route mismatch must remain fail closed",
  );
  assert.match(
    routeProbeBlock,
    /hydrationDeferred: snapshot\?\.detailReady !== true/u,
  );
});

test("single-note Douyin profile lookup always restores a canonical work route", () => {
  const helperStart = captureSyncSource.indexOf(
    "async function captureBloggerMetricsForSingleNoteRecord",
  );
  const helperEnd = captureSyncSource.indexOf(
    "async function captureDouyinBloggerMetricsFromNoteDetail",
    helperStart,
  );
  const helperBlock = captureSyncSource.slice(helperStart, helperEnd);

  assert.ok(helperStart >= 0);
  assert.match(
    helperBlock,
    /const noteUrl =\s+resolveRecordNoteUrl\(record\) \|\|/u,
  );
  assert.match(
    helperBlock,
    /finally \{[\s\S]*?openUrlInTab\(tab\.id, noteUrl,[\s\S]*?active: true/u,
  );
});

test("targeted Douyin preflight defers only detail loading to the existing capture wait chain", () => {
  const helperStart = captureSyncSource.indexOf(
    "async function probeDouyinDetailPreloadBeforeCapture",
  );
  const helperEnd = captureSyncSource.indexOf(
    "/**\n * 批量链接采集",
    helperStart,
  );
  const helperBlock = captureSyncSource.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  assert.match(
    helperBlock,
    /String\(error\?\.code \|\| ""\)\.trim\(\)\.toUpperCase\(\) !==\s+"DOUYIN_DETAIL_NOT_READY"/u,
  );
  assert.match(helperBlock, /throw error;/u);
  assert.match(helperBlock, /deferredToCapture: true/u);
  assert.doesNotMatch(
    helperBlock,
    /DOUYIN_CONTENT_UNAVAILABLE|DOUYIN_DETAIL_ID_MISMATCH|PAGE_CHALLENGE_BLOCK|XHS_SECURITY_BLOCK/u,
  );

  const batchStart = captureSyncSource.indexOf(
    "export async function batchCaptureByUrls({",
  );
  const batchEnd = captureSyncSource.indexOf(
    "async function applySearchFiltersInTab",
    batchStart,
  );
  const batchBlock = captureSyncSource.slice(batchStart, batchEnd);
  const preflightIndex = batchBlock.indexOf(
    "await probeDouyinDetailPreloadBeforeCapture(runnerTabId",
  );
  const captureIndex = batchBlock.indexOf(
    "let captureResult = await captureInTab(runnerTabId",
  );
  assert.ok(preflightIndex >= 0);
  assert.ok(
    captureIndex > preflightIndex,
    "a slow-but-correct detail must continue into single-note capture",
  );
});
