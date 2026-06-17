import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import cloud from 'd3-cloud'
import {
  AlertTriangle, BarChart3, CalendarDays, Loader2, MessageSquareWarning, RefreshCw,
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
import { InfoHint } from '@/components/shared/InfoHint'

const ChinaMap = lazy(() => import('@/components/shared/ChinaMap'))

// 指标口径词典(给"只看报告"的客户:每个指标怎么统计/算)
const G = {
  volume: '声量=本期监测到的内容条数(去重)。含老帖在本期被再次采集到的,所以时间范围越大越接近库存量;要看"真正新增"请对照「新增内容」。不含 AI 判定不相关的内容。',
  newRecords: '新增内容=首次入库时间落在本期内的内容,即本期真正新冒出来的(声量则含老帖复采)。',
  interaction: '互动总量=点赞+评论+收藏+转发 之和。为采集那一刻的快照,非实时;本系统不采阅读/播放量,故不报"触达人数"。',
  nsr: '净情感 NSR=(正面−负面)/(正面+负面)×100,范围 −100~+100。只看正负、不计中性,比负面率更敏感反映口碑好坏。',
  negativeRate: '负面率=负面内容数 ÷ 已 AI 标注内容数 ×100%。分母不含"待标注",AI 覆盖率低时该值会被放大,请对照待标注量解读。',
  risk: '舆情风险指数(0~100)=负面率/负面评论/高危未关闭问题/告警 加权,封顶 100。≥70 重点处置,≥45 风险抬升,≥20 持续观察。是促处置的相对警戒分,非概率。',
  heat: '舆情热度指数=内容数/互动/新评论/观测 加权综合,无固定上限;数值本身无绝对含义,只看相对高低与环比。',
  official: '官方响应率=有官方回复的内容数 ÷ 总声量。',
  pending: '待处理=进入处置队列、尚未转工单也未归档的内容(已排除官方内容与"已响应且零负评")。',
  sentiment: '情感由 AI 标注为 正面/中性/负面;"待标注"单列为灰色、不并入中性。',
  platform: '平台分布=各平台内容条数与负面率;注:平台字段缺失的内容会默认归到小红书,占比可能略有偏差。',
  category: '主题分类由 AI 归入 9 类(安全救援/续费收费/服务质量 等),其中安全/续费/服务为车企高优先级风险议题。',
  topInteraction: '按 点赞+评论+收藏+转发 之和排序的高互动内容(采集时刻快照)。',
  topNegative: '重点负面=按 负评/转发/互动 加权排序的负面内容,可逐条点开核实处置。',
  negativeComment: '负面评论为评论层风险线索,带风险等级(低~严重),与内容层"负面"是两套口径。',
  workflow: '处置漏斗:待处理 → 已转工单 → 归档/误报;配合官方响应、未关闭问题看监测→处置闭环。',
  hotTerms: '热词来自标题/正文/摘要/标签的文本挖掘,与"监控关键词"(只统计监控订阅采集)口径不同。',
  media: '媒体/来源类型来自内容的类型字段(record_type / mediaType)。',
}

function delta(cur: number, prev: number) {
  const c = Number(cur) || 0, p = Number(prev) || 0
  if (!p) return null
  const d = Math.round((c - p) / p * 100)
  return { pct: Math.abs(d), up: d >= 0 }
}
function nsrOf(sm: any = {}) {
  const p = Number(sm.positive) || 0, n = Number(sm.negative) || 0
  return (p + n) ? Math.round((p - n) / (p + n) * 100) : 0
}
function sumInteractions(pm: any[] = []) {
  return pm.reduce((sum, r) => sum + (Number(r.interactions) || 0), 0)
}

// 媒体/来源类型中文(记录类型 + 笔记类型)
const MEDIA_LABELS: Record<string, string> = {
  single_note: '单篇笔记', keyword_notes: '关键词笔记', blogger_notes: '博主笔记',
  blogger_profile: '博主主页', official_content: '官方内容', comments: '评论',
  normal: '图文笔记', video: '视频', image: '图文', article: '文章', text: '文字', live: '直播',
  '未采集': '未知类型', '': '未知类型',
}
// 平台品牌色点(让平台板块更有辨识度)
const PLATFORM_DOT: Record<string, string> = { xiaohongshu: 'bg-status-red', douyin: 'bg-foreground', weibo: 'bg-status-orange' }

function mergeRegions(a: any[] = [], b: any[] = []) {
  const m = new Map<string, { region: string; count: number; negative_count: number }>()
  for (const r of [...a, ...b]) {
    const k = r.region || '未采集'
    const cur = m.get(k) || { region: k, count: 0, negative_count: 0 }
    cur.count += Number(r.count) || 0
    cur.negative_count += Number(r.negative_count) || 0
    m.set(k, cur)
  }
  return [...m.values()].sort((x, y) => y.count - x.count)
}

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
          {/* 1. 执行摘要 —— 结论先行 */}
          <ExecutiveSummary s={s} />

          {/* 2. 声量总览与趋势 */}
          <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.8fr)]">
            <Panel title="声量总览与趋势" hint={G.volume}
              note={`本期声量 ${formatNumber(s.total)} 条(新增 ${formatNumber(s.newRecords)}、复现 ${formatNumber(s.updatedRecords)}),${trendNote(s)}`}>
              <VolumeTrend rows={s.volumeTrend || []} />
            </Panel>
            <Panel title="舆情态势指数" hint={G.heat}>
              <OpinionIndex snapshot={s} />
            </Panel>
          </section>

          {/* 3. 情感 / 4. 平台 / 主题 */}
          <section className="grid gap-4 xl:grid-cols-3">
            <Panel title="情感分析" hint={G.sentiment}
              note={`负面率 ${s.negativeRate}%、净情感 NSR ${nsrOf(s.sentimentMap)}${(s.pendingLabel || 0) > 0 ? `;另有 ${formatNumber(s.pendingLabel)} 条待 AI 标注` : ''}`}>
              <SentimentRing rows={s.sentimentStructure || []} />
            </Panel>
            <Panel title="平台分布" hint={G.platform} note={platformNote(s)}>
              <PlatformMatrix rows={s.platformMatrix || []} />
            </Panel>
            <Panel title="主题分类" hint={G.category}>
              <Distribution rows={s.category || []} labelKey="category" labelMap={LABELS.category} />
            </Panel>
          </section>

          {/* 5. 高影响内容 */}
          <section className="grid gap-4 xl:grid-cols-2">
            <Panel title="高互动内容 TOP" hint={G.topInteraction}>
              <TopContent rows={s.topInteraction || []} />
            </Panel>
            <Panel title="重点负面内容" hint={G.topNegative}>
              <RiskItems rows={s.riskItems || s.topNegative || []} />
            </Panel>
          </section>

          {/* 6. 负面预警 / 7. 处置闭环 */}
          <section className="grid gap-4 xl:grid-cols-2">
            <Panel title="负面评论与风险" hint={G.negativeComment}
              note={`本期负面评论 ${formatNumber(s.commentStats?.negative_comments || 0)} 条${(s.issueStats?.high_open_issues || 0) > 0 ? `,高危未关闭问题 ${formatNumber(s.issueStats.high_open_issues)} 个` : ''}`}>
              <CommentRisks rows={s.commentRisks || s.negativeComments || []} />
            </Panel>
            <Panel title="处置与闭环" hint={G.workflow} note={workflowNote(s)}>
              <WorkflowSummary snapshot={s} />
            </Panel>
          </section>

          {/* 更多维度 */}
          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(390px,0.8fr)]">
            <Panel title="热点词云" hint={G.hotTerms}>
              <WordCloud terms={s.hotTerms || []} />
            </Panel>
            <Panel title="热词指数榜" hint={G.hotTerms}>
              <HotTermRank terms={s.hotTerms || []} />
            </Panel>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <Panel title="媒体/来源类型" hint={G.media}>
              <Distribution rows={s.mediaDistribution || []} labelKey="media_type" labelMap={MEDIA_LABELS} />
            </Panel>
            <Panel title="重点账号 / 作者影响力" hint="按负面数与互动量综合排序的作者;影响力≈粉丝×互动(近似,非平台官方指数)。">
              <AuthorRank rows={s.topAuthors || []} />
            </Panel>
          </section>

          {/* 地域地图(整行,中国省级填色)*/}
          <RegionPanel content={s.regionDistribution || []} comment={s.commentRegionDistribution || []} />

          {/* 结论与建议 */}
          <Panel title="结论与建议" hint="由本期各项异动自动生成的处置建议(actionable)。">
            <Recommendations items={s.actionItems || s.actionRecommendations || []} />
          </Panel>
        </>
      )}
    </div>
  )
}

function Panel({ title, hint, note, children }: { title: string; hint?: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">{title}{hint && <InfoHint text={hint} />}</h3>
      </div>
      <div className="p-5">
        {children}
        {note && <p className="mt-3 border-t border-border/50 pt-2.5 text-[11.5px] leading-5 text-muted-foreground"><span className="font-semibold text-foreground">解读 · </span>{note}</p>}
      </div>
    </section>
  )
}

function trendNote(s: any) {
  const d = delta(s.total, s.previous?.total)
  return d ? `较上期${d.up ? '上升' : '下降'} ${d.pct}%` : '暂无可比上期'
}
function platformNote(s: any) {
  const rows = s.platformMatrix || []
  if (!rows.length) return ''
  const top = rows[0]
  const worst = [...rows].sort((a, b) => (Number(b.negativeRate) || 0) - (Number(a.negativeRate) || 0))[0]
  return `主战场「${platformName(top.platform)}」占 ${top.share}%;负面最集中「${platformName(worst.platform)}」(${Number(worst.negativeRate) || 0}%)`
}
function workflowNote(s: any) {
  const w = s.workflowStats || {}
  const officialRate = s.total ? Math.round((s.officialPeriod?.record_count || 0) / s.total * 100) : 0
  return `待处理 ${formatNumber(w.active_inbox || 0)}、已转工单 ${formatNumber(w.issue_linked || 0)};官方响应率 ${officialRate}%`
}

function ExecutiveSummary({ s }: { s: any }) {
  const prev = s.previous || {}
  const risk = Number(s.opinionIndex?.risk) || 0
  const status = s.opinionIndex?.status || '平稳'
  const lightCls = risk >= 70 ? 'bg-status-red' : risk >= 45 ? 'bg-status-amber' : 'bg-status-green'
  const riskTone = risk >= 70 ? 'critical' : risk >= 45 ? 'medium' : 'positive'
  const nsr = nsrOf(s.sentimentMap)
  const interaction = sumInteractions(s.platformMatrix)
  const officialRate = s.total ? Math.round((s.officialPeriod?.record_count || 0) / s.total * 100) : 0
  const negRate = Number(s.negativeRate) || 0
  const stats = [
    { label: '总声量', value: formatNumber(s.total), d: delta(s.total, prev.total), tone: 'accent', hint: G.volume },
    { label: '互动总量', value: formatNumber(interaction), tone: 'accent', hint: G.interaction },
    { label: '净情感 NSR', value: nsr, d: delta(nsr, nsrOf(prev.sentimentMap)), tone: nsr < 0 ? 'danger' : 'normal', hint: G.nsr },
    { label: '风险指数', value: risk, tone: risk >= 70 ? 'danger' : risk >= 45 ? 'warning' : 'normal', hint: G.risk },
    { label: '负面率', value: `${negRate}%`, d: delta(negRate, prev.negativeRate), tone: negRate >= 20 ? 'danger' : 'normal', hint: G.negativeRate },
    { label: '新增内容', value: formatNumber(s.newRecords), d: delta(s.newRecords, prev.newRecords), hint: G.newRecords },
    { label: '待处理', value: formatNumber(s.workflowStats?.active_inbox || 0), tone: (s.workflowStats?.active_inbox || 0) > 0 ? 'warning' : 'normal', hint: G.pending },
    { label: '官方响应率', value: `${officialRate}%`, hint: G.official },
  ]
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={`h-2.5 w-2.5 rounded-full ${lightCls}`} />
        <h2 className="text-base font-bold">执行摘要</h2>
        <StatusBadge tone={riskTone}>风险{status}</StatusBadge>
      </div>
      <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
        本期共监测 <strong className="text-foreground">{formatNumber(s.total)}</strong> 条内容(新增 {formatNumber(s.newRecords)}),
        负面率 <strong className="text-foreground">{negRate}%</strong>、净情感 NSR <strong className="text-foreground">{nsr}</strong>,
        舆情风险指数 <strong className="text-foreground">{risk}</strong>({status});待处理 {formatNumber(s.workflowStats?.active_inbox || 0)} 条,官方响应率 {officialRate}%。
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(st => <Stat key={st.label} {...st} />)}
      </div>
    </section>
  )
}

function Stat({ label, value, d, tone, hint }: { label: string; value: React.ReactNode; d?: { pct: number; up: boolean } | null; tone?: string; hint?: string }) {
  const bg = tone === 'danger' ? 'bg-status-red/[0.07] ring-1 ring-status-red/15'
    : tone === 'warning' ? 'bg-status-amber/[0.10] ring-1 ring-status-amber/20'
      : tone === 'accent' ? 'bg-primary/[0.06] ring-1 ring-primary/15'
        : 'bg-muted/40'
  const valColor = tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-amber-600' : tone === 'accent' ? 'text-primary' : 'text-foreground'
  return (
    <div className={`rounded-lg p-3.5 ${bg}`}>
      <div className="flex items-center gap-1 text-[12px] text-muted-foreground">{label}{hint && <InfoHint text={hint} />}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className={`text-[22px] font-bold tabular-nums ${valColor}`}>{value}</span>
        {d && <span className="text-[11px] font-semibold text-muted-foreground">{d.up ? '↑' : '↓'}{d.pct}%</span>}
      </div>
    </div>
  )
}

function TopContent({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={BarChart3} title="暂无内容" />
  return (
    <div className="divide-y divide-border">
      {rows.slice(0, 8).map((row, i) => (
        <div key={row.id || i} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-primary/10 text-xs font-black text-primary">{i + 1}</span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{row.title || compact(row.content || '', 40) || '无标题'}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <StatusBadge tone="neutral">{platformName(row.platform)}</StatusBadge>
              <span className="truncate">{row.author_name || '未知作者'}</span>
            </div>
          </div>
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">{formatNumber(interactions(row))}</span>
        </div>
      ))}
    </div>
  )
}

function AuthorRank({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={BarChart3} title="暂无账号数据" />
  return (
    <div className="divide-y divide-border">
      {rows.slice(0, 8).map((r, i) => (
        <div key={r.author_name || i} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-primary/10 text-xs font-black text-primary">{i + 1}</span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{r.author_name || '未知作者'}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">粉丝 {formatNumber(r.author_fans)} · {formatNumber(r.count)} 条{Number(r.negative_count) > 0 ? ` · 负面 ${formatNumber(r.negative_count)}` : ''}</div>
          </div>
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">{formatNumber(r.interaction_total)} 互动</span>
        </div>
      ))}
    </div>
  )
}

function Recommendations({ items }: { items: any[] }) {
  if (!items.length) return <EmptyState icon={AlertTriangle} title="本周期无显著风险" />
  return (
    <ol className="space-y-2.5">
      {items.slice(0, 7).map((it, i) => {
        const text = typeof it === 'string' ? it : (it?.text || it?.title || String(it))
        return (
          <li key={i} className="flex gap-2.5 text-[13px] leading-6">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">{i + 1}</span>
            <span className="text-foreground">{text}</span>
          </li>
        )
      })}
    </ol>
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
              <strong className="flex items-center gap-1.5"><span className={`h-2 w-2 shrink-0 rounded-full ${PLATFORM_DOT[row.platform] || 'bg-muted-foreground/40'}`} />{platformName(row.platform) || row.label}</strong>
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

function RegionPanel({ content, comment }: { content: any[]; comment: any[] }) {
  const [mode, setMode] = useState<'all' | 'content' | 'comment'>('all')
  const rows = mode === 'content' ? content : mode === 'comment' ? comment : mergeRegions(content, comment)
  const note = mode === 'content'
    ? '内容地域:博主内容沿用其作者属地回填,仍取不到才记未采集'
    : mode === 'comment'
      ? '评论地域:取评论自带的 IP 属地,平台原生最全'
      : '全部:内容(作者属地)+ 评论(评论IP)合并,覆盖最全的地域大盘'
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">地域/发布位置<InfoHint text="地域=内容作者属地 + 评论 IP 属地。默认「全部」合并两者(最全);可切单看。内容侧大量「未采集」是源头限制,评论侧最完整。" /></h3>
        <div className="inline-flex rounded-lg bg-muted p-0.5 text-[12px] font-semibold">
          {([['all', '全部'], ['content', '内容'], ['comment', '评论']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`rounded-md px-2.5 py-1 transition-colors ${mode === k ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
        <div>
          <Suspense fallback={<div className="grid h-[280px] place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
            <ChinaMap rows={rows} />
          </Suspense>
        </div>
        <div className="lg:border-l lg:border-border/50 lg:pl-5">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">省份排行</div>
          <Distribution rows={rows} labelKey="region" />
          <p className="mt-3 text-[11px] text-muted-foreground">{note}</p>
        </div>
      </div>
    </section>
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

const CLOUD_COLORS = ['#2563EB', '#E11D48', '#059669', '#D97706', '#7C3AED', '#0EA5E9', '#DB2777']

function WordCloud({ terms }: { terms: any[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(560)
  const [placed, setPlaced] = useState<any[]>([])
  const H = 300

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(Math.max(280, el.clientWidth || 560))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!terms.length || !width) { setPlaced([]); return }
    const top = terms.slice(0, 50)
    const ws = top.map(t => Number(t.weight) || Number(t.count) || 1)
    const max = Math.max(...ws, 1), min = Math.min(...ws)
    const words = top.map((t, i) => {
      const v = Number(t.weight) || Number(t.count) || 1
      return {
        text: String(t.label || ''),
        size: Math.round(14 + (v - min) / (max - min || 1) * 30),
        count: Number(t.count) || 0,
        tone: Number(t.tone) || i,
      }
    })
    let cancelled = false
    const layout = cloud()
      .size([width, H])
      .words(words as any)
      .padding(2)
      .rotate(() => (Math.random() < 0.22 ? 90 : 0))
      .font('sans-serif')
      .fontSize((d: any) => d.size)
      .on('end', (out: any[]) => { if (!cancelled) setPlaced(out) })
    layout.start()
    return () => { cancelled = true; layout.stop() }
  }, [terms, width])

  if (!terms.length) return <EmptyState icon={BarChart3} title="暂无热点词" />
  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={H} className="w-full" style={{ display: 'block' }}>
        <g transform={`translate(${width / 2},${H / 2})`}>
          {placed.map((d, i) => (
            <text
              key={`${d.text}-${i}`}
              textAnchor="middle"
              transform={`translate(${d.x},${d.y}) rotate(${d.rotate})`}
              fontSize={d.size}
              fontWeight={700}
              fill={CLOUD_COLORS[d.tone % CLOUD_COLORS.length]}
              style={{ cursor: 'default' }}
            >
              <title>{d.text} · {formatNumber(d.count)}</title>
              {d.text}
            </text>
          ))}
        </g>
      </svg>
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
    ['已转工单', snapshot.workflowStats?.issue_linked || 0, 'issue_linked'],
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
