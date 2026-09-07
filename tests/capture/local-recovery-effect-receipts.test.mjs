import assert from 'node:assert/strict';
import test from 'node:test';
import {createLocalRecoveryHarness, LOCAL_KEYS, clone, tick, until} from '../helpers/local-recovery-harness.mjs';

async function stoppedHarness() {
  const h = createLocalRecoveryHarness();
  await h.stoppedOriginal();
  h.source = clone(h.store.request);
  h.stopEvidence = clone(h.store[LOCAL_KEYS.journal]);
  h.savedRecords = clone(h.store.unsyncedRecords);
  h.savedOutbox = clone(h.store.checkpointOutbox);
  return h;
}

async function activatedHarness() {
  const h = await stoppedHarness();
  h.prepared = await h.prepare();
  assert.equal(h.prepared.ok, true);
  h.runnerSender = h.shellSender();
  h.connect(h.runnerSender, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  const bound = await h.send({type: 'onstarvoice:local-recovery-runner-bind',
    launchIntentId: h.prepared.launchIntentId, holderId: 'successor-holder'}, h.runnerSender);
  assert.equal(bound.ok, true);
  await until(() => h.store[LOCAL_KEYS.launch]?.phase === 'activated');
  return h;
}

function claimMessage(h) {
  return {type: 'onstarvoice:local-recovery-runner-claim', launchIntentId: h.prepared.launchIntentId,
    requestId: h.prepared.requestId, attemptId: h.prepared.attemptId,
    generation: 2, holderId: 'successor-holder'};
}

function rejectAfterCommittedSet(h, matches) {
  const realSet = h.storage.set.bind(h.storage);
  let injections = 0;
  h.storage.set = async patch => {
    await realSet(patch);
    if (matches(patch)) {
      injections += 1;
      throw new Error('synthetic committed storage receipt lost');
    }
  };
  return () => injections;
}

async function assertRetained(h, {generation = 1, shells = 0} = {}) {
  assert.equal(h.store[LOCAL_KEYS.journal].generation, generation);
  if (generation === 1) {
    assert.deepEqual(h.store[LOCAL_KEYS.journal], h.stopEvidence);
    assert.equal(h.store.request.id, h.source.id);
  } else {
    assert.deepEqual(h.store[LOCAL_KEYS.journal].retired, [h.stopEvidence]);
    assert.equal(h.store.archive.requests[h.source.id].attemptId, h.source.attemptId);
  }
  assert.deepEqual(h.store.unsyncedRecords, h.savedRecords);
  assert.deepEqual(h.store.checkpointOutbox, h.savedOutbox);
  assert.equal(h.creates.length, shells);
  assert.equal(h.pageEffects.length, 0);
  assert.equal(await h.captureControl.guardLegacy(), true);
}

function assertEffect(response, expected) {
  assert.equal(response.ok, false);
  assert.equal(response.accepted, false, 'an effect receipt never grants execution');
  assert.equal(response.successorAllowed, false);
  assert.equal(response.phase, expected.observedPhase);
  assert.equal(response.reconciliationPending, true);
  assert.equal(response.resourcesReleased, false);
  assert.equal(response.automaticRetryAllowed, false);
  assert.deepEqual(clone(response.effectReceipt), {
    version: 1, originId: null, launchIntentId: null, requestId: null, attemptId: null,
    observation: 'matched', runnerCreationAttempted: false, runnerTabId: null,
    effectUncertain: true, reconciliationPending: true, resourcesReleased: false,
    automaticRetryAllowed: false, ...expected,
  });
  assert.equal(response.strictControl, undefined, 'a failed acknowledgement contains no owner grant');
}

function launchEffect(h, overrides = {}) {
  const launch = h.store[LOCAL_KEYS.launch];
  return {operation: 'prepare', originId: h.store[LOCAL_KEYS.origin].request.originId,
    launchIntentId: launch.id, requestId: launch.request.id, attemptId: launch.request.attemptId,
    attemptedPhase: 'prepared', observedPhase: 'prepared', ...overrides};
}

test('prepared write committed before rejection is retained and reported, not treated as a no-op denial', async () => {
  const h = await stoppedHarness();
  const injected = rejectAfterCommittedSet(h, patch => patch[LOCAL_KEYS.launch]?.phase === 'prepared');
  const response = await h.prepare();
  assert.equal(injected(), 1);
  assertEffect(response, launchEffect(h));
  assert.equal(h.store[LOCAL_KEYS.launch].tabId, null);
  await assertRetained(h);
  const writes = h.writes.length;
  assert.equal((await h.prepare()).ok, false, 'a repeat cannot replace the retained intent');
  assert.equal(h.writes.length, writes);
  await assertRetained(h);
});

test('a shell created before its creation acknowledgement is lost remains fenced with an unknown resource receipt', async () => {
  const h = await stoppedHarness();
  h.hooks.beforeCreate = () => {throw new Error('synthetic created shell acknowledgement lost');};
  const response = await h.prepare();
  assertEffect(response, launchEffect(h, {runnerCreationAttempted: true}));
  assert.equal(h.store[LOCAL_KEYS.launch].tabId, null, 'a guessed shell ID must not be persisted');
  await assertRetained(h, {shells: 1});
  assert.equal((await h.prepare()).ok, false);
  await tick();
  await assertRetained(h, {shells: 1});
});

test('a confirmed shell survives a rejected tab CAS and is truthfully reported without closing by tab ID', async () => {
  const h = await stoppedHarness();
  h.hooks.beforeSet = patch => {
    if (patch[LOCAL_KEYS.launch]?.phase === 'prepared' && patch[LOCAL_KEYS.launch].tabId !== null) {
      throw new Error('synthetic quota before runner tab CAS');
    }
  };
  const response = await h.prepare();
  assertEffect(response, launchEffect(h, {runnerCreationAttempted: true, runnerTabId: h.creates[0].id}));
  assert.equal(h.store[LOCAL_KEYS.launch].tabId, null);
  await assertRetained(h, {shells: 1});
});

test('a tab CAS committed before rejection reports the observed retained shell and cannot auto-relaunch', async () => {
  const h = await stoppedHarness();
  const injected = rejectAfterCommittedSet(h, patch => patch[LOCAL_KEYS.launch]?.phase === 'prepared' &&
    patch[LOCAL_KEYS.launch].tabId !== null);
  const response = await h.prepare();
  assert.equal(injected(), 1);
  assertEffect(response, launchEffect(h, {runnerCreationAttempted: true, runnerTabId: h.creates[0].id}));
  assert.equal(h.store[LOCAL_KEYS.launch].tabId, h.creates[0].id);
  await assertRetained(h, {shells: 1});
  assert.equal((await h.prepare()).ok, false);
  await tick();
  await assertRetained(h, {shells: 1});
});

test('a durable successor with a lost claim receipt is reported as claimed but never re-grants or replays execution', async () => {
  const h = await activatedHarness();
  const injected = rejectAfterCommittedSet(h, patch => patch[LOCAL_KEYS.launch]?.phase === 'claimed');
  const message = claimMessage(h), response = await h.send(message, h.runnerSender);
  assert.equal(injected(), 1);
  assertEffect(response, launchEffect(h, {operation: 'runner_claim', attemptedPhase: 'claimed',
    observedPhase: 'claimed', runnerTabId: h.runnerSender.tab.id}));
  assert.equal(h.store.request.id, h.prepared.requestId);
  assert.equal(h.store.request.status, 'running');
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'claimed');
  assert.equal(h.store.lock.captureTaskAttemptId, h.prepared.attemptId);
  await assertRetained(h, {generation: 2, shells: 1});
  const writes = h.writes.length, queries = h.queries.length;
  const repeated = await h.send(message, h.runnerSender);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.successorAllowed, false);
  assert.equal(repeated.strictControl, undefined);
  assert.equal(h.writes.length, writes, 'replay must not publish any second generation');
  assert.equal(h.queries.length, queries, 'a committed claim is not automatically reauthorized');
  assert.equal(h.writes.filter(patch => patch[LOCAL_KEYS.journal]?.generation === 2).length, 1);
  await assertRetained(h, {generation: 2, shells: 1});
});

test('the actual dormant shell gate rejects a lost durable claim receipt without legacy fallback or producer work', async () => {
  const h = await stoppedHarness();
  h.prepared = await h.prepare();
  const injected = rejectAfterCommittedSet(h, patch => patch[LOCAL_KEYS.launch]?.phase === 'claimed');
  const shell = h.shell();
  await assert.rejects(shell.start(), {code: 'local_recovery_claim_unconfirmed'});
  await tick();
  assert.equal(injected(), 1);
  assert.throws(() => shell.gate.assertActive(), {code: 'local_recovery_claim_unconfirmed'});
  assert.equal(h.messages.filter(({message}) => message.type === 'onstarvoice:local-recovery-runner-claim').length, 1);
  assert.equal(h.messages.some(({message}) => message.type === 'onstarvoice:claim-unattended-keyword-run'), false);
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'claimed');
  await assertRetained(h, {generation: 2, shells: 1});
});

test('save-plan committed before acknowledgement failure reports the persisted origin without starting a request', async () => {
  const h = createLocalRecoveryHarness();
  const injected = rejectAfterCommittedSet(h, patch => Boolean(patch[LOCAL_KEYS.origin]?.plan));
  const response = await h.savePlan();
  assert.equal(injected(), 1);
  assertEffect(response, {operation: 'save_plan', originId: h.store[LOCAL_KEYS.origin].plan.originId,
    attemptedPhase: 'plan_saved', observedPhase: 'plan_saved'});
  assert.equal(h.store.plan.enabled, true);
  assert.equal(h.store.request, null);
  assert.equal(h.creates.length, 0);
  assert.equal(h.pageEffects.length, 0);
});

test('a failing post-save alarm hook cannot disguise a successfully persisted local plan as a no-op denial', async () => {
  const h = createLocalRecoveryHarness();
  let alarmAttempts = 0;
  const recovery = h.context.OnStarvoiceLocalRecovery.create({journal: h.journal, authority: h.authority,
    captureControl: h.captureControl, extensionId: h.clientSender.id,
    normalizePlan: h.builders.normalizeUnattendedKeywordPlan,
    buildOriginal: h.builders.buildUnattendedKeywordRequest, buildRecovery: h.builders.buildLocalRecoveryRequest,
    project: h.project, createRunner() {assert.fail('save-plan must not create a runner');},
    async afterPlanSaved() {
      alarmAttempts += 1;
      assert.ok(h.store[LOCAL_KEYS.origin]?.plan, 'the real origin writer precedes the alarm hook');
      throw new Error('synthetic alarm acknowledgement lost');
    }, now: h.now});
  assert.equal(recovery.attachPort({name: h.context.OnStarvoiceLocalRecovery.CLIENT_PORT,
    sender: h.clientSender, onDisconnect: {addListener() {}}, disconnect() {}}), true);
  const response = await recovery.handle({type: h.context.OnStarvoiceLocalRecovery.SAVE,
    candidate: true, plan: {enabled: true, platform: 'xiaohongshu', keywords: ['synthetic-one']}}, h.clientSender);
  assert.equal(alarmAttempts, 1);
  assertEffect(response, {operation: 'save_plan', originId: h.store[LOCAL_KEYS.origin].plan.originId,
    attemptedPhase: 'plan_saved', observedPhase: 'plan_saved'});
  assert.equal(h.store.plan.enabled, true);
  assert.equal(h.store.request, null);
  assert.equal(h.creates.length, 0);
  assert.equal(h.pageEffects.length, 0);
});

test('a committed prepare with both write acknowledgement and observation failure remains explicitly unknown', async () => {
  const h = await stoppedHarness();
  const realSet = h.storage.set.bind(h.storage), realGet = h.storage.get.bind(h.storage);
  h.storage.set = async patch => {
    await realSet(patch);
    if (patch[LOCAL_KEYS.launch]?.phase === 'prepared') {
      h.storage.get = async () => {throw new Error('synthetic receipt observation unavailable');};
      throw new Error('synthetic committed prepare acknowledgement lost');
    }
  };
  const writes = h.writes.length;
  const response = await h.prepare();
  assertEffect(response, launchEffect(h, {observation: 'unavailable', observedPhase: 'unknown'}));
  assert.equal(h.writes.length, writes + 1, 'observation failure must not perform compensating writes');
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'prepared', 'unknown never means rolled back');
  h.storage.get = realGet;
  await assertRetained(h);
});

for (const observed of ['different', 'missing', 'unknown-phase', 'object-phase', 'missing-phase']) test(`a ${observed} intent observation cannot turn an ambiguous prepare into a rollback claim`, async () => {
  const h = await stoppedHarness();
  const realSet = h.storage.set.bind(h.storage), realGet = h.storage.get.bind(h.storage);
  h.storage.set = async patch => {
    await realSet(patch);
    if (patch[LOCAL_KEYS.launch]?.phase === 'prepared') {
      h.storage.get = async keys => {
        const current = await realGet(keys);
        if (observed === 'missing') current[LOCAL_KEYS.launch] = null;
        else if (observed === 'different') current[LOCAL_KEYS.launch].id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        else current[LOCAL_KEYS.launch].phase = {
          'unknown-phase': 'unrecognized', 'object-phase': {untrusted: true}, 'missing-phase': undefined,
        }[observed];
        return current;
      };
      throw new Error('synthetic committed prepare acknowledgement lost');
    }
  };
  const writes = h.writes.length;
  const response = await h.prepare();
  assertEffect(response, launchEffect(h, {observation: 'not_matched', observedPhase: 'unknown'}));
  assert.equal(h.writes.length, writes + 1, 'an unrelated observation must not delete or rewrite either intent');
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'prepared');
  h.storage.get = realGet;
  await assertRetained(h);
});
