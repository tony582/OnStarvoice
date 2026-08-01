import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  allocateNegativePatrolCandidates,
  negativePatrolExistingRequestMatches,
  negativePatrolItemReassignable,
  negativePatrolReassignmentExistingRequestMatches,
  negativePatrolReassignmentRequestHash,
  normalizeNegativePatrolAgentIds,
} from '../server/routes/negative-patrol.js';
import {negativePatrolTargetResults} from '../server/routes/capture-cloud.js';

async function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const AGENT_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

test('negative patrol accepts an ordered Agent team and rejects ambiguous duplicates', () => {
  assert.deepEqual(
    normalizeNegativePatrolAgentIds({agentIds: AGENT_IDS}).agentIds,
    AGENT_IDS,
  );
  assert.deepEqual(
    normalizeNegativePatrolAgentIds({agentId: AGENT_IDS[0]}).agentIds,
    [AGENT_IDS[0]],
  );
  assert.equal(
    normalizeNegativePatrolAgentIds({
      agentIds: [AGENT_IDS[0], AGENT_IDS[0]],
    }).failure.error,
    'duplicate_agent_id',
  );
});

test('an exact requestKey retry recognizes and returns its existing multi-Agent parent', () => {
  const existingParent = {
    task_type: 'capture_orchestration',
    feature_key: 'negative_post_patrol',
    metadata: {
      workflow: 'negative_post_patrol',
      remoteRequestHash: 'same-request-hash',
    },
  };

  assert.equal(
    negativePatrolExistingRequestMatches(
      existingParent,
      'same-request-hash',
    ),
    true,
  );
  assert.equal(
    negativePatrolExistingRequestMatches(
      existingParent,
      'different-request-hash',
    ),
    false,
  );
  assert.equal(
    negativePatrolExistingRequestMatches({
      ...existingParent,
      task_type: 'capture',
      feature_key: '',
    }, 'same-request-hash'),
    false,
  );
});

test('negative patrol allocation is stable, complete, and balanced', () => {
  const candidates = Array.from({length: 10}, (_, index) => ({
    id: `record-${index + 1}`,
  }));
  const allocation = allocateNegativePatrolCandidates(candidates, AGENT_IDS);

  assert.deepEqual(
    allocation.groups.map(group => ({
      agentId: group.agentId,
      count: group.candidates.length,
      startOrdinal: group.startOrdinal,
      endOrdinal: group.endOrdinal,
    })),
    [
      {
        agentId: AGENT_IDS[0],
        count: 4,
        startOrdinal: 0,
        endOrdinal: 3,
      },
      {
        agentId: AGENT_IDS[1],
        count: 3,
        startOrdinal: 4,
        endOrdinal: 6,
      },
      {
        agentId: AGENT_IDS[2],
        count: 3,
        startOrdinal: 7,
        endOrdinal: 9,
      },
    ],
  );
  assert.deepEqual(
    allocation.assignments.map(entry => entry.candidate.id),
    candidates.map(candidate => candidate.id),
  );
  assert.ok(
    Math.max(...allocation.groups.map(group => group.candidates.length)) -
      Math.min(...allocation.groups.map(group => group.candidates.length)) <= 1,
  );
});

test('negative patrol reassignment selects only unfinished actionable posts', () => {
  for (const status of [
    'pending',
    'assigned',
    'dispatch_pending',
    'dispatched',
    'waiting_device',
    'retryable',
    'needs_action',
    'failed',
  ]) {
    assert.equal(
      negativePatrolItemReassignable({status}),
      true,
      status,
    );
  }
  for (const status of [
    'running',
    'completed',
    'completed_with_warnings',
    'skipped',
    'canceled',
  ]) {
    assert.equal(
      negativePatrolItemReassignable({status}),
      false,
      status,
    );
  }
  assert.equal(
    negativePatrolItemReassignable({
      status: 'failed',
      content_availability_status: 'deleted',
    }),
    false,
  );
  assert.equal(
    negativePatrolItemReassignable({
      status: 'needs_action',
      metadata: {
        targetResult: {availabilityStatus: 'page_unavailable'},
      },
    }),
    false,
  );
});

test('negative patrol reassignment requestKey is semantic and replay-safe', () => {
  const input = {
    orchestrationId: '44444444-4444-4444-8444-444444444444',
    requestKey: '55555555-5555-4555-8555-555555555555',
    expectedRevision: 2,
    agentIds: AGENT_IDS.slice(0, 2),
  };
  const requestHash = negativePatrolReassignmentRequestHash(input);
  assert.equal(requestHash.length, 64);
  assert.equal(
    negativePatrolReassignmentExistingRequestMatches({
      task_type: 'negative_post_patrol',
      metadata: {
        orchestrationChild: true,
        reassignmentRequestHash: requestHash,
      },
    }, requestHash),
    true,
  );
  assert.equal(
    negativePatrolReassignmentRequestHash({
      ...input,
      expectedRevision: 3,
    }) === requestHash,
    false,
  );
  assert.equal(
    negativePatrolReassignmentExistingRequestMatches({
      task_type: 'negative_post_patrol',
      metadata: {
        orchestrationChild: true,
        reassignmentRequestHash: 'different',
      },
    }, requestHash),
    false,
  );
});

test('multi-Agent patrol uses a parent business task and one execution child per Agent', async () => {
  const route = await read('server/routes/negative-patrol.js');

  assert.match(route, /'capture_orchestration',\s*'negative_post_patrol'/u);
  assert.match(route, /negative_patrol_multi_agent_child/u);
  assert.match(route, /parent_task_id, origin_agent_id, assigned_agent_id/u);
  assert.match(route, /task_id, item_key, ordinal[\s\S]*execution_task_id/u);
  assert.match(
    route,
    /const metadata = \{[\s\S]*protocolVersion:\s*2[\s\S]*multiAgent:\s*true/u,
  );
  assert.match(
    route,
    /const childMetadata = \{[\s\S]*protocolVersion:\s*1/u,
  );
  assert.match(
    route,
    /const payload = \{[\s\S]*workflow: 'negative_post_patrol',[\s\S]*protocolVersion:\s*1/u,
  );
  assert.match(route, /requireOnline:\s*true/u);
  assert.match(route, /negative_patrol_candidates_fewer_than_agents/u);
  assert.match(
    route,
    /content_availability_status NOT IN \(\s*'deleted',\s*'page_unavailable'\s*\)/u,
  );
  assert.match(
    route,
    /negativePatrolExistingRequestMatches\(existing, requestHash\)/u,
  );
  assert.match(route, /task:\s*existing[\s\S]*existing:\s*true/u);
});

test('multi-Agent patrol UI requires two nodes and enough posts for every node', async () => {
  const [drawer, creator] = await Promise.all([
    read('web/admin/src/pages/dispatch/cloud-tasks/CreateTaskDrawer.tsx'),
    read('web/admin/src/pages/dispatch/cloud-tasks/NegativePatrolTaskCreator.tsx'),
  ]);

  assert.match(
    drawer,
    /method === 'multi'[\s\S]*selectedAssignableIds\.length < 2/u,
  );
  assert.match(drawer, /多 Agent 模式至少选择 2 个可用节点/u);
  assert.match(creator, /agentIds:\s*agents\.map\(agent => agent\.id\)/u);
  assert.match(
    creator,
    /allocationInvalid = multiAgent && selectedIds\.size < agents\.length/u,
  );
  assert.match(creator, /帖子数少于节点数/u);
});

test('negative patrol detail can reassign only unfinished posts to an explicit online Agent team', async () => {
  const [workspace, orchestrationRoute] = await Promise.all([
    read(
      'web/admin/src/pages/dispatch/cloud-tasks/OrchestrationDetailWorkspace.tsx',
    ),
    read('server/routes/capture-orchestrations.js'),
  ]);

  assert.match(
    workspace,
    /NEGATIVE_REASSIGN_EXPLICIT_STATUSES[\s\S]*'needs_action'[\s\S]*'failed'[\s\S]*'retryable'/u,
  );
  assert.match(
    workspace,
    /if \(itemAvailabilityLabel\(item\)\) return false/u,
  );
  assert.match(
    workspace,
    /item\.content_availability_status/u,
  );
  assert.match(
    orchestrationRoute,
    /record\.content_availability_status[\s\S]*LEFT JOIN records record/u,
  );
  assert.match(
    workspace,
    /agent\.status !== 'active' \|\| !agent\.online/u,
  );
  assert.match(
    workspace,
    /agent\.capabilities\?\.negativePostPatrol !== true/u,
  );
  assert.match(
    workspace,
    /preferred = negativeReassignCandidates\.filter\([\s\S]*!negativeReassignSourceAgentIds\.has\(agent\.id\)/u,
  );
  assert.match(
    workspace,
    /\/capture-cloud\/negative-patrol\/orchestrations\/\$\{orchestrationId\}\/reassign/u,
  );
  assert.match(
    workspace,
    /requestKey: pendingNegativeReassign\.current\.requestKey[\s\S]*expectedRevision[\s\S]*agentIds/u,
  );
  assert.match(workspace, /重新分配未完成帖子/u);
  assert.match(workspace, /原失败节点/u);
  assert.match(
    workspace,
    /NEGATIVE_REASSIGN_BLOCKING_EXECUTION_STATUSES[\s\S]*negativeReassignBlockedByActiveExecution/u,
  );
  assert.match(
    workspace,
    /当前批次仍有 Agent 在执行或等待设备/u,
  );
  assert.match(
    workspace,
    /已完成(?:以及|、)已删除或不可访问的帖子(?:不会重复执行|继续保留原结果)/u,
  );
});

test('negative patrol backend reassigns unfinished items with CAS and stale-child fencing', async () => {
  const [route, projection] = await Promise.all([
    read('server/routes/negative-patrol.js'),
    read('server/routes/capture-cloud.js'),
  ]);
  const marker =
    "router.post(\n  '/negative-patrol/orchestrations/:id/reassign'";
  const start = route.indexOf(marker);
  assert.notEqual(start, -1);
  const reassign = route.slice(start, route.indexOf('export default router'));

  assert.match(reassign, /requireTenantAccess/u);
  assert.match(reassign, /requireSessionUser/u);
  assert.match(reassign, /requireTenantWriter/u);
  assert.match(reassign, /pg_advisory_xact_lock/u);
  assert.match(
    reassign,
    /negativePatrolReassignmentExistingRequestMatches/u,
  );
  assert.match(reassign, /currentRevision !== expectedRevision/u);
  assert.match(
    reassign,
    /negative_patrol_reassignment_execution_active/u,
  );
  assert.match(reassign, /requireOnline:\s*true/u);
  assert.match(reassign, /requireIdle:\s*true/u);
  assert.match(route, /await lockCaptureAgentExecutionSlot\(tx, tenantId, agentId\)/u);
  assert.match(route, /findCaptureAgentExecutionSlotBlocker/u);
  assert.match(route, /CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES/u);
  const agentLockIndex = reassign.indexOf(
    'const compatible = await loadCompatibleAgents(',
  );
  const itemLockIndex = reassign.indexOf('FOR UPDATE OF item');
  const parentCasIndex = reassign.indexOf(
    'AND orchestration_revision = $13',
  );
  assert.ok(agentLockIndex >= 0, 'reassignment must lock selected Agents');
  assert.ok(itemLockIndex >= 0, 'reassignment must lock eligible item rows');
  assert.ok(
    agentLockIndex < itemLockIndex,
    'reassignment lock order must be Agent rows before item rows',
  );
  assert.ok(
    itemLockIndex < parentCasIndex,
    'parent revision CAS must follow Agent and item row locks',
  );
  assert.match(
    route,
    /for \(const agentId of \[\.\.\.agentIds\]\.sort\(\)\)/u,
    'multi-Agent row locks must use stable UUID order',
  );
  assert.match(
    reassign,
    /item\.status = ANY\(\$3::text\[\]\)[\s\S]*content_availability_status NOT IN \(\s*'deleted',\s*'page_unavailable'/u,
  );
  assert.match(reassign, /protocolVersion:\s*1/u);
  assert.match(reassign, /negative_patrol_reassignment/u);
  assert.match(
    reassign,
    /MAX\(attempt_number\)[\s\S]*next_attempt_number/u,
  );
  assert.match(
    reassign,
    /attempt_count = \$12/u,
  );
  assert.match(
    reassign,
    /execution_task_id IS NOT DISTINCT FROM \$5::uuid[\s\S]*assignment_revision = \$10/u,
  );
  assert.match(
    reassign,
    /INSERT INTO capture_task_item_attempts[\s\S]*assignment_revision/u,
  );
  assert.match(
    reassign,
    /orchestration_revision = \$1[\s\S]*AND orchestration_revision = \$13/u,
  );
  assert.match(reassign, /eventType: 'negative_patrol_reassigned'/u);
  assert.match(reassign, /negative_patrol\.reassign_unfinished/u);
  assert.doesNotMatch(
    reassign,
    /SELECT \*[\s\S]{0,160}FROM capture_tasks[\s\S]{0,160}FOR UPDATE/u,
    'reassignment must not lock parent before item rows',
  );

  assert.match(
    projection,
    /AND execution_task_id = \$12[\s\S]*AND assignment_revision = \$17/u,
  );
  assert.match(
    projection,
    /'reassignmentRequestKey', capture_tasks\.metadata->'reassignmentRequestKey'/u,
  );
});

test('deleted or unavailable posts remain terminal results and are persisted for future patrol exclusion', async () => {
  const [route, migration] = await Promise.all([
    read('server/routes/capture-cloud.js'),
    read('server/db/migrations/048_record_content_availability.sql'),
  ]);
  const [entry] = negativePatrolTargetResults({
    targetResults: [{
      itemId: '44444444-4444-4444-8444-444444444444',
      recordId: '55555555-5555-4555-8555-555555555555',
      externalId: 'note-12345',
      ordinal: 1,
      status: 'skipped',
      businessOutcome: 'post_unavailable',
      availabilityStatus: 'deleted',
      retryable: false,
      availability: {
        status: 'unavailable',
        availabilityStatus: 'deleted',
        reason: 'post_deleted_or_unavailable',
        code: 'TARGET_POST_UNAVAILABLE',
        message: '原帖已删除或不可访问',
        observedAt: '2026-07-27T09:00:00.000Z',
        evidence: {detector: 'xiaohongshu_unavailable_page'},
      },
    }],
  });

  assert.equal(entry.status, 'skipped');
  assert.equal(entry.businessOutcome, 'post_unavailable');
  assert.equal(entry.availabilityStatus, 'deleted');
  assert.equal(entry.availability.availabilityStatus, 'deleted');
  assert.equal(entry.retryable, false);
  assert.match(route, /targetResultContentAvailability/u);
  assert.match(route, /signals: availability\.evidence/u);
  assert.match(route, /UPDATE records[\s\S]*content_availability_status = \$1/u);
  assert.match(route, /content_availability_evidence = \$4::jsonb/u);
  assert.match(
    route,
    /content_availability_checked_at <= COALESCE\(\s*\$2::timestamptz,\s*now\(\)\s*\)/u,
  );
  assert.match(
    route,
    /ORDER BY ordinal, id\s*OFFSET \$5\s*LIMIT 1/u,
    'a child checkpoint ordinal must be resolved within that child slice',
  );
  assert.match(
    route,
    /if \(!checkedAt\) return null/u,
  );
  assert.match(
    migration,
    /content_availability_status[\s\S]*'available'[\s\S]*'deleted'[\s\S]*'page_unavailable'/u,
  );
  assert.match(migration, /content_availability_checked_at TIMESTAMPTZ/u);
});
