import assert from 'node:assert/strict';
import test from 'node:test';

import { createProcessBackgroundWorkRegistry } from '../server/runtime/process-background-work.js';

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('background drain includes child work registered by an already-running parent', async () => {
  const registry = createProcessBackgroundWorkRegistry();
  const parentGate = deferred();
  const events = [];

  const parent = registry.run(async () => {
    events.push('parent:start');
    await parentGate.promise;
    void registry.schedule(async () => {
      events.push('child');
    });
    events.push('parent:end');
  });
  await new Promise(resolve => setImmediate(resolve));

  const draining = registry.drain({ timeoutMs: 1000 });
  parentGate.resolve();
  await parent;

  assert.deepEqual(await draining, {
    drained: true,
    timedOut: false,
    pending: 0,
  });
  assert.deepEqual(events, ['parent:start', 'parent:end', 'child']);
  assert.deepEqual(registry.snapshot(), { draining: true, inFlight: 0 });

  let lateCalls = 0;
  assert.equal(await registry.run(() => { lateCalls += 1; }), undefined);
  assert.equal(lateCalls, 0);
});

test('timed-out background work remains observable and can finish before a later drain', async () => {
  const registry = createProcessBackgroundWorkRegistry();
  const gate = deferred();
  const pending = registry.run(() => gate.promise);

  const timedOut = await registry.drain({ timeoutMs: 5 });
  assert.equal(timedOut.drained, false);
  assert.equal(timedOut.pending, 1);
  assert.equal(registry.snapshot().inFlight, 1);

  gate.resolve();
  await pending;
  assert.deepEqual(await registry.drain({ timeoutMs: 100 }), {
    drained: true,
    timedOut: false,
    pending: 0,
  });

  let lateCalls = 0;
  assert.equal(await registry.run(() => { lateCalls += 1; }), undefined);
  assert.equal(lateCalls, 0, 'a successful retry must close background-work admission');
});
