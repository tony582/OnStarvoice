import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowLeft, BarChart3, Bell, Building2, ChevronRight,
  CircleAlert, Database, Eye, FileText,
  Home, KeyRound, Lightbulb, ListChecks, LogOut, MessageCircle, MessageSquare, Monitor,
  Loader2, MoonStar, MoreHorizontal, Radio, RefreshCw, ScanSearch, Search, Send, ServerCog, Settings, ShieldCheck,
  Sparkles, User, Users,
} from 'lucide-react'
import {
  HashRouter, Navigate, Route, Routes, useLocation, useNavigate as useRouterNavigate,
  useParams, useSearchParams,
} from 'react-router-dom'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'
import { useNav } from '@/lib/navigation'
import { switchUiMode } from '@/lib/ui-mode'
import { cn, compact, formatDate, formatNumber, platformName } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/badge'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { ComingSoon } from '@/pages/ComingSoon'
import { OverviewPage } from '@/pages/OverviewPage'
import { OpinionPage } from '@/pages/OpinionPage'
import { SalesLeadsPage } from '@/pages/SalesLeadsPage'
import { WorkbenchPage } from '@/pages/WorkbenchPage'
import { MonitoringPage } from '@/pages/MonitoringPage'
import { DispatchPage } from '@/pages/dispatch/DispatchPage'
import { SocialAccountsPage } from '@/pages/SocialAccountsPage'
import { InsightsPage } from '@/pages/InsightsPage'
import { OpinionAnalysisPage } from '@/pages/OpinionAnalysisPage'
import { DataPage } from '@/pages/DataPage'
import { EventsPage } from '@/pages/EventsPage'
import { TracksPage } from '@/pages/TracksPage'
import { BenchmarksPage } from '@/pages/BenchmarksPage'
import { KeywordsPage } from '@/pages/KeywordsPage'
import { ContentHomePage } from '@/pages/ContentHomePage'
import { HitsPage } from '@/pages/HitsPage'
import { OwnedAccountExclusionsPage } from '@/pages/OwnedAccountExclusionsPage'
import { OfficialCommentPatrolTab } from '@/pages/monitoring/OfficialCommentPatrolTab'
import { TenantsPage, UsersPage, AuthCodesPage, SettingsPage } from '@/pages/AdminPages'

type OpenPage = (page: string, params?: Record<string, string>) => void
type RootTab = 'today' | 'tasks' | 'monitor' | 'insights' | 'more'

const PAGE_COMPONENTS: Record<string, React.ComponentType> = {
  overview: OverviewPage,
  opinion: OpinionPage,
  salesleads: SalesLeadsPage,
  workbench: WorkbenchPage,
  monitoring: MonitoringPage,
  dispatch: DispatchPage,
  'social-accounts': SocialAccountsPage,
  insights: InsightsPage,
  'opinion-analysis': OpinionAnalysisPage,
  data: DataPage,
  events: EventsPage,
  tracks: TracksPage,
  benchmarks: BenchmarksPage,
  keywords: KeywordsPage,
  'content-home': ContentHomePage,
  hits: HitsPage,
  'official-comments': OfficialCommentPatrolTab,
  'owned-account-exclusions': OwnedAccountExclusionsPage,
  tenants: TenantsPage,
  users: UsersPage,
  'auth-codes': AuthCodesPage,
  settings: SettingsPage,
}

const PAGE_TITLES: Record<string, string> = {
  overview: '今日值守', opinion: '客服工单', salesleads: '销售客资', workbench: '待办队列',
  monitoring: '关注博主', dispatch: '调度中心', 'social-accounts': '社交账号', insights: '舆情洞察', 'opinion-analysis': '舆情剖析', data: '数据与导出', events: '事件中心',
  tracks: '赛道机会', benchmarks: '对标账号', keywords: '选题与扩词',
  'content-home': '内容总览', hits: '爆款拆解', review: '内容复盘',
  'official-comments': '官方社媒',
  'owned-account-exclusions': '自营内容排除',
  tenants: '租户管理', users: '用户账号',
  'auth-codes': '激活码', settings: '系统设置',
}

const QUEUE_TITLES: Record<string, string> = {
  triage: '内容分诊', leads: '评论分诊',
  misjudgments: '误判反馈', issues: '问题处置',
}

const ROOTS: Array<{ key: RootTab; label: string; icon: React.ElementType }> = [
  { key: 'today', label: '今日', icon: Home },
  { key: 'tasks', label: '待办', icon: ListChecks },
  { key: 'monitor', label: '监测', icon: Radio },
  { key: 'insights', label: '洞察', icon: BarChart3 },
  { key: 'more', label: '更多', icon: MoreHorizontal },
]

export default function MobileApp() {
  return (
    <HashRouter>
      <MobileRouter />
    </HashRouter>
  )
}

function MobileRouter() {
  const routerNavigate = useRouterNavigate()
  const location = useLocation()
  const { navigate } = useNav()
  const { tenantId } = useAuth()

  const openPage = useCallback<OpenPage>((page, params) => {
    navigate(page, params)
    const query = new URLSearchParams(params || {}).toString()
    routerNavigate(`/m/page/${page}${query ? `?${query}` : ''}`)
  }, [navigate, routerNavigate])

  useEffect(() => {
    document.querySelector('.mobile-shell-main')?.scrollTo({ top: 0 })
  }, [location.pathname, location.search])

  const activeRoot = rootFromPath(location.pathname, location.search)

  return (
    <div className="mobile-shell flex h-dvh min-h-[520px] flex-col overflow-hidden bg-background text-foreground">
      <main className="mobile-shell-main flex-1 overflow-y-auto overscroll-y-contain">
        <Routes>
          <Route path="/m/today" element={<TodayPage key={tenantId} openPage={openPage} />} />
          <Route path="/m/tasks" element={<TasksHub openPage={openPage} />} />
          <Route path="/m/monitor" element={<MonitorHub key={tenantId} openPage={openPage} />} />
          <Route path="/m/insights" element={<InsightsHub openPage={openPage} />} />
          <Route path="/m/more" element={<MoreHub openPage={openPage} />} />
          <Route path="/m/page/:pageId" element={<MobilePageSurface />} />
          <Route path="*" element={<Navigate replace to="/m/today" />} />
        </Routes>
      </main>
      <BottomNav active={activeRoot} />
    </div>
  )
}

function rootFromPath(path: string, search = ''): RootTab | null {
  const match = path.match(/^\/m\/(today|tasks|monitor|insights|more)$/)
  if (match?.[1]) return match[1] as RootTab
  const pageMatch = path.match(/^\/m\/page\/([^/]+)$/)
  if (!pageMatch?.[1]) return null
  return rootForPage(decodeURIComponent(pageMatch[1]), Object.fromEntries(new URLSearchParams(search).entries()))
}

function BottomNav({ active }: { active: RootTab | null }) {
  const { badges, features } = useBadges()
  const { isPlatformAdmin } = useAuth()
  const routerNavigate = useRouterNavigate()
  const taskCount = badges.triagePending
    + (features.commentRiskAttentionEnabled ? badges.leadsNew : 0)
    + (isPlatformAdmin() ? badges.feedbackPending : 0) + badges.issuesOpen

  return (
    <nav aria-label="手机端主导航" className="mobile-bottom-nav relative z-30 grid shrink-0 grid-cols-5 border-t border-border/80 bg-card/95 px-1 pt-1 backdrop-blur-xl">
      {ROOTS.map(item => {
        const Icon = item.icon
        const selected = active === item.key
        const badge = item.key === 'tasks' ? taskCount : 0
        return (
          <button key={item.key} type="button" onClick={() => routerNavigate(`/m/${item.key}`)}
            aria-current={selected ? 'page' : undefined}
            className={cn('relative flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-lg text-[10.5px] font-semibold transition-colors',
              selected ? 'text-primary' : 'text-muted-foreground active:bg-muted')}>
            <span className={cn('relative flex h-6 w-9 items-center justify-center rounded-full transition-colors', selected && 'bg-primary/10')}>
              <Icon className="h-[19px] w-[19px]" strokeWidth={selected ? 2.4 : 1.9} />
              {badge > 0 && <span className="absolute -right-1 -top-1 min-w-[17px] rounded-full bg-status-red px-1 text-center text-[9px] font-bold leading-[17px] text-white">{badge > 99 ? '99+' : badge}</span>}
            </span>
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}

function RootHeader({ eyebrow, title, badge, action }: { eyebrow: string; title: string; badge?: string; action?: React.ReactNode }) {
  const { tenants, tenantId, switchTenant } = useAuth()
  const current = tenants.find(t => t.id === tenantId)
  return (
    <header className="px-4 pb-3 pt-[max(0.8rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-status-red" />StarVoice · {eyebrow}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[25px] font-extrabold leading-tight tracking-[-0.035em]">{title}</h1>
            {badge && <span className="shrink-0 rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-[0.12em] text-primary">{badge}</span>}
          </div>
        </div>
        {action}
      </div>
      <label className="mt-3 inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/80 px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">
        <Building2 className="h-3.5 w-3.5 shrink-0" />
        <select value={tenantId} onChange={e => switchTenant(e.target.value)} aria-label="切换租户"
          className="min-w-0 max-w-[240px] appearance-none truncate bg-transparent pr-2 text-foreground outline-none">
          {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {!current && <span>选择租户</span>}
      </label>
    </header>
  )
}

interface OverviewPendingRecord {
  id: string
  platform?: string
  title?: string
  content?: string
  author_name?: string
  sentiment?: string
  alert_count?: number
  last_seen_at?: string
}

interface OverviewData {
  kpi: Record<string, number>
  sentimentBreakdown: { negative: number; neutral: number; positive: number; unlabeled: number; total: number }
  platformRisk: Array<{ platform: string; total: number; negative: number }>
  pendingRecords: OverviewPendingRecord[]
}

interface MobileOpsControlSummary {
  runtimeBaselineVersion: string
  mode: 'observe' | 'guarded'
  policy: {
    enabled: boolean
    globalEnabled: boolean
    actionsEnabled: boolean
  }
  run?: {
    service_date: string
    verdict: 'pending' | 'healthy' | 'degraded' | 'blocked_manual' | 'incident'
    snapshot_count: number
    summary?: {
      headline?: string
      observedScheduleCount?: number
      expectedScheduleCount?: number
      recoveredItemCount?: number
      sourceClosureBlockedCount?: number
      manualBlockerCount?: number
      onlineAgentCount?: number
      registeredAgentCount?: number
      actions?: {
        pendingVerification?: number
        verified?: number
        failed?: number
        blocked?: number
      }
    }
  } | null
  digest?: { summary?: string } | null
  incidents?: Array<{
    id: string
    type?: string
    incident_type?: string
    title: string
    alert_delivery_status?: string
    alert_sent_at?: string
  }>
}

function TodayPage({ openPage }: { openPage: OpenPage }) {
  const { tenantId, canWrite } = useAuth()
  const { badges, features } = useBadges()
  const [data, setData] = useState<OverviewData | null>(null)
  const [ops, setOps] = useState<MobileOpsControlSummary | null>(null)
  const [opsBusy, setOpsBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [overview, opsSummary] = await Promise.all([
        api.get<OverviewData>('/workspace/overview?days=7'),
        api.get<MobileOpsControlSummary>('/ops-control/summary').catch(() => null),
      ])
      setData(overview)
      setOps(opsSummary)
      setUpdatedAt(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : '值守数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [tenantId, load]) // eslint-disable-line react-hooks/set-state-in-effect

  const observeNow = async () => {
    setOpsBusy(true)
    try {
      await api.post('/ops-control/observe-now', {})
      setOps(await api.get<MobileOpsControlSummary>('/ops-control/summary'))
    } catch (err) {
      setError(err instanceof Error ? err.message : '值守复核失败')
    } finally {
      setOpsBusy(false)
    }
  }

  const k = data?.kpi || {}
  const high = Number(k.high_open_issues || 0)
  const overdue = Number(k.overdue_issues || 0)
  const commentRiskAttentionEnabled = features.commentRiskAttentionEnabled
  const urgentTotal = high + overdue + badges.triagePending
    + (commentRiskAttentionEnabled ? badges.leadsNew : 0)
  const tasks = [
    { key: 'issues', count: high + overdue, label: overdue ? `${overdue} 个问题已超时` : `${high} 个高优问题开放中`, reason: '需要确认负责人和处置结论', tone: 'red', icon: CircleAlert, action: () => openPage('workbench', { queue: 'issues' }) },
    { key: 'triage', count: badges.triagePending, label: `${badges.triagePending} 条内容待判断`, reason: '负面与高互动内容优先', tone: 'orange', icon: Eye, action: () => openPage('workbench', { queue: 'triage' }) },
    ...(commentRiskAttentionEnabled ? [
      { key: 'comments', count: badges.leadsNew, label: `${badges.leadsNew} 条风险评论待跟进`, reason: '转工单、归档或忽略', tone: 'purple', icon: MessageSquare, action: () => openPage('workbench', { queue: 'leads' }) },
    ] : []),
  ].filter(item => item.count > 0)

  const pulseHeadline = loading
    ? '正在汇总当前值守态势…'
    : error
      ? '值守数据暂时未能刷新'
      : urgentTotal > 0
        ? `当前有 ${urgentTotal} 项需要你关注`
        : '当前没有紧急待办，可以继续观察'

  const handled = Number(k.handled_total || 0)
  const active = Number(k.status_total ?? (Number(k.unhandled || 0) + handled))
  const handledPct = active ? Math.round((handled / active) * 100) : 0

  return (
    <div className="min-h-full pb-5">
      <RootHeader eyebrow="Duty" title="今日值守" action={
        <button type="button" onClick={load} disabled={loading} aria-label="刷新值守数据"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground active:bg-muted">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      } />

      <div className="space-y-5 px-4">
        <MobileOpsControlCard
          data={ops}
          busy={opsBusy}
          canObserve={canWrite()}
          onObserve={observeNow}
          onOpenDispatch={() => openPage('dispatch')}
        />

        <section className={cn('mobile-duty-pulse relative overflow-hidden rounded-2xl border bg-card px-4 py-4', urgentTotal > 0 ? 'border-status-red/25' : 'border-status-green/25')}>
          <span className={cn('absolute inset-y-0 left-0 w-1', urgentTotal > 0 ? 'bg-status-red' : 'bg-status-green')} />
          <div className="flex items-center justify-between gap-3">
            <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.16em]', urgentTotal > 0 ? 'text-status-red' : 'text-emerald-600 dark:text-emerald-400')}>
              <span className="mobile-live-dot h-1.5 w-1.5 rounded-full bg-current" />实时值守脉冲
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground">{updatedAt ? `${updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新` : '等待更新'}</span>
          </div>
          <p className="mt-3 text-[24px] font-extrabold leading-[1.18] tracking-[-0.035em]">{pulseHeadline}</p>
          {!loading && !error && (
            <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
              近 7 日内容负面 {formatNumber(k.negative_period)} 条 · 开放问题 {formatNumber(k.open_issues)} 个 · 今日新增 {formatNumber(k.today_new)} 条
            </p>
          )}
          {error && <button className="mt-3 text-xs font-bold text-primary" onClick={load}>重新加载</button>}
        </section>

        <section>
          <SectionHeading label="必须处理" meta={tasks.length ? `${tasks.length} 组` : '已清空'} />
          {tasks.length ? (
            <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
              {tasks.map((task, index) => {
                const Icon = task.icon
                return (
                  <button key={task.key} type="button" onClick={task.action}
                    className={cn('flex w-full items-center gap-3 px-3.5 py-3.5 text-left active:bg-muted/80', index > 0 && 'border-t border-border/70')}>
                    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                      task.tone === 'red' ? 'bg-status-red/10 text-status-red' :
                      task.tone === 'orange' ? 'bg-status-orange/15 text-amber-700 dark:text-amber-300' :
                      task.tone === 'purple' ? 'bg-status-purple/10 text-status-purple' : 'bg-status-blue/10 text-status-indigo')}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-bold leading-5">{task.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{task.reason}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-3 rounded-2xl border border-status-green/20 bg-card p-4">
              <ShieldCheck className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
              <div><div className="text-sm font-bold">紧急项已清空</div><div className="mt-0.5 text-[11px] text-muted-foreground">新的风险出现后会排到这里</div></div>
            </div>
          )}
        </section>

        <section>
          <SectionHeading label="风险正在发生" action={<button onClick={() => openPage('workbench', { queue: 'triage' })} className="text-[11px] font-bold text-primary">查看全部</button>} />
          <div className="mt-2 space-y-2">
            {(data?.pendingRecords || []).slice(0, 4).map(record => (
              <button key={record.id} type="button" onClick={() => openPage('workbench', { queue: 'triage', sentiment: record.sentiment === 'negative' ? 'negative' : '' })}
                className="relative w-full overflow-hidden rounded-xl border border-border bg-card p-3.5 text-left active:bg-muted/70">
                <span className={cn('absolute inset-y-3 left-0 w-[3px] rounded-r-full', record.sentiment === 'negative' ? 'bg-status-red' : 'bg-status-blue')} />
                <div className="flex items-start gap-2">
                  <StatusBadge tone={record.sentiment || 'neutral'}>{record.sentiment === 'negative' ? '负面' : record.sentiment === 'positive' ? '正面' : '待判断'}</StatusBadge>
                  <span className="ml-auto text-[10px] text-muted-foreground">{formatDate(record.last_seen_at)}</span>
                </div>
                <div className="mt-2 line-clamp-2 text-[13px] font-semibold leading-5">{record.title || compact(record.content || '', 56) || '(无标题)'}</div>
                <div className="mt-2 flex items-center gap-2 text-[10.5px] text-muted-foreground">
                  <span>{platformName(record.platform || '')}</span><span>·</span><span>作者 {record.author_name || '未知'}</span>
                  {Number(record.alert_count) > 0 && <span className="ml-auto font-bold text-status-red">预警 {record.alert_count}</span>}
                </div>
              </button>
            ))}
            {!loading && !(data?.pendingRecords || []).length && <EmptyLine text="当前没有待处置风险内容" />}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <SectionHeading label="状态处理进度" meta={`${handled} / ${active}`} />
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-status-green" style={{ width: `${handledPct}%` }} /></div>
          <div className="mt-3 grid grid-cols-3 divide-x divide-border text-center">
            <MiniMetric label="待处理" value={k.unhandled} />
            <MiniMetric label="飞书表" value={k.negative_feishu} />
            <MiniMetric label="冷处理" value={k.negative_cold} />
          </div>
        </section>

        <button type="button" onClick={() => openPage('content-home')}
          className="flex w-full items-center gap-3 rounded-2xl border border-primary/20 bg-card p-4 text-left active:bg-muted">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Lightbulb className="h-5 w-5" /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-bold">看看今天的内容机会</span><span className="mt-0.5 block text-[11px] text-muted-foreground">选题、赛道与爆款建议</span></span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  )
}

const MOBILE_OPS_VERDICT = {
  pending: { label: '观察中', tone: 'neutral', accent: 'border-l-status-blue' },
  healthy: { label: '无需处理', tone: 'positive', accent: 'border-l-status-green' },
  degraded: { label: '部分异常', tone: 'medium', accent: 'border-l-status-orange' },
  blocked_manual: { label: '需要人工', tone: 'medium', accent: 'border-l-status-orange' },
  incident: { label: '系统异常', tone: 'negative', accent: 'border-l-status-red' },
} as const

function MobileOpsControlCard({ data, busy, canObserve, onObserve, onOpenDispatch }: {
  data: MobileOpsControlSummary | null
  busy: boolean
  canObserve: boolean
  onObserve: () => void
  onOpenDispatch: () => void
}) {
  const enabled = data?.policy?.enabled === true
  const run = data?.run || null
  const verdict = run?.verdict || 'pending'
  const style = MOBILE_OPS_VERDICT[verdict]
  const summary = run?.summary || {}
  const actionSummary = summary.actions || {}
  const sourceClosureBlockedCount = Number(summary.sourceClosureBlockedCount || 0)
  const explicitManualBlockerCount = Number(summary.manualBlockerCount || 0)
  const guarded = data?.mode === 'guarded'
  const actionsEnabled = data?.policy?.actionsEnabled === true
  const firstIncident = data?.incidents?.[0]
  const firstIncidentType = firstIncident?.incident_type || firstIncident?.type || ''
  const alertLabel = firstIncidentType === 'capture_source_closure_blocked'
    ? '恢复阻塞：等待原 Agent 关闭确认'
    : firstIncident?.alert_delivery_status === 'sent'
    ? '提醒已发'
    : ['retry_wait', 'blocked_config', 'failed'].includes(firstIncident?.alert_delivery_status || '')
      ? '提醒异常'
      : firstIncident ? '恢复/提醒判定中' : ''
  const attention = verdict === 'incident' || verdict === 'blocked_manual' || verdict === 'degraded'
    || Number(actionSummary.failed || 0) > 0 || Number(actionSummary.blocked || 0) > 0
  const headline = !data
    ? '值守控制面暂不可用'
    : !enabled
      ? '观察模式尚未启用'
      : summary.headline || data.digest?.summary || '等待首次连续观察'

  return (
    <section data-ops-control-card className={cn('overflow-hidden rounded-2xl border border-l-4 border-border bg-card p-4', enabled ? style.accent : 'border-l-border')}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MoonStar className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="text-[13px] font-extrabold">昨夜值守</h2>
            <StatusBadge tone={enabled ? style.tone : 'neutral'}>{enabled ? style.label : '未开启'}</StatusBadge>
            <span className="text-[9px] font-bold text-muted-foreground">
              {guarded ? (actionsEnabled ? '受控动作' : '动作未放行') : '观察模式'}
            </span>
          </div>
          <p className="mt-2 text-[15px] font-extrabold leading-5">{headline}</p>
          {!enabled && (
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              {data?.policy?.globalEnabled === false ? '服务端全局 kill switch 已关闭' : '本租户尚未开启值守观察'}
            </p>
          )}
          {enabled && run && <p className="mt-1 text-[10px] text-muted-foreground">{run.service_date} · {Number(run.snapshot_count || 0)} 次快照</p>}
        </div>
      </div>

      {enabled && run && (
        <div className="mt-3 grid grid-cols-2 gap-y-3 divide-x divide-border rounded-xl bg-muted/45 py-2.5 text-center">
          <MobileOpsFact label="计划覆盖" value={`${Number(summary.observedScheduleCount || 0)}/${Number(summary.expectedScheduleCount || 0)}`} />
          <MobileOpsFact label="恢复已完成" value={String(Number(summary.recoveredItemCount || 0))} />
          <MobileOpsFact label="恢复阻塞" value={String(sourceClosureBlockedCount)} />
          <MobileOpsFact label="需人工" value={String(explicitManualBlockerCount)} />
        </div>
      )}

      {enabled && run && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          在线 Agent {Number(summary.onlineAgentCount || 0)}/{Number(summary.registeredAgentCount || 0)}
          {guarded ? ` · 动作验收 ${Number(actionSummary.verified || 0)}/${Number(actionSummary.pendingVerification || 0)} 待验收` : ''}
          {(data?.incidents || []).length > 0 ? ` · 当前事项 ${firstIncident?.title}` : ''}
          {alertLabel ? ` · ${alertLabel}` : ''}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        {enabled && canObserve && (
          <button type="button" onClick={onObserve} disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[11px] font-bold text-muted-foreground active:bg-muted disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}立即复核
          </button>
        )}
        {attention && (
          <button type="button" onClick={onOpenDispatch}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-bold text-primary-foreground">
            查看调度 <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <p className="mt-3 border-t border-border/70 pt-2 text-[9.5px] leading-4 text-muted-foreground">
        {data?.runtimeBaselineVersion || '0.3.91'} 值守与受控恢复基线 · 未调用 LLM · {actionsEnabled
          ? '仅执行白名单动作；后续快照验收成功后才计为恢复完成'
          : guarded ? '动作门禁尚未全部放行' : '当前只观察、判断和通知'}
      </p>
    </section>
  )
}

function MobileOpsFact({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[17px] font-extrabold tabular-nums">{value}</div><div className="mt-0.5 text-[9.5px] text-muted-foreground">{label}</div></div>
}

function TasksHub({ openPage }: { openPage: OpenPage }) {
  const { badges, features } = useBadges()
  const { isPlatformAdmin } = useAuth()
  const adminFeedback = isPlatformAdmin() ? badges.feedbackPending : 0
  const commentRiskAttentionLoaded = features.loaded
  const commentRiskAttentionEnabled = features.commentRiskAttentionEnabled
  const total = badges.triagePending
    + (commentRiskAttentionEnabled ? badges.leadsNew : 0)
    + adminFeedback + badges.issuesOpen
  const queues = [
    { title: '内容分诊', count: badges.triagePending, copy: '判断风险、更新处理状态或填写备注', icon: Eye, tone: 'red', page: 'workbench', params: { queue: 'triage' } },
    ...(commentRiskAttentionEnabled ? [
      { title: '评论分诊', count: badges.leadsNew, copy: '跟进风险评论，转工单或忽略', icon: MessageSquare, tone: 'orange', page: 'workbench', params: { queue: 'leads' } },
    ] : []),
    { title: '问题处置', count: badges.issuesOpen, copy: '确认负责人、解决问题或关闭事件', icon: CircleAlert, tone: 'purple', page: 'workbench', params: { queue: 'issues' } },
    ...(isPlatformAdmin() ? [{ title: '误判反馈', count: badges.feedbackPending, copy: '核对客户提交的误报并复核', icon: Sparkles, tone: 'green', page: 'workbench', params: { queue: 'misjudgments' } }] : []),
  ]

  return (
    <div className="min-h-full pb-5">
      <RootHeader eyebrow="Action" title="待办" />
      <div className="space-y-5 px-4">
        <section className="rounded-2xl bg-[#10233f] p-4 text-white dark:bg-[#dfe8ff] dark:text-[#10233f]">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/60 dark:text-[#10233f]/60">Next actions</div>
          <div className="mt-2 flex items-end gap-2"><span className="text-[40px] font-black leading-none tabular-nums">{formatNumber(total)}</span><span className="pb-1 text-[13px] font-semibold opacity-75">项等待处理</span></div>
          <p className="mt-2 text-[11px] leading-5 opacity-70">按紧急、超时和高风险排序，不按数据来源排队。</p>
        </section>

        <div className="grid grid-cols-2 gap-2">
          <QuickFilter label="高风险" value={String(badges.triagePending)} onClick={() => openPage('workbench', { queue: 'triage', sentiment: 'negative' })} />
          <QuickFilter label="负面-飞书表" value="处理状态" onClick={() => openPage('workbench', { queue: 'triage', status: 'negative_feishu' })} />
        </div>

        <section>
          <SectionHeading label="按下一步处理" meta="全部能力" />
          <div className="mt-2 space-y-2">
            {queues.map(queue => <QueueCard key={queue.title} {...queue} onClick={() => openPage(queue.page, queue.params)} />)}
          </div>
        </section>

        <section>
          <SectionHeading label="其他任务" />
          <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
            {commentRiskAttentionLoaded && !commentRiskAttentionEnabled && (
              <DirectoryRow icon={MessageSquare} title="评论分诊" subtitle="持续采集和标注，不计入当前值守待办" onClick={() => openPage('workbench', { queue: 'leads' })} />
            )}
            <DirectoryRow icon={User} title="销售客资" subtitle="跟进、处理或忽略购买意向" onClick={() => openPage('salesleads')} divided={commentRiskAttentionLoaded && !commentRiskAttentionEnabled} />
          </div>
        </section>
      </div>
    </div>
  )
}

function MonitorHub({ openPage }: { openPage: OpenPage }) {
  return (
    <div className="min-h-full pb-5">
      <RootHeader eyebrow="Watch" title="监测" />
      <div className="space-y-4 px-4">
        <button type="button" onClick={() => openPage('dispatch')}
          className="w-full rounded-2xl bg-[#10233f] p-4 text-left text-white active:opacity-90 dark:bg-[#dfe8ff] dark:text-[#10233f]">
          <span className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.16em] opacity-65">
            <ServerCog className="h-4 w-4" />任务与设备
          </span>
          <span className="mt-3 flex items-center gap-2 text-[21px] font-extrabold tracking-[-0.025em]">调度中心<ChevronRight className="ml-auto h-5 w-5 opacity-70" /></span>
          <span className="mt-1 block text-[11px] leading-5 opacity-70">先看执行中与需处理任务，再按需切到 Agent 设备。</span>
        </button>

        <section>
          <SectionHeading label="监测目录" />
          <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
            <DirectoryRow icon={Users} title="Agent 今日运行" subtitle="搜索、采集、安全验证与账号用量" onClick={() => openPage('social-accounts')} />
            <DirectoryRow icon={Radio} title="关注博主" subtitle="管理关注对象，并在页内查看博主新动态" onClick={() => openPage('monitoring', { tab: 'tasks' })} divided />
            <DirectoryRow icon={Bell} title="风险事件" subtitle="查看扩散中的事件与当前处置状态" onClick={() => openPage('events')} divided />
          </div>
        </section>
      </div>
    </div>
  )
}

function InsightsHub({ openPage }: { openPage: OpenPage }) {
  return (
    <div className="min-h-full pb-5">
      <RootHeader eyebrow="Learn" title="洞察" />
      <div className="space-y-5 px-4">
        <section>
          <SectionHeading label="舆情决策" />
          <button type="button" onClick={() => openPage('insights', { tab: 'dashboard' })}
            className="mt-2 w-full rounded-2xl border border-border bg-card p-4 text-left active:bg-muted">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-status-red/10 text-status-red"><BarChart3 className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1"><span className="block text-[15px] font-bold">先看结论，再看指标</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">执行摘要、关键变化、风险建议、趋势与 AI 研判</span></span>
              <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground" />
            </div>
          </button>
          <button type="button" onClick={() => openPage('opinion-analysis')}
            className="mt-2 w-full rounded-2xl border border-border bg-card p-4 text-left active:bg-muted">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-status-purple/10 text-status-purple"><ScanSearch className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1"><span className="block text-[15px] font-bold">舆情剖析</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">圈定话题深度拆解：风险研判、观点情绪、传播与应对口径</span></span>
              <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground" />
            </div>
          </button>
        </section>
        <section>
          <SectionHeading label="内容机会" />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <InsightTile icon={Lightbulb} title="内容总览" copy="今天做什么" onClick={() => openPage('content-home')} />
            <InsightTile icon={Activity} title="赛道机会" copy="机会与变化" onClick={() => openPage('tracks')} />
            <InsightTile icon={Sparkles} title="爆款拆解" copy="结构与模板" onClick={() => openPage('hits')} />
            <InsightTile icon={Users} title="对标账号" copy="关注标杆" onClick={() => openPage('benchmarks')} />
            <InsightTile icon={Search} title="选题与扩词" copy="拓展方向" onClick={() => openPage('keywords')} />
            <InsightTile icon={Eye} title="内容复盘" copy="能力建设中" onClick={() => openPage('review')} muted />
          </div>
        </section>
        <section>
          <SectionHeading label="报告" />
          <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
            <DirectoryRow icon={FileText} title="日报 / 周报 / 月报" subtitle="生成、预览、发送和查看历史" onClick={() => openPage('insights', { tab: 'reports' })} />
            <DirectoryRow icon={Send} title="报告发送记录" subtitle="查看状态、失败原因并重试" onClick={() => openPage('insights', { tab: 'reports' })} divided />
          </div>
        </section>
      </div>
    </div>
  )
}

interface DirectoryItem {
  title: string
  subtitle: string
  icon: React.ElementType
  page: string
  params?: Record<string, string>
  admin?: boolean
  internal?: boolean
}

const MORE_GROUPS: Array<{ label: string; items: DirectoryItem[] }> = [
  { label: '数据与导出', items: [
    { title: '数据底座', subtitle: '六类数据集、筛选、详情与下载', icon: Database, page: 'data' },
    { title: '报告中心', subtitle: '生成、预览、发送与历史记录', icon: FileText, page: 'insights', params: { tab: 'reports' } },
  ] },
  { label: '业务能力', items: [
    { title: '官方社媒', subtitle: '帖子趋势、评论情绪与运营建议', icon: MessageCircle, page: 'official-comments' },
    { title: '销售客资', subtitle: '购买意向跟进与处理', icon: User, page: 'salesleads' },
    { title: '社交账号', subtitle: 'Agent 每日用量、安全验证与可选账号信息', icon: Users, page: 'social-accounts' },
    { title: '事件中心', subtitle: '严重度、状态与关联内容时间线', icon: Bell, page: 'events' },
  ] },
  { label: '平台管理', items: [
    { title: '自营内容排除', subtitle: '避免自营发文进入内容分诊', icon: ShieldCheck, page: 'owned-account-exclusions', internal: true },
    { title: '租户管理', subtitle: '客户空间和状态', icon: Building2, page: 'tenants', admin: true },
    { title: '用户账号', subtitle: '角色、状态和密码', icon: Users, page: 'users', admin: true },
    { title: '激活码', subtitle: '生成和管理授权', icon: KeyRound, page: 'auth-codes', admin: true },
    { title: '系统设置', subtitle: 'AI、品牌、报告与邮件', icon: Settings, page: 'settings', admin: true },
  ] },
]

function MoreHub({ openPage }: { openPage: OpenPage }) {
  const { user, tenants, tenantId, switchTenant, logout, isPlatformAdmin, isInternal } = useAuth()
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLowerCase()
  const groups = MORE_GROUPS.map(group => ({
    ...group,
    items: group.items.filter(item =>
      (!item.admin || isPlatformAdmin())
      && (!item.internal || isInternal())
      && (!normalized || `${item.title}${item.subtitle}`.toLowerCase().includes(normalized))),
  })).filter(group => group.items.length)

  return (
    <div className="min-h-full pb-5">
      <RootHeader eyebrow="All tools" title="更多" action={<ThemeToggle />} />
      <div className="space-y-5 px-4">
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#10233f] text-sm font-extrabold text-white dark:bg-[#dfe8ff] dark:text-[#10233f]">{(user?.name || user?.email || 'S').slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-bold">{user?.name || 'StarVoice 用户'}</div><div className="mt-0.5 truncate text-[11px] text-muted-foreground">{user?.email}</div></div>
            <StatusBadge tone={isInternal() ? 'active' : 'neutral'}>{isInternal() ? '内部' : '租户'}</StatusBadge>
          </div>
          <label className="mt-4 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">当前客户空间</label>
          <select value={tenantId} onChange={e => switchTenant(e.target.value)} className="mt-1.5 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm font-semibold">
            {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </section>

        <label className="relative block">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="查找功能"
            className="h-12 w-full rounded-xl border border-input bg-card pl-10 pr-4 text-base outline-none focus:border-primary" />
        </label>

        {groups.map(group => (
          <section key={group.label}>
            <SectionHeading label={group.label} />
            <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
              {group.items.map((item, index) => (
                <DirectoryRow key={item.title} icon={item.icon} title={item.title} subtitle={item.subtitle}
                  divided={index > 0} onClick={() => openPage(item.page, item.params)} />
              ))}
            </div>
          </section>
        ))}

        {!groups.length && <EmptyLine text="没有找到这个功能" />}

        <section className="overflow-hidden rounded-2xl border border-border bg-card">
          <button type="button" onClick={() => switchUiMode('desktop')} className="flex min-h-12 w-full items-center gap-3 px-4 text-left active:bg-muted">
            <Monitor className="h-4 w-4 text-muted-foreground" /><span className="flex-1 text-sm font-semibold">切换桌面版</span><ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
          <button type="button" onClick={logout} className="flex min-h-12 w-full items-center gap-3 border-t border-border px-4 text-left text-status-red active:bg-muted">
            <LogOut className="h-4 w-4" /><span className="text-sm font-semibold">退出登录</span>
          </button>
        </section>
      </div>
    </div>
  )
}

function MobilePageSurface() {
  const { pageId = 'overview' } = useParams()
  const [searchParams] = useSearchParams()
  const routerNavigate = useRouterNavigate()
  const location = useLocation()
  const { page, params, seq, navigate } = useNav()
  const { tenantId, isPlatformAdmin } = useAuth()
  const querySignature = searchParams.toString()
  const query = useMemo(() => Object.fromEntries(searchParams.entries()), [querySignature]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sameParams = Object.entries(query).every(([key, value]) => params?.[key] === value)
    if (page !== pageId || !sameParams) navigate(pageId, query)
  }, [page, pageId, params, query, navigate])

  const PageComponent = PAGE_COMPONENTS[pageId]
  const requestedQueue = query.queue === 'feedback' ? 'triage' : (query.queue || 'triage')
  const visibleQueue = requestedQueue === 'misjudgments' && !isPlatformAdmin() ? 'triage' : requestedQueue
  const title = pageId === 'workbench' ? (QUEUE_TITLES[visibleQueue] || PAGE_TITLES[pageId]) : (PAGE_TITLES[pageId] || '功能')
  const backRoot = rootForPage(pageId, query)

  return (
    <div className="mobile-page-surface min-h-full bg-background pb-5">
      <header className="mobile-page-header sticky top-0 z-20 flex min-h-[56px] items-center gap-2 border-b border-border/80 bg-background/95 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <button type="button" onClick={() => location.key === 'default' ? routerNavigate(`/m/${backRoot}`, { replace: true }) : routerNavigate(-1)} aria-label="返回"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full active:bg-muted"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1"><div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">StarVoice mobile</div><div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-[17px] font-extrabold tracking-[-0.02em]">{title}</h1></div></div>
        <button type="button" onClick={() => routerNavigate('/m/more')} aria-label="更多功能" className="flex h-11 w-11 items-center justify-center rounded-full active:bg-muted"><MoreHorizontal className="h-5 w-5" /></button>
      </header>
      <div className="mobile-feature-page animate-fade-up px-3 py-3" key={`${pageId}:${seq}:${tenantId}:${querySignature}`}>
        {PageComponent
          ? pageId === 'dispatch'
            ? <DispatchPage surface="mobile" />
            : <PageComponent />
          : <ComingSoon pageId={pageId} />}
      </div>
    </div>
  )
}

function rootForPage(page: string, params: Record<string, string>): RootTab {
  if (page === 'workbench' || page === 'opinion' || page === 'salesleads') return 'tasks'
  if (page === 'monitoring' || page === 'dispatch' || page === 'social-accounts' || page === 'events') return 'monitor'
  if (['insights', 'opinion-analysis', 'content-home', 'tracks', 'hits', 'benchmarks', 'keywords', 'review'].includes(page)) return 'insights'
  if (page === 'overview') return 'today'
  if (page === 'official-comments' || page === 'owned-account-exclusions') return 'more'
  if (params.queue) return 'tasks'
  return 'more'
}

function SectionHeading({ label, meta, action }: { label: string; meta?: string; action?: React.ReactNode }) {
  return <div className="flex min-h-6 items-center gap-2"><h2 className="text-[13px] font-extrabold tracking-[-0.01em]">{label}</h2>{meta && <span className="text-[10px] text-muted-foreground">{meta}</span>}<span className="ml-auto">{action}</span></div>
}

function MiniMetric({ label, value }: { label: string; value: unknown }) {
  return <div><div className="text-[17px] font-extrabold tabular-nums">{formatNumber(Number(value || 0))}</div><div className="mt-0.5 text-[9.5px] text-muted-foreground">{label}</div></div>
}

function QuickFilter({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="rounded-xl border border-border bg-card p-3 text-left active:bg-muted"><span className="block text-[11px] font-semibold text-muted-foreground">{label}</span><span className="mt-1 block text-[22px] font-extrabold tabular-nums">{value}</span></button>
}

function QueueCard({ title, count, copy, icon: Icon, tone, onClick }: { title: string; count: number; copy: string; icon: React.ElementType; tone: string; onClick: () => void }) {
  const color = tone === 'red' ? 'bg-status-red' : tone === 'orange' ? 'bg-status-orange' : tone === 'purple' ? 'bg-status-purple' : tone === 'green' ? 'bg-status-green' : 'bg-status-blue'
  return (
    <button type="button" onClick={onClick} className="relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card p-3.5 text-left active:bg-muted">
      <span className={cn('absolute inset-y-0 left-0 w-1', color)} />
      <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white', color)}><Icon className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1"><span className="flex items-baseline gap-2"><span className="text-sm font-bold">{title}</span>{count > 0 && <span className="text-[17px] font-black tabular-nums">{count}</span>}</span><span className="mt-0.5 block text-[10.5px] leading-4 text-muted-foreground">{copy}</span></span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function DirectoryRow({ icon: Icon, title, subtitle, onClick, divided = false }: { icon: React.ElementType; title: string; subtitle: string; onClick: () => void; divided?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex min-h-[64px] w-full items-center gap-3 px-3.5 py-2.5 text-left active:bg-muted', divided && 'border-t border-border/70')}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="h-[18px] w-[18px]" /></span>
      <span className="min-w-0 flex-1"><span className="block text-[13px] font-bold">{title}</span><span className="mt-0.5 block text-[10.5px] leading-4 text-muted-foreground">{subtitle}</span></span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function InsightTile({ icon: Icon, title, copy, onClick, muted = false }: { icon: React.ElementType; title: string; copy: string; onClick: () => void; muted?: boolean }) {
  return <button type="button" onClick={onClick} className={cn('min-h-[108px] rounded-2xl border border-border bg-card p-3.5 text-left active:bg-muted', muted && 'opacity-65')}><Icon className="h-5 w-5 text-primary" /><span className="mt-4 block text-[13px] font-bold">{title}</span><span className="mt-0.5 block text-[10.5px] text-muted-foreground">{copy}</span></button>
}

function EmptyLine({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-border bg-card/60 px-4 py-7 text-center text-xs text-muted-foreground">{text}</div>
}
