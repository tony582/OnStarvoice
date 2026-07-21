import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp,
  CircleOff, CloudCog, Laptop, Loader2, Pencil, Play, Plus, RefreshCw, Save,
  ServerCog, Square, Wifi, WifiOff,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'

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
}

type CloudTask = {
  id: string
  client_task_id: string
  control_task_id: string
  task_type: string
  source?: string
  title: string
  platform: string
  status: string
  effective_status?: string
  progress?: Record<string, unknown>
  counts?: Record<string, unknown>
  message?: string
  error?: Record<string, unknown>
  attempt_number?: number
  heartbeat_at?: string | null
  business_progress_at?: string | null
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
}: {
  agent: CloudAgent
  writable: boolean
  onCreated: () => Promise<void>
}) {
  const remoteTaskCreate = agent.capabilities?.remoteTaskCreate === true
  const remoteUnattendedPlanWrite = agent.capabilities?.remoteUnattendedPlanWrite === true
  const remoteTaskEnhancementOptions = agent.capabilities?.remoteTaskEnhancementOptions === true
  const remoteTaskKeywordPostLimit = agent.capabilities?.remoteTaskKeywordPostLimit === true
  const availablePlatforms = useMemo(() => agentCreatePlatforms(agent), [agent])
  const [open, setOpen] = useState(false)
  const [executionMode, setExecutionMode] = useState<'one_time' | 'unattended_plan'>('one_time')
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
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="space-y-1.5">
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
      </div>
      {open && (
        <form className="mt-3 space-y-3" onSubmit={submit}>
          {editingExistingPlan && (
            <div className="rounded-lg border border-status-orange/30 bg-status-orange/8 px-3 py-2.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              <div className="font-semibold">正在修改该设备的现有无人值守计划</div>
              <p className="mt-1">保存修改会覆盖当前设备计划，并在设备端重新启用；新建一次性任务不会改动这份计划。</p>
              <p className="mt-1">正在运行的任务继续使用启动时的旧快照；新配置从后续排期生效。</p>
            </div>
          )}
          <p className={`rounded-lg px-2.5 py-2 text-[11px] leading-4 ${agent.online && agent.status === 'active' ? 'bg-status-green/8 text-status-green' : 'bg-status-orange/8 text-amber-700 dark:text-amber-300'}`}>{nodeMessage}</p>
          {!writable && <p className="text-[11px] leading-4 text-muted-foreground">当前账号为只读权限，不能创建任务。</p>}
          <div>
            <div className="text-xs font-medium text-muted-foreground">执行方式</div>
            <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="执行方式">
              <button type="button" role="tab" aria-selected={executionMode === 'one_time'}
                onClick={() => editingExistingPlan ? resetNewTaskForm() : setExecutionMode('one_time')} disabled={disabled}
                className={`min-h-9 rounded-md px-3 text-xs font-semibold transition-colors ${executionMode === 'one_time' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                一次性
              </button>
              <button type="button" role="tab" aria-selected={executionMode === 'unattended_plan'}
                onClick={() => setExecutionMode('unattended_plan')} disabled={disabled || !remoteUnattendedPlanWrite}
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

export function CloudTasksTab() {
  const { canWrite } = useAuth()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionTaskId, setActionTaskId] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const loadGeneration = useRef(0)

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

  const groupedAgents = useMemo(() => {
    const groups = new Map<string, CloudAgent[]>()
    for (const agent of overview?.agents || []) {
      const key = agent.host_label || agent.operating_system || '未命名设备'
      groups.set(key, [...(groups.get(key) || []), agent])
    }
    return Array.from(groups.entries())
  }, [overview?.agents])

  const visibleTasks = useMemo(() => {
    const active = new Set(['pending', 'waiting_device', 'claimed', 'running', 'recovering', 'interrupted', 'resume_requested', 'needs_action', 'failed', 'completed_with_failures'])
    return (overview?.tasks || []).filter(task => showHistory || active.has(task.effective_status || task.status))
  }, [overview?.tasks, showHistory])

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
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-primary"><CloudCog className="h-4 w-4" /> Cloud Task Center</div>
            <h2 className="mt-2 text-xl font-bold text-foreground">云端采集任务中心</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">查看不同浏览器节点的实时进度，也可为指定节点新建任务或继续中断任务。离线、忙碌设备会排队等待，不会假装正在执行。</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> 刷新
          </Button>
        </div>
        <div className="grid grid-cols-2 border-t border-border/60 lg:grid-cols-4">
          <SummaryStat label="采集节点" value={summary.agents} icon={ServerCog} />
          <SummaryStat label="在线节点" value={summary.onlineAgents} icon={Wifi} tone="green" />
          <SummaryStat label="运行任务" value={summary.runningTasks} icon={Activity} tone="blue" />
          <SummaryStat label="需要处理" value={summary.attentionTasks} icon={AlertTriangle} tone={summary.attentionTasks ? 'red' : 'default'} />
        </div>
      </section>

      {error && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">{error}</div>}
      {actionError && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">{actionError}</div>}
      {feedback && <div role="status" className="rounded-xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-primary">{feedback}</div>}

      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div><h3 className="text-base font-bold">执行设备</h3><p className="mt-0.5 text-xs text-muted-foreground">同一台电脑的多个浏览器，需要把“所属设备”改成完全相同的名称后归组</p></div>
          <span className="text-xs text-muted-foreground">2分钟无心跳视为离线</span>
        </div>
        {groupedAgents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center">
            <CircleOff className="mx-auto h-7 w-7 text-muted-foreground" />
            <div className="mt-3 text-sm font-semibold">还没有采集节点</div>
            <p className="mt-1 text-xs text-muted-foreground">客户扩展重新验证激活码后，会自动注册到这里。</p>
          </div>
        ) : (
          <div className="space-y-3">
            {groupedAgents.map(([hostLabel, agents]) => (
              <article key={hostLabel} className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs">
                <div className="mb-3 flex items-center gap-2"><Laptop className="h-4 w-4 text-primary" /><h4 className="text-sm font-bold">{hostLabel}</h4><span className="text-xs text-muted-foreground">{agents.length} 个浏览器节点</span></div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {agents.map(agent => (
                    <div key={agent.id} className="rounded-xl border border-border/70 bg-background/70 p-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><div className="truncate text-sm font-bold">{agent.display_name}</div><div className="mt-1 text-[11px] text-muted-foreground">{agent.browser_name} · {agent.operating_system} · v{agent.app_version || '未知'} · {agent.client_uuid.slice(0, 8)}</div><div className="mt-0.5 truncate text-[11px] text-muted-foreground">{agent.client_label}</div></div>
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${agent.status === 'paused' ? 'bg-status-orange/10 text-amber-700 dark:text-amber-300' : agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
                          {agent.status === 'paused' ? <CircleOff className="h-3 w-3" /> : agent.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{agent.status === 'paused' ? '已暂停' : agent.online ? '在线' : '离线'}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {(agent.allowed_platforms || []).length > 0
                          ? agent.allowed_platforms.map(platform => <span key={platform} className="rounded-md bg-primary/8 px-2 py-1 text-[11px] font-medium text-primary">{PLATFORM_LABELS[platform] || platform}</span>)
                          : <span className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">平台未限制</span>}
                      </div>
                      <div className="mt-3 text-[11px] text-muted-foreground">最后心跳：{formatTime(agent.last_heartbeat_at)}</div>
                      {agent.last_error && <div role="alert" className="mt-2 rounded-lg bg-status-red/8 px-2.5 py-2 text-[11px] text-status-red">节点异常：{agent.last_error}</div>}
                      <UnattendedPlanSummary plan={agent.unattended_plan} mirroredAt={agent.unattended_plan_updated_at} />
                      <AgentTaskCreator agent={agent} writable={canWrite()} onCreated={() => load(true)} />
                      {canWrite() && <AgentEditor key={`${agent.id}:${agent.display_name}:${agent.host_label}:${agent.status}:${(agent.allowed_platforms || []).join(',')}`} agent={agent} onSaved={() => load(true)} />}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h3 className="text-base font-bold">采集任务</h3><p className="mt-0.5 text-xs text-muted-foreground">设备心跳、任务心跳和业务进展分别记录；离线恢复指令保留 30 天</p></div>
          <Button variant="ghost" size="sm" onClick={() => setShowHistory(value => !value)}>{showHistory ? '只看进行中' : '查看历史'}</Button>
        </div>
        {visibleTasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center">
            <CheckCircle2 className="mx-auto h-7 w-7 text-status-green" /><div className="mt-3 text-sm font-semibold">当前没有需要处理的云端任务</div>
          </div>
        ) : (
          <div className="space-y-3">
            {visibleTasks.map(task => {
              const effectiveStatus = task.effective_status || task.status
              const progress = taskProgress(task)
              const resumable = canResume(task)
              const stoppable = canStop(task)
              const commandPending = Boolean(task.pending_command_id)
              const stopPending = task.pending_command_type === 'stop'
              const resumeBlocked = resumable ? resumeBlockReason(task) : ''
              const taskError = taskErrorText(task)
              return (
                <article key={task.id} className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTone(effectiveStatus)}`}>{STATUS_LABELS[effectiveStatus] || effectiveStatus}</span>
                        <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">{PLATFORM_LABELS[task.platform] || task.platform}</span>
                        {task.attempt_number ? <span className="text-[11px] text-muted-foreground">第 {task.attempt_number} 次执行</span> : null}
                      </div>
                      <h4 className="mt-2.5 truncate text-[15px] font-bold">{task.title || '采集任务'}</h4>
                      <div className="mt-1 text-xs text-muted-foreground">{task.agent_host_label || '未分配设备'} · {task.agent_display_name || '未分配节点'} · {task.agent_online ? '在线' : '离线'}</div>
                      {task.message && <p className="mt-2 text-xs leading-5 text-muted-foreground">{task.message}</p>}
                      {taskError && taskError !== task.message && <p role="alert" className="mt-2 text-xs leading-5 text-status-red">{taskError}</p>}
                    </div>
                    {(resumable || stoppable || commandPending) && (
                      <div className="shrink-0 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {resumable && !commandPending && (
                            <Button size="sm" onClick={() => resume(task)} disabled={!canWrite() || Boolean(resumeBlocked) || actionTaskId === task.id}>
                              {actionTaskId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                              {resumeBlocked ? '暂时不能继续' : task.agent_online ? '继续剩余任务' : '上线后继续'}
                            </Button>
                          )}
                          {stoppable && !stopPending && (
                            <Button variant="destructive" size="sm" onClick={() => stop(task)} disabled={!canWrite() || actionTaskId === task.id}>
                              {actionTaskId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
                              {task.agent_online ? '停止任务' : '上线后停止'}
                            </Button>
                          )}
                          {stopPending && (
                            <Button variant="destructive" size="sm" disabled>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              {task.agent_online ? '等待设备停止' : '已排队，上线后停止'}
                            </Button>
                          )}
                          {commandPending && !stoppable && !stopPending && (
                            <Button size="sm" disabled><Loader2 className="h-4 w-4 animate-spin" />等待设备响应</Button>
                          )}
                        </div>
                        {resumeBlocked && !commandPending && <p className="mt-1.5 max-w-44 text-[11px] text-status-red">{resumeBlocked}</p>}
                        {commandPending && task.pending_command_expires_at && <p className="mt-1.5 text-[11px] text-muted-foreground">排队保留至 {formatTime(task.pending_command_expires_at)}</p>}
                      </div>
                    )}
                  </div>
                  {progress.total > 0 && (
                    <div className="mt-4">
                      <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground"><span>总体进度</span><span>{progress.current}/{progress.total} · {progress.percent}%</span></div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} /></div>
                    </div>
                  )}
                  <div className="mt-4 grid gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                    <div>设备心跳：<span className="text-foreground">{formatTime(task.agent_last_heartbeat_at)}</span></div>
                    <div>任务心跳：<span className="text-foreground">{formatTime(task.heartbeat_at)}</span></div>
                    <div>业务进展：<span className="text-foreground">{formatTime(task.business_progress_at)}</span></div>
                    <div>最后更新：<span className="text-foreground">{formatTime(task.updated_at)}</span></div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function SummaryStat({ label, value, icon: Icon, tone = 'default' }: { label: string; value: number; icon: React.ElementType; tone?: 'default' | 'green' | 'blue' | 'red' }) {
  const colors = { default: 'text-foreground', green: 'text-status-green', blue: 'text-primary', red: 'text-status-red' }
  return (
    <div className="flex items-center gap-3 border-b border-r border-border/60 px-4 py-3.5 last:border-r-0 lg:border-b-0">
      <Icon className={`h-5 w-5 ${colors[tone]}`} /><div><div className={`text-lg font-bold tabular-nums ${colors[tone]}`}>{value}</div><div className="text-[11px] text-muted-foreground">{label}</div></div>
    </div>
  )
}
