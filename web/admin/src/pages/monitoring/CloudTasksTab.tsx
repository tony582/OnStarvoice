import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowLeft, Bot, CheckCircle2, ChevronDown, ChevronRight, ChevronUp,
  CircleOff, ClipboardList, CloudCog, History, Laptop, ListChecks, Loader2, Pencil, Play, Plus,
  Network, RefreshCw, Save, ServerCog, Settings2, Square, Wifi, WifiOff, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import {
  OrchestrationComposerDrawer,
  OrchestrationDetailWorkspace,
} from './cloud-tasks'

type CaptureEnhancementSettings = {
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

type UnattendedPlan = {
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

type CloudAgent = {
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

type CloudTask = {
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

type TaskView = 'active' | 'attention' | 'history'
type ComposerStep = 'mode' | 'agent' | 'configure'
type ComposerIntent = {
  agentId?: string
  mode?: 'one_time' | 'unattended_plan'
  editExisting?: boolean
}

type Overview = {
  agents: CloudAgent[]
  tasks: CloudTask[]
  summary: {
    agents: number
    onlineAgents: number
    runningTasks: number
    attentionTasks: number
  }
}

const PLATFORM_LABELS: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  weibo: '微博',
  mixed: '多平台',
  unknown: '未识别',
}

const STATUS_LABELS: Record<string, string> = {
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

const PLAN_MODE_LABELS: Record<string, string> = {
  daily: '每天',
  custom_dates: '指定日期',
}

const SORT_OPTIONS = [
  { value: 'comprehensive', label: '综合排序' },
  { value: 'latest', label: '最新发布' },
  { value: 'likes', label: '最多点赞' },
  { value: 'comments', label: '最多评论', platform: 'xiaohongshu' },
  { value: 'collects', label: '最多收藏', platform: 'xiaohongshu' },
]

const PUBLISH_TIME_OPTIONS = [
  { value: 'all', label: '不限时间' },
  { value: 'day', label: '一天内' },
  { value: 'week', label: '一周内' },
  { value: 'halfyear', label: '半年内' },
]

function safeNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

function normalizeCloudTaskDate(value = '') {
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

function normalizeCloudTaskDateList(value = '') {
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

function formatTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function taskProgress(task: CloudTask) {
  const progress = task.progress || {}
  const counts = task.counts || {}
  const current = safeNumber(progress.current ?? progress.index ?? counts.processed)
  const total = safeNumber(progress.total ?? counts.total)
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
  return { current, total, percent }
}

function statusTone(status: string) {
  if (['running', 'recovering', 'claimed'].includes(status)) return 'border-primary/25 bg-primary/8 text-primary'
  if (['interrupted', 'needs_action', 'failed', 'completed_with_failures'].includes(status)) return 'border-status-red/25 bg-status-red/8 text-status-red'
  if (status === 'waiting_device' || status === 'resume_requested') return 'border-status-orange/30 bg-status-orange/10 text-amber-700 dark:text-amber-300'
  if (['completed', 'completed_with_warnings', 'superseded'].includes(status)) return 'border-status-green/25 bg-status-green/8 text-status-green'
  return 'border-border bg-muted text-muted-foreground'
}

function canResume(task: CloudTask) {
  return Boolean(
    task.control_task_id &&
    task.task_type.includes('unattended') &&
    ['interrupted', 'needs_action', 'failed', 'completed_with_failures'].includes(task.status),
  )
}

function canStop(task: CloudTask) {
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

function resumeBlockReason(task: CloudTask) {
  if (task.resume_block_reason) return task.resume_block_reason
  if (task.agent_status && task.agent_status !== 'active') return '原执行节点已暂停或撤销'
  const platforms = task.agent_allowed_platforms || []
  if (platforms.length > 0 && !platforms.includes(task.platform)) return '原执行节点未配置负责该平台'
  return ''
}

function taskErrorText(task: CloudTask) {
  const error = task.error || {}
  return String(error.message || error.reason || error.code || '').trim()
}

function agentCreatePlatforms(agent: CloudAgent) {
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

function hasConfiguredUnattendedPlan(plan?: UnattendedPlan | null) {
  if (!plan) return false
  const keywordCount = Array.isArray(plan.keywords)
    ? plan.keywords.map(value => String(value || '').trim()).filter(Boolean).length
    : 0
  return plan.configured ?? Boolean(plan.updatedAt || plan.enabled || keywordCount > 0 || safeNumber(plan.keywordCount) > 0)
}

function UnattendedPlanSummary({
  plan,
  mirroredAt,
}: {
  plan?: UnattendedPlan | null
  mirroredAt?: string | null
}) {
  if (!plan) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2.5">
        <div className="text-xs font-semibold text-foreground">本地无人值守计划</div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">节点尚未上报本地计划。</p>
      </div>
    )
  }

  const keywords = Array.isArray(plan.keywords)
    ? plan.keywords.map(value => String(value || '').trim()).filter(Boolean)
    : []
  const keywordCount = Math.max(keywords.length, safeNumber(plan.keywordCount))
  // 旧后端归一化可能没有保留 configured；本地计划只要有更新时间、
  // 已启用或含关键词，就可判定为真实配置，而空镜像应显示“尚未配置”。
  const configured = hasConfiguredUnattendedPlan(plan)
  const maxRounds = Math.max(1, safeNumber(plan.maxRounds) || 1)
  const roundGapMin = safeNumber(plan.roundGapMin)
  const mode = PLAN_MODE_LABELS[String(plan.mode || '')] || String(plan.mode || '本地设置')
  const sortLabel = SORT_OPTIONS.find(option => option.value === plan.searchFilters?.sort)?.label || '综合排序'
  const publishTimeLabel = PUBLISH_TIME_OPTIONS.find(option => option.value === plan.searchFilters?.publishTime)?.label || '不限时间'
  const lastRunStatus = STATUS_LABELS[String(plan.lastRunStatus || '')] || String(plan.lastRunStatus || '')
  const captureSettings = plan.captureSettings
  const keywordMaxDetectedItems = Number(plan.keywordMaxDetectedItems)
  const hasKeywordMaxDetectedItems = Number.isSafeInteger(keywordMaxDetectedItems) && keywordMaxDetectedItems > 0
  const enhancementItems = captureSettings?.autoDetailCaptureAfterListCapture
    ? [
        captureSettings.autoSyncAfterDetailCapture ? '自动同步' : '',
        captureSettings.enableAiRelevancePrefilter ? 'AI 筛选' : '',
        captureSettings.includeBloggerMetricsOnDetailCapture ? '博主数据' : '',
        captureSettings.enableLowFollowerHitFilterOnDetailCapture
          ? `低粉爆款（≤ ${safeNumber(captureSettings.lowFollowerHitThresholdOnDetailCapture).toLocaleString('zh-CN')} 粉）`
          : '',
        captureSettings.includeCommentsOnDetailCapture
          ? `评论 ${Math.max(1, safeNumber(captureSettings.detailCommentsMaxDetectedItems) || 50)} 条`
          : '',
        captureSettings.enableCommentLeadsFilterOnDetailCapture ? '评论客资筛选' : '',
        captureSettings.skipAlreadyCapturedOnDetailCapture ? '跳过已增强' : '',
      ].filter(Boolean)
    : []

  return (
    <div className="mt-3 rounded-lg border border-border/70 bg-card/70 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-foreground">本地无人值守计划</div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${plan.enabled ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
          {!configured ? '尚未配置' : plan.enabled ? '已启用' : '未启用'}
        </span>
      </div>
      <div className="mt-2 grid gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground sm:grid-cols-2">
        <div>平台：<span className="text-foreground">{PLATFORM_LABELS[plan.platform || 'unknown'] || plan.platform || '未设置'}</span></div>
        <div>关键词：<span className="text-foreground">{keywordCount} 个</span></div>
        <div>执行：<span className="text-foreground">{plan.enabled ? `${mode}${plan.startTime ? ` · ${plan.startTime}` : ''}` : '当前不自动执行'}</span></div>
        <div>循环：<span className="text-foreground">{maxRounds} 轮{maxRounds > 1 ? ` · 间隔 ${roundGapMin} 分钟` : ''}</span></div>
        <div>排序：<span className="text-foreground">{sortLabel}</span></div>
        <div>时间：<span className="text-foreground">{publishTimeLabel}</span></div>
        <div className="sm:col-span-2">采集数量：<span className="text-foreground">{hasKeywordMaxDetectedItems ? `每个关键词最多 ${keywordMaxDetectedItems} 条` : '每词上限使用设备本地设置'}</span></div>
        <div>下次运行：<span className="text-foreground">{formatTime(plan.nextRunAt)}</span></div>
        <div>上次运行：<span className="text-foreground">{formatTime(plan.lastRunAt)}{lastRunStatus ? ` · ${lastRunStatus}` : ''}</span></div>
        {captureSettings && (
          <div className="sm:col-span-2">采集增强：<span className="text-foreground">{captureSettings.autoDetailCaptureAfterListCapture ? enhancementItems.join(' · ') || '已开启' : '未开启'}</span></div>
        )}
        <div className="sm:col-span-2">计划同步：<span className="text-foreground">{formatTime(mirroredAt || plan.updatedAt)}</span></div>
      </div>
      {keywords.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {keywords.slice(0, 3).map(keyword => (
            <span key={keyword} className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{keyword}</span>
          ))}
          {keywords.length > 3 && <span className="px-1 py-1 text-[10px] text-muted-foreground">另 {keywords.length - 3} 个</span>}
        </div>
      )}
    </div>
  )
}

function AgentTaskCreator({
  agent,
  writable,
  onCreated,
  initialExecutionMode = 'one_time',
  forceOpen = false,
  editExistingInitially = false,
  hideLauncher = false,
  lockExecutionMode = false,
}: {
  agent: CloudAgent
  writable: boolean
  onCreated: () => Promise<void>
  initialExecutionMode?: 'one_time' | 'unattended_plan'
  forceOpen?: boolean
  editExistingInitially?: boolean
  hideLauncher?: boolean
  lockExecutionMode?: boolean
}) {
  const remoteTaskCreate = agent.capabilities?.remoteTaskCreate === true
  const remoteUnattendedPlanWrite = agent.capabilities?.remoteUnattendedPlanWrite === true
  const remoteTaskEnhancementOptions = agent.capabilities?.remoteTaskEnhancementOptions === true
  const remoteTaskKeywordPostLimit = agent.capabilities?.remoteTaskKeywordPostLimit === true
  const availablePlatforms = useMemo(() => agentCreatePlatforms(agent), [agent])
  const [open, setOpen] = useState(forceOpen)
  const [executionMode, setExecutionMode] = useState<'one_time' | 'unattended_plan'>(initialExecutionMode)
  const [taskTitle, setTaskTitle] = useState('')
  const [platform, setPlatform] = useState(availablePlatforms[0] || '')
  const [keywordText, setKeywordText] = useState('')
  const [sort, setSort] = useState('comprehensive')
  const [publishTime, setPublishTime] = useState('all')
  const [maxRounds, setMaxRounds] = useState(1)
  const [roundGapMin, setRoundGapMin] = useState(10)
  const [planMode, setPlanMode] = useState<'daily' | 'custom_dates'>('daily')
  const [startTime, setStartTime] = useState('09:00')
  const [randomOffsetMin, setRandomOffsetMin] = useState(20)
  const [customDates, setCustomDates] = useState('')
  const [keywordMaxDetectedItems, setKeywordMaxDetectedItems] = useState(50)
  const [keywordLimitOverrideEnabled, setKeywordLimitOverrideEnabled] = useState(true)
  const [enhancementEnabled, setEnhancementEnabled] = useState(false)
  const [captureSettingsOverrideEnabled, setCaptureSettingsOverrideEnabled] = useState(true)
  const [autoSyncAfterEnhancement, setAutoSyncAfterEnhancement] = useState(false)
  const [aiRelevancePrefilter, setAiRelevancePrefilter] = useState(false)
  const [includeBloggerMetrics, setIncludeBloggerMetrics] = useState(false)
  const [lowFollowerHitFilter, setLowFollowerHitFilter] = useState(false)
  const [lowFollowerHitThreshold, setLowFollowerHitThreshold] = useState(10_000)
  const [includeComments, setIncludeComments] = useState(false)
  const [commentLimit, setCommentLimit] = useState(50)
  const [commentLeadsFilter, setCommentLeadsFilter] = useState(false)
  const [skipAlreadyEnhanced, setSkipAlreadyEnhanced] = useState(true)
  const [editingExistingPlan, setEditingExistingPlan] = useState(false)
  const [keywordLimitDefaultedFromLegacyPlan, setKeywordLimitDefaultedFromLegacyPlan] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const pendingSubmission = useRef<{ fingerprint: string; requestKey: string } | null>(null)
  const selectedPlatform = availablePlatforms.includes(platform)
    ? platform
    : availablePlatforms[0] || ''
  const selectedSort = selectedPlatform !== 'xiaohongshu' && ['comments', 'collects'].includes(sort)
    ? 'comprehensive'
    : sort
  const existingPlan = agent.unattended_plan
  const hasExistingPlan = hasConfiguredUnattendedPlan(existingPlan)

  const resetNewTaskForm = () => {
    setExecutionMode('one_time')
    setTaskTitle('')
    setPlatform(availablePlatforms[0] || '')
    setKeywordText('')
    setSort('comprehensive')
    setPublishTime('all')
    setMaxRounds(1)
    setRoundGapMin(10)
    setPlanMode('daily')
    setStartTime('09:00')
    setRandomOffsetMin(20)
    setCustomDates('')
    setKeywordMaxDetectedItems(50)
    setKeywordLimitOverrideEnabled(true)
    setEnhancementEnabled(false)
    setCaptureSettingsOverrideEnabled(true)
    setAutoSyncAfterEnhancement(false)
    setAiRelevancePrefilter(false)
    setIncludeBloggerMetrics(false)
    setLowFollowerHitFilter(false)
    setLowFollowerHitThreshold(10_000)
    setIncludeComments(false)
    setCommentLimit(50)
    setCommentLeadsFilter(false)
    setSkipAlreadyEnhanced(true)
    setEditingExistingPlan(false)
    setKeywordLimitDefaultedFromLegacyPlan(false)
    setError('')
    setFeedback('')
    pendingSubmission.current = null
  }

  const toggleNewTaskForm = () => {
    if (open && !editingExistingPlan) {
      setOpen(false)
      return
    }
    resetNewTaskForm()
    setOpen(true)
  }

  const editUnattendedPlan = () => {
    if (open && editingExistingPlan) {
      setOpen(false)
      return
    }
    if (!existingPlan || !hasExistingPlan) return
    const captureSettings = existingPlan.captureSettings
    const hasConfiguredCaptureSettings = Boolean(captureSettings && Object.keys(captureSettings).length > 0)
    const configuredLimit = Number(existingPlan.keywordMaxDetectedItems)
    const hasConfiguredLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    const configuredMode = existingPlan.mode === 'custom_dates' ? 'custom_dates' : 'daily'
    const configuredStartTime = /^\d{2}:\d{2}$/.test(String(existingPlan.startTime || ''))
      ? String(existingPlan.startTime)
      : '09:00'

    setExecutionMode('unattended_plan')
    setPlatform(availablePlatforms.includes(String(existingPlan.platform || ''))
      ? String(existingPlan.platform)
      : availablePlatforms[0] || '')
    setKeywordText(Array.isArray(existingPlan.keywords)
      ? existingPlan.keywords.map(value => String(value || '').trim()).filter(Boolean).join('\n')
      : '')
    setSort(SORT_OPTIONS.some(option => option.value === existingPlan.searchFilters?.sort)
      ? String(existingPlan.searchFilters?.sort)
      : 'comprehensive')
    setPublishTime(PUBLISH_TIME_OPTIONS.some(option => option.value === existingPlan.searchFilters?.publishTime)
      ? String(existingPlan.searchFilters?.publishTime)
      : 'all')
    setMaxRounds(Math.max(1, safeNumber(existingPlan.maxRounds) || 1))
    setRoundGapMin(existingPlan.roundGapMin === undefined ? 10 : safeNumber(existingPlan.roundGapMin))
    setPlanMode(configuredMode)
    setStartTime(configuredStartTime)
    setRandomOffsetMin(existingPlan.randomOffsetMin === undefined ? 20 : safeNumber(existingPlan.randomOffsetMin))
    setCustomDates(String(existingPlan.customDates || ''))
    setKeywordMaxDetectedItems(hasConfiguredLimit ? configuredLimit : 50)
    setKeywordLimitOverrideEnabled(hasConfiguredLimit)
    setKeywordLimitDefaultedFromLegacyPlan(!hasConfiguredLimit)
    setEnhancementEnabled(captureSettings?.autoDetailCaptureAfterListCapture === true)
    setCaptureSettingsOverrideEnabled(hasConfiguredCaptureSettings)
    setAutoSyncAfterEnhancement(captureSettings?.autoSyncAfterDetailCapture === true)
    setAiRelevancePrefilter(captureSettings?.enableAiRelevancePrefilter === true)
    setIncludeBloggerMetrics(captureSettings?.includeBloggerMetricsOnDetailCapture === true)
    setLowFollowerHitFilter(captureSettings?.enableLowFollowerHitFilterOnDetailCapture === true)
    setLowFollowerHitThreshold(Number.isInteger(captureSettings?.lowFollowerHitThresholdOnDetailCapture)
      ? Math.max(0, Number(captureSettings?.lowFollowerHitThresholdOnDetailCapture))
      : 10_000)
    setIncludeComments(captureSettings?.includeCommentsOnDetailCapture === true)
    setCommentLimit(Number.isInteger(captureSettings?.detailCommentsMaxDetectedItems) && Number(captureSettings?.detailCommentsMaxDetectedItems) >= 1
      ? Number(captureSettings?.detailCommentsMaxDetectedItems)
      : 50)
    setCommentLeadsFilter(captureSettings?.enableCommentLeadsFilterOnDetailCapture === true)
    setSkipAlreadyEnhanced(captureSettings?.skipAlreadyCapturedOnDetailCapture ?? true)
    setEditingExistingPlan(true)
    setError('')
    setFeedback('')
    pendingSubmission.current = null
    setOpen(true)
  }

  /* eslint-disable react-hooks/set-state-in-effect -- 抽屉按 agent/mode key 重新挂载时，需要用设备镜像一次性回填受控表单。 */
  useEffect(() => {
    if (!forceOpen) return
    if (editExistingInitially) {
      editUnattendedPlan()
      return
    }
    resetNewTaskForm()
    setExecutionMode(initialExecutionMode)
    setOpen(true)
    // 该表单由抽屉通过 key 控制生命周期；这里只在目标节点或入口模式变化时初始化一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, editExistingInitially, forceOpen, initialExecutionMode])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!remoteTaskCreate) {
    return (
      <div className="mt-3 rounded-lg border border-status-orange/25 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
        当前扩展版本不支持云端新建任务，请升级扩展。
      </div>
    )
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setFeedback('')
    const keywordLines = keywordText.split(/\r?\n/g).map(value => value.trim()).filter(Boolean)
    const keywords = Array.from(new Set(keywordLines))
    if (!selectedPlatform) {
      setError('该节点没有可执行的平台，请先完成节点配置。')
      return
    }
    if (keywordLines.length < 1 || keywordLines.length > 30) {
      setError('请输入 1–30 个关键词，每行一个。')
      return
    }
    if (
      remoteTaskKeywordPostLimit &&
      keywordLimitOverrideEnabled &&
      (!Number.isSafeInteger(keywordMaxDetectedItems) || keywordMaxDetectedItems < 1)
    ) {
      setError('每个关键词最多采集帖子数必须是大于等于 1 的整数。')
      return
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      setError('执行轮数必须是大于等于 1 的整数。')
      return
    }
    if (!Number.isInteger(roundGapMin) || roundGapMin < 0) {
      setError('轮次间隔必须是大于等于 0 的整数。')
      return
    }
    if (executionMode === 'unattended_plan' && !remoteUnattendedPlanWrite) {
      setError('当前扩展版本不支持从云端保存无人值守计划，请先更新扩展。')
      return
    }
    if (
      executionMode === 'unattended_plan' &&
      (!/^\d{2}:\d{2}$/.test(startTime) || !Number.isInteger(randomOffsetMin) || randomOffsetMin < 0)
    ) {
      setError('请检查无人值守计划的开始时间和随机偏移。')
      return
    }
    const { dates: normalizedDates, invalidDates } = normalizeCloudTaskDateList(customDates)
    if (
      executionMode === 'unattended_plan' &&
      planMode === 'custom_dates' &&
      (normalizedDates.length === 0 || invalidDates.length > 0)
    ) {
      setError(invalidDates.length > 0
        ? `以下日期无效：${invalidDates.slice(0, 3).join('、')}。请输入真实存在的日期，例如 2026-07-21。`
        : '指定日期计划至少需要一个有效日期，例如 2026-7-21 或 2026/7/21。')
      return
    }
    if (executionMode === 'unattended_plan' && planMode === 'custom_dates') {
      setCustomDates(normalizedDates.join('\n'))
    }
    if (
      remoteTaskEnhancementOptions &&
      captureSettingsOverrideEnabled &&
      enhancementEnabled &&
      includeBloggerMetrics &&
      lowFollowerHitFilter &&
      (!Number.isInteger(lowFollowerHitThreshold) || lowFollowerHitThreshold < 0)
    ) {
      setError('低粉爆款筛选的粉丝上限必须是大于等于 0 的整数。')
      return
    }
    if (
      remoteTaskEnhancementOptions &&
      captureSettingsOverrideEnabled &&
      enhancementEnabled &&
      includeComments &&
      (!Number.isInteger(commentLimit) || commentLimit < 1)
    ) {
      setError('评论加载上限必须是大于等于 1 的整数。')
      return
    }

    const captureSettings: CaptureEnhancementSettings | undefined = remoteTaskEnhancementOptions && captureSettingsOverrideEnabled
      ? {
          autoDetailCaptureAfterListCapture: enhancementEnabled,
          autoSyncAfterDetailCapture: enhancementEnabled && autoSyncAfterEnhancement,
          enableAiRelevancePrefilter: enhancementEnabled && aiRelevancePrefilter,
          includeBloggerMetricsOnDetailCapture: enhancementEnabled && includeBloggerMetrics,
          enableLowFollowerHitFilterOnDetailCapture:
            enhancementEnabled && includeBloggerMetrics && lowFollowerHitFilter,
          lowFollowerHitThresholdOnDetailCapture:
            Number.isInteger(lowFollowerHitThreshold) && lowFollowerHitThreshold >= 0
              ? lowFollowerHitThreshold
              : 10_000,
          includeCommentsOnDetailCapture: enhancementEnabled && includeComments,
          detailCommentsMaxDetectedItems:
            Number.isInteger(commentLimit) && commentLimit >= 1 ? commentLimit : 50,
          enableCommentLeadsFilterOnDetailCapture:
            enhancementEnabled && includeComments && commentLeadsFilter,
          skipAlreadyCapturedOnDetailCapture: enhancementEnabled && skipAlreadyEnhanced,
        }
      : undefined

    const taskInput = {
      ...(taskTitle.trim() ? { title: taskTitle.trim() } : {}),
      executionMode,
      platform: selectedPlatform,
      keywords,
      sort: selectedSort,
      publishTime,
      maxRounds: executionMode === 'unattended_plan' ? maxRounds : 1,
      roundGapMin: executionMode === 'unattended_plan' ? roundGapMin : 0,
      ...(remoteTaskKeywordPostLimit && keywordLimitOverrideEnabled ? { keywordMaxDetectedItems } : {}),
      ...(captureSettings ? { captureSettings } : {}),
      ...(executionMode === 'unattended_plan' ? {
        enabled: true,
        mode: planMode,
        startTime,
        randomOffsetMin,
        customDates: planMode === 'custom_dates' ? normalizedDates.join('\n') : '',
      } : {}),
    }
    const fingerprint = JSON.stringify(taskInput)
    let submission = pendingSubmission.current
    if (submission?.fingerprint !== fingerprint) {
      submission = {
        fingerprint,
        requestKey: window.crypto.randomUUID(),
      }
      pendingSubmission.current = submission
    }
    const requestKey = submission.requestKey

    setSubmitting(true)
    try {
      const result = await api.post<{ message?: string }>(`/capture-cloud/agents/${agent.id}/tasks`, {
        ...taskInput,
        requestKey,
      })
      pendingSubmission.current = null
      setFeedback(result.message || (agent.online
        ? executionMode === 'unattended_plan'
          ? editingExistingPlan
            ? '无人值守计划修改已下发，等待设备覆盖保存。'
            : '无人值守计划已下发，等待设备保存。'
          : '一次性采集任务已创建，等待设备领取。'
        : executionMode === 'unattended_plan'
          ? editingExistingPlan
            ? '无人值守计划修改已排队，将在设备上线后覆盖保存。'
            : '无人值守计划已排队，将在设备上线后保存。'
          : '一次性采集任务已创建，将在设备上线后自动领取。'))
      if (!editingExistingPlan) setKeywordText('')
      await onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建关键词采集任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = submitting || !writable || agent.status !== 'active' || availablePlatforms.length === 0
  const nodeMessage = agent.status !== 'active'
    ? '节点已暂停，恢复节点后才能接收新任务。'
    : agent.online
      ? '节点在线，提交后会在下一次心跳领取任务。'
      : '节点离线，任务会在云端排队，设备上线后自动领取。'

  return (
    <div className={hideLauncher ? '' : 'mt-3 border-t border-border/60 pt-3'}>
      {!hideLauncher && <div className="space-y-1.5">
        <button type="button" onClick={toggleNewTaskForm}
          className="flex min-h-8 w-full items-center justify-between gap-3 rounded-lg px-1 text-left text-xs font-semibold text-foreground hover:bg-muted/60">
          <span className="flex items-center gap-1.5"><Plus className="h-3.5 w-3.5 text-primary" />新建关键词采集任务</span>
          {open && !editingExistingPlan ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        </button>
        {hasExistingPlan && (
          <button type="button" onClick={editUnattendedPlan}
            disabled={disabled || !remoteUnattendedPlanWrite}
            title={remoteUnattendedPlanWrite ? '载入当前计划并修改' : '需要更新扩展后才能修改无人值守计划'}
            className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/[0.045] px-2.5 text-left text-xs font-semibold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50">
            <span className="flex items-center gap-1.5"><Pencil className="h-3.5 w-3.5" />修改现有无人值守计划</span>
            {open && editingExistingPlan ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>}
      {open && (
        <form className={`${hideLauncher ? '' : 'mt-3'} space-y-4`} onSubmit={submit}>
          {editingExistingPlan && (
            <div className="rounded-lg border border-status-orange/30 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              <div className="font-semibold">正在修改该设备的现有无人值守计划</div>
              <p className="mt-1">保存修改会覆盖当前设备计划，并在设备端重新启用；新建一次性任务不会改动这份计划。</p>
              <p className="mt-1">正在运行的任务继续使用启动时的旧快照；新配置从后续排期生效。</p>
            </div>
          )}
          <p className={`rounded-lg px-2.5 py-2 text-[11px] leading-4 ${agent.online && agent.status === 'active' ? 'bg-status-green/8 text-status-green' : 'bg-status-orange/8 text-amber-700 dark:text-amber-300'}`}>{nodeMessage}</p>
          {!writable && <p className="text-[11px] leading-4 text-muted-foreground">当前账号为只读权限，不能创建任务。</p>}
          <label className="block text-xs font-medium text-muted-foreground">
            任务名称（可选）
            <input value={taskTitle} onChange={event => setTaskTitle(event.target.value)} disabled={disabled}
              maxLength={120} placeholder={executionMode === 'unattended_plan' ? '例如：新能源竞品每日监测' : '例如：7 月新品口碑采集'}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary disabled:opacity-60" />
            <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground">用于在任务队列中快速识别；不填写时会自动生成名称。</span>
          </label>
          <div>
            <div className="text-xs font-medium text-muted-foreground">执行方式</div>
            <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="执行方式">
              <button type="button" role="tab" aria-selected={executionMode === 'one_time'}
                onClick={() => editingExistingPlan ? resetNewTaskForm() : setExecutionMode('one_time')} disabled={disabled || lockExecutionMode}
                className={`min-h-9 rounded-md px-3 text-xs font-semibold transition-colors ${executionMode === 'one_time' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                一次性
              </button>
              <button type="button" role="tab" aria-selected={executionMode === 'unattended_plan'}
                onClick={() => setExecutionMode('unattended_plan')} disabled={disabled || lockExecutionMode || !remoteUnattendedPlanWrite}
                title={remoteUnattendedPlanWrite ? '' : '需要更新扩展后才能云端保存无人值守计划'}
                className={`min-h-9 rounded-md px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${executionMode === 'unattended_plan' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                无人值守
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              {editingExistingPlan
                ? '当前字段来自设备已上报的计划；保存修改后会用这些内容覆盖原计划。'
                : executionMode === 'unattended_plan'
                  ? '保存并启用该设备的本地计划，之后由扩展按时间自动执行。'
                : '只执行这一次，不会改动该设备已保存的无人值守计划。'}
            </p>
            {!editingExistingPlan && executionMode === 'unattended_plan' && hasExistingPlan && (
              <p className="mt-1 rounded-lg border border-status-orange/25 bg-status-orange/8 px-2.5 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                该设备已有无人值守计划，保存会覆盖原计划。若要在原内容上修改，请使用上方“修改现有无人值守计划”。
              </p>
            )}
            {!remoteUnattendedPlanWrite && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">当前扩展只支持一次性任务，更新后可从云端保存无人值守计划。</p>}
          </div>
          <label className="block text-xs font-medium text-muted-foreground">
            执行平台
            <select value={selectedPlatform} onChange={event => setPlatform(event.target.value)} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
              {availablePlatforms.length === 0 && <option value="">暂无可用平台</option>}
              {availablePlatforms.map(value => <option key={value} value={value}>{PLATFORM_LABELS[value] || value}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            关键词（每行一个，1–30 个）
            <textarea value={keywordText} onChange={event => setKeywordText(event.target.value)} rows={4} disabled={disabled}
              placeholder={'新能源汽车\n智能座舱'}
              className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary disabled:opacity-60" />
          </label>
          {remoteTaskKeywordPostLimit ? (
            <fieldset className="rounded-xl border border-border/70 bg-card/50 p-3">
              <legend className="px-1 text-xs font-semibold text-foreground">帖子采集上限</legend>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={keywordLimitOverrideEnabled}
                  onChange={event => setKeywordLimitOverrideEnabled(event.target.checked)} disabled={disabled}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                <span>
                  <span className="block text-xs font-semibold text-foreground">使用{executionMode === 'unattended_plan' ? '计划' : '任务'}专属帖子上限</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">关闭时沿用目标设备当前的本地采集上限。</span>
                </span>
              </label>
              {keywordLimitOverrideEnabled ? (
                <label className="mt-2.5 block text-xs font-medium text-muted-foreground">
                  每个关键词最多采集帖子数
                  <input type="number" min={1} step={1} value={keywordMaxDetectedItems}
                    onChange={event => {
                      setKeywordMaxDetectedItems(Number(event.target.value))
                      setKeywordLimitDefaultedFromLegacyPlan(false)
                    }} disabled={disabled}
                    className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
                  <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground">按每个关键词、每一轮单独计算；受页面实际结果和筛选条件影响，实际数量可能更少。</span>
                  {editingExistingPlan && keywordLimitDefaultedFromLegacyPlan && (
                    <span className="mt-1.5 block rounded-lg border border-status-orange/25 bg-status-orange/8 px-2.5 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                      旧计划没有记录帖子上限。你已改用计划专属设置；如直接保存，新计划将使用每个关键词最多 50 条。
                    </span>
                  )}
                </label>
              ) : (
                <p className="mt-2.5 rounded-lg bg-muted/70 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                  沿用设备设置：本次保存不会写入帖子上限，也不会因为修改日期等其他字段而改成 50 条。
                </p>
              )}
            </fieldset>
          ) : (
            <p className="rounded-lg border border-status-orange/25 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              当前扩展版本不支持从后台指定帖子采集上限；任务会使用目标设备的本地设置，更新扩展后可单独配置。
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-muted-foreground">
              排序方式
              <select value={selectedSort} onChange={event => setSort(event.target.value)} disabled={disabled}
                className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
                {SORT_OPTIONS.filter(option => !option.platform || option.platform === selectedPlatform).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              发布时间
              <select value={publishTime} onChange={event => setPublishTime(event.target.value)} disabled={disabled}
                className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
                {PUBLISH_TIME_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {executionMode === 'unattended_plan' && <>
              <label className="block text-xs font-medium text-muted-foreground">
                运行规则
                <select value={planMode} onChange={event => setPlanMode(event.target.value as 'daily' | 'custom_dates')} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
                  <option value="daily">每天</option>
                  <option value="custom_dates">指定日期</option>
                </select>
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                开始时间
                <input type="time" value={startTime} onChange={event => setStartTime(event.target.value)} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                随机偏移（分钟）
                <input type="number" min={0} max={240} step={1} value={randomOffsetMin} onChange={event => setRandomOffsetMin(Number(event.target.value))} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                执行轮数
                <input type="number" min={1} step={1} value={maxRounds} onChange={event => setMaxRounds(Number(event.target.value))} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              </label>
              <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">
                轮次间隔（分钟）
                <input type="number" min={0} step={1} value={roundGapMin} onChange={event => setRoundGapMin(Number(event.target.value))} disabled={disabled}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              </label>
            </>}
          </div>
          {executionMode === 'unattended_plan' && planMode === 'custom_dates' && (
            <label className="block text-xs font-medium text-muted-foreground">
              运行日期（每行一个）
              <textarea value={customDates} onChange={event => setCustomDates(event.target.value)} rows={3} disabled={disabled}
                placeholder={'2026-7-21\n2026/10/2'}
                className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-3 py-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary disabled:opacity-60" />
              <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground">支持 YYYY-M-D 或 YYYY/M/D，保存时会自动规范为 YYYY-MM-DD。</span>
            </label>
          )}
          {remoteTaskEnhancementOptions ? (
            <fieldset className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3.5">
              <legend className="px-1 text-xs font-semibold text-foreground">采集增强</legend>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={captureSettingsOverrideEnabled}
                  onChange={event => setCaptureSettingsOverrideEnabled(event.target.checked)} disabled={disabled}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                <span>
                  <span className="block text-xs font-semibold text-foreground">使用{executionMode === 'unattended_plan' ? '计划' : '任务'}专属采集增强设置</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">关闭时沿用目标设备当前的本地采集增强设置。</span>
                </span>
              </label>
              {captureSettingsOverrideEnabled ? (
                <div className="mt-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={enhancementEnabled}
                  onChange={event => setEnhancementEnabled(event.target.checked)} disabled={disabled}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                <span>
                  <span className="block text-xs font-semibold text-foreground">采集增强</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">逐条打开详情页，补齐正文、互动数据、图文视频链接等信息。</span>
                </span>
              </label>

              <div className={`mt-3 space-y-2 border-l-2 border-primary/15 pl-3 ${enhancementEnabled ? '' : 'opacity-55'}`}>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-background/70">
                  <input type="checkbox" checked={autoSyncAfterEnhancement}
                    onChange={event => setAutoSyncAfterEnhancement(event.target.checked)} disabled={disabled || !enhancementEnabled}
                    className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                  <span className="text-xs font-medium text-foreground">增强后自动同步后台</span>
                </label>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-background/70">
                  <input type="checkbox" checked={aiRelevancePrefilter}
                    onChange={event => setAiRelevancePrefilter(event.target.checked)} disabled={disabled || !enhancementEnabled}
                    className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                  <span className="text-xs font-medium text-foreground">AI 精准筛选</span>
                  <span className="rounded-full border border-primary/25 bg-primary/8 px-1.5 py-0.5 text-[10px] font-semibold text-primary">DeepSeek</span>
                </label>

                <div className="rounded-lg border border-border/70 bg-background/55 p-2.5">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={includeBloggerMetrics}
                      onChange={event => setIncludeBloggerMetrics(event.target.checked)} disabled={disabled || !enhancementEnabled}
                      className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                    <span className="text-xs font-medium text-foreground">附件博主粉丝数和赞藏数</span>
                  </label>
                  <div className={`mt-2 border-l border-border pl-3 ${includeBloggerMetrics ? '' : 'opacity-55'}`}>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={lowFollowerHitFilter}
                        onChange={event => setLowFollowerHitFilter(event.target.checked)}
                        disabled={disabled || !enhancementEnabled || !includeBloggerMetrics}
                        className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                      <span className="text-xs text-foreground">低粉爆款筛选</span>
                    </label>
                    {lowFollowerHitFilter && includeBloggerMetrics && (
                      <label className="mt-2 block text-[11px] font-medium text-muted-foreground">
                        博主粉丝上限
                        <input type="number" min={0} step={1} value={lowFollowerHitThreshold}
                          onChange={event => setLowFollowerHitThreshold(Number(event.target.value))} disabled={disabled || !enhancementEnabled}
                          className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
                      </label>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border/70 bg-background/55 p-2.5">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={includeComments}
                      onChange={event => setIncludeComments(event.target.checked)} disabled={disabled || !enhancementEnabled}
                      className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                    <span className="text-xs font-medium text-foreground">附加评论</span>
                  </label>
                  <div className={`mt-2 space-y-2 border-l border-border pl-3 ${includeComments ? '' : 'opacity-55'}`}>
                    <label className="block text-[11px] font-medium text-muted-foreground">
                      评论加载上限
                      <input type="number" min={1} step={1} value={commentLimit}
                        onChange={event => setCommentLimit(Number(event.target.value))}
                        disabled={disabled || !enhancementEnabled || !includeComments}
                        className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
                    </label>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input type="checkbox" checked={commentLeadsFilter}
                        onChange={event => setCommentLeadsFilter(event.target.checked)}
                        disabled={disabled || !enhancementEnabled || !includeComments}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                      <span>
                        <span className="block text-xs text-foreground">评论客资筛选</span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">需要目标设备已配置评论客资筛选规则。</span>
                      </span>
                    </label>
                  </div>
                </div>

                <label className="flex min-h-8 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-background/70">
                  <input type="checkbox" checked={skipAlreadyEnhanced}
                    onChange={event => setSkipAlreadyEnhanced(event.target.checked)} disabled={disabled || !enhancementEnabled}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed" />
                  <span>
                    <span className="block text-xs font-medium text-foreground">跳过已增强内容</span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">已完成详情增强的内容不重复打开，减少重复导航。</span>
                  </span>
                </label>
              </div>
                </div>
              ) : (
                <p className="mt-2.5 rounded-lg bg-muted/70 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                  沿用设备设置：本次保存不会写入采集增强选项，也不会因为修改时间、日期等其他字段而关闭设备原有增强能力。
                </p>
              )}
            </fieldset>
          ) : (
            <p className="rounded-lg border border-status-orange/25 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              当前扩展版本不支持为远程任务指定采集增强选项；任务会继续使用目标设备的本地设置。更新扩展后可在这里单独配置。
            </p>
          )}
          {error && <p role="alert" className="text-xs leading-5 text-status-red">{error}</p>}
          {feedback && <p role="status" className="text-xs leading-5 text-status-green">{feedback}</p>}
          <Button type="submit" size="sm" className="min-h-10 w-full" disabled={disabled || !keywordText.trim()}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {editingExistingPlan
              ? agent.online ? '保存修改并覆盖原计划' : '排队保存修改并覆盖原计划'
              : executionMode === 'unattended_plan'
                ? agent.online ? '保存无人值守计划' : '排队保存计划'
              : agent.online ? '立即执行一次' : '创建一次性任务并排队'}
          </Button>
        </form>
      )}
    </div>
  )
}

function AgentEditor({ agent, onSaved }: { agent: CloudAgent; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState(agent.display_name)
  const [hostLabel, setHostLabel] = useState(agent.host_label)
  const [platforms, setPlatforms] = useState<string[]>(agent.allowed_platforms || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const togglePlatform = (platform: string) => {
    setPlatforms(current => current.includes(platform)
      ? current.filter(item => item !== platform)
      : [...current, platform])
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api.patch('/capture-cloud/agents/' + agent.id, {
        displayName, hostLabel, allowedPlatforms: platforms, status: agent.status,
      })
      await onSaved()
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-border/60 pt-3">
      <button type="button" onClick={() => setOpen(value => !value)}
        className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground">
        节点配置 {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-muted-foreground">
            节点名称
            <input value={displayName} onChange={event => setDisplayName(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            所属设备
            <input value={hostLabel} onChange={event => setHostLabel(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" />
          </label>
          <fieldset>
            <legend className="text-xs font-medium text-muted-foreground">负责平台</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {['xiaohongshu', 'douyin', 'weibo'].map(platform => (
                <label key={platform} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs">
                  <input type="checkbox" checked={platforms.includes(platform)} onChange={() => togglePlatform(platform)} />
                  {PLATFORM_LABELS[platform]}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">勾选后，后台只会向该节点恢复对应平台任务；不勾选表示不限制。</p>
          </fieldset>
          {error && <p role="alert" className="text-xs text-status-red">{error}</p>}
          <Button size="sm" className="w-full" onClick={save} disabled={saving || !displayName.trim() || !hostLabel.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存配置
          </Button>
        </div>
      )}
    </div>
  )
}

const ACTIVE_TASK_STATUSES = new Set(['pending', 'waiting_device', 'claimed', 'running', 'recovering', 'resume_requested'])
const ATTENTION_TASK_STATUSES = new Set(['interrupted', 'needs_action', 'failed', 'completed_with_failures'])

function isBusinessVisibleTask(task: CloudTask) {
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

function taskBelongsToAgent(task: CloudTask, agent: CloudAgent) {
  const agentId = task.assigned_agent_id || task.origin_agent_id
  if (agentId) return agentId === agent.id
  return task.agent_display_name === agent.display_name && task.agent_host_label === agent.host_label
}

function agentAssignmentBlockReason(agent: CloudAgent, mode: 'one_time' | 'unattended_plan') {
  if (agent.status !== 'active') return '节点已暂停，不能接收新任务'
  if (agent.capabilities?.remoteTaskCreate !== true) return 'Extension 版本过低，需升级后才能远程接单'
  if (mode === 'unattended_plan' && agent.capabilities?.remoteUnattendedPlanWrite !== true) {
    return '当前版本不支持云端无人值守计划'
  }
  if (agentCreatePlatforms(agent).length === 0) return '没有可执行的小红书或抖音平台'
  return ''
}

function AssignmentSteps({ step }: { step: ComposerStep }) {
  const current = { mode: 1, agent: 2, configure: 3 }[step]
  const items = [
    { number: 1, label: '选择任务类型' },
    { number: 2, label: '分配执行设备' },
    { number: 3, label: '配置并确认' },
  ]
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="创建任务步骤">
      {items.map(item => (
        <li key={item.number} aria-current={current === item.number ? 'step' : undefined}
          className={`min-w-0 rounded-xl border px-2.5 py-2.5 sm:px-3 ${current === item.number ? 'border-primary/35 bg-primary/8' : current > item.number ? 'border-status-green/25 bg-status-green/5' : 'border-border/70 bg-muted/35'}`}>
          <div className={`text-[10px] font-bold uppercase tracking-wider ${current === item.number ? 'text-primary' : current > item.number ? 'text-status-green' : 'text-muted-foreground'}`}>
            {current > item.number ? '已完成' : `第 ${item.number} 步`}
          </div>
          <div className="mt-0.5 truncate text-xs font-semibold text-foreground">{item.label}</div>
        </li>
      ))}
    </ol>
  )
}

function TaskAssignmentDrawer({
  agents,
  tasks,
  writable,
  intent,
  onClose,
  onCreated,
}: {
  agents: CloudAgent[]
  tasks: CloudTask[]
  writable: boolean
  intent: ComposerIntent
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const editingExisting = intent.editExisting === true
  const [step, setStep] = useState<ComposerStep>(editingExisting ? 'configure' : 'mode')
  const [mode, setMode] = useState<'one_time' | 'unattended_plan'>(intent.mode || (editingExisting ? 'unattended_plan' : 'one_time'))
  const [selectedAgentId, setSelectedAgentId] = useState(intent.agentId || '')
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId)
  const sortedAgents = useMemo(() => [...agents].sort((left, right) => {
    const leftBlocked = Boolean(agentAssignmentBlockReason(left, mode))
    const rightBlocked = Boolean(agentAssignmentBlockReason(right, mode))
    if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1
    if (left.online !== right.online) return left.online ? -1 : 1
    return `${left.host_label}${left.display_name}`.localeCompare(`${right.host_label}${right.display_name}`, 'zh-CN')
  }), [agents, mode])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const goBack = () => {
    if (editingExisting || step === 'mode') return onClose()
    setStep(step === 'configure' ? 'agent' : 'mode')
  }

  const selectMode = (value: 'one_time' | 'unattended_plan') => {
    setMode(value)
    if (selectedAgentId) {
      const candidate = agents.find(agent => agent.id === selectedAgentId)
      if (!candidate || agentAssignmentBlockReason(candidate, value)) setSelectedAgentId('')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="absolute inset-0 bg-black/35" />
      <div role="dialog" aria-modal="true" aria-labelledby="task-composer-title"
        className="relative z-10 flex h-full w-full max-w-3xl flex-col bg-card shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200 lg:border-l lg:border-border">
        <header className="shrink-0 border-b border-border/70 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
          <div className="flex items-start gap-3">
            <button type="button" onClick={goBack} aria-label={step === 'mode' || editingExisting ? '关闭任务创建' : '返回上一步'}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted hover:text-foreground">
              {step === 'mode' || editingExisting ? <X className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="task-composer-title" className="text-lg font-bold text-foreground">{editingExisting ? '修改无人值守计划' : '新建任务并分配'}</h2>
                <span className="rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">Beta</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">像分配 Agent 一样：先定义工作，再明确选择由哪个浏览器节点执行。</p>
            </div>
          </div>
          {!editingExisting && <div className="mt-4"><AssignmentSteps step={step} /></div>}
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
          {step === 'mode' && (
            <div className="mx-auto max-w-2xl">
              <div className="mb-4">
                <h3 className="text-base font-bold">这次要交给设备什么任务？</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">先选择交付方式；采集内容和高级参数会在最后一步填写。</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="任务类型">
                {([
                  { value: 'one_time' as const, title: '一次性任务', icon: Play, description: '创建后执行一次，完成后进入历史，不修改设备的自动计划。', note: '适合临时采集、补采和专项调研' },
                  { value: 'unattended_plan' as const, title: '无人值守计划', icon: History, description: '保存到指定设备，由 Extension 按日期和时间自动产生采集任务。', note: '适合每天或指定日期持续监测' },
                ]).map(item => {
                  const selected = mode === item.value
                  const Icon = item.icon
                  return (
                    <button key={item.value} type="button" role="radio" aria-checked={selected} onClick={() => selectMode(item.value)}
                      className={`min-h-44 rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/20' : 'border-border bg-background hover:border-primary/35'}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}><Icon className="h-5 w-5" /></span>
                        <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}>{selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary-foreground" />}</span>
                      </div>
                      <div className="mt-4 text-sm font-bold text-foreground">{item.title}</div>
                      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.description}</p>
                      <div className="mt-3 text-[11px] font-medium text-primary">{item.note}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 'agent' && (
            <div className="mx-auto max-w-2xl">
              <div className="mb-4">
                <h3 className="text-base font-bold">选择一个执行节点</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">任务会绑定到具体浏览器 Extension。离线节点仍可接单，上线后自动领取。</p>
              </div>
              {sortedAgents.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border p-8 text-center">
                  <CircleOff className="mx-auto h-7 w-7 text-muted-foreground" />
                  <div className="mt-3 text-sm font-semibold">还没有可分配的执行节点</div>
                  <p className="mt-1 text-xs text-muted-foreground">让客户 Extension 重新验证激活码后，再回来分配任务。</p>
                </div>
              ) : (
                <div className="space-y-2" role="radiogroup" aria-label="执行节点">
                  {sortedAgents.map(agent => {
                    const blockReason = agentAssignmentBlockReason(agent, mode)
                    const selected = selectedAgentId === agent.id
                    const agentTasks = tasks.filter(task => taskBelongsToAgent(task, agent) && ACTIVE_TASK_STATUSES.has(task.effective_status || task.status))
                    const workloadKnown = agent.active_task_count !== undefined || agent.queued_task_count !== undefined
                    const activeTaskCount = workloadKnown ? safeNumber(agent.active_task_count) : agentTasks.length
                    const queuedTaskCount = workloadKnown ? safeNumber(agent.queued_task_count) : 0
                    return (
                      <button key={agent.id} type="button" role="radio" aria-checked={selected} disabled={Boolean(blockReason)}
                        onClick={() => setSelectedAgentId(agent.id)}
                        className={`flex min-h-24 w-full items-start gap-3 rounded-2xl border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/20' : 'border-border bg-background hover:border-primary/35'}`}>
                        <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}><Bot className="h-5 w-5" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-bold text-foreground">{agent.display_name}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>{agent.online ? '在线' : '离线'}</span>
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">{agent.host_label} › {agent.browser_name} · {agent.operating_system} · v{agent.app_version || '未知'}</span>
                          <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{agentCreatePlatforms(agent).map(value => PLATFORM_LABELS[value] || value).join('、') || '无可用平台'}</span>
                            <span>
                              {activeTaskCount > 0
                                ? `执行中 ${activeTaskCount}`
                                : queuedTaskCount > 0
                                  ? '当前无执行任务'
                                  : '当前空闲'}
                              {queuedTaskCount > 0 ? ` · 排队 ${queuedTaskCount}` : ''}
                            </span>
                          </span>
                          {blockReason && <span className="mt-1.5 block text-[11px] font-medium text-status-red">{blockReason}</span>}
                          {!blockReason && !agent.online && <span className="mt-1.5 block text-[11px] font-medium text-amber-700 dark:text-amber-300">设备离线；分配后会排队，上线即执行</span>}
                        </span>
                        <span className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}>{selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary-foreground" />}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {step === 'configure' && selectedAgent && (
            <div className="mx-auto max-w-2xl">
              <div className="mb-4 rounded-2xl border border-primary/20 bg-primary/[0.045] p-3.5">
                <div className="flex items-center gap-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${selectedAgent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}><Bot className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-primary">已分配执行节点</div>
                    <div className="mt-0.5 truncate text-sm font-bold">{selectedAgent.host_label} › {selectedAgent.display_name}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{selectedAgent.online ? '在线，提交后设备将在下一次心跳领取' : '离线，提交后在云端排队，上线自动领取'}</div>
                  </div>
                  {!editingExisting && <button type="button" onClick={() => setStep('agent')} className="min-h-10 rounded-lg px-3 text-xs font-semibold text-primary hover:bg-primary/10">更换</button>}
                </div>
              </div>
              <AgentTaskCreator
                key={`${selectedAgent.id}:${mode}:${editingExisting ? 'edit' : 'new'}`}
                agent={selectedAgent}
                writable={writable}
                initialExecutionMode={mode}
                forceOpen
                editExistingInitially={editingExisting}
                hideLauncher
                lockExecutionMode
                onCreated={async () => {
                  await onCreated()
                  onClose()
                }}
              />
            </div>
          )}
        </div>

        {step !== 'configure' && (
          <footer className="shrink-0 border-t border-border bg-card px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
              <Button type="button" variant="ghost" onClick={goBack}>{step === 'mode' ? '取消' : '上一步'}</Button>
              <Button type="button" onClick={() => setStep(step === 'mode' ? 'agent' : 'configure')}
                disabled={!writable || (step === 'agent' && !selectedAgentId)} className="min-h-11 min-w-36">
                {step === 'mode' ? '下一步：选择设备' : '下一步：配置任务'} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}

function DeviceAgentCard({
  agent,
  tasks,
  writable,
  onAssign,
  onEditPlan,
  onSaved,
}: {
  agent: CloudAgent
  tasks: CloudTask[]
  writable: boolean
  onAssign: (agent: CloudAgent) => void
  onEditPlan: (agent: CloudAgent) => void
  onSaved: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const relatedActiveTasks = tasks.filter(task => taskBelongsToAgent(task, agent) && ACTIVE_TASK_STATUSES.has(task.effective_status || task.status))
  const workloadKnown = agent.active_task_count !== undefined || agent.queued_task_count !== undefined
  const activeTaskCount = workloadKnown ? safeNumber(agent.active_task_count) : relatedActiveTasks.length
  const queuedTaskCount = workloadKnown ? safeNumber(agent.queued_task_count) : 0
  const blockReason = agentAssignmentBlockReason(agent, 'one_time')
  const hasPlan = hasConfiguredUnattendedPlan(agent.unattended_plan)

  return (
    <article className="rounded-2xl border border-border/70 bg-card p-3.5 shadow-xs">
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}><Bot className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-bold">{agent.display_name}</h4>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${agent.status === 'paused' ? 'bg-status-orange/10 text-amber-700 dark:text-amber-300' : agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
              {agent.status === 'paused' ? <CircleOff className="h-3 w-3" /> : agent.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {agent.status === 'paused' ? '已暂停' : agent.online ? '在线' : '离线'}
            </span>
          </div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{agent.browser_name} · {agent.operating_system} · v{agent.app_version || '未知'}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {agentCreatePlatforms(agent).length > 0
              ? agentCreatePlatforms(agent).map(platform => <span key={platform} className="rounded-md bg-primary/8 px-2 py-1 text-[10px] font-medium text-primary">{PLATFORM_LABELS[platform] || platform}</span>)
              : <span className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">无可用平台</span>}
            <span className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">
              {activeTaskCount > 0 ? `执行中 ${activeTaskCount}` : queuedTaskCount > 0 ? '无执行任务' : '空闲'}
              {queuedTaskCount > 0 ? ` · 排队 ${queuedTaskCount}` : ''}
            </span>
          </div>
        </div>
      </div>
      {agent.last_error && <div role="alert" className="mt-3 rounded-lg bg-status-red/8 px-2.5 py-2 text-[11px] leading-4 text-status-red">节点异常：{agent.last_error}</div>}
      {blockReason && <p className="mt-2 text-[11px] leading-4 text-status-red">{blockReason}</p>}
      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
        <Button size="sm" onClick={() => onAssign(agent)} disabled={!writable || Boolean(blockReason)} className="min-h-10">
          <Plus className="h-4 w-4" /> 分配任务
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label={`管理 ${agent.display_name}`} className="min-h-10 px-3">
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>
      {open && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>最后心跳：{formatTime(agent.last_heartbeat_at)}</span>
            <span>{agent.client_uuid.slice(0, 8)}</span>
          </div>
          <UnattendedPlanSummary plan={agent.unattended_plan} mirroredAt={agent.unattended_plan_updated_at} />
          {hasPlan && (
            <Button variant="outline" size="sm" onClick={() => onEditPlan(agent)} disabled={!writable || agent.capabilities?.remoteUnattendedPlanWrite !== true} className="mt-2 min-h-10 w-full">
              <Pencil className="h-3.5 w-3.5" /> 编辑无人值守计划
            </Button>
          )}
          {writable && <div className="mt-3"><AgentEditor key={`${agent.id}:${agent.display_name}:${agent.host_label}:${agent.status}:${(agent.allowed_platforms || []).join(',')}`} agent={agent} onSaved={onSaved} /></div>}
        </div>
      )}
    </article>
  )
}

function TaskCard({
  task,
  writable,
  actionTaskId,
  onResume,
  onStop,
  onOpenOrchestration,
}: {
  task: CloudTask
  writable: boolean
  actionTaskId: string
  onResume: (task: CloudTask) => Promise<void>
  onStop: (task: CloudTask) => Promise<void>
  onOpenOrchestration: (task: CloudTask) => void
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const effectiveStatus = task.effective_status || task.status
  const progress = taskProgress(task)
  const orchestration = task.task_type === 'capture_orchestration'
  const resumable = !orchestration && canResume(task)
  const stoppable = !orchestration && canStop(task)
  const commandPending = Boolean(task.pending_command_id)
  const stopPending = task.pending_command_type === 'stop'
  const resumeBlocked = resumable ? resumeBlockReason(task) : ''
  const taskError = taskErrorText(task)
  const taskMode = orchestration ? '多 Agent 编排' : task.source === 'cloud' && task.task_type.includes('plan') ? '自动计划' : task.source === 'cloud' ? '一次性任务' : '设备任务'

  return (
    <article className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTone(effectiveStatus)}`}>{STATUS_LABELS[effectiveStatus] || effectiveStatus}</span>
            <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">{PLATFORM_LABELS[task.platform] || task.platform}</span>
            <span className="text-[11px] text-muted-foreground">{taskMode}</span>
          </div>
          <h4 className="mt-2.5 truncate text-[15px] font-bold">{task.title || '采集任务'}</h4>
          {orchestration ? (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <ClipboardList className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span>父任务</span><ChevronRight className="h-3.5 w-3.5 shrink-0" />
              <Network className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="text-foreground">{safeNumber(task.counts?.total ?? task.progress?.total)} 个关键词工作项</span>
              <span>· 分配版本 {task.orchestration_revision || 0}</span>
            </div>
          ) : (
            <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <ClipboardList className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="shrink-0">任务</span><ChevronRight className="h-3.5 w-3.5 shrink-0" />
              <Bot className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-foreground">{task.agent_host_label || '未分配设备'} › {task.agent_display_name || '未分配节点'}</span>
              <span className={`shrink-0 ${task.agent_online ? 'text-status-green' : ''}`}>{task.agent_online ? '在线' : '离线'}</span>
            </div>
          )}
          {task.message && <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{task.message}</p>}
          {taskError && taskError !== task.message && <p role="alert" className="mt-2 line-clamp-2 text-xs leading-5 text-status-red">{taskError}</p>}
        </div>
        {(orchestration || resumable || stoppable || commandPending) && (
          <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
            {orchestration && (
              <Button size="sm" onClick={() => onOpenOrchestration(task)}>
                <Network className="h-4 w-4" /> 查看编排
              </Button>
            )}
            {resumable && !commandPending && (
              <Button size="sm" onClick={() => void onResume(task)} disabled={!writable || Boolean(resumeBlocked) || actionTaskId === task.id}>
                {actionTaskId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {resumeBlocked ? '暂时不能继续' : task.agent_online ? '继续剩余任务' : '上线后继续'}
              </Button>
            )}
            {stoppable && !stopPending && (
              <Button variant="destructive" size="sm" onClick={() => void onStop(task)} disabled={!writable || actionTaskId === task.id}>
                {actionTaskId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
                {task.agent_online ? '停止任务' : '上线后停止'}
              </Button>
            )}
            {stopPending && <Button variant="destructive" size="sm" disabled><Loader2 className="h-4 w-4 animate-spin" />{task.agent_online ? '等待设备停止' : '已排队，上线后停止'}</Button>}
            {commandPending && !stoppable && !stopPending && <Button size="sm" disabled><Loader2 className="h-4 w-4 animate-spin" />等待设备响应</Button>}
          </div>
        )}
      </div>
      {progress.total > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground"><span>总体进度</span><span>{progress.current}/{progress.total} · {progress.percent}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="任务总体进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} /></div>
        </div>
      )}
      <button type="button" onClick={() => setDetailsOpen(value => !value)} aria-expanded={detailsOpen}
        className="mt-3 flex min-h-9 w-full items-center justify-between border-t border-border/60 pt-3 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground">
        <span>创建于 {formatTime(task.created_at || task.updated_at)}</span>
        <span className="flex items-center gap-1">运行详情 {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</span>
      </button>
      {detailsOpen && (
        <div className="mt-2 grid gap-2 rounded-xl bg-muted/45 p-3 text-[11px] text-muted-foreground sm:grid-cols-2">
          {orchestration ? (
            <>
              <div>关键词工作项：<span className="text-foreground">{safeNumber(task.counts?.total ?? task.progress?.total)} 项</span></div>
              <div>已结算：<span className="text-foreground">{safeNumber(task.progress?.current)} 项</span></div>
              <div>分配版本：<span className="text-foreground">第 {task.orchestration_revision || 0} 版</span></div>
              <div>最后更新：<span className="text-foreground">{formatTime(task.updated_at)}</span></div>
            </>
          ) : (
            <>
              <div>设备心跳：<span className="text-foreground">{formatTime(task.agent_last_heartbeat_at)}</span></div>
              <div>任务心跳：<span className="text-foreground">{formatTime(task.heartbeat_at)}</span></div>
              <div>业务进展：<span className="text-foreground">{formatTime(task.business_progress_at)}</span></div>
              <div>最后更新：<span className="text-foreground">{formatTime(task.updated_at)}</span></div>
              {task.attempt_number ? <div>执行次数：<span className="text-foreground">第 {task.attempt_number} 次</span></div> : null}
              {commandPending && task.pending_command_expires_at ? <div>指令保留至：<span className="text-foreground">{formatTime(task.pending_command_expires_at)}</span></div> : null}
              {resumeBlocked && !commandPending ? <div className="text-status-red sm:col-span-2">继续阻断：{resumeBlocked}</div> : null}
            </>
          )}
        </div>
      )}
    </article>
  )
}

export function CloudTasksTab() {
  const { canWrite } = useAuth()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionTaskId, setActionTaskId] = useState('')
  const [taskView, setTaskView] = useState<TaskView>('active')
  const [composerIntent, setComposerIntent] = useState<ComposerIntent | null>(null)
  const [orchestrationComposerOpen, setOrchestrationComposerOpen] = useState(false)
  const [selectedOrchestrationId, setSelectedOrchestrationId] = useState<string | null>(null)
  const [orchestrationRefreshKey, setOrchestrationRefreshKey] = useState(0)
  const loadGeneration = useRef(0)
  const orchestrationDetailDialogRef = useRef<HTMLDivElement | null>(null)

  const closeOrchestrationComposer = useCallback(() => {
    setOrchestrationComposerOpen(false)
  }, [])

  const closeOrchestrationDetail = useCallback(() => {
    setSelectedOrchestrationId(null)
  }, [])

  const load = useCallback(async (quiet = false) => {
    const generation = ++loadGeneration.current
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await api.get<Overview & { ok: boolean }>('/capture-cloud/overview')
      if (generation !== loadGeneration.current) return
      setOverview({ agents: data.agents || [], tasks: data.tasks || [], summary: data.summary })
      setError('')
    } catch (err) {
      if (generation !== loadGeneration.current) return
      setError(err instanceof Error ? err.message : '读取云端任务中心失败')
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => void load(true), 15_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [load])

  useEffect(() => {
    if (!selectedOrchestrationId) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTimer = window.setTimeout(() => {
      const initialFocus = orchestrationDetailDialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      if (initialFocus) initialFocus.focus()
      else orchestrationDetailDialogRef.current?.focus()
    }, 0)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeOrchestrationDetail()
        return
      }
      if (event.key !== 'Tab' || !orchestrationDetailDialogRef.current) return
      const focusable = Array.from(orchestrationDetailDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        orchestrationDetailDialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [closeOrchestrationDetail, selectedOrchestrationId])

  const groupedAgents = useMemo(() => {
    const groups = new Map<string, CloudAgent[]>()
    for (const agent of overview?.agents || []) {
      const key = agent.host_label || agent.operating_system || '未命名设备'
      groups.set(key, [...(groups.get(key) || []), agent])
    }
    return Array.from(groups.entries())
  }, [overview?.agents])

  const businessTasks = useMemo(
    () => (overview?.tasks || []).filter(isBusinessVisibleTask),
    [overview?.tasks],
  )

  const visibleTasks = useMemo(() => {
    const tasks = [...businessTasks]
    return tasks.filter(task => {
      const status = task.effective_status || task.status
      if (taskView === 'active') return ACTIVE_TASK_STATUSES.has(status)
      if (taskView === 'attention') return ATTENTION_TASK_STATUSES.has(status)
      return !ACTIVE_TASK_STATUSES.has(status) && !ATTENTION_TASK_STATUSES.has(status)
    }).sort((left, right) => {
      const leftTime = new Date(left.created_at || left.updated_at || left.finished_at || 0).getTime()
      const rightTime = new Date(right.created_at || right.updated_at || right.finished_at || 0).getTime()
      return rightTime - leftTime
    })
  }, [businessTasks, taskView])

  const taskCounts = useMemo(() => {
    const counts = { active: 0, attention: 0, history: 0 }
    for (const task of businessTasks) {
      const status = task.effective_status || task.status
      if (ACTIVE_TASK_STATUSES.has(status)) counts.active += 1
      else if (ATTENTION_TASK_STATUSES.has(status)) counts.attention += 1
      else counts.history += 1
    }
    return counts
  }, [businessTasks])

  const resume = async (task: CloudTask) => {
    setActionTaskId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>('/capture-cloud/tasks/' + task.id + '/resume', { mode: 'remaining' })
      setFeedback(result.message || '已发送继续指令')
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '发送继续指令失败')
    } finally {
      setActionTaskId('')
    }
  }

  const stop = async (task: CloudTask) => {
    if (!window.confirm(`确定停止“${task.title || '当前任务'}”吗？已采集的结果会保留。`)) return
    setActionTaskId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>('/capture-cloud/tasks/' + task.id + '/stop', {})
      setFeedback(result.message || '已发送停止指令')
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '发送停止指令失败')
    } finally {
      setActionTaskId('')
    }
  }

  if (loading && !overview) {
    return <div className="flex justify-center py-24"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
  }

  const summary = overview?.summary || { agents: 0, onlineAgents: 0, runningTasks: 0, attentionTasks: 0 }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-[22px] border border-border/70 bg-card shadow-sm">
        <div className="flex flex-col gap-4 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-primary">
              <CloudCog className="h-4 w-4" /> Task Dispatch
              <span className="rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[10px] tracking-wider">Beta</span>
            </div>
            <h2 className="mt-2 text-xl font-bold text-foreground">任务调度台</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">创建采集任务，明确分配给一个浏览器节点，再持续跟踪排队、执行、中断与恢复。设备像 Agent，任务就是交给它的工作。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing} className="min-h-10">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> 刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => setComposerIntent({})} disabled={!canWrite()} className="min-h-10 px-4" aria-label="新建单节点关键词采集任务">
              <Plus className="h-4 w-4" /> 单节点任务
            </Button>
            <Button size="sm" onClick={() => setOrchestrationComposerOpen(true)} disabled={!canWrite()} className="min-h-10 px-4" aria-label="新建多 Agent 编排任务">
              <Network className="h-4 w-4" /> 多 Agent 编排
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 border-t border-border/60 lg:grid-cols-4">
          <SummaryStat label="执行节点" value={summary.agents} icon={ServerCog} />
          <SummaryStat label="在线节点" value={summary.onlineAgents} icon={Wifi} tone="green" />
          <SummaryStat label="正在执行" value={taskCounts.active} icon={Activity} tone="blue" selected={taskView === 'active'} onClick={() => setTaskView('active')} />
          <SummaryStat label="需要处理" value={taskCounts.attention} icon={AlertTriangle} tone={taskCounts.attention ? 'red' : 'default'} selected={taskView === 'attention'} onClick={() => setTaskView('attention')} />
        </div>
      </section>

      {error && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">{error}</div>}
      {actionError && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">{actionError}</div>}
      {feedback && <div role="status" aria-live="polite" className="rounded-xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-primary">{feedback}</div>}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.72fr)]">
        <section className="min-w-0">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2"><ListChecks className="h-4 w-4 text-primary" /><h3 className="text-base font-bold">任务队列</h3></div>
              <p className="mt-1 text-xs text-muted-foreground">按创建时间倒序，新任务在最前；当前展示最近 {businessTasks.length} 条业务任务</p>
            </div>
            <div className="flex rounded-xl border border-border bg-card p-1" role="tablist" aria-label="任务分组">
              {([
                { value: 'active' as const, label: '执行中', count: taskCounts.active },
                { value: 'attention' as const, label: '需处理', count: taskCounts.attention },
                { value: 'history' as const, label: '历史', count: taskCounts.history },
              ]).map(item => (
                <button key={item.value} type="button" role="tab" aria-selected={taskView === item.value} onClick={() => setTaskView(item.value)}
                  className={`min-h-9 rounded-lg px-3 text-xs font-semibold transition-colors ${taskView === item.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                  {item.label} <span className="ml-1 tabular-nums opacity-80">{item.count}</span>
                </button>
              ))}
            </div>
          </div>

          {visibleTasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-12 text-center">
              {taskView === 'attention' ? <CheckCircle2 className="mx-auto h-7 w-7 text-status-green" /> : taskView === 'history' ? <History className="mx-auto h-7 w-7 text-muted-foreground" /> : <ClipboardList className="mx-auto h-7 w-7 text-primary" />}
              <div className="mt-3 text-sm font-semibold">{taskView === 'active' ? '当前没有执行中或排队中的任务' : taskView === 'attention' ? '当前没有需要人工处理的任务' : '最近任务中还没有历史记录'}</div>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{taskView === 'active' ? '新建任务后，先分配一个执行节点；节点离线时会保留在云端队列。' : taskView === 'attention' ? '中断、失败和部分失败会集中出现在这里。' : '已完成、已停止和已跳过的任务会进入历史。'}</p>
              {taskView === 'active' && canWrite() && (
                <div className="mt-4 flex justify-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setComposerIntent({})}><Plus className="h-4 w-4" /> 单节点任务</Button>
                  <Button size="sm" onClick={() => setOrchestrationComposerOpen(true)}><Network className="h-4 w-4" /> 多 Agent 编排</Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {visibleTasks.map(task => (
                <TaskCard key={task.id} task={task} writable={canWrite()} actionTaskId={actionTaskId} onResume={resume} onStop={stop}
                  onOpenOrchestration={selected => setSelectedOrchestrationId(selected.id)} />
              ))}
            </div>
          )}
        </section>

        <aside className="min-w-0 xl:sticky xl:top-4">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /><h3 className="text-base font-bold">执行设备</h3></div>
              <p className="mt-1 text-xs text-muted-foreground">同一台电脑的多个浏览器会作为独立执行 Agent</p>
            </div>
            <span className="shrink-0 text-[11px] text-muted-foreground">2 分钟无心跳视为离线</span>
          </div>
          {groupedAgents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center">
              <CircleOff className="mx-auto h-7 w-7 text-muted-foreground" />
              <div className="mt-3 text-sm font-semibold">还没有执行节点</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">客户 Extension 重新验证激活码后，会自动注册到这里。</p>
            </div>
          ) : (
            <div className="space-y-4">
              {groupedAgents.map(([hostLabel, agents]) => (
                <section key={hostLabel} aria-label={hostLabel}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <Laptop className="h-4 w-4 text-primary" />
                    <h4 className="min-w-0 truncate text-sm font-bold">{hostLabel}</h4>
                    <span className="text-[11px] text-muted-foreground">{agents.length} 个节点</span>
                  </div>
                  <div className="space-y-2.5">
                    {agents.map(agent => (
                      <DeviceAgentCard key={agent.id} agent={agent} tasks={businessTasks} writable={canWrite()}
                        onAssign={selected => setComposerIntent({ agentId: selected.id })}
                        onEditPlan={selected => setComposerIntent({ agentId: selected.id, mode: 'unattended_plan', editExisting: true })}
                        onSaved={() => load(true)} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </aside>
      </div>

      {composerIntent && (
        <TaskAssignmentDrawer agents={overview?.agents || []} tasks={businessTasks} writable={canWrite()} intent={composerIntent}
          onClose={() => setComposerIntent(null)}
          onCreated={async () => {
            setFeedback('任务已创建并分配给指定执行节点。')
            await load(true)
          }} />
      )}

      <OrchestrationComposerDrawer
        open={orchestrationComposerOpen}
        writable={canWrite()}
        agents={overview?.agents || []}
        onClose={closeOrchestrationComposer}
        onChanged={async () => {
          setOrchestrationRefreshKey(value => value + 1)
          await load(true)
        }}
        onDispatched={async result => {
          setFeedback(`多 Agent 任务已拆分为 ${result.executions.length} 条执行指令。`)
          setOrchestrationRefreshKey(value => value + 1)
          await load(true)
        }}
      />

      {selectedOrchestrationId && (
        <div ref={orchestrationDetailDialogRef}
          className="fixed inset-0 z-[60] overflow-y-auto bg-black/35 p-0 outline-none sm:p-4 lg:p-8"
          role="dialog" aria-modal="true" aria-labelledby="orchestration-detail-title" tabIndex={-1}
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeOrchestrationDetail()
          }}>
          <div className="mx-auto max-w-6xl">
            <OrchestrationDetailWorkspace
              orchestrationId={selectedOrchestrationId}
              refreshKey={orchestrationRefreshKey}
              writable={canWrite()}
              onClose={closeOrchestrationDetail}
              onChanged={async () => {
                setOrchestrationRefreshKey(value => value + 1)
                await load(true)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryStat({ label, value, icon: Icon, tone = 'default', selected = false, onClick }: { label: string; value: number; icon: React.ElementType; tone?: 'default' | 'green' | 'blue' | 'red'; selected?: boolean; onClick?: () => void }) {
  const colors = { default: 'text-foreground', green: 'text-status-green', blue: 'text-primary', red: 'text-status-red' }
  const content = (
    <>
      <Icon className={`h-5 w-5 ${colors[tone]}`} /><div><div className={`text-lg font-bold tabular-nums ${colors[tone]}`}>{value}</div><div className="text-[11px] text-muted-foreground">{label}</div></div>
    </>
  )
  if (onClick) return <button type="button" onClick={onClick} aria-pressed={selected} className={`flex min-h-16 items-center gap-3 border-b border-r border-border/60 px-4 py-3.5 text-left transition-colors last:border-r-0 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary lg:border-b-0 ${selected ? 'bg-primary/[0.045]' : ''}`}>{content}</button>
  return <div className="flex min-h-16 items-center gap-3 border-b border-r border-border/60 px-4 py-3.5 last:border-r-0 lg:border-b-0">{content}</div>
}
