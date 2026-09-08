import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../utils/capture-sync.js', import.meta.url), 'utf8');

function functionSource(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing function slice: ${startMarker}`);
  return source.slice(start, end);
}

const runtimeSource = [
  functionSource('async function runBatchSingleNoteEnhancements(', 'async function classifyTargetPageAvailabilityInTab'),
  functionSource('async function captureBloggerMetricsForSingleNoteRecord(', 'async function captureDouyinBloggerMetricsFromNoteDetail'),
  functionSource('async function openUrlInTab(', 'async function probeDetailPreloadSafety'),
].join('\n');

function createRuntime({platform = 'xiaohongshu', closedRunner = false, neverLoads = false} = {}) {
  const noteUrl = platform === 'douyin'
    ? 'https://www.douyin.com/video/123'
    : 'https://www.xiaohongshu.com/explore/123';
  const profileUrl = platform === 'douyin' ? '' : 'https://www.xiaohongshu.com/user/profile/456';
  const tabs = new Map([
    [7, {id: 7, url: 'https://example.org/customer-work', status: 'complete'}],
    [88, {id: 88, url: noteUrl, status: 'complete'}],
  ]);
  const observed = {activeTabReads: 0, navigations: [], captures: [], profileWaits: [], commentTabs: [], updates: []};
  let now = 0;
  const context = vm.createContext({
    DETAIL_CAPTURE_NAV_TIMEOUT_MS: 90000,
    PROFILE_AFTER_NAV_WAIT_MS: 3500,
    DETAIL_CAPTURE_NAV_POLL_MS: 250,
    DOUYIN_DETAIL_ROUTE_SETTLE_MS: 500,
    Date: {now: () => now},
    console: {warn() {}},
    SYNC_TYPE: {SINGLE_NOTE: 'single'},
    RECORD_STATUS: {DRAFT: 'draft'},
    BLOGGER_METRICS_CAPTURE_STATUS: {FAILED: 'failed'},
    getRecord: async () => ({type: 'single', payload: {url: noteUrl, authorUrl: profileUrl}}),
    ensureBloggerMetricsFields: (payload) => payload,
    resolveRecordNoteUrl: () => noteUrl,
    normalizeOpenUrl: (url) => url,
    detectPlatformFromUrl: () => platform,
    resolveBloggerMetricsPatchFromCurrentPayload: () => null,
    resolveBloggerProfileUrlFromPayload: () => profileUrl,
    applyBloggerMetricsPatch: (payload, patch) => ({...payload, ...patch}),
    createBloggerMetricsPatch: (patch) => patch,
    resolveBloggerMetricsFromProfilePayload: (data) => data,
    updateRecord: async (_id, update) => observed.updates.push(update),
    getCurrentActiveTab: async () => {
      observed.activeTabReads += 1;
      return {...tabs.get(7)};
    },
    chrome: {tabs: {
      get: async (id) => {
        if (closedRunner && id === 88) throw new Error('No tab with id: 88');
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        const current = {...tab};
        if (!neverLoads) tab.status = 'complete';
        return current;
      },
      update: async (id, update) => {
        observed.navigations.push({id, ...update});
        tabs.set(id, {...tabs.get(id), ...update, status: 'loading'});
      },
    }},
    ensureXhsNoteUrlSource: (url) => url,
    extractNoteId: (url) => /(?:explore|video)\/(\d+)/.exec(url)?.[1] || '',
    isDouyinContentFlowUrl: (url) => String(url).includes('douyin.com/video/'),
    isTargetNoteOpened: (current, target) => current === target,
    waitMs: async (ms) => { now += ms; },
    waitMsWithStop: async (ms) => {
      observed.profileWaits.push(ms);
      now += ms;
    },
    captureInTab: async (id, options) => {
      observed.captures.push({id, mode: options.mode});
      return {ok: true, data: {fansCount: 123, likesCount: 456}};
    },
    captureDouyinBloggerMetricsFromNoteDetail: async ({tabId}) => {
      observed.captures.push({id: tabId, mode: 'douyin_works'});
      return {ok: true, patch: {fansCount: 123, likesCount: 456}};
    },
    captureCommentsForSingleNoteRecord: async (_id, {runnerTabId}) => {
      observed.commentTabs.push(runnerTabId);
      return {ok: true};
    },
  });
  vm.runInContext(runtimeSource, context);
  return {
    observed,
    tabs,
    run: (options = {}) => context.runBatchSingleNoteEnhancements('record', {
      includeBloggerMetrics: true,
      ...options,
    }),
  };
}

for (const timeout of [undefined, null, 12000]) {
  test(`batch blogger capture really navigates, captures and restores with ${timeout} timeout`, async () => {
    const runtime = createRuntime();
    const result = await runtime.run({
      runnerTabId: 88,
      detailNavTimeoutMs: timeout,
      profileAfterNavWaitMs: timeout,
    });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.bloggerMetricsResult.ok, true);
    assert.deepEqual(runtime.observed.captures, [{id: 88, mode: 'blogger_profile'}]);
    assert.deepEqual(runtime.observed.profileWaits, [timeout ?? 3500]);
    assert.deepEqual(runtime.observed.navigations.map(({id, url}) => ({id, url})), [
      {id: 88, url: 'https://www.xiaohongshu.com/user/profile/456'},
      {id: 88, url: 'https://www.xiaohongshu.com/explore/123'},
    ]);
    assert.equal(runtime.observed.activeTabReads, 0);
    assert.equal(runtime.tabs.get(7).url, 'https://example.org/customer-work');
  });
}

test('ordinary capture without an explicit runner retains its active-tab fallback', async () => {
  const runtime = createRuntime();
  const result = await runtime.run();
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(runtime.observed.activeTabReads, 1);
  assert.deepEqual(runtime.observed.captures, [{id: 7, mode: 'blogger_profile'}]);
  assert.ok(runtime.observed.navigations.every(({id}) => id === 7));
});

test('blogger and comments use the same dedicated runner after the active tab changes', async () => {
  const runtime = createRuntime();
  const result = await runtime.run({runnerTabId: 88, includeComments: true});
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(runtime.observed.captures, [{id: 88, mode: 'blogger_profile'}]);
  assert.deepEqual(runtime.observed.commentTabs, [88]);
  assert.equal(runtime.observed.activeTabReads, 0);
});

test('a closed dedicated runner fails without navigating an unrelated active tab', async () => {
  const runtime = createRuntime({closedRunner: true});
  const result = await runtime.run({runnerTabId: 88});
  assert.equal(result.ok, false);
  assert.match(result.error.message, /No tab with id: 88/);
  assert.equal(runtime.observed.activeTabReads, 0);
  assert.deepEqual(runtime.observed.navigations, []);
  assert.deepEqual(runtime.observed.captures, []);
});

test('a genuinely stalled page still times out instead of reporting successful blogger capture', async () => {
  const runtime = createRuntime({neverLoads: true});
  const result = await runtime.run({runnerTabId: 88, detailNavTimeoutMs: 500});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BLOGGER_METRICS_CAPTURE_FAILED');
  assert.match(result.error.message, /打开页面超时/);
  assert.deepEqual(runtime.observed.captures, []);
});

test('cancellation prevents profile navigation and comments from starting', async () => {
  const runtime = createRuntime();
  const result = await runtime.run({runnerTabId: 88, includeComments: true, shouldStop: () => true});
  assert.equal(result.canceled, true);
  assert.equal(runtime.observed.activeTabReads, 0);
  assert.deepEqual(runtime.observed.navigations, []);
  assert.deepEqual(runtime.observed.commentTabs, []);
});

test('Douyin blogger metrics also stay on the explicitly assigned runner', async () => {
  const runtime = createRuntime({platform: 'douyin'});
  const result = await runtime.run({runnerTabId: 88});
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(runtime.observed.captures, [{id: 88, mode: 'douyin_works'}]);
  assert.equal(runtime.observed.activeTabReads, 0);
});

test('an explicitly disabled profile settling delay remains zero', async () => {
  const runtime = createRuntime();
  const result = await runtime.run({runnerTabId: 88, profileAfterNavWaitMs: 0});
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(runtime.observed.profileWaits, [0]);
});
