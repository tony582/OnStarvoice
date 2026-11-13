import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readCommentPanel} from '../src/device/wechat-comment-reader.mjs';

const row = (text, x, y) => ({text, x, y, w: 300, h: 32});
const title = row('评论 2', 120, 655);
const post = row('视频发布者 作者 广东 1天前', 150, 745);
const first = [
  title, post, row('第一位读者 广东 1天前', 150, 790), row('第一条一级留言', 150, 850),
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
  const original = [title, post, row('第一位读者 广东 1天前', 150, 790), row('第一条一级留言', 150, 850),
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
  const byline = {...row('第二位读者 江苏 1天前', 150, 2056), h: 42};
  const original = [...first.slice(0, 4), byline];
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

const latest = JSON.parse(readFileSync(new URL('./fixtures/wechat/comments-finish-20261113.json', import.meta.url)));
const earlier = JSON.parse(readFileSync(new URL('./fixtures/wechat/comments-retest-20261113.json', import.meta.url)));
const shifts = swipes => swipes.map(([, from, , to]) => from - to);

test('a real Dou-dou panel that opens mid-list first seeks the top before it reads downward', async () => {
  const [top, ...rest] = earlier['dou-dou'];
  // The 0.5.8 first swipe skipped a screen. Supply an overlapping viewport between those two saved OCR frames.
  const tailOfTop = top.filter(row => row.y >= 1700 && row.y < 2000).map(row => ({...row, y: row.y - 950}));
  const headOfNext = rest[0].filter(row => row.y >= 700 && row.y + row.h < 1850).map(row => ({...row, y: row.y + 300}));
  const overlap = [top[0], ...tailOfTop, ...headOfNext];
  const swipes = [];
  const result = await readCommentPanel({
    screen: {swipeAndHold: async (...args) => swipes.push(args.slice(0, 6))},
    view: viewFrames(latest['dou-dou'][0], top, overlap, ...rest),
    wait: async () => {},
  });
  assert.equal(shifts(swipes)[0], -800);
  assert.equal(result.status, 'captured');
  assert.equal(result.post.author, '豆豆的xt5');
  assert.deepEqual(result.items.map(item => item.author), [
    '垄断悠闲', '养鱼新手2480', 'Rookie V', '發0713發', '魏来可期-8880', '晨曦', '八九区我的', '符号Ing', '温柔的梦里久',
  ]);
  assert.ok(result.items.every(item => !item.reply));
});

test('the full Dasheng read replays both overlap recoveries and keeps 26 top-level comments', async () => {
  const swipes = [];
  const result = await readCommentPanel({
    screen: {swipeAndHold: async (...args) => swipes.push(args)},
    view: viewFrames(...latest.dasheng), wait: async () => {},
  });
  assert.equal(result.status, 'captured');
  assert.equal(result.headerCount, 31);
  assert.equal(result.items.length, 26);
  assert.ok(result.items.every(item => !item.reply));
  assert.deepEqual(shifts(swipes).filter(distance => distance < 0), [-400, -400]);
});

test('two unchanged reverse readings stop seeking and preserve a partial forward result', async () => {
  const swipes = [];
  const midList = [title, row('第二位读者 江苏 1天前', 150, 790),
    row('第二条一级留言', 150, 850)];
  const result = await readCommentPanel({
    screen: {swipeAndHold: async (...args) => swipes.push(args)},
    view: viewFrames(midList), wait: async () => {},
  });
  assert.deepEqual(shifts(swipes), [-800, -800, 800, 800]);
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'top_unverified');
  assert.deepEqual(result.items.map(item => item.content), ['第二条一级留言']);
});

test('a popular-comment badge is not proof of the post author row', async () => {
  const swipes = [];
  const promoted = [title, row('第三位读者 已帮作者上热门 江苏 1天前', 150, 790),
    row('这条留言帮作者上了热门', 150, 850)];
  const result = await readCommentPanel({
    screen: {swipeAndHold: async (...args) => swipes.push(args)},
    view: viewFrames(promoted), wait: async () => {},
  });
  assert.deepEqual(shifts(swipes), [-800, -800, 800, 800]);
  assert.equal(result.reason, 'top_unverified');
  assert.equal(result.post, null);
  assert.deepEqual(result.items.map(item => item.author), ['第三位读者']);
});

test('the top seek caps at ten moves and starts the partial read at the final viewport', async () => {
  const swipes = [];
  const views = Array.from({length: 11}, (_, i) => [title,
    row(`路过的读者${i} 山东 1天前`, 150, 800), row(`这条出现在第${i}屏`, 150, 870)]);
  const result = await readCommentPanel({
    screen: {swipeAndHold: async (...args) => swipes.push(args)},
    view: viewFrames(...views), wait: async () => {},
  });
  assert.deepEqual(shifts(swipes), [...Array(10).fill(-800), 800, 800]);
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'top_unverified');
  assert.deepEqual(result.items.map(item => item.content), ['这条出现在第10屏']);
});

test('an explicitly empty or disabled panel needs no rewind', async () => {
  const screen = {swipeAndHold: async () => assert.fail('must not swipe')};
  const empty = await readCommentPanel({screen, view: viewFrames([title, row('暂无评论', 450, 1300)])});
  const disabled = await readCommentPanel({screen, view: viewFrames(second), limit: 0});
  assert.equal(empty.status, 'empty');
  assert.equal(empty.headerCount, 0);
  assert.equal(disabled.status, 'disabled');
});

test('a short action budget keeps the observed comments and reports the remaining gap', async () => {
  const screen = {swipeAndHold: async () => assert.fail('no swipe fits in the budget')};
  const canScroll = () => false;
  for (const [rows, reason, content] of [[first, 'comment_time_limit', '第一条一级留言'], [second, 'top_unverified', '第二条一级留言']]) {
    const result = await readCommentPanel({screen, view: viewFrames(rows), canScroll});
    assert.equal(result.status, 'partial');
    assert.equal(result.reason, reason);
    assert.deepEqual(result.items.map(item => item.content), [content]);
  }
});
