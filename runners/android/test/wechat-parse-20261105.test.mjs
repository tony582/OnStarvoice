import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {comparable, findText, findWord, isResultsPage, parseResultCards, parseTimeLabel, sameCard} from '../src/device/wechat-ocr-parse.mjs';
import {mergeCommentScreens, parseCommentScreen} from '../src/device/wechat-comments-parse.mjs';
import {encodeModifiedUtf7} from '../src/device/adb-screen.mjs';
import {readFeedInfo} from '../src/preview/share-preview.mjs';
import {agesAscending} from '../src/device/wechat-flow.mjs';

// OCR rows recognized from real DE106 / WeChat 8.0.80 screenshots on 2026-11-05 (public posts only).
const rows = name => readFileSync(fileURLToPath(new URL(`./fixtures/wechat/${name}.ocr.jsonl`, import.meta.url)), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line));
const NOW = Date.parse('2026-11-05T17:12:00+08:00');

test('results page: the keyword box and the 视频 tab confirm the page; two fully visible cards in reading order', () => {
  const screen = rows('results-latest-20261105');
  assert.equal(isResultsPage(screen, '别克车机升级'), true);
  assert.equal(isResultsPage(screen, '别克壁纸'), false);
  const cards = parseResultCards(screen, {now: NOW});
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.column), [0, 1]);
  assert.equal(cards[0].snippet, '别克GL8 ES 17-19款中控老改新 大连屏');
  assert.equal(cards[0].author, '小智');
  assert.deepEqual(cards[0].age, {minHours: 1, maxHours: 2, precision: '小时'});
  assert.equal(cards[1].author, '宏星源俞姐');
  assert.equal(cards[1].timeLabel, '22小时');
  assert.equal(cards[1].likeLabel, '8');
  for (const card of cards) {
    // The tap lands on the thumbnail above the duration row, never on the caption or below.
    assert.ok(card.tap.y < card.anchorY && card.tap.y > 480);
    assert.match(card.cardKey, /^[a-f0-9]{64}$/u);
  }
});

test('thumbnail text above the duration row is never read as a caption, and OCR variants still match the same card', () => {
  const plain = parseResultCards(rows('results-latest-20261105'), {now: NOW});
  const covered = parseResultCards(rows('results-thumbnails-20261105'), {now: NOW});
  assert.equal(covered.length, 2);
  assert.ok(!covered.some(card => /通用品牌区别|别克君越/u.test(card.snippet)));
  // 別 (traditional) on one screenshot, 别 on the other: the comparable form maps them to one key.
  assert.match(covered[0].snippet, /^別克/u);
  assert.equal(covered[0].cardKey, plain[0].cardKey);
  assert.equal(sameCard({...covered[0], cardKey: 'x', snippet: '別克GL8 ES 17-19款中控老改新 大连'}, plain[0]), true);
  assert.equal(sameCard(covered[0], plain[1]), false);
  assert.equal(comparable('別克GL8 …'), '别克gl8');
});

test('card time labels, including ones cut short by the card', () => {
  assert.deepEqual(parseTimeLabel('8分钟前', NOW), {minHours: 8 / 60, maxHours: 9 / 60, precision: '分钟'});
  assert.equal(parseTimeLabel('22 小时…', NOW).minHours, 22);
  assert.equal(parseTimeLabel('1小时.', NOW).maxHours, 2);
  assert.equal(parseTimeLabel('3天前', NOW).minHours, 72);
  assert.equal(parseTimeLabel('2个月前', NOW).minHours, 1440);
  assert.equal(parseTimeLabel('刚刚', NOW).minHours, 0);
  // 17:12 Beijing: yesterday is 17.2–41.2 hours ago, the day before 41.2–65.2.
  const yesterday = parseTimeLabel('昨天', NOW), dayBefore = parseTimeLabel('前天', NOW);
  assert.ok(Math.abs(yesterday.minHours - 17.2) < 0.01 && Math.abs(yesterday.maxHours - 41.2) < 0.01);
  assert.ok(Math.abs(dayBefore.minHours - 41.2) < 0.01);
  assert.ok(parseTimeLabel('11月3日', NOW).minHours > 24);
  assert.ok(parseTimeLabel('2025年3月1日', NOW).minHours > 5000);
  assert.equal(parseTimeLabel('宏星源', NOW), null);
  assert.equal(parseTimeLabel('', NOW), null);
});

test('newest-first read back: ages may not decrease; fewer than three ages prove nothing', () => {
  const card = minHours => ({age: {minHours}});
  assert.equal(agesAscending([card(0.1), card(20), card(41), card(72)]), true);
  assert.equal(agesAscending([card(7200), card(41), card(1440), card(20)]), false);
  assert.equal(agesAscending([card(30), card(1)]), true);
});

test('comment panel: count, the post row, top-level comments, an indented reply and the replies control', () => {
  const screen = parseCommentScreen(rows('comments-207-20261105'));
  assert.equal(screen.headerCount, 207);
  assert.equal(screen.post.author, '上海交通广播');
  assert.equal(screen.post.location, '上海');
  assert.match(screen.post.caption, /^通用品牌内 区别对待？承诺更新不履约！/u);
  assert.deepEqual(screen.comments.map(item => [item.author, item.location, item.reply]),
    [['肿么肥四', '江苏', false], ['归舟向晚', '河南', false], ['A上海通', '上海', true]]);
  assert.equal(screen.comments[0].likeCount, 31);
  assert.equal(screen.comments[1].content, '别克的每一次决策都是消耗老车主的忠实度，从不切实考虑车主的驾驶感受');
  assert.equal(screen.expand.length, 1);
  assert.equal(screen.expand[0].count, 4);
  assert.ok(screen.expand[0].tap.y < 2100, 'never taps the comment input');
  const empty = parseCommentScreen(rows('comments-empty-20261105'));
  assert.equal(empty.comments.length, 0);
  assert.equal(empty.post.author, '小智ad');
});

test('merging scrolled screens keeps one reading per comment and links replies to their parent', () => {
  const first = parseCommentScreen(rows('comments-207-20261105'));
  const second = {comments: [
    {author: '归舟向晚', location: '河南', timeLabel: '2天前', content: '别克的每一次决策都是消耗老车主的忠实度，从不切实考虑车主的驾驶感受', likeCount: 19, reply: false},
    {author: 'A上海通', location: '上海', timeLabel: '2天前', content: '其他车企也一样', likeCount: null, reply: true},
    {author: '漫步人生', location: '河北', timeLabel: '2天前', content: '消费者要的是一个态度', likeCount: 17, reply: false},
  ]};
  const merged = mergeCommentScreens([first, second]);
  assert.deepEqual(merged.map(item => item.author), ['肿么肥四', '归舟向晚', 'A上海通', '漫步人生']);
  assert.equal(merged[2].parentIndex, 1);
  assert.equal(mergeCommentScreens([first, second], {limit: 2}).length, 2);
});

test('share sheet: 复制链接 is located by its text on the second row', () => {
  const hit = findText(rows('share-sheet-row2-20261105'), '复制链接', {region: {y0: 1850, y1: 2060}});
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].center, {x: 969, y: 1975});
});

test('Unicode keyboard text uses modified UTF-7', () => {
  assert.equal(encodeModifiedUtf7('别克车机升级'), '&UitRS49mZzpTR36n-');
  assert.equal(encodeModifiedUtf7('GL8 & 君越'), 'GL8 &- &VBuNig-');
});

test('preview answers: complete posts, unavailable posts and malformed bodies', () => {
  const body = data => JSON.stringify({errCode: 0, data});
  const info = readFeedInfo(body({authorInfo: {nickname: '上海交通广播', headImgUrl: 'https://wx.qlogo.cn/a'},
    feedInfo: {description: '通用品牌内 区别对待？', createtime: 1793671301, likeCountFmt: '262', favCountFmt: '423',
      forwardCountFmt: '405', commentCountFmt: '207', coverUrl: 'https://finder.video.qq.com/x', picInfo: []},
    errMsg: {type: 0}, sceneInfo: {dynamicExportId: 'export/abc'}}));
  assert.equal(info.unavailable, false);
  assert.equal(info.createtime, 1793671301);
  assert.equal(info.favCountFmt, '423');
  assert.equal(info.isImage, false);
  assert.deepEqual(readFeedInfo(body({errMsg: {type: 1, msg: '内容已删除'}})), {unavailable: true, reason: '内容已删除'});
  assert.throws(() => readFeedInfo('{'), {code: 'preview_invalid'});
  assert.throws(() => readFeedInfo(JSON.stringify({errCode: -1})), {code: 'preview_refused'});
  assert.throws(() => readFeedInfo(body({authorInfo: {}, feedInfo: {description: 'x', createtime: 1793671301}, errMsg: {type: 0}})),
    {code: 'preview_incomplete'});
});

test('search-term icons read as Q or ° are removed from comment text; model names stay', async () => {
  const {cleanCommentText} = await import('../src/device/wechat-comments-parse.mjs');
  assert.equal(cleanCommentText('这次OTAQ算是完整秀了一把'), '这次OTA算是完整秀了一把');
  assert.equal(cleanCommentText('智驾高速Q很好用'), '智驾高速很好用');
  assert.equal(cleanCommentText('别克NVH°功底在线'), '别克NVHNVH功底在线'.replace('NVHNVH', 'NVH'));
  assert.equal(cleanCommentText('广州小鹏飞行汽车Q+直升机X'), '广州小鹏飞行汽车+直升机X');
  assert.equal(cleanCommentText('奥迪Q5和25°C'), '奥迪Q5和25°C');
  assert.equal(cleanCommentText('别克服务Q至于交付'), '别克服务至于交付');
});

test('a 服务号 card on top of the results: the tabs read as one line and the 视频 tab is still found inside it', () => {
  const screen = rows('results-service-card-20261105');
  const region = {y0: 240, y1: 350, x1: 400};
  assert.equal(isResultsPage(screen, 'ibuick'), true);
  assert.equal(findText(screen, '视频', {region}).length, 0, 'the exact match that failed on 2026-11-05');
  const [tab] = findWord(screen, '视频', {region});
  assert.equal(tab.text, '视频');
  // "视频 账号" spans x 202–462: the label is its first word, left of 账号 and right of 全部 (x 39–127).
  assert.ok(tab.center.x > 202 && tab.center.x < 300, `x ${tab.center.x}`);
  assert.equal(tab.center.y, 303);
  // An exact row still wins, and a longer word that only contains the label is not it.
  const plain = rows('results-latest-20261105');
  assert.deepEqual(findWord(plain, '视频', {region}).map(row => row.center), findText(plain, '视频', {region}).map(row => row.center));
  assert.equal(findWord([{text: '视频号 账号', x: 200, y: 280, w: 260, h: 50, conf: 1}], '视频', {region}).length, 0);
});
