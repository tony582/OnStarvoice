import assert from 'node:assert/strict';
import test from 'node:test';
import { presentResultPage } from '../../extension-ui/domain/result-page.mjs';
import { buildResultCatalog } from '../../extension-ui/domain/result-catalog.mjs';
import { readQuery, decodeResultPage } from '../../extension-ui/domain/read-contract.mjs';
import { presentResult } from '../../extension-ui/domain/result-presenter.mjs';
import { evaluateAccessPolicy } from '../../extension-ui/domain/access-policy.mjs';
import { createHistoryReadAuthorizer } from '../../extension-ui/application/history-read-authorizer.mjs';
import { createSnapshotResultSource } from '../../extension-ui/application/snapshot-result-source.mjs';
import { createResultReadSession } from '../../extension-ui/application/result-read-session.mjs';

const SCOPE = Object.freeze({ tenantId: 'synthetic-tenant', taskId: 'synthetic-task', executionId: 'synthetic-execution' });
const FILTERS = ['all', 'attention', 'unverified', 'issues', 'intervention'];

function summary(id, capture = 'completed', remote = 'confirmed', local = 'confirmed', reconciliationRequired) {
  return { id, title: '合成结果', platform: 'xiaohongshu', kind: 'note', capture: { status: capture }, delivery: { remote, local }, reconciliationRequired };
}

function rows() {
  return [
    summary('normal'), summary('unverified', 'unknown', 'unknown', 'unknown'),
    summary('failed', 'failed'), summary('intervention', 'needs_action'),
    summary('overlap', 'completed', 'unknown', 'failed'), summary('stopped', 'stopped'),
    summary('local-pending', 'completed', 'confirmed', 'pending'),
    summary('reconcile', 'completed', 'confirmed', 'confirmed', true),
    summary('partial', 'partial'),
  ];
}

const EXPECTED = Object.freeze({
  all: ['normal', 'unverified', 'failed', 'intervention', 'overlap', 'stopped', 'local-pending', 'reconcile', 'partial'],
  attention: ['unverified', 'failed', 'intervention', 'overlap', 'stopped', 'local-pending', 'reconcile', 'partial'],
  unverified: ['unverified', 'overlap'],
  issues: ['failed', 'intervention', 'overlap', 'reconcile', 'partial'],
  intervention: ['intervention'],
});

function manifest(values = rows()) {
  return { scope: { ...SCOPE }, snapshotId: 'snapshot-1', recordNamespace: 'client_record', entries: values.map(value => ({ recordId: value.id, recordVersion: `version:${value.id}`, summary: value })) };
}

function envelope(items, filter, counts, overrides = {}) {
  return { scope: { ...SCOPE }, snapshotId: 'snapshot-1', query: { filter, offset: 0, limit: 50 }, items, counts, ...overrides };
}

function accessRequest() {
  return { principalId: 'principal-1', sessionId: 'session-1', scope: { ...SCOPE }, snapshotId: 'snapshot-1', recordNamespace: 'client_record' };
}

function facts(overrides = {}) {
  return { ...accessRequest(), accessRevision: 'access-1', identityStatus: 'active', tenantStatus: 'active', membershipStatus: 'active', deviceStatus: 'active',
    licenseStatus: 'expired', licenseExpiresAt: 999, sessionExpiresAt: 10000, evidenceExpiresAt: 8000, historyReadAllowed: true, captureAllowed: true, ...overrides };
}

function getter(target, key, reads) {
  Object.defineProperty(target, key, { configurable: true, get() { reads.count += 1; throw new Error('private input'); } });
  return target;
}

for (const filter of FILTERS) {
  test(`${filter} filters the complete lightweight set before paging in presenter, catalog and decoder`, () => {
    const catalog = buildResultCatalog(manifest());
    for (const offset of [0, 1, 2, 8, 50]) {
      const query = { filter, offset, limit: 2 };
      const expectedIds = EXPECTED[filter].slice(offset, offset + 2);
      const expectedCounts = { all: 9, attention: 8, matching: EXPECTED[filter].length };
      const simple = presentResultPage(rows(), query);
      const sourced = catalog.readPage(query);
      const decoded = decodeResultPage(sourced, SCOPE, query);
      assert.deepEqual(simple.items.map(item => item.id), expectedIds);
      assert.deepEqual(sourced.items.map(item => item.id), expectedIds);
      assert.ok(decoded);
      assert.deepEqual(decoded.page.items.map(item => item.id), expectedIds);
      for (const value of [simple, sourced, decoded.page]) assert.deepEqual(value.counts, expectedCounts);
      assert.equal(decoded.page.page.filter, filter);
      assert.equal(decoded.page.page.hasNext, offset + expectedIds.length < EXPECTED[filter].length);
      assert.equal(Object.isFrozen(decoded.page.items), true);
      for (const item of decoded.page.items) assert.equal(Object.isFrozen(item.review.reasons), true);
    }
  });

  test(`${filter} supports exact empty and beyond-end pages without calling them errors`, () => {
    for (const offset of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const query = { filter, offset, limit: 50 };
      const catalogPage = buildResultCatalog(manifest([])).readPage(query);
      const simple = presentResultPage([], query);
      const decoded = decodeResultPage(catalogPage, SCOPE, query);
      for (const result of [simple, catalogPage, decoded.page]) {
        assert.deepEqual(result.items, []);
        assert.deepEqual(result.counts, { all: 0, attention: 0, matching: 0 });
      }
    }
  });
}

test('new filter strings remain exact while legacy display fallback remains unchanged', () => {
  for (const filter of FILTERS) assert.deepEqual(readQuery({ filter }), { filter, offset: 0, limit: 50 });
  for (const filter of ['issue', 'UNVERIFIED', 'intervention ', 'constructor', '__proto__', null, undefined, 1]) {
    assert.equal(readQuery({ filter }), null);
    assert.equal(presentResultPage(rows(), { filter }).page.filter, 'all');
    assert.throws(() => buildResultCatalog(manifest()).readPage({ filter }), error => error instanceof TypeError && error.message === 'Invalid result catalog');
  }
});

test('overlapping review groups are intentionally non-additive and preserve exact old attention totals', () => {
  const catalog = buildResultCatalog(manifest());
  assert.deepEqual(catalog.readPage({ filter: 'attention' }).counts, { all: 9, attention: 8, matching: 8 });
  assert.equal(catalog.readPage({ filter: 'unverified' }).items.some(item => item.id === 'overlap'), true);
  assert.equal(catalog.readPage({ filter: 'issues' }).items.some(item => item.id === 'overlap'), true);
  assert.equal(catalog.readPage({ filter: 'issues' }).items.some(item => item.id === 'intervention'), true);
  for (const filter of ['unverified', 'issues', 'intervention']) {
    const page = catalog.readPage({ filter });
    assert.deepEqual(Object.keys(page.counts).sort(), ['all', 'attention', 'matching']);
    assert.equal(page.items.some(item => ['stopped', 'local-pending'].includes(item.id)), false);
  }
});

test('catalog builds new indexes once without retaining original sources or reading heavy details', () => {
  let sealed = false; let descriptorReads = 0; const forbiddenReads = { count: 0 };
  const track = value => new Proxy(value, { getOwnPropertyDescriptor(target, key) {
    descriptorReads += 1;
    if (sealed) throw new Error('retained source');
    return Object.getOwnPropertyDescriptor(target, key);
  } });
  const values = Array.from({ length: 1500 }, (_, i) => {
    const value = rows()[i % 9]; value.id = `record-${i}`;
    for (const key of ['body', 'comments', 'payload', 'review', 'allowedActions']) getter(value, key, forbiddenReads);
    return track(value);
  });
  const input = manifest(values); const catalog = buildResultCatalog(track(input));
  const builtReads = descriptorReads; sealed = true;
  for (const filter of FILTERS) {
    const matching = Array.from({ length: 1500 }, (_, i) => i).filter(i => EXPECTED[filter].includes(rows()[i % 9].id)).map(i => `record-${i}`);
    for (const offset of [0, 50, 100, 1499]) {
      const query = { filter, offset, limit: 50 };
      const page = catalog.readPage(query);
      assert.deepEqual(page.items.map(item => item.id), matching.slice(offset, offset + 50));
      assert.equal(page.items.length <= 50, true);
      assert.equal(page.counts.matching, matching.length);
      assert.ok(decodeResultPage(page, SCOPE, query));
    }
  }
  assert.equal(descriptorReads, builtReads);
  assert.equal(forbiddenReads.count, 0);
});

for (const filter of ['unverified', 'issues', 'intervention']) {
  test(`${filter} decoder recomputes visible rows and refuses forged source review claims`, () => {
    const item = summary('forged');
    item.review = { unverified: true, hasIssue: true, interventionReported: true };
    item.needsAttention = true;
    const response = envelope([item], filter, { all: 1, attention: 1, matching: 1 });
    assert.equal(decodeResultPage(response, SCOPE, response.query), null);
    const genuinelyMatching = rows().find(value => value.id === EXPECTED[filter][0]);
    genuinelyMatching.review = { unverified: false, hasIssue: false, interventionReported: false };
    response.items = [genuinelyMatching];
    const result = decodeResultPage(response, SCOPE, response.query);
    assert.ok(result);
    assert.notDeepEqual(result.page.items[0].review, genuinelyMatching.review);
  });

  test(`${filter} decoder enforces safe counts, exact page length and visible filter membership`, () => {
    const item = rows().find(value => value.id === EXPECTED[filter][0]);
    const response = envelope([item], filter, { all: 1, attention: 1, matching: 1 });
    assert.ok(decodeResultPage(response, SCOPE, response.query));
    for (const counts of [{ all: 1, attention: 0, matching: 1 }, { all: 1, attention: 1, matching: 2 }, { all: 1, attention: 2, matching: 1 }, { all: 1, attention: 1, matching: 0 }, { all: 1, attention: 1, matching: 1.5 }]) {
      assert.equal(decodeResultPage({ ...response, counts }, SCOPE, response.query), null);
    }
    assert.equal(decodeResultPage({ ...response, items: [] }, SCOPE, response.query), null);
    assert.equal(decodeResultPage({ ...response, items: [item, item] }, SCOPE, response.query), null);
    assert.equal(decodeResultPage({ ...response, items: [summary('stopped', 'stopped')] }, SCOPE, response.query), null);
  });

  test(`${filter} decoder ignores irrelevant hostile claims and preserves exact query echo`, () => {
    const reads = { count: 0 };
    const item = rows().find(value => value.id === EXPECTED[filter][0]);
    for (const key of ['review', 'body', 'comments', 'needsUserAction', 'allowedActions']) getter(item, key, reads);
    const response = envelope([item], filter, { all: 1, attention: 1, matching: 1 });
    assert.ok(decodeResultPage(response, SCOPE, response.query));
    assert.equal(decodeResultPage({ ...response, query: { ...response.query, filter: 'all' } }, SCOPE, response.query), null);
    assert.equal(reads.count, 0);
  });
}

test('new matching counts are bounded source claims, not fabricated totals for unseen rows', () => {
  const query = { filter: 'issues', offset: 50, limit: 1 };
  const response = envelope([summary('issue-at-51', 'failed')], 'issues', { all: 1500, attention: 100, matching: 60 }, { query });
  const result = decodeResultPage(response, SCOPE, query);
  assert.deepEqual(result.page.counts, response.counts);
  assert.equal(result.page.page.hasNext, true);
  assert.deepEqual(Object.keys(result.page.counts).sort(), ['all', 'attention', 'matching']);
});

test('expired history access composes through U4 authorizer, U3 source and U2 filtered selection without capture authority', async t => {
  let factReads = 0; const detailCalls = [];
  const authorize = createHistoryReadAuthorizer({ identity: { principalId: 'principal-1', sessionId: 'session-1' }, now: () => 1000,
    readAccessFacts() { factReads += 1; return facts(); } });
  const source = createSnapshotResultSource({ manifest: manifest(), authorize, now: () => 1000,
    loadDetail(request) { detailCalls.push(request); return { ...request, detail: { body: '合成历史正文', comments: [] } }; } });
  const session = createResultReadSession({ scope: SCOPE, source });
  t.after(() => { session.close(); source.close(); });
  for (const filter of ['unverified', 'issues', 'intervention']) {
    const result = await session.readPage({ filter, offset: 0, limit: 2 });
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.page.items.map(item => item.id), EXPECTED[filter].slice(0, 2));
    assert.deepEqual(result.page.counts, { all: 9, attention: 8, matching: EXPECTED[filter].length });
    const selected = await session.readDetail({ recordId: result.page.items[0].id, pageToken: result.pageToken });
    assert.equal(selected.status, 'ready');
    assert.equal(selected.detail.body, '合成历史正文');
  }
  assert.equal(factReads, 12);
  assert.equal(detailCalls.length, 3);
  const issue = presentResult(summary('intervention', 'needs_action'));
  assert.equal(issue.review.interventionReported, true);
  const decision = evaluateAccessPolicy({ ...facts(), review: issue.review, needsUserAction: true }, accessRequest(), 1000);
  assert.equal(decision.history.allowed, true);
  assert.equal(decision.capture.allowed, false);
  assert.equal(decision.capture.reason, 'license_expired');
  assert.deepEqual(Object.keys(source).sort(), ['close', 'readRecordDetail', 'readSummaryPage']);
});

for (const licenseStatus of ['frozen', 'revoked']) {
  test(`reported intervention cannot override ${licenseStatus} access in the actual read flow`, async t => {
    let detailCalls = 0;
    const authorize = createHistoryReadAuthorizer({ identity: { principalId: 'principal-1', sessionId: 'session-1' }, now: () => 1000,
      readAccessFacts() { return facts({ licenseStatus, review: { interventionReported: true }, needsUserAction: true }); } });
    const source = createSnapshotResultSource({ manifest: manifest([summary('intervention', 'needs_action')]), authorize, now: () => 1000,
      loadDetail() { detailCalls += 1; throw new Error('must not load'); } });
    const session = createResultReadSession({ scope: SCOPE, source });
    t.after(() => { session.close(); source.close(); });
    const result = await session.readPage({ filter: 'intervention' });
    assert.equal(result.status, 'read_failed');
    assert.equal(detailCalls, 0);
    assert.equal(Object.hasOwn(result, 'page'), false);
    const decision = evaluateAccessPolicy(facts({ licenseStatus }), accessRequest(), 1000);
    assert.equal(decision.history.allowed, false);
    assert.equal(decision.capture.allowed, false);
  });
}
