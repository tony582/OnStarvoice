import { useEffect, useState } from 'react'
import { Loader2, AlertCircle, X, Clock, User, FileText, Activity } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatFullDate, formatNumber, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { useAuth } from '@/lib/auth'

export function IssuesPage() {
  const { canWrite } = useAuth()
  const [issues, setIssues] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerIssue, setDrawerIssue] = useState<any>(null)

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
    setDrawerIssue(null)
  }

  const openDetail = async (issueId: string) => {
    try {
      const data = await api.get<any>('/issues/' + issueId)
      setDrawerIssue({ ...data.issue, records: data.records || [], events: data.events || [] })
    } catch (err) { console.error(err) }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      {issues.length === 0 ? (
        <EmptyState icon={AlertCircle} title="暂无问题" description="在收件箱中将内容转为问题后显示在这里" />
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

      {/* Issue detail drawer */}
      {drawerIssue && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setDrawerIssue(null)}>
          <div className="absolute inset-0 bg-black/35" />
          <div className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200"
            onClick={e => e.stopPropagation()}>

            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <h2 className="text-base font-bold">问题详情</h2>
              <button onClick={() => setDrawerIssue(null)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"><X className="h-5 w-5" /></button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-6">
              <h3 className="text-lg font-bold">{drawerIssue.title}</h3>

              <div className="grid grid-cols-2 gap-3">
                <InfoTile label="状态" badge tone={drawerIssue.status}>{LABELS.issueStatus[drawerIssue.status] || drawerIssue.status}</InfoTile>
                <InfoTile label="级别" badge tone={drawerIssue.severity}>{LABELS.severity[drawerIssue.severity] || drawerIssue.severity}</InfoTile>
                <InfoTile label="负责人">{drawerIssue.owner_name || '未分配'}</InfoTile>
                <InfoTile label="截止时间">{formatDate(drawerIssue.due_at) || '-'}</InfoTile>
              </div>

              {drawerIssue.summary && (
                <Section title="摘要"><p className="text-sm">{drawerIssue.summary}</p></Section>
              )}
              {drawerIssue.suggested_action && (
                <Section title="处理建议"><p className="text-sm">{drawerIssue.suggested_action}</p></Section>
              )}

              <Section title="关联内容">
                {drawerIssue.records.length === 0 ? (
                  <EmptyState icon={FileText} title="暂无关联内容" />
                ) : (
                  <div className="space-y-2">
                    {drawerIssue.records.map((r: any, i: number) => (
                      <div key={i} className="flex items-center justify-between rounded-lg border border-border p-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{r.title || r.content || '(无标题)'}</div>
                          <div className="text-xs text-muted-foreground">{r.platform} · {formatNumber(r.likes + r.comments_count + r.collects + r.shares)} 互动</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="时间线">
                {drawerIssue.events.length === 0 ? (
                  <EmptyState icon={Activity} title="暂无记录" />
                ) : (
                  <div className="space-y-2">
                    {drawerIssue.events.map((e: any, i: number) => (
                      <div key={i} className="flex items-start gap-3 rounded-lg border border-border p-3">
                        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div>
                          <div className="text-sm font-medium">{e.body || e.event_type}</div>
                          <div className="text-xs text-muted-foreground">{e.actor_name || e.actor_type} · {formatFullDate(e.created_at)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </div>

            {canWrite() && (
              <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
                <Button variant="outline" onClick={() => updateStatus(drawerIssue.id, 'resolved')}>标为已解决</Button>
                <Button variant="ghost" onClick={() => updateStatus(drawerIssue.id, 'closed')}>关闭问题</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h4>
      {children}
    </div>
  )
}

function InfoTile({ label, children, badge, tone }: { label: string; children: React.ReactNode; badge?: boolean; tone?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1">{badge ? <StatusBadge tone={tone}>{children}</StatusBadge> : <span className="text-sm font-semibold">{children}</span>}</div>
    </div>
  )
}
