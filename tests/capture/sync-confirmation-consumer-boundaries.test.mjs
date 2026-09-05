import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createRecordSyncQueue} from '../../utils/record-sync-queue.js';
import {projectElasticKeywordRecoveryStatus} from '../../server/modules/capture/application/control-outcome-projection.js';

// Characterize UNMODIFIED consumers, not a fix or production replay guarantee.
// These are the gates that prevent wiring the prototype into only one call site.
const sidebar = readFileSync(new URL('../../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
const start = sidebar.indexOf('function createStreamingDetailAutoSyncQueue(');
const end = sidebar.indexOf('function routeDetailItemToStreamingSync(', start);
assert.ok(start >= 0 && end > start);
assert.equal(sidebar.indexOf('function createStreamingDetailAutoSyncQueue(', start + 1), -1);
const consumerSource = sidebar.slice(start, end);

test('current boundary: streaming wrapper drops a proposed blocked flag and text matching ignores retryable false', async () => {
  const proposedResult = {ok: false, blocked: true, retryable: false,
    phase: 'local_confirmation', partialContentSuccess: true,
    error: {code: 'LOCAL_CONFIRMATION_REQUIRED', message: 'local adapter network timeout', retryable: false}};
  const context = vm.createContext({
    createRecordSyncQueue: (options) => options,
    maybeRunAutoSyncAfterDetailCapture: async () => proposedResult,
  });
  vm.runInContext(`${consumerSource}\nglobalThis.create = createStreamingDetailAutoSyncQueue;
    globalThis.retryable = isTransientStreamingSyncFailure;`, context, {timeout: 5000});
  const wrapped = context.create({autoDetailCaptureAfterListCapture: true, autoSyncAfterDetailCapture: true});
  const result = await wrapped.processRecord({recordId: 'record-a'});
  assert.equal(result.blocked, false, 'legacy wrapper overwrites the proposed protection');
  assert.equal(result.partialContentSuccess, true);
  assert.equal(result.retryable, false);
  assert.equal(context.retryable(proposedResult), false, 'the original blocked flag would have stopped retry');
  assert.equal(context.retryable(result), true, 'text matching still treats the wrapped result as transient');
});

test('current boundary: dirty requeue runs independently of an explicit shouldRetry rejection', async () => {
  let enter;
  const entered = new Promise((resolve) => {enter = resolve;});
  let release;
  const pending = new Promise((resolve) => {release = resolve;});
  let calls = 0;
  let retryDecisions = 0;
  const queue = createRecordSyncQueue({
    retryDelaysMs: [0],
    shouldRetry: () => {retryDecisions += 1; return false;},
    processRecord: async () => {
      calls += 1;
      if (calls === 1) {enter(); await pending;}
      return {ok: false, retryable: false,
        error: {code: 'LOCAL_CONFIRMATION_REQUIRED', retryable: false}};
    },
  });
  queue.enqueue('record-a', {revision: 1});
  await entered;
  const enqueuedAgain = queue.enqueue('record-a', {revision: 2});
  release();
  const stats = await queue.drain();
  assert.equal(enqueuedAgain, false, 'the active update is tracked as dirty, not queued immediately');
  assert.equal(calls, 2, 'legacy dirty update is processed again despite no ordinary retry');
  assert.equal(retryDecisions, 2);
  assert.equal(stats.retryCount, 0);
  assert.equal(stats.processedCount, 2);
  assert.equal(stats.blocked, false);
});

test('current boundary: targeted result projection overwrites proposed non-retryability', () => {
  const context = vm.createContext({Date, Set, URL});
  vm.runInContext(readFileSync(new URL('../../utils/cloud-targeted-post.js', import.meta.url), 'utf8'),
    context, {timeout: 5000});
  const result = context.OnStarvoiceCloudTargetedPost.applySyncResult(
    {status: 'completed', recordIds: ['record-a']},
    {ok: false, blocked: true, retryable: false, successCount: 0, failedCount: 0,
      error: {code: 'LOCAL_CONFIRMATION_REQUIRED', message: 'Remote evidence retained', retryable: false}},
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.backendSynced, false);
  assert.equal(result.error.code, 'LOCAL_CONFIRMATION_REQUIRED');
  assert.equal(result.error.retryable, true, 'legacy projection does not consume the proposed flag');
});

test('current boundary: elastic recovery can reclassify a non-safety local-confirmation failure as retryable', () => {
  for (const status of ['failed', 'needs_action', 'completed_with_failures']) {
    const input = {elasticPool: true, status, attemptCount: 0, agentAttemptLimit: 2,
      error: {code: 'LOCAL_CONFIRMATION_REQUIRED', retryable: false},
      checkpoint: {blockAutomaticReplay: true, requiresReconciliation: true}};
    assert.equal(projectElasticKeywordRecoveryStatus(input), 'retryable');
    assert.equal(projectElasticKeywordRecoveryStatus({...input, elasticPool: false}), status);
  }
});
