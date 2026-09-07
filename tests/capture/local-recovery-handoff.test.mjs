import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createLocalRecoveryHarness, LOCAL_KEYS, clone, deferred, tick, until} from '../helpers/local-recovery-harness.mjs';
import {consumeLocalRecoveryOwnerHandoff} from '../../sidebar/recovery-runner-gate.js';
import {createOwnerController} from '../../sidebar/task-controller/owner.js';
import {createUnattendedRunController} from '../../sidebar/task-controller/unattended-run.js';

async function preparedHarness() {
  const h = createLocalRecoveryHarness();
  h.original = await h.stoppedOriginal();
  h.source = clone(h.store.request);
  h.stopEvidence = clone(h.store[LOCAL_KEYS.journal]);
  h.prepared = await h.prepare();
  assert.equal(h.prepared.ok, true, JSON.stringify(h.prepared));
  return h;
}
function bindMessage(h) {return {type: 'onstarvoice:local-recovery-runner-bind', launchIntentId: h.prepared.launchIntentId, holderId: 'successor-holder'};}
function claimMessage(h) {return {type: 'onstarvoice:local-recovery-runner-claim', launchIntentId: h.prepared.launchIntentId,
  requestId: h.prepared.requestId, attemptId: h.prepared.attemptId, generation: 2, holderId: 'successor-holder'};}
async function activatedHarness() {
  const h = await preparedHarness();
  h.runnerSender = h.shellSender();
  h.runnerConnection = h.connect(h.runnerSender, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  assert.equal((await h.send(bindMessage(h), h.runnerSender)).ok, true);
  await until(() => h.store[LOCAL_KEYS.launch].phase === 'activated', 'final activation');
  return h;
}

test('the actual local save writer and actual background builders/projector establish the only local origin', async () => {
  const h = createLocalRecoveryHarness();
  assert.equal(h.store.request, null);
  assert.equal(h.store[LOCAL_KEYS.origin], undefined);
  assert.equal((await h.savePlan()).ok, true);
  assert.equal(h.store.request, null, 'save does not claim or create a request');
  assert.equal(h.creates.length, 0);
  const created = await h.createOriginal();
  assert.equal(created.handled, true);
  assert.equal(created.request.status, 'pending');
  assert.equal(h.store.ledger.runs.length, 1);
  assert.equal(h.store.ledger.runs[0].metadata.cloudAgentScopeId, h.binding.agentId);
  assert.equal(h.store.ledger.runs[0].source, 'unattended_supervisor');
  assert.equal(h.store.ledger.runs[0].metadata.cloudAssigned, false);
  assert.equal(h.context.OnStarvoiceLocalCaptureSource.requestProof(await h.journal.read()).requestId, created.request.id);
  assert.ok(h.builderDeclarations.includes('buildUnattendedTaskRun'));
  assert.ok(h.builderDeclarations.includes('upsertUnattendedTaskLedger'));
  assert.deepEqual(h.queries.map(q => q.action), ['admit_local_plan', 'start_local_capture']);
  assert.equal(h.pageEffects.length, 0);
});

test('true stopped local generation 1 hands off once through the real shell gate and retains exact old evidence', async () => {
  const h = await preparedHarness();
  const savedRecords = clone(h.store.unsyncedRecords), savedOutbox = clone(h.store.checkpointOutbox);
  assert.equal(h.stopEvidence.receipt.sourceStopped, true);
  assert.equal(h.stopEvidence.receipt.successorAllowed, false);
  assert.equal(h.store.request.id, h.source.id, 'prepared successor has not replaced the source');
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'prepared');
  const shell = h.shell();
  const token = await shell.start();
  const handoff = consumeLocalRecoveryOwnerHandoff(token);
  assert.equal(handoff.claim.strictControl.generation, 2);
  assert.equal(handoff.claim.strictControl.ownerDocumentId, shell.from.documentId);
  assert.equal(handoff.port, shell.connected[0].client);
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'claimed');
  assert.equal(h.store.request.id, h.prepared.requestId);
  assert.equal(h.store.request.parentRequestId, h.source.id);
  assert.equal(h.store.request.attemptNumber, 2);
  assert.deepEqual(h.store[LOCAL_KEYS.journal].retired, [h.stopEvidence]);
  assert.equal(h.store.archive.requests[h.source.id].attemptId, h.source.attemptId);
  assert.equal(h.context.OnStarvoiceLocalCaptureSource.requestProof(await h.journal.read()).generation, 2);
  assert.deepEqual(h.store.unsyncedRecords, savedRecords);
  assert.deepEqual(h.store.checkpointOutbox, savedOutbox);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].active, false);
  assert.equal(h.pageEffects.length, 0);
  assert.equal(await h.captureControl.guardLegacy(), true);
  assert.equal((await h.send(claimMessage(h), shell.from)).ok, false, 'second claim cannot start again');
});

test('pending original producer blocks stop proof and recovery until its real promise settles', async () => {
  const h = createLocalRecoveryHarness();
  assert.equal((await h.savePlan()).ok, true);
  await h.createOriginal();
  const original = await h.originalRunning();
  assert.equal(original.result.ok, true);
  const producer = deferred(), entered = deferred();
  const work = original.client.runProducer('pending-synthetic-owner', async () => {entered.resolve(); await producer.promise;});
  await entered.promise;
  const prepared = await h.send({type: 'onstarvoice:prepare-active-capture-stop', action: 'stop_local_capture'}, original.from);
  await h.send({type: 'onstarvoice:execute-active-capture-stop', action: 'stop_local_capture', handle: prepared.handle}, original.from);
  const premature = await h.send({type: 'onstarvoice:strict-owner-settled', strictControl: original.control,
    runnerQuiesced: true, pendingUploads: 1}, original.from);
  assert.equal(premature.ok, false);
  assert.equal((await h.prepare()).ok, false);
  assert.equal(h.creates.length, 0);
  producer.resolve(); await work;
  const drain = await original.client.drain();
  for (const type of ['onstarvoice:strict-owner-settled', 'onstarvoice:strict-owner-release']) {
    assert.equal((await h.send({type, strictControl: original.control, ...drain, pendingUploads: 1}, original.from)).ok, true);
  }
  assert.equal((await h.send({type: 'onstarvoice:inspect-active-capture-stop'}, original.from)).sourceStopped, true);
  assert.equal((await h.prepare()).ok, true);
});

for (const stage of ['save', 'original', 'stop', 'prepare', 'activate', 'claim']) test(`current ${stage} permission denial cannot cross its stage boundary`, async () => {
  const h = createLocalRecoveryHarness();
  const denied = body => {throw new Error(`synthetic_denied_${body.action}`);};
  if (stage === 'save') {
    h.hooks.beforeQuery = denied;
    assert.equal((await h.savePlan()).ok, false);
    assert.equal(h.writes.length, 0);
    return;
  }
  await h.savePlan();
  if (stage === 'original') {
    h.hooks.beforeQuery = denied;
    await assert.rejects(h.createOriginal());
    assert.equal(h.store.request, null);
    return;
  }
  await h.createOriginal();
  const original = await h.originalRunning();
  assert.equal(original.result.ok, true);
  if (stage === 'stop') {
    h.hooks.beforeQuery = denied;
    const result = await h.send({type: 'onstarvoice:prepare-active-capture-stop', action: 'stop_local_capture'}, original.from);
    assert.equal(result.ok, false);
    assert.equal(h.store[LOCAL_KEYS.journal].phase, 'active');
    return;
  }
  await h.stopOriginal(original);
  if (stage === 'prepare') {
    h.hooks.beforeQuery = denied;
    assert.equal((await h.prepare()).ok, false);
    assert.equal(h.creates.length, 0);
    assert.equal(h.store[LOCAL_KEYS.launch], undefined);
    return;
  }
  h.prepared = await h.prepare();
  const from = h.shellSender(), pair = h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  if (stage === 'activate') h.hooks.beforeQuery = denied;
  await h.send(bindMessage(h), from);
  await until(() => ['activated', 'failed'].includes(h.store[LOCAL_KEYS.launch].phase));
  if (stage === 'activate') {
    assert.equal(h.store[LOCAL_KEYS.launch].phase, 'failed');
    assert.equal(pair.outgoing.length, 0);
  } else {
    h.hooks.beforeQuery = denied;
    assert.equal((await h.send(claimMessage(h), from)).ok, false);
    assert.equal(h.store[LOCAL_KEYS.launch].phase, 'activated');
  }
  assert.equal(h.store[LOCAL_KEYS.journal].generation, 1);
  assert.equal(h.pageEffects.length, 0);
});

test('neither prepared nor bound can claim; final activation is an independent permission check', async () => {
  const h = await preparedHarness();
  const from = h.shellSender();
  h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  assert.equal((await h.send(claimMessage(h), from)).ok, false);
  const permission = deferred(), entered = deferred();
  h.hooks.beforeQuery = async () => {entered.resolve(); await permission.promise;};
  assert.equal((await h.send(bindMessage(h), from)).ok, true);
  await entered.promise;
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'runner_bound');
  assert.equal((await h.send(claimMessage(h), from)).ok, false);
  assert.equal(h.store.request.id, h.source.id);
  assert.equal(h.store.lock.holderDocumentId, h.original.from.documentId);
  permission.resolve();
  await until(() => h.store[LOCAL_KEYS.launch].phase === 'activated');
  assert.equal((await h.send(claimMessage(h), from)).ok, true);
});

for (const patch of [{documentId: 'wrong-document'}, {frameId: 1}, {documentLifecycle: 'cached'}, {tab: {id: 999}}]) {
  test(`wrong actual sender ${JSON.stringify(patch)} cannot claim the activated runner`, async () => {
    const h = await activatedHarness();
    assert.equal((await h.send(claimMessage(h), {...h.runnerSender, ...patch})).ok, false);
    assert.equal(h.store[LOCAL_KEYS.journal].generation, 1);
    assert.equal(h.store.request.id, h.source.id);
  });
}

test('concurrent exact claims commit one successor and one lock; replay never dispatches a producer', async () => {
  const h = await activatedHarness();
  const results = await Promise.all([h.send(claimMessage(h), h.runnerSender), h.send(claimMessage(h), h.runnerSender)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(h.writes.filter(patch => patch[LOCAL_KEYS.journal]?.generation === 2).length, 1);
  assert.equal(h.creates.length, 1);
  assert.equal(h.pageEffects.length, 0);
});

for (const phase of ['prepared', 'runner_bound', 'activated', 'claimed']) test(`quota failure at ${phase} never reports a committed successor or cleans old evidence`, async () => {
  const h = phase === 'prepared' ? createLocalRecoveryHarness() : await preparedHarness();
  if (phase === 'prepared') {await h.stoppedOriginal(); h.source = clone(h.store.request);}
  const old = clone(h.store[LOCAL_KEYS.journal]);
  h.hooks.beforeSet = patch => {if (patch[LOCAL_KEYS.launch]?.phase === phase) throw new Error('synthetic quota exhausted');};
  if (phase === 'prepared') {
    assert.equal((await h.prepare()).ok, false);
    assert.equal(h.creates.length, 0);
  } else {
    const from = h.shellSender();
    h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
    const bound = await h.send(bindMessage(h), from);
    if (phase === 'runner_bound') assert.equal(bound.ok, false);
    else {
      await until(() => ['activated', 'failed'].includes(h.store[LOCAL_KEYS.launch].phase));
      if (phase === 'activated') assert.equal(h.store[LOCAL_KEYS.launch].phase, 'failed');
      else assert.equal((await h.send(claimMessage(h), from)).ok, false);
    }
  }
  assert.deepEqual(h.store[LOCAL_KEYS.journal], old);
  assert.equal(h.store.request.id, h.source.id);
  assert.equal(h.store.unsyncedRecords.length, 1);
  assert.equal(h.store.checkpointOutbox.length, 1);
  assert.equal(h.pageEffects.length, 0);
});

test('a worker restart cannot reconstruct the retired stop witness and cannot resume a prepared shell', async () => {
  const h = await preparedHarness();
  h.restart();
  const shell = h.shell();
  await assert.rejects(shell.start());
  assert.equal(h.store[LOCAL_KEYS.journal].generation, 1);
  assert.equal(h.creates.length, 1);
  assert.equal(h.pageEffects.length, 0);
});

for (const mutate of [
  r => {r.cloudAssigned = true;},
  r => {r.cloudCommandId = randomUUID();},
  r => {delete r.cloudAssigned; delete r.cloudCommandId;},
  r => {r.orchestrationContext = {};},
  r => {r.parentRequestId = randomUUID();},
  r => {r.recoveryAdoptionReceipt = {ok: true};},
]) test(`cloud/unknown lineage cannot launder the real local witness: ${mutate.toString()}`, async () => {
  const h = createLocalRecoveryHarness();
  await h.savePlan(); await h.createOriginal();
  mutate(h.store.request);
  const original = await h.originalRunning();
  assert.equal(original.result.ok, false);
  assert.equal(h.store[LOCAL_KEYS.journal], undefined);
  assert.equal(h.creates.length, 0);
});

test('cloud create options never consume or replace a locally authored origin', async () => {
  const h = createLocalRecoveryHarness();
  await h.savePlan();
  const origin = clone(h.store[LOCAL_KEYS.origin]);
  for (const options of [{cloudAssigned: true}, {cloudCommandId: randomUUID()}, {orchestrationContext: {}}]) {
    assert.equal((await h.createOriginal(options)).handled, false);
  }
  assert.equal(h.store.request, null);
  assert.deepEqual(h.store[LOCAL_KEYS.origin], origin);
});

test('late original-owner messages cannot change the new journal, lock or request', async () => {
  const h = await activatedHarness();
  const claimed = await h.send(claimMessage(h), h.runnerSender);
  assert.equal(claimed.ok, true);
  const before = clone(h.store);
  for (const message of [
    {type: 'onstarvoice:strict-owner-release', runnerQuiesced: true, pendingUploads: 0},
    {type: 'onstarvoice:strict-owner-activity-begin', activityId: randomUUID(), activitySeq: 99},
    {type: 'onstarvoice:strict-owner-settled', runnerQuiesced: true, pendingUploads: 0},
  ]) assert.equal((await h.send({...message, strictControl: h.original.control}, h.original.from)).ok, false);
  assert.deepEqual(h.store, before);
});

for (const [name, change] of [
  ['worker epoch', h => {h.store[LOCAL_KEYS.journal].workerEpoch = 'changed-worker';}],
  ['stop receipt request', h => {h.store[LOCAL_KEYS.journal].receipt.requestId = randomUUID();}],
  ['stop receipt attempt', h => {h.store[LOCAL_KEYS.journal].receipt.attemptId = randomUUID();}],
  ['stop receipt generation', h => {h.store[LOCAL_KEYS.journal].receipt.generation = 2;}],
  ['owner document', h => {h.store[LOCAL_KEYS.journal].ownerDocumentId = 'old-document';}],
  ['auth mutation', h => {h.store.auth.authMutationId = 'changed-auth';}],
  ['ledger clear', h => {h.store.ledger.clearedAt = new Date(h.now() + 1000).toISOString();}],
  ['ledger metadata', h => {h.store.ledger.runs[0].metadata.cloudAssigned = true;}],
]) test(`prepare revalidates ${name} after pending online authority`, async () => {
  const h = createLocalRecoveryHarness();
  await h.stoppedOriginal();
  h.hooks.beforeQuery = () => {change(h);};
  assert.equal((await h.prepare()).ok, false);
  assert.equal(h.creates.length, 0);
  assert.equal(h.store[LOCAL_KEYS.launch], undefined);
});

test('client port replacement during permission lookup cannot inherit the old prepare command', async () => {
  const h = createLocalRecoveryHarness();
  await h.stoppedOriginal();
  h.hooks.beforeQuery = () => {
    h.clientConnection.client.disconnect();
    h.connect(h.clientSender, h.context.OnStarvoiceLocalRecovery.CLIENT_PORT);
  };
  const result = await h.prepare();
  assert.equal(result.ok, false);
  assert.equal(h.creates.length, 0);
  assert.equal(h.store[LOCAL_KEYS.launch], undefined);
});

test('an early runner bind cannot lend its prepared acknowledgement to a replacement connection', async () => {
  const h = createLocalRecoveryHarness();
  await h.stoppedOriginal();
  let replacement;
  h.hooks.beforeCreate = async spec => {
    const from = h.shellSender(spec);
    h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
    const bound = await h.send({type: 'onstarvoice:local-recovery-runner-bind', launchIntentId: spec.launchIntentId, holderId: 'successor-holder'}, from);
    assert.equal(bound.phase, 'prepared');
    replacement = h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  };
  assert.equal((await h.prepare()).ok, false);
  await tick(); await tick();
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'failed');
  assert.equal(h.store[LOCAL_KEYS.launch].reason, 'connection_replaced');
  assert.equal(replacement.outgoing.length, 0);
  assert.equal(h.store[LOCAL_KEYS.journal].generation, 1);
});

test('an early bind on the same connection completes only after shell creation is durably recorded', async () => {
  const h = createLocalRecoveryHarness();
  await h.stoppedOriginal();
  let pair;
  h.hooks.beforeCreate = async spec => {
    const from = h.shellSender(spec);
    pair = h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
    const response = await h.send({type: 'onstarvoice:local-recovery-runner-bind', launchIntentId: spec.launchIntentId, holderId: 'successor-holder'}, from);
    assert.equal(response.phase, 'prepared');
    assert.equal(h.store[LOCAL_KEYS.launch].tabId, null);
    assert.equal(pair.outgoing.length, 0);
  };
  assert.equal((await h.prepare()).ok, true);
  await until(() => pair.outgoing.length === 1);
  assert.equal(h.store[LOCAL_KEYS.launch].phase, 'activated');
  assert.equal(h.store[LOCAL_KEYS.journal].generation, 1);
});

for (const stage of ['activate', 'claim']) test(`${stage} permission cannot outlive its original runner connection`, async () => {
  const h = await preparedHarness();
  const from = h.shellSender();
  const pair = h.connect(from, h.context.OnStarvoiceLocalRecovery.RUNNER_PORT);
  const disconnect = () => {pair.client.disconnect();};
  if (stage === 'activate') h.hooks.beforeQuery = disconnect;
  await h.send(bindMessage(h), from);
  await until(() => ['activated', 'failed'].includes(h.store[LOCAL_KEYS.launch].phase));
  if (stage === 'claim') {
    h.hooks.beforeQuery = disconnect;
    assert.equal((await h.send(claimMessage(h), from)).ok, false);
  }
  assert.equal(h.store[LOCAL_KEYS.journal].generation, 1);
  assert.equal(h.store.request.id, h.source.id);
  assert.equal(h.pageEffects.length, 0);
});

test('an expired recover grant cannot open a shell even if its response otherwise matches', async () => {
  const h = createLocalRecoveryHarness();
  await h.stoppedOriginal();
  h.hooks.beforeQuery = () => {h.advance(5001);};
  assert.equal((await h.prepare()).ok, false);
  assert.equal(h.creates.length, 0);
});

test('real save/build/stop/handoff/gate/owner enters the original producer and stops before its first platform operation', async () => {
  const h = await preparedHarness();
  const shell = h.shell(), token = await shell.start();
  const scope = clone(h.store[LOCAL_KEYS.journal]);
  let enteredActualRun = false;
  h.hooks.runtime = async (message, from) => {
    assert.notEqual(message.type, 'onstarvoice:claim-unattended-keyword-run');
    assert.equal(await h.captureControl.guardScope(message.strictControl, from, {allowStopped: true}), true,
      `original persistence/lock seam retains the exact granted owner: ${message.type}`);
    if (message.type === 'onstarvoice:update-unattended-keyword-run') {
      h.advance(1);
      await h.journal.localTransaction(fresh => {
        const request = {...fresh.request, ...message.patch, progressSeq: fresh.request.progressSeq + 1,
          updatedAt: new Date(h.now()).toISOString()};
        return {patch: {request, ledger: h.project(fresh.ledger, request, fresh.request)}, result: true};
      });
      return {ok: true, accepted: true, data: clone(h.store.request)};
    }
    if (['onstarvoice:renew-capture-lock', 'onstarvoice:release-capture-lock'].includes(message.type)) {
      return {ok: true, accepted: true, retained: true};
    }
    if (message.type === 'onstarvoice:record-unattended-local-closure') return {ok: true, accepted: true, reason: 'local_closure_not_required'};
    assert.fail(`unexpected original runner side effect ${message.type}`);
  };
  const state = {captureTaskOwnerClosing: false, unattendedFinalFlushInFlightByIdentity: new Map(),
    unattendedFinalFlushRetryTimersByIdentity: new Map()};
  const ports = {
    chrome: shell.chromeApi, localRecoveryRunnerGate: shell.gate,
    CAPTURE_EXECUTION_LOCK_HOLDER_ID: 'successor-holder', CAPTURE_TASK_OWNER_PORT_NAME: 'legacy-owner',
    UNATTENDED_RUN_QUERY_KEY: 'unattendedRun', UNATTENDED_RUN_ATTEMPT_QUERY_KEY: 'unattendedAttempt',
    TARGETED_POST_RUN_QUERY_KEY: 'targetedPostRun', MAX_BATCH_KEYWORDS: 30,
    UNATTENDED_INITIAL_REPORT_RETRY_DELAYS_MS: [0], UNATTENDED_TERMINAL_REPORT_RETRY_DELAYS_MS: [0],
    UNATTENDED_RUNTIME_MESSAGE_TIMEOUT_MS: 1000, KEYWORD_PLAN_TERMINAL_STATUSES: new Set(['failed']),
    KEYWORD_RUN_REQUEST_STORAGE_KEY: 'request', UNATTENDED_FINAL_FLUSH_INTENT_STORAGE_PREFIX: 'fixture-final:',
    UNATTENDED_FINAL_FLUSH_INTENT_VERSION: 1, UNATTENDED_LOCAL_CLOSURE_READY_STORAGE_PREFIX: 'fixture-ready:',
    UNATTENDED_LOCAL_CLOSURE_READY_VERSION: 1,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    console: {warn() {}, error() {}, debug() {}},
    taskView: {readRunnerLocationSearch: () => new URL(shell.from.url).search},
    getCurrentRuntime: () => ({}), setCancelFlag() {}, showMessage() {}, closeBatchModal() {},
    loadKeywordPlanUI: async () => {},
    getKeywordExecutionCopy: () => ({taskLabel: 'synthetic task', executionMode: 'unattended_plan'}),
    normalizeUnattendedSearchPasses: () => [],
    normalizeUnattendedKeywordCheckpoint: () => ({round: 1, keywordResults: []}),
    findUnattendedResumeKeyword: () => 'synthetic-one',
    summarizeUnattendedKeywordCheckpoint: () => ({}),
    flushUnattendedCheckpointReportOutbox: async () => ({ok: true, remaining: 0}),
    ensureControlStorageReserve: async () => true,
    isUnattendedSafetyBlock: () => false, hasSyncReconciliationSignal: () => false,
    renderCaptureDebugSession() {
      enteredActualRun = true;
      assert.ok(h.messages.some(({message}) => message.type === 'onstarvoice:update-unattended-keyword-run' && message.patch.status === 'running'));
      // An explicit memory port stop at the first platform boundary. The real
      // page-operation client, not this fixture, prevents the subsequent send.
      shell.connected[0].server.postMessage({type: 'capture-owner:strict-stop', strictControl: {
        version: 1, requestId: scope.requestId, attemptId: scope.attemptId, generation: 2, ownerDocumentId: scope.ownerDocumentId,
      }});
    },
  };
  const operations = {dedupeKeywords: values => [...values], supportsPersistentCaptureTaskPlatform: () => true,
    rememberCaptureTaskProgressContext() {}};
  const owner = createOwnerController({controllerState: state, controllerPorts: ports, controllerOperations: operations});
  Object.assign(operations, owner);
  owner.adoptLocalRecoveryRunnerOwner(token);
  const runner = createUnattendedRunController({controllerState: state, controllerPorts: ports, controllerOperations: operations});
  await runner.maybeClaimAndRunUnattendedKeywordPlan({allowPending: true});
  assert.equal(enteredActualRun, true);
  assert.equal(h.store[LOCAL_KEYS.journal].runnerQuiesced, true);
  assert.equal(h.store[LOCAL_KEYS.journal].ownerReleased, true);
  assert.equal(h.store[LOCAL_KEYS.journal].activities.length, 0);
  assert.deepEqual(h.store[LOCAL_KEYS.journal].retired, [h.stopEvidence]);
  assert.equal(h.messages.filter(({message}) => message.type === 'onstarvoice:strict-owner-bind').length, 1, 'only original generation needed BIND');
  assert.equal(h.messages.filter(({message}) => message.type === 'onstarvoice:local-recovery-runner-claim').length, 1);
  assert.equal(h.messages.filter(({message}) => message.type === 'onstarvoice:strict-page-operation').length, 0);
  assert.equal(h.pageEffects.length, 0);
  assert.equal(h.store.unsyncedRecords.length, 1);
  assert.equal(h.store.checkpointOutbox.length, 1);
});
