import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import express from '../server/node_modules/express/index.js';
import {createCaptureStopAuthorityRouter} from '../server/routes/capture-stop-authority.js';
import {evaluateActiveStopAuthority, validateActiveStopRequest, ACTIVE_STOP_ACTION,
  ACTIVE_STOP_POLICY_VERSION, ACTIVE_STOP_AUTHORITY_SQL} from '../server/services/capture-stop-authority.js';
import {normalizeCloudTaskSnapshot, normalizeRemoteTaskInput} from '../server/services/capture-cloud.js';

const NOW = Date.parse('2026-09-06T03:00:00.000Z');
const AT = new Date(NOW - 1000).toISOString();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const context = vm.createContext({Date, URL, AbortController, setTimeout, clearTimeout});
for (const file of ['utils/capture/task-center-projection.js', 'utils/task-center.js', 'utils/cloud-task-agent.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, {filename: file});
}

// Exercise the actual Extension projection and snapshot sanitizers before the
// DB-shaped synthetic row. No cached auth/legacy Attempt alias supplies source.
function fixture(platform = 'xiaohongshu') {
  const plan = normalizeRemoteTaskInput({executionMode: 'one_time', platform, keywords: ['甲', '乙']}).planSnapshot;
  const raw = {id: id(1), attemptId: id(2), attemptNumber: 1, progressSeq: 7,
    status: 'running', platform, cloudAssigned: true, cloudAgentScopeId: id(4),
    createdAt: AT, updatedAt: AT, finishedAt: '', planSnapshot: plan, cloudCommandId: id(3),
    checkpoint: {round: 1, keywordResults: [
      {round: 1, index: 0, keyword: '甲', status: 'completed', attemptCount: 1, savedCount: 3, finishedAt: AT},
    ]},
    progress: {phase: 'keyword_running', current: 1, total: 2, keywordCurrent: 1, keywordTotal: 2},
  };
  const projection = context.OnStarvoiceCaptureTaskCenterProjection;
  const run = clone(context.OnStarvoiceTaskCenterCore.normalizeTaskRun({...raw,
    taskType: 'unattended_keyword_capture', featureKey: 'unattended_keyword_plan', source: 'cloud_assignment',
    counts: projection.buildUnattendedTaskCounts(raw), checkpoint: projection.buildTaskCenterCheckpointFromUnattendedRequest(raw),
    metadata: {cloudCommandId: id(3), cloudAssigned: true, cloudAgentScopeId: id(4)},
  }, {now: NOW}));
  const normalized = normalizeCloudTaskSnapshot(clone(context.OnStarvoiceCloudTaskAgent.buildTaskSnapshot(
    run, raw.id, {}, {allowLiveHealth: false},
  )));
  assert.equal(normalized.attemptId, raw.attemptId);
  assert.equal(normalized.updatedAt, raw.updatedAt);
  assert.equal(normalized.status, 'running');
  assert.equal(normalized.metadata.cloudAssigned, true);
  const identity = {tenant_id: id(5), agent_id: id(4), auth_code_id: id(6), auth_binding_id: id(7), expires_at: null,
    token_id: id(8), token_created_at: AT, agent_updated_at: AT, bound_at: AT};
  const task = {id: id(10), tenant_id: id(5), origin_agent_id: id(4), assigned_agent_id: id(4), parent_task_id: null,
    task_type: normalized.taskType, client_task_id: normalized.clientTaskId, control_task_id: normalized.controlTaskId,
    attempt_number: normalized.attemptNumber, progress_seq: normalized.progressSeq, source_updated_at: normalized.updatedAt,
    finished_at: null, platform: normalized.platform, status: normalized.status, progress: normalized.progress,
    counts: normalized.counts, checkpoint: normalized.checkpoint, metadata: {...normalized.metadata, createCommandId: id(3)},
    error: {}, updated_at: AT};
  const attempt = {id: id(9), task_id: task.id, tenant_id: id(5), agent_id: id(4), client_attempt_id: normalized.attemptId,
    attempt_number: normalized.attemptNumber, progress_seq: normalized.progressSeq, status: normalized.status,
    progress: clone(normalized.progress), checkpoint: clone(normalized.checkpoint), finished_at: null, error: {}, updated_at: AT};
  const snapshot = {...clone(task), id: 101, task_id: task.id, agent_id: id(4), attempt_id: attempt.id,
    client_attempt_id: normalized.attemptId, metadata: clone(normalized.metadata), snapshot_fingerprint: 'a'.repeat(64)};
  const command = {id: id(3), task_id: task.id, tenant_id: id(5), agent_id: id(4), command_type: 'create', status: 'completed',
    finished_at: AT, updated_at: AT, payload: {taskId: task.id, clientTaskId: raw.id, authCodeId: id(6), authBindingId: id(7), planSnapshot: plan}};
  const body = {action: ACTIVE_STOP_ACTION, source: {clientTaskId: raw.id, controlTaskId: raw.id,
    clientAttemptId: raw.attemptId, attemptNumber: raw.attemptNumber, progressSeq: raw.progressSeq,
    sourceUpdatedAt: raw.updatedAt, cloudCommandId: raw.cloudCommandId, platform: raw.platform, status: raw.status}};
  return {raw, run, normalized, body, row: {evaluated_at: new Date(NOW), identity,
    evidence: [{task, attempt, snapshot, command, attempt_conflict: false, command_conflict: false, successor_conflict: false}]}};
}

async function evaluate(f, options = {}) {
  const calls = [];
  const result = await evaluateActiveStopAuthority({token: 'synthetic-private-agent-token', body: f.body}, {
    now: () => NOW,
    readOne: async (sql, params) => {calls.push({sql, params}); return clone(f.row);},
    ...options,
  });
  return {result, calls};
}

for (const platform of ['xiaohongshu', 'douyin']) {
  test(`actual projected running source obtains stop-only authority: ${platform}`, async () => {
    const f = fixture(platform), before = clone(f);
    const {result, calls} = await evaluate(f);
    assert.equal(validateActiveStopRequest(f.body), true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.action, 'stop_active_capture');
    assert.equal(result.policyVersion, 'active-capture-stop-v1');
    assert.equal(result.source.serverTaskId, id(10));
    assert.equal(result.source.serverAttemptId, id(9));
    assert.equal(result.source.snapshotId, '101');
    assert.equal(result.source.status, 'running');
    assert.equal(result.expiresAt, new Date(NOW + 5000).toISOString());
    assert.match(result.authorityRevision, /^[a-f0-9]{64}$/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sql, ACTIVE_STOP_AUTHORITY_SQL);
    assert.equal(calls[0].params.length, 8);
    assert.notEqual(calls[0].params[0], 'synthetic-private-agent-token');
    assert.match(calls[0].params[0], /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-agent-token|settlement|keywordResults|token_id|token_hash|planSnapshot|successorAllowed/u);
    assert.deepEqual(clone(f), before, 'provider must not alter its source/evidence');
  });
}

test('query is one SELECT-only identity/source view, independent of terminal policy', () => {
  assert.doesNotMatch(ACTIVE_STOP_AUTHORITY_SQL, /\b(?:INSERT|UPDATE|DELETE|CALL|LOCK|pg_advisory|FOR\s+UPDATE)\b/iu);
  assert.doesNotMatch(ACTIVE_STOP_AUTHORITY_SQL, /completed_with_failures|settlement|adoptLocal|heartbeat/iu);
  for (const fragment of ['cat.revoked_at IS NULL', 'ca.auth_binding_id = cat.auth_binding_id',
    "ac.status = 'active'", "tenant.status = 'active'", 'task.parent_task_id IS NULL',
    "command.payload->>'authBindingId' = identity.auth_binding_id::text", 'task.origin_agent_id = identity.agent_id',
    'snapshot.attempt_id = attempt.id', 'snapshot.source_updated_at = task.source_updated_at',
    "task.status = 'running'", 'task.finished_at IS NULL', 'attempt.finished_at IS NULL', 'snapshot.finished_at IS NULL',
    "other.status IN ('pending', 'acknowledged')", 'LIMIT 2']) assert.ok(ACTIVE_STOP_AUTHORITY_SQL.includes(fragment), fragment);
});

for (const [name, mutate] of Object.entries({
  'terminal metadata action': f => {f.body.action = 'dismiss_terminal_recovery_metadata';},
  'resume action': f => {f.body.action = 'resume';},
  'start action': f => {f.body.action = 'start_capture';},
  'extra UI permissions': f => {f.body.permissions = ['allow'];},
  'caller generation': f => {f.body.source.generation = 'trusted';},
  'terminal settlement': f => {f.body.source.settlement = {};},
  'terminal finishedAt': f => {f.body.source.finishedAt = AT;},
  'legacy Attempt': f => {f.body.source.clientAttemptId = 'legacy-task';},
  'coerced UUID': f => {f.body.source.clientAttemptId = {toString: () => id(2)};},
  'coerced Attempt number': f => {f.body.source.attemptNumber = '1';},
  'zero Attempt number': f => {f.body.source.attemptNumber = 0;},
  'negative progress': f => {f.body.source.progressSeq = -1;},
  'fractional progress': f => {f.body.source.progressSeq = 1.5;},
  'missing version': f => {delete f.body.source.sourceUpdatedAt;},
  'noncanonical timestamp': f => {f.body.source.sourceUpdatedAt = '2026-09-06T03:00:00Z';},
  'invalid timestamp': f => {f.body.source.sourceUpdatedAt = '2026-09-99T03:00:00.000Z';},
  'unbound control request': f => {f.body.source.controlTaskId = id(17);},
  'terminal status': f => {f.body.source.status = 'completed_with_failures';},
  'pending status': f => {f.body.source.status = 'pending';},
  'recovering status': f => {f.body.source.status = 'recovering';},
  'unsupported platform': f => {f.body.source.platform = 'weibo';},
  'inherited action': f => {f.body = Object.assign(Object.create({action: ACTIVE_STOP_ACTION}), {source: f.body.source});},
  'accessor source identity': f => {Object.defineProperty(f.body.source, 'clientTaskId', {get() {throw new Error('must not invoke');}});},
  'symbol field': f => {f.body.source[Symbol('authority')] = true;},
})) {
  test(`invalid target refused before query: ${name}`, async () => {
    const f = fixture(); mutate(f);
    const {result, calls} = await evaluate(f);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_control_target');
    assert.equal(calls.length, 0);
  });
}

for (const [name, mutate] of Object.entries({
  'revoked token/identity missing': f => {f.row.identity = null;},
  'malformed identity': f => {f.row.identity.agent_id = '';},
  'binding removed': f => {f.row.identity.auth_binding_id = null;},
  'invalid entitlement timestamp': f => {f.row.identity.expires_at = 'tomorrow';},
  'task gone': f => {f.row.evidence = [];},
  'ambiguous snapshot': f => {f.row.evidence.push(clone(f.row.evidence[0]));},
  'newer Attempt': f => {f.row.evidence[0].attempt_conflict = true;},
  'pending command': f => {f.row.evidence[0].command_conflict = true;},
  'active successor': f => {f.row.evidence[0].successor_conflict = true;},
  'missing conflict evidence': f => {delete f.row.evidence[0].successor_conflict;},
  'same Agent rebound': f => {f.row.identity.auth_binding_id = id(17);},
  'changed tenant': f => {f.row.identity.tenant_id = id(17);},
  'cross-tenant task': f => {f.row.evidence[0].task.tenant_id = id(17);},
  'cross-tenant snapshot': f => {f.row.evidence[0].snapshot.tenant_id = id(17);},
  'cross-tenant Attempt': f => {f.row.evidence[0].attempt.tenant_id = id(17);},
  'cross-tenant command': f => {f.row.evidence[0].command.tenant_id = id(17);},
  'different assigned Agent': f => {f.row.evidence[0].task.assigned_agent_id = id(17);},
  'different origin Agent': f => {f.row.evidence[0].task.origin_agent_id = id(17);},
  'different snapshot Agent': f => {f.row.evidence[0].snapshot.agent_id = id(17);},
  'different Attempt Agent': f => {f.row.evidence[0].attempt.agent_id = id(17);},
  'different command Agent': f => {f.row.evidence[0].command.agent_id = id(17);},
  'task no longer running': f => {f.row.evidence[0].task.status = 'completed';},
  'snapshot no longer running': f => {f.row.evidence[0].snapshot.status = 'failed';},
  'Attempt no longer running': f => {f.row.evidence[0].attempt.status = 'canceled';},
  'task terminal timestamp': f => {f.row.evidence[0].task.finished_at = AT;},
  'snapshot terminal timestamp': f => {f.row.evidence[0].snapshot.finished_at = AT;},
  'Attempt terminal timestamp': f => {f.row.evidence[0].attempt.finished_at = AT;},
  'task version changed': f => {f.row.evidence[0].task.source_updated_at = new Date(NOW).toISOString();},
  'snapshot version changed': f => {f.row.evidence[0].snapshot.source_updated_at = new Date(NOW).toISOString();},
  'snapshot client Attempt changed': f => {f.row.evidence[0].snapshot.client_attempt_id = id(17);},
  'snapshot server Attempt changed': f => {f.row.evidence[0].snapshot.attempt_id = id(17);},
  'Attempt progress changed': f => {f.row.evidence[0].attempt.progress_seq++;},
  'task progress changed': f => {f.row.evidence[0].task.progress_seq++;},
  'snapshot progress changed': f => {f.row.evidence[0].snapshot.progress_seq++;},
  'client task changed': f => {f.row.evidence[0].task.client_task_id = id(17);},
  'control task changed': f => {f.row.evidence[0].snapshot.control_task_id = id(17);},
  'unsupported task type': f => {f.row.evidence[0].task.task_type = 'targeted_post_capture';},
  'missing fingerprint': f => {delete f.row.evidence[0].snapshot.snapshot_fingerprint;},
  'coerced snapshot id': f => {f.row.evidence[0].snapshot.id = '101';},
  'original create missing': f => {f.row.evidence[0].command = null;},
  'command not completed': f => {f.row.evidence[0].command.status = 'acknowledged';},
  'command not original create': f => {f.row.evidence[0].command.command_type = 'resume';},
  'command missing completion': f => {f.row.evidence[0].command.finished_at = null;},
  'command provenance altered': f => {f.row.evidence[0].task.metadata.createCommandId = id(17);},
  'command auth binding altered': f => {f.row.evidence[0].command.payload.authBindingId = id(17);},
  'command client task altered': f => {f.row.evidence[0].command.payload.clientTaskId = id(17);},
  'command server task altered': f => {f.row.evidence[0].command.payload.taskId = id(17);},
  'local-only source': f => {f.row.evidence[0].task.metadata.cloudAssigned = false;},
  'missing snapshot cloud provenance': f => {delete f.row.evidence[0].snapshot.metadata.cloudAssigned;},
  'snapshot cloud Agent differs': f => {f.row.evidence[0].snapshot.metadata.cloudAgentScopeId = id(17);},
  'snapshot create differs': f => {f.row.evidence[0].snapshot.metadata.cloudCommandId = id(17);},
  'orchestration parent': f => {f.row.evidence[0].task.parent_task_id = id(17);},
  'orchestration create': f => {f.row.evidence[0].command.payload.orchestration = {parentTaskId: id(17)};},
  'orchestration snapshot': f => {f.row.evidence[0].snapshot.metadata.orchestrationContext = {revision: 1};},
  'manual recovery lineage': f => {f.row.evidence[0].task.metadata.parentRequestId = id(17);},
  'adoption receipt': f => {f.row.evidence[0].snapshot.metadata.localRecoveryAdoption = {accepted: true};},
  'original resume checkpoint': f => {f.row.evidence[0].command.payload.checkpoint = {round: 1};},
  'legacy local closure': f => {f.row.evidence[0].task.metadata.localClosure = {sourceStopped: true};},
  'missing original plan': f => {f.row.evidence[0].command.payload.planSnapshot = null;},
  'mismatching original platform': f => {f.row.evidence[0].command.payload.planSnapshot.platform = 'douyin';},
  'empty original workset': f => {f.row.evidence[0].command.payload.planSnapshot.keywords = [];},
})) {
  test(`unproven active source refused: ${name}`, async () => {
    const f = fixture(); mutate(f);
    const {result, calls} = await evaluate(f);
    assert.equal(result.ok, false, name);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /serverTaskId|serverAttemptId|snapshotId|token/u);
  });
}

test('source is detached before the asynchronous authority read', async () => {
  const f = fixture();
  const {result} = await evaluate(f, {readOne: async () => {
    f.body.source.clientAttemptId = id(17); f.body.source.progressSeq = 99;
    return clone(f.row);
  }});
  assert.equal(result.ok, true);
  assert.equal(result.source.clientAttemptId, id(2));
  assert.equal(result.source.progressSeq, 7);
});

test('safety warnings and pending results never prevent stop-only permission or get cleared', async () => {
  const f = fixture();
  for (const row of [f.row.evidence[0].task, f.row.evidence[0].snapshot]) {
    row.error = {code: 'PLATFORM_SAFETY_BLOCKED', requiresManualAction: true};
    row.metadata.pendingUploads = 3;
    row.metadata.reconciliationRequired = true;
  }
  const before = clone(f.row);
  assert.equal((await evaluate(f)).result.ok, true);
  assert.deepEqual(clone(f.row), before);
});

test('original multi-round plan retains its unchanged stop permission', async () => {
  const f = fixture();
  f.row.evidence[0].command.payload.planSnapshot.maxRounds = 3;
  f.row.evidence[0].command.payload.planSnapshot.autoLoop = true;
  assert.equal((await evaluate(f)).result.ok, true);
});

test('a source, snapshot, or binding revision change rotates the authority fingerprint', async () => {
  const f = fixture();
  const original = (await evaluate(f)).result.authorityRevision;
  f.row.evidence[0].snapshot.snapshot_fingerprint = 'b'.repeat(64);
  assert.notEqual((await evaluate(f)).result.authorityRevision, original);
  f.row.evidence[0].snapshot.snapshot_fingerprint = 'a'.repeat(64);
  f.row.identity.agent_updated_at = new Date(NOW).toISOString();
  assert.notEqual((await evaluate(f)).result.authorityRevision, original);
});

test('entitlement and read latency bound the five-second window without renewal', async () => {
  const f = fixture();
  f.row.identity.expires_at = new Date(NOW + 800).toISOString();
  assert.equal((await evaluate(f)).result.expiresAt, f.row.identity.expires_at);
  let ticks = [NOW, NOW + 800];
  assert.equal((await evaluate(f, {now: () => ticks.shift()})).result.reason, 'authority_expired');
  f.row.identity.expires_at = null;
  ticks = [NOW, NOW + 5000];
  assert.equal((await evaluate(f, {now: () => ticks.shift()})).result.reason, 'authority_expired');
  f.row.evaluated_at = new Date(NOW - 2000).toISOString();
  assert.equal((await evaluate(f)).result.reason, 'active_source_unproven');
  f.row.evaluated_at = new Date(NOW + 1).toISOString();
  assert.equal((await evaluate(f)).result.reason, 'active_source_unproven');
});

for (const token of ['', 'a'.repeat(513), 'two words', 'with\nnewline', null, 123]) {
  test(`invalid token rejected without query: ${JSON.stringify(token).slice(0, 25)}`, async () => {
    let reads = 0;
    const result = await evaluateActiveStopAuthority({token, body: fixture().body}, {
      readOne: async () => {reads++; throw new Error('must not query');},
    });
    assert.equal(result.reason, 'invalid_agent_token');
    assert.equal(reads, 0);
  });
}

test('real Router is no-store, separates status codes and exposes no legacy route or commands', async t => {
  const f = fixture(), calls = [];
  let queryFailure = false;
  const app = express();
  app.use(express.json());
  app.use('/api/capture-cloud', createCaptureStopAuthorityRouter({evaluate: args => {
    calls.push(args);
    return evaluateActiveStopAuthority(args, {readOne: async () => {
      if (queryFailure) throw new Error('private database detail');
      return clone(f.row);
    }, now: () => NOW});
  }}));
  app.use((error, req, res, next) => res.status(500).json({ok: false, error: 'internal_error'}));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close(error => error ? reject(error) : resolve());
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body = f.body, token = 'synthetic-router-token', path = 'stop-authority') => fetch(`${origin}/api/capture-cloud/agent/${path}`, {
    method: 'POST', headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body),
  });
  const allowed = await post();
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.equal(allowed.headers.get('pragma'), 'no-cache');
  assert.equal((await allowed.json()).policyVersion, ACTIVE_STOP_POLICY_VERSION);
  assert.equal(calls[0].token, 'synthetic-router-token');
  for (const action of ['resume', 'start_capture', 'dismiss_terminal_recovery_metadata']) {
    const denied = await post({...f.body, action});
    assert.equal(denied.status, 400);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal((await denied.json()).decision, 'deny');
  }
  assert.equal((await post(f.body, '')).status, 403);
  f.row.evidence[0].command_conflict = true;
  assert.equal((await post()).status, 409);
  f.row.evidence[0].command_conflict = false;
  assert.equal((await post(f.body, 'synthetic-router-token', 'control-authority')).status, 404);
  const read = await fetch(`${origin}/api/capture-cloud/agent/stop-authority`);
  assert.equal(read.status, 404);
  queryFailure = true;
  const failure = await post();
  assert.equal(failure.status, 500);
  assert.equal(failure.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await failure.text(), /private database detail/u);
});
