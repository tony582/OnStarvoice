import assert from 'node:assert/strict';
import test from 'node:test';

for (const name of ['task-runtime', 'debug-session', 'task-tab-group', 'task-owner',
  'lifecycle/cleanup', 'lifecycle/attempts']) {
  await import(`../../utils/capture/${name}.js`);
}

const runtimeApi = globalThis.OnStarvoiceCaptureTaskRuntime;
const expected = () => ({version: 1, taskId: 'task', attemptId: 'attempt-A', runId: 'run-A',
  debug: null, group: null, owner: null, runtime: null, workerTabIds: []});
const absent = () => ({taskId: 'task', strictResources: expected(), debugSnapshot: null,
  groupSnapshot: null, ownerSnapshot: null, runtimeSnapshot: {captureDebugSession: null},
  pendingWorkerTabIds: [], cleanupInProgress: false});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};

function resourceHarness() {
  const effects = [];
  const actual = {debug: null, group: null, owner: null, runtime: {captureDebugSession: null}};
  const state = {
    captureDebugSessionManager: {getSessionByTaskId: () => actual.debug,
      stopByTaskId: () => effects.push('detach')},
    captureTaskTabGroupManager: {getTask: () => actual.group, end: () => effects.push('ungroup')},
    captureTaskOwnerCoordinator: {getOwner: () => actual.owner, clearTask: () => effects.push('owner')},
    captureTaskPendingWorkerTabIds: new Map(), captureTaskCleanupInProgress: new Set(),
  };
  const ports = {
    chrome: {tabs: {remove: () => effects.push('remove'), sendMessage: () => effects.push('overlay')},
      storage: {local: {set: () => effects.push('storage'),
        get: async () => ({'strict.runtime': await actual.runtime})}}},
    console: {warn() {}, debug() {}}, setTimeout: () => effects.push('timer'),
    relayToContentWithRetry: () => effects.push('relay'), resolveCaptureTaskTabId: value => value,
    STORAGE_KEYS: {runtime: 'strict.runtime'},
    taskRuntimeApi: runtimeApi, readRuntimeState: async () => actual.runtime,
    writeRuntimeState: () => effects.push('runtime'),
    terminalizeCaptureTaskLedgerRun: () => effects.push('terminalize'),
  };
  const operations = {};
  Object.assign(operations, globalThis.OnStarvoiceCaptureLifecycleCleanup.create({state, ports, operations}));
  Object.assign(operations, globalThis.OnStarvoiceCaptureLifecycleAttempts.create({state, ports, operations}));
  return {actual, state, ports, effects, operations};
}

test('strict absence is explicitly an observation, never a completed release or future mutation lease', () => {
  assert.deepEqual(runtimeApi.inspectStrictResourceAbsence(absent()), {
    observed: true, released: false, rejected: false, strict: true, mutated: false,
    reason: 'strict_resources_absent', taskId: 'task', attemptId: 'attempt-A', runId: 'run-A',
  });
});

test('strict expectations are copied as frozen own-data snapshots without invoking accessors', () => {
  const original = expected(); const snapshot = runtimeApi.snapshotStrictResourceExpectation(original, 'task');
  assert.deepEqual(snapshot, original); assert.notEqual(snapshot, original);
  assert.notEqual(snapshot.workerTabIds, original.workerTabIds);
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.workerTabIds), true);
  for (const field of Object.keys(original)) {
    let reads = 0; const accessor = expected();
    Object.defineProperty(accessor, field, {get() {reads++; return original[field];}});
    assert.equal(runtimeApi.snapshotStrictResourceExpectation(accessor, 'task'), null);
    assert.equal(reads, 0);
  }
});

test('actual runtime session must be own explicit null, never missing, undefined, inherited or accessor', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'captureDebugSession', {get() {reads++; return null;}});
  for (const runtimeSnapshot of [{}, {captureDebugSession: undefined},
    Object.create({captureDebugSession: null}), accessor]) {
    const result = runtimeApi.inspectStrictResourceAbsence({...absent(), runtimeSnapshot});
    assert.equal(result.reason, 'strict_resource_inspection_unavailable');
    assert.equal(result.observed, false);
  }
  assert.equal(reads, 0);
});

for (const field of Object.keys(expected())) {
  test(`strict absence requires own explicit ${field}`, () => {
    const input = absent(); delete input.strictResources[field];
    assert.equal(runtimeApi.inspectStrictResourceAbsence(input).reason, 'strict_resource_identity_invalid');
    input.strictResources = Object.create(expected());
    assert.equal(runtimeApi.inspectStrictResourceAbsence(input).rejected, true);
  });
}

for (const value of [null, undefined, false, true, '', 1, [], {}]) {
  test(`explicit malformed strict envelope ${JSON.stringify(value)} cannot invoke legacy cleanup`, async () => {
    const h = resourceHarness(); h.actual.debug = {taskId: 'task', attemptId: 'attempt-B', tabId: 9};
    const result = await h.operations.releaseCaptureTaskResources({taskId: 'task', strictResources: value});
    assert.equal(result.rejected, true); assert.equal(result.mutated, false);
    assert.deepEqual(h.effects, []); assert.equal(h.state.captureTaskCleanupInProgress.size, 0);
  });
}

for (const [field, value] of [
  ['version', 2], ['taskId', 'other'], ['attemptId', ''], ['attemptId', ' attempt-A'],
  ['runId', 99], ['debug', {}], ['group', {}], ['owner', {}], ['runtime', {}], ['workerTabIds', [9]],
]) {
  test(`strict expected ${field}=${JSON.stringify(value)} fails closed`, () => {
    const input = absent(); input.strictResources[field] = value;
    assert.equal(runtimeApi.inspectStrictResourceAbsence(input).rejected, true);
  });
}

for (const field of ['debugSnapshot', 'groupSnapshot', 'ownerSnapshot', 'runtimeSnapshot',
  'pendingWorkerTabIds', 'cleanupInProgress']) {
  test(`missing actual ${field} is unknown, not empty`, () => {
    const input = absent(); delete input[field];
    assert.equal(runtimeApi.inspectStrictResourceAbsence(input).reason, 'strict_resource_inspection_unavailable');
  });
}

for (const field of ['debug', 'group', 'owner', 'runtime', 'worker', 'cleanup']) {
  test(`actual ${field} resource is preserved without runtime/overlay/owner/native writes`, async () => {
    const h = resourceHarness();
    if (field === 'worker') h.state.captureTaskPendingWorkerTabIds.set('task', [41]);
    else if (field === 'cleanup') h.state.captureTaskCleanupInProgress.add('task');
    else if (field === 'runtime') h.actual.runtime.captureDebugSession = {taskId: 'other-task'};
    else h.actual[field] = {taskId: 'task', attemptId: 'attempt-B'};
    const result = await h.operations.releaseCaptureTaskResourcesWithRetry({
      taskId: 'task', debugSnapshot: null, strictResources: expected(),
    }, {attempts: 3});
    assert.equal(result.reason, 'strict_active_resource_cleanup_unavailable');
    assert.equal(result.released, false); assert.deepEqual(h.effects, []);
  });
}

test('strict lifecycle re-reads manager ownership after runtime await, not supplied stale snapshots', async () => {
  const h = resourceHarness(); const gate = deferred(); h.actual.runtime = gate.promise;
  const pending = h.operations.releaseCaptureTaskResources({taskId: 'task', debugSnapshot: null, strictResources: expected()});
  h.actual.debug = {taskId: 'task', attemptId: 'attempt-B', tabId: 41};
  gate.resolve({captureDebugSession: null});
  assert.equal((await pending).rejected, true); assert.deepEqual(h.effects, []);
  assert.equal(h.actual.debug.attemptId, 'attempt-B');
});

test('strict expected identity is snapshotted before raw runtime await, not attributed to later caller edits', async () => {
  const h = resourceHarness(); const gate = deferred(); const envelope = expected(); h.actual.runtime = gate.promise;
  const pending = h.operations.releaseCaptureTaskResources({taskId: 'task', strictResources: envelope});
  envelope.attemptId = 'attempt-B'; envelope.runId = 'run-B'; envelope.workerTabIds.push(41);
  gate.resolve({captureDebugSession: null});
  const result = await pending;
  assert.equal(result.observed, true); assert.equal(result.attemptId, 'attempt-A');
  assert.equal(result.runId, 'run-A'); assert.equal(result.released, false);
  assert.deepEqual(h.effects, []);
});

test('strict lifecycle rejects an accessor envelope without reading it or raw storage', async () => {
  const h = resourceHarness(); let reads = 0;
  h.ports.chrome.storage.local.get = async () => {reads++; return {'strict.runtime': {captureDebugSession: null}};};
  const input = Object.defineProperty({taskId: 'task'}, 'strictResources', {get() {reads++; return expected();}});
  const result = await h.operations.releaseCaptureTaskResources(input);
  assert.equal(result.reason, 'strict_resource_identity_invalid'); assert.equal(reads, 0);
  assert.deepEqual(h.effects, []);
});

test('strict lifecycle reads raw persisted evidence and never substitutes the defaulting runtime reader', async () => {
  const h = resourceHarness(); let defaultReads = 0; let getters = 0;
  h.ports.readRuntimeState = async () => {defaultReads++; return {captureDebugSession: null};};
  const recordAccessor = Object.defineProperty({}, 'strict.runtime', {get() {getters++; return {captureDebugSession: null};}});
  const sessionAccessor = Object.defineProperty({}, 'captureDebugSession', {get() {getters++; return null;}});
  for (const stored of [{}, {'strict.runtime': undefined}, {'strict.runtime': {}},
    Object.create({'strict.runtime': {captureDebugSession: null}}), recordAccessor,
    {'strict.runtime': {captureDebugSession: undefined}}, {'strict.runtime': sessionAccessor},
    {'strict.runtime': Object.create({captureDebugSession: null})}]) {
    h.ports.chrome.storage.local.get = async key => {assert.equal(key, 'strict.runtime'); return stored;};
    const result = await h.operations.releaseCaptureTaskResources({taskId: 'task', strictResources: expected()});
    assert.equal(result.reason, 'strict_resource_inspection_unavailable');
    assert.equal(result.observed, false);
  }
  assert.equal(defaultReads, 0); assert.equal(getters, 0); assert.deepEqual(h.effects, []);
});

test('strict resource observation fails closed on a runtime read failure', async () => {
  const h = resourceHarness();
  h.actual.runtime = Promise.reject(new Error('synthetic read failure'));
  const result = await h.operations.releaseCaptureTaskResources({taskId: 'task', strictResources: expected()});
  assert.equal(result.reason, 'strict_resource_inspection_unavailable'); assert.deepEqual(h.effects, []);
});

test('both strict attempt wrappers preserve lock binding and ledger, even for absent resources', async () => {
  const h = resourceHarness();
  const first = await h.operations.releaseStableUnattendedCaptureTaskResourcesOnly(
    {unattended: true, taskId: 'task', request: {id: 'request'}}, {strictResources: expected()});
  const second = await h.operations.releaseUnattendedCaptureTaskResourcesForRecovery(
    {captureTaskId: 'task', captureTaskAttemptId: 'attempt-A'}, {strictResources: expected()});
  for (const result of [first, second]) {
    assert.equal(result.observed, true); assert.equal(result.released, false);
  }
  assert.deepEqual(h.effects, []);
});

test('strict worker and runtime end helpers reject before any supplied callback, even empty workers', async () => {
  const calls = []; const bad = () => calls.push('callback');
  for (const strictResources of [undefined, null, false, expected()]) {
    for (const workers of [[], [41]]) {
      const closed = await runtimeApi.closeWorkerTabsIndividually(workers, {strictResources, removeTab: bad});
      assert.equal(closed.rejected, true);
    }
    const ended = await runtimeApi.endTaskResources({taskId: 'task', strictResources,
      stopDebug: bad, endGroup: bad, closeWorkerTabs: bad});
    assert.equal(ended.rejected, true);
  }
  assert.deepEqual(calls, []);
});

function debugHarness() {
  const calls = []; const timers = new Map(); let id = 0;
  const manager = globalThis.OnStarvoiceCaptureDebugSession.createManager({
    debuggerApi: {attach: async () => calls.push('attach'), detach: async () => calls.push('detach'),
      sendCommand: async () => calls.push('focus')},
    setTimeoutFn: callback => {const key = ++id; timers.set(key, callback); return key;},
    clearTimeoutFn: key => {calls.push('clearTimer'); timers.delete(key);},
    onStateChange: async () => calls.push('publish'),
  });
  return {calls, timers, manager};
}

test('strict Debug stop preserves pending replacement timer, current session and native attachment', async () => {
  const h = debugHarness();
  await h.manager.start({tabId: 41, taskId: 'task', attemptId: 'attempt-B', runId: 'run-B', persistent: true});
  await h.manager.handleDetach({tabId: 41}, 'target_closed');
  const session = h.manager.getSession(41); const timers = [...h.timers.keys()]; h.calls.length = 0;
  for (const strictResources of [null, undefined, false, expected()]) {
    const result = await h.manager.stop({tabId: 41, taskId: 'task', force: true, strictResources});
    assert.equal(result.rejected, true); assert.deepEqual(h.manager.getSession(41), session);
  }
  assert.deepEqual([...h.timers.keys()], timers); assert.deepEqual(h.calls, []);
  assert.ok(timers.length > 0);
});

test('strict Debug compatibility wrappers do not fall back to force detach', async () => {
  const h = debugHarness();
  await h.manager.start({tabId: 41, taskId: 'task', attemptId: 'attempt-A', runId: 'run-A', persistent: true});
  h.calls.length = 0;
  assert.equal((await h.manager.stopByTaskId('task', 'stop', {strictResources: expected()})).rejected, true);
  assert.equal((await h.manager.stopByTab(41, 'stop', {strictResources: null})).rejected, true);
  assert.deepEqual(h.calls, []); assert.equal(h.manager.getSession(41).attemptId, 'attempt-A');
});

test('strict native group release queued after same-task replacement never ungroups replacement', async () => {
  const calls = []; let groupId = 0;
  const manager = globalThis.OnStarvoiceCaptureTaskTabGroup.createManager({
    tabsApi: {get: async id => ({id, windowId: 1, groupId: -1}),
      group: async () => {calls.push('group'); return ++groupId;}, ungroup: async () => calls.push('ungroup')},
    tabGroupsApi: {update: async () => calls.push('update')},
  });
  await manager.begin({taskId: 'task', attemptId: 'attempt-A', sourceTabId: 41});
  manager.forget('task');
  const newGroup = manager.begin({taskId: 'task', attemptId: 'attempt-B', sourceTabId: 41});
  const stopped = manager.end({taskId: 'task', attemptId: 'attempt-A', strictResources: expected()});
  await newGroup; calls.length = 0;
  assert.equal((await stopped).rejected, true);
  assert.equal(manager.getTask('task').attemptId, 'attempt-B'); assert.deepEqual(calls, []);
});

test('strict owner clear preserves replacement port and abandonment timer without taskId fallback', () => {
  const timers = new Map(); const calls = []; let id = 0;
  const coordinator = globalThis.OnStarvoiceCaptureTaskOwner.createCoordinator({
    setTimeoutFn: callback => {const key = ++id; timers.set(key, callback); return key;},
    clearTimeoutFn: key => {calls.push('clearTimer'); timers.delete(key);},
  });
  const port = () => ({name: globalThis.OnStarvoiceCaptureTaskOwner.OWNER_PORT_NAME,
    onMessage: {addListener() {}}, onDisconnect: {addListener() {}}});
  const a = port(); const b = port(); coordinator.attachPort(a); coordinator.attachPort(b);
  coordinator.bind(a, 'task'); coordinator.bind(b, 'task'); coordinator.handlePortDisconnect(b);
  const owner = coordinator.getOwner('task'); const timerIds = [...timers.keys()]; calls.length = 0;
  for (const strictResources of [undefined, null, false, expected()]) {
    assert.equal(coordinator.clearTask('task', {strictResources}).rejected, true);
    assert.deepEqual(coordinator.getOwner('task'), owner);
  }
  assert.deepEqual([...timers.keys()], timerIds); assert.deepEqual(calls, []);
});
