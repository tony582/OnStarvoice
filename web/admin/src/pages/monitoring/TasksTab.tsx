import { useEffect, useState } from 'react'
import { Loader2, Radar, Play, Target, Clock, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, platformName, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge, StatusDot } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchTableShell } from '@/components/shared/Workbench'
import { useAuth } from '@/lib/auth'

function formatCadence(min: number) {
  if (!min) return '-'
  if (min >= 1440) return min === 1440 ? '每天' : `每 ${Math.round(min / 1440)} 天`
  if (min >= 60) return `每 ${Math.round(min / 60)} 小时`
  return `每 ${min} 分钟`
}

export function MonitorTasksTab({ onViewHits }: { onViewHits?: (subscriptionId: string) => void }) {
  const { canWrite } = useAuth()
  const [subs, setSubs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const data = await api.get<any>('/monitor/subscriptions')
    setSubs(data.subscriptions || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const runNow = async (id: string) => {
    await api.post('/monitor/run-now', { subscriptionId: id })
    load()
  }

  const active = subs.filter(s => s.status === 'active').length
  const errored = subs.filter(s => (s.last_error || '').trim()).length

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      {/* Stats 头部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <Stat label="关注博主" value={formatNumber(subs.length)} icon={Radar} />
          <Stat label="运行中" value={formatNumber(active)} icon={Clock} tone="green" />
          <Stat label="异常" value={formatNumber(errored)} icon={AlertTriangle} tone={errored > 0 ? 'red' : 'default'} />
        </div>
        <span className="text-[12px] text-muted-foreground">在扩展「对标监控」里把竞品博主纳入监控,这里查看并执行扫描</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : subs.length === 0 ? (
        <EmptyState icon={Radar} title="暂无监控账号" description="在扩展「对标监控」标签把竞品博主纳入监控,即可在此查看与执行" />
      ) : (
        <WorkbenchTableShell>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border/60 [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-[11px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider [&>th]:whitespace-nowrap [&>th]:text-muted-foreground">
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">博主</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">平台</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">频率</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">上次 / 下次</th>
              <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border/40">
              {subs.map(s => {
                const err = (s.last_error || '').trim()
                return (
                  <tr key={s.id} className="align-top transition-colors hover:bg-accent/45">
                    <td className="px-4 py-3">
                      <div className="font-medium">{s.name || s.bloggerName || '博主'}</div>
                      {(s.account_url || s.accountUrl)
                        ? <a href={s.account_url || s.accountUrl} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-xs text-primary hover:underline">博主主页 ↗</a>
                        : <div className="mt-0.5 text-xs text-muted-foreground">{s.platformBloggerId || s.keyword || '-'}</div>}
                    </td>
                    <td className="px-4 py-3"><StatusBadge tone="neutral">{platformName(s.platform)}</StatusBadge></td>
                    <td className="px-4 py-3">
                      {err
                        ? <StatusDot tone="negative">异常</StatusDot>
                        : s.status === 'active'
                          ? <StatusDot tone="active">运行中</StatusDot>
                          : <StatusDot tone="muted">{s.status === 'paused' ? '已暂停' : s.status}</StatusDot>}
                      {err && <div className="mt-1 max-w-[180px] truncate text-[10.5px] text-status-red" title={err}>{err}</div>}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatCadence(s.cadence_minutes)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <div>上次 {formatDate(s.last_run_at) || '—'}</div>
                      <div className="mt-0.5">下次 {formatDate(s.next_run_at) || '—'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {onViewHits && (
                          <Button variant="ghost" size="sm" onClick={() => onViewHits(s.id)}>
                            <Target className="h-3.5 w-3.5" /> 命中
                          </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={() => runNow(s.id)} disabled={!canWrite()}>
                          <Play className="h-3.5 w-3.5" /> 立即执行
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </WorkbenchTableShell>
      )}
    </div>
  )
}

const STAT_TONE = { default: 'text-foreground', green: 'text-status-green', red: 'text-status-red' }

function Stat({ label, value, icon: Icon, tone = 'default' }: { label: string; value: string; icon: React.ElementType; tone?: keyof typeof STAT_TONE }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-xs">
      <Icon className={`h-5 w-5 ${STAT_TONE[tone]}`} strokeWidth={1.8} />
      <div>
        <div className={`text-[20px] font-bold leading-none tabular-nums ${STAT_TONE[tone]}`}>{value}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}
