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

test("Douyin image modal fallback uses the note route instead of video", async () => {
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
      modalUrl,
      `https://www.douyin.com/note/${noteId}`,
    ],
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

test("Douyin comment readiness cannot pass from API cache without visible detail DOM", () => {
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
  assert.match(helperBlock, /requireVisibleDetailRoot: true/u);
  assert.match(helperBlock, /buildDouyinCommentRecoveryCandidates/u);

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
});
