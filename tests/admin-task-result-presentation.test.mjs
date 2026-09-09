import assert from 'node:assert/strict'
import test from 'node:test'
import { orchestrationCurrentExecution, orchestrationItemTiming, orchestrationResultEvidence, resultSyncEvidence, resultTiming } from '../web/admin/src/pages/dispatch/cloud-tasks/task-result-presentation.mjs'

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

test('the morning retried keyword uses its matching execution time pair and reports the stale attempt timestamp', () => {
  const item = {id: 'keyword', keyword: '凯迪拉克壁纸', execution_task_id: 'current', started_at: '2026-09-09T05:38:15.095728+08:00', finished_at: '2026-09-09T05:34:52.682+08:00'}
  const current = {id: 'current', status: 'failed', started_at: '2026-09-09T05:38:01.551+08:00', finished_at: '2026-09-09T05:38:45.075+08:00'}
  const attempts = [{id: 'latest', item_id: item.id, execution_task_id: current.id, attempt_number: 2, started_at: item.started_at, finished_at: item.finished_at}]
  const timing = orchestrationItemTiming(item, current, attempts)
  assert.equal(timing.source, 'execution')
  assert.equal(timing.startedAt, current.started_at)
  assert.equal(timing.finishedAt, current.finished_at)
  assert.equal(timing.invalidOrder, true)
  assert.match(timing.note, /工作项时间记录异常，显示对应节点执行时间/)
  assert.equal(attempts[0].finished_at, '2026-09-09T05:34:52.682+08:00')
  assert.equal(orchestrationResultEvidence(item, current).childIncomplete, true)
  const noValidExecutionPair = orchestrationItemTiming(item, {...current, finished_at: null}, attempts)
  assert.equal(noValidExecutionPair.source, 'attempt')
  assert.equal(noValidExecutionPair.finishedAt, null)
  assert.match(noValidExecutionPair.note, /结束时间早于开始时间/)
})

test('missing attempt timestamps fall back as a pair to the same current execution, never an older attempt', () => {
  const item = {id: 'keyword', execution_task_id: 'current', started_at: '2026-09-09T05:33:00+08:00', finished_at: '2026-09-09T05:34:00+08:00'}
  const current = {id: 'current', started_at: '2026-09-09T05:38:01+08:00', finished_at: '2026-09-09T05:38:45+08:00'}
  const attempts = [
    {item_id: item.id, execution_task_id: 'previous', attempt_number: 9, started_at: item.started_at, finished_at: item.finished_at},
    {item_id: item.id, execution_task_id: current.id, attempt_number: 2, started_at: '2026-09-09T05:38:15+08:00', finished_at: null},
  ]
  const timing = orchestrationItemTiming(item, current, attempts)
  assert.equal(timing.source, 'execution')
  assert.equal(timing.startedAt, current.started_at)
  assert.equal(timing.finishedAt, current.finished_at)
  const missingFinish = orchestrationItemTiming(item, {...current, finished_at: null}, attempts)
  assert.equal(missingFinish.source, 'attempt')
  assert.equal(missingFinish.finishedAt, null)
})

test('latest matching attempt and newest fallback execution drive the same current-result display', () => {
  const item = {id: 'keyword'}
  const executions = [
    {id: 'new', itemIds: [item.id], status: 'failed', created_at: '2026-09-09T05:38:00+08:00'},
    {id: 'old', itemIds: [item.id], status: 'completed', created_at: '2026-09-09T05:33:00+08:00'},
  ]
  const current = orchestrationCurrentExecution(item, executions)
  assert.equal(current.id, 'new')
  const attempts = [
    {item_id: item.id, execution_task_id: 'new', attempt_number: 3, assignment_revision: 2, started_at: '2026-09-09T05:38:20+08:00', finished_at: '2026-09-09T05:38:40+08:00'},
    {item_id: 'other-item', execution_task_id: 'new', attempt_number: 4, started_at: '2026-09-09T05:40:00+08:00', finished_at: '2026-09-09T05:41:00+08:00'},
    {item_id: item.id, execution_task_id: 'new', attempt_number: 2, assignment_revision: 1, started_at: '2026-09-09T05:38:01+08:00', finished_at: '2026-09-09T05:38:15+08:00'},
  ]
  assert.equal(orchestrationItemTiming(item, current, attempts).startedAt, attempts[0].started_at)
  assert.equal(orchestrationResultEvidence(item, current).childIncomplete, true)
})

test('reversed fallback item timestamps also suppress the invalid finish', () => {
  const timing = orchestrationItemTiming({id: 'legacy', started_at: '2026-09-09T05:38:15+08:00', finished_at: '2026-09-09T05:34:52+08:00'}, undefined)
  assert.equal(timing.source, 'item')
  assert.equal(timing.finishedAt, null)
  assert.equal(timing.invalidOrder, true)
})
