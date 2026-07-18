import { useEffect, useState, useCallback } from 'react'
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, UserRound, Files, Clock3 } from 'lucide-react'
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
const SEVERITY_ACCENT: Record<string, string> = {
  critical: 'border-l-status-darkred',
  high: 'border-l-status-red',
  medium: 'border-l-status-orange',
  low: 'border-l-status-grey',
}

export function IssuesQueue({ initial }: { initial?: Record<string, string> }) {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const [status, setStatus] = useState(initial?.status ?? '')
  const [issues, setIssues] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [drawerIssue, setDrawerIssue] = useState<any>(null)

  const load = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '30', page: String(page) })
      if (status) params.set('status', status)
      const data = await api.get<any>('/issues?' + params.toString())
      setIssues(data.issues || [])
      setPagination(data.pagination || null)
    } catch (err) { console.error(err) }
    finally { setLoading(false) }
  }, [status])

  useEffect(() => { load(1) }, [load])

  const updateStatus = async (id: string, next: string) => {
    await api.patch('/issues/' + id, { status: next })
    setDrawerIssue(null)
    await load(pagination?.page ?? 1)
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
        <>
          <div className="space-y-3 lg:hidden">
            {issues.map(issue => (
              <article
                key={issue.id}
                role="button"
                tabIndex={0}
                aria-label={`打开问题：${issue.title || '未命名问题'}`}
                onClick={() => openDetail(issue.id)}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openDetail(issue.id)
                  }
                }}
                className="overflow-hidden rounded-[18px] border border-border/70 bg-card shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)] outline-none transition active:scale-[0.995] focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div className={`border-l-4 px-4 pb-4 pt-3.5 ${SEVERITY_ACCENT[issue.severity] || 'border-l-status-grey'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <StatusBadge tone={issue.severity}>{LABELS.severity[issue.severity] || issue.severity}</StatusBadge>
                    <StatusBadge tone={issue.status}>{LABELS.issueStatus[issue.status] || issue.status}</StatusBadge>
                  </div>
                  <h3 className="mt-3 text-[16px] font-bold leading-6 text-foreground">{issue.title || '未命名问题'}</h3>
                  {(issue.primary_record_platform || issue.primary_record_title) && (
                    <p className="mt-1.5 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
                      {[issue.primary_record_platform, issue.primary_record_title].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-3 border-y border-border/50 bg-muted/20">
                  <div className="min-w-0 border-r border-border/50 px-3 py-3">
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><UserRound className="h-3 w-3" />负责人</div>
                    <div className="mt-1 truncate text-[12px] font-semibold text-foreground">{issue.owner_name || '未分配'}</div>
                  </div>
                  <div className="min-w-0 border-r border-border/50 px-3 py-3">
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><Files className="h-3 w-3" />关联内容</div>
                    <div className="mt-1 text-[12px] font-semibold tabular-nums text-foreground">{issue.record_count || 0} 条</div>
                  </div>
                  <div className="min-w-0 px-3 py-3">
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><Clock3 className="h-3 w-3" />最近更新</div>
                    <div className="mt-1 truncate text-[11px] font-medium text-foreground">{formatDate(issue.updated_at)}</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 px-3 py-3" onClick={event => event.stopPropagation()}>
                  <Button variant="outline" className="h-11 min-w-0 flex-1 rounded-xl" onClick={() => openDetail(issue.id)}>
                    查看详情<ChevronRight className="h-4 w-4" />
                  </Button>
                  {canWrite() && (
                    <>
                      <Button className="h-11 rounded-xl px-4" onClick={() => updateStatus(issue.id, 'resolved')}>解决</Button>
                      <Button variant="ghost" className="h-11 rounded-xl px-3" onClick={() => updateStatus(issue.id, 'closed')}>关闭</Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-border bg-card lg:block">
            <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b border-border/60 [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-[11px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider [&>th]:whitespace-nowrap [&>th]:text-muted-foreground">
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">问题</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">级别</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">状态</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">负责人</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">内容数</th>
              <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">更新时间</th>
              {canWrite() && <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">操作</th>}
            </tr></thead>
            <tbody className="divide-y divide-border/40">
              {issues.map(i => (
                <tr key={i.id} className="cursor-pointer transition-colors hover:bg-accent/45" onClick={() => openDetail(i.id)}>
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
        </>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card p-2 lg:justify-end lg:border-0 lg:bg-transparent lg:p-0">
          <Button variant="outline" className="h-10 flex-1 rounded-xl lg:h-8 lg:w-8 lg:flex-none lg:px-0" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}>
            <ChevronLeft className="h-4 w-4" /><span className="lg:hidden">上一页</span>
          </Button>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
          <Button variant="outline" className="h-10 flex-1 rounded-xl lg:h-8 lg:w-8 lg:flex-none lg:px-0" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}>
            <span className="lg:hidden">下一页</span><ChevronRight className="h-4 w-4" />
          </Button>
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
