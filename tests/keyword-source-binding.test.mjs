import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const [bindingSource, homeSource, background, sidebar, capture, safetySource] = await Promise.all([
  '../utils/keyword-source-binding.js', '../utils/task-home-cleanup.js', '../background.js',
  '../sidebar/sidebar-logic.js', '../utils/capture-sync.js', '../utils/task-home-page-safety.js',
].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
const clone = value => structuredClone(value);
function section(source, start, end) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, `source section ${start}`);
  return source.slice(begin, finish);
}
function fn(source, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const rest = source.slice(match.index);
  const next = /\n(?:async )?function \w+\(/.exec(rest);
  assert.ok(next, `next function after ${name}`);
  return rest.slice(0, next.index);
}
function memory(initial = {}) {
  const data = clone(initial);
  return {data, async get(key) {
    if (typeof key === 'string') return {[key]: clone(data[key])};
    return Object.fromEntries((key || Object.keys(data)).map(value => [value, clone(data[value])]));
  }, async set(patch) { Object.assign(data, clone(patch)); }};
}
const owner = {kind: 'unattended', identity: 'request:attempt', requestId: 'request', attemptId: 'attempt',
  platform: 'douyin', runnerDocumentId: 'runner-document'};
const search = keyword => `https://www.douyin.com/search/${encodeURIComponent(keyword)}`;
const source = {tabId: 20, windowId: 1, created: true, url: 'https://www.douyin.com/jingxuan'};
function bindingHarness(storage = memory(), extras = {}) {
  const context = vm.createContext({URL, console, setTimeout, clearTimeout, ...extras});
  vm.runInContext(bindingSource, context);
  return {storage, context, module: context.OnStarvoiceKeywordSourceBinding,
    controller: context.OnStarvoiceKeywordSourceBinding.createController({storage})};
}

test('launch creation survives the same owner switching to its already-created page', async () => {
  const h = bindingHarness();
  await h.controller.bind({...owner, runnerDocumentId: ''}, source);
  await h.controller.bind(owner, {...source, created: false});
  assert.equal((await h.controller.get(owner))[0].createdByTask, true);
  assert.equal((await h.controller.get(owner))[0].originalUrl, source.url);
  assert.equal(await h.controller.record(owner, {sourceTabId: 20, windowId: 1,
    documentId: 'search-document', url: search('a')}), true);
  const restarted = bindingHarness(h.storage);
  assert.equal((await restarted.controller.get(owner))[0].documentId, 'search-document');
});

test('new attempt revokes old source ownership and cannot inherit created or document authority', async () => {
  const h = bindingHarness();
  await h.controller.bind(owner, source);
  await h.controller.record(owner, {sourceTabId: 20, windowId: 1, documentId: 'old-document', url: search('a')});
  const next = {...owner, identity: 'request:next', attemptId: 'next', runnerDocumentId: 'next-document'};
  const binding = await h.controller.bind(next, {...source, created: false});
  assert.equal(binding.transferred, true);
  assert.equal((await h.controller.get(owner)).length, 0);
  assert.equal(binding.createdByTask, false);
  assert.equal(binding.documentId, '');
  assert.equal(await h.controller.record(owner, {sourceTabId: 20, windowId: 1, documentId: 'late', url: search('a')}), false);
});

test('replacement migration clears document authority until the exact owner proves its new source', async () => {
  const h = bindingHarness();
  await h.controller.bind(owner, source);
  await h.controller.record(owner, {sourceTabId: 20, windowId: 1, documentId: 'old-document', url: search('a')});
  await h.controller.replace(20, 21);
  const migrated = (await h.controller.get(owner))[0];
  assert.equal(migrated.sourceTabId, 21);
  assert.equal(migrated.documentId, '');
  assert.equal(migrated.createdByTask, true);
  for (const bad of [{sourceTabId: 20}, {windowId: 2}, {documentId: ''}]) {
    assert.equal(await h.controller.record(owner, {sourceTabId: 21, windowId: 1, documentId: 'new', url: search('b'), ...bad}), false);
  }
  assert.equal(await h.controller.record({...owner, runnerDocumentId: 'other'},
    {sourceTabId: 21, windowId: 1, documentId: 'new', url: search('b')}), false);
  assert.equal(await h.controller.record(owner, {sourceTabId: 21, windowId: 1, documentId: 'new', url: search('b')}), true);
});

test('closed source removal is idempotent and retains other live sources for the same task', async () => {
  const h = bindingHarness();
  await h.controller.bind(owner, source);
  await h.controller.bind(owner, {...source, tabId: 21});
  await h.controller.forget(20);
  await h.controller.forget(20);
  assert.deepEqual(Array.from(await h.controller.get(owner), entry => entry.sourceTabId), [21]);
  await h.controller.forget(21);
  assert.deepEqual(h.storage.data[h.module.STORAGE_KEY], {});
});

test('a timed-out binding cannot write late after its storage read resumes or revoke newer authority', async () => {
  const storage = memory();
  let release;
  const originalGet = storage.get;
  storage.get = () => new Promise(resolve => { release = resolve; });
  const h = bindingHarness(storage);
  let canceled = false;
  const pending = h.controller.bind(owner, source, {shouldWrite: () => !canceled});
  await Promise.resolve();
  canceled = true;
  storage.get = originalGet;
  release({});
  assert.equal(await pending, null);
  assert.equal(storage.data[h.module.STORAGE_KEY], undefined);
  const next = {...owner, identity: 'request:next', attemptId: 'next'};
  await h.controller.bind(next, {...source, created: false});
  assert.equal((await h.controller.get(next))[0].createdByTask, false);
  assert.equal((await h.controller.get(owner)).length, 0);
});

test('cleanup recorder failures and a never-answering runtime message do not hang the caller', async () => {
  const rejected = bindingHarness(memory(), {chrome: {runtime: {sendMessage: async () => { throw new Error('closed'); }}}});
  await assert.doesNotReject(() => rejected.module.recordNavigation(20, search('a')));
  let deadline;
  const hanging = bindingHarness(memory(), {chrome: {runtime: {sendMessage: () => new Promise(() => {})}},
    setTimeout: (callback, delay) => { deadline = delay; queueMicrotask(callback); return 1; }, clearTimeout: () => {}});
  await hanging.module.recordNavigation(20, search('a'));
  assert.equal(deadline, 5000);
});

function integrationHarness({storage = memory(), session = memory(), pages: initialPages, kind = 'unattended'} = {}) {
  const pages = new Map((initialPages || [
    {id: 20, windowId: 1, url: source.url, documentId: 'home-document', status: 'complete', active: false},
    {id: 900, windowId: 1, url: 'chrome-extension://test/sidebar/sidebar.html', documentId: 'runner-document', active: true},
  ]).map(page => [page.id, {...page}]));
  const operations = [];
  const plan = {enabled: true, platform: 'douyin', keywords: ['a', 'b']};
  const state = {idle: true, request: {id: 'request', attemptId: 'attempt', status: 'running', runnerTabId: 900, planSnapshot: plan},
    kind, probe: null};
  const manual = {id: 'manual', commandId: 'command', status: 'claimed', runnerTabId: 900,
    claimedDocumentId: 'runner-document', plan};
  storage.data.manual = {manual};
  const sender = () => ({tab: {id: 900}, documentId: 'runner-document', url: state.kind === 'manual'
    ? 'chrome-extension://test/sidebar/sidebar.html?manualKeywordBatch=manual'
    : `chrome-extension://test/sidebar/sidebar.html?unattendedRun=${state.request.id}&unattendedAttempt=${state.request.attemptId}`});
  let newId = 1000;
  const tabs = {
    async get(id) { if (!pages.has(id)) throw new Error(`No tab with id: ${id}.`); return {...pages.get(id)}; },
    async query(query = {}) { return [...pages.values()].filter(page =>
      (query.windowId === undefined || page.windowId === query.windowId) && (!query.active || page.active) &&
      (!query.currentWindow || page.windowId === 1)).map(page => ({...page})); },
    async update(id, patch) {
      const tab = await this.get(id);
      if (patch.active) for (const page of pages.values()) if (page.windowId === tab.windowId) page.active = false;
      Object.assign(tab, patch);
      if (patch.url) { tab.documentId = `navigated-${id}-${operations.length}`; tab.status = 'complete'; delete tab.pendingUrl; }
      pages.set(id, tab); operations.push({type: 'update', id, ...patch}); return {...tab};
    },
    async remove(id) { operations.push({type: 'remove', id}); pages.delete(id); },
    async create(props) { const id = ++newId; const tab = {id, windowId: 1, documentId: `created-${id}`, status: 'complete', ...props};
      pages.set(id, tab); operations.push({type: 'create', ...tab}); return {...tab}; },
  };
  const context = vm.createContext({console, URL, setTimeout, clearTimeout, crypto: webcrypto,
    chrome: {storage: {local: storage, session}, tabs,
      windows: {WINDOW_ID_NONE: -1, update: async () => {}},
      scripting: {executeScript: async ({target}) => {
        const page = await tabs.get(target.tabId);
        if (state.probe) return state.probe(page);
        return [{frameId: 0, documentId: page.documentId, result: {url: page.url, safeForCleanup: true}}];
      }}},
    isTaskBrowserIdle: async () => state.idle,
    resolveCaptureTaskTabId: value => Number.isSafeInteger(value) && value > 0 ? value : null,
    UNATTENDED_RUNNER_QUERY_KEY: 'unattendedRun', UNATTENDED_RUNNER_ATTEMPT_QUERY_KEY: 'unattendedAttempt',
    isOwnExtensionPageUrl: value => value.startsWith('chrome-extension://test/'),
    readUnattendedKeywordRunRequest: async () => state.request,
    isTerminalUnattendedRunStatus: status => ['completed', 'failed', 'canceled', 'needs_action'].includes(status),
    OnStarvoiceManualKeywordDispatch: {STORAGE_KEY: 'manual'},
    scheduleTaskBrowserCleanup: async () => {}, runCaptureExecutionLockOperation: fn => fn(),
    runCaptureTaskLifecycleOperation: fn => fn(), normalizePlatformId: value => value,
    detectPlatformFromUrl: value => value.startsWith('https://www.douyin.com/') ? 'douyin' : 'unknown',
    getPlatformHomeUrl: () => source.url, syncRuntimeForTabId: async () => {},
    normalizeUnattendedKeywordPlan: value => value,
    createUnattendedKeywordRunRequest: async () => state.request,
    openUnattendedRunnerTab: async () => ({id: 900}), bindUnattendedRunnerTab: async () => state.request,
    getUnattendedExecutionCopy: () => ({runnerLabel: 'runner'}), markUnattendedRunRequestStale: async () => {},
  });
  vm.runInContext(bindingSource, context);
  vm.runInContext(homeSource, context);
  vm.runInContext(safetySource, context);
  vm.runInContext(section(background, 'const keywordSourceBindings =', 'async function canCloseManualKeywordRunner('), context);
  for (const name of ['findExistingPlatformTab', 'activateOrCreatePlatformTab', 'launchUnattendedKeywordRun']) {
    vm.runInContext(fn(background, name), context);
  }
  const dispatch = vm.runInContext(`(async (message, sender, sendResponse) => {
    const type = message.type;
    ${section(background, "      if (type === 'onstarvoice:switch-platform-tab')", "      if (type === 'onstarvoice:begin-capture-task')")}
  })`, context);
  context.chrome.runtime = {sendMessage: async message => {
    let response; await dispatch(message, sender(), value => { response = value; }); return response;
  }};
  const api = vm.runInContext('({keywordSourceBindings, taskHomeCleanup, bindKeywordSource, recordKeywordSourceNavigation, queueFinishedTaskHome, getTaskHomeCreationSessionId})', context);
  return {context, api, state, manual, plan, pages, operations, storage, session, sender, tabs,
    switch: () => context.chrome.runtime.sendMessage({type: 'onstarvoice:switch-platform-tab', platform: 'douyin'}),
    record: url => context.chrome.runtime.sendMessage({type: 'onstarvoice:record-keyword-source-navigation', sourceTabId: 20, expectedUrl: url}),
    request: () => state.kind === 'manual' ? storage.data.manual.manual : state.request};
}

function loadProgressFlow(h) {
  Object.assign(h.context, {activeCaptureTaskProgressContext: null, activeUnattendedRunRequestId: 'request',
    activeUnattendedRunAttemptId: 'attempt', activeUnattendedProgressSeq: 0,
    getKeywordExecutionCopy: () => ({taskLabel: 'task'}), summarizeUnattendedKeywordCheckpoint: () => ({}),
    buildUnattendedTaskCounts: () => ({}), reportUnattendedKeywordRun: async () => {},
    refreshDataPool: async () => {}, refreshSyncHistory: async () => {}, showMessage: () => {},
  });
  for (const name of ['readFiniteProgressNumber', 'readProgressText', 'isCaptureTaskWaitPhase',
    'isCaptureTaskDetailPhase', 'isCaptureTaskSyncPhase', 'projectCaptureTaskProgress',
    'createUnattendedKeywordProgressReporter', 'drainStreamingDetailSyncQueue', 'buildUnattendedTerminalProgress']) {
    vm.runInContext(fn(sidebar, name), h.context);
  }
}

test('actual streaming drain clears progress runnerTabId while durable source still returns home', async () => {
  const h = integrationHarness();
  await h.switch();
  await h.tabs.update(20, {url: search('a')});
  assert.equal((await h.record(search('a'))).data.recorded, true);
  loadProgressFlow(h);
  const reporter = h.context.createUnattendedKeywordProgressReporter('request', {attemptId: 'attempt'});
  reporter({runnerTabId: 20, keyword: 'a', phase: 'detail_batch_done'});
  assert.equal(reporter.getSnapshot().runnerTabId, 20);
  const stats = {processedCount: 1, enqueuedCount: 1, successCount: 1, remainingCount: 0};
  await h.context.drainStreamingDetailSyncQueue({enabled: true, getStats: () => stats, drain: async () => stats},
    {notifyProgress: reporter});
  assert.equal(reporter.getSnapshot().runnerTabId, null);
  const progress = h.context.buildUnattendedTerminalProgress({previousProgress: reporter.getSnapshot(),
    requestId: 'request', attemptId: 'attempt', taskTotal: 1, summary: {completed: 1}});
  assert.equal(progress.runnerTabId, null);
  await h.api.queueFinishedTaskHome({...h.state.request, status: 'completed', progress});
  assert.equal(h.pages.get(20).url, source.url);
  assert.equal(h.operations.filter(row => row.type === 'create').length, 0);
  assert.deepEqual(h.storage.data['onstarvoice.taskHomeCleanup.v1'], {});
});

test('real launch create followed by runner switch retains created ownership', async () => {
  const h = integrationHarness({pages: [{id: 900, windowId: 1, url: 'chrome-extension://test/sidebar/sidebar.html', active: true}]});
  await h.context.launchUnattendedKeywordRun(h.plan);
  const switched = await h.switch();
  const saved = await h.api.keywordSourceBindings.get(owner);
  assert.equal(saved[0].sourceTabId, switched.data.tabId);
  assert.equal(saved[0].createdByTask, true);
  assert.equal(saved[0].runnerDocumentId, 'runner-document');
});

test('source-binding storage that never answers cannot block platform switching or unattended launch', async () => {
  for (const kind of ['manual', 'unattended']) {
    const h = integrationHarness({kind});
    const deadlines = [];
    h.context.setTimeout = (callback, delay) => { deadlines.push(delay); return setTimeout(callback, 1); };
    h.storage.get = () => new Promise(() => {});
    assert.equal((await h.switch()).ok, true);
    assert.ok(deadlines.every(delay => delay === 1500));
    assert.equal(h.pages.get(20).url, source.url);
  }
  const h = integrationHarness();
  h.context.setTimeout = callback => setTimeout(callback, 1);
  h.storage.get = () => new Promise(() => {});
  assert.equal((await h.context.launchUnattendedKeywordRun(h.plan)).id, 'request');
});

test('terminal home queue returns when a timed-out bind has wedged the same registry serial queue', async () => {
  const h = integrationHarness();
  h.context.setTimeout = callback => setTimeout(callback, 1);
  const originalGet = h.storage.get;
  h.storage.get = key => key === 'onstarvoice.keywordSourceBindings.v1'
    ? new Promise(() => {}) : originalGet(key);
  assert.equal((await h.switch()).ok, true);
  await h.api.queueFinishedTaskHome({...h.state.request, status: 'completed', progress: {runnerTabId: null}});
  assert.equal(h.pages.get(20).url, source.url);
  assert.equal(h.operations.filter(row => row.type === 'create' || row.type === 'remove' || row.url).length, 0);
});

for (const kind of ['unattended', 'manual']) for (const status of ['completed', 'failed', 'canceled']) {
  test(`${kind} ${status}: actual switch/navigation/terminal chain closes proven source beside existing home`, async () => {
    const h = integrationHarness({kind});
    await h.switch();
    await h.tabs.update(20, {url: search('b')});
    assert.equal((await h.record(search('b'))).data.recorded, true);
    h.pages.set(30, {id: 30, windowId: 1, url: source.url, documentId: 'existing-home', status: 'complete'});
    await h.api.queueFinishedTaskHome({...h.request(), status, progress: {runnerTabId: null}});
    assert.equal(h.pages.has(20), false);
    assert.equal(h.pages.get(30).url, source.url);
    assert.equal(h.operations.filter(row => row.type === 'create').length, 0);
  });
}

test('service-worker restart preserves exact source proof and does not create another page', async () => {
  const h = integrationHarness();
  await h.switch();
  await h.tabs.update(20, {url: search('a')});
  await h.record(search('a'));
  const restarted = integrationHarness({storage: h.storage, session: h.session, pages: [...h.pages.values()]});
  await restarted.api.queueFinishedTaskHome({...h.state.request, status: 'failed', progress: {runnerTabId: null}});
  assert.equal(restarted.pages.get(20).url, source.url);
  assert.equal(restarted.operations.filter(row => row.type === 'create').length, 0);
});

test('continuous keywords retain one source binding and the final restored document', async () => {
  const h = integrationHarness();
  await h.switch();
  for (const keyword of ['a', 'b', 'a']) {
    await h.tabs.update(20, {url: search(keyword)});
    assert.equal((await h.record(search(keyword))).data.recorded, true);
  }
  const saved = await h.api.keywordSourceBindings.get(owner);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].documentId, h.pages.get(20).documentId);
  assert.equal(saved[0].expectedSourceUrl, search('a'));
  await h.api.queueFinishedTaskHome({...h.state.request, status: 'completed'});
  assert.equal(h.pages.get(20).url, source.url);
});

test('same URL reload, another keyword in the plan, missing document and a queried unbound tab are not authority', async () => {
  const h = integrationHarness();
  await h.switch();
  await h.tabs.update(20, {url: search('b')});
  assert.equal((await h.record(search('a'))).data.recorded, false, 'a navigation cannot claim a b document');
  h.pages.set(21, {...h.pages.get(20), id: 21});
  assert.equal((await h.context.chrome.runtime.sendMessage({type: 'onstarvoice:record-keyword-source-navigation',
    sourceTabId: 21, expectedUrl: search('b')})).data.recorded, false);
  assert.equal((await h.record(search('b'))).data.recorded, true);
  h.pages.get(20).documentId = 'user-reloaded-same-url';
  await h.api.queueFinishedTaskHome({...h.state.request, status: 'completed'});
  assert.equal(h.pages.get(20).url, search('b'));
  assert.equal(h.operations.filter(row => row.type === 'create' || row.type === 'remove').length, 0);
});

test('recording rejects old attempts, wrong runner documents for manual and unrelated extension pages', async () => {
  const h = integrationHarness();
  await h.switch(); await h.tabs.update(20, {url: search('a')});
  const stale = h.sender(); h.state.request = {...h.state.request, attemptId: 'new-attempt'};
  assert.equal((await h.api.recordKeywordSourceNavigation({sourceTabId: 20, expectedUrl: search('a')}, stale)).recorded, false);
  h.state.kind = 'manual'; await h.switch();
  for (const sender of [{...h.sender(), documentId: 'reloaded'}, {...h.sender(), tab: {id: 901}},
    {...h.sender(), url: 'chrome-extension://test/other.html?manualKeywordBatch=manual'}]) {
    assert.equal((await h.api.recordKeywordSourceNavigation({sourceTabId: 20, expectedUrl: search('a')}, sender)).recorded, false);
  }
});

test('an unbound old progress tab and needs_action produce no navigation or fallback home', async () => {
  const h = integrationHarness();
  h.pages.get(20).url = search('a');
  await h.api.queueFinishedTaskHome({...h.state.request, status: 'completed', progress: {runnerTabId: 20}});
  await h.switch(); await h.record(search('a'));
  await h.api.queueFinishedTaskHome({...h.state.request, status: 'needs_action'});
  assert.equal(h.pages.get(20).url, search('a'));
  assert.equal(h.operations.filter(row => row.type === 'create' || row.type === 'remove' || row.url).length, 0);
});

test('source wiring is invoked after readiness, on restore, and before final source consumers', () => {
  assert.match(capture, /import '\.\/keyword-source-binding\.js'/);
  assert.match(sidebar, /from "\.\.\/utils\/capture-sync\.js"/);
  const bootstrap = fn(sidebar, 'navigateActiveTabToKeywordSearchForPlan');
  assert.ok(bootstrap.indexOf('recordNavigation(preferredTabId, searchUrl)') > bootstrap.indexOf('await waitForRuntimeSearchPage'));
  const batch = section(capture, 'export async function batchCaptureByKeywords(', '// 小红书搜索路由');
  assert.ok(batch.indexOf('recordNavigation(runnerTabId, searchUrl)') > batch.indexOf('await waitForKeywordSearchResultsInTab'));
  assert.match(batch, /recordNavigation\(runnerTabId, runnerCtx\.sourcePageUrl\)/);
  assert.doesNotMatch(section(background, 'async function queueFinishedTaskHome(', 'async function canCloseManualKeywordRunner('),
    /sourceTabId:\s*(?:normalized|current)\.progress/);
});

test('targeted home creation token survives worker restart but not full browser session or unavailable session storage', async () => {
  const h = integrationHarness();
  const first = await h.api.getTaskHomeCreationSessionId();
  assert.ok(first);
  const restarted = integrationHarness({session: h.session});
  assert.equal(await restarted.api.getTaskHomeCreationSessionId(), first);
  const newBrowser = integrationHarness();
  assert.notEqual(await newBrowser.api.getTaskHomeCreationSessionId(), first);
  const unavailable = integrationHarness({session: null});
  assert.equal(await unavailable.api.getTaskHomeCreationSessionId(), null);
});
