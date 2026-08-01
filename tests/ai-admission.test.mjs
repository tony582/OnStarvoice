import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AI_QUEUE_TIMEOUT_MS,
  DEFAULT_AI_TENANT_CONCURRENCY,
  TenantAiAdmissionController,
} from '../server/services/ai-admission.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('tenant AI admission has one shared six-request ceiling by default', () => {
  assert.equal(DEFAULT_AI_TENANT_CONCURRENCY, 6);
  assert.equal(DEFAULT_AI_QUEUE_TIMEOUT_MS, 120000);
  const controller = new TenantAiAdmissionController();
  assert.deepEqual(controller.snapshot('tenant-a'), {
    tenantId: 'tenant-a',
    limit: 6,
    active: 0,
    queued: 0,
    queuedByPriority: {
      capture: 0,
      interactive: 0,
      normal: 0,
      background: 0,
    },
    oldestWaitMs: 0,
  });
});

test('capture requests pass queued background work without exceeding the limit', async () => {
  const controller = new TenantAiAdmissionController({concurrency: 1});
  const blocker = deferred();
  const order = [];
  const first = controller.run('tenant-a', async () => {
    order.push('active-background');
    await blocker.promise;
  }, {priority: 'background', kind: 'comment_refine'});
  await nextTurn();

  const normal = controller.run('tenant-a', async () => {
    order.push('normal');
  }, {priority: 'normal'});
  const capture = controller.run('tenant-a', async () => {
    order.push('capture');
  }, {priority: 'capture'});
  await nextTurn();
  assert.equal(controller.snapshot('tenant-a').active, 1);
  assert.equal(controller.snapshot('tenant-a').queued, 2);

  blocker.resolve();
  await Promise.all([first, normal, capture]);
  assert.deepEqual(order, ['active-background', 'capture', 'normal']);
  assert.equal(controller.snapshot('tenant-a').active, 0);
});

test('different tenants have independent admission ceilings', async () => {
  const controller = new TenantAiAdmissionController({concurrency: 1});
  const left = deferred();
  const right = deferred();
  let active = 0;
  let peak = 0;
  const run = (tenantId, gate) => controller.run(tenantId, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
  });
  const first = run('tenant-a', left);
  const second = run('tenant-b', right);
  await nextTurn();
  assert.equal(peak, 2);
  assert.equal(controller.snapshot('tenant-a').active, 1);
  assert.equal(controller.snapshot('tenant-b').active, 1);
  left.resolve();
  right.resolve();
  await Promise.all([first, second]);
});

test('timed-out waiters leave no queue residue or active-slot leak', async () => {
  let timeoutCallback = null;
  const controller = new TenantAiAdmissionController({
    concurrency: 1,
    setTimer(callback) {
      timeoutCallback = callback;
      return 1;
    },
    clearTimer() {},
  });
  const admission = await controller.acquire('tenant-a');
  const queued = controller.acquire('tenant-a', {
    priority: 'background',
    queueTimeoutMs: 1000,
  });
  assert.equal(controller.snapshot('tenant-a').queued, 1);
  timeoutCallback();
  await assert.rejects(
    queued,
    error => error?.code === 'AI_ADMISSION_QUEUE_TIMEOUT',
  );
  assert.equal(controller.snapshot('tenant-a').active, 1);
  assert.equal(controller.snapshot('tenant-a').queued, 0);
  controller.release(admission.tenantId);
  assert.equal(controller.snapshot('tenant-a').active, 0);
});

test('operation errors always release their tenant slot', async () => {
  const controller = new TenantAiAdmissionController({concurrency: 1});
  await assert.rejects(
    controller.run('tenant-a', async () => {
      throw new Error('model failed');
    }),
    /model failed/u,
  );
  assert.equal(controller.snapshot('tenant-a').active, 0);
});
