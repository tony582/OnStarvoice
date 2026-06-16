import { useCallback, useEffect, useState } from 'react'
import { Loader2, Inbox, Search, RefreshCw, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { compact, formatDate, formatNumber, LABELS, platformName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import { WorkbenchSelect, WorkbenchTableShell, WorkbenchTabs, WorkbenchToolbar } from '@/components/shared/Workbench'
import { useNotePrompt } from '@/components/shared/NotePrompt'
import { useAuth } from '@/lib/auth'

const STATE_TABS = [
  { key: 'pending', label: '待处理' },
  { key: 'doing', label: '处理中' },
  { key: 'done', label: '已处理' },
  { key: 'dismissed', label: '已忽略' },
]
const TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
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

interface Pagination { page: number; totalPages: number; total: number }

export function OpinionPage() {
  const { canWrite } = useAuth()
  const { ask, dialog } = useNotePrompt()
  const [state, setState] = useState('pending')
  const [type, setType] = useState('')
  const [platform, setPlatform] = useState('')
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<any[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({ pending: 0, doing: 0, done: 0, dismissed: 0 })
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: '30', state })
      if (type) p.set('type', type)
      if (platform) p.set('platform', platform)
      if (keyword.trim()) p.set('q', keyword.trim())
      const data = await api.get<any>('/opinion?' + p.toString())
      setItems(data.items || [])
      setCounts(data.counts || { pending: 0, doing: 0, done: 0, dismissed: 0 })
      setPagination(data.pagination || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally { setLoading(false) }
  }, [state, type, platform, keyword])

  useEffect(() => { load(1) }, [state, type, platform]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (item: any, next: string, needNote = false) => {
    let note: string | undefined
    if (needNote) {
      const v = await ask({ title: '处理备注', placeholder: '例如：已官方回复 / 已转售后 / 与品牌无关' })
      if (v === null) return
      note = v
    }
    await api.patch(`/opinion/${item.item_type}/${item.id}`, { state: next, ...(note !== undefined ? { note } : {}) })
    await load(pagination?.page ?? 1)
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <p className="text-[13px] text-muted-foreground">所有需要处理的舆情(负面内容 + 风险评论)统一在这里,按"待处理 → 处理中 → 已处理 / 已忽略"流转。销售客资单独走。</p>

      <WorkbenchTabs
        tabs={STATE_TABS.map(t => ({ key: t.key, label: `${t.label}${counts[t.key] ? ` (${counts[t.key]})` : ''}` }))}
        activeKey={state}
        onChange={setState}
      />

      <WorkbenchToolbar meta={`${formatNumber(pagination?.total ?? items.length)} 条`}>
        <WorkbenchSelect value={type} onChange={e => setType(e.target.value)}>
          {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </WorkbenchSelect>
        <WorkbenchSelect value={platform} onChange={e => setPlatform(e.target.value)}>
          {PLATFORM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </WorkbenchSelect>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={keyword} onChange={e => setKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && load(1)} placeholder="搜索内容 / 作者" className="h-8 w-48 pl-8 text-[13px]" />
        </div>
        <Button variant="outline" size="sm" onClick={() => load(1)}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
      </WorkbenchToolbar>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <EmptyState icon={Inbox} title="加载失败" description={error} />
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} title={`暂无${STATE_LABEL[state]}的舆情`} description="采集到的负面内容和风险评论会自动进入这里" />
      ) : (
        <WorkbenchTableShell>
          <table className="w-full min-w-[920px] text-sm">
            <thead><tr className="border-b border-border bg-muted">
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">舆情内容</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">来源</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">标签</th>
              <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-2.5 text-right text-[12px] font-medium text-muted-foreground">操作</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {items.map(it => (
                <tr key={`${it.item_type}-${it.id}`} className="align-top transition-colors hover:bg-muted/30">
                  <td className="max-w-[440px] px-4 py-3">
                    <div className="mb-1 flex items-center gap-1.5">
                      <StatusBadge tone={it.item_type === 'comment' ? 'neutral' : 'active'}>{it.item_type === 'comment' ? '评论' : '内容'}</StatusBadge>
                      <StatusBadge tone="neutral">{platformName(it.platform)}</StatusBadge>
                      {it.url && <a href={it.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary hover:underline">原文<ExternalLink className="h-3 w-3" /></a>}
                    </div>
                    <div className="line-clamp-2 text-[13px] leading-5 text-foreground">{it.item_text || '(无内容)'}</div>
                    {it.item_type === 'comment' && it.record_title && <div className="mt-1 truncate text-[11px] text-muted-foreground">原帖:{compact(it.record_title, 30)}</div>}
                    {(it.opinion_note || it.opinion_handled_at) && (
                      <div className="mt-1.5 rounded-md bg-muted/50 px-2 py-1 text-[11px] leading-5 text-muted-foreground">
                        留痕:{it.opinion_note || '—'}
                        {(it.opinion_handled_name || it.opinion_handled_at) && <span className="ml-1 opacity-70">· {it.opinion_handled_name || '—'}{it.opinion_handled_at ? ` · ${formatDate(it.opinion_handled_at)}` : ''}</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="font-medium text-foreground">{it.author || '-'}</div>
                    {it.ip && <div className="mt-0.5 whitespace-nowrap text-muted-foreground">IP {it.ip}</div>}
                    <div className="mt-0.5 whitespace-nowrap text-muted-foreground">{formatDate(it.ts)}</div>
                  </td>
                  <td className="px-4 py-3">
                    {it.item_type === 'content'
                      ? <div className="flex flex-col gap-1">
                          <StatusBadge tone={it.sentiment === 'negative' ? 'negative' : it.sentiment === 'positive' ? 'positive' : 'muted'}>{LABELS.sentiment[it.sentiment] || '待标注'}</StatusBadge>
                          {it.neg_comments > 0 && <span className="text-[10.5px] text-status-red">负评 {it.neg_comments}</span>}
                        </div>
                      : <div className="flex flex-col gap-1">
                          <StatusBadge tone="neutral">{LABELS.leadType[it.lead_type] || it.lead_type}</StatusBadge>
                          <StatusBadge tone={it.priority}>{LABELS.priority[it.priority] || it.priority}</StatusBadge>
                        </div>}
                  </td>
                  <td className="px-4 py-3"><StatusBadge tone={STATE_TONE[it.opinion_state] || 'muted'}>{STATE_LABEL[it.opinion_state] || it.opinion_state}</StatusBadge></td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-1">
                      {canWrite() && it.opinion_state === 'pending' && <>
                        <Button variant="outline" size="sm" onClick={() => act(it, 'doing')}>开始处理</Button>
                        <Button variant="outline" size="sm" onClick={() => act(it, 'done', true)}>处理完成</Button>
                        <Button variant="ghost" size="sm" onClick={() => act(it, 'dismissed', true)}>忽略</Button>
                      </>}
                      {canWrite() && it.opinion_state === 'doing' && <>
                        <Button variant="outline" size="sm" onClick={() => act(it, 'done', true)}>处理完成</Button>
                        <Button variant="ghost" size="sm" onClick={() => act(it, 'pending')}>退回</Button>
                      </>}
                      {canWrite() && (it.opinion_state === 'done' || it.opinion_state === 'dismissed') &&
                        <Button variant="ghost" size="sm" onClick={() => act(it, 'pending')}>重新打开</Button>}
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
