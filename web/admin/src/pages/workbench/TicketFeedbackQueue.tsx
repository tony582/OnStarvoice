import { useCallback, useEffect, useState } from 'react'
import { Loader2, ClipboardCheck, ExternalLink, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatNumber, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { TicketDrawer } from '@/components/shared/TicketDrawer'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

const STATE_TONE: Record<string, string> = { pending: 'orange', doing: 'blue', done: 'positive', dismissed: 'muted' }
const STATE_LABEL: Record<string, string> = { pending: '待客服领取', doing: '客服处理中', done: '已处理', dismissed: '已忽略' }
const TABS = [
  { key: 'review', label: '待确认' },
  { key: 'progress', label: '处理中' },
  { key: '', label: '全部' },
]

export function TicketFeedbackQueue() {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const { ask, dialog } = useNotePrompt()
  const [view, setView] = useState('review')
  const [items, setItems] = useState<any[]>([])
  const [counts, setCounts] = useState<{ review: number; progress: number; total: number }>({ review: 0, progress: 0, total: 0 })
  const [pagination, setPagination] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState<any>(null)

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError('')
    try {
      const data = await api.get<any>(`/tickets/dispatched?view=${view}&page=${page}&pageSize=30`)
      setItems(data.items || [])
      setCounts(data.counts || { review: 0, progress: 0, total: 0 })
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally { setLoading(false) }
  }, [view])

  useEffect(() => { load(1) }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  const review = async (item: any, decision: 'confirm' | 'reopen') => {
    let note: string | undefined
    if (decision === 'reopen') {
      const v = await ask({ title: '打回重处理', placeholder: '说明为什么打回,客服会看到并重新处理' })
      if (v === null) return
      note = v
    }
    await api.patch(`/tickets/${item.id}/review`, { decision, ...(note !== undefined ? { note } : {}) })
    setDrawer(null)
    await load(pagination?.page ?? 1)
    refreshBadges()
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">你转出去的工单都在这里:可看客服处理进度;客服处理完会进「待确认」,核对后【确认归档】闭环,不满意可【打回】。</p>

      <WorkbenchTabs
        tabs={TABS.map(t => {
          const n = t.key === 'review' ? counts.review : t.key === 'progress' ? counts.progress : counts.total
          return { key: t.key, label: `${t.label}${n ? ` (${n})` : ''}` }
        })}
        activeKey={view}
        onChange={setView}
      />

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? items.length)} 个工单`}>
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
          <table className="w-full min-w-[920px] text-sm">
            <thead><tr className="border-b border-border/60 [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-[11px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider [&>th]:whitespace-nowrap [&>th]:text-muted-foreground">
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">工单内容</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">客服状态</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">处理结果</th>
              <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border/40">
              {items.map(it => (
                <tr key={it.id} onClick={() => setDrawer(it)} className={`cursor-pointer align-top transition-colors hover:bg-accent/45 ${drawer?.id === it.id ? 'bg-accent' : ''}`}>
                  <td className="max-w-[380px] px-4 py-3">
                    <div className="mb-1 flex items-center gap-1.5">
                      <StatusBadge tone={it.source_type === 'comment' ? 'neutral' : 'active'}>{it.source_type === 'comment' ? '评论' : '内容'}</StatusBadge>
                      <StatusBadge tone="neutral">{platformName(it.platform)}</StatusBadge>
                      {it.url && <a href={it.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary hover:underline">原文<ExternalLink className="h-3 w-3" /></a>}
                    </div>
                    <div className="line-clamp-2 text-[13px] leading-5 text-foreground">{it.item_text || it.title || '(无内容)'}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">指派 {it.assignee_name || '公共池'}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={STATE_TONE[it.status] || 'muted'}>{STATE_LABEL[it.status] || it.status}</StatusBadge>
                    {it.feedback_status === 'pending_review' && <div className="mt-1 text-[10.5px] text-amber-600 dark:text-amber-400">待你确认</div>}
                    {it.feedback_status === 'reopened' && <div className="mt-1 text-[10.5px] text-muted-foreground">已打回</div>}
                  </td>
                  <td className="max-w-[280px] px-4 py-3 text-xs">
                    {it.handle_note || it.handled_at ? <>
                      <div className="leading-5 text-foreground">{it.handle_note || '(无说明)'}</div>
                      <div className="mt-0.5 text-muted-foreground">{it.handled_by_name || '-'}{it.handled_at ? ` · ${formatDate(it.handled_at)}` : ''}</div>
                    </> : <span className="text-muted-foreground/60">—</span>}
                  </td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <div className="flex flex-wrap justify-end gap-1">
                      {canWrite() && it.feedback_status === 'pending_review' ? <>
                        <Button variant="outline" size="sm" onClick={() => review(it, 'confirm')}>确认归档</Button>
                        <Button variant="ghost" size="sm" onClick={() => review(it, 'reopen')}>打回</Button>
                      </> : <span className="text-[11px] text-muted-foreground/60">跟踪中</span>}
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
          onReview={drawer.feedback_status === 'pending_review' ? (decision) => review(drawer, decision) : undefined}
        />
      )}
      {dialog}
    </div>
  )
}
