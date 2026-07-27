const SUPPORTED_SOCIAL_PLATFORMS = new Set([
  "xiaohongshu",
  "douyin",
  "weibo",
]);

const GENERIC_LABELS = new Set([
  "",
  "我",
  "我的",
  "主页",
  "个人主页",
  "头像",
  "用户",
  "账号",
  "小红书",
  "抖音",
  "微博",
]);
const RESERVED_ACCOUNT_IDS = new Set([
  "self",
  "me",
  "my",
  "profile",
  "home",
  "login",
  "undefined",
  "null",
]);

function cleanText(value, limit = 160) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}
export function normalizeSocialPlatform(value) {
  const platform = cleanText(value, 40).toLowerCase();
  return SUPPORTED_SOCIAL_PLATFORMS.has(platform) ? platform : "";
}

export function isReservedPlatformAccountId(value) {
  return RESERVED_ACCOUNT_IDS.has(
    cleanText(value, 240).toLowerCase().replace(/^@/u, ""),
  );
}

export function extractPlatformAccountId(platformValue, hrefValue) {
  const platform = normalizeSocialPlatform(platformValue);
  const href = cleanText(hrefValue, 2000);
  if (!platform || !href) return "";
  let pathname = href;
  try {
    pathname = new URL(href, "https://example.invalid").pathname;
  } catch {
    pathname = href.split(/[?#]/u)[0];
  }
  const patterns = {
    xiaohongshu: /\/user\/profile\/([^/?#]+)/iu,
    douyin: /\/user\/([^/?#]+)/iu,
    weibo: /\/(?:u\/)?(\d{4,})\/?$/iu,
  };
  const match = pathname.match(patterns[platform]);
  if (!match?.[1]) return "";
  let accountId = "";
  try {
    accountId = cleanText(decodeURIComponent(match[1]), 240);
  } catch {
    accountId = cleanText(match[1], 240);
  }
  return isReservedPlatformAccountId(accountId) ? "" : accountId;
}

function accountHandleFromText(value) {
  const text = cleanText(value, 500);
  const match = text.match(
    /(?:小红书号|抖音号|微博号|账号)\s*[:：]\s*([^\s|·,，;；]{2,80})/iu,
  );
  return cleanText(match?.[1], 160);
}

function candidateLabel(anchor) {
  const candidates = [
    anchor?.getAttribute?.("aria-label"),
    anchor?.getAttribute?.("title"),
    anchor?.querySelector?.("img")?.getAttribute?.("alt"),
    anchor?.querySelector?.("[aria-label]")?.getAttribute?.("aria-label"),
    anchor?.textContent,
  ];
  for (const value of candidates) {
    const label = cleanText(value);
    if (label && !GENERIC_LABELS.has(label)) return label;
  }
  return "";
}

function candidateScore(anchor, platform, accountId) {
  if (!anchor || !accountId) return -Infinity;
  const descriptor = cleanText(
    [
      anchor.getAttribute?.("class"),
      anchor.getAttribute?.("id"),
      anchor.getAttribute?.("data-e2e"),
      anchor.getAttribute?.("aria-label"),
      anchor.getAttribute?.("title"),
      anchor.textContent,
    ].join(" "),
    1000,
  ).toLowerCase();
  let score = 0;
  if (anchor.closest?.("header, nav, [role='navigation']")) score += 70;
  if (
    anchor.closest?.(
      "[class*='header'],[class*='Header'],[class*='sidebar'],[class*='Sidebar'],[class*='nav'],[class*='Nav']",
    )
  ) {
    score += 35;
  }
  if (/avatar|profile|account|user|mine|my-|self/u.test(descriptor)) {
    score += 28;
  }
  if (/(^|\s)(我|我的|个人主页)(\s|$)/u.test(descriptor)) score += 55;
  if (anchor.querySelector?.("img")) score += 8;
  if (
    anchor.closest?.(
      "article,[class*='feed-card'],[class*='note-item'],[class*='video-card'],[class*='search-result']",
    ) &&
    !anchor.closest?.("header,nav,[role='navigation']")
  ) {
    score -= 100;
  }
  if (platform === "douyin" && /feed-video-nickname/u.test(descriptor)) {
    score -= 120;
  }
  return score;
}

function platformFromUrl(value) {
  const url = cleanText(value, 2000).toLowerCase();
  if (/xiaohongshu\.com/u.test(url)) return "xiaohongshu";
  if (/douyin\.com/u.test(url)) return "douyin";
  if (/(?:^|\.)weibo\.com/u.test(url)) return "weibo";
  return "";
}

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function explicitLoggedOut(documentRef) {
  const candidates = Array.from(
    documentRef?.querySelectorAll?.(
      "header button,header a,nav button,nav a,[role='navigation'] button,[role='navigation'] a",
    ) || [],
  ).slice(0, 120);
  return candidates.some(node =>
    /^(?:登录|立即登录|扫码登录|账号登录)$/u.test(
      cleanText(node?.textContent, 40),
    ),
  );
}

export function detectLoggedSocialAccount({
  documentRef = globalThis.document,
  locationHref = globalThis.location?.href || "",
  platform: platformValue = "",
} = {}) {
  const platform =
    normalizeSocialPlatform(platformValue) ||
    platformFromUrl(locationHref);
  if (!platform || !documentRef?.querySelectorAll) return null;

  const selector = [
    "header a[href]",
    "nav a[href]",
    "[role='navigation'] a[href]",
    "[class*='header'] a[href]",
    "[class*='Header'] a[href]",
    "[class*='sidebar'] a[href]",
    "[class*='Sidebar'] a[href]",
    "a[data-e2e*='user'][href]",
    "a[data-e2e*='avatar'][href]",
  ].join(",");
  const candidates = [];
  const seen = new Set();
  for (const anchor of Array.from(documentRef.querySelectorAll(selector)).slice(
    0,
    240,
  )) {
    const href = cleanText(
      anchor?.href || anchor?.getAttribute?.("href"),
      2000,
    );
    const accountId = extractPlatformAccountId(platform, href);
    if (!accountId) continue;
    const key = `${platform}:${accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = candidateScore(anchor, platform, accountId);
    candidates.push({
      anchor,
      href,
      accountId,
      score,
      label: candidateLabel(anchor),
    });
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  const observedAt = new Date().toISOString();
  if (!best || best.score < 60) {
    if (!explicitLoggedOut(documentRef)) return null;
    return {
      platform,
      platformAccountId: "",
      accountHandle: "",
      displayName: "",
      avatarUrl: "",
      loginState: "logged_out",
      confidence: "high",
      sourceUrl: sourceUrl(locationHref),
      observedAt,
    };
  }
  return {
    platform,
    platformAccountId: best.accountId,
    accountHandle: accountHandleFromText(
      `${best.anchor?.textContent || ""} ${best.anchor?.parentElement?.textContent || ""}`,
    ),
    displayName: best.label,
    avatarUrl: cleanText(
      best.anchor?.querySelector?.("img")?.src ||
        best.anchor?.querySelector?.("img")?.getAttribute?.("src"),
      1000,
    ),
    loginState: "authenticated",
    confidence: best.score >= 100 ? "high" : "medium",
    sourceUrl: sourceUrl(locationHref),
    observedAt,
  };
}
