import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, ExternalLink,
  FileText, FileWarning, Loader2, RefreshCw, Search, User,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'
import { cn, formatFullDate, formatNumber, identityLabel, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge, StatusPill } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import {
  WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar,
} from '@/components/shared/Workbench'

type FeedbackStatus = '' | 'pending' | 'reviewed' | 'summarized'
type ReviewAction = 'reviewed' | 'summarized'
type JsonMap = Record<string, unknown>

interface FeedbackItem {
  id: string
  feedback_type?: string
  review_status?: string
  reason?: string
  record_title?: string
  record_content?: string
  record_platform?: string
  record_author_name?: string
  record_url?: string
  title?: string
  content?: string
  platform?: string
  author_name?: string
  url?: string
  current_sentiment?: string
  current_category?: string
  current_identity_override?: string
  current_publish_time?: string
  original_values?: unknown
  corrected_values?: unknown
  ai_snapshot?: unknown
  record_snapshot?: unknown
  submitted_by_name?: string
  submitted_at?: string
  reviewed_by_name?: string
  reviewed_at?: string
  review_note?: string
  [key: string]: unknown
}

interface FeedbackResponse {
  feedback?: FeedbackItem[]
  items?: FeedbackItem[]
  pagination?: unknown
  counts?: unknown
}

interface Pagination {
  page: number
  totalPages: number
  total: number
}

interface FeedbackCounts {
  pending: number
  reviewed: number
  summarized: number
  dismissed: number
  total: number
}

const EMPTY_COUNTS: FeedbackCounts = {
  pending: 0,
  reviewed: 0,
  summarized: 0,
  dismissed: 0,
  total: 0,
}

const STATUS_TABS: Array<{ key: FeedbackStatus; label: string }> = [
  { key: 'pending', label: '待复核' },
  { key: 'reviewed', label: '已复核' },
  { key: 'summarized', label: '已记录' },
  { key: '', label: '全部' },
]

const TYPE_LABELS: Record<string, string> = {
  false_positive: '误报',
  manual_correction: '人工纠正',
}

const REVIEW_LABELS: Record<string, string> = {
  pending: '待复核',
  reviewed: '已复核',
  summarized: '已记录',
  dismissed: '已忽略',
}

const REVIEW_TONES: Record<string, string> = {
  pending: 'reviewing',
  reviewed: 'positive',
  summarized: 'issue_linked',
  dismissed: 'muted',
}

const FIELD_LABELS: Record<string, string> = {
  sentiment: '情感',
  category: '分类',
  identity: '身份',
  identity_override: '身份',
  identityOverride: '身份',
  source_type: '身份',
  sourceType: '身份',
  triage_status: '处置状态',
  triage_note: '处置备注',
  publish_date: '发布日期',
  publishDate: '发布日期',
  publish_time: '发布日期',
  publishTime: '发布日期',
  published_ts: '发布日期',
  publishedTs: '发布日期',
}

const IDENTITY_LABELS: Record<string, string> = {
  user: '用户',
  ugc: '用户',
  kol: 'KOL / KOC',
  pgc: 'KOL / KOC',
  koe: 'KOE',
  employee: 'KOE',
  dealer: '4S店',
  other: '其他',
}

export function MisjudgmentQueue() {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const { ask, dialog } = useNotePrompt()
  const requestSeq = useRef(0)
  const [status, setStatus] = useState<FeedbackStatus>('pending')
  const [type, setType] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [counts, setCounts] = useState<FeedbackCounts>(EMPTY_COUNTS)
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(keywordInput.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [keywordInput])

  const filterParams = useCallback(() => {
    return new URLSearchParams({ status, type, keyword })
  }, [status, type, keyword])

  const load = useCallback(async (page = 1) => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError('')
    try {
      const params = filterParams()
      params.set('page', String(page))
      params.set('pageSize', '30')
      const data = await api.get<FeedbackResponse>('/feedback?' + params.toString())
      if (seq !== requestSeq.current) return
      setItems(data.feedback || data.items || [])
      setCounts(normalizeCounts(data.counts))
      setPagination(normalizePagination(data.pagination))
    } catch (err) {
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : '加载失败')
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [filterParams])

  useEffect(() => { load(1) }, [load]) // eslint-disable-line react-hooks/set-state-in-effect

  const exportXlsx = async () => {
    setExporting(true)
    setError('')
    try {
      await api.download('/feedback/export?' + filterParams().toString(), '误判反馈.xlsx')
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const updateStatus = async (item: FeedbackItem, nextStatus: ReviewAction) => {
    const actionLabel = nextStatus === 'reviewed' ? '标为已复核' : '保存记录'
    const note = await ask({
      title: actionLabel,
      placeholder: nextStatus === 'reviewed'
        ? '可填写复核结论、补充说明'
        : '请填写本次复核结论或内部备注',
      confirmLabel: actionLabel,
      required: nextStatus === 'summarized',
      requiredMessage: '请填写记录内容后再确认',
      helpText: nextStatus === 'summarized'
        ? '必填。仅保存为内部复核记录，不会发送给 AI，也不会触发模型学习。'
        : '选填。可记录复核结论或补充说明。',
    })
    if (note === null) return

    const actionKey = `${item.id}:${nextStatus}`
    setBusyAction(actionKey)
    setError('')
    try {
      await api.patch('/feedback/' + item.id, { status: nextStatus, reviewNote: note })
      const page = pagination?.page || 1
      const willEmpty = items.length <= 1 && page > 1 && status !== ''
      await load(willEmpty ? page - 1 : page)
      refreshBadges()
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败')
    } finally {
      setBusyAction('')
    }
  }

  const tabs = STATUS_TABS.map(tab => ({
    key: tab.key,
    label: tab.label,
    count: tab.key ? counts[tab.key] : counts.total,
  }))

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">
        平台管理员集中复核客户提交的误报和人工纠正；所有结论仅作为内部记录，不会发送给 AI，也不会触发模型学习。
      </p>

      <WorkbenchTabs tabs={tabs} activeKey={status} onChange={key => setStatus(key as FeedbackStatus)} />

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? items.length)} 条反馈`}>
        <WorkbenchSelect
          value={type}
          onChange={e => setType(e.target.value)}
          className={cn('min-w-32 flex-1 bg-muted font-medium hover:bg-muted/70 sm:w-auto sm:flex-none', type ? 'text-foreground' : 'text-muted-foreground')}
        >
          <option value="">全部类型</option>
          <option value="false_positive">误报</option>
          <option value="manual_correction">人工纠正</option>
        </WorkbenchSelect>
        <div className="order-first relative w-full sm:order-none sm:w-56">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keywordInput}
            onChange={e => setKeywordInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const next = keywordInput.trim()
                if (next === keyword) load(1)
                else setKeyword(next)
              }
            }}
            placeholder="搜索内容、作者、原因…"
            className="h-8 border-transparent bg-muted pl-8 text-[12px] focus:bg-card"
          />
        </div>
        <Button variant="outline" size="sm" onClick={exportXlsx} disabled={exporting}>
          <Download className={cn('h-3.5 w-3.5', exporting && 'animate-pulse')} />
          {exporting ? '导出中…' : '导出'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => load(pagination?.page || 1)} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />刷新
        </Button>
      </WorkbenchToolbar>

      {error && items.length > 0 && (
        <div className="rounded-lg bg-status-red/10 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error && items.length === 0 ? (
        <EmptyState icon={FileWarning} title="加载失败" description={error} />
      ) : items.length === 0 ? (
        <EmptyState icon={FileWarning} title="暂无反馈" description="当前筛选条件下没有需要查看的误判反馈" />
      ) : (
        <>
          <div className="space-y-3 lg:hidden">
            {items.map(item => (
              <MobileFeedbackCard
                key={item.id}
                item={item}
                canWrite={canWrite()}
                busyAction={busyAction}
                onUpdate={updateStatus}
              />
            ))}
          </div>

          <WorkbenchTableShell className="hidden lg:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] text-sm">
                <thead>
                  <tr className="border-b border-border/60 [&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:py-3 [&>th]:text-left [&>th]:text-[11px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-muted-foreground">
                    <th className="pl-4">类型</th>
                    <th>内容</th>
                    <th>原因 / 判断变化</th>
                    <th>提交人 / 时间</th>
                    <th>复核状态 / 备注</th>
                    {canWrite() && <th className="pr-4 text-right">操作</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {items.map(item => (
                    <FeedbackRow
                      key={item.id}
                      item={item}
                      canWrite={canWrite()}
                      busyAction={busyAction}
                      onUpdate={updateStatus}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </WorkbenchTableShell>
        </>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">共 {formatNumber(pagination.total)} 条</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-3 text-sm tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {dialog}
    </div>
  )
}

function MobileFeedbackCard({
  item,
  canWrite,
  busyAction,
  onUpdate,
}: {
  item: FeedbackItem
  canWrite: boolean
  busyAction: string
  onUpdate: (item: FeedbackItem, status: ReviewAction) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const record = recordFields(item)
  const changes = beforeAfterRows(item)
  const reviewStatus = String(item.review_status || item.status || 'pending')
  const type = String(item.feedback_type || item.type || 'false_positive')
  const reviewedBusy = busyAction === `${item.id}:reviewed`
  const summarizedBusy = busyAction === `${item.id}:summarized`
  const primaryChange = changes[0]

  return (
    <article className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-[0_8px_28px_rgba(15,23,42,0.06)]">
      <div className={cn('h-1', type === 'false_positive' ? 'bg-status-red' : 'bg-status-blue')} />

      <div className="space-y-4 px-4 pb-4 pt-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusPill tone={type === 'false_positive' ? 'negative' : 'issue_linked'}>
              {TYPE_LABELS[type] || type}
            </StatusPill>
            <StatusPill tone={REVIEW_TONES[reviewStatus] || 'muted'}>
              {REVIEW_LABELS[reviewStatus] || reviewStatus}
            </StatusPill>
          </div>
          <span className="shrink-0 pt-0.5 text-[10.5px] tabular-nums text-muted-foreground">
            {formatFullDate(item.submitted_at as string)}
          </span>
        </div>

        <div>
          <h3 className="line-clamp-2 text-[15px] font-semibold leading-6 text-foreground">
            {record.title || record.content || '(无内容)'}
          </h3>
          {record.title && record.content && record.content !== record.title && (
            <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">{record.content}</p>
          )}
        </div>

        {primaryChange && (
          <section className="relative overflow-hidden rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3">
            <div className={cn('absolute inset-y-0 left-0 w-1', type === 'false_positive' ? 'bg-status-red' : 'bg-status-blue')} />
            <div className="pl-1.5">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">AI 原判断 · {primaryChange.label}</div>
              <div className="mt-1 break-words text-[13px] leading-5 text-foreground">{primaryChange.before}</div>
              <div className="my-1.5 flex items-center gap-2 text-[10.5px] font-medium text-muted-foreground">
                <ArrowDown className="h-3.5 w-3.5" />
                人工复核后
              </div>
              <div className={cn(
                'break-words text-[14px] font-semibold leading-5',
                type === 'false_positive' ? 'text-rose-700 dark:text-rose-300' : 'text-primary',
              )}>
                {primaryChange.after}
              </div>
            </div>
          </section>
        )}

        <div className="space-y-1.5">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">反馈原因</div>
          <p className={cn('text-[12.5px] leading-5 text-foreground', expanded ? '' : 'line-clamp-2')}>
            {item.reason || '未填写原因'}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">提交：{item.submitted_by_name || '未知'}</span>
          <span className="shrink-0">{item.review_note ? '已有复核备注' : '暂无复核备注'}</span>
        </div>

        {expanded && (
          <div className="space-y-4 border-t border-dashed border-border/70 pt-4">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <StatusBadge tone="neutral">{platformName(record.platform)}</StatusBadge>
              <span className="inline-flex min-w-0 items-center gap-1">
                <User className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-48 truncate">{record.author || '未知作者'}</span>
              </span>
              {record.url && (
                <a
                  href={record.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 font-semibold text-primary hover:bg-primary/8"
                >
                  查看原文<ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>

            {changes.length > 1 && (
              <section>
                <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">全部判断变化</div>
                <div className="space-y-2">
                  {changes.map((change, index) => (
                    <div key={`${change.label}-${index}`} className="rounded-xl bg-muted/35 px-3 py-2.5">
                      <div className="text-[11px] font-semibold text-muted-foreground">{change.label}</div>
                      <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-start gap-2 text-[11.5px] leading-5">
                        <span className="min-w-0 break-words text-muted-foreground">{change.before}</span>
                        <span className="text-muted-foreground/60">→</span>
                        <span className="min-w-0 break-words font-medium text-primary">{change.after}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="rounded-xl bg-muted/25 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold text-muted-foreground">复核记录</span>
                <StatusPill tone={REVIEW_TONES[reviewStatus] || 'muted'}>
                  {REVIEW_LABELS[reviewStatus] || reviewStatus}
                </StatusPill>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-foreground">
                {item.review_note || '暂无复核备注'}
              </p>
              {(item.reviewed_by_name || item.reviewed_at) && (
                <p className="mt-1.5 text-[10.5px] text-muted-foreground">
                  {item.reviewed_by_name || '后台人员'}{item.reviewed_at ? ` · ${formatFullDate(item.reviewed_at as string)}` : ''}
                </p>
              )}
            </section>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 border-t border-border/50 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="col-span-2 justify-between bg-muted/35 px-3 text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}
          >
            {expanded ? '收起详情' : '查看详情'}
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>

          {canWrite && reviewStatus === 'pending' && (
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busyAction)}
              onClick={() => onUpdate(item, 'reviewed')}
            >
              {reviewedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              标为已复核
            </Button>
          )}
          {canWrite && reviewStatus !== 'summarized' && reviewStatus !== 'dismissed' && (
            <Button
              variant={reviewStatus === 'reviewed' ? 'default' : 'outline'}
              size="sm"
              className={cn(reviewStatus !== 'pending' && 'col-span-2')}
              disabled={Boolean(busyAction)}
              onClick={() => onUpdate(item, 'summarized')}
            >
              {summarizedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
              保存记录
            </Button>
          )}
          {canWrite && (reviewStatus === 'summarized' || reviewStatus === 'dismissed') && (
            <div className="col-span-2 py-2 text-center text-[11px] font-medium text-muted-foreground">本条反馈已完成</div>
          )}
        </div>
      </div>
    </article>
  )
}

function FeedbackRow({
  item,
  canWrite,
  busyAction,
  onUpdate,
}: {
  item: FeedbackItem
  canWrite: boolean
  busyAction: string
  onUpdate: (item: FeedbackItem, status: ReviewAction) => void
}) {
  const record = recordFields(item)
  const changes = beforeAfterRows(item)
  const reviewStatus = String(item.review_status || item.status || 'pending')
  const type = String(item.feedback_type || item.type || 'false_positive')
  const reviewedBusy = busyAction === `${item.id}:reviewed`
  const summarizedBusy = busyAction === `${item.id}:summarized`

  return (
    <tr className="align-top transition-colors hover:bg-accent/45">
      <td className="pl-4 pr-3 py-3.5">
        <StatusPill tone={type === 'false_positive' ? 'negative' : 'issue_linked'}>
          {TYPE_LABELS[type] || type}
        </StatusPill>
      </td>
      <td className="max-w-[330px] px-3 py-3.5">
        <div className="line-clamp-2 text-[13px] font-medium leading-5 text-foreground">
          {record.title || record.content || '(无内容)'}
        </div>
        {record.title && record.content && record.content !== record.title && (
          <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{record.content}</div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <StatusBadge tone="neutral">{platformName(record.platform)}</StatusBadge>
          <span className="inline-flex min-w-0 items-center gap-1">
            <User className="h-3 w-3 shrink-0" />
            <span className="max-w-28 truncate">{record.author || '未知作者'}</span>
          </span>
          {record.url && (
            <a href={record.url} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-semibold text-primary hover:underline">
              原文<ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </td>
      <td className="max-w-[390px] px-3 py-3.5">
        <div className="line-clamp-2 text-[12px] leading-5 text-foreground">{item.reason || '—'}</div>
        <div className="mt-1.5 space-y-1">
          {changes.map((change, index) => (
            <div key={`${change.label}-${index}`} className="flex min-w-0 items-center gap-1 text-[11px] leading-5">
              <span className="shrink-0 text-muted-foreground">{change.label}</span>
              <span className="max-w-[125px] truncate rounded bg-muted px-1.5 text-muted-foreground" title={change.before}>{change.before}</span>
              <span className="shrink-0 text-muted-foreground/60">→</span>
              <span className="max-w-[125px] truncate rounded bg-primary/8 px-1.5 font-medium text-primary" title={change.after}>{change.after}</span>
            </div>
          ))}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3.5 text-[11px] text-muted-foreground">
        <div className="font-medium text-foreground">{item.submitted_by_name || '未知'}</div>
        <div className="mt-0.5">{formatFullDate(item.submitted_at as string)}</div>
      </td>
      <td className="max-w-[260px] px-3 py-3.5">
        <StatusPill tone={REVIEW_TONES[reviewStatus] || 'muted'}>{REVIEW_LABELS[reviewStatus] || reviewStatus}</StatusPill>
        {item.review_note ? (
          <div className="mt-1.5 line-clamp-2 text-[11px] leading-5 text-foreground">{item.review_note}</div>
        ) : (
          <div className="mt-1.5 text-[11px] text-muted-foreground/60">暂无复核备注</div>
        )}
        {(item.reviewed_by_name || item.reviewed_at) && (
          <div className="mt-0.5 text-[10.5px] text-muted-foreground">
            {item.reviewed_by_name || '后台人员'}{item.reviewed_at ? ` · ${formatFullDate(item.reviewed_at as string)}` : ''}
          </div>
        )}
      </td>
      {canWrite && (
        <td className="px-3 py-3.5 pr-4">
          <div className="flex justify-end gap-1">
            {reviewStatus === 'pending' && (
              <Button variant="outline" size="sm" disabled={Boolean(busyAction)} onClick={() => onUpdate(item, 'reviewed')}>
                {reviewedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                已复核
              </Button>
            )}
            {reviewStatus !== 'summarized' && reviewStatus !== 'dismissed' && (
              <Button variant={reviewStatus === 'reviewed' ? 'default' : 'outline'} size="sm" disabled={Boolean(busyAction)} onClick={() => onUpdate(item, 'summarized')}>
                {summarizedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                保存记录
              </Button>
            )}
            {(reviewStatus === 'summarized' || reviewStatus === 'dismissed') && (
              <span className="py-1.5 text-[11px] text-muted-foreground/60">已完成</span>
            )}
          </div>
        </td>
      )}
    </tr>
  )
}

function recordFields(item: FeedbackItem) {
  const snapshot = asMap(item.record_snapshot)
  return {
    title: firstText(item.record_title, item.title, snapshot.title),
    content: firstText(item.record_content, item.content, snapshot.content, snapshot.text),
    platform: firstText(item.record_platform, item.platform, snapshot.platform),
    author: firstText(item.record_author_name, item.author_name, snapshot.author_name, snapshot.authorName, snapshot.author),
    url: firstText(item.record_url, item.url, snapshot.url, snapshot.original_url, snapshot.originalUrl),
  }
}

function beforeAfterRows(item: FeedbackItem): Array<{ label: string; before: string; after: string }> {
  const type = String(item.feedback_type || item.type || '')
  let before = asMap(item.original_values)
  let after = asMap(item.corrected_values)
  const aiSnapshot = asMap(item.ai_snapshot)
  const recordSnapshot = asMap(item.record_snapshot)

  if (type === 'manual_correction') {
    if (Object.keys(before).length === 0) before = aiSnapshot
    if (Object.keys(after).length === 0) {
      after = compactDefined({
        sentiment: item.current_sentiment,
        category: item.current_category,
        identity: item.current_identity_override,
        publish_time: item.current_publish_time,
      })
    }
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !['id', 'tenant_id', 'record_id', 'updated_at'].includes(key))
    .filter(key => key !== 'published_ts' || (!('publish_time' in before) && !('publish_time' in after)))
    .filter(key => !sameValue(before[key], after[key]))
    .slice(0, 4)

  if (type === 'false_positive') {
    const rows = [{
      label: 'AI判断',
      before: summarizeAi(aiSnapshot) || '原判定',
      after: '误报',
    }]
    const statusKey = keys.find(key => key === 'triage_status')
    if (statusKey) {
      rows.push({
        label: FIELD_LABELS[statusKey],
        before: formatFieldValue(statusKey, before[statusKey]),
        after: formatFieldValue(statusKey, after[statusKey]),
      })
    }
    return rows
  }

  if (keys.length > 0) {
    return keys.map(key => ({
      label: FIELD_LABELS[key] || key,
      before: formatComparisonValue(key, before[key], aiSnapshot, recordSnapshot),
      after: formatComparisonValue(key, after[key], aiSnapshot, recordSnapshot),
    }))
  }

  return [{ label: '判断', before: '原结果', after: '人工纠正' }]
}

function normalizePagination(raw: unknown): Pagination | null {
  const value = asMap(raw)
  if (Object.keys(value).length === 0) return null
  return {
    page: Number(value.page || 1),
    totalPages: Number(value.totalPages ?? value.total_pages ?? 1),
    total: Number(value.total || 0),
  }
}

function normalizeCounts(raw: unknown): FeedbackCounts {
  const value = asMap(raw)
  return {
    pending: Number(value.pending || 0),
    reviewed: Number(value.reviewed || 0),
    summarized: Number(value.summarized || 0),
    dismissed: Number(value.dismissed || 0),
    total: Number(value.total || 0),
  }
}

function asMap(value: unknown): JsonMap {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonMap
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonMap : {}
    } catch { return {} }
  }
  return {}
}

function compactDefined(value: JsonMap): JsonMap {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''))
}

function firstText(...values: unknown[]): string {
  const value = values.find(v => v !== undefined && v !== null && String(v).trim() !== '')
  return value === undefined ? '' : String(value)
}

function sameValue(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return a === b }
}

function formatComparisonValue(field: string, value: unknown, ai: JsonMap, snapshot: JsonMap): string {
  if (
    ['identity', 'identity_override', 'identityOverride'].includes(field)
    && (value === undefined || value === null || value === '')
  ) {
    return identityLabel(
      firstText(ai.source_type, ai.sourceType, snapshot.source_type, snapshot.sourceType),
      Number(snapshot.author_fans ?? snapshot.authorFans ?? 0),
      firstText(snapshot.author_name, snapshot.authorName),
    ) || '未判定'
  }
  return formatFieldValue(field, value)
}

function formatFieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  const raw = String(value)
  if (field === 'sentiment') return LABELS.sentiment[raw] || raw
  if (field === 'category') return LABELS.category[raw] || raw
  if (field === 'triage_status') return LABELS.triage[raw] || raw
  if (['identity', 'identity_override', 'identityOverride', 'source_type', 'sourceType'].includes(field)) return IDENTITY_LABELS[raw] || raw
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      return json.length > 80 ? json.slice(0, 80) + '…' : json
    } catch { return raw }
  }
  return raw.length > 80 ? raw.slice(0, 80) + '…' : raw
}

function summarizeAi(ai: JsonMap): string {
  const parts: string[] = []
  for (const key of ['sentiment', 'category', 'identity', 'source_type']) {
    if (ai[key] !== undefined && ai[key] !== null && ai[key] !== '') {
      parts.push(`${FIELD_LABELS[key] || key} ${formatFieldValue(key, ai[key])}`)
    }
  }
  return parts.slice(0, 3).join(' / ')
}
