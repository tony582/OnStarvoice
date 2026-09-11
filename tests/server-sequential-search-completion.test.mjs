import assert from 'node:assert/strict';
import test from 'node:test';
import {
  orchestrationCheckpointEntries,
  sequentialKeywordCompletionEvidence,
  evaluateIncompleteSequentialItemRepair,
  buildSequentialSearchResumeCheckpoint,
} from '../server/routes/capture-cloud.js';
import {checkpointEntryToItemStatus} from '../server/services/capture-orchestration.js';

const keyword = '别克 OTA';
const planSnapshot = {platform: 'douyin', searchPasses: ['all', 'image'], keywords: [keyword]};
const first = {keyword, round: 1, status: 'completed', savedCount: 0, finishedAt: '2026-09-10T12:31:50Z'};
const snapshot = status => ({status, finishedAt: '2026-09-10T12:38:50Z',
  progress: {keyword, roundCurrent: 2},
  checkpoint: {round: 2, activeKeyword: keyword, keywordResults: [first]},
  error: {code: 'stale_unattended_attempt', message: '旧无人值守运行页已失效'}});

test('an unfinished second pass never becomes complete when the child stops before writing it', () => {
  for (const status of ['running', 'failed', 'needs_action', 'completed', 'completed_with_failures']) {
    const entry = orchestrationCheckpointEntries(snapshot(status), {planSnapshot})[0];
    assert.equal(entry.round, 2);
    assert.notEqual(checkpointEntryToItemStatus(entry), 'completed');
    assert.deepEqual(entry.searchPassResults, [first]);
    assert.deepEqual(entry.searchPassCompletion.missing, [2]);
    if (status === 'running') assert.equal(entry.status, 'running');
    else {
      assert.equal(entry.error.code, 'stale_unattended_attempt');
      assert.equal(entry.finishedAt, snapshot(status).finishedAt);
    }
  }
});

test('the first completed step cannot settle a still-active two-step item or parent', () => {
  const active = snapshot('running');
  active.progress.roundCurrent = 1;
  active.checkpoint.round = 1;
  assert.equal(orchestrationCheckpointEntries(active, {planSnapshot})[0].status, 'running');
});

test('genuine complete, single-step, other platform and explicit cancellation remain distinct', () => {
  const complete = snapshot('completed');
  complete.checkpoint.keywordResults.push({...first, round: 2});
  assert.equal(orchestrationCheckpointEntries(complete, {planSnapshot})[0].status, 'completed');
  assert.equal(orchestrationCheckpointEntries(snapshot('failed'), {planSnapshot: {platform: 'douyin'}})[0].status, 'completed');
  assert.equal(orchestrationCheckpointEntries(snapshot('failed'), {planSnapshot: {...planSnapshot, platform: 'xiaohongshu'}})[0].status, 'completed');
  assert.equal(orchestrationCheckpointEntries(snapshot('canceled'), {planSnapshot})[0].status, 'canceled');
});

test('completion uses every required round and retains an explicit earlier failed step', () => {
  const value = snapshot('failed');
  value.checkpoint.keywordResults = [{...first, status: 'failed', errorCode: 'NETWORK_TIMEOUT'}, {...first, round: 2}];
  const entry = orchestrationCheckpointEntries(value, {planSnapshot})[0];
  assert.equal(entry.errorCode, 'NETWORK_TIMEOUT');
  assert.equal(entry.round, 1);
  assert.deepEqual(sequentialKeywordCompletionEvidence(value, planSnapshot, keyword).missing, [1]);
});

test('duplicate rounds use the latest failure consistently for both completeness and recovery', () => {
  const value = snapshot('failed');
  value.checkpoint.keywordResults = [first,
    {...first, status: 'failed', errorCode: 'LATEST_STEP_FAILURE'}, {...first, round: 2}];
  const entry = orchestrationCheckpointEntries(value, {planSnapshot})[0];
  assert.deepEqual(entry.searchPassCompletion.missing, [1]);
  assert.notEqual(checkpointEntryToItemStatus(entry), 'completed');
  assert.equal(entry.errorCode, 'LATEST_STEP_FAILURE');
  assert.equal(entry.error.code, 'LATEST_STEP_FAILURE');
  value.checkpoint.keywordResults.push({...first});
  assert.equal(sequentialKeywordCompletionEvidence(value, planSnapshot, keyword).complete, true);
  assert.equal(orchestrationCheckpointEntries(value, {planSnapshot})[0].status, 'completed');
});

function repairFixture({code = 'stale_unattended_attempt', attemptCount = 2, pinned = false} = {}) {
  const parent = {id: 'parent', tenant_id: 'tenant', status: 'completed', metadata: {distributionMode: 'elastic_pool',
    eligibleAgentIds: ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'], planSnapshot}};
  const item = {id: 'item', tenant_id: 'tenant', task_id: parent.id, execution_task_id: 'child', assigned_agent_id: 'agent',
    item_type: 'keyword', keyword, status: 'completed', attempt_count: attemptCount, assignment_revision: 2,
    metadata: {elasticAttemptBudgetUsed: attemptCount, ...(pinned ? {pinnedAgentId: parent.metadata.eligibleAgentIds[0]} : {})}};
  const child = {...snapshot('failed'), id: 'child', tenant_id: 'tenant', parent_task_id: parent.id, assigned_agent_id: 'agent'};
  child.error = {code, message: code};
  const attempt = {id: 'attempt', tenant_id: 'tenant', parent_task_id: parent.id, status: 'completed', item_id: item.id, execution_task_id: child.id,
    agent_id: item.assigned_agent_id, assignment_revision: 2, attempt_number: attemptCount};
  return {parent, item, child, attempt};
}

test('reviewed historical repair preserves the completed prefix and refunds only the technical budget once', () => {
  const fixture = repairFixture();
  const fix = evaluateIncompleteSequentialItemRepair(fixture);
  assert.equal(fix.eligible, true);
  assert.equal(fix.status, 'retryable');
  assert.equal(fix.metadataPatch.elasticAttemptBudgetUsed, 1);
  assert.equal(fix.metadataPatch.elasticTechnicalAttemptCount, 1);
  const resume = buildSequentialSearchResumeCheckpoint({planSnapshot, itemMetadata: {checkpoint: fix.checkpoint}, keyword});
  assert.equal(resume.round, 2);
  assert.deepEqual(resume.keywordResults.map(row => row.round), [1]);
  const replay = evaluateIncompleteSequentialItemRepair({...fixture, item: {...fixture.item,
    metadata: {...fixture.item.metadata, ...fix.metadataPatch}}});
  assert.equal(replay.metadataPatch.elasticAttemptBudgetUsed, 1);
  assert.equal(replay.metadataPatch.elasticTechnicalAttemptCount, 1);
});

test('historical repair respects exhausted, pinned, safety and disabled-handoff policy', () => {
  for (const fixture of [repairFixture({attemptCount: 4}), repairFixture({pinned: true})]) {
    const fix = evaluateIncompleteSequentialItemRepair(fixture);
    assert.notEqual(fix.status, 'retryable');
    assert.equal(fix.error.recoveryLimitReached, true);
  }
  const safety = evaluateIncompleteSequentialItemRepair(repairFixture({code: 'LOGIN_REQUIRED'}));
  assert.equal(safety.status, 'needs_action');
  const disabled = repairFixture();
  disabled.parent.metadata.automaticRetryDisabled = true;
  assert.equal(evaluateIncompleteSequentialItemRepair(disabled).status, 'needs_action');
});

test('repair excludes complete results, stopped parents, canceled children and changed attempt lineage', () => {
  const fixtures = [repairFixture(), repairFixture(), repairFixture(), repairFixture()];
  fixtures[0].child.checkpoint.keywordResults.push({...first, round: 2});
  fixtures[1].parent.metadata.operatorStopped = true;
  fixtures[2].child.status = 'canceled';
  fixtures[3].attempt.attempt_number = 3;
  for (const fixture of fixtures) assert.equal(evaluateIncompleteSequentialItemRepair(fixture).eligible, false);
});

test('repair cannot reopen hidden parents, user-cancellation failures, foreign tenants or active attempts', () => {
  const fixtures = Array.from({length: 5}, () => repairFixture());
  fixtures[0].parent.metadata.historyClearedAt = '2026-09-10';
  fixtures[1].parent.status = 'failed';
  fixtures[2].child.error.category = 'user_canceled';
  fixtures[3].attempt.tenant_id = 'foreign';
  fixtures[4].attempt.status = 'running';
  for (const fixture of fixtures) assert.equal(evaluateIncompleteSequentialItemRepair(fixture).eligible, false);
});
