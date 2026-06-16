import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Inbox, Search, RefreshCw, ChevronLeft, ChevronRight, ExternalLink, UserCog } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { TicketDrawer } from '@/components/shared/TicketDrawer'
import { useAuth } from '@/lib/auth'
import { useBadges } from '@/lib/badges'

const STATE_TABS = [
  { key: 'open', label: '待处理', countKeys: ['pending', 'doing'] },
  { key: 'done', label: '已处理', countKeys: ['done'] },
  { key: 'dismissed', label: '已忽略', countKeys: ['dismissed'] },
]
const TYPE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'content', label: '内容(主贴)' },
  { value: 'comment', label: '评论' },
]
const PLATFORM_OPTIONS = [
  { value: '', label: '全部平台' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'weibo', label: '微博' },
]
const STATE_TONE: Record<string, string> = { pending: 'orange', doing: 'blue', done: 'positive', dismissed: 'muted' }
const STATE_LABEL: Record<string, string> = { pending: '待处理', doing: '处理中', done: '已处理', dismissed: '已忽略' }
const FEEDBACK_LABEL: Record<string, string> = { pending_review: '待分诊确认', confirmed: '分诊已确认', reopened: '被打回' }

interface Pagination { page: number; totalPages: number; total: number }

export function OpinionPage() {
  const { canWrite } = useAuth()
  const { refresh: refreshBadges } = useBadges()
  const { ask, dialog } = useNotePrompt()
  const [state, setState] = useState('open')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])
  const [type, setType] = useState('')
  const [platform, setPlatform] = useState('')
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<any[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({ pending: 0, doing: 0, done: 0, dismissed: 0 })
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState<any>(null)

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: '30', status: state })
      if (type) p.set('type', type)
      if (platform) p.set('platform', platform)
      if (keyword.trim()) p.set('q', keyword.trim())
      const data = await api.get<any>('/tickets?' + p.toString())
      setItems(data.items || [])
      setCounts(data.counts || { pending: 0, doing: 0, done: 0, dismissed: 0 })
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally { setLoading(false) }
  }, [state, type, platform, keyword])

  useEffect(() => { load(1) }, [state, type, platform]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (item: any, action: string, needNote = false) => {
    let note: string | undefined
    if (needNote) {
      const v = await ask({
        title: action === 'dismiss' ? '忽略原因' : '处理结果',
        placeholder: action === 'dismiss' ? '例如:与本品牌无关 / 重复工单' : '例如:已官方回复并私信用户 / 已转售后跟进',
      })
      if (v === null) return
      note = v
    }
    await api.patch(`/tickets/${item.id}`, { action, ...(note !== undefined ? { note } : {}) })
    setDrawer(null)
    await load(pagination?.page ?? 1)
    refreshBadges()
    if (action === 'done' || action === 'dismiss') {
      setToast(action === 'done' ? '已处理完成,已回执给分诊确认' : '已忽略,已回执给分诊')
      window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(''), 2600)
    }
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <p className="text-[13px] text-muted-foreground">分诊团队转来的工单在这里处理:认领 →「处理中」→ 处理完成。处理完会回执给分诊确认。</p>

      <WorkbenchTabs
        tabs={STATE_TABS.map(t => { const n = t.countKeys.reduce((s, k) => s + (counts[k] || 0), 0); return { key: t.key, label: `${t.label}${n ? ` (${n})` : ''}` } })}
        activeKey={state}
        onChange={setState}
      />

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? items.length)} 个工单`}>
        <WorkbenchSelect value={type} onChange={e => setType(e.target.value)}>
          {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </WorkbenchSelect>
        <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
          {PLATFORM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </WorkbenchSelect>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={keyword} onChange={e => setKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && load(1)} placeholder="搜索工单内容 / 作者" className="h-8 w-48 pl-8 text-[13px]" />
        </div>
        <Button variant="outline" size="sm" onClick={() => load(1)}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
      </WorkbenchToolbar>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <EmptyState icon={Inbox} title="加载失败" description={error} />
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} title={`暂无${STATE_TABS.find(t => t.key === state)?.label || ''}的工单`} description="分诊团队在「工作台」点【转工单】后,工单会进入这里" />
      ) : (
        <WorkbenchTableShell>
          <table className="w-full min-w-[940px] text-sm">
            <thead><tr className="border-b border-border bg-muted">
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">工单内容</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">来源 / 指派</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">优先级</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {items.map(it => (
                <tr key={it.id} onClick={() => setDrawer(it)} className={`cursor-pointer align-top transition-colors hover:bg-muted/30 ${drawer?.id === it.id ? 'bg-accent' : ''}`}>
                  <td className="max-w-[440px] px-4 py-3">
                    <div className="mb-1 flex items-center gap-1.5">
                      <StatusBadge tone={it.source_type === 'comment' ? 'neutral' : 'active'}>{it.source_type === 'comment' ? '评论' : '内容'}</StatusBadge>
                      <StatusBadge tone="neutral">{platformName(it.platform)}</StatusBadge>
                      {it.category && <StatusBadge tone="neutral">{LABELS.leadType[it.category] || it.category}</StatusBadge>}
                      {it.url && <a href={it.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary hover:underline">原文<ExternalLink className="h-3 w-3" /></a>}
                    </div>
                    <div className="line-clamp-2 text-[13px] leading-5 text-foreground">{it.item_text || it.title || '(无内容)'}</div>
                    {it.dispatch_note && <div className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] leading-5 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">转单说明:{it.dispatch_note}</div>}
                    {(it.handle_note || it.handled_at) && (
                      <div className="mt-1.5 rounded-md bg-muted/50 px-2 py-1 text-[11px] leading-5 text-muted-foreground">
                        处理留痕:{it.handle_note || '—'}
                        {(it.handled_by_name || it.handled_at) && <span className="ml-1 opacity-70">· {it.handled_by_name || '—'}{it.handled_at ? ` · ${formatDate(it.handled_at)}` : ''}</span>}
                      </div>
                    )}
                    {it.feedback_status === 'reopened' && it.review_note && <div className="mt-1.5 rounded-md bg-rose-50 px-2 py-1 text-[11px] leading-5 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">分诊打回:{it.review_note}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="text-muted-foreground">作者 <span className="font-medium text-foreground">{it.author || '-'}</span></div>
                    <div className="mt-0.5 text-muted-foreground">转单 {it.created_by_name || '-'}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-muted-foreground"><UserCog className="h-3 w-3" />{it.assignee_name || '公共池'}</div>
                    <div className="mt-0.5 whitespace-nowrap text-muted-foreground/70">{formatDate(it.created_at)}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge tone={it.priority}>{LABELS.priority[it.priority] || it.priority}</StatusBadge></td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={STATE_TONE[it.status] || 'muted'}>{STATE_LABEL[it.status] || it.status}</StatusBadge>
                    {it.feedback_status && it.feedback_status !== 'none' && it.status !== 'pending' && (
                      <div className="mt-1 text-[10.5px] text-muted-foreground">{FEEDBACK_LABEL[it.feedback_status] || ''}</div>
                    )}
                  </td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <div className="flex flex-wrap justify-end gap-1">
                      {canWrite() && (it.status === 'pending' || it.status === 'doing') && <>
                        <Button size="sm" onClick={() => act(it, 'done', true)}>处理完成</Button>
                        <Button variant="ghost" size="sm" onClick={() => act(it, 'dismiss', true)}>忽略</Button>
                      </>}
                      {(it.status === 'done' || it.status === 'dismissed') &&
                        <span className="text-[11px] text-muted-foreground">{it.feedback_status === 'pending_review' ? '待分诊确认' : '已完成'}</span>}
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
          onAction={(action) => act(drawer, action, action === 'done' || action === 'dismiss')}
        />
      )}
      {dialog}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-lg bg-foreground px-4 py-2.5 text-[13px] font-medium text-background shadow-lg animate-in fade-in slide-in-from-bottom-2">
          {toast}
        </div>
      )}
    </div>
  )
}
