import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createContentActivityRegistry, createSearchWitnessActivityPorts} from '../../utils/capture/content-activity.js';

const source = readFileSync(new URL('../../utils/capture-sync.js', import.meta.url), 'utf8');
const registrySource = readFileSync(new URL('../../utils/capture/content-activity.js', import.meta.url), 'utf8');
const cohort = {version: 1, requestId: 'request-a', attemptId: 'attempt-a', generation: 1,
  ownerDocumentId: 'owner-a', documentId: 'document-a'};
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

function harness() {
  const observers = [], timers = new Map(), cleared = [], scripts = [];
  let nextTimer = 0, scriptGate = null;
  class Element {
    constructor() {this.value = 'keyword'; this.textContent = '搜索';}
    getBoundingClientRect() {return {width: 100, height: 30};}
    querySelectorAll() {return [{}, {}];}
    getAttribute() {return '';}
    contains(node) {return node === this;}
    focus() {} dispatchEvent() {} scrollIntoView() {} click() {}
  }
  const resultRoot = new Element(), input = new Element(), button = new Element();
  const window = {location: {href: 'https://www.douyin.com/search/keyword'},
    getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'})};
  const context = vm.createContext({URL, window, HTMLElement: Element, AbortController,
    crypto: {randomUUID: () => 'activation-a'},
    PointerEvent: class {}, MouseEvent: class {}, KeyboardEvent: class {},
    document: {body: {}, querySelector: selector => selector.includes('#search-result-container') ? resultRoot : button,
      querySelectorAll: () => [input]},
    MutationObserver: class {
      constructor(callback) {this.callback = callback; this.connected = false; this.failDisconnect = false; observers.push(this);}
      observe() {this.connected = true;}
      disconnect() {if (this.failDisconnect) throw new Error('synthetic disconnect failure'); this.connected = false;}
    },
    setTimeout: (callback, delay) => {const id = ++nextTimer; timers.set(id, {callback, delay}); return id;},
    clearTimeout: id => {cleared.push(id); timers.delete(id);},
    MESSAGE_TYPE: {RELAY_TO_CONTENT: 'fixture-relay'},
    isDouyinPlatform: platform => platform === 'douyin',
    assertNoDouyinSearchSecurityChallengeInTab: async () => {},
    isDouyinSearchServiceAbnormalError: () => false,
    isDouyinSearchSecurityChallengeError: () => false,
    readDouyinSearchWorkIdsInTab: async () => ({captured: true, workIds: ['123456789']}),
    chrome: {runtime: {sendMessage: async () => ({ok: true, data: {ok: true}})},
      scripting: {executeScript: async details => {
        scripts.push(details);
        const result = details.func(...(details.args || []));
        if (scriptGate) await scriptGate.promise;
        return [{result}];
      }}},
  });
  for (const [start, end] of [
    ['async function submitKeywordSearchInTab(', '\nasync function readDouyinSearchWorkIdsInTab('],
    ['async function beginDouyinSearchResultTransitionInTab(', '\nasync function readDouyinSearchDocumentGenerationInTab('],
  ]) {
    // Execute the actual production functions, including their full injected
    // browser functions; no copied observer implementation or real browser.
    vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  }
  const activity = createContentActivityRegistry({createActivationId: () => 'activation-a',
    ...createSearchWitnessActivityPorts({getWitness: () => window.__STARVOICE_DOUYIN_SEARCH_WITNESS__})});
  const activate = () => ({...activity.handshake(cohort).scope, operationId: 'operation-a'});
  const install = kind => kind === 'submit'
    ? context.submitKeywordSearchInTab(7, 'douyin', 'keyword', null, {reason: 'initial_search_generation'})
    : context.beginDouyinSearchResultTransitionInTab(7, 'keyword');
  return {activity, activate, install, window, observers, timers, cleared, scripts, context,
    mutate(observer = observers.at(-1)) {observer.callback([{target: resultRoot}]);},
    expire(id) {const timer = timers.get(id); timers.delete(id); timer.callback();},
    get witness() {return window.__STARVOICE_DOUYIN_SEARCH_WITNESS__;},
    set scriptGate(value) {scriptGate = value;},
  };
}

for (const kind of ['submit', 'transition']) {
  test(`${kind}: real injected observer remains counted after native result, and stop fences already queued callbacks`, async () => {
    const h = harness(), envelope = h.activate();
    h.activity.reserve(envelope);
    await h.install(kind);
    assert.equal(h.scripts.length, 1);
    assert.equal(h.activity.inspect().activeCount, 2);
    assert.equal(h.activity.inspect().childCount, 1);
    assert.equal((await h.activity.settle(envelope)).activeCount, 1);
    assert.equal(h.activity.inspect().passiveCount, 1);
    h.mutate(); assert.equal(h.witness.mutationCount, 1);
    const timerId = h.witness.timerId;
    assert.equal(h.timers.get(timerId).delay, 90_000);
    assert.equal(h.activity.cancel(envelope).quiesced, true);
    assert.equal(h.witness.active, false); assert.equal(h.witness.retired, true);
    assert.equal(h.observers[0].connected, false); assert.equal(h.timers.size, 0);
    assert.ok(h.cleared.includes(timerId));
    h.mutate(); assert.equal(h.witness.mutationCount, 1, 'queued callback cannot mutate the retired witness');
  });

  test(`${kind}: replacement retires the old observer and its timer, while natural timeout retires the successor`, async () => {
    const h = harness(); await h.install(kind);
    const previous = h.witness, oldObserver = h.observers[0], oldTimer = previous.timerId;
    h.mutate();
    await h.install(kind);
    assert.equal(previous.active, false); assert.equal(previous.retired, true);
    assert.equal(oldObserver.connected, false); assert.equal(h.timers.has(oldTimer), false);
    assert.ok(h.cleared.includes(oldTimer));
    h.mutate(oldObserver); assert.equal(previous.mutationCount, 1);
    assert.equal(h.timers.size, 1);
    const timerId = h.witness.timerId;
    assert.equal(h.timers.get(timerId).delay, 90_000);
    h.expire(timerId);
    assert.equal(h.witness.active, false); assert.equal(h.witness.retired, true);
    assert.equal(h.activity.inspect().passiveCount, 0);
    assert.equal(h.timers.size, 0);
    h.mutate(); assert.equal(h.witness.mutationCount, 0);
    assert.equal(h.activate().activationId, 'activation-a');
  });

  test(`${kind}: active legacy witness blocks first handshake until its real retirement`, async () => {
    const h = harness(); await h.install(kind);
    assert.throws(h.activate, /PAGE_CONTROL_PAGE_BUSY/);
    assert.equal(h.activity.isStrict(), false);
    h.expire(h.witness.timerId);
    assert.equal(h.activate().activationId, 'activation-a');
  });

  test(`${kind}: passive observation coexists with ordinary run/reserve and is retired before navigation dispatch`, async () => {
    const h = harness(), envelope = h.activate(); await h.install(kind);
    assert.equal(await h.activity.run(envelope, () => 'read'), 'read');
    const external = {...envelope, operationId: 'external'};
    assert.equal(h.activity.reserve(external).activeCount, 2);
    await h.activity.settle(external);
    let dispatched = false;
    const result = h.activity.navigate({...envelope, operationId: 'navigate'}, () => {
      assert.equal(h.witness.retired, true);
      assert.equal(h.timers.size, 0);
      assert.equal(h.activity.inspect().quiesced, true);
      dispatched = true;
    });
    assert.equal(dispatched, true); assert.equal(result.quiesced, true);
    h.mutate(); assert.equal(h.witness.mutationCount, 0);
  });

  test(`${kind}: late installation after stop stays counted until native completion and external settlement cleans it again`, async () => {
    const h = harness(), envelope = h.activate(), gate = deferred();
    h.activity.reserve(envelope);
    assert.equal(h.activity.cancel(envelope).quiesced, false);
    h.scriptGate = gate;
    const installing = h.install(kind); await tick();
    assert.equal(h.observers.length, 1);
    assert.equal(h.activity.inspect().topLevelCount, 1);
    assert.equal(h.activity.inspect().passiveCount, 1);
    assert.equal(h.activity.inspect().quiesced, false);
    gate.resolve(); await installing;
    assert.equal(h.activity.inspect().activeCount, 2, 'native result alone does not erase either receipt');
    assert.equal((await h.activity.settle(envelope)).quiesced, true);
    h.mutate(); assert.equal(h.witness.mutationCount, 0);
    assert.equal(h.timers.size, 0);
  });

  test(`${kind}: page invalidation retires a witness, but never erases a still-pending external operation`, async () => {
    const h = harness(), envelope = h.activate(); h.activity.reserve(envelope);
    await h.install(kind);
    h.activity.invalidate();
    assert.equal(h.activity.inspect().activeCount, 1);
    assert.equal(h.activity.inspect().quiesced, false);
    assert.equal(h.witness.retired, true); assert.equal(h.timers.size, 0);
    h.mutate(); assert.equal(h.witness.mutationCount, 0);
    assert.equal((await h.activity.settle(envelope)).quiesced, true);
  });

  test(`${kind}: failed observer retirement refuses navigation and remains counted even though callback writes are frozen`, async () => {
    const h = harness(), envelope = h.activate(); await h.install(kind);
    h.observers[0].failDisconnect = true;
    let dispatched = false;
    assert.throws(() => h.activity.navigate(envelope, () => {dispatched = true;}), /PAGE_CONTROL_PAGE_BUSY/);
    assert.equal(dispatched, false); assert.equal(h.activity.isStopped(), true);
    assert.equal(h.activity.inspect().quiesced, false);
    assert.equal(h.activity.inspect().passiveCount, 1);
    assert.equal(h.witness.active, false); assert.equal(h.witness.retired, false);
    h.mutate(); assert.equal(h.witness.mutationCount, 0);
    h.observers[0].failDisconnect = false;
    assert.equal(h.activity.cancel(envelope).quiesced, true);
    assert.equal(h.timers.size, 0);
  });

  test(`${kind}: failed replacement preserves the old observer as pending instead of losing its lifecycle pointer`, async () => {
    const h = harness(); await h.install(kind);
    const previous = h.witness;
    h.observers[0].failDisconnect = true;
    await h.install(kind);
    assert.equal(h.witness, previous);
    assert.equal(h.observers.length, 1);
    assert.equal(previous.retired, false);
    assert.equal(h.activity.inspect().passiveCount, 1);
    assert.throws(h.activate, /PAGE_CONTROL_PAGE_BUSY/);
    h.mutate(); assert.equal(previous.mutationCount, 0);
    h.observers[0].failDisconnect = false; previous.stop();
    assert.equal(h.timers.size, 0);
  });
}

test('actual pageActivity singleton is wired to the isolated-world witness without a caller-supplied replacement registry', async () => {
  const h = harness();
  vm.runInContext(registrySource.replace(/^export /gm, '') + '\nglobalThis.actualPageActivity = pageActivity;', h.context);
  const activity = h.context.actualPageActivity;
  await h.install('transition');
  assert.equal(activity.inspect().passiveCount, 1);
  assert.throws(() => activity.handshake(cohort), /PAGE_CONTROL_PAGE_BUSY/);
  h.expire(h.witness.timerId);
  const envelope = {...activity.handshake(cohort).scope, operationId: 'operation-a'};
  await h.install('submit');
  assert.equal(activity.cancel(envelope).quiesced, true);
  assert.equal(h.timers.size, 0);
  h.mutate(); assert.equal(h.witness.mutationCount, 0);
});

test('an unknown legacy observer is never considered idle, even if a partial legacy disconnect is possible', () => {
  const h = harness(); let disconnected = false;
  h.window.__STARVOICE_DOUYIN_SEARCH_WITNESS__ = {observer: {disconnect() {disconnected = true;}}};
  assert.equal(h.activity.inspect().passiveCount, 1);
  assert.throws(h.activate, /PAGE_CONTROL_PAGE_BUSY/);
  assert.equal(disconnected, false, 'first admission must not silently mutate unrelated legacy activity');
});

for (const kind of ['submit', 'transition']) {
  test(`${kind}: replacement still disconnects an older witness without a stop method`, async () => {
    const h = harness(); let disconnected = false;
    h.window.__STARVOICE_DOUYIN_SEARCH_WITNESS__ = {observer: {disconnect() {disconnected = true;}}};
    await h.install(kind);
    assert.equal(disconnected, true);
    assert.equal(h.witness.lifecycleVersion, 1);
    h.witness.stop(); assert.equal(h.activity.inspect().passiveCount, 0);
  });
}
