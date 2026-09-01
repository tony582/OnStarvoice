import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';

import {
  API_RUNTIME_RESPONSIBILITIES,
  startApiRuntime,
} from '../server/runtime/api-runtime.js';
import {
  AI_MEDIA_RUNTIME_RESPONSIBILITIES,
  COMPATIBILITY_ONE_SHOT_RESPONSIBILITIES,
  startAiMediaRuntime,
} from '../server/runtime/ai-media-runtime.js';
import {
  SCHEDULER_RUNTIME_RESPONSIBILITIES,
  startSchedulerRuntime,
} from '../server/runtime/scheduler-runtime.js';

function createFakeApp(events, { listenError = null } = {}) {
  const server = new EventEmitter();
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 43123 });
  server.close = (callback) => {
    events.push('listener:close');
    queueMicrotask(() => callback());
  };
  server.closeIdleConnections = () => {
    events.push('listener:close-idle');
  };
  server.closeAllConnections = () => {
    events.push('listener:close-all');
  };

  return {
    server,
    app: {
      listen(port, hostOrCallback, maybeCallback) {
        const callback = typeof hostOrCallback === 'function'
          ? hostOrCallback
          : maybeCallback;
        events.push(`listener:listen:${port}`);
        queueMicrotask(() => {
          if (listenError) {
            server.emit('error', listenError);
          } else {
            callback();
          }
        });
        return server;
      },
    },
  };
}

function fakeCronRuntime(events) {
  let stopped = false;
  return {
    stop() {
      if (stopped) return false;
      stopped = true;
      events.push('cron:stop');
      return true;
    },
    async drain() {
      events.push('cron:drain');
      return { drained: true };
    },
    destroy() {
      events.push('cron:destroy');
      return true;
    },
    snapshot() {
      return {};
    },
  };
}

function fakeWakeupRuntime(events) {
  let stopped = false;
  return {
    stopNewWork() {
      if (stopped) return false;
      stopped = true;
      events.push('wakeups:stop');
      return true;
    },
    async drain() {
      events.push('wakeups:drain');
      return {
        name: 'ops-control-wakeup',
        drained: true,
        timedOut: false,
        pending: 0,
      };
    },
    snapshot() {
      return {connected: true};
    },
  };
}

function fakeDrainController(events) {
  return {
    inFlightCount: 0,
    run(work) {
      events.push('drain:run');
      return Promise.resolve().then(work);
    },
    stopAccepting() {
      events.push('drain:stop-accepting');
      return true;
    },
    async waitForIdle() {
      events.push('drain:wait-idle');
      return { drained: true };
    },
  };
}

function fakeTimers(events) {
  let nextId = 0;
  const scheduled = [];
  return {
    scheduled,
    setTimer(callback, delay) {
      const handle = { id: ++nextId, callback, delay };
      scheduled.push(handle);
      events.push(`timer:set:${delay}`);
      return handle;
    },
    clearTimer(handle) {
      events.push(`timer:clear:${handle.id}`);
    },
  };
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('API runtime is the only runtime that owns and closes an HTTP listener', async () => {
  const events = [];
  const { app, server } = createFakeApp(events);

  const runtime = await startApiRuntime({
    port: 0,
    buildApp: () => {
      events.push('app:build');
      return app;
    },
    prepareMediaDirectories: () => {
      events.push('media:ensure');
    },
    startVerifyCleanup() {
      events.push('verify:start');
    },
    stopVerifyCleanup() {
      events.push('verify:stop');
    },
    startMediaCleanup() {
      events.push('media-cleanup:start');
    },
    stopMediaCleanup() {
      events.push('media-cleanup:stop');
    },
    logger: quietLogger(),
  });

  assert.equal(runtime.kind, 'api');
  assert.strictEqual(runtime.server, server);
  assert.equal(runtime.port, 43123);
  assert.deepEqual(runtime.responsibilities, API_RUNTIME_RESPONSIBILITIES);
  assert.deepEqual(events, [
    'media:ensure',
    'verify:start',
    'media-cleanup:start',
    'app:build',
    'listener:listen:0',
  ]);

  events.length = 0;
  assert.equal(runtime.stopNewWork(), true);
  assert.equal(runtime.stopNewWork(), false);
  const result = await runtime.drain({ timeoutMs: 50 });
  assert.equal(result.drained, true);
  assert.deepEqual(events, [
    'verify:stop',
    'media-cleanup:stop',
    'listener:close',
    'listener:close-idle',
  ]);
});

test('real HTTP drain keeps an in-flight request alive before closing the listener', async t => {
  const requestStarted = deferred();
  const releaseResponse = deferred();
  const app = {
    listen(port, hostOrCallback, maybeCallback) {
      const host = typeof hostOrCallback === 'string' ? hostOrCallback : undefined;
      const callback = typeof hostOrCallback === 'function' ? hostOrCallback : maybeCallback;
      const server = http.createServer(async (request, response) => {
        requestStarted.resolve();
        await releaseResponse.promise;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
      return host ? server.listen(port, host, callback) : server.listen(port, callback);
    },
  };
  const runtime = await startApiRuntime({
    port: 0,
    host: '127.0.0.1',
    buildApp: () => app,
    prepareMediaDirectories() {},
    startVerifyCleanup() {},
    stopVerifyCleanup() {},
    startMediaCleanup() {},
    stopMediaCleanup() {},
    logger: quietLogger(),
  });
  t.after(async () => {
    releaseResponse.resolve();
    await runtime.stop({ timeoutMs: 1000 });
  });

  const responsePromise = fetch(`http://127.0.0.1:${runtime.port}/slow`);
  await requestStarted.promise;

  let drainSettled = false;
  const drainPromise = runtime.drain({ timeoutMs: 1000 }).then(result => {
    drainSettled = true;
    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(drainSettled, false, 'listener drain abandoned the in-flight request');

  releaseResponse.resolve();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await drainPromise).drained, true);
});

test('API listener startup failure tears down API-owned cleanup loops', async () => {
  const events = [];
  const listenError = new Error('address in use');
  const { app } = createFakeApp(events, { listenError });

  await assert.rejects(
    startApiRuntime({
      buildApp: () => app,
      prepareMediaDirectories: () => {},
      startVerifyCleanup: () => events.push('verify:start'),
      stopVerifyCleanup: () => events.push('verify:stop'),
      startMediaCleanup: () => events.push('media:start'),
      stopMediaCleanup: () => events.push('media:stop'),
      logger: quietLogger(),
    }),
    listenError,
  );

  assert.deepEqual(events.slice(-2), ['verify:stop', 'media:stop']);
});

test('an observational logger failure cannot orphan a live API listener', async () => {
  const events = [];
  const { app } = createFakeApp(events);
  const runtime = await startApiRuntime({
    buildApp: () => app,
    prepareMediaDirectories() {},
    startVerifyCleanup() {},
    stopVerifyCleanup() {},
    startMediaCleanup() {},
    stopMediaCleanup() {},
    logger: {
      info() {
        throw new Error('logger unavailable');
      },
    },
  });

  assert.equal(runtime.kind, 'api');
  assert.equal((await runtime.stop({ timeoutMs: 50 })).drained, true);
});

test('scheduler worker has no HTTP listener surface and delegates bounded cron lifecycle', async () => {
  const events = [];
  const runtime = await startSchedulerRuntime({
    startCron: () => {
      events.push('cron:start');
      return fakeCronRuntime(events);
    },
    startWakeups: () => {
      events.push('wakeups:start');
      return fakeWakeupRuntime(events);
    },
  });

  assert.equal(runtime.kind, 'scheduler');
  assert.equal('server' in runtime, false);
  assert.equal('port' in runtime, false);
  assert.deepEqual(runtime.responsibilities, SCHEDULER_RUNTIME_RESPONSIBILITIES);
  assert.equal(runtime.stopNewWork(), true);
  assert.equal(runtime.stopNewWork(), false);
  const result = await runtime.drain({ timeoutMs: 20 });
  assert.equal(result.drained, true);
  assert.equal(result.cron.drained, true);
  assert.equal(result.wakeups.drained, true);
  assert.deepEqual(events, [
    'cron:start',
    'wakeups:start',
    'cron:stop',
    'wakeups:stop',
    'cron:drain',
    'wakeups:drain',
    'cron:destroy',
  ]);
});

test('split ai-media worker excludes compatibility one-shots and has no HTTP listener', async () => {
  const events = [];
  const timers = fakeTimers(events);
  let staleRepairCalls = 0;

  const runtime = await startAiMediaRuntime({
    compatibilityMode: false,
    startCron: () => fakeCronRuntime(events),
    createDrainController: () => fakeDrainController(events),
    jobs: {
      failStaleAnalyses: async () => {
        staleRepairCalls += 1;
      },
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    logger: quietLogger(),
  });

  assert.equal(runtime.kind, 'ai-media');
  assert.equal('server' in runtime, false);
  assert.equal('port' in runtime, false);
  assert.deepEqual(runtime.responsibilities, AI_MEDIA_RUNTIME_RESPONSIBILITIES);
  assert.equal(staleRepairCalls, 0);
  assert.deepEqual(timers.scheduled.map(({ delay }) => delay), [20_000, 60_000]);

  runtime.stopNewWork();
  const result = await runtime.drain({ timeoutMs: 20 });
  assert.equal(result.drained, true);
  assert.equal(events.filter((event) => event.startsWith('timer:clear:')).length, 2);
});

test('compatibility ai-media owns the explicit one-shot boundary in addition to recurring work', async () => {
  const events = [];
  const timers = fakeTimers(events);
  let staleRepairCalls = 0;

  const runtime = await startAiMediaRuntime({
    compatibilityMode: true,
    startCron: () => fakeCronRuntime(events),
    createDrainController: () => fakeDrainController(events),
    jobs: {
      failStaleAnalyses: async () => {
        staleRepairCalls += 1;
      },
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    maintenanceTaskRunner: async ({ task }) => ({
      status: 'succeeded',
      result: await task.run(),
    }),
    logger: quietLogger(),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runtime.responsibilities, [
    ...AI_MEDIA_RUNTIME_RESPONSIBILITIES,
    ...COMPATIBILITY_ONE_SHOT_RESPONSIBILITIES,
  ]);
  assert.equal(staleRepairCalls, 1);
  assert.deepEqual(timers.scheduled.map(({ delay }) => delay), [
    20_000,
    60_000,
    15_000,
    25_000,
    25_000,
  ]);

  runtime.stopNewWork();
  await runtime.drain({ timeoutMs: 20 });
  assert.equal(events.filter((event) => event.startsWith('timer:clear:')).length, 5);
});

test('API, scheduler, and recurring ai-media responsibility sets are pairwise disjoint', () => {
  const roleSets = [
    new Set(API_RUNTIME_RESPONSIBILITIES),
    new Set(SCHEDULER_RUNTIME_RESPONSIBILITIES),
    new Set(AI_MEDIA_RUNTIME_RESPONSIBILITIES),
  ];

  for (let leftIndex = 0; leftIndex < roleSets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roleSets.length; rightIndex += 1) {
      const overlap = [...roleSets[leftIndex]].filter((item) => roleSets[rightIndex].has(item));
      assert.deepEqual(overlap, []);
    }
  }

  const splitUnion = new Set([
    ...API_RUNTIME_RESPONSIBILITIES,
    ...SCHEDULER_RUNTIME_RESPONSIBILITIES,
    ...AI_MEDIA_RUNTIME_RESPONSIBILITIES,
  ]);
  const compatibilityUnion = new Set([
    ...splitUnion,
    ...COMPATIBILITY_ONE_SHOT_RESPONSIBILITIES,
  ]);

  assert.equal(splitUnion.size,
    API_RUNTIME_RESPONSIBILITIES.length
      + SCHEDULER_RUNTIME_RESPONSIBILITIES.length
      + AI_MEDIA_RUNTIME_RESPONSIBILITIES.length);
  assert.equal(compatibilityUnion.size,
    splitUnion.size + COMPATIBILITY_ONE_SHOT_RESPONSIBILITIES.length);
});
