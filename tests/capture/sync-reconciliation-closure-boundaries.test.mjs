import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createRecordSyncQueue} from '../../utils/record-sync-queue.js';

// Exercise the opt-in queue with the REAL sidebar drain, terminal projection,
// and background upload-evidence predicate. Browser I/O is replaced, not these
// decisions. No shipping sync producer enables this policy in this stage.
const sidebar = readFileSync(new URL('../../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
const background = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing actual function: ${start}`);
  assert.equal(source.indexOf(start, from + start.length), -1, `ambiguous actual function: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing following function: ${end}`);
  return source.slice(from, to);
}

const factorySource = section(sidebar,
  'function createStreamingDetailAutoSyncQueue(',
  'function routeDetailItemToStreamingSync(');
const bridgeSource = [
  section(sidebar, 'async function drainStreamingDetailSyncQueue(', 'async function handleBatchKeywordCapture('),
  section(sidebar, 'function buildUnattendedTerminalProgress(', 'function createUnattendedKeywordCheckpointReporter('),
  section(background, 'function inspectUnattendedBusinessUploadEvidence(', 'async function releaseExactCaptureExecutionLockSnapshot('),
].join('\n');

function createBridge() {
  const progress = [];
  const notified = [];
  const messages = [];
  let refreshes = 0;
  const context = vm.createContext({
    refreshDataPool: async () => {refreshes += 1;},
    refreshSyncHistory: async () => {refreshes += 1;},
    showMessage: (message, tone) => messages.push({message, tone}),
  });
  vm.runInContext(`${bridgeSource}\nglobalThis.api = {
    drain: drainStreamingDetailSyncQueue,
    terminal: buildUnattendedTerminalProgress,
    inspect: inspectUnattendedBusinessUploadEvidence,
  };`, context, {timeout: 5000});
  return {
    progress, notified, messages,
    get refreshes() {return refreshes;},
    drain(queue) {
      return context.api.drain(queue, {
        updateProgress: (value) => progress.push(plain(value)),
        notifyProgress: (value) => notified.push(plain(value)),
      });
    },
    inspect(streamingSync, savedCount) {
      const terminal = context.api.terminal({
        requestId: 'isolated-request', attemptId: 'isolated-attempt',
        captureTaskId: 'isolated-task', finishedAt: '2026-09-05T00:00:00.000Z',
        status: streamingSync.reconciliationRequired ? 'completed_with_failures' : 'completed',
        summary: {saved: savedCount}, streamingSync,
      });
      const evidence = context.api.inspect({
        id: 'isolated-request', attemptId: 'isolated-attempt',
        counts: {saved: savedCount}, progress: terminal,
      });
      return {terminal: plain(terminal), evidence: plain(evidence)};
    },
  };
}

async function createPendingHoldQueue() {
  let enter;
  const entered = new Promise((resolve) => {enter = resolve;});
  let release;
  const pending = new Promise((resolve) => {release = resolve;});
  const processed = [];
  let retryDecisions = 0;
  const queue = createRecordSyncQueue({
    shouldHoldForReconciliation: (result) => result?.requiresReconciliation === true,
    retryDelaysMs: [0],
    shouldRetry: () => {retryDecisions += 1; return true;},
    processRecord: async ({recordId}) => {
      processed.push(recordId);
      enter();
      await pending;
      return {
        ok: false, requiresReconciliation: true, blockAutomaticReplay: true,
        error: {code: 'LOCAL_CONFIRMATION_REQUIRED', message: 'network timeout in local confirmation'},
        remoteEvidence: {recordId, acknowledged: true},
      };
    },
  });
  queue.registerCaptured(['record-a', 'record-b']);
  queue.enqueue('record-a');
  await entered;
  queue.enqueue('record-b');
  return {queue, processed, release, get retryDecisions() {return retryDecisions;}};
}

function assertHeldDrain(bridge, result) {
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.drainCompleted, false);
  assert.ok(result.remainingCount > 0);
  assert.equal(result.processedCount, 0);
  assert.equal(result.successCount, 0);
  assert.equal(result.failedCount, 0);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.succeededUniqueCount, 0);
  assert.equal(result.excludedUniqueCount, 0);
  assert.equal(bridge.progress.at(-1).phase, 'streaming_sync_reconciliation_required');
  assert.match(bridge.progress.at(-1).message, /核对|确认/);
  assert.equal(bridge.progress.some(({phase}) => phase === 'streaming_sync_done'), false);
  assert.equal(bridge.progress.some(({message}) => /边采边同步完成|已采数据已同步后台/.test(message)), false);
  assert.equal(bridge.messages.some(({tone}) => tone === 'success'), false);
  assert.deepEqual(bridge.notified, bridge.progress);
}

test('the real streaming producer factory does not opt into reconciliation holds', async () => {
  assert.doesNotMatch(factorySource, /\bshouldHoldForReconciliation\b/);
  const context = vm.createContext({
    createRecordSyncQueue: (options) => options,
    maybeRunAutoSyncAfterDetailCapture: async () => ({ok: true, successCount: 1}),
  });
  vm.runInContext(`${factorySource}\nglobalThis.create = createStreamingDetailAutoSyncQueue;`, context, {timeout: 5000});
  const options = context.create({autoDetailCaptureAfterListCapture: true, autoSyncAfterDetailCapture: true}, {
    shouldHoldForReconciliation: () => assert.fail('shipping factory must not forward this opt-in'),
  });
  assert.equal(Object.hasOwn(options, 'shouldHoldForReconciliation'), false);
  assert.equal((await options.processRecord({recordId: 'record-a'})).ok, true);
});

test('a held real queue drains to pending verification and cannot establish upload closure', {timeout: 3000}, async () => {
  const harness = await createPendingHoldQueue();
  const bridge = createBridge();
  const draining = bridge.drain(harness.queue);
  harness.release();
  const result = await draining;
  assertHeldDrain(bridge, result);
  assert.equal(result.remainingCount, 2);
  assert.deepEqual(harness.processed, ['record-a']);
  assert.equal(harness.retryDecisions, 0);
  const {terminal, evidence} = bridge.inspect(result, 2);
  assert.equal(terminal.streamingSyncEvidenceKnown, false);
  assert.equal(terminal.streamingSyncDrainCompleted, false);
  assert.equal(evidence.known, false);
  assert.equal(evidence.reason, 'business_upload_state_unknown');
  assert.notEqual(evidence.cleared, true);
  const second = createBridge();
  assertHeldDrain(second, await second.drain(harness.queue));
  assert.deepEqual(harness.processed, ['record-a'], 'another drain must not send held or pending records');
});

test('even an incorrectly forced drain-completed bit cannot clear retained unresolved records', {timeout: 3000}, async () => {
  const harness = await createPendingHoldQueue();
  harness.release();
  const result = await harness.queue.drain();
  assert.equal(result.reconciliationRequired, true);
  assert.ok(result.remainingCount > 0);
  const {terminal, evidence} = createBridge().inspect({...result, drainCompleted: true}, 2);
  assert.equal(terminal.streamingSyncEvidenceKnown, true);
  assert.ok(terminal.streamingSyncRemainingCount > 0);
  assert.equal(evidence.known, true);
  assert.equal(evidence.cleared, false);
  assert.equal(evidence.reason, 'business_uploads_not_cleared');
});

test('cancellation before the active hold result arrives cannot manufacture completed upload evidence', {timeout: 3000}, async () => {
  const harness = await createPendingHoldQueue();
  harness.queue.cancel('user_cancel_requested');
  harness.release();
  const bridge = createBridge();
  const result = await bridge.drain(harness.queue);
  assertHeldDrain(bridge, result);
  assert.equal(result.canceled, true);
  assert.equal(result.remainingCount, 2, 'the pre-cancel pending record must remain unresolved evidence');
  assert.deepEqual(harness.processed, ['record-a']);
  const {terminal, evidence} = bridge.inspect(result, 2);
  assert.equal(terminal.streamingSyncDrainCompleted, false);
  assert.notEqual(evidence.cleared, true);
});

test('the existing successful queue still emits completed progress and establishes complete upload evidence', {timeout: 3000}, async () => {
  const processed = [];
  const queue = createRecordSyncQueue({processRecord: async ({recordId}) => {processed.push(recordId); return {ok: true};}});
  queue.registerCaptured(['record-a', 'record-b']);
  queue.enqueue('record-a');
  queue.enqueue('record-b');
  const bridge = createBridge();
  const result = await bridge.drain(queue);
  assert.equal(result.drainCompleted, true);
  assert.equal(result.remainingCount, 0);
  assert.equal(result.successCount, 2);
  assert.deepEqual(processed, ['record-a', 'record-b']);
  assert.equal(bridge.progress.at(-1).phase, 'streaming_sync_done');
  assert.deepEqual(bridge.notified, bridge.progress);
  const {terminal, evidence} = bridge.inspect(result, 2);
  assert.equal(terminal.streamingSyncEvidenceKnown, true);
  assert.equal(evidence.known, true);
  assert.equal(evidence.cleared, true);
});

test('the disabled zero-record queue retains its existing successful drain contract', async () => {
  const bridge = createBridge();
  const result = await bridge.drain(createRecordSyncQueue({enabled: false}));
  assert.equal(result.enabled, false);
  assert.equal(result.drainCompleted, true);
  assert.deepEqual(bridge.progress, []);
  assert.equal(bridge.refreshes, 0);
  assert.equal(bridge.inspect(result, 0).evidence.cleared, true);
});
