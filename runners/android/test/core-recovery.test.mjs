import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { RunnerStore } from '../src/storage/runner-store.mjs';
import { runDiscoveryTask } from '../src/core/discovery-runner.mjs';
import { readDeviceClosure } from '../src/core/device-closure.mjs';
import { BudgetLedger } from '../src/core/budget.mjs';
import { fixtureTask, fixtureClock, fixturePermit, fixtureDevice } from './core-fixtures.mjs';

test('crash between durable event and noteLink cannot grant extra discovery budget after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'android-crash-budget-'));
  const path = join(dir, 'state.sqlite');
  const task = fixtureTask({ budgets: { maxLinks: 1 } });
  const clock = fixtureClock();
  let store;
  try {
    store = new RunnerStore(path);
    const ledger = new BudgetLedger({ task, store, clock });
    ledger.beforeCard();
    const event = { eventId: 'original', ...task.identity, verification: 'verified', verifiedExternalId: '1234567890123456789' };
    store.recordEvent(event); // Simulated crash cut: no noteLink, no finish.
    store.recordEvent({ ...event, eventId: 'repeat-old-attempt', attemptId: 'another-old-attempt' });
    store.recordEvent({ ...event, eventId: 'other-item', itemId: 'other', verifiedExternalId: '2234567890123456789' });
    store.recordEvent({ ...event, eventId: 'not-verified', verification: 'link_unverified', verifiedExternalId: '3234567890123456789' });
    store.close();
    store = new RunnerStore(path);
    const resumed = { ...task, identity: { ...task.identity, attemptId: 'attempt-2', assignmentRevision: 2 } };
    const { device, calls } = fixtureDevice(resumed);
    const result = await runDiscoveryTask({ task: resumed, store, clock, device,
      permit: fixturePermit(resumed, clock), resumeAuthorized: true });
    assert.equal(result.reason, 'link_limit');
    assert.equal(result.stats.links, 1);
    assert.equal(result.stats.cards, 1);
    assert.deepEqual(calls, []);
    assert.equal(store.getEvent('original').payload.attemptId, 'attempt-1');
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('timeout uncertainty survives real SQLite reopen and requires operation-specific closure evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'android-stop-reopen-'));
  const path = join(dir, 'state.sqlite');
  const task = fixtureTask();
  const clock = fixtureClock();
  let store;
  try {
    store = new RunnerStore(path);
    const first = fixtureDevice(task, { openCard: () => new Promise(() => {}) });
    const stopped = await runDiscoveryTask({ task, store, clock, device: first.device,
      permit: fixturePermit(task, clock), actionTimeoutMs: 5 });
    assert.equal(stopped.reason, 'device_action_timeout');
    assert.equal(stopped.stopConfirmationRequired, true);
    const closure = stopped.deviceClosure;
    store.close();
    store = new RunnerStore(path);
    const resumed = { ...task, identity: { ...task.identity, attemptId: 'attempt-2', assignmentRevision: 2 } };
    const next = fixtureDevice(resumed);
    const args = { task: resumed, store, clock, device: next.device,
      permit: fixturePermit(resumed, clock), resumeAuthorized: true };
    const blocked = await runDiscoveryTask(args);
    assert.equal(blocked.reason, 'device_closure_required');
    assert.equal(blocked.deviceIdle, false);
    assert.deepEqual(next.calls, []);
    assert.equal((await runDiscoveryTask({ ...args, deviceClosureVerified: true })).reason, 'device_closure_required');
    const proof = { deviceId: task.deviceId, operationId: closure.operationId, method: 'operator_takeover',
      evidenceId: 'manual-check-1', verifiedBy: 'test-operator', verifiedAt: new Date(clock.wallNow()).toISOString() };
    assert.equal((await runDiscoveryTask({ ...args, deviceClosureVerified: { ...proof, operationId: 'wrong' } })).reason, 'device_closure_required');
    const restored = await runDiscoveryTask({ ...args, deviceClosureVerified: proof });
    assert.equal(restored.status, 'completed');
    assert.equal(restored.stopConfirmationRequired, false);
    assert.deepEqual(readDeviceClosure(store, task.deviceId).lastClosureProof, proof);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('actual process exit during a device action retains a pending marker before another run can inspect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'android-process-crash-'));
  const path = join(dir, 'state.sqlite');
  const moduleUrl = (relative) => new URL(relative, import.meta.url).href;
  try {
    const script = `
      import { RunnerStore } from ${JSON.stringify(moduleUrl('../src/storage/runner-store.mjs'))};
      import { runDiscoveryTask } from ${JSON.stringify(moduleUrl('../src/core/discovery-runner.mjs'))};
      import { fixtureTask, fixtureClock, fixturePermit, fixtureDevice } from ${JSON.stringify(moduleUrl('./core-fixtures.mjs'))};
      const task = fixtureTask(); const clock = fixtureClock(); const store = new RunnerStore(${JSON.stringify(path)});
      const {device} = fixtureDevice(task, { openCard: async () => process.exit(73) });
      await runDiscoveryTask({task,clock,store,device,permit:fixturePermit(task,clock)});
    `;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(crashed.status, 73, crashed.stderr);
    const store = new RunnerStore(path);
    try {
      const task = fixtureTask({ identity: { ...fixtureTask().identity, taskId: 'new-run', discoveryRunId: 'new-run', itemId: 'new-item' } });
      const clock = fixtureClock();
      const { device, calls } = fixtureDevice(task);
      const result = await runDiscoveryTask({ task, clock, store, device, permit: fixturePermit(task, clock) });
      assert.equal(result.reason, 'device_closure_required');
      assert.equal(result.deviceClosure.operation, 'openCard');
      assert.equal(result.deviceIdle, false);
      assert.deepEqual(calls, []);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
