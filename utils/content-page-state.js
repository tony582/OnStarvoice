import {
  detectPageType,
  detectPlatformFromUrl,
} from "./platform/page-routing.js";
import {PAGE_TYPE} from "./constants.js";
import {NOTE_DETAIL_SELECTORS} from "./selectors.js";

export function startContentPageStateReporting({
  sendMessage,
  debounceMs = 80,
  initialRetryDelaysMs = [250, 1000],
} = {}) {
  if (typeof sendMessage !== "function") {
    throw new Error("sendMessage is required");
  }

  let lastReportedSignature = "";

  const reportPageState = (action, {force = false} = {}) => {
    const url = window.location.href;
    const platform = detectPlatformFromUrl(url);
    const pageType = detectPageType(url);
    const detailReadiness = resolveDetailReadiness({platform, pageType});
    const signature = [
      url,
      platform,
      pageType,
      detailReadiness.detailReady,
      detailReadiness.detailReadyReason,
    ].join("|");
    if (!force && signature === lastReportedSignature) {
      return;
    }
    lastReportedSignature = signature;
    sendMessage({
      action,
      url,
      platform,
      pageType,
      ...detailReadiness,
    });
  };

  let lastUrl = window.location.href;
  let pendingTimer = null;

  const flushUrlChange = () => {
    pendingTimer = null;
    const url = window.location.href;
    if (url === lastUrl) {
      reportPageState("pageStateChanged");
      return;
    }

    lastUrl = url;
    reportPageState("pageChanged", {force: true});
  };

  const notifyUrlChanged = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(flushUrlChange, debounceMs);
  };

  reportPageState("pageLoaded", {force: true});
  initialRetryDelaysMs.forEach((delayMs) => {
    setTimeout(() => {
      reportPageState("pageLoaded", {force: true});
    }, delayMs);
  });

  window.addEventListener(
    "load",
    () => {
      reportPageState("pageLoaded", {force: true});
    },
    {once: true},
  );

  new MutationObserver(() => {
    notifyUrlChanged();
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-busy"],
  });

  window.addEventListener("popstate", notifyUrlChanged);
  window.addEventListener("hashchange", notifyUrlChanged);

  const rawPushState = history.pushState;
  history.pushState = function patchedPushState(...args) {
    const result = rawPushState.apply(this, args);
    notifyUrlChanged();
    return result;
  };

  const rawReplaceState = history.replaceState;
  history.replaceState = function patchedReplaceState(...args) {
    const result = rawReplaceState.apply(this, args);
    notifyUrlChanged();
    return result;
  };
}

function resolveDetailReadiness({platform, pageType} = {}) {
  if (pageType !== PAGE_TYPE.NOTE_DETAIL) {
    return {
      detailReady: null,
      detailReadyReason: "not_note_detail",
      detailReadyCheckedAt: Date.now(),
    };
  }

  if (platform === "douyin") {
    return resolveDouyinDetailReadiness();
  }
  if (platform === "xiaohongshu") {
    return resolveXiaohongshuDetailReadiness();
  }

  if (hasVisibleLoadingSignal()) {
    return {
      detailReady: false,
      detailReadyReason: "loading",
      detailReadyCheckedAt: Date.now(),
    };
  }

  return {
    detailReady: true,
    detailReadyReason: "ready",
    detailReadyCheckedAt: Date.now(),
  };
}

function resolveXiaohongshuDetailReadiness() {
  const hasLoading = hasVisibleLoadingSignal();
  const hasTitle =
    hasValidVisibleXiaohongshuText([
      ...NOTE_DETAIL_SELECTORS.title,
      "#detail-title",
      '[id*="detail-title"]',
      ".note-content h1",
      ".note-content h2",
      ".interaction-container h1",
      ".interaction-container h2",
      "main h1",
      "main h2",
      "article h1",
      "article h2",
    ]) || hasValidXiaohongshuDocumentTitle();
  const hasContent = hasValidVisibleXiaohongshuText([
    ...NOTE_DETAIL_SELECTORS.content,
    "#detail-desc",
    '[id*="detail-desc"]',
    ".note-content .desc",
    ".note-content .content",
    ".interaction-container .desc",
    ".interaction-container .content",
    '.interaction-container [class*="desc"]',
    '.interaction-container [class*="Desc"]',
    "article .desc",
    "article .content",
  ]);
  const hasAuthor = hasVisibleElement([
    ...NOTE_DETAIL_SELECTORS.author.container,
    ...NOTE_DETAIL_SELECTORS.author.name,
    'a[href*="/user/profile/"]',
    'a[href*="/user/"]',
    ".username",
    ".user-name",
    ".nickname",
  ]);
  const hasMedia = hasVisibleElement([
    ...NOTE_DETAIL_SELECTORS.images,
    ...NOTE_DETAIL_SELECTORS.video,
    ".note-slider .swiper-slide",
    ".note-slider img",
    ".swiper-slide img",
    ".swiper img",
    'img[src*="xhscdn"]',
    'img[src*="xiaohongshu"]',
    "video",
    ".xgplayer",
  ]);
  const hasEngagement = hasVisibleElement([
    ...NOTE_DETAIL_SELECTORS.engageBar.container,
    ...NOTE_DETAIL_SELECTORS.engageBar.likesCount,
    ...NOTE_DETAIL_SELECTORS.engageBar.collectsCount,
    ...NOTE_DETAIL_SELECTORS.engageBar.commentsCount,
    ".like-wrapper",
    ".collect-wrapper",
    ".chat-wrapper",
    ".comment-wrapper",
    '[aria-label*="点赞"]',
    '[aria-label*="收藏"]',
    '[aria-label*="评论"]',
  ]);

  const ready = Boolean(
    (hasTitle || hasContent) && (hasAuthor || hasMedia || hasEngagement),
  );

  return {
    detailReady: ready,
    detailReadyReason: ready
      ? "ready"
      : hasLoading
        ? "loading"
        : "missing_detail_content",
    detailReadyCheckedAt: Date.now(),
  };
}

function resolveDouyinDetailReadiness() {
  const hasLoading = hasVisibleLoadingSignal();
  const hasTitle =
    hasValidVisibleDouyinText([
      '[data-e2e="video-desc"]',
      '[data-e2e="video-info"] [class*="title"]',
      '[data-e2e="video-info"] [class*="Title"]',
      ".video-info-detail .title",
      '.video-info-detail [class*="title"]',
      ".work-desc",
      ".video-desc",
      '[class*="video-desc"]',
      '[class*="VideoDesc"]',
      "main h1",
      "main h2",
      "h1",
      "h2",
    ]) || hasValidDouyinDocumentTitle();
  const hasContent = hasValidVisibleDouyinText([
    '[data-e2e="video-desc"]',
    ".video-info-detail .title",
    ".video-info-detail p",
    ".video-info-detail div",
    '[class*="video-desc"]',
    '[class*="VideoDesc"]',
    "main p",
    'main [class*="desc"]',
    'main [class*="Desc"]',
  ]);
  const hasAuthor = hasVisibleElement([
    '[data-e2e="feed-video-nickname"]',
    '[data-e2e="video-info"] a[href*="/user/"]',
    '.video-info-detail a[href*="/user/"]',
    '[data-e2e="video-avatar"][href*="/user/"]',
    'a[href*="/user/"]',
  ]);
  const hasMedia = hasVisibleElement([
    "video",
    ".xgplayer",
    '[class*="xgplayer"]',
    '[class*="player"] video',
    '[class*="Player"] video',
    ".swiper-slide img",
    '[data-e2e="video-info"] img[src]',
    'main img[src*="douyinpic.com"]',
    'main img[src*="byteimg.com"]',
  ]);
  const hasEngagement = hasVisibleElement([
    '[data-e2e="video-player-digg"]',
    '[data-e2e="like-icon"]',
    '[data-e2e="feed-like-icon"]',
    '[data-e2e="feed-comment-icon"]',
    '[data-e2e="comment-icon"]',
    '[data-e2e="video-player-collect"]',
    '[data-e2e="collect-icon"]',
    '[data-e2e="feed-collect-icon"]',
    '[data-e2e="video-player-share"]',
    '[data-e2e="feed-share-icon"]',
    '[data-e2e="share-icon"]',
    '[aria-label*="评论"]',
    '[aria-label*="点赞"]',
    '[aria-label*="收藏"]',
    '[aria-label*="分享"]',
  ]);

  const ready = Boolean(
    (hasMedia && (hasTitle || hasContent || hasEngagement || hasAuthor)) ||
      ((hasTitle || hasContent) && (hasEngagement || hasAuthor)),
  );

  return {
    detailReady: ready,
    detailReadyReason: ready
      ? "ready"
      : hasLoading
        ? "loading"
        : "missing_detail_content",
    detailReadyCheckedAt: Date.now(),
  };
}

function hasVisibleLoadingSignal() {
  const loadingSelectors = [
    ".loading",
    ".spinner",
    ".loading-indicator",
    "[data-v-loading]",
    '[aria-busy="true"]',
    '[class*="loading"]',
    '[class*="Loading"]',
  ];
  if (hasVisibleElement(loadingSelectors)) {
    return true;
  }

  const candidates = document.querySelectorAll("div, span, p, section");
  return Array.from(candidates).some((node) => {
    if (!isVisibleElement(node)) {
      return false;
    }
    const text = normalizeText(node.textContent);
    return /^(加载中|正在加载|加载中\.\.\.)$/.test(text);
  });
}

function hasValidVisibleDouyinText(selectors) {
  return queryVisibleElements(selectors).some((element) =>
    isLikelyDouyinWorkText(element.textContent),
  );
}

function hasValidVisibleXiaohongshuText(selectors) {
  return queryVisibleElements(selectors).some((element) =>
    isLikelyXiaohongshuWorkText(element.textContent),
  );
}

function hasValidDouyinDocumentTitle() {
  const title = normalizeText(document.title.replace(/\s*-\s*抖音.*$/i, ""));
  return isLikelyDouyinWorkText(title);
}

function hasValidXiaohongshuDocumentTitle() {
  const title = normalizeText(document.title.replace(/\s*-\s*小红书.*$/i, ""));
  return isLikelyXiaohongshuWorkText(title);
}

function isLikelyDouyinWorkText(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (text.length < 2 || text.length > 240) return false;
  if (/^\d{1,2}:\d{2}$/.test(text)) return false;
  if (/^[0-9]+(?:\.[0-9]+)?[万亿kK]?$/.test(text)) return false;
  if (
    /^(?:抖音|精选|搜索|关注|已关注|私信|投稿|通知|客服|下载|下载客户端|桌面快捷访问)$/.test(
      text,
    )
  ) {
    return false;
  }
  if (/^(?:点赞|评论|收藏|转发|分享|全部评论|评论区|暂无评论|相关推荐|播放中)$/.test(text)) {
    return false;
  }
  if (/粉丝\s*\d/.test(text) && /获赞\s*\d/.test(text)) {
    return false;
  }
  const compact = text.replace(/\s+/g, "");
  if (/粉丝\d+(?:\.\d+)?[万亿kK]?获赞\d+(?:\.\d+)?[万亿kK]?/.test(compact)) {
    return false;
  }
  if (
    /^(?:暂停|播放|重播)(?:进入全屏|退出全屏|网页全屏)/.test(compact) &&
    /(?:截图|字幕|清晰度|倍速|拖动视频)/.test(compact)
  ) {
    return false;
  }
  return true;
}

function isLikelyXiaohongshuWorkText(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (text.length < 2 || text.length > 260) return false;
  if (/^\d{1,2}:\d{2}$/.test(text)) return false;
  if (/^[0-9]+(?:\.[0-9]+)?[万亿kK]?$/.test(text)) return false;
  if (/^(?:小红书|首页|发现|搜索|消息|我|关注|登录|立即登录|发布|创作中心)$/.test(text)) {
    return false;
  }
  if (/^(?:点赞|评论|收藏|转发|分享|赞|回复|全部评论|展开|收起|加载中|正在加载)$/.test(text)) {
    return false;
  }
  if (/^(?:请先登录|打开小红书查看更多|说点什么|留下你的评论)$/.test(text)) {
    return false;
  }
  return true;
}

function hasVisibleElement(selectors) {
  return queryVisibleElements(selectors).length > 0;
}

function queryVisibleElements(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const results = [];
  for (const selector of list) {
    try {
      document.querySelectorAll(selector).forEach((element) => {
        if (isVisibleElement(element)) {
          results.push(element);
        }
      });
    } catch {
      // Ignore selectors unsupported by the current browser.
    }
  }
  return results;
}

function isVisibleElement(element) {
  if (!(element instanceof Element)) {
    return false;
  }
  if (element.closest("[hidden]")) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity || 1) === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
