import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ClipboardList,
  Loader2,
  Play,
  Settings2,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ScheduledDatesPicker } from './ScheduledDatesPicker'
import { Drawer } from '@/components/shared/Drawer'
import { shanghaiToday } from './lib'
import type {
  CaptureEnhancementSettings,
  OrchestrationCloudAgent,
  OrchestrationComposerDrawerProps,
  OrchestrationDispatchResult,
  OrchestrationExecutionMode,
  OrchestrationItemRecord,
  OrchestrationPlatform,
  OrchestrationRecord,
  OrchestrationScheduleUpdateResult,
} from './types'

type ComposerStage = 'define' | 'allocate' | 'dispatched'
type PlanMode = 'daily' | 'custom_dates'
type DistributionMode = 'fixed_batch' | 'elastic_pool'

type CreateResponse = {
  ok: true
  existing: boolean
  orchestration: OrchestrationRecord
  items: OrchestrationItemRecord[]
}

type AllocationPreviewGroup = {
  agentId: string
  agent: Pick<
    OrchestrationCloudAgent,
    'id' | 'display_name' | 'host_label' | 'browser_name' | 'operating_system' | 'app_version' | 'online'
  >
  itemIds: string[]
  keywords: string[]
  itemCount: number
}

type AllocationPreviewResponse = {
  ok: true
  orchestrationId: string
  revision: number
  platform: string
  itemCount: number
  groups: AllocationPreviewGroup[]
}

type EditableAssignment = {
  itemId: string
  keyword: string
  agentId: string
}

const PLATFORM_OPTIONS: Array<{ value: OrchestrationPlatform; label: string }> = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
]

const SORT_OPTIONS = [
  { value: 'comprehensive', label: '综合排序' },
  { value: 'latest', label: '最新发布' },
  { value: 'likes', label: '最多点赞' },
]

const PUBLISH_TIME_OPTIONS = [
  { value: 'all', label: '不限时间' },
  { value: 'day', label: '一天内' },
  { value: 'week', label: '一周内' },
  { value: 'halfyear', label: '半年内' },
]

const inputClassName = 'mt-1.5 h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/55 hover:border-muted-foreground/35 focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-55'
const textareaClassName = 'mt-1.5 w-full resize-y rounded-lg border border-input bg-card px-3 py-2.5 text-sm leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/55 hover:border-muted-foreground/35 focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-55'

function randomRequestKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16)
    const value = character === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function uniqueKeywords(value: string) {
  return Array.from(new Set(
    value
      .split(/\r?\n/g)
      .map(keyword => keyword.trim())
      .filter(Boolean),
  ))
}

function normalizeScheduleDate(value: string) {
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return ''
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseCustomDates(value: string) {
  const candidates = value
    .split(/[\n,，;；]+/g)
    .map(candidate => candidate.trim())
    .filter(Boolean)
  const invalidDates: string[] = []
  const dates = Array.from(new Set(candidates.map(candidate => {
    const normalized = normalizeScheduleDate(candidate)
    if (!normalized) invalidDates.push(candidate)
    return normalized
  }).filter(Boolean))).sort()
  return { dates, invalidDates }
}

function formatScheduleTime(value?: string | null) {
  if (!value) return '等待云端计算'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function safeCount(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : []
}

function agentPlatforms(agent: OrchestrationCloudAgent) {
  const supportedPlatforms = Array.isArray(agent.capabilities?.supportedPlatforms)
    ? agent.capabilities.supportedPlatforms.map(value => String(value || '').trim()).filter(Boolean)
    : []
  const allowedPlatforms = Array.isArray(agent.allowed_platforms)
    ? agent.allowed_platforms.map(value => String(value || '').trim()).filter(Boolean)
    : []
  return PLATFORM_OPTIONS
    .map(option => option.value)
    .filter(platform =>
      (supportedPlatforms.length === 0 || supportedPlatforms.includes(platform)) &&
      (allowedPlatforms.length === 0 || allowedPlatforms.includes(platform)),
    )
}

function agentBlockReason(
  agent: OrchestrationCloudAgent,
  platform: OrchestrationPlatform,
  enhancementEnabled: boolean,
) {
  if (agent.status !== 'active') return agent.status === 'paused' ? '节点已暂停接单' : '节点已撤销'
  if (agent.capabilities?.remoteTaskCreate !== true) return 'Extension 版本不支持云端任务'
  if (!agentPlatforms(agent).includes(platform)) {
    return `该节点不支持${PLATFORM_OPTIONS.find(option => option.value === platform)?.label || platform}`
  }
  if (agent.capabilities?.remoteTaskKeywordPostLimit !== true) return 'Extension 版本不支持任务级帖子上限'
  if (enhancementEnabled && agent.capabilities?.remoteTaskEnhancementOptions !== true) {
    return 'Extension 版本不支持远程采集增强'
  }
  return ''
}

function allocationAgentLabel(agent: OrchestrationCloudAgent) {
  const host = agent.host_label || '未命名设备'
  const node = agent.display_name || '未命名节点'
  const browser = agent.browser_name || '浏览器'
  return `${host} › ${node} · ${browser}`
}

function keywordForItem(item: OrchestrationItemRecord) {
  const metadataKeyword = item.metadata?.keyword
  return typeof metadataKeyword === 'string' && metadataKeyword.trim()
    ? metadataKeyword.trim()
    : item.item_key
}

function buildAssignments(createResult: CreateResponse, preview: AllocationPreviewResponse) {
  const previewByItem = new Map<string, { agentId: string; keyword: string }>()
  for (const group of preview.groups) {
    group.itemIds.forEach((itemId, index) => {
      previewByItem.set(itemId, {
        agentId: group.agentId,
        keyword: group.keywords[index] || '',
      })
    })
  }

  return [...createResult.items]
    .sort((left, right) => {
      const ordinalDiff = safeCount(left.ordinal) - safeCount(right.ordinal)
      if (ordinalDiff !== 0) return ordinalDiff
      return String(left.created_at || '').localeCompare(String(right.created_at || ''))
    })
    .map(item => ({
      itemId: item.id,
      keyword: previewByItem.get(item.id)?.keyword || keywordForItem(item),
      agentId: previewByItem.get(item.id)?.agentId || '',
    }))
}

function buildEditPreview({
  orchestrationId,
  revision,
  platform,
  keywords,
  selectedAgents,
  existingItems,
}: {
  orchestrationId: string
  revision: number
  platform: string
  keywords: string[]
  selectedAgents: OrchestrationCloudAgent[]
  existingItems: OrchestrationItemRecord[]
}) {
  const existingItemIdByKeyword = new Map(
    existingItems.map(item => [keywordForItem(item), item.id]),
  )
  const baseSize = Math.floor(keywords.length / selectedAgents.length)
  const remainder = keywords.length % selectedAgents.length
  const groups: AllocationPreviewGroup[] = []
  const assignments: EditableAssignment[] = []
  let cursor = 0
  selectedAgents.forEach((agent, agentIndex) => {
    const size = baseSize + (agentIndex < remainder ? 1 : 0)
    if (size === 0) return
    const groupKeywords = keywords.slice(cursor, cursor + size)
    const itemIds = groupKeywords.map((keyword, offset) =>
      existingItemIdByKeyword.get(keyword) || `edit-${cursor + offset}`,
    )
    groups.push({
      agentId: agent.id,
      agent,
      itemIds,
      keywords: groupKeywords,
      itemCount: groupKeywords.length,
    })
    groupKeywords.forEach((keyword, offset) => assignments.push({
      itemId: itemIds[offset],
      keyword,
      agentId: agent.id,
    }))
    cursor += size
  })
  return {
    preview: {
      ok: true as const,
      orchestrationId,
      revision,
      platform,
      itemCount: keywords.length,
      groups,
    },
    assignments,
  }
}

function StepPill({ active, complete, children }: { active: boolean; complete: boolean; children: ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-2 ${active ? 'border-primary/35 bg-primary/8' : complete ? 'border-status-green/25 bg-status-green/5' : 'border-border/70 bg-muted/30'}`}>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${active ? 'bg-primary text-primary-foreground' : complete ? 'bg-status-green text-white' : 'bg-muted text-muted-foreground'}`}>
        {complete ? <CheckCircle2 className="h-3.5 w-3.5" /> : active ? '●' : '○'}
      </span>
      <span className={`truncate text-xs font-semibold ${active ? 'text-primary' : complete ? 'text-status-green' : 'text-muted-foreground'}`}>{children}</span>
    </div>
  )
}

export function OrchestrationComposerDrawer({
  open,
  writable,
  agents,
  initialExecutionMode = 'one_time',
  lockExecutionMode = false,
  minimumAgentCount = 1,
  initialAgentIds,
  editingPlan,
  copyingPlan,
  onClose,
  onDispatched,
  onPlanUpdated,
  onChanged,
}: OrchestrationComposerDrawerProps) {
  const editMode = Boolean(editingPlan)
  const copyMode = !editMode && Boolean(copyingPlan)
  const sourcePlan = useMemo(
    () => editingPlan || copyingPlan || null,
    [copyingPlan, editingPlan],
  )
  const [stage, setStage] = useState<ComposerStage>('define')
  const [title, setTitle] = useState('')
  const [platform, setPlatform] = useState<OrchestrationPlatform>('xiaohongshu')
  const [executionMode, setExecutionMode] = useState<OrchestrationExecutionMode>(initialExecutionMode)
  const [planMode, setPlanMode] = useState<PlanMode>('daily')
  const [startTime, setStartTime] = useState('09:00')
  const [randomOffsetMin, setRandomOffsetMin] = useState(20)
  const [customDates, setCustomDates] = useState('')
  const [keywordText, setKeywordText] = useState('')
  const [keywordMaxDetectedItems, setKeywordMaxDetectedItems] = useState(50)
  const [sort, setSort] = useState('comprehensive')
  const [publishTime, setPublishTime] = useState('all')
  const [enhancementEnabled, setEnhancementEnabled] = useState(false)
  const [autoSync, setAutoSync] = useState(false)
  const [aiPrefilter, setAiPrefilter] = useState(false)
  const [bloggerMetrics, setBloggerMetrics] = useState(false)
  const [includeComments, setIncludeComments] = useState(false)
  const [commentLimit, setCommentLimit] = useState(50)
  const [skipCaptured, setSkipCaptured] = useState(true)
  const allowIdleAgentHandoff = true
  const [distributionMode, setDistributionMode] = useState<DistributionMode>('elastic_pool')
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [selectionNotice, setSelectionNotice] = useState('')
  const [createResult, setCreateResult] = useState<CreateResponse | null>(null)
  const [createFingerprint, setCreateFingerprint] = useState('')
  const [preview, setPreview] = useState<AllocationPreviewResponse | null>(null)
  const [assignments, setAssignments] = useState<EditableAssignment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [discardingDraft, setDiscardingDraft] = useState(false)
  const [pendingDraftCount, setPendingDraftCount] = useState(0)
  const [error, setError] = useState('')
  const [dispatchResult, setDispatchResult] = useState<OrchestrationDispatchResult | null>(null)
  const [updateResult, setUpdateResult] = useState<OrchestrationScheduleUpdateResult | null>(null)
  const requestKeyRef = useRef(randomRequestKey())
  const previouslyOpenRef = useRef(false)
  const submittingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const onChangedRef = useRef(onChanged)
  const draftIdsRef = useRef(new Set<string>())
  const draftCleanupPromiseRef = useRef<Promise<boolean> | null>(null)

  const keywords = useMemo(() => uniqueKeywords(keywordText), [keywordText])
  const sortedAgents = useMemo(() => [...agents].sort((left, right) => {
    const leftBlocked = Boolean(agentBlockReason(left, platform, enhancementEnabled))
    const rightBlocked = Boolean(agentBlockReason(right, platform, enhancementEnabled))
    if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1
    if (left.online !== right.online) return left.online ? -1 : 1
    return `${left.host_label}${left.display_name}`.localeCompare(`${right.host_label}${right.display_name}`, 'zh-CN')
  }), [agents, enhancementEnabled, platform])
  const validSelectedAgentIds = useMemo(
    () => selectedAgentIds.filter(agentId => {
      const agent = agents.find(candidate => candidate.id === agentId)
      return agent ? !agentBlockReason(agent, platform, enhancementEnabled) : false
    }),
    [agents, enhancementEnabled, platform, selectedAgentIds],
  )
  const selectedAgents = useMemo(
    () => validSelectedAgentIds
      .map(agentId => agents.find(agent => agent.id === agentId))
      .filter((agent): agent is OrchestrationCloudAgent => Boolean(agent)),
    [agents, validSelectedAgentIds],
  )
  const busy = submitting || discardingDraft
  const requiredAgentCount = Number.isFinite(minimumAgentCount)
    ? Math.max(1, Math.floor(minimumAgentCount))
    : 1
  const dispatchedSchedule = updateResult?.schedule || dispatchResult?.schedule
  const nextScheduleRunAt = dispatchedSchedule?.next_run_at || dispatchedSchedule?.nextRunAt || null

  const reset = useCallback(() => {
    const schedule = sourcePlan?.schedule
    const metadata = safeRecord(sourcePlan?.orchestration.metadata)
    const planSnapshot = {
      ...safeRecord(metadata.planSnapshot),
      ...safeRecord(schedule?.plan_snapshot),
    }
    const searchFilters = safeRecord(planSnapshot.searchFilters)
    const enhancementSettings = safeRecord(planSnapshot.captureSettings)
    const editingPlatform = sourcePlan?.orchestration.platform === 'douyin'
      ? 'douyin'
      : 'xiaohongshu'
    const editingEnhancementEnabled = enhancementSettings.autoDetailCaptureAfterListCapture === true
    const scheduleDates = planSnapshot.customDates ?? schedule?.custom_dates ?? ''
    const editingAgentIds = stringList(metadata.eligibleAgentIds).length > 0
      ? stringList(metadata.eligibleAgentIds)
      : (sourcePlan?.agents || []).map(agent => agent.id)
    const candidateAgentIds = sourcePlan ? editingAgentIds : (initialAgentIds ?? [])
    const targetPlatform = sourcePlan ? editingPlatform : 'xiaohongshu'
    const targetEnhancementEnabled = sourcePlan ? editingEnhancementEnabled : false
    const compatibleInitialAgentIds = candidateAgentIds.filter(agentId => {
      const agent = agents.find(candidate => candidate.id === agentId)
      return agent && !agentBlockReason(agent, targetPlatform, targetEnhancementEnabled)
    })

    setStage('define')
    setTitle(copyMode ? `${sourcePlan?.orchestration.title || '无人值守计划'}（副本）` : sourcePlan?.orchestration.title || '')
    setPlatform(targetPlatform)
    setExecutionMode(editMode ? 'unattended_plan' : initialExecutionMode)
    if (copyMode && initialExecutionMode !== 'unattended_plan') {
      setExecutionMode('unattended_plan')
    }
    setPlanMode(
      (schedule?.schedule_mode || planSnapshot.mode) === 'custom_dates'
        ? 'custom_dates'
        : 'daily',
    )
    setStartTime(String(schedule?.start_time || planSnapshot.startTime || '09:00').slice(0, 5))
    setRandomOffsetMin(safeCount(schedule?.random_offset_min ?? planSnapshot.randomOffsetMin ?? 20))
    setCustomDates(Array.isArray(scheduleDates) ? scheduleDates.join('\n') : String(scheduleDates || ''))
    setKeywordText(sourcePlan
      ? [...sourcePlan.items]
        .sort((left, right) => safeCount(left.ordinal) - safeCount(right.ordinal))
        .map(keywordForItem)
        .join('\n')
      : '')
    setKeywordMaxDetectedItems(safeCount(planSnapshot.keywordMaxDetectedItems) || 50)
    setSort(String(searchFilters.sort || 'comprehensive'))
    setPublishTime(String(searchFilters.publishTime || 'all'))
    setEnhancementEnabled(editingEnhancementEnabled)
    setAutoSync(enhancementSettings.autoSyncAfterDetailCapture === true)
    setAiPrefilter(enhancementSettings.enableAiRelevancePrefilter === true)
    setBloggerMetrics(enhancementSettings.includeBloggerMetricsOnDetailCapture === true)
    setIncludeComments(enhancementSettings.includeCommentsOnDetailCapture === true)
    setCommentLimit(safeCount(enhancementSettings.detailCommentsMaxDetectedItems) || 50)
    setSkipCaptured(enhancementSettings.skipAlreadyCapturedOnDetailCapture !== false)
    setDistributionMode(
      (schedule?.distribution_mode || metadata.distributionMode) === 'fixed_batch'
        ? 'fixed_batch'
        : 'elastic_pool',
    )
    setSelectedAgentIds(compatibleInitialAgentIds)
    setSelectionNotice(
      compatibleInitialAgentIds.length < candidateAgentIds.length
        ? sourcePlan
          ? '原计划中有节点当前不可用或不兼容，已移除；保存前请重新确认 Agent 小队。'
          : '已移除与默认小红书平台不兼容的预选节点，请重新确认 Agent 小队。'
        : '',
    )
    setCreateResult(null)
    setCreateFingerprint('')
    setPreview(null)
    setAssignments([])
    setSubmitting(false)
    setDiscardingDraft(false)
    setPendingDraftCount(draftIdsRef.current.size)
    setError('')
    setDispatchResult(null)
    setUpdateResult(null)
    requestKeyRef.current = randomRequestKey()
  }, [agents, copyMode, editMode, initialAgentIds, initialExecutionMode, sourcePlan])

  useEffect(() => {
    if (open && !previouslyOpenRef.current) reset()
    previouslyOpenRef.current = open
  }, [open, reset])

  useEffect(() => {
    submittingRef.current = busy
  }, [busy])

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])

  const discardCreatedDrafts = async () => {
    if (draftCleanupPromiseRef.current) return draftCleanupPromiseRef.current
    const draftIds = Array.from(draftIdsRef.current)
    if (draftIds.length === 0) return true

    setDiscardingDraft(true)
    setError('')
    const cleanupPromise = (async () => {
      let refreshNeeded = false
      const results = await Promise.allSettled(
        draftIds.map(async orchestrationId => {
          try {
            await api.delete(`/capture-cloud/orchestrations/${orchestrationId}/draft`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err || '')
            const alreadyAbsent = /编排任务不存在|not found|\b404\b/i.test(message)
            const noLongerDraft = /已经下发|状态变化|不能作为草稿|not.?draft|\b409\b/i.test(message)
            if (alreadyAbsent || noLongerDraft) {
              if (noLongerDraft) refreshNeeded = true
              return
            }
            throw err
          }
        }),
      )
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') draftIdsRef.current.delete(draftIds[index])
      })
      const failedCount = results.filter(result => result.status === 'rejected').length
      setPendingDraftCount(draftIdsRef.current.size)
      if (refreshNeeded) {
        try {
          await onChangedRef.current?.()
        } catch {
          setError('任务已不再是草稿，已停止本地清理；任务列表刷新失败，请稍后手动刷新。')
        }
      }
      if (failedCount > 0) {
        setError(`有 ${failedCount} 个未下发草稿未能取消。请检查网络后重试；为避免留下无效任务，当前不会关闭或创建新草稿。`)
        return false
      }
      return true
    })()
    draftCleanupPromiseRef.current = cleanupPromise
    try {
      return await cleanupPromise
    } finally {
      draftCleanupPromiseRef.current = null
      setDiscardingDraft(false)
    }
  }

  const clearCreatedDraftState = () => {
    setCreateResult(null)
    setCreateFingerprint('')
    setPreview(null)
    setAssignments([])
    requestKeyRef.current = randomRequestKey()
  }

  const markDefinitionChanged = () => {
    setError('')
    clearCreatedDraftState()
    if (draftIdsRef.current.size > 0) void discardCreatedDrafts()
  }

  const requestClose = async () => {
    if (submittingRef.current) return
    const discarded = await discardCreatedDrafts()
    if (discarded && draftIdsRef.current.size === 0) onCloseRef.current()
  }

  const keepCompatibleAgents = (
    candidateIds: string[],
    targetPlatform: OrchestrationPlatform,
    targetEnhancementEnabled: boolean,
  ) => {
    const compatibleIds = candidateIds.filter(agentId => {
      const agent = agents.find(candidate => candidate.id === agentId)
      return agent && !agentBlockReason(agent, targetPlatform, targetEnhancementEnabled)
    })
    const removedNames = candidateIds
      .filter(agentId => !compatibleIds.includes(agentId))
      .map(agentId => agents.find(candidate => candidate.id === agentId)?.display_name || `Agent ${agentId.slice(0, 8)}`)
    setSelectedAgentIds(compatibleIds)
    setSelectionNotice(
      removedNames.length > 0
        ? `已移除不兼容节点：${removedNames.join('、')}。请按当前平台和采集设置补选。`
        : '',
    )
  }

  const changePlatform = (value: OrchestrationPlatform) => {
    markDefinitionChanged()
    setPlatform(value)
    keepCompatibleAgents(selectedAgentIds, value, enhancementEnabled)
  }

  const changeEnhancementEnabled = (value: boolean) => {
    markDefinitionChanged()
    setEnhancementEnabled(value)
    if (!value) {
      setAutoSync(false)
      setAiPrefilter(false)
      setBloggerMetrics(false)
      setIncludeComments(false)
    }
    keepCompatibleAgents(selectedAgentIds, platform, value)
  }

  const toggleAgent = (agentId: string) => {
    setError('')
    setSelectionNotice('')
    setPreview(null)
    setAssignments([])
    setSelectedAgentIds(current =>
      current.includes(agentId)
        ? current.filter(value => value !== agentId)
        : [...current, agentId],
    )
  }

  const captureSettings: CaptureEnhancementSettings | undefined = enhancementEnabled
    ? {
        autoDetailCaptureAfterListCapture: true,
        autoSyncAfterDetailCapture: autoSync,
        enableAiRelevancePrefilter: aiPrefilter,
        includeBloggerMetricsOnDetailCapture: bloggerMetrics,
        includeCommentsOnDetailCapture: includeComments,
        detailCommentsMaxDetectedItems: includeComments ? commentLimit : 50,
        skipAlreadyCapturedOnDetailCapture: skipCaptured,
      }
    : undefined

  const currentFingerprint = JSON.stringify({
    title: title.trim(),
    platform,
    executionMode,
    ...(executionMode === 'unattended_plan'
      ? {
          planMode,
          startTime,
          randomOffsetMin,
          customDates: parseCustomDates(customDates).dates,
        }
      : {}),
    keywords,
    keywordMaxDetectedItems,
    sort,
    publishTime,
    captureSettings,
    allowIdleAgentHandoff,
    distributionMode,
    eligibleAgentIds: [...validSelectedAgentIds].sort(),
  })

  const generatePreview = async () => {
    setError('')
    if (!writable) {
      setError(editMode ? '当前账号为只读权限，不能编辑计划。' : '当前账号为只读权限，不能创建编排任务。')
      return
    }
    if (!title.trim()) {
      setError('请填写任务名称。')
      return
    }
    if (keywords.length < 1 || keywords.length > 300) {
      setError('请输入 1–300 个关键词，每行一个。弹性池会让节点逐个领取。')
      return
    }
    if (!Number.isSafeInteger(keywordMaxDetectedItems) || keywordMaxDetectedItems < 1) {
      setError('每个关键词的帖子上限必须是大于等于 1 的整数。')
      return
    }
    if (enhancementEnabled && includeComments && (!Number.isSafeInteger(commentLimit) || commentLimit < 1)) {
      setError('评论加载上限必须是大于等于 1 的整数。')
      return
    }
    const customDateResult = parseCustomDates(customDates)
    if (executionMode === 'unattended_plan') {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
        setError('请选择有效的无人值守开始时间。')
        return
      }
      if (!Number.isSafeInteger(randomOffsetMin) || randomOffsetMin < 0 || randomOffsetMin > 240) {
        setError('随机延迟需要填写 0–240 分钟的整数。')
        return
      }
      if (planMode === 'custom_dates') {
        if (customDateResult.invalidDates.length > 0) {
          setError(`存在无效日期：${customDateResult.invalidDates.slice(0, 3).join('、')}。请使用 YYYY-MM-DD 格式。`)
          return
        }
        if (customDateResult.dates.length < 1) {
          setError('指定日期计划至少需要填写一个运行日期。')
          return
        }
        if (!customDateResult.dates.some(date => date >= shanghaiToday())) {
          setError('指定日期中至少需要有一个今天或未来的日期。')
          return
        }
      }
    }
    if (validSelectedAgentIds.length < requiredAgentCount) {
      setError(`请至少选择 ${requiredAgentCount} 个与当前平台和采集设置兼容的 Agent。`)
      return
    }
    if (
      distributionMode === 'fixed_batch' &&
      validSelectedAgentIds.length < Math.ceil(keywords.length / 30)
    ) {
      setError(`固定分配时每个 Agent 最多接收 30 个关键词，请至少选择 ${Math.ceil(keywords.length / 30)} 个兼容 Agent。`)
      return
    }
    if (editMode) {
      const scheduleRevision = Number(editingPlan?.schedule?.revision || 0)
      if (!editingPlan?.schedule || scheduleRevision < 1) {
        setError('计划版本缺失，请关闭后刷新详情再编辑。')
        return
      }
      const localPreview = buildEditPreview({
        orchestrationId: editingPlan.orchestration.id,
        revision: scheduleRevision,
        platform,
        keywords,
        selectedAgents,
        existingItems: editingPlan.items,
      })
      setPreview(localPreview.preview)
      setAssignments(localPreview.assignments)
      setStage('allocate')
      return
    }
    if ((!createResult || createFingerprint !== currentFingerprint) && draftIdsRef.current.size > 0) {
      const discarded = await discardCreatedDrafts()
      if (!discarded) return
    }

    setSubmitting(true)
    try {
      let nextCreateResult = createResult
      if (!nextCreateResult || createFingerprint !== currentFingerprint) {
        const candidateDraftId = requestKeyRef.current
        draftIdsRef.current.add(candidateDraftId)
        setPendingDraftCount(draftIdsRef.current.size)
        nextCreateResult = await api.post<CreateResponse>('/capture-cloud/orchestrations', {
          requestKey: candidateDraftId,
          title: title.trim(),
          platform,
          executionMode,
          distributionMode,
          agentIds: validSelectedAgentIds,
          ...(executionMode === 'unattended_plan'
            ? {
                schedule: {
                  mode: planMode,
                  planMode,
                  startTime,
                  randomOffsetMin,
                  customDates: planMode === 'custom_dates' ? customDateResult.dates.join('\n') : '',
                  maxRounds: 1,
                  roundGapMin: 10,
                },
              }
            : {}),
          keywords,
          keywordMaxDetectedItems,
          searchFilters: { sort, publishTime },
          recoveryPolicy: {
            allowIdleAgentHandoff,
            platformSafetyMode: 'manual_confirmed',
          },
          ...(captureSettings ? { captureSettings } : {}),
        })
        draftIdsRef.current.add(nextCreateResult.orchestration.id)
        setPendingDraftCount(draftIdsRef.current.size)
        setCreateResult(nextCreateResult)
        setCreateFingerprint(currentFingerprint)
      }

      const nextPreview = await api.post<AllocationPreviewResponse>(
        `/capture-cloud/orchestrations/${nextCreateResult.orchestration.id}/allocation-preview`,
        { agentIds: validSelectedAgentIds },
      )
      const nextAssignments = buildAssignments(nextCreateResult, nextPreview)
      if (nextAssignments.length !== nextPreview.itemCount || nextAssignments.some(assignment => !assignment.agentId)) {
        throw new Error('工作项预览不完整，请刷新 Agent 状态后重试。')
      }
      setPreview(nextPreview)
      setAssignments(nextAssignments)
      setStage('allocate')
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成队列预览失败')
    } finally {
      setSubmitting(false)
    }
  }

  const dispatch = async () => {
    setError('')
    if (!preview || (!editMode && !createResult)) {
      setError('当前队列预览已失效，请返回上一步重新生成。')
      return
    }
    if (
      assignments.length !== (editMode ? keywords.length : createResult?.items.length) ||
      assignments.some(assignment => !assignment.agentId)
    ) {
      setError('工作项清单不完整，请返回上一步重新生成。')
      return
    }
    if (validSelectedAgentIds.length < requiredAgentCount) {
      setError(`请至少选择 ${requiredAgentCount} 个兼容 Agent。`)
      return
    }
    setSubmitting(true)
    try {
      if (editMode) {
        const customDateResult = parseCustomDates(customDates)
        const result = await api.patch<OrchestrationScheduleUpdateResult>(
          `/capture-cloud/orchestrations/${preview.orchestrationId}/schedule`,
          {
            expectedRevision: preview.revision,
            title: title.trim(),
            platform,
            executionMode: 'unattended_plan',
            distributionMode,
            agentIds: validSelectedAgentIds,
            schedule: {
              mode: planMode,
              planMode,
              startTime,
              randomOffsetMin,
              customDates: planMode === 'custom_dates' ? customDateResult.dates.join('\n') : '',
              maxRounds: 1,
              roundGapMin: 10,
            },
            keywords,
            keywordMaxDetectedItems,
            searchFilters: { sort, publishTime },
            recoveryPolicy: {
              allowIdleAgentHandoff,
              platformSafetyMode: 'manual_confirmed',
            },
            ...(captureSettings ? { captureSettings } : {}),
          },
          { timeoutMs: 30_000 },
        )
        setUpdateResult(result)
        setStage('dispatched')
        try {
          await onPlanUpdated?.(result)
        } catch {
          setError('计划已经保存，但父页面刷新失败。关闭抽屉后可手动刷新计划列表。')
        }
        return
      }
      const result = await api.post<OrchestrationDispatchResult>(
        `/capture-cloud/orchestrations/${preview.orchestrationId}/dispatch`,
        {
          expectedRevision: preview.revision,
          eligibleAgentIds: validSelectedAgentIds,
          assignments: assignments.map(assignment => ({
            itemId: assignment.itemId,
            agentId: assignment.agentId,
          })),
        },
        { timeoutMs: 30_000 },
      )
      draftIdsRef.current.delete(preview.orchestrationId)
      setPendingDraftCount(draftIdsRef.current.size)
      setDispatchResult(result)
      setStage('dispatched')
      try {
        await onDispatched?.(result)
      } catch {
        setError('云端队列已经创建，但父页面刷新失败。关闭抽屉后可手动刷新任务列表。')
      }
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : editMode ? '保存计划修改失败' : '创建云端队列失败'
      setError(/revision|版本|冲突|已被更新/i.test(message)
        ? editMode
          ? '计划在编辑期间已经发生变化。请关闭编辑器，刷新计划详情后再修改。'
          : '任务草稿已经变化，当前预览已过期。请返回并重新生成分配预览。'
        : message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <Drawer
      onClose={() => void requestClose()}
      labelledBy="orchestration-composer-title"
      panelClassName="max-w-none lg:max-w-[880px]"
    >
        <header className="shrink-0 border-b border-border/70 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
          <div className="flex items-start gap-3">
            <button
              type="button"
              data-dialog-initial-focus
              onClick={stage === 'allocate' ? () => { setStage('define'); setError('') } : () => void requestClose()}
              aria-label={stage === 'allocate' ? '返回任务配置' : editMode ? '关闭计划编辑' : copyMode ? '关闭复制计划' : '关闭新建编排任务'}
              disabled={busy}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {stage === 'allocate' ? <ArrowLeft className="h-5 w-5" /> : <X className="h-5 w-5" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="orchestration-composer-title" className="text-lg font-bold text-foreground">
                  {editMode ? '编辑无人值守计划' : copyMode ? '复制为新计划' : '新建弹性节点池任务'}
                </h2>
                <span className="rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">Beta</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {editMode
                  ? '保留原计划和运行历史；保存后的设置从下一次运行开始生效。'
                  : copyMode
                    ? '已带入原计划设置；确认后创建独立的新计划，不改动归档记录。'
                  : executionMode === 'unattended_plan'
                  ? '无人值守 · 每次到点生成云端工作项，由空闲节点逐个领取。'
                  : '执行一次 · 关键词留在云端，兼容节点空闲后逐个领取。'}
              </p>
            </div>
          </div>
          <div className="mt-4 flex gap-2" aria-label={editMode ? '编辑计划步骤' : '新建任务步骤'}>
            <StepPill active={stage === 'define'} complete={stage !== 'define'}>定义任务与节点池</StepPill>
            <ChevronRight className="mt-3 h-4 w-4 shrink-0 text-muted-foreground/45" />
            <StepPill active={stage === 'allocate'} complete={stage === 'dispatched'}>{editMode ? '确认修改范围' : '确认云端队列'}</StepPill>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
          {stage === 'define' && (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
              <div className="space-y-4">
                <section className={`rounded-2xl border p-4 transition-colors ${executionMode === 'unattended_plan' ? 'border-primary/25 bg-primary/[0.035]' : 'border-border/70 bg-background'}`}>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><Clock3 className="h-4 w-4" /></span>
                    <div>
                      <h3 className="text-sm font-bold text-foreground">运行方式</h3>
                      <p className="text-[11px] text-muted-foreground">
                        {editMode
                          ? '当前编辑的是云端无人值守计划，只调整后续运行规则。'
                          : lockExecutionMode ? '已从上一步带入；这里只配置具体运行规则。' : '选择只执行一次，或让云端按固定计划反复生成任务。'}
                      </p>
                    </div>
                  </div>
                  {lockExecutionMode || editMode || copyMode ? (
                    <div role="status" className="flex items-center gap-3 rounded-xl border border-primary/20 bg-card px-3 py-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        {executionMode === 'unattended_plan' ? <CalendarDays className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-bold text-foreground">
                          {executionMode === 'unattended_plan' ? '无人值守' : '执行一次'}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">
                          {editMode ? '计划类型保持不变；修改只作用于后续批次。' : copyMode ? '从原计划复制，创建后独立运行。' : '已从上一步确定，无需重复选择。'}
                        </span>
                      </span>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">已确定</span>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/55 p-1">
                      {([
                        {
                          value: 'one_time' as const,
                          label: '执行一次',
                          description: '确认后立即下发',
                          icon: Play,
                        },
                        {
                          value: 'unattended_plan' as const,
                          label: '无人值守',
                          description: '云端按时运行',
                          icon: CalendarDays,
                        },
                      ]).map(option => {
                        const Icon = option.icon
                        const active = executionMode === option.value
                        return (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={active}
                            disabled={busy}
                            onClick={() => {
                              if (executionMode === option.value) return
                              markDefinitionChanged()
                              setExecutionMode(option.value)
                            }}
                            className={`flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${active ? 'border-primary/30 bg-card text-primary shadow-sm' : 'border-transparent text-muted-foreground hover:bg-card/70 hover:text-foreground'}`}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="min-w-0">
                              <span className="block text-xs font-bold">{option.label}</span>
                              <span className="mt-0.5 block truncate text-[10px] font-normal">{option.description}</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {executionMode === 'unattended_plan' && (
                    <div className="mt-4 space-y-3 border-t border-primary/15 pt-4">
                      <div className="rounded-xl border border-primary/15 bg-card/80 px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          <p className="text-[11px] leading-4 text-muted-foreground">
                            {editMode
                              ? <>保存后继续使用同一个云端计划，<span className="font-semibold text-foreground">已经生成、正在运行或已完成的批次不会改变</span>。</>
                              : <>这是独立的云端计划。到点后才创建当次任务并发给下方 Agent，<span className="font-semibold text-foreground">不会覆盖设备 Extension 里已有的本地无人值守计划</span>。</>}
                          </p>
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block text-xs font-medium text-muted-foreground">
                          运行日期
                          <select
                            value={planMode}
                            onChange={event => { markDefinitionChanged(); setPlanMode(event.target.value as PlanMode) }}
                            disabled={busy}
                            className={inputClassName}
                          >
                            <option value="daily">每天</option>
                            <option value="custom_dates">指定日期</option>
                          </select>
                        </label>
                        <label className="block text-xs font-medium text-muted-foreground">
                          开始时间（上海时区）
                          <input
                            type="time"
                            value={startTime}
                            onChange={event => { markDefinitionChanged(); setStartTime(event.target.value) }}
                            disabled={busy}
                            className={inputClassName}
                          />
                        </label>
                      </div>
                      {planMode === 'custom_dates' && (
                        <ScheduledDatesPicker
                          value={customDates}
                          onChange={value => {
                            markDefinitionChanged()
                            setCustomDates(value)
                          }}
                          disabled={busy}
                        />
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block text-xs font-medium text-muted-foreground">
                          随机延迟（分钟）
                          <input
                            type="number"
                            min={0}
                            max={240}
                            step={1}
                            value={randomOffsetMin}
                            onChange={event => { markDefinitionChanged(); setRandomOffsetMin(Number(event.target.value)) }}
                            disabled={busy}
                            className={inputClassName}
                          />
                        </label>
                        <div className="flex items-center rounded-xl border border-border/70 bg-card px-3 py-2.5">
                          <p className="text-[11px] leading-4 text-muted-foreground">
                            每个计划时间，<span className="font-semibold text-foreground">每个关键词执行 1 次</span>。
                          </p>
                        </div>
                      </div>
                      <p className="text-[11px] leading-4 text-muted-foreground">
                        随机延迟会在设定时间后 0–{randomOffsetMin} 分钟内启动，避免多个任务同时拥挤；节点池可在下一步统一确认。
                      </p>
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-border/70 bg-background p-4">
                  <div className="mb-4 flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ClipboardList className="h-4 w-4" /></span>
                    <div>
                      <h3 className="text-sm font-bold text-foreground">任务内容</h3>
                      <p className="text-[11px] text-muted-foreground">每个关键词会成为一个独立工作项。</p>
                    </div>
                  </div>
                  <div className="space-y-3.5">
                    <label className="block text-xs font-medium text-muted-foreground">
                      任务名称
                      <input
                        value={title}
                        onChange={event => { markDefinitionChanged(); setTitle(event.target.value) }}
                        disabled={busy}
                        maxLength={120}
                        placeholder="例如：7 月新能源竞品口碑采集"
                        className={inputClassName}
                      />
                    </label>
                    <label className="block text-xs font-medium text-muted-foreground">
                      每个关键词最多采集
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={keywordMaxDetectedItems}
                        onChange={event => { markDefinitionChanged(); setKeywordMaxDetectedItems(Number(event.target.value)) }}
                        disabled={busy}
                        className={inputClassName}
                      />
                    </label>
                    <label className="block text-xs font-medium text-muted-foreground">
                      关键词（每行一个）
                      <textarea
                        value={keywordText}
                        onChange={event => { markDefinitionChanged(); setKeywordText(event.target.value) }}
                        disabled={busy}
                        rows={7}
                        placeholder={'别克\n凯迪拉克\n雪佛兰'}
                        className={textareaClassName}
                      />
                      <span className={`mt-1.5 block text-[11px] ${keywords.length > 300 ? 'text-status-red' : 'text-muted-foreground'}`}>
                        {keywords.length}/300 个工作项 · {distributionMode === 'elastic_pool' ? '每个 Agent 一次领取 1 个' : '保存时按节点均衡固定分配'}
                      </span>
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block text-xs font-medium text-muted-foreground">
                        排序方式
                        <select value={sort} onChange={event => { markDefinitionChanged(); setSort(event.target.value) }} disabled={busy} className={inputClassName}>
                          {SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                      <label className="block text-xs font-medium text-muted-foreground">
                        发布时间
                        <select value={publishTime} onChange={event => { markDefinitionChanged(); setPublishTime(event.target.value) }} disabled={busy} className={inputClassName}>
                          {PUBLISH_TIME_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-border/70 bg-background p-4">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={enhancementEnabled}
                      onChange={event => changeEnhancementEnabled(event.target.checked)}
                      disabled={busy}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-bold text-foreground">采集增强</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">逐条打开详情页补充内容；只有支持远程增强参数的 Agent 可接单。</span>
                    </span>
                  </label>
                  {enhancementEnabled && (
                    <div className="mt-3 grid gap-2 border-l-2 border-primary/15 pl-3 sm:grid-cols-2">
                      {[
                        { label: '增强后自动同步后台', checked: autoSync, setter: setAutoSync },
                        { label: 'AI 精准筛选', checked: aiPrefilter, setter: setAiPrefilter },
                        { label: '附加博主粉丝与赞藏数', checked: bloggerMetrics, setter: setBloggerMetrics },
                        { label: '跳过已增强内容', checked: skipCaptured, setter: setSkipCaptured },
                      ].map(option => (
                        <label key={option.label} className="flex min-h-9 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-muted/60">
                          <input type="checkbox" checked={option.checked} onChange={event => { markDefinitionChanged(); option.setter(event.target.checked) }} disabled={busy} className="mt-0.5 h-4 w-4 accent-primary" />
                          <span>{option.label}</span>
                        </label>
                      ))}
                      <div className="flex min-h-9 flex-wrap items-center gap-3 rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-muted/60 sm:col-span-2">
                        <label className="flex cursor-pointer items-center gap-2">
                          <input type="checkbox" checked={includeComments} onChange={event => { markDefinitionChanged(); setIncludeComments(event.target.checked) }} disabled={busy} className="h-4 w-4 accent-primary" />
                          <span>附加评论</span>
                        </label>
                        {includeComments && (
                          <label className="inline-flex items-center gap-1 text-muted-foreground">
                            最多
                            <input
                              type="number"
                              min={1}
                              step={1}
                              value={commentLimit}
                              aria-label="评论加载上限"
                              onChange={event => { markDefinitionChanged(); setCommentLimit(Number(event.target.value)) }}
                              disabled={busy}
                              className="h-8 w-20 rounded-md border border-input bg-card px-2 text-xs text-foreground outline-none focus:border-primary"
                            />
                            条
                          </label>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              </div>

              <section className="self-start rounded-2xl border border-border/70 bg-background p-4 xl:sticky xl:top-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><Users className="h-4 w-4" /></span>
                    <div>
                      <h3 className="text-sm font-bold text-foreground">采集平台与 Agent 小队</h3>
                      <p className="text-[11px] text-muted-foreground">已选 {selectedAgents.length} 个兼容节点</p>
                    </div>
                  </div>
                  <span className="rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">至少 {requiredAgentCount} 个</span>
                </div>
                <label className="mt-3 block text-xs font-medium text-muted-foreground">
                  先选采集平台
                  <select value={platform} onChange={event => changePlatform(event.target.value as OrchestrationPlatform)} disabled={busy} className={inputClassName}>
                    {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground">下方仅允许选择支持当前平台和采集设置的 Agent。</span>
                </label>
                {selectionNotice && (
                  <p role="status" aria-live="polite" className="mt-3 rounded-xl border border-status-orange/25 bg-status-orange/8 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                    {selectionNotice}
                  </p>
                )}
                {editMode ? (
                  <fieldset className="mt-3">
                    <legend className="text-xs font-medium text-muted-foreground">任务分配方式</legend>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                      {([
                        {
                          value: 'elastic_pool' as const,
                          label: '弹性节点池',
                          description: '空闲节点逐个领取，快的自然多做',
                        },
                        {
                          value: 'fixed_batch' as const,
                          label: '固定分配',
                          description: '保存时把关键词固定分给各节点',
                        },
                      ]).map(option => {
                        const active = distributionMode === option.value
                        return (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={active}
                            disabled={busy}
                            onClick={() => {
                              if (active) return
                              markDefinitionChanged()
                              setDistributionMode(option.value)
                            }}
                            className={`rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${active ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/15' : 'border-border bg-card hover:border-primary/35'}`}
                          >
                            <span className={`flex items-center gap-2 text-xs font-semibold ${active ? 'text-primary' : 'text-foreground'}`}>
                              <Settings2 className="h-3.5 w-3.5" /> {option.label}
                            </span>
                            <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{option.description}</span>
                          </button>
                        )
                      })}
                    </div>
                  </fieldset>
                ) : (
                  <div className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.045] px-3 py-2.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-primary"><Settings2 className="h-3.5 w-3.5" /> 弹性节点池</div>
                    <p className="mt-1 text-[11px] leading-4 text-muted-foreground">关键词先留在云端。节点空闲时只领 1 个，完成后再领下一个；速度快的节点会自然多做。</p>
                  </div>
                )}
                <div className={`mt-3 flex items-start gap-3 rounded-xl border px-3 py-3 ${distributionMode === 'elastic_pool' ? 'border-primary/20 bg-primary/[0.035]' : 'border-status-orange/25 bg-status-orange/[0.045]'}`}>
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">✓</span>
                  <span>
                    <span className="block text-xs font-semibold text-foreground">
                      {distributionMode === 'elastic_pool' ? '离线不会拖住整批任务' : '保留固定分配方式'}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                      {distributionMode === 'elastic_pool'
                        ? '创建指令 3 分钟未确认会退回队列；执行节点持续离线 10 分钟也会回收。验证码或登录验证只暂停当前关键词，不会自动扩散到其他节点。'
                        : '关键词会均衡后固定给各节点；某台设备较慢或离线时，其他设备不会自动领取它的关键词。'}
                    </span>
                  </span>
                </div>
                {sortedAgents.length === 0 ? (
                  <div className="mt-3 rounded-xl border border-dashed border-border px-4 py-8 text-center">
                    <Bot className="mx-auto h-6 w-6 text-muted-foreground" />
                    <p className="mt-2 text-sm font-semibold">还没有执行节点</p>
                    <p className="mt-1 text-xs text-muted-foreground">先让 Extension 完成激活并上报心跳。</p>
                  </div>
                ) : (
                  <div className="mt-3 max-h-[520px] space-y-2 overflow-y-auto pr-1">
                    {sortedAgents.map(agent => {
                      const blockReason = agentBlockReason(agent, platform, enhancementEnabled)
                      const checked = validSelectedAgentIds.includes(agent.id)
                      const workloadKnown = agent.active_task_count !== undefined || agent.queued_task_count !== undefined
                      const activeTasks = safeCount(agent.active_task_count)
                      const queuedTasks = safeCount(agent.queued_task_count)
                      return (
                        <label
                          key={agent.id}
                          className={`flex min-h-24 items-start gap-3 rounded-xl border p-3 transition-colors ${blockReason ? 'cursor-not-allowed border-border bg-muted/25 opacity-60' : checked ? 'cursor-pointer border-primary bg-primary/[0.055] ring-1 ring-primary/15' : 'cursor-pointer border-border bg-card hover:border-primary/35'}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={Boolean(blockReason) || busy}
                            onChange={() => toggleAgent(agent.id)}
                            className="mt-1 h-4 w-4 shrink-0 accent-primary"
                          />
                          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
                            <Bot className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-xs font-bold text-foreground">{agent.display_name}</span>
                              <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
                                {agent.online ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
                                {agent.online ? '在线' : '离线'}
                              </span>
                            </span>
                            <span className="mt-1 block truncate text-[11px] text-muted-foreground">{agent.host_label} › {agent.browser_name} · {agent.operating_system}</span>
                            {blockReason ? (
                              <span className="mt-1.5 block text-[11px] font-medium text-status-red">{blockReason}</span>
                            ) : (
                              <span className="mt-1.5 block text-[11px] text-muted-foreground">
                                {workloadKnown
                                  ? <>
                                      {activeTasks > 0 ? `执行中 ${activeTasks}` : '当前无执行任务'}
                                      {queuedTasks > 0 ? ` · 排队 ${queuedTasks}` : ''}
                                    </>
                                  : '当前负载未提供'}
                                {!agent.online
                                  ? distributionMode === 'elastic_pool'
                                    ? ' · 当前不参与领取，上线后自动加入'
                                    : ' · 固定任务会等待该节点上线'
                                  : distributionMode === 'elastic_pool'
                                    ? ' · 空闲时可领取'
                                    : ' · 将接收固定关键词'}
                              </span>
                            )}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
                {selectedAgents.length < requiredAgentCount && (
                  <p role="status" className="mt-3 text-[11px] leading-4 text-status-orange">
                    还需选择 {requiredAgentCount - selectedAgents.length} 个与当前平台和采集设置兼容的 Agent。
                  </p>
                )}
              </section>
            </div>
          )}

          {stage === 'allocate' && preview && (
            <div className="space-y-4">
              {editMode && (
                <section className="rounded-2xl border border-status-orange/30 bg-status-orange/[0.055] p-4" aria-label="修改影响范围">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-status-orange/12 text-amber-700 dark:text-amber-300">
                      <CalendarDays className="h-4.5 w-4.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">修改影响范围</div>
                      <h3 className="mt-1 text-sm font-bold text-foreground">只影响下一次及之后生成的批次</h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        已经生成、正在运行或已经完成的批次继续使用原配置；计划 ID、运行次数和历史记录全部保留。
                      </p>
                      {editingPlan?.schedule?.status === 'paused' && (
                        <p className="mt-2 rounded-lg border border-border/70 bg-card/70 px-3 py-2 text-[11px] text-muted-foreground">
                          当前计划处于暂停状态。保存后仍保持暂停，等你重新启用才会按新设置运行。
                        </p>
                      )}
                      {editingPlan?.schedule?.status === 'completed' && (
                        <p className="mt-2 rounded-lg border border-border/70 bg-card/70 px-3 py-2 text-[11px] text-muted-foreground">
                          当前计划已经结束。保存有效的未来日期后，计划会重新启用。
                        </p>
                      )}
                    </div>
                  </div>
                </section>
              )}
              <section className="rounded-2xl border border-primary/20 bg-primary/[0.035] p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">{editMode ? '计划修改确认' : '云端队列确认'}</div>
                      <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-card px-2 py-0.5 text-[10px] font-semibold text-primary">
                        {executionMode === 'unattended_plan' ? <CalendarDays className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                        {executionMode === 'unattended_plan' ? '无人值守' : '执行一次'}
                      </span>
                    </div>
                    <h3 className="mt-1 text-base font-bold text-foreground">{title}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {preview.itemCount} 个工作项 · {selectedAgents.length} 个执行节点 · {distributionMode === 'elastic_pool' ? '一次领取 1 项' : '按当前顺序均衡固定分配'}
                      {executionMode === 'unattended_plan'
                        ? ` · ${planMode === 'daily' ? '每天' : `${parseCustomDates(customDates).dates.length} 个指定日期`} ${startTime}`
                        : ''}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => { setStage('define'); setError('') }} disabled={busy}>{editMode ? '返回修改' : '调整节点池'}</Button>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {selectedAgents.map(agent => (
                    <div key={agent.id} className="rounded-xl border border-border/70 bg-card px-3 py-2.5">
                      <div className="truncate text-xs font-bold text-foreground">{allocationAgentLabel(agent)}</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {distributionMode === 'elastic_pool'
                          ? agent.online ? '在线 · 空闲时可领取' : '离线 · 不阻塞其他节点'
                          : agent.online ? '在线 · 接收固定关键词' : '离线 · 固定关键词会等待'}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
                <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                  <div>
                    <h3 className="text-sm font-bold text-foreground">云端工作项</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {distributionMode === 'elastic_pool'
                        ? '这里确认要跑哪些词；实际执行节点由当时的空闲状态决定。'
                        : '这里确认要跑哪些词，以及保存后采用的固定均衡分配。'}
                    </p>
                  </div>
                  <span className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{assignments.length} 项</span>
                </div>
                <div className="divide-y divide-border/70">
                  {assignments.map((assignment, index) => (
                      <div key={assignment.itemId} className="grid gap-3 px-4 py-3 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-center">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-xs font-bold tabular-nums text-muted-foreground">{index + 1}</span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-foreground">{assignment.keyword}</div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">每词最多 {keywordMaxDetectedItems} 条 · {PLATFORM_OPTIONS.find(option => option.value === platform)?.label}</div>
                        </div>
                        <span className="rounded-full border border-primary/20 bg-primary/[0.055] px-2.5 py-1 text-[10px] font-semibold text-primary">
                          {distributionMode === 'elastic_pool'
                            ? '等待动态领取'
                            : selectedAgents.find(agent => agent.id === assignment.agentId)?.display_name || '固定分配'}
                        </span>
                      </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {stage === 'dispatched' && (dispatchResult || updateResult) && (
            <div className="mx-auto flex min-h-[480px] max-w-xl items-center justify-center">
              <div className="w-full rounded-2xl border border-status-green/25 bg-status-green/5 p-6 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-green text-white"><CheckCircle2 className="h-6 w-6" /></span>
                <h3 className="mt-4 text-lg font-bold text-foreground">
                  {editMode
                    ? '计划修改已保存'
                    : executionMode === 'unattended_plan' ? '无人值守弹性计划已启用' : '云端队列已创建'}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {editMode
                    ? '同一个计划会继续运行，原有历史保持不变。新配置从下一次生成批次时开始使用。'
                    : executionMode === 'unattended_plan'
                    ? '云端会在每个运行时间生成当次工作项。在线空闲节点逐个领取，设备本地计划保持不变。'
                    : '关键词已留在云端队列。在线节点空闲时一次领取一个，完成后继续领取。'}
                </p>
                <div className="mt-4 rounded-xl border border-border/70 bg-card px-4 py-3 text-left text-xs text-muted-foreground">
                  <div>编排任务：<span className="font-mono text-foreground">{updateResult?.orchestrationId || dispatchResult?.orchestrationId}</span></div>
                  <div className="mt-1">
                    {editMode ? '计划版本：' : '当前状态：'}
                    <span className="font-semibold text-foreground">{editMode ? `v${updateResult?.schedule.revision || '—'}` : dispatchResult?.status}</span>
                  </div>
                  {executionMode === 'unattended_plan' && (
                    <>
                      <div className="mt-1">
                        运行规则：
                        <span className="font-semibold text-foreground">
                          {planMode === 'daily' ? '每天' : '指定日期'} {startTime}
                          {randomOffsetMin > 0 ? ` 后随机延迟 0–${randomOffsetMin} 分钟` : ''}
                          {` · ${distributionMode === 'elastic_pool' ? '弹性节点池' : '固定分配'} · 每个关键词执行 1 次`}
                        </span>
                      </div>
                      <div className="mt-1">
                        下次运行：<span className="font-semibold text-foreground">{formatScheduleTime(nextScheduleRunAt)}</span>
                      </div>
                    </>
                  )}
                </div>
                <Button className="mt-5 min-w-32" onClick={() => void requestClose()}>完成</Button>
              </div>
            </div>
          )}

          {stage === 'dispatched' && error && (
            <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-status-red/25 bg-status-red/8 px-3 py-2.5 text-xs leading-5 text-status-red">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {discardingDraft && (
            <div role="status" aria-live="polite" className="mt-4 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/8 px-3 py-2.5 text-xs text-primary">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在取消未下发草稿，完成前不会关闭或创建新任务。
            </div>
          )}
          {!discardingDraft && pendingDraftCount > 0 && !createResult && (
            <div role="status" className="mt-4 rounded-xl border border-status-red/25 bg-status-red/8 px-3 py-2.5 text-xs leading-5 text-status-red">
              仍有 {pendingDraftCount} 个未下发草稿等待取消。再次预览或关闭时会自动重试。
            </div>
          )}
        </div>

        {stage !== 'dispatched' && (
          <footer className="shrink-0 border-t border-border bg-card px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
            <div aria-live="polite" aria-atomic="true">
              {error && (
                <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-status-red/25 bg-status-red/8 px-3 py-2.5 text-xs leading-5 text-status-red">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              {submitting && (
                <div role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/8 px-3 py-2.5 text-xs font-medium text-primary">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  {stage === 'allocate'
                    ? editMode
                      ? '正在保存计划修改，请稍候…'
                      : executionMode === 'unattended_plan'
                      ? '正在保存弹性节点池并启用云端计划，请稍候…'
                      : '正在创建云端工作队列，请稍候…'
                    : editMode ? '正在检查计划修改，请稍候…' : '正在创建任务草稿并检查节点池，请稍候…'}
                </div>
              )}
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-[11px] leading-4 text-muted-foreground">
                {stage === 'define'
                  ? editMode
                    ? '可修改名称、平台、时间、关键词、采集设置、分配方式和 Agent 小队。'
                    : executionMode === 'unattended_plan'
                    ? '这是云端无人值守计划，不会修改设备已有的本地计划。'
                    : '执行一次会在确认后立即创建云端队列，不会修改设备已有的无人值守计划。'
                  : editMode
                    ? '保存后只更新计划模板；已经生成的批次和历史记录保持不变。'
                    : executionMode === 'unattended_plan'
                    ? '确认后保存节点池；云端将在每次到点时生成可动态领取的工作项。'
                    : '确认后创建云端工作项；每个节点一次只领取一个。'}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" onClick={stage === 'allocate' ? () => setStage('define') : () => void requestClose()} disabled={busy}>
                  {stage === 'allocate' ? '上一步' : '取消'}
                </Button>
                {stage === 'define' ? (
                  <Button onClick={() => void generatePreview()} disabled={busy || !writable || selectedAgents.length < requiredAgentCount} className="min-w-44">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
                    {busy ? '正在生成预览…' : editMode ? '预览计划修改' : '预览云端队列'}
                  </Button>
                ) : (
                  <Button onClick={() => void dispatch()} disabled={busy || validSelectedAgentIds.length < requiredAgentCount} className="min-w-36">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : editMode ? <CheckCircle2 className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {busy
                      ? editMode ? '正在保存…' : executionMode === 'unattended_plan' ? '正在启用…' : '正在创建…'
                      : editMode ? '保存修改' : executionMode === 'unattended_plan' ? '确认并启用计划' : '确认并创建队列'}
                  </Button>
                )}
              </div>
            </div>
          </footer>
        )}
    </Drawer>
  )
}
