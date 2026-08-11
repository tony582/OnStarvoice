import { useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarDays, Check, Loader2, MessageSquareText,
  RefreshCw, Search, Send, Sparkles, Users,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { CloudAgent } from './lib'
import { PLATFORM_LABELS, agentCreatePlatforms } from './lib'

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
}

type PreviewResponse = {
  ok: true
  candidates?: NegativePatrolCandidate[]
  records?: NegativePatrolCandidate[]
  total?: number
  matchedCount?: number
  limited?: boolean
  message?: string
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

export function NegativePatrolTaskCreator({
  agents,
  writable,
  onCreated,
}: {
  agents: CloudAgent[]
  writable: boolean
  onCreated: () => Promise<void>
}) {
  const initialRange = useMemo(() => initialDateRange(), [])
  const availablePlatforms = useMemo(() => {
    const [firstAgent, ...remainingAgents] = agents
    if (!firstAgent) return []
    return agentCreatePlatforms(firstAgent).filter(candidate =>
      remainingAgents.every(agent => agentCreatePlatforms(agent).includes(candidate)),
    )
  }, [agents])
  const [title, setTitle] = useState('负面帖子巡查')
  const [platform, setPlatform] = useState(availablePlatforms[0] || '')
  const [publishDateFrom, setPublishDateFrom] = useState(initialRange.from)
  const [publishDateTo, setPublishDateTo] = useState(initialRange.to)
  const [query, setQuery] = useState('')
  const [minInteractions, setMinInteractions] = useState(0)
  const [limit, setLimit] = useState(50)
  const [includeComments, setIncludeComments] = useState(false)
  const [includeBloggerMetrics, setIncludeBloggerMetrics] = useState(false)
  const [candidates, setCandidates] = useState<NegativePatrolCandidate[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [matchedCount, setMatchedCount] = useState(0)
  const [limited, setLimited] = useState(false)
  const [previewed, setPreviewed] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const pendingSubmission = useRef<{ fingerprint: string; requestKey: string } | null>(null)

  const supportsPatrol = agents.length > 0
    && agents.every(agent =>
      agent.capabilities?.negativePostPatrol === true
      && agent.capabilities?.remoteTargetedPostCaptureV1 === true,
    )
  const multiAgent = agents.length > 1
  const selectedPlatform = availablePlatforms.includes(platform)
    ? platform
    : availablePlatforms[0] || ''
  const allSelected = candidates.length > 0 && selectedIds.size === candidates.length
  const onlineAgentCount = agents.filter(agent => agent.online).length

  const filters = {
    publishDateFrom,
    publishDateTo,
    platform: selectedPlatform,
    query: query.trim(),
    minInteractions,
    limit,
  }

  const clearPreview = () => {
    setCandidates([])
    setSelectedIds(new Set())
    setMatchedCount(0)
    setLimited(false)
    setPreviewed(false)
    setFeedback('')
    pendingSubmission.current = null
  }

  const validateFilters = () => {
    if (agents.length === 0) return '请至少选择一个执行节点。'
    if (!supportsPatrol) return '部分节点版本尚不支持负面帖子巡查，请先升级 Extension。'
    if (agents.some(agent => agent.status !== 'active')) return '已选节点中包含暂停或停用节点，请返回重新选择。'
    if (!selectedPlatform) return '已选 Agent 没有共同可执行的平台，请调整节点负责平台。'
    if (!publishDateFrom || !publishDateTo) return '发布时间范围不能为空。'
    if (publishDateFrom > publishDateTo) return '发布时间的开始日期不能晚于结束日期。'
    if (!Number.isSafeInteger(minInteractions) || minInteractions < 0) {
      return '最低互动量必须是大于等于 0 的整数。'
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return '候选上限必须是 1–100 的整数。'
    }
    return ''
  }

  const preview = async () => {
    setError('')
    setFeedback('')
    const validationError = validateFilters()
    if (validationError) {
      setError(validationError)
      return
    }
    setPreviewing(true)
    try {
      const result = await api.post<PreviewResponse>(
        '/capture-cloud/negative-patrol/candidates/preview',
        filters,
      )
      const rows = (result.candidates || result.records || [])
        .filter(item => item && typeof item.id === 'string')
      setCandidates(rows)
      setSelectedIds(new Set(rows.map(item => item.id)))
      setMatchedCount(safeCount(result.total ?? result.matchedCount ?? rows.length))
      setLimited(result.limited === true)
      setPreviewed(true)
      setFeedback(rows.length > 0
        ? `已找到 ${result.total ?? result.matchedCount ?? rows.length} 条符合条件的负面帖子。`
        : result.message || '当前范围内没有可巡查的负面帖子。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取负面候选失败')
    } finally {
      setPreviewing(false)
    }
  }

  const toggleCandidate = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    pendingSubmission.current = null
  }

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(candidates.map(item => item.id)))
    pendingSubmission.current = null
  }

  const submit = async () => {
    setError('')
    setFeedback('')
    const validationError = validateFilters()
    if (validationError) {
      setError(validationError)
      return
    }
    if (!previewed) {
      setError('请先预览候选帖子，再确认下发。')
      return
    }
    if (selectedIds.size === 0) {
      setError('请至少选择一条需要定向采集的帖子。')
      return
    }
    const taskInput = {
      ...filters,
      agentIds: agents.map(agent => agent.id),
      ...(agents.length === 1 ? { agentId: agents[0].id } : {}),
      distributionMode: multiAgent ? 'elastic_pool' : 'fixed_batch',
      recoveryPolicy: {
        allowIdleAgentHandoff: multiAgent,
        platformSafetyMode: 'manual_confirmed',
      },
      title: title.trim() || '负面帖子巡查',
      recordIds: Array.from(selectedIds),
      captureSettings: {
        autoSyncAfterDetailCapture: true,
        includeComments,
        includeBloggerMetrics,
      },
    }
    const fingerprint = JSON.stringify(taskInput)
    let submission = pendingSubmission.current
    if (submission?.fingerprint !== fingerprint) {
      submission = { fingerprint, requestKey: window.crypto.randomUUID() }
      pendingSubmission.current = submission
    }

    setSubmitting(true)
    try {
      const result = await api.post<{ message?: string }>(
        '/capture-cloud/negative-patrol/tasks',
        { ...taskInput, requestKey: submission.requestKey },
        { timeoutMs: 30_000 },
      )
      pendingSubmission.current = null
      setFeedback(result.message || (
        multiAgent
          ? `已把 ${selectedIds.size} 条帖子放入云端队列，由 ${agents.length} 个候选 Agent 逐篇领取。`
          : agents[0]?.online
            ? `已向 ${agents[0].display_name} 下发 ${selectedIds.size} 条定向采集任务。`
            : `已创建 ${selectedIds.size} 条定向采集任务，Agent 上线后自动领取。`
      ))
      await onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建负面帖子巡查任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = !writable
    || agents.length === 0
    || agents.some(agent => agent.status !== 'active')
    || availablePlatforms.length === 0
    || submitting

  if (!supportsPatrol) {
    return (
      <div className="rounded-2xl border border-status-orange/25 bg-status-orange/8 p-4 text-sm leading-6 text-amber-700 dark:text-amber-300">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="font-semibold">部分 Extension 还不能执行负面帖子巡查</div>
            <p className="mt-1 text-xs leading-5">升级并重新加载 Extension 后，Agent 会自动上报定向逐帖采集能力。</p>
          </div>
        </div>
      </div>
    )
  }

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
          <label className="block text-xs font-medium text-muted-foreground">
            执行平台
            <select value={selectedPlatform} onChange={event => { setPlatform(event.target.value); clearPreview() }} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
              {availablePlatforms.map(value => <option key={value} value={value}>{PLATFORM_LABELS[value] || value}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            候选上限
            <input type="number" min={1} max={100} step={1} value={limit}
              onChange={event => { setLimit(Number(event.target.value)); clearPreview() }} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
          </label>
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
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">发布日期缺失的历史记录不会进入候选，也不会用采集时间代替。</p>
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
          <p className="text-[11px] leading-4 text-muted-foreground">筛选只用于圈定对象；Extension 会逐条打开原帖并补采最新详情。</p>
          <Button type="button" variant="outline" size="sm" onClick={preview} disabled={disabled || previewing} className="shrink-0">
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : previewed ? <RefreshCw className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            {previewed ? '重新筛选' : '预览候选'}
          </Button>
        </div>
      </section>

      {previewed && (
        <section className="overflow-hidden rounded-2xl border border-border bg-background">
          <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
            <div>
              <h3 className="text-sm font-bold text-foreground">确认定向采集清单</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                命中 {matchedCount} 条{limited ? `，当前展示前 ${candidates.length} 条` : ''} · 已选 {selectedIds.size} 条
              </p>
            </div>
            {candidates.length > 0 && (
              <button type="button" onClick={toggleAll}
                className="min-h-8 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {allSelected ? '取消全选' : '全选'}
              </button>
            )}
          </div>
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
                return (
                  <button key={candidate.id} type="button" onClick={() => toggleCandidate(candidate.id)}
                    className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors sm:px-5 ${selected ? 'bg-primary/[0.035]' : 'hover:bg-muted/35'}`}>
                    <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background'}`}>
                      {selected && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${platformTone(candidate.platform)}`}>
                          {PLATFORM_LABELS[candidate.platform] || candidate.platform}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{formatPublishDate(candidate)}</span>
                        <span className="text-[11px] text-muted-foreground">互动 {candidateInteraction(candidate)}</span>
                      </span>
                      <span className="mt-1.5 line-clamp-2 block text-sm font-semibold leading-5 text-foreground">
                        {candidate.title || candidate.content || '未命名帖子'}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                        {candidate.authorName || '作者未识别'}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
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

      {previewed && multiAgent && selectedIds.size > 0 && (
        <section className="rounded-2xl border border-primary/20 bg-primary/[0.035] p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Users className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-bold text-foreground">弹性领取确认</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {selectedIds.size} 条帖子保留在云端；每个空闲 Agent 一次只领 1 条，完成后再领取下一条。
              </p>
              <div className="mt-3 grid gap-2 text-[11px] leading-4 text-muted-foreground sm:grid-cols-2">
                <span className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                  候选节点 <strong className="font-semibold text-foreground">{agents.length}</strong> 个 · 当前在线 {onlineAgentCount} 个
                </span>
                <span className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                  节点离线后，未完成帖子会退回队列；旧结果不会重复写入
                </span>
                <span className="rounded-lg border border-border/70 bg-background px-2.5 py-2 sm:col-span-2">
                  验证码、登录失效等平台安全问题不会自动换账号；当前帖子保留人工处理，其他帖子继续领取
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      {error && <p role="alert" className="text-xs leading-5 text-status-red">{error}</p>}
      {feedback && <p role="status" className="text-xs leading-5 text-status-green">{feedback}</p>}

      <Button type="button" onClick={submit}
        disabled={disabled || !previewed || selectedIds.size === 0}
        className="min-h-11 w-full">
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {multiAgent
          ? `把 ${selectedIds.size || ''} 条帖子放入弹性队列`
          : agents[0]?.online
            ? `下发 ${selectedIds.size || ''} 条定向采集`
            : `创建 ${selectedIds.size || ''} 条任务并排队`}
      </Button>
    </div>
  )
}
