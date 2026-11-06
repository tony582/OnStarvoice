import assert from 'node:assert/strict';
import test from 'node:test';
import {createEnhancementRetrySession, ENHANCEMENT_RETRY_EXHAUSTED} from '../../utils/capture/enhancement-retry-session.js';
import {runEnhancementWithSingleRetry} from '../../utils/capture/enhancement-retry.js';

const noteId = '6aa1e9900000000012027610';
const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=test-only`;
function memoryStorage() {
  const values = new Map();
  return {async get(keys) {return Object.fromEntries((keys == null ? [...values.keys()] : Array.isArray(keys) ? keys : [keys]).filter(k => values.has(k)).map(k => [k, structuredClone(values.get(k))]));},
    async set(patch) {Object.entries(patch).forEach(([k,v]) => values.set(k, structuredClone(v)));},
    async remove(keys) {(Array.isArray(keys) ? keys : [keys]).forEach(k => values.delete(k));}};
}
function browserHarness({alwaysPartial = false, securityOnRetry = false, onComments = null} = {}) {
  const source = {id: 41, windowId: 5, index: 3, active: true, status: 'complete', url: 'https://www.xiaohongshu.com/search_result?keyword=test'};
  const workers = new Map();
  const calls = {body: 0, comments: [], metrics: 0, persistedBeforeComments: []};
  let nextId = 92;
  globalThis.chrome = {
    storage: {local: memoryStorage()},
    runtime: {getURL: path => `chrome-extension://test/${path}`, async sendMessage(message) {
      const request = message.payload || {};
      if (request.action === 'captureSingleNote') {
        calls.body++;
        return {ok: true, data: {ok: true, data: {noteId, url: noteUrl, title: 'verified body', content: 'saved detail text', comments: 2,
          bloggerFollowersCount: 100, bloggerFollowersCountKnown: true, bloggerLikedAndCollectedCount: 200,
          bloggerLikedAndCollectedCountKnown: true, authorUrl: 'https://www.xiaohongshu.com/user/profile/author'}}};
      }
      if (request.action === 'captureComments') {
        calls.comments.push(request);
        const {getRecord} = await import('../../utils/storage.js');
        calls.persistedBeforeComments.push((await getRecord(request.recordId))?.payload);
        await onComments?.(calls.comments.length);
        if (securityOnRetry && calls.comments.length === 2) return {ok: true, data: {ok: false, error: {code: 'XHS_SECURITY_BLOCK', message: '安全验证'}}};
        const partial = alwaysPartial || calls.comments.length === 1;
        return {ok: true, data: {ok: true, data: {noteId, items: [{id: `c${calls.comments.length}`, content: `comment ${calls.comments.length}`, author: 'reader'}],
          captureStatus: partial ? 'partial' : 'done', stopReason: partial ? 'max_duration' : 'complete'}}};
      }
      return {ok: true, data: null};
    }},
    tabs: {async query() {return [source];}, async create(properties) {const tab = {...properties, id: nextId++, windowId: 5, status: 'complete'}; workers.set(tab.id, tab); return tab;},
      async update(tabId, patch) {const tab = workers.get(tabId) || source; Object.assign(tab, patch); return tab;},
      async get(tabId) {return workers.get(tabId) || source;}, async remove(tabId) {assert.notEqual(tabId, source.id); workers.delete(tabId);}},
    scripting: {async executeScript({func, target}) {
      const tab = workers.get(target?.tabId) || source;
      if (func?.name === 'readDetailAvailabilitySnapshot') return [{result: {url: tab.url, title: 'post', bodyText: 'normal content', notices: []}}];
      return [{result: {ok: true, currentUrl: tab.url, currentNoteId: noteId, targetMatched: true, detailReady: true}}];
    }},
    windows: {async update() {return {};}}
  };
  return {calls, workers};
}
async function runBatch(recordId, options = {}) {
  const {addRecord} = await import('../../utils/storage.js');
  const {batchCaptureDetailsForRecords} = await import('../../utils/capture-sync.js');
  await addRecord({id: recordId, type: 'keyword_notes', platform: 'xiaohongshu', payload: {items: [{noteId, url: noteUrl, title: 'list snapshot'}]}});
  return runEnhancementWithSingleRetry({recordIds: [recordId], ...options.retry,
    runAttempt: (ids, context) => batchCaptureDetailsForRecords(ids, {
      skipAlreadyCaptured: false, enableAiRelevancePrefilter: false,
      includeComments: true, includeBloggerMetrics: true,
      detailAfterNavWaitMs: 1, profileAfterNavWaitMs: 1,
      enhancementRetrySession: context.retrySession,
      shouldStop: options.shouldStop,
      onProgress: async progress => {
        if (progress.phase === 'detail_blogger_metrics_capturing') options.calls.metrics++;
        await options.onProgress?.(progress);
      },
    })});
}

test('real batch retries comments only, preserves verified body/metrics and merges partial comments', async () => {
  const {calls, workers} = browserHarness();
  const result = await runBatch('stage-retry-success', {calls});
  const {getRecord} = await import('../../utils/storage.js');
  const record = await getRecord('stage-retry-success');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.body, 1);
  assert.equal(calls.metrics, 1);
  assert.equal(calls.comments.length, 2);
  assert.ok(calls.persistedBeforeComments.every(payload => payload.detailCaptureStatus === 'capturing' && payload.detailPayload.content === 'saved detail text'));
  assert.equal(record.payload.detailCaptureStatus, 'done');
  assert.equal(record.payload.detailPayload.bloggerFollowersCount, 100);
  assert.equal(record.payload.detailPayload.commentsCaptureStatus, 'done');
  assert.equal(record.payload.detailPayload.commentsCleanedItems.length, 2);
  assert.equal(workers.size, 0);
});

test('repeated partial comments exhaust the shared stage budget without replaying body or claiming success', async () => {
  const {calls} = browserHarness({alwaysPartial: true});
  const result = await runBatch('stage-retry-exhausted', {calls});
  const {getRecord} = await import('../../utils/storage.js');
  const record = await getRecord('stage-retry-exhausted');
  assert.equal(result.ok, false);
  assert.equal(result.canceled, false);
  assert.equal(result.error.code, ENHANCEMENT_RETRY_EXHAUSTED);
  assert.equal(result.error.budgetStopReason, 'comment_attempt_budget');
  assert.equal(calls.body, 1);
  assert.equal(calls.metrics, 1);
  assert.equal(calls.comments.length, 2, 'inner recovery and outer compensation share the counter');
  assert.equal(record.payload.detailCaptureStatus, 'failed');
  assert.equal(record.payload.detailPayload.content, 'saved detail text');
  assert.equal(record.payload.detailPayload.commentsCleanedItems.length, 2);
  assert.deepEqual(result.enhancementFailure.savedDetailRecordIds, ['stage-retry-exhausted']);
});

test('security during comment compensation retains the safety stop ahead of retry exhaustion', async () => {
  const {calls} = browserHarness({securityOnRetry: true});
  const result = await runBatch('stage-retry-security', {calls});
  assert.equal(result.ok, false);
  assert.equal(result.securityBlocked, true);
  assert.notEqual(result.error?.code, ENHANCEMENT_RETRY_EXHAUSTED);
  assert.equal(calls.body, 1);
  assert.equal(calls.comments.length, 2);
});

test('retry admission budget starts after initial capture and limits the next comment request to remaining time', async () => {
  let now = 0;
  const {calls} = browserHarness({alwaysPartial: true, onComments: n => {now += n === 1 ? 50_000 : 5_000;}});
  const result = await runBatch('stage-retry-time-budget', {calls, retry: {now: () => now, maxRetryDurationMs: 5_000}});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ENHANCEMENT_RETRY_EXHAUSTED);
  assert.equal(result.error.budgetStopReason, 'retry_time_budget');
  assert.equal(calls.comments[0].maxDurationMs, 600_000, 'initial collection keeps the configured duration');
  assert.equal(calls.comments[1].maxDurationMs, 5_000);
  assert.equal(calls.comments.length, 2);
});

test('stage checkpoints are scoped, copied and never shared across invocations', () => {
  const first = createEnhancementRetrySession();
  const second = createEnhancementRetrySession();
  const payload = {noteId, nested: {value: 1}};
  first.remember('record', 'scope-a', payload);
  payload.nested.value = 2;
  const read = first.read('record', 'scope-a');
  assert.equal(read.nested.value, 1);
  read.nested.value = 3;
  assert.equal(first.read('record', 'scope-a').nested.value, 1);
  assert.equal(first.read('record', 'scope-b'), null);
  assert.equal(second.read('record', 'scope-a'), null);
  assert.equal(first.beginComments('record').ok, true);
  assert.equal(first.beginComments('record').ok, true);
  assert.equal(first.beginComments('record').ok, false);
});


test('an inner stage budget already exhausted on the initial attempt becomes a terminal structured result', async () => {
  let calls = 0;
  const result = await runEnhancementWithSingleRetry({recordIds: ['inner-exhausted'],
    runAttempt: async () => {calls++; return {ok: false, results: [{recordId: 'inner-exhausted', ok: false,
      reason: ENHANCEMENT_RETRY_EXHAUSTED, budgetStopReason: 'comment_attempt_budget', stage: 'comments_capture'}]};},
  });
  assert.equal(calls, 1);
  assert.equal(result.error.code, ENHANCEMENT_RETRY_EXHAUSTED);
  assert.equal(result.autoRetryCount, 0);
  assert.equal(result.error.budgetStopReason, 'comment_attempt_budget');
});

test('41 failed enhancements end with explicit exhausted evidence instead of an unbounded new pass', async () => {
  const recordIds = Array.from({length: 41}, (_, i) => `record-${i}`);
  let calls = 0;
  const result = await runEnhancementWithSingleRetry({recordIds,
    runAttempt: async ids => {calls++; return {ok: false, results: ids.map(recordId => ({recordId, ok: false,
      reason: 'COMMENTS_CAPTURE_FAILED', category: 'page_failed', stage: 'comments_capture'}))};},
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.failedCount, 41);
  assert.equal(result.error.code, ENHANCEMENT_RETRY_EXHAUSTED);
  assert.deepEqual(result.enhancementFailure.failedRecordIds, recordIds);
});


test('changed worker identity during cached retry prevents partial persistence and comment collection', async () => {
  const {calls, workers} = browserHarness();
  let noteStages = 0;
  const result = await runBatch('stage-retry-identity-switch', {calls,
    onProgress: progress => {
      if (progress.phase === 'detail_note_capture_started' && ++noteStages === 2) {
        for (const worker of workers.values()) {
          worker.url = 'https://www.xiaohongshu.com/explore/6bb2e9900000000012027610';
        }
      }
    },
  });
  const {getRecord} = await import('../../utils/storage.js');
  const record = await getRecord('stage-retry-identity-switch');
  assert.equal(result.ok, false);
  assert.equal(result.integrityBlocked, true);
  assert.notEqual(result.error?.code, ENHANCEMENT_RETRY_EXHAUSTED);
  assert.equal(calls.body, 1, 'the original body is reused only within its guarded stage');
  assert.equal(calls.comments.length, 1, 'no comments are read from the changed note');
  assert.equal(record.payload.detailCaptureStatus, 'failed');
  assert.equal(record.payload.detailPayload.noteId, noteId);
  assert.equal(record.payload.detailPayload.content, 'saved detail text');
  assert.equal(record.payload.detailPayload.commentsCleanedItems.length, 1);
  assert.equal(workers.size, 0);
});

test('cancellation during cached retry remains canceled and never becomes exhaustion', async () => {
  const {calls, workers} = browserHarness();
  let noteStages = 0;
  let stopped = false;
  const result = await runBatch('stage-retry-canceled', {calls, shouldStop: () => stopped,
    retry: {shouldStop: () => stopped},
    onProgress: progress => {
      if (progress.phase === 'detail_note_capture_started' && ++noteStages === 2) stopped = true;
    },
  });
  const {getRecord} = await import('../../utils/storage.js');
  const record = await getRecord('stage-retry-canceled');
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.notEqual(result.error?.code, ENHANCEMENT_RETRY_EXHAUSTED);
  assert.equal(calls.body, 1);
  assert.equal(calls.comments.length, 1);
  assert.equal(record.payload.detailPayload.noteId, noteId);
  assert.equal(record.payload.detailPayload.commentsCleanedItems.length, 1);
  assert.notEqual(record.payload.detailCaptureStatus, 'done');
  assert.equal(workers.size, 0);
});
