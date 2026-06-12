import { X, Clock, FileText, Activity } from 'lucide-react'
import { formatDate, formatFullDate, formatNumber, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'

/**
 * 问题详情抽屉(摘要/建议/关联内容/时间线)。从问题处置页提取以供工作台问题队列复用。
 * issue 需已携带 records[] 与 events[](调用方在打开前用 GET /issues/:id 载入)。
 * 纯展示 + onUpdateStatus 回调,写后由调用方 reload + 关闭。
 */
export function IssueDrawer({ issue, onClose, canWrite, onUpdateStatus }: {
  issue: any
  onClose: () => void
  canWrite: boolean
  onUpdateStatus: (id: string, status: string) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-border bg-card shadow-lg animate-in slide-in-from-right duration-200"
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-bold">问题详情</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <h3 className="text-lg font-bold">{issue.title}</h3>

          <div className="grid grid-cols-2 gap-3">
            <InfoTile label="状态" badge tone={issue.status}>{LABELS.issueStatus[issue.status] || issue.status}</InfoTile>
            <InfoTile label="级别" badge tone={issue.severity}>{LABELS.severity[issue.severity] || issue.severity}</InfoTile>
            <InfoTile label="负责人">{issue.owner_name || '未分配'}</InfoTile>
            <InfoTile label="截止时间">{formatDate(issue.due_at) || '-'}</InfoTile>
          </div>

          {issue.summary && (
            <Section title="摘要"><p className="text-sm">{issue.summary}</p></Section>
          )}
          {issue.suggested_action && (
            <Section title="处理建议"><p className="text-sm">{issue.suggested_action}</p></Section>
          )}

          <Section title="关联内容">
            {(issue.records || []).length === 0 ? (
              <EmptyState icon={FileText} title="暂无关联内容" />
            ) : (
              <div className="space-y-2">
                {issue.records.map((r: any, i: number) => (
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
            {(issue.events || []).length === 0 ? (
              <EmptyState icon={Activity} title="暂无记录" />
            ) : (
              <div className="space-y-2">
                {issue.events.map((e: any, i: number) => (
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

        {canWrite && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
            <Button variant="outline" onClick={() => onUpdateStatus(issue.id, 'resolved')}>标为已解决</Button>
            <Button variant="ghost" onClick={() => onUpdateStatus(issue.id, 'closed')}>关闭问题</Button>
          </div>
        )}
      </div>
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
