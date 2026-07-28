import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, CheckCircle2, ClipboardList,
  History, ListChecks, Loader2, Plus, RefreshCw,
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
import { TaskCard } from './cloud-tasks/TaskCard'
import type {
  CloudAgent,
  CloudTask,
  ComposerIntent,
  Overview,
  TaskView,
} from './cloud-tasks/lib'
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
        : null,
  )
  const [orchestrationComposerOpen, setOrchestrationComposerOpen] = useState(false)
  const [orchestrationInitialAgentIds, setOrchestrationInitialAgentIds] = useState<string[]>([])
  const [selectedOrchestrationId, setSelectedOrchestrationId] = useState<string | null>(
    () => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      String(params?.orchestrationId || ''),
    )
      ? String(params?.orchestrationId)
      : null,
  )
  const [orchestrationRefreshKey, setOrchestrationRefreshKey] = useState(0)
  const loadGeneration = useRef(0)
  const orchestrationDetailDialogRef = useRef<HTMLDivElement | null>(null)

  const closeOrchestrationComposer = useCallback(() => {
    setOrchestrationComposerOpen(false)
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
      if (taskView === 'history') return !ACTIVE_TASK_STATUSES.has(status) && !isAttentionTask(task)
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
    return counts
  }, [queueTasks])

  const configuredPlanAgentCount = useMemo(
    () => (overview?.agents || []).filter(agent => hasConfiguredUnattendedPlan(agent.unattended_plan)).length,
    [overview?.agents],
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

  const retireAgent = async (
    agent: CloudAgent,
    reason: 'tenant_migrated' | 'permanently_offline',
  ) => {
    setAgentActionId(agent.id)
    setFeedback('')
    setActionError('')
    try {
      const result = await api.post<{ message?: string }>(
        `/capture-cloud/agents/${agent.id}/retire`,
        { confirmation: '永久归档', reason },
      )
      setFeedback(result.message || `节点“${agent.display_name}”已永久归档；历史记录已保留。`)
      await load(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : '永久归档节点失败'
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
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing} className="min-h-10">
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
                agents={overview?.agents || []}
                writable={canWrite()}
                onOpenOrchestration={task => setSelectedOrchestrationId(task.id)}
                onEditPlan={agent => setComposerIntent({ agentId: agent.id, mode: 'unattended_plan', editExisting: true })}
                onDeletePlan={agent => void deleteUnattendedPlan(agent)}
                deletingAgentId={planActionAgentId}
                pendingDeleteAgentIds={pendingPlanDeleteAgentIds}
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
                    {taskView === 'attention' ? <CheckCircle2 className="mx-auto h-7 w-7 text-status-green" /> : taskView === 'history' ? <History className="mx-auto h-7 w-7 text-muted-foreground" /> : <ClipboardList className="mx-auto h-7 w-7 text-primary" />}
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
            agents={overview?.agents || []}
            tasks={overview?.tasks || []}
            writable={canWrite()}
            onAssign={agent => setComposerIntent({ agentId: agent.id })}
            onEditPlan={agent => setComposerIntent({ agentId: agent.id, mode: 'unattended_plan', editExisting: true })}
            onCreatePlan={agent => setComposerIntent({ agentId: agent.id, mode: 'unattended_plan' })}
            onDeletePlan={agent => void deleteUnattendedPlan(agent)}
            onDeleteAgent={deleteAgent}
            onRetireAgent={retireAgent}
            deletingPlanAgentId={planActionAgentId}
            deletingAgentId={agentActionId}
            retiringAgentId={agentActionId}
            onSaved={() => load(true)}
          />
        </aside>
      </div>

      {composerIntent && (
        <CreateTaskDrawer agents={overview?.agents || []} tasks={businessTasks} writable={canWrite()} intent={composerIntent}
          onClose={() => setComposerIntent(null)}
          onLaunchOrchestration={agentIds => {
            setComposerIntent(null)
            setOrchestrationInitialAgentIds(agentIds)
            setOrchestrationComposerOpen(true)
          }}
          onCreated={async () => {
            setFeedback('任务已创建并分配给指定 Agent。')
            await load(true)
          }} />
      )}

      <OrchestrationComposerDrawer
        open={orchestrationComposerOpen}
        writable={canWrite()}
        agents={overview?.agents || []}
        initialAgentIds={orchestrationInitialAgentIds}
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
              availableAgents={overview?.agents || []}
              onClose={closeOrchestrationDetail}
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
