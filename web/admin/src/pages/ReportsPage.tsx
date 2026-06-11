import { useEffect, useState } from 'react'
import { Loader2, FileText, Send } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useAuth } from '@/lib/auth'

export function ReportsPage() {
  const { canWrite } = useAuth()
  const [reports, setReports] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const data = await api.get<any>('/reports?limit=100')
    setReports(data.reports || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const generate = async (type: string) => {
    await api.post('/reports/generate', { type, send: false })
    load()
  }

  const send = async (id: string) => {
    await api.post('/reports/' + id + '/send')
    load()
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <div className="flex gap-2">
        <Button onClick={() => generate('daily')} disabled={!canWrite()}>生成日报</Button>
        <Button variant="outline" onClick={() => generate('weekly')} disabled={!canWrite()}>生成周报</Button>
        <Button variant="outline" onClick={() => generate('monthly')} disabled={!canWrite()}>生成月报</Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : reports.length === 0 ? (
        <EmptyState icon={FileText} title="暂无报告" description="点击上方按钮生成第一份报告" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">类型</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">周期</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">状态</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">生成时间</th>
              <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {reports.map(r => (
                <tr key={r.id} className="transition-colors hover:bg-muted/30">
                  <td className="px-4 py-3"><StatusBadge tone="neutral">{LABELS.reportType[r.report_type] || r.report_type}</StatusBadge></td>
                  <td className="px-4 py-3 text-sm">{r.subject || `${formatDate(r.period_start)} - ${formatDate(r.period_end)}`}</td>
                  <td className="px-4 py-3"><StatusBadge tone={r.status}>{LABELS.reportStatus[r.status] || r.status}</StatusBadge></td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(r.generated_at || r.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="outline" size="sm" onClick={() => send(r.id)} disabled={!canWrite()}>
                      <Send className="h-3.5 w-3.5" /> 发送
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
