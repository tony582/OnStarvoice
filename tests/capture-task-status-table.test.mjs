import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES,
  CROSS_DEVICE_RETRY_ITEM_STATUSES,
  CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES,
  CROSS_DEVICE_RETRY_SOURCE_STATUSES,
  CROSS_DEVICE_RETRY_TASK_TYPES,
  CROSS_DEVICE_RETRY_UNSTARTED_ITEM_STATUSES,
  DISMISSIBLE_ATTENTION_STATUSES,
  RECOVERABLE_STATUSES,
  REMOTELY_STOPPABLE_STATUSES,
  STOP_FINAL_STATUSES,
} from '../server/modules/capture/domain/task-status.js';
import {
  CROSS_DEVICE_RETRY_PERMANENT_CODES,
  ELASTIC_AGENT_CAPACITY_CODES,
  ELASTIC_BOOTSTRAP_CONGESTION_CODES,
  ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES,
  ELASTIC_STALE_TASK_CODES,
  EXPLICIT_USER_CANCELLATION_CODES,
} from '../server/modules/capture/domain/attempt-codes.js';

function isSubset(subset, superset) {
  return [...subset].every(value => superset.has(value));
}

function intersection(left, right) {
  return [...left].filter(value => right.has(value));
}

test('final statuses are never remotely stoppable', () => {
  assert.deepEqual(intersection(STOP_FINAL_STATUSES, REMOTELY_STOPPABLE_STATUSES), []);
});

test('operator recovery, dismissal and cross-device retry all start from stoppable statuses', () => {
  assert.ok(isSubset(RECOVERABLE_STATUSES, REMOTELY_STOPPABLE_STATUSES));
  assert.ok(isSubset(DISMISSIBLE_ATTENTION_STATUSES, RECOVERABLE_STATUSES));
  assert.ok(isSubset(CROSS_DEVICE_RETRY_SOURCE_STATUSES, RECOVERABLE_STATUSES));
});

test('a cross-device retry source is always already settled', () => {
  assert.ok(isSubset(CROSS_DEVICE_RETRY_SOURCE_STATUSES, CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES));
  assert.ok(isSubset(STOP_FINAL_STATUSES, CROSS_DEVICE_RETRY_SOURCE_FINAL_STATUSES));
});

test('unstarted items are a subset of retryable items and never overlap follow-up activity', () => {
  assert.ok(isSubset(CROSS_DEVICE_RETRY_UNSTARTED_ITEM_STATUSES, CROSS_DEVICE_RETRY_ITEM_STATUSES));
  assert.ok(isSubset(AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES, REMOTELY_STOPPABLE_STATUSES));
});

test('every cross-device retry task type is a known patrol or capture task', () => {
  for (const taskType of CROSS_DEVICE_RETRY_TASK_TYPES) {
    assert.match(taskType, /^[a-z_]+$/u);
  }
  assert.equal(CROSS_DEVICE_RETRY_TASK_TYPES.size, 6);
});

test('capacity and congestion failures never charge an attempt', () => {
  assert.ok(isSubset(ELASTIC_AGENT_CAPACITY_CODES, ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES));
  assert.ok(isSubset(ELASTIC_BOOTSTRAP_CONGESTION_CODES, ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES));
});

test('stale-lease codes and permanent codes are disjoint from the non-chargeable class', () => {
  assert.deepEqual(intersection(ELASTIC_STALE_TASK_CODES, ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES), []);
  assert.deepEqual(intersection(CROSS_DEVICE_RETRY_PERMANENT_CODES, ELASTIC_NON_CHARGEABLE_ATTEMPT_CODES), []);
});

test('an explicit user cancellation that is permanent is spelled USER_CANCELED', () => {
  assert.deepEqual(
    intersection(EXPLICIT_USER_CANCELLATION_CODES, CROSS_DEVICE_RETRY_PERMANENT_CODES),
    ['USER_CANCELED'],
  );
});
