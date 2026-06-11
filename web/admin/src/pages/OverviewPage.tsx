import { useEffect, useState } from 'react'
import { TrendingUp, AlertTriangle, AlertCircle, Activity, Tag, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { formatNumber, formatDate, LABELS, platformName, compact } from '@/lib/utils'
import { KpiCard } from '@/components/shared/KpiCard'
import { TrendChart } from '@/components/shared/TrendChart'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { Globe, FileText, Radar, Inbox } from 'lucide-react'

interface OverviewData {
  kpi: Record<string, number>
  pendingRecords: any[]
  riskTrend: any[]
  platformCoverage: any[]
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
      {/* KPI Grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="今日新增" value={k.today_new} icon={TrendingUp} />
        <KpiCard label="负面内容" value={k.negative_period} icon={AlertTriangle} tone="destructive" />
        <KpiCard label="待处理问题" value={k.open_issues} icon={AlertCircle} tone="warning" />
        <KpiCard label="高危问题" value={k.high_open_issues} icon={AlertTriangle} tone="destructive" />
        <KpiCard label="待分诊" value={k.unhandled} icon={Activity} tone="warning" />
        <KpiCard label="待标注" value={k.pending_label} icon={Tag} />
      </div>

      {/* Main content grid */}
      <div className="grid gap-4 lg:grid-cols-5">
        {/* Left column - larger */}
        <div className="space-y-4 lg:col-span-3">
          {/* Pending records */}
          <Panel title="需要处理" accent>
            <PendingRecords records={data?.pendingRecords || []} />
          </Panel>

          {/* Trend chart */}
          <Panel title="风险趋势（近7日）">
            <TrendChart data={data?.riskTrend || []} />
          </Panel>
        </div>

        {/* Right column */}
        <div className="space-y-4 lg:col-span-2">
          <Panel title="平台覆盖">
            <PlatformCoverage rows={data?.platformCoverage || []} />
          </Panel>
          <Panel title="报告状态">
            <ReportMini rows={data?.reports || []} />
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
    <section className={`overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md ${accent ? 'border-primary/15' : 'border-border'}`}>
      <div className={`border-b px-5 py-3.5 ${accent ? 'border-primary/15' : 'border-border'}`}>
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function PendingRecords({ records }: { records: any[] }) {
  if (!records.length) return <EmptyState icon={Inbox} title="暂无待处理内容" description="所有舆情内容已处理完毕" />

  return (
    <div className="divide-y divide-border">
      {records.slice(0, 8).map((r, i) => {
        const interactions = Number(r.likes || 0) + Number(r.comments_count || 0) + Number(r.collects || 0) + Number(r.shares || 0)
        return (
          <div key={i} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.title || compact(r.content, 60) || '(无标题)'}</div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge tone="neutral">{platformName(r.platform)}</StatusBadge>
                <span>{formatNumber(interactions)} 互动</span>
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
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">{platformName(r.platform)}</div>
            <div className="text-xs text-muted-foreground">{formatNumber(r.count)} 条 · 新增 {formatNumber(r.period_new)}</div>
          </div>
          <span className="text-xs text-muted-foreground">{formatDate(r.last_seen_at)}</span>
        </div>
      ))}
    </div>
  )
}

function ReportMini({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState icon={FileText} title="暂无报告" description="可在报告中心生成日报/周报" />

  return (
    <div className="divide-y divide-border">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
          <span className="text-sm font-medium">{LABELS.reportType[r.report_type] || r.report_type}</span>
          <StatusBadge tone={r.status}>{LABELS.reportStatus[r.status] || r.status}</StatusBadge>
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
