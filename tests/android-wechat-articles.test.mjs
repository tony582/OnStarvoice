import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalArticleUrl, articleExternalId, articlePublishTime, normalizeArticleEvent} from '../server/services/android-control/articles.js';
import {normalizePostEvent, wechatSyncBody} from '../server/services/android-control/posts.js';
import {mergeArticleRecord} from '../server/services/android-control/article-record.js';
import {readyPlatforms, runnerFeatures, taskPayload} from '../server/services/android-control/leases.js';
import {mobileTaskFilters, mobilePlanBlockReason, mobileWorkflowFor} from '../server/services/android-control/mobile-tasks.js';
import {normalizeOrchestrationRequest} from '../server/services/capture-orchestration.js';
import {normalizeRemoteTaskInput} from '../server/services/capture-cloud.js';
import {normalizeRecord} from '../server/routes/sync.js';
import {resolveRecordMetrics} from '../server/utils/metrics.js';
import {unattendedNegativePatrolTargetUrl} from '../server/services/unattended-negative-patrol.js';

const agentId = randomUUID(), taskId = randomUUID();
const principal = {agentId};
const identity = {eventId: randomUUID(), discoveryRunId: taskId, taskId, itemId: randomUUID(), attemptId: randomUUID(),
  agentId, requestHash: 'a'.repeat(64), assignmentRevision: 1};
const link = 'https://mp.weixin.qq.com/s/bMWKCZnPrhVlz2uCqmRzKw';
function event(extra = {}) {
  return {eventKind: 'wechat_article', ...identity, mode: 'keyword', capturedAt: '2026-11-09T08:00:00Z', rank: 1,
    link: {shareUrl: link}, card: {snippet: '列表只是摘要', author: '公众号'},
    article: {title: '文章标题', content: '完整正文，包含多个段落。', account: '公众号', author: '署名作者',
      publishedAt: '2026-11-08T23:59+08:00', timeLabel: '2026年11月8日23:59 上海', timePrecision: 'minute', location: '上海',
      bodyStatus: 'complete', bodyReason: '', source: 'screen_ocr', contentType: 'article',
      metrics: {read: {raw: '4.8万', value: 48000, precision: 'abbreviated_display_not_exact'},
        like: {raw: '8', value: 8}, share: {raw: '分享', value: null}, recommend: {raw: '0', value: 0}}},
    comments: {status: 'unavailable', headerCount: null, postingState: 'unknown', reason: 'no_visible_comment_entry', items: []}, ...extra};
}
function sync(input) {
  return wechatSyncBody(normalizePostEvent(input, principal), {keyword: '服务端关键词', taskId, attemptId: identity.attemptId, requestHash: identity.requestHash});
}

test('article identity uses the canonical short link, not author/time/keyword or tracking query', () => {
  assert.equal(canonicalArticleUrl(`${link}/?scene=21#wechat_redirect`), link);
  assert.equal(articleExternalId(`${link}?from=search`), articleExternalId(link));
  assert.match(articleExternalId(link), /^wxa_[a-f0-9]{24}$/u);
  const changed = event(); changed.article.account = '账号改名'; changed.article.publishedAt = '2026-11-07 12:30';
  assert.equal(sync(changed).externalId, sync(event()).externalId);
  for (const bad of ['http://mp.weixin.qq.com/s/abcdefgh', 'https://mp.weixin.qq.com.evil/s/abcdefgh',
    'https://u:p@mp.weixin.qq.com/s/abcdefgh', 'https://mp.weixin.qq.com:444/s/abcdefgh',
    'https://mp.weixin.qq.com/s?__biz=unverified', 'https://weixin.qq.com/sph/abcdefgh']) assert.equal(canonicalArticleUrl(bad), '');
});

test('article sync preserves independent account/author, minute precision, body status and unknown metrics', () => {
  const {body} = sync(event());
  const [record] = normalizeRecord(body), article = body.payload.wechatArticle;
  assert.equal(record.platform, 'wechat_articles');
  assert.equal(record.title, '文章标题');
  assert.equal(record.content, '完整正文，包含多个段落。');
  assert.equal(record.author_name, '公众号');
  assert.equal(article.author, '署名作者');
  assert.equal(record.publish_time, '2026-11-08 23:59');
  assert.equal(article.timePrecision, 'minute');
  assert.equal(article.metrics.read.precision, 'abbreviated_display_not_exact');
  assert.equal(record.likes, 8);
  assert.equal(record.collects, 0, 'explicit observed zero');
  assert.equal(record.shares, null);
  assert.equal(record.comments_count, null);
  assert.equal(record.comments_capture_status, 'unavailable');
  assert.equal(body.payload.detailCaptureStatus, 'done');
  assert.equal(record.keyword, '服务端关键词');
});

test('article comment states do not collapse disabled/closed/unavailable/unknown into zero', () => {
  for (const status of ['disabled', 'closed', 'unavailable', 'unknown']) {
    const input = event({comments: {status, headerCount: null, postingState: status === 'closed' ? 'closed' : 'unknown', items: []}});
    const [record] = normalizeRecord(sync(input).body);
    assert.equal(record.comments_capture_status, status);
    assert.equal(record.comments_count, null);
    assert.equal(JSON.parse(record.payload).detailCaptureStatus, 'done');
  }
  const empty = event({comments: {status: 'empty', headerCount: 0, postingState: 'open', items: []}});
  assert.equal(normalizeRecord(sync(empty).body)[0].comments_count, 0);
  empty.comments.headerCount = null;
  assert.throws(() => sync(empty), {code: 'INVALID_EMPTY_ARTICLE_COMMENTS'});
  assert.throws(() => sync(event({comments: {status: 'made_up', items: []}})), {code: 'INVALID_ARTICLE_COMMENT_STATUS'});
});

test('closed posting retains readable old comments and reply parent relationship', () => {
  const input = event({comments: {status: 'captured', headerCount: 2, postingState: 'closed', items: [
    {author: '读者', content: '还可以使用吗？', location: '上海', timeLabel: '昨天', likeCount: null, reply: false},
    {author: '公众号', content: '可以使用。', timeLabel: '今天', likeCount: 0, reply: true, parentIndex: 0},
  ]}});
  const {body} = sync(input), comments = body.payload.commentsCleanedItems;
  assert.equal(body.payload.wechatArticle.comments.postingState, 'closed');
  assert.equal(comments[0].likes, null);
  assert.equal(comments[1].parentCommentId, comments[0].commentId);
  assert.equal(comments[1].likes, 0);
});

test('article date validation preserves calendar precision without making up seconds', () => {
  const at = Date.parse('2026-11-09T08:00:00Z');
  assert.equal(articlePublishTime('2026-11-08', 'date', at), '2026-11-08');
  assert.equal(articlePublishTime('', 'unknown', at), '');
  for (const [date, precision] of [['2026-02-31', 'date'], ['2026-11-08', 'minute'],
    ['2026-11-08 25:00', 'minute'], ['2026-11-10 12:00', 'minute'], ['2026-11-08 12:31:12', 'minute']]) {
    assert.throws(() => articlePublishTime(date, precision, at), {code: 'INVALID_ARTICLE_PUBLISH_TIME'});
  }
});

test('article payload bounds refuse oversized content and retain ordered text/image blocks without claiming original files', () => {
  const input = event();
  input.article.content = '字'.repeat(100_001);
  assert.throws(() => sync(input), {code: 'ARTICLE_CONTENT_TOO_LARGE'});
  input.article.content = '文字';
  input.article.images = [{url: 'https://mmbiz.qpic.cn/image.png', stored: true, ocrText: '图片内文字'}];
  input.article.bodyBlocks = [{type: 'text', text: '文字'}, {type: 'image', imageIndex: 0}];
  const {body} = sync(input), article = body.payload.wechatArticle;
  assert.deepEqual(article.bodyBlocks.map(b => b.type), ['text', 'image']);
  assert.equal(article.bodyBlocks[1].imageIndex, 0);
  assert.equal(article.images[0].stored, false);
  input.article.content = '';
  assert.throws(() => sync(input), {code: 'EMPTY_COMPLETE_ARTICLE'});
});

test('partial recapture preserves complete body and known metrics while exposing this visit as partial and unknown', () => {
  const initial = event(); initial.article.evidence = {screens: 3, bodyEndObserved: true, overlapVerified: true};
  const first = normalizeRecord(sync(initial).body)[0];
  const input = event(); input.article.evidence = {screens: 1, bodyEndObserved: false, overlapVerified: false};
  input.article.title = '本次 OCR 局部标题'; input.article.account = '误读账号'; input.article.content = '完整正文'; input.article.bodyStatus = 'partial'; input.article.bodyReason = 'screen_limit';
  input.article.metrics.like = {raw: '', value: null}; input.article.metrics.read = {raw: '', value: null};
  const merged = mergeArticleRecord(normalizeRecord(sync(input).body)[0], first), payload = JSON.parse(merged.payload);
  assert.equal(merged.content, first.content);
  assert.equal(merged.likes, null, 'incremental column update preserves previous, rather than making 0');
  assert.equal(payload.wechatArticle.bodyStatus, 'complete');
  assert.equal(payload.wechatArticle.metrics.like.value, 8);
  assert.equal(payload.wechatArticle.metrics.read.value, 48000);
  assert.equal(payload.wechatArticle.latestCapture.bodyStatus, 'partial');
  assert.equal(payload.wechatArticle.evidence.bodyEndObserved, true);
  assert.equal(payload.wechatArticle.latestCapture.evidence.bodyEndObserved, false);
  assert.equal(payload.wechatArticle.title, initial.article.title);
  assert.equal(merged.author_name, initial.article.account);
  assert.equal(payload.wechatArticle.latestCapture.metrics.like.value, null);
});

test('record presentation preserves article unknown null; existing platform behavior remains unchanged', () => {
  const {body} = sync(event());
  assert.deepEqual(resolveRecordMetrics({platform: 'wechat_articles', payload: body.payload, likes: 8, collects: 0, shares: null,
    comments_count: null}), {likes: 8, collects: 0, shares: null, comments_count: null});
  assert.deepEqual(resolveRecordMetrics({platform: 'douyin'}), {likes: 0, collects: 0, shares: 0, comments_count: 0});
});

test('article plans and actual ready platforms require explicit article capability; unsupported filters are rejected', () => {
  const agent = {allowed_platforms: ['douyin', 'wechat_channels', 'wechat_articles']};
  assert.deepEqual(readyPlatforms({platforms: ['wechat_articles']}, agent, true), []);
  assert.deepEqual(readyPlatforms({platforms: ['wechat_articles'], features: ['wechat_articles']}, agent, true), ['wechat_articles']);
  assert.deepEqual(runnerFeatures({features: ['wechat_articles']}), ['wechat_articles']);
  assert.equal(mobileWorkflowFor('wechat_articles'), 'wechat_articles_mobile_capture');
  assert.deepEqual(mobileTaskFilters({sort: 'likes', publishTime: 'all'}, 'wechat_articles'), {sort: 'hot', publishWindowHours: null});
  assert.deepEqual(mobileTaskFilters({sort: 'comprehensive', publishTime: 'month'}, 'wechat_articles'), {sort: 'latest', publishWindowHours: 720});
  for (const sort of ['comprehensive', 'latest', 'likes']) {
    for (const publishTime of ['all', 'day', 'week', 'month', 'halfyear']) {
      const filters = {sort, publishTime};
      assert.deepEqual(mobileTaskFilters(filters, 'wechat_articles'), mobileTaskFilters(filters, 'wechat_channels'),
        'article and Channels use the same sort/window contract');
    }
  }
  assert.deepEqual(mobileTaskFilters({sort: 'likes', publishTime: 'all', videoDuration: 'under_5m', searchScope: 'followed'}, 'wechat_articles'),
    {sort: 'hot', publishWindowHours: null}, 'Channels-only filter fields never leak into an article task');
  for (const filters of [{searchScope: 'followed'}, {searchScope: 'unknown'}, {videoDuration: 'under_5m'}, {sort: 'comments'}]) {
    assert.match(mobilePlanBlockReason({searchFilters: filters}, 'wechat_articles'), /^article_/);
    assert.throws(() => normalizeOrchestrationRequest({platform: 'wechat_articles', keywords: ['安吉星'], searchFilters: filters}));
    assert.throws(() => normalizeRemoteTaskInput({platform: 'wechat_articles', keywords: ['安吉星'], searchFilters: filters}));
  }
  assert.throws(() => normalizeOrchestrationRequest({platform: 'wechat_articles', keywords: ['安吉星'], searchScope: 'followed'}));
  const plan = normalizeOrchestrationRequest({platform: 'wechat_articles', keywords: ['安吉星']});
  assert.equal(plan.platform, 'wechat_articles');
  const item = {execution_task_id: taskId, id: identity.itemId, assignment_revision: 1, request_hash: identity.requestHash,
    assigned_agent_id: agentId, keyword: '安吉星', metadata: {attemptId: identity.attemptId}};
  const payload = taskPayload(item, {workflow: 'wechat_articles_mobile_capture', comments: {enabled: true, limit: 20}});
  assert.equal(payload.platform, 'wechat_articles');
  assert.deepEqual(payload.comments, {enabled: true, limit: 20});
});

test('article patrol uses the stored article URL and cannot mistake another platform for an article', () => {
  assert.equal(unattendedNegativePatrolTargetUrl({platform: 'wechat_articles', external_id: articleExternalId(link), url: link}), link);
  assert.equal(unattendedNegativePatrolTargetUrl({platform: 'wechat_articles', external_id: 'wxa_wrong', url: 'https://example.com/a'}), '');
});

test('page DOM body, phone comments and each metric retain separate sources and observation times', () => {
  const input = event();
  Object.assign(input.article, {source: 'page_dom', capturedAt: '2026-11-09T07:58:00Z', timeSource: 'page_dom',
    evidence: {domContentObserved: true, domReadyState: 'complete', imageUrlsObserved: 2, commentScreens: 3, originalImagesCaptured: true},
    images: [{url: 'https://mmbiz.qpic.cn/example/first.png', alt: '第一张图', order: 0, source: 'page_dom', stored: true},
      {url: 'https://mmbiz.qpic.cn/example/second.png', alt: '第二张图', order: 1, source: 'page_dom', stored: true}],
    bodyBlocks: [{type: 'text', text: '第一段'}, {type: 'image', url: 'https://mmbiz.qpic.cn/example/first.png', alt: '第一张图'},
      {type: 'text', text: '第二段'}, {type: 'image', url: 'https://mmbiz.qpic.cn/example/second.png', alt: '第二张图'}]});
  input.article.metrics.like = {raw: '9', value: 9, source: 'screen_ocr', capturedAt: '2026-11-09T07:59:00Z'};
  input.article.metrics.read = {raw: '', value: null, source: 'page_dom', capturedAt: '2026-11-09T07:58:00Z'};
  Object.assign(input.comments, {source: 'screen_ocr', capturedAt: '2026-11-09T07:59:30Z'});
  const {body} = sync(input), article = body.payload.wechatArticle;
  assert.equal(article.source, 'page_dom');
  assert.equal(article.capturedAt, '2026-11-09T07:58:00.000Z');
  assert.equal(article.timeSource, 'page_dom');
  assert.equal(article.evidence.domContentObserved, true);
  assert.equal(article.evidence.imageUrlsObserved, 2);
  assert.equal(article.evidence.commentScreens, 3);
  assert.equal(article.evidence.originalImagesCaptured, false);
  assert.equal(article.metrics.like.source, 'screen_ocr');
  assert.equal(article.metrics.like.capturedAt, '2026-11-09T07:59:00.000Z');
  assert.equal(article.metrics.read.value, null);
  assert.equal(article.metrics.read.source, 'page_dom');
  assert.equal(article.comments.source, 'screen_ocr');
  assert.equal(article.comments.capturedAt, '2026-11-09T07:59:30.000Z');
  assert.deepEqual(body.payload.imageUrls, input.article.images.map(image => image.url));
  assert.deepEqual(article.bodyBlocks.map(block => block.type), ['text', 'image', 'text', 'image']);
  assert.deepEqual(article.bodyBlocks.filter(block => block.type === 'image').map(block => block.imageIndex), [0, 1]);
  assert.ok(article.images.every(image => image.source === 'page_dom' && !image.stored && image.downloadEligible),
    'the authorized CDN is download eligible, but a URL alone never proves a local file');
  input.comments.source = 'page_dom';
  assert.throws(() => sync(input), {code: 'INVALID_ARTICLE_COMMENT_SOURCE'});
  input.comments.source = 'screen_ocr';
  input.article.metrics.like.source = 'made_up';
  assert.throws(() => sync(input), {code: 'INVALID_ARTICLE_EVIDENCE_SOURCE'});
  input.article.metrics.like.source = 'screen_ocr';
  input.article.capturedAt = '2027-01-01T00:00:00Z';
  assert.throws(() => sync(input), {code: 'INVALID_ARTICLE_OBSERVED_AT'});
});

test('a complete DOM body including image-only content survives later OCR; the new observation remains inspectable', () => {
  const input = event();
  Object.assign(input.article, {source: 'page_dom', capturedAt: '2026-11-09T07:58:00Z', content: '',
    images: [{url: 'https://mmbiz.qpic.cn/example/page.png', alt: '长图', source: 'page_dom'}],
    bodyBlocks: [{type: 'image', url: 'https://mmbiz.qpic.cn/example/page.png', alt: '长图'}]});
  const first = normalizeRecord(sync(input).body)[0];
  const ocr = event(); ocr.article.content = '图片中只看见一小段'; ocr.article.title = 'OCR误读';
  const result = mergeArticleRecord(normalizeRecord(sync(ocr).body)[0], first);
  const stored = JSON.parse(result.payload).wechatArticle;
  assert.equal(stored.source, 'page_dom');
  assert.equal(stored.bodyStatus, 'complete');
  assert.equal(result.content, '');
  assert.deepEqual(JSON.parse(result.image_urls), [input.article.images[0].url]);
  assert.equal(stored.latestCapture.source, 'screen_ocr');
  assert.equal(stored.latestCapture.title, 'OCR误读');
  assert.equal(stored.title, input.article.title);
});

test('actual runner merge and JSON event serialization satisfy the server DOM/phone contract', async () => {
  const {mergeArticleCapture, articleEvent} = await import('../runners/android/src/core/wechat-article-evidence.mjs');
  const taskIdentity = {...identity}; delete taskIdentity.eventId;
  const task = {identity: taskIdentity, keyword: '安吉星', mode: 'keyword'};
  const bodyAt = '2026-11-09T07:58:00.000Z', phoneAt = '2026-11-09T07:59:00.000Z', uploadAt = '2026-11-09T08:00:00.000Z';
  const paragraph = '长'.repeat(20_001);
  const urls = ['https://images.example.test/one.png', 'https://images.example.test/two.png'];
  const page = {...event().article, url: link, source: 'page_dom', capturedAt: bodyAt, timeSource: 'page_dom',
    content: `${paragraph}\n第二段`,
    images: urls.map((url, order) => ({url, alt: `图 ${order + 1}`, order, source: 'page_dom', stored: false})),
    bodyBlocks: [{type: 'text', text: paragraph}, {type: 'image', url: urls[0], alt: '图 1'},
      {type: 'text', text: '第二段'}, {type: 'image', url: urls[1], alt: '图 2'}],
    evidence: {bodyEndObserved: true, domContentObserved: true, domReadyState: 'complete',
      imageUrlsObserved: 2, selectorAcceptance: 'live_dom_20261109', originalImagesCaptured: false},
    metrics: {like: {value: 7, raw: '7', capturedAt: bodyAt}, read: {value: 48000, raw: '4.8万', precision: 'rounded', capturedAt: bodyAt}}};
  const phone = {article: {title: '手机标题不用于覆盖网页', content: '', bodyStatus: 'delegated', source: 'screen_ocr',
    evidence: {screens: 4, bodyEndObserved: false, overlapVerified: null},
    metrics: {like: {value: 0, raw: '0', capturedAt: phoneAt}, read: {value: null, raw: ''},
      recommend: {value: 3, raw: '3', capturedAt: phoneAt}}},
    comments: {status: 'captured', postingState: 'closed', headerCount: 2, source: 'screen_ocr', capturedAt: phoneAt, items: [
      {author: '读者', content: '文章末尾的旧留言', likeCount: null, reply: false},
      {author: '公众号', content: '作者回复', likeCount: 0, reply: true, parentIndex: 0}]}};
  const combined = mergeArticleCapture(page, phone, Date.parse(uploadAt));
  const serialized = JSON.parse(JSON.stringify(articleEvent({task, card: {snippet: '搜索摘要'}, rank: 1,
    shareUrl: `${link}?scene=21`, ...combined, capturedAt: Date.parse(uploadAt)})));
  const normalized = normalizeArticleEvent(serialized, principal);
  assert.equal(normalized.eventId, serialized.eventId);
  assert.equal(normalized.shareUrl, link);
  assert.equal(normalized.capturedAt, Date.parse(uploadAt));
  assert.equal(normalized.article.content, page.content);
  assert.equal(normalized.article.title, page.title);
  assert.equal(normalized.article.bodyStatus, 'complete', 'the phone delegated state never escapes as the body state');
  assert.equal(normalized.article.source, 'page_dom');
  assert.equal(normalized.article.capturedAt, bodyAt);
  assert.equal(normalized.article.timeSource, 'page_dom');
  assert.equal(normalized.article.publishedAt, '2026-11-08 23:59');
  assert.equal(normalized.article.timePrecision, 'minute');
  assert.deepEqual(normalized.article.images.map(({url, order, source, stored}) => ({url, order, source, stored})), page.images.map(({alt, ...image}) => image));
  assert.deepEqual(normalized.article.bodyBlocks.map(({type, text, url}) => type === 'text' ? {type, text} : {type, url}),
    page.bodyBlocks.map(({type, text, url}) => type === 'text' ? {type, text} : {type, url}));
  assert.deepEqual(normalized.article.evidence, {screens: null, bodyEndObserved: true, overlapVerified: null,
    originalImagesCaptured: false, domContentObserved: true, domReadyState: 'complete', imageUrlsObserved: 2,
    commentScreens: 4, selectorAcceptance: 'live_dom_20261109'});
  for (const [key, value, source, capturedAt] of [['like', 0, 'screen_ocr', phoneAt], ['read', 48000, 'page_dom', bodyAt],
    ['recommend', 3, 'screen_ocr', phoneAt], ['share', null, 'page_dom', bodyAt]]) {
    assert.equal(normalized.article.metrics[key].value, value, key);
    assert.equal(normalized.article.metrics[key].source, source, key);
    assert.equal(normalized.article.metrics[key].capturedAt, capturedAt, key);
  }
  assert.equal(normalized.comments.source, 'screen_ocr');
  assert.equal(normalized.comments.capturedAt, phoneAt);
  assert.equal(normalized.comments.postingState, 'closed');
  assert.equal(normalized.comments.items[0].likeCount, null);
  assert.equal(normalized.comments.items[1].likeCount, 0);
  assert.equal(normalized.comments.items[1].parentIndex, 0);
  const {body} = sync(serialized), [record] = normalizeRecord(body);
  assert.equal(record.likes, 0);
  assert.equal(record.shares, null);
  assert.deepEqual(body.payload.imageUrls, urls);
  assert.equal(body.payload.commentsCleanedItems[1].parentCommentId, body.payload.commentsCleanedItems[0].commentId);
});
