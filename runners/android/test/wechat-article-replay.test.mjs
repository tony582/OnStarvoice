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
