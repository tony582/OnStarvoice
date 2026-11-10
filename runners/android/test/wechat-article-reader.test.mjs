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
function harness(pages, options = {}) {
  let index = 0, checks = 0; const swipes = [];
  const reader = createArticleReader({screen: {swipe: async (...args) => { swipes.push(args.slice(0, 5)); index = Math.min(index + 1, pages.length - 1); }},
    look: async () => pages[index], assertArticle: async () => { checks++; }, wait: async () => {}, now: () => 1, ...options});
  return {reader, swipes, checks: () => checks};
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

test('reply expansion is bounded to three verified comment controls and does not claim hidden replies captured', async () => {
  const end = number => [...lines(8, 12), row('阅读100', 55, 800, 180), row('不喜欢', 855, 800, 160), row('留言8', 55, 1000, 100),
    row('写留言', 75, 1150, 120), row('小明 上海 11月9日', 163, 1320), row('回复', 865, 1320, 80), row('用户的实际评论', 163, 1400),
    row(`展开${number}条回复`, 230, 1560, 250)];
  const pages = [[...header, ...lines(0, 15, 620)], end(1), end(2), end(3), end(4)];
  let index = 0; const taps = [];
  const reader = createArticleReader({screen: {swipe: async () => { index = Math.min(index + 1, pages.length - 1); },
    tap: async (x, y) => { taps.push([x, y]); index = Math.min(index + 1, pages.length - 1); }}, look: async () => pages[index],
    assertArticle: async () => {}, wait: async () => {}, now: () => 1});
  const result = await reader.read({limit: 20});
  assert.equal(taps.length, 3); assert.ok(taps.every(([x, y]) => x > 145 && y > 1400 && y < 1980));
  assert.equal(result.comments.status, 'partial'); assert.equal(result.comments.reason, 'replies_not_expanded');
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

test('delegated body scanning continues in bounded short steps from the current position and distinguishes a missing comment entry', async () => {
  const end = fixture('52-latest-body-6');
  const {reader, swipes, checks} = harness([lines(40, 48), end, end], {...supplemental, maxChunkPages: 1});
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
  assert.deepEqual(swipes, [[540, 1750, 540, 1200, 1100], [540, 1750, 540, 1200, 1100]], 'no header seek or body-overlap reverse');
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
  assert.equal(result.article.evidence.bodyEndObserved, false); assert.equal(result.article.evidence.scanReason, 'screen_budget_exhausted');
  assert.equal(result.comments.status, 'unknown'); assert.equal(result.comments.headerCount, null);
  const aborted = harness([lines(20, 28)], supplemental); const controller = new AbortController(); controller.abort();
  await assert.rejects(aborted.reader.read({signal: controller.signal}));
  assert.equal(aborted.checks(), 0); assert.equal(aborted.swipes.length, 0);
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
