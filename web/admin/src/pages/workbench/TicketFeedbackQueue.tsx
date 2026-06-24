import { useCallback, useEffect, useState } from 'react'
import { Loader2, ClipboardCheck, ExternalLink, RefreshCw, ChevronLeft, ChevronRight, CheckCircle2, Download, UserCog } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatNumber, platformName, LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { TicketDrawer } from '@/components/shared/TicketDrawer'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

const STATE_TONE: Record<string, string> = { pending: 'orange', doing: 'blue', done: 'positive', dismissed: 'muted', closed: 'positive' }
const STATE_LABEL: Record<string, string> = { pending: '待处理', doing: '处理中', done: '已处理', dismissed: '已忽略', closed: '已结案' }
const TABS = [
  { key: 'progress', label: '待处理' },
  { key: 'closed', label: '已结案' },
]

export function TicketFeedbackQueue() {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const { ask, dialog } = useNotePrompt()
  const [view, setView] = useState('progress')
  const [items, setItems] = useState<any[]>([])
  const [counts, setCounts] = useState<{ review: number; progress: number; total: number; closed: number }>({ review: 0, progress: 0, total: 0, closed: 0 })
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState<any>(null)

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError('')
    try {
      const data = await api.get<any>(`/tickets/dispatched?view=${view}&page=${page}&pageSize=30`)
      setItems(data.items || [])
      setCounts(data.counts || { review: 0, progress: 0, total: 0, closed: 0 })
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally { setLoading(false) }
  }, [view])

  useEffect(() => { load(1) }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeTicket = async (item: any) => {
    const v = await ask({ title: '结案', placeholder: '填写结案说明 / 处理结论(可留空)' })
    if (v === null) return
    await api.patch(`/tickets/${item.id}`, { action: 'close', note: v })
    setDrawer(null)
    await load(pagination?.page ?? 1)
    refreshBadges()
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">转出的工单在这里处理:打开工单填写「过程备注」记录处理进展,处理完点【结案】闭环。</p>

      <WorkbenchTabs
        tabs={TABS.map(t => {
          const n = t.key === 'progress' ? counts.progress : t.key === 'closed' ? counts.closed : counts.total
          return { key: t.key, label: `${t.label}${n ? ` (${n})` : ''}` }
        })}
        activeKey={view}
        onChange={setView}
      />

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? items.length)} 个工单`}>
        <Button variant="outline" size="sm" onClick={() => api.download(`/tickets/export?view=${view}`, '已转工单.xlsx')}><Download className="h-3.5 w-3.5" />导出</Button>
        <Button variant="outline" size="sm" onClick={() => load(1)}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
      </WorkbenchToolbar>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <EmptyState icon={ClipboardCheck} title="加载失败" description={error} />
      ) : items.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="暂无工单" description="在内容分诊 / 评论分诊点【转工单】后,工单会出现在这里供你跟踪" />
      ) : (
        <WorkbenchTableShell>
          <table className="w-full min-w-[1040px] text-sm">
            <thead><tr className="border-b border-border/60 [&>th]:px-3 [&>th]:py-3 [&>th]:text-[11px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider [&>th]:whitespace-nowrap [&>th]:text-muted-foreground">
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">工单内容</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">处理人 / 转单</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">处理进展</th>
              <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border/40">
              {items.map(it => (
                <tr key={it.id} onClick={() => setDrawer(it)} className={`cursor-pointer align-top transition-colors hover:bg-accent/45 ${drawer?.id === it.id ? 'bg-accent' : ''}`}>
                  <td className="max-w-[360px] px-4 py-3">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <StatusBadge tone={it.source_type === 'comment' ? 'neutral' : 'active'}>{it.source_type === 'comment' ? '评论' : '内容'}</StatusBadge>
                      <StatusBadge tone="neutral">{platformName(it.platform)}</StatusBadge>
                      <StatusBadge tone={it.priority}>{LABELS.priority[it.priority] || it.priority}</StatusBadge>
                      {it.url && <a href={it.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary hover:underline">原文<ExternalLink className="h-3 w-3" /></a>}
                    </div>
                    <div className="line-clamp-2 text-[13px] leading-5 text-foreground">{it.item_text || it.title || '(无内容)'}</div>
                    {it.author && <div className="mt-1 text-[11px] text-muted-foreground">作者 {it.author}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="flex items-center gap-1 text-muted-foreground"><UserCog className="h-3 w-3" /><span className="font-medium text-foreground">{it.assignee_name || '本人跟进'}</span></div>
                    <div className="mt-0.5 text-muted-foreground">转单 {it.created_by_name || '-'}</div>
                    <div className="mt-0.5 whitespace-nowrap text-muted-foreground/70">{formatDate(it.created_at)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={STATE_TONE[it.status] || 'muted'}>{STATE_LABEL[it.status] || it.status}</StatusBadge>
                  </td>
                  <td className="max-w-[300px] px-4 py-3 text-xs">
                    {it.status === 'closed' ? <>
                      <div className="line-clamp-2 leading-5 text-foreground">{it.handle_note || '(无结案说明)'}</div>
                      <div className="mt-0.5 text-muted-foreground">{it.handled_by_name || '-'}{(it.reviewed_at || it.handled_at) ? ` · ${formatDate(it.reviewed_at || it.handled_at)}` : ''}</div>
                    </> : it.latest_note ? <>
                      <div className="line-clamp-2 leading-5 text-foreground">{it.latest_note}</div>
                      {it.notes_count > 1 && <div className="mt-0.5 text-muted-foreground/70">共 {it.notes_count} 条备注</div>}
                    </> : <span className="text-muted-foreground/60">— 未开始</span>}
                  </td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      {canWrite() && it.status !== 'closed'
                        ? <Button variant="outline" size="sm" onClick={() => closeTicket(it)}><CheckCircle2 className="h-3.5 w-3.5" />结案</Button>
                        : <span className="text-[11px] text-muted-foreground/60">{it.status === 'closed' ? '已结案' : '跟踪中'}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </WorkbenchTableShell>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-xs text-muted-foreground">{pagination.page} / {pagination.totalPages}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}

      {drawer && (
        <TicketDrawer
          ticket={drawer}
          canWrite={canWrite()}
          onClose={() => setDrawer(null)}
          onCloseTicket={() => closeTicket(drawer)}
        />
      )}
      {dialog}
    </div>
  )
}
