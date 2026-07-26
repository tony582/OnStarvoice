import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarDays, Check, Loader2, MessageCircle,
  RefreshCw, Search, Send, ShieldCheck,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { CloudAgent } from './lib'
import { PLATFORM_LABELS, agentCreatePlatforms } from './lib'

type OfficialAccount = {
  id: string
  platform: string
  accountName?: string
  name?: string
  profileUrl?: string
}

type PatrolCandidate = {
  id: string
  platform?: string
  title?: string
  content?: string
  url?: string
  publishTime?: string
  publishedAt?: string
  commentsCount?: number
  comments_count?: number
}

type AccountResponse = {
  accounts?: OfficialAccount[]
  items?: OfficialAccount[]
  data?: { accounts?: OfficialAccount[]; items?: OfficialAccount[] }
}

type PreviewResponse = {
  candidates?: PatrolCandidate[]
  posts?: PatrolCandidate[]
  records?: PatrolCandidate[]
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

function formatDate(value?: string) {
  if (!value) return '发布时间缺失'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function accountLabel(account?: OfficialAccount) {
  return account?.accountName || account?.name || '未命名官方账号'
}

export function OfficialCommentPatrolTaskCreator({
  agent,
  writable,
  onCreated,
}: {
  agent: CloudAgent
  writable: boolean
  onCreated: () => Promise<void>
}) {
  const initialRange = useMemo(() => initialDateRange(), [])
  const [accounts, setAccounts] = useState<OfficialAccount[]>([])
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [accountError, setAccountError] = useState('')
  const [accountId, setAccountId] = useState('')
  const [publishDateFrom, setPublishDateFrom] = useState(initialRange.from)
  const [publishDateTo, setPublishDateTo] = useState(initialRange.to)
  const [postsLimit, setPostsLimit] = useState(20)
  const [commentsLimit, setCommentsLimit] = useState(50)
  const [candidates, setCandidates] = useState<PatrolCandidate[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [matchedCount, setMatchedCount] = useState(0)
  const [limited, setLimited] = useState(false)
  const [previewed, setPreviewed] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const pendingSubmission = useRef<{ fingerprint: string; requestKey: string } | null>(null)
  const availablePlatforms = useMemo(() => agentCreatePlatforms(agent), [agent])
  const selectedAccount = accounts.find(account => account.id === accountId)
  const selectedPlatform = String(selectedAccount?.platform || '').trim()
  const platformCompatible = Boolean(selectedPlatform && availablePlatforms.includes(selectedPlatform))
  const commentPatrolSupported = agent.capabilities?.officialAccountCommentPatrol === true
  const compatible = platformCompatible && commentPatrolSupported
  const allSelected = candidates.length > 0 && selectedIds.size === candidates.length

  const loadAccounts = async () => {
    setAccountsLoading(true)
    setAccountError('')
    try {
      const response = await api.get<AccountResponse>('/capture-cloud/official-comment-patrol/accounts?range=7d')
      const rows = response.accounts || response.items || response.data?.accounts || response.data?.items || []
      const normalized = rows
        .filter(item => item && typeof item.id === 'string' && String(item.platform || '').trim())
        .map(item => ({ ...item, platform: String(item.platform).trim() }))
      setAccounts(normalized)
      setAccountId(current => normalized.some(item => item.id === current) ? current : normalized[0]?.id || '')
    } catch (requestError) {
      setAccounts([])
      setAccountError(requestError instanceof Error ? requestError.message : '读取官方账号失败')
    } finally {
      setAccountsLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void loadAccounts()
    })
    return () => { active = false }
  }, [])

  const clearPreview = () => {
    setCandidates([])
    setSelectedIds(new Set())
    setMatchedCount(0)
    setLimited(false)
    setPreviewed(false)
    setFeedback('')
    pendingSubmission.current = null
  }

  const validate = () => {
    if (!selectedAccount) return '请先选择一个官方账号。'
    if (!platformCompatible) return `当前 Agent 不负责${PLATFORM_LABELS[selectedPlatform] || selectedPlatform}，请返回选择兼容节点。`
    if (!commentPatrolSupported) return '当前 Agent 的扩展版本不支持官方账号评论巡查，请升级扩展后再创建任务。'
    if (!publishDateFrom || !publishDateTo) return '发布时间范围不能为空。'
    if (publishDateFrom > publishDateTo) return '发布时间开始日期不能晚于结束日期。'
    const span = Math.round((Date.parse(`${publishDateTo}T00:00:00`) - Date.parse(`${publishDateFrom}T00:00:00`)) / 86400000)
    if (!Number.isFinite(span) || span > 29) return '单次巡查最多覆盖连续 30 天，请缩小发布时间范围。'
    if (!Number.isSafeInteger(postsLimit) || postsLimit < 1 || postsLimit > 20) return '作品上限必须是 1–20 的整数。'
    if (!Number.isSafeInteger(commentsLimit) || commentsLimit < 1 || commentsLimit > 100) return '每篇评论上限必须是 1–100 的整数。'
    return ''
  }

  const preview = async () => {
    setError('')
    setFeedback('')
    const validationError = validate()
    if (validationError) return setError(validationError)
    setPreviewing(true)
    try {
      const response = await api.post<PreviewResponse>('/capture-cloud/official-comment-patrol/candidates/preview', {
        officialAccountId: selectedAccount?.id,
        platform: selectedPlatform,
        publishDateFrom,
        publishDateTo,
        postsLimit,
        commentsLimit,
      })
      const rows = (response.candidates || response.posts || response.records || [])
        .filter(item => item && typeof item.id === 'string')
      setCandidates(rows)
      setSelectedIds(new Set(rows.map(item => item.id)))
      setMatchedCount(safeCount(response.total ?? response.matchedCount ?? rows.length))
      setLimited(response.limited === true)
      setPreviewed(true)
      setFeedback(rows.length > 0
        ? `已圈定 ${response.total ?? response.matchedCount ?? rows.length} 篇可巡查作品。`
        : response.message || '该时间范围内没有已发现且可定位的作品。')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '预览巡查作品失败')
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

  const submit = async () => {
    setError('')
    setFeedback('')
    const validationError = validate()
    if (validationError) return setError(validationError)
    if (!previewed) return setError('请先预览作品范围，再确认创建任务。')
    if (selectedIds.size === 0) return setError('请至少选择一篇需要巡查的作品。')

    const taskInput = {
      officialAccountId: selectedAccount?.id,
      platform: selectedPlatform,
      publishDateFrom,
      publishDateTo,
      postsLimit,
      commentsLimit,
      recordIds: Array.from(selectedIds),
      agentId: agent.id,
      title: `${accountLabel(selectedAccount)}评论巡查`,
    }
    const fingerprint = JSON.stringify(taskInput)
    let submission = pendingSubmission.current
    if (submission?.fingerprint !== fingerprint) {
      submission = { fingerprint, requestKey: window.crypto.randomUUID() }
      pendingSubmission.current = submission
    }

    setSubmitting(true)
    try {
      const result = await api.post<{ message?: string }>('/capture-cloud/official-comment-patrol/tasks', {
        ...taskInput,
        requestKey: submission.requestKey,
      }, { timeoutMs: 30_000 })
      pendingSubmission.current = null
      setFeedback(result.message || (agent.online
        ? `已向 ${agent.display_name} 下发 ${selectedIds.size} 篇作品的评论巡查。`
        : `已创建 ${selectedIds.size} 篇作品的评论巡查，Agent 上线后自动领取。`))
      await onCreated()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '创建评论巡查任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = !writable || agent.status !== 'active' || submitting || accountsLoading

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-background">
        <div className="border-l-4 border-l-primary px-4 py-4 sm:px-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><MessageCircle className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground">先圈定官方账号近期作品</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">只巡查已发现、带有效发布时间和原帖链接的作品；评论结果是本次可见样本，不承诺全量。</p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-t border-border/70 p-4 sm:grid-cols-2 sm:p-5">
          <label className="block text-xs font-medium text-muted-foreground sm:col-span-2">
            官方账号 <span className="text-status-red">*</span>
            <select value={accountId} onChange={event => { setAccountId(event.target.value); clearPreview() }} disabled={disabled || accounts.length === 0}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60">
              {accounts.length === 0 ? <option value="">暂无可巡查官方账号</option> : accounts.map(account => (
                <option key={account.id} value={account.id}>{PLATFORM_LABELS[account.platform] || account.platform} · {accountLabel(account)}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            本次最多巡查作品
            <input type="number" min={1} max={20} step={1} value={postsLimit}
              onChange={event => { setPostsLimit(Number(event.target.value)); clearPreview() }} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            每篇最多读取评论
            <input type="number" min={1} max={100} step={1} value={commentsLimit}
              onChange={event => { setCommentsLimit(Number(event.target.value)); clearPreview() }} disabled={disabled}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
          </label>
          <div className="sm:col-span-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-foreground"><CalendarDays className="h-3.5 w-3.5 text-primary" />发布时间范围 <span className="text-status-red">*</span></div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <input type="date" value={publishDateFrom} onChange={event => { setPublishDateFrom(event.target.value); clearPreview() }} disabled={disabled} aria-label="发布时间开始日期"
                className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
              <span className="text-xs text-muted-foreground">至</span>
              <input type="date" value={publishDateTo} onChange={event => { setPublishDateTo(event.target.value); clearPreview() }} disabled={disabled} aria-label="发布时间结束日期"
                className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60" />
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">默认近 7 天，单次最多连续 30 天；发布时间未知的作品不会被自动纳入。</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/25 px-4 py-3 sm:px-5">
          <p className={`text-[11px] leading-4 ${selectedPlatform && !compatible ? 'text-status-red' : 'text-muted-foreground'}`}>{selectedPlatform
            ? !platformCompatible
              ? `${PLATFORM_LABELS[selectedPlatform] || selectedPlatform} · 当前节点不兼容`
              : !commentPatrolSupported
                ? '当前扩展版本不支持评论巡查，请升级扩展后再创建。'
                : `${PLATFORM_LABELS[selectedPlatform] || selectedPlatform} · 当前节点可执行`
            : '请选择账号后继续'}</p>
          <Button type="button" variant="outline" size="sm" onClick={preview} disabled={disabled || previewing || !selectedAccount || !compatible} className="shrink-0">
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : previewed ? <RefreshCw className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            {previewed ? '重新预览' : '预览作品'}
          </Button>
        </div>
      </section>

      {accountsLoading && <div className="flex items-center justify-center gap-2 py-5 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取可巡查官方账号</div>}
      {accountError && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-xs leading-5 text-status-red"><div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{accountError}</span></div><Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => void loadAccounts()}>重新读取</Button></div>}

      {previewed && (
        <section className="overflow-hidden rounded-2xl border border-border bg-background">
          <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
            <div><h3 className="text-sm font-bold text-foreground">确认巡查清单</h3><p className="mt-0.5 text-[11px] text-muted-foreground">候选 {matchedCount} 篇{limited ? `，当前展示前 ${candidates.length} 篇` : ''} · 已选 {selectedIds.size} 篇</p></div>
            {candidates.length > 0 && <button type="button" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(candidates.map(item => item.id)))} className="min-h-8 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{allSelected ? '取消全选' : '全选'}</button>}
          </div>
          {candidates.length === 0 ? (
            <div className="px-5 py-10 text-center"><ShieldCheck className="mx-auto h-7 w-7 text-muted-foreground/50" /><div className="mt-3 text-sm font-semibold">没有可巡查作品</div><p className="mt-1 text-xs leading-5 text-muted-foreground">请先在关注博主中完成账号作品发现，或调整发布时间范围。</p></div>
          ) : (
            <div className="max-h-[420px] divide-y divide-border/70 overflow-y-auto overscroll-contain">
              {candidates.map(candidate => {
                const selected = selectedIds.has(candidate.id)
                return <button key={candidate.id} type="button" onClick={() => toggleCandidate(candidate.id)} className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors sm:px-5 ${selected ? 'bg-primary/[0.035]' : 'hover:bg-muted/35'}`}>
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background'}`}>{selected && <Check className="h-3.5 w-3.5" />}</span>
                  <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"><span>{formatDate(candidate.publishedAt || candidate.publishTime)}</span><span>已有评论 {safeCount(candidate.commentsCount ?? candidate.comments_count)} 条</span></span><span className="mt-1.5 block line-clamp-2 text-sm font-semibold leading-5 text-foreground">{candidate.title || candidate.content || '未命名作品'}</span></span>
                </button>
              })}
            </div>
          )}
        </section>
      )}

      {error && <p role="alert" className="text-xs leading-5 text-status-red">{error}</p>}
      {feedback && <p role="status" className="text-xs leading-5 text-status-green">{feedback}</p>}

      <Button type="button" onClick={submit} disabled={disabled || !previewed || selectedIds.size === 0 || !compatible} className="min-h-11 w-full">
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {agent.online ? `下发 ${selectedIds.size || ''} 篇作品的评论巡查` : `创建 ${selectedIds.size || ''} 篇作品的评论巡查并排队`}
      </Button>
    </div>
  )
}
