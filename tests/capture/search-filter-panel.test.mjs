import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../content-v2.js', import.meta.url), 'utf8');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

class Element {
  constructor(tag = 'div', text = '', children = []) {
    this.tagName = tag.toUpperCase();
    this.text = text;
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    children.forEach(child => this.append(child));
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  contains(child) { return child === this || this.children.some(node => node.contains(child)); }
  get innerText() { return [this.text, ...this.children.map(node => node.innerText)].join(' '); }
  getBoundingClientRect() {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden) return {width: 0, height: 0};
    }
    return {width: 100, height: 30};
  }
  querySelectorAll(selector) {
    const tags = selector.split(',').map(tag => tag.trim().toUpperCase());
    return this.children.flatMap(child => [
      ...(tags.includes(child.tagName) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const row = (label, options) => new Element('div', '', [
  new Element('div', label), ...options.map(option => new Element('span', option)),
]);
const menu = () => new Element('div', '', [
  row('排序依据', ['综合排序', '最新发布', '最多点赞']),
  row('发布时间', ['不限', '一天内', '一周内', '半年内']),
  row('视频时长', ['不限', '1分钟以下', '1-5分钟', '5分钟以上']),
  row('搜索范围', ['不限', '关注的人', '最近看过', '还未看过']),
  row('内容形式', ['不限', '视频', '图文']),
]);
function harness(body) {
  const context = vm.createContext({document: body, HTMLElement: Element});
  vm.runInContext([
    slice('function findStrategyFilterPanel()', 'async function closeKeywordStrategyFilterPanel('),
    slice('function normalizeStrategyText(', 'function isStrategyControlActive('),
    'globalThis.find = findStrategyFilterPanel;',
  ].join('\n'), context);
  return context;
}

test('Douyin AI answer with 时间 and 距离 is not an open filter menu', () => {
  const body = new Element('body', '', [new Element('div', '', [
    new Element('p', '耗电：节能设计，但长时间停放建议插电；'),
    new Element('p', '触发：碰撞 / 近距离移动时启动，轻微震动可能不触发；'),
  ])]);
  assert.equal(harness(body).find(), null);
});

test('one section cannot count twice via 发布时间/时间 or 排序依据/排序 aliases', () => {
  for (const section of [row('发布时间', ['不限', '一天内']), row('排序依据', ['综合排序', '最新发布'])]) {
    assert.equal(harness(new Element('body', '', [new Element('div', '', [section])])).find(), null);
  }
});

test('exact headings in search content without filter options are not a menu', () => {
  assert.equal(harness(new Element('body', '', [new Element('div', '', [
    new Element('div', '时间'), new Element('p', '长时间停车如何省电'),
    new Element('div', '距离'), new Element('p', '近距离移动才会触发'),
  ])])).find(), null);
});

test('real Douyin rows select the menu itself, not the AI answer or page wrapper', () => {
  const panel = menu();
  const body = new Element('body', '', [new Element('div', '', [
    new Element('div', '长时间停放 / 近距离移动'),
    new Element('div', '', [new Element('span', '筛选'), panel]),
  ])]);
  assert.equal(harness(body).find(), panel);
});

test('XHS note-type/time rows and nested label/option wrappers remain supported', () => {
  const panel = new Element('div', '', [
    new Element('div', '', [new Element('div', '', [new Element('span', '笔记类型')]),
      new Element('div', '', [new Element('span', '不限'), new Element('span', '图文'), new Element('span', '视频')])]),
    row('发布时间', ['不限', '一天内', '一周内', '半年内']),
  ]);
  assert.equal(harness(new Element('body', '', [panel])).find(), panel);
});

test('hidden menu options cannot make the closed filter appear open', () => {
  const panel = menu();
  panel.hidden = true;
  assert.equal(harness(new Element('body', '', [panel])).find(), null);
});

test('an AI answer no longer prevents opening the real filter menu', async () => {
  const panel = menu();
  panel.hidden = true;
  const body = new Element('body', '', [new Element('div', '长时间停放 / 近距离移动'), panel]);
  const context = harness(body);
  let clicks = 0;
  Object.assign(context, {
    findStrategyClickableByText: () => null,
    findStrategyFilterTrigger: () => new Element('span', '筛选'),
    clickStrategyElement: () => { clicks += 1; panel.hidden = false; },
    waitForKeywordStrategyUi: async () => {},
  });
  vm.runInContext(`${slice('async function ensureKeywordStrategyFilterPanelOpen(', 'function findStrategyFilterPanel()')}\nglobalThis.open = ensureKeywordStrategyFilterPanelOpen;`, context);
  assert.equal(await context.open([]), true);
  assert.equal(clicks, 1);
  assert.equal(context.find(), panel);
});
