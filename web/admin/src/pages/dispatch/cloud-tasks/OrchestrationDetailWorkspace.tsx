import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Loader2,
  Lock,
  Pause,
  Play,
  RefreshCw,
  Square,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  OrchestrationAttemptRecord,
  OrchestrationCloudAgent,
  OrchestrationDetailResponse,
  OrchestrationDetailWorkspaceProps,
  OrchestrationExecutionRecord,
  OrchestrationItemRecord,
} from './types'
// 平台/状态文案与时间格式化统一以 lib.ts 为准，避免两处定义漂移。
import { PLATFORM_LABELS, STATUS_LABELS, formatTime } from './lib'

const SORT_LABELS: Record<string, string> = {
  comprehensive: '综合排序',
  latest: '最新发布',
  likes: '最多点赞',
}

const PUBLISH_TIME_LABELS: Record<string, string> = {
  all: '不限时间',
  day: '一天内',
  week: '一周内',
  halfyear: '半年内',
}

const SUCCESS_ITEM_STATUSES = new Set(['completed', 'completed_with_warnings'])
const SETTLED_ITEM_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'])
const FAILURE_STATUSES = new Set(['retryable', 'needs_action', 'failed', 'interrupted', 'completed_with_failures'])
const ACTIVE_STATUSES = new Set(['pending', 'assigned', 'dispatch_pending', 'dispatched', 'waiting_device', 'claimed', 'running', 'recovering'])
const STOPPABLE_EXECUTION_STATUSES = new Set([
  'pending', 'claimed', 'running', 'recovering', 'interrupted',
  'resume_requested', 'needs_action', 'failed', 'completed_with_failures',
])

const COMMAND_STATUS_LABELS: Record<string, string> = {
  pending: '等待 Agent 领取',
  claimed: 'Agent 已领取',
  completed: '指令已完成',
  failed: '指令失败',
  canceled: '指令已取消',
  expired: '指令已过期',
  superseded: '指令已替换',
}

const SCHEDULE_STATUS_LABELS: Record<string, string> = {
  active: '计划已启用',
  paused: '计划已暂停',
  completed: '计划已结束',
  canceled: '计划已取消',
}

function statusLabel(status?: string) {
  return STATUS_LABELS[String(status || '')] || String(status || '未记录')
}

function statusTone(status?: string) {
  const value = String(status || '')
  if (FAILURE_STATUSES.has(value)) return 'border-status-red/25 bg-status-red/8 text-status-red'
  if (['completed', 'completed_with_warnings'].includes(value)) return 'border-status-green/25 bg-status-green/8 text-status-green'
  if (ACTIVE_STATUSES.has(value)) return 'border-primary/25 bg-primary/8 text-primary'
  return 'border-border bg-muted text-muted-foreground'
}

function keywordForItem(item: OrchestrationItemRecord) {
  if (item.keyword?.trim()) return item.keyword.trim()
  const metadataKeyword = item.metadata?.keyword
  return typeof metadataKeyword === 'string' && metadataKeyword.trim()
    ? metadataKeyword.trim()
    : item.item_key
}

function executionAgentId(execution: OrchestrationExecutionRecord) {
  return String(execution.agentId || execution.agent_id || execution.assigned_agent_id || '')
}

function executionTaskId(execution: OrchestrationExecutionRecord) {
  return String(execution.taskId || execution.task_id || execution.id || '')
}

function executionItemIds(execution: OrchestrationExecutionRecord) {
  const ids = execution.itemIds || execution.item_ids
  return Array.isArray(ids) ? ids.map(String) : []
}

function executionOnline(execution: OrchestrationExecutionRecord) {
  return execution.agentOnline ?? execution.agent_online
}

function attemptItemId(attempt: OrchestrationAttemptRecord) {
  return String(attempt.itemId || attempt.item_id || '')
}

function itemAssignedAgentId(
  item: OrchestrationItemRecord,
  executions: OrchestrationExecutionRecord[],
  attempts: OrchestrationAttemptRecord[],
) {
  if (item.assigned_agent_id) return item.assigned_agent_id
  const execution = executions.find(candidate => executionItemIds(candidate).includes(item.id))
  if (execution) return executionAgentId(execution)
  const latestAttempt = [...attempts]
    .filter(candidate => attemptItemId(candidate) === item.id)
    .sort((left, right) => Number(right.attempt_number || 0) - Number(left.attempt_number || 0))[0]
  return String(latestAttempt?.agentId || latestAttempt?.agent_id || '')
}

function agentName(agent?: OrchestrationCloudAgent) {
  if (!agent) return '未记录 Agent'
  return agent.display_name || `${agent.host_label || '未命名设备'} · ${agent.browser_name || '浏览器'}`
}

function dataMessage(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return String(record.message || record.reason || record.code || '').trim()
}

export function OrchestrationDetailWorkspace({
  orchestrationId,
  writable = false,
  onClose,
  onChanged,
  className,
  refreshKey,
}: OrchestrationDetailWorkspaceProps) {
  const [detail, setDetail] = useState<OrchestrationDetailResponse | null>(null)
  const [loading, setLoading] = useState(Boolean(orchestrationId))
  const [refreshing, setRefreshing] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [scheduleUpdating, setScheduleUpdating] = useState(false)
  const [actionFeedback, setActionFeedback] = useState('')
  const [actionError, setActionError] = useState('')
  const [error, setError] = useState('')
  const loadGeneration = useRef(0)

  const load = useCallback(async (quiet = false, showRefreshIndicator = true) => {
    if (!orchestrationId) return
    const generation = ++loadGeneration.current
    if (!quiet) setLoading(true)
    else if (showRefreshIndicator) setRefreshing(true)
    try {
      const result = await api.get<OrchestrationDetailResponse>(`/capture-cloud/orchestrations/${orchestrationId}`)
      if (generation !== loadGeneration.current) return
      setDetail(result)
      setError('')
    } catch (err) {
      if (generation !== loadGeneration.current) return
      setError(err instanceof Error ? err.message : '读取编排任务详情失败')
    } finally {
      if (generation === loadGeneration.current) {
        if (!quiet) setLoading(false)
        if (showRefreshIndicator) setRefreshing(false)
      }
    }
  }, [orchestrationId])

  /* eslint-disable react-hooks/set-state-in-effect -- an id change intentionally replaces the displayed remote record */
  useEffect(() => {
    setDetail(null)
    setError('')
    setActionFeedback('')
    setActionError('')
    if (!orchestrationId) {
      setLoading(false)
      return
    }
    void load()
  }, [load, orchestrationId, refreshKey])
  /* eslint-enable react-hooks/set-state-in-effect */

  const sortedItems = useMemo(
    () => [...(detail?.items || [])].sort((left, right) => {
      const ordinalDiff = Number(left.ordinal || 0) - Number(right.ordinal || 0)
      if (ordinalDiff !== 0) return ordinalDiff
      return String(left.created_at || '').localeCompare(String(right.created_at || ''))
    }),
    [detail?.items],
  )
  const agentsById = useMemo(
    () => new Map((detail?.agents || []).map(agent => [agent.id, agent])),
    [detail?.agents],
  )
  const attemptsByItem = useMemo(() => {
    const result = new Map<string, OrchestrationAttemptRecord[]>()
    for (const attempt of detail?.attempts || []) {
      const itemId = attemptItemId(attempt)
      if (!itemId) continue
      result.set(itemId, [...(result.get(itemId) || []), attempt])
    }
    return result
  }, [detail?.attempts])
  const completedCount = sortedItems.filter(item => SUCCESS_ITEM_STATUSES.has(item.status)).length
  const settledCount = sortedItems.filter(item => SETTLED_ITEM_STATUSES.has(item.status)).length
  const failedCount = sortedItems.filter(item => FAILURE_STATUSES.has(item.status)).length
  const activeCount = sortedItems.filter(item => ACTIVE_STATUSES.has(item.status)).length
  const progressPercent = sortedItems.length > 0 ? Math.round((settledCount / sortedItems.length) * 100) : 0
  const isScheduleTemplate =
    detail?.orchestration.metadata?.orchestrationTemplate === true
  const stoppableTaskIds = useMemo(
    () => Array.from(new Set((detail?.executions || [])
      .filter(execution => STOPPABLE_EXECUTION_STATUSES.has(String(execution.status || '')))
      .map(executionTaskId)
      .filter(Boolean))),
    [detail?.executions],
  )
  const hasActiveWork = Boolean(detail && !isScheduleTemplate && (
    ACTIVE_STATUSES.has(String(detail.orchestration.status || '')) ||
    activeCount > 0
  ))

  useEffect(() => {
    if (!orchestrationId || !hasActiveWork) return
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load(true, false)
    }
    const timer = window.setInterval(refreshWhenVisible, 15_000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [hasActiveWork, load, orchestrationId])

  const stopAllExecutions = async () => {
    if (!writable || stopping || stoppableTaskIds.length === 0) return
    if (!window.confirm(`确定停止这个编排任务的 ${stoppableTaskIds.length} 条执行任务吗？已采集结果会保留。`)) return
    setStopping(true)
    setActionFeedback('')
    setActionError('')
    try {
      const results = await Promise.allSettled(
        stoppableTaskIds.map(taskId => api.post(`/capture-cloud/tasks/${taskId}/stop`, {})),
      )
      const succeeded = results.filter(result => result.status === 'fulfilled').length
      const failed = results.length - succeeded
      if (failed > 0) {
        setActionError(`已向 ${succeeded} 条子任务发送停止指令，另有 ${failed} 条未能停止；请刷新后检查。`)
      } else {
        setActionFeedback(`已向 ${succeeded} 条子任务发送停止指令；离线 Agent 上线后执行。`)
      }
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '停止编排子任务失败')
    } finally {
      setStopping(false)
    }
  }

  const updateScheduleStatus = async () => {
    if (!detail?.schedule || !isScheduleTemplate || !writable || scheduleUpdating) return
    const action = detail.schedule.status === 'active' ? 'pause' : 'resume'
    const prompt = action === 'pause'
      ? '暂停这个无人值守计划吗？已经生成并正在运行的任务不会被停止，但不会再生成下一轮。'
      : '重新启用这个无人值守计划吗？云端会从下一个有效时间开始运行，不会补跑暂停期间错过的时间。'
    if (!window.confirm(prompt)) return
    setScheduleUpdating(true)
    setActionFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/orchestrations/${orchestrationId}/schedule/${action}`,
        {},
      )
      setActionFeedback(result.message || (action === 'pause' ? '计划已暂停' : '计划已重新启用'))
      await load(true)
      await onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '更新无人值守计划失败')
    } finally {
      setScheduleUpdating(false)
    }
  }

  if (!orchestrationId) {
    return (
      <section className={cn('rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-12 text-center', className)}>
        <ClipboardList className="mx-auto h-7 w-7 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold text-foreground">选择一个编排任务</h3>
        <p className="mt-1 text-xs text-muted-foreground">这里会显示任务、工作项和真实 Agent 执行记录。</p>
      </section>
    )
  }

  if (loading && !detail) {
    return (
      <section className={cn('flex min-h-96 items-center justify-center rounded-2xl border border-border bg-card', className)}>
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="正在读取编排任务" />
      </section>
    )
  }

  if (!detail) {
    return (
      <section className={cn('rounded-2xl border border-status-red/25 bg-status-red/5 p-5', className)}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-red" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-foreground">无法读取编排任务</h3>
            <p role="alert" className="mt-1 text-xs leading-5 text-status-red">{error || '任务不存在或当前账号无权查看。'}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}><RefreshCw className="h-4 w-4" /> 重试</Button>
          </div>
        </div>
      </section>
    )
  }

  const { orchestration, executions, agents, attempts, schedule } = detail
  const metadata = orchestration.metadata || {}
  const scheduleTemplate = metadata.orchestrationTemplate === true
  const scheduleRun = metadata.orchestrationScheduleRun === true
  const planSnapshot = metadata.planSnapshot && typeof metadata.planSnapshot === 'object'
    ? metadata.planSnapshot as Record<string, unknown>
    : {}
  const keywordLimit = Number(planSnapshot.keywordMaxDetectedItems)
  const searchFilters = planSnapshot.searchFilters && typeof planSnapshot.searchFilters === 'object'
    ? planSnapshot.searchFilters as Record<string, unknown>
    : null
  const captureSettings = planSnapshot.captureSettings && typeof planSnapshot.captureSettings === 'object'
    ? planSnapshot.captureSettings as Record<string, unknown>
    : null

  return (
    <section className={cn('overflow-hidden rounded-[22px] border border-border/70 bg-card shadow-sm', className)}>
      <header className="border-b border-border/70 px-4 py-4 sm:px-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${scheduleTemplate && schedule?.status === 'active' ? 'border-status-green/25 bg-status-green/8 text-status-green' : statusTone(orchestration.status)}`}>
                {scheduleTemplate && schedule
                  ? SCHEDULE_STATUS_LABELS[schedule.status] || schedule.status
                  : statusLabel(orchestration.status)}
              </span>
              <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">{PLATFORM_LABELS[orchestration.platform] || orchestration.platform}</span>
              <span className="text-[11px] text-muted-foreground">
                {scheduleTemplate
                  ? '多 Agent 无人值守计划'
                  : scheduleRun
                    ? '无人值守计划运行批次'
                    : '一次性多 Agent 任务'}
              </span>
            </div>
            <h2 id="orchestration-detail-title" className="mt-2.5 truncate text-lg font-bold text-foreground">{orchestration.title || '未命名编排任务'}</h2>
            <p className="mt-1 text-xs text-muted-foreground">创建于 {formatTime(orchestration.created_at)} · 版本 {orchestration.revision ?? orchestration.orchestration_revision ?? '—'}</p>
          </div>
          {scheduleTemplate && schedule && ['active', 'paused'].includes(schedule.status) ? (
            <Button
              variant={schedule.status === 'active' ? 'outline' : 'default'}
              size="sm"
              onClick={() => void updateScheduleStatus()}
              disabled={!writable || scheduleUpdating}
              title={!writable ? '当前账号为只读权限' : schedule.status === 'active' ? '暂停后不再生成新任务' : '从下一个有效时间重新运行'}
            >
              {scheduleUpdating
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : schedule.status === 'active'
                  ? <Pause className="h-4 w-4" />
                  : <Play className="h-4 w-4" />}
              {schedule.status === 'active' ? '暂停计划' : '重新启用'}
            </Button>
          ) : (
            <Button variant="destructive" size="sm" onClick={() => void stopAllExecutions()}
              disabled={!writable || stopping || stoppableTaskIds.length === 0}
              title={!writable ? '当前账号为只读权限' : stoppableTaskIds.length === 0 ? '当前没有可停止的子任务' : '停止所有仍可控制的 Agent 子任务'}>
              {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
              停止全部
            </Button>
          )}
          <Button variant="outline" size="icon" onClick={() => void load(true)} disabled={refreshing} aria-label="刷新编排任务详情">
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭编排任务详情" data-dialog-initial-focus><X className="h-5 w-5" /></Button>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-status-red">{error}</p>}
        {actionError && <p role="alert" className="mt-3 text-xs text-status-red">{actionError}</p>}
        {actionFeedback && <p role="status" aria-live="polite" className="mt-3 text-xs text-status-green">{actionFeedback}</p>}
      </header>

      <div className="p-4 sm:p-5">
        {scheduleTemplate && schedule && (
          <section className="mb-4 rounded-2xl border border-primary/20 bg-primary/[0.035] p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <CalendarDays className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <h3 className="text-sm font-bold text-foreground">云端运行计划</h3>
                  <span className="text-[11px] text-muted-foreground">
                    {schedule.schedule_mode === 'custom_dates' ? '指定日期' : '每天'} {String(schedule.start_time || '09:00').slice(0, 5)}
                    {Number(schedule.random_offset_min || 0) > 0 ? ` · 随机延迟 0–${Number(schedule.random_offset_min)} 分钟` : ''}
                  </span>
                </div>
                <div className="mt-2 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                  <div>下次运行：<strong className="font-semibold text-foreground">{formatTime(schedule.next_run_at)}</strong></div>
                  <div>已生成：<strong className="font-semibold text-foreground">{Number(schedule.run_count || 0)} 轮</strong></div>
                  <div>上轮状态：<strong className="font-semibold text-foreground">{schedule.last_run_status ? statusLabel(schedule.last_run_status) : '尚未运行'}</strong></div>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">每个计划时间，每个关键词执行 1 次。计划只保存在云端，不会覆盖任一 Extension 的本地无人值守计划。</p>
              </div>
            </div>
          </section>
        )}
        <ol className="mb-4 flex items-center gap-2 overflow-x-auto pb-1" aria-label="编排任务结构">
          <li className="flex min-w-36 items-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.045] px-3 py-2">
            <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
            <span><span className="block text-[10px] text-muted-foreground">{scheduleTemplate ? '计划模板' : '父任务'}</span><span className="block text-xs font-bold">{sortedItems.length} 个工作项</span></span>
          </li>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/45" />
          <li className="flex min-w-36 items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
            <Activity className="h-4 w-4 shrink-0 text-primary" />
            <span>
              <span className="block text-[10px] text-muted-foreground">{scheduleTemplate ? '固定分配' : '工作项状态'}</span>
              <span className="block text-xs font-bold">{scheduleTemplate ? `${sortedItems.length} 个关键词已分配` : `${settledCount} 已结算 · ${activeCount} 进行/等待`}</span>
            </span>
          </li>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/45" />
          <li className="flex min-w-36 items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
            <Users className="h-4 w-4 shrink-0 text-primary" />
            <span><span className="block text-[10px] text-muted-foreground">Agent 小队</span><span className="block text-xs font-bold">{agents.length} 个执行节点</span></span>
          </li>
        </ol>

        <section className="rounded-2xl border border-border/70 bg-background p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Task</div>
              <h3 className="mt-1 text-sm font-bold text-foreground">{scheduleTemplate ? '计划分配' : '父任务进度'}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {scheduleTemplate
                  ? '这里展示后续每轮都会沿用的关键词和 Agent 分配。'
                  : '只按服务端返回的工作项状态统计，不推测 Extension 当前页面步骤。'}
              </p>
            </div>
            {!scheduleTemplate && <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-md bg-status-green/10 px-2 py-1 font-medium text-status-green">成功 {completedCount}</span>
              <span className="rounded-md bg-primary/8 px-2 py-1 font-medium text-primary">进行/等待 {activeCount}</span>
              {failedCount > 0 && <span className="rounded-md bg-status-red/8 px-2 py-1 font-medium text-status-red">异常 {failedCount}</span>}
            </div>}
          </div>
          {!scheduleTemplate && <div className="mt-4 flex items-center gap-3">
            <div
              className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="编排任务已结算进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
              aria-valuetext={`${settledCount} / ${sortedItems.length} 个工作项已结算`}
            >
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progressPercent}%` }} />
            </div>
            <span className="shrink-0 text-xs font-bold tabular-nums text-foreground">{settledCount}/{sortedItems.length}</span>
          </div>}
          {(Number.isFinite(keywordLimit) || searchFilters || captureSettings) && (
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
              {Number.isFinite(keywordLimit) && keywordLimit > 0 && <span>每词上限 <strong className="font-semibold text-foreground">{keywordLimit} 条</strong></span>}
              {searchFilters && <span>筛选 <strong className="font-semibold text-foreground">{SORT_LABELS[String(searchFilters.sort || '')] || String(searchFilters.sort || '默认')} · {PUBLISH_TIME_LABELS[String(searchFilters.publishTime || '')] || String(searchFilters.publishTime || '不限')}</strong></span>}
              {captureSettings && <span>采集增强 <strong className="font-semibold text-foreground">{captureSettings.autoDetailCaptureAfterListCapture === true ? '已开启' : '未开启'}</strong></span>}
            </div>
          )}
        </section>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
          <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Work items</div>
                <h3 className="mt-0.5 text-sm font-bold text-foreground">关键词工作项</h3>
              </div>
              <span className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{sortedItems.length} 项</span>
            </div>
            {sortedItems.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-muted-foreground">服务端尚未返回工作项。</div>
            ) : (
              <div className="divide-y divide-border/70">
                {sortedItems.map((item, index) => {
                  const assignedAgentId = itemAssignedAgentId(item, executions, attempts)
                  const assignedAgent = agentsById.get(assignedAgentId)
                  const itemAttempts = attemptsByItem.get(item.id) || []
                  const errorMessage = dataMessage(item.error)
                  return (
                    <article key={item.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-start">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-xs font-bold tabular-nums text-muted-foreground">
                        {Number.isFinite(Number(item.ordinal)) ? Number(item.ordinal) + 1 : index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="truncate text-sm font-semibold text-foreground">{keywordForItem(item)}</h4>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span>Agent：<strong className="font-medium text-foreground">{agentName(assignedAgent)}</strong></span>
                          {itemAttempts.length > 0 && <span>尝试记录：{itemAttempts.length}</span>}
                          <span>更新：{formatTime(item.updated_at)}</span>
                        </div>
                        {errorMessage && <p className="mt-1.5 text-[11px] leading-4 text-status-red">{errorMessage}</p>}
                      </div>
                      <span className="hidden text-[10px] font-mono text-muted-foreground sm:block">{item.id.slice(0, 8)}</span>
                    </article>
                  )
                })}
              </div>
            )}
          </section>

          <section className="self-start overflow-hidden rounded-2xl border border-border/70 bg-card">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Agent team</div>
                <h3 className="mt-0.5 text-sm font-bold text-foreground">执行节点与子任务</h3>
              </div>
              <Bot className="h-4 w-4 text-primary" />
            </div>
            {agents.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-muted-foreground">服务端尚未返回分配节点。</div>
            ) : (
              <div className="divide-y divide-border/70">
                {agents.map(agent => {
                  const agentExecutions = executions.filter(execution => executionAgentId(execution) === agent.id)
                  const assignedItems = sortedItems.filter(item => itemAssignedAgentId(item, executions, attempts) === agent.id)
                  return (
                    <article key={agent.id} className="p-4">
                      <div className="flex items-start gap-3">
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}><Bot className="h-4 w-4" /></span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <h4 className="truncate text-xs font-bold text-foreground">{agentName(agent)}</h4>
                            <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
                              {agent.online ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
                              {agent.online ? '在线' : '离线'}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-[11px] text-muted-foreground">{agent.host_label} › {agent.browser_name} · {agent.operating_system}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">分配 {assignedItems.length} 个工作项 · {agentExecutions.length} 条子任务记录</p>
                        </div>
                      </div>
                      {agentExecutions.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {agentExecutions.map((execution, index) => (
                            <div key={executionTaskId(execution) || index} className="rounded-lg border border-border/70 bg-muted/25 px-2.5 py-2">
                              {(() => {
                                const executionItems = sortedItems.filter(item => item.execution_task_id === executionTaskId(execution))
                                const itemCount = executionItemIds(execution).length || executionItems.length || (execution.keywords || []).length
                                return <>
                              <div className="flex items-center justify-between gap-2">
                                <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold ${statusTone(String(execution.status || ''))}`}>{statusLabel(String(execution.status || ''))}</span>
                                <span className="text-[10px] text-muted-foreground">{itemCount} 个工作项</span>
                              </div>
                              <div className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground">{executionTaskId(execution) || '未返回子任务 ID'}</div>
                              {(execution.command_status || execution.command_expires_at) && (
                                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                                  指令：<span className="font-medium text-foreground">
                                    {COMMAND_STATUS_LABELS[String(execution.command_status || '')] || String(execution.command_status || '状态未记录')}
                                  </span>
                                  {execution.command_expires_at ? ` · 有效至 ${formatTime(execution.command_expires_at)}` : ''}
                                </p>
                              )}
                              {executionOnline(execution) === false && <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">节点离线；子任务保持服务端返回的当前状态。</p>}
                              {execution.message && <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{execution.message}</p>}
                                </>
                              })()}
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
            <div className="border-t border-border/70 bg-muted/25 p-3">
              <Button variant="outline" size="sm" className="w-full" disabled title="当前版本尚未开放跨节点接力或重新分配接口">
                <Lock className="h-3.5 w-3.5" /> 重新分配（尚未开放）
              </Button>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">第一期只展示创建时的真实分配和子任务状态；跨 Agent 接力需要新的租约与重分配协议，当前不会伪装执行。</p>
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}
