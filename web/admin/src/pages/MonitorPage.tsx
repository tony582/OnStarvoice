import { useEffect, useState } from 'react'
import { Loader2, Radar, Play } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useAuth } from '@/lib/auth'

export function MonitorPage() {
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

  const create = async () => {
    const keyword = prompt('监控关键词：')
    if (!keyword) return
    const platform = prompt('平台 (xiaohongshu / douyin / weibo)：', 'xiaohongshu')
    if (!platform) return
    await api.post('/monitor/subscriptions', { keyword, platform, cadenceMinutes: 1440 })
    load()
  }

  const runNow = async (id: string) => {
    await api.post('/monitor/run-now', { subscriptionId: id })
    load()
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <div><Button onClick={create} disabled={!canWrite()}>新建监控</Button></div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : subs.length === 0 ? (
        <EmptyState icon={Radar} title="暂无监控任务" description="创建关键词监控以自动采集舆情内容" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">任务</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">平台</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">状态</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">频率</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">上次运行</th>
              <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {subs.map(s => (
                <tr key={s.id} className="transition-colors hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{s.name || s.keyword}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{s.keyword}</div>
                  </td>
                  <td className="px-4 py-3 text-sm">{platformName(s.platform)}</td>
                  <td className="px-4 py-3"><StatusBadge tone={s.status}>{s.status === 'active' ? '运行中' : s.status}</StatusBadge></td>
                  <td className="px-4 py-3 tabular-nums text-sm">{s.cadence_minutes} 分钟</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(s.last_run_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="outline" size="sm" onClick={() => runNow(s.id)} disabled={!canWrite()}>
                      <Play className="h-3.5 w-3.5" /> 立即执行
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
