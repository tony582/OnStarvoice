import { useEffect, useState } from 'react'
import {
  AlertCircle, BookOpen, Database, FileQuestion, Globe,
  Inbox, Loader2, MessageSquareWarning, Radar, RefreshCw, Sparkles,
  Tag, Target, TrendingUp,
} from 'lucide-react'
import { api } from '@/lib/api'
import { compact, formatDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { KpiCard } from '@/components/shared/KpiCard'
import { TrendChart } from '@/components/shared/TrendChart'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'

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
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="今日新增内容" value={k.today_new} icon={TrendingUp} />
        <KpiCard label="今日监控命中" value={k.today_monitor_hits} icon={Target} />
        <KpiCard label="今日评论线索" value={k.today_comment_leads} icon={MessageSquareWarning} tone={Number(k.today_comment_leads || 0) > 0 ? 'warning' : 'default'} />
        <KpiCard label="活跃监控" value={k.active_monitors} icon={Radar} />
        <KpiCard label="待处理问题" value={k.open_issues} icon={AlertCircle} tone={Number(k.open_issues || 0) > 0 ? 'warning' : 'default'} />
        <KpiCard label="待标注内容" value={k.pending_label} icon={Tag} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <Panel title="今天采集到什么" accent>
          <LatestContent rows={data?.latestContent || []} />
        </Panel>
        <Panel title="帮助中心">
          <HelpCenter />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="评论线索">
          <LatestCommentLeads rows={data?.latestCommentLeads || []} />
        </Panel>
        <Panel title="监控命中内容">
          <LatestMonitorHits rows={data?.latestMonitorHits || []} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Panel title="风险趋势（近7日）">
            <TrendChart data={data?.riskTrend || []} />
          </Panel>
          <Panel title="需要处理">
            <PendingRecords records={data?.pendingRecords || []} />
          </Panel>
        </div>
        <div className="space-y-4 lg:col-span-2">
          <Panel title="平台覆盖">
            <PlatformCoverage rows={data?.platformCoverage || []} />
          </Panel>
          <Panel title="数据来源">
            <SourceDistribution rows={data?.sourceDistribution || []} />
          </Panel>
          <Panel title="监控健康">
            <MonitorMini rows={data?.monitorHealth || []} />
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Panel({ title, children, accent }: { title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <section className={`overflow-hidden rounded-lg border bg-card transition-colors hover:border-input ${accent ? 'border-primary/15' : 'border-border'}`}>
      <div className={`border-b px-5 py-3.5 ${accent ? 'border-primary/15' : 'border-border'}`}>
        <h2 className="text-sm font-bold">{title}</h2>
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
    <div className="grid gap-3 sm:grid-cols-2">
      {HELP_ITEMS.map(item => {
        const Icon = item.icon
        return (
          <div key={item.title} className="rounded-lg border border-border bg-muted/20 p-4">
            <Icon className="h-4 w-4 text-primary" />
            <div className="mt-3 text-sm font-bold">{item.title}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.desc}</div>
          </div>
        )
      })}
    </div>
  )
}

function PendingRecords({ records }: { records: any[] }) {
  if (!records.length) return <EmptyState icon={Inbox} title="暂无待处理内容" description="所有舆情内容已处理完毕" />

  return (
    <div className="divide-y divide-border">
      {records.slice(0, 6).map((r, i) => {
        const total = interaction(r)
        return (
          <div key={i} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
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
          </div>
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
