import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareIndependentProcess } from '../server/runtime/independent-process.js';

test('independent API preparation resolves its role, acquires no role-lock responsibility, then connects', async () => {
  const events = [];
  const lockHandle = {
    heldRoles: [],
    async release() {
      events.push('release-lock');
    },
  };
  const onLockLost = () => {};

  const prepared = await prepareIndependentProcess({
    expectedRole: 'api',
    entrypoint: 'server/api-process.js',
    env: { PROCESS_ROLE: 'api' },
    resolveRole(options) {
      events.push('resolve-role');
      assert.equal(options.expectedRole, 'api');
      return { role: 'api', source: 'test' };
    },
    async acquireLocks(options) {
      events.push('acquire-locks');
      assert.equal(options.role, 'api');
      assert.strictEqual(options.onLockLost, onLockLost);
      return lockHandle;
    },
    async connectDatabase() {
      events.push('connect-db');
    },
    onLockLost,
  });

  assert.deepEqual(events, ['resolve-role', 'acquire-locks', 'connect-db']);
  assert.deepEqual(prepared.roleConfig, { role: 'api', source: 'test' });
  assert.strictEqual(prepared.lockHandle, lockHandle);
  assert.deepEqual(prepared.lockHandle.heldRoles, []);
});

test('role validation failure happens before lock acquisition and database connection', async () => {
  const roleError = new Error('PROCESS_ROLE mismatch');
  let acquireCalled = false;
  let connectCalled = false;

  await assert.rejects(
    prepareIndependentProcess({
      expectedRole: 'scheduler',
      entrypoint: 'server/scheduler-process.js',
      resolveRole() {
        throw roleError;
      },
      acquireLocks: async () => {
        acquireCalled = true;
      },
      connectDatabase: async () => {
        connectCalled = true;
      },
      onLockLost() {},
    }),
    roleError,
  );

  assert.equal(acquireCalled, false);
  assert.equal(connectCalled, false);
});

test('database startup failure releases the acquired role lock', async () => {
  const events = [];
  const databaseError = new Error('database unavailable');

  await assert.rejects(
    prepareIndependentProcess({
      expectedRole: 'ai-media',
      entrypoint: 'server/ai-media-process.js',
      resolveRole: () => ({ role: 'ai-media' }),
      acquireLocks: async () => ({
        heldRoles: ['ai-media'],
        async release() {
          events.push('release-lock');
        },
      }),
      connectDatabase: async () => {
        events.push('connect-db');
        throw databaseError;
      },
      closeDatabase: async () => {
        events.push('close-db');
      },
      onLockLost() {},
    }),
    databaseError,
  );

  assert.deepEqual(events, ['connect-db', 'close-db', 'release-lock']);
});

test('invalid independent role and missing lock-loss callback fail closed', async () => {
  await assert.rejects(
    prepareIndependentProcess({
      expectedRole: 'all',
      entrypoint: 'server/index.js',
      onLockLost() {},
    }),
    /expectedRole must be api, scheduler, or ai-media/,
  );

  await assert.rejects(
    prepareIndependentProcess({
      expectedRole: 'api',
      entrypoint: 'server/api-process.js',
    }),
    /onLockLost is required/,
  );
});
