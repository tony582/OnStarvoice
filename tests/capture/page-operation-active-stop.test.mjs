import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {
  createPageOperationClient,
  parsePageOperationOwnerControl,
} from '../../utils/capture/page-operation-client.js';
import {createCaptureSyncScope} from '../../utils/capture-sync.js';
import {closeOwnedDetailRunnerTabs, createDedicatedDetailRunnerTab, normalizeDetailRunnerMode, DETAIL_RUNNER_MODE} from '../../utils/capture/detail-runner.js';
import {parseSidebarAst, findSidebarFunctionAst} from '../helpers/sidebar-controller-ast.mjs';
import {detectPlatformFromUrl, detectPageType} from '../../utils/helpers.js';
import {PAGE_TYPE} from '../../utils/constants.js';
import {createUnattendedReportingAndClosureController} from '../../sidebar/task-controller/unattended-reporting-and-closure.js';

const control = Object.freeze({version: 1, requestId: 'request-1', attemptId: 'attempt-1',
  generation: 3, ownerDocumentId: 'owner-document-1'});
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('actual dedicated-runner preparation bootstraps only the verified cohort HTTPS source through registered create', async () => {
  const sourceUrl = 'https://www.xiaohongshu.com/explore';
  const h = harness({admit: message => {
    if (message.kind === 'platform-source') return {ok: true,
      result: {ok: true, data: {tabId: 9, url: sourceUrl, platform: 'xiaohongshu'}}};
    if (message.kind === 'create') {
      assert.equal(message.payload.url, sourceUrl);
      assert.equal(message.payload.active, false);
      return {ok: true, result: {id: 10, url: message.payload.url, active: false}};
    }
    return {ok: true, ...grant(message)};
  }});
  assert.throws(() => h.client.chromeApi.tabs.create({url: 'about:blank'}), {code: 'strict_source_bootstrap_required'});
  assert.equal(h.messages.length, 0);
  await h.client.chromeApi.runtime.sendMessage({type: 'onstarvoice:switch-platform-tab', platform: 'xiaohongshu'});
  const source = readFileSync(new URL('../../utils/capture-sync.js', import.meta.url), 'utf8');
  const ast = parseSidebarAst(source);
  const realBodies = ['getTabScrollY', 'prepareDetailBatchRunnerContext'].map(name =>
    source.slice(...findSidebarFunctionAst(ast, name).range)).join('\n');
  const prepare = vm.runInNewContext(`${realBodies}\nprepareDetailBatchRunnerContext;`, {
    chrome: h.client.chromeApi, createDedicatedDetailRunnerTab,
    normalizeDetailRunnerMode, DETAIL_RUNNER_MODE, detectPlatformFromUrl, detectPageType, PAGE_TYPE,
  });
  const result = await prepare({sourceTab: {id: 9, url: sourceUrl, windowId: 2, index: 3},
    runnerMode: DETAIL_RUNNER_MODE.DEDICATED_TAB});
  assert.equal(result.runnerTabId, 10);
  assert.equal(result.sourceTabId, 9);
  assert.equal(result.ownsRunnerTab, true);
  const created = h.messages.filter(message => message.kind === 'create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].payload, {url: sourceUrl, active: false, windowId: 2, index: 4});
  assert.deepEqual((await h.client.chromeApi.tabs.query({active: true, currentWindow: true})).map(tab => tab.id), [9]);
  assert.deepEqual((await h.client.chromeApi.tabs.query({currentWindow: true})).map(tab => tab.id), [9, 10]);
});

test('actual final checkpoint flush completes storage and closure after stop and keeps the true drain pending', async () => {
  const writes = [];
  const firstWrite = deferred();
  const firstWriteEntered = deferred();
  const flush = deferred();
  const flushEntered = deferred();
  const stored = {'synthetic.request': {id: control.requestId, attemptId: control.attemptId, status: 'completed'}};
  const area = {
    async get(keys) {
      assert.equal(this, area);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]]));
    },
    async set(values) {
      assert.equal(this, area);
      writes.push(['set', values]);
      if (writes.length === 1) { firstWriteEntered.resolve(); await firstWrite.promise; }
      Object.assign(stored, values);
    },
    async remove(key) { assert.equal(this, area); writes.push(['remove', key]); delete stored[key]; },
    async getBytesInUse() { assert.equal(this, area); return 123; },
    clear() { throw new Error('no storage clear capability is authorized'); },
  };
  const h = harness({storage: {local: area}});
  assert.deepEqual(Object.keys(h.client.chromeApi.storage.local).sort(), ['get', 'getBytesInUse', 'remove', 'set']);
  const operations = createUnattendedReportingAndClosureController({
    controllerState: {unattendedFinalFlushInFlightByIdentity: new Map(),
      unattendedFinalFlushRetryTimersByIdentity: new Map(), unattendedCheckpointOutboxFlushPromise: null},
    controllerOperations: {},
    controllerPorts: {
      chrome: h.client.chromeApi, console: {warn() {}}, setTimeout, clearTimeout,
      KEYWORD_PLAN_TERMINAL_STATUSES: new Set(['completed']),
      KEYWORD_RUN_REQUEST_STORAGE_KEY: 'synthetic.request',
      UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX: 'synthetic.intent.',
      UNATTENDED_FINAL_FLUSH_INTENT_VERSION: 1,
      UNATTENDED_LOCAL_CLOSURE_READY_STORAGE_PREFIX: 'synthetic.ready.',
      UNATTENDED_LOCAL_CLOSURE_READY_VERSION: 1,
      UNATTENDED_FINAL_FLUSH_RETRY_DELAYS_MS: [0],
      UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS: [0],
      UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS: 10000,
      flushUnattendedCheckpointReportOutbox: async () => { flushEntered.resolve(); await flush.promise; return {ok: true, retained: 0}; },
      isStorageQuotaError: () => false,
    },
  });
  const producer = h.client.runProducer('unattended-final-flush', () =>
    operations.finalizeUnattendedLocalClosureAfterFlush(control.requestId, control.attemptId));
  await firstWriteEntered.promise;
  h.client.stop(control);
  let drained = false;
  const draining = h.client.drain().then(receipt => { drained = true; return receipt; });
  await tick();
  assert.equal(drained, false, 'an already-issued checkpoint write is still real work');
  firstWrite.resolve();
  await flushEntered.promise;
  await tick();
  assert.equal(drained, false, 'the real final-flush producer must finish, not merely its first write');
  flush.resolve();
  assert.equal((await producer).ok, true);
  assert.equal((await draining).runnerQuiesced, true);
  const identity = `${control.requestId}.${control.attemptId}`;
  assert.equal(stored[`synthetic.ready.${identity}`].requestId, control.requestId);
  assert.equal(Object.hasOwn(stored, `synthetic.intent.${identity}`), false);
  assert.deepEqual(writes.map(([kind]) => kind), ['set', 'set', 'remove']);
  assert.equal(await h.client.chromeApi.storage.local.getBytesInUse(null), 123,
    'read-only diagnostics remain available after stop');
  const finalized = h.messages.find(message => message.type === 'onstarvoice:finalize-unattended-local-closure');
  assert.equal(finalized.flushReady, true);
  assert.deepEqual(finalized.strictControl, control);
});

test('actual interrupted-worker rebuild cannot close through global chrome after stop interleaves its prefetch wait', async () => {
  const source = readFileSync(new URL('../../utils/capture-sync.js', import.meta.url), 'utf8');
  const matches = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.name === 'recreateInterruptedDetailRunners') matches.push(node.init);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parseSidebarAst(source));
  assert.equal(matches.length, 1, 'the actual single rebuild producer');
  const h = harness();
  const prefetch = deferred();
  let nativeCloses = 0;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {configurable: true, value: {
    tabs: {remove: async () => { nativeCloses += 1; throw new Error('unregistered native close'); }},
  }});
  try {
    const rebuild = vm.runInNewContext(`(${source.slice(...matches[0].range)})`, {
      chrome: h.client.chromeApi,
      closeOwnedDetailRunnerTabs,
      uniqueRecordIds: ['record-1'],
      detailRunnerRecoveryAttemptsByRecordId: new Map(),
      detailRunnerRecoveryCount: 0,
      DETAIL_RUNNER_RECREATE_MAX_PER_BATCH: 2,
      DETAIL_RUNNER_RECREATE_MAX_PER_ITEM: 1,
      shouldStopDetailBatch: () => h.client.shouldStop(),
      runnerContexts: [{runnerTabId: 99, sourceTabId: 9, ownsRunnerTab: true}],
      detailPrefetchPipeline: {stop: () => prefetch.promise},
      console: {warn() {}},
    });
    const rebuilding = h.client.track(rebuild({recordId: 'record-1', recordPlatform: 'xiaohongshu'}));
    h.client.stop(control);
    prefetch.resolve();
    assert.equal(await rebuilding, false);
    assert.equal(nativeCloses, 0, 'no global tabs.remove escape');
    assert.equal(h.messages.some(message => message.kind === 'remove'), false,
      'stop freezes even the registered removal admission');
    assert.deepEqual((await h.client.drain()).retainedTabs, [99]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
    else delete globalThis.chrome;
  }
});

function harness({admit = null, execute = async () => [{result: 'injected'}], settle = null, storage = null} = {}) {
  const messages = [];
  const injections = [];
  let sequence = 0;
  const chromeApi = {
    ...(storage ? {storage} : {}),
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'onstarvoice:strict-page-operation') {
          if (admit) return admit(message);
          return {ok: true, ...grant(message)};
        }
        if (message.type === 'onstarvoice:strict-operation-settled' && settle) {
          return settle(message);
        }
        return {ok: true};
      },
    },
    tabs: {get: async (id) => ({id, status: 'complete'}), query: async () => []},
    scripting: {executeScript: async (details) => {
      injections.push(details); return execute(details);
    }},
    windows: {update: () => { throw new Error('raw window mutation forbidden'); }},
  };
  const client = createPageOperationClient({strictControl: control, chromeApi,
    createId: () => `operation-${++sequence}`});
  return {client, messages, injections, chromeApi};
}
function grant(message) {
  return {pageControl: {...control, operationId: message.operationId,
    documentId: 'page-document-1', activationId: 'activation-1'}};
}

test('strict owner control rejects inherited, accessor, malformed and old-generation identities', () => {
  assert.equal(parsePageOperationOwnerControl(Object.create(control)), null);
  assert.equal(parsePageOperationOwnerControl({...control, generation: '3'}), null);
  assert.equal(parsePageOperationOwnerControl({...control, requestId: ' request-1'}), null);
  assert.equal(parsePageOperationOwnerControl({...control, get attemptId() { throw new Error('read'); }}), null);
  const h = harness();
  assert.equal(h.client.stop({...control, generation: 2}), false);
  assert.equal(h.client.shouldStop(), false);
  assert.equal(h.client.stop(control), true);
});

test('native injection is document-bound and drain waits for its actual unresolved Promise', async () => {
  const pending = deferred();
  const h = harness({execute: () => pending.promise});
  const original = globalThis.chrome;
  const sentinel = {};
  globalThis.chrome = sentinel;
  try {
    const work = h.client.chromeApi.scripting.executeScript({
      target: {tabId: 8, frameIds: [0]}, func: () => 1,
    });
    await tick();
    assert.deepEqual(h.injections[0].target, {tabId: 8, documentIds: ['page-document-1']});
    h.client.stop(control);
    let drained = false;
    const drain = h.client.drain().then((value) => { drained = true; return value; });
    await tick();
    assert.equal(drained, false);
    assert.equal(globalThis.chrome, sentinel, 'never monkey-patches global chrome');
    assert.throws(() => h.client.chromeApi.tabs.update(8, {url: 'https://example.test/next'}),
      {code: 'capture_strict_stopped'});
    pending.resolve([{result: 1}]);
    assert.deepEqual(await work, [{result: 1}]);
    assert.equal((await drain).runnerQuiesced, true);
    assert.equal(h.messages.filter((m) => m.type.endsWith('operation-settled')).length, 1);
  } finally { globalThis.chrome = original; }
});

test('stop during admission never dispatches a late script but still settles the granted slot', async () => {
  const pending = deferred();
  const h = harness({admit: () => pending.promise});
  const work = h.client.chromeApi.scripting.executeScript({target: {tabId: 8}, func: () => 1});
  await tick();
  h.client.stop(control);
  pending.resolve({ok: true, ...grant(h.messages[0])});
  await assert.rejects(work, {code: 'capture_strict_stopped'});
  assert.equal(h.injections.length, 0);
  assert.equal(h.messages.at(-1).outcome, 'rejected_before_dispatch');
  assert.equal((await h.client.drain()).runnerQuiesced, true);
});

test('wrong document grant identity is quarantined without native injection or false drain', async () => {
  const h = harness({admit: (message) => ({ok: true,
    pageControl: {...grant(message).pageControl, generation: 4}})});
  await assert.rejects(h.client.chromeApi.scripting.executeScript({target: {tabId: 8}, func: () => 1}),
    {code: 'strict_page_operation_grant_mismatch'});
  assert.equal(h.injections.length, 0);
  assert.equal((await h.client.drain()).runnerQuiesced, false);
});

test('native rejection settles once and settlement failure remains unconfirmed', async () => {
  const h = harness({execute: async () => { throw new Error('native rejected'); }});
  await assert.rejects(h.client.chromeApi.scripting.executeScript({target: {tabId: 8}}), /native rejected/);
  assert.equal(h.messages.at(-1).outcome, 'rejected');
  assert.equal((await h.client.drain()).runnerQuiesced, true);
  const failed = harness({settle: () => ({ok: false})});
  await assert.rejects(failed.client.chromeApi.scripting.executeScript({target: {tabId: 8}}),
    {code: 'strict_operation_settlement_unconfirmed'});
  assert.equal((await failed.client.drain()).runnerQuiesced, false);
});

test('backend relay Promise stays tracked after stop and is not repeated by the client', async () => {
  const pending = deferred();
  const h = harness({admit: () => pending.promise});
  const work = h.client.chromeApi.runtime.sendMessage({type: 'RELAY_TO_CONTENT', tabId: 8,
    payload: {action: 'captureSingleNote'}});
  await tick();
  h.client.stop(control);
  let drained = false;
  const drain = h.client.drain().then(() => { drained = true; });
  await tick();
  assert.equal(drained, false);
  pending.resolve({ok: true, result: {ok: true, data: {ok: true, value: 'saved'}}});
  assert.deepEqual(await work, {ok: true, data: {ok: true, value: 'saved'}});
  await drain;
  assert.equal(h.messages.length, 1);
  assert.equal(h.injections.length, 0);
});

test('a background-retained tab cannot be reported as successful legacy worker cleanup', async () => {
  const h = harness({admit: () => ({ok: true, result: {retained: true, removed: false}})});
  await assert.rejects(h.client.chromeApi.tabs.remove(8), {code: 'strict_owned_tab_retained'});
  assert.deepEqual((await h.client.drain()).retainedTabs, [8]);
  await assert.rejects(h.client.chromeApi.windows.update(1, {focused: true}),
    {code: 'strict_window_focus_unsupported'});
});

test('producer drain waits for save/checkpoint finally and children added before stop', async () => {
  const checkpoint = deferred();
  const child = deferred();
  const h = harness();
  const work = h.client.runProducer('actual-runner', async () => {
    h.client.track(child.promise);
    try { return 'captured'; } finally { await checkpoint.promise; }
  });
  await tick();
  h.client.stop(control);
  let drained = false;
  const drain = h.client.drain().then((result) => { drained = true; return result; });
  checkpoint.resolve();
  assert.equal(await work, 'captured');
  await tick();
  assert.equal(drained, false);
  child.resolve();
  assert.equal((await drain).runnerQuiesced, true);
  assert.equal(h.messages.at(-1).type, 'onstarvoice:strict-owner-activity-end');
});

test('real capture-sync exported helpers share no global browser port with strict scope', async () => {
  const h = harness({admit: (message) => ({ok: true, result: {
    ok: true, data: {ok: false, error: {code: 'synthetic_page_result'}},
  }})});
  const api = createCaptureSyncScope({chromeApi: h.client.chromeApi, pageOperations: h.client});
  const result = await api.captureTabContent(8, {mode: 'single'});
  assert.equal(result.error.code, 'synthetic_page_result');
  assert.equal(h.messages[0].kind, 'relay');
  assert.equal(h.messages[0].strictControl.generation, 3);
  assert.equal(h.messages[0].payload.action, 'captureSingleNote');
  h.client.stop(control);
  await assert.rejects(api.captureTabContent(8, {mode: 'single'}), {code: 'capture_strict_stopped'});
});

test('operation and activity admission sequence numbers remain ordered and end with their exact original sequence', async () => {
  const admission = deferred();
  const h = harness({admit: (message) => message.operationSeq === 1
    ? admission.promise : {ok: true, ...grant(message)}});
  const first = h.client.chromeApi.scripting.executeScript({target: {tabId: 8}, func: () => 1});
  const second = h.client.chromeApi.scripting.executeScript({target: {tabId: 9}, func: () => 2});
  await tick();
  assert.deepEqual(h.messages.filter(m => m.kind === 'executeScript').map(m => m.operationSeq), [1]);
  admission.resolve({ok: true, ...grant(h.messages[0])});
  await Promise.all([first, second]);
  assert.deepEqual(h.messages.filter(m => m.kind === 'executeScript').map(m => m.operationSeq), [1, 2]);
  assert.deepEqual(h.messages.filter(m => m.type.endsWith('operation-settled')).map(m => m.operationSeq).sort(), [1, 2]);
  await Promise.all([h.client.runProducer('first', async () => 1), h.client.runProducer('second', async () => 2)]);
  assert.deepEqual(h.messages.filter(m => m.type.endsWith('activity-begin')).map(m => m.activitySeq), [1, 2]);
  assert.deepEqual(h.messages.filter(m => m.type.endsWith('activity-end')).map(m => m.activitySeq).sort(), [1, 2]);
});

test('private platform switching is one registered source operation, never a legacy background switch', async () => {
  const h = harness({admit: () => ({ok: true, result: {ok: true,
    data: {tabId: 17, url: 'https://www.douyin.com/', platform: 'douyin'}}})});
  const result = await h.client.chromeApi.runtime.sendMessage({type: 'onstarvoice:switch-platform-tab', platform: 'douyin'});
  assert.equal(result.data.tabId, 17);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].kind, 'platform-source');
  assert.equal(h.messages[0].payload.platform, 'douyin');
});

test('a real capture entry cannot lose an async progress checkpoint when its own setup already failed', async () => {
  const h = harness();
  const checkpoint = deferred();
  let progressCalls = 0;
  const api = createCaptureSyncScope({chromeApi: h.client.chromeApi, pageOperations: h.client});
  // No browser/storage is installed in this synthetic test. The original setup
  // fails before any content collection, after its first progress callback.
  await api.captureAndSync({autoSync: false, mode: 'synthetic-unsupported',
    onProgress: () => { progressCalls += 1; return checkpoint.promise; },
  }).catch(() => undefined);
  assert.ok(progressCalls > 0);
  h.client.stop(control);
  let drained = false;
  const drain = h.client.drain().then(() => { drained = true; });
  await tick();
  assert.equal(drained, false);
  checkpoint.resolve();
  await drain;
  assert.equal(h.messages.some(m => m.kind === 'relay'), false);
});
