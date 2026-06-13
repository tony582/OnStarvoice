import { useEffect, useState } from 'react'
import {
  Loader2, TrendingUp, Users2, Hash, Lightbulb, Flame, ArrowRight, Sparkles, Target,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useNav } from '@/lib/navigation'

const HEAT_LABEL: Record<string, string> = { high: '高热', medium: '中等', low: '低热' }
const HEAT_TONE: Record<string, string> = { high: 'high', medium: 'medium', low: 'low' }
const GROWTH_LABEL: Record<string, string> = { high: '高潜力', medium: '稳定', low: '一般' }
const GROWTH_TONE: Record<string, string> = { high: 'positive', medium: 'medium', low: 'low' }

export function ContentHomePage() {
  const { navigate } = useNav()
  const [tracks, setTracks] = useState<any[]>([])
  const [accounts, setAccounts] = useState<any[]>([])
  const [angles, setAngles] = useState<any[]>([])
  const [keywordCount, setKeywordCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get<any>('/content/tracks').catch(() => ({ tracks: [] })),
      api.get<any>('/content/benchmarks').catch(() => ({ benchmarks: [] })),
      api.get<any>('/content/keywords').catch(() => ({ keywords: [] })),
    ]).then(([t, b, k]) => {
      const tk = t.tracks || []
      setTracks(tk)
      // 选题灵感:从赛道的 recommendedAngles 摊平
      const ang: any[] = []
      for (const tr of tk) for (const a of (tr.payload?.recommendedAngles || [])) ang.push({ ...a, keyword: tr.keyword })
      setAngles(ang)
      // 对标账号摊平去重
      const map = new Map<string, any>()
      for (const run of (b.benchmarks || [])) for (const c of (run.payload?.candidateAnalyses || [])) {
        const name = c.authorName || c.key
        if (name && !map.has(name)) map.set(name, { ...c, keyword: run.keyword })
      }
      setAccounts([...map.values()].sort((x, y) => rank(x.growthPotential) - rank(y.growthPotential)))
      setKeywordCount((k.keywords || []).reduce((s: number, r: any) => s + Number(r.keyword_count || 0), 0))
    }).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  const empty = tracks.length === 0 && accounts.length === 0 && keywordCount === 0
  if (empty) {
    return <EmptyState icon={Sparkles} title="内容创意面还没有数据"
      description="在扩展侧边栏跑「判断赛道机会 / 找对标账号 / 长尾扩词」,结果会自动汇总,这里就会出现赛道动态、对标账号和选题灵感。" />
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      {/* Numbers */}
      <div className="grid grid-cols-3 gap-3">
        <Num label="赛道" value={formatNumber(tracks.length)} icon={TrendingUp} onClick={() => navigate('tracks')} />
        <Num label="对标账号" value={formatNumber(accounts.length)} icon={Users2} onClick={() => navigate('benchmarks')} />
        <Num label="长尾词" value={formatNumber(keywordCount)} icon={Hash} onClick={() => navigate('keywords')} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {/* 选题灵感 */}
        <Panel title="今日选题灵感" icon={Lightbulb} onMore={tracks.length ? () => navigate('tracks') : undefined}>
          {angles.length === 0 ? (
            <Hint>跑赛道策略后,推荐选题会出现在这里</Hint>
          ) : (
            <div className="space-y-2">
              {angles.slice(0, 6).map((a, i) => (
                <button key={i} onClick={() => navigate('tracks')} className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-input">
                  <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-green" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium leading-snug">{a.title}</div>
                    {a.audiencePainPoint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{a.audiencePainPoint}</div>}
                  </div>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.keyword}</span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          {/* 热门赛道 */}
          <Panel title="热门赛道" icon={Flame} onMore={tracks.length ? () => navigate('tracks') : undefined}>
            {tracks.length === 0 ? <Hint>暂无赛道</Hint> : (
              <div className="divide-y divide-border">
                {tracks.slice(0, 5).map(t => (
                  <button key={t.id} onClick={() => navigate('tracks')} className="flex w-full items-center gap-2 py-2 text-left first:pt-0 last:pb-0">
                    <StatusBadge tone={HEAT_TONE[t.heat_level] || 'low'}>{HEAT_LABEL[t.heat_level] || '—'}</StatusBadge>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.keyword}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{t.angle_count} 选题</span>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          {/* 高潜力对标账号 */}
          <Panel title="高潜力对标账号" icon={Users2} onMore={accounts.length ? () => navigate('benchmarks') : undefined}>
            {accounts.length === 0 ? <Hint>暂无对标账号</Hint> : (
              <div className="space-y-2">
                {accounts.slice(0, 4).map((a, i) => (
                  <button key={i} onClick={() => navigate('benchmarks')} className="flex w-full items-center gap-2.5 text-left">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-status-purple/12 text-[11px] font-bold text-purple-600 dark:text-purple-400">{(a.authorName || '?').slice(0, 1)}</div>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.authorName || '未知账号'}</span>
                    <StatusBadge tone={GROWTH_TONE[a.growthPotential] || 'low'}>{GROWTH_LABEL[a.growthPotential] || '一般'}</StatusBadge>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}

function rank(g: string): number { return g === 'high' ? 1 : g === 'medium' ? 2 : 3 }

function Num({ label, value, icon: Icon, onClick }: { label: string; value: string; icon: React.ElementType; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group rounded-xl border border-border bg-card px-4 py-3.5 text-left shadow-xs transition-all hover:border-primary/30 hover:shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" strokeWidth={1.8} />
      </div>
      <div className="mt-2 text-[26px] font-bold leading-none tabular-nums">{value}</div>
    </button>
  )
}

function Panel({ title, icon: Icon, onMore, children }: { title: string; icon: React.ElementType; onMore?: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card shadow-xs">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="inline-flex items-center gap-1.5 text-[13px] font-semibold"><Icon className="h-3.5 w-3.5 text-muted-foreground" />{title}</h2>
        {onMore && <button onClick={onMore} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary">查看全部 <ArrowRight className="h-3 w-3" /></button>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="py-6 text-center text-[12px] text-muted-foreground">{children}</div>
}
