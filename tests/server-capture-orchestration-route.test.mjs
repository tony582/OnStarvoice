import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const route = await readFile(
  new URL('../server/routes/capture-orchestrations.js', import.meta.url),
  'utf8',
);
const serverIndex = await readFile(
  new URL('../server/index.js', import.meta.url),
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
    serverIndex,
    /import captureOrchestrationsRouter from '\.\/routes\/capture-orchestrations\.js';/u,
  );
  assert.match(
    serverIndex,
    /app\.use\('\/api\/capture-cloud', captureOrchestrationsRouter\);/u,
  );
});

test('all orchestration mutations require a tenant-scoped writer session', () => {
  for (const marker of [
    "'/orchestrations'",
    "'/orchestrations/:id/draft'",
    "'/orchestrations/:id/allocation-preview'",
    "'/orchestrations/:id/dispatch'",
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
    "router.post(\n  '/orchestrations/:id/schedule/pause'",
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
    "router.post(\n  '/orchestrations/:id/schedule/pause'",
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
  assert.match(dispatch, /'dispatched'/u);
  assert.match(dispatch, /eventType: 'orchestration_child_dispatched'/u);
  assert.match(dispatch, /eventType: 'orchestration_dispatched'/u);
  assert.doesNotMatch(dispatch, /\b(?:handoff|reassign|fencing_token|lease_expires_at)\b/u);
});

test('unattended dispatch stores a cloud schedule and fixed assignments without issuing immediate child commands', () => {
  const dispatch = section(
    "router.post(\n  '/orchestrations/:id/dispatch'",
    "router.post(\n  '/orchestrations/:id/schedule/pause'",
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
  assert.match(unattended, /SET status = 'assigned'/u);
  assert.match(unattended, /orchestration_schedule_id = \$1/u);
  assert.match(unattended, /schedule_revision = 1/u);
  assert.match(unattended, /orchestrationTemplate/u);
  assert.match(unattended, /eventType: 'orchestration_schedule_created'/u);
  assert.doesNotMatch(unattended, /INSERT INTO capture_agent_commands/u);
  assert.doesNotMatch(unattended, /INSERT INTO capture_task_item_attempts/u);
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

test('failed keyword retry stays inside the same parent and can target an idle Agent', () => {
  const retry = section(
    "router.post(\n  '/orchestrations/:id/retry-items'",
    "router.post(\n  '/orchestrations/:id/resolve-attention'",
  );
  assert.match(retry, /normalizeRetryItems/u);
  assert.match(retry, /RETRY_ITEM_STATUSES/u);
  assert.match(retry, /retry_requires_safety_confirmation/u);
  assert.match(retry, /HANDOFF_SOURCE_FINAL_STATUSES\.has\(task\.status\)/u);
  assert.match(retry, /lockCaptureAgentExecutionSlot/u);
  assert.match(retry, /captureAgentOnline\(targetAgent\.last_heartbeat_at\)/u);
  assert.match(retry, /retry_target_busy/u);
  assert.match(retry, /'orchestration_retry'/u);
  assert.match(retry, /parent_task_id/u);
  assert.match(retry, /attempt_count = attempt_count \+ 1/u);
  assert.match(retry, /INSERT INTO capture_task_item_attempts/u);
  assert.match(retry, /retrySourceExecutionTaskIds/u);
  assert.match(retry, /orchestration_revision = orchestration_revision \+ 1/u);
  assert.match(retry, /eventType: 'orchestration_retry_dispatched'/u);
  assert.doesNotMatch(
    retry,
    /SET status = 'superseded'/u,
    'retrying one failed item must not erase sibling results on its source execution',
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
    /WHERE item\.tenant_id = \$1 AND item\.task_id = \$2/u,
  );
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
