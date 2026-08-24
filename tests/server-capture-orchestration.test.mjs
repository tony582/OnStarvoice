import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  aggregateParentTaskItems,
  allocateKeywordWorkItems,
  checkpointEntryToItemStatus,
  computeNextOrchestrationRunAt,
  hashOrchestrationRequest,
  normalizeOrchestrationRequest,
  normalizeOrchestrationSchedule,
} from '../server/services/capture-orchestration.js';
import {enqueueDueCaptureOrchestrations} from '../server/services/capture-orchestration-scheduler.js';

test('guarded schedule materialization rejects an empty or invalid target scope', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(
    await enqueueDueCaptureOrchestrations({tenantId, scheduleIds: [], limit: 1}),
    [{kind: 'invalid_schedule_scope'}],
  );
  assert.deepEqual(
    await enqueueDueCaptureOrchestrations({
      tenantId,
      scheduleIds: ['not-a-uuid'],
      limit: 1,
    }),
    [{kind: 'invalid_schedule_scope'}],
  );
});

test('orchestration input keeps a validated cloud schedule without changing allocation order', () => {
  const normalized = normalizeOrchestrationRequest({
    requestKey: ' request-1 ',
    title: ' 20 个关键词 ',
    platform: 'XHS',
    executionMode: 'unattended_plan',
    allocationMode: 'ai',
    keywords: [' 别克 ', '雪佛兰', '别克', '凯迪拉克'],
    agents: [
      {id: 'agent-a'},
      {agentId: 'agent-b'},
      {id: 'agent-a'},
    ],
    sort: 'Latest',
    mode: 'daily',
    startTime: '22:45',
    randomOffsetMin: 20,
    maxRounds: 1,
    keywordMaxDetectedItems: 50,
    captureSettings: {
      autoDetailCaptureAfterListCapture: true,
      includeCommentsOnDetailCapture: true,
      detailCommentsMaxDetectedItems: 20,
    },
    recoveryPolicy: {
      allowIdleAgentHandoff: false,
    },
  });

  assert.equal(normalized.requestKey, 'request-1');
  assert.equal(normalized.platform, 'xiaohongshu');
  assert.equal(normalized.executionMode, 'unattended_plan');
  assert.equal(normalized.allocationMode, 'balanced');
  assert.equal(normalized.distributionMode, 'fixed_batch');
  assert.deepEqual(normalized.keywords, ['别克', '雪佛兰', '凯迪拉克']);
  assert.deepEqual(normalized.agentIds, ['agent-a', 'agent-b']);
  assert.equal(normalized.taskInput.searchFilters.sort, 'latest');
  assert.equal(normalized.taskInput.mode, 'daily');
  assert.equal(normalized.taskInput.startTime, '22:45');
  assert.equal(normalized.taskInput.randomOffsetMin, 20);
  assert.equal(normalized.taskInput.maxRounds, 1);
  assert.equal(normalized.taskInput.roundGapMin, 10);
  assert.equal(
    normalized.taskInput.captureSettings.includeCommentsOnDetailCapture,
    true,
  );
  assert.deepEqual(normalized.taskInput.recoveryPolicy, {
    allowIdleAgentHandoff: false,
    platformSafetyMode: 'manual_confirmed',
  });
});

test('elastic distribution is explicit and unknown values stay backward-compatible', () => {
  assert.equal(
    normalizeOrchestrationRequest({distributionMode: 'elastic_pool'})
      .distributionMode,
    'elastic_pool',
  );
  assert.equal(
    normalizeOrchestrationRequest({distributionMode: 'future_mode'})
      .distributionMode,
    'fixed_batch',
  );
});

test('Douyin unattended elastic plans allow one focused search after comprehensive', () => {
  const imageSupplement = normalizeOrchestrationRequest({
    platform: 'douyin',
    executionMode: 'unattended_plan',
    distributionMode: 'elastic_pool',
    searchPasses: ['all', 'image'],
    keywords: ['别克壁纸'],
    agents: [{id: 'agent-a'}],
    schedule: {mode: 'daily', startTime: '06:30'},
  });
  assert.deepEqual(imageSupplement.taskInput.searchPasses, ['all', 'image']);
  assert.equal(imageSupplement.taskInput.searchFilters.contentType, 'all');
  assert.equal(imageSupplement.taskInput.recoveryPolicy.disableAutomaticSearchRetry, true);
  assert.equal(imageSupplement.taskInput.recoveryPolicy.requireVerifiedFilters, true);

  const videoSupplement = normalizeOrchestrationRequest({
    platform: 'douyin',
    executionMode: 'unattended_plan',
    distributionMode: 'elastic_pool',
    searchPasses: ['all', 'video'],
    schedule: {mode: 'daily'},
  });
  assert.deepEqual(videoSupplement.taskInput.searchPasses, ['all', 'video']);

  const incompatiblePair = normalizeOrchestrationRequest({
    platform: 'douyin',
    executionMode: 'unattended_plan',
    distributionMode: 'elastic_pool',
    searchPasses: ['image', 'video'],
    searchFilters: {contentType: 'image'},
    schedule: {mode: 'daily'},
  });
  assert.equal(Object.hasOwn(incompatiblePair.taskInput, 'searchPasses'), false);
  assert.equal(incompatiblePair.taskInput.searchFilters.contentType, 'image');

  for (const input of [
    {
      platform: 'xiaohongshu', executionMode: 'unattended_plan',
      distributionMode: 'elastic_pool', searchPasses: ['all', 'image'],
      schedule: {mode: 'daily'},
    },
    {
      platform: 'douyin', executionMode: 'unattended_plan',
      distributionMode: 'fixed_batch', searchPasses: ['all', 'image'],
      schedule: {mode: 'daily'},
    },
    {
      platform: 'douyin', executionMode: 'one_time',
      distributionMode: 'elastic_pool', searchPasses: ['all', 'image'],
    },
  ]) {
    const normalized = normalizeOrchestrationRequest(input);
    assert.equal(Object.hasOwn(normalized.taskInput, 'searchPasses'), false);
  }
});

test('non-patrol search filters remain single-choice even when an API sends arrays', () => {
  const normalized = normalizeOrchestrationRequest({
    platform: 'douyin',
    executionMode: 'unattended_plan',
    distributionMode: 'elastic_pool',
    searchPasses: ['all', 'video'],
    searchFilters: {
      publishTime: ['day', 'week'],
      sort: ['latest', 'likes'],
      searchScope: ['unviewed', 'viewed'],
      videoDuration: ['under_1m', 'over_5m'],
    },
    schedule: {mode: 'daily'},
  });

  assert.equal(normalized.taskInput.searchFilters.publishTime, 'day');
  assert.equal(normalized.taskInput.searchFilters.sort, 'latest');
  assert.equal(normalized.taskInput.searchFilters.searchScope, 'unviewed');
  assert.equal(normalized.taskInput.searchFilters.videoDuration, 'under_1m');
  assert.deepEqual(normalized.taskInput.searchPasses, ['all', 'video']);
});

test('custom-date schedules reject malformed dates and normalize accepted dates', () => {
  assert.throws(
    () => normalizeOrchestrationSchedule({mode: 'daily', maxRounds: 2}),
    error => error?.code === 'multi_agent_schedule_single_round_only',
  );
  assert.throws(
    () => normalizeOrchestrationSchedule({
      mode: 'custom_dates',
      customDates: '2026-07-23\n2026-02-30',
    }),
    error => error?.code === 'invalid_schedule_dates',
  );
  assert.deepEqual(
    normalizeOrchestrationSchedule({
      mode: 'custom_dates',
      startTime: '08:05',
      customDates: '2026/7/24，2026-07-23\n2026-07-24',
      randomOffsetMin: 0,
    }),
    {
      mode: 'custom_dates',
      timezone: 'Asia/Shanghai',
      startTime: '08:05',
      randomOffsetMin: 0,
      customDates: '2026-07-23\n2026-07-24',
      maxRounds: 1,
      roundGapMin: 10,
      overlapPolicy: 'skip',
      lateStartGraceMin: 360,
    },
  );
});

test('next schedule occurrence is computed in Asia/Shanghai and is deterministic', () => {
  const schedule = {
    mode: 'custom_dates',
    startTime: '09:30',
    randomOffsetMin: 0,
    customDates: '2026-07-23\n2026-07-24',
  };
  assert.equal(
    computeNextOrchestrationRunAt(schedule, {
      after: new Date('2026-07-23T00:00:00.000Z'),
      seed: 'schedule-a',
    }),
    '2026-07-23T01:30:00.000Z',
  );
  assert.equal(
    computeNextOrchestrationRunAt(schedule, {
      after: new Date('2026-07-23T02:00:00.000Z'),
      seed: 'schedule-a',
    }),
    '2026-07-24T01:30:00.000Z',
  );
  assert.equal(
    computeNextOrchestrationRunAt(schedule, {
      after: new Date('2026-07-24T02:00:00.000Z'),
      seed: 'schedule-a',
    }),
    '',
  );
  const jittered = {
    mode: 'daily',
    startTime: '09:30',
    randomOffsetMin: 20,
  };
  assert.equal(
    computeNextOrchestrationRunAt(jittered, {
      after: new Date('2026-07-23T00:00:00.000Z'),
      seed: 'schedule-a',
    }),
    computeNextOrchestrationRunAt(jittered, {
      after: new Date('2026-07-23T00:00:00.000Z'),
      seed: 'schedule-a',
    }),
  );
});

test('balanced allocation is deterministic, contiguous, disjoint, and differs by at most one', () => {
  const input = {
    keywords: Array.from({length: 10}, (_, index) => `关键词${index + 1}`),
    agentIds: ['agent-a', 'agent-b', 'agent-c'],
    revision: 4,
  };
  const first = allocateKeywordWorkItems(input);
  const replay = allocateKeywordWorkItems(structuredClone(input));

  assert.deepEqual(first, replay);
  assert.deepEqual(first.groups.map(group => group.keywords.length), [4, 3, 3]);
  assert.deepEqual(first.groups[0].keywords, ['关键词1', '关键词2', '关键词3', '关键词4']);
  assert.deepEqual(first.groups[1].keywords, ['关键词5', '关键词6', '关键词7']);
  assert.deepEqual(first.groups[2].keywords, ['关键词8', '关键词9', '关键词10']);
  assert.equal(new Set(first.items.map(item => item.keyword)).size, 10);
  assert.equal(new Set(first.items.map(item => item.itemKey)).size, 10);
  assert.ok(first.items.every(item => item.assignmentRevision === 4));
  assert.ok(first.items.every(item => item.status === 'assigned'));
});

test('allocation omits empty Agent groups and never emits a no-op command group', () => {
  const allocation = allocateKeywordWorkItems({
    keywords: ['A', 'B'],
    agentIds: ['agent-a', 'agent-b', 'agent-c', 'agent-d'],
  });
  assert.equal(allocation.items.length, 2);
  assert.deepEqual(allocation.groups.map(group => group.agentId), [
    'agent-a',
    'agent-b',
  ]);
  assert.ok(allocation.groups.every(group => group.keywords.length === 1));
});

test('request hash ignores idempotency labels and object key order but detects allocation changes', () => {
  const first = {
    requestKey: 'retry-1',
    platform: 'douyin',
    keywords: ['A', 'B'],
    agentIds: ['agent-a', 'agent-b'],
    taskInput: {maxRounds: 1, searchFilters: {sort: 'latest'}},
  };
  const retry = {
    taskInput: {searchFilters: {sort: 'latest'}, maxRounds: 1},
    agentIds: ['agent-a', 'agent-b'],
    keywords: ['A', 'B'],
    platform: 'douyin',
    requestKey: 'retry-2',
    updatedAt: '2026-07-23T01:00:00.000Z',
  };
  assert.equal(hashOrchestrationRequest(first), hashOrchestrationRequest(retry));
  assert.equal(hashOrchestrationRequest(first).length, 64);
  assert.notEqual(
    hashOrchestrationRequest(first),
    hashOrchestrationRequest({...first, agentIds: ['agent-b', 'agent-a']}),
  );
  assert.notEqual(
    hashOrchestrationRequest(first),
    hashOrchestrationRequest({...first, keywords: ['A', 'C']}),
  );
});

test('checkpoint mapping is retry-aware and requires structured safety evidence', () => {
  assert.equal(
    checkpointEntryToItemStatus({status: 'completed', attemptCount: 1}),
    'completed',
  );
  assert.equal(checkpointEntryToItemStatus({status: 'partial'}), 'retryable');
  assert.equal(
    checkpointEntryToItemStatus({status: 'failed', attemptCount: 1}, {maxAttempts: 2}),
    'retryable',
  );
  assert.equal(
    checkpointEntryToItemStatus({status: 'failed', attemptCount: 2}, {maxAttempts: 2}),
    'failed',
  );
  assert.equal(
    checkpointEntryToItemStatus({
      status: 'failed',
      attemptCount: 2,
      error: {code: 'PLATFORM_SAFETY_BLOCK'},
    }),
    'needs_action',
  );
  assert.equal(
    checkpointEntryToItemStatus({
      status: 'failed',
      attemptCount: 1,
      errorCode: 'DOUYIN_SEARCH_SERVICE_ABNORMAL',
    }),
    'retryable',
  );
  assert.equal(
    checkpointEntryToItemStatus({
      status: 'failed',
      attemptCount: 1,
      errorCode: 'DOUYIN_SEARCH_SERVICE_ABNORMAL',
      requiresManualAction: true,
    }),
    'retryable',
    'legacy service-abnormal flags must be downgraded after the behavior change',
  );
  assert.equal(
    checkpointEntryToItemStatus({
      status: 'failed',
      attemptCount: 1,
      errorCode: 'SECURITY_VERIFICATION_REQUIRED',
      requiresManualAction: true,
    }),
    'needs_action',
  );
  assert.equal(
    checkpointEntryToItemStatus({
      status: 'failed',
      attemptCount: 2,
      error: '文案里声称触发平台安全限制，但没有结构化证据',
    }),
    'failed',
  );
});

test('parent aggregate stays running during mixed progress and settles conservatively', () => {
  const active = aggregateParentTaskItems([
    {status: 'completed'},
    {status: 'running'},
    {status: 'needs_action'},
    {status: 'assigned'},
  ]);
  assert.equal(active.status, 'running');
  assert.equal(active.progress.current, 1);
  assert.equal(active.progress.total, 4);
  assert.equal(active.progress.percent, 25);
  assert.equal(active.counts.needsAction, 1);
  assert.equal(active.terminal, false);

  const warning = aggregateParentTaskItems([
    {status: 'completed'},
    {status: 'skipped'},
  ]);
  assert.equal(warning.status, 'completed_with_warnings');
  assert.equal(warning.terminal, true);

  const partial = aggregateParentTaskItems([
    {status: 'completed'},
    {status: 'failed'},
    {status: 'canceled'},
  ]);
  assert.equal(partial.status, 'completed_with_failures');
  assert.equal(partial.progress.percent, 100);
  assert.equal(partial.terminal, true);

  const stopped = aggregateParentTaskItems([
    {status: 'completed'},
    {status: 'canceled'},
    {status: 'canceled'},
  ]);
  assert.equal(stopped.status, 'canceled');
  assert.equal(stopped.progress.percent, 100);
  assert.equal(stopped.terminal, true);
});

test('migration adds parent/item audit fields without pretending to implement a lease or fence', async () => {
  const migration = await readFile(
    new URL(
      '../server/db/migrations/041_capture_task_orchestration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(migration, /parent_task_id UUID/);
  assert.match(migration, /orchestration_revision INTEGER/);
  assert.match(migration, /assigned_agent_id UUID/);
  assert.match(migration, /execution_task_id UUID/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS capture_task_item_attempts/);
  assert.match(migration, /UNIQUE \(item_id, attempt_number\)/);
  assert.doesNotMatch(migration, /\b(?:lease_expires_at|fencing_token|claim_token)\b/);
});

test('cloud orchestration schedule migration keeps each occurrence unique and cleanup auditable', async () => {
  const migration = await readFile(
    new URL(
      '../server/db/migrations/043_capture_orchestration_schedules.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS capture_orchestration_schedules/);
  assert.match(migration, /template_task_id UUID NOT NULL UNIQUE/);
  assert.match(migration, /next_run_at TIMESTAMPTZ/);
  assert.match(migration, /uniq_capture_orchestration_schedule_occurrence/);
  assert.match(migration, /attention_dismissed_at TIMESTAMPTZ/);
  assert.match(migration, /attention_dismissed_by_user_id UUID/);
  assert.doesNotMatch(
    migration,
    /ON DELETE SET NULL \([^)]+\)/u,
    'production PostgreSQL 14 does not support a SET NULL target-column list',
  );
  assert.doesNotMatch(migration, /\bDELETE FROM capture_tasks\b/);
});

test('elastic work queue migration is additive and keeps old schedules fixed', async () => {
  const migration = await readFile(
    new URL(
      '../server/db/migrations/061_capture_cloud_work_queue.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(migration, /distribution_mode TEXT NOT NULL DEFAULT 'fixed_batch'/u);
  assert.match(migration, /'fixed_batch', 'elastic_pool'/u);
  assert.match(migration, /idx_capture_task_items_elastic_claim/u);
  assert.match(migration, /idx_capture_task_items_negative_claim/u);
  assert.doesNotMatch(migration, /DELETE FROM/u);
});

test('bootstrap pacing lookback stays tenant-scoped and index-backed', async () => {
  const migration = await readFile(
    new URL(
      '../server/db/migrations/069_capture_bootstrap_pacing.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    migration,
    /capture_task_item_attempts \(tenant_id, updated_at DESC\)/u,
  );
  assert.match(
    migration,
    /WHERE status IN \('retryable', 'needs_action', 'failed'\)/u,
  );
});

test('schedule overlap guard ignores its template but still detects active occurrences', async () => {
  const scheduler = await readFile(
    new URL(
      '../server/services/capture-orchestration-scheduler.js',
      import.meta.url,
    ),
    'utf8',
  );
  const overlapStart = scheduler.indexOf('const overlapping = await tx.queryOne');
  const overlapEnd = scheduler.indexOf('if (overlapping)', overlapStart);
  assert.ok(overlapStart >= 0);
  assert.ok(overlapEnd > overlapStart);
  const overlap = scheduler.slice(overlapStart, overlapEnd);

  assert.match(overlap, /run\.orchestration_schedule_id = \$2/u);
  assert.match(overlap, /run\.id <> \$3/u);
  assert.match(
    overlap,
    /SCHEDULE_TERMINAL_RUN_STATUSES/u,
  );
  assert.match(overlap, /run\.status = ANY\(\$5::text\[\]\)/u);
  assert.match(overlap, /child\.parent_task_id = run\.id/u);
  assert.match(overlap, /item\.task_id = run\.id/u);
  assert.match(overlap, /item\.status = ANY\(\$6::text\[\]\)/u);
  assert.match(overlap, /NOT EXISTS \([\s\S]*any_child/u);
  assert.match(overlap, /NOT EXISTS \([\s\S]*any_item/u);
});

test('elastic schedule occurrences materialize pending work without preassigning child commands', async () => {
  const scheduler = await readFile(
    new URL(
      '../server/services/capture-orchestration-scheduler.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(scheduler, /schedule\.distribution_mode === 'elastic_pool'/u);
  assert.match(scheduler, /capture_orchestration_schedule_agents/u);
  assert.match(scheduler, /eligibleAgentIds/u);
  assert.match(scheduler, /distributionMode === 'elastic_pool' \? 'pending' : 'assigned'/u);
  const elasticStart = scheduler.indexOf("if (distributionMode === 'elastic_pool')");
  const fixedDispatch = scheduler.indexOf('const itemsByAgent = new Map()', elasticStart);
  assert.ok(elasticStart >= 0);
  assert.ok(fixedDispatch > elasticStart);
  const elastic = scheduler.slice(elasticStart, fixedDispatch);
  assert.match(elastic, /orchestration_schedule_queue_created/u);
  assert.doesNotMatch(elastic, /INSERT INTO capture_agent_commands/u);
});

test('sequential patrol stays one keyword item and is executed inside one Agent task', async () => {
  const [scheduler, route, agent] = await Promise.all([
    readFile(new URL('../server/services/capture-orchestration-scheduler.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/routes/capture-cloud.js', import.meta.url), 'utf8'),
    readFile(new URL('../utils/cloud-task-agent.js', import.meta.url), 'utf8'),
  ]);

  assert.match(scheduler, /const runItemTotal = templateItems\.length/u);
  assert.match(scheduler, /sequentialSearch:[\s\S]*passes: searchPasses/u);
  assert.match(scheduler, /searchPasses,[\s\S]*disableAutomaticSearchRetry: true/u);
  assert.match(scheduler, /disableAutomaticSearchRetry: true/u);
  assert.match(scheduler, /requireVerifiedFilters: true/u);
  assert.match(scheduler, /remoteSequentialSearchPassesV1/u);
  assert.doesNotMatch(scheduler, /dependsOnItemId/u);

  const claimStart = route.indexOf('async function dispatchNextElasticWorkItem');
  const claimEnd = route.indexOf('async function dispatchQueuedCommands', claimStart);
  const claim = route.slice(claimStart, claimEnd);
  assert.match(claim, /remoteSequentialSearchPassesV1 === true/u);
  assert.match(claim, /parent\.metadata->'planSnapshot'->'searchPasses'/u);
  assert.match(claim, /planSnapshot,[\s\S]*maxRounds: 1/u);
  assert.doesNotMatch(claim, /dependsOnItemId/u);

  const refreshStart = route.indexOf('async function refreshOrchestrationParentTask');
  const refreshEnd = route.indexOf('async function projectNegativePatrolSnapshot', refreshStart);
  const refresh = route.slice(refreshStart, refreshEnd);
  assert.match(refresh, /status = 'needs_action'[\s\S]*status = 'retryable'[\s\S]*disableAutomaticSearchRetry/u);
  assert.doesNotMatch(refresh, /staged_patrol_predecessor_not_safe/u);
  assert.match(agent, /remoteSequentialSearchPassesV1: true/u);
});

test('terminal or attention-only schedule residue never blocks the next occurrence', async () => {
  const {
    scheduleRunBlocksNextOccurrence,
    SCHEDULE_OVERLAP_ITEM_STATUSES,
  } = await import(
    `../server/services/capture-orchestration-scheduler.js?overlap=${Date.now()}`
  );

  assert.equal(scheduleRunBlocksNextOccurrence({
    runStatus: 'completed',
    itemStatuses: Array(13).fill('assigned'),
  }), false);
  assert.equal(scheduleRunBlocksNextOccurrence({
    runStatus: 'needs_action',
    itemStatuses: ['needs_action', 'retryable', 'retryable'],
  }), false);
  assert.equal(scheduleRunBlocksNextOccurrence({
    runStatus: 'needs_action',
    childStatuses: ['running'],
  }), true);
  assert.equal(scheduleRunBlocksNextOccurrence({
    runStatus: 'running',
  }), true);
  assert.equal(scheduleRunBlocksNextOccurrence({
    runStatus: 'running',
    childStatuses: ['completed'],
    itemStatuses: ['completed', 'failed'],
  }), false);
  assert.equal(SCHEDULE_OVERLAP_ITEM_STATUSES.includes('retryable'), false);
});

test('manual cloud start is idempotent and never overlaps an active schedule run', async () => {
  const scheduler = await readFile(
    new URL(
      '../server/services/capture-orchestration-scheduler.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    scheduler,
    /export async function runCaptureOrchestrationScheduleNow/u,
  );
  assert.match(
    scheduler,
    /orchestration_schedule_manual_run_requested/u,
  );
  assert.match(
    scheduler,
    /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)/u,
  );
  assert.match(
    scheduler,
    /if \(manual\) \{[\s\S]*kind: 'blocked_overlap'/u,
  );
  assert.match(scheduler, /manualRunNow: manual/u);
  assert.match(
    scheduler,
    /\['active', 'completed'\]\.includes\(schedule\.status\)/u,
  );
});
