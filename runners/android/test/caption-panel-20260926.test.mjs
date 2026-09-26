import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {resource} from '../src/device/douyin-profile.mjs';
import {readVerifiedDetail} from '../src/device/douyin-detail.mjs';
import {faultDetails} from '../src/core/discovery-runner.mjs';

// Measured on the DE106 (Douyin 40.6.0) on 2026-09-26: on some videos the inline "展开" opens a
// detail panel over the video (author g_5, full caption g=7, heading 相关推荐 g_f) instead of
// expanding the caption in place. The runner took that panel for a page it had left and skipped
// the work, two or three per keyword.

const encode = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('\n', '&#10;');
const node = (id, text = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${encode(value)}"`).join(' ')} />`;
const tree = body => parseUiTree(`<hierarchy>${body}</hierarchy>`);
const card = {title: '车机壁纸分享✨ 贺兰山下万马奔腾，这壁纸效果真的挺不错！ #车机壁纸 #别克', author: '车主小王'};
const collapsed = '车机壁纸分享✨ 贺兰山下万马奔腾，这壁纸... 展开';
// As measured: the detail shows " · 23小时前" (4wp) and the panel caption ends with "    23小时前".
const videoPage = (caption = collapsed, author = `@${card.author}`, time = ' · 23小时前') => tree(node('desc', caption, {clickable: 'true'})
  + node('title', author, {'content-desc': '按钮'}) + (time ? node('4wp', time) : '') + node('vmj') + node('title', '相关搜索'));
const fullCaption = '车机壁纸分享✨ 贺兰山下万马奔腾，这壁纸效果真的挺不错！\n#车机壁纸 #别克';
const panelPage = (caption = `${fullCaption}    23小时前`, author = card.author) =>
  tree(node('g_5', author, {clickable: 'true'}) + node('g_3', '关注') + node('g=7', caption, {clickable: 'true'})
    + node('g_f', '相关推荐'));
const TAP = {x: 768, y: 85, width: 817, height: 114};

function fakeUi(afterTap, afterBack = () => videoPage(), start = () => videoPage()) {
  let screen = start;
  const calls = [];
  return {calls, ui: {
    read: async () => screen(),
    tapIdNearEnd: async id => { calls.push(`tap:${id}`); screen = afterTap; return TAP; },
    back: async () => { calls.push('back'); screen = afterBack; },
    clickId: async id => assert.fail(`only the inline 展开 may be tapped (${id})`),
  }};
}

test('a caption panel with the full caption verifies the work and is closed before returning', async () => {
  const {ui, calls} = fakeUi(() => panelPage());
  const detail = await readVerifiedDetail({ui, card});
  assert.deepEqual(calls, ['tap:desc', 'back']);
  assert.equal(detail.kind, 'video');
  assert.equal(detail.author, `@${card.author}`);
  assert.equal(detail.title.replace(/\s/gu, ''), card.title.replace(/\s/gu, ''), 'the full caption, as after an in-place expand');
  assert.equal(detail.share, 'vmj', 'the detail page itself is back, with its share control');
});

test('a panel showing another caption, author or time never verifies the work and is not closed blindly', async () => {
  for (const [panel, start] of [
    [() => panelPage('另一条完全不同的正文 #车机壁纸    23小时前')],
    [() => panelPage(undefined, '另一个作者')],
    // The time suffix is only removed when it is exactly the detail's own publish time.
    [() => panelPage(`${fullCaption}    1天前`)],
    [() => panelPage(`${fullCaption}23小时前`)],
    [() => panelPage(), () => videoPage(collapsed, `@${card.author}`, null)],
  ]) {
    const {ui, calls} = fakeUi(panel, undefined, start);
    await assert.rejects(readVerifiedDetail({ui, card}), error => {
      assert.equal(error.code, 'detail_identity_unverified');
      assert.equal(error.expandOutcome, 'panel_mismatch');
      assert.equal(error.deviceSettled, true);
      return true;
    });
    assert.deepEqual(calls, ['tap:desc'], 'the skip path returns to the results itself');
  }
});

test('the work is only returned when the very same collapsed detail comes back after the panel', async () => {
  for (const [label, afterBack] of [
    ['panel still open', () => panelPage()],
    ['another collapsed caption', () => videoPage('另一条视频的正文... 展开')],
    ['another author', () => videoPage(collapsed, '@另一个作者')],
    ['left the detail', () => tree(node('topic_title', '#车机壁纸 话题页面'))],
  ]) {
    let clock = 0;
    const {ui, calls} = fakeUi(() => panelPage(), afterBack);
    const read = ui.read; ui.read = async () => { clock += 8000; return read(); };
    await assert.rejects(readVerifiedDetail({ui, card, budgetMs: 40_000, now: () => clock}), error => {
      assert.equal(error.code, 'detail_identity_unverified', label);
      assert.equal(error.stage, 'panel', label);
      assert.equal(error.expandOutcome, 'panel_not_closed', label);
      assert.equal(error.deviceSettled, true, label);
      const uploaded = faultDetails(error);
      assert.equal(uploaded.expandOutcome, 'panel_not_closed');
      assert.equal(JSON.stringify(uploaded).includes('车机壁纸分享'), false, 'captions never reach uploaded details');
      return true;
    });
    assert.deepEqual(calls, ['tap:desc', 'back'], label);
  }
});
