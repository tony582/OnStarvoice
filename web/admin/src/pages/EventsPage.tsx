import { useEffect, useState, useCallback } from 'react'
import { Loader2, Route, TrendingUp, Activity, Globe, Clock, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, platformName, LABELS, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchTabs } from '@/components/shared/Workbench'
import { EventDrawer } from '@/components/shared/EventDrawer'

const FILTERS = [
  { key: '', label: '全部事件' },
  { key: 'sev:critical', label: '危急' },
  { key: 'sev:high', label: '高' },
  { key: 'st:open', label: '处置中' },
  { key: 'st:resolved', label: '已解决' },
]

export function EventsPage() {
  const [filter, setFilter] = useState('')
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (filter.startsWith('sev:')) p.set('severity', filter.slice(4))
      if (filter.startsWith('st:')) p.set('status', filter.slice(3))
      const data = await api.get<any>('/workspace/events?' + p)
      setEvents(data.events || [])
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }, [filter])

  useEffect(() => { load() }, [load])

  const maxReach = Math.max(1, ...events.map(e => Number(e.reach || 0)))

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <p className="text-[13px] text-muted-foreground">负面内容自动聚类成"事件",按影响力排序。点开看时间脉络:这起舆情怎么起、怎么扩。</p>
      <WorkbenchTabs tabs={FILTERS.map(f => ({ key: f.key, label: f.label }))} activeKey={filter} onChange={setFilter} />

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : events.length === 0 ? (
        <EmptyState icon={Route} title="暂无事件" description="负面内容关联成问题后,会在这里聚成事件" />
      ) : (
        <div className="space-y-2.5">
          {events.map(ev => {
            const sevAccent = ev.severity === 'critical' ? 'border-l-status-darkred' : ev.severity === 'high' ? 'border-l-status-red' : ev.severity === 'medium' ? 'border-l-status-orange' : 'border-l-status-grey'
            const reachPct = Math.max(3, Math.round((Number(ev.reach || 0) / maxReach) * 100))
            return (
              <button key={ev.id} onClick={() => setOpenId(ev.id)}
                className={cn('group flex w-full items-center gap-4 rounded-xl border border-l-[3px] border-border bg-card p-4 text-left shadow-xs transition-all hover:border-input hover:shadow-sm', sevAccent)}>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <StatusBadge tone={ev.severity}>{LABELS.severity?.[ev.severity] || ev.severity}</StatusBadge>
                    <StatusBadge tone={ev.status}>{LABELS.issueStatus?.[ev.status] || ev.status}</StatusBadge>
                    {(ev.platforms || []).slice(0, 3).map((p: string) => <StatusBadge key={p} tone="neutral">{platformName(p)}</StatusBadge>)}
                  </div>
                  <h3 className="truncate text-sm font-bold leading-snug">{ev.title || '未命名事件'}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1"><Activity className="h-3 w-3" />{formatNumber(ev.record_count)} 内容</span>
                    {Number(ev.negative_count) > 0 && <span className="inline-flex items-center gap-1 font-medium text-status-red">{formatNumber(ev.negative_count)} 负面</span>}
                    <span className="inline-flex items-center gap-1"><Globe className="h-3 w-3" />{(ev.platforms || []).length} 平台</span>
                    <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{formatDate(ev.span_start)} 起</span>
                    {ev.owner_name && <span>负责人 {ev.owner_name}</span>}
                  </div>
                </div>

                {/* 影响力 */}
                <div className="w-32 shrink-0">
                  <div className="mb-1 flex items-center justify-between text-[10.5px] text-muted-foreground">
                    <span className="inline-flex items-center gap-0.5"><TrendingUp className="h-3 w-3" />影响力</span>
                    <span className="font-bold tabular-nums text-foreground">{formatNumber(ev.reach)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-status-red" style={{ width: `${reachPct}%` }} /></div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
              </button>
            )
          })}
        </div>
      )}

      {openId && <EventDrawer eventId={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}
