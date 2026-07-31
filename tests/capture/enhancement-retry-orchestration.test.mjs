import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectRetryableEnhancementRecordIds,
  mergeEnhancementAttemptResults,
  runEnhancementWithSingleRetry,
} from '../../utils/capture/enhancement-retry.js';

function detailResult(items = [], overrides = {}) {
  const results = items.map((item) => ({...item}));
  const successCount = results.filter((item) => item.ok === true).length;
  const failedCount = results.filter((item) => item.ok === false).length;
  return {
    ok: failedCount === 0,
    canceled: false,
    runnerInterrupted: false,
    securityBlocked: false,
    total: results.length,
    processedCount: results.length,
    successCount,
    failedCount,
    filteredCount: 0,
    skippedCount: 0,
    results,
    ...overrides,
  };
}

function transientFailure(recordId, reason = 'PAGE_OPEN_TIMEOUT') {
  return {
    recordId,
    ok: false,
    reason,
    category: 'page_failed',
    stage: reason === 'COMMENTS_CAPTURE_FAILED' ? 'comments_capture' : 'navigation',
  };
}

function successful(recordId, extra = {}) {
  return {
    recordId,
    ok: true,
    reason: 'none',
    ...extra,
  };
}

test('transient enhancement failure runs exactly two total attempts and records recovery metadata', async () => {
  const calls = [];
  const scheduled = [];
  let waits = 0;
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['record-ok', 'record-retry'],
    runAttempt: async (recordIds, {attempt}) => {
      calls.push({recordIds: [...recordIds], attempt});
      return calls.length === 1
        ? detailResult([
            successful('record-ok', {payloadVersion: 'first'}),
            transientFailure('record-retry'),
          ])
        : detailResult([
            successful('record-retry', {payloadVersion: 'retry'}),
          ]);
    },
    onRetryScheduled: async (metadata) => {
      scheduled.push(metadata);
    },
    waitBeforeRetry: async () => {
      waits += 1;
    },
    shouldStop: () => false,
  });

  assert.equal(calls.length, 2, 'one initial attempt plus one retry only');
  assert.deepEqual(calls[0].recordIds, ['record-ok', 'record-retry']);
  assert.deepEqual(calls[1].recordIds, ['record-retry']);
  assert.equal(calls[0].attempt, 1);
  assert.equal(calls[1].attempt, 2);
  assert.equal(scheduled.length, 1);
  assert.equal(waits, 1);
  assert.equal(result.ok, true);
  assert.equal(result.successCount, 2);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(
    result.results.map((item) => [item.recordId, item.ok, item.payloadVersion]),
    [
      ['record-ok', true, 'first'],
      ['record-retry', true, 'retry'],
    ],
  );
  assert.equal(result.autoRetryAttempted, true);
  assert.equal(result.autoRetryCount, 1);
  assert.deepEqual(result.autoRetryRecordIds, ['record-retry']);
  assert.deepEqual(result.autoRetryRecoveredIds, ['record-retry']);
});

test('a second transient failure is terminal after exactly two total attempts', async () => {
  const calls = [];
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['record-retry'],
    runAttempt: async (recordIds, {attempt}) => {
      calls.push({recordIds: [...recordIds], attempt});
      return detailResult([
        transientFailure(
          'record-retry',
          calls.length === 1 ? 'PAGE_OPEN_FAILED' : 'NOTE_CAPTURE_FAILED',
        ),
      ]);
    },
    waitBeforeRetry: async () => undefined,
    shouldStop: () => false,
  });

  assert.equal(calls.length, 2, 'retry budget must not grow after retry failure');
  assert.deepEqual(calls[1].recordIds, ['record-retry']);
  assert.equal(result.ok, false);
  assert.equal(result.successCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].reason, 'NOTE_CAPTURE_FAILED');
  assert.equal(result.autoRetryAttempted, true);
  assert.equal(result.autoRetryCount, 1);
  assert.deepEqual(result.autoRetryRecordIds, ['record-retry']);
  assert.deepEqual(result.autoRetryRecoveredIds, []);
});

test('retry classifier accepts transient stages and rejects permanent or unsafe failures', () => {
  const transientCodes = [
    'PAGE_OPEN_TIMEOUT',
    'PAGE_OPEN_FAILED',
    'NOTE_CAPTURE_FAILED',
    'COMMENTS_CAPTURE_FAILED',
    'BLOGGER_METRICS_FAILED',
    'UNEXPECTED_ERROR',
    'UNKNOWN',
    'CONTEXT_INTERRUPTED',
    'RUNNER_INTERRUPTED',
  ];
  const permanentCodes = [
    'CONTENT_UNAVAILABLE',
    'LINK_MISSING',
    'INVALID_RECORD',
    'CANCELED',
    'DETAIL_CAPTURE_CANCELED',
    'XHS_SECURITY_BLOCK',
    'IDENTITY_MISMATCH',
    'DOUYIN_DETAIL_ID_MISMATCH',
    'DOUYIN_COMMENT_ID_MISMATCH',
    'DOUYIN_COMMENT_ID_CONFLICT',
  ];
  const input = [
    ...transientCodes.map((reason, index) =>
      transientFailure(`transient-${index}`, reason),
    ),
    ...permanentCodes.map((reason, index) => ({
      recordId: `permanent-${index}`,
      ok: false,
      reason,
        category:
          reason.includes('CANCELED')
            ? 'user_canceled'
            : reason.includes('IDENTITY') || reason.includes('ID_')
              ? 'integrity_blocked'
            : 'page_failed',
      securityBlocked: reason === 'XHS_SECURITY_BLOCK',
    })),
    successful('already-successful'),
    {ok: false, reason: 'PAGE_OPEN_TIMEOUT'},
  ];

  assert.deepEqual(
    collectRetryableEnhancementRecordIds(detailResult(input)),
    transientCodes.map((_, index) => `transient-${index}`),
  );
});

test('permanent, security and user cancellation results never retry', async () => {
  const scenarios = [
    detailResult([
      {
        recordId: 'permanent',
        ok: false,
        reason: 'CONTENT_UNAVAILABLE',
        category: 'page_failed',
      },
    ]),
    detailResult([transientFailure('security')], {
      securityBlocked: true,
    }),
    detailResult([transientFailure('canceled')], {
      canceled: true,
    }),
    detailResult(
      [
        transientFailure('earlier-transient'),
        {
          ...transientFailure('identity-stop', 'IDENTITY_MISMATCH'),
          integrityBlocked: true,
          fatal: true,
          stopBatch: true,
        },
      ],
      {
        integrityBlocked: true,
        fatal: true,
        stopBatch: true,
      },
    ),
  ];

  for (const [index, firstResult] of scenarios.entries()) {
    let callCount = 0;
    let scheduleCount = 0;
    let waitCount = 0;
    const result = await runEnhancementWithSingleRetry({
      recordIds: firstResult.results.map((item) => item.recordId),
      runAttempt: async () => {
        callCount += 1;
        return firstResult;
      },
      onRetryScheduled: async () => {
        scheduleCount += 1;
      },
      waitBeforeRetry: async () => {
        waitCount += 1;
      },
      shouldStop: () => false,
    });

    assert.equal(callCount, 1, `scenario ${index} must not run attempt two`);
    assert.equal(scheduleCount, 0);
    assert.equal(waitCount, 0);
    assert.equal(result.autoRetryAttempted, false);
    assert.equal(result.autoRetryCount, 0);
    assert.deepEqual(result.autoRetryRecordIds, []);
    assert.deepEqual(result.autoRetryRecoveredIds, []);
  }
});

test('runner interruption exits the old batch and starts one fresh attempt exactly once', async () => {
  const calls = [];
  const pipelineInstances = [];
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['runner-record'],
    runAttempt: async (recordIds, metadata) => {
      const pipeline = {id: Symbol(`pipeline-${metadata.attempt}`)};
      pipelineInstances.push(pipeline);
      calls.push({recordIds: [...recordIds], ...metadata, pipeline});
      return metadata.attempt === 1
        ? detailResult(
            [transientFailure('runner-record', 'CONTEXT_INTERRUPTED')],
            {
              ok: false,
              runnerInterrupted: true,
              error: {code: 'CONTEXT_INTERRUPTED'},
            },
          )
        : detailResult([successful('runner-record', {pipeline: 'fresh'})]);
    },
    waitBeforeRetry: async () => undefined,
    shouldStop: () => false,
  });

  assert.equal(calls.length, 2, 'old runner exits before one fresh retry');
  assert.equal(calls[0].attempt, 1);
  assert.equal(calls[0].isRetry, false);
  assert.equal(calls[1].attempt, 2);
  assert.equal(calls[1].isRetry, true);
  assert.notEqual(
    pipelineInstances[0],
    pipelineInstances[1],
    'the retry callback creates a new pipeline instance',
  );
  assert.deepEqual(calls[1].recordIds, ['runner-record']);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].pipeline, 'fresh');
  assert.equal(result.autoRetryAttempted, true);
  assert.equal(result.autoRetryCount, 1);
  assert.deepEqual(result.autoRetryRecoveredIds, ['runner-record']);
  assert.equal(result.runnerInterrupted, false);
  assert.equal(result.recoveryRequired, false);
  assert.equal(result.autoRetryInitialRunnerInterrupted, true);
  assert.equal(result.autoRetryInitialRecoveryRequired, true);
});

test('runner recovery prepares a fresh persistent context before attempt two', async () => {
  const order = [];
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['runner-record'],
    runAttempt: async (recordIds, metadata) => {
      order.push(`attempt-${metadata.attempt}`);
      return metadata.attempt === 1
        ? detailResult(
            [transientFailure('runner-record', 'CONTEXT_INTERRUPTED')],
            {
              ok: false,
              runnerInterrupted: true,
              recoveryRequired: true,
              error: {code: 'RUNNER_TAB_UNAVAILABLE'},
            },
          )
        : detailResult(recordIds.map((recordId) => successful(recordId)));
    },
    prepareRetry: async (metadata) => {
      assert.equal(metadata.requiresContextRebuild, true);
      assert.equal(metadata.initialFailureCode, 'RUNNER_TAB_UNAVAILABLE');
      order.push('prepare-context');
    },
  });

  assert.deepEqual(order, ['attempt-1', 'prepare-context', 'attempt-2']);
  assert.equal(result.ok, true);
  assert.equal(result.autoRetryCount, 1);
});

test('context preparation failure settles every retry item without a hidden third attempt', async () => {
  let attemptCount = 0;
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['setup-a', 'setup-b'],
    runAttempt: async () => {
      attemptCount += 1;
      return detailResult([], {
        ok: false,
        runnerInterrupted: true,
        recoveryRequired: true,
        error: {code: 'TASK_TAB_GROUP_UNAVAILABLE'},
      });
    },
    prepareRetry: async () => {
      const error = new Error('旧采集上下文仍在清理');
      error.code = 'TASK_TAB_GROUP_UNAVAILABLE';
      throw error;
    },
  });

  assert.equal(attemptCount, 1, 'failed preparation must not start a dead runner');
  assert.equal(result.autoRetryAttempted, true);
  assert.equal(result.autoRetryPreparationFailed, true);
  assert.equal(result.failedCount, 2);
  assert.equal(result.processedCount, 2);
  assert.deepEqual(
    result.results.map((item) => item.recordId),
    ['setup-a', 'setup-b'],
  );
  assert.ok(
    result.results.every(
      (item) =>
        item.ok === false &&
        item.reason === 'TASK_TAB_GROUP_UNAVAILABLE',
    ),
  );
});

test('top-level runner interruption with empty results retries fallback unfinished record ids', async () => {
  const calls = [];
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['unfinished-a', 'unfinished-b'],
    runAttempt: async (recordIds, metadata) => {
      calls.push({recordIds: [...recordIds], ...metadata});
      return metadata.attempt === 1
        ? detailResult([], {
            ok: false,
            runnerInterrupted: true,
            error: {code: 'RUNNER_INTERRUPTED'},
          })
        : detailResult(recordIds.map((recordId) => successful(recordId)));
    },
    waitBeforeRetry: async () => undefined,
    shouldStop: () => false,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].recordIds, ['unfinished-a', 'unfinished-b']);
  assert.equal(calls[1].attempt, 2);
  assert.equal(calls[1].isRetry, true);
  assert.equal(result.ok, true);
  assert.equal(result.successCount, 2);
  assert.deepEqual(result.autoRetryRecordIds, ['unfinished-a', 'unfinished-b']);
  assert.deepEqual(result.autoRetryRecoveredIds, [
    'unfinished-a',
    'unfinished-b',
  ]);
});

test('merge replaces only retried records and preserves first-attempt order and terminal flags', () => {
  const first = detailResult(
    [
      successful('record-a', {source: 'first'}),
      transientFailure('record-b'),
      transientFailure('record-c', 'COMMENTS_CAPTURE_FAILED'),
    ],
    {diagnostics: {stageTrace: ['first']}},
  );
  const retry = detailResult(
    [
      successful('record-b', {source: 'retry'}),
      transientFailure('record-c', 'BLOGGER_METRICS_FAILED'),
    ],
    {diagnostics: {stageTrace: ['retry']}},
  );

  const merged = mergeEnhancementAttemptResults({
    initialResult: first,
    retryResult: retry,
    retryRecordIds: ['record-b', 'record-c'],
  });

  assert.deepEqual(
    merged.results.map((item) => [item.recordId, item.ok, item.source || item.reason]),
    [
      ['record-a', true, 'first'],
      ['record-b', true, 'retry'],
      ['record-c', false, 'BLOGGER_METRICS_FAILED'],
    ],
  );
  assert.equal(merged.ok, false);
  assert.equal(merged.total, 3);
  assert.equal(merged.processedCount, 3);
  assert.equal(merged.successCount, 2);
  assert.equal(merged.failedCount, 1);
});

test('merge preserves an identity-integrity stop raised by the retry attempt', () => {
  const first = detailResult(
    [transientFailure('record-a')],
    {
      ok: false,
      runnerInterrupted: true,
      recoveryRequired: true,
    },
  );
  const retry = detailResult(
    [
      {
        ...transientFailure('record-a', 'IDENTITY_MISMATCH'),
        integrityBlocked: true,
        fatal: true,
        stopBatch: true,
      },
    ],
    {
      ok: false,
      integrityBlocked: true,
      fatal: true,
      stopBatch: true,
    },
  );

  const merged = mergeEnhancementAttemptResults({
    initialResult: first,
    retryResult: retry,
    retryRecordIds: ['record-a'],
  });

  assert.equal(merged.ok, false);
  assert.equal(merged.integrityBlocked, true);
  assert.equal(merged.fatal, true);
  assert.equal(merged.stopBatch, true);
});

test('runner setup failures retry every unresolved record with a fresh second attempt', async () => {
  const setupCodes = [
    'RUNNER_TAB_UNAVAILABLE',
    'TASK_TAB_GROUP_UNAVAILABLE',
    'TAB_NOT_FOUND',
  ];

  for (const code of setupCodes) {
    const calls = [];
    const result = await runEnhancementWithSingleRetry({
      recordIds: ['setup-a', 'setup-b'],
      runAttempt: async (recordIds, metadata) => {
        calls.push({recordIds: [...recordIds], ...metadata});
        return metadata.attempt === 1
          ? detailResult([], {
              ok: false,
              error: {code, message: `${code} first attempt`},
            })
          : detailResult(recordIds.map((recordId) => successful(recordId)));
      },
    });

    assert.equal(calls.length, 2, `${code} receives exactly one retry`);
    assert.deepEqual(calls[1].recordIds, ['setup-a', 'setup-b']);
    assert.equal(result.ok, true);
    assert.equal(result.failedCount, 0);
    assert.equal(result.runnerInterrupted, false);
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.autoRetryInitialRunnerInterrupted, true);
    assert.equal(result.autoRetryInitialRecoveryRequired, true);
  }
});

test('runner fallback excludes successful, filtered, already captured and permanent records', () => {
  const result = detailResult(
    [
      successful('success'),
      successful('filtered', {
        filtered: true,
        reason: 'ai_relevance_filtered',
      }),
      successful('captured', {
        skipped: true,
        reason: 'already_captured',
      }),
      {
        recordId: 'permanent',
        ok: false,
        reason: 'CONTENT_UNAVAILABLE',
        category: 'page_failed',
      },
      transientFailure('transient'),
    ],
    {
      ok: false,
      runnerInterrupted: true,
      recoveryRequired: true,
      error: {code: 'RUNNER_INTERRUPTED'},
    },
  );

  assert.deepEqual(
    collectRetryableEnhancementRecordIds(result, {
      fallbackRecordIds: [
        'success',
        'filtered',
        'captured',
        'permanent',
        'transient',
        'unresolved',
      ],
    }),
    ['transient', 'unresolved'],
  );
});

test('a thrown first attempt is converted to failures and retried once', async () => {
  const lifecycle = [];
  const calls = [];
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['throw-a', 'throw-b'],
    runAttempt: async (recordIds, metadata) => {
      calls.push({recordIds: [...recordIds], ...metadata});
      if (metadata.attempt === 1) {
        const error = new Error('first attempt crashed');
        error.code = 'UNEXPECTED_ERROR';
        throw error;
      }
      return detailResult(recordIds.map((recordId) => successful(recordId)));
    },
    onRetryScheduled: async () => lifecycle.push('scheduled'),
    waitBeforeRetry: async () => lifecycle.push('waited'),
    onRetryStarted: async () => lifecycle.push('started'),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].recordIds, ['throw-a', 'throw-b']);
  assert.deepEqual(lifecycle, ['scheduled', 'waited', 'started']);
  assert.equal(result.ok, true);
  assert.equal(result.autoRetryScheduled, true);
  assert.equal(result.autoRetryAttempted, true);
  assert.deepEqual(result.autoRetryRecoveredIds, ['throw-a', 'throw-b']);
});

test('a thrown retry is terminal, explicit and preserves unresolved recovery state', async () => {
  const calls = [];
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['retry-throws'],
    runAttempt: async (recordIds, metadata) => {
      calls.push({recordIds: [...recordIds], ...metadata});
      if (metadata.attempt === 1) {
        return detailResult([transientFailure('retry-throws')]);
      }
      const error = new Error('worker registration failed again');
      error.code = 'TASK_TAB_GROUP_UNAVAILABLE';
      throw error;
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.failedCount, 1);
  assert.equal(result.processedCount, 1);
  assert.equal(result.results[0].recordId, 'retry-throws');
  assert.equal(result.results[0].reason, 'TASK_TAB_GROUP_UNAVAILABLE');
  assert.equal(result.runnerInterrupted, true);
  assert.equal(result.recoveryRequired, true);
  assert.deepEqual(result.autoRetryStillFailedIds, ['retry-throws']);
});

test('missing retry outputs become explicit failures instead of success zero failure zero', async () => {
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['returned', 'missing'],
    runAttempt: async (recordIds, metadata) =>
      metadata.attempt === 1
        ? detailResult(recordIds.map((recordId) => transientFailure(recordId)))
        : detailResult([successful('returned')]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.processedCount, 2);
  assert.deepEqual(
    result.results.map((item) => [item.recordId, item.ok, item.reason]),
    [
      ['returned', true, 'none'],
      ['missing', false, 'RETRY_RESULT_MISSING'],
    ],
  );
  assert.equal(result.error.code, 'RETRY_RESULT_MISSING');
  assert.equal(result.runnerInterrupted, true);
  assert.equal(result.recoveryRequired, true);
  assert.deepEqual(result.autoRetryStillFailedIds, ['missing']);
});

test('scheduled retry does not count as started when stop arrives during the wait', async () => {
  const lifecycle = [];
  let stopped = false;
  let attempts = 0;
  const result = await runEnhancementWithSingleRetry({
    recordIds: ['stop-during-wait'],
    runAttempt: async () => {
      attempts += 1;
      return detailResult([transientFailure('stop-during-wait')]);
    },
    shouldStop: () => stopped,
    onRetryScheduled: async () => lifecycle.push('scheduled'),
    waitBeforeRetry: async () => {
      lifecycle.push('waited');
      stopped = true;
    },
    onRetryStarted: async () => lifecycle.push('started'),
  });

  assert.equal(attempts, 1);
  assert.deepEqual(lifecycle, ['scheduled', 'waited']);
  assert.equal(result.autoRetryScheduled, true);
  assert.equal(result.autoRetryAttempted, false);
  assert.equal(result.autoRetryCount, 0);
  assert.equal(result.autoRetrySkippedReason, 'stopped_during_retry_wait');
});
