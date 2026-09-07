import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerController} from '../../sidebar/task-controller/owner.js';
import {createUnattendedRunController} from '../../sidebar/task-controller/unattended-run.js';

const control = Object.freeze({version: 1, requestId: 'request-1', attemptId: 'attempt-1',
  generation: 7, ownerDocumentId: 'owner-document-1'});
const candidate = {id: 'request-1', attemptId: 'attempt-1', strictControlCandidate: true};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return {promise, resolve};
}
function event() {
  const listeners = [];
  return {addListener: (fn) => listeners.push(fn), emit: (value) => {
    for (const fn of listeners) fn(value);
  }};
}
function harness({bind = null, relay = null} = {}) {
  const messages = [];
  const ports = [];
  let legacyCancel = 0;
  const state = {captureTaskOwnerTaskId: 'task-1', captureTaskOwnerPort: null,
    captureTaskOwnerClosing: false};
  const chromeApi = {
    runtime: {
      connect({name}) {
        const port = {name, onMessage: event(), onDisconnect: event(),
          postMessage: (message) => messages.push(message)};
        port.disconnect = () => port.onDisconnect.emit();
        ports.push(port);
        return port;
      },
      getURL: (path) => `chrome-extension://test/${path}`,
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'onstarvoice:strict-owner-bind') {
          return bind ? bind(message) : {ok: true, data: {strictControl: control, scopeMode: 'cooperative'}};
        }
        if (message.type === 'onstarvoice:update-unattended-keyword-run') return {ok: true, accepted: true};
        if (message.type === 'onstarvoice:strict-page-operation') {
          if (message.kind === 'platform-source') return {ok: true,
            result: {ok: true, data: {tabId: 9, platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore'}}};
          if (message.kind === 'relay') return relay ? relay(message) : {
            ok: true, result: {ok: true, data: {ok: true, data: {
              noteId: 'note-1', title: 'synthetic sample', content: 'synthetic body',
            }}},
          };
          return {ok: true, result: {id: message.tabId, status: 'complete'}};
        }
        return {ok: true};
      },
    },
    tabs: {get: async (id) => ({id, status: 'complete'}), query: async () => []},
    scripting: {executeScript: () => { throw new Error('unregistered native injection'); }},
  };
  const controllerPorts = {
    chrome: chromeApi, console: {warn() {}, debug() {}}, setTimeout,
    CAPTURE_TASK_OWNER_PORT_NAME: 'legacy-owner', MESSAGE_TYPE: {RELAY_TO_CONTENT: 'RELAY_TO_CONTENT'},
    getCurrentRuntime: () => ({}), setCancelFlag: () => { legacyCancel += 1; },
    showMessage() {}, showProgress() {}, wait: async () => {},
  };
  const operations = {normalizeRepresentativeSampleItems: (items) => [...items],
    requestDetailRunnerCancelSignals: async () => { legacyCancel += 1; }};
  const owner = createOwnerController({controllerState: state, controllerPorts,
    controllerOperations: operations});
  Object.assign(operations, owner);
  return {owner, state, operations, controllerPorts, messages, ports,
    legacyCancel: () => legacyCancel};
}

test('only explicitly admitted candidate owns a private control port; no legacy fallback on denial', async () => {
  const h = harness();
  await assert.rejects(h.owner.runStrictCaptureProducer({...candidate, strictControlCandidate: false}, () => {}),
    {code: 'strict_capture_candidate_required'});
  assert.equal(h.ports.length, 0);
  let started = false;
  const denied = harness({bind: () => ({ok: false, error: {code: 'source_changed'}})});
  await assert.rejects(denied.owner.runStrictCaptureProducer(candidate, () => { started = true; }),
    {code: 'source_changed'});
  assert.equal(started, false);
  assert.equal(denied.ports[0].name, 'onstarvoice:strict-capture-owner-v1');
  assert.equal(denied.messages.some((message) => message.type === 'capture-owner:bind'), false);
});

test('strict stop requires exact attempt, generation and owner document and never changes legacy cancel flags', async () => {
  const h = harness();
  const pending = deferred();
  const work = h.owner.runStrictCaptureProducer(candidate, async (scope) => {
    await pending.promise;
    return scope.client.shouldStop();
  });
  await tick();
  for (const mismatch of [{attemptId: 'old'}, {generation: 6}, {ownerDocumentId: 'old-owner'}]) {
    h.ports[0].onMessage.emit({type: 'capture-owner:strict-stop', strictControl: {...control, ...mismatch}});
    assert.equal(h.owner.isStrictCaptureOwnerStopped(), false);
  }
  h.owner.applyCaptureTaskCancellation({taskId: 'task-1', reason: 'legacy'});
  assert.equal(h.legacyCancel(), 0);
  h.ports[0].onMessage.emit({type: 'capture-owner:strict-stop', strictControl: control});
  await tick();
  assert.equal(h.owner.isStrictCaptureOwnerStopped(), true);
  assert.equal(h.messages.some((m) => m.type === 'onstarvoice:strict-owner-settled'), false);
  pending.resolve();
  assert.equal(await work, true);
  assert.equal(h.legacyCancel(), 0);
  assert.equal(h.messages.some((m) => m.type === 'onstarvoice:strict-owner-settled' && m.runnerQuiesced), true);
});

test('real keyword sample producer waits for its checkpoint then blocks finally navigation after stop', async () => {
  const h = harness();
  const checkpoint = deferred();
  const checkpointStarted = deferred();
  const work = h.owner.runStrictCaptureProducer(candidate, (scope) =>
    scope.operations.captureKeywordOpportunitySamples({
      sourceTabId: 9, sourceTabUrl: 'https://example.test/search',
      sampleItems: [{noteId: 'note-1', url: 'https://example.test/note-1'}],
      onSampleCaptured: async () => {
        checkpointStarted.resolve();
        await checkpoint.promise;
      },
    }));
  await checkpointStarted.promise;
  const beforeStop = h.messages.filter((m) => m.kind === 'navigate').length;
  assert.equal(beforeStop, 1);
  h.ports[0].onMessage.emit({type: 'capture-owner:strict-stop', strictControl: control});
  await tick();
  assert.equal(h.messages.some((m) => m.type === 'onstarvoice:strict-owner-settled'), false);
  checkpoint.resolve();
  const samples = await work;
  assert.equal(samples[0].noteId, 'note-1');
  assert.equal(h.messages.filter((m) => m.kind === 'navigate').length, beforeStop);
  assert.equal(h.messages.filter((m) => m.kind === 'relay').length, 1);
  assert.equal(h.messages.some((m) => m.type === 'onstarvoice:strict-owner-release'), true);
});

test('owner disconnection freezes the same generation and never schedules a reconnect', async () => {
  const h = harness();
  const pending = deferred();
  const work = h.owner.runStrictCaptureProducer(candidate, async (scope) => {
    await pending.promise;
    assert.equal(scope.client.shouldStop(), true);
  });
  await tick();
  h.ports[0].onDisconnect.emit();
  h.owner.connectCaptureTaskOwnerPort();
  assert.equal(h.ports.length, 1);
  pending.resolve();
  await work;
});

test('unattended real entry accepts the running report before strict bind and producer dispatch', async () => {
  const calls = [];
  const h = harness();
  const request = {...candidate, planSnapshot: {keywords: ['keyword-1'], platform: 'xiaohongshu'}};
  h.state.activeUnattendedRunRequestId = request.id;
  h.state.activeUnattendedRunAttemptId = request.attemptId;
  const report = {accepted: true, data: {...request, status: 'running'}};
  Object.assign(h.controllerPorts, {
    MAX_BATCH_KEYWORDS: 50,
    getKeywordExecutionCopy: () => ({taskLabel: 'fixture task', captureLabel: 'fixture capture', executionMode: 'local'}),
    normalizeUnattendedSearchPasses: () => [],
    normalizeUnattendedKeywordCheckpoint: () => ({round: 1, keywordResults: []}),
    findUnattendedResumeKeyword: () => 'keyword-1',
    summarizeUnattendedKeywordCheckpoint: () => ({}),
  });
  const operations = {...h.operations,
    dedupeKeywords: (values) => [...values],
    supportsPersistentCaptureTaskPlatform: () => true,
    rememberCaptureTaskProgressContext() {},
    reportInitialUnattendedKeywordRun: async (id, patch, identity) => {
      assert.equal(id, request.id);
      assert.equal(identity.attemptId, request.attemptId);
      assert.equal(patch.status, 'running');
      calls.push('running-accepted');
      return report;
    },
    runStrictCaptureProducer: async (actual, invoke, kind, continuation) => {
      assert.equal(actual, request);
      assert.equal(kind, 'unattended-keyword-producer');
      assert.equal(continuation.startReport, report);
      assert.equal(calls.at(-1), 'running-accepted');
      return h.owner.runStrictCaptureProducer(actual, async (scope) => {
        calls.push('strict-producer');
        assert.equal(scope.ports.strictCaptureContinuation.startReport, report);
        return scope.operations.captureKeywordOpportunitySamples({
          sourceTabId: 9, sourceTabUrl: 'https://example.test/search',
          sampleItems: [{noteId: 'note-1', url: 'https://example.test/note-1'}],
        });
      }, kind, continuation);
    },
  };
  const runner = createUnattendedRunController({controllerState: h.state,
    controllerPorts: h.controllerPorts, controllerOperations: operations});
  const result = await runner.runUnattendedKeywordPlanRequest(request);
  assert.equal(result[0].noteId, 'note-1');
  assert.deepEqual(calls, ['running-accepted', 'strict-producer']);
  assert.equal(h.messages[0].type, 'onstarvoice:strict-owner-bind');
  assert.equal(h.messages[1].type, 'onstarvoice:strict-owner-activity-begin');
});

test('a stop racing the bind response is latched before any producer dispatch', async () => {
  const admission = deferred();
  const h = harness({bind: () => admission.promise});
  let started = false;
  const work = h.owner.runStrictCaptureProducer(candidate, () => { started = true; });
  h.ports[0].onMessage.emit({type: 'capture-owner:strict-stop', strictControl: control});
  admission.resolve({ok: true, data: {strictControl: control, scopeMode: 'cooperative'}});
  await assert.rejects(work, {code: 'capture_strict_stopped'});
  assert.equal(started, false);
  assert.equal(h.messages.some((m) => m.type === 'onstarvoice:strict-owner-activity-begin'), false);
});

test('actual accepted report cannot lose its fire-and-forget checkpoint flush before owner drain', async () => {
  const h = harness();
  const flush = deferred();
  const entered = deferred();
  let flushEnded = false;
  Object.assign(h.controllerPorts, {
    clearTimeout, UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS: 10000,
    flushUnattendedCheckpointReportOutbox: async () => {
      entered.resolve();
      await flush.promise;
      flushEnded = true;
      return {ok: true, retained: 0};
    },
  });
  const producer = h.owner.runStrictCaptureProducer(candidate, scope =>
    scope.operations.reportUnattendedKeywordRun(candidate.id, {status: 'running'}, {attemptId: candidate.attemptId}));
  await entered.promise;
  h.ports[0].onMessage.emit({type: 'capture-owner:strict-stop', strictControl: control});
  await tick();
  assert.equal(flushEnded, false);
  assert.ok(h.state.unattendedCheckpointOutboxFlushPromise);
  assert.equal(h.messages.some(message => message.type === 'onstarvoice:strict-owner-settled'), false);
  flush.resolve();
  assert.equal((await producer).accepted, true);
  assert.equal(flushEnded, true);
  assert.equal(h.messages.some(message => message.type === 'onstarvoice:strict-owner-settled' && message.runnerQuiesced), true);
});

test('all existing checkpoint and reserve ports keep their true Promise and can finish after stop without extra calls', async () => {
  const h = harness();
  const write = deferred();
  const invoked = deferred();
  const calls = [];
  const names = ['flushUnattendedCheckpointReportOutbox', 'enqueueUnattendedCheckpointReport',
    'discardUnattendedCheckpointReports', 'ensureControlStorageReserve', 'releaseControlStorageReserve'];
  for (const name of names) h.controllerPorts[name] = (...args) => { calls.push([name, args]); return write.promise; };
  const producer = h.owner.runStrictCaptureProducer(candidate, scope => {
    scope.client.stop(control);
    const results = names.map(name => scope.ports[name]({requestId: candidate.id}));
    for (const result of results) assert.equal(result, write.promise);
    invoked.resolve();
    return results.length; // Deliberately do not await: drain owns the real port work.
  });
  await invoked.promise;
  await tick();
  assert.equal(h.messages.some(message => message.type === 'onstarvoice:strict-owner-settled'), false);
  assert.deepEqual(calls.map(([name]) => name), names);
  write.resolve({ok: true});
  assert.equal(await producer, 5);
  assert.equal(calls.length, 5, 'no replay/new write is introduced by tracking');
});

test('actual batch startup reads sort through its private controller and owned source, never the user active tab', async () => {
  const h = harness({relay: () => ({ok: true,
    result: {ok: true, data: {ok: true, data: {dimension: 'collects', source: 'page'}}}})});
  let rawQueries = 0;
  let legacySortCalls = 0;
  let passedSort = false;
  h.controllerPorts.chrome.tabs.query = async () => { rawQueries += 1; return [{id: 666}]; };
  Object.assign(h.state, {activeUnattendedRunRequestId: candidate.id,
    activeUnattendedRunAttemptId: candidate.attemptId, keywordSortDimension: 'likes'});
  Object.assign(h.controllerPorts, {
    MAX_BATCH_KEYWORDS: 50, PAGE_TYPE: {SEARCH_RESULTS: 'search'},
    KEYWORD_SORT_DIMENSION: {LIKES: 'likes', COMMENTS: 'comments', COLLECTS: 'collects'},
    getCurrentRuntime: () => ({pageType: 'search', lastPageUrl: 'https://www.xiaohongshu.com/search_result?keyword=test'}),
    getViewPlatform: () => 'xiaohongshu', getPagePlatform: () => 'xiaohongshu',
    detectPlatformFromUrl: () => 'xiaohongshu', getPlatformCapabilities: () => ({captureSearch: true}),
    getBatchKeywordsFromTextarea: () => ['keyword-1'], normalizeUnattendedSearchPasses: () => [],
    getCaptureSettings: async () => ({}), resolveCurrentDetailCaptureSettings: settings => settings,
    ensureAuthVerifiedOrWarn: async () => true,
    updateBatchKeywordInputState() {}, persistCurrentBatchDraft() {}, setBatchProgressDetail() {},
    taskView: {applyKeywordSortDimensionToUI() {}, showBatchKeywordIdle() {}},
    readKeywordMinLikesFromInput() { passedSort = true; throw new Error('bounded_after_registered_sort'); },
    hasSyncReconciliationSignal: () => false,
    console: {warn() {}, error() {}},
    syncKeywordSortDimensionFromPage: () => { legacySortCalls += 1; throw new Error('legacy sort escape'); },
    setInterval: () => { throw new Error('sort timer must not be started'); },
  });
  h.operations.dedupeKeywords = values => [...values];
  const result = await h.owner.runStrictCaptureProducer(candidate, async scope => {
    await scope.ports.chrome.runtime.sendMessage({type: 'onstarvoice:switch-platform-tab', platform: 'xiaohongshu'});
    // Only task-lock I/O and UI cleanup are synthetic. The actual batch body,
    // original sort factory, private query and registered relay all execute.
    scope.operations.acquireCaptureExecutionLock = async () => ({id: 'fixture-lock'});
    scope.operations.createStreamingDetailAutoSyncQueue = () => null;
    scope.operations.releaseCaptureExecutionLock = async () => true;
    scope.operations.clearCaptureTaskProgressContext = () => {};
    return scope.operations.handleBatchKeywordCapture({executionLockOwner: 'unattended_keyword_plan',
      unattendedRequestId: candidate.id, unattendedAttemptId: candidate.attemptId,
      captureTaskContext: {taskId: candidate.id}, sourceTabId: 9});
  });
  assert.equal(passedSort, true, JSON.stringify(result));
  assert.equal(result.error, 'bounded_after_registered_sort');
  assert.equal(h.state.keywordSortDimension, 'collects');
  assert.equal(rawQueries, 0);
  assert.equal(legacySortCalls, 0);
  const relays = h.messages.filter(message => message.kind === 'relay');
  assert.equal(relays.length, 1);
  assert.equal(relays[0].tabId, 9);
  assert.equal(relays[0].payload.action, 'detectSearchSortDimension');
  assert.deepEqual(relays[0].strictControl, control);
});
