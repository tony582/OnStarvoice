const DOUYIN_SHELL_AUTHOR_NAME_PATTERN = /^我的$/u;

function cleanAuthorText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^@\s*/, "");
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
