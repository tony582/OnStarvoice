import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureCreateCommandExpiredBeforeOpen,
  captureCreateCommandExpiryEligible,
  captureExecutionNeverOpened,
} from '../server/modules/capture/infrastructure/postgres-command-reconciliation.js';

const now = Date.parse('2026-09-02T06:00:00.000Z');
const graceMs = 10 * 60 * 1000;
const onlineCreate = {
  status: 'acknowledged',
  commandType: 'create',
  lastLivenessAt: '2026-09-02T05:59:55.000Z',
  lastFullHeartbeatAt: '2026-09-02T05:30:00.000Z',
  taskStatus: 'pending',
};

test('canonical command expiry distinguishes delivery ACK from execution evidence', () => {
  for (const taskStatus of ['pending', 'claimed']) {
    assert.equal(captureCreateCommandExpiryEligible({
      ...onlineCreate,
      taskStatus,
    }, now, graceMs), true, `${taskStatus} without execution evidence must expire`);
  }
  for (const evidence of [
    {taskStatus: 'running'},
    {taskHeartbeatAt: '2026-09-02T05:59:54.000Z'},
    {taskStartedAt: '2026-09-02T05:50:00.000Z'},
    {executionAttemptObserved: true},
  ]) {
    assert.equal(captureCreateCommandExpiryEligible({
      ...onlineCreate,
      ...evidence,
    }, now, graceMs), false, JSON.stringify(evidence));
  }
  assert.equal(captureCreateCommandExpiryEligible({
    ...onlineCreate,
    taskStatus: '',
  }, now, graceMs), false, 'missing task state is not proof of an unstarted create');
});

test('pending, non-create, and offline expiry retain their original policy', () => {
  assert.equal(captureCreateCommandExpiryEligible({
    ...onlineCreate,
    status: 'pending',
    executionAttemptObserved: true,
  }, now, graceMs), true);
  assert.equal(captureCreateCommandExpiryEligible({
    ...onlineCreate,
    commandType: 'stop',
  }, now, graceMs), true);
  assert.equal(captureCreateCommandExpiryEligible({
    ...onlineCreate,
    lastLivenessAt: '2026-09-02T05:49:59.999Z',
    executionAttemptObserved: true,
  }, now, graceMs), true);
  for (const status of ['completed', 'expired', 'failed', '']) {
    assert.equal(captureCreateCommandExpiryEligible({
      ...onlineCreate,
      status,
    }, now, graceMs), false, status);
  }
});

test('expiring an acknowledged create does not waive the local closure fence', () => {
  const error = {
    code: 'create_command_expired',
    commandStatusBeforeExpiry: 'acknowledged',
  };
  assert.equal(captureCreateCommandExpiredBeforeOpen({error}), false);
  assert.equal(captureExecutionNeverOpened({
    executionTaskId: 'ad93d0f0-e55b-4c98-bba4-b033bf99a345',
    error,
    attemptExists: true,
    attemptCount: 1,
  }), false);
  const pendingError = {...error, commandStatusBeforeExpiry: 'pending'};
  assert.equal(captureCreateCommandExpiredBeforeOpen({error: pendingError}), true);
  for (const startedField of [
    'executionStartedAt', 'itemStartedAt', 'attemptStartedAt',
  ]) {
    assert.equal(captureCreateCommandExpiredBeforeOpen({
      error: pendingError,
      [startedField]: '2026-09-02T05:50:00.000Z',
    }), false, startedField);
  }
});
