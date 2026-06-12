import { useEffect, useState } from 'react'
import {
  AlertCircle, ArrowRight, BookOpen, CheckCircle2, Database, FileQuestion, Globe,
  Inbox, Loader2, MessageSquareWarning, Radar, RefreshCw, Sparkles,
  Tag, Target, TrendingUp,
} from 'lucide-react'
import { api } from '@/lib/api'
import { compact, formatDate, formatNumber, LABELS, platformName, cn } from '@/lib/utils'
import { KpiCard } from '@/components/shared/KpiCard'
import { TrendChart } from '@/components/shared/TrendChart'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useNav, type PageParams } from '@/lib/navigation'
import { useBadges, type Badges } from '@/lib/badges'

interface OverviewData {
  kpi: Record<string, number>
  pendingRecords: any[]
  latestContent: any[]
  latestCommentLeads: any[]
  latestMonitorHits: any[]
  riskTrend: any[]
  platformCoverage: any[]
  sourceDistribution: any[]
  reports: any[]
  monitorHealth: any[]
}

export function OverviewPage() {
  const { navigate } = useNav()
  const { badges } = useBadges()
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<OverviewData>('/workspace/overview?days=7')
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const k = data?.kpi || {}

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-6 duration-300">
      {/* 今日待办:行动导向,点击直达对应队列(带预置筛选) */}
      <TodoBar badges={badges} navigate={navigate} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="今日新增内容" value={k.today_new} icon={TrendingUp} onClick={() => navigate('data')} />
        <KpiCard label="今日监控命中" value={k.today_monitor_hits} icon={Target} onClick={() => navigate('monitoring', { tab: 'hits' })} />
        <KpiCard label="今日评论线索" value={k.today_comment_leads} icon={MessageSquareWarning} tone={Number(k.today_comment_leads || 0) > 0 ? 'warning' : 'default'} onClick={() => navigate('workbench', { queue: 'leads' })} />
        <KpiCard label="活跃监控" value={k.active_monitors} icon={Radar} onClick={() => navigate('monitoring', { tab: 'tasks' })} />
        <KpiCard label="待处理问题" value={k.open_issues} icon={AlertCircle} tone={Number(k.open_issues || 0) > 0 ? 'warning' : 'default'} onClick={() => navigate('workbench', { queue: 'issues' })} />
        <KpiCard label="待标注内容" value={k.pending_label} icon={Tag} onClick={() => navigate('data')} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <Panel title="今天采集到什么" accent onMore={() => navigate('data')}>
          <LatestContent rows={data?.latestContent || []} />
        </Panel>
        <Panel title="帮助中心">
          <HelpCenter />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="评论线索" onMore={() => navigate('workbench', { queue: 'leads' })}>
          <LatestCommentLeads rows={data?.latestCommentLeads || []} />
        </Panel>
        <Panel title="监控命中内容" onMore={() => navigate('monitoring', { tab: 'hits' })}>
          <LatestMonitorHits rows={data?.latestMonitorHits || []} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Panel title="风险趋势（近7日）">
            <TrendChart data={data?.riskTrend || []} />
          </Panel>
          <Panel title="需要处理" onMore={() => navigate('workbench', { queue: 'triage' })}>
            <PendingRecords records={data?.pendingRecords || []} onOpen={() => navigate('workbench', { queue: 'triage' })} />
          </Panel>
        </div>
        <div className="space-y-4 lg:col-span-2">
          <Panel title="平台覆盖">
            <PlatformCoverage rows={data?.platformCoverage || []} />
          </Panel>
          <Panel title="数据来源" onMore={() => navigate('data')}>
            <SourceDistribution rows={data?.sourceDistribution || []} />
          </Panel>
          <Panel title="监控健康" onMore={() => navigate('monitoring', { tab: 'tasks' })}>
            <MonitorMini rows={data?.monitorHealth || []} />
          </Panel>
        </div>
      </div>
    </div>
  )
}

const TODO_ITEMS: Array<{ key: keyof Badges; label: string; hint: string; icon: React.ElementType; page: string; params: PageParams; tone: 'primary' | 'amber' | 'rose' }> = [
  { key: 'triagePending', label: '待分诊内容', hint: '研判舆情、转问题', icon: Inbox, page: 'workbench', params: { queue: 'triage' }, tone: 'primary' },
  { key: 'leadsNew', label: '新评论线索', hint: '跟进高风险评论', icon: MessageSquareWarning, page: 'workbench', params: { queue: 'leads', status: 'new' }, tone: 'amber' },
  { key: 'issuesOpen', label: '开放问题', hint: '处置中的舆情问题', icon: AlertCircle, page: 'workbench', params: { queue: 'issues' }, tone: 'rose' },
  { key: 'monitorAttention', label: '异常监控', hint: '监控任务报错待查', icon: Radar, page: 'monitoring', params: { tab: 'tasks' }, tone: 'amber' },
]

const TODO_TONES = {
  primary: { ring: 'hover:border-primary/40', chip: 'bg-primary/10 text-primary', num: 'text-primary' },
  amber: { ring: 'hover:border-amber-400/50', chip: 'bg-amber-500/12 text-amber-600 dark:text-amber-400', num: 'text-amber-600 dark:text-amber-400' },
  rose: { ring: 'hover:border-rose-400/50', chip: 'bg-rose-500/12 text-rose-600 dark:text-rose-400', num: 'text-rose-600 dark:text-rose-400' },
}

function TodoBar({ badges, navigate }: { badges: Badges; navigate: (page: string, params?: PageParams) => void }) {
  const total = TODO_ITEMS.reduce((sum, item) => sum + badges[item.key], 0)
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-bold">今日待办</h2>
        {total === 0
          ? <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />全部已清空</span>
          : <span className="text-xs text-muted-foreground">共 <span className="font-semibold text-foreground tabular-nums">{total}</span> 项待处理</span>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TODO_ITEMS.map(item => {
          const Icon = item.icon
          const count = badges[item.key]
          const t = TODO_TONES[item.tone]
          const done = count === 0
          return (
            <button
              key={item.key}
              onClick={() => navigate(item.page, item.params)}
              className={cn(
                'group flex items-center gap-3.5 rounded-xl border bg-card p-4 text-left shadow-xs transition-all duration-200 hover:shadow-sm',
                done ? 'border-border opacity-65 hover:opacity-100' : `border-border ${t.ring}`,
              )}
            >
              <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px]', done ? 'bg-muted text-muted-foreground' : t.chip)}>
                <Icon className="h-[22px] w-[22px]" strokeWidth={1.7} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cn('text-[26px] font-bold tabular-nums leading-none tracking-tight', done ? 'text-muted-foreground' : t.num)}>{count}</span>
                  <span className="truncate text-[13px] font-medium text-foreground">{item.label}</span>
                </div>
                <div className="mt-1.5 truncate text-xs text-muted-foreground">{item.hint}</div>
              </div>
              <ArrowRight className={cn('h-4 w-4 shrink-0 transition-all', done ? 'text-muted-foreground' : 'text-muted-foreground/60 group-hover:translate-x-0.5 group-hover:text-foreground')} />
            </button>
          )
        })}
      </div>
    </section>
  )
}

function Panel({ title, children, accent, onMore }: { title: string; children: React.ReactNode; accent?: boolean; onMore?: () => void }) {
  return (
    <section className={`overflow-hidden rounded-xl border bg-card shadow-xs ${accent ? 'border-primary/20' : 'border-border'}`}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          {accent && <span className="h-3.5 w-1 rounded-full bg-primary" />}
          <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        </div>
        {onMore && (
          <button onClick={onMore} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary">
            查看全部 <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function interaction(row: any) {
  return Number(row.likes || 0) + Number(row.comments_count || 0) + Number(row.collects || 0) + Number(row.shares || 0)
}

function LatestContent({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={Database} title="暂无采集内容" description="采集或监控入库后会显示最新内容" />
  return (
    <div className="divide-y divide-border">
      {rows.slice(0, 6).map(row => (
        <div key={row.id} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="neutral">{platformName(row.platform)}</StatusBadge>
              <StatusBadge tone="muted">{LABELS.recordType[row.record_type] || row.record_type || '内容'}</StatusBadge>
              {row.keyword && <StatusBadge tone="muted">{row.keyword}</StatusBadge>}
            </div>
            <div className="mt-2 truncate text-sm font-semibold">{row.title || compact(row.content || '', 80) || '(无标题)'}</div>
            <div className="mt-1 text-xs text-muted-foreground">{row.author_name || '未知作者'} · {formatNumber(interaction(row))} 互动</div>
          </div>
          <div className="shrink-0 text-xs text-muted-foreground">{formatDate(row.created_at)}</div>
        </div>
      ))}
    </div>
  )
}

function LatestCommentLeads({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={MessageSquareWarning} title="暂无评论线索" description="高风险评论会沉淀为舆情跟进线索" />
  return (
    <div className="divide-y divide-border">
      {rows.slice(0, 6).map(row => (
        <div key={row.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={row.priority}>{LABELS.priority[row.priority] || row.priority}</StatusBadge>
            <StatusBadge tone={row.status}>{LABELS.leadStatus[row.status] || row.status}</StatusBadge>
            <StatusBadge tone="neutral">{LABELS.leadType[row.lead_type] || row.lead_type}</StatusBadge>
          </div>
          <div className="mt-2 text-sm font-semibold">{row.comment_author_name || '匿名用户'}</div>
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-foreground">{row.comment_content}</div>
          <div className="mt-1 text-xs text-muted-foreground">{platformName(row.platform)} · {formatDate(row.captured_at)}</div>
        </div>
      ))}
    </div>
  )
}

function LatestMonitorHits({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={Target} title="暂无监控命中" description="执行监控后会显示命中的内容结果" />
  return (
    <div className="divide-y divide-border">
      {rows.slice(0, 6).map(row => (
        <div key={row.observation_id} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="neutral">{platformName(row.platform)}</StatusBadge>
              {row.is_new_record && <StatusBadge tone="active">新入库</StatusBadge>}
            </div>
            <div className="mt-2 truncate text-sm font-semibold">{row.title || compact(row.content || '', 72) || '(无标题)'}</div>
            <div className="mt-1 text-xs text-muted-foreground">{row.monitor_name || row.monitor_keyword || row.observation_keyword || '监控项'} · {formatNumber(interaction(row))} 互动</div>
          </div>
          <div className="shrink-0 text-xs text-muted-foreground">{formatDate(row.captured_at)}</div>
        </div>
      ))}
    </div>
  )
}

const HELP_ITEMS = [
  { title: '使用教程', desc: '采集、同步、分诊流程', icon: BookOpen },
  { title: '常见问题', desc: '登录、扩展、同步排查', icon: FileQuestion },
  { title: '数据表说明', desc: '内容、评论、线索、监控', icon: Database },
  { title: '更新日志', desc: '版本变化和修复记录', icon: RefreshCw },
]

function HelpCenter() {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {HELP_ITEMS.map(item => {
        const Icon = item.icon
        return (
          <div key={item.title} className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3.5 py-3 transition-colors hover:bg-muted/40">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="h-4 w-4" strokeWidth={1.8} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{item.title}</div>
              <div className="truncate text-xs text-muted-foreground">{item.desc}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PendingRecords({ records, onOpen }: { records: any[]; onOpen?: () => void }) {
  if (!records.length) return <EmptyState icon={Inbox} title="暂无待处理内容" description="所有舆情内容已处理完毕" />

  return (
    <div className="divide-y divide-border">
      {records.slice(0, 6).map((r, i) => {
        const total = interaction(r)
        return (
          <button key={i} onClick={onOpen}
            className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-md px-2 py-3 text-left transition-colors first:pt-0 last:pb-0 hover:bg-muted/40">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.title || compact(r.content, 60) || '(无标题)'}</div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
                <span>{formatNumber(total)} 互动</span>
              </div>
            </div>
            <StatusBadge tone={r.sentiment || 'muted'}>
              {LABELS.sentiment[r.sentiment] || '待标注'}
            </StatusBadge>
          </button>
        )
      })}
    </div>
  )
}

const PLATFORM_ICONS: Record<string, string> = { weibo: '微', xiaohongshu: '红', douyin: '抖' }

function PlatformCoverage({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={Globe} title="暂无平台数据" description="开始采集后将显示平台覆盖" />

  return (
    <div className="divide-y divide-border">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
            {PLATFORM_ICONS[r.platform] || '平'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{platformName(r.platform)}</div>
            <div className="text-xs text-muted-foreground">{formatNumber(r.count)} 条 · 新增 {formatNumber(r.period_new)}</div>
          </div>
          <span className="text-xs text-muted-foreground">{formatDate(r.last_seen_at)}</span>
        </div>
      ))}
    </div>
  )
}

function SourceDistribution({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={Sparkles} title="暂无来源数据" />
  return (
    <div className="divide-y divide-border">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{LABELS.recordType[row.record_type] || row.record_type || '内容'}</div>
            <div className="text-xs text-muted-foreground">近7天新增 {formatNumber(row.period_new)}</div>
          </div>
          <div className="text-lg font-bold tabular-nums">{formatNumber(row.count)}</div>
        </div>
      ))}
    </div>
  )
}

function MonitorMini({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={Radar} title="暂无监控任务" description="可在监控任务页创建关键词监控" />

  return (
    <div className="divide-y divide-border">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{r.name || r.keyword}</div>
            <div className="text-xs text-muted-foreground">{platformName(r.platform)} · 下次 {formatDate(r.next_run_at)}</div>
          </div>
          <StatusBadge tone={r.status === 'active' ? 'active' : r.status}>
            {r.status === 'active' ? '运行中' : r.status}
          </StatusBadge>
        </div>
      ))}
    </div>
  )
}
