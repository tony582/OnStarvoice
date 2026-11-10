import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ARTICLE_LINK, articleBodyRows, articleSortTarget, footerEvidence, isArticleResults, metric,
  parseArticleCards, parseArticleHeader, parseArticleMetrics, cardMatchesHeader, findTab, hasArticleTabs, resultsTop} from '../src/device/wechat-article-parse.mjs';
import {mergeArticleComments, parseArticleComments} from '../src/device/wechat-article-comments.mjs';
const rows = name => JSON.parse(readFileSync(new URL(`./fixtures/wechat-articles/${name}.json`, import.meta.url)));
const row = (text, x, y, w = 500, h = 45) => ({text, x, y, w, h, conf: 1});
const t9 = name => rows('t9-claude-phone-20261109')[name].rows;
const t13 = name => rows('t13-claude-phone-20261110')[name].rows;
const t13Comments = number => rows('t13-comment-footer-20261110')[`t12-renew-d/${number}`].rows;
const t14Comments = number => rows('t14-comment-quality-20261110')[`t13-hidden-read-b/${number}`].rows;

test('T14 real advertisement variants exclude the brand baseline and every ad line across consecutive frames', () => {
  let merged = [];
  for (const number of ['021', '022', '023']) {
    const parsed = parseArticleComments(t14Comments(number), {reachedEnd: true});
    assert.equal(parsed.comments.find(item => item.author === '欲.').content, '收费也能理解，毕竟人家提供了服务嘛');
    merged = mergeArticleComments(merged, parsed.comments);
  }
  assert.equal(merged.find(item => item.author === '欲.').content, '收费也能理解，毕竟人家提供了服务嘛');
  for (const marker of ['厂告～', '厂告♥', '广告～']) {
    const parsed = parseArticleComments([row('留言2', 55, 400), row('甲 上海 11月9日', 163, 600),
      row('我在全友全屋定制看到广告，这也是留言正文', 163, 680), row('任意品牌', 159, 793, 231, 39),
      row(marker, 921, 800, 98, 33), row('这段是广告文案', 163, 850), row('了解更多', 163, 990),
      row('乙 江苏 11月9日', 163, 1100), row('广告后的下一条正常留言', 163, 1180)]);
    assert.deepEqual(parsed.comments.map(item => item.content), ['我在全友全屋定制看到广告，这也是留言正文', '广告后的下一条正常留言']);
  }
  const ordinary = parseArticleComments([row('留言1', 55, 400), row('甲 上海 11月9日', 163, 600),
    row('厂告～', 163, 680), row('我在全友全屋定制看到广告', 163, 750)]);
  assert.ok(ordinary.comments[0].content.includes('全友全屋定制'), 'a brand name or left-side text alone is not an ad boundary');
});

test('T14 uncertain single-symbol authors retain their comments and only mark uncertainty when present', () => {
  for (const author of ['↓', '～', '※', '总']) {
    const parsed = parseArticleComments([row('留言1', 55, 400), row(`${author} 安徽 2023年9月14日`, 163, 600), row('这个我觉得蛮正常', 163, 680)]);
    assert.equal(parsed.comments.length, 1);
    assert.equal(parsed.comments[0].author, ''); assert.equal(parsed.comments[0].authorUncertain, true);
    assert.equal(parsed.comments[0].content, '这个我觉得蛮正常'); assert.equal(parsed.comments[0].likeCount, null);
  }
  for (const author of ['M.', '欲.', '王', '总经理']) {
    const item = parseArticleComments([row('留言1', 55, 400), row(`${author} 安徽 2023年9月14日`, 163, 600), row('有效作者的留言', 163, 680)]).comments[0];
    assert.equal(item.author, author); assert.equal(Object.hasOwn(item, 'authorUncertain'), false);
  }
});

test('T14 cross-author merging needs valid equal region and date and chooses the better observed name', () => {
  const one = {author: '杨瑞们', location: '安徽', timeLabel: '2023年9月14日', content: '这个通用没毛病，安吉星服务员里面也写的很清楚。我的雪佛兰就是。', reply: false, cut: false};
  assert.equal(mergeArticleComments([one], [{...one, author: '杨瑞物'}]).length, 1);
  const better = mergeArticleComments([{...one, author: '杨瑞', content: one.content + '长尾', cut: true}], [one]);
  assert.equal(better.length, 1); assert.equal(better[0].author, one.author); assert.equal(better[0].content, one.content);
  for (const change of [{location: '上海'}, {timeLabel: '2023年9月15日'}, {location: null}, {timeLabel: ''}]) {
    assert.equal(mergeArticleComments([one], [{...one, author: '另一个人', ...change}]).length, 2);
  }
  for (const context of [{location: null}, {location: '未知'}, {timeLabel: '未显示'}, {timeLabel: '2023年13月14日'}, {timeLabel: '2023年2月30日'}]) {
    assert.equal(mergeArticleComments([{...one, ...context}], [{...one, ...context, author: '另一个人'}]).length, 2);
  }
  const short = {...one, content: '确实这样'};
  for (const author of [short.author, '另一个人', '']) {
    const item = {...short, author, ...(author ? {} : {authorUncertain: true})};
    assert.equal(mergeArticleComments([item], [{...item, location: '江苏'}]).length, 2);
    assert.equal(mergeArticleComments([item], [{...item, timeLabel: '2023年9月15日'}]).length, 2);
  }
});

test('T14 same-known-author hidden or foreign IP retains old overlap merging without using empty authors as proof', () => {
  const one = {author: 'Alice 加拿大', location: null, timeLabel: '11月9日', content: '这是一条地区不显示的完整留言', reply: false, cut: true};
  assert.equal(mergeArticleComments([one], [{...one, cut: false}]).length, 1);
  assert.equal(mergeArticleComments([one], [{...one, location: '安徽', cut: false}]).length, 1);
  const uncertain = {...one, author: '', authorUncertain: true};
  assert.equal(mergeArticleComments([uncertain], [uncertain]).length, 2);
  const explicitlyUncertain = mergeArticleComments([], [{...one, author: '错误读名', authorUncertain: true}])[0];
  assert.equal(explicitlyUncertain.author, ''); assert.equal(explicitlyUncertain.authorUncertain, true);
  const similar = {...uncertain, location: '安徽', content: '这是另一条地区不显示的完整留言'};
  assert.equal(mergeArticleComments([{...uncertain, location: '安徽'}], [similar]).length, 2, 'uncertain authors cannot use the looser same-name threshold');
});

test('T14 a better author survives later uncertain frames while content completion and reply parent indices are preserved', () => {
  const parent = {author: '', authorUncertain: true, location: '安徽', timeLabel: '2023年9月14日', content: '这个我觉得蛮正常', reply: false, cut: true};
  const known = {...parent, author: '真实读者', cut: false}; delete known.authorUncertain;
  const reply = {...known, content: '这是一条回复', reply: true};
  const merged = mergeArticleComments([], [parent, reply]);
  assert.equal(merged[1].parentIndex, 0);
  const completed = mergeArticleComments(merged, [known, {...parent, cut: false}]);
  assert.equal(completed.length, 2); assert.equal(completed[0].author, '真实读者');
  assert.equal(Object.hasOwn(completed[0], 'authorUncertain'), false); assert.equal(completed[0].cut, false);
  assert.equal(completed[1].reply, true); assert.equal(completed[1].parentIndex, 0);
  assert.equal(mergeArticleComments([], [parent, {...parent, author: '另一条', content: '内容不同'}], 1).length, 1);
});

test('T14 identical replies under different parents stay separate and a repeated parent restores its reply context', () => {
  const first = {author: '父甲', location: '安徽', timeLabel: '11月9日', content: '汽车套餐需要怎样续费', reply: false, cut: false};
  const second = {...first, author: '父乙', content: '远程控制到期之后怎么办'};
  const reply = {...first, author: '↓', content: '收到', reply: true};
  const initial = mergeArticleComments([], [first, reply, second, {...reply, author: '※'}]);
  assert.equal(initial.length, 4);
  assert.deepEqual(initial.filter(item => item.reply).map(item => item.parentIndex), [0, 2]);
  const repeated = mergeArticleComments(initial, [first, {...reply, author: '～'}]);
  assert.equal(repeated.length, 4); assert.deepEqual(repeated.filter(item => item.reply).map(item => item.parentIndex), [0, 2]);
  const newReply = mergeArticleComments(initial, [first, {...reply, author: '真实读者', content: '我也想知道续费方法'}]);
  assert.equal(newReply.length, 5); assert.equal(newReply.at(-1).parentIndex, 0);
  const limited = mergeArticleComments(initial.slice(0, 2), [second, {...reply, author: '父乙的新读者'}], 2);
  assert.equal(limited[1].author, '', 'an unrecorded parent at the limit cannot authorize changing another parent\'s reply');
});

test('T13 merged 阅读原文 and read count require the paired footer control and preserve rounded precision', () => {
  const source = t13Comments(130), read = footerEvidence(source).read;
  assert.equal(read.text, '阅读原文 阅读3.6万');
  assert.deepEqual(parseArticleMetrics(source).read, {raw: '3.6万', value: 36000, precision: 'rounded'});
  assert.deepEqual(parseArticleMetrics([row(' 阅读原文 阅读3.6万 ', 55, 700), row('不喜欢', 855, 700)]).read,
    {raw: '3.6万', value: 36000, precision: 'rounded'});
  for (const sample of [source.filter(item => !item.text.includes('不喜欢')),
    [row('阅读原文 阅读3.6万', 55, 700), row('不喜欢', 855, 900)],
    [row('阅读原文 阅读3.6万', 200, 700), row('不喜欢', 855, 700)],
    [row('阅读原文的阅读3.6万案例', 55, 700), row('不喜欢', 855, 700)],
    [row('阅读原文 阅读3.6万，欢迎留言', 55, 700), row('不喜欢', 855, 700)],
    [row('阅读3.6万的案例', 55, 700), row('不喜欢', 855, 700)]]) {
    assert.equal(footerEvidence(sample).read, undefined);
    assert.deepEqual(parseArticleMetrics(sample).read, {raw: null, value: null, precision: 'unknown'});
  }
});

test('T13 real header-only screens preserve comment count 13 and never invent a read count', () => {
  for (const number of [131, 132]) {
    const source = t13Comments(number), footer = footerEvidence(source);
    assert.equal(footer.read, undefined); assert.equal(footer.bodyEndY, footer.header.y);
    assert.equal(parseArticleComments(source).headerCount, 13);
    assert.deepEqual(parseArticleMetrics(source).read, {raw: null, value: null, precision: 'unknown'});
    assert.ok(articleBodyRows(source).every(item => item.y + item.h < footer.header.y));
  }
});

test('T13 missing authors delimit preceding comments without inventing names or losing later valid comments', () => {
  const source = [row('留言13', 55, 400), row('甲 上海 11月9日', 163, 600), row('第一条已知留言', 163, 680),
    row('安徽 2023年9月14日', 208, 850), row('回复', 813, 850, 80), row('缺名字的下一条', 163, 920),
    row('乙 江苏 11月9日', 163, 1100), row('后面的有效留言', 163, 1180)];
  const parsed = parseArticleComments(source);
  assert.equal(parsed.unparsed, true);
  assert.deepEqual(parsed.comments.map(item => [item.author, item.content]), [['甲', '第一条已知留言'], ['乙', '后面的有效留言']]);
  assert.equal(parsed.comments[0].cut, true); assert.equal(parsed.headerCount, 13);
  const invalid = source.map(item => item.y === 850 && item.x === 208 ? {...item, text: `${'长'.repeat(61)} 安徽 2023年9月14日`} : item);
  assert.deepEqual(parseArticleComments(invalid).comments.map(item => item.content), ['第一条已知留言', '后面的有效留言']);
});

test('T13 small right-side advertisement markers delimit only the preceding comment', () => {
  for (const marker of ['广告', '广告♥', '广告<']) {
    const source = [row('留言2', 55, 400), row('甲 上海 11月9日', 163, 600), row('正常正文提到京东和广告应保留', 163, 680),
      row('京东', 163, 797), row(marker, 921, 800, 98, 33), row('新人优惠广告文案', 163, 880),
      row('乙 江苏 11月9日', 163, 1100), row('后面的有效留言', 163, 1180)];
    const parsed = parseArticleComments(source);
    assert.deepEqual(parsed.comments.map(item => item.content), ['正常正文提到京东和广告应保留', '后面的有效留言']);
  }
  for (const marker of [row('广告', 163, 800), row('广告文案', 921, 800, 98, 33), row('广告', 921, 800, 98, 80)]) {
    const parsed = parseArticleComments([row('留言1', 55, 400), row('甲 上海 11月9日', 163, 600), marker,
      row('后面的正常内容', 163, 880)]);
    assert.ok(parsed.comments[0].content.includes('后面的正常内容'), 'ordinary text or an unverified marker is not a boundary');
  }
});

test('T13 original comment screens no longer join anonymous comments or advertisements into known authors', () => {
  const second = parseArticleComments(t13Comments(132), {reachedEnd: true});
  assert.ok(second.comments[0].content.includes('使用方向盘'));
  assert.ok(!second.comments[0].content.includes('这个还真的要交钱'));
  assert.equal(second.unparsed, true);
  for (const number of [133, 134, 135]) {
    const parsed = parseArticleComments(t13Comments(number), {reachedEnd: true});
    const item = parsed.comments.find(comment => comment.author === '欲.');
    assert.equal(item.content, '收费也能理解，毕竟人家提供了服务嘛');
    assert.equal(parsed.unparsed, true);
    if (number === 133) assert.ok(!parsed.comments[0].content.includes('这个通用没毛病'));
    if (number === 135) assert.equal(parsed.comments.find(comment => comment.author === 'M.').content, '如果要用，这个钱还真的要交@');
  }
});

test('T13 real shifted tabs need the keyword, article tab and two distinct known neighbours', () => {
  const source = t13('t12-renew-b/049');
  assert.equal(findTab(source, 'AI搜索'), null);
  assert.equal(isArticleResults(source, '安吉星 续费', {scrolledOk: true}), true);
  assert.equal(isArticleResults(source, '安吉星 续费'), false);
  assert.equal(isArticleResults(source, '不同关键词', {scrolledOk: true}), false);
  const controls = source.filter(item => item.y < 240);
  const article = row('文章', 480, 287, 90);
  assert.equal(isArticleResults([...controls, article, row('视频', 640, 287, 90)], '安吉星 续费', {scrolledOk: true}), false);
  assert.equal(isArticleResults([...controls, article, row('视频 视频', 640, 287, 180)], '安吉星 续费', {scrolledOk: true}), false);
  assert.equal(isArticleResults([...controls, article, row('视频 评论', 640, 287, 240)], '安吉星 续费', {scrolledOk: true}), true);
  assert.equal(isArticleResults([...controls, row('视频 评论', 640, 287, 240)], '安吉星 续费', {scrolledOk: true}), false);
});

test('T13 followers-only empty prompt is zero while genuine comments and missing entries remain distinct', () => {
  const parsed = parseArticleComments(t13('t12-week/128'));
  assert.equal(parsed.empty, true); assert.equal(parsed.headerCount, 0); assert.equal(parsed.postingState, 'followers_only');
  const quote = [row('留言', 55, 700, 90), row('作者已设置关注后可以留言', 75, 850), row('读者 上海 11月9日', 163, 1000), row('还没有留言', 446, 1100, 190)];
  const comment = parseArticleComments(quote);
  assert.equal(comment.empty, false); assert.equal(comment.headerCount, null); assert.equal(comment.comments[0].content, '还没有留言');
  assert.equal(parseArticleComments([row('还没有留言', 446, 1100, 190)], {reachedEnd: true}).empty, false);
});

test('Claude phone results match a clipped title and a complete account token in the article byline', () => {
  const cards = parseArticleCards(t9('s1-renew/070'));
  const longHeader = parseArticleHeader(t9('s1-renew/072'));
  const bylineHeader = parseArticleHeader(t9('s1-renew/076'));
  assert.equal(longHeader.headerVerified, true); assert.equal(bylineHeader.headerVerified, true);
  assert.equal(cards[2].title, '务，统统一键解决！');
  assert.equal(cardMatchesHeader(cards[2], longHeader), true);
  assert.equal(cardMatchesHeader(cards[3], bylineHeader), true);
  assert.equal(cardMatchesHeader({...cards[3], account: bylineHeader.account}, {...bylineHeader, account: '连确'}), true);
  for (const account of ['连确汽车', '连确俱乐部', '另一个公众号']) {
    assert.equal(cardMatchesHeader(cards[3], {...bylineHeader, account}), false);
  }
  assert.equal(cardMatchesHeader({...cards[3], account: '安吉星'}, {...bylineHeader, account: '安吉星服务'}), false);
  assert.equal(cardMatchesHeader({...cards[2], title: '统统一键解'}, longHeader), false, 'five characters are insufficient');
  assert.equal(cardMatchesHeader({...cards[2], title: '统一键解！！！'}, longHeader), false, 'punctuation does not reach the six-character threshold');
  assert.equal(cardMatchesHeader({...cards[2], account: '另一个公众号'}, longHeader), false);
  assert.equal(cardMatchesHeader({...cards[3], title: '一篇完全无关的文章'}, bylineHeader), false);
});

test('Claude scrolled results retain the first complete card only after explicit context verification', () => {
  const source = t9('s1-renew/080');
  assert.equal(isArticleResults(source, '安吉星 续费'), false);
  assert.equal(isArticleResults(source, '安吉星 续费', {scrolledOk: true}), true);
  assert.equal(isArticleResults(source, '另一个词', {scrolledOk: true}), false);
  assert.equal(resultsTop(source), 360);
  const cards = parseArticleCards(source, {top: resultsTop(source)});
  assert.equal(cards.length, 4);
  assert.equal(cards[0].title, '安吉星手机应用再次升级，修车保养、续费服务，统统一键解决！');
  assert.equal(resultsTop(t9('s1-renew/070')), 520);
});

test('only complete known tab labels can be split, with an integer tap inside 文章', () => {
  const source = t9('s1-renew-c/006');
  const target = findTab(source, '文章');
  assert.equal(target.center.x, 543); assert.equal(target.center.y, 308);
  assert.ok(target.center.x >= 478 && target.center.x < 608);
  for (const text of ['热门文章', '文章 交流群', 'AI搜索 异常提示', '文章视频未知']) {
    assert.equal(findTab([row(text, 100, 280)], '文章'), null);
    assert.equal(hasArticleTabs([row(text, 100, 280)]), false);
  }
  assert.equal(hasArticleTabs(t9('s2-week/006')), false);
  assert.equal(hasArticleTabs(t9('s2-week/007')), true, '007 has the 视频 anchor inside a merged known-label box');
  assert.equal(hasArticleTabs([row('账号 评论', 200, 280)]), false);
  assert.equal(hasArticleTabs([row('全部 视频 AI搜索', 100, 700)]), false, 'body text is not a tab row');
});

test('Claude empty-comment screen keeps unknown metrics null even when OCR drops or reorders labels', () => {
  const source = t9('s1-renew/069');
  for (const page of [source, [...source].reverse(), source.filter(item => item.text !== '推荐')]) {
    const metrics = parseArticleMetrics(page);
    assert.equal(metrics.read.value, 148); assert.equal(metrics.like.value, null); assert.equal(metrics.share.value, 5);
    assert.deepEqual(metrics.recommend, {raw: null, value: null});
  }
  for (const label of ['写留言', '推荐', '赞']) assert.deepEqual(metric(label), {raw: null, value: null});
  const parsed = parseArticleComments(source);
  assert.equal(parsed.empty, true); assert.equal(parsed.headerCount, 0); assert.equal(parsed.postingState, 'open');
  const phrase = '还没有留言，来写首评';
  assert.equal(parseArticleComments([row(phrase, 351, 700, 381, 49)]).empty, false, 'body text cannot claim empty comments');
  assert.equal(parseArticleComments([row(phrase, 351, 900, 381, 49)], {reachedEnd: true}).empty, false,
    'historical footer evidence cannot turn a comment fragment into a zero count');
  const quoted = parseArticleComments([row('留言', 52, 1000), row('测试者 上海 11月9日', 156, 1200), row(phrase, 156, 1300)]);
  assert.equal(quoted.empty, false); assert.equal(quoted.headerCount, null); assert.equal(quoted.comments[0].content, phrase);
});

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

test('Claude T12 real publication metadata accepts the trailing audio and AI controls only as a suffix', () => {
  const source = rows('t12-claude-header-012').rows;
  const header = parseArticleHeader(source);
  assert.equal(header.headerVerified, true);
  assert.equal(header.title, '2.2亿美元和解之后，你急刹数据归谁');
  assert.equal(header.account, '汽车前瞻资讯');
  assert.equal(header.publishedAt, '2026-11-08T23:59:00+08:00');
  assert.equal(header.timePrecision, 'minute'); assert.equal(header.location, '上海');
  for (const tail of ['上海 60 听全文 Al摘要', '上海 60 听全文 A1总结', '上海 AI摘要', '上海 听全文']) {
    const variant = source.map(item => item.y === 557 ? {...item, text: `2026年11月8日 23:59 ${tail}`} : item);
    assert.equal(parseArticleHeader(variant).headerVerified, true, tail);
  }
  for (const tail of ['上海 60 听全文 AI摘要 后面还有正文', '报道称发生了事故 AI摘要', '上海601人']) {
    const variant = source.map(item => item.y === 557 ? {...item, text: `2026年11月8日 23:59 ${tail}`} : item);
    assert.equal(parseArticleHeader(variant).headerVerified, false, tail);
  }
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

test('a left-aligned bare 留言 heading establishes the end without a numeric comment count', () => {
  const source = [row('这是正常正文', 55, 300), row('留言', 55, 600), row('后面还有正常内容', 55, 800)];
  assert.equal(footerEvidence(source).bodyEndY, 600);
  assert.deepEqual(articleBodyRows(source).map(item => item.text), ['这是正常正文']);
  assert.equal(parseArticleComments(source).headerCount, null);
  assert.equal(parseArticleComments(source).empty, false);
});

test('sentences mentioning 留言 and text outside the footer heading region remain body text', () => {
  for (const item of [row('正文中提到留言13条', 55, 600), row('「留言」', 55, 600), row('留言区讨论', 55, 600),
    row('留言13', 130, 600), row('留言', 55, 240), row('留言13', 55, 2050)]) {
    const source = [row('这是正常正文', 55, 300), item, row('后面还有正常内容', 55, 800)];
    assert.equal(footerEvidence(source).bodyEndY, null);
    assert.ok(articleBodyRows(source).some(value => value.text === '后面还有正常内容'));
  }
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
