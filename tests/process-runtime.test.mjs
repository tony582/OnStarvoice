import test from 'node:test';
import assert from 'node:assert/strict';

import { startRoleProcess } from '../server/runtime/process-runtime.js';

function createHealth(events) {
  return {
    markReady() {
      events.push('health:ready');
    },
    markDraining(reason) {
      events.push(`health:draining:${reason}`);
    },
    markStopped() {
      events.push('health:stopped');
    },
    markFailed(reason) {
      events.push(`health:failed:${reason}`);
    },
    snapshot() {
      return {};
    },
  };
}

function createRoleRuntime(role, events, { drained = true } = {}) {
  return {
    kind: role,
    responsibilities: [`${role}-responsibility`],
    stopNewWork() {
      events.push(`stop-new-work:${role}`);
      return true;
    },
    async drain() {
      events.push(`drain:${role}`);
      return { drained };
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

function createBackgroundWork(events, { drained = true } = {}) {
  return {
    async drain() {
      events.push('drain:background');
      return { drained };
    },
  };
}

test('api process uses independent preparation, starts only API, and can close its listener runtime', async () => {
  const events = [];
  const lockHandle = {
    heldRoles: [],
    async release() {
      events.push('release-lock');
    },
  };
  let independentOptions;

  const processRuntime = await startRoleProcess({
    expectedRole: 'api',
    entrypoint: 'server/api-process.js',
    prepareCompatibility: async () => {
      throw new Error('compatibility preparation must not run for api');
    },
    prepareIndependent: async (options) => {
      independentOptions = options;
      events.push('prepare-independent:api');
      return { roleConfig: { role: 'api' }, lockHandle };
    },
    runtimeStarters: {
      api: async () => {
        events.push('start:api');
        return createRoleRuntime('api', events);
      },
      scheduler: async () => {
        throw new Error('scheduler must not start in api process');
      },
      'ai-media': async () => {
        throw new Error('ai-media must not start in api process');
      },
    },
    createHealth: () => createHealth(events),
    onLockLost() {},
    closeDatabase: async () => {
      events.push('close-db');
    },
    backgroundWork: createBackgroundWork(events),
    logger: quietLogger(),
  });

  assert.equal(independentOptions.expectedRole, 'api');
  assert.equal(independentOptions.entrypoint, 'server/api-process.js');
  assert.deepEqual(lockHandle.heldRoles, []);
  assert.deepEqual(processRuntime.runtimes.map(({ kind }) => kind), ['api']);
  assert.deepEqual(
    processRuntime.runtimes.flatMap(({ responsibilities }) => responsibilities),
    ['api-responsibility'],
  );
  assert.deepEqual(events, [
    'prepare-independent:api',
    'start:api',
    'health:ready',
  ]);

  events.length = 0;
  const result = await processRuntime.stop({ reason: 'test', timeoutMs: 25 });

  assert.equal(result.drained, true);
  assert.deepEqual(events, [
    'health:draining:test',
    'stop-new-work:api',
    'drain:api',
    'drain:background',
    'close-db',
    'release-lock',
    'health:stopped',
  ]);
});

test('all process starts the bounded role set and shuts down in the safe order', async () => {
  const events = [];
  const lockHandle = {
    heldRoles: ['scheduler', 'ai-media'],
    async release() {
      events.push('release-lock');
    },
  };

  const runtimeStarters = Object.fromEntries(
    ['scheduler', 'ai-media', 'api'].map((role) => [
      role,
      async () => {
        events.push(`start:${role}`);
        return createRoleRuntime(role, events);
      },
    ]),
  );

  const processRuntime = await startRoleProcess({
    expectedRole: 'all',
    entrypoint: 'server/index.js',
    prepareCompatibility: async () => {
      events.push('prepare-compatibility');
      return { roleConfig: { role: 'all' }, lockHandle };
    },
    prepareIndependent: async () => {
      throw new Error('independent preparation must not run for all');
    },
    runtimeStarters,
    createHealth: () => createHealth(events),
    onLockLost() {},
    closeDatabase: async () => {
      events.push('close-db');
    },
    backgroundWork: createBackgroundWork(events),
    logger: quietLogger(),
  });

  assert.deepEqual(
    processRuntime.runtimes.map(({ kind }) => kind),
    ['scheduler', 'ai-media', 'api'],
  );
  assert.deepEqual(events, [
    'prepare-compatibility',
    'start:scheduler',
    'start:ai-media',
    'start:api',
    'health:ready',
  ]);

  events.length = 0;
  const firstStop = processRuntime.stop({ reason: 'SIGTERM', timeoutMs: 50 });
  const secondStop = processRuntime.stop({ reason: 'ignored', timeoutMs: 1 });
  assert.strictEqual(firstStop, secondStop);
  assert.equal((await firstStop).drained, true);
  assert.deepEqual(events, [
    'health:draining:SIGTERM',
    'stop-new-work:api',
    'stop-new-work:ai-media',
    'stop-new-work:scheduler',
    'drain:api',
    'drain:ai-media',
    'drain:scheduler',
    'drain:background',
    'close-db',
    'release-lock',
    'health:stopped',
  ]);
});

test('role-lock loss marks the process failed before invoking fail-fast handling', async () => {
  const events = [];
  let reportLockLost;

  await startRoleProcess({
    expectedRole: 'scheduler',
    entrypoint: 'server/scheduler-process.js',
    prepareIndependent: async ({ onLockLost }) => {
      reportLockLost = onLockLost;
      return {
        roleConfig: { role: 'scheduler' },
        lockHandle: { heldRoles: ['scheduler'], async release() {} },
      };
    },
    runtimeStarters: {
      scheduler: async () => createRoleRuntime('scheduler', events),
    },
    createHealth: () => createHealth(events),
    closeDatabase: async () => {},
    onLockLost: (error) => {
      events.push(`fail-fast:${error.message}`);
    },
    logger: quietLogger(),
  });

  const lockError = new Error('lock connection ended');
  reportLockLost(lockError);

  assert.deepEqual(events.slice(-2), [
    'health:failed:process_role_lock_lost',
    'fail-fast:lock connection ended',
  ]);
});

test('startup failure cleans started runtimes before database and lock release', async () => {
  const events = [];
  const startupError = new Error('ai-media failed to start');

  await assert.rejects(
    startRoleProcess({
      expectedRole: 'all',
      entrypoint: 'server/index.js',
      prepareCompatibility: async () => ({
        roleConfig: { role: 'all' },
        lockHandle: {
          heldRoles: ['scheduler', 'ai-media'],
          async release() {
            events.push('release-lock');
          },
        },
      }),
      runtimeStarters: {
        scheduler: async () => {
          events.push('start:scheduler');
          return createRoleRuntime('scheduler', events);
        },
        'ai-media': async () => {
          events.push('start:ai-media');
          throw startupError;
        },
        api: async () => {
          events.push('start:api');
          return createRoleRuntime('api', events);
        },
      },
      createHealth: () => createHealth(events),
      onLockLost() {},
      closeDatabase: async () => {
        events.push('close-db');
      },
      backgroundWork: createBackgroundWork(events),
      logger: quietLogger(),
    }),
    startupError,
  );

  assert.deepEqual(events, [
    'start:scheduler',
    'start:ai-media',
    'health:failed:startup_failed',
    'stop-new-work:scheduler',
    'drain:scheduler',
    'drain:background',
    'close-db',
    'release-lock',
  ]);
});

test('startup rollback retains locks when an already-started runtime cannot drain', async () => {
  const events = [];
  const startupError = new Error('api failed to start');

  await assert.rejects(
    startRoleProcess({
      expectedRole: 'all',
      entrypoint: 'server/index.js',
      prepareCompatibility: async () => ({
        roleConfig: { role: 'all' },
        lockHandle: {
          heldRoles: ['scheduler', 'ai-media'],
          async release() {
            events.push('release-lock');
          },
        },
      }),
      runtimeStarters: {
        scheduler: async () => createRoleRuntime('scheduler', events, { drained: false }),
        'ai-media': async () => {
          throw startupError;
        },
        api: async () => createRoleRuntime('api', events),
      },
      createHealth: () => createHealth(events),
      onLockLost() {},
      closeDatabase: async () => {
        events.push('close-db');
      },
      backgroundWork: createBackgroundWork(events),
      logger: quietLogger(),
    }),
    startupError,
  );

  assert.deepEqual(events, [
    'health:failed:startup_failed',
    'stop-new-work:scheduler',
    'drain:scheduler',
  ]);
});

test('incomplete runtime drain is surfaced and retains database and lock ownership until exit', async () => {
  const events = [];

  const processRuntime = await startRoleProcess({
    expectedRole: 'scheduler',
    entrypoint: 'server/scheduler-process.js',
    prepareIndependent: async () => ({
      roleConfig: { role: 'scheduler' },
      lockHandle: {
        heldRoles: ['scheduler'],
        async release() {
          events.push('release-lock');
        },
      },
    }),
    runtimeStarters: {
      scheduler: async () => createRoleRuntime('scheduler', events, { drained: false }),
    },
    createHealth: () => createHealth(events),
    onLockLost() {},
    closeDatabase: async () => {
      events.push('close-db');
    },
    backgroundWork: createBackgroundWork(events),
    logger: quietLogger(),
  });

  events.length = 0;
  const result = await processRuntime.stop({ reason: 'timeout', timeoutMs: 1 });
  assert.equal(result.drained, false);
  assert.equal(result.lockRetained, true);
  assert.deepEqual(events, [
    'health:draining:timeout',
    'stop-new-work:scheduler',
    'drain:scheduler',
    'health:failed:shutdown_incomplete',
  ]);
});

test('incomplete detached background drain also retains database and role locks', async () => {
  const events = [];
  const processRuntime = await startRoleProcess({
    expectedRole: 'ai-media',
    entrypoint: 'server/ai-media-process.js',
    prepareIndependent: async () => ({
      roleConfig: { role: 'ai-media' },
      lockHandle: {
        heldRoles: ['ai-media'],
        async release() {
          events.push('release-lock');
        },
      },
    }),
    runtimeStarters: {
      'ai-media': async () => createRoleRuntime('ai-media', events),
    },
    createHealth: () => createHealth(events),
    onLockLost() {},
    closeDatabase: async () => {
      events.push('close-db');
    },
    backgroundWork: createBackgroundWork(events, { drained: false }),
    logger: quietLogger(),
  });

  events.length = 0;
  const result = await processRuntime.stop({ reason: 'timeout', timeoutMs: 5 });
  assert.equal(result.drained, false);
  assert.equal(result.lockRetained, true);
  assert.deepEqual(events, [
    'health:draining:timeout',
    'stop-new-work:ai-media',
    'drain:ai-media',
    'drain:background',
    'health:failed:shutdown_incomplete',
  ]);
});

test('database close failure retains execution authority until fail-fast process exit', async () => {
  const events = [];
  const closeError = new Error('pool did not close');
  const processRuntime = await startRoleProcess({
    expectedRole: 'scheduler',
    entrypoint: 'server/scheduler-process.js',
    prepareIndependent: async () => ({
      roleConfig: { role: 'scheduler' },
      lockHandle: {
        heldRoles: ['scheduler'],
        async release() {
          events.push('release-lock');
        },
      },
    }),
    runtimeStarters: {
      scheduler: async () => createRoleRuntime('scheduler', events),
    },
    createHealth: () => createHealth(events),
    onLockLost() {},
    closeDatabase: async () => {
      events.push('close-db');
      throw closeError;
    },
    backgroundWork: createBackgroundWork(events),
    logger: quietLogger(),
  });

  events.length = 0;
  const result = await processRuntime.stop({ reason: 'SIGTERM', timeoutMs: 10 });
  assert.equal(result.drained, false);
  assert.strictEqual(result.closeError, closeError);
  assert.equal(result.lockRetained, true);
  assert.deepEqual(events, [
    'health:draining:SIGTERM',
    'stop-new-work:scheduler',
    'drain:scheduler',
    'drain:background',
    'close-db',
    'health:failed:shutdown_incomplete',
  ]);
});
