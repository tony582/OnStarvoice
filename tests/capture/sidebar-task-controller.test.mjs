import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {createSidebarTaskController} from '../../sidebar/task-controller/coordinator.js';
import {KEYWORD_SORT_DIMENSION} from '../../sidebar/task-controller/keyword-state.js';
import {createLegacyKeywordView} from '../../sidebar/legacy-view/coordinator.js';
import {createLegacyCaptureInputsView} from '../../sidebar/legacy-view/capture-inputs.js';
import {createLegacyKeywordInputsView} from '../../sidebar/legacy-view/keyword-inputs.js';
import {createLegacyCaptureProgressView} from '../../sidebar/legacy-view/capture-progress.js';
import {createLegacyProgressVisibilityView} from '../../sidebar/legacy-view/progress-visibility.js';
import {createLegacyTaskCenterActions} from '../../sidebar/legacy-application/task-center-actions.js';
import {createLegacyTaskCenterActionView} from '../../sidebar/legacy-view/task-center-actions.js';
import {createLocalRecoveryRunnerGate} from '../../sidebar/recovery-runner-gate.js';
import {readSidebarFunction, readSidebarFunctionOwner} from '../helpers/sidebar-controller-source.mjs';
import * as constants from '../../utils/constants.js';
import {DEFAULT_CAPTURE_SETTINGS} from '../../utils/capture-settings.js';

const root = new URL('../../', import.meta.url);
const hostSource = readFileSync(new URL('sidebar/sidebar-logic.js', root), 'utf8');
const fixtureSource = readFileSync(new URL('tests/fixtures/sidebar-controller-migration.json', root), 'utf8');
const fixture = JSON.parse(fixtureSource);
const moved = fixture.entries.filter(entry => entry.module);
const viewPrivateNames = new Set(['setRecoveryCopy', 'isRecoveryActionAvailable', 'handoffRecoveryFocus']);
const controllerMoved = moved.filter(entry => !viewPrivateNames.has(entry.name));
const plain = value => JSON.parse(JSON.stringify(value));
const silence = {log() {}, warn() {}, error() {}};
const hash = source => createHash('sha256').update(source.split('\n').map(line => line.trim()).join('\n')).digest('hex');
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};

// Every operation below executes actual ESM stages. I/O is synthetic and cannot
// reach a browser, customer data, authorization service or collection target.
function harness(overrides = {}) {
  const events = [];
  const timers = new Map();
  const control = {releaseOk: true, failRelay: false};
  let sequence = 0;
  const ports = {
    ...constants, KEYWORD_SORT_DIMENSION, console: silence,
    CAPTURE_TASK_OWNER_PORT_NAME: 'synthetic-owner',
    CAPTURE_EXECUTION_LOCK_HOLDER_ID: 'synthetic-holder',
    CAPTURE_EXECUTION_LOCK_HEARTBEAT_INTERVAL_MS: 30000,
    ACTIVE_COMMENT_PROGRESS_PHASES: new Set(['comments_capturing']),
    COMMENT_PHASE_TO_TERMINAL_STATUS: {comments_done: 'done'},
    KEYWORD_PLAN_TERMINAL_STATUSES: new Set(['completed', 'failed', 'canceled']),
    TARGETED_POST_RUN_QUERY_KEY: 'targetedPostRun',
    TARGETED_POST_RUN_ATTEMPT_QUERY_KEY: 'targetedPostAttempt',
    UNATTENDED_RUN_QUERY_KEY: 'unattendedRun',
    UNATTENDED_RUN_ATTEMPT_QUERY_KEY: 'unattendedAttempt',
    getCurrentRuntime: () => ({platform: 'xiaohongshu', captureDebugSession: {taskId: 'task-a', persistent: true, sourceTabId: 19}}),
    getCurrentAuth: () => ({verified: true}),
    getCurrentDataPool: () => ({records: []}),
    document: {getElementById: () => null},
    window: {location: {href: 'chrome-extension://synthetic/sidebar.html', search: ''}},
    showMessage: (...args) => events.push(['message', ...args]),
    showProgress: (...args) => events.push(['show-progress', ...args]),
    hideProgress: () => events.push(['hide-progress']),
    hideProgressPanelOnly: () => events.push(['hide-panel']),
    renderCaptureDebugSession: () => events.push(['render-debug']),
    setCancelFlag: value => events.push(['cancel-flag', value]),
    refreshDataPool: async () => {events.push(['refresh-pool']);},
    setTimeout: (callback, delay) => {events.push(['timeout', delay]); queueMicrotask(callback); return ++sequence;},
    clearTimeout: id => events.push(['clear-timeout', id]),
    setInterval: (callback, delay) => {const id = ++sequence; timers.set(id, callback); events.push(['interval', id, delay]); return id;},
    clearInterval: id => {events.push(['clear-interval', id]); timers.delete(id);},
    chrome: {
      tabs: {query: async query => {events.push(['tabs-query', query]); return [{id: 19}];}},
      runtime: {sendMessage: async message => {
        events.push(['runtime', plain(message)]);
        if (message.type === 'onstarvoice:release-capture-lock') return {ok: control.releaseOk};
        if (message.type === 'onstarvoice:acquire-capture-lock') return {ok: true, data: {id: 'lock-new'}};
        if (control.failRelay && message.type === constants.MESSAGE_TYPE.RELAY_TO_CONTENT) throw Error('synthetic relay failed');
        return {ok: true};
      }},
    },
    ...overrides,
  };
  ports.taskView = Object.freeze({
    ...createLegacyCaptureInputsView(ports),
    ...createLegacyKeywordInputsView(ports),
    ...createLegacyCaptureProgressView(ports),
    ...createLegacyProgressVisibilityView(ports),
    ...overrides.taskView,
  });
  const api = createSidebarTaskController(ports);
  return {api, events, ports, timers, control};
}

test('controller cold import and construction do not read DOM, clocks, random, storage or network', () => {
  const script = `import assert from 'node:assert/strict';
    for (const name of ['chrome','browser','window','document','fetch','localStorage','indexedDB','Date','performance','setTimeout','setInterval']) Object.defineProperty(globalThis,name,{get(){throw Error('unexpected '+name);},configurable:true});
    Math.random=()=>{throw Error('unexpected random');};
    const {createSidebarTaskController}=await import(${JSON.stringify(new URL('sidebar/task-controller/coordinator.js', root).href)});
    const api=createSidebarTaskController({});
    assert.equal(Object.isFrozen(api),true); assert.equal(api.readDetailBatchCaptureInFlight(),false);
    process.stdout.write('cold-safe');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {encoding: 'utf8', timeout: 10000}), 'cold-safe');
});

test('L3-A migration evidence stays pinned while current operations use their actual owners', () => {
  assert.equal(fixture.baseline, 'f1ed550f4b0bc9125223e95287a829b4edddd64a');
  assert.equal(createHash('sha256').update(fixtureSource).digest('hex'),
    'a658643e3b297b197dd5f0d03817581e4a46e2206ec43c73691ba883bae34b04',
    'Historical L3-A evidence must not be rewritten to match L3-B changes');
  assert.equal(moved.length, 165);
  assert.equal(fixture.state.length, 62);
  const api = createSidebarTaskController({});
  for (const entry of controllerMoved) {
    assert.match(readSidebarFunctionOwner(entry.name).path, /^sidebar\/task-controller\//u);
    assert.equal(hash(api[entry.name].toString()), hash(readSidebarFunction(entry.name)), entry.name);
  }
  for (const name of viewPrivateNames) {
    assert.equal(Object.hasOwn(api, name), false, `${name} is presentation-private`);
    assert.equal(readSidebarFunctionOwner(name).path, 'sidebar/legacy-view/capture-progress.js');
  }
  for (const key of ['state', 'controllerState', 'controllerBindings', 'controllerPorts', 'controllerOperations']) assert.equal(Object.hasOwn(api, key), false);
  for (const entry of moved) assert.doesNotMatch(hostSource, new RegExp(`\\bfunction ${entry.name}\\(`, 'u'));
  for (const {name} of fixture.state) assert.doesNotMatch(hostSource, new RegExp(`\\b(?:let|const) ${name}\\b`, 'u'));
});

test('independent controller instances do not share comment terminal maps or Attempt ownership', () => {
  const a = harness(); const b = harness();
  a.api.markCommentCaptureTerminalStatus('record-a', 'done');
  assert.equal(a.api.isCommentCaptureTerminal('record-a'), true);
  assert.equal(b.api.isCommentCaptureTerminal('record-a'), false);
  a.api.activateUnattendedRunRequest({id: 'run', attemptId: 'old'});
  a.api.activateUnattendedRunRequest({id: 'run', attemptId: 'new'});
  a.api.clearActiveUnattendedRunRequest('run', 'old');
  assert.equal(a.api.readActiveUnattendedRunRequestId(), 'run');
  assert.equal(b.api.readActiveUnattendedRunRequestId(), '');
  a.api.clearActiveUnattendedRunRequest('run', 'new');
  assert.equal(a.api.readActiveUnattendedRunRequestId(), '');
});

test('targeted invocation fencing rejects earlier and other-instance tokens', () => {
  const a = harness(); const b = harness();
  const old = a.api.activateTargetedPostInvocation({requestId: 'request', attemptId: 'old'});
  const current = a.api.activateTargetedPostInvocation({requestId: 'request', attemptId: 'new'});
  assert.equal(a.api.isActiveTargetedPostInvocation(old), false);
  assert.equal(a.api.isActiveTargetedPostInvocation(current), true);
  assert.equal(b.api.isActiveTargetedPostInvocation(current), false);
  assert.deepEqual(a.api.getTargetedPostInvocationOwnership(old), {active: false, run: false, batch: false, runnerTab: false});
});

test('late unrelated task and Attempt progress return unchanged before any business side effect', () => {
  const h = harness();
  h.api.activateUnattendedRunRequest({id: 'current-run', attemptId: 'current-attempt'});
  for (const progress of [
    {unattendedRequestId: 'old-run', unattendedAttemptId: 'current-attempt'},
    {unattendedRequestId: 'current-run', unattendedAttemptId: 'old-attempt'},
  ]) assert.equal(h.api.handleProgress(progress), progress);
  assert.deepEqual(h.events, []);
});

test('shutdown sets closing before disconnect and never schedules owner reconnection', () => {
  const events = []; let disconnected;
  const port = {postMessage: message => events.push(['owner-message', message]),
    onMessage: {addListener() {}}, onDisconnect: {addListener: callback => {disconnected = callback;}},
    disconnect: () => {events.push(['disconnect']); disconnected();}};
  const h = harness({chrome: {runtime: {connect: () => {events.push(['connect']); return port;}}}});
  h.api.bindCaptureTaskOwner('task-a'); h.api.shutdownCaptureTaskOwner(); h.api.connectCaptureTaskOwnerPort();
  assert.equal(events.filter(e => e[0] === 'connect').length, 1);
  assert.equal(events.filter(e => e[0] === 'disconnect').length, 1);
  assert.equal(h.events.some(e => e[0] === 'timeout'), false);
  assert.equal(h.api.postCaptureTaskOwnerMessage({type: 'after-close'}), false);
});

for (const failRelay of [false, true]) test(`cancel preserves relay-before-assist-end ordering even on relay failure: ${failRelay}`, async () => {
  const h = harness(); h.control.failRelay = failRelay;
  await h.api.handleCancel();
  const messages = h.events.filter(e => e[0] === 'runtime').map(e => e[1]);
  assert.equal(messages[0].tabId, 19);
  assert.equal(messages[0].type, constants.MESSAGE_TYPE.RELAY_TO_CONTENT);
  assert.equal(messages[1].type, 'onstarvoice:end-capture-task');
  assert.equal(messages[1].taskId, 'task-a');
  assert.equal(h.events[0][0], 'cancel-flag');
});

test('failed lock release retains cleanup gate, retries old release before new acquisition', async () => {
  const h = harness(); h.api.adoptUnattendedCaptureExecutionLock({id: 'old-lock', holderTabId: 19});
  h.control.releaseOk = false;
  assert.equal(await h.api.releaseCaptureExecutionLock('old-lock'), false);
  assert.equal(await h.api.acquireCaptureExecutionLock(), null);
  assert.equal(h.events.filter(e => e[0] === 'runtime' && e[1].type === 'onstarvoice:acquire-capture-lock').length, 0);
  assert.deepEqual(h.events.filter(e => e[0] === 'timeout').map(e => e[1]), [120, 360, 120, 360]);
  h.control.releaseOk = true;
  assert.equal((await h.api.acquireCaptureExecutionLock()).id, 'lock-new');
  const kinds = h.events.filter(e => e[0] === 'runtime').map(e => e[1].type);
  assert.equal(kinds.at(-2), 'onstarvoice:release-capture-lock');
  assert.equal(kinds.at(-1), 'onstarvoice:acquire-capture-lock');
});

test('releasing an earlier lock cannot clear a newer lock heartbeat or renewal', async () => {
  const h = harness();
  h.api.adoptUnattendedCaptureExecutionLock({id: 'old', holderTabId: 17});
  h.api.adoptUnattendedCaptureExecutionLock({id: 'current', holderTabId: 19});
  const activeTimers = [...h.timers.keys()];
  await h.api.releaseCaptureExecutionLock('old');
  assert.deepEqual([...h.timers.keys()], activeTimers);
  await h.api.renewCaptureExecutionLock('current');
  const renewal = h.events.find(e => e[0] === 'runtime' && e[1].type === 'onstarvoice:renew-capture-lock');
  assert.equal(renewal[1].lockId, 'current'); assert.equal(renewal[1].holderTabId, 19);
});

for (const mode of ['success', 'load-failure', 'write-failure']) test(`storage remains lazy with read/write/refresh order and propagates failures: ${mode}`, async () => {
  const calls = [];
  const h = harness({loadStorageModule: async () => {
    calls.push('load'); if (mode === 'load-failure') throw Error('synthetic load failure');
    return {getRecord: async () => {calls.push('read'); return {type: 'single_note', payload: {commentsTotalCaptured: 2}};},
      updateRecord: async () => {calls.push('write'); if (mode === 'write-failure') throw Error('synthetic write failure');}};
  }, refreshDataPool: async () => {calls.push('refresh');}});
  assert.deepEqual(calls, []);
  const result = h.api.reconcileCommentCaptureTerminalState('record', {status: 'done', collectedCount: 3});
  if (mode === 'success') {await result; assert.deepEqual(calls, ['load', 'read', 'write', 'refresh']);}
  else {await assert.rejects(result, /synthetic/); assert.equal(calls.includes('refresh'), false);}
});

test('controller-owned keyword state stays live and cancellation uses the latest loaded plan', async () => {
  let plan = {lastRunRequestId: 'old'};
  const calls = [];
  const next = {id: 'current', status: 'canceled'};
  const h = harness({buildKeywordRunDisplayPlan: value => value,
    loadKeywordPlanUI: async () => {}, loadActiveKeywordRunState: async () => {},
    taskView: {renderKeywordPlanStatusLabels: () => {}, hideKeywordPlanProgressPanelIfOwned: () => {}},
    chrome: {runtime: {sendMessage: async message => {
      calls.push(message);
      if (message.type === 'onstarvoice:get-unattended-keyword-plan') return {ok: true, data: plan};
      return {ok: true, data: {request: next}};
    }}}});
  await h.api.loadKeywordPlanUI({preserveInputs: true});
  assert.equal(h.api.readKeywordPlanState().lastRunRequestId, 'old');
  plan = {lastRunRequestId: 'current'};
  await h.api.loadKeywordPlanUI({preserveInputs: true});
  assert.equal(h.api.readKeywordPlanState(), plan);
  await h.api.cancelUnattendedKeywordPlanFromSidebar();
  assert.equal(calls.find(call => call.type === 'onstarvoice:cancel-unattended-keyword-run').requestId, 'current');
  assert.equal(h.api.buildKeywordRunDisplayPlan(null).lastRunRequestId, 'current');
  assert.equal(harness().api.readKeywordPlanState(), null);
});

// Execute the complete actual host, not a concatenation of migrated functions.
// Imported capabilities are substituted; bootstrap pauses at the first storage
// await so the test cannot start the original background/collection workflow.
function hostHarness(source = hostSource, readyState = 'loading') {
  const events = []; const listeners = new Map(); const pending = deferred();
  const location = {href: 'chrome-extension://synthetic/sidebar.html', search: ''};
  // Use the real ordinary-page gate, without a dormant-runner URL or claim.
  // It must preserve the existing startup/hook trace without opening a port.
  const localRecoveryRunnerGate = createLocalRecoveryRunnerGate({location});
  const imports = {};
  for (const match of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"];?/gmu)) {
    for (const binding of match[1].split(',').map(v => v.trim()).filter(Boolean)) {
      const name = binding.split(/\s+as\s+/u).at(-1);
      imports[name] = () => {throw Error(`unexpected imported capability ${name}`);};
    }
  }
  const context = vm.createContext({...imports, ...constants, DEFAULT_CAPTURE_SETTINGS, KEYWORD_SORT_DIMENSION,
    AUTH_CODE_VIEW_MODE: {ENCRYPTED: 'encrypted'}, createSidebarTaskController,
    createLegacyKeywordView, createLegacyCaptureInputsView, createLegacyKeywordInputsView, createLegacyCaptureProgressView, createLegacyProgressVisibilityView,
    createLegacyTaskCenterActions, createLegacyTaskCenterActionView,
    getLocalRecoveryRunnerGate: () => localRecoveryRunnerGate,
    HTMLElement: class HTMLElement {}, navigator: {},
    console: silence, URL, URLSearchParams, TextEncoder,
    crypto: {randomUUID: () => 'synthetic-holder'},
    document: {readyState, getElementById: () => null,
      addEventListener: (name, callback) => {events.push(['document-listener', name]); listeners.set(name, callback);}},
    window: {location,
      addEventListener: (name, callback) => {events.push(['window-listener', name]); listeners.set(name, callback);}},
    chrome: {runtime: {id: 'synthetic'}, storage: {local: {get: key => {events.push(['storage-read', key]); return pending.promise;}}}},
    confirm: () => {throw Error('unexpected dialog');},
    setTimeout: () => {throw Error('unexpected timer');}, clearTimeout: () => {},
    setInterval: () => {throw Error('unexpected interval');}, clearInterval: () => {},
  });
  const executable = source.replace(/^import\s*(?:\{[^}]+\}\s*from\s*)?['"][^'"]+['"];?[^\S\n]*\n/gmu, '').replace(/^export (?=(?:async )?function\b)/gmu, '');
  assert.doesNotMatch(executable, /^import\b|^export\b/mu);
  vm.runInContext(`${executable}\nglobalThis.hostTestApi = {initSidebar, ${controllerMoved.map(e => e.name).join(',')}};`, context, {timeout: 1500});
  return {events, listeners, context, api: context.hostTestApi};
}

for (const readyState of ['loading', 'complete']) test(`actual host composes before original startup and registers exactly the original hooks: ${readyState}`, () => {
  const h = hostHarness(hostSource, readyState);
  if (readyState === 'loading') {
    assert.deepEqual(h.events.map(e => e.slice(0, 2)), [['document-listener', 'DOMContentLoaded'], ['window-listener', 'beforeunload'], ['window-listener', 'pagehide']]);
    assert.equal(h.listeners.get('DOMContentLoaded'), h.api.initSidebar);
    void h.listeners.get('DOMContentLoaded')();
  } else assert.equal(h.events[0][0], 'storage-read');
  assert.equal(h.events.filter(e => e[0] === 'storage-read').length, 1);
  const actualController = createSidebarTaskController({});
  for (const {name} of controllerMoved) assert.equal(h.api[name].toString(), actualController[name].toString(), `host alias ${name}`);
  h.listeners.get('beforeunload')(); h.listeners.get('pagehide')();
});

test('late host view reads use current controller values and not a construction-time snapshot', () => {
  const h = hostHarness();
  h.api.activateUnattendedRunRequest({id: 'now', attemptId: 'attempt'});
  assert.equal(vm.runInContext('sidebarTaskController.readActiveUnattendedRunRequestId()', h.context), 'now');
  assert.equal(vm.runInContext('typeof activeUnattendedRunRequestId', h.context), 'undefined');
  h.api.clearActiveUnattendedRunRequest('now', 'attempt');
  assert.equal(vm.runInContext('sidebarTaskController.readActiveUnattendedRunRequestId()', h.context), '');
});

// These extra local checks require only the exact Git object, never network.
// CI always runs every test above, including shallow Node 18 checkouts.
if (process.env.ONSTARVOICE_L3_BASELINE_REF) {
  assert.equal(process.env.ONSTARVOICE_L3_BASELINE_REF, fixture.baseline);
  const baseline = execFileSync('git', ['show', `${fixture.baseline}:sidebar/sidebar-logic.js`], {cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  for (const readyState of ['loading', 'complete']) test(`exact baseline/candidate startup event trace: ${readyState}`, () => {
    const a = hostHarness(baseline, readyState); const b = hostHarness(hostSource, readyState);
    if (readyState === 'loading') {void a.listeners.get('DOMContentLoaded')(); void b.listeners.get('DOMContentLoaded')();}
    assert.deepEqual(b.events, a.events);
  });
}
