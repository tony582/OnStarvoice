import {hasSemanticFilters, readSemanticFilters} from './douyin-semantic-filters.mjs';
import { createHash } from 'node:crypto';
import { DeviceError } from './bounded.mjs';
import { descendants, visible, xpathLiteral } from './ui-tree.mjs';

export const DOUYIN_P0_PROFILE = Object.freeze({
  id: 'douyin-40.6.0-de106-api27-p0', packageName: 'com.ss.android.ugc.aweme',
  version: '40.6.0', model: 'DE106', apiLevel: '27', productionAccepted: false,
});
// Measured on 40.6.0 after the phone updated at 2026-09-23 11:32; selectors stay semantic in callers.
const resourceAliases = {hmy:'2r9', '0g9':'46p', hb9:'iu1', b87:'drk', ab0:'--', za5:'3-y', vmj:'z0a', w67:'tv_nickname', n00:'q26', vl3:'zyk'};
export const resource = (id) => `${DOUYIN_P0_PROFILE.packageName}:id/${resourceAliases[id] ?? id}`;
export const normalizeCaption = (value) => (value ?? '').normalize('NFC').replace(/\s+/gu, '');
export const appNodes = (tree) => tree.nodes.filter(node => node.attributes.package === DOUYIN_P0_PROFILE.packageName && visible(node));
export const byId = (tree, id) => appNodes(tree).filter(node => node.attributes['resource-id'] === resource(id));
export const searchEntryNodes = tree => byId(tree,'hmy').filter(node => node.attributes['content-desc'] === '搜索');
const oneText = (nodes) => nodes.length === 1 && nodes[0].attributes.text?.trim() ? nodes[0].attributes.text : null;
const within = (node, id) => descendants(node).filter(child => visible(child) && child.attributes['resource-id'] === resource(id));

export function assertProfileDevice(device) {
  if (device.model !== DOUYIN_P0_PROFILE.model || String(device.apiLevel) !== DOUYIN_P0_PROFILE.apiLevel
    || device.appVersion !== DOUYIN_P0_PROFILE.version) throw new DeviceError('profile_version_mismatch', 'Device and Douyin versions do not match this calibration profile');
}

export function readSearch(tree, keyword) {
  const input = byId(tree, 'et_search_kw');
  const tabs = appNodes(tree).filter(node => node.attributes['resource-id'] === 'android:id/text1'
    && node.attributes.text === '综合' && node.attributes.selected === 'true');
  const verified = input.length === 1 && input[0].attributes.text === keyword && tabs.length === 1
    && !byId(tree, 'hdi').length && !hasSemanticFilters(tree);
  const cards = verified ? byId(tree, 'b87').flatMap(card => {
    const title = oneText(within(card, 'desc')); const author = oneText(within(card, 'ab0'));
    if (!title || !author) return [];
    const cardId = createHash('sha256').update(JSON.stringify([title, author])).digest('hex');
    return [{ cardId, title, author, publishTimeRaw: oneText(within(card, 'za5')),
      selector: `//*[@resource-id=${xpathLiteral(resource('b87'))} and .//*[@resource-id=${xpathLiteral(resource('desc'))} and @text=${xpathLiteral(title)}] and .//*[@resource-id=${xpathLiteral(resource('ab0'))} and @text=${xpathLiteral(author)}]]` }];
  }) : [];
  return { verified, keyword, cards };
}

// 40.6.0 folds a long video caption inside its clickable caption node: the visible part, an ellipsis and an
// inline "展开" ("... 展开", "…展开"). An unfolded one shows the whole caption and ends with a UI "收起" (spacing
// varies). Neither label is tapped.
const FOLDED_LABEL = /(?:\.\.\.|…)\s*展开$/u;
const UNFOLDED_LABEL = /\s*收起$/u;

export function readDetail(tree) {
  for (const [kind, caption, authorId, share, back] of [
    ['note', 'tv_desc', 'w67', 'n00', 'iv_back'], ['video', 'desc', 'title', 'vmj', null],
  ]) {
    const captionNodes = byId(tree, caption);
    const body = oneText(captionNodes);
    const heading = kind === 'note' ? oneText(byId(tree, 'tv_title')) : null;
    const title = heading ? `${heading} ${body ?? ''}`.trim() : body;
    const authors = byId(tree, authorId).filter(node => kind !== 'video'
      || node.attributes.text?.startsWith('@') && node.attributes['content-desc'] === '按钮');
    const author = oneText(authors);
    if (title && author && byId(tree, share).length === 1) return { kind, title, author, share, back,
      ...(heading ? { heading, body: body ?? '' } : {}),
      ...(kind === 'video' ? { captionClickable: captionNodes[0]?.attributes.clickable === 'true' } : {}) };
  }
  return null;
}

// The opened detail is the clicked card: the same author, and the caption equals the card's. A video caption that
// shows its UI label is compared without it: unfolded (收起) it must still equal the card's caption, folded (… 展开)
// its visible part must begin the card's caption. Nothing is tapped to unfold it: the copied link is the work's
// identity (2026-10-02). Code-unit prefix, so a fold inside an emoji or a surrogate pair still matches.
export function detailMatchesCard(detail, card) {
  if (!detail || !(detail.author === card.author || detail.author === `@${card.author}`)) return false;
  const wanted = normalizeCaption(card.title);
  const captions = [detail.title];
  // Search may join a separate note heading and body with a full stop.
  // Preserve all punctuation inside both fields; this is not fuzzy matching.
  if (detail.kind === 'note' && detail.heading && detail.body) captions.push(`${detail.heading}。${detail.body}`);
  if (captions.some(value => normalizeCaption(value) === wanted)) return true;
  if (detail.kind !== 'video' || detail.captionClickable !== true) return false;
  if (UNFOLDED_LABEL.test(detail.title)) return normalizeCaption(detail.title.replace(UNFOLDED_LABEL, '')) === wanted;
  if (!FOLDED_LABEL.test(detail.title)) return false;
  const visible = normalizeCaption(detail.title.replace(FOLDED_LABEL, ''));
  return visible.length > 0 && wanted.startsWith(visible);
}

const homeButtons = tree => byId(tree, '0p3').filter(node => node.attributes['content-desc'] === '首页，按钮');
// Search/profile controls can be shared by other tabs. Positive Home selection is mandatory;
// devices that do not expose this marker remain unverified until calibrated on the physical phone.
export const isDouyinHome = tree => searchEntryNodes(tree).length === 1
  && byId(tree, '0p3').filter(node => node.attributes['content-desc'] === '我，按钮').length === 1
  && byId(tree, 'et_search_kw').length === 0
  && homeButtons(tree).length === 1 && homeButtons(tree)[0].attributes.selected === 'true';

export function readFilters(tree) {
  if (hasSemanticFilters(tree)) return readSemanticFilters(tree);
  const groups = {};
  for (const label of byId(tree, 'hdi')) {
    const name = label.attributes.text;
    if (Object.hasOwn(groups, name)) throw new DeviceError('filter_ambiguous', 'Duplicate filter group');
    const choices = within(label.parent, 'urc');
    const selected = choices.map(node => node.attributes['content-desc']?.match(/^已选中，(.+)，按钮$/u)?.[1]).filter(Boolean);
    if (selected.length !== 1) throw new DeviceError('filter_unverified', 'Filter selection could not be read');
    groups[name] = selected[0];
  }
  return groups;
}

export function filtersMatch(groups, filters) {
  // Every requested group is compared to its choice; the groups the task does not steer must read 不限.
  return groups['排序依据'] === filters.sort && groups['发布时间'] === filters.time
    && groups['内容形式'] === (filters.content ?? '不限')
    && ['视频时长', '搜索范围'].every(name => groups[name] === '不限')
    && (!Object.hasOwn(groups,'位置距离') || groups['位置距离'] === '不限');
}

export function filterSelector(group, choice) {
  return `//*[@resource-id=${xpathLiteral(resource('uxo'))} and .//*[@resource-id=${xpathLiteral(resource('hdi'))} and @text=${xpathLiteral(group)}]]//*[@resource-id=${xpathLiteral(resource('rmy'))} and @text=${xpathLiteral(choice)}]`;
}
