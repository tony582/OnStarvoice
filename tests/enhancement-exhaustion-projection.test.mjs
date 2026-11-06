import assert from 'node:assert/strict';
import test from 'node:test';
import {checkpointEntryToItemStatus} from '../server/services/capture-orchestration.js';
import {classifyCaptureRecoveryCandidate} from '../server/services/capture-recovery-intents.js';
import {normalizeCloudTaskSnapshot} from '../server/services/capture-cloud.js';
import {
  classifyCaptureRecoveryDisposition,
  orchestrationCheckpointEntries,
  projectElasticKeywordRecoveryStatus,
} from '../server/routes/capture-cloud.js';

const code = 'ENHANCEMENT_RETRY_EXHAUSTED';
const error = {code, category: 'enhancement_incomplete', retryable: false,
  message: '正文已保存，增强自动重试已耗尽'};

test('nested enhancement evidence keeps bounded arrays through cloud snapshot sanitizing', () => {
  const evidence = {version: 1,
    failedRecordIds: Array.from({length: 300}, (_, i) => `record-${i}`),
    savedDetailRecordIds: ['saved', 'saved', 42], failureStages: ['comments_capture'],
    autoRetryCount: Infinity, budgetStopReason: 'retry_time_budget',
    untrustedExtra: {deep: {payload: 'not part of this evidence schema'}}};
  const snapshot = normalizeCloudTaskSnapshot({id: 'synthetic',
    checkpoint: {keywordResults: [{keyword: 'synthetic', errorCode: code,
      enhancementFailure: evidence}]}});
  const retained = snapshot.checkpoint.keywordResults[0].enhancementFailure;
  assert.equal(retained.failedRecordIds.length, 200);
  assert.deepEqual(retained.savedDetailRecordIds, ['saved']);
  assert.deepEqual(retained.failureStages, ['comments_capture']);
  assert.equal(retained.autoRetryCount, 0);
  assert.equal(retained.untrustedExtra, undefined);
});

test('non-elastic recovery also stops exhausted enhancement in both recovery phases', () => {
  for (const phase of ['fast', 'duty']) {
    for (const status of ['failed', 'retryable']) {
      assert.deepEqual(classifyCaptureRecoveryDisposition({status, error,
        attempt_count: 1, started_at: new Date().toISOString()}, {phase}),
      {kind: 'enhancement_retry_exhausted', automatic: false});
    }
    assert.equal(classifyCaptureRecoveryDisposition({status: 'failed',
      error: {...error, securityBlocked: true}}, {phase}).kind, 'manual_current');
  }
});

test('exhausted enhancement stays failed without consuming a fresh keyword relay budget', () => {
  for (const status of ['failed', 'partial']) {
    const entry = {status, attemptCount: 1, savedCount: 40, errorCode: code, error};
    assert.equal(checkpointEntryToItemStatus(entry, {maxAttempts: 16}), 'failed');
    assert.equal(projectElasticKeywordRecoveryStatus({elasticPool: true,
      status: 'failed', error, checkpoint: entry, attemptCount: 1, agentAttemptLimit: 8}), 'failed');
  }
  assert.equal(projectElasticKeywordRecoveryStatus({elasticPool: true,
    status: 'failed', error: {code: 'PAGE_OPEN_TIMEOUT'}, attemptCount: 1,
    agentAttemptLimit: 8}), 'retryable', 'ordinary search failure retains bounded recovery');
  assert.equal(projectElasticKeywordRecoveryStatus({elasticPool: true,
    status: 'failed', error, attemptCount: 16, agentAttemptLimit: 8,
    technicalLimitReached: true}), 'failed', 'exhausted enhancement is terminal at the relay limit too');
});

test('exhaustion cannot overwrite cancellation, active work or a later explicit success', () => {
  for (const status of ['canceled', 'running', 'completed', 'completed_with_warnings']) {
    assert.equal(checkpointEntryToItemStatus({status, errorCode: code}), status);
    assert.equal(projectElasticKeywordRecoveryStatus({elasticPool: true,
      status, error, attemptCount: 1, agentAttemptLimit: 8}), status);
  }
});

test('safety and an unconfirmed local stop still take precedence over enhancement exhaustion', () => {
  assert.equal(checkpointEntryToItemStatus({status: 'failed', errorCode: code,
    securityBlocked: true}), 'needs_action');
  assert.equal(projectElasticKeywordRecoveryStatus({elasticPool: true, status: 'failed',
    error: {...error, securityBlocked: true}, agentAttemptLimit: 8}), 'needs_action');
});

test('sequential search retains exhausted enhancement instead of a generic missing-pass retry', () => {
  const keyword = 'synthetic keyword';
  const planSnapshot = {platform: 'douyin', searchPasses: ['all', 'image']};
  const snapshot = {status: 'completed_with_failures', progress: {keyword, round: 2},
    checkpoint: {keywordResults: [
      {keyword, round: 1, status: 'completed', savedCount: 8},
      {keyword, round: 2, status: 'failed', savedCount: 32, attemptCount: 1,
        errorCode: code, error},
    ]}};
  const [entry] = orchestrationCheckpointEntries(snapshot, {planSnapshot});
  assert.equal(entry.errorCode, code);
  assert.equal(entry.error.code, code);
  assert.equal(checkpointEntryToItemStatus(entry), 'failed');
  assert.equal(entry.savedCount, 32);
  assert.deepEqual(entry.searchPassCompletion.completed, [1]);
});

test('duty recovery cannot open a second recovery loop after enhancement exhaustion', () => {
  for (const status of ['failed', 'retryable']) {
    const result = classifyCaptureRecoveryCandidate({status, attempt_count: 16,
      item_type: 'keyword', item_platform: 'xiaohongshu', error,
      source_attempt_checkpoint: {errorCode: code},
      parent_metadata: {distributionMode: 'elastic_pool'}});
    assert.equal(result.code, code);
    assert.equal(result.eligible, false);
    assert.equal(result.terminalStatus, 'failed');
    assert.equal(result.decision, 'stop');
    assert.equal(result.reason, 'enhancement_retry_exhausted');
  }
});

test('duty recovery keeps stronger safety and user-stop boundaries', () => {
  const safety = classifyCaptureRecoveryCandidate({status: 'failed', attempt_count: 16,
    error: {...error, securityBlocked: true}});
  assert.equal(safety.terminalStatus, 'waiting_human');
  const stopped = classifyCaptureRecoveryCandidate({status: 'canceled',
    error: {code: 'USER_CANCELED', category: 'user_canceled'}});
  assert.equal(stopped.terminalStatus, 'stopped_by_user');
  assert.equal(classifyCaptureRecoveryCandidate({status: 'completed', error}).terminalStatus, 'resolved');
});
