import { useMemo } from 'react'
import { CheckCircle2, CircleOff } from 'lucide-react'
import type { CloudAgent, CloudTask } from './lib'
import {
  ACTIVE_TASK_STATUSES,
  PLATFORM_LABELS,
  agentAssignmentBlockReason,
  agentCreatePlatforms,
  safeNumber,
  taskBelongsToAgent,
} from './lib'

// 共用的执行节点选择列表：新建任务向导按单选/多选复用。
// 行内展示状态点、名称、设备、负责平台与负载；不可选（暂停/能力缺失/无可用平台）时禁用并注明原因。
export function AgentPicker({
  agents,
  tasks,
  mode,
  multiple = false,
  selectedIds,
  onChange,
}: {
  agents: CloudAgent[]
  tasks: CloudTask[]
  mode: 'one_time' | 'unattended_plan'
  multiple?: boolean
  selectedIds: string[]
  onChange: (ids: string[]) => void
}) {
  const sortedAgents = useMemo(() => [...agents].sort((left, right) => {
    const leftBlocked = Boolean(agentAssignmentBlockReason(left, mode))
    const rightBlocked = Boolean(agentAssignmentBlockReason(right, mode))
    if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1
    if (left.online !== right.online) return left.online ? -1 : 1
    return `${left.host_label}${left.display_name}`.localeCompare(`${right.host_label}${right.display_name}`, 'zh-CN')
  }), [agents, mode])

  const toggle = (agentId: string) => {
    if (multiple) {
      onChange(selectedIds.includes(agentId)
        ? selectedIds.filter(id => id !== agentId)
        : [...selectedIds, agentId])
      return
    }
    onChange([agentId])
  }

  if (sortedAgents.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center">
        <CircleOff className="mx-auto h-7 w-7 text-muted-foreground" />
        <div className="mt-3 text-sm font-semibold">还没有可分配的 Agent</div>
        <p className="mt-1 text-xs text-muted-foreground">让客户端扩展重新验证激活码后，再回来分配任务。</p>
      </div>
    )
  }

  return (
    <div className="space-y-2" role={multiple ? 'group' : 'radiogroup'} aria-label="选择执行节点">
      {sortedAgents.map(agent => {
        const blockReason = agentAssignmentBlockReason(agent, mode)
        const selected = selectedIds.includes(agent.id)
        const platforms = agentCreatePlatforms(agent)
        const agentTasks = tasks.filter(task => taskBelongsToAgent(task, agent) && ACTIVE_TASK_STATUSES.has(task.effective_status || task.status))
        const workloadKnown = agent.active_task_count !== undefined || agent.queued_task_count !== undefined
        const activeTaskCount = workloadKnown ? safeNumber(agent.active_task_count) : agentTasks.length
        const queuedTaskCount = workloadKnown ? safeNumber(agent.queued_task_count) : 0
        const dotClass = agent.status === 'paused' ? 'bg-status-orange' : agent.online ? 'bg-status-green' : 'bg-muted-foreground/40'
        return (
          <button key={agent.id} type="button" role={multiple ? 'checkbox' : 'radio'} aria-checked={selected} disabled={Boolean(blockReason)}
            onClick={() => toggle(agent.id)}
            className={`flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/20' : 'border-border bg-background hover:border-primary/35'}`}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="truncate text-sm font-semibold text-foreground">{agent.display_name}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">执行中 {activeTaskCount}{queuedTaskCount > 0 ? ` · 排队 ${queuedTaskCount}` : ''}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{agent.host_label} · {agent.browser_name}</span>
              <span className="mt-1 flex flex-wrap items-center gap-1">
                {platforms.length > 0
                  ? platforms.map(platform => (
                      <span key={platform} className="rounded bg-primary/8 px-1.5 py-0.5 text-[10px] font-medium text-primary">{PLATFORM_LABELS[platform] || platform}</span>
                    ))
                  : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">无可用平台</span>}
              </span>
              {blockReason
                ? <span className="mt-1 block text-[11px] font-medium text-status-red">{blockReason}</span>
                : !agent.online && <span className="mt-1 block text-[11px] font-medium text-amber-700 dark:text-amber-300">Agent 离线；分配后会排队，上线即执行</span>}
            </span>
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}>
              {selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary-foreground" />}
            </span>
          </button>
        )
      })}
    </div>
  )
}
