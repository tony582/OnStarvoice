import { classifyDouyinUrl, validateCopiedShare } from '../device/clipboard.mjs';
import { DeviceError } from '../device/bounded.mjs';
import { normalizeCaption, detailMatchesCard } from '../device/douyin-profile.mjs';

/** UI provenance is a pending observation. It cannot authorize an ingestion by itself. */
export function observeCopiedShare({ marker, beforeText, afterText, card, detailBefore, detailAfter }) {
  const link = validateCopiedShare({ marker, beforeText, afterText });
  if (!link.fresh) throw new DeviceError('clipboard_not_fresh', 'No fresh unambiguous work link was copied');
  if (!detailMatchesCard(detailBefore, card) || !detailMatchesCard(detailAfter, card)
    || detailBefore.kind !== detailAfter.kind) throw new DeviceError('detail_identity_unverified', 'The work changed during copying');
  const author = afterText.match(/看看【(.+?)的(?:图文|视频)作品】/u)?.[1];
  if (author && author !== card.author) throw new DeviceError('share_author_mismatch', 'Share author differs from the selected work');
  return { status: 'awaiting_independent_detail', identityVerified: false, shareUrl: link.shareUrl,
    externalId: link.externalId, kind: detailBefore.kind, title: card.title, author: card.author,
    cardDetailMatched: true, detailStillMatched: true, fresh: true, markerReplaced: true,
    shareAuthorMatched: author ? true : null,
    fullTitleIncluded: normalizeCaption(afterText).includes(normalizeCaption(card.title)) };
}

/** The verifier must read the independent official detail page, never the copied caption. */
export function confirmIndependentDetail({ observation, resolvedUrl, independentDetail }) {
  if (observation?.status !== 'awaiting_independent_detail' || observation.identityVerified !== false
    || observation.fresh !== true || observation.markerReplaced !== true
    || observation.cardDetailMatched !== true || observation.detailStillMatched !== true) {
    throw new DeviceError('invalid_share_observation', 'A fresh bound UI observation is required');
  }
  const resolved = classifyDouyinUrl(resolvedUrl);
  const page = classifyDouyinUrl(independentDetail?.url);
  const valid = resolved.externalId && resolved.kind === observation.kind
    && page.externalId === resolved.externalId && page.kind === resolved.kind
    && ['official_browser_detail', 'extension_detail'].includes(independentDetail?.source)
    && normalizeCaption(independentDetail.title) === normalizeCaption(observation.title)
    && independentDetail.author?.normalize('NFC') === observation.author.normalize('NFC');
  if (!valid) throw new DeviceError('link_identity_unverified', 'Independent work ID, kind, full caption and author must agree');
  if (observation.externalId && observation.externalId !== resolved.externalId) {
    throw new DeviceError('link_identity_mismatch', 'The copied canonical work ID differs from the resolved work');
  }
  return { ...observation, externalId: resolved.externalId, canonicalUrl: resolved.canonicalUrl,
    identityVerified: true, status: 'identity_confirmed', verificationSource: independentDetail.source };
}
