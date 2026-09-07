// No browser, fetch, database, or scheduler. Production local-origin writers,
// authority/source/journal/handoff modules and background builders run against
// explicit memory ports; original claim/running are the marked fixture seam.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID, webcrypto} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {parseSidebarAst} from './sidebar-controller-ast.mjs';
import {createPageOperationClient} from '../../utils/capture/page-operation-client.js';
import {createLocalRecoveryRunnerGate} from '../../sidebar/recovery-runner-gate.js';

export const LOCAL_KEYS = Object.freeze({journal: 'onstarvoice.captureStopControl.v1',
  origin: 'onstarvoice.localCaptureOrigin.v1', launch: 'onstarvoice.localRecoveryLaunch.v1'});
export const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
export function deferred() {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};}
export const tick = () => new Promise(resolve => setImmediate(resolve));
export async function until(predicate, label = 'condition') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail(`${label} did not settle in the memory-only harness`);
}
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (value.type) visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (['range', 'loc', 'tokens', 'comments'].includes(key)) continue;
    if (Array.isArray(child)) child.forEach(entry => walk(entry, visit));
    else walk(child, visit);
  }
}
function boundNames(pattern) {
  const result = [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) result.push(...boundNames(property.value || property.argument));
  if (pattern.type === 'ArrayPattern') for (const entry of pattern.elements.filter(Boolean)) result.push(...boundNames(entry));
  if (pattern.type === 'AssignmentPattern') result.push(...boundNames(pattern.left));
  return result;
}
function installActualBackgroundBuilders(context) {
  const source = read('background.js'), ast = parseSidebarAst(source), declarations = new Map();
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration') declarations.set(node.id.name, node);
    if (node.type === 'VariableDeclaration') for (const entry of node.declarations) {
      for (const name of boundNames(entry.id)) declarations.set(name, node);
    }
  }
  const requested = ['buildUnattendedKeywordRequest', 'buildLocalRecoveryRequest',
    'normalizeUnattendedKeywordPlan', 'buildUnattendedTaskRun', 'upsertUnattendedTaskLedger'];
  const selected = new Set();
  function include(name) {
    const node = declarations.get(name);
    assert.ok(node, `actual background declaration ${name} must exist; no substitute builder`);
    if (selected.has(node)) return;
    selected.add(node);
    walk(node, entry => {if (entry.type === 'Identifier' && declarations.has(entry.name)) include(entry.name);});
  }
  requested.forEach(include);
  const ordered = [...selected].sort((a, b) => a.range[0] - b.range[0]);
  assert.ok(ordered.length < 90, 'only pure builder dependencies, not background startup');
  vm.runInContext(`${ordered.map(node => source.slice(...node.range)).join('\n')}
    globalThis.actualBuilders={${requested.join(',')}};`, context, {filename: 'actual-background-local-builders.js'});
  return {api: context.actualBuilders, declarations: [...declarations].filter(([, node]) => selected.has(node)).map(([name]) => name)};
}
function event() {
  const listeners = [];
  return {addListener: listener => listeners.push(listener), emit: message => listeners.forEach(listener => listener(message))};
}

export function createLocalRecoveryHarness() {
  const keys = {auth: 'auth', request: 'request', ledger: 'ledger', archive: 'archive', lock: 'lock', plan: 'plan'};
  let time = Date.parse('2026-09-07T12:00:00.000Z'), epoch = 'local-worker-1';
  const extensionId = 'fixture-local-extension';
  const binding = {tenantId: randomUUID(), agentId: randomUUID(), authCodeId: randomUUID(),
    authBindingId: randomUUID(), bindingRevision: 'a'.repeat(64)};
  const store = {auth: {authMutationId: 'local-fixture-auth-mutation', tenant: {id: binding.tenantId},
      captureAgent: {id: binding.agentId, token: 'synthetic-local-token-never-persist'}},
    request: null, ledger: {version: 1, runs: [], updatedAt: new Date(time).toISOString(), clearedAt: ''},
    archive: {requests: {}}, plan: null, lock: null,
    unsyncedRecords: [{id: 'preserved-record', synced: false, body: 'synthetic saved result'}],
    checkpointOutbox: [{id: 'preserved-outbox', payload: 'synthetic checkpoint'}]};
  const writes = [], messages = [], queries = [], creates = [], pageEffects = [], lockEvents = [];
  const lockContext = new AsyncLocalStorage(), tails = new Map();
  const held = () => [...(lockContext.getStore() || [])];
  function outside(label) {assert.deepEqual(held(), [], `${label} must not await inside final-write locks`);}
  const AUTH = 'onstarvoice:auth-state', Q = 'onstarvoice:control-state-v1', L = 'fixture:execution-lock';
  const locks = {request(name, options, operation) {
    const current = held();
    assert.equal(options.mode, 'exclusive');
    if (name === AUTH) assert.deepEqual(current, []);
    else if (name === L) assert.deepEqual(current, [AUTH]);
    else if (name === Q) assert.ok(JSON.stringify(current) === JSON.stringify([AUTH]) || JSON.stringify(current) === JSON.stringify([AUTH, L]));
    else assert.fail(`unexpected lock ${name}`);
    const work = (tails.get(name) || Promise.resolve()).then(() => lockContext.run([...current, name], async () => {
      lockEvents.push(['enter', name]);
      try {return await operation();} finally {lockEvents.push(['leave', name]);}
    }));
    tails.set(name, work.catch(() => {}));
    return work;
  }};
  const hooks = {beforeSet: null, beforeQuery: null, beforeCreate: null, runtime: null};
  const storage = {
    async get(requested) {
      const list = requested == null ? Object.keys(store) : typeof requested === 'string' ? [requested] : requested;
      return Object.fromEntries(list.map(key => [key, clone(store[key])]));
    },
    async set(patch) {
      if (hooks.beforeSet) await hooks.beforeSet(patch, {held: held()});
      writes.push(clone(patch)); Object.assign(store, clone(patch));
    },
    async remove(requested) {for (const key of typeof requested === 'string' ? [requested] : requested) delete store[key];},
  };
  class ClockDate extends Date {
    constructor(...args) {super(...(args.length ? args : [time]));}
    static now() {return time;}
  }
  const context = vm.createContext({Date: ClockDate, URL, URLSearchParams, TextEncoder, AbortController,
    crypto: {randomUUID, subtle: webcrypto.subtle}, navigator: {locks}, setTimeout, clearTimeout,
    console, fetch() {assert.fail('no network is available in the local recovery harness');}});
  for (const path of ['utils/task-center.js', 'utils/capture/task-center-projection.js',
    'utils/control/state-fence.js', 'utils/control/active-stop-authority.js',
    'utils/control/local-capture-authority.js', 'utils/control/local-capture-source.js',
    'utils/control/stop-journal.js', 'utils/capture/lifecycle/strict-control.js',
    'utils/capture/lifecycle/local-recovery.js']) {
    vm.runInContext(read(path), context, {filename: path});
  }
  const actual = installActualBackgroundBuilders(context), builders = actual.api;
  const journal = context.OnStarvoiceStopJournal.create({storage, fence: context.OnStarvoiceControlStateFence,
    keys, now: () => time, runReservationOperation: operation => locks.request(L, {mode: 'exclusive'}, operation)});
  const authority = context.OnStarvoiceLocalCaptureAuthority.create({now: () => time,
    query: async (body, options) => {
      outside('authority'); queries.push(clone(body));
      assert.equal(options.rawAuth.captureAgent.token, store.auth.captureAgent.token);
      if (hooks.beforeQuery) {
        const override = await hooks.beforeQuery(body, options);
        if (override) return override;
      }
      return {ok: true, decision: 'allow', reason: 'local_control_authorized', action: body.action,
        policyVersion: 'local-capture-control-v1', ...binding, authorityRevision: 'b'.repeat(64),
        source: clone(body.source), evaluatedAt: new Date(time).toISOString(), expiresAt: new Date(time + 4000).toISOString()};
    }});
  const localSource = context.OnStarvoiceLocalCaptureSource.create({authority});
  let captureControl, recovery;
  function project(ledger, request, previousRequest) {
    const result = builders.upsertUnattendedTaskLedger(ledger, request, {previousRequest, now: request.updatedAt});
    assert.equal(result.accepted, true, `real ledger projection: ${result.reason}`);
    return result.ledger;
  }
  function makeWorker(nextEpoch = epoch) {
    epoch = nextEpoch;
    captureControl = context.OnStarvoiceStrictCaptureControl.create({journal, authority: {evaluate() {assert.fail('cloud authority cannot authorize local recovery');}},
      localSource, extensionId, workerEpoch: epoch, now: () => time, randomId: randomUUID,
      resolveDocument: async () => {outside('document lookup'); assert.fail('no platform documents are needed before the synthetic capture boundary');},
      sendPage: async () => {outside('page'); pageEffects.push('unexpected'); assert.fail('no platform capture');},
      createTab: async () => {outside('page create'); pageEffects.push('unexpected'); assert.fail('no platform tabs');},
      admitWhileLegacyIdle: operation => operation(), pause: async () => {outside('pause');}});
    recovery = context.OnStarvoiceLocalRecovery.create({journal, authority, captureControl, extensionId,
      normalizePlan: builders.normalizeUnattendedKeywordPlan,
      buildOriginal: builders.buildUnattendedKeywordRequest,
      buildRecovery: builders.buildLocalRecoveryRequest, project,
      createRunner: async (request, launchIntentId) => {
        outside('dormant shell create');
        const id = 80 + creates.length;
        const url = `chrome-extension://${extensionId}/sidebar/sidebar.html?unattendedRun=${request.id}&unattendedAttempt=${request.attemptId}&localRecoveryIntent=${launchIntentId}`;
        const spec = {id, url, active: false, request: clone(request), launchIntentId};
        creates.push(spec);
        if (hooks.beforeCreate) await hooks.beforeCreate(spec);
        return {id, url};
      }, afterPlanSaved: async () => {outside('post-save hook');}, now: () => time, randomId: randomUUID});
    return {captureControl, recovery};
  }
  makeWorker();
  function sender(documentId, tabId = 7, url = `chrome-extension://${extensionId}/sidebar/sidebar.html`) {
    return {id: extensionId, documentId, frameId: 0, documentLifecycle: 'active', tab: {id: tabId}, url};
  }
  const clientSender = sender('local-control-client', 70);
  function connect(from, name) {
    let disconnected = false;
    const outgoing = [], onMessage = event(), onDisconnect = event();
    const server = {name, sender: from, onDisconnect, postMessage(message) {
      outside('port notification'); outgoing.push(clone(message)); onMessage.emit(clone(message));
    }};
    const client = {name, onMessage, onDisconnect};
    server.disconnect = client.disconnect = () => {if (!disconnected) {disconnected = true; onDisconnect.emit();}};
    const accepted = recovery.attachPort(server) || captureControl.attachPort(server);
    assert.equal(accepted, true, name);
    return {server, client, outgoing};
  }
  let clientConnection = connect(clientSender, context.OnStarvoiceLocalRecovery.CLIENT_PORT);
  async function send(message, from = clientSender) {
    messages.push({message: clone(message), sender: clone(from)});
    if (recovery.accepts(message.type)) return recovery.handle(message, from);
    if (captureControl.accepts(message.type)) return captureControl.handle(message, from);
    if (hooks.runtime) return hooks.runtime(message, from);
    throw new Error(`unimplemented synthetic runtime seam ${message.type}`);
  }
  async function savePlan(patch = {}) {
    return send({type: context.OnStarvoiceLocalRecovery.SAVE, candidate: true,
      plan: {enabled: true, platform: 'xiaohongshu', keywords: ['synthetic-one', 'synthetic-two'], ...patch}});
  }
  async function createOriginal(options = {}) {
    return recovery.maybeCreateOriginal(clone(store.plan), options);
  }
  async function originalRunning() {
    const r = store.request;
    assert.ok(r?.strictControlCandidate && store[LOCAL_KEYS.origin]?.request, 'the actual local source writer must run first');
    time += 1;
    const from = sender('original-owner', 7,
      `chrome-extension://${extensionId}/sidebar/sidebar.html?unattendedRun=${r.id}&unattendedAttempt=${r.attemptId}`);
    // Explicit original claim/running seam. We do not create an original browser
    // tab: it is a memory sender with the exact fields the old claim establishes.
    await journal.localTransaction(fresh => {
      const at = new Date(time).toISOString();
      const request = {...fresh.request, status: 'running', progressSeq: 1, claimedAt: at, startedAt: at,
        updatedAt: at, heartbeatAt: at, businessProgressAt: at, runnerTabId: 7};
      const lock = {id: randomUUID(), owner: 'unattended_keyword_plan', holderId: 'original-holder',
        holderDocumentId: from.documentId, holderTabId: 7, captureTaskId: '', captureTaskAttemptId: '', expiresAt: time + 60000};
      return {patch: {request, lock, ledger: project(fresh.ledger, request, fresh.request)}, result: true};
    });
    const port = connect(from, context.OnStarvoiceStrictCaptureControl.PORT);
    const result = await send({type: 'onstarvoice:strict-owner-bind', requestId: r.id, attemptId: r.attemptId}, from);
    if (!result.ok) return {result, from, port};
    const client = createPageOperationClient({strictControl: result.strictControl,
      chromeApi: {runtime: {sendMessage: message => send(message, from)}}});
    port.client.onMessage.addListener(message => {
      if (message.type === 'capture-owner:strict-stop') client.stop(message.strictControl, message.reason);
    });
    return {result, from, port, client, control: result.strictControl};
  }
  async function stopOriginal(original, {pendingUploads = 1} = {}) {
    const ready = await send({type: 'onstarvoice:prepare-active-capture-stop', action: 'stop_local_capture'}, original.from);
    assert.equal(ready.ok, true, JSON.stringify(ready));
    const accepted = await send({type: 'onstarvoice:execute-active-capture-stop', action: 'stop_local_capture', handle: ready.handle}, original.from);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const receipt = await original.client.drain();
    for (const type of ['onstarvoice:strict-owner-settled', 'onstarvoice:strict-owner-release']) {
      const response = await send({type, strictControl: original.control, ...receipt, pendingUploads}, original.from);
      assert.equal(response.ok, true, JSON.stringify(response));
    }
    await until(async () => {
      const inspected = await send({type: 'onstarvoice:inspect-active-capture-stop'}, original.from);
      return inspected.sourceStopped === true;
    }, 'accurate original stop');
    return clone(store[LOCAL_KEYS.journal].receipt);
  }
  async function stoppedOriginal() {
    assert.equal((await savePlan()).ok, true);
    assert.equal((await createOriginal()).handled, true);
    const original = await originalRunning();
    assert.equal(original.result.ok, true, JSON.stringify(original.result));
    await original.client.runProducer('synthetic-original-no-capture', async () => 'settled');
    await stopOriginal(original);
    return original;
  }
  function prepare(mode = 'remaining') {
    return send({type: 'onstarvoice:local-recovery-prepare', requestId: store.request.id, attemptId: store.request.attemptId, mode});
  }
  function shellSender(spec = creates.at(-1), overrides = {}) {
    return {...sender(`recovery-document-${spec.id}`, spec.id, spec.url), ...overrides};
  }
  function shell({spec = creates.at(-1), from = shellSender(spec)} = {}) {
    const connected = [];
    const lifecycle = new Map();
    const chromeApi = {runtime: {
      getURL: path => `chrome-extension://${extensionId}/${path}`,
      connect({name}) {const pair = connect(from, name); connected.push(pair); return pair.client;},
      sendMessage: message => send(message, from),
    }, storage: {local: storage}};
    const gate = createLocalRecoveryRunnerGate({location: {search: new URL(from.url).search}, chromeApi,
      lifecycle: {addEventListener: (name, callback) => lifecycle.set(name, callback)}});
    return {gate, from, chromeApi, connected, lifecycle,
      start: () => gate.waitForActivation({holderId: 'successor-holder'})};
  }
  return {store, keys, binding, context, journal, authority, localSource, builders,
    builderDeclarations: actual.declarations, writes, queries, creates, pageEffects, messages, hooks,
    storage, project, held, lockEvents, sender, clientSender, connect, send,
    savePlan, createOriginal, originalRunning, stopOriginal, stoppedOriginal, prepare, shellSender, shell,
    get captureControl() {return captureControl;}, get recovery() {return recovery;},
    get clientConnection() {return clientConnection;}, now: () => time, advance: ms => {time += ms;},
    restart() {makeWorker(`local-worker-${randomUUID()}`); clientConnection = connect(clientSender, context.OnStarvoiceLocalRecovery.CLIENT_PORT);},
  };
}
