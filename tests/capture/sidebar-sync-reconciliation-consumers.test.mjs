import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {hasSyncReconciliationSignal, buildSyncReconciliationError} from '../../utils/capture/sync-reconciliation-state.js';
import {isUnattendedSafetyBlock, summarizeUnattendedKeywordCheckpoint} from '../../utils/unattended-keyword-run.js';

// Run actual post-capture consumer sections, including their catches, terminal
// closure, and target-loop guards. Capture/network/browser/clock are seams.
// These tests do not start a worker/browser or establish server replay safety.
const sidebar = readFileSync(new URL('../../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
const targetedSource = readFileSync(new URL('../../utils/cloud-targeted-post.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const canonicalError = () => buildSyncReconciliationError();
class FixtureDate extends Date {
  constructor(...args) {super(...(args.length ? args : ['2026-09-06T00:00:00.000Z']));}
  static now() {return Date.parse('2026-09-06T00:00:00.000Z');}
}

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing actual source marker: ${start}`);
  assert.equal(source.indexOf(start, from + start.length), -1, `ambiguous source marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ending source marker: ${end}`);
  return source.slice(from, to);
}

const unattended = section(sidebar, 'async function runUnattendedKeywordPlanRequest(request)', 'async function runCaptureAction({');
const unattendedOutcome = section(unattended, '    if (!batchRunResult?.started) {', '\n  } catch (error) {');
const unattendedCatch = section(unattended, '    console.error("[Sidebar] Unattended keyword plan failed:", error);', '\n  } finally {');
const terminalClosure = section(unattended, '  const createTerminalProgress = ({', '\n  if (!isCurrentRequestAttempt()) {');
const terminalHelpers = section(sidebar, 'function buildUnattendedTaskCounts(', 'function createUnattendedKeywordCheckpointReporter(');
const targeted = section(sidebar, 'async function maybeClaimAndRunTargetedPostWorkflow()', 'async function maybeClaimAndRunUnattendedKeywordPlan(');
const targetLatch = section(targeted, '  let targetedSyncReconciliationRequired =', '\n  let stopTargetedPostHeartbeat =');
const targetLoopStart = section(targeted, '    let targetResults = Array.isArray(request.targetResults)', '\n      const startedAt =');
const targetLoopTail = section(targeted, '      targetedSyncReconciliationRequired =', '\n    }\n\n    if (!isActiveTargetedPostInvocation(invocationToken)) {');
const targetFinal = section(targeted, '\n    if (!isActiveTargetedPostInvocation(invocationToken)) {\n      throw createTargetedPostInvocationError();\n    }\n    const checkpoint =', '\n  } catch (error) {');
const targetCatch = section(targeted, '    stopTargetedPostHeartbeat();\n    await flushTargetedBusinessProgress();\n    console.error("[Sidebar] Targeted post workflow failed:", error);', '\n  } finally {');
const innerBatch = section(sidebar, 'async function handleBatchKeywordCapture(options = {})', 'function activateUnattendedRunRequest(');
const innerBatchCatch = section(innerBatch, '    console.error("[Sidebar] Batch keyword capture failed:", error);', '\n  } finally {');
const innerBatchFinally = section(innerBatch, '    const ownsBatchInvocation = () =>', '\n    const shouldEndCaptureTaskSession =');
const drainSource = section(sidebar, 'async function drainStreamingDetailSyncQueue(', 'async function handleBatchKeywordCapture(');

function closedSync(overrides = {}) {
  return {
    enabled: true, drainCompleted: true, enqueuedCount: 2, processedCount: 2,
    successCount: 2, failedCount: 0, skippedCount: 0, pendingCount: 0,
    activeCount: 0, remainingCount: 0, capturedUniqueCount: 2,
    enqueuedUniqueCount: 2, excludedUniqueCount: 0, succeededUniqueCount: 2,
    blocked: false, canceled: false,
    ...overrides,
  };
}

function outcome(overrides = {}) {
  return {started: true, ok: true, totalSuccess: 1, totalFailed: 0,
    streamingSync: closedSync(), ...overrides};
}

function unattendedBridge(batchRunResult = outcome(), overrides = {}) {
  const reports = [], messages = [], ended = [], released = [];
  const context = vm.createContext({
    Date: FixtureDate,
    hasSyncReconciliationSignal, buildSyncReconciliationError,
    isUnattendedSafetyBlock, summarizeUnattendedKeywordCheckpoint,
    batchRunResult, requestId: 'request-a', requestAttemptId: 'attempt-a',
    request: {cloudAssigned: false}, plannedTaskTotal: 1, plannedRounds: 1,
    checkpoint: {activeKeyword: 'keyword-a', keywordResults: [{keyword: 'keyword-a', status: 'completed', savedCount: 2}]},
    keywords: ['keyword-a'], resumeKeyword: 'keyword-a',
    startingProgress: {keyword: 'keyword-a'}, reportKeywordProgress: null,
    runStartedAt: '2026-09-06T00:00:00.000Z',
    sequentialSearchEnabled: false, executionCopy: {taskLabel: '隔离采集'},
    unattendedCaptureTaskStatus: 'running', unattendedCaptureTaskError: null,
    unattendedCaptureTaskTerminalProgress: null,
    unattendedCaptureTaskContext: {taskId: 'task-a'},
    unattendedCaptureTaskSessionStarted: true,
    activeUnattendedAttemptRejected: false, capturePipelineStarted: true,
    activeCaptureTaskCancellationReason: 'user_cancel_requested',
    resolveUnattendedCancellationTerminal: () => ({status: 'canceled', message: 'fixture cancellation', error: null}),
    reportUnattendedTerminalRun: async (id, payload, options) => {reports.push(plain({id, payload, options}));},
    endCaptureTaskSession: async value => {ended.push(plain(value)); return {ok: true};},
    releaseCaptureTaskOwner: id => released.push(id),
    showMessage: (message, tone) => messages.push({message, tone}),
    console: {error() {}},
    ...overrides,
  });
  vm.runInContext(`${terminalHelpers}\n${terminalClosure}
    globalThis.runOutcome = async () => {
      try { ${unattendedOutcome} } catch (error) { ${unattendedCatch} }
    };
    globalThis.runCaught = async (error) => { ${unattendedCatch} };`, context, {timeout: 5000});
  return {context, reports, messages, ended, released};
}

function assertVerificationReport(bridge) {
  assert.equal(bridge.reports.length, 1);
  const report = bridge.reports[0];
  assert.equal(report.id, 'request-a');
  assert.deepEqual(report.options, {attemptId: 'attempt-a'});
  assert.equal(report.payload.status, 'needs_action');
  assert.deepEqual(report.payload.error, canonicalError());
  assert.equal(report.payload.progress.streamingSyncEvidenceKnown, false);
  assert.equal(report.payload.progress.streamingSyncDrainCompleted, false);
  assert.equal(report.payload.progress.syncReconciliationRequired, true);
  assert.equal(bridge.context.unattendedCaptureTaskStatus, 'needs_action');
  assert.deepEqual(bridge.ended, []);
  assert.deepEqual(bridge.released, []);
  assert.doesNotMatch(report.payload.message, /交回云端|接力|解除.*锁定/);
  return report.payload;
}

test('unattended ordinary completion keeps its completed status and valid upload evidence', async () => {
  const bridge = unattendedBridge();
  await bridge.context.runOutcome();
  assert.equal(bridge.reports.length, 1);
  assert.equal(bridge.reports[0].payload.status, 'completed');
  assert.equal(bridge.reports[0].payload.progress.streamingSyncEvidenceKnown, true);
  assert.equal(bridge.reports[0].payload.progress.streamingSyncDrainCompleted, true);
  assert.equal('error' in bridge.reports[0].payload, false);
});

test('unattended explicit top-level hold without an error cannot become a completed run', async () => {
  const input = outcome({ok: false, reconciliationRequired: true});
  const before = plain(input);
  const bridge = unattendedBridge(input);
  await bridge.context.runOutcome();
  assertVerificationReport(bridge);
  assert.deepEqual(input, before, 'the closure override must copy, not mutate received sync facts');
});

test('unattended exact local-confirmation error avoids ordinary Error stringification', async () => {
  const bridge = unattendedBridge(outcome({ok: false, error: {code: 'LOCAL_CONFIRMATION_REQUIRED', message: 'retained receipt'}}));
  await bridge.context.runOutcome();
  assertVerificationReport(bridge);
});

test('unattended hold wins over ok true and otherwise fully-cleared upload counters', async () => {
  const bridge = unattendedBridge(outcome({ok: true, requiresReconciliation: true}));
  await bridge.context.runOutcome();
  assertVerificationReport(bridge);
});

test('unattended direct streamingSync flag routes to the same needs-action result', async () => {
  const bridge = unattendedBridge(outcome({streamingSync: closedSync({reconciliationRequired: true})}));
  await bridge.context.runOutcome();
  assertVerificationReport(bridge);
});

test('unattended cancellation keeps precedence while hold still blocks upload closure', async () => {
  const bridge = unattendedBridge(outcome({canceled: true, reconciliationRequired: true}));
  await bridge.context.runOutcome();
  const report = bridge.reports[0].payload;
  assert.equal(report.status, 'canceled');
  assert.equal(report.error, null);
  assert.equal(report.progress.streamingSyncEvidenceKnown, false);
  assert.equal(report.progress.streamingSyncDrainCompleted, false);
  assert.equal(bridge.context.unattendedCaptureTaskStatus, 'canceled');
});

test('unattended platform safety remains ahead of cancellation and hold classification', async () => {
  const bridge = unattendedBridge(outcome({
    securityBlocked: true, canceled: true, reconciliationRequired: true,
    blockingError: {code: 'XHS_SECURITY_BLOCK', message: 'fixture verification required'},
  }));
  await bridge.context.runOutcome();
  const report = bridge.reports[0].payload;
  assert.equal(report.status, 'needs_action');
  assert.equal(report.error.code, 'XHS_SECURITY_BLOCK');
  assert.equal(report.error.securityBlocked, true);
  assert.equal(report.error.retryable, false);
  assert.equal(report.progress.streamingSyncEvidenceKnown, false);
});

test('unattended ordinary failure retains the old failure path without reading message text as a hold', async () => {
  const bridge = unattendedBridge(outcome({ok: false, error: 'LOCAL_CONFIRMATION_REQUIRED is text only'}));
  await assert.rejects(bridge.context.runOutcome(), /text only/);
  assert.equal(bridge.reports[0].payload.status, 'failed');
  assert.equal(bridge.reports[0].payload.error.reconciliationRequired, undefined);
});

test('unattended hold catch suppresses both elastic release and cloud technical handoff', async () => {
  for (const code of ['UNATTENDED_ELASTIC_ITEM_RELEASED', 'UNATTENDED_SEARCH_BOOTSTRAP_FAILED']) {
    const bridge = unattendedBridge(outcome(), {
      request: {cloudAssigned: true, orchestrationContext: {distributionMode: 'elastic_pool'}},
    });
    const error = Object.assign(new Error('fixture transport failure'), {code, reconciliationRequired: true, keyword: 'keyword-a'});
    await assert.rejects(bridge.context.runCaught(error), value => value === error);
    assertVerificationReport(bridge);
    assert.equal(bridge.context.checkpoint.keywordResults[0].itemLockReleased, undefined);
    assert.equal(error.unattendedTerminalReported, true);
  }
});

test('unattended generic catch retains a hold already present on the batch outcome', async () => {
  const bridge = unattendedBridge(outcome({reconciliationRequired: true}));
  const error = new Error('report transport failed after receiving the result');
  await assert.rejects(bridge.context.runCaught(error), value => value === error);
  assertVerificationReport(bridge);
});

test('unattended cancellation catch stays canceled rather than advertising handoff', async () => {
  const bridge = unattendedBridge(outcome(), {
    request: {cloudAssigned: true, orchestrationContext: {distributionMode: 'elastic_pool'}},
  });
  const error = Object.assign(new Error('fixture cancellation'), {
    code: 'UNATTENDED_SEARCH_BOOTSTRAP_CANCELED', reconciliationRequired: true,
  });
  await assert.rejects(bridge.context.runCaught(error), value => value === error);
  assert.equal(bridge.reports[0].payload.status, 'canceled');
  assert.equal(bridge.reports[0].payload.progress.streamingSyncEvidenceKnown, false);
  assert.deepEqual(bridge.ended, []);
  assert.deepEqual(bridge.released, []);
});

test('unattended safety plus hold never advertises an elastic handoff that was suppressed', async () => {
  const bridge = unattendedBridge(outcome(), {
    request: {cloudAssigned: true, orchestrationContext: {distributionMode: 'elastic_pool'}},
  });
  const error = Object.assign(new Error('fixture platform verification required'), {
    code: 'UNATTENDED_ELASTIC_ITEM_RELEASED', reconciliationRequired: true,
    securityBlocked: true,
  });
  await assert.rejects(bridge.context.runCaught(error), value => value === error);
  const report = bridge.reports[0].payload;
  assert.equal(report.status, 'needs_action');
  assert.equal(report.error.code, 'PLATFORM_SAFETY_BLOCK');
  assert.equal(report.progress.streamingSyncEvidenceKnown, false);
  assert.deepEqual(bridge.ended, []);
  assert.deepEqual(bridge.released, []);
  assert.doesNotMatch(report.message, /交回云端|接力|解除.*锁定/);
});

test('unattended ordinary elastic bootstrap failure keeps its existing release behavior', async () => {
  const bridge = unattendedBridge(outcome(), {
    request: {cloudAssigned: true, orchestrationContext: {distributionMode: 'elastic_pool'}},
  });
  const error = Object.assign(new Error('ordinary bootstrap failure'), {code: 'UNATTENDED_SEARCH_BOOTSTRAP_FAILED'});
  await assert.rejects(bridge.context.runCaught(error), value => value === error);
  assert.equal(bridge.ended.length, 1);
  assert.deepEqual(bridge.released, ['task-a']);
  assert.equal(bridge.context.checkpoint.keywordResults[0].itemLockReleased, true);
  assert.equal(bridge.reports[0].payload.error.retryable, true);
  assert.match(bridge.reports[0].payload.message, /交回云端/);
});

test('unattended stale-attempt catch does not publish a new terminal result', async () => {
  const bridge = unattendedBridge(outcome({reconciliationRequired: true}), {activeUnattendedAttemptRejected: true});
  const error = new Error('stale owner');
  await assert.rejects(bridge.context.runCaught(error), value => value === error);
  assert.deepEqual(bridge.reports, []);
  assert.deepEqual(bridge.ended, []);
});

function innerBatchBridge(error, {sync = closedSync(), canceled = false} = {}) {
  const messages = [];
  const token = {};
  const context = vm.createContext({
    hasSyncReconciliationSignal, buildSyncReconciliationError, isUnattendedSafetyBlock,
    injectedError: error, sidebarTaskStatus: 'completed', sidebarTaskError: null,
    caughtError: null, failureOutcome: null, streamingSyncResult: null,
    streamingSyncDrained: false, batchKeywordCancelRequested: canceled,
    activeBatchKeywordInvocationToken: token, batchInvocationToken: token,
    isCurrentUnattendedInvocation: () => true,
    streamingSyncQueue: {enabled: true, getStats: () => sync, drain: async () => sync},
    notifyProgress() {}, refreshDataPool: async () => {}, refreshSyncHistory: async () => {},
    showMessage: (message, tone) => messages.push({message, tone}),
    console: {error() {}, warn() {}},
  });
  vm.runInContext(`${drainSource}
    globalThis.run = async () => {
      try { throw injectedError; }
      catch (error) { ${innerBatchCatch} }
      finally { ${innerBatchFinally} }
    };`, context, {timeout: 5000});
  return {context, messages};
}

test('inner batch catch preserves an explicit confirmation error as a structured outcome', async () => {
  const error = Object.assign(new Error('local confirmation failed'), {code: 'LOCAL_CONFIRMATION_REQUIRED'});
  const bridge = innerBatchBridge(error);
  const result = await bridge.context.run();
  assert.equal(result.reconciliationRequired, true);
  assert.deepEqual(plain(result.error), canonicalError());
  assert.equal(result.streamingSync.drainCompleted, true, 'original drain facts remain separate from the top-level hold signal');
  assert.equal(bridge.context.sidebarTaskStatus, 'needs_action');
  assert.equal(bridge.messages[0].tone, 'warning');
});

test('inner batch finally promotes a hold learned only while draining the same queue', async () => {
  const bridge = innerBatchBridge(new Error('ordinary capture error'), {
    sync: closedSync({reconciliationRequired: true, remainingCount: 1}),
  });
  const result = await bridge.context.run();
  assert.equal(result.reconciliationRequired, true);
  assert.deepEqual(plain(result.error), canonicalError());
  assert.equal(result.streamingSync.drainCompleted, false);
  assert.equal(bridge.context.sidebarTaskStatus, 'needs_action');
  assert.equal(bridge.context.caughtError.streamingSync.reconciliationRequired, true);
});

test('inner batch ordinary errors retain their legacy string outcome and failed status', async () => {
  const bridge = innerBatchBridge(new Error('ordinary capture error'));
  const result = await bridge.context.run();
  assert.equal(result.error, 'ordinary capture error');
  assert.equal(result.reconciliationRequired, undefined);
  assert.equal(bridge.context.sidebarTaskStatus, 'failed');
  assert.equal(bridge.messages[0].tone, 'error');
});

test('inner batch hold preserves explicit user cancellation instead of replacing it with needs-action', async () => {
  const error = Object.assign(new Error('confirmation needed'), {reconciliationRequired: true});
  const bridge = innerBatchBridge(error, {canceled: true});
  const result = await bridge.context.run();
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.canceled, true);
  assert.equal(bridge.context.sidebarTaskStatus, 'canceled');
  assert.equal(result.error.retryable, false);
});

test('inner batch safety evidence survives both immediate and drain-discovered hold signals', async () => {
  for (const lateHold of [false, true]) {
    const error = Object.assign(new Error('platform verification required'), {
      code: 'PLATFORM_SAFETY_BLOCK', securityBlocked: true,
      ...(lateHold ? {} : {reconciliationRequired: true}),
    });
    const bridge = innerBatchBridge(error, {
      sync: closedSync(lateHold ? {reconciliationRequired: true} : {}),
    });
    const result = await bridge.context.run();
    assert.equal(result.reconciliationRequired, true);
    assert.equal(result.securityBlocked, true, 'outer unattended safety precedence must not lose this flag');
    assert.equal(result.blockingError.code, 'PLATFORM_SAFETY_BLOCK');
    assert.equal(bridge.context.sidebarTaskError.code, 'PLATFORM_SAFETY_BLOCK');
    assert.equal(result.error.retryable, false);
  }
});

function target(itemId, ordinal) {
  return {itemId, ordinal, recordId: `backend-${itemId}`, externalId: `note-${itemId}`,
    recordIds: [`local-${itemId}`], status: 'completed', scanComplete: true};
}

function targetedBridge({firstHold = false, initialHold = false, cancelFirst = false,
  ordinaryFailure = false, flushError = null, reportError = null, stale = false} = {}) {
  const processed = [], reports = [];
  const context = vm.createContext({
    Date: FixtureDate,
    hasSyncReconciliationSignal, buildSyncReconciliationError,
    console: {error() {}},
  });
  vm.runInContext(targetedSource, context, {timeout: 5000});
  const api = context.OnStarvoiceCloudTargetedPost;
  const targets = [target('A', 1), target('B', 2)];
  const held = api.applySyncResult(targets[0], {reconciliationRequired: true});
  let flushFailed = false, reportFailed = false;
  Object.assign(context, {
    cloudTargetedPostApi: api,
    request: {id: 'target-run', status: 'running', targets,
      targetResults: initialHold ? [held] : [], cancelRequested: false},
    pendingTargets: initialHold ? [targets[1]] : targets,
    fixtureResults: {
      A: firstHold ? held : ordinaryFailure
        ? {...targets[0], status: 'failed', error: {code: 'ORDINARY_FAILURE', retryable: true}}
        : targets[0],
      B: targets[1],
    },
    fixtureBatchResults: {A: {canceled: cancelFirst}, B: {}},
    processed,
    shouldStop: () => false,
    isActiveTargetedPostInvocation: () => !stale,
    createTargetedPostInvocationError: () => Object.assign(new Error('stale target'), {code: 'stale_targeted_post_attempt'}),
    invocationToken: {requestId: 'target-run', attemptId: 'attempt-a'},
    targetTabId: 1, workflowLabel: '隔离巡查', targetedWorkflow: 'watched_content_patrol',
    isProfileDiscovery: false,
    stopTargetedPostHeartbeat() {},
    flushTargetedBusinessProgress: async () => {
      if (flushError && !flushFailed) {flushFailed = true; throw flushError;}
    },
    updateTargetedPostRun: async (current, patch, token) => {
      reports.push(plain({patch, token}));
      if (reportError && patch.status === 'running' && !reportFailed) {
        reportFailed = true;
        throw reportError;
      }
      return api.mergeRunPatch(current, patch);
    },
    refreshDataPool: async () => {},
  });
  vm.runInContext(`globalThis.runTargets = async () => {
    ${targetLatch}
    try {
      ${targetLoopStart}
        processed.push(target.itemId);
        const targetResult = fixtureResults[target.itemId];
        const batchResult = fixtureBatchResults[target.itemId];
        ${targetLoopTail}
      }
      ${targetFinal}
    } catch (error) { ${targetCatch} }
    return request;
  };`, context, {timeout: 5000});
  return {context, reports, processed};
}

test('targeted hold stops before the next target and reports a needs-action run', async () => {
  const bridge = targetedBridge({firstHold: true});
  const request = await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, ['A']);
  assert.equal(request.status, 'needs_action');
  assert.deepEqual(plain(request.error), canonicalError());
  assert.equal(request.targetResults.length, 1);
  assert.equal(request.targetResults[0].backendSynced, false);
  assert.equal(request.targetResults[0].reconciliationRequired, true);
  assert.equal(bridge.reports.at(-1).patch.progress.phase, 'needs_action');
});

test('targeted ordinary success still processes both targets and completes', async () => {
  const bridge = targetedBridge();
  const request = await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, ['A', 'B']);
  assert.equal(request.status, 'completed');
  assert.equal(request.checkpoint.successCount, 2);
  assert.equal(hasSyncReconciliationSignal(request.error), false);
});

test('targeted ordinary failure does not activate a hold or stop the later target', async () => {
  const bridge = targetedBridge({ordinaryFailure: true});
  const request = await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, ['A', 'B']);
  assert.equal(request.status, 'completed_with_warnings');
  assert.equal(request.checkpoint.failedCount, 1);
  assert.equal(request.checkpoint.successCount, 1);
});

test('targeted cancellation outranks a simultaneous hold and still prevents the next target', async () => {
  const bridge = targetedBridge({firstHold: true, cancelFirst: true});
  const request = await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, ['A']);
  assert.equal(request.status, 'canceled');
  assert.equal(request.targetResults[0].reconciliationRequired, true);
  assert.equal(request.error.retryable, false);
  assert.match(request.message, /已停止/);
});

test('targeted existing hold blocks the pending target before post-capture work begins', async () => {
  const bridge = targetedBridge({initialHold: true});
  const request = await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, []);
  assert.equal(request.status, 'needs_action');
  assert.equal(request.targetResults[0].reconciliationRequired, true);
});

test('targeted progress-flush failure cannot erase the already observed hold signal', async () => {
  const bridge = targetedBridge({firstHold: true, flushError: new Error('fixture progress transport failed')});
  await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, ['A']);
  assert.equal(bridge.reports.at(-1).patch.status, 'needs_action');
  assert.deepEqual(bridge.reports.at(-1).patch.error, canonicalError());
});

test('targeted post-result report failure cannot convert the local hold into retryable failure', async () => {
  const bridge = targetedBridge({firstHold: true, reportError: new Error('fixture target report failed')});
  await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, ['A']);
  assert.equal(bridge.reports.at(-1).patch.status, 'needs_action');
  assert.equal(bridge.reports.at(-1).patch.error.retryable, false);
});

test('targeted catch recognizes an explicit confirmation error without requiring a result flag', async () => {
  const error = Object.assign(new Error('fixture confirmation failure'), {code: 'LOCAL_CONFIRMATION_REQUIRED'});
  const bridge = targetedBridge({flushError: error});
  await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, ['A']);
  assert.equal(bridge.reports.at(-1).patch.status, 'needs_action');
  assert.deepEqual(bridge.reports.at(-1).patch.error, canonicalError());
});

test('targeted stale invocation never publishes a new needs-action report for the old owner', async () => {
  const bridge = targetedBridge({firstHold: true, stale: true});
  await bridge.context.runTargets();
  assert.deepEqual(bridge.processed, ['A']);
  assert.deepEqual(bridge.reports, []);
});
