import { negativeInteractionClass } from '@/lib/negativeInteraction.mjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarDays, Check, ChevronLeft, ChevronRight, Loader2,
  MessageSquareText, RefreshCw, Search, Send, Sparkles, Users,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import type { CloudAgent } from './lib'
import { PLATFORM_LABELS, agentCreatePlatforms, agentTaskTypeBlockReason } from './lib'
import {
  classifySubmissionFailure,
  confirmedSubmissionTaskId,
  createSubmissionRecord,
  isCurrentPreviewRequest,
  listSubmissionRecords,
  NEGATIVE_PATROL_MAX_SELECTED,
  NEGATIVE_PATROL_PREVIEW_PAGE_SIZE,
  recoverInterruptedSubmission,
  removeSubmissionRecord,
  stableStringify,
  submissionScopeLockName,
  submissionStorageKey,
  updatePageSelection,
  updateSubmissionRecord,
  writeSubmissionRecord,
  type NegativePatrolSubmissionRecord,
} from './negativePatrolSubmission'

type NegativePatrolCandidate = {
  id: string
  platform: string
  externalId?: string
  title?: string
  content?: string
  url?: string
  authorName?: string
  publishTime?: string
  publishedAt?: string
  interactions?: number
  metrics?: {
    likes?: number
    comments?: number
    collects?: number
    shares?: number
  }
  risk_level?: string
  effectiveSentiment?: string
  sentimentSource?: string
  canDispatch?: boolean
  dispatchable?: boolean
  eligible?: boolean
  eligibilityReason?: unknown
  eligibilityCode?: string
  falsePositivePending?: boolean
}

type PreviewResponse = {
  ok: true
  candidates?: NegativePatrolCandidate[]
  records?: NegativePatrolCandidate[]
  total?: number
  matchedCount?: number
  dispatchableCount?: number
  eligibleCount?: number
  deferredCount?: number
  pageCount?: number
  currentPageCount?: number
  nextCursor?: string | null
  hasMore?: boolean
  limited?: boolean
  message?: string
  counts?: {
    matched?: number
    dispatchable?: number
    eligible?: number
    deferred?: number
    page?: number
  }
}

type PreviewPage = {
  cursor: string | null
  candidates: NegativePatrolCandidate[]
  nextCursor: string | null
  hasMore: boolean
}

type TaskCreateResponse = {
  ok?: boolean
  message?: string
  existing?: boolean
  taskId?: string
  task?: {id?: string}
}

type TaskFailureBody = {
  error?: string
  code?: string
  message?: string
  submissionState?: string
  created?: boolean
  invalidRecordIds?: string[]
}

class TaskCreationResponseError extends Error {
  readonly status: number
  readonly code: string
  readonly submissionState: string
  readonly created: boolean | undefined
  readonly invalidRecordIds: string[]

  constructor(status: number, body: TaskFailureBody) {
    super(body.message || body.error || '创建负面帖子巡查任务失败')
    this.name = 'TaskCreationResponseError'
    this.status = status
    this.code = String(body.error || body.code || '')
    this.submissionState = String(body.submissionState || '')
    this.created = body.created
    this.invalidRecordIds = Array.isArray(body.invalidRecordIds)
      ? body.invalidRecordIds.map(String)
      : []
  }
}

async function postNegativePatrolTask(
  input: Record<string, unknown>,
  requestKey: string,
  tenantId: string,
) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch('/api/capture-cloud/negative-patrol/tasks', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(tenantId ? {'x-tenant-id': tenantId} : {}),
      },
      body: JSON.stringify({...input, requestKey}),
      signal: controller.signal,
    })
    let body: TaskCreateResponse & TaskFailureBody
    try {
      body = await response.json() as TaskCreateResponse & TaskFailureBody
    } catch {
      throw new Error('服务器返回格式异常，提交结果需要确认。')
    }
    if (!response.ok) throw new TaskCreationResponseError(response.status, body)
    if (!confirmedSubmissionTaskId(body)) {
      throw new Error('服务器未返回可确认的任务编号，提交结果需要确认。')
    }
    return body
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('请求超时，服务端是否已创建任务尚未确认。') as Error & {cause?: unknown}
      timeoutError.cause = error
      throw timeoutError
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function localDateKey(date: Date) {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function initialDateRange() {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 6)
  return { from: localDateKey(start), to: localDateKey(end) }
}

function safeCount(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

function candidateInteraction(candidate: NegativePatrolCandidate) {
  if (Number.isFinite(Number(candidate.interactions))) {
    return safeCount(candidate.interactions)
  }
  return safeCount(candidate.metrics?.likes)
    + safeCount(candidate.metrics?.comments)
    + safeCount(candidate.metrics?.collects)
    + safeCount(candidate.metrics?.shares)
}

function formatPublishDate(candidate: NegativePatrolCandidate) {
  const source = candidate.publishedAt || candidate.publishTime || ''
  if (!source) return '发布日期缺失'
  const parsed = new Date(source)
  if (Number.isNaN(parsed.getTime())) return String(source)
  return parsed.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function platformTone(platform: string) {
  return platform === 'douyin'
    ? 'bg-slate-950 text-white dark:bg-slate-100 dark:text-slate-950'
    : 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300'
}

function eligibilityReason(candidate: NegativePatrolCandidate) {
  if (typeof candidate.eligibilityReason === 'string') return candidate.eligibilityReason.trim()
  if (candidate.eligibilityReason && typeof candidate.eligibilityReason === 'object') {
    const source = candidate.eligibilityReason as Record<string, unknown>
    return String(source.message || source.reason || '').trim()
  }
  return ''
}

function canDispatchCandidate(candidate: NegativePatrolCandidate) {
  return candidate.canDispatch === true
}

function sentimentLabel(candidate: NegativePatrolCandidate) {
  const source = String(candidate.sentimentSource || '').toLowerCase()
  if (String(candidate.effectiveSentiment || '').toLowerCase() !== 'negative') return ''
  if (source.includes('invalid')) return ''
  if (source.includes('manual') || source.includes('human')) return '人工负面'
  if (source.includes('ai')) return 'AI 负面'
  return candidate.effectiveSentiment === 'negative' ? '当前负面' : ''
}

function uniqueCandidates(rows: NegativePatrolCandidate[], excluded = new Set<string>()) {
  const seen = new Set(excluded)
  return rows.filter(candidate => {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || seen.has(candidate.id)) return false
    seen.add(candidate.id)
    return true
  })
}

function persistSubmission(key: string, record: NegativePatrolSubmissionRecord) {
  try {
    writeSubmissionRecord(window.localStorage, key, record)
    return true
  } catch {
    return false
  }
}

function discardSubmission(key: string) {
  try {
    removeSubmissionRecord(window.localStorage, key)
  } catch {
    // A retained record is safer than losing an unresolved submission.
  }
}

export function NegativePatrolTaskCreator({
  agents: allAgents,
  writable,
  initialRecordIds = [],
  initialAgentIds = [],
  onCreated,
}: {
  agents: CloudAgent[]
  writable: boolean
  initialRecordIds?: string[]
  initialAgentIds?: string[]
  onCreated: () => Promise<void>
}) {
  const {user, tenantId} = useAuth()
  const initialRange = useMemo(() => initialDateRange(), [])
  const stableInitialIds = useMemo(() => Array.from(new Set(
    initialRecordIds.map(value => String(value || '').trim()).filter(Boolean),
  )).slice(0, NEGATIVE_PATROL_MAX_SELECTED), [initialRecordIds])
  const availablePlatforms = ['xiaohongshu', 'douyin']
  const [explicitAgentIds, setExplicitAgentIds] = useState<Set<string> | null>(() =>
    initialAgentIds.length > 0 ? new Set(initialAgentIds) : null)
  const compatibleAgents = allAgents.filter(agent => !agentTaskTypeBlockReason(agent, 'negative_patrol', 'one_time')
    && agent.capabilities?.negativePostPatrol === true
    && agent.capabilities?.negativePatrolTerminalReceiptV1 === true
    && agent.capabilities?.remoteTargetedPostCaptureV1 === true)
  const agents = compatibleAgents.filter(agent => (!explicitAgentIds || explicitAgentIds.has(agent.id)))
  const [title, setTitle] = useState('负面帖子巡查')
  const [platforms, setPlatforms] = useState<string[]>(availablePlatforms)
  const [publishDateFrom, setPublishDateFrom] = useState(initialRange.from)
  const [publishDateTo, setPublishDateTo] = useState(initialRange.to)
  const [query, setQuery] = useState('')
  const [minInteractions, setMinInteractions] = useState(0)
  const [includeComments, setIncludeComments] = useState(false)
  const [includeBloggerMetrics, setIncludeBloggerMetrics] = useState(false)
  const [previewPages, setPreviewPages] = useState<PreviewPage[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [matchedCount, setMatchedCount] = useState(0)
  const [dispatchableCount, setDispatchableCount] = useState(0)
  const [deferredCount, setDeferredCount] = useState(0)
  const [limited, setLimited] = useState(false)
  const [handoffMissingCount, setHandoffMissingCount] = useState(0)
  const [previewed, setPreviewed] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [submission, setSubmission] = useState<NegativePatrolSubmissionRecord | null>(null)
  const [submissionBusy, setSubmissionBusy] = useState(false)
  const [loadedSubmissionScope, setLoadedSubmissionScope] = useState('')
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const loadedInitialScope = useRef('')
  const previewGeneration = useRef(0)
  const activePreviewCriteria = useRef('')
  const previewSnapshotCriteria = useRef('')
  const activeScope = useRef('')
  const activeSubmissionRequest = useRef('')

  const selectedPlatforms = platforms.filter(platform => availablePlatforms.includes(platform))
  const scopeKey = user?.id && tenantId ? `${user.id}:${tenantId}` : ''
  const currentPage = previewPages[pageIndex] || null
  const candidates = currentPage?.candidates || []
  const loadedCandidates = useMemo(() => {
    const seen = new Set<string>()
    return previewPages.flatMap(page => page.candidates).filter(candidate => {
      if (seen.has(candidate.id)) return false
      seen.add(candidate.id)
      return true
    })
  }, [previewPages])
  const selectablePageIds = candidates.filter(canDispatchCandidate).map(candidate => candidate.id)
  const allSelected = selectablePageIds.length > 0
    && selectablePageIds.every(id => selectedIds.has(id))
  const selectedCandidates = loadedCandidates.filter(candidate => selectedIds.has(candidate.id))
  const selectedCandidatePlatforms = Array.from(new Set(
    selectedCandidates.map(candidate => candidate.platform).filter(Boolean),
  ))
  const dispatchAgents = agents.filter(agent => selectedCandidatePlatforms.some(
    platform => agentCreatePlatforms(agent).includes(platform),
  ))
  const elasticPool = dispatchAgents.length > 1 || selectedCandidatePlatforms.length > 1
  const onlineAgentCount = dispatchAgents.filter(agent => agent.online).length
  const platformCoverage = selectedCandidatePlatforms.map(platform => ({
    platform,
    items: selectedCandidates.filter(candidate => candidate.platform === platform).length,
    agents: agents.filter(agent => agentCreatePlatforms(agent).includes(platform)).length,
  })).filter(entry => entry.items > 0)
  const missingCoverage = platformCoverage.filter(entry => entry.agents === 0)

  const filters = {
    publishDateFrom,
    publishDateTo,
    platform: selectedPlatforms.length === 1 ? selectedPlatforms[0] : 'mixed',
    platforms: [...selectedPlatforms].sort(),
    query: query.trim(),
    minInteractions,
    limit: NEGATIVE_PATROL_MAX_SELECTED,
    timezone: 'Asia/Shanghai',
  }
  const previewCriteriaKey = stableStringify({
    scopeKey,
    publishDateFrom,
    publishDateTo,
    platforms: [...selectedPlatforms].sort(),
    query: query.trim(),
    minInteractions,
    recordIds: stableInitialIds,
  })
  const submissionLocked = submission !== null
  const submitting = submission?.status === 'submitting' && submissionBusy

  const clearPreview = () => {
    previewGeneration.current += 1
    previewSnapshotCriteria.current = ''
    setPreviewing(false)
    setPreviewPages([])
    setPageIndex(0)
    setSelectedIds(new Set())
    setMatchedCount(0)
    setDispatchableCount(0)
    setDeferredCount(0)
    setLimited(false)
    setHandoffMissingCount(0)
    setPreviewed(false)
    setFeedback('')
    setError('')
  }

  const validateFilters = () => {
    if (selectedPlatforms.length === 0) return '请至少选择一个执行平台。'
    if (!publishDateFrom || !publishDateTo) return '发布时间范围不能为空。'
    if (publishDateFrom > publishDateTo) return '发布时间的开始日期不能晚于结束日期。'
    if (!Number.isSafeInteger(minInteractions) || minInteractions < 0) {
      return '最低互动量必须是大于等于 0 的整数。'
    }
    return ''
  }

  const preview = async ({
    recordIds = stableInitialIds,
    cursor = null,
    append = false,
  }: {
    recordIds?: string[]
    cursor?: string | null
    append?: boolean
  } = {}) => {
    setError('')
    setFeedback('')
    if (submissionLocked) {
      setError('上次提交结果尚未确认，请先完成恢复。')
      return
    }
    const validationError = validateFilters()
    if (validationError) {
      setError(validationError)
      return
    }
    if (append && previewSnapshotCriteria.current !== previewCriteriaKey) {
      clearPreview()
      setError('筛选条件已经变化，请重新预览。')
      return
    }
    const generation = ++previewGeneration.current
    const responseCriteriaKey = previewCriteriaKey
    if (!append) {
      previewSnapshotCriteria.current = ''
      setPreviewPages([])
      setPageIndex(0)
      setSelectedIds(new Set())
      setMatchedCount(0)
      setDispatchableCount(0)
      setDeferredCount(0)
      setLimited(false)
      setHandoffMissingCount(0)
      setPreviewed(false)
    }
    setPreviewing(true)
    try {
      const pageSize = recordIds.length > 0
        ? Math.min(NEGATIVE_PATROL_MAX_SELECTED, Math.max(NEGATIVE_PATROL_PREVIEW_PAGE_SIZE, recordIds.length))
        : NEGATIVE_PATROL_PREVIEW_PAGE_SIZE
      const result = await api.post<PreviewResponse>(
        '/capture-cloud/negative-patrol/candidates/preview',
        {
          ...filters,
          limit: pageSize,
          pageSize,
          ...(cursor ? {cursor} : {}),
          ...(recordIds.length > 0 ? {recordIds} : {}),
        },
      )
      if (!isCurrentPreviewRequest({
        activeGeneration: previewGeneration.current,
        responseGeneration: generation,
        activeCriteriaKey: activePreviewCriteria.current,
        responseCriteriaKey,
      })) return
      const existingIds = append
        ? new Set(previewPages.flatMap(page => page.candidates.map(candidate => candidate.id)))
        : new Set<string>()
      const rows = uniqueCandidates(result.candidates || result.records || [], existingIds)
      const missingCount = recordIds.length > 0 ? Math.max(0, recordIds.length - rows.length) : 0
      const nextCursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : null
      const page: PreviewPage = {
        cursor,
        candidates: rows,
        nextCursor,
        hasMore: result.hasMore === true || nextCursor !== null,
      }
      if (append) {
        setPreviewPages(current => [...current, page])
        setPageIndex(previewPages.length)
      } else {
        setPreviewPages([page])
        setPageIndex(0)
        setSelectedIds(new Set(
          rows.filter(canDispatchCandidate)
            .slice(0, NEGATIVE_PATROL_MAX_SELECTED)
            .map(item => item.id),
        ))
      }
      const matched = safeCount(result.matchedCount ?? result.counts?.matched ?? result.total ?? rows.length)
      const dispatchable = safeCount(
        result.dispatchableCount
          ?? result.eligibleCount
          ?? result.counts?.dispatchable
          ?? result.counts?.eligible
          ?? matched,
      )
      setMatchedCount(matched)
      setDispatchableCount(dispatchable)
      setDeferredCount(safeCount(
        result.deferredCount ?? result.counts?.deferred ?? Math.max(0, matched - dispatchable),
      ))
      setLimited(result.limited === true)
      setHandoffMissingCount(missingCount)
      setPreviewed(true)
      previewSnapshotCriteria.current = responseCriteriaKey
      if (missingCount > 0) {
        setError(`带入清单中有 ${missingCount} 条不符合负面巡查条件，请返回重新选择负面内容。`)
      } else {
        setFeedback(rows.length > 0
          ? recordIds.length > 0
            ? `已加载 ${rows.length} 条负面内容。`
            : append
              ? `已加载第 ${previewPages.length + 1} 页。跨页选择已保留。`
              : `已找到 ${matched} 条当前负面帖子，其中 ${dispatchable} 条可下发。`
          : result.message || '当前范围内没有可巡查的负面帖子。')
      }
    } catch (err) {
      if (isCurrentPreviewRequest({
        activeGeneration: previewGeneration.current,
        responseGeneration: generation,
        activeCriteriaKey: activePreviewCriteria.current,
        responseCriteriaKey,
      })) {
        setError(err instanceof Error ? err.message : '读取负面候选失败')
      }
    } finally {
      if (isCurrentPreviewRequest({
        activeGeneration: previewGeneration.current,
        responseGeneration: generation,
        activeCriteriaKey: activePreviewCriteria.current,
        responseCriteriaKey,
      })) {
        setPreviewing(false)
      }
    }
  }

  useEffect(() => {
    activeScope.current = scopeKey
    activePreviewCriteria.current = previewCriteriaKey
  }, [previewCriteriaKey, scopeKey])

  useEffect(() => {
    let cancelled = false
    previewGeneration.current += 1
    previewSnapshotCriteria.current = ''
    loadedInitialScope.current = ''
    queueMicrotask(() => {
      if (cancelled) return
      setPreviewing(false)
      setLoadedSubmissionScope('')
      setPreviewPages([])
      setPageIndex(0)
      setSelectedIds(new Set())
      setMatchedCount(0)
      setDispatchableCount(0)
      setDeferredCount(0)
      setLimited(false)
      setHandoffMissingCount(0)
      setPreviewed(false)
      setError('')
      setFeedback('')
      if (!scopeKey || !user?.id || !tenantId) {
        setSubmission(null)
        return
      }
      let stored: NegativePatrolSubmissionRecord | null = null
      try {
        const records = listSubmissionRecords(window.localStorage, user.id, tenantId)
        for (const record of records) {
          const key = submissionStorageKey(record.userId, record.tenantId, record.requestKey)
          if (record.status === 'rejected_before_create') {
            discardSubmission(key)
            continue
          }
          if (!stored) stored = record
        }
      } catch {
        setSubmission(null)
        setLoadedSubmissionScope('')
        setError('无法安全读取提交恢复记录，请先检查浏览器本地存储。')
        return
      }
      if (stored?.status === 'submitting') {
        stored = recoverInterruptedSubmission(stored)
        const key = submissionStorageKey(stored.userId, stored.tenantId, stored.requestKey)
        if (!persistSubmission(key, stored)) {
          setError('无法更新上次提交的本地恢复状态，请释放浏览器存储空间。')
        }
      }
      setSubmission(stored)
      if (!activeSubmissionRequest.current) setSubmissionBusy(false)
      setLoadedSubmissionScope(scopeKey)
      if (stored?.status === 'unknown') {
        setError('上次提交的结果尚未确认，请使用原请求继续确认。')
      } else if (stored?.status === 'conflict') {
        setError(stored.message || '上次提交需要原用户重新登录后继续确认。')
      } else if (stored?.status === 'confirmed') {
        setFeedback('任务已经确认创建，只需刷新任务列表。')
      }
    })
    return () => { cancelled = true }
  }, [scopeKey, tenantId, user?.id])

  useEffect(() => {
    if (
      stableInitialIds.length === 0
      || !scopeKey
      || loadedSubmissionScope !== scopeKey
      || submissionLocked
      || loadedInitialScope.current === scopeKey
    ) return
    loadedInitialScope.current = scopeKey
    void preview({recordIds: stableInitialIds})
    // Initial handoff is consumed once; later filtering is explicitly user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedSubmissionScope, scopeKey, submissionLocked])

  const toggleCandidate = (candidate: NegativePatrolCandidate) => {
    if (submissionLocked || !canDispatchCandidate(candidate)) return
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(candidate.id)) {
        next.delete(candidate.id)
      } else if (next.size >= NEGATIVE_PATROL_MAX_SELECTED) {
        setError(`单次最多选择 ${NEGATIVE_PATROL_MAX_SELECTED} 条，请分批下发。`)
      } else {
        next.add(candidate.id)
      }
      return next
    })
  }

  const toggleAll = () => {
    if (submissionLocked) return
    setSelectedIds(current => {
      const result = updatePageSelection(
        current,
        selectablePageIds,
        !allSelected,
        NEGATIVE_PATROL_MAX_SELECTED,
      )
      if (result.overflow > 0) {
        setError(`单次最多选择 ${NEGATIVE_PATROL_MAX_SELECTED} 条，本页还有 ${result.overflow} 条未选，请分批下发。`)
      } else {
        setError('')
      }
      return result.selected
    })
  }

  const showPage = async (nextIndex: number) => {
    if (submissionLocked || previewing || nextIndex < 0) return
    if (previewPages[nextIndex]) {
      setPageIndex(nextIndex)
      return
    }
    if (nextIndex !== pageIndex + 1 || !currentPage?.nextCursor) return
    await preview({cursor: currentPage.nextCursor, append: true})
  }

  const finishConfirmedSubmission = async (record: NegativePatrolSubmissionRecord) => {
    const actionKey = `refresh:${record.requestKey}`
    if (activeSubmissionRequest.current) return
    activeSubmissionRequest.current = actionKey
    setSubmissionBusy(true)
    try {
      await onCreated()
      const key = submissionStorageKey(record.userId, record.tenantId, record.requestKey)
      discardSubmission(key)
      if (activeScope.current === `${record.userId}:${record.tenantId}`) setSubmission(null)
    } catch (err) {
      setError(err instanceof Error ? `任务已创建，但列表刷新失败：${err.message}` : '任务已创建，但列表刷新失败。')
    } finally {
      if (activeSubmissionRequest.current === actionKey) {
        activeSubmissionRequest.current = ''
        setSubmissionBusy(false)
      }
    }
  }

  const runSubmission = async (record: NegativePatrolSubmissionRecord, recovery: boolean) => {
    if (activeSubmissionRequest.current) return
    const recordScope = `${record.userId}:${record.tenantId}`
    const recordStorageKey = submissionStorageKey(record.userId, record.tenantId, record.requestKey)
    const active = updateSubmissionRecord(record, 'submitting', {
      message: recovery ? '正在使用原请求确认上次提交。' : '正在创建任务。',
    })
    if (!persistSubmission(recordStorageKey, active)) {
      setError('浏览器无法保存提交恢复信息，本次没有下发。请释放本地存储空间后重试。')
      return
    }
    activeSubmissionRequest.current = active.requestKey
    if (activeScope.current === recordScope) setSubmission(active)
    setSubmissionBusy(true)
    setError('')
    setFeedback(recovery ? '正在确认上次提交；将复用相同请求，不会另建一批。' : '')

    let result: TaskCreateResponse
    try {
      result = await postNegativePatrolTask(active.input, active.requestKey, active.tenantId)
    } catch (err) {
      const responseError = err instanceof TaskCreationResponseError ? err : null
      const failureStatus = classifySubmissionFailure({
        httpStatus: responseError?.status,
        code: responseError?.code,
        submissionState: responseError?.submissionState,
        created: responseError?.created,
      })
      if (failureStatus === 'rejected_before_create') {
        const rejectedRecord = updateSubmissionRecord(active, 'rejected_before_create', {
          message: responseError?.message,
          errorCode: responseError?.code,
        })
        persistSubmission(recordStorageKey, rejectedRecord)
        discardSubmission(recordStorageKey)
        if (activeScope.current === recordScope) {
          setSubmission(null)
          if (['candidate_selection_changed', 'negative_candidates_empty'].includes(responseError?.code || '')) {
            clearPreview()
          }
          setError(responseError?.message || '服务器明确拒绝了本次创建，请修改后重试。')
        }
      } else {
        const unresolved = updateSubmissionRecord(active, failureStatus, {
          message: err instanceof Error ? err.message : '提交结果尚未确认。',
          errorCode: responseError?.code,
        })
        const unresolvedSaved = persistSubmission(recordStorageKey, unresolved)
        if (activeScope.current === recordScope) {
          setSubmission(unresolved)
          setError(failureStatus === 'conflict'
            ? unresolved.message || '请使用原用户和租户重新登录后继续确认。'
            : `${unresolved.message || '提交结果尚未确认。'} 请点击“确认上次提交”，不要重新选择帖子。${unresolvedSaved ? '' : ' 浏览器未能更新恢复状态，请勿关闭此页。'}`)
        }
      }
      if (activeSubmissionRequest.current === active.requestKey) {
        activeSubmissionRequest.current = ''
        setSubmissionBusy(false)
      }
      return
    }

    const taskId = confirmedSubmissionTaskId(result)
    if (!taskId) {
      const unresolved = updateSubmissionRecord(active, 'unknown', {
        message: '服务器未返回可确认的任务编号，提交结果需要确认。',
      })
      persistSubmission(recordStorageKey, unresolved)
      if (activeScope.current === recordScope) {
        setSubmission(unresolved)
        setError('服务器未返回可确认的任务编号，请使用原请求继续确认。')
      }
      if (activeSubmissionRequest.current === active.requestKey) {
        activeSubmissionRequest.current = ''
        setSubmissionBusy(false)
      }
      return
    }
    const confirmed = updateSubmissionRecord(active, 'confirmed', {
      taskId,
      message: result.message || (result.existing ? '已找到原任务。' : '任务已创建。'),
    })
    const confirmedSaved = persistSubmission(recordStorageKey, confirmed)
    if (activeSubmissionRequest.current === active.requestKey) {
      activeSubmissionRequest.current = ''
      setSubmissionBusy(false)
    }
    if (activeScope.current !== recordScope) return
    setSubmission(confirmed)
    setFeedback(result.message || (
      result.existing
        ? '已确认上次提交并找到原任务，没有重复创建。'
        : `已创建 ${Array.isArray(active.input.recordIds) ? active.input.recordIds.length : 0} 条定向采集任务。`
    ))
    if (!confirmedSaved) {
      setError('任务已确认创建，但浏览器未能保存确认状态；请立即刷新任务列表。')
    }
    await finishConfirmedSubmission(confirmed)
  }

  const submit = async () => {
    setError('')
    setFeedback('')
    if (submission?.status === 'confirmed') {
      await finishConfirmedSubmission(submission)
      return
    }
    if (submission) {
      await runSubmission(submission, true)
      return
    }
    const validationError = validateFilters()
    if (validationError) {
      setError(validationError)
      return
    }
    if (!previewed || previewSnapshotCriteria.current !== previewCriteriaKey) {
      setError('请先预览候选帖子，再确认下发。')
      return
    }
    if (handoffMissingCount > 0) {
      setError('带入的负面内容尚未完整加载，不能创建可能漏采的任务。')
      return
    }
    if (selectedIds.size === 0) {
      setError('请至少选择一条需要定向采集的帖子。')
      return
    }
    if (selectedIds.size > NEGATIVE_PATROL_MAX_SELECTED) {
      setError(`单次最多选择 ${NEGATIVE_PATROL_MAX_SELECTED} 条，请分批下发。`)
      return
    }
    if (missingCoverage.length > 0) {
      setError(`已选节点未覆盖${missingCoverage.map(entry => PLATFORM_LABELS[entry.platform] || entry.platform).join('、')}，请在下方补选对应平台节点；若没有可用节点，请启用或升级该平台的采集设备。`)
      return
    }
    const eligibleAgents = dispatchAgents
    if (!user?.id || !tenantId || loadedSubmissionScope !== scopeKey) {
      setError('登录信息尚未就绪，无法安全保存提交恢复信息。')
      return
    }
    const taskInput: Record<string, unknown> = {
      ...filters,
      platform: selectedCandidatePlatforms.length === 1 ? selectedCandidatePlatforms[0] : 'mixed',
      platforms: [...selectedCandidatePlatforms].sort(),
      agentIds: eligibleAgents.map(agent => agent.id),
      ...(eligibleAgents.length === 1 ? { agentId: eligibleAgents[0].id } : {}),
      distributionMode: elasticPool ? 'elastic_pool' : 'fixed_batch',
      recoveryPolicy: {
        allowIdleAgentHandoff: elasticPool,
        platformSafetyMode: 'manual_confirmed',
      },
      title: title.trim() || '负面帖子巡查',
      recordIds: Array.from(selectedIds).sort(),
      captureSettings: {
        autoSyncAfterDetailCapture: true,
        includeComments,
        includeBloggerMetrics,
      },
    }
    let freshSubmission: NegativePatrolSubmissionRecord | null = null
    let existingSubmission: NegativePatrolSubmissionRecord | null = null
    try {
      const lockName = submissionScopeLockName(user.id, tenantId)
      if (!lockName || !navigator.locks?.request) throw new Error('submission_lock_unavailable')
      await navigator.locks.request(lockName, {mode: 'exclusive'}, async () => {
        const records = listSubmissionRecords(window.localStorage, user.id, tenantId)
        for (const record of records) {
          const key = submissionStorageKey(record.userId, record.tenantId, record.requestKey)
          if (record.status === 'rejected_before_create') {
            discardSubmission(key)
            continue
          }
          existingSubmission = record.status === 'submitting'
            ? recoverInterruptedSubmission(record)
            : record
          if (existingSubmission !== record && !persistSubmission(key, existingSubmission)) {
            throw new Error('local_storage_write_failed')
          }
          break
        }
        if (existingSubmission) return
        const created = createSubmissionRecord({
          userId: user.id,
          tenantId,
          requestKey: window.crypto.randomUUID(),
          input: taskInput,
        })
        const key = submissionStorageKey(created.userId, created.tenantId, created.requestKey)
        if (!persistSubmission(key, created)) throw new Error('local_storage_write_failed')
        freshSubmission = created
      })
    } catch {
      setError('浏览器无法安全锁定并保存提交恢复信息，本次没有下发。请关闭重复后台页或检查本地存储后重试。')
      return
    }
    if (existingSubmission) {
      setSubmission(existingSubmission)
      setError('另一个后台页已有待确认的负面巡查提交，请先使用原请求确认结果。')
      return
    }
    if (!freshSubmission) {
      setError('没有生成可恢复的提交记录，本次没有下发。')
      return
    }
    setSubmission(freshSubmission)
    await runSubmission(freshSubmission, false)
  }

  const disabled = !writable || submissionLocked
  const submitDisabled = submissionBusy || !writable || (!submission && (
    loadedSubmissionScope !== scopeKey
    || !scopeKey
    || dispatchAgents.length === 0
    || dispatchAgents.some(agent => agent.status !== 'active')
    || selectedPlatforms.length === 0
    || previewing
    || !previewed
    || handoffMissingCount > 0
    || selectedIds.size === 0
    || missingCoverage.length > 0
  ))

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-background">
        <div className="border-l-4 border-l-status-red px-4 py-4 sm:px-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-status-red/10 text-status-red">
              <Search className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground">先圈定负面候选</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                只会选择已判为负面、带有效发布日期且能定位到原帖的内容。
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-t border-border/70 p-4 sm:grid-cols-2 sm:p-5">
          <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">
            任务名称
            <input value={title} onChange={event => setTitle(event.target.value)} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
          </label>
          <fieldset className="block text-xs font-medium text-muted-foreground">
            <legend>执行平台（可多选）</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {availablePlatforms.map(value => {
                const checked = selectedPlatforms.includes(value)
                return (
                  <label key={value}
                    className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${checked ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-background text-foreground'}`}>
                    <input type="checkbox" checked={checked} disabled={disabled}
                      onChange={event => {
                        const nextChecked = event.target.checked
                        setPlatforms(current => nextChecked ? [...current, value] : current.filter(item => item !== value))
                        clearPreview()
                      }}
                      className="h-4 w-4 shrink-0 accent-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" />
                    <span>{PLATFORM_LABELS[value] || value}</span>
                  </label>
                )
              })}
            </div>
            <p role="status" className={`mt-1.5 text-xs leading-5 ${selectedPlatforms.length > 0 ? 'text-foreground' : 'text-status-red'}`}>
              {selectedPlatforms.length > 0
                ? `已选：${selectedPlatforms.map(value => PLATFORM_LABELS[value] || value).join('、')}`
                : '尚未选择平台，请至少勾选一个'}
            </p>
          </fieldset>
          <div className="block text-xs font-medium text-muted-foreground">
            预览与下发上限
            <div className="mt-1.5 flex h-10 items-center rounded-lg border border-border bg-muted/25 px-3 text-xs text-foreground">
              每页 {NEGATIVE_PATROL_PREVIEW_PAGE_SIZE} 条 · 单次最多选择 {NEGATIVE_PATROL_MAX_SELECTED} 条
            </div>
          </div>
          <div className="sm:col-span-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <CalendarDays className="h-3.5 w-3.5 text-status-red" />
              发布时间范围 <span className="text-status-red">*</span>
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <input type="date" value={publishDateFrom}
                onChange={event => { setPublishDateFrom(event.target.value); clearPreview() }} disabled={disabled}
                aria-label="发布时间开始日期"
                className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              <span className="text-xs text-muted-foreground">至</span>
              <input type="date" value={publishDateTo}
                onChange={event => { setPublishDateTo(event.target.value); clearPreview() }} disabled={disabled}
                aria-label="发布时间结束日期"
                className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">按北京时间统计，开始日 00:00 起、截止日次日 00:00 前；发布日期缺失时不会用采集时间代替。</p>
          </div>
          <label className="block text-xs font-medium text-muted-foreground">
            内容关键词（可选）
            <input value={query} onChange={event => { setQuery(event.target.value); clearPreview() }}
              placeholder="标题、正文、作者或采集关键词" disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary disabled:opacity-60" />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            最低互动量（可选）
            <input type="number" min={0} step={1} value={minInteractions}
              onChange={event => { setMinInteractions(Number(event.target.value)); clearPreview() }} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/25 px-4 py-3 sm:px-5">
          <p className="text-[11px] leading-4 text-muted-foreground">{stableInitialIds.length > 0 ? '已带入当前勾选清单；系统仍会校验负面状态与原帖定位。' : '筛选只用于圈定对象；Extension 会逐条打开原帖并补采最新详情。'}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => preview({recordIds: stableInitialIds})} disabled={disabled || selectedPlatforms.length === 0 || previewing} className="shrink-0">
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : previewed ? <RefreshCw className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            {previewed ? '重新加载' : stableInitialIds.length > 0 ? '加载清单' : '预览候选'}
          </Button>
        </div>
      </section>

      {previewed && (
        <section className="overflow-hidden rounded-2xl border border-border bg-background">
          <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
            <div>
              <h3 className="text-sm font-bold text-foreground">确认定向采集清单</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                当前负面 {matchedCount} 条 · 可下发 {dispatchableCount} 条 · 暂缓 {deferredCount} 条 · 已选 {selectedIds.size} 条
              </p>
            </div>
            {selectablePageIds.length > 0 && (
              <button type="button" onClick={toggleAll} disabled={disabled}
                className="min-h-8 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {allSelected ? '取消本页全选' : '全选本页'}
              </button>
            )}
          </div>
          {dispatchableCount > NEGATIVE_PATROL_MAX_SELECTED && (
            <p className="border-b border-amber-300/30 bg-amber-50/60 px-4 py-2.5 text-[11px] leading-4 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300 sm:px-5">
              当前有 {dispatchableCount} 条可下发，单次最多选择 {NEGATIVE_PATROL_MAX_SELECTED} 条；请分批创建，系统不会自动生成第二批任务。
            </p>
          )}
          {candidates.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <Sparkles className="mx-auto h-7 w-7 text-muted-foreground/50" />
              <div className="mt-3 text-sm font-semibold">没有符合条件的负面帖子</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">扩大发布日期范围，或降低互动量条件后重新筛选。</p>
            </div>
          ) : (
            <div className="max-h-[420px] divide-y divide-border/70 overflow-y-auto overscroll-contain">
              {candidates.map(candidate => {
                const selected = selectedIds.has(candidate.id)
                const selectable = canDispatchCandidate(candidate)
                const reason = eligibilityReason(candidate)
                const sentiment = sentimentLabel(candidate)
                const reviewHint = candidate.falsePositivePending
                  ? '存在待复核的误报反馈；当前人工负面仍可下发。'
                  : ''
                return (
                  <button key={candidate.id} type="button" onClick={() => toggleCandidate(candidate)}
                    disabled={disabled || !selectable}
                    aria-describedby={reason || reviewHint ? `negative-patrol-reason-${candidate.id}` : undefined}
                    className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors sm:px-5 ${selected ? 'bg-primary/[0.035]' : selectable ? 'hover:bg-muted/35' : 'cursor-not-allowed bg-muted/20 opacity-75'}`}>
                    <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${selected ? 'border-primary bg-primary text-primary-foreground' : selectable ? 'border-border bg-background' : 'border-border bg-muted'}`}>
                      {selected && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${platformTone(candidate.platform)}`}>
                          {PLATFORM_LABELS[candidate.platform] || candidate.platform}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{formatPublishDate(candidate)}</span>
                        <span className={`text-[11px] ${negativeInteractionClass(candidate.effectiveSentiment, candidateInteraction(candidate))}`}>互动 {candidateInteraction(candidate)}</span>
                        {sentiment && <span className="text-[11px] font-medium text-status-red">{sentiment}</span>}
                      </span>
                      <span className="mt-1.5 line-clamp-2 block text-sm font-semibold leading-5 text-foreground">
                        {candidate.title || candidate.content || '未命名帖子'}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                        {candidate.authorName || '作者未识别'}
                      </span>
                      {!selectable && (
                        <span id={`negative-patrol-reason-${candidate.id}`} className="mt-1.5 block text-[11px] font-medium leading-4 text-amber-700 dark:text-amber-300">
                          暂不下发：{reason || candidate.eligibilityCode || '当前记录需要核对'}
                        </span>
                      )}
                      {selectable && reviewHint && (
                        <span id={`negative-patrol-reason-${candidate.id}`} className="mt-1.5 block text-[11px] font-medium leading-4 text-amber-700 dark:text-amber-300">
                          {reviewHint}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {previewed && candidates.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-4 py-3 sm:px-5">
              <p className="text-[11px] text-muted-foreground">
                第 {pageIndex + 1} 页 · 本页 {candidates.length} 条 · 跨页选择会保留
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm"
                  onClick={() => void showPage(pageIndex - 1)}
                  disabled={disabled || previewing || pageIndex === 0}>
                  <ChevronLeft className="h-4 w-4" />上一页
                </Button>
                <Button type="button" variant="outline" size="sm"
                  onClick={() => void showPage(pageIndex + 1)}
                  disabled={disabled || previewing || (!previewPages[pageIndex + 1] && !currentPage?.nextCursor)}>
                  {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                  下一页
                </Button>
              </div>
            </div>
          )}
          {(limited || currentPage?.hasMore) && !currentPage?.nextCursor && (
            <p className="border-t border-amber-300/30 bg-amber-50/60 px-4 py-2.5 text-[11px] leading-4 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300 sm:px-5">
              当前服务仅返回了前 {candidates.length} 条，尚未提供稳定翻页游标；不能把这一页当作整个时间范围。
            </p>
          )}
        </section>
      )}

      {previewed && candidates.length > 0 && (
        <section className="rounded-2xl border border-primary/15 bg-primary/[0.025] p-4 sm:p-5">
          <h3 className="text-sm font-bold text-foreground">补采内容</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">正文与最新互动数据始终采集并同步后台；以下信息会增加单帖耗时。</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border border-border/70 bg-background px-3">
              <input type="checkbox" checked={includeComments} onChange={event => setIncludeComments(event.target.checked)}
                disabled={disabled} className="h-4 w-4 accent-primary" />
              <MessageSquareText className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium">附加评论</span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border border-border/70 bg-background px-3">
              <input type="checkbox" checked={includeBloggerMetrics} onChange={event => setIncludeBloggerMetrics(event.target.checked)}
                disabled={disabled} className="h-4 w-4 accent-primary" />
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium">补充博主数据</span>
            </label>
          </div>
        </section>
      )}

      {previewed && selectedIds.size > 0 && (
        <>
        <section className="rounded-2xl border border-border p-4 sm:p-5">
          <h3 className="text-sm font-bold">按帖子平台选择执行节点</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">按所选帖子的平台展示可用节点。可以在此调整，帖子清单会保留；不同平台分别领取对应帖子。</p>
          <div className="mt-3 space-y-3">
            {platformCoverage.map(entry => (
              <fieldset key={entry.platform} className="rounded-lg border border-border p-3">
                <legend className="px-1 text-xs font-semibold">{PLATFORM_LABELS[entry.platform]} · {entry.items} 条帖子</legend>
                {compatibleAgents.filter(agent => agentCreatePlatforms(agent).includes(entry.platform)).map(agent => (
                  <label key={agent.id} className="flex min-h-10 items-center gap-2 text-xs">
                    <input type="checkbox" checked={(!explicitAgentIds || explicitAgentIds.has(agent.id))} disabled={submissionLocked || !writable}
                      onChange={event => setExplicitAgentIds(current => {
                        const next = new Set(current || compatibleAgents.map(candidate => candidate.id))
                        if (event.target.checked) next.add(agent.id)
                        else next.delete(agent.id)
                        return next
                      })} />
                    <span>{agent.display_name}</span>
                    <span className="text-muted-foreground">{agent.online ? '在线' : '离线，待上线领取'}</span>
                  </label>
                ))}
                {entry.agents === 0 && <p role="alert" className="mt-2 text-xs text-status-orange">缺少{PLATFORM_LABELS[entry.platform]}执行节点，请在此选择节点或启用对应平台设备。已选帖子会保留。</p>}
              </fieldset>
            ))}
          </div>
        </section>
        <section className="rounded-2xl border border-primary/20 bg-primary/[0.035] p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Users className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-bold text-foreground">
                {elasticPool ? '平台覆盖与弹性领取' : '平台覆盖与固定节点'}
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {elasticPool
                  ? `${selectedIds.size} 条帖子保留在云端；每个空闲 Agent 一次只领 1 条，完成后再领取下一条。`
                  : `${selectedIds.size} 条帖子固定交给 ${dispatchAgents[0]?.display_name || '所选 Agent'}；节点离线时原地等待，不自动转交。`}
              </p>
              <div className="mt-3 grid gap-2 text-[11px] leading-4 text-muted-foreground sm:grid-cols-2">
                {platformCoverage.map(entry => (
                  <span key={entry.platform} className={`rounded-lg border bg-background px-2.5 py-2 ${entry.agents > 0 ? 'border-border/70' : 'border-status-red/35 text-status-red'}`}>
                    {PLATFORM_LABELS[entry.platform] || entry.platform}：{entry.items} 条 · 可用 Agent {entry.agents} 个
                  </span>
                ))}
                <span className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                  {elasticPool ? '候选节点' : '执行节点'} <strong className="font-semibold text-foreground">{dispatchAgents.length}</strong> 个 · 当前在线 {onlineAgentCount} 个
                </span>
                <span className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                  {elasticPool
                    ? '节点离线后，未完成帖子会退回队列；旧结果不会重复写入'
                    : '节点离线时任务保留在队列；原节点重新上线后继续执行'}
                </span>
                <span className="rounded-lg border border-border/70 bg-background px-2.5 py-2 sm:col-span-2">
                  验证码、登录失效等平台安全问题不会自动换账号；当前帖子保留人工处理，其他帖子继续领取
                </span>
              </div>
            </div>
          </div>
        </section>
        </>
      )}

      {error && <p role="alert" className="text-xs leading-5 text-status-red">{error}</p>}
      {feedback && <p role="status" className="text-xs leading-5 text-status-green">{feedback}</p>}

      {submission && (
        <section className="rounded-xl border border-amber-300/40 bg-amber-50/60 px-4 py-3 text-xs leading-5 text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
          <div className="font-semibold">
            {submission.status === 'confirmed'
              ? '任务已确认创建'
              : submission.status === 'submitting'
                ? '正在提交，页面已冻结'
                : '上次提交结果尚未完成确认'}
          </div>
          <p className="mt-1">
            {submission.status === 'confirmed'
              ? `任务编号 ${submission.taskId || submission.requestKey}，只需刷新列表。`
              : '筛选、选帖和翻页暂时冻结；继续时会复用原请求和原清单，不会生成新的请求编号。'}
          </p>
        </section>
      )}

      <Button type="button" onClick={submit}
        disabled={submitDisabled}
        className="min-h-11 w-full">
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {submission?.status === 'confirmed'
          ? '刷新任务列表'
          : submission
            ? submitting ? '正在确认上次提交' : '确认上次提交'
            : !previewed
              ? '请先预览候选帖子'
              : elasticPool
              ? `把 ${selectedIds.size} 条帖子放入弹性队列`
              : dispatchAgents[0]?.online
                ? `下发 ${selectedIds.size || ''} 条定向采集`
                : `创建 ${selectedIds.size || ''} 条任务并排队`}
      </Button>
    </div>
  )
}
