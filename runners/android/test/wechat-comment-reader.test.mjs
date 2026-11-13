import test from 'node:test';
import assert from 'node:assert/strict';
import {readCommentPanel} from '../src/device/wechat-comment-reader.mjs';

const row = (text, x, y) => ({text, x, y, w: 300, h: 32});
const title = row('评论 2', 120, 655);
const first = [
  title, row('第一位读者 广东 1天前', 150, 790), row('第一条一级留言', 150, 850),
  row('作者 广东 1天前', 230, 950), row('这条是回复预览', 230, 1010), row('展开 3 条回复', 150, 1100),
];
const second = [title, row('第二位读者 江苏 1天前', 150, 790), row('第二条一级留言', 150, 850)];
const overlapping = [...first, ...second.slice(1).map(item => ({...item, y: item.y + 450}))];
const viewFrames = (...frames) => ({look: async () => frames.length > 1 ? frames.shift() : frames[0]});

test('Channels does not tap expand controls or spend the limit on visible replies', async () => {
  const taps = [];
  let swipes = 0;
  const result = await readCommentPanel({
    screen: {tap: async (...args) => taps.push(args), swipeAndHold: async () => { swipes++; }},
    view: viewFrames(first, overlapping),
    limit: 2, maxScreens: 3, wait: async () => {},
  });
  assert.deepEqual(taps, []);
  assert.ok(swipes > 0, 'the visible reply did not consume the second slot');
  assert.deepEqual(result.items.map(item => [item.content, item.reply, item.parentIndex]),
    [['第一条一级留言', false, null], ['第二条一级留言', false, null]]);
});

test('Channels can finish after the top-level comments stop changing even with collapsed replies', async () => {
  const result = await readCommentPanel({
    screen: {tap: async () => assert.fail('reply expansion must not be tapped'), swipeAndHold: async () => {}},
    view: viewFrames(overlapping),
    limit: 10, maxScreens: 4, wait: async () => {},
  });
  assert.equal(result.status, 'captured');
  assert.equal(result.headerCount, 2);
  assert.deepEqual(result.items.map(item => item.content), ['第一条一级留言', '第二条一级留言']);
});

test('a lost overlap reverses once and continues from the last verified frame', async () => {
  const skipped = [title, row('更远的读者 上海 1天前', 150, 790), row('这个屏幕有断档', 150, 850)];
  const swipes = [];
  const result = await readCommentPanel({
    screen: {swipe: async (...args) => swipes.push(args.slice(0, 5)), swipeAndHold: async (...args) => swipes.push(args.slice(0, 6))},
    view: viewFrames(first, skipped, overlapping),
    limit: 50, maxScreens: 4, wait: async () => {},
  });
  assert.equal(result.status, 'captured');
  assert.deepEqual(result.items.map(item => item.content), ['第一条一级留言', '第二条一级留言']);
  assert.deepEqual(swipes, [
    [540, 1950, 540, 1150, 600, 200], [540, 1150, 540, 1550, 600, 200],
    [540, 1950, 540, 1150, 600, 200], [540, 1950, 540, 1150, 600, 200],
  ]);
});

test('a 1306-pixel jump with no shared comment after the reverse stays partial', async () => {
  const original = [title, row('第一位读者 广东 1天前', 150, 790), row('第一条一级留言', 150, 850),
    row('页尾读者 湖南 1天前', 150, 2069)];
  const skipped = [title, row('第二位读者 江苏 1天前', 150, 2069 - 1306), row('第二条一级留言', 150, 829)];
  const swipes = [];
  const result = await readCommentPanel({
    screen: {swipe: async (...args) => swipes.push(args.slice(0, 5)), swipeAndHold: async (...args) => swipes.push(args.slice(0, 6))},
    view: viewFrames(original, skipped),
    limit: 50, maxScreens: 4, wait: async () => {},
  });
  assert.deepEqual(swipes, [[540, 1950, 540, 1150, 600, 200], [540, 1150, 540, 1550, 600, 200]]);
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'scroll_gap');
  assert.deepEqual(result.items.map(item => item.content), ['第一条一级留言', '第二条一级留言']);
});

test('a byline at the edge proves overlap even before its body becomes visible', async () => {
  const original = [title, ...first.slice(1, 3), row('第二位读者 江苏 1天前', 150, 2060)];
  const swipes = [];
  const result = await readCommentPanel({
    screen: {swipeAndHold: async (...args) => swipes.push(args.slice(0, 6))},
    view: viewFrames(original, second),
    limit: 50, maxScreens: 4, wait: async () => {},
  });
  assert.equal(result.status, 'captured');
  assert.deepEqual(result.items.map(item => item.content), ['第一条一级留言', '第二条一级留言']);
  assert.equal(swipes.length, 3);
  assert.ok(swipes.every(([, from, , to]) => from - to === 800));
});
