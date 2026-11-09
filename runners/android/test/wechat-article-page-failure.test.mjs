import test from 'node:test';
import assert from 'node:assert/strict';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {runWechatArticleTask} from '../src/core/wechat-article-runner.mjs';
import {articleWorkKey} from '../src/core/wechat-article-evidence.mjs';
import {readDiagnostics} from '../src/core/diagnostics.mjs';
import {fixtureClock, fixturePermit, fixtureTask} from './core-fixtures.mjs';

const urls = ['https://mp.weixin.qq.com/s/FirstArticle123', 'https://mp.weixin.qq.com/s/SecondArticle123'];
const fault = code => Object.assign(new Error(code), {code});
const page = (url, overrides = {}) => ({url, title: '文章标题', content: '已读完整网页正文', account: '公众号', author: '作者',
  publishedAt: '2026-09-22T09:00:00+08:00', timePrecision: 'minute', source: 'page_dom', bodyStatus: 'complete', ...overrides});
const articleTask = overrides => fixtureTask({platform: 'wechat_articles', filters: {sort: 'all', publishWindowHours: null},
  comments: {enabled: true, limit: 20}, ...overrides});

function phone(links) {
  const calls = [], cards = links.map((url, i) => ({cardKey: `card-${i}`, title: '文章标题', author: '公众号', url}));
  let current = cards[0];
  const methods = {inspect: async () => ({deviceId: 'phone-1', readyForSearch: true}),
    search: async () => ({verified: true, cards}), readCards: async () => cards, scroll: async () => {},
    openCard: async ({card}) => { current = card; return {opened: true}; },
    openArticleLink: async () => ({opened: true}), copyLink: async () => ({shareUrl: current.url}),
    readArticle: async () => ({article: {content: '', bodyStatus: 'delegated'}, comments: {status: 'captured', items: [
      {author: '读者', content: '独立留言'}]}, hasMore: false}), returnToResults: async () => cards, recoverResults: async () => cards};
  return {calls, device: Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, async params => {
    calls.push({name, url: params?.card?.url ?? current.url, params}); return method(params);
  }]))};
}

async function capture({links = urls, task = articleTask(), clock = fixtureClock(), permit = fixturePermit(task, clock),
  preview = async link => page(link), store: suppliedStore, configure = () => {}, ...options} = {}) {
  const store = suppliedStore ?? new RunnerStore(':memory:'), mobile = phone(links), previews = [];
  configure({store, mobile, clock, permit});
  try {
    const result = await runWechatArticleTask({task, store, clock, permit, device: mobile.device, postPauseMs: [0, 0], ...options,
      preview: {resolveArticle: async (link, params) => { previews.push(link); return preview(link, {...params, clock, permit}); }}});
    return {result, calls: mobile.calls, previews, events: store.nextBatch()?.events ?? [], diagnostics: readDiagnostics(store),
      ledger: store.loadCheckpoint(task.identity.discoveryRunId)?.value?.items[task.identity.itemId]};
  } finally { if (!suppliedStore) store.close(); }
}

test('a settled first-page timeout returns safely to results and records only the second article', async () => {
  const captured = await capture({preview: async link => { if (link === urls[0]) throw fault('preview_timeout'); return page(link); }});
  const {result, calls, events, diagnostics, ledger} = captured;
  assert.equal(result.status, 'completed_with_warnings'); assert.equal(result.reason, 'article_page_incomplete');
  assert.equal(result.stats.pageFailures, 1); assert.equal(result.stats.posts, 1); assert.equal(result.stats.links, 1);
  assert.equal(result.deviceIdle, true); assert.equal(result.stopConfirmationRequired, false);
  assert.equal(result.deviceClosure.required, false); assert.equal(result.lastEventId, events[0].eventId);
  assert.deepEqual(events.map(event => event.link.shareUrl), [urls[1]]);
  assert.deepEqual(calls.filter(call => call.name === 'readArticle').map(call => call.url), [urls[1]]);
  assert.deepEqual(calls.filter(call => call.name === 'returnToResults').map(call => call.url), urls);
  assert.deepEqual(ledger.links, [articleWorkKey(urls[1])]);
  const notes = diagnostics.filter(note => note.event === 'wechat_article_page_failed');
  assert.equal(notes.length, 1); assert.equal(notes[0].code, 'preview_timeout'); assert.equal(notes[0].operation, 'resolveArticle');
});

test('only the explicit settled DOM error codes are skipped without phone body fallback', async t => {
  for (const code of ['preview_unavailable', 'preview_cdp_error', 'article_preview_loading', 'article_preview_body_empty',
    'article_preview_header_incomplete', 'article_preview_unavailable', 'article_preview_navigation_failed',
    'article_preview_dom_error', 'article_preview_incomplete', 'article_preview_body_folded', 'article_preview_invalid_time']) {
    await t.test(code, async () => {
      const {result, calls, events, ledger} = await capture({links: [urls[0]], preview: async () => { throw fault(code); }});
      assert.equal(result.reason, 'article_page_incomplete'); assert.equal(result.stats.pageFailures, 1);
      assert.equal(result.deviceIdle, true); assert.equal(events.length, 0); assert.deepEqual(ledger.links, []);
      assert.equal(calls.some(call => call.name === 'readArticle'), false);
    });
  }
});

test('verification, challenge, identity, aborted and unknown errors stop before the next card', async t => {
  for (const code of ['article_preview_verification_required', 'article_page_challenge', 'article_preview_identity_mismatch',
    'article_link_invalid', 'aborted', 'unexpected_preview_error']) {
    await t.test(code, async () => {
      const {result, calls, events, previews} = await capture({preview: async () => { throw fault(code); }});
      assert.equal(result.status, 'needs_action'); assert.equal(result.reason, code); assert.equal(result.stats.pageFailures, 0);
      assert.equal(events.length, 0); assert.deepEqual(previews, [urls[0]]);
      assert.equal(calls.filter(call => call.name === 'openCard').length, 1);
      assert.equal(calls.some(call => ['readArticle', 'returnToResults', 'recoverResults'].includes(call.name)), false);
    });
  }
});

test('patrol propagates an otherwise skippable page failure and never marks the target captured', async () => {
  const {result, calls, events, ledger} = await capture({links: [urls[0]], task: articleTask({mode: 'patrol', patrolTarget: {url: urls[0]}}),
    preview: async () => { throw fault('preview_timeout'); }});
  assert.equal(result.status, 'needs_action'); assert.equal(result.reason, 'preview_timeout'); assert.equal(result.stats.pageFailures, 0);
  assert.equal(events.length, 0); assert.deepEqual(ledger.links, []);
  assert.equal(calls.some(call => ['search', 'readArticle', 'returnToResults'].includes(call.name)), false);
});

test('failed canonical links deduplicate only this run and remain retryable by a later task', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const failed = await capture({store, links: [urls[0], urls[0] + '?scene=1#wechat_redirect'], preview: async () => { throw fault('preview_timeout'); }});
    assert.deepEqual(failed.previews, [urls[0]]); assert.equal(failed.result.stats.pageFailures, 1);
    assert.deepEqual(failed.ledger.links, []); assert.equal(failed.result.stats.cards, 2); assert.equal(failed.events.length, 0);
    const next = articleTask(); next.identity = {...next.identity, taskId: 'run-2', discoveryRunId: 'run-2', itemId: 'item-2'};
    const retried = await capture({store, task: next, links: [urls[0]]});
    assert.deepEqual(retried.previews, [urls[0]]); assert.equal(retried.events.length, 1);
    assert.deepEqual(retried.ledger.links, [articleWorkKey(urls[0])]);
  } finally { store.close(); }
});

test('persistent browser startup failure remains bounded by unique cards and the existing card budget', async () => {
  const links = Array.from({length: 7}, (_, i) => `https://mp.weixin.qq.com/s/FailedArticle${i}`);
  const failing = {links, preview: async () => { throw fault('preview_unavailable'); }};
  const all = await capture(failing);
  assert.equal(all.result.reason, 'article_page_incomplete'); assert.equal(all.previews.length, 7);
  assert.equal(all.result.stats.pageFailures, 7); assert.equal(all.result.stats.links, 0); assert.equal(all.events.length, 0);
  assert.equal(all.calls.filter(call => call.name === 'scroll').length, 1, 'seen cards cannot loop endlessly');
  const bounded = await capture({...failing, task: articleTask({budgets: {maxCards: 3}})});
  assert.equal(bounded.result.reason, 'card_limit'); assert.equal(bounded.result.stats.pageFailures, 3);
  assert.equal(bounded.previews.length, 3); assert.equal(bounded.result.deviceIdle, true);
});

test('a page failure spends time but no links, and expired task budgets prevent further gestures', async t => {
  for (const [budgets, reason] of [[{keywordMs: 1000}, 'keyword_time_limit'], [{batchMs: 1000}, 'batch_time_limit']]) {
    await t.test(reason, async () => {
      const {result, calls, ledger} = await capture({task: articleTask({budgets}), preview: async (_link, {clock}) => {
        clock.advance(1100); throw fault('preview_timeout');
      }});
      assert.equal(result.status, 'completed_with_warnings'); assert.equal(result.reason, reason); assert.equal(result.stats.pageFailures, 1);
      assert.deepEqual(ledger.links, []); assert.equal(result.deviceIdle, true);
      assert.equal(calls.some(call => ['readArticle', 'returnToResults', 'recoverResults'].includes(call.name)), false);
    });
  }
  const {result, events} = await capture({task: articleTask({budgets: {maxLinks: 1}}), preview: async link => {
    if (link === urls[0]) throw fault('preview_timeout'); return page(link);
  }});
  assert.equal(events.length, 1); assert.equal(result.reason, 'link_limit'); assert.equal(result.stats.pageFailures, 1);
});

test('a stop or lease expiry cannot be swallowed as a simultaneous page timeout', async t => {
  for (const stop of ['remote_stop', 'lease_expired']) await t.test(stop, async () => {
    const {result, calls, events} = await capture({preview: async (_link, {permit, clock}) => {
      if (stop === 'remote_stop') permit.stop(stop); else clock.advance(90001);
      throw fault('preview_timeout');
    }});
    assert.equal(result.status, stop === 'remote_stop' ? 'canceled' : 'interrupted'); assert.equal(result.reason, stop);
    assert.equal(result.stats.pageFailures, 0); assert.equal(events.length, 0);
    assert.equal(calls.some(call => ['readArticle', 'returnToResults', 'recoverResults'].includes(call.name)), false);
  });
});

test('an outer operation timeout retains its uncertain closure even if the preview rejects on abort', async () => {
  const {result, calls, events} = await capture({actionTimeoutMs: 15, preview: async (_link, {signal}) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(fault('preview_timeout')), {once: true});
  })});
  assert.equal(result.reason, 'device_action_timeout'); assert.equal(result.deviceIdle, false);
  assert.equal(result.stopConfirmationRequired, true); assert.equal(result.deviceClosure.required, true);
  assert.equal(result.stats.pageFailures, 0); assert.equal(events.length, 0);
  assert.equal(calls.some(call => ['readArticle', 'returnToResults', 'recoverResults'].includes(call.name)), false);
});

test('page warning wins natural completion, but a later cancellation keeps its stop reason', async () => {
  const warning = await capture({preview: async link => {
    if (link === urls[0]) throw fault('preview_timeout');
    return page(link, {bodyStatus: 'partial', bodyReason: 'image_limit'});
  }});
  assert.equal(warning.result.reason, 'article_page_incomplete'); assert.equal(warning.result.stats.partialBodies, 1);
  const canceled = await capture({preview: async (link, {permit}) => {
    if (link === urls[0]) throw fault('preview_timeout'); permit.stop('remote_stop'); return page(link);
  }});
  assert.equal(canceled.result.status, 'canceled'); assert.equal(canceled.result.reason, 'remote_stop');
  assert.equal(canceled.result.stats.pageFailures, 1); assert.equal(canceled.events.length, 0);
});

test('the page failure exception scope never swallows phone or storage failures using the same code', async t => {
  for (const source of ['phone', 'storage']) await t.test(source, async () => {
    const {result, events} = await capture({configure: ({mobile, store}) => {
      const fail = async () => { throw fault('preview_timeout'); };
      if (source === 'phone') mobile.device.readArticle = fail;
      else store.recordEvent = () => { throw fault('preview_timeout'); };
    }});
    assert.equal(result.status, 'needs_action'); assert.equal(result.reason, 'preview_timeout');
    assert.equal(result.stats.pageFailures, 0); assert.equal(events.length, 0);
  });
});

test('a null desktop result is rejected instead of triggering phone OCR fallback', async () => {
  const {result, events, calls} = await capture({preview: async () => null});
  assert.equal(result.reason, 'article_page_incomplete'); assert.equal(result.stats.pageFailures, 0);
  assert.equal(events.length, 0); assert.equal(calls.some(call => call.name === 'readArticle'), false);
});
