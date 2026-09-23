import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionPermit } from '../src/core/execution-permit.mjs';
import { OperationGate } from '../src/core/operation-gate.mjs';
import { fixtureTask, fixtureClock, fixturePermit } from './core-fixtures.mjs';

test('lease uses request-start monotonic time, rejects mismatched, delayed and stale grants', () => {
  const task = fixtureTask();
  const clock = fixtureClock();
  const permit = new ExecutionPermit({ identity: task.identity, monotonicNow: clock.monotonicNow });
  const lease = { ...task.identity, leaseId: 'l', serverTime: '2026-09-22T00:00:00Z', leaseUntil: '2026-09-22T00:01:30Z' };
  assert.throws(() => permit.grant({ ...lease, attemptId: 'wrong' }, { requestStartedAt: 100 }), { code: 'lease_identity_mismatch' });
  clock.advance(10_000);
  permit.grant(lease, { requestStartedAt: 100 });
  assert.equal(permit.expiresAt, 90_100);
  clock.wallOnly(-1_000_000);
  permit.assertAllowed();
  assert.throws(() => permit.grant(lease, { requestStartedAt: 99 }), { code: 'stale_lease' });
  clock.advance(80_000);
  assert.throws(() => permit.assertAllowed(), { code: 'lease_expired' });
  assert.throws(() => permit.grant(lease, { requestStartedAt: 100 }), { code: 'expired_lease_response' });
});

test('stop cannot be undone by a late lease response', () => {
  const task = fixtureTask();
  const clock = fixtureClock();
  const permit = fixturePermit(task, clock);
  permit.stop('operator_takeover');
  assert.equal(permit.signal.aborted, true);
  assert.throws(() => permit.assertAllowed(), { code: 'operator_takeover' });
  assert.throws(() => permit.grant({}, { requestStartedAt: 100 }), { code: 'stopped' });
});

test('abort cannot claim a stuck device is idle and prevents another action', async () => {
  const task = fixtureTask();
  const clock = fixtureClock();
  const permit = fixturePermit(task, clock);
  const gate = new OperationGate({ permit, beforeAction() {}, timeoutMs: 200 });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let complete;
  const pending = gate.run(async () => { entered(); return new Promise((resolve) => { complete = resolve; }); });
  await ready;
  permit.stop();
  await assert.rejects(pending, { code: 'user_stop' });
  assert.equal(gate.deviceIdle, false);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.deviceIdle, false, 'settling a timed-out promise is not physical stop evidence');
  await assert.rejects(gate.run(async () => {}), { code: 'operation_not_settled' });
});

test('bounded command timeout blocks future operations without releasing control', async () => {
  const task = fixtureTask();
  const clock = fixtureClock();
  const gate = new OperationGate({ permit: fixturePermit(task, clock), beforeAction() {}, timeoutMs: 5 });
  await assert.rejects(gate.run(() => new Promise(() => {})), { code: 'device_action_timeout' });
  assert.equal(gate.deviceIdle, false);
  await assert.rejects(gate.run(async () => {}), { code: 'operation_not_settled' });
});
