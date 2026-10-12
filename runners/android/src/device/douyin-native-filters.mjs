import {descendants, visible, xpathLiteral} from './ui-tree.mjs';
import {DeviceError} from './bounded.mjs';
import {FILTER_GROUPS, FILTER_OPTIONS} from './douyin-semantic-filters.mjs';

// 40.6.0 also serves this native popup (DE106, 2026-10-13). It is a separate Android window;
// the older semantic ScrollView and the legacy five-group panel remain supported by their readers.
const PACKAGE = 'com.ss.android.ugc.aweme';
const id = name => `${PACKAGE}:id/${name}`;
const is = (node, name) => visible(node) && node.attributes.package === PACKAGE
  && node.attributes['resource-id'] === id(name);
const within = (node, name) => descendants(node).filter(child => is(child, name));
const panels = tree => tree.nodes.filter(node => is(node, 'iu1')
  && node.attributes.class === 'androidx.recyclerview.widget.RecyclerView'
  && within(node, 'jhx').some(label => label.attributes.text === '排序依据'));
export const hasNativeFilters = tree => panels(tree).length > 0;

function panelState(tree, {repairScope = false} = {}) {
  const matches = panels(tree);
  if (matches.length !== 1) throw new DeviceError('filter_ambiguous', 'Native filter panel is missing or ambiguous');
  const panel = matches[0], groups = {};
  for (const section of panel.children.filter(node => is(node, 'y9y'))) {
    const labels = within(section, 'jhx');
    const group = labels[0]?.attributes.text;
    if (labels.length !== 1 || !FILTER_GROUPS.includes(group) || Object.hasOwn(groups, group)) {
      throw new DeviceError('filter_ambiguous', 'Native filter group is missing, unknown or repeated');
    }
    const choices = within(section, 'jhg').map(node => {
      const texts = within(node, 'vlc');
      const choice = texts[0]?.attributes.text;
      const state = node.attributes['content-desc']?.match(/^(已选中|未选中)，(.+)，按钮$/u);
      // After returning from a note, Douyin can omit only 搜索范围/不限's description. It is unknown,
      // never inferred as selected; the repair reader may locate Reset, but cannot apply this panel.
      const unknown = repairScope && group === '搜索范围' && choice === '不限' && !node.attributes['content-desc'];
      if (texts.length !== 1 || !FILTER_OPTIONS[group].includes(choice) || (!unknown && state?.[2] !== choice)
        || node.attributes.clickable !== 'true') {
        throw new DeviceError('filter_unverified', 'Native filter choice and accessible state disagree');
      }
      return {node, choice, selected: unknown ? null : state[1] === '已选中'};
    });
    if (new Set(choices.map(item => item.choice)).size !== choices.length) {
      throw new DeviceError('filter_ambiguous', 'Native filter choice is repeated within its group');
    }
    const unknown = choices.some(item => item.selected === null);
    const selected = choices.filter(item => item.selected === true).length;
    if (unknown ? selected !== 0 || choices.length !== FILTER_OPTIONS[group].length : selected !== 1) {
      throw new DeviceError('filter_unverified', 'Native filter group must have exactly one selected choice');
    }
    groups[group] = choices;
  }
  if (FILTER_GROUPS.some(group => !groups[group])) {
    throw new DeviceError('filter_unverified', 'Every native filter group must be visible');
  }
  return {panel, groups};
}

export function readNativeFilters(tree) {
  const {groups} = panelState(tree);
  return Object.fromEntries(FILTER_GROUPS.map(group => [group, groups[group].find(item => item.selected).choice]));
}

const panelXPath = `//*[@package=${xpathLiteral(PACKAGE)} and @resource-id=${xpathLiteral(id('iu1'))}`
  + " and @class='androidx.recyclerview.widget.RecyclerView']";
export function nativeFilterSelector(group, choice, tree) {
  if (!FILTER_OPTIONS[group]?.includes(choice)) throw new DeviceError('filter_unverified', 'Unknown native filter choice');
  const {groups} = panelState(tree);
  const targets = groups[group].filter(item => item.choice === choice);
  if (targets.length !== 1) throw new DeviceError('filter_ambiguous', 'Native filter choice is missing or ambiguous');
  const bounds = xpathLiteral(targets[0].node.attributes.bounds);
  // Bind the repeated 不限 labels to their group and current measured bounds, never to screen coordinates.
  return `${panelXPath}/*[@resource-id=${xpathLiteral(id('y9y'))} and .//*[@resource-id=${xpathLiteral(id('jhx'))}`
    + ` and @text=${xpathLiteral(group)}]]//*[@resource-id=${xpathLiteral(id('jhg'))} and @clickable='true'`
    + ` and @bounds=${bounds} and .//*[@resource-id=${xpathLiteral(id('vlc'))} and @text=${xpathLiteral(choice)}]]`;
}

function popupButtonSelector(panel, name, text) {
  const popup = panel.parent?.parent;
  const buttons = popup && is(popup, 'y+_') ? within(popup, name).filter(node =>
    node.attributes.class === 'android.widget.Button' && node.attributes.text === text
    && node.attributes.clickable === 'true') : [];
  if (buttons.length !== 1) throw new DeviceError('filter_ambiguous', 'Native filter apply button is missing or ambiguous');
  return `//*[@package=${xpathLiteral(PACKAGE)} and @resource-id=${xpathLiteral(id('y+_'))}]`
    + `//*[@resource-id=${xpathLiteral(id(name))} and @text=${xpathLiteral(text)} and @clickable='true'`
    + ` and @bounds=${xpathLiteral(buttons[0].attributes.bounds)}]`;
}

export function nativeFilterApplySelector(tree) {
  return popupButtonSelector(panelState(tree).panel, 'beg', '查看结果');
}

/** Only the measured missing scope marker qualifies. All other choices must be readable and unambiguous. */
export function nativeFilterResetState(tree) {
  const {panel, groups} = panelState(tree, {repairScope: true});
  if (!groups['搜索范围'].some(item => item.selected === null)) return null;
  return {selector: popupButtonSelector(panel, 'bo6', '重置选项'),
    knownGroups: Object.fromEntries(FILTER_GROUPS.map(group => [group, groups[group].find(item => item.selected === true)?.choice ?? null]))};
}
