import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../utils/task-home-cleanup.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const homeUrl = 'https://www.douyin.com/';
const searchUrl = 'https://www.douyin.com/search/%E5%AE%89%E5%90%89%E6%98%9F?type=general';
const base = {identity: 'a:b', platform: 'douyin', windowId: 1, runnerTabId: 11, keywords: ['安吉星'], creationSessionId: 'browser-session-1'};
function harness() {
  const context = vm.createContext({URL}); vm.runInContext(source, context);
  const state = {}, pages = new Map([[11, {id: 11, windowId: 1, url: 'chrome-extension://test/sidebar/sidebar.html?unattendedRun=a', active: true, documentId: 'runner-doc'}]]);
  const updates = [], created = [], removed = [];
  let idle = true, failure = '', retainRemoved = false, serial = 1000, browserSession = 'browser-session-1';
  let beforeGet = () => {}, beforeIdle = () => {}, beforeDocument = () => {}, afterCreate = () => {}, beforeQuery = () => {};
  const deps = {
    storage: {async get(key) {return {[key]: structuredClone(state[key])};}, async set(value) {if (failure === 'storage') throw Error('storage full'); Object.assign(state, structuredClone(value));}},
    tabs: {
      async query({windowId}) {beforeQuery(); return [...pages.values()].filter(tab => tab.windowId === windowId).map(tab => ({...tab}));},
      async get(id) {beforeGet(id); if (!pages.has(id)) throw Error(`No tab with id: ${id}.`); return {...pages.get(id)};},
      async update(id, patch) {if (failure === 'update') throw Error('temporary update failure'); updates.push({id, ...patch}); Object.assign(pages.get(id), patch, patch.url ? {documentId: `home-doc-${id}`} : {}); return {...pages.get(id)};},
      async remove(id) {if (failure === 'remove') throw Error('temporary remove failure'); removed.push(id); if (!retainRemoved) pages.delete(id);},
      async create(patch) {if (failure === 'create') throw Error('temporary create failure'); const tab = {...patch, id: ++serial, documentId: `created-doc-${serial}`}; created.push(tab); pages.set(tab.id, tab); afterCreate(tab); return {...tab};},
    },
    canPark: async () => {beforeIdle(); return idle;},
    canCreateHome: async entry => Boolean(entry.creationSessionId && entry.creationSessionId === browserSession),
    getDocumentIdentity: async tabId => {beforeDocument(tabId); const tab = pages.get(tabId); return tab ? {documentId: tab.documentId, url: tab.url} : null;},
  };
  const create = () => context.OnStarvoiceTaskHomeCleanup.createController(deps);
  return {api: context.OnStarvoiceTaskHomeCleanup, deps, create, controller: create(), pages, state, updates, created, removed,
    addSource(tabId, options = {}) {
      const page = {id: tabId, windowId: options.windowId || 1, url: options.url || searchUrl, documentId: options.documentId || `doc-${tabId}`, active: false};
      pages.set(tabId, page);
      return {sourceTabId: tabId, expectedSourceUrl: page.url, documentId: page.documentId,
        createdByTask: options.createdByTask !== false, originalUrl: options.originalUrl || ''};
    },
    addHome(tabId = 90, url = homeUrl) {pages.set(tabId, {id: tabId, windowId: 1, url, documentId: `doc-${tabId}`});},
    pending() {return Object.values(state[this.api.STORAGE_KEY] || {});},
    idle: value => {idle = value;}, session: value => {browserSession = value;}, fail: value => {failure = value;}, retainRemoved: value => {retainRemoved = value;},
    beforeGet: fn => {beforeGet = fn;}, beforeIdle: fn => {beforeIdle = fn;}, beforeDocument: fn => {beforeDocument = fn;},
    afterCreate: fn => {afterCreate = fn;}, beforeQuery: fn => {beforeQuery = fn;}};
}

test('a hundred real tasks each with an owned search source converge to one home', async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) {
    await h.controller.enqueue({...base, identity: `task:${i}`, sources: [h.addSource(200 + i)]});
    const [result] = await h.controller.reconcile();
    assert.equal(result.parked, true); assert.equal(result.settled, true);
    assert.equal([...h.pages.values()].filter(tab => h.api.isHome(tab.url, 'douyin')).length, 1);
    assert.equal([...h.pages.values()].filter(tab => h.api.isPlanSearch(tab.url, 'douyin', base.keywords)).length, 0);
  }
  assert.equal(h.created.length, 0); assert.equal(h.updates.length, 1); assert.equal(h.removed.length, 99);
});

for (const home of ['https://www.douyin.com/', 'https://www.douyin.com/jingxuan', 'https://www.douyin.com/jingxuan/']) {
  test(`an existing ${home} is retained while the owned search page closes`, async () => {
    const h = harness(); h.addHome(90, home);
    await h.controller.enqueue({...base, sources: [h.addSource(12)]});
    const [result] = await h.controller.reconcile();
    assert.deepEqual(h.removed, [12]); assert.equal(result.closedCount, 1);
    assert.equal(h.pages.get(90).url, home); assert.equal(h.updates.length, 0); assert.equal(h.created.length, 0);
  });
}

test('Xiaohongshu trailing-slash search sources are eligible without broadening unrelated routes', async () => {
  const h = harness(); const url = 'https://www.xiaohongshu.com/search_result/?keyword=安吉星';
  assert.equal(h.api.isPlanSearch(url, 'xiaohongshu', base.keywords), true);
  await h.controller.enqueue({...base, platform: 'xiaohongshu', sources: [h.addSource(12, {url})]});
  await h.controller.reconcile();
  assert.equal(h.pages.get(12).url, 'https://www.xiaohongshu.com/explore'); assert.equal(h.created.length, 0);
});

test('distinct identities and all their sources survive deferred cleanup without being overwritten', async () => {
  const h = harness(); h.idle(false);
  await h.controller.enqueue({...base, sources: [h.addSource(12), h.addSource(13)]});
  await h.controller.enqueue({...base, identity: 'next:attempt', sources: [h.addSource(14)]});
  assert.equal(h.pending().length, 2);
  await h.controller.reconcile(); assert.equal(h.updates.length, 0);
  h.idle(true); await h.create().reconcile();
  assert.equal(h.pending().length, 0); assert.equal(h.created.length, 0);
  assert.equal([...h.pages.values()].filter(tab => h.api.isHome(tab.url, 'douyin')).length, 1);
  assert.equal(h.removed.length, 2);
});

test('an unchanged source document remains authorized after a service-worker restart', async () => {
  const h = harness(); await h.controller.enqueue({...base, sources: [h.addSource(12)]});
  const [result] = await h.create().reconcile();
  assert.equal(result.settled, true); assert.equal(h.pages.get(12).url, homeUrl); assert.equal(h.created.length, 0);
});

for (const change of ['document', 'url', 'window', 'pending', 'missing_document']) {
  test(`a ${change} change never authorizes source navigation or fallback creation`, async () => {
    const h = harness(); const owned = h.addSource(12);
    await h.controller.enqueue({...base, sources: [owned]});
    const tab = h.pages.get(12);
    if (change === 'document') tab.documentId = 'replacement-document';
    if (change === 'url') tab.url = 'https://www.douyin.com/passport/login';
    if (change === 'window') tab.windowId = 2;
    if (change === 'pending') tab.pendingUrl = searchUrl;
    if (change === 'missing_document') tab.documentId = '';
    const [result] = await h.create().reconcile();
    assert.equal(result.settled === true, false); assert.equal(h.pending().length, 1);
    assert.equal(h.updates.length, 0); assert.equal(h.removed.length, 0); assert.equal(h.created.length, 0);
  });
}

test('legacy numeric source IDs and tasks with no source stay pending without creating homes', async () => {
  for (const legacy of [true, false]) {
    const h = harness(); h.addSource(12); h.addHome();
    h.state[h.api.STORAGE_KEY] = {'1:douyin': {...base, ...(legacy ? {sourceTabId: 12, expectedSourceUrl: searchUrl} : {})}};
    const [result] = await h.controller.reconcile();
    assert.equal(result.settled === true, false); assert.equal(h.pending().length, 1);
    assert.equal(h.created.length, 0); assert.equal(h.removed.length, 0); assert.equal(h.updates.length, 0);
  }
});

test('borrowed source pages remain untouched next to an existing home by default', async () => {
  const h = harness(); h.addHome(); const borrowed = h.addSource(12, {createdByTask: false});
  await h.controller.enqueue({...base, sources: [borrowed]});
  const [result] = await h.controller.reconcile();
  assert.equal(result.reason, 'user_owned_preserved'); assert.equal(result.preservedCount, 1);
  assert.equal(result.closedCount, 0); assert.equal(h.pages.get(12).url, searchUrl);
  assert.equal(h.updates.length, 0); assert.equal(h.removed.length, 0); assert.equal(h.pending().length, 0);
});

test('a dedicated collection window may close a fully proven borrowed source beside its home', async () => {
  const h = harness(); h.addHome(90, 'https://www.douyin.com/jingxuan');
  await h.controller.enqueue({...base, dedicatedWindow: true, sources: [h.addSource(12, {createdByTask: false})]});
  await h.create().reconcile();
  assert.deepEqual(h.removed, [12]); assert.equal(h.created.length, 0); assert.equal(h.pages.has(90), true);
});

test('dedicated mode never upgrades a replaced or missing document into close authority', async () => {
  for (const proofMissing of [true, false]) {
    const h = harness(); h.addHome(); const owned = h.addSource(12, {createdByTask: false});
    if (proofMissing) owned.documentId = '';
    await h.controller.enqueue({...base, dedicatedWindow: true, sources: [owned]});
    if (!proofMissing) h.pages.get(12).documentId = 'new-document';
    await h.controller.reconcile(); assert.deepEqual(h.removed, []); assert.equal(h.pending().length, 1);
  }
});

test('without a home one verified source returns home and remaining dedicated sources close', async () => {
  const h = harness();
  await h.controller.enqueue({...base, dedicatedWindow: true,
    sources: [h.addSource(12, {createdByTask: false}), h.addSource(13, {createdByTask: false}), h.addSource(14)]});
  await h.controller.reconcile();
  assert.equal(h.updates.length, 1); assert.equal(h.removed.length, 2); assert.equal(h.created.length, 0);
  assert.equal([...h.pages.values()].filter(tab => h.api.isHome(tab.url, 'douyin')).length, 1);
});

test('new ownership revokes the old source obligation before it can use stale createdByTask', async () => {
  const h = harness(); const owned = h.addSource(12); h.addHome();
  await h.controller.enqueue({...base, sources: [owned]});
  await h.controller.enqueue({...base, identity: 'new:attempt', sources: [{...owned, createdByTask: false}]});
  assert.equal(h.pending().length, 1); assert.equal(h.pending()[0].identity, 'new:attempt');
  await h.controller.reconcile(); assert.deepEqual(h.removed, []);
  await h.controller.enqueue({...base, sources: [owned]}); await h.controller.revokeSource(12);
  assert.equal(h.pending().length, 0); await h.controller.reconcile(); assert.deepEqual(h.removed, []);
});

for (const action of ['update', 'remove']) {
  test(`${action} failures keep the exact source pending for retry after restart`, async () => {
    const h = harness(); if (action === 'remove') h.addHome();
    await h.controller.enqueue({...base, sources: [h.addSource(12)]}); h.fail(action);
    assert.equal((await h.controller.reconcile())[0].reason, 'home_cleanup_pending'); assert.equal(h.pending().length, 1);
    h.fail(''); const [result] = await h.create().reconcile(); assert.equal(result.settled, true);
    assert.equal(h.pending().length, 0); assert.equal(h.created.length, 0);
  });
}

test('a resolved remove that leaves the page open remains pending', async () => {
  const h = harness(); h.addHome(); await h.controller.enqueue({...base, sources: [h.addSource(12)]}); h.retainRemoved(true);
  assert.equal((await h.controller.reconcile())[0].reason, 'source_close_unconfirmed'); assert.equal(h.pending().length, 1);
});

test('storage failure before a home navigation leaves the source untouched', async () => {
  const h = harness(); await h.controller.enqueue({...base, sources: [h.addSource(12)]}); h.fail('storage');
  await h.controller.reconcile(); assert.equal(h.updates.length, 0); assert.equal(h.created.length, 0);
});

test('an identity or active-task change during verification prevents mutation', async () => {
  for (const change of ['document', 'capture_active']) {
    const h = harness(); h.addHome(); await h.controller.enqueue({...base, sources: [h.addSource(12)]});
    let calls = 0; h.beforeDocument(() => {if (++calls === 1) {
      if (change === 'document') h.pages.get(12).documentId = 'new'; else h.idle(false);
    }});
    await h.controller.reconcile(); assert.equal(h.removed.length, 0); assert.equal(h.updates.length, 0);
  }
});

test('a home appearing during source verification is reused, never added beside it', async () => {
  const h = harness(); await h.controller.enqueue({...base, sources: [h.addSource(12)]});
  h.beforeDocument(() => h.addHome()); await h.controller.reconcile();
  assert.equal(h.created.length, 0); assert.equal(h.updates.length, 0); assert.deepEqual(h.removed, [12]);
});

test('known login, detail and foreign routes never become removable task search pages', async () => {
  for (const url of ['https://www.douyin.com/passport/login', 'https://www.douyin.com/search/安吉星?modal_id=123',
    'https://www.douyin.com/user/personal', 'https://example.com/search/安吉星']) {
    const h = harness(); h.addHome(); await h.controller.enqueue({...base, dedicatedWindow: true, sources: [h.addSource(12, {url})]});
    await h.controller.reconcile(); assert.equal(h.removed.length, 0, url); assert.equal(h.updates.length, 0, url);
  }
});

test('explicit targeted closure evidence permits one home, while unknown keyword sources never create one', async () => {
  const unknown = harness(); await unknown.controller.enqueue(base); await unknown.controller.reconcile();
  assert.equal(unknown.created.length, 0); assert.equal(unknown.pending().length, 1);
  const h = harness(); await h.controller.enqueue({...base, allowCreateHome: true});
  assert.equal((await h.controller.reconcile())[0].settled, true); assert.equal(h.created.length, 1);
  for (let i = 0; i < 20; i++) {
    await h.controller.enqueue({...base, identity: `targeted:${i}`, allowCreateHome: true}); await h.create().reconcile();
  }
  assert.equal(h.created.length, 1);
});

test('authorized home creation rechecks for an existing jingxuan home after the idle await', async () => {
  const h = harness(); await h.controller.enqueue({...base, allowCreateHome: true});
  let checks = 0; h.beforeIdle(() => {if (++checks === 2) h.addHome(90, 'https://www.douyin.com/jingxuan');});
  assert.equal((await h.controller.reconcile())[0].settled, true); assert.equal(h.created.length, 0);
});

test('a concurrent home creation can only roll back the exact new task-created home', async () => {
  const h = harness(); await h.controller.enqueue({...base, allowCreateHome: true});
  h.afterCreate(() => h.addHome(90, 'https://www.douyin.com/jingxuan'));
  const [result] = await h.controller.reconcile();
  assert.equal(result.reason, 'created_duplicate_closed'); assert.deepEqual(h.removed, [h.created[0].id]);
  assert.equal(h.pages.has(90), true); assert.equal(h.pending().length, 0);
});

test('duplicate-home rollback cannot close a same-URL replacement document', async () => {
  const h = harness(); await h.controller.enqueue({...base, allowCreateHome: true});
  h.afterCreate(() => h.addHome()); let probes = 0;
  h.beforeDocument(tabId => {if (tabId > 1000 && ++probes === 2) h.pages.get(tabId).documentId = 'replacement';});
  await h.controller.reconcile(); assert.deepEqual(h.removed, []); assert.equal(h.pending().length, 1);
});

test('a pending created home survives re-enqueue and worker restart, then redirects and deduplicates', async () => {
  const h = harness();
  await h.controller.enqueue({...base, allowCreateHome: true});
  h.afterCreate(tab => {
    Object.assign(tab, {url: 'about:blank', pendingUrl: homeUrl, status: 'loading', documentId: ''});
    h.addHome(90, 'https://www.douyin.com/jingxuan');
  });
  assert.equal((await h.controller.reconcile())[0].reason, 'home_navigation_pending');
  const recorded = h.pending()[0].createdHome;
  assert.equal(recorded.sourceTabId, h.created[0].id); assert.equal(recorded.creationPending, true);
  await h.controller.enqueue({...base, allowCreateHome: true, creationSessionId: 'other-session'});
  assert.deepEqual(h.pending()[0].createdHome, recorded);
  assert.equal(h.pending()[0].creationSessionId, base.creationSessionId);
  Object.assign(h.pages.get(recorded.sourceTabId), {url: 'https://www.douyin.com/jingxuan',
    pendingUrl: '', status: 'complete', documentId: 'initial-redirect-document'});
  const [result] = await h.create().reconcile();
  assert.equal(result.reason, 'created_duplicate_closed');
  assert.deepEqual(h.removed, [recorded.sourceTabId]); assert.equal(h.created.length, 1);
  assert.equal(h.pages.has(90), true); assert.equal(h.pending().length, 0);
});

test('an initial created-home document probe failure keeps its durable id for a safe retry', async () => {
  for (const failure of ['null', 'throw']) {
    const h = harness(); await h.controller.enqueue({...base, allowCreateHome: true});
    h.afterCreate(() => h.addHome(90, 'https://www.douyin.com/jingxuan'));
    const original = h.deps.getDocumentIdentity;
    h.deps.getDocumentIdentity = async () => {if (failure === 'throw') throw Error('frame not ready'); return null;};
    await h.create().reconcile();
    assert.equal(h.pending()[0].createdHome.sourceTabId, h.created[0].id);
    assert.deepEqual(h.removed, []); assert.equal(h.created.length, 1);
    h.deps.getDocumentIdentity = original;
    assert.equal((await h.create().reconcile())[0].reason, 'created_duplicate_closed');
    assert.deepEqual(h.removed, [h.created[0].id]); assert.equal(h.created.length, 1);
  }
});

test('creation authority survives a worker restart but expires across browser sessions', async () => {
  const worker = harness(); await worker.controller.enqueue({...base, allowCreateHome: true});
  await worker.create().reconcile(); assert.equal(worker.created.length, 1);
  const browser = harness(); await browser.controller.enqueue({...base, allowCreateHome: true});
  browser.session('browser-session-2');
  assert.equal((await browser.create().reconcile())[0].reason, 'home_creation_session_unverified');
  assert.equal(browser.created.length, 0);
  browser.addHome(90, 'https://www.douyin.com/jingxuan');
  assert.equal((await browser.create().reconcile())[0].settled, true);
  const absent = harness(); await absent.controller.enqueue({...base, allowCreateHome: true, creationSessionId: ''});
  await absent.controller.reconcile(); assert.equal(absent.created.length, 0);
  const noVerifier = harness(); delete noVerifier.deps.canCreateHome;
  await noVerifier.controller.enqueue({...base, allowCreateHome: true});
  await noVerifier.create().reconcile(); assert.equal(noVerifier.created.length, 0);
});

test('a task becoming active after persisting create intent defers and safely retries', async () => {
  const h = harness(); await h.controller.enqueue({...base, allowCreateHome: true});
  let paused = false;
  h.beforeIdle(() => {
    if (!paused && h.pending()[0]?.creationRequested) { paused = true; h.idle(false); }
  });
  assert.equal((await h.controller.reconcile())[0].reason, 'capture_active');
  assert.equal(h.created.length, 0); assert.equal(h.pending()[0].creationRequested, false);
  h.idle(true); await h.create().reconcile(); assert.equal(h.created.length, 1);
});

test('pending-created proof cannot be recaptured after a browser restart or explicit revocation', async () => {
  for (const change of ['session', 'revoke', 'legacy']) {
    const h = harness(); await h.controller.enqueue({...base, allowCreateHome: true});
    h.afterCreate(tab => Object.assign(tab, {url: 'about:blank', pendingUrl: homeUrl, status: 'loading', documentId: ''}));
    await h.controller.reconcile(); const ownId = h.created[0].id;
    Object.assign(h.pages.get(ownId), {url: 'https://www.douyin.com/jingxuan', pendingUrl: '', status: 'complete', documentId: 'replacement'});
    h.addHome();
    if (change === 'session') h.session('browser-session-2');
    if (change === 'revoke') await h.controller.revokeSource(ownId);
    if (change === 'legacy') delete Object.values(h.state[h.api.STORAGE_KEY])[0].createdHome.creationPending;
    await h.create().reconcile();
    assert.deepEqual(h.removed, []); assert.equal(h.pending().length, 1); assert.equal(h.created.length, 1);
  }
});

test('an observed created-home navigation away permanently disables delayed proof capture', async () => {
  const h = harness(); await h.controller.enqueue({...base, allowCreateHome: true});
  h.afterCreate(tab => Object.assign(tab, {url: 'https://www.douyin.com/passport/login'}));
  assert.equal((await h.controller.reconcile())[0].reason, 'home_navigated');
  const ownId = h.created[0].id; h.pages.get(ownId).url = homeUrl; h.addHome();
  await h.create().reconcile(); assert.deepEqual(h.removed, []); assert.equal(h.created.length, 1);
});

test('same-task re-enqueue preserves navigation progress and cannot expand creation permission', async () => {
  const h = harness(); const owned = h.addSource(12);
  await h.controller.enqueue({...base, sources: [owned]}); h.fail('update');
  await h.controller.reconcile(); assert.equal(h.pending()[0].sources[0].homeRequested, true);
  await h.controller.enqueue({...base, keywords: [], sources: [owned], allowCreateHome: true});
  assert.equal(h.pending()[0].sources[0].homeRequested, true);
  assert.equal(h.pending()[0].allowCreateHome, false); assert.deepEqual(h.pending()[0].keywords, base.keywords);
  h.fail(''); await h.controller.reconcile(); assert.equal(h.pages.get(12).url, homeUrl);
});

test('settled sources do not block later source obligations in the same task', async () => {
  const h = harness(); h.addHome();
  h.deps.canPark = async entry => entry.sources.every(item => h.pages.has(item.sourceTabId));
  const controller = h.create();
  await controller.enqueue({...base, sources: [h.addSource(12), h.addSource(13)]});
  const [result] = await controller.reconcile();
  assert.equal(result.settled, true); assert.deepEqual(h.removed, [12, 13]);
});

test('closed windows and user tabs in other windows are not recreated or changed', async () => {
  const h = harness(); await h.controller.enqueue({...base, windowId: 2, allowCreateHome: true});
  assert.equal((await h.controller.reconcile())[0].reason, 'window_closed'); assert.equal(h.created.length, 0);
});

test('the actual background home entry accepts warning/partial/error terminals but not active or human action', async () => {
  const enqueued = [];
  const context = vm.createContext({
    console, OnStarvoiceTaskHomeCleanup: {HOMES: {douyin: 'https://www.douyin.com/'}, isPlanSearch: () => false},
    taskHomeCleanup: {enqueue: async value => enqueued.push(value), reconcile: async () => []},
    chrome: {tabs: {get: async () => ({id: 11, windowId: 1})}},
    resolveCaptureTaskTabId: () => null, scheduleTaskBrowserCleanup: async () => {},
    keywordSourceBindings: {get: async () => []}, keywordSourceOwnerForRequest: request => request,
    getTaskHomeCreationSessionId: async () => base.creationSessionId,
    runTaskHomeSidecar: fn => fn(),
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
