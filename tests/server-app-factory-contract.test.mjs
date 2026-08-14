import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../server/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');

function assertAppearsInOrder(source, snippets, message) {
  let cursor = -1;
  for (const snippet of snippets) {
    const next = source.indexOf(snippet, cursor + 1);
    assert.notEqual(next, -1, `${message}: missing ${snippet}`);
    assert.ok(next > cursor, `${message}: ${snippet} is out of order`);
    cursor = next;
  }
}

function signalHandlerSource(signal) {
  const marker = `process.on('${signal}'`;
  const start = indexSource.indexOf(marker);
  assert.notEqual(start, -1, `missing ${signal} handler`);
  const end = indexSource.indexOf('\n});', start);
  assert.notEqual(end, -1, `unterminated ${signal} handler`);
  return indexSource.slice(start, end);
}

test('app factory owns HTTP composition without process startup side effects', () => {
  assert.match(appSource, /export function createApp\(/u);
  assert.doesNotMatch(appSource, /\.listen\s*\(/u);
  assert.doesNotMatch(appSource, /\binitDb\b/u);
  assert.doesNotMatch(appSource, /\bstartCronJobs\b/u);
  assert.doesNotMatch(appSource, /\bsetInterval\b/u);
  assert.doesNotMatch(appSource, /\bsetTimeout\b/u);

  assert.match(indexSource, /import \{ createApp \} from '\.\/app\.js';/u);
  assert.match(indexSource, /const app = createApp\(\);/u);
  assert.match(indexSource, /await initDb\(\);/u);
  assert.match(indexSource, /startCronJobs\(\);/u);
  assert.match(indexSource, /app\.listen\(PORT/u);

  const startupSource = indexSource.slice(
    indexSource.indexOf('async function start()'),
    indexSource.indexOf('\nstart().catch'),
  );
  assertAppearsInOrder(startupSource, [
    'await initDb();',
    'startVerifyRateLimitCleanup();',
    'startAsrMediaCleanup();',
    'startCronJobs();',
    'app.listen(PORT',
  ], 'compatibility entrypoint startup');

  for (const signal of ['SIGINT', 'SIGTERM']) {
    assertAppearsInOrder(signalHandlerSource(signal), [
      'stopVerifyRateLimitCleanup();',
      'stopAsrMediaCleanup();',
      'await closeDb();',
    ], `${signal} shutdown`);
  }
});

test('importing and creating the app adds no timers or signal listeners while cleanups are idempotent', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetImmediate = globalThis.setImmediate;
  const intervalHandles = [];
  const clearedHandles = [];
  const timeoutHandles = [];
  const immediateHandles = [];
  const signalListenerCounts = new Map([
    ['SIGINT', process.listenerCount('SIGINT')],
    ['SIGTERM', process.listenerCount('SIGTERM')],
  ]);
  let verifyModule;
  let asrModule;

  globalThis.setInterval = (callback, delay) => {
    const handle = {
      callback,
      delay,
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1;
        return this;
      },
    };
    intervalHandles.push(handle);
    return handle;
  };
  globalThis.clearInterval = handle => {
    clearedHandles.push(handle);
  };
  globalThis.setTimeout = (callback, delay) => {
    const handle = { callback, delay };
    timeoutHandles.push(handle);
    return handle;
  };
  globalThis.setImmediate = callback => {
    const handle = { callback };
    immediateHandles.push(handle);
    return handle;
  };

  try {
    const appUrl = new URL('../server/app.js', import.meta.url);
    appUrl.searchParams.set('side-effect-contract', String(Date.now()));
    const { createApp } = await import(appUrl.href);
    const app = createApp({ logger: { log() {}, error() {} } });

    assert.equal(typeof app, 'function');
    assert.equal(intervalHandles.length, 0, 'app import/create must not start setInterval');
    assert.equal(timeoutHandles.length, 0, 'app import/create must not start setTimeout');
    assert.equal(immediateHandles.length, 0, 'app import/create must not start setImmediate');
    for (const [signal, listenerCount] of signalListenerCounts) {
      assert.equal(
        process.listenerCount(signal),
        listenerCount,
        `app import/create must not register a ${signal} listener`,
      );
    }

    verifyModule = await import('../server/routes/verify.js');
    const firstVerifyHandle = verifyModule.startVerifyRateLimitCleanup();
    const secondVerifyHandle = verifyModule.startVerifyRateLimitCleanup();
    assert.strictEqual(secondVerifyHandle, firstVerifyHandle);
    assert.equal(intervalHandles.length, 1);
    assert.equal(firstVerifyHandle.unrefCalls, 1);
    assert.equal(verifyModule.stopVerifyRateLimitCleanup(), true);
    assert.equal(verifyModule.stopVerifyRateLimitCleanup(), false);
    assert.deepEqual(clearedHandles, [firstVerifyHandle]);

    asrModule = await import('../server/services/asr-media-host.js');
    const firstAsrHandle = asrModule.startAsrMediaCleanup();
    const secondAsrHandle = asrModule.startAsrMediaCleanup();
    assert.strictEqual(secondAsrHandle, firstAsrHandle);
    assert.equal(intervalHandles.length, 2);
    assert.equal(firstAsrHandle.unrefCalls, 1);
    assert.equal(asrModule.stopAsrMediaCleanup(), true);
    assert.equal(asrModule.stopAsrMediaCleanup(), false);
    assert.deepEqual(clearedHandles, [firstVerifyHandle, firstAsrHandle]);
  } finally {
    verifyModule?.stopVerifyRateLimitCleanup();
    asrModule?.stopAsrMediaCleanup();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setImmediate = originalSetImmediate;
  }
});
