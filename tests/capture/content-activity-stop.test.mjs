import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createContentActivityRegistry} from '../../utils/capture/content-activity.js';

const source = readFileSync(new URL('../../content-v2.js', import.meta.url), 'utf8');
const scrollSource = readFileSync(new URL('../../utils/scroll.js', import.meta.url), 'utf8');
const cohort = Object.freeze({version: 1, requestId: 'request-a', attemptId: 'attempt-a',
  generation: 1, ownerDocumentId: 'owner-a', documentId: 'document-a'});
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function registry() {
  return createContentActivityRegistry({createActivationId: () => 'activation-a'});
}
function activate(activity) {
  const state = activity.handshake(cohort);
  return {...state.scope, operationId: 'operation-a'};
}

test('anonymous legacy activity and its detached child both prevent strict admission', async () => {
  const activity = registry();
  const child = deferred();
  await activity.runLegacy(() => {
    activity.trackChild(child.promise, {kind: 'detached'});
    return 'response already returned';
  });
  assert.equal(activity.inspect().topLevelCount, 0);
  assert.equal(activity.inspect().childCount, 1);
  assert.throws(() => activity.handshake(cohort), /PAGE_CONTROL_PAGE_BUSY/u);
  child.resolve();
  await tick();
  assert.equal(activate(activity).activationId, 'activation-a');
});

test('strict cancellation is monotonic through true underlying settlement, not outer timeout', async () => {
  const activity = registry();
  const envelope = activate(activity);
  const child = deferred();
  let cancelCount = 0;
  await activity.run(envelope, () => {
    activity.trackChild(child.promise, {cancel: () => { cancelCount += 1; }});
    return 'timeout result';
  });
  assert.equal(activity.cancel(envelope).quiesced, false);
  assert.equal(cancelCount, 1);
  assert.throws(() => activity.run({...envelope, operationId: 'other'}, () => {}), /CAPTURE_CANCELED/u);
  assert.throws(() => activity.runLegacy(() => {}), /PAGE_CONTROL_LEGACY_BLOCKED/u);
  child.resolve();
  await tick();
  assert.equal(activity.inspectStrict(envelope).quiesced, true);
  assert.equal(activity.handshake(cohort).stopped, true);
  assert.throws(() => activity.handshake({...cohort, generation: 2}), /COHORT_LOCKED/u);
});

for (const field of ['requestId', 'attemptId', 'generation', 'ownerDocumentId', 'documentId', 'activationId', 'operationId']) {
  test(`strict control rejects mismatched/malformed ${field} without stopping`, () => {
    const activity = registry(); const envelope = activate(activity);
    const value = field === 'generation' ? 2 : field === 'operationId' ? '' : 'another';
    assert.throws(() => activity.cancel({...envelope, [field]: value}), /IDENTITY_MISMATCH/u);
    assert.equal(activity.isStopped(), false);
  });
}

test('single top-level cohort remains owned until detached child really settles', async () => {
  const activity = registry(); const envelope = activate(activity);
  const child = deferred();
  await activity.run(envelope, () => { activity.trackChild(child.promise); });
  assert.equal(activity.getInvocation().operationId, 'operation-a');
  assert.throws(() => activity.run({...envelope, operationId: 'operation-b'}, () => {}), /PAGE_BUSY/u);
  child.resolve(); await tick();
  assert.throws(() => activity.run(envelope, () => {}), /OPERATION_REPLAY/u);
  await activity.run({...envelope, operationId: 'operation-b'}, () => {});
});

test('external script reservation cannot be drained by stop or wrong settlement', async () => {
  const activity = registry(); const envelope = activate(activity);
  assert.equal(activity.reserve(envelope).activeCount, 1);
  assert.equal(activity.cancel(envelope).quiesced, false);
  await assert.rejects(activity.settle({...envelope, operationId: 'other'}), /UNKNOWN/u);
  assert.equal(activity.inspect().activeCount, 1);
  assert.equal((await activity.settle(envelope)).quiesced, true);
  await assert.rejects(activity.settle(envelope), /UNKNOWN/u);
});

function contentHarness() {
  const activity = registry();
  const calls = [];
  const events = new Map();
  const pending = deferred();
  let listener;
  const capture = (...args) => { calls.push(args); return pending.promise; };
  const overlay = {
    getState: () => ({}), startSession() {}, setTaskTakeover: () => ({}),
    recordItems() {}, complete() {}, fail() {}, cancel() {},
  };
  const context = vm.createContext({
    pageActivity: activity, crypto: {randomUUID}, URL,
    console: {log() {}, warn() {}, error() {}}, setInterval, clearInterval,
    window: {location: {href: 'https://www.douyin.com/search/x', origin: 'https://www.douyin.com',
      assign: (url) => calls.push(['navigate', url])},
      addEventListener: (type, fn) => events.set(type, fn), setTimeout},
    document: {querySelector: () => null, querySelectorAll: () => [], body: {}},
    chrome: {runtime: {id: 'fixture-extension', onMessage: {addListener: (fn) => { listener = fn; }},
      sendMessage(_message, callback) { callback?.(); }}},
    normalizeTaskContext: () => null, buildContentDiagnostics: () => ({}),
    startContentPageStateReporting() {}, resetCancelFlag() {}, setCancelFlag: (flag) => calls.push(['cancel', flag]),
    detectPlatformFromUrl: () => 'fixture', detectPageType: () => 'fixture',
    smartCapture: capture, captureSingleNote: capture, captureBloggerProfile: capture,
    captureBloggerNotes: capture, captureKeywordNotes: capture, captureComments: capture,
    expandKeywordViaSuggestions: capture, findXhsSourceNote: capture,
    detectKeywordSortDimension: () => ({}), detectLoggedSocialAccount: () => ({}),
    getListCaptureDebugOverlay: () => overlay,
    createListCaptureOverlayRunScope: () => ({...overlay, isCurrent: () => true}),
    createListCaptureAcceptanceLedger: () => ({getAcceptedCount: () => 0,
      accept: (items) => items, record: () => [], decorateFinalItems: (items) => items}),
    decorateListCheckpointProgress: (progress) => progress,
    assertNoDouyinSearchServiceAbnormalPage() {}, assertNoDouyinSearchSecurityChallengePage() {},
  });
  vm.runInContext(source.replace(/^import[\s\S]*?from ["'][^"']+["'];\s*/gm, ''), context);
  const sender = {id: 'fixture-extension', url: 'chrome-extension://fixture-extension/background.js'};
  function send(request, suppliedSender = sender) {
    const responses = [];
    const keepAlive = listener(request, suppliedSender, (value) => responses.push(value));
    return {responses, keepAlive};
  }
  function handshake() {
    const result = send({action: 'onstarvoice:page-control-handshake', pageControl: cohort});
    assert.equal(result.responses[0]?.ok, true);
    return {...result.responses[0].pageControl.scope, operationId: randomUUID()};
  }
  return {activity, calls, pending, events, send, handshake, context};
}

for (const action of ['prepareKeywordStrategyCapture', 'applyBatchSearchFilters']) {
  test(`actual ${action} handler remains registered through asynchronous page helper settlement`, async () => {
    const h = contentHarness(); const pageControl = h.handshake();
    h.context.fixturePageWait = h.pending.promise;
    h.context.detectPageType = () => 'search_results';
    // Keep the actual listener + handler + flow; substitute only the DOM panel
    // adapter, which is unavailable in this offline VM.
    vm.runInContext('ensureKeywordStrategyFilterPanelOpen = () => fixturePageWait;', h.context);
    h.send({action, pageControl, sort: 'likes'});
    assert.equal(h.activity.inspect().topLevelCount, 1);
    assert.equal(h.activity.cancel(pageControl).quiesced, false);
    h.pending.resolve(false); await tick();
    assert.equal(h.activity.inspect().quiesced, true);
  });
}

for (const action of ['restoreListCaptureTraceOverlay', 'updateListCaptureTraceBindings', 'setCaptureTaskTakeover']) {
  test(`actual strict ${action} has positive admission and cannot reuse its operation`, async () => {
    const h = contentHarness(); const pageControl = h.handshake();
    const result = h.send({action, pageControl});
    assert.equal(result.responses[0]?.ok, true);
    assert.equal(h.activity.inspect().topLevelCount, 1, 'synchronous response still tracked until handler settlement');
    await tick();
    assert.equal(h.activity.inspect().activeCount, 0);
    assert.equal(h.send({action, pageControl}).responses[0].error.code, 'PAGE_CONTROL_OPERATION_REPLAY');
  });
}

for (const action of ['smartCapture', 'captureSingleNote', 'captureBloggerProfile', 'captureBloggerNotes',
  'captureKeywordNotes', 'captureComments', 'expandKeywordSuggestions', 'findXhsSourceNote']) {
  test(`actual content entry ${action} registers anonymous legacy and strict invocation`, async () => {
    for (const strict of [false, true]) {
      const h = contentHarness();
      const pageControl = strict ? h.handshake() : null;
      const request = {action, ...(pageControl ? {pageControl} : {})};
      h.send(request);
      assert.equal(h.calls.length, 1, 'real handler reached injected platform capture port');
      assert.equal(h.activity.inspect().topLevelCount, 1);
      if (strict) {
        assert.equal(h.send({action: 'onstarvoice:page-control-stop', pageControl}).responses[0].pageControl.quiesced, false);
      } else {
        assert.equal(h.send({action: 'onstarvoice:page-control-handshake', pageControl: cohort}).responses[0].ok, false);
      }
      h.pending.resolve({ok: true, data: {items: []}});
      await tick();
      assert.equal(h.activity.inspect().activeCount, 0);
      if (strict) assert.equal(h.activity.inspect().quiesced, true);
    }
  });
}

for (const action of ['cancelCapture', 'restoreListCaptureTraceOverlay', 'updateListCaptureTraceBindings',
  'setCaptureTaskTakeover', 'prepareKeywordStrategyCapture', 'applyBatchSearchFilters', 'findXhsSourceNote',
  'smartCapture', 'captureComments']) {
  test(`actual strict page refuses legacy ${action} before any effects`, () => {
    const h = contentHarness(); h.handshake();
    const response = h.send({action}).responses[0];
    assert.equal(response.error.code, 'PAGE_CONTROL_LEGACY_BLOCKED');
    assert.deepEqual(h.calls, []);
  });
}

for (const sender of [{id: 'foreign'}, {id: 'fixture-extension', tab: {id: 1}},
  {id: 'fixture-extension', documentId: 'another-document'},
  {id: 'fixture-extension', url: 'chrome-extension://fixture-extension/sidebar.html'},
  {id: 'fixture-extension', origin: 'https://www.douyin.com'}]) {
  test(`actual control rejects non-background sender ${JSON.stringify(sender)}`, () => {
    const h = contentHarness();
    assert.equal(h.send({action: 'onstarvoice:page-control-handshake', pageControl: cohort}, sender)
      .responses[0].error.code, 'PAGE_CONTROL_UNTRUSTED_SENDER');
    assert.equal(h.activity.isStrict(), false);
  });
}

test('actual pagehide/BFCache fences old activation and does not clear pending activity', async () => {
  const h = contentHarness(); const pageControl = h.handshake();
  h.send({action: 'captureSingleNote', pageControl});
  h.events.get('pagehide')({persisted: true});
  assert.equal(h.activity.inspect().stopped, true);
  assert.equal(h.activity.inspect().quiesced, false);
  h.pending.resolve({ok: true}); await tick();
  assert.equal(h.activity.inspect().quiesced, true);
  assert.equal(h.send({action: 'onstarvoice:page-control-handshake', pageControl: cohort}).responses[0].pageControl.stopped, true);
});

test('actual navigation is document-owned, same-origin HTTPS, and permanently denied after stop', async () => {
  const h = contentHarness(); const pageControl = h.handshake();
  assert.equal(h.send({action: 'onstarvoice:page-control-navigate', pageControl,
    payload: {url: 'https://elsewhere.example/'}}).responses[0].ok, false);
  const response = h.send({action: 'onstarvoice:page-control-navigate', pageControl,
    payload: {url: 'https://www.douyin.com/search/next'}});
  assert.equal(response.keepAlive, false);
  assert.equal(response.responses[0].navigationDispatched, true);
  assert.equal(response.responses[0].pageControl.stopped, true);
  assert.equal(response.responses[0].pageControl.quiesced, true);
  assert.equal(response.responses[0].pageControl.activeCount, 0);
  await tick();
  assert.deepEqual(h.calls, [['navigate', 'https://www.douyin.com/search/next']]);
  h.send({action: 'onstarvoice:page-control-stop', pageControl});
  assert.equal(h.send({action: 'onstarvoice:page-control-navigate',
    pageControl: {...pageControl, operationId: 'next'},
    payload: {url: 'https://www.douyin.com/search/last'}}).responses[0].ok, false);
  assert.equal(h.calls.length, 1);
});

test('navigation freezes before assigning and old Document remains stopped without pagehide or new-document evidence', () => {
  const h = contentHarness(); const pageControl = h.handshake();
  let dispatched = false;
  h.context.window.location.assign = () => {
    dispatched = true;
    assert.equal(h.activity.isStopped(), true);
    assert.equal(h.activity.inspect().quiesced, true);
    assert.equal(h.activity.getSignal().aborted, true);
    assert.equal(h.send({action: 'captureSingleNote',
      pageControl: {...pageControl, operationId: 'late'}}).responses[0].error.code, 'CAPTURE_CANCELED');
  };
  const result = h.send({action: 'onstarvoice:page-control-navigate', pageControl,
    payload: {url: 'https://www.douyin.com/search/next'}}).responses[0];
  assert.equal(dispatched, true);
  assert.equal(result.pageControl.quiesced, true);
  assert.equal(h.send({action: 'onstarvoice:page-control-handshake', pageControl: cohort})
    .responses[0].pageControl.stopped, true);
  assert.deepEqual(h.calls, []);
});

for (const url of ['https://www.douyin.com/search/x', 'https://www.douyin.com/search/x#another']) {
  test(`same-document or hash-only navigation is rejected without freezing: ${url}`, () => {
    const h = contentHarness(); const pageControl = h.handshake();
    assert.equal(h.send({action: 'onstarvoice:page-control-navigate', pageControl, payload: {url}})
      .responses[0].error.code, 'PAGE_CONTROL_NAVIGATION_REJECTED');
    assert.equal(h.activity.isStopped(), false);
    assert.deepEqual(h.calls, []);
  });
}

test('navigation cannot hide detached child activity; dispatch failure cannot reverse its freeze', async () => {
  const h = contentHarness(); const pageControl = h.handshake();
  const child = deferred();
  await h.activity.run(pageControl, () => { h.activity.trackChild(child.promise); });
  const navigation = {action: 'onstarvoice:page-control-navigate',
    pageControl: {...pageControl, operationId: 'navigate'},
    payload: {url: 'https://www.douyin.com/search/next'}};
  assert.equal(h.send(navigation).responses[0].error.code, 'PAGE_CONTROL_PAGE_BUSY');
  assert.equal(h.activity.isStopped(), false);
  assert.deepEqual(h.calls, []);
  child.resolve(); await tick();
  h.context.window.location.assign = () => { throw new Error('synthetic assignment failure'); };
  assert.equal(h.send(navigation).responses[0].ok, false);
  assert.equal(h.activity.isStopped(), true);
  assert.equal(h.activity.inspect().quiesced, true);
  assert.equal(h.send({...navigation, pageControl: {...pageControl, operationId: 'retry'}})
    .responses[0].error.code, 'CAPTURE_CANCELED');
});

test('actual scroll reset cannot reverse strict cancellation and step timeout retains underlying child', async () => {
  const activity = registry(); const envelope = activate(activity);
  const context = vm.createContext({pageActivity: activity, setTimeout, clearTimeout,
    DEFAULT_CONFIG: {}, randomScrollDistance: () => 0});
  vm.runInContext(scrollSource.replace(/^import[^\n]+\n/gm, '').replace(/\bexport\s+/g, '')
    + '\nglobalThis.api = {setCancelFlag, resetCancelFlag, isCanceled, runCaptureStepWithTimeout};', context);
  const pending = deferred();
  await activity.run(envelope, async () => {
    await assert.rejects(context.api.runCaptureStepWithTimeout(() => pending.promise, 1), /未响应/u);
  });
  assert.equal(activity.inspect().childCount, 1);
  activity.cancel(envelope);
  context.api.resetCancelFlag(); context.api.setCancelFlag(false);
  assert.equal(context.api.isCanceled(), true);
  assert.equal(activity.inspect().quiesced, false);
  pending.resolve(); await tick();
  assert.equal(activity.inspect().quiesced, true);
});

test('actual Douyin safety race retains its underlying work after outer safety error', async () => {
  const keywordSource = readFileSync(new URL('../../utils/capture/douyin-keyword-search.js', import.meta.url), 'utf8');
  const start = keywordSource.indexOf('  const waitWithPageGuard = async (promise) => {');
  const end = keywordSource.indexOf('  const serviceAbnormalObserver =', start);
  assert.ok(start > 0 && end > start);
  const activity = registry(); const envelope = activate(activity);
  const underlying = deferred(); const guard = deferred(); const never = deferred();
  const context = vm.createContext({pageActivity: activity,
    serviceAbnormalSignal: guard.promise, securityChallengeSignal: never.promise,
    assertNoSecurityChallenge() {}, assertNoBlockingPage() {},
  });
  vm.runInContext(keywordSource.slice(start, end) + '\nglobalThis.runGuard = waitWithPageGuard;', context);
  const top = activity.run(envelope, () => context.runGuard(underlying.promise));
  guard.resolve(new Error('synthetic security guard'));
  await assert.rejects(top, /synthetic security guard/u);
  assert.equal(activity.inspect().childCount, 1);
  assert.equal(activity.cancel(envelope).quiesced, false);
  underlying.resolve('late platform result'); await tick();
  assert.equal(activity.inspect().quiesced, true);
});
