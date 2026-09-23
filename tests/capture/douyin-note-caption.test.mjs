import assert from 'node:assert/strict';
import test from 'node:test';
import {el} from '../fixtures/author-dom.mjs';
import {extractDouyinTitle} from '../../utils/capture/douyin-single-note.js';

const short = '机壁纸换上这一幕，红歌一响，瞬间肃然起敬。 人民，只有人民，';
const body = short + '才是创造世界历史的动力。';
const topics = ['#人民万岁', '#国庆', '#家国情怀', '#别克君越'];

test('image-note caption keeps the complete body and hashtags instead of the SEO title', () => {
  // Observed /note/7688275159347077243: caption is a div, not video-desc/h1.
  const caption = el('div', {class: 'daVLa2m7'}, el('div', {class: 'wB7XlRLR'},
    el('div', {class: 'RMlWQIcN'}, el('div', {class: 'Bfj9rfeR'},
      el('span', {}, body, ...topics.map(topic => el('a', {href: '/hashtag/1'}, ' ' + topic)))))));
  const root = el('main', {'data-e2e': 'note-detail'},
    el('div', {'data-e2e': 'user-info'}, el('h1', {}, 'morning')),
    caption,
    el('div', {class: 'noteSideBarContainer'}, el('h3', {}, '另一条推荐内容')));
  globalThis.document = el('body', {}, root);
  document.title = short + ' - 抖音';
  assert.equal(extractDouyinTitle(root), body + ' ' + topics.join(' '));
});

test('caption lookup cannot borrow a full body from another detail outside the bound root', () => {
  const root = el('main', {'data-e2e': 'note-detail'});
  globalThis.document = el('body', {}, root,
    el('div', {'data-e2e': 'video-desc'}, '另一篇更长的完整正文'));
  document.title = short + ' - 抖音';
  assert.equal(extractDouyinTitle(root), short);
});

test('existing video captions still include official mentions as body text', () => {
  const text = '新壁纸很好看 @上海安吉星信息服务有限公司 #别克';
  const root = el('main', {}, el('div', {'data-e2e': 'video-desc'}, text));
  globalThis.document = el('body', {}, root);
  document.title = '短标题 - 抖音';
  assert.equal(extractDouyinTitle(root), text);
});

test('caption keeps inline emoji images in document order without decorative image labels', () => {
  const root=el('main', {'data-e2e':'note-detail'},
    el('div', {'data-e2e':'video-desc'}, '换上新壁纸，感觉整个人的磁场都变强了',
      el('img', {alt:'🚩'}), '。', el('a', {}, '#汽车里的爱国情怀'), ' #人民万岁',
      el('img', {alt:'认证标识'}), el('button', {}, '展开')));
  globalThis.document=el('body', {}, root, el('div', {'data-e2e':'video-desc'}, '其他作品🚗'));
  document.title='换上新壁纸 - 抖音';
  assert.equal(extractDouyinTitle(root),'换上新壁纸，感觉整个人的磁场都变强了🚩。#汽车里的爱国情怀 #人民万岁');
});

test('caption preserves native emoji, flags, keycaps and skin-tone sequences once', () => {
  const root=el('main', {}, el('div', {'data-e2e':'video-desc'}, '喜欢🐰',
    el('span', {}, el('img', {alt:'🇨🇳'}), el('img', {alt:'1️⃣'}), el('img', {alt:'👧🏻'})),
    el('span', {'aria-hidden':'true'}, '隐藏标签'), el('svg', {}, '图标说明')));
  globalThis.document=el('body', {}, root);document.title='短标题 - 抖音';
  assert.equal(extractDouyinTitle(root),'喜欢🐰🇨🇳1️⃣👧🏻');
});
