import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createRecordSyncQueue} from '../../utils/record-sync-queue.js';
import {STORAGE_KEY} from '../../utils/constants.js';
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
const {syncRecordBatch} = await import('../../utils/capture-sync.js');
const {getRecord} = await import('../../utils/storage.js');

function reset(ids) {
  store = {
    [STORAGE_KEY.AUTH]: {code: 'TEST-ONLY'},
    [STORAGE_KEY.RUNTIME]: {clientUuid: 'test-client', appVersion: '0.4.32'},
    [STORAGE_KEY.DATA_POOL]: {records: ids.map(id => serializeRecordEnvelope({id, type: 'keyword_notes',
      platform: 'douyin', status: 'draft', payload: {keyword: 'test',
        items: [{noteId: id, title: id, url: `https://www.douyin.com/video/${id}`}]}}))},
  };
}
const options = {requestSpacingMs: 0, rateLimitBaseDelayMs: 0, rateLimitMaxDelayMs: 0, captureSettings: {}};
const accepted = recordId => ({ok: true, action: 'inserted', recordId, backendRecordId: `srv-${recordId}`, id: `srv-${recordId}`});
const busyItem = recordId => ({ok: false, action: 'skipped', recordId, reason: 'server_busy',
  message: '服务当前繁忙，本条数据稍后自动重传', retryAfterMs: 1,
  error: {reason: 'server_busy', message: '服务当前繁忙，本条数据稍后自动重传', retryable: true, retryAfterMs: 1}});

test('a per-record database busy refusal is resent instead of marking the record failed', async () => {
  reset(['7700000000000000001']);
  let calls = 0;
  globalThis.fetch = async (url, request) => {
    calls += 1;
    const body = JSON.parse(request.body);
    const items = body.records.map(r => calls < 3 ? busyItem(r.recordId) : accepted(r.recordId));
    return new Response(JSON.stringify({ok: true, data: {items}}));
  };
  const result = await syncRecordBatch(['7700000000000000001'], null, options);
  assert.equal(calls, 3, 'two backoff resends, then accepted');
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 0);
  assert.notEqual((await getRecord('7700000000000000001')).status, 'failed');
});

test('a whole-request 503 busy response is resent like a rate limit', async () => {
  reset(['7700000000000000002']);
  let calls = 0;
  globalThis.fetch = async (url, request) => {
    calls += 1;
    const body = JSON.parse(request.body);
    if (calls === 1) {
      return new Response(JSON.stringify({ok: false, error: 'server_busy',
        code: 'database_capacity_unavailable', retryAfterMs: 1, message: '服务当前繁忙，请稍后重试'}), {status: 503});
    }
    return new Response(JSON.stringify({ok: true, data: {items: body.records.map(r => accepted(r.recordId))}}));
  };
  const result = await syncRecordBatch(['7700000000000000002'], null, options);
  assert.equal(calls, 2);
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 0);
});

test('a stale attempt stays terminal even when other refusals are retryable', async () => {
  reset(['7700000000000000003']);
  let calls = 0;
  globalThis.fetch = async (url, request) => {
    calls += 1;
    const body = JSON.parse(request.body);
    return new Response(JSON.stringify({ok: true, data: {items: body.records.map(r => ({
      ok: false, action: 'skipped', recordId: r.recordId, reason: 'stale_attempt', message: 'stale',
      error: {reason: 'stale_attempt', message: 'stale', retryable: true}}))}}));
  };
  const result = await syncRecordBatch(['7700000000000000003'], null, options);
  assert.equal(calls, 1);
  assert.equal(result.successCount, 0);
  assert.equal(result.failedCount, 1);
});

test('a later successful resend clears the queue failure count and only transient failures are resent', async () => {
  const outcomes = new Map([['a', [{ok: false, reason: 'server_busy', message: 'server busy'}, {ok: true}]],
    ['b', [{ok: false, reason: 'invalid_record', message: 'bad'}]]]);
  const queue = createRecordSyncQueue({
    retryDelaysMs: [],
    shouldRetry: result => result?.ok === false && /busy/.test(result.reason),
    processRecord: async ({recordId}) => outcomes.get(recordId).shift() || {ok: true},
  });
  queue.enqueue('a');
  queue.enqueue('b');
  let stats = await queue.drain();
  assert.equal(stats.failedCount, 2);
  assert.equal(queue.countRetryableFailed(), 1);
  assert.equal(queue.retryFailed(), 1);
  stats = await queue.drain();
  assert.equal(stats.failedCount, 1, 'only the permanently refused record remains failed');
  assert.equal(stats.successCount, 1);
  assert.equal(queue.countRetryableFailed(), 0);
});

test('the server reports database busy as a retryable sync result and a 503', async () => {
  const sync = await readFile(new URL('../../server/routes/sync.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../server/app.js', import.meta.url), 'utf8');
  assert.match(sync, /const capacity = isDbCapacityError\(err\)[\s\S]*'server_busy'[\s\S]*retryable: capacity \|\| err\?\.retryable === true/u);
  assert.match(app, /if \(isDbCapacityError\(err\)\)[\s\S]*res\.status\(503\)[\s\S]*error: 'server_busy'/u);
});
