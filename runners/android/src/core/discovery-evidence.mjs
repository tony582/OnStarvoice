import { createHash } from 'node:crypto';
import { canonicalJson } from '../storage/codec.mjs';
import { requireEvidence } from './errors.mjs';

export function verifyContext(result, task, contextId = null) {
  requireEvidence(result?.verified === true && typeof result.contextId === 'string' && result.contextId.length > 0,
    'search_context_unverified');
  requireEvidence(result.keyword === task.keyword && canonicalJson(result.filters) === canonicalJson(task.filters), 'search_filters_mismatch');
  if (contextId) requireEvidence(result.contextId === contextId, 'search_context_changed');
  return result.contextId;
}

export function verifyLink(link, detail) {
  requireEvidence(link?.fresh === true && link.markerReplaced === true, 'clipboard_not_fresh');
  requireEvidence(link.detailId === detail.detailId, 'link_identity_unverified');
  const pending = link.verification === 'ui_bound';
  if (pending) {
    requireEvidence(link.identityVerified === false && link.cardDetailMatched === true && link.detailStillMatched === true
      && link.uiBinding?.cardId === detail.cardId && /^[a-f0-9]{64}$/.test(link.uiBinding.cardId)
      && ['douyin-30.6.0-de106-api27-p0','douyin-40.6.0-de106-api27-p0'].includes(link.uiBinding.profileId)
      && ['note','video'].includes(link.uiBinding.kind) && !!link.title && !!link.author, 'link_identity_unverified');
  } else {
    requireEvidence(link.identityVerified === true && typeof link.externalId === 'string'
      && /^\d{16,22}$/.test(link.externalId), 'link_identity_unverified');
  }
  requireEvidence(typeof link.shareUrl === 'string', 'link_unverified');
  let url;
  try { url = new URL(link.shareUrl); } catch { requireEvidence(false, 'link_unverified'); }
  requireEvidence(url.protocol === 'https:' && !url.username && !url.password && !url.port, 'link_unverified');
  const short = url.hostname === 'v.douyin.com' && /^\/[\w-]+\/?$/.test(url.pathname);
  const canonical = url.hostname === 'www.douyin.com' ? /^\/(?:video|note)\/(\d{16,22})\/?$/.exec(url.pathname)
    : url.hostname === 'www.iesdouyin.com' && /^\/share\/(?:video|note|slides)\/(\d{16,22})\/?$/.exec(url.pathname);
  requireEvidence(short || canonical, 'link_unverified');
  if (canonical && (!pending || link.externalId)) requireEvidence(canonical[1] === link.externalId, 'link_identity_mismatch');
  if (detail.externalId) requireEvidence(detail.externalId === link.externalId, 'link_identity_mismatch');
}

export function eventIdFor(task, detail, externalId = null) {
  const namespace = Buffer.from('c10bf58103444987b4573d0a501ee389', 'hex');
  const bytes = createHash('sha1').update(namespace)
    .update(canonicalJson({ identity: task.identity, keyword: task.keyword, work: externalId ?? detail.detailId })).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const discoveredWorkKey = (link, detail) => link.verification === 'ui_bound'
  ? `ui:${detail.cardId}` : link.externalId;

export function discoveryEvent({ task, card, detail, link, context, clock, error = null }) {
  return { eventId: eventIdFor(task, detail, error ? null : discoveredWorkKey(link, detail)), ...task.identity, keyword: task.keyword,
    requestedFilters: task.filters, observedFilters: context.filters,
    rawShareUrl: typeof link?.shareUrl === 'string' ? link.shareUrl : '',
    verifiedExternalId: error || link.verification === 'ui_bound' ? null : link.externalId,
    ...(!error && link.verification === 'ui_bound' ? {uiBinding: link.uiBinding} : {}),
    titleHint: card.title ?? '', authorHint: card.author ?? '', publishTimeRaw: card.publishTimeRaw ?? '',
    discoveredAt: new Date(clock.wallNow()).toISOString(), verification: error ? 'link_unverified' : link.verification === 'ui_bound' ? 'ui_bound' : 'verified',
    reason: error?.code ?? null };
}
