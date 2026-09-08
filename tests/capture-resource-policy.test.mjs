import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureResourceAgentIds,
  normalizeCaptureResourcePolicy,
  normalizeNegativePatrolAdmissionPolicy,
  projectCaptureResourceAdmission,
  projectNegativePatrolAdmission,
  validateCaptureResourcePolicy,
} from '../server/services/capture-resource-policy.js';

const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';

test('capture resource policy keeps only the small supported contract', () => {
  assert.deepEqual(normalizeCaptureResourcePolicy({
    maxActive: 2,
    maxActivePerHost: 3,
    capacityGroup: 'SHARED-5G',
    maxActiveInGroup: 1,
    maxDailySearchesPerAgent: 20,
    relayAgentIds: [AGENT_B, 'invalid', AGENT_B],
    optimizer: {enabled: true},
  }), {
    maxActive: 2,
    maxActivePerHost: 3,
    maxActiveInGroup: 1,
    capacityGroup: 'shared-5g',
    maxDailySearchesPerAgent: 20,
    relayAgentIds: [AGENT_B],
  });
});

test('resource policy rejects malformed caps, groups, and relay ids', () => {
  assert.deepEqual(validateCaptureResourcePolicy({maxActiv: 1}), {
    valid: false,
    reason: 'resource_policy_unknown_field',
  });
  assert.deepEqual(validateCaptureResourcePolicy({relayAgentId: [AGENT_B]}), {
    valid: false,
    reason: 'resource_policy_unknown_field',
  });
  assert.deepEqual(validateCaptureResourcePolicy({maxActive: 'many'}), {
    valid: false,
    reason: 'maxActive_invalid',
  });
  assert.deepEqual(validateCaptureResourcePolicy({maxActive: 1.5}), {
    valid: false,
    reason: 'maxActive_invalid',
  });
  assert.deepEqual(validateCaptureResourcePolicy({maxActive: 51}), {
    valid: false,
    reason: 'maxActive_invalid',
  });
  assert.deepEqual(validateCaptureResourcePolicy({maxActiveInGroup: 1}), {
    valid: false,
    reason: 'capacity_group_invalid',
  });
  assert.equal(validateCaptureResourcePolicy({
    capacityGroup: 'shared-5g',
    maxActiveInGroup: 1,
    relayAgentIds: [AGENT_B],
  }).valid, true);
});

test('relay pool extends the original pool without duplicating agents', () => {
  assert.deepEqual(captureResourceAgentIds({
    eligibleAgentIds: [AGENT_A, AGENT_B],
    resourcePolicy: {relayAgentIds: [AGENT_B]},
  }), [AGENT_A, AGENT_B]);
});

test('resource admission rejects only an exhausted configured boundary', () => {
  const resourcePolicy = {
    maxActive: 2,
    maxActivePerHost: 3,
    maxDailySearchesPerAgent: 20,
  };
  assert.deepEqual(projectCaptureResourceAdmission({
    resourcePolicy,
    hostLabel: 'tony-mac',
    planActive: 1,
    hostActive: 2,
    todaySearches: 19,
  }), {allowed: true, reason: ''});
  assert.equal(projectCaptureResourceAdmission({
    resourcePolicy,
    hostLabel: 'tony-mac',
    todaySearches: 19,
    expectedSearches: 2,
  }).reason, 'daily_search_capacity');
  assert.equal(projectCaptureResourceAdmission({
    resourcePolicy,
    hostLabel: 'tony-mac',
    planActive: 2,
  }).reason, 'plan_capacity');
  assert.equal(projectCaptureResourceAdmission({
    resourcePolicy,
    hostLabel: 'tony-mac',
    hostActive: 3,
  }).reason, 'host_capacity');
  assert.equal(projectCaptureResourceAdmission({
    resourcePolicy,
    hostLabel: 'tony-mac',
    todaySearches: 20,
  }).reason, 'daily_search_capacity');

  assert.equal(projectCaptureResourceAdmission({
    resourcePolicy: {
      capacityGroup: 'shared-5g',
      maxActiveInGroup: 1,
    },
    groupActive: 1,
  }).reason, 'capacity_group_full');

  assert.deepEqual(projectCaptureResourceAdmission({
    hostLabel: 'tony-mac',
    todaySearches: 18,
    expectedSearches: 2,
    dailySearchLimit: 20,
  }), {allowed: true, reason: ''});
  assert.equal(projectCaptureResourceAdmission({
    hostLabel: 'tony-mac',
    todaySearches: 19,
    expectedSearches: 2,
    dailySearchLimit: 20,
  }).reason, 'account_daily_search_capacity');
});

test('host-bound plans fail closed when the Agent host label is missing', () => {
  assert.deepEqual(projectCaptureResourceAdmission({
    resourcePolicy: {maxActivePerHost: 1},
    hostLabel: '',
  }), {allowed: false, reason: 'host_unknown'});
});

test('negative patrol admission uses conservative bounded defaults', () => {
  assert.deepEqual(normalizeNegativePatrolAdmissionPolicy({}), {
    globalActiveLimit: 2,
    tenantActiveLimit: 1,
    globalFirstAdmissionIntervalMs: 10000,
    tenantFirstAdmissionIntervalMs: 10000,
    postProcessingHighWaterCount: 1000,
    postProcessingHighWaterBytes: 128 * 1024 * 1024,
  });
  const bounded = normalizeNegativePatrolAdmissionPolicy({
    NEGATIVE_PATROL_POST_PROCESSING_HIGH_WATER_COUNT: '999999',
    NEGATIVE_PATROL_POST_PROCESSING_HIGH_WATER_BYTES: '999999999999',
  });
  assert.equal(bounded.postProcessingHighWaterCount, 2000);
  assert.equal(bounded.postProcessingHighWaterBytes, 256 * 1024 * 1024);
});

test('negative patrol admission pauses before the durable post-processing cap', () => {
  const policy = normalizeNegativePatrolAdmissionPolicy({});
  const now = new Date('2026-09-07T08:00:00.000Z');
  assert.equal(projectNegativePatrolAdmission({
    policy,
    postProcessingObserved: false,
    now,
  }).reason, 'post_processing_metrics_unavailable');
  assert.equal(projectNegativePatrolAdmission({
    policy,
    postProcessingPendingCount: 1000,
    now,
  }).reason, 'post_processing_count_high_water');
  assert.equal(projectNegativePatrolAdmission({
    policy,
    postProcessingPendingCount: 999,
    postProcessingPendingBytes: 128 * 1024 * 1024,
    now,
  }).reason, 'post_processing_bytes_high_water');
  assert.deepEqual(projectNegativePatrolAdmission({
    policy,
    postProcessingPendingCount: 999,
    postProcessingPendingBytes: 128 * 1024 * 1024 - 1,
    now,
  }), {allowed: true, reason: '', retryAfterMs: 0});
});
