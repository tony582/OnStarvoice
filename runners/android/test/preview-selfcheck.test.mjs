import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createSharePreview} from '../src/preview/share-preview.mjs';
import {chromeInstallRoot, chromeInstallPaths} from '../src/preview/chrome-cache.mjs';
import {combineRunnerDevices} from '../src/daemon/multi-device.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';

const VERSION = '157.0.8103.78';
const CHANNEL = 'https://weixin.qq.com/sph/FixtureA';
const CHANNEL_B = 'https://weixin.qq.com/sph/FixtureB';
const CHANNEL_C = 'https://weixin.qq.com/sph/FixtureC';
const ARTICLE = 'https://mp.weixin.qq.com/s/ArticleFixture123';
const TIMEOUT = 15_000;

function fixture(t, {navigation = () => 'ok', holdDevtools = false, explicit = false, closeHangs = false,
  systemAvailable = true, launchDelayMs = 0, devtoolsUnavailableMs = 0, holdSocket = false, maxTabs = 2} = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'preview-browser-'));
  const paths = chromeInstallPaths(chromeInstallRoot(homeDir), VERSION, 'mac-arm64');
  mkdirSync(dirname(paths.executable), {recursive: true});
  const bytes = 'fixture only, never executed';
  writeFileSync(paths.executable, bytes, {mode: 0o700});
  writeFileSync(paths.receipt, JSON.stringify({schemaVersion: 1, verified: true, version: VERSION,
    platform: 'mac-arm64', executableSha256: createHash('sha256').update(bytes).digest('hex')}));
  writeFileSync(paths.current, JSON.stringify({version: VERSION, platform: 'mac-arm64'}));
  const systemChrome = join(homeDir, 'system-chrome');
  if (systemAvailable) writeFileSync(systemChrome, bytes, {mode: 0o700});

  const spawns = [], calls = [], visits = [], diagnostics = [], warnings = [], targets = new Map(), sessions = new Map();
  let targetSeq = 0;
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.browser = spawns.at(-1);
      if (!holdSocket || !this.browser.managed) queueMicrotask(() => this.emit('open'));
    }
    addEventListener(name, listener, options) {
      if (options?.once) this.once(name, listener);
      else this.on(name, listener);
    }
    close() {
      this.closed = true;
      for (const [id, target] of targets) if (target.browser === this.browser) targets.delete(id);
      this.emit('close');
    }
    send(raw) {
      const {id, method, params, sessionId} = JSON.parse(raw);
      calls.push(method);
      const emit = value => { if (!this.closed) this.emit('message', {data: JSON.stringify(value)}); };
      const respond = () => {
        if (this.closed) return;
        const target = targets.get(sessions.get(sessionId));
        let result = {};
        if (method === 'Target.createTarget') {
          const targetId = 'target-' + ++targetSeq;
          targets.set(targetId, {browser: this.browser});
          result = {targetId};
        } else if (method === 'Target.attachToTarget') {
          const name = 'session-' + params.targetId;
          sessions.set(name, params.targetId);
          result = {sessionId: name};
        } else if (method === 'Target.closeTarget') {
          targets.delete(params.targetId);
          result = {success: true};
        } else if (method === 'Runtime.evaluate') {
          result = {result: {value: {ok: true, article: {
            url: target.url, source: 'page_dom', title: 'fixture article', account: 'fixture account'}}}};
        } else if (method === 'Network.getResponseBody') {
          result = {body: target.outcome === 'invalid' ? 'invalid JSON' : JSON.stringify({errCode: 0,
            data: {feedInfo: {description: 'fixture video', createtime: 1794000000}, authorInfo: {nickname: 'fixture account'}}})};
        }
        emit({id, result});
        if (method !== 'Page.navigate') return;
        if (target.url.startsWith('https://weixin.qq.com/sph/')) {
          emit({sessionId, method: 'Network.responseReceived', params: {requestId: 'feed',
            response: {url: 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info'}}});
          emit({sessionId, method: 'Network.loadingFinished', params: {requestId: 'feed'}});
        } else emit({sessionId, method: 'Page.loadEventFired', params: {}});
      };
      if (method === 'Page.navigate') {
        const target = targets.get(sessions.get(sessionId));
        target.url = params.url;
        target.outcome = navigation(this.browser, params.url);
        visits.push([this.browser.path, params.url]);
        if (target.outcome === 'timeout') return;
        if (typeof target.outcome === 'number') {
          setTimeout(respond, target.outcome);
          return;
        }
      }
      queueMicrotask(respond);
    }
  }

  const preview = createSharePreview({profileDir: join(homeDir, 'private-profile'), maxTabs, timeoutMs: TIMEOUT,
    chromePath: explicit ? paths.executable : undefined, chromeExplicit: explicit,
    browserOptions: {homeDir, platform: 'darwin', arch: 'arm64', systemChrome},
    onDiagnostic: entry => diagnostics.push(entry), onWarning: line => warnings.push(line),
    fetchImpl: async url => {
      assert.equal(url, 'http://127.0.0.1:9333/json/version');
      const browser = spawns.at(-1);
      if (browser.managed) {
        if (holdDevtools) return new Promise(() => {});
        if (performance.now() - browser.started < devtoolsUnavailableMs) throw new Error('DevTools not ready');
        if (launchDelayMs) await new Promise(resolve => setTimeout(resolve, launchDelayMs));
      }
      return {json: async () => ({webSocketDebuggerUrl: 'ws://127.0.0.1:9333/fake'})};
    },
    WebSocketImpl: FakeSocket,
    spawnImpl: path => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kills = [];
      const managed = path === paths.executable;
      child.kill = signal => {
        child.kills.push(signal);
        if (managed && closeHangs) return;
        child.exitCode = 0;
        child.emit('exit', 0, null);
      };
      spawns.push({path, child, managed, started: performance.now(),
        priorExited: spawns.every(item => item.child.exitCode !== null)});
      return child;
    }});
  t.after(() => { preview.close(); rmSync(homeDir, {recursive: true, force: true}); });
  return {preview, spawns, calls, visits, diagnostics, warnings, targets, managed: paths.executable, systemChrome};
}

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

function clock(t) {
  const epoch = Date.parse('2026-11-12T09:00:00.000Z');
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: epoch});
  t.mock.method(performance, 'now', () => Date.now() - epoch);
  return {async advance(ms) { t.mock.timers.tick(ms); await flush(); }, at: ms => new Date(epoch + ms).toISOString()};
}

function runtimeDiagnostics(f) {
  return f.diagnostics.filter(entry => entry.event === 'preview_browser_runtime_fallback');
}

test('a managed Channels timeout retries the same link once with system Chrome and keeps using it', async t => {
  const time = clock(t);
  const f = fixture(t, {navigation: (browser, url) => browser.managed && url === CHANNEL ? 'timeout' : 'ok'});
  const first = f.preview.resolve(CHANNEL);
  first.catch(() => {});
  await flush();
  await time.advance(TIMEOUT);
  assert.equal((await first).description, 'fixture video');
  assert.equal((await f.preview.resolve(CHANNEL_B)).description, 'fixture video');
  assert.deepEqual(f.visits,
    [[f.managed, CHANNEL], [f.systemChrome, CHANNEL], [f.systemChrome, CHANNEL_B]]);
  assert.deepEqual(f.spawns.map(item => item.path), [f.managed, f.systemChrome]);
  assert.equal(f.spawns[1].priorExited, true);
  assert.deepEqual(f.spawns[0].child.kills, ['SIGTERM']);
  assert.equal(f.targets.size, 0);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /超时.*系统 Chrome/u);
  assert.deepEqual(runtimeDiagnostics(f), [{event: 'preview_browser_runtime_fallback',
    at: time.at(TIMEOUT), kind: 'channels', elapsedMs: TIMEOUT, browserVersion: VERSION}]);
});

test('an article timeout retries the canonical article and Channels shares the system browser afterwards', async t => {
  const time = clock(t);
  const f = fixture(t, {navigation: (browser, url) => browser.managed && url === ARTICLE ? 'timeout' : 'ok'});
  const request = f.preview.resolveArticle(ARTICLE + '?tracking=1');
  request.catch(() => {});
  await flush();
  await time.advance(TIMEOUT);
  await time.advance(250);
  assert.equal((await request).url, ARTICLE);
  assert.equal((await f.preview.resolve(CHANNEL)).nickname, 'fixture account');
  assert.deepEqual(f.visits,
    [[f.managed, ARTICLE], [f.systemChrome, ARTICLE], [f.systemChrome, CHANNEL]]);
  assert.equal(f.spawns.length, 2);
  assert.equal(f.warnings.length, 1);
  assert.equal(runtimeDiagnostics(f)[0].kind, 'article');
});

test('a second preview timeout is returned to the caller with no third navigation', async t => {
  const time = clock(t);
  const f = fixture(t, {navigation: (_browser, url) => url === CHANNEL ? 'timeout' : 'ok'});
  const request = f.preview.resolve(CHANNEL);
  request.catch(() => {});
  await flush();
  await time.advance(TIMEOUT);
  await time.advance(TIMEOUT);
  await assert.rejects(request, {code: 'preview_timeout', retryable: false});
  assert.deepEqual(f.visits,
    [[f.managed, CHANNEL], [f.systemChrome, CHANNEL]]);
  assert.equal(f.warnings.length, 1);
  assert.equal(runtimeDiagnostics(f).length, 1);
  assert.equal((await f.preview.resolve(CHANNEL_B)).nickname, 'fixture account');
  assert.equal(f.spawns.length, 2);
});

test('a parsing failure on the managed browser keeps that browser selected', async t => {
  const f = fixture(t, {navigation: (_browser, url) => url === CHANNEL ? 'invalid' : 'ok'});
  await assert.rejects(f.preview.resolve(CHANNEL), {code: 'preview_invalid'});
  assert.equal((await f.preview.resolve(CHANNEL_B)).nickname, 'fixture account');
  assert.deepEqual(f.visits, [[f.managed, CHANNEL], [f.managed, CHANNEL_B]]);
  assert.equal(f.spawns.length, 1);
  assert.equal(f.warnings.length, 0);
  assert.equal(runtimeDiagnostics(f).length, 0);
});

for (const [label, options] of [['an explicit --chrome', {explicit: true}], ['no system Chrome', {systemAvailable: false}]]) {
  test('a preview timeout with ' + label + ' keeps the original error and never switches', async t => {
    const time = clock(t);
    const f = fixture(t, {...options, navigation: (_browser, url) => url === CHANNEL ? 'timeout' : 'ok'});
    const request = f.preview.resolve(CHANNEL);
    request.catch(() => {});
    await flush();
    await time.advance(TIMEOUT);
    await assert.rejects(request, {code: 'preview_timeout'});
    assert.deepEqual(f.visits, [[f.managed, CHANNEL]]);
    assert.equal(f.spawns.length, 1);
    assert.equal(f.warnings.length, 0);
    assert.equal(runtimeDiagnostics(f).length, 0);
  });
}

test('fallback lets an already open tab finish, then starts queued pages on system Chrome', async t => {
  const time = clock(t);
  const f = fixture(t, {navigation: (browser, url) => {
    if (browser.managed && url === CHANNEL) return 'timeout';
    if (browser.managed && url === CHANNEL_B) return 14_800;
    return 'ok';
  }});
  const first = f.preview.resolve(CHANNEL);
  first.catch(() => {});
  await flush();
  await time.advance(500);
  const second = f.preview.resolve(CHANNEL_B), queued = f.preview.resolve(CHANNEL_C);
  await flush();
  await time.advance(14_500);
  assert.deepEqual(f.visits, [[f.managed, CHANNEL], [f.managed, CHANNEL_B]]);
  assert.equal(f.spawns.length, 1);
  await time.advance(300);
  const results = await Promise.all([first, second, queued]);
  assert.ok(results.every(value => value.nickname === 'fixture account'));
  assert.deepEqual(f.visits, [[f.managed, CHANNEL], [f.managed, CHANNEL_B],
    [f.systemChrome, CHANNEL], [f.systemChrome, CHANNEL_C]]);
  assert.equal(f.spawns[1].priorExited, true);
  assert.equal(runtimeDiagnostics(f).length, 1);
});

test('an unexited browser leaves the timed-out preview failed without opening a second browser', async t => {
  const time = clock(t);
  const f = fixture(t, {closeHangs: true, navigation: () => 'timeout'});
  const first = f.preview.resolve(CHANNEL);
  first.catch(() => {});
  await flush();
  await time.advance(TIMEOUT);
  await time.advance(2000);
  await assert.rejects(first, {code: 'preview_timeout'});
  await assert.rejects(f.preview.resolve(CHANNEL_B), {code: 'preview_unavailable'});
  assert.equal(f.preview.available(), false);
  assert.equal(f.spawns.length, 1);
  assert.equal(f.warnings.length, 0);
  assert.equal(runtimeDiagnostics(f).length, 0);
});

test('a caller canceled during the first preview never switches or retries', async t => {
  const time = clock(t);
  const f = fixture(t, {navigation: () => 'timeout'});
  const controller = new AbortController();
  const pending = assert.rejects(f.preview.resolve(CHANNEL, {signal: controller.signal}), {code: 'aborted'});
  await flush();
  controller.abort();
  await pending;
  await time.advance(TIMEOUT);
  assert.deepEqual(f.visits, [[f.managed, CHANNEL]]);
  assert.equal(f.targets.size, 0);
  assert.equal(f.spawns.length, 1);
  assert.equal(f.warnings.length, 0);
  assert.equal(runtimeDiagnostics(f).length, 0);
});

test('a caller canceled while the browser is exiting does not replay the timed-out link', async t => {
  const time = clock(t);
  const f = fixture(t, {closeHangs: true, navigation: (browser, url) =>
    browser.managed && url === CHANNEL ? 'timeout' : 'ok'});
  const controller = new AbortController();
  const pending = f.preview.resolve(CHANNEL, {signal: controller.signal});
  pending.catch(() => {});
  await flush();
  await time.advance(TIMEOUT);
  const {child} = f.spawns[0];
  assert.deepEqual(child.kills, ['SIGTERM']);
  controller.abort();
  await assert.rejects(pending, {code: 'aborted'});
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.equal((await f.preview.resolve(CHANNEL_B)).nickname, 'fixture account');
  assert.deepEqual(f.visits, [[f.managed, CHANNEL], [f.systemChrome, CHANNEL_B]]);
});

test('shared startup can take twenty seconds and opens no page', async t => {
  const time = clock(t);
  const f = fixture(t, {launchDelayMs: 20_000});
  assert.equal(f.preview.status().reason, 'preview_warming');
  f.preview.start();
  const pending = Promise.all([f.preview.prepare(), f.preview.prepare()]);
  await time.advance(19_999);
  assert.equal(f.diagnostics.length, 0);
  assert.equal(f.preview.available(), false);
  await time.advance(1);
  await pending;
  assert.deepEqual(f.calls, []);
  assert.equal(f.spawns.length, 1);
  assert.equal(f.preview.available(), true);
  assert.deepEqual(f.diagnostics, [{event: 'preview_browser_selfcheck_passed', at: time.at(20_000),
    stage: 'launch', launchElapsedMs: 20_000, elapsedMs: 20_000}]);
  assert.equal(f.warnings.length, 0);
});

test('launch past thirty seconds switches once without navigating a selfcheck page', async t => {
  const time = clock(t);
  const f = fixture(t, {launchDelayMs: 31_000});
  const pending = f.preview.prepare();
  await time.advance(29_999);
  assert.equal(f.diagnostics.length, 0);
  await time.advance(1);
  await pending;
  assert.deepEqual(f.diagnostics, [{event: 'preview_browser_selfcheck_failed', at: time.at(30_000), stage: 'launch',
    code: 'preview_selfcheck_timeout', launchElapsedMs: 30_000, elapsedMs: 30_000,
    explicit: false, fallback: true, browserStopped: true}]);
  assert.deepEqual(f.spawns[0].child.kills, ['SIGTERM']);
  await time.advance(1000);
  assert.equal((await f.preview.resolve(CHANNEL)).nickname, 'fixture account');
  assert.deepEqual(f.visits, [[f.systemChrome, CHANNEL]]);
  assert.equal(f.spawns[1].priorExited, true);
  assert.equal(f.warnings.length, 1);
});

test('DevTools endpoint retries can span a twenty-second cold start', async t => {
  const time = clock(t);
  const f = fixture(t, {devtoolsUnavailableMs: 20_000});
  const pending = f.preview.prepare();
  await flush();
  for (let i = 0; i < 79; i++) await time.advance(250);
  assert.equal(f.diagnostics.length, 0);
  await time.advance(250);
  await pending;
  assert.equal(f.diagnostics[0].event, 'preview_browser_selfcheck_passed');
  assert.equal(f.diagnostics[0].launchElapsedMs, 20_000);
  assert.deepEqual(f.calls, []);
  assert.equal(f.spawns.length, 1);
});

test('explicit launch timeout bounds a stalled websocket handshake and does not switch browsers', async t => {
  const time = clock(t);
  const f = fixture(t, {explicit: true, holdSocket: true});
  const rejected = assert.rejects(f.preview.prepare(), {code: 'preview_browser_selfcheck_failed'});
  await flush();
  await time.advance(30_000);
  await rejected;
  assert.deepEqual(f.diagnostics, [{event: 'preview_browser_selfcheck_failed', at: time.at(30_000), stage: 'launch',
    code: 'preview_selfcheck_timeout', launchElapsedMs: 30_000, elapsedMs: 30_000,
    explicit: true, fallback: false, browserStopped: true}]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.spawns.length, 1);
  assert.equal(f.warnings.length, 0);
  assert.equal(f.preview.available(), false);
});

test('closing during launch cancels shared preparation without late browser work', async t => {
  const time = clock(t);
  const f = fixture(t, {launchDelayMs: 20_000});
  const canceled = assert.rejects(f.preview.prepare(), {code: 'aborted'});
  await time.advance(10_000);
  f.preview.close();
  await canceled;
  await time.advance(30_000);
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(f.spawns[0].child.kills, ['SIGTERM']);
  assert.deepEqual(f.calls, []);
  assert.equal(f.diagnostics.length, 0);
  assert.equal(f.warnings.length, 0);
});

test('a missing system browser or an unexited owned browser leaves a failed launch unavailable', async t => {
  const time = clock(t);
  for (const options of [{systemAvailable: false}, {closeHangs: true}]) {
    const f = fixture(t, {...options, holdDevtools: true});
    const rejected = assert.rejects(f.preview.prepare(), {code: 'preview_browser_selfcheck_failed'});
    await flush();
    await time.advance(30_000);
    await time.advance(2000);
    await rejected;
    assert.equal(f.preview.available(), false);
    assert.equal(f.spawns.length, 1);
    assert.equal(f.warnings.length, 0);
    assert.equal(f.diagnostics[0].fallback, false);
    assert.equal(f.diagnostics[0].browserStopped, !options.closeHangs);
    assert.deepEqual(f.calls, []);
  }
});

test('canceling one waiter does not cancel startup shared with a second waiter', async t => {
  const time = clock(t);
  const f = fixture(t, {launchDelayMs: 20_000});
  const canceled = new AbortController();
  const first = assert.rejects(f.preview.prepare({signal: canceled.signal}), {code: 'aborted'});
  const second = f.preview.prepare();
  canceled.abort();
  await first;
  await time.advance(20_000);
  await second;
  assert.equal(f.diagnostics[0].event, 'preview_browser_selfcheck_passed');
  assert.equal(f.preview.available(), true);
  assert.deepEqual(f.calls, []);
});

test('an already canceled caller never starts the browser', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.preview.prepare({signal: controller.signal}), {code: 'aborted'});
  assert.equal(f.spawns.length, 0);
});

test('a tampered explicit managed path cannot silently become the system fallback', async t => {
  const homeDir = mkdtempSync(join(tmpdir(), 'explicit-invalid-preview-'));
  t.after(() => rmSync(homeDir, {recursive: true, force: true}));
  const paths = chromeInstallPaths(chromeInstallRoot(homeDir), VERSION, 'mac-arm64');
  mkdirSync(dirname(paths.executable), {recursive: true});
  writeFileSync(paths.executable, 'invalid fixture', {mode: 0o700});
  const warnings = [], diagnostics = [];
  const preview = createSharePreview({chromePath: paths.executable, chromeExplicit: true,
    profileDir: join(homeDir, 'private'), browserOptions: {homeDir, platform: 'darwin', arch: 'arm64',
      systemChrome: process.execPath, onWarning: message => warnings.push(message)},
    onDiagnostic: entry => diagnostics.push(entry), spawnImpl: () => assert.fail('invalid explicit path must not spawn')});
  t.after(() => preview.close());
  await assert.rejects(preview.prepare(), {code: 'preview_browser_selfcheck_failed'});
  assert.equal(warnings.length, 0);
  assert.equal(diagnostics[0].code, 'preview_explicit_unavailable');
  assert.equal(diagnostics[0].fallback, false);
});

test('invalid public preview URLs are rejected before a browser starts', async t => {
  const f = fixture(t);
  await assert.rejects(f.preview.resolve('http://127.0.0.1:1234/example'), {code: 'share_link_invalid'});
  await assert.rejects(f.preview.resolveArticle('https://example.com/article'), {code: 'article_link_invalid'});
  assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.calls, []);
});

test('pending preview gates both WeChat platforms while Douyin can still probe and prepare a task', async () => {
  const store = new RunnerStore(':memory:');
  let prepared = false, release, started = 0;
  const flight = new Promise(resolve => { release = () => { prepared = true; resolve(); }; });
  const preview = {start() { started++; }, prepare: () => flight, available: () => prepared,
    status: () => ({readyForSearch: false, reason: 'preview_warming'}), close() {}};
  const adapter = {probe: async () => ({readyForSearch: true, reason: null})};
  const ocr = {lastSuccessAt: Date.now(), pending: 0, recognize: async () => ({rows: []}), close() {}};
  const device = combineRunnerDevices({douyin: adapter, wechat: adapter, articles: adapter, preview, ocr, store});
  try {
    assert.equal(started, 1);
    assert.deepEqual((await device.probe()).platforms, ['douyin']);
    await device.prepareTask({platform: 'douyin'});
    let ready = false;
    const waiting = device.prepareTask({platform: 'wechat_articles'}).then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false);
    release();
    await waiting;
    assert.deepEqual((await device.probe()).platforms, ['douyin', 'wechat_channels', 'wechat_articles']);
  } finally { device.shutdown(); store.close(); }
});
