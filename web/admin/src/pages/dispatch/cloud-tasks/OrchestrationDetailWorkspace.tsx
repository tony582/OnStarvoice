import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Clock3,
  Loader2,
  Pause,
  Pencil,
  Play,
  Send,
  ShieldAlert,
  RefreshCw,
  Square,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  OrchestrationAttemptRecord,
  OrchestrationCloudAgent,
  OrchestrationDetailResponse,
  OrchestrationDetailWorkspaceProps,
  OrchestrationExecutionRecord,
  OrchestrationItemRecord,
} from './types'
// 平台/状态文案与时间格式化统一以 lib.ts 为准，避免两处定义漂移。
import { PLATFORM_LABELS, STATUS_LABELS, formatTime } from './lib'
import { KeywordExecutionReport } from './KeywordExecutionReport'
import {
  allocateKeywordRetryItems,
  buildKeywordRetryAssignments,
} from './retry-item-allocation.js'

const SORT_LABELS: Record<string, string> = {
  comprehensive: '综合排序',
  latest: '最新发布',
  likes: '最多点赞',
  comments: '最多评论',
  collects: '最多收藏',
}

const PUBLISH_TIME_LABELS: Record<string, string> = {
  all: '不限时间',
  day: '一天内',
  week: '一周内',
  halfyear: '半年内',
}

const CONTENT_TYPE_LABELS: Record<string, string> = {
  all: '全部内容',
  video: '视频',
  image: '图文',
}
const SEARCH_SCOPE_LABELS: Record<string, string> = {
  all: '全部范围',
  viewed: '已看过',
  unviewed: '未看过',
  followed: '已关注',
}
const DISTANCE_LABELS: Record<string, string> = {
  all: '不限距离',
  city: '同城',
  nearby: '附近',
}
const VIDEO_DURATION_LABELS: Record<string, string> = {
  all: '不限时长',
  under_1m: '1 分钟以内',
  '1_5m': '1–5 分钟',
  over_5m: '5 分钟以上',
}

const SUCCESS_ITEM_STATUSES = new Set(['completed', 'completed_with_warnings'])
const SETTLED_ITEM_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'])
const FAILURE_STATUSES = new Set(['retryable', 'needs_action', 'failed', 'interrupted', 'completed_with_failures'])
const ACTIVE_STATUSES = new Set(['pending', 'assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'claimed', 'running', 'recovering'])
const STOPPABLE_EXECUTION_STATUSES = new Set([
  'pending', 'assigned', 'dispatch_pending', 'dispatched', 'waiting_device',
  'claimed', 'running', 'recovering', 'interrupted',
  'resume_requested', 'needs_action', 'failed', 'completed_with_failures',
])
const STOPPABLE_ORCHESTRATION_STATUSES = new Set([
  'pending', 'assigned', 'dispatch_pending', 'dispatched', 'waiting_device',
  'claimed', 'running', 'recovering', 'interrupted',
  'resume_requested', 'needs_action', 'failed', 'completed_with_failures',
])
const FINAL_EXECUTION_STATUSES = new Set([
  'completed', 'completed_with_warnings', 'completed_with_failures',
  'failed', 'canceled', 'skipped', 'superseded',
])
const FINAL_ORCHESTRATION_STATUSES = new Set([
  'completed', 'completed_with_warnings', 'completed_with_failures',
  'failed', 'canceled', 'skipped', 'superseded',
])
const ELASTIC_AUTOMATIC_ATTEMPT_LIMIT = 3
const HANDOFF_UNSTARTED_EXCLUDED_STATUSES = new Set([
  'completed', 'completed_with_warnings', 'failed', 'skipped',
])
const ENDED_EXECUTION_STATUSES = new Set(['canceled', 'skipped'])
const NEGATIVE_REASSIGN_EXPLICIT_STATUSES = new Set([
  'needs_action',
  'failed',
  'retryable',
])
const NEGATIVE_REASSIGN_UNSTARTED_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
])
const NEGATIVE_REASSIGN_BLOCKING_EXECUTION_STATUSES = new Set([
  'pending',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'waiting_device',
  'resume_requested',
])
const KEYWORD_RETRY_STATUSES = new Set(['retryable', 'needs_action', 'failed'])

function elasticAttemptBudgetUsed(item: OrchestrationItemRecord) {
  const rawBudget = item.metadata?.elasticAttemptBudgetUsed
  const budget = Number(rawBudget)
  return Number.isInteger(budget) && budget >= 0
    ? budget
    : Math.max(0, Number(item.attempt_count || 0))
}

const COMMAND_STATUS_LABELS: Record<string, string> = {
  pending: '等待 Agent 领取',
  claimed: 'Agent 已领取',
  completed: '指令已完成',
  failed: '指令失败',
  canceled: '指令已取消',
  expired: '指令已过期',
  superseded: '指令已替换',
}

const SCHEDULE_STATUS_LABELS: Record<string, string> = {
  active: '计划已启用',
  paused: '计划已暂停',
  completed: '计划已结束',
  canceled: '计划已取消',
}

function statusLabel(status?: string) {
  return STATUS_LABELS[String(status || '')] || String(status || '未记录')
}

function statusTone(status?: string) {
  const value = String(status || '')
  if (FAILURE_STATUSES.has(value)) return 'border-status-red/25 bg-status-red/8 text-status-red'
  if (['completed', 'completed_with_warnings'].includes(value)) return 'border-status-green/25 bg-status-green/8 text-status-green'
  if (ACTIVE_STATUSES.has(value)) return 'border-primary/25 bg-primary/8 text-primary'
  return 'border-border bg-muted text-muted-foreground'
}

function keywordForItem(item: OrchestrationItemRecord) {
  const sourceRecord = item.metadata?.sourceRecord
  if (sourceRecord && typeof sourceRecord === 'object' && !Array.isArray(sourceRecord)) {
    const record = sourceRecord as Record<string, unknown>
    const title = String(record.title || record.content || '').trim()
    if (title) return title
  }
  if (item.keyword?.trim()) return item.keyword.trim()
  const metadataKeyword = item.metadata?.keyword
  return typeof metadataKeyword === 'string' && metadataKeyword.trim()
    ? metadataKeyword.trim()
    : item.item_key
}

function itemAvailabilityLabel(item: OrchestrationItemRecord) {
  const persistedStatus = String(item.content_availability_status || '')
  if (persistedStatus === 'deleted') return '原帖已删除'
  if (persistedStatus === 'page_unavailable') return '已删除或不可访问'
  const targetResult = item.metadata?.targetResult
  if (!targetResult || typeof targetResult !== 'object' || Array.isArray(targetResult)) return ''
  const result = targetResult as Record<string, unknown>
  const availability = result.availability && typeof result.availability === 'object' && !Array.isArray(result.availability)
    ? result.availability as Record<string, unknown>
    : {}
  const status = String(
    result.availabilityStatus
      || result.availability_status
      || availability.availabilityStatus
      || availability.availability_status
      || '',
  )
  if (status === 'deleted') return '原帖已删除'
  if (status === 'page_unavailable') return '已删除或不可访问'
  return ''
}

function executionAgentId(execution: OrchestrationExecutionRecord) {
  return String(execution.agentId || execution.agent_id || execution.assigned_agent_id || '')
}

function executionTaskId(execution: OrchestrationExecutionRecord) {
  return String(execution.taskId || execution.task_id || execution.id || '')
}

function executionItemIds(execution: OrchestrationExecutionRecord) {
  const ids = execution.itemIds || execution.item_ids
  return Array.isArray(ids) ? ids.map(String) : []
}

function executionOnline(execution: OrchestrationExecutionRecord) {
  return execution.agentOnline ?? execution.agent_online
}

function attemptItemId(attempt: OrchestrationAttemptRecord) {
  return String(attempt.itemId || attempt.item_id || '')
}

function itemAssignedAgentId(
  item: OrchestrationItemRecord,
  executions: OrchestrationExecutionRecord[],
  attempts: OrchestrationAttemptRecord[],
) {
  if (item.assigned_agent_id) return item.assigned_agent_id
  const execution = executions.find(candidate => executionItemIds(candidate).includes(item.id))
  if (execution) return executionAgentId(execution)
  const latestAttempt = [...attempts]
    .filter(candidate => attemptItemId(candidate) === item.id)
    .sort((left, right) => Number(right.attempt_number || 0) - Number(left.attempt_number || 0))[0]
  return String(latestAttempt?.agentId || latestAttempt?.agent_id || '')
}

function agentName(agent?: OrchestrationCloudAgent) {
  if (!agent) return '未记录 Agent'
  return agent.display_name || `${agent.host_label || '未命名设备'} · ${agent.browser_name || '浏览器'}`
}

function dataMessage(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return String(record.message || record.reason || record.code || '').trim()
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function formatRecoveryCountdown(waitUntil: number, now: number) {
  const remainingSeconds = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  const hours = Math.floor(remainingSeconds / 3600)
  const minutes = Math.floor((remainingSeconds % 3600) / 60)
  const seconds = remainingSeconds % 60
  const clock = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return waitUntil > now ? `${clock} 后重试` : '已到重试时间，正在等待 Agent 回报'
}

function formatAgentCooldownCountdown(waitUntil: number, now: number) {
  const remainingSeconds = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return waitUntil > now ? `原 Agent 冷却 ${clock}` : '原 Agent 冷却已结束'
}

function safetyDiagnostic(value: unknown): boolean {
  if (!value) return false
  if (typeof value === 'string') {
    return /platform[_ -]?safety|security[_ -]?(?:challenge|blocked)|captcha|login[_ -]?required|auth[_ -]?required|验证码|安全验证|请(?:先|重新)?登录|请选择所有符合/u.test(value)
  }
  if (Array.isArray(value)) return value.some(safetyDiagnostic)
  if (typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    /platformSafetyBlocked|securityChallenge|captcha|requiresManualAction|loginRequired|authRequired/u.test(key) || safetyDiagnostic(nested),
  )
}

function executionStatus(execution?: OrchestrationExecutionRecord) {
  return String(execution?.status || '')
}

function agentSupportsNegativePatrol(
  agent: OrchestrationCloudAgent,
  platform: string,
) {
  if (agent.status !== 'active' || !agent.online) return false
  if (agent.capabilities?.remoteTaskCreate !== true) return false
  if (agent.capabilities?.negativePostPatrol !== true) return false
  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : []
  if (
    allowedPlatforms.length > 0 &&
    !allowedPlatforms.includes(platform)
  ) {
    return false
  }
  const supportedPlatforms = agent.capabilities?.supportedPlatforms
  return !Array.isArray(supportedPlatforms) ||
    supportedPlatforms.length === 0 ||
    supportedPlatforms.includes(platform)
}

function agentSupportsKeywordRetry(
  agent: OrchestrationCloudAgent,
  platform: string,
) {
  if (agent.status !== 'active' || !agent.online) return false
  if (agent.capabilities?.remoteTaskCreate !== true) return false
  if (Number(agent.active_task_count || 0) > 0) return false
  if (Number(agent.queued_task_count || 0) > 0) return false
  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms
    : []
  if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform)) {
    return false
  }
  const supportedPlatforms = agent.capabilities?.supportedPlatforms
  return !Array.isArray(supportedPlatforms) ||
    supportedPlatforms.length === 0 ||
    supportedPlatforms.includes(platform)
}

export function OrchestrationDetailWorkspace({
  orchestrationId,
  writable = false,
  availableAgents = [],
  onClose,
  onEditPlan,
  onChanged,
  className,
  refreshKey,
}: OrchestrationDetailWorkspaceProps) {
  const [detail, setDetail] = useState<OrchestrationDetailResponse | null>(null)
  const [loading, setLoading] = useState(Boolean(orchestrationId))
  const [refreshing, setRefreshing] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [scheduleUpdating, setScheduleUpdating] = useState(false)
  const [scheduleRunningNow, setScheduleRunningNow] = useState(false)
  const [attentionAction, setAttentionAction] = useState<'resume' | 'stop' | ''>('')
  const [keywordRetryAgentOverrides, setKeywordRetryAgentOverrides] = useState<Record<string, string>>({})
  const [keywordRetrying, setKeywordRetrying] = useState(false)
  const [negativeReassignOpen, setNegativeReassignOpen] = useState(false)
  const [negativeReassigning, setNegativeReassigning] = useState(false)
  const [negativeReassignAgentIds, setNegativeReassignAgentIds] = useState<Set<string>>(new Set())
  const [actionFeedback, setActionFeedback] = useState('')
  const [actionError, setActionError] = useState('')
  const [error, setError] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const loadGeneration = useRef(0)
  const pendingNegativeReassign = useRef<{
    fingerprint: string
    requestKey: string
  } | null>(null)
  const pendingKeywordRetry = useRef<{
    fingerprint: string
    requestKey: string
  } | null>(null)
  const pendingScheduleRunNow = useRef<string | null>(null)

  const load = useCallback(async (quiet = false, showRefreshIndicator = true) => {
    if (!orchestrationId) return
    const generation = ++loadGeneration.current
    if (!quiet) setLoading(true)
    else if (showRefreshIndicator) setRefreshing(true)
    try {
      const result = await api.get<OrchestrationDetailResponse>(`/capture-cloud/orchestrations/${orchestrationId}`)
      if (generation !== loadGeneration.current) return
      setDetail(result)
      setError('')
    } catch (err) {
      if (generation !== loadGeneration.current) return
      setError(err instanceof Error ? err.message : '读取编排任务详情失败')
    } finally {
      if (generation === loadGeneration.current) {
        if (!quiet) setLoading(false)
        if (showRefreshIndicator) setRefreshing(false)
      }
    }
  }, [orchestrationId])

  /* eslint-disable react-hooks/set-state-in-effect -- an id change intentionally replaces the displayed remote record */
  useEffect(() => {
    setDetail(null)
    setError('')
    setActionFeedback('')
    setActionError('')
    setNegativeReassignOpen(false)
    setNegativeReassignAgentIds(new Set())
    setKeywordRetryAgentOverrides({})
    pendingNegativeReassign.current = null
    pendingKeywordRetry.current = null
    pendingScheduleRunNow.current = null
    if (!orchestrationId) {
      setLoading(false)
      return
    }
    void load()
  }, [load, orchestrationId, refreshKey])
  /* eslint-enable react-hooks/set-state-in-effect */

  const sortedItems = useMemo(
    () => [...(detail?.items || [])].sort((left, right) => {
      const ordinalDiff = Number(left.ordinal || 0) - Number(right.ordinal || 0)
      if (ordinalDiff !== 0) return ordinalDiff
      return String(left.created_at || '').localeCompare(String(right.created_at || ''))
    }),
    [detail?.items],
  )
  const agentsById = useMemo(
    () => new Map((detail?.agents || []).map(agent => [agent.id, agent])),
    [detail?.agents],
  )
  const attemptsByItem = useMemo(() => {
    const result = new Map<string, OrchestrationAttemptRecord[]>()
    for (const attempt of detail?.attempts || []) {
      const itemId = attemptItemId(attempt)
      if (!itemId) continue
      result.set(itemId, [...(result.get(itemId) || []), attempt])
    }
    return result
  }, [detail?.attempts])
  const completedCount = sortedItems.filter(item => SUCCESS_ITEM_STATUSES.has(item.status)).length
  const settledCount = sortedItems.filter(item => SETTLED_ITEM_STATUSES.has(item.status)).length
  const failedCount = sortedItems.filter(item => FAILURE_STATUSES.has(item.status)).length
  const activeCount = sortedItems.filter(item => ACTIVE_STATUSES.has(item.status)).length
  const progressPercent = sortedItems.length > 0 ? Math.round((settledCount / sortedItems.length) * 100) : 0
  const isScheduleTemplate =
    detail?.orchestration.metadata?.orchestrationTemplate === true
  const metadata = detail?.orchestration.metadata || {}
  const elasticPool = metadata.distributionMode === 'elastic_pool'
    || detail?.schedule?.distribution_mode === 'elastic_pool'
  const negativePatrol = detail?.orchestration.feature_key === 'negative_post_patrol'
    || detail?.orchestration.metadata?.workflow === 'negative_post_patrol'
  const watchedContentPatrol = detail?.orchestration.feature_key === 'watched_content_patrol'
    || detail?.orchestration.metadata?.workflow === 'watched_content_patrol'
  const contentPatrol = negativePatrol || watchedContentPatrol
  const executionsById = useMemo(
    () => new Map((detail?.executions || []).map(execution => [
      executionTaskId(execution),
      execution,
    ])),
    [detail?.executions],
  )
  const keywordRetryItems = useMemo(() => {
    if (!detail || contentPatrol || isScheduleTemplate) return []
    return sortedItems.filter(item => {
      if (!KEYWORD_RETRY_STATUSES.has(item.status)) return false
      if (safetyDiagnostic(item.error) || safetyDiagnostic(item.metadata)) {
        // 弹性池第一次命中验证码会自动换 Agent；此时 item 已被服务端明确
        // 标为 retryable，不应提前显示成人工待办。
        if (!(elasticPool && item.status === 'retryable')) return false
      }
      const sourceExecution = executionsById.get(
        String(item.execution_task_id || ''),
      )
      return Boolean(
        sourceExecution &&
        (
          FINAL_EXECUTION_STATUSES.has(executionStatus(sourceExecution)) ||
          (elasticPool && executionStatus(sourceExecution) === 'needs_action')
        ),
      )
    })
  }, [contentPatrol, detail, elasticPool, executionsById, isScheduleTemplate, sortedItems])
  const keywordRetrySourceAgentIds = useMemo(() => new Set(
    keywordRetryItems
      .map(item => itemAssignedAgentId(
        item,
        detail?.executions || [],
        detail?.attempts || [],
      ))
      .filter(Boolean),
  ), [detail?.attempts, detail?.executions, keywordRetryItems])
  const keywordRetryCandidates = useMemo(() => {
    if (!detail || contentPatrol) return []
    const source = Array.isArray(detail.retryCandidates)
      ? detail.retryCandidates
      : availableAgents
    return source.filter(agent => agentSupportsKeywordRetry(
        agent,
        detail.orchestration.platform,
      ))
  }, [availableAgents, contentPatrol, detail])
  const keywordAutomaticCandidates = useMemo(
    () => keywordRetryCandidates.filter(agent =>
      !keywordRetrySourceAgentIds.has(agent.id),
    ),
    [keywordRetryCandidates, keywordRetrySourceAgentIds],
  )
  const keywordRetryAllocation = useMemo(() => {
    return allocateKeywordRetryItems({
      items: keywordRetryItems,
      candidates: keywordRetryCandidates,
      overrides: keywordRetryAgentOverrides,
    })
  }, [keywordRetryAgentOverrides, keywordRetryCandidates, keywordRetryItems])
  const keywordRetryDispatchableCount = keywordRetryAllocation.filter(
    allocation => Boolean(allocation.agent),
  ).length
  const keywordRetryWaitingCount =
    keywordRetryAllocation.length - keywordRetryDispatchableCount
  const keywordRetryStrictWaitingCount = keywordRetryAllocation.filter(
    allocation => allocation.strictWaiting,
  ).length
  const negativeReassignItems = useMemo(() => {
    if (!negativePatrol) return []
    return sortedItems.filter(item => {
      if (itemAvailabilityLabel(item)) return false
      if (safetyDiagnostic(item.error) || safetyDiagnostic(item.metadata)) {
        return false
      }
      if (NEGATIVE_REASSIGN_EXPLICIT_STATUSES.has(item.status)) return true
      if (
        !item.started_at &&
        NEGATIVE_REASSIGN_UNSTARTED_STATUSES.has(item.status)
      ) {
        const sourceExecution = executionsById.get(
          String(item.execution_task_id || ''),
        )
        return Boolean(
          sourceExecution &&
          FINAL_EXECUTION_STATUSES.has(executionStatus(sourceExecution)),
        )
      }
      return false
    })
  }, [executionsById, negativePatrol, sortedItems])
  const negativeReassignSourceAgentIds = useMemo(() => new Set(
    negativeReassignItems
      .map(item => itemAssignedAgentId(
        item,
        detail?.executions || [],
        detail?.attempts || [],
      ))
      .filter(Boolean),
  ), [detail?.attempts, detail?.executions, negativeReassignItems])
  const negativeReassignCandidates = useMemo(() => {
    if (!detail || !negativePatrol) return []
    return availableAgents
      .filter(agent => agentSupportsNegativePatrol(
        agent,
        detail.orchestration.platform,
      ))
      .sort((left, right) =>
        `${left.host_label}${left.display_name}`.localeCompare(
          `${right.host_label}${right.display_name}`,
          'zh-CN',
        ),
      )
  }, [availableAgents, detail, negativePatrol])
  const negativeReassignBlockedByActiveExecution = Boolean(
    negativePatrol &&
    (detail?.executions || []).some(execution =>
      NEGATIVE_REASSIGN_BLOCKING_EXECUTION_STATUSES.has(
        executionStatus(execution),
      ),
    ),
  )
  const selectedNegativeReassignAgents = useMemo(
    () => negativeReassignCandidates.filter(agent =>
      negativeReassignAgentIds.has(agent.id),
    ),
    [negativeReassignAgentIds, negativeReassignCandidates],
  )
  const negativeReassignAllocation = useMemo(() => {
    if (
      negativeReassignItems.length === 0 ||
      selectedNegativeReassignAgents.length === 0
    ) return []
    const base = Math.floor(
      negativeReassignItems.length / selectedNegativeReassignAgents.length,
    )
    const remainder =
      negativeReassignItems.length % selectedNegativeReassignAgents.length
    return selectedNegativeReassignAgents.map((agent, index) => ({
      agent,
      count: base + (index < remainder ? 1 : 0),
    }))
  }, [negativeReassignItems.length, selectedNegativeReassignAgents])
  const stoppableTaskIds = useMemo(
    () => Array.from(new Set((detail?.executions || [])
      .filter(execution => STOPPABLE_EXECUTION_STATUSES.has(String(execution.status || '')))
      .map(executionTaskId)
      .filter(Boolean))),
    [detail?.executions],
  )
  const canStopOrchestration = Boolean(
    detail &&
    !isScheduleTemplate &&
    STOPPABLE_ORCHESTRATION_STATUSES.has(
      String(detail.orchestration.status || ''),
    ),
  )
  const attentionContext = useMemo(() => {
    if (!detail || contentPatrol) return null
    const item = sortedItems.find(candidate =>
      Boolean(candidate.execution_task_id) &&
      candidate.status === 'needs_action' &&
      (
        safetyDiagnostic(candidate.error) ||
        safetyDiagnostic(candidate.metadata)
      ),
    )
    const execution = item
      ? detail.executions.find(candidate => executionTaskId(candidate) === item.execution_task_id)
      : detail.executions.find(candidate => {
          const metadata = candidate.metadata && typeof candidate.metadata === 'object'
            ? candidate.metadata as Record<string, unknown>
            : {}
          if (metadata.handoffSuccessorTaskId || metadata.recoveryTaskId) return false
          const status = executionStatus(candidate)
          const safetyEvidence =
            safetyDiagnostic(candidate.error) ||
            safetyDiagnostic(candidate.metadata) ||
            safetyDiagnostic(candidate.checkpoint) ||
            safetyDiagnostic(candidate.message)
          if (!safetyEvidence) return false
          const taskId = executionTaskId(candidate)
          if (
            elasticPool &&
            sortedItems.some(candidateItem =>
              candidateItem.execution_task_id === taskId &&
              candidateItem.status === 'retryable',
            )
          ) {
            return false
          }
          if (status === 'needs_action') return true
          if (!FINAL_EXECUTION_STATUSES.has(status)) return false
          return sortedItems.some(candidateItem =>
            candidateItem.execution_task_id === taskId &&
            !candidateItem.started_at &&
            !HANDOFF_UNSTARTED_EXCLUDED_STATUSES.has(candidateItem.status),
          )
        })
    if (!execution) return null
    const executionMetadata = execution.metadata && typeof execution.metadata === 'object'
      ? execution.metadata as Record<string, unknown>
      : {}
    if (
      executionStatus(execution) === 'superseded' ||
      executionMetadata.handoffSuccessorTaskId ||
      executionMetadata.recoveryTaskId
    ) {
      return null
    }
    const sourceTaskId = executionTaskId(execution)
    const sourceAgentId = executionAgentId(execution)
    if (!sourceTaskId || !sourceAgentId) return null
    const sourceItems = sortedItems.filter(candidate => candidate.execution_task_id === sourceTaskId)
    const currentItem = item ||
      sourceItems.find(candidate => candidate.status === 'needs_action') ||
      [...sourceItems].reverse().find(candidate =>
        Boolean(candidate.started_at) &&
        (
          safetyDiagnostic(candidate.error) ||
          safetyDiagnostic(candidate.metadata)
        ),
      )
    const sourceStatus = executionStatus(execution)
    return {
      sourceTaskId,
      sourceAgentId,
      sourceStatus,
      sourceFinal: FINAL_EXECUTION_STATUSES.has(sourceStatus),
      sourceEnded: ENDED_EXECUTION_STATUSES.has(sourceStatus),
      sourceAgent: detail.agents.find(agent => agent.id === sourceAgentId),
      currentItem,
      currentOrdinal: Number(currentItem?.ordinal ?? -1) + 1,
      unstartedCount: sourceItems.filter(candidate =>
        !candidate.started_at &&
        !HANDOFF_UNSTARTED_EXCLUDED_STATUSES.has(candidate.status),
      ).length,
    }
  }, [contentPatrol, detail, elasticPool, sortedItems])
  const handoffCandidates = useMemo(() => {
    if (!attentionContext || !detail) return []
    return availableAgents
      .filter(agent =>
        agent.id !== attentionContext.sourceAgentId &&
        agent.status === 'active' &&
        agent.online &&
        (agent.allowed_platforms.length === 0 || agent.allowed_platforms.includes(detail.orchestration.platform)) &&
        Number(agent.active_task_count || 0) === 0 &&
        Number(agent.queued_task_count || 0) === 0,
      )
      .sort((left, right) =>
        `${left.host_label}${left.display_name}`.localeCompare(`${right.host_label}${right.display_name}`, 'zh-CN'),
      )
  }, [attentionContext, availableAgents, detail])

  const automaticRecoveryStates = useMemo(() => {
    if (!detail || isScheduleTemplate) return []
    const states: Array<{
      id: string
      label: string
      message: string
      attemptCurrent: number
      attemptTotal: number
      waitUntil: number
      agentLabel: string
      countdownKind: 'retry' | 'agent_cooldown'
    }> = []
    for (const execution of detail.executions) {
      const progress = execution.progress && typeof execution.progress === 'object'
        ? execution.progress as Record<string, unknown>
        : {}
      const waitUntil = timestamp(
        progress.waitUntil || progress.wait_until || progress.nextRetryAt,
      )
      const phase = String(progress.phase || '')
      if (!waitUntil || (!phase.startsWith('waiting_') && waitUntil < nowMs - 10 * 60 * 1000)) {
        continue
      }
      const agentId = executionAgentId(execution)
      const attemptCurrent = Math.max(0, Number(
        progress.attemptCurrent || progress.attempt_current || progress.attempt || 0,
      ) || 0)
      const attemptTotal = Math.max(0, Number(
        progress.attemptTotal || progress.attempt_total || progress.maxAttempts || 0,
      ) || 0)
      states.push({
        id: `execution:${executionTaskId(execution)}`,
        label: attemptCurrent > 0 && attemptTotal > 0
          ? `当前 Agent 自动恢复 ${attemptCurrent}/${attemptTotal}`
          : '当前 Agent 自动恢复',
        message: String(progress.message || execution.message || '正在等待下一次自动恢复'),
        attemptCurrent,
        attemptTotal,
        waitUntil,
        agentLabel: agentName(agentsById.get(agentId)),
        countdownKind: 'retry',
      })
    }
    for (const item of sortedItems) {
      if (item.status !== 'retryable') continue
      const checkpoint = item.metadata?.checkpoint
      const checkpointRecord = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
        ? checkpoint as Record<string, unknown>
        : {}
      const itemError = item.error && typeof item.error === 'object'
        ? item.error as Record<string, unknown>
        : {}
      const recoveryValue = checkpointRecord.recovery || itemError.recovery
      const recovery = recoveryValue && typeof recoveryValue === 'object' && !Array.isArray(recoveryValue)
        ? recoveryValue as Record<string, unknown>
        : {}
      const waitUntil = timestamp(
        recovery.sourceAgentHoldUntil ||
        recovery.source_agent_hold_until ||
        recovery.nextEvaluationAt ||
        recovery.next_evaluation_at,
      )
      const attemptCurrent = Math.max(1, Number(
        recovery.attemptCurrent || recovery.attempt_current || item.attempt_count || 1,
      ) || 1)
      const attemptTotal = Math.max(attemptCurrent, Number(
        recovery.attemptTotal || recovery.attempt_total || 3,
      ) || 3)
      const workUnit = contentPatrol || ['negative_post', 'watched_content'].includes(item.item_type)
        ? '帖子'
        : '关键词'
      const cooldownHomeStatus = Object.prototype.hasOwnProperty.call(
        recovery,
        'cooldownHomeRestored',
      )
        ? recovery.cooldownHomeRestored === true
          ? '；原 Agent 已返回平台首页'
          : '；原 Agent 返回平台首页未确认'
        : ''
      states.push({
        id: `item:${item.id}`,
        label: `工作项已释放 · 换 Agent ${attemptCurrent}/${attemptTotal}`,
        message: String(recovery.reason || '') === 'platform_safety_handoff'
          ? `${workUnit}「${keywordForItem(item)}」已解除原 Agent 锁定，其他账号可立即复核；原 Agent 冷却期间不会领取新任务${cooldownHomeStatus}`
          : `${workUnit}「${keywordForItem(item)}」已解除原 Agent 锁定，其他空闲 Agent 可立即领取；原 Agent 冷却期间不会领取新任务${cooldownHomeStatus}`,
        attemptCurrent,
        attemptTotal,
        waitUntil,
        agentLabel: `原 Agent：${agentName(agentsById.get(String(recovery.sourceAgentId || item.assigned_agent_id || '')))}`,
        countdownKind: 'agent_cooldown',
      })
    }
    return states
  }, [agentsById, contentPatrol, detail, isScheduleTemplate, nowMs, sortedItems])

  useEffect(() => {
    if (!orchestrationId) return
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load(true, false)
    }
    const timer = window.setInterval(refreshWhenVisible, 5_000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [load, orchestrationId])

  useEffect(() => {
    if (!orchestrationId) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [orchestrationId])

  const stopAllExecutions = async () => {
    if (!writable || stopping || !canStopOrchestration) return
    const executionHint = stoppableTaskIds.length > 0
      ? `，并向 ${stoppableTaskIds.length} 条 Agent 子任务发送停止指令`
      : ''
    if (!window.confirm(`确定停止整个任务吗？系统会立即终止父任务和自动接力${executionHint}；已采集结果会保留。`)) return
    setStopping(true)
    setActionFeedback('')
    setActionError('')
    try {
      const stopResult = await api.post<{
        executionTaskIds?: string[]
        message?: string
      }>(`/capture-cloud/orchestrations/${orchestrationId}/stop`, {})
      const executionTaskIds = Array.from(new Set([
        ...stoppableTaskIds,
        ...(Array.isArray(stopResult.executionTaskIds)
          ? stopResult.executionTaskIds
          : []),
      ].filter(Boolean)))
      const results = await Promise.allSettled(
        executionTaskIds.map(taskId => api.post(`/capture-cloud/tasks/${taskId}/stop`, {})),
      )
      const succeeded = results.filter(result => result.status === 'fulfilled').length
      const failed = results.length - succeeded
      if (failed > 0) {
        setActionError(`整个任务和自动接力已停止；已向 ${succeeded} 条子任务发送停止指令，另有 ${failed} 条未能送达，请刷新检查 Agent 状态。`)
      } else {
        setActionFeedback(executionTaskIds.length > 0
          ? `整个任务和自动接力已停止；已向 ${succeeded} 条子任务发送停止指令。`
          : stopResult.message || '整个任务和自动接力已停止。')
      }
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '停止编排子任务失败')
    } finally {
      setStopping(false)
    }
  }

  const updateScheduleStatus = async () => {
    if (!detail?.schedule || !isScheduleTemplate || !writable || scheduleUpdating) return
    const action = detail.schedule.status === 'active' ? 'pause' : 'resume'
    const prompt = action === 'pause'
      ? '暂停这个无人值守计划吗？已经生成并正在运行的任务不会被停止，但不会再生成下一轮。'
      : '重新启用这个无人值守计划吗？云端会从下一个有效时间开始运行，不会补跑暂停期间错过的时间。'
    if (!window.confirm(prompt)) return
    setScheduleUpdating(true)
    setActionFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/orchestrations/${orchestrationId}/schedule/${action}`,
        {},
      )
      setActionFeedback(result.message || (action === 'pause' ? '计划已暂停' : '计划已重新启用'))
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '更新无人值守计划失败')
    } finally {
      setScheduleUpdating(false)
    }
  }

  const runScheduleNow = async () => {
    if (
      !detail?.schedule ||
      !isScheduleTemplate ||
      !['active', 'completed'].includes(detail.schedule.status) ||
      !writable ||
      scheduleRunningNow
    ) return
    if (!window.confirm(
      '现在立即启动一轮无人值守任务吗？如果上一轮仍未结束，云端会阻止重复启动；计划模板和原定时设置都会保留。',
    )) return
    if (!pendingScheduleRunNow.current) {
      pendingScheduleRunNow.current = crypto.randomUUID()
    }
    setScheduleRunningNow(true)
    setActionFeedback('')
    setActionError('')
    try {
      const result = await api.post<{message?: string; runTaskId?: string}>(
        `/capture-cloud/orchestrations/${orchestrationId}/schedule/run-now`,
        {requestKey: pendingScheduleRunNow.current},
        {timeoutMs: 30_000},
      )
      pendingScheduleRunNow.current = null
      setActionFeedback(result.message || '已立即启动一轮无人值守任务')
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '立即启动无人值守任务失败')
    } finally {
      setScheduleRunningNow(false)
    }
  }

  const resumeAttentionSource = async () => {
    if (!attentionContext || !writable || attentionAction) return
    const verificationConfirmation = elasticPool
      ? '请确认已经在原 Agent 的平台页面完成人工验证。确认后只解除该账号冷却；受阻关键词仍由其它空闲 Agent 接力，不会重开旧任务。'
      : '请确认已经在当前 Agent 的平台页面完成人工验证。确认后将从未完成位置继续，并保留此前结果。'
    if (!window.confirm(verificationConfirmation)) return
    setAttentionAction('resume')
    setActionFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/tasks/${attentionContext.sourceTaskId}/resume`,
        { mode: 'remaining' },
      )
      setActionFeedback(result.message || (elasticPool
        ? '原账号冷却已解除，受阻关键词继续由其它 Agent 接力'
        : '已向当前 Agent 发送继续剩余关键词指令'))
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : (elasticPool
        ? '解除账号冷却失败'
        : '发送继续指令失败'))
    } finally {
      setAttentionAction('')
    }
  }

  const stopAttentionSource = async () => {
    if (!attentionContext || !writable || attentionAction) return
    if (!window.confirm('确定结束当前 Agent 的任务吗？后续关键词不再执行，已经采集和保存的结果会保留。')) return
    setAttentionAction('stop')
    setActionFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/tasks/${attentionContext.sourceTaskId}/stop`,
        {},
      )
      setActionFeedback(result.message || '已向当前 Agent 发送结束并保留结果指令')
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '发送结束指令失败')
    } finally {
      setAttentionAction('')
    }
  }

  const retryFailedKeywords = async () => {
    if (
      !detail ||
      !orchestrationId ||
      !writable ||
      keywordRetrying ||
      keywordRetryItems.length === 0
    ) return
    const confirmSafety = keywordRetryItems.some(item =>
      safetyDiagnostic(item.error) || safetyDiagnostic(item.metadata),
    )
    const originalCount = keywordRetryAllocation.filter(allocation =>
      allocation.agent && keywordRetrySourceAgentIds.has(allocation.agent.id),
    ).length
    if (!window.confirm(
      (keywordRetryDispatchableCount > 0
        ? `确定按预览让 ${keywordRetryDispatchableCount} 个失败关键词现在接力吗？`
        : `当前没有空闲兼容 Agent，确定让 ${keywordRetryWaitingCount} 个失败关键词进入自动等待队列吗？`) +
      `${keywordRetryDispatchableCount > 0 && keywordRetryWaitingCount
        ? ` 另有 ${keywordRetryWaitingCount} 个等待空闲 Agent，槽位释放后自动接力。`
        : ''}` +
      `${keywordRetryStrictWaitingCount > 0
        ? ` 其中 ${keywordRetryStrictWaitingCount} 项指定的 Agent 当前不可用，将严格等待该 Agent，不会自动改派。`
        : ''}` +
      `${keywordRetryDispatchableCount === 0
        ? ''
        : originalCount
          ? ` 其中 ${originalCount} 项使用原执行 Agent。`
          : ' 当前可接力项全部使用其他空闲 Agent。'}` +
      ' 新结果会写回当前无人值守任务，不会生成独立根任务。' +
      `${confirmSafety ? ' 其中包含曾触发安全验证的关键词，请确认目标设备已可正常访问平台。' : ''}`,
    )) return

    const expectedRevision = Number(
      detail.orchestration.revision ??
      detail.orchestration.orchestration_revision ??
      0,
    )
    const itemIds = keywordRetryItems.map(item => item.id)
    const assignments = buildKeywordRetryAssignments({
      items: keywordRetryItems,
      overrides: keywordRetryAgentOverrides,
    })
    const fingerprint = JSON.stringify({
      orchestrationId,
      expectedRevision,
      itemIds,
      assignments,
      confirmSafety,
    })
    if (
      !pendingKeywordRetry.current ||
      pendingKeywordRetry.current.fingerprint !== fingerprint
    ) {
      pendingKeywordRetry.current = {
        fingerprint,
        requestKey: crypto.randomUUID(),
      }
    }
    setKeywordRetrying(true)
    setActionError('')
    setActionFeedback('')
    try {
      const result = await api.post<{
        message?: string
        dispatched?: Array<{itemIds?: string[]}>
        waiting?: Array<{itemId?: string}>
      }>(
        `/capture-cloud/orchestrations/${orchestrationId}/retry-items`,
        {
          requestKey: pendingKeywordRetry.current.requestKey,
          expectedRevision,
          itemIds,
          assignments,
          confirmSafety,
        },
        {timeoutMs: 30_000},
      )
      pendingKeywordRetry.current = null
      setKeywordRetryAgentOverrides({})
      setActionFeedback(
        result.message ||
        `${result.dispatched?.length || assignments.length} 个关键词已接力，${result.waiting?.length || 0} 个等待空闲 Agent 并将在槽位释放后自动接力`,
      )
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '云端重试失败关键词失败')
    } finally {
      setKeywordRetrying(false)
    }
  }

  const openNegativeReassign = () => {
    const preferred = negativeReassignCandidates.filter(
      agent => !negativeReassignSourceAgentIds.has(agent.id),
    )
    const initial = preferred.length > 0
      ? preferred
      : negativeReassignCandidates
    setNegativeReassignAgentIds(new Set(
      initial
        .slice(0, negativeReassignItems.length)
        .map(agent => agent.id),
    ))
    setNegativeReassignOpen(true)
    setActionError('')
    setActionFeedback('')
  }

  const toggleNegativeReassignAgent = (agentId: string) => {
    setNegativeReassignAgentIds(current => {
      const next = new Set(current)
      if (next.has(agentId)) {
        next.delete(agentId)
      } else if (next.size < negativeReassignItems.length) {
        next.add(agentId)
      }
      return next
    })
  }

  const submitNegativeReassign = async () => {
    if (
      !detail ||
      !orchestrationId ||
      !writable ||
      negativeReassigning ||
      negativeReassignItems.length === 0 ||
      selectedNegativeReassignAgents.length === 0
    ) return
    const agentIds = selectedNegativeReassignAgents.map(agent => agent.id)
    const retryingOriginalAgents = agentIds.filter(agentId =>
      negativeReassignSourceAgentIds.has(agentId),
    ).length
    if (!window.confirm(
      `确定把 ${negativeReassignItems.length} 条未完成帖子重新均衡分配给 ${agentIds.length} 个在线 Agent 吗？` +
      `${retryingOriginalAgents > 0 ? ` 其中 ${retryingOriginalAgents} 个是原失败节点。` : ''}` +
      ' 已完成以及已删除或不可访问的帖子不会重复执行。',
    )) return

    const expectedRevision = Number(
      detail.orchestration.revision ??
      detail.orchestration.orchestration_revision ??
      0,
    )
    const fingerprint = JSON.stringify({
      orchestrationId,
      expectedRevision,
      agentIds,
      itemIds: negativeReassignItems.map(item => item.id),
    })
    if (
      !pendingNegativeReassign.current ||
      pendingNegativeReassign.current.fingerprint !== fingerprint
    ) {
      pendingNegativeReassign.current = {
        fingerprint,
        requestKey: crypto.randomUUID(),
      }
    }
    setNegativeReassigning(true)
    setActionError('')
    setActionFeedback('')
    try {
      const result = await api.post<{
        existing?: boolean
        eligibleCount?: number
        message?: string
      }>(
        `/capture-cloud/negative-patrol/orchestrations/${orchestrationId}/reassign`,
        {
          requestKey: pendingNegativeReassign.current.requestKey,
          expectedRevision,
          agentIds,
        },
        { timeoutMs: 30_000 },
      )
      pendingNegativeReassign.current = null
      setNegativeReassignOpen(false)
      setNegativeReassignAgentIds(new Set())
      setActionFeedback(
        result.message ||
        `已重新分配 ${result.eligibleCount ?? negativeReassignItems.length} 条未完成帖子`,
      )
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '重新分配未完成帖子失败')
    } finally {
      setNegativeReassigning(false)
    }
  }

  if (!orchestrationId) {
    return (
      <section className={cn('rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-12 text-center', className)}>
        <ClipboardList className="mx-auto h-7 w-7 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold text-foreground">选择一个编排任务</h3>
        <p className="mt-1 text-xs text-muted-foreground">这里会显示任务、工作项和真实 Agent 执行记录。</p>
      </section>
    )
  }

  if (loading && !detail) {
    return (
      <section className={cn('flex min-h-96 items-center justify-center rounded-2xl border border-border bg-card', className)}>
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="正在读取编排任务" />
      </section>
    )
  }

  if (!detail) {
    return (
      <section className={cn('rounded-2xl border border-status-red/25 bg-status-red/5 p-5', className)}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-red" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-foreground">无法读取编排任务</h3>
            <p role="alert" className="mt-1 text-xs leading-5 text-status-red">{error || '任务不存在或当前账号无权查看。'}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}><RefreshCw className="h-4 w-4" /> 重试</Button>
          </div>
        </div>
      </section>
    )
  }

  const { orchestration, executions, agents, attempts, schedule } = detail
  const scheduleTemplate = metadata.orchestrationTemplate === true
  const scheduleRun = metadata.orchestrationScheduleRun === true
  const planSnapshot = metadata.planSnapshot && typeof metadata.planSnapshot === 'object'
    ? metadata.planSnapshot as Record<string, unknown>
    : {}
  const keywordLimit = Number(planSnapshot.keywordMaxDetectedItems)
  const searchFilters = planSnapshot.searchFilters && typeof planSnapshot.searchFilters === 'object'
    ? planSnapshot.searchFilters as Record<string, unknown>
    : null
  const captureSettings = planSnapshot.captureSettings && typeof planSnapshot.captureSettings === 'object'
    ? planSnapshot.captureSettings as Record<string, unknown>
    : null
  const recoveryPolicy = planSnapshot.recoveryPolicy && typeof planSnapshot.recoveryPolicy === 'object'
    ? planSnapshot.recoveryPolicy as Record<string, unknown>
    : metadata.recoveryPolicy && typeof metadata.recoveryPolicy === 'object'
      ? metadata.recoveryPolicy as Record<string, unknown>
      : {}
  const searchPasses = (Array.isArray(planSnapshot.searchPasses) ? planSnapshot.searchPasses : [])
    .map(value => String(value || '').trim())
    .filter(value => ['all', 'image', 'video'].includes(value))
    .slice(0, 2)
  const sequentialSearchEnabled = searchPasses.length > 1
  const patrolPathLabel = searchPasses
    .map(value => value === 'all' ? '综合' : CONTENT_TYPE_LABELS[value] || value)
    .join(' → ')
  const idleHandoffAllowed = elasticPool || recoveryPolicy.allowIdleAgentHandoff !== false
  const orchestrationFinal = FINAL_ORCHESTRATION_STATUSES.has(
    String(orchestration.status || ''),
  )
  const automaticKeywordRecoveryActive = Boolean(
    elasticPool &&
    idleHandoffAllowed &&
    !orchestrationFinal &&
    keywordRetryItems.some(item =>
      item.status === 'retryable' &&
      elasticAttemptBudgetUsed(item) < ELASTIC_AUTOMATIC_ATTEMPT_LIMIT,
    ),
  )
  const keywordRecoveryExhausted = Boolean(
    elasticPool &&
    orchestrationFinal &&
    keywordRetryItems.length > 0 &&
    keywordRetryItems.every(item =>
      elasticAttemptBudgetUsed(item) >= ELASTIC_AUTOMATIC_ATTEMPT_LIMIT,
    ),
  )

  return (
    <section className={cn('overflow-hidden rounded-[22px] border border-border/70 bg-card shadow-sm', className)}>
      <header className="border-b border-border/70 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${scheduleTemplate && schedule?.status === 'active' ? 'border-status-green/25 bg-status-green/8 text-status-green' : statusTone(orchestration.status)}`}>
                {scheduleTemplate && schedule
                  ? SCHEDULE_STATUS_LABELS[schedule.status] || schedule.status
                  : statusLabel(orchestration.status)}
              </span>
              <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">{PLATFORM_LABELS[orchestration.platform] || orchestration.platform}</span>
              <span className="text-[11px] text-muted-foreground">
                {scheduleTemplate
                  ? '多 Agent 无人值守计划'
                  : scheduleRun
                    ? '无人值守计划运行批次'
                    : contentPatrol
                      ? watchedContentPatrol ? '关注内容巡查' : '多 Agent 负面帖子巡查'
                    : '一次性多 Agent 任务'}
              </span>
            </div>
            <h2 id="orchestration-detail-title" className="mt-2.5 truncate text-lg font-bold text-foreground">{orchestration.title || '未命名编排任务'}</h2>
            <p className="mt-1 text-xs text-muted-foreground">创建于 {formatTime(orchestration.created_at)} · 版本 {orchestration.revision ?? orchestration.orchestration_revision ?? '—'}</p>
          </div>
          <div className="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
            {scheduleTemplate && schedule && ['active', 'paused', 'completed'].includes(schedule.status) ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditPlan?.(detail)}
                  disabled={!writable || scheduleRunningNow || scheduleUpdating || !onEditPlan}
                  title={!writable ? '当前账号为只读权限' : '编辑同一个计划；修改只影响后续运行'}
                >
                  <Pencil className="h-4 w-4" />
                  编辑计划
                </Button>
                {['active', 'completed'].includes(schedule.status) && (
                  <Button
                    size="sm"
                    onClick={() => void runScheduleNow()}
                    disabled={!writable || scheduleRunningNow || scheduleUpdating}
                    title={!writable ? '当前账号为只读权限' : '立即生成并下发一轮无人值守任务'}
                  >
                    {scheduleRunningNow
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Play className="h-4 w-4" />}
                    立即运行
                  </Button>
                )}
                {schedule.status !== 'completed' && (
                  <Button
                    variant={schedule.status === 'active' ? 'outline' : 'default'}
                    size="sm"
                    onClick={() => void updateScheduleStatus()}
                    disabled={!writable || scheduleUpdating || scheduleRunningNow}
                    title={!writable ? '当前账号为只读权限' : schedule.status === 'active' ? '暂停后不再生成新任务' : '从下一个有效时间重新运行'}
                  >
                    {scheduleUpdating
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : schedule.status === 'active'
                        ? <Pause className="h-4 w-4" />
                        : <Play className="h-4 w-4" />}
                    {schedule.status === 'active' ? '暂停计划' : '重新启用'}
                  </Button>
                )}
              </>
            ) : (
              <Button variant="destructive" size="sm" onClick={() => void stopAllExecutions()}
                disabled={!writable || stopping || !canStopOrchestration}
                title={!writable ? '当前账号为只读权限' : !canStopOrchestration ? '当前任务已经结束或不能停止' : '停止整个父任务、自动接力和仍可控制的 Agent 子任务'}>
                {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
                停止全部
              </Button>
            )}
            <Button variant="outline" size="icon" onClick={() => void load(true)} disabled={refreshing} aria-label="刷新编排任务详情">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            {onClose && (
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭编排任务详情" data-dialog-initial-focus><X className="h-5 w-5" /></Button>
            )}
          </div>
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-status-red">{error}</p>}
        {actionError && <p role="alert" className="mt-3 text-xs text-status-red">{actionError}</p>}
        {actionFeedback && <p role="status" aria-live="polite" className="mt-3 text-xs text-status-green">{actionFeedback}</p>}
      </header>

      <div className="p-4 sm:p-5">
        {automaticRecoveryStates.length > 0 && (
          <section className="mb-4 rounded-2xl border border-primary/20 bg-primary/[0.025] p-4" aria-label="自动恢复实时状态">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Clock3 className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-foreground">自动恢复实时状态</h3>
                  <span className="text-[10px] text-muted-foreground">每 5 秒同步设备状态</span>
                </div>
                <div className="mt-3 grid gap-2">
                  {automaticRecoveryStates.map(state => {
                    const due = state.waitUntil > 0 && state.waitUntil <= nowMs
                    return (
                      <div key={state.id} className={cn(
                        'rounded-xl border px-3 py-2.5',
                        due
                          ? 'border-status-orange/25 bg-status-orange/[0.045]'
                          : 'border-primary/15 bg-background/70',
                      )}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong className="text-xs font-semibold text-foreground">{state.label}</strong>
                          <span className={cn(
                            'font-mono text-xs font-bold tabular-nums',
                            due ? 'text-status-orange' : 'text-primary',
                          )}>
                            {state.waitUntil > 0
                              ? state.countdownKind === 'agent_cooldown'
                                ? formatAgentCooldownCountdown(state.waitUntil, nowMs)
                                : formatRecoveryCountdown(state.waitUntil, nowMs)
                              : '排队中，空闲 Agent 自动领取'}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{state.message}</p>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {state.agentLabel}
                          {state.waitUntil > 0
                            ? ` · ${state.countdownKind === 'agent_cooldown' ? '冷却结束' : '下次动作'} ${new Date(state.waitUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                            : ''}
                        </p>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>
        )}
        {attentionContext && (
          <section className="mb-4 rounded-2xl border border-status-red/25 bg-status-red/[0.035] p-4" role="alert">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-status-red/10 text-status-red">
                <ShieldAlert className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-sm font-bold text-foreground">
                    {attentionContext.sourceEnded
                      ? '当前 Agent 已结束，后续关键词由系统自动接力'
                      : '自动恢复与换设备复核后仍需人工验证'}
                  </h3>
                  <span className="rounded-full bg-status-red/10 px-2 py-0.5 text-[10px] font-semibold text-status-red">
                    {attentionContext.currentOrdinal > 0
                      ? `${attentionContext.currentOrdinal}/${sortedItems.length}`
                      : '需处理'}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  当前 Agent：<strong className="font-semibold text-foreground">{agentName(attentionContext.sourceAgent)}</strong>
                  {attentionContext.currentItem
                    ? <> · 当前关键词：<strong className="font-semibold text-foreground">{keywordForItem(attentionContext.currentItem)}</strong></>
                    : null}
                  。此前采集结果已保留。
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {!attentionContext.sourceEnded && (
                    <Button
                      size="sm"
                      onClick={() => void resumeAttentionSource()}
                      disabled={!writable || Boolean(attentionAction)}
                    >
                      {attentionAction === 'resume'
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Play className="h-4 w-4" />}
                      {elasticPool
                        ? '验证完成，解除账号冷却'
                        : '验证完成，当前 Agent 继续'}
                    </Button>
                  )}
                  {!attentionContext.sourceFinal && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void stopAttentionSource()}
                      disabled={!writable || Boolean(attentionAction)}
                    >
                      {attentionAction === 'stop'
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Square className="h-3.5 w-3.5 fill-current" />}
                      结束并保留
                    </Button>
                  )}
                  {idleHandoffAllowed && attentionContext.unstartedCount > 0 && (
                    <span className="inline-flex min-h-9 items-center rounded-lg border border-primary/20 bg-primary/[0.045] px-3 text-xs font-medium text-primary">
                      {handoffCandidates.length > 0
                        ? `系统正在按词分配后续 ${attentionContext.unstartedCount} 个关键词`
                        : `后续 ${attentionContext.unstartedCount} 个关键词正在等待空闲 Agent`}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                  {attentionContext.sourceEnded
                    ? idleHandoffAllowed
                      ? '当前任务结果已保留；系统只接力尚未开始的完整关键词，并按空闲情况逐词分配。'
                      : '当前任务已结束，现有结果已保留；该历史任务创建时未启用自动接力。'
                    : idleHandoffAllowed
                    ? '系统已经先做过原 Agent 分散重试，并尝试换一个账号复核；再次遇到验证码或登录限制后才暂停，避免在多个账号间继续扩散风控。其他未开始关键词仍会自动分配。'
                    : '该历史任务创建时未启用自动接力；你可以在当前 Agent 验证后继续，或结束并保留结果。'}
                </p>
              </div>
            </div>
          </section>
        )}
        {keywordRetryItems.length > 0 && (
          <section className="mb-4 rounded-2xl border border-primary/20 bg-primary/[0.025] p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <RefreshCw className="h-4.5 w-4.5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold text-foreground">
                      {automaticKeywordRecoveryActive
                        ? `${keywordRetryItems.length} 个关键词正在自动恢复`
                        : keywordRecoveryExhausted
                          ? `${keywordRetryItems.length} 个关键词自动尝试已耗尽`
                          : orchestrationFinal && elasticPool
                            ? `${keywordRetryItems.length} 个关键词自动恢复已停止`
                            : `${keywordRetryItems.length} 个关键词可云端重试`}
                    </h3>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      {automaticKeywordRecoveryActive
                        ? '系统自动分配'
                        : orchestrationFinal && elasticPool
                          ? '任务已结算'
                          : '回写当前父任务'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {automaticKeywordRecoveryActive
                      ? '技术失败会按关键词自动重试，并优先交给近期更稳定的空闲 Agent；新结果仍回写当前任务。'
                      : keywordRecoveryExhausted
                        ? '该批次已完成结算，不会继续自动下发；请查看每次尝试的真实错误后决定是否新建补采任务。'
                        : orchestrationFinal && elasticPool
                          ? '该批次已经结算，页面不再把失败项误报为“正在自动恢复”。'
                          : '默认每个失败关键词分配一台空闲 Agent；你可以在下方逐项覆盖。'}
                  </p>
                </div>
              </div>
              {automaticKeywordRecoveryActive ? (
                <span className="inline-flex min-h-9 items-center rounded-lg border border-primary/20 bg-primary/[0.045] px-3 text-xs font-medium text-primary">
                  {keywordAutomaticCandidates.length > 0
                    ? '系统按上方倒计时自动检查并下发，无需人工操作'
                    : '正在等待兼容的空闲 Agent；上方会显示检查状态'}
                </span>
              ) : orchestrationFinal && elasticPool ? (
                <span className="inline-flex min-h-9 items-center rounded-lg border border-border bg-muted/50 px-3 text-xs font-medium text-muted-foreground">
                  当前任务已结算，不会继续自动分配
                </span>
              ) : <div className="flex flex-col items-end gap-1">
                <Button
                  size="sm"
                  onClick={() => void retryFailedKeywords()}
                  disabled={!writable || keywordRetrying}
                >
                  {keywordRetrying
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Send className="h-4 w-4" />}
                  重试失败关键词
                </Button>
                {keywordRetryWaitingCount > 0 && (
                  <span className={cn(
                    'text-[11px]',
                    keywordRetryDispatchableCount > 0
                      ? 'text-muted-foreground'
                      : 'text-status-red',
                  )}>
                    {keywordRetryDispatchableCount} 个现在接力，{keywordRetryWaitingCount} 个等待
                    {keywordRetryStrictWaitingCount > 0
                      ? `（其中 ${keywordRetryStrictWaitingCount} 个严格等待指定 Agent）`
                      : '槽位释放后自动接力'}
                  </span>
                )}
              </div>}
            </div>
            {!automaticKeywordRecoveryActive && !(orchestrationFinal && elasticPool) && (
              <div className="mt-4 overflow-hidden rounded-xl border border-border bg-background/80">
                <div className="hidden grid-cols-[minmax(0,1fr)_minmax(12rem,0.9fr)] gap-3 border-b border-border bg-muted/35 px-3 py-2 text-[11px] font-semibold text-muted-foreground sm:grid">
                  <span>失败关键词</span>
                  <span>单项执行 Agent</span>
                </div>
                {keywordRetryAllocation.map(allocation => {
                  const overriddenElsewhere = new Set(
                    Object.entries(keywordRetryAgentOverrides)
                      .filter(([itemId]) => itemId !== allocation.item.id)
                      .map(([, agentId]) => agentId),
                  )
                  return (
                    <div
                      key={allocation.item.id}
                      className="grid grid-cols-1 gap-2 border-b border-border px-3 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.9fr)] sm:items-center sm:gap-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">
                          {keywordForItem(allocation.item)}
                        </p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {allocation.strictWaiting
                            ? '已人工覆盖 · 指定 Agent 当前不可用，将严格等待'
                            : allocation.overridden
                              ? '已人工覆盖'
                              : '自动分配预览'}
                        </p>
                      </div>
                      <select
                        aria-label={`为关键词 ${keywordForItem(allocation.item)} 选择重试 Agent`}
                        value={keywordRetryAgentOverrides[allocation.item.id] || ''}
                        onChange={event => setKeywordRetryAgentOverrides(current => ({
                          ...current,
                          [allocation.item.id]: event.target.value,
                        }))}
                        disabled={
                          !writable ||
                          keywordRetrying ||
                          (
                            keywordRetryCandidates.length === 0 &&
                            !allocation.overrideAgentId
                          )
                        }
                        className="h-9 min-w-0 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-primary"
                      >
                        <option value="">
                          {allocation.agent
                            ? `自动 · ${agentName(allocation.agent)}`
                            : '自动 · 等待槽位释放后接力'}
                        </option>
                        {allocation.strictWaiting && (
                          <option value={allocation.overrideAgentId}>
                            已指定 · 当前不可用（将严格等待）
                          </option>
                        )}
                        {keywordRetryCandidates.map(agent => (
                          <option
                            key={agent.id}
                            value={agent.id}
                            disabled={overriddenElsewhere.has(agent.id)}
                          >
                            {agentName(agent)}
                            {keywordRetrySourceAgentIds.has(agent.id) ? '（原 Agent）' : ''}
                            {agent.todaySearches !== undefined
                              ? ` · 今日搜索 ${agent.todaySearches}${agent.dailySearchLimit
                                ? `/${agent.dailySearchLimit}`
                                : ''}`
                              : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}
        {negativePatrol && negativeReassignItems.length > 0 && (
          <section className="mb-4 overflow-hidden rounded-2xl border border-primary/20 bg-primary/[0.025]">
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <RefreshCw className="h-4.5 w-4.5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold text-foreground">
                      {negativeReassignItems.length} 条帖子尚未完成
                    </h3>
                    <span className="rounded-full bg-status-red/8 px-2 py-0.5 text-[10px] font-semibold text-status-red">
                      {idleHandoffAllowed ? '系统自动分配' : '可重新分配'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {idleHandoffAllowed
                      ? '系统按单条帖子选择在线空闲 Agent；已完成、已删除或不可访问的帖子不会重复执行。'
                      : '只会重建失败或未结算的逐帖任务；已完成、已删除或不可访问的帖子继续保留原结果。'}
                  </p>
                </div>
              </div>
              {idleHandoffAllowed ? (
                <span className="inline-flex min-h-9 items-center rounded-lg border border-primary/20 bg-primary/[0.045] px-3 text-xs font-medium text-primary">
                  {negativeReassignCandidates.length > 0
                    ? '系统将在一分钟内自动下发，无需人工操作'
                    : '正在等待兼容的空闲 Agent，上线后自动继续'}
                </span>
              ) : !negativeReassignOpen && (
                <Button
                  size="sm"
                  onClick={openNegativeReassign}
                  disabled={!writable || negativeReassignBlockedByActiveExecution}
                  title={
                    !writable
                      ? '当前账号为只读权限'
                      : negativeReassignBlockedByActiveExecution
                        ? '当前批次仍有 Agent 在运行，请先等待结束或停止任务'
                        : '选择在线 Agent 重新分配未完成帖子'
                  }
                >
                  <Send className="h-4 w-4" />
                  重新分配未完成帖子
                </Button>
              )}
            </div>
            {negativeReassignBlockedByActiveExecution && !negativeReassignOpen && (
              <p className="border-t border-border/70 bg-background/55 px-4 py-2.5 text-[11px] leading-4 text-muted-foreground">
                {idleHandoffAllowed
                  ? '当前批次仍有 Agent 在执行或等待设备；系统会先避免同一帖子并发，待可安全接力时自动继续。'
                  : '当前批次仍有 Agent 在执行或等待设备。为避免同一帖子并发执行，请先等待批次结束，或停止任务后再重新分配。'}
              </p>
            )}
            {!idleHandoffAllowed && negativeReassignOpen && (
              <div className="border-t border-border/70 bg-background/70 p-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h4 className="text-xs font-bold text-foreground">选择接力 Agent</h4>
                    <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                      默认排除原失败节点；确有需要时可以手动勾回。每条帖子只会交给一个新执行节点。
                    </p>
                  </div>
                  <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                    已选 {selectedNegativeReassignAgents.length} / 最多 {negativeReassignItems.length}
                  </span>
                </div>
                {negativeReassignCandidates.length === 0 ? (
                  <div className="mt-3 rounded-xl border border-dashed border-border bg-muted/25 px-3 py-5 text-center text-xs text-muted-foreground">
                    当前没有在线且兼容负面巡查的 Agent。请先让可用 Extension 上线或升级。
                  </div>
                ) : (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {negativeReassignCandidates.map(agent => {
                      const checked = negativeReassignAgentIds.has(agent.id)
                      const originalFailed = negativeReassignSourceAgentIds.has(agent.id)
                      const selectionFull =
                        !checked &&
                        negativeReassignAgentIds.size >= negativeReassignItems.length
                      return (
                        <label
                          key={agent.id}
                          className={cn(
                            'flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors',
                            checked
                              ? 'border-primary/35 bg-primary/[0.045]'
                              : 'border-border/70 bg-card hover:border-primary/25',
                            selectionFull && 'cursor-not-allowed opacity-55',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleNegativeReassignAgent(agent.id)}
                            disabled={negativeReassigning || selectionFull}
                            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <strong className="truncate text-xs font-semibold text-foreground">
                                {agentName(agent)}
                              </strong>
                              {originalFailed && (
                                <span className="rounded-full bg-status-red/8 px-1.5 py-0.5 text-[9px] font-semibold text-status-red">
                                  原失败节点
                                </span>
                              )}
                            </span>
                            <span className="mt-1 block text-[10px] text-muted-foreground">
                              在线 · 执行中 {Number(agent.active_task_count || 0)} · 排队 {Number(agent.queued_task_count || 0)}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
                {negativeReassignAllocation.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted/30 px-3 py-2.5">
                    <span className="text-[10px] font-semibold text-muted-foreground">预计分配</span>
                    {negativeReassignAllocation.map(({ agent, count }) => (
                      <span key={agent.id} className="rounded-md border border-border/70 bg-card px-2 py-1 text-[10px] text-foreground">
                        {agentName(agent)} · {count} 条
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setNegativeReassignOpen(false)
                      setNegativeReassignAgentIds(new Set())
                    }}
                    disabled={negativeReassigning}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void submitNegativeReassign()}
                    disabled={
                      !writable ||
                      negativeReassigning ||
                      selectedNegativeReassignAgents.length === 0
                    }
                  >
                    {negativeReassigning
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Send className="h-4 w-4" />}
                    确认重新分配 {negativeReassignItems.length} 条
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
        {scheduleTemplate && schedule && (
          <section className="mb-4 rounded-2xl border border-primary/20 bg-primary/[0.035] p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <CalendarDays className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <h3 className="text-sm font-bold text-foreground">云端运行计划</h3>
                  <span className="text-[11px] text-muted-foreground">
                    {schedule.schedule_mode === 'custom_dates' ? '指定日期' : '每天'} {String(schedule.start_time || '09:00').slice(0, 5)}
                    {Number(schedule.random_offset_min || 0) > 0 ? ` · 随机延迟 0–${Number(schedule.random_offset_min)} 分钟` : ''}
                  </span>
                </div>
                <div className="mt-2 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                  <div>下次运行：<strong className="font-semibold text-foreground">{formatTime(schedule.next_run_at)}</strong></div>
                  <div>已生成：<strong className="font-semibold text-foreground">{Number(schedule.run_count || 0)} 轮</strong></div>
                  <div>上轮状态：<strong className="font-semibold text-foreground">{schedule.last_run_status ? statusLabel(schedule.last_run_status) : '尚未运行'}</strong></div>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                  {sequentialSearchEnabled
                    ? `每个关键词由同一 Agent 按“${patrolPathLabel}”串行完成；每次搜索采集后增强新增内容，不自动刷新补搜。`
                    : '每个计划时间，每个关键词执行 1 次。'} 计划只保存在云端，不会覆盖任一 Extension 的本地无人值守计划。
                </p>
              </div>
            </div>
          </section>
        )}
        <ol className="mb-4 flex items-center gap-2 overflow-x-auto pb-1" aria-label="编排任务结构">
          <li className="flex min-w-36 items-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.045] px-3 py-2">
            <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
            <span><span className="block text-[10px] text-muted-foreground">{scheduleTemplate ? '计划模板' : '父任务'}</span><span className="block text-xs font-bold">{sortedItems.length} {contentPatrol ? '条帖子' : '个工作项'}</span></span>
          </li>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/45" />
          <li className="flex min-w-36 items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
            <Activity className="h-4 w-4 shrink-0 text-primary" />
            <span>
              <span className="block text-[10px] text-muted-foreground">{scheduleTemplate ? (elasticPool ? '领取策略' : '固定分配') : '工作项状态'}</span>
              <span className="block text-xs font-bold">{scheduleTemplate ? (elasticPool ? '空闲节点逐个领取' : `${sortedItems.length} 个关键词已分配`) : `${settledCount} 已结算 · ${activeCount} 进行/等待`}</span>
            </span>
          </li>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/45" />
          <li className="flex min-w-36 items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
            <Users className="h-4 w-4 shrink-0 text-primary" />
            <span><span className="block text-[10px] text-muted-foreground">Agent 小队</span><span className="block text-xs font-bold">{agents.length} 个执行节点</span></span>
          </li>
        </ol>

        <section className="rounded-2xl border border-border/70 bg-background p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Task</div>
              <h3 className="mt-1 text-sm font-bold text-foreground">{scheduleTemplate ? '计划分配' : '父任务进度'}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {scheduleTemplate
                  ? elasticPool
                    ? '这里展示后续每轮都会沿用的关键词和弹性节点池；实际领取量由节点空闲速度决定。'
                    : '这里展示后续每轮都会沿用的关键词和 Agent 分配。'
                  : contentPatrol
                    ? '按每条帖子的真实巡查结果汇总，并展示它由哪个 Agent 执行。'
                    : '只按服务端返回的工作项状态统计，不推测 Extension 当前页面步骤。'}
              </p>
            </div>
            {!scheduleTemplate && <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-md bg-status-green/10 px-2 py-1 font-medium text-status-green">成功 {completedCount}</span>
              <span className="rounded-md bg-primary/8 px-2 py-1 font-medium text-primary">进行/等待 {activeCount}</span>
              {failedCount > 0 && <span className="rounded-md bg-status-red/8 px-2 py-1 font-medium text-status-red">异常 {failedCount}</span>}
            </div>}
          </div>
          {!scheduleTemplate && <div className="mt-4 flex items-center gap-3">
            <div
              className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="编排任务已结算进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
              aria-valuetext={`${settledCount} / ${sortedItems.length} 个工作项已结算`}
            >
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progressPercent}%` }} />
            </div>
            <span className="shrink-0 text-xs font-bold tabular-nums text-foreground">{settledCount}/{sortedItems.length}</span>
          </div>}
          {(Number.isFinite(keywordLimit) || searchFilters || captureSettings) && (
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
              {Number.isFinite(keywordLimit) && keywordLimit > 0 && <span>每词上限 <strong className="font-semibold text-foreground">{keywordLimit} 条</strong></span>}
              {searchFilters && <span>筛选 <strong className="font-semibold text-foreground">
                {SORT_LABELS[String(searchFilters.sort || '')] || String(searchFilters.sort || '默认')} · {PUBLISH_TIME_LABELS[String(searchFilters.publishTime || '')] || String(searchFilters.publishTime || '不限')} · {sequentialSearchEnabled ? patrolPathLabel : CONTENT_TYPE_LABELS[String(searchFilters.contentType || 'all')] || String(searchFilters.contentType || '全部')} · {SEARCH_SCOPE_LABELS[String(searchFilters.searchScope || 'all')] || String(searchFilters.searchScope || '全部')}
                {orchestration.platform === 'xiaohongshu' ? ` · ${DISTANCE_LABELS[String(searchFilters.distance || 'all')] || String(searchFilters.distance || '不限距离')}` : ''}
                {orchestration.platform === 'douyin' ? ` · ${VIDEO_DURATION_LABELS[String(searchFilters.videoDuration || 'all')] || String(searchFilters.videoDuration || '不限时长')}` : ''}
              </strong></span>}
              {captureSettings && <span>采集增强 <strong className="font-semibold text-foreground">{captureSettings.autoDetailCaptureAfterListCapture === true ? '已开启' : '未开启'}</strong></span>}
            </div>
          )}
        </section>

        {!contentPatrol && !scheduleTemplate ? (
          <div className="mt-4">
            <KeywordExecutionReport
              items={sortedItems}
              executions={executions}
              agents={agents}
              attempts={attempts}
            />
          </div>
        ) : <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
          <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Work items</div>
                <h3 className="mt-0.5 text-sm font-bold text-foreground">{watchedContentPatrol ? '关注内容工作项' : negativePatrol ? '负面帖子工作项' : '关键词工作项'}</h3>
              </div>
              <span className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{sortedItems.length} 项</span>
            </div>
            {sortedItems.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-muted-foreground">服务端尚未返回工作项。</div>
            ) : (
              <div className="divide-y divide-border/70">
                {sortedItems.map((item, index) => {
                  const assignedAgentId = itemAssignedAgentId(item, executions, attempts)
                  const assignedAgent = agentsById.get(assignedAgentId)
                  const itemAttempts = attemptsByItem.get(item.id) || []
                  const errorMessage = dataMessage(item.error)
                  const availabilityLabel = itemAvailabilityLabel(item)
                  return (
                    <article key={item.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-start">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-xs font-bold tabular-nums text-muted-foreground">
                        {Number.isFinite(Number(item.ordinal)) ? Number(item.ordinal) + 1 : index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="truncate text-sm font-semibold text-foreground">{keywordForItem(item)}</h4>
                          {contentPatrol && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                              {PLATFORM_LABELS[item.platform] || item.platform}
                            </span>
                          )}
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTone(item.status)}`}>
                            {availabilityLabel || statusLabel(item.status)}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span>Agent：<strong className="font-medium text-foreground">{agentName(assignedAgent)}</strong></span>
                          {itemAttempts.length > 0 && <span>尝试记录：{itemAttempts.length}</span>}
                          <span>更新：{formatTime(item.updated_at)}</span>
                        </div>
                        {errorMessage && <p className="mt-1.5 text-[11px] leading-4 text-status-red">{errorMessage}</p>}
                      </div>
                      <span className="hidden text-[10px] font-mono text-muted-foreground sm:block">{item.id.slice(0, 8)}</span>
                    </article>
                  )
                })}
              </div>
            )}
          </section>

          <section className="self-start overflow-hidden rounded-2xl border border-border/70 bg-card">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Agent team</div>
                <h3 className="mt-0.5 text-sm font-bold text-foreground">执行节点与子任务</h3>
              </div>
              <Bot className="h-4 w-4 text-primary" />
            </div>
            {agents.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-muted-foreground">{elasticPool ? '尚未有节点领取工作项。' : '服务端尚未返回分配节点。'}</div>
            ) : (
              <div className="divide-y divide-border/70">
                {agents.map(agent => {
                  const agentExecutions = executions.filter(execution => executionAgentId(execution) === agent.id)
                  const assignedItems = sortedItems.filter(item => itemAssignedAgentId(item, executions, attempts) === agent.id)
                  return (
                    <article key={agent.id} className="p-4">
                      <div className="flex items-start gap-3">
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}><Bot className="h-4 w-4" /></span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <h4 className="truncate text-xs font-bold text-foreground">{agentName(agent)}</h4>
                            <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
                              {agent.online ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
                              {agent.online ? '在线' : '离线'}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-[11px] text-muted-foreground">{agent.host_label} › {agent.browser_name} · {agent.operating_system}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">分配 {assignedItems.length} {contentPatrol ? '条帖子' : '个工作项'} · {agentExecutions.length} 条子任务记录</p>
                        </div>
                      </div>
                      {agentExecutions.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {agentExecutions.map((execution, index) => (
                            <div key={executionTaskId(execution) || index} className="rounded-lg border border-border/70 bg-muted/25 px-2.5 py-2">
                              {(() => {
                                const executionItems = sortedItems.filter(item => item.execution_task_id === executionTaskId(execution))
                                const itemCount = executionItemIds(execution).length || executionItems.length || (execution.keywords || []).length
                                return <>
                              <div className="flex items-center justify-between gap-2">
                                <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold ${statusTone(String(execution.status || ''))}`}>{statusLabel(String(execution.status || ''))}</span>
                                <span className="text-[10px] text-muted-foreground">{itemCount} {contentPatrol ? '条帖子' : '个工作项'}</span>
                              </div>
                              <div className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground">{executionTaskId(execution) || '未返回子任务 ID'}</div>
                              {(execution.command_status || execution.command_expires_at) && (
                                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                                  指令：<span className="font-medium text-foreground">
                                    {COMMAND_STATUS_LABELS[String(execution.command_status || '')] || String(execution.command_status || '状态未记录')}
                                  </span>
                                  {execution.command_expires_at ? ` · 有效至 ${formatTime(execution.command_expires_at)}` : ''}
                                </p>
                              )}
                              {executionOnline(execution) === false && <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">节点离线；子任务保持服务端返回的当前状态。</p>}
                              {execution.message && <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{execution.message}</p>}
                                </>
                              })()}
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
            {!contentPatrol && <div className="border-t border-border/70 bg-muted/25 p-3">
              <p className="text-[10px] leading-4 text-muted-foreground">
                任务遇到安全验证时（包括验证码或登录要求），运营只需处理当前受阻关键词；它留在原 Agent。接力只处理尚未开始的完整关键词，并由系统自动逐词分配。
              </p>
            </div>}
          </section>
        </div>}
      </div>
    </section>
  )
}
