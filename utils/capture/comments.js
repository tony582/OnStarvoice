/**
 * onstarvoice V2.0 Comments Capture Module
 * 采集笔记评论数据（仅采集当前自动加载可见评论，不主动展开折叠回复）
 */

import {
  COMMENTS_SELECTORS,
  NOTE_DETAIL_SELECTORS,
  querySelector,
  querySelectorAll,
  waitForElement,
} from "../selectors.js";
import {
  parseInteractionCount,
  cleanText,
  extractUserId,
  randomScrollDistance,
} from "../helpers.js";
import {PAGE_TYPE, SYNC_TYPE, DEFAULT_CONFIG} from "../constants.js";
import {
  autoScrollLoad,
  isCanceled,
  resetCancelFlag,
  wait,
  scrollElementIntoView,
} from "../scroll.js";
import {buildCommentLoadStage} from "./stage-diagnostics.js";

const DEFAULT_MAX_ITEMS = 100;
const COMMENT_CONTENT_MAX_LENGTH = 280;
const MIN_COMMENTS_STALL_TIMEOUT_MS = 10000;
const REQUIRED_STALL_ROUNDS = 4;
const FORCE_STOP_STALL_ROUNDS = 10;

/**
 * 采集笔记评论
 * @param {Object} options
 * @param {Function} options.onProgress - 进度回调
 * @param {number} options.maxDetectedItems - 评论加载上限
 * @param {number} options.maxDurationMs - 最大采集时长
 * @param {number} options.noNewContentThreshold - 轮次无新增阈值（兼容保留）
 * @param {number} options.waitMinMs - 每轮随机等待最小毫秒
 * @param {number} options.waitMaxMs - 每轮随机等待最大毫秒
 * @param {number} options.stallTimeoutMs - 连续无新增超时毫秒
 * @param {number} options.maxScrollTimes - 最大滚动次数
 */
export async function captureComments({
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
  // 兼容旧调用参数；评论区懒加载由更长的停滞判断控制。
  void noNewContentThreshold;

  const normalizedMaxDetectedItems = normalizePositiveInteger(
    maxDetectedItems ?? maxItems,
    DEFAULT_MAX_ITEMS,
  );
  const normalizedMaxDurationMs = normalizePositiveInteger(
    maxDurationMs,
    DEFAULT_CONFIG.MAX_CAPTURE_DURATION_MS,
  );
  const normalizedWaitMinMs = normalizePositiveInteger(
    waitMinMs,
    DEFAULT_CONFIG.SCROLL_DELAY_MIN,
  );
  const normalizedWaitMaxMs = normalizePositiveInteger(
    waitMaxMs,
    DEFAULT_CONFIG.SCROLL_DELAY_MAX,
  );
  const waitRange =
    normalizedWaitMinMs <= normalizedWaitMaxMs
      ? {min: normalizedWaitMinMs, max: normalizedWaitMaxMs}
      : {min: normalizedWaitMaxMs, max: normalizedWaitMinMs};
  const normalizedStallTimeoutMs = Math.max(
    normalizePositiveInteger(stallTimeoutMs, 3000),
    MIN_COMMENTS_STALL_TIMEOUT_MS,
  );
  const normalizedMaxScrollTimes = normalizePositiveInteger(
    maxScrollTimes,
    DEFAULT_CONFIG.MAX_SCROLL_TIMES,
  );

  try {
    const noteId = extractNoteIdFromUrl();
    if (!noteId) {
      throw new Error("无法从 URL 提取笔记 ID");
    }

    await waitForElement(COMMENTS_SELECTORS.container, 8000);
    const commentContainer = querySelector(COMMENTS_SELECTORS.container);
    if (!commentContainer) {
      throw new Error("无法找到评论区容器");
    }

    await scrollElementIntoView(commentContainer);
    await wait(400);

    const commentsMap = new Map();
    let lastGrowthAt = Date.now();
    let lastObservedCount = 0;
    let stallRounds = 0;

    const scrollResult = await autoScrollLoad({
      onProgress: (progress) => {
        if (onProgress) {
          onProgress({
            ...progress,
            phase: "comments_collecting",
            collectedCount: commentsMap.size,
            message: `评论采集中（${commentsMap.size}条）`,
          });
        }
      },
      detectNewContent: () => {
        collectVisibleComments(
          commentContainer,
          commentsMap,
          normalizedMaxDetectedItems,
        );
        return commentsMap.size;
      },
      maxScrollTimes: normalizedMaxScrollTimes,
      noNewContentThreshold: 0,
      maxDurationMs: normalizedMaxDurationMs,
      waitMinMs: waitRange.min,
      waitMaxMs: waitRange.max,
      stopWhen: ({currentContentCount}) => {
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

        if (
          currentContentCount < normalizedMaxDetectedItems &&
          Date.now() - lastGrowthAt >= normalizedStallTimeoutMs &&
          stallRounds >= REQUIRED_STALL_ROUNDS &&
          (isCommentAreaExhausted(commentContainer) ||
            stallRounds >= FORCE_STOP_STALL_ROUNDS)
        ) {
          return {
            stop: true,
            reason: "stall_timeout",
            message: isCommentAreaExhausted(commentContainer)
              ? `评论区已接近底部，连续 ${Math.floor(normalizedStallTimeoutMs / 1000)} 秒无新增，按当前最大值结束`
              : `连续多轮未触发新增评论，按当前最大值结束`,
          };
        }
        return {stop: false};
      },
      scrollStep: async (ctx = {}) => {
        const aggressive =
          Number(ctx.currentContentCount || 0) < normalizedMaxDetectedItems;
        await scrollWithinCommentArea(commentContainer, {
          aggressive,
          stallRounds,
        });
        await clickLoadMoreComments(commentContainer);
      },
    });

    collectVisibleComments(
      commentContainer,
      commentsMap,
      normalizedMaxDetectedItems,
    );

    const stoppedByUser = isCanceled();
    const captureStatus = stoppedByUser ? "partial" : "done";
    const items = Array.from(commentsMap.values()).slice(
      0,
      normalizedMaxDetectedItems,
    );
    const stageTrace = [
      buildCommentLoadStage({
        label: "小红书评论加载",
        status: stoppedByUser ? "partial" : "completed",
        commentsMaxDetectedItems: normalizedMaxDetectedItems,
        collectedCount: items.length,
        uniqueCount: commentsMap.size,
        commentContainerFound: Boolean(commentContainer),
        scrollResult,
        maxScrollTimes: normalizedMaxScrollTimes,
        waitMinMs: waitRange.min,
        waitMaxMs: waitRange.max,
        stallTimeoutMs: normalizedStallTimeoutMs,
        maxDurationMs: normalizedMaxDurationMs,
      }),
    ];

    const noteTitleElement = querySelector(NOTE_DETAIL_SELECTORS.title);
    const noteTitle = noteTitleElement
      ? cleanText(noteTitleElement.textContent)
      : "";

    return {
      ok: true,
      type: SYNC_TYPE.COMMENTS,
      data: {
        noteId,
        noteUrl: window.location.href,
        noteTitle,
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
    console.error("[Capture] Comments capture failed:", error);
    return {
      ok: false,
      type: SYNC_TYPE.COMMENTS,
      data: null,
      meta: {
        pageType: PAGE_TYPE.NOTE_DETAIL,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
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

function extractNoteIdFromUrl() {
  const url = window.location.href;
  const match = url.match(
    /\/(?:explore|discovery\/item|note|search_result)\/([a-zA-Z0-9_-]+)|\/user\/profile\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)/i,
  );
  if (match?.[1]) {
    return match[1];
  }
  if (match?.[2]) {
    return match[2];
  }
  return null;
}

function collectVisibleComments(container, commentsMap, maxDetectedItems) {
  if (commentsMap.size >= maxDetectedItems) return;

  const candidates = querySelectorAll(
    COMMENTS_SELECTORS.commentItem.container,
    container,
  );
  for (const node of candidates) {
    const comment = extractComment(node);
    if (!comment) continue;
    if (commentsMap.has(comment.key)) continue;
    commentsMap.set(comment.key, comment.data);
    if (commentsMap.size >= maxDetectedItems) {
      return;
    }
  }
}

function extractComment(node) {
  const content = extractCommentContent(node);
  if (!content) return null;

  const userLinkElement = querySelector(
    COMMENTS_SELECTORS.commentItem.userLink,
    node,
  );
  const userUrl = userLinkElement
    ? String(userLinkElement.href || "").trim()
    : "";
  const userName = extractCommentUserName(node, userLinkElement);
  const userId = extractCommentUserId(node, userLinkElement, userUrl);
  const ipLocation = extractCommentIpLocation(node);

  const likes = extractCommentLikes(node);

  const commentId = extractCommentId(node, content, userId, likes);
  const key = commentId || `${userId || "anonymous"}|${content}|${likes}`;

  return {
    key,
    data: {
      commentId,
      content,
      userName,
      userId,
      userUrl,
      ipLocation,
      likes,
    },
  };
}

function extractCommentUserName(node, userLinkElement) {
  const userNameElement = querySelector(
    COMMENTS_SELECTORS.commentItem.userName,
    node,
  );
  const directName = normalizeCommentUserName(
    userNameElement?.textContent || "",
  );
  if (directName) {
    return directName;
  }

  const linkName = normalizeCommentUserName(userLinkElement?.textContent || "");
  if (linkName) {
    return linkName;
  }

  const linkCandidateAttrs = [
    userLinkElement?.dataset?.userName,
    userLinkElement?.getAttribute?.("data-user-name"),
    userLinkElement?.getAttribute?.("aria-label"),
    userLinkElement?.getAttribute?.("title"),
  ];
  for (const candidate of linkCandidateAttrs) {
    const normalized = normalizeCommentUserName(candidate || "");
    if (normalized) {
      return normalized;
    }
  }

  const fallbackCandidates = [
    node?.querySelector?.("[data-user-name]"),
    node?.querySelector?.('[class*="user"] [class*="name"]'),
    node?.querySelector?.('[class*="author"] [class*="name"]'),
    node?.querySelector?.("img[alt]"),
  ].filter(Boolean);
  for (const element of fallbackCandidates) {
    const normalized = normalizeCommentUserName(
      element?.getAttribute?.("data-user-name") ||
        element?.getAttribute?.("aria-label") ||
        element?.getAttribute?.("title") ||
        element?.getAttribute?.("alt") ||
        element?.textContent ||
        "",
    );
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function extractCommentUserId(node, userLinkElement, userUrl) {
  const candidateElements = [
    userLinkElement,
    node,
    node?.querySelector?.("[data-user-id]"),
    node?.querySelector?.("#user-hover-guide"),
  ].filter(Boolean);

  for (const element of candidateElements) {
    const byDataset = String(element?.dataset?.userId || "").trim();
    if (byDataset) return byDataset;
    const byAttr = String(element?.getAttribute?.("data-user-id") || "").trim();
    if (byAttr) return byAttr;
  }

  return userUrl ? extractUserId(userUrl) : "";
}

function normalizeCommentUserName(value) {
  const text = cleanText(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length > 30) return "";
  if (/^(?:ip|IP)(?:属地)?[:：]/.test(text)) return "";
  if (/(?:个赞|回复|查看|展开|收起)/.test(text)) return "";
  return text;
}

function extractCommentIpLocation(node) {
  const strictSelectors = [
    ".comment-ip",
    ".ip-location",
    ".ip",
    "[data-ip-location]",
    "[data-ip]",
    "[data-location]",
  ];
  const looseSelectors = ['[class*="ip"]', '[class*="location"]'];
  const candidateNodes = [
    ...querySelectorAll(strictSelectors, node),
    ...querySelectorAll(looseSelectors, node),
  ];

  for (const element of candidateNodes) {
    const candidateText = cleanText(
      element?.getAttribute?.("data-ip-location") ||
        element?.getAttribute?.("data-ip") ||
        element?.getAttribute?.("data-location") ||
        element?.dataset?.ipLocation ||
        element?.dataset?.ip ||
        element?.dataset?.location ||
        element?.textContent ||
        "",
    );
    const normalized = normalizeIpLocation(candidateText, {allowLoose: true});
    if (normalized) {
      return normalized;
    }
  }

  const ipElement = querySelector(
    COMMENTS_SELECTORS.commentItem.ipLocation,
    node,
  );
  const fromIpElement = normalizeIpLocation(
    cleanText(ipElement?.textContent || ""),
    {allowLoose: true},
  );
  if (fromIpElement) {
    return fromIpElement;
  }

  const fallbackText = cleanText(node?.textContent || "");
  return normalizeIpLocation(fallbackText, {allowLoose: false});
}

function normalizeIpLocation(value, {allowLoose = false} = {}) {
  const text = cleanText(value || "");
  if (!text) return "";
  const match = text.match(
    /(?:IP(?:属地)?|ip(?:属地)?)[:：]?\s*([^\n|｜，,。;；（）()]+)/i,
  );
  if (match?.[1]) {
    const strict = normalizeLooseIpLocation(match[1]);
    if (strict) {
      return strict;
    }
  }
  if (!allowLoose) return "";
  return normalizeLooseIpLocation(text);
}

function normalizeLooseIpLocation(value) {
  const cleaned = cleanText(value || "")
    .replace(/^(?:IP(?:属地)?|ip(?:属地)?)[:：]?\s*/i, "")
    .replace(/^[·•|｜\s]+/, "")
    .trim();
  if (!cleaned) return "";

  const firstSegment = cleanText(
    cleaned.split(/[|｜，,。;；（）()]/)[0] || "",
  ).trim();
  if (!firstSegment) return "";
  if (firstSegment.length < 2 || firstSegment.length > 20) return "";
  if (/https?:\/\//i.test(firstSegment)) return "";
  if (/^\d+$/.test(firstSegment)) return "";
  if (
    /(?:个赞|点赞|回复|查看|展开|收起|作者|置顶|编辑|刚刚|分钟前|小时前|天前|月前|年前)/.test(
      firstSegment,
    )
  ) {
    return "";
  }

  return firstSegment;
}

function extractCommentContent(node) {
  const contentElement = querySelector(
    COMMENTS_SELECTORS.commentItem.content,
    node,
  );
  const content = contentElement ? cleanText(contentElement.textContent) : "";
  if (!content) return "";
  if (content.length <= COMMENT_CONTENT_MAX_LENGTH) {
    return content;
  }
  return `${content.slice(0, COMMENT_CONTENT_MAX_LENGTH)}...`;
}

function extractCommentId(node, content, userId, likes) {
  const candidates = [
    node?.dataset?.commentId,
    node?.dataset?.id,
    node?.getAttribute?.("data-comment-id"),
    node?.getAttribute?.("data-id"),
    node?.id,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) {
      return normalized;
    }
  }

  return `${userId || "anonymous"}_${likes}_${content.slice(0, 24)}`;
}

function extractCommentLikes(node) {
  const likesElement = querySelector(
    COMMENTS_SELECTORS.commentItem.likes,
    node,
  );
  const directText = cleanText(likesElement?.textContent || "");
  const directLikes = parseMaybeCount(directText);
  if (directLikes > 0) {
    return directLikes;
  }

  const likeIcon = node.querySelector('.like-icon, [class*="like-icon"]');
  if (likeIcon) {
    const iconParent =
      likeIcon.closest(
        'button, .like-wrapper, [class*="like-wrapper"], [class*="like"]',
      ) ||
      likeIcon.parentElement ||
      node;
    const candidates = [
      ...Array.from(
        iconParent.querySelectorAll('.count, [class*="count"], [data-count]'),
      ),
      iconParent,
    ];
    for (const candidate of candidates) {
      const text = cleanText(candidate?.textContent || "");
      const count = parseMaybeCount(text);
      if (count > 0) {
        return count;
      }
    }

    const contextual = parseLikeCountFromContext(iconParent?.textContent || "");
    if (contextual > 0) {
      return contextual;
    }
  }

  return 0;
}

function parseMaybeCount(text) {
  if (!text) return 0;
  const normalized = String(text).trim();
  if (!normalized) return 0;

  if (/^\d+(?:\.\d+)?[万kK]?$/.test(normalized)) {
    return parseInteractionCount(normalized);
  }

  const match = normalized.match(/(\d+(?:\.\d+)?(?:万|[kK])?)/);
  if (!match) {
    return 0;
  }
  return parseInteractionCount(match[1]);
}

function parseLikeCountFromContext(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return 0;

  const patterns = [
    /(?:点赞|赞|like)\s*[:：]?\s*(\d+(?:\.\d+)?(?:万|[kK])?)/i,
    /(\d+(?:\.\d+)?(?:万|[kK])?)\s*(?:点赞|赞|like)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const count = parseInteractionCount(match[1]);
    if (count > 0) {
      return count;
    }
  }

  return 0;
}

async function clickLoadMoreComments(container) {
  const buttonsInContainer = querySelectorAll(
    COMMENTS_SELECTORS.loadMore,
    container,
  );
  const buttonsOnPage = querySelectorAll(COMMENTS_SELECTORS.loadMore, document);
  const textCandidates = findLoadMoreButtonsByText(container);
  const allButtons = [
    ...buttonsInContainer,
    ...buttonsOnPage,
    ...textCandidates,
  ];
  const dedupButtons = Array.from(new Set(allButtons)).slice(0, 8);
  for (const button of dedupButtons) {
    const text = cleanText(button?.textContent || "");
    if (!text) continue;
    // 不主动展开回复层级，只触发评论列表继续加载
    if (/回复|展开回复|收起/.test(text)) {
      continue;
    }
    if (typeof button.click === "function") {
      button.click();
      await wait(150);
    }
  }
}

function findLoadMoreButtonsByText(container) {
  const scope = findCommentScopeRoot(container) || container || document;
  const nodes = Array.from(scope.querySelectorAll("button, span, div, a"));
  return nodes.filter((node) => {
    const text = cleanText(node?.textContent || "");
    if (!text || text.length > 30) return false;
    if (/回复|展开回复|收起/.test(text)) return false;
    return /(加载更多|查看更多|更多评论|展开更多|显示更多)/.test(text);
  });
}

async function scrollWithinCommentArea(
  container,
  {aggressive = false, stallRounds = 0} = {},
) {
  const target = findScrollableTarget(container);
  const strongPush = stallRounds >= 2;
  const minDistance = aggressive ? 500 : 300;
  const maxDistance = strongPush ? 1800 : aggressive ? 1100 : 800;
  const distance = randomScrollDistance(minDistance, maxDistance);

  dispatchWheelHint(container, distance);
  dispatchWheelHint(target, distance);

  if (target === window) {
    window.scrollBy({
      top: distance,
      behavior: "smooth",
    });
    return;
  }

  target.scrollTo({
    top: target.scrollTop + distance,
    behavior: "smooth",
  });
}

function findScrollableTarget(startNode) {
  const descendant = findScrollableDescendant(startNode);
  if (descendant) {
    return descendant;
  }

  let node = startNode;
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollableElement(node)) {
      return node;
    }
    node = node.parentElement;
  }
  return window;
}

function isCommentAreaExhausted(container) {
  const target = findScrollableTarget(container);
  if (target === window && !isWindowScrollable()) {
    return false;
  }
  if (target !== window && !isScrollableElement(target)) {
    return false;
  }
  const remaining = getRemainingScrollableDistance(target);
  const hasMoreButton = hasLoadMoreHint(container);
  // 既接近底部且没有“加载更多”提示，才认为评论区已探底。
  return remaining <= 160 && !hasMoreButton;
}

function getRemainingScrollableDistance(target) {
  if (target === window) {
    const doc = document.documentElement;
    return Math.max(
      0,
      doc.scrollHeight - (window.scrollY + window.innerHeight),
    );
  }
  return Math.max(
    0,
    target.scrollHeight - (target.scrollTop + target.clientHeight),
  );
}

function hasLoadMoreHint(container) {
  const textButtons = findLoadMoreButtonsByText(container);
  if (textButtons.length > 0) {
    return true;
  }
  const scope = findCommentScopeRoot(container) || container || document;
  const text = cleanText(scope?.textContent || "");
  if (!text) return false;
  return /(加载更多|查看更多|更多评论|展开更多)/.test(text);
}

function findCommentScopeRoot(container) {
  if (!container) return null;
  return (
    container.closest(".note-scroller, #noteContainer, .note-container") ||
    container.parentElement ||
    container
  );
}

function findScrollableDescendant(root) {
  if (!root?.querySelectorAll) return null;
  const candidates = Array.from(root.querySelectorAll("*"))
    .filter(isScrollableElement)
    .sort((a, b) => getScrollableArea(b) - getScrollableArea(a));
  return candidates[0] || null;
}

function isScrollableElement(node) {
  if (!node || typeof node !== "object" || node === window) return false;
  const style = window.getComputedStyle(node);
  const overflowY = style?.overflowY || "";
  return (
    (overflowY.includes("auto") || overflowY.includes("scroll")) &&
    node.scrollHeight > node.clientHeight + 24
  );
}

function isWindowScrollable() {
  const doc = document.documentElement;
  return doc.scrollHeight > window.innerHeight + 24;
}

function getScrollableArea(node) {
  if (!node || node === window) return 0;
  return Math.max(0, (node.scrollHeight || 0) - (node.clientHeight || 0));
}

function dispatchWheelHint(target, distance) {
  const eventTarget =
    target === window
      ? document.scrollingElement || document.documentElement
      : target;
  if (!eventTarget?.dispatchEvent) return;

  eventTarget.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: distance,
      view: window,
    }),
  );
}
