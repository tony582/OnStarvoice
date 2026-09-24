import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import test from 'node:test';
import {AndroidDaemon, closureProofFor} from '../src/daemon/runtime.mjs';
import {setCheckpoint, stateValue} from '../src/daemon/state.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {createSimulationDevice} from '../src/daemon/simulation.mjs';
import {DeviceClosureJournal} from '../src/core/device-closure.mjs';
import {mockControlPlane, until} from './daemon-fixture.mjs';
import {fixtureTask} from './core-fixtures.mjs';

const options = f => ({stateDir: f.directory, config: f.config, lockRoot: f.lockRoot, pollMs: 5, renewMs: 10, deliveryMs: 5, watchMs: 5});
const polls = f => f.state.calls.filter(c => c.path.endsWith('/poll'));

test('Douyin outside the foreground blocks claiming; only a fresh passing probe lets the next poll claim', async t => {
  const f = await mockControlPlane(t);
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const device = createSimulationDevice(f.config.deviceId);
  let probeState = {readyForSearch: false, reason: 'douyin_not_foreground', focus: 'com.smartisanos.launcher'};
  let probes = 0;
  device.probe = async () => { probes++; return probeState; };
  const daemon = new AndroidDaemon({...options(f), store, device});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => polls(f).length >= 3);
  const early = polls(f);
  assert.ok(early.every(c => c.body.readyForSearch === false));
  assert.equal(f.state.calls.some(c => c.path.endsWith('/complete')), false);
  await until(() => stateValue(store, 'daemon:status')?.reason === 'douyin_not_foreground');
  assert.equal(stateValue(store, 'daemon:status').deviceProbe.focus, 'com.smartisanos.launcher');
  assert.ok(probes >= early.length, 'every idle poll follows its own probe');
  probeState = {readyForSearch: true, reason: null, foreground: {package: 'com.ss.android.ugc.aweme', activity: '.main.MainActivity', launched: true}};
  await until(() => f.state.completed);
  daemon.requestStop(); await running;
  const complete = f.state.calls.find(c => c.path.endsWith('/complete')).body;
  assert.equal(complete.status, 'completed');
  assert.equal(polls(f).find(c => c.body.readyForSearch === true).body.readyForSearch, true);
  assert.equal(stateValue(store, 'daemon:status').deviceProbe.foreground.launched, true);
});

test('a readiness failure at inspect demotes the runner until re-probed, and the next new run starts clean', async t => {
  const f = await mockControlPlane(t, {onRequest: ({path, body, json, state, lease}) => {
    if (path.pathname.endsWith('/poll')) {
      const next = state.queue[0] ?? null;
      json({ok: true, task: body.readyForSearch && next ? next : null, permit: next ? {...lease(), ...next.identity} : null, control: {}, pollAfterMs: 5, renewAfterMs: 30000});
      return true;
    }
    if (path.pathname.endsWith('/complete')) {
      state.completions = [...(state.completions ?? []), body];
      state.queue.shift();
      state.completed = state.queue.length === 0;
      json({ok: true, accepted: true, deviceHeld: !body.deviceIdle});
      return true;
    }
  }});
  const fresh = () => { const id = randomUUID(); return {...f.state.task, identity: {...f.state.task.identity, taskId: id, discoveryRunId: id, itemId: randomUUID(), attemptId: randomUUID()}}; };
  f.state.queue = [fresh(), fresh()];
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const device = createSimulationDevice(f.config.deviceId);
  const inspect = device.inspect;
  let inspects = 0;
  device.inspect = async params => { if (inspects++ === 0) throw Object.assign(new Error('background'), {code: 'douyin_not_foreground', deviceSettled: true}); return inspect(params); };
  let sawDemotion = false;
  const daemon = new AndroidDaemon({...options(f), store, device});
  device.probe = async () => { if (daemon.ready === false) sawDemotion = true; return {readyForSearch: true, reason: null}; };
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => f.state.completed, 5000);
  daemon.requestStop(); await running;
  const [first, second] = f.state.completions;
  assert.equal(first.status, 'needs_action');
  assert.equal(first.reason, 'douyin_not_foreground');
  assert.equal(first.deviceIdle, true, 'a read-only foreground check leaves nothing in flight');
  assert.equal(sawDemotion, true, 'the runner stopped advertising readiness before the next probe');
  assert.equal(second.status, 'completed');
  assert.notEqual(second.identity.taskId, first.identity.taskId);
  assert.ok(f.state.completions.every(c => c.reason !== 'resume_authorization_required'));
  assert.equal(store.loadCheckpoint(second.identity.discoveryRunId).value.items[second.identity.itemId].status, 'completed');
  assert.equal(store.loadCheckpoint(first.identity.discoveryRunId).value.items[first.identity.itemId].status, 'needs_action');
});

test('a retained closure proof reaches a task only for the pending operation it names', () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask();
    const journal = new DeviceClosureJournal({store, task, clock: {wallNow: Date.now}});
    journal.begin('openCard');
    const proof = {deviceId: task.deviceId, operationId: journal.value.operationId, method: 'independent_stop_check',
      evidenceId: 'phone-checked', verifiedBy: 'operator', verifiedAt: new Date().toISOString()};
    setCheckpoint(store, 'daemon:closure-proof', {...proof, operationId: randomUUID()});
    assert.equal(closureProofFor(store, task.deviceId), null, 'an older proof never travels to a new task');
    setCheckpoint(store, 'daemon:closure-proof', proof);
    assert.deepEqual(closureProofFor(store, task.deviceId), proof);
    journal.complete();
    assert.equal(closureProofFor(store, task.deviceId), null, 'nothing pending means nothing to prove');
  } finally { store.close(); }
});
