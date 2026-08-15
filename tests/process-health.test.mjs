import assert from 'node:assert/strict';
import test from 'node:test';

import { createProcessHealth } from '../server/runtime/process-health.js';

test('process health keeps liveness separate from opt-in readiness', () => {
  const health = createProcessHealth({ role: 'api', uptime: () => 42.5 });

  assert.deepEqual(health.getLegacyHealth(), {
    ok: true,
    version: '0.1.0',
    uptime: 42.5,
  });
  assert.deepEqual(health.getLiveness(), {
    ok: true,
    status: 'live',
    version: '0.1.0',
    role: 'api',
    uptime: 42.5,
  });
  assert.deepEqual(health.getReadiness(), {
    ok: false,
    status: 'not_ready',
    version: '0.1.0',
    role: 'api',
    uptime: 42.5,
    reason: 'initializing',
  });

  assert.deepEqual(health.markReady(), {
    ok: true,
    status: 'ready',
    version: '0.1.0',
    role: 'api',
    uptime: 42.5,
  });
  assert.equal(health.getLiveness().ok, true);

  assert.equal(health.markDraining().reason, 'draining');
  assert.equal(health.getLiveness().ok, true);
  assert.equal(health.markFailed('database_unavailable').reason, 'database_unavailable');
  assert.equal(health.getReadiness().ok, false);
  assert.equal(health.getLiveness().ok, false);
  assert.equal(health.markStopped().reason, 'stopped');
  assert.equal(health.getLiveness().reason, 'stopped');
});

test('process health exposes immutable snapshots and rejects unsafe metadata', () => {
  const health = createProcessHealth({ role: 'scheduler', uptime: () => Number.NaN });
  const snapshot = health.getReadiness();

  assert.equal(Object.isFrozen(health), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.uptime, 0);
  assert.throws(
    () => health.markFailed('postgres://secret@database'),
    /machine-readable code/u,
  );
  assert.throws(
    () => createProcessHealth({ role: 'worker' }),
    /supported process role/u,
  );
  assert.throws(
    () => createProcessHealth({ version: '' }),
    /non-empty string/u,
  );
});

test('readiness probes dependencies without changing process liveness', async () => {
  let databaseReady = true;
  const health = createProcessHealth({
    role: 'api',
    uptime: () => 7,
    readinessProbe: async () => databaseReady,
    readinessFailureReason: 'database_unavailable',
  });

  await health.markReady();
  assert.equal((await health.getReadiness()).ok, true);

  databaseReady = false;
  assert.deepEqual(await health.getReadiness(), {
    ok: false,
    status: 'not_ready',
    version: '0.1.0',
    role: 'api',
    uptime: 7,
    reason: 'database_unavailable',
  });
  assert.equal(health.getLiveness().ok, true);

  databaseReady = true;
  assert.equal((await health.getReadiness()).ok, true);
});
