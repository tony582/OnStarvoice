import { PAGE_TYPE, URL_PATTERN } from "../constants.js";
import { getPlatformConfig, normalizePlatformId } from "./registry.js";

function parseUrlSafely(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function matchPlatformByHostname(hostname) {
  const normalizedHostname = String(hostname || "").toLowerCase();
  if (!normalizedHostname) {
    return "unknown";
  }

  for (const platformId of Object.keys(getPlatformHostsMap())) {
    const hosts = getPlatformHostsMap()[platformId];
    if (hosts.some((host) => normalizedHostname === host || normalizedHostname.endsWith(`.${host}`))) {
      return platformId;
    }
  }

  return "unknown";
}

function getPlatformHostsMap() {
  return {
    xiaohongshu: getPlatformConfig("xiaohongshu").matchers?.hosts || [],
    douyin: getPlatformConfig("douyin").matchers?.hosts || [],
  };
}

const DOUYIN_SEARCH_QUERY_KEYS = new Set([
  "keyword",
  "query",
  "q",
  "search_keyword",
  "searchkey",
  "search_word",
]);

function hasDouyinSearchKeyword(parsedUrl) {
  if (!parsedUrl?.searchParams) {
    return false;
  }

  for (const [key, value] of parsedUrl.searchParams.entries()) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    if (!DOUYIN_SEARCH_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }
    if (String(value || "").trim()) {
      return true;
    }
  }

  return false;
}

function isSearchResultRoute(pathname, search, hash) {
  if (
    pathname.includes("/search_result") ||
    pathname.includes("/web/search_result") ||
    pathname.includes("/search/result")
  ) {
    return true;
  }

  if (search.includes("keyword=")) {
    return true;
  }

  return /(?:^#|#\/).*search_result(?:[/?]|$)/.test(hash);
}

function isDiscoveryRoute(pathname, hash) {
  if (/^\/(?:explore|discovery)\/?$/i.test(pathname)) {
    return true;
  }

  return /(?:^#|#\/)(?:explore|discovery)(?:[/?]|$)/i.test(hash);
}

function detectXiaohongshuPageType(url, parsedUrl) {
  if (URL_PATTERN.NOTE_DETAIL.test(url)) {
    return PAGE_TYPE.NOTE_DETAIL;
  }

  if (URL_PATTERN.BLOGGER_PROFILE.test(url)) {
    return PAGE_TYPE.BLOGGER_PROFILE;
  }

  if (URL_PATTERN.SEARCH_RESULTS.test(url) || URL_PATTERN.DISCOVERY.test(url)) {
    return PAGE_TYPE.SEARCH_RESULTS;
  }

  if (parsedUrl) {
    const pathname = String(parsedUrl.pathname || "").toLowerCase();
    const search = String(parsedUrl.search || "").toLowerCase();
    const hash = String(parsedUrl.hash || "").toLowerCase();

    if (isSearchResultRoute(pathname, search, hash) || isDiscoveryRoute(pathname, hash)) {
      return PAGE_TYPE.SEARCH_RESULTS;
    }
  }

  return PAGE_TYPE.UNSUPPORTED;
}

function detectDouyinPageType(parsedUrl, rawUrl) {
  if (!parsedUrl) {
    return PAGE_TYPE.UNSUPPORTED;
  }

  const pathname = String(parsedUrl.pathname || "").toLowerCase();
  const searchParams = parsedUrl.searchParams;

  if (searchParams.get("modal_id")) {
    return PAGE_TYPE.NOTE_DETAIL;
  }

  if (/^\/(?:video|note)\/\d+(?:\/)?$/i.test(pathname)) {
    return PAGE_TYPE.NOTE_DETAIL;
  }

  if (/^\/user\/[a-z0-9._-]+(?:\/)?$/i.test(pathname)) {
    return PAGE_TYPE.BLOGGER_PROFILE;
  }

  if (pathname === "/jingxuan" || pathname === "/jingxuan/") {
    return PAGE_TYPE.SEARCH_RESULTS;
  }

  if (hasDouyinSearchKeyword(parsedUrl)) {
    return PAGE_TYPE.SEARCH_RESULTS;
  }

  if (/douyin\.com\/(?:jingxuan(?:\/search)?|search)(?:[/?#]|$)/i.test(rawUrl)) {
    return PAGE_TYPE.SEARCH_RESULTS;
  }

  return PAGE_TYPE.UNSUPPORTED;
}

export function detectPlatformFromUrl(url) {
  const parsedUrl = parseUrlSafely(String(url || "").trim());
  if (!parsedUrl) {
    return "unknown";
  }

  return matchPlatformByHostname(parsedUrl.hostname);
}

export function detectPageType(url, platform) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) {
    return PAGE_TYPE.UNKNOWN;
  }

  const parsedUrl = parseUrlSafely(normalizedUrl);
  const resolvedPlatform = normalizePlatformId(platform || detectPlatformFromUrl(normalizedUrl));

  switch (resolvedPlatform) {
    case "xiaohongshu":
      return detectXiaohongshuPageType(normalizedUrl, parsedUrl);
    case "douyin":
      return detectDouyinPageType(parsedUrl, normalizedUrl);
    default:
      return PAGE_TYPE.UNSUPPORTED;
  }
}

export function isSupportedCaptureUrl(url) {
  const platform = detectPlatformFromUrl(url);
  return platform === "xiaohongshu" || platform === "douyin";
}
