import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import type {
  CaptureEnhancementSettings,
  OrchestrationCloudAgent,
  OrchestrationComposerDrawerProps,
  OrchestrationDispatchResult,
  OrchestrationItemRecord,
  OrchestrationPlatform,
  OrchestrationRecord,
} from './types'

type ComposerStage = 'define' | 'allocate' | 'dispatched'
type ExecutionMode = 'one_time' | 'unattended_plan'
type PlanMode = 'daily' | 'custom_dates'

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

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
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
  onClose,
  onDispatched,
  onChanged,
}: OrchestrationComposerDrawerProps) {
  const [stage, setStage] = useState<ComposerStage>('define')
  const [title, setTitle] = useState('')
  const [platform, setPlatform] = useState<OrchestrationPlatform>('xiaohongshu')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('one_time')
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
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [createResult, setCreateResult] = useState<CreateResponse | null>(null)
  const [createFingerprint, setCreateFingerprint] = useState('')
  const [preview, setPreview] = useState<AllocationPreviewResponse | null>(null)
  const [assignments, setAssignments] = useState<EditableAssignment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [discardingDraft, setDiscardingDraft] = useState(false)
  const [pendingDraftCount, setPendingDraftCount] = useState(0)
  const [error, setError] = useState('')
  const [dispatchResult, setDispatchResult] = useState<OrchestrationDispatchResult | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const requestKeyRef = useRef(randomRequestKey())
  const previouslyOpenRef = useRef(false)
  const submittingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const onChangedRef = useRef(onChanged)
  const requestCloseRef = useRef<() => void | Promise<void>>(() => {})
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
  const selectedAgents = useMemo(
    () => selectedAgentIds
      .map(agentId => agents.find(agent => agent.id === agentId))
      .filter((agent): agent is OrchestrationCloudAgent => Boolean(agent)),
    [agents, selectedAgentIds],
  )
  const assignmentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    assignments.forEach(assignment => counts.set(assignment.agentId, (counts.get(assignment.agentId) || 0) + 1))
    return counts
  }, [assignments])
  const overloadedAgentIds = useMemo(
    () => Array.from(assignmentCounts.entries())
      .filter(([, count]) => count > 30)
      .map(([agentId]) => agentId),
    [assignmentCounts],
  )
  const busy = submitting || discardingDraft
  const dispatchedSchedule = dispatchResult?.schedule
  const nextScheduleRunAt = dispatchedSchedule?.next_run_at || dispatchedSchedule?.nextRunAt || null

  const reset = () => {
    setStage('define')
    setTitle('')
    setPlatform('xiaohongshu')
    setExecutionMode('one_time')
    setPlanMode('daily')
    setStartTime('09:00')
    setRandomOffsetMin(20)
    setCustomDates('')
    setKeywordText('')
    setKeywordMaxDetectedItems(50)
    setSort('comprehensive')
    setPublishTime('all')
    setEnhancementEnabled(false)
    setAutoSync(false)
    setAiPrefilter(false)
    setBloggerMetrics(false)
    setIncludeComments(false)
    setCommentLimit(50)
    setSkipCaptured(true)
    setSelectedAgentIds([])
    setCreateResult(null)
    setCreateFingerprint('')
    setPreview(null)
    setAssignments([])
    setSubmitting(false)
    setDiscardingDraft(false)
    setPendingDraftCount(draftIdsRef.current.size)
    setError('')
    setDispatchResult(null)
    requestKeyRef.current = randomRequestKey()
  }

  useEffect(() => {
    if (open && !previouslyOpenRef.current) reset()
    previouslyOpenRef.current = open
  }, [open])

  useEffect(() => {
    submittingRef.current = busy
  }, [busy])

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submittingRef.current) void requestCloseRef.current()
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter(element => !element.hasAttribute('hidden'))
      if (focusable.length === 0) return
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
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [open])

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

  useEffect(() => {
    requestCloseRef.current = requestClose
  })

  const changePlatform = (value: OrchestrationPlatform) => {
    markDefinitionChanged()
    setPlatform(value)
    setSelectedAgentIds(current => current.filter(agentId => {
      const agent = agents.find(candidate => candidate.id === agentId)
      return agent && !agentBlockReason(agent, value, enhancementEnabled)
    }))
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
    setSelectedAgentIds(current => current.filter(agentId => {
      const agent = agents.find(candidate => candidate.id === agentId)
      return agent && !agentBlockReason(agent, platform, value)
    }))
  }

  const toggleAgent = (agentId: string) => {
    setError('')
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
  })

  const generatePreview = async () => {
    setError('')
    if (!writable) {
      setError('当前账号为只读权限，不能创建编排任务。')
      return
    }
    if (!title.trim()) {
      setError('请填写任务名称。')
      return
    }
    if (keywords.length < 1 || keywords.length > 300) {
      setError('请输入 1–300 个关键词，每行一个。单个 Agent 最多承载 30 个。')
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
    const validSelectedAgents = selectedAgentIds.filter(agentId => {
      const agent = agents.find(candidate => candidate.id === agentId)
      return agent && !agentBlockReason(agent, platform, enhancementEnabled)
    })
    if (validSelectedAgents.length < 1) {
      setError('至少选择 1 个与当前平台和采集设置兼容的 Agent。')
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
          ...(captureSettings ? { captureSettings } : {}),
        })
        draftIdsRef.current.add(nextCreateResult.orchestration.id)
        setPendingDraftCount(draftIdsRef.current.size)
        setCreateResult(nextCreateResult)
        setCreateFingerprint(currentFingerprint)
      }

      const nextPreview = await api.post<AllocationPreviewResponse>(
        `/capture-cloud/orchestrations/${nextCreateResult.orchestration.id}/allocation-preview`,
        { agentIds: validSelectedAgents },
      )
      const nextAssignments = buildAssignments(nextCreateResult, nextPreview)
      if (nextAssignments.length !== nextPreview.itemCount || nextAssignments.some(assignment => !assignment.agentId)) {
        throw new Error('分配预览不完整，请刷新 Agent 状态后重试。')
      }
      setPreview(nextPreview)
      setAssignments(nextAssignments)
      setStage('allocate')
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成分配预览失败')
    } finally {
      setSubmitting(false)
    }
  }

  const dispatch = async () => {
    setError('')
    if (!preview || !createResult) {
      setError('当前分配预览已失效，请返回上一步重新生成分配预览。')
      return
    }
    if (assignments.length !== createResult.items.length || assignments.some(assignment => !assignment.agentId)) {
      setError('每个工作项都必须分配给一个已选择的 Agent。')
      return
    }
    if (overloadedAgentIds.length > 0) {
      setError('单个 Agent 最多只能承载 30 个工作项。请调整超载 Agent 的分配后再下发。')
      return
    }
    setSubmitting(true)
    try {
      const result = await api.post<OrchestrationDispatchResult>(
        `/capture-cloud/orchestrations/${preview.orchestrationId}/dispatch`,
        {
          expectedRevision: preview.revision,
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
        setError('任务已经分配成功，但父页面刷新失败。关闭抽屉后可手动刷新任务列表。')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '确认并分配任务失败'
      setError(/revision|版本|冲突/i.test(message)
        ? '任务草稿已经变化，当前预览已过期。请返回并重新生成分配预览。'
        : message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/35" onMouseDown={() => { if (!busy) void requestClose() }} />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="orchestration-composer-title"
        className="relative z-10 flex h-full w-full flex-col bg-card shadow-lg lg:max-w-[880px] lg:border-l lg:border-border"
      >
        <header className="shrink-0 border-b border-border/70 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
          <div className="flex items-start gap-3">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={stage === 'allocate' ? () => { setStage('define'); setError('') } : () => void requestClose()}
              aria-label={stage === 'allocate' ? '返回任务配置' : '关闭新建编排任务'}
              disabled={busy}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {stage === 'allocate' ? <ArrowLeft className="h-5 w-5" /> : <X className="h-5 w-5" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="orchestration-composer-title" className="text-lg font-bold text-foreground">新建多 Agent 任务</h2>
                <span className="rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">Beta</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {executionMode === 'unattended_plan'
                  ? '无人值守 · 先固定关键词与 Agent 分配，再由云端按计划创建每次任务。'
                  : '执行一次 · 先拆成关键词工作项，再明确分配给浏览器节点。'}
              </p>
            </div>
          </div>
          <div className="mt-4 flex gap-2" aria-label="新建任务步骤">
            <StepPill active={stage === 'define'} complete={stage !== 'define'}>定义任务与 Agent</StepPill>
            <ChevronRight className="mt-3 h-4 w-4 shrink-0 text-muted-foreground/45" />
            <StepPill active={stage === 'allocate'} complete={stage === 'dispatched'}>检查工作项分配</StepPill>
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
                      <p className="text-[11px] text-muted-foreground">选择只执行一次，或让云端按固定计划反复生成任务。</p>
                    </div>
                  </div>
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

                  {executionMode === 'unattended_plan' && (
                    <div className="mt-4 space-y-3 border-t border-primary/15 pt-4">
                      <div className="rounded-xl border border-primary/15 bg-card/80 px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          <p className="text-[11px] leading-4 text-muted-foreground">
                            这是独立的云端计划。到点后才创建当次任务并发给下方 Agent，<span className="font-semibold text-foreground">不会覆盖设备 Extension 里已有的本地无人值守计划</span>。
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
                        <label className="block text-xs font-medium text-muted-foreground">
                          指定日期（每行一个）
                          <textarea
                            value={customDates}
                            onChange={event => { markDefinitionChanged(); setCustomDates(event.target.value) }}
                            disabled={busy}
                            rows={3}
                            placeholder={'2026-07-25\n2026-08-01'}
                            className={textareaClassName}
                          />
                          <span className="mt-1.5 block text-[11px] text-muted-foreground">格式 YYYY-MM-DD；已经过去的日期不会再次运行。</span>
                        </label>
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
                        随机延迟会在设定时间后 0–{randomOffsetMin} 分钟内启动，避免多个任务同时拥挤；Agent 分配可在下一步逐项确认。
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
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block text-xs font-medium text-muted-foreground">
                        平台
                        <select value={platform} onChange={event => changePlatform(event.target.value as OrchestrationPlatform)} disabled={busy} className={inputClassName}>
                          {PLATFORM_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
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
                    </div>
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
                      <span className={`mt-1.5 block text-[11px] ${keywords.length > 300 ? 'text-status-red' : 'text-muted-foreground'}`}>{keywords.length}/300 个工作项 · 单个 Agent 最多 30 个</span>
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
                      <h3 className="text-sm font-bold text-foreground">选择 Agent 小队</h3>
                      <p className="text-[11px] text-muted-foreground">已选 {selectedAgentIds.length} 个节点</p>
                    </div>
                  </div>
                  <span className="rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">至少 1 个</span>
                </div>
                <div className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.045] px-3 py-2.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-primary"><Settings2 className="h-3.5 w-3.5" /> 规则均衡</div>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">按关键词顺序连续均分给已选 Agent；结果可在下一步逐项调整。这里不会调用 AI。</p>
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
                      const checked = selectedAgentIds.includes(agent.id)
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
                                {!agent.online ? ' · 上线后领取' : ''}
                              </span>
                            )}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          {stage === 'allocate' && preview && (
            <div className="space-y-4">
              <section className="rounded-2xl border border-primary/20 bg-primary/[0.035] p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">规则分配预览</div>
                      <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-card px-2 py-0.5 text-[10px] font-semibold text-primary">
                        {executionMode === 'unattended_plan' ? <CalendarDays className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                        {executionMode === 'unattended_plan' ? '无人值守' : '执行一次'}
                      </span>
                    </div>
                    <h3 className="mt-1 text-base font-bold text-foreground">{title}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {preview.itemCount} 个工作项 · {selectedAgents.length} 个 Agent · 连续均衡分配
                      {executionMode === 'unattended_plan'
                        ? ` · ${planMode === 'daily' ? '每天' : `${parseCustomDates(customDates).dates.length} 个指定日期`} ${startTime}`
                        : ''}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => { setStage('define'); setError('') }} disabled={busy}>调整 Agent</Button>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {selectedAgents.map(agent => (
                    <div key={agent.id} className="rounded-xl border border-border/70 bg-card px-3 py-2.5">
                      <div className="truncate text-xs font-bold text-foreground">{allocationAgentLabel(agent)}</div>
                      <div className={`mt-1 text-[11px] ${(assignmentCounts.get(agent.id) || 0) > 30 ? 'font-semibold text-status-red' : 'text-muted-foreground'}`}>
                        {assignmentCounts.get(agent.id) || 0} 个工作项 · {agent.online ? '在线' : '离线排队'}
                        {(assignmentCounts.get(agent.id) || 0) > 30 ? ' · 超出 30 项上限' : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
                <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                  <div>
                    <h3 className="text-sm font-bold text-foreground">工作项分配</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">默认结果来自确定性规则；你可以逐项指定其他已选 Agent。</p>
                  </div>
                  <span className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{assignments.length} 项</span>
                </div>
                <div className="divide-y divide-border/70">
                  {assignments.map((assignment, index) => {
                    const assignedAgent = agents.find(agent => agent.id === assignment.agentId)
                    return (
                      <div key={assignment.itemId} className="grid gap-3 px-4 py-3 sm:grid-cols-[44px_minmax(0,1fr)_minmax(210px,0.75fr)] sm:items-center">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-xs font-bold tabular-nums text-muted-foreground">{index + 1}</span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-foreground">{assignment.keyword}</div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">每词最多 {keywordMaxDetectedItems} 条 · {PLATFORM_OPTIONS.find(option => option.value === platform)?.label}</div>
                        </div>
                        <label className="block text-[11px] font-medium text-muted-foreground">
                          执行 Agent
                          <select
                            value={assignment.agentId}
                            aria-label={`为关键词“${assignment.keyword}”选择执行 Agent`}
                            onChange={event => setAssignments(current => current.map(item =>
                              item.itemId === assignment.itemId ? { ...item, agentId: event.target.value } : item,
                            ))}
                            disabled={busy}
                            className="mt-1 h-9 w-full rounded-lg border border-input bg-card px-2.5 text-xs font-semibold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                          >
                            {selectedAgents.map(agent => (
                              <option key={agent.id} value={agent.id}>{allocationAgentLabel(agent)}{agent.online ? '' : '（离线）'}</option>
                            ))}
                          </select>
                          {assignedAgent && <span className="sr-only">当前分配给 {assignedAgent.display_name}</span>}
                        </label>
                      </div>
                    )
                  })}
                </div>
              </section>
              {overloadedAgentIds.length > 0 && (
                <div role="alert" className="flex items-start gap-2 rounded-xl border border-status-red/25 bg-status-red/8 px-3 py-2.5 text-xs leading-5 text-status-red">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {overloadedAgentIds.map(agentId => {
                      const agent = agents.find(candidate => candidate.id === agentId)
                      return agent ? allocationAgentLabel(agent) : `Agent ${agentId.slice(0, 8)}`
                    }).join('、')}
                    {' '}超过单节点 30 个工作项上限。请把部分关键词改分配给其他 Agent。
                  </span>
                </div>
              )}
            </div>
          )}

          {stage === 'dispatched' && dispatchResult && (
            <div className="mx-auto flex min-h-[480px] max-w-xl items-center justify-center">
              <div className="w-full rounded-2xl border border-status-green/25 bg-status-green/5 p-6 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-green text-white"><CheckCircle2 className="h-6 w-6" /></span>
                <h3 className="mt-4 text-lg font-bold text-foreground">
                  {executionMode === 'unattended_plan' ? '无人值守计划已启用' : '任务已分配'}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {executionMode === 'unattended_plan'
                    ? '云端会在每个运行时间创建当次任务，并按已确认的关键词分配发送给 Agent。设备本地计划保持不变。'
                    : `已创建 ${dispatchResult.executions.length} 条 Agent 执行指令。在线节点将在下一次心跳领取，离线节点上线后领取。`}
                </p>
                <div className="mt-4 rounded-xl border border-border/70 bg-card px-4 py-3 text-left text-xs text-muted-foreground">
                  <div>编排任务：<span className="font-mono text-foreground">{dispatchResult.orchestrationId}</span></div>
                  <div className="mt-1">当前状态：<span className="font-semibold text-foreground">{dispatchResult.status}</span></div>
                  {executionMode === 'unattended_plan' && (
                    <>
                      <div className="mt-1">
                        运行规则：
                        <span className="font-semibold text-foreground">
                          {planMode === 'daily' ? '每天' : '指定日期'} {startTime}
                          {randomOffsetMin > 0 ? ` 后随机延迟 0–${randomOffsetMin} 分钟` : ''}
                          {' · 每个关键词执行 1 次'}
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
                    ? executionMode === 'unattended_plan'
                      ? '正在保存 Agent 分配并启用云端计划，请稍候…'
                      : `正在创建 ${new Set(assignments.map(assignment => assignment.agentId)).size} 条 Agent 执行指令并写入云端，请稍候…`
                    : '正在创建任务草稿并生成规则分配预览，请稍候…'}
                </div>
              )}
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-[11px] leading-4 text-muted-foreground">
                {stage === 'define'
                  ? executionMode === 'unattended_plan'
                    ? '这是云端无人值守计划，不会修改设备已有的本地计划。'
                    : '执行一次会在确认分配后立即创建任务，不会修改设备已有的无人值守计划。'
                  : executionMode === 'unattended_plan'
                    ? '确认后保存长期分配；云端将在每次到点时创建真实子任务。'
                    : '确认后将按当前分配创建真实子任务；每个工作项只归属一个 Agent。'}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" onClick={stage === 'allocate' ? () => setStage('define') : () => void requestClose()} disabled={busy}>
                  {stage === 'allocate' ? '上一步' : '取消'}
                </Button>
                {stage === 'define' ? (
                  <Button onClick={() => void generatePreview()} disabled={busy || !writable} className="min-w-44">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
                    {busy ? '正在生成预览…' : '生成规则分配预览'}
                  </Button>
                ) : (
                  <Button onClick={() => void dispatch()} disabled={busy || overloadedAgentIds.length > 0} className="min-w-36">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {busy
                      ? executionMode === 'unattended_plan' ? '正在启用…' : '正在分配…'
                      : executionMode === 'unattended_plan' ? '确认并启用计划' : '确认并分配'}
                  </Button>
                )}
              </div>
            </div>
          </footer>
        )}
      </section>
    </div>
  )
}
