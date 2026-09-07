// Recovery modes run through the real local writer/source/stop/claim modules.
// Only checkpoint observations and the original running reservation are memory
// fixtures. Proofs are never manufactured, rewritten or borrowed from cloud.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createLocalRecoveryHarness, LOCAL_KEYS, clone} from '../helpers/local-recovery-harness.mjs';
import {consumeLocalRecoveryOwnerHandoff} from '../../sidebar/recovery-runner-gate.js';
import {createPageOperationClient} from '../../utils/capture/page-operation-client.js';

const keywords = ['completed', 'failed-one', 'failed-two', 'current', 'remaining'];
function checkpoint({current = 'current', failed = true, results = true} = {}) {
  return {schemaVersion: 1, round: 2, activeKeywordIndex: 3, keywordIndex: 3,
    activeKeyword: current, currentKeyword: current, activePhase: 'capturing', phase: 'capturing',
    keywordResults: results ? [
      {round: 2, index: 0, keyword: 'completed', status: 'completed', attemptCount: 1, savedCount: 1},
      ...(failed ? [
        {round: 2, index: 1, keyword: 'failed-one', status: 'failed', attemptCount: 2},
        {round: 2, index: 2, keyword: 'failed-two', status: 'partial', attemptCount: 1},
      ] : []),
      ...(current ? [{round: 2, index: 3, keyword: current, status: 'running', attemptCount: 1}] : []),
    ] : [],
    completedKeywords: results ? ['completed'] : [],
    failedKeywords: failed ? ['failed-one', 'failed-two'] : [], skippedKeywords: [],
    attempts: failed ? {'failed-one': 2, 'failed-two': 1} : {}};
}
async function stoppedModeSource({platform, planKeywords = keywords, progress = checkpoint()} = {}) {
  const h = createLocalRecoveryHarness();
  assert.equal((await h.savePlan({platform, keywords: planKeywords,
    autoLoop: true, maxRounds: 3, roundGapMin: 2})).ok, true);
  assert.equal((await h.createOriginal()).handled, true);
  const originalProof = clone(h.store[LOCAL_KEYS.origin]);
  h.advance(1);
  // Marked fixture seam: saved observations only, projected with the original
  // task-center implementation before real original bind/stop. No proof writes.
  await h.journal.localTransaction(state => {
    const request = {...state.request, checkpoint: clone(progress), updatedAt: new Date(h.now()).toISOString()};
    return {patch: {request, ledger: h.project(state.ledger, request, state.request)}, result: true};
  });
  assert.deepEqual(h.store[LOCAL_KEYS.origin], originalProof);
  h.original = await h.originalRunning();
  assert.equal(h.original.result.ok, true, JSON.stringify(h.original.result));
  await h.original.client.runProducer('synthetic-existing-mode-source', async () => 'no-page-observations');
  await h.stopOriginal(h.original);
  h.originalProof = clone(h.store[LOCAL_KEYS.origin].request);
  h.originalRequest = clone(h.store.request);
  h.originalJournal = clone(h.store[LOCAL_KEYS.journal]);
  assert.equal(h.originalJournal.receipt.sourceStopped, true);
  assert.equal(h.creates.length, 0); assert.equal(h.pageEffects.length, 0);
  return h;
}

for (const platform of ['xiaohongshu', 'douyin']) {
  for (const mode of ['remaining', 'failed', 'skip_current']) {
    test(`${platform} ${mode}: real local mode -> gate claim -> matching generation 2 source -> accurate stop`, async () => {
      const h = await stoppedModeSource({platform});
      const protectedRecords = clone(h.store.unsyncedRecords), protectedOutbox = clone(h.store.checkpointOutbox);
      const prepared = await h.prepare(mode);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      const pending = clone(h.store[LOCAL_KEYS.launch].request);
      assert.equal(pending.recoveryMode, mode);
      assert.equal(pending.parentRequestId, h.originalRequest.id);
      assert.equal(h.store.request.id, h.originalRequest.id, 'planning is not an early successor claim');
      assert.deepEqual(h.store[LOCAL_KEYS.origin].request, h.originalProof);
      const expectedKeywords = mode === 'failed' ? ['failed-one', 'failed-two']
        : mode === 'skip_current' ? keywords.filter(value => value !== 'current') : keywords;
      assert.deepEqual(pending.planSnapshot.keywords, expectedKeywords);
      if (mode === 'failed') {
        assert.equal(pending.planSnapshot.autoLoop, false);
        assert.equal(pending.planSnapshot.maxRounds, 1);
        assert.equal(pending.planSnapshot.roundGapMin, 0);
        assert.deepEqual(pending.checkpoint.keywordResults, []);
        assert.deepEqual(pending.checkpoint.failedKeywords, []);
        assert.equal(pending.checkpoint.round, 1);
        assert.equal(pending.checkpoint.activeKeywordIndex, 0);
      } else if (mode === 'skip_current') {
        assert.equal(pending.planSnapshot.autoLoop, true);
        assert.equal(pending.planSnapshot.maxRounds, 3);
        assert.deepEqual(pending.checkpoint.skippedKeywords, ['current']);
        assert.equal(pending.checkpoint.keywordResults.find(row => row.keyword === 'current').status, 'skipped');
        assert.equal(pending.checkpoint.activeKeyword, '');
        assert.equal(pending.checkpoint.currentKeyword, '');
        assert.equal(pending.checkpoint.activeKeywordIndex, 4);
      } else {
        assert.deepEqual(pending.checkpoint, h.originalRequest.checkpoint);
        assert.equal(pending.planSnapshot.autoLoop, true);
        assert.equal(pending.planSnapshot.maxRounds, 3);
      }
      const shell = h.shell(), handoff = consumeLocalRecoveryOwnerHandoff(await shell.start());
      const control = handoff.claim.strictControl;
      assert.equal(control.generation, 2);
      assert.equal(control.ownerDocumentId, shell.from.documentId);
      assert.equal(handoff.port, shell.connected[0].client);
      const state = await h.journal.read();
      const proof = h.context.OnStarvoiceLocalCaptureSource.requestProof(state);
      assert.equal(proof.generation, 2);
      assert.equal(proof.originId, h.originalProof.originId);
      assert.equal(proof.sourceRequestId, h.originalRequest.id);
      assert.equal(proof.sourceAttemptId, h.originalRequest.attemptId);
      assert.equal(proof.launchIntentId, prepared.launchIntentId);
      assert.deepEqual(clone(proof.planSnapshot.keywords), expectedKeywords);
      const actualFingerprint = await h.context.OnStarvoiceLocalCaptureAuthority.hash(
        h.context.OnStarvoiceLocalCaptureSource.planIdentity(state.request.planSnapshot));
      assert.equal(proof.planFingerprint, actualFingerprint);
      if (mode === 'remaining') assert.equal(proof.planFingerprint, h.originalProof.planFingerprint);
      else assert.notEqual(proof.planFingerprint, h.originalProof.planFingerprint,
        'changed keyword plan must mint its own actual derived fingerprint');
      assert.deepEqual(state.origin.plan, h.store[LOCAL_KEYS.origin].plan);
      assert.equal(state.origin.plan.planFingerprint, h.originalProof.planFingerprint,
        'original authored plan proof is retained, not rewritten to spoof a new source');
      const row = state.ledger.runs.find(entry => entry.id === control.requestId);
      assert.equal(row.attemptId, control.attemptId);
      assert.equal(row.status, 'running'); assert.equal(row.attemptNumber, 2);
      assert.equal(row.source, 'unattended_supervisor');
      assert.deepEqual(row.metadata.keywords, expectedKeywords);
      assert.equal(row.metadata.recoveryMode, mode);
      assert.equal(row.metadata.parentRequestId, h.originalRequest.id);
      assert.equal(row.metadata.cloudAssigned, false); assert.equal(row.metadata.cloudCommandId, '');
      assert.equal(row.metadata.cloudAgentScopeId, h.binding.agentId);
      assert.equal(await h.captureControl.guardScope(control, shell.from), true,
        'derived request, ledger, private witness and exact owner all match');
      const candidate = h.localSource.candidate(state);
      assert.equal(candidate.source.attemptNumber, 2);
      assert.equal(candidate.local, true);
      const evaluated = await h.localSource.evaluate(candidate, 'stop_local_capture');
      assert.equal(evaluated.authority.source.planFingerprint, actualFingerprint);
      const client = createPageOperationClient({strictControl: control, chromeApi: shell.chromeApi});
      handoff.attach({onStop: message => client.stop(message.strictControl, message.reason),
        onDisconnect: () => client.stop(control, 'synthetic-runner-disconnected')});
      await client.runProducer(`synthetic-derived-${mode}`, async () => 'no-platform-operation');
      assert.equal(h.pageEffects.length, 0);
      const receipt = await h.stopOriginal({from: shell.from, control, client});
      assert.equal(receipt.requestId, control.requestId);
      assert.equal(receipt.attemptId, control.attemptId);
      assert.equal(receipt.generation, 2);
      assert.equal(receipt.sourceStopped, true); assert.equal(receipt.runnerQuiesced, true);
      assert.equal(receipt.resourcesReleased, false); assert.equal(receipt.successorAllowed, false);
      assert.equal(receipt.pendingUploads, 1);
      assert.equal(h.store[LOCAL_KEYS.journal].phase, 'stopped');
      assert.equal(h.store[LOCAL_KEYS.journal].ownerReleased, true);
      assert.deepEqual(h.store[LOCAL_KEYS.journal].retired, [h.originalJournal]);
      const successorQueries = h.queries.filter(query => query.source.generation === 2);
      assert.equal(successorQueries.length, 3, 'candidate evaluation plus accurate stop prepare/execute');
      for (const query of successorQueries) {
        assert.equal(query.action, 'stop_local_capture');
        assert.equal(query.source.requestId, control.requestId);
        assert.equal(query.source.attemptId, control.attemptId);
        assert.equal(query.source.planFingerprint, actualFingerprint);
      }
      assert.equal(h.creates.length, 1); assert.equal(h.creates[0].active, false);
      assert.equal(h.pageEffects.length, 0);
      assert.deepEqual(h.store.unsyncedRecords, protectedRecords);
      assert.deepEqual(h.store.checkpointOutbox, protectedOutbox);
      assert.equal((await h.prepare(mode)).ok, false, 'third-generation recovery is outside this one-successor contract');
      assert.equal(h.creates.length, 1);
    });
  }
  for (const scenario of [
    {mode: 'failed', reason: 'no_failed_keywords', progress: checkpoint({failed: false})},
    {mode: 'skip_current', reason: 'no_current_keyword', progress: checkpoint({current: ''})},
    {mode: 'skip_current', reason: 'no_remaining_keywords', planKeywords: ['current'],
      progress: checkpoint({failed: false, results: false})},
  ]) test(`${platform} ${scenario.reason}: true stopped source cannot create an empty recovery shell`, async () => {
    const h = await stoppedModeSource({platform, ...scenario});
    const before = clone(h.store), queryCount = h.queries.length;
    const result = await h.prepare(scenario.mode);
    assert.equal(result.ok, false);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, scenario.reason);
    assert.equal(h.creates.length, 0); assert.equal(h.pageEffects.length, 0);
    assert.equal(h.store[LOCAL_KEYS.launch], undefined);
    assert.deepEqual(h.store, before, 'invalid modes retain exact stopped source/lock/proofs/outbox');
    assert.equal(h.queries.length, queryCount, 'no recovery permission request for an empty derived plan');
  });
}
