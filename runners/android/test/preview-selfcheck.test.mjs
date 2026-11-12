import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createSharePreview} from '../src/preview/share-preview.mjs';
import {chromeInstallRoot, chromeInstallPaths} from '../src/preview/chrome-cache.mjs';
import {visitLocalPreviewPage} from '../src/preview/local-selfcheck.mjs';
import {combineRunnerDevices} from '../src/daemon/multi-device.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';

function fixture(t, {holdSelfcheck = false, holdDevtools = false, explicit = false, closeHangs = false,
  badBody = false, failedNavigation = false, disconnectSelfcheck = false, systemAvailable = true, timeoutMs = 60} = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'preview-selfcheck-'));
  const paths = chromeInstallPaths(chromeInstallRoot(homeDir), '157.0.8103.78', 'mac-arm64');
  mkdirSync(dirname(paths.executable), {recursive: true});
  const bytes = 'fixture only, never executed';
  writeFileSync(paths.executable, bytes, {mode: 0o700});
  writeFileSync(paths.receipt, JSON.stringify({schemaVersion: 1, verified: true, version: '157.0.8103.78',
    platform: 'mac-arm64', executableSha256: createHash('sha256').update(bytes).digest('hex')}));
  writeFileSync(paths.current, JSON.stringify({version: '157.0.8103.78', platform: 'mac-arm64'}));
  const systemChrome = join(homeDir, 'system-chrome');
  if (systemAvailable) writeFileSync(systemChrome, bytes, {mode: 0o700});
  const spawns = [], calls = [], urls = [], diagnostics = [], warnings = [], targets = new Map(), sessions = new Map();
  let targetSeq = 0;
  class FakeSocket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    addEventListener(name, listener, options) { options?.once ? this.once(name, listener) : this.on(name, listener); }
    close() { this.closed = true; this.emit('close'); }
    send(raw) {
      const request = JSON.parse(raw); calls.push(request);
      const {id, method, params, sessionId} = request;
      const emit = value => { if (!this.closed) this.emit('message', {data: JSON.stringify(value)}); };
      const respond = async () => {
        if (this.closed) return;
        let result = {};
        if (method === 'Target.createTarget') { const targetId = `target-${++targetSeq}`; targets.set(targetId, {}); result = {targetId}; }
        if (method === 'Target.attachToTarget') { sessions.set(`session-${params.targetId}`, params.targetId); result = {sessionId: `session-${params.targetId}`}; }
        if (method === 'Target.closeTarget') { targets.delete(params.targetId); result = {success: true}; }
        if (method === 'Page.navigate') {
          const target = targets.get(sessions.get(sessionId)); target.url = params.url;
          if (params.url.startsWith('http://127.0.0.1:')) {
            urls.push(params.url);
            if (disconnectSelfcheck) { this.close(); return; }
            if (holdSelfcheck) return;
            if (failedNavigation) { emit({id, result: {errorText: 'net::ERR_FAILED'}}); return; }
            const response = await fetch(params.url);
            target.html = await response.text(); target.contentType = response.headers.get('content-type');
            target.marker = target.html.match(/<body>([^<]+)<\/body>/u)?.[1];
          }
        }
        if (method === 'Runtime.evaluate') {
          const target = targets.get(sessions.get(sessionId));
          result = {result: {value: {url: target.url, readyState: 'complete', text: badBody ? 'wrong page' : target.marker}}};
        }
        if (method === 'Network.getResponseBody') result = {body: JSON.stringify({errCode: 0,
          data: {feedInfo: {description: 'real resolver fixture', createtime: 1794000000}, authorInfo: {nickname: 'fixture account'}}})};
        emit({id, result});
        if (method === 'Page.navigate') {
          if (params.url.startsWith('http://127.0.0.1:')) emit({sessionId, method: 'Page.loadEventFired', params: {}});
          else {
            emit({sessionId, method: 'Network.responseReceived', params: {requestId: 'feed', response: {url: 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info'}}});
            emit({sessionId, method: 'Network.loadingFinished', params: {requestId: 'feed'}});
          }
        }
      };
      queueMicrotask(() => { respond().catch(error => emit({id, error: {message: error.message}})); });
    }
  }
  const preview = createSharePreview({profileDir: join(homeDir, 'private-profile'),
    chromePath: explicit ? paths.executable : undefined, chromeExplicit: explicit, selfcheckTimeoutMs: timeoutMs,
    browserOptions: {homeDir, platform: 'darwin', arch: 'arm64', systemChrome},
    onDiagnostic: entry => diagnostics.push(entry), onWarning: line => warnings.push(line),
    fetchImpl: async () => holdDevtools ? new Promise(() => {}) : {json: async () => ({webSocketDebuggerUrl: 'ws://127.0.0.1:9333/fake'})},
    WebSocketImpl: FakeSocket,
    spawnImpl: (path, args) => {
      const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = signal => { child.kills = [...child.kills ?? [], signal]; if (!closeHangs) { child.exitCode = 0; child.emit('exit', 0, null); } };
      spawns.push({path, args, child}); return child;
    }});
  t.after(() => { preview.close(); rmSync(homeDir, {recursive: true, force: true}); });
  return {preview, spawns, calls, urls, diagnostics, warnings, targets, paths, systemChrome};
}

test('local selfcheck binds only loopback, serves one nonce page and closes the HTTP listener', async () => {
  let url;
  await visitLocalPreviewPage(async (value, marker) => {
    url = value; const address = new URL(url);
    assert.equal(address.hostname, '127.0.0.1'); assert.equal(address.protocol, 'http:');
    const response = await fetch(url); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
    assert.match(await response.text(), new RegExp(`<body>${marker}</body>`, 'u'));
    assert.equal((await fetch(new URL('/other', url))).status, 404);
    assert.equal((await fetch(url, {method: 'POST'})).status, 404);
  }, {signal: AbortSignal.timeout(1000)});
  await assert.rejects(fetch(url));
});

test('managed preview checks once at startup, concurrent content waits, and selfcheck leaves no tab/server', async t => {
  const f = fixture(t, {timeoutMs: 1000});
  assert.equal(f.preview.available(), false); assert.equal(f.preview.status().reason, 'preview_warming');
  f.preview.start();
  const [one, two] = await Promise.all([f.preview.resolve('https://weixin.qq.com/sph/FixtureA'), f.preview.resolve('https://weixin.qq.com/sph/FixtureB')]);
  assert.equal(one.nickname, 'fixture account'); assert.equal(two.nickname, 'fixture account');
  await f.preview.prepare();
  assert.equal(f.urls.length, 1); assert.equal(f.spawns.length, 1); assert.equal(f.preview.available(), true);
  assert.equal(f.targets.size, 0); assert.deepEqual(f.diagnostics, []); assert.deepEqual(f.warnings, []);
  await assert.rejects(fetch(f.urls[0]));
  const navs = f.calls.filter(call => call.method === 'Page.navigate').map(call => call.params.url);
  assert.match(navs[0], /^http:\/\/127\.0\.0\.1:\d+\/preview-selfcheck\//u);
  assert.equal(navs.length, 3); assert.equal(navs.some(url => url.startsWith('data:')), false);
});

test('navigation timeout closes failed managed browser before system fallback, warns and diagnoses once', async t => {
  const f = fixture(t, {holdSelfcheck: true});
  const result = await f.preview.resolve('https://weixin.qq.com/sph/FixtureA');
  assert.equal(result.nickname, 'fixture account');
  await f.preview.prepare(); await f.preview.resolve('https://weixin.qq.com/sph/FixtureB');
  assert.deepEqual(f.spawns.map(item => item.path), [f.paths.executable, f.systemChrome]);
  assert.deepEqual(f.spawns[0].child.kills, ['SIGTERM']);
  assert.equal(f.urls.length, 1); assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /暂用系统 Chrome/u);
  assert.equal(f.diagnostics.length, 1); assert.equal(f.diagnostics[0].event, 'preview_browser_selfcheck_failed');
  assert.equal(f.diagnostics[0].code, 'preview_selfcheck_timeout'); assert.equal(f.diagnostics[0].fallback, true);
  await assert.rejects(fetch(f.urls[0]));
});

test('explicit browser path still selfchecks but failure never selects a system browser', async t => {
  const f = fixture(t, {explicit: true, holdSelfcheck: true});
  await assert.rejects(f.preview.prepare(), {code: 'preview_browser_selfcheck_failed'});
  await assert.rejects(f.preview.resolve('https://weixin.qq.com/sph/FixtureA'), {code: 'preview_browser_selfcheck_failed'});
  assert.deepEqual(f.spawns.map(item => item.path), [f.paths.executable]);
  assert.equal(f.diagnostics.length, 1); assert.equal(f.diagnostics[0].explicit, true); assert.equal(f.diagnostics[0].fallback, false);
  assert.equal(f.warnings.length, 0); assert.equal(f.preview.available(), false);
  assert.deepEqual(f.spawns[0].child.kills, ['SIGTERM']); await assert.rejects(fetch(f.urls[0]));
});

test('the selfcheck deadline also covers stalled DevTools startup and cleanup', async t => {
  const f = fixture(t, {holdDevtools: true});
  const start = performance.now(); await f.preview.prepare(); const elapsed = performance.now() - start;
  assert.ok(elapsed < 500, `selfcheck unexpectedly waited ${elapsed} ms`);
  assert.equal(f.diagnostics[0].code, 'preview_selfcheck_timeout');
  assert.deepEqual(f.spawns[0].child.kills, ['SIGTERM']); assert.equal(f.preview.available(), true);
});

test('a missing system fallback or an unclosed owned browser leaves preview unavailable', async t => {
  for (const options of [{systemAvailable: false}, {closeHangs: true}]) {
    const f = fixture(t, {...options, holdSelfcheck: true});
    await assert.rejects(f.preview.prepare(), {code: 'preview_browser_selfcheck_failed'});
    assert.equal(f.preview.available(), false); assert.equal(f.spawns.length, 1);
    assert.equal(f.warnings.length, 0); assert.equal(f.diagnostics.length, 1);
    assert.equal(f.diagnostics[0].fallback, false); await assert.rejects(fetch(f.urls[0]));
  }
});

test('socket reset retains browser ownership until actual exit and cannot race fallback against a live child', async t => {
  const f = fixture(t, {disconnectSelfcheck: true, closeHangs: true, timeoutMs: 1000});
  await assert.rejects(f.preview.prepare(), {code: 'preview_browser_selfcheck_failed'});
  assert.equal(f.spawns.length, 1); assert.equal(f.preview.available(), false); assert.equal(f.warnings.length, 0);
  assert.equal(f.diagnostics[0].browserStopped, false); assert.equal(f.diagnostics[0].fallback, false);
  const killsBeforeClose = f.spawns[0].child.kills.length;
  f.preview.close(); assert.ok(f.spawns[0].child.kills.length > killsBeforeClose, 'shutdown retains the unexited child');
  await assert.rejects(fetch(f.urls[0]));
});

test('canceling one waiter does not cancel the shared startup check or a second platform waiter', async t => {
  const f = fixture(t, {holdSelfcheck: true}); const canceled = new AbortController();
  const first = f.preview.prepare({signal: canceled.signal}); const second = f.preview.prepare();
  canceled.abort(); await assert.rejects(first, {code: 'aborted'}); await second;
  assert.equal(f.urls.length, 1); assert.equal(f.diagnostics.length, 1); assert.equal(f.warnings.length, 1);
  assert.equal(f.preview.available(), true);
});

test('an already canceled caller never starts the browser or selfcheck HTTP server', async t => {
  const f = fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.preview.prepare({signal: controller.signal}), {code: 'aborted'});
  assert.equal(f.spawns.length, 0); assert.equal(f.urls.length, 0);
});

test('a tampered explicit managed path cannot silently become the system fallback', async t => {
  const homeDir = mkdtempSync(join(tmpdir(), 'explicit-invalid-preview-'));
  t.after(() => rmSync(homeDir, {recursive: true, force: true}));
  const paths = chromeInstallPaths(chromeInstallRoot(homeDir), '157.0.8103.78', 'mac-arm64');
  mkdirSync(dirname(paths.executable), {recursive: true});
  writeFileSync(paths.executable, 'invalid fixture', {mode: 0o700});
  const warnings = [], diagnostics = [];
  const preview = createSharePreview({chromePath: paths.executable, chromeExplicit: true,
    profileDir: join(homeDir, 'private'), browserOptions: {homeDir, platform: 'darwin', arch: 'arm64',
      systemChrome: process.execPath, onWarning: message => warnings.push(message)},
    onDiagnostic: entry => diagnostics.push(entry), spawnImpl: () => assert.fail('invalid explicit path must not spawn')});
  t.after(() => preview.close());
  await assert.rejects(preview.prepare(), {code: 'preview_browser_selfcheck_failed'});
  assert.equal(warnings.length, 0); assert.equal(diagnostics[0].code, 'preview_explicit_unavailable');
  assert.equal(diagnostics[0].fallback, false);
});

test('local HTTP selfcheck closes its listener when canceled while the visitor is stalled', async () => {
  const controller = new AbortController(); let url;
  const operation = visitLocalPreviewPage(async value => {
    url = value; assert.equal((await fetch(url)).status, 200); controller.abort(new Error('fixture cancel'));
    return new Promise(() => {});
  }, {signal: controller.signal});
  await assert.rejects(operation, /fixture cancel/u); await assert.rejects(fetch(url));
  const before = new AbortController(); before.abort(new Error('already canceled'));
  await assert.rejects(visitLocalPreviewPage(() => assert.fail('must not visit'), {signal: before.signal}), /already canceled/u);
});

test('wrong selfcheck document and navigation error are refused and recorded', async t => {
  for (const options of [{badBody: true}, {failedNavigation: true}]) {
    const f = fixture(t, {...options, timeoutMs: 1000}); await f.preview.prepare();
    assert.equal(f.diagnostics.length, 1); assert.equal(f.diagnostics[0].fallback, true);
    assert.equal(f.spawns.length, 1); assert.equal(f.preview.available(), true); await assert.rejects(fetch(f.urls[0]));
  }
});

test('closing while checking cancels startup, cleans local listener and never warns or falls back', async t => {
  const f = fixture(t, {holdSelfcheck: true, timeoutMs: 1000});
  const preparing = f.preview.prepare();
  preparing.catch(() => {});
  for (let i = 0; i < 500 && !f.urls.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.urls.length, 1, 'selfcheck navigation must begin before cancellation');
  f.preview.close();
  await assert.rejects(preparing, {code: 'aborted'});
  assert.equal(f.preview.available(), false); assert.equal(f.spawns.length, 1);
  assert.equal(f.diagnostics.length, 0); assert.equal(f.warnings.length, 0); await assert.rejects(fetch(f.urls[0]));
});

test('public entry points still reject loopback/arbitrary URLs before any browser starts', async t => {
  const f = fixture(t);
  await assert.rejects(f.preview.resolve('http://127.0.0.1:1234/preview-selfcheck/x'), {code: 'share_link_invalid'});
  await assert.rejects(f.preview.resolveArticle('https://example.com/article'), {code: 'article_link_invalid'});
  assert.equal(f.spawns.length, 0); assert.equal(f.urls.length, 0);
});

test('pending preview gates both WeChat platforms while Douyin can still probe and prepare a task', async () => {
  const store = new RunnerStore(':memory:'); let prepared = false, release, started = 0;
  const flight = new Promise(resolve => { release = () => { prepared = true; resolve(); }; });
  const preview = {start() { started++; }, prepare: () => flight, available: () => prepared,
    status: () => ({readyForSearch: false, reason: 'preview_warming'}), close() {}};
  const adapter = {probe: async () => ({readyForSearch: true, reason: null})};
  const ocr = {lastSuccessAt: Date.now(), pending: 0, recognize: async () => ({rows: []}), close() {}};
  const device = combineRunnerDevices({douyin: adapter, wechat: adapter, articles: adapter, preview, ocr, store});
  try {
    assert.equal(started, 1); assert.deepEqual((await device.probe()).platforms, ['douyin']);
    await device.prepareTask({platform: 'douyin'});
    let ready = false; const waiting = device.prepareTask({platform: 'wechat_articles'}).then(() => { ready = true; });
    await Promise.resolve(); assert.equal(ready, false);
    release(); await waiting;
    assert.deepEqual((await device.probe()).platforms, ['douyin', 'wechat_channels', 'wechat_articles']);
  } finally { device.shutdown(); store.close(); }
});
