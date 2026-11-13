import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseArticleHeader} from '../src/device/wechat-article-parse.mjs';
import {articleOverlap, createArticleReader} from '../src/device/wechat-article-reader.mjs';
const row = (text, x, y, w = 900, h = 45) => ({text, x, y, w, h, conf: 1});
const header = [row('一篇测试文章', 55, 280, 550, 60), row('测试作者 2026年11月9日 10:15 上海', 55, 394, 850, 43)];
const line = number => `这段正文记录第${number}条独立事实，采集时必须保留。`;
const lines = (from, to, y = 300, step = 90) => Array.from({length: to - from}, (_, i) => row(line(from + i), 55, y + step * i));
const footer = [row('阅读100', 55, 1850, 180), row('不喜欢', 855, 1850, 160)];
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/wechat-articles/${name}.json`, import.meta.url)));
const t13 = name => fixture('t13-claude-phone-20261110')[name].rows;
const t13Comments = number => fixture('t13-comment-footer-20261110')[`t12-renew-d/${number}`].rows;
function harness(pages, options = {}) {
  let index = 0, checks = 0, now = 1;
  const swipes = [], waits = [], taps = [];
  const move = (args, size) => {
    swipes.push(args.slice(0, size));
    index = Math.min(index + 1, pages.length - 1);
    now += args[4] + (size === 6 ? args[5] : 0);
  };
  const reader = createArticleReader({
    screen: {swipe: async (...args) => move(args, 5), swipeAndHold: async (...args) => move(args, 6),
      tap: async (...args) => taps.push(args)},
    look: async () => pages[index], assertArticle: async () => { checks++; },
    wait: async ms => { waits.push(ms); now += ms; }, now: () => now, ...options,
  });
  return {reader, swipes, waits, taps, checks: () => checks};
}

test('bounded chunks continue in place, merge overlap, and capture the complete body when comments are disabled', async () => {
  const {reader, swipes} = harness([[...header, ...lines(0, 15, 620)], lines(8, 23), [...lines(16, 30), ...footer]], {maxChunkPages: 1});
  const first = await reader.read({commentsEnabled: false});
  assert.equal(first.hasMore, true); assert.equal(first.pagesRead, 1); assert.equal(first.article.bodyStatus, 'partial');
  const second = await reader.read({commentsEnabled: false});
  assert.equal(second.hasMore, true); assert.equal(second.pagesRead, 2);
  const last = await reader.read({commentsEnabled: false});
  assert.equal(last.hasMore, false); assert.equal(last.article.bodyStatus, 'complete');
  assert.equal(last.comments.status, 'disabled');
  assert.deepEqual(last.article.content.split('\n'), Array.from({length: 30}, (_, n) => line(n)));
  assert.equal(last.article.evidence.originalImagesCaptured, false);
  assert.deepEqual(swipes, [[540, 1750, 540, 1200, 1100], [540, 1750, 540, 1200, 1100]]);
});

test('a failed overlap triggers a reverse movement and cannot be reported as a complete body', async () => {
  const {reader, swipes} = harness([[...header, ...lines(0, 15, 620)], [...lines(70, 83), ...footer], [...lines(60, 73), ...footer]]);
  const result = await reader.read({limit: 0});
  assert.equal(result.hasMore, false); assert.equal(result.article.bodyStatus, 'partial');
  assert.equal(result.article.bodyReason, 'scroll_gap');
  assert.ok(swipes.some(swipe => swipe[3] > swipe[1]), 'reverse once to recover overlap');
});

test('different numeric lines are not mistaken for overlap despite similar surrounding words', () => {
  assert.equal(articleOverlap(lines(0, 10), lines(50, 60)), null);
  assert.ok(articleOverlap(lines(0, 10), lines(5, 15)));
});

test('a stable footer without a comment entry reports unavailable/null and keeps the body', async () => {
  const end = fixture('52-latest-body-6');
  const {reader} = harness([fixture('51-latest-article'), end, end]);
  const result = await reader.read({limit: 20});
  assert.equal(result.hasMore, false); assert.equal(result.comments.status, 'unavailable');
  assert.equal(result.comments.headerCount, null); assert.equal(result.comments.reason, 'no_comment_entry');
  assert.ok(result.article.content.includes('前瞻快评'));
  assert.equal(result.article.bodyStatus, 'partial', 'the fixture jump intentionally has a missing body interval');
});

test('Claude centered first-comment invitation is empty/open with real footer metrics, not no-entry', async () => {
  const end = fixture('t9-claude-phone-20261109')['s1-renew/069'].rows;
  const {reader} = harness([end], {bodyRequired: false, initialHeader: parseArticleHeader(header)});
  const result = await reader.read();
  assert.equal(result.comments.status, 'empty'); assert.equal(result.comments.headerCount, 0);
  assert.equal(result.comments.postingState, 'open'); assert.deepEqual(result.comments.items, []);
  assert.equal(result.article.metrics.read.value, 148); assert.equal(result.article.metrics.share.value, 5);
  assert.equal(result.article.metrics.recommend.raw, null); assert.equal(result.hasMore, false);
});

test('followers-only footer preserves the public comment and does not request follow', async () => {
  const end = fixture('43-image-comments');
  const {reader} = harness([fixture('40-image-loaded'), end, end]);
  const result = await reader.read({limit: 20});
  assert.equal(result.comments.postingState, 'followers_only');
  assert.equal(result.comments.status, 'captured'); assert.equal(result.comments.items[0].content, '好得很');
});

test('an explicit closed notice never blocks body capture or invents a zero comment count', async () => {
  const end = [...lines(8, 20), ...footer.map(item => ({...item, y: 1500})), row('作者已关闭留言', 75, 1700, 500)];
  const {reader} = harness([[...header, ...lines(0, 15, 620)], end, end]);
  const result = await reader.read();
  assert.equal(result.article.bodyStatus, 'complete'); assert.ok(result.article.content.includes(line(19)));
  assert.equal(result.comments.status, 'closed'); assert.equal(result.comments.headerCount, null);
});

test('screen budget and a motionless page without an end marker are partial, not empty successful articles', async () => {
  const {reader} = harness([[...header, ...lines(0, 15, 620)], lines(8, 23)], {maxPages: 2});
  const bounded = await reader.read(); assert.equal(bounded.hasMore, false);
  assert.equal(bounded.article.bodyStatus, 'partial'); assert.equal(bounded.article.bodyReason, 'screen_budget_exhausted');
  const still = harness([[...header, ...lines(0, 15, 620)]]);
  const stalled = await still.reader.read();
  assert.equal(stalled.article.bodyStatus, 'partial'); assert.equal(stalled.article.bodyReason, 'body_end_unverified');
  assert.equal(stalled.comments.status, 'unknown');
});

test('comment limit without a stable end stays partial when the header omits a count', async () => {
  const end = [...lines(8, 12), row('阅读100', 55, 800, 180), row('不喜欢', 855, 800, 160), row('留言', 55, 1000, 100),
    row('写留言', 75, 1150, 120), row('小明 上海 11月9日', 163, 1320), row('回复', 865, 1320, 80), row('用户的实际评论', 163, 1400)];
  const {reader} = harness([[...header, ...lines(0, 15, 620)], end]);
  const result = await reader.read({limit: 1});
  assert.equal(result.hasMore, false); assert.equal(result.comments.headerCount, null);
  assert.equal(result.comments.status, 'partial'); assert.equal(result.comments.reason, 'comment_limit');
});

test('reaching the real footer and the text budget together is partial after truncation', async () => {
  const {reader} = harness([[...header, ...lines(0, 2, 620)], [...lines(0, 6), ...footer]], {maxCharacters: 100});
  const result = await reader.read({limit: 0});
  assert.equal(result.hasMore, false); assert.equal(result.article.content.length, 100);
  assert.equal(result.article.bodyStatus, 'partial'); assert.equal(result.article.bodyReason, 'text_budget_exhausted');
});

test('article ignores collapsed and visible replies, including an unreadable reply byline', async () => {
  const end = [row('阅读100', 55, 380, 180), row('不喜欢', 855, 380, 160), row('留言2', 55, 515, 100),
    row('写留言', 75, 640, 120), row('小明 上海 11月9日', 163, 750), row('第一条一级留言', 163, 820),
    row('展开3条回复', 230, 925, 250), row('作者 北京 11月9日', 250, 1000), row('这条是回复预览', 250, 1060),
    row('看不清名字的回复 11月9日', 250, 1160), row('这段也属于回复', 250, 1220),
    row('小雨 江苏 11月9日', 163, 1340), row('第二条一级留言', 163, 1410)];
  const {reader, taps} = harness([end, end], supplemental);
  const result = await reader.read({limit: 20, expandLimit: 3});
  assert.deepEqual(taps, []);
  assert.equal(result.comments.status, 'captured');
  assert.equal(result.comments.reason, null);
  assert.deepEqual(result.comments.items.map(item => [item.content, item.reply, item.parentIndex]),
    [['第一条一级留言', false, null], ['第二条一级留言', false, null]]);
  const limited = await harness([end], supplemental).reader.read({limit: 2});
  assert.deepEqual(limited.comments.items.map(item => item.content), ['第一条一级留言', '第二条一级留言']);
});

test('header first paint can stay blank for two frames before body loads without ending or scrolling early', async () => {
  const pages = [header, header, [...header, ...lines(0, 15, 620)], lines(8, 23), [...lines(16, 30), ...footer]];
  let index = 0; const swipes = [];
  const reader = createArticleReader({screen: {swipe: async (...args) => swipes.push(args.slice(0, 5))},
    look: async () => pages[Math.min(index++, pages.length - 1)], assertArticle: async () => {}, wait: async () => {}, now: () => 1});
  const result = await reader.read({limit: 0});
  assert.equal(result.article.bodyStatus, 'complete'); assert.equal(result.hasMore, false);
  assert.equal(swipes.length, 2); assert.equal(result.article.content.split('这段正文记录第0条').length - 1, 1);
  assert.ok(!result.article.content.includes('一篇测试文章'), 'the repeating header is never body text');
});

test('a body that never paints has a bounded load timeout and is never an empty success', async () => {
  const {reader} = harness([header]); let result;
  do { result = await reader.read(); } while (result.hasMore);
  assert.equal(result.pagesRead, 12); assert.equal(result.article.bodyStatus, 'unavailable');
  assert.equal(result.article.bodyReason, 'body_load_timeout'); assert.equal(result.comments.headerCount, null);
});

test('a footer first visible below the safe region cannot freeze or skip the obscured final paragraph', async () => {
  const lastLine = '这段最后的正文不能因为页脚刚露出来而丢失。';
  const pages = [[...header, ...lines(0, 15, 620)], [...lines(8, 23), row(lastLine, 55, 1910), ...footer.map(item => ({...item, y: 2000}))],
    [...lines(16, 23), row(lastLine, 55, 1180), ...footer.map(item => ({...item, y: 1450}))]];
  const {reader} = harness(pages, {maxChunkPages: 1});
  await reader.read({limit: 0});
  const peek = await reader.read({limit: 0}); assert.equal(peek.hasMore, true); assert.equal(peek.article.evidence.bodyEndObserved, false);
  const result = await reader.read({limit: 0});
  assert.equal(result.article.bodyStatus, 'complete'); assert.ok(result.article.content.includes(lastLine));
  assert.equal(result.article.content.split(lastLine).length - 1, 1);
});

test('a stale initial header cannot certify a reader that actually starts in the middle of an article', async () => {
  const initialHeader = parseArticleHeader(fixture('51-latest-article'));
  const {reader} = harness([fixture('52-latest-body-6')], {initialHeader});
  const result = await reader.read();
  assert.equal(result.article.bodyStatus, 'partial'); assert.equal(result.article.bodyReason, 'header_unverified');
});

const supplemental = {bodyRequired: false, initialHeader: parseArticleHeader(header)};

test('T13 real animated ads and changing dislike icons stop after one verified forward swipe at the same footer', async () => {
  for (const frames of [['018', '019'], ['151', '152']]) {
    const {reader, swipes} = harness(frames.map(frame => t13(`t12-week/${frame}`)), supplemental);
    const result = await reader.read();
    assert.equal(result.hasMore, false); assert.equal(result.pagesRead, 2);
    assert.deepEqual(swipes, [[540, 1750, 540, 1200, 1100]]);
    assert.notEqual(result.article.evidence.scanReason, 'screen_budget_exhausted');
    assert.equal(result.comments.status, frames[0] === '018' ? 'unavailable' : 'empty');
  }
  const empty = await harness([t13('t12-week/128'), t13('t12-week/128')], supplemental).reader.read();
  assert.equal(empty.comments.status, 'empty'); assert.equal(empty.comments.headerCount, 0);
  assert.equal(empty.comments.postingState, 'followers_only');
});

test('T13 footer pinning cannot equate different anchor types, numbers or a movement beyond eight pixels', async () => {
  const first = [row('阅读100', 55, 500, 180), row('不喜欢', 855, 500, 160), row('留言', 55, 700, 90),
    row('写留言', 75, 850, 140), row('上一幅广告介绍', 200, 1200, 500)];
  const changingAd = [row('这一幅广告完全不同', 200, 1180), row('第二条动画广告说明', 200, 1280), row('第三条动画广告说明', 200, 1380)];
  const cases = [
    [row('留言', 55, 500, 90), row('写留言', 75, 850, 140), ...changingAd],
    [row('阅读101', 55, 500, 180), row('不喜欢', 855, 500, 160), row('留言', 55, 700, 90), row('写留言', 75, 850, 140), ...changingAd],
    [row('阅读100', 55, 509, 180), row('不喜欢', 855, 509, 160), row('留言', 55, 700, 90), row('写留言', 75, 850, 140), ...changingAd],
  ];
  for (const second of cases) {
    const {reader} = harness([first, second], {...supplemental, maxChunkPages: 1});
    assert.equal((await reader.read()).hasMore, true);
    assert.equal((await reader.read()).hasMore, true, 'a changed footer is not proof of the scroll limit');
  }
});

test('a collapsed reply control does not delay the next forward swipe at the footer', async () => {
  const common = [row('阅读100', 55, 500, 180), row('不喜欢', 855, 500, 160), row('留言2', 55, 700, 90),
    row('读者 上海 11月9日', 163, 950, 450), row('第一条留言', 163, 1040, 450)];
  const before = [...common, row('展开1条回复', 163, 1140, 450)];
  const {reader, taps, swipes} = harness([before, before], {...supplemental, maxChunkPages: 1});
  assert.equal((await reader.read()).hasMore, true);
  const result = await reader.read();
  assert.equal(result.hasMore, false);
  assert.equal(result.comments.items.length, 1);
  assert.equal(result.comments.status, 'partial', 'a real count shortfall is still partial');
  assert.deepEqual(taps, []);
  assert.deepEqual(swipes, [[540, 1750, 540, 1200, 1100]]);
});

test('delegated body scanning uses a held fast swipe before the footer and the original short swipe afterwards', async () => {
  const end = fixture('52-latest-body-6');
  const {reader, swipes, waits, checks} = harness([lines(40, 48), end, end], {...supplemental, maxChunkPages: 1});
  const first = await reader.read();
  assert.equal(first.hasMore, true); assert.equal(first.article.bodyStatus, 'delegated');
  assert.equal(first.article.content, ''); assert.equal(first.article.title, '一篇测试文章');
  const second = await reader.read(); assert.equal(second.hasMore, true);
  const result = await reader.read();
  assert.equal(result.hasMore, false); assert.equal(result.pagesRead, 3);
  assert.equal(result.comments.status, 'unavailable'); assert.equal(result.comments.headerCount, null);
  assert.equal(result.comments.reason, 'no_comment_entry');
  assert.equal(result.article.bodyStatus, 'delegated'); assert.equal(result.article.bodyReason, 'body_delegated');
  assert.equal(result.article.content, ''); assert.equal(result.article.evidence.bodyEndObserved, true);
  assert.equal(result.article.evidence.bodyCapture, 'delegated'); assert.equal(result.article.evidence.overlapVerified, null);
  assert.ok(result.article.metrics.read.value > 0); assert.ok(checks() >= result.pagesRead + swipes.length);
  assert.deepEqual(swipes, [[540, 1850, 540, 550, 600, 200], [540, 1750, 540, 1200, 1100]]);
  assert.deepEqual(waits, [300, 850]);
  assert.deepEqual(result.article.evidence.commentScan, {fastScreens: 2, slowScreens: 1, footerSearchMs: 1100});
});

test('a fast swipe past the comment heading backs up before collecting the first comment', async () => {
  const middle = [row('写留言', 75, 310, 150), row('后面的读者 广东 11月9日', 163, 520), row('后面的留言', 163, 605)];
  const end = [row('留言2', 55, 370, 150), row('写留言', 75, 500, 150),
    row('最先的读者 上海 11月9日', 163, 650), row('文末第一条留言', 163, 730),
    ...middle.slice(1).map(item => ({...item, y: item.y + 550}))];
  const {reader, swipes, waits} = harness([lines(40, 48), middle, end, end], {...supplemental, maxChunkPages: 1});
  let result;
  do { result = await reader.read(); } while (result.hasMore);
  assert.deepEqual(swipes, [[540, 1850, 540, 550, 600, 200], [540, 1000, 540, 1650, 600, 200], [540, 1750, 540, 1200, 1100]]);
  assert.deepEqual(waits, [300, 300, 850]);
  assert.deepEqual(result.article.evidence.commentScan, {fastScreens: 3, slowScreens: 1, footerSearchMs: 2200});
  assert.equal(result.comments.status, 'captured');
  assert.deepEqual(result.comments.items.map(item => item.content), ['文末第一条留言', '后面的留言']);
});

test('a visible comment row alone triggers the same bounded reverse and does not claim coverage without a heading', async () => {
  const middle = [row('后面的读者 广东 11月9日', 163, 520), row('后面的留言', 163, 605)];
  const {reader, swipes} = harness([lines(40, 48), middle, middle], supplemental);
  const result = await reader.read();
  assert.deepEqual(swipes, [[540, 1850, 540, 550, 600, 200], [540, 1000, 540, 1650, 600, 200]]);
  assert.equal(result.hasMore, false);
  assert.equal(result.article.evidence.bodyEndObserved, false);
  assert.equal(result.article.evidence.commentScan.footerSearchMs, null);
  assert.equal(result.comments.status, 'unknown');
  assert.equal(result.comments.reason, 'comment_start_unverified');
  assert.deepEqual(result.comments.items, []);
});

test('delegated mode preserves closed comments and followers-only public comments without tapping', async () => {
  const closed = [...footer.map(item => ({...item, y: 1300})), row('作者已关闭留言', 75, 1550, 500)];
  const closedResult = await harness([closed, closed], supplemental).reader.read();
  assert.equal(closedResult.comments.status, 'closed'); assert.equal(closedResult.comments.postingState, 'closed');
  assert.equal(closedResult.comments.headerCount, null); assert.equal(closedResult.article.metrics.read.value, 100);
  assert.equal(closedResult.article.bodyStatus, 'delegated');
  const end = fixture('43-image-comments');
  const followersResult = await harness([end, end], supplemental).reader.read();
  assert.equal(followersResult.comments.postingState, 'followers_only');
  assert.equal(followersResult.comments.status, 'captured'); assert.equal(followersResult.comments.items[0].content, '好得很');
  assert.equal(followersResult.article.content, '');
});

test('delegated mode with comments disabled still reaches the verified footer and reads metrics', async () => {
  const end = [...footer.map(item => ({...item, y: 1400})), row('7', 600, 2180, 40), row('3', 710, 2180, 40), row('2', 820, 2180, 40)];
  const {reader, swipes} = harness([lines(20, 28), end], supplemental);
  const result = await reader.read({commentsEnabled: false});
  assert.equal(result.hasMore, false); assert.equal(swipes.length, 1);
  assert.equal(result.comments.status, 'disabled'); assert.deepEqual(result.comments.items, []);
  assert.equal(result.article.metrics.read.value, 100); assert.equal(result.article.metrics.like.value, 7);
  assert.equal(result.article.metrics.share.value, 3); assert.equal(result.article.metrics.recommend.value, 2);
  assert.equal(result.article.bodyStatus, 'delegated'); assert.equal(result.article.evidence.bodyEndObserved, true);
});

test('delegated scanning requires verified identity and retains page limits, cancellation, and footer proof', async () => {
  assert.throws(() => harness([lines(0, 8)], {bodyRequired: false}), {code: 'article_identity_unverified'});
  const {reader} = harness([lines(20, 28), [...lines(25, 33), row('留言', 55, 1700)]], {...supplemental, maxPages: 2});
  const result = await reader.read();
  assert.equal(result.hasMore, false); assert.equal(result.article.bodyStatus, 'delegated');
  assert.equal(result.article.evidence.bodyEndObserved, true); assert.equal(result.article.evidence.scanReason, 'screen_budget_exhausted');
  assert.equal(result.comments.status, 'unknown'); assert.equal(result.comments.headerCount, null);
  const aborted = harness([lines(20, 28)], supplemental); const controller = new AbortController(); controller.abort();
  await assert.rejects(aborted.reader.read({signal: controller.signal}));
  assert.equal(aborted.checks(), 0); assert.equal(aborted.swipes.length, 0);
});

test('T13 delegated scans without any footer still stop at the page budget with unknown counts', async () => {
  const {reader} = harness([lines(20, 28), lines(25, 33)], {...supplemental, maxPages: 2});
  const result = await reader.read();
  assert.equal(result.hasMore, false); assert.equal(result.pagesRead, 2);
  assert.equal(result.article.evidence.bodyEndObserved, false);
  assert.equal(result.article.evidence.scanReason, 'screen_budget_exhausted');
  assert.equal(result.comments.status, 'unknown'); assert.equal(result.comments.headerCount, null);
  assert.equal(result.article.metrics.read.value, null);
});

test('T13 original 130–135 screens reach comments after the merged read row and keep incomplete coverage partial', async () => {
  const pages = Array.from({length: 6}, (_, index) => t13Comments(130 + index));
  const {reader, swipes} = harness(pages, {...supplemental, maxPages: pages.length});
  const result = await reader.read({limit: 50});
  assert.equal(result.hasMore, false); assert.equal(result.pagesRead, 6); assert.equal(swipes.length, 5);
  assert.equal(result.article.evidence.bodyEndObserved, true);
  assert.deepEqual({raw: result.article.metrics.read.raw, value: result.article.metrics.read.value, precision: result.article.metrics.read.precision},
    {raw: '3.6万', value: 36000, precision: 'rounded'});
  assert.equal(result.comments.headerCount, 13); assert.equal(result.comments.status, 'partial');
  assert.equal(result.comments.postingState, 'followers_only'); assert.equal(result.comments.visibleScopeComplete, false);
  assert.ok(result.comments.items.length > 0 && result.comments.items.length < 13);
  assert.ok(result.comments.items.every(item => !/(京东|新人0\.01|这个还真的要交钱|这个我觉得蛮正常)/u.test(item.content)));
  assert.equal(result.comments.items.find(item => item.author === '欲.').content, '收费也能理解，毕竟人家提供了服务嘛');
});

test('T14 bounded reader chunks keep uncertain text and preserve a later observed author over subsequent symbol frames', async () => {
  const pages = [
    [row('留言1', 55, 400), row('↓ 安徽 2023年9月14日', 163, 600), row('这个我觉得蛮正常', 163, 680)],
    [row('真实读者 安徽 2023年9月14日', 163, 400), row('这个我觉得蛮正常', 163, 480)],
    [row('※ 安徽 2023年9月14日', 163, 240), row('这个我觉得蛮正常', 163, 320)],
  ];
  const {reader} = harness(pages, {...supplemental, maxChunkPages: 1, maxPages: 3});
  const first = await reader.read({limit: 50});
  assert.equal(first.comments.items[0].author, ''); assert.equal(first.comments.items[0].authorUncertain, true);
  assert.equal(first.comments.items[0].content, '这个我觉得蛮正常');
  const second = await reader.read({limit: 50});
  assert.equal(second.comments.items.length, 1); assert.equal(second.comments.items[0].author, '真实读者');
  const last = await reader.read({limit: 50});
  assert.equal(last.comments.items.length, 1); assert.equal(last.comments.items[0].author, '真实读者');
  assert.equal(Object.hasOwn(last.comments.items[0], 'authorUncertain'), false);
  assert.equal(Object.hasOwn(last.comments.items[0], 'cut'), false);
  assert.equal(last.comments.status, 'partial');
});

test('T13 original header-only 131–135 screens independently start comment reading without a fabricated read count', async () => {
  const pages = Array.from({length: 5}, (_, index) => t13Comments(131 + index));
  const {reader, swipes} = harness(pages, {...supplemental, maxPages: pages.length, maxChunkPages: 1});
  let result = await reader.read({limit: 50});
  assert.equal(result.article.evidence.bodyEndObserved, true); assert.equal(result.comments.items.length, 1);
  assert.equal(result.hasMore, true, 'the moving heading does not prove a pinned end');
  while (result.hasMore) result = await reader.read({limit: 50});
  assert.equal(result.pagesRead, 5); assert.equal(swipes.length, 4);
  assert.deepEqual(result.article.metrics.read, {raw: null, value: null, precision: 'unknown'});
  assert.equal(result.comments.headerCount, 13); assert.equal(result.comments.status, 'partial');
  assert.ok(result.comments.items.length > 0 && result.comments.items.length < 13);
});

test('T13 a bare comment heading proves the end but does not prove empty or closed comments', async () => {
  const end = [row('留言', 55, 700, 100)];
  const result = await harness([end, end], supplemental).reader.read();
  assert.equal(result.article.evidence.bodyEndObserved, true); assert.equal(result.hasMore, false);
  assert.equal(result.comments.status, 'unknown'); assert.equal(result.comments.postingState, 'unknown');
  assert.equal(result.comments.headerCount, null); assert.deepEqual(result.comments.items, []);
  assert.deepEqual(result.article.metrics.read, {raw: null, value: null, precision: 'unknown'});
});

test('T13 a comment heading crossing the safe bottom edge is not yet an observed body end', async () => {
  for (const y of [1850, 1880]) {
    const pages = [[row('留言13', 55, y, 150, 50)], [row('留言13', 55, 1400, 150, 50)]];
    const {reader} = harness(pages, {...supplemental, maxChunkPages: 1});
    const peek = await reader.read();
    assert.equal(peek.article.evidence.bodyEndObserved, false); assert.equal(peek.hasMore, true);
    assert.equal(peek.comments.headerCount, null); assert.equal(peek.comments.status, 'unknown');
    const result = await reader.read();
    assert.equal(result.article.evidence.bodyEndObserved, true); assert.equal(result.comments.headerCount, 13);
    assert.equal(result.article.metrics.read.value, null);
  }
});

test('T13 diagnostic body capture ends before the comment heading and excludes the comment area', async () => {
  const page = [...header, row('这是真实正文最后一段。', 55, 620), row('留言13', 55, 1000),
    row('甲 上海 11月9日', 163, 1200), row('这条留言不是文章正文', 163, 1300)];
  const result = await harness([page]).reader.read({commentsEnabled: false});
  assert.equal(result.article.bodyStatus, 'complete'); assert.equal(result.article.content, '这是真实正文最后一段。');
  assert.equal(result.article.evidence.bodyEndObserved, true); assert.equal(result.comments.status, 'disabled');
  assert.equal(result.article.metrics.read.value, null);
});

test('T13 comment headings at or below y1900 do not freeze obscured final body text', async () => {
  for (const y of [1900, 2000]) {
    const lastLine = '最后的正文仍须完整读到。';
    const pages = [[...header, ...lines(0, 15, 620)], [...lines(8, 23), row(lastLine, 55, 1850), row('留言13', 55, y)],
      [...lines(16, 23), row(lastLine, 55, 1180), row('留言13', 55, 1450)]];
    const {reader} = harness(pages, {maxChunkPages: 1});
    await reader.read({commentsEnabled: false});
    const peek = await reader.read({commentsEnabled: false});
    assert.equal(peek.hasMore, true); assert.equal(peek.article.evidence.bodyEndObserved, false);
    const result = await reader.read({commentsEnabled: false});
    assert.equal(result.article.bodyStatus, 'complete'); assert.equal(result.article.evidence.bodyEndObserved, true);
    assert.ok(result.article.content.includes(lastLine)); assert.ok(!result.article.content.includes('留言13'));
  }
});

test('each displayed metric keeps its screen observation time after it scrolls out of view', async () => {
  const end = footer.map(item => ({...item, y: 1400}));
  const after = [row('留言', 55, 500), row('写留言', 75, 700)]; let time = Date.parse('2026-11-09T10:00:00+08:00');
  const {reader} = harness([end, after, after], {...supplemental, maxChunkPages: 1, now: () => time});
  const first = await reader.read();
  assert.equal(first.article.metrics.read.source, 'screen_ocr');
  assert.equal(first.article.metrics.read.capturedAt, '2026-11-09T02:00:00.000Z');
  time += 5000;
  const next = await reader.read();
  assert.equal(next.article.metrics.read.capturedAt, first.article.metrics.read.capturedAt, 'absent metric is not re-observed');
  assert.equal(next.comments.capturedAt, '2026-11-09T02:00:05.000Z');
});
