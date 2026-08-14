import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, History, Loader2, Search, SlidersHorizontal } from 'lucide-react'
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
  onTotalChange,
}: Props) {
  const initialFilters = useMemo(() => defaultFilters(), [])
  const [draft, setDraft] = useState<HistoryFilters>(initialFilters)
  const [filters, setFilters] = useState<HistoryFilters>(initialFilters)
  const [page, setPage] = useState(1)
  const [response, setResponse] = useState<TaskHistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
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
    setFilters({ ...draft, q: draft.q.trim() })
  }

  const resetFilters = () => {
    const next = defaultFilters()
    setDraft(next)
    setFilters(next)
    setPage(1)
  }

  const pagination = response?.pagination
  const tasks = response?.tasks || []

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold text-foreground">历史筛选</h3>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">默认近 30 天，每页 50 条；总数来自独立历史查询，不再受任务概览数量限制。</p>
          </div>
          {pagination && <span className="self-start rounded-md bg-muted px-2 py-1 text-[11px] tabular-nums text-muted-foreground">共 {pagination.total} 条</span>}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="relative block sm:col-span-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={draft.q}
              onChange={event => setDraft(current => ({ ...current, q: event.target.value }))}
              onKeyDown={event => { if (event.key === 'Enter') applyFilters() }}
              placeholder="搜索任务名称"
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs text-foreground outline-none focus:border-primary"
            />
          </label>
          <select
            value={draft.platform}
            onChange={event => setDraft(current => ({ ...current, platform: event.target.value }))}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary"
            aria-label="筛选平台"
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
            />
          </label>
          <div className="flex gap-2 sm:col-span-2 sm:justify-end">
            <Button size="sm" onClick={applyFilters} disabled={loading}>查询</Button>
            <Button variant="ghost" size="sm" onClick={resetFilters} disabled={loading}>重置</Button>
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-xs text-status-red">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>
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
        <div className={`space-y-3 transition-opacity ${loading ? 'opacity-55' : ''}`} aria-busy={loading}>
          {tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              surface={surface}
              writable={writable}
              actionTaskId={actionTaskId}
              onResume={onResume}
              onRetryOnIdleAgent={onRetryOnIdleAgent}
              onStop={onStop}
              onDismissAttention={onDismissAttention}
              onOpenOrchestration={onOpenOrchestration}
            />
          ))}
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <nav className="flex items-center justify-between rounded-xl border border-border/70 bg-card px-3 py-2" aria-label="历史分页">
          <span className="text-[11px] text-muted-foreground">第 {pagination.page}/{pagination.totalPages} 页 · 每页 {pagination.pageSize} 条</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={loading || pagination.page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>
              <ChevronLeft className="h-3.5 w-3.5" />上一页
            </Button>
            <Button variant="outline" size="sm" disabled={loading || pagination.page >= pagination.totalPages} onClick={() => setPage(current => current + 1)}>
              下一页<ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </nav>
      )}
    </div>
  )
}
