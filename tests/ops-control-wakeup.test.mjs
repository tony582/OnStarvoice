import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpsControlEventWake,
  opsControlWakeupRetryDelayMs,
  processOpsControlWakeupBatch,
  shouldScheduleOpsControlFollowup,
} from '../server/services/ops-control-wakeup.js';

test('event wakeup metadata is bounded and preserves distinct durable reasons', () => {
  const activation = buildOpsControlEventWake([
    {
      reason: 'task_created',
      source_type: 'capture_task',
      created_at: '2026-08-24T12:00:01.000Z',
    },
    {
      reason: 'command_created',
      source_type: 'capture_command',
      created_at: '2026-08-24T12:00:02.000Z',
    },
  ]);
  assert.equal(activation.reason, 'multiple_events');
  assert.deepEqual(activation.reasons, ['task_created', 'command_created']);
  assert.deepEqual(activation.sourceTypes, ['capture_task', 'capture_command']);
  assert.equal(activation.eventCount, 2);
  assert.equal(activation.firstEventAt, '2026-08-24T12:00:01.000Z');
});

test('followups continue only while evidence, active work or action verification needs them', () => {
  assert.equal(shouldScheduleOpsControlFollowup({kind: 'outside_window'}), false);
  assert.equal(shouldScheduleOpsControlFollowup({
    kind: 'observed',
    assessment: {summary: {consecutiveEvidence: false}},
  }), true);
  assert.equal(shouldScheduleOpsControlFollowup({
    kind: 'observed',
    assessment: {
      lifecycleStatus: 'progressing',
      summary: {consecutiveEvidence: true, activeTaskCount: 1},
    },
    actions: {pendingVerification: 0},
  }), true);
  assert.equal(shouldScheduleOpsControlFollowup({
    kind: 'observed',
    assessment: {
      lifecycleStatus: 'settled',
      verdict: 'healthy',
      summary: {consecutiveEvidence: true, activeTaskCount: 0},
    },
    activation: {activeCommandCount: 0, pendingActionCount: 0},
    actions: {pendingVerification: 0},
  }), false);
});

test('wakeup retry backoff is bounded', () => {
  assert.equal(opsControlWakeupRetryDelayMs(1), 5_000);
  assert.equal(opsControlWakeupRetryDelayMs(2), 10_000);
  assert.equal(opsControlWakeupRetryDelayMs(7), 300_000);
  assert.equal(opsControlWakeupRetryDelayMs(99), 300_000);
});

test('one claimed batch coalesces by tenant and schedules only required followups', async () => {
  const completed = [];
  const retried = [];
  const enqueued = [];
  const observedTenants = [];
  const now = new Date('2026-08-24T12:00:05.000Z');
  const summary = await processOpsControlWakeupBatch({
    now,
    env: {OPS_CONTROL_GLOBAL_ENABLED: 'true'},
    claimWakeups: async () => ({
      claimToken: 'a0000000-0000-4000-8000-000000000001',
      wakeups: [
        {
          id: 1,
          tenant_id: 'tenant-a',
          reason: 'task_created',
          source_type: 'capture_task',
          created_at: '2026-08-24T12:00:03.000Z',
        },
        {
          id: 2,
          tenant_id: 'tenant-a',
          reason: 'command_created',
          source_type: 'capture_command',
          created_at: '2026-08-24T12:00:04.000Z',
        },
        {
          id: 3,
          tenant_id: 'tenant-b',
          reason: 'task_state_changed',
          source_type: 'capture_task',
          created_at: '2026-08-24T12:00:04.000Z',
        },
      ],
    }),
    observeTenant: async ({tenantId}) => {
      observedTenants.push(tenantId);
      if (tenantId === 'tenant-b') {
        return {result: {kind: 'disabled', tenantId}, policy: {snapshotGapSeconds: 25}};
      }
      return {
        policy: {snapshotGapSeconds: 30},
        result: {
          kind: 'observed',
          tenantId,
          run: {id: 'run-a'},
          sequence: 1,
          assessment: {
            lifecycleStatus: 'observing',
            verdict: 'pending',
            summary: {consecutiveEvidence: false, activeTaskCount: 1},
          },
          activation: {activeCommandCount: 1, pendingActionCount: 0},
          actions: {pendingVerification: 0},
        },
      };
    },
    completeWakeups: async input => {
      completed.push(input);
      return input.ids.length;
    },
    retryWakeups: async input => {
      retried.push(input);
      return input.wakeups.length;
    },
    enqueueWakeup: async input => {
      enqueued.push(input);
      return 9;
    },
    cleanupWakeups: async () => 0,
  });

  assert.deepEqual(observedTenants, ['tenant-a', 'tenant-b']);
  assert.equal(summary.claimed, 3);
  assert.equal(summary.tenants, 2);
  assert.equal(summary.observed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.followups, 1);
  assert.equal(summary.eventLatencyMs, 2_000);
  assert.deepEqual(completed.map(row => row.ids), [[1, 2], [3]]);
  assert.deepEqual(retried, []);
  assert.equal(enqueued[0].reason, 'observation_followup');
  assert.equal(enqueued[0].availableAt.toISOString(), '2026-08-24T12:00:35.000Z');
});

test('a failed tenant releases only its claimed wakeups for durable retry', async () => {
  const retries = [];
  const summary = await processOpsControlWakeupBatch({
    now: new Date('2026-08-24T12:00:00.000Z'),
    claimWakeups: async () => ({
      claimToken: 'a0000000-0000-4000-8000-000000000002',
      wakeups: [{
        id: 4,
        tenant_id: 'tenant-c',
        reason: 'schedule_due',
        source_type: 'capture_schedule',
        created_at: '2026-08-24T11:59:59.000Z',
      }],
    }),
    observeTenant: async () => {
      throw new Error('temporary database failure');
    },
    retryWakeups: async input => {
      retries.push(input);
      return 1;
    },
    completeWakeups: async () => assert.fail('failed wakeup was completed'),
    cleanupWakeups: async () => 0,
  });
  assert.equal(summary.failed, 1);
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0].wakeups.map(row => row.id), [4]);
});
