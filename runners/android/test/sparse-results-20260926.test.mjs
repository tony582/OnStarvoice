import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUiTree } from '../src/device/ui-tree.mjs';
import { resource } from '../src/device/douyin-profile.mjs';
import { createDouyinCalibrationFlow } from '../src/calibration/douyin-flow.mjs';
import { RunnerStore } from '../src/storage/runner-store.mjs';
import { runDiscoveryTask } from '../src/core/discovery-runner.mjs';
import { fixtureTask, fixtureClock, fixturePermit, fixtureDevice } from './core-fixtures.mjs';

// 09-26 20:04 run: 24 of 30 early endings were scroll_container_ambiguous on 一天内 keywords with
// 0-3 results. A short list fits one screen (Android marks it not scrollable) and an empty search has
// no list at all, so the first scroll failed instead of ending the keyword.
const encode = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const attrs = values => Object.entries(values).map(([key, value]) => `${key}="${encode(value)}"`).join(' ');
const node = (id, text = '', children = '', extra = {}) => `<android.widget.TextView ${attrs({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
})}>${children}</android.widget.TextView>`;
const list = (children, extra = {}) => `<androidx.recyclerview.widget.RecyclerView ${attrs({
  package: 'com.ss.android.ugc.aweme', class: 'androidx.recyclerview.widget.RecyclerView',
  'resource-id': resource('results_list'), scrollable: 'true', displayed: 'true', enabled: 'true',
  bounds: '[0,300][1080,2242]', ...extra,
})}>${children}</androidx.recyclerview.widget.RecyclerView>`;
const tree = body => parseUiTree(`<hierarchy>${body}</hierarchy>`);
const keyword = '别克OTA';
const header = node('et_search_kw', keyword) + node('tab', '综合', '', { 'resource-id': 'android:id/text1', selected: 'true' });
const cardNode = index => node('b87', '', node('desc', `别克OTA 升级实拍第${index}条`) + node('ab0', `车主${index}`) + node('za5', '1小时前'));
const group = (label, selected) => node('uxo', '', node('hdi', label) + node('urc', '', node('rmy', selected), { 'content-desc': `已选中，${selected}，按钮` }));
const filterPanel = tree(group('排序依据', '最新发布') + group('发布时间', '一天内') + group('视频时长', '不限') + group('搜索范围', '不限') + group('内容形式', '不限'));

// A fake phone that shows `page` and then, read by read, the pages queued in `later`.
function fakePhone(page, later = []) {
  let current = page; let panel = false; let clock = 0;
  const scrolls = []; let reads = 0;
  const ui = {
    setWindowScope: async () => {},
    read: async () => { clock += 6000; reads++; if (panel) return filterPanel; if (later.length) current = later.shift(); return current; },
    waitFor: async predicate => { const shown = panel ? filterPanel : current; assert.equal(predicate(shown), true); return shown; },
    clickXPath: async selector => { if (!selector.includes('筛选，按钮')) throw new Error(`unexpected ${selector}`); panel = true; },
    clickId: async id => { if (id !== 'zsg') throw new Error(`unexpected click ${id}`); panel = false; },
    scroll: async id => { scrolls.push(id); },
  };
  return { ui, scrolls, now: () => clock, get reads() { return reads; } };
}
async function adopted(phone) {
  const flow = createDouyinCalibrationFlow({ ui: phone.ui, now: phone.now });
  await flow.adoptCurrentSearch({ keyword, filters: { sort: '最新发布', time: '一天内' } });
  return flow;
}

test('a short result list that fits on one screen ends the keyword instead of failing the scroll', async () => {
  const phone = fakePhone(tree(header + list(cardNode(1) + cardNode(2), { scrollable: 'false' })));
  const flow = await adopted(phone);
  const page = await flow.scroll();
  assert.equal(page.end, true);
  assert.equal(page.cards.length, 2);
  assert.deepEqual(phone.scrolls, []);
});

test('an empty result ends the keyword only after waiting for late cards', async () => {
  const empty = fakePhone(tree(header));
  const flow = await adopted(empty);
  const before = empty.reads;
  const page = await flow.scroll();
  assert.equal(page.end, true);
  assert.equal(page.cards.length, 0);
  assert.ok(empty.reads - before >= 2, 'the empty page is re-read before it counts as the end');
  assert.deepEqual(empty.scrolls, []);

  const late = fakePhone(tree(header), [tree(header), tree(header + list(cardNode(1), { scrollable: 'false' }))]);
  const lateFlow = await adopted(late);
  const lateCards = await lateFlow.scroll();
  assert.equal(lateCards.end, undefined, 'late cards are read before the keyword can end');
  assert.equal(lateCards.cards.length, 1);
  assert.deepEqual(late.scrolls, []);
});

test('one scrollable result list still scrolls as before', async () => {
  const phone = fakePhone(tree(header + list(cardNode(1) + cardNode(2) + cardNode(3))));
  const flow = await adopted(phone);
  const page = await flow.scroll();
  assert.notEqual(page.end, true);
  assert.deepEqual(phone.scrolls, [resource('results_list')]);
});

test('an unresolved result list still fails, with a local diagnostic that carries no text', async () => {
  const twoLists = fakePhone(tree(header + list(cardNode(1)) + list(cardNode(2), { 'resource-id': resource('other_list') })));
  const flow = await adopted(twoLists);
  await assert.rejects(flow.scroll(), error => {
    assert.equal(error.code, 'scroll_container_ambiguous');
    assert.equal(error.diagnostic.stage, 'scroll');
    assert.deepEqual(error.diagnostic.cardLists.map(item => [item.id, item.scrollable, item.cards]),
      [[resource('results_list'), 'true', 1], [resource('other_list'), 'true', 1]]);
    assert.equal(error.diagnostic.scrollables.length, 2);
    assert.equal(JSON.stringify(error.diagnostic).includes('别克OTA'), false, 'no caption or keyword text');
    return true;
  });
  assert.deepEqual(twoLists.scrolls, []);

  // Cards outside any recognised list are an unknown layout, never mistaken for the end.
  const bare = fakePhone(tree(header + cardNode(1)));
  const bareFlow = await adopted(bare);
  await assert.rejects(bareFlow.scroll(), { code: 'scroll_container_ambiguous' });
});

test('a scroll that reports the end completes the keyword as results_end', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask(); const clock = fixtureClock();
    const { device, calls } = fixtureDevice(task, {
      readCards: async () => ({ contextVerified: true, contextId: 'context-1', end: false,
        cards: [{ cardId: 'card-1', title: '别克OTA 升级实拍', author: '车主', publishTimeRaw: '1小时前' }] }),
      scroll: async () => ({ contextVerified: true, contextId: 'context-1', end: true }),
    });
    const result = await runDiscoveryTask({ task, store, clock, device, permit: fixturePermit(task, clock) });
    assert.equal(result.status, 'completed');
    assert.equal(result.reason, 'results_end');
    assert.equal(result.stats.links, 1);
    assert.equal(calls.filter(name => name === 'scroll').length, 1);
  } finally { store.close(); }
});

test('a raw > inside a quoted value parses, and a broken attribute is located without text', () => {
  const parsed = parseUiTree('<hierarchy><node text="别克远控>设置 >_<" bounds="[0,0][1,1]"/></hierarchy>'
    .replace('>_<', '&gt;_&lt;'));
  assert.equal(parsed.nodes[1].attributes.text, '别克远控>设置 >_<');
  assert.throws(() => parseUiTree('<hierarchy><node text="x" 1bad="y"/></hierarchy>'), error => {
    assert.equal(error.code, 'invalid_ui_source');
    assert.equal(error.diagnostic.parser, 'invalid_attribute');
    assert.equal(error.diagnostic.tag, 'node');
    assert.equal(error.diagnostic.lastAttribute, 'text');
    assert.deepEqual(error.diagnostic.nextCodePoints, [...'1bad'].map(char => char.codePointAt(0)));
    return true;
  });
});
