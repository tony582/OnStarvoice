import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';
import {AndroidDaemon} from '../src/daemon/runtime.mjs';
import {setCheckpoint, stateValue} from '../src/daemon/state.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {createSimulationDevice} from '../src/daemon/simulation.mjs';
import {mockControlPlane, until} from './daemon-fixture.mjs';

const options = f => ({stateDir: f.directory, config: f.config, lockRoot: f.lockRoot, pollMs: 5, renewMs: 10, deliveryMs: 5, watchMs: 5});
const pollCount = state => state.calls.filter(c => c.path.endsWith('/poll')).length;
const completeCount = state => state.calls.filter(c => c.path.endsWith('/complete')).length;
const status = store => stateValue(store, 'daemon:status');

test('a failed poll stays in daemon:status only until a later poll is answered', async t => {
  let store;
  let beforeRetry;
  const polledAt = [];
  const f = await mockControlPlane(t, {onRequest: ({path, response, json, state}) => {
    if (!path.pathname.endsWith('/poll')) return false;
    polledAt.push(Date.now());
    if (pollCount(state) === 1) {
      // Server restart: the Retry-After keeps the next loop turns inside the backoff, so they skip the poll.
      response.statusCode = 502; response.setHeader('retry-after', '0.1'); json({ok: false});
      return true;
    }
    if (pollCount(state) === 2) beforeRetry = status(store);
    json({ok: true, task: null, permit: null, control: {}, pollAfterMs: 5});
    return true;
  }});
  store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const daemon = new AndroidDaemon({...options(f), store});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => pollCount(f.state) >= 2 && status(store)?.controlError === null);
  const recovered = status(store);
  daemon.requestStop(); await running;
  assert.equal(beforeRetry.controlError, 'cloud_http_502', 'turns that only wait out the backoff keep the error');
  assert.equal(beforeRetry.reason, null, 'a retryable failure does not block the runner');
  assert.ok(polledAt[1] - polledAt[0] >= 100, 'the Retry-After backoff still holds the next poll back');
  assert.equal(recovered.controlError, null);
  assert.equal(recovered.reason, null);
});

test('401, 403 and 409 still block with control_requires_attention and keep their error code', async t => {
  for (const code of [401, 403, 409]) {
    const f = await mockControlPlane(t, {onRequest: ({path, response, json}) => {
      if (!path.pathname.endsWith('/poll')) return false;
      response.statusCode = code; json({ok: false});
      return true;
    }});
    const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
    const daemon = new AndroidDaemon({...options(f), store});
    const running = daemon.run();
    t.after(async () => { daemon.requestStop(); await running; store.close(); });
    await until(() => status(store)?.reason === 'control_requires_attention');
    const blocked = status(store);
    // The next loop turn skips the poll because the runner is blocked; that must not wipe the code.
    await until(() => status(store).updatedAt !== blocked.updatedAt);
    const later = status(store);
    daemon.requestStop(); await running;
    assert.equal(blocked.controlError, `cloud_http_${code}`);
    assert.equal(later.reason, 'control_requires_attention', `HTTP ${code}`);
    assert.equal(later.controlError, `cloud_http_${code}`, `HTTP ${code}`);
    assert.equal(pollCount(f.state), 1, `HTTP ${code}: a blocked runner does not poll again`);
  }
});

test('an idle runner waits longer after each failure in a row and starts over after an answered poll', async t => {
  const polledAt = [];
  const f = await mockControlPlane(t, {onRequest: ({path, response, json, state}) => {
    if (!path.pathname.endsWith('/poll')) return false;
    polledAt.push(Date.now());
    if (pollCount(state) <= 4) { response.statusCode = 502; json({ok: false}); return true; }
    json({ok: true, task: null, permit: null, control: {}, pollAfterMs: 5});
    return true;
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const daemon = new AndroidDaemon({...options(f), store});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => pollCount(f.state) >= 5 && status(store)?.controlError === null);
  const failures = daemon.controlFailures;
  daemon.requestStop(); await running;
  // pollMs 5: failures 1-4 wait 10, 20, 40 and 80 ms, although the loop turns in between skip the poll.
  for (const [index, wait] of [10, 20, 40, 80].entries()) {
    assert.ok(polledAt[index + 1] - polledAt[index] >= wait, `failure ${index + 1} waits at least ${wait} ms`);
  }
  assert.equal(failures, 0, 'the next outage starts again from the first step');
});

test('a running task keeps retrying at the first step so a renewal can still land inside its lease', async t => {
  let entered = false;
  const f = await mockControlPlane(t, {onRequest: ({path, response, json}) => {
    if (!entered || !path.pathname.endsWith('/poll')) return false;
    response.statusCode = 502; json({ok: false});
    return true;
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const device = createSimulationDevice(f.config.deviceId);
  device.copyLink = async () => { entered = true; return new Promise(() => {}); };
  const daemon = new AndroidDaemon({...options(f), store, device});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => entered);
  const before = pollCount(f.state);
  let longest = 0;
  await until(() => { longest = Math.max(longest, daemon.nextControlAt - Date.now()); return pollCount(f.state) >= before + 6; });
  daemon.requestStop(); await running;
  assert.ok(longest <= 10, `a busy runner waited ${longest} ms; the first step is 10 ms`);
});

test('an undelivered completion also keeps retrying at the first step', async t => {
  const f = await mockControlPlane(t, {onRequest: ({path, response, json}) => {
    if (!path.pathname.endsWith('/complete')) return false;
    response.statusCode = 502; json({ok: false});
    return true;
  }});
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  // A task interrupted by a restart leaves a completion that still has to reach the server.
  setCheckpoint(store, 'daemon:active', {task: f.state.task, sessionId: 'previous-process-session', leaseId: 'lease-one'});
  const daemon = new AndroidDaemon({...options(f), store});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  let longest = 0;
  await until(() => { longest = Math.max(longest, daemon.nextControlAt - Date.now()); return completeCount(f.state) >= 7; });
  daemon.requestStop(); await running;
  assert.ok(longest <= 10, `a pending completion waited ${longest} ms; the first step is 10 ms`);
});
