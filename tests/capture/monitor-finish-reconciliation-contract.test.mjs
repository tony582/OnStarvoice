import {readSidebarControllerSources} from '../helpers/sidebar-controller-source.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as contract from '../../prototypes/extension-sync-confirmation/monitor-finish-contract.mjs';

const {planMonitorFinish} = contract;
const defer = {decision: 'defer_existing'};
const denial = {
  legacyFinishAllowed: false,
  automaticReplayBlocked: true,
  terminalSuccessAllowed: false,
};
const protocolRequired = {decision: 'require_protocol_support', ...denial};
const serverHoldRequired = {decision: 'require_server_hold', ...denial};
const explicitHold = {reconciliationRequired: true};

const source = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const monitorSource = source('server/routes/monitor.js');
const dispatchSource = source('server/services/profile-patrol-dispatch.js');
function exactRange(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `actual source contains ${startMarker}`);
  assert.equal(text.indexOf(startMarker, start + 1), -1, `unique actual source marker ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `actual source range ends at ${endMarker}`);
  return text.slice(start, end);
}
const dueSource = exactRange(monitorSource, "router.get('/due',", "router.post('/executions/:id/start',");
const startSource = exactRange(monitorSource, "router.post('/executions/:id/start',", "router.post('/executions/:id/finish',");
const finishSource = exactRange(monitorSource, "router.post('/executions/:id/finish',", "router.get('/settings',");
const runNowSource = monitorSource.slice(monitorSource.indexOf("router.post('/run-now',"));
assert.ok(runNowSource.startsWith("router.post('/run-now',"));

// Execute the actual legacy handler with canned database CAS results. This
// proves handler branches only; the SQL predicates are separately inspected.
// No middleware, route server, database, network or scheduler is started.
function actualLegacyFinishHarness(casResults = []) {
  const calls = {locks: 0, executions: [], subscriptions: [], snapshots: []};
  let handler;
  const tx = {
    queryOne: async (sql, params) => {
      assert.match(sql, /WHERE id = \$7 AND tenant_id = \$8 AND status IN \('pending', 'running'\)/);
      calls.executions.push({sql, params});
      return casResults.shift() ?? null;
    },
    execute: async (sql, params) => {calls.subscriptions.push({sql, params});},
  };
  const context = vm.createContext({
    router: {post: (path, ...handlers) => {
      assert.equal(path, '/executions/:id/finish');
      handler = handlers.at(-1);
    }},
    requireTenantAccess: () => {},
    requireTenantWriter: () => {},
    withTransaction: async (operation) => operation(tx),
    lockProfileDiscoverySubscriptionsForExecutions: async () => {calls.locks += 1;},
    captureOfficialCommentPatrolSnapshots: async (_, tenantId, executionId) => {
      calls.snapshots.push({tenantId, executionId});
    },
  });
  vm.runInContext(finishSource, context, {timeout: 1000});
  assert.equal(typeof handler, 'function');
  return {
    calls,
    run: async (body = {}) => {
      let response;
      let nextError;
      await handler({tenantId: 'tenant-a', params: {id: 'execution-a'}, body},
        {json: (value) => {response = JSON.parse(JSON.stringify(value));}},
        (error) => {nextError = error;});
      if (nextError) throw nextError;
      return response;
    },
  };
}

test('monitor finish prototype exposes only the requirement planner', () => {
  assert.deepEqual(Object.keys(contract), ['planMonitorFinish']);
});

test('without explicit hold or prior denial the planner defers without changing legacy behavior', () => {
  assert.deepEqual(planMonitorFinish(), defer);
  for (const signal of [undefined, null, false, true, '', 'reconciliationRequired', [], {},
    {ok: false}, {status: 'failed'}, {status: 'needs_action'},
    {reconciliationRequired: 'true'}, {requiresReconciliation: 1}]) {
    for (const capabilities of [undefined, null, {}, {reconciliationProtocolVersion: 1}]) {
      assert.deepEqual(planMonitorFinish({signal, capabilities}), defer);
    }
  }
});

test('malformed outer input denies rather than throwing into a legacy fallback', () => {
  for (const input of [null, [], [explicitHold], false, true, 0, 1, '', 'hold', () => ({})]) {
    assert.deepEqual(planMonitorFinish(input), protocolRequired);
  }
  assert.deepEqual(planMonitorFinish({}), defer);
  assert.deepEqual(planMonitorFinish(), defer, 'omitted optional input keeps the original empty-input behavior');
});

test('throwing signal or prior-denial accessors produce the same blocking decision', () => {
  const throwing = (field) => Object.defineProperty({}, field, {
    get() {throw new Error(`broken ${field} accessor`);},
  });
  for (const input of [
    throwing('signal'),
    {signal: throwing('reconciliationRequired')},
    {signal: throwing('error')},
    throwing('holdDecision'),
    {holdDecision: throwing('automaticReplayBlocked')},
  ]) {
    assert.deepEqual(planMonitorFinish(input), protocolRequired);
  }
});

test('capability accessor failure denies, while a direct hold avoids reading an unnecessary prior decision', () => {
  const brokenCapability = {signal: explicitHold};
  Object.defineProperty(brokenCapability, 'capabilities', {
    get() {throw new Error('capability advertisement unavailable');},
  });
  assert.deepEqual(planMonitorFinish(brokenCapability), protocolRequired);
  const capabilities = {};
  Object.defineProperty(capabilities, 'reconciliationProtocolVersion', {
    get() {throw new Error('capability version unavailable');},
  });
  assert.deepEqual(planMonitorFinish({signal: explicitHold, capabilities}), protocolRequired);
  const direct = {signal: explicitHold, capabilities: {reconciliationProtocolVersion: 1}};
  Object.defineProperty(direct, 'holdDecision', {
    get() {throw new Error('a confirmed direct signal must short-circuit this read');},
  });
  assert.deepEqual(planMonitorFinish(direct), serverHoldRequired);
});

test('hold without exact numeric capability 1 blocks legacy finish and requires protocol support', () => {
  for (const reconciliationProtocolVersion of [undefined, null, false, true, 0, -1, 2, '1', 1.5, [], {}, new Number(1)]) {
    assert.deepEqual(planMonitorFinish({signal: explicitHold,
      capabilities: {reconciliationProtocolVersion}}), protocolRequired);
  }
  assert.deepEqual(planMonitorFinish({signal: explicitHold}), protocolRequired);
});

test('capability 1 still only requires a server hold and never makes a finish payload', () => {
  const decision = planMonitorFinish({signal: explicitHold,
    capabilities: {reconciliationProtocolVersion: 1}});
  assert.deepEqual(decision, serverHoldRequired);
  for (const field of ['accepted', 'status', 'finishPayload', 'payload', 'receipt', 'holdReleased']) {
    assert.equal(field in decision, false);
  }
});

test('canonical wrapped signals cannot be downgraded to legacy failed or needs_action finish', () => {
  for (const signal of [{requiresReconciliation: true},
    {error: {code: 'LOCAL_CONFIRMATION_REQUIRED'}},
    {streamingSync: {reconciliationRequired: true}},
    {code: 'SYNC_RECONCILIATION_REQUIRED'},
    {code: 'STREAMING_SYNC_RECONCILIATION_REQUIRED'}]) {
    assert.deepEqual(planMonitorFinish({signal}), protocolRequired);
    assert.deepEqual(planMonitorFinish({signal,
      capabilities: {reconciliationProtocolVersion: 1}}), serverHoldRequired);
  }
});

test('strict prior automaticReplayBlocked denial survives a later absent or false signal', () => {
  for (const signal of [undefined, null, {reconciliationRequired: false}, {ok: true, status: 'completed'}]) {
    assert.deepEqual(planMonitorFinish({signal, holdDecision: {automaticReplayBlocked: true}}), protocolRequired);
    assert.deepEqual(planMonitorFinish({signal, holdDecision: {automaticReplayBlocked: true},
      capabilities: {reconciliationProtocolVersion: 1}}), serverHoldRequired);
  }
  for (const automaticReplayBlocked of [undefined, null, false, 0, 1, 'true', {}]) {
    assert.deepEqual(planMonitorFinish({holdDecision: {automaticReplayBlocked}}), defer);
  }
});

test('forged commit, receipt or acknowledgement fields never grant finish or replay authority', () => {
  for (const holdDecision of [
    {committed: true}, {accepted: true}, {acknowledged: true},
    {receipt: {committed: true}}, {decision: 'hold_committed'},
    {automaticReplayBlocked: false, terminalSuccessAllowed: true},
  ]) {
    assert.deepEqual(planMonitorFinish({signal: explicitHold, holdDecision,
      capabilities: {reconciliationProtocolVersion: 1}}), serverHoldRequired);
    assert.deepEqual(planMonitorFinish({holdDecision,
      capabilities: {reconciliationProtocolVersion: 1}}), defer,
    'defer is not an accepted or permitted finish');
  }
});

test('planner never reads raw receipts or acknowledgement bodies and leaves frozen input unchanged', () => {
  const holdDecision = {automaticReplayBlocked: true};
  for (const field of ['receipt', 'body', 'rawResponse', 'acknowledged', 'committed', 'decision']) {
    Object.defineProperty(holdDecision, field, {get() {throw new Error(`unexpected read: ${field}`);}});
  }
  const capabilities = Object.freeze({reconciliationProtocolVersion: 1});
  Object.freeze(holdDecision);
  assert.deepEqual(planMonitorFinish({signal: Object.freeze({ok: true}), holdDecision, capabilities}), serverHoldRequired);
  assert.equal(holdDecision.automaticReplayBlocked, true);
  assert.equal(capabilities.reconciliationProtocolVersion, 1);
});

test('returned decisions are fresh and caller mutation cannot clear a later denial', () => {
  const first = planMonitorFinish({signal: explicitHold});
  first.automaticReplayBlocked = false;
  first.legacyFinishAllowed = true;
  first.accepted = true;
  assert.deepEqual(planMonitorFinish({signal: explicitHold}), protocolRequired);
  assert.notEqual(planMonitorFinish(), planMonitorFinish());
});

test('KNOWN UNFIXED: legacy monitor execution schema and finish lack claim/agent/attempt identity', () => {
  const schema = source('server/db/migrations/001_initial_postgres.sql');
  const executionTable = exactRange(schema, 'CREATE TABLE IF NOT EXISTS monitor_executions (',
    'CREATE INDEX IF NOT EXISTS idx_monitor_executions_tenant_created');
  assert.match(executionTable, /tenant_id UUID NOT NULL/);
  assert.match(executionTable, /subscription_id UUID NOT NULL/);
  assert.doesNotMatch(executionTable, /agent_id|attempt_id|claim_epoch|assignment_revision|request_hash|hold_version/);
  assert.match(startSource, /requireTenantAccess, requireTenantWriter/);
  assert.match(finishSource, /requireTenantAccess, requireTenantWriter/);
  assert.doesNotMatch(startSource + finishSource, /requireCaptureAgent|captureAgent|claimEpoch|attemptId|expectedVersion|expectedRevision|requestHash/);
  assert.match(startSource, /WHERE id = \$1 AND tenant_id = \$2 AND status = 'pending'/);
  assert.match(finishSource, /WHERE id = \$7 AND tenant_id = \$8 AND status IN \('pending', 'running'\)/);
  assert.match(startSource + finishSource, /item\.metadata->>'monitorExecutionId'/,
    'linked cloud items are deliberately excluded from the legacy claim path');
});

test('KNOWN UNFIXED: actual legacy finish converts unfamiliar hold states into succeeded', async () => {
  for (const status of ['needs_action', 'reconciliation_required', 'held']) {
    const harness = actualLegacyFinishHarness([{id: 'execution-a', subscription_id: 'subscription-a'}]);
    const response = await harness.run({status, reconciliationRequired: true,
      reconciliationProtocolVersion: 1, claimEpoch: 'unverified', agentId: 'other-agent'});
    assert.equal(response.ok, true);
    assert.equal(harness.calls.executions[0].params[0], 'succeeded');
    assert.equal(harness.calls.snapshots.length, 1);
    assert.deepEqual(planMonitorFinish({signal: explicitHold}), protocolRequired,
      'the planner must never send this status through the legacy handler');
  }
});

test('actual legacy repeat-CAS miss avoids duplicate side effects but has no replay receipt', async () => {
  const harness = actualLegacyFinishHarness([{id: 'execution-a', subscription_id: 'subscription-a'}, null]);
  const first = await harness.run({status: 'succeeded', nextCursor: 'cursor-a'});
  const repeated = await harness.run({status: 'succeeded', nextCursor: 'cursor-a'});
  assert.equal(first.ok, true);
  assert.deepEqual(repeated, {ok: false, execution: null});
  assert.equal(harness.calls.executions.length, 2);
  assert.equal(harness.calls.subscriptions.length, 1);
  assert.equal(harness.calls.snapshots.length, 1);
  assert.equal(harness.calls.locks, 2);
  assert.doesNotMatch(finishSource, /idempotency|eventId|receiptId|payloadHash/,
    'same-payload replay and stale/conflicting finish are not distinguished');
});

test('KNOWN UNFIXED: failed finish still schedules another run instead of keeping a hold', async () => {
  const harness = actualLegacyFinishHarness([{id: 'execution-a', subscription_id: 'subscription-a'}]);
  await harness.run({status: 'failed', errorMessage: 'local confirmation unknown'});
  assert.equal(harness.calls.executions[0].params[0], 'failed');
  assert.equal(harness.calls.snapshots.length, 0);
  assert.match(harness.calls.subscriptions[0].sql, /ELSE now\(\) \+ interval '15 minutes'/);
  assert.doesNotMatch(harness.calls.subscriptions[0].sql, /reconciliation|hold/);
});

test('KNOWN UNFIXED: due, run-now and unique-active constraints lack a held-subscription fence', () => {
  assert.match(dueSource, /me\.status = 'pending'/);
  assert.doesNotMatch(dueSource, /FOR UPDATE|claimEpoch|reconciliation/);
  assert.match(runNowSource, /AND status IN \('pending', 'running'\)/);
  assert.match(runNowSource, /INSERT INTO monitor_executions \(tenant_id, subscription_id, status\)/);
  const migration = source('server/db/migrations/049_official_account_monitor_link.sql');
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_monitor_executions_subscription_active\s+ON monitor_executions \(subscription_id\)\s+WHERE status IN \('pending', 'running'\)/);
  assert.doesNotMatch(runNowSource + dueSource, /reconciliationRequired|automaticReplayBlocked|reconciliation_holds/);
});

test('KNOWN UNFIXED: scheduler selection, stale cleanup and cross-device renewal each need a scope-aware gate', () => {
  // Implementation checklist: gate BOTH read-only candidate discovery and the
  // locked recheck, stale cleanup, retry renewal and every materialization path.
  // These are source-level negative controls, not simulated SQL execution.
  const gates = [
    {
      name: 'due candidate discovery',
      text: exactRange(dispatchSource, 'async function loadDueProfilePatrolSubscriptionCandidates(', 'async function lockDueProfilePatrolSubscription('),
      marker: /execution\.status = 'running'/,
    },
    {
      name: 'locked due recheck',
      text: exactRange(dispatchSource, 'async function lockDueProfilePatrolSubscription(', 'async function enqueueDueProfilePatrolSubscription('),
      marker: /FOR UPDATE OF ms SKIP LOCKED/,
    },
    {
      name: 'stale execution reconciliation',
      text: exactRange(dispatchSource, 'export async function reconcileStaleProfilePatrolExecutions(', 'export async function materializeProfilePatrolTask('),
      marker: /SET status = 'failed'/,
    },
  ];
  for (const {name, text, marker} of gates) {
    assert.match(text, marker, name);
    assert.doesNotMatch(text, /reconciliationRequired|automaticReplayBlocked|reconciliation_holds/, name);
  }
  const retrySource = source('server/modules/capture/infrastructure/postgres-cross-device-retry.js');
  const renewal = exactRange(retrySource,
    '    const previousExecutionId = text(metadata.monitorExecutionId, 100);',
    'export async function dispatchCrossDeviceRetry(');
  assert.match(renewal, /SET status = 'failed'/);
  assert.match(renewal, /INSERT INTO monitor_executions \(tenant_id, subscription_id, status\)/);
  assert.match(renewal, /WHERE status IN \('pending', 'running'\)/);
  assert.doesNotMatch(renewal, /reconciliationRequired|automaticReplayBlocked|reconciliation_holds/);
});

test('cloud lineage has additional scope fields that a future monitor protocol must not confuse with legacy claims', () => {
  const recordStore = source('server/services/record-store.js');
  for (const marker of [
    'candidate.assigned_agent_id = $7::uuid',
    "candidate.metadata->>'monitorExecutionId' = $6::uuid::text",
    'attempt.assignment_revision = current_item.assignment_revision',
    'attempt.attempt_number = current_item.attempt_count',
    'attempt.id = $10::uuid',
    'attempt.request_hash = $11',
    'current_item.request_hash = $11',
  ]) assert.ok(recordStore.includes(marker), marker);
  assert.match(dispatchSource, /item_id, parent_task_id, execution_task_id,[\s\S]*?agent_id, attempt_number, assignment_revision, status,[\s\S]*?request_hash/);
  const projection = source('server/modules/capture/infrastructure/postgres-profile-discovery-work.js');
  assert.match(projection, /ORDER BY subscription\.id\s+FOR UPDATE OF subscription/);
  assert.match(projection, /ORDER BY item\.ordinal, item\.id\s+FOR UPDATE OF item/);
  assert.match(projection, /ORDER BY attempt\.item_id, attempt\.attempt_number, attempt\.id\s+FOR UPDATE OF attempt/);
  // Future hold persistence must follow the canonical lock order, preserve the
  // tenant/subscription/execution scope, and reject stale assignment/attempts.
});

test('monitor prototype cannot dispatch, persist, mutate server state or enter shipping runtime', () => {
  const prototype = source('prototypes/extension-sync-confirmation/monitor-finish-contract.mjs');
  assert.doesNotMatch(prototype, /\b(?:fetch|finishMonitorExecution|setTimeout|setInterval|queryOne|execute|withTransaction)\s*\(/);
  assert.doesNotMatch(prototype, /\b(?:chrome|indexedDB|localStorage|sessionStorage)\s*[.(]/);
  for (const file of ['sidebar/sidebar-logic.js', 'background.js', 'utils/capture-sync.js',
    'utils/api.js', 'server/routes/monitor.js', 'server/services/profile-patrol-dispatch.js']) {
    assert.doesNotMatch(source(file), /monitor-finish-contract\.mjs|planMonitorFinish\s*\(/, file);
  }
  for (const {path, source: actual} of readSidebarControllerSources()) {
    assert.doesNotMatch(actual, /monitor-finish-contract\.mjs|planMonitorFinish\s*\(/, path);
  }
});
