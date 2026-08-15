import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runProcessEntrypoint } from '../server/runtime/process-entrypoint.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createHarness(overrides = {}) {
  const processObject = new EventEmitter();
  const exits = [];
  const timers = [];
  const clearedTimers = [];

  const options = {
    expectedRole: 'scheduler',
    entrypoint: 'server/scheduler-process.js',
    processObject,
    exitProcess(code) {
      exits.push(code);
    },
    setTimer(callback, delay) {
      const handle = {
        callback,
        delay,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      clearedTimers.push(handle);
    },
    logger: quietLogger(),
    ...overrides,
  };

  return { options, processObject, exits, timers, clearedTimers };
}

test('first termination signal drains the runtime and exits successfully', async () => {
  const stopCalls = [];
  const runtime = {
    async stop(options) {
      stopCalls.push(options);
      return { drained: true };
    },
  };
  const harness = createHarness({
    startProcess: async () => runtime,
    env: { PROCESS_SHUTDOWN_TIMEOUT_MS: '321' },
  });

  const started = await runProcessEntrypoint(harness.options);
  assert.strictEqual(started, runtime);

  harness.processObject.emit('SIGTERM');
  await nextTurn();

  assert.deepEqual(stopCalls, [{ reason: 'SIGTERM', timeoutMs: 321 }]);
  assert.deepEqual(harness.exits, [0]);
  assert.equal(harness.processObject.listenerCount('SIGTERM'), 0);
  assert.equal(harness.processObject.listenerCount('SIGINT'), 0);
  assert.equal(harness.clearedTimers.length, 1);
});

test('second signal during an active graceful shutdown forces a non-zero exit', async () => {
  const shutdown = deferred();
  let stopCalls = 0;
  const harness = createHarness({
    startProcess: async () => ({
      stop() {
        stopCalls += 1;
        return shutdown.promise;
      },
    }),
  });

  await runProcessEntrypoint(harness.options);
  harness.processObject.emit('SIGTERM');
  assert.equal(stopCalls, 1);
  assert.deepEqual(harness.exits, []);

  harness.processObject.emit('SIGINT');
  assert.deepEqual(harness.exits, [1]);

  shutdown.resolve({ drained: true });
  await nextTurn();
  assert.deepEqual(harness.exits, [1]);
});

test('a signal received during startup drains immediately after startup completes', async () => {
  const startup = deferred();
  const stopCalls = [];
  const harness = createHarness({
    startProcess: () => startup.promise,
  });

  const entrypointPromise = runProcessEntrypoint(harness.options);
  harness.processObject.emit('SIGTERM');
  assert.deepEqual(harness.exits, []);

  startup.resolve({
    async stop(options) {
      stopCalls.push(options);
      return { drained: true };
    },
  });
  await entrypointPromise;
  await nextTurn();

  assert.deepEqual(stopCalls, [{ reason: 'SIGTERM', timeoutMs: 30_000 }]);
  assert.deepEqual(harness.exits, [0]);
});

test('second signal while startup is still pending forces a non-zero exit', async () => {
  const startup = deferred();
  const harness = createHarness({
    startProcess: () => startup.promise,
  });

  const entrypointPromise = runProcessEntrypoint(harness.options);
  harness.processObject.emit('SIGTERM');
  assert.deepEqual(harness.exits, []);

  harness.processObject.emit('SIGINT');
  assert.deepEqual(harness.exits, [1]);

  startup.resolve({
    async stop() {
      return { drained: true };
    },
  });
  await entrypointPromise;
});

test('role-lock loss uses the fail-fast exit path without starting graceful shutdown', async () => {
  let reportLockLost;
  let stopCalls = 0;
  const harness = createHarness({
    startProcess: async ({ onLockLost }) => {
      reportLockLost = onLockLost;
      return {
        async stop() {
          stopCalls += 1;
          return { drained: true };
        },
      };
    },
  });

  await runProcessEntrypoint(harness.options);
  reportLockLost(new Error('advisory lock connection ended'));

  assert.deepEqual(harness.exits, [1]);
  assert.equal(stopCalls, 0);
  assert.equal(harness.processObject.listenerCount('SIGTERM'), 0);
  assert.equal(harness.processObject.listenerCount('SIGINT'), 0);
});

test('startup failure exits non-zero and removes signal handlers', async () => {
  const startupError = new Error('startup failed');
  const harness = createHarness({
    startProcess: async () => {
      throw startupError;
    },
  });

  const result = await runProcessEntrypoint(harness.options);

  assert.equal(result, null);
  assert.deepEqual(harness.exits, [1]);
  assert.equal(harness.processObject.listenerCount('SIGTERM'), 0);
  assert.equal(harness.processObject.listenerCount('SIGINT'), 0);
});

test('forced-shutdown timer exits non-zero when graceful drain does not finish', async () => {
  const shutdown = deferred();
  const harness = createHarness({
    startProcess: async () => ({ stop: () => shutdown.promise }),
  });

  await runProcessEntrypoint(harness.options);
  harness.processObject.emit('SIGTERM');
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].unrefCalled, true);

  harness.timers[0].callback();
  assert.deepEqual(harness.exits, [1]);

  shutdown.resolve({ drained: true });
  await nextTurn();
  assert.deepEqual(harness.exits, [1]);
});
