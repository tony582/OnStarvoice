import assert from 'node:assert/strict';
import test from 'node:test';
import { readScope, readQuery, decodeResultPage, decodeResultDetail } from '../../extension-ui/domain/read-contract.mjs';

const scope = { tenantId: 'tenant-1', taskId: 'task-1', executionId: 'execution-1' };
const query = { filter: 'all', offset: 0, limit: 50 };

function summary(id = 'record-1', attention = false) {
  return {
    id, title: '摘要标题', platform: 'xiaohongshu', kind: 'note', author: '作者',
    capture: { status: 'completed' },
    delivery: { remote: 'confirmed', local: attention ? 'failed' : 'confirmed' },
  };
}

function page(overrides = {}) {
  return { scope: { ...scope }, snapshotId: 'snapshot-1', query: { ...query }, items: [summary()], counts: { all: 1, attention: 0, matching: 1 }, ...overrides };
}

function detail(overrides = {}) {
  return { scope: { ...scope }, snapshotId: 'snapshot-1', recordId: 'record-1', detail: { body: '正文', comments: [{ author: '甲', text: '评论' }] }, ...overrides };
}

function accessor(target, key, reads) {
  Object.defineProperty(target, key, { configurable: true, get() { reads.count += 1; throw new Error('must not execute'); } });
  return target;
}

function assertFrozenTree(value) {
  if (value !== null && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertFrozenTree(child);
  }
}

test('scope returns an exact frozen copy of only the three proposed identity fields', () => {
  const source = { tenantId: 'ten:ant|1', taskId: '任务-😀', executionId: 'é-e\u0301', token: 'secret' };
  const result = readScope(source);
  assert.deepEqual(result, { tenantId: source.tenantId, taskId: source.taskId, executionId: source.executionId });
  assert.notEqual(result, source);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(result), true);
});

for (const key of ['tenantId', 'taskId', 'executionId']) {
  test(`scope requires its own valid ${key}`, () => {
    for (const invalid of [undefined, null, '', 1, 1n, true, {}, [], 'x'.repeat(241), ' x', 'x ', 'x\ny', '\u0000', '\u0085', 'x\u061Cy', 'x\u200Ey', 'x\u200Fy', 'x\u202Ey', 'x\u2066y', '\uD800', '\uDC00']) {
      assert.equal(readScope({ ...scope, [key]: invalid }), null);
    }
    const missing = { ...scope }; delete missing[key];
    assert.equal(readScope(missing), null);
    const inherited = Object.create({ [key]: scope[key] });
    for (const other of Object.keys(scope).filter(value => value !== key)) inherited[other] = scope[other];
    assert.equal(readScope(inherited), null);
    const reads = { count: 0 };
    assert.equal(readScope(accessor({ ...scope }, key, reads)), null);
    assert.equal(reads.count, 0);
    assert.equal(readScope({ ...scope, [key]: 'x'.repeat(240) })[key].length, 240);
  });
}

test('scope refuses malformed roots and revoked or throwing descriptor proxies', () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const throws = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private error'); } });
  for (const value of [null, undefined, [], true, 'scope', 1, () => {}, revoked.proxy, throws]) assert.equal(readScope(value), null);
});

test('query defaults only absent fields and returns a frozen own-field copy', () => {
  for (const value of [undefined, {}]) assert.deepEqual(readQuery(value), query);
  assert.deepEqual(readQuery({ filter: 'attention' }), { filter: 'attention', offset: 0, limit: 50 });
  assert.deepEqual(readQuery({ offset: 4 }), { filter: 'all', offset: 4, limit: 50 });
  const source = { filter: 'attention', offset: Number.MAX_SAFE_INTEGER, limit: 1, token: 'private' };
  assert.deepEqual(readQuery(source), { filter: 'attention', offset: Number.MAX_SAFE_INTEGER, limit: 1 });
  assert.equal(Object.isFrozen(readQuery(source)), true);
  assert.equal(Object.isFrozen(source), false);
});

for (const [key, invalidValues] of [
  ['filter', [undefined, null, '', 'ALL', 'complete', 0, false]],
  ['offset', [undefined, null, -1, 0.5, Infinity, NaN, '0', Number.MAX_SAFE_INTEGER + 1]],
  ['limit', [undefined, null, 0, -1, 51, 0.5, Infinity, NaN, '50']],
]) {
  test(`query rejects malformed or accessor ${key} instead of broadening`, () => {
    for (const value of invalidValues) assert.equal(readQuery({ [key]: value }), null);
    const reads = { count: 0 };
    assert.equal(readQuery(accessor({}, key, reads)), null);
    assert.equal(reads.count, 0);
  });
}

test('query does not execute inherited or unknown fields and refuses malformed roots', () => {
  const reads = { count: 0 };
  const value = Object.create(accessor({}, 'filter', reads));
  accessor(value, 'secret', reads);
  assert.deepEqual(readQuery(value), query);
  assert.equal(reads.count, 0);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const invalid of [null, [], 'query', 0, () => {}, revoked.proxy]) assert.equal(readQuery(invalid), null);
});

test('page projects only returned summaries and source-provided aggregate counts', () => {
  const request = { filter: 'all', offset: 20, limit: 2 };
  const response = page({ query: request, items: [summary('a'), summary('b', true)], counts: { all: 1500, attention: 10, matching: 1500 } });
  const result = decodeResultPage(response, scope, request);
  assert.equal(result.snapshotId, 'snapshot-1');
  assert.deepEqual(result.page.items.map(item => item.id), ['a', 'b']);
  assert.deepEqual(result.page.counts, response.counts);
  assert.deepEqual(result.page.page, { ...request, hasPrevious: true, hasNext: true });
  assertFrozenTree(result);
});

test('page permits known empty, exact final and beyond-end pages', () => {
  const empty = decodeResultPage(page({ items: [], counts: { all: 0, attention: 0, matching: 0 } }), scope, query);
  assert.deepEqual(empty.page.items, []);
  assert.deepEqual(empty.page.page, { ...query, hasPrevious: false, hasNext: false });
  for (const offset of [2, 3, 100, Number.MAX_SAFE_INTEGER]) {
    const request = { filter: 'all', offset, limit: 2 };
    const response = page({ query: request, items: offset === 2 ? [summary('last')] : [], counts: { all: 3, attention: 0, matching: 3 } });
    const result = decodeResultPage(response, scope, request);
    assert.ok(result);
    assert.equal(result.page.page.hasPrevious, true);
    assert.equal(result.page.page.hasNext, false);
  }
});

test('page never reads content, comments, extra fields, array iterator or credential fields', () => {
  const reads = { count: 0 };
  const response = page();
  for (const key of ['body', 'comments', 'payload', 'token']) accessor(response.items[0], key, reads);
  for (const key of ['secret', 'raw', 'error']) accessor(response, key, reads);
  accessor(response.items, Symbol.iterator, reads);
  assert.ok(decodeResultPage(response, scope, query));
  assert.equal(reads.count, 0);
});

test('page preserves invalid and duplicate identities without deduplication', () => {
  const response = page({ items: [summary('same'), summary('same'), summary('')], counts: { all: 3, attention: 1, matching: 3 } });
  const result = decodeResultPage(response, scope, query);
  assert.deepEqual(result.page.items.map(item => item.id), ['same', 'same', '']);
  assert.equal(result.page.items[2].needsAttention, true);
});

for (const key of ['tenantId', 'taskId', 'executionId']) {
  test(`page rejects ${key} mismatch before reading items`, () => {
    const reads = { count: 0 };
    const response = page({ scope: { ...scope, [key]: `${scope[key]}-other` } });
    accessor(response, 'items', reads);
    assert.equal(decodeResultPage(response, scope, query), null);
    assert.equal(reads.count, 0);
  });
}

test('page rejects malformed request scope and query rather than trusting the response', () => {
  assert.equal(decodeResultPage(page(), { ...scope, executionId: '' }, query), null);
  assert.equal(decodeResultPage(page(), scope, { filter: 'finished' }), null);
  assert.equal(decodeResultPage(page(), scope, null), null);
});

test('page requires a complete exact query echo and an exact bounded snapshot identity', () => {
  for (const invalid of [null, {}, { offset: 0, limit: 50 }, { ...query, filter: 'attention' }, { ...query, offset: 1 }, { ...query, limit: 49 }, Object.create(query)]) {
    assert.equal(decodeResultPage(page({ query: invalid }), scope, query), null);
  }
  for (const snapshotId of [undefined, '', null, 'x'.repeat(241), ' snapshot', 'x\u202Ey', '\uD800', 123]) {
    assert.equal(decodeResultPage(page({ snapshotId }), scope, query), null);
  }
  assert.equal(decodeResultPage(page({ snapshotId: 's'.repeat(240) }), scope, query).snapshotId.length, 240);
});

for (const key of ['scope', 'snapshotId', 'query', 'counts', 'items']) {
  test(`page rejects missing/inherited/accessor ${key} without execution`, () => {
    const response = page(); delete response[key];
    assert.equal(decodeResultPage(response, scope, query), null);
    const prototype = { [key]: page()[key] };
    Object.setPrototypeOf(response, prototype);
    assert.equal(decodeResultPage(response, scope, query), null);
    const reads = { count: 0 };
    accessor(response, key, reads);
    assert.equal(decodeResultPage(response, scope, query), null);
    assert.equal(reads.count, 0);
  });
}

test('page rejects non-array, sparse, accessor, primitive or excessive item slots', () => {
  const sparse = new Array(1);
  const reads = { count: 0 };
  const entryAccessor = accessor([summary()], '0', reads);
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  for (const items of [null, {}, 'items', sparse, entryAccessor, [null], [[]], ['text'], [0], revoked.proxy, Array.from({ length: 51 }, () => summary())]) {
    assert.equal(decodeResultPage(page({ items }), scope, query), null);
  }
  assert.equal(reads.count, 0);
});

test('page enforces exact requested length rather than accepting misleading partial/extra pages', () => {
  for (const items of [[], [summary(), summary()]]) assert.equal(decodeResultPage(page({ items }), scope, query), null);
  const request = { filter: 'all', offset: 0, limit: 2 };
  assert.equal(decodeResultPage(page({ query: request, counts: { all: 10, attention: 0, matching: 10 } }), scope, request), null);
});

for (const key of ['all', 'attention', 'matching']) {
  test(`page counts require safe own-data nonnegative ${key}`, () => {
    for (const invalid of [undefined, null, -1, 0.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1]) {
      const response = page(); response.counts[key] = invalid;
      assert.equal(decodeResultPage(response, scope, query), null);
    }
    const reads = { count: 0 }; const response = page();
    accessor(response.counts, key, reads);
    assert.equal(decodeResultPage(response, scope, query), null);
    assert.equal(reads.count, 0);
  });
}

test('page rejects internally contradictory aggregate counts', () => {
  for (const counts of [{ all: 1, attention: 2, matching: 1 }, { all: 1, attention: 0, matching: 0 }]) {
    assert.equal(decodeResultPage(page({ counts }), scope, query), null);
  }
  assert.equal(decodeResultPage(page({ items: [summary('a', true)] }), scope, query), null);
  assert.equal(decodeResultPage(page({ counts: { all: 1, attention: 1, matching: 1 } }), scope, query), null);
});

test('page attention feasibility accounts only for known visible rows', () => {
  const request = { filter: 'all', offset: 0, limit: 2 };
  for (const attention of [1, 8, 9]) {
    assert.ok(decodeResultPage(page({ query: request, items: [summary('a', true), summary('b')], counts: { all: 10, attention, matching: 10 } }), scope, request));
  }
  for (const attention of [0, 10]) {
    assert.equal(decodeResultPage(page({ query: request, items: [summary('a', true), summary('b')], counts: { all: 10, attention, matching: 10 } }), scope, request), null);
  }
});

test('attention page contains only attention projections and matches the attention total', () => {
  const request = { filter: 'attention', offset: 0, limit: 2 };
  const response = page({ query: request, items: [summary('a', true), summary('b', true)], counts: { all: 10, attention: 3, matching: 3 } });
  assert.ok(decodeResultPage(response, scope, request));
  response.items[1] = summary('b');
  assert.equal(decodeResultPage(response, scope, request), null);
  response.items[1] = summary('b', true);
  response.counts.matching = 10;
  assert.equal(decodeResultPage(response, scope, request), null);
});

test('page copies and deeply freezes only new projections without freezing or retaining input', () => {
  const response = page();
  const before = structuredClone(response);
  const result = decodeResultPage(response, scope, query);
  assert.deepEqual(response, before);
  assertFrozenTree(result);
  for (const value of [response, response.items, response.items[0], response.items[0].capture, response.counts, response.query, response.scope]) assert.equal(Object.isFrozen(value), false);
  response.items[0].title = 'changed'; response.counts.all = 100;
  assert.equal(result.page.items[0].title, '摘要标题');
  assert.equal(result.page.counts.all, 1);
});

test('detail projects bounded content after exact matching and drops envelope extras', () => {
  const response = detail({ token: 'secret', raw: { password: 'private' } });
  const result = decodeResultDetail(response, scope, 'snapshot-1', 'record-1');
  assert.deepEqual(result, { recordId: 'record-1', detail: { body: '正文', comments: [{ author: '甲', text: '评论' }], truncated: { body: false, comments: false } } });
  assertFrozenTree(result);
  assert.equal(Object.isFrozen(response), false);
  assert.equal(Object.isFrozen(response.detail), false);
  assert.equal(Object.isFrozen(response.detail.comments[0]), false);
  response.detail.comments[0].text = 'changed';
  assert.equal(result.detail.comments[0].text, '评论');
});

for (const field of ['tenantId', 'taskId', 'executionId']) {
  test(`detail rejects ${field} mismatch before inspecting the heavy field`, () => {
    let detailReads = 0;
    const response = new Proxy(detail({ scope: { ...scope, [field]: 'other' } }), {
      getOwnPropertyDescriptor(target, key) { if (key === 'detail') detailReads += 1; return Object.getOwnPropertyDescriptor(target, key); },
    });
    assert.equal(decodeResultDetail(response, scope, 'snapshot-1', 'record-1'), null);
    assert.equal(detailReads, 0);
  });
}

test('detail rejects old snapshot, a different record or malformed requested identity before inspection', () => {
  const requests = [
    [scope, 'snapshot-old', 'record-1'], [scope, 'snapshot-1', 'record-other'],
    [scope, '', 'record-1'], [scope, 'snapshot-1', ''], [scope, 'snapshot-1', 'record-1 '],
    [scope, 'snapshot-1', 'r'.repeat(129)], [scope, 's'.repeat(241), 'record-1'],
    [{ ...scope, executionId: '' }, 'snapshot-1', 'record-1'],
  ];
  let detailReads = 0;
  const response = new Proxy(detail(), { getOwnPropertyDescriptor(target, key) { if (key === 'detail') detailReads += 1; return Object.getOwnPropertyDescriptor(target, key); } });
  for (const request of requests) assert.equal(decodeResultDetail(response, ...request), null);
  assert.equal(detailReads, 0);
});

test('detail does not normalize exact record IDs, including case and Unicode forms', () => {
  for (const [responseId, requested] of [['RECORD-1', 'record-1'], ['é', 'e\u0301'], ['x:y', 'x|y']]) {
    assert.equal(decodeResultDetail(detail({ recordId: responseId }), scope, 'snapshot-1', requested), null);
  }
  const recordId = 'r'.repeat(126) + '😀';
  assert.equal(decodeResultDetail(detail({ recordId }), scope, 'snapshot-1', recordId).recordId, recordId);
});

for (const key of ['scope', 'snapshotId', 'recordId', 'detail']) {
  test(`detail requires own-data ${key} without executing accessors`, () => {
    const missing = detail(); delete missing[key];
    assert.equal(decodeResultDetail(missing, scope, 'snapshot-1', 'record-1'), null);
    Object.setPrototypeOf(missing, { [key]: detail()[key] });
    assert.equal(decodeResultDetail(missing, scope, 'snapshot-1', 'record-1'), null);
    const reads = { count: 0 };
    accessor(missing, key, reads);
    assert.equal(decodeResultDetail(missing, scope, 'snapshot-1', 'record-1'), null);
    assert.equal(reads.count, 0);
  });
}

test('detail rejects non-object details and malformed or unreadable response roots', () => {
  for (const value of [null, undefined, [], true, 'body', 1, () => {}]) assert.equal(decodeResultDetail(detail({ detail: value }), scope, 'snapshot-1', 'record-1'), null);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private error'); } });
  for (const response of [null, undefined, [], 'response', revoked.proxy, throwing]) {
    assert.equal(decodeResultPage(response, scope, query), null);
    assert.equal(decodeResultDetail(response, scope, 'snapshot-1', 'record-1'), null);
  }
});

test('detail retains U1 bounds and truncation while avoiding inherited or executable values', () => {
  const reads = { count: 0 };
  const response = detail({ detail: { body: '😀'.repeat(7000), comments: Array.from({ length: 60 }, () => ({ text: 'x'.repeat(1700), author: '甲' })) } });
  accessor(response.detail, 'token', reads);
  accessor(response.detail.comments, Symbol.iterator, reads);
  const result = decodeResultDetail(response, scope, 'snapshot-1', 'record-1');
  assert.equal(result.detail.comments.length, 50);
  assert.ok(result.detail.body.length <= 12000);
  assert.ok(result.detail.comments.every(comment => comment.text.length <= 1600));
  assert.deepEqual(result.detail.truncated, { body: true, comments: true });
  assertFrozenTree(result);
  assert.equal(reads.count, 0);
});
