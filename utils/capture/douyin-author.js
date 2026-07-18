const DOUYIN_SHELL_AUTHOR_NAME_PATTERN = /^我的$/u;
const DOUYIN_AUTHOR_DECORATION_SUFFIX_PATTERN =
  /(?:认证徽章|(?:商家|企业|官方|机构|个人|品牌)?认证账号|(?:商家|企业|官方|机构|个人|品牌)认证|蓝V认证|黄V认证|已关注|关注)+$/u;

function cleanAuthorText(value) {
  let text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^@\s*/, "");
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text.replace(DOUYIN_AUTHOR_DECORATION_SUFFIX_PATTERN, "").trim();
  }
  return text;
}

export function isDouyinShellAuthorName(value) {
  const text = cleanAuthorText(value);
  return Boolean(text && DOUYIN_SHELL_AUTHOR_NAME_PATTERN.test(text));
}

export function normalizeDouyinAuthorName(value) {
  const text = cleanAuthorText(value);
  return isDouyinShellAuthorName(text) ? "" : text;
}

export function pickDouyinAuthorName(...values) {
  for (const value of values) {
    const normalized = normalizeDouyinAuthorName(value);
    if (normalized) return normalized;
  }
  return "";
}

export function isDouyinOwnProfileUrl(value) {
  const text = String(value || "").trim();
  if (!text) return false;

  try {
    const parsed = new URL(text, "https://www.douyin.com");
    return /^\/user\/self(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /\/user\/self(?:[/?#]|$)/i.test(text);
  }
}
