import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const route = await readFile(
  new URL('../server/routes/capture-orchestrations.js', import.meta.url),
  'utf8',
);
const serverApp = await readFile(
  new URL('../server/app.js', import.meta.url),
  'utf8',
);

function section(startMarker, endMarker) {
  const start = route.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = route.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return route.slice(start, end);
}

test('orchestration router is mounted under the existing capture-cloud namespace', () => {
  assert.match(
    serverApp,
    /import captureOrchestrationsRouter from '\.\/routes\/capture-orchestrations\.js';/u,
  );
  assert.match(
    serverApp,
    /app\.use\('\/api\/capture-cloud', captureOrchestrationsRouter\);/u,
  );
});

test('all orchestration mutations require a tenant-scoped writer session', () => {
  for (const marker of [
    "'/orchestrations'",
    "'/orchestrations/:id/draft'",
    "'/orchestrations/:id/allocation-preview'",
    "'/orchestrations/:id/dispatch'",
    "'/orchestrations/:id/stop'",
    "'/orchestrations/:id/schedule'",
    "'/orchestrations/:id/schedule/pause'",
    "'/orchestrations/:id/schedule/resume'",
    "'/orchestrations/:id/schedule/run-now'",
    "'/orchestrations/:id/retry-items'",
    "'/orchestrations/:id/resolve-attention'",
  ]) {
    const start = route.indexOf(marker);
    assert.notEqual(start, -1);
    const middleware = route.slice(start, start + 260);
    assert.match(middleware, /requireTenantAccess/u);
    assert.match(middleware, /requireSessionUser/u);
    assert.match(middleware, /requireTenantWriter/u);
  }
  const detailStart = route.indexOf("'/orchestrations/:id'");
  assert.notEqual(detailStart, -1);
  assert.match(route.slice(detailStart, detailStart + 240), /requireTenantAccess/u);
  assert.match(route.slice(detailStart, detailStart + 240), /requireSessionUser/u);
});

test('create is idempotent and creates only the parent plus keyword items', () => {
  const create = section(
    "router.post(\n  '/orchestrations'",
    "router.post(\n  '/orchestrations/:id/allocation-preview'",
  );
  assert.match(
    create,
    /\$1::uuid, \$2, \$1::uuid::text, 'capture_orchestration'/u,
  );
  assert.doesNotMatch(
    create,
    /\$1::text/u,
    'parent task id must have one PostgreSQL parameter type',
  );
  assert.match(create, /metadata\.orchestrationRequestHash !== requestHash/u);
  assert.match(create, /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)/u);
  assert.match(create, /draft\.created_at < now\(\) - interval '24 hours'/u);
  assert.match(create, /item\.status <> 'pending'/u);
  assert.match(create, /'idempotency_key_conflict'/u);
  assert.match(create, /INSERT INTO capture_tasks/u);
  assert.match(create, /'capture_orchestration'/u);
  assert.match(create, /draft: true/u);
  assert.match(create, /orchestration_revision, source_updated_at/u);
  assert.match(create, /INSERT INTO capture_task_items/u);
  assert.match(create, /'keyword', 'pending'/u);
  assert.doesNotMatch(create, /INSERT INTO capture_agent_commands/u);
  assert.doesNotMatch(create, /INSERT INTO capture_task_item_attempts/u);
});

test('preview-only orchestration drafts can be discarded only before assignment', () => {
  const discard = section(
    "router.delete(\n  '/orchestrations/:id/draft'",
    "router.post(\n  '/orchestrations/:id/allocation-preview'",
  );
  assert.match(discard, /parentSelect\(\{lock: true\}\)/u);
  assert.match(discard, /orchestration_revision \|\| 0\) === 0/u);
  assert.match(discard, /children\.length === 0/u);
  assert.match(discard, /item\.status === 'pending'/u);
  assert.match(discard, /DELETE FROM capture_tasks/u);
  assert.match(discard, /'orchestration_not_draft'/u);
});

test('allocation preview uses deterministic balanced groups and validates compatible tenant agents', () => {
  const preview = section(
    "router.post(\n  '/orchestrations/:id/allocation-preview'",
    'function normalizeDispatch',
  );
  assert.match(preview, /allocateKeywordWorkItems\(\{/u);
  assert.match(preview, /agentIds: normalizedAgents\.agentIds/u);
  assert.match(preview, /loadCompatibleAgents\(/u);
  assert.match(preview, /parent\.platform/u);
  assert.match(preview, /insufficient_agents/u);
  assert.match(preview, /Math\.ceil\(items\.length \/ 30\)/u);

  const compatibility = section(
    'async function loadCompatibleAgents',
    'function parentSelect',
  );
  assert.match(
    compatibility,
    /WHERE ca\.tenant_id = \$1[\s\S]*ca\.id = ANY\(\$2::uuid\[\]\)/u,
  );
  assert.match(compatibility, /ORDER BY ca\.id/u);
  assert.match(compatibility, /agentCompatibilityFailure/u);
});

test('dispatch is revision-CAS protected and locks parent, items, then agents', () => {
  const dispatch = section(
    "router.post(\n  '/orchestrations/:id/dispatch'",
    "router.post(\n  '/orchestrations/:id/stop'",
  );
  const parentLock = dispatch.indexOf('parentSelect({lock: true})');
  const itemLock = dispatch.indexOf('listParentItems(', parentLock);
  const agentLock = dispatch.indexOf('loadCompatibleAgents(', itemLock);
  assert.ok(parentLock >= 0);
  assert.ok(itemLock > parentLock);
  assert.ok(agentLock > itemLock);
  assert.match(dispatch, /currentRevision !== normalized\.expectedRevision/u);
  assert.match(dispatch, /'revision_conflict'/u);
  assert.match(dispatch, /items\.length !== normalized\.assignments\.length/u);
  assert.match(dispatch, /'assignment_coverage_mismatch'/u);
  assert.match(route, /function normalizeDispatch[\s\S]*'duplicate_item_assignment'/u);
  assert.match(
    dispatch,
    /orchestration_revision = orchestration_revision \+ 1[\s\S]*AND orchestration_revision = \$5/u,
  );
  assert.match(dispatch, /metadata = \(metadata - 'draft'\)/u);
  assert.match(dispatch, /exactCommittedReplay/u);
  assert.match(dispatch, /idempotent: result\.existing === true/u);
});

test('one-time dispatch creates disjoint ordinary child tasks, create commands, item attempts, and audit events', () => {
  const dispatch = section(
    "router.post(\n  '/orchestrations/:id/dispatch'",
    "router.post(\n  '/orchestrations/:id/stop'",
  );
  assert.match(dispatch, /parent_task_id, origin_agent_id, assigned_agent_id/u);
  assert.match(dispatch, /\$1::uuid[\s\S]*\$1::uuid::text/u);
  assert.doesNotMatch(
    dispatch,
    /\$1, \$2, \$3, \$4, \$4,[\s\S]*\$1::text/u,
    'child task id must have one PostgreSQL parameter type',
  );
  assert.match(dispatch, /'unattended_keyword_capture'/u);
  assert.match(dispatch, /orchestrationChild: true/u);
  assert.match(dispatch, /parentTaskId: parent\.id/u);
  assert.match(dispatch, /keywords: groupItems\.map\(item => item\.keyword\)/u);
  assert.match(dispatch, /INSERT INTO capture_agent_commands/u);
  assert.match(dispatch, /'create'/u);
  assert.match(dispatch, /INSERT INTO capture_task_item_attempts/u);
  assert.match(dispatch, /const itemAttemptBindings = \[\]/u);
  assert.match(dispatch, /itemAttempts: itemAttemptBindings/u);
  const fixedDispatch = dispatch.slice(dispatch.indexOf('const executions = [];'));
  assert.ok(
    fixedDispatch.indexOf('INSERT INTO capture_task_item_attempts') <
      fixedDispatch.indexOf('INSERT INTO capture_agent_commands'),
    'fixed-batch attempts must be durable before the create command is visible',
  );
  assert.match(dispatch, /'dispatched'/u);
  assert.match(dispatch, /eventType: 'orchestration_child_dispatched'/u);
  assert.match(dispatch, /eventType: 'orchestration_dispatched'/u);
  assert.doesNotMatch(dispatch, /\b(?:handoff|reassign|fencing_token|lease_expires_at)\b/u);
});

test('elastic one-time dispatch publishes an unassigned queue and defers commands to idle Agent heartbeats', () => {
  const dispatch = section(
    "router.post(\n  '/orchestrations/:id/dispatch'",
    "router.post(\n  '/orchestrations/:id/stop'",
  );
  const elasticStart = dispatch.indexOf("if (distributionMode === 'elastic_pool')");
  const fixedStart = dispatch.indexOf('const executions = [];', elasticStart);
  assert.ok(elasticStart >= 0);
  assert.ok(fixedStart > elasticStart);
  const elastic = dispatch.slice(elasticStart, fixedStart);
  assert.match(elastic, /eligibleAgentIds/u);
  assert.match(elastic, /'claimUnit', 'keyword'/u);
  assert.match(elastic, /phase: 'queued'/u);
  assert.match(elastic, /assigned: 0/u);
  assert.match(elastic, /eventType: 'orchestration_elastic_pool_opened'/u);
  assert.doesNotMatch(elastic, /INSERT INTO capture_agent_commands/u);
  assert.match(route, /function normalizeDispatch[\s\S]*eligibleAgentIds/u);
});

test('unattended dispatch stores either fixed assignments or an elastic cloud pool without issuing immediate child commands', () => {
  const dispatch = section(
    "router.post(\n  '/orchestrations/:id/dispatch'",
    "router.post(\n  '/orchestrations/:id/stop'",
  );
  const unattendedStart = dispatch.indexOf(
    "if (parentExecutionMode === 'unattended_plan')",
  );
  const oneTimeStart = dispatch.indexOf('const executions = [];', unattendedStart);
  assert.ok(unattendedStart >= 0);
  assert.ok(oneTimeStart > unattendedStart);
  const unattended = dispatch.slice(unattendedStart, oneTimeStart);

  assert.match(unattended, /INSERT INTO capture_orchestration_schedules/u);
  assert.match(unattended, /INSERT INTO capture_orchestration_schedule_agents/u);
  assert.match(unattended, /distribution_mode/u);
  assert.match(unattended, /WHEN \$1 = 'elastic_pool' THEN 'pending'/u);
  assert.match(unattended, /eligibleAgentIds/u);
  assert.match(unattended, /orchestration_schedule_id = \$1/u);
  assert.match(unattended, /schedule_revision = 1/u);
  assert.match(unattended, /orchestrationTemplate/u);
  assert.match(unattended, /eventType: 'orchestration_schedule_created'/u);
  assert.doesNotMatch(unattended, /INSERT INTO capture_agent_commands/u);
  assert.doesNotMatch(unattended, /INSERT INTO capture_task_item_attempts/u);
});

test('operator stop atomically settles the parent and disables automatic relay', () => {
  const stop = section(
    "router.post(\n  '/orchestrations/:id/stop'",
    "router.post(\n  '/orchestrations/:id/schedule/pause'",
  );
  const parentLock = stop.indexOf('parentSelect({lock: true})');
  const itemLock = stop.indexOf(
    'listParentItems(tx, req.tenantId, parent.id, {lock: true})',
  );
  assert.ok(parentLock >= 0);
  assert.ok(itemLock > parentLock);
  assert.match(stop, /capture_orchestration_control/u);
  assert.match(route, /ORCHESTRATION_STOPPABLE_STATUSES[\s\S]*'waiting_device'/u);
  assert.match(stop, /orchestrationScheduleTemplate_stop_unsupported|orchestration_schedule_template_stop_unsupported/u);
  assert.match(stop, /SET status = 'canceled'/u);
  assert.match(
    stop,
    /'completed', 'completed_with_warnings', 'skipped', 'canceled'/u,
  );
  assert.match(stop, /'automaticRetryDisabled', true/u);
  assert.match(stop, /attention_dismissed_at = COALESCE/u);
  assert.match(stop, /orchestration_revision = orchestration_revision \+ 1/u);
  assert.match(stop, /last_run_status = 'canceled'/u);
  assert.match(stop, /eventType: 'orchestration_stopped'/u);
  assert.match(stop, /executionTaskIds/u);
});

test('schedule edit updates the same template with revision protection and leaves generated runs untouched', () => {
  const edit = section(
    "router.patch(\n  '/orchestrations/:id/schedule'",
    "router.post(\n  '/orchestrations/:id/schedule/pause'",
  );
  const scheduleLock = edit.indexOf('loadOrchestrationSchedule(');
  const parentLock = edit.indexOf('parentSelect({lock: true})', scheduleLock);
  const agentLock = edit.indexOf('loadCompatibleAgents(', parentLock);
  const itemLock = edit.indexOf('listParentItems(', agentLock);
  assert.ok(scheduleLock >= 0);
  assert.ok(parentLock > scheduleLock);
  assert.ok(agentLock > parentLock);
  assert.ok(itemLock > agentLock);
  assert.match(edit, /currentRevision !== normalized\.expectedRevision/u);
  assert.match(edit, /'schedule_revision_conflict'/u);
  assert.match(edit, /computeNextOrchestrationRunAt\(planSnapshot/u);
  assert.match(edit, /WHERE id = \$12 AND tenant_id = \$13 AND revision = \$14/u);
  assert.match(edit, /revision = revision \+ 1/u);
  assert.match(edit, /orchestration_revision = orchestration_revision \+ 1/u);
  assert.match(edit, /UPDATE capture_orchestration_schedules/u);
  assert.doesNotMatch(edit, /INSERT INTO capture_orchestration_schedules/u);
  assert.doesNotMatch(edit, /DELETE FROM capture_orchestration_schedules/u);
  assert.doesNotMatch(edit, /DELETE FROM capture_tasks/u);
  assert.match(edit, /capture_task_item_attempts/u);
  assert.match(edit, /orchestration_template_items_not_editable/u);
  assert.match(edit, /distributionMode === 'fixed_batch'/u);
  assert.match(edit, /assigned_agent_id = \$6::uuid/u);
  assert.match(edit, /eventType: 'orchestration_schedule_updated'/u);
  assert.match(edit, /已生成的运行批次保持不变/u);
  assert.match(edit, /修改从下一次运行开始生效/u);
});

test('schedule pause and resume are tenant scoped, idempotent, and never backfill missed runs', () => {
  const pause = section(
    "router.post(\n  '/orchestrations/:id/schedule/pause'",
    "router.post(\n  '/orchestrations/:id/schedule/resume'",
  );
  const resume = section(
    "router.post(\n  '/orchestrations/:id/schedule/resume'",
    "router.get(\n  '/orchestrations/:id'",
  );

  assert.match(pause, /loadOrchestrationSchedule\([\s\S]*\{lock: true\}/u);
  assert.match(pause, /schedule\.status === 'paused'/u);
  assert.match(pause, /SET status = 'paused'/u);
  assert.match(pause, /不会再生成新任务/u);
  assert.match(resume, /schedule\.status === 'active'/u);
  assert.match(resume, /computeNextOrchestrationRunAt\(schedule\.plan_snapshot/u);
  assert.match(resume, /SET status = 'active'/u);
  assert.match(resume, /等待下一次云端运行/u);
  assert.doesNotMatch(resume, /\bbackfill\b/u);
});

test('manual handoff transfers only unstarted whole keywords after the source is settled', () => {
  const handoff = section(
    "router.post(\n  '/orchestrations/:id/resolve-attention'",
    "router.get(\n  '/orchestrations/:id'",
  );
  assert.match(handoff, /normalizeAttentionHandoff/u);
  assert.match(route, /text\(body\?\.action, 40\) !== 'handoff'/u);
  assert.match(handoff, /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)/u);
  assert.match(handoff, /\['capture_task_global_id', normalized\.requestKey\]/u);
  assert.match(handoff, /await lockCaptureAgentExecutionSlot\([\s\S]*normalized\.targetAgentId/u);
  assert.match(handoff, /handoffRequestHash/u);
  assert.match(handoff, /exactReplay/u);
  assert.match(
    handoff,
    /WHERE id = \$1::uuid AND tenant_id = \$2/u,
  );
  assert.doesNotMatch(
    handoff,
    /SELECT id FROM capture_tasks WHERE id = \$1::uuid/u,
    'a foreign-tenant task id must not be exposed through a global probe',
  );
  assert.match(handoff, /'idempotency_key_conflict'/u);
  assert.doesNotMatch(
    route.slice(
      route.indexOf('const HANDOFF_SOURCE_FINAL_STATUSES'),
      route.indexOf('const HANDOFF_PLATFORM_SAFETY_CODES'),
    ),
    /'superseded'/u,
  );
  assert.match(
    handoff,
    /sourceTask\.status === 'superseded'[\s\S]*sourceMetadata\.recoveryTaskId[\s\S]*handoff_source_recovery_active/u,
  );
  assert.match(
    handoff,
    /原设备已经创建恢复任务并继续执行，不能再把相同剩余关键词接力给其他节点/u,
  );
  assert.match(handoff, /HANDOFF_SOURCE_FINAL_STATUSES\.has\(sourceTask\.status\)/u);
  assert.match(
    handoff,
    /capture_task_snapshots[\s\S]*snapshot\.status = 'needs_action'[\s\S]*capture_task_events[\s\S]*event\.status = 'needs_action'[\s\S]*parent_event\.payload->>'childTaskId'/u,
  );
  assert.match(handoff, /handoff_requires_attention_state/u);
  assert.match(
    handoff,
    /status IN \('pending', 'acknowledged'\)[\s\S]*handoff_source_command_pending/u,
  );
  assert.match(handoff, /!item\.started_at/u);
  assert.match(handoff, /started_at IS NULL/u);
  assert.match(handoff, /handoff_has_no_unstarted_items/u);
  assert.match(handoff, /itemRequiresManualSafetyAction\(item\)/u);
  assert.match(handoff, /handoff_source_has_unresolved_started_items/u);
  assert.match(handoff, /recoveryPolicy\.allowIdleAgentHandoff === false/u);
  assert.match(handoff, /handoff_disabled_by_task_policy/u);
  assert.match(
    handoff,
    /SET status = 'failed'[\s\S]*'code', 'handoff_source_security_item_failed'/u,
  );
  assert.match(
    handoff,
    /capture_task_item_attempts[\s\S]*SET status = 'failed'/u,
  );
  assert.match(handoff, /settledSourceItemIds/u);
  assert.match(handoff, /handoff_target_same_as_source/u);
  assert.match(handoff, /captureAgentOnline\(targetAgent\.last_heartbeat_at\)/u);
  assert.match(handoff, /handoff_target_busy/u);
  assert.match(handoff, /findCaptureAgentExecutionSlotBlocker/u);
  assert.match(handoff, /blockerKind: targetBusyTask\.kind/u);
  assert.match(handoff, /orchestration_revision = orchestration_revision \+ 1/u);
  assert.match(handoff, /AND orchestration_revision = \$9/u);
  assert.match(handoff, /attempt_count = attempt_count \+ 1/u);
  assert.match(handoff, /INSERT INTO capture_task_item_attempts/u);
  assert.match(handoff, /const itemAttemptIdByItemId = new Map/u);
  assert.match(handoff, /itemAttempts: itemAttemptBindings/u);
  assert.match(handoff, /handoffConfirmedByUser: true/u);
  assert.match(
    handoff,
    /SET status = 'superseded'[\s\S]*'handoffSourcePreviousStatus'/u,
  );
  assert.match(handoff, /error\?\.code === '23505'/u);
  assert.match(handoff, /'orchestration_handoff'/u);
  assert.match(handoff, /eventType: 'orchestration_handoff_dispatched'/u);
  assert.doesNotMatch(
    handoff,
    /(?:captcha|securityBlocked)[\s\S]*(?:auto|automatic)/iu,
    'platform safety challenges must never trigger an automatic handoff',
  );
});

test('failed keyword retry atomically shards each item to a distinct idle Agent lease', () => {
  const retry = section(
    "router.post(\n  '/orchestrations/:id/retry-items'",
    "router.post(\n  '/orchestrations/:id/resolve-attention'",
  );
  assert.match(retry, /normalizeRetryItems/u);
  assert.match(retry, /action: 'retry_items_atomic_shard'/u);
  assert.match(retry, /metadata->>'retryRequestKey'/u);
  assert.match(retry, /existingTasks\.every/u);
  assert.match(retry, /RETRY_ITEM_STATUSES/u);
  assert.match(retry, /retry_requires_safety_confirmation/u);
  assert.match(retry, /HANDOFF_SOURCE_FINAL_STATUSES\.has\(task\.status\)/u);
  assert.match(retry, /for \(const agentId of candidateAgentIds\)/u);
  assert.match(retry, /await lockCaptureAgentExecutionSlot\(tx, req\.tenantId, agentId\)/u);
  assert.match(retry, /captureAgentOnline\(agent\.last_heartbeat_at\)/u);
  assert.doesNotMatch(retry, /retry_no_idle_agents/u);
  assert.match(retry, /status = 'retryable'/u);
  assert.match(retry, /retryWaitingItems/u);
  assert.match(retry, /dispatched: result\.executions/u);
  assert.match(retry, /waiting: result\.waiting/u);
  assert.match(retry, /single|单项租约/u);
  assert.match(retry, /for \(let index = 0; index < retryAssignments\.length; index \+= 1\)/u);
  assert.match(retry, /keywords: \[item\.keyword\]/u);
  assert.match(retry, /const itemAttemptId = crypto\.randomUUID\(\)/u);
  assert.match(retry, /itemAttempts: itemAttemptBindings/u);
  assert.match(retry, /itemIds: \[item\.id\]/u);
  assert.match(retry, /'orchestration_retry'/u);
  assert.match(retry, /parent_task_id/u);
  assert.match(retry, /attempt_count = attempt_count \+ 1/u);
  assert.match(retry, /INSERT INTO capture_task_item_attempts/u);
  assert.match(retry, /retrySourceExecutionTaskIds/u);
  assert.match(retry, /orchestration_revision = orchestration_revision \+ 1/u);
  assert.match(retry, /'orchestration_retry_dispatched'/u);
  assert.match(retry, /executions: result\.executions/u);
  assert.doesNotMatch(
    retry,
    /SET status = 'superseded'/u,
    'retrying one failed item must not erase sibling results on its source execution',
  );
  const waitingStart = retry.indexOf('for (const waitingItem of waiting)');
  const waitingEnd = retry.indexOf('const refreshedItems', waitingStart);
  assert.notEqual(waitingStart, -1);
  assert.notEqual(waitingEnd, -1);
  const waitingUpdate = retry.slice(waitingStart, waitingEnd);
  assert.match(waitingUpdate, /SET status = 'retryable'/u);
  assert.match(waitingUpdate, /'retryPending', true/u);
  for (const lineageField of [
    'retryWaitingRequestHash',
    'retryWaitingPlanHash',
    'retryWaitingAgentId',
    'retryWaitingParentRevision',
    'retryWaitingItemRevision',
    'retryWaitingAttemptCount',
    'retryWaitingSourceExecutionTaskId',
    'retryWaitingSafetyConfirmed',
    'retryWaitingBatchSize',
    'retryWaitingDispatchOrdinal',
  ]) {
    assert.match(waitingUpdate, new RegExp(lineageField, 'u'));
  }
  const waitingSet = waitingUpdate.slice(
    waitingUpdate.indexOf('SET'),
    waitingUpdate.indexOf('WHERE'),
  );
  assert.doesNotMatch(waitingSet, /attempt_count\s*=/u);
  assert.doesNotMatch(waitingSet, /assigned_agent_id\s*=/u);
  assert.doesNotMatch(waitingSet, /execution_task_id\s*=/u);
});

test('four retry items with three ranked idle Agents dispatch three and preserve one waiting', async () => {
  const {allocateRetryItemsForRetry} = await import(
    new URL('../server/routes/capture-orchestrations.js', import.meta.url)
  );
  const items = [1, 2, 3, 4].map(index => ({
    id: `item-${index}`,
    keyword: `keyword-${index}`,
  }));
  const agents = [1, 2, 3].map(index => ({id: `agent-${index}`}));
  const allocation = allocateRetryItemsForRetry({items, agents});
  assert.deepEqual(
    allocation.dispatched.map(entry => [entry.item.id, entry.agentId]),
    [
      ['item-1', 'agent-1'],
      ['item-2', 'agent-2'],
      ['item-3', 'agent-3'],
    ],
  );
  assert.deepEqual(allocation.waiting, [{
    itemId: 'item-4',
    keyword: 'keyword-4',
    status: 'retryable',
    reason: 'no_idle_agent',
  }]);
});

test('an unavailable per-item override remains fenced to that Agent while waiting', async () => {
  const {allocateRetryItemsForRetry} = await import(
    new URL('../server/routes/capture-orchestrations.js', import.meta.url)
  );
  const allocation = allocateRetryItemsForRetry({
    items: [{id: 'item-1', keyword: 'keyword-1'}],
    agents: [],
    overrides: [{itemId: 'item-1', agentId: 'agent-required'}],
  });
  assert.deepEqual(allocation.dispatched, []);
  assert.deepEqual(allocation.waiting, [{
    itemId: 'item-1',
    keyword: 'keyword-1',
    status: 'retryable',
    reason: 'assigned_agent_unavailable',
    agentId: 'agent-required',
  }]);
});

test('retry candidate SQL fails closed on unknown Shanghai usage and hard limits', () => {
  const candidateStart = route.indexOf('async function loadRetryAgentCandidates');
  const candidateEnd = route.indexOf('function publicRetryAgentCandidate', candidateStart);
  assert.notEqual(candidateStart, -1);
  assert.notEqual(candidateEnd, -1);
  const candidates = route.slice(candidateStart, candidateEnd);
  assert.match(candidates, /JOIN social_agent_daily_usage daily_usage/u);
  assert.match(candidates, /now\(\) AT TIME ZONE 'Asia\/Shanghai'/u);
  assert.match(candidates, /daily_usage\.last_event_at IS NOT NULL/u);
  assert.match(candidates, /AS today_usage_current/u);
  assert.doesNotMatch(candidates, /COALESCE\(daily_usage\.searches,\s*0\)/u);
  assert.match(candidates, /daily_usage\.searches < current_social_account\.daily_search_limit/u);
  assert.match(candidates, /ORDER BY daily_usage\.searches ASC,[\s\S]*health_status[\s\S]*recent_technical_failure_count ASC/u);
  assert.match(candidates, /FOR UPDATE OF ca, daily_usage/u);
  assert.match(route, /crossDeviceRetryAgentDailyUsageEligible\(agent\)/u);
});

test('retryPending has a bounded deterministic consumer on the existing recovery sweep', () => {
  const consumerStart = route.indexOf(
    'export async function reconcilePendingOrchestrationRetries',
  );
  const consumerEnd = route.indexOf("router.post(\n  '/orchestrations/:id/dispatch'", consumerStart);
  assert.notEqual(consumerStart, -1);
  assert.notEqual(consumerEnd, -1);
  const consumer = route.slice(consumerStart, consumerEnd);
  const dispatchStart = route.indexOf('function deterministicRetryUuid');
  assert.notEqual(dispatchStart, -1);
  const dispatch = route.slice(dispatchStart, consumerEnd);
  assert.match(dispatch, /metadata->>'retryPending' = 'true'/u);
  assert.match(dispatch, /deterministicRetryUuid/u);
  assert.match(dispatch, /tryLockCaptureAgentExecutionSlot/u);
  assert.match(dispatch, /crossDeviceRetryAgentDailyUsageEligible/u);
  assert.match(dispatch, /HANDOFF_SOURCE_FINAL_STATUSES\.has\(sourceTask\.status\)/u);
  assert.match(dispatch, /lineage\.safetyConfirmed/u);
  assert.match(dispatch, /lineage\.preferredAgentId/u);
  assert.match(dispatch, /AND assignment_revision = \$11/u);
  assert.match(dispatch, /AND attempt_count = \$12/u);
  assert.match(dispatch, /retryWaitingRequestHash' = \$13/u);
  assert.match(dispatch, /INSERT INTO capture_task_item_attempts/u);
  assert.match(dispatch, /actorType: 'system'/u);
  assert.match(dispatch, /retryWaitingInvalidatedAt/u);
  assert.match(dispatch, /retryWaitingInvalidatedReason/u);
  assert.match(dispatch, /retryWaitingInvalidatedMarker/u);
  assert.match(dispatch, /jsonb_object_agg\(current_marker\.key, current_marker\.value\)/u);
  assert.match(dispatch, /retryWaitingLastCheckedAt/u);
  assert.match(dispatch, /excludedItemIds/u);
  assert.match(dispatch, /safety_confirmation_missing/u);
  assert.match(dispatch, /aggregateParentTaskItems\(refreshedItems\)/u);
  assert.match(dispatch, /lastRetryWaitingInvalidatedCount/u);
  assert.match(
    dispatch,
    /orchestration_retry_pending_projection_reconciled/u,
  );
  assert.match(consumer, /Math\.min\(100/u);
  assert.doesNotMatch(consumer, /crypto\.randomUUID/u);
});

test('manual and automatic retry dispatch share one deadlock-safe lock order', () => {
  const retry = section(
    "router.post(\n  '/orchestrations/:id/retry-items'",
    "router.post(\n  '/orchestrations/:id/resolve-attention'",
  );
  const advisorySlot = retry.indexOf('lockCaptureAgentExecutionSlot(');
  const agentRows = retry.indexOf('const candidateAgents =');
  const sourceRows = retry.indexOf('const sourceTasks =');
  const parentRow = retry.indexOf('parentSelect({lock: true})');
  const itemRows = retry.indexOf('const items = await listParentItems');
  assert.ok(advisorySlot >= 0);
  assert.ok(agentRows > advisorySlot);
  assert.ok(sourceRows > agentRows);
  assert.ok(parentRow > sourceRows);
  assert.ok(itemRows > parentRow);

  const consumerStart = route.indexOf(
    'async function loadIdlePendingRetryAgent',
  );
  const consumerEnd = route.indexOf(
    'export async function reconcilePendingOrchestrationRetries',
    consumerStart,
  );
  const consumer = route.slice(consumerStart, consumerEnd);
  const consumerAdvisory = consumer.indexOf(
    'tryLockCaptureAgentExecutionSlot(',
  );
  const consumerAgentRows = consumer.indexOf('lock: true');
  const consumerSourceRows = consumer.indexOf('const sourceTask =');
  const consumerParentRow = consumer.indexOf('parentSelect({lock: true})');
  const consumerItemRows = consumer.indexOf('const item = await tx.queryOne');
  assert.ok(consumerAdvisory >= 0);
  assert.ok(consumerAgentRows > consumerAdvisory);
  assert.ok(consumerSourceRows > consumerAgentRows);
  assert.ok(consumerParentRow > consumerSourceRows);
  assert.ok(consumerItemRows > consumerParentRow);
});

test('automatic waiting continuation binds its deterministic attempt into the command', () => {
  const consumerStart = route.indexOf(
    'async function dispatchOnePendingOrchestrationRetry',
  );
  const consumerEnd = route.indexOf(
    'export async function reconcilePendingOrchestrationRetries',
    consumerStart,
  );
  assert.ok(consumerStart >= 0);
  assert.ok(consumerEnd > consumerStart);
  const consumer = route.slice(consumerStart, consumerEnd);
  assert.match(consumer, /const itemAttemptId = deterministicRetryUuid/u);
  assert.match(consumer, /itemAttempts: itemAttemptBindings/u);
  assert.ok(
    consumer.indexOf('INSERT INTO capture_task_item_attempts') <
      consumer.indexOf('INSERT INTO capture_agent_commands'),
    'automatic continuation must persist the attempt before publishing command',
  );
});

test('idempotent replay reads live retryPending rows instead of a child snapshot', () => {
  const retry = section(
    "router.post(\n  '/orchestrations/:id/retry-items'",
    "router.post(\n  '/orchestrations/:id/resolve-attention'",
  );
  assert.match(retry, /existingWaitingItems/u);
  assert.match(retry, /existingWaitingItems\.map\(publicPendingRetryItem\)/u);
  assert.doesNotMatch(retry, /replayMetadata\.retryWaitingItems/u);
});

test('retry request no longer requires one targetAgentId for a multi-item batch', () => {
  const normalizeStart = route.indexOf('function normalizeRetryItems');
  const normalizeEnd = route.indexOf("router.post(\n  '/orchestrations/:id/dispatch'", normalizeStart);
  assert.notEqual(normalizeStart, -1);
  assert.notEqual(normalizeEnd, -1);
  const normalize = route.slice(normalizeStart, normalizeEnd);
  assert.match(normalize, /if \(!requestKey \|\| itemIds\.length === 0\)/u);
  assert.match(normalize, /Array\.isArray\(body\?\.assignments\)/u);
  assert.match(normalize, /duplicate_retry_agent_assignment/u);
  assert.match(normalize, /legacyBatchTarget/u);
  const retry = section(
    "router.post(\n  '/orchestrations/:id/retry-items'",
    "router.post(\n  '/orchestrations/:id/resolve-attention'",
  );
  assert.match(retry, /existingTasks\.length > 0[\s\S]*legacy_retry_target_not_atomic/u);
  assert.doesNotMatch(
    normalize,
    /if \(!requestKey \|\| !targetAgentId/u,
    'targetAgentId must not remain mandatory for retry batches',
  );
});

test('an active unattended plan can be started immediately from the cloud', () => {
  const runNow = section(
    "router.post(\n  '/orchestrations/:id/schedule/run-now'",
    "router.post(\n  '/orchestrations/:id/retry-items'",
  );
  assert.match(runNow, /runCaptureOrchestrationScheduleNow/u);
  assert.match(runNow, /requestKey/u);
  assert.match(runNow, /orchestration_schedule_overlap/u);
  assert.match(runNow, /已从云端立即启动一轮无人值守任务/u);
  assert.match(runNow, /idempotency_conflict/u);
});

test('detail reader is tenant scoped and returns the complete orchestration projection', () => {
  const detail = route.slice(route.indexOf("router.get(\n  '/orchestrations/:id'"));
  assert.match(detail, /parentSelect\(\)/u);
  assert.match(detail, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/u);
  assert.match(
    detail,
    /WHERE child\.tenant_id = \$1[\s\S]*child\.parent_task_id = \$2/u,
  );
  assert.match(
    detail,
    /ca\.id = ANY\(\$3::uuid\[\]\)[\s\S]*item\.task_id = \$2[\s\S]*item\.assigned_agent_id = ca\.id/u,
  );
  assert.match(route, /record\.content AS source_record_content/u);
  assert.match(route, /function publicParentItem/u);
  assert.match(detail, /\.map\(publicParentItem\)/u);
  assert.match(
    detail,
    /WHERE attempt\.tenant_id = \$1[\s\S]*attempt\.parent_task_id = \$2/u,
  );
  for (const field of [
    'orchestration',
    'items',
    'executions',
    'agents',
    'attempts',
    'schedule',
  ]) {
    assert.match(detail, new RegExp(`\\b${field}\\b`, 'u'));
  }
});

test('all id-addressed orchestration routes validate UUIDs before database casts', () => {
  for (const marker of [
    "'/orchestrations/:id/draft'",
    "'/orchestrations/:id/allocation-preview'",
    "'/orchestrations/:id/dispatch'",
    "'/orchestrations/:id/stop'",
    "'/orchestrations/:id/schedule/pause'",
    "'/orchestrations/:id/schedule/resume'",
    "'/orchestrations/:id/resolve-attention'",
    "'/orchestrations/:id'",
  ]) {
    const start = route.indexOf(marker);
    assert.notEqual(start, -1, `missing route ${marker}`);
    assert.match(route.slice(start, start + 520), /orchestrationRouteId\(req, res\)/u);
  }
  assert.match(route, /'invalid_orchestration_id'/u);
});
