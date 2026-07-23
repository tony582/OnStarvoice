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
  customDates?: string
  keywords?: string[]
  keywordCount?: number
  searchFilters?: {
    sort?: string
    publishTime?: string
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
  status: 'active' | 'paused' | 'revoked'
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

export type TaskView = 'active' | 'attention' | 'plans' | 'history'
export type ComposerIntent = {
  agentId?: string
  mode?: 'one_time' | 'unattended_plan'
  editExisting?: boolean
}

export type Overview = {
  agents: CloudAgent[]
  tasks: CloudTask[]
  summary: {
    agents: number
    onlineAgents: number
    runningTasks: number
    attentionTasks: number
  }
}

export const PLATFORM_LABELS: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  weibo: '微博',
  mixed: '多平台',
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

export function normalizeCloudTaskDateList(value = '') {
  const sourceDates = String(value).split(/[\s,，;；]+/g).map(item => item.trim()).filter(Boolean)
  const normalizedDates = sourceDates.map(sourceDate => ({
    sourceDate,
    normalizedDate: normalizeCloudTaskDate(sourceDate),
  }))

  return {
    dates: Array.from(new Set(normalizedDates.map(item => item.normalizedDate).filter(Boolean))),
    invalidDates: normalizedDates.filter(item => !item.normalizedDate).map(item => item.sourceDate),
  }
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

export function taskBelongsToAgent(task: CloudTask, agent: CloudAgent) {
  const agentId = task.assigned_agent_id || task.origin_agent_id
  if (agentId) return agentId === agent.id
  return task.agent_display_name === agent.display_name && task.agent_host_label === agent.host_label
}

export function agentAssignmentBlockReason(agent: CloudAgent, mode: 'one_time' | 'unattended_plan') {
  if (agent.status !== 'active') return 'Agent 已暂停，不能接收新任务'
  if (agent.capabilities?.remoteTaskCreate !== true) return '客户端扩展版本过低，需升级后才能远程接单'
  if (mode === 'unattended_plan' && agent.capabilities?.remoteUnattendedPlanWrite !== true) {
    return '当前版本不支持云端无人值守计划'
  }
  if (agentCreatePlatforms(agent).length === 0) return '没有可执行的小红书或抖音平台'
  return ''
}
