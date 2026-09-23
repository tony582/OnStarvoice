import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startAndroidControlHarness} from '../../../tests/integration/postgres/android-control-harness.mjs';
import {setupRunner} from '../src/daemon/setup.mjs';
import {readConfig} from '../src/daemon/state.mjs';
import {AndroidDaemon} from '../src/daemon/runtime.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';

test('real HTTP auth + PostgreSQL lineage + SQLite runner complete two discovery keywords', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'android-real-control-'));
  let daemon;
  let running;
  let store;
  t.after(async () => {
    daemon?.requestStop();
    await running;
    store?.close();
    rmSync(directory, {recursive: true, force: true});
  });
  const {origin, tenantId, code, operator, query} = await startAndroidControlHarness(t);
  // Genuine test activation code, real tenant-admin session and real agent bearer auth.
  // The only simulated component is the phone UI adapter.
  await setupRunner({stateDir: directory, baseUrl: origin, deviceId: `SIMULATED-${randomUUID()}`,
    code, simulation: true});
  const config = readConfig(directory);
  const {run} = await operator('/runs', {method: 'POST', body: {requestId: randomUUID(), agentId: config.agentId}});
  store = new RunnerStore(join(directory, 'runner.sqlite'));
  daemon = new AndroidDaemon({stateDir: directory, store, lockRoot: join(directory, 'locks'),
    pollMs: 10, deliveryMs: 10, watchMs: 10});
  running = daemon.run();
  let result;
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    result = await operator(`/runs/${run.id}`);
    if (result.run.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(result.run.status, 'completed', JSON.stringify(store.loadCheckpoint('daemon:status')?.value));
  daemon.requestStop();
  await running;
  const events = await query('SELECT * FROM capture_discovery_events WHERE tenant_id=$1', [tenantId]);
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map(event => event.item_id)).size, 2);
  assert.ok(events.every(event => event.delivery_mode === 'normal'));
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.quarantinedCount(), 0);
  assert.equal((await query('SELECT * FROM records WHERE tenant_id=$1', [tenantId])).length, 0);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(item => item.status === 'completed'));
});
