import { useEffect, useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ArrowLeft, Bot, CheckCircle2, ChevronRight, CircleOff, MessagesSquare, Network, Search, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentTaskCreator } from './AgentTaskCreator'
import type { CloudAgent, CloudTask, ComposerIntent } from './lib'
import {
  ACTIVE_TASK_STATUSES,
  PLATFORM_LABELS,
  agentAssignmentBlockReason,
  agentCreatePlatforms,
  safeNumber,
  taskBelongsToAgent,
} from './lib'

type WizardStep = 'type' | 'assign' | 'agent' | 'configure'
type TaskType = 'keyword' | 'negative_patrol' | 'comment_patrol'
type AssignMethod = 'auto' | 'single' | ''

const TASK_TYPES: Array<{ value: TaskType; title: string; description: string; note: string; icon: LucideIcon; planned: boolean }> = [
  { value: 'keyword', title: '关键词采集', description: '按关键词在小红书、抖音搜索并采集匹配帖子。', note: '一次性补采，或保存为无人值守计划', icon: Search, planned: false },
  { value: 'negative_patrol', title: '负面帖子巡查', description: '定期巡查负面口碑帖并升级预警', note: '规划中，敬请期待', icon: ShieldAlert, planned: true },
  { value: 'comment_patrol', title: '官方账号评论巡查', description: '定期巡查官方账号评论区，发现风险评论', note: '规划中，敬请期待', icon: MessagesSquare, planned: true },
]

const ASSIGN_METHODS: Array<{ value: Exclude<AssignMethod, ''>; title: string; description: string; note: string; icon: LucideIcon; recommended: boolean }> = [
  { value: 'auto', title: '自动分配多个 Agent', description: '系统按负载把关键词拆分到多个在线 Agent', note: '关键词多、Agent 多时更快', icon: Network, recommended: true },
  { value: 'single', title: '指定单个 Agent', description: '手动选择一个 Agent 执行本次任务，离线也可排队。', note: '适合定点补采或单设备计划', icon: Bot, recommended: false },
]

const STEP_LABELS: Array<{ step: WizardStep; label: string }> = [
  { step: 'type', label: '任务类型' },
  { step: 'assign', label: '分配方式' },
  { step: 'agent', label: '选择 Agent' },
  { step: 'configure', label: '配置并确认' },
]

function StepIndicator({ step }: { step: WizardStep }) {
  const currentIndex = STEP_LABELS.findIndex(item => item.step === step)
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="创建任务步骤">
      {STEP_LABELS.map((item, index) => (
        <li key={item.step} aria-current={index === currentIndex ? 'step' : undefined}
          className={`min-w-0 rounded-xl border px-2.5 py-2.5 ${index === currentIndex ? 'border-primary/35 bg-primary/8' : index < currentIndex ? 'border-status-green/25 bg-status-green/5' : 'border-border/70 bg-muted/35'}`}>
          <div className={`text-[10px] font-bold uppercase tracking-wider ${index === currentIndex ? 'text-primary' : index < currentIndex ? 'text-status-green' : 'text-muted-foreground'}`}>
            {index < currentIndex ? '已完成' : `第 ${index + 1} 步`}
          </div>
          <div className="mt-0.5 truncate text-xs font-semibold text-foreground">{item.label}</div>
        </li>
      ))}
    </ol>
  )
}

export function CreateTaskDrawer({
  agents,
  tasks,
  writable,
  intent,
  onClose,
  onCreated,
  onLaunchOrchestration,
}: {
  agents: CloudAgent[]
  tasks: CloudTask[]
  writable: boolean
  intent: ComposerIntent
  onClose: () => void
  onCreated: () => Promise<void>
  onLaunchOrchestration: () => void
}) {
  const editingExisting = intent.editExisting === true
  // 从 Agent 详情「分配任务」进入时锁定该 Agent：跳过分配方式/选 Agent 两步，直接 类型 → 配置。
  const presetAgentId = !editingExisting && intent.agentId ? intent.agentId : ''
  const mode: 'one_time' | 'unattended_plan' = intent.mode || (editingExisting ? 'unattended_plan' : 'one_time')

  const [step, setStep] = useState<WizardStep>(editingExisting ? 'configure' : 'type')
  const [assignMethod, setAssignMethod] = useState<AssignMethod>('')
  const [taskType, setTaskType] = useState<TaskType>('keyword')
  const [selectedAgentId, setSelectedAgentId] = useState(intent.agentId || '')
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId)

  const sortedAgents = useMemo(() => [...agents].sort((left, right) => {
    const leftBlocked = Boolean(agentAssignmentBlockReason(left, mode))
    const rightBlocked = Boolean(agentAssignmentBlockReason(right, mode))
    if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1
    if (left.online !== right.online) return left.online ? -1 : 1
    return `${left.host_label}${left.display_name}`.localeCompare(`${right.host_label}${right.display_name}`, 'zh-CN')
  }), [agents, mode])

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

  const showIndicator = !editingExisting && !presetAgentId
  const atFirstStep = step === 'type' || (step === 'configure' && editingExisting)

  const goBack = () => {
    if (step === 'configure') {
      if (editingExisting) return onClose()
      if (presetAgentId) return setStep('type')
      return setStep('agent')
    }
    if (step === 'agent') return setStep('assign')
    if (step === 'assign') return setStep('type')
    return onClose()
  }

  const goNext = () => {
    if (step === 'type') {
      if (presetAgentId) return setStep('configure')
      return setStep('assign')
    }
    if (step === 'assign') {
      // 自动分配多个 Agent：交回父组件关闭本抽屉并打开编排抽屉；不改动本地步骤。
      if (assignMethod === 'auto') return onLaunchOrchestration()
      if (assignMethod === 'single') return setStep('agent')
      return
    }
    if (step === 'agent') return setStep('configure')
  }

  const nextDisabled = !writable
    || (step === 'assign' && !assignMethod)
    || (step === 'agent' && !selectedAgentId)

  const nextLabel = step === 'type'
    ? (presetAgentId ? '下一步：配置任务' : '下一步：选择分配方式')
    : step === 'assign'
      ? (assignMethod === 'auto' ? '前往多 Agent 编排' : '下一步：选择 Agent')
      : '下一步：配置任务'

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* 多步表单：不点击空白关闭，避免误触丢失已填内容；用 X / Esc 关闭。 */}
      <div className="absolute inset-0 bg-black/35" aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby="create-task-title"
        className="relative z-10 flex h-full w-full max-w-3xl flex-col bg-card shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200 lg:border-l lg:border-border">
        <header className="shrink-0 border-b border-border/70 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
          <div className="flex items-start gap-3">
            <button type="button" onClick={goBack} aria-label={atFirstStep ? '关闭任务创建' : '返回上一步'}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted hover:text-foreground">
              {atFirstStep ? <X className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
            </button>
            <div className="min-w-0 flex-1">
              <h2 id="create-task-title" className="text-lg font-bold text-foreground">{editingExisting ? '修改无人值守计划' : '新建任务'}</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {editingExisting
                  ? '更新该设备的无人值守计划，保存后覆盖原计划。'
                  : '先选择任务类型，再决定交给哪个 Agent（浏览器节点）执行。'}
              </p>
            </div>
          </div>
          {showIndicator && <div className="mt-4"><StepIndicator step={step} /></div>}
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
          {step === 'type' && (
            <div className="mx-auto max-w-2xl">
              <div className="mb-4">
                <h3 className="text-base font-bold">这次要创建哪种任务？</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">目前开放关键词采集；巡查类任务正在规划中，可先了解方向。</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="任务类型">
                {TASK_TYPES.map(item => {
                  const Icon = item.icon
                  const selected = !item.planned && taskType === item.value
                  return (
                    <button key={item.value} type="button" role="radio" aria-checked={selected} aria-disabled={item.planned || undefined}
                      onClick={() => { if (!item.planned) setTaskType(item.value) }}
                      className={`flex min-h-44 flex-col rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${item.planned ? 'cursor-not-allowed border-dashed border-border/70 bg-muted/30' : selected ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/20' : 'border-border bg-background hover:border-primary/35'}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${!item.planned && selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}><Icon className="h-5 w-5" /></span>
                        {item.planned
                          ? <span className="rounded-full bg-status-orange/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">规划中</span>
                          : <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}>{selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary-foreground" />}</span>}
                      </div>
                      <div className="mt-4 text-sm font-bold text-foreground">{item.title}</div>
                      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.description}</p>
                      <div className={`mt-auto pt-3 text-[11px] font-medium ${item.planned ? 'text-muted-foreground' : 'text-primary'}`}>{item.note}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 'assign' && (
            <div className="mx-auto max-w-2xl">
              <div className="mb-4">
                <h3 className="text-base font-bold">怎么把这批关键词分给 Agent？</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">Agent 指浏览器执行节点。多个在线 Agent 时可自动分摊，也可指定单个执行。</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="分配方式">
                {ASSIGN_METHODS.map(item => {
                  const Icon = item.icon
                  const selected = assignMethod === item.value
                  return (
                    <button key={item.value} type="button" role="radio" aria-checked={selected} onClick={() => setAssignMethod(item.value)}
                      className={`min-h-44 rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/20' : 'border-border bg-background hover:border-primary/35'}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}><Icon className="h-5 w-5" /></span>
                        <span className="flex items-center gap-2">
                          {item.recommended && <span className="rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[10px] font-bold text-primary">推荐</span>}
                          <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}>{selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary-foreground" />}</span>
                        </span>
                      </div>
                      <div className="mt-4 text-sm font-bold text-foreground">{item.title}</div>
                      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.description}</p>
                      <div className="mt-3 text-[11px] font-medium text-primary">{item.note}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 'agent' && (
            <div className="mx-auto max-w-2xl">
              <div className="mb-4">
                <h3 className="text-base font-bold">选择一个 Agent</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">任务会绑定到具体浏览器扩展。离线 Agent 仍可接单，上线后自动领取。</p>
              </div>
              {sortedAgents.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border p-8 text-center">
                  <CircleOff className="mx-auto h-7 w-7 text-muted-foreground" />
                  <div className="mt-3 text-sm font-semibold">还没有可分配的 Agent</div>
                  <p className="mt-1 text-xs text-muted-foreground">让客户端扩展重新验证激活码后，再回来分配任务。</p>
                </div>
              ) : (
                <div className="space-y-2" role="radiogroup" aria-label="Agent">
                  {sortedAgents.map(agent => {
                    const blockReason = agentAssignmentBlockReason(agent, mode)
                    const selected = selectedAgentId === agent.id
                    const agentTasks = tasks.filter(task => taskBelongsToAgent(task, agent) && ACTIVE_TASK_STATUSES.has(task.effective_status || task.status))
                    const workloadKnown = agent.active_task_count !== undefined || agent.queued_task_count !== undefined
                    const activeTaskCount = workloadKnown ? safeNumber(agent.active_task_count) : agentTasks.length
                    const queuedTaskCount = workloadKnown ? safeNumber(agent.queued_task_count) : 0
                    return (
                      <button key={agent.id} type="button" role="radio" aria-checked={selected} disabled={Boolean(blockReason)}
                        onClick={() => setSelectedAgentId(agent.id)}
                        className={`flex min-h-24 w-full items-start gap-3 rounded-2xl border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/20' : 'border-border bg-background hover:border-primary/35'}`}>
                        <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}><Bot className="h-5 w-5" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-bold text-foreground">{agent.display_name}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${agent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>{agent.online ? '在线' : '离线'}</span>
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">{agent.host_label} › {agent.browser_name} · {agent.operating_system} · v{agent.app_version || '未知'}</span>
                          <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{agentCreatePlatforms(agent).map(value => PLATFORM_LABELS[value] || value).join('、') || '无可用平台'}</span>
                            <span>
                              {activeTaskCount > 0
                                ? `执行中 ${activeTaskCount}`
                                : queuedTaskCount > 0
                                  ? '当前无执行任务'
                                  : '当前空闲'}
                              {queuedTaskCount > 0 ? ` · 排队 ${queuedTaskCount}` : ''}
                            </span>
                          </span>
                          {blockReason && <span className="mt-1.5 block text-[11px] font-medium text-status-red">{blockReason}</span>}
                          {!blockReason && !agent.online && <span className="mt-1.5 block text-[11px] font-medium text-amber-700 dark:text-amber-300">Agent 离线；分配后会排队，上线即执行</span>}
                        </span>
                        <span className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}>{selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary-foreground" />}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {step === 'configure' && (
            selectedAgent ? (
              <div className="mx-auto max-w-2xl">
                <div className="mb-4 rounded-2xl border border-primary/20 bg-primary/[0.045] p-3.5">
                  <div className="flex items-center gap-3">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${selectedAgent.online ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}><Bot className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-primary">已分配 Agent</div>
                      <div className="mt-0.5 truncate text-sm font-bold">{selectedAgent.host_label} › {selectedAgent.display_name}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{selectedAgent.online ? '在线，提交后设备将在下一次心跳领取' : '离线，提交后在云端排队，上线自动领取'}</div>
                    </div>
                    {!editingExisting && !presetAgentId && <button type="button" onClick={() => setStep('agent')} className="min-h-10 rounded-lg px-3 text-xs font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">更换</button>}
                  </div>
                </div>
                <AgentTaskCreator
                  key={`${selectedAgent.id}:${mode}:${editingExisting ? 'edit' : 'new'}`}
                  agent={selectedAgent}
                  writable={writable}
                  initialExecutionMode={mode}
                  forceOpen
                  editExistingInitially={editingExisting}
                  hideLauncher
                  lockExecutionMode={editingExisting || Boolean(intent.mode)}
                  onCreated={async () => {
                    await onCreated()
                    onClose()
                  }}
                />
              </div>
            ) : (
              <div className="mx-auto max-w-2xl rounded-2xl border border-dashed border-border p-8 text-center">
                <CircleOff className="mx-auto h-7 w-7 text-muted-foreground" />
                <div className="mt-3 text-sm font-semibold">未找到目标 Agent</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">该 Agent 可能已下线或被移除，请返回重新选择。</p>
                <Button variant="outline" size="sm" onClick={goBack} className="mt-4">返回</Button>
              </div>
            )
          )}
        </div>

        {step !== 'configure' && (
          <footer className="shrink-0 border-t border-border bg-card px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
              <Button type="button" variant="ghost" onClick={goBack}>{step === 'type' ? '取消' : '上一步'}</Button>
              <Button type="button" onClick={goNext} disabled={nextDisabled} className="min-h-11 min-w-36">
                {nextLabel} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}
