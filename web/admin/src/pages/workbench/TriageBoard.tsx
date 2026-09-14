import { useEffect, useState, useCallback, useRef } from 'react'
import { AlertCircle, RefreshCw, Loader2, Heart, MessageCircle, FileText, GripVertical } from 'lucide-react'
import { api } from '@/lib/api'
import { triageLoadError, withTriageReadDeadline } from '@/lib/triage-load'
import { Button } from '@/components/ui/button'
import { formatNumber, formatDate, LABELS, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { getCover } from '@/components/shared/RecordDrawer'
import { PostIntentBadge, PostRelevanceBadge } from '@/components/shared/PostJudgment'
import {
  FeishuTableNumberControl,
  type FeishuTableNumberSaveResult,
} from '@/components/shared/FeishuTableNumberControl'

type ColKey = 'unhandled' | 'replied' | 'reviewed' | 'reviewed_non_monitor' | 'unavailable' | 'privacy_unreachable' | 'negative_feishu' | 'negative_cold' | 'negative_comment'
type BoardColumn = { key: ColKey; label: string; dot: string; ring: string }

const COLUMNS: BoardColumn[] = [
  { key: 'unhandled', label: '待处理', dot: 'bg-status-orange', ring: 'ring-status-orange/40 bg-status-orange/[0.04]' },
  { key: 'replied', label: '已回复', dot: 'bg-status-teal', ring: 'ring-status-teal/40 bg-status-teal/[0.04]' },
  { key: 'reviewed', label: '已复核', dot: 'bg-status-green', ring: 'ring-status-green/40 bg-status-green/[0.04]' },
  { key: 'reviewed_non_monitor', label: '已复核-非监控内容', dot: 'bg-status-grey', ring: 'ring-slate-300/50 bg-slate-50 dark:bg-slate-800/40' },
  { key: 'unavailable', label: '已不可见', dot: 'bg-status-grey', ring: 'ring-slate-300/50 bg-slate-50 dark:bg-slate-800/40' },
  { key: 'privacy_unreachable', label: '负面–隐私设置无法触达', dot: 'bg-status-red', ring: 'ring-status-red/40 bg-status-red/[0.04]' },
  { key: 'negative_feishu', label: '负面-飞书表', dot: 'bg-status-red', ring: 'ring-status-red/40 bg-status-red/[0.04]' },
  { key: 'negative_cold', label: '负面-冷处理', dot: 'bg-status-red', ring: 'ring-status-red/40 bg-status-red/[0.04]' },
  { key: 'negative_comment', label: '负面-评论区留言', dot: 'bg-status-red', ring: 'ring-status-red/40 bg-status-red/[0.04]' },
]

const PER_COL = 60

function emptyColumns(): Record<ColKey, any[]> {
  return {
    unhandled: [],
    replied: [],
    reviewed: [],
    reviewed_non_monitor: [],
    unavailable: [],
    privacy_unreachable: [],
    negative_feishu: [],
    negative_cold: [],
    negative_comment: [],
  }
}

export function TriageBoard({ filterQuery, reloadKey, canWrite, onOpen, onChangeMode, onSaveFeishuTableNo, refreshBadges }: {
  filterQuery: string
  reloadKey: string
  canWrite: boolean
  onOpen: (record: any) => void
  onChangeMode: (record: any, status: ColKey) => Promise<boolean>
  onSaveFeishuTableNo: (record: any, value: string) => Promise<FeishuTableNumberSaveResult>
  refreshBadges: () => void
}) {
  const [cols, setCols] = useState<Record<ColKey, any[]>>(emptyColumns)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<ColKey | null>(null)
  const dragFrom = useRef<ColKey | null>(null)
  const requestSeq = useRef(0)
  const requestAbort = useRef<AbortController | null>(null)

  const load = useCallback(() => Promise.resolve().then(async () => {
    const seq = ++requestSeq.current
    requestAbort.current?.abort()
    setLoadError('')
    if (new URLSearchParams(filterQuery).getAll('intent').includes('none')) {
      setCols(emptyColumns())
      setLoading(false)
      return
    }
    const controller = new AbortController()
    requestAbort.current = controller
    setLoading(true)
    try {
      const results = await withTriageReadDeadline(async signal => {
        const loaded: Array<readonly [ColKey, ReturnType<typeof emptyColumns>[ColKey]]> = []
        // Avoid nine simultaneous list queries when the database is busy.
        for (let start = 0; start < COLUMNS.length; start += 2) {
          signal.throwIfAborted()
          const batch = await Promise.all(COLUMNS.slice(start, start + 2).map(async column => {
            const params = new URLSearchParams(filterQuery)
            params.set('queue', 'triage')
            params.set('status', column.key)
            params.set('pageSize', String(PER_COL))
            const data = await api.request<any>('/triage/records?' + params, { signal })
            if (!Array.isArray(data.records)) throw new Error('内容响应不完整，请稍后重试。')
            return [column.key, data.records] as const
          }))
          loaded.push(...batch)
        }
        return loaded
      }, controller)
      if (seq !== requestSeq.current) return
      const next = emptyColumns()
      for (const [key, records] of results) next[key] = records
      setCols(next)
    } catch (error) {
      controller.abort()
      if (seq === requestSeq.current) setLoadError(triageLoadError(error))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }), [filterQuery])

  useEffect(() => {
    void load()
    return () => { requestSeq.current += 1; requestAbort.current?.abort() }
  }, [load, reloadKey])
  useEffect(() => () => { requestSeq.current += 1; requestAbort.current?.abort() }, [])

  const move = useCallback(async (id: string, from: ColKey, to: ColKey) => {
    if (from === to) return
    const card = cols[from].find(record => record.id === id)
    if (!card) return

    const changed = await onChangeMode(card, to)
    if (!changed) return
    setCols(previous => ({
      ...previous,
      [from]: previous[from].filter(record => record.id !== id),
      [to]: [{ ...card, triage_status: to }, ...previous[to]],
    }))
    refreshBadges()
  }, [cols, onChangeMode, refreshBadges])

  if (loading) {
    return <div role="status" className="flex items-center justify-center gap-2 py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /><span className="text-sm text-muted-foreground">正在加载看板…</span></div>
  }

  if (loadError) return <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-destructive/20 bg-card px-5 py-10 text-center"><AlertCircle className="h-6 w-6 text-destructive" /><p className="text-sm font-medium">{loadError}</p><p className="text-xs text-muted-foreground">看板暂未加载完整，当前筛选已保留。</p><Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />重试加载</Button></div>
  if (new URLSearchParams(filterQuery).getAll('intent').includes('none')) return <div className="rounded-xl border border-border bg-card px-5 py-10 text-center"><p className="text-sm font-medium">未勾选意图</p><p className="mt-2 text-xs text-muted-foreground">勾选需要查看的意图，或点击全选恢复全部内容</p></div>

  return (
    <div className="overflow-x-auto pb-2">
      <section aria-labelledby="triage-status-group-title" className="min-w-max rounded-2xl border border-border/70 bg-muted/[0.14] p-2">
        <div className="flex min-h-10 items-center px-1 pb-2">
          <h3 id="triage-status-group-title" className="text-[12px] font-bold text-foreground">处理状态</h3>
        </div>
        <div className="flex items-stretch gap-3">
          {COLUMNS.map(column => {
            const items = cols[column.key]
            const isOver = overCol === column.key
            return (
              <div
                key={column.key}
                onDragOver={event => { if (dragId) { event.preventDefault(); setOverCol(column.key) } }}
                onDragLeave={() => setOverCol(current => current === column.key ? null : current)}
                onDrop={event => {
                  event.preventDefault()
                  if (dragId && dragFrom.current) void move(dragId, dragFrom.current, column.key)
                  setDragId(null)
                  setOverCol(null)
                }}
                className={cn(
                  'flex w-[270px] shrink-0 flex-col rounded-xl border border-border bg-muted/30 transition-colors',
                  isOver && `ring-2 ${column.ring}`,
                )}
              >
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className={cn('h-2.5 w-2.5 rounded-full', column.dot)} />
                  <span className="text-[13px] font-semibold">{column.label}</span>
                  <span className="ml-auto rounded-full bg-card px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
                    {items.length}{items.length >= PER_COL ? '+' : ''}
                  </span>
                </div>
                <div className="flex min-h-[120px] flex-1 flex-col gap-2 px-2 pb-2">
                  {items.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border py-8 text-[11px] text-muted-foreground/60">
                      {canWrite && dragId ? '拖卡至此' : '暂无'}
                    </div>
                  ) : items.map(record => (
                    <BoardCard
                      key={record.id}
                      record={record}
                      canWrite={canWrite}
                      dragging={dragId === record.id}
                      onOpen={() => onOpen(record)}
                      onSaveFeishuTableNo={value => onSaveFeishuTableNo(record, value)}
                      onDragStart={() => { setDragId(record.id); dragFrom.current = column.key }}
                      onDragEnd={() => { setDragId(null); setOverCol(null) }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function BoardCard({ record: r, canWrite, dragging, onOpen, onSaveFeishuTableNo, onDragStart, onDragEnd }: {
  record: any
  canWrite: boolean
  dragging: boolean
  onOpen: () => void
  onSaveFeishuTableNo: (value: string) => Promise<FeishuTableNumberSaveResult>
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const cover = getCover(r)
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
  const accent = r.triage_status === 'unhandled'
    ? 'border-l-status-orange'
    : r.triage_status === 'replied' || r.triage_status === 'reviewed'
      ? 'border-l-status-green'
      : r.triage_status === 'negative_feishu' || r.triage_status === 'negative_cold' || r.triage_status === 'negative_comment'
        ? 'border-l-status-red'
        : 'border-l-status-grey'
  return (
    <div
      data-record-detail-trigger
      draggable={canWrite}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={cn(
        'group cursor-pointer rounded-lg border border-l-[3px] border-border bg-card p-2.5 shadow-xs transition-all hover:shadow-sm',
        accent,
        dragging && 'opacity-40',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <StatusBadge tone={tone}>{tone === 'negative' ? '负面' : tone === 'positive' ? '正面' : '中性'}</StatusBadge>
        <PostIntentBadge record={r} />
        <PostRelevanceBadge record={r} />
        {r.category && <StatusBadge tone="neutral">{LABELS.category[r.category] || r.category}</StatusBadge>}
        {canWrite && <GripVertical className="ml-auto h-3.5 w-3.5 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>
      {r.triage_status === 'negative_feishu' && (
        <FeishuTableNumberControl
          value={r.feishu_table_no}
          onSave={canWrite ? onSaveFeishuTableNo : undefined}
          className="mb-1.5 max-w-full"
        />
      )}
      <div className="flex gap-2.5">
        {cover ? (
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
            <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={event => { (event.target as HTMLImageElement).style.display = 'none' }} />
          </div>
        ) : (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-muted/50"><FileText className="h-4 w-4 text-muted-foreground/40" /></div>
        )}
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[12px] font-medium leading-snug">{r.title || r.content || '(无标题)'}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2.5 text-[10.5px] text-muted-foreground">
        <span>{platformName(r.platform)}</span>
        <span className="inline-flex items-center gap-0.5"><Heart className="h-2.5 w-2.5" />{formatNumber(r.likes)}</span>
        <span className="inline-flex items-center gap-0.5"><MessageCircle className="h-2.5 w-2.5" />{formatNumber(r.comments_count)}</span>
        {Number(r.alert_count) > 0 && <span className="font-medium text-status-red">预警{r.alert_count}</span>}
        <span className="ml-auto">{formatDate(r.last_seen_at || r.created_at)}</span>
      </div>
    </div>
  )
}
