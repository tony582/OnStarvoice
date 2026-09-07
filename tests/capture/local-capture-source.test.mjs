import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const NOW = Date.parse('2026-09-07T03:00:00.000Z');
const CREATED = new Date(NOW - 2000).toISOString();
const STARTED = new Date(NOW - 1000).toISOString();
const AT = new Date(NOW).toISOString();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
function realm() {
  const context = vm.createContext({Date, TextEncoder, crypto: webcrypto});
  for (const file of ['utils/capture/task-center-projection.js', 'utils/task-center.js',
    'utils/control/active-stop-authority.js', 'utils/control/local-capture-authority.js',
    'utils/control/local-capture-source.js']) {
    vm.runInContext(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), context, {filename: file});
  }
  return context;
}
const context = realm();
const api = context.OnStarvoiceLocalCaptureSource;
const authorityApi = context.OnStarvoiceLocalCaptureAuthority;
async function fixture({generation = 1, platform = 'xiaohongshu'} = {}) {
  const plan = {enabled: true, platform, mode: 'daily', startTime: '09:00', randomOffsetMin: 20,
    keywords: ['甲', '乙'], autoLoop: false, maxRounds: 1, roundGapMin: 10,
    searchFilters: {}, holidayDates: '', customDates: '', updatedAt: CREATED,
    nextRunAt: STARTED, lastRunAt: '', lastRunStatus: '', lastRunMessage: '', lastRunProgress: null};
  const auth = {authMutationId: 'synthetic-auth-mutation', tenant: {id: id(4)},
    captureAgent: {id: id(5), token: 'synthetic-local-source-token'}};
  const proof = {version: 1, kind: 'local-authored-plan', originId: id(1),
    planFingerprint: await authorityApi.hash(api.planIdentity(plan)),
    credentialFingerprint: await authorityApi.hash(auth), authMutationId: auth.authMutationId,
    createdAt: CREATED, binding: {tenantId: id(4), agentId: id(5), authCodeId: id(6),
      authBindingId: id(7), bindingRevision: 'c'.repeat(64)}, planSnapshot: clone(plan),
    requestId: id(generation === 1 ? 2 : 12), attemptId: id(generation === 1 ? 3 : 13),
    requestCreatedAt: STARTED, generation,
    ...(generation === 2 ? {sourceRequestId: id(2), sourceAttemptId: id(3), launchIntentId: id(14)} : {}),
  };
  const request = {id: proof.requestId, attemptId: proof.attemptId, attemptNumber: generation,
    createdAt: STARTED, updatedAt: AT, status: 'running', type: 'keyword_batch',
    cloudAssigned: false, cloudCommandId: '', cloudAgentScopeId: id(5),
    strictControlCandidate: true, planSnapshot: clone(plan), progressSeq: 2, runnerTabId: 21,
    ...(generation === 2 ? {parentRequestId: id(2), localRecoveryIntentId: id(14),
      recoveryReason: 'local_recovery', recoveryMode: 'remaining'} : {}),
  };
  // Match the actual background buildUnattendedTaskRun projection, then use
  // the real task-center normalizer rather than inventing a reduced ledger.
  const row = clone(context.OnStarvoiceTaskCenterCore.normalizeTaskRun({id: request.id,
    taskType: 'unattended_keyword_capture', featureKey: 'unattended_keyword_plan',
    source: 'unattended_supervisor', platform, status: request.status,
    attemptId: request.attemptId, attemptNumber: generation, progressSeq: request.progressSeq,
    createdAt: STARTED, updatedAt: AT, metadata: {cloudAssigned: false,
      cloudAgentScopeId: id(5), cloudCommandId: '', parentRequestId: request.parentRequestId || '',
      recoveryReason: request.recoveryReason || '', recoveryMode: request.recoveryMode || '',
      attemptIdentity: ''},
  }, {now: NOW}));
  const state = {request, origin: {version: 1, request: proof}, auth,
    ledger: {version: 1, runs: [row], clearedAt: ''}, archive: null,
    lock: {id: 'synthetic-lock', owner: 'unattended_keyword_plan', holderId: 'holder',
      holderDocumentId: 'owner-document', holderTabId: 21, expiresAt: NOW + 10000,
      captureTaskId: `unattended-capture:${request.id}`, captureTaskAttemptId: request.attemptId}};
  return state;
}
function journal(state) {
  const p = state.origin.request;
  return {originKind: 'local-v1', originId: p.originId, generation: p.generation,
    requestId: p.requestId, attemptId: p.attemptId, originWitness: authorityApi.canonical(p)};
}
function evaluator() {
  const calls = [];
  const source = api.create({authority: {evaluate: async input => {
    calls.push(clone(input)); return {deadline: NOW + 5000, authority: {action: input.action}};
  }}});
  return {source, calls};
}

for (const generation of [1, 2]) for (const platform of ['xiaohongshu', 'douyin']) {
  test(`positive witnessed local source supports exact stop: generation ${generation}/${platform}`, async () => {
    const state = await fixture({generation, platform}), before = clone(state);
    const {source, calls} = evaluator();
    assert.equal(api.validProof(state.origin.request), true);
    const proof = api.requestProof(state);
    assert.deepEqual(clone(proof), state.origin.request);
    const current = source.candidate(state);
    assert.equal(current.local, true);
    assert.equal(current.source.clientTaskId, state.request.id);
    assert.equal(current.source.clientAttemptId, state.request.attemptId);
    assert.equal(current.source.attemptNumber, generation);
    assert.equal(current.source.platform, platform);
    assert.equal(source.matches(state, journal(state)), true);
    const result = await source.evaluate(current);
    assert.equal(result.authority.action, 'stop_local_capture');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {action: 'stop_local_capture', source: {
      originId: proof.originId, planFingerprint: proof.planFingerprint, platform,
      requestId: state.request.id, attemptId: state.request.attemptId, generation,
      sourceRevision: await authorityApi.hash(current.fingerprint)}, auth: state.auth, expectedBinding: clone(proof.binding)});
    assert.deepEqual(clone(state), before);
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.isFrozen(current.proof.planSnapshot.keywords), true);
    assert.equal(Object.isFrozen(proof), true);
    if (generation === 2) assert.throws(() => api.requestProof(state, {allowSuccessor: false}), /local_lineage_unproven/u);
    else assert.deepEqual(clone(api.requestProof(state, {allowSuccessor: false})), state.origin.request);
  });
}

test('a local flag, mirror, or legacy history cannot manufacture a production witness', async () => {
  for (const origin of [null, {}, {version: 1}, {version: 1, request: {cloudAssigned: false}}]) {
    const state = await fixture(); state.origin = origin;
    assert.throws(() => api.requestProof(state), /local_source_unproven/u);
  }
});

test('plan identity excludes only schedule/run projection fields and preserves authored execution inputs', async () => {
  const state = await fixture(), plan = state.request.planSnapshot;
  const original = clone(api.planIdentity(plan));
  Object.assign(plan, {updatedAt: AT, nextRunAt: AT, lastRunAt: AT, lastRunStatus: 'running',
    lastRunMessage: 'projected', lastRunProgress: {progress: 5}, lastRunRequestId: id(19)});
  assert.deepEqual(clone(api.planIdentity(plan)), original);
  const {source, calls} = evaluator();
  assert.equal((await source.evaluate(source.candidate(state))).authority.action, 'stop_local_capture');
  assert.equal(calls.length, 1);
  for (const key of ['keywords', 'maxRounds', 'searchFilters', 'enabled', 'startTime', 'randomOffsetMin']) {
    assert.ok(Object.hasOwn(original, key), key);
  }
  plan.keywords = ['changed'];
  assert.notDeepEqual(clone(api.planIdentity(plan)), original);
  assert.throws(() => api.requestProof(state), /local_source_unproven/u);
});

const lineageFields = ['orchestrationContext', 'orchestration', 'parentTaskId', 'previousAttemptId',
  'recoveryAdoptionReceipt', 'recoveryAdoptedAt', 'localClosureEvidence', 'localClosureEvidences',
  'localClosureStopConfirmation', 'resumeCommandId', 'stopCommandId', 'itemIds', 'itemAttempts',
  'recoveryTaskId', 'recoveryAdoption', 'localRecoveryAdoption', 'adoptionReceipt', 'localClosure',
  'localClosures', 'orchestrationChild', 'orchestrationRevision', 'handoffSuccessorTaskId',
  'attemptIdentity', 'parent_task_id', 'cloud_command_id'];
for (const field of lineageFields) {
  test(`foreign lineage is denied in request, proof, plan, and ledger: ${field}`, async () => {
    for (const target of ['request', 'proof', 'plan', 'ledger', 'metadata']) {
      const state = await fixture();
      const row = target === 'request' ? state.request : target === 'proof' ? state.origin.request :
        target === 'plan' ? state.request.planSnapshot : target === 'ledger' ? state.ledger.runs[0] : state.ledger.runs[0].metadata;
      row[field] = {synthetic: 'foreign lineage'};
      assert.throws(() => api.requestProof(state), /local_(?:source|lineage)_(?:unproven|ambiguous)/u, target);
    }
  });
}

for (const [name, mutate] of Object.entries({
  'wrong origin version': s => {s.origin.version = 2;},
  'wrong proof kind': s => {s.origin.request.kind = 'cloud-authored-plan';},
  'invalid proof origin': s => {s.origin.request.originId = 'legacy';},
  'invalid plan hash': s => {s.origin.request.planFingerprint = 'a'.repeat(63);},
  'invalid credential hash': s => {s.origin.request.credentialFingerprint = 'B'.repeat(64);},
  'numeric proof createdAt': s => {s.origin.request.createdAt = NOW - 2000;},
  'noncanonical proof createdAt': s => {s.origin.request.createdAt = '2026-09-07T02:59:58Z';},
  'request createdAt malformed equally': s => {s.origin.request.requestCreatedAt = s.request.createdAt = 'not-a-time';},
  'request createdAt noncanonical equally': s => {s.origin.request.requestCreatedAt = s.request.createdAt = '2026-09-07T02:59:59Z';},
  'request predates authored plan': s => {s.origin.request.requestCreatedAt = s.request.createdAt = new Date(NOW - 3000).toISOString();},
  'request update predates creation': s => {s.request.updatedAt = new Date(NOW - 3000).toISOString();},
  'noncanonical request update': s => {s.request.updatedAt = '2026-09-07T03:00:00Z';},
  'invalid binding id': s => {s.origin.request.binding.authBindingId = '';},
  'invalid binding revision': s => {s.origin.request.binding.bindingRevision = '';},
  'unsupported platform': s => {s.origin.request.planSnapshot.platform = s.request.planSnapshot.platform = 'weibo';},
  'new auth mutation': s => {s.auth.authMutationId = 'other';},
  'changed Agent': s => {s.auth.captureAgent.id = id(19);},
  'changed tenant': s => {s.auth.tenant.id = id(19);},
  'missing token': s => {delete s.auth.captureAgent.token;},
  'wrong request id': s => {s.request.id = id(19);},
  'wrong Attempt': s => {s.request.attemptId = id(19);},
  'cloud assigned request': s => {s.request.cloudAssigned = true;},
  'not a keyword request': s => {s.request.type = 'targeted_post';},
  'absent cloud flag': s => {delete s.request.cloudAssigned;},
  'cloud command request': s => {s.request.cloudCommandId = id(19);},
  'wrong cloud Agent scope': s => {s.request.cloudAgentScopeId = id(19);},
  'not strict admitted': s => {s.request.strictControlCandidate = false;},
  'pending legacy recovery': s => {s.request.recoveryPendingLaunch = true;},
  'dismissed source': s => {s.request.recoveryDismissedAt = AT;},
  'first generation parent': s => {s.request.parentRequestId = id(19);},
  'first generation intent': s => {s.request.localRecoveryIntentId = id(19);},
  'first generation recovery reason': s => {s.request.recoveryReason = 'manual_recovery';},
  'first generation recovery mode': s => {s.request.recoveryMode = 'failed';},
  'first generation hidden source id': s => {s.origin.request.sourceRequestId = id(19);},
  'first generation hidden source Attempt': s => {s.origin.request.sourceAttemptId = id(19);},
  'first generation hidden launch intent': s => {s.origin.request.launchIntentId = id(19);},
  'zero generation': s => {s.origin.request.generation = 0;},
  'third generation': s => {s.origin.request.generation = 3;},
  'coerced generation': s => {s.origin.request.generation = '1';},
  'wrong Attempt number': s => {s.request.attemptNumber = 2;},
  'missing ledger row': s => {s.ledger.runs = [];},
  'duplicate ledger row': s => {s.ledger.runs.push(clone(s.ledger.runs[0]));},
  'ledger different Attempt': s => {s.ledger.runs[0].attemptId = id(19);},
  'ledger different status': s => {s.ledger.runs[0].status = 'completed';},
  'ledger different createdAt': s => {s.ledger.runs[0].createdAt = CREATED;},
  'ledger different updatedAt': s => {s.ledger.runs[0].updatedAt = STARTED;},
  'ledger missing metadata': s => {s.ledger.runs[0].metadata = null;},
  'ledger cloud assigned': s => {s.ledger.runs[0].metadata.cloudAssigned = true;},
  'ledger source cloud assignment': s => {s.ledger.runs[0].source = 'cloud_assignment';},
  'ledger wrong task kind': s => {s.ledger.runs[0].taskType = 'capture';},
  'ledger wrong feature kind': s => {s.ledger.runs[0].featureKey = 'capture.keyword_batch';},
  'ledger wrong platform': s => {s.ledger.runs[0].platform = 'douyin';},
  'ledger wrong Attempt number': s => {s.ledger.runs[0].attemptNumber = 2;},
  'ledger wrong progress': s => {s.ledger.runs[0].progressSeq = 9;},
  'ledger wrong scope': s => {s.ledger.runs[0].metadata.cloudAgentScopeId = id(19);},
  'ledger cloud command': s => {s.ledger.runs[0].metadata.cloudCommandId = id(19);},
  'ledger parent on original': s => {s.ledger.runs[0].metadata.parentRequestId = id(19);},
  'ledger top-level parent on original': s => {s.ledger.runs[0].parentRequestId = id(19);},
  'ledger launch intent on original': s => {s.ledger.runs[0].metadata.localRecoveryIntentId = id(19);},
  'ledger recovery reason mismatch': s => {s.ledger.runs[0].metadata.recoveryReason = 'manual_recovery';},
  'ledger recovery mode mismatch': s => {s.ledger.runs[0].metadata.recoveryMode = 'failed';},
  'archived duplicate': s => {s.archive = {requests: {[s.request.id]: clone(s.request)}};},
  'malformed archive': s => {s.archive = {};},
  'cleared ledger at creation': s => {s.ledger.clearedAt = STARTED;},
  'cleared ledger after creation': s => {s.ledger.clearedAt = AT;},
  'malformed cleared marker': s => {s.ledger.clearedAt = 'not-a-time';},
  'noncanonical cleared marker': s => {s.ledger.clearedAt = '2026-09-07T02:59:00Z';},
})) test(`inconsistent local source is rejected: ${name}`, async () => {
  const state = await fixture(); mutate(state);
  const {source} = evaluator();
  assert.throws(() => api.requestProof(state), /local_(?:source|lineage)_(?:unproven|ambiguous)/u);
  assert.equal(source.matches(state, {}), false);
});

for (const [name, mutate] of Object.entries({
  'missing predecessor request': s => {delete s.origin.request.sourceRequestId;},
  'missing predecessor Attempt': s => {delete s.origin.request.sourceAttemptId;},
  'missing launch intent': s => {delete s.origin.request.launchIntentId;},
  'self successor request': s => {s.origin.request.sourceRequestId = s.request.id;},
  'self successor Attempt': s => {s.origin.request.sourceAttemptId = s.request.attemptId;},
  'wrong parent': s => {s.request.parentRequestId = id(19);},
  'wrong launch intent': s => {s.request.localRecoveryIntentId = id(19);},
  'wrong ledger parent': s => {s.ledger.runs[0].metadata.parentRequestId = id(19);},
  'missing ledger parent': s => {delete s.ledger.runs[0].metadata.parentRequestId;},
  'wrong projected intent': s => {s.ledger.runs[0].metadata.localRecoveryIntentId = id(19);},
  'wrong top-level ledger parent': s => {s.ledger.runs[0].parentRequestId = id(19);},
})) test(`second generation requires exact predecessor and launch intent: ${name}`, async () => {
  const state = await fixture({generation: 2}); mutate(state);
  assert.throws(() => api.requestProof(state), /local_(?:source|lineage)_(?:unproven|ambiguous)/u);
});

test('exact second-generation projected parent/intent and unrelated archived source remain valid', async () => {
  const state = await fixture({generation: 2});
  state.ledger.runs[0].parentRequestId = state.origin.request.sourceRequestId;
  state.ledger.runs[0].metadata.localRecoveryIntentId = state.origin.request.launchIntentId;
  state.archive = {requests: {[id(2)]: {id: id(2), attemptId: id(3)}}};
  state.ledger.clearedAt = CREATED;
  assert.equal(api.requestProof(state).generation, 2);
});

test('non-running/invalid progress and wrong lock never form an active stop candidate', async () => {
  for (const mutate of [s => {s.request.status = s.ledger.runs[0].status = 'pending';},
    s => {s.request.progressSeq = s.ledger.runs[0].progressSeq = -1;},
    s => {s.request.progressSeq = s.ledger.runs[0].progressSeq = '2';},
    s => {s.lock.captureTaskAttemptId = id(19);},
    s => {s.lock.captureTaskId = 'other';}]) {
    const state = await fixture(); mutate(state);
    assert.throws(() => api.candidate(state), /local_source_not_running|owner_unproven/u);
  }
  const state = await fixture();
  state.lock.captureTaskId = ''; state.lock.captureTaskAttemptId = '';
  assert.throws(() => api.candidate(state), /owner_unproven/u);
  assert.equal(api.candidate(state, {allowReservation: true}).source.clientTaskId, state.request.id);
});

test('changing raw plan and proof together cannot reuse an old plan fingerprint', async () => {
  const state = await fixture(), {source, calls} = evaluator();
  state.request.planSnapshot.keywords = ['different'];
  state.origin.request.planSnapshot.keywords = ['different'];
  // The synchronous structural relation still holds; the asynchronous hash
  // check must reject before the independent entitlement provider is called.
  const current = source.candidate(state);
  await assert.rejects(source.evaluate(current), /local_plan_changed/u);
  assert.equal(calls.length, 0);
});

test('changed credentials are denied before any entitlement call', async () => {
  const state = await fixture(), {source, calls} = evaluator();
  state.auth.captureAgent.token = 'synthetic-changed-token';
  await assert.rejects(source.evaluate(source.candidate(state)), /local_credential_changed/u);
  assert.equal(calls.length, 0);
});

test('a valid plan proof cannot be evaluated against another request/Attempt/source', async () => {
  for (const mutate of [c => {c.source.clientTaskId = id(19);}, c => {c.source.clientAttemptId = id(19);},
    c => {c.source.platform = 'douyin';}, c => {c.source.cloudCommandId = id(19);},
    c => {c.source.attemptNumber = 2;}, c => {c.source.status = 'completed';},
    c => {c.source.progressSeq = -1;}, c => {c.local = false;}]) {
    const state = await fixture(), {source, calls} = evaluator(), current = clone(source.candidate(state));
    mutate(current);
    await assert.rejects(source.evaluate(current), /local_source_unproven/u);
    assert.equal(calls.length, 0);
  }
});

test('evaluation snapshots all input before awaiting hashes or calling authority', async () => {
  const state = await fixture(), {source, calls} = evaluator();
  const current = clone(source.candidate(state));
  const before = clone(current);
  const evaluation = source.evaluate(current);
  current.proof.planSnapshot.keywords = ['different'];
  current.proof.planFingerprint = 'f'.repeat(64);
  current.source.clientTaskId = id(19);
  current.auth.captureAgent.token = 'synthetic-changed-token';
  await evaluation;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source.requestId, before.source.clientTaskId);
  assert.equal(calls[0].source.planFingerprint, before.proof.planFingerprint);
  assert.deepEqual(calls[0].auth, before.auth);
  assert.deepEqual(calls[0].expectedBinding, before.proof.binding);
});

test('same-worker private origin witness rejects coordinated proof/plan rewrites, even after rehash', async () => {
  const state = await fixture(), {source} = evaluator();
  const admitted = journal(state);
  assert.equal(source.matches(state, admitted), true);
  state.request.planSnapshot.keywords = ['different'];
  state.origin.request.planSnapshot.keywords = ['different'];
  state.origin.request.planFingerprint = await authorityApi.hash(api.planIdentity(state.origin.request.planSnapshot));
  assert.equal(source.matches(state, admitted), false);
  // A persisted proof copy is not a substitute for a worker-private admission.
  assert.equal(source.matches(state, {...admitted, originWitness: undefined, originProof: clone(state.origin.request)}), false);
  assert.equal(source.matches(state, {...admitted, originWitness: ''}), false);
});

test('private witness also pins binding, credential fingerprint, timestamps and predecessor fields', async () => {
  for (const mutate of [s => {s.origin.request.binding.bindingRevision = 'd'.repeat(64);},
    s => {s.origin.request.credentialFingerprint = 'e'.repeat(64);},
    s => {s.origin.request.createdAt = new Date(NOW - 3000).toISOString();},
    s => {s.origin.request.sourceAttemptId = id(19);}]) {
    const state = await fixture({generation: 2}), {source} = evaluator(), admitted = journal(state);
    mutate(state);
    assert.equal(source.matches(state, admitted), false);
  }
});

test('getters, toJSON, symbols, and non-JSON proof values cannot change the meaning while hashing', async () => {
  for (const mutate of [s => {Object.defineProperty(s.origin.request, 'originId', {get() {throw new Error('getter invoked');}});},
    s => {s.origin.request.toJSON = () => {throw new Error('toJSON invoked');};},
    s => {s.origin.request[Symbol('trust')] = true;},
    s => {s.origin.request.planSnapshot.maxRounds = NaN;}]) {
    const state = await fixture(); mutate(state);
    assert.equal(api.validProof(state.origin.request), false);
    assert.throws(() => api.requestProof(state), /local_control_invalid_json/u);
  }
});
