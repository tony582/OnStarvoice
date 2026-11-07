import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {
  KEYWORD_REPAIR_LIMIT,
  buildKeywordRepairCheckpoint,
  keywordRepairPendingError,
  normalizeKeywordRepairTargets,
  pendingKeywordRepair,
  planKeywordRepair,
  settleKeywordRepair,
} from '../server/services/capture-keyword-repair.js';
import {normalizeCloudTaskSnapshot} from '../server/services/capture-cloud.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const noteId = '6aa1e9900000000012027610';
const target = {recordId: 'rec_keyword_notes_a', externalId: noteId,
  url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=test-only`, platform: 'xiaohongshu', stage: 'navigation'};
const failure = {version: 1, failedRecordIds: [target.recordId], failedTargets: [target],
  savedDetailRecordIds: [], failureStages: ['navigation'], autoRetryCount: 1, budgetStopReason: 'retry_time_budget'};
const exhaustedEntry = {keyword: '安吉星', round: 1, status: 'failed', errorCode: 'ENHANCEMENT_RETRY_EXHAUSTED'};
const exhaustedCheckpoint = {keyword: '安吉星', round: 1, status: 'failed', enhancementFailure: failure};
const plan = (overrides = {}) => planKeywordRepair({entry: exhaustedEntry, checkpoint: exhaustedCheckpoint,
  platform: 'xiaohongshu', sourceAgentId: 'agent-a', executionTaskId: 'task-a', now: new Date('2026-11-07T12:00:00Z'),
  ...overrides});

test('an exhausted step with known posts is planned for another browser', () => {
  const repair = plan();
  assert.equal(repair.state, 'pending');
  assert.equal(repair.count, 1);
  assert.equal(repair.round, 1);
  assert.equal(repair.keyword, '安吉星');
  assert.deepEqual(repair.targets, [{externalId: noteId, url: target.url, stage: 'navigation'}]);
  assert.deepEqual(repair.sourceAgentIds, ['agent-a']);
  assert.equal(pendingKeywordRepair({keywordRepair: repair}), repair);
  const error = keywordRepairPendingError({code: 'ENHANCEMENT_RETRY_EXHAUSTED', message: '采集增强有 1 条仍未完成'}, repair);
  assert.equal(error.code, 'KEYWORD_REPAIR_PENDING');
  assert.equal(error.sourceCode, 'ENHANCEMENT_RETRY_EXHAUSTED');
  assert.match(error.message, /已交给其它节点补采这 1 条帖子（第 1\/2 次）/u);
});

test('repairs are bounded, replay-safe and respect pinned or no-handoff plans', () => {
  const first = plan();
  assert.equal(plan({itemMetadata: {keywordRepair: first}}), first, 'the same source execution plans once');
  const second = plan({itemMetadata: {keywordRepair: first}, executionTaskId: 'task-b', sourceAgentId: 'agent-b'});
  assert.equal(second.count, 2);
  assert.deepEqual(second.sourceAgentIds, ['agent-a', 'agent-b']);
  assert.equal(plan({itemMetadata: {keywordRepair: {...second, count: KEYWORD_REPAIR_LIMIT}}, executionTaskId: 'task-c'}), null);
  assert.equal(plan({itemMetadata: {pinnedAgentId: 'agent-a'}}), null);
  assert.equal(plan({planSnapshot: {recoveryPolicy: {allowIdleAgentHandoff: false}}}), null);
  assert.equal(plan({parentMetadata: {automaticRetryDisabled: true}}), null);
  assert.equal(plan({attemptBudgetRemaining: false}), null);
  assert.equal(plan({entry: {...exhaustedEntry, errorCode: 'XHS_SEARCH_PAGE_TIMEOUT'}}), null);
  assert.equal(plan({checkpoint: {...exhaustedCheckpoint, enhancementFailure: {...failure, failedTargets: []}}}), null,
    'without post identity the failure stays visible instead of re-searching');
});

test('repair targets accept only https post links on the same platform', () => {
  const targets = normalizeKeywordRepairTargets([
    target,
    {...target},
    {externalId: 'x1', url: 'http://www.xiaohongshu.com/explore/x1'},
    {externalId: 'x2', url: 'https://evil.example/explore/x2'},
    {externalId: 'x3', url: 'https://user:pass@www.xiaohongshu.com/explore/x3'},
    {externalId: '', url: target.url},
  ], 'xiaohongshu');
  assert.deepEqual(targets.map(t => t.externalId), [noteId]);
});

test('a settled repaired step closes the repair; other steps or running snapshots do not', () => {
  const repair = plan();
  const metadata = {keywordRepair: repair};
  assert.equal(settleKeywordRepair({itemMetadata: metadata, checkpoint: {round: 1}, status: 'running'}), null);
  assert.equal(settleKeywordRepair({itemMetadata: metadata, checkpoint: {round: 2}, status: 'completed'}), null);
  assert.equal(settleKeywordRepair({itemMetadata: metadata, checkpoint: {round: 1}, status: 'completed'}).state, 'completed');
  assert.equal(settleKeywordRepair({itemMetadata: metadata, checkpoint: {round: 1}, status: 'failed'}).state, 'closed');
});

test('a repair relay resumes at the repaired step and keeps other completed steps', () => {
  const checkpoint = buildKeywordRepairCheckpoint({
    repair: {keyword: '别克车机升级', round: 1},
    itemMetadata: {checkpoint: {searchPassResults: [
      {keyword: '别克车机升级', round: 1, status: 'failed', errorCode: 'ENHANCEMENT_RETRY_EXHAUSTED'},
      {keyword: '别克车机升级', round: 2, status: 'completed', savedCount: 4, scanComplete: true},
    ]}},
    now: new Date('2026-11-07T12:00:00Z'),
  });
  assert.equal(checkpoint.round, 1);
  assert.deepEqual(checkpoint.keywordResults.map(entry => [entry.round, entry.status]), [[2, 'completed']]);
});

test('the server keeps failed post identities through snapshot sanitizing', () => {
  const snapshot = normalizeCloudTaskSnapshot({
    id: 'client-task', status: 'completed_with_failures', platform: 'xiaohongshu',
    taskType: 'unattended_keyword_capture', featureKey: 'unattended_keyword_plan',
    checkpoint: {round: 1, keywordResults: [{...exhaustedEntry, enhancementFailure: failure}]},
  });
  assert.deepEqual(snapshot.checkpoint.keywordResults[0].enhancementFailure.failedTargets, [target]);
});

test('the Extension task ledger and cloud snapshot keep the evidence below the generic depth limit', async () => {
  const context = vm.createContext({AbortController, Date, URL, clearTimeout, setTimeout});
  vm.runInContext(await readFile(resolve(repoRoot, 'utils/task-center.js'), 'utf8'), context);
  vm.runInContext(await readFile(resolve(repoRoot, 'utils/cloud-task-agent.js'), 'utf8'), context);
  const run = context.OnStarvoiceTaskCenterCore.normalizeTaskRun({
    id: 'run-1', status: 'completed_with_failures', platform: 'xiaohongshu', kind: 'unattended_keyword',
    checkpoint: {round: 1, keywordResults: [{...exhaustedEntry, retryable: false, enhancementFailure: failure}]},
  });
  const entry = JSON.parse(JSON.stringify(run.checkpoint.keywordResults[0]));
  assert.equal(entry.retryable, false);
  assert.deepEqual(entry.enhancementFailure.failedTargets, [target]);
  const snapshot = JSON.parse(JSON.stringify(context.OnStarvoiceCloudTaskAgent.buildTaskSnapshot(run)));
  assert.deepEqual(snapshot.checkpoint.keywordResults[0].enhancementFailure.failedTargets, [target]);
  assert.deepEqual(snapshot.checkpoint.keywordResults[0].enhancementFailure.failedRecordIds, [target.recordId]);
});

test('the Extension advertises the repair capability and the keyword runner takes the repair branch', async () => {
  const agent = await readFile(resolve(repoRoot, 'utils/cloud-task-agent.js'), 'utf8');
  assert.match(agent, /keywordRepairTargetsV1: true/u);
  const sync = await readFile(resolve(repoRoot, 'utils/capture-sync.js'), 'utf8');
  assert.match(sync, /if \(repairTargets\.length > 0\) \{\s*keywordResult = await prepareKeywordRepairRecords/u);
  assert.match(sync, /\} else try \{/u);
  const sidebar = await readFile(resolve(repoRoot, 'sidebar/sidebar-logic.js'), 'utf8');
  assert.match(sidebar, /keywordRepair: plan\.keywordRepair \|\| null/u);
  assert.match(sidebar, /keywordRepair: runOptions\.keywordRepair \|\| null,\s*keywordRepairRound: round/u);
});
