import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = background.indexOf(start), b = background.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `${start} -> ${end}`);
  return background.slice(a, b);
}
const functions = [
  section('async function runTaskHomeSidecar(', 'async function bindKeywordSource('),
  section('async function captureManagedTaskWindow(', 'const taskHomeCleanup ='),
  section('async function openOwnedTargetedPostPlatformTab(', 'async function closeTerminalTargetedPostPlatformTab('),
].join('\n');
function harness({read = 'ok', begin = 'ok'} = {}) {
  const request = {id: 'request', attemptId: 'attempt', cloudCommandId: 'command', workflow: 'discovered_post_capture',
    status: 'running', platform: 'douyin', runnerTabId: 10,
    targets: [{platform: 'douyin', externalId: '123', url: 'https://www.douyin.com/note/123'}]};
  const state = {reads: 0, begins: [], navigated: [], removed: [], timeouts: [], errors: [], releaseRead: null, releaseBegin: null};
  const ctx = vm.createContext({console: {warn: (...args) => state.errors.push(args)},
    setTimeout: (fn, ms) => {state.timeouts.push(ms); return setTimeout(fn, Math.min(ms, 5));}, clearTimeout,
    STORAGE_KEYS: {targetedPostPlatformTab: 'registration'},
    OnStarvoiceTaskHomeCleanup: {HOMES: {douyin: 'https://www.douyin.com/', xiaohongshu: 'https://www.xiaohongshu.com/explore', weibo: 'https://weibo.com/'}},
    readTargetedPostRunRequest: async () => {
      if (++state.reads === 1) return request;
      if (read === 'reject') throw Error('optional storage read failed');
      if (read === 'hang') return new Promise(resolve => {state.releaseRead = resolve;});
      if (read === 'superseded') return {...request, attemptId: 'new-attempt'};
      return request;
    },
    taskWindowSources: {begin: async owner => {
      state.begins.push({...owner});
      if (begin === 'reject') throw Error('optional inventory failed');
      if (begin === 'hang') return new Promise(resolve => {state.releaseBegin = resolve;});
      return {known: true, sources: []};
    }},
    cloudTargetedPostApi: {usesOwnedPlatformTab: () => true, isTerminalRunStatus: status => status === 'completed'},
    isSameTargetedPostAttempt: (a, b) => a?.id === b?.id && a?.attemptId === b?.attemptId,
    recoverNegativePatrolTerminalOutboxCleanup: async () => {},
    recoverTargetedPostPlatformTabCleanup: async () => ({ok: true}),
    readTargetedPostPlatformTabCleanup: async () => null,
    normalizeTargetedPostPlatformTab: () => null,
    runAuthoritativeControlStorageMutation: operation => operation(),
    targetedPostLogicalRequestId: value => value.id, createUuid: () => 'session',
    chrome: {storage: {local: {get: async () => ({}), set: async () => {}}}, tabs: {
      create: async patch => ({...patch, id: 20, windowId: 7}),
      update: async (id, patch) => {state.navigated.push({id, ...patch});},
      remove: async id => state.removed.push(id),
    }},
  });
  vm.runInContext(functions, ctx);
  return {ctx, request, state, open: () => ctx.openOwnedTargetedPostPlatformTab({
    requestId: request.id, attemptId: request.attemptId, url: request.targets[0].url,
  })};
}

for (const failure of [{read: 'reject'}, {read: 'hang'}, {begin: 'reject'}, {begin: 'hang'}]) {
  test(`optional window inventory ${JSON.stringify(failure)} cannot prevent the real owned-tab navigation`, {timeout: 1000}, async () => {
    const h = harness(failure), result = await h.open();
    assert.equal(result.ok, true);
    assert.deepEqual(h.state.navigated, [{id: 20, url: h.request.targets[0].url, active: true}]);
    assert.deepEqual(h.state.removed, []);
    assert.ok(h.state.timeouts.includes(1500));
    assert.equal(h.state.begins.length, failure.begin ? 1 : 0);
    if (failure.read === 'hang') {
      h.state.releaseRead(h.request);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.state.begins.length, 0, 'a canceled late validation cannot begin a snapshot');
    }
    h.state.releaseBegin?.({known: true, sources: []});
  });
}

test('a superseded optional validation cannot register the old task window', async () => {
  const h = harness({read: 'superseded'});
  await h.open();
  assert.equal(h.state.begins.length, 0);
});

test('the existing keyword sidecar control also contains validation exceptions', async () => {
  const h = harness();
  h.ctx.readTargetedPostRunRequest = async () => {throw Error('optional read failed');};
  await assert.doesNotReject(h.ctx.captureManagedTaskWindow(h.request, {windowId: 7, id: 20}, {isCanceled: () => false}));
  assert.equal(h.state.begins.length, 0);
});

test('the real owned-tab opener uses the actual task window and excludes only its two task-owned pages', async () => {
  const h = harness();
  assert.equal((await h.open()).ok, true);
  assert.equal(h.state.begins[0].windowId, 7);
  assert.equal(h.state.begins[0].platform, 'douyin');
  assert.deepEqual(Array.from(h.state.begins[0].excludeTabIds), [10, 20]);
});


test('a real multi-platform owned-tab open snapshots every target platform in its actual window', async () => {
  const h = harness();
  h.request.platform = 'multi';
  h.request.targets.push({platform: 'xiaohongshu', externalId: 'abc', url: 'https://www.xiaohongshu.com/explore/abc'});
  assert.equal((await h.open()).ok, true);
  assert.deepEqual(h.state.begins.map(owner => owner.platform), ['douyin', 'xiaohongshu']);
  assert.ok(h.state.begins.every(owner => owner.windowId === 7 && owner.identity === 'request:attempt'));
  assert.deepEqual(h.state.errors, []);
});
