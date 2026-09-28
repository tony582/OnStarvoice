import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const wiring = background.slice(background.indexOf("const TASK_BROWSER_CLEANUP_ALARM ="),
  background.indexOf('async function canCloseManualKeywordRunner('));
const sourceFiles = ['utils/task-home-cleanup.js', 'utils/task-window-sources.js',
  'utils/keyword-source-binding.js', 'utils/task-home-page-safety.js'];
const helpers = await Promise.all(sourceFiles.map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
const terminal = value => ['completed', 'failed', 'canceled', 'needs_action'].includes(value);
const search = 'https://www.douyin.com/search/旧关键词?type=general';
const home = 'https://www.douyin.com/jingxuan';
const keys = {captureExecutionLock: 'lock', runtime: 'runtime', unattendedKeywordRunRequest: 'unattended', targetedPostRunRequest: 'targeted'};
function harness() {
  const data = {}, session = {}, pages = new Map(), created = [], removed = [], navigated = [];
  let serial = 900, probeHook = () => {};
  const storage = state => ({
    async get(key) {
      if (key == null) return structuredClone(state);
      return Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, structuredClone(state[name])]));
    },
    async set(patch) {Object.assign(state, structuredClone(patch));},
    async remove(key) {delete state[key];},
  });
  const tabs = {
    async query({windowId} = {}) {return [...pages.values()].filter(tab => !windowId || tab.windowId === windowId).map(tab => ({...tab}));},
    async get(id) {if (!pages.has(id)) throw Error(`No tab with id: ${id}.`); return {...pages.get(id)};},
    async update(id, patch) {navigated.push({id, ...patch}); Object.assign(pages.get(id), patch,
      patch.url ? {documentId: `changed-${++serial}`, status: 'complete'} : {}); return {...pages.get(id)};},
    async remove(id) {removed.push(id); pages.delete(id);},
    async create(patch) {const tab = {id: ++serial, documentId: `new-${serial}`, status: 'complete', ...patch}; pages.set(tab.id, tab); created.push(tab); return {...tab};},
  };
  const ctx = vm.createContext({console, URL, crypto: webcrypto, setTimeout, clearTimeout,
    STORAGE_KEYS: keys, inFlightContentRelays: new Map(), captureTaskCleanupInProgress: new Set(),
    isTerminalUnattendedRunStatus: terminal,
    cloudTargetedPostApi: {isTerminalRunStatus: terminal, shouldPreservePlatformTab: request => request.status === 'needs_action'},
    OnStarvoiceManualKeywordDispatch: {STORAGE_KEY: 'manual'},
    readUnattendedKeywordRunRequest: async () => data.unattended,
    readTargetedPostRunRequest: async () => data.targeted,
    runCaptureExecutionLockOperation: async operation => operation(),
    chrome: {storage: {local: storage(data), session: storage(session)}, tabs,
      alarms: {async create() {}}, scripting: {async executeScript({target}) {
        probeHook(target.tabId); const tab = pages.get(target.tabId);
        return tab ? [{frameId: 0, documentId: tab.documentId,
          result: {url: tab.url, safeForCleanup: tab.safeForCleanup !== false}}] : [];
      }}},
  });
  for (const helper of helpers) vm.runInContext(helper, ctx);
  vm.runInContext(wiring, ctx);
  const page = (id, url, options = {}) => {pages.set(id, {id, url, documentId: `doc-${id}`, windowId: 1, status: 'complete', ...options}); return pages.get(id);};
  const start = async (id = 'task', platform = 'douyin') => {
    const request = {id, attemptId: `${id}-attempt`, status: 'running', platform, workflow: 'discovered_post_capture', runnerTabId: 10};
    data.targeted = request; page(10, 'chrome-extension://test/sidebar/sidebar.html');
    const detail = page(20, 'about:blank#onstarvoice-targeted-post=owned');
    await ctx.captureManagedTaskWindow(request, detail);
    return request;
  };
  const finish = async request => {request.status = 'completed'; pages.delete(20);
    await ctx.queueFinishedTaskHome(request, {runnerTab: {id: 10, windowId: 1}, allowCreateHome: true});};
  return {ctx, data, session, pages, page, start, finish, created, removed, navigated,
    probe(fn) {probeHook = fn;},
    reconcile: () => vm.runInContext('taskHomeCleanup.reconcile()', ctx)};
}

for (const existingHome of [false, true]) {
  test(`discovery closes the pre-task search and leaves one home (existing home=${existingHome})`, async () => {
    const h = harness(); h.page(1, search); if (existingHome) h.page(2, home);
    h.page(3, 'https://www.douyin.com/note/leave-this-detail');
    h.page(4, search, {windowId: 2}); h.page(5, 'https://www.xiaohongshu.com/explore');
    await h.finish(await h.start());
    const platformPages = [...h.pages.values()].filter(tab => tab.windowId === 1 && (tab.id === 1 || tab.id === 2));
    assert.equal(platformPages.length, 1); assert.match(platformPages[0].url, /^https:\/\/www\.douyin\.com\/(?:jingxuan)?$/);
    assert.equal(h.created.length, 0); assert.equal(h.pages.has(3), true); assert.equal(h.pages.has(4), true); assert.equal(h.pages.has(5), true);
    if (existingHome) assert.deepEqual(h.removed, [1]); else assert.equal(h.navigated[0].id, 1);
  });
}

test('one hundred mixed terminal tasks reuse the same home without cumulative tabs', async () => {
  const h = harness(); h.page(1, search); h.page(2, home); h.page(3, home);
  for (let i = 0; i < 100; i++) {
    const request = await h.start(`task-${i}`);
    request.workflow = ['discovered_post_capture', 'negative_post_patrol', 'watched_content_patrol',
      'official_account_comment_patrol', 'followed_creator_post_patrol', 'official_account_post_discovery'][i % 6];
    await h.finish(request);
    assert.equal([...h.pages.values()].filter(tab => tab.windowId === 1 && tab.url.startsWith('https://www.douyin.com/')).length, 1);
  }
  assert.equal(h.created.length, 0);
});

for (const change of ['same_url_document', 'user_navigation', 'loading', 'security', 'session', 'new_task', 'debug', 'relay']) {
  test(`a ${change} change preserves the page and never creates a fallback`, async () => {
    const h = harness(); h.page(1, search); const request = await h.start();
    if (change === 'same_url_document') h.pages.get(1).documentId = 'user-reload';
    if (change === 'user_navigation') h.pages.get(1).url = 'https://www.douyin.com/user/person';
    if (change === 'loading') h.pages.get(1).status = 'loading';
    if (change === 'security') h.pages.get(1).safeForCleanup = false;
    if (change === 'session') for (const key of Object.keys(h.session)) delete h.session[key];
    if (change === 'new_task') h.data.lock = {id: 'next-task-lock'};
    if (change === 'debug') h.data.runtime = {captureDebugSession: {taskId: 'active'}};
    if (change === 'relay') vm.runInContext("inFlightContentRelays.set('active', {})", h.ctx);
    await h.finish(request);
    assert.equal(h.pages.has(1), true); assert.equal(h.created.length, 0); assert.equal(h.navigated.length, 0); assert.equal(h.removed.length, 0);
  });
}

test('unknown pre-task document remains a blocking obligation instead of creating an extra home', async () => {
  const h = harness(); h.page(1, search, {documentId: ''}); const request = await h.start();
  h.pages.get(1).documentId = 'late-doc'; await h.finish(request);
  assert.equal(h.created.length, 0); assert.equal(h.removed.length, 0); assert.equal(h.navigated.length, 0);
});

test('the next real task may freshly snapshot a previous protected or changed document', async () => {
  const h = harness(); h.page(1, search); const old = await h.start('old');
  h.pages.get(1).documentId = 'replacement'; await h.finish(old);
  assert.equal(h.navigated.length, 0);
  await h.finish(await h.start('next'));
  assert.equal(h.created.length, 0); assert.equal(h.navigated.length, 1);
});

test('an old terminal callback cannot borrow a newer task snapshot', async () => {
  const h = harness(); h.page(1, search); const old = await h.start('old');
  const next = await h.start('next'); old.status = 'completed';
  await h.ctx.queueFinishedTaskHome(old, {runnerTab: {id: 10, windowId: 1}, allowCreateHome: true});
  assert.equal(h.created.length, 0); assert.equal(h.removed.length, 0); assert.equal(h.navigated.length, 0);
  await h.finish(next); assert.equal(h.navigated.length, 1);
});
