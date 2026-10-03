// 2026-10-03 (Runner 0.3.0): about nine in ten cards a phone keyword opened (~17 s each) were unrelated noise. The fresh
// cards of a results page now go to the server's relevance prefilter before any is opened, and only a card the server
// clearly marks irrelevant (the extension's skip rule) stays unopened. Every doubt, error or timeout opens the card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RunnerStore } from '../src/storage/runner-store.mjs';
import { runDiscoveryTask } from '../src/core/discovery-runner.mjs';
import { readDiagnostics, PREFILTER_DIAGNOSTICS_KEY } from '../src/core/diagnostics.mjs';
import { diagnoseRunner } from '../src/daemon/diagnose.mjs';
import { createCardPrefilter, shouldSkipCard, cleanText, clipText, PREFILTER_BATCH } from '../src/core/card-prefilter.mjs';
import { createControlClient } from '../src/cloud/control-client.mjs';
import { CloudRequestError } from '../src/cloud/transport.mjs';
import { describeOutcome } from '../src/cli/up-command.mjs';
import { fixtureTask, fixtureClock, fixturePermit, fixtureDevice } from './core-fixtures.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const makeCard = (title, author = '车友') => ({ cardId: createHash('sha256').update(JSON.stringify([title, author])).digest('hex'),
  title, author, publishTimeRaw: '1 小时前' });
const cardsOf = (count, prefix = '别克远控上线') => Array.from({ length: count }, (_, index) => makeCard(`${prefix} 第${index + 1}条`));
const skipItem = (card, extra = {}) => ({ cardId: card.cardId, status: 'ok', modelDecision: 'skip', tenantRelevance: 'irrelevant',
  confidence: 0.98, protectedSignal: false, executionDisposition: 'skip_full_capture', reason: '美食探店，与上汽通用无关', ...extra });
const keepItem = card => ({ cardId: card.cardId, status: 'ok', modelDecision: 'keep', tenantRelevance: 'relevant', confidence: 0.9,
  protectedSignal: false, executionDisposition: 'collect_full', reason: '车机远控相关' });
const answer = items => ({ ok: true, enabled: true, degraded: false, items });
const enabledTask = (overrides = {}) => fixtureTask({ relevancePrefilter: { enabled: true }, ...overrides });

/** A client that answers each card by `decide(card)` and records every request and the most concurrent ones. */
function fakeClient(decide = card => skipItem(card)) {
  const requests = [];
  let inFlight = 0, maxInFlight = 0;
  return { requests, get maxInFlight() { return maxInFlight; }, prefilter: async (body, opts) => {
    requests.push({ body, opts });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight--;
    return answer(body.cards.map(card => decide(card)));
  } };
}

test('skip rule: only a clean, single, confident "irrelevant → skip_full_capture" answer leaves a card unopened', () => {
  const card = makeCard('周末去吃火锅');
  assert.equal(shouldSkipCard(answer([skipItem(card)]), card), true);
  assert.equal(shouldSkipCard(answer([skipItem(card, { confidence: 0 })]), card), true);
  assert.equal(shouldSkipCard(answer([skipItem(card, { confidence: 1 })]), card), true);
  const opens = {
    'response not ok': { ...answer([skipItem(card)]), ok: false },
    'switch off': { ...answer([skipItem(card)]), enabled: false },
    'enabled not boolean true': { ...answer([skipItem(card)]), enabled: 'true' },
    'items missing': { ok: true, enabled: true },
    'no item for the card': answer([skipItem(makeCard('别的作品'))]),
    'duplicate items': answer([skipItem(card), skipItem(card)]),
    'status model_error': answer([skipItem(card, { status: 'model_error' })]),
    'status upper case': answer([skipItem(card, { status: 'OK' })]),
    'decision keep': answer([skipItem(card, { modelDecision: 'keep' })]),
    'decision need_detail': answer([skipItem(card, { modelDecision: 'need_detail' })]),
    'relevance uncertain': answer([skipItem(card, { tenantRelevance: 'uncertain' })]),
    'relevance relevant': answer([skipItem(card, { tenantRelevance: 'relevant' })]),
    'confidence as text': answer([skipItem(card, { confidence: '0.99' })]),
    'confidence missing': answer([skipItem(card, { confidence: undefined })]),
    'confidence NaN': answer([skipItem(card, { confidence: Number.NaN })]),
    'confidence infinite': answer([skipItem(card, { confidence: Infinity })]),
    'confidence below 0': answer([skipItem(card, { confidence: -0.01 })]),
    'confidence above 1': answer([skipItem(card, { confidence: 1.01 })]),
    'protected signal': answer([skipItem(card, { protectedSignal: true })]),
    'disposition collect_full': answer([skipItem(card, { executionDisposition: 'collect_full' })]),
    'disposition defer_enhancement': answer([skipItem(card, { executionDisposition: 'defer_enhancement' })]),
    'disposition missing': answer([skipItem(card, { executionDisposition: undefined })]),
  };
  for (const [name, response] of Object.entries(opens)) assert.equal(shouldSkipCard(response, card), false, name);
  for (const title of ['', ' ', '火', ' \u200b火\u200d ', '无标题', '无标题数据', '搜索结果笔记', '抖音搜索结果', '抖音搜索结果 12',
    '关键词：', '关键词 :', '单篇笔记', '\u200b单篇笔记\ufeff']) {
    const weak = { ...card, title };
    assert.equal(shouldSkipCard(answer([skipItem(weak)]), weak), false, JSON.stringify(title));
  }
  assert.equal(shouldSkipCard(answer([skipItem({ ...card, title: '火锅' })]), { ...card, title: '火锅' }), true);
});

test('placeholder and one-character titles are never sent, so they are never skipped', async () => {
  const client = fakeClient();
  const weak = [makeCard('无标题'), makeCard('火'), makeCard('抖音搜索结果 3')];
  const strong = makeCard('周末去吃火锅');
  const prefilter = createCardPrefilter({ client, task: enabledTask() });
  const result = await prefilter.decide([...weak, strong, { ...strong }, { cardId: 'card-1', title: '不是十六进制的卡片', author: 'a' }]);
  assert.deepEqual([...result.skip], [strong.cardId]);
  assert.equal(client.requests.length, 1);
  assert.deepEqual(client.requests[0].body.cards.map(card => card.cardId), [strong.cardId]);
  assert.deepEqual({ judged: result.judged, unjudged: result.unjudged }, { judged: 1, unjudged: 0 });
});

test('cards go in order, at most 8 per request, one request at a time, each with a new request ID', async () => {
  const task = enabledTask();
  const client = fakeClient();
  const cards = cardsOf(19);
  const result = await createCardPrefilter({ client, task }).decide(cards);
  assert.deepEqual(client.requests.map(request => request.body.cards.length), [PREFILTER_BATCH, PREFILTER_BATCH, 3]);
  assert.deepEqual(client.requests.flatMap(request => request.body.cards.map(card => card.cardId)), cards.map(card => card.cardId));
  assert.equal(client.maxInFlight, 1);
  const ids = client.requests.map(request => request.body.requestId);
  assert.ok(ids.every(id => UUID_V4.test(id)));
  assert.equal(new Set(ids).size, 3);
  for (const { body, opts } of client.requests) {
    assert.deepEqual(Object.keys(body).sort(), ['cards', 'identity', 'requestId']);
    assert.deepEqual(body.identity, task.identity);
    assert.ok(body.cards.every(card => Object.keys(card).sort().join() === 'author,cardId,title'));
    assert.ok(opts.signal instanceof AbortSignal);
  }
  assert.deepEqual({ skipped: result.skip.size, judged: result.judged, unjudged: result.unjudged }, { skipped: 19, judged: 19, unjudged: 0 });
});

test('titles and authors are cleaned and cut without splitting a surrogate pair', async () => {
  assert.equal(cleanText(' \u200b别克\u200c\n\t远控\ufeff  上线 \u200d'), '别克 远控 上线');
  assert.equal(clipText('a😀b', 2), 'a');
  assert.equal(clipText('a😀b', 3), 'a😀');
  assert.equal(clipText('abc', 5), 'abc');
  const client = fakeClient();
  const longTitle = `\u200b 开头  ${'车'.repeat(496)}😀尾巴`; // cleaned: "开头 " + 496 车 = 499 units, so the emoji straddles unit 500
  const longAuthor = `${'作'.repeat(199)}😀者`;
  const card = { ...makeCard(longTitle, longAuthor) };
  await createCardPrefilter({ client, task: enabledTask() }).decide([card]);
  const sent = client.requests[0].body.cards[0];
  assert.equal(sent.title, `开头 ${'车'.repeat(496)}`);
  assert.equal(sent.title.length, 499);
  assert.equal(sent.author, '作'.repeat(199));
  assert.equal(sent.cardId, card.cardId);
});

test('the plan switch off, or a client without the route, never calls anything', async () => {
  for (const task of [fixtureTask(), fixtureTask({ relevancePrefilter: { enabled: false } }), fixtureTask({ relevancePrefilter: { enabled: 'true' } })]) {
    const client = fakeClient();
    const prefilter = createCardPrefilter({ client, task });
    assert.equal(prefilter.enabled, false);
    const result = await prefilter.decide(cardsOf(3));
    assert.deepEqual({ skipped: result.skip.size, judged: result.judged, unjudged: result.unjudged }, { skipped: 0, judged: 0, unjudged: 0 });
    assert.equal(client.requests.length, 0);
  }
  assert.equal(createCardPrefilter({ client: {}, task: enabledTask() }).enabled, false);
});

test('an "enabled: false" answer opens the batch and stops further requests for the task', async () => {
  let calls = 0;
  const batches = [];
  const prefilter = createCardPrefilter({ task: enabledTask(), onBatch: batch => batches.push(batch),
    client: { prefilter: async () => { calls++; return { ok: true, enabled: false, degraded: false, items: [] }; } } });
  const first = await prefilter.decide(cardsOf(3));
  assert.deepEqual({ skipped: first.skip.size, judged: first.judged, unjudged: first.unjudged, failure: first.failure },
    { skipped: 0, judged: 0, unjudged: 3, failure: 'prefilter_disabled' });
  const later = await prefilter.decide(cardsOf(2, '下一页'));
  assert.equal(calls, 1);
  assert.deepEqual({ skipped: later.skip.size, unjudged: later.unjudged, failure: later.failure }, { skipped: 0, unjudged: 2, failure: 'prefilter_disabled' });
  assert.equal(prefilter.stopped, 'prefilter_disabled');
  assert.equal(batches.length, 1);
});

test('a thrown error, a malformed answer or a timeout opens the batch; two failed requests in a row stop the calls', async () => {
  const outcomes = [
    () => { throw new CloudRequestError('cloud_http_409', { status: 409, serverCode: 'STALE_ATTEMPT' }); },
    body => answer(body.cards.map(card => skipItem(card))),
    () => ({ ok: true, enabled: true }),
    () => new Promise(() => {}),
  ];
  const signals = [];
  let calls = 0;
  const prefilter = createCardPrefilter({ task: enabledTask(), timeoutMs: 20,
    client: { prefilter: async (body, { signal }) => { signals.push(signal); return outcomes[calls++](body); } } });
  const first = await prefilter.decide(cardsOf(2, '一'));
  assert.deepEqual({ skipped: first.skip.size, unjudged: first.unjudged, failure: first.failure }, { skipped: 0, unjudged: 2, failure: 'STALE_ATTEMPT' });
  const second = await prefilter.decide(cardsOf(2, '二')); // a success resets the failure streak
  assert.deepEqual({ skipped: second.skip.size, judged: second.judged, failure: second.failure }, { skipped: 2, judged: 2, failure: null });
  const third = await prefilter.decide(cardsOf(2, '三'));
  assert.deepEqual({ unjudged: third.unjudged, failure: third.failure }, { unjudged: 2, failure: 'invalid_prefilter_response' });
  const fourth = await prefilter.decide(cardsOf(2, '四'));
  assert.deepEqual({ unjudged: fourth.unjudged, failure: fourth.failure }, { unjudged: 2, failure: 'prefilter_timeout' });
  assert.equal(signals.at(-1).aborted, true, 'the timed-out request is aborted');
  assert.equal(prefilter.stopped, 'prefilter_breaker_open');
  const fifth = await prefilter.decide(cardsOf(2, '五'));
  assert.equal(calls, 4);
  assert.deepEqual({ unjudged: fifth.unjudged, failure: fifth.failure }, { unjudged: 2, failure: 'prefilter_breaker_open' });
});

test('within one page the breaker stops the third batch after two failed requests', async () => {
  let calls = 0;
  const prefilter = createCardPrefilter({ task: enabledTask(), client: { prefilter: async () => { calls++; throw new Error('socket hang up'); } } });
  const result = await prefilter.decide(cardsOf(17));
  assert.equal(calls, 2);
  assert.deepEqual({ skipped: result.skip.size, judged: result.judged, unjudged: result.unjudged, failure: result.failure },
    { skipped: 0, judged: 0, unjudged: 17, failure: 'prefilter_failed' });
});

test('missing, duplicated or non-ok items open only those cards; the rest of the answer still counts', async () => {
  const [a, b, c, d] = cardsOf(4);
  const prefilter = createCardPrefilter({ task: enabledTask(), client: { prefilter: async () => answer([skipItem(a),
    skipItem(b), skipItem(b), skipItem(c, { status: 'model_error' }), skipItem(makeCard('别的作品'))]) } });
  const result = await prefilter.decide([a, b, c, d]);
  assert.deepEqual([...result.skip], [a.cardId]);
  assert.deepEqual({ judged: result.judged, unjudged: result.unjudged, failure: result.failure }, { judged: 1, unjudged: 3, failure: null });
});

test('the control client posts the prefilter to the agent route with the agent token', async () => {
  const body = { identity: fixtureTask().identity, requestId: '00000000-0000-4000-8000-000000000000', cards: [] };
  const client = createControlClient({ baseUrl: 'https://capture.example', agentToken: 'local-fixture-token',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://capture.example/api/capture-cloud/android/agent/prefilter');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['x-capture-agent-token'], 'local-fixture-token');
      assert.deepEqual(JSON.parse(options.body), body);
      return Response.json({ ok: true, enabled: false, degraded: false, items: [] });
    } });
  assert.deepEqual(await client.prefilter(body), { ok: true, enabled: false, degraded: false, items: [] });
});

// ---- The discovery runner with the prefilter ----

function flowDevice(task, pages, overrides = {}) {
  let read = 0;
  return fixtureDevice(task, {
    readCards: async () => ({ contextVerified: true, contextId: 'context-1', cards: pages[Math.min(read++, pages.length - 1)], end: false }),
    openCard: async ({ card }) => ({ identityVerified: true, cardId: card.cardId, detailId: `detail-${card.cardId.slice(0, 8)}`,
      externalId: String(7_000_000_000_000_000n + BigInt(Number.parseInt(card.cardId.slice(0, 8), 16))) }),
    ...overrides,
  });
}
async function runFlow({ task = enabledTask(), pages, client, overrides, withPrefilter = true, onPermit } = {}) {
  const store = new RunnerStore(':memory:');
  const clock = fixtureClock();
  const permit = fixturePermit(task, clock);
  onPermit?.(permit);
  const { device, calls } = flowDevice(task, pages, overrides);
  const result = await runDiscoveryTask({ task, store, clock, permit, device,
    ...(withPrefilter ? { prefilter: options => createCardPrefilter({ ...options, client }) } : {}) });
  return { result, store, calls, clock, notes: readDiagnostics(store, { key: PREFILTER_DIAGNOSTICS_KEY }), mainNotes: readDiagnostics(store) };
}

test('a page of 5 with 3 judged irrelevant opens only 2; empty-page detection is unchanged', async () => {
  const page = cardsOf(5);
  const skip = new Set([page[1], page[2], page[4]].map(card => card.cardId));
  const client = fakeClient(card => skip.has(card.cardId) ? skipItem(card) : keepItem(card));
  const { result, store, calls, clock, notes, mainNotes } = await runFlow({ pages: [page], client });
  try {
    assert.equal(result.status, 'completed_with_warnings');
    assert.equal(result.reason, 'no_new_cards');
    assert.deepEqual(calls, ['inspect', 'search', 'readCards', 'openCard', 'copyLink', 'returnToResults',
      'openCard', 'copyLink', 'returnToResults', 'scroll', 'readCards', 'scroll', 'readCards']);
    assert.equal(client.requests.length, 1, 'pages without fresh cards are not sent again');
    assert.equal(result.stats.links, 2);
    assert.equal(result.stats.cards, 2);
    assert.equal(result.stats.skippedCards, 0);
    assert.deepEqual([result.stats.prefilterSkipped, result.stats.prefilterJudged, result.stats.prefilterUnjudged], [3, 5, 0]);
    assert.deepEqual(store.nextBatch().events.map(event => event.titleHint), [page[0].title, page[3].title]);
    const batch = notes.find(note => note.event === 'card_prefilter');
    assert.equal(batch.cards, 5);
    assert.equal(batch.judged, 5);
    assert.equal(batch.skipped, 3);
    assert.equal(batch.unjudged, 0);
    assert.equal(batch.failure, null);
    assert.equal(typeof batch.latencyMs, 'number');
    assert.deepEqual(batch.aiSkipped, [page[1], page[2], page[4]].map(card => ({ title: card.title, reason: '美食探店，与上汽通用无关' })));
    assert.equal(batch.keyword, '别克壁纸');
    assert.equal(result.deviceIdle, true);
    // The per-request notes keep their own ring; the failure ring still holds only the finished task.
    assert.deepEqual(mainNotes.map(note => note.event), ['task_finished']);
    assert.equal(mainNotes[0].stats.prefilterSkipped, 3);
    const report = diagnoseRunner(store, { hours: 1, now: clock.wallNow() + 1000 });
    assert.deepEqual([report.runs[0].aiSkipped, report.runs[0].aiJudged, report.runs[0].aiUnjudged, report.summary.aiSkipped], [3, 5, 0, 3]);
    assert.deepEqual(report.prefilter.map(note => [note.event, note.skipped]), [['card_prefilter', 3]]);
    assert.deepEqual(report.problems, []);
  } finally { store.close(); }
});

test('a page whose fresh cards are all skipped still counts as new cards', async () => {
  const { result, store, calls } = await runFlow({ pages: [cardsOf(5)], client: fakeClient() });
  try {
    assert.equal(result.reason, 'no_new_cards');
    assert.deepEqual(calls, ['inspect', 'search', 'readCards', 'scroll', 'readCards', 'scroll', 'readCards']);
    assert.deepEqual([result.stats.cards, result.stats.links, result.stats.prefilterSkipped], [0, 0, 5]);
  } finally { store.close(); }
});

test('a failing prefilter opens every card and never ends the task', async () => {
  let calls = 0;
  const client = { prefilter: async () => { calls++; throw new CloudRequestError('cloud_http_503', { status: 503, serverCode: 'PREFILTER_UNAVAILABLE' }); } };
  const pages = [cardsOf(3, '一'), cardsOf(3, '二'), cardsOf(3, '三')];
  const { result, store, notes } = await runFlow({ pages, client });
  try {
    assert.equal(result.status, 'completed_with_warnings');
    assert.equal(result.stats.links, 9);
    assert.equal(calls, 2, 'the third page is not sent after two failed requests');
    assert.deepEqual([result.stats.prefilterSkipped, result.stats.prefilterJudged, result.stats.prefilterUnjudged], [0, 0, 9]);
    assert.deepEqual(notes.filter(note => note.event === 'card_prefilter').map(note => note.failure), ['PREFILTER_UNAVAILABLE', 'PREFILTER_UNAVAILABLE']);
    assert.equal(result.deviceIdle, true);
  } finally { store.close(); }
});

test('a stop while the prefilter request is pending ends the task without opening a card', async () => {
  for (const ignoresSignal of [false, true]) {
    let permit;
    const client = { prefilter: (_body, { signal }) => new Promise((_, reject) => {
      setTimeout(() => permit.stop('user_stop'), 5);
      if (!ignoresSignal) signal.addEventListener('abort', () => reject(new CloudRequestError('cloud_aborted')), { once: true });
    }) };
    const { result, store, calls } = await runFlow({ pages: [cardsOf(5)], client, onPermit: value => { permit = value; } });
    try {
      assert.equal(result.status, 'canceled');
      assert.equal(result.reason, 'user_stop');
      assert.deepEqual(calls, ['inspect', 'search', 'readCards']);
      assert.equal(result.deviceIdle, true);
      assert.equal(store.pendingCount(), 0);
    } finally { store.close(); }
  }
});

test('without a prefilter, or with the plan switch off, the run is exactly as before', async () => {
  const page = cardsOf(5);
  const plain = await runFlow({ task: fixtureTask(), pages: [page], withPrefilter: false });
  const client = fakeClient();
  const switchedOff = await runFlow({ task: fixtureTask(), pages: [page], client });
  try {
    for (const { result, calls, notes, store } of [plain, switchedOff]) {
      assert.equal(result.reason, 'no_new_cards');
      assert.equal(calls.filter(name => name === 'openCard').length, 5);
      assert.equal(result.stats.links, 5);
      assert.deepEqual(Object.keys(result.stats), ['cards', 'swipes', 'links', 'skippedCards', 'keywordElapsedMs', 'batchElapsedMs']);
      assert.deepEqual(notes, []);
      assert.equal(diagnoseRunner(store, { hours: 1, now: Date.parse('2026-09-22T02:00:01Z') }).runs[0].aiSkipped, undefined);
    }
    assert.deepEqual(switchedOff.calls, plain.calls);
    assert.equal(client.requests.length, 0);
  } finally { plain.store.close(); switchedOff.store.close(); }
});

test('the one-click window line adds the AI skips only when there are some', () => {
  const base = { keyword: '别克远控', status: 'completed_with_warnings', reason: 'no_new_cards', links: 2, skipped: 0 };
  assert.equal(describeOutcome({ ...base, prefilterSkipped: 18 }), '【完成】别克远控 · 找到 2 条 · AI 跳过 18 条无关 · 结果已看完');
  assert.equal(describeOutcome({ ...base, prefilterSkipped: 0 }), describeOutcome(base));
  assert.doesNotMatch(describeOutcome(base), /AI/u);
});
