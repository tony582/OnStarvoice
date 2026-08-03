import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  AlertTriangle, ArrowLeft, Bot, CalendarClock, CheckCircle2, ChevronRight, CircleOff,
  ChevronDown, ClipboardList, Loader2, LogOut, MoreHorizontal, Pencil, Plus, PowerOff, Save, Trash2,
  Wifi, WifiOff,
} from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { UnattendedPlanSummary } from './UnattendedPlanSummary'
import type { CloudAgent, CloudTask } from './lib'
import {
  ACTIVE_TASK_STATUSES,
  PLATFORM_LABELS,
  STATUS_LABELS,
  agentAssignmentBlockReason,
  agentCreatePlatforms,
  formatTime,
  hasConfiguredUnattendedPlan,
  isPendingUnattendedPlanDeleteTask,
  safeNumber,
  statusTone,
  taskBelongsToAgent,
  taskProgress,
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

function isVisibleAgentTask(task: CloudTask) {
  const type = String(task.task_type || '').toLowerCase()
  return type !== 'unattended_plan_configuration' &&
    type !== 'sync' &&
    !type.endsWith('_sync') &&
    task.status !== 'superseded'
}

function AgentTaskRow({ task }: { task: CloudTask }) {
  const effectiveStatus = task.effective_status || task.status
  const progress = taskProgress(task)

  return (
    <article className="border-t border-border/60 px-3 py-3 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <h5 className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{task.title || '采集任务'}</h5>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTone(effectiveStatus)}`}>
          {STATUS_LABELS[effectiveStatus] || effectiveStatus}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{PLATFORM_LABELS[task.platform] || task.platform || '未识别平台'}</span>
        {progress.total > 0 && <span className="shrink-0 tabular-nums">{progress.current}/{progress.total}</span>}
        <span className="shrink-0">· {formatTime(task.updated_at || task.created_at)}</span>
      </div>
      {task.message && <p className="mt-1 line-clamp-1 text-[11px] leading-4 text-muted-foreground">{task.message}</p>}
    </article>
  )
}

function AgentRow({
  agent,
  tasks,
  withBorder,
  writable,
  onOpen,
  onDelete,
  onDetach,
  onRetire,
}: {
  agent: CloudAgent
  tasks: CloudTask[]
  withBorder: boolean
  writable: boolean
  onOpen: () => void
  onDelete: () => void
  onDetach: () => void
  onRetire: () => void
}) {
  const { activeTaskCount, queuedTaskCount } = agentWorkload(agent, tasks)
  const platforms = agentCreatePlatforms(agent)
  const hasPlan = hasConfiguredUnattendedPlan(agent.unattended_plan)
  const dotClass = agent.status === 'paused' ? 'bg-status-orange' : agent.online ? 'bg-status-green' : 'bg-muted-foreground/40'
  const statusLabel = agent.status === 'paused' ? '已暂停' : agent.online ? '在线' : '离线'

  return (
    <div className={`flex min-w-0 items-stretch transition-colors hover:bg-sidebar-accent/60 ${withBorder ? 'border-t border-border/60' : ''} ${agent.online ? '' : 'opacity-60'}`}>
      <button type="button" onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-foreground">{agent.display_name}</span>
            {hasPlan && <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="已配置无人值守计划" />}
            {agent.last_error && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-red" aria-label="Agent 异常" />}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{statusLabel} · 最近心跳 {formatDate(agent.last_heartbeat_at)}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {platforms.length > 0
              ? platforms.map(platform => (
                  <span key={platform} className="rounded bg-primary/8 px-1.5 py-0.5 text-[10px] font-medium text-primary">{PLATFORM_LABELS[platform] || platform}</span>
                ))
              : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">无平台</span>}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
          <span>执行中 {activeTaskCount} · 排队 {queuedTaskCount}</span>
          <ChevronRight className="h-4 w-4" />
        </span>
      </button>
      {writable && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label={`管理节点 ${agent.display_name}`}
              className="my-auto mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6}
              className="z-[80] min-w-36 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none">
              <DropdownMenu.Item onSelect={onDelete}
                className="flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 text-xs font-medium text-destructive outline-none transition-colors focus:bg-destructive/10 data-[highlighted]:bg-destructive/10">
                <Trash2 className="h-3.5 w-3.5" /> 删除节点
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onDetach} disabled={agent.online}
                className="flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 text-xs font-medium text-foreground outline-none transition-colors focus:bg-muted data-[highlighted]:bg-muted data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45">
                <LogOut className="h-3.5 w-3.5" />
                {agent.online ? '移出当前租户（节点仍在线）' : '移出当前租户'}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onRetire} disabled={agent.online}
                className="flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 text-xs font-medium text-destructive outline-none transition-colors focus:bg-destructive/10 data-[highlighted]:bg-destructive/10 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45">
                <PowerOff className="h-3.5 w-3.5" />
                {agent.online ? '永久停用（节点仍在线）' : '永久停用节点'}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  )
}

function DeleteAgentDialog({
  agent,
  tasks,
  deleting,
  error,
  onOpenChange,
  onConfirm,
}: {
  agent: CloudAgent | null
  tasks: CloudTask[]
  deleting: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const workload = agent ? agentWorkload(agent, tasks) : {activeTaskCount: 0, queuedTaskCount: 0}
  const hasPlan = Boolean(agent && hasConfiguredUnattendedPlan(agent.unattended_plan))
  const knownBlocker = Boolean(
    agent?.online ||
    workload.activeTaskCount > 0 ||
    workload.queuedTaskCount > 0 ||
    hasPlan,
  )

  return (
    <Dialog.Root open={Boolean(agent)} onOpenChange={open => {
      if (!deleting) onOpenChange(open)
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/35 backdrop-blur-[1px] data-[state=closed]:animate-out data-[state=open]:animate-in" />
        <Dialog.Content aria-describedby="delete-agent-description"
          className="fixed left-1/2 top-1/2 z-[91] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-5 shadow-2xl outline-none">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <Trash2 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-base font-bold text-foreground">删除节点？</Dialog.Title>
              <Dialog.Description id="delete-agent-description" className="mt-1 text-xs leading-5 text-muted-foreground">
                删除后，该节点会失去云端访问权限并从调度中心移除。此操作不可直接恢复。
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3">
            <p className="truncate text-sm font-semibold text-foreground">{agent?.display_name || '未命名节点'}</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              历史任务、采集结果和账号用量会保留；激活码的环境名额不会自动释放。
            </p>
          </div>

          {knownBlocker && (
            <div role="alert" className="mt-3 rounded-xl border border-status-orange/25 bg-status-orange/8 px-3.5 py-3 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
              {agent?.online && <p>节点仍在线，请先关闭该浏览器的 Extension，等待约 2 分钟。</p>}
              {(workload.activeTaskCount > 0 || workload.queuedTaskCount > 0) && (
                <p>请先处理现有任务：执行中 {workload.activeTaskCount}，排队 {workload.queuedTaskCount}。</p>
              )}
              {hasPlan && <p>请先删除无人值守计划，并等待设备确认。</p>}
            </div>
          )}
          {error && <p role="alert" className="mt-3 rounded-xl bg-destructive/8 px-3.5 py-2.5 text-[11px] leading-5 text-destructive">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline" size="sm" disabled={deleting}>取消</Button>
            </Dialog.Close>
            <Button variant="destructive" size="sm" onClick={onConfirm} disabled={deleting || knownBlocker}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              确认删除
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DetachAgentDialog({
  agent,
  tasks,
  detaching,
  error,
  onOpenChange,
  onConfirm,
}: {
  agent: CloudAgent | null
  tasks: CloudTask[]
  detaching: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const workload = agent ? agentWorkload(agent, tasks) : {activeTaskCount: 0, queuedTaskCount: 0}
  const hasPlan = Boolean(agent && hasConfiguredUnattendedPlan(agent.unattended_plan))

  const close = (open: boolean) => {
    if (!detaching) onOpenChange(open)
  }

  return (
    <Dialog.Root open={Boolean(agent)} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/35 backdrop-blur-[1px] data-[state=closed]:animate-out data-[state=open]:animate-in" />
        <Dialog.Content aria-describedby="detach-agent-description"
          className="fixed left-1/2 top-1/2 z-[91] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl outline-none">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <LogOut className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-base font-bold text-foreground">移出当前租户</Dialog.Title>
              <Dialog.Description id="detach-agent-description" className="mt-1 text-xs leading-5 text-muted-foreground">
                仅用于浏览器已经切换到其他租户或激活码的旧节点。普通离线和临时关机不要使用。
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 px-3.5 py-3">
            <p className="truncate text-sm font-semibold text-foreground">{agent?.display_name || '未命名节点'}</p>
            <ul className="mt-2 space-y-1 text-[11px] leading-5 text-muted-foreground">
              <li>· 从当前租户的节点列表和新建任务选择中隐藏。</li>
              <li>· 现有等待任务与无人值守计划会终止；历史任务、采集结果、用量和审计记录全部保留。</li>
              <li>· 以后浏览器切回本租户并重新验证激活码，会恢复为可用节点。</li>
            </ul>
          </div>

          {agent?.online && (
            <div role="alert" className="mt-3 rounded-xl border border-status-orange/25 bg-status-orange/8 px-3.5 py-3 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
              该节点目前仍在线，不能移出当前租户。请先在 Extension 中完成租户切换或关闭扩展，并等待约 2 分钟。
            </div>
          )}
          {!agent?.online && (workload.activeTaskCount > 0 || workload.queuedTaskCount > 0 || hasPlan) && (
            <div className="mt-3 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3 text-[11px] leading-5 text-muted-foreground">
              移出时将终止：执行中 {workload.activeTaskCount} 个、排队 {workload.queuedTaskCount} 个
              {hasPlan ? '，以及当前无人值守计划' : ''}。
            </div>
          )}
          {error && <p role="alert" className="mt-3 rounded-xl bg-destructive/8 px-3.5 py-2.5 text-[11px] leading-5 text-destructive">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline" size="sm" disabled={detaching}>取消</Button>
            </Dialog.Close>
            <Button size="sm" onClick={onConfirm} disabled={detaching || Boolean(agent?.online)}>
              {detaching ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
              移出当前租户
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RetireAgentDialog({
  agent,
  tasks,
  retiring,
  error,
  onOpenChange,
  onConfirm,
}: {
  agent: CloudAgent | null
  tasks: CloudTask[]
  retiring: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const workload = agent ? agentWorkload(agent, tasks) : {activeTaskCount: 0, queuedTaskCount: 0}
  const hasPlan = Boolean(agent && hasConfiguredUnattendedPlan(agent.unattended_plan))

  const close = (open: boolean) => {
    if (!retiring) onOpenChange(open)
  }

  return (
    <Dialog.Root open={Boolean(agent)} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/35 backdrop-blur-[1px] data-[state=closed]:animate-out data-[state=open]:animate-in" />
        <Dialog.Content aria-describedby="retire-agent-description"
          className="fixed left-1/2 top-1/2 z-[91] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl outline-none">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <PowerOff className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-base font-bold text-foreground">永久停用节点</Dialog.Title>
              <Dialog.Description id="retire-agent-description" className="mt-1 text-xs leading-5 text-muted-foreground">
                仅用于浏览器或设备已经报废、确认永远不会再使用的节点。换租户、普通离线和临时关机不要使用。
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-destructive/25 bg-destructive/5 px-3.5 py-3">
            <p className="truncate text-sm font-semibold text-foreground">{agent?.display_name || '未命名节点'}</p>
            <ul className="mt-2 space-y-1 text-[11px] leading-5 text-muted-foreground">
              <li>· 立即撤销节点的云端访问凭证，以后重新验证也不能恢复。</li>
              <li>· 结束等待中的指令和任务，停止关联的云端计划并清除本地计划镜像。</li>
              <li>· 解除当前社交账号绑定；历史任务、采集结果、用量和审计记录全部保留。</li>
            </ul>
          </div>

          {agent?.online && (
            <div role="alert" className="mt-3 rounded-xl border border-status-orange/25 bg-status-orange/8 px-3.5 py-3 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
              该节点目前仍在线，系统禁止永久停用。请先关闭该浏览器的 Extension，并等待约 2 分钟。
            </div>
          )}
          {!agent?.online && (workload.activeTaskCount > 0 || workload.queuedTaskCount > 0 || hasPlan) && (
            <div className="mt-3 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-3 text-[11px] leading-5 text-muted-foreground">
              永久停用时将终止：执行中 {workload.activeTaskCount} 个、排队 {workload.queuedTaskCount} 个
              {hasPlan ? '，以及当前无人值守计划' : ''}。
            </div>
          )}

          <label className="mt-4 block text-xs font-semibold text-foreground">
            输入“永久停用”确认
            <input value={confirmation} onChange={event => setConfirmation(event.target.value)}
              disabled={retiring || Boolean(agent?.online)} autoComplete="off"
              className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-destructive disabled:opacity-55" />
          </label>
          {error && <p role="alert" className="mt-3 rounded-xl bg-destructive/8 px-3.5 py-2.5 text-[11px] leading-5 text-destructive">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline" size="sm" disabled={retiring}>取消</Button>
            </Dialog.Close>
            <Button variant="destructive" size="sm" onClick={onConfirm}
              disabled={retiring || Boolean(agent?.online) || confirmation !== '永久停用'}>
              {retiring ? <Loader2 className="h-4 w-4 animate-spin" /> : <PowerOff className="h-4 w-4" />}
              永久停用
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function AgentDetailPane({
  agent,
  tasks,
  writable,
  onAssign,
  onEditPlan,
  onCreatePlan,
  onDeletePlan,
  deletingPlan,
  onSaved,
  onBack,
}: {
  agent: CloudAgent
  tasks: CloudTask[]
  writable: boolean
  onAssign: (agent: CloudAgent) => void
  onEditPlan: (agent: CloudAgent) => void
  onCreatePlan: (agent: CloudAgent) => void
  onDeletePlan: (agent: CloudAgent) => void
  deletingPlan: boolean
  onSaved: () => Promise<void>
  onBack: () => void
}) {
  const { activeTaskCount, queuedTaskCount } = agentWorkload(agent, tasks)
  const blockReason = agentAssignmentBlockReason(agent, 'one_time')
  const hasPlan = hasConfiguredUnattendedPlan(agent.unattended_plan)
  const remoteUnattendedPlanWrite = agent.capabilities?.remoteUnattendedPlanWrite === true
  const remoteUnattendedPlanDelete = agent.capabilities?.remoteUnattendedPlanDelete === true
  const planDeletePending = deletingPlan || tasks.some(task =>
    taskBelongsToAgent(task, agent) && isPendingUnattendedPlanDeleteTask(task),
  )
  const statusLabel = agent.status === 'paused' ? '已暂停' : agent.online ? '在线' : '离线'
  const relatedTasks = tasks
    .filter(task => taskBelongsToAgent(task, agent) && isVisibleAgentTask(task))
    .sort((left, right) => {
      const leftTime = new Date(left.updated_at || left.created_at || 0).getTime()
      const rightTime = new Date(right.updated_at || right.created_at || 0).getTime()
      return rightTime - leftTime
    })
  const activeTasks = relatedTasks.filter(task => ACTIVE_TASK_STATUSES.has(task.effective_status || task.status))
  const historyTasks = relatedTasks.filter(task => !ACTIVE_TASK_STATUSES.has(task.effective_status || task.status))

  // 客户只编辑业务可理解的节点名称与负责平台；技术设备标识保持原值。
  const [displayName, setDisplayName] = useState(agent.display_name)
  const [allowedPlatforms, setAllowedPlatforms] = useState<string[]>(agent.allowed_platforms || [])
  const [profileEditing, setProfileEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedTick, setSavedTick] = useState(false)

  // 轮询刷新会替换 agent 对象；关键字段变化时同步表单初值（等价原 AgentEditor 的 key 重挂载）。
  const agentSignature = `${agent.id}:${agent.display_name}:${agent.host_label}:${agent.status}:${(agent.allowed_platforms || []).join(',')}`
  const [appliedSignature, setAppliedSignature] = useState(agentSignature)
  if (appliedSignature !== agentSignature) {
    setAppliedSignature(agentSignature)
    setDisplayName(agent.display_name)
    setAllowedPlatforms(agent.allowed_platforms || [])
  }

  // 「已保存」inline 提示短暂展示后自动消失。
  useEffect(() => {
    if (!savedTick) return
    const timer = window.setTimeout(() => setSavedTick(false), 2500)
    return () => window.clearTimeout(timer)
  }, [savedTick])

  const togglePlatform = (platform: string) => {
    setAllowedPlatforms(current => current.includes(platform)
      ? current.filter(item => item !== platform)
      : [...current, platform])
  }

  const resetProfileDraft = () => {
    setDisplayName(agent.display_name)
    setAllowedPlatforms(agent.allowed_platforms || [])
    setSaveError('')
  }

  const toggleProfileEditor = () => {
    if (profileEditing) resetProfileDraft()
    setProfileEditing(current => !current)
  }

  const save = async () => {
    setSaving(true)
    setSaveError('')
    setSavedTick(false)
    try {
      await api.patch('/capture-cloud/agents/' + agent.id, {
        displayName, hostLabel: agent.host_label, allowedPlatforms, status: agent.status,
      })
      await onSaved()
      setProfileEditing(false)
      setSavedTick(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/70 pb-3 pr-5">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onBack} aria-label="返回执行节点列表"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="agent-detail-title" className="truncate text-lg font-bold text-foreground">{agent.display_name}</h2>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${agent.status === 'paused' ? 'bg-status-orange/10 text-amber-700 dark:text-amber-300' : agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
                {agent.status === 'paused' ? <CircleOff className="h-3 w-3" /> : agent.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {statusLabel}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">最近心跳 {formatDate(agent.last_heartbeat_at)} · 执行中 {activeTaskCount} · 排队 {queuedTaskCount}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {savedTick && !profileEditing && (
              <span className="hidden items-center gap-1 text-[11px] font-medium text-status-green sm:inline-flex" aria-live="polite">
                <CheckCircle2 className="h-3.5 w-3.5" /> 已保存
              </span>
            )}
            <Button variant="outline" size="sm" onClick={toggleProfileEditor} disabled={!writable} className="min-h-9">
              <Pencil className="h-3.5 w-3.5" /> {profileEditing ? '取消编辑' : '编辑节点'}
            </Button>
          </div>
        </div>
      </header>

      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain py-4 pr-5">
        {agent.last_error && <div role="alert" className="mt-3 rounded-lg bg-status-red/8 px-2.5 py-2 text-[11px] leading-4 text-status-red">Agent 异常：{agent.last_error}</div>}
        {blockReason && <p className="mt-2 text-[11px] leading-4 text-status-red">{blockReason}</p>}

        {/* 节点资料是低频设置，只在用户点击右上角“编辑节点”后展开。 */}
        {profileEditing && (
          <section className={`${agent.last_error || blockReason ? 'mt-3 ' : ''}rounded-xl border border-border/70 bg-card p-3.5 shadow-xs`} aria-label="编辑节点资料">
            <h3 className="text-xs font-bold text-foreground">编辑节点资料</h3>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">设置客户可识别的名称，以及这个 Agent 负责的平台。</p>
            <div className="mt-3 space-y-3">
              <label className="block text-xs font-medium text-muted-foreground">
                节点名称
                <input value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={!writable}
                  className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-55" />
              </label>
              <fieldset>
                <legend className="text-xs font-medium text-muted-foreground">负责平台</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {['xiaohongshu', 'douyin', 'weibo'].map(platform => (
                    <label key={platform} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs">
                      <input type="checkbox" checked={allowedPlatforms.includes(platform)} onChange={() => togglePlatform(platform)} disabled={!writable} />
                      {PLATFORM_LABELS[platform]}
                    </label>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">只向该 Agent 分配已勾选的平台任务；全部不勾选表示不限制。</p>
              </fieldset>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
              <span aria-live="polite">
                {saveError && <span role="alert" className="text-[11px] text-status-red">{saveError}</span>}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={toggleProfileEditor} disabled={saving}>取消</Button>
                <Button size="sm" onClick={() => void save()} disabled={saving || !displayName.trim()} className="min-h-9">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存资料
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* 当前任务与计划是详情页主体；历史记录默认收起，按需查看。 */}
        <section className={profileEditing || agent.last_error || blockReason ? 'mt-5' : ''} aria-label="当前任务与计划">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5">
                <ClipboardList className="h-4 w-4 text-primary" />
                <h3 className="text-xs font-bold text-foreground">当前任务与计划</h3>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">优先显示正在执行、等待设备和已启用的计划。</p>
            </div>
            <Button size="sm" onClick={() => onAssign(agent)} disabled={!writable || Boolean(blockReason)} className="min-h-9">
              <Plus className="h-4 w-4" /> 分配任务
            </Button>
          </div>

          {activeTasks.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-xl border border-border/70 bg-card">
              {activeTasks.map(task => <AgentTaskRow key={task.id} task={task} />)}
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-dashed border-border px-4 py-4 text-center">
              <p className="text-xs font-semibold text-foreground">当前没有执行中的任务</p>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">新任务分配后会显示在这里；结束后自动归入历史。</p>
            </div>
          )}

          {hasPlan ? (
            <UnattendedPlanSummary
              plan={agent.unattended_plan}
              mirroredAt={agent.unattended_plan_updated_at}
              title="无人值守计划"
              onEdit={() => onEditPlan(agent)}
              editDisabled={!writable || !remoteUnattendedPlanWrite || planDeletePending}
              editTitle={!writable
                ? '只读模式下无法编辑计划'
                : planDeletePending
                  ? '删除指令正在等待设备确认'
                : remoteUnattendedPlanWrite
                  ? undefined
                  : '当前扩展版本不支持云端编辑无人值守计划'}
              onDelete={() => onDeletePlan(agent)}
              deleteDisabled={!writable || !remoteUnattendedPlanDelete || planDeletePending}
              deleteTitle={!writable
                ? '只读模式下无法删除计划'
                : planDeletePending
                  ? '删除指令正在等待设备确认'
                  : remoteUnattendedPlanDelete
                    ? undefined
                    : '需要更新 Extension 后才能安全删除设备本地计划'}
              deleting={planDeletePending}
            />
          ) : (
            <div className="mt-3 rounded-xl border border-dashed border-border px-4 py-5 text-center">
              <CalendarClock className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-xs font-semibold text-foreground">还没有无人值守计划</p>
              <p className="mx-auto mt-1 max-w-60 text-[11px] leading-4 text-muted-foreground">配置后，该 Agent 会按固定时间自动执行关键词采集。</p>
              {writable && (
                <Button variant="outline" size="sm" className="mt-3 min-h-10" disabled={!remoteUnattendedPlanWrite}
                  onClick={() => onCreatePlan(agent)}>
                  <Plus className="h-4 w-4" /> 创建无人值守计划
                </Button>
              )}
              {writable && !remoteUnattendedPlanWrite && (
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">当前扩展版本不支持云端无人值守计划，升级浏览器扩展以解锁。</p>
              )}
            </div>
          )}

          {historyTasks.length > 0 && (
            <details className="group mt-4 overflow-hidden rounded-xl border border-border/70 bg-card">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">历史任务</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">{historyTasks.length}</span>
                </span>
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  点击查看
                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <div className="border-t border-border/60">
                {historyTasks.map(task => <AgentTaskRow key={task.id} task={task} />)}
              </div>
            </details>
          )}
        </section>
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
  onCreatePlan,
  onDeletePlan,
  onDeleteAgent,
  onDetachAgent,
  onRetireAgent,
  deletingPlanAgentId = '',
  deletingAgentId = '',
  detachingAgentId = '',
  retiringAgentId = '',
  onSaved,
}: {
  agents: CloudAgent[]
  tasks: CloudTask[]
  writable: boolean
  onAssign: (agent: CloudAgent) => void
  onEditPlan: (agent: CloudAgent) => void
  onCreatePlan: (agent: CloudAgent) => void
  onDeletePlan: (agent: CloudAgent) => void
  onDeleteAgent: (agent: CloudAgent) => Promise<void>
  onDetachAgent: (agent: CloudAgent) => Promise<void>
  onRetireAgent: (agent: CloudAgent) => Promise<void>
  deletingPlanAgentId?: string
  deletingAgentId?: string
  detachingAgentId?: string
  retiringAgentId?: string
  onSaved: () => Promise<void>
}) {
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<CloudAgent | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [detachCandidate, setDetachCandidate] = useState<CloudAgent | null>(null)
  const [detachError, setDetachError] = useState('')
  const [retireCandidate, setRetireCandidate] = useState<CloudAgent | null>(null)
  const [retireError, setRetireError] = useState('')

  // 轮询刷新会替换 agents 数组；用 id 定位保证详情页在刷新后仍指向最新的同一 Agent，Agent 消失时自动返回列表。
  const activeAgent = activeAgentId ? agents.find(agent => agent.id === activeAgentId) ?? null : null
  const onlineAgentCount = agents.filter(agent => agent.online).length

  const confirmDelete = async () => {
    if (!deleteCandidate) return
    setDeleteError('')
    try {
      await onDeleteAgent(deleteCandidate)
      if (activeAgentId === deleteCandidate.id) setActiveAgentId(null)
      setDeleteCandidate(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : '删除节点失败')
    }
  }

  const confirmDetach = async () => {
    if (!detachCandidate) return
    setDetachError('')
    try {
      await onDetachAgent(detachCandidate)
      if (activeAgentId === detachCandidate.id) setActiveAgentId(null)
      setDetachCandidate(null)
    } catch (err) {
      setDetachError(err instanceof Error ? err.message : '移出当前租户失败')
    }
  }

  const confirmRetire = async () => {
    if (!retireCandidate) return
    setRetireError('')
    try {
      await onRetireAgent(retireCandidate)
      if (activeAgentId === retireCandidate.id) setActiveAgentId(null)
      setRetireCandidate(null)
    } catch (err) {
      setRetireError(err instanceof Error ? err.message : '永久停用节点失败')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {activeAgent ? (
        <AgentDetailPane
          agent={activeAgent}
          tasks={tasks}
          writable={writable}
          onAssign={onAssign}
          onEditPlan={onEditPlan}
          onCreatePlan={onCreatePlan}
          onDeletePlan={onDeletePlan}
          deletingPlan={deletingPlanAgentId === activeAgent.id}
          onSaved={onSaved}
          onBack={() => setActiveAgentId(null)}
        />
      ) : (
        <>
          <header className="mb-3 shrink-0 pr-5">
            <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /><h3 className="text-base font-bold">执行节点 · 在线 {onlineAgentCount}/{agents.length}</h3></div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">每个浏览器均为独立 Agent · 2 分钟无心跳即视为离线</p>
          </header>
          <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 pr-5">
            {agents.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center">
                <CircleOff className="mx-auto h-7 w-7 text-muted-foreground" />
                <div className="mt-3 text-sm font-semibold">还没有 Agent（浏览器节点）</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">客户端扩展重新验证激活码后，会自动注册到这里。</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs">
                {agents.map((agent, index) => (
                  <AgentRow key={agent.id} agent={agent} tasks={tasks} withBorder={index > 0}
                    writable={writable}
                    onOpen={() => setActiveAgentId(agent.id)}
                    onDelete={() => {
                      setDeleteError('')
                      setDeleteCandidate(agent)
                    }}
                    onDetach={() => {
                      setDetachError('')
                      setDetachCandidate(agent)
                    }}
                    onRetire={() => {
                      setRetireError('')
                      setRetireCandidate(agent)
                    }} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <DeleteAgentDialog
        agent={deleteCandidate}
        tasks={tasks}
        deleting={Boolean(deleteCandidate && deletingAgentId === deleteCandidate.id)}
        error={deleteError}
        onOpenChange={open => {
          if (!open) {
            setDeleteCandidate(null)
            setDeleteError('')
          }
        }}
        onConfirm={() => void confirmDelete()}
      />
      <DetachAgentDialog
        agent={detachCandidate}
        tasks={tasks}
        detaching={Boolean(detachCandidate && detachingAgentId === detachCandidate.id)}
        error={detachError}
        onOpenChange={open => {
          if (!open) {
            setDetachCandidate(null)
            setDetachError('')
          }
        }}
        onConfirm={() => void confirmDetach()}
      />
      <RetireAgentDialog
        key={retireCandidate?.id || 'no-retirement-candidate'}
        agent={retireCandidate}
        tasks={tasks}
        retiring={Boolean(retireCandidate && retiringAgentId === retireCandidate.id)}
        error={retireError}
        onOpenChange={open => {
          if (!open) {
            setRetireCandidate(null)
            setRetireError('')
          }
        }}
        onConfirm={() => void confirmRetire()}
      />
    </div>
  )
}
