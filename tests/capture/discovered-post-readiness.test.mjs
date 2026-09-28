import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import {
  readDiscoveredPostDocument,
  waitForDiscoveredPostTab,
} from '../../utils/capture/discovered-post-readiness.js';

const root = new URL('../../', import.meta.url);
const [sidebar, background, protocol] = await Promise.all([
  readFile(new URL('sidebar/sidebar-logic.js', root), 'utf8'),
  readFile(new URL('background.js', root), 'utf8'),
  readFile(new URL('utils/cloud-targeted-post.js', root), 'utf8'),
]);
const apiContext = vm.createContext({URL});
vm.runInContext(protocol, apiContext);
const api = apiContext.OnStarvoiceCloudTargetedPost;
const url = 'https://www.douyin.com/video/76543210987654321';
const otherUrl = 'https://www.douyin.com/video/76543210987654322';
const target = {url, externalId: '76543210987654321', itemId: 'item-1'};
const plain = (value) => JSON.parse(JSON.stringify(value));
function section(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `${start} -> ${end}`);
  return source.slice(a, b);
}

function scenario(options = {}) {
  const state = {time: 0, reads: 0, probes: 0, documents: 0, stopped: false,
    tab: {id: 21, url, status: 'loading'},
    document: {documentId: 'doc-1', url, readyState: 'interactive'},
    safety: {currentUrl: url, isDouyin: true, targetMatched: true, detailReady: false},
  };
  const dependencies = {
    tabId: 21, target, platform: 'douyin', canonicalizeTargetUrl: api.canonicalizeTargetUrl,
    shouldStop: () => state.stopped,
    now: () => state.time,
    wait: async (ms) => { state.time += ms; await options.onWait?.(state); },
    readTab: async () => { state.reads++; await options.onRead?.(state); return {...state.tab}; },
    readDocument: async () => { state.documents++; await options.onDocument?.(state); return {...state.document}; },
    probeSafety: async () => { state.probes++; await options.onProbe?.(state); return {...state.safety}; },
  };
  return {state, dependencies, run: (overrides = {}) => waitForDiscoveredPostTab({...dependencies, ...overrides})};
}

test('a loaded target retains the existing navigation contract; loading requires exact detail readiness', async () => {
  const complete = scenario();
  complete.state.tab.status = 'complete';
  assert.equal((await complete.run()).id, 21);
  const loading = scenario();
  loading.state.safety.detailReady = true;
  assert.equal((await loading.run()).status, 'loading');
  assert.equal(loading.state.probes, 1);
  assert.equal(loading.state.documents, 2);
});

test('the same page completing after the old twenty-second limit is observed without another navigation', async () => {
  const h = scenario({onWait(state) { if (state.time >= 25_000) state.tab.status = 'complete'; }});
  assert.equal((await h.run()).id, 21);
  assert.ok(h.state.time >= 25_000 && h.state.time < 60_000);
});

test('a suspended event loop gets exactly one final fresh observation after the deadline', async () => {
  const h = scenario({onWait(state) { state.time = 75_000; state.tab.status = 'complete'; }});
  assert.equal((await h.run()).id, 21);
  assert.equal(h.state.probes, 2);
});

test('persistent loading has a sixty-second budget and one bounded final observation', async () => {
  const h = scenario();
  await assert.rejects(h.run(), {code: 'TARGET_RUNNER_TAB_TIMEOUT', stage: 'initial_detail_readiness'});
  assert.equal(h.state.time, 60_000);
  assert.equal(h.state.probes, 201);
});

test('cancellation before any access and during a probe prevents readiness', async () => {
  const before = scenario();
  before.state.stopped = true;
  await assert.rejects(before.run(), {code: 'TARGET_CAPTURE_CANCELED'});
  assert.equal(before.state.reads, 0);
  const during = scenario({onProbe(state) { state.stopped = true; }});
  during.state.tab.status = 'complete';
  await assert.rejects(during.run(), {code: 'TARGET_CAPTURE_CANCELED'});
});

test('closed tabs remain distinguishable from a page that did not become ready', async () => {
  const h = scenario({onRead() { throw new Error('No tab with id: 21'); }});
  await assert.rejects(h.run(), {code: 'TARGET_RUNNER_TAB_CLOSED'});
});

test('changed target URL, pending navigation, and conflicting active work cannot pass on complete', async () => {
  for (const kind of ['url', 'pending', 'probe']) {
    const h = scenario();
    h.state.tab.status = 'complete';
    if (kind === 'url') h.state.document.url = otherUrl;
    if (kind === 'pending') h.state.tab.pendingUrl = otherUrl;
    if (kind === 'probe') h.state.safety.activeWorkIdentityConflict = true;
    await assert.rejects(h.run(), {code: 'TARGET_IDENTITY_MISMATCH'}, kind);
  }
});

test('an initial document commit can settle, but replacing a verified target document cannot inherit the task', async () => {
  const committing = scenario({onDocument(state) {
    if (state.documents === 2) state.document.documentId = 'doc-2';
  }});
  committing.state.tab.status = 'complete';
  assert.equal((await committing.run()).id, 21);
  assert.equal(committing.state.probes, 2);
  const replaced = scenario({onWait(state) {
    state.document.documentId = 'replacement'; state.tab.status = 'complete';
  }});
  await assert.rejects(replaced.run(), {code: 'TARGET_RUNNER_DOCUMENT_CHANGED'});
});

test('a same-URL document swap during a later probe cannot pass readiness', async () => {
  const h = scenario({onProbe(state) {
    if (state.probes === 2) { state.document.documentId = 'replacement'; state.tab.status = 'complete'; }
  }});
  await assert.rejects(h.run(), {code: 'TARGET_RUNNER_DOCUMENT_CHANGED'});
});

test('missing document proof and skipped safety probe never become successful readiness', async () => {
  for (const kind of ['document', 'probe']) {
    const h = scenario();
    h.state.tab.status = 'complete';
    if (kind === 'document') h.state.document.documentId = '';
    if (kind === 'probe') h.state.safety = {ok: true, skipped: true};
    await assert.rejects(h.run({timeoutMs: 900}), {code: 'TARGET_RUNNER_TAB_TIMEOUT'}, kind);
  }
});

test('an owned opening placeholder may commit to the target without authorizing a foreign site', async () => {
  const h = scenario({onWait(state) { state.tab.url = url; state.tab.status = 'complete'; }});
  h.state.tab.url = 'about:blank#onstarvoice-targeted-post=session-1';
  assert.equal((await h.run()).url, url);
  const foreign = scenario();
  foreign.state.tab.url = 'https://example.com/login';
  await assert.rejects(foreign.run(), {code: 'TARGET_IDENTITY_MISMATCH'});
  assert.equal(foreign.state.documents, 0);
});

test('same-target pending navigation cannot use the previous document ready state', async () => {
  const h = scenario({onWait(state) {
    state.tab.pendingUrl = undefined;
    state.document.documentId = 'committed-document';
  }});
  h.state.tab.pendingUrl = url;
  h.state.safety.detailReady = true;
  assert.equal((await h.run()).id, 21);
  assert.equal(h.state.time, 300);
  assert.equal(h.state.probes, 1, 'only the committed document is probed');
  const pendingForever = scenario();
  pendingForever.state.tab.pendingUrl = url;
  pendingForever.state.safety.detailReady = true;
  await assert.rejects(pendingForever.run({timeoutMs: 900}), {code: 'TARGET_RUNNER_TAB_TIMEOUT'});
  assert.equal(pendingForever.state.probes, 0);
});

test('navigation beginning during a ready probe needs a new full observation after commit', async () => {
  const h = scenario({onProbe(state) {
    if (state.probes === 1) state.tab.pendingUrl = url;
  }, onWait(state) {
    state.tab.pendingUrl = undefined;
    state.document.documentId = 'committed-document';
  }});
  h.state.safety.detailReady = true;
  assert.equal((await h.run()).id, 21);
  assert.equal(h.state.probes, 2);
  assert.equal(h.state.time, 300);
});

test('CAPTCHA and rate limit errors survive the wrapper with their safety evidence', async () => {
  for (const code of ['PAGE_CHALLENGE_BLOCK', 'RATE_LIMITED', 'XHS_SECURITY_BLOCK']) {
    const h = scenario({onProbe() {
      throw Object.assign(new Error('安全验证'), {code, securityBlocked: true,
        securityEvidence: {confirmed: true, platform: 'douyin', reason: 'captcha'}});
    }});
    await assert.rejects(h.run(), error => error.code === code && error.stage === 'initial_detail_readiness' && error.securityEvidence.confirmed);
  }
});

test('a safety exception from a replaced document is not confirmed for the original page', async () => {
  const h = scenario({onProbe(state) {
    if (state.probes === 2) {
      state.document.documentId = 'replacement';
      throw Object.assign(new Error('验证码'), {code: 'PAGE_CHALLENGE_BLOCK'});
    }
  }});
  await assert.rejects(h.run(), {code: 'TARGET_RUNNER_DOCUMENT_CHANGED'});
  const initial = scenario({onProbe(state) {
    if (state.probes === 1) {
      state.document.documentId = 'committed';
      throw Object.assign(new Error('过期文档的验证码'), {code: 'PAGE_CHALLENGE_BLOCK'});
    }
    state.tab.status = 'complete';
  }});
  assert.equal((await initial.run()).status, 'complete');
  assert.equal(initial.state.probes, 2);
});

test('a document replaced during the final tab lookup is caught by the last document read', async () => {
  const h = scenario({onRead(state) {
    if (state.reads === 4) state.document.documentId = 'replacement';
  }, onWait(state) { state.tab.status = 'complete'; }});
  await assert.rejects(h.run(), {code: 'TARGET_RUNNER_DOCUMENT_CHANGED'});
});

test('confirmed blocking login pauses even if the separate safety probe would hang', async () => {
  const h = scenario({onProbe() { throw Error('must not start'); }});
  h.state.document.loginRequired = true;
  await assert.rejects(h.run(), {code: 'LOGIN_REQUIRED', requiresManualAction: true, retryable: false});
  assert.equal(h.state.probes, 0);
});

test('unresponsive Chrome calls cannot hold the run or suppress cancellation', async () => {
  const pending = new Promise(() => {});
  const h = scenario();
  const began = Date.now();
  await assert.rejects(h.run({now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    timeoutMs: 35, observationTimeoutMs: 15, readDocument: () => pending}), {code: 'TARGET_RUNNER_TAB_TIMEOUT'});
  assert.ok(Date.now() - began < 500);
  let stopped = false;
  const timer = setTimeout(() => { stopped = true; }, 15);
  try {
    await assert.rejects(h.run({now: Date.now, readTab: () => pending, shouldStop: () => stopped}), {code: 'TARGET_CAPTURE_CANCELED'});
  } finally { clearTimeout(timer); }
});

test('late resolution after a suspended probe cannot skip the final identity check', async () => {
  const h = scenario({onProbe(state) {
    if (state.probes === 1) { state.time = 75_000; state.tab.status = 'complete'; state.document.url = otherUrl; }
  }});
  await assert.rejects(h.run(), {code: 'TARGET_IDENTITY_MISMATCH'});
  assert.equal(h.state.probes, 2);
});

test('the document adapter uses Chrome frame-zero documentId and ignores an ordinary login button', async () => {
  let details;
  const result = await readDiscoveredPostDocument(21, {scripting: {executeScript: async value => {
    details = value;
    const ctx = vm.createContext({location: {href: url, pathname: '/video/76543210987654321'},
      document: {readyState: 'interactive', querySelectorAll: () => []}, getComputedStyle: () => ({})});
    const observed = vm.runInContext(`(${value.func.toString()})()`, ctx);
    return [{frameId: 0, documentId: 'chrome-document-id', result: observed}];
  }}});
  assert.deepEqual(details.target, {tabId: 21, frameIds: [0]});
  assert.equal(result.documentId, 'chrome-document-id');
  assert.equal(result.loginRequired, false);
});

const waiter = section(sidebar, 'async function waitForTargetedPostRunnerTab(', 'function collectTargetedPostRecordIds(');
test('the real sidebar waiter enables the enhanced path only for discovery', async () => {
  const invocations = [];
  const context = vm.createContext({Date, setTimeout,
    chrome: {tabs: {get: async id => ({id, status: 'complete'})}},
    waitForDiscoveredPostTab: async options => { invocations.push(options); return {id: options.tabId}; },
    readDiscoveredPostDocument, probeDetailPreloadSafety: () => {}, cloudTargetedPostApi: api,
  });
  vm.runInContext(waiter, context);
  for (const workflow of ['negative_post_patrol', 'watched_content_patrol', 'official_account_post_discovery', 'discovered_post_capture']) {
    await context.waitForTargetedPostRunnerTab(21, () => false, {workflow, platform: 'douyin', target});
  }
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].target, target);
  assert.equal(invocations[0].probeSafety, context.probeDetailPreloadSafety);
});

function backgroundState() {
  const storage = {};
  const context = vm.createContext({console, Date, URL, cloudTargetedPostApi: api,
    STORAGE_KEYS: {targetedPostRunRequest: 'request', taskLedger: 'ledger'},
    isSupportedCloudTargetedPostWorkflow: api.isSupportedWorkflow,
    chrome: {storage: {local: {
      get: async key => ({[key]: storage[key]}),
      set: async values => Object.assign(storage, plain(values)),
    }}},
    runTaskLedgerMutation: operation => operation(),
    runAuthoritativeControlStorageMutation: operation => operation(),
    getUnattendedTaskCenterCore: () => null,
    buildTargetedPostTaskCenterRun: () => null,
  });
  vm.runInContext([
    section(background, 'function resolveOfficialPatrolRunError(', 'async function readTargetedPostRunRequest('),
    section(background, 'async function persistTargetedPostRunRequest(', 'function isNegativePatrolWorkflow('),
    section(background, 'async function closeTerminalTargetedPostPlatformTab(', 'async function forgetRemovedTargetedPostPlatformTab('),
  ].join('\n'), context);
  return {storage, context};
}

async function runInitialFailure(error, {workflow = 'discovered_post_capture', reportingFails = false} = {}) {
  const bg = backgroundState();
  let request = {id: 'request-1', attemptId: 'attempt-1', workflow, platform: 'douyin',
    status: 'pending', targets: [target], targetResults: []};
  const token = {requestId: request.id, attemptId: request.attemptId};
  const patches = [], removed = [];
  const context = vm.createContext({console: {error() {}, warn() {}}, Date, URL, setTimeout, clearTimeout,
    cloudTargetedPostApi: api, OnStarvoiceCloudTargetedPost: api,
    getRemoteManualKeywordBatchId: () => '',
    getTargetedPostRunRequestIdFromUrl: () => request.id,
    getTargetedPostRunAttemptIdFromUrl: () => request.attemptId,
    createTargetedPostInvocationToken: () => token,
    getTargetedPostInvocationTokenFromRequest: () => token,
    isSameTargetedPostInvocationToken: () => true,
    targetedPostRunInFlight: false, targetedPostReconciledAttemptKey: '', targetedPostReconciledAt: 0,
    targetedPostReconcileRetryTimer: null, targetedPostRunState: null,
    activeTargetedPostInvocationToken: null, targetedPostRunBindingStopReason: '',
    targetedPostRunInFlightOwnerToken: null, targetedPostCancelRequested: false,
    batchUrlCancelRequested: false, batchUrlCaptureInFlight: false, batchUrlCaptureMode: '',
    targetedPostBatchStateOwnerToken: null, activeBatchRunnerTabId: null,
    targetedPostRunnerTabOwnerToken: null,
    activateTargetedPostInvocation(value) { context.activeTargetedPostInvocationToken = value; },
    isActiveTargetedPostInvocation: () => true,
    getTargetedPostInvocationOwnership: () => ({active: true, runnerTab: true, run: true}),
    resolveTargetedPostRunBinding: response => ({accepted: response.ok, request: response.data}),
    renderCaptureDebugSession() {}, getCurrentRuntime: () => ({}),
    isTargetedProfileDiscoveryWorkflow: () => false,
    getTargetedWorkflowLabel: () => '作品补详情',
    acquireCaptureExecutionLock: async () => ({id: 'lock'}),
    releaseCaptureExecutionLock: async () => {},
    startTargetedPostRunHeartbeat: () => () => {},
    confirmTargetedPostInvocationBinding: async () => true,
    waitForTargetedPostRunnerTab: async () => { throw error; },
    detectPlatformFromUrl: () => 'douyin',
    chrome: {
      runtime: {sendMessage: async message => {
        if (message.type === 'onstarvoice:open-targeted-post-platform-tab') return {ok: true, data: {tabId: 21}};
        if (message.type === 'onstarvoice:update-targeted-post-run') {
          patches.push(plain(message.patch));
          if (reportingFails && message.patch.finishedAt) throw new Error('storage unavailable');
          request = await bg.context.persistTargetedPostRunRequest(api.mergeRunPatch(request, message.patch));
        }
        return {ok: true, data: request};
      }},
      tabs: {get: async id => ({id, url, status: 'complete'}), remove: async id => removed.push(id)},
      scripting: {executeScript: async () => []},
    },
  });
  vm.runInContext([
    section(sidebar, 'async function updateTargetedPostRun(', 'function startTargetedPostRunHeartbeat('),
    section(sidebar, 'async function settleTargetedPostRunnerTab(', 'async function waitForTargetedPostRunnerTab('),
    section(sidebar, 'async function maybeClaimAndRunTargetedPostWorkflow()', 'async function maybeClaimAndRunUnattendedKeywordPlan('),
  ].join('\n'), context);
  await context.maybeClaimAndRunTargetedPostWorkflow();
  return {request: plain(request), patches, removed, bg};
}

test('real discovery catch, update, durable normalization, finally and background preserve confirmed security', async () => {
  for (const code of ['PAGE_CHALLENGE_BLOCK', 'LOGIN_REQUIRED', 'RATE_LIMITED']) {
    const result = await runInitialFailure(Object.assign(new Error('平台需要验证'), {code, stage: 'initial_detail_readiness'}));
    assert.equal(result.request.status, 'needs_action', code);
    assert.equal(result.request.error.requiresManualAction, true, code);
    assert.equal(result.request.error.retryable, false, code);
    assert.equal(result.bg.storage.request.error.stage, 'initial_detail_readiness');
    assert.deepEqual(result.removed, [], code);
    const normalized = result.bg.context.normalizeStoredTargetedPostRunRequest(plain(result.bg.storage.request)).request;
    assert.equal(api.shouldPreservePlatformTab(normalized), true);
    const cleanup = await result.bg.context.closeTerminalTargetedPostPlatformTab(normalized);
    assert.equal(cleanup.reason, 'targeted_post_needs_action_preserved');
    assert.equal(cleanup.removedCount, 0);
  }
});

test('a verified document replacement survives real catch, persistence and both cleanup paths', async () => {
  const observed = scenario({onWait(state) {
    state.document.documentId = 'replacement'; state.tab.status = 'complete';
  }});
  let failure;
  try { await observed.run(); } catch (error) { failure = error; }
  assert.equal(failure.code, 'TARGET_RUNNER_DOCUMENT_CHANGED');
  assert.equal(failure.requiresManualAction, true);
  const result = await runInitialFailure(failure);
  assert.equal(result.request.status, 'needs_action');
  assert.equal(result.request.error.category, 'document_identity_changed');
  assert.equal(result.request.error.securityBlocked, undefined, 'document replacement is not proof of a CAPTCHA');
  assert.deepEqual(result.removed, []);
  const persisted = result.bg.context.normalizeStoredTargetedPostRunRequest(plain(result.bg.storage.request)).request;
  const cleanup = await result.bg.context.closeTerminalTargetedPostPlatformTab(persisted);
  assert.equal(cleanup.removedCount, 0);
  assert.equal(cleanup.reason, 'targeted_post_needs_action_preserved');
});

test('real finally preserves confirmed safety when reporting fails, but ordinary timeout still closes the owned page', async () => {
  const safe = await runInitialFailure(Object.assign(new Error('验证码'), {code: 'PAGE_CHALLENGE_BLOCK', stage: 'initial_detail_readiness'}), {reportingFails: true});
  assert.deepEqual(safe.removed, []);
  const timedOut = await runInitialFailure(Object.assign(new Error('打开超时'), {code: 'TARGET_RUNNER_TAB_TIMEOUT', stage: 'initial_detail_readiness'}));
  assert.equal(timedOut.request.status, 'failed');
  assert.equal(timedOut.request.error.stage, 'initial_detail_readiness');
  assert.deepEqual(timedOut.removed, [21]);
  assert.equal(api.shouldPreservePlatformTab({...timedOut.request, status: 'needs_action'}), false);
});

test('real catch keeps cancellation and unrelated workflows on their existing terminal paths', async () => {
  const canceled = await runInitialFailure(Object.assign(new Error('已取消'), {
    code: 'TARGET_CAPTURE_CANCELED', stage: 'initial_detail_readiness',
  }));
  assert.equal(canceled.request.status, 'canceled');
  assert.deepEqual(canceled.removed, [21]);
  const unrelated = await runInitialFailure(Object.assign(new Error('打开失败'), {
    code: 'PAGE_CHALLENGE_BLOCK', stage: 'initial_detail_readiness',
  }), {workflow: 'watched_content_patrol'});
  assert.equal(unrelated.request.status, 'failed');
  assert.equal(unrelated.request.error.stage, undefined);
  assert.deepEqual(unrelated.removed, [21]);
});

test('ordinary missing-ingestion needs_action and non-initial discovery errors do not acquire safety retention', () => {
  for (const error of [
    {code: 'detail_finished_without_ingestion', reportedStatus: 'failed'},
    {code: 'TARGET_RUNNER_TAB_TIMEOUT', stage: 'initial_detail_readiness'},
    {code: 'LOGIN_REQUIRED', stage: 'capture'},
  ]) {
    assert.equal(api.shouldPreservePlatformTab({workflow: 'discovered_post_capture', status: 'needs_action', error}), false);
  }
});
