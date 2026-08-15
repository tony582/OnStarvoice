import assert from 'node:assert/strict';
import test from 'node:test';

import {
  startAiCronJobs,
  startCronJobs,
  startSchedulerCronJobs,
} from '../server/cron.js';
import {createDrainController} from '../server/runtime/drain-controller.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise, resolve, reject};
}

function createFakeCron() {
  const registrations = [];
  return {
    registrations,
    schedule(expression, callback, options) {
      const task = {
        stopCalls: 0,
        destroyCalls: 0,
        fire: () => callback(),
        stop() {
          this.stopCalls += 1;
        },
        destroy() {
          this.destroyCalls += 1;
        },
      };
      registrations.push({expression, callback, options, task});
      return task;
    },
  };
}

function quietLogger() {
  return {log() {}, error() {}};
}

function safeJobs(overrides = {}) {
  return {
    async compactOldCaptureTaskTechnicalHistory() {
      return {rootCount: 0, deletedSnapshotCount: 0};
    },
    async enqueueDueCaptureOrchestrations() {
      return [];
    },
    async enqueueDueProfilePatrolTasks() {
      return [];
    },
    async generateDailyReport() {},
    async generateMonthlyReport() {},
    async generateWeeklyReport() {},
    async getSetting() {
      return '';
    },
    async labelPendingRecords() {
      return {total: 0, labeled: 0};
    },
    async processCaptureAttentionNotifications() {
      return {
        claimed: 0,
        sent: 0,
        retry_wait: 0,
        blocked_config: 0,
        failed: 0,
        worker_error: 0,
      };
    },
    async queryAll() {
      return [];
    },
    async reconcileAutomaticCaptureRetries() {
      return {dispatched: 0, waitingForAgent: 0, manualOnly: 0, failed: 0};
    },
    async reconcileElasticCaptureLeases() {
      return {requeued: 0};
    },
    async reconcilePendingCaptureCommands() {
      return {commandCount: 0};
    },
    ...overrides,
  };
}

test('drain controller exposes the Node 18 compatible bounded lifecycle contract', async () => {
  const work = deferred();
  let timeoutCallback;
  let timeoutDelay;
  const cleared = [];
  const controller = createDrainController({
    setTimer(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 42;
    },
    clearTimer(handle) {
      cleared.push(handle);
    },
  });

  const running = controller.run(() => work.promise);
  assert.equal(controller.inFlightCount, 1);
  assert.equal(controller.stopAccepting(), true);
  assert.equal(controller.stopAccepting(), false);

  let skippedCalls = 0;
  assert.equal(await controller.run(() => { skippedCalls += 1; }), undefined);
  assert.equal(skippedCalls, 0);

  const waiting = controller.waitForIdle({timeoutMs: 123});
  assert.equal(timeoutDelay, 123);
  timeoutCallback();
  assert.deepEqual(await waiting, {
    drained: false,
    timedOut: true,
    pending: 1,
  });
  assert.deepEqual(cleared, [42]);

  work.resolve('done');
  assert.equal(await running, 'done');
  assert.equal(controller.inFlightCount, 0);
  assert.deepEqual(await controller.waitForIdle({timeoutMs: 1}), {
    drained: true,
    timedOut: false,
    pending: 0,
  });
});

test('scheduler cron owns only scheduler work and every task is non-overlapping', async () => {
  const fakeCron = createFakeCron();
  let reconcileCalls = 0;
  let patrolCalls = 0;
  const runtime = startSchedulerCronJobs({
    cronModule: fakeCron,
    logger: quietLogger(),
    jobs: safeJobs({
      async reconcilePendingCaptureCommands() {
        reconcileCalls += 1;
        return {commandCount: 0};
      },
      async enqueueDueProfilePatrolTasks(limit) {
        patrolCalls += 1;
        assert.equal(limit, 20);
        return [];
      },
    }),
  });

  assert.deepEqual(
    fakeCron.registrations.map(item => item.expression),
    ['17 3 * * *', '*/5 * * * *', '* * * * *', '* * * * *'],
  );
  assert.deepEqual(
    fakeCron.registrations.map(item => item.options.name),
    [
      'onstarvoice:capture-task-retention',
      'onstarvoice:profile-patrol',
      'onstarvoice:capture-orchestration-recovery',
      'onstarvoice:capture-attention-notifications',
    ],
  );
  assert.ok(fakeCron.registrations.every(item => item.options.noOverlap === true));
  assert.ok(fakeCron.registrations.every(item => !/ai|report/u.test(item.options.name)));

  await fakeCron.registrations[1].task.fire();
  assert.equal(reconcileCalls, 1);
  assert.equal(patrolCalls, 1);

  assert.equal(runtime.stop(), true);
  assert.equal(runtime.stop(), false);
  assert.ok(fakeCron.registrations.every(item => item.task.stopCalls === 1));
  assert.deepEqual(await runtime.drain({timeoutMs: 5}), {
    name: 'cron:scheduler',
    drained: true,
    timedOut: false,
    pending: 0,
  });
  assert.equal(runtime.destroy(), true);
  assert.equal(runtime.destroy(), false);
  assert.ok(fakeCron.registrations.every(item => item.task.destroyCalls === 1));
});

test('AI cron owns batch labeling and configured reports only', async () => {
  const fakeCron = createFakeCron();
  let labelingLimit = 0;
  let tenantQueries = 0;
  const runtime = startAiCronJobs({
    cronModule: fakeCron,
    logger: quietLogger(),
    jobs: safeJobs({
      async labelPendingRecords(limit) {
        labelingLimit = limit;
        return {total: 0, labeled: 0};
      },
      async queryAll() {
        tenantQueries += 1;
        return [];
      },
    }),
  });

  assert.deepEqual(
    fakeCron.registrations.map(item => [item.expression, item.options.name]),
    [
      ['*/10 * * * *', 'onstarvoice:batch-ai-labeling'],
      ['* * * * *', 'onstarvoice:configured-reports'],
    ],
  );
  assert.ok(fakeCron.registrations.every(item => item.options.noOverlap === true));

  await fakeCron.registrations[0].task.fire();
  await fakeCron.registrations[1].task.fire();
  assert.equal(labelingLimit, 20);
  assert.equal(tenantQueries, 1);
  runtime.destroy();
});

test('cron drain stops new work, times out safely, then observes eventual idle', async () => {
  const fakeCron = createFakeCron();
  const work = deferred();
  let retentionCalls = 0;
  const runtime = startSchedulerCronJobs({
    cronModule: fakeCron,
    logger: quietLogger(),
    jobs: safeJobs({
      async compactOldCaptureTaskTechnicalHistory() {
        retentionCalls += 1;
        return work.promise;
      },
    }),
  });

  const running = fakeCron.registrations[0].task.fire();
  const timedOut = await runtime.drain({timeoutMs: 5});
  assert.deepEqual(timedOut, {
    name: 'cron:scheduler',
    drained: false,
    timedOut: true,
    pending: 1,
  });
  assert.equal(runtime.snapshot().inFlight, 1);
  assert.ok(fakeCron.registrations.every(item => item.task.stopCalls === 1));

  await fakeCron.registrations[0].task.fire();
  assert.equal(retentionCalls, 1, 'stopped cron runtime accepted new work');

  work.resolve({rootCount: 0, deletedSnapshotCount: 0});
  await running;
  assert.deepEqual(await runtime.drain({timeoutMs: 5}), {
    name: 'cron:scheduler',
    drained: true,
    timedOut: false,
    pending: 0,
  });
  assert.equal(runtime.destroy(), true);
  assert.equal(runtime.destroy(), false);
});

test('compatibility cron composes both groups without duplicate lifecycle calls', async () => {
  const fakeCron = createFakeCron();
  const messages = [];
  const runtime = startCronJobs({
    cronModule: fakeCron,
    logger: {
      log(message) {
        messages.push(message);
      },
      error() {},
    },
    jobs: safeJobs(),
  });

  assert.equal(fakeCron.registrations.length, 6);
  assert.deepEqual(runtime.runtimes.map(item => item.groupName), ['scheduler', 'ai']);
  assert.deepEqual(messages, ['[Cron] Scheduled jobs started']);
  assert.equal(runtime.stop(), true);
  assert.equal(runtime.stop(), false);
  assert.ok(fakeCron.registrations.every(item => item.task.stopCalls === 1));
  assert.equal((await runtime.drain({timeoutMs: 5})).drained, true);
  assert.equal(runtime.destroy(), true);
  assert.equal(runtime.destroy(), false);
  assert.ok(fakeCron.registrations.every(item => item.task.destroyCalls === 1));
});
