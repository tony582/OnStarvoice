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
const PRIORITY_ACCENT: Record<string, string> = {
  urgent: 'border-l-status-darkred',
  high: 'border-l-status-red',
  normal: 'border-l-status-blue',
  low: 'border-l-status-grey',
}
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
        <>
          <div className="space-y-3 lg:hidden">
            {items.map(it => {
              const closed = it.status === 'closed'
              const progress = closed
                ? (it.handle_note || '(无结案说明)')
                : (it.latest_note || '尚未开始处理')

              return (
                <article
                  key={it.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`打开工单：${it.item_text || it.title || '无标题工单'}`}
                  onClick={() => setDrawer(it)}
                  onKeyDown={event => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setDrawer(it)
                    }
                  }}
                  className="overflow-hidden rounded-[18px] border border-border/70 bg-card shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)] outline-none transition active:scale-[0.995] focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <div className={`border-l-4 px-4 pb-3.5 pt-4 ${PRIORITY_ACCENT[it.priority] || 'border-l-status-grey'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <StatusBadge tone={it.source_type === 'comment' ? 'neutral' : 'active'}>{it.source_type === 'comment' ? '评论' : '内容'}</StatusBadge>
                        <StatusBadge tone="neutral">{platformName(it.platform)}</StatusBadge>
                        <StatusBadge tone={STATE_TONE[it.status] || 'muted'}>{STATE_LABEL[it.status] || it.status}</StatusBadge>
                      </div>
                      <StatusBadge tone={it.priority}>{LABELS.priority[it.priority] || it.priority}</StatusBadge>
                    </div>

                    <div className="mt-3 line-clamp-3 text-[15px] font-semibold leading-6 text-foreground">
                      {it.item_text || it.title || '(无内容)'}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      {it.author && <span>作者 {it.author}</span>}
                      <span>{formatDate(it.created_at)}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 border-y border-border/50 bg-muted/20">
                    <div className="min-w-0 border-r border-border/50 px-4 py-3">
                      <div className="text-[10px] font-medium tracking-wide text-muted-foreground">当前处理人</div>
                      <div className="mt-1 flex items-center gap-1.5 truncate text-[13px] font-semibold text-foreground">
                        <UserCog className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="truncate">{it.assignee_name || '本人跟进'}</span>
                      </div>
                    </div>
                    <div className="min-w-0 px-4 py-3">
                      <div className="text-[10px] font-medium tracking-wide text-muted-foreground">转单人</div>
                      <div className="mt-1 truncate text-[13px] font-semibold text-foreground">{it.created_by_name || '-'}</div>
                    </div>
                  </div>

                  <div className="px-4 py-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-muted-foreground">{closed ? '结案结论' : '最新进展'}</span>
                      {!closed && it.notes_count > 1 && <span className="text-[10px] text-muted-foreground">共 {it.notes_count} 条备注</span>}
                    </div>
                    <p className={`mt-1.5 line-clamp-3 text-[13px] leading-5 ${it.latest_note || closed ? 'text-foreground' : 'text-muted-foreground'}`}>{progress}</p>
                    {closed && (
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {it.handled_by_name || '-'}{(it.reviewed_at || it.handled_at) ? ` · ${formatDate(it.reviewed_at || it.handled_at)}` : ''}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 border-t border-border/50 px-3 py-3" onClick={event => event.stopPropagation()}>
                    {it.url && (
                      <a
                        href={it.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/5"
                      >
                        原文<ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                    <Button variant="outline" className="h-11 min-w-0 flex-1 rounded-xl" onClick={() => setDrawer(it)}>
                      查看工单<ChevronRight className="h-4 w-4" />
                    </Button>
                    {canWrite() && !closed && (
                      <Button className="h-11 rounded-xl px-4" onClick={() => closeTicket(it)}>
                        <CheckCircle2 className="h-4 w-4" />结案
                      </Button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>

          <WorkbenchTableShell className="hidden lg:block" mobileHint={false}>
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
