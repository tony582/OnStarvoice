import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [bindingSource, captureSource] = await Promise.all([
  readFile(new URL('../../utils/keyword-source-binding.js', import.meta.url), 'utf8'),
  readFile(new URL('../../utils/capture-sync.js', import.meta.url), 'utf8'),
]);
const searchA = 'https://www.douyin.com/search/first';
const searchB = 'https://www.douyin.com/search/last';
const plain = value => JSON.parse(JSON.stringify(value));

function timers() {
  let next = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout: (callback, delay) => { const id = ++next; pending.set(id, {callback, delay}); return id; },
    clearTimeout: id => pending.delete(id),
    expire(delay) {
      const matches = [...pending].filter(([, timer]) => timer.delay === delay);
      assert.ok(matches.length > 0, `expected ${delay}ms timer`);
      for (const [id, timer] of matches) { pending.delete(id); timer.callback(); }
    },
  };
}

function binding(sendMessage) {
  const clock = timers();
  const messages = [];
  const context = vm.createContext({URL, ...clock,
    chrome: {runtime: {sendMessage: message => { messages.push(plain(message)); return sendMessage(message); }}},
  });
  vm.runInContext(bindingSource, context);
  return {api: context.OnStarvoiceKeywordSourceBinding, context, clock, messages};
}

test('deferRestore accepts only an explicit authenticated-background acknowledgement', async () => {
  for (const response of [undefined, null, {}, {deferred: true}, {ok: true},
    {ok: false, data: {deferred: true}}, {ok: true, data: {deferred: 'true'}},
    {ok: true, data: {deferred: false}}, {ok: true, data: {deferred: true}}]) {
    const h = binding(async () => response);
    assert.equal(await h.api.deferRestore(21), response?.ok === true && response?.data?.deferred === true);
    assert.deepEqual(h.messages, [{type: 'onstarvoice:defer-keyword-source-restore', sourceTabId: 21}]);
    assert.equal(h.clock.pending.size, 0);
  }
});

test('invalid source ids, unavailable runtime and rejected messages retain the original restore', async () => {
  const h = binding(async () => { throw new Error('must not send'); });
  for (const id of [undefined, null, 0, -1, '21', 1.5]) assert.equal(await h.api.deferRestore(id), false);
  assert.equal(h.messages.length, 0);
  assert.equal(await h.api.deferRestore(21), false);
  const missing = vm.createContext({URL, setTimeout, clearTimeout});
  vm.runInContext(bindingSource, missing);
  assert.equal(await missing.OnStarvoiceKeywordSourceBinding.deferRestore(21), false);
});

test('a never-answering message has one 1500ms deadline, and a late acknowledgement cannot reverse fallback', async () => {
  let reply;
  const h = binding(() => new Promise(resolve => { reply = resolve; }));
  const waiting = h.api.deferRestore(21);
  assert.equal(h.clock.pending.size, 1);
  h.clock.expire(1500);
  assert.equal(await waiting, false);
  reply({ok: true, data: {deferred: true}});
  await Promise.resolve();
  assert.equal(await waiting, false);
  assert.equal(h.messages.length, 1, 'the sidecar never retries');
  assert.equal(h.clock.pending.size, 0);
});

const batchAt = captureSource.indexOf('export async function batchCaptureByKeywords(');
const finallyAt = captureSource.indexOf('  } finally {\n    if (typeof runnerReplacementEvents?.removeListener', batchAt);
const afterFinally = captureSource.indexOf('// 小红书搜索路由', finallyAt);
assert.ok(batchAt >= 0 && finallyAt > batchAt && afterFinally > finallyAt);
// Execute the production finally body, including its own error handling. The
// try result represents completed/canceled/failed business work unchanged.
const finalizer = captureSource.slice(finallyAt, afterFinally);
function batchHarness({response = {ok: true, data: {deferred: true}}, send,
  shouldRestore = true, sourcePageUrl = searchA, currentUrl = searchB, helperAvailable = true} = {}) {
  const h = binding(message => {
    if (send) return send(message);
    return Promise.resolve(message.type === 'onstarvoice:defer-keyword-source-restore' ? response : {ok: true});
  });
  const observations = {gets: [], updates: [], removedListeners: []};
  const listener = () => {};
  Object.assign(h.context, {
    runnerCtx: {shouldRestoreSourcePage: shouldRestore, sourcePageUrl}, runnerTabId: 21,
    runnerReplacementEvents: {removeListener: value => observations.removedListeners.push(value)},
    handleRunnerTabReplacement: listener,
    normalizeUrlWithoutHash: value => String(value || '').split('#')[0],
  });
  h.context.chrome.tabs = {
    get: async id => { observations.gets.push(id); return {id, url: currentUrl, status: 'complete'}; },
    update: async (id, patch) => {
      observations.updates.push({id, ...plain(patch)});
      // A real navigation may remain loading longer than the old recorder's
      // deadline. Successful handoff must not start that navigation at all.
      currentUrl = patch.url;
      return {id, url: currentUrl, status: 'loading'};
    },
  };
  if (!helperAvailable) h.context.OnStarvoiceKeywordSourceBinding = undefined;
  vm.runInContext(`async function finalizeBusinessResult(value, rejected = false) {\n  try {\n    if (rejected) throw value;\n    return value;\n${finalizer}`, h.context);
  return {...h, observations, listener, run: (value, rejected) => h.context.finalizeBusinessResult(value, rejected)};
}

test('real batch finally skips the redundant restore only after background takes the proven document', async () => {
  const h = batchHarness();
  const business = {ok: true, stats: {processed: 2}, results: [{recordIds: ['saved-record']}]};
  assert.equal(await h.run(business), business);
  assert.deepEqual(h.observations.gets, []);
  assert.deepEqual(h.observations.updates, []);
  assert.deepEqual(h.messages, [{type: 'onstarvoice:defer-keyword-source-restore', sourceTabId: 21}]);
  assert.deepEqual(h.observations.removedListeners, [h.listener]);
});

test('ordinary and unconfirmed runners execute the original restore and navigation recording', async () => {
  for (const response of [{ok: true, data: {deferred: false}}, {ok: false}, undefined]) {
    const h = batchHarness({response: response ?? null});
    const business = {ok: true};
    assert.equal(await h.run(business), business);
    assert.deepEqual(h.observations.updates, [{id: 21, url: searchA}]);
    assert.equal(h.messages[1].type, 'onstarvoice:record-keyword-source-navigation');
    assert.equal(h.messages[1].expectedUrl, searchA);
  }
  const missing = batchHarness({helperAvailable: false});
  await missing.run({ok: true});
  assert.deepEqual(missing.observations.updates, [{id: 21, url: searchA}]);
});

test('handoff timeout or rejection cannot prevent the existing restore or mutate a settled business result', async () => {
  let reply;
  const slow = batchHarness({send: message => message.type === 'onstarvoice:defer-keyword-source-restore'
    ? new Promise(resolve => { reply = resolve; }) : Promise.resolve({ok: true})});
  const business = {ok: false, canceled: true, results: ['preserved']};
  const waiting = slow.run(business);
  slow.clock.expire(1500);
  assert.equal(await waiting, business);
  assert.deepEqual(slow.observations.updates, [{id: 21, url: searchA}]);
  reply({ok: true, data: {deferred: true}});
  await Promise.resolve();
  assert.equal(slow.observations.updates.length, 1);
  const rejected = batchHarness({send: async () => { throw new Error('runtime unavailable'); }});
  assert.equal(await rejected.run(business), business);
  assert.deepEqual(rejected.observations.updates, [{id: 21, url: searchA}]);
});

test('a throwing optional sidecar still falls back and original capture exceptions retain their identity', async () => {
  for (const deferred of [true, false]) {
    const h = batchHarness({response: {ok: true, data: {deferred}}});
    const failure = new Error('original checkpoint failure');
    await assert.rejects(h.run(failure, true), error => error === failure);
    assert.equal(h.observations.updates.length, deferred ? 0 : 1);
  }
  const h = batchHarness();
  h.context.OnStarvoiceKeywordSourceBinding = {deferRestore: async () => { throw new Error('sidecar failed'); }};
  const business = {ok: true};
  assert.equal(await h.run(business), business);
  assert.deepEqual(h.observations.updates, [{id: 21, url: searchA}]);
});

test('dedicated detail runners and missing source URLs never request a handoff', async () => {
  for (const options of [{shouldRestore: false}, {sourcePageUrl: ''}]) {
    const h = batchHarness(options);
    const business = {ok: true};
    assert.equal(await h.run(business), business);
    assert.equal(h.messages.length, 0);
    assert.equal(h.observations.updates.length, 0);
    assert.equal(h.observations.removedListeners.length, 1);
  }
});

const [backgroundSource, homeSource, pageSafetySource] = await Promise.all([
  readFile(new URL('../../background.js', import.meta.url), 'utf8'),
  readFile(new URL('../../utils/task-home-cleanup.js', import.meta.url), 'utf8'),
  readFile(new URL('../../utils/task-home-page-safety.js', import.meta.url), 'utf8'),
]);
function backgroundFunction(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(backgroundSource);
  assert.ok(start, name);
  const rest = backgroundSource.slice(start.index);
  const next = /\n(?:async )?function \w+\(/.exec(rest);
  assert.ok(next, `function after ${name}`);
  return rest.slice(0, next.index);
}
async function authenticatedBatch({kind = 'unattended', bound = true, status = 'running',
  documentId = 'runner-document', pageUrl = searchB, pageStatus = 'complete'} = {}) {
  const store = {};
  const storage = {
    get: async key => ({[key]: structuredClone(store[key])}),
    set: async values => Object.assign(store, structuredClone(values)),
  };
  const request = kind === 'manual'
    ? {id: 'manual', commandId: 'command', status: status === 'running' ? 'claimed' : status,
      runnerTabId: 900, claimedDocumentId: 'runner-document', platform: 'douyin', plan: {keywords: ['first', 'last']}}
    : {id: 'request', attemptId: 'attempt', status, runnerTabId: 900,
      platform: 'douyin', planSnapshot: {keywords: ['first', 'last']}};
  store.manual = {manual: request};
  const sender = {tab: {id: 900}, documentId,
    url: kind === 'manual' ? 'chrome-extension://test/sidebar/sidebar.html?manualKeywordBatch=manual'
      : 'chrome-extension://test/sidebar/sidebar.html?unattendedRun=request&unattendedAttempt=attempt'};
  let h;
  h = batchHarness({send: async message => message.type === 'onstarvoice:defer-keyword-source-restore'
    ? {ok: true, data: await h.context.deferKeywordSourceRestore(message, sender)} : {ok: true}});
  vm.runInContext(homeSource, h.context);
  vm.runInContext(pageSafetySource, h.context);
  Object.assign(h.context, {
    keywordSourceBindings: h.api.createController({storage}),
    taskWindowSources: null,
    UNATTENDED_RUNNER_QUERY_KEY: 'unattendedRun', UNATTENDED_RUNNER_ATTEMPT_QUERY_KEY: 'unattendedAttempt',
    resolveCaptureTaskTabId: value => Number.isSafeInteger(value) && value > 0 ? value : null,
    isOwnExtensionPageUrl: value => value.startsWith('chrome-extension://test/'),
    readUnattendedKeywordRunRequest: async () => request,
    isTerminalUnattendedRunStatus: value => ['completed', 'failed', 'canceled', 'needs_action'].includes(value),
    OnStarvoiceManualKeywordDispatch: {STORAGE_KEY: 'manual'},
    scheduleTaskBrowserCleanup: async () => {}, runCaptureExecutionLockOperation: operation => operation(),
  });
  const page = {id: 21, windowId: 1, url: pageUrl, status: pageStatus, documentId: 'last-search-document'};
  h.context.chrome.storage = {local: storage};
  h.context.chrome.tabs = {
    get: async id => { assert.equal(id, 21); return {...page}; },
    query: async () => [{...page}],
    update: async (id, patch) => {
      h.observations.updates.push({id, ...plain(patch)});
      Object.assign(page, patch, {status: 'complete', documentId: 'home-document'});
      return {...page};
    },
    remove: async () => { throw new Error('single source should become home'); },
    create: async () => { throw new Error('must not add a home'); },
  };
  h.context.chrome.scripting = {executeScript: async () => [{frameId: 0, documentId: page.documentId, result: {url: page.url, safeForCleanup: true}}]};
  for (const name of ['keywordSourceOwnerForRequest', 'readKeywordSourceSenderOwner', 'runTaskHomeSidecar',
    'getTaskSourceDocumentIdentity', 'deferKeywordSourceRestore', 'queueFinishedTaskHome']) {
    vm.runInContext(backgroundFunction(name), h.context);
  }
  const owner = h.context.keywordSourceOwnerForRequest(request, 'runner-document');
  if (bound) {
    await h.context.keywordSourceBindings.bind(owner, {tabId: 21, windowId: 1, created: false, url: 'https://www.douyin.com/'});
    await h.context.keywordSourceBindings.record(owner, {sourceTabId: 21, windowId: 1, url: searchA, documentId: 'earlier-search-document'});
    // The real per-keyword readiness path records the final search before its
    // batch finally asks to hand off cleanup. Handoff must not create proof.
    await h.context.keywordSourceBindings.record(owner, {sourceTabId: 21, windowId: 1, url: searchB, documentId: 'last-search-document'});
  }
  h.context.taskHomeCleanup = h.context.OnStarvoiceTaskHomeCleanup.createController({storage, tabs: h.context.chrome.tabs,
    canPark: async () => true, getDocumentIdentity: h.context.getTaskSourceDocumentIdentity});
  return {...h, page, request, owner, store};
}

for (const kind of ['unattended', 'manual']) {
  test(`real ${kind} sender, background proof, batch finally and terminal home queue avoid the slow restore`, async () => {
    const h = await authenticatedBatch({kind});
    const business = {ok: true, records: ['saved']};
    assert.equal(await h.run(business), business);
    assert.equal(h.page.url, searchB);
    assert.deepEqual(h.observations.updates, [], 'no pointless navigation back to first search');
    const saved = await h.context.keywordSourceBindings.get(h.owner);
    assert.equal(saved[0].documentId, 'last-search-document');
    assert.equal(saved[0].expectedSourceUrl, searchB);
    await h.context.queueFinishedTaskHome({...h.request, status: 'completed'}, {runnerTab: {id: 900, windowId: 1}});
    assert.equal(h.page.url, 'https://www.douyin.com/');
    assert.deepEqual(h.observations.updates, [{id: 21, url: 'https://www.douyin.com/'}]);
    assert.deepEqual(h.store['onstarvoice.taskHomeCleanup.v1'], {});
  });
}

test('real background rejects missing binding, terminal ownership, wrong manual document and unrelated routes', async () => {
  for (const options of [{bound: false}, {status: 'completed'},
    {kind: 'manual', documentId: 'other-runner'}, {pageUrl: 'https://www.douyin.com/video/123456789'},
    {pageUrl: 'https://www.douyin.com/search/not-in-plan'}, {pageStatus: 'loading'}]) {
    const h = await authenticatedBatch(options);
    const business = {ok: true};
    assert.equal(await h.run(business), business);
    assert.deepEqual(h.observations.updates, [{id: 21, url: searchA}], JSON.stringify(options));
  }
});

for (const kind of ['unattended', 'manual']) {
  test(`real ${kind} handoff rejects a replacement document or another planned search without adopting it`, async () => {
    for (const changedPage of [
      {documentId: 'replacement-document'},
      {url: searchA, documentId: 'earlier-search-document'},
    ]) {
      const h = await authenticatedBatch({kind});
      Object.assign(h.page, changedPage);
      const proofBefore = plain(await h.context.keywordSourceBindings.get(h.owner));
      assert.equal(await h.api.deferRestore(21), false);
      assert.deepEqual(plain(await h.context.keywordSourceBindings.get(h.owner)), proofBefore,
        'a cleanup handoff cannot adopt the changed page as task-owned');
      const business = {ok: true, records: ['saved']};
      assert.equal(await h.run(business), business);
      assert.deepEqual(h.observations.updates, h.page.url === searchA && changedPage.url === searchA
        ? [] : [{id: 21, url: searchA}]);
      assert.deepEqual(plain(await h.context.keywordSourceBindings.get(h.owner)), proofBefore);
    }
  });
}
