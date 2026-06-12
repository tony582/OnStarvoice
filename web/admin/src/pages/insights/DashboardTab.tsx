import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, BarChart3, CalendarDays, Loader2, MessageSquareWarning,
  RefreshCw, ShieldCheck, Siren, TrendingUp,
} from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api } from '@/lib/api'
import { compact, formatDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'

type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'all' | 'custom'

type DashboardResponse = {
  period: {
    range: RangePreset
    label: string
    start: string
    end: string
    generatedAt: string
  }
  snapshot: any
}

const RANGE_OPTIONS: Array<{ id: RangePreset; label: string }> = [
  { id: 'today', label: '今日' },
  { id: 'yesterday', label: '昨日' },
  { id: '7d', label: '近7天' },
  { id: '30d', label: '近30天' },
  { id: '90d', label: '近90天' },
  { id: 'all', label: '全部' },
  { id: 'custom', label: '自定义' },
]

function inputDate(offsetDays = 0) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return date.toLocaleDateString('en-CA')
}

function percent(value: number) {
  const n = Number(value) || 0
  return Math.max(3, Math.min(100, n))
}

function interactions(row: any) {
  return Number(row?.likes || 0) + Number(row?.comments_count || 0) + Number(row?.collects || 0) + Number(row?.shares || 0)
}

export function DashboardTab() {
  const [range, setRange] = useState<RangePreset>('7d')
  const [start, setStart] = useState(inputDate(-6))
  const [end, setEnd] = useState(inputDate())
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ range })
      if (range === 'custom') {
        params.set('start', start)
        params.set('end', end)
      }
      const result = await api.get<DashboardResponse>('/analytics/dashboard?' + params.toString())
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据看板加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [range, start, end])

  const s = data?.snapshot
  const kpis = useMemo(() => {
    if (!s) return []
    return [
      { label: '总声量', value: s.total, icon: TrendingUp, tone: 'normal', help: '筛选范围内被采集或更新的内容' },
      { label: '新增线索', value: s.newRecords, icon: BarChart3, tone: 'normal', help: '首次进入系统的内容' },
      { label: '负面率', value: `${s.negativeRate}%`, icon: AlertTriangle, tone: Number(s.negativeRate) >= 20 ? 'danger' : 'normal', help: '负面内容 / 已标注内容' },
      { label: '负面评论', value: s.commentStats?.negative_comments || 0, icon: MessageSquareWarning, tone: (s.commentStats?.negative_comments || 0) > 0 ? 'danger' : 'normal', help: '评论层风险线索' },
      { label: '待处理', value: s.workflowStats?.active_inbox || 0, icon: Siren, tone: (s.workflowStats?.active_inbox || 0) > 0 ? 'warning' : 'normal', help: '当前待处理/待复核' },
      { label: '官方响应', value: s.officialPeriod?.record_count || 0, icon: ShieldCheck, tone: 'normal', help: '筛选范围内有官方回复的内容' },
    ]
  }, [s])

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-primary">Live Analytics</div>
            <h2 className="mt-2 text-2xl font-bold tracking-normal text-foreground">数据看板</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              <span>{data?.period?.label || '近7天'}</span>
              {data?.period?.generatedAt && <span>刷新于 {formatDate(data.period.generatedAt)}</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap rounded-lg border border-border bg-muted p-1">
              {RANGE_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setRange(option.id)}
                  className={`h-8 rounded-md px-3 text-xs font-semibold transition ${
                    range === option.id ? 'bg-card text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>
        </div>
        {range === 'custom' && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
              开始日期
              <Input type="date" className="w-[170px]" value={start} onChange={e => setStart(e.target.value)} />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
              结束日期
              <Input type="date" className="w-[170px]" value={end} onChange={e => setEnd(e.target.value)} />
            </label>
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading && !s ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !s ? (
        <EmptyState icon={BarChart3} title="暂无看板数据" />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {kpis.map(item => {
              const Icon = item.icon
              return (
                <article key={item.label} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-muted-foreground">{item.label}</div>
                    <Icon className={`h-4 w-4 ${item.tone === 'danger' ? 'text-destructive' : item.tone === 'warning' ? 'text-amber-600' : 'text-primary'}`} />
                  </div>
                  <div className={`mt-3 text-2xl font-bold tabular-nums ${item.tone === 'danger' ? 'text-destructive' : item.tone === 'warning' ? 'text-amber-600' : 'text-foreground'}`}>
                    {typeof item.value === 'number' ? formatNumber(item.value) : item.value}
                  </div>
                  <div className="mt-2 text-xs leading-5 text-muted-foreground">{item.help}</div>
                </article>
              )
            })}
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.8fr)]">
            <Panel title="声量与情绪趋势">
              <VolumeTrend rows={s.volumeTrend || []} />
            </Panel>
            <Panel title="舆情态势指数">
              <OpinionIndex snapshot={s} />
            </Panel>
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <Panel title="平台声量矩阵">
              <PlatformMatrix rows={s.platformMatrix || []} />
            </Panel>
            <Panel title="情绪结构">
              <SentimentRing rows={s.sentimentStructure || []} />
            </Panel>
            <Panel title="主题分类">
              <Distribution rows={s.category || []} labelKey="category" labelMap={LABELS.category} />
            </Panel>
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(390px,0.8fr)]">
            <Panel title="热点词云">
              <WordCloud terms={s.hotTerms || []} />
            </Panel>
            <Panel title="热词指数榜">
              <HotTermRank terms={s.hotTerms || []} />
            </Panel>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <Panel title="高风险内容">
              <RiskItems rows={s.riskItems || []} />
            </Panel>
            <Panel title="负面评论舆情">
              <CommentRisks rows={s.commentRisks || []} />
            </Panel>
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <Panel title="处置闭环">
              <WorkflowSummary snapshot={s} />
            </Panel>
            <Panel title="媒体/来源类型">
              <Distribution rows={s.mediaDistribution || []} labelKey="media_type" />
            </Panel>
            <Panel title="地域/发布位置">
              <Distribution rows={s.regionDistribution || []} labelKey="region" />
            </Panel>
          </section>
        </>
      )}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h3 className="text-sm font-bold">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function VolumeTrend({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={BarChart3} title="暂无趋势数据" />
  const data = rows.map(row => ({
    label: row.label,
    total: Number(row.total) || 0,
    negative: Number(row.negative) || 0,
    positive: Number(row.positive) || 0,
  }))
  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: 0, right: 8, top: 12, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--muted-fg)' }} />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--muted-fg)' }} width={34} />
          <Tooltip
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
            formatter={(value, name) => [formatNumber(Number(value)), name === 'negative' ? '负面' : name === 'positive' ? '正面' : '声量']}
          />
          <Area dataKey="total" type="monotone" stroke="#2563EB" fill="#2563EB" fillOpacity={0.12} strokeWidth={2.4} />
          <Area dataKey="negative" type="monotone" stroke="#DC2626" fill="#DC2626" fillOpacity={0.1} strokeWidth={2} />
          <Area dataKey="positive" type="monotone" stroke="#059669" fill="#059669" fillOpacity={0.08} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function OpinionIndex({ snapshot }: { snapshot: any }) {
  const idx = snapshot.opinionIndex || {}
  const risk = Number(idx.risk) || 0
  const response = Number(idx.response) || 0
  return (
    <div className="grid gap-4">
      <div className="rounded-lg border border-border bg-muted/40 p-4">
        <div className="text-xs font-semibold text-muted-foreground">综合舆情热度指数</div>
        <div className="mt-2 text-4xl font-black tabular-nums text-primary">{formatNumber(idx.heat || 0)}</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <StatusBadge tone={risk >= 70 ? 'critical' : risk >= 45 ? 'medium' : 'neutral'}>{idx.status || '平稳'}</StatusBadge>
          {idx.heatDelta?.value && <StatusBadge tone="muted">较前期 {idx.heatDelta.value}</StatusBadge>}
        </div>
      </div>
      <IndexBar label="风险指数" value={risk} color={risk >= 70 ? '#DC2626' : risk >= 45 ? '#D97706' : '#2563EB'} />
      <IndexBar label="处置响应指数" value={response} color="#059669" />
      <IndexBar label="负面率" value={Number(snapshot.negativeRate) || 0} color="#DC2626" suffix="%" />
    </div>
  )
}

function IndexBar({ label, value, color, suffix = '' }: { label: string; value: number; color: string; suffix?: string }) {
  return (
    <div className="grid gap-2">
      <div className="flex justify-between gap-3 text-xs font-semibold">
        <span className="text-muted-foreground">{label}</span>
        <span style={{ color }}>{formatNumber(value)}{suffix}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${percent(value)}%`, background: color }} />
      </div>
    </div>
  )
}

function PlatformMatrix({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={BarChart3} title="暂无平台数据" />
  const maxHeat = Math.max(1, ...rows.map(row => Number(row.heat) || 0))
  return (
    <div className="space-y-4">
      {rows.map(row => {
        const negativeRate = Number(row.negativeRate) || 0
        const color = negativeRate >= 30 ? '#DC2626' : negativeRate >= 12 ? '#D97706' : '#2563EB'
        return (
          <div key={row.platform || row.label} className="grid gap-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <strong>{platformName(row.platform) || row.label}</strong>
              <span className="text-xs text-muted-foreground">{formatNumber(row.count)} 条 · 负面 {negativeRate}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${percent((Number(row.heat) || 0) / maxHeat * 100)}%`, background: color }} />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>互动 {formatNumber(row.interactions)}</span>
              <span>占比 {row.share}%</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SentimentRing({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={BarChart3} title="暂无情绪数据" />
  let cursor = 0
  const stops = rows.map(row => {
    const start = cursor
    cursor += Number(row.share) || 0
    return `${row.color} ${start}% ${Math.min(100, cursor)}%`
  }).join(', ')
  const negative = rows.find(row => row.key === 'negative') || { share: 0 }
  return (
    <div className="grid gap-5 sm:grid-cols-[150px_minmax(0,1fr)]">
      <div className="mx-auto grid h-[142px] w-[142px] place-items-center rounded-full" style={{ background: `conic-gradient(${stops || '#E5E7EB 0 100%'})` }}>
        <div className="grid h-[82px] w-[82px] place-items-center rounded-full border border-border bg-card text-center">
          <div>
            <strong className="block text-xl tabular-nums">{negative.share}%</strong>
            <span className="text-[11px] text-muted-foreground">负面占比</span>
          </div>
        </div>
      </div>
      <div className="grid content-center gap-3">
        {rows.map(row => (
          <div key={row.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <i className="h-2.5 w-2.5 rounded-full" style={{ background: row.color }} />
              {row.label}
            </span>
            <strong>{formatNumber(row.count)} · {row.share}%</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function Distribution({ rows, labelKey, labelMap = {} }: { rows: any[]; labelKey: string; labelMap?: Record<string, string> }) {
  if (!rows.length) return <EmptyState icon={BarChart3} title="暂无分布数据" />
  const total = Math.max(1, rows.reduce((sum, row) => sum + Number(row.count || 0), 0))
  return (
    <div className="space-y-3">
      {rows.slice(0, 8).map(row => {
        const value = Number(row.count) || 0
        const label = labelMap[row[labelKey]] || row[labelKey] || '未采集'
        return (
          <div key={label} className="grid gap-1.5">
            <div className="flex justify-between gap-3 text-sm">
              <span className="truncate">{label}</span>
              <strong>{formatNumber(value)} · {Math.round(value / total * 100)}%</strong>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent(value / total * 100)}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function WordCloud({ terms }: { terms: any[] }) {
  if (!terms.length) return <EmptyState icon={BarChart3} title="暂无热点词" />
  const colors = ['text-primary', 'text-emerald-600', 'text-amber-600', 'text-violet-600', 'text-destructive']
  return (
    <div className="flex min-h-[220px] flex-wrap content-center items-center justify-center gap-x-4 gap-y-3">
      {terms.slice(0, 36).map((term, index) => (
        <span
          key={`${term.label}-${index}`}
          className={`font-bold leading-none ${colors[Number(term.tone) % colors.length]}`}
          style={{ fontSize: `${Number(term.weight) || 14}px` }}
          title={`${term.label} · ${term.count}`}
        >
          {term.label}
        </span>
      ))}
    </div>
  )
}

function HotTermRank({ terms }: { terms: any[] }) {
  if (!terms.length) return <EmptyState icon={BarChart3} title="暂无热词排行" />
  return (
    <div className="divide-y divide-border">
      {terms.slice(0, 10).map((term, index) => (
        <div key={`${term.label}-${index}`} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-primary/10 text-xs font-black text-primary">{index + 1}</span>
          <span className="truncate text-sm font-semibold">{term.label}</span>
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">{formatNumber(term.count)}</span>
        </div>
      ))}
    </div>
  )
}

function RiskItems({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={AlertTriangle} title="暂无高风险内容" />
  return (
    <div className="space-y-3">
      {rows.slice(0, 6).map(row => {
        const cover = row.cover_url || row.record_cover_url || ''
        const title = row.title || row.record_title || compact(row.content || '', 50) || '无标题'
        return (
          <article key={row.id || title} className="grid grid-cols-[58px_minmax(0,1fr)] gap-3 rounded-lg border border-border p-3">
            <div className="grid h-[58px] w-[58px] place-items-center overflow-hidden rounded-md border border-border bg-muted text-[11px] text-muted-foreground">
              {cover ? <img src={cover} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" /> : '无图'}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold">{title}</div>
              <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{row.ai_summary || row.content || '暂无摘要'}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge tone="neutral">{platformName(row.platform)}</StatusBadge>
                <span>{row.author_name || row.record_author_name || '未知作者'}</span>
                <span>{formatNumber(interactions(row))} 互动</span>
                {row.negative_comment_count > 0 && <StatusBadge tone="negative">负评 {formatNumber(row.negative_comment_count)}</StatusBadge>}
              </div>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function CommentRisks({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={MessageSquareWarning} title="暂无负面评论" />
  return (
    <div className="divide-y divide-border">
      {rows.slice(0, 7).map(row => (
        <div key={row.id || row.content} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-center justify-between gap-3">
            <strong className="text-sm">{row.author_name || '匿名评论者'}</strong>
            <StatusBadge tone={row.risk_level || 'negative'}>{row.risk_level || 'negative'}</StatusBadge>
          </div>
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-foreground">{row.content}</div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{compact(row.record_title || '原帖', 32)}</span>
            <span>{formatNumber(row.like_count)} 赞</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function WorkflowSummary({ snapshot }: { snapshot: any }) {
  const rows = [
    ['待处理/复核', snapshot.workflowStats?.active_inbox || 0, 'unhandled'],
    ['已转问题', snapshot.workflowStats?.issue_linked || 0, 'issue_linked'],
    ['官方已响应', snapshot.workflowStats?.official_responded || 0, 'official_responded'],
    ['已归档', snapshot.workflowStats?.archived || 0, 'archived'],
    ['误报', snapshot.workflowStats?.false_positive || 0, 'false_positive'],
    ['未关闭问题', snapshot.issueStats?.open_issues || 0, 'medium'],
  ]
  return (
    <div className="grid gap-3">
      {rows.map(([label, value, tone]) => (
        <div key={label} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
          <span className="text-sm text-muted-foreground">{label}</span>
          <StatusBadge tone={String(tone)}>{formatNumber(Number(value) || 0)}</StatusBadge>
        </div>
      ))}
    </div>
  )
}
