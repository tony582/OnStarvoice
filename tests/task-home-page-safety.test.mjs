import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const code = await readFile(new URL('../utils/task-home-page-safety.js', import.meta.url), 'utf8');
const registry = vm.createContext({});
vm.runInContext(code, registry);
const injected = `(${registry.OnStarvoiceTaskHomePageSafety.readDocument.toString()})()`;
const url = 'https://www.douyin.com/search/a';

// A small selector-capable DOM fixture exercises the serialized page function,
// with no module globals or injected helper dependencies in its execution realm.
class Element {
  constructor(tag = 'div', {text = '', attributes = {}, children = [], style = {}, hidden = false} = {}) {
    Object.assign(this, {tag, attributes, children, hidden, isConnected: true, width: 500, height: 100});
    this.style = {display: 'block', visibility: 'visible', opacity: '1', ...style};
    this.innerText = text; this.textContent = text;
    for (const child of children) child.parentElement = this;
  }
  getAttribute(key) {return this.attributes[key] ?? null;}
  getBoundingClientRect() {return {width: this.width, height: this.height};}
  matches(selector) {
    return selector.split(',').some(raw => {
      const value = raw.trim();
      if (value.startsWith('.')) return String(this.attributes.class || '').split(/\s+/).includes(value.slice(1));
      if (!value.startsWith('[')) return this.tag === value;
      const match = value.match(/^\[([^\s=\^\*\]]+)(?:(\*=|\^=|=)"([^"]*)")?(?: (i))?\]$/);
      assert.ok(match, `supported selector: ${value}`);
      let actual = this.attributes[match[1]], expected = match[3];
      if (actual === undefined) return false;
      if (!match[2]) return true;
      actual = String(actual);
      if (match[4]) {actual = actual.toLowerCase(); expected = expected.toLowerCase();}
      return match[2] === '*=' ? actual.includes(expected) : match[2] === '^=' ? actual.startsWith(expected) : actual === expected;
    });
  }
  closest(selector) {for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null;}
  querySelectorAll(selector) {return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);}
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
}
function page({nodes = [], text = '', title = '', pageUrl = url, readyState = 'complete', configure} = {}) {
  const body = new Element('body', {text, children: nodes});
  const html = new Element('html', {children: [body]});
  const document = {body, documentElement: html, title, readyState,
    querySelectorAll: selector => html.querySelectorAll(selector)};
  const context = {URL, document, location: new URL(pageUrl), getComputedStyle: node => node.style};
  configure?.(context);
  return JSON.parse(JSON.stringify(vm.runInNewContext(injected, context)));
}
const dialog = text => new Element('div', {text, attributes: {role: 'dialog'}});
const challenge = () => dialog('请完成下列验证后继续：');
const card = (...children) => new Element('section', {attributes: {class: 'search-result-card'}, children});

test('serialized detector is self-contained and returns only URL and a boolean on normal pages', () => {
  for (const pageUrl of [url, 'https://www.douyin.com/jingxuan', 'https://www.xiaohongshu.com/search_result/?keyword=a', 'https://weibo.com/']) {
    assert.deepEqual(page({pageUrl}), {url: pageUrl, safeForCleanup: true});
  }
});

test('same-URL blocking login modal is protected while normal header login text is harmless', () => {
  assert.equal(page({nodes: [dialog('扫码登录后继续')]}).safeForCleanup, false);
  assert.equal(page({nodes: [new Element('button', {text: '扫码登录'})]}).safeForCleanup, true);
  assert.equal(page({pageUrl: 'https://www.douyin.com/passport/login'}).safeForCleanup, false);
});

test('visible structured image challenges and verification frames are protected', () => {
  for (const node of [challenge(), dialog('请选择所有符合上述描述的图片，并拖拽到下方'),
    new Element('iframe', {attributes: {src: 'https://verify.example/challenge'}})]) {
    assert.equal(page({nodes: [node]}).safeForCleanup, false);
  }
  assert.equal(page({title: '抖音验证码中间页'}).safeForCleanup, false);
});

test('opaque visible captcha surfaces are protected and a newly appearing same-URL dialog is rechecked', () => {
  const captcha = new Element('div', {attributes: {class: 'captcha-container'}});
  assert.equal(page({nodes: [captcha]}).safeForCleanup, false);
  assert.equal(page({nodes: [card(captcha)]}).safeForCleanup, true);
  const modal = dialog('扫码登录'); modal.hidden = true;
  assert.equal(page({nodes: [modal]}).safeForCleanup, true);
  modal.hidden = false;
  assert.deepEqual(page({nodes: [modal]}), {url, safeForCleanup: false});
});

test('hidden overlays and overlays under a hidden ancestor do not block cleanup', () => {
  for (const style of [{display: 'none'}, {visibility: 'hidden'}, {opacity: '0'}]) {
    const parent = new Element('div', {style, children: [challenge()]});
    assert.equal(page({nodes: [parent]}).safeForCleanup, true);
  }
  assert.equal(page({nodes: [new Element('div', {hidden: true, children: [dialog('扫码登录')]})]}).safeForCleanup, true);
});

test('post copy, embedded post frames, and page wrappers containing cards are not safety evidence', () => {
  assert.equal(page({text: '请完成下列验证后继续', nodes: [card(challenge(), new Element('iframe', {attributes: {src: '/captcha'}}))]}).safeForCleanup, true);
  assert.equal(page({nodes: [new Element('div', {attributes: {role: 'dialog'}, text: '请完成下列验证后继续', children: [card()]})]}).safeForCleanup, true);
  assert.equal(page({nodes: [card(challenge()), challenge()]}).safeForCleanup, false);
});

test('generic numeric data attributes cannot disguise a real security dialog as a post', () => {
  for (const attributes of [{'data-id': '123456789'}, {'data-item-id': '123456789'}]) {
    assert.equal(page({nodes: [new Element('div', {attributes, children: [challenge()]})]}).safeForCleanup, false);
  }
});

test('Xiaohongshu protection uses exact multilingual combinations, not a single quoted phrase', () => {
  const pageUrl = 'https://www.xiaohongshu.com/explore';
  for (const text of ['安全限制 访问频繁 稍后再试 300013', '安全限制 访问频繁 稍后再试 我要反馈 返回首页',
    'Scan with logged-in REDNote app for account security', 'Requests too frequent. Try again after 1 minute']) {
    assert.equal(page({pageUrl, text}).safeForCleanup, false, text);
    assert.equal(page({pageUrl, text, nodes: [card(new Element('p', {text}))]}).safeForCleanup, true, text);
    assert.equal(page({pageUrl, nodes: [card(), dialog(text)]}).safeForCleanup, false, text);
  }
  assert.equal(page({pageUrl, text: '访问频繁'}).safeForCleanup, true);
});

test('loading, unsupported hosts, missing DOM, script errors and unknown geometry fail closed', () => {
  for (const options of [{readyState: 'loading'}, {pageUrl: 'https://example.com/'},
    {configure: c => {c.document.body = null;}}, {configure: c => {delete c.document;}},
    {configure: c => {c.document.querySelectorAll = () => {throw Error('DOM unavailable');};}},
    {nodes: [challenge()], configure: c => {c.getComputedStyle = () => {throw Error('style unavailable');};}},
    {nodes: [challenge()], configure: c => {c.document.body.children[0].width = NaN;}}]) {
    assert.equal(page(options).safeForCleanup, false);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(injected, {}))), {url: '', safeForCleanup: false});
});
