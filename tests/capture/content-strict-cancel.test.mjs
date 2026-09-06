import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const contentSource = await readFile(new URL('../../content-v2.js', import.meta.url), 'utf8');

function section(startMarker, endMarker) {
  const start = contentSource.indexOf(startMarker);
  const end = contentSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source boundaries: ${startMarker}`);
  return contentSource.slice(start, end);
}

const cancelSource = section('function handleCancelCapture(', '\n}\n') + '\n}';
const helpersSource = section('function normalizeListCaptureRunId(', 'function consumeListCaptureCancellation(');
const trackerSource = section('function runTrackedCaptureRequest(', 'function reportCaptureProgress(');
const strictStart = cancelSource.indexOf('    if (Object.prototype.hasOwnProperty.call(request || {}, "strictControl")) {');
const legacyStart = cancelSource.indexOf('    const targetRequestId =');
assert.ok(strictStart > 0 && legacyStart > strictStart);
const legacySource = cancelSource.slice(0, strictStart) + cancelSource.slice(legacyStart);
const stable = (value) => JSON.parse(JSON.stringify(value));

function harness({counts = [], overlayRunId = null, overlayThrows = false, legacy = false} = {}) {
  const effects = [];
  class CancellationMap extends Map {
    set(key, value) {
      effects.push(['remember', key]);
      return super.set(key, value);
    }
    delete(key) {
      effects.push(['forget', key]);
      return super.delete(key);
    }
  }
  const active = new Map(counts);
  const pending = new CancellationMap();
  const overlay = overlayRunId === null ? null : {
    getState() {
      effects.push(['overlay.read']);
      if (overlayThrows) throw new Error('synthetic overlay failure');
      return {sessionId: overlayRunId};
    },
    cancel(message) {
      effects.push(['overlay.cancel', message]);
    },
  };
  const context = vm.createContext({
    activeCaptureRequestCounts: active,
    activeListCaptureDebugOverlay: overlay,
    pendingListCaptureCancellations: pending,
    setCancelFlag: (value) => effects.push(['cancelFlag', value]),
    console: {
      warn: (...args) => effects.push(['warn', args[0]]),
      error: (...args) => effects.push(['error', args[0]]),
    },
  });
  vm.runInContext(`${helpersSource}\n${trackerSource}\n${legacy ? legacySource : cancelSource}\n`
    + 'globalThis.api = {handleCancelCapture, runTrackedCaptureRequest, handleInspectCaptureActivity};', context);
  function cancel(request) {
    const responses = [];
    context.api.handleCancelCapture(request, (value) => responses.push(stable(value)));
    assert.equal(responses.length, 1, 'one synchronous acknowledgement');
    return responses[0];
  }
  function inspect(request) {
    let response;
    context.api.handleInspectCaptureActivity(request, (value) => {response = stable(value);});
    return response;
  }
  return {cancel, inspect, track: context.api.runTrackedCaptureRequest, effects, active, pending};
}

const refusal = {
  ok: false,
  matched: false,
  strictControl: {version: 1, accepted: false, reason: 'CONTENT_ACTIVITY_IDENTITY_UNPROVEN'},
  error: {code: 'STRICT_CONTENT_CONTROL_REJECTED', message: '当前页面尚不能核验独占采集身份，未执行严格取消'},
};

function assertNoCancellation(h, request) {
  const countsBefore = [...h.active];
  assert.deepEqual(h.cancel(request), refusal);
  assert.deepEqual(h.effects, [], 'no flag, list memory, overlay reads/effects, or legacy error path');
  assert.deepEqual([...h.pending], []);
  assert.deepEqual([...h.active], countsBefore);
}

test('legacy cancellation function remains byte-identical outside the single strict guard', () => {
  // Exact function from 5ef340c625f764e9228cd965740208b425f886bb, not a reconstructed behavior model.
  assert.equal(createHash('sha256').update(legacySource).digest('hex'),
    '0964149a9007d10301fb7918009d7d387f28154a22cb5e98d38d680865df7a75');
});

const invalidEnvelopes = [undefined, null, false, true, '', 'strict', 1, [], {}, {version: 0}, {version: 2}];
for (const [index, strictControl] of invalidEnvelopes.entries()) {
  test(`explicit strict envelope ${index} refuses synchronously without legacy fallback`, () => {
    const h = harness({counts: [['capture-A', 1]], overlayRunId: 'list-A'});
    assertNoCancellation(h, {strictControl, captureRequestId: 'capture-A', listCaptureRunId: 'list-A'});
  });
}

const pageStates = [
  ['no active task', {counts: []}],
  ['one exact capture', {counts: [['capture-A', 1]]}],
  ['duplicate same capture', {counts: [['capture-A', 2]]}],
  ['old capture and new capture', {counts: [['capture-B', 1]]}],
  ['two distinct captures', {counts: [['capture-A', 1], ['capture-B', 1]]}],
  ['exact capture and exact overlay', {counts: [['capture-A', 1]], overlayRunId: 'list-A'}],
  ['old capture and new overlay', {counts: [['capture-B', 1]], overlayRunId: 'list-B'}],
  ['no capture and restored overlay', {counts: [], overlayRunId: 'list-A'}],
  ['unknown overlay state', {counts: [['capture-A', 1]], overlayRunId: 'list-A', overlayThrows: true}],
];
for (const [label, state] of pageStates) {
  test(`claimed full identity cannot authorize cancellation: ${label}`, () => {
    const h = harness(state);
    assertNoCancellation(h, {
      captureRequestId: 'capture-A', listCaptureRunId: 'list-A',
      strictControl: {
        version: 1, requestId: 'request-A', attemptId: 'attempt-A',
        expectedUpdatedAt: 100, scope: 'scope-A', documentId: 'doc-A',
        ownerId: 'owner-A', captureRequestId: 'capture-A', listCaptureRunId: 'list-A',
        verified: true, exclusive: true, permission: 'cancel',
      },
    });
  });
}

test('strict refusal never reads legacy target fields or trusts envelope getters', () => {
  const h = harness({counts: [['capture-A', 1]], overlayRunId: 'list-A'});
  const unexpected = () => {throw new Error('must not read unverified target');};
  const request = Object.defineProperties({}, {
    strictControl: {get: unexpected},
    captureRequestId: {get: unexpected},
    listCaptureRunId: {get: unexpected},
  });
  assertNoCancellation(h, request);
});

test('a stale inspection followed by task replacement still cannot cancel the new activity', () => {
  const h = harness({counts: [['capture-A', 1]], overlayRunId: 'list-B'});
  assert.equal(h.inspect({captureRequestId: 'capture-A'}).targetActive, true);
  h.active.delete('capture-A');
  h.active.set('capture-B', 1);
  assertNoCancellation(h, {strictControl: {version: 1}, captureRequestId: 'capture-A', listCaptureRunId: 'list-A'});
});

test('actual legacy tracker count one omits a concurrent anonymous handler and cannot establish exclusivity', async () => {
  const h = harness({overlayRunId: 'list-A'});
  let finishNamed;
  let finishAnonymous;
  const named = new Promise((resolve) => {finishNamed = resolve;});
  const anonymous = new Promise((resolve) => {finishAnonymous = resolve;});
  let runningHandlers = 0;
  h.track({captureRequestId: 'capture-A'}, () => {runningHandlers += 1; return named;});
  h.track({}, () => {runningHandlers += 1; return anonymous;});
  assert.equal(runningHandlers, 2);
  assert.deepEqual(h.inspect({captureRequestId: 'capture-A'}), {
    ok: true, captureRequestId: 'capture-A', targetActive: true, activeCount: 1,
  });
  assertNoCancellation(h, {strictControl: {version: 1}, captureRequestId: 'capture-A', listCaptureRunId: 'list-A'});
  finishNamed();
  finishAnonymous();
  await Promise.all([named, anonymous]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.inspect({captureRequestId: 'capture-A'}).activeCount, 0);
  assert.deepEqual(h.effects, []);
});

const legacyCases = [
  ['empty request cancels globally', {}, {}],
  ['active named capture', {captureRequestId: 'capture-A'}, {counts: [['capture-A', 1]]}],
  ['absent named capture', {captureRequestId: 'capture-A'}, {counts: [['capture-B', 1]]}],
  ['unmatched capture with new list still triggers legacy flag', {captureRequestId: 'capture-A', listCaptureRunId: 'list-A'}, {counts: [['capture-B', 1]]}],
  ['matching list overlay', {captureRequestId: 'capture-A', listCaptureRunId: 'list-A'}, {overlayRunId: 'list-A'}],
  ['different overlay is retained', {captureRequestId: 'capture-A', listCaptureRunId: 'list-A'}, {overlayRunId: 'list-B'}],
  ['missing list targets current overlay despite unmatched capture', {captureRequestId: 'capture-A'}, {overlayRunId: 'list-B'}],
  ['overlay failure remains nonfatal', {captureRequestId: 'capture-A'}, {overlayRunId: 'list-B', overlayThrows: true}],
  ['malformed legacy list remains empty', {captureRequestId: 'capture-A', listCaptureRunId: 'x'.repeat(321)}, {counts: [['capture-A', 1]]}],
  ['legacy target coercion remains', {captureRequestId: 42, listCaptureRunId: 27}, {counts: [['42', 1]], overlayRunId: '27'}],
];
for (const [label, request, state] of legacyCases) {
  test(`absent strict envelope preserves exact legacy function behavior: ${label}`, () => {
    const old = harness({...state, legacy: true});
    const candidate = harness(state);
    assert.deepEqual(candidate.cancel(request), old.cancel(request));
    assert.deepEqual(candidate.effects, old.effects);
    assert.deepEqual([...candidate.pending.keys()], [...old.pending.keys()]);
  });
}

test('a prototype property is not an explicit strict message field', () => {
  const request = Object.create({strictControl: {version: 1}});
  request.captureRequestId = 'capture-A';
  const old = harness({counts: [['capture-A', 1]], legacy: true});
  const candidate = harness({counts: [['capture-A', 1]]});
  assert.deepEqual(candidate.cancel(request), old.cancel(request));
  assert.deepEqual(candidate.effects, old.effects);
});
