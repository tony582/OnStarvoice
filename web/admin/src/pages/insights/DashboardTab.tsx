import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import cloud from 'd3-cloud'
import {
  AlertTriangle, BarChart3, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Download, Loader2,
  MessageSquareWarning, RefreshCw, Sparkles, Star, X,
} from 'lucide-react'
import { KeywordFilter } from '@/components/shared/KeywordFilter'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api } from '@/lib/api'
import { compact, formatDate, formatNumber, LABELS, platformName, proxiedImg } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { InfoHint } from '@/components/shared/InfoHint'
import { NegativePatrolOverview } from '@/pages/insights/NegativePatrolTab'

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
  pending: '待处理=当前处理状态仍为“待处理”、且尚未归档的内容。其它状态均由客户按实际处置结果灵活维护。',
  sentiment: '情感由 AI 标注为 正面/中性/负面;"待标注"单列为灰色、不并入中性。',
  platform: '平台分布=各平台内容条数与负面率;注:平台字段缺失的内容会默认归到小红书,占比可能略有偏差。',
  category: '主题分类由 AI 归入 9 类(安全救援/续费收费/服务质量 等),其中安全/续费/服务为车企高优先级风险议题。',
  topInteraction: '按 点赞+评论+收藏+转发 之和排序的高互动内容(采集时刻快照)。',
  topNegative: '重点负面=按 负评/转发/互动 加权排序的负面内容,可逐条点开核实处置。',
  negativeComment: '负面评论为评论层风险线索,带风险等级(低~严重),与内容层"负面"是两套口径。',
  workflow: '处置概览按当前处理状态展示；状态可按实际结果自由切换，备注单独留痕。',
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

type CoreDimension = 'platform' | 'sentiment' | 'status'

type DashboardResponse = {
  period: {
    range: 'month'
    month: string | null
    label: string
    start: string
    end: string
    generatedAt: string
  }
  snapshot: any
}

type DrilldownSelection = { dimension: CoreDimension; value: string }
type DrilldownBreakdownRow = {
  key: string
  count: number
  share: number
  interactions: number
  negativeCount: number
}
type DashboardDrilldown = {
  selection: DrilldownSelection & { dimensionLabel: string; label: string }
  summary: {
    count: number
    shareOfPeriod: number
    interactions: number
    negativeCount: number
    negativeRate: number
  }
  breakdowns: Record<CoreDimension, DrilldownBreakdownRow[]>
}
type DashboardDrilldownResponse = { drilldown: DashboardDrilldown }

const HANDLING_STATUS_ROWS = [
  { key: 'unhandled', label: '待处理', color: '#D97706' },
  { key: 'replied', label: '已回复', color: '#059669' },
  { key: 'reviewed', label: '已复核', color: '#059669' },
  { key: 'reviewed_non_monitor', label: '已复核-非监控内容', color: '#64748B' },
  { key: 'unavailable', label: '已不可见', color: '#64748B' },
  { key: 'negative_feishu', label: '负面-飞书表', color: '#DC2626' },
  { key: 'negative_cold', label: '负面-冷处理', color: '#DC2626' },
] as const

const PLATFORM_COLOR: Record<string, string> = {
  xiaohongshu: '#DC2626',
  douyin: '#111827',
  weibo: '#D97706',
  unknown: '#94A3B8',
}

function currentShanghaiMonth() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}`
}

function shiftMonth(value: string, offset: number) {
  const [year, month] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1 + offset, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function percent(value: number) {
  const n = Number(value) || 0
  return Math.max(3, Math.min(100, n))
}

function interactions(row: any) {
  return Number(row?.likes || 0) + Number(row?.comments_count || 0) + Number(row?.collects || 0) + Number(row?.shares || 0)
}

interface FocusTopic { id: string; name: string; keywords: string[]; sort_order: number }

// 关注主题 + 采集关键词:数据看板按阶段/主题收敛。预设(存阶段)+ 临时筛选两用。
function FocusTopicBar({ keywords, setKeywords }: { keywords: string[]; setKeywords: (v: string[]) => void }) {
  const [topics, setTopics] = useState<FocusTopic[]>([])
  const [activeId, setActiveId] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const loadTopics = () => api.get<any>('/analytics/focus-topics').then(d => setTopics(d.topics || [])).catch(() => {})
  useEffect(() => { loadTopics() }, [])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [])

  const active = topics.find(t => t.id === activeId) || null
  const norm = (a: string[]) => [...(a || [])].sort().join('')
  const dirty = !!active && norm(active.keywords) !== norm(keywords)

  const pickTopic = (t: FocusTopic) => { setActiveId(t.id); setKeywords(t.keywords || []); setOpen(false) }
  const clearAll = () => { setActiveId(''); setKeywords([]) }
  const saveAsNew = async () => {
    const name = window.prompt('给这个关注主题起个名(如:新车上市期 / 壁纸功能期):')?.trim()
    if (!name) return
    setBusy(true)
    try {
      const d = await api.post<any>('/analytics/focus-topics', { name, keywords })
      await loadTopics()
      if (d?.topic?.id) setActiveId(d.topic.id)
    } finally { setBusy(false) }
  }
  const updateActive = async () => {
    if (!active) return
    setBusy(true)
    try { await api.patch('/analytics/focus-topics/' + active.id, { keywords }); await loadTopics() }
    finally { setBusy(false) }
  }
  const removeTopic = async (id: string) => {
    if (!window.confirm('删除这个关注主题?(只删主题,不影响内容)')) return
    setBusy(true)
    try { await api.delete('/analytics/focus-topics/' + id); if (activeId === id) clearAll(); await loadTopics() }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground"><Star className="h-3.5 w-3.5" />关注主题</span>
      <div className="relative" ref={ref}>
        <button type="button" onClick={() => setOpen(o => !o)}
          className={`inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2.5 text-[12px] font-medium transition hover:bg-accent ${active ? 'text-primary' : 'text-muted-foreground'}`}>
          {active ? active.name : '全部内容'}
          <ChevronDown className="h-3 w-3" />
        </button>
        {open && (
          <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-border bg-card p-1.5 shadow-lg">
            <button onClick={clearAll} className={`flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-accent ${!active ? 'font-semibold text-primary' : ''}`}>全部内容(不限主题)</button>
            {topics.map(t => (
              <div key={t.id} className="group flex items-center gap-1 rounded-md hover:bg-accent">
                <button onClick={() => pickTopic(t)} className={`flex flex-1 items-center justify-between px-2 py-1.5 text-left text-[12px] ${t.id === activeId ? 'font-semibold text-primary' : ''}`}>
                  <span className="truncate" title={t.name}>{t.name}</span>
                  <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">{(t.keywords || []).length}词</span>
                </button>
                <button onClick={() => removeTopic(t.id)} title="删除主题" className="mr-1 rounded p-0.5 text-muted-foreground opacity-0 transition hover:text-rose-600 group-hover:opacity-100"><X className="h-3 w-3" /></button>
              </div>
            ))}
            {topics.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">还没有主题。选好关键词后点「存为主题」。</div>}
          </div>
        )}
      </div>
      <KeywordFilter value={keywords} onChange={setKeywords} />
      {keywords.length > 0 && <Button variant="outline" size="sm" disabled={busy} onClick={saveAsNew}>存为主题</Button>}
      {dirty && <Button variant="outline" size="sm" disabled={busy} onClick={updateActive}>更新「{active!.name}」</Button>}
      {(keywords.length > 0 || active) && <button onClick={clearAll} className="text-[11px] text-muted-foreground hover:text-foreground">清空</button>}
    </div>
  )
}

export function DashboardTab({ onOpenPatrol }: { onOpenPatrol?: () => void }) {
  const [month, setMonth] = useState(currentShanghaiMonth)
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [keywords, setKeywords] = useState<string[]>([]) // 关注主题/临时关键词:空=全量
  const [exporting, setExporting] = useState(false)
  const [drilldownSelection, setDrilldownSelection] = useState<DrilldownSelection | null>(null)
  const [drilldownData, setDrilldownData] = useState<DashboardDrilldown | null>(null)
  const [drilldownLoading, setDrilldownLoading] = useState(false)
  const [drilldownError, setDrilldownError] = useState('')
  const drilldownRequestRef = useRef(0)

  const load = useCallback(() => Promise.resolve().then(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ range: 'month', month })
      if (keywords.length) params.set('keywords', keywords.join(','))
      const result = await api.get<DashboardResponse>('/analytics/dashboard?' + params.toString())
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据看板加载失败')
    } finally {
      setLoading(false)
    }
  }), [month, keywords])

  useEffect(() => { void load() }, [load])

  const s = data?.snapshot
  const exportMonthlyWorkbook = async () => {
    setExporting(true)
    setError('')
    try {
      const params = new URLSearchParams({ range: 'month', month })
      if (keywords.length) params.set('keywords', keywords.join(','))
      await api.download(
        '/analytics/dashboard/export?' + params.toString(),
        `${data?.period?.label || '月报'}-月报基础分析及数据源.xlsx`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const clearDrilldown = useCallback(() => {
    drilldownRequestRef.current += 1
    setDrilldownSelection(null)
    setDrilldownData(null)
    setDrilldownLoading(false)
    setDrilldownError('')
  }, [])

  useEffect(() => { clearDrilldown() }, [clearDrilldown, month, keywords])

  const drillDown = async (dimension: CoreDimension, value: string) => {
    if (drilldownSelection?.dimension === dimension && drilldownSelection.value === value) {
      clearDrilldown()
      return
    }
    const requestId = drilldownRequestRef.current + 1
    drilldownRequestRef.current = requestId
    setDrilldownSelection({ dimension, value })
    setDrilldownData(null)
    setDrilldownError('')
    setDrilldownLoading(true)
    try {
      const params = new URLSearchParams({ range: 'month', month, dimension, value })
      if (keywords.length) params.set('keywords', keywords.join(','))
      const result = await api.get<DashboardDrilldownResponse>('/analytics/dashboard/drilldown?' + params.toString())
      if (drilldownRequestRef.current === requestId) setDrilldownData(result.drilldown)
    } catch (err) {
      if (drilldownRequestRef.current === requestId) {
        setDrilldownError(err instanceof Error ? err.message : '下钻分析加载失败')
      }
    } finally {
      if (drilldownRequestRef.current === requestId) setDrilldownLoading(false)
    }
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-primary">Live Analytics</div>
            <h2 className="mt-2 text-2xl font-bold tracking-normal text-foreground">数据看板</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              <span>{data?.period?.label || '本月（月报）'}</span>
              {data?.period?.generatedAt && <span>刷新于 {formatDate(data.period.generatedAt)}</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-9 items-center gap-1 rounded-lg border border-border bg-background px-2 text-xs font-semibold text-muted-foreground" aria-label="统计月份选择">
              <span className="px-1">统计月份</span>
              <button type="button" onClick={() => setMonth(value => shiftMonth(value, -1))} className="grid h-7 w-7 place-items-center rounded-md hover:bg-accent hover:text-foreground" aria-label="上一个月">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <Input aria-label="统计月份" type="month" className="h-7 w-[138px] border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" value={month} onChange={event => setMonth(event.target.value || currentShanghaiMonth())} />
              <button type="button" onClick={() => setMonth(value => shiftMonth(value, 1))} className="grid h-7 w-7 place-items-center rounded-md hover:bg-accent hover:text-foreground" aria-label="下一个月">
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={() => void exportMonthlyWorkbook()} disabled={exporting || !s}>
              <Download className={`h-3.5 w-3.5 ${exporting ? 'animate-pulse' : ''}`} />
              {exporting ? '导出中…' : '导出月报数据'}
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>
        </div>
        <FocusTopicBar keywords={keywords} setKeywords={setKeywords} />
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
          {/* 客户基础月报：先看核心数字，再按分布下钻或导出。 */}
          <CoreMonthlyAnalysis
            snapshot={s}
            periodLabel={data?.period?.label || '月报'}
            activeSelection={drilldownSelection}
            drilldownData={drilldownData}
            drilldownLoading={drilldownLoading}
            drilldownError={drilldownError}
            onClearFilter={clearDrilldown}
            onDrillDown={(dimension, value) => void drillDown(dimension, value)}
          />

          <div className="flex items-center gap-3 pt-1" aria-label="延展分析分隔">
            <span className="shrink-0 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">延展分析</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          {/* 执行摘要与专业分析统一后移。 */}
          <ExecutiveSummary s={s} />

          {/* 数据看板只保留巡查摘要，完整趋势与升温内容在独立页面查看 */}
          <NegativePatrolOverview data={s.negativePatrol} onOpen={onOpenPatrol} />

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

          {/* 主题与评论风险属于延展维度，基础三分布已在首屏呈现。 */}
          <section className="grid gap-4 xl:grid-cols-2">
            <Panel title="主题分类" hint={G.category}>
              <Distribution rows={s.category || []} labelKey="category" labelMap={LABELS.category} />
            </Panel>
            <Panel title="负面评论与风险" hint={G.negativeComment}
              note={`本期负面评论 ${formatNumber(s.commentStats?.negative_comments || 0)} 条${(s.issueStats?.high_open_issues || 0) > 0 ? `,高危未关闭问题 ${formatNumber(s.issueStats.high_open_issues)} 个` : ''}`}>
              <CommentRisks rows={s.commentRisks || s.negativeComments || []} />
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

          {/* AI 舆情研判按需触发,不阻塞基础月报。 */}
          <AiInsightPanel month={month} />

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

type CoreDistributionRow = {
  key: string
  label: string
  count: number
  share: number
  color: string
  detail?: string
}

function CoreMonthlyAnalysis({
  snapshot,
  periodLabel,
  activeSelection,
  drilldownData,
  drilldownLoading,
  drilldownError,
  onClearFilter,
  onDrillDown,
}: {
  snapshot: any
  periodLabel: string
  activeSelection: DrilldownSelection | null
  drilldownData: DashboardDrilldown | null
  drilldownLoading: boolean
  drilldownError: string
  onClearFilter: () => void
  onDrillDown: (dimension: CoreDimension, value: string) => void
}) {
  const basePlatformRows: CoreDistributionRow[] = [...(snapshot.platformMatrix || [])]
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .map(row => {
      const key = String(row.platform || 'unknown')
      return {
        key,
        label: row.label || platformName(key) || '未知平台',
        count: Number(row.count) || 0,
        share: Number(row.share) || 0,
        color: PLATFORM_COLOR[key] || '#2563EB',
        detail: `负面 ${Number(row.negativeRate) || 0}% · 互动 ${formatNumber(row.interactions)}`,
      }
    })
  const baseSentimentRows: CoreDistributionRow[] = (snapshot.sentimentStructure || []).map((row: any) => ({
    key: String(row.key || 'pending'),
    label: row.label || LABELS.sentiment[row.key] || '待标注',
    count: Number(row.count) || 0,
    share: Number(row.share) || 0,
    color: row.color || '#94A3B8',
  }))
  const statusCount = new Map<string, number>(
    (snapshot.triagePeriod || []).map((row: any) => [String(row.status || 'unhandled'), Number(row.count) || 0]),
  )
  const statusTotal = HANDLING_STATUS_ROWS.reduce((sum, row) => sum + (statusCount.get(row.key) || 0), 0)
  const baseStatusRows: CoreDistributionRow[] = HANDLING_STATUS_ROWS.map(row => {
    const count = statusCount.get(row.key) || 0
    return {
      ...row,
      count,
      share: statusTotal ? Math.round(count / statusTotal * 100) : 0,
    }
  })

  const filterReady = Boolean(activeSelection && drilldownData)
  const crossFilteredRows = (dimension: CoreDimension, baseRows: CoreDistributionRow[]) => {
    if (!filterReady || activeSelection?.dimension === dimension) return baseRows
    const filtered = new Map<string, DrilldownBreakdownRow>(
      (drilldownData?.breakdowns[dimension] || []).map(row => [row.key, row]),
    )
    return baseRows.map(row => {
      const current = filtered.get(row.key)
      return {
        ...row,
        count: current?.count || 0,
        share: current?.share || 0,
        detail: current
          ? `互动 ${formatNumber(current.interactions)}${current.negativeCount ? ` · 负面 ${formatNumber(current.negativeCount)}` : ''}`
          : undefined,
      }
    })
  }
  const platformRows = crossFilteredRows('platform', basePlatformRows)
  const sentimentRows = crossFilteredRows('sentiment', baseSentimentRows)
  const statusRows = crossFilteredRows('status', baseStatusRows)

  const filteredStatus = new Map<string, number>(
    filterReady
      ? (drilldownData?.breakdowns.status || []).map(row => [row.key, row.count])
      : baseStatusRows.map(row => [row.key, row.count]),
  )
  const metricTotal = filterReady ? Number(drilldownData?.summary.count) || 0 : Number(snapshot.total) || 0
  const metricInteractions = filterReady
    ? Number(drilldownData?.summary.interactions) || 0
    : sumInteractions(snapshot.platformMatrix)
  const unhandled = filteredStatus.get('unhandled') || 0
  const handled = Math.max(0, metricTotal - unhandled)
  const handledRate = metricTotal ? Math.round(handled / metricTotal * 100) : 0
  const negativeCount = filterReady
    ? Number(drilldownData?.summary.negativeCount) || 0
    : Number(snapshot.sentimentMap?.negative) || 0
  const stats = [
    {
      label: filterReady ? '筛选内容' : '本期内容',
      value: formatNumber(metricTotal),
      suffix: filterReady ? `${drilldownData?.summary.shareOfPeriod || 0}%` : undefined,
      tone: 'accent',
      hint: G.volume,
    },
    { label: '互动总量', value: formatNumber(metricInteractions), tone: 'accent', hint: G.interaction },
    { label: '负面内容', value: formatNumber(negativeCount), tone: negativeCount > 0 ? 'danger' : 'normal', hint: G.sentiment },
    { label: '已处理', value: formatNumber(handled), suffix: `${handledRate}%`, tone: 'positive', hint: G.workflow },
  ]
  const filterLabel = activeSelection
    ? `${activeSelection.dimension === 'platform' ? '平台' : activeSelection.dimension === 'sentiment' ? '情感' : '处理模式'} · ${drilldownLabel(activeSelection.dimension, activeSelection.value)}`
    : ''

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="monthly-core-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="monthly-core-title" className="text-base font-bold">月报基础分析</h2>
            <StatusBadge tone="muted">{periodLabel}</StatusBadge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">三类分布始终显示；点击任一项会联动筛选顶部指标和另外两个分布。</p>
        </div>
        {activeSelection ? (
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.05] px-2.5 py-1.5 text-xs" aria-label="当前联动筛选">
            <span className="font-semibold text-primary">联动筛选</span>
            <strong>{filterLabel}</strong>
            {drilldownLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
            <button type="button" onClick={onClearFilter} className="ml-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">清除筛选</button>
          </div>
        ) : (
          <span className="rounded-md bg-primary/8 px-2.5 py-1 text-[11px] font-semibold text-primary">自然月月报</span>
        )}
      </div>
      <div className="p-5">
        {drilldownError && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <span>{drilldownError}</span>
            <button type="button" onClick={onClearFilter} className="font-semibold hover:underline">恢复整月数据</button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map(stat => (
            <CoreMetric key={stat.label} {...stat} />
          ))}
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <CoreDistributionCard
            title="平台分布"
            hint={G.platform}
            rows={platformRows}
            dimension="platform"
            activeValue={activeSelection?.dimension === 'platform' ? activeSelection.value : ''}
            filterState={activeSelection?.dimension === 'platform' ? 'source' : activeSelection ? 'filtered' : 'none'}
            onSelect={onDrillDown}
          />
          <CoreDistributionCard
            title="情感分布"
            hint={G.sentiment}
            rows={sentimentRows}
            dimension="sentiment"
            activeValue={activeSelection?.dimension === 'sentiment' ? activeSelection.value : ''}
            filterState={activeSelection?.dimension === 'sentiment' ? 'source' : activeSelection ? 'filtered' : 'none'}
            onSelect={onDrillDown}
          />
          <CoreDistributionCard
            title="处理模式分布"
            hint={G.workflow}
            rows={statusRows}
            dimension="status"
            activeValue={activeSelection?.dimension === 'status' ? activeSelection.value : ''}
            filterState={activeSelection?.dimension === 'status' ? 'source' : activeSelection ? 'filtered' : 'none'}
            onSelect={onDrillDown}
          />
        </div>
      </div>
    </section>
  )
}

function CoreMetric({ label, value, suffix, tone = 'normal', hint }: {
  label: string
  value: React.ReactNode
  suffix?: string
  tone?: string
  hint?: string
}) {
  const toneClass = tone === 'danger'
    ? 'border-status-red/20 bg-status-red/[0.06] text-destructive'
    : tone === 'positive'
      ? 'border-status-green/20 bg-status-green/[0.06] text-emerald-700 dark:text-emerald-300'
      : tone === 'accent'
        ? 'border-primary/15 bg-primary/[0.05] text-primary'
        : 'border-border bg-muted/35 text-foreground'
  return (
    <div className={`rounded-lg border px-3.5 py-3 ${toneClass}`}>
      <div className="flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground">{label}{hint && <InfoHint text={hint} />}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <strong className="text-[22px] font-bold tabular-nums">{value}</strong>
        {suffix && <span className="text-[11px] font-semibold text-muted-foreground">占比 {suffix}</span>}
      </div>
    </div>
  )
}

function CoreDistributionCard({
  title,
  hint,
  rows,
  dimension,
  activeValue,
  filterState,
  onSelect,
}: {
  title: string
  hint: string
  rows: CoreDistributionRow[]
  dimension: CoreDimension
  activeValue: string
  filterState: 'none' | 'source' | 'filtered'
  onSelect: (dimension: CoreDimension, value: string) => void
}) {
  return (
    <section className="flex min-h-[320px] flex-col overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">{title}<InfoHint text={hint} /></h3>
        {filterState !== 'none' && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${filterState === 'source' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
            {filterState === 'source' ? '筛选来源' : '已联动'}
          </span>
        )}
      </div>
      {rows.length ? (
        <div className="flex-1 divide-y divide-border/60 px-2">
          {rows.map(row => (
            <button
              key={row.key}
              type="button"
              onClick={() => onSelect(dimension, row.key)}
              aria-pressed={activeValue === row.key}
              className={`group grid w-full gap-1.5 rounded-md px-2 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 ${activeValue === row.key ? 'bg-primary/8 ring-1 ring-primary/15' : 'hover:bg-accent'}`}
              aria-label={`${title}：${row.label}，${formatNumber(row.count)}条，占比${row.share}%，点击联动筛选`}
            >
              <span className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="flex min-w-0 items-center gap-2 font-semibold">
                  <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                  <span className="truncate">{row.label}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
                  <strong className="text-foreground">{formatNumber(row.count)}</strong>
                  <span>· {row.share}%</span>
                </span>
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full transition-all"
                  style={{
                    width: `${row.share > 0 ? Math.max(3, Math.min(100, row.share)) : 0}%`,
                    backgroundColor: row.color,
                  }}
                />
              </span>
              {row.detail && <span className="text-[10.5px] text-muted-foreground">{row.detail}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center p-4"><EmptyState icon={BarChart3} title={`暂无${title}`} /></div>
      )}
      <div className="border-t border-border bg-muted/20 px-4 py-2 text-[10.5px] text-muted-foreground">
        {filterState === 'source' ? '再次点击已选项可清除筛选' : filterState === 'filtered' ? '数据已按当前选择联动筛选' : '点击任一项，联动筛选本月报告'}
      </div>
    </section>
  )
}

function drilldownLabel(dimension: CoreDimension, key: string) {
  if (dimension === 'platform') return platformName(key) || '未知平台'
  if (dimension === 'sentiment') return LABELS.sentiment[key] || (key === 'pending' ? '待标注' : key)
  return HANDLING_STATUS_ROWS.find(row => row.key === key)?.label || key
}

function AiInsightPanel({ month }: { month: string }) {
  const [insight, setInsight] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ range: 'month', month })
      const r: any = await api.get('/analytics/ai-insight?' + params.toString())
      setInsight(r?.insight || null)
      if (!r?.insight) setError('本期代表样本不足或未配置 LLM,暂无法生成研判。')
    } catch (e: any) {
      setError(e?.message || '生成失败')
    } finally {
      setLoading(false)
    }
  }
  const map = insight?.sampleMap || {}
  const arr = (v: any): any[] => (Array.isArray(v) ? v.filter(Boolean) : [])
  const chips = (ids: any) => {
    const list = arr(ids)
    if (!list.length) return null
    return (
      <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
        {list.map((id: string, i: number) => {
          const m = map[id] || {}
          const label = String(m.title || id).slice(0, 14)
          return m.url
            ? <a key={i} href={m.url} target="_blank" rel="noreferrer" className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-primary hover:underline">{label}</a>
            : <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{label}</span>
        })}
      </span>
    )
  }
  const topics = arr(insight?.topicClusters)
  const risks = arr(insight?.sentimentAndRisks)
  const needs = arr(insight?.userNeeds).map(String)
  const signals = arr(insight?.brandSignals).map(String)
  const actions = arr(insight?.actionSuggestions)
  return (
    <Panel title="AI 舆情研判" hint="按需触发:用 LLM 对本期代表样本做跨样本研判(议题/情绪/诉求/信号/建议),每条挂可回链原帖的样本;不随看板自动跑,省 token">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={run} disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-primary transition hover:bg-accent disabled:opacity-50">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {insight ? '重新生成' : '生成 AI 研判'}
          </button>
          {!insight && !loading && !error && <span className="text-xs text-muted-foreground">把本期代表样本交给 LLM 跨样本归纳议题与处置建议</span>}
          {error && <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
        </div>
        {insight && (
          <>
            {insight.heatTrend && <p className="leading-relaxed"><span className="font-semibold">热度走势 · </span>{String(insight.heatTrend)}</p>}
            {insight.executiveSummary && <p className="rounded-md bg-muted/40 p-2.5 leading-relaxed">{String(insight.executiveSummary)}</p>}
            {topics.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-bold text-muted-foreground">议题聚类</div>
                <ul className="space-y-1.5">
                  {topics.map((t, i) => <li key={i}><span className="font-semibold">{String(t.topic || '')}</span>{t.summary ? `：${String(t.summary)}` : ''}{chips(t.sampleIds)}</li>)}
                </ul>
              </div>
            )}
            {risks.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-bold text-muted-foreground">情绪与争议</div>
                <ul className="space-y-1.5">
                  {risks.map((r, i) => (
                    <li key={i}>
                      <span className={`mr-1.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${r.level === '高' ? 'bg-status-red/15 text-rose-700 dark:text-rose-300' : r.level === '中' ? 'bg-status-amber/20 text-amber-700 dark:text-amber-300' : 'bg-muted text-muted-foreground'}`}>{String(r.level || '—')}</span>
                      {String(r.point || '')}{chips(r.sampleIds)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {needs.length > 0 && <InsightChips label="用户诉求" items={needs} />}
            {signals.length > 0 && <InsightChips label="品牌信号" items={signals} />}
            {actions.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-bold text-muted-foreground">处置建议</div>
                <ul className="space-y-2">
                  {actions.map((a, i) => (
                    <li key={i} className="rounded-md bg-muted/40 p-2.5">
                      <div className="font-semibold">{String(a.title || '')}{chips(a.sampleIds)}</div>
                      {a.nextStep && <div className="mt-0.5 text-[13px]"><span className="text-muted-foreground">下一步：</span>{String(a.nextStep)}</div>}
                      {a.rationale && <div className="mt-0.5 text-[12px] text-muted-foreground">依据：{String(a.rationale)}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  )
}

function InsightChips({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-bold text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it, i) => <span key={i} className="rounded-md bg-muted px-2 py-1 text-[12.5px]">{it}</span>)}
      </div>
    </div>
  )
}

function trendNote(s: any) {
  const d = delta(s.total, s.previous?.total)
  return d ? `较上期${d.up ? '上升' : '下降'} ${d.pct}%` : '暂无可比上期'
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
  const periodPending = Number((s.triagePeriod || []).find((row: any) => row.status === 'unhandled')?.count) || 0
  const stats = [
    { label: '总声量', value: formatNumber(s.total), d: delta(s.total, prev.total), tone: 'accent', hint: G.volume },
    { label: '互动总量', value: formatNumber(interaction), tone: 'accent', hint: G.interaction },
    { label: '净情感 NSR', value: nsr, d: delta(nsr, nsrOf(prev.sentimentMap)), tone: nsr < 0 ? 'danger' : 'normal', hint: G.nsr },
    { label: '风险指数', value: risk, tone: risk >= 70 ? 'danger' : risk >= 45 ? 'warning' : 'normal', hint: G.risk },
    { label: '负面率', value: `${negRate}%`, d: delta(negRate, prev.negativeRate), tone: negRate >= 20 ? 'danger' : 'normal', hint: G.negativeRate },
    { label: '新增内容', value: formatNumber(s.newRecords), d: delta(s.newRecords, prev.newRecords), hint: G.newRecords },
    { label: '本期待处理', value: formatNumber(periodPending), tone: periodPending > 0 ? 'warning' : 'normal', hint: G.pending },
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
        舆情风险指数 <strong className="text-foreground">{risk}</strong>({status});本期待处理 {formatNumber(periodPending)} 条,官方响应率 {officialRate}%。
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
      <IndexBar label="处置覆盖指数" value={response} color="#059669" />
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
  const [placement, setPlacement] = useState<{ source: any[]; width: number; words: any[] } | null>(null)
  const H = 340

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
    if (!terms.length || !width) return
    const top = terms.slice(0, 60)
    const ws = top.map(t => Number(t.weight) || Number(t.count) || 1)
    const max = Math.max(...ws, 1), min = Math.min(...ws)
    const maxFont = Math.min(58, Math.max(34, Math.round(width / 11)))
    const words = top.map((t, i) => {
      const v = Number(t.weight) || Number(t.count) || 1
      const ratio = (v - min) / (max - min || 1)
      return {
        text: String(t.label || ''),
        size: Math.round(15 + Math.pow(ratio, 0.65) * (maxFont - 15)),
        count: Number(t.count) || 0,
        tone: Number(t.tone) || i,
      }
    })
    let cancelled = false
    const layout = cloud()
      .size([width, H])
      .words(words as any)
      .padding(1)
      .spiral('rectangular') // 矩形螺旋:填满边角,不留大空白
      .rotate(() => (Math.random() < 0.12 ? 90 : 0))
      .font('sans-serif')
      .fontSize((d: any) => d.size)
      .on('end', (out: any[]) => {
        if (!cancelled) setPlacement({ source: terms, width, words: out })
      })
    layout.start()
    return () => { cancelled = true; layout.stop() }
  }, [terms, width])

  if (!terms.length) return <EmptyState icon={BarChart3} title="暂无热点词" />
  const placed = placement?.source === terms && placement.width === width ? placement.words : []
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
        const cover = proxiedImg(row.cover_url || row.record_cover_url || '')
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
