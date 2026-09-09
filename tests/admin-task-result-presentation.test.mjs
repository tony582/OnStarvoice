import assert from 'node:assert/strict'
import test from 'node:test'
import { orchestrationCurrentExecution, orchestrationResultEvidence, resultSyncEvidence, resultTiming } from '../web/admin/src/pages/dispatch/cloud-tasks/task-result-presentation.mjs'

test('a resumed two-step keyword retains its failed current execution even when the first step was completed earlier', () => {
  const item = {id: 'keyword', keyword: '凯迪拉克壁纸', item_type: 'keyword', execution_task_id: 'second-attempt', status: 'completed'}
  const current = {id: 'second-attempt', status: 'failed', checkpoint: {round: 2, phase: 'pending', keywordResults: [
    {keyword: item.keyword, round: 1, status: 'completed', savedCount: 2, finishedAt: '2026-09-09T05:34:52+08:00'},
  ]}}
  const evidence = orchestrationResultEvidence(item, orchestrationCurrentExecution(item, [current]), 2)
  assert.equal(evidence.childIncomplete, true)
  assert.equal(evidence.missingCompletedSteps, true)
  assert.equal(evidence.completedStepCount, 1)
  assert.equal(item.status, 'completed', 'Result presentation must preserve the original task ledger')
})

test('a successfully recovered current execution does not inherit failures from a superseded attempt', () => {
  const item = {id: 'keyword', keyword: '品牌', item_type: 'keyword', execution_task_id: 'new'}
  const previous = {id: 'old', itemIds: ['keyword'], status: 'superseded', checkpoint: {keywordResults: [{keyword: '品牌', round: 1, status: 'failed'}]}}
  const current = {id: 'new', itemIds: ['keyword'], status: 'completed', checkpoint: {keywordResults: [1, 2].map(round => ({keyword: '品牌', round, status: 'completed'}))}}
  const evidence = orchestrationResultEvidence(item, orchestrationCurrentExecution(item, [previous, current]), 2)
  assert.equal(evidence.childIncomplete, false)
  assert.equal(evidence.failedStepCount, 0)
  assert.equal(evidence.missingCompletedSteps, false)
  assert.equal(orchestrationCurrentExecution({...item, execution_task_id: null}, [previous, current]), current)
})

test('reported upload failures require reconciliation and never establish a missing-content count', () => {
  const sync = {streamingSyncEvidenceKnown: true, streamingSyncDrainCompleted: true, streamingSyncRemainingCount: 0, streamingSyncFailedCount: 1}
  assert.equal(resultSyncEvidence(sync).outcome, 'needs_review')
  assert.equal(resultSyncEvidence({...sync, streamingSyncFailedCount: 0}).outcome, 'reported_drained')
  assert.equal(resultSyncEvidence({...sync, streamingSyncFailedCount: null}).outcome, 'needs_review')
  assert.equal(resultSyncEvidence({}).outcome, 'unknown')
})

test('a historical parent without a start timestamp shows total elapsed time without inventing an execution start', () => {
  const task = {createdAt: '2026-09-09T04:01:00+08:00', startedAt: null, finishedAt: '2026-09-09T05:05:07+08:00'}
  assert.deepEqual(resultTiming(task), {label: '总用时', source: 'created_at', duration: '1 小时 4 分'})
  assert.equal(task.startedAt, null)
  assert.equal(resultTiming({...task, startedAt: '2026-09-09T04:30:00+08:00'}).label, '执行耗时')
})
