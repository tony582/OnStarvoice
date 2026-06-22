/**
 * onstarvoice V2.0 Keyword Search Capture Module
 * 采集关键词搜索结果笔记列表
 */

import {
  SEARCH_RESULTS_SELECTORS,
  querySelector,
  querySelectorAll,
} from "../selectors.js";
import {
  parseInteractionCount,
  normalizeDate,
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

const KEYWORD_SORT_DIMENSION = {
  LIKES: "likes",
  COLLECTS: "collects",
  COMMENTS: "comments",
};

const SORT_DIMENSION_LABEL_MAP = {
  [KEYWORD_SORT_DIMENSION.LIKES]: "点赞",
  [KEYWORD_SORT_DIMENSION.COLLECTS]: "收藏",
  [KEYWORD_SORT_DIMENSION.COMMENTS]: "评论",
};

const MIN_KEYWORD_STALL_TIMEOUT_MS = 15000;
const REQUIRED_KEYWORD_STALL_ROUNDS = 5;

/**
 * 采集关键词搜索结果
 * @param {Object} options - 配置选项
 * @param {string} options.keyword - 搜索关键词
 * @param {Function} options.onProgress - 进度回调
 * @param {number} options.maxScrollTimes - 最大滚动次数
 * @returns {Promise<Object>} 采集结果
 */
export async function captureKeywordNotes({
  keyword = "",
  onProgress = null,
  maxScrollTimes = 50,
  minLikes = 0,
  sortDimension = "",
  maxDetectedItems = null,
  maxItems = null,
  waitMinMs = DEFAULT_CONFIG.SCROLL_DELAY_MIN,
  waitMaxMs = DEFAULT_CONFIG.SCROLL_DELAY_MAX,
  stallTimeoutMs = 3000,
  maxDurationMs = DEFAULT_CONFIG.MAX_CAPTURE_DURATION_MS,
} = {}) {
  const captureStartedAt = new Date().toISOString();
  resetCancelFlag();

  try {
    keyword = normalizeKeyword(keyword);

    // 如果没有提供关键词，从 URL 提取
    if (!keyword) {
      keyword = normalizeKeyword(extractKeywordFromUrl());
    }

    if (!keyword) {
      throw new Error("无法获取搜索关键词");
    }

    // 等待搜索结果加载
    await wait(1500);

    const normalizedMinLikes = normalizeNonNegativeInteger(minLikes, 0);
    const requestedSortDimension = normalizeSortDimension(sortDimension);
    const detectedSort = detectKeywordSortDimension();
    const resolvedSortDimension =
      requestedSortDimension || detectedSort.dimension;
    const sortDimensionSource = requestedSortDimension
      ? "request"
      : detectedSort.source;
    const sortDimensionLabel = getSortDimensionLabel(resolvedSortDimension);
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
    const normalizedStallTimeoutMs = Math.max(
      normalizePositiveInteger(stallTimeoutMs, 3000),
      MIN_KEYWORD_STALL_TIMEOUT_MS,
    );
    const normalizedMaxDurationMs = normalizePositiveInteger(
      maxDurationMs,
      DEFAULT_CONFIG.MAX_CAPTURE_DURATION_MS,
    );
    const normalizedMaxScrollTimes = normalizePositiveInteger(
      maxScrollTimes,
      DEFAULT_CONFIG.MAX_SCROLL_TIMES,
    );
    const noteMap = new Map();
    let progressStats = {
      detectedCount: 0,
      qualifiedCount: 0,
      filteredCount: 0,
    };
    let lastGrowthAt = Date.now();
    let lastObservedCount = 0;
    const emittedCheckpointKeys = new Set();

    const emitProgress = (progress = {}) => {
      if (!onProgress) return;
      onProgress({
        ...progress,
        keyword,
        detectedCount: progressStats.detectedCount,
        qualifiedCount: progressStats.qualifiedCount,
        filteredCount: progressStats.filteredCount,
        minLikes: normalizedMinLikes,
        minInteraction: normalizedMinLikes,
        sortDimension: resolvedSortDimension,
        sortDimensionLabel,
        sortDimensionSource,
        maxDetectedItems: normalizedMaxDetectedItems,
      });
    };

    const buildFilteredItems = () => {
      const allItems = Array.from(noteMap.values());
      const filteredItems = allItems.filter(
        (item) =>
          getKeywordMetricCountByDimension(item, resolvedSortDimension) >=
          normalizedMinLikes,
      );
      return filteredItems.slice(0, normalizedMaxDetectedItems);
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
        message: "正在加载搜索结果",
        listCheckpoint: {
          type: SYNC_TYPE.KEYWORD_NOTES,
          platform: "xiaohongshu",
          items: checkpointItems,
          payload: {
            keyword,
            searchUrl: window.location.href,
            totalCount: checkpointItems.length,
            rawTotalCount: progressStats.detectedCount,
            minLikes: normalizedMinLikes,
            minInteraction: normalizedMinLikes,
            sortDimension: resolvedSortDimension,
            sortDimensionLabel,
            sortDimensionSource,
            maxDetectedItems: normalizedMaxDetectedItems,
            filteredCount: checkpointItems.length,
            filteredBeforeLimitCount: progressStats.qualifiedCount,
            items: checkpointItems,
            captureTimestamp: Date.now(),
          },
          meta: {
            pageType: PAGE_TYPE.SEARCH_RESULTS,
            captureStartedAt,
            sourceUrl: window.location.href,
          },
        },
      });
    };

    const collectDetectedNotes = () => {
      mergeNotesIntoMap(
        noteMap,
        extractNoteCards(resolvedSortDimension),
        normalizedMaxDetectedItems,
      );
      const allItems = Array.from(noteMap.values());
      const qualifiedCount = allItems.filter(
        (item) =>
          getKeywordMetricCountByDimension(item, resolvedSortDimension) >=
          normalizedMinLikes,
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

    // 自动滚动加载
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
        await scrollKeywordSearchResults({noNewContentCount});
      },
      stopWhen: ({currentContentCount, noNewContentCount}) => {
        if (progressStats.detectedCount >= normalizedMaxDetectedItems) {
          return {
            stop: true,
            reason: "max_items",
            message: `达到关键词笔记加载上限（已加载 ${progressStats.detectedCount}/${normalizedMaxDetectedItems} 条，已筛选 ${progressStats.filteredCount} 条）`,
          };
        }

        if (currentContentCount > lastObservedCount) {
          lastObservedCount = currentContentCount;
          lastGrowthAt = Date.now();
          return {stop: false};
        }

        if (
          Date.now() - lastGrowthAt >= normalizedStallTimeoutMs &&
          noNewContentCount >= REQUIRED_KEYWORD_STALL_ROUNDS
        ) {
          return {
            stop: true,
            reason: "stall_timeout",
            message: `连续 ${noNewContentCount} 轮、约 ${Math.floor(normalizedStallTimeoutMs / 1000)} 秒无新增，结束滚动（已加载 ${progressStats.detectedCount} 条，已筛选 ${progressStats.filteredCount} 条）`,
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
    const filteredItems = allItems.filter(
      (item) =>
        getKeywordMetricCountByDimension(item, resolvedSortDimension) >=
        normalizedMinLikes,
    );
    const items = buildFilteredItems();
    const missingMetricCount = countMissingMetric(
      allItems,
      normalizeSortDimension(resolvedSortDimension),
    );
    const metricCounts = allItems.map((item) =>
      getKeywordMetricCountByDimension(item, resolvedSortDimension),
    );
    const minMetricCount = metricCounts.length ? Math.min(...metricCounts) : 0;
    const maxMetricCount = metricCounts.length ? Math.max(...metricCounts) : 0;
    const zeroMetricCount = metricCounts.filter((count) => count === 0).length;
    const metricExtractionSuspicious =
      allItems.length > 0 && maxMetricCount === 0;
    const stageTrace = [
      buildScrollLoadStage({
        label: "搜索结果滚动加载",
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
        label: "搜索结果解析",
        rawTotalCount: allItems.length,
        parsedCount: allItems.length,
        missingMetricCount,
      }),
      buildFilterApplyStage({
        label: "搜索互动阈值筛选",
        rawTotalCount: allItems.length,
        filteredBeforeLimitCount: filteredItems.length,
        filteredCount: items.length,
        minLikes: normalizedMinLikes,
        sortDimension: resolvedSortDimension,
        maxDetectedItems: normalizedMaxDetectedItems,
        missingMetricCount,
        minMetricCount,
        maxMetricCount,
        zeroMetricCount,
        metricExtractionSuspicious,
      }),
    ];

    if (items.length === 0) {
      const sample = allItems.slice(0, 3).map((item) => ({
        noteId: item.noteId,
        url: item.url,
        title: item.title,
        likes: item.likes,
        collects: item.collects,
        comments: item.comments,
      }));
      console.warn(
        "[Capture] Keyword notes extracted empty items after filtering",
        {
          keyword,
          detectedCount: allItems.length,
          filteredBeforeLimitCount: filteredItems.length,
          minLikes: normalizedMinLikes,
          minInteraction: normalizedMinLikes,
          sortDimension: resolvedSortDimension,
          sortDimensionLabel,
          sortDimensionSource,
          maxDetectedItems: normalizedMaxDetectedItems,
          sample,
        },
      );
    }

    // 构建 payload
    const payload = {
      keyword,
      searchUrl: window.location.href,
      totalCount: items.length,
      rawTotalCount: allItems.length,
      minLikes: normalizedMinLikes,
      minInteraction: normalizedMinLikes,
      sortDimension: resolvedSortDimension,
      sortDimensionLabel,
      sortDimensionSource,
      maxDetectedItems: normalizedMaxDetectedItems,
      filteredCount: items.length,
      filteredBeforeLimitCount: filteredItems.length,
      items,
      captureTimestamp: Date.now(),
    };

    return {
      ok: true,
      type: SYNC_TYPE.KEYWORD_NOTES,
      data: payload,
      meta: {
        pageType: PAGE_TYPE.SEARCH_RESULTS,
        captureStartedAt,
        captureFinishedAt: new Date().toISOString(),
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
    console.error("[Capture] Keyword notes capture failed:", error);

    return {
      ok: false,
      type: SYNC_TYPE.KEYWORD_NOTES,
      data: null,
      meta: {
        pageType: PAGE_TYPE.SEARCH_RESULTS,
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

async function scrollKeywordSearchResults({noNewContentCount = 0} = {}) {
  const target = findKeywordSearchScrollTarget();
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

function findKeywordSearchScrollTarget() {
  const roots = [
    querySelector(SEARCH_RESULTS_SELECTORS.container),
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
 * 从 URL 提取搜索关键词
 */
function extractKeywordFromUrl() {
  const url = window.location.href;
  const match = url.match(/[?&]keyword=([^&]+)/i);
  if (match) {
    return decodeURIComponentSafe(match[1]);
  }

  // 备用：从 hash 提取
  const hashMatch = url.match(/#\/search_result\?keyword=([^&]+)/i);
  if (hashMatch) {
    return decodeURIComponentSafe(hashMatch[1]);
  }

  return "";
}

/**
 * 检测当前搜索结果排序维度（点赞/收藏/评论）
 */
export function detectKeywordSortDimension() {
  const fromSortControls = detectSortDimensionFromControls();
  if (fromSortControls) {
    return {
      dimension: fromSortControls,
      source: "sort_controls",
    };
  }

  const fromCardHints = detectSortDimensionFromCards();
  if (fromCardHints) {
    return {
      dimension: fromCardHints,
      source: "card_hints",
    };
  }

  return {
    dimension: KEYWORD_SORT_DIMENSION.LIKES,
    source: "default",
  };
}

/**
 * 提取所有笔记卡片
 */
function extractNoteCards(sortDimension = KEYWORD_SORT_DIMENSION.LIKES) {
  const normalizedSortDimension = normalizeSortDimension(sortDimension);
  const items = querySelectorAll(SEARCH_RESULTS_SELECTORS.noteCard.item);
  const notes = [];
  const dedupe = new Set();

  items.forEach((item, index) => {
    try {
      const noteUrl = extractNoteUrlFromCard(item);
      if (!noteUrl) {
        return;
      }
      let noteId = extractNoteIdFromCard(item, noteUrl);

      // 提取标题
      const title = extractTitleFromCard(item);

      // 如果没有标题，尝试从图片 alt 提取
      let finalTitle = title;
      if (!finalTitle) {
        const imgElement = item.querySelector("img");
        if (imgElement && imgElement.alt) {
          finalTitle = cleanText(imgElement.alt);
        }
      }
      finalTitle = cleanText(finalTitle);

      // 提取封面
      const cover = extractCoverImageFromCard(item);

      // 提取最近编辑时间
      const publishDateRaw = extractPublishDateFromCard(item);
      const publishTimestamp = parsePublishTimestamp(publishDateRaw);
      const publishDate = publishTimestamp
        ? formatDateFromTimestamp(publishTimestamp)
        : publishDateRaw
          ? normalizeDate(publishDateRaw)
          : "";

      // 提取作者（结合最近编辑时间原文剥离拼接尾巴）
      const authorName = normalizeAuthorName(
        extractAuthorFromCard(item, publishDateRaw),
        publishDateRaw,
      );
      const authorAvatar = extractAuthorAvatarFromCard(item);
      const authorProfileUrl = extractAuthorProfileUrlFromCard(item);

      // 提取笔记类型
      const noteType = detectKeywordNoteType(item);

      // 提取当前排序维度对应的互动值
      const interaction = extractPrimaryInteractionMetricFromCard(item);
      const metricDimension =
        normalizedSortDimension ||
        interaction.dimensionHint ||
        KEYWORD_SORT_DIMENSION.LIKES;
      const metricFields = buildMetricFieldsByDimension(
        interaction.count,
        metricDimension,
      );

      // 避免把作者卡/空壳节点误当作笔记数据入池
      if (
        shouldSkipKeywordNote({
          noteUrl,
          title: finalTitle,
          author: authorName,
          cover,
        })
      ) {
        return;
      }

      if (!noteId) {
        noteId = `synthetic_${hashText(
          `${noteUrl}|${finalTitle}|${authorName}|${cover}|${index}`,
        )}`;
      }

      const dedupeKey = String(
        noteId || noteUrl || `${finalTitle}|${authorName}|${cover}`,
      ).trim();
      if (!dedupeKey || dedupe.has(dedupeKey)) {
        return;
      }
      dedupe.add(dedupeKey);

      notes.push({
        noteId,
        url: noteUrl,
        title: finalTitle,
        coverImageUrl: cover,
        author: authorName,
        authorAvatar,
        avatarUrl: authorAvatar,
        authorProfileUrl,
        noteType,
        publishDate,
        publishDateRaw,
        publishTimestamp,
        likes: metricFields.likes,
        collects: metricFields.collects,
        comments: metricFields.comments,
        displayMetricCount: interaction.count,
        displayMetricDimension: metricDimension,
      });
    } catch (error) {
      console.warn("[Capture] Failed to extract note card:", error);
    }
  });

  return notes;
}

function extractNoteUrlFromCard(cardNode) {
  if (!cardNode) return "";

  const candidates = [];
  if (cardNode instanceof HTMLAnchorElement) {
    candidates.push(cardNode.getAttribute("href") || cardNode.href || "");
  }

  const directLink = cardNode.querySelector(
    'a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="/note/"],a[href*="/video/"],a[href*="/search_result/"],a[href*="/user/profile/"],a[href]',
  );
  if (directLink) {
    candidates.push(directLink.getAttribute("href") || directLink.href || "");
  }

  const allLinks = cardNode.querySelectorAll(
    "a[href],a[data-href],a[data-url],a[data-note-url]",
  );
  allLinks.forEach((link) => {
    candidates.push(link.getAttribute("href") || link.href || "");
    candidates.push(link.getAttribute("data-href"));
    candidates.push(link.getAttribute("data-url"));
    candidates.push(link.getAttribute("data-note-url"));
    candidates.push(link.dataset?.href);
    candidates.push(link.dataset?.url);
    candidates.push(link.dataset?.noteUrl);
  });

  const dataCandidates = [
    cardNode.getAttribute?.("href"),
    cardNode.getAttribute?.("data-href"),
    cardNode.getAttribute?.("data-url"),
    cardNode.getAttribute?.("data-note-url"),
    cardNode.dataset?.href,
    cardNode.dataset?.url,
    cardNode.dataset?.noteUrl,
  ];
  candidates.push(...dataCandidates);

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

function extractTitleFromCard(cardNode) {
  if (!cardNode) return "";

  const titleSelectors = SEARCH_RESULTS_SELECTORS.noteCard.title;
  const titleElement = querySelector(titleSelectors, cardNode);
  const fromTitle = titleElement ? cleanText(titleElement.textContent) : "";
  if (fromTitle) return fromTitle;

  const imgElement = cardNode.querySelector("img[alt]");
  if (imgElement?.alt) {
    return cleanText(imgElement.alt);
  }

  return cleanText(
    cardNode.getAttribute?.("title") ||
      cardNode.getAttribute?.("aria-label") ||
      "",
  );
}

function extractCoverImageFromCard(cardNode) {
  if (!cardNode) return "";

  const candidates = [];
  const coverSelectors = SEARCH_RESULTS_SELECTORS.noteCard.cover || [];
  coverSelectors.forEach((selector) => {
    try {
      cardNode.querySelectorAll(selector).forEach((element) => {
        candidates.push(extractImageUrlFromElement(element));
      });
    } catch (error) {
      console.warn("[Capture] Invalid cover selector:", selector, error);
    }
  });

  cardNode.querySelectorAll?.("img")?.forEach((element) => {
    candidates.push(extractImageUrlFromElement(element));
  });

  return (
    candidates
      .map(normalizeMediaUrl)
      .find((url) => url && !isLikelyAvatarUrl(url)) || ""
  );
}

function extractAuthorFromCard(cardNode, publishDateRaw = "") {
  if (!cardNode) return "";

  const authorSelectors = SEARCH_RESULTS_SELECTORS.noteCard.author;
  const authorElement = querySelector(authorSelectors, cardNode);
  const fromAuthor = authorElement
    ? extractAuthorTextFromElement(authorElement, publishDateRaw)
    : "";
  if (fromAuthor) return fromAuthor;

  const authorHint = cardNode.querySelector(
    '[class*="author"],[class*="user"],[class*="name"]',
  );
  return normalizeAuthorName(
    cleanText(authorHint?.textContent || ""),
    publishDateRaw,
  );
}

function extractAuthorAvatarFromCard(cardNode) {
  if (!cardNode) return "";

  const avatarSelectors = SEARCH_RESULTS_SELECTORS.noteCard.avatar || [];
  const avatarElement = querySelector(avatarSelectors, cardNode);
  const directUrl = normalizeMediaUrl(extractImageUrlFromElement(avatarElement));
  if (isLikelyAvatarUrl(directUrl)) return directUrl;

  const imageElements = Array.from(cardNode.querySelectorAll?.("img") || []);
  for (const image of imageElements) {
    const url = normalizeMediaUrl(extractImageUrlFromElement(image));
    if (isLikelyAvatarUrl(url)) return url;
  }

  return "";
}

function extractImageUrlFromElement(element) {
  if (!element) return "";
  return (
    element.getAttribute?.("src") ||
    element.getAttribute?.("data-src") ||
    element.getAttribute?.("data-original") ||
    element.getAttribute?.("data-lazy-src") ||
    element.currentSrc ||
    element.src ||
    ""
  );
}

function extractAuthorProfileUrlFromCard(cardNode) {
  if (!cardNode) return "";

  const candidates = [];
  const links = cardNode.querySelectorAll(
    'a[href*="/user/profile/"],a[data-href*="/user/profile/"],a[data-url*="/user/profile/"]',
  );
  links.forEach((link) => {
    candidates.push(link.getAttribute("href") || link.href || "");
    candidates.push(link.getAttribute("data-href"));
    candidates.push(link.getAttribute("data-url"));
    candidates.push(link.dataset?.href);
    candidates.push(link.dataset?.url);
  });

  return pickBestAuthorProfileUrl(candidates);
}

function detectKeywordNoteType(cardNode) {
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
      'video, .video, [class*="video"], [class*="play-icon"], [class*="duration"], [class*="video-time"], [class*="play"]',
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

function extractPublishDateFromCard(cardNode) {
  if (!cardNode) return "";

  const candidates = [];
  const selectors = SEARCH_RESULTS_SELECTORS.noteCard.publishDate || [];

  selectors.forEach((selector) => {
    try {
      const elements = cardNode.querySelectorAll(selector);
      elements.forEach((element) => {
        const dateText = getDateTextFromElement(element);
        if (dateText) {
          candidates.push(dateText);
        }
      });
    } catch (error) {
      console.warn("[Capture] Invalid publishDate selector:", selector, error);
    }
  });

  const rawText = cleanText(cardNode.textContent || "");
  candidates.push(...extractDateTextCandidates(rawText));

  return pickDateTextCandidate(candidates);
}

function getDateTextFromElement(element) {
  if (!element) return "";

  const datetime = cleanText(element.getAttribute?.("datetime") || "");
  if (looksLikePublishDate(datetime)) {
    return datetime;
  }

  const text = cleanText(element.textContent || "");
  if (looksLikePublishDate(text)) {
    return text;
  }

  return "";
}

function extractDateTextCandidates(text) {
  if (!text) return [];

  const patterns = [
    /\d{4}[./-]\d{1,2}[./-]\d{1,2}/g,
    /\d{1,2}[./-]\d{1,2}/g,
    /\d+\s*分钟前/g,
    /\d+\s*小时前/g,
    /\d+\s*天前/g,
    /刚刚/g,
    /昨天/g,
  ];

  const results = [];
  patterns.forEach((pattern) => {
    const matches = text.match(pattern);
    if (Array.isArray(matches)) {
      results.push(...matches.map((item) => cleanText(item)));
    }
  });

  return [...new Set(results.filter((item) => looksLikePublishDate(item)))];
}

function looksLikePublishDate(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return false;

  return (
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(normalized) ||
    /^\d{1,2}[./-]\d{1,2}$/.test(normalized) ||
    /^\d+\s*分钟前$/.test(normalized) ||
    /^\d+\s*小时前$/.test(normalized) ||
    /^\d+\s*天前$/.test(normalized) ||
    normalized === "刚刚" ||
    normalized === "昨天"
  );
}

function pickDateTextCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return "";
  }

  const normalized = candidates
    .map((item) => cleanText(item))
    .filter((item) => looksLikePublishDate(item));

  if (normalized.length === 0) {
    return "";
  }

  const withYear = normalized.find((item) =>
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(item),
  );
  if (withYear) return withYear;

  const monthDay = normalized.find((item) =>
    /^\d{1,2}[./-]\d{1,2}$/.test(item),
  );
  if (monthDay) return monthDay;

  return normalized[0];
}

function detectSortDimensionFromControls() {
  const candidates = collectSortControlCandidates();
  if (candidates.length === 0) {
    return "";
  }

  const best = {
    dimension: "",
    score: 0,
  };

  candidates.forEach((node) => {
    const text = cleanText(node?.textContent || node?.innerText || "");
    if (!text || text.length > 24) {
      return;
    }

    const dimension = mapSortDimensionFromText(text);
    if (!dimension) {
      return;
    }

    const score = scoreSortControlActiveState(node);
    if (score > best.score) {
      best.dimension = dimension;
      best.score = score;
    }
  });

  return best.score >= 3 ? best.dimension : "";
}

function collectSortControlCandidates() {
  const selectors = [
    "button",
    '[role="button"]',
    '[class*="sort"] [class*="item"]',
    '[class*="filter"] [class*="item"]',
    '[class*="sort"] .tag',
    '[class*="filter"] .tag',
  ];

  const nodes = [];
  const seen = new Set();

  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      nodes.push(node);
    });
  });

  return nodes;
}

function mapSortDimensionFromText(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return "";

  if (/(最多点赞|点赞最多|按点赞|点赞数)/i.test(normalized)) {
    return KEYWORD_SORT_DIMENSION.LIKES;
  }
  if (/(最多收藏|收藏最多|按收藏|收藏数)/i.test(normalized)) {
    return KEYWORD_SORT_DIMENSION.COLLECTS;
  }
  if (/(最多评论|评论最多|按评论|评论数)/i.test(normalized)) {
    return KEYWORD_SORT_DIMENSION.COMMENTS;
  }

  return "";
}

function scoreSortControlActiveState(node) {
  if (!node || !(node instanceof Element)) {
    return 0;
  }

  let score = 0;
  const className = String(node.className || "").toLowerCase();
  const stateAttrs = [
    node.getAttribute("aria-selected"),
    node.getAttribute("aria-pressed"),
    node.getAttribute("data-state"),
    node.getAttribute("data-active"),
    node.getAttribute("data-selected"),
  ]
    .map((item) => String(item || "").toLowerCase())
    .filter(Boolean)
    .join(" ");

  if (/\btrue\b|active|selected|checked|current|on/.test(stateAttrs)) {
    score += 6;
  }

  if (/(is-active|active|selected|current|checked|on|chosen)/.test(className)) {
    score += 4;
  }

  if (/(red|highlight)/.test(className)) {
    score += 1;
  }

  if (isElementVisible(node)) {
    score += 1;
  }

  try {
    const style = window.getComputedStyle(node);
    if (isStrongRedColor(style?.color)) {
      score += 2;
    }
    if (
      isStrongRedColor(style?.borderColor) ||
      isStrongRedColor(style?.backgroundColor)
    ) {
      score += 1;
    }
  } catch {
    // ignore computed style errors
  }

  return score;
}

function isElementVisible(node) {
  if (!node || !(node instanceof Element)) {
    return false;
  }
  return node.getClientRects().length > 0;
}

function isStrongRedColor(color) {
  const text = String(color || "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  const match = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return false;
  const r = Number.parseInt(match[1], 10);
  const g = Number.parseInt(match[2], 10);
  const b = Number.parseInt(match[3], 10);
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
    ? r >= 200 && g <= 120 && b <= 120
    : false;
}

function detectSortDimensionFromCards() {
  const cards = Array.from(
    querySelectorAll(SEARCH_RESULTS_SELECTORS.noteCard.item) || [],
  ).slice(0, 24);
  if (!Array.isArray(cards) || cards.length === 0) {
    return "";
  }

  const scores = {
    [KEYWORD_SORT_DIMENSION.LIKES]: 0,
    [KEYWORD_SORT_DIMENSION.COLLECTS]: 0,
    [KEYWORD_SORT_DIMENSION.COMMENTS]: 0,
  };

  cards.forEach((card) => {
    const dimension = extractMetricDimensionHintFromCard(card);
    if (dimension) {
      scores[dimension] += 1;
    }
  });

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const bestDimension = ranked[0]?.[0] || "";
  const bestScore = Number(ranked[0]?.[1] || 0);
  const secondScore = Number(ranked[1]?.[1] || 0);
  if (!bestDimension || bestScore < 2 || bestScore <= secondScore) {
    return "";
  }

  return normalizeSortDimension(bestDimension);
}

function extractPrimaryInteractionMetricFromCard(cardNode) {
  if (!cardNode) {
    return {
      count: 0,
      dimensionHint: "",
    };
  }

  const dimensionHint = extractMetricDimensionHintFromCard(cardNode);

  const likesSelectors = SEARCH_RESULTS_SELECTORS.noteCard.likes;
  const likesElement = querySelector(likesSelectors, cardNode);
  const fromSelector = likesElement
    ? parseKeywordInteractionCount(cleanText(likesElement.textContent))
    : 0;
  if (fromSelector > 0) {
    return {count: fromSelector, dimensionHint};
  }

  const hintNodes = cardNode.querySelectorAll(
    '[class*="count"],[class*="interact"],[class*="engage"],[class*="like"],[class*="collect"],[class*="comment"],[aria-label],[title]',
  );
  for (const hint of hintNodes) {
    const parsed = parseKeywordInteractionCount(cleanText(hint.textContent));
    if (parsed > 0) {
      return {count: parsed, dimensionHint};
    }
  }

  const rawText = cleanText(cardNode.textContent || "");
  const suffixMatch = rawText.match(
    /(\d+(?:\.\d+)?\s*[wWkK万]?)\s*(?:点赞|赞|like|收藏|collect|评论|comment)\b/i,
  );
  if (suffixMatch?.[1]) {
    const parsed = parseKeywordInteractionCount(suffixMatch[1]);
    if (parsed > 0) {
      return {count: parsed, dimensionHint};
    }
  }

  const prefixMatch = rawText.match(
    /(?:点赞|赞|like|收藏|collect|评论|comment)\s*(\d+(?:\.\d+)?\s*[wWkK万]?)/i,
  );
  if (prefixMatch?.[1]) {
    const parsed = parseKeywordInteractionCount(prefixMatch[1]);
    if (parsed > 0) {
      return {count: parsed, dimensionHint};
    }
  }

  return {
    count: 0,
    dimensionHint,
  };
}

function parseKeywordInteractionCount(value) {
  const text = cleanText(value || "");
  if (!text) return 0;
  if (
    /\d{1,2}[:：]\d{2}/.test(text) ||
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(text) ||
    /^\d{1,2}[./-]\d{1,2}$/.test(text) ||
    /(分钟前|小时前|天前|刚刚|昨天|今天|前天)/.test(text)
  ) {
    return 0;
  }

  const normalized = text.toLowerCase();
  const wMatch = normalized.match(/(\d+(?:\.\d+)?)\s*w\b/);
  if (wMatch?.[1]) {
    const num = Number.parseFloat(wMatch[1]);
    if (Number.isFinite(num)) {
      return Math.round(num * 10000);
    }
  }

  return parseInteractionCount(text);
}

function extractMetricDimensionHintFromCard(cardNode) {
  if (!cardNode) return "";

  const candidates = [];
  const hintNodes = cardNode.querySelectorAll(
    'svg use,[class*="like"],[class*="collect"],[class*="comment"],[class*="interact"],[class*="engage"],[class*="icon"],[aria-label],[title]',
  );

  hintNodes.forEach((node) => {
    candidates.push(node.getAttribute?.("class"));
    candidates.push(node.getAttribute?.("id"));
    candidates.push(node.getAttribute?.("aria-label"));
    candidates.push(node.getAttribute?.("title"));
    candidates.push(node.getAttribute?.("name"));
    candidates.push(node.getAttribute?.("href"));
    candidates.push(node.getAttribute?.("xlink:href"));
    candidates.push(node.getAttribute?.("data-type"));
    candidates.push(node.getAttribute?.("data-testid"));
  });

  return inferMetricDimensionFromHints(candidates);
}

function inferMetricDimensionFromHints(hints = []) {
  const text = hints.map((item) => String(item || "").toLowerCase()).join(" ");
  if (!text) return "";

  const scores = {
    [KEYWORD_SORT_DIMENSION.LIKES]: 0,
    [KEYWORD_SORT_DIMENSION.COLLECTS]: 0,
    [KEYWORD_SORT_DIMENSION.COMMENTS]: 0,
  };

  ["like", "heart", "zan", "点赞", "赞"].forEach((token) => {
    if (text.includes(token)) scores[KEYWORD_SORT_DIMENSION.LIKES] += 1;
  });
  ["collect", "favorite", "favourite", "star", "shoucang", "收藏"].forEach(
    (token) => {
      if (text.includes(token)) scores[KEYWORD_SORT_DIMENSION.COLLECTS] += 1;
    },
  );
  ["comment", "chat", "message", "pinglun", "评论"].forEach((token) => {
    if (text.includes(token)) scores[KEYWORD_SORT_DIMENSION.COMMENTS] += 1;
  });

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  if (!best || Number(best[1]) <= 0) {
    return "";
  }
  return normalizeSortDimension(best[0]);
}

function buildMetricFieldsByDimension(value, dimension) {
  const count = normalizeNonNegativeInteger(value, 0);
  const normalizedDimension = normalizeSortDimension(dimension);
  if (normalizedDimension === KEYWORD_SORT_DIMENSION.COLLECTS) {
    return {likes: 0, collects: count, comments: 0};
  }
  if (normalizedDimension === KEYWORD_SORT_DIMENSION.COMMENTS) {
    return {likes: 0, collects: 0, comments: count};
  }
  return {likes: count, collects: 0, comments: 0};
}

function getKeywordMetricCountByDimension(item, dimension) {
  const normalizedDimension = normalizeSortDimension(dimension);
  if (normalizedDimension === KEYWORD_SORT_DIMENSION.COLLECTS) {
    return normalizeNonNegativeInteger(item?.collects, 0);
  }
  if (normalizedDimension === KEYWORD_SORT_DIMENSION.COMMENTS) {
    return normalizeNonNegativeInteger(item?.comments, 0);
  }
  return normalizeNonNegativeInteger(item?.likes, 0);
}

function getSortDimensionLabel(dimension) {
  return SORT_DIMENSION_LABEL_MAP[normalizeSortDimension(dimension)] || "点赞";
}

function normalizeSortDimension(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === KEYWORD_SORT_DIMENSION.LIKES) {
    return KEYWORD_SORT_DIMENSION.LIKES;
  }
  if (normalized === KEYWORD_SORT_DIMENSION.COLLECTS) {
    return KEYWORD_SORT_DIMENSION.COLLECTS;
  }
  if (normalized === KEYWORD_SORT_DIMENSION.COMMENTS) {
    return KEYWORD_SORT_DIMENSION.COMMENTS;
  }
  return "";
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

  return "";
}

function pickBestAuthorProfileUrl(candidates = []) {
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

  return (
    normalizedCandidates.find((url) => isXiaohongshuAuthorProfileUrl(url)) || ""
  );
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

function isXiaohongshuAuthorProfileUrl(value) {
  return /\/user\/profile\/[a-zA-Z0-9_-]+(?:[/?#]|$)/i.test(
    String(value || ""),
  );
}

function hashText(value) {
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function mergeNotesIntoMap(noteMap, notes = [], maxItems = Infinity) {
  if (!(noteMap instanceof Map) || !Array.isArray(notes)) {
    return;
  }

  notes.forEach((note) => {
    if (!note || typeof note !== "object") return;
    const key = String(note.noteId || note.url || "").trim();
    if (!key) return;
    if (!noteMap.has(key) && noteMap.size >= maxItems) return;

    const previous = noteMap.get(key) || {};
    noteMap.set(key, {
      ...previous,
      ...note,
    });
  });
}

function normalizeMediaUrl(url) {
  const text = String(url || "").trim();
  if (!text) return "";

  if (text.startsWith("//")) {
    return `https:${text}`;
  }

  if (/^http:\/\//i.test(text)) {
    return text.replace(/^http:\/\//i, "https://");
  }

  return text;
}

function isLikelyAvatarUrl(url) {
  const text = String(url || "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  return text.includes("sns-avatar") || /\/avatar\//i.test(text);
}

function normalizeAuthorName(authorName, publishDateRaw = "") {
  const text = cleanText(authorName || "");
  if (!text) return "";
  if (/^\d{1,4}([./-]\d{1,2}){0,2}$/.test(text)) return "";
  if (
    /^(?:笔记最近编辑时间|最近编辑时间|发布\s*时间|发布|日期|时间)$/i.test(text)
  )
    return "";
  const cleaned = stripTrailingAuthorDateTime(text, publishDateRaw);
  return cleaned || text;
}

function extractAuthorTextFromElement(element, publishDateRaw = "") {
  if (!element) return "";

  const directText = extractDirectTextNodes(element);
  const normalizedDirect = normalizeAuthorName(directText, publishDateRaw);
  if (normalizedDirect) {
    return normalizedDirect;
  }

  return normalizeAuthorName(
    cleanText(element.textContent || ""),
    publishDateRaw,
  );
}

function extractDirectTextNodes(element) {
  if (!element || !element.childNodes) return "";
  const parts = [];

  element.childNodes.forEach((node) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = cleanText(node.textContent || "");
      if (text) {
        parts.push(text);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const child = /** @type {Element} */ (node);
    const className = String(child.className || "").toLowerCase();
    const childText = cleanText(child.textContent || "");
    if (!childText) return;

    if (
      looksLikePublishDate(childText) ||
      /(?:publish|date|time|最近编辑|发布\s*时间|日期|时间|天前|小时前|分钟前|刚刚|昨天|今天|前天)/i.test(
        className,
      )
    ) {
      return;
    }

    parts.push(childText);
  });

  return cleanText(parts.join(" "));
}

function stripTrailingAuthorDateTime(text, publishDateRaw = "") {
  let next = cleanText(text || "");
  if (!next) return "";

  const normalizedPublishDateRaw = cleanText(publishDateRaw || "");
  if (normalizedPublishDateRaw) {
    const escapedPublishDate = escapeRegex(normalizedPublishDateRaw);
    next = cleanText(
      next.replace(
        new RegExp(`(?:[\\s|｜·•\\-–—_/：:.,，。]*)${escapedPublishDate}$`),
        "",
      ),
    );
  }

  const trailingPatterns = [
    // 02-11 / 2/11 / 2.11 / 02月11日（支持无空格拼接：昵称02-11）
    /(?:[\s|｜·•\-–—_/：:.,，。]*)?(\d{1,2}(?:[./-]\d{1,2}|月\d{1,2}日?))$/,
    // 2026-02-11 / 2026/02/11 / 2026.02.11
    /(?:[\s|｜·•\-–—_/：:.,，。]*)?(\d{4}[./-]\d{1,2}[./-]\d{1,2})$/,
    // 21:59 / 9:08
    /(?:[\s|｜·•\-–—_/：:.,，。]*)?(\d{1,2}[:：]\d{2})$/,
    // 昨天21:59 / 今天 21:59 / 前天 08:00
    /(?:[\s|｜·•\-–—_/：:.,，。]*)?((?:昨天|今天|前天)\s*\d{1,2}[:：]\d{2})$/,
    // 3分钟前 / 5小时前 / 2天前 / 刚刚 / 昨天 / 今天 / 前天（支持无空格拼接）
    /(?:[\s|｜·•\-–—_/：:.,，。]*)?((?:\d+\s*(?:分钟前|小时前|天前))|刚刚|昨天|今天|前天)$/,
  ];

  // 允许剥离多个连续尾巴（例如 “昨天 21:59”）
  for (let i = 0; i < 3; i += 1) {
    let changed = false;
    for (const pattern of trailingPatterns) {
      if (pattern.test(next)) {
        next = cleanText(next.replace(pattern, ""));
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 清掉结尾连接符，避免 “昵称-” 这种残留。
  next = next.replace(/[-–—_/：:.,，。\s]+$/g, "").trim();
  return cleanText(next);
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldSkipKeywordNote({noteUrl, title, author, cover}) {
  if (!noteUrl) return true;
  if (!isXiaohongshuNoteUrl(noteUrl)) return true;

  const hasTitle = Boolean(cleanText(title || ""));
  const hasAuthor = Boolean(cleanText(author || ""));
  const hasCover = Boolean(String(cover || "").trim());
  if (!hasTitle && !hasAuthor && !hasCover) return true;

  return false;
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

function decodeURIComponentSafe(value) {
  let decoded = String(value || "").replace(/\+/g, "%20");
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return next;
      }
      decoded = next;
    } catch {
      return decoded;
    }
  }
  return decoded;
}

function normalizeKeyword(value) {
  return decodeURIComponentSafe(value).trim();
}

function parsePublishTimestamp(rawText) {
  const text = cleanText(rawText || "");
  if (!text) return 0;

  const now = new Date();

  if (text === "刚刚") {
    return now.getTime();
  }

  let match = text.match(/(\d+)\s*分钟前/);
  if (match?.[1]) {
    const minutes = Number.parseInt(match[1], 10);
    if (Number.isFinite(minutes)) {
      return now.getTime() - minutes * 60 * 1000;
    }
  }

  match = text.match(/(\d+)\s*小时前/);
  if (match?.[1]) {
    const hours = Number.parseInt(match[1], 10);
    if (Number.isFinite(hours)) {
      return now.getTime() - hours * 60 * 60 * 1000;
    }
  }

  if (text === "昨天") {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      0,
      0,
      0,
      0,
    ).getTime();
  }

  match = text.match(/(\d+)\s*天前/);
  if (match?.[1]) {
    const days = Number.parseInt(match[1], 10);
    if (Number.isFinite(days)) {
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - days,
        0,
        0,
        0,
        0,
      ).getTime();
    }
  }

  match = text.match(
    /(\d{4})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})日?\s*(\d{1,2})[:：](\d{2})/,
  );
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      0,
      0,
    ).getTime();
  }

  match = text.match(/(\d{1,2})[./-](\d{1,2})\s*(\d{1,2})[:：](\d{2})/);
  if (match) {
    const [, month, day, hour, minute] = match;
    const candidate = new Date(
      now.getFullYear(),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      0,
      0,
    );
    if (candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
      candidate.setFullYear(candidate.getFullYear() - 1);
    }
    return candidate.getTime();
  }

  match = text.match(/(\d{4})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})日?/);
  if (match) {
    const [, year, month, day] = match;
    return new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      0,
      0,
      0,
      0,
    ).getTime();
  }

  match = text.match(/(\d{1,2})[./-](\d{1,2})/);
  if (match) {
    const [, month, day] = match;
    const candidate = new Date(
      now.getFullYear(),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      0,
      0,
      0,
      0,
    );
    if (candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
      candidate.setFullYear(candidate.getFullYear() - 1);
    }
    return candidate.getTime();
  }

  const normalizedDate = normalizeDate(text);
  if (normalizedDate) {
    const timestamp = new Date(`${normalizedDate}T00:00:00`).getTime();
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  return 0;
}

function formatDateFromTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
