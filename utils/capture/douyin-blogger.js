/**
 * Douyin Blogger Capture Module
 * Profile-first DOM capture for blogger profile and blogger works.
 */

import {PAGE_TYPE, SYNC_TYPE, DEFAULT_CONFIG} from "../constants.js";
import {
  parseInteractionCount,
  cleanText,
  extractBloggerId,
  extractNoteId,
} from "../helpers.js";
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

export async function captureDouyinBloggerProfile() {
  const captureStartedAt = new Date().toISOString();

  try {
    await wait(1000);
    assertNoCaptchaPage();
    await ensureSectionReady(DOUYIN_DOM_PROFILE, "bloggerProfile");

    const profileRoot = resolveSectionRoot(
      DOUYIN_DOM_PROFILE,
      "bloggerProfile",
    );
    const profileContext = resolveBloggerProfileContext(profileRoot);
    const infoRoot = profileContext.infoRoot || profileRoot;
    const bloggerId = resolveBloggerId(infoRoot);
    if (!bloggerId) {
      throw new Error("无法从页面识别抖音博主 ID");
    }

    const name = extractBloggerName(infoRoot);
    const avatar = extractBloggerAvatar(profileContext);
    const description = extractBloggerDescription(profileContext);
    const metrics = extractBloggerMetrics(infoRoot);
    const ipLocation = extractIpLocation();
    const accountType = extractBloggerAccountType(infoRoot);
    const douyinId = extractDouyinId();

    const hasMetricSignal =
      metrics.followingCount > 0 ||
      metrics.followersCount > 0 ||
      metrics.likedAndCollectedCount > 0;

    const payload = {
      bloggerName: name,
      bloggerId,
      douyinId,
      bloggerUrl: window.location.href,
      avatarUrl: avatar,
      description,
      followingCount: metrics.followingCount,
      followersCount: metrics.followersCount,
      likedAndCollectedCount: metrics.likedAndCollectedCount,
      bloggerFollowersCount: metrics.followersCount,
      bloggerLikedAndCollectedCount: metrics.likedAndCollectedCount,
      bloggerProfileUrl: window.location.href,
      bloggerMetricsCaptureStatus: hasMetricSignal ? "done" : "failed",
      bloggerMetricsCaptureError: hasMetricSignal ? "" : "未识别到博主指标区域",
      bloggerAccountType: accountType,
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
    console.error("[Douyin][BloggerProfile] Capture failed:", error);
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

export async function captureDouyinBloggerNotes({
  onProgress = null,
  profileMetrics = null,
  maxScrollTimes = 50,
  minLikes = 0,
  maxDetectedItems = null,
  maxItems = null,
  keywordFilter = "",
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
    await ensureSectionReady(DOUYIN_DOM_PROFILE, "bloggerProfile");

    const profileRoot = resolveSectionRoot(
      DOUYIN_DOM_PROFILE,
      "bloggerProfile",
    );
    const profileContext = resolveBloggerProfileContext(profileRoot);
    const infoRoot = profileContext.infoRoot || profileRoot;
    const notesRoot = resolveBloggerNotesRoot(profileRoot);
    const bloggerId = resolveBloggerId(infoRoot);
    const douyinId = extractDouyinId();
    if (!bloggerId) {
      throw new Error("无法从页面识别抖音博主 ID");
    }

    const bloggerName = extractBloggerName(infoRoot);
    const pageMetrics = extractBloggerMetrics(infoRoot);
    const fallbackMetrics = normalizeMetricsFallback(profileMetrics);
    const resolvedMetrics = {
      followersCount:
        pageMetrics.followersCount || fallbackMetrics.followersCount || 0,
      likedAndCollectedCount:
        pageMetrics.likedAndCollectedCount ||
        fallbackMetrics.likedAndCollectedCount ||
        0,
      accountType: pageMetrics.accountType || fallbackMetrics.accountType || "",
      captureStatus:
        pageMetrics.followersCount > 0 || pageMetrics.likedAndCollectedCount > 0
          ? "done"
          : fallbackMetrics.captureStatus || "failed",
      captureError:
        pageMetrics.followersCount > 0 || pageMetrics.likedAndCollectedCount > 0
          ? ""
          : fallbackMetrics.captureError || "未识别到博主指标区域",
      profileUrl: window.location.href,
    };

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
    const normalizedStallTimeoutMs = normalizePositiveInteger(
      stallTimeoutMs,
      3000,
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
    let stallRounds = 0;
    const requiredStallRounds = 3;

    const emitProgress = (progress = {}) => {
      if (!onProgress) return;
      onProgress({
        ...progress,
        detectedCount: progressStats.detectedCount,
        qualifiedCount: progressStats.qualifiedCount,
        filteredCount: progressStats.filteredCount,
        minLikes: normalizedMinLikes,
        maxDetectedItems: normalizedMaxDetectedItems,
      });
    };

    const collectDetectedNotes = () => {
      mergeNotesIntoMap(
        noteMap,
        extractDouyinProfileNoteCards(notesRoot, bloggerName),
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
      noNewContentThreshold: DEFAULT_CONFIG.NO_NEW_CONTENT_THRESHOLD,
      maxDurationMs: normalizedMaxDurationMs,
      waitMinMs: waitRange.min,
      waitMaxMs: waitRange.max,
      stopWhen: ({currentContentCount}) => {
        if (currentContentCount >= normalizedMaxDetectedItems) {
          return {
            stop: true,
            reason: "max_items",
            message: `达到抖音博主作品加载上限（${currentContentCount}/${normalizedMaxDetectedItems}）`,
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
          stallRounds >= requiredStallRounds
        ) {
          return {
            stop: true,
            reason: "stall_timeout",
            message: `连续 ${Math.floor(normalizedStallTimeoutMs / 1000)} 秒无新增，结束滚动`,
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
    const parsedKeywords = parseKeywordFilter(keywordFilter);
    const likesFiltered = allItems.filter(
      (item) => Number(item.likes || 0) >= normalizedMinLikes,
    );
    const filteredItems = parsedKeywords.length
      ? likesFiltered.filter((item) =>
          matchesKeywordFilter(item.title || "", parsedKeywords),
        )
      : likesFiltered;

    const items = filteredItems
      .slice(0, normalizedMaxDetectedItems)
      .map((item) => ({
        ...item,
        bloggerFollowersCount: resolvedMetrics.followersCount,
        bloggerLikedAndCollectedCount: resolvedMetrics.likedAndCollectedCount,
        bloggerProfileUrl: resolvedMetrics.profileUrl,
        bloggerMetricsCaptureStatus: resolvedMetrics.captureStatus,
        bloggerMetricsCaptureError: resolvedMetrics.captureError,
        bloggerAccountType: resolvedMetrics.accountType,
      }));

    const payload = {
      bloggerName,
      bloggerId,
      douyinId,
      bloggerUrl: window.location.href,
      bloggerFollowersCount: resolvedMetrics.followersCount,
      bloggerLikedAndCollectedCount: resolvedMetrics.likedAndCollectedCount,
      bloggerProfileUrl: resolvedMetrics.profileUrl,
      bloggerMetricsCaptureStatus: resolvedMetrics.captureStatus,
      bloggerMetricsCaptureError: resolvedMetrics.captureError,
      bloggerAccountType: resolvedMetrics.accountType,
      totalCount: items.length,
      rawTotalCount: allItems.length,
      minLikes: normalizedMinLikes,
      maxDetectedItems: normalizedMaxDetectedItems,
      keywordFilter: keywordFilter || "",
      filteredCount: items.length,
      filteredBeforeLimitCount: filteredItems.length,
      items,
      captureTimestamp: Date.now(),
    };

    return {
      ok: true,
      type: SYNC_TYPE.BLOGGER_NOTES,
      data: payload,
      meta: {
        pageType: PAGE_TYPE.BLOGGER_PROFILE,
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
    console.error("[Douyin][BloggerNotes] Capture failed:", error);

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

function assertNoCaptchaPage() {
  const title = cleanText(document.title || "");
  const bodyText = cleanText(document.body?.innerText || "");
  if (/验证码中间页/i.test(title) || /请完成下列验证后继续:/i.test(bodyText)) {
    throw new Error("当前页面触发抖音验证码或风险中间页");
  }
}

function resolveBloggerId(profileRoot) {
  const fromUrl = extractBloggerId(window.location.href);
  if (fromUrl) return fromUrl;

  const href = getAttribute(
    DOUYIN_DOM_PROFILE.bloggerProfile.fields.bloggerLink,
    "href",
    profileRoot,
    {fallbackContext: document},
  );
  return extractBloggerId(href) || "";
}

function resolveBloggerProfileContext(profileRoot) {
  const detailRoot =
    resolveScopedNode(profileRoot, '[data-e2e="user-detail"]') ||
    resolveScopedNode(document, '[data-e2e="user-detail"]') ||
    profileRoot ||
    document.body;

  const infoRoot =
    resolveScopedNode(profileRoot, '[data-e2e="user-info"]') ||
    resolveScopedNode(detailRoot, '[data-e2e="user-info"]') ||
    profileRoot ||
    detailRoot;

  return {
    detailRoot,
    infoRoot,
    headerRoot: infoRoot?.parentElement || detailRoot,
  };
}

function resolveScopedNode(root, selector) {
  if (!root || !selector) return null;

  try {
    if (typeof root.matches === "function" && root.matches(selector)) {
      return root;
    }
  } catch {
    // noop
  }

  try {
    if (typeof root.closest === "function") {
      const closestMatch = root.closest(selector);
      if (closestMatch) {
        return closestMatch;
      }
    }
  } catch {
    // noop
  }

  try {
    if (typeof root.querySelector === "function") {
      return root.querySelector(selector);
    }
  } catch {
    return null;
  }

  return null;
}

function extractBloggerName(profileRoot) {
  const text = cleanText(
    getText(DOUYIN_DOM_PROFILE.bloggerProfile.fields.name, profileRoot, {
      fallbackContext: document,
    }),
  );
  if (text) {
    return text.replace(/^@/, "");
  }

  return cleanText(document.title.replace(/\s*-\s*抖音.*$/i, ""));
}

function extractBloggerAvatar(profileContext) {
  const detailRoot = profileContext?.detailRoot || document;
  const headerRoot = profileContext?.headerRoot || detailRoot;
  const infoRoot = profileContext?.infoRoot || null;
  const candidate = findBloggerAvatarCandidate(headerRoot, infoRoot);
  if (candidate) {
    return normalizeUrl(candidate.currentSrc || candidate.src || candidate.getAttribute?.("src") || "");
  }

  return normalizeUrl(
    getAttribute(
      DOUYIN_DOM_PROFILE.bloggerProfile.fields.avatar,
      "src",
      detailRoot,
    ),
  );
}

function findBloggerAvatarCandidate(searchRoot, infoRoot = null) {
  const root = searchRoot || document;
  const candidates = Array.from(
    root.querySelectorAll?.("img[src], img[data-src]") || [],
  )
    .map((node) => ({
      node,
      score: scoreBloggerAvatarCandidate(node, searchRoot, infoRoot),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.node || null;
}

function scoreBloggerAvatarCandidate(node, searchRoot, infoRoot) {
  if (!node || typeof node.getAttribute !== "function") {
    return -1000;
  }

  const src = normalizeUrl(node.currentSrc || node.src || node.getAttribute("src") || node.getAttribute("data-src") || "");
  const alt = cleanText(node.getAttribute("alt") || "");
  const className = cleanText(node.className || "");
  const rect =
    typeof node.getBoundingClientRect === "function"
      ? node.getBoundingClientRect()
      : {width: 0, height: 0};
  const width = Number(rect.width || 0);
  const height = Number(rect.height || 0);
  const size = Math.max(width, height);

  if (!src) return -1000;
  if (/twemoji|emoji|emblem|icon/i.test(src)) return -1000;
  if (alt && alt.length <= 2 && !/头像$/.test(alt)) return -800;

  let score = 0;

  if (/头像$/.test(alt)) score += 140;
  if (/aweme-avatar|avatar/i.test(src)) score += 90;
  if (/avatar/i.test(className)) score += 30;

  if (size >= 72) {
    score += 80;
  } else if (size >= 48) {
    score += 40;
  } else if (size > 0 && size < 40) {
    score -= 120;
  }

  if (width > 0 && height > 0 && Math.abs(width - height) <= 16) {
    score += 20;
  }

  if (searchRoot?.contains?.(node)) score += 30;
  if (infoRoot?.contains?.(node)) score -= 80;

  return score;
}

function extractBloggerDescription(profileContext) {
  const infoRoot = profileContext?.infoRoot || document;
  const directNode = getFirstMatch(
    DOUYIN_DOM_PROFILE.bloggerProfile.fields.description,
    infoRoot,
  );
  const directText = sanitizeBloggerDescriptionText(extractNodeText(directNode));
  if (directText) {
    return directText;
  }

  const fallbackNode = findBloggerDescriptionNode(infoRoot);
  const fallbackText = sanitizeBloggerDescriptionText(extractNodeText(fallbackNode));
  if (fallbackText) {
    return fallbackText;
  }

  return extractDescriptionFromProfileText(infoRoot);
}

function findBloggerDescriptionNode(infoRoot) {
  const children = Array.from(infoRoot?.children || []);
  const markerIndex = children.findIndex((node) =>
    /抖音号[:：]|IP属地[:：]/.test(extractNodeText(node)),
  );

  if (markerIndex >= 0) {
    for (let index = markerIndex + 1; index < children.length; index += 1) {
      const text = sanitizeBloggerDescriptionText(extractNodeText(children[index]));
      if (isLikelyBloggerDescriptionText(text)) {
        return children[index];
      }
    }
  }

  return (
    [...children]
      .reverse()
      .find((node) => {
        const text = sanitizeBloggerDescriptionText(extractNodeText(node));
        return isLikelyBloggerDescriptionText(text);
      }) || null
  );
}

function extractNodeText(node) {
  if (!node) return "";

  const clone =
    typeof node.cloneNode === "function" ? node.cloneNode(true) : null;
  const target = clone || node;

  if (typeof target.querySelectorAll === "function") {
    target
      .querySelectorAll('button, [role="button"], [aria-haspopup="menu"]')
      .forEach((element) => element.remove());

    Array.from(target.children || [])
      .filter((element) => /^更多$/.test(cleanText(element.textContent || "")))
      .forEach((element) => element.remove());
  }

  return cleanText(target.innerText || target.textContent || "");
}

function sanitizeBloggerDescriptionText(text) {
  const normalized = cleanText(text);
  if (!normalized) return "";

  const withoutUi = normalized
    .replace(/\s*更多\s*$/u, "")
    .replace(/\s*分享主页\s*$/u, "")
    .replace(/\s*关注\s*私信\s*$/u, "")
    .trim();

  return isLikelyBloggerDescriptionText(withoutUi) ? withoutUi : "";
}

function extractDescriptionFromProfileText(infoRoot) {
  const rawLines = String(infoRoot?.innerText || "")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const lines = rawLines
    .map((line) => sanitizeBloggerDescriptionText(line))
    .filter(Boolean);

  const markerIndex = rawLines.findIndex((line) => /抖音号[:：]|IP属地[:：]/.test(line));
  if (markerIndex >= 0) {
    for (let index = markerIndex + 1; index < rawLines.length; index += 1) {
      const candidate = sanitizeBloggerDescriptionText(rawLines[index]);
      if (isLikelyBloggerDescriptionText(candidate)) {
        return candidate;
      }
    }
  }

  return lines.find((line) => isLikelyBloggerDescriptionText(line)) || "";
}

function isLikelyBloggerDescriptionText(text) {
  const normalized = cleanText(text);
  if (!normalized) return false;
  if (/^(关注|粉丝|获赞|更多|分享主页|私信|作品|推荐|喜欢|合集|短剧)$/u.test(normalized)) {
    return false;
  }
  if (/^(抖音号[:：]|IP属地[:：])/u.test(normalized)) {
    return false;
  }
  if (/^[0-9]+(?:\.[0-9]+)?(?:万|亿|[kK])?$/u.test(normalized)) {
    return false;
  }

  return true;
}

function extractBloggerMetrics(profileRoot) {
  const followingCount = parseCount(
    getText(
      DOUYIN_DOM_PROFILE.bloggerProfile.fields.followingCount,
      profileRoot,
      {
        fallbackContext: document,
      },
    ),
  );
  const followersCount = parseCount(
    getText(
      DOUYIN_DOM_PROFILE.bloggerProfile.fields.followersCount,
      profileRoot,
      {
        fallbackContext: document,
      },
    ),
  );
  const likedAndCollectedCount = parseCount(
    getText(
      DOUYIN_DOM_PROFILE.bloggerProfile.fields.likedAndCollectedCount,
      profileRoot,
      {
        fallbackContext: document,
      },
    ),
  );

  if (followingCount || followersCount || likedAndCollectedCount) {
    return {
      followingCount,
      followersCount,
      likedAndCollectedCount,
      accountType: extractBloggerAccountType(profileRoot),
    };
  }

  const text = cleanText(document.body?.innerText || "");
  return {
    followingCount: extractMetricByLabel(text, "关注"),
    followersCount: extractMetricByLabel(text, "粉丝"),
    likedAndCollectedCount: extractMetricByLabel(text, "获赞"),
    accountType: extractBloggerAccountType(profileRoot),
  };
}

function extractMetricByLabel(text, label) {
  const normalized = String(text || "");
  if (!normalized) return 0;

  const match = normalized.match(
    new RegExp(`${label}\\s*([0-9]+(?:\\.[0-9]+)?(?:万|亿|[kK])?)`),
  );
  if (!match?.[1]) return 0;

  return parseCount(match[1]);
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

  return parseInteractionCount(match[1]);
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

function extractIpLocation() {
  const text = cleanText(document.body?.innerText || "");
  const match = text.match(/IP属地[:：]?\s*([^\s|｜]+)/i);
  return match?.[1] ? cleanText(match[1]) : "";
}

function extractDouyinId() {
  const text = cleanText(document.body?.innerText || "");
  const match = text.match(/抖音号[:：]?\s*([a-zA-Z0-9_-]+)/i);
  return match?.[1] ? cleanText(match[1]) : "";
}

function extractBloggerAccountType(profileRoot) {
  const badgeText = cleanText(
    getText(DOUYIN_DOM_PROFILE.bloggerProfile.fields.accountType, profileRoot, {
      fallbackContext: document,
    }),
  );

  if (/商家|企业|品牌|机构/i.test(badgeText)) return "company";
  if (/认证|达人|红v/i.test(badgeText)) return "famous";
  return "";
}

function resolveBloggerNotesRoot(profileRoot) {
  const selectors = DOUYIN_DOM_PROFILE.bloggerProfile.notesList.rootSelectors;
  return (
    getFirstMatch(selectors, document) ||
    getFirstMatch(selectors, profileRoot) ||
    document.querySelector("main") ||
    document.body
  );
}

function extractDouyinProfileNoteCards(notesRoot, bloggerName = "") {
  const linkNodes = Array.from(
    (notesRoot || document).querySelectorAll(
      DOUYIN_DOM_PROFILE.bloggerProfile.notesList.cardSelectors.join(", "),
    ),
  );

  const notes = [];
  const dedupe = new Set();

  linkNodes.forEach((link) => {
    const noteUrl = normalizeUrl(link.getAttribute("href") || link.href || "");
    if (!noteUrl) return;

    const noteId = extractNoteId(noteUrl);
    if (!noteId) return;

    const dedupeKey = `${noteId}-${noteUrl}`;
    if (dedupe.has(dedupeKey)) return;
    dedupe.add(dedupeKey);

    const card = link.closest("a, article, li, div") || link;
    const title = resolveCardTitle(card, noteId);
    const coverImage = normalizeUrl(
      getAttribute(
        DOUYIN_DOM_PROFILE.bloggerProfile.notesList.fields.coverImage,
        "src",
        card,
      ),
    );
    const cardMedia = collectMediaUrlsFromElement(card);
    const likes = resolveProfileCardLikes(card);
    const noteType = /\/note\//i.test(noteUrl) ? "image" : "video";

    notes.push({
      noteId,
      url: noteUrl,
      noteUrl,
      detailPageUrl: noteUrl,
      title,
      coverImageUrl: coverImage,
      author: bloggerName,
      likes,
      noteType,
      domLocator: buildDomLocator(card),
      domMatchHints: buildReverseMatchHints({
        noteId,
        noteUrl,
        coverImageUrl: coverImage,
        videoUrl: cardMedia.videos[0] || "",
        title,
        author: bloggerName,
      }),
      cardImageCandidates: cardMedia.images,
      cardVideoCandidates: cardMedia.videos,
      captureTimestamp: Date.now(),
    });
  });

  return notes;
}

function resolveCardTitle(card, noteId) {
  const fromText = cleanText(
    getText(DOUYIN_DOM_PROFILE.bloggerProfile.notesList.fields.title, card),
  );
  if (fromText) {
    return fromText;
  }

  const imageAlt = cleanText(
    getAttribute(
      DOUYIN_DOM_PROFILE.bloggerProfile.notesList.fields.title,
      "alt",
      card,
    ),
  );
  if (imageAlt) {
    return imageAlt;
  }

  return `抖音作品 ${noteId}`;
}

function resolveProfileCardLikes(card) {
  const directLikes = parseCount(
    getText(DOUYIN_DOM_PROFILE.bloggerProfile.notesList.fields.likes, card),
  );
  if (directLikes > 0) {
    return directLikes;
  }

  return extractFallbackLikeCountFromCard(card);
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

function normalizeMetricsFallback(input) {
  const safe = input && typeof input === "object" ? input : {};

  const followersCount = normalizeNonNegativeInteger(
    safe.bloggerFollowersCount ?? safe.followersCount,
    0,
  );
  const likedAndCollectedCount = normalizeNonNegativeInteger(
    safe.bloggerLikedAndCollectedCount ?? safe.likedAndCollectedCount,
    0,
  );

  return {
    followersCount,
    likedAndCollectedCount,
    accountType: String(
      safe.bloggerAccountType || safe.accountType || "",
    ).trim(),
    captureStatus: followersCount || likedAndCollectedCount ? "done" : "failed",
    captureError:
      followersCount || likedAndCollectedCount ? "" : "未识别到博主指标区域",
  };
}

function normalizeUrl(raw) {
  const text = String(raw || "").trim();
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
