import { useEffect, useState, useCallback, useRef } from 'react'
import { Loader2, Heart, MessageCircle, FileText, GripVertical } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, LABELS, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { getCover } from '@/components/shared/RecordDrawer'

type ColKey = 'unhandled' | 'reviewing' | 'issue_linked' | 'official_responded' | 'archived'

// Monday 风格彩色分组列。dot=列头圆点色;ring=拖拽悬停高亮色。
const COLUMNS: Array<{ key: ColKey; label: string; dot: string; ring: string }> = [
  { key: 'unhandled', label: '待分诊', dot: 'bg-status-orange', ring: 'ring-status-orange/40 bg-status-orange/[0.04]' },
  { key: 'reviewing', label: '待复核', dot: 'bg-status-purple', ring: 'ring-status-purple/40 bg-status-purple/[0.04]' },
  { key: 'issue_linked', label: '已转问题', dot: 'bg-status-blue', ring: 'ring-status-blue/40 bg-status-blue/[0.04]' },
  { key: 'official_responded', label: '已响应', dot: 'bg-status-green', ring: 'ring-status-green/40 bg-status-green/[0.04]' },
  { key: 'archived', label: '已归档', dot: 'bg-status-grey', ring: 'ring-slate-300/50 bg-slate-50 dark:bg-slate-800/40' },
]

const PER_COL = 60

export function TriageBoard({ sentiment, platform, keyword, reloadKey, canWrite, onOpen, refreshBadges }: {
  sentiment: string
  platform?: string
  keyword: string
  reloadKey: string
  canWrite: boolean
  onOpen: (record: any) => void
  refreshBadges: () => void
}) {
  const [cols, setCols] = useState<Record<ColKey, any[]>>({ unhandled: [], reviewing: [], issue_linked: [], official_responded: [], archived: [] })
  const [loading, setLoading] = useState(true)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<ColKey | null>(null)
  const dragFrom = useRef<ColKey | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const results = await Promise.all(COLUMNS.map(c => {
        const p = new URLSearchParams({ status: c.key, pageSize: String(PER_COL), sentiment, platform: platform || '', keyword })
        return api.get<any>('/triage/records?' + p).then(d => [c.key, d.records || []] as const).catch(() => [c.key, []] as const)
      }))
      const next: any = { unhandled: [], reviewing: [], issue_linked: [], official_responded: [], archived: [] }
      for (const [k, recs] of results) next[k] = recs
      setCols(next)
    } finally { setLoading(false) }
  }, [sentiment, platform, keyword])

  useEffect(() => { load() }, [reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const move = useCallback(async (id: string, from: ColKey, to: ColKey) => {
    if (from === to) return
    let card: any
    setCols(prev => {
      card = prev[from].find(r => r.id === id)
      if (!card) return prev
      return { ...prev, [from]: prev[from].filter(r => r.id !== id), [to]: [{ ...card, triage_status: to }, ...prev[to]] }
    })
    try {
      await api.patch('/triage/records/' + id, { status: to })
      refreshBadges()
    } catch {
      // 回滚
      setCols(prev => ({ ...prev, [to]: prev[to].filter(r => r.id !== id), [from]: card ? [card, ...prev[from]] : prev[from] }))
    }
  }, [refreshBadges])

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map(col => {
        const items = cols[col.key]
        const isOver = overCol === col.key
        return (
          <div key={col.key}
            onDragOver={e => { if (dragId) { e.preventDefault(); setOverCol(col.key) } }}
            onDragLeave={() => setOverCol(c => (c === col.key ? null : c))}
            onDrop={e => { e.preventDefault(); if (dragId && dragFrom.current) move(dragId, dragFrom.current, col.key); setDragId(null); setOverCol(null) }}
            className={cn(
              'flex w-[270px] shrink-0 flex-col rounded-xl border border-border bg-muted/30 transition-colors',
              isOver && `ring-2 ${col.ring}`,
            )}>
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className={cn('h-2.5 w-2.5 rounded-full', col.dot)} />
              <span className="text-[13px] font-semibold">{col.label}</span>
              <span className="ml-auto rounded-full bg-card px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{items.length}{items.length >= PER_COL ? '+' : ''}</span>
            </div>
            <div className="flex min-h-[120px] flex-1 flex-col gap-2 px-2 pb-2">
              {items.length === 0 ? (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border py-8 text-[11px] text-muted-foreground/60">
                  {canWrite && dragId ? '拖卡至此' : '暂无'}
                </div>
              ) : items.map(r => (
                <BoardCard key={r.id} record={r} canWrite={canWrite} dragging={dragId === r.id}
                  onOpen={() => onOpen(r)}
                  onDragStart={() => { setDragId(r.id); dragFrom.current = col.key }}
                  onDragEnd={() => { setDragId(null); setOverCol(null) }}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function BoardCard({ record: r, canWrite, dragging, onOpen, onDragStart, onDragEnd }: {
  record: any; canWrite: boolean; dragging: boolean; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void
}) {
  const cover = getCover(r)
  const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
  const accent = r.sentiment === 'negative' ? 'border-l-status-red' : r.sentiment === 'positive' ? 'border-l-status-green' : 'border-l-status-blue'
  return (
    <div
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
