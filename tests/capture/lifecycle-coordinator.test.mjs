import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const names = ['leases', 'restore', 'admission', 'begin', 'progress', 'cleanup', 'attempts', 'end', 'tabs', 'coordinator'];
const sources = Object.fromEntries(await Promise.all(names.map(async name => [name,
  await readFile(new URL(`utils/capture/lifecycle/${name}.js`, root), 'utf8'),
])));
const runtimeSource = await readFile(new URL('utils/capture/task-runtime.js', root), 'utf8');
const identitySource = await readFile(new URL('utils/capture/execution-identity.js', root), 'utf8');
const fingerprints = JSON.parse(await readFile(new URL('tests/fixtures/capture-lifecycle-body-fingerprints.json', root), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; let reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; }

function load() {
  const context = vm.createContext({setTimeout, clearTimeout});
  for (const [name, source] of [['runtime',runtimeSource],['identity',identitySource],...Object.entries(sources)]) {
    vm.runInContext(source, context, {filename: name});
  }
  return context;
}

function harness(context = load()) {
  const events = []; const sessions = new Map(); const groups = new Map(); const owners = new Map();
  const runtime = {}; let callbacks; let ownerCallbacks;
  const debug = {
    getSessionByTaskId: id => sessions.get(id) ?? null,
    getSession: tab => [...sessions.values()].find(s => s.tabId === tab) ?? null,
    getActiveSessions: () => [...sessions.values()],
    async stopByTaskId(id) { events.push('debug'); sessions.delete(id); return {released:true}; },
    async updateTask(update) { const value={...sessions.get(update.taskId),...update}; sessions.set(update.taskId,value); return value; },
  };
  const group = {
    getTask: id => groups.get(id) ?? null,
    getActiveTasks: () => [...groups.values()],
    async end({taskId}) { events.push('group'); groups.delete(taskId); return {released:true}; },
  };
  const owner = {
    getOwner: id => owners.get(id) ?? null,
    clearTask(id) { events.push('owner'); owners.delete(id); },
    notifyCanceled() { events.push('cancel-notification'); },
  };
  const ports = {
    CAPTURE_TASK_GROUP_TITLE: 'synthetic-task', CAPTURE_TASK_REPLACEMENT_TAB_TTL_MS: 600000,
    STORAGE_KEYS: {runtime:'synthetic.runtime'}, TASK_LEDGER_STALE_ACTIVE_MS: 60000,
    UNATTENDED_RUNNER_QUERY_KEY:'synthetic-run',
    ...context.OnStarvoiceCaptureExecutionIdentity,
    chrome: {
      tabs: {async remove(id) {events.push(`worker:${id}`);}, async sendMessage() {return {ok:true};}},
      tabGroups:{}, debugger:{},
    },
    console:{warn(){},debug(){}}, setTimeout,
    captureTaskTabGroupApi:{createManager: () => group},
    debugSessionApi:{createManager(value) {callbacks=value; return debug;}},
    taskOwnerApi:{createCoordinator(value) {ownerCallbacks=value; return owner;}},
    taskRuntimeApi:context.OnStarvoiceCaptureTaskRuntime,
    taskTabGroupApi:{normalizeTaskTabRole: value=>value},
    normalizePlatformId: value=>value || 'unknown',
    detectPlatformFromUrl: ()=> 'xiaohongshu',
    readRuntimeState: async()=>runtime,
    async writeRuntimeState(patch) {Object.assign(runtime, typeof patch==='function' ? await patch(runtime) : patch); return runtime;},
    readStoredCaptureExecutionLock: async()=>null,
    readUnattendedKeywordRunRequest: async()=>null,
    isTerminalUnattendedRunStatus: value=>value==='completed',
    relayToContentWithRetry: async()=>({ok:true}),
    terminalizeCaptureTaskLedgerRun: async()=>events.push('terminal'),
    inspectTargetedPostCaptureTaskAttempt: async()=>({targeted:false,current:false}),
  };
  const api = context.OnStarvoiceCaptureLifecycle.create(ports);
  return {api, ports, runtime, events, sessions, groups, owners, debug, group, owner, callbacks, ownerCallbacks};
}

test('factories load without accessing host capabilities or creating execution state', () => {
  const context = vm.createContext({}); let accessed=0;
  for(const key of ['chrome','console','setTimeout','fetch','localStorage']) Object.defineProperty(context,key,{get(){accessed++; throw new Error('host access');}});
  for(const source of Object.values(sources)) vm.runInContext(source,context);
  assert.equal(accessed,0);
  assert.equal(typeof context.OnStarvoiceCaptureLifecycle.create,'function');
  assert.equal(Object.isFrozen(context.OnStarvoiceCaptureLifecycle),true);
});

for(const missing of names.filter(n=>n!=='coordinator')) test(`missing required ${missing} module fails before composition`, () => {
  const context=vm.createContext({});
  for(const name of names.filter(n=>n!==missing&&n!=='coordinator')) vm.runInContext(sources[name],context);
  assert.throws(()=>vm.runInContext(sources.coordinator,context), /Missing capture lifecycle module/u);
});

test('coordinator exposes a frozen compatible facade, never its mutable execution state', () => {
  const {api}=harness();
  assert.equal(Object.isFrozen(api),true);
  for(const name of ['state','operations','captureTaskLifecycleQueue','captureRuntimeRestorePromise','captureTaskBeginInFlight','captureTaskReplacementTabIds','captureTaskPendingWorkerTabIds','captureTaskCleanupInProgress']) assert.equal(Object.hasOwn(api,name),false);
  for(const name of ['beginCaptureTask','updateCaptureTask','registerCaptureTaskTab','endCaptureTask','restorePersistedCaptureRuntimeSession','handleCaptureRuntimeTabReplaced','handleCaptureRuntimeTabRemoved']) assert.equal(typeof api[name],'function');
});

test('manager compatibility ports expose only named operations and preserve method receivers and return values', async () => {
  const {api, debug, group, owner}=harness();
  const expected = {
    debugSessions: [debug, ['getSessionByTaskId','getSession','getActiveSessions','stopByTab','stopByTaskId','updateTask']],
    tabGroups: [group, ['getTask']],
    owners: [owner, ['getOwner','clearTask','attachPort','bind']],
  };
  for(const [name,[manager,methods]] of Object.entries(expected)) {
    const facade=api[name];
    assert.notEqual(facade,manager);
    assert.equal(Object.isFrozen(facade),true);
    assert.deepEqual(Object.keys(facade).sort(),[...methods].sort());
    for(const method of methods) {
      const args=[{taskId:'synthetic'},'reason']; const value={method};
      manager[method]=function(...received) {assert.equal(this,manager);assert.deepEqual(received,args);return value;};
      assert.equal(facade[method](...args),value);
      const pending=Promise.resolve(value);
      manager[method]=function(...received) {assert.equal(this,manager);assert.deepEqual(received,args);return pending;};
      assert.equal(facade[method](...args),pending);
      assert.equal(await pending,value);
    }
  }
});

test('separate coordinators have independent queues; a rejection does not poison either queue', async () => {
  const context=load(); const a=harness(context); const b=harness(context); const gate=deferred(); const entered=deferred(); const order=[];
  const blocked=a.api.runCaptureTaskLifecycleOperation(async()=>{order.push('a1');entered.resolve();await gate.promise;throw new Error('controlled');});
  const rejection=assert.rejects(blocked,/controlled/u);
  await entered.promise;
  const second=a.api.runCaptureTaskLifecycleOperation(()=>order.push('a2'));
  await b.api.runCaptureTaskLifecycleOperation(()=>order.push('b1'));
  assert.deepEqual(order,['a1','b1']);
  gate.resolve(); await rejection; await second;
  assert.deepEqual(order,['a1','b1','a2']);
});

test('replacement leases and task/attempt fences are local to each lifecycle instance', () => {
  const context=load(); const a=harness(context); const b=harness(context);
  assert.equal(a.api.rememberCaptureTaskReplacementTab({removedTabId:1,addedTabId:2,taskId:'task',attemptId:'attempt'}),true);
  assert.equal(a.api.resolveCaptureTaskReplacementLease(1,{taskId:'task',attemptId:'old'}),null);
  assert.deepEqual(plain(a.api.resolveCaptureTaskReplacementLease(1,{taskId:'task',attemptId:'attempt'})),{tabId:2,taskId:'task',attemptId:'attempt'});
  assert.equal(b.api.resolveCaptureTaskReplacementLease(1),null);
  a.api.pruneCaptureTaskReplacementTabs(Date.now()+600001);
  assert.equal(a.api.resolveCaptureTaskReplacementLease(1),null);
});

test('failed workers remain tracked in their owner; replacement and successful cleanup do not cross instances', async () => {
  const context=load(); const a=harness(context); const b=harness(context);
  a.ports.chrome.tabs.remove=async()=>{throw new Error('synthetic close failure');};
  await assert.rejects(a.api.closeTrackedCaptureTaskWorkerTabs('task',[42]),error=>error.code==='capture_worker_close_failed');
  assert.deepEqual(plain(a.api.getTrackedCaptureTaskWorkers('task')),[42]);
  assert.deepEqual(plain(b.api.getTrackedCaptureTaskWorkers('task')),[]);
  assert.equal(a.api.replaceTrackedCaptureTaskWorkerTab('task',42,43),true);
  assert.deepEqual(plain(a.api.getTrackedCaptureTaskWorkers('task')),[43]);
  a.ports.chrome.tabs.remove=async id=>a.events.push(`worker:${id}`);
  await a.api.closeTrackedCaptureTaskWorkerTabs('task',[43]);
  assert.deepEqual(plain(a.api.getTrackedCaptureTaskWorkers('task')),[]);
});

test('cleanup retains one in-flight owner and releases Debug, workers, group and owner in order', async () => {
  const context=load(); const a=harness(context); const b=harness(context); const gate=deferred(); const entered=deferred();
  a.sessions.set('task',{taskId:'task',tabId:7,persistent:true,workerTabIds:[8]});
  a.groups.set('task',{taskId:'task',sourceTabId:7,workerTabIds:[8]});
  a.owners.set('task',{connected:true});
  a.debug.stopByTaskId=async()=>{a.events.push('debug');entered.resolve();await gate.promise;return {released:true};};
  const pending=a.api.releaseCaptureTaskResources({taskId:'task',reason:'completed'});
  await entered.promise;
  assert.equal(a.api.isCaptureTaskCleanupInProgress('task'),true);
  assert.equal(b.api.isCaptureTaskCleanupInProgress('task'),false);
  assert.equal(a.runtime.captureDebugSession.cleanupPending,true);
  gate.resolve(); await pending;
  assert.deepEqual(a.events,['debug','worker:8','group','owner']);
  assert.equal(a.api.isCaptureTaskCleanupInProgress('task'),false);
  assert.equal(a.runtime.captureDebugSession,null);
});

test('cleanup failure retains persistent ownership and pending workers for the next attempt', async () => {
  const a=harness(); a.sessions.set('task',{taskId:'task',tabId:7,persistent:true,workerTabIds:[8]});
  a.groups.set('task',{taskId:'task',sourceTabId:7,workerTabIds:[8]}); a.owners.set('task',{connected:true});
  a.ports.chrome.tabs.remove=async()=>{throw new Error('synthetic close failure');};
  await assert.rejects(a.api.releaseCaptureTaskResources({taskId:'task',reason:'completed'}),error=>error.code==='capture_worker_close_failed');
  assert.equal(a.api.isCaptureTaskCleanupInProgress('task'),false);
  assert.equal(a.runtime.captureDebugSession.cleanupPending,true);
  assert.equal(a.groups.has('task'),true); assert.equal(a.owners.has('task'),true);
  assert.deepEqual(plain(a.api.getTrackedCaptureTaskWorkers('task')),[8]);
  assert.deepEqual(a.events,['debug']);
});

test('old unattended attempts are rejected by progress and END without resource mutations', async () => {
  const {api,events}=harness();
  const taskId='unattended-capture:synthetic-request';
  const update=await api.updateCaptureTask({taskId,attemptId:'old'});
  const end=await api.endCaptureTask({taskId,attemptId:'old',status:'canceled'});
  assert.equal(update.reason,'stale_unattended_attempt'); assert.equal(end.reason,'stale_unattended_attempt');
  assert.equal(end.released,false); assert.deepEqual(events,[]);
});

test('manager detach callback remains observational, while the explicit END owns business termination', async () => {
  const {api,events,callbacks,sessions}=harness();
  const session={taskId:'task',tabId:7,persistent:true,workerTabIds:[]};sessions.set('task',session);
  await callbacks.onUnexpectedDetach({session,reason:'target_closed'});
  assert.deepEqual(events,[]);
  await api.endCaptureTask({taskId:'task',status:'completed'});
  assert.deepEqual(events,['debug','group','owner','terminal']);
});

test('all 54 migrated function bodies preserve the pinned baseline except explicit state/API qualification', () => {
  const {api}=harness();
  assert.equal(fingerprints.baseline,'d5b243f0c6e6e9b3f920ab8264264553a6141411');
  assert.equal(fingerprints.entries.length,54);
  const globals={taskRuntimeApi:'OnStarvoiceCaptureTaskRuntime',taskTabGroupApi:'OnStarvoiceCaptureTaskTabGroup',debugSessionApi:'OnStarvoiceCaptureDebugSession',taskOwnerApi:'OnStarvoiceCaptureTaskOwner'};
  for(const {name,sha256} of fingerprints.entries) {
    let source=api[name].toString().replace(/\bstate\.(captureTaskLifecycleQueue|captureRuntimeRestorePromise|captureTaskBeginInFlight|captureTaskReplacementTabIds|captureTaskPendingWorkerTabIds|captureTaskCleanupInProgress|captureDebugSessionManager|captureTaskTabGroupManager|captureTaskOwnerCoordinator)\b/gu,'$1');
    for(const [alias,global] of Object.entries(globals)) source=source.replace(new RegExp(`\\b${alias}\\.`,'gu'),`globalThis.${global}.`);
    source=source.split('\n').map(line=>line.trim()).join('\n');
    assert.equal(createHash('sha256').update(source).digest('hex'),sha256,name);
  }
});
