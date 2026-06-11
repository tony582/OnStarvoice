import { useEffect, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useAuth } from '@/lib/auth'

export function IssuesPage() {
  const { canWrite } = useAuth()
  const [issues, setIssues] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const data = await api.get<any>('/issues?limit=100')
      setIssues(data.issues || [])
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const updateStatus = async (id: string, status: string) => {
    await api.patch('/issues/' + id, { status })
    load()
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      {issues.length === 0 ? (
        <EmptyState icon={AlertCircle} title="暂无问题" description="在收件箱中将内容转为问题后显示在这里" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">问题</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">级别</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">状态</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">负责人</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">内容数</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">更新时间</th>
              {canWrite() && <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">操作</th>}
            </tr></thead>
            <tbody className="divide-y divide-border">
              {issues.map(i => (
                <tr key={i.id} className="transition-colors hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{i.title || '未命名问题'}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{i.primary_record_platform} {i.primary_record_title}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge tone={i.severity}>{LABELS.severity[i.severity] || i.severity}</StatusBadge></td>
                  <td className="px-4 py-3"><StatusBadge tone={i.status}>{LABELS.issueStatus[i.status] || i.status}</StatusBadge></td>
                  <td className="px-4 py-3 text-sm">{i.owner_name || '未分配'}</td>
                  <td className="px-4 py-3 tabular-nums">{i.record_count}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(i.updated_at)}</td>
                  {canWrite() && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="outline" size="sm" onClick={() => updateStatus(i.id, 'resolved')}>解决</Button>
                        <Button variant="ghost" size="sm" onClick={() => updateStatus(i.id, 'closed')}>关闭</Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
