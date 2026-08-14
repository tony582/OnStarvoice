import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { acquireProcessRoleLocks } from '../server/runtime/process-role-locks.js';

class FakeLockClient extends EventEmitter {
  constructor({ failHeartbeat = false } = {}) {
    super();
    this.failHeartbeat = failHeartbeat;
    this.processID = null;
    this.queries = [];
    this.heartbeatCalls = 0;
    this.unlockCalls = 0;
    this.endCalls = 0;
  }

  async connect() {
    this.processID = 4242;
  }

  async query(config) {
    this.queries.push(config);
    if (/pg_try_advisory_lock/u.test(config.text)) {
      return { rows: [{ acquired: true }] };
    }
    if (/process_role_lock_heartbeat/u.test(config.text)) {
      this.heartbeatCalls += 1;
      if (this.failHeartbeat) throw new Error('simulated heartbeat timeout');
      return { rows: [{ process_role_lock_heartbeat: 1 }] };
    }
    if (/pg_advisory_unlock/u.test(config.text)) {
      this.unlockCalls += 1;
      return { rows: [{ released: true }] };
    }
    throw new Error('unexpected fake PostgreSQL query');
  }

  async end() {
    this.endCalls += 1;
    queueMicrotask(() => this.emit('end'));
  }
}

function waitForPromise(promise, timeoutMs = 1000) {
  let timeout;
  const timed = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('timed out waiting for lock event')), timeoutMs);
  });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timeout));
}

test('heartbeat failure closes the lock session and notifies exactly once', async () => {
  const client = new FakeLockClient({ failHeartbeat: true });
  let clientOptions;
  let resolveLockLost;
  const lockLost = new Promise(resolve => { resolveLockLost = resolve; });
  const notifications = [];

  const handle = await acquireProcessRoleLocks({
    role: 'scheduler',
    databaseUrl: 'postgresql://local-test.invalid/onstarvoice_test',
    connectionTimeoutMillis: 13,
    queryTimeoutMillis: 7,
    heartbeatIntervalMillis: 5,
    keepAliveInitialDelayMillis: 11,
    logger: { error() {} },
    onLockLost(details) {
      notifications.push(details);
      resolveLockLost(details);
    },
    createClient(options) {
      clientOptions = options;
      return client;
    },
  });

  const details = await waitForPromise(lockLost);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(details.event, 'heartbeat');
  assert.match(details.error.message, /simulated heartbeat timeout/u);
  assert.deepEqual(details.heldRoles, ['scheduler']);
  assert.equal(details.backendPid, 4242);
  assert.equal(notifications.length, 1);
  assert.equal(client.heartbeatCalls, 1);
  assert.equal(client.endCalls, 1);
  assert.equal(clientOptions.connectionTimeoutMillis, 13);
  assert.equal(clientOptions.keepAlive, true);
  assert.equal(clientOptions.keepAliveInitialDelayMillis, 11);
  assert.deepEqual(client.queries.map(query => query.query_timeout), [7, 7]);

  const firstRelease = handle.release();
  assert.strictEqual(handle.release(), firstRelease);
  await firstRelease;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(client.heartbeatCalls, 1, 'a lost lock must not schedule another heartbeat');
  assert.equal(client.endCalls, 1, 'release must reuse the in-flight close operation');
  assert.equal(notifications.length, 1);
});

test('normal release clears the heartbeat before unlocking and closing', async () => {
  const client = new FakeLockClient();
  let lockLosses = 0;
  const handle = await acquireProcessRoleLocks({
    role: 'scheduler',
    queryTimeoutMillis: 25,
    heartbeatIntervalMillis: 40,
    keepAliveInitialDelayMillis: 10,
    logger: { error() {} },
    onLockLost() {
      lockLosses += 1;
    },
    createClient() {
      return client;
    },
  });

  await handle.release();
  await new Promise(resolve => setTimeout(resolve, 80));

  assert.equal(client.heartbeatCalls, 0);
  assert.equal(client.unlockCalls, 1);
  assert.equal(client.endCalls, 1);
  assert.equal(lockLosses, 0);
  assert.deepEqual(client.queries.map(query => query.query_timeout), [25, 25]);
});

test('lock timing controls reject zero instead of disabling fail-closed bounds', async () => {
  const common = {
    role: 'scheduler',
    onLockLost() {},
    createClient() {
      throw new Error('client must not be created for invalid timing');
    },
  };

  for (const [name, message] of [
    ['connectionTimeoutMillis', /connectionTimeoutMillis must be a positive integer/u],
    ['queryTimeoutMillis', /queryTimeoutMillis must be a positive integer/u],
    ['heartbeatIntervalMillis', /heartbeatIntervalMillis must be a positive integer/u],
    ['keepAliveInitialDelayMillis', /keepAliveInitialDelayMillis must be a positive integer/u],
  ]) {
    await assert.rejects(
      acquireProcessRoleLocks({ ...common, [name]: 0 }),
      message,
    );
  }
});
