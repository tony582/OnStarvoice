/**
 * Douyin Keyword Search Capture Module
 * Search results DOM capture for jingxuan/search and search pages.
 */

import {PAGE_TYPE, SYNC_TYPE, DEFAULT_CONFIG} from "../constants.js";
import {cleanText, extractNoteId, normalizeDate} from "../helpers.js";
import {autoScrollLoad, isCanceled, resetCancelFlag, wait} from "../scroll.js";
import {getDomProfile} from "../platform/dom-profiles/index.js";
import {
  ensureSectionReady,
  getAttribute,
  getFirstMatch,
  getText,
  resolveSectionRoot,
} from "./shared/detail-dom.js";
import {
  buildDomLocator,
  buildReverseMatchHints,
  collectMediaUrlsFromElement,
} from "./shared/dom-locator.js";

const DOUYIN_DOM_PROFILE = getDomProfile("douyin");
const DEFAULT_SORT_DIMENSION = "likes";
const SEARCH_KEYWORD_QUERY_KEYS = new Set([
  "keyword",
  "query",
  "q",
  "search_keyword",
  "searchkey",
  "search_word",
]);

export async function captureDouyinKeywordNotes({
  keyword = "",
  onProgress = null,
  maxScrollTimes = 50,
  minLikes = 0,
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
    await wait(1200);
    assertNoCaptchaPage();
    await ensureSectionReady(DOUYIN_DOM_PROFILE, "searchResults");

    const searchRoot = resolveSectionRoot(DOUYIN_DOM_PROFILE, "searchResults");
    const resolvedKeyword = normalizeKeyword(
      keyword ||
        extractKeywordFromUrl(window.location.href) ||
        getText(DOUYIN_DOM_PROFILE.searchResults.fields.searchInput, document),
    );

    if (!resolvedKeyword) {
      throw new Error("无法获取抖音搜索关键词");
    }

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
    const normalizedStallTimeoutMs = normalizePositiveInteger(
      stallTimeoutMs,
      3000,
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
    const requiredStallRounds = 3;

    const emitProgress = (progress = {}) => {
      if (!onProgress) return;
      onProgress({
        ...progress,
        keyword: resolvedKeyword,
        detectedCount: progressStats.detectedCount,
        qualifiedCount: progressStats.qualifiedCount,
        filteredCount: progressStats.filteredCount,
        minLikes: normalizedMinLikes,
        sortDimension: DEFAULT_SORT_DIMENSION,
        sortDimensionLabel: "点赞",
        sortDimensionSource: "douyin_default",
        maxDetectedItems: normalizedMaxDetectedItems,
      });
    };

    const collectDetectedNotes = () => {
      mergeNotesIntoMap(
        noteMap,
        extractDouyinSearchCards(searchRoot),
        normalizedMaxDetectedItems,
      );
      const allItems = Array.from(noteMap.values());
      const qualifiedCount = allItems.filter(
        (item) => Number(item.likes || 0) >= normalizedMinLikes,
      ).length;
      progressStats = {
        detectedCount: allItems.length,
        qualifiedCount,
        filteredCount: Math.min(qualifiedCount, normalizedMaxDetectedItems),
      };
      return progressStats.detectedCount;
    };

    lastObservedCount = collectDetectedNotes();
    if (lastObservedCount > 0) {
      lastGrowthAt = Date.now();
    }

    const scrollResult = await autoScrollLoad({
      onProgress: (progress) => {
        emitProgress(progress);
      },
      detectNewContent: () => collectDetectedNotes(),
      maxScrollTimes: normalizedMaxScrollTimes,
      noNewContentThreshold: 0,
      maxDurationMs: normalizedMaxDurationMs,
      waitMinMs: waitRange.min,
      waitMaxMs: waitRange.max,
      scrollStep: async ({noNewContentCount = 0} = {}) => {
        await scrollDouyinSearchResults(searchRoot, {noNewContentCount});
      },
      stopWhen: ({currentContentCount, noNewContentCount}) => {
        if (progressStats.detectedCount >= normalizedMaxDetectedItems) {
          return {
            stop: true,
            reason: "max_items",
            message: `达到抖音搜索结果探测上限（已探测 ${progressStats.detectedCount}/${normalizedMaxDetectedItems} 条，已筛选 ${progressStats.filteredCount} 条）`,
          };
        }

        if (currentContentCount > lastObservedCount) {
          lastObservedCount = currentContentCount;
          lastGrowthAt = Date.now();
          return {stop: false};
        }

        if (
          Date.now() - lastGrowthAt >= normalizedStallTimeoutMs &&
          noNewContentCount >= requiredStallRounds
        ) {
          return {
            stop: true,
            reason: "stall_timeout",
            message: `连续 ${noNewContentCount} 轮、约 ${Math.floor(normalizedStallTimeoutMs / 1000)} 秒无新增，结束滚动（已探测 ${progressStats.detectedCount} 条，已筛选 ${progressStats.filteredCount} 条）`,
          };
        }

        return {stop: false};
      },
    });

    if (isCanceled()) {
      throw new Error("采集已取消");
    }

    collectDetectedNotes();
    const allItems = Array.from(noteMap.values());
    const filteredItems = allItems.filter(
      (item) => Number(item.likes || 0) >= normalizedMinLikes,
    );
    const items = filteredItems.slice(0, normalizedMaxDetectedItems);

    const payload = {
      keyword: resolvedKeyword,
      searchUrl: window.location.href,
      totalCount: items.length,
      rawTotalCount: allItems.length,
      minLikes: normalizedMinLikes,
      minInteraction: normalizedMinLikes,
      sortDimension: DEFAULT_SORT_DIMENSION,
      sortDimensionLabel: "点赞",
      sortDimensionSource: "douyin_default",
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
          completed: scrollResult.completed,
          canceled: scrollResult.canceled,
        },
      },
      error: null,
    };
  } catch (error) {
    console.error("[Douyin][KeywordSearch] Capture failed:", error);

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

function assertNoCaptchaPage() {
  const title = cleanText(document.title || "");
  const bodyText = cleanText(document.body?.innerText || "");
  if (/验证码中间页/i.test(title) || /请完成下列验证后继续:/i.test(bodyText)) {
    throw new Error("当前页面触发抖音验证码或风险中间页");
  }
}

function extractKeywordFromUrl(url) {
  const parsed = new URL(String(url || ""), window.location.origin);
  const pathname = decodeURIComponent(parsed.pathname || "");
  const queryKeyword = extractKeywordFromSearchParams(parsed.searchParams);
  if (queryKeyword) {
    return queryKeyword;
  }

  const pathMatch = pathname.match(/\/(?:jingxuan\/search|search)\/([^/?#]+)/i);
  if (pathMatch?.[1]) {
    return decodeURIComponent(pathMatch[1]);
  }

  return "";
}

function extractKeywordFromSearchParams(searchParams) {
  if (!searchParams || typeof searchParams.entries !== "function") {
    return "";
  }

  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase();
    if (!SEARCH_KEYWORD_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }

    const normalizedValue = String(value || "").trim();
    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return "";
}

function extractDouyinSearchCards(searchRoot) {
  const cards = collectSearchCards(searchRoot);
  const notes = [];
  const dedupe = new Set();
  const tabType = detectSearchTabType();

  cards.forEach((card, index) => {
    const noteId = resolveSearchCardId(card, index);
    const noteUrl = resolveSearchCardUrl(card, noteId, tabType);
    if (!noteUrl) return;
    if (!noteId) return;

    const dedupeKey = `${noteId}-${noteUrl}`;
    if (dedupe.has(dedupeKey)) return;
    dedupe.add(dedupeKey);

    const title = resolveSearchCardTitle(card, noteId, index);
    const coverImageUrl = resolveSearchCardCover(card);
    const author = resolveSearchCardAuthor(card);
    const cardMedia = collectMediaUrlsFromElement(card);
    const reverseMatchHints = buildReverseMatchHints({
      noteId,
      noteUrl,
      coverImageUrl,
      videoUrl: cardMedia.videos[0] || "",
      title,
      author,
    });
    const duration = cleanText(
      getText(DOUYIN_DOM_PROFILE.searchResults.cards.fields.duration, card),
    );
    const likes = resolveSearchCardLikes(card);
    const publishDateRaw = cleanText(resolveSearchCardPublishDate(card));
    const publishDate = publishDateRaw
      ? normalizeSearchDate(publishDateRaw)
      : "";
    const noteType = resolveSearchCardNoteType(card, noteUrl, tabType);

    notes.push({
      noteId,
      url: noteUrl,
      noteUrl,
      detailPageUrl: noteUrl,
      title,
      coverImageUrl,
      author,
      noteType,
      duration,
      publishDate,
      publishDateRaw,
      likes,
      collects: 0,
      comments: 0,
      displayMetricCount: likes,
      displayMetricDimension: DEFAULT_SORT_DIMENSION,
      domLocator: buildDomLocator(card),
      domMatchHints: reverseMatchHints,
      cardImageCandidates: cardMedia.images,
      cardVideoCandidates: cardMedia.videos,
      captureTimestamp: Date.now(),
    });
  });

  return notes;
}

function collectSearchCards(searchRoot) {
  const selectors =
    DOUYIN_DOM_PROFILE.searchResults.cards.cardSelectors.join(", ");
  const rawNodes = Array.from(
    (searchRoot || document).querySelectorAll(selectors),
  );
  const cards = [];
  const seen = new Set();

  rawNodes.forEach((node) => {
    const card = node.matches?.(".search-result-card")
      ? node
      : node.querySelector?.(".search-result-card") ||
        node.closest?.(".search-result-card") ||
        null;
    if (!card) return;

    const key =
      card.id ||
      `${String(card.className || "").slice(0, 80)}::${cleanText(card.innerText || "").slice(0, 80)}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    cards.push(card);
  });

  return cards;
}

function resolveSearchCardId(card, index = 0) {
  const idCandidates = [
    card?.id,
    card?.closest?.("[id^='waterfall_item_']")?.id,
    card?.getAttribute?.("data-id"),
    card?.getAttribute?.("data-aweme-id"),
  ];

  for (const candidate of idCandidates) {
    const text = String(candidate || "");
    const match = text.match(/(\d{8,})/);
    if (match?.[1]) {
      return match[1];
    }
  }

  const text = cleanText(card?.innerText || "");
  const inlineId = text.match(/\b(\d{16,20})\b/);
  if (inlineId?.[1]) {
    return inlineId[1];
  }

  return `search_card_${index + 1}`;
}

function resolveSearchCardUrl(card, noteId, tabType) {
  const anchors = Array.from(card?.querySelectorAll?.("a[href]") || []);
  const anchorCandidates = anchors.flatMap((anchor) => [
    anchor.getAttribute("href"),
    anchor.href,
    anchor.getAttribute("data-href"),
    anchor.getAttribute("data-url"),
  ]);

  const candidates = [
    ...anchorCandidates,
    card?.getAttribute?.("href"),
    card?.getAttribute?.("data-href"),
    card?.getAttribute?.("data-url"),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate);
    if (!normalized) continue;
    if (
      !/\/(?:video|note)\//i.test(normalized) &&
      !/[?&]modal_id=/i.test(normalized)
    ) {
      continue;
    }

    const noteId = extractNoteId(normalized);
    if (!noteId) continue;

    if (/\/(?:video|note)\//i.test(normalized)) {
      return normalized;
    }

    return `https://www.douyin.com/video/${noteId}`;
  }

  if (/^\d{8,}$/.test(String(noteId || ""))) {
    if (tabType === "video" || tabType === "general") {
      return `https://www.douyin.com/video/${noteId}`;
    }
  }

  return "";
}

function resolveSearchCardTitle(card, noteId, index) {
  const fromText = cleanText(
    getText(DOUYIN_DOM_PROFILE.searchResults.cards.fields.title, card),
  );
  if (fromText) {
    return fromText;
  }

  const text = cleanText(card?.innerText || "");
  const lines = text
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const candidate = lines.find(
    (line) =>
      line &&
      !/^@/.test(line) &&
      !/^·/.test(line) &&
      !/^\d{1,2}:\d{2}$/.test(line) &&
      !/^[0-9]+(?:\.[0-9]+)?[万亿kK]?$/.test(line),
  );
  if (candidate) {
    return candidate;
  }

  return `抖音搜索结果 ${noteId || index + 1}`;
}

function resolveSearchCardCover(card) {
  const imageNode = getFirstMatch(
    DOUYIN_DOM_PROFILE.searchResults.cards.fields.coverImage,
    card,
  );

  const imageUrl = normalizeUrl(
    imageNode?.getAttribute?.("src") ||
      imageNode?.src ||
      extractBackgroundImageUrl(imageNode) ||
      extractBackgroundImageUrl(card),
  );
  if (imageUrl) {
    return imageUrl;
  }

  const html = String(card?.outerHTML || "");
  const hit = html.match(/https?:[^"'\\s>]+(?:douyinpic|byteimg)[^"'\\s>]*/i);
  return normalizeUrl(hit?.[0] || "");
}

function resolveSearchCardAuthor(card) {
  const direct = cleanText(
    getText(DOUYIN_DOM_PROFILE.searchResults.cards.fields.author, card),
  ).replace(/^@/, "");
  if (direct) {
    return direct;
  }

  const text = cleanText(card?.innerText || "");
  const match = text.match(/@([^\s@·#]+)/);
  return cleanText(match?.[1] || "");
}

function resolveSearchCardPublishDate(card) {
  const direct = cleanText(
    getText(DOUYIN_DOM_PROFILE.searchResults.cards.fields.publishDate, card),
  );
  if (direct) {
    return direct.replace(/^·\s*/, "");
  }

  return extractRelativeDateHint(card);
}

function resolveSearchCardNoteType(card, noteUrl, tabType) {
  if (/\/note\//i.test(noteUrl)) {
    return "image";
  }

  const text = cleanText(card?.innerText || "");
  if (/^\d{1,2}:\d{2}/.test(text)) {
    return "video";
  }

  return tabType === "video" ? "video" : "video";
}

function detectSearchTabType() {
  const activeTab = getFirstMatch(
    DOUYIN_DOM_PROFILE.searchResults.fields.activeTab,
    document,
  );
  const dataKey = cleanText(activeTab?.getAttribute?.("data-key") || "");
  if (dataKey) {
    return dataKey.toLowerCase();
  }

  const parsed = new URL(window.location.href);
  return cleanText(parsed.searchParams.get("type") || "general").toLowerCase();
}

async function scrollDouyinSearchResults(
  searchRoot,
  {noNewContentCount = 0} = {},
) {
  const target = resolveDouyinSearchScrollTarget(searchRoot);
  const distance = resolveDouyinSearchScrollDistance(target, {
    noNewContentCount,
  });

  if (target && !isWindowScrollTarget(target)) {
    const moved = await scrollElementByDistance(target, distance);
    if (moved) {
      await wait(220);
      return;
    }
  }

  const anchor =
    getLastDouyinSearchCard(searchRoot) ||
    (searchRoot instanceof Element ? searchRoot : null);
  if (anchor instanceof Element) {
    try {
      anchor.scrollIntoView({
        block: "end",
        inline: "nearest",
        behavior: "instant",
      });
    } catch {}
    await wait(100);
  }

  await scrollWindowByDistance(distance);
  await wait(220);
}

function resolveDouyinSearchScrollTarget(searchRoot) {
  const lastCard = getLastDouyinSearchCard(searchRoot);
  const candidates = [
    lastCard?.closest?.("#waterFallScrollContainer") || null,
    lastCard?.closest?.("#search-result-container") || null,
    searchRoot instanceof Element
      ? searchRoot.closest?.("#waterFallScrollContainer, #search-result-container")
      : null,
    document.querySelector("#waterFallScrollContainer"),
    document.querySelector("#search-result-container"),
    lastCard ? findNearestScrollableAncestor(lastCard) : null,
    searchRoot instanceof Element ? findNearestScrollableAncestor(searchRoot) : null,
    document.querySelector('[data-e2e="scroll-list"]'),
    document.querySelector(".scroll-list"),
    document.querySelector("main"),
  ].filter((node, index, array) => node && array.indexOf(node) === index);

  for (const candidate of candidates) {
    if (canScrollElement(candidate)) {
      return candidate;
    }
  }

  return document.scrollingElement || document.documentElement || document.body;
}

function getLastDouyinSearchCard(searchRoot) {
  const cards = collectSearchCards(searchRoot);
  return cards.length ? cards[cards.length - 1] : null;
}

function findNearestScrollableAncestor(node) {
  let current = node?.parentElement || null;
  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    if (canScrollElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function canScrollElement(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  const height = Number(node.clientHeight || 0);
  const scrollHeight = Number(node.scrollHeight || 0);
  if (scrollHeight <= height + 24) {
    return false;
  }

  const style = window.getComputedStyle(node);
  const overflowY = String(style?.overflowY || "").toLowerCase();
  return (
    /(auto|scroll|overlay)/.test(overflowY) ||
    /waterfall|scroll/i.test(String(node.id || "")) ||
    /waterfall|scroll/i.test(String(node.className || ""))
  );
}

function isWindowScrollTarget(node) {
  return (
    node === window ||
    node === document.scrollingElement ||
    node === document.documentElement ||
    node === document.body
  );
}

function resolveDouyinSearchScrollDistance(
  target,
  {noNewContentCount = 0} = {},
) {
  const viewportHeight =
    Number(target?.clientHeight || 0) || Number(window.innerHeight || 0) || 900;
  const strongPush = Number(noNewContentCount || 0) >= 2;
  const minDistance = Math.max(480, Math.floor(viewportHeight * 0.72));
  const maxDistance = strongPush
    ? Math.max(1400, Math.floor(viewportHeight * 1.45))
    : Math.max(960, Math.floor(viewportHeight * 1.05));

  return (
    minDistance +
    Math.floor(Math.random() * Math.max(1, maxDistance - minDistance + 1))
  );
}

async function scrollElementByDistance(node, distance) {
  if (!(node instanceof Element)) {
    return false;
  }

  const beforeTop = Number(node.scrollTop || 0);
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  const nextTop = Math.min(
    beforeTop + Math.max(280, Math.floor(Number(distance) || 0)),
    maxTop,
  );

  try {
    node.scrollTo({top: nextTop, behavior: "smooth"});
  } catch {
    node.scrollTop = nextTop;
  }

  try {
    node.dispatchEvent(new Event("scroll", {bubbles: true}));
  } catch {}

  await wait(160);

  const afterTop = Number(node.scrollTop || 0);
  if (Math.abs(afterTop - beforeTop) >= 1) {
    return true;
  }

  try {
    node.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: Math.max(320, Math.floor(Number(distance) || 0)),
        bubbles: true,
        cancelable: true,
      }),
    );
  } catch {}

  await wait(120);
  return Math.abs(Number(node.scrollTop || 0) - beforeTop) >= 1;
}

async function scrollWindowByDistance(distance) {
  const beforeY = Number(window.scrollY || 0);
  const nextY = beforeY + Math.max(320, Math.floor(Number(distance) || 0));

  try {
    window.scrollTo({top: nextY, behavior: "smooth"});
  } catch {
    window.scrollTo(0, nextY);
  }

  await wait(180);
  return Math.abs(Number(window.scrollY || 0) - beforeY) >= 1;
}

function resolveMetricText(card, selectors) {
  const direct = cleanText(getText(selectors, card));
  if (/[0-9万亿kK]/.test(direct)) {
    return direct;
  }

  const spans = Array.from(card.querySelectorAll("span, strong, em"));
  const metricNode = spans.find((node) =>
    /[0-9]/.test(cleanText(node.textContent || "")),
  );
  return cleanText(metricNode?.textContent || "");
}

function resolveSearchCardLikes(card) {
  const directLikes = parseCount(
    resolveMetricText(
      card,
      DOUYIN_DOM_PROFILE.searchResults.cards.fields.likes,
    ),
  );
  if (directLikes > 0) {
    return directLikes;
  }

  return extractFallbackLikeCountFromCard(card);
}

function extractRelativeDateHint(card) {
  const text = cleanText(card?.innerText || "");
  const match = text.match(
    /(\d+\s*(?:分钟前|小时前|天前)|昨天|前天|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})/,
  );
  return match?.[1] || "";
}

function parseCount(text) {
  const normalized = String(text || "").replace(/[,，\s]/g, "");
  if (!normalized) return 0;

  const match = normalized.match(/(\d+(?:\.\d+)?)(亿|万|[kK])?/);
  if (!match) return 0;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;

  const unit = match[2] || "";
  if (unit === "亿") return Math.round(value * 100000000);
  if (unit === "万") return Math.round(value * 10000);
  if (/^[kK]$/.test(unit)) return Math.round(value * 1000);
  return Math.round(value);
}

function extractFallbackLikeCountFromCard(card) {
  const text = cleanText(card?.innerText || "");
  if (!text) return 0;

  const lines = text
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const count = extractLikeCountFromText(lines[index]);
    if (count > 0) {
      return count;
    }
  }

  return 0;
}

function extractLikeCountFromText(text) {
  const normalized = cleanText(text);
  if (!normalized) return 0;

  const labeledMatch = normalized.match(
    /(?:赞|点赞)[：:\s]*([0-9]+(?:\.[0-9]+)?(?:亿|万|[kK])?)/i,
  );
  if (labeledMatch?.[1]) {
    return parseCount(labeledMatch[1]);
  }

  if (isNonMetricLikeText(normalized)) {
    return 0;
  }

  if (/^[0-9]+(?:\.[0-9]+)?(?:亿|万|[kK])?$/.test(normalized)) {
    return parseCount(normalized);
  }

  return 0;
}

function isNonMetricLikeText(text) {
  return (
    /^\d{1,2}:\d{2}$/.test(text) ||
    /^\d{1,2}[-/.月]\d{1,2}(?:日)?$/.test(text) ||
    /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?$/.test(text) ||
    /^(?:刚刚|昨天|\d+分钟前|\d+小时前|\d+天前)$/.test(text)
  );
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

function normalizeKeyword(value) {
  return cleanText(String(value || "").replace(/^#/, ""));
}

function normalizeNonNegativeInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded >= 0 ? rounded : fallback;
}

function normalizePositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded > 0 ? rounded : fallback;
}

function normalizeUrl(raw) {
  const text = String(raw || "")
    .replace(/&amp;/g, "&")
    .trim();
  if (!text) return "";

  if (text.startsWith("//")) {
    return `https:${text}`;
  }

  try {
    return new URL(text, "https://www.douyin.com").toString();
  } catch {
    return text;
  }
}

function extractBackgroundImageUrl(node) {
  if (!node) return "";

  const styleValue =
    node.getAttribute?.("style") || node.style?.backgroundImage || "";
  const match = String(styleValue).match(
    /background-image\s*:\s*url\((['"]?)(.*?)\1\)/i,
  );
  if (match?.[2]) {
    return match[2];
  }

  const computed = globalThis.getComputedStyle?.(node)?.backgroundImage || "";
  const computedMatch = String(computed).match(/url\((['"]?)(.*?)\1\)/i);
  return computedMatch?.[2] || "";
}

function normalizeSearchDate(raw) {
  const text = cleanText(String(raw || "").replace(/^·\s*/, ""));
  if (!text) return "";

  const fullCn = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (fullCn) {
    return `${fullCn[1]}-${String(fullCn[2]).padStart(2, "0")}-${String(fullCn[3]).padStart(2, "0")}`;
  }

  return normalizeDate(text);
}
