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

const DOUYIN_AUTHOR_CARD_SELECTOR =
  '[data-e2e="user-info"], .author-card, .author-card-user-info';
const DOUYIN_AUTHOR_NAME_SELECTORS = [
  '[data-e2e="feed-video-nickname"]',
  '.author-card-name',
  '[data-e2e="user-info"] h1',
  '.video-info-detail .account-name-text',
  '.video-info-detail .account-name',
  '.OMAnlCHg .q5XQ42ql',
];
const DOUYIN_NON_AUTHOR_SELECTOR = [
  '[data-e2e="video-desc"]',
  '[data-e2e*="comment"]',
  '[data-e2e*="recommend"]',
  '.video-info-detail .title',
  '.search-result-card [class*="desc"]',
  '.search-result-card [class*="title"]',
  '[aria-hidden="true"]',
].join(', ');
const DOUYIN_PROFILE_LINK_SELECTOR =
  'a[href*="/user/"], a[data-href*="/user/"], a[data-url*="/user/"]';

export function isDouyinNonAuthorElement(node) {
  return Boolean(
    node?.closest?.(DOUYIN_NON_AUTHOR_SELECTOR) ||
    node?.matches?.('[id^="@"]') ||
    node?.querySelector?.('[id^="@"]'),
  );
}

function readDouyinProfileIdentity(node) {
  const raw = node?.getAttribute?.('href') ||
    node?.getAttribute?.('data-href') || node?.getAttribute?.('data-url') || '';
  try {
    const parsed = new URL(raw, 'https://www.douyin.com');
    const userId = parsed.pathname.match(/^\/user\/([^/?#]+)\/?$/)?.[1];
    if (!/^(www\.)?douyin\.com$/i.test(parsed.hostname) ||
        !/^https?:$/.test(parsed.protocol) || !userId || userId === 'self') return null;
    return {userId, url: `https://www.douyin.com/user/${userId}`};
  } catch {
    return null;
  }
}

// A /user/ link or an @ prefix alone is not publisher evidence. Only inspect
// publisher cards/nickname nodes inside the already target-bound detail/card.
// Keep the display name and profile identity from the same author region.
export function extractDouyinDomAuthorInfo(root, {
  nameSelectors = DOUYIN_AUTHOR_NAME_SELECTORS,
  isVisible = () => true,
} = {}) {
  const empty = {name: '', userId: '', url: ''};
  if (!root?.querySelectorAll) return empty;
  const accepted = (node) => node && root.contains(node) &&
    !isDouyinNonAuthorElement(node) && isVisible(node);
  const collect = (selector) => [
    ...(root.matches?.(selector) ? [root] : []),
    ...root.querySelectorAll(selector),
  ].filter(accepted);
  const nameNodes = nameSelectors.flatMap(collect);
  const regions = [...collect(DOUYIN_AUTHOR_CARD_SELECTOR), ...nameNodes];
  let nameOnly = '';

  for (const region of new Set(regions)) {
    const links = [...new Set([
      region.closest?.(DOUYIN_PROFILE_LINK_SELECTOR),
      ...region.querySelectorAll(DOUYIN_PROFILE_LINK_SELECTOR),
    ].filter(accepted))];
    const identities = links.map(link => ({link, ...readDouyinProfileIdentity(link)}))
      .filter(candidate => candidate.userId);
    const ids = new Set(identities.map(candidate => candidate.userId));
    // Conflicting profiles in one region must never produce a mixed identity.
    if (ids.size > 1) continue;
    if (ids.size === 1) {
      const identity = identities[0];
      const namedLink = identities.find(({link}) =>
        normalizeDouyinAuthorName(link.textContent));
      const nameNode = nameNodes.find(node => region.contains(node));
      const name = pickDouyinAuthorName(
        nameNode?.textContent,
        namedLink?.link.textContent,
        identity.link.querySelector?.('img[alt]')?.getAttribute('alt'),
      );
      if (name) return {name, userId: identity.userId, url: identity.url};
      continue;
    }
    if (nameNodes.includes(region)) {
      nameOnly ||= normalizeDouyinAuthorName(region.textContent);
    }
  }
  // A reliable nickname without a profile link is safer than borrowing the ID
  // of a mentioned account elsewhere in the card or page.
  return {...empty, name: nameOnly};
}
