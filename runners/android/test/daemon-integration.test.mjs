import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {AndroidDaemon} from '../src/daemon/runtime.mjs';
import {setupRunner} from '../src/daemon/setup.mjs';
import {readConfig, setCheckpoint, stateValue} from '../src/daemon/state.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {createSimulationDevice} from '../src/daemon/simulation.mjs';
import {inspectDeviceLock} from '../src/core/device-lock.mjs';
import {confirmDeviceClosure, requestLocalStop} from '../src/daemon/local-control.mjs';
import {mockControlPlane, until} from './daemon-fixture.mjs';

const options = f => ({stateDir: f.directory, config: f.config, lockRoot: f.lockRoot,
  pollMs: 5, renewMs: 10, deliveryMs: 5, watchMs: 5});

test('setup keeps stable independent identity and private token but never activation code', async t => {
  const f = await mockControlPlane(t);
  const input = {stateDir: f.directory, baseUrl: f.baseUrl, deviceId: 'SIMULATED_DEVICE', code: 'activation-secret', simulation: true};
  await setupRunner(input);
  const first = readConfig(f.directory);
  await setupRunner(input);
  assert.equal(readConfig(f.directory).clientUuid, first.clientUuid);
  assert.notEqual(first.clientUuid, first.agentId);
  const contents = readFileSync(join(f.directory, 'connection.json'), 'utf8');
  assert.ok(!contents.includes('activation-secret'));
  assert.equal(statSync(join(f.directory, 'connection.json')).mode & 0o777, 0o600);
  assert.ok(f.state.calls.every(call => !call.token));
  await assert.rejects(setupRunner({...input, deviceId: 'ANOTHER_PHONE'}));
  await assert.rejects(setupRunner({...input, baseUrl: 'https://example.com'}));
});

test('real HTTP + SQLite daemon discovers, uploads before completion and replays lost completion identically', async t => {
  let lost = false;
  const f = await mockControlPlane(t, {onRequest: ({path, body, response, state}) => {
    if (path.pathname.endsWith('/complete') && !lost) {
      assert.ok(state.receipts.size > 0, 'must ingest before normal completion');
      state.completed = true;
      lost = true;
      response.destroy();
      return true;
    }
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const daemon = new AndroidDaemon({...options(f), store});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => f.state.calls.filter(c => c.path.endsWith('/complete')).length >= 2
    && !stateValue(store, 'daemon:completion'));
  daemon.requestStop();
  await running;
  const complete = f.state.calls.filter(c => c.path.endsWith('/complete'));
  assert.deepEqual(complete[0].body, complete[1].body);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.quarantinedCount(), 0);
  assert.equal(inspectDeviceLock({lockRoot: f.lockRoot, serial: f.config.deviceId}), null);
  assert.equal(complete[0].body.status, 'completed');
  assert.equal(complete[0].body.deviceIdle, true);
});

test('pending upload renews without redoing device actions; completion waits for durable receipts', async t => {
  let uploads = 0;
  const f = await mockControlPlane(t, {onRequest: async ({path}) => {
    if (path.pathname.endsWith('/discoveries')) { uploads++; await new Promise(resolve => setTimeout(resolve, 45)); }
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const daemon = new AndroidDaemon({...options(f), store});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => f.state.completed);
  daemon.requestStop(); await running;
  assert.equal(uploads, 1);
  assert.ok(f.state.calls.some(c => c.path.endsWith('/renew')));
  assert.equal(store.pendingCount(), 0);
});

test('real device without calibrated profile polls unavailable and never operates or receives fixture data', async t => {
  const f = await mockControlPlane(t);
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const daemon = new AndroidDaemon({...options(f), store, config: {...f.config, simulation: false}});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => f.state.calls.some(c => c.path.endsWith('/poll')));
  daemon.requestStop(); await running;
  assert.equal(store.pendingCount(), 0);
  assert.equal(stateValue(store, 'daemon:status').reason, 'profile_required');
  assert.ok(f.state.calls.filter(c => c.path.endsWith('/poll')).every(c => c.body.readyForSearch === false));
});

test('durable stop interrupts stuck device, preserves closure lock and requires explicit evidence to release', async t => {
  const f = await mockControlPlane(t);
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  let entered = false;
  const device = createSimulationDevice(f.config.deviceId);
  device.copyLink = async () => { entered = true; return new Promise(() => {}); };
  const daemon = new AndroidDaemon({...options(f), store, device});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => entered);
  const other = new RunnerStore(join(f.directory, 'runner.sqlite'));
  requestLocalStop(other); other.close();
  await running;
  const complete = f.state.calls.find(c => c.path.endsWith('/complete')).body;
  assert.equal(complete.status, 'canceled');
  assert.equal(complete.deviceIdle, false);
  assert.ok(inspectDeviceLock({lockRoot: f.lockRoot, serial: f.config.deviceId}));
  await assert.rejects(confirmDeviceClosure({store, config: f.config, lockRoot: f.lockRoot, evidence: {}}));
  const evidence = {method: 'independent_stop_check', evidenceId: 'verified-phone-unplugged',
    verifiedBy: 'test-operator', verifiedAt: new Date().toISOString()};
  await confirmDeviceClosure({store, config: f.config, lockRoot: f.lockRoot, evidence, isProcessAlive: () => false});
  assert.equal(inspectDeviceLock({lockRoot: f.lockRoot, serial: f.config.deviceId}), null);
  assert.equal(stateValue(store, `device-closure:${f.config.deviceId}`).required, false);
});

test('restart reports interrupted old session before polling and does not replay its device task', async t => {
  const f = await mockControlPlane(t);
  let store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  setCheckpoint(store, 'daemon:active', {task: f.state.task, sessionId: 'previous-process-session', leaseId: 'lease-one'});
  store.close();
  store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const daemon = new AndroidDaemon({...options(f), store});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => f.state.calls.some(c => c.path.endsWith('/poll')));
  daemon.requestStop(); await running;
  const complete = f.state.calls.find(c => c.path.endsWith('/complete')).body;
  assert.equal(complete.sessionId, 'previous-process-session');
  assert.equal(complete.status, 'interrupted');
  assert.equal(complete.identity.attemptId, f.state.task.identity.attemptId);
  assert.equal(store.pendingCount(), 0);
});

test('a second daemon using another state directory cannot operate the same fixed serial', async t => {
  const f = await mockControlPlane(t);
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const first = new AndroidDaemon({...options(f), store, config: {...f.config, simulation: false}});
  const running = first.run();
  t.after(async () => { first.requestStop(); await running; store.close(); });
  await until(() => f.state.calls.some(c => c.path.endsWith('/poll')));
  const second = new AndroidDaemon({...options(f), stateDir: join(f.directory, 'other-state')});
  await assert.rejects(second.run(), /device_locked/u);
  assert.equal(stateValue(store, 'daemon:status').running, true);
  first.requestStop(); await running;
});

test('setup cannot rebind an existing queue or overwrite a running registration', async t => {
  const f = await mockControlPlane(t);
  const input = {stateDir: f.directory, baseUrl: f.baseUrl, deviceId: f.config.deviceId, code: 'code', simulation: true};
  await setupRunner(input);
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  store.recordEvent({eventId: 'prior-event', ...f.state.task.identity});
  store.close();
  await assert.rejects(setupRunner(input), /empty queue/u);
  assert.equal(f.state.calls.filter(c => c.path.endsWith('/register')).length, 1);
});

test('remote stop from polling aborts current UI and never accepts a late renewal as permission', async t => {
  let entered = false;
  const f = await mockControlPlane(t, {onRequest: ({path, json}) => {
    if (path.pathname.endsWith('/poll') && entered) {
      json({ok: true, task: null, permit: null, control: {stopRequested: true, blocked: true, reason: 'remote_stop'}, pollAfterMs: 5});
      return true;
    }
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const device = createSimulationDevice(f.config.deviceId);
  device.copyLink = async () => { entered = true; return new Promise(() => {}); };
  const daemon = new AndroidDaemon({...options(f), store, device});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => f.state.completed);
  daemon.requestStop(); await running;
  const complete = f.state.calls.find(c => c.path.endsWith('/complete')).body;
  assert.equal(complete.status, 'canceled');
  assert.equal(complete.reason, 'remote_stop');
  assert.equal(complete.deviceIdle, false);
  assert.equal(store.pendingCount(), 0);
});

test('expired upload window closes interrupted while durable events retain their original identity', async t => {
  const f = await mockControlPlane(t, {onRequest: ({path, response, json}) => {
    if (path.pathname.endsWith('/discoveries')) {
      response.statusCode = 503; response.setHeader('retry-after', '60'); json({ok: false}); return true;
    }
  }});
  f.state.task.deadlineAt = new Date(Date.now() + 60).toISOString();
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const daemon = new AndroidDaemon({...options(f), store});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => f.state.completed);
  daemon.requestStop(); await running;
  const complete = f.state.calls.find(c => c.path.endsWith('/complete')).body;
  assert.equal(complete.status, 'interrupted');
  assert.equal(complete.reason, 'upload_deadline_expired');
  assert.equal(store.pendingCount(), 2);
  const batch = store.nextBatch();
  assert.ok(batch.events.every(event => event.attemptId === f.state.task.identity.attemptId));
  assert.ok(batch.events.every(event => event.agentId === f.config.agentId));
});

test('refused duplicate daemon cannot cancel completion in the live owner state directory', async t => {
  const f = await mockControlPlane(t, {onRequest: ({path, response, json}) => {
    if (path.pathname.endsWith('/discoveries')) {
      response.statusCode = 503; response.setHeader('retry-after', '60'); json({ok: false}); return true;
    }
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const first = new AndroidDaemon({...options(f), store});
  const running = first.run();
  t.after(async () => { first.requestStop(); await running; store.close(); });
  await until(() => stateValue(store, 'daemon:completion')?.status === 'completed' && store.pendingCount() > 0);
  const before = stateValue(store, 'daemon:completion');
  const second = new AndroidDaemon({...options(f)});
  await assert.rejects(second.run(), /device_locked/u);
  assert.deepEqual(stateValue(store, 'daemon:completion'), before);
  assert.equal(stateValue(store, 'daemon:status').running, true);
  first.requestStop(); await running;
});


test('local stop during physical session closure remains canceled instead of reporting completed', async t => {
  const f=await mockControlPlane(t),store=new RunnerStore(join(f.directory,'runner.sqlite'));
  let closing=false,release;
  const device=createSimulationDevice(f.config.deviceId);
  device.close=async()=>{closing=true;await new Promise(resolve=>{release=resolve;});
    return {closed:true,evidenceId:'physical-close-fixture',verifiedAt:new Date().toISOString()};};
  const daemon=new AndroidDaemon({...options(f),store,device});const running=daemon.run();
  t.after(async()=>{release?.();daemon.requestStop();await running;store.close();});
  await until(()=>closing);daemon.requestStop();release();await running;
  const complete=f.state.calls.find(c=>c.path.endsWith('/complete')).body;
  assert.equal(complete.status,'canceled');assert.equal(complete.reason,'user_stop');
  assert.equal(complete.deviceIdle,true);
});
