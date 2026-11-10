import test from 'node:test';
import assert from 'node:assert/strict';
import {runClaimedTask} from '../src/daemon/task-runner.mjs';
import {AndroidDaemon} from '../src/daemon/runtime.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {BudgetLedger} from '../src/core/budget.mjs';
import {DeviceClosureJournal, readDeviceClosure} from '../src/core/device-closure.mjs';
import {readDiagnostics} from '../src/core/diagnostics.mjs';
import {fixtureClock, fixtureDevice, fixturePermit, fixtureTask} from './core-fixtures.mjs';

const platforms = ['wechat_channels', 'wechat_articles'];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const makeTask = (platform, overrides = {}) => fixtureTask({platform, filters: {sort: 'latest', publishWindowHours: 24},
  budgets: {keywordMs: 5_000, batchMs: 8_000}, ...overrides});

function emptyPhone(clock) {
  const calls = [];
  const methods = {inspect: async () => ({deviceId: 'phone-1', readyForSearch: true}),
    search: async () => ({verified: true, cards: []}), readCards: async () => [], scroll: async () => {},
    openCard: async () => assert.fail('empty search must not open a post'), copyLink: async () => {},
    readComments: async () => {}, readArticle: async () => {}, returnToResults: async () => [], recoverResults: async () => []};
  return {calls, adapter: Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async args => {
    calls.push({name, at: clock.monotonicNow()}); return fn(args);
  }]))};
}
function runnerDevice(adapter, prepareTask) {
  const activity = [];
  return {activity, device: {forPlatform: () => adapter, prepareTask,
    setTaskActive: active => activity.push(active), preview: {
      resolve: async () => assert.fail('empty search must not open a preview'),
      resolveArticle: async () => assert.fail('empty search must not open a preview'),
    }}};
}

for (const platform of platforms) {
  test(`${platform}: a 40-second preparation precedes phone operations and does not consume a fresh keyword budget`, async () => {
    const store = new RunnerStore(':memory:');
    try {
      const clock = fixtureClock(), task = makeTask(platform), permit = fixturePermit(task, clock);
      const phone = emptyPhone(clock), pending = deferred(), prepared = [];
      const {device, activity} = runnerDevice(phone.adapter, async options => { prepared.push(options); await pending.promise; });
      const running = runClaimedTask({task, device, store, permit, clock, actionTimeoutMs: 100});
      assert.deepEqual(activity, [true]);
      assert.deepEqual(phone.calls, []);
      assert.equal(prepared[0].platform, platform);
      assert.equal(prepared[0].signal, permit.signal);
      clock.advance(40_000); pending.resolve();
      const result = await running;
      assert.equal(result.status, 'completed');
      assert.equal(result.reason, 'results_end');
      assert.equal(result.stats.keywordElapsedMs, 0);
      assert.equal(result.stats.batchElapsedMs, 0);
      assert.ok(phone.calls.length > 0);
      assert.ok(phone.calls.every(call => call.at === clock.monotonicNow()));
      assert.deepEqual(activity, [true, false]);
    } finally { store.close(); }
  });

  test(`${platform}: resume excludes only preparation and keeps prior work and offline time`, async () => {
    const store = new RunnerStore(':memory:');
    try {
      const clock = fixtureClock(), original = makeTask(platform);
      const ledger = new BudgetLedger({task: original, store, clock});
      clock.advance(2_000); ledger.finish('interrupted', 'usb_disconnected');
      clock.advance(1_000);
      const task = {...original, resumeAuthorized: true, identity: {...original.identity, attemptId: 'attempt-2', assignmentRevision: 2}};
      const phone = emptyPhone(clock);
      const {device} = runnerDevice(phone.adapter, async () => { clock.advance(40_000); });
      const result = await runClaimedTask({task, device, store, clock, permit: fixturePermit(task, clock)});
      assert.equal(result.status, 'completed');
      assert.equal(result.stats.keywordElapsedMs, 3_000);
      assert.equal(result.stats.batchElapsedMs, 3_000);
    } finally { store.close(); }
  });

  test(`${platform}: preparation never extends the server's absolute task deadline`, async () => {
    const store = new RunnerStore(':memory:');
    try {
      const clock = fixtureClock(), task = makeTask(platform, {deadlineAt: new Date(clock.wallNow() + 30_000).toISOString()});
      const phone = emptyPhone(clock);
      const {device} = runnerDevice(phone.adapter, async () => { clock.advance(40_000); });
      const result = await runClaimedTask({task, device, store, clock, permit: fixturePermit(task, clock)});
      assert.equal(result.status, 'completed_with_warnings');
      assert.equal(result.reason, 'task_deadline');
      assert.deepEqual(phone.calls, []);
    } finally { store.close(); }
  });
}

test('a warmup failure completes normally without phone actions and keeps detailed errors local', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const clock = fixtureClock(), task = makeTask('wechat_articles'), phone = emptyPhone(clock);
    phone.adapter.close = async () => assert.fail('warmup failure must not close a phone session');
    phone.adapter.parkHome = async () => assert.fail('warmup failure must not move the phone');
    const stderr = `discarded prefix: ${'x'.repeat(3_000)}private OCR helper diagnostics`;
    const details = {error: 'recognition_failed', domain: 'Vision', code: 9, stderr};
    const {device, activity} = runnerDevice(phone.adapter, async () => {
      throw Object.assign(new Error('recognition failed'), {code: 'ocr_failed', details});
    });
    const result = await runClaimedTask({task, device, store, clock, permit: fixturePermit(task, clock)});
    assert.equal(result.status, 'needs_action'); assert.equal(result.reason, 'ocr_unavailable');
    assert.equal(result.deviceIdle, true); assert.equal(result.stopConfirmationRequired, false);
    assert.deepEqual(result.details, {operation: 'ocr_warmup'});
    assert.equal(JSON.stringify(result).includes('private OCR'), false);
    const localDetails = readDiagnostics(store).at(-1).details;
    assert.deepEqual(localDetails, {...details, stderr: stderr.slice(-2_048)});
    assert.equal(Buffer.byteLength(localDetails.stderr), 2_048);
    assert.equal(store.loadCheckpoint(task.identity.discoveryRunId), null);
    assert.deepEqual(phone.calls, []); assert.deepEqual(activity, [true, false]);
  } finally { store.close(); }
});

for (const reason of ['user_stop', 'remote_stop', 'lease_expired']) {
  test(`a ${reason} during preparation preserves the unclosed action without moving or closing the phone`, async () => {
    const store = new RunnerStore(':memory:');
    try {
      const clock = fixtureClock(), task = makeTask('wechat_articles'), permit = fixturePermit(task, clock);
      const journal = new DeviceClosureJournal({store, task, clock}); journal.begin('openCard');
      const closure = readDeviceClosure(store, task.deviceId), phone = emptyPhone(clock);
      phone.adapter.close = async () => assert.fail('preparation stop must not close a phone session');
      phone.adapter.parkHome = async () => assert.fail('preparation stop must not move the phone');
      const {device, activity} = runnerDevice(phone.adapter, ({signal}) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      }));
      const running = runClaimedTask({task, device, store, clock, permit});
      permit.stop(reason);
      const result = await running;
      assert.equal(result.status, reason === 'lease_expired' ? 'interrupted' : 'canceled');
      assert.equal(result.reason, reason); assert.equal(result.deviceIdle, false); assert.equal(result.stopConfirmationRequired, true);
      assert.deepEqual(readDeviceClosure(store, task.deviceId), closure);
      assert.deepEqual(result.deviceClosure, closure);
      assert.deepEqual(phone.calls, []); assert.deepEqual(activity, [true, false]);
    } finally { store.close(); }
  });
}

test('an already stopped task skips preparation entirely', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const clock = fixtureClock(), task = makeTask('wechat_channels'), permit = fixturePermit(task, clock);
    const phone = emptyPhone(clock);
    const {device} = runnerDevice(phone.adapter, async () => assert.fail('stopped tasks must not warm OCR'));
    permit.stop('user_stop');
    const result = await runClaimedTask({task, device, store, clock, permit});
    assert.equal(result.reason, 'user_stop'); assert.deepEqual(phone.calls, []);
  } finally { store.close(); }
});

test('a lease that expires while preparation resolves is checked again before phone operations', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const clock = fixtureClock(), task = makeTask('wechat_channels'), phone = emptyPhone(clock);
    const {device} = runnerDevice(phone.adapter, async () => { clock.advance(40_000); });
    const result = await runClaimedTask({task, device, store, clock, permit: fixturePermit(task, clock, 30_000)});
    assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'lease_expired'); assert.deepEqual(phone.calls, []);
  } finally { store.close(); }
});

test('Douyin never awaits OCR readiness and remains active until physical closure settles', async () => {
  const store = new RunnerStore(':memory:');
  try {
    const clock = fixtureClock(), task = fixtureTask();
    const {device: adapter, calls} = fixtureDevice(task, {
      readCards: async () => ({contextVerified: true, contextId: 'context-1', cards: [], end: true}),
    });
    const closing = deferred(), enteredClose = deferred();
    adapter.close = async () => { enteredClose.resolve(); return closing.promise; };
    const {device, activity} = runnerDevice(adapter, async () => assert.fail('Douyin must not wait for OCR'));
    const running = runClaimedTask({task, device, store, clock, permit: fixturePermit(task, clock)});
    await enteredClose.promise;
    assert.ok(calls.includes('inspect')); assert.deepEqual(activity, [true]);
    closing.resolve({closed: true, verifiedAt: new Date(clock.wallNow()).toISOString(), evidenceId: 'closed-session-1'});
    const result = await running;
    assert.equal(result.status, 'completed'); assert.equal(result.deviceIdle, true); assert.deepEqual(activity, [true, false]);
  } finally { store.close(); }
});

test('the daemon continues lease renewal while OCR preparation is pending, using an in-memory control plane', async () => {
  const store = new RunnerStore(':memory:'), pending = deferred();
  let running;
  try {
    const task = makeTask('wechat_articles', {deadlineAt: new Date(Date.now() + 180_000).toISOString()});
    const lease = () => {
      const now = Date.now();
      return {...task.identity, leaseId: 'lease-current', serverTime: new Date(now).toISOString(),
        leaseUntil: new Date(now + 90_000).toISOString()};
    };
    let polls = 0, renewals = 0;
    const control = {poll: async () => { polls++; return {control: {}}; },
      renew: async () => { renewals++; return {permit: lease(), control: {}}; }};
    const phone = emptyPhone({monotonicNow: () => performance.now()});
    const {device, activity} = runnerDevice(phone.adapter, async () => pending.promise);
    const daemon = new AndroidDaemon({config: {deviceId: task.deviceId, agentId: task.identity.agentId},
      store, control, delivery: {}, device});
    daemon.ready = true;
    daemon.launch(task, lease(), performance.now()); running = daemon.taskPromise;
    assert.ok(daemon.active); assert.deepEqual(activity, [true]);
    daemon.nextRenewAt = 0;
    await daemon.tick();
    assert.equal(polls, 1); assert.equal(renewals, 1);
    assert.ok(daemon.active); assert.deepEqual(phone.calls, []);
    pending.resolve();
    const result = await running;
    assert.equal(result.status, 'completed');
    assert.equal(store.loadCheckpoint('daemon:completion').value.status, 'completed');
    assert.deepEqual(activity, [true, false]);
  } finally { pending.resolve(); await running; store.close(); }
});
