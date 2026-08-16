import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createAutomaticCaptureRetryReconciler,
} from '../server/modules/capture/application/automatic-recovery.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise, resolve, reject};
}

function successfulDependencies(overrides = {}) {
  let requestNumber = 0;
  return {
    async listCandidates() {
      return [];
    },
    async dispatchRetry() {
      return {error: 'task_not_settled_for_retry'};
    },
    createRequestKey() {
      requestNumber += 1;
      return `request-${requestNumber}`;
    },
    formatErrorMessage(message) {
      return String(message || '').slice(0, 240);
    },
    ...overrides,
  };
}

test('automatic recovery reconciler requires every application port', () => {
  for (const dependency of [
    'listCandidates',
    'dispatchRetry',
    'createRequestKey',
    'formatErrorMessage',
  ]) {
    const dependencies = successfulDependencies();
    delete dependencies[dependency];
    assert.throws(
      () => createAutomaticCaptureRetryReconciler(dependencies),
      new RegExp(`${dependency} must be a function`, 'u'),
    );
  }
});

test('automatic recovery reconciler preserves candidate limit normalization', async () => {
  const limits = [];
  const reconcile = createAutomaticCaptureRetryReconciler(
    successfulDependencies({
      async listCandidates(limit) {
        limits.push(limit);
        return [];
      },
    }),
  );

  for (const limit of [
    undefined,
    0,
    Number.NaN,
    -8,
    800,
    '12',
  ]) {
    assert.deepEqual(await reconcile(limit), {
      scanned: 0,
      dispatched: 0,
      waitingForAgent: 0,
      manualOnly: 0,
      skipped: 0,
      failed: 0,
      results: [],
    });
  }
  assert.deepEqual(limits, [10, 10, 10, 1, 50, 12]);
});

test('automatic recovery propagates candidate listing failures without dispatch', async () => {
  let dispatchCalls = 0;
  let requestKeyCalls = 0;
  const reconcile = createAutomaticCaptureRetryReconciler(
    successfulDependencies({
      async listCandidates() {
        throw new Error('candidate query failed');
      },
      async dispatchRetry() {
        dispatchCalls += 1;
        return {};
      },
      createRequestKey() {
        requestKeyCalls += 1;
        return 'unexpected';
      },
    }),
  );

  await assert.rejects(reconcile(), /candidate query failed/u);
  assert.equal(dispatchCalls, 0);
  assert.equal(requestKeyCalls, 0);
});

test('automatic recovery preserves serial allocation and revision progression', async () => {
  const sequence = [];
  const responses = [
    {
      child: {id: 'retry-a-1'},
      parent: {orchestration_revision: 4},
      itemCount: 1,
    },
    {
      child: {id: 'retry-a-2'},
      parent: {orchestration_revision: 5},
      itemCount: 2,
    },
    {error: 'idle_compatible_agent_unavailable'},
    {existing: true, child: {id: 'retry-b-existing'}, itemCount: 3},
  ];
  let requestNumber = 0;
  const reconcile = createAutomaticCaptureRetryReconciler({
    async listCandidates(limit) {
      sequence.push(`list:${limit}`);
      return [
        {id: 'task-a', tenant_id: 'tenant-a', orchestration_revision: 3},
        {id: 'task-b', tenant_id: 'tenant-b', orchestration_revision: 9},
      ];
    },
    async dispatchRetry(options) {
      sequence.push([
        options.taskId,
        options.expectedRevision,
        options.requestKey,
        options.actorType,
        options.requestedByName,
        options.automatic,
      ]);
      return responses.shift();
    },
    createRequestKey() {
      requestNumber += 1;
      return `request-${requestNumber}`;
    },
    formatErrorMessage(message) {
      return String(message || '');
    },
  });

  assert.deepEqual(await reconcile(2), {
    scanned: 2,
    dispatched: 2,
    waitingForAgent: 1,
    manualOnly: 0,
    skipped: 0,
    failed: 0,
    results: [
      {
        taskId: 'task-a',
        action: 'dispatched',
        retryTaskId: 'retry-a-1',
        itemCount: 1,
      },
      {
        taskId: 'task-a',
        action: 'dispatched',
        retryTaskId: 'retry-a-2',
        itemCount: 2,
      },
      {taskId: 'task-a', action: 'idle_compatible_agent_unavailable'},
      {
        taskId: 'task-b',
        action: 'existing',
        retryTaskId: 'retry-b-existing',
        itemCount: 3,
      },
    ],
  });
  assert.deepEqual(sequence, [
    'list:2',
    ['task-a', 3, 'request-1', 'system', '自动调度中心', true],
    ['task-a', 4, 'request-2', 'system', '自动调度中心', true],
    ['task-a', 5, 'request-3', 'system', '自动调度中心', true],
    ['task-b', 9, 'request-4', 'system', '自动调度中心', true],
  ]);
});

test('automatic recovery keeps the per-candidate allocation cap at thirty', async () => {
  let dispatchCalls = 0;
  const reconcile = createAutomaticCaptureRetryReconciler(
    successfulDependencies({
      async listCandidates() {
        return [{id: 'task-a', tenant_id: 'tenant-a'}];
      },
      async dispatchRetry() {
        dispatchCalls += 1;
        return {
          child: {id: `retry-${dispatchCalls}`},
          parent: {orchestration_revision: dispatchCalls},
          itemCount: 1,
        };
      },
    }),
  );

  const summary = await reconcile();
  assert.equal(dispatchCalls, 30);
  assert.equal(summary.scanned, 1);
  assert.equal(summary.dispatched, 30);
  assert.equal(summary.results.length, 30);
  assert.equal(summary.results.at(-1).retryTaskId, 'retry-30');
});

test('automatic recovery preserves waiting, manual-only, and skipped outcomes', async () => {
  const errors = [
    'idle_compatible_agent_unavailable',
    'retry_requires_manual_safety_action',
    'automatic_retry_disabled',
    'retry_items_not_automatically_recoverable',
    'revision_conflict',
  ];
  const reconcile = createAutomaticCaptureRetryReconciler(
    successfulDependencies({
      async listCandidates() {
        return errors.map((error, index) => ({
          id: `task-${index}`,
          tenant_id: 'tenant-a',
          error,
        }));
      },
      async dispatchRetry({taskId}) {
        const index = Number(taskId.split('-').at(-1));
        return {error: errors[index]};
      },
    }),
  );

  const summary = await reconcile();
  assert.equal(summary.scanned, 5);
  assert.equal(summary.waitingForAgent, 1);
  assert.equal(summary.manualOnly, 3);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.failed, 0);
  assert.deepEqual(
    summary.results.map(result => result.action),
    errors,
  );
});

test('automatic recovery forwards scope and preserves configured dispatch context', async () => {
  const listed = [];
  const dispatched = [];
  const reconcile = createAutomaticCaptureRetryReconciler(
    successfulDependencies({
      async listCandidates(limit, options) {
        listed.push({limit, options});
        return [{id: 'task-a', tenant_id: 'tenant-a'}];
      },
      async dispatchRetry(options) {
        dispatched.push(options);
        return {
          child: {id: `retry-${dispatched.length}`},
          parent: {orchestration_revision: dispatched.length},
          itemCount: 1,
        };
      },
    }),
  );

  const input = {
    limit: 7,
    tenantId: 'tenant-a',
    taskIds: ['task-a'],
    maxDispatchesPerTask: 2,
    requestedByName: '值守 Agent',
  };
  const summary = await reconcile(input);

  assert.deepEqual(listed, [{limit: 7, options: input}]);
  assert.equal(summary.scanned, 1);
  assert.equal(summary.dispatched, 2);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched.every(call => call.requestedByName === '值守 Agent'), true);
  assert.equal(dispatched.every(call => call.automatic === true), true);
});

test('automatic recovery preserves conflict and worker error classification', async () => {
  const formatted = [];
  const failures = [
    Object.assign(new Error('manual'), {
      crossDeviceRetryError: 'retry_requires_manual_safety_action',
    }),
    Object.assign(new Error('item conflict'), {
      code: 'cross_device_retry_item_conflict',
    }),
    Object.assign(new Error('revision conflict'), {
      code: 'cross_device_retry_revision_conflict',
    }),
    new Error('database unavailable'),
  ];
  const reconcile = createAutomaticCaptureRetryReconciler(
    successfulDependencies({
      async listCandidates() {
        return failures.map((failure, index) => ({
          id: `task-${index}`,
          tenant_id: 'tenant-a',
          failure,
        }));
      },
      async dispatchRetry({taskId}) {
        throw failures[Number(taskId.split('-').at(-1))];
      },
      formatErrorMessage(message) {
        formatted.push(message);
        return `safe:${message}`;
      },
    }),
  );

  const summary = await reconcile();
  assert.equal(summary.manualOnly, 0);
  assert.equal(summary.skipped, 3);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.results, [
    {taskId: 'task-0', action: 'retry_requires_manual_safety_action'},
    {taskId: 'task-1', action: 'cross_device_retry_item_conflict'},
    {taskId: 'task-2', action: 'cross_device_retry_revision_conflict'},
    {
      taskId: 'task-3',
      action: 'worker_error',
      message: 'safe:database unavailable',
    },
  ]);
  assert.deepEqual(formatted, ['database unavailable']);
});

test('overlapping automatic recovery runs remain independent', async () => {
  const firstCandidates = deferred();
  const limits = [];
  const reconcile = createAutomaticCaptureRetryReconciler(
    successfulDependencies({
      async listCandidates(limit) {
        limits.push(limit);
        return limits.length === 1 ? firstCandidates.promise : [];
      },
    }),
  );

  const first = reconcile(7);
  const overlapping = reconcile(42);
  await Promise.resolve();
  assert.deepEqual(limits, [7, 42]);
  firstCandidates.resolve([]);
  const empty = {
    scanned: 0,
    dispatched: 0,
    waitingForAgent: 0,
    manualOnly: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };
  assert.deepEqual(await Promise.all([first, overlapping]), [empty, empty]);
});

test('automatic recovery module is route and Express independent', () => {
  const source = readFileSync(
    path.join(
      repositoryRoot,
      'server',
      'modules',
      'capture',
      'application',
      'automatic-recovery.js',
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"][^'"]*routes\//u);
  assert.doesNotMatch(source, /from ['"]express['"]/u);
  assert.doesNotMatch(source, /\bRouter\s*\(/u);
  assert.doesNotMatch(source, /\b(?:req|res)\s*\./u);
  assert.doesNotMatch(source, /\b(?:queryAll|withTransaction)\b/u);
});
