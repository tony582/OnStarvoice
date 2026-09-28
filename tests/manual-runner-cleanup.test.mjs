import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const protocol = await readFile(new URL('../utils/manual-keyword-dispatch.js', import.meta.url), 'utf8');
const sidebar = await readFile(new URL('../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
const id = 'eef45fc2-60f4-49f2-a3fd-4a2b572ba51e';
const command = {id: 'command-1', payload: {clientTaskId: id, title: 'manual',
  planSnapshot: {platform: 'douyin', keywords: ['安吉星']}}};
const safeProof = {producerStopped: true, flushConfirmed: true, pendingUploads: 0};
const key = 'onstarvoice.manualKeywordDispatch.v1';

function harness() {
  const state = {}, pages = new Map(), reports = [], removed = [], order = [];
  let guard = true, removeFails = false, retainPage = false, writeFails = false, busy = false;
  let scheduled = 0;
  const context = vm.createContext({URL});
  vm.runInContext(protocol, context);
  const deps = {
    storage: {async get(key) {return {[key]: structuredClone(state[key])};},
      async set(value) {if (writeFails) throw Error('storage full'); Object.assign(state, structuredClone(value));}},
    tabs: {async create(value) {const page = {id: pages.size + 1, ...value}; pages.set(page.id, page); return page;},
      async get(tabId) {if (!pages.has(tabId)) throw Error(`No tab with id: ${tabId}.`); return pages.get(tabId);},
      async remove(tabId) {order.push('remove'); if (removeFails) throw Error('Tabs cannot be edited right now');
        removed.push(tabId); if (!retainPage) pages.delete(tabId);}},
    getURL: path => `chrome-extension://starvoice/${path}`, isBusy: async () => busy,
    reportRun: async run => reports.push(structuredClone(run)),
    canCloseRunner: async () => guard, scheduleCleanup: async () => {scheduled++;},
    onCleaned: async () => {order.push('home');},
  };
  const create = () => context.OnStarvoiceManualKeywordDispatch.createController(deps);
  return {state, pages, reports, removed, order, deps, create, controller: create(),
    sender: () => ({url: `chrome-extension://starvoice/sidebar/sidebar.html?manualKeywordBatch=${id}`, tab: {id: 1}, documentId: 'doc-1'}),
    setGuard: value => {guard = value;}, setRemoveFails: value => {removeFails = value;},
    setRetainPage: value => {retainPage = value;}, setWriteFails: value => {writeFails = value;},
    setBusy: value => {busy = value;}, get scheduled() {return scheduled;}};
}

async function claimed() {
  const h = harness(); await h.controller.dispatch(command); await h.controller.claim(id, h.sender()); return h;
}

for (const status of ['completed', 'failed', 'canceled', 'completed_with_failures', 'needs_action']) {
  test(`manual ${status} reclaims only its shell after a durable flush without rewriting the task result`, async () => {
    const h = await claimed(); const reports = structuredClone(h.reports);
    await h.controller.finish(id, h.sender(), {status, sourceTabId: 88, closureProof: safeProof});
    assert.deepEqual(h.removed, [1]);
    assert.deepEqual(h.order, ['home', 'remove']);
    assert.equal(h.state[key][id].status, status);
    assert.equal(h.state[key][id].sourceTabId, 88);
    assert.equal(h.state[key][id].cleanupPending, false);
    assert.deepEqual(h.reports, reports, 'cleanup does not rewrite the actual ledger/error');
    await h.controller.removed(1);
    assert.deepEqual(h.reports, reports);
  });
}

test('manual close failure survives worker restart and is reconciled without replay', async () => {
  const h = await claimed(); h.setRemoveFails(true);
  await h.controller.finish(id, h.sender(), {status: 'failed', closureProof: safeProof});
  assert.equal(h.state[key][id].cleanupPending, true); assert.ok(h.scheduled > 0);
  h.setRemoveFails(false);
  assert.equal((await h.create().reconcileCleanup()).closedCount, 1);
  assert.equal(h.state[key][id].cleanupPending, false);
  assert.equal((await h.create().dispatch(command)).accepted, true);
  assert.equal(h.pages.size, 0);
});

test('manual cleanup waits for the ledger/resources guard and never trusts unflushed counts', async () => {
  const h = await claimed(); h.setGuard(false);
  await h.controller.finish(id, h.sender(), {status: 'completed', closureProof: safeProof});
  assert.deepEqual(h.removed, []);
  h.setGuard(true); await h.controller.reconcileCleanup(); assert.deepEqual(h.removed, [1]);
  for (const closureProof of [undefined, {...safeProof, pendingUploads: null}, {...safeProof, pendingUploads: ''}, {...safeProof, pendingUploads: false}, {...safeProof, flushConfirmed: false}, {...safeProof, pendingUploads: 2}, {...safeProof, producerStopped: false}]) {
    const other = await claimed();
    await other.controller.finish(id, other.sender(), {status: 'failed', closureProof});
    assert.deepEqual(other.removed, []); assert.equal(other.state[key][id].cleanupPending, true);
  }
});

test('manual retirement rejects a foreign document, reused tab URL and pending foreign navigation', async () => {
  const h = await claimed();
  assert.equal((await h.controller.finish(id, {...h.sender(), documentId: 'doc-2'}, {status: 'completed', closureProof: safeProof})).ok, false);
  assert.deepEqual(h.removed, []);
  for (const patch of [{url: 'https://example.invalid/'}, {pendingUrl: 'https://example.invalid/'},
    {url: `chrome-extension://starvoice/sidebar/sidebar.html?manualKeywordBatch=${id}&targetedPostRun=other`}]) {
    const other = await claimed(); Object.assign(other.pages.get(1), patch);
    await other.controller.finish(id, other.sender(), {status: 'completed', closureProof: safeProof});
    assert.deepEqual(other.removed, []); assert.equal(other.state[key][id].cleanupReason, 'runner_identity_changed');
  }
});

test('manual cleanup rechecks the exact document and resources after home restoration', async () => {
  for (const changed of ['document', 'lock', 'relay']) {
    const h = harness();
    let currentDocument = 'doc-1', resourceBusy = false, checks = 0;
    h.deps.canCloseRunner = async entry => {
      checks++;
      return entry.claimedDocumentId === currentDocument && !resourceBusy;
    };
    h.deps.onCleaned = async () => {
      h.order.push('home');
      // The URL is identical during a reload; only document identity changes.
      if (changed === 'document') currentDocument = 'doc-reloaded';
      else resourceBusy = true;
    };
    const controller = h.create();
    await controller.dispatch(command); await controller.claim(id, h.sender());
    await controller.finish(id, h.sender(), {status: 'completed', closureProof: safeProof});
    assert.equal(checks, 2, changed);
    assert.deepEqual(h.removed, [], changed);
    assert.equal(h.state[key][id].cleanupPending, true, changed);
    assert.ok(h.scheduled > 0, changed);
  }
});

test('storage failure before retirement prevents close and a resolved remove must still be verified', async () => {
  const h = await claimed(); h.setWriteFails(true);
  await assert.rejects(h.controller.finish(id, h.sender(), {status: 'completed', closureProof: safeProof}), /storage full/);
  assert.deepEqual(h.removed, []);
  const other = await claimed(); other.setRetainPage(true);
  await other.controller.finish(id, other.sender(), {status: 'completed', closureProof: safeProof});
  assert.equal(other.state[key][id].cleanupPending, true);
  assert.match(other.state[key][id].cleanupLastError, /remains open/);
});

test('a rejected unclaimed manual runner can retire, but an active or refreshed claimed document cannot assert an empty queue', async () => {
  const h = harness(); await h.controller.dispatch(command); h.setBusy(true);
  await h.controller.claim(id, h.sender());
  await h.controller.requestCleanup(id, h.sender(), {reason: 'capture_lock_busy'});
  assert.deepEqual(h.removed, [1]); assert.equal(h.reports.at(-1).status, 'needs_action');
  const other = await claimed();
  assert.equal((await other.controller.requestCleanup(id, other.sender())).ok, false);
  await other.controller.claim(id, {...other.sender(), documentId: 'doc-2'});
  await other.controller.requestCleanup(id, {...other.sender(), documentId: 'doc-2'});
  assert.deepEqual(other.removed, []); assert.equal(other.state[key][id].cleanupPending, true);
});

function section(start, end) {
  const from = sidebar.indexOf(start); assert.notEqual(from, -1);
  const to = sidebar.indexOf(end, from + start.length); assert.notEqual(to, -1);
  return sidebar.slice(from, to);
}

for (const kind of ['manual', 'unattended']) {
  test(`${kind} runner cannot render or fetch shared targeted state`, async () => {
    let queries = 0;
    const context = vm.createContext({
      getUnattendedRunRequestIdFromUrl: () => kind === 'unattended' ? 'own-request' : '',
      getRemoteManualKeywordBatchId: () => kind === 'manual' ? 'own-request' : '',
      getTargetedPostRunRequestIdFromUrl: () => '', targetedPostRunState: {id: 'other-request'},
      renderCaptureDebugSession() {}, getCurrentRuntime: () => ({}),
      chrome: {runtime: {sendMessage: async () => {queries++; throw Error('must not query');}}},
    });
    vm.runInContext(section('function buildTargetedPostSyntheticDebugSession(', 'function resolveDisplayedUnattendedSessionBinding(') +
      section('function handleTargetedPostRunRequestStorageChange(', 'function resolveTargetedPostRunBinding(') +
      section('async function loadTargetedPostRunStateForDisplay()', 'async function updateTargetedPostRun('), context);
    assert.equal(context.buildTargetedPostSyntheticDebugSession({}), null);
    context.handleTargetedPostRunRequestStorageChange({id: 'other-request'});
    assert.equal(context.targetedPostRunState, null);
    assert.equal(await context.loadTargetedPostRunStateForDisplay(), null);
    assert.equal(queries, 0);
  });
}

test('a targeted shell cannot render another attempt of its logical request', () => {
  const context = vm.createContext({
    getUnattendedRunRequestIdFromUrl: () => '', getRemoteManualKeywordBatchId: () => '',
    getTargetedPostRunRequestIdFromUrl: () => 'request-1', getTargetedPostRunAttemptIdFromUrl: () => 'old',
    targetedPostRunState: {id: 'request-1', attemptId: 'new'},
  });
  vm.runInContext(section('function buildTargetedPostSyntheticDebugSession(', 'function resolveDisplayedUnattendedSessionBinding('), context);
  assert.equal(context.buildTargetedPostSyntheticDebugSession({}), null);
});


test('native task UI stays bound to the shell request and attempt', () => {
  const context = vm.createContext({
    getRemoteManualKeywordBatchId: () => '',
    getUnattendedRunRequestIdFromUrl: () => 'old-request', getUnattendedRunAttemptIdFromUrl: () => 'attempt-1',
    getTargetedPostRunRequestIdFromUrl: () => '', getTargetedPostRunAttemptIdFromUrl: () => '',
  });
  vm.runInContext(section('function isCaptureSessionForCurrentRunner(', 'function renderCaptureDebugSession('), context);
  assert.equal(context.isCaptureSessionForCurrentRunner({taskId: 'targeted-new::attempt-2'}), false);
  assert.equal(context.isCaptureSessionForCurrentRunner({taskId: 'unattended-capture:old-request', attemptId: 'attempt-2'}), false);
  assert.equal(context.isCaptureSessionForCurrentRunner({taskId: 'unattended-capture:old-request', attemptId: 'attempt-1'}), true);
  context.getUnattendedRunRequestIdFromUrl = () => '';
  context.getRemoteManualKeywordBatchId = () => 'manual-own';
  assert.equal(context.isCaptureSessionForCurrentRunner({taskId: 'targeted-new::attempt-2'}), false);
  assert.equal(context.isCaptureSessionForCurrentRunner({taskId: 'manual-own'}), true);
});

for (const reason of ['capture_lock_conflict', 'previous_capture_stop_unconfirmed', 'not_claimable', 'missing_lock_holder', 'not_found', 'attempt_superseded', 'terminal']) {
  test(`rejected unattended claim ${reason} preserves execution fences or retires only stale ownership`, async () => {
    const retired = [];
    const context = vm.createContext({
      getRemoteManualKeywordBatchId: () => '', getTargetedPostRunRequestIdFromUrl: () => '',
      getUnattendedRunRequestIdFromUrl: () => 'request-1', getUnattendedRunAttemptIdFromUrl: () => 'attempt-1',
      CAPTURE_EXECUTION_LOCK_HOLDER_ID: 'holder-1', getKeywordExecutionCopy: () => ({taskLabel: 'test'}),
      chrome: {runtime: {sendMessage: async () => ({ok: true, accepted: false, reason})}},
      showMessage() {}, clearActiveUnattendedRunRequest() {},
      retireSupersededUnattendedAttempt: async value => retired.push(value),
    });
    vm.runInContext(section('async function maybeClaimAndRunUnattendedKeywordPlan(', 'function buildSidebarKeywordSearchUrl('), context);
    await context.maybeClaimAndRunUnattendedKeywordPlan();
    assert.equal(retired.length, ['not_found', 'attempt_superseded', 'terminal'].includes(reason) ? 1 : 0);
    if (retired.length) assert.deepEqual(JSON.parse(JSON.stringify(retired[0])),
      {requestId: 'request-1', attemptId: 'attempt-1', reason: 'claim_rejected'});
  });
}
