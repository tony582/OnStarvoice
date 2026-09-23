import { DeviceError } from './bounded.mjs';
import { byId, readDetail, detailMatchesCard } from './douyin-profile.mjs';

// 40.6.0 places its expand/collapse label inside the clickable video caption.
// Remove that UI suffix only when the remaining full text AND author match the card.
function readCardDetail(tree, card) {
  const detail = readDetail(tree);
  if (!detail || detailMatchesCard(detail, card)) return detail;
  const captions = byId(tree, 'desc');
  if (detail.kind === 'video' && captions.length === 1
    && captions[0].attributes.clickable === 'true' && detail.title.endsWith(' 收起')) {
    const expanded = {...detail, title: detail.title.slice(0, -3)};
    if (detailMatchesCard(expanded, card)) return expanded;
  }
  return detail;
}

export async function readVerifiedDetail({ ui, card, signal }) {
  const options = { signal };
  let tree = await ui.waitFor(tree => !!readDetail(tree), options);
  let detail = readCardDetail(tree, card);
  if (detailMatchesCard(detail, card)) return detail;
  const expand = byId(tree, '0s0');
  const sameAuthor = detail.author === card.author || detail.author === `@${card.author}`;
  const captions = byId(tree, 'desc');
  const separateExpand = expand.length === 1 && expand[0].attributes.text === '展开';
  const inlineExpand = expand.length === 0 && captions.length === 1
    && captions[0].attributes.clickable === 'true' && /\.\.\.\s+展开$/u.test(detail.title);
  if (detail.kind !== 'video' || !sameAuthor || (!separateExpand && !inlineExpand)) {
    throw new DeviceError('detail_identity_unverified', 'Opened detail differs from the selected card');
  }
  // Expand the observed control; a truncated prefix alone never verifies identity.
  await ui.clickId(separateExpand ? '0s0' : 'desc', options);
  tree = await ui.waitFor(tree => detailMatchesCard(readCardDetail(tree, card), card), options);
  detail = readCardDetail(tree, card);
  if (!detailMatchesCard(detail, card)) throw new DeviceError('detail_identity_unverified', 'Expanded detail did not match');
  return detail;
}
