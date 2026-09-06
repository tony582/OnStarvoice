import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import express from '../server/node_modules/express/index.js';
import {createCaptureControlAuthorityRouter} from '../server/routes/capture-control-authority.js';
import {evaluateTerminalControlAuthority, validateTerminalControlRequest, TERMINAL_CONTROL_ACTION,
  TERMINAL_CONTROL_AUTHORITY_SQL} from '../server/services/capture-control-authority.js';
import {normalizeCloudTaskSnapshot, normalizeRemoteTaskInput} from '../server/services/capture-cloud.js';

const NOW = Date.parse('2026-09-06T03:00:00.000Z');
const AT = new Date(NOW - 1000).toISOString();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const select = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const context = vm.createContext({Date, URL, AbortController, setTimeout, clearTimeout});
for (const file of ['utils/capture/task-center-projection.js', 'utils/task-center.js', 'utils/cloud-task-agent.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, {filename: file});
}

// This fixture traverses the existing checkpoint/count projection, ledger
// normalizer, Extension snapshot builder and server snapshot normalizer. It
// intentionally has raw fields that the production projection drops.
function fixture() {
  const plan = normalizeRemoteTaskInput({executionMode: 'one_time', platform: 'xiaohongshu', keywords: ['甲', '乙']}).planSnapshot;
  const raw = {id: id(1), attemptId: id(2), attemptNumber: 1, progressSeq: 7,
    status: 'completed_with_failures', platform: 'xiaohongshu', createdAt: AT,
    updatedAt: AT, finishedAt: AT, planSnapshot: plan, cloudCommandId: id(3),
    summary: {total: 2, completed: 1, success: 1, failed: 1, partial: 0, skipped: 0, saved: 3},
    checkpoint: {round: 1, keywordResults: [
      {round: 1, index: 0, keyword: '甲', status: 'completed', attemptCount: 1, savedCount: 3, finishedAt: AT, scanComplete: true},
      {round: 1, index: 1, keyword: '乙', status: 'failed', attemptCount: 1, savedCount: 0, finishedAt: AT},
    ]},
    progress: {phase: 'unattended_completed_with_failures', progressScope: 'terminal', current: 2, total: 2,
      keywordCurrent: 2, keywordTotal: 2, finishedAt: AT},
  };
  const projection = context.OnStarvoiceCaptureTaskCenterProjection;
  const run = clone(context.OnStarvoiceTaskCenterCore.normalizeTaskRun({...raw,
    taskType: 'unattended_keyword_capture', featureKey: 'unattended_keyword_plan', source: 'cloud_assignment',
    counts: projection.buildUnattendedTaskCounts(raw), checkpoint: projection.buildTaskCenterCheckpointFromUnattendedRequest(raw),
    metadata: {cloudCommandId: id(3), cloudAssigned: true, cloudAgentScopeId: id(4)},
  }, {now: NOW}));
  const normalized = normalizeCloudTaskSnapshot(clone(context.OnStarvoiceCloudTaskAgent.buildTaskSnapshot(run, raw.id)));
  assert.equal(Object.hasOwn(normalized.progress, 'progressScope'), false);
  assert.equal(Object.hasOwn(normalized.checkpoint.keywordResults[0], 'scanComplete'), false);
  assert.equal(Object.hasOwn(normalized, 'summary'), false);
  const identity = {tenant_id: id(5), agent_id: id(4), auth_code_id: id(6), auth_binding_id: id(7), expires_at: null,
    token_id: id(8), token_created_at: AT, agent_updated_at: AT, bound_at: AT};
  const task = {id: id(1), tenant_id: id(5), origin_agent_id: id(4), assigned_agent_id: id(4),
    task_type: normalized.taskType, client_task_id: raw.id, control_task_id: normalized.controlTaskId,
    attempt_number: raw.attemptNumber, progress_seq: raw.progressSeq, source_updated_at: AT, finished_at: AT,
    platform: normalized.platform, status: normalized.status, progress: normalized.progress,
    counts: normalized.counts, checkpoint: normalized.checkpoint, metadata: {...normalized.metadata, createCommandId: id(3)}, error: {}, updated_at: AT};
  const attempt = {id: id(9), task_id: task.id, tenant_id: id(5), agent_id: id(4), client_attempt_id: raw.attemptId,
    attempt_number: raw.attemptNumber, progress_seq: raw.progressSeq, status: raw.status,
    progress: clone(normalized.progress), checkpoint: clone(normalized.checkpoint), finished_at: AT, error: {}, updated_at: AT};
  const snapshot = {...clone(task), id: 101, task_id: task.id, agent_id: id(4), attempt_id: attempt.id,
    client_attempt_id: raw.attemptId, metadata: clone(normalized.metadata), snapshot_fingerprint: 'a'.repeat(64)};
  const command = {id: id(3), task_id: task.id, tenant_id: id(5), agent_id: id(4), command_type: 'create', status: 'completed',
    finished_at: AT, updated_at: AT, payload: {taskId: task.id, clientTaskId: raw.id, authCodeId: id(6), authBindingId: id(7), planSnapshot: plan}};
  const countsKeys = ['total', 'processed', 'saved', 'success', 'failed', 'skipped', 'retried', 'warnings'];
  const resultKeys = ['round', 'index', 'keyword', 'status', 'attemptCount', 'savedCount', 'finishedAt'];
  const body = {action: TERMINAL_CONTROL_ACTION, source: {clientTaskId: raw.id, controlTaskId: raw.id,
    clientAttemptId: raw.attemptId, attemptNumber: 1, progressSeq: 7, sourceUpdatedAt: AT, finishedAt: AT,
    cloudCommandId: id(3), platform: 'xiaohongshu', settlement: {counts: select(normalized.counts, countsKeys),
      progress: select(normalized.progress, ['phase', 'current', 'total']),
      keywordResults: normalized.checkpoint.keywordResults.map(result => select(result, resultKeys))}}};
  return {raw, run, normalized, body, row: {evaluated_at: new Date(NOW), identity,
    evidence: [{task, attempt, snapshot, command, attempt_conflict: false, command_conflict: false, successor_conflict: false}]}};
}

async function evaluate(f, options = {}) {
  const calls = [];
  const result = await evaluateTerminalControlAuthority({token: 'synthetic-private-agent-token', body: f.body}, {
    now: () => NOW,
    readOne: async (sql, params) => {calls.push({sql, params}); return clone(f.row);},
    ...options,
  });
  return {result, calls};
}

test('actual projection chain authorizes only exact terminal metadata and leaks no payload or token', async () => {
  const f = fixture();
  const {result, calls} = await evaluate(f);
  assert.equal(validateTerminalControlRequest(f.body), true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.source.serverTaskId, id(1));
  assert.equal(result.source.serverAttemptId, id(9));
  assert.equal(result.source.snapshotId, '101');
  assert.equal(result.expiresAt, new Date(NOW + 5000).toISOString());
  assert.match(result.authorityRevision, /^[a-f0-9]{64}$/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, TERMINAL_CONTROL_AUTHORITY_SQL);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-agent-token|settlement|keywordResults|token_id|token_hash/u);
  assert.notEqual(calls[0].params[0], 'synthetic-private-agent-token');
});

test('authority statement is SELECT-only and rechecks binding in the same target query', () => {
  assert.doesNotMatch(TERMINAL_CONTROL_AUTHORITY_SQL, /\b(?:INSERT|UPDATE|DELETE|CALL|LOCK|pg_advisory|FOR\s+UPDATE)\b/iu);
  for (const fragment of ['cat.revoked_at IS NULL', 'ca.auth_binding_id = cat.auth_binding_id',
    "ac.status = 'active'", "tenant.status = 'active'", "command.payload->>'authBindingId' = identity.auth_binding_id::text",
    'snapshot.attempt_id = attempt.id', 'snapshot.source_updated_at = task.source_updated_at', 'LIMIT 2']) {
    assert.ok(TERMINAL_CONTROL_AUTHORITY_SQL.includes(fragment), fragment);
  }
});

for (const [name, mutate] of Object.entries({
  'unknown action': f => {f.body.action = 'stop';},
  'extra UI authority': f => {f.body.permissions = ['allow'];},
  'legacy Attempt': f => {f.body.source.clientAttemptId = 'legacy-task';},
  'coerced count': f => {f.body.source.settlement.counts.total = '2';},
  'remaining work': f => {f.body.source.settlement.counts.total = 3;},
  'duplicate checkpoint identity': f => {f.body.source.settlement.keywordResults[1].index = 0;},
  'unknown checkpoint status': f => {f.body.source.settlement.keywordResults[1].status = 'needs_action';},
  'inconsistent saved total': f => {f.body.source.settlement.counts.saved = 2;},
  'inconsistent retries': f => {f.body.source.settlement.counts.retried = 1;},
  'zero attempt count': f => {f.body.source.settlement.keywordResults[1].attemptCount = 0;},
  'future finishedAt': f => {f.body.source.finishedAt = new Date(NOW + 1).toISOString();},
})) {
  test(`malformed source rejected before any query: ${name}`, async () => {
    const f = fixture(); mutate(f);
    const {result, calls} = await evaluate(f);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_control_target');
    assert.equal(calls.length, 0);
  });
}

for (const [name, mutate] of Object.entries({
  'current token or entitlement gone': f => {f.row.identity = null;},
  'source query no match': f => {f.row.evidence = [];},
  'ambiguous exact snapshots': f => {f.row.evidence.push(clone(f.row.evidence[0]));},
  'newer Attempt': f => {f.row.evidence[0].attempt_conflict = true;},
  'pending/conflicting command': f => {f.row.evidence[0].command_conflict = true;},
  'successor': f => {f.row.evidence[0].successor_conflict = true;},
  'same agent rebound': f => {f.row.identity.auth_binding_id = id(17);},
  'client uploaded fake create provenance': f => {f.row.evidence[0].command.payload.authBindingId = id(17);},
  'raw timestamp stale': f => {f.row.evidence[0].task.source_updated_at = new Date(NOW).toISOString();},
  'stale terminal status': f => {f.row.evidence[0].task.status = 'failed';},
  'snapshot local Attempt changed': f => {f.row.evidence[0].snapshot.client_attempt_id = id(18);},
  'snapshot saved count differs': f => {f.row.evidence[0].snapshot.counts.saved += 1;},
  'snapshot result truncated': f => {f.row.evidence[0].snapshot.checkpoint.keywordResults.pop();},
  'attempt checkpoint differs': f => {f.row.evidence[0].attempt.checkpoint.keywordResults[0].savedCount = 5;},
  'safety flag': f => {f.row.evidence[0].snapshot.checkpoint.keywordResults[1].requiresManualAction = true;},
  'manual action alternate marker': f => {f.row.evidence[0].snapshot.metadata.manualActionRequired = true;},
  'missing snapshot fingerprint': f => {delete f.row.evidence[0].snapshot.snapshot_fingerprint;},
  'reconciliation': f => {f.row.evidence[0].task.metadata.reconciliationRequired = true;},
  'legacy closure': f => {f.row.evidence[0].task.metadata.localClosure = {sourceStopped: true};},
  'handoff marker': f => {f.row.evidence[0].task.metadata.handoffSuccessorTaskId = id(20);},
  'adoption marker': f => {f.row.evidence[0].task.metadata.localRecoveryAdoption = {accepted: true};},
  'unknown remainder omitted': f => {f.row.evidence[0].command.payload.planSnapshot.keywords.push('丙');},
  'unsupported sequential profile': f => {f.row.evidence[0].command.payload.planSnapshot.searchPasses = ['all', 'video'];},
  'orchestration profile': f => {f.row.evidence[0].command.payload.orchestration = {parentTaskId: id(19)};},
})) {
  test(`unproven target cannot borrow terminal authority: ${name}`, async () => {
    const f = fixture(); mutate(f);
    assert.equal((await evaluate(f)).result.ok, false);
  });
}

test('expiry is capped by entitlement and query/queue time is not renewed', async () => {
  const f = fixture();
  f.row.identity.expires_at = new Date(NOW + 800).toISOString();
  assert.equal((await evaluate(f)).result.expiresAt, f.row.identity.expires_at);
  const ticks = [NOW, NOW + 800];
  assert.equal((await evaluate(f, {now: () => ticks.shift()})).result.reason, 'authority_expired');
  f.row.identity.expires_at = null;
  const slowTicks = [NOW, NOW + 5000];
  assert.equal((await evaluate(f, {now: () => slowTicks.shift()})).result.reason, 'authority_expired');
});

test('a mirrored future source version cannot become a current authority', async () => {
  const f = fixture();
  f.row.evaluated_at = new Date(NOW - 2000).toISOString();
  assert.equal((await evaluate(f)).result.reason, 'terminal_source_unproven');
});

test('read-only real Router uses only synthetic token, response no-store and no old fallback', async t => {
  const f = fixture();
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/capture-cloud', createCaptureControlAuthorityRouter({evaluate: args => {
    calls.push(args);
    return evaluateTerminalControlAuthority(args, {readOne: async () => clone(f.row), now: () => NOW});
  }}));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close(error => error ? reject(error) : resolve());
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/capture-cloud/agent/control-authority`, {
    method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer isolated-router-token'}, body: JSON.stringify(f.body),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).ok, true);
  assert.equal(calls[0].token, 'isolated-router-token');
  const denied = await fetch(`${origin}/api/capture-cloud/agent/control-authority`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({...f.body, action: 'resume'}),
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal((await denied.json()).decision, 'deny');
});
