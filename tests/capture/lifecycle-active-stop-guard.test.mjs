import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const moduleNames = ['leases', 'restore', 'admission', 'begin', 'progress', 'cleanup', 'attempts', 'end', 'tabs', 'coordinator'];
const sources = Object.fromEntries(await Promise.all(moduleNames.map(async name => [name,
  await readFile(new URL(`utils/capture/lifecycle/${name}.js`, root), 'utf8'),
])));
const runtimeSource = await readFile(new URL('utils/capture/task-runtime.js', root), 'utf8');
const identitySource = await readFile(new URL('utils/capture/execution-identity.js', root), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(accept => {resolve = accept;});
  return {promise, resolve};
};

// All operations below are the real public lifecycle functions. No browser,
// collection, network, task dispatch, or persistent storage is used by the test.
function harness({retained = false, guardError = false, capturePrivateState = false} = {}) {
  const context = vm.createContext({setTimeout, clearTimeout});
  for (const source of [runtimeSource, identitySource]) vm.runInContext(source, context);
  let privateState;
  for (const name of moduleNames) {
    vm.runInContext(sources[name], context, {filename: name});
    if (name === 'leases' && capturePrivateState) {
      const original = context.OnStarvoiceCaptureLifecycleLeases;
      context.OnStarvoiceCaptureLifecycleLeases = {create(args) {
        privateState = args.state;
        return original.create(args);
      }};
    }
  }
  const events = [];
  const sessions = new Map(); const groups = new Map(); const owners = new Map();
  const runtime = {};
  const stored = {'test.runtime': runtime};
  let callbacks; let ownerCallbacks;
  const record = {retained, guardError};
  const debug = {
    getSessionByTaskId: id => sessions.get(id) ?? null,
    getSession: tabId => [...sessions.values()].find(value => value.tabId === tabId) ?? null,
    getActiveSessions: () => [...sessions.values()],
    async stopByTaskId(id) {events.push('debug.stop'); sessions.delete(id); return {released:true};},
    async stopByTab(id) {events.push('debug.stopByTab'); return {released:true, tabId:id};},
    async updateTask(update) {events.push('debug.update'); const next = {...sessions.get(update.taskId), ...update}; sessions.set(update.taskId, next); return next;},
    async setMinimized(update) {events.push('debug.minimize'); const next = {...sessions.get(update.taskId), ...update}; sessions.set(update.taskId, next); return next;},
    async registerWorkerTab(value) {events.push('debug.register'); return value;},
    async handleTabRemoved() {events.push('debug.removed');},
  };
  const group = {
    getTask: id => groups.get(id) ?? null,
    getActiveTasks: () => [...groups.values()],
    async end({taskId}) {events.push('group.end'); groups.delete(taskId); return {released:true};},
    async register(value) {events.push('group.register'); return {...value, groupId:4};},
    async unregister(value) {events.push('group.unregister'); return value;},
    async handleTabRemoved() {events.push('group.removed');},
  };
  const owner = {
    getOwner: id => owners.get(id) ?? null,
    clearTask(id) {events.push('owner.clear'); owners.delete(id);},
    notifyCanceled() {events.push('owner.cancel');},
  };
  const ports = {
    CAPTURE_TASK_GROUP_TITLE:'synthetic-task', CAPTURE_TASK_REPLACEMENT_TAB_TTL_MS:600000,
    STORAGE_KEYS:{runtime:'test.runtime', captureExecutionLock:'test.lock'},
    TASK_LEDGER_STALE_ACTIVE_MS:60000, UNATTENDED_RUNNER_QUERY_KEY:'synthetic-run',
    ...context.OnStarvoiceCaptureExecutionIdentity,
    async hasStrictCaptureStopControl() {
      if (record.guardError) throw new Error('synthetic journal read failure');
      return record.retained;
    },
    chrome: {
      tabs: {
        async remove(id) {events.push(`tab.remove:${id}`);},
        async sendMessage() {events.push('tab.message'); return {ok:true};},
        async ungroup() {events.push('tab.ungroup');},
        async get(id) {return {id, groupId:4, windowId:1, url:'https://www.xiaohongshu.com/explore/test'};},
      },
      tabGroups:{async get(id) {return {id, title:'synthetic-task', windowId:1};}},
      debugger:{async detach() {events.push('native.detach');}},
      storage:{local:{
        async get(key) {return {[key]: stored[key]};},
        async set(patch) {events.push('storage.set'); Object.assign(stored, patch);},
      }},
      action:{
        async setBadgeText() {events.push('badge.text');},
        async setBadgeBackgroundColor() {events.push('badge.color');},
      },
    },
    console:{warn(){}, debug(){}}, setTimeout,
    captureTaskTabGroupApi:{createManager: () => group},
    debugSessionApi:{createManager(value) {callbacks = value; return debug;}},
    taskOwnerApi:{createCoordinator(value) {ownerCallbacks = value; return owner;}},
    taskRuntimeApi:context.OnStarvoiceCaptureTaskRuntime,
    taskTabGroupApi:{normalizeTaskTabRole: value => value},
    normalizePlatformId: value => value || 'unknown',
    detectPlatformFromUrl: () => 'xiaohongshu',
    readRuntimeState: async () => runtime,
    async writeRuntimeState(patch) {events.push('runtime.write'); Object.assign(runtime, typeof patch === 'function' ? await patch(runtime) : patch); return runtime;},
    readStoredCaptureExecutionLock: async () => null,
    readUnattendedKeywordRunRequest: async () => null,
    runCaptureExecutionLockOperation: async operation => operation(),
    runUnattendedRunMutation: async operation => operation(),
    persistUnattendedRunMutation: async () => events.push('request.persist'),
    normalizeCaptureExecutionLock: value => value ?? null,
    isTerminalUnattendedRunStatus: value => value === 'completed',
    relayToContentWithRetry: async () => {events.push('cancel.relay'); return {ok:true};},
    terminalizeCaptureTaskLedgerRun: async () => events.push('ledger.terminal'),
    inspectTargetedPostCaptureTaskAttempt: async () => ({targeted:false, current:false}),
  };
  const api = context.OnStarvoiceCaptureLifecycle.create(ports);
  return {api, ports, record, events, sessions, groups, owners, debug, group,
    runtime, stored, callbacks, ownerCallbacks, privateState};
}

const entries = [
  ['endCaptureTask', [{taskId:'task', status:'canceled'}]],
  ['performEndCaptureTask', [{taskId:'task', status:'canceled'}]],
  ['handleUnexpectedCaptureDebugDetach', [{session:{taskId:'task', persistent:true, tabId:7}, reason:'target_closed'}]],
  ['handleAbandonedCaptureTask', [{taskId:'task'}]],
  ['updateCaptureTask', [{taskId:'task', progress:{phase:'capture'}}]],
  ['registerCaptureTaskTab', [{taskId:'task', role:'worker', workerTabId:8}, {tab:{id:7}}]],
  ['setCaptureTaskMinimized', [{taskId:'task', minimized:true}]],
  ['cleanupStaleCaptureRuntimeSession', [{taskId:'task', sourceTabId:7, workerTabIds:[8], groupId:4}]],
  ['clearPersistedCaptureRuntimeSnapshot', [{taskId:'task'}], false],
  ['publishRestoredCaptureRuntimeSnapshot', [{taskId:'task'}, {taskId:'task', state:'attached'}], false],
  ['restorePersistedCaptureRuntimeSession', [{captureDebugSession:{taskId:'task', persistent:true, tabId:7}}]],
  ['replaceCaptureExecutionLockTabId', [7,9], false],
  ['replaceUnattendedRunnerTabId', [7,9], false],
  ['handleCaptureRuntimeTabReplaced', [9,7], false],
  ['handleCaptureRuntimeTabRemoved', [7]],
  ['closeCaptureTaskWorkerTabs', [[8]]],
  ['closeTrackedCaptureTaskWorkerTabs', ['task',[8]]],
  ['writeCaptureTaskCancellationFailSoft', [{taskId:'task'}, {captureTaskCancellation:{taskId:'task'}}]],
  ['clearCaptureTaskTraceOverlayFailSoft', [{taskId:'task',tabId:7}], false],
  ['publishCaptureTaskCancellation', ['task','user_cancel_requested']],
  ['relayCaptureTaskCancellation', [{taskId:'task',tabId:7,workerTabIds:[8]},'user_cancel_requested']],
  ['releaseCaptureTaskResources', [{taskId:'task', reason:'completed'}]],
  ['releaseCaptureTaskResourcesWithRetry', [{taskId:'task',reason:'completed'}]],
  ['releaseStableUnattendedCaptureTaskResourcesOnly', [{unattended:true, taskId:'unattended-capture:request', requestId:'request'}]],
  ['releaseUnattendedCaptureTaskResourcesForRecovery', [{id:'lock', captureTaskId:'task'}, {request:{id:'request'}}]],
  ['clearUnattendedCaptureTaskLockBinding', ['lock','task'], false],
  ['recoverUnattendedCaptureTaskInterruption', [{taskId:'task'}]],
  ['reclaimSupersededUnattendedCaptureTaskForBegin', [{taskId:'task', sourceTabId:7, attemptId:'attempt'}]],
  ['releaseConfirmedStaleCaptureTaskGroupsForBegin', []],
];

function assertPending(value) {
  assert.equal(value.cleanupPending, true);
  assert.equal(value.resourcesReleased, false);
  assert.equal(value.accepted, false);
}

for (const [journal, options] of [
  ['active', {retained:true}], ['stopped-but-retained', {retained:true}],
  ['corrupt-retained', {retained:true}], ['old-worker-epoch', {retained:true}],
  ['journal-read-fails', {guardError:true}], ['unknown-provider-result', {retained:undefined}],
]) {
  for (const [name, args, denied] of entries) test(`${journal}: real ${name} is fail-closed without cleanup`, async () => {
    const h = harness(options);
    if (journal === 'unknown-provider-result') h.record.retained = undefined;
    h.sessions.set('task', {taskId:'task', tabId:7, persistent:true, workerTabIds:[8]});
    h.groups.set('task', {taskId:'task', sourceTabId:7, workerTabIds:[8]});
    h.owners.set('task', {connected:true});
    h.runtime.captureDebugSession = {taskId:'task', persistent:true};
    const before = JSON.stringify(h.runtime);
    const result = await h.api[name](...args);
    if (denied === false) assert.equal(result, false); else assertPending(result);
    assert.deepEqual(h.events, []);
    assert.equal(JSON.stringify(h.runtime), before);
    assert.equal(h.sessions.has('task'), true);
    assert.equal(h.groups.has('task'), true);
    assert.equal(h.owners.has('task'), true);
  });
}

test('no retained record: real legacy minimize, worker close and END retain their effects', async () => {
  const h = harness();
  h.sessions.set('task', {taskId:'task', tabId:7, persistent:true});
  const minimized = await h.api.setCaptureTaskMinimized({taskId:'task', minimized:true});
  assert.equal(minimized.session.minimized, true);
  await h.api.closeTrackedCaptureTaskWorkerTabs('task',[8]);
  await h.api.endCaptureTask({taskId:'task', status:'completed'});
  assert.deepEqual(h.events, ['debug.minimize','tab.remove:8','runtime.write','tab.message',
    'debug.stop','group.end','owner.clear','runtime.write','ledger.terminal']);
  assert.equal(h.runtime.captureDebugSession, null);
});

test('no retained record: raw exact tab lock replacement still writes once', async () => {
  const h = harness();
  h.stored['test.lock'] = {id:'lock', holderTabId:7, captureTaskId:'task', captureTaskAttemptId:'attempt'};
  assert.equal(await h.api.replaceCaptureExecutionLockTabId(7,9), true);
  assert.equal(h.stored['test.lock'].holderTabId, 9);
  assert.equal(h.stored['test.lock'].captureTaskAttemptId, 'attempt');
  assert.deepEqual(h.events, ['storage.set']);
});

test('no retained record: restore with no snapshot does not manufacture resource activity', async () => {
  const h = harness();
  assert.deepEqual(plain(await h.api.restorePersistedCaptureRuntimeSession({})), {restored:false, reason:'not_required'});
  assert.deepEqual(h.events, []);
});

test('queued legacy END rechecks the record when C queue finally admits it', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  const blocker = h.api.runCaptureTaskLifecycleOperation(async () => {entered.resolve(); await gate.promise;});
  await entered.promise;
  const pending = h.api.endCaptureTask({taskId:'task', status:'completed'});
  // Let the entry read resolve before changing the record, while C is blocked.
  await new Promise(resolve => setImmediate(resolve));
  h.record.retained = true;
  gate.resolve(); await blocker;
  assertPending(await pending);
  assert.deepEqual(h.events, []);
});

test('source lookup completion cannot publish progress after a journal appears', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  h.ports.readUnattendedKeywordRunRequest = async () => {entered.resolve(); await gate.promise; return null;};
  // Module ports are intentionally captured at composition, so hold the actual
  // manager await and prove the subsequent overlay is not published.
  h.debug.updateTask = async value => {entered.resolve(); await gate.promise; return {...value, state:'attached', sourceTabId:7};};
  const pending = h.api.updateCaptureTask({taskId:'task', progress:{phase:'capture'}});
  await entered.promise; h.record.retained = true; gate.resolve();
  assertPending(await pending);
  assert.deepEqual(h.events, []);
});

test('lock storage wait cannot rebind a tab after a journal appears', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  h.ports.chrome.storage.local.get = async () => {entered.resolve(); await gate.promise; return {'test.lock':{id:'lock', holderTabId:7}};};
  const pending = h.api.replaceCaptureExecutionLockTabId(7,9);
  await entered.promise; h.record.retained = true; gate.resolve();
  assert.equal(await pending, false);
  assert.deepEqual(h.events, []);
});

test('raw native cleanup source lookup cannot detach or ungroup after a journal appears', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  h.ports.chrome.tabGroups.get = async () => {entered.resolve(); await gate.promise; return {id:4,title:'synthetic-task',windowId:1};};
  const pending = h.api.cleanupStaleCaptureRuntimeSession({taskId:'task',sourceTabId:7,groupId:4,workerTabIds:[8]});
  await entered.promise; h.record.retained = true; gate.resolve();
  assertPending(await pending);
  assert.deepEqual(h.events, []);
});

test('in-flight legacy Debug completion cannot cascade into group/owner release after stop retention', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  h.sessions.set('task',{taskId:'task',tabId:7,persistent:true});
  h.groups.set('task',{taskId:'task',sourceTabId:7,workerTabIds:[]});
  h.owners.set('task',{connected:true});
  h.debug.stopByTaskId = async () => {h.events.push('debug.started'); entered.resolve(); await gate.promise; return {released:true};};
  const pending = h.api.releaseCaptureTaskResources({taskId:'task',reason:'completed'});
  await entered.promise; h.record.retained = true; gate.resolve();
  assertPending(await pending);
  assert.equal(h.events.includes('group.end'), false);
  assert.equal(h.events.includes('owner.clear'), false);
  assert.equal(h.runtime.captureDebugSession.cleanupPending, true);
  assert.equal(h.api.isCaptureTaskCleanupInProgress('task'), true);
  assert.equal(h.owners.has('task'), true);
  assert.equal(h.groups.has('task'), true);
});

test('automatic debug detach and abandoned-owner callbacks cannot bypass retained record', async () => {
  const h = harness({retained:true});
  await h.callbacks.onUnexpectedDetach({session:{taskId:'task',persistent:true,tabId:7},reason:'target_closed'});
  await h.ownerCallbacks.onAbandoned({taskId:'task'});
  await h.callbacks.onStateChange({taskId:'task',persistent:true,state:'attached',tabId:7});
  assert.deepEqual(h.events, []);
});

test('debug state callback rechecks record after badge wait and cannot erase retained runtime', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  h.ports.chrome.action.setBadgeText = async () => {entered.resolve(); await gate.promise;};
  h.runtime.captureDebugSession = {taskId:'keep', persistent:true};
  const pending = h.callbacks.onStateChange({taskId:'task',persistent:true,state:'attached',tabId:7});
  await entered.promise; h.record.retained = true; gate.resolve(); await pending;
  assert.equal(h.runtime.captureDebugSession.taskId, 'keep');
  assert.equal(h.events.includes('runtime.write'), false);
});

for (const name of ['stopByTab','stopByTaskId','updateTask']) test(`manager facade ${name} also rejects retained control`, async () => {
  const h = harness({retained:true});
  assertPending(await h.api.debugSessions[name]('task'));
  assert.deepEqual(h.events, []);
});

test('strict idle admission leaves C before the sole callback and never acquires a host lock', async () => {
  const h = harness(); const order = []; const entered = deferred(); const gate = deferred();
  h.ports.runCaptureExecutionLockOperation = async () => {throw new Error('coordinator must not acquire host lock');};
  const blocker = h.api.runCaptureTaskLifecycleOperation(async () => {order.push('C-earlier'); entered.resolve(); await gate.promise;});
  await entered.promise;
  const pending = h.api.admitStrictCaptureCohort(async () => {
    order.push('CAS');
    await h.api.runCaptureTaskLifecycleOperation(() => {order.push('C-free');});
    return {ok:true};
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['C-earlier']);
  gate.resolve(); await blocker;
  assert.deepEqual(plain(await pending), {ok:true});
  assert.deepEqual(order, ['C-earlier','CAS','C-free']);
  assert.deepEqual(h.events, []);
});

for (const [label, seed] of [
  ['debug session', h => h.sessions.set('task',{taskId:'task'})],
  ['native group', h => h.groups.set('task',{taskId:'task'})],
  ['persisted runtime session', h => {h.runtime.captureDebugSession = {taskId:'task'};}],
  ['malformed persisted runtime', h => {h.stored['test.runtime'] = 'corrupt';}],
  ['begin in flight', h => {h.privateState.captureTaskBeginInFlight = {taskId:'task'};}],
  ['restore in flight', h => {h.privateState.captureRuntimeRestorePromise = Promise.resolve();}],
  ['cleanup in flight', h => h.privateState.captureTaskCleanupInProgress.add('task')],
  ['pending workers', h => h.privateState.captureTaskPendingWorkerTabIds.set('task',[8])],
  ['replacement leases', h => h.privateState.captureTaskReplacementTabIds.set(7,{tabId:8})],
]) test(`strict admission denies ${label} without attempting cleanup`, async () => {
  const h = harness({capturePrivateState:true}); seed(h); let invoked = 0;
  assertPending(await h.api.admitStrictCaptureCohort(() => {invoked++; return {ok:true};}));
  assert.equal(invoked, 0);
  assert.deepEqual(h.events, []);
});

test('strict admission keeps new legacy entrants out throughout host callback wait', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred(); let invoked = 0;
  const pending = h.api.admitStrictCaptureCohort(async () => {invoked++; entered.resolve(); await gate.promise; return {ok:true};});
  await entered.promise;
  assertPending(await h.api.closeCaptureTaskWorkerTabs([8]));
  assertPending(await h.api.setCaptureTaskMinimized({taskId:'task',minimized:true}));
  gate.resolve();
  assert.deepEqual(plain(await pending), {ok:true});
  assert.equal(invoked, 1);
  assert.deepEqual(h.events, []);
});

test('strict admission rechecks private resources after raw storage await', async () => {
  const h = harness({capturePrivateState:true}); const entered = deferred(); const gate = deferred(); let invoked = 0;
  h.ports.chrome.storage.local.get = async key => {entered.resolve(); await gate.promise; return {[key]:{captureDebugSession:null}};};
  const pending = h.api.admitStrictCaptureCohort(() => {invoked++; return {ok:true};});
  await entered.promise; h.privateState.captureTaskCleanupInProgress.add('task'); gate.resolve();
  assertPending(await pending);
  assert.equal(invoked, 0);
  assert.deepEqual(h.events, []);
});

test('strict admission never calls final callback when storage evidence is unavailable', async () => {
  const h = harness(); let invoked = 0;
  h.ports.chrome.storage.local.get = async () => {throw new Error('synthetic unavailable');};
  await assert.rejects(h.api.admitStrictCaptureCohort(() => {invoked++;}), /synthetic unavailable/u);
  assert.equal(invoked, 0);
  assert.deepEqual(h.events, []);
});

for (const [name, args, denied] of [
  ...entries,
  ['beginCaptureTask', [{taskId:'task',sourceTabId:7}]],
  ['beginCaptureTaskNow', [{taskId:'task',sourceTabId:7}]],
]) test(`admission barrier synchronously prevents ${name} before journal publication`, async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  const pending = h.api.admitStrictCaptureCohort(async () => {entered.resolve(); await gate.promise; return {ok:true};});
  await entered.promise;
  // The raw journal remains absent: this proves the in-memory barrier, not the
  // existing retained-record guard, protects the source-validation/CAS window.
  assert.equal(h.record.retained, false);
  const result = h.api[name](...args);
  assert.equal(typeof result.then, 'function', `${name} retains its asynchronous contract`);
  if (denied === false) assert.equal(await result, false); else assertPending(await result);
  assert.deepEqual(h.events, []);
  gate.resolve(); await pending;
});

test('native worker operation is counted before its first journal await and until real completion', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred(); let invoked = 0;
  h.ports.hasStrictCaptureStopControl = async () => {entered.resolve(); await gate.promise; return false;};
  const work = h.api.closeCaptureTaskWorkerTabs([8]);
  const blocked = h.api.admitStrictCaptureCohort(() => {invoked++; return {ok:true};});
  await entered.promise;
  assertPending(await blocked);
  assert.equal(invoked, 0);
  assert.deepEqual(h.events, []);
  gate.resolve(); await work;
  assert.deepEqual(h.events, ['tab.remove:8']);
  assert.deepEqual(plain(await h.api.admitStrictCaptureCohort(() => ({ok:true}))), {ok:true});
});

test('untracked native remove Promise remains an entrant until its actual settlement', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  h.ports.chrome.tabs.remove = async () => {entered.resolve(); await gate.promise;};
  const work = h.api.closeCaptureTaskWorkerTabs([8]);
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assertPending(await h.api.admitStrictCaptureCohort(() => ({ok:true})));
  gate.resolve(); await work;
  assert.deepEqual(plain(await h.api.admitStrictCaptureCohort(() => ({ok:true}))), {ok:true});
});

test('native rejection releases entrant count without swallowing the legacy failure', async () => {
  const h = harness();
  h.ports.chrome.tabs.remove = async () => {throw new Error('synthetic worker remove failure');};
  await assert.rejects(h.api.closeCaptureTaskWorkerTabs([8]), error => error.code === 'capture_worker_close_failed');
  assert.deepEqual(plain(await h.api.admitStrictCaptureCohort(() => ({ok:true}))), {ok:true});
});

test('direct debug facade Promise retains exact identity and blocks admission until settlement', async () => {
  const h = harness(); const gate = deferred();
  delete h.ports.hasStrictCaptureStopControl;
  h.debug.stopByTaskId = () => gate.promise;
  assert.equal(h.api.debugSessions.stopByTaskId('task'), gate.promise);
  assertPending(await h.api.admitStrictCaptureCohort(() => ({ok:true})));
  gate.resolve({released:true}); await gate.promise;
  assert.deepEqual(plain(await h.api.admitStrictCaptureCohort(() => ({ok:true}))), {ok:true});
});

test('direct debug synchronous error preserves throw and releases entrant count', async () => {
  const h = harness();
  delete h.ports.hasStrictCaptureStopControl;
  h.debug.updateTask = () => {throw new Error('synthetic synchronous manager failure');};
  assert.throws(() => h.api.debugSessions.updateTask({taskId:'task'}), /synthetic synchronous manager failure/u);
  assert.deepEqual(plain(await h.api.admitStrictCaptureCohort(() => ({ok:true}))), {ok:true});
});

test('synchronous owner mutation and replacement-map APIs cannot enter admission window', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  h.owners.set('task',{connected:true});
  const pending = h.api.admitStrictCaptureCohort(async () => {entered.resolve(); await gate.promise; return {ok:true};});
  await entered.promise;
  const clear = h.api.owners.clearTask('task');
  assert.equal(clear instanceof Promise, false);
  assertPending(clear);
  assert.equal(h.api.rememberCaptureTaskReplacementTab({removedTabId:7,addedTabId:9,taskId:'task'}), false);
  assert.equal(h.api.replaceTrackedCaptureTaskWorkerTab('task',7,9), false);
  assert.equal(h.api.resolveCaptureTaskReplacementLease(7), null);
  assert.equal(h.owners.has('task'), true);
  assert.deepEqual(h.events, []);
  gate.resolve(); await pending;
  assert.equal(h.api.owners.clearTask('task'), undefined);
  assert.equal(h.owners.has('task'), false);
});

test('automatic native state publication counts as an entrant despite no active manager session', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  h.ports.chrome.action.setBadgeText = async () => {entered.resolve(); await gate.promise;};
  const work = h.callbacks.onStateChange(null);
  await entered.promise;
  assertPending(await h.api.admitStrictCaptureCohort(() => ({ok:true})));
  gate.resolve(); await work;
  assert.deepEqual(plain(await h.api.admitStrictCaptureCohort(() => ({ok:true}))), {ok:true});
});

test('automatic callbacks cannot write during the admission source-validation window', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  const pending = h.api.admitStrictCaptureCohort(async () => {entered.resolve(); await gate.promise; return {ok:true};});
  await entered.promise;
  await h.callbacks.onStateChange(null);
  await h.callbacks.onUnexpectedDetach({session:{taskId:'task',persistent:true,tabId:7},reason:'target_closed'});
  await h.ownerCallbacks.onAbandoned({taskId:'task'});
  assert.deepEqual(h.events, []);
  gate.resolve(); await pending;
});

test('callback failure releases admission barrier but cannot swallow the exact failure', async () => {
  const h = harness(); const entered = deferred(); const gate = deferred();
  const failure = new Error('synthetic source CAS failure');
  const pending = h.api.admitStrictCaptureCohort(async () => {entered.resolve(); await gate.promise; throw failure;});
  await entered.promise;
  assertPending(await h.api.admitStrictCaptureCohort(() => ({ok:true})));
  assertPending(await h.api.closeCaptureTaskWorkerTabs([8]));
  gate.resolve(); await assert.rejects(pending, error => error === failure);
  await h.api.closeCaptureTaskWorkerTabs([8]);
  assert.deepEqual(h.events, ['tab.remove:8']);
});
