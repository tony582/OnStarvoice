import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Bot, CalendarClock, ChevronRight, CircleOff, Laptop, Pencil, Plus, Wifi, WifiOff, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentEditor } from './AgentEditor'
import { UnattendedPlanSummary } from './UnattendedPlanSummary'
import type { CloudAgent, CloudTask } from './lib'
import {
  ACTIVE_TASK_STATUSES,
  PLATFORM_LABELS,
  agentAssignmentBlockReason,
  agentCreatePlatforms,
  formatTime,
  hasConfiguredUnattendedPlan,
  safeNumber,
  taskBelongsToAgent,
} from './lib'

// 设备上报的负载优先（active/queued 计数），缺省时回退到本地可见任务里属于该 Agent 的活动任务数。
function agentWorkload(agent: CloudAgent, tasks: CloudTask[]) {
  const workloadKnown = agent.active_task_count !== undefined || agent.queued_task_count !== undefined
  if (workloadKnown) {
    return {
      activeTaskCount: safeNumber(agent.active_task_count),
      queuedTaskCount: safeNumber(agent.queued_task_count),
    }
  }
  const relatedActiveTasks = tasks.filter(
    task => taskBelongsToAgent(task, agent) && ACTIVE_TASK_STATUSES.has(task.effective_status || task.status),
  )
  return { activeTaskCount: relatedActiveTasks.length, queuedTaskCount: 0 }
}

function AgentRow({
  agent,
  tasks,
  withBorder,
  onOpen,
}: {
  agent: CloudAgent
  tasks: CloudTask[]
  withBorder: boolean
  onOpen: () => void
}) {
  const { activeTaskCount, queuedTaskCount } = agentWorkload(agent, tasks)
  const platforms = agentCreatePlatforms(agent)
  const hasPlan = hasConfiguredUnattendedPlan(agent.unattended_plan)
  const dotClass = agent.status === 'paused' ? 'bg-status-orange' : agent.online ? 'bg-status-green' : 'bg-muted-foreground/40'

  return (
    <button type="button" onClick={onOpen}
      className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${withBorder ? 'border-t border-border/60' : ''}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">{agent.display_name}</span>
          {hasPlan && <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="已配置无人值守计划" />}
          {agent.last_error && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-red" aria-label="Agent 异常" />}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {platforms.length > 0
            ? platforms.map(platform => (
                <span key={platform} className="rounded bg-primary/8 px-1.5 py-0.5 text-[10px] font-medium text-primary">{PLATFORM_LABELS[platform] || platform}</span>
              ))
            : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">无平台</span>}
          <span className="text-[11px] text-muted-foreground">执行中 {activeTaskCount} / 排队 {queuedTaskCount}</span>
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function AgentDetailDrawer({
  agent,
  tasks,
  writable,
  onAssign,
  onEditPlan,
  onSaved,
  onClose,
}: {
  agent: CloudAgent
  tasks: CloudTask[]
  writable: boolean
  onAssign: (agent: CloudAgent) => void
  onEditPlan: (agent: CloudAgent) => void
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const { activeTaskCount, queuedTaskCount } = agentWorkload(agent, tasks)
  const platforms = agentCreatePlatforms(agent)
  const blockReason = agentAssignmentBlockReason(agent, 'one_time')
  const hasPlan = hasConfiguredUnattendedPlan(agent.unattended_plan)
  const remoteUnattendedPlanWrite = agent.capabilities?.remoteUnattendedPlanWrite === true
  const statusLabel = agent.status === 'paused' ? '已暂停' : agent.online ? '在线' : '离线'

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/35" onMouseDown={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby="agent-detail-title"
        className="relative z-10 flex h-full w-full max-w-md flex-col bg-card shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200 lg:border-l lg:border-border">
        <header className="shrink-0 border-b border-border/70 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-5">
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}><Bot className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="agent-detail-title" className="truncate text-lg font-bold text-foreground">{agent.display_name}</h2>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${agent.status === 'paused' ? 'bg-status-orange/10 text-amber-700 dark:text-amber-300' : agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
                  {agent.status === 'paused' ? <CircleOff className="h-3 w-3" /> : agent.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                  {statusLabel}
                </span>
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{agent.host_label} › {agent.browser_name} · {agent.operating_system} · v{agent.app_version || '未知'}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="关闭 Agent 详情"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          <div className="flex flex-wrap gap-1.5">
            {platforms.length > 0
              ? platforms.map(platform => (
                  <span key={platform} className="rounded-md bg-primary/8 px-2 py-1 text-[10px] font-medium text-primary">{PLATFORM_LABELS[platform] || platform}</span>
                ))
              : <span className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">无可用平台</span>}
          </div>
          <div className="mt-3 grid gap-x-3 gap-y-1.5 text-[11px] leading-4 text-muted-foreground sm:grid-cols-2">
            <div>状态：<span className="text-foreground">{statusLabel}</span></div>
            <div>最后心跳：<span className="text-foreground">{formatTime(agent.last_heartbeat_at)}</span></div>
            <div>标识：<span className="text-foreground">{agent.client_uuid.slice(0, 8)}</span></div>
            <div>负载：<span className="text-foreground">执行中 {activeTaskCount} / 排队 {queuedTaskCount}</span></div>
          </div>
          {agent.last_error && <div role="alert" className="mt-3 rounded-lg bg-status-red/8 px-2.5 py-2 text-[11px] leading-4 text-status-red">Agent 异常：{agent.last_error}</div>}
          {blockReason && <p className="mt-2 text-[11px] leading-4 text-status-red">{blockReason}</p>}
          <UnattendedPlanSummary plan={agent.unattended_plan} mirroredAt={agent.unattended_plan_updated_at} />
          {writable && (
            <div className="mt-3">
              <AgentEditor key={`${agent.id}:${agent.display_name}:${agent.host_label}:${agent.status}:${(agent.allowed_platforms || []).join(',')}`} agent={agent} onSaved={onSaved} />
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-border bg-card px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5">
          <div className="grid gap-2">
            <Button size="sm" onClick={() => { onAssign(agent); onClose() }} disabled={!writable || Boolean(blockReason)} className="min-h-10 w-full">
              <Plus className="h-4 w-4" /> 分配任务
            </Button>
            {hasPlan && (
              <Button variant="outline" size="sm" onClick={() => { onEditPlan(agent); onClose() }} disabled={!writable || !remoteUnattendedPlanWrite} className="min-h-10 w-full">
                <Pencil className="h-3.5 w-3.5" /> 编辑计划
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

export function AgentRail({
  agents,
  tasks,
  writable,
  onAssign,
  onEditPlan,
  onSaved,
}: {
  agents: CloudAgent[]
  tasks: CloudTask[]
  writable: boolean
  onAssign: (agent: CloudAgent) => void
  onEditPlan: (agent: CloudAgent) => void
  onSaved: () => Promise<void>
}) {
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)

  const groupedAgents = useMemo(() => {
    const groups = new Map<string, CloudAgent[]>()
    for (const agent of agents) {
      const key = agent.host_label || agent.operating_system || '未命名设备'
      groups.set(key, [...(groups.get(key) || []), agent])
    }
    return Array.from(groups.entries())
  }, [agents])

  // 轮询刷新会替换 agents 数组；用 id 定位保证抽屉在刷新后仍指向最新的同一 Agent，Agent 消失时自动关闭。
  const activeAgent = activeAgentId ? agents.find(agent => agent.id === activeAgentId) ?? null : null

  return (
    <div>
      {groupedAgents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center">
          <CircleOff className="mx-auto h-7 w-7 text-muted-foreground" />
          <div className="mt-3 text-sm font-semibold">还没有 Agent（浏览器节点）</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">客户端扩展重新验证激活码后，会自动注册到这里。</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedAgents.map(([hostLabel, hostAgents]) => (
            <section key={hostLabel} aria-label={hostLabel}>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <Laptop className="h-4 w-4 text-primary" />
                <h4 className="min-w-0 truncate text-sm font-bold">{hostLabel}</h4>
                <span className="shrink-0 text-[11px] text-muted-foreground">{hostAgents.length} 个 Agent</span>
              </div>
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs">
                {hostAgents.map((agent, index) => (
                  <AgentRow key={agent.id} agent={agent} tasks={tasks} withBorder={index > 0} onOpen={() => setActiveAgentId(agent.id)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {activeAgent && (
        <AgentDetailDrawer
          agent={activeAgent}
          tasks={tasks}
          writable={writable}
          onAssign={onAssign}
          onEditPlan={onEditPlan}
          onSaved={onSaved}
          onClose={() => setActiveAgentId(null)}
        />
      )}
    </div>
  )
}
