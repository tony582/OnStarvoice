import { useEffect, useState, useCallback, useRef } from 'react'
import { Loader2, Heart, MessageCircle, FileText, GripVertical, ClipboardCheck, GitFork } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, LABELS, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { getCover } from '@/components/shared/RecordDrawer'

type ColKey = 'unhandled' | 'reviewing' | 'official_responded' | 'no_action' | 'ticketed'
type BoardColumn = { key: ColKey; label: string; dot: string; ring: string }

const CONTENT_COLUMNS: BoardColumn[] = [
  { key: 'unhandled', label: '待处理', dot: 'bg-status-orange', ring: 'ring-status-orange/40 bg-status-orange/[0.04]' },
  { key: 'reviewing', label: '负面流程', dot: 'bg-status-purple', ring: 'ring-status-purple/40 bg-status-purple/[0.04]' },
  { key: 'official_responded', label: '官方已评', dot: 'bg-status-green', ring: 'ring-status-green/40 bg-status-green/[0.04]' },
  { key: 'no_action', label: '无需操作', dot: 'bg-status-grey', ring: 'ring-slate-300/50 bg-slate-50 dark:bg-slate-800/40' },
]
const TICKET_COLUMN: BoardColumn = { key: 'ticketed', label: '已转工单', dot: 'bg-status-blue', ring: 'ring-status-blue/40 bg-status-blue/[0.04]' }
const COLUMNS: BoardColumn[] = [...CONTENT_COLUMNS, TICKET_COLUMN]

const PER_COL = 60

export function TriageBoard({ sentiment, platform, keyword, reloadKey, canWrite, onOpen, onDispatchTicket, refreshBadges }: {
  sentiment: string
  platform?: string
  keyword: string
  reloadKey: string
  canWrite: boolean
  onOpen: (record: any) => void
  onDispatchTicket: (record: any) => Promise<boolean>
  refreshBadges: () => void
}) {
  const [cols, setCols] = useState<Record<ColKey, any[]>>({ unhandled: [], reviewing: [], official_responded: [], no_action: [], ticketed: [] })
  const [loading, setLoading] = useState(true)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<ColKey | null>(null)
  const dragFrom = useRef<ColKey | null>(null)

  const load = useCallback(() => Promise.resolve().then(async () => {
    setLoading(true)
    try {
      const results = await Promise.all(COLUMNS.map(c => {
        const p = new URLSearchParams({
          queue: 'triage',
          status: c.key,
          pageSize: String(PER_COL),
          sentiment,
          platform: platform || '',
          keyword,
        })
        return api.get<any>('/triage/records?' + p).then(d => [c.key, d.records || []] as const).catch(() => [c.key, []] as const)
      }))
      const next: any = { unhandled: [], reviewing: [], official_responded: [], no_action: [], ticketed: [] }
      for (const [k, recs] of results) next[k] = recs
      setCols(next)
    } finally { setLoading(false) }
  }), [sentiment, platform, keyword])

  useEffect(() => { void load() }, [load, reloadKey])

  const move = useCallback(async (id: string, from: ColKey, to: ColKey) => {
    if (from === to || from === 'ticketed') return
    const card = cols[from].find(r => r.id === id)
    if (!card) return
    if (to === 'ticketed') {
      const changed = await onDispatchTicket(card)
      if (changed) await load()
      return
    }
    setCols(prev => {
      return { ...prev, [from]: prev[from].filter(r => r.id !== id), [to]: [{ ...card, triage_status: to }, ...prev[to]] }
    })
    try {
      if (to === 'official_responded') {
        await api.patch('/records/' + id + '/official-response', { status: 'responded' })
      } else {
        await api.patch('/triage/records/' + id, { status: to })
      }
      refreshBadges()
    } catch {
      // 回滚
      setCols(prev => ({ ...prev, [to]: prev[to].filter(r => r.id !== id), [from]: card ? [card, ...prev[from]] : prev[from] }))
    }
  }, [cols, load, onDispatchTicket, refreshBadges])

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  const renderColumn = (col: BoardColumn, ticketBranch = false) => {
    const items = cols[col.key]
    const isOver = overCol === col.key
    return (
      <div key={col.key}
        onDragOver={e => { if (dragId) { e.preventDefault(); setOverCol(col.key) } }}
        onDragLeave={() => setOverCol(c => (c === col.key ? null : c))}
        onDrop={e => { e.preventDefault(); if (dragId && dragFrom.current) void move(dragId, dragFrom.current, col.key); setDragId(null); setOverCol(null) }}
        className={cn(
          'flex w-[270px] shrink-0 flex-col rounded-xl border transition-colors',
          ticketBranch ? 'flex-1 border-primary/20 bg-card/80' : 'border-border bg-muted/30',
          isOver && `ring-2 ${col.ring}`,
        )}>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className={cn('h-2.5 w-2.5 rounded-full', col.dot)} />
          <span className="text-[13px] font-semibold">{col.label}</span>
          <span className="ml-auto rounded-full bg-card px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{items.length}{items.length >= PER_COL ? '+' : ''}</span>
        </div>
        <div className="flex min-h-[120px] flex-1 flex-col gap-2 px-2 pb-2">
          {items.length === 0 ? (
            <div className={cn(
              'flex flex-1 items-center justify-center rounded-lg border border-dashed py-8 text-[11px]',
              ticketBranch ? 'border-primary/20 bg-primary/[0.025] text-primary/65' : 'border-border text-muted-foreground/60',
            )}>
              {canWrite && dragId ? (ticketBranch ? '拖到这里转工单' : '拖卡至此') : '暂无'}
            </div>
          ) : items.map(r => (
            <BoardCard key={r.id} record={r} canWrite={canWrite && col.key !== 'ticketed'} dragging={dragId === r.id}
              onOpen={() => onOpen(r)}
              onDragStart={() => { setDragId(r.id); dragFrom.current = col.key }}
              onDragEnd={() => { setDragId(null); setOverCol(null) }}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max items-stretch">
        <section aria-labelledby="triage-content-group-title" className="flex flex-col rounded-2xl border border-border/70 bg-muted/[0.14] p-2">
          <div className="flex min-h-10 items-center px-1 pb-2">
            <h3 id="triage-content-group-title" className="text-[12px] font-bold text-foreground">处理模式</h3>
          </div>
          <div className="flex flex-1 items-stretch gap-3">
            {CONTENT_COLUMNS.map(col => renderColumn(col))}
          </div>
        </section>

        <div aria-hidden="true" className="flex w-[76px] shrink-0 items-start pt-[68px]">
          <div className="relative flex w-full items-center">
            <span className="h-px flex-1 bg-border" />
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-card text-primary shadow-sm">
              <GitFork className="h-4 w-4 rotate-90" />
            </span>
            <span className="h-px flex-1 bg-primary/35" />
          </div>
        </div>

        <section
          aria-labelledby="triage-ticket-group-title"
          className={cn(
            'flex w-[286px] shrink-0 flex-col rounded-2xl border border-primary/20 bg-primary/[0.045] p-2 transition-shadow',
            overCol === 'ticketed' && 'ring-2 ring-primary/20',
          )}
        >
          <div className="flex min-h-10 items-center gap-2 px-1 pb-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ClipboardCheck className="h-3.5 w-3.5" />
            </span>
            <h3 id="triage-ticket-group-title" className="text-[12px] font-bold text-foreground">工单</h3>
          </div>
          {renderColumn(TICKET_COLUMN, true)}
        </section>
      </div>
    </div>
  )
}

function BoardCard({ record: r, canWrite, dragging, onOpen, onDragStart, onDragEnd }: {
  record: any; canWrite: boolean; dragging: boolean; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void
}) {
  const cover = getCover(r)
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
  const accent = r.sentiment === 'negative' ? 'border-l-status-red' : r.sentiment === 'positive' ? 'border-l-status-green' : 'border-l-status-blue'
  const ticketNumber = String(r.ticket_number || '').trim()
  const matchedTicketNumber = String(r.matched_ticket_number || '').trim()
  const ticketLabel = matchedTicketNumber && matchedTicketNumber !== ticketNumber
    ? `匹配工单号 ${matchedTicketNumber} · 当前工单号 ${ticketNumber || '待补录'}`
    : (ticketNumber ? `工单号 ${ticketNumber}` : '工单号待补录')
  return (
    <div
      data-record-detail-trigger
      draggable={canWrite}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={cn(
        'group cursor-pointer rounded-lg border border-l-[3px] border-border bg-card p-2.5 shadow-xs transition-all hover:shadow-sm',
        accent, dragging && 'opacity-40',
      )}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <StatusBadge tone={tone}>{tone === 'negative' ? '负面' : tone === 'positive' ? '正面' : '中性'}</StatusBadge>
        {r.category && <StatusBadge tone="neutral">{LABELS.category[r.category] || r.category}</StatusBadge>}
        {r.ticket_id && (
          <StatusBadge tone="ticketed" className="max-w-40 gap-1">
            <ClipboardCheck className="h-3 w-3 shrink-0" />
            <span className="truncate" title={ticketLabel}>{ticketLabel}</span>
          </StatusBadge>
        )}
        {canWrite && <GripVertical className="ml-auto h-3.5 w-3.5 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>
      <div className="flex gap-2.5">
        {cover ? (
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
            <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
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
