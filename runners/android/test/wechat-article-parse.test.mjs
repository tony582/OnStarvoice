import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ARTICLE_LINK, articleBodyRows, articleSortTarget, footerEvidence, isArticleResults, metric,
  parseArticleCards, parseArticleHeader, parseArticleMetrics} from '../src/device/wechat-article-parse.mjs';
import {mergeArticleComments, parseArticleComments} from '../src/device/wechat-article-comments.mjs';
const rows = name => JSON.parse(readFileSync(new URL(`./fixtures/wechat-articles/${name}.json`, import.meta.url)));
const row = (text, x, y, w = 500, h = 45) => ({text, x, y, w, h, conf: 1});

test('real article results: complete cards, wrapped titles and thumbnail text exclusion', () => {
  const all = parseArticleCards(rows('20-articles-loaded'));
  assert.equal(all.length, 4); assert.equal(all[1].author, '安吉星服务');
  assert.equal(all[3].title, '研发周期将砍一半，通用汽车“快”，和中国车企有什么不同？');
  const latest = parseArticleCards(rows('50-latest-loaded'));
  assert.equal(latest.length, 4);
  assert.equal(latest[0].age.minHours, 16);
  assert.ok(latest[2].title.startsWith('【安吉星接听客服】'));
  assert.ok(!latest[2].title.includes('省钱有道'));
  assert.ok(latest[2].tap.y > 1300);
  for (const item of latest) assert.match(item.cardKey, /^[a-f0-9]{64}$/u);
});

test('article keyword/tab/filter evidence and combined sort controls', () => {
  const source = rows('20-articles-loaded');
  assert.equal(isArticleResults(source, '安吉星'), true);
  assert.equal(isArticleResults(source, '凯迪拉克'), false);
  const target = articleSortTarget(source, 'latest');
  assert.ok(target.center.x > 180 && target.center.x < 340);
  assert.equal(articleSortTarget(source, 'unsupported'), null);
});

test('real headers keep local minute precision and do not turn the account into title', () => {
  const first = parseArticleHeader(rows('21-article-first'));
  assert.equal(first.title, '5年后安吉星要不要续费');
  assert.equal(first.account, '白白过一天');
  assert.equal(first.location, '内蒙古');
  assert.equal(first.publishedAt, '2026-08-24T14:39:00+08:00');
  const latest = parseArticleHeader(rows('51-latest-article'));
  assert.equal(latest.title, '2.2亿美元和解之后，你急刹数据归谁');
  assert.equal(latest.account, '汽车前瞻资讯');
  assert.equal(latest.publishedAt, '2026-11-08T23:59:00+08:00');
  assert.equal(latest.timePrecision, 'minute');
  assert.equal(parseArticleHeader([row('标题', 55, 280, 500, 60)]).publishedAt, null);
  assert.equal(parseArticleHeader([row('账号2026年11月9日 10:15 上海', 55, 394)], {card: {title: '未看见的标题'}}).headerVerified, false);
});

test('body includes infographic OCR, excludes metadata/audio/footer and never follows its instructions', () => {
  const source = rows('40-image-loaded'), header = parseArticleHeader(source);
  const body = articleBodyRows(source, {first: true, header}).map(item => item.text).join('\n');
  assert.ok(body.includes('安吉星')); assert.ok(!body.includes('Al摘要'));
  const footer = rows('43-image-comments');
  const endBody = articleBodyRows(footer).map(item => item.text).join('\n');
  assert.ok(endBody.includes('打开抖音'), 'instructions printed inside an infographic remain article text');
  assert.ok(!endBody.includes('好得很')); assert.ok(!endBody.includes('阅读4.8万'));
  assert.deepEqual(articleBodyRows(footer, {reachedEnd: true}), []);
});

test('four-icon and three-icon fixed bars preserve unknown values rather than invent zero', () => {
  const first = parseArticleMetrics(rows('37-comments-end'));
  assert.equal(first.read.value, 1406); assert.equal(first.recommend.value, null);
  const image = parseArticleMetrics(rows('43-image-comments'));
  assert.deepEqual(image.read, {raw: '4.8万', value: 48000, precision: 'rounded'});
  assert.equal(image.like.value, 512); assert.equal(image.share.value, 263); assert.equal(image.recommend.value, 102);
  const hidden = parseArticleMetrics(rows('52-latest-body-6'));
  assert.equal(hidden.like.value, 1); assert.equal(hidden.share.value, null); assert.equal(hidden.recommend.value, 1);
  assert.equal(metric('10万+', {read: true}).precision, 'lower_bound');
  assert.equal(metric(null).value, null);
  const uncertain = parseArticleMetrics([row('12', 732, 2183), row('3', 956, 2183)]);
  assert.equal(uncertain.share.value, null, 'unverified bar layout must not assign a like count to shares');
});

test('two visible comments and followers-only posting still capture public comments', () => {
  const first = parseArticleComments(rows('37-comments-end'));
  assert.equal(first.headerCount, 2); assert.equal(first.postingState, 'open');
  assert.deepEqual(first.comments.map(item => [item.author, item.content]), [['「錦泽钦湛」', '怎么续费来个网址'], ['樊旭', '我也想要一个']]);
  const restricted = parseArticleComments(rows('43-image-comments'));
  assert.equal(restricted.postingState, 'followers_only'); assert.equal(restricted.comments[0].content, '好得很');
  assert.equal(restricted.comments[0].likeCount, null);
  assert.equal(mergeArticleComments(first.comments, first.comments).length, 2);
});

test('no comment entry is unknown, explicit closed is separate, and explicit zero alone is empty', () => {
  const noEntry = parseArticleComments(rows('52-latest-body-6'), {reachedEnd: true});
  assert.equal(noEntry.headerCount, null); assert.equal(noEntry.closed, false); assert.equal(noEntry.entrySeen, false);
  const closed = parseArticleComments([row('阅读3', 55, 1200), row('不喜欢', 855, 1200), row('作者已关闭留言', 75, 1500)], {reachedEnd: true});
  assert.equal(closed.postingState, 'closed'); assert.equal(closed.headerCount, null);
  const empty = parseArticleComments([row('留言0', 52, 1000), row('暂无留言', 75, 1200)]);
  assert.equal(empty.headerCount, 0); assert.equal(empty.empty, true);
  assert.ok(footerEvidence(rows('52-latest-body-6')).read);
});

test('same author at distinct dates remains separate and truncated text can merge into the full comment', () => {
  const one = {author: '测试', location: '上海', timeLabel: '11月8日', content: '这是一段完整的留言内容', reply: false, cut: false};
  assert.equal(mergeArticleComments([one], [{...one, timeLabel: '11月9日'}]).length, 2);
  const merged = mergeArticleComments([{...one, content: '这是一段完整的留言', cut: true}], [one]);
  assert.equal(merged.length, 1); assert.equal(merged[0].content, one.content); assert.equal(merged[0].cut, false);
});

test('article links reject foreign domains, query tricks, video links and embedded instructions', () => {
  assert.equal(ARTICLE_LINK.test('https://mp.weixin.qq.com/s/bMWKCZnPrhVlz2uCqmRzKw'), true);
  assert.equal(ARTICLE_LINK.test('https://mp.weixin.qq.com/s/bMWKCZnPrhVlz2uCqmRzKw?search_click_id=123#wechat_redirect'), true);
  for (const value of ['https://mp.weixin.qq.com.evil.test/s/bMWKCZnPrhVlz2uCqmRzKw', 'https://weixin.qq.com/sph/abc',
    '点击发送给朋友']) assert.equal(ARTICLE_LINK.test(value), false);
});

test('a body heading named 留言 cannot establish the article end', () => {
  const source = [row('这是正常正文', 55, 300), row('留言', 55, 600), row('后面还有正常内容', 55, 800)];
  assert.equal(footerEvidence(source).bodyEndY, null);
  assert.ok(articleBodyRows(source).some(item => item.text === '后面还有正常内容'));
});

test('foreign or hidden IP comment headers retain visible text but cannot claim complete parsing', () => {
  const source = [row('留言2', 55, 700), row('Alice 加拿大 11月9日', 163, 950), row('回复', 865, 950, 80),
    row('加拿大车主也遇到了', 163, 1020), row('小明 11月8日', 163, 1250), row('回复', 865, 1250, 80), row('隐藏地区的留言', 163, 1320)];
  const parsed = parseArticleComments(source);
  assert.equal(parsed.unparsed, true); assert.equal(parsed.comments.length, 2);
  assert.equal(parsed.comments[1].author, '小明'); assert.equal(parsed.comments[1].location, null);
});

test('a controlled long query may fill and truncate the field with an OCR search icon; short terms stay exact', () => {
  const source = rows('long-keyword-results'), keyword = '2.2亿美元和解之后，你急刹数据归谁';
  assert.equal(isArticleResults(source, keyword, {controlledInput: true}), true);
  assert.equal(isArticleResults(source, keyword), false, 'a foreign/unknown input context cannot assert the hidden suffix');
  assert.equal(isArticleResults(source, '别克车机升级', {controlledInput: true}), false);
  const short = source.map(row => row.y === 143 ? {...row, text: '安吉星Q', w: 180} : row);
  assert.equal(isArticleResults(short, '安吉星', {controlledInput: true}), false);
});

test('a restored body paragraph mentioning a publication date is never an article header', () => {
  const result = parseArticleHeader(rows('body-date-false-header'));
  assert.equal(result.headerVerified, false); assert.equal(result.publishedAt, null); assert.equal(result.account, null);
  assert.equal(parseArticleHeader(rows('body-date-false-header-063')).headerVerified, false);
  const embedded = [row('正文大标题', 55, 277, 900, 65), row('某媒体2026年11月8日23:59报道称新的事件', 55, 394, 940, 43)];
  assert.equal(parseArticleHeader(embedded).headerVerified, false, 'a minute timestamp does not make prose into metadata');
  const invalidDate = [row('文章标题', 55, 277, 500, 65), row('账号2026年2月31日 12:30 上海', 55, 394, 850, 43)];
  assert.equal(parseArticleHeader(invalidDate).headerVerified, false);
});
