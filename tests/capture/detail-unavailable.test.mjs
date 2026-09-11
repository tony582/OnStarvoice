import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {normalizeDetailAvailability, unavailableDetailPayload, unavailableDetailResult, classifyDetailAvailabilitySnapshot, readDetailAvailabilitySnapshot} from '../../utils/capture/detail-availability.js';
import {capturedContentAvailability} from '../../server/services/capture-content-availability.js';
import {runEnhancementWithSingleRetry} from '../../utils/capture/enhancement-retry.js';

const id = '6aa1e9900000000012027610';
const targetUrl = `https://www.xiaohongshu.com/explore/${id}?xsec_token=test-only`;
const qrSnapshot = {url: `https://www.xiaohongshu.com/404?redirectPath=${encodeURIComponent(`/explore/${id}`)}`,
  title: '小红书 - 你访问的页面不见了',
  bodyText: "Sorry, This Page Isn't Available Right Now. 请打开小红书App扫码查看 问题反馈 返回首页"};
const classifierContext = vm.createContext({});
vm.runInContext(await readFile(new URL('../../utils/capture/target-page-availability.js', import.meta.url), 'utf8'), classifierContext);
const classifySnapshot = classifierContext.OnStarvoiceTargetPageAvailability.classifySnapshot;
const classify = (snapshot, options = {}) => classifyDetailAvailabilitySnapshot(snapshot, {targetUrl, classifySnapshot, ...options});

for (const [label, snapshot, status] of [
  ['reported QR page', qrSnapshot, 'page_unavailable'],
  ['visible QR modal', {...qrSnapshot, url: targetUrl, unavailableDialog: true}, 'page_unavailable'],
  ['floating platform notice over feed', {url: 'https://www.xiaohongshu.com/explore', bodyText: '推荐列表'.repeat(1000), notices: ['该内容暂时无法查看']}, 'page_unavailable'],
  ['explicit deletion', {url: targetUrl, bodyText: '该笔记已被作者删除，返回首页'}, 'deleted'],
]) test(`${label} settles as identity-bound unavailable, preserving list evidence`, () => {
  const value = classify(snapshot);
  assert.equal(value.externalId, id);
  assert.equal(value.status, status);
  assert.equal(value.code, 'TARGET_POST_UNAVAILABLE');
  assert.equal('url' in value, false);
  const old = {items: [{noteId: id, title: 'Vo83——你会不会为车联网买单'}], detailCaptureStatus: 'failed', detailCaptureFailureCode: 'NOTE_CAPTURE_FAILED', detailCaptureAutoRetryCount: 2};
  const updated = unavailableDetailPayload(old, value);
  assert.deepEqual(updated.items, old.items);
  assert.equal(updated.detailCaptureFailureCode, '');
  assert.equal(updated.detailCaptureAutoRetryCount, 0);
  assert.equal(capturedContentAvailability({platform: 'xiaohongshu', external_id: id, payload: updated}).status, status);
});

for (const [label, snapshot] of [
  ['quoted body text', {url: targetUrl, bodyText: '该内容暂时无法查看'}],
  ['quoted full error-page copy inside an article', {...qrSnapshot, url: targetUrl, title: '讨论小红书提示语'}],
  ['login', {...qrSnapshot, bodyText: `${qrSnapshot.bodyText} 扫码登录`}],
  ['captcha', {...qrSnapshot, bodyText: `${qrSnapshot.bodyText} 请完成验证`}],
  ['network failure', {...qrSnapshot, bodyText: `${qrSnapshot.bodyText} 网络连接失败`}],
  ['wrong post', {...qrSnapshot, url: 'https://www.xiaohongshu.com/explore/different-post'}],
  ['wrong redirected post', {...qrSnapshot, url: 'https://www.xiaohongshu.com/404?redirectPath=/explore/different-post'}],
  ['foreign host', {...qrSnapshot, url: 'https://xiaohongshu.com.example.org/explore'}],
  ['missing page identity', {...qrSnapshot, url: ''}],
]) test(`${label} must not become a deleted/unavailable record`, () => assert.equal(classify(snapshot), null));

test('temporary unavailable expires, explicit deletion persists, and unsupported evidence is rejected', () => {
  const now = Date.now();
  const value = classify(qrSnapshot, {now});
  assert.equal(normalizeDetailAvailability(value, {externalId: id, now: now + 86400001}), null);
  assert.ok(normalizeDetailAvailability({...value, status: 'deleted', evidence: ['xhs_deleted_copy']}, {externalId: id, now: now + 86400001}));
  for (const patch of [{externalId: 'wrong'}, {platform: 'douyin'}, {evidence: ['NOTE_CAPTURE_FAILED']}, {observedAt: 'invalid'}, {observedAt: new Date(now + 600000).toISOString()}]) {
    assert.equal(normalizeDetailAvailability({...value, ...patch}, {externalId: id, now}), null);
    assert.equal(capturedContentAvailability({platform: 'xiaohongshu', external_id: id, payload: unavailableDetailPayload({}, {...value, ...patch})}, now), null);
  }
});

test('DOM snapshot accepts only a visible platform notice, not article text', () => {
  const box = {width: 260, height: 50, top: 50, bottom: 100};
  const node = {children: [], textContent: '该内容暂时无法查看', getBoundingClientRect: () => box, getAttribute: () => null};
  const context = vm.createContext({document: {body: {innerText: '推荐内容'}, title: '小红书', querySelectorAll: () => [node]},
    location: {href: targetUrl}, innerHeight: 900, getComputedStyle: () => ({position: 'static', visibility: 'visible', opacity: '1'})});
  const read = vm.runInContext(`(${readDetailAvailabilitySnapshot.toString()})`, context);
  assert.equal(read().notices.length, 0);
  context.getComputedStyle = () => ({position: 'fixed', visibility: 'visible', opacity: '1'});
  assert.equal(read().notices.length, 1);
  context.getComputedStyle = () => ({position: 'fixed', visibility: 'hidden', opacity: '1'});
  assert.equal(read().notices.length, 0);
});

function memoryStorage() {
  const values = new Map();
  return {async get(keys) {return Object.fromEntries((keys == null ? [...values.keys()] : Array.isArray(keys) ? keys : [keys]).filter(k => values.has(k)).map(k => [k, structuredClone(values.get(k))]));},
    async set(patch) {Object.entries(patch).forEach(([k,v]) => values.set(k, structuredClone(v)));},
    async remove(keys) {(Array.isArray(keys) ? keys : [keys]).forEach(k => values.delete(k));}};
}

function browserHarness({snapshot = qrSnapshot, navigationError = null} = {}) {
  const source = {id: 41, windowId: 5, index: 3, active: true, status: 'complete', url: 'https://www.xiaohongshu.com/search_result?keyword=test'};
  const workers = new Map();
  const events = [];
  let nextId = 92;
  globalThis.chrome = {
    storage: {local: memoryStorage()},
    runtime: {getURL: path => `chrome-extension://test/${path}`, async sendMessage() {return {ok: true, data: null};}},
    tabs: {async query() {return [source];}, async create(properties) {const tab = {...properties, id: nextId++, windowId: 5, status: 'complete'}; workers.set(tab.id, tab); events.push('create'); return tab;},
      async update(tabId, patch) {const tab = workers.get(tabId) || source; Object.assign(tab, patch); if (patch.url) {events.push('navigate'); if (navigationError) throw navigationError; tab.url = snapshot.url;} return tab;},
      async get(tabId) {return workers.get(tabId) || source;}, async remove(tabId) {assert.notEqual(tabId, source.id); workers.delete(tabId); events.push('remove');}},
    scripting: {async executeScript({func}) {if (func?.name === 'readDetailAvailabilitySnapshot') return [{result: snapshot}]; return [{result: 0}];}},
    windows: {async update() {return {};}}
  };
  return {events, workers};
}

async function newRecord(recordId, payload = {}) {
  const {addRecord} = await import('../../utils/storage.js');
  await addRecord({id: recordId, type: 'keyword_notes', platform: 'xiaohongshu', payload: {items: [{noteId: id, title: 'Vo83——你会不会为车联网买单', url: targetUrl}], ...payload}});
}

test('real batch: unavailable navigation is settled once, list data survives sync, next run opens no worker', async () => {
  const {events, workers} = browserHarness();
  const {batchCaptureDetailsForRecords} = await import('../../utils/capture-sync.js');
  const {getRecord} = await import('../../utils/storage.js');
  const {buildSyncInput} = await import('../../utils/platform/sync-router.js');
  await newRecord('deleted-first');
  let calls = 0;
  const outcome = await runEnhancementWithSingleRetry({recordIds: ['deleted-first'], runAttempt: async ids => {
    calls++; return batchCaptureDetailsForRecords(ids, {skipAlreadyCaptured: false, detailAfterNavWaitMs: 1});
  }});
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.failedCount, 0);
  assert.equal(calls, 1);
  assert.equal(outcome.results[0].reason, 'post_unavailable');
  assert.equal(outcome.results[0].skipped, true);
  assert.equal(workers.size, 0);
  const record = await getRecord('deleted-first');
  assert.equal(record.payload.items[0].title, 'Vo83——你会不会为车联网买单');
  assert.equal(record.payload.detailCaptureStatus, 'unavailable');
  assert.equal(buildSyncInput(record).payload.detailAvailability.externalId, id);
  await newRecord('deleted-next-run');
  const before = events.length;
  const next = await batchCaptureDetailsForRecords(['deleted-next-run']);
  assert.equal(next.ok, true);
  assert.equal(next.results[0].reason, 'post_unavailable');
  assert.equal(next.skippedCount, 1);
  assert.equal(events.length, before, 'local cross-run skip does not create/navigate tabs');
  // Explicit manual capture can recheck the same post despite its saved marker.
  await batchCaptureDetailsForRecords(['deleted-next-run'], {skipAlreadyCaptured: false});
  assert.ok(events.length > before);
});

test('real batch: stale cached unavailable outcome cannot turn an actual navigation failure into success', async () => {
  browserHarness({snapshot: {url: targetUrl, title: '网络异常', bodyText: '网络连接失败'}, navigationError: new Error('打开页面失败')});
  const {batchCaptureDetailsForRecords} = await import('../../utils/capture-sync.js');
  await newRecord('real-failure', {detailCaptureStatus: 'unavailable', detailAvailability: classify(qrSnapshot)});
  const result = await batchCaptureDetailsForRecords(['real-failure'], {skipAlreadyCaptured: false});
  assert.equal(result.ok, false);
  assert.equal(result.failedCount, 1);
  assert.notEqual(result.results[0].reason, 'post_unavailable');
});

test('mixed enhancement only retries the actual transient failure', async () => {
  const skipped = unavailableDetailResult('unavailable', classify(qrSnapshot));
  const calls = [];
  const result = await runEnhancementWithSingleRetry({recordIds: ['unavailable', 'network'],
    waitBeforeRetry: async () => {}, runAttempt: async ids => {
      calls.push(ids);
      const results = calls.length === 1 ? [skipped, {recordId: 'network', ok: false, reason: 'PAGE_OPEN_TIMEOUT', category: 'page_failed'}] : [{recordId: 'network', ok: true}];
      return {ok: calls.length > 1, results, total: ids.length, processedCount: ids.length, failedCount: calls.length === 1 ? 1 : 0, skippedCount: calls.length === 1 ? 1 : 0, successCount: calls.length === 1 ? 0 : 1};
    }});
  assert.deepEqual(calls, [['unavailable', 'network'], ['network']]);
  assert.equal(result.ok, true);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.failedCount, 0);
});

test('real next-device batch reads the server outcome and skips before opening any worker', async t => {
  const {events} = browserHarness();
  const originalFetch = globalThis.fetch;
  t.after(() => {globalThis.fetch = originalFetch;});
  const {setAuth, getRecord} = await import('../../utils/storage.js');
  const {batchCaptureDetailsForRecords} = await import('../../utils/capture-sync.js');
  await setAuth({code: 'unavailable-test-auth'});
  const requests = [];
  const observation = classify(qrSnapshot);
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/sync/captured');
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ok: true, captured: [], items: [], unavailable: [observation]}), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  await newRecord('second-device-record');
  const result = await batchCaptureDetailsForRecords(['second-device-record']);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.results[0].reason, 'post_unavailable');
  assert.equal(result.skippedCount, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].externalIds, [id]);
  assert.deepEqual(events, [], 'server availability prevents navigation on a fresh device');
  assert.equal((await getRecord('second-device-record')).payload.detailAvailability.externalId, id);
});

test('real batch keeps cancellation and platform safety ahead of unavailable settlement', async () => {
  const {batchCaptureDetailsForRecords} = await import('../../utils/capture-sync.js');
  for (const code of ['DETAIL_CAPTURE_CANCELED', 'XHS_SECURITY_BLOCK']) {
    browserHarness({navigationError: Object.assign(new Error(code), {code})});
    await newRecord(`protected-${code}`);
    const result = await batchCaptureDetailsForRecords([`protected-${code}`], {skipAlreadyCaptured: false});
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.results.some(item => item.unavailable), false);
    if (code === 'DETAIL_CAPTURE_CANCELED') assert.equal(result.canceled, true);
    else assert.equal(result.securityBlocked, true);
  }
});


test('newer full capture clears a stale unavailable marker during preflight', async t => {
  const {events} = browserHarness();
  const originalFetch = globalThis.fetch;
  t.after(() => {globalThis.fetch = originalFetch;});
  const {setAuth, getRecord} = await import('../../utils/storage.js');
  const {batchCaptureDetailsForRecords} = await import('../../utils/capture-sync.js');
  await setAuth({code: 'unavailable-test-auth'});
  const observation = classify(qrSnapshot, {now: Date.now() - 10000});
  globalThis.fetch = async () => new Response(JSON.stringify({ok: true, captured: [id], unavailable: [], items: [{externalId: id, capturedAt: Date.now()}]}), {status: 200});
  await newRecord('recovered-on-another-device', unavailableDetailPayload({}, observation));
  const result = await batchCaptureDetailsForRecords(['recovered-on-another-device']);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].reason, 'already_captured');
  assert.equal((await getRecord('recovered-on-another-device')).payload.detailAvailability, null);
  assert.deepEqual(events, []);
});
