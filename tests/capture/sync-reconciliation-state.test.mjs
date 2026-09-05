import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import * as state from '../../utils/capture/sync-reconciliation-state.js';

const {hasSyncReconciliationSignal, buildSyncReconciliationError} = state;
const codes = [
  'SYNC_RECONCILIATION_REQUIRED',
  'STREAMING_SYNC_RECONCILIATION_REQUIRED',
  'LOCAL_CONFIRMATION_REQUIRED',
];
const expectedError = {
  code: 'SYNC_RECONCILIATION_REQUIRED',
  message: '同步结果需要核对，本地自动处理已暂停',
  retryable: false,
  reconciliationRequired: true,
  category: 'local_confirmation',
};

test('shared reconciliation state exposes only signal inspection and error construction', () => {
  assert.deepEqual(Object.keys(state).sort(), ['buildSyncReconciliationError', 'hasSyncReconciliationSignal']);
});

test('missing, primitive, function and array payloads cannot carry an explicit object signal', () => {
  for (const value of [undefined, null, false, true, 0, 1, '', 'true', ...codes]) {
    assert.equal(hasSyncReconciliationSignal(value), false);
  }
  const array = Object.assign([], {reconciliationRequired: true, code: codes[0]});
  const fn = Object.assign(() => null, {requiresReconciliation: true, code: codes[0]});
  assert.equal(hasSyncReconciliationSignal(array), false);
  assert.equal(hasSyncReconciliationSignal(fn), false);
});

test('both direct flags require the boolean true value without coercion', () => {
  for (const field of ['reconciliationRequired', 'requiresReconciliation']) {
    assert.equal(hasSyncReconciliationSignal({[field]: true}), true);
    for (const value of [undefined, null, false, 0, 1, '', 'true', 'false', [], {}, new Boolean(true)]) {
      assert.equal(hasSyncReconciliationSignal({[field]: value}), false, `${field}=${String(value)}`);
    }
  }
  assert.equal(hasSyncReconciliationSignal({blockAutomaticReplay: true}), false);
  assert.equal(hasSyncReconciliationSignal({syncReconciliationRequired: true}), false);
});

test('direct error codes use only the three exact strings', () => {
  for (const code of codes) {
    assert.equal(hasSyncReconciliationSignal({code}), true);
    for (const variant of [code.toLowerCase(), ` ${code}`, `${code} `, `${code}_OTHER`, new String(code)]) {
      assert.equal(hasSyncReconciliationSignal({code: variant}), false);
    }
  }
  for (const code of ['SYNC_ERROR', 'NETWORK_ERROR', '', false, 1, null]) {
    assert.equal(hasSyncReconciliationSignal({code}), false);
  }
});

test('one direct error object supports the same exact flags and codes', () => {
  for (const error of [{reconciliationRequired: true}, {requiresReconciliation: true}, ...codes.map(code => ({code}))]) {
    assert.equal(hasSyncReconciliationSignal({error}), true);
  }
  const actualError = new Error('message alone is not inspected');
  actualError.code = codes[0];
  assert.equal(hasSyncReconciliationSignal({error: actualError}), true);
  for (const error of [codes[0], [{code: codes[0]}], {code: 'sync_reconciliation_required'},
    {error: {code: codes[0]}}, {streamingSync: {reconciliationRequired: true}}]) {
    assert.equal(hasSyncReconciliationSignal({error}), false);
  }
});

test('streamingSync accepts only its two direct boolean flags, not codes or nested signals', () => {
  assert.equal(hasSyncReconciliationSignal({streamingSync: {reconciliationRequired: true}}), true);
  assert.equal(hasSyncReconciliationSignal({streamingSync: {requiresReconciliation: true}}), true);
  for (const streamingSync of [...codes.map(code => ({code})),
    {reconciliationRequired: 'true'}, {requiresReconciliation: 1},
    {error: {code: codes[0]}}, {streamingSync: {reconciliationRequired: true}},
    [{reconciliationRequired: true}], codes[0]]) {
    assert.equal(hasSyncReconciliationSignal({streamingSync}), false);
  }
});

test('no recursive search through response, records, checkpoint, metadata or arbitrary wrappers', () => {
  for (const field of ['rawResponse', 'response', 'syncResult', 'result', 'payload', 'data',
    'checkpoint', 'metadata', 'receipt', 'operations', 'records']) {
    assert.equal(hasSyncReconciliationSignal({[field]: {reconciliationRequired: true, code: codes[0]}}), false);
  }
  assert.equal(hasSyncReconciliationSignal({results: [{reconciliationRequired: true}]}), false);
  assert.equal(hasSyncReconciliationSignal({message: codes[0], reason: codes[0]}), false);
  const cyclic = {};
  cyclic.error = cyclic;
  cyclic.streamingSync = cyclic;
  assert.equal(hasSyncReconciliationSignal(cyclic), false, 'bounded inspection does not recurse into cycles');
});

test('a real signal is not cleared by false flags, zero counts or contradictory success fields', () => {
  for (const signal of [{reconciliationRequired: true}, {requiresReconciliation: true},
    {error: {code: codes[0]}}, {streamingSync: {requiresReconciliation: true}}]) {
    assert.equal(hasSyncReconciliationSignal({
      reconciliationRequired: false, requiresReconciliation: false,
      ok: true, status: 'completed', canceled: true, successCount: 0,
      remainingCount: 0, drainCompleted: true, enabled: false, retryable: true,
      ...signal,
    }), true);
  }
});

test('inspection does not read messages, full evidence, queue methods or coercion hooks', () => {
  const forbidden = ['message', 'rawResponse', 'receipt', 'results', 'records', 'recordIds',
    'operations', 'getReconciliationSnapshot', 'cancel', 'drain', 'enqueue'];
  const source = {error: {message: 'ordinary error'}, streamingSync: {remainingCount: 1}};
  for (const field of forbidden) {
    Object.defineProperty(source, field, {get() {throw new Error(`unexpected read: ${field}`);}});
  }
  const nonStringCode = {
    toString() {throw new Error('code must not be stringified');},
    valueOf() {throw new Error('code must not be coerced');},
  };
  source.code = nonStringCode;
  Object.freeze(source);
  assert.equal(hasSyncReconciliationSignal(source), false);
  const signaled = {reconciliationRequired: true};
  Object.defineProperty(signaled, 'error', {get() {throw new Error('direct signal should short-circuit');}});
  assert.equal(hasSyncReconciliationSignal(signaled), true);
});

test('inspection leaves deeply frozen ordinary input unchanged', () => {
  const source = Object.freeze({
    ok: false,
    error: Object.freeze({code: codes[2], message: 'retained separately'}),
    streamingSync: Object.freeze({remainingCount: 2, drainCompleted: false}),
  });
  const before = structuredClone(source);
  assert.equal(hasSyncReconciliationSignal(source), true);
  assert.deepEqual(source, before);
});

test('constructed errors are fresh lightweight non-retryable descriptions, not caller evidence', () => {
  const first = buildSyncReconciliationError();
  assert.deepEqual(first, expectedError);
  assert.equal(hasSyncReconciliationSignal(first), true);
  first.retryable = true;
  first.code = 'SYNC_ERROR';
  first.receipt = {body: 'must not enter another error'};
  const second = buildSyncReconciliationError();
  assert.deepEqual(second, expectedError);
  assert.notEqual(first, second);
  assert.equal('receipt' in second, false);
});

test('shared module is dependency-free and cannot dispatch, persist, schedule or inspect browser state', () => {
  const source = readFileSync(new URL('../../utils/capture/sync-reconciliation-state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|markRecordSynced|updateRecord|setDataPool|createRecordSyncQueue)\s*\(/);
  assert.doesNotMatch(source, /\b(?:chrome|indexedDB|localStorage|sessionStorage)\s*[.(]/);
});
