import { useEffect, useState, useCallback } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchTabs } from '@/components/shared/Workbench'
import { IssueDrawer } from '@/components/shared/IssueDrawer'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'new', label: '新建' },
  { key: 'triage', label: '分诊' },
  { key: 'in_progress', label: '处理中' },
  { key: 'resolved', label: '已解决' },
  { key: 'closed', label: '已关闭' },
]

export function IssuesQueue({ initial }: { initial?: Record<string, string> }) {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const [status, setStatus] = useState(initial?.status ?? '')
  const [issues, setIssues] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerIssue, setDrawerIssue] = useState<any>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ pageSize: '100' })
      if (status) params.set('status', status)
      const data = await api.get<any>('/issues?' + params.toString())
      setIssues(data.issues || [])
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }, [status])

  useEffect(() => { load() }, [load])

  const updateStatus = async (id: string, next: string) => {
    await api.patch('/issues/' + id, { status: next })
    setDrawerIssue(null)
    await load()
    refreshBadges()
  }

  const openDetail = async (issueId: string) => {
    try {
      const data = await api.get<any>('/issues/' + issueId)
      setDrawerIssue({ ...data.issue, records: data.records || [], events: data.events || [] })
    } catch (err) { console.error(err) }
  }

  return (
    <div className="space-y-4">
      <WorkbenchTabs tabs={STATUS_TABS} activeKey={status} onChange={setStatus} />
      <p className="text-[12px] text-muted-foreground">问题 = 从「内容分诊」点「转问题」升级而来，用于把同一事件下的多条内容归到一起、跨内容跟踪处理进度。</p>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : issues.length === 0 ? (
        <EmptyState icon={AlertCircle} title="暂无问题" description="在分诊队列中将内容转为问题后显示在这里" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
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
                <tr key={i.id} className="cursor-pointer transition-colors hover:bg-muted/30" onClick={() => openDetail(i.id)}>
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
                    <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
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

      {drawerIssue && (
        <IssueDrawer
          issue={drawerIssue}
          onClose={() => setDrawerIssue(null)}
          canWrite={canWrite()}
          onUpdateStatus={updateStatus}
        />
      )}
    </div>
  )
}
