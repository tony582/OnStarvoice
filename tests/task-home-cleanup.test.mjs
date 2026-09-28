import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../utils/task-home-cleanup.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
function harness() {
  const context = vm.createContext({URL});
  vm.runInContext(source, context);
  const state = {}, pages = new Map([[11, {id: 11, windowId: 1, url: 'chrome-extension://test/sidebar/sidebar.html?unattendedRun=a', active: true}]]);
  const updates = [], created = [];
  let idle = true, fail = false, beforeGet = () => {}, beforeIdle = () => {};
  const deps = {
    storage: {async get(key) {return {[key]: structuredClone(state[key])};}, async set(value) {Object.assign(state, structuredClone(value));}},
    tabs: {
      async query({windowId}) {return [...pages.values()].filter(tab => tab.windowId === windowId).map(tab => ({...tab}));},
      async get(id) {beforeGet(id); if (!pages.has(id)) throw Error('No tab with id'); return {...pages.get(id)};},
      async update(id, patch) {if (fail) throw Error('temporary'); updates.push({id, ...patch}); Object.assign(pages.get(id), patch); return {...pages.get(id)};},
      async create(patch) {if (fail) throw Error('temporary'); const tab = {...patch, id: 100 + created.length}; created.push(tab); pages.set(tab.id, tab); return tab;},
    },
    canPark: async () => {beforeIdle(); return idle;},
  };
  const create = () => context.OnStarvoiceTaskHomeCleanup.createController(deps);
  return {api: context.OnStarvoiceTaskHomeCleanup, create, controller: create(), pages, state, updates, created,
    idle: value => {idle = value;}, fail: value => {fail = value;}, beforeGet: fn => {beforeGet = fn;}, beforeIdle: fn => {beforeIdle = fn;}};
}
const base = {identity: 'a:b', platform: 'douyin', windowId: 1, runnerTabId: 11, keywords: ['安吉星']};

test('a hundred settled tasks reuse one platform home', async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) {
    await h.controller.enqueue({...base, identity: `task:${i}`});
    const result = await h.controller.reconcile();
    assert.equal(result[0].parked, true);
  }
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].url, 'https://www.douyin.com/');
});

test('an exact finished keyword source returns home without opening another tab', async () => {
  const h = harness(), url = 'https://www.douyin.com/search/%E5%AE%89%E5%90%89%E6%98%9F?type=general';
  h.pages.set(12, {id: 12, windowId: 1, url});
  await h.controller.enqueue({...base, sourceTabId: 12, expectedSourceUrl: url});
  assert.equal((await h.controller.reconcile())[0].parked, true);
  assert.equal(h.pages.get(12).url, 'https://www.douyin.com/');
  assert.equal(h.created.length, 0);
});

test('active collection defers UI cleanup across a worker restart', async () => {
  const h = harness(); h.idle(false);
  await h.controller.enqueue(base);
  assert.equal((await h.controller.reconcile())[0].reason, 'capture_active');
  assert.equal(h.created.length, 0);
  h.idle(true);
  assert.equal((await h.create().reconcile())[0].parked, true);
});

test('failed home creation persists an obligation and retry does not duplicate', async () => {
  const h = harness(); h.fail(true);
  await h.controller.enqueue(base);
  assert.equal((await h.controller.reconcile())[0].reason, 'home_cleanup_pending');
  h.fail(false);
  assert.equal((await h.create().reconcile())[0].parked, true);
  assert.equal((await h.create().reconcile()).length, 0);
  assert.equal(h.created.length, 1);
});

test('user navigation, foreign tabs and another window are preserved', async () => {
  const h = harness();
  h.pages.get(11).active = false;
  h.pages.set(12, {id: 12, windowId: 1, url: 'https://www.douyin.com/user/personal', active: true});
  h.pages.set(13, {id: 13, windowId: 2, url: 'https://www.douyin.com/', active: true});
  await h.controller.enqueue({...base, sourceTabId: 12, expectedSourceUrl: 'https://www.douyin.com/search/安吉星'});
  await h.controller.reconcile();
  assert.equal(h.updates.length, 0);
  assert.equal(h.created[0].active, false);
  assert.equal(h.created[0].windowId, 1);
  assert.equal(h.pages.get(12).url, 'https://www.douyin.com/user/personal');
});

test('navigation while checking a source never gets overwritten', async () => {
  const h = harness(), url = 'https://www.douyin.com/search/安吉星';
  h.pages.set(12, {id: 12, windowId: 1, url});
  await h.controller.enqueue({...base, sourceTabId: 12, expectedSourceUrl: url});
  h.beforeGet(() => {h.pages.get(12).url = 'https://example.com/';});
  assert.equal((await h.controller.reconcile())[0].reason, 'source_navigated');
  assert.equal(h.updates.length, 0);
});

test('closed browser windows are never recreated for cosmetic cleanup', async () => {
  const h = harness();
  await h.controller.enqueue({...base, windowId: 2});
  assert.equal((await h.controller.reconcile())[0].reason, 'window_closed');
  assert.equal(h.created.length, 0);
});

test('navigation during the final idle check never gets overwritten', async () => {
  const h = harness(), url = 'https://www.douyin.com/search/安吉星';
  h.pages.set(12, {id: 12, windowId: 1, url});
  await h.controller.enqueue({...base, sourceTabId: 12, expectedSourceUrl: url});
  let checks = 0;
  h.beforeIdle(() => {if (++checks === 2) h.pages.get(12).url = 'https://example.com/';});
  assert.equal((await h.controller.reconcile())[0].reason, 'source_navigated');
  assert.equal(h.updates.length, 0);
});

test('persisted source ids after restart cannot authorize navigation of a reused tab', async () => {
  const h = harness(), url = 'https://www.douyin.com/search/安吉星';
  h.pages.set(12, {id: 12, windowId: 1, url});
  await h.controller.enqueue({...base, sourceTabId: 12, expectedSourceUrl: url});
  await h.create().reconcile();
  assert.equal(h.pages.get(12).url, url);
  assert.equal(h.updates.length, 0);
  assert.equal(h.created.length, 1);
});

test('a source tab removed during this worker lifetime loses navigation authority', async () => {
  const h = harness(), url = 'https://www.douyin.com/search/安吉星';
  h.pages.set(12, {id: 12, windowId: 1, url});
  await h.controller.enqueue({...base, sourceTabId: 12, expectedSourceUrl: url});
  await h.controller.forgetTab(12);
  await h.controller.reconcile();
  assert.equal(h.pages.get(12).url, url);
  assert.equal(h.created.length, 1);
});

test('only exact known platform search keywords qualify for source navigation', () => {
  const {api} = harness();
  assert.equal(api.isPlanSearch('https://www.xiaohongshu.com/search_result?keyword=安吉星', 'xiaohongshu', ['安吉星']), true);
  for (const url of ['https://evil.com/search/安吉星', 'https://www.douyin.com/search/安吉星?modal_id=123',
    'https://www.douyin.com/search/别的词', 'https://www.douyin.com/user/安吉星', 'https://www.douyin.com/search/%ZZ']) {
    assert.equal(api.isPlanSearch(url, 'douyin', ['安吉星']), false, url);
  }
});

test('the actual background home entry accepts warning/partial/error terminals but not active or human action', async () => {
  const enqueued = [];
  const context = vm.createContext({
    console, OnStarvoiceTaskHomeCleanup: {HOMES: {douyin: 'https://www.douyin.com/'}, isPlanSearch: () => false},
    taskHomeCleanup: {enqueue: async value => enqueued.push(value), reconcile: async () => []},
    chrome: {tabs: {get: async () => ({id: 11, windowId: 1})}},
    resolveCaptureTaskTabId: () => null, scheduleTaskBrowserCleanup: async () => {},
    runCaptureExecutionLockOperation: fn => fn(),
  });
  vm.runInContext(background.slice(background.indexOf('async function queueFinishedTaskHome('),
    background.indexOf('async function canCloseManualKeywordRunner(')), context);
  for (const status of ['completed', 'completed_with_warnings', 'completed_with_failures', 'failed', 'canceled', 'skipped', 'running', 'recovering', 'needs_action']) {
    await context.queueFinishedTaskHome({id: status, attemptId: 'a', status, platform: 'douyin', runnerTabId: 11});
  }
  assert.deepEqual(enqueued.map(row => row.identity), [
    'completed:a', 'completed_with_warnings:a', 'completed_with_failures:a', 'failed:a', 'canceled:a', 'skipped:a',
  ]);
});
