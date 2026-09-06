import assert from 'node:assert/strict';
import test from 'node:test';
import { createResultReadSession } from '../../extension-ui/application/result-read-session.mjs';

const SCOPE = Object.freeze({ tenantId: 'tenant-甲', taskId: 'task-1', executionId: 'execution-1' });
const QUERY = Object.freeze({ filter: 'all', offset: 0, limit: 50 });

function summary(id = 'record-1', overrides = {}) {
  return {
    id, title: '测试标题', platform: 'xiaohongshu', kind: 'note', author: '作者', summary: '轻量摘要',
    likes: 4, commentsCount: 0, capture: { status: 'completed' },
    delivery: { remote: 'confirmed', local: 'confirmed' }, ...overrides,
  };
}

function pageResponse(request, overrides = {}) {
  return {
    scope: { ...request.scope }, snapshotId: 'snapshot-1', query: { ...request.query },
    items: [summary()], counts: { all: 1, attention: 0, matching: 1 }, ...overrides,
  };
}

function detailResponse(request, overrides = {}) {
  return {
    scope: { ...request.scope }, snapshotId: request.snapshotId, recordId: request.recordId,
    detail: { body: '正文', comments: [{ author: '评论作者', text: '评论内容' }], truncated: { body: false, comments: false } },
    ...overrides,
  };
}

function harness(t, options = {}) {
  const calls = { page: [], detail: [] };
  const source = {
    readSummaryPage(request) {
      calls.page.push(request);
      return options.readSummaryPage ? options.readSummaryPage(request) : pageResponse(request);
    },
    readRecordDetail(request) {
      calls.detail.push(request);
      return options.readRecordDetail ? options.readRecordDetail(request) : detailResponse(request);
    },
  };
  const session = createResultReadSession({ scope: options.scope ?? { ...SCOPE }, source, timeoutMs: options.timeoutMs ?? 3000 });
  t.after(() => session.close());
  return { session, calls, source };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function sourceStarted() {
  await Promise.resolve();
  await Promise.resolve();
}

function frozenTree(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (Object.hasOwn(descriptor, 'value')) frozenTree(descriptor.value);
  }
}

function terminal(result, status) {
  assert.equal(result.status, status);
  assert.deepEqual(Object.keys(result).sort(), ['requestToken', 'status']);
  assert.equal(typeof result.requestToken, 'object');
  assert.notEqual(result.requestToken, null);
  frozenTree(result);
}

test('session exposes only frozen read-only lifecycle methods', t => {
  const { session } = harness(t);
  assert.deepEqual(Object.keys(session).sort(), ['cancel', 'close', 'isCurrent', 'readDetail', 'readPage']);
  assert.equal(Object.isFrozen(session), true);
  for (const method of Object.values(session)) assert.equal(typeof method, 'function');
});

test('successful page projects only display data and detail uses the issued selection token', async t => {
  const { session, calls } = harness(t);
  const result = await session.readPage();
  assert.equal(result.status, 'ready');
  assert.equal(typeof result.pageToken, 'object');
  assert.notEqual(result.pageToken, null);
  assert.notEqual(result.requestToken, result.pageToken);
  assert.equal(session.isCurrent(result.requestToken), true);
  assert.deepEqual(result.page.counts, { all: 1, attention: 0, matching: 1 });
  assert.deepEqual(result.page.page, { ...QUERY, hasPrevious: false, hasNext: false });
  assert.equal(result.page.items[0].title, '测试标题');
  assert.equal(result.page.items[0].capture.key, 'completed');
  assert.equal(result.page.items[0].delivery.key, 'confirmed');
  assert.equal(result.page.items[0].metrics[1].value, '0');
  assert.equal(Object.hasOwn(result.page.items[0], 'body'), false);
  const selected = await session.readDetail({ recordId: 'record-1', pageToken: result.pageToken });
  assert.equal(selected.status, 'ready');
  assert.equal(selected.recordId, 'record-1');
  assert.equal(selected.detail.body, '正文');
  assert.equal(selected.detail.comments[0].text, '评论内容');
  assert.deepEqual(Object.keys(calls.page[0]).sort(), ['query', 'scope', 'signal']);
  assert.deepEqual(Object.keys(calls.detail[0]).sort(), ['recordId', 'scope', 'signal', 'snapshotId']);
  assert.deepEqual(calls.page[0].scope, SCOPE);
  assert.deepEqual(calls.page[0].query, QUERY);
  assert.equal(calls.detail[0].snapshotId, 'snapshot-1');
  assert.equal(calls.detail[0].recordId, 'record-1');
  assert.equal(typeof calls.page[0].signal.addEventListener, 'function');
  frozenTree(result);
  frozenTree(selected);
});

test('source already paginates: nonzero offset does not slice the supplied rows again', async t => {
  const { session } = harness(t, {
    readSummaryPage: request => pageResponse(request, {
      items: [summary('record-51'), summary('record-52')], counts: { all: 1500, attention: 150, matching: 1500 },
    }),
  });
  const result = await session.readPage({ filter: 'all', offset: 50, limit: 2 });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.page.items.map(item => item.id), ['record-51', 'record-52']);
  assert.deepEqual(result.page.counts, { all: 1500, attention: 150, matching: 1500 });
  assert.deepEqual(result.page.page, { filter: 'all', offset: 50, limit: 2, hasPrevious: true, hasNext: true });
});

test('attention pages preserve authorized global counts and the supplied selection', async t => {
  const { session } = harness(t, {
    readSummaryPage: request => pageResponse(request, {
      items: [summary('attention-51', { delivery: { remote: 'unknown', local: 'confirmed' } })],
      counts: { all: 1500, attention: 51, matching: 51 },
    }),
  });
  const result = await session.readPage({ filter: 'attention', offset: 50, limit: 50 });
  assert.equal(result.status, 'ready');
  assert.equal(result.page.items[0].needsAttention, true);
  assert.equal(result.page.items[0].id, 'attention-51');
  assert.equal(result.page.page.hasNext, false);
  assert.equal(result.page.page.hasPrevious, true);
});

test('an actual empty authorized result is ready, never confused with a read error', async t => {
  const { session } = harness(t, {
    readSummaryPage: request => pageResponse(request, { items: [], counts: { all: 0, attention: 0, matching: 0 } }),
  });
  const result = await session.readPage();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.page.items, []);
  assert.deepEqual(result.page.counts, { all: 0, attention: 0, matching: 0 });
  terminal(await session.readDetail({ recordId: 'record-1', pageToken: result.pageToken }), 'selection_unavailable');
});

for (const query of [null, 5, [], { filter: 'private-secret' }, { offset: -1 }, { offset: 0.5 },
  { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 51 }, { limit: '50' }]) {
  test(`invalid query is an explicit terminal result (${JSON.stringify(query)})`, async t => {
    const { session, calls } = harness(t);
    const previous = await session.readPage();
    terminal(await session.readPage(query), 'invalid_request');
    terminal(await session.readDetail({ recordId: 'record-1', pageToken: previous.pageToken }), 'selection_unavailable');
    assert.equal(calls.page.length, 1);
    assert.equal(calls.detail.length, 0);
  });
}

test('query getters are never executed or forwarded as source commands', async t => {
  const { session, calls } = harness(t);
  let accessed = 0;
  const query = { get filter() { accessed += 1; return 'all'; } };
  terminal(await session.readPage(query), 'invalid_request');
  assert.equal(accessed, 0);
  assert.equal(calls.page.length, 0);
});

test('caller mutation cannot retarget the fixed scope or the queued page query', async t => {
  const scope = { ...SCOPE };
  const { session, calls } = harness(t, { scope });
  const query = { filter: 'all', offset: 0, limit: 50, extra: 'not-a-command' };
  const pending = session.readPage(query);
  scope.tenantId = 'other-tenant';
  scope.executionId = 'other-execution';
  query.filter = 'attention';
  query.limit = 1;
  const result = await pending;
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls.page[0].scope, SCOPE);
  assert.deepEqual(calls.page[0].query, QUERY);
  assert.equal(Object.isFrozen(scope), false);
  assert.equal(Object.isFrozen(query), false);
});

test('projected responses freeze only new models and do not freeze or mutate source input', async t => {
  let original;
  const { session } = harness(t, {
    readSummaryPage(request) { original = pageResponse(request); return original; },
  });
  const result = await session.readPage();
  assert.equal(result.status, 'ready');
  frozenTree(result);
  assert.equal(Object.isFrozen(original), false);
  assert.equal(Object.isFrozen(original.items), false);
  assert.equal(Object.isFrozen(original.items[0].capture), false);
  original.items[0].title = 'mutated source';
  original.counts.all = 900;
  assert.equal(result.page.items[0].title, '测试标题');
  assert.equal(result.page.counts.all, 1);
});

test('page summary handling never even probes body or comments fields', async t => {
  const { session } = harness(t, {
    readSummaryPage: request => pageResponse(request, {
      items: [new Proxy(summary(), {
        getOwnPropertyDescriptor(target, key) {
          assert.equal(['body', 'comments', 'detail', 'rawPayload'].includes(key), false, String(key));
          return Object.getOwnPropertyDescriptor(target, key);
        },
      })],
    }),
  });
  assert.equal((await session.readPage()).status, 'ready');
});

test('detail is explicitly bounded and does not imply full capture or delivery', async t => {
  let original;
  const { session } = harness(t, {
    readRecordDetail(request) {
      original = detailResponse(request, {
        detail: { body: '文'.repeat(12050), comments: Array.from({ length: 80 }, () => ({ author: '甲', text: '评'.repeat(1800) })), truncated: { body: false, comments: false } },
      });
      return original;
    },
  });
  const page = await session.readPage();
  const result = await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
  assert.equal(result.status, 'ready');
  assert.equal(result.detail.body.length, 12000);
  assert.equal(result.detail.comments.length, 50);
  assert.equal(result.detail.comments[0].text.length, 1600);
  assert.deepEqual(result.detail.truncated, { body: true, comments: true });
  assert.equal(Object.isFrozen(original.detail), false);
  assert.equal(Object.isFrozen(original.detail.comments), false);
  assert.equal(Object.hasOwn(result, 'capture'), false);
  assert.equal(Object.hasOwn(result, 'delivery'), false);
  frozenTree(result);
});

test('new page supersedes pending page without waiting for an uncooperative source', async t => {
  const first = deferred();
  let count = 0;
  const { session, calls } = harness(t, {
    readSummaryPage: request => ++count === 1 ? first.promise : pageResponse(request, { snapshotId: 'snapshot-2' }),
  });
  const pending = session.readPage();
  await sourceStarted();
  assert.equal(calls.page.length, 1);
  const next = session.readPage();
  terminal(await pending, 'superseded');
  assert.equal(calls.page[0].signal.aborted, true);
  const current = await next;
  assert.equal(current.status, 'ready');
  first.resolve(pageResponse(calls.page[0]));
  await sourceStarted();
  assert.equal((await session.readDetail({ recordId: 'record-1', pageToken: current.pageToken })).status, 'ready');
  assert.equal(calls.detail[0].snapshotId, 'snapshot-2');
});

test('new page immediately invalidates the old selection before the replacement completes', async t => {
  const replacement = deferred();
  let count = 0;
  const { session, calls } = harness(t, {
    readSummaryPage: request => ++count === 1 ? pageResponse(request) : replacement.promise,
  });
  const old = await session.readPage();
  const pending = session.readPage();
  terminal(await session.readDetail({ recordId: 'record-1', pageToken: old.pageToken }), 'selection_unavailable');
  assert.equal(calls.detail.length, 0);
  session.cancel();
  terminal(await pending, 'cancelled');
});

test('new page supersedes an in-flight detail and ignores its late body', async t => {
  const oldDetail = deferred();
  const { session, calls } = harness(t, { readRecordDetail: () => oldDetail.promise });
  const page = await session.readPage();
  const pending = session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
  await sourceStarted();
  const next = session.readPage();
  terminal(await pending, 'superseded');
  assert.equal(calls.detail[0].signal.aborted, true);
  assert.equal((await next).status, 'ready');
  oldDetail.resolve(detailResponse(calls.detail[0], { detail: { body: 'late private body' } }));
  await sourceStarted();
});

test('new detail supersedes prior detail, even if the earlier source never completes', async t => {
  const pendingDetail = deferred();
  let count = 0;
  const { session, calls } = harness(t, {
    readRecordDetail: request => ++count === 1 ? pendingDetail.promise : detailResponse(request),
  });
  const page = await session.readPage();
  const first = session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
  await sourceStarted();
  const second = session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
  terminal(await first, 'superseded');
  assert.equal((await second).status, 'ready');
  assert.equal(calls.detail[0].signal.aborted, true);
});

test('invalid detail first supersedes an older detail rather than allowing stale data to arrive', async t => {
  const never = deferred();
  const { session } = harness(t, { readRecordDetail: () => never.promise });
  const page = await session.readPage();
  const old = session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
  await sourceStarted();
  terminal(await session.readDetail({ recordId: 'bad id', pageToken: page.pageToken }), 'invalid_request');
  terminal(await old, 'superseded');
});

test('invalid page supersedes an older page and does not call the source again', async t => {
  const never = deferred();
  const { session, calls } = harness(t, { readSummaryPage: () => never.promise });
  const old = session.readPage();
  await sourceStarted();
  terminal(await session.readPage({ limit: -1 }), 'invalid_request');
  terminal(await old, 'superseded');
  assert.equal(calls.page.length, 1);
});

for (const operation of ['cancel', 'close']) {
  test(`${operation} before the source microtask prevents source invocation`, async t => {
    const { session, calls } = harness(t);
    const pending = session.readPage();
    session[operation]();
    terminal(await pending, operation === 'close' ? 'closed' : 'cancelled');
    await sourceStarted();
    assert.equal(calls.page.length, 0);
  });

  test(`${operation} settles an uncooperative pending page locally`, async t => {
    const never = deferred();
    const { session, calls } = harness(t, { readSummaryPage: () => never.promise });
    const pending = session.readPage();
    await sourceStarted();
    session[operation]();
    terminal(await pending, operation === 'close' ? 'closed' : 'cancelled');
    assert.equal(calls.page[0].signal.aborted, true);
  });

  test(`${operation} settles pending detail and revokes selection`, async t => {
    const never = deferred();
    const { session, calls } = harness(t, { readRecordDetail: () => never.promise });
    const page = await session.readPage();
    const pending = session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
    await sourceStarted();
    session[operation]();
    terminal(await pending, operation === 'close' ? 'closed' : 'cancelled');
    assert.equal(calls.detail[0].signal.aborted, true);
    terminal(await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken }), operation === 'close' ? 'closed' : 'selection_unavailable');
  });
}

test('cancel is reusable whereas close is permanent and never invokes source again', async t => {
  const { session, calls } = harness(t);
  session.cancel();
  const fresh = await session.readPage();
  assert.equal(fresh.status, 'ready');
  session.close();
  session.cancel();
  session.close();
  terminal(await session.readPage(), 'closed');
  terminal(await session.readPage({ limit: -1 }), 'closed');
  terminal(await session.readDetail({ recordId: 'record-1', pageToken: fresh.pageToken }), 'closed');
  assert.equal(calls.page.length, 1);
  assert.equal(calls.detail.length, 0);
});

test('pending page times out without retrying, even when the source ignores cancellation', async t => {
  const never = deferred();
  const { session, calls } = harness(t, { timeoutMs: 5, readSummaryPage: () => never.promise });
  terminal(await session.readPage(), 'timed_out');
  assert.equal(calls.page.length, 1);
  assert.equal(calls.page[0].signal.aborted, true);
});

test('pending detail times out without reporting an empty successful detail', async t => {
  const never = deferred();
  const { session, calls } = harness(t, { timeoutMs: 5, readRecordDetail: () => never.promise });
  const page = await session.readPage();
  terminal(await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken }), 'timed_out');
  assert.equal(calls.detail.length, 1);
  assert.equal(calls.detail[0].signal.aborted, true);
});

test('a source rejection arriving after cancellation is handled, not leaked as an unhandled rejection', async t => {
  const delayed = deferred();
  const { session } = harness(t, { readSummaryPage: () => delayed.promise });
  const pending = session.readPage();
  await sourceStarted();
  session.cancel();
  terminal(await pending, 'cancelled');
  delayed.reject(new Error('late private token body'));
  await new Promise(resolve => setImmediate(resolve));
});

for (const failure of ['throw', 'reject']) {
  test(`source ${failure} becomes sanitized read_failed with no automatic retry`, async t => {
    const { session, calls } = harness(t, {
      readSummaryPage() {
        const error = new Error('private tenant credentials and content');
        if (failure === 'throw') throw error;
        return Promise.reject(error);
      },
    });
    terminal(await session.readPage(), 'read_failed');
    assert.equal(calls.page.length, 1);
  });
}

test('detail read rejection stays separate from capture and synchronization state', async t => {
  const { session } = harness(t, { readRecordDetail() { throw new Error('private detail'); } });
  const page = await session.readPage();
  terminal(await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken }), 'read_failed');
  assert.equal(page.page.items[0].capture.key, 'completed');
  assert.equal(page.page.items[0].delivery.key, 'confirmed');
});

for (const field of ['tenantId', 'taskId', 'executionId']) {
  test(`page ${field} mismatch rejects the entire response without exposing rows`, async t => {
    const { session } = harness(t, {
      readSummaryPage: request => pageResponse(request, { scope: { ...request.scope, [field]: 'foreign-private' }, items: [summary('secret-id', { title: 'private body' })] }),
    });
    terminal(await session.readPage(), 'invalid_response');
  });

  test(`detail ${field} mismatch rejects the entire response without exposing content`, async t => {
    const { session } = harness(t, {
      readRecordDetail: request => detailResponse(request, { scope: { ...request.scope, [field]: 'foreign-private' }, detail: { body: 'private body' } }),
    });
    const page = await session.readPage();
    terminal(await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken }), 'invalid_response');
  });
}

for (const override of [{ snapshotId: '' }, { snapshotId: 'bad snapshot' }, { query: { ...QUERY, offset: 1 } },
  { counts: { all: -1, attention: 0, matching: 0 } }, { counts: { all: 1, attention: 2, matching: 1 } },
  { counts: { all: 1, attention: 0, matching: 0 } }, { counts: { all: 1.5, attention: 0, matching: 1 } },
  { items: null }, { items: Array.from({ length: 51 }, (_, index) => summary(`row-${index}`)), counts: { all: 51, attention: 0, matching: 51 } }]) {
  test(`malformed page envelope is never returned as partial ready data (${Object.keys(override).join(',')}:${JSON.stringify(override).slice(0, 100)})`, async t => {
    const { session } = harness(t, { readSummaryPage: request => pageResponse(request, override) });
    terminal(await session.readPage(), 'invalid_response');
  });
}

for (const overrides of [{ snapshotId: 'different-snapshot' }, { recordId: 'another-record' }, { detail: null }]) {
  test(`detail envelope must match the current snapshot and exact record (${Object.keys(overrides)[0]})`, async t => {
    const { session } = harness(t, { readRecordDetail: request => detailResponse(request, overrides) });
    const page = await session.readPage();
    terminal(await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken }), 'invalid_response');
  });
}

test('response envelope getters are not executed or accepted as data', async t => {
  let accessed = 0;
  const { session } = harness(t, {
    readSummaryPage(request) {
      const response = pageResponse(request);
      Object.defineProperty(response, 'scope', { get() { accessed += 1; return SCOPE; } });
      return response;
    },
  });
  terminal(await session.readPage(), 'invalid_response');
  assert.equal(accessed, 0);
});

test('an array element getter is never executed while validating a page', async t => {
  let accessed = 0;
  const { session } = harness(t, {
    readSummaryPage(request) {
      const items = [summary()];
      Object.defineProperty(items, '0', { get() { accessed += 1; return summary(); } });
      return pageResponse(request, { items });
    },
  });
  terminal(await session.readPage(), 'invalid_response');
  assert.equal(accessed, 0);
});

test('revoked proxy response is sanitized without leaking exceptions', async t => {
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  const { session } = harness(t, { readSummaryPage: () => proxy.proxy });
  const result = await session.readPage();
  assert.equal(['invalid_response', 'read_failed'].includes(result.status), true);
  terminal(result, result.status);
});

test('copied, serialized, missing, and foreign-session tokens cannot select detail', async t => {
  const first = harness(t);
  const second = harness(t);
  const page = await first.session.readPage();
  await second.session.readPage();
  for (const fake of [undefined, null, {}, { ...page.pageToken }, JSON.parse(JSON.stringify(page.pageToken))]) {
    terminal(await first.session.readDetail({ recordId: 'record-1', pageToken: fake }), 'selection_unavailable');
  }
  terminal(await second.session.readDetail({ recordId: 'record-1', pageToken: page.pageToken }), 'selection_unavailable');
  assert.equal(first.calls.detail.length, 0);
  assert.equal(second.calls.detail.length, 0);
});

test('closing one execution then creating another does not transfer a token or record authority', async t => {
  const old = harness(t);
  const oldPage = await old.session.readPage();
  old.session.close();
  const current = harness(t, { scope: { ...SCOPE, executionId: 'execution-2' } });
  const currentPage = await current.session.readPage();
  terminal(await current.session.readDetail({ recordId: 'record-1', pageToken: oldPage.pageToken }), 'selection_unavailable');
  assert.equal((await current.session.readDetail({ recordId: 'record-1', pageToken: currentPage.pageToken })).status, 'ready');
  assert.equal(current.calls.detail[0].scope.executionId, 'execution-2');
});

test('duplicate exact IDs remain visible but are not selectable', async t => {
  const { session, calls } = harness(t, {
    readSummaryPage: request => pageResponse(request, { items: [summary(), summary()], counts: { all: 2, attention: 0, matching: 2 } }),
  });
  const page = await session.readPage();
  assert.equal(page.status, 'ready');
  assert.equal(page.page.items.length, 2);
  terminal(await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken }), 'selection_unavailable');
  assert.equal(calls.detail.length, 0);
});

test('IDs outside the visible authorized page are unavailable even if syntactically valid', async t => {
  const { session, calls } = harness(t);
  const page = await session.readPage();
  terminal(await session.readDetail({ recordId: 'record-2', pageToken: page.pageToken }), 'selection_unavailable');
  assert.equal(calls.detail.length, 0);
});

for (const id of ['', 'record 1', 'record-1\n', 'x'.repeat(129), '\u202Esecret', '\uD800', 1]) {
  test(`invalid record identifier is neither normalized nor sent to detail source (${JSON.stringify(id)})`, async t => {
    const { session, calls } = harness(t);
    const page = await session.readPage();
    terminal(await session.readDetail({ recordId: id, pageToken: page.pageToken }), 'invalid_request');
    assert.equal(calls.detail.length, 0);
  });
}

test('detail identifier getter is not executed', async t => {
  const { session, calls } = harness(t);
  const page = await session.readPage();
  let accessed = 0;
  terminal(await session.readDetail({ pageToken: page.pageToken, get recordId() { accessed += 1; return 'record-1'; } }), 'invalid_request');
  assert.equal(accessed, 0);
  assert.equal(calls.detail.length, 0);
});

test('detail request is snapshotted before the source microtask', async t => {
  const { session, calls } = harness(t);
  const page = await session.readPage();
  const selection = { recordId: 'record-1', pageToken: page.pageToken };
  const pending = session.readDetail(selection);
  selection.recordId = 'record-2';
  selection.pageToken = {};
  assert.equal((await pending).status, 'ready');
  assert.equal(calls.detail[0].recordId, 'record-1');
  assert.equal(Object.isFrozen(selection), false);
});

test('an already settled page result is no longer current after a new page begins', async t => {
  const replacement = deferred();
  let count = 0;
  const { session } = harness(t, {
    readSummaryPage: request => ++count === 1 ? pageResponse(request) : replacement.promise,
  });
  const old = await session.readPage();
  assert.equal(session.isCurrent(old.requestToken), true);
  const pending = session.readPage();
  assert.equal(session.isCurrent(old.requestToken), false);
  session.cancel();
  const cancelled = await pending;
  terminal(cancelled, 'cancelled');
  assert.equal(session.isCurrent(cancelled.requestToken), false);
});

test('new detail invalidates only the previous detail request token, not the ready page token', async t => {
  const { session } = harness(t);
  const page = await session.readPage();
  const first = await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
  assert.equal(session.isCurrent(first.requestToken), true);
  const second = await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
  assert.equal(session.isCurrent(first.requestToken), false);
  assert.equal(session.isCurrent(second.requestToken), true);
  assert.equal(session.isCurrent(page.requestToken), true);
  assert.equal(session.isCurrent(page.pageToken), false);
  await session.readPage();
  assert.equal(session.isCurrent(second.requestToken), false);
  assert.equal(session.isCurrent(page.requestToken), false);
});

test('a settled error token protects consumers against applying an obsolete failure after refresh', async t => {
  let count = 0;
  const { session } = harness(t, {
    readSummaryPage(request) {
      if (++count === 1) throw new Error('old private read error');
      return pageResponse(request);
    },
  });
  const failure = await session.readPage();
  terminal(failure, 'read_failed');
  assert.equal(session.isCurrent(failure.requestToken), true);
  const replacement = await session.readPage();
  assert.equal(replacement.status, 'ready');
  assert.equal(session.isCurrent(failure.requestToken), false);
  assert.equal(session.isCurrent(replacement.requestToken), true);
});

for (const operation of ['cancel', 'close']) {
  test(`${operation} revokes even already settled page and detail request tokens`, async t => {
    const { session } = harness(t);
    const page = await session.readPage();
    const detail = await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
    assert.equal(session.isCurrent(page.requestToken), true);
    assert.equal(session.isCurrent(detail.requestToken), true);
    session[operation]();
    assert.equal(session.isCurrent(page.requestToken), false);
    assert.equal(session.isCurrent(detail.requestToken), false);
  });
}

test('request-token identity is not forgeable or transferable between sessions', async t => {
  const first = harness(t);
  const second = harness(t);
  const page = await first.session.readPage();
  await second.session.readPage();
  for (const token of [undefined, null, {}, { ...page.requestToken }, JSON.parse(JSON.stringify(page.requestToken)), page.pageToken]) {
    assert.equal(first.session.isCurrent(token), false);
  }
  assert.equal(second.session.isCurrent(page.requestToken), false);
});

test('a page read reentered from an abort listener supersedes the outer replacement without leaving a request pending', async t => {
  const never = deferred();
  let session;
  let nested;
  let sourceCalls = 0;
  const context = harness(t, {
    timeoutMs: 100,
    readSummaryPage(request) {
      sourceCalls += 1;
      if (sourceCalls === 1) {
        request.signal.addEventListener('abort', () => { nested = session.readPage(); }, { once: true });
        return never.promise;
      }
      return pageResponse(request, { snapshotId: 'nested-current' });
    },
  });
  session = context.session;
  const old = session.readPage();
  await sourceStarted();
  const outer = session.readPage();
  assert.ok(nested);
  terminal(await old, 'superseded');
  terminal(await outer, 'superseded');
  const current = await nested;
  assert.equal(current.status, 'ready');
  assert.equal(session.isCurrent(current.requestToken), true);
  assert.equal(sourceCalls, 2);
});

test('cancellation reentered from a response descriptor trap cannot publish partially decoded data', async t => {
  let session;
  const context = harness(t, {
    readSummaryPage(request) {
      return new Proxy(pageResponse(request), {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'scope') session.cancel();
          return Object.getOwnPropertyDescriptor(target, key);
        },
      });
    },
  });
  session = context.session;
  const result = await session.readPage();
  terminal(result, 'cancelled');
  assert.equal(session.isCurrent(result.requestToken), false);
});

test('a reentrant detail read becomes current without allowing the outer replacement to invoke its source', async t => {
  const never = deferred();
  let session;
  let selection;
  let nested;
  let sourceCalls = 0;
  const context = harness(t, {
    timeoutMs: 100,
    readRecordDetail(request) {
      sourceCalls += 1;
      if (sourceCalls === 1) {
        request.signal.addEventListener('abort', () => { nested = session.readDetail(selection); }, { once: true });
        return never.promise;
      }
      return detailResponse(request);
    },
  });
  session = context.session;
  const page = await session.readPage();
  selection = { recordId: 'record-1', pageToken: page.pageToken };
  const old = session.readDetail(selection);
  await sourceStarted();
  const outer = session.readDetail(selection);
  assert.ok(nested);
  terminal(await old, 'superseded');
  terminal(await outer, 'superseded');
  const current = await nested;
  assert.equal(current.status, 'ready');
  assert.equal(session.isCurrent(current.requestToken), true);
  assert.equal(session.isCurrent(page.requestToken), true);
  assert.equal(sourceCalls, 2);
});

for (const operation of ['readPage', 'cancel', 'close']) {
  test(`${operation} handles a detail abort listener that synchronously starts a new page`, async t => {
    const never = deferred();
    let session;
    let nested;
    const context = harness(t, {
      timeoutMs: 100,
      readRecordDetail(request) {
        request.signal.addEventListener('abort', () => { nested = session.readPage(); }, { once: true });
        return never.promise;
      },
    });
    session = context.session;
    const page = await session.readPage();
    const detail = session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
    await sourceStarted();
    const outer = session[operation]();
    assert.ok(nested);
    terminal(await detail, operation === 'readPage' ? 'superseded' : operation === 'close' ? 'closed' : 'cancelled');
    assert.equal(session.isCurrent(page.requestToken), false);
    if (operation === 'readPage') terminal(await outer, 'superseded');
    const current = await nested;
    if (operation === 'close') {
      terminal(current, 'closed');
      assert.equal(session.isCurrent(current.requestToken), false);
      assert.equal(context.calls.page.length, 1);
    } else {
      assert.equal(current.status, 'ready');
      assert.equal(session.isCurrent(current.requestToken), true);
      assert.equal(context.calls.page.length, 2);
    }
    assert.equal(context.calls.detail.length, 1);
  });
}

test('factory accepts maximal scope tokens and paired Unicode without normalizing them', t => {
  const scope = { tenantId: 't'.repeat(240), taskId: '任务-😀', executionId: '运行-2' };
  const { session } = harness(t, { scope });
  assert.equal(typeof session.readPage, 'function');
});

test('factory rejects invalid scope, timeout, and source with fixed non-sensitive TypeError text', () => {
  const source = { readSummaryPage() {}, readRecordDetail() {} };
  const valid = { scope: { ...SCOPE }, source };
  const invalid = [];
  for (const key of Object.keys(SCOPE)) {
    for (const value of ['', 'private space', '\u0001secret', '\u0085secret', '\u2066secret', '\uD800', 'x'.repeat(241), 123]) {
      invalid.push({ ...valid, scope: { ...SCOPE, [key]: value } });
    }
  }
  for (const timeoutMs of [0, -1, 0.5, 30001, '5', null, NaN, Infinity]) invalid.push({ ...valid, timeoutMs });
  invalid.push(null, [], {}, { ...valid, source: {} }, { ...valid, source: Object.create(source) });
  let message;
  for (const config of invalid) {
    assert.throws(() => createResultReadSession(config), error => {
      assert.equal(error instanceof TypeError, true);
      if (message === undefined) message = error.message;
      assert.equal(error.message, message);
      assert.equal(/secret|private|tenant-甲/u.test(error.message), false);
      return true;
    });
  }
});

test('factory never invokes source or scope property accessors', () => {
  let accessed = 0;
  const good = { readSummaryPage() {}, readRecordDetail() {} };
  const getterSource = { readRecordDetail() {}, get readSummaryPage() { accessed += 1; return () => {}; } };
  const getterScope = { ...SCOPE };
  Object.defineProperty(getterScope, 'taskId', { get() { accessed += 1; return 'task-1'; } });
  assert.throws(() => createResultReadSession({ scope: { ...SCOPE }, source: getterSource }), TypeError);
  assert.throws(() => createResultReadSession({ scope: getterScope, source: good }), TypeError);
  assert.equal(accessed, 0);
});
