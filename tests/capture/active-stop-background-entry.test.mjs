import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createActiveStopHarness} from '../helpers/active-stop-harness.mjs';
import {createPageOperationClient} from '../../utils/capture/page-operation-client.js';

const source = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function declaration(name) {
  const pattern = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const start = source.search(pattern);
  assert.notEqual(start, -1, name);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}
function entryHarness() {
  const h = createActiveStopHarness();
  const connections = [], listeners = [], native = [], network = [];
  const ports = h.createPorts();
  const actualKeysStart = source.indexOf('const STORAGE_KEYS = {');
  const actualKeys = source.slice(actualKeysStart, source.indexOf('\n};', actualKeysStart) + 3);
  const c = h.context;
  vm.runInContext(`${actualKeys};globalThis.fixtureKeys=STORAGE_KEYS;`, c);
  const aliases = new Map([
    [c.fixtureKeys.auth, 'auth'], [c.fixtureKeys.unattendedKeywordRunRequest, 'request'],
    [c.fixtureKeys.taskLedger, 'ledger'], [c.fixtureKeys.unattendedKeywordRunArchive, 'archive'],
    [c.fixtureKeys.captureExecutionLock, 'lock'],
  ]);
  const storage = {
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      const stored = await h.storage.get(list.map(key => aliases.get(key) || key));
      return Object.fromEntries(list.map(key => [key, stored[aliases.get(key) || key]]));
    },
    set(patch) {return h.storage.set(Object.fromEntries(Object.entries(patch).map(([key, value]) => [aliases.get(key) || key, value])));},
  };
  c.chrome = {
    runtime: {id: h.sender.id, onConnect: {addListener: fn => connections.push(fn)},
      onMessage: {addListener: fn => listeners.push(fn)}},
    storage: {local: storage},
    tabs: {
      sendMessage: (tabId, payload, options) => {
        assert.deepEqual(Object.keys(options), ['documentId']);
        return h.sendPage(tabId, payload, options.documentId);
      },
      create: async properties => {
        native.push(['create', properties]);
        return {id: 19, url: properties.url};
      },
    },
    scripting: {executeScript: async details => {
      assert.deepEqual(Array.from(details.target.frameIds), [0]);
      assert.equal(details.func(), null, 'background lookup cannot produce page effects');
      const doc = await h.resolveDocument(details.target.tabId);
      return [{frameId: 0, documentId: doc.documentId}];
    }},
  };
  class ClockDate extends Date {
    constructor(...args) {super(...(args.length ? args : [ports.now()]));}
    static now() {return ports.now();}
  }
  c.Date = ClockDate; c.console = console;
  c.__ONSTARVOICE_BUILD_TARGET__ = 'local';
  c.__ONSTARVOICE_API_BASE_URL__ = 'http://127.0.0.1:19431';
  c.fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:19431/api/capture-cloud/agent/stop-authority');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    network.push(JSON.parse(options.body));
    const current = c.OnStarvoiceActiveStopAuthority.candidate(await ports.journal.read(), {allowReservation: true});
    const evaluation = await h.authority.evaluate(current);
    return {ok: true, json: async () => evaluation.authority};
  };
  c.captureLifecycle = {admitStrictCaptureCohort: operation => operation()};
  c.runCaptureExecutionLockOperation = operation => operation();
  c.captureTaskOwnerCoordinator = {attachPort: () => false};
  c.handleTerminalMetadataConnection = () => false;
  const functions = ['hasStrictCaptureStopControl', 'assertLegacyCaptureControlAvailable',
    'queryActiveStopAuthority', 'getStrictCaptureControl', 'strictLifecycleGuard'];
  vm.runInContext(`let strictCaptureControl=null;${functions.map(declaration).join('\n')}
    ${source.slice(source.indexOf('chrome.runtime.onConnect.addListener('))}
    globalThis.fixtureControl=()=>getStrictCaptureControl();`, c);
  const ownerPort = h.ownerPort();
  for (const listener of connections) listener(ownerPort);
  assert.equal(listeners.length, 1);
  const send = (message, sender = h.sender) => new Promise(resolve => {
    assert.equal(listeners[0](message, sender, resolve), true);
  });
  return {...h, send, network, native, backgroundControl: c.fixtureControl()};
}

test('real background messages bind and dispatch a real scoped producer then accept stop before missing page replies', async () => {
  const h = entryHarness();
  const bound = await h.send({type: 'onstarvoice:strict-owner-bind', requestId: h.requestId, attemptId: h.attemptId});
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal(bound.data.scopeMode, 'cooperative');
  const client = createPageOperationClient({strictControl: bound.strictControl,
    chromeApi: {runtime: {sendMessage: h.send}}});
  const result = await client.runProducer('synthetic-existing-runner', () =>
    client.chromeApi.runtime.sendMessage({type: 'onstarvoice:relay-to-content', tabId: 7,
      payload: {action: 'captureSingleNote'}}));
  assert.equal(result.ok, true);
  assert.equal(result.data.ok, true);
  const prepared = await h.send({type: 'onstarvoice:prepare-active-capture-stop', action: 'stop_active_capture'});
  assert.equal(prepared.ok, true);
  const accepted = await h.send({type: 'onstarvoice:execute-active-capture-stop', action: 'stop_active_capture', handle: prepared.handle});
  assert.equal(accepted.phase, 'stop_requested'); assert.equal(accepted.sourceStopped, false);
  await tick();
  assert.equal(h.pageFor('page-a').isStopped(), true);
  const drained = await client.drain();
  assert.equal((await h.send({type: 'onstarvoice:strict-owner-settled', strictControl: bound.strictControl,
    ...drained, pendingUploads: 1})).ok, true);
  await h.send({type: 'onstarvoice:inspect-active-capture-stop'}); await tick();
  const receipt = await h.send({type: 'onstarvoice:inspect-active-capture-stop'});
  assert.equal(receipt.sourceStopped, true); assert.equal(receipt.pendingUploads, 1);
  assert.equal(receipt.resourcesReleased, false); assert.equal(receipt.successorAllowed, false);
  assert.equal(h.network.length, 3, 'bind and both command evaluations use the distinct read-only URL');
  assert.equal(h.native.length, 0, 'no real or synthetic native cleanup during stop');
});

test('actual legacy relay/switch/cancel cannot pass a retained strict journal to native operations', async () => {
  const h = entryHarness();
  assert.equal((await h.send({type: 'onstarvoice:strict-owner-bind', requestId: h.requestId, attemptId: h.attemptId})).ok, true);
  const before = h.pageCalls.length;
  for (const type of ['onstarvoice:relay-to-content', 'onstarvoice:switch-platform-tab', 'onstarvoice:cancel-unattended-keyword-run']) {
    const response = await h.send({type, tabId: 7, platform: 'douyin', payload: {action: 'captureSingleNote'}});
    assert.equal(response.ok, false, type);
  }
  assert.equal(h.pageCalls.length, before); assert.equal(h.native.length, 0);
});

test('real strict BEGIN/END preserve cooperative and resource-pending meanings without calling native lifecycle', async () => {
  const h = entryHarness();
  const bound = await h.send({type: 'onstarvoice:strict-owner-bind', requestId: h.requestId, attemptId: h.attemptId});
  h.context.beginCaptureTask = (message, sender) => vm.runInContext('strictLifecycleGuard', h.context)('begin', message, sender);
  for (const type of ['onstarvoice:begin-capture-task', 'onstarvoice:end-capture-task']) {
    const response = await h.send({type, strictControl: bound.strictControl, taskId: `unattended-capture:${h.requestId}`});
    assert.equal(response.data.scopeMode, 'cooperative');
    assert.equal(response.data.resourcesReleased, false);
    assert.equal(response.data.cleanupPending, true);
  }
});
