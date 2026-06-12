import {PAGE_TYPE, SYNC_TYPE, DEFAULT_CONFIG} from "../constants.js";
import {
  cleanText,
  extractNoteId,
  extractUserId,
  parseInteractionCount,
} from "../helpers.js";
import {
  autoScrollLoad,
  isCanceled,
  resetCancelFlag,
  smoothScrollTo,
  wait,
  waitUntil,
} from "../scroll.js";
import {getDomProfile} from "../platform/dom-profiles/index.js";
import {ensureDetailPageReady} from "./shared/detail-dom.js";
import {buildCommentLoadStage} from "./stage-diagnostics.js";

const DOUYIN_DOM_PROFILE = getDomProfile("douyin");

const DEFAULT_MAX_ITEMS = 100;
const MIN_COMMENTS_STALL_TIMEOUT_MS = 8000;
const REQUIRED_STALL_ROUNDS = 4;
const COMMENT_CONTENT_MAX_LENGTH = 280;
const MAX_REASONABLE_LIKES = 1_000_000_000;
const PRECISE_COMMENT_OPEN_TIMEOUT_MS = 2800;
const FALLBACK_COMMENT_OPEN_TIMEOUT_MS = 3500;
const BOTTOM_COMMENT_REVEAL_TIMEOUT_MS = 4200;

const COMMENT_LIST_SELECTORS = Object.freeze([
  '[data-e2e="comment-list"]',
  '[data-e2e*="comment-list"]',
  '[class*="comment-list"]',
  '[class*="CommentList"]',
  "[data-comment-list]",
]);

const COMMENT_ITEM_SELECTORS = Object.freeze([
  '[data-e2e="comment-item"]',
  '[data-e2e*="comment-item"]',
  "[data-comment-id]",
  '[class*="comment-item"]',
  '[class*="CommentItem"]',
]);

const COMMENT_BUTTON_SELECTORS = Object.freeze([
  '[data-e2e="feed-comment-icon"]',
  '[data-e2e="comment-icon"]',
  '[data-e2e="video-player-comment"]',
  '[data-e2e*="comment-icon"]',
  '[data-e2e*="player-comment"]',
  '[data-e2e*="feed-comment"]',
  ".DG40dqtZ",
  ".DG40dqtZ *",
  '.NynyWX3_._LuYd1v3.kvkOpnzi',
  '.NynyWX3_._LuYd1v3.kvkOpnzi *',
  '.mPbLYXE8.rxsO1JiP',
  ".fN2jqmuV .fcEX2ARL:nth-child(2)",
  ".fN2jqmuV .fcEX2ARL:nth-child(2) *",
  'div[data-click-from="click_icon"] .kT7icnwc',
  ".kT7icnwc",
  '[class*="comment-icon"]',
  '[class*="CommentIcon"]',
  '[aria-label*="评论"]',
  '[title*="评论"]',
]);

const COMMENT_SECTION_ANCHOR_SELECTORS = Object.freeze([
  '[data-e2e="comment-list"]',
  '[data-e2e*="comment-list"]',
  '[data-e2e*="comment-input"]',
  '[data-e2e*="comment-area"]',
  '[placeholder*="评论"]',
  'div[class*="comment-input"]',
  'div[class*="CommentInput"]',
]);

const DETAIL_TAB_LABELS = Object.freeze([
  "详情",
  "TA的作品",
  "评论",
  "问AI",
  "相关推荐",
]);

const DETAIL_TAB_CANDIDATE_SELECTORS = Object.freeze([
  '[role="tab"]',
  '[role="button"]',
  "button",
  "a",
  "span",
  "div",
]);

const DOUYIN_AUTHOR_ENTRY_SELECTORS = Object.freeze([
  'img.fiWP27dC',
  '[data-click-from="click_icon"] img.fiWP27dC',
  '[data-e2e="feed-video-nickname"]',
  '[data-e2e="feed-video-nickname"] a[href*="/user/"]',
  '[data-e2e="video-info"] a[href*="/user/"]',
  '.video-info-detail a[href*="/user/"]',
  '[data-click-from="click_icon"]',
  '[data-click-from="click_icon"] [data-e2e="video-avatar"]',
  '[data-click-from="click_icon"] [data-e2e="live-avatar"]',
  '[data-e2e="feed-avatar"]',
  '[data-e2e="video-avatar"]',
  '[data-e2e="live-avatar"]',
  'a[href*="/user/"]',
]);

const COMMENT_ICON_PATH_SIGNATURE = "M-5.79,5.98";

const COMMENT_SCENE = Object.freeze({
  CONTENT_FEED: "content_feed",
  DETAIL_BOTTOM: "detail_bottom",
});

const COMMENT_SCENE_PROFILES = Object.freeze({
  [COMMENT_SCENE.CONTENT_FEED]: Object.freeze({
    itemSelectors: Object.freeze([
      ...COMMENT_ITEM_SELECTORS,
      '[data-e2e*="comment-item"]',
    ]),
    userNameSelectors: Object.freeze([
      '[data-click-from="title"]',
      ".JS0ztEHa",
      '[class*="comment-user"]',
      '[class*="CommentUser"]',
      ".BT7MlqJC a",
      ".BT7MlqJC",
    ]),
    contentSelectors: Object.freeze([
      '[data-e2e="comment-content"]',
      ".JrWL1Ykc",
      ".C7LroK_h",
      ".WFJiGxr7",
      '[class*="comment-content"]',
      '[class*="CommentContent"]',
    ]),
    metaSelectors: Object.freeze([
      ".vo4kEeuY",
      ".fJhvAqos",
      '[class*="comment-time"]',
      '[class*="CommentTime"]',
      '[class*="comment-meta"]',
    ]),
    likesSelectors: Object.freeze([
      ".soEq5p_Y span:last-child",
      ".xZhLomAs span",
      '[class*="comment-like"] span',
      '[class*="CommentLike"] span',
      '[data-e2e*="like"] span',
    ]),
  }),
  [COMMENT_SCENE.DETAIL_BOTTOM]: Object.freeze({
    itemSelectors: Object.freeze([
      ...COMMENT_ITEM_SELECTORS,
      "article",
      "li",
    ]),
    userNameSelectors: Object.freeze([
      ".JS0ztEHa",
      '[data-click-from="title"]',
      '[class*="comment-user"]',
      '[class*="CommentUser"]',
      'a[href*="/user/"] span',
      'a[href*="/user/"]',
    ]),
    contentSelectors: Object.freeze([
      ".JrWL1Ykc",
      '[data-e2e="comment-content"]',
      '[class*="comment-content"]',
      '[class*="CommentContent"]',
      "p",
    ]),
    metaSelectors: Object.freeze([
      ".vo4kEeuY",
      '[class*="comment-time"]',
      '[class*="CommentTime"]',
      '[class*="comment-meta"]',
      "time",
    ]),
    likesSelectors: Object.freeze([
      ".soEq5p_Y span:last-child",
      '[class*="comment-like"] span',
      '[class*="CommentLike"] span',
      '[data-e2e*="like"] span',
    ]),
  }),
});

const COMMENT_DIAGNOSTIC_REASON_BUCKET = Object.freeze({
  GENERAL: "general",
  NODE: "node",
  CONTENT: "content",
});

const COMMENT_LOAD_MORE_SELECTORS = Object.freeze([
  "button",
  'div[role="button"]',
  "span",
]);

const STRICT_COMMENT_ICON_SELECTORS = Object.freeze([
  '[data-e2e="feed-comment-icon"]',
  '[data-e2e="comment-icon"]',
  '[data-e2e="video-player-comment"]',
  ".DG40dqtZ",
  '.NynyWX3_._LuYd1v3.kvkOpnzi',
]);

function createCommentCaptureContext({noteId = "", scene = ""} = {}) {
  return {
    noteId,
    scene,
    diagnostics: {
      scene,
      openStrategy: "",
      openStrategyCounts: {},
      containerSource: "",
      containerSourceCounts: {},
      candidateCount: 0,
      candidateCountAfterFilter: 0,
      extractedCount: 0,
      acceptedCount: 0,
      updatedCount: 0,
      rejectedReasons: {},
      rejectedNodeReasons: {},
      rejectedContentReasons: {},
    },
  };
}

function incrementDiagnosticCounter(map, key, delta = 1) {
  const normalizedKey = cleanText(key);
  if (!map || !normalizedKey || !Number.isFinite(delta) || delta === 0) {
    return;
  }
  map[normalizedKey] = Number(map[normalizedKey] || 0) + delta;
}

function incrementCommentDiagnostic(captureContext, field, delta = 1) {
  if (!captureContext?.diagnostics || !field || !Number.isFinite(delta)) {
    return;
  }
  captureContext.diagnostics[field] =
    Number(captureContext.diagnostics[field] || 0) + delta;
}

function setCommentOpenStrategy(captureContext, strategy = "") {
  const normalized = cleanText(strategy);
  if (!captureContext?.diagnostics || !normalized) {
    return;
  }
  if (!captureContext.diagnostics.openStrategy) {
    captureContext.diagnostics.openStrategy = normalized;
  }
  incrementDiagnosticCounter(
    captureContext.diagnostics.openStrategyCounts,
    normalized,
  );
}

function recordCommentContainerSource(captureContext, source = "") {
  const normalized = cleanText(source);
  if (!captureContext?.diagnostics || !normalized) {
    return;
  }
  if (!captureContext.diagnostics.containerSource) {
    captureContext.diagnostics.containerSource = normalized;
  }
  incrementDiagnosticCounter(
    captureContext.diagnostics.containerSourceCounts,
    normalized,
  );
}

function recordCommentReject(
  captureContext,
  reason = "",
  bucket = COMMENT_DIAGNOSTIC_REASON_BUCKET.GENERAL,
) {
  const normalized = cleanText(reason);
  if (!captureContext?.diagnostics || !normalized) {
    return;
  }
  incrementDiagnosticCounter(captureContext.diagnostics.rejectedReasons, normalized);
  if (bucket === COMMENT_DIAGNOSTIC_REASON_BUCKET.NODE) {
    incrementDiagnosticCounter(
      captureContext.diagnostics.rejectedNodeReasons,
      normalized,
    );
    return;
  }
  if (bucket === COMMENT_DIAGNOSTIC_REASON_BUCKET.CONTENT) {
    incrementDiagnosticCounter(
      captureContext.diagnostics.rejectedContentReasons,
      normalized,
    );
  }
}

function toTopDiagnosticEntries(map, limit = 5) {
  return Object.entries(map || {})
    .map(([reason, count]) => ({reason, count: Number(count || 0)}))
    .filter(({reason, count}) => reason && count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

function buildCommentCaptureDiagnostics(captureContext) {
  const diagnostics = captureContext?.diagnostics || {};
  return {
    scene: diagnostics.scene || "",
    openStrategy: diagnostics.openStrategy || "",
    openStrategyCounts: diagnostics.openStrategyCounts || {},
    containerSource: diagnostics.containerSource || "",
    containerSourceCounts: diagnostics.containerSourceCounts || {},
    candidateCount: Number(diagnostics.candidateCount || 0),
    candidateCountAfterFilter: Number(
      diagnostics.candidateCountAfterFilter || 0,
    ),
    extractedCount: Number(diagnostics.extractedCount || 0),
    acceptedCount: Number(diagnostics.acceptedCount || 0),
    updatedCount: Number(diagnostics.updatedCount || 0),
    rejectedReasonsTopN: toTopDiagnosticEntries(diagnostics.rejectedReasons),
    rejectedNodeReasonsTopN: toTopDiagnosticEntries(
      diagnostics.rejectedNodeReasons,
    ),
    rejectedContentReasonsTopN: toTopDiagnosticEntries(
      diagnostics.rejectedContentReasons,
    ),
  };
}

export async function captureDouyinComments({
  onProgress = null,
  maxDetectedItems = null,
  maxItems = null,
  maxDurationMs = DEFAULT_CONFIG.MAX_CAPTURE_DURATION_MS,
  noNewContentThreshold = DEFAULT_CONFIG.NO_NEW_CONTENT_THRESHOLD,
  waitMinMs = DEFAULT_CONFIG.SCROLL_DELAY_MIN,
  waitMaxMs = DEFAULT_CONFIG.SCROLL_DELAY_MAX,
  stallTimeoutMs = 3000,
  maxScrollTimes = DEFAULT_CONFIG.MAX_SCROLL_TIMES,
} = {}) {
  const captureStartedAt = new Date().toISOString();
  resetCancelFlag();

  const normalizedMaxDetectedItems = normalizePositiveInteger(
    maxDetectedItems ?? maxItems,
    DEFAULT_MAX_ITEMS,
  );
  const normalizedMaxDurationMs = normalizePositiveInteger(
    maxDurationMs,
    DEFAULT_CONFIG.MAX_CAPTURE_DURATION_MS,
  );
  const normalizedNoNewThreshold = normalizePositiveInteger(
    noNewContentThreshold,
    DEFAULT_CONFIG.NO_NEW_CONTENT_THRESHOLD,
  );
  const normalizedWaitMinMs = normalizePositiveInteger(
    waitMinMs,
    DEFAULT_CONFIG.SCROLL_DELAY_MIN,
  );
  const normalizedWaitMaxMs = normalizePositiveInteger(
    waitMaxMs,
    DEFAULT_CONFIG.SCROLL_DELAY_MAX,
  );
  const normalizedStallTimeoutMs = Math.max(
    normalizePositiveInteger(stallTimeoutMs, 3000),
    MIN_COMMENTS_STALL_TIMEOUT_MS,
  );
  const normalizedMaxScrollTimes = normalizePositiveInteger(
    maxScrollTimes,
    DEFAULT_CONFIG.MAX_SCROLL_TIMES,
  );
  let captureContext = null;

  try {
    await ensureDetailPageReady(DOUYIN_DOM_PROFILE, {timeout: 10000});

    const noteId = resolveDouyinNoteId();
    if (!noteId) {
      throw new Error("无法识别当前作品 ID");
    }

    const scene = detectCommentScene();
    captureContext = createCommentCaptureContext({noteId, scene});
    const commentContainer = await prepareCommentContainer(scene, {
      onProgress,
      captureContext,
    });
    if (!commentContainer) {
      throw new Error("无法找到评论区容器");
    }

    await waitForCommentSurfaceReady(commentContainer, {
      timeout:
        scene === COMMENT_SCENE.CONTENT_FEED
          ? Math.max(FALLBACK_COMMENT_OPEN_TIMEOUT_MS + 4000, 7000)
          : Math.max(BOTTOM_COMMENT_REVEAL_TIMEOUT_MS, 5000),
      scene,
      captureContext,
    });

    await scrollNodeIntoActiveViewport(commentContainer);
    await wait(400);

    const commentsMap = new Map();
    const commentScopeRoot = resolveCommentScopeRoot(commentContainer, {
      noteId,
      scene,
    });
    let activeCommentContainer = commentContainer;
    const resolveActiveCommentContainer = () => {
      const latestContainer = findVisibleCommentContainer({
        scopeRoot: commentScopeRoot,
        scene,
        captureContext,
      });
      if (latestContainer) {
        activeCommentContainer = latestContainer;
      }
      return activeCommentContainer || commentContainer;
    };
    let lastGrowthAt = Date.now();
    let lastObservedCount = 0;
    let stallRounds = 0;
    const requiredStallRounds =
      scene === COMMENT_SCENE.CONTENT_FEED
        ? REQUIRED_STALL_ROUNDS + 2
        : REQUIRED_STALL_ROUNDS;

    const scrollResult = await autoScrollLoad({
      onProgress: (progress) => {
        if (!onProgress) return;
        onProgress({
          ...progress,
          phase: "comments_collecting",
          collectedCount: commentsMap.size,
          maxDetectedItems: normalizedMaxDetectedItems,
          message: `评论采集中（${commentsMap.size}条）`,
        });
      },
      detectNewContent: () => {
        const currentContainer = resolveActiveCommentContainer();
        collectVisibleComments(
          currentContainer,
          commentsMap,
          normalizedMaxDetectedItems,
          scene,
          captureContext,
        );
        return commentsMap.size;
      },
      maxScrollTimes: normalizedMaxScrollTimes,
      noNewContentThreshold: Math.max(normalizedNoNewThreshold, requiredStallRounds + 3),
      maxDurationMs: normalizedMaxDurationMs,
      waitMinMs: Math.min(normalizedWaitMinMs, normalizedWaitMaxMs),
      waitMaxMs: Math.max(normalizedWaitMinMs, normalizedWaitMaxMs),
      stopWhen: ({currentContentCount}) => {
        const currentContainer = resolveActiveCommentContainer();
        if (currentContentCount > lastObservedCount) {
          lastObservedCount = currentContentCount;
          lastGrowthAt = Date.now();
          stallRounds = 0;
        } else {
          stallRounds += 1;
        }

        if (currentContentCount >= normalizedMaxDetectedItems) {
          return {
            stop: true,
            reason: "max_items",
            message: `达到评论加载上限（${normalizedMaxDetectedItems}条）`,
          };
        }

        if (isCommentAreaExhausted(currentContainer, scene)) {
          return {
            stop: true,
            reason: "comment_area_exhausted",
            message: "当前作品评论区已到末尾，结束采集",
          };
        }

        if (
          currentContentCount < normalizedMaxDetectedItems &&
          Date.now() - lastGrowthAt >= normalizedStallTimeoutMs &&
          stallRounds >= requiredStallRounds
        ) {
          return {
            stop: true,
            reason: "stall_timeout",
            message: `连续 ${Math.floor(normalizedStallTimeoutMs / 1000)} 秒无新增，按当前最大值结束`,
          };
        }

        return {stop: false};
      },
      scrollStep: async () => {
        const currentContainer = resolveActiveCommentContainer();
        await scrollWithinCommentArea(currentContainer, {scene, stallRounds});
        await clickLoadMoreComments(currentContainer);
      },
    });

    collectVisibleComments(
      resolveActiveCommentContainer(),
      commentsMap,
      normalizedMaxDetectedItems,
      scene,
      captureContext,
    );

    const stoppedByUser = isCanceled();
    const captureStatus = stoppedByUser ? "partial" : "done";
    const items = Array.from(commentsMap.values()).slice(
      0,
      normalizedMaxDetectedItems,
    );
    const commentDiagnostics = buildCommentCaptureDiagnostics(captureContext);
    const stageTrace = [
      buildCommentLoadStage({
        label: "抖音评论加载",
        status: stoppedByUser ? "partial" : "completed",
        commentsMaxDetectedItems: normalizedMaxDetectedItems,
        collectedCount: items.length,
        uniqueCount: commentsMap.size,
        commentContainerFound: Boolean(activeCommentContainer || commentContainer),
        scrollResult,
        maxScrollTimes: normalizedMaxScrollTimes,
        waitMinMs: Math.min(normalizedWaitMinMs, normalizedWaitMaxMs),
        waitMaxMs: Math.max(normalizedWaitMinMs, normalizedWaitMaxMs),
        stallTimeoutMs: normalizedStallTimeoutMs,
        maxDurationMs: normalizedMaxDurationMs,
        scene,
        commentDiagnostics,
      }),
    ];

    return {
      ok: true,
      type: SYNC_TYPE.COMMENTS,
      data: {
        noteId,
        noteUrl: window.location.href,
        noteTitle: resolveNoteTitle(),
        totalCount: items.length,
        items,
        captureTimestamp: Date.now(),
        captureStatus,
        stoppedByUser,
        stopReason: stoppedByUser ? "canceled" : scrollResult.stopReason || "",
      },
      meta: {
        pageType: PAGE_TYPE.NOTE_DETAIL,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
        captureStatus,
        stoppedByUser,
        scene,
        diagnostics: commentDiagnostics,
        scrollInfo: {
          scrollCount: scrollResult.scrollCount,
          maxScrollTimes: scrollResult.maxScrollTimes,
          completed: scrollResult.completed,
          canceled: scrollResult.canceled,
          stopReason: scrollResult.stopReason,
          finalContentCount: scrollResult.finalContentCount,
          noNewContentCount: scrollResult.noNewContentCount,
          elapsedMs: scrollResult.elapsedMs,
        },
      },
      diagnostics: {
        stageTrace,
      },
      error: null,
    };
  } catch (error) {
    console.error("[Douyin][Comments] capture failed:", error);
    return {
      ok: false,
      type: SYNC_TYPE.COMMENTS,
      data: null,
      meta: {
        pageType: PAGE_TYPE.NOTE_DETAIL,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
        scene: captureContext?.scene || "",
        diagnostics: buildCommentCaptureDiagnostics(captureContext),
      },
      error: {
        code: isCanceled() ? "CAPTURE_CANCELED" : "CAPTURE_FAILED",
        message: error.message,
      },
    };
  }
}

function normalizePositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded > 0 ? rounded : fallback;
}

function resolveDouyinNoteId() {
  return (
    document
      .querySelector("[data-e2e-aweme-id]")
      ?.getAttribute("data-e2e-aweme-id") ||
    extractNoteId(window.location.href) ||
    ""
  );
}

function resolveNoteTitle() {
  const title = cleanText(
    document.querySelector('[data-e2e="video-desc"]')?.textContent ||
      document.querySelector("h1")?.textContent ||
      "",
  );
  return title;
}

function detectCommentScene({allowContainerInference = true} = {}) {
  if (isLikelyDouyinContentFlowPage() || isDouyinNoteDetailPage()) {
    return COMMENT_SCENE.CONTENT_FEED;
  }

  if (isDouyinVideoDetailPage()) {
    return COMMENT_SCENE.DETAIL_BOTTOM;
  }

  if (!allowContainerInference) {
    return COMMENT_SCENE.DETAIL_BOTTOM;
  }

  const visibleContainer = findVisibleCommentContainer({
    allowSceneDetection: false,
  });
  if (visibleContainer) {
    return isScrollableContainer(visibleContainer)
      ? COMMENT_SCENE.CONTENT_FEED
      : COMMENT_SCENE.DETAIL_BOTTOM;
  }

  return COMMENT_SCENE.DETAIL_BOTTOM;
}

function resolveCommentSceneProfile(scene) {
  return (
    COMMENT_SCENE_PROFILES[scene] ||
    COMMENT_SCENE_PROFILES[COMMENT_SCENE.DETAIL_BOTTOM]
  );
}

function isLikelyDouyinContentFlowPage() {
  try {
    const parsed = new URL(window.location.href);
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (parsed.searchParams.get("modal_id")) {
      return true;
    }
    if (
      pathname.startsWith("/search/") ||
      pathname.startsWith("/jingxuan/search")
    ) {
      return true;
    }
  } catch {}

  return false;
}

function isDouyinNoteDetailPage() {
  try {
    const parsed = new URL(window.location.href);
    return /\/note\//i.test(String(parsed.pathname || ""));
  } catch {
    return /\/note\//i.test(String(window.location.href || ""));
  }
}

function isDouyinVideoDetailPage() {
  try {
    const parsed = new URL(window.location.href);
    return /\/video\//i.test(String(parsed.pathname || ""));
  } catch {
    return /\/video\//i.test(String(window.location.href || ""));
  }
}

async function prepareCommentContainer(
  scene,
  {onProgress = null, captureContext = null} = {},
) {
  const existingContainer = findVisibleCommentContainer({
    scene,
    captureContext,
  });
  if (existingContainer) {
    setCommentOpenStrategy(captureContext, "existing_visible_container");
    return existingContainer;
  }

  const preloaded = await waitForVisibleCommentContainer({
    timeout: 1200,
    scene,
    captureContext,
  });
  if (preloaded) {
    setCommentOpenStrategy(captureContext, "preloaded_visible_container");
    return findVisibleCommentContainer({
      scene,
      captureContext,
    });
  }

  if (scene === COMMENT_SCENE.CONTENT_FEED) {
    const openedByPreciseEntry = await openRightRailCommentsFromPreciseEntry({
      onProgress,
      timeout: PRECISE_COMMENT_OPEN_TIMEOUT_MS,
      scene,
      captureContext,
    });
    if (openedByPreciseEntry) {
      return findVisibleCommentContainer({
        scene,
        captureContext,
      });
    }

    const openedByFallbackEntry = await fallbackOpenRightRailComments({
      onProgress,
      allowTabFallback: false,
      scene,
      captureContext,
    });
    if (openedByFallbackEntry) {
      return findVisibleCommentContainer({
        scene,
        captureContext,
      });
    }

    const tabTrigger = findCommentsTabTrigger();
    if (tabTrigger) {
      if (typeof onProgress === "function") {
        onProgress({
          phase: "comments_preparing",
          message: "正在切换到评论标签...",
        });
      }
      safeClick(tabTrigger);
      await wait(300);
      const openedByTab = await waitForVisibleCommentContainer({
        timeout: FALLBACK_COMMENT_OPEN_TIMEOUT_MS,
        scene,
        captureContext,
      });
      if (openedByTab) {
        setCommentOpenStrategy(captureContext, "content_tab_trigger");
        return findVisibleCommentContainer({
          scene,
          captureContext,
        });
      }
    }

    if (!isDouyinNoteDetailPage()) {
      const panelOpened = await ensureContentFlowPanelOpenForComments({
        onProgress,
        captureContext,
      });
      if (panelOpened) {
        const openedAfterPanel = await openRightRailCommentsFromPreciseEntry({
          onProgress,
          timeout: FALLBACK_COMMENT_OPEN_TIMEOUT_MS,
          scene,
          captureContext,
        });
        if (openedAfterPanel) {
          setCommentOpenStrategy(captureContext, "content_panel_then_precise_icon");
          return findVisibleCommentContainer({
            scene,
            captureContext,
          });
        }
      }
    }

    return await fallbackOpenRightRailComments({
      onProgress,
      allowTabFallback: true,
      scene,
      captureContext,
    });
  }

  await revealDetailCommentSection({scene, captureContext});
  const foundBottom = await waitForVisibleCommentContainer({
    timeout: BOTTOM_COMMENT_REVEAL_TIMEOUT_MS,
    scene,
    captureContext,
  });
  if (foundBottom) {
    setCommentOpenStrategy(captureContext, "detail_anchor_reveal");
    return findVisibleCommentContainer({
      scene,
      captureContext,
    });
  }

  return await fallbackOpenDetailComments({onProgress, scene, captureContext});
}

async function openRightRailCommentsFromPreciseEntry({
  onProgress = null,
  timeout = PRECISE_COMMENT_OPEN_TIMEOUT_MS,
  scene = COMMENT_SCENE.CONTENT_FEED,
  captureContext = null,
} = {}) {
  const button = findStrictCommentIconTrigger();
  if (!button) {
    return false;
  }

  if (typeof onProgress === "function") {
    onProgress({
      phase: "comments_preparing",
      message: "正在打开右侧评论栏...",
    });
  }

  return await tryOpenCommentContainerByClick(button, {
    timeout,
    scene,
    captureContext,
    openStrategy: "content_precise_icon",
  });
}

async function fallbackOpenRightRailComments({
  onProgress = null,
  allowTabFallback = true,
  scene = COMMENT_SCENE.CONTENT_FEED,
  captureContext = null,
} = {}) {
  const button = findCommentButton();
  if (button) {
    if (typeof onProgress === "function") {
      onProgress({
        phase: "comments_preparing",
        message: "正在尝试备用评论入口...",
      });
    }
    const opened = await tryOpenCommentContainerByClick(button, {
      timeout: FALLBACK_COMMENT_OPEN_TIMEOUT_MS,
      scene,
      captureContext,
      openStrategy: "content_fallback_button",
    });
    if (opened) {
      return findVisibleCommentContainer({
        scene,
        captureContext,
      });
    }
  }

  if (allowTabFallback) {
    const tabInFlow = findCommentsTabTrigger();
    if (tabInFlow) {
      const opened = await tryOpenCommentContainerByClick(tabInFlow, {
        timeout: FALLBACK_COMMENT_OPEN_TIMEOUT_MS,
        scene,
        captureContext,
        openStrategy: "content_tab_fallback",
      });
      if (opened) {
        return findVisibleCommentContainer({
          scene,
          captureContext,
        });
      }
    }
  }

  // 内容流/图文右侧栏不回退到页面滚动，避免把推荐内容当评论区。
  return null;
}

async function fallbackOpenDetailComments({
  onProgress = null,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
  captureContext = null,
} = {}) {
  const commentsTab = findCommentsTabTrigger();
  if (commentsTab) {
    if (typeof onProgress === "function") {
      onProgress({
        phase: "comments_preparing",
        message: "正在尝试备用评论标签...",
      });
    }
    const opened = await tryOpenCommentContainerByClick(commentsTab, {
      timeout: FALLBACK_COMMENT_OPEN_TIMEOUT_MS,
      scene,
      captureContext,
      openStrategy: "detail_tab_trigger",
    });
    if (opened) {
      return findVisibleCommentContainer({
        scene,
        captureContext,
      });
    }
  }

  const openedByPreciseEntry = await openRightRailCommentsFromPreciseEntry({
    onProgress,
    timeout: FALLBACK_COMMENT_OPEN_TIMEOUT_MS,
    scene,
    captureContext,
  });
  if (openedByPreciseEntry) {
    return findVisibleCommentContainer({
      scene,
      captureContext,
    });
  }

  if (isCommentSurfaceLoading()) {
    const loaded = await waitForVisibleCommentContainer({
      timeout: FALLBACK_COMMENT_OPEN_TIMEOUT_MS,
      scene,
      captureContext,
    });
    if (loaded) {
      setCommentOpenStrategy(captureContext, "detail_loading_wait");
      return findVisibleCommentContainer({
        scene,
        captureContext,
      });
    }
  }

  return null;
}

async function tryOpenCommentContainerByClick(
  node,
  {
    timeout = FALLBACK_COMMENT_OPEN_TIMEOUT_MS,
    nativeWaitMs = 260,
    syntheticWaitMs = 180,
    scene = COMMENT_SCENE.DETAIL_BOTTOM,
    captureContext = null,
    openStrategy = "",
  } = {},
) {
  if (!(node instanceof Element)) {
    return false;
  }

  if (clickElementNative(node)) {
    await wait(nativeWaitMs);
    const openedByNative = await waitForVisibleCommentContainer({
      timeout: Math.max(600, Math.floor(timeout * 0.45)),
      scene,
      captureContext,
    });
    if (openedByNative) {
      setCommentOpenStrategy(captureContext, openStrategy || "native_click_open");
      return true;
    }
  }

  safeClick(node);
  await wait(syntheticWaitMs);
  const opened = await waitForVisibleCommentContainer({
    timeout: Math.max(800, timeout),
    scene,
    captureContext,
  });
  if (opened) {
    setCommentOpenStrategy(
      captureContext,
      openStrategy || "synthetic_click_open",
    );
  }
  return opened;
}

async function ensureContentFlowPanelOpenForComments({
  onProgress = null,
  captureContext = null,
} = {}) {
  if (hasTabbedContentFlowForComments()) {
    return true;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const trigger = findAuthorEntryTriggerForComments();
    if (!trigger) {
      await wait(140);
      continue;
    }

    if (typeof onProgress === "function") {
      onProgress({
        phase: "comments_preparing",
        message: "正在展开侧边详情面板...",
      });
    }

    safeClick(trigger);
    await wait(220 + attempt * 120);

    const opened = await waitUntil(
      () => hasTabbedContentFlowForComments() || Boolean(findCommentsTabTrigger()),
      {
        timeout: 1800 + attempt * 1100,
        interval: 120,
      },
    ).catch(() => false);

    if (opened || hasTabbedContentFlowForComments()) {
      setCommentOpenStrategy(captureContext, "content_panel_opened");
      return true;
    }
  }

  return hasTabbedContentFlowForComments();
}

async function revealDetailCommentSection({
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
  captureContext = null,
} = {}) {
  const anchor = findCommentSectionAnchor();
  if (anchor) {
    await scrollNodeIntoActiveViewport(anchor);
    await wait(400);
    return;
  }

  const maxRounds = 8;
  for (let round = 0; round < maxRounds; round += 1) {
    if (
      findVisibleCommentContainer({scene, captureContext}) ||
      findCommentSectionAnchor()
    ) {
      break;
    }
    await advancePrimaryScroller(Math.max(480, window.innerHeight * 0.8));
    await wait(450);
  }

  const finalAnchor = findCommentSectionAnchor();
  if (finalAnchor) {
    await scrollNodeIntoActiveViewport(finalAnchor);
    await wait(300);
  }
}

function findVisibleCommentContainer({
  allowSceneDetection = true,
  scopeRoot = null,
  scene = null,
  captureContext = null,
} = {}) {
  const searchRoot = scopeRoot instanceof Element ? scopeRoot : document;
  const directMatch = queryVisibleElements(
    COMMENT_LIST_SELECTORS,
    searchRoot,
  ).find((node) => {
    const rect = safeRect(node);
    return (
      rect.height >= 40 &&
      rect.width >= 100 &&
      (isVisibleDouyinCommentSurface(node) || isCommentSurfacePendingNode(node))
    );
  });
  if (directMatch) {
    recordCommentContainerSource(captureContext, "direct_selector");
    return directMatch;
  }

  const fromItems = inferCommentContainerFromItems(searchRoot, {
    scene:
      scene ||
      (allowSceneDetection
        ? detectCommentScene({allowContainerInference: false})
        : COMMENT_SCENE.DETAIL_BOTTOM),
  });
  if (fromItems) {
    recordCommentContainerSource(captureContext, "inferred_from_items");
    return fromItems;
  }

  const anchor = findCommentSectionAnchor(searchRoot);
  if (anchor) {
    const container = inferCommentContainerAround(anchor, {
      scene:
        scene ||
        (allowSceneDetection
          ? undefined
          : detectCommentScene({allowContainerInference: false})),
    });
    if (container && isVisibleDouyinCommentSurface(container)) {
      recordCommentContainerSource(captureContext, "inferred_from_anchor");
      return container;
    }
  }

  return null;
}

function findCommentButton() {
  const nodes = queryVisibleElements(COMMENT_BUTTON_SELECTORS)
    .map(resolveActionableCommentNode)
    .filter(Boolean);
  const deduped = Array.from(new Set(nodes));
  const ranked = deduped
    .filter((node) => {
      if (node.closest?.('[role="tablist"]')) return false;
      if (countKnownTabLabelsAround(node) >= 2) return false;
      const text = cleanText(node.textContent || "");
      if (/全部评论/.test(text)) return false;
      if (text && !/评论|\d/.test(text)) return false;
      return true;
    })
    .map((node) => ({
      node,
      score: scoreCommentButtonCandidate(node),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.node || null;
}

function findAuthorEntryTriggerForComments() {
  const strict = findStrictAvatarTriggerForComments();
  if (strict) {
    return strict;
  }

  const candidates = [];

  DOUYIN_AUTHOR_ENTRY_SELECTORS.forEach((selector) => {
    try {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof Element) || !isElementVisible(node)) return;
        const actionable =
          node.closest?.('a[href*="/user/"]') ||
          node.closest?.('[data-click-from="click_icon"]') ||
          node.closest?.('[role="button"], button, [tabindex], a') ||
          node;
        if (
          actionable instanceof Element &&
          isElementVisible(actionable) &&
          isLikelyDouyinUserEntry(actionable, node) &&
          isLikelyRightRailActionTarget(actionable)
        ) {
          candidates.push(actionable);
        }
      });
    } catch {}
  });

  const ranked = Array.from(new Set(candidates))
    .map((node) => ({
      node,
      score: scoreDouyinAuthorEntryCandidate(node),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function findStrictAvatarTriggerForComments() {
  const avatarSelectors = [
    'img.fiWP27dC',
    '[data-click-from="click_icon"] img[src*="aweme-avatar"]',
    '[data-e2e="video-avatar"] img',
    '[data-e2e="video-avatar"]',
    'a[href*="/user/"] img',
  ];
  const clickableCandidates = [];

  avatarSelectors.forEach((selector) => {
    try {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof Element) || !isElementVisible(node)) return;
        const clickable =
          node.closest?.('[data-click-from="click_icon"]') ||
          node.closest?.('[role="button"], button, [tabindex], a[href*="/user/"], a') ||
          node;
        if (
          clickable instanceof Element &&
          isElementVisible(clickable) &&
          isLikelyRightRailActionTarget(clickable)
        ) {
          clickableCandidates.push(clickable);
        }
      });
    } catch {}
  });

  const ranked = Array.from(new Set(clickableCandidates))
    .map((node) => ({
      node,
      score: scoreStrictAvatarCandidate(node),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function findStrictCommentIconTrigger() {
  const directHotzoneTrigger = findDirectCommentHotzoneTrigger();
  if (directHotzoneTrigger) {
    return directHotzoneTrigger;
  }

  const interactionTrigger = findInteractionBarCommentTrigger();
  if (interactionTrigger) {
    return interactionTrigger;
  }

  const strictPathMatches = Array.from(
    document.querySelectorAll(`svg path[d*="${COMMENT_ICON_PATH_SIGNATURE}"]`),
  );

  for (const pathNode of strictPathMatches) {
    const clickable =
      resolveCommentIconActionableNode(pathNode) ||
      pathNode.closest?.("svg");
    if (
      clickable instanceof Element &&
      isElementVisible(clickable) &&
      isLikelyRightRailActionTarget(clickable, {maxWidth: 320, maxHeight: 320})
    ) {
      return clickable;
    }
  }

  for (const selector of STRICT_COMMENT_ICON_SELECTORS) {
    try {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        if (
          node instanceof Element &&
          isElementVisible(node) &&
          isLikelyRightRailActionTarget(node, {maxWidth: 180, maxHeight: 180})
        ) {
          return node;
        }
      }
    } catch {}
  }

  const pathMatches = Array.from(
    document.querySelectorAll(`svg path[d*="${COMMENT_ICON_PATH_SIGNATURE}"]`),
  );

  for (const pathNode of pathMatches) {
    const iconNode = pathNode.closest?.("svg");
    const clickable = resolveCommentIconActionableNode(iconNode) || iconNode;
    if (
      clickable instanceof Element &&
      isElementVisible(clickable) &&
      isLikelyRightRailActionTarget(clickable, {maxWidth: 320, maxHeight: 320})
    ) {
      return clickable;
    }
  }

  const actionBarMatch = findCommentIconByActionBarPosition();
  if (actionBarMatch) {
    return actionBarMatch;
  }

  return null;
}

function findCommentIconByActionBarPosition() {
  const actionItems = Array.from(document.querySelectorAll("div, span, button"))
    .filter((node) => {
      if (!(node instanceof Element) || !isElementVisible(node)) return false;
      const rect = safeRect(node);
      if (rect.left < window.innerWidth * 0.5) return false;
      if (rect.width > 140 || rect.height > 180) return false;
      if (rect.width < 16 || rect.height < 16) return false;
      if (!node.querySelector("svg")) return false;
      const text = cleanText(node.textContent || "");
      return /^\d+(?:\.\d+)?[万wWkK]?$/.test(text);
    })
    .slice(0, 40);

  if (actionItems.length < 3) return null;

  const withRect = actionItems.map((node) => {
    const rect = safeRect(node);
    return {node, centerX: rect.left + rect.width / 2, top: rect.top};
  });

  for (let i = 0; i < withRect.length; i += 1) {
    const cluster = withRect.filter(
      (item) => Math.abs(item.centerX - withRect[i].centerX) < 30,
    );
    if (cluster.length < 3) continue;
    cluster.sort((a, b) => a.top - b.top);

    const commentSvgMatch = cluster.find(({node}) =>
      node.querySelector(`svg path[d*="${COMMENT_ICON_PATH_SIGNATURE}"]`),
    );
    if (commentSvgMatch) return commentSvgMatch.node;

    const commentAttrMatch = cluster.find(({node}) => {
      const attrs = [
        node.getAttribute?.("data-e2e") || "",
        typeof node.className === "string" ? node.className : "",
      ].join(" ");
      return /comment/i.test(attrs);
    });
    if (commentAttrMatch) return commentAttrMatch.node;

    if (cluster.length >= 2) return cluster[1].node;
  }

  return null;
}

function findDirectCommentHotzoneTrigger() {
  const selectors = Array.from(
    new Set([
      '[data-e2e="feed-comment-icon"]',
      '[data-e2e="comment-icon"]',
      '[data-e2e="video-player-comment"]',
      '.qSsCHWSU[data-e2e="feed-comment-icon"]',
      '.qSsCHWSU',
      '.kT7icnwc',
    ]),
  );
  const candidates = [];
  const root = findCurrentDouyinWorkRoot();
  const contexts = root ? [root, document] : [document];

  contexts.forEach((context) => {
    selectors.forEach((selector) => {
      try {
        context.querySelectorAll(selector).forEach((node) => {
          if (!(node instanceof Element) || !isElementVisible(node)) return;
          const actionable = resolveCommentIconActionableNode(node) || node;
          if (!(actionable instanceof Element) || !isElementVisible(actionable)) return;
          if (!isLikelyRightRailActionTarget(actionable, {maxWidth: 260, maxHeight: 260})) {
            return;
          }
          if (!looksLikeCommentHotzone(actionable)) {
            return;
          }
          candidates.push(actionable);
        });
      } catch {}
    });
  });

  const ranked = Array.from(new Set(candidates))
    .map((node) => ({
      node,
      score: scoreDirectCommentHotzone(node, {root}),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function findInteractionBarCommentTrigger() {
  const selectors = Array.from(
    new Set([
      '[data-e2e="feed-comment-icon"]',
      ".DG40dqtZ",
      ".fN2jqmuV .fcEX2ARL:nth-child(2)",
      ...(Array.isArray(DOUYIN_DOM_PROFILE?.noteDetail?.fields?.interactions?.comments)
        ? DOUYIN_DOM_PROFILE.noteDetail.fields.interactions.comments
        : []),
    ]),
  );
  const candidates = [];

  const root = findCurrentDouyinWorkRoot();
  const contexts = root ? [root, document] : [document];

  contexts.forEach((context) => {
    selectors.forEach((selector) => {
      try {
        context.querySelectorAll(selector).forEach((node) => {
          if (!(node instanceof Element) || !isElementVisible(node)) return;
          const actionable = resolveCommentIconActionableNode(node) || node;
          if (!(actionable instanceof Element) || !isElementVisible(actionable)) return;
          if (!isLikelyRightRailActionTarget(actionable, {maxWidth: 240, maxHeight: 320})) {
            return;
          }
          candidates.push(actionable);
        });
      } catch {}
    });
  });

  const ranked = Array.from(new Set(candidates))
    .map((node) => ({
      node,
      score: scoreInteractionBarCommentTrigger(node, {root}),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function findCurrentDouyinWorkRoot() {
  const selectors = Array.isArray(DOUYIN_DOM_PROFILE?.noteDetail?.rootSelectors)
    ? DOUYIN_DOM_PROFILE.noteDetail.rootSelectors
    : [];
  const candidates = [];

  selectors.forEach((selector) => {
    try {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof Element) || !isElementVisible(node)) return;
        candidates.push(node);
      });
    } catch {}
  });

  const ranked = Array.from(new Set(candidates))
    .map((node) => ({
      node,
      score: scoreCurrentWorkRoot(node),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function scoreCurrentWorkRoot(node) {
  if (!(node instanceof Element) || !isElementVisible(node)) return 0;
  const rect = safeRect(node);
  const selectors = Array.isArray(
    DOUYIN_DOM_PROFILE?.noteDetail?.rootSignals,
  )
    ? DOUYIN_DOM_PROFILE.noteDetail.rootSignals
    : [];
  const signalCount = selectors.filter((selector) => {
    try {
      return Boolean(node.querySelector(selector));
    } catch {
      return false;
    }
  }).length;
  const hasCommentEntry = Boolean(
    queryAllWithin(node, [
      '[data-e2e="feed-comment-icon"]',
      '[data-e2e="comment-icon"]',
      ".DG40dqtZ",
      ".fN2jqmuV .fcEX2ARL:nth-child(2)",
    ]).find(isElementVisible),
  );
  const hasMedia = Boolean(node.querySelector("video, img"));

  let score = signalCount * 12;
  if (hasCommentEntry) score += 32;
  if (hasMedia) score += 8;
  if (rect.width >= window.innerWidth * 0.45) score += 6;
  if (rect.height >= window.innerHeight * 0.45) score += 6;
  if (rect.top > window.innerHeight || rect.bottom < 0) score -= 40;
  if (node === document.body || node === document.documentElement) score -= 30;
  return score;
}

function resolveCommentIconActionableNode(node) {
  if (!(node instanceof Element)) {
    return null;
  }

  const preferred =
    node.closest?.('[data-e2e="feed-comment-icon"]') ||
    node.closest?.('[data-e2e="comment-icon"]') ||
    node.closest?.('[data-e2e="video-player-comment"]') ||
    node.closest?.(".DG40dqtZ") ||
    node.closest?.(".fcEX2ARL") ||
    node.closest?.('[data-e2e*="comment"]');
  if (preferred instanceof Element && isElementVisible(preferred)) {
    return preferred;
  }

  let current = node;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (!isElementVisible(current)) {
      current = current.parentElement;
      continue;
    }

    const text = cleanText(current.textContent || "");
    const attrs = [
      current.getAttribute?.("data-e2e") || "",
      current.getAttribute?.("aria-label") || "",
      current.getAttribute?.("title") || "",
      typeof current.className === "string" ? current.className : "",
    ].join(" ");
    const hasCountText = /^\d+(?:\.\d+)?[万wWkK]?$/.test(text) || /评论/.test(text);
    if (
      /feed-comment|comment-icon|player-comment|DG40dqtZ|fcEX2ARL/i.test(attrs) ||
      hasCountText
    ) {
      return current;
    }

    current = current.parentElement;
  }

  const semanticAncestor = node.closest?.('[role="button"], button, a, [tabindex]');
  if (semanticAncestor instanceof Element && isElementVisible(semanticAncestor)) {
    return semanticAncestor;
  }

  const genericAncestor = findGenericActionAncestor(node, {
    maxWidth: 360,
    maxHeight: 360,
  });
  if (genericAncestor) {
    return genericAncestor;
  }

  return (
    node.closest?.("div, span") ||
    node.closest?.("svg") ||
    node
  );
}

function findGenericActionAncestor(
  node,
  {maxWidth = 360, maxHeight = 360} = {},
) {
  let current = node instanceof Element ? node.parentElement : null;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (!isElementVisible(current)) {
      current = current.parentElement;
      continue;
    }

    const tagName = String(current.tagName || "").toLowerCase();
    if (tagName === "svg" || tagName === "g" || tagName === "path") {
      current = current.parentElement;
      continue;
    }

    const style = window.getComputedStyle(current);
    const attrs = [
      current.getAttribute?.("role") || "",
      current.getAttribute?.("tabindex") || "",
      current.getAttribute?.("data-e2e") || "",
      current.getAttribute?.("aria-label") || "",
      current.getAttribute?.("title") || "",
      typeof current.className === "string" ? current.className : "",
    ].join(" ");
    const looksGenericClickable =
      current.matches?.("div, span, button, a, li") ||
      style.cursor === "pointer" ||
      /comment|icon|action|button|btn|click|DG40dqtZ|fcEX2ARL/i.test(attrs);

    if (
      looksGenericClickable &&
      isLikelyRightRailActionTarget(current, {maxWidth, maxHeight})
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function looksLikeCommentHotzone(node) {
  if (!(node instanceof Element) || !isElementVisible(node)) {
    return false;
  }

  const text = cleanText(node.textContent || "");
  const attrs = [
    node.getAttribute?.("data-e2e") || "",
    node.getAttribute?.("aria-label") || "",
    node.getAttribute?.("title") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");
  const hasCommentSvg = Boolean(
    node.querySelector?.(`svg path[d*="${COMMENT_ICON_PATH_SIGNATURE}"]`),
  );
  const hasCountText = /^\d+(?:\.\d+)?[万wWkK]?$/.test(text);
  const hasIconWrapper = Boolean(
    node.querySelector?.(".kT7icnwc, svg, [class*=\"icon\"]"),
  );

  if (/feed-comment-icon|comment-icon|player-comment/i.test(attrs)) {
    return true;
  }

  return (hasCommentSvg || hasIconWrapper) && hasCountText;
}

function scoreDirectCommentHotzone(node, {root = null} = {}) {
  if (!(node instanceof Element) || !isElementVisible(node)) return 0;
  if (!looksLikeCommentHotzone(node)) return 0;

  const rect = safeRect(node);
  const text = cleanText(node.textContent || "");
  const attrs = [
    node.getAttribute?.("data-e2e") || "",
    node.getAttribute?.("aria-label") || "",
    node.getAttribute?.("title") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  let score = 40;
  if (node.getAttribute?.("data-e2e") === "feed-comment-icon") score += 120;
  if (/feed-comment-icon/.test(attrs)) score += 60;
  if (/comment-icon|player-comment/.test(attrs)) score += 30;
  if (node.querySelector?.(`svg path[d*="${COMMENT_ICON_PATH_SIGNATURE}"]`)) score += 35;
  if (node.querySelector?.(".kT7icnwc")) score += 18;
  if (node.children.length >= 2) score += 10;
  if (/^\d+(?:\.\d+)?[万wWkK]?$/.test(text)) score += 22;
  if (rect.width >= 32 && rect.width <= 140) score += 8;
  if (rect.height >= 40 && rect.height <= 180) score += 8;
  if (rect.left >= window.innerWidth * 0.62) score += 22;
  if (rect.left >= window.innerWidth * 0.72) score += 12;
  if (rect.top >= window.innerHeight * 0.18 && rect.top <= window.innerHeight * 0.82) {
    score += 8;
  }
  if (root instanceof Element && root.contains(node)) {
    score += 24;
  }

  return score;
}

function scoreDouyinAuthorEntryCandidate(node) {
  if (!(node instanceof Element)) return 0;
  const rect = safeRect(node);
  const text = cleanText(node.textContent || "");
  const attrText = [
    node.getAttribute?.("data-click-from") || "",
    node.getAttribute?.("data-e2e") || "",
    node.getAttribute?.("href") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  let score = 1;
  if (node.matches?.('[data-click-from="click_icon"]')) score += 45;
  if (/video-avatar|live-avatar/i.test(attrText)) score += 30;
  if (/feed-avatar/i.test(attrText)) score += 18;
  if (/click_icon/i.test(attrText)) score += 12;
  if (/\/user\//i.test(attrText)) score += 38;
  if (/feed-video-nickname/i.test(attrText)) score += 32;
  if (/nickname|account-name|user-name/i.test(attrText)) score += 18;
  if (/^@/.test(text)) score += 14;
  if (/评论|点赞|收藏|转发|分享/.test(text)) score -= 36;
  if (/comment|digg|like|collect|share/i.test(attrText)) score -= 42;
  if (rect.left >= window.innerWidth * 0.62) score += 18;
  if (rect.left <= window.innerWidth * 0.5) score -= 18;
  if (rect.top > window.innerHeight * 0.18 && rect.top <= window.innerHeight * 0.95) score += 6;
  if (rect.top <= window.innerHeight * 0.12) score -= 24;
  if (rect.width >= 20 && rect.height >= 20 && rect.width <= 160) score += 2;
  if (rect.width > 180 || rect.height > 180) score -= 20;
  return score;
}

function isLikelyDouyinUserEntry(actionable, sourceNode = null) {
  const nodes = [actionable, sourceNode].filter((node) => node instanceof Element);
  if (nodes.length === 0) return false;

  return nodes.some((node) => {
    const text = cleanText(node.textContent || "");
    const attrText = [
      node.getAttribute?.("data-e2e") || "",
      node.getAttribute?.("data-click-from") || "",
      node.getAttribute?.("href") || "",
      typeof node.className === "string" ? node.className : "",
    ].join(" ");

    return (
      /\/user\//i.test(attrText) ||
      /feed-video-nickname|video-avatar|feed-avatar|live-avatar/i.test(attrText) ||
      /nickname|account-name|user-name/i.test(attrText) ||
      /^@/.test(text)
    );
  });
}

function isLikelyRightRailActionTarget(
  node,
  {maxWidth = 220, maxHeight = 220} = {},
) {
  if (!(node instanceof Element)) return false;
  const rect = safeRect(node);
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.width > maxWidth || rect.height > maxHeight) return false;
  // 侧边栏打开后内容区会左移，右侧操作列不再总是位于 55% 之后。
  if (rect.left < window.innerWidth * 0.32) return false;
  if (rect.top < 0 || rect.top > window.innerHeight * 0.98) return false;
  return true;
}

function scoreStrictAvatarCandidate(node) {
  if (!(node instanceof Element)) return 0;
  const rect = safeRect(node);
  const attrText = [
    node.getAttribute?.("data-e2e") || "",
    node.getAttribute?.("data-click-from") || "",
    node.getAttribute?.("href") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  let score = 1;
  if (/video-avatar|feed-avatar|live-avatar/i.test(attrText)) score += 42;
  if (/\/user\//i.test(attrText)) score += 26;
  if (/click_icon/i.test(attrText)) score += 18;
  if (rect.left >= window.innerWidth * 0.74) score += 28;
  else if (rect.left >= window.innerWidth * 0.62) score += 18;
  if (rect.width >= 28 && rect.height >= 28 && rect.width <= 96 && rect.height <= 96) score += 16;
  if (rect.width > 120 || rect.height > 120) score -= 24;
  if (rect.top > window.innerHeight * 0.2 && rect.top < window.innerHeight * 0.7) score += 10;
  return score;
}

function findCommentSectionAnchor(scopeRoot = document) {
  const textAnchor = Array.from(
    scopeRoot.querySelectorAll?.("div, span, h2, h3, p") || [],
  ).find((node) => {
    const text = cleanText(node.textContent || "");
    return (
      /^全部评论(?:\(|（)?/.test(text) ||
      text === "全部评论" ||
      /^(评论区|评论列表)$/.test(text)
    );
  });

  if (textAnchor) {
    return textAnchor;
  }

  const selectorAnchor = queryVisibleElements(
    COMMENT_SECTION_ANCHOR_SELECTORS,
    scopeRoot,
  )[0];
  if (selectorAnchor) {
    return selectorAnchor;
  }

  return null;
}

function findCommentsTabTrigger() {
  const rawCandidates = queryAllWithin(document, DETAIL_TAB_CANDIDATE_SELECTORS)
    .filter(isElementVisible)
    .filter((node) => {
      const text = cleanText(node.textContent || "");
      return hasDouyinCommentsTabLabel([text], "评论");
    });

  const actionable = Array.from(
    new Set(rawCandidates.map(resolveActionableTabNode).filter(Boolean)),
  );
  if (!actionable.length) {
    return null;
  }

  const ranked = actionable
    .map((node) => ({
      node,
      score: scoreCommentsTabCandidate(node),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.node || null;
}

function hasTabbedContentFlowForComments() {
  const candidates = queryAllWithin(document, DETAIL_TAB_CANDIDATE_SELECTORS)
    .filter(isElementVisible);
  if (!candidates.length) return false;

  const containers = new Set();
  for (const node of candidates) {
    const parent = node.parentElement;
    const grand = parent?.parentElement;
    if (parent) containers.add(parent);
    if (grand) containers.add(grand);
  }

  for (const container of containers) {
    const texts = Array.from(container.children || [])
      .map((child) => cleanText(child.textContent || ""))
      .filter(Boolean);
    if (
      hasDouyinCommentsTabLabel(texts, "TA的作品") &&
      hasDouyinCommentsTabLabel(texts, "评论")
    ) {
      return true;
    }
  }

  return false;
}

function normalizeDouyinCommentsTabText(text) {
  return cleanText(text || "")
    .replace(/[（(][^()（）]*[)）]/g, "")
    .replace(/\s+/g, "");
}

function hasDouyinCommentsTabLabel(texts = [], label = "") {
  const target = normalizeDouyinCommentsTabText(label);
  if (!target) return false;
  return texts.some((text) => {
    const normalized = normalizeDouyinCommentsTabText(text);
    if (!normalized) return false;
    return normalized === target || normalized.includes(target);
  });
}

function resolveActionableTabNode(node) {
  if (!node) return null;

  const semanticClickable =
    node.closest?.('[role="tab"], [role="button"], button, a') || null;
  if (semanticClickable && isElementVisible(semanticClickable)) {
    return semanticClickable;
  }

  let current = node instanceof Element ? node : null;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (!isElementVisible(current)) {
      current = current.parentElement;
      continue;
    }

    const siblingTabCount = countKnownTabLabelsAround(current);
    const normalizedText = normalizeDouyinCommentsTabText(
      cleanText(current.textContent || ""),
    );
    if (
      siblingTabCount >= 2 &&
      (normalizedText === "评论" || normalizedText === "TA的作品")
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return node instanceof Element && isElementVisible(node) ? node : null;
}

function resolveActionableCommentNode(node) {
  if (!node) return null;

  const clickable =
    node.closest?.(
      '[data-e2e*="comment"], [role="button"], button, a, div[tabindex], span[tabindex]',
    ) || node;
  return isElementVisible(clickable) ? clickable : null;
}

function inferCommentContainerFromItems(
  scopeRoot = document.body,
  {scene = detectCommentScene({allowContainerInference: false})} = {},
) {
  const profile = resolveCommentSceneProfile(scene);
  const visibleItems = queryVisibleElements(
    profile.itemSelectors,
    scopeRoot,
  ).slice(0, 40);
  if (visibleItems.length < 2) {
    const structuralItems = collectCommentCandidateNodesByStructure(
      scopeRoot,
      scene,
    ).slice(0, 20);
    if (structuralItems.length < 2) {
      return null;
    }
    return inferCommentContainerFromCandidates(structuralItems, scene);
  }

  return inferCommentContainerFromCandidates(visibleItems, scene);
}

function inferCommentContainerFromCandidates(
  items,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
) {
  let bestNode = null;
  let bestScore = 0;

  for (const item of items) {
    let current = item;
    let depth = 0;
    while (
      current &&
      current !== document.body &&
      current !== document.documentElement &&
      depth <= 6
    ) {
      const score = scoreCommentContainerCandidate(current, depth, scene);
      if (score > bestScore) {
        bestNode = current;
        bestScore = score;
      }
      current = current.parentElement;
      depth += 1;
    }
  }

  return bestNode;
}

function inferCommentContainerAround(
  anchor,
  {scene = detectCommentScene({allowContainerInference: false})} = {},
) {
  let current = anchor;
  let depth = 0;
  let bestNode = null;
  let bestScore = 0;
  while (
    current &&
    current !== document.body &&
    current !== document.documentElement &&
      depth <= 6
  ) {
    const score = scoreCommentContainerCandidate(current, depth, scene);
    if (score > bestScore) {
      bestNode = current;
      bestScore = score;
    }
    current = current.parentElement;
    depth += 1;
  }
  return bestNode;
}

function scoreCommentContainerCandidate(
  node,
  depth = 0,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
) {
  if (!node || !isElementVisible(node)) return 0;
  if (!isVisibleDouyinCommentSurface(node)) return 0;

  const rect = safeRect(node);
  if (rect.width < 100 || rect.height < 60) return 0;

  const profile = resolveCommentSceneProfile(scene);
  const itemCount = Math.max(
    queryAllWithin(node, profile.itemSelectors).length,
    collectCommentCandidateNodesFromUserLinks(node, scene).length,
    collectCommentCandidateNodesByStructure(node, scene).length,
  );
  const containerText = cleanText(node.textContent || "");
  const hasCommentText = /评论/.test(containerText);
  const hasSingleCommentSignals =
    itemCount >= 1 &&
    /(回复|展开\d+条回复|刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前)/.test(
      containerText,
    );
  if (itemCount < 1 && !hasCommentText) return 0;
  if (itemCount < 2 && !hasCommentText && !hasSingleCommentSignals) return 0;

  let score = itemCount * 10;
  if (isScrollableContainer(node)) score += 18;
  if (/全部评论|评论区|留下你的精彩评论吧/.test(containerText)) score += 8;
  if (node.querySelector?.('[placeholder*="评论"]')) score += 4;
  if (itemCount >= 1) score += 10;
  score -= depth * 2;
  return score;
}

function isCommentSurfaceLoading() {
  const loadingNodes = document.querySelectorAll("div, span, p");
  return Array.from(loadingNodes).some((node) => {
    if (!isElementVisible(node)) return false;
    const text = cleanText(node.textContent || "");
    return /^(加载中|正在加载|加载中\.\.\.)$/.test(text);
  });
}

function isCommentSurfacePendingNode(node) {
  if (!(node instanceof Element) || !isElementVisible(node)) {
    return false;
  }

  const text = cleanText(node.innerText || node.textContent || "");
  if (!/^(加载中|正在加载|加载中\.\.\.)$/.test(text)) {
    return false;
  }

  return COMMENT_LIST_SELECTORS.some((selector) => {
    try {
      return node.matches?.(selector);
    } catch {
      return false;
    }
  });
}

async function waitForCommentSurfaceReady(
  container,
  {
    timeout = 6500,
    interval = 120,
    scene = COMMENT_SCENE.DETAIL_BOTTOM,
    captureContext = null,
  } = {},
) {
  if (!(container instanceof Element)) {
    return false;
  }

  const isReady = () => {
    const latestContainer =
      findVisibleCommentContainer({scene, captureContext}) || container;
    return !isCommentSurfacePendingNode(latestContainer) && !isCommentSurfaceLoading();
  };

  if (isReady()) {
    return true;
  }

  return await waitUntil(isReady, {
    timeout,
    interval,
  }).catch(() => false);
}

async function waitForVisibleCommentContainer({
  timeout = 8000,
  interval = 120,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
  captureContext = null,
} = {}) {
  const found = await waitUntil(
    () => Boolean(findVisibleCommentContainer({scene, captureContext})),
    {
      timeout,
      interval,
    },
  ).catch(() => false);
  if (found) {
    return true;
  }

  if (!isCommentSurfaceLoading()) {
    return false;
  }

  return waitUntil(
    () =>
      Boolean(findVisibleCommentContainer({scene, captureContext})) ||
      !isCommentSurfaceLoading(),
    {
      timeout: Math.min(6000, Math.max(1500, timeout)),
      interval,
    },
  )
    .then(() => Boolean(findVisibleCommentContainer({scene, captureContext})))
    .catch(() => false);
}

function scoreCommentsTabCandidate(node) {
  if (!node) return 0;

  const rect = safeRect(node);
  const normalizedText = normalizeDouyinCommentsTabText(
    cleanText(node.textContent || ""),
  );
  let score = 1;
  const knownSiblingCount = countKnownTabLabelsAround(node);
  const attributes = [
    node.getAttribute?.("role") || "",
    node.getAttribute?.("aria-selected") || "",
    node.getAttribute?.("aria-current") || "",
    node.getAttribute?.("data-e2e") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");
  const siblingTexts = collectSiblingTabTexts(node);
  const hasRelatedTabs =
    hasDouyinCommentsTabLabel(siblingTexts, "相关推荐") ||
    hasDouyinCommentsTabLabel(siblingTexts, "TA的作品") ||
    hasDouyinCommentsTabLabel(siblingTexts, "详情");
  const looksLikeCommentCountTab =
    /^评论(?:[（(]?\d+(?:\.\d+)?[万wWkK]?[)）]?)?$/.test(
      cleanText(node.textContent || ""),
    );

  if (knownSiblingCount >= 2) {
    score += 24 + knownSiblingCount * 3;
  }
  if (hasRelatedTabs) {
    score += 18;
  }
  if (node.getAttribute?.("role") === "tab") {
    score += 12;
  }
  if (node.closest?.('[role="tablist"]')) {
    score += 10;
  }
  if (normalizedText === "评论") {
    score += 12;
  } else if (normalizedText.includes("评论")) {
    score += 6;
  }
  if (looksLikeCommentCountTab) {
    score += 12;
  }
  if (/tab|Tabs?|selected|active|current/i.test(attributes)) {
    score += 8;
  }
  if (rect.top >= 0 && rect.top <= window.innerHeight * 0.45) {
    score += 4;
  }
  if (rect.width > 16 && rect.width <= 140 && rect.height > 12 && rect.height <= 72) {
    score += 3;
  }
  if (knownSiblingCount === 0 && !looksLikeCommentCountTab) {
    score -= 24;
  }
  if (!hasRelatedTabs && knownSiblingCount < 2) {
    score -= 18;
  }

  return score;
}

function collectSiblingTabTexts(node) {
  const containers = [
    node?.parentElement || null,
    node?.parentElement?.parentElement || null,
  ].filter(Boolean);
  const texts = [];
  containers.forEach((container) => {
    Array.from(container.children || []).forEach((child) => {
      const text = cleanText(child.textContent || "");
      if (text) {
        texts.push(text);
      }
    });
  });
  return texts;
}

function isVisibleDouyinCommentSurface(node) {
  if (!(node instanceof Element) || !isElementVisible(node)) {
    return false;
  }

  const text = cleanText(node.innerText || node.textContent || "");
  const normalized = text.replace(/\s+/g, "");
  if (!text) {
    return false;
  }

  const hasCommentInput =
    !!node.querySelector('[placeholder*="评论"]') ||
    /留下你的精彩评论吧|全部评论|评论区/.test(text);
  const hasCommentActions = /分享|回复|展开\d+条回复/.test(text);
  const hasCommentTime = /(刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前)/.test(text);
  const hasCommentUsers = node.querySelectorAll('a[href*="/user/"]').length >= 1;
  const hasCommentItems =
    queryAllWithin(node, COMMENT_ITEM_SELECTORS).length >= 1 ||
    collectCommentCandidateNodesFromUserLinks(node).length >= 1 ||
    collectCommentCandidateNodesByStructure(node).length >= 1;
  const hasReplySignals = /回复|展开\d+条回复/.test(text);
  const hasRecommendationPlaybackSignals = looksLikeRecommendationPlaybackNode(
    node,
    text,
  );

  if (hasCommentInput) {
    return true;
  }

  if (hasRecommendationPlaybackSignals && !hasReplySignals) {
    return false;
  }

  if (looksLikePrivateMessageNode(node)) {
    return false;
  }

  if (hasCommentUsers && hasCommentActions && hasCommentTime) {
    return true;
  }

  if (hasCommentUsers && hasCommentTime && hasCommentItems) {
    return true;
  }

  if (hasCommentItems && hasReplySignals) {
    return true;
  }

  if (isLikelyRecommendationsOnlyContainer(node, normalized)) {
    return false;
  }

  return false;
}

function isLikelyRecommendationsOnlyContainer(node, normalizedText = "") {
  if (!(node instanceof Element)) {
    return false;
  }

  const normalized = normalizedText || cleanText(node.innerText || node.textContent || "").replace(/\s+/g, "");
  const hasRelatedTab = normalized.includes("相关推荐");
  const hasCommentTab = normalized.includes("评论");
  const hasRecommendationCards =
    node.querySelectorAll('img[alt], [role="img"], h3, [aria-level="3"]').length >= 3;
  const hasDurations = /\b\d{2}:\d{2}\b/.test(normalized);
  const hasCommentSignals = /(分享|回复|展开\d+条回复|刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前)/.test(normalized);

  return hasRelatedTab && hasCommentTab && hasRecommendationCards && hasDurations && !hasCommentSignals;
}

function scoreCommentButtonCandidate(node) {
  if (!node || !isElementVisible(node)) return 0;
  if (!isLikelyRightRailActionTarget(node, {maxWidth: 200, maxHeight: 200})) {
    return 0;
  }

  const rect = safeRect(node);
  const text = cleanText(node.textContent || "");
  const attrs = [
    node.getAttribute?.("data-e2e") || "",
    node.getAttribute?.("aria-label") || "",
    node.getAttribute?.("title") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  let score = 1;
  if (/feed-comment-icon|comment-icon|player-comment|DG40dqtZ|kT7icnwc/i.test(attrs)) score += 32;
  if (/评论/.test(text)) score += 10;
  if (/^\d+(?:\.\d+)?[万wWkK]?$/.test(text)) score += 8;
  if (rect.right >= window.innerWidth * 0.72) score += 14;
  if (rect.left <= window.innerWidth * 0.55) score -= 16;
  if (rect.top >= 0 && rect.top <= window.innerHeight * 0.9) score += 4;
  if (rect.width >= 20 && rect.height >= 20 && rect.width <= 120) score += 3;
  if (rect.width > 180 || rect.height > 180) score -= 18;
  if (node.closest?.('[data-e2e="comment-list"], [data-e2e*="comment-list"]')) {
    score -= 30;
  }

  return score;
}

function scoreInteractionBarCommentTrigger(node, {root = null} = {}) {
  if (!(node instanceof Element) || !isElementVisible(node)) return 0;

  const rect = safeRect(node);
  const text = cleanText(node.textContent || "");
  const attrs = [
    node.getAttribute?.("data-e2e") || "",
    node.getAttribute?.("aria-label") || "",
    node.getAttribute?.("title") || "",
    typeof node.className === "string" ? node.className : "",
  ].join(" ");

  let score = scoreCommentButtonCandidate(node) + 8;
  if (/DG40dqtZ|fcEX2ARL|comment/i.test(attrs)) score += 18;
  if (/^\d+(?:\.\d+)?[万wWkK]?$/.test(text)) score += 16;
  if (rect.height >= 28 && rect.height <= 120) score += 8;
  if (rect.top >= window.innerHeight * 0.22 && rect.top <= window.innerHeight * 0.82) {
    score += 10;
  }
  if (root instanceof Element && root.contains(node)) {
    score += 16;
  }
  return score;
}

function countKnownTabLabelsAround(node) {
  const containers = [
    node?.parentElement || null,
    node?.parentElement?.parentElement || null,
  ].filter(Boolean);

  let maxCount = 0;
  for (const container of containers) {
    const texts = Array.from(container.children || [])
      .map((child) => cleanText(child.textContent || ""))
      .filter(Boolean);
    const count = DETAIL_TAB_LABELS.filter((label) =>
      hasDouyinCommentsTabLabel(texts, label),
    ).length;
    maxCount = Math.max(maxCount, count);
  }

  return maxCount;
}

function collectVisibleComments(
  container,
  commentsMap,
  maxDetectedItems,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
  captureContext = null,
) {
  if (commentsMap.size >= maxDetectedItems) return;
  if (hasEmptyCommentState(container)) return;
  const profile = resolveCommentSceneProfile(scene);
  const beforeSize = commentsMap.size;

  let candidates = Array.from(
    new Set([
      ...queryAllWithin(container, profile.itemSelectors),
      ...collectCommentCandidateNodesFromUserLinks(container, scene),
      ...collectCommentCandidateNodesByStructure(container, scene),
    ]),
  );

  if (candidates.length === 0 && container.children.length > 0) {
    let listParent = container;
    if (container.children.length === 1 && container.children[0].children.length > 1) {
      listParent = container.children[0];
    }
    candidates = Array.from(listParent.children).filter(
      (node) => node instanceof Element && isElementVisible(node),
    );
  }

  if (scene === COMMENT_SCENE.CONTENT_FEED) {
    const terminalNode = findTerminalTextNode(container);
    if (terminalNode instanceof Element) {
      const terminalRect = safeRect(terminalNode);
      candidates = candidates.filter((node) => {
        if (!(node instanceof Element)) return false;
        if (node === terminalNode || node.contains(terminalNode) || terminalNode.contains(node)) {
          return false;
        }
        return safeRect(node).top < terminalRect.top - 4;
      });
    }
  }

  incrementCommentDiagnostic(captureContext, "candidateCount", candidates.length);
  candidates = filterNestedCommentCandidates(candidates, scene, captureContext);
  incrementCommentDiagnostic(
    captureContext,
    "candidateCountAfterFilter",
    candidates.length,
  );

  appendExtractedCommentsFromCandidates(
    candidates,
    commentsMap,
    maxDetectedItems,
    scene,
    captureContext,
  );

  if (
    scene !== COMMENT_SCENE.CONTENT_FEED &&
    commentsMap.size === beforeSize &&
    container !== document.body
  ) {
    const fallbackCandidates = collectVisibleCommentCandidatesNearAnchor(scene);
    appendExtractedCommentsFromCandidates(
      fallbackCandidates,
      commentsMap,
      maxDetectedItems,
      scene,
      captureContext,
    );
  }
}

function appendExtractedCommentsFromCandidates(
  candidates,
  commentsMap,
  maxDetectedItems,
  scene,
  captureContext = null,
) {
  for (const node of candidates) {
    const extraction = extractCommentDetailed(node, scene);
    if (!extraction.comment) {
      recordCommentReject(
        captureContext,
        extraction.rejectReason || "comment_extract_failed",
        extraction.reasonBucket || COMMENT_DIAGNOSTIC_REASON_BUCKET.GENERAL,
      );
      continue;
    }
    incrementCommentDiagnostic(captureContext, "extractedCount", 1);
    const comment = extraction.comment;
    const existing = commentsMap.get(comment.key);
    if (existing) {
      if (scoreExtractedCommentData(comment.data) > scoreExtractedCommentData(existing)) {
        commentsMap.set(comment.key, comment.data);
        incrementCommentDiagnostic(captureContext, "updatedCount", 1);
      }
      continue;
    }
    commentsMap.set(comment.key, comment.data);
    incrementCommentDiagnostic(captureContext, "acceptedCount", 1);
    if (commentsMap.size >= maxDetectedItems) {
      return;
    }
  }
}

function filterNestedCommentCandidates(
  candidates,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
  captureContext = null,
) {
  const uniqueCandidates = Array.from(
    new Set(
      (Array.isArray(candidates) ? candidates : []).filter(
        (node) => node instanceof Element && isElementVisible(node),
      ),
    ),
  );
  const scored = uniqueCandidates
    .map((node) => {
      const evaluation = evaluateLikelyCommentEntryNode(
        node,
        resolveCommentSceneProfile(scene),
      );
      return {
        node,
        score: evaluation.score,
        rejectReason: evaluation.rejectReason,
        area: getNodeArea(node),
        depth: getNodeDepth(node),
      };
    })
    .filter(({score, rejectReason}) => {
      if (score > 0) {
        return true;
      }
      recordCommentReject(
        captureContext,
        rejectReason || "score_below_comment_threshold",
        COMMENT_DIAGNOSTIC_REASON_BUCKET.NODE,
      );
      return false;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.depth !== left.depth) return right.depth - left.depth;
      return left.area - right.area;
    });

  const retained = [];
  for (const candidate of scored) {
    const hasBetterDescendant = retained.some(
      (item) =>
        candidate.node.contains(item.node) &&
        item.score >= candidate.score - 4,
    );
    if (hasBetterDescendant) {
      recordCommentReject(
        captureContext,
        "nested_descendant_pruned",
        COMMENT_DIAGNOSTIC_REASON_BUCKET.NODE,
      );
      continue;
    }

    for (let index = retained.length - 1; index >= 0; index -= 1) {
      const existing = retained[index];
      if (
        existing.node.contains(candidate.node) &&
        candidate.score >= existing.score - 4
      ) {
        retained.splice(index, 1);
      }
    }

    retained.push(candidate);
  }

  return retained
    .sort((left, right) => {
      const leftRect = safeRect(left.node);
      const rightRect = safeRect(right.node);
      if (leftRect.top !== rightRect.top) return leftRect.top - rightRect.top;
      return leftRect.left - rightRect.left;
    })
    .map(({node}) => node);
}

function collectVisibleCommentCandidatesNearAnchor(scene) {
  const anchor = findCommentSectionAnchor();
  const anchorRect = anchor ? safeRect(anchor) : null;
  return collectCommentCandidateNodesByStructure(document.body, scene)
    .filter((node) => {
      const rect = safeRect(node);
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        return false;
      }
      if (anchorRect && rect.top < anchorRect.top - 80) {
        return false;
      }
      return true;
    })
    .slice(0, 80);
}

function collectCommentCandidateNodesFromUserLinks(
  container,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
) {
  if (!(container instanceof Element)) {
    return [];
  }

  const candidates = [];
  const userLinks = Array.from(container.querySelectorAll('a[href*="/user/"]'))
    .filter((node) => isElementVisible(node))
    .slice(0, 120);

  userLinks.forEach((link) => {
    let current = link;
    for (let depth = 0; current && depth < 7; depth += 1) {
      if (
        current instanceof Element &&
        isElementVisible(current) &&
        isLikelyCommentEntryNode(current, scene)
      ) {
        candidates.push(current);
        break;
      }
      current = current.parentElement;
    }
  });

  return Array.from(new Set(candidates)).sort((left, right) => {
    const leftDepth = getNodeDepth(left);
    const rightDepth = getNodeDepth(right);
    if (rightDepth !== leftDepth) {
      return rightDepth - leftDepth;
    }
    return getNodeArea(left) - getNodeArea(right);
  });
}

function collectCommentCandidateNodesByStructure(
  container,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
) {
  if (!(container instanceof Element)) {
    return [];
  }

  const profile = resolveCommentSceneProfile(scene);
  const pool = Array.from(container.querySelectorAll("div, li, article, section"))
    .filter((node) => node instanceof Element && isElementVisible(node))
    .slice(0, 400);

  return pool
    .map((node) => ({
      node,
      score: scoreLikelyCommentEntryNode(node, profile),
    }))
    .filter(({score}) => score >= 16)
    .sort((left, right) => right.score - left.score)
    .map(({node}) => node)
    .filter((node, index, list) => list.indexOf(node) === index)
    .slice(0, 120);
}

function isLikelyCommentEntryNode(
  node,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
) {
  return scoreLikelyCommentEntryNode(node, resolveCommentSceneProfile(scene)) >= 16;
}

function looksLikePrivateMessageNode(node) {
  if (!(node instanceof Element)) return false;

  const imAncestorSelectors = [
    '[class*="im-"]',
    '[class*="chat-"]',
    '[class*="message-list"]',
    '[class*="conversation"]',
    '[class*="inbox"]',
    '[class*="letter"]',
    '[class*="private-message"]',
    '[class*="PrivateMessage"]',
    '[class*="ChatPanel"]',
    '[class*="chat_panel"]',
    '[data-e2e*="im-"]',
    '[data-e2e*="chat"]',
    '[data-e2e*="message"]',
  ];

  for (const sel of imAncestorSelectors) {
    try {
      if (node.closest?.(sel) || node.matches?.(sel)) return true;
    } catch {}
  }

  const text = cleanText(node.innerText || node.textContent || "");
  if (/私信可在[\[【]设置/.test(text)) return true;
  if (/隐私设置.*在线状态/.test(text)) return true;
  if (/修改在线状态.*去设置/.test(text)) return true;

  return false;
}

function scoreLikelyCommentEntryNode(node, profile = resolveCommentSceneProfile()) {
  return evaluateLikelyCommentEntryNode(node, profile).score;
}

function evaluateLikelyCommentEntryNode(
  node,
  profile = resolveCommentSceneProfile(),
) {
  if (!(node instanceof Element) || !isElementVisible(node)) {
    return {score: 0, rejectReason: "node_not_visible"};
  }

  const text = cleanText(node.innerText || node.textContent || "");
  if (!text || text.length < 8 || text.length > 1200) {
    return {score: 0, rejectReason: "text_empty_or_out_of_range"};
  }
  const normalized = text.replace(/\s+/g, "");
  if (/^(相关推荐|大家都在搜|留下你的精彩评论吧|评论区|全部评论)/.test(normalized)) {
    return {score: 0, rejectReason: "comment_heading_only"};
  }
  if (isLikelyRecommendationsOnlyContainer(node, normalized)) {
    return {score: 0, rejectReason: "recommendation_only_container"};
  }
  if (looksLikeRecommendationPlaybackNode(node, text)) {
    return {score: 0, rejectReason: "recommendation_playback"};
  }
  if (looksLikeRecommendationContentCardNode(node, text)) {
    return {score: 0, rejectReason: "recommendation_content_card"};
  }
  if (looksLikePrivateMessageNode(node)) {
    return {score: 0, rejectReason: "private_message_like"};
  }
  if (looksLikeCommentGroupContainer(node, text)) {
    return {score: 0, rejectReason: "comment_group_container"};
  }

  const rect = safeRect(node);
  let score = 0;
  const hasUserLink = !!node.querySelector('a[href*="/user/"]');
  const userNameText = queryText(node, profile.userNameSelectors);
  const hasAvatarSignal = hasLikelyCommentAvatarSignal(node);
  const fallbackUserName =
    !hasUserLink && !userNameText && hasAvatarSignal
      ? inferCommentUserNameFromText(node)
      : "";
  const hasUserName = Boolean(userNameText || fallbackUserName);
  const parsedMeta = parseCommentMeta(text);
  const selectorContent = queryText(node, profile.contentSelectors);
  const hasContent =
    Boolean(selectorContent) ||
    hasLikelyCommentContentCandidate(node, {
      userName: userNameText || fallbackUserName,
      publishTime: parsedMeta.publishTime,
      ipLocation: parsedMeta.ipLocation,
    });
  const hasMeta = Boolean(queryText(node, profile.metaSelectors)) ||
    /(刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前)/.test(text);
  const hasLike = Boolean(queryText(node, profile.likesSelectors)) ||
    /(?:^|\s)\d+(?:\.\d+)?(?:万|亿|w|W|k|K)?(?:\s|$)/.test(text);
  const hasActions = /回复|分享|展开\d+条回复/.test(text);
  const hasReplySignals = /回复|展开\d+条回复/.test(text);

  if (!hasContent) return {score: 0, rejectReason: "missing_content_signal"};
  if (!(hasUserLink || hasUserName)) {
    return {score: 0, rejectReason: "missing_user_signal"};
  }
  if (!(hasMeta || hasLike || hasActions)) {
    return {score: 0, rejectReason: "missing_meta_or_action_signal"};
  }

  if (hasUserLink) score += 12;
  if (hasUserName) score += 12;
  if (hasContent) score += 20;
  if (hasMeta) score += 14;
  if (hasLike) score += 8;
  if (hasActions) score += 10;
  if (rect.width >= 120 && rect.width <= Math.max(window.innerWidth * 0.9, 320)) score += 4;
  if (rect.height >= 60 && rect.height <= 800) score += 4;
  if (node.querySelectorAll("img").length > 4) score -= 12;
  if (node.querySelectorAll("video").length > 0) score -= 18;
  if (text.length > 700) score -= 10;
  if (hasMeta && hasContent && (hasUserLink || hasUserName)) score += 10;
  if (hasMeta && hasContent && !hasReplySignals) score += 6;
  if (!hasReplySignals && /\b\d{2}:\d{2}\b/.test(text)) score -= 30;
  if (!hasReplySignals && /播放中/.test(text)) score -= 30;

  return {
    score,
    rejectReason: score >= 16 ? "" : "score_below_comment_threshold",
  };
}

function hasLikelyCommentAvatarSignal(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  return Array.from(node.querySelectorAll("img")).some((image) => {
    if (!(image instanceof Element) || !isElementVisible(image)) {
      return false;
    }
    const attrs = [
      image.getAttribute?.("alt") || "",
      image.getAttribute?.("src") || "",
      image.getAttribute?.("data-e2e") || "",
      typeof image.className === "string" ? image.className : "",
    ].join(" ");
    return /头像|avatar|aweme-avatar|user/i.test(attrs);
  });
}

function looksLikeCommentGroupContainer(node, rawText = "") {
  if (!(node instanceof Element)) {
    return false;
  }

  if (node.matches?.('[data-comment-id], [data-e2e*="comment-item"]')) {
    return false;
  }

  const text = cleanText(rawText || node.innerText || node.textContent || "");
  const userLinkCount = node.querySelectorAll('a[href*="/user/"]').length;
  const nestedItemCount = node.querySelectorAll(
    '[data-comment-id], [data-e2e*="comment-item"], [class*="comment-item"], [class*="CommentItem"]',
  ).length;
  const timeCount = (
    text.match(
      /刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前|\d{1,2}月\d{1,2}日|\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?/g,
    ) || []
  ).length;

  if (nestedItemCount >= 2) {
    return true;
  }
  return userLinkCount >= 2 && timeCount >= 2;
}

function hasLikelyCommentContentCandidate(
  node,
  {userName = "", publishTime = "", ipLocation = "", likes = 0} = {},
) {
  const texts = [
    ...collectCommentTextCandidates(node),
    ...collectRenderedCommentTextLines(node),
  ];
  return texts.some((text) => {
    const sanitized = sanitizeCommentContentCandidateDetailed(text, {
      userName,
      publishTime,
      ipLocation,
      likes,
    });
    return isLikelyCommentBodyText(sanitized.text);
  });
}

function collectRenderedCommentTextLines(node) {
  const rawText = [node?.innerText, node?.textContent]
    .map((value) => String(value || ""))
    .filter(Boolean)
    .join("\n");
  if (!rawText) {
    return [];
  }
  return rawText
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function isLikelyCommentBodyText(text) {
  const normalized = cleanText(text || "");
  if (!normalized) {
    return false;
  }
  if (normalized.length > COMMENT_CONTENT_MAX_LENGTH) {
    return false;
  }
  if (
    /^(相关推荐|大家都在搜|留下你的精彩评论吧|评论区|全部评论(?:[（(]\d+[^）)]*[）)])?|分享|回复|作者回复过|作者赞过|展开\d+条回复|收起|IP属地.*)$/.test(
      normalized,
    )
  ) {
    return false;
  }
  if (looksLikeCommentActionCluster(normalized)) {
    return false;
  }
  if (/^(播放中|\d{2}:\d{2}|\d{2}\/\d{2})$/.test(normalized)) {
    return false;
  }
  if (/^[\d.]+(?:万|亿|w|W|k|K)?$/.test(normalized)) {
    return false;
  }
  if (looksLikeStandaloneCommentMeta(normalized)) {
    return false;
  }
  return getCommentContentScore(normalized) > 0;
}

function extractComment(node, scene = COMMENT_SCENE.DETAIL_BOTTOM) {
  return extractCommentDetailed(node, scene).comment;
}

function extractCommentDetailed(node, scene = COMMENT_SCENE.DETAIL_BOTTOM) {
  if (!node || !isElementVisible(node)) {
    return {
      comment: null,
      rejectReason: "node_not_visible",
      reasonBucket: COMMENT_DIAGNOSTIC_REASON_BUCKET.NODE,
    };
  }
  if (looksLikeRecommendationPlaybackNode(node)) {
    return {
      comment: null,
      rejectReason: "recommendation_playback",
      reasonBucket: COMMENT_DIAGNOSTIC_REASON_BUCKET.NODE,
    };
  }
  if (looksLikeRecommendationContentCardNode(node)) {
    return {
      comment: null,
      rejectReason: "recommendation_content_card",
      reasonBucket: COMMENT_DIAGNOSTIC_REASON_BUCKET.NODE,
    };
  }
  if (looksLikePrivateMessageNode(node)) {
    return {
      comment: null,
      rejectReason: "private_message_like",
      reasonBucket: COMMENT_DIAGNOSTIC_REASON_BUCKET.NODE,
    };
  }

  const profile = resolveCommentSceneProfile(scene);
  const userLinkElement = findBestCommentUserLinkElement(node, profile);
  const userUrl = normalizeUrl(userLinkElement?.getAttribute("href") || "");
  let userName = extractCommentUserName(node, profile, {userLinkElement});
  if (!userName) {
    userName = inferCommentUserNameFromText(node, profile);
  }
  const userId = extractUserId(userUrl) || "";
  const {publishTime, ipLocation} = extractCommentMeta(node, profile);
  const likes = extractCommentLikes(node, profile);
  const contentResult = extractCommentContentDetailed(node, {
    userName,
    publishTime,
    ipLocation,
    likes,
    profile,
  });
  const content = contentResult.content;
  if (!content) {
    return {
      comment: null,
      rejectReason: contentResult.rejectReason || "empty_content_after_sanitize",
      reasonBucket:
        contentResult.reasonBucket || COMMENT_DIAGNOSTIC_REASON_BUCKET.CONTENT,
    };
  }
  if (
    scene === COMMENT_SCENE.CONTENT_FEED &&
    isLikelyNonCommentContentRecord({
      node,
      userName,
      userId,
      content,
      publishTime,
      ipLocation,
    })
  ) {
    return {
      comment: null,
      rejectReason: "content_feed_non_comment_record",
      reasonBucket: COMMENT_DIAGNOSTIC_REASON_BUCKET.NODE,
    };
  }

  const commentId = resolveCommentId(node, content, userId, likes);
  const semanticKey = resolveCommentSemanticKey({
    commentId,
    userId,
    userName,
    content,
    publishTime,
    ipLocation,
    isReply: isReplyNode(node),
  });
  const key = semanticKey || commentId || `${userId || "anonymous"}|${content}`;

  return {
    comment: {
      key,
      data: {
        commentId,
        userName,
        userId,
        userUrl,
        ipLocation,
        content,
        likes,
        publishTime,
        replyCount: resolveReplyCount(node),
        isReply: isReplyNode(node),
        capturedAt: Date.now(),
      },
    },
    rejectReason: "",
    reasonBucket: COMMENT_DIAGNOSTIC_REASON_BUCKET.GENERAL,
  };
}

function findBestCommentUserLinkElement(
  node,
  profile = resolveCommentSceneProfile(),
) {
  const candidates = Array.from(
    new Set([
      ...queryWithinOrSelf(node, ['a[href*="/user/"]']),
      ...queryWithinOrSelf(node, profile.userNameSelectors).filter(
        (element) => element instanceof Element,
      ),
    ]),
  ).filter(
    (element) =>
      element instanceof Element &&
      element.matches?.('a[href*="/user/"]') &&
      isElementVisible(element),
  );

  if (!candidates.length) {
    return null;
  }

  const ranked = candidates
    .map((element) => ({
      element,
      score: scoreCommentUserLinkCandidate(element, node),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.element || candidates[0] || null;
}

function extractCommentUserName(
  node,
  profile = resolveCommentSceneProfile(),
  {userLinkElement = null} = {},
) {
  const candidates = [];
  const pushCandidate = (element, source = "") => {
    if (!(element instanceof Element) || !isElementVisible(element)) {
      return;
    }
    const text = cleanText(element.textContent || "");
    if (!text) {
      return;
    }
    candidates.push({
      element,
      text,
      source,
      score: scoreCommentUserNameCandidate(text, element, node, source),
    });
  };

  if (userLinkElement instanceof Element) {
    pushCandidate(userLinkElement, "user_link");
    Array.from(userLinkElement.querySelectorAll("span, div")).forEach((element) =>
      pushCandidate(element, "user_link_child"),
    );
  }

  queryWithinOrSelf(node, profile.userNameSelectors).forEach((element) =>
    pushCandidate(element, "selector"),
  );

  const ranked = candidates
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.text || "";
}

function extractCommentContent(
  node,
  {
    userName = "",
    publishTime = "",
    ipLocation = "",
    likes = 0,
    profile = resolveCommentSceneProfile(),
  } = {},
) {
  return extractCommentContentDetailed(node, {
    userName,
    publishTime,
    ipLocation,
    likes,
    profile,
  }).content;
}

function extractCommentContentDetailed(
  node,
  {
    userName = "",
    publishTime = "",
    ipLocation = "",
    likes = 0,
    profile = resolveCommentSceneProfile(),
  } = {},
) {
  let content = queryText(node, profile.contentSelectors);
  let rejectReason = "";

  const directSanitized = sanitizeCommentContentCandidateDetailed(content, {
    userName,
    publishTime,
    ipLocation,
    likes,
  });
  content = directSanitized.text;
  rejectReason = directSanitized.rejectReason || rejectReason;

  if (!content) {
    const validTexts = collectCommentTextCandidates(node)
      .map((text) => {
        const sanitized = sanitizeCommentContentCandidateDetailed(text, {
          userName,
          publishTime,
          ipLocation,
          likes,
        });
        if (!rejectReason && sanitized.rejectReason) {
          rejectReason = sanitized.rejectReason;
        }
        return sanitized;
      })
      .filter((item) => Boolean(item.text))
      .sort((left, right) =>
        scoreCommentContentCandidate(left.text, right.text),
      );

    if (validTexts.length > 0) {
      content = validTexts[0].text;
    }
  }

  if (!content) {
    content = inferCommentContentFromText(node, {
      userName,
      publishTime,
      ipLocation,
      likes,
    });
    if (!content && !rejectReason) {
      rejectReason = "content_inference_failed";
    }
  }

  if (!content) {
    return {
      content: "",
      rejectReason: rejectReason || "empty_content_after_sanitize",
      reasonBucket: COMMENT_DIAGNOSTIC_REASON_BUCKET.CONTENT,
    };
  }
  return {
    content:
      content.length <= COMMENT_CONTENT_MAX_LENGTH
        ? content
        : `${content.slice(0, COMMENT_CONTENT_MAX_LENGTH)}...`,
    rejectReason: "",
    reasonBucket: COMMENT_DIAGNOSTIC_REASON_BUCKET.CONTENT,
  };
}

function inferCommentUserNameFromText(node) {
  const texts = Array.from(node.querySelectorAll('a[href*="/user/"], span, div, p'))
    .map((child) => cleanText(child.textContent || ""))
    .filter(Boolean);
  const ranked = texts
    .map((text) => ({
      text,
      score: scoreCommentUserNameCandidate(text, null, node, "text_fallback"),
    }))
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.text || "";
}

function inferCommentContentFromText(
  node,
  {userName = "", publishTime = "", ipLocation = "", likes = 0} = {},
) {
  const fullText = cleanText(node.innerText || node.textContent || "");
  if (!fullText) {
    return "";
  }

  const lines = fullText
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => {
      return !/^(相关推荐|大家都在搜|留下你的精彩评论吧|评论区|全部评论|分享|回复|展开\d+条回复|刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|IP属地.*)$/.test(line);
    });

  if (lines.length === 0) {
    return "";
  }

  const preferred = lines
    .map((line) =>
      sanitizeCommentContentCandidate(line, {
        userName,
        publishTime,
        ipLocation,
        likes,
      }),
    )
    .find(Boolean);
  return preferred || "";
}

function collectCommentTextCandidates(node) {
  const candidates = [];
  const elements = Array.from(node.querySelectorAll("span, p, div, a, button"));

  elements.forEach((element) => {
    if (!(element instanceof Element) || !isUsableCommentTextElement(element, node)) {
      return;
    }
    if (element.querySelector('a[href*="/user/"]')) {
      return;
    }
    const text = cleanText(element.textContent || "");
    if (text) {
      candidates.push(text);
    }

    const leafTexts = Array.from(element.childNodes || [])
      .filter((child) => child?.nodeType === Node.TEXT_NODE)
      .map((child) => cleanText(child.nodeValue || ""))
      .filter(Boolean);
    candidates.push(...leafTexts);
  });

  const leafTexts = Array.from(node.childNodes || [])
    .filter((child) => child?.nodeType === Node.TEXT_NODE)
    .map((child) => cleanText(child.nodeValue || ""))
    .filter(Boolean);
  candidates.push(...leafTexts);

  return Array.from(new Set(candidates));
}

function isUsableCommentTextElement(element, rootNode) {
  if (!(element instanceof Element)) {
    return false;
  }
  if (isElementVisible(element)) {
    return true;
  }
  if (!(rootNode instanceof Element) || !isElementVisible(rootNode)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

function scoreCommentContentCandidate(left, right) {
  return getCommentContentScore(right) - getCommentContentScore(left);
}

function getCommentContentScore(text) {
  const normalized = cleanText(text);
  if (!normalized) return -1;

  let score = normalized.length;
  if (/[\u4e00-\u9fa5]/.test(normalized)) score += 20;
  if (/[，。！？、,.!?]/.test(normalized)) score += 10;
  if (normalized.length >= 4) score += 8;
  if (/头像|分享\s*回复|作者回复过|IP属地/.test(normalized)) score -= 80;
  if (/^[\d.]+(?:万|亿|w|W|k|K)?$/.test(normalized)) score -= 60;
  if (/^(播放中|\d{2}:\d{2})$/.test(normalized)) score -= 120;
  if (/^\d{1,2}[:：]\d{2}/.test(normalized)) score -= 100;
  return score;
}

function sanitizeCommentContentCandidate(
  rawText,
  {userName = "", publishTime = "", ipLocation = "", likes = 0} = {},
) {
  return sanitizeCommentContentCandidateDetailed(rawText, {
    userName,
    publishTime,
    ipLocation,
    likes,
  }).text;
}

function sanitizeCommentContentCandidateDetailed(
  rawText,
  {userName = "", publishTime = "", ipLocation = "", likes = 0} = {},
) {
  let text = cleanText(rawText || "");
  if (!text) return {text: "", rejectReason: "empty_text"};

  const normalizedUserName = cleanText(userName);
  const normalizedPublishTime = cleanText(publishTime);
  const normalizedIpLocation = cleanText(ipLocation);
  const normalizedLikes = Number.isFinite(likes) ? String(likes) : "";

  text = stripKnownCommentDecorations(text, {
    userName: normalizedUserName,
    publishTime: normalizedPublishTime,
    ipLocation: normalizedIpLocation,
    likes: normalizedLikes,
  });
  if (!text) return {text: "", rejectReason: "stripped_to_empty"};

  if (normalizedUserName && text === normalizedUserName) {
    return {text: "", rejectReason: "same_as_user_name"};
  }
  if (normalizedPublishTime && text === normalizedPublishTime) {
    return {text: "", rejectReason: "same_as_publish_time"};
  }
  if (normalizedIpLocation && text === normalizedIpLocation) {
    return {text: "", rejectReason: "same_as_ip_location"};
  }
  if (normalizedLikes && text === normalizedLikes) {
    return {text: "", rejectReason: "same_as_likes_value"};
  }

  if (
    /^(相关推荐|大家都在搜|留下你的精彩评论吧|评论区|全部评论(?:[（(]\d+[^）)]*[）)])?|分享|回复|作者回复过|展开\d+条回复|收起|IP属地.*)$/.test(text)
  ) {
    return {text: "", rejectReason: "known_comment_decoration"};
  }
  if (looksLikeCommentActionCluster(text)) {
    return {text: "", rejectReason: "comment_action_cluster"};
  }
  if (/私信可在[\[【]设置/.test(text) || /隐私设置.*在线状态/.test(text)) {
    return {text: "", rejectReason: "private_message_notice"};
  }
  if (/^(播放中|\d{2}:\d{2}|\d{2}\/\d{2})$/.test(text)) {
    return {text: "", rejectReason: "playback_only_text"};
  }
  if (looksLikeStandaloneCommentMeta(text)) {
    return {text: "", rejectReason: "standalone_comment_meta"};
  }
  const parsedMeta = parseCommentMeta(text);
  if (isPureCommentMetaText(text, parsedMeta)) {
    return {text: "", rejectReason: "pure_comment_meta_text"};
  }
  if (/^(刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})$/.test(text)) {
    return {text: "", rejectReason: "time_only_text"};
  }
  if (/^[\d.]+(?:万|亿|w|W|k|K)?(?:\s*分享\s*回复)?$/.test(text)) {
    return {text: "", rejectReason: "numeric_action_only_text"};
  }
  if (/头像$/.test(text)) {
    return {text: "", rejectReason: "avatar_only_text"};
  }
  if (normalizedUserName && text.startsWith(`${normalizedUserName}头像`)) {
    return {text: "", rejectReason: "avatar_prefix_text"};
  }

  return {text, rejectReason: ""};
}

function looksLikeCommentActionCluster(text) {
  const normalized = cleanText(text || "").replace(/\s+/g, "");
  if (!normalized) {
    return false;
  }
  return /^(?:分享|回复|收起|点赞|作者回复过|作者赞过|展开\d+条回复|\d+(?:\.\d+)?(?:万|亿|w|W|k|K)?)+$/.test(
    normalized,
  );
}

function stripKnownCommentDecorations(
  text,
  {userName = "", publishTime = "", ipLocation = "", likes = ""} = {},
) {
  let sanitized = cleanText(text || "");
  if (!sanitized) {
    return "";
  }

  if (userName) {
    const escapedUserName = escapeRegExp(userName);
    sanitized = sanitized.replace(
      new RegExp(`^${escapedUserName}(?:\\s+作者)?\\s*[:：-]?\\s*`),
      "",
    );
  }

  sanitized = sanitized
    .replace(/^作者回复[：:]\s*/, "")
    .replace(/^作者\s+/, "")
    .replace(/\s*(?:作者回复过|作者赞过)\s*/g, " ")
    .trim();

  const tailTokens = [
    publishTime ? escapeRegExp(publishTime) : "",
    ipLocation ? escapeRegExp(ipLocation) : "",
    likes ? escapeRegExp(likes) : "",
    "\\d+(?:\\.\\d+)?(?:万|亿|w|W|k|K)?",
  ].filter(Boolean);
  const tailActions =
    "(?:分享|回复|收起|展开\\d+条回复|作者回复过|作者赞过|点赞)";
  const publishTimePattern = publishTime ? escapeRegExp(publishTime) : "";
  const ipLocationPattern = ipLocation ? escapeRegExp(ipLocation) : "";

  if (publishTimePattern) {
    const metaTailPattern = new RegExp(
      `\\s*${publishTimePattern}` +
        (ipLocationPattern
          ? `(?:\\s*[·•|｜:：-]\\s*${ipLocationPattern}|\\s+${ipLocationPattern})?`
          : "") +
        (likes ? `(?:\\s+${escapeRegExp(likes)})?` : "(?:\\s+\\d+(?:\\.\\d+)?(?:万|亿|w|W|k|K)?)?") +
        `(?:\\s+${tailActions})*$`,
    );
    sanitized = sanitized.replace(metaTailPattern, "").trim();
  }

  if (tailTokens.length) {
    const tailPattern = new RegExp(
      `(?:\\s+[·•|｜]??\\s*(?:${tailTokens.join("|")}))*` +
        `(?:\\s+${tailActions})*$`,
    );
    sanitized = sanitized.replace(tailPattern, "").trim();
  } else {
    sanitized = sanitized
      .replace(new RegExp(`(?:\\s+${tailActions})+$`), "")
      .trim();
  }

  sanitized = sanitized
    .replace(/\s+[·•|｜]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return sanitized;
}

function isPureCommentMetaText(
  text,
  {publishTime = "", ipLocation = ""} = {},
) {
  const normalizedText = cleanText(text);
  const normalizedPublishTime = cleanText(publishTime);
  const normalizedIpLocation = cleanText(ipLocation);
  if (!normalizedText) {
    return false;
  }

  const stripped = normalizedText
    .replace(normalizedPublishTime, "")
    .replace(normalizedIpLocation, "")
    .replace(/[·•|｜:：\s-]+/g, "");

  return Boolean(
    (normalizedPublishTime || normalizedIpLocation) &&
      (!stripped ||
        /^(分享|回复|作者回复过|展开\d+条回复|收起|\d+(?:\.\d+)?(?:万|亿|w|W|k|K)?)$/.test(stripped)),
  );
}

function looksLikeStandaloneCommentMeta(text) {
  const normalizedText = cleanText(text);
  if (!normalizedText) {
    return false;
  }
  if (
    /^(刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前|\d{1,2}月\d{1,2}日|\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?)(?:\s*[·•|｜:：-]\s*[^\s·•|｜\d]{2,20})?$/.test(
      normalizedText,
    )
  ) {
    return true;
  }
  const parsed = parseCommentMeta(normalizedText);
  if (!parsed.publishTime && !parsed.ipLocation) {
    return false;
  }
  const stripped = normalizedText
    .replace(cleanText(parsed.publishTime), "")
    .replace(cleanText(parsed.ipLocation), "")
    .replace(/[·•|｜:：\s-]+/g, "");
  return !stripped;
}

function extractCommentMeta(
  node,
  profile = resolveCommentSceneProfile(),
) {
  const candidates = [];
  const pushCandidate = (text, source = "", element = null) => {
    const parsed = parseCommentMeta(text);
    if (!parsed.publishTime && !parsed.ipLocation) {
      return;
    }
    candidates.push({
      source,
      text: cleanText(text),
      element,
      parsed,
      score: scoreCommentMetaCandidate(parsed, cleanText(text), element, source),
    });
  };

  queryWithinOrSelf(node, profile.metaSelectors).forEach((element) =>
    pushCandidate(element?.textContent || "", "meta_selector", element),
  );

  collectCommentTextCandidates(node).forEach((text) =>
    pushCandidate(text, "text_fallback"),
  );

  const ranked = candidates
    .filter(({score}) => score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.parsed || {publishTime: "", ipLocation: ""};
}

function extractCommentLikes(
  node,
  profile = resolveCommentSceneProfile(),
) {
  const candidates = [];
  const pushCandidate = (text, source = "", element = null) => {
    const likes = parseCommentLikeCount(text);
    if (likes < 0 || likes > MAX_REASONABLE_LIKES) {
      return;
    }
    candidates.push({
      source,
      text: cleanText(text),
      element,
      likes,
      score: scoreCommentLikeCandidate(likes, cleanText(text), element, node, source),
    });
  };

  queryWithinOrSelf(node, profile.likesSelectors).forEach((element) =>
    pushCandidate(element?.textContent || "", "like_selector", element),
  );

  Array.from(node.querySelectorAll("span, div, button"))
    .filter((element) => element instanceof Element && isElementVisible(element))
    .forEach((element) => pushCandidate(element.textContent || "", "numeric_fallback", element));

  const ranked = candidates
    .filter(({score}) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.likes - left.likes;
    });

  return ranked[0]?.likes ?? 0;
}

function looksLikeRecommendationPlaybackNode(node, rawText = "") {
  const text = cleanText(rawText || node?.innerText || node?.textContent || "");
  if (!text) {
    return false;
  }

  const hasDuration = /\b\d{2}:\d{2}\b/.test(text);
  const hasPlayback = /播放中/.test(text);
  const hasHashtagCluster = (text.match(/#/g) || []).length >= 2;
  const hasReplySignals = /回复|展开\d+条回复/.test(text);
  const hasCommentHeading = /全部评论|留下你的精彩评论吧|评论区/.test(text);
  const hasManyMedia = (node?.querySelectorAll?.("img").length || 0) >= 1;

  if ((hasDuration || hasPlayback) && !hasReplySignals && hasManyMedia) {
    return true;
  }
  if ((hasDuration || hasPlayback) && hasHashtagCluster && !hasReplySignals) {
    return true;
  }
  if (hasPlayback && !hasCommentHeading) {
    return true;
  }

  return false;
}

function looksLikeRecommendationContentCardNode(node, rawText = "") {
  const text = cleanText(rawText || node?.innerText || node?.textContent || "");
  if (!text) {
    return false;
  }

  const hasReplySignals = /回复|展开\d+条回复|作者回复过/.test(text);
  if (hasReplySignals) {
    return false;
  }

  const hasHashtagCluster = (text.match(/#/g) || []).length >= 2;
  const hasAuthorHandle = /@\S+/.test(text);
  const hasCardLabel = /^(图文|视频)\d+/.test(text);
  const hasFeedPublishTime =
    /(刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前|\d{1,2}月\d{1,2}日)/.test(text);
  const mediaCount = node?.querySelectorAll?.("img, video").length || 0;
  const hasFeedMedia = mediaCount >= 2;
  const hasTopicStyleTitle =
    /^#.+#/.test(text) ||
    /#.+#.+/.test(text) ||
    /学生党|真实感受|面诊|后续来了|分享篇来了/.test(text);

  if (hasCardLabel && (hasHashtagCluster || hasAuthorHandle || hasFeedPublishTime)) {
    return true;
  }

  if (hasHashtagCluster && hasAuthorHandle && hasFeedPublishTime) {
    return true;
  }

  if (hasFeedMedia && hasTopicStyleTitle && hasFeedPublishTime && hasAuthorHandle) {
    return true;
  }

  return false;
}

function isLikelyNonCommentContentRecord({
  node,
  userName = "",
  userId = "",
  content = "",
  publishTime = "",
  ipLocation = "",
} = {}) {
  const normalizedUserName = cleanText(userName);
  const normalizedContent = cleanText(content);
  if (!normalizedContent) {
    return true;
  }

  if (looksLikeRecommendationContentCardNode(node, `${normalizedUserName} ${normalizedContent}`)) {
    return true;
  }

  const hasHashtagCluster = (normalizedContent.match(/#/g) || []).length >= 2;
  const hasAuthorHandle = /@\S+/.test(normalizedUserName) || /@\S+/.test(normalizedContent);
  const hasMeta = Boolean(cleanText(publishTime) || cleanText(ipLocation));
  const hasCommentConversationSignal = /回复|医生|姐妹|怎么办|怎么做|我也|多久|恢复|肿/.test(
    normalizedContent,
  );

  if (/^(图文|视频)\d+$/.test(normalizedUserName)) {
    return true;
  }

  if (!userId && hasHashtagCluster && hasAuthorHandle && hasMeta && !hasCommentConversationSignal) {
    return true;
  }

  return false;
}

function resolveCommentId(node, content, userId, likes) {
  const candidates = [
    node.getAttribute?.("data-comment-id"),
    node.dataset?.commentId,
    node.dataset?.id,
    node.id,
  ];
  const direct = candidates.find(Boolean);
  if (direct) return String(direct).trim();
  return content ? `${userId || "anonymous"}|${content}` : "";
}

function resolveCommentSemanticKey({
  commentId = "",
  userId = "",
  userName = "",
  content = "",
  publishTime = "",
  ipLocation = "",
  isReply = false,
} = {}) {
  const directId = cleanText(commentId);
  if (directId) {
    return `id:${directId}`;
  }

  const normalizedContent = normalizeCommentSemanticText(content);
  if (!normalizedContent) {
    return "";
  }

  const identity =
    cleanText(userId) ||
    cleanText(userName) ||
    cleanText(ipLocation) ||
    "anonymous";
  const time = cleanText(publishTime) || "";
  return `${isReply ? "reply" : "comment"}|${identity}|${normalizedContent}|${time}`;
}

function normalizeCommentSemanticText(text) {
  return cleanText(text || "")
    .replace(/\s+/g, " ")
    .replace(/[。！!？?，,、；;：:~～]+$/g, "")
    .trim();
}

function scoreExtractedCommentData(comment = null) {
  if (!comment || typeof comment !== "object") {
    return 0;
  }

  let score = 0;
  if (cleanText(comment.userId || "")) score += 18;
  if (cleanText(comment.userName || "")) score += 14;
  if (cleanText(comment.publishTime || "")) score += 12;
  if (cleanText(comment.ipLocation || "")) score += 12;
  if (Number(comment.likes || 0) > 0) score += 10;
  if (cleanText(comment.userUrl || "")) score += 8;
  score += Math.min(normalizeCommentSemanticText(comment.content || "").length, 80);
  if (comment.isReply) score -= 4;
  return score;
}

function resolveReplyCount(node) {
  const text = Array.from(node.querySelectorAll("div, span, button"))
    .map((child) => cleanText(child.textContent || ""))
    .find((value) => /展开\d+条回复/.test(value));
  const match = String(text || "").match(/展开(\d+)条回复/);
  return match?.[1] ? Number(match[1]) : 0;
}

function isReplyNode(node) {
  return Boolean(node.closest('[class*="reply"], [class*="Reply"]'));
}

async function clickLoadMoreComments(container) {
  const buttons = queryAllWithin(container, COMMENT_LOAD_MORE_SELECTORS)
    .concat(queryVisibleElements(COMMENT_LOAD_MORE_SELECTORS))
    .filter((node) => {
      const text = cleanText(node.textContent || "");
      if (/回复|展开回复|收起/.test(text)) return false;
      return /(加载更多|查看更多|更多评论|展开更多|显示更多)/.test(text);
    });

  const deduped = Array.from(new Set(buttons))
    .filter(isElementVisible)
    .slice(0, 6);
  if (!deduped.length) return false;

  for (const target of deduped) {
    safeClick(target);
    await wait(180);
  }
  await wait(420);
  return true;
}

function findCommentScrollTarget(container) {
  if (isScrollableContainer(container)) {
    return container;
  }

  let current = container?.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    if (isScrollableContainer(current)) {
      return current;
    }
    current = current.parentElement;
  }

  return findScrollableTarget(container);
}

async function scrollWithinCommentArea(
  container,
  {scene = COMMENT_SCENE.DETAIL_BOTTOM, stallRounds = 0} = {},
) {
  const target = findCommentScrollTarget(container);
  const strongPush = stallRounds >= 2;
  const baseDistance =
    scene === COMMENT_SCENE.CONTENT_FEED
      ? Math.max((target?.clientHeight || 0) * 1.2, 680)
      : Math.max((target?.clientHeight || 0) * 0.85, 480);
  const distance = strongPush ? Math.max(baseDistance, 1200) : baseDistance;

  if (target && !isWindowScroller(target)) {
    const moved = await attemptScrollOnNode(target, distance, {
      allowWheelFallback: scene === COMMENT_SCENE.CONTENT_FEED,
    });
    if (moved) {
      await wait(260);
      return;
    }
  }

  if (scene === COMMENT_SCENE.CONTENT_FEED) {
    // 内容流场景只允许在当前评论面板内滚动，避免把下一条作品误当成评论继续采集。
    await wait(180);
    return;
  }

  const anchorNode =
    getLastVisibleCommentNode(container) ||
    container.lastElementChild ||
    container;
  const anchorRect = safeRect(anchorNode);
  await scrollNodeIntoActiveViewport(anchorNode, {
    offset: Math.max(anchorRect.height * 0.6, 320),
  });
  await wait(350);
}

async function attemptScrollOnNode(
  node,
  distance,
  {allowWheelFallback = false} = {},
) {
  if (!(node instanceof Element)) {
    return false;
  }

  const beforeTop = Number(node.scrollTop || 0);
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  const delta = Math.max(240, Math.floor(Number(distance) || 0));
  const nextTop = maxTop > 0 ? Math.min(beforeTop + delta, maxTop) : beforeTop + delta;

  node.scrollTop = nextTop;
  try {
    node.dispatchEvent(new Event("scroll", {bubbles: true}));
  } catch {}
  await wait(160);

  const afterTop = Number(node.scrollTop || 0);
  if (Math.abs(afterTop - beforeTop) >= 1) {
    return true;
  }

  if (!allowWheelFallback) {
    return false;
  }

  return await attemptWheelScroll(node, delta);
}

async function dispatchWheelScrollFallback(node, distance) {
  const candidates = [
    node,
    node?.parentElement || null,
    node?.closest?.('[data-e2e="comment-list"]') || null,
    node?.closest?.('[data-e2e="scroll-list"]') || null,
    document.querySelector('[data-e2e="comment-list"]'),
    document.querySelector('[data-e2e="scroll-list"]'),
    document.querySelector("main"),
  ].filter((item) => item instanceof Element);

  const uniqueCandidates = Array.from(new Set(candidates));
  for (const candidate of uniqueCandidates) {
    const moved = await attemptWheelScroll(candidate, distance);
    if (moved) {
      return true;
    }
  }

  return false;
}

async function attemptWheelScroll(node, distance) {
  if (!(node instanceof Element)) {
    return false;
  }

  const beforeTop = Number(node.scrollTop || 0);
  const beforeWindowY = window.scrollY;
  const deltaY = Math.max(320, Math.floor(Number(distance) || 680));

  for (let round = 0; round < 2; round += 1) {
    try {
      node.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {}

    try {
      node.scrollTop = Math.min(
        Number(node.scrollTop || 0) + deltaY,
        Math.max(0, node.scrollHeight - node.clientHeight),
      );
    } catch {}

    await wait(120);
  }

  const afterTop = Number(node.scrollTop || 0);
  if (Math.abs(afterTop - beforeTop) >= 1) {
    return true;
  }

  return Math.abs(window.scrollY - beforeWindowY) >= 1;
}

function isCommentAreaExhausted(
  container,
  scene = COMMENT_SCENE.DETAIL_BOTTOM,
) {
  if (!(container instanceof Element)) {
    return false;
  }

  if (hasLoadMoreSignal(container)) {
    return false;
  }

  if (containsTerminalText(container)) {
    return true;
  }

  const target = findScrollableTarget(container, {
    includePrimaryFallback: false,
  });
  if (target && !isWindowScroller(target)) {
    const remaining =
      target.scrollHeight - target.clientHeight - target.scrollTop;
    return remaining <= (scene === COMMENT_SCENE.CONTENT_FEED ? 8 : 24);
  }

  if (scene === COMMENT_SCENE.CONTENT_FEED) {
    return true;
  }

  const rect = safeRect(container);
  const distanceToViewportBottom = Math.abs(window.innerHeight - rect.bottom);
  return distanceToViewportBottom <= 80 && scene !== COMMENT_SCENE.CONTENT_FEED;
}

function hasLoadMoreSignal(container) {
  return queryAllWithin(container, COMMENT_LOAD_MORE_SELECTORS).some((node) => {
    const text = cleanText(node.textContent || "");
    return /(加载更多|查看更多|更多评论|展开更多)/.test(text);
  });
}

function containsTerminalText(scope) {
  return Boolean(findTerminalTextNode(scope) || findEmptyCommentStateNode(scope));
}

function findTerminalTextNode(scope) {
  const nodes = scope?.querySelectorAll
    ? scope.querySelectorAll("div, span, p")
    : [];
  return (
    Array.from(nodes).find((node) => {
      if (!(node instanceof Element) || !isElementVisible(node)) return false;
      const text = cleanText(node.textContent || "");
      return /(暂时没有更多评论|没有更多评论|暂无更多评论)/.test(text);
    }) || null
  );
}

function hasEmptyCommentState(scope) {
  return Boolean(findEmptyCommentStateNode(scope));
}

function findEmptyCommentStateNode(scope) {
  const nodes = scope?.querySelectorAll
    ? scope.querySelectorAll("div, span, p")
    : [];
  return (
    Array.from(nodes).find((node) => {
      if (!(node instanceof Element) || !isElementVisible(node)) return false;
      const text = cleanText(node.textContent || "");
      return /^(暂无评论|还没有评论|暂时没有评论)$/.test(text);
    }) || null
  );
}

function queryAllWithin(context, selectors) {
  const result = [];
  const seen = new Set();
  selectors.forEach((selector) => {
    try {
      context.querySelectorAll(selector).forEach((node) => {
        if (!seen.has(node)) {
          seen.add(node);
          result.push(node);
        }
      });
    } catch {}
  });
  return result;
}

function queryVisibleElements(selectors, context = document) {
  return queryWithinOrSelf(context, selectors).filter(isElementVisible);
}

function queryWithinOrSelf(context, selectors) {
  const root = context || document;
  const result = queryAllWithin(root, selectors);
  if (!(root instanceof Element)) {
    return result;
  }

  const seen = new Set(result);
  selectors.forEach((selector) => {
    try {
      if (root.matches?.(selector) && !seen.has(root)) {
        seen.add(root);
        result.unshift(root);
      }
    } catch {}
  });
  return result;
}

function queryText(context, selectors) {
  for (const selector of selectors) {
    try {
      const node = context.querySelector(selector);
      const text = cleanText(node?.textContent || "");
      if (text) {
        return text;
      }
    } catch {}
  }
  return "";
}

function scoreCommentUserLinkCandidate(element, commentNode) {
  if (!(element instanceof Element) || !isElementVisible(element)) {
    return 0;
  }

  const text = cleanText(element.textContent || "");
  const rect = safeRect(element);
  const commentRect = safeRect(commentNode);
  const attrs = [
    element.getAttribute?.("href") || "",
    element.getAttribute?.("data-click-from") || "",
    element.getAttribute?.("data-e2e") || "",
    typeof element.className === "string" ? element.className : "",
  ].join(" ");

  let score = scoreCommentUserNameCandidate(text, element, commentNode, "user_link");
  if (/\/user\//i.test(attrs)) score += 24;
  if (/title|nickname|name|comment-user/i.test(attrs)) score += 18;
  if (rect.top <= commentRect.top + Math.max(commentRect.height * 0.55, 42)) score += 8;
  if (rect.left <= commentRect.left + Math.max(commentRect.width * 0.7, 120)) score += 4;
  return score;
}

function scoreCommentUserNameCandidate(
  text,
  element = null,
  commentNode = null,
  source = "",
) {
  const normalized = cleanText(text);
  if (!normalized) {
    return 0;
  }

  if (
    normalized.length > 32 ||
    /^(相关推荐|大家都在搜|全部评论|评论区|分享|回复|收起|作者回复过|作者赞过)$/.test(normalized) ||
    /^(刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前)$/.test(normalized) ||
    /^IP属地/.test(normalized) ||
    /^\d+(?:\.\d+)?(?:万|亿|w|W|k|K)?$/.test(normalized) ||
    /\b\d{2}:\d{2}\b/.test(normalized)
  ) {
    return 0;
  }

  let score = 12;
  if (normalized.length >= 2 && normalized.length <= 20) score += 20;
  if (normalized.length <= 12) score += 8;
  if (!/[，。！？,.!?#@]/.test(normalized)) score += 8;
  if (/^[\u4e00-\u9fa5A-Za-z0-9_.·-]+$/.test(normalized)) score += 12;
  if (/user_link/.test(source)) score += 18;
  if (/selector/.test(source)) score += 6;
  if (/text_fallback/.test(source)) score -= 4;
  if (/回复|分享|作者回复过|作者赞过|展开\d+条回复|留下你的精彩评论吧/.test(normalized)) score -= 60;
  if (/[，。！？,.!?#]/.test(normalized)) score -= 18;
  if (normalized.length >= 20) score -= 12;

  if (element instanceof Element) {
    const attrs = [
      element.getAttribute?.("href") || "",
      element.getAttribute?.("data-click-from") || "",
      element.getAttribute?.("data-e2e") || "",
      typeof element.className === "string" ? element.className : "",
    ].join(" ");
    if (/\/user\//i.test(attrs)) score += 18;
    if (/title|nickname|name|comment-user/i.test(attrs)) score += 18;
    if (/comment-content|CommentContent|comment-time|CommentTime|like/i.test(attrs)) {
      score -= 28;
    }
  }

  if (element instanceof Element && commentNode instanceof Element) {
    const rect = safeRect(element);
    const commentRect = safeRect(commentNode);
    if (rect.top <= commentRect.top + Math.max(commentRect.height * 0.45, 36)) {
      score += 8;
    }
    if (rect.left <= commentRect.left + Math.max(commentRect.width * 0.72, 140)) {
      score += 4;
    }
  }

  return score;
}

function scoreCommentMetaCandidate(
  parsed,
  text = "",
  element = null,
  source = "",
) {
  const normalized = cleanText(text);
  const publishTime = cleanText(parsed?.publishTime || "");
  const ipLocation = cleanText(parsed?.ipLocation || "");
  if (!publishTime && !ipLocation) {
    return 0;
  }

  let score = 8;
  if (publishTime) score += 22;
  if (ipLocation) score += 26;
  if (/IP属地/.test(normalized)) score += 10;
  if (/meta_selector/.test(source)) score += 12;
  if (normalized.length <= 32) score += 8;
  if (/分享|回复|展开\d+条回复/.test(normalized)) score -= 8;
  if (normalized.length > 80) score -= 20;

  if (element instanceof Element) {
    const attrs = [
      element.getAttribute?.("data-e2e") || "",
      typeof element.className === "string" ? element.className : "",
    ].join(" ");
    if (/comment-time|CommentTime|comment-meta|meta|vo4kEeuY|fJhvAqos/i.test(attrs)) {
      score += 18;
    }
  }

  return score;
}

function parseCommentLikeCount(rawText) {
  const normalized = cleanText(rawText);
  if (!normalized) {
    return -1;
  }

  if (/^(分享|回复|作者回复过|作者赞过|展开\d+条回复|收起)$/.test(normalized)) {
    return -1;
  }

  if (!/^\d+(?:\.\d+)?(?:万|亿|w|W|k|K)?$/.test(normalized)) {
    return -1;
  }

  const parsed = parseInteractionCount(normalized);
  return Number.isFinite(parsed) ? parsed : -1;
}

function scoreCommentLikeCandidate(
  likes,
  text = "",
  element = null,
  commentNode = null,
  source = "",
) {
  if (!Number.isFinite(likes) || likes < 0 || likes > MAX_REASONABLE_LIKES) {
    return 0;
  }

  let score = likes === 0 ? 8 : 16;
  if (/like_selector/.test(source)) score += 30;
  if (/numeric_fallback/.test(source)) score += 4;

  if (element instanceof Element) {
    const attrs = [
      element.getAttribute?.("data-e2e") || "",
      typeof element.className === "string" ? element.className : "",
    ].join(" ");
    if (/like|digg|soEq5p_Y|xZhLomAs/i.test(attrs)) score += 28;
    if (/comment-time|CommentTime|comment-meta|meta/i.test(attrs)) score -= 30;
  }

  const normalized = cleanText(text);
  if (normalized && /^\d+(?:\.\d+)?(?:万|亿|w|W|k|K)?$/.test(normalized)) {
    score += 10;
  }

  if (element instanceof Element && commentNode instanceof Element) {
    const rect = safeRect(element);
    const commentRect = safeRect(commentNode);
    if (rect.top >= commentRect.top + Math.max(commentRect.height * 0.25, 20)) {
      score += 8;
    }
    if (rect.left >= commentRect.left + Math.max(commentRect.width * 0.5, 120)) {
      score += 10;
    }
  }

  return score;
}

function parseCommentMeta(rawText) {
  const normalized = cleanText(rawText || "");
  if (!normalized) {
    return {publishTime: "", ipLocation: ""};
  }

  const timeMatch = normalized.match(
    /(刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前|\d{1,2}月\d{1,2}日|\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?)/,
  );
  const publishTime = cleanText(timeMatch?.[1] || "");
  let ipLocation = extractIpLocationFromCommentMeta(normalized, timeMatch);
  if (/^(分享|回复|作者回复过)$/.test(ipLocation)) {
    ipLocation = "";
  }

  if (publishTime || ipLocation) {
    return {publishTime, ipLocation};
  }

  const parts = normalized
    .split("·")
    .map((part) => cleanText(part))
    .filter(Boolean);
  if (
    parts.length >= 2 &&
    /^(刚刚|\d+分钟前|\d+小时前|\d+天前|\d+周前|\d+月前|\d+年前|\d{1,2}月\d{1,2}日|\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?)$/.test(parts[0] || "")
  ) {
    return {
      publishTime: parts[0] || "",
      ipLocation: parts.slice(1).join(" · "),
    };
  }

  return {
    publishTime: "",
    ipLocation: "",
  };
}

function extractIpLocationFromCommentMeta(normalizedText, timeMatch = null) {
  const explicitMatch = normalizedText.match(
    /IP属地[:：]?\s*([^·•|｜\d]+?)(?=(?:\s*[·•|｜])|(?:\s*(?:分享|回复|作者回复过|展开\d+条回复|收起))|(?:\s*\d+(?:\.\d+)?(?:万|亿|w|W|k|K)?)|$)/i,
  );
  if (explicitMatch?.[1]) {
    return cleanText(explicitMatch[1]);
  }

  if (!timeMatch?.[0] && !/[·•|｜]/.test(normalizedText)) {
    return "";
  }

  const fallbackMatch = normalizedText.match(
    /(?:^|[·•|｜])\s*([^\s·•|｜\d]{2,20})\s*$/,
  );
  if (fallbackMatch?.[1]) {
    return cleanText(fallbackMatch[1]);
  }

  if (!timeMatch?.[0]) {
    return "";
  }

  const tail = normalizedText
    .slice((timeMatch.index || 0) + timeMatch[0].length)
    .replace(/^[\s·•|｜:：-]+/, "");
  if (!tail) {
    return "";
  }

  const tailMatch = tail.match(
    /^([^\s·•|｜\d]{2,20}?)(?=(?:\s*[·•|｜])|(?:\s*(?:分享|回复|作者回复过|展开\d+条回复|收起))|(?:\s*\d+(?:\.\d+)?(?:万|亿|w|W|k|K)?)|$)/,
  );
  return cleanText(tailMatch?.[1] || "");
}

function normalizeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `${location.origin}${raw}`;
  return raw;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeClick(node) {
  if (!(node instanceof Element)) return false;

  try {
    node.scrollIntoView?.({block: "center", inline: "center", behavior: "instant"});
  } catch {}

  try {
    dispatchSyntheticClickSequence(node);
    return true;
  } catch {}

  try {
    node.click();
    return true;
  } catch {}

  try {
    const target = resolveClickableNodeAtCenter(node);
    if (target && target !== node) {
      dispatchSyntheticClickSequence(target);
      return true;
    }
  } catch {}

  return false;
}

function clickElementNative(node) {
  if (!(node instanceof Element)) return false;

  try {
    node.scrollIntoView?.({block: "center", inline: "center", behavior: "instant"});
  } catch {}

  try {
    node.click();
    return true;
  } catch {}

  return false;
}

function resolveClickableNodeAtCenter(node) {
  if (!(node instanceof Element)) return null;
  const rect = safeRect(node);
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const hitTarget =
    Number.isFinite(centerX) &&
    Number.isFinite(centerY) &&
    centerX >= 0 &&
    centerY >= 0
      ? document.elementFromPoint(centerX, centerY)
      : null;
  if (!(hitTarget instanceof Element)) {
    return node;
  }

  if (node.contains(hitTarget)) {
    return node;
  }

  const semanticTarget =
    hitTarget.closest?.('[role="button"], button, a, [tabindex], .DG40dqtZ, .fcEX2ARL') ||
    null;
  if (semanticTarget instanceof Element) {
    if (semanticTarget.contains(node)) {
      return node;
    }
    return semanticTarget;
  }

  const genericTarget =
    findGenericActionAncestor(hitTarget, {maxWidth: 420, maxHeight: 420}) ||
    findGenericActionAncestor(node, {maxWidth: 420, maxHeight: 420});
  if (genericTarget) {
    return genericTarget;
  }

  return (
    hitTarget.closest?.("div, span") ||
    hitTarget.closest?.("svg") ||
    node
  );
}

function dispatchSyntheticClickSequence(node) {
  if (!(node instanceof Element)) return false;
  const rect = safeRect(node);
  const clientX = rect.left + Math.max(rect.width / 2, 1);
  const clientY = rect.top + Math.max(rect.height / 2, 1);
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
  };

  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
    const EventCtor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    node.dispatchEvent(new EventCtor(type, eventOptions));
  });
  return true;
}

function safeRect(node) {
  try {
    return node.getBoundingClientRect();
  } catch {
    return {top: 0, bottom: 0, width: 0, height: 0};
  }
}

function getNodeDepth(node) {
  let depth = 0;
  let current = node;
  while (current?.parentElement) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function getNodeArea(node) {
  const rect = safeRect(node);
  return Math.max(rect.width * rect.height, 1);
}

function isElementVisible(node) {
  if (!node) return false;
  const rect = safeRect(node);
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(node);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

function isScrollableContainer(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  const overflowY = style.overflowY || "";
  return (
    /(auto|scroll|overlay)/.test(overflowY) &&
    node.scrollHeight > node.clientHeight + 20
  );
}

function isPotentialScrollableContainer(node) {
  if (!node) return false;
  return (
    node.clientHeight >= 80 &&
    node.scrollHeight > node.clientHeight + 20
  );
}

function findScrollableTarget(
  startNode,
  {includePrimaryFallback = true} = {},
) {
  const descendants = queryAllWithin(startNode || document, ["*"])
    .filter(
      (node) =>
        node !== startNode &&
        (isScrollableContainer(node) || isPotentialScrollableContainer(node)),
    )
    .sort((left, right) => {
      const leftArea = left.clientHeight * left.clientWidth;
      const rightArea = right.clientHeight * right.clientWidth;
      return leftArea - rightArea;
    });
  if (descendants.length) {
    return descendants[0];
  }

  let node = startNode;
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollableContainer(node) || isPotentialScrollableContainer(node)) {
      return node;
    }
    node = node.parentElement;
  }

  return includePrimaryFallback ? findPrimaryScroller() : null;
}

function resolveCommentScopeRoot(
  container,
  {noteId = "", scene = COMMENT_SCENE.DETAIL_BOTTOM} = {},
) {
  const normalizedNoteId = String(noteId || "").trim();
  if (normalizedNoteId) {
    const noteRoot =
      container?.closest?.(`[data-e2e-aweme-id="${normalizedNoteId}"]`) ||
      document.querySelector?.(`[data-e2e-aweme-id="${normalizedNoteId}"]`);
    if (noteRoot instanceof Element) {
      return noteRoot;
    }
  }

  if (scene === COMMENT_SCENE.CONTENT_FEED) {
    return (
      container?.closest?.(".swiper-slide-active") ||
      container?.closest?.('[role="dialog"]') ||
      container?.closest?.('[class*="modal"]') ||
      container?.closest?.("main") ||
      container?.parentElement ||
      container
    );
  }

  return (
    container?.closest?.('[data-e2e="detail-container"]') ||
    container?.closest?.("main") ||
    container?.parentElement ||
    container
  );
}

function getLastVisibleCommentNode(container) {
  const nodes = queryAllWithin(container, COMMENT_ITEM_SELECTORS).filter(
    isElementVisible,
  );
  return nodes[nodes.length - 1] || null;
}

async function scrollNodeIntoActiveViewport(node, {offset = 0} = {}) {
  if (!node) return;

  const scroller = findNearestScrollableAncestor(node) || findPrimaryScroller();
  if (!scroller || isWindowScroller(scroller)) {
    const rect = safeRect(node);
    const targetY =
      window.scrollY + rect.top - window.innerHeight / 2 + Number(offset || 0);
    await smoothScrollTo(Math.max(0, targetY), 450);
    return;
  }

  const scrollerRect = safeRect(scroller);
  const nodeRect = safeRect(node);
  const delta =
    nodeRect.top -
    scrollerRect.top -
    scroller.clientHeight / 2 +
    nodeRect.height / 2 +
    Number(offset || 0);
  scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
}

async function advancePrimaryScroller(distance) {
  const scroller = findPrimaryScroller();
  if (!scroller || isWindowScroller(scroller)) {
    await smoothScrollTo(window.scrollY + distance, 450);
    return;
  }

  scroller.scrollTop = Math.min(
    scroller.scrollTop + distance,
    Math.max(0, scroller.scrollHeight - scroller.clientHeight),
  );
}

function findPrimaryScroller() {
  const candidates = [
    document.querySelector('[data-e2e="scroll-list"]'),
    document.querySelector(".scroll-list"),
    document.querySelector("main"),
    document.scrollingElement,
    document.documentElement,
    document.body,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (
      candidate === document.scrollingElement ||
      candidate === document.documentElement ||
      candidate === document.body
    ) {
      return candidate;
    }
    if (isScrollableContainer(candidate) || isPotentialScrollableContainer(candidate)) {
      return candidate;
    }
  }

  return document.scrollingElement || document.documentElement || document.body;
}

function findNearestScrollableAncestor(node) {
  let current = node?.parentElement || null;
  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    if (isScrollableContainer(current) || isPotentialScrollableContainer(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isWindowScroller(node) {
  return (
    node === window ||
    node === document ||
    node === document.body ||
    node === document.documentElement ||
    node === document.scrollingElement
  );
}
