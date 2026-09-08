import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeishuDailyPost, feishuDailyPostRequestBytes, FEISHU_DAILY_POST_MAX_BYTES,
  FEISHU_DAILY_POST_IMAGE_PLACEHOLDER } from '../server/services/feishu-daily-report-message.js';

const documentUrl = 'https://example.feishu.cn/docx/daily';
const imageKey = 'img_v3_test-summary';
const item = index => ({title: `帖子${index}`, platform: 'xiaohongshu', url: `https://www.xiaohongshu.com/explore/${index}`, heat: 320, comparisonText: '↑180%'});
const snapshot = overrides => ({tenantName: '安吉星', reportDate: '2026-09-07', highHeat: [], coldMarked: [], evidence: {cold: {coverageComplete: true}}, ...overrides});
const build = input => buildFeishuDailyPost({snapshot: snapshot(input), imageKey, documentUrl});
const nodes = post => post.zh_cn.content.flat();
const words = post => nodes(post).map(node => node.text || '').join('\n');
const links = post => nodes(post).filter(node => node.tag === 'a');

test('daily post renders an actual top image and all 11 post links plus editable document', () => {
  const post = build({highHeat: Array.from({length: 7}, (_, i) => item(i)), coldMarked: Array.from({length: 4}, (_, i) => item(20 + i))});
  assert.equal(post.zh_cn.title, '安吉星 · 舆情日报 2026-09-07');
  assert.deepEqual(post.zh_cn.content[0], [{tag: 'img', image_key: imageKey}]);
  assert.equal(links(post).length, 12);
  assert.equal(links(post).at(-1).href, documentUrl);
  assert.match(words(post), /TOP7：/);
  assert.match(words(post), /热度 320 \| 较昨日 ↑180%/);
  assert.match(words(post), / - 小红书/);
  assert.doesNotMatch(words(post), /另有|测试|数据说明|截至/);
});

test('untrusted titles remain ordinary nodes and unsafe or credential-bearing URLs are not linked', () => {
  const maliciousTitle = '[](<at user_id="all">) **标题** <script>&amp;';
  const urls = ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.com/post', 'https://example.com/\npost'];
  const post = build({highHeat: [{...item(1), title: maliciousTitle, url: 'https://example.com/post?q=%5Btest%5D&x=1'}, ...urls.map((url, i) => ({...item(i + 2), url}))]});
  assert.equal(links(post)[0].text, maliciousTitle);
  assert.equal(links(post).length, 2);
  assert.equal(nodes(post).filter(node => !['text', 'a', 'img'].includes(node.tag)).length, 0);
  assert.match(words(post), /原帖链接待补/);
  assert.equal(JSON.stringify(post).includes('user:password'), false);
});

test('cold empty states preserve known empty versus unavailable history', () => {
  assert.match(words(build({})), /当日无新增冷处理负面帖子。/);
  const unknown = build({evidence: {cold: {coverageComplete: false}}});
  assert.match(words(unknown), /暂未检出。/);
  assert.doesNotMatch(words(unknown), /当日无新增|冷处理 0/);
});

test('comparison placeholders stay explicit and numeric heat is never invented', () => {
  const values = [{...item(1), comparisonText: undefined}, {...item(2), comparisonText: '较昨日 暂无昨日数据'},
    {...item(3), heat: null, comparisonText: '↑Infinity%'}, {...item(4), heat: -1, comparisonText: '↓101%'},
    {...item(5), heat: Infinity, comparisonText: '由0增至42'}, {...item(6), heat: 0, comparisonText: '持平'}];
  const message = words(build({highHeat: values}));
  assert.match(message, /较昨日 暂无对比/);
  assert.match(message, /较昨日 暂无昨日数据/);
  assert.match(message, /热度 待核实/);
  assert.match(message, /较昨日 由0增至42/);
  assert.match(message, /热度 0 \| 较昨日 持平/);
  assert.doesNotMatch(message, /Infinity|↓101%|较昨日 较昨日|热度 null|热度 -1/);
});

test('overflow stays within the final serialized app request budget with both sections represented', () => {
  const records = Array.from({length: 600}, (_, i) => ({...item(i), title: `长标题${'舆情😀'.repeat(50)}${i}`, url: `https://example.com/posts/${i}?q=${'x'.repeat(700)}`}));
  const post = build({highHeat: records, coldMarked: records});
  assert.ok(feishuDailyPostRequestBytes(post) <= FEISHU_DAILY_POST_MAX_BYTES);
  const firstCold = post.zh_cn.content.findIndex(row => row.some(node => node.text === '三、冷处理负面帖链接'));
  const heatDisplayed = post.zh_cn.content.slice(0, firstCold).flat().filter(node => node.tag === 'a').length;
  const coldDisplayed = post.zh_cn.content.slice(firstCold, -1).flat().filter(node => node.tag === 'a').length;
  assert.ok(heatDisplayed > 0 && heatDisplayed < records.length);
  assert.ok(coldDisplayed > 0 && coldDisplayed < records.length);
  assert.match(words(post), new RegExp(`另有 ${records.length - heatDisplayed} 条高热负面帖子`));
  assert.match(words(post), new RegExp(`另有 ${records.length - coldDisplayed} 条冷处理负面帖子`));
  assert.equal(links(post).at(-1).href, documentUrl);
});

test('large high-heat section cannot exclude a short cold section', () => {
  const post = build({highHeat: Array.from({length: 400}, (_, i) => ({...item(i), title: '标题'.repeat(100)})), coldMarked: [item('cold-one'), item('cold-two')]});
  assert.ok(links(post).some(link => link.href.endsWith('/cold-one')));
  assert.ok(links(post).some(link => link.href.endsWith('/cold-two')));
  assert.doesNotMatch(words(post), /另有 \d+ 条冷处理/);
});

test('preflight reserves the maximum image key without substituting a text table', () => {
  const post = buildFeishuDailyPost({snapshot: snapshot({}), documentUrl});
  assert.equal(FEISHU_DAILY_POST_IMAGE_PLACEHOLDER.length, 256);
  assert.deepEqual(post.zh_cn.content[0], [{tag: 'img', image_key: FEISHU_DAILY_POST_IMAGE_PLACEHOLDER}]);
  assert.throws(() => buildFeishuDailyPost({snapshot: snapshot({}), documentUrl, imageKey: '<img>'}), /图片标识/);
  assert.throws(() => buildFeishuDailyPost({snapshot: snapshot({}), documentUrl: 'https://user:password@example.com/doc', imageKey}), /文档链接/);
});

test('builder keeps immutable source arrays intact and only reflects explicit tenant test naming', () => {
  const source = snapshot({tenantName: '安吉星【测试】', highHeat: Array.from({length: 300}, (_, i) => item(i))});
  const before = JSON.stringify(source);
  const post = buildFeishuDailyPost({snapshot: source, documentUrl, imageKey});
  assert.equal(JSON.stringify(source), before);
  assert.match(post.zh_cn.title, /【测试】/);
});
