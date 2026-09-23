const EXTERNAL_ID = /^\d{16,22}$/;
const HOSTS = new Set(['www.douyin.com', 'www.iesdouyin.com', 'v.douyin.com']);

export function parseDouyinShareUrl(value) {
  const urls = String(value || '').match(/https:\/\/[^\s<>"，。]+/g) || [];
  if (urls.length !== 1) return {status: 'needs_review', reason: 'ambiguous_or_missing_url'};
  let url;
  try { url = new URL(urls[0]); } catch { return {status: 'needs_review', reason: 'invalid_url'}; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.hostname)) {
    return {status: 'needs_review', reason: 'unsupported_url'};
  }
  if (url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    return {status: 'pending', shortUrl: `${url.origin}${url.pathname}`, reason: 'short_link_unresolved'};
  }
  const match = url.hostname === 'www.douyin.com'
    ? url.pathname.match(/^\/(video|note)\/(\d+)\/?$/)
    : url.hostname === 'www.iesdouyin.com' && url.pathname.match(/^\/share\/(video|note|slides)\/(\d+)\/?$/);
  if (!match || !EXTERNAL_ID.test(match[2])) return {status: 'needs_review', reason: 'not_a_work_url'};
  const kind = match[1] === 'slides' ? 'note' : match[1];
  return {status: 'resolved', externalId: match[2], canonicalUrl: `https://www.douyin.com/${kind}/${match[2]}`};
}

// Network adapters are optional and run before acquiring database locks. The
// default stores short links as pending; no arbitrary server fetch is exposed.
export async function resolveEventIdentity(event, resolveShareUrl) {
  if (!['verified', 'ui_bound'].includes(event.verification)) return {status: 'needs_review', reason: 'link_unverified'};
  let identity = parseDouyinShareUrl(event.rawShareUrl);
  if (identity.status === 'pending' && !resolveShareUrl) {
    return {status: 'needs_review', reason: 'short_link_resolver_unavailable'};
  }
  if (identity.status === 'pending' && resolveShareUrl) {
    const controller = new AbortController();
    let timer;
    try {
      const resolvedUrl = await Promise.race([
        resolveShareUrl(identity.shortUrl, {signal: controller.signal}),
        new Promise((_, reject) => {
          timer = setTimeout(() => {controller.abort(); reject(new Error('resolution timeout'));}, 3000);
        }),
      ]);
      identity = parseDouyinShareUrl(resolvedUrl);
      if (identity.status === 'pending') identity.reason = 'short_link_unresolved';
    } catch (error) {
      const reason = error.message === 'UNSAFE_SHARE_ADDRESS' ? 'short_link_dns_address_blocked'
        : error.message === 'SHARE_DNS_UNAVAILABLE' ? 'short_link_dns_failed' : 'short_link_resolution_failed';
      identity = {status: 'pending', reason};
    } finally {
      clearTimeout(timer);
    }
  }
  if (identity.status === 'resolved' && event.verifiedExternalId
      && identity.externalId !== event.verifiedExternalId) {
    return {status: 'needs_review', reason: 'work_identity_mismatch'};
  }
  if (identity.status === 'resolved' && event.verification === 'ui_bound'
      && !identity.canonicalUrl.includes(`/${event.uiBinding?.kind}/`)) {
    return {status: 'needs_review', reason: 'work_kind_mismatch'};
  }
  return identity;
}
