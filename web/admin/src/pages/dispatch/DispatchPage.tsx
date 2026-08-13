import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, CheckCircle2, ClipboardList,
  ListChecks, Loader2, Plus, RefreshCw,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useNav } from '@/lib/navigation'
import { Button } from '@/components/ui/button'
import {
  OrchestrationComposerDrawer,
  OrchestrationDetailWorkspace,
} from './cloud-tasks'
import { AgentRail } from './cloud-tasks/AgentRail'
import { CreateTaskDrawer } from './cloud-tasks/CreateTaskDrawer'
import { PlansView } from './cloud-tasks/PlansView'
import { HistoryView } from './cloud-tasks/HistoryView'
import { TaskCard } from './cloud-tasks/TaskCard'
import type {
  CloudAgent,
  CloudTask,
  ComposerIntent,
  Overview,
  TaskView,
} from './cloud-tasks/lib'
import type { OrchestrationDetailResponse, OrchestrationLaunchIntent } from './cloud-tasks/types'
import {
  ACTIVE_TASK_STATUSES,
  canDismissAttention,
  hasConfiguredUnattendedPlan,
  isPendingUnattendedPlanDeleteTask,
  isAttentionTask,
  isBusinessVisibleTask,
} from './cloud-tasks/lib'

// 计划模板（多 Agent 无人值守编排）是「计划」视图的对象，从执行中/需处理/历史三桶中剔除，
// 计划运行批次（orchestrationScheduleRun）不是模板，仍按普通任务留在原视图。
function isScheduleTemplateTask(task: CloudTask) {
  return task.task_type === 'capture_orchestration' && task.metadata?.orchestrationTemplate === true
}

export function DispatchPage() {
  const { canWrite } = useAuth()
  const { params } = useNav()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionTaskId, setActionTaskId] = useState('')
  const [planActionAgentId, setPlanActionAgentId] = useState('')
  const [templateActionId, setTemplateActionId] = useState('')
  const [agentActionId, setAgentActionId] = useState('')
  const [taskView, setTaskView] = useState<TaskView>(
    () => params?.view === 'attention' ? 'attention' : 'active',
  )
  const [composerIntent, setComposerIntent] = useState<ComposerIntent | null>(
    () => params?.create === 'comment_patrol'
      ? {
          taskType: 'comment_patrol',
          officialAccountId: String(params?.officialAccountId || '') || undefined,
        }
      : params?.create === 'creator_patrol'
        ? { taskType: 'creator_patrol', subscriptionId: String(params?.subscriptionId || '') || undefined }
        : params?.create === 'negative_patrol'
          ? {
              taskType: 'negative_patrol',
              recordIds: String(params?.recordIds || '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 100),
            }
        : params?.create === 'watched_content'
          ? {
              taskType: 'watched_content',
              recordIds: String(params?.recordIds || '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 100),
            }
        : null,
  )
  const [orchestrationLaunchIntent, setOrchestrationLaunchIntent] = useState<OrchestrationLaunchIntent | null>(null)
  const [editingOrchestrationPlan, setEditingOrchestrationPlan] = useState<OrchestrationDetailResponse | null>(null)
  const [copyingOrchestrationPlan, setCopyingOrchestrationPlan] = useState<OrchestrationDetailResponse | null>(null)
  const [selectedOrchestrationId, setSelectedOrchestrationId] = useState<string | null>(
    () => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      String(params?.orchestrationId || ''),
    )
      ? String(params?.orchestrationId)
      : null,
  )
  const [orchestrationRefreshKey, setOrchestrationRefreshKey] = useState(0)
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)
  const [historyTotal, setHistoryTotal] = useState<number | null>(null)
  const loadGeneration = useRef(0)
  const orchestrationDetailDialogRef = useRef<HTMLDivElement | null>(null)

  const closeOrchestrationComposer = useCallback(() => {
    setOrchestrationLaunchIntent(null)
  }, [])

  const closeOrchestrationDetail = useCallback(() => {
    setSelectedOrchestrationId(null)
  }, [])

  const load = useCallback(async (quiet = false) => {
    const generation = ++loadGeneration.current
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await api.get<Overview & { ok: boolean }>('/capture-cloud/overview')
      if (generation !== loadGeneration.current) return
      setOverview({ agents: data.agents || [], tasks: data.tasks || [], summary: data.summary })
      setError('')
    } catch (err) {
      if (generation !== loadGeneration.current) return
      setError(err instanceof Error ? err.message : '读取云端任务中心失败')
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => void load(true), 15_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [load])

  useEffect(() => {
    if (!selectedOrchestrationId) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTimer = window.setTimeout(() => {
      const initialFocus = orchestrationDetailDialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      if (initialFocus) initialFocus.focus()
      else orchestrationDetailDialogRef.current?.focus()
    }, 0)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeOrchestrationDetail()
        return
      }
      if (event.key !== 'Tab' || !orchestrationDetailDialogRef.current) return
      const focusable = Array.from(orchestrationDetailDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        orchestrationDetailDialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [closeOrchestrationDetail, selectedOrchestrationId])

  const businessTasks = useMemo(
    () => (overview?.tasks || []).filter(isBusinessVisibleTask),
    [overview?.tasks],
  )
  // The server already omits migrated/revoked Agents. Keep the same boundary
  // in the client so a stale response can never surface them in a picker or
  // preset task flow while a lifecycle action is refreshing the page.
  const operationalAgents = useMemo(
    () => (overview?.agents || []).filter(agent =>
      agent.status === 'active' || agent.status === 'paused'),
    [overview?.agents],
  )

  // 模板任务进入「计划」视图；其余任务进入执行中/需处理/历史三桶。
  const scheduleTemplates = useMemo(
    () => businessTasks.filter(isScheduleTemplateTask),
    [businessTasks],
  )
  const queueTasks = useMemo(
    () => businessTasks.filter(task => !isScheduleTemplateTask(task)),
    [businessTasks],
  )

  const visibleTasks = useMemo(() => {
    return queueTasks.filter(task => {
      const status = task.effective_status || task.status
      if (taskView === 'active') return ACTIVE_TASK_STATUSES.has(status)
      if (taskView === 'attention') return isAttentionTask(task)
      return false
    }).sort((left, right) => {
      const leftTime = new Date(left.created_at || left.updated_at || left.finished_at || 0).getTime()
      const rightTime = new Date(right.created_at || right.updated_at || right.finished_at || 0).getTime()
      return rightTime - leftTime
    })
  }, [queueTasks, taskView])

  const taskCounts = useMemo(() => {
    const counts = { active: 0, attention: 0, history: 0 }
    for (const task of queueTasks) {
      const status = task.effective_status || task.status
      if (ACTIVE_TASK_STATUSES.has(status)) counts.active += 1
      else if (isAttentionTask(task)) counts.attention += 1
      else counts.history += 1
    }
    counts.history = historyTotal ?? Number(overview?.summary.historyTasks || counts.history)
    return counts
  }, [historyTotal, overview?.summary.historyTasks, queueTasks])

  const configuredPlanAgentCount = useMemo(
    () => operationalAgents.filter(agent => hasConfiguredUnattendedPlan(agent.unattended_plan)).length,
    [operationalAgents],
  )
  const plansCount = scheduleTemplates.length + configuredPlanAgentCount
  const pendingPlanDeleteAgentIds = useMemo(() => new Set(
    (overview?.tasks || [])
      .filter(isPendingUnattendedPlanDeleteTask)
      .map(task => task.assigned_agent_id || task.origin_agent_id || '')
      .filter(Boolean),
  ), [overview?.tasks])

  const dismissibleAttentionCount = useMemo(
    () => queueTasks.filter(canDismissAttention).length,
    [queueTasks],
  )

  const resume = async (task: CloudTask) => {
    setActionTaskId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>('/capture-cloud/tasks/' + task.id + '/resume', { mode: 'remaining' })
      setFeedback(result.message || '已向原 Agent 发送继续剩余任务指令')
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '发送继续指令失败')
    } finally {
      setActionTaskId('')
    }
  }

  const retryOnIdleAgent = async (task: CloudTask) => {
    if (!window.confirm(
      `确定把“${task.title || '当前任务'}”的未完成项转交给其它在线空闲设备吗？` +
      ' 已完成结果会保留，重试结果仍汇总在这条原任务里。',
    )) return
    setActionTaskId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{
        itemCount?: number
        targetAgentName?: string
        message?: string
      }>(`/capture-cloud/tasks/${task.id}/retry-on-idle-agent`, {
        requestKey: window.crypto.randomUUID(),
        expectedRevision: Number(task.orchestration_revision || 0),
      })
      setFeedback(
        result.message ||
        `${result.itemCount || 0} 个未完成项已转交${result.targetAgentName || '空闲设备'}重试`,
      )
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '换空闲设备重试失败')
    } finally {
      setActionTaskId('')
    }
  }

  const stop = async (task: CloudTask) => {
    if (!window.confirm(`确定结束“${task.title || '当前任务'}”吗？后续关键词将不再执行，已经采集和保存的结果会保留。`)) return
    setActionTaskId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>('/capture-cloud/tasks/' + task.id + '/stop', {})
      setFeedback(result.message || '已发送停止指令')
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '发送停止指令失败')
    } finally {
      setActionTaskId('')
    }
  }

  const dismissAttention = async (task: CloudTask) => {
    if (!window.confirm(`将“${task.title || '当前任务'}”移到历史吗？任务记录和采集结果都会保留。`)) return
    setActionTaskId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>('/capture-cloud/tasks/' + task.id + '/dismiss-attention', {})
      setFeedback(result.message || '已移到历史')
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '移到历史失败')
    } finally {
      setActionTaskId('')
    }
  }

  const dismissTerminalAttention = async () => {
    if (dismissibleAttentionCount <= 0) return
    if (!window.confirm('将当前账号下所有已结束的失败任务移到历史吗？中断和仍需处理的任务不会被清理。')) return
    setActionTaskId('bulk-dismiss-attention')
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ dismissedCount?: number; message?: string }>('/capture-cloud/tasks/dismiss-terminal-attention', {})
      setFeedback(result.message || `已将 ${result.dismissedCount || 0} 个任务移到历史`)
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '清理已结束失败项失败')
    } finally {
      setActionTaskId('')
    }
  }

  const deleteUnattendedPlan = async (agent: CloudAgent) => {
    const name = agent.display_name || '当前 Agent'
    if (!window.confirm(
      `确定删除“${name}”的无人值守计划吗？设备收到指令后会停止该计划及其正在执行的本地任务；历史任务和已采集结果会保留。`,
    )) return

    setPlanActionAgentId(agent.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.delete<{ message?: string }>(
        `/capture-cloud/agents/${agent.id}/unattended-plan`,
      )
      setFeedback(result.message || '删除计划指令已下发')
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '删除无人值守计划失败')
    } finally {
      setPlanActionAgentId('')
    }
  }

  const archiveTemplate = async (task: CloudTask) => {
    if (!window.confirm(
      `确定删除计划“${task.title || '未命名计划'}”吗？计划会进入归档并停止后续排期；正在执行的批次、历史任务和采集结果都会保留。`,
    )) return
    setTemplateActionId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/orchestrations/${task.id}/schedule/archive`,
        {},
      )
      setFeedback(result.message || '计划已移入归档')
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '归档计划失败')
    } finally {
      setTemplateActionId('')
    }
  }

  const restoreTemplate = async (task: CloudTask) => {
    setTemplateActionId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/orchestrations/${task.id}/schedule/restore`,
        {},
      )
      setFeedback(result.message || '计划已恢复为暂停状态')
      await load(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '恢复计划失败')
    } finally {
      setTemplateActionId('')
    }
  }

  const copyTemplate = async (task: CloudTask) => {
    setTemplateActionId(task.id)
    setFeedback('')
    setActionError('')
    try {
      const detail = await api.get<OrchestrationDetailResponse>(`/capture-cloud/orchestrations/${task.id}`)
      setCopyingOrchestrationPlan(detail)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '读取计划配置失败')
    } finally {
      setTemplateActionId('')
    }
  }

  const deleteAgent = async (agent: CloudAgent) => {
    setAgentActionId(agent.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.delete<{ message?: string }>(
        `/capture-cloud/agents/${agent.id}`,
      )
      setFeedback(result.message || `节点“${agent.display_name}”已删除；历史任务和采集结果已保留。`)
      await load(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除节点失败'
      setActionError(message)
      throw err
    } finally {
      setAgentActionId('')
    }
  }

  const detachAgent = async (agent: CloudAgent) => {
    setAgentActionId(agent.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/agents/${agent.id}/retire`,
        { confirmation: '移出当前租户', reason: 'tenant_migrated' },
      )
      setFeedback(result.message || `节点“${agent.display_name}”已移出当前租户；历史记录已保留，切回本租户重新验证后可恢复。`)
      await load(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : '移出当前租户失败'
      setActionError(message)
      throw err
    } finally {
      setAgentActionId('')
    }
  }

  const retireAgent = async (agent: CloudAgent) => {
    setAgentActionId(agent.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/agents/${agent.id}/retire`,
        { confirmation: '永久停用', reason: 'permanently_offline' },
      )
      setFeedback(result.message || `节点“${agent.display_name}”已永久停用；历史记录已保留。`)
      await load(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : '永久停用节点失败'
      setActionError(message)
      throw err
    } finally {
      setAgentActionId('')
    }
  }

  if (loading && !overview) {
    return <div className="flex justify-center py-24"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
  }

  return (
    <div className="space-y-5 xl:h-full">
      {error && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">{error}</div>}
      {actionError && <div role="alert" className="rounded-xl border border-status-red/25 bg-status-red/8 px-4 py-3 text-sm text-status-red">{actionError}</div>}
      {feedback && <div role="status" aria-live="polite" className="rounded-xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-primary">{feedback}</div>}

      <div className="grid items-stretch gap-5 xl:h-full xl:min-h-[36rem] xl:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)] xl:gap-0 xl:overflow-hidden">
        <section className="flex min-h-0 min-w-0 flex-col xl:py-5 xl:pr-5">
          <div className="mb-3 shrink-0 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><ListChecks className="h-4 w-4 text-primary" /><h3 className="text-base font-bold">任务队列</h3></div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{taskView === 'plans' ? '集中管理多 Agent 编排模板与各设备的无人值守计划' : '按创建时间倒序，新任务在最前'}</p>
                {Number(overview?.summary.aiConcurrencyLimit || 0) > 0 && (
                  <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
                    AI 处理中 {Number(overview?.summary.aiActive || 0)}/{Number(overview?.summary.aiConcurrencyLimit || 0)}
                    {' · '}排队 {Number(overview?.summary.aiQueued || 0)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => { void load(true); if (taskView === 'history') setHistoryRefreshKey(value => value + 1) }} disabled={refreshing} className="min-h-10">
                  <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> 刷新
                </Button>
              <Button size="sm" onClick={() => setComposerIntent({})} disabled={!canWrite()} className="min-h-10 px-4" aria-label="新建任务">
                <Plus className="h-4 w-4" /> 新建任务
              </Button>
            </div>
            </div>
            <div className="mobile-table-scroll inline-flex max-w-full overflow-x-auto rounded-xl border border-border bg-card p-1" role="tablist" aria-label="任务分组">
              {([
                { value: 'active' as const, label: '执行中', count: taskCounts.active },
                { value: 'attention' as const, label: '需处理', count: taskCounts.attention },
                { value: 'plans' as const, label: '计划', count: plansCount },
                { value: 'history' as const, label: '历史', count: taskCounts.history },
              ]).map(item => (
                <button key={item.value} type="button" role="tab" aria-selected={taskView === item.value} onClick={() => setTaskView(item.value)}
                  className={`min-h-9 shrink-0 rounded-lg px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${taskView === item.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                  {item.label} <span className="ml-1 tabular-nums opacity-80">{item.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="workspace-scrollbar min-h-0 flex-1 xl:overflow-y-auto xl:overscroll-contain xl:pb-4 xl:pr-2">
            {taskView === 'plans' ? (
              <PlansView
                templates={scheduleTemplates}
                agents={operationalAgents}
                writable={canWrite()}
                onOpenOrchestration={task => setSelectedOrchestrationId(task.id)}
                onEditPlan={agent => setComposerIntent({ agentId: agent.id, mode: 'unattended_plan', editExisting: true })}
                onDeletePlan={agent => void deleteUnattendedPlan(agent)}
                onArchiveTemplate={task => void archiveTemplate(task)}
                onRestoreTemplate={task => void restoreTemplate(task)}
                onCopyTemplate={task => void copyTemplate(task)}
                templateActionId={templateActionId}
                deletingAgentId={planActionAgentId}
                pendingDeleteAgentIds={pendingPlanDeleteAgentIds}
              />
            ) : taskView === 'history' ? (
              <HistoryView
                writable={canWrite()}
                actionTaskId={actionTaskId}
                refreshKey={historyRefreshKey}
                onResume={resume}
                onRetryOnIdleAgent={retryOnIdleAgent}
                onStop={stop}
                onDismissAttention={dismissAttention}
                onOpenOrchestration={task => setSelectedOrchestrationId(task.id)}
                onTotalChange={setHistoryTotal}
              />
            ) : (
              <>
                {taskView === 'attention' && dismissibleAttentionCount > 0 && (
                  <div className="mb-3 flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/35 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs leading-5 text-muted-foreground">失败和部分失败已经结束，可移到历史；中断和需要人工处理的任务会继续保留。</p>
                    <Button variant="outline" size="sm" onClick={() => void dismissTerminalAttention()} disabled={!canWrite() || actionTaskId === 'bulk-dismiss-attention'} className="shrink-0">
                      {actionTaskId === 'bulk-dismiss-attention' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                      清理已结束失败项
                    </Button>
                  </div>
                )}

                {visibleTasks.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-12 text-center xl:flex xl:h-full xl:min-h-[22rem] xl:flex-col xl:justify-center">
                    {taskView === 'attention' ? <CheckCircle2 className="mx-auto h-7 w-7 text-status-green" /> : <ClipboardList className="mx-auto h-7 w-7 text-primary" />}
                    <div className="mt-3 text-sm font-semibold">{taskView === 'active' ? '当前没有执行中或排队中的任务' : taskView === 'attention' ? '当前没有需要人工处理的任务' : '最近任务中还没有历史记录'}</div>
                    <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{taskView === 'active' ? '新建任务后分配给 Agent；Agent 离线时任务会保留在云端队列，上线后自动领取。' : taskView === 'attention' ? '中断、失败和部分失败会集中出现在这里。' : '已完成、已停止和已跳过的任务会进入历史。'}</p>
                    {taskView === 'active' && canWrite() && (
                      <div className="mt-4 flex justify-center">
                        <Button size="sm" onClick={() => setComposerIntent({})}><Plus className="h-4 w-4" /> 新建任务</Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {visibleTasks.map(task => (
                      <TaskCard key={task.id} task={task} writable={canWrite()} actionTaskId={actionTaskId} onResume={resume} onStop={stop}
                        onRetryOnIdleAgent={retryOnIdleAgent}
                        onDismissAttention={dismissAttention}
                        onOpenOrchestration={selected => setSelectedOrchestrationId(selected.id)} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <aside className="flex min-h-0 min-w-0 flex-col xl:border-l xl:border-border/70 xl:py-5 xl:pl-5">
          <AgentRail
            agents={operationalAgents}
            tasks={overview?.tasks || []}
            writable={canWrite()}
            onAssign={agent => setComposerIntent({ agentId: agent.id })}
            onEditPlan={agent => setComposerIntent({ agentId: agent.id, mode: 'unattended_plan', editExisting: true })}
            onCreatePlan={agent => setComposerIntent({ agentId: agent.id, mode: 'unattended_plan' })}
            onDeletePlan={agent => void deleteUnattendedPlan(agent)}
            onDeleteAgent={deleteAgent}
            onDetachAgent={detachAgent}
            onRetireAgent={retireAgent}
            deletingPlanAgentId={planActionAgentId}
            deletingAgentId={agentActionId}
            detachingAgentId={agentActionId}
            retiringAgentId={agentActionId}
            onSaved={() => load(true)}
          />
        </aside>
      </div>

      {composerIntent && (
        <CreateTaskDrawer agents={operationalAgents} tasks={businessTasks} writable={canWrite()} intent={composerIntent}
          onClose={() => setComposerIntent(null)}
          onLaunchOrchestration={launchIntent => {
            setComposerIntent(null)
            setOrchestrationLaunchIntent(launchIntent)
          }}
          onCreated={async createdTaskType => {
            setFeedback(createdTaskType === 'watched_content'
              ? '关注内容巡查已创建，内容将按平台由兼容 Agent 领取。'
              : createdTaskType === 'negative_patrol'
                ? '负面帖子巡查已创建，内容将按平台由兼容 Agent 领取。'
                : '任务已创建并分配给指定 Agent。')
            await load(true)
          }} />
      )}

      {orchestrationLaunchIntent && (
        <OrchestrationComposerDrawer
          open
          writable={canWrite()}
          agents={operationalAgents}
          initialExecutionMode={orchestrationLaunchIntent.executionMode}
          lockExecutionMode={orchestrationLaunchIntent.lockExecutionMode}
          minimumAgentCount={orchestrationLaunchIntent.minimumAgentCount}
          initialAgentIds={orchestrationLaunchIntent.agentIds}
          onClose={closeOrchestrationComposer}
          onChanged={async () => {
            setOrchestrationRefreshKey(value => value + 1)
            await load(true)
          }}
          onDispatched={async result => {
            setFeedback(result.schedule
              ? '多 Agent 无人值守计划已启用，将按云端时间生成每轮任务。'
              : `多 Agent 任务已拆分为 ${result.executions.length} 条执行指令。`)
            setOrchestrationRefreshKey(value => value + 1)
            await load(true)
          }}
        />
      )}

      {editingOrchestrationPlan && (
        <OrchestrationComposerDrawer
          open
          writable={canWrite()}
          agents={operationalAgents}
          initialExecutionMode="unattended_plan"
          lockExecutionMode
          editingPlan={editingOrchestrationPlan}
          onClose={() => {
            const orchestrationId = editingOrchestrationPlan.orchestration.id
            setEditingOrchestrationPlan(null)
            setSelectedOrchestrationId(orchestrationId)
          }}
          onPlanUpdated={async result => {
            setFeedback(result.message || '无人值守计划已保存，修改从下一次运行开始生效。')
            setOrchestrationRefreshKey(value => value + 1)
            await load(true)
          }}
        />
      )}

      {copyingOrchestrationPlan && (
        <OrchestrationComposerDrawer
          open
          writable={canWrite()}
          agents={operationalAgents}
          initialExecutionMode="unattended_plan"
          lockExecutionMode
          copyingPlan={copyingOrchestrationPlan}
          onClose={() => setCopyingOrchestrationPlan(null)}
          onChanged={async () => {
            setOrchestrationRefreshKey(value => value + 1)
            await load(true)
          }}
          onDispatched={async result => {
            setFeedback(result.schedule
              ? '已从归档配置创建独立的新计划。'
              : '已从归档配置创建新任务。')
            setOrchestrationRefreshKey(value => value + 1)
            await load(true)
          }}
        />
      )}

      {selectedOrchestrationId && (
        <div ref={orchestrationDetailDialogRef}
          className="fixed inset-0 z-[60] overflow-y-auto bg-black/35 p-0 outline-none sm:p-4 lg:p-8"
          role="dialog" aria-modal="true" aria-labelledby="orchestration-detail-title" tabIndex={-1}
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeOrchestrationDetail()
          }}>
          <div className="mx-auto max-w-6xl">
            <OrchestrationDetailWorkspace
              orchestrationId={selectedOrchestrationId}
              refreshKey={orchestrationRefreshKey}
              writable={canWrite()}
              availableAgents={operationalAgents}
              onClose={closeOrchestrationDetail}
              onEditPlan={plan => {
                setEditingOrchestrationPlan(plan)
                setSelectedOrchestrationId(null)
              }}
              onChanged={async () => {
                setOrchestrationRefreshKey(value => value + 1)
                await load(true)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
