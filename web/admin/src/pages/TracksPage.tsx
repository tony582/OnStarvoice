import { useEffect, useState } from 'react'
import { Loader2, TrendingUp, Flame, Target, Lightbulb, X, ChevronRight, Layers } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'

const HEAT_LABEL: Record<string, string> = { high: '高热', medium: '中等热度', low: '低热度' }
const HEAT_TONE: Record<string, string> = { high: 'high', medium: 'medium', low: 'low' }

export function TracksPage() {
  const [tracks, setTracks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<any>(null)

  useEffect(() => {
    api.get<any>('/content/tracks').then(d => setTracks(d.tracks || [])).catch(console.error).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <p className="text-[13px] text-muted-foreground">在扩展里跑「判断赛道机会」,结果会自动汇总到这里 —— 按热度看哪个赛道值得做、流量是否集中、有哪些选题角度。</p>

      {tracks.length === 0 ? (
        <EmptyState icon={TrendingUp} title="还没有赛道数据"
          description="打开扩展侧边栏,在搜索结果页点「判断赛道机会」;算出的赛道热度、断层、选题角度会自动存进来。" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tracks.map(t => {
            const cliff = Math.round(Number(t.cliff_drop_ratio || 0) * 100)
            return (
              <button key={t.id} onClick={() => setOpen(t)}
                className="group flex flex-col rounded-xl border border-border bg-card p-4 text-left shadow-xs transition-all hover:border-input hover:shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <StatusBadge tone={HEAT_TONE[t.heat_level] || 'low'}>
                      <Flame className="mr-0.5 h-2.5 w-2.5" />{HEAT_LABEL[t.heat_level] || '未知'}
                    </StatusBadge>
                    {t.platform && <StatusBadge tone="neutral">{platformName(t.platform)}</StatusBadge>}
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                </div>
                <h3 className="mt-2.5 truncate text-[15px] font-bold">{t.keyword}</h3>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <Mini label="前排断层" value={`${cliff}%`} tone={cliff >= 25 ? 'red' : 'default'} />
                  <Mini label="选题方向" value={String(t.direction_count)} />
                  <Mini label="推荐选题" value={String(t.angle_count)} />
                </div>
                <div className="mt-2.5 text-[10.5px] text-muted-foreground">样本 {formatNumber(t.sample_count)} · {formatDate(t.created_at)}</div>
              </button>
            )
          })}
        </div>
      )}

      {open && <TrackDrawer track={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Mini({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'red' }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2">
      <div className={cn('text-[15px] font-bold tabular-nums', tone === 'red' && 'text-status-red')}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  )
}

function TrackDrawer({ track, onClose }: { track: any; onClose: () => void }) {
  const data = track.payload || {}
  const directions = data.hotTopicDirections || []
  const angles = data.recommendedAngles || []
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-bold">赛道策略 · {track.keyword}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <StatusBadge tone={HEAT_TONE[track.heat_level] || 'low'}><Flame className="mr-0.5 h-2.5 w-2.5" />{HEAT_LABEL[track.heat_level] || '未知'}</StatusBadge>
            {track.platform && <StatusBadge tone="neutral">{platformName(track.platform)}</StatusBadge>}
            <span className="text-xs text-muted-foreground">前排断层 {Math.round(Number(track.cliff_drop_ratio || 0) * 100)}% · 样本 {formatNumber(track.sample_count)}</span>
          </div>
          {data.distributionSummary && (
            <div className="mb-5 rounded-lg border border-border bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">{data.distributionSummary}</div>
          )}

          {directions.length > 0 && (
            <section className="mb-6">
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Layers className="h-3.5 w-3.5" />热门方向</h3>
              <div className="space-y-2.5">
                {directions.map((d: any, i: number) => (
                  <div key={i} className="rounded-lg border border-border p-3.5">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded bg-status-purple/15 text-[11px] font-bold text-purple-600 dark:text-purple-400">{i + 1}</span>
                      <span className="text-sm font-semibold">{d.name}</span>
                    </div>
                    {d.whyItWorks && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{d.whyItWorks}</p>}
                    {Array.isArray(d.representativeTitles) && d.representativeTitles.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {d.representativeTitles.slice(0, 3).map((t: string, j: number) => (
                          <li key={j} className="truncate text-[11px] text-foreground/70">· {t}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {angles.length > 0 && (
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Lightbulb className="h-3.5 w-3.5" />推荐选题</h3>
              <div className="space-y-2.5">
                {angles.map((a: any, i: number) => (
                  <div key={i} className="rounded-lg border border-border p-3.5">
                    <div className="flex items-start gap-2">
                      <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-green" />
                      <span className="text-sm font-semibold leading-snug">{a.title}</span>
                    </div>
                    {a.audiencePainPoint && <p className="mt-1.5 text-xs text-muted-foreground"><span className="font-medium text-foreground/70">痛点:</span>{a.audiencePainPoint}</p>}
                    {a.formatSuggestion && <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium text-foreground/70">形式:</span>{a.formatSuggestion}</p>}
                    {a.executionHint && <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium text-foreground/70">执行:</span>{a.executionHint}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
