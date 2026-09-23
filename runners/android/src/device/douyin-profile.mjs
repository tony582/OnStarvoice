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

export function readDetail(tree) {
  for (const [kind, caption, authorId, share, back] of [
    ['note', 'tv_desc', 'w67', 'n00', 'iv_back'], ['video', 'desc', 'title', 'vmj', null],
  ]) {
    const body = oneText(byId(tree, caption));
    const heading = kind === 'note' ? oneText(byId(tree, 'tv_title')) : null;
    const title = heading ? `${heading} ${body ?? ''}`.trim() : body;
    const authors = byId(tree, authorId).filter(node => kind !== 'video'
      || node.attributes.text?.startsWith('@') && node.attributes['content-desc'] === '按钮');
    const author = oneText(authors);
    if (title && author && byId(tree, share).length === 1) return { kind, title, author, share, back, ...(heading ? { heading, body: body ?? '' } : {}) };
  }
  return null;
}

export function detailMatchesCard(detail, card) {
  if (!detail) return false;
  const captions = [detail.title];
  // Search may join a separate note heading and body with a full stop.
  // Preserve all punctuation inside both fields; this is not fuzzy matching.
  if (detail.kind === 'note' && detail.heading && detail.body) captions.push(`${detail.heading}。${detail.body}`);
  return captions.some(value => normalizeCaption(value) === normalizeCaption(card.title))
    && (detail.author === card.author || detail.author === `@${card.author}`);
}

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
  return groups['排序依据'] === filters.sort && groups['发布时间'] === filters.time
    && ['视频时长', '搜索范围', '内容形式'].every(name => groups[name] === '不限')
    && (!Object.hasOwn(groups,'位置距离') || groups['位置距离'] === '不限');
}

export function filterSelector(group, choice) {
  return `//*[@resource-id=${xpathLiteral(resource('uxo'))} and .//*[@resource-id=${xpathLiteral(resource('hdi'))} and @text=${xpathLiteral(group)}]]//*[@resource-id=${xpathLiteral(resource('rmy'))} and @text=${xpathLiteral(choice)}]`;
}
