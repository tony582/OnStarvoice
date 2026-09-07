// Memory-only control fixture: real authority, journal, Auth/Q fence and page
// registry. Browser/server effects are explicit ports and never use the network.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID, webcrypto} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createContentActivityRegistry} from '../../utils/capture/content-activity.js';
const PREFIX = 'onstarvoice:strict-';
const PREPARE = 'onstarvoice:prepare-active-capture-stop';
const EXECUTE = 'onstarvoice:execute-active-capture-stop';
const INSPECT = 'onstarvoice:inspect-active-capture-stop';
const ACTION = 'stop_active_capture';
const KEY = 'onstarvoice.captureStopControl.v1';
const AUTH_LOCK = 'onstarvoice:auth-state';
const CONTROL_LOCK = 'onstarvoice:control-state-v1';
const RESERVATION_LOCK = 'fixture:capture-execution-lock';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function deferred() {let resolve; let reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};}

export function createActiveStopHarness(options = {}) {
  let time = Date.parse('2026-09-06T12:00:00.000Z');
  const requestId = randomUUID(), attemptId = randomUUID(), commandId = randomUUID();
  const sender = {id: 'fixture-extension', url: 'chrome-extension://fixture-extension/sidebar/sidebar.html',
    documentId: 'owner-document', documentLifecycle: 'active', frameId: 0, tab: {id: 7}};
  const request = {id: requestId, attemptId, status: 'running', cloudAssigned: true,
    cloudCommandId: commandId, cloudAgentScopeId: 'fixture-agent', attemptNumber: 1, progressSeq: 3,
    createdAt: new Date(time - 1000).toISOString(), updatedAt: new Date(time).toISOString(),
    runnerTabId: 7, planSnapshot: {platform: 'douyin'}};
  const store = {
    auth: {authMutationId: 'fixture-auth-mutation', captureAgent: {id: 'fixture-agent', token: 'synthetic-token-never-persist'},
      tenant: {id: 'fixture-tenant'}},
    request,
    ledger: {runs: [{id: requestId, attemptId, status: 'running', updatedAt: request.updatedAt,
      metadata: {cloudAgentScopeId: 'fixture-agent', cloudCommandId: commandId}}]},
    archive: {requests: {}},
    lock: {id: 'reserved-lock', owner: 'unattended_keyword_plan', holderId: 'holder-a',
      holderDocumentId: sender.documentId, holderTabId: 7, expiresAt: time + 60000,
      captureTaskId: '', captureTaskAttemptId: ''},
    unsyncedRecords: [{id: 'preserved', body: 'fixture-body', synced: false}],
  };
  options.mutateInitial?.(store);
  const writes = [], pageCalls = [], ownerMessages = [], lockEvents = [], queryCalls = [], effects = [];
  const lockContext = new AsyncLocalStorage(), tails = new Map();
  const outsideLocks = label => {
    assert.deepEqual(lockContext.getStore() || [], [], `${label} cannot wait inside Auth/reservation/Q`);
  };
  const locks = {request(name, config, callback) {
    assert.equal(config.mode, 'exclusive');
    const held = lockContext.getStore() || [];
    assert.equal(held.includes(CONTROL_LOCK), false, 'Q remains the leaf');
    if (name === AUTH_LOCK) assert.deepEqual(held, [], 'Auth must precede reservation and Q');
    if (name === RESERVATION_LOCK) assert.deepEqual(held, [AUTH_LOCK], 'reservation is acquired after Auth');
    if (name === CONTROL_LOCK) assert.ok(
      JSON.stringify(held) === JSON.stringify([AUTH_LOCK]) ||
      JSON.stringify(held) === JSON.stringify([AUTH_LOCK, RESERVATION_LOCK]),
      `Q is acquired only after Auth or Auth/reservation: ${JSON.stringify(held)}`);
    const work = (tails.get(name) || Promise.resolve()).then(() =>
      lockContext.run([...held, name], async () => {
        lockEvents.push(['enter', name]);
        try {return await callback();} finally {lockEvents.push(['leave', name]);}
      }));
    tails.set(name, work.catch(() => {}));
    return work;
  }};
  const runReservationOperation = callback => locks.request(RESERVATION_LOCK, {mode: 'exclusive'}, callback);
  let beforeSet = null, beforeGet = null;
  const storage = {
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      if (beforeGet) await beforeGet(list, {held: [...(lockContext.getStore() || [])]});
      return Object.fromEntries(list.map(key => [key, clone(store[key])]));
    },
    async set(patch) {
      if (beforeSet) await beforeSet(patch);
      writes.push(clone(patch)); Object.assign(store, clone(patch));
    },
  };
  const context = vm.createContext({URL, TextEncoder, AbortController, setTimeout, clearTimeout,
    crypto: {subtle: webcrypto.subtle, randomUUID}, navigator: {locks}});
  for (const file of ['utils/control/state-fence.js', 'utils/control/stop-journal.js',
    'utils/control/active-stop-authority.js', 'utils/capture/lifecycle/strict-control.js']) {
    vm.runInContext(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), context, {filename: file});
  }
  const journal = context.OnStarvoiceStopJournal.create({storage,
    fence: context.OnStarvoiceControlStateFence, now: () => time,
    runReservationOperation,
    keys: {auth: 'auth', request: 'request', ledger: 'ledger', archive: 'archive', lock: 'lock'}});
  let beforeAuthority = null;
  const authority = context.OnStarvoiceActiveStopAuthority.create({now: () => time,
    query: async (body, queryOptions) => {
      outsideLocks('authority'); queryCalls.push(clone(body));
      assert.equal(queryOptions.rawAuth.captureAgent.token, store.auth.captureAgent.token);
      if (beforeAuthority) await beforeAuthority();
      return {ok: true, decision: 'allow', action: ACTION, policyVersion: 'active-capture-stop-v1',
        authorityRevision: 'a'.repeat(64), agentId: 'fixture-agent', tenantId: 'fixture-tenant',
        authCodeId: 'fixture-code', authBindingId: 'fixture-binding',
        evaluatedAt: new Date(time).toISOString(), expiresAt: new Date(time + 4000).toISOString(),
        source: {...body.source, serverTaskId: randomUUID(), serverAttemptId: randomUUID(),
          snapshotId: randomUUID(), snapshotFingerprint: 'b'.repeat(64)}};
    }});
  const documents = new Map([[7, 'page-a']]), pages = new Map();
  const child = deferred(); let navigation = null, missingReceipt = false, blockedPageControl = null;
  function pageFor(documentId) {
    if (!pages.has(documentId)) pages.set(documentId,
      createContentActivityRegistry({createActivationId: () => `activation-${documentId}`}));
    return pages.get(documentId);
  }
  async function resolveDocument(tabId) {
    outsideLocks('resolveDocument');
    if (navigation && tabId === navigation.tabId) {
      if (options.navigationGate) await options.navigationGate.promise;
      documents.set(tabId, navigation.nextDocumentId);
      navigation = null;
    }
    return {documentId: documents.get(tabId)};
  }
  async function sendPage(tabId, message, documentId) {
    outsideLocks('sendPage');
    pageCalls.push(clone({tabId, documentId, message, journalPhaseAtDispatch: store[KEY]?.phase}));
    // Explicit document targeting is mandatory; BFCache pages remain accessible
    // in the fixture so a different document is never mistaken for destruction.
    const page = pageFor(documentId), envelope = message.pageControl;
    assert.equal(envelope.documentId, documentId);
    if (blockedPageControl && ['onstarvoice:page-control-stop', 'onstarvoice:page-control-inspect'].includes(message.action)) {
      await blockedPageControl.promise;
    }
    if (message.action === 'onstarvoice:page-control-handshake') {
      if (options.pageHandshakeGate) await options.pageHandshakeGate.promise;
      return {ok: true, pageControl: page.handshake(envelope)};
    }
    if (message.action === 'onstarvoice:page-control-stop') return {ok: true, pageControl: page.cancel(envelope)};
    if (message.action === 'onstarvoice:page-control-inspect') return missingReceipt ? null : {ok: true, pageControl: page.inspectStrict(envelope)};
    if (message.action === 'onstarvoice:page-control-reserve') return {ok: true, pageControl: page.reserve(envelope)};
    if (message.action === 'onstarvoice:page-control-settle') return {ok: true, pageControl: await page.settle(envelope)};
    if (message.action === 'onstarvoice:page-control-navigate') {
      const snapshot = page.navigate(envelope, () => {
        effects.push(['navigate', documentId]);
        navigation = {tabId, nextDocumentId: `${documentId}-next`};
      });
      return {ok: true, navigationDispatched: true, pageControl: snapshot};
    }
    const result = await page.run(envelope, () => {
      effects.push(['relay', documentId, message.action]);
      if (message.withChild) page.trackChild(child.promise, {kind: 'fixture-platform-body'});
      const result = {ok: true, data: {records: ['preserved-result']}};
      return options.relayGate ? options.relayGate.promise.then(() => result) : result;
    });
    if (options.loseRelayReply) throw new Error('synthetic lost relay reply');
    return result;
  }
  const disconnect = [];
  function ownerPort() {
    return {name: context.OnStarvoiceStrictCaptureControl.PORT, sender,
      onDisconnect: {addListener: listener => disconnect.push(listener)},
      postMessage: message => {outsideLocks('owner stop notification'); ownerMessages.push(clone(message));}, disconnect() {}};
  }
  function createPorts(epoch = 'worker-a') {
    return {journal, authority,
      extensionId: 'fixture-extension', workerEpoch: epoch, resolveDocument, sendPage,
      createTab: async payload => {
        outsideLocks('createTab'); effects.push(['create', payload]);
        if (options.createGate) await options.createGate.promise;
        return {id: 19};
      },
      admitWhileLegacyIdle: callback => callback(), now: () => time, randomId: randomUUID,
      pause: async ms => {outsideLocks('pause'); time += ms;}};
  }
  function makeControl(epoch = 'worker-a') {
    const ports = createPorts(epoch);
    const control = options.createControl ? options.createControl(ports, context)
      : context.OnStarvoiceStrictCaptureControl.create(ports);
    assert.equal(control.attachPort(ownerPort()), true);
    return control;
  }
  const control = makeControl(); let scope = null, operationSeq = 0, activitySeq = 0;
  const send = (message, from = sender, target = control) => target.handle(message, from);
  async function bind() {
    const result = await send({type: PREFIX + 'owner-bind', requestId, attemptId});
    if (result.ok) scope = result.strictControl;
    return result;
  }
  const scoped = (type, data = {}) => send({type: PREFIX + type, strictControl: scope, ...data});
  const operation = (kind = 'relay', payload = {action: 'captureSingleNote'}, data = {}) => scoped('page-operation', {
    operationId: randomUUID(), operationSeq: ++operationSeq, tabId: 7, kind, payload, ...data});
  const beginActivity = (activityId = randomUUID(), data = {}) => scoped('owner-activity-begin', {
    activityId, activitySeq: ++activitySeq, ...data});
  const prepare = () => send({type: PREPARE, action: ACTION});
  const execute = handle => send({type: EXECUTE, action: ACTION, handle});
  const inspect = () => send({type: INSPECT});
  return {control, journal, context, storage, authority, createPorts, ownerPort, sendPage, resolveDocument,
    keys: {auth: 'auth', request: 'request', ledger: 'ledger', archive: 'archive', lock: 'lock'},
    chrome: {storage: {local: storage}, runtime: {id: 'fixture-extension'}},
    store, writes, pageCalls, ownerMessages, queryCalls, effects, sender,
    requestId, attemptId, bind, scoped, operation, beginActivity, prepare, execute, inspect,
    child, pages, documents, pageFor, makeControl, send, lockEvents, runReservationOperation,
    heldLocks: () => [...(lockContext.getStore() || [])],
    get scope() {return scope;},
    set beforeSet(callback) {beforeSet = callback;},
    set beforeGet(callback) {beforeGet = callback;},
    set beforeAuthority(callback) {beforeAuthority = callback;},
    set missingReceipt(value) {missingReceipt = value;},
    set blockedPageControl(value) {blockedPageControl = value;},
    advance(ms) {time += ms;},
  };
}
