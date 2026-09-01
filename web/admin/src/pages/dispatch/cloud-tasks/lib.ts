export type CaptureEnhancementSettings = {
  autoDetailCaptureAfterListCapture?: boolean
  autoSyncAfterDetailCapture?: boolean
  enableAiRelevancePrefilter?: boolean
  includeBloggerMetricsOnDetailCapture?: boolean
  enableLowFollowerHitFilterOnDetailCapture?: boolean
  lowFollowerHitThresholdOnDetailCapture?: number
  includeCommentsOnDetailCapture?: boolean
  detailCommentsMaxDetectedItems?: number
  enableCommentLeadsFilterOnDetailCapture?: boolean
  skipAlreadyCapturedOnDetailCapture?: boolean
}

export type UnattendedPlan = {
  configured?: boolean
  enabled?: boolean
  platform?: string
  mode?: string
  startTime?: string
  randomOffsetMin?: number
  customDates?: string | string[]
  keywords?: string[]
  keywordCount?: number
  searchFilters?: {
    sort?: string
    publishTime?: string
    contentType?: string
    searchScope?: string
    distance?: string
    videoDuration?: string
  }
  searchPasses?: string[]
  recoveryPolicy?: {
    allowIdleAgentHandoff?: boolean
    platformSafetyMode?: string
    disableAutomaticSearchRetry?: boolean
    requireVerifiedFilters?: boolean
  }
  captureSettings?: CaptureEnhancementSettings
  keywordMaxDetectedItems?: number
  maxRounds?: number
  roundGapMin?: number
  nextRunAt?: string | null
  lastRunAt?: string | null
  lastRunStatus?: string
  lastRunMessage?: string
  updatedAt?: string | null
}

export type CloudAgent = {
  id: string
  client_uuid: string
  client_label: string
  display_name: string
  host_label: string
  browser_name: string
  operating_system: string
  app_version: string
  allowed_platforms: string[]
  capabilities?: Record<string, unknown>
  unattended_plan?: UnattendedPlan | null
  unattended_plan_updated_at?: string | null
  status: 'active' | 'paused' | 'migrated' | 'revoked'
  last_heartbeat_at?: string | null
  last_error?: string
  online: boolean
  active_task_count?: number
  queued_task_count?: number
}

export type CloudTask = {
  id: string
  parent_task_id?: string | null
  assigned_agent_id?: string | null
  origin_agent_id?: string | null
  client_task_id: string
  control_task_id: string
  task_type: string
  feature_key?: string
  source?: string
  title: string
  platform: string
  status: string
  effective_status?: string
  progress?: Record<string, unknown>
  checkpoint?: Record<string, unknown>
  counts?: Record<string, unknown>
  metadata?: Record<string, unknown>
  message?: string
  error?: Record<string, unknown>
  attempt_number?: number
  orchestration_revision?: number
  heartbeat_at?: string | null
  business_progress_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  finished_at?: string | null
  attention_dismissed_at?: string | null
  attention_dismissed_by_user_id?: string | null
  attention_dismissed_by_name?: string
  agent_display_name?: string
  agent_host_label?: string
  agent_online?: boolean
  agent_last_heartbeat_at?: string | null
  pending_command_id?: string | null
  pending_command_type?: 'create' | 'resume' | 'stop' | null
  pending_command_status?: string | null
  pending_command_created_at?: string | null
  pending_command_expires_at?: string | null
  agent_status?: CloudAgent['status'] | null
  agent_capabilities?: Record<string, unknown> | null
  agent_allowed_platforms?: string[] | null
  resume_block_reason?: string
}

export type TaskKeywordResult = {
  round: number
  index: number
  keyword: string
  status: string
  noResults: boolean
  resultKind: string
  attemptCount: number
  savedCount: number
  error: string
  errorCode: string
  errorCategory: string
  securityBlocked: boolean
  requiresManualAction: boolean
  finishedAt: string
}

export type TaskKeywordFailureKind =
  | 'safety'
  | 'search_unavailable'
  | 'enhancement'
  | 'network'
  | 'other'

export type TaskDiagnostics = {
  items: TaskKeywordResult[]
  total: number
  processed: number
  completed: number
  partial: number
  failed: number
  skipped: number
  noResults: number
  saved: number
  retried: number
  currentKeyword: string
  currentOrdinal: number
  currentPhase: string
  lastFinishedAt: string
  safetyBlocked: number
  searchUnavailable: number
  enhancementFailed: number
  networkFailed: number
  otherFailed: number
  headline: string
  explanation: string
  tone: 'success' | 'warning' | 'danger' | 'active' | 'neutral'
  retryLimit: number
  retryExhausted: boolean
}

export type TaskView = 'active' | 'attention' | 'plans' | 'history'
export type ComposerIntent = {
  agentId?: string
  mode?: 'one_time' | 'unattended_plan'
  taskType?: 'comment_patrol' | 'creator_patrol' | 'negative_patrol' | 'watched_content'
  recordIds?: string[]
  subscriptionId?: string
  officialAccountId?: string
  editExisting?: boolean
}

export type CloudCreateTaskType =
  | 'keyword'
  | 'unattended_plan'
  | 'creator_patrol'
  | 'negative_patrol'
  | 'watched_content'
  | 'comment_patrol'

export type Overview = {
  agents: CloudAgent[]
  tasks: CloudTask[]
  summary: {
    agents: number
    onlineAgents: number
    runningTasks: number
    attentionTasks: number
    historyTasks?: number
    aiActive?: number
    aiQueued?: number
    aiConcurrencyLimit?: number
  }
}

export type TaskHistoryResponse = {
  ok: true
  tasks: CloudTask[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
  filters?: {
    q?: string
    platform?: string
    status?: string
    from?: string
    to?: string
    days?: number
  }
}

export const PLATFORM_LABELS: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  weibo: '微博',
  mixed: '小红书＋抖音',
  unknown: '未识别',
}

export const STATUS_LABELS: Record<string, string> = {
  pending: '等待执行',
  waiting_device: '等待设备',
  claimed: '已认领',
  running: '运行中',
  recovering: '恢复中',
  interrupted: '已中断',
  resume_requested: '已请求继续',
  needs_action: '需要处理',
  completed: '已完成',
  completed_with_warnings: '完成有警告',
  completed_with_failures: '部分失败',
  failed: '失败',
  canceled: '已取消',
  skipped: '已跳过',
  superseded: '已转入恢复任务',
  // 编排任务/工作项专属状态（编排详情使用，普通任务不会出现）
  draft: '草稿',
  assigned: '已分配',
  dispatch_pending: '等待下发',
  dispatched: '已下发',
  retryable: '等待重试',
}

export const PLAN_MODE_LABELS: Record<string, string> = {
  daily: '每天',
  custom_dates: '指定日期',
}

export const SORT_OPTIONS = [
  { value: 'comprehensive', label: '综合排序' },
  { value: 'latest', label: '最新发布' },
  { value: 'likes', label: '最多点赞' },
  { value: 'comments', label: '最多评论', platform: 'xiaohongshu' },
  { value: 'collects', label: '最多收藏', platform: 'xiaohongshu' },
]

export const PUBLISH_TIME_OPTIONS = [
  { value: 'all', label: '不限时间' },
  { value: 'day', label: '一天内' },
  { value: 'week', label: '一周内' },
  { value: 'halfyear', label: '半年内' },
]

export function safeNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

export function normalizeCloudTaskDate(value = '') {
  const match = String(value).trim().match(/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/)
  if (!match) return ''

  const year = Number(match[1])
  const month = Number(match[3])
  const day = Number(match[4])
  if (year < 1000 || month < 1 || month > 12 || day < 1) return ''

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day > daysInMonth) return ''

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function normalizeCloudTaskDateList(value: unknown = '') {
  const source = Array.isArray(value) ? value.join('\n') : String(value ?? '')
  const sourceDates = source.split(/[\s,，;；]+/g).map(item => item.trim()).filter(Boolean)
  const normalizedDates = sourceDates.map(sourceDate => ({
    sourceDate,
    normalizedDate: normalizeCloudTaskDate(sourceDate),
  }))

  return {
    dates: Array.from(new Set(normalizedDates.map(item => item.normalizedDate).filter(Boolean))),
    invalidDates: normalizedDates.filter(item => !item.normalizedDate).map(item => item.sourceDate),
  }
}

export function shanghaiToday(reference = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(reference)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function localDateKey(date: Date) {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

export function unattendedPlanDates(plan?: UnattendedPlan | null) {
  if (!plan || String(plan.mode || '') !== 'custom_dates') return []
  return normalizeCloudTaskDateList(plan.customDates).dates.slice().sort()
}

export function isUnattendedPlanEnded(
  plan?: UnattendedPlan | null,
  reference = new Date(),
) {
  if (!hasConfiguredUnattendedPlan(plan) || String(plan?.mode || '') !== 'custom_dates') {
    return false
  }

  const nextRunAt = Date.parse(String(plan?.nextRunAt || ''))
  if (Number.isFinite(nextRunAt) && nextRunAt > reference.getTime()) return false

  const dates = unattendedPlanDates(plan)
  if (dates.length === 0) return false
  const today = localDateKey(reference)
  const latestDate = dates[dates.length - 1]
  if (latestDate < today) return true
  if (latestDate > today) return false

  const timeMatch = String(plan?.startTime || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!timeMatch) return false
  const scheduled = new Date(reference)
  scheduled.setHours(Number(timeMatch[1]), Number(timeMatch[2]), 0, 0)
  return reference.getTime() > scheduled.getTime()
}

export function formatTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

export function taskProgress(task: CloudTask) {
  const progress = task.progress || {}
  const counts = task.counts || {}
  const current = safeNumber(progress.current ?? progress.index ?? counts.processed)
  const total = safeNumber(progress.total ?? counts.total)
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
  return { current, total, percent }
}

function diagnosticText(...values: unknown[]) {
  for (const value of values) {
    const resolved = String(value ?? '').trim()
    if (resolved) return resolved
  }
  return ''
}

function diagnosticBoolean(...values: unknown[]) {
  return values.some(value => value === true || value === 'true')
}

export function taskKeywordResults(task: CloudTask): TaskKeywordResult[] {
  const checkpoint = task.checkpoint || {}
  const rawItems = Array.isArray(checkpoint.keywordResults)
    ? checkpoint.keywordResults
    : []

  return rawItems
    .map((value, fallbackIndex) => {
      const item = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {}
      const rawError = item.error && typeof item.error === 'object'
        ? item.error as Record<string, unknown>
        : {}
      const parsedIndex = Number(item.index)
      const parsedRound = safeNumber(item.round)
      return {
        round: parsedRound > 0 ? parsedRound : 1,
        index: Number.isFinite(parsedIndex) ? Math.max(0, Math.floor(parsedIndex)) : fallbackIndex,
        keyword: diagnosticText(item.keyword),
        status: diagnosticText(item.status, 'failed').toLowerCase(),
        noResults: diagnosticBoolean(
          item.noResults,
          item.no_results,
          item.emptyResult,
          item.empty_result,
        ) || ['no_matching_results', 'no_search_results'].includes(
          diagnosticText(item.resultKind, item.result_kind),
        ),
        resultKind: diagnosticText(item.resultKind, item.result_kind),
        attemptCount: safeNumber(item.attemptCount ?? item.attempt_count),
        savedCount: safeNumber(item.savedCount ?? item.saved_count),
        error: diagnosticText(rawError.message, item.error),
        errorCode: diagnosticText(item.errorCode, item.error_code, rawError.code),
        errorCategory: diagnosticText(item.errorCategory, item.error_category, rawError.category),
        securityBlocked: diagnosticBoolean(
          item.securityBlocked,
          item.security_blocked,
          item.platformSafetyBlocked,
          item.platform_safety_blocked,
          rawError.securityBlocked,
          rawError.platformSafetyBlocked,
        ),
        requiresManualAction: diagnosticBoolean(
          item.requiresManualAction,
          item.requires_manual_action,
          rawError.requiresManualAction,
        ),
        finishedAt: diagnosticText(item.finishedAt, item.finished_at),
      }
    })
    .filter(item => item.keyword)
    .sort((left, right) => left.round - right.round || left.index - right.index)
}

export function taskKeywordFailureKind(item: TaskKeywordResult): TaskKeywordFailureKind {
  const evidence = [item.errorCode, item.errorCategory, item.error].join(' ')
  if (
    item.securityBlocked ||
    item.requiresManualAction ||
    /(platform_safety_block|security_verification|required|page_challenge|xhs_security_block|http_?429|rate_?limited|captcha|risk.?control|账号异常|账号限制|平台安全|安全限制|安全审核|安全验证|访问频繁|访问受限|验证码|风控)/iu.test(evidence)
  ) {
    return 'safety'
  }
  if (/(采集增强|增强采集|增强未完整|详情采集|评论采集|博主数据|enhance|detail.?capture|comment.?capture)/iu.test(evidence)) {
    return 'enhancement'
  }
  if (/(搜索结果页未就绪|搜索页未就绪|服务出现异常|搜索服务异常|douyin_search_service_abnormal|search.*(?:not.?ready|unavailable)|结果页.*未加载)/iu.test(evidence)) {
    return 'search_unavailable'
  }
  if (/(network|net::|timeout|timed.?out|网络|连接失败|请求超时|设备离线)/iu.test(evidence)) {
    return 'network'
  }
  return 'other'
}

export function taskPhaseLabel(phase = '') {
  const normalized = String(phase || '').trim().toLowerCase()
  const labels: Record<string, string> = {
    pending: '等待执行',
    opening_search: '打开搜索页',
    reading_search: '读取搜索结果',
    list_capture: '列表采集',
    filtering: '筛选搜索结果',
    enhancement: '增强采集',
    detail_capture: '增强采集',
    comments: '评论采集',
    syncing: '同步后台',
    retrying: '等待重试',
    needs_action: '等待人工处理',
    platform_safety_block: '等待人工安全验证',
    no_matching_results: '筛选范围内无匹配内容',
    no_search_results: '无搜索结果',
    failed: '执行失败',
    partial: '部分完成',
    completed: '执行完成',
    unattended_completed_with_failures: '已完成全部尝试',
  }
  return labels[normalized] || normalized.replace(/_/g, ' ') || '—'
}

const PLATFORM_SAFETY_EVIDENCE_PATTERN =
  /(platform_safety_block|security_verification|page_challenge|xhs_security_block|douyin_search_security_challenge|http_?429|rate_?limited|captcha|login.?required|auth.?required|risk.?control|登录失效|请(?:先|重新)?登录|账号异常|账号限制|平台安全|安全限制|安全审核|安全验证|访问频繁|访问受限|验证码|风控)/iu

export function isPlatformSafetyAttention(task: CloudTask) {
  const status = String(task.effective_status || task.status || '').toLowerCase()
  if (!['interrupted', 'needs_action', 'failed', 'completed_with_failures'].includes(status)) {
    return false
  }

  const error = task.error || {}
  const progress = task.progress || {}
  const checkpoint = task.checkpoint || {}
  const explicitSafetyFlag = diagnosticBoolean(
    error.securityBlocked,
    error.security_blocked,
    error.platformSafetyBlocked,
    error.platform_safety_blocked,
    error.requiresManualAction,
    error.requires_manual_action,
    progress.securityBlocked,
    progress.security_blocked,
    progress.platformSafetyBlocked,
    progress.platform_safety_blocked,
    progress.requiresManualAction,
    progress.requires_manual_action,
    checkpoint.securityBlocked,
    checkpoint.security_blocked,
    checkpoint.platformSafetyBlocked,
    checkpoint.platform_safety_blocked,
    checkpoint.requiresManualAction,
    checkpoint.requires_manual_action,
  )
  const evidence = [
    error.code,
    error.category,
    error.message,
    error.reason,
    progress.errorCode,
    progress.errorCategory,
    checkpoint.errorCode,
    checkpoint.errorCategory,
    task.message,
  ].map(value => String(value ?? '').trim()).filter(Boolean).join(' ')

  return explicitSafetyFlag ||
    PLATFORM_SAFETY_EVIDENCE_PATTERN.test(evidence) ||
    taskKeywordResults(task).some(item => taskKeywordFailureKind(item) === 'safety')
}

export function platformSafetyReason(task: CloudTask) {
  const error = task.error || {}
  const codeAndCategory = [
    error.code,
    error.category,
    task.progress?.errorCode,
    task.progress?.errorCategory,
  ].map(value => String(value ?? '').trim()).filter(Boolean).join(' ')
  if (/(douyin_search_security_challenge|security_verification|page_challenge|captcha|验证码|安全验证)/iu.test(codeAndCategory)) {
    return task.platform === 'douyin'
      ? '抖音页面要求完成人工安全验证'
      : '平台页面要求完成人工安全验证'
  }
  if (/(login|required|登录)/iu.test(codeAndCategory)) return '当前账号需要重新登录或确认账号状态'
  if (/(http_?429|rate_?limited|访问频繁)/iu.test(codeAndCategory)) return '平台提示访问过于频繁'

  return diagnosticText(error.message, error.reason, task.message, '平台要求人工确认账号或安全验证')
}

export function taskDiagnostics(task: CloudTask): TaskDiagnostics {
  const items = taskKeywordResults(task)
  const progress = taskProgress(task)
  const checkpoint = task.checkpoint || {}
  const counts = task.counts || {}
  const metadata = task.metadata || {}
  const terminalStatuses = new Set(['completed', 'partial', 'failed', 'skipped', 'canceled'])
  const hasKeywordCheckpoint = items.length > 0
  // Extension may stop between keywords before the current keyword checkpoint
  // has settled. Keep the original plan total instead of shrinking the task to
  // only the entries that happened to reach keywordResults.
  const keywordTotal = Math.max(items.length, progress.total, safeNumber(counts.total))
  const processedFromItems = items.filter(item => terminalStatuses.has(item.status)).length
  const processed = hasKeywordCheckpoint
    ? processedFromItems
    : Math.max(progress.current, safeNumber(counts.processed))
  const completedFromItems = items.filter(item => item.status === 'completed').length
  const partialFromItems = items.filter(item => item.status === 'partial').length
  const completed = hasKeywordCheckpoint ? completedFromItems : safeNumber(counts.success)
  const partial = hasKeywordCheckpoint ? partialFromItems : safeNumber(counts.warnings)
  const failedItems = items.filter(item => item.status === 'failed')
  const partialItems = items.filter(item => item.status === 'partial')
  const abnormalItems = [...failedItems, ...partialItems]
  const failed = hasKeywordCheckpoint ? failedItems.length : safeNumber(counts.failed)
  const skippedFromItems = items.filter(item => item.status === 'skipped').length
  const skipped = hasKeywordCheckpoint ? skippedFromItems : safeNumber(counts.skipped)
  const noResults = items.filter(item => item.status === 'completed' && item.noResults).length
  const noSearchResults = items.filter(item =>
    item.status === 'completed' && item.resultKind === 'no_search_results'
  ).length
  const savedFromItems = items.reduce((sum, item) => sum + item.savedCount, 0)
  const retriesFromItems = items.reduce((sum, item) => sum + Math.max(0, item.attemptCount - 1), 0)
  const currentKeyword = diagnosticText(
    task.progress?.keyword,
    task.progress?.currentKeyword,
    checkpoint.currentKeyword,
    checkpoint.activeKeyword,
    items[items.length - 1]?.keyword,
  )
  const currentItem = items.find(item => item.keyword === currentKeyword)
  const checkpointKeywordIndex = Number(checkpoint.activeKeywordIndex ?? checkpoint.keywordIndex)
  const currentOrdinal = currentItem
    ? Math.min(currentItem.index + 1, Math.max(keywordTotal, 1))
    : Number.isFinite(checkpointKeywordIndex)
      ? Math.min(Math.max(0, Math.floor(checkpointKeywordIndex)) + 1, Math.max(keywordTotal, 1))
      : progress.current > 0
        ? Math.min(progress.current, Math.max(keywordTotal, 1))
        : 0
  const failureKinds = abnormalItems.reduce<Record<TaskKeywordFailureKind, number>>((summary, item) => {
    summary[taskKeywordFailureKind(item)] += 1
    return summary
  }, {
    safety: 0,
    search_unavailable: 0,
    enhancement: 0,
    network: 0,
    other: 0,
  })
  const retryLimit = safeNumber(
    metadata.maxRecoveryAttempts ??
    metadata.maxAttempts ??
    checkpoint.maxRecoveryAttempts ??
    checkpoint.maxAttempts,
  ) || 2
  const terminalTask = [
    'completed', 'completed_with_warnings', 'completed_with_failures',
    'failed', 'canceled', 'skipped',
  ].includes(task.status)
  const retryExhausted = terminalTask &&
    failedItems.length > 0 &&
    failedItems.every(item => item.attemptCount >= retryLimit)
  const platformSafetyAttention = isPlatformSafetyAttention(task)
  const safetyBlocked = failureKinds.safety > 0
    ? failureKinds.safety
    : platformSafetyAttention
      ? 1
      : 0

  let headline: string
  let explanation: string
  let tone: TaskDiagnostics['tone'] = 'neutral'
  const taskIsActive = ['pending', 'waiting_device', 'claimed', 'running', 'recovering', 'resume_requested']
    .includes(task.effective_status || task.status)

  if (taskIsActive && currentKeyword) {
    headline = `正在处理 ${currentOrdinal || 1}/${Math.max(keywordTotal, 1)} · ${currentKeyword}`
    explanation = `当前阶段：${taskPhaseLabel(diagnosticText(task.progress?.phase, checkpoint.activePhase, checkpoint.phase))}`
    tone = 'active'
  } else if (safetyBlocked > 0) {
    const position = currentKeyword && currentOrdinal > 0
      ? ` · 停在 ${currentOrdinal}/${Math.max(keywordTotal, 1)}「${currentKeyword}」`
      : ''
    headline = `${platformSafetyReason(task)}${position}`
    explanation = '自动操作已保护性停止；请先在原 Agent 完成人工验证，再继续剩余关键词。'
    tone = 'danger'
  } else if (failed > 0) {
    const causes = [
      failureKinds.search_unavailable > 0 ? `搜索页未就绪 ${failureKinds.search_unavailable}` : '',
      failureKinds.enhancement > 0 ? `增强未完整 ${failureKinds.enhancement}` : '',
      failureKinds.network > 0 ? `网络异常 ${failureKinds.network}` : '',
      failureKinds.other > 0 ? `其他异常 ${failureKinds.other}` : '',
    ].filter(Boolean)
    headline = `未检测到明确风控 · ${causes.join(' · ') || `失败 ${failed}`}`
    explanation = retryExhausted
      ? `失败关键词均已达到 ${retryLimit} 次尝试上限；继续原任务不会产生新的采集进展。`
      : '可在关键词明细中查看失败位置、尝试次数和设备返回的原始原因。'
    tone = 'warning'
  } else if (partial > 0) {
    const causes = [
      failureKinds.search_unavailable > 0 ? `搜索页未就绪 ${failureKinds.search_unavailable}` : '',
      failureKinds.enhancement > 0 ? `增强未完整 ${failureKinds.enhancement}` : '',
      failureKinds.network > 0 ? `网络异常 ${failureKinds.network}` : '',
      failureKinds.other > 0 ? `其他异常 ${failureKinds.other}` : '',
    ].filter(Boolean)
    headline = `${partial} 个关键词只完成了部分采集${causes.length > 0 ? ` · ${causes.join(' · ')}` : ''}`
    explanation = '列表结果已保留，增强、评论或同步步骤可能尚未完整。'
    tone = 'warning'
  } else if (items.length > 0 && completed + skipped >= items.length) {
    const capturedCount = Math.max(0, completed - noResults)
    headline = noResults > 0
      ? `${capturedCount} 个关键词采到结果 · ${noSearchResults > 0
        ? `${noSearchResults} 个无搜索结果${noResults > noSearchResults
          ? ` · ${noResults - noSearchResults} 个筛选范围内无匹配内容`
          : ''}`
        : `${noResults} 个筛选范围内无匹配内容`}`
      : `${completed} 个关键词已完整完成`
    explanation = skipped > 0
      ? `另有 ${skipped} 个关键词已按规则跳过。`
      : noResults > 0
        ? '无搜索结果或无匹配内容已按 0 条正常结算，不计入失败或未完成。'
        : '列表与已启用的增强步骤均已结算。'
    tone = 'success'
  } else {
    headline = diagnosticText(task.message, taskErrorText(task), '暂时没有关键词级运行记录')
    explanation = items.length === 0 ? '当前 Extension 尚未上报关键词检查点。' : ''
  }

  return {
    items,
    total: keywordTotal,
    processed,
    completed,
    partial,
    failed,
    skipped,
    noResults,
    saved: Math.max(savedFromItems, safeNumber(counts.saved)),
    retried: Math.max(retriesFromItems, safeNumber(counts.retried)),
    currentKeyword,
    currentOrdinal,
    currentPhase: diagnosticText(task.progress?.phase, checkpoint.activePhase, checkpoint.phase),
    lastFinishedAt: (() => {
      const finishedTimes = items
        .map(item => item.finishedAt)
        .filter(Boolean)
        .sort()
      return finishedTimes[finishedTimes.length - 1] || ''
    })(),
    safetyBlocked,
    searchUnavailable: failureKinds.search_unavailable,
    enhancementFailed: failureKinds.enhancement,
    networkFailed: failureKinds.network,
    otherFailed: failureKinds.other,
    headline,
    explanation,
    tone,
    retryLimit,
    retryExhausted,
  }
}

export function statusTone(status: string) {
  if (['running', 'recovering', 'claimed'].includes(status)) return 'border-primary/25 bg-primary/8 text-primary'
  if (['interrupted', 'needs_action', 'failed', 'completed_with_failures'].includes(status)) return 'border-status-red/25 bg-status-red/8 text-status-red'
  if (status === 'waiting_device' || status === 'resume_requested') return 'border-status-orange/30 bg-status-orange/10 text-amber-700 dark:text-amber-300'
  if (['completed', 'completed_with_warnings', 'superseded'].includes(status)) return 'border-status-green/25 bg-status-green/8 text-status-green'
  return 'border-border bg-muted text-muted-foreground'
}

export function canResume(task: CloudTask) {
  return Boolean(
    task.control_task_id &&
    task.task_type.includes('unattended') &&
    ['interrupted', 'needs_action', 'failed', 'completed_with_failures'].includes(task.status),
  )
}

const CROSS_DEVICE_RETRY_TASK_TYPES = new Set([
  'unattended_keyword_capture',
  'negative_post_patrol',
  'watched_content_patrol',
  'official_account_comment_patrol',
  'followed_creator_post_patrol',
  'official_account_post_discovery',
])

export function canRetryOnIdleAgent(task: CloudTask) {
  if (task.parent_task_id || task.pending_command_id) return false
  if (!['needs_action', 'failed', 'completed_with_failures'].includes(task.status)) return false
  if (task.task_type === 'capture_orchestration') {
    return task.metadata?.promotedRetryParent === true
  }
  return CROSS_DEVICE_RETRY_TASK_TYPES.has(task.task_type)
}

export function automaticIdleAgentRecoveryEnabled(task: CloudTask) {
  const metadata = task.metadata && typeof task.metadata === 'object'
    ? task.metadata
    : {}
  const planSnapshot = metadata.planSnapshot && typeof metadata.planSnapshot === 'object'
    ? metadata.planSnapshot as Record<string, unknown>
    : {}
  const recoveryPolicy = planSnapshot.recoveryPolicy && typeof planSnapshot.recoveryPolicy === 'object'
    ? planSnapshot.recoveryPolicy as Record<string, unknown>
    : {}
  return recoveryPolicy.allowIdleAgentHandoff !== false
}

export function canStop(task: CloudTask) {
  if (task.agent_capabilities?.remoteStop !== true) return false
  const status = task.status
  const activeOrRecoverable = [
    'pending', 'claimed', 'running', 'recovering', 'interrupted',
    'resume_requested', 'needs_action', 'failed', 'completed_with_failures',
  ].includes(status)
  if (!activeOrRecoverable) return false
  if (task.pending_command_type === 'create') return true
  return Boolean(
    task.control_task_id &&
    (task.task_type.includes('unattended') || task.source === 'cloud'),
  )
}

export function resumeBlockReason(task: CloudTask) {
  if (task.resume_block_reason) return task.resume_block_reason
  if (task.agent_status && task.agent_status !== 'active') return '原执行 Agent 已暂停或撤销'
  const platforms = task.agent_allowed_platforms || []
  if (platforms.length > 0 && !platforms.includes(task.platform)) return '原执行 Agent 未配置负责该平台'
  const diagnostics = taskDiagnostics(task)
  if (diagnostics.retryExhausted) return `失败关键词均已达到 ${diagnostics.retryLimit} 次尝试上限，请新建补采任务`
  return ''
}

export function taskErrorText(task: CloudTask) {
  const error = task.error || {}
  return String(error.message || error.reason || error.code || '').trim()
}

export function agentCreatePlatforms(agent: CloudAgent) {
  // 云端 create 命令当前只在小红书、抖音执行链实现；微博仍可上报任务，
  // 但不能从管理端新建，避免设备收到无法执行的指令。
  const allPlatforms = ['xiaohongshu', 'douyin']
  const supportedPlatforms = Array.isArray(agent.capabilities?.supportedPlatforms)
    ? agent.capabilities.supportedPlatforms.map(value => String(value || '').trim()).filter(Boolean)
    : []
  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms.map(value => String(value || '').trim()).filter(Boolean)
    : []
  return allPlatforms.filter(platform =>
    (supportedPlatforms.length === 0 || supportedPlatforms.includes(platform)) &&
    (allowedPlatforms.length === 0 || allowedPlatforms.includes(platform)),
  )
}

export function agentTaskTypeBlockReason(
  agent: CloudAgent,
  taskType: CloudCreateTaskType,
  mode: 'one_time' | 'unattended_plan',
) {
  const genericReason = agentAssignmentBlockReason(agent, mode)
  if (genericReason) return genericReason
  if (['creator_patrol', 'negative_patrol', 'watched_content', 'comment_patrol'].includes(taskType)
    && agent.capabilities?.remoteTargetedPostCaptureV1 !== true) {
    return '客户端扩展版本过低，尚不支持定向页面任务'
  }
  if (taskType === 'creator_patrol' && agent.capabilities?.followedCreatorPostPatrol !== true) {
    return '客户端扩展版本过低，尚不支持关注博主扫描'
  }
  if (taskType === 'negative_patrol' && agent.capabilities?.negativePostPatrol !== true) {
    return '客户端扩展版本过低，尚不支持负面帖子巡查'
  }
  if (taskType === 'watched_content' && agent.capabilities?.watchedContentPatrol !== true) {
    return '客户端扩展版本过低，尚不支持关注内容巡查'
  }
  if (taskType === 'comment_patrol'
    && (agent.capabilities?.officialAccountCommentPatrolProfileV1 !== true
      || agent.capabilities?.officialAccountLatestPostsByCountV1 !== true)) {
    return '客户端扩展版本过低，尚不支持按作品数量巡查官方账号'
  }
  return ''
}

export function hasConfiguredUnattendedPlan(plan?: UnattendedPlan | null) {
  if (!plan) return false
  const keywordCount = Array.isArray(plan.keywords)
    ? plan.keywords.map(value => String(value || '').trim()).filter(Boolean).length
    : 0
  return plan.configured ?? Boolean(plan.updatedAt || plan.enabled || keywordCount > 0 || safeNumber(plan.keywordCount) > 0)
}

export const ACTIVE_TASK_STATUSES = new Set(['pending', 'waiting_device', 'claimed', 'running', 'recovering', 'resume_requested'])
export const ATTENTION_TASK_STATUSES = new Set(['interrupted', 'needs_action', 'failed', 'completed_with_failures'])
export const DISMISSIBLE_ATTENTION_TASK_STATUSES = new Set(['failed', 'completed_with_failures'])

export function isAttentionTask(task: CloudTask) {
  const status = task.effective_status || task.status
  return ATTENTION_TASK_STATUSES.has(status) && !task.attention_dismissed_at
}

export function canDismissAttention(task: CloudTask) {
  return !task.parent_task_id &&
    DISMISSIBLE_ATTENTION_TASK_STATUSES.has(task.status) &&
    !task.attention_dismissed_at
}

export function isBusinessVisibleTask(task: CloudTask) {
  const type = String(task.task_type || '').toLowerCase()
  if (type === 'capture_orchestration') return true
  // 多 Agent 父任务是业务对象；其每个 Agent 子任务只在编排详情中展示，
  // 避免一个 20 关键词任务在主列表里膨胀成多条技术记录。
  if (task.parent_task_id || task.metadata?.orchestrationChild === true) return false
  // 计划保存/覆盖和采集链内同步是系统动作，不应占据业务任务队列。
  if (type === 'unattended_plan_configuration' || type === 'sync' || type.endsWith('_sync')) return false
  // 被恢复任务接替的旧记录保留在服务端审计中，不再作为一条独立业务任务重复展示。
  if (task.status === 'superseded') return false
  return true
}

export function isPendingUnattendedPlanDeleteTask(task: CloudTask) {
  return task.task_type === 'unattended_plan_configuration' &&
    task.metadata?.planOperation === 'delete' &&
    ['pending', 'claimed'].includes(task.status)
}

export function taskBelongsToAgent(task: CloudTask, agent: CloudAgent) {
  const agentId = task.assigned_agent_id || task.origin_agent_id
  if (agentId) return agentId === agent.id
  return task.agent_display_name === agent.display_name && task.agent_host_label === agent.host_label
}

export function agentAssignmentBlockReason(agent: CloudAgent, mode: 'one_time' | 'unattended_plan') {
  if (agent.status === 'migrated') return 'Agent 已移出当前租户，不能接收新任务'
  if (agent.status === 'revoked') return 'Agent 已永久停用，不能接收新任务'
  if (agent.status !== 'active') return 'Agent 已暂停，不能接收新任务'
  if (agent.capabilities?.remoteTaskCreate !== true) return '客户端扩展版本过低，需升级后才能远程接单'
  if (mode === 'unattended_plan' && agent.capabilities?.remoteUnattendedPlanWrite !== true) {
    return '当前版本不支持云端无人值守计划'
  }
  if (agentCreatePlatforms(agent).length === 0) return '没有可执行的小红书或抖音平台'
  return ''
}
