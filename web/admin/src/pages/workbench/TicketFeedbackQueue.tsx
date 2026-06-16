import { useCallback, useEffect, useState } from 'react'
import { Loader2, ClipboardCheck, ExternalLink, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatNumber, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchTableShell, WorkbenchToolbar } from '@/components/shared/Workbench'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

export function TicketFeedbackQueue() {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const { ask, dialog } = useNotePrompt()
  const [items, setItems] = useState<any[]>([])
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError('')
    try {
      const data = await api.get<any>(`/tickets/feedback?page=${page}&pageSize=30`)
      setItems(data.items || [])
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load(1) }, [load])

  const review = async (item: any, decision: 'confirm' | 'reopen') => {
    let note: string | undefined
    if (decision === 'reopen') {
      const v = await ask({ title: '打回重处理', placeholder: '说明为什么打回,客服会看到并重新处理' })
      if (v === null) return
      note = v
    }
    await api.patch(`/tickets/${item.id}/review`, { decision, ...(note !== undefined ? { note } : {}) })
    await load(pagination?.page ?? 1)
    refreshBadges()
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">客服处理完的工单在这里回执。核对处理结果后【确认归档】闭环;不满意可【打回】让客服重处理。</p>

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? items.length)} 个待确认`}>
        <Button variant="outline" size="sm" onClick={() => load(1)}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
      </WorkbenchToolbar>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <EmptyState icon={ClipboardCheck} title="加载失败" description={error} />
      ) : items.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="暂无待确认的工单" description="客服处理完工单后,回执会出现在这里等你确认归档" />
      ) : (
        <WorkbenchTableShell>
          <table className="w-full min-w-[920px] text-sm">
            <thead><tr className="border-b border-border bg-muted">
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">工单内容</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">处理结果</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">结论</th>
              <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {items.map(it => (
                <tr key={it.id} className="align-top transition-colors hover:bg-muted/30">
                  <td className="max-w-[380px] px-4 py-3">
                    <div className="mb-1 flex items-center gap-1.5">
                      <StatusBadge tone={it.source_type === 'comment' ? 'neutral' : 'active'}>{it.source_type === 'comment' ? '评论' : '内容'}</StatusBadge>
                      <StatusBadge tone="neutral">{platformName(it.platform)}</StatusBadge>
                      {it.url && <a href={it.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary hover:underline">原文<ExternalLink className="h-3 w-3" /></a>}
                    </div>
                    <div className="line-clamp-2 text-[13px] leading-5 text-foreground">{it.item_text || it.title || '(无内容)'}</div>
                  </td>
                  <td className="max-w-[320px] px-4 py-3 text-xs">
                    <div className="leading-5 text-foreground">{it.handle_note || '(无说明)'}</div>
                    <div className="mt-1 text-muted-foreground">{it.handled_by_name || '-'}{it.handled_at ? ` · ${formatDate(it.handled_at)}` : ''}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={it.status === 'dismissed' ? 'muted' : 'positive'}>{it.status === 'dismissed' ? '已忽略' : '已处理'}</StatusBadge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-1">
                      {canWrite() ? <>
                        <Button variant="outline" size="sm" onClick={() => review(it, 'confirm')}>确认归档</Button>
                        <Button variant="ghost" size="sm" onClick={() => review(it, 'reopen')}>打回</Button>
                      </> : <span className="text-[11px] text-muted-foreground">无权限</span>}
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

      {dialog}
    </div>
  )
}
