import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  hasSyncReconciliationSignal,
  buildSyncReconciliationError,
} from '../../utils/capture/sync-reconciliation-state.js';

const source = readFileSync(new URL('../../utils/cloud-targeted-post.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function loadTargeted(overrides = {}) {
  const context = vm.createContext({...overrides});
  vm.runInContext(source, context, {filename: 'utils/cloud-targeted-post.js', timeout: 5000});
  return context.OnStarvoiceCloudTargetedPost;
}

const targeted = loadTargeted();
const target = (overrides = {}) => ({
  itemId: 'target-a', recordId: 'backend-row-a', externalId: 'note-a', ordinal: 1,
  recordIds: ['local-a', 'local-b'], status: 'completed', scanComplete: true,
  captureTaskItemAttemptId: 'attempt-a', captureTaskItemRequestHash: 'hash-a',
  commentObservation: {observedCount: 3},
  ...overrides,
});

const codes = [
  'SYNC_RECONCILIATION_REQUIRED',
  'STREAMING_SYNC_RECONCILIATION_REQUIRED',
  'LOCAL_CONFIRMATION_REQUIRED',
];
const signalCases = [
  {reconciliationRequired: true},
  {requiresReconciliation: true},
  {error: {reconciliationRequired: true}},
  {error: {requiresReconciliation: true}},
  {streamingSync: {reconciliationRequired: true}},
  {streamingSync: {requiresReconciliation: true}},
  ...codes.map(code => ({code})),
  ...codes.map(code => ({error: {code}})),
];

function assertHeld(result) {
  assert.equal(result.status, 'failed', 'retain the accepted target-result protocol envelope');
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.backendSynced, false);
  assert.equal(result.scanComplete, false);
  assert.equal(result.localCaptureCompleted, true);
  assert.equal(result.sync.status, 'needs_action');
  assert.equal(result.sync.reconciliationRequired, true);
  assert.deepEqual(plain(result.error), {
    code: 'SYNC_RECONCILIATION_REQUIRED',
    message: '同步结果需要核对，本地自动处理已暂停',
    retryable: false,
    reconciliationRequired: true,
    category: 'local_confirmation',
    stage: 'sync',
  });
  assert.equal('securityBlocked' in result, false);
  assert.equal('securityBlocked' in result.error, false);
  assert.equal('platformSafetyBlocked' in result.error, false);
}

test('every explicit supported signal keeps a targeted result pending verification', () => {
  for (const signal of signalCases) {
    const input = {ok: false, ...signal};
    assertHeld(targeted.applySyncResult(target(), input));
    assertHeld(targeted.applySyncResult(target({status: 'completed_with_warnings'}), input));
  }
});

test('explicit sync errors use the same hold path, including an Error with an exact code', () => {
  for (const signal of signalCases) {
    assertHeld(targeted.applySyncResult(target(), null, signal));
  }
  const error = new Error('a transport-looking message must not authorize replay');
  error.code = 'LOCAL_CONFIRMATION_REQUIRED';
  assertHeld(targeted.applySyncResult(target(), null, error));
});

test('an explicit hold overrides apparent full success without inventing failed counts', () => {
  const result = targeted.applySyncResult(target(), {
    ok: true, successCount: 2, failedCount: 0, pausedCount: 0,
    reconciliationRequired: true,
  });
  assertHeld(result);
  assert.equal(result.partial, true);
  assert.deepEqual(plain(result.sync), {
    status: 'needs_action', successCount: 2, failedCount: 0, pausedCount: 0,
    reconciliationRequired: true,
  });
});

test('hold projection retains target identity, capture observations and partial sync facts', () => {
  const input = target();
  const syncResult = {
    successCount: 1, failedCount: 0, pausedCount: 1, requiresReconciliation: true,
  };
  const before = plain({input, syncResult});
  const result = targeted.applySyncResult(input, syncResult);
  assertHeld(result);
  for (const field of ['itemId', 'recordId', 'externalId', 'ordinal',
    'captureTaskItemAttemptId', 'captureTaskItemRequestHash']) {
    assert.equal(result[field], input[field]);
  }
  assert.deepEqual(plain(result.recordIds), input.recordIds);
  assert.deepEqual(plain(result.commentObservation), input.commentObservation);
  assert.equal(result.sync.successCount, 1);
  assert.equal(result.sync.failedCount, 0);
  assert.equal(result.sync.pausedCount, 1);
  assert.equal(result.partial, true);
  assert.deepEqual(plain({input, syncResult}), before, 'projection must not mutate its inputs');
});

test('lightweight target projection does not embed response bodies or invent durable receipt storage', () => {
  const result = targeted.applySyncResult(target(), {
    reconciliationRequired: true,
    rawResponse: {body: 'x'.repeat(100_000)},
    results: [{recordId: 'local-a', remoteReceipt: {accepted: true}}],
  });
  assertHeld(result);
  assert.equal('rawResponse' in result, false);
  assert.equal('results' in result.sync, false);
  assert.ok(JSON.stringify(result).length < 2000);
  // The operation-level receipt ledger is a separate producer/recovery gate.
});

test('normalization and run merging preserve the hold without changing checkpoint status accounting', () => {
  const targets = [target(), target({itemId: 'target-b', ordinal: 2})];
  const held = targeted.applySyncResult(targets[0], {reconciliationRequired: true});
  const normalized = targeted.normalizeTargetResults([held], targets);
  assert.equal(normalized.length, 1);
  assertHeld(normalized[0]);
  const merged = targeted.mergeRunPatch({
    status: 'running', targets, targetResults: [], createdAt: '2026-09-06T00:00:00.000Z',
  }, {targetResults: [held]});
  assert.equal(merged.targetResults.length, 1);
  assertHeld(merged.targetResults[0]);
  assert.equal(merged.checkpoint.successCount, 0);
  assert.equal(merged.checkpoint.failedCount, 1);
  assert.equal(merged.checkpoint.processedCount, 1);
  assert.equal(merged.checkpoint.nextOrdinal, 2);
  assert.deepEqual(plain(merged.checkpoint.completedItemIds), ['target-a']);
  // This intentionally retains legacy accounting. Stopping the next target
  // and reporting a needs_action RUN requires the outer consumer's hold gate.
});

test('existing unsuccessful capture outcomes are not rewritten by a later sync projection', () => {
  for (const status of ['failed', 'canceled', 'skipped', 'needs_action', 'pending']) {
    const input = target({status, error: {code: 'TARGET_IDENTITY_MISMATCH', retryable: false}});
    const result = targeted.applySyncResult(input, {reconciliationRequired: true});
    assert.equal(result, input);
    assert.equal(result.error.code, 'TARGET_IDENTITY_MISMATCH');
  }
});

test('an already-held target cannot be cleared by another apparent success result', () => {
  const held = targeted.applySyncResult(target(), {requiresReconciliation: true});
  const result = targeted.applySyncResult(held, {ok: true, successCount: 2});
  assert.equal(result, held);
  assertHeld(result);
});

test('normal success and ordinary partial failure keep their existing projections', () => {
  const completed = targeted.applySyncResult(target(), {
    ok: true, successCount: 2, failedCount: 0, pausedCount: 0,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.backendSynced, true);
  assert.deepEqual(plain(completed.sync), {status: 'completed', successCount: 2, failedCount: 0, pausedCount: 0});
  assert.equal('reconciliationRequired' in completed, false);
  const partial = targeted.applySyncResult(target(), {
    ok: false, successCount: 1, failedCount: 1,
    error: {code: 'SYNC_REJECTED', message: 'ordinary backend rejection'},
  });
  assert.equal(partial.status, 'failed');
  assert.equal(partial.partial, true);
  assert.equal(partial.sync.status, 'partial');
  assert.equal(partial.error.code, 'SYNC_REJECTED');
  assert.equal(partial.error.retryable, true);
  assert.equal('reconciliationRequired' in partial, false);
});

test('text, non-boolean flags, generic retry policy and nested response bodies are not hold signals', () => {
  const negatives = [
    {}, {retryable: false}, {blockAutomaticReplay: true},
    {partialContentSuccess: true}, {syncPaused: true},
    {message: 'SYNC_RECONCILIATION_REQUIRED local confirmation needs reconciliation'},
    {error: {message: 'LOCAL_CONFIRMATION_REQUIRED', retryable: false}},
    {code: 'sync_reconciliation_required'}, {code: ' SYNC_RECONCILIATION_REQUIRED '},
    {code: 'SYNC_RECONCILIATION_REQUIRED_EXTRA'},
    {error: {error: {code: 'LOCAL_CONFIRMATION_REQUIRED'}}},
    {rawResponse: {reconciliationRequired: true}},
    {results: [{requiresReconciliation: true}]},
    {streamingSync: {code: 'LOCAL_CONFIRMATION_REQUIRED'}},
    {streamingSync: {error: {reconciliationRequired: true}}},
    ...['true', 1, {}, [], null, false].flatMap(value => [
      {reconciliationRequired: value}, {requiresReconciliation: value},
      {error: {reconciliationRequired: value}},
      {streamingSync: {requiresReconciliation: value}},
    ]),
  ];
  for (const value of negatives) {
    const result = targeted.applySyncResult(target(), {ok: false, ...value});
    assert.equal(result.reconciliationRequired, undefined, JSON.stringify(value));
    assert.equal(result.error.retryable, true, JSON.stringify(value));
  }
});

test('the classic adapter and shared ESM classifier agree on their finite signal boundary', () => {
  const values = [
    null, undefined, false, 'LOCAL_CONFIRMATION_REQUIRED', [], {},
    ...signalCases,
    {error: {error: {requiresReconciliation: true}}},
    {streamingSync: {code: 'LOCAL_CONFIRMATION_REQUIRED'}},
    {results: [{reconciliationRequired: true}]},
    ...codes.flatMap(code => [
      {code: code.toLowerCase()}, {code: ` ${code}`}, {code: `${code}_EXTRA`},
      {body: {code}}, {error: {streamingSync: {code}}},
    ]),
    ...['true', 1, {}, null, false].flatMap(value => [
      {reconciliationRequired: value}, {requiresReconciliation: value},
      {error: {reconciliationRequired: value}},
      {streamingSync: {requiresReconciliation: value}},
    ]),
  ];
  for (const value of values) {
    const result = targeted.applySyncResult(target(), value);
    assert.equal(result.reconciliationRequired === true, hasSyncReconciliationSignal(value), JSON.stringify(value));
    if (result.reconciliationRequired === true) {
      assert.deepEqual(plain(result.error), {...buildSyncReconciliationError(value), stage: 'sync'});
    }
  }
  const explicit = {reconciliationRequired: true};
  Object.defineProperty(explicit, 'streamingSync', {get() {
    assert.fail('a direct signal must not inspect lower-priority nested values');
  }});
  assert.equal(hasSyncReconciliationSignal(explicit), true);
  assertHeld(targeted.applySyncResult(target(), explicit));
});

test('classic loading and the new projection need no browser, network, storage or clock access', () => {
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  let externalReads = 0;
  const sandbox = {};
  for (const key of ['chrome', 'fetch', 'XMLHttpRequest', 'WebSocket', 'document',
    'localStorage', 'sessionStorage', 'indexedDB', 'setTimeout', 'setInterval',
    'importScripts', 'Date', 'performance', 'crypto']) {
    Object.defineProperty(sandbox, key, {get() {
      externalReads += 1;
      throw new Error(`unexpected external access: ${key}`);
    }});
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, {timeout: 5000});
  const api = context.OnStarvoiceCloudTargetedPost;
  assert.equal(Object.isFrozen(api), true);
  assertHeld(api.applySyncResult(target(), {reconciliationRequired: true}));
  assert.equal(api.applySyncResult(target(), {ok: true, successCount: 2}).backendSynced, true);
  assert.equal(externalReads, 0);
});
