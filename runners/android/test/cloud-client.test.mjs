import assert from 'node:assert/strict';
import test from 'node:test';
import {createCloudClient, normalizeCloudUrl, CloudRequestError}
  from '../src/cloud/client.mjs';
import {deliverPendingBatch} from '../src/cloud/delivery.mjs';

const token = 'local-fixture-token';
const result = receipts => ({ok: true, uploadBatchId: 'batch-1', receipts});
const receipt = {eventId: 'event-1', receiptId: 'receipt-1', status: 'accepted'};

test('cloud transport allows loopback testing and refuses credentials or cleartext external servers', () => {
  assert.equal(normalizeCloudUrl('https://capture.example'), 'https://capture.example');
  assert.equal(normalizeCloudUrl('http://127.0.0.1:3333'), 'http://127.0.0.1:3333');
  for (const url of ['http://capture.example', 'https://u:p@capture.example',
    'https://capture.example?token=secret', 'https://capture.example/api', 'file:///tmp']) {
    assert.throws(() => normalizeCloudUrl(url));
  }
});

test('cloud transport binds token to origin, forbids redirects and returns receipt envelope', async () => {
  const client = createCloudClient({baseUrl: 'https://capture.example', agentToken: token,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://capture.example/api/capture-cloud/agent/discoveries');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-capture-agent-token'], token);
      assert.deepEqual(JSON.parse(options.body), {uploadBatchId: 'batch-1', events: []});
      return Response.json(result([]));
    }});
  assert.deepEqual(await client.ingest({uploadBatchId: 'batch-1', events: []}), result([]));
});

test('busy responses honor Retry-After without exposing server text or credentials', async () => {
  const client = createCloudClient({baseUrl: 'https://capture.example', agentToken: token,
    fetchImpl: async () => new Response(`sensitive ${token}`, {status: 503, headers: {'Retry-After': '12'}})});
  await assert.rejects(client.getReceipts('batch-1'), error => {
    assert.equal(error.retryAfterMs, 12000);
    assert.equal(error.retryable, true);
    assert.equal(error.message, 'cloud_http_503');
    return true;
  });
});

test('deadline stays bounded when a broken transport ignores abort', async () => {
  const client = createCloudClient({baseUrl: 'https://capture.example', agentToken: token,
    timeoutMs: 10, fetchImpl: () => new Promise(() => {})});
  await assert.rejects(client.ingest({}), {code: 'cloud_timeout'});
});

test('stop aborts cloud I/O promptly even if transport ignores its signal', async () => {
  const controller = new AbortController();
  const client = createCloudClient({baseUrl: 'https://capture.example', agentToken: token,
    fetchImpl: () => new Promise(() => {})});
  const operation = client.getReceipts('batch-1', {signal: controller.signal});
  controller.abort();
  await assert.rejects(operation, {code: 'cloud_aborted'});
});

test('already stopped requests never invoke fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createCloudClient({baseUrl: 'https://capture.example', agentToken: token,
    fetchImpl: () => assert.fail('fetch must not run')});
  await assert.rejects(client.getReceipts('batch-1', {signal: controller.signal}), {code: 'cloud_aborted'});
});

test('malformed or oversized success payloads cannot acknowledge a queue', async () => {
  for (const response of [Response.json({ok: true}), new Response('not-json'),
    new Response('x'.repeat(300000))]) {
    const client = createCloudClient({baseUrl: 'https://capture.example', agentToken: token,
      fetchImpl: async () => response});
    await assert.rejects(client.getReceipts('batch-1'), CloudRequestError);
  }
});

function queue() {
  const acks = [];
  return {acks, nextBatch: () => ({uploadBatchId: 'batch-1', events: [{eventId: 'event-1'}]}),
    ackBatch: (batchId, receipts) => acks.push({batchId, receipts})};
}

test('receipt recovery after a lost response avoids a second POST', async () => {
  const store = queue();
  const client = {getReceipts: async () => result([receipt]), ingest: () => assert.fail('must not POST')};
  assert.equal((await deliverPendingBatch({store, client})).status, 'delivered');
  assert.equal(store.acks.length, 1);
});

test('unacknowledged events are delivered with stable batch identity', async () => {
  const store = queue();
  const client = {getReceipts: async () => result([]), ingest: async batch => {
    assert.equal(batch.uploadBatchId, 'batch-1');
    return result([receipt]);
  }};
  assert.equal((await deliverPendingBatch({store, client})).status, 'delivered');
});

test('503 defers without changing queue and preserved retry state suppresses another request', async () => {
  const store = queue();
  let calls = 0;
  const client = {getReceipts: async () => {
    calls++;
    throw new CloudRequestError('cloud_http_503', {retryable: true, retryAfterMs: 12000});
  }};
  const first = await deliverPendingBatch({store, client, now: () => 100, random: () => 0});
  assert.equal(first.retryState.nextAttemptAt, 12100);
  assert.equal(store.acks.length, 0);
  await deliverPendingBatch({store, client, retryState: first.retryState, now: () => 200});
  assert.equal(calls, 1);
});

test('foreign and duplicate receipts, identity mismatch and incomplete replies never drain the queue', async () => {
  for (const reply of [{...result([receipt]), uploadBatchId: 'foreign'},
    result([{...receipt, eventId: 'foreign'}]), result([receipt, receipt]),
    result([{...receipt, receiptId: ''}])]) {
    const store = queue();
    const outcome = await deliverPendingBatch({store, client: {getReceipts: async () => reply}});
    assert.equal(outcome.status, 'needs_action');
    assert.equal(store.acks.length, 0);
  }
});

test('explicit stop performs no network or queue mutation', async () => {
  const controller = new AbortController();
  controller.abort();
  const store = queue();
  const outcome = await deliverPendingBatch({store, client: {}, signal: controller.signal});
  assert.equal(outcome.status, 'stopped');
  assert.deepEqual(store.acks, []);
});
