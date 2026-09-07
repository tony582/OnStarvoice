import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createActiveStopHarness as harness} from '../helpers/active-stop-harness.mjs';

const PREFIX = 'onstarvoice:strict-';
const PREPARE = 'onstarvoice:prepare-active-capture-stop';
const EXECUTE = 'onstarvoice:execute-active-capture-stop';
const INSPECT = 'onstarvoice:inspect-active-capture-stop';
const ACTION = 'stop_active_capture';
const KEY = 'onstarvoice.captureStopControl.v1';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {let resolve; let reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};}
async function promptly(promise) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('control waited for an unsettled page')), 250);
  })]);} finally {clearTimeout(timer);}
}


test('real control binds the exact live reservation atomically without changing task, ledger or unsynced results', async () => {
  const h = harness(); const before = clone(h.store);
  const bound = await h.bind();
  assert.equal(bound.ok, true); assert.equal(bound.accepted, true);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(Object.keys(h.writes[0]).sort(), [KEY, 'lock'].sort());
  assert.equal(h.store.lock.captureTaskId, `unattended-capture:${h.requestId}`);
  assert.equal(h.store.lock.captureTaskAttemptId, h.attemptId);
  for (const key of ['auth', 'request', 'ledger', 'archive', 'unsyncedRecords']) assert.deepEqual(h.store[key], before[key]);
  assert.equal(JSON.stringify(h.store[KEY]).includes('synthetic-token-never-persist'), false);
  assert.equal(await h.control.guardScope(h.scope, h.sender), true);
  assert.equal(await h.control.guardLegacy(), true);
  assert.equal((await h.bind()).accepted, false);
});

test('real relay -> prepare -> immediate pending stop -> child/owner drain -> source stopped retains resources and uploads', async () => {
  const h = harness(); assert.equal((await h.bind()).ok, true);
  const activityId = randomUUID(); assert.equal((await h.beginActivity(activityId)).ok, true);
  assert.equal((await h.operation('relay', {action: 'captureSingleNote', withChild: true})).ok, true);
  assert.equal(h.pageFor('page-a').inspect().childCount, 1);
  const prepared = await h.prepare(); assert.equal(prepared.ok, true);
  const executed = await promptly(h.execute(prepared.handle));
  assert.equal(executed.accepted, true); assert.equal(executed.sourceStopped, false);
  assert.equal(executed.phase, 'stop_requested');
  await tick();
  assert.equal(h.ownerMessages.at(-1).type, 'capture-owner:strict-stop');
  assert.equal(h.pageFor('page-a').isStopped(), true);
  assert.equal((await promptly(h.inspect())).sourceStopped, false);
  assert.equal((await h.operation()).accepted, false);
  assert.equal((await h.scoped('owner-settled', {runnerQuiesced: true, pendingUploads: 2})).accepted, false);
  h.child.resolve(); await tick();
  assert.equal((await h.scoped('owner-activity-end', {activityId})).ok, true);
  assert.equal((await h.scoped('owner-settled', {runnerQuiesced: true, pendingUploads: 2})).ok, true);
  await h.inspect(); await tick();
  const receipt = await h.inspect();
  assert.equal(receipt.sourceStopped, true); assert.equal(receipt.phase, 'stopped');
  assert.equal(receipt.pendingUploads, 2); assert.equal(receipt.resourcesReleased, false);
  assert.equal(receipt.successorAllowed, false); assert.equal(receipt.manualActionRequired, true);
  assert.deepEqual(clone(receipt.retainedTabs), [7]);
  assert.equal(h.store.unsyncedRecords[0].synced, false);
  assert.equal((await h.execute(prepared.handle)).accepted, false);
});

test('blocked stop/inspect page channel cannot block accepted stop or inspection and never manufactures quiescence', async () => {
  const h = harness(); await h.bind(); await h.operation();
  const gate = deferred(); h.blockedPageControl = gate;
  const prepared = await h.prepare();
  assert.equal((await promptly(h.execute(prepared.handle))).accepted, true);
  await h.scoped('owner-settled', {runnerQuiesced: true, pendingUploads: 0});
  assert.equal((await promptly(h.inspect())).sourceStopped, false);
  assert.equal(h.store[KEY].phase, 'draining');
  h.blockedPageControl = null; gate.resolve(); await tick();
  await h.inspect(); await tick();
  assert.equal((await h.inspect()).sourceStopped, true);
});

test('lost post-effect relay acknowledgement retains unknown operation and cannot become source stopped', async () => {
  const h = harness({loseRelayReply: true}); await h.bind();
  const result = await h.operation();
  assert.equal(result.accepted, false);
  assert.equal(h.effects.length, 1);
  assert.equal(h.store[KEY].operations[0].state, 'unknown');
  assert.equal(h.store[KEY].phase, 'quarantined');
  await tick();
  await h.scoped('owner-settled', {runnerQuiesced: true, pendingUploads: 0});
  const receipt = await h.inspect();
  assert.equal(receipt.sourceStopped, false); assert.equal(receipt.successorAllowed, false);
});

test('exact external script reservation survives stop and only its real settlement releases the operation', async () => {
  const h = harness(); await h.bind();
  const reserved = await h.operation('executeScript'); assert.equal(reserved.accepted, true);
  const prepared = await h.prepare(); await h.execute(prepared.handle); await tick();
  await h.scoped('owner-settled', {runnerQuiesced: true, pendingUploads: 0});
  assert.equal((await h.inspect()).sourceStopped, false);
  assert.equal((await h.scoped('operation-settled', {operationId: reserved.operationId,
    pageControl: {...reserved.pageControl, activationId: 'wrong'}})).accepted, false);
  assert.equal((await h.scoped('operation-settled', {operationId: reserved.operationId,
    pageControl: reserved.pageControl})).ok, true);
  await h.inspect(); await tick();
  assert.equal((await h.inspect()).sourceStopped, true);
});

test('navigation waits for a new document handshake while the old BFCache document stays irreversibly stopped', async () => {
  const gate = deferred(); const h = harness({navigationGate: gate}); await h.bind();
  let finished = false;
  const navigating = h.operation('navigate', {url: 'https://www.douyin.com/search/next'}).then(value => {finished = true; return value;});
  for (let n = 0; n < 10 && !h.pageFor('page-a').isStopped(); n += 1) await tick();
  assert.equal(h.pageFor('page-a').inspect().quiesced, true);
  assert.equal(finished, false);
  assert.equal(h.store[KEY].operations.length, 1);
  gate.resolve();
  const result = await navigating; assert.equal(result.accepted, true);
  assert.equal(result.result.documentId, 'page-a-next');
  assert.equal(h.pageFor('page-a').isStopped(), true);
  assert.equal(h.pageFor('page-a-next').isStrict(), true);
  assert.equal(h.pageFor('page-a-next').isStopped(), false);
  assert.equal(h.store[KEY].operations.length, 0);
  assert.equal(h.store[KEY].pages[0].documentId, 'page-a-next');
});

test('over 300 completed operations and 100 owner activities compact pending rows but retain replay watermarks', async () => {
  const h = harness(); await h.bind();
  for (let index = 0; index < 305; index += 1) {
    assert.equal((await h.operation()).ok, true, `operation ${index + 1}`);
    assert.equal(h.store[KEY].operations.length, 0);
  }
  assert.equal(h.store[KEY].operationWatermark, 305);
  assert.equal((await h.operation('relay', {action: 'captureSingleNote'}, {operationSeq: 300})).accepted, false);
  for (let index = 0; index < 105; index += 1) {
    const activityId = randomUUID();
    assert.equal((await h.beginActivity(activityId)).ok, true);
    assert.equal((await h.scoped('owner-activity-end', {activityId})).ok, true);
    assert.equal(h.store[KEY].activities.length, 0);
  }
  assert.equal(h.store[KEY].activityWatermark, 105);
  assert.equal((await h.beginActivity(randomUUID(), {activitySeq: 100})).accepted, false);
});

for (const [name, mutateInitial] of [
  ['different reservation owner document', state => {state.lock.holderDocumentId = 'other';}],
  ['different reservation runner tab', state => {state.lock.holderTabId = 99;}],
  ['expired reservation', state => {state.lock.expiresAt = 0;}],
  ['different already-bound task', state => {state.lock.captureTaskId = 'other'; state.lock.captureTaskAttemptId = randomUUID();}],
  ['duplicate raw ledger source', state => {state.ledger.runs.push(clone(state.ledger.runs[0]));}],
  ['mismatched raw source revision', state => {state.ledger.runs[0].updatedAt = '2026-09-05T12:00:00.000Z';}],
]) {
  test(`admission rejects ${name} without accepting or changing reservation`, async () => {
    const h = harness({mutateInitial}); const original = clone(h.store.lock);
    assert.equal((await h.bind()).accepted, false);
    assert.equal(h.store[KEY], undefined); assert.deepEqual(h.store.lock, original);
    assert.deepEqual(h.effects, []);
  });
}

for (const [name, mutate] of [
  ['auth rotation', h => {h.store.auth.authMutationId = 'new-auth';}],
  ['owner lock replacement', h => {h.store.lock.id = 'new-lock';}],
  ['attempt replacement', h => {h.store.request.attemptId = randomUUID();}],
  ['source progress replacement', h => {h.store.request.progressSeq += 1;}],
]) {
  test(`prepared command refuses ${name} before durable stop acceptance`, async () => {
    const h = harness(); await h.bind(); const prepared = await h.prepare();
    mutate(h);
    assert.equal((await h.execute(prepared.handle)).accepted, false);
    assert.equal(h.store[KEY].phase, 'active'); assert.deepEqual(h.ownerMessages, []);
  });
}

test('new worker epoch cannot adopt old in-memory authority or bypass retained legacy fence', async () => {
  const h = harness(); await h.bind(); const restarted = h.makeControl('worker-b');
  assert.equal(await restarted.guardLegacy(), true);
  assert.equal(await restarted.guardScope(h.scope, h.sender), false);
  assert.equal((await h.send({type: PREFIX + 'page-operation', strictControl: h.scope,
    operationId: randomUUID(), operationSeq: 1, kind: 'relay', tabId: 7,
    payload: {action: 'captureSingleNote'}}, h.sender, restarted)).accepted, false);
  assert.deepEqual(h.effects, []);
});

for (const patch of [{id: 'foreign-extension'}, {documentLifecycle: 'cached'}, {frameId: 1},
  {url: 'https://www.douyin.com/search/x'}, {url: 'chrome-extension://fixture-extension/other.html'},
  {documentId: 'unconnected-owner'}]) {
  test(`exact owner sender fails closed for ${JSON.stringify(patch)}`, async () => {
    const h = harness();
    const result = await h.send({type: PREFIX + 'owner-bind', requestId: h.requestId,
      attemptId: h.attemptId}, {...h.sender, ...patch});
    assert.equal(result.accepted, false); assert.equal(h.store[KEY], undefined);
  });
}

test('quota failure before atomic admission leaves journal absent and existing reservation untouched', async () => {
  const h = harness(); const original = clone(h.store.lock);
  h.beforeSet = () => {throw new Error('synthetic quota failure');};
  const result = await h.bind();
  assert.equal(result.accepted, false); assert.equal(h.store[KEY], undefined);
  assert.deepEqual(h.store.lock, original); assert.equal(h.writes.length, 0);
});

test('quota failure committing stop intent cannot acknowledge acceptance or signal the owner', async () => {
  const h = harness(); await h.bind(); const prepared = await h.prepare();
  h.beforeSet = patch => {if (patch[KEY]?.phase === 'stop_requested') throw new Error('synthetic quota failure');};
  const result = await h.execute(prepared.handle);
  assert.equal(result.accepted, false); assert.equal(h.store[KEY].phase, 'active');
  assert.equal(h.ownerMessages.length, 0);
});

test('source replacement while online admission is pending fails final CAS without holding locks across authority', async () => {
  const h = harness(); const gate = deferred(); h.beforeAuthority = () => gate.promise;
  const binding = h.bind();
  for (let n = 0; n < 10 && h.queryCalls.length === 0; n += 1) await tick();
  h.store.lock.id = 'new-reservation'; gate.resolve();
  assert.equal((await binding).accepted, false);
  assert.equal(h.store[KEY], undefined);
  assert.equal(h.store.lock.captureTaskId, '');
});

for (const [name, mutate] of [
  ['missing current raw ledger row', h => {h.store.ledger.runs = [];}],
  ['terminal current request', h => {h.store.request.status = 'completed';}],
  ['current source also archived', h => {h.store.archive.requests[h.requestId] = clone(h.store.request);}],
  ['task platform replaced', h => {h.store.request.planSnapshot.platform = 'xiaohongshu';}],
]) {
  test(`live producer refuses ${name} after binding instead of trusting stale admission`, async () => {
    const h = harness(); await h.bind(); mutate(h);
    const result = await h.operation();
    assert.equal(result.accepted, false);
    assert.equal(h.effects.length, 0);
    assert.equal(await h.control.guardScope(h.scope, h.sender), false);
  });
}

test('stop winning a pending handshake records and stops its exact late page without running its capture', async () => {
  const gate = deferred(); const h = harness({pageHandshakeGate: gate}); await h.bind();
  const operating = h.operation();
  for (let n = 0; n < 10 && !h.pageCalls.some(call => call.message.action === 'onstarvoice:page-control-handshake'); n += 1) await tick();
  const prepared = await h.prepare();
  assert.equal((await promptly(h.execute(prepared.handle))).accepted, true);
  gate.resolve();
  assert.equal((await operating).accepted, false);
  await tick();
  assert.equal(h.pageFor('page-a').isStopped(), true);
  assert.equal(h.effects.length, 0);
  assert.equal(h.store[KEY].pages.length, 1);
  assert.equal(h.store[KEY].operations[0].state, 'unknown');
});

test('a tab creation finishing after stop is retained and refused, never compensatingly closed', async () => {
  const gate = deferred(); const h = harness({createGate: gate}); await h.bind();
  const creating = h.operation('create', {url: 'https://www.douyin.com/search/next'});
  for (let n = 0; n < 10 && !h.effects.length; n += 1) await tick();
  const prepared = await h.prepare(); await h.execute(prepared.handle);
  gate.resolve();
  assert.equal((await creating).accepted, false);
  assert.deepEqual(h.store[KEY].retainedTabs, [7, 19], 'owner shell and late-created page stay retained');
  assert.equal(h.effects.filter(effect => effect[0] === 'create').length, 1);
  await h.scoped('owner-settled', {runnerQuiesced: true, pendingUploads: 0});
  const receipt = await h.inspect();
  assert.equal(receipt.resourcesReleased, false); assert.equal(receipt.successorAllowed, false);
  assert.deepEqual(clone(receipt.retainedTabs), [7, 19]);
});

test('an unrelated user tab cannot be adopted by a stale runtime tabId', async () => {
  const h = harness(); await h.bind();
  h.documents.set(666, 'user-document');
  const result = await h.operation('relay', {action: 'captureSingleNote'}, {tabId: 666});
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'strict_tab_not_owned');
  assert.equal(h.pageCalls.some(call => call.tabId === 666), false);
  assert.equal(h.effects.length, 0);
});

for (const reason of ['auth_rotation', 'worker_restart']) {
  test(`fail-safe ${reason} stops existing exact pages without adopting or releasing them`, async () => {
    const h = harness(); await h.bind();
    await h.operation('relay', {action: 'captureSingleNote', withChild: true});
    let control = h.control;
    if (reason === 'auth_rotation') h.store.auth.authMutationId = 'rotated-auth';
    else control = h.makeControl('worker-after-restart');
    await control.reconcileWitness(); await tick();
    assert.equal(h.store[KEY].phase, 'quarantined');
    assert.equal(h.pageFor('page-a').isStopped(), true);
    assert.equal(h.pageFor('page-a').inspect().quiesced, false);
    assert.equal(await control.guardLegacy(), true);
    assert.equal(await control.guardScope(h.scope, h.sender), false);
    h.child.resolve(); await tick();
    const receipt = await h.send({type: INSPECT}, h.sender, control);
    assert.equal(receipt.sourceStopped, false);
    assert.equal(receipt.accepted, false);
    assert.equal(h.store[KEY].pages.length, 1);
  });
}

test('final source receipt is refused if the raw ledger source disappears after physical drain', async () => {
  const h = harness(); await h.bind(); await h.operation();
  const prepared = await h.prepare(); await h.execute(prepared.handle); await tick();
  await h.scoped('owner-settled', {runnerQuiesced: true, pendingUploads: 0});
  await h.inspect(); await tick();
  h.store.ledger.runs = [];
  const receipt = await h.inspect();
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.sourceStopped, false);
});

test('stop intent CAS cannot overtake final dispatch validation and then permit a new page dispatch', async () => {
  const h = harness(); await h.bind();
  const prepared = await h.prepare();
  const finalRead = deferred(), releaseRead = deferred();
  h.beforeGet = async (_keys, {held}) => {
    if (!held.includes('onstarvoice:control-state-v1') || h.store[KEY]?.pages.length !== 1
      || h.store[KEY]?.phase !== 'active' || h.store[KEY]?.operations.length !== 1) return;
    h.beforeGet = null;
    finalRead.resolve();
    await releaseRead.promise;
  };
  const operating = h.operation();
  await promptly(finalRead.promise);
  const stopping = h.execute(prepared.handle);
  // Let the exact stop reauthorization finish and its final CAS queue behind the
  // existing validation read, while that read still owns Auth/Q.
  for (let n = 0; n < 10 && h.queryCalls.length < 3; n += 1) await tick();
  assert.equal(h.queryCalls.length, 3);
  await tick();
  releaseRead.resolve();
  await Promise.all([operating, stopping]);
  const actual = h.pageCalls.filter(call => call.message.action === 'captureSingleNote');
  assert.ok(actual.every(call => call.journalPhaseAtDispatch === 'active'),
    `no new dispatch after durable stop: ${JSON.stringify(actual.map(call => call.journalPhaseAtDispatch))}`);
});

test('dispatch gate releases immediately after real page work starts, so a hung page cannot block stop CAS', async () => {
  const gate = deferred(); const h = harness({relayGate: gate}); await h.bind();
  const operating = h.operation();
  for (let n = 0; n < 10 && !h.effects.length; n += 1) await tick();
  assert.equal(h.effects.length, 1);
  assert.equal(h.pageFor('page-a').inspect().topLevelCount, 1);
  const prepared = await h.prepare();
  const result = await promptly(h.execute(prepared.handle));
  assert.equal(result.accepted, true);
  await tick();
  assert.equal(h.pageFor('page-a').isStopped(), true);
  assert.equal(h.store[KEY].operations.length, 1);
  await h.scoped('owner-settled', {runnerQuiesced: true, pendingUploads: 0});
  assert.equal((await promptly(h.inspect())).sourceStopped, false);
  gate.resolve(); await operating; await tick();
  await h.inspect(); await tick();
  assert.equal((await h.inspect()).sourceStopped, true);
});

const AUTH_LOCK = 'onstarvoice:auth-state';
const CONTROL_LOCK = 'onstarvoice:control-state-v1';
const RESERVATION_LOCK = 'fixture:capture-execution-lock';
const lockCycle = names => [
  ...names.map(name => ['enter', name]),
  ...[...names].reverse().map(name => ['leave', name]),
];

test('atomic bind acquires Auth -> reservation -> Q, while an ordinary owner transaction never enters reservation', async () => {
  const h = harness();
  h.beforeSet = patch => {
    if (patch.lock) assert.deepEqual(h.heldLocks(), [AUTH_LOCK, RESERVATION_LOCK, CONTROL_LOCK]);
  };
  assert.equal((await h.bind()).ok, true);
  assert.deepEqual(h.lockEvents, lockCycle([AUTH_LOCK, RESERVATION_LOCK, CONTROL_LOCK]));
  h.lockEvents.length = 0;
  assert.equal((await h.beginActivity()).ok, true);
  assert.deepEqual(h.lockEvents, lockCycle([AUTH_LOCK, CONTROL_LOCK]));
});

test('reservation binding without its execution queue port fails before acquiring Auth or invoking the mutation', async () => {
  const h = harness(); let mutated = false;
  const journal = h.context.OnStarvoiceStopJournal.create({storage: h.storage,
    fence: h.context.OnStarvoiceControlStateFence, keys: h.keys});
  await assert.rejects(journal.transact(() => {mutated = true;}, {bindReservation: true}),
    /strict_reservation_queue_unavailable/);
  assert.equal(mutated, false);
  assert.deepEqual(h.lockEvents, []);
  assert.deepEqual(h.writes, []);
});

// Model the existing release's Auth -> execution queue, including its retained
// journal check. The fixture shares a real queued mutex with strict admission;
// a callback-only stub could not catch an inverted lock acquisition here.
function legacyRelease(h, beforeRelease = async () => {}) {
  return h.context.OnStarvoiceControlStateFence.runAuth(() => h.runReservationOperation(async () => {
    assert.deepEqual(h.heldLocks(), [AUTH_LOCK, RESERVATION_LOCK]);
    await beforeRelease();
    const state = await h.storage.get([KEY, 'lock']);
    if (state[KEY]) return false;
    await h.storage.set({lock: null});
    return true;
  }), {strict: true});
}

test('legacy Auth -> reservation release winning admission cannot deadlock or resurrect its released lock', async () => {
  const h = harness(); const entered = deferred(), releaseGate = deferred();
  const releasing = legacyRelease(h, async () => {entered.resolve(); await releaseGate.promise;});
  await promptly(entered.promise);
  const binding = h.bind();
  for (let n = 0; n < 10 && !h.queryCalls.length; n += 1) await tick();
  assert.equal(h.queryCalls.length, 1, 'admission reaches online authority without owning another lock');
  assert.equal(h.store[KEY], undefined);
  assert.deepEqual(h.lockEvents, [['enter', AUTH_LOCK], ['enter', RESERVATION_LOCK]]);
  releaseGate.resolve();
  const [released, bound] = await promptly(Promise.all([releasing, binding]));
  assert.equal(released, true); assert.equal(bound.accepted, false);
  assert.equal(h.store.lock, null); assert.equal(h.store[KEY], undefined);
  assert.deepEqual(h.writes, [{lock: null}]);
  assert.deepEqual(h.lockEvents, [
    ...lockCycle([AUTH_LOCK, RESERVATION_LOCK]),
    ...lockCycle([AUTH_LOCK, RESERVATION_LOCK, CONTROL_LOCK]),
  ]);
});

test('atomic bind winning legacy release cannot deadlock or let the late release erase the retained reservation', async () => {
  const h = harness(); const entered = deferred(), commitGate = deferred();
  h.beforeSet = async patch => {
    if (!patch[KEY] || !patch.lock) return;
    assert.deepEqual(h.heldLocks(), [AUTH_LOCK, RESERVATION_LOCK, CONTROL_LOCK]);
    entered.resolve(); await commitGate.promise;
  };
  const binding = h.bind();
  await promptly(entered.promise);
  const releasing = legacyRelease(h);
  await tick();
  assert.deepEqual(h.lockEvents, [
    ['enter', AUTH_LOCK], ['enter', RESERVATION_LOCK], ['enter', CONTROL_LOCK],
  ]);
  assert.deepEqual(h.writes, []);
  commitGate.resolve();
  const [bound, released] = await promptly(Promise.all([binding, releasing]));
  assert.equal(bound.ok, true); assert.equal(released, false);
  assert.equal(h.store.lock.captureTaskId, `unattended-capture:${h.requestId}`);
  assert.equal(h.store.lock.captureTaskAttemptId, h.attemptId);
  assert.equal(h.store[KEY].phase, 'active');
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.lockEvents, [
    ...lockCycle([AUTH_LOCK, RESERVATION_LOCK, CONTROL_LOCK]),
    ...lockCycle([AUTH_LOCK, RESERVATION_LOCK]),
  ]);
});
