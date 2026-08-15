import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareCompatibilityProcess } from '../server/runtime/compatibility-process.js';

function createLockHandle(events) {
  let releasePromise;
  return Object.freeze({
    role: 'all',
    backendPid: 4242,
    heldRoles: Object.freeze(['scheduler', 'ai-media']),
    release() {
      events.push('release-locks');
      releasePromise ||= Promise.resolve();
      return releasePromise;
    },
  });
}

function dependencies(events, overrides = {}) {
  const lockHandle = overrides.lockHandle || createLockHandle(events);
  return {
    env: {
      NODE_ENV: 'production',
      PROCESS_ROLE: 'all',
      DATABASE_URL: 'postgresql://must-not-be-logged.invalid/onstarvoice',
      PG_CONNECT_TIMEOUT_MS: '4321',
    },
    logger: {
      info: message => events.push(`info:${message}`),
      warn: message => events.push(`warn:${message}`),
      error: message => events.push(`error:${message}`),
    },
    onLockLost() {},
    resolveRole(options) {
      events.push('resolve-role');
      assert.equal(options.entrypoint, 'server/index.js');
      return Object.freeze({ role: 'all', source: 'environment', warnings: [] });
    },
    async acquireLocks(options) {
      events.push('acquire-locks');
      assert.equal(options.role, 'all');
      assert.equal(options.connectionTimeoutMillis, '4321');
      assert.equal(typeof options.onLockLost, 'function');
      return lockHandle;
    },
    async initializeDatabase() {
      events.push('init-db');
    },
    async closeDatabase() {
      events.push('close-db');
    },
    ...overrides,
  };
}

test('compatibility preparation validates, fences, then initializes the database', async () => {
  const events = [];
  const runtime = await prepareCompatibilityProcess(dependencies(events));

  assert.equal(runtime.roleConfig.role, 'all');
  assert.equal(runtime.lockHandle.backendPid, 4242);
  assert.deepEqual(events.slice(0, 3), [
    'resolve-role',
    'acquire-locks',
    'init-db',
  ]);
  assert.match(events[3], /^info:\[ProcessRole\] role=all /u);
  assert.doesNotMatch(events.join('\n'), /must-not-be-logged/u);
});

test('role rejection happens before lock, database, and later startup responsibilities', async () => {
  const events = [];
  const options = dependencies(events, {
    resolveRole() {
      events.push('resolve-role');
      const error = new Error('role rejected');
      error.code = 'PROCESS_ROLE_REQUIRED';
      throw error;
    },
  });

  await assert.rejects(prepareCompatibilityProcess(options), /role rejected/u);
  assert.deepEqual(events, ['resolve-role']);
});

test('lock rejection happens before database initialization', async () => {
  const events = [];
  const options = dependencies(events, {
    async acquireLocks() {
      events.push('acquire-locks');
      const error = new Error('role lock unavailable');
      error.code = 'PROCESS_ROLE_LOCK_UNAVAILABLE';
      throw error;
    },
  });

  await assert.rejects(prepareCompatibilityProcess(options), /role lock unavailable/u);
  assert.deepEqual(events, ['resolve-role', 'acquire-locks']);
});

test('database initialization failure releases locks before any background startup', async () => {
  const events = [];
  const options = dependencies(events, {
    async initializeDatabase() {
      events.push('init-db');
      throw new Error('database initialization failed');
    },
  });

  await assert.rejects(
    prepareCompatibilityProcess(options),
    /database initialization failed/u,
  );
  assert.deepEqual(events, [
    'resolve-role',
    'acquire-locks',
    'init-db',
    'close-db',
    'release-locks',
  ]);
});

test('compatibility preparation requires a fail-closed lock-loss handler', async () => {
  const events = [];
  const options = dependencies(events);
  delete options.onLockLost;

  await assert.rejects(
    prepareCompatibilityProcess(options),
    /onLockLost is required for the compatibility process/u,
  );
  assert.deepEqual(events, []);
});
