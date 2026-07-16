import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDetailPrefetchPipeline,
  DETAIL_WORKER_STATE,
} from '../../utils/capture/detail-prefetch-pipeline.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {promise, resolve, reject};
}

function createPipeline(overrides = {}) {
  return createDetailPrefetchPipeline({
    workerTabs: [
      {tabId: 101, label: 'A'},
      {tabId: 102, label: 'B'},
    ],
    minNavigationGapMs: 0,
    navigate: async () => undefined,
    ...overrides,
  });
}

test('never promotes two workers into COLLECTING at the same time', async () => {
  const pipeline = createPipeline();
  const firstLease = await pipeline.acquire({recordId: 'r1', url: 'https://x/r1'});
  const prefetch = pipeline.prefetch({recordId: 'r2', url: 'https://x/r2'});

  assert.equal(prefetch.started, true);
  assert.equal(
    pipeline.snapshot().slots.find((slot) => slot.tabId === 102).state,
    DETAIL_WORKER_STATE.QUEUED,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overlappingSnapshot = pipeline.snapshot();
  assert.equal(
    overlappingSnapshot.slots.find((slot) => slot.tabId === 101).state,
    DETAIL_WORKER_STATE.COLLECTING,
  );
  assert.equal(
    overlappingSnapshot.slots.find((slot) => slot.tabId === 102).state,
    DETAIL_WORKER_STATE.READY,
  );
  await assert.rejects(
    pipeline.acquire({recordId: 'r2', url: 'https://x/r2'}),
    (error) => error?.code === 'detail_worker_active_lease',
  );
  assert.equal(
    pipeline
      .snapshot()
      .slots.filter((slot) => slot.state === DETAIL_WORKER_STATE.COLLECTING)
      .length,
    1,
  );

  assert.equal(pipeline.release({...firstLease, leaseId: firstLease.leaseId + 1}), false);
  assert.equal(pipeline.release(firstLease), true);
  const secondLease = await pipeline.acquire({recordId: 'r2', url: 'https://x/r2'});
  assert.equal(secondLease.prefetched, true);
  assert.equal(secondLease.tabId, 102);
  assert.equal(pipeline.release(secondLease), true);
});

test('applies one shared minimum gap to worker navigations', async () => {
  const starts = [];
  const pipeline = createPipeline({
    minNavigationGapMs: 35,
    navigate: async ({tabId}) => {
      starts.push({tabId, at: Date.now()});
    },
  });

  const firstLease = await pipeline.acquire({recordId: 'r1', url: 'https://x/r1'});
  pipeline.prefetch(
    {recordId: 'r2', url: 'https://x/r2'},
    {excludeTabId: firstLease.tabId},
  );
  assert.equal(pipeline.release(firstLease), true);
  const secondLease = await pipeline.acquire({recordId: 'r2', url: 'https://x/r2'});

  assert.equal(starts.length, 2);
  assert.ok(starts[1].at - starts[0].at >= 30, JSON.stringify(starts));
  assert.equal(pipeline.release(secondLease), true);
});

test('serializes external profile navigation through the same worker pacer', async () => {
  const starts = [];
  const pipeline = createPipeline({
    minNavigationGapMs: 35,
    navigate: async ({tabId}) => {
      starts.push({kind: `worker:${tabId}`, at: Date.now()});
    },
  });

  const lease = await pipeline.acquire({recordId: 'r1', url: 'https://x/r1'});
  await pipeline.runExternalNavigation(async () => {
    starts.push({kind: 'profile', at: Date.now()});
  });

  assert.equal(starts.length, 2);
  assert.ok(starts[1].at - starts[0].at >= 30, JSON.stringify(starts));
  assert.equal(pipeline.release(lease), true);
});

test('discard invalidates a late prefetch result', async () => {
  const secondNavigation = deferred();
  const pipeline = createPipeline({
    navigate: async ({recordId}) => {
      if (recordId === 'r2') await secondNavigation.promise;
    },
  });
  const firstLease = await pipeline.acquire({recordId: 'r1', url: 'https://x/r1'});
  pipeline.prefetch(
    {recordId: 'r2', url: 'https://x/r2'},
    {excludeTabId: firstLease.tabId},
  );

  assert.equal(pipeline.discard({recordId: 'r2', url: 'https://x/r2'}), true);
  secondNavigation.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondSlot = pipeline.snapshot().slots.find((slot) => slot.tabId === 102);
  assert.equal(secondSlot.state, DETAIL_WORKER_STATE.IDLE);
  assert.equal(secondSlot.recordId, '');
  assert.equal(pipeline.release(firstLease), true);
});

test('fatal navigation failures stop the pipeline', async () => {
  const fatal = new Error('触发安全限制 300013');
  fatal.code = 'XHS_SECURITY_BLOCK';
  const pipeline = createPipeline({
    navigate: async () => {
      throw fatal;
    },
  });

  await assert.rejects(
    pipeline.acquire({recordId: 'r1', url: 'https://x/r1'}),
    (error) => error === fatal,
  );
  assert.equal(pipeline.getFatalError(), fatal);
  assert.equal(pipeline.snapshot().stopped, true);
  assert.equal(pipeline.prefetch({recordId: 'r2', url: 'https://x/r2'}).started, false);
});

test('a standby fatal is exposed while the current lease is still collecting', async () => {
  const fatal = new Error('standby challenge 300013');
  fatal.code = 'XHS_SECURITY_BLOCK';
  const transitions = [];
  const pipeline = createPipeline({
    onTransition: (transition) => transitions.push(transition),
    navigate: async ({recordId}) => {
      if (recordId === 'r2') throw fatal;
    },
  });

  const firstLease = await pipeline.acquire({recordId: 'r1', url: 'https://x/r1'});
  pipeline.prefetch(
    {recordId: 'r2', url: 'https://x/r2'},
    {excludeTabId: firstLease.tabId},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(pipeline.getFatalError(), fatal);
  assert.equal(pipeline.snapshot().stopped, true);
  assert.equal(
    pipeline.snapshot().slots.find((slot) => slot.tabId === firstLease.tabId).state,
    DETAIL_WORKER_STATE.COLLECTING,
  );
  const fatalTransition = transitions.find(
    (transition) => transition.type === 'navigation_failed',
  );
  assert.equal(fatalTransition.snapshot.activeTabId, firstLease.tabId);
  assert.equal(pipeline.release(firstLease), true);
});

test('fatal external navigation failures stop both worker lanes', async () => {
  const fatal = new Error('risk challenge page');
  fatal.code = 'PAGE_CHALLENGE_BLOCK';
  const pipeline = createPipeline();

  await assert.rejects(
    pipeline.runExternalNavigation(async () => {
      throw fatal;
    }),
    (error) => error === fatal,
  );
  assert.equal(pipeline.getFatalError(), fatal);
  assert.equal(pipeline.snapshot().stopped, true);
  assert.equal(pipeline.prefetch({recordId: 'r2', url: 'https://x/r2'}).started, false);
});

test('stop is bounded even when a navigation promise never settles', async () => {
  const hanging = deferred();
  const pipeline = createPipeline({
    stopTimeoutMs: 100,
    navigate: async () => hanging.promise,
  });
  const acquisition = pipeline
    .acquire({recordId: 'r1', url: 'https://x/r1'})
    .catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const startedAt = Date.now();
  await pipeline.stop();
  assert.ok(Date.now() - startedAt < 350);
  assert.equal(pipeline.snapshot().stopped, true);

  hanging.resolve();
  await acquisition;
});
