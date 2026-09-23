import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import test from 'node:test';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {setCheckpoint, stateValue} from '../src/daemon/state.mjs';
import {confirmDeviceClosure} from '../src/daemon/local-control.mjs';
import {acquireDeviceLock, inspectDeviceLock} from '../src/core/device-lock.mjs';
import {mockControlPlane} from './daemon-fixture.mjs';

function uncertainTask(f, store) {
  const task = f.state.task;
  setCheckpoint(store, 'daemon:last-task', {task, sessionId: randomUUID()});
  setCheckpoint(store, `device-closure:${task.deviceId}`, {required: true, deviceId: task.deviceId,
    identity: task.identity, operationId: randomUUID(), startedAt: Date.now() - 100, operation: 'copyLink'});
  const lock = acquireDeviceLock({lockRoot: f.lockRoot, serial: task.deviceId});
  setCheckpoint(store, 'daemon:lock', {token: lock.token, serial: task.deviceId});
  return {method: 'independent_stop_check', evidenceId: randomUUID(), verifiedBy: 'actual-operator', verifiedAt: new Date().toISOString()};
}

test('lost close response retains original proof and request identity until replay and physical release', async t => {
  let lost = false;
  const f = await mockControlPlane(t, {onRequest: ({path, response}) => {
    if (path.pathname.endsWith('/close') && !lost) { lost = true; response.destroy(); return true; }
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  t.after(() => store.close());
  const evidence = uncertainTask(f, store);
  const input = {store, config: f.config, lockRoot: f.lockRoot, evidence, isProcessAlive: () => false};
  await assert.rejects(confirmDeviceClosure(input));
  assert.ok(stateValue(store, 'daemon:close'));
  assert.ok(inspectDeviceLock({lockRoot: f.lockRoot, serial: f.config.deviceId}));
  await confirmDeviceClosure({...input, evidence: {...evidence, evidenceId: 'later-input-must-not-mutate-original'}});
  const closes = f.state.calls.filter(c => c.path.endsWith('/close'));
  assert.deepEqual(closes[0].body, closes[1].body);
  assert.equal(stateValue(store, 'daemon:close'), null);
  assert.equal(inspectDeviceLock({lockRoot: f.lockRoot, serial: f.config.deviceId}), null);
});

test('closure cannot use a later session task identity to close an older uncertain operation', async t => {
  const f = await mockControlPlane(t);
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  t.after(() => store.close());
  const evidence = uncertainTask(f, store);
  const previous = stateValue(store, 'daemon:last-task');
  setCheckpoint(store, 'daemon:last-task', {...previous, task: {...previous.task,
    identity: {...previous.task.identity, attemptId: randomUUID(), assignmentRevision: 2}}});
  await assert.rejects(confirmDeviceClosure({store, config: f.config, lockRoot: f.lockRoot,
    evidence, isProcessAlive: () => false}), /identity differs/u);
  assert.equal(f.state.calls.length, 0);
  assert.ok(inspectDeviceLock({lockRoot: f.lockRoot, serial: f.config.deviceId}));
});
