import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeRemoteTaskInput} from '../server/services/capture-cloud.js';
import {
  hashOrchestrationRequest,
  normalizeOrchestrationRequest,
} from '../server/services/capture-orchestration.js';
import {mobileTaskBudgets} from '../server/services/android-control/mobile-tasks.js';

const legacyInput = {
  executionMode: 'unattended_plan', title: '旧手机计划',
  platform: 'wechat_channels', keywords: ['安吉星'],
  mode: 'daily', startTime: '20:30',
};

test('phone keyword limit survives both normalization passes on every mobile platform', () => {
  for (const platform of ['douyin', 'wechat_channels', 'wechat_articles']) {
    const request = normalizeOrchestrationRequest({
      ...legacyInput, platform, mobileKeywordMaxMinutes: 5,
    });
    const normalized = normalizeRemoteTaskInput({
      executionMode: request.executionMode, planSnapshot: request.taskInput,
    });
    assert.equal(normalized.planSnapshot.mobileKeywordMaxMinutes, 5, platform);
    assert.equal(mobileTaskBudgets(normalized.planSnapshot).keywordMs, 300_000, platform);
  }
});

test('remote phone keyword limit uses the orchestration range, coercion and legacy alias', () => {
  const cases = [
    [5, 5], ['5', 5], [5.9, 5], [0, 1], [-4, 1], [121, 120],
    [Number.MAX_SAFE_INTEGER, 120], ['invalid', 15], [Infinity, 15],
    [null, 15], ['', 1],
  ];
  for (const [value, expected] of cases) {
    const source = {...legacyInput, mobileKeywordMaxMinutes: value};
    assert.equal(normalizeOrchestrationRequest(source).taskInput.mobileKeywordMaxMinutes, expected);
    for (const input of [source, {planSnapshot: source}]) {
      assert.equal(normalizeRemoteTaskInput(input).planSnapshot.mobileKeywordMaxMinutes, expected);
    }
  }
  for (const field of ['mobileKeywordMaxMinutes', 'mobile_keyword_max_minutes']) {
    for (const nested of ['planSnapshot', 'unattendedPlan', 'plan']) {
      assert.equal(normalizeRemoteTaskInput({[nested]: {...legacyInput, [field]: 5}})
        .planSnapshot.mobileKeywordMaxMinutes, 5);
    }
  }
  assert.equal(normalizeRemoteTaskInput({
    planSnapshot: {...legacyInput, mobileKeywordMaxMinutes: 12}, mobileKeywordMaxMinutes: 5,
  }).planSnapshot.mobileKeywordMaxMinutes, 5, 'explicit request overrides nested plan');
  assert.equal(normalizeRemoteTaskInput({
    ...legacyInput, mobileKeywordMaxMinutes: null, mobile_keyword_max_minutes: 5,
  }).planSnapshot.mobileKeywordMaxMinutes, 5, 'null canonical field falls back to its alias');
});

test('omitting a phone time limit keeps the legacy snapshot hash and 15 minute consumption default', () => {
  // Recorded before the whitelist fix: introducing this optional field must not
  // invalidate old callers' idempotency hashes by writing an implicit default.
  const legacyHash = '985faca127dacaf69bcf48b15516bd7109c8a19b88f741672c6a44084a5b9ad9';
  for (const input of [legacyInput, {...legacyInput, mobileKeywordMaxMinutes: undefined}]) {
    const normalized = normalizeRemoteTaskInput(input);
    assert.equal(Object.hasOwn(normalized.planSnapshot, 'mobileKeywordMaxMinutes'), false);
    assert.equal(hashOrchestrationRequest(normalized), legacyHash);
    assert.equal(mobileTaskBudgets(normalized.planSnapshot).keywordMs, 900_000);
  }
  const request = normalizeOrchestrationRequest(legacyInput);
  const normalized = normalizeRemoteTaskInput({planSnapshot: request.taskInput});
  assert.equal(Object.hasOwn(normalized.planSnapshot, 'mobileKeywordMaxMinutes'), false);
  assert.notEqual(hashOrchestrationRequest(normalizeRemoteTaskInput({
    ...legacyInput, mobileKeywordMaxMinutes: 5,
  })), legacyHash, 'an explicit time limit remains part of request identity');
});
