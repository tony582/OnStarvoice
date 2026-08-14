import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Check, Loader2, MessageSquareText, RefreshCw,
  Search, Send, Sparkles, Star, Users,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { CloudAgent } from './lib'
import { PLATFORM_LABELS, agentCreatePlatforms } from './lib'

type Candidate = {
  id: string
  platform: string
  title?: string
  content?: string
  authorName?: string
  watchedAt?: string
  sentiment?: string
}

type PreviewResponse = {
  candidates?: Candidate[]
  total?: number
  limited?: boolean
  message?: string
}

function platformTone(platform: string) {
  return platform === 'douyin'
    ? 'bg-slate-950 text-white dark:bg-slate-100 dark:text-slate-950'
    : 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300'
}

function formatDate(value?: string) {
  if (!value) return '关注时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function WatchedContentTaskCreator({
  agents,
  writable,
  initialRecordIds = [],
  onCreated,
}: {
  agents: CloudAgent[]
  writable: boolean
  initialRecordIds?: string[]
  onCreated: () => Promise<void>
}) {
  const stableInitialIds = useMemo(() => Array.from(new Set(
    initialRecordIds.map(value => String(value || '').trim()).filter(Boolean),
  )).slice(0, 100), [initialRecordIds])
  const availablePlatforms = useMemo(() => Array.from(new Set(
    agents.flatMap(agent => agentCreatePlatforms(agent)),
  )), [agents])
  const [title, setTitle] = useState('关注内容巡查')
  const [platforms, setPlatforms] = useState<string[]>(availablePlatforms)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(Math.max(stableInitialIds.length, 50))
  const [includeComments, setIncludeComments] = useState(false)
  const [includeBloggerMetrics, setIncludeBloggerMetrics] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [matchedCount, setMatchedCount] = useState(0)
  const [limited, setLimited] = useState(false)
  const [handoffMissingCount, setHandoffMissingCount] = useState(0)
  const [previewed, setPreviewed] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const loadedInitial = useRef(false)
  const pendingSubmission = useRef<{ fingerprint: string; requestKey: string } | null>(null)

  const selectedPlatforms = platforms.filter(platform => availablePlatforms.includes(platform))
  const supportsPatrol = agents.length > 0 && agents.every(agent =>
    agent.capabilities?.watchedContentPatrol === true
    && agent.capabilities?.remoteTargetedPostCaptureV1 === true,
  )
  const selectedCandidates = candidates.filter(candidate => selectedIds.has(candidate.id))
  const platformCoverage = ['xiaohongshu', 'douyin'].map(platform => ({
    platform,
    items: selectedCandidates.filter(candidate => candidate.platform === platform).length,
    agents: agents.filter(agent => agentCreatePlatforms(agent).includes(platform)).length,
  })).filter(entry => entry.items > 0)
  const missingCoverage = platformCoverage.filter(entry => entry.agents === 0)
  const allSelected = candidates.length > 0 && selectedIds.size === candidates.length
  const onlineAgentCount = agents.filter(agent => agent.online).length

  const clearPreview = () => {
    setCandidates([])
    setSelectedIds(new Set())
    setMatchedCount(0)
    setLimited(false)
    setHandoffMissingCount(0)
    setPreviewed(false)
    setFeedback('')
    pendingSubmission.current = null
  }

  const validationError = () => {
    if (agents.length === 0) return '请至少选择一个执行节点。'
    if (!supportsPatrol) return '部分节点版本尚不支持关注内容巡查，请先升级 Extension。'
    if (agents.some(agent => agent.status !== 'active')) return '已选节点中包含暂停或停用节点，请返回重新选择。'
    if (selectedPlatforms.length === 0) return '请至少选择一个执行平台。'
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return '候选上限必须是 1–100 的整数。'
    return ''
  }

  const preview = async (recordIds = stableInitialIds) => {
    setError('')
    setFeedback('')
    const validation = validationError()
    if (validation) return setError(validation)
    setPreviewing(true)
    try {
      const result = await api.post<PreviewResponse>('/capture-cloud/watched-content/candidates/preview', {
        platform: selectedPlatforms.length === 1 ? selectedPlatforms[0] : 'mixed',
        platforms: selectedPlatforms,
        query: query.trim(),
        limit,
        ...(recordIds.length > 0 ? { recordIds } : {}),
      })
      const rows = (result.candidates || []).filter(candidate => candidate?.id)
      const missingCount = recordIds.length > 0 ? Math.max(0, recordIds.length - rows.length) : 0
      setCandidates(rows)
      setSelectedIds(new Set(rows.map(candidate => candidate.id)))
      setMatchedCount(Number(result.total || rows.length))
      setLimited(result.limited === true)
      setHandoffMissingCount(missingCount)
      setPreviewed(true)
      if (missingCount > 0) {
        setError(`带入清单中有 ${missingCount} 条未被完整加载。请返回补选对应平台 Agent，或确认内容仍处于关注状态。`)
      } else {
        setFeedback(rows.length
          ? `已加载 ${rows.length} 条已关注内容。`
          : result.message || '当前条件下没有可巡查的已关注内容。')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取关注内容失败')
    } finally {
      setPreviewing(false)
    }
  }

  useEffect(() => {
    if (loadedInitial.current || stableInitialIds.length === 0) return
    loadedInitial.current = true
    void preview(stableInitialIds)
    // Initial handoff is consumed once; later filtering is explicitly user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    pendingSubmission.current = null
  }

  const submit = async () => {
    setError('')
    setFeedback('')
    const validation = validationError()
    if (validation) return setError(validation)
    if (!previewed) return setError('请先加载关注内容清单。')
    if (handoffMissingCount > 0) return setError('带入的关注内容尚未完整加载，不能创建可能漏采的任务。')
    if (selectedIds.size === 0) return setError('请至少选择一条关注内容。')
    if (missingCoverage.length > 0) {
      return setError(`已选节点未覆盖${missingCoverage.map(entry => PLATFORM_LABELS[entry.platform]).join('、')}，请返回补选对应平台 Agent。`)
    }
    const selectedItemPlatforms = Array.from(new Set(
      selectedCandidates.map(candidate => candidate.platform),
    ))
    const eligibleAgents = agents.filter(agent => selectedItemPlatforms.some(
      platform => agentCreatePlatforms(agent).includes(platform),
    ))
    const taskInput = {
      agentIds: eligibleAgents.map(agent => agent.id),
      distributionMode: 'elastic_pool',
      platform: selectedItemPlatforms.length === 1 ? selectedItemPlatforms[0] : 'mixed',
      platforms: selectedItemPlatforms,
      title: title.trim() || '关注内容巡查',
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
      const result = await api.post<{ message?: string }>('/capture-cloud/watched-content/tasks', {
        ...taskInput,
        requestKey: submission.requestKey,
      }, { timeoutMs: 30_000 })
      pendingSubmission.current = null
      setFeedback(result.message || `已把 ${selectedIds.size} 条关注内容放入云端队列。`)
      await onCreated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建关注内容巡查失败')
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = !writable || agents.length === 0 || !supportsPatrol || submitting
  if (!supportsPatrol) {
    return (
      <div className="rounded-2xl border border-status-orange/25 bg-status-orange/8 p-4 text-sm leading-6 text-amber-700 dark:text-amber-300">
        <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div><div className="font-semibold">部分 Extension 还不能执行关注内容巡查</div>
            <p className="mt-1 text-xs leading-5">升级并重新加载后，Agent 会上报关注内容逐帖采集能力。</p></div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-background">
        <div className="border-l-4 border-l-primary px-4 py-4 sm:px-5">
          <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Star className="h-5 w-5" /></span>
            <div><h3 className="text-sm font-bold">选择已关注内容</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">只读取人工关注且仍能定位到原帖的内容；支持一张清单同时包含小红书和抖音。</p></div>
          </div>
        </div>
        <div className="grid gap-4 border-t border-border/70 p-4 sm:grid-cols-2 sm:p-5">
          <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">任务名称
            <input value={title} onChange={event => setTitle(event.target.value)} disabled={disabled} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" />
          </label>
          <fieldset className="text-xs font-medium text-muted-foreground"><legend>内容平台</legend>
            <div className="mt-1.5 grid h-10 grid-cols-2 gap-1 rounded-lg bg-muted p-0.5">
              {availablePlatforms.map(value => {
                const checked = selectedPlatforms.includes(value)
                return <button key={value} type="button" aria-pressed={checked} disabled={disabled} onClick={() => { setPlatforms(current => checked ? current.filter(item => item !== value) : [...current, value]); clearPreview() }} className={`rounded-md px-2 text-xs font-semibold ${checked ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'}`}>{PLATFORM_LABELS[value]}</button>
              })}
            </div>
          </fieldset>
          <label className="block text-xs font-medium text-muted-foreground">候选上限
            <input type="number" min={1} max={100} value={limit} onChange={event => { setLimit(Number(event.target.value)); clearPreview() }} disabled={disabled} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" />
          </label>
          <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">内容关键词（可选）
            <input value={query} onChange={event => { setQuery(event.target.value); clearPreview() }} placeholder="标题、正文、作者或采集关键词" disabled={disabled} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary" />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/25 px-4 py-3 sm:px-5">
          <p className="text-[11px] text-muted-foreground">任务创建时会再次校验关注状态，已取消关注的内容不会执行。</p>
          <Button variant="outline" size="sm" onClick={() => preview(stableInitialIds)} disabled={disabled || previewing}>{previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : previewed ? <RefreshCw className="h-4 w-4" /> : <Search className="h-4 w-4" />}{previewed ? '重新加载' : '加载清单'}</Button>
        </div>
      </section>

      {previewed && <section className="overflow-hidden rounded-2xl border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3 sm:px-5"><div><h3 className="text-sm font-bold">确认巡查清单</h3><p className="mt-0.5 text-[11px] text-muted-foreground">命中 {matchedCount} 条{limited ? `，展示前 ${candidates.length} 条` : ''} · 已选 {selectedIds.size} 条</p></div>
          {candidates.length > 0 && <button type="button" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(candidates.map(item => item.id)))} className="min-h-8 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-primary/8">{allSelected ? '取消全选' : '全选'}</button>}
        </div>
        {candidates.length === 0 ? <div className="px-5 py-10 text-center"><Sparkles className="mx-auto h-7 w-7 text-muted-foreground/50" /><div className="mt-3 text-sm font-semibold">没有可巡查的已关注内容</div></div>
          : <div className="max-h-[420px] divide-y divide-border/70 overflow-y-auto">{candidates.map(candidate => { const selected = selectedIds.has(candidate.id); return <button key={candidate.id} type="button" onClick={() => toggle(candidate.id)} className={`flex w-full items-start gap-3 px-4 py-3.5 text-left sm:px-5 ${selected ? 'bg-primary/[0.035]' : 'hover:bg-muted/35'}`}><span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>{selected && <Check className="h-3.5 w-3.5" />}</span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-1.5"><span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${platformTone(candidate.platform)}`}>{PLATFORM_LABELS[candidate.platform]}</span><span className="text-[11px] text-muted-foreground">关注于 {formatDate(candidate.watchedAt)}</span></span><span className="mt-1.5 line-clamp-2 block text-sm font-semibold leading-5">{candidate.title || candidate.content || '未命名内容'}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{candidate.authorName || '作者未识别'}</span></span></button> })}</div>}
      </section>}

      {previewed && candidates.length > 0 && <section className="rounded-2xl border border-primary/15 bg-primary/[0.025] p-4 sm:p-5"><h3 className="text-sm font-bold">补采内容</h3><p className="mt-1 text-xs text-muted-foreground">正文与最新互动数据始终同步；以下信息会增加单帖耗时。</p><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="flex min-h-11 items-center gap-2.5 rounded-xl border border-border/70 bg-background px-3"><input type="checkbox" checked={includeComments} onChange={event => setIncludeComments(event.target.checked)} className="h-4 w-4 accent-primary" /><MessageSquareText className="h-4 w-4 text-muted-foreground" /><span className="text-xs font-medium">附加评论</span></label><label className="flex min-h-11 items-center gap-2.5 rounded-xl border border-border/70 bg-background px-3"><input type="checkbox" checked={includeBloggerMetrics} onChange={event => setIncludeBloggerMetrics(event.target.checked)} className="h-4 w-4 accent-primary" /><Sparkles className="h-4 w-4 text-muted-foreground" /><span className="text-xs font-medium">补充博主数据</span></label></div></section>}

      {previewed && selectedIds.size > 0 && <section className="rounded-2xl border border-primary/20 bg-primary/[0.035] p-4 sm:p-5"><div className="flex items-start gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><Users className="h-4 w-4" /></span><div className="flex-1"><h3 className="text-sm font-bold">平台覆盖与弹性领取</h3><p className="mt-1 text-xs text-muted-foreground">每个 Agent 只会领取自己负责平台的内容；安全验证保留人工处理，不自动换账号。</p><div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">{platformCoverage.map(entry => <span key={entry.platform} className={`rounded-lg border bg-background px-2.5 py-2 ${entry.agents > 0 ? 'border-border/70' : 'border-status-red/35 text-status-red'}`}>{PLATFORM_LABELS[entry.platform]}：{entry.items} 条 · 可用 Agent {entry.agents} 个</span>)}<span className="rounded-lg border border-border/70 bg-background px-2.5 py-2">候选 Agent {agents.length} 个 · 在线 {onlineAgentCount} 个</span></div></div></div></section>}

      {error && <p role="alert" className="text-xs leading-5 text-status-red">{error}</p>}
      {feedback && <p role="status" className="text-xs leading-5 text-status-green">{feedback}</p>}
      <Button onClick={submit} disabled={disabled || !previewed || handoffMissingCount > 0 || selectedIds.size === 0 || missingCoverage.length > 0} className="min-h-11 w-full">{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}把 {selectedIds.size || ''} 条关注内容放入弹性队列</Button>
    </div>
  )
}
