import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshotResultSource } from '../../extension-ui/application/snapshot-result-source.mjs';
import { createResultReadSession } from '../../extension-ui/application/result-read-session.mjs';

const SCOPE = Object.freeze({ tenantId: 'synthetic-tenant', taskId: 'synthetic-task', executionId: 'synthetic-execution' });
const QUERY = Object.freeze({ filter: 'all', offset: 0, limit: 50 });

function summary(id = 'record-1', attention = false) {
  return {
    id, title: '人工测试标题', author: '人工作者', platform: 'xiaohongshu', kind: 'note', summary: '轻量摘要',
    likes: 12, commentsCount: 0, capture: { status: attention ? 'unknown' : 'completed' },
    delivery: { remote: attention ? 'unknown' : 'confirmed', local: attention ? 'unknown' : 'confirmed' },
  };
}

function manifest(entries = [{ recordId: 'record-1', recordVersion: 'version-1', summary: summary() }], scope = SCOPE) {
  return { scope: { ...scope }, snapshotId: 'snapshot-1', recordNamespace: 'client_record', entries };
}

function grant(request, overrides = {}) {
  return { allowed: true, scope: { ...request.scope }, snapshotId: request.snapshotId, recordNamespace: request.recordNamespace, accessRevision: 'access-1', expiresAt: 10000, ...overrides };
}

function loaded(request, overrides = {}) {
  return {
    scope: { ...request.scope }, snapshotId: request.snapshotId, recordNamespace: request.recordNamespace, recordId: request.recordId, recordVersion: request.recordVersion,
    detail: { body: '人工正文', comments: [{ author: '读者', text: '人工评论' }], truncated: { body: false, comments: false } },
    ...overrides,
  };
}

function pageRequest(overrides = {}) {
  return { scope: { ...SCOPE }, query: { ...QUERY }, signal: new AbortController().signal, ...overrides };
}

function detailRequest(overrides = {}) {
  return { scope: { ...SCOPE }, snapshotId: 'snapshot-1', recordId: 'record-1', signal: new AbortController().signal, ...overrides };
}

function harness(t, options = {}) {
  const calls = { authorize: [], detail: [] };
  const input = options.manifest ?? manifest();
  const authorize = request => {
    calls.authorize.push(request);
    return options.authorize ? options.authorize(request, calls.authorize.length) : grant(request);
  };
  const loadDetail = request => {
    calls.detail.push(request);
    return options.loadDetail ? options.loadDetail(request) : loaded(request);
  };
  const source = createSnapshotResultSource({ manifest: input, authorize, loadDetail, now: options.now ?? (() => 1000) });
  t.after(() => source.close());
  return { source, calls, input };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function unavailable(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, 'Result read unavailable');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(Object.hasOwn(error, 'detail'), false);
    assert.equal(Object.hasOwn(error, 'grant'), false);
    assert.equal(Object.hasOwn(error, 'scope'), false);
    return true;
  });
}

function frozenTree(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (Object.hasOwn(descriptor, 'value')) frozenTree(descriptor.value);
  }
}

test('snapshot source exposes a frozen read-only capability surface', t => {
  const { source } = harness(t);
  assert.deepEqual(Object.keys(source).sort(), ['close', 'readRecordDetail', 'readSummaryPage']);
  assert.equal(Object.isFrozen(source), true);
  for (const value of Object.values(source)) assert.equal(typeof value, 'function');
});

test('page read authorizes before and after returning a bounded snapshot envelope', async t => {
  const { source, calls } = harness(t);
  const result = await source.readSummaryPage(pageRequest());
  assert.deepEqual(result.scope, SCOPE);
  assert.equal(result.snapshotId, 'snapshot-1');
  assert.deepEqual(result.query, QUERY);
  assert.deepEqual(result.counts, { all: 1, attention: 0, matching: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'record-1');
  assert.equal(result.items[0].title, '人工测试标题');
  assert.equal(calls.authorize.length, 2);
  assert.equal(calls.detail.length, 0);
  for (const request of calls.authorize) {
    assert.deepEqual(Object.keys(request).sort(), ['recordNamespace', 'scope', 'signal', 'snapshotId']);
    assert.deepEqual(request.scope, SCOPE);
    assert.equal(request.snapshotId, 'snapshot-1');
    assert.equal(request.recordNamespace, 'client_record');
    assert.equal(request.signal instanceof AbortSignal, true);
  }
  assert.equal(Object.hasOwn(result, 'accessRevision'), false);
  assert.equal(Object.hasOwn(result, 'expiresAt'), false);
  frozenTree(result);
});

test('detail reads precisely the manifest record version between independent authorization checks', async t => {
  const events = [];
  const { source, calls } = harness(t, {
    authorize(request) { events.push('authorize'); return grant(request); },
    loadDetail(request) { events.push('loadDetail'); return loaded(request); },
  });
  const result = await source.readRecordDetail(detailRequest());
  assert.deepEqual(events, ['authorize', 'loadDetail', 'authorize']);
  assert.deepEqual(Object.keys(calls.detail[0]).sort(), ['recordId', 'recordNamespace', 'recordVersion', 'scope', 'signal', 'snapshotId']);
  assert.equal(calls.detail[0].recordVersion, 'version-1');
  assert.equal(calls.detail[0].recordId, 'record-1');
  assert.equal(result.recordId, 'record-1');
  assert.equal(result.detail.body, '人工正文');
  assert.deepEqual(Object.keys(result).sort(), ['detail', 'recordId', 'recordNamespace', 'scope', 'snapshotId']);
  frozenTree(result);
});

test('every read obtains fresh permissions rather than caching an earlier allow', async t => {
  const { source, calls } = harness(t, { authorize: (request, count) => count <= 2 ? grant(request) : { allowed: false } });
  await source.readSummaryPage(pageRequest());
  await unavailable(source.readSummaryPage(pageRequest()));
  await unavailable(source.readRecordDetail(detailRequest()));
  assert.equal(calls.authorize.length, 4);
  assert.equal(calls.detail.length, 0);
});

test('catalog pagination and attention counts cover the full immutable manifest, not just the page', async t => {
  const entries = Array.from({ length: 121 }, (_, index) => ({
    recordId: `record-${index}`, recordVersion: `version-${index}`, summary: summary(`record-${index}`, index % 2 === 0),
  }));
  const { source } = harness(t, { manifest: manifest(entries) });
  const all = await source.readSummaryPage(pageRequest({ query: { filter: 'all', offset: 50, limit: 2 } }));
  assert.deepEqual(all.items.map(item => item.id), ['record-50', 'record-51']);
  assert.deepEqual(all.counts, { all: 121, attention: 61, matching: 121 });
  const attention = await source.readSummaryPage(pageRequest({ query: { filter: 'attention', offset: 50, limit: 2 } }));
  assert.deepEqual(attention.items.map(item => item.id), ['record-100', 'record-102']);
  assert.deepEqual(attention.counts, { all: 121, attention: 61, matching: 61 });
});

test('an authorized empty manifest returns a successful empty page after two grant checks', async t => {
  const { source, calls } = harness(t, { manifest: manifest([]) });
  const result = await source.readSummaryPage(pageRequest());
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.counts, { all: 0, attention: 0, matching: 0 });
  assert.equal(calls.authorize.length, 2);
});

test('historical synced fields do not upgrade unknown capture or delivery into confirmed success', async t => {
  const entry = { recordId: 'record-1', recordVersion: 'version-1', summary: { ...summary('record-1', true), status: 'synced', lastSyncedAt: 900 } };
  const { source } = harness(t, { manifest: manifest([entry]) });
  const session = createResultReadSession({ scope: SCOPE, source });
  t.after(() => session.close());
  const result = await session.readPage();
  assert.equal(result.status, 'ready');
  assert.equal(result.page.items[0].capture.key, 'unknown');
  assert.notEqual(result.page.items[0].delivery.key, 'confirmed');
  assert.equal(result.page.items[0].needsAttention, true);
});

for (const denied of [false, null, {}, { allowed: false }, { allowed: 'true' },
  { allowed: true }, { allowed: true, scope: SCOPE, snapshotId: 'snapshot-1', recordNamespace: 'client_record', accessRevision: 'access-1', expiresAt: 1000 },
  { allowed: true, scope: SCOPE, snapshotId: 'snapshot-1', recordNamespace: 'client_record', accessRevision: 'access-1', expiresAt: 999 },
  { allowed: true, scope: SCOPE, snapshotId: 'snapshot-1', recordNamespace: 'client_record', accessRevision: 'bad revision', expiresAt: 10000 }]) {
  test(`preauthorization rejects malformed or denied grants without loading detail (${JSON.stringify(denied)})`, async t => {
    const { source, calls } = harness(t, { authorize: () => denied });
    await unavailable(source.readRecordDetail(detailRequest()));
    await unavailable(source.readSummaryPage(pageRequest()));
    assert.equal(calls.detail.length, 0);
    assert.equal(calls.authorize.length, 2);
  });
}

for (const reason of ['deny', 'throw', 'reject']) {
  test(`postauthorization ${reason} prevents release of previously loaded body`, async t => {
    const { source, calls } = harness(t, {
      authorize(request, count) {
        if (count === 1) return grant(request);
        if (reason === 'throw') throw new Error('private credentials from authorization');
        if (reason === 'reject') return Promise.reject(new Error('private credentials from authorization'));
        return { allowed: false };
      },
    });
    await unavailable(source.readRecordDetail(detailRequest()));
    assert.equal(calls.detail.length, 1);
    assert.equal(calls.authorize.length, 2);
  });
}

test('page postauthorization rejection is never downgraded to an empty successful page', async t => {
  const { source, calls } = harness(t, { authorize: (request, count) => count === 1 ? grant(request) : { allowed: false } });
  await unavailable(source.readSummaryPage(pageRequest()));
  assert.equal(calls.authorize.length, 2);
});

test('access revision changes during detail loading discard the old account response', async t => {
  const { source, calls } = harness(t, {
    authorize: (request, count) => grant(request, { accessRevision: count === 1 ? 'account-before-switch' : 'account-after-switch' }),
  });
  await unavailable(source.readRecordDetail(detailRequest()));
  assert.equal(calls.detail.length, 1);
});

test('page access revision must match between authorization checks even when the scopes match', async t => {
  const { source } = harness(t, { authorize: (request, count) => grant(request, { accessRevision: `access-${count}` }) });
  await unavailable(source.readSummaryPage(pageRequest()));
});

for (const phase of ['before', 'after']) {
  for (const field of ['tenantId', 'taskId', 'executionId', 'snapshotId']) {
    test(`${phase} grant ${field} mismatch rejects access without returning bound records`, async t => {
      const { source, calls } = harness(t, {
        authorize(request, count) {
          const mismatch = phase === 'before' ? count === 1 : count === 2;
          return grant(request, !mismatch ? {} : field === 'snapshotId'
            ? { snapshotId: 'foreign-snapshot' } : { scope: { ...SCOPE, [field]: 'foreign-private-scope' } });
        },
      });
      await unavailable(source.readRecordDetail(detailRequest()));
      assert.equal(calls.detail.length, phase === 'before' ? 0 : 1);
    });
  }
}

test('the original permission must still be valid after loading even if the second permission extends expiry', async t => {
  let time = 1000;
  const { source } = harness(t, {
    now: () => time,
    authorize(request, count) {
      if (count === 1) return grant(request, { expiresAt: 1100 });
      time = 1200;
      return grant(request, { expiresAt: 10000 });
    },
  });
  await unavailable(source.readRecordDetail(detailRequest()));
});

test('the final permission is checked at publication time rather than only at creation', async t => {
  let time = 1000;
  const { source } = harness(t, {
    now: () => time,
    authorize(request, count) {
      if (count === 1) return grant(request, { expiresAt: 10000 });
      time = 1200;
      return grant(request, { expiresAt: 1200 });
    },
  });
  await unavailable(source.readRecordDetail(detailRequest()));
});

test('same revision grants with different still-future expiry remain valid', async t => {
  const { source } = harness(t, { authorize: (request, count) => grant(request, { expiresAt: count === 1 ? 2000 : 3000 }) });
  assert.equal((await source.readRecordDetail(detailRequest())).detail.body, '人工正文');
});

test('default clock supports real future grants without requiring caller clock injection', async t => {
  const source = createSnapshotResultSource({
    manifest: manifest(), authorize: request => grant(request, { expiresAt: Date.now() + 60000 }), loadDetail: loaded,
  });
  t.after(() => source.close());
  assert.equal((await source.readSummaryPage(pageRequest())).items.length, 1);
});

for (const value of [NaN, Infinity, -1, '1000', null]) {
  test(`invalid current clock value never grants access (${String(value)})`, async t => {
    const { source, calls } = harness(t, { now: () => value });
    await unavailable(source.readRecordDetail(detailRequest()));
    assert.equal(calls.detail.length, 0);
  });
}

test('a clock exception is sanitized just like an authorization exception', async t => {
  const { source } = harness(t, { now() { throw new Error('private clock environment'); } });
  await unavailable(source.readSummaryPage(pageRequest()));
});

for (const override of [{ scope: { ...SCOPE, tenantId: 'foreign-tenant' } }, { scope: { ...SCOPE, taskId: 'foreign-task' } },
  { scope: { ...SCOPE, executionId: 'foreign-execution' } }, { snapshotId: 'latest-snapshot' }, { recordId: 'another-record' },
  { recordVersion: 'latest-version' }, { recordVersion: '' }, { detail: null }]) {
  test(`detail loader binding errors never trigger fallback to a newer record (${JSON.stringify(override)})`, async t => {
    const { source, calls } = harness(t, { loadDetail: request => loaded(request, override) });
    await unavailable(source.readRecordDetail(detailRequest()));
    assert.equal(calls.detail.length, 1);
  });
}

for (const reason of ['throw', 'reject']) {
  test(`detail loader ${reason} is sanitized without retry or successful empty body`, async t => {
    const { source, calls } = harness(t, {
      loadDetail() {
        const error = new Error('private database location and body');
        if (reason === 'throw') throw error;
        return Promise.reject(error);
      },
    });
    await unavailable(source.readRecordDetail(detailRequest()));
    assert.equal(calls.detail.length, 1);
  });
}

test('detail content is bounded and detached without freezing the loader payload', async t => {
  let original;
  const { source } = harness(t, {
    loadDetail(request) {
      original = loaded(request, { detail: { body: '文'.repeat(13000), comments: Array.from({ length: 60 }, () => ({ author: '评者', text: '评'.repeat(1700) })), truncated: { body: false, comments: false } } });
      return original;
    },
  });
  const result = await source.readRecordDetail(detailRequest());
  assert.equal(result.detail.body.length, 12000);
  assert.equal(result.detail.comments.length, 50);
  assert.equal(result.detail.comments[0].text.length, 1600);
  assert.deepEqual(result.detail.truncated, { body: true, comments: true });
  assert.equal(Object.isFrozen(original), false);
  assert.equal(Object.isFrozen(original.detail.comments), false);
  original.detail.body = 'changed';
  assert.notEqual(result.detail.body, original.detail.body);
  frozenTree(result);
});

test('manifest and nested summaries are copied once without freezing caller-owned inputs', async t => {
  const input = manifest();
  const { source, calls } = harness(t, { manifest: input });
  input.scope.tenantId = 'later-tenant';
  input.snapshotId = 'later-snapshot';
  input.entries[0].recordVersion = 'later-version';
  input.entries[0].summary.title = 'later title';
  input.entries[0].summary.capture.status = 'failed';
  input.entries.push({ recordId: 'record-2', recordVersion: 'version-2', summary: summary('record-2') });
  const page = await source.readSummaryPage(pageRequest());
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].title, '人工测试标题');
  assert.equal(page.snapshotId, 'snapshot-1');
  await source.readRecordDetail(detailRequest());
  assert.equal(calls.detail[0].recordVersion, 'version-1');
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.entries), false);
  assert.equal(Object.isFrozen(input.entries[0].summary.capture), false);
});

test('lightweight catalog setup and page reads never inspect heavy body or comments properties', async t => {
  const watched = new Proxy(summary(), {
    getOwnPropertyDescriptor(target, key) {
      assert.equal(['body', 'comments', 'detail', 'rawPayload'].includes(key), false, String(key));
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const { source } = harness(t, { manifest: manifest([{ recordId: 'record-1', recordVersion: 'version-1', summary: watched }]) });
  assert.equal((await source.readSummaryPage(pageRequest())).items.length, 1);
});

test('queued requests snapshot query and scope before later caller mutation', async t => {
  const waiting = deferred();
  const { source, calls } = harness(t, { authorize: (request, count) => count === 1 ? waiting.promise : grant(request) });
  const request = pageRequest();
  const pending = source.readSummaryPage(request);
  request.scope.executionId = 'later-execution';
  request.query.limit = 1;
  await tick();
  waiting.resolve(grant(calls.authorize[0]));
  const result = await pending;
  assert.deepEqual(result.scope, SCOPE);
  assert.deepEqual(result.query, QUERY);
  assert.equal(Object.isFrozen(request), false);
  assert.equal(Object.isFrozen(request.scope), false);
});

test('grant property accessors are never executed or accepted as permission evidence', async t => {
  let reads = 0;
  const { source, calls } = harness(t, {
    authorize(request) {
      const value = grant(request);
      Object.defineProperty(value, 'allowed', { get() { reads += 1; return true; } });
      return value;
    },
  });
  await unavailable(source.readRecordDetail(detailRequest()));
  assert.equal(reads, 0);
  assert.equal(calls.detail.length, 0);
});

test('detail loader binding getters are never executed', async t => {
  let reads = 0;
  const { source } = harness(t, {
    loadDetail(request) {
      const value = loaded(request);
      Object.defineProperty(value, 'recordVersion', { get() { reads += 1; return 'version-1'; } });
      return value;
    },
  });
  await unavailable(source.readRecordDetail(detailRequest()));
  assert.equal(reads, 0);
});

test('request scope accessors are rejected without executing caller code or authorization', async t => {
  let reads = 0;
  const { source, calls } = harness(t);
  const request = pageRequest();
  Object.defineProperty(request, 'scope', { get() { reads += 1; return SCOPE; } });
  await unavailable(source.readSummaryPage(request));
  assert.equal(reads, 0);
  assert.equal(calls.authorize.length, 0);
});

for (const request of [null, {}, pageRequest({ signal: undefined }), pageRequest({ signal: {} }),
  pageRequest({ scope: { ...SCOPE, tenantId: 'foreign-tenant' } }), pageRequest({ query: { limit: 51 } })]) {
  test(`invalid or unbound page request never invokes authorization (${JSON.stringify(request)})`, async t => {
    const { source, calls } = harness(t);
    await unavailable(source.readSummaryPage(request));
    assert.equal(calls.authorize.length, 0);
  });
}

for (const override of [{ recordId: 'unknown-record' }, { recordId: 'record 1' }, { snapshotId: 'snapshot-latest' },
  { scope: { ...SCOPE, executionId: 'foreign-execution' } }, { signal: {} }]) {
  test(`detail selection must bind to this catalog before loading (${JSON.stringify(override)})`, async t => {
    const { source, calls } = harness(t);
    await unavailable(source.readRecordDetail(detailRequest(override)));
    assert.equal(calls.detail.length, 0);
  });
}

for (const stage of ['authorize', 'detail', 'reauthorize']) {
  test(`external abort locally rejects a pending ${stage} that ignores its signal`, async t => {
    const waiting = deferred();
    const controller = new AbortController();
    const { source, calls } = harness(t, {
      authorize: (request, count) => (stage === 'authorize' && count === 1) || (stage === 'reauthorize' && count === 2) ? waiting.promise : grant(request),
      loadDetail: request => stage === 'detail' ? waiting.promise : loaded(request),
    });
    const pending = source.readRecordDetail(detailRequest({ signal: controller.signal }));
    await tick();
    assert.equal(calls.authorize.length, stage === 'reauthorize' ? 2 : 1);
    assert.equal(calls.detail.length, stage === 'authorize' ? 0 : 1);
    controller.abort();
    await unavailable(pending);
    for (const request of [...calls.authorize, ...calls.detail]) assert.equal(request.signal.aborted, true);
    waiting.reject(new Error('late private rejected response'));
    await new Promise(resolve => setImmediate(resolve));
  });
}

for (const stage of ['authorize', 'detail', 'reauthorize']) {
  test(`close locally rejects a pending ${stage} and prevents any subsequent reads`, async t => {
    const waiting = deferred();
    const { source, calls } = harness(t, {
      authorize: (request, count) => (stage === 'authorize' && count === 1) || (stage === 'reauthorize' && count === 2) ? waiting.promise : grant(request),
      loadDetail: request => stage === 'detail' ? waiting.promise : loaded(request),
    });
    const pending = source.readRecordDetail(detailRequest());
    await tick();
    assert.equal(calls.authorize.length, stage === 'reauthorize' ? 2 : 1);
    assert.equal(calls.detail.length, stage === 'authorize' ? 0 : 1);
    source.close();
    await unavailable(pending);
    const authorizeCount = calls.authorize.length;
    const loadCount = calls.detail.length;
    await unavailable(source.readSummaryPage(pageRequest()));
    await unavailable(source.readRecordDetail(detailRequest()));
    assert.equal(calls.authorize.length, authorizeCount);
    assert.equal(calls.detail.length, loadCount);
    for (const request of [...calls.authorize, ...calls.detail]) assert.equal(request.signal.aborted, true);
    source.close();
    waiting.resolve({ secret: 'late private content' });
    await tick();
  });
}

test('already aborted requests reject without authorization or body loading', async t => {
  const controller = new AbortController();
  controller.abort();
  const { source, calls } = harness(t);
  await unavailable(source.readSummaryPage(pageRequest({ signal: controller.signal })));
  await unavailable(source.readRecordDetail(detailRequest({ signal: controller.signal })));
  assert.equal(calls.authorize.length, 0);
  assert.equal(calls.detail.length, 0);
});

test('closing cancels several concurrent sources locally even when every authorization promise is pending', async t => {
  const never = deferred();
  const { source } = harness(t, { authorize: () => never.promise });
  const page = source.readSummaryPage(pageRequest());
  const detail = source.readRecordDetail(detailRequest());
  await tick();
  source.close();
  await Promise.all([unavailable(page), unavailable(detail)]);
});

test('closing reentrantly inside authorization does not invoke the loader or release a page', async t => {
  let source;
  const context = harness(t, { authorize(request) { source.close(); return grant(request); } });
  source = context.source;
  await unavailable(source.readRecordDetail(detailRequest()));
  assert.equal(context.calls.detail.length, 0);
});

test('a delayed old-account body is discarded after authorization changes while loading', async t => {
  const delayed = deferred();
  let revision = 'before-switch';
  const { source, calls } = harness(t, {
    authorize: request => grant(request, { accessRevision: revision }), loadDetail: () => delayed.promise,
  });
  const pending = source.readRecordDetail(detailRequest());
  await tick();
  revision = 'after-switch';
  delayed.resolve(loaded(calls.detail[0]));
  await unavailable(pending);
  assert.equal(calls.detail.length, 1);
  assert.equal(calls.authorize.length, 2);
});

test('real U2 session consumes an authorized page and version-bound detail then closes safely', async t => {
  const { source, calls } = harness(t);
  const session = createResultReadSession({ scope: SCOPE, source, timeoutMs: 1000 });
  t.after(() => session.close());
  const page = await session.readPage();
  assert.equal(page.status, 'ready');
  assert.equal(page.page.items[0].title, '人工测试标题');
  const detail = await session.readDetail({ recordId: 'record-1', pageToken: page.pageToken });
  assert.equal(detail.status, 'ready');
  assert.equal(detail.detail.body, '人工正文');
  assert.equal(calls.authorize.length, 4);
  session.close();
  source.close();
  assert.equal(session.isCurrent(page.requestToken), false);
  assert.equal((await session.readPage()).status, 'closed');
});

test('closing the U3 source while U2 waits gives a sanitized failure, not a successful empty list', async t => {
  const never = deferred();
  const { source } = harness(t, { authorize: () => never.promise });
  const session = createResultReadSession({ scope: SCOPE, source, timeoutMs: 1000 });
  t.after(() => session.close());
  const pending = session.readPage();
  await tick();
  source.close();
  const result = await pending;
  assert.equal(result.status, 'read_failed');
  assert.deepEqual(Object.keys(result).sort(), ['requestToken', 'status']);
});

test('same record ID across different scoped catalogs cannot reuse another session selection token', async t => {
  const first = harness(t);
  const otherScope = { ...SCOPE, tenantId: 'another-tenant', executionId: 'another-execution' };
  const second = harness(t, { manifest: manifest(undefined, otherScope) });
  const a = createResultReadSession({ scope: SCOPE, source: first.source });
  const b = createResultReadSession({ scope: otherScope, source: second.source });
  t.after(() => { a.close(); b.close(); });
  const firstPage = await a.readPage();
  const secondPage = await b.readPage();
  assert.equal(secondPage.status, 'ready');
  assert.equal((await b.readDetail({ recordId: 'record-1', pageToken: firstPage.pageToken })).status, 'selection_unavailable');
  assert.equal(second.calls.detail.length, 0);
  assert.equal((await b.readDetail({ recordId: 'record-1', pageToken: secondPage.pageToken })).status, 'ready');
  assert.deepEqual(second.calls.detail[0].scope, otherScope);
});

for (const namespace of ['client_record', 'server_record']) {
  test(`the ${namespace} namespace reaches authorization and loader unchanged`, async t => {
    const { source, calls } = harness(t, { manifest: { ...manifest(), recordNamespace: namespace } });
    const page = await source.readSummaryPage(pageRequest());
    const detail = await source.readRecordDetail(detailRequest());
    assert.equal(page.recordNamespace, namespace);
    assert.equal(detail.recordNamespace, namespace);
    for (const request of [...calls.authorize, ...calls.detail]) assert.equal(request.recordNamespace, namespace);
  });
}

for (const phase of ['before', 'after', 'loader']) {
  test(`client/server identity collision is rejected at ${phase} even when ID, scope, snapshot and version all match`, async t => {
    const { source, calls } = harness(t, {
      authorize: (request, count) => grant(request,
        (phase === 'before' && count === 1) || (phase === 'after' && count === 2) ? { recordNamespace: 'server_record' } : {}),
      loadDetail: request => loaded(request, phase === 'loader' ? { recordNamespace: 'server_record' } : {}),
    });
    await unavailable(source.readRecordDetail(detailRequest()));
    assert.equal(calls.detail.length, phase === 'before' ? 0 : 1);
  });
}

for (const phase of ['authorize', 'loader']) {
  test(`a namespace getter in ${phase} is never invoked or treated as a binding`, async t => {
    let reads = 0;
    const { source } = harness(t, {
      authorize(request) {
        const value = grant(request);
        if (phase === 'authorize') Object.defineProperty(value, 'recordNamespace', { get() { reads += 1; return 'client_record'; } });
        return value;
      },
      loadDetail(request) {
        const value = loaded(request);
        if (phase === 'loader') Object.defineProperty(value, 'recordNamespace', { get() { reads += 1; return 'client_record'; } });
        return value;
      },
    });
    await unavailable(source.readRecordDetail(detailRequest()));
    assert.equal(reads, 0);
  });
}

test('namespace tokens are not transferable across U2 sessions with equal IDs and scopes', async t => {
  const client = harness(t);
  const server = harness(t, { manifest: { ...manifest(), recordNamespace: 'server_record' } });
  const first = createResultReadSession({ scope: SCOPE, source: client.source });
  const second = createResultReadSession({ scope: SCOPE, source: server.source });
  t.after(() => { first.close(); second.close(); });
  const clientPage = await first.readPage();
  const serverPage = await second.readPage();
  assert.equal((await second.readDetail({ recordId: 'record-1', pageToken: clientPage.pageToken })).status, 'selection_unavailable');
  assert.equal(server.calls.detail.length, 0);
  assert.equal((await second.readDetail({ recordId: 'record-1', pageToken: serverPage.pageToken })).status, 'ready');
  assert.equal(server.calls.detail[0].recordNamespace, 'server_record');
});

for (const binding of ['recordVersion', 'recordNamespace', 'recordId', 'snapshotId']) {
  test(`detail ${binding} is checked again after delayed postauthorization`, async t => {
    const waiting = deferred();
    let original;
    const { source, calls } = harness(t, {
      authorize: (request, count) => count === 2 ? waiting.promise : grant(request),
      loadDetail(request) { original = loaded(request); return original; },
    });
    const pending = source.readRecordDetail(detailRequest());
    await tick();
    assert.equal(calls.authorize.length, 2);
    original[binding] = binding === 'recordNamespace' ? 'server_record' : 'changed-after-binding';
    waiting.resolve(grant(calls.authorize[1]));
    await unavailable(pending);
  });
}

test('detail body and comments are snapshotted before delayed postauthorization even without a version change', async t => {
  const waiting = deferred();
  let original;
  const { source, calls } = harness(t, {
    authorize: (request, count) => count === 2 ? waiting.promise : grant(request),
    loadDetail(request) {
      original = loaded(request);
      return original;
    },
  });
  const pending = source.readRecordDetail(detailRequest());
  await tick();
  assert.equal(calls.authorize.length, 2);
  assert.equal(original.detail.body, '人工正文');
  assert.equal(original.detail.comments[0].text, '人工评论');
  assert.equal(Object.isFrozen(original.detail), false);
  assert.equal(Object.isFrozen(original.detail.comments), false);
  assert.equal(Object.isFrozen(original.detail.comments[0]), false);
  original.detail.body = 'changed body with unchanged version';
  original.detail.comments[0].author = 'changed author';
  original.detail.comments[0].text = 'changed comment';
  original.detail.comments.push({ author: 'new author', text: 'new comment' });
  original.detail.truncated.body = true;
  original.detail.truncated.comments = true;
  const afterCallerChange = structuredClone(original);
  waiting.resolve(grant(calls.authorize[1]));
  const result = await pending;
  assert.deepEqual(result.detail, {
    body: '人工正文', comments: [{ author: '读者', text: '人工评论' }], truncated: { body: false, comments: false },
  });
  assert.deepEqual(original, afterCallerChange);
  assert.equal(original.recordVersion, 'version-1');
  assert.equal(calls.detail.length, 1);
  frozenTree(result);
});

test('replacing the complete raw detail object during postauthorization does not replace the accepted projection', async t => {
  const waiting = deferred();
  let original;
  const { source, calls } = harness(t, {
    authorize: (request, count) => count === 2 ? waiting.promise : grant(request),
    loadDetail(request) { original = loaded(request); return original; },
  });
  const pending = source.readRecordDetail(detailRequest());
  await tick();
  assert.equal(calls.authorize.length, 2);
  original.detail = { body: 'replacement content', comments: [], truncated: { body: false, comments: false } };
  waiting.resolve(grant(calls.authorize[1]));
  const result = await pending;
  assert.equal(result.detail.body, '人工正文');
  assert.equal(result.detail.comments[0].text, '人工评论');
  assert.equal(original.detail.body, 'replacement content');
  assert.equal(Object.isFrozen(original.detail), false);
});

test('a descriptor trap changing record version during detail projection cannot publish the changed body', async t => {
  let original;
  const { source, calls } = harness(t, {
    loadDetail(request) {
      original = loaded(request);
      return new Proxy(original, {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'detail') {
            target.recordVersion = 'version-2';
            target.detail.body = 'body belonging to version-2';
          }
          return Object.getOwnPropertyDescriptor(target, key);
        },
      });
    },
  });
  await unavailable(source.readRecordDetail(detailRequest()));
  assert.equal(original.recordVersion, 'version-2');
  assert.equal(calls.detail.length, 1);
});

test('a manifest namespace getter is rejected without executing it', () => {
  let reads = 0;
  const input = manifest();
  Object.defineProperty(input, 'recordNamespace', { get() { reads += 1; return 'client_record'; } });
  assert.throws(() => createSnapshotResultSource({ manifest: input, authorize: grant, loadDetail: loaded }), TypeError);
  assert.equal(reads, 0);
});

test('duplicate catalog IDs are rejected across page boundaries rather than silently deduplicated', () => {
  const entries = Array.from({ length: 51 }, (_, index) => ({ recordId: `record-${index}`, recordVersion: `version-${index}`, summary: summary(`record-${index}`) }));
  entries.push({ recordId: 'record-0', recordVersion: 'different-version', summary: summary('record-0') });
  assert.throws(() => createSnapshotResultSource({ manifest: manifest(entries), authorize: grant, loadDetail: loaded }), error => {
    assert.equal(error instanceof TypeError, true);
    assert.equal(['Invalid result catalog', 'Invalid snapshot source configuration'].includes(error.message), true);
    return true;
  });
});

test('invalid factory configuration rejects with a fixed non-sensitive TypeError', () => {
  const valid = { manifest: manifest(), authorize: grant, loadDetail: loaded };
  for (const options of [null, [], {}, { ...valid, authorize: null }, { ...valid, loadDetail: {} }, { ...valid, now: 5 },
    { ...valid, manifest: null }, { ...valid, manifest: { ...manifest(), snapshotId: 'private bad snapshot' } },
    { ...valid, manifest: manifest([{ recordId: 'record-1', recordVersion: 'private bad version', summary: summary() }]) }]) {
    assert.throws(() => createSnapshotResultSource(options), error => {
      assert.equal(error instanceof TypeError, true);
      assert.equal(['Invalid result catalog', 'Invalid snapshot source configuration'].includes(error.message), true);
      assert.equal(/private/u.test(error.message), false);
      return true;
    });
  }
});

test('factory configuration accessors are never executed as capabilities', () => {
  let reads = 0;
  const options = { manifest: manifest(), loadDetail: loaded, get authorize() { reads += 1; return grant; } };
  assert.throws(() => createSnapshotResultSource(options), TypeError);
  assert.equal(reads, 0);
});
