import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResultCatalog } from '../../extension-ui/domain/result-catalog.mjs';
import { exactReadIdentity } from '../../extension-ui/domain/read-identity.mjs';
import { decodeResultPage } from '../../extension-ui/domain/read-contract.mjs';
import { presentResult } from '../../extension-ui/domain/result-presenter.mjs';

const scope = { tenantId: 'tenant-1', taskId: 'task-1', executionId: 'execution-1' };
const invalidCatalog = error => error instanceof TypeError && error.message === 'Invalid result catalog';

function summary(id = 'record-1', needsAttention = false) {
  return {
    id, title: '标题', author: '作者', summary: '摘要', platform: 'xiaohongshu', kind: 'note',
    likes: 0, commentsCount: null, capture: { status: 'completed' },
    delivery: { remote: 'confirmed', local: needsAttention ? 'failed' : 'confirmed' },
  };
}

function entry(id = 'record-1', needsAttention = false) {
  return { recordId: id, recordVersion: `version:${id}`, summary: summary(id, needsAttention) };
}

function manifest(entries = [entry()]) { return { scope: { ...scope }, snapshotId: 'snapshot-1', recordNamespace: 'client_record', entries }; }

function getter(target, key, reads) {
  Object.defineProperty(target, key, { configurable: true, get() { reads.count += 1; throw new Error('private input'); } });
  return target;
}

function frozenTree(value) {
  if (value !== null && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const nested of Object.values(value)) frozenTree(nested);
  }
}

test('shared read identity preserves exact U2 scope/snapshot rules', () => {
  for (const value of ['scope', '任务-😀', 'x'.repeat(240), 'é', 'e\u0301', '__proto__']) assert.equal(exactReadIdentity(value), value);
  for (const value of ['', 'x'.repeat(241), ' spaced', 'x\ny', 'x\u0000', 'x\u0085', 'x\u061C', 'x\u200E', 'x\u200F', 'x\u202E', 'x\u2066', '\uD800', '\uDC00', null, undefined, 1, {}, []]) assert.equal(exactReadIdentity(value), null);
});

test('catalog returns an immutable exact scope and a source envelope accepted by U2', () => {
  const input = manifest();
  const catalog = buildResultCatalog(input);
  assert.deepEqual(catalog.scope, scope);
  assert.notEqual(catalog.scope, input.scope);
  assert.equal(catalog.snapshotId, 'snapshot-1');
  assert.equal(catalog.recordNamespace, 'client_record');
  const page = catalog.readPage();
  assert.equal(page.recordNamespace, 'client_record');
  assert.deepEqual(page.query, { filter: 'all', offset: 0, limit: 50 });
  assert.deepEqual(page.counts, { all: 1, attention: 0, matching: 1 });
  assert.deepEqual(page.items[0], input.entries[0].summary);
  assert.deepEqual(catalog.lookup('record-1'), { recordId: 'record-1', recordVersion: 'version:record-1' });
  assert.ok(decodeResultPage(page, scope, page.query));
  frozenTree(catalog); frozenTree(page); frozenTree(catalog.lookup('record-1'));
});

test('catalog empty manifest has confirmed empty pages and no lookup result', () => {
  const catalog = buildResultCatalog(manifest([]));
  for (const query of [undefined, { filter: 'attention' }, { offset: 99 }]) {
    const page = catalog.readPage(query);
    assert.deepEqual(page.items, []);
    assert.deepEqual(page.counts, { all: 0, attention: 0, matching: 0 });
    assert.ok(decodeResultPage(page, scope, page.query));
  }
  assert.equal(catalog.lookup('record-1'), null);
});

test('catalog indexes 1500 lightweight rows once and does not inspect inputs during pagination or lookup', () => {
  let descriptorReads = 0;
  let laterReads = false;
  const tracked = value => new Proxy(value, {
    getOwnPropertyDescriptor(target, key) {
      descriptorReads += 1;
      if (laterReads) throw new Error('catalog retained source');
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const entries = Array.from({ length: 1500 }, (_, index) => {
    const value = entry(`record-${index}`, index % 10 === 0);
    value.summary = tracked(value.summary);
    return tracked(value);
  });
  const source = manifest(tracked(entries)); source.scope = tracked(source.scope);
  const catalog = buildResultCatalog(tracked(source));
  const initialReads = descriptorReads;
  laterReads = true;
  for (let offset = 0; offset < 1500; offset += 50) {
    const page = catalog.readPage({ offset });
    assert.equal(page.items.length, 50);
    assert.equal(page.items[0].id, `record-${offset}`);
    assert.deepEqual(page.counts, { all: 1500, attention: 150, matching: 1500 });
  }
  const attention = catalog.readPage({ filter: 'attention', offset: 100 });
  assert.equal(attention.items[0].id, 'record-1000');
  assert.equal(attention.items.length, 50);
  assert.deepEqual(attention.counts, { all: 1500, attention: 150, matching: 150 });
  assert.deepEqual(catalog.lookup('record-1499'), { recordId: 'record-1499', recordVersion: 'version:record-1499' });
  assert.equal(descriptorReads, initialReads);
});

test('catalog snapshots do not change when the caller mutates manifest, source scope or nested summaries', () => {
  const input = manifest([entry('one'), entry('two', true)]);
  const catalog = buildResultCatalog(input);
  const before = structuredClone(catalog.readPage());
  const beforeLookup = structuredClone(catalog.lookup('one'));
  for (const value of [input, input.scope, input.entries, input.entries[0], input.entries[0].summary, input.entries[0].summary.capture, input.entries[0].summary.delivery]) assert.equal(Object.isFrozen(value), false);
  input.scope.tenantId = 'another'; input.snapshotId = 'changed';
  input.entries[0].recordId = 'reassigned'; input.entries[0].recordVersion = 'updated';
  input.entries[0].summary.id = 'reassigned'; input.entries[0].summary.title = 'different';
  input.entries[0].summary.capture.status = 'failed'; input.entries[0].summary.delivery.local = 'failed';
  input.entries[0].summary.reconciliationRequired = true;
  input.entries.splice(0, 2, entry('replacement'));
  assert.deepEqual(catalog.readPage(), before);
  assert.deepEqual(catalog.lookup('one'), beforeLookup);
  assert.equal(catalog.lookup('reassigned'), null);
});

test('catalog retains no details, payloads, credentials, actions or unknown fields', () => {
  const reads = { count: 0 }; const value = entry();
  for (const key of ['body', 'comments', 'payload', 'rawPayload', 'normalizedPayload', 'token', 'secret', 'retry', 'sync', 'unknown']) getter(value.summary, key, reads);
  for (const key of ['body', 'comments', 'payload', 'rawPayload', 'token']) getter(value, key, reads);
  const input = manifest([value]);
  for (const key of ['auth', 'token', 'rawPayload', 'error']) getter(input, key, reads);
  getter(input.entries, Symbol.iterator, reads);
  const catalog = buildResultCatalog(input);
  assert.deepEqual(Object.keys(catalog.lookup('record-1')).sort(), ['recordId', 'recordVersion']);
  assert.deepEqual(Object.keys(catalog.readPage().items[0]).sort(), ['id', 'title', 'author', 'summary', 'platform', 'kind', 'likes', 'commentsCount', 'capture', 'delivery'].sort());
  assert.equal(reads.count, 0);
});

test('catalog rejects duplicate IDs anywhere in the complete manifest, including beyond page one', () => {
  for (const duplicateAt of [1, 50, 1499]) {
    const entries = Array.from({ length: duplicateAt + 1 }, (_, index) => entry(`record-${index}`));
    entries[duplicateAt] = entry('record-0');
    assert.throws(() => buildResultCatalog(manifest(entries)), invalidCatalog);
  }
});

test('catalog ID lookup is exact, cannot be guessed, and is safe for prototype-like strings', () => {
  const ids = ['__proto__', 'constructor', 'é', 'e\u0301', 'UPPER', 'x:y', 'x|y', 'r'.repeat(126) + '😀'];
  const catalog = buildResultCatalog(manifest(ids.map(id => entry(id))));
  for (const id of ids) assert.equal(catalog.lookup(id).recordId, id);
  for (const id of [undefined, null, '', ' __proto__', 'UPPER ', 'upper', 0, {}, 'r'.repeat(129), '\uD800']) assert.equal(catalog.lookup(id), null);
});

test('catalog supports the bounded 10000-row contract and rejects the next row before inspecting it', () => {
  const catalog = buildResultCatalog(manifest(Array.from({ length: 10000 }, (_, index) => entry(`r-${index}`))));
  assert.equal(catalog.readPage().counts.all, 10000);
  assert.equal(catalog.lookup('r-9999').recordId, 'r-9999');
  const reads = { count: 0 }; const oversized = new Array(10001); getter(oversized, '0', reads);
  assert.throws(() => buildResultCatalog(manifest(oversized)), invalidCatalog);
  assert.equal(reads.count, 0);
});

test('catalog rejects invalid ownership and snapshot identity without inferring current scope', () => {
  for (const badScope of [undefined, null, {}, [], { ...scope, tenantId: '' }, { ...scope, taskId: ' wrong' }, { ...scope, executionId: 'x'.repeat(241) }, Object.create(scope)]) {
    assert.throws(() => buildResultCatalog({ ...manifest(), scope: badScope }), invalidCatalog);
  }
  for (const snapshotId of [undefined, null, '', 's'.repeat(241), '\u202E', 3]) assert.throws(() => buildResultCatalog({ ...manifest(), snapshotId }), invalidCatalog);
});

for (const key of ['recordId', 'recordVersion']) {
  test(`catalog requires exact own-data ${key} and rejects missing/accessor/inherited values`, () => {
    for (const invalid of [undefined, null, '', 4, {}, [], ' whitespace', '\uD800', 'x'.repeat(key === 'recordId' ? 129 : 241)]) {
      assert.throws(() => buildResultCatalog(manifest([{ ...entry(), [key]: invalid }])), invalidCatalog);
    }
    const missing = entry(); delete missing[key];
    Object.setPrototypeOf(missing, { [key]: entry()[key] });
    assert.throws(() => buildResultCatalog(manifest([missing])), invalidCatalog);
    const reads = { count: 0 }; const value = getter(entry(), key, reads);
    assert.throws(() => buildResultCatalog(manifest([value])), invalidCatalog);
    assert.equal(reads.count, 0);
  });
}

test('catalog rejects mismatched or missing summary IDs rather than repairing them', () => {
  for (const id of [undefined, null, '', 'other', ' record-1', 'record-1 ', 1]) {
    const value = entry(); value.summary.id = id;
    assert.throws(() => buildResultCatalog(manifest([value])), invalidCatalog);
  }
  const value = entry(); value.summary = Object.create(value.summary);
  assert.throws(() => buildResultCatalog(manifest([value])), invalidCatalog);
});

for (const key of ['scope', 'snapshotId', 'recordNamespace', 'entries']) {
  test(`catalog requires own-data manifest ${key} without getter execution`, () => {
    const input = manifest(); const inherited = input[key]; delete input[key];
    Object.setPrototypeOf(input, { [key]: inherited });
    assert.throws(() => buildResultCatalog(input), invalidCatalog);
    const reads = { count: 0 }; getter(input, key, reads);
    assert.throws(() => buildResultCatalog(input), invalidCatalog);
    assert.equal(reads.count, 0);
  });
}

test('catalog requires an explicit known record namespace without conflating client and server IDs', () => {
  for (const recordNamespace of [undefined, null, '', 'unknown', 'client', 'server', 'CLIENT_RECORD', 'client_record ', 'client_record:server_record', 1]) {
    assert.throws(() => buildResultCatalog({ ...manifest(), recordNamespace }), invalidCatalog);
  }
  for (const recordNamespace of ['client_record', 'server_record']) {
    const catalog = buildResultCatalog({ ...manifest(), recordNamespace });
    assert.equal(catalog.recordNamespace, recordNamespace);
    assert.equal(catalog.readPage().recordNamespace, recordNamespace);
    assert.deepEqual(catalog.lookup('record-1'), { recordId: 'record-1', recordVersion: 'version:record-1' });
  }
});

test('catalog rejects sparse, accessor, revoked and malformed entry containers with a fixed error', () => {
  const reads = { count: 0 }; const revoked = Proxy.revocable([], {}); revoked.revoke();
  for (const entries of [undefined, null, {}, 'entries', new Array(1), [null], [[]], [4], getter([entry()], '0', reads), revoked.proxy]) {
    assert.throws(() => buildResultCatalog({ ...manifest(), entries }), invalidCatalog);
  }
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private response'); } });
  for (const input of [undefined, null, [], 'manifest', throwing]) assert.throws(() => buildResultCatalog(input), invalidCatalog);
  assert.equal(reads.count, 0);
});

test('catalog does not stringify malformed selected fields or execute selected summary accessors', () => {
  const reads = { count: 0 };
  for (const field of ['id', 'title', 'platform', 'kind', 'author', 'summary', 'likes', 'commentsCount', 'capture', 'delivery', 'reconciliationRequired']) {
    const value = entry(); getter(value.summary, field, reads);
    assert.throws(() => buildResultCatalog(manifest([value])), invalidCatalog);
  }
  for (const [group, field] of [['capture', 'status'], ['delivery', 'remote'], ['delivery', 'local']]) {
    const value = entry(); getter(value.summary[group], field, reads);
    assert.throws(() => buildResultCatalog(manifest([value])), invalidCatalog);
  }
  assert.equal(reads.count, 0);
});

test('catalog rejects malformed holds instead of making both-confirmed input look successful', () => {
  for (const reconciliationRequired of [null, 0, 1, 'false', 'true', {}, []]) {
    const value = entry(); value.summary.reconciliationRequired = reconciliationRequired;
    assert.equal(presentResult(value.summary).needsAttention, true);
    assert.throws(() => buildResultCatalog(manifest([value])), invalidCatalog);
  }
});

test('catalog rejects unsafe field types and long semantic strings without converting them to success', () => {
  const variants = [
    ...['title', 'author', 'summary', 'platform', 'kind'].flatMap(field => [null, {}, [], 1, false].map(value => ({ [field]: value }))),
    ...['likes', 'commentsCount'].flatMap(field => [-1, 0.5, NaN, Infinity, '0', {}, Number.MAX_SAFE_INTEGER + 1].map(value => ({ [field]: value }))),
    { capture: null }, { capture: [] }, { capture: { status: {} } },
    { delivery: null }, { delivery: { remote: true } }, { delivery: { local: [] } },
    { platform: 'x'.repeat(241) }, { kind: 'x'.repeat(241) },
    { capture: { status: 'completed' + 'x'.repeat(241) } }, { delivery: { remote: 'confirmed' + 'x'.repeat(241) } },
  ];
  for (const patch of variants) {
    const value = entry(); Object.assign(value.summary, patch);
    assert.throws(() => buildResultCatalog(manifest([value])), invalidCatalog);
  }
});

test('catalog optional absent/undefined values preserve U1 defaults and do not copy inherited fields', () => {
  const values = [
    { id: 'record-1' },
    { id: 'record-1', title: undefined, likes: undefined, capture: undefined, delivery: undefined, reconciliationRequired: undefined },
    { id: 'record-1', capture: {}, delivery: { remote: undefined }, likes: null, commentsCount: null },
    Object.assign(Object.create({ title: 'ignored', capture: { status: 'completed' }, delivery: { remote: 'confirmed', local: 'confirmed' }, reconciliationRequired: true }), { id: 'record-1' }),
  ];
  for (const source of values) {
    const value = entry(); value.summary = source;
    const page = buildResultCatalog(manifest([value])).readPage();
    assert.deepEqual(presentResult(page.items[0]), presentResult(source));
    assert.equal(page.counts.attention, 1);
  }
});

test('catalog all and attention indexes exactly follow U1 state semantics', () => {
  const variants = [
    {}, { reconciliationRequired: true }, { reconciliationRequired: false },
    ...['pending', 'queued', 'running', 'completed', 'succeeded', 'success', 'partial', 'needs_action', 'failed', 'cancelled', 'stopped', 'unknown'].map(status => ({ capture: { status } })),
    ...['confirmed', 'pending', 'failed', 'unknown', 'other'].flatMap(remote => ['confirmed', 'pending', 'failed', 'unknown', undefined].map(local => ({ delivery: { remote, local } }))),
  ];
  const entries = variants.map((patch, index) => {
    const value = entry(`record-${index}`); Object.assign(value.summary, patch); return value;
  });
  const expected = entries.filter(value => presentResult(value.summary).needsAttention).map(value => value.recordId);
  const catalog = buildResultCatalog(manifest(entries));
  const all = catalog.readPage(); const attention = catalog.readPage({ filter: 'attention' });
  assert.equal(all.counts.all, entries.length);
  assert.equal(all.counts.attention, expected.length);
  assert.deepEqual(attention.items.map(value => value.id), expected);
  for (const page of [all, attention]) assert.ok(decodeResultPage(page, scope, page.query));
});

test('catalog bound text copies preserve U1 projections and ellipsis at Unicode/control/whitespace boundaries', () => {
  for (const [field, limit] of [['title', 180], ['author', 80], ['summary', 240]]) {
    const samples = [
      '', 'x'.repeat(limit - 1), 'x'.repeat(limit), 'x'.repeat(limit + 1), 'x'.repeat(limit + 10),
      '😀'.repeat(limit), 'x'.repeat(limit - 1) + '😀tail', 'x'.repeat(limit) + '😀tail',
      'x'.repeat(limit - 2) + '😀tail', '  ' + 'x'.repeat(limit + 20),
      '\n\t' + 'x'.repeat(limit) + 'tail', '\u202E\u0000' + 'x'.repeat(limit) + 'tail',
      'x'.repeat(limit) + '\uD800', '\uD800x\uDC00' + 'y'.repeat(limit + 20),
      ' '.repeat(limit + 10), '\r\n'.repeat(limit + 10),
    ];
    for (const text of samples) {
      const value = entry(); value.summary[field] = text;
      const copied = buildResultCatalog(manifest([value])).readPage().items[0];
      assert.ok(copied[field].length <= limit + 1);
      assert.deepEqual(presentResult(copied), presentResult(value.summary));
      assert.equal(/[\uD800-\uDFFF]/u.test(copied[field]), false);
    }
  }
});

test('catalog page query rejects invalid filters/limits and retains stable ordering across boundaries', () => {
  const catalog = buildResultCatalog(manifest(Array.from({ length: 53 }, (_, index) => entry(`r-${index}`, index % 2 === 0))));
  const last = catalog.readPage({ offset: 50 });
  assert.deepEqual(last.items.map(value => value.id), ['r-50', 'r-51', 'r-52']);
  assert.deepEqual(catalog.readPage({ offset: Number.MAX_SAFE_INTEGER }).items, []);
  assert.deepEqual(catalog.readPage({ filter: 'attention', offset: 24, limit: 2 }).items.map(value => value.id), ['r-48', 'r-50']);
  for (const query of [null, [], { filter: 'finished' }, { offset: -1 }, { limit: 0 }, { limit: 51 }, { limit: '50' }]) assert.throws(() => catalog.readPage(query), invalidCatalog);
  const reads = { count: 0 };
  assert.throws(() => catalog.readPage(getter({}, 'filter', reads)), invalidCatalog);
  assert.equal(reads.count, 0);
});
