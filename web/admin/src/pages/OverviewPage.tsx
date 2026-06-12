import { useEffect, useState } from 'react'
import {
  Activity, AlertOctagon, Inbox, Loader2, ShieldAlert, ArrowRight,
  Radio, Heart, MessageCircle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { compact, formatNumber, formatDate, platformName, cn } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { RecordDrawer } from '@/components/shared/RecordDrawer'
import { useNav } from '@/lib/navigation'
import { useBadges } from '@/lib/badges'
import { useAuth } from '@/lib/auth'

interface OverviewData {
  kpi: Record<string, number>
  sentimentBreakdown: { negative: number; neutral: number; positive: number; unlabeled: number; total: number }
  platformRisk: Array<{ platform: string; total: number; negative: number }>
  pendingRecords: any[]
}

export function OverviewPage() {
  const { navigate } = useNav()
  const { badges } = useBadges()
  const { canWrite } = useAuth()
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawer, setDrawer] = useState<any>(null)

  useEffect(() => {
    api.get<OverviewData>('/workspace/overview?days=7').then(setData).catch(console.error).finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  const k = data?.kpi || {}
  const sb = data?.sentimentBreakdown || { negative: 0, neutral: 0, positive: 0, unlabeled: 0, total: 0 }
  const negRatio = sb.total ? Math.round((sb.negative / sb.total) * 100) : 0
  const events = data?.pendingRecords || []
  const handled = Number(k.issue_linked || 0)
  const activeTotal = Number(k.unhandled || 0) + Number(k.reviewing || 0) + handled
  const handledPct = activeTotal ? Math.round((handled / activeTotal) * 100) : 0

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      {/* 顶部状态条 */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-green opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-status-green" /></span>
          实时值守中 · 近 7 日
        </span>
      </div>

      {/* Numbers 行 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <NumberCard label="全网声量" value={formatNumber(k.total_interaction)} sub={`周期新增 ${formatNumber(k.period_new)}`} icon={Radio} onClick={() => navigate('data')} />
        <NumberCard label="待分诊" value={formatNumber(badges.triagePending)} sub="待人工研判" tone="orange" icon={Inbox} onClick={() => navigate('workbench', { queue: 'triage' })} />
        <NumberCard label="累计负面" value={formatNumber(sb.negative)} sub={`负面占比 ${negRatio}%`} tone="red" icon={ShieldAlert} onClick={() => navigate('workbench', { queue: 'triage', sentiment: 'negative' })} />
        <NumberCard label="开放问题" value={formatNumber(k.open_issues)} sub={`高优 ${formatNumber(k.high_open_issues)}`} tone={Number(k.high_open_issues || 0) > 0 ? 'red' : 'default'} icon={AlertOctagon} onClick={() => navigate('workbench', { queue: 'issues' })} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        {/* 左:情感结构 + 分平台风险 */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-xs">
          <h2 className="text-[13px] font-semibold tracking-tight">情感结构</h2>
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted">
            <div className="bg-status-red" style={{ width: pct(sb.negative, sb.total) }} />
            <div className="bg-status-grey" style={{ width: pct(sb.neutral, sb.total) }} />
            <div className="bg-status-green" style={{ width: pct(sb.positive, sb.total) }} />
          </div>
          <div className="mt-2.5 flex items-center justify-between text-[11px]">
            <span className="font-medium text-status-red">负面 {formatNumber(sb.negative)}</span>
            <span className="text-muted-foreground">中性 {formatNumber(sb.neutral)}</span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">正面 {formatNumber(sb.positive)}</span>
          </div>

          <h2 className="mt-5 text-[13px] font-semibold tracking-tight">分平台风险</h2>
          <div className="mt-3 space-y-2.5">
            {(data?.platformRisk || []).filter(p => p.platform).slice(0, 5).map(p => {
              const ratio = p.total ? p.negative / p.total : 0
              const color = ratio >= 0.2 ? 'bg-status-red' : ratio >= 0.08 ? 'bg-status-orange' : 'bg-status-green'
              return (
                <div key={p.platform} className="flex items-center gap-2.5 text-[11px]">
                  <span className="w-12 shrink-0 text-muted-foreground">{platformName(p.platform)}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', color)} style={{ width: `${Math.max(4, Math.round(ratio * 100))}%` }} /></div>
                  <span className={cn('w-7 shrink-0 text-right font-semibold tabular-nums', ratio >= 0.2 ? 'text-status-red' : 'text-muted-foreground')}>{formatNumber(p.negative)}</span>
                </div>
              )
            })}
          </div>
        </section>

        {/* 右:风险事件流 + 处置进度 */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight">风险事件流</h2>
            <button onClick={() => navigate('workbench', { queue: 'triage' })} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary">全部处置 <ArrowRight className="h-3 w-3" /></button>
          </div>
          {events.length === 0 ? (
            <div className="py-8"><EmptyState icon={Activity} title="暂无待处置风险" description="所有舆情已处置完毕" /></div>
          ) : (
            <div className="mt-3 space-y-2">
              {events.slice(0, 6).map(r => {
                const tone = r.sentiment === 'negative' ? 'negative' : r.sentiment === 'positive' ? 'positive' : 'neutral'
                const accent = r.sentiment === 'negative' ? 'border-l-status-red' : r.sentiment === 'positive' ? 'border-l-status-green' : 'border-l-status-blue'
                const interactions = Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0)
                return (
                  <button key={r.id} onClick={() => setDrawer(r)}
                    className={cn('flex w-full items-center gap-3 rounded-r-lg border border-l-[3px] border-border bg-card px-3 py-2.5 text-left transition-all hover:shadow-xs hover:border-input', accent)}>
                    <StatusBadge tone={tone}>{tone === 'negative' ? '负面' : tone === 'positive' ? '正面' : '中性'}</StatusBadge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{r.title || compact(r.content || '', 40) || '(无标题)'}</div>
                      <div className="mt-0.5 flex items-center gap-2.5 text-[10.5px] text-muted-foreground">
                        <span>{platformName(r.platform)}</span>
                        <span className="inline-flex items-center gap-0.5"><Heart className="h-2.5 w-2.5" />{formatNumber(r.likes)}</span>
                        <span className="inline-flex items-center gap-0.5"><MessageCircle className="h-2.5 w-2.5" />{formatNumber(r.comments_count)}</span>
                        {Number(r.alert_count) > 0 && <span className="font-medium text-status-red">预警 {r.alert_count}</span>}
                        <span className="ml-auto">{formatDate(r.last_seen_at)}</span>
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] font-medium text-primary">处置</span>
                  </button>
                )
              })}
            </div>
          )}

          {/* 处置进度电池条 */}
          <div className="mt-4 border-t border-border pt-3.5">
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground"><span>处置进度(已关联问题 / 活跃)</span><span className="tabular-nums">{formatNumber(handled)} / {formatNumber(activeTotal)}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-status-green transition-all" style={{ width: `${handledPct}%` }} /></div>
          </div>
        </section>
      </div>

      {drawer && (
        <RecordDrawer record={drawer} onClose={() => setDrawer(null)} canWrite={canWrite()} onLinkIssue={() => { navigate('workbench', { queue: 'triage' }); setDrawer(null) }} />
      )}
    </div>
  )
}

function pct(n: number, total: number): string {
  if (!total) return '0%'
  return `${(n / total) * 100}%`
}

const NUM_TONE = {
  default: 'text-foreground',
  orange: 'text-status-orange',
  red: 'text-status-red',
}

function NumberCard({ label, value, sub, icon: Icon, tone = 'default', onClick }: {
  label: string; value: string; sub?: string; icon: React.ElementType; tone?: keyof typeof NUM_TONE; onClick?: () => void
}) {
  return (
    <button onClick={onClick}
      className="group rounded-xl border border-border bg-card px-4 py-3.5 text-left shadow-xs transition-all duration-150 hover:border-primary/30 hover:shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" strokeWidth={1.8} />
      </div>
      <div className={cn('mt-2 text-[26px] font-bold leading-none tabular-nums tracking-tight', NUM_TONE[tone])}>{value}</div>
      {sub && <div className="mt-1.5 text-[10.5px] text-muted-foreground">{sub}</div>}
    </button>
  )
}
