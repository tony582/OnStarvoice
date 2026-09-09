export function resultObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function resultCount(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function resultDuration(start, end) {
  if (!start || !end) return '未记录'
  const seconds = Math.floor((Date.parse(end) - Date.parse(start)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return '时间记录不完整'
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
}

export function resultMessage(value) {
  if (typeof value === 'string') return value.trim()
  const source = resultObject(value)
  return String(source.message || source.reason || source.code || '').trim()
}

export function taskResultKind(task) {
  if (task.metadata?.orchestrationTemplate === true) return '无人值守计划'
  if (task.metadata?.orchestrationScheduleRun === true) return '无人值守运行批次'
  const type = `${task.task_type || ''} ${task.feature_key || ''}`
  if (type.includes('negative_post_patrol')) return '负面内容巡查'
  if (type.includes('watched_content_patrol')) return '关注内容复查'
  if (type.includes('comment_patrol')) return '评论巡查'
  if (type.includes('followed_creator')) return '关注博主巡查'
  if (type.includes('official_account_post_discovery')) return '官方账号内容发现'
  if (type.includes('keyword') || type.includes('search')) return '关键词采集'
  if (type.includes('capture_orchestration')) return '多节点采集'
  if (type.includes('detail') || type.includes('targeted_post')) return '内容详情采集'
  return '采集任务'
}

export function historicalItemStatus(status) {
  return ['pending', 'assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'claimed', 'running', 'recovering', 'retryable', 'resume_requested'].includes(status)
    ? '结束时未完成'
    : ''
}

export function resultTiming({createdAt, startedAt, finishedAt}) {
  return {
    label: startedAt ? '执行耗时' : '总用时',
    source: startedAt ? 'started_at' : createdAt ? 'created_at' : null,
    duration: resultDuration(startedAt || createdAt, finishedAt),
  }
}

export function resultSyncEvidence(progress) {
  const source = resultObject(progress)
  const known = source.streamingSyncEvidenceKnown === true
  const failed = resultCount(source.streamingSyncFailedCount)
  const remaining = resultCount(source.streamingSyncRemainingCount)
  return {
    known, failed, remaining,
    outcome: !known ? 'unknown'
      : source.streamingSyncDrainCompleted === true && failed === 0 && remaining === 0 ? 'reported_drained' : 'needs_review',
  }
}

export function orchestrationCurrentExecution(item, executions) {
  const idOf = execution => String(execution.taskId || execution.task_id || execution.id || '')
  const currentId = String(item.execution_task_id || '')
  const exact = currentId ? executions.find(execution => idOf(execution) === currentId) : undefined
  if (exact) return exact
  return executions.map((execution, index) => ({execution, index}))
    .filter(({execution}) => execution.status !== 'superseded'
      && (execution.itemIds || execution.item_ids || []).includes(item.id))
    .sort((left, right) => resultTimestamp(right.execution.created_at) - resultTimestamp(left.execution.created_at)
      || right.index - left.index)[0]?.execution
}

function resultTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(timestamp) ? timestamp : 0
}

function recordedTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function sameSourceTiming(record, source) {
  const startedAt = recordedTime(record?.started_at)
  const recordedEnd = recordedTime(record?.finished_at)
  const reversed = Boolean(startedAt && recordedEnd && Date.parse(recordedEnd) < Date.parse(startedAt))
  return {
    source, startedAt, finishedAt: reversed ? null : recordedEnd,
    invalidOrder: reversed,
    note: reversed ? '该次记录的结束时间早于开始时间，结束时间暂不展示；节点执行时间可在下方单独查看。' : '',
  }
}

export function orchestrationItemTiming(item, execution, attempts = []) {
  const executionId = String(execution?.taskId || execution?.task_id || execution?.id || item.execution_task_id || '')
  // An attempt must belong to both this item and this execution. Never borrow a
  // previous attempt's finish time to complete the current attempt's timeline.
  const attempt = executionId ? attempts.filter(candidate =>
    String(candidate.itemId || candidate.item_id || '') === String(item.id || '')
    && String(candidate.execution_task_id || candidate.taskId || candidate.task_id || '') === executionId)
    .sort((left, right) => Number(right.attempt_number || 0) - Number(left.attempt_number || 0)
      || Number(right.assignment_revision || 0) - Number(left.assignment_revision || 0)
      || resultTimestamp(right.created_at) - resultTimestamp(left.created_at)
      || String(right.id || '').localeCompare(String(left.id || '')))[0] : undefined
  const attemptTiming = attempt ? sameSourceTiming(attempt, 'attempt') : null
  if (attemptTiming?.startedAt && attemptTiming.finishedAt) return attemptTiming

  const executionTiming = execution ? sameSourceTiming(execution, 'execution') : null
  if (executionTiming?.startedAt && executionTiming.finishedAt) return attemptTiming?.invalidOrder
    ? {...executionTiming, invalidOrder: true, note: '工作项时间记录异常，显示对应节点执行时间。'}
    : executionTiming
  if (attemptTiming?.invalidOrder) return attemptTiming
  if (executionTiming?.invalidOrder) return executionTiming
  if (attemptTiming && (attemptTiming.startedAt || attemptTiming.finishedAt)) return attemptTiming
  if (executionTiming && (executionTiming.startedAt || executionTiming.finishedAt)) return executionTiming
  return sameSourceTiming(item, 'item')
}

export function orchestrationResultEvidence(item, execution, expectedSearchPasses = 1) {
  const checkpoint = resultObject(execution?.checkpoint)
  const steps = (Array.isArray(checkpoint.keywordResults) ? checkpoint.keywordResults : []).map(resultObject)
    .filter(step => !item.keyword || step.keyword === item.keyword)
  const completedRounds = new Set(steps.filter(step => ['completed', 'completed_with_warnings'].includes(String(step.status))).map(step => Number(step.round || 1)))
  const failedSteps = steps.filter(step => ['failed', 'partial'].includes(String(step.status)))
  const sync = resultSyncEvidence(execution?.progress)
  return {
    steps,
    childIncomplete: ['failed', 'completed_with_failures', 'needs_action', 'interrupted'].includes(String(execution?.status)),
    failedStepCount: failedSteps.length,
    completedStepCount: completedRounds.size,
    missingCompletedSteps: item.item_type === 'keyword' && expectedSearchPasses > 1 && steps.length > 0 && completedRounds.size < expectedSearchPasses,
    syncNeedsReview: (sync.failed ?? 0) > 0 || (sync.remaining ?? 0) > 0,
  }
}
