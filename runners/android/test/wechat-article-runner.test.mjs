import test from 'node:test';
import assert from 'node:assert/strict';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {runWechatArticleTask} from '../src/core/wechat-article-runner.mjs';
import {articleWorkKey, canonicalArticleUrl, articleOutsideWindow, articleWindowState} from '../src/core/wechat-article-evidence.mjs';
import {deliverPendingBatch} from '../src/cloud/delivery.mjs';
import {BudgetLedger} from '../src/core/budget.mjs';
import {fixtureClock, fixturePermit, fixtureTask} from './core-fixtures.mjs';

const url = 'https://mp.weixin.qq.com/s/bMWKCZnPrhVlz2uCqmRzKw';
const article = (overrides = {}) => ({title: '文章标题', content: '正文第一段\n正文最后一段', account: '账号', author: '作者',
  publishedAt: '2026-09-22 09:00', timePrecision: 'minute', timeLabel: '2026年9月22日 09:00',
  bodyStatus: 'complete', source: 'screen_ocr', metrics: {read: {raw: '4.8万', value: 48000, precision: 'approximate'}}, ...overrides});
const comment = {author: '读者', content: '正文后的留言', likeCount: null};
const task = overrides => fixtureTask({platform: 'wechat_articles', filters: {sort: 'latest', publishWindowHours: 24},
  comments: {enabled: true, limit: 20}, ...overrides});
function phone({reads = [{article: article(), comments: {status: 'captured', items: [comment]}, hasMore: false}], urls = [url]} = {}) {
  let opened = 0, chunk = 0;
  const calls = [], cards = urls.map((_, i) => ({cardKey: `card-${i}`, snippet: '文章标题', author: '账号'}));
  const methods = {inspect: async () => ({deviceId: 'phone-1', readyForSearch: true}),
    search: async () => ({verified: true, cards}), readCards: async () => cards, scroll: async () => {},
    openCard: async ({card}) => { opened = cards.indexOf(card); chunk = 0; return {opened: true}; }, copyLink: async () => ({shareUrl: urls[opened]}),
    openArticleLink: async () => { opened = 0; chunk = 0; return {opened: true}; },
    readArticle: async () => reads[Math.min(chunk++, reads.length - 1)], returnToResults: async () => cards, recoverResults: async () => cards};
  return {calls, device: Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async params => {
    calls.push({name, params}); return fn(params);
  }]))};
}
async function run({t = task(), device, clock = fixtureClock(), permit = fixturePermit(t, clock), ...options} = {}) {
  const store = new RunnerStore(':memory:');
  const result = await runWechatArticleTask({task: t, store, device, clock, permit, bodySource: 'screen_ocr', postPauseMs: [0, 0], ...options});
  const events = store.nextBatch()?.events ?? [];
  store.close(); return {result, events};
}

test('long articles read across bounded chunks, with one durable event and footer comments', async () => {
  const p = phone({reads: [{article: article({content: '第一段', bodyStatus: 'partial'}), hasMore: true, pagesRead: 8},
    {article: article(), comments: {status: 'captured', headerCount: 1, items: [comment]}, hasMore: false, pagesRead: 3}]});
  const {result, events} = await run({device: p.device});
  assert.equal(result.status, 'completed'); assert.equal(result.stats.posts, 1);
  assert.equal(p.calls.filter(x => x.name === 'readArticle').length, 2);
  assert.ok(p.calls.filter(x => x.name === 'readArticle').every(x => x.params.budgetMs <= 35000));
  assert.equal(events[0].article.content, '正文第一段\n正文最后一段');
  assert.equal(events[0].comments.items[0].content, comment.content);
  assert.equal(events[0].article.metrics.like.value, null);
});

test('closed, absent and disabled comments all retain the full body and null unknown counts', async () => {
  for (const status of ['closed', 'unavailable', 'disabled']) {
    const p = phone({reads: [{article: article(), comments: {status, postingState: status === 'closed' ? 'closed' : 'unknown',
      headerCount: null, items: []}, hasMore: false}]});
    const {events, result} = await run({device: p.device, t: task({comments: {enabled: status !== 'disabled', limit: 20}})});
    assert.equal(result.stats.posts, 1); assert.equal(events[0].article.bodyStatus, 'complete');
    assert.equal(events[0].article.content, article().content); assert.equal(events[0].comments.status, status);
    assert.equal(events[0].comments.headerCount, null);
  }
});

test('an article restored midway is returned to its verified header across bounded calls before copying', async () => {
  const p = phone(); let opening = 0;
  p.device.openCard = async () => ++opening === 1 ? {opened: false, hasMore: true} : {opened: true, hasMore: false};
  const {events} = await run({device: p.device});
  assert.equal(opening, 2); assert.equal(events.length, 1);
});

test('a partial body is recorded honestly and makes task completion carry a warning', async () => {
  const p = phone({reads: [{article: article({bodyStatus: 'partial', bodyReason: 'overlap_lost'}), comments: {status: 'unknown'}, hasMore: false}]});
  const {events, result} = await run({device: p.device});
  assert.equal(events[0].article.bodyStatus, 'partial'); assert.equal(events[0].article.bodyReason, 'overlap_lost');
  assert.equal(result.status, 'completed_with_warnings'); assert.equal(result.stats.partialBodies, 1);
});

test('desktop prose and images combine with phone-only comments and independently sourced counts', async () => {
  const p = phone({reads: [{article: article({content: '', bodyStatus: 'delegated', metrics: {
    like: {value: 0, raw: '0'}, read: {value: null, raw: ''}, recommend: {value: 3, raw: '3'},
  }}), comments: {status: 'captured', items: [comment]}, hasMore: false}]});
  const capturedAt = '2026-09-22T01:59:00.000Z';
  const page = article({url, source: 'page_dom', capturedAt, content: '直接读取的完整网页正文',
    images: [{url: 'https://images.example.test/article.png', alt: '正文配图'}],
    bodyBlocks: [{type: 'text', text: '直接读取的完整网页正文'}, {type: 'image', url: 'https://images.example.test/article.png'}],
    metrics: {like: {value: 7, raw: '7'}, read: {value: 48000, raw: '4.8万', capturedAt}},
    evidence: {domContentObserved: true, bodyEndObserved: true}});
  const seen = [];
  const {events, result} = await run({device: p.device, bodySource: 'page_dom', preview: {
    resolveArticle: async (link, options) => { seen.push({link, signal: options.signal}); return page; },
  }});
  assert.equal(result.stats.posts, 1); assert.equal(seen[0].link, url); assert.ok(seen[0].signal);
  const event = events[0];
  assert.equal(event.article.source, 'page_dom'); assert.equal(event.article.content, page.content);
  assert.equal(event.article.metrics.like.value, 0); assert.equal(event.article.metrics.like.source, 'screen_ocr');
  assert.equal(event.article.metrics.read.value, 48000); assert.equal(event.article.metrics.read.source, 'page_dom');
  assert.equal(event.article.metrics.read.capturedAt, capturedAt);
  assert.equal(event.article.metrics.share.value, null);
  assert.equal(event.comments.source, 'screen_ocr'); assert.equal(event.comments.items[0].content, comment.content);
  assert.equal(event.article.images[0].stored, false); assert.equal(event.article.evidence.originalImagesCaptured, false);
  assert.equal(p.calls.find(call => call.name === 'readArticle').params.bodyRequired, false);
});

test('desktop access failures do not silently fall back to screen OCR or invent an article', async () => {
  const p = phone();
  const {events, result} = await run({device: p.device, bodySource: 'page_dom', preview: {
    resolveArticle: async () => { throw Object.assign(new Error('verification required'), {code: 'article_page_challenge'}); },
  }});
  assert.equal(result.reason, 'article_page_challenge'); assert.equal(events.length, 0);
  assert.equal(p.calls.some(call => call.name === 'readArticle'), false);
});

test('a different desktop canonical link is refused before phone comment collection', async () => {
  const p = phone();
  const {events, result} = await run({device: p.device, bodySource: 'page_dom', preview: {
    resolveArticle: async () => article({url: 'https://mp.weixin.qq.com/s/AnotherArticle123', source: 'page_dom'}),
  }});
  assert.equal(result.reason, 'article_link_mismatch'); assert.equal(events.length, 0);
  assert.equal(p.calls.some(call => call.name === 'readArticle'), false);
});

test('desktop publish time applies the same strict time window before phone supplements', async () => {
  const p = phone();
  const {events, result} = await run({device: p.device, bodySource: 'page_dom', preview: {
    resolveArticle: async () => article({url, source: 'page_dom', publishedAt: '2026-09-20', timePrecision: 'date'}),
  }});
  assert.equal(result.stats.outsideWindow, 1); assert.equal(events.length, 0);
  assert.equal(p.calls.some(call => call.name === 'readArticle'), false);
});

test('a stop during the desktop read prevents subsequent phone gestures and upload', async () => {
  const t = task(), clock = fixtureClock(), permit = fixturePermit(t, clock), p = phone();
  const {result, events} = await run({t, clock, permit, device: p.device, bodySource: 'page_dom', preview: {
    resolveArticle: async () => { permit.stop('remote_stop'); return article({url, source: 'page_dom'}); },
  }});
  assert.equal(result.status, 'canceled'); assert.equal(events.length, 0);
  assert.equal(p.calls.some(call => call.name === 'readArticle'), false);
});

test('a phone supplement budget preserves already complete desktop text and marks comments partial', async () => {
  const t = task({budgets: {keywordMs: 1000}}), clock = fixtureClock(), p = phone();
  p.device.readArticle = async () => { clock.advance(1100); return {
    article: article({content: '', bodyStatus: 'delegated'}), comments: {status: 'partial', items: [comment]}, hasMore: true,
  }; };
  const {events, result} = await run({t, clock, device: p.device, bodySource: 'page_dom', preview: {
    resolveArticle: async () => article({url, source: 'page_dom', content: '完整网页正文'}),
  }});
  assert.equal(result.reason, 'keyword_time_limit'); assert.equal(events.length, 1);
  assert.equal(events[0].article.content, '完整网页正文'); assert.equal(events[0].article.bodyStatus, 'complete');
  assert.equal(events[0].comments.status, 'partial'); assert.equal(events[0].comments.reason, 'keyword_time_limit');
});

test('the normal article path requires the shared desktop preview before touching the phone', async () => {
  const p = phone();
  const {events, result} = await run({device: p.device, bodySource: 'page_dom'});
  assert.equal(result.reason, 'preview_unavailable'); assert.equal(events.length, 0); assert.equal(p.calls.length, 0);
});

test('two result cards for the same canonical short link produce one event', async () => {
  const p = phone({urls: [url, `${url}?scene=21#wechat_redirect`]});
  const {events, result} = await run({device: p.device});
  assert.equal(events.length, 1); assert.equal(result.stats.posts, 1);
  assert.equal(p.calls.filter(x => x.name === 'readArticle').length, 1);
  assert.equal(articleWorkKey(url), articleWorkKey(`${url}/?scene=21`));
  assert.equal(canonicalArticleUrl('https://mp.weixin.qq.com.evil.test/s/12345678'), '');
  assert.equal(canonicalArticleUrl('https://user@mp.weixin.qq.com/s/12345678'), '');
});

test('patrol opens the exact link without title search and verifies the copied canonical URL', async () => {
  const p = phone({urls: [`${url}?scene=1`]});
  const {result, events} = await run({device: p.device, t: task({mode: 'patrol', patrolTarget: {url, title: '文章标题'}})});
  assert.equal(result.reason, 'patrol_relocated'); assert.equal(events.length, 1); assert.equal(events[0].mode, 'patrol');
  assert.equal(events[0].link.shareUrl, url); assert.equal(p.calls.filter(x => x.name === 'readArticle').length, 1);
  assert.equal(p.calls.some(x => x.name === 'search'), false);
  assert.equal(p.calls.find(x => x.name === 'openArticleLink').params.url, url);
});

test('patrol refuses a different copied link even when the title is similar', async () => {
  const p = phone({urls: ['https://mp.weixin.qq.com/s/OtherArticle123']});
  const {result, events} = await run({device: p.device, t: task({mode: 'patrol', patrolTarget: {url, title: '文章标题'}})});
  assert.equal(result.reason, 'article_link_mismatch'); assert.equal(events.length, 0);
  assert.equal(p.calls.some(x => x.name === 'readArticle' || x.name === 'search'), false);
});

test('a stop between body chunks cancels without reading or uploading the rest', async () => {
  const t = task(), clock = fixtureClock(), permit = fixturePermit(t, clock), p = phone();
  p.device.readArticle = async () => { permit.stop('remote_stop'); return {article: article(), hasMore: true}; };
  const {result, events} = await run({t, clock, permit, device: p.device});
  assert.equal(result.status, 'canceled'); assert.equal(events.length, 0);
});

test('total time limit between chunks preserves the last settled text as partial', async () => {
  const t = task({budgets: {keywordMs: 1000}}), clock = fixtureClock(), p = phone();
  p.device.readArticle = async () => { clock.advance(1100); return {article: article({content: '已读正文'}), hasMore: true}; };
  const {events, result} = await run({t, clock, device: p.device});
  assert.equal(result.reason, 'keyword_time_limit'); assert.equal(events[0].article.content, '已读正文');
  assert.equal(events[0].article.bodyStatus, 'partial');
});

test('time-window exclusions respect minute/day uncertainty', () => {
  const capturedAt = Date.parse('2026-09-22T10:00:00+08:00');
  assert.equal(articleOutsideWindow(article({publishedAt: '2026-09-21', timePrecision: 'date'}), capturedAt, 24), false);
  assert.equal(articleOutsideWindow(article({publishedAt: '2026-09-20', timePrecision: 'date'}), capturedAt, 24), true);
  assert.equal(articleOutsideWindow(article({publishedAt: null, timePrecision: 'unknown'}), capturedAt, 24), false);
  assert.equal(articleOutsideWindow(article({publishedAt: '2026-09-21 09:00'}), capturedAt, 24), true);
  assert.equal(articleWindowState(article({publishedAt: '2026-09-21', timePrecision: 'date'}), capturedAt, 24), 'unknown');
  assert.equal(articleWindowState(article({publishedAt: '2026-09-22', timePrecision: 'date'}), capturedAt, 24), 'inside');
});

test('unknown publish dates are retained only when no strict time window was requested', async () => {
  for (const hours of [24, null]) {
    const p = phone({reads: [{article: article({publishedAt: null, timePrecision: 'unknown'}), comments: {status: 'unavailable'}, hasMore: false}]});
    const {result, events} = await run({device: p.device, t: task({filters: {sort: 'latest', publishWindowHours: hours}})});
    assert.equal(events.length, hours === null ? 1 : 0);
    assert.equal(result.stats.timeUnverified, hours === null ? 0 : 1);
  }
});

test('article outbox uses the post receipt endpoint and does not upload a committed event again', async () => {
  const store = new RunnerStore(':memory:');
  store.recordEvent({eventId: 'event-1', eventKind: 'wechat_article', discoveryRunId: 'run', itemId: 'item', attemptId: 'attempt'});
  let uploads = 0, lookups = 0;
  const client = {getPostReceipts: async id => { lookups++; return {uploadBatchId: id,
    receipts: [{eventId: 'event-1', status: 'duplicate', receiptId: 'receipt'}]}; }, ingestPosts: async () => { uploads++; }};
  const result = await deliverPendingBatch({store, client});
  assert.equal(result.status, 'delivered'); assert.equal(uploads, 0); assert.equal(lookups, 1); assert.equal(store.pendingCount(), 0);
  store.close();
});

test('recovery counts an article committed just before the link checkpoint and does not repeat its capture', async () => {
  const store = new RunnerStore(':memory:'), clock = fixtureClock(), t = task({budgets: {maxLinks: 1}});
  const ledger = new BudgetLedger({task: t, store, clock});
  store.recordEvent({eventId: 'event-before-crash', eventKind: 'wechat_article', workKey: articleWorkKey(url), ...t.identity});
  // A crash left a running checkpoint with no noteLink; only the event survived.
  assert.equal(ledger.item.links.length, 0);
  const resumed = {...t, identity: {...t.identity, attemptId: 'attempt-2', assignmentRevision: 2}};
  const recovered = new BudgetLedger({task: resumed, store, clock, resumeAuthorized: true});
  assert.deepEqual(recovered.item.links, [articleWorkKey(url)]);
  assert.throws(() => recovered.assertAllowed(), {code: 'budget_exhausted'});
  store.close();
});
