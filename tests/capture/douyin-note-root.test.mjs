import assert from 'node:assert/strict';
import test from 'node:test';
import {AuthorDomNode, el} from '../fixtures/author-dom.mjs';
import {findDirectDouyinNoteRoot} from '../../utils/capture/douyin-note-root.js';
import {resolveActiveDouyinDetailRoot, extractDouyinTitle,
  extractDouyinAuthorInfo} from '../../utils/capture/douyin-single-note.js';

const id = '7688400908224987643';
const url = `https://www.douyin.com/note/${id}`;
const authorId = 'MS4wLjABAAAA_publisher';
const body = '别克又出新壁纸啦！第一张《月兔栖梦》:小兔子抱着发光的月亮，配上黄色小花，画面温柔治愈。';
const caption = body + ' 第二张《檐下秋意》:深蓝流动星河背景。#安吉星车机壁纸 @上海安吉星信息服务有限公司';
const note = () => el('main', {'data-e2e': 'note-detail'},
  el('div', {class: 'focusPanel'}, el('video')),
  el('div', {'data-e2e': 'user-info'},
    el('a', {href: `/user/${authorId}`}, el('div', {'data-click-from': 'title'}, '没你不行'))),
  el('div', {class: 'daVLa2m7'}, el('div', {class: 'Bfj9rfeR'}, caption)));
const find = (document, options = {}) => findDirectDouyinNoteRoot({
  url, expectedNoteId: id, document, isVisible: () => true, ...options,
});

test('a playing image-note preview cannot hide the full caption or publisher from the existing collector', () => {
  const root = note();
  const video = root.querySelector('video');
  Object.assign(video, {paused: false, ended: false, readyState: 4});
  globalThis.Element = AuthorDomNode;
  globalThis.document = el('body', {}, root);
  document.title = body.slice(0, 30) + ' - 抖音';
  globalThis.window = {location: {href: url}, innerWidth: 1200, innerHeight: 900,
    getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'})};
  const bound = resolveActiveDouyinDetailRoot(id);
  assert.equal(bound, root);
  assert.equal(extractDouyinTitle(bound), caption);
  assert.deepEqual(extractDouyinAuthorInfo(bound), {
    name: '没你不行', userId: authorId, url: `https://www.douyin.com/user/${authorId}`,
  });
});

test('direct note roots require an exact route identity and do not widen video or search-modal scope', () => {
  const document = el('body', {}, note());
  assert.equal(find(document), document.children[0]);
  for (const otherUrl of [
    `https://www.douyin.com/video/${id}`,
    `https://www.douyin.com/search/别克?modal_id=${id}`,
    url + '?modal_id=7688400908224987644',
    url + '?modal_id=' ,
    url + '/recommendation',
    `https://douyin.com.example/note/${id}`,
  ]) assert.equal(find(document, {url: otherUrl}), null);
  assert.equal(find(document, {expectedNoteId: '7688400908224987644'}), null);
});

test('hidden or ambiguous note pages cannot replace the bound root', () => {
  const visible = note();
  const document = el('body', {}, el('div', {'aria-hidden': 'true'}, note()), visible);
  assert.equal(find(document), visible);
  assert.equal(find(el('body', {}, el('div', {hidden: ''}, note()))), null);
  assert.equal(find(el('body', {}, note()), {isVisible: () => false}), null);
  assert.equal(find(el('body', {}, note(), note())), null);
});

test('a media-only note page or a body mention is insufficient publisher evidence', () => {
  const root = el('main', {'data-e2e': 'note-detail'},
    el('div', {class: 'focusPanel'}, el('video')),
    el('div', {class: 'daVLa2m7'}, el('div', {class: 'Bfj9rfeR'},
      el('a', {href: '/user/official'}, '@上海安吉星信息服务有限公司'))));
  assert.equal(find(el('body', {}, root)), null);
});
