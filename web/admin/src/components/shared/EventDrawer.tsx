import { useEffect, useState } from 'react'
import { X, Loader2, Heart, MessageCircle, Star, Share2, ExternalLink, Activity, TrendingUp, Globe, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, formatFullDate, platformName, LABELS, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'

/**
 * 事件详情:把一个 issue 当"事件",核心是【时间脉络】——关联内容按时间排成时间线,
 * 看清这起舆情怎么起、怎么扩。传播网络图因缺转发有向边暂不做(数据可行性未满足)。
 */
export function EventDrawer({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [issue, setIssue] = useState<any>(null)
  const [records, setRecords] = useState<any[]>([])
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.get<any>('/issues/' + eventId)
      .then(d => { setIssue(d.issue); setRecords(d.records || []); setEvents(d.events || []) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [eventId])

  const reach = records.reduce((s, r) => s + Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0), 0)
  const platforms = Array.from(new Set(records.map(r => r.platform).filter(Boolean)))
  // 时间脉络:按内容时间升序
  const timeline = [...records].sort((a, b) => new Date(a.last_seen_at || a.linked_at).getTime() - new Date(b.last_seen_at || b.linked_at).getTime())

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-bold">事件详情 · 时间脉络</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* Hero */}
            <div className="border-b border-border p-6">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusBadge tone={issue?.severity}>{LABELS.severity?.[issue?.severity] || issue?.severity}</StatusBadge>
                <StatusBadge tone={issue?.status}>{LABELS.issueStatus?.[issue?.status] || issue?.status}</StatusBadge>
              </div>
              <h3 className="text-base font-bold leading-snug">{issue?.title}</h3>
              {issue?.summary && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{issue.summary}</p>}

              <div className="mt-4 grid grid-cols-4 gap-2">
                <Metric icon={TrendingUp} label="影响力" value={formatNumber(reach)} tone="red" />
                <Metric icon={Activity} label="关联内容" value={formatNumber(records.length)} />
                <Metric icon={Globe} label="涉及平台" value={String(platforms.length)} />
                <Metric icon={Clock} label="时间跨度" value={spanLabel(timeline)} />
              </div>
            </div>

            {/* 时间脉络 */}
            <div className="p-6">
              <h4 className="mb-4 text-xs font-bold uppercase tracking-wider text-muted-foreground">时间脉络</h4>
              {timeline.length === 0 ? (
                <EmptyState icon={Activity} title="暂无关联内容" />
              ) : (
                <div className="relative space-y-4 pl-5">
                  <div className="absolute left-[5px] top-1.5 h-[calc(100%-12px)] w-px bg-border" />
                  {timeline.map((r, i) => {
                    const dot = r.sentiment === 'negative' ? 'bg-status-red' : r.sentiment === 'positive' ? 'bg-status-green' : 'bg-status-blue'
                    const inter = Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0)
                    return (
                      <div key={i} className="relative">
                        <div className={cn('absolute -left-5 top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-card', dot)} />
                        <div className="rounded-lg border border-border bg-card p-3 shadow-xs transition-shadow hover:shadow-sm">
                          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="font-medium text-foreground">{formatFullDate(r.last_seen_at)}</span>
                            <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
                            <StatusBadge tone={r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'}>
                              {r.sentiment === 'negative' ? '负面' : r.sentiment === 'positive' ? '正面' : '中性'}
                            </StatusBadge>
                          </div>
                          <div className="text-[13px] font-medium leading-snug">{r.title || r.content || '(无标题)'}</div>
                          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                            <span>{r.author_name || '未知'}</span>
                            <span className="inline-flex items-center gap-0.5"><Heart className="h-3 w-3" />{formatNumber(r.likes)}</span>
                            <span className="inline-flex items-center gap-0.5"><MessageCircle className="h-3 w-3" />{formatNumber(r.comments_count)}</span>
                            <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3" />{formatNumber(r.collects)}</span>
                            <span className="inline-flex items-center gap-0.5"><Share2 className="h-3 w-3" />{formatNumber(r.shares)}</span>
                            <span className="ml-auto font-medium text-foreground">{formatNumber(inter)} 互动</span>
                            {r.url && <a href={r.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-primary hover:underline"><ExternalLink className="h-3 w-3" /></a>}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* 处置记录 */}
              {events.length > 0 && (
                <>
                  <h4 className="mb-3 mt-6 text-xs font-bold uppercase tracking-wider text-muted-foreground">处置记录</h4>
                  <div className="space-y-2">
                    {events.map((e, i) => (
                      <div key={i} className="flex items-start gap-3 rounded-lg border border-border p-3">
                        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div>
                          <div className="text-sm font-medium">{e.body || e.event_type}</div>
                          <div className="text-xs text-muted-foreground">{e.actor_name || e.actor_type} · {formatFullDate(e.created_at)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function spanLabel(timeline: any[]): string {
  if (timeline.length < 1) return '—'
  const start = new Date(timeline[0].last_seen_at || timeline[0].linked_at).getTime()
  const end = new Date(timeline[timeline.length - 1].last_seen_at || timeline[timeline.length - 1].linked_at).getTime()
  const days = Math.max(0, Math.round((end - start) / 86400000))
  return days === 0 ? '当日' : `${days} 天`
}

function Metric({ icon: Icon, label, value, tone = 'default' }: { icon: React.ElementType; label: string; value: string; tone?: 'default' | 'red' }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2.5 text-center">
      <Icon className={cn('mx-auto mb-1 h-4 w-4', tone === 'red' ? 'text-status-red' : 'text-muted-foreground')} strokeWidth={1.8} />
      <div className={cn('text-[15px] font-bold tabular-nums', tone === 'red' && 'text-status-red')}>{value}</div>
      <div className="text-[10px] font-medium text-muted-foreground">{label}</div>
    </div>
  )
}
