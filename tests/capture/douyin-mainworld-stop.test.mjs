import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createContentActivityRegistry} from '../../utils/capture/content-activity.js';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const base = '3c19c5ea14c9ac1f68a21da8b8caf30353b459d1';
const baseline = (path) => execFileSync('git', ['show', `${base}:${path}`], {cwd: root, encoding: 'utf8'});
const callerSlice = (source) => source.slice(source.indexOf('async function waitForDouyinApiCache('),
  source.indexOf('\nfunction readInterceptedMediaRequests()'));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cohort = {version: 1, requestId: 'request-a', attemptId: 'attempt-a', generation: 1,
  ownerDocumentId: 'owner-a', documentId: 'document-a'};

function harness({legacy = false, strict = true, loadInterceptor = true} = {}) {
  const activity = createContentActivityRegistry({createActivationId: () => 'activation-a'});
  const envelope = strict ? {...activity.handshake(cohort).scope, operationId: 'operation-a'} : null;
  const entries = new Map();
  const storage = {
    get length() { return entries.size; }, key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  const calls = [], events = [], listeners = new Map(), waits = [];
  let now = 1788700000000;
  class FakeDate extends Date { static now() { return now; } }
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  const window = {
    XMLHttpRequest: class {},
    fetch(url, options) { return new Promise((resolve, reject) => calls.push({url, options, resolve, reject})); },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      events.push(event);
      [...(listeners.get(event.type) || [])].forEach((callback) => callback(event));
      return true;
    },
  };
  const context = vm.createContext({
    window, CustomEvent, AbortController, crypto: {randomUUID}, pageActivity: activity,
    sessionStorage: storage, localStorage: storage, Date: FakeDate,
    console: {debug() {}, warn() {}}, _DETAIL_REQUEST_EVENT: '__mc_dy_request_detail__',
    readDouyinApiCache: (id) => { const value = storage.getItem(`__mc_dy_detail_${id}`); return value ? JSON.parse(value).detail : null; },
    wait: async (ms) => { activity.assertCanProduce(); waits.push(ms); now += ms; },
  });
  const getSource = legacy ? baseline : read;
  if (loadInterceptor) vm.runInContext(getSource('utils/capture/douyin-interceptor.js'), context);
  vm.runInContext(callerSlice(getSource('utils/capture/douyin-single-note.js')), context);
  function run(id = 'fixture-note', options) {
    const handler = () => context.requestDouyinApiDetailFromMainWorld(id, options);
    return strict ? activity.run(envelope, handler) : activity.runLegacy(handler);
  }
  const dispatch = (type, detail) => window.dispatchEvent(new CustomEvent(type, {detail}));
  return {activity, envelope, storage, calls, events, listeners, waits, run, dispatch, window};
}

test('controlled details retain the current platform fetch wrapper, including asynchronous invocation', async () => {
  const h = harness();
  const previousFetch = h.window.fetch;
  h.window.fetch = (url, options) => Promise.resolve().then(() => previousFetch(url, {
    ...options, headers: {...options.headers, 'fixture-platform-header': 'retained'},
  }));
  await h.run();
  assert.equal(h.calls[0].options.headers['fixture-platform-header'], 'retained');
  let reads = 0;
  h.calls[0].resolve({ok: true, clone: () => ({json: async () => {
    reads += 1; return {aweme_detail: {aweme_id: 'fixture-note', video: {}}};
  }})});
  await tick();
  assert.equal(reads, 1);
  assert.equal(h.activity.inspect().activeCount, 0);
});

test('actual caller timeout leaves MAIN fetch counted; stop aborts but waits actual rejection/settlement', async () => {
  const h = harness();
  assert.equal(await h.run(), null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.activity.inspect().topLevelCount, 0);
  assert.equal(h.activity.inspect().childCount, 1);
  assert.equal(h.activity.cancel(h.envelope).quiesced, false);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.activity.inspect().activeCount, 1, 'an abort request is not settlement');
  h.calls[0].reject(new Error('synthetic aborted fetch'));
  await tick();
  assert.equal(h.activity.inspect().quiesced, true);
  assert.equal(h.activity.inspect().mainWorldCooperative, true);
  assert.equal(h.calls.length, 1);
});

test('actual body reader stays counted after fetch resolves; canceled late body cannot update cache', async () => {
  const h = harness();
  await h.run();
  let finishBody;
  let reads = 0;
  h.calls[0].resolve({ok: true, clone: () => ({json: () => {
    reads += 1; return new Promise((resolve) => { finishBody = resolve; });
  }})});
  await tick();
  assert.equal(reads, 1, 'owned path has no detached passive Proxy clone');
  assert.equal(h.activity.cancel(h.envelope).quiesced, false);
  finishBody({aweme_detail: {aweme_id: 'fixture-note', video: {play_addr: 'fixture'}}});
  await tick();
  assert.equal(h.activity.inspect().quiesced, true);
  assert.equal(h.storage.getItem('__mc_dy_detail_fixture-note'), null);
  assert.equal(h.calls.length, 1);
});

for (const outcome of ['http-failure', 'fetch-rejection', 'missing-detail']) {
  test(`actual canceled ${outcome} cannot start a fallback endpoint`, async () => {
    const h = harness(); await h.run();
    h.activity.cancel(h.envelope);
    if (outcome === 'http-failure') h.calls[0].resolve({ok: false});
    else if (outcome === 'fetch-rejection') h.calls[0].reject(new Error('synthetic fetch failure'));
    else h.calls[0].resolve({ok: true, clone: () => ({json: async () => ({})})});
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.activity.inspect().quiesced, true);
  });
}

test('normal positive MAIN detail path keeps existing cache format and drains without stopping cohort', async () => {
  const h = harness(); await h.run();
  h.calls[0].resolve({ok: true, clone: () => ({json: async () => ({
    aweme_detail: {aweme_id: 'fixture-note', video: {play_addr: 'fixture'}},
  })})});
  await tick();
  assert.equal(JSON.parse(h.storage.getItem('__mc_dy_detail_fixture-note')).detail.aweme_id, 'fixture-note');
  assert.equal(h.activity.inspect().activeCount, 0);
  assert.equal(h.activity.isStopped(), false);
});

test('legacy baseline versus current anonymous caller keeps endpoint order, credentials, headers, waits and cache polling timeout', async () => {
  const results = [];
  for (const legacy of [true, false]) {
    const h = harness({legacy, strict: false});
    assert.equal(await h.run('fixture-fallback'), null);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(h.calls.length, index + 1);
      h.calls[index].resolve({ok: false}); await tick();
    }
    results.push({requests: h.calls.map(({url, options}) => ({url,
      credentials: options.credentials, headers: JSON.parse(JSON.stringify(options.headers))})), waits: h.waits});
    assert.equal(h.activity.inspect().activeCount, 0);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[0].requests.map((item) => item.url), [
    '/aweme/v1/web/aweme/detail/?aweme_id=fixture-fallback',
    '/aweme/v1/aweme/detail/?aweme_id=fixture-fallback',
    '/aweme/v2/aweme/detail/?aweme_id=fixture-fallback',
  ]);
});

test('malformed, wrong identity/key and stale MAIN receipts do not release the real pending request', async () => {
  const h = harness(); await h.run();
  const request = h.events.find((event) => event.type === '__mc_dy_request_detail__').detail;
  const receipt = {version: 1, requestKey: request.requestKey, awemeId: request.awemeId,
    pageControl: {...h.envelope}, phase: 'settled'};
  for (const wrong of [{...receipt, version: 2}, {...receipt, requestKey: 'other'},
    {...receipt, awemeId: 'other'}, {...receipt, phase: 'finished'},
    {...receipt, pageControl: {...h.envelope, generation: 2}},
    {...receipt, pageControl: {...h.envelope, operationId: 'other'}},
    {...receipt, pageControl: {...h.envelope, activationId: 'old'}}]) {
    h.dispatch('__onstarvoice_dy_detail_status_v1__', wrong);
    assert.equal(h.activity.inspect().childCount, 1);
  }
  h.activity.cancel(h.envelope);
  h.calls[0].resolve({ok: false}); await tick();
  assert.equal(h.activity.inspect().quiesced, true);
});

test('missing MAIN bridge or a settled receipt without started remains quarantined, never false idle', async () => {
  const h = harness({loadInterceptor: false}); await h.run();
  const request = h.events.find((event) => event.type === '__mc_dy_request_detail__').detail;
  h.dispatch('__onstarvoice_dy_detail_status_v1__', {...request, phase: 'settled'});
  assert.equal(h.activity.cancel(h.envelope).quiesced, false);
  assert.equal(h.activity.inspect().childCount, 1);
});

test('legacy anonymous MAIN work prevents first strict handshake after content response timeout', async () => {
  const h = harness({strict: false}); await h.run();
  assert.throws(() => h.activity.handshake(cohort), /PAGE_BUSY/u);
  h.calls[0].resolve({ok: true, clone: () => ({json: async () => ({
    aweme_detail: {aweme_id: 'fixture-note', video: {}},
  })})});
  await tick();
  assert.equal(h.activity.handshake(cohort).strict, true);
});
