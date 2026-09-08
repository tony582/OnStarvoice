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

test('negative patrol admission bounds server work without a default browser lifetime cap', () => {
  assert.deepEqual(normalizeNegativePatrolAdmissionPolicy({}), {
    globalActiveLimit: 0,
    tenantActiveLimit: 0,
    globalFirstAdmissionIntervalMs: 10000,
    tenantFirstAdmissionIntervalMs: 10000,
    postProcessingHighWaterCount: 1000,
    postProcessingHighWaterBytes: 128 * 1024 * 1024,
  });
  const bounded = normalizeNegativePatrolAdmissionPolicy({
    NEGATIVE_PATROL_GLOBAL_ACTIVE_LIMIT: '999999',
    NEGATIVE_PATROL_TENANT_ACTIVE_LIMIT: '999999',
    NEGATIVE_PATROL_POST_PROCESSING_HIGH_WATER_COUNT: '999999',
    NEGATIVE_PATROL_POST_PROCESSING_HIGH_WATER_BYTES: '999999999999',
  });
  assert.equal(bounded.globalActiveLimit, 50);
  assert.equal(bounded.tenantActiveLimit, 20);
  assert.equal(bounded.postProcessingHighWaterCount, 2000);
  assert.equal(bounded.postProcessingHighWaterBytes, 256 * 1024 * 1024);
});

test('eight idle Agents in one tenant can all receive a post without waiting for earlier posts to finish', () => {
  const policy = normalizeNegativePatrolAdmissionPolicy({});
  const start = Date.parse('2026-09-08T08:00:00.000Z');
  let active = 0;
  let lastAdmittedAt = null;
  for (let agent = 0; agent < 8; agent += 1) {
    const now = new Date(start + agent * 10000);
    assert.deepEqual(projectNegativePatrolAdmission({
      policy,
      globalActive: active,
      tenantActive: active,
      lastGlobalAdmittedAt: lastAdmittedAt,
      lastTenantAdmittedAt: lastAdmittedAt,
      now,
    }), {allowed: true, reason: '', retryAfterMs: 0}, `Agent ${agent + 1}`);
    active += 1;
    lastAdmittedAt = now;

    // Serialized competitors cannot spend the same admission interval, even
    // though more browsers are free and existing posts have not completed.
    assert.deepEqual(projectNegativePatrolAdmission({
      policy,
      globalActive: active,
      tenantActive: active,
      lastGlobalAdmittedAt: lastAdmittedAt,
      lastTenantAdmittedAt: lastAdmittedAt,
      now,
    }), {
      allowed: false,
      reason: 'global_admission_rate',
      retryAfterMs: 10000,
    });
  }
  assert.equal(active, 8);
});

test('negative patrol admission keeps independent global and tenant rate limits', () => {
  const policy = normalizeNegativePatrolAdmissionPolicy({
    NEGATIVE_PATROL_GLOBAL_ADMISSION_INTERVAL_MS: '10000',
    NEGATIVE_PATROL_TENANT_ADMISSION_INTERVAL_MS: '20000',
  });
  const lastAdmittedAt = new Date('2026-09-08T08:00:00.000Z');
  const input = {
    policy,
    globalActive: 8,
    tenantActive: 8,
    lastGlobalAdmittedAt: lastAdmittedAt,
    lastTenantAdmittedAt: lastAdmittedAt,
  };
  assert.deepEqual(projectNegativePatrolAdmission({
    ...input,
    now: new Date('2026-09-08T08:00:09.999Z'),
  }), {allowed: false, reason: 'global_admission_rate', retryAfterMs: 1});
  assert.deepEqual(projectNegativePatrolAdmission({
    ...input,
    now: new Date('2026-09-08T08:00:10.000Z'),
  }), {allowed: false, reason: 'tenant_admission_rate', retryAfterMs: 10000});
  assert.deepEqual(projectNegativePatrolAdmission({
    ...input,
    now: new Date('2026-09-08T08:00:20.000Z'),
  }), {allowed: true, reason: '', retryAfterMs: 0});
});

test('explicit negative patrol emergency lifetime limits are still enforced', () => {
  const policy = normalizeNegativePatrolAdmissionPolicy({
    NEGATIVE_PATROL_GLOBAL_ACTIVE_LIMIT: '2',
    NEGATIVE_PATROL_TENANT_ACTIVE_LIMIT: '1',
  });
  const now = new Date('2026-09-08T08:00:00.000Z');
  assert.deepEqual(projectNegativePatrolAdmission({policy, now}), {
    allowed: true, reason: '', retryAfterMs: 0,
  });
  assert.deepEqual(projectNegativePatrolAdmission({
    policy, now, globalActive: 1, tenantActive: 1,
  }), {allowed: false, reason: 'tenant_active_limit', retryAfterMs: 5000});
  assert.deepEqual(projectNegativePatrolAdmission({
    policy, now, globalActive: 2, tenantActive: 0,
  }), {allowed: false, reason: 'global_active_limit', retryAfterMs: 5000});
  const uncapped = normalizeNegativePatrolAdmissionPolicy({
    NEGATIVE_PATROL_GLOBAL_ACTIVE_LIMIT: '0',
    NEGATIVE_PATROL_TENANT_ACTIVE_LIMIT: '0',
  });
  assert.deepEqual(projectNegativePatrolAdmission({
    policy: uncapped, now, globalActive: 50, tenantActive: 20,
  }), {allowed: true, reason: '', retryAfterMs: 0});
});

test('negative patrol admission pauses before the durable post-processing cap', () => {
  const policy = normalizeNegativePatrolAdmissionPolicy({});
  const now = new Date('2026-09-07T08:00:00.000Z');
  assert.equal(projectNegativePatrolAdmission({
    policy,
    globalActive: 8,
    tenantActive: 8,
    postProcessingObserved: false,
    now,
  }).reason, 'post_processing_metrics_unavailable');
  assert.equal(projectNegativePatrolAdmission({
    policy,
    globalActive: 8,
    tenantActive: 8,
    postProcessingPendingCount: 1000,
    now,
  }).reason, 'post_processing_count_high_water');
  assert.equal(projectNegativePatrolAdmission({
    policy,
    globalActive: 8,
    tenantActive: 8,
    postProcessingPendingCount: 999,
    postProcessingPendingBytes: 128 * 1024 * 1024,
    now,
  }).reason, 'post_processing_bytes_high_water');
  assert.deepEqual(projectNegativePatrolAdmission({
    policy,
    globalActive: 8,
    tenantActive: 8,
    postProcessingPendingCount: 999,
    postProcessingPendingBytes: 128 * 1024 * 1024 - 1,
    now,
  }), {allowed: true, reason: '', retryAfterMs: 0});
});
