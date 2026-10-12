import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseUiTree, descendants} from '../src/device/ui-tree.mjs';
import {DeviceError} from '../src/device/bounded.mjs';
import {hasNativeFilters, readNativeFilters, nativeFilterSelector, nativeFilterApplySelector, nativeFilterResetState} from '../src/device/douyin-native-filters.mjs';
import {readFilters, readSearch, filtersMatch} from '../src/device/douyin-profile.mjs';
import {createDouyinCalibrationFlow} from '../src/calibration/douyin-flow.mjs';

// Actual DE106 popup captured with multi-window source. System UI and account/content data were removed;
// only the filter controls and an anonymized underlying search header remain.
const xml = readFileSync(new URL('./fixtures/douyin-native-filter-popup-20261013.xml', import.meta.url), 'utf8');
const keyword = '测试关键词';
const desired = {sort: '综合排序', time: '一天内', content: '不限'};
const fixture = () => parseUiTree(xml);
const label = (tree, group) => tree.nodes.find(node => node.attributes.text === group);
const choices = (tree, group) => descendants(label(tree, group).parent).filter(node => node.attributes['resource-id']?.endsWith('/jhg'));
function select(tree, group, choice) {
  for (const node of choices(tree, group)) {
    const text = descendants(node).find(child => child.attributes['resource-id']?.endsWith('/vlc')).attributes.text;
    node.attributes['content-desc'] = `${text === choice ? '已选中' : '未选中'}，${text}，按钮`;
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

function scenario({ignoreDay = false, ignoreApply = false, missingPanel = false, transientPanel = false, time = '不限', location = '不限', missingScope = false, ignoreReset = false, homeLookupMs = 0} = {}) {
  const panel = select(select(fixture(), '发布时间', time), '位置距离', location);
  if (missingScope) delete choices(panel, '搜索范围')[0].attributes['content-desc'];
  const opening = fixture(); label(opening, '位置距离').parent.attributes.displayed = 'false';
  const page = results(), actions = [], scopes = [], actionOptions = [];
  const home = parseUiTree('<hierarchy><node package="com.ss.android.ugc.aweme" resource-id="com.ss.android.ugc.aweme:id/2r9" content-desc="搜索" displayed="true" bounds="[900,100][1050,200]"/></hierarchy>');
  let popup = false, multi = false, onHome = homeLookupMs > 0;
  const current = () => onHome ? home : popup && multi && !missingPanel ? panel : page;
  const ui = {
    setWindowScope: async value => { multi = value; scopes.push(value); },
    read: async () => current(),
    waitFor: async predicate => {
      const frames = popup && multi && transientPanel ? [opening, current()] : [current()];
      for (const tree of frames) if (predicate(tree)) return tree;
      throw new DeviceError('device_timeout', 'Fixture readiness timed out');
    },
    input: async () => {}, clickId: async () => {},
    clickXPath: async (selector, options) => {
      actions.push(selector); actionOptions.push(options);
      if (selector.includes("@content-desc='搜索'")) {
        if ((options?.timeoutMs ?? 5000) < homeLookupMs) throw new DeviceError('device_timeout', 'Slow home lookup timed out');
        onHome = false;
      }
      else if (selector.includes('筛选，按钮')) popup = true;
      else if (selector.includes("@text='重置选项'")) {
        if (!ignoreReset) for (const group of ['排序依据', '发布时间', '视频时长', '搜索范围', '内容形式', '位置距离']) {
          select(panel, group, group === '排序依据' ? '综合排序' : '不限');
        }
      }
      else if (selector.includes("@text='发布时间'")) { if (!ignoreDay) select(panel, '发布时间', '一天内'); }
      else if (selector.includes("@text='位置距离'")) select(panel, '位置距离', '不限');
      else if (selector.includes("@text='查看结果'")) {
        assert.equal(multi, true, 'the popup must remain readable through apply');
        assert.equal(filtersMatch(readFilters(panel), desired), true);
        if (!ignoreApply) popup = false;
      } else assert.fail(`unexpected click: ${selector}`);
    },
  };
  return {flow: createDouyinCalibrationFlow({ui}), actions, scopes, panel, actionOptions};
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

test('a missing scope marker only authorizes the measured reset, never a filter readback or apply', () => {
  const tree = fixture(); delete choices(tree, '搜索范围')[0].attributes['content-desc'];
  assert.throws(() => readNativeFilters(tree), {code: 'filter_unverified'});
  assert.throws(() => nativeFilterApplySelector(tree), {code: 'filter_unverified'});
  const reset = nativeFilterResetState(tree);
  assert.equal(reset.knownGroups['搜索范围'], null);
  assert.match(reset.selector, /@text='重置选项'/u);
  choices(tree, '搜索范围')[1].attributes['content-desc'] = '已选中，关注的人，按钮';
  assert.throws(() => nativeFilterResetState(tree), {code: 'filter_unverified'});
  const missingDay = fixture(); delete choices(missingDay, '发布时间')[0].attributes['content-desc'];
  assert.throws(() => nativeFilterResetState(missingDay), {code: 'filter_unverified'});
  const missingChoice = fixture(); delete choices(missingChoice, '搜索范围')[0].attributes['content-desc'];
  choices(missingChoice, '搜索范围')[3].attributes.displayed = 'false';
  assert.throws(() => nativeFilterResetState(missingChoice), {code: 'filter_unverified'});
});

test('search and reopening reset the missing scope marker once and then explicitly reapply one day', async () => {
  for (const operation of ['search', 'adoptCurrentSearch']) {
    const run = scenario({missingScope: true, time: '一天内'});
    assert.equal((await run.flow[operation]({keyword, filters: desired})).verified, true);
    assert.equal(run.actions.filter(action => action.includes("@text='重置选项'")).length, 1);
    const reset = run.actions.findIndex(action => action.includes("@text='重置选项'"));
    const day = run.actions.findIndex(action => action.includes("@text='一天内'"));
    const apply = run.actions.findIndex(action => action.includes("@text='查看结果'"));
    assert.ok(reset < day && day < apply);
    assert.equal(run.scopes.at(-1), false);
  }
});

test('reset failure remains bounded and recovery cannot erase a known changed filter', async () => {
  for (const operation of ['search', 'adoptCurrentSearch']) {
    const run = scenario({missingScope: true, ignoreReset: true, time: '一天内'});
    await assert.rejects(run.flow[operation]({keyword, filters: desired}), {code: 'device_timeout'});
    assert.equal(run.actions.filter(action => action.includes("@text='重置选项'")).length, 1);
    assert.equal(run.actions.some(action => action.includes("@text='查看结果'")), false);
    assert.equal(run.scopes.at(-1), false);
    await assert.rejects(run.flow.readCards(), {code: 'search_context_unverified'});
  }
  const changed = scenario({missingScope: true, time: '不限'});
  await assert.rejects(changed.flow.adoptCurrentSearch({keyword, filters: desired}), {code: 'search_filters_changed'});
  assert.equal(changed.actions.length, 1, 'no reset can hide a known time-filter mismatch');
});

test('the measured 6.7 second home lookup fits its own bound without extending later actions or retrying clicks', async () => {
  const run = scenario({homeLookupMs: 6700});
  const signal = new AbortController().signal;
  assert.equal((await run.flow.search({keyword, filters: desired, signal})).verified, true);
  assert.equal(run.actions.filter(action => action.includes("@content-desc='搜索'")).length, 1);
  assert.equal(run.actionOptions[0].timeoutMs, 10000);
  assert.equal(run.actionOptions[0].signal, signal);
  assert.ok(run.actionOptions.slice(1).every(options => options.timeoutMs === undefined && options.signal === signal));
  const stuck = scenario({homeLookupMs: 12000});
  await assert.rejects(stuck.flow.search({keyword, filters: desired}), {code: 'device_timeout', stage: 'search:entry'});
  assert.equal(stuck.actions.length, 1);
  await assert.rejects(stuck.flow.readCards(), {code: 'search_context_unverified'});
});
