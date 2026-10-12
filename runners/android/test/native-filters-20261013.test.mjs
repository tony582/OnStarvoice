import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseUiTree, descendants} from '../src/device/ui-tree.mjs';
import {DeviceError} from '../src/device/bounded.mjs';
import {hasNativeFilters, readNativeFilters, nativeFilterSelector, nativeFilterApplySelector} from '../src/device/douyin-native-filters.mjs';
import {readFilters, readSearch, filtersMatch} from '../src/device/douyin-profile.mjs';
import {createDouyinCalibrationFlow} from '../src/calibration/douyin-flow.mjs';

// Actual DE106 popup captured with multi-window source. System UI and account/content data were removed;
// only the filter controls and an anonymized underlying search header remain.
const xml = readFileSync(new URL('./fixtures/douyin-native-filter-popup-20261013.xml', import.meta.url), 'utf8');
const keyword = '测试关键词';
const desired = {sort: '综合排序', time: '一天内', content: '不限'};
const fixture = () => parseUiTree(xml);
const label = (tree, group) => tree.nodes.find(node => node.attributes.text === group);
function select(tree, group, choice) {
  for (const node of descendants(label(tree, group).parent)) {
    const state = node.attributes['content-desc']?.match(/^(?:已选中|未选中)，(.+)，按钮$/u);
    if (state) node.attributes['content-desc'] = `${state[1] === choice ? '已选中' : '未选中'}，${state[1]}，按钮`;
  }
  return tree;
}
const results = () => {
  const tree = fixture();
  const popup = tree.root.children[0];
  const hidden = new Set([popup, ...descendants(popup)]);
  tree.root.children = tree.root.children.slice(1);
  tree.nodes = tree.nodes.filter(node => !hidden.has(node));
  return tree;
};

test('the real native popup reads all six selections and cannot be mistaken for the results behind it', () => {
  const tree = fixture();
  assert.equal(hasNativeFilters(tree), true);
  assert.deepEqual(readFilters(tree), {排序依据: '综合排序', 发布时间: '不限', 视频时长: '不限',
    搜索范围: '不限', 内容形式: '不限', 位置距离: '不限'});
  assert.equal(filtersMatch(readFilters(tree), desired), false);
  assert.equal(readSearch(tree, keyword).verified, false);
  select(tree, '发布时间', '一天内');
  assert.equal(filtersMatch(readFilters(tree), desired), true);
  assert.equal(readSearch(tree, keyword).verified, false, 'a selected but unapplied popup is still not a result');
  assert.equal(readSearch(results(), keyword).verified, true);
});

test('native choices are bound to their group and the apply action is 查看结果', () => {
  const tree = fixture();
  const day = nativeFilterSelector('发布时间', '一天内', tree);
  assert.match(day, /@text='发布时间'/u);
  assert.match(day, /@text='一天内'/u);
  assert.match(day, /@bounds='\[295,688\]\[530,768\]'/u);
  const time = nativeFilterSelector('视频时长', '不限', tree);
  const location = nativeFilterSelector('位置距离', '不限', tree);
  assert.notEqual(time, location);
  assert.match(time, /@bounds='\[40,867\]\[275,947\]'/u);
  assert.match(location, /@bounds='\[40,1404\]\[275,1484\]'/u);
  assert.match(nativeFilterApplySelector(tree), /@text='查看结果'/u);
  assert.throws(() => nativeFilterSelector('发布时间', '一个月内', tree), {code: 'filter_unverified'});
});

test('native readback rejects missing groups, duplicate panels and ambiguous or inconsistent selections', () => {
  const missing = fixture(); label(missing, '位置距离').parent.attributes.displayed = 'false';
  assert.throws(() => readNativeFilters(missing), {code: 'filter_unverified'});
  const repeated = fixture(); repeated.nodes.push(repeated.nodes.find(node =>
    node.attributes['resource-id']?.endsWith('/iu1') && node.attributes.class === 'androidx.recyclerview.widget.RecyclerView'));
  assert.throws(() => readNativeFilters(repeated), {code: 'filter_ambiguous'});
  const ambiguous = fixture();
  ambiguous.nodes.find(node => node.attributes['content-desc'] === '未选中，一天内，按钮')
    .attributes['content-desc'] = '已选中，一天内，按钮';
  assert.throws(() => readNativeFilters(ambiguous), {code: 'filter_unverified'});
  const inconsistent = fixture();
  inconsistent.nodes.find(node => node.attributes['content-desc'] === '未选中，一天内，按钮')
    .attributes['content-desc'] = '未选中，一周内，按钮';
  assert.throws(() => nativeFilterSelector('发布时间', '一天内', inconsistent), {code: 'filter_unverified'});
  const noApply = fixture(); noApply.nodes.find(node => node.attributes.text === '查看结果').attributes.displayed = 'false';
  assert.throws(() => nativeFilterApplySelector(noApply), {code: 'filter_ambiguous'});
});

function scenario({ignoreDay = false, ignoreApply = false, missingPanel = false, transientPanel = false, time = '不限', location = '不限'} = {}) {
  const panel = select(select(fixture(), '发布时间', time), '位置距离', location);
  const opening = fixture(); label(opening, '位置距离').parent.attributes.displayed = 'false';
  const page = results(), actions = [], scopes = [];
  let popup = false, multi = false;
  const current = () => popup && multi && !missingPanel ? panel : page;
  const ui = {
    setWindowScope: async value => { multi = value; scopes.push(value); },
    read: async () => current(),
    waitFor: async predicate => {
      const frames = popup && multi && transientPanel ? [opening, current()] : [current()];
      for (const tree of frames) if (predicate(tree)) return tree;
      throw new DeviceError('device_timeout', 'Fixture readiness timed out');
    },
    input: async () => {}, clickId: async () => {},
    clickXPath: async selector => {
      actions.push(selector);
      if (selector.includes('筛选，按钮')) popup = true;
      else if (selector.includes("@text='发布时间'")) { if (!ignoreDay) select(panel, '发布时间', '一天内'); }
      else if (selector.includes("@text='位置距离'")) select(panel, '位置距离', '不限');
      else if (selector.includes("@text='查看结果'")) {
        assert.equal(multi, true, 'the popup must remain readable through apply');
        assert.equal(filtersMatch(readFilters(panel), desired), true);
        if (!ignoreApply) popup = false;
      } else assert.fail(`unexpected click: ${selector}`);
    },
  };
  return {flow: createDouyinCalibrationFlow({ui}), actions, scopes, panel};
}

test('search reads the separate popup, selects one day and resets location before applying and restoring scope', async () => {
  const run = scenario({location: '同城'});
  assert.equal((await run.flow.search({keyword, filters: desired})).verified, true);
  assert.deepEqual(run.scopes, [false, true, false]);
  assert.equal(run.actions.length, 4);
  assert.match(run.actions[1], /@text='一天内'/u);
  assert.match(run.actions[2], /@text='位置距离'/u);
  assert.match(run.actions[3], /@text='查看结果'/u);
});

test('opening and selection animations wait for complete filter readback before clicking or applying', async () => {
  const run = scenario({transientPanel: true});
  assert.equal((await run.flow.search({keyword, filters: desired})).verified, true);
  assert.equal((await run.flow.adoptCurrentSearch({keyword, filters: desired})).verified, true);
  assert.equal(run.scopes.at(-1), false);
});

test('a day selection that did not stick never applies, and a popup that did not close never becomes success', async () => {
  for (const options of [{ignoreDay: true}, {ignoreApply: true}, {missingPanel: true}]) {
    const run = scenario(options);
    await assert.rejects(run.flow.search({keyword, filters: desired}), {code: 'device_timeout'});
    assert.equal(run.scopes.at(-1), false);
    await assert.rejects(run.flow.readCards(), {code: 'search_context_unverified'});
    if (options.ignoreDay || options.missingPanel) assert.equal(run.actions.some(action => action.includes("@text='查看结果'")), false);
  }
});

test('reopening the native popup verifies the applied day filter and rejects unlimited instead of silently adopting it', async () => {
  const run = scenario({time: '一天内'});
  assert.equal((await run.flow.adoptCurrentSearch({keyword, filters: desired})).verified, true);
  assert.deepEqual(run.scopes, [true, false]);
  assert.equal(run.actions.length, 2);
  const wrong = scenario();
  await assert.rejects(wrong.flow.adoptCurrentSearch({keyword, filters: desired}), {code: 'search_filters_changed'});
  assert.equal(wrong.actions.length, 1);
  assert.equal(wrong.scopes.at(-1), false);
});
