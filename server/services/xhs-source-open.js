const XHS_CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/u;

function text(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

export function normalizeXhsContentId(value) {
  const normalized = text(value, 100);
  return XHS_CONTENT_ID_PATTERN.test(normalized) ? normalized : '';
}

export function xhsCanonicalIdentityUrl(value) {
  const contentId = normalizeXhsContentId(value);
  return contentId
    ? `https://www.xiaohongshu.com/explore/${contentId}`
    : '';
}

export function validatedStoredXhsSourceUrl(value, expectedContentId) {
  const expected = normalizeXhsContentId(expectedContentId).toLowerCase();
  if (!expected) return '';
  try {
    const url = new URL(text(value, 4000));
    const host = url.hostname.toLowerCase();
    const directMatch = url.pathname.match(
      /^\/(?:explore|search_result|discovery\/item|note|video)\/([A-Za-z0-9_-]{8,100})(?:\/|$)/iu,
    );
    const profileMatch = url.pathname.match(
      /^\/user\/profile\/[A-Za-z0-9_-]{6,100}\/([A-Za-z0-9_-]{8,100})(?:\/|$)/iu,
    );
    const actual = (directMatch?.[1] || profileMatch?.[1] || '').toLowerCase();
    const xsecToken = text(url.searchParams.get('xsec_token'), 2000);
    if (
      url.protocol !== 'https:' ||
      (host !== 'xiaohongshu.com' && !host.endsWith('.xiaohongshu.com')) ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      actual !== expected ||
      !xsecToken
    ) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function redactXhsRecordNavigation(record = {}) {
  if (text(record.platform, 40).toLowerCase() !== 'xiaohongshu') {
    return record;
  }
  const canonicalUrl = xhsCanonicalIdentityUrl(record.external_id);
  const sourceUrl = validatedStoredXhsSourceUrl(
    record.url,
    record.external_id,
  );
  return {
    ...record,
    url: sourceUrl,
    canonical_url: canonicalUrl,
    source_open_mode: 'stored_url',
    source_open_available: Boolean(sourceUrl),
  };
}
