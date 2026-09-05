import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ELASTIC_TECHNICAL_RETRY_ROUNDS,
  projectElasticAttemptBudget,
  projectElasticKeywordRecoveryStatus,
} from '../server/modules/capture/application/control-outcome-projection.js';

test('canonical projection gives non-safety failures exactly two bounded pool passes', () => {
  assert.equal(ELASTIC_TECHNICAL_RETRY_ROUNDS, 2);
  for (const agentAttemptLimit of [1, 2, 6]) {
    for (const code of ['UNATTENDED_SEARCH_BOOTSTRAP_FAILED', 'BUSINESS_CAPTURE_FAILED']) {
      const input = {
        elasticPool: true,
        status: 'failed',
        error: {code},
        agentAttemptLimit,
      };
      for (let attemptCount = 0; attemptCount < agentAttemptLimit * 2; attemptCount += 1) {
        assert.equal(projectElasticKeywordRecoveryStatus({
          ...input, attemptCount,
        }), 'retryable', `${code}, pool=${agentAttemptLimit}, attempt=${attemptCount}`);
      }
      assert.equal(projectElasticKeywordRecoveryStatus({
        ...input, attemptCount: agentAttemptLimit * 2,
      }), 'failed');
      assert.equal(projectElasticKeywordRecoveryStatus({
        ...input, attemptCount: agentAttemptLimit * 2, technicalLimitReached: true,
      }), 'needs_action');
    }
  }
});

test('safety failures retain the original distinct-account limit and manual boundary', () => {
  const searchChallenge = {
    elasticPool: true,
    status: 'needs_action',
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE', securityBlocked: true},
    agentAttemptLimit: 6,
  };
  assert.equal(projectElasticKeywordRecoveryStatus({
    ...searchChallenge, attemptCount: 5,
  }), 'retryable');
  assert.equal(projectElasticKeywordRecoveryStatus({
    ...searchChallenge, attemptCount: 6,
  }), 'needs_action');
  assert.equal(projectElasticKeywordRecoveryStatus({
    ...searchChallenge,
    error: {code: 'PAGE_CHALLENGE_BLOCK', securityBlocked: true},
    attemptCount: 0,
  }), 'needs_action');
  assert.equal(projectElasticKeywordRecoveryStatus({
    ...searchChallenge, elasticPool: false,
  }), 'needs_action');
  for (const status of ['completed', 'completed_with_warnings', 'canceled', 'running']) {
    assert.equal(projectElasticKeywordRecoveryStatus({
      ...searchChallenge, status,
    }), status);
  }
});

test('technical refund remains execution-idempotent without shortening the pool bound', () => {
  const source = {error: {code: 'UNATTENDED_SEARCH_BOOTSTRAP_FAILED'}};
  const first = projectElasticAttemptBudget({attempt_count: 1}, source, 'execution-one');
  assert.equal(first.attemptBudget, 0);
  assert.equal(first.technicalAttemptCount, 1);
  assert.equal(first.refunded, true);
  const replay = projectElasticAttemptBudget({
    attempt_count: 1,
    metadata: first.metadataPatch,
  }, source, 'execution-one');
  assert.equal(replay.attemptBudget, 0);
  assert.equal(replay.technicalAttemptCount, 1);
  assert.equal(replay.refunded, false);
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: 'failed',
    ...source,
    attemptCount: 0,
    agentAttemptLimit: 6,
    technicalLimitReached: true,
  }), 'retryable');
});
