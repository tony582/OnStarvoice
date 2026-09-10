import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {createRecordSyncQueue} from '../../utils/record-sync-queue.js';
import {CAPTURE_PUBLISH_WINDOW_EXCLUSION as REASON, isCapturePublishWindowExclusion,
  isStoredCapturePublishWindowExclusion, hasNewCaptureAfterPublishWindowExclusion,
} from '../../utils/capture-publish-window-exclusion.js';
import {normalizeCaptureLocalClosureEvidence} from '../../server/services/capture-local-closure-proof.js';
import {STORAGE_KEY} from '../../utils/constants.js';
import {beginTaskContext, completeTaskContext} from '../../utils/task-context.js';
import {serializeRecordEnvelope} from '../../utils/platform/record-envelope.js';

let store = {};
globalThis.chrome = {
  storage: {local: {
    async get(keys) {
      if (keys == null) return structuredClone(store);
      const list = Array.isArray(keys) ? keys : typeof keys === 'object' ? Object.keys(keys) : [keys];
      return structuredClone(Object.fromEntries(list.map(key => [key, store[key] ?? null])));
    },
    async set(values) { Object.assign(store, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
  }},
  runtime: {async sendMessage() { return {ok: true}; }},
};
const {syncRecord, syncRecordBatch} = await import('../../utils/capture-sync.js');
const {getRecord, getDataPool, setDataPool, runDataPoolMutation} = await import('../../utils/storage.js');

function rejection(recordId) {
  return {ok: false, action: 'skipped', recordId, backendRecordId: null,
    reason: REASON, message: '发布时间超出本次采集范围，已拦截', retryable: false};
}
function reset(ids) {
  store = {
    [STORAGE_KEY.AUTH]: {code: 'TEST-ONLY'},
    [STORAGE_KEY.RUNTIME]: {clientUuid: 'test-client', appVersion: '0.4.7'},
    [STORAGE_KEY.DATA_POOL]: {records: ids.map(id => ({id, type: 'keyword_notes',
      platform: 'douyin', status: 'draft', payload: {keyword: 'test',
        items: [{noteId: id, title: id, publishTime: '2025-01-01',
          url: `https://www.douyin.com/video/${id}`}],
        detailPayload: {title: id, publishTime: '2025-01-01',
          comments: [{content: '购买咨询', userName: 'test'}]},
      }}))},
  };
  store[STORAGE_KEY.DATA_POOL].records = store[STORAGE_KEY.DATA_POOL].records.map(serializeRecordEnvelope);
}
const options = {requestSpacingMs: 0, rateLimitBaseDelayMs: 0,
  captureSettings: {}, commentLeadsConfig: {enabled: true, keywords: ['购买']}};

test('single 422 is excluded with zero inserts and no comment-leads upload', async () => {
  reset(['old']);
  const calls = [];
  globalThis.fetch = async (url, request) => {
    calls.push({url, body: JSON.parse(request.body)});
    return new Response(JSON.stringify(rejection('old')), {status: 422});
  };
  const result = await syncRecord('old', null, options);
  assert.equal(result.excluded, true);
  assert.equal(result.successCount, 0);
  assert.equal(result.failedCount, 0);
  assert.equal(result.excludedCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.syncType, 'keyword_notes');
  const saved = await getRecord('old');
  assert.equal(saved.status, 'draft');
  assert.equal(saved.lastSyncReason, REASON);
  const history = store[STORAGE_KEY.SYNC_HISTORY].entries[0];
  assert.equal(history.successCount, 0);
  assert.equal(history.failedCount, 0);
  assert.equal(history.excludedCount, 1);
});

test('all-excluded batch is terminal without retries, pause, leads or fake successes', async () => {
  reset(['old-a', 'old-b']);
  const calls = [];
  globalThis.fetch = async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({url, body});
    return new Response(JSON.stringify({ok: true, data: {items: body.records.map(r => rejection(r.recordId))}}));
  };
  const result = await syncRecordBatch(['old-a', 'old-b'], null, options);
  assert.equal(result.ok, true);
  assert.equal(result.excluded, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, REASON);
  assert.equal(result.successCount, 0);
  assert.equal(result.failedCount, 0);
  assert.equal(result.excludedCount, 2);
  assert.equal(result.pausedCount, 0);
  assert.equal(result.commentLeadsSyncedCount, 0);
  assert.equal(result.commentLeadsFailedCount, 0);
  assert.equal(calls.reduce((n, c) => n + c.body.records.length, 0), 2);
  assert.ok(calls.every(c => c.url.endsWith('/sync/batch')));
  assert.ok(result.results.every(r => r.success === false && r.excluded === true));
});

test('a rejected local record cannot be replayed without a new explicit valid task scope', async () => {
  reset(['old']);
  store[STORAGE_KEY.DATA_POOL].records[0].lastSyncReason = REASON;
  let calls = 0;
  const newTaskId = '22222222-2222-4222-8222-222222222222';
  beginTaskContext({metadata: {requestId: '11111111-1111-4111-8111-111111111111'}});
  globalThis.fetch = async (_url, request) => {
    calls += 1;
    const body = JSON.parse(request.body);
    assert.equal(body.records[0].captureTaskId, newTaskId);
    return new Response(JSON.stringify({ok: true, data: {items:
      body.records.map(r => ({ok: true, recordId: r.recordId, action: 'inserted'})),
    }}));
  };
  try {
    const single = await syncRecord('old', null, options);
    const batch = await syncRecordBatch(['old'], null, options);
    const invalid = await syncRecordBatch(['old'], null, {...options, captureTaskId: 'not-a-server-task'});
    assert.equal(single.excludedCount, 1);
    assert.equal(batch.excludedCount, 1);
    assert.equal(invalid.excludedCount, 1);
    assert.equal(calls, 0);
    const rechecked = await syncRecordBatch(['old'], null,
      {...options, captureTaskId: newTaskId, commentLeadsConfig: {enabled: false}});
    assert.equal(calls, 1);
    assert.equal(rechecked.successCount, 1);
    assert.equal((await getRecord('old')).lastSyncReason, 'none');
  } finally { completeTaskContext(); }
});

test('only a valid newer capture timestamp releases an unscoped rejected record', () => {
  const lastSyncedAt = Date.now() - 1000;
  const record = {lastSyncReason: REASON, lastSyncedAt, updatedAt: Date.now(),
    payload: {captureTimestamp: lastSyncedAt - 1}};
  assert.equal(isStoredCapturePublishWindowExclusion(record), true,
    'ordinary updatedAt changes are not recapture evidence');
  for (const captureTimestamp of [undefined, null, '', true, Infinity, NaN,
    '2026-09-10', {}, lastSyncedAt, lastSyncedAt - 1]) {
    assert.equal(isStoredCapturePublishWindowExclusion({...record, payload: {captureTimestamp}}), true);
  }
  for (const captureTimestamp of [lastSyncedAt + 1, String(lastSyncedAt + 1)]) {
    assert.equal(isStoredCapturePublishWindowExclusion({...record, payload: {captureTimestamp}}), false);
  }
  assert.equal(isStoredCapturePublishWindowExclusion({...record,
    lastSyncedAt: null, payload: {captureTimestamp: Date.now()}}), true,
  'missing rejection time cannot prove that the capture is newer');
});

async function dedupeHarness() {
  const source = await readFile(new URL('../../utils/capture-sync.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('async function saveRecordsWithCacheDedupe('),
    source.indexOf('async function saveCaptureResultRecords('));
  const key = record => `${record.platform}:${record.payload.keyword}:${record.payload.items[0].noteId}`;
  const context = vm.createContext({runDataPoolMutation, getDataPool, setDataPool,
    buildDataPoolIdentityIndex: records => new Map(records.map(record => [key(record), record])),
    resolveRecordIdentityKeys: record => [key(record)],
    isListCaptureRecordType: type => type === 'keyword_notes',
    mergeCaptureTraceIntoExistingRecord: () => ({changed: false, binding: null}),
    mergeKeywordMatchLabelsInPlace: () => false,
    refreshListCaptureSourceUrlInPlace: () => false,
    refreshListCaptureMetricsInPlace: () => false,
    sortCaptureTraceBindings: bindings => bindings,
    hasNewCaptureAfterPublishWindowExclusion,
  });
  vm.runInContext(`${section}\nglobalThis.save = saveRecordsWithCacheDedupe;`, context);
  return context.save;
}

test('recapturing the same rejected note reuses its ID and syncs without the old day scope', async () => {
  reset(['old']);
  const lastSyncedAt = Date.now() - 1000;
  const original = store[STORAGE_KEY.DATA_POOL].records[0];
  original.lastSyncReason = REASON;
  original.lastSyncedAt = lastSyncedAt;
  original.normalizedPayload.captureTimestamp = lastSyncedAt - 1;
  original.normalizedPayload.captureTaskId = '11111111-1111-4111-8111-111111111111';
  original.meta = {captureTaskId: original.normalizedPayload.captureTaskId};
  const fresh = structuredClone(await getRecord('old'));
  fresh.id = 'new-capture-local-id';
  fresh.payload.captureTimestamp = lastSyncedAt + 1;
  delete fresh.payload.captureTaskId;
  delete fresh.meta.captureTaskId;
  const save = await dedupeHarness();
  const saved = await save([fresh]);
  assert.deepEqual(Array.from(saved.syncRecordIds), ['old']);
  const cached = await getRecord('old');
  assert.equal((await getDataPool()).records.length, 1);
  assert.equal(cached.payload.captureTimestamp, lastSyncedAt + 1);
  assert.equal(cached.payload.captureTaskId, undefined);
  assert.equal(cached.meta.captureTaskId, undefined);
  let requests = 0;
  globalThis.fetch = async (_url, request) => {
    requests += 1;
    const body = JSON.parse(request.body);
    assert.equal(body.records[0].captureTaskId, '');
    return new Response(JSON.stringify({ok: true, data: {items:
      body.records.map(r => ({ok: true, recordId: r.recordId, action: 'updated'})),
    }}));
  };
  const result = await syncRecordBatch(Array.from(saved.syncRecordIds), null,
    {...options, trigger: 'capture_auto', commentLeadsConfig: {enabled: false}});
  assert.equal(requests, 1);
  assert.equal(result.successCount, 1);
  assert.equal(result.excludedCount, 0);
  assert.equal((await getRecord('old')).lastSyncReason, 'none');
});

test('ordinary stable dedupe does not change capture timestamps or force another upload', async () => {
  reset(['old']);
  const original = store[STORAGE_KEY.DATA_POOL].records[0];
  original.lastSyncedAt = Date.now() - 1000;
  original.normalizedPayload.captureTimestamp = original.lastSyncedAt - 1;
  const fresh = structuredClone(await getRecord('old'));
  fresh.id = 'duplicate';
  fresh.payload.captureTimestamp = Date.now();
  const save = await dedupeHarness();
  const saved = await save([fresh]);
  assert.deepEqual(Array.from(saved.syncRecordIds), []);
  assert.equal((await getRecord('old')).payload.captureTimestamp, original.lastSyncedAt - 1);
});

test('manual pending sync never binds older records to an unrelated active day task', async () => {
  reset(['unbound', 'bound']);
  const ownTaskId = '22222222-2222-4222-8222-222222222222';
  store[STORAGE_KEY.DATA_POOL].records[1].meta = {captureTaskId: ownTaskId};
  beginTaskContext({metadata: {requestId: '11111111-1111-4111-8111-111111111111'}});
  const sent = [];
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (!body.records) {
      sent.push({recordId: 'unbound', captureTaskId: body.captureTaskId});
      return new Response(JSON.stringify({ok: true, action: 'inserted'}));
    }
    sent.push(...body.records);
    return new Response(JSON.stringify({ok: true, data: {items: body.records.map(r =>
      ({ok: true, recordId: r.recordId, action: 'inserted'}))}}));
  };
  try {
    const single = await syncRecord('unbound', null, {...options, commentLeadsConfig: {enabled: false}});
    const batch = await syncRecordBatch(['unbound', 'bound'], null,
      {...options, commentLeadsConfig: {enabled: false}});
    assert.equal(single.ok, true);
    assert.equal(batch.successCount, 2);
    assert.deepEqual(sent.map(r => [r.recordId, r.captureTaskId]),
      [['unbound', ''], ['unbound', ''], ['bound', ownTaskId]]);
  } finally { completeTaskContext(); }
});

test('mixed batch keeps real failures separate and continues after an excluded item', async () => {
  reset(['old', 'new', 'failure']);
  const uploaded = [];
  globalThis.fetch = async (url, request) => {
    const body = JSON.parse(request.body);
    const items = body.records.map(r => {
      uploaded.push(r.recordId);
      return r.recordId === 'old' ? rejection(r.recordId) : r.recordId === 'failure'
        ? {ok: false, recordId: r.recordId, action: 'skipped', reason: 'server_error', message: '写入失败'}
        : {ok: true, recordId: r.recordId, action: 'inserted'};
    });
    return new Response(JSON.stringify({ok: true, data: {items}}));
  };
  const result = await syncRecordBatch(['old', 'new', 'failure'], null,
    {...options, commentLeadsConfig: {enabled: false}});
  assert.equal(result.ok, false);
  assert.equal(result.successCount, 1);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.pausedCount, 0);
  assert.deepEqual(uploaded, ['old', 'new', 'failure']);
  assert.equal((await getRecord('new')).status, 'synced');
  assert.equal((await getRecord('failure')).status, 'failed');
});

function closureFor(stats) {
  const sync = Object.fromEntries(Object.entries(stats).map(([key, value]) =>
    [`streamingSync${key[0].toUpperCase()}${key.slice(1)}`, value]));
  return normalizeCaptureLocalClosureEvidence({
    version: 2, requestId: 'request-1', attemptId: 'attempt-1',
    itemId: '11111111-1111-4111-8111-111111111111',
    itemAttemptId: '22222222-2222-4222-8222-222222222222',
    attemptNumber: 1, assignmentRevision: 1, snapshotRevision: 1,
    terminalStatus: 'completed', terminalUpdatedAt: '2026-09-10T01:00:00Z',
    closedAt: '2026-09-10T01:00:01Z', terminalLedgerConfirmed: true,
    runnerTabCount: 0, platformTaskTabCount: 0, detailTaskTabCount: 0, ownedTaskTabCount: 0,
    executionLockPresent: false, debugSessionPresent: false, taskSessionPresent: false,
    taskOwnerPresent: false, pendingCheckpointReportCount: 0,
    businessUploadEvidenceKnown: true, streamingSyncDrainCompleted: true,
    capturedRecordCount: stats.capturedUniqueCount, ...sync,
  });
}

test('queue reclassifies a delayed detail rejection into verifiable exclusion coverage', async () => {
  let release;
  let calls = 0;
  const queue = createRecordSyncQueue({retryDelaysMs: [0, 0], shouldRetry: () => true,
    async processRecord({recordId}) {
      calls += 1;
      if (calls === 1) return {ok: true};
      await new Promise(resolve => { release = resolve; });
      return rejection(recordId);
    }});
  queue.registerCaptured(['old']);
  queue.enqueue('old');
  await queue.drain();
  queue.enqueue('old');
  while (!release) await Promise.resolve();
  queue.enqueue('old', {revision: 'dirty'});
  release();
  const stats = await queue.drain();
  assert.equal(calls, 2);
  assert.equal(stats.successCount, 0);
  assert.equal(stats.failedCount, 0);
  assert.equal(stats.skippedCount, 0);
  assert.equal(stats.excludedCount, 1);
  assert.equal(stats.excludedUniqueCount, 1);
  assert.equal(stats.enqueuedUniqueCount, 0);
  assert.equal(stats.succeededUniqueCount, 0);
  assert.equal(stats.retryCount, 0);
  assert.equal(stats.remainingCount, 0);
  assert.ok(closureFor(stats), 'existing server closure protocol must accept intentional exclusions');
  assert.equal(queue.enqueue('old'), false);
  assert.equal(queue.enqueueMissing(['old']), 0);
});

test('queue continues later records and preserves unrelated skipped/failure handling', async () => {
  const queue = createRecordSyncQueue({async processRecord({recordId}) {
    return recordId === 'old' ? rejection(recordId) : {ok: true};
  }});
  queue.registerCaptured(['old', 'new']);
  queue.enqueue('old');
  queue.enqueue('new');
  const stats = await queue.drain();
  assert.equal(stats.successCount, 1);
  assert.equal(stats.excludedCount, 1);
  assert.ok(closureFor(stats));
  for (const reason of ['stale_attempt', 'server_error', 'comment_workflow_capacity']) {
    assert.equal(isCapturePublishWindowExclusion({ok: false, action: 'skipped', reason}), false);
  }
});

test('sidebar treats exclusion coverage as a completed task and reports the exclusion', async () => {
  const source = await readFile(new URL('../../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('function formatStreamingSyncSummary('),
    source.indexOf('function buildStreamingSyncTaskMetadata('));
  const context = vm.createContext({});
  vm.runInContext(`${section}\nglobalThis.summary = formatStreamingSyncSummary; globalThis.issue = buildStreamingSyncTaskIssue;`, context);
  const stats = {enabled: true, enqueuedCount: 0, successCount: 0, excludedCount: 2,
    failedCount: 0, remainingCount: 0, blocked: false};
  assert.equal(context.issue(stats), null);
  assert.match(context.summary(stats), /已排除 2/);
  assert.match(context.summary(stats), /同步成功 0/);
  assert.equal(context.issue({...stats, failedCount: 1}).code, 'STREAMING_SYNC_INCOMPLETE');
});
