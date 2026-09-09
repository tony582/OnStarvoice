import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, History, Loader2, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { TaskCard } from './TaskCard'
import type { CloudTask, TaskHistoryResponse } from './lib'

type HistoryFilters = {
  q: string
  platform: string
  status: string
  from: string
  to: string
}

type Props = {
  surface?: 'desktop' | 'mobile'
  writable: boolean
  actionTaskId: string
  refreshKey?: string | number
  onResume: (task: CloudTask) => Promise<void>
  onRetryOnIdleAgent: (task: CloudTask) => Promise<void>
  onStop: (task: CloudTask) => Promise<void>
  onDismissAttention: (task: CloudTask) => Promise<void>
  onOpenOrchestration: (task: CloudTask) => void
  onOpenResult: (task: CloudTask) => void
  onCleared?: () => void | Promise<void>
  onTotalChange?: (total: number) => void
}

function dateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function defaultFilters(): HistoryFilters {
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - 29)
  return { q: '', platform: '', status: '', from: dateKey(from), to: dateKey(to) }
}

export function HistoryView({
  surface = 'desktop',
  writable,
  actionTaskId,
  refreshKey,
  onResume,
  onRetryOnIdleAgent,
  onStop,
  onDismissAttention,
  onOpenOrchestration,
  onOpenResult,
  onCleared,
  onTotalChange,
}: Props) {
  const initialFilters = useMemo(() => defaultFilters(), [])
  const [draft, setDraft] = useState<HistoryFilters>(initialFilters)
  const [filters, setFilters] = useState<HistoryFilters>(initialFilters)
  const [page, setPage] = useState(1)
  const [response, setResponse] = useState<TaskHistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [clearing, setClearing] = useState(false)
  const [notice, setNotice] = useState('')
  const loadGeneration = useRef(0)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '50', days: '0' })
      if (filters.q) params.set('q', filters.q)
      if (filters.platform) params.set('platform', filters.platform)
      if (filters.status) params.set('status', filters.status)
      if (filters.from) params.set('from', filters.from)
      if (filters.to) params.set('to', filters.to)
      const result = await api.get<TaskHistoryResponse>(`/capture-cloud/history?${params.toString()}`)
      if (generation !== loadGeneration.current) return
      if (page > result.pagination.totalPages) {
        setPage(result.pagination.totalPages)
        return
      }
      setResponse(result)
      setSelectedIds(current => current.filter(id => result.tasks.some(task => task.id === id)))
      setError('')
      onTotalChange?.(result.pagination.total)
    } catch (err) {
      if (generation !== loadGeneration.current) return
      setError(err instanceof Error ? err.message : '读取任务历史失败')
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [filters, onTotalChange, page])

  /* eslint-disable react-hooks/set-state-in-effect -- fetching remote history intentionally owns loading state */
  useEffect(() => {
    void load()
  }, [load, refreshKey])
  /* eslint-enable react-hooks/set-state-in-effect */

  const applyFilters = () => {
    if (draft.from && draft.to && draft.from > draft.to) {
      setError('开始日期不能晚于结束日期')
      return
    }
    setPage(1)
    setSelectedIds([])
    setFilters({ ...draft, q: draft.q.trim() })
  }

  const resetFilters = () => {
    const next = defaultFilters()
    setDraft(next)
    setFilters(next)
    setPage(1)
    setSelectedIds([])
  }

  const selectPeriod = (period: 'today' | 'yesterday' | 'week' | 'month') => {
    const to = new Date()
    if (period === 'yesterday') to.setDate(to.getDate() - 1)
    const from = new Date(to)
    if (period === 'week') from.setDate(from.getDate() - 6)
    if (period === 'month') from.setDate(from.getDate() - 29)
    const next = { ...draft, q: draft.q.trim(), from: dateKey(from), to: dateKey(to) }
    setDraft(next)
    setFilters(next)
    setPage(1)
    setSelectedIds([])
  }

  const clearSelected = async () => {
    if (!writable || clearing || loading || selectedIds.length === 0) return
    if (!window.confirm(`将选中的 ${selectedIds.length} 条任务移出历史列表？采集内容、运行结果和执行记录都会保留。`)) return
    setClearing(true)
    setError('')
    setNotice('')
    try {
      const result = await api.post<{ clearedCount: number; message?: string }>('/capture-cloud/history/clear', { taskIds: selectedIds })
      setSelectedIds([])
      setNotice(result.message || `已清除 ${result.clearedCount} 条历史记录，采集内容和运行结果已保留。`)
      await load()
      await onCleared?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '清除历史失败，请刷新后重试')
    } finally {
      setClearing(false)
    }
  }

  const pagination = response?.pagination
  const tasks = response?.tasks || []
  const busy = loading || clearing
  const allSelected = tasks.length > 0 && tasks.every(task => selectedIds.includes(task.id))

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold text-foreground">历史结果</h3>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">按完整任务查看运行结果、采集内容和异常。默认近 30 天，最近结束的任务在前。</p>
          </div>
          {pagination && <span className="self-start rounded-md bg-muted px-2 py-1 text-[11px] tabular-nums text-muted-foreground">共 {pagination.total} 条</span>}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="历史日期快捷选择">
          {([['today', '今天'], ['yesterday', '昨天'], ['week', '近 7 天'], ['month', '近 30 天']] as const).map(([period, label]) => (
            <Button key={period} variant="outline" size="sm" disabled={busy} onClick={() => selectPeriod(period)}>{label}</Button>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <label className="relative block min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={draft.q}
              onChange={event => setDraft(current => ({ ...current, q: event.target.value }))}
              onKeyDown={event => { if (event.key === 'Enter') applyFilters() }}
              placeholder="搜索任务名称"
              aria-label="搜索任务名称"
              disabled={clearing}
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs text-foreground outline-none focus:border-primary"
            />
          </label>
          <Button size="sm" onClick={applyFilters} disabled={busy}>查询</Button>
        </div>

        <details className="mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground">
            <SlidersHorizontal className="h-3.5 w-3.5" />平台、状态和日期筛选
            <span className="ml-auto tabular-nums">{filters.from || '不限'} — {filters.to || '不限'}</span>
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <select
            value={draft.platform}
            onChange={event => setDraft(current => ({ ...current, platform: event.target.value }))}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary"
            aria-label="筛选平台"
            disabled={clearing}
          >
            <option value="">全部平台</option>
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
            <option value="weibo">微博</option>
            <option value="mixed">多平台</option>
          </select>
          <select
            value={draft.status}
            onChange={event => setDraft(current => ({ ...current, status: event.target.value }))}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary"
            aria-label="筛选任务状态"
            disabled={clearing}
          >
            <option value="">全部状态</option>
            <option value="completed">已完成</option>
            <option value="completed_with_warnings">完成有警告</option>
            <option value="completed_with_failures">部分失败</option>
            <option value="failed">失败</option>
            <option value="canceled">已取消</option>
            <option value="skipped">已跳过</option>
          </select>
          <label className="relative block">
            <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="date"
              value={draft.from}
              onChange={event => setDraft(current => ({ ...current, from: event.target.value }))}
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs text-foreground outline-none focus:border-primary"
              aria-label="历史开始日期"
              disabled={clearing}
            />
          </label>
          <label className="relative block">
            <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="date"
              value={draft.to}
              onChange={event => setDraft(current => ({ ...current, to: event.target.value }))}
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs text-foreground outline-none focus:border-primary"
              aria-label="历史结束日期"
              disabled={clearing}
            />
          </label>
          <div className="flex gap-2 sm:col-span-2 sm:justify-end">
            <Button variant="outline" size="sm" onClick={applyFilters} disabled={busy}>应用筛选</Button>
            <Button variant="ghost" size="sm" onClick={resetFilters} disabled={busy}>重置</Button>
          </div>
          </div>
        </details>
      </section>

      {notice && <div role="status" className="rounded-xl border border-status-green/25 bg-status-green/8 px-4 py-3 text-xs text-status-green">{notice}</div>}

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-xs text-status-red">
          <span>{error}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>重试</Button>
        </div>
      )}

      {loading && !response ? (
        <div className="flex min-h-56 items-center justify-center rounded-2xl border border-border/70 bg-card">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-12 text-center">
          <History className="mx-auto h-7 w-7 text-muted-foreground" />
          <div className="mt-3 text-sm font-semibold">当前条件下没有历史记录</div>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">筛选栏会继续保留；可扩大日期范围、清空条件后重新查询。</p>
        </div>
      ) : (
        <div className={`space-y-3 transition-opacity ${busy ? 'opacity-55' : ''}`} aria-busy={busy}>
          {writable && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-card px-3 py-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={allSelected} disabled={busy}
                  onChange={event => setSelectedIds(event.target.checked ? tasks.map(task => task.id) : [])} />
                全选本页{selectedIds.length > 0 && ` · 已选 ${selectedIds.length} 条`}
              </label>
              <Button variant="outline" size="sm" disabled={busy || selectedIds.length === 0} onClick={() => void clearSelected()}>
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}清除所选
              </Button>
            </div>
          )}
          {tasks.map(task => (
            <div key={task.id} className="relative">
              {writable && (
                <label className="mb-1.5 inline-flex cursor-pointer items-center gap-2 pl-1 text-xs text-muted-foreground">
                  <input type="checkbox" className="h-4 w-4 accent-primary" aria-label={`选择 ${task.title || '任务'}`}
                    checked={selectedIds.includes(task.id)} disabled={busy}
                    onChange={event => setSelectedIds(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id))} />
                  选择此任务
                </label>
              )}
            <TaskCard
              task={task}
              history
              surface={surface}
              writable={writable}
              actionTaskId={actionTaskId}
              onResume={onResume}
              onRetryOnIdleAgent={onRetryOnIdleAgent}
              onStop={onStop}
              onDismissAttention={onDismissAttention}
              onOpenOrchestration={onOpenOrchestration}
              onOpenResult={onOpenResult}
            />
            </div>
          ))}
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <nav className="flex items-center justify-between rounded-xl border border-border/70 bg-card px-3 py-2" aria-label="历史分页">
          <span className="text-[11px] text-muted-foreground">第 {pagination.page}/{pagination.totalPages} 页 · 每页 {pagination.pageSize} 条</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy || pagination.page <= 1} onClick={() => { setSelectedIds([]); setPage(current => Math.max(1, current - 1)) }}>
              <ChevronLeft className="h-3.5 w-3.5" />上一页
            </Button>
            <Button variant="outline" size="sm" disabled={busy || pagination.page >= pagination.totalPages} onClick={() => { setSelectedIds([]); setPage(current => current + 1) }}>
              下一页<ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </nav>
      )}
    </div>
  )
}
