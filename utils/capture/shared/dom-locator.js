function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeMediaUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const unwrapped = text.replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
  if (!unwrapped) return "";

  try {
    const normalized = unwrapped.startsWith("//")
      ? `https:${unwrapped}`
      : new URL(unwrapped, window.location.origin).toString();
    return normalized.replace(/^http:\/\//i, "https://");
  } catch {
    return unwrapped;
  }
}

function isLikelyPageRouteUrl(url) {
  const normalized = normalizeMediaUrl(url).toLowerCase();
  if (!normalized) return false;

  return (
    /^https?:\/\/(?:www\.)?douyin\.com\/(?:video|note|user|search|jingxuan\/search)\//i.test(
      normalized,
    ) ||
    /^https?:\/\/v\.douyin\.com\//i.test(normalized) ||
    /^https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|video|user\/profile|search_result|web\/search_result)\//i.test(
      normalized,
    ) ||
    normalized.endsWith(".html")
  );
}

function isLikelyVideoAssetUrl(url) {
  const normalized = normalizeMediaUrl(url).toLowerCase();
  if (!normalized || isLikelyPageRouteUrl(normalized)) {
    return false;
  }

  return (
    /\.(mp4|m3u8|webm)(?:$|[?#])/i.test(normalized) ||
    normalized.includes("mime_type=video") ||
    normalized.includes("video_id=") ||
    normalized.includes("/aweme/v1/play/") ||
    normalized.includes("video/tos/") ||
    normalized.includes("douyinvod.com") ||
    normalized.includes("bytevod.com") ||
    normalized.includes("zjcdn.com")
  );
}

export function buildUrlFingerprint(raw) {
  const normalized = normalizeMediaUrl(raw);
  if (!normalized) return "";

  try {
    const parsed = new URL(normalized);
    const keys = ["id", "item_id", "group_id", "__vid", "uri", "mime_type"];
    const query = keys
      .map((key) => {
        const value = parsed.searchParams.get(key);
        return value ? `${key}=${value}` : "";
      })
      .filter(Boolean)
      .join("&");
    return `${parsed.hostname}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return normalized.split("?")[0];
  }
}

export function extractBackgroundImageUrl(node) {
  if (!node || typeof node !== "object") return "";

  const candidates = [
    node.getAttribute?.("style") || "",
    globalThis.getComputedStyle ? globalThis.getComputedStyle(node).backgroundImage : "",
  ];

  for (const candidate of candidates) {
    const match = String(candidate || "").match(/url\((['"]?)(.*?)\1\)/i);
    if (match?.[2]) {
      return normalizeMediaUrl(match[2]);
    }
  }

  return "";
}

export function collectMediaUrlsFromElement(node) {
  if (!node || typeof node.querySelectorAll !== "function") {
    return { images: [], videos: [] };
  }

  const imageSet = new Set();
  const videoSet = new Set();

  const imageNodes = node.querySelectorAll("img[src], img[data-src], [style*='background-image']");
  imageNodes.forEach((element) => {
    const candidates = [
      element.getAttribute?.("src"),
      element.getAttribute?.("data-src"),
      extractBackgroundImageUrl(element),
    ];
    candidates
      .map(normalizeMediaUrl)
      .filter(Boolean)
      .forEach((value) => imageSet.add(value));
  });

  const videoNodes = node.querySelectorAll("video, source[src]");
  videoNodes.forEach((element) => {
    const candidates = [
      element.getAttribute?.("src"),
      element.currentSrc,
      element.getAttribute?.("poster"),
    ];
    candidates
      .map(normalizeMediaUrl)
      .filter(Boolean)
      .forEach((value) => {
        if (/\.(jpg|jpeg|png|webp|gif)(?:$|[?#])/i.test(value) || /douyinpic\.com/i.test(value)) {
          imageSet.add(value);
        } else if (isLikelyVideoAssetUrl(value)) {
          videoSet.add(value);
        }
      });
  });

  const ownBackground = extractBackgroundImageUrl(node);
  if (ownBackground) {
    imageSet.add(ownBackground);
  }

  return {
    images: Array.from(imageSet),
    videos: Array.from(videoSet),
  };
}

function getElementIndexWithinParent(node) {
  const parent = node?.parentElement;
  if (!parent) return -1;
  return Array.from(parent.children).indexOf(node);
}

function buildSimpleSelector(node) {
  if (!node || node.nodeType !== 1) return "";
  const tag = String(node.tagName || "").toLowerCase();
  if (!tag) return "";
  if (node.id) return `${tag}#${CSS.escape(node.id)}`;

  const stableAttrs = ["data-e2e", "data-id", "data-aweme-id", "href"];
  for (const attr of stableAttrs) {
    const value = cleanText(node.getAttribute?.(attr));
    if (value) {
      return `${tag}[${attr}="${CSS.escape(value)}"]`;
    }
  }

  const classNames = String(node.className || "")
    .split(/\s+/)
    .map((name) => name.trim())
    .filter((name) => name && !/\d{4,}/.test(name))
    .slice(0, 2);
  if (classNames.length > 0) {
    return `${tag}.${classNames.map((name) => CSS.escape(name)).join(".")}`;
  }

  const index = getElementIndexWithinParent(node);
  return index >= 0 ? `${tag}:nth-child(${index + 1})` : tag;
}

export function buildCssPath(node, { maxDepth = 6 } = {}) {
  if (!node || node.nodeType !== 1) return "";

  const parts = [];
  let current = node;
  let depth = 0;

  while (current && current.nodeType === 1 && depth < maxDepth) {
    parts.unshift(buildSimpleSelector(current));
    if (current.id) break;
    current = current.parentElement;
    depth += 1;
  }

  return parts.filter(Boolean).join(" > ");
}

export function buildDomLocator(node) {
  if (!node || node.nodeType !== 1) return null;

  const element = node;
  const media = collectMediaUrlsFromElement(element);

  return {
    tagName: String(element.tagName || "").toLowerCase(),
    id: cleanText(element.id),
    className: cleanText(element.className),
    textSnippet: cleanText(element.innerText || "").slice(0, 120),
    href: normalizeMediaUrl(element.getAttribute?.("href") || element.href || ""),
    dataE2e: cleanText(element.getAttribute?.("data-e2e")),
    dataAwemeId: cleanText(element.getAttribute?.("data-aweme-id")),
    cssPath: buildCssPath(element),
    parentCssPath: buildCssPath(element.parentElement),
    childIndex: getElementIndexWithinParent(element),
    imageFingerprints: media.images.map(buildUrlFingerprint).filter(Boolean),
    videoFingerprints: media.videos.map(buildUrlFingerprint).filter(Boolean),
  };
}

export function buildReverseMatchHints({
  noteId = "",
  noteUrl = "",
  coverImageUrl = "",
  videoUrl = "",
  title = "",
  author = "",
} = {}) {
  const normalizedNoteUrl = normalizeMediaUrl(noteUrl);
  const normalizedCoverImageUrl = normalizeMediaUrl(coverImageUrl);
  const normalizedVideoUrl = normalizeMediaUrl(videoUrl);

  return {
    noteId: String(noteId || "").trim(),
    noteUrl: normalizedNoteUrl,
    noteUrlFingerprint: buildUrlFingerprint(normalizedNoteUrl),
    coverImageUrl: normalizedCoverImageUrl,
    coverImageFingerprint: buildUrlFingerprint(normalizedCoverImageUrl),
    videoUrl: normalizedVideoUrl,
    videoUrlFingerprint: buildUrlFingerprint(normalizedVideoUrl),
    titleSnippet: cleanText(title).slice(0, 80),
    authorSnippet: cleanText(author).slice(0, 80),
  };
}
