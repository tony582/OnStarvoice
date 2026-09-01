import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURE_SAFETY_HANDOFF_SEARCH_CODES,
  evaluateCaptureSafetyHandoff,
} from '../server/services/capture-safety-handoff-policy.js';

function eligible(overrides = {}) {
  return evaluateCaptureSafetyHandoff({
    faultClass: 'platform_safety',
    challengeCode: 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
    platform: 'douyin',
    businessTaskType: 'unattended_keyword_capture',
    itemType: 'keyword',
    safetyHandoffCount: 0,
    sourcePlatformAccountId: 'source-account',
    sourceLoginState: 'authenticated',
    sourceLocalClosureProven: true,
    ...overrides,
  });
}

test('only explicit search challenge codes are allowlisted', () => {
  assert.deepEqual(CAPTURE_SAFETY_HANDOFF_SEARCH_CODES, [
    'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
    'DOUYIN_SEARCH_SECURITY_CHALLENGE',
  ]);
  const preflight = eligible();
  assert.equal(preflight.automaticEligible, true);
  assert.equal(preflight.targetAccountRequired, true);
  assert.equal(preflight.sourceLineageSilent, false);
  assert.equal(preflight.sourceLineageSilenceRequired, true);
  assert.equal(preflight.nextSafetyHandoffCount, 1);

  for (const challengeCode of [
    'PLATFORM_SAFETY_BLOCK',
    'CAPTCHA_REQUIRED',
    'PAGE_CHALLENGE_BLOCK',
    'XHS_SECURITY_BLOCK',
    'UNKNOWN',
    '',
  ]) {
    const decision = eligible({challengeCode});
    assert.equal(decision.automaticEligible, false, challengeCode);
    assert.equal(decision.decision, 'human_required', challengeCode);
    assert.equal(decision.reason, 'challenge_not_allowlisted', challengeCode);
    assert.equal(decision.sourceLineageSilent, false, challengeCode);
    assert.equal(decision.sourceLineageSilenceRequired, false, challengeCode);
  }
});

test('final handoff requires a different authenticated platform account', () => {
  const accepted = eligible({
    targetPlatformAccountId: 'target-account',
    targetLoginState: 'authenticated',
  });
  assert.equal(accepted.automaticEligible, true);
  assert.equal(
    accepted.reason,
    'first_allowlisted_search_challenge_distinct_account',
  );

  const sameAccount = eligible({
    targetPlatformAccountId: ' SOURCE-ACCOUNT ',
    targetLoginState: 'authenticated',
  });
  assert.equal(sameAccount.automaticEligible, false);
  assert.equal(sameAccount.reason, 'target_platform_account_not_distinct');

  const missingTarget = eligible({
    targetPlatformAccountId: '',
    targetLoginState: 'authenticated',
  });
  assert.equal(missingTarget.automaticEligible, false);
  assert.equal(missingTarget.reason, 'target_platform_account_unknown');

  const loggedOutTarget = eligible({
    targetPlatformAccountId: 'target-account',
    targetLoginState: 'logged_out',
  });
  assert.equal(loggedOutTarget.automaticEligible, false);
  assert.equal(loggedOutTarget.reason, 'target_login_not_authenticated');
});

test('login loss, unknown identity and a second challenge go straight to human', () => {
  for (const [overrides, reason] of [
    [{sourceLoginState: 'logged_out'}, 'source_login_not_authenticated'],
    [{sourceLoginState: 'unknown'}, 'source_login_not_authenticated'],
    [{sourcePlatformAccountId: ''}, 'source_platform_account_unknown'],
    [{safetyHandoffCount: 1}, 'safety_handoff_already_used'],
    [{safetyHandoffCount: 8}, 'safety_handoff_already_used'],
  ]) {
    const decision = eligible(overrides);
    assert.equal(decision.automaticEligible, false, reason);
    assert.equal(decision.decision, 'human_required', reason);
    assert.equal(decision.reason, reason);
    assert.equal(decision.sourceLineageSilent, false, reason);
  }
});

test('cloud-only silence never substitutes for authoritative local closure proof', () => {
  for (const cloudClaim of [
    {sourceTaskStatus: 'running'},
    {activeCommandCount: 1},
    {activeAttemptCount: 1},
    {sourceTaskStatus: 'failed', activeCommandCount: 0, activeAttemptCount: 0},
  ]) {
    const decision = eligible({
      sourceLocalClosureProven: false,
      ...cloudClaim,
    });
    assert.equal(decision.automaticEligible, false);
    assert.equal(decision.decision, 'human_required');
    assert.equal(decision.reason, 'source_local_closure_proof_unavailable');
    assert.equal(decision.sourceLineageSilent, false);
  }
});

test('the handoff is restricted to Douyin keyword-search recovery', () => {
  for (const [overrides, reason] of [
    [{platform: 'xiaohongshu'}, 'platform_not_allowlisted'],
    [{businessTaskType: 'negative_post_patrol'}, 'task_type_not_allowlisted'],
    [{itemType: 'post'}, 'item_type_not_allowlisted'],
  ]) {
    const decision = eligible(overrides);
    assert.equal(decision.automaticEligible, false, reason);
    assert.equal(decision.reason, reason);
  }
});
