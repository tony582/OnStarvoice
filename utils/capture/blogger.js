/**
 * onstarvoice V2.0 Blogger Capture Module
 * 采集博主信息和笔记列表
 */

import {
  BLOGGER_PROFILE_SELECTORS,
  querySelector,
  querySelectorAll,
} from "../selectors.js";
import {
  parseInteractionCount,
  cleanText,
  extractNoteId,
  randomScrollDistance,
} from "../helpers.js";
import {PAGE_TYPE, SYNC_TYPE, DEFAULT_CONFIG} from "../constants.js";
import {autoScrollLoad, isCanceled, resetCancelFlag, wait} from "../scroll.js";
import {
  buildFilterApplyStage,
  buildListParseStage,
  buildScrollLoadStage,
  countMissingMetric,
} from "./stage-diagnostics.js";

const BLOGGER_CONTENT_TABS = Object.freeze({
  note: Object.freeze({key: "note", label: "笔记", index: 0}),
  fav: Object.freeze({key: "fav", label: "收藏", index: 1}),
  liked: Object.freeze({key: "liked", label: "点赞", index: 2}),
});

const BLOGGER_TAB_PANEL_SELECTORS = Object.freeze([
  ".transform-container > .tab-content-item",
  ".feeds-tab-container > .tab-content-item",
  ".feeds-tab-container .tab-content-item",
  ".tab-content-item",
]);

const MIN_BLOGGER_STALL_TIMEOUT_MS = 12000;
const REQUIRED_BLOGGER_STALL_ROUNDS = 5;

/**
 * 采集博主信息
 * @returns {Promise<Object>} 采集结果
 */
export async function captureBloggerProfile() {
  const captureStartedAt = new Date().toISOString();

  try {
    // 提取博主 ID
    const bloggerIdFromUrl = extractBloggerIdFromUrl();
    if (!bloggerIdFromUrl) {
      throw new Error("无法从 URL 提取博主 ID");
    }

    // 等待页面加载完成
    await wait(1000);

    // 提取头像
    const avatarElement = querySelector(BLOGGER_PROFILE_SELECTORS.avatar);
    const avatar = avatarElement ? avatarElement.src : "";

    // 提取博主名称
    const nameElement = querySelector(BLOGGER_PROFILE_SELECTORS.name);
    const name = nameElement ? cleanText(nameElement.textContent) : "";

    // 提取简介
    const bioElement = querySelector(BLOGGER_PROFILE_SELECTORS.bio);
    const bio = bioElement ? cleanText(bioElement.textContent) : "";

    // 提取小红书号
    const userIdElement = querySelector(BLOGGER_PROFILE_SELECTORS.userId);
    const userId = userIdElement ? cleanText(userIdElement.textContent) : "";
    const normalizedUserId =
      normalizeBloggerUserId(userId) ||
      extractBloggerUserIdFromText(cleanText(document.body?.innerText || ""));
    const ipLocation = extractIpLocation(userId);

    const metrics = await extractBloggerMetricsFromCurrentPageWithRetry();

    // 构建 payload
    const payload = {
      bloggerName: name,
      bloggerId: normalizedUserId || bloggerIdFromUrl,
      bloggerUrl: window.location.href,
      avatarUrl: avatar,
      description: bio,
      followingCount: metrics.followingCount,
      followersCount: metrics.followersCount,
      likedAndCollectedCount: metrics.likedAndCollectedCount,
      bloggerFollowersCount: metrics.followersCount,
      bloggerLikedAndCollectedCount: metrics.likedAndCollectedCount,
      bloggerProfileUrl: window.location.href,
      bloggerMetricsCaptureStatus: metrics.ok ? "done" : "failed",
      bloggerMetricsCaptureError: metrics.ok ? "" : metrics.error,
      bloggerAccountType: metrics.accountType,
      ipLocation,
      captureTimestamp: Date.now(),
    };

    return {
      ok: true,
      type: SYNC_TYPE.BLOGGER_PROFILE,
      data: payload,
      meta: {
        pageType: PAGE_TYPE.BLOGGER_PROFILE,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
      },
      error: null,
    };
  } catch (error) {
    console.error("[Capture] Blogger profile capture failed:", error);

    return {
      ok: false,
      type: SYNC_TYPE.BLOGGER_PROFILE,
      data: null,
      meta: {
        pageType: PAGE_TYPE.BLOGGER_PROFILE,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
      },
      error: {
        code: "CAPTURE_FAILED",
        message: error.message,
      },
    };
  }
}

/**
 * 采集博主笔记列表（带自动滚动）
 * @param {Object} options - 配置选项
 * @param {Function} options.onProgress - 进度回调
 * @param {number} options.maxScrollTimes - 最大滚动次数
 * @returns {Promise<Object>} 采集结果
 */
export async function captureBloggerNotes({
  onProgress = null,
  profileMetrics = null,
  maxScrollTimes = null,
  minLikes = 0,
  maxDetectedItems = null,
  maxItems = null,
  keywordFilter = "",
  deferKeywordFilter = false,
  waitMinMs = DEFAULT_CONFIG.SCROLL_DELAY_MIN,
  waitMaxMs = DEFAULT_CONFIG.SCROLL_DELAY_MAX,
  stallTimeoutMs = 3000,
  maxDurationMs = DEFAULT_CONFIG.MAX_CAPTURE_DURATION_MS,
} = {}) {
  const captureStartedAt = new Date().toISOString();
  resetCancelFlag();

  try {
    // 提取博主 ID
    const bloggerId = extractBloggerIdFromUrl();
    if (!bloggerId) {
      throw new Error("无法从 URL 提取博主 ID");
    }

    // 等待笔记列表加载
    await wait(1000);

    const activeTab = await resolveCurrentBloggerContentTab();

    const bloggerNameElement = querySelector(BLOGGER_PROFILE_SELECTORS.name);
    const bloggerName = bloggerNameElement
      ? cleanText(bloggerNameElement.textContent)
      : "";
    const pageMetrics = await extractBloggerMetricsFromCurrentPageWithRetry();
    const fallbackMetrics = normalizeBloggerMetricsInput(profileMetrics);
    const resolvedMetrics = resolveBloggerMetricsWithFallback(
      pageMetrics,
      fallbackMetrics,
      window.location.href,
    );

    const normalizedMinLikes = normalizeNonNegativeInteger(minLikes, 0);
    const normalizedMaxDetectedItems = normalizePositiveInteger(
      maxDetectedItems ?? maxItems,
      100,
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
    const normalizedMaxDurationMs = normalizePositiveInteger(
      maxDurationMs,
      DEFAULT_CONFIG.MAX_CAPTURE_DURATION_MS,
    );
    const normalizedStallTimeoutMs = Math.max(
      normalizePositiveInteger(stallTimeoutMs, 3000),
      MIN_BLOGGER_STALL_TIMEOUT_MS,
    );
    const normalizedMaxScrollTimes = normalizePositiveInteger(
      maxScrollTimes,
      Math.max(
        DEFAULT_CONFIG.MAX_SCROLL_TIMES,
        Math.ceil(normalizedMaxDetectedItems / 2),
      ),
    );
    const parsedKeywords = parseKeywordFilter(keywordFilter);
    const shouldFilterByListTitle = parsedKeywords.length && !deferKeywordFilter;
    const noteMap = new Map();
    const emittedCheckpointKeys = new Set();
    let progressStats = {
      detectedCount: 0,
      qualifiedCount: 0,
      filteredCount: 0,
    };
    let lastGrowthAt = Date.now();
    let lastObservedCount = 0;
    let stallRounds = 0;

    const emitProgress = (progress = {}) => {
      if (!onProgress) return;
      onProgress({
        ...progress,
        detectedCount: progressStats.detectedCount,
        qualifiedCount: progressStats.qualifiedCount,
        filteredCount: progressStats.filteredCount,
        minLikes: normalizedMinLikes,
        maxDetectedItems: normalizedMaxDetectedItems,
        sourceTab: activeTab.key,
        sourceTabLabel: activeTab.label,
      });
    };

    const buildFilteredItems = () => {
      const allItems = Array.from(noteMap.values());
      const likesFiltered = allItems.filter(
        (item) => item.likes >= normalizedMinLikes,
      );
      const filteredItems = shouldFilterByListTitle
        ? likesFiltered.filter((item) =>
            matchesKeywordFilter(item.title || "", parsedKeywords),
          )
        : likesFiltered;
      return filteredItems
        .slice(0, normalizedMaxDetectedItems)
        .map((item) => ({
          ...item,
          bloggerFollowersCount: resolvedMetrics.followersCount,
          bloggerLikedAndCollectedCount: resolvedMetrics.likedAndCollectedCount,
          bloggerProfileUrl: resolvedMetrics.profileUrl || window.location.href,
          bloggerMetricsCaptureStatus: resolvedMetrics.captureStatus,
          bloggerMetricsCaptureError: resolvedMetrics.captureError,
          bloggerAccountType: resolvedMetrics.accountType,
        }));
    };

    const emitListCheckpoint = () => {
      if (!onProgress) return;
      const checkpointItems = buildFilteredItems().filter((item) => {
        const key = String(item.noteId || item.url || "").trim();
        if (!key || emittedCheckpointKeys.has(key)) return false;
        emittedCheckpointKeys.add(key);
        return true;
      });
      if (checkpointItems.length === 0) return;

      emitProgress({
        phase: "list_checkpoint",
        message: `正在加载博主作品`,
        listCheckpoint: {
          type: SYNC_TYPE.BLOGGER_NOTES,
          platform: "xiaohongshu",
          items: checkpointItems,
          payload: {
            bloggerName,
            bloggerId,
            bloggerUrl: window.location.href,
            bloggerFollowersCount: resolvedMetrics.followersCount,
            bloggerLikedAndCollectedCount: resolvedMetrics.likedAndCollectedCount,
            bloggerProfileUrl: resolvedMetrics.profileUrl || window.location.href,
            bloggerMetricsCaptureStatus: resolvedMetrics.captureStatus,
            bloggerMetricsCaptureError: resolvedMetrics.captureError,
            bloggerAccountType: resolvedMetrics.accountType,
            sourceTab: activeTab.key,
            sourceTabLabel: activeTab.label,
            totalCount: checkpointItems.length,
            rawTotalCount: progressStats.detectedCount,
            minLikes: normalizedMinLikes,
            maxDetectedItems: normalizedMaxDetectedItems,
            keywordFilter: keywordFilter || "",
            keywordFilterMode:
              deferKeywordFilter && parsedKeywords.length ? "detail" : "title",
            filteredCount: checkpointItems.length,
            filteredBeforeLimitCount: progressStats.qualifiedCount,
            items: checkpointItems,
            captureTimestamp: Date.now(),
          },
          meta: {
            pageType: PAGE_TYPE.BLOGGER_PROFILE,
            captureStartedAt,
            sourceUrl: window.location.href,
            sourceTab: activeTab.key,
            sourceTabLabel: activeTab.label,
          },
        },
      });
    };

    const collectDetectedNotes = () => {
      mergeNotesIntoMap(noteMap, extractNoteCards(bloggerName, activeTab));
      const allItems = Array.from(noteMap.values());
      const qualifiedCount = allItems.filter(
        (item) => Number(item.likes || 0) >= normalizedMinLikes,
      ).length;
      progressStats = {
        detectedCount: allItems.length,
        qualifiedCount,
        filteredCount: Math.min(qualifiedCount, normalizedMaxDetectedItems),
      };
      emitListCheckpoint();
      return progressStats.detectedCount;
    };

    lastObservedCount = collectDetectedNotes();
    if (lastObservedCount > 0) {
      lastGrowthAt = Date.now();
    }

    // 自动滚动加载（先拿全量 DOM）
    const scrollResult = await autoScrollLoad({
      onProgress: (progress) => {
        emitProgress(progress);
      },
      detectNewContent: () => {
        return collectDetectedNotes();
      },
      maxScrollTimes: normalizedMaxScrollTimes,
      noNewContentThreshold: 0,
      maxDurationMs: normalizedMaxDurationMs,
      waitMinMs: waitRange.min,
      waitMaxMs: waitRange.max,
      scrollStep: async ({noNewContentCount = 0} = {}) => {
        await scrollBloggerNotesResults(activeTab, {noNewContentCount});
      },
      stopWhen: ({currentContentCount}) => {
        if (currentContentCount >= normalizedMaxDetectedItems) {
          return {
            stop: true,
            reason: "max_items",
            message: `达到博主笔记加载上限（已加载 ${currentContentCount}/${normalizedMaxDetectedItems} 条）`,
          };
        }

        if (currentContentCount > lastObservedCount) {
          lastObservedCount = currentContentCount;
          lastGrowthAt = Date.now();
          stallRounds = 0;
          return {stop: false};
        }

        stallRounds += 1;
        if (
          Date.now() - lastGrowthAt >= normalizedStallTimeoutMs &&
          stallRounds >= REQUIRED_BLOGGER_STALL_ROUNDS
        ) {
          return {
            stop: true,
            reason: "stall_timeout",
            message: `连续约 ${Math.floor(normalizedStallTimeoutMs / 1000)} 秒无新增，结束滚动（已探测 ${progressStats.detectedCount} 条，已筛选 ${progressStats.filteredCount} 条）`,
          };
        }
        return {stop: false};
      },
    });

    // 检查是否被取消
    if (isCanceled()) {
      throw new Error("采集已取消");
    }

    // 提取全量笔记后按条件筛选入池
    collectDetectedNotes();
    const allItems = Array.from(noteMap.values());
    const likesFiltered = allItems.filter((item) => item.likes >= normalizedMinLikes);
    const filteredItems = shouldFilterByListTitle
      ? likesFiltered.filter((item) =>
          matchesKeywordFilter(item.title || "", parsedKeywords),
        )
      : likesFiltered;
    const missingMetricCount = countMissingMetric(allItems, "likes");
    const metricCounts = allItems.map((item) => Number(item.likes || 0));
    const minMetricCount = metricCounts.length ? Math.min(...metricCounts) : 0;
    const maxMetricCount = metricCounts.length ? Math.max(...metricCounts) : 0;
    const zeroMetricCount = metricCounts.filter((count) => count === 0).length;
    const metricExtractionSuspicious =
      allItems.length > 0 && maxMetricCount === 0;
    const items = buildFilteredItems();

    // 构建 payload
    const payload = {
      bloggerName,
      bloggerId,
      bloggerUrl: window.location.href,
      bloggerFollowersCount: resolvedMetrics.followersCount,
      bloggerLikedAndCollectedCount: resolvedMetrics.likedAndCollectedCount,
      bloggerProfileUrl: resolvedMetrics.profileUrl || window.location.href,
      bloggerMetricsCaptureStatus: resolvedMetrics.captureStatus,
      bloggerMetricsCaptureError: resolvedMetrics.captureError,
      bloggerAccountType: resolvedMetrics.accountType,
      sourceTab: activeTab.key,
      sourceTabLabel: activeTab.label,
      totalCount: items.length,
      rawTotalCount: allItems.length,
      minLikes: normalizedMinLikes,
      maxDetectedItems: normalizedMaxDetectedItems,
      keywordFilter: keywordFilter || "",
      keywordFilterMode: deferKeywordFilter && parsedKeywords.length ? "detail" : "title",
      filteredCount: items.length,
      filteredBeforeLimitCount: filteredItems.length,
      items,
      captureTimestamp: Date.now(),
    };
    const stageTrace = [
      buildScrollLoadStage({
        label: "博主作品滚动加载",
        requestedMaxDetectedItems: normalizedMaxDetectedItems,
        finalContentCount: allItems.length,
        scrollResult,
        maxScrollTimes: normalizedMaxScrollTimes,
        waitMinMs: waitRange.min,
        waitMaxMs: waitRange.max,
        stallTimeoutMs: normalizedStallTimeoutMs,
        maxDurationMs: normalizedMaxDurationMs,
      }),
      buildListParseStage({
        label: "博主作品列表解析",
        rawTotalCount: allItems.length,
        parsedCount: allItems.length,
        missingMetricCount,
      }),
      buildFilterApplyStage({
        label: "博主作品筛选",
        rawTotalCount: allItems.length,
        filteredBeforeLimitCount: filteredItems.length,
        filteredCount: items.length,
        minLikes: normalizedMinLikes,
        sortDimension: "likes",
        keywordFilter,
        maxDetectedItems: normalizedMaxDetectedItems,
        missingMetricCount,
        minMetricCount,
        maxMetricCount,
        zeroMetricCount,
        metricExtractionSuspicious,
      }),
    ];

    return {
      ok: true,
      type: SYNC_TYPE.BLOGGER_NOTES,
      data: payload,
      meta: {
        pageType: PAGE_TYPE.BLOGGER_PROFILE,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
        sourceTab: activeTab.key,
        sourceTabLabel: activeTab.label,
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
    console.error("[Capture] Blogger notes capture failed:", error);

    return {
      ok: false,
      type: SYNC_TYPE.BLOGGER_NOTES,
      data: null,
      meta: {
        pageType: PAGE_TYPE.BLOGGER_PROFILE,
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

// ==================== 辅助函数 ====================

async function scrollBloggerNotesResults(
  activeTab = null,
  {noNewContentCount = 0} = {},
) {
  const target = findBloggerNotesScrollTarget(activeTab);
  const strongPush = noNewContentCount >= 2;
  const distance = randomScrollDistance(
    strongPush ? 900 : 500,
    strongPush ? 1800 : 1100,
  );

  dispatchWheelHint(target, distance);

  if (target === window) {
    window.scrollBy({
      top: distance,
      behavior: "smooth",
    });
  } else {
    target.scrollTo({
      top: target.scrollTop + distance,
      behavior: "smooth",
    });
  }

  await wait(250);
}

function findBloggerNotesScrollTarget(activeTab = null) {
  const scope = resolveBloggerNotesScope(activeTab);
  const roots = [
    scope,
    querySelector(BLOGGER_PROFILE_SELECTORS.notesList.container),
    document.querySelector(".feeds-container"),
    document.querySelector(".user-feeds"),
    document.querySelector(".profile-container"),
    document.querySelector("#global"),
    document.querySelector("#app"),
    document.querySelector("main"),
    document.scrollingElement,
    document.documentElement,
    document.body,
  ].filter(Boolean);

  for (const root of roots) {
    const target = findScrollableAncestor(root);
    if (target) {
      return target;
    }
  }

  return window;
}

function findScrollableAncestor(startNode) {
  let node = startNode;
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollableElement(node)) {
      return node;
    }
    node = node.parentElement;
  }

  if (isDocumentScrollable()) {
    return window;
  }
  return null;
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

function isDocumentScrollable() {
  const doc = document.documentElement;
  return doc.scrollHeight > window.innerHeight + 24;
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

/**
 * 从 URL 提取博主 ID
 */
function extractBloggerIdFromUrl() {
  const url = window.location.href;
  const match = url.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : null;
}

/**
 * 提取所有笔记卡片
 */
function extractNoteCards(bloggerName = "", activeTab = null) {
  const scope = resolveBloggerNotesScope(activeTab);
  if (!scope) {
    return [];
  }
  const items = querySelectorAll(BLOGGER_PROFILE_SELECTORS.notesList.item, scope);
  const notes = [];
  // 博主主页头部的「IP属地:广东」,下发给该博主每条笔记作为发布位置
  const bloggerIpLocation = extractIpLocation("");

  items.forEach((item) => {
    try {
      const url = extractNoteUrlFromCard(item);
      const noteId = extractNoteIdFromCard(item, url);

      if (!noteId) return;

      // 提取标题
      const titleElement = querySelector(
        BLOGGER_PROFILE_SELECTORS.notesList.title,
        item,
      );
      let title = "";
      if (titleElement) {
        title =
          titleElement.tagName === "IMG"
            ? titleElement.getAttribute("alt") || ""
            : cleanText(titleElement.textContent);
      }
      if (!title) {
        const imgForTitle = item.querySelector("img");
        title = imgForTitle ? cleanText(imgForTitle.alt || "") : "";
      }

      // 提取封面
      const coverElement = querySelector(
        BLOGGER_PROFILE_SELECTORS.notesList.cover,
        item,
      );
      const coverImageUrl = coverElement ? coverElement.src || "" : "";

      // 提取作者
      const authorElement = querySelector(
        BLOGGER_PROFILE_SELECTORS.notesList.author,
        item,
      );
      const author = authorElement
        ? cleanText(authorElement.textContent)
        : bloggerName;

      // 提取点赞数
      const likes = extractBloggerLikeCountFromCard(item);

      // 检查重复
      const isDuplicate = notes.some(
        (note) => note.noteId === noteId || (url && note.url === url),
      );
      if (isDuplicate) return;

      notes.push({
        noteId,
        url,
        title: cleanText(title),
        author: author || bloggerName,
        likes,
        coverImageUrl,
        noteType: detectBloggerNoteType(item),
        publishLocation: bloggerIpLocation,
      });
    } catch (error) {
      console.warn("[Capture] Failed to extract note card:", error);
    }
  });

  return notes;
}

async function resolveCurrentBloggerContentTab({attempts = 4, waitMs = 250} = {}) {
  let best = getBloggerContentTabFromUrl() || getBloggerContentTabFromDom();

  for (let i = 0; i < attempts; i += 1) {
    const scopedPanel = resolveBloggerNotesScope(best, {allowDocumentFallback: false});
    if (scopedPanel) {
      return best || BLOGGER_CONTENT_TABS.note;
    }

    if (i < attempts - 1) {
      await wait(waitMs);
      best = getBloggerContentTabFromUrl() || getBloggerContentTabFromDom() || best;
    }
  }

  return best || BLOGGER_CONTENT_TABS.note;
}

function getBloggerContentTabFromUrl(url = window.location.href) {
  try {
    const parsed = new URL(url, window.location.href);
    return resolveBloggerContentTab(parsed.searchParams.get("tab"));
  } catch {
    return null;
  }
}

function getBloggerContentTabFromDom() {
  const candidates = Array.from(
    document.querySelectorAll(".reds-tab-item, .sub-tab-list, [class*='tab-item']"),
  );
  const activeNode =
    candidates.find((node) => isBloggerTabNodeActive(node)) || candidates[0] || null;
  const text = cleanText(activeNode?.textContent || "");
  return resolveBloggerContentTabLabel(text);
}

function resolveBloggerContentTab(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === "fav" || normalized === "favorite" || normalized === "collect") {
    return BLOGGER_CONTENT_TABS.fav;
  }
  if (normalized === "liked" || normalized === "like") {
    return BLOGGER_CONTENT_TABS.liked;
  }
  if (normalized === "note" || normalized === "notes" || normalized === "works") {
    return BLOGGER_CONTENT_TABS.note;
  }
  return null;
}

function resolveBloggerContentTabLabel(text = "") {
  const normalized = cleanText(text);
  if (!normalized) return null;
  if (normalized.includes("收藏")) {
    return BLOGGER_CONTENT_TABS.fav;
  }
  if (normalized.includes("点赞")) {
    return BLOGGER_CONTENT_TABS.liked;
  }
  if (normalized.includes("笔记") || normalized.includes("作品")) {
    return BLOGGER_CONTENT_TABS.note;
  }
  return null;
}

function isBloggerTabNodeActive(node) {
  if (!(node instanceof Element)) return false;
  const attrText = [
    node.getAttribute("class"),
    node.getAttribute("id"),
    node.getAttribute("aria-current"),
    node.getAttribute("aria-selected"),
    node.getAttribute("data-active"),
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(active|current|selected)\b/i.test(attrText);
}

function resolveBloggerNotesScope(
  activeTab = null,
  {allowDocumentFallback = true} = {},
) {
  const panels = collectBloggerTabPanels();
  const activeIndex = Number(activeTab?.index);

  if (Number.isInteger(activeIndex) && activeIndex >= 0 && panels.length > 0) {
    if (panels[activeIndex]) {
      return panels[activeIndex];
    }
    return null;
  }

  const mostVisiblePanel = pickMostVisibleElement(panels);
  if (mostVisiblePanel) {
    return mostVisiblePanel;
  }

  const containers = querySelectorAll(BLOGGER_PROFILE_SELECTORS.notesList.container).filter(
    (node) => isElementRenderable(node),
  );
  if (containers.length > 0) {
    return pickMostVisibleElement(containers) || containers[0];
  }

  return allowDocumentFallback ? document : null;
}

function collectBloggerTabPanels() {
  const panels = [];
  BLOGGER_TAB_PANEL_SELECTORS.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      if (!panels.includes(node) && isElementRenderable(node)) {
        panels.push(node);
      }
    });
  });
  return panels;
}

function pickMostVisibleElement(nodes = []) {
  let bestNode = null;
  let bestVisibleArea = 0;

  nodes.forEach((node) => {
    const visibleArea = getVisibleArea(node);
    if (visibleArea > bestVisibleArea) {
      bestVisibleArea = visibleArea;
      bestNode = node;
    }
  });

  if (bestNode) {
    return bestNode;
  }

  return nodes.find((node) => isElementRenderable(node)) || null;
}

function isElementRenderable(node) {
  if (!(node instanceof Element)) return false;
  if (node.getAttribute("aria-hidden") === "true") return false;

  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getVisibleArea(node) {
  if (!isElementRenderable(node)) return 0;

  const rect = node.getBoundingClientRect();
  const visibleWidth = Math.max(
    0,
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
  );
  const visibleHeight = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
  );
  return visibleWidth * visibleHeight;
}

function extractNoteUrlFromCard(cardNode) {
  if (!cardNode) return "";

  const candidates = [];
  if (cardNode instanceof HTMLAnchorElement) {
    candidates.push(cardNode.getAttribute("href") || cardNode.href || "");
  }

  const linkCandidates = cardNode.querySelectorAll(
    'a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="/note/"],a[href*="/video/"],a[href*="/search_result/"],a[href*="/user/profile/"],a[href]',
  );
  linkCandidates.forEach((link) => {
    candidates.push(link.getAttribute("href") || link.href || "");
    candidates.push(link.getAttribute("data-href"));
    candidates.push(link.getAttribute("data-url"));
    candidates.push(link.getAttribute("data-note-url"));
    candidates.push(link.dataset?.href);
    candidates.push(link.dataset?.url);
    candidates.push(link.dataset?.noteUrl);
  });

  candidates.push(
    cardNode.getAttribute?.("href"),
    cardNode.getAttribute?.("data-href"),
    cardNode.getAttribute?.("data-url"),
    cardNode.getAttribute?.("data-note-url"),
    cardNode.dataset?.href,
    cardNode.dataset?.url,
    cardNode.dataset?.noteUrl,
  );

  return pickBestNoteUrl(candidates);
}

function extractNoteIdFromCard(cardNode, noteUrl = "") {
  const fromUrl = extractNoteId(noteUrl);
  if (fromUrl) return fromUrl;

  if (!cardNode) return "";
  const candidates = [
    cardNode.getAttribute?.("data-note-id"),
    cardNode.getAttribute?.("note-id"),
    cardNode.dataset?.noteId,
    cardNode.id,
  ];

  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text) continue;

    const direct = text.match(/^[a-zA-Z0-9_-]{8,}$/)?.[0];
    if (direct) return direct;

    const embedded = text.match(/([a-zA-Z0-9_-]{8,})/);
    if (embedded?.[1]) return embedded[1];
  }

  return "";
}

function pickBestNoteUrl(candidates = []) {
  const uniqueCandidates = new Set();
  const normalizedCandidates = [];

  candidates.forEach((candidate) => {
    const normalized = normalizeAbsoluteUrl(candidate);
    if (!normalized || uniqueCandidates.has(normalized)) {
      return;
    }
    uniqueCandidates.add(normalized);
    normalizedCandidates.push(normalized);
  });

  let bestUrl = "";
  let bestScore = -1;

  normalizedCandidates.forEach((url) => {
    const score = scoreNoteUrl(url);
    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
      return;
    }

    if (score === bestScore && score >= 0 && url.length > bestUrl.length) {
      bestUrl = url;
    }
  });

  if (bestScore >= 0) {
    return bestUrl;
  }

  return normalizedCandidates[0] || "";
}

function scoreNoteUrl(url) {
  if (!isXiaohongshuNoteUrl(url)) {
    return -1;
  }

  let score = 100;
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.searchParams.get("xsec_token")) {
      score += 80;
    }
    if (parsed.searchParams.get("xsec_source")) {
      score += 20;
    }
    if (isUserProfileNotePath(parsed.pathname)) {
      score += 10;
    }
    if (parsed.search) {
      score += 5;
    }
  } catch {
    // Ignore parse errors and keep base score.
  }

  return score;
}

function isXiaohongshuNoteUrl(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return false;

  return (
    /\/(?:explore|discovery\/item|note|video|search_result)\/[a-zA-Z0-9_-]+(?:[/?#]|$)/i.test(
      normalized,
    ) || isUserProfileNotePath(normalized)
  );
}

function isUserProfileNotePath(value) {
  return /\/user\/profile\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+(?:[/?#]|$)/i.test(
    String(value || ""),
  );
}

function normalizeAbsoluteUrl(url) {
  const text = String(url || "").trim();
  if (!text) return "";

  try {
    return new URL(text, window.location.href).toString();
  } catch {
    return text;
  }
}

function mergeNotesIntoMap(noteMap, notes = []) {
  if (!(noteMap instanceof Map) || !Array.isArray(notes)) {
    return;
  }

  notes.forEach((note) => {
    if (!note || typeof note !== "object") return;
    const key = String(note.noteId || note.url || "").trim();
    if (!key) return;

    const previous = noteMap.get(key) || {};
    noteMap.set(key, {
      ...previous,
      ...note,
    });
  });
}

function extractBloggerLikeCountFromCard(cardNode) {
  if (!cardNode) return 0;

  const prioritizedNodes = [];
  const likesElement = querySelector(
    BLOGGER_PROFILE_SELECTORS.notesList.likes,
    cardNode,
  );
  if (likesElement) {
    prioritizedNodes.push(likesElement);
  }

  cardNode
    .querySelectorAll?.(
      [
        ".like-count",
        '[class*="like-count"]',
        '[class*="likeCount"]',
        '[class*="like-wrapper"]',
        '[class*="likeWrapper"]',
        '[class*="interaction"]',
        '[class*="interact"]',
        '[class*="engage"]',
        '[aria-label*="点赞"]',
        '[aria-label*="赞"]',
        '[title*="点赞"]',
        '[title*="赞"]',
      ].join(","),
    )
    .forEach((node) => {
      if (!prioritizedNodes.includes(node)) {
        prioritizedNodes.push(node);
      }
    });

  for (const node of prioritizedNodes) {
    const parsed = parseBloggerInteractionCount(
      [
        node?.textContent,
        node?.getAttribute?.("aria-label"),
        node?.getAttribute?.("title"),
      ]
        .filter(Boolean)
        .join(" "),
      {allowLooseText: true},
    );
    if (parsed > 0) {
      return parsed;
    }
  }

  const textNodes = cardNode.querySelectorAll?.("span, div, p, i, em") || [];
  for (const node of textNodes) {
    const text = cleanText(node?.textContent || "");
    if (!text || text.length > 24) continue;
    const parsed = parseBloggerInteractionCount(text, {
      allowLooseText: false,
    });
    if (parsed > 0) {
      return parsed;
    }
  }

  const rawText = cleanText(cardNode.textContent || "");
  const unitMatch = rawText.match(/(\d+(?:\.\d+)?\s*(?:万|[wWkK]))/);
  if (unitMatch?.[1]) {
    const parsed = parseBloggerInteractionCount(unitMatch[1], {
      allowLooseText: false,
    });
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

function parseBloggerInteractionCount(value, {allowLooseText = false} = {}) {
  const text = cleanText(value || "");
  if (!text) return 0;
  if (looksLikeDateOrTime(text)) {
    return 0;
  }

  const metricPattern = allowLooseText
    ? /(\d+(?:\.\d+)?)\s*(万|[wWkK])?/
    : /^(\d+(?:\.\d+)?)\s*(万|[wWkK])?$/;
  const match = text.match(metricPattern);
  if (!match?.[1]) {
    return 0;
  }

  const num = Number.parseFloat(match[1]);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }

  const unit = String(match[2] || "").toLowerCase();
  if (unit === "万" || unit === "w") {
    return Math.round(num * 10000);
  }
  if (unit === "k") {
    return Math.round(num * 1000);
  }

  return parseInteractionCount(match[1]);
}

function looksLikeDateOrTime(text) {
  const normalized = cleanText(text);
  if (!normalized) return false;
  return (
    /\d{1,2}[:：]\d{2}/.test(normalized) ||
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(normalized) ||
    /^\d{1,2}[./-]\d{1,2}$/.test(normalized) ||
    /(分钟前|小时前|天前|刚刚|昨天|今天|前天)/.test(normalized)
  );
}

function normalizeBloggerUserId(rawUserId = "") {
  if (!rawUserId) return "";
  return rawUserId
    .split(/[|｜]/)[0]
    .replace(/^小红书号[:：]?\s*/i, "")
    .replace(/^id[:：]?\s*/i, "")
    .trim();
}

function detectBloggerNoteType(cardNode) {
  if (!cardNode) return "image";

  const byAttr = String(
    cardNode.getAttribute?.("data-note-type") ||
      cardNode.dataset?.noteType ||
      "",
  )
    .trim()
    .toLowerCase();
  if (byAttr.includes("video") || byAttr.includes("视频")) {
    return "video";
  }

  if (
    cardNode.querySelector?.(
      'video, .video, [class*="video"], [class*="play-icon"], [class*="duration"]',
    )
  ) {
    return "video";
  }

  const textNodes = cardNode.querySelectorAll?.("span, div, i") || [];
  for (const node of textNodes) {
    const text = cleanText(node?.textContent || "");
    if (!text) continue;
    if (text === "视频" || text.includes("视频")) {
      return "video";
    }
  }

  return "image";
}

function extractBloggerUserIdFromText(text = "") {
  const normalized = cleanText(text);
  if (!normalized) return "";
  const match = normalized.match(/小红书号[:：]?\s*([a-zA-Z0-9_-]+)/i);
  return match?.[1] ? cleanText(match[1]) : "";
}

function extractIpLocation(text = "") {
  const normalized = cleanText(text);
  const candidates = [normalized, cleanText(document.body?.innerText || "")];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const ipMatch = candidate.match(/IP(?:属地)?[:：]?\s*([^|｜\s]+)/i);
    if (ipMatch?.[1]) {
      return cleanText(ipMatch[1]);
    }
  }

  return "";
}

function collectProfileStatsTextCandidates() {
  const candidates = [];
  const roots = querySelectorAll(["div", "section", "ul", "li", "span"]);

  roots.forEach((node) => {
    const text = cleanText(node?.textContent || "");
    if (!text || text.length > 80) return;
    if (/(关注|粉丝|获赞与收藏|点赞与收藏)/.test(text)) {
      candidates.push(text);
    }
  });

  const bodyText = cleanText(document.body?.innerText || "");
  if (bodyText) {
    candidates.push(bodyText);
  }

  return Array.from(new Set(candidates));
}

function extractBloggerAccountType() {
  const candidates = collectBloggerAccountTypeCandidates();
  const accountType = resolveBloggerAccountTypeFromCandidates(candidates);
  return {
    accountType,
    candidates,
  };
}

function resolveBloggerAccountTypeFromCandidates(candidates = []) {
  for (const candidate of candidates) {
    const normalized = String(candidate || "")
      .trim()
      .toLowerCase();
    if (!normalized) continue;
    const hasFamousIconRef =
      /^#?famous(?:[-_](?:icon|badge|v))?$/i.test(normalized) ||
      /[#/]famous(?:[-_](?:icon|badge|v))?(?:$|[/?#])/i.test(normalized);
    const hasCompanyIconRef =
      /^#?company(?:[-_](?:icon|badge|v))?$/i.test(normalized) ||
      /[#/]company(?:[-_](?:icon|badge|v))?(?:$|[/?#])/i.test(normalized) ||
      /^#?enterprise(?:[-_](?:icon|badge|v))?$/i.test(normalized) ||
      /[#/]enterprise(?:[-_](?:icon|badge|v))?(?:$|[/?#])/i.test(normalized);

    if (
      hasFamousIconRef ||
      (/famous/i.test(normalized) &&
        /(verify|verified|auth|badge|认证|红\s*v|红v)/i.test(normalized)) ||
      /红\s*v|红v|个人认证|博主认证|达人认证/i.test(normalized)
    ) {
      return "famous";
    }

    if (
      hasCompanyIconRef ||
      (/company|enterprise/i.test(normalized) &&
        /(verify|verified|auth|badge|认证|蓝\s*v|蓝v)/i.test(normalized)) ||
      /蓝\s*v|蓝v|企业认证|品牌认证|机构认证/i.test(normalized)
    ) {
      return "company";
    }
  }

  return "";
}

function collectBloggerAccountTypeCandidates() {
  const candidates = [];
  const pushCandidate = (value) => {
    const text = String(value || "").trim();
    if (!text || text.length > 2000) return;
    candidates.push(text);
  };
  const verifySelector =
    '[class*="verify"],[class*="auth"],[aria-label*="认证"],[title*="认证"],[aria-label*="红V"],[aria-label*="蓝V"],[title*="红V"],[title*="蓝V"]';
  const nameElement = querySelector(BLOGGER_PROFILE_SELECTORS.name);
  const accountHeader =
    nameElement?.closest?.(
      ".user-name, .nickname, .user-info, .basic-info, header",
    ) ||
    nameElement?.parentElement ||
    null;

  const scopedRoots = new Set(
    [
      accountHeader,
      accountHeader?.parentElement || null,
      nameElement?.parentElement || null,
      nameElement?.parentElement?.parentElement || null,
    ].filter(Boolean),
  );

  scopedRoots.forEach((root) => {
    pushCandidate(root?.getAttribute?.("class"));
    pushCandidate(root?.getAttribute?.("id"));
    const headerText = cleanText(root?.textContent || "");
    if (headerText) {
      pushCandidate(headerText.slice(0, 240));
    }

    const nestedUseNodes = root.querySelectorAll("use");
    nestedUseNodes.forEach((node) => {
      pushCandidate(node.getAttribute?.("xlink:href"));
      pushCandidate(node.getAttribute?.("href"));
      pushCandidate(node?.ownerSVGElement?.getAttribute?.("class"));
      pushCandidate(node?.ownerSVGElement?.getAttribute?.("aria-label"));
      pushCandidate(node?.ownerSVGElement?.getAttribute?.("title"));
    });

    const verifyNodes = root.querySelectorAll(verifySelector);
    verifyNodes.forEach((node) => {
      pushCandidate(node.getAttribute?.("class"));
      pushCandidate(node.getAttribute?.("id"));
      pushCandidate(node.getAttribute?.("aria-label"));
      pushCandidate(node.getAttribute?.("title"));
      pushCandidate(node.getAttribute?.("data-icon"));
      pushCandidate(node.getAttribute?.("data-testid"));
    });
  });

  return Array.from(new Set(candidates));
}

function extractBloggerMetricsFromCurrentPage() {
  const followersElement = querySelector(
    BLOGGER_PROFILE_SELECTORS.followersCount,
  );
  const followersCountFromSelector = followersElement
    ? parseInteractionCount(cleanText(followersElement.textContent))
    : 0;
  const statsTextCandidates = collectProfileStatsTextCandidates();
  const followersCount =
    followersCountFromSelector ||
    extractMetricByLabels(statsTextCandidates, ["粉丝"]);
  const followingCount = extractMetricByLabels(statsTextCandidates, ["关注"]);
  const likedAndCollectedCount = extractMetricByLabels(statsTextCandidates, [
    "获赞与收藏",
    "点赞与收藏",
  ]);
  const accountTypeResult = extractBloggerAccountType();
  const accountType = accountTypeResult.accountType;
  if (!accountType && accountTypeResult.candidates.length > 0) {
    console.info("[Capture][Blogger] Account type not detected", {
      sampleCandidates: accountTypeResult.candidates.slice(0, 12),
    });
  }
  const hasSignal =
    Boolean(followersElement) ||
    statsTextCandidates.some((text) =>
      /(关注|粉丝|获赞与收藏|点赞与收藏)/.test(text),
    ) ||
    Boolean(accountType);

  return {
    ok: hasSignal,
    followingCount: normalizeNonNegativeInteger(followingCount, 0),
    followersCount: normalizeNonNegativeInteger(followersCount, 0),
    likedAndCollectedCount: normalizeNonNegativeInteger(
      likedAndCollectedCount,
      0,
    ),
    accountType,
    error: hasSignal ? "" : "未识别到博主指标区域",
  };
}

async function extractBloggerMetricsFromCurrentPageWithRetry({
  attempts = 6,
  waitMs = 450,
} = {}) {
  const maxAttempts = Math.max(1, normalizePositiveInteger(attempts, 6));
  const retryWaitMs = Math.max(0, Number(waitMs) || 0);
  let best = extractBloggerMetricsFromCurrentPage();
  if (best.accountType) {
    return best;
  }

  for (let i = 1; i < maxAttempts; i += 1) {
    if (retryWaitMs > 0) {
      await wait(retryWaitMs);
    }
    const next = extractBloggerMetricsFromCurrentPage();
    if (
      next.accountType ||
      (!best.ok && next.ok) ||
      (next.followersCount > best.followersCount &&
        next.likedAndCollectedCount >= best.likedAndCollectedCount)
    ) {
      best = next;
    }
    if (best.accountType) {
      return best;
    }
  }

  return best;
}

function normalizeBloggerMetricsInput(input) {
  const safe = input && typeof input === "object" ? input : {};
  const followersCount = normalizeNonNegativeInteger(
    safe.bloggerFollowersCount ?? safe.followersCount,
    0,
  );
  const likedAndCollectedCount = normalizeNonNegativeInteger(
    safe.bloggerLikedAndCollectedCount ?? safe.likedAndCollectedCount,
    0,
  );
  const accountType = normalizeBloggerAccountType(
    safe.bloggerAccountType || safe.accountType,
  );
  const profileUrl = String(
    safe.bloggerProfileUrl || safe.bloggerUrl || safe.authorUrl || "",
  ).trim();
  const hasSignal =
    isFiniteNonNegativeNumber(safe.bloggerFollowersCount) ||
    isFiniteNonNegativeNumber(safe.followersCount) ||
    isFiniteNonNegativeNumber(safe.bloggerLikedAndCollectedCount) ||
    isFiniteNonNegativeNumber(safe.likedAndCollectedCount) ||
    Boolean(accountType);

  return {
    hasSignal,
    followersCount,
    likedAndCollectedCount,
    accountType,
    profileUrl,
  };
}

function resolveBloggerMetricsWithFallback(
  pageMetrics,
  fallbackMetrics,
  defaultProfileUrl = "",
) {
  if (pageMetrics?.ok) {
    const mergedAccountType =
      normalizeBloggerAccountType(pageMetrics.accountType) ||
      normalizeBloggerAccountType(fallbackMetrics?.accountType);
    return {
      followersCount: pageMetrics.followersCount,
      likedAndCollectedCount: pageMetrics.likedAndCollectedCount,
      accountType: mergedAccountType,
      profileUrl: fallbackMetrics?.profileUrl || defaultProfileUrl,
      captureStatus: "done",
      captureError: "",
    };
  }

  if (fallbackMetrics?.hasSignal) {
    return {
      followersCount: fallbackMetrics.followersCount,
      likedAndCollectedCount: fallbackMetrics.likedAndCollectedCount,
      accountType: normalizeBloggerAccountType(fallbackMetrics.accountType),
      profileUrl: fallbackMetrics.profileUrl || defaultProfileUrl,
      captureStatus: "done",
      captureError: "",
    };
  }

  return {
    followersCount: 0,
    likedAndCollectedCount: 0,
    accountType: "",
    profileUrl: defaultProfileUrl,
    captureStatus: "failed",
    captureError: pageMetrics?.error || "未识别到博主指标",
  };
}

function normalizeBloggerAccountType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "famous") return "famous";
  if (normalized === "company") return "company";
  return "";
}

function isFiniteNonNegativeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0;
}

function extractMetricByLabels(textCandidates = [], labels = []) {
  const cleanLabels = labels
    .map((label) => String(label || "").trim())
    .filter(Boolean);
  if (cleanLabels.length === 0) return 0;

  const labelRegex = cleanLabels.map(escapeRegex).join("|");
  const countPattern = "([0-9]+(?:[.,][0-9]+)?(?:万|W|w|K|k)?(?:\\s*[+＋])?)";
  const patternAfterCount = new RegExp(
    `${countPattern}\\s*(?:${labelRegex})`,
    "i",
  );
  const patternBeforeCount = new RegExp(
    `(?:${labelRegex})\\s*${countPattern}`,
    "i",
  );

  for (const text of textCandidates) {
    const normalized = cleanText(text);
    if (!normalized) continue;

    const matchAfter = normalized.match(patternAfterCount);
    if (matchAfter?.[1]) {
      return parseInteractionCount(matchAfter[1]);
    }

    const matchBefore = normalized.match(patternBeforeCount);
    if (matchBefore?.[1]) {
      return parseInteractionCount(matchBefore[1]);
    }
  }

  return 0;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded > 0 ? rounded : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded >= 0 ? rounded : fallback;
}

function parseKeywordFilter(raw) {
  if (!raw) return [];
  return raw
    .split(/[,，]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function matchesKeywordFilter(text, keywords) {
  if (!keywords.length) return true;
  const lower = (text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}
