import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createLocalRecoveryRunnerGate, consumeLocalRecoveryOwnerHandoff} from '../../sidebar/recovery-runner-gate.js';
import {createOwnerController} from '../../sidebar/task-controller/owner.js';
import {createUnattendedRunController} from '../../sidebar/task-controller/unattended-run.js';
import {parseSidebarAst, findSidebarFunctionAst} from '../helpers/sidebar-controller-ast.mjs';

const ids = {launchIntentId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222', attemptId: '33333333-3333-4333-8333-333333333333'};
const control = {...ids, version: 1, generation: 2, ownerDocumentId: 'exact-recovery-document'};
delete control.launchIntentId;
const search = `?localRecoveryIntent=${ids.launchIntentId}&unattendedRun=${ids.requestId}&unattendedAttempt=${ids.attemptId}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; }
function event() { const listeners = []; return {addListener: fn => listeners.push(fn), emit: message => listeners.forEach(fn => fn(message))}; }
function harness({bind = null, claim = null, query = search, runtime = null} = {}) {
  const messages = [], connections = [], lifecycleEvents = new Map();
  const port = {name: 'onstarvoice:local-recovery-runner-v1', onMessage: event(), onDisconnect: event()};
  let disconnected = false;
  port.disconnect = () => {if (!disconnected) {disconnected = true; port.onDisconnect.emit();}};
  const response = {ok: true, accepted: true, launchIntentId: ids.launchIntentId,
    scopeMode: 'cooperative', strictControl: control,
    data: {id: ids.requestId, attemptId: ids.attemptId, status: 'claimed', cloudAssigned: false,
      planSnapshot: {platform: 'xiaohongshu', keywords: ['synthetic-keyword']}},
    lock: {id: 'reserved-lock', holderId: 'fixture-holder', holderDocumentId: control.ownerDocumentId, holderTabId: 71}};
  const chromeApi = {runtime: {
    connect(options) {connections.push(options); return port;},
    getURL: path => `chrome-extension://fixture/${path}`,
    async sendMessage(message) {
      messages.push(message);
      if (message.type === 'onstarvoice:local-recovery-runner-bind') return bind ? bind(message) : {ok: true, phase: 'runner_bound'};
      if (message.type === 'onstarvoice:local-recovery-runner-claim') return claim ? claim(message, response) : response;
      if (runtime) return runtime(message);
      throw new Error(`Unexpected runtime call: ${message.type}`);
    },
  }, storage: {local: {get: async () => ({}), set: async () => {}, remove: async () => {}}}};
  const gate = createLocalRecoveryRunnerGate({location: {search: query}, chromeApi,
    lifecycle: {addEventListener: (name, fn) => lifecycleEvents.set(name, fn)}});
  const activate = (patch = {}) => port.onMessage.emit({type: 'onstarvoice:local-recovery-activated', ...ids, generation: 2, ...patch});
  return {gate, messages, connections, port, response, chromeApi, activate, lifecycleEvents};
}

test('ordinary pages stay synchronous and never connect or change initialization timing', () => {
  const h = harness({query: '?ordinary=1'});
  assert.equal(h.gate.isRecoveryRunner, false);
  assert.equal(h.gate.waitForActivation(), null);
  assert.equal(h.gate.assertActive(), undefined);
  assert.equal(h.connections.length, 0);
  assert.equal(h.messages.length, 0);
});

test('two bootstraps share one promise; binding or a notification alone cannot activate', async () => {
  const pending = deferred();
  const h = harness({claim: () => pending.promise});
  const ui = h.gate.waitForActivation();
  assert.equal(h.connections.length, 0, 'UI cannot invent a holder before the logic bootstrap');
  const logic = h.gate.waitForActivation({holderId: 'fixture-holder'});
  assert.equal(logic, ui);
  let initialized = false;
  logic.then(() => {initialized = true;});
  await tick();
  assert.equal(h.messages.length, 1);
  assert.equal(initialized, false);
  h.activate(); h.activate();
  await tick();
  assert.equal(h.messages.filter(m => m.type.endsWith('-claim')).length, 1);
  assert.equal(initialized, false);
  pending.resolve(h.response);
  const token = await logic;
  h.gate.assertActive();
  const handoff = consumeLocalRecoveryOwnerHandoff(token);
  assert.equal(handoff.port, h.port);
  assert.equal(handoff.claim.strictControl.ownerDocumentId, control.ownerDocumentId);
  assert.throws(() => consumeLocalRecoveryOwnerHandoff(token), {code: 'local_recovery_owner_handoff_required'});
  assert.throws(() => consumeLocalRecoveryOwnerHandoff({...h.response}), {code: 'local_recovery_owner_handoff_required'});
});

test('an activation racing bind confirmation waits for the actual bind result', async () => {
  const pending = deferred();
  const h = harness({bind: () => pending.promise});
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  h.activate();
  await tick();
  assert.equal(h.messages.length, 1);
  pending.resolve({ok: true, phase: 'runner_bound'});
  await ready;
  assert.equal(h.messages.length, 2);
});

test('late activation notifications cannot revoke or restart an already claimed successor', async () => {
  const h = harness();
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  h.activate();
  const token = await ready;
  h.activate({generation: 1});
  h.activate({requestId: 'old-request', attemptId: 'old-attempt', launchIntentId: 'old-intent'});
  for (const patch of [{generation: 1}, {requestId: 'old-request'}, {attemptId: 'old-attempt'}, {ownerDocumentId: 'old-document'}]) {
    h.port.onMessage.emit({type: 'capture-owner:strict-stop', strictControl: {...control, ...patch}});
  }
  h.gate.assertActive();
  assert.equal(consumeLocalRecoveryOwnerHandoff(token).claim.data.id, ids.requestId);
  assert.equal(h.connections.length, 1);
  assert.equal(h.messages.length, 2);
});

for (const [name, query] of [
  ['missing attempt', `?localRecoveryIntent=${ids.launchIntentId}&unattendedRun=${ids.requestId}`],
  ['duplicate intent', `${search}&localRecoveryIntent=${ids.launchIntentId}`],
  ['malformed intent', search.replace(ids.launchIntentId, 'not-a-uuid')],
]) test(`${name} keeps the shell inert before any connection`, async () => {
  const h = harness({query});
  await assert.rejects(h.gate.waitForActivation({holderId: 'fixture-holder'}), {code: 'local_recovery_runner_url_invalid'});
  assert.equal(h.connections.length, 0);
});

for (const patch of [{generation: 1}, {requestId: 'wrong'}, {attemptId: 'wrong'}, {launchIntentId: 'wrong'}]) {
  test(`bad activation/claim identity ${JSON.stringify(patch)} never releases initialization`, async () => {
    const h = harness();
    const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
    h.activate(patch);
    await assert.rejects(ready);
    assert.throws(() => h.gate.assertActive());
    assert.ok(h.messages.every(m => m.type.startsWith('onstarvoice:local-recovery-runner-')));
  });
}

for (const [name, change] of [
  ['rejected', response => ({...response, accepted: false})],
  ['wrong scope mode', response => ({...response, scopeMode: 'native'})],
  ['wrong owner document', response => ({...response, strictControl: {...control, ownerDocumentId: 'new-document'}})],
  ['wrong holder', response => ({...response, lock: {...response.lock, holderId: 'other-holder'}})],
  ['wrong request', response => ({...response, data: {...response.data, id: 'wrong'}})],
  ['wrong attempt', response => ({...response, data: {...response.data, attemptId: 'wrong'}})],
]) test(`claim ${name} fails closed without a legacy fallback`, async () => {
  const h = harness({claim: (_, response) => change(response)});
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  h.activate();
  await assert.rejects(ready, {code: 'local_recovery_claim_unconfirmed'});
  assert.equal(h.connections.length, 1);
  assert.equal(h.messages.length, 2);
});

for (const stage of ['bind', 'claim', 'claimed']) test(`disconnect/pagehide at ${stage} never resumes or changes documents`, async () => {
  const pending = deferred();
  const h = harness(stage === 'bind' ? {bind: () => pending.promise} :
    stage === 'claim' ? {claim: () => pending.promise} : {});
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  h.activate();
  if (stage === 'claimed') await ready;
  else await tick();
  h.lifecycleEvents.get('pagehide')({persisted: true});
  pending.resolve(stage === 'bind' ? {ok: true, phase: 'runner_bound'} : h.response);
  if (stage !== 'claimed') await assert.rejects(ready);
  assert.throws(() => h.gate.assertActive(), {code: 'local_recovery_runner_document_hidden'});
  h.activate();
  await tick();
  assert.equal(h.connections.length, 1);
  assert.ok(h.messages.length <= 2);
});

for (const stage of ['bind', 'claim', 'claimed']) test(`actual port loss at ${stage} permanently freezes this document`, async () => {
  const pending = deferred();
  const h = harness(stage === 'bind' ? {bind: () => pending.promise} :
    stage === 'claim' ? {claim: () => pending.promise} : {});
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  h.activate();
  if (stage === 'claimed') await ready;
  else await tick();
  h.port.disconnect();
  pending.resolve(stage === 'bind' ? {ok: true, phase: 'runner_bound'} : h.response);
  if (stage !== 'claimed') await assert.rejects(ready, {code: 'local_recovery_runner_disconnected'});
  assert.throws(() => h.gate.assertActive(), {code: 'local_recovery_runner_disconnected'});
  h.activate();
  assert.equal(h.connections.length, 1);
});

for (const stage of ['bind', 'claim']) test(`lost ${stage} response does not retry or fall back`, async () => {
  const rejected = () => Promise.reject(new Error('synthetic response loss'));
  const h = harness(stage === 'bind' ? {bind: rejected} : {claim: rejected});
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  h.activate();
  await assert.rejects(ready, {code: `local_recovery_${stage}_failed`});
  h.activate();
  await tick();
  assert.equal(h.connections.length, 1);
  assert.equal(h.messages.length, stage === 'bind' ? 1 : 2);
});

test('a stop after claim but before bootstrap adoption invalidates the handoff', async () => {
  const h = harness();
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  h.activate();
  const token = await ready;
  h.port.onMessage.emit({type: 'capture-owner:strict-stop', strictControl: control});
  assert.throws(() => consumeLocalRecoveryOwnerHandoff(token), {code: 'local_recovery_stop_before_adoption'});
  assert.throws(() => h.gate.assertActive(), {code: 'local_recovery_stop_before_adoption'});
});

test('a second bootstrap cannot replace the holder chosen by the first', async () => {
  const h = harness();
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  assert.equal(ready, h.gate.waitForActivation({holderId: 'other-holder'}));
  await assert.rejects(ready, {code: 'local_recovery_holder_mismatch'});
  h.activate();
  assert.equal(h.messages.length, 1);
});

function actualBootstraps(gate, onAdopt = () => {}) {
  const logic = readFileSync(new URL('../../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../sidebar/sidebar-ui.js', import.meta.url), 'utf8');
  const initNode = findSidebarFunctionAst(parseSidebarAst(logic), 'initSidebar');
  const uiNode = parseSidebarAst(ui).body.find(node => node.type === 'ExpressionStatement' &&
    node.expression?.callee?.object?.name === 'document' &&
    node.expression?.callee?.property?.name === 'addEventListener' &&
    node.expression.arguments[0]?.value === 'DOMContentLoaded').expression.arguments[1];
  const effects = [];
  const reached = new Error('exact existing bootstrap boundary reached');
  const context = vm.createContext({getLocalRecoveryRunnerGate: () => gate,
    CAPTURE_EXECUTION_LOCK_HOLDER_ID: 'fixture-holder',
    sidebarTaskController: {adoptLocalRecoveryRunnerOwner: onAdopt},
    console: {warn() {}, log() {effects.push('logic'); throw reached;}},
    initInstantTooltips() {effects.push('ui'); throw reached;},
  });
  vm.runInContext(`globalThis.logic = ${logic.slice(...initNode.range)};
    globalThis.ui = ${ui.slice(...uiNode.range)};`, context);
  return {effects, reached, logic: context.logic, ui: context.ui};
}

test('both actual bootstrap bodies execute no original initialization until the same document claim is confirmed', async () => {
  const h = harness();
  const adopted = [];
  const boots = actualBootstraps(h.gate, token => adopted.push(consumeLocalRecoveryOwnerHandoff(token)));
  const uiWork = boots.ui(), logicWork = boots.logic();
  const results = Promise.allSettled([uiWork, logicWork]);
  await tick();
  assert.deepEqual(boots.effects, []);
  assert.equal(adopted.length, 0);
  h.activate();
  const settled = await results;
  assert.deepEqual(boots.effects.sort(), ['logic', 'ui']);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].port, h.port);
  assert.ok(settled.every(value => value.status === 'rejected' && value.reason === boots.reached));
});

test('both actual bootstrap bodies return inert on binding failure', async () => {
  const h = harness({bind: () => ({ok: false})});
  const boots = actualBootstraps(h.gate, () => assert.fail('owner must not adopt'));
  await Promise.all([boots.ui(), boots.logic()]);
  assert.deepEqual(boots.effects, []);
});

test('ordinary actual bootstraps preserve their first synchronous legacy effect', async () => {
  const h = harness({query: ''});
  const boots = actualBootstraps(h.gate);
  const logic = boots.logic();
  assert.deepEqual(boots.effects, ['logic']);
  const ui = boots.ui();
  assert.deepEqual(boots.effects, ['logic', 'ui']);
  await Promise.allSettled([logic, ui]);
  assert.equal(h.messages.length, 0);
});

test('claim hands the same port to the real owner and actual unattended producer; stop prevents its first platform operation', async () => {
  let reachedRun = false;
  const h = harness({runtime: async message => {
    assert.notEqual(message.type, 'onstarvoice:claim-unattended-keyword-run');
    assert.notEqual(message.type, 'onstarvoice:strict-owner-bind');
    assert.notEqual(message.type, 'onstarvoice:strict-page-operation', 'no platform operation may dispatch');
    if (message.type === 'onstarvoice:update-unattended-keyword-run') return {ok: true, accepted: true};
    return {ok: true};
  }});
  const ready = h.gate.waitForActivation({holderId: 'fixture-holder'});
  h.activate();
  const token = await ready;
  const state = {captureTaskOwnerClosing: false, unattendedFinalFlushInFlightByIdentity: new Map(),
    unattendedFinalFlushRetryTimersByIdentity: new Map()};
  const ports = {
    chrome: h.chromeApi, localRecoveryRunnerGate: h.gate,
    CAPTURE_EXECUTION_LOCK_HOLDER_ID: 'fixture-holder', CAPTURE_TASK_OWNER_PORT_NAME: 'legacy-owner',
    UNATTENDED_RUN_QUERY_KEY: 'unattendedRun', UNATTENDED_RUN_ATTEMPT_QUERY_KEY: 'unattendedAttempt',
    TARGETED_POST_RUN_QUERY_KEY: 'targetedPostRun', MAX_BATCH_KEYWORDS: 30,
    UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS: [0], UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS: [0],
    UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS: 1000, KEYWORD_PLAN_TERMINAL_STATUSES: new Set(['failed']),
    KEYWORD_RUN_REQUEST_STORAGE_KEY: 'request',
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    console: {warn() {}, error() {}, debug() {}},
    taskView: {readRunnerLocationSearch: () => search},
    getCurrentRuntime: () => ({}), setCancelFlag() {}, showMessage() {}, closeBatchModal() {},
    loadKeywordPlanUI: async () => {},
    getKeywordExecutionCopy: () => ({taskLabel: 'synthetic task', executionMode: 'unattended_plan'}),
    normalizeUnattendedSearchPasses: () => [],
    normalizeUnattendedKeywordCheckpoint: () => ({round: 1, keywordResults: []}),
    findUnattendedResumeKeyword: () => 'synthetic-keyword',
    summarizeUnattendedKeywordCheckpoint: () => ({}),
    flushUnattendedCheckpointReportOutbox: async () => ({ok: true, remaining: 0}),
    isUnattendedSafetyBlock: () => false, hasSyncReconciliationSignal: () => false,
    renderCaptureDebugSession() {
      reachedRun = true;
      assert.ok(h.messages.some(message => message.type === 'onstarvoice:update-unattended-keyword-run' && message.patch.status === 'running'));
      h.port.onMessage.emit({type: 'capture-owner:strict-stop', strictControl: control});
    },
  };
  const operations = {dedupeKeywords: values => [...values], supportsPersistentCaptureTaskPlatform: () => true,
    rememberCaptureTaskProgressContext() {}};
  const owner = createOwnerController({controllerState: state, controllerPorts: ports, controllerOperations: operations});
  Object.assign(operations, owner);
  owner.adoptLocalRecoveryRunnerOwner(token);
  owner.connectCaptureTaskOwnerPort();
  assert.equal(h.connections.length, 1, 'no reconnect or legacy owner port');
  const runner = createUnattendedRunController({controllerState: state, controllerPorts: ports, controllerOperations: operations});
  await runner.maybeClaimAndRunUnattendedKeywordPlan({allowPending: true});
  assert.equal(reachedRun, true);
  assert.ok(h.messages.some(message => message.type === 'onstarvoice:strict-owner-activity-begin'));
  assert.ok(h.messages.some(message => message.type === 'onstarvoice:strict-owner-settled' && message.runnerQuiesced === true));
  assert.equal(h.messages.filter(message => message.type === 'onstarvoice:local-recovery-runner-claim').length, 1);
  await assert.rejects(runner.maybeClaimAndRunUnattendedKeywordPlan({allowPending: true}), {code: 'local_recovery_producer_unavailable'});
});
