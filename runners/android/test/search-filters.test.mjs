import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {filtersMatch, readFilters, resource} from '../src/device/douyin-profile.mjs';
import {mapSearchFilters} from '../src/device/profile-adapter.mjs';
import {createDouyinCalibrationFlow} from '../src/calibration/douyin-flow.mjs';

const encode = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const node = (id, text = '', children = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${encode(value)}"`).join(' ')}>${children}</android.widget.TextView>`;
const tree = body => parseUiTree(`<hierarchy>${body}</hierarchy>`);
const group = (label, selected) => node('uxo', '', node('hdi', label) + node('urc', '', node('rmy', selected), { 'content-desc': `已选中，${selected}，按钮` }));

test('public filters map to the calibrated Chinese labels, including the legacy range form', () => {
  assert.deepEqual(mapSearchFilters({sort: 'comprehensive', publishTime: 'all', contentType: 'all'}),
    {sort: '综合排序', time: '不限', content: '不限'});
  assert.deepEqual(mapSearchFilters({sort: 'latest', publishTime: 'week', contentType: 'image'}),
    {sort: '最新发布', time: '一周内', content: '图文'});
  assert.deepEqual(mapSearchFilters({sort: 'likes', publishTime: 'halfyear', contentType: 'video'}),
    {sort: '最多点赞', time: '半年内', content: '视频'});
  assert.deepEqual(mapSearchFilters({sort: 'comments', range: 'day'}), {sort: '最多评论', time: '一天内', content: '不限'});
  assert.deepEqual(mapSearchFilters({sort: 'collects', range: 'day'}), {sort: '最多收藏', time: '一天内', content: '不限'});
});

test('unsupported filter values are rejected before any UI action', () => {
  for (const filters of [{sort: 'trending', publishTime: 'all', contentType: 'all'},
    {sort: 'latest', publishTime: 'month', contentType: 'all'}, {sort: 'latest', publishTime: 'all', contentType: 'gif'},
    {sort: 'latest', range: 'week'}, {sort: 'latest', range: 'day', contentType: 'video'}, {sort: 'latest'}, null]) {
    assert.throws(() => mapSearchFilters(filters), {code: 'unsupported_search_filters'});
  }
});

test('filter readback compares every requested group and holds the rest at 不限', () => {
  const groups = readFilters(tree(group('排序依据', '最多点赞') + group('发布时间', '半年内')
    + group('视频时长', '不限') + group('搜索范围', '不限') + group('内容形式', '图文')));
  assert.equal(filtersMatch(groups, {sort: '最多点赞', time: '半年内', content: '图文'}), true);
  assert.equal(filtersMatch(groups, {sort: '最多点赞', time: '半年内', content: '视频'}), false, 'contentType is verified');
  assert.equal(filtersMatch(groups, {sort: '最多点赞', time: '半年内'}), false, 'omitted content defaults to 不限');
  const noisy = readFilters(tree(group('排序依据', '最多点赞') + group('发布时间', '半年内')
    + group('视频时长', '1分钟以下') + group('搜索范围', '不限') + group('内容形式', '图文')));
  assert.equal(filtersMatch(noisy, {sort: '最多点赞', time: '半年内', content: '图文'}), false, 'an untouched group must stay 不限');
});

test('the calibration flow selects and re-verifies a non-default content type', async () => {
  const header = node('et_search_kw', '别克壁纸') + node('tab', '综合', '', {'resource-id': 'android:id/text1', selected: 'true'});
  const page = tree(header + node('b87', '', node('desc', '标题') + node('ab0', '作者')));
  const filters = content => tree(group('排序依据', '最新发布') + group('发布时间', '一天内')
    + group('视频时长', '不限') + group('搜索范围', '不限') + group('内容形式', content));
  const build = shownContent => {
    let current = page;
    const ui = {setWindowScope: async () => {}, read: async () => current,
      waitFor: async predicate => { assert.equal(predicate(current), true); return current; },
      clickXPath: async selector => { current = selector.includes('筛选，按钮') ? filters(shownContent) : page; },
      clickId: async id => { if (id === 'zsg') current = page; }};
    return createDouyinCalibrationFlow({ui});
  };
  const search = await build('图文').adoptCurrentSearch({keyword: '别克壁纸', filters: {sort: '最新发布', time: '一天内', content: '图文'}});
  assert.equal(search.verified, true);
  await assert.rejects(build('不限').adoptCurrentSearch({keyword: '别克壁纸', filters: {sort: '最新发布', time: '一天内', content: '图文'}}),
    {code: 'search_filters_changed'});
});

test('the flow rejects an uncalibrated filter choice before touching the UI', async () => {
  let touched = 0;
  const flow = createDouyinCalibrationFlow({ui: {setWindowScope: async () => { touched++; }, read: async () => { touched++; }}});
  await assert.rejects(flow.search({keyword: '别克壁纸', filters: {sort: '综合排序', time: '一天内', content: 'GIF'}}),
    {code: 'unsupported_calibration_search'});
  assert.equal(touched, 0);
});
