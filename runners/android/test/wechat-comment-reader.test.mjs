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

test('Channels does not tap expand controls or spend the limit on visible replies', async () => {
  const taps = [];
  let swipes = 0;
  const result = await readCommentPanel({
    screen: {tap: async (...args) => taps.push(args), swipe: async () => { swipes++; }},
    view: {look: async () => first, capture: async () => ({text: Promise.resolve({rows: second})})},
    limit: 2, maxScreens: 3,
  });
  assert.deepEqual(taps, []);
  assert.ok(swipes > 0, 'the visible reply did not consume the second slot');
  assert.deepEqual(result.items.map(item => [item.content, item.reply, item.parentIndex]),
    [['第一条一级留言', false, null], ['第二条一级留言', false, null]]);
});

test('Channels can finish after the top-level comments stop changing even with collapsed replies', async () => {
  const rows = [...first, ...second.slice(1).map(item => ({...item, y: item.y + 450}))];
  const result = await readCommentPanel({
    screen: {tap: async () => assert.fail('reply expansion must not be tapped'), swipe: async () => {}},
    view: {look: async () => rows, capture: async () => ({text: Promise.resolve({rows})})},
    limit: 10, maxScreens: 4,
  });
  assert.equal(result.status, 'captured');
  assert.equal(result.headerCount, 2);
  assert.deepEqual(result.items.map(item => item.content), ['第一条一级留言', '第二条一级留言']);
});
