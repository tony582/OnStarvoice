import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerStore } from '../src/storage/runner-store.mjs';
import { runDiscoveryTask } from '../src/core/discovery-runner.mjs';
import { validateCopiedShare } from '../src/device/clipboard.mjs';
import { fixtureTask, fixtureClock, fixturePermit, fixtureDevice } from './core-fixtures.mjs';

test('runner marker interoperates with the real device clipboard evidence validator', async () => {
  const task = fixtureTask();
  const clock = fixtureClock();
  const store = new RunnerStore(':memory:');
  let observedMarker;
  try {
    const { device } = fixtureDevice(task, { copyLink: async ({ marker, detail }) => {
      observedMarker = marker;
      const evidence = validateCopiedShare({ marker, beforeText: marker,
        afterText: `新壁纸 https://www.douyin.com/note/${detail.externalId}`,
        expectedExternalId: detail.externalId });
      assert.equal(evidence.ok, true);
      return { ...evidence, detailId: detail.detailId };
    } });
    const result = await runDiscoveryTask({ task, store, clock, device, permit: fixturePermit(task, clock) });
    assert.match(observedMarker, /^starvoice-discovery:[0-9a-f-]{36}$/);
    assert.equal(result.status, 'completed');
    assert.equal(store.nextBatch().events[0].verification, 'verified');
  } finally { store.close(); }
});
