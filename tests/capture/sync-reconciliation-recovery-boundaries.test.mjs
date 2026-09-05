import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as policy from '../../prototypes/extension-sync-confirmation/recovery-policy.mjs';
import {hasSyncReconciliationSignal} from '../../utils/capture/sync-reconciliation-state.js';
import {projectElasticKeywordRecoveryStatus} from '../../server/modules/capture/application/control-outcome-projection.js';

const {projectSyncReconciliationRecovery} = policy;
const holdDecision = {
  decision: 'require_reconciliation',
  automaticReplayBlocked: true,
  terminalSuccessAllowed: false,
};
const deferDecision = {decision: 'defer_existing'};

// These negative controls execute the actual, STILL UNFIXED monitor source.
// Do not use their legacy success/retry behavior as a specification to implement.
// No route, database, browser, real sync request, or scheduler is started here.
const sidebarSource = readFileSync(new URL('../../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
const monitorRouteSource = readFileSync(new URL('../../server/routes/monitor.js', import.meta.url), 'utf8');

function uniqueRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `source marker exists: ${startMarker}`);
  assert.equal(source.indexOf(startMarker, start + 1), -1, `source marker is unique: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `source range ends: ${endMarker}`);
  return source.slice(start, end);
}

const monitorSyncSummarySource = uniqueRange(sidebarSource,
  'function summarizeMonitorSyncResult(', 'function getShanghaiDayStartMs(');
const monitorOutcomeSource = uniqueRange(sidebarSource,
  '    const syncStats = summarizeMonitorSyncResult(syncResult);',
  '    const errorMessage = hasCommentCaptureFailure');
const monitorFinishRouteSource = uniqueRange(monitorRouteSource,
  "router.post('/executions/:id/finish',", "router.get('/settings',");
const finalStatusAssignments = monitorFinishRouteSource.match(/const finalStatus\s*=\s*[^;]+;/g) || [];
assert.equal(finalStatusAssignments.length, 1, 'exactly one actual finish status projection');
const finalStatusSource = finalStatusAssignments[0];

function evaluateActualMonitorOutcome(syncResult, {shouldCaptureComments = false, commentDetailResult = null} = {}) {
  const context = vm.createContext({syncResult, shouldCaptureComments, commentDetailResult});
  vm.runInContext(`${monitorSyncSummarySource}\n${monitorOutcomeSource}
    globalThis.projected = {syncStats, hasSyncFailure, hasCommentCaptureFailure, hasTaskFailure};`,
  context, {timeout: 1000});
  return JSON.parse(JSON.stringify(context.projected));
}

function evaluateActualMonitorFinishStatus(status) {
  const context = vm.createContext({status});
  vm.runInContext(`${finalStatusSource}\nglobalThis.projected = finalStatus;`, context, {timeout: 1000});
  return context.projected;
}

function elasticHoldInput(overrides = {}) {
  return {
    elasticPool: true, status: 'failed', attemptCount: 0, agentAttemptLimit: 2,
    reconciliationRequired: true,
    error: {code: 'STREAMING_SYNC_RECONCILIATION_REQUIRED', retryable: false, reconciliationRequired: true},
    checkpoint: {syncReconciliationRequired: true, syncDrainCompleted: false, blockAutomaticReplay: true},
    ...overrides,
  };
}

test('unwired recovery policy has one requirement-only export', () => {
  assert.deepEqual(Object.keys(policy), ['projectSyncReconciliationRecovery']);
});

test('absent reconciliation signals defer judgment without allowing replay or terminal success', () => {
  for (const input of [undefined, null, false, true, 0, '', {},
    {ok: true}, {ok: false}, {status: 'retryable'}, {status: 'completed'},
    {retryable: true}, {retryable: false}, {reconciliationRequired: false}]) {
    assert.deepEqual(projectSyncReconciliationRecovery(input), deferDecision);
  }
});

test('explicit hold always blocks both actions regardless of contradictory completion fields', () => {
  for (const extra of [{}, {enabled: false}, {ok: true, status: 'completed', successCount: 99},
    {ok: false, status: 'retryable', retryable: true},
    {canceled: true, drainCompleted: true, remainingCount: 0},
    {successCount: 'invalid', failedCount: -1, remainingCount: -2}]) {
    assert.deepEqual(projectSyncReconciliationRecovery({reconciliationRequired: true, ...extra}), holdDecision);
  }
});

test('prototype delegates signal interpretation to the shared helper rather than introducing another parser', () => {
  const sources = [
    {reconciliationRequired: true}, {requiresReconciliation: true}, {blockAutomaticReplay: true},
    {reconciliationRequired: 'true'}, {requiresReconciliation: 1}, {blockAutomaticReplay: 'yes'},
    {error: {reconciliationRequired: true}}, {syncResult: {reconciliationRequired: true}},
    {streamingSync: {reconciliationRequired: true}},
    {checkpoint: {syncReconciliationRequired: true}},
  ];
  for (const source of sources) {
    assert.deepEqual(projectSyncReconciliationRecovery(source),
      hasSyncReconciliationSignal(source) ? holdDecision : deferDecision);
  }
});

test('only canonical direct or bounded-wrapper signals carry the blocking requirement', () => {
  for (const field of ['reconciliationRequired', 'requiresReconciliation']) {
    for (const input of [{[field]: true}, {error: {[field]: true}}, {streamingSync: {[field]: true}}]) {
      assert.deepEqual(projectSyncReconciliationRecovery(input), holdDecision);
    }
  }
  for (const code of ['SYNC_RECONCILIATION_REQUIRED', 'STREAMING_SYNC_RECONCILIATION_REQUIRED', 'LOCAL_CONFIRMATION_REQUIRED']) {
    assert.deepEqual(projectSyncReconciliationRecovery({code}), holdDecision);
    assert.deepEqual(projectSyncReconciliationRecovery({error: {code}}), holdDecision);
    assert.deepEqual(projectSyncReconciliationRecovery({streamingSync: {code}}), deferDecision);
    assert.deepEqual(projectSyncReconciliationRecovery({code: code.toLowerCase()}), deferDecision);
    assert.deepEqual(projectSyncReconciliationRecovery({code: ` ${code} `}), deferDecision);
  }
  for (const input of [
    {reconciliationRequired: 'true'}, {requiresReconciliation: 1}, {blockAutomaticReplay: true},
    {syncResult: {reconciliationRequired: true}},
    {checkpoint: {syncReconciliationRequired: true}},
    {rawResponse: {reconciliationRequired: true}},
    {results: [{reconciliationRequired: true}]},
    {error: {error: {reconciliationRequired: true}}},
    {message: 'SYNC_RECONCILIATION_REQUIRED'},
  ]) {
    assert.deepEqual(projectSyncReconciliationRecovery(input), deferDecision,
      'unrecognized data must defer, never silently grant replay permission');
  }
});

test('prototype does not mutate inputs, retain mutable decisions or inspect receipt bodies', () => {
  const input = {reconciliationRequired: true};
  for (const field of ['receipt', 'rawResponse', 'operations', 'recordIds', 'heldRecordIds', 'getReconciliationSnapshot']) {
    Object.defineProperty(input, field, {
      get() {throw new Error(`recovery policy must not inspect ${field}`);},
    });
  }
  Object.freeze(input);
  const first = projectSyncReconciliationRecovery(input);
  first.automaticReplayBlocked = false;
  first.terminalSuccessAllowed = true;
  assert.deepEqual(projectSyncReconciliationRecovery(input), holdDecision);
  assert.equal(input.reconciliationRequired, true);
});

test('KNOWN UNFIXED: actual elastic recovery still makes five held failure states retryable', () => {
  for (const status of ['interrupted', 'needs_action', 'failed', 'completed_with_failures', 'retryable']) {
    const input = elasticHoldInput({status});
    assert.deepEqual(projectSyncReconciliationRecovery(input), holdDecision,
      'the unwired requirement forbids replay, not the current server');
    assert.equal(projectElasticKeywordRecoveryStatus(input), 'retryable',
      `known server integration gap: ${status} ignores the hold signal`);
  }
});

test('KNOWN UNFIXED: existing elastic attempt limits are not a reconciliation fence', () => {
  const beforeLimit = elasticHoldInput({attemptCount: 3});
  const atLimit = elasticHoldInput({attemptCount: 4});
  assert.equal(projectElasticKeywordRecoveryStatus(beforeLimit), 'retryable');
  assert.equal(projectElasticKeywordRecoveryStatus(atLimit), 'failed');
  assert.deepEqual(projectSyncReconciliationRecovery(beforeLimit), holdDecision);
  assert.deepEqual(projectSyncReconciliationRecovery(atLimit), holdDecision,
    'exhausting retries does not confirm an acknowledged operation');
  assert.equal(projectElasticKeywordRecoveryStatus(elasticHoldInput({elasticPool: false})), 'failed');
});

test('KNOWN UNFIXED: actual monitor consumer treats hold plus ok and an item success as successful', () => {
  const result = {ok: true, reconciliationRequired: true, blockAutomaticReplay: true,
    results: [{success: true, rawResponse: {action: 'inserted'}}]};
  assert.deepEqual(projectSyncReconciliationRecovery(result), holdDecision);
  assert.deepEqual(evaluateActualMonitorOutcome(result), {
    syncStats: {successCount: 1, failedCount: 0, insertedCount: 1, updatedCount: 0, negativeCount: 0},
    hasSyncFailure: false, hasCommentCaptureFailure: false, hasTaskFailure: false,
  });
});

test('KNOWN UNFIXED: actual monitor consumer flattens a held non-ok result into ordinary failure', () => {
  const result = {ok: false, reconciliationRequired: true, retryable: false,
    error: {code: 'STREAMING_SYNC_RECONCILIATION_REQUIRED', retryable: false},
    results: [{success: true, rawResponse: {action: 'updated'}}]};
  const outcome = evaluateActualMonitorOutcome(result);
  assert.equal(outcome.hasTaskFailure, true);
  assert.equal(outcome.syncStats.successCount, 1);
  assert.equal(outcome.syncStats.updatedCount, 1);
  assert.equal('reconciliationRequired' in outcome, false);
  assert.deepEqual(projectSyncReconciliationRecovery(result), holdDecision);
});

test('actual monitor negative-control extraction retains the independent comment-failure gate', () => {
  const outcome = evaluateActualMonitorOutcome({ok: true, results: [{success: true}]},
    {shouldCaptureComments: true, commentDetailResult: {ok: false, failedCount: 1}});
  assert.equal(outcome.hasSyncFailure, false);
  assert.equal(outcome.hasCommentCaptureFailure, true);
  assert.equal(outcome.hasTaskFailure, true);
});

test('KNOWN UNFIXED: actual monitor finish converts proposed reconciliation states into success', () => {
  for (const status of ['needs_action', 'reconciliation_required', 'held', 'canceled']) {
    assert.equal(evaluateActualMonitorFinishStatus(status), 'succeeded',
      'do not send a new hold state through the unchanged finish endpoint');
  }
  assert.equal(evaluateActualMonitorFinishStatus('failed'), 'failed');
  assert.equal(evaluateActualMonitorFinishStatus('succeeded'), 'succeeded');
});

test('KNOWN UNFIXED: monitor failed finish still schedules a later run rather than a durable hold', () => {
  assert.match(monitorFinishRouteSource, /next_run_at\s*=\s*CASE[\s\S]*?WHEN \$1 = 'succeeded'[\s\S]*?ELSE now\(\) \+ interval '15 minutes'/);
  assert.match(monitorFinishRouteSource, /status IN \('pending', 'running'\)/);
  assert.doesNotMatch(monitorFinishRouteSource, /reconciliationRequired|blockAutomaticReplay|requiresReconciliation/);
});

test('recovery prototype remains disconnected from runtime entry points and cannot perform effects', () => {
  for (const file of ['../../sidebar/sidebar-logic.js', '../../background.js',
    '../../utils/capture-sync.js', '../../utils/record-sync-queue.js',
    '../../server/modules/capture/application/control-outcome-projection.js', '../../server/routes/monitor.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /recovery-policy\.mjs|projectSyncReconciliationRecovery\s*\(/, file);
  }
  const prototypeSource = readFileSync(new URL('../../prototypes/extension-sync-confirmation/recovery-policy.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(prototypeSource, /\b(?:fetch|setTimeout|setInterval|markRecordSynced|updateRecord|setDataPool|createRecordSyncQueue)\s*\(/);
  assert.doesNotMatch(prototypeSource, /\b(?:chrome|indexedDB|localStorage|sessionStorage)\s*[.(]/);
});
