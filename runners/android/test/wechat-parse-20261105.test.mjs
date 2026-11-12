import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {commentButton, comparable, filterButton, forwardEntry, forwardToastSeen, pickerMatch, pickerSearch, sendConfirmation, sheetOption, findText, findWord, isResultsPage, parseResultCards, parseTimeLabel, sameCard} from '../src/device/wechat-ocr-parse.mjs';
import {MORE_VIDEOS_SHIFT, POINT, SEARCH_FILTERS, feedLink} from '../src/device/wechat-profile.mjs';
import {mergeCommentScreens, namesAgree, parseCommentScreen, textsAgree} from '../src/device/wechat-comments-parse.mjs';
import {createAdbScreen, encodeModifiedUtf7} from '../src/device/adb-screen.mjs';
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

test('an image-only comment is kept as 「[图片]」; a header with its text still below the screen is not', () => {
  // 2026-11-06: 「评论1」 whose only comment is a picture — header line, then 400 px of image, then the 首评 badge.
  const screen = parseCommentScreen(rows('comments-image-only-20261106'));
  assert.equal(screen.headerCount, 1);
  assert.deepEqual(screen.comments.map(item => [item.author, item.location, item.timeLabel, item.content, item.reply]),
    [['那年夏天', '湖北', '1天前', '[图片]', false]]);
  assert.equal(screen.bottomCut, false);
  // The same comment seen again after a scroll stays one comment.
  assert.equal(mergeCommentScreens([screen, screen]).length, 1);
  // 漫步人生's header sits 74 px above the comment input: its text is on the next screen, so it is not an image.
  const busy = parseCommentScreen(rows('comments-207-20261105'));
  assert.ok(!busy.comments.some(item => item.content === '[图片]'));
  assert.ok(!busy.comments.some(item => item.author === '漫步人生'));
});

test('a keyword longer than the search box is confirmed by the beginning the box shows', () => {
  // 2026-11-06 patrol of a 20-character caption start: the box reads 「忍无可忍，无须再忍！凯迪拉克/」.
  const screen = rows('results-long-keyword-20261106');
  assert.equal(isResultsPage(screen, '忍无可忍，无须再忍！凯迪拉克ATSL升级'), true);
  assert.equal(isResultsPage(screen, '忍无可忍，无须再忍！别克GL8升级'), false, 'another ending is another keyword');
  // A short shown beginning proves nothing, and a keyword that fits the box still has to match in full.
  const box = text => [{text, conf: 1, x: 140, y: 145, w: 600, h: 60}, {text: '视频', conf: 1, x: 202, y: 280, w: 84, h: 42}];
  assert.equal(isResultsPage(box('忍无可忍/'), '忍无可忍，无须再忍！凯迪拉克ATSL升级'), false);
  assert.equal(isResultsPage(box('别克车机升'), '别克车机升级'), false);
  assert.equal(isResultsPage(box('别克车机升级'), '别克车机升级'), true);
  assert.equal(findWord(screen, '视频', {region: {y0: 240, y1: 350, x1: 400}}).length, 1);
});

test('the 评论 button is found from the bar counts, also when the 「更多视频」 strip pushes the bar up', () => {
  const options = {fallback: POINT.comments, shift: MORE_VIDEOS_SHIFT};
  // Counts 9 / 6 / 1 at y 2127–2131: the icon row stays where the fixed point is.
  const plain = commentButton(rows('work-page-20261106'), options);
  assert.equal(plain.from, 'counts');
  assert.equal(plain.x, POINT.comments.x);
  assert.ok(Math.abs(plain.y - POINT.comments.y) <= 10, `y ${plain.y}`);
  // Opened by link: only 9 was read, at y 1951, above 「↑更多视频」. The icon row (author line) is at y 1905.
  const lifted = commentButton(rows('work-page-more-videos-20261106'), options);
  assert.equal(lifted.from, 'counts');
  assert.ok(Math.abs(lifted.y - 1905) <= 10, `y ${lifted.y}`);
  // No count read: the strip alone shifts the fixed point; nothing at all keeps it.
  const stripOnly = rows('work-page-more-videos-20261106').filter(row => !/^\d+$/u.test(row.text));
  assert.deepEqual(commentButton(stripOnly, options), {x: POINT.comments.x, y: POINT.comments.y - MORE_VIDEOS_SHIFT, from: 'more_videos'});
  assert.deepEqual(commentButton([], options), {...POINT.comments, from: 'fixed'});
});

test('a post is opened by its export id through WeChat\'s scheme entry for the main user; unsafe ids never reach the shell', async () => {
  const id = 'export/UzFfBgAAxKWAeCIjPWGPk8zT4DCsIuXYLQcsJMdCb2FRt--U894rO25aoQ';
  assert.equal(feedLink(id), `weixin://biz/finder/openFinderFeed/exportId=${id}&actionType=0&commentScene=39&entryScene=64&entryCardType=48&requestScene=0`);
  for (const bad of ['', 'export/', 'export/abc', "export/abcdefgh'; rm -rf /", 'export/abcdefgh$(id)', 'https://x/abcdefgh']) {
    assert.throws(() => feedLink(bad), {code: 'invalid_export_id'}, bad);
  }
  const sent = [];
  const screen = createAdbScreen({serial: '829d89', command: async (_bin, args) => { sent.push(args); return {stdout: 'Status: ok'}; }});
  await screen.openLink('com.tencent.mm/.plugin.base.stub.WXCustomSchemeEntryActivity', feedLink(id));
  const args = sent[0];
  assert.deepEqual(args.slice(args.indexOf('shell') + 1, args.indexOf('-d')), ['am', 'start', '--user', '0', '-a', 'android.intent.action.VIEW',
    '-c', 'android.intent.category.BROWSABLE', '-n', 'com.tencent.mm/.plugin.base.stub.WXCustomSchemeEntryActivity']);
  assert.equal(args.at(-1), `'${feedLink(id)}'`, 'the link is one quoted word on the device shell');
  await assert.rejects(screen.openLink('com.tencent.mm/.X', "weixin://a'b"), {code: 'invalid_link'});
  await assert.rejects(screen.openLink('com.tencent.mm/.X', 'weixin://a b'), {code: 'invalid_link'});
  const refusing = createAdbScreen({serial: '829d89', command: async () => ({stdout: 'Error: Activity not started'})});
  await assert.rejects(refusing.openLink('com.tencent.mm/.X', feedLink(id)), {code: 'app_launch_failed', deviceSettled: true});
});

// OnStar test 2026-11-06: four posts whose comments came back duplicated or with foreign text.
const panel = name => parseCommentScreen(rows(name));
const summary = comments => comments.map(item => [item.author, item.location, item.content]);

test('an ad card under a comment and the 「首评」 label are not comment text; scrolled readings stay one comment', () => {
  const first = panel('comments-ad-20261106-0'), second = panel('comments-ad-20261106-1');
  // Before: 「XT59接入豆包了吗？首评岚图汽车官方…岚图梦想家，限时18,000元…」, kept 2–4 times.
  assert.deepEqual(summary(first.comments), [['果然多', '浙江', 'XT59接入豆包了吗？']]);
  assert.deepEqual(summary(second.comments), [['果然多', '浙江', 'XT59接入豆包了吗？']]);
  assert.equal(mergeCommentScreens([first, second, second]).length, 1);
  assert.deepEqual(summary(panel('comments-first-label-20261106-0').comments),
    [['沪上青山Vlog', '上海', '换这款多少钱啊'], ['勇哥的视界', '山东', '同问']]);
});

test('name badge variants still merge; complete prefix variants remain separate without cut evidence', () => {
  const first = panel('comments-stickers-20261106-0'), second = panel('comments-stickers-20261106-1');
  assert.deepEqual(first.comments.map(item => item.author), ['田纳西瓜皮', '迷途懒猫心', '强']);
  assert.deepEqual(second.comments.map(item => item.author), ['田纳西瓜皮', '迷途懒猫凶', '强']);
  const merged = mergeCommentScreens([first, second]);
  assert.equal(merged.length, 4, JSON.stringify(summary(merged)));
  assert.ok(merged[2].content.endsWith('最后一地鸡毛'), '首评 is not part of the text');
  assert.equal(namesAgree('迷途懒猫心', '迷途懒猫凶'), true);
  assert.equal(namesAgree('迷途懒猫', '迷途懒猫心'), true);
  assert.equal(namesAgree('张三', '张四'), false, 'two-character names must match exactly');
  assert.equal(namesAgree('迷途懒猫', '迷途小猫咪'), false);
  assert.equal(textsAgree('安吉星也要付钱的，一天一块钱', '安吉星“也要付钱的，一天一块钱起'), false, 'both complete readings stay distinct');
  assert.equal(textsAgree('没见过凯迪拉克打过广告，人家钱都放安全上了', '没见过凯迪拉克打过广告的，人家钱都放安全上了'), true);
  assert.equal(textsAgree('好看', '好看吗'), false);
  assert.equal(textsAgree('同问', '同问'), true);
});

test('an IP region run into the name is split off; a missed 「评论 N」 title does not lose the screen', () => {
  const first = panel('comments-regions-20261106-0');
  assert.equal(first.headerCount, null, 'the title was not read on this screen');
  assert.deepEqual(summary(first.comments), [['哆啦A梦快乐豆', '河南', '[图片]'], ['哟改名字了997200', '四川', '界个欠费的是哪个车起'],
    ['凌晨三点', '山东', '开朋友别克误碰过，还没挂就接通了，慌忙道歉说点错了']]);
  const merged = mergeCommentScreens([first, panel('comments-regions-20261106-1')]);
  assert.deepEqual(merged.map(item => item.author), ['哆啦A梦快乐豆', '哟改名字了997200', '凌晨三点', '里程']);
});

// 2026-11-09, DE106 / 微信 8.0.80, keyword 安吉星: the 视频 tab's own 时长 and 范围 sheets.
test('the 时长 / 范围 buttons, their sheets and the picked choice are read from the screen', () => {
  const {duration, scope} = SEARCH_FILTERS;
  const start = rows('filters-start-20261109');
  assert.deepEqual([filterButton(start, duration).shows, filterButton(start, scope).shows], ['all', 'all']);
  assert.ok(Math.abs(filterButton(start, duration).center.x - 598) < 40, 'the 时长 button, not the sort row');
  // The sheet: its title confirms it; options are matched exactly (5-20分钟 is not 20分钟以上).
  const sheet = rows('filters-duration-sheet-20261109');
  const fiveTwenty = sheetOption(sheet, duration, '5_20m');
  const under = sheetOption(sheet, duration, 'under_5m');
  const over = sheetOption(sheet, duration, 'over_20m');
  assert.ok(under && fiveTwenty && over);
  assert.ok(under.center.x > 540 && under.center.y < fiveTwenty.center.y, 'right column, first row');
  assert.ok(over.center.x > 540 && fiveTwenty.center.x < 540);
  assert.equal(sheetOption(sheet, scope, 'viewed'), null, 'the 范围 options are not on the 时长 sheet');
  assert.equal(sheetOption(start, duration, 'under_5m'), null, 'no sheet open');
  const scopeSheet = rows('filters-scope-sheet-20261109');
  assert.ok(sheetOption(scopeSheet, scope, 'viewed').center.y > sheetOption(scopeSheet, scope, 'followed').center.y);
  // After picking, each button shows its choice.
  assert.equal(filterButton(rows('filters-duration-picked-20261109'), duration).shows, 'under_5m');
  assert.equal(filterButton(rows('filters-duration-picked-20261109'), scope).shows, 'all');
  const both = rows('filters-both-picked-20261109');
  assert.deepEqual([filterButton(both, duration).shows, filterButton(both, scope).shows], ['under_5m', 'viewed']);
});

// 2026-11-09 13:23, the 萧枫 post forwarded to 金明Tony by hand: share sheet, 选择聊天, 「发送给：」 sheet, 「已发送」.
test('转发给朋友 screens: the entry, the picker search and contact row, the confirmation that names the contact, the toast', () => {
  const entry = forwardEntry(rows('forward-share-sheet-20261109'));
  assert.ok(entry && entry.x < 200 && entry.y < 1664, 'on the icon above the 转发给朋友 label, never 收藏 or 朋友圈');
  assert.equal(forwardEntry(rows('forward-sent-20261109')), null);
  const picker = rows('forward-picker-20261109');
  assert.ok(pickerSearch(picker).center.y < 340);
  assert.ok(pickerMatch(picker, '金明Tony').center.y > 560);
  assert.equal(pickerMatch(picker, '金明'), null, 'only the exact name');
  assert.equal(pickerMatch([{text: '金明Tony', x: 140, y: 150, w: 200, h: 50, conf: 1}], '金明Tony'), null, 'the search field echo is not a contact');
  const sheet = sendConfirmation(rows('forward-confirm-20261109'), '金明Tony');
  assert.equal(sheet.confirmed, true);
  assert.ok(sheet.send.center.x > 540 && sheet.cancel.center.x < 540);
  assert.equal(sendConfirmation(rows('forward-confirm-20261109'), '别人').confirmed, false, 'another name never confirms');
  assert.equal(sendConfirmation(rows('forward-picker-20261109'), '金明Tony').confirmed, false);
  assert.equal(forwardToastSeen(rows('forward-sent-20261109')), true);
  assert.equal(forwardToastSeen(rows('forward-confirm-20261109')), false);
});
