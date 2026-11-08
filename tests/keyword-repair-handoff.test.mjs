import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {
  KEYWORD_REPAIR_LIMIT,
  buildKeywordRepairCheckpoint,
  decideKeywordRepair,
  keywordRepairFailedAgentIds,
  keywordRepairPendingError,
  keywordRepairTargetUnopenable,
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

test('a settled repaired step closes the repair; a failed other step or running snapshot does not', () => {
  const repair = plan();
  const metadata = {keywordRepair: repair};
  assert.equal(settleKeywordRepair({itemMetadata: metadata, checkpoint: {round: 1}, status: 'running'}), null);
  assert.equal(settleKeywordRepair({itemMetadata: metadata, checkpoint: {round: 2}, status: 'failed'}), null);
  assert.equal(settleKeywordRepair({itemMetadata: metadata, checkpoint: {round: 2}, status: 'completed'}).state, 'completed',
    'a completed keyword needs every step, including the repaired one');
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

// 11-08 ibuick: one Douyin note no browser could open. Every repair run used to
// report a generic failure that did not count, so the keyword went around
// seven browsers twelve times and still ended as failed for a person.
const douyinId = '7705537689119245434';
const douyinTarget = {recordId: 'rec_keyword_notes_94d1', externalId: douyinId,
  url: `https://www.douyin.com/note/${douyinId}`, platform: 'douyin', stage: 'navigation'};
const douyinFailure = {version: 1, failedRecordIds: [douyinTarget.recordId], failedTargets: [douyinTarget],
  savedDetailRecordIds: [], failureStages: ['navigation'], autoRetryCount: 2, budgetStopReason: 'attempt_budget'};
const sourceEntry = {keyword: 'ibuick', round: 2, status: 'failed', errorCode: 'ENHANCEMENT_RETRY_EXHAUSTED'};
const genericEntry = {keyword: 'ibuick', round: 2, status: 'failed', errorCode: 'INCOMPLETE_SEARCH_PASSES'};
const decide = (overrides = {}) => decideKeywordRepair({
  entry: sourceEntry, checkpoint: {keyword: 'ibuick', round: 2, enhancementFailure: douyinFailure},
  status: 'failed', error: {code: 'ENHANCEMENT_RETRY_EXHAUSTED', message: '采集增强有 1 条仍未完成'},
  platform: 'douyin', agentId: 'xigua', executionTaskId: 'task-1', now: new Date('2026-11-08T05:49:00Z'), ...overrides,
});
const runOf = repair => ({version: 1, keyword: repair.keyword, round: repair.round, count: repair.count, targets: repair.targets});
const genericRun = (repair, agentId, executionTaskId) => decide({
  entry: genericEntry, checkpoint: {keyword: 'ibuick', round: 2}, status: 'retryable',
  error: {code: 'INCOMPLETE_SEARCH_PASSES', message: '采集增强未完整完成'},
  itemMetadata: {keywordRepair: repair}, childRepair: runOf(repair), agentId, executionTaskId,
});

test('every failed repair run counts, and a post three browsers cannot open finishes with a warning', () => {
  const first = decide();
  assert.equal(first.status, 'retryable');
  assert.equal(first.repair.count, 1);
  assert.deepEqual(keywordRepairFailedAgentIds(first.repair), ['xigua']);

  const second = genericRun(first.repair, 'taikongren', 'task-2');
  assert.equal(second.status, 'retryable', 'a generic repair failure is a counted repair, not a free relay');
  assert.equal(second.repair.count, 2);
  assert.deepEqual(keywordRepairFailedAgentIds(second.repair).sort(), ['taikongren', 'xigua']);
  assert.match(second.error.message, /第 2\/2 次/u);

  const third = genericRun(second.repair, 'tuxing', 'task-3');
  assert.equal(third.status, 'completed_with_warnings');
  assert.equal(third.error.code, 'KEYWORD_POSTS_UNOPENABLE');
  assert.equal(third.error.retryable, false);
  assert.match(third.error.message, /1 条帖子在 3 个节点都打不开，可能已删除或审核中/u);
  assert.deepEqual(third.error.unopenableTargets.map(target => [target.externalId, target.agentCount]), [[douyinId, 3]]);
  assert.equal(third.repair.state, 'unopenable');

  const replay = genericRun(third.repair, 'tuxing', 'task-3');
  assert.equal(replay.status, 'completed_with_warnings', 'a replayed final snapshot keeps the decision');
  const pendingReplay = genericRun(second.repair, 'taikongren', 'task-2');
  assert.equal(pendingReplay.status, 'retryable');
  assert.equal(pendingReplay.repair.count, 2, 'a replayed repair run is not counted twice');
});

test('a post failing elsewhere than the page open still ends visibly failed at the limit', () => {
  const first = decide();
  const commentsFailure = (repair, agentId, executionTaskId) => decide({
    entry: sourceEntry, checkpoint: {keyword: 'ibuick', round: 2, enhancementFailure: {...douyinFailure,
      failedTargets: [{...douyinTarget, stage: 'comments_capture', code: 'COMMENTS_CAPTURE_FAILED'}]}},
    itemMetadata: {keywordRepair: repair}, childRepair: runOf(repair), agentId, executionTaskId,
  });
  const second = commentsFailure(first.repair, 'taikongren', 'task-2');
  assert.equal(second.status, 'retryable');
  const third = commentsFailure(second.repair, 'tuxing', 'task-3');
  assert.equal(third.status, 'failed');
  assert.equal(third.repair.state, 'closed');
  assert.match(third.error.message, /已换 3 个节点补采这 1 条帖子，仍未完成/u);
  assert.equal(commentsFailure(third.repair, 'tuxing', 'task-3').status, 'failed', 'replay keeps the failure');
});

test('an interrupted repair run, a security stop and an ordinary failure are not counted as repairs', () => {
  const first = decide();
  for (const entry of [{...genericEntry, status: 'interrupted'}, {...genericEntry, errorCode: 'RUNNER_TAB_UNAVAILABLE'},
    {...genericEntry, recoverableInterruption: true}]) {
    const interrupted = decide({entry, checkpoint: {keyword: 'ibuick', round: 2}, status: 'retryable',
      error: {code: entry.errorCode},
      itemMetadata: {keywordRepair: first.repair}, childRepair: runOf(first.repair), agentId: 'taikongren', executionTaskId: 'task-2'});
    assert.equal(interrupted, null, 'the next browser runs the same repair again');
  }
  const security = decide({entry: genericEntry, checkpoint: {keyword: 'ibuick', round: 2}, status: 'needs_action',
    error: {code: 'DOUYIN_SECURITY_CHALLENGE', securityBlocked: true},
    itemMetadata: {keywordRepair: first.repair}, childRepair: runOf(first.repair), agentId: 'taikongren', executionTaskId: 'task-2'});
  assert.equal(security.status, 'needs_action');
  assert.equal(security.repair.state, 'closed');
  const ordinary = decide({entry: genericEntry, checkpoint: {keyword: 'ibuick', round: 2}, status: 'retryable',
    error: {code: 'INCOMPLETE_SEARCH_PASSES'}});
  assert.equal(ordinary, null, 'without a repair in progress nothing changes');
});

test('only page-open failures on three different browsers make a post unopenable', () => {
  const open = (agentId, extra = {}) => ({agentId, stage: 'navigation', ...extra});
  assert.equal(keywordRepairTargetUnopenable([open('a'), {agentId: 'b'}, {agentId: 'c'}]), true,
    'old browsers that report nothing still count once one names the open step');
  assert.equal(keywordRepairTargetUnopenable([open('a'), open('a'), open('b')]), false, 'distinct browsers');
  assert.equal(keywordRepairTargetUnopenable([{agentId: 'a'}, {agentId: 'b'}, {agentId: 'c'}]), false,
    'no browser named the open step');
  assert.equal(keywordRepairTargetUnopenable([open('a'), open('b'), {agentId: 'c', stage: 'comments_capture'}]), false);
  assert.equal(keywordRepairTargetUnopenable([open('a'), open('b'), open('c', {code: 'RUNNER_TAB_UNAVAILABLE'})]), false,
    'a broken browser is not evidence about the post');
  assert.equal(keywordRepairTargetUnopenable([open('a'), open('b'), {agentId: 'c', stage: 'retry_budget'}]), false,
    'a browser that never tried the post does not count');
  assert.equal(keywordRepairTargetUnopenable([open('a'), {agentId: 'b', code: 'PAGE_OPEN_TIMEOUT'},
    {agentId: 'c', code: 'ENHANCEMENT_RETRY_EXHAUSTED'}]), true);
});
