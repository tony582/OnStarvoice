import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {parkDouyinHome, HOME_PARK_MAX_BACKS} from '../src/device/douyin-home.mjs';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {resource, DOUYIN_P0_PROFILE} from '../src/device/douyin-profile.mjs';
import {createProfileAdapter} from '../src/device/profile-adapter.mjs';
import {settleDevice} from '../src/daemon/settle-device.mjs';
import {AndroidDaemon} from '../src/daemon/runtime.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {stateValue} from '../src/daemon/state.mjs';
import {readDeviceClosure} from '../src/core/device-closure.mjs';
import {fixtureTask, fixtureClock, fixturePermit, fixtureDevice} from './core-fixtures.mjs';

const node = (id, text = '', extra = {}) => `<node ${Object.entries({
  package: DOUYIN_P0_PROFILE.packageName, 'resource-id': resource(id), text,
  displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${value}"`).join(' ')}/>`;
const xml = body => `<hierarchy>${body}</hierarchy>`;
const home = xml(node('hmy', '', {'content-desc': '搜索'})
  + node('0p3', '', {'content-desc': '我，按钮'}) + node('0p3', '', {'content-desc': '首页，按钮', selected: 'true'}));
const profile = xml(node('504', '抖音号：fixture') + node('whh', '编辑主页')
  + node('0p3', '', {'content-desc': '首页，按钮'}));
const results = xml(node('et_search_kw', '别克壁纸'));
const detail = xml(node('tv_desc', '壁纸') + node('w67', '车主') + node('n00'));
const challenge = xml(node('title', '请完成验证') + node('et_search_kw', '别克壁纸'));
const unknown = xml(node('title', '未校准的页面'));
const deferred = () => { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; };
const tick = () => delay(0);

function uiFixture(pages) {
  const calls = []; let index = 0;
  return {calls, ui: {read: async () => { calls.push('read'); return parseUiTree(pages[Math.min(index++, pages.length - 1)]); },
    back: async () => {calls.push('back');}, clickXPath: async () => {calls.push('home');}}};
}

test('home parking reads calibrated home evidence and never treats search results as home', async () => {
  const f = uiFixture([detail, results, home]);
  const outcome = await parkDouyinHome({ui: f.ui, beforeAction: () => {}});
  assert.equal(outcome.parked, true); assert.equal(outcome.backPresses, 2);
  assert.equal(outcome.evidence, 'home_selected_search_and_profile');
  assert.deepEqual(f.calls, ['read', 'back', 'read', 'back', 'read']);
  const already = uiFixture([home]);
  assert.equal((await parkDouyinHome({ui: already.ui, beforeAction: () => {}})).backPresses, 0);
  assert.deepEqual(already.calls, ['read']);
  const own = uiFixture([profile, home]);
  await parkDouyinHome({ui: own.ui, beforeAction: () => {}});
  assert.deepEqual(own.calls, ['read', 'home', 'read']);
});

test('unknown, verification and unreadable screens cause no blind navigation', async () => {
  for (const [page, code] of [[unknown, 'home_path_unverified'], [challenge, 'login_or_challenge_required'],
    ['<hierarchy><node>', 'invalid_ui_source']]) {
    const f = uiFixture([page]);
    await assert.rejects(parkDouyinHome({ui: f.ui, beforeAction: () => {}}), {code});
    assert.deepEqual(f.calls, ['read']);
  }
  const f = uiFixture([results]);
  await assert.rejects(parkDouyinHome({ui: f.ui, beforeAction: () => {}}), {code: 'home_back_limit'});
  assert.equal(f.calls.filter(call => call === 'back').length, HOME_PARK_MAX_BACKS);
});

test('a canceled or expired permit prevents a late navigation after a source read', async () => {
  for (const stop of ['operator_takeover', 'lease_expired']) {
    const task = fixtureTask(), clock = fixtureClock(), permit = fixturePermit(task, clock);
    const f = uiFixture([results]);
    const read = f.ui.read;
    f.ui.read = async () => {const value = await read(); if (stop === 'operator_takeover') permit.stop(stop); else clock.advance(90001); return value;};
    await assert.rejects(parkDouyinHome({ui: f.ui, signal: permit.signal, beforeAction: () => permit.assertAllowed()}));
    assert.deepEqual(f.calls, ['read']);
  }
});

async function adapterFixture() {
  const calls = [];
  let page = profile, sourceOverride = null;
  const adb = {inspect: async () => ({model: 'DE106', apiLevel: 27}), inspectApp: async () => ({appVersion: '40.6.0'}),
    listDevices: async () => [{serial: 'phone-1', state: 'device'}], helperPids: async () => [], stopHelper: async () => {calls.push('stop-helper');}};
  const client = {createProfileSession: async () => ({sessionId: 'owned'}), isLocked: async () => false,
    settings: async () => ({wakeLockTimeout: 0, enableTopmostWindowFromActivePackage: false}),
    source: async () => {calls.push('read'); return sourceOverride ? sourceOverride() : page;},
    findElements: async () => [{'element-6066-11e4-a52e-4f735466cecf': 'home'}],
    clickElement: async () => {calls.push('home'); page = home;},
    back: async () => {calls.push('back'); page = page === detail ? results : home;},
    deleteSession: async () => {calls.push('close');}, isSessionActive: async () => false};
  const foreground = {ensure: async ({launch}) => {assert.equal(launch, false); calls.push('foreground');},
    waitFor: async () => ({douyin: true})};
  const adapter = createProfileAdapter({serial: 'phone-1', profileId: DOUYIN_P0_PROFILE.id, adb, client, foreground});
  await adapter.inspect();
  calls.length = 0; page = results;
  return {adapter, calls, setSource: value => {sourceOverride = value;}, setPage: value => {page = value;}};
}

test('adapter waits for an earlier operation before parking and close remains a separate proof', async () => {
  const f = await adapterFixture(), wait = deferred();
  const task = fixtureTask(), clock = fixtureClock(), permit = fixturePermit(task, clock);
  f.setSource(() => wait.promise);
  const earlier = f.adapter.readSource(); await tick();
  const parking = f.adapter.parkHome({permit}); await tick();
  assert.deepEqual(f.calls, ['read']);
  f.setSource(null); wait.resolve(results); await earlier;
  assert.equal((await parking).parked, true);
  assert.deepEqual(f.calls, ['read', 'foreground', 'read', 'back', 'read']);
  assert.equal((await f.adapter.close()).closed, true);
  assert.equal(f.calls.at(-1), 'close');
});

test('timeout or stop while draining pending work cannot produce delayed navigation', async () => {
  for (const mode of ['timeout', 'stop', 'expired']) {
    const f = await adapterFixture(), wait = deferred();
    const task = fixtureTask(), clock = fixtureClock(), permit = fixturePermit(task, clock);
    f.setSource(() => wait.promise);
    const earlier = f.adapter.readSource(); await tick();
    const parking = f.adapter.parkHome({permit, timeoutMs: mode === 'timeout' ? 10 : 8000});
    const rejected = assert.rejects(parking);
    if (mode === 'stop') permit.stop('operator_takeover');
    if (mode === 'expired') {clock.advance(90001); wait.resolve(results);}
    await rejected;
    f.setSource(null); wait.resolve(results); await earlier; await tick();
    assert.deepEqual(f.calls, ['read'], mode);
    await f.adapter.close();
  }
});

test('timed-out home source cannot issue a late Back and close waits for the actual command', async () => {
  const f = await adapterFixture(), wait = deferred();
  const task = fixtureTask(), clock = fixtureClock(), permit = fixturePermit(task, clock);
  f.setSource(() => wait.promise);
  await assert.rejects(f.adapter.parkHome({permit, timeoutMs: 10}), {code: 'device_timeout'});
  const closing = f.adapter.close(); await tick();
  assert.deepEqual(f.calls, ['foreground', 'read']);
  wait.resolve(results);
  assert.equal((await closing).closed, true);
  assert.deepEqual(f.calls, ['foreground', 'read', 'close']);
});

test('settlement covers success, budgets and ordinary errors without changing business outcomes', async () => {
  for (const result of [{status: 'completed', reason: 'results_end'},
    {status: 'completed_with_warnings', reason: 'keyword_time'}, {status: 'needs_action', reason: 'detail_ui_not_ready'}]) {
    const f = await adapterFixture(), store = new RunnerStore(':memory:');
    const task = fixtureTask(), clock = {wallNow: Date.now, monotonicNow: () => performance.now()}, permit = fixturePermit(task, clock);
    try {
      const value = await settleDevice({device: f.adapter, store, task, clock, permit, result});
      assert.equal(value.status, result.status); assert.equal(value.reason, result.reason);
      assert.equal(value.homePark.parked, true); assert.equal(value.deviceIdle, true);
      assert.ok(f.calls.indexOf('back') < f.calls.indexOf('close'));
      assert.equal(readDeviceClosure(store, task.deviceId).required, false);
    } finally {store.close();}
  }
});

test('protected endings skip home navigation while retaining independent closure behavior', async () => {
  for (const reason of ['user_stop', 'remote_stop', 'operator_takeover', 'lease_expired', 'usb_disconnected',
    'login_required', 'login_or_challenge_required', 'device_locked', 'device_asleep', 'session_creation_unconfirmed']) {
    const store = new RunnerStore(':memory:'), task = fixtureTask(), clock = {wallNow: Date.now};
    const calls = [], result = {status: 'needs_action', reason};
    try {
      const value = await settleDevice({store, task, clock, result, device: {
        parkHome: async () => {calls.push('park');}, close: async () => {calls.push('close'); return {closed: false};}}});
      assert.deepEqual(calls, ['close']); assert.equal(value.homePark.reason, reason);
      assert.equal(value.homePark.parked, false); assert.equal(value.deviceIdle, false);
      assert.equal(readDeviceClosure(store, task.deviceId).required, true);
    } finally {store.close();}
  }
});

test('home failure neither rewrites saved results nor becomes home success after session close', async () => {
  const store = new RunnerStore(':memory:'), task = fixtureTask(), clock = {wallNow: Date.now, monotonicNow: () => performance.now()};
  const permit = fixturePermit(task, clock), result = {status: 'completed', reason: 'results_end', stats: {links: 3}};
  try {
    const settled = await settleDevice({store, task, clock, permit, result, device: {
      parkHome: async () => {throw Object.assign(new Error('unknown'), {code: 'home_path_unverified'});},
      close: async () => ({closed: true, verifiedAt: new Date().toISOString(), evidenceId: 'closed-fixture'})}});
    assert.equal(settled.status, 'completed'); assert.equal(settled.reason, 'results_end');
    assert.deepEqual(settled.stats, {links: 3}); assert.equal(settled.deviceIdle, true);
    assert.deepEqual(settled.homePark, {parked: false, reason: 'home_path_unverified'});
    const daemon = new AndroidDaemon({store, config: {deviceId: task.deviceId, agentId: 'agent-1'}, device: {}, control: {}, delivery: {}});
    daemon.saveCompletion({task, sessionId: 'session'}, settled);
    assert.deepEqual(stateValue(store, 'daemon:completion').checkpoint.homePark, settled.homePark);
    assert.deepEqual(stateValue(store, 'daemon:completion').checkpoint.stats, {links: 3});
  } finally {store.close();}
});

test('short remaining leases are reserved for physical close without changing successful task status', async () => {
  const f = await adapterFixture(), store = new RunnerStore(':memory:');
  const task = fixtureTask(), clock = {wallNow: Date.now, monotonicNow: () => performance.now()};
  const permit = fixturePermit(task, clock, 30000);
  try {
    const value = await settleDevice({device: f.adapter, store, task, clock, permit,
      result: {status: 'completed', reason: 'results_end'}});
    assert.deepEqual(f.calls, ['close']);
    assert.deepEqual(value.homePark, {parked: false, reason: 'home_park_lease_too_short'});
    assert.equal(value.status, 'completed'); assert.equal(value.deviceIdle, true);
  } finally {store.close();}
});

test('daemon launches the original collection, parks with its same lease, and saves both outcomes', async () => {
  const store = new RunnerStore(':memory:');
  const task = fixtureTask({deadlineAt: new Date(Date.now() + 60000).toISOString()});
  const {device, calls} = fixtureDevice(task, {
    parkHome: async ({permit}) => {
      permit.assertAllowed(); assert.deepEqual(permit.identity, task.identity);
      return {parked: true, reason: 'home_verified', evidence: 'home_selected_search_and_profile'};
    }, close: async () => ({closed: true, verifiedAt: new Date().toISOString(), evidenceId: 'physical-close'})});
  const daemon = new AndroidDaemon({store, config: {deviceId: task.deviceId, agentId: task.identity.agentId},
    device, control: {}, delivery: {}});
  daemon.ready = true;
  try {
    daemon.launch(task, {...task.identity, leaseId: 'lease-1', serverTime: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 90000).toISOString()}, performance.now());
    await daemon.taskPromise;
    assert.deepEqual(calls.slice(-3), ['returnToResults', 'parkHome', 'close']);
    const completion = stateValue(store, 'daemon:completion');
    assert.equal(completion.status, 'completed'); assert.equal(completion.checkpoint.stats.links, 1);
    assert.equal(completion.checkpoint.homePark.parked, true);
    assert.equal(store.pendingCount(), 1, 'home return never drains the discovery upload queue');
  } finally {store.close();}
});

test('shared bottom navigation never proves home unless the unique Home tab is selected', async () => {
  for (const page of [home.replace('selected="true"', 'selected="false"'), home.replace(' selected="true"', '')]) {
    const f = uiFixture([page]);
    await assert.rejects(parkDouyinHome({ui: f.ui, beforeAction: () => {}}), {code: 'home_not_verified'});
    assert.deepEqual(f.calls, ['read', 'home', 'read'], 'only the identified Home tab may be clicked once');
  }
});

test('disk-full and quota errors in optional diagnostics cannot prevent closing the owned session', async () => {
  for (const code of ['SQLITE_FULL', 'QuotaExceededError']) {
    const store = new RunnerStore(':memory:'), task = fixtureTask(), clock = {wallNow: Date.now};
    const save = store.saveCheckpoint.bind(store); let diagnosticsWrites = 0, closes = 0;
    store.saveCheckpoint = (key, ...args) => {
      if (key === 'diagnostics:recent') {diagnosticsWrites++; throw Object.assign(new Error('fixture storage failure'), {code});}
      return save(key, ...args);
    };
    try {
      const value = await settleDevice({store, task, clock, result: {status: 'completed', reason: 'results_end'},
        device: {close: async () => {closes++; return {closed: true, evidenceId: 'owned-closed', verifiedAt: new Date().toISOString()};}}});
      assert.ok(diagnosticsWrites > 0); assert.equal(closes, 1);
      assert.equal(value.status, 'completed'); assert.equal(value.deviceIdle, true);
      assert.equal(readDeviceClosure(store, task.deviceId).required, false);
    } finally {store.close();}
  }
});

test('home diagnostics may be dropped for quota, but a fully unwritable completion is never acknowledged', () => {
  for (const fullDisk of [false, true]) {
    const store = new RunnerStore(':memory:'), task = fixtureTask();
    const save = store.saveCheckpoint.bind(store); let writes = 0;
    store.saveCheckpoint = (key, value, ...args) => {
      if (key === 'daemon:completion') {
        writes++;
        if (fullDisk || value.checkpoint.homePark) throw Object.assign(new Error('fixture full'), {code: 'SQLITE_FULL'});
      }
      return save(key, value, ...args);
    };
    const daemon = new AndroidDaemon({store, config: {deviceId: task.deviceId, agentId: 'agent-1'}, device: {}, control: {}, delivery: {}});
    const result = {status: 'completed', reason: 'results_end', deviceIdle: true, stats: {links: 3},
      homePark: {parked: false, reason: 'home_not_verified'}};
    try {
      if (fullDisk) {
        assert.throws(() => daemon.saveCompletion({task, sessionId: 'session'}, result), {code: 'SQLITE_FULL'});
        assert.equal(stateValue(store, 'daemon:completion'), null);
      } else {
        daemon.saveCompletion({task, sessionId: 'session'}, result);
        const saved = stateValue(store, 'daemon:completion');
        assert.equal(saved.status, 'completed'); assert.equal(saved.deviceIdle, true);
        assert.deepEqual(saved.checkpoint.stats, {links: 3});
        assert.equal(saved.checkpoint.homePark, undefined);
      }
      assert.equal(writes, 2);
    } finally {store.close();}
  }
});
