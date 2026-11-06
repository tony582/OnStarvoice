import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';
import {AndroidDaemon, delay} from '../src/daemon/runtime.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {createSimulationDevice} from '../src/daemon/simulation.mjs';
import {mockControlPlane, until} from './daemon-fixture.mjs';

const options = f => ({stateDir: f.directory, config: f.config, lockRoot: f.lockRoot, pollMs: 5, renewMs: 10, deliveryMs: 5, watchMs: 5});

// 2026-11-05 OnStar trial: a poll sent while 别克OTA ran came back after it finished, still carrying the open lease.
// The runner started the same task again, failed it as resume_authorization_required and sent that instead of "completed".
test('a poll answered after the task finished never starts the same attempt again', async t => {
  let daemon;
  let held = false;
  let released = false;
  const f = await mockControlPlane(t, {onRequest: async ({path, json, state, lease}) => {
    if (!path.pathname.endsWith('/poll') || !daemon?.active || held) return false;
    // The one poll sent while the task runs is answered only after it finished, with the lease the server still holds open.
    held = true;
    while (daemon.active) await delay(2);
    released = true;
    json({ok: true, task: state.task, permit: lease(), control: {}, pollAfterMs: 5});
    return true;
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const device = createSimulationDevice(f.config.deviceId);
  const copyLink = device.copyLink.bind(device);
  device.copyLink = async (...args) => { await until(() => held, 3000); return copyLink(...args); };
  daemon = new AndroidDaemon({...options(f), store, device});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => released && f.state.completed, 5000);
  await delay(50);
  daemon.requestStop(); await running;
  const completions = f.state.calls.filter(c => c.path.endsWith('/complete'));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].body.status, 'completed');
  assert.equal(completions[0].body.identity.attemptId, f.state.task.identity.attemptId);
});
