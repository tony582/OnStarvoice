// Real background declarations/listeners, not a duplicate message router.
// Browser ports, network responses and the original claim/running reservation
// are explicit memory seams. No startup, browser, DB or collection runs here.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {parseSidebarAst} from '../helpers/sidebar-controller-ast.mjs';
import {createLocalRecoveryHarness, LOCAL_KEYS, clone, tick, until} from '../helpers/local-recovery-harness.mjs';
import {createPageOperationClient} from '../../utils/capture/page-operation-client.js';
import {createLocalRecoveryRunnerGate, consumeLocalRecoveryOwnerHandoff} from '../../sidebar/recovery-runner-gate.js';

const source = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');
const ast = parseSidebarAst(source), declarations = new Map();
for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration') declarations.set(node.id.name, node);
  if (node.type === 'VariableDeclaration') for (const entry of node.declarations) {
    if (entry.id.type === 'Identifier') declarations.set(entry.id.name, node);
  }
}
function declaration(name) {
  const node = declarations.get(name);
  assert.ok(node, `actual background declaration ${name}`);
  return source.slice(...node.range);
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (['range', 'loc', 'tokens', 'comments'].includes(key)) continue;
    if (Array.isArray(child)) child.forEach(value => walk(value, visit));
    else walk(child, visit);
  }
}
function event() {
  const listeners = [];
  return {addListener: fn => listeners.push(fn), emit: value => listeners.forEach(fn => fn(value))};
}

function entryHarness() {
  const h = createLocalRecoveryHarness(), c = h.context;
  const connections = [], listeners = [], network = [], creates = [], alarms = [], messages = [], legacyPorts = [];
  const counts = {strict: 0, local: 0}, originalStrict = c.OnStarvoiceStrictCaptureControl,
    originalLocal = c.OnStarvoiceLocalRecovery;
  c.OnStarvoiceStrictCaptureControl = {...originalStrict, create(ports) {
    counts.strict += 1; return originalStrict.create(ports);
  }};
  c.OnStarvoiceLocalRecovery = {...originalLocal, create(ports) {
    counts.local += 1; return originalLocal.create(ports);
  }};
  vm.runInContext(`${declaration('STORAGE_KEYS')};globalThis.entryKeys=STORAGE_KEYS;`, c);
  const aliases = new Map([
    [c.entryKeys.auth, 'auth'], [c.entryKeys.unattendedKeywordRunRequest, 'request'],
    [c.entryKeys.taskLedger, 'ledger'], [c.entryKeys.unattendedKeywordRunArchive, 'archive'],
    [c.entryKeys.captureExecutionLock, 'lock'], [c.entryKeys.unattendedKeywordPlan, 'plan'],
  ]);
  const storage = {
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      const data = await h.storage.get(list.map(key => aliases.get(key) || key));
      return Object.fromEntries(list.map(key => [key, data[aliases.get(key) || key]]));
    },
    set: patch => h.storage.set(Object.fromEntries(Object.entries(patch).map(([key, value]) => [aliases.get(key) || key, value]))),
    remove: keys => h.storage.remove((typeof keys === 'string' ? [keys] : keys).map(key => aliases.get(key) || key)),
  };
  c.chrome = {
    runtime: {id: h.clientSender.id, getURL: path => `chrome-extension://${h.clientSender.id}/${path}`,
      onConnect: {addListener: fn => connections.push(fn)}, onMessage: {addListener: fn => listeners.push(fn)}},
    storage: {local: storage},
    alarms: {
      clear: async name => {assert.deepEqual(h.held(), []); alarms.push(['clear', name]); return true;},
      create: async (name, options) => {assert.deepEqual(h.held(), []); alarms.push(['create', name, clone(options)]);},
    },
    tabs: {
      create: async properties => {
        assert.deepEqual(h.held(), [], 'runner creation is outside write locks');
        assert.deepEqual(Object.keys(properties).sort(), ['active', 'url']);
        assert.equal(properties.active, false);
        const url = new URL(properties.url);
        assert.equal(url.protocol, 'chrome-extension:');
        assert.equal(url.hostname, h.clientSender.id);
        assert.equal(url.pathname, '/sidebar/sidebar.html');
        assert.ok(url.searchParams.get('localRecoveryIntent'), 'only dormant recovery shell creation is permitted');
        const tab = {id: 80 + creates.length, ...clone(properties)};
        creates.push(tab); return tab;
      },
      sendMessage() {assert.fail('no platform page is needed before the capture boundary');},
    },
    scripting: {executeScript() {assert.fail('no real or synthetic platform injection is needed');}},
  };
  c.__ONSTARVOICE_BUILD_TARGET__ = 'local';
  c.__ONSTARVOICE_API_BASE_URL__ = 'http://127.0.0.1:19431';
  c.fetch = async (url, options) => {
    assert.deepEqual(h.held(), [], 'authority fetch cannot run inside final write locks');
    assert.equal(String(url), 'http://127.0.0.1:19431/api/capture-cloud/agent/local-control-authority',
      'local sources must never fall through to cloud stop authority');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, `Bearer ${h.store.auth.captureAgent.token}`);
    const body = JSON.parse(options.body); network.push({url: String(url), body});
    return {ok: true, json: async () => ({ok: true, decision: 'allow', reason: 'local_control_authorized',
      action: body.action, policyVersion: 'local-capture-control-v1', ...h.binding,
      authorityRevision: 'b'.repeat(64), source: clone(body.source),
      evaluatedAt: new Date(h.now()).toISOString(), expiresAt: new Date(h.now() + 4000).toISOString()})};
  };
  // The real journal/fence owns Auth -> L -> Q. Only the empty legacy executor
  // admission is a seam: no background startup means there are no old entrants.
  c.runCaptureExecutionLockOperation = operation => c.navigator.locks.request('fixture:execution-lock', {mode: 'exclusive'}, operation);
  c.captureLifecycle = {admitStrictCaptureCohort: operation => operation()};
  c.captureTaskOwnerCoordinator = {attachPort: port => {legacyPorts.push(port.name); return false;}};
  c.handleTerminalMetadataConnection = () => false;
  const existing = new Set(h.builderDeclarations), selected = new Set();
  function include(name) {
    if (existing.has(name)) return;
    const node = declarations.get(name);
    assert.ok(node, name);
    if (selected.has(node)) return;
    selected.add(node);
    walk(node, child => {if (child.type === 'Identifier' && declarations.has(child.name)) include(child.name);});
  }
  ['computeNextUnattendedRunAt', 'syncUnattendedKeywordAlarm', 'buildUnattendedRunnerUrl',
    'CAPTURE_EXECUTION_LOCK_LEASE_MS'].forEach(include);
  assert.ok(selected.size < 25, 'only original schedule/URL helper dependencies');
  const exact = ['strictCaptureControl', 'localRecoveryControl', 'hasStrictCaptureStopControl',
    'assertLegacyCaptureControlAvailable', 'queryActiveStopAuthority', 'queryLocalCaptureAuthority',
    'getStrictCaptureControl', 'getLocalRecoveryControl', 'strictLifecycleGuard'];
  const routerStart = source.indexOf('chrome.runtime.onConnect.addListener(');
  assert.ok(routerStart > 0);
  vm.runInContext(`${[...selected].sort((a, b) => a.range[0] - b.range[0]).map(node => source.slice(...node.range)).join('\n')}
    ${exact.map(declaration).join('\n')}
    ${source.slice(routerStart)}
    globalThis.entryLocal=()=>getLocalRecoveryControl();
    globalThis.entryStrict=()=>getStrictCaptureControl();
    globalThis.entryPeek=()=>({strict:strictCaptureControl,local:localRecoveryControl});`, c,
  {filename: 'actual-background-local-entry.js'});
  assert.equal(connections.length, 3); assert.equal(listeners.length, 1);
  function connect(from, name) {
    let disconnected = false;
    const onMessage = event(), onDisconnect = event(), outgoing = [];
    const server = {name, sender: from, onDisconnect, postMessage(message) {
      assert.deepEqual(h.held(), []); outgoing.push(clone(message)); onMessage.emit(clone(message));
    }};
    const client = {name, onMessage, onDisconnect};
    server.disconnect = client.disconnect = () => {if (!disconnected) {disconnected = true; onDisconnect.emit();}};
    connections.forEach(listener => listener(server));
    return {server, client, outgoing};
  }
  const send = (message, from = h.clientSender) => new Promise(resolve => {
    messages.push({message: clone(message), sender: clone(from)});
    assert.equal(listeners[0](message, from, resolve), true, 'real asynchronous onMessage channel stays open');
  });
  const savePlan = () => send({type: originalLocal.SAVE, candidate: true,
    plan: {enabled: true, mode: 'daily', randomOffsetMin: 0, platform: 'xiaohongshu', keywords: ['synthetic-only']}});
  return {...h, send, connect, savePlan, network, creates, alarms, messages, counts, legacyPorts,
    peek: c.entryPeek, local: c.entryLocal, strict: c.entryStrict};
}

async function stoppedEntry() {
  const h = entryHarness();
  h.connect(h.clientSender, h.context.OnStarvoiceLocalRecovery.CLIENT_PORT);
  await tick();
  assert.equal((await h.savePlan()).ok, true);
  const original = await h.local().maybeCreateOriginal(clone(h.store.plan), {});
  assert.equal(original.handled, true);
  const request = h.store.request;
  const from = h.sender('original-router-owner', 7,
    `chrome-extension://${h.clientSender.id}/sidebar/sidebar.html?unattendedRun=${request.id}&unattendedAttempt=${request.attemptId}`);
  h.advance(1);
  // Original claim/running is the explicit no-browser seam; both local origin
  // and the original request/ledger are produced by real background builders.
  await h.strict().localJournal.localTransaction(fresh => {
    const at = new Date(h.now()).toISOString();
    const next = {...fresh.request, status: 'running', progressSeq: 1, claimedAt: at, startedAt: at,
      updatedAt: at, heartbeatAt: at, businessProgressAt: at, runnerTabId: 7};
    return {patch: {request: next, ledger: h.project(fresh.ledger, next, fresh.request),
      lock: {id: randomUUID(), owner: 'unattended_keyword_plan', holderId: 'original-holder',
        holderDocumentId: from.documentId, holderTabId: 7, captureTaskId: '', captureTaskAttemptId: '',
        expiresAt: h.now() + 60000}}, result: true};
  });
  const pair = h.connect(from, h.context.OnStarvoiceStrictCaptureControl.PORT);
  const bound = await h.send({type: 'onstarvoice:strict-owner-bind', requestId: request.id, attemptId: request.attemptId}, from);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const client = createPageOperationClient({strictControl: bound.strictControl,
    chromeApi: {runtime: {sendMessage: message => h.send(message, from)}}});
  pair.client.onMessage.addListener(message => {
    if (message.type === 'capture-owner:strict-stop') client.stop(message.strictControl, message.reason);
  });
  await client.runProducer('memory-only-original-owner', async () => 'settled-without-page');
  const ready = await h.send({type: 'onstarvoice:prepare-active-capture-stop', action: 'stop_local_capture'}, from);
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal((await h.send({type: 'onstarvoice:execute-active-capture-stop', action: 'stop_local_capture', handle: ready.handle}, from)).ok, true);
  const drain = await client.drain();
  for (const type of ['onstarvoice:strict-owner-settled', 'onstarvoice:strict-owner-release']) {
    assert.equal((await h.send({type, strictControl: bound.strictControl, ...drain, pendingUploads: 1}, from)).ok, true);
  }
  await until(async () => (await h.send({type: 'onstarvoice:inspect-active-capture-stop'}, from)).sourceStopped === true);
  return h;
}

test('real onConnect leaves ordinary ports lazy; local and strict ports share exactly one journal/control instance', async () => {
  const h = entryHarness();
  assert.equal(h.peek().local, null); assert.equal(h.peek().strict, null);
  h.connect(h.clientSender, 'ordinary-unrelated-port');
  assert.equal(h.peek().local, null); assert.equal(h.peek().strict, null);
  assert.deepEqual(h.counts, {strict: 0, local: 0});
  h.connect(h.clientSender, h.context.OnStarvoiceLocalRecovery.CLIENT_PORT);
  const local = h.local(), strict = h.strict();
  h.connect(h.sender('unrelated-strict-owner'), h.context.OnStarvoiceStrictCaptureControl.PORT);
  h.connect(h.clientSender, h.context.OnStarvoiceLocalRecovery.CLIENT_PORT);
  assert.equal(h.local(), local); assert.equal(h.strict(), strict);
  assert.deepEqual(h.counts, {strict: 1, local: 1});
  await tick();
  assert.equal(h.network.length, 0); assert.equal(h.writes.length, 0);
  assert.equal(h.creates.length, 0); assert.equal(h.alarms.length, 0);
  assert.equal(h.legacyPorts.length, 4, 'existing owner listener remains registered without authorizing local work');
});

test('real save-plan onMessage uses lazy factory, exact storage keys and original schedule/alarm ports', async () => {
  const h = entryHarness();
  const denied = await h.savePlan();
  assert.equal(denied.ok, false, 'onMessage alone cannot invent the connected control client');
  assert.equal(h.writes.length, 0); assert.equal(h.network.length, 0);
  h.connect(h.clientSender, h.context.OnStarvoiceLocalRecovery.CLIENT_PORT);
  const response = await h.savePlan();
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(h.store.plan.enabled, true); assert.ok(Date.parse(h.store.plan.nextRunAt) > h.now());
  assert.ok(h.store[LOCAL_KEYS.origin].plan);
  assert.deepEqual(h.network.map(row => row.body.action), ['admit_local_plan']);
  assert.equal(h.store.request, null); assert.equal(h.creates.length, 0);
  assert.equal(h.alarms.length, 2);
  assert.deepEqual(h.alarms[0], ['clear', 'onstarvoice:unattended-keyword-plan']);
  assert.equal(h.alarms[1][0], 'create');
  assert.equal(h.alarms[1][2].when, Date.parse(h.store.plan.nextRunAt));
});

test('actual background router completes genuine local stop -> dormant create -> same-document gate claim generation 2', async () => {
  const h = await stoppedEntry();
  const oldRequest = clone(h.store.request), oldJournal = clone(h.store[LOCAL_KEYS.journal]);
  const prepared = await h.send({type: 'onstarvoice:local-recovery-prepare', requestId: oldRequest.id,
    attemptId: oldRequest.attemptId, mode: 'remaining'});
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(h.creates.length, 1); assert.equal(h.store.request.id, oldRequest.id);
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'prepared');
  const spec = h.creates[0], url = new URL(spec.url);
  assert.equal(url.searchParams.get('localRecoveryIntent'), prepared.launchIntentId);
  assert.equal(url.searchParams.get('unattendedRun'), prepared.requestId);
  assert.equal(url.searchParams.get('unattendedAttempt'), prepared.attemptId);
  const from = h.sender('successor-router-document', spec.id, spec.url), pairs = [];
  const gate = createLocalRecoveryRunnerGate({location: {search: url.search},
    chromeApi: {runtime: {
      connect({name}) {const pair = h.connect(from, name); pairs.push(pair); return pair.client;},
      sendMessage: message => h.send(message, from),
    }}, lifecycle: {addEventListener() {}}});
  const handoff = consumeLocalRecoveryOwnerHandoff(await gate.waitForActivation({holderId: 'successor-router-holder'}));
  assert.equal(handoff.port, pairs[0].client); assert.equal(pairs.length, 1);
  assert.equal(handoff.claim.strictControl.generation, 2);
  assert.equal(handoff.claim.strictControl.ownerDocumentId, from.documentId);
  assert.equal(handoff.claim.lock.holderDocumentId, from.documentId);
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'claimed');
  assert.deepEqual(h.store[LOCAL_KEYS.journal].retired, [oldJournal]);
  assert.equal(h.store.request.parentRequestId, oldRequest.id);
  assert.equal(h.messages.filter(row => row.message.type === 'onstarvoice:local-recovery-runner-claim').length, 1);
  assert.equal(h.messages.filter(row => row.message.type === 'onstarvoice:strict-owner-bind').length, 1,
    'successor does not re-enter cloud/old BIND');
  assert.deepEqual(h.counts, {strict: 1, local: 1});
  assert.ok(h.network.some(row => row.body.action === 'recover_local_capture'));
  assert.equal(h.store.unsyncedRecords.length, 1); assert.equal(h.store.checkpointOutbox.length, 1);
  const claims = h.messages.find(row => row.message.type === 'onstarvoice:local-recovery-runner-claim').message;
  assert.equal((await h.send(claims, from)).ok, false, 'router cannot claim twice');
  for (const type of ['onstarvoice:switch-platform-tab', 'onstarvoice:relay-to-content', 'onstarvoice:cancel-unattended-keyword-run']) {
    assert.equal((await h.send({type, tabId: 7, platform: 'douyin', payload: {action: 'captureSingleNote'}}, from)).ok, false);
  }
  assert.equal(h.creates.length, 1, 'only the inactive extension shell, no platform page');
});

test('actual local onMessage catches lazy factory failure and never reaches a legacy fallback', async () => {
  const h = entryHarness();
  h.context.OnStarvoiceLocalRecovery = {...h.context.OnStarvoiceLocalRecovery,
    create() {throw new Error('synthetic module initialization failure');}};
  const result = await h.send({type: 'onstarvoice:local-recovery-prepare'});
  assert.deepEqual(clone(result), {ok: false, accepted: false, reason: 'local_control_unavailable'});
  assert.equal(h.peek().local, null); assert.equal(h.writes.length, 0);
  assert.equal(h.network.length, 0); assert.equal(h.creates.length, 0);
});

test('actual local router denies unknown local messages instead of feeding them into old control paths', async () => {
  const h = entryHarness();
  h.connect(h.clientSender, h.context.OnStarvoiceLocalRecovery.CLIENT_PORT);
  const result = await h.send({type: 'onstarvoice:local-recovery-unknown', action: 'captureProgress'});
  assert.equal(result.ok, false);
  assert.equal(h.network.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.creates.length, 0);
});

function queryHarness({base, target, response = {ok: true, json: async () => ({synthetic: true})}} = {}) {
  const calls = [], context = vm.createContext({URL, __ONSTARVOICE_API_BASE_URL__: base,
    __ONSTARVOICE_BUILD_TARGET__: target, fetch: async (url, options) => {calls.push({url: String(url), options}); return response;}});
  vm.runInContext(`${declaration('queryLocalCaptureAuthority')};globalThis.query=queryLocalCaptureAuthority;`, context);
  return {calls, query: context.query};
}
for (const [base, target, origin] of [
  [undefined, undefined, 'https://voice.minilife.online'],
  ['https://voice.minilife.online', 'production', 'https://voice.minilife.online'],
  ['https://voice.minilife.online/', 'local', 'https://voice.minilife.online'],
  ['http://127.0.0.1:19431', 'local', 'http://127.0.0.1:19431'],
  ['http://localhost:19431/', 'local', 'http://localhost:19431'],
]) test(`real authority request uses the distinct endpoint with explicit credential/redirect policy: ${base || 'default'}/${target}`, async () => {
  const h = queryHarness({base, target}), controller = new AbortController();
  const body = {action: 'recover_local_capture', source: {requestId: 'synthetic-request', attemptId: 'synthetic-attempt'}};
  const result = await h.query(body, {rawAuth: {captureAgent: {token: 'synthetic-secret'}}, signal: controller.signal});
  assert.deepEqual(result, {synthetic: true}); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${origin}/api/capture-cloud/agent/local-control-authority`);
  const options = h.calls[0].options;
  assert.deepEqual(Object.keys(options).sort(), ['body', 'cache', 'credentials', 'headers', 'method', 'redirect', 'signal']);
  assert.equal(options.method, 'POST'); assert.equal(options.signal, controller.signal);
  assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
  assert.deepEqual(clone(options.headers), {'Content-Type': 'application/json', Authorization: 'Bearer synthetic-secret'});
  assert.deepEqual(JSON.parse(options.body), body); assert.equal(options.body.includes('synthetic-secret'), false);
});
for (const [base, target] of [
  ['https://attacker.invalid', 'local'], ['http://voice.minilife.online', 'production'],
  ['https://voice.minilife.online.attacker.invalid', 'production'], ['https://voice.minilife.online:8443', 'production'],
  ['https://localhost:19431', 'local'], ['http://127.0.0.1:19431', undefined],
  ['http://localhost:19431', 'production'], ['http://[::1]:19431', 'local'],
  ['https://username:password@voice.minilife.online', 'production'], ['http://username@localhost:19431', 'local'],
  ['https://voice.minilife.online/api', 'production'], ['http://localhost:19431/api', 'local'],
  ['https://voice.minilife.online/?query=1', 'production'], ['http://localhost:19431/#fragment', 'local'],
  ['file:///tmp/authority', 'local'], ['not a URL', 'local'],
]) test(`real authority URL policy rejects before fetch: ${base}/${target}`, async () => {
  const h = queryHarness({base, target});
  await assert.rejects(h.query({action: 'recover_local_capture'}, {rawAuth: {captureAgent: {token: 'synthetic'}}}));
  assert.equal(h.calls.length, 0);
});
for (const failure of ['http', 'json', 'network']) test(`real authority ${failure} failure has no retry, redirect or cloud fallback`, async () => {
  let jsonCalls = 0;
  const h = queryHarness({response: {ok: failure !== 'http', json: async () => {jsonCalls += 1; throw new Error('synthetic invalid JSON');}}});
  if (failure === 'network') {
    // A rejecting response promise reproduces fetch failure before JSON.
    const original = queryHarness({response: Promise.reject(new Error('synthetic network rejection'))});
    await assert.rejects(original.query({}, {rawAuth: {captureAgent: {token: 'synthetic'}}}), /synthetic network rejection/);
    assert.equal(original.calls.length, 1); return;
  }
  await assert.rejects(h.query({}, {rawAuth: {captureAgent: {token: 'synthetic'}}}),
    failure === 'http' ? /local_authority_denied/ : /synthetic invalid JSON/);
  assert.equal(h.calls.length, 1); assert.equal(jsonCalls, failure === 'http' ? 0 : 1);
});
