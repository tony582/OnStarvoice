// 2026-10-01 21:26 one discovery with a 2807-character caption was refused by the server (HTTP 400,
// INVALID_TITLEHINT). The runner treated the refusal as "needs a person", stopped uploading for good,
// and once 100 events were waiting every keyword ended at once with outbox_backlog.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {createCloudClient, CloudRequestError} from '../src/cloud/client.mjs';
import {deliverPendingBatch, summarizeDelivery, REFUSALS_BEFORE_PAUSE, REFUSAL_PAUSE_MS} from '../src/cloud/delivery.mjs';
import {daemonStatus} from '../src/daemon/local-control.mjs';
import {diagnoseRunner} from '../src/daemon/diagnose.mjs';
import {describeDelivery} from '../src/cli/up-command.mjs';
import {normalizeBatch} from '../../../server/services/capture-discovery/validation.js';

const agentId = randomUUID();
function discovery(index, extra = {}) {
  const taskId = randomUUID();
  return {eventId: randomUUID(), discoveryRunId: taskId, taskId, itemId: randomUUID(), attemptId: randomUUID(), agentId,
    requestHash: 'a'.repeat(64), assignmentRevision: 1, keyword: '别克哨兵',
    discoveredAt: new Date(Date.parse('2026-10-01T13:26:00Z') + index * 1000).toISOString(),
    verification: 'ui_bound', titleHint: `作品 ${index}`, authorHint: 'H先生随笔', rawShareUrl: 'https://v.douyin.com/example/',
    uiBinding: {profileId: 'douyin-40.6.0-de106-api27-p0', cardId: 'b'.repeat(64), kind: 'note'},
    requestedFilters: {sort: 'comprehensive'}, observedFilters: {sort: 'comprehensive'}, ...extra};
}
function seeded(events) {
  const store = new RunnerStore(':memory:');
  for (const event of events) store.recordEvent(event);
  return store;
}
// Stands in for the server: like request validation, it refuses the whole request when one event is refused.
function cloud(refused, {status = 400, serverCode = 'INVALID_TITLEHINT', known = () => []} = {}) {
  const posts = [];
  return {posts,
    getReceipts: async uploadBatchId => ({ok: true, uploadBatchId, receipts: known(uploadBatchId)}),
    ingest: async batch => {
      posts.push(batch.events.map(event => event.eventId));
      if (batch.events.some(event => refused(event))) throw new CloudRequestError(`cloud_http_${status}`, {status, serverCode});
      return {ok: true, uploadBatchId: batch.uploadBatchId,
        receipts: batch.events.map(event => ({eventId: event.eventId, receiptId: randomUUID(), status: 'accepted'}))};
    }};
}
// Behaves like the real ingestion: the request is validated as a whole before anything is saved, then
// events are saved one by one, so a refusal in the middle leaves the earlier ones accepted for good.
function faithfulServer({invalid = () => false, superseded = () => false} = {}) {
  const saved = new Map();
  const posts = [];
  return {saved, posts,
    getReceipts: async uploadBatchId => ({ok: true, uploadBatchId,
      receipts: [...saved.values()].filter(row => row.uploadBatchId === uploadBatchId).map(row => row.receipt)}),
    ingest: async batch => {
      posts.push(batch.events.map(event => event.eventId));
      if (batch.events.some(invalid)) throw new CloudRequestError('cloud_http_400', {status: 400, serverCode: 'INVALID_TITLEHINT'});
      const receipts = [];
      for (const event of batch.events) {
        const existing = saved.get(event.eventId);
        if (existing && existing.uploadBatchId !== batch.uploadBatchId) {
          throw new CloudRequestError('cloud_http_409', {status: 409, serverCode: 'EVENT_BATCH_CONFLICT'});
        }
        if (existing) { receipts.push({...existing.receipt, status: 'duplicate'}); continue; }
        if (superseded(event)) throw new CloudRequestError('cloud_http_403', {status: 403, serverCode: 'ATTEMPT_LINEAGE_MISMATCH'});
        const receipt = {eventId: event.eventId, receiptId: randomUUID(), status: 'accepted'};
        saved.set(event.eventId, {uploadBatchId: batch.uploadBatchId, receipt});
        receipts.push(receipt);
      }
      return {ok: true, uploadBatchId: batch.uploadBatchId, receipts};
    }};
}
async function drain(store, client, retryState = {}) {
  const statuses = [];
  for (let turn = 0; turn < 60; turn++) {
    const result = await deliverPendingBatch({store, client, retryState, now: () => 1_790_861_211_000 + turn});
    statuses.push(result.status);
    retryState = result.retryState;
    store.saveCheckpoint('network:delivery', retryState, store.loadCheckpoint('network:delivery')?.revision ?? 0);
    if (['idle', 'needs_action'].includes(result.status)) break;
  }
  return {statuses, retryState};
}

test('one refused event in a full batch is isolated and every other event still uploads', async () => {
  const events = Array.from({length: 7}, (_, index) => discovery(index));
  const bad = events[2];
  const store = seeded(events);
  const client = cloud(event => event.eventId === bad.eventId);
  const {statuses, retryState} = await drain(store, client);
  assert.deepEqual(statuses, ['split', 'delivered', 'delivered', 'quarantined', 'delivered', 'delivered', 'delivered', 'idle']);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.quarantinedCount(), 1);
  assert.equal(store.getEvent(bad.eventId).state, 'rejected');
  assert.deepEqual({reason: store.getEvent(bad.eventId).receipt.reason, by: store.getEvent(bad.eventId).receipt.quarantinedBy},
    {reason: 'INVALID_TITLEHINT', by: 'runner'});
  for (const event of events.filter(item => item !== bad)) assert.equal(store.getEvent(event.eventId).state, 'acked');
  assert.equal(retryState.blocked, undefined);
  assert.equal(retryState.singles, undefined, 'single-event mode ends once the refused batch has been worked through');
  assert.equal(retryState.lastRefusal.serverCode, 'INVALID_TITLEHINT');
  // The first five went out together once, then one at a time; the last two travel as a normal batch again.
  assert.deepEqual(client.posts.map(post => post.length), [5, 1, 1, 1, 1, 1, 2]);
});

test('the block left behind by 0.2.6 is tried once more and its lone refused event is set aside', async () => {
  const bad = discovery(0, {titleHint: '十'.repeat(2807)});
  const store = seeded([bad]);
  const stuck = store.nextBatch(); // the open batch that held the queue on 2026-10-01
  const later = Array.from({length: 3}, (_, index) => discovery(index + 1));
  for (const event of later) store.recordEvent(event);
  const client = cloud(event => event.titleHint.length > 2000);
  const {statuses, retryState} = await drain(store, client, {blocked: true, failures: 1, nextAttemptAt: 1_790_861_211_452});
  assert.deepEqual(statuses, ['quarantined', 'delivered', 'idle']);
  assert.deepEqual(client.posts[0], [bad.eventId]);
  assert.equal(stuck.events[0].eventId, bad.eventId);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.quarantinedCount(), 1);
  assert.equal(retryState.blocked, undefined);
});

test('events already accepted before a refusal keep their receipts and are never offered again', async () => {
  const events = Array.from({length: 5}, (_, index) => discovery(index));
  const [accepted, bad] = events;
  const store = seeded(events);
  const receipt = {eventId: accepted.eventId, receiptId: randomUUID(), status: 'accepted'};
  let firstBatch = null;
  const client = cloud(event => event.eventId === bad.eventId,
    {known: uploadBatchId => (firstBatch ??= uploadBatchId) === uploadBatchId ? [receipt] : []});
  const {statuses} = await drain(store, client);
  assert.equal(statuses[0], 'split');
  assert.equal(store.getEvent(accepted.eventId).state, 'acked');
  assert.deepEqual(store.getEvent(accepted.eventId).receipt, receipt);
  assert.equal(client.posts.slice(1).flat().includes(accepted.eventId), false);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.quarantinedCount(), 1);
});

// After 21:26 the finished keywords could not report completion, their leases ran out and the server
// handed the same keywords out again (revision 2, 3). Events of the earlier attempts are refused one
// by one with 403 ATTEMPT_LINEAGE_MISMATCH, after the events before them in the batch were accepted.
test('events of a superseded attempt are set aside one by one and accepted events never travel under a second batch', async () => {
  const events = Array.from({length: 9}, (_, index) => discovery(index));
  const old = new Set([2, 5, 6].map(index => events[index].eventId));
  const store = seeded(events);
  const server = faithfulServer({superseded: event => old.has(event.eventId)});
  const {statuses, retryState} = await drain(store, server);
  // Offering an accepted event under another batch would end in 409 EVENT_BATCH_CONFLICT and hold the queue.
  assert.deepEqual(statuses, ['split', 'quarantined', 'delivered', 'delivered', 'split', 'quarantined', 'quarantined', 'delivered', 'delivered', 'idle']);
  assert.equal(store.pendingCount(), 0);
  for (const [index, event] of events.entries()) {
    const stored = store.getEvent(event.eventId);
    if (old.has(event.eventId)) {
      assert.deepEqual([stored.state, stored.receipt.reason, stored.receipt.quarantinedBy], ['rejected', 'ATTEMPT_LINEAGE_MISMATCH', 'runner'], `event ${index}`);
    } else {
      assert.deepEqual([stored.state, stored.receipt.receiptId], ['acked', server.saved.get(event.eventId).receipt.receiptId], `event ${index}`);
    }
  }
  assert.deepEqual(store.quarantineReasons(), {ATTEMPT_LINEAGE_MISMATCH: 3});
  assert.equal(retryState.blocked, undefined);
  assert.equal(retryState.lastRefusal.serverCode, 'ATTEMPT_LINEAGE_MISMATCH');
});

test('when receipts cannot be read right after a refusal the batch stays whole and is taken apart on a later turn', async () => {
  const events = Array.from({length: 3}, (_, index) => discovery(index));
  const store = seeded(events);
  const server = faithfulServer({superseded: event => event.eventId === events[1].eventId});
  let lookups = 0;
  const flaky = {...server, getReceipts: async uploadBatchId => {
    if (++lookups === 2) throw new CloudRequestError('cloud_http_503', {status: 503, retryable: true});
    return server.getReceipts(uploadBatchId);
  }};
  const first = await deliverPendingBatch({store, client: flaky, now: () => 1000, random: () => 0});
  assert.equal(first.status, 'deferred');
  assert.equal(first.retryState.blocked, false);
  assert.deepEqual([store.pendingCount(), store.quarantinedCount()], [3, 0]);
  const {statuses} = await drain(store, flaky, first.retryState);
  assert.deepEqual(statuses, ['split', 'quarantined', 'delivered', 'idle']);
  assert.deepEqual([store.pendingCount(), store.quarantinedCount()], [0, 1]);
  assert.deepEqual(events.map(event => store.getEvent(event.eventId).state), ['acked', 'rejected', 'acked']);
  assert.equal(server.posts.flat().filter(id => id === events[0].eventId).length, 2, 'the accepted event is only ever re-sent inside its own batch');
});

// Setting everything aside would hide a server fault or a version mismatch: keywords would finish
// while nothing reaches the server. A long run of refusals therefore slows uploads down, so waiting
// events pile up and keywords end with outbox_backlog, which is the failure a person can see.
test('a long run of refusals slows uploads to one event per pause and resumes by itself once the server accepts again', async () => {
  const events = Array.from({length: REFUSALS_BEFORE_PAUSE + 12}, (_, index) => discovery(index));
  const store = seeded(events);
  let broken = true;
  const server = faithfulServer({invalid: () => broken});
  let clock = 1_790_900_000_000;
  let retryState = {};
  const statuses = [];
  const turn = async () => {
    const result = await deliverPendingBatch({store, client: server, retryState, now: () => clock});
    retryState = result.retryState;
    statuses.push(result.status);
    return result;
  };
  const until = async reached => {
    for (let turns = 0; turns < 300; turns++) { const result = await turn(); if (reached(result)) return result; }
    return assert.fail('uploads never reached the expected state');
  };
  let result = await until(outcome => outcome.retryState.pausedUntil);
  // The first refusals are set aside at full speed, exactly up to the limit.
  assert.equal(store.quarantinedCount(), REFUSALS_BEFORE_PAUSE);
  assert.equal(store.pendingCount(), 12);
  assert.deepEqual([result.status, result.retryState.refusedInARow, result.retryState.pausedUntil],
    ['quarantined', REFUSALS_BEFORE_PAUSE, clock + REFUSAL_PAUSE_MS]);
  assert.match(describeDelivery(summarizeDelivery(result)), /^【上传已放慢】服务端连续拒收了 20 条发现（INVALID_TITLEHINT），改为每 10 分钟只试 1 条；服务端恢复后自动继续/u);

  // During the pause nothing is sent, however often the loop turns.
  const sentBefore = server.posts.length;
  clock += REFUSAL_PAUSE_MS - 1;
  assert.equal((await turn()).status, 'deferred');
  assert.equal(server.posts.length, sentBefore);
  store.saveCheckpoint('network:delivery', retryState, 0);
  const paused = daemonStatus(store, clock);
  assert.deepEqual([paused.refusedInARow, paused.deliveryPausedUntil, paused.deliveryBlocked, paused.lastRefusal.serverCode],
    [REFUSALS_BEFORE_PAUSE, new Date(retryState.pausedUntil).toISOString(), false, 'INVALID_TITLEHINT']);
  assert.equal(daemonStatus(store, retryState.pausedUntil).deliveryPausedUntil, null);

  // When the pause ends, one more event is tried and set aside, and the pause starts again.
  clock += 1;
  result = await until(outcome => outcome.status !== 'split');
  assert.deepEqual([result.status, store.quarantinedCount(), store.pendingCount(), result.retryState.pausedUntil],
    ['quarantined', REFUSALS_BEFORE_PAUSE + 1, 11, clock + REFUSAL_PAUSE_MS]);
  assert.equal((await turn()).status, 'deferred');

  // The server is repaired. The next try is accepted, the count is forgotten and the rest drains at full speed.
  broken = false;
  clock += REFUSAL_PAUSE_MS;
  statuses.length = 0;
  await until(outcome => outcome.status === 'idle');
  assert.equal(statuses.includes('deferred'), false);
  assert.equal(statuses.includes('quarantined'), false);
  assert.deepEqual([store.pendingCount(), store.quarantinedCount()], [0, REFUSALS_BEFORE_PAUSE + 1]);
  assert.deepEqual([retryState.refusedInARow, retryState.pausedUntil, retryState.nextAttemptAt], [undefined, undefined, 0]);
});

test('refusals with accepted events in between never add up to a pause', async () => {
  const events = Array.from({length: (REFUSALS_BEFORE_PAUSE + 5) * 2}, (_, index) => discovery(index));
  const bad = new Set(events.filter((_, index) => index % 2 === 0).map(event => event.eventId));
  const store = seeded(events);
  const server = faithfulServer({superseded: event => bad.has(event.eventId)});
  let retryState = {};
  const statuses = [];
  for (let turn = 0; turn < 400; turn++) {
    const result = await deliverPendingBatch({store, client: server, retryState, now: () => 1_790_900_000_000 + turn});
    retryState = result.retryState;
    statuses.push(result.status);
    assert.equal(result.retryState.pausedUntil, undefined);
    if (result.status === 'idle') break;
  }
  assert.equal(statuses.at(-1), 'idle');
  assert.equal(statuses.includes('deferred'), false);
  assert.deepEqual([store.pendingCount(), store.quarantinedCount()], [0, REFUSALS_BEFORE_PAUSE + 5]);
});

test('a refusal that is about this runner, not an event, still stops uploads and now records why', async () => {
  for (const [status, serverCode] of [[401, null], [403, null], [403, 'MOBILE_AGENT_NOT_AUTHORIZED'], [403, 'mobile_discovery_agent_required'],
    [404, 'discovery_not_enabled'], [409, 'BATCH_PAYLOAD_CONFLICT'], [409, 'EVENT_BATCH_CONFLICT']]) {
    const store = seeded([discovery(0), discovery(1)]);
    const client = cloud(() => true, {status, serverCode});
    const first = await deliverPendingBatch({store, client, now: () => 1000, random: () => 0});
    assert.equal(first.status, 'needs_action');
    assert.equal(first.retryState.blocked, true);
    assert.deepEqual({code: first.retryState.error.code, serverCode: first.retryState.error.serverCode, status: first.retryState.error.status},
      {code: `cloud_http_${status}`, serverCode, status});
    const again = await deliverPendingBatch({store, client, retryState: first.retryState, now: () => 9_000_000});
    assert.equal(again.status, 'needs_action');
    assert.equal(client.posts.length, 1, 'a block with a recorded cause is not retried on its own');
    assert.equal(store.pendingCount(), 2);
    assert.equal(store.quarantinedCount(), 0);
  }
});

test('a refused receipt lookup is not blamed on the events: nothing is set aside and the cause is kept', async () => {
  const store = seeded([discovery(0), discovery(1)]);
  let posts = 0;
  const client = {getReceipts: async () => { throw new CloudRequestError('cloud_http_400', {status: 400, serverCode: 'INVALID_UPLOAD_BATCH'}); },
    ingest: async () => { posts++; throw new Error('must not upload'); }};
  const result = await deliverPendingBatch({store, client, now: () => 1000, random: () => 0});
  assert.equal(result.status, 'needs_action');
  assert.equal(result.retryState.blocked, true);
  assert.equal(result.retryState.error.serverCode, 'INVALID_UPLOAD_BATCH');
  assert.deepEqual([posts, store.pendingCount(), store.quarantinedCount()], [0, 2, 0]);
});

test('a busy server still only defers, and single-event mode survives the wait', async () => {
  const events = Array.from({length: 3}, (_, index) => discovery(index));
  const store = seeded(events);
  let busy = true;
  const client = {getReceipts: async uploadBatchId => ({ok: true, uploadBatchId, receipts: []}),
    ingest: async batch => {
      if (busy) throw new CloudRequestError('cloud_http_503', {status: 503, retryable: true});
      return {ok: true, uploadBatchId: batch.uploadBatchId,
        receipts: batch.events.map(event => ({eventId: event.eventId, receiptId: randomUUID(), status: 'accepted'}))};
    }};
  const deferred = await deliverPendingBatch({store, client, retryState: {singles: 2}, now: () => 1000, random: () => 0});
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.retryState.blocked, false);
  assert.equal(deferred.retryState.singles, 2);
  assert.equal(deferred.retryState.error.code, 'cloud_http_503');
  busy = false;
  const delivered = await deliverPendingBatch({store, client, retryState: deferred.retryState, now: () => 9_000_000});
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.retryState.singles, 1);
  assert.equal(delivered.retryState.error, undefined);
  assert.equal(store.pendingCount(), 2);
});

test('an error body contributes only its short machine code, never free text', async () => {
  const failing = body => createCloudClient({baseUrl: 'https://capture.example', agentToken: 'local-fixture-token',
    fetchImpl: async () => body});
  await assert.rejects(failing(Response.json({ok: false, error: 'INVALID_TITLEHINT'}, {status: 400})).ingest({}), error => {
    assert.deepEqual({code: error.code, status: error.status, serverCode: error.serverCode, retryable: error.retryable},
      {code: 'cloud_http_400', status: 400, serverCode: 'INVALID_TITLEHINT', retryable: false});
    return true;
  });
  for (const body of [Response.json({ok: false, error: 'free text that echoes local-fixture-token'}, {status: 400}),
    Response.json({ok: false, error: {nested: true}}, {status: 400}), new Response('<html>bad gateway</html>', {status: 400}),
    new Response('x'.repeat(300000), {status: 400})]) {
    await assert.rejects(failing(body).ingest({}), error => {
      assert.equal(error.serverCode, null);
      assert.equal(error.message, 'cloud_http_400');
      return true;
    });
  }
});

test('status, diagnose and the one-click window say what was refused without showing the caption', async () => {
  const bad = discovery(0, {titleHint: '十'.repeat(2807)});
  const store = seeded([bad, discovery(1)]);
  await drain(store, cloud(event => event.eventId === bad.eventId));
  const status = daemonStatus(store);
  assert.equal(status.quarantinedEvents, 1);
  assert.equal(status.deliveryBlocked, false);
  assert.equal(status.lastRefusal.serverCode, 'INVALID_TITLEHINT');
  const report = diagnoseRunner(store, {hours: 1});
  assert.equal(report.quarantined.length, 1);
  assert.deepEqual(report.quarantinedByReason, {INVALID_TITLEHINT: 1});
  assert.deepEqual({keyword: report.quarantined[0].keyword, reason: report.quarantined[0].reason, titleLength: report.quarantined[0].titleLength},
    {keyword: '别克哨兵', reason: 'INVALID_TITLEHINT', titleLength: 2807});
  assert.equal(JSON.stringify(report).includes('十十十'), false);
  assert.match(describeDelivery({status: 'quarantined', code: 'INVALID_TITLEHINT'}), /服务端拒收了发现（INVALID_TITLEHINT），已单独隔离，其余继续上传/u);
  assert.match(describeDelivery({status: 'needs_action', blocked: true, code: 'MOBILE_AGENT_NOT_AUTHORIZED'}), /上传已暂停.*MOBILE_AGENT_NOT_AUTHORIZED.*需要人工处理/u);
  // A rejected receipt from the server sets events aside but never holds the queue, so it must not read as "paused".
  assert.match(describeDelivery({status: 'needs_action', blocked: false, code: null}), /^【上传】服务端拒收了发现，已单独隔离，其余继续上传/u);
  for (const status of ['delivered', 'idle', 'deferred', 'split', 'stopped']) assert.equal(describeDelivery({status}), null);
});

test('a held queue names its recorded cause again after a restart', async () => {
  const store = seeded([discovery(0)]);
  const client = cloud(() => true, {status: 403, serverCode: 'MOBILE_AGENT_NOT_AUTHORIZED'});
  const first = await deliverPendingBatch({store, client, now: () => 1000, random: () => 0});
  const held = {status: 'needs_action', blocked: true, uploadBatchId: null, code: 'MOBILE_AGENT_NOT_AUTHORIZED', pausedUntil: null, refusedInARow: 0};
  assert.deepEqual(summarizeDelivery(first), held);
  // The process restarts: only the persisted state is left, and the first turn returns before any request.
  const afterRestart = await deliverPendingBatch({store, client, retryState: first.retryState, now: () => 9_000_000});
  assert.deepEqual(summarizeDelivery(afterRestart), held);
  assert.match(describeDelivery(summarizeDelivery(afterRestart)), /上传已暂停.*MOBILE_AGENT_NOT_AUTHORIZED/u);
  const refused = await deliverPendingBatch({store: seeded([discovery(1)]), client: cloud(() => true), now: () => 1000});
  assert.deepEqual({...summarizeDelivery(refused), uploadBatchId: null},
    {status: 'quarantined', blocked: false, uploadBatchId: null, code: 'INVALID_TITLEHINT', pausedUntil: null, refusedInARow: 1});
});

test('the server keeps a whole caption, because the captured detail is later compared with it in full', () => {
  const caption = '十五万人走到漠北，找不到敌人。'.repeat(190);
  assert.ok(caption.length > 2000);
  const event = discovery(0, {titleHint: caption});
  const normalized = normalizeBatch({uploadBatchId: randomUUID(), events: [event]}, {agentId});
  assert.equal(normalized.events[0].titleHint, caption);
});
