import assert from 'node:assert/strict';
import test from 'node:test';

import {captureTaskUnconfirmedLocalStopSql} from '../server/services/capture-cloud.js';
import {
  STOP_FENCE_CONTENT_EVIDENCE,
  STOP_FENCE_PHASES,
  STOP_FENCE_PROOF_EVIDENCE,
  evaluateStopFenceProof,
  STOP_FENCE_LOCAL_RELEASE_HOLD_MS,
  STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS,
  listCaptureAgentStopFences,
  normalizeStopFenceCheckResult,
  readStopFenceHeartbeatWork,
  recordStopFenceCheckResult,
  stopFenceAutoCheckEnabled,
  stopFenceCheckEscalated,
  stopFenceLocalReleaseHoldsNewWork,
  stopFenceReasonLabel,
  summarizeAgentStopFence,
} from '../server/services/capture-stop-fence.js';

const CHECK_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = 'unattended-request-1';
const binding = {checkId: CHECK_ID, taskId: TASK_ID, requestId: REQUEST_ID};
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const ago = minutes => new Date(NOW - minutes * 60_000).toISOString();
const later = minutes => new Date(NOW + minutes * 60_000).toISOString();

function proof(overrides = {}) {
  return {
    version: 1,
    mode: 'check',
    checkId: CHECK_ID,
    taskId: TASK_ID,
    requestId: REQUEST_ID,
    accepted: true,
    reason: 'previous_capture_stopped',
    retryable: false,
    requiresOperator: false,
    proofMethod: 'browser_sweep',
    requestKnown: true,
    requestStatus: 'needs_action',
    requestActive: false,
    runtimeEpochOrigin: 'browser_startup',
    runtimeStartedAt: ago(30),
    fenceRuntime: 'different',
    captureRequestKnown: true,
    sweepComplete: true,
    sweptTabCount: 4,
    unresolvedTabCount: 0,
    relayInFlightCount: 0,
    targets: [
      {tabId: 1, role: 'progress_tab', evidence: 'tab_closed', platform: 'xiaohongshu', documentState: 'unknown'},
      {tabId: 2, role: 'platform_tab', evidence: 'content_idle', platform: 'xiaohongshu', documentState: 'current_runtime'},
      {tabId: 3, role: 'runner', evidence: 'runner_closed', platform: 'extension', documentState: 'unknown'},
      {tabId: 4, role: 'platform_tab', evidence: 'unrelated_live_capture', platform: 'douyin', documentState: 'current_runtime'},
    ],
    pendingTabIds: [],
    pendingTabs: [],
    runnerTabsClosed: 1,
    scopedCancelSent: false,
    lockReleased: true,
    localLockBoundToRequest: false,
    residueReleased: true,
    checkedAt: ago(0),
    durationMs: 2310,
    message: '设备已确认旧采集页面已停止',
    ...overrides,
  };
}

function normalized(overrides = {}) {
  const result = normalizeStopFenceCheckResult(proof(overrides));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result;
}

test('receipt normalization is a bounded whitelist and rejects malformed receipts', () => {
  const raw = proof({
    unknownKey: 'dropped',
    debugSessionPresent: true,
    reason: 'x'.repeat(200),
    message: 'm'.repeat(500),
    targets: Array.from({length: 45}, (_, index) => ({
      tabId: index + 1, role: 'platform_tab', evidence: 'content_idle',
      platform: 'xiaohongshu', documentState: 'current_runtime', extra: {nested: true},
    })),
    pendingTabIds: [1, -2, 0, 'x', 3.5, ...Array.from({length: 30}, (_, index) => index + 10)],
    pendingTabs: Array.from({length: 15}, (_, index) => ({
      tabId: index + 1, platform: 'weibo', evidence: 'old_document_uninspectable', title: '标'.repeat(80),
    })),
  });
  const {ok, result} = normalizeStopFenceCheckResult(raw);
  assert.equal(ok, true);
  assert.equal('unknownKey' in result, false);
  assert.equal('debugSessionPresent' in result, false);
  assert.equal(result.reason.length, 80);
  assert.equal(result.message.length, 200);
  assert.equal(result.targets.length, 40);
  assert.equal(result.targetsTruncated, true);
  assert.equal('extra' in result.targets[0], false);
  assert.equal(result.pendingTabIds.length, 20);
  assert.ok(result.pendingTabIds.every(id => Number.isInteger(id) && id > 0));
  assert.equal(result.pendingTabs.length, 10);
  assert.equal(result.pendingTabs[0].title.length, 40);
  // Omitted booleans stay unknown instead of silently becoming false.
  const partial = normalizeStopFenceCheckResult({version: 1, mode: 'check', accepted: false, reason: 'probe_failed'});
  assert.equal(partial.ok, true);
  assert.equal(partial.result.requiresOperator, null);
  assert.equal(partial.result.requestActive, null);
  assert.equal(partial.result.unresolvedTabCount, null);

  for (const [label, value] of [
    ['non-object', 'accepted'],
    ['array', [proof()]],
    ['missing version', {...proof(), version: undefined}],
    ['version 2', proof({version: 2})],
    ['unknown mode', proof({mode: 'stop'})],
    ['non-boolean accepted', proof({accepted: 'true'})],
    ['missing reason', proof({reason: ''})],
    ['targets object', proof({targets: {}})],
    ['pending ids object', proof({pendingTabIds: {}})],
  ]) {
    assert.equal(normalizeStopFenceCheckResult(value).ok, false, label);
  }
});

test('a self-consistent browser sweep bound to the offered round is proof', () => {
  assert.deepEqual(evaluateStopFenceProof(normalized(), binding), {ok: true, reason: 'previous_capture_stopped'});
  // No platform page at all is still a complete sweep.
  assert.equal(evaluateStopFenceProof(normalized({targets: [], sweptTabCount: 0}), binding).ok, true);
  // A list cut at 40 only drops pages the node listed after the non-proof ones.
  const many = normalized({
    sweptTabCount: 45,
    targets: Array.from({length: 45}, (_, index) => ({
      tabId: index + 1, evidence: 'tab_closed', platform: 'xiaohongshu', documentState: 'unknown',
    })),
  });
  assert.equal(evaluateStopFenceProof(many, binding).ok, true);
  assert.equal(STOP_FENCE_PROOF_EVIDENCE.length, 8);
  for (const evidence of STOP_FENCE_PROOF_EVIDENCE) {
    const result = normalized({
      sweptTabCount: 1,
      targets: [{tabId: 9, evidence, platform: 'xiaohongshu', documentState: 'current_runtime'}],
    });
    assert.equal(evaluateStopFenceProof(result, binding).ok, true, evidence);
  }
});

test('every non-proof evidence, operator flag and binding mismatch keeps the fence', () => {
  for (const evidence of [
    'off_platform_observing', 'tab_frozen', 'probe_failed', 'tab_busy_unattributed',
    'capture_still_active', 'runner_close_failed', 'old_document_uninspectable',
    'source_identity_unverifiable', '',
  ]) {
    const result = normalized({
      sweptTabCount: 1,
      targets: [{tabId: 9, evidence, platform: 'xiaohongshu', documentState: 'current_runtime'}],
    });
    assert.equal(evaluateStopFenceProof(result, binding).ok, false, evidence || 'missing evidence');
  }
  for (const evidence of STOP_FENCE_CONTENT_EVIDENCE) {
    for (const documentState of ['before_runtime', 'unknown']) {
      const result = normalized({
        sweptTabCount: 1,
        targets: [{tabId: 9, evidence, platform: 'xiaohongshu', documentState}],
      });
      assert.equal(evaluateStopFenceProof(result, binding).ok, false, `${evidence}/${documentState}`);
    }
  }
  const cases = [
    ['requires operator', {requiresOperator: true}],
    ['operator flag omitted', {requiresOperator: undefined}],
    ['pending tab ids', {pendingTabIds: [7]}],
    ['local lock still bound', {localLockBoundToRequest: true}],
    ['request still active', {requestActive: true}],
    ['request activity omitted', {requestActive: undefined}],
    ['sweep incomplete', {sweepComplete: false}],
    ['unresolved tabs', {unresolvedTabCount: 1}],
    ['unresolved count omitted', {unresolvedTabCount: undefined}],
    ['relay in flight', {relayInFlightCount: 2}],
    ['swept count short', {sweptTabCount: 3}],
    ['not accepted', {accepted: false}],
    ['wrong reason', {reason: 'local_release_done'}],
    ['wrong proof method', {proofMethod: 'recorded_tabs'}],
    ['release-only receipt', {mode: 'release_only'}],
    ['other check id', {checkId: '33333333-3333-4333-8333-333333333333'}],
    ['other task id', {taskId: '44444444-4444-4444-8444-444444444444'}],
    ['other request id', {requestId: 'another-request'}],
  ];
  for (const [label, overrides] of cases) {
    const result = normalizeStopFenceCheckResult(proof(overrides));
    const verdict = result.ok ? evaluateStopFenceProof(result.result, binding) : {ok: false};
    assert.equal(verdict.ok, false, label);
  }
  assert.equal(evaluateStopFenceProof(normalized({version: 1}), {...binding, requestId: ''}).ok, false,
    'an empty request id can never bind a proof');
  // The legacy stop receipt shape is never proof, before or after normalization.
  const legacy = {accepted: true, state: 'canceled', requestId: REQUEST_ID};
  assert.equal(normalizeStopFenceCheckResult(legacy).ok, false);
  assert.equal(evaluateStopFenceProof(legacy, binding).ok, false);
});

test('escalation triggers on the third failure, a 30-minute first round, or an operator result', () => {
  const base = {version: 1, checkId: CHECK_ID, round: 1, firstIssuedAt: ago(5), issuedAt: ago(5),
    expiresAt: later(5), lastOfferedAt: ago(5), failureCount: 0, lastResult: null, escalatedAt: null,
    resolvedAt: null};
  assert.equal(stopFenceCheckEscalated(base, NOW), false);
  assert.equal(stopFenceCheckEscalated({...base, failureCount: 2}, NOW), false);
  assert.equal(stopFenceCheckEscalated({...base, failureCount: 3}, NOW), true);
  assert.equal(stopFenceCheckEscalated({...base, firstIssuedAt: ago(29)}, NOW), false);
  assert.equal(stopFenceCheckEscalated({...base, firstIssuedAt: ago(30)}, NOW), true);
  // A round a recheck started while the node was offline was never offered:
  // however old it is, nobody was asked yet, so it cannot escalate by age.
  assert.equal(stopFenceCheckEscalated({...base, firstIssuedAt: ago(45), issuedAt: ago(45),
    expiresAt: ago(35), lastOfferedAt: null}, NOW), false);
  const operatorResult = {checkId: CHECK_ID, at: ago(1), accepted: false,
    reason: 'old_document_uninspectable', requiresOperator: true};
  assert.equal(stopFenceCheckEscalated({...base, failureCount: 1, lastResult: operatorResult}, NOW), true);
  assert.equal(stopFenceCheckEscalated({...base, escalatedAt: ago(1)}, NOW), true, 'escalation is sticky');
  assert.equal(stopFenceCheckEscalated({...base, failureCount: 5, resolvedAt: ago(0)}, NOW), false);
  // A manual recheck starts a new epoch: counters reset and an older operator
  // result no longer escalates by itself.
  const rechecked = {...base, round: 4, firstIssuedAt: ago(0), issuedAt: ago(0), failureCount: 0,
    escalatedAt: null, lastResult: operatorResult};
  assert.equal(stopFenceCheckEscalated(rechecked, NOW), false);
});

test('the server kill switch only accepts an explicit off', () => {
  assert.equal(stopFenceAutoCheckEnabled({}), true);
  assert.equal(stopFenceAutoCheckEnabled({CAPTURE_STOP_FENCE_AUTO_CHECK: 'on'}), true);
  assert.equal(stopFenceAutoCheckEnabled({CAPTURE_STOP_FENCE_AUTO_CHECK: ' OFF '}), false);
  assert.match(stopFenceReasonLabel('old_document_uninspectable'), /重启 Chrome/u);
  assert.match(stopFenceReasonLabel('not_a_known_reason'), /not_a_known_reason/u);
});

function fenceRow(overrides = {}) {
  return {
    kind: 'fence', id: TASK_ID, parent_task_id: null, agent_id: 'agent-1', status: 'superseded',
    platform: 'xiaohongshu', title: 'Old keyword', error: {code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED',
      message: '旧采集页面未能安全停止'}, message: '', fenced_at: ago(60), request_id: REQUEST_ID,
    attempt_id: 'attempt-1', stop_fence_check: null, local_release_expires_at: null,
    ...overrides,
  };
}

const onlineAgent = {id: 'agent-1', status: 'active', online: true, dispatch_ready: true,
  capabilities: {previousCaptureStopCheckV1: true}};

test('every node gets exactly one server-computed phase in priority order', () => {
  const phase = (agent, rows, options = {}) =>
    summarizeAgentStopFence(agent, rows, {now: NOW, autoCheckEnabled: true, ...options})?.phase;
  const issued = {version: 1, checkId: CHECK_ID, round: 1, firstIssuedAt: ago(2), issuedAt: ago(2),
    expiresAt: later(8), lastOfferedAt: ago(2), failureCount: 0, lastResult: null};
  const failed = {...issued, failureCount: 1, nextIssueAt: later(3),
    lastResult: {checkId: CHECK_ID, at: ago(1), accepted: false, reason: 'probe_failed', requiresOperator: false}};
  const needsAction = fenceRow({id: 'needs-action', status: 'needs_action'});
  const cases = [
    ['task_action_required', onlineAgent, [needsAction]],
    ['manual_only', {...onlineAgent, capabilities: {}}, [fenceRow()]],
    ['manual_only', onlineAgent, [fenceRow(), fenceRow({id: 'clone', request_id: ''})]],
    ['auto_check_disabled', onlineAgent, [fenceRow()], {autoCheckEnabled: false}],
    ['offline', {...onlineAgent, online: false, dispatch_ready: false}, [fenceRow()]],
    ['heartbeat_degraded', {...onlineAgent, dispatch_ready: false}, [fenceRow()]],
    ['needs_operator', onlineAgent, [fenceRow({stop_fence_check: {...failed, failureCount: 3}})]],
    ['node_retrying', onlineAgent, [fenceRow({stop_fence_check: failed})]],
    ['node_checking', onlineAgent, [fenceRow({stop_fence_check: issued})]],
    ['awaiting_node', onlineAgent, [fenceRow()]],
    ['local_release_pending', onlineAgent, [fenceRow({kind: 'local_release',
      error: {code: 'HISTORICAL_STOP_FENCE_RECONCILED'}, local_release_expires_at: later(600)})]],
  ];
  const seen = new Set();
  for (const [expected, agent, rows, options] of cases) {
    assert.equal(phase(agent, rows, options), expected, expected);
    seen.add(expected);
  }
  assert.deepEqual([...seen].sort(), [...STOP_FENCE_PHASES].sort());
  // Priorities: a superseded fence outranks leftovers; manual-only outranks
  // the kill switch and connectivity; offline outranks escalation.
  assert.equal(phase(onlineAgent, [fenceRow(), needsAction]), 'awaiting_node');
  assert.equal(phase({...onlineAgent, capabilities: {}}, [fenceRow()], {autoCheckEnabled: false}), 'manual_only');
  assert.equal(phase({...onlineAgent, online: false}, [fenceRow()], {autoCheckEnabled: false}), 'auto_check_disabled');
  assert.equal(phase({...onlineAgent, online: false},
    [fenceRow({stop_fence_check: {...failed, failureCount: 3}})]), 'offline');
  assert.equal(phase(onlineAgent, [fenceRow({stop_fence_check: {...issued, expiresAt: ago(1)}})]), 'awaiting_node');
  assert.equal(phase(onlineAgent, [fenceRow({stop_fence_check: {...issued, firstIssuedAt: ago(31)}})]),
    'needs_operator', 'a first round older than 30 minutes needs a person');
  assert.equal(summarizeAgentStopFence(onlineAgent, [], {now: NOW}), null);
  assert.equal(summarizeAgentStopFence(onlineAgent, [fenceRow({kind: 'local_release',
    local_release_expires_at: ago(1)})], {now: NOW}), null, 'expired local releases are not shown');
});

test('the node summary carries counts, the oldest fence and bounded task details', () => {
  const summary = summarizeAgentStopFence(onlineAgent, [
    fenceRow({fenced_at: ago(90), stop_fence_check: {version: 1, checkId: CHECK_ID, round: 2,
      firstIssuedAt: ago(40), issuedAt: ago(2), expiresAt: later(8), lastOfferedAt: ago(2),
      failureCount: 3, escalatedAt: ago(10), lastResult: {checkId: 'older', at: ago(5), accepted: false,
        reason: 'old_document_uninspectable', requiresOperator: true, pendingTabCount: 1,
        pendingTabs: [{platform: 'xiaohongshu', evidence: 'old_document_uninspectable', title: '搜索页'}]}}}),
    fenceRow({id: 'clone', request_id: '', fenced_at: ago(30)}),
    fenceRow({id: 'held', status: 'needs_action', fenced_at: ago(20)}),
    fenceRow({id: 'released', kind: 'local_release', local_release_expires_at: later(60)}),
  ], {now: NOW, autoCheckEnabled: true});
  assert.equal(summary.phase, 'manual_only');
  assert.equal(summary.task_count, 3);
  assert.equal(summary.superseded_count, 2);
  assert.equal(summary.action_required_count, 1);
  assert.equal(summary.manual_only_task_count, 1);
  assert.equal(summary.local_release_pending_count, 1);
  assert.equal(summary.since, ago(90));
  assert.equal(summary.escalated, true);
  assert.equal(summary.escalated_at, ago(10));
  assert.deepEqual(summary.superseded_task_ids, [TASK_ID, 'clone'],
    'every superseded fence id, for the operator confirmation');
  assert.equal(summary.tasks.length, 3, 'released rows are counted, not listed');
  assert.ok(summary.tasks.every(task => task.kind === 'fence'));
  const [first, clone, held] = summary.tasks;
  assert.equal(first.auto_checkable, true);
  assert.equal(first.message, '旧采集页面未能安全停止');
  assert.equal(first.check.round, 2);
  assert.equal(first.check.failure_count, 3);
  assert.equal(first.check.last_result.requires_operator, true);
  assert.equal(first.check.last_result.pending_tabs[0].title, '搜索页');
  assert.equal(clone.auto_checkable, false);
  assert.equal(clone.check, null);
  assert.equal(held.auto_checkable, false);
});

test('the fence listing reuses the exact admission predicate and filters by node', async () => {
  const statements = [];
  const executor = {queryAll: async (sql, params) => { statements.push({sql, params}); return []; }};
  await listCaptureAgentStopFences(executor, 'tenant-1', {
    agentId: '55555555-5555-4555-8555-555555555555',
    onlySuperseded: true,
    includeLocalRelease: true,
    limit: 6,
  });
  const [{sql, params}] = statements;
  assert.ok(sql.includes(captureTaskUnconfirmedLocalStopSql('task')), 'same fence SQL as admission');
  assert.match(sql, /HISTORICAL_STOP_FENCE_RECONCILED/u);
  assert.match(sql, /localRelease,state/u);
  assert.deepEqual(params, ['tenant-1', '55555555-5555-4555-8555-555555555555', true, true, 6, false, 200, false]);
  assert.deepEqual(await listCaptureAgentStopFences(executor, 'tenant-1', {agentId: 'not-a-uuid'}), []);
  assert.equal(statements.length, 1, 'an invalid node id never widens to the whole tenant');

  // Tenant-wide: every node keeps its own first 200 rows, so one node with
  // many fences can never push another node's fences out of the overview.
  await listCaptureAgentStopFences(executor, 'tenant-1', {includeLocalRelease: true});
  const tenantWide = statements.at(-1);
  assert.match(tenantWide.sql, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY stop_fence\.agent_id/u);
  // Fences first; among local releases the never-offered ones first, so the
  // heartbeat claim (six rows) always reaches a new release.
  assert.match(tenantWide.sql,
    /ORDER BY stop_fence\.kind,[\s\S]*?\(stop_fence\.kind = 'local_release'\s+AND NULLIF\(stop_fence\.stop_fence_check #>> '\{localRelease,firstOfferedAt\}', ''\) IS NOT NULL\),\s+stop_fence\.fenced_at, stop_fence\.id\s+\) AS agent_row_number/u);
  assert.match(tenantWide.sql, /WHERE ranked\.agent_row_number <= \$7\s+ORDER BY ranked\.agent_row_number/u);
  assert.deepEqual(tenantWide.params, ['tenant-1', null, false, true, 5000, false, 200, false]);
  // The node-scoped default equals the per-node cap: the confirm route checks
  // exactly the rows the overview listed for that node.
  await listCaptureAgentStopFences(executor, 'tenant-1', {agentId: '55555555-5555-4555-8555-555555555555'});
  assert.deepEqual(statements.at(-1).params.slice(4), [200, false, 200, false]);
  // The heartbeat claim only takes rows the node can locate, in SQL, so rows
  // without a request id never use up its window.
  await listCaptureAgentStopFences(executor, 'tenant-1', {
    agentId: '55555555-5555-4555-8555-555555555555', requireRequestId: true, limit: 6});
  assert.equal(statements.at(-1).params[7], true);
  assert.match(statements.at(-1).sql, /\$8::boolean = false OR COALESCE\(NULLIF\(task\.control_task_id, ''\), NULLIF\(task\.client_task_id, ''\), ''\) <> ''/u);
  assert.match(statements.at(-1).sql, /\$8::boolean = false OR COALESCE\(NULLIF\(released\.control_task_id, ''\), NULLIF\(released\.client_task_id, ''\), ''\) <> ''/u);
});

test('a pending local release holds new work only until it is done, and only briefly', async () => {
  const release = {checkId: CHECK_ID, state: 'pending', requestedAt: ago(1), expiresAt: later(1439),
    firstOfferedAt: null, lastOfferedAt: null, nextIssueAt: null, lastResult: null};
  const holdMinutes = STOP_FENCE_LOCAL_RELEASE_HOLD_MS / 60_000;
  const unofferedMinutes = STOP_FENCE_LOCAL_RELEASE_UNOFFERED_HOLD_MS / 60_000;
  const holds = (value, previousFullHeartbeatAt = null) =>
    stopFenceLocalReleaseHoldsNewWork(value, NOW, {previousFullHeartbeatAt});
  assert.equal(holds(release), true, 'just confirmed, not offered yet');
  // Never offered: the first full heartbeat after the confirmation always
  // holds, however long the node was away, because the claim offers the
  // release in that same heartbeat (reviewer repro: confirm while offline,
  // back 15 minutes later -> create and release_only together).
  for (const minutes of [holdMinutes + 5, unofferedMinutes + 5, 23 * 60]) {
    assert.equal(holds({...release, requestedAt: ago(minutes)}, ago(minutes + 5)), true,
      `first heartbeat back ${minutes} min after the confirmation`);
    assert.equal(holds({...release, requestedAt: ago(minutes)}), true, 'unknown previous heartbeat');
  }
  // A heartbeat that started a moment before the confirmation committed may
  // carry a slightly later timestamp; it has not seen the release either.
  assert.equal(holds({...release, requestedAt: ago(unofferedMinutes + 5)},
    new Date(NOW - (unofferedMinutes + 5) * 60_000 + 30_000).toISOString()), true);
  // The node already had a full heartbeat after the confirmation and the
  // release is still not offered (a claim failed, or a large confirmation is
  // offered three rows per heartbeat): keep holding within the bound...
  assert.equal(holds({...release, requestedAt: ago(holdMinutes + 1)}, ago(holdMinutes - 1)), true,
    'rows of a large confirmation not offered yet keep holding past ten minutes');
  assert.equal(holds({...release, requestedAt: ago(unofferedMinutes - 1)}, ago(1)), true);
  // ...but a claim that keeps failing never keeps the node from work for long.
  assert.equal(holds({...release, requestedAt: ago(unofferedMinutes)}, ago(1)), false,
    'never offered through the whole bound while the node kept heartbeating: stop holding');
  // Once offered, the hold runs from the first offer.
  assert.equal(holds({...release, requestedAt: ago(120), firstOfferedAt: ago(1), lastOfferedAt: ago(1)}, ago(1)),
    true, 'the hold runs from the first offer');
  assert.equal(holds({...release, firstOfferedAt: ago(holdMinutes)}), false);
  assert.equal(holds({...release, firstOfferedAt: ago(4), nextIssueAt: later(2),
    lastResult: {accepted: false, reason: 'lock_holder_alive'}}), true,
  'a failed answer is retried inside the window, still without new work');
  assert.equal(holds({...release, firstOfferedAt: 'garbage'}), false);
  assert.equal(holds({...release, state: 'done'}), false, 'done ends the hold');
  assert.equal(holds({...release, state: 'expired'}), false);
  assert.equal(holds({...release, expiresAt: ago(1)}), false);
  assert.equal(holds({...release, checkId: ''}), false);
  assert.equal(holds({...release, requestedAt: 'garbage'}), false);
  assert.equal(holds(null), false);
  assert.equal(stopFenceLocalReleaseHoldsNewWork(release, NOW), true, 'options are optional');

  const statements = [];
  const heartbeatWork = async row => readStopFenceHeartbeatWork({
    queryOne: async (sql, params) => { statements.push({sql, params}); return row; },
  }, {tenantId: 'tenant-1', agentId: 'agent-1', now: NOW});
  assert.deepEqual(await heartbeatWork({fence_pending: false, local_release_pending: false, local_releases: []}),
    {checkDue: false, holdNewWork: false});
  assert.deepEqual(await heartbeatWork({fence_pending: true, local_release_pending: false, local_releases: []}),
    {checkDue: true, holdNewWork: false});
  assert.deepEqual(await heartbeatWork({fence_pending: false, local_release_pending: true,
    local_releases: [release]}), {checkDue: true, holdNewWork: true});
  assert.deepEqual(await heartbeatWork({fence_pending: false, local_release_pending: true,
    local_releases: []}), {checkDue: true, holdNewWork: false},
  'an expired pending release is still claimed once, to be marked expired, but never holds');
  // The previous full heartbeat reaches the predicate.
  const stale = {...release, requestedAt: ago(unofferedMinutes + 5)};
  const withPrevious = previousFullHeartbeatAt => readStopFenceHeartbeatWork({
    queryOne: async () => ({fence_pending: false, local_release_pending: true, local_releases: [stale]}),
  }, {tenantId: 'tenant-1', agentId: 'agent-1', previousFullHeartbeatAt, now: NOW});
  assert.equal((await withPrevious(ago(unofferedMinutes + 10))).holdNewWork, true, 'first heartbeat back');
  assert.equal((await withPrevious(new Date(NOW - 60_000))).holdNewWork, false, 'already heard since, bound passed');
  // Every branch only names rows the heartbeat claim can locate.
  const [{sql}] = statements;
  assert.equal(sql.match(/COALESCE\(NULLIF\(control_task_id, ''\), NULLIF\(client_task_id, ''\), ''\) <> ''/gu).length, 1);
  assert.equal(sql.match(/COALESCE\(NULLIF\(released\.control_task_id, ''\), NULLIF\(released\.client_task_id, ''\), ''\) <> ''/gu).length, 3);
  // The hold is read from unexpired releases: the latest never-offered one by
  // requestedAt and the latest offered one by firstOfferedAt. The predicate
  // grows with those timestamps, so if any release holds, one of these two
  // does, however many releases the node has.
  const holding = sql.slice(sql.indexOf('AS local_release_pending'));
  assert.equal(holding.match(/\{stopFenceCheck,localRelease,expiresAt\}[\s\S]*?> now\(\)/gu).length, 2);
  assert.match(holding, /firstOfferedAt\}', ''\) IS NULL\s+ORDER BY CASE[\s\S]*?\{stopFenceCheck,localRelease,requestedAt\}'\)::timestamptz\s+END DESC NULLS LAST, released\.id\s+LIMIT 1/u);
  assert.match(holding, /firstOfferedAt\}', ''\) IS NOT NULL\s+ORDER BY CASE[\s\S]*?\{stopFenceCheck,localRelease,firstOfferedAt\}'\)::timestamptz\s+END DESC NULLS LAST, released\.id\s+LIMIT 1/u);
  assert.doesNotMatch(holding, /LIMIT 20/u, 'never an arbitrary first-N subset');
  assert.doesNotMatch(sql.slice(sql.indexOf('AS fence_pending'), sql.indexOf('AS local_release_pending')), /expiresAt/u,
    'expired pending releases still make the claim run');
});

test('the summary says when a confirmed node is still held for its local lock release', () => {
  const releaseRow = localRelease => fenceRow({kind: 'local_release', status: 'superseded',
    error: {code: 'HISTORICAL_STOP_FENCE_RECONCILED'}, local_release_expires_at: later(600),
    stop_fence_check: {version: 1, resolvedAt: ago(1), resolution: 'operator_confirmed', localRelease}});
  const pending = {checkId: CHECK_ID, state: 'pending', requestedAt: ago(1), expiresAt: later(1439)};
  const summary = (agent, rows, options = {}) =>
    summarizeAgentStopFence(agent, rows, {now: NOW, autoCheckEnabled: true, ...options});
  // Same predicate as the heartbeat hold, with the stored full heartbeat as
  // the "previous" one of the next heartbeat.
  const held = summary({...onlineAgent, last_full_heartbeat_at: ago(2)}, [releaseRow(pending)]);
  assert.equal(held.phase, 'local_release_pending');
  assert.equal(held.local_release_holds_new_work, true, 'confirmed a minute ago, not offered yet');
  assert.equal(summary({...onlineAgent, last_full_heartbeat_at: ago(0.5)},
    [releaseRow({...pending, firstOfferedAt: ago(11), lastOfferedAt: ago(1)})]).local_release_holds_new_work,
  false, 'the offered window has passed');
  assert.equal(summary({...onlineAgent, last_full_heartbeat_at: ago(0.5)},
    [releaseRow({...pending, state: 'done'})]).local_release_holds_new_work, false, 'done ends the hold');
  // Only 0.4.16 nodes with the kill switch off are held by the heartbeat.
  assert.equal(summary({...onlineAgent, capabilities: {}}, [releaseRow(pending)]).local_release_holds_new_work, false);
  assert.equal(summary(onlineAgent, [releaseRow(pending)], {autoCheckEnabled: false}).local_release_holds_new_work, false);
  assert.equal(summary(onlineAgent, [fenceRow()]).local_release_holds_new_work, false);
});

test('rounds that only observe an off-site page never escalate by failure count', async () => {
  const statements = [];
  const tx = {execute: async (sql, params) => { statements.push({sql, params}); }};
  const events = () => statements.filter(entry => /INSERT INTO capture_task_events/u.test(entry.sql))
    .map(entry => entry.params[3]);
  const task = {id: TASK_ID, tenant_id: 'tenant-1'};
  const agent = {id: 'agent-1', display_name: '北京'};
  const observing = {checkId: CHECK_ID, reason: 'off_platform_observing', retryable: true,
    requiresOperator: false, pendingTabs: [{platform: 'xiaohongshu', evidence: 'off_platform_observing',
      title: '浏览器错误页·小红书搜索页'}], message: '旧页面已离开平台，观察满 10 分钟后确认'};
  let state = {version: 1, checkId: CHECK_ID, round: 1, firstIssuedAt: ago(1), issuedAt: ago(1),
    expiresAt: later(9), lastOfferedAt: ago(1), offerCount: 1, failureCount: 0, nextIssueAt: null,
    escalatedAt: null, lastResult: null};
  // The Extension needs ten continuous minutes; rounds come every three.
  for (let round = 1; round <= 4; round += 1) {
    const at = NOW + (round - 1) * 3.5 * 60_000;
    state = await recordStopFenceCheckResult(tx, {task, agent, state: {...state, round}, result: observing, now: at});
    assert.equal(state.failureCount, 0, `observing round ${round} is not a failure`);
    assert.equal(state.escalatedAt ?? null, null, `observing round ${round} does not escalate`);
    assert.equal(state.lastResult.reason, 'off_platform_observing');
    assert.ok(Date.parse(state.nextIssueAt) > at, 'it is still retried after three minutes');
  }
  assert.deepEqual(events(), ['stop_fence_check_failed'], 'one event for the reason, not one per round');
  assert.equal(stopFenceCheckEscalated(state, NOW + 12 * 60_000), false);
  // Still bounded: an observation that never ends escalates at thirty minutes.
  assert.equal(stopFenceCheckEscalated(state, Date.parse(state.firstIssuedAt) + 30 * 60_000), true);
  // Any other retryable reason still counts, and a changed reason is logged.
  state = await recordStopFenceCheckResult(tx, {task, agent, state,
    result: {...observing, reason: 'probe_failed', pendingTabs: []}, now: NOW + 14 * 60_000});
  assert.equal(state.failureCount, 1);
  assert.deepEqual(events(), ['stop_fence_check_failed', 'stop_fence_check_failed']);
  // An observing result flagged for an operator is not the benign case.
  state = await recordStopFenceCheckResult(tx, {task, agent, state,
    result: {...observing, requiresOperator: true}, now: NOW + 15 * 60_000});
  assert.equal(state.failureCount, 2);
  assert.ok(state.escalatedAt, 'an operator-flagged result escalates');
  // After a manual recheck the same reason starts a new epoch and is logged again.
  const rechecked = {...state, firstIssuedAt: new Date(NOW + 16 * 60_000).toISOString(),
    failureCount: 0, escalatedAt: null};
  const before = events().filter(type => type === 'stop_fence_check_failed').length;
  await recordStopFenceCheckResult(tx, {task, agent, state: rechecked, result: observing, now: NOW + 17 * 60_000});
  await recordStopFenceCheckResult(tx, {task, agent, state: {...rechecked, lastResult: {
    ...observing, checkId: CHECK_ID, at: new Date(NOW + 15.5 * 60_000).toISOString()}},
  result: observing, now: NOW + 18 * 60_000});
  assert.equal(events().filter(type => type === 'stop_fence_check_failed').length, before + 2,
    'a result from before the recheck belongs to the previous epoch');
});
