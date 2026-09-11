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
  // A missing explicitly assigned execution is missing evidence, not permission
  // to replace the current state with a previous successful/failed attempt.
  if (currentId) return executions.find(execution => idOf(execution) === currentId)
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

const SUCCESS_RESULTS = new Set(['completed', 'completed_with_warnings'])
const ENDED_EXECUTIONS = new Set(['completed', 'completed_with_warnings', 'completed_with_failures', 'failed', 'canceled', 'skipped', 'superseded'])
const RELEASED_EXECUTIONS = new Set([...ENDED_EXECUTIONS, 'needs_action', 'interrupted'])

export function orchestrationSearchStepLabel(round, searchPasses = []) {
  const name = {all: '综合', image: '图文', video: '视频'}[searchPasses[round - 1]]
  return `第 ${round} 步${name ? `（${name}）` : ''}`
}

export function orchestrationResultEvidence(item, execution, expectedSearchPasses = 1, searchPasses = []) {
  const checkpoint = resultObject(execution?.checkpoint)
  const itemCheckpoint = resultObject(item.metadata?.checkpoint)
  const itemError = resultObject(item.error)
  const keyword = String(item.keyword || item.metadata?.keyword || '')
  const currentSteps = (Array.isArray(checkpoint.keywordResults) ? checkpoint.keywordResults : []).map(resultObject)
    .filter(step => !keyword || step.keyword === keyword)
  const retainedSteps = (Array.isArray(itemCheckpoint.searchPassResults) ? itemCheckpoint.searchPassResults : []).map(resultObject)
    .filter(step => !keyword || !step.keyword || step.keyword === keyword)
  const rounds = new Map()
  // A resumed execution can retain an earlier successful pass in the item
  // checkpoint. Its current pass result supersedes the old result for that pass.
  for (const source of [retainedSteps, currentSteps]) {
    const latest = new Map()
    for (const step of source) {
      const round = Number(step.round || 1)
      if (!Number.isInteger(round) || round < 1) continue
      const previous = latest.get(round)
      const previousTime = resultTimestamp(previous?.finishedAt || previous?.updatedAt)
      const nextTime = resultTimestamp(step.finishedAt || step.updatedAt)
      if (!previous || !previousTime || !nextTime || nextTime >= previousTime) latest.set(round, step)
    }
    for (const [round, step] of latest) rounds.set(round, step)
  }
  const steps = [...rounds.entries()].sort(([left], [right]) => left - right).map(([, step]) => step)
  const completedRounds = new Set(steps.filter(step => SUCCESS_RESULTS.has(String(step.status))).map(step => Number(step.round || 1)))
  const completion = resultObject(itemCheckpoint.searchPassCompletion || (!SUCCESS_RESULTS.has(String(item.status)) ? itemError.searchPassCompletion : null))
  const expected = Math.max(1, Math.min(20, Math.floor(Number(completion.expected) || Number(expectedSearchPasses) || 1)))
  for (const round of Array.isArray(completion.completed) ? completion.completed : []) {
    if (Number.isInteger(round) && round > 0 && round <= expected && !rounds.has(round)) completedRounds.add(round)
  }
  const reportedMissing = !SUCCESS_RESULTS.has(String(item.status)) && Array.isArray(completion.missing)
    ? completion.missing.filter(round => Number.isInteger(round) && round > 0 && round <= expected)
    : []
  const missingRounds = Array.from({length: expected}, (_, index) => index + 1)
    .filter(round => !completedRounds.has(round) || reportedMissing.includes(round))
  const failedSteps = steps.filter(step => ['failed', 'partial'].includes(String(step.status)))
  const sync = resultSyncEvidence(execution?.progress)
  const missingCompletedSteps = item.item_type === 'keyword' && expected > 1 && (steps.length > 0 || reportedMissing.length > 0) && missingRounds.length > 0
  const recovered = SUCCESS_RESULTS.has(String(item.status)) && completedRounds.size >= expected && failedSteps.length === 0
  return {
    steps,
    childIncomplete: !recovered && ['failed', 'completed_with_failures', 'needs_action', 'interrupted'].includes(String(execution?.status)),
    failedStepCount: failedSteps.length,
    completedStepCount: completedRounds.size,
    missingCompletedSteps,
    unfinishedStepLabels: missingCompletedSteps ? missingRounds.map(round => orchestrationSearchStepLabel(round, searchPasses)) : failedSteps.map(step => orchestrationSearchStepLabel(Number(step.round || 1), searchPasses)),
    syncNeedsReview: (sync.failed ?? 0) > 0 || (sync.remaining ?? 0) > 0,
  }
}

export function orchestrationResultRecovery(item, execution, {parentStatus = '', automaticRecovery = false, now = Date.now(), evidence = orchestrationResultEvidence(item, execution)} = {}) {
  const status = String(item.status || '')
  const executionStatus = String(execution?.status || '')
  const error = resultObject(item.error)
  const recovery = resultObject(resultObject(item.metadata?.checkpoint).recovery || error.recovery)
  const incomplete = evidence.childIncomplete || evidence.failedStepCount > 0 || evidence.missingCompletedSteps || evidence.syncNeedsReview
  const resolved = SUCCESS_RESULTS.has(status) && !incomplete
  const currentError = SUCCESS_RESULTS.has(status) && !evidence.childIncomplete && evidence.failedStepCount === 0 && !evidence.missingCompletedSteps
    ? '' : resultMessage(item.error) || resultMessage(execution?.error)
  const answer = (state, label, message = '') => ({state, label, message, currentError})
  if (resolved) return answer('completed', '已完成')
  if (status === 'canceled' || status === 'skipped') return answer('stopped', status === 'canceled' ? '已取消' : '已跳过')
  if (status === 'needs_action') {
    const safety = /captcha|security[_ -]?(?:challenge|blocked)|platform[_ -]?safety|login[_ -]?required|auth[_ -]?required|验证码|安全验证|重新登录/iu.test(`${error.code || ''} ${error.category || ''} ${currentError}`)
    return answer(safety ? 'verification' : 'manual', safety ? '需完成平台验证' : '需人工处理', safety ? '请在对应节点完成平台验证；恢复以服务端确认后的状态为准。' : '当前工作项等待人工处理，尚未进入自动恢复队列。')
  }
  if (status === 'failed') {
    const exhausted = error.recoveryLimitReached === true
    return answer(exhausted ? 'exhausted' : 'failed', exhausted ? '重试次数已用尽' : '执行失败', '已采集结果保留；当前没有正在执行的恢复任务。')
  }
  if (ENDED_EXECUTIONS.has(String(parentStatus))) return answer('unfinished', '未完成', '该批次已结束，当前未自动排队。')
  const parentActive = ['pending', 'assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'claimed', 'running', 'recovering', 'resume_requested', 'needs_action', 'interrupted'].includes(String(parentStatus))
  if (status === 'retryable') {
    if (!automaticRecovery || !parentActive) return answer('manual', '等待恢复', '当前未自动排队。')
    if (item.execution_task_id && !execution) return answer('blocked', '等待执行记录核对', '来源执行记录缺失，尚不能确认已释放给其他节点。')
    if (execution && !RELEASED_EXECUTIONS.has(executionStatus)) return answer('blocked', '等待原执行结算', '原执行尚未结束，暂未重新派发。')
    const commandStatus = String(execution?.blocking_command_status || execution?.command_status || '')
    const commandId = String(execution?.blocking_command_id || execution?.command_id || execution?.commandId || '')
    const expiresAt = resultTimestamp(execution?.command_expires_at)
    if (commandId && ['pending', 'acknowledged'].includes(commandStatus) && (!expiresAt || expiresAt > now)) {
      return answer('blocked', '等待原指令结算', '原指令尚未结算，暂未重新派发。')
    }
    return answer('queued', '等待恢复分配', '工作项已释放，等待兼容的空闲节点领取；尚未派发。')
  }
  if (['running', 'recovering'].includes(status) && ['running', 'recovering'].includes(executionStatus)) return answer('running', Number(item.attempt_count) > 1 || Object.keys(recovery).length ? '恢复执行中' : '执行中', '当前节点正在执行，未完成步骤仍需后续结果确认。')
  if (['assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'claimed', 'resume_requested'].includes(status) && execution && !RELEASED_EXECUTIONS.has(executionStatus)) {
    return answer('assigned', '已分配，等待执行回报', '已有对应节点执行记录，完成情况以节点回报为准。')
  }
  if (status === 'pending' && parentActive) return answer('queued', '等待分配', '工作项尚未开始执行。')
  return answer('unfinished', '未完成', '尚未确认恢复排队或执行状态。')
}
