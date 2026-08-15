import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../server/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
const compatibilityProcessSource = await readFile(
  new URL('../server/runtime/compatibility-process.js', import.meta.url),
  'utf8',
);
const processEntrypointSource = await readFile(
  new URL('../server/runtime/process-entrypoint.js', import.meta.url),
  'utf8',
);
const processRuntimeSource = await readFile(
  new URL('../server/runtime/process-runtime.js', import.meta.url),
  'utf8',
);
const apiRuntimeSource = await readFile(
  new URL('../server/runtime/api-runtime.js', import.meta.url),
  'utf8',
);

function assertAppearsInOrder(source, snippets, message) {
  let cursor = -1;
  for (const snippet of snippets) {
    const next = source.indexOf(snippet, cursor + 1);
    assert.notEqual(next, -1, `${message}: missing ${snippet}`);
    assert.ok(next > cursor, `${message}: ${snippet} is out of order`);
    cursor = next;
  }
}

test('app factory owns HTTP composition without process startup side effects', () => {
  assert.match(appSource, /export function createApp\(/u);
  assert.doesNotMatch(appSource, /\.listen\s*\(/u);
  assert.doesNotMatch(appSource, /\binitDb\b/u);
  assert.doesNotMatch(appSource, /\bstartCronJobs\b/u);
  assert.doesNotMatch(appSource, /\bsetInterval\b/u);
  assert.doesNotMatch(appSource, /\bsetTimeout\b/u);

  assert.match(
    indexSource,
    /import \{ runProcessEntrypoint \} from '\.\/runtime\/process-entrypoint\.js';/u,
  );
  assert.match(indexSource, /await runProcessEntrypoint\(\{/u);
  assert.match(indexSource, /expectedRole: 'all'/u);
  assert.doesNotMatch(indexSource, /\bcreateApp\b|\bstartCronJobs\b|\.listen\s*\(/u);

  assertAppearsInOrder(compatibilityProcessSource, [
    'const roleConfig = resolveRole({',
    'const lockHandle = await acquireLocks({',
    'await initializeDatabase();',
  ], 'compatibility role fence');

  assertAppearsInOrder(processRuntimeSource, [
    "await prepareCompatibility({ env, logger, onLockLost: notifyLockLost })",
    'for (const runtimeRole of rolesForProcess(preparation.roleConfig.role))',
    'health.markReady?.();',
  ], 'compatibility runtime startup');

  assertAppearsInOrder(apiRuntimeSource, [
    'prepareMediaDirectories();',
    'startVerifyCleanup();',
    'startMediaCleanup();',
    'server = await listen(',
  ], 'API runtime startup');

  assertAppearsInOrder(processRuntimeSource, [
    'health.markDraining?.(reason);',
    'runtime.stopNewWork?.();',
    'const drainResults = await Promise.all(',
    'await closeDatabase();',
    'await preparation.lockHandle.release();',
  ], 'graceful shutdown fence');

  assert.match(processEntrypointSource, /processObject\.on\('SIGINT', onSigint\)/u);
  assert.match(processEntrypointSource, /processObject\.on\('SIGTERM', onSigterm\)/u);
  assert.match(processEntrypointSource, /received \$\{signal\} during shutdown; forcing exit/u);
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
