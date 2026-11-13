import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createArticleReader} from '../src/device/wechat-article-reader.mjs';
import {parseArticleComments, mergeArticleComments} from '../src/device/wechat-article-comments.mjs';
import {parseArticleHeader} from '../src/device/wechat-article-parse.mjs';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/wechat-articles/${name}.json`, import.meta.url)));
async function replay(name) {
  const pages = fixture(name); let index = 0;
  const reader = createArticleReader({screen: {swipe: async () => { index = Math.min(index + 1, pages.length - 1); }},
    look: async () => pages[index].rows, assertArticle: async () => {}, wait: async () => {}, now: () => 1});
  let result; do { result = await reader.read({limit: 20}); } while (result.hasMore);
  return result;
}

test('ordinary-v7 real phone replay: all fourteen frames merge into one body with two uncontaminated comments', async () => {
  const result = await replay('ordinary-v7-read-pages');
  assert.equal(result.pagesRead, 14);
  assert.equal(result.article.bodyStatus, 'complete'); assert.equal(result.article.account, '白白过一天');
  assert.equal(result.article.evidence.overlapVerified, true);
  for (const title of ['3.1年免费增值功能', '二、要不要续费，分两种情况判断', '三、续费省钱建议', '总结', '响行车安全。']) {
    assert.equal(result.article.content.split(title).length - 1, 1, `${title} must occur once`);
  }
  assert.ok(!result.article.content.includes('安吉星紧急救援需要收费吗'));
  assert.ok(!result.article.content.includes('已复制到剪贴板'));
  assert.ok(!result.article.content.includes('二、要不要续费，“'));
  assert.deepEqual(result.comments.items.map(item => item.content), ['怎么续费来个网址', '我也想要一个']);
  assert.equal(result.comments.status, 'captured'); assert.equal(result.comments.headerCount, 2);
});

test('v7 split metadata is actual header evidence, and a clear later comment can replace an earlier cut fragment', () => {
  const pages = fixture('ordinary-v7-read-pages');
  assert.equal(parseArticleHeader(pages[0].rows).headerVerified, true);
  const partial = parseArticleComments(pages.find(page => page.frame === '029.json').rows);
  const complete = parseArticleComments(pages.find(page => page.frame === '030.json').rows);
  assert.deepEqual(mergeArticleComments(partial.comments, complete.comments).map(item => item.content), ['怎么续费来个网址', '我也想要一个']);
  const old = {...complete.comments[0], content: '怎么续费来个网址樊旭内蒙古9月20ロ我也想要一个', cut: true};
  assert.equal(mergeArticleComments([old], complete.comments)[0].content, '怎么续费来个网址');
});

test('image-v1 real phone replay: sparse infographic content survives scrolling and followers-only comments stay readable', async () => {
  const result = await replay('image-v1-read-pages');
  assert.equal(result.article.title, '解锁安吉星小程序4大板块');
  assert.equal(result.article.bodyStatus, 'complete');
  assert.ok(result.article.content.includes('400-820-1188'));
  for (const label of ['我的车况', '福利活动', '过往订单', 'Step 01', 'Step 02', 'Step 03', '获取更多资讯']) assert.ok(result.article.content.includes(label), label);
  assert.ok(!result.article.content.includes('复制到剪贴板'));
  assert.equal(result.comments.postingState, 'followers_only'); assert.equal(result.comments.items.length, 1);
  assert.equal(result.article.evidence.originalImagesCaptured, false);
});

test('T14 original 014–026 replay keeps ten distinct comments, removes the whole ad, and preserves three uncertain authors', async () => {
  const pages = Object.values(fixture('t14-comment-quality-20261110')); let index = 0;
  const advance = async () => { index = Math.min(index + 1, pages.length - 1); };
  const reader = createArticleReader({bodyRequired: false,
    initialHeader: {title: '离线回放已核对的文章', account: '汽车365热线', headerVerified: true, source: 'page_dom'},
    screen: {swipe: advance, swipeAndHold: advance}, look: async () => pages[index].rows,
    assertArticle: async () => {}, wait: async () => {}, now: () => 1});
  const first = await reader.read({limit: 50});
  assert.equal(first.hasMore, true); assert.equal(first.pagesRead, 8);
  const result = await reader.read({limit: 50}), items = result.comments.items;
  assert.equal(result.hasMore, false); assert.equal(result.pagesRead, 13);
  assert.equal(result.article.bodyStatus, 'delegated'); assert.equal(result.article.content, '');
  assert.equal(result.article.metrics.read.value, 36000);
  assert.equal(result.comments.status, 'partial'); assert.equal(result.comments.headerCount, 13);
  assert.equal(result.comments.visibleScopeComplete, false); assert.equal(result.comments.postingState, 'followers_only');
  assert.equal(items.length, 10);
  assert.equal(items.filter(item => item.content.startsWith('这个通用没毛病')).length, 1);
  assert.equal(items.filter(item => item.content === '这个我觉得蛮正常').length, 1);
  assert.equal(items.find(item => item.author === '欲.').content, '收费也能理解，毕竟人家提供了服务嘛');
  assert.ok(items.every(item => !/全友|629元|了解更多|厂告|广告/u.test(item.content)));
  const uncertain = items.filter(item => item.authorUncertain);
  assert.equal(uncertain.length, 3); assert.ok(uncertain.every(item => item.author === '' && item.likeCount === null));
  assert.deepEqual(uncertain.map(item => item.content), ['这个还真的要交钱，别克对2条回～', '这个我觉得蛮正常',
    '如果不是车带的功能，是额外的网络功能，要收费挺正常啊。']);
  assert.ok(items.filter(item => item.author).every(item => !Object.hasOwn(item, 'authorUncertain')));
});
