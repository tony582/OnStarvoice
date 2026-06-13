import { useEffect, useState } from 'react'
import { Loader2, Users2, TrendingUp, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'

const GROWTH_LABEL: Record<string, string> = { high: '高潜力', medium: '稳定', low: '一般' }
const GROWTH_TONE: Record<string, string> = { high: 'positive', medium: 'medium', low: 'low' }

export function BenchmarksPage() {
  const [accounts, setAccounts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<any>('/content/benchmarks').then(d => {
      // 把各次对标分析的候选账号摊平、按账号去重(留最高潜力的)
      const map = new Map<string, any>()
      for (const run of (d.benchmarks || [])) {
        for (const c of (run.payload?.candidateAnalyses || [])) {
          const name = c.authorName || c.key || ''
          if (!name) continue
          const prev = map.get(name)
          const enriched = { ...c, keyword: run.keyword, platform: run.platform }
          if (!prev || rank(enriched.growthPotential) < rank(prev.growthPotential)) map.set(name, enriched)
        }
      }
      setAccounts([...map.values()].sort((a, b) => rank(a.growthPotential) - rank(b.growthPotential)))
    }).catch(console.error).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <p className="text-[13px] text-muted-foreground">在扩展里跑「找对标账号」,沉淀的对标号会按生长势能汇总到这里 —— 看哪些账号值得对标、为什么。同一账号若也在传负面,会与监控源关联(后续打通)。</p>

      {accounts.length === 0 ? (
        <EmptyState icon={Users2} title="还没有对标账号"
          description="在扩展搜索结果页点「找对标账号」;分析出的候选账号、生长势能、推荐理由会自动存进来。" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a, i) => (
            <div key={i} className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-xs">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-status-purple/12 text-sm font-bold text-purple-600 dark:text-purple-400">
                  {(a.authorName || '?').slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold">{a.authorName || '未知账号'}</div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <StatusBadge tone={GROWTH_TONE[a.growthPotential] || 'low'}><TrendingUp className="mr-0.5 h-2.5 w-2.5" />{GROWTH_LABEL[a.growthPotential] || '一般'}</StatusBadge>
                    {a.platform && <StatusBadge tone="neutral">{platformName(a.platform)}</StatusBadge>}
                  </div>
                </div>
              </div>
              {a.recommendationReason && <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{a.recommendationReason}</p>}
              {a.focusAssessment && <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-foreground/60"><span className="font-medium">关注点:</span>{a.focusAssessment}</p>}
              {Array.isArray(a.tags) && a.tags.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1">
                  {a.tags.slice(0, 4).map((t: string, j: number) => (
                    <span key={j} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t}</span>
                  ))}
                </div>
              )}
              {a.keyword && <div className="mt-2.5 inline-flex items-center gap-1 text-[10.5px] text-muted-foreground"><Sparkles className="h-2.5 w-2.5" />来自赛道「{a.keyword}」</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function rank(g: string): number { return g === 'high' ? 1 : g === 'medium' ? 2 : 3 }
