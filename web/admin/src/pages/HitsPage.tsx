import { useEffect, useState } from 'react'
import {
  Loader2, Flame, Heart, MessageCircle, Star, Share2, X, FileText,
  Anchor, Type, ListTree, Hash, Sparkles, Copy, ExternalLink, Wand2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { getCover } from '@/components/shared/RecordDrawer'

export function HitsPage() {
  const [hits, setHits] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<any>(null)

  useEffect(() => {
    api.get<any>('/content/hits').then(d => setHits(d.hits || [])).catch(console.error).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <p className="text-[13px] text-muted-foreground">从已采集内容里挑高互动的爆款,点开 AI 反编译:黄金钩子、标题公式、正文结构、标签策略,产出可复刻仿写模板。</p>

      {hits.length === 0 ? (
        <EmptyState icon={Flame} title="暂无可拆解内容" description="采集到高互动内容后,会在这里按互动量排出爆款候选" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {hits.map(h => {
            const cover = getCover(h)
            return (
              <button key={h.id} onClick={() => setOpen(h)}
                className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left shadow-xs transition-all hover:border-input hover:shadow-sm">
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
                  {cover ? (
                    <img src={cover} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]" loading="lazy" referrerPolicy="no-referrer" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center"><FileText className="h-7 w-7 text-muted-foreground/30" /></div>
                  )}
                  <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur">
                    <Flame className="h-2.5 w-2.5 text-status-orange" />{formatNumber(h.interaction)}
                  </div>
                  {h.analyzed && <div className="absolute right-2 top-2 rounded bg-status-green px-1.5 py-0.5 text-[9px] font-bold text-white">已拆解</div>}
                </div>
                <div className="flex flex-1 flex-col p-3">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <StatusBadge tone="neutral">{platformName(h.platform)}</StatusBadge>
                    {h.category && <StatusBadge tone="muted">{h.category}</StatusBadge>}
                  </div>
                  <div className="line-clamp-2 text-[12.5px] font-medium leading-snug">{h.title || h.content || '(无标题)'}</div>
                  <div className="mt-2 flex items-center gap-2.5 text-[10.5px] text-muted-foreground">
                    <span className="inline-flex items-center gap-0.5"><Heart className="h-2.5 w-2.5" />{formatNumber(h.likes)}</span>
                    <span className="inline-flex items-center gap-0.5"><MessageCircle className="h-2.5 w-2.5" />{formatNumber(h.comments_count)}</span>
                    <span className="inline-flex items-center gap-0.5"><Star className="h-2.5 w-2.5" />{formatNumber(h.collects)}</span>
                    <span className="ml-auto truncate">{h.author_name}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {open && <HitDrawer hit={open} onClose={() => setOpen(null)} onAnalyzed={() => setHits(hs => hs.map(x => x.id === open.id ? { ...x, analyzed: true } : x))} />}
    </div>
  )
}

function HitDrawer({ hit, onClose, onAnalyzed }: { hit: any; onClose: () => void; onAnalyzed: () => void }) {
  const [analysis, setAnalysis] = useState<any>(null)
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(true)
  const cover = getCover(hit)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.post<any>(`/content/hits/${hit.id}/analyze`)
      .then(d => { if (alive) { setAnalysis(d.analysis); setSource(d.source); if (!d.cached) onAnalyzed() } })
      .catch(console.error)
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [hit.id])

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="inline-flex items-center gap-2 text-base font-bold"><Wand2 className="h-4 w-4 text-status-purple" />爆款拆解</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* 原内容 */}
          <div className="flex gap-4 border-b border-border p-6">
            {cover && <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-border bg-muted"><img src={cover} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" /></div>}
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex items-center gap-1.5">
                <StatusBadge tone="neutral">{platformName(hit.platform)}</StatusBadge>
                <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-status-orange"><Flame className="h-3 w-3" />{formatNumber(hit.interaction)} 互动</span>
              </div>
              <div className="text-sm font-bold leading-snug">{hit.title || '(无标题)'}</div>
              <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>{hit.author_name}</span>
                <span className="inline-flex items-center gap-0.5"><Heart className="h-3 w-3" />{formatNumber(hit.likes)}</span>
                <span className="inline-flex items-center gap-0.5"><MessageCircle className="h-3 w-3" />{formatNumber(hit.comments_count)}</span>
                <span className="inline-flex items-center gap-0.5"><Share2 className="h-3 w-3" />{formatNumber(hit.shares)}</span>
                {hit.url && <a href={hit.url} target="_blank" rel="noreferrer" className="text-primary hover:underline"><ExternalLink className="h-3 w-3" /></a>}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-xs">AI 正在反编译这条爆款…</span>
            </div>
          ) : analysis ? (
            <div className="space-y-4 p-6">
              <Block icon={Anchor} tone="text-status-red" title="黄金钩子">{analysis.hook}</Block>
              <Block icon={Type} tone="text-status-blue" title="标题公式">{analysis.titleFormula}</Block>
              <div className="rounded-lg border border-border p-4">
                <div className="mb-2.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground"><ListTree className="h-3.5 w-3.5" />正文结构</div>
                <div className="space-y-2">
                  {(analysis.structure || []).map((s: any, i: number) => (
                    <div key={i} className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-status-purple/15 text-[11px] font-bold text-purple-600 dark:text-purple-400">{i + 1}</span>
                      <div><span className="text-[13px] font-semibold">{s.part}</span><span className="ml-1.5 text-xs text-muted-foreground">{s.desc}</span></div>
                    </div>
                  ))}
                </div>
              </div>
              <Block icon={Hash} tone="text-status-orange" title="标签策略">{analysis.tagStrategy}</Block>
              <Block icon={Sparkles} tone="text-status-green" title="为什么火">{analysis.whyItWorks}</Block>
              {/* 可复刻模板 */}
              <div className="rounded-lg border-2 border-status-purple/30 bg-status-purple/[0.04] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-purple-600 dark:text-purple-400"><Copy className="h-3.5 w-3.5" />可复刻仿写模板</span>
                  <button onClick={() => navigator.clipboard?.writeText(analysis.template || '')} className="text-[11px] font-medium text-primary hover:underline">复制</button>
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{analysis.template}</p>
              </div>
              <div className="text-center text-[10px] text-muted-foreground">{source === 'ai' ? 'AI 拆解' : '规则拆解(AI 暂不可用)'}</div>
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-muted-foreground">拆解失败,请重试</div>
          )}
        </div>
      </div>
    </div>
  )
}

function Block({ icon: Icon, tone, title, children }: { icon: React.ElementType; tone: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className={cn('mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider', tone)}><Icon className="h-3.5 w-3.5" />{title}</div>
      <p className="text-[13px] leading-relaxed text-foreground/90">{children}</p>
    </div>
  )
}
