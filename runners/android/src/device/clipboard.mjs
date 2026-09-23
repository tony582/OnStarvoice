import { randomUUID } from 'node:crypto';

export const createClipboardMarker = () => `starvoice-discovery:${randomUUID()}`;

export function classifyDouyinUrl(value) {
  let url;
  try { url = new URL(value); } catch { return { kind: 'invalid', reason: 'invalid_url' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { kind: 'invalid', reason: 'invalid_url' };
  }
  if (url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)) {
    return { kind: 'short_link', shareUrl: url.href, externalId: null, requiresResolution: true };
  }
  const official = ['www.douyin.com', 'douyin.com'].includes(url.hostname);
  const legacy = ['www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname);
  const match = (official && url.pathname.match(/^\/(video|note)\/(\d{16,22})\/?$/))
    || (legacy && url.pathname.match(/^\/share\/(video|note)\/(\d{16,22})\/?$/))
    || (url.hostname === 'www.iesdouyin.com' && url.pathname.match(/^\/share\/(slides)\/(\d{16,22})\/?$/));
  if (!match) return { kind: 'invalid', reason: 'not_work_url' };
  const kind = match[1] === 'slides' ? 'note' : match[1];
  return { kind, shareUrl: url.href, externalId: match[2],
    canonicalUrl: `https://www.douyin.com/${kind}/${match[2]}`, requiresResolution: false };
}

// Fresh clipboard text proves copying occurred, not which work was copied.
// The caller must independently bind the current detail to expectedExternalId.
export function validateCopiedShare({ marker, beforeText, afterText, expectedExternalId } = {}) {
  const fail = (reason) => ({ ok: false, fresh: false, identityVerified: false, reason });
  if (typeof marker !== 'string' || !/^starvoice-discovery:[0-9a-f-]{36}$/.test(marker) || beforeText !== marker) {
    return fail('marker_not_confirmed');
  }
  if (typeof afterText !== 'string' || !afterText.trim() || afterText === marker || afterText.includes(marker)) return fail('stale_clipboard');
  if (Buffer.byteLength(afterText) > 16 * 1024) return fail('clipboard_too_large');
  const urls = [...new Set(afterText.match(/https?:\/\/[^\s<>"'，。！？、）)\]】]+/g) ?? [])];
  const candidates = urls.map(classifyDouyinUrl).filter((result) => result.kind !== 'invalid');
  if (candidates.length !== 1) return fail(candidates.length ? 'ambiguous_share_links' : 'not_work_url');
  const link = candidates[0];
  const identityVerified = typeof expectedExternalId === 'string' && /^\d{16,22}$/.test(expectedExternalId)
    && expectedExternalId === link.externalId;
  return {
    ...link, fresh: true, markerReplaced: true, identityVerified, ok: identityVerified,
    reason: link.requiresResolution ? 'resolution_required' : identityVerified ? null
      : expectedExternalId ? 'identity_mismatch' : 'identity_unverified',
  };
}
