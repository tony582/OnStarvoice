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
  });

  assert.equal(normalized.requestKey, 'request-1');
  assert.equal(normalized.platform, 'xiaohongshu');
  assert.equal(normalized.executionMode, 'unattended_plan');
  assert.equal(normalized.allocationMode, 'balanced');
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
