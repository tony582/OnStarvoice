import {descendants, visible, xpathLiteral} from './ui-tree.mjs';
import {DeviceError} from './bounded.mjs';

// All choices below were read on the physical 40.6.0 filter panel.
export const FILTER_OPTIONS = Object.freeze({
  排序依据:['综合排序','最新发布','最多点赞','最多评论','最多收藏'],
  发布时间:['不限','一天内','一周内','半年内'],
  视频时长:['不限','1分钟以下','1-5分钟','5分钟以上'],
  搜索范围:['不限','关注的人','最近看过','还未看过'],
  内容形式:['不限','视频','图文'],
  位置距离:['不限','同城'],
});
export const FILTER_GROUPS = ['排序依据','发布时间','视频时长','搜索范围','内容形式','位置距离'];
const panels = tree => tree.nodes.filter(node => visible(node) && node.attributes.class === 'android.widget.ScrollView'
  && node.children.some(child => child.attributes.text === '排序依据'));
export const hasSemanticFilters = tree => panels(tree).length > 0;
export function readSemanticFilters(tree) {
  const matches = panels(tree);
  if (matches.length !== 1) throw new DeviceError('filter_ambiguous','Filter panel is missing or ambiguous');
  const result = {}; let group = null;
  for (const node of matches[0].children) {
    if (node.attributes.class === 'android.widget.TextView' && FILTER_GROUPS.includes(node.attributes.text)) {
      group = node.attributes.text;
      if (Object.hasOwn(result,group)) throw new DeviceError('filter_ambiguous','Duplicate filter group');
      result[group] = [];
    } else if (group) {
      for (const child of [node,...descendants(node)].filter(visible)) {
        const choice = child.attributes['content-desc']?.match(/^已选中，(.+)，按钮$/u)?.[1];
        if (choice) result[group].push(choice);
      }
    }
  }
  if (FILTER_GROUPS.some(key => result[key]?.length !== 1)) throw new DeviceError('filter_unverified','Every group must have one selected choice');
  return Object.fromEntries(FILTER_GROUPS.map(key => [key,result[key][0]]));
}
export function semanticFilterSelector(group, choice, tree) {
  if (!FILTER_OPTIONS[group]?.includes(choice)) throw new DeviceError('filter_unverified','Unknown filter choice');
  const matches = panels(tree);
  if (matches.length !== 1) throw new DeviceError('filter_ambiguous','Filter panel is missing or ambiguous');
  let current = null;
  const targets = [];
  for (const node of matches[0].children) {
    if (node.attributes.class === 'android.widget.TextView' && FILTER_GROUPS.includes(node.attributes.text)) {
      current = node.attributes.text;
    } else if (current === group && node.attributes.clickable === 'true' && visible(node)
      && descendants(node).some(child => visible(child) && child.attributes.text === choice)) targets.push(node);
  }
  if (targets.length !== 1 || !/^\[\d+,\d+\]\[\d+,\d+\]$/u.test(targets[0].attributes.bounds ?? '')) {
    throw new DeviceError('filter_ambiguous','Filter choice is missing or ambiguous in its group');
  }
  // UiAutomator2's XPath snapshot does not reliably preserve sibling axes for these virtual views.
  // Bind to the current semantic group's measured bounds; the selected value is read back after clicking.
  return `//*[@class='android.widget.ScrollView' and *[@text='排序依据']]/*[@clickable='true' and @bounds=${xpathLiteral(targets[0].attributes.bounds)} and .//*[@text=${xpathLiteral(choice)}]]`;
}
