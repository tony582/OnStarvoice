import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeft, Bot, CalendarClock, Check, CheckCircle2, ChevronRight, CircleOff,
  MessagesSquare, Network, Radar, Search, ShieldAlert, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Drawer } from '@/components/shared/Drawer'
import { AgentPicker } from './AgentPicker'
import { AgentTaskCreator } from './AgentTaskCreator'
import { NegativePatrolTaskCreator } from './NegativePatrolTaskCreator'
import { OfficialCommentPatrolTaskCreator } from './OfficialCommentPatrolTaskCreator'
import { AccountDiscoveryTaskCreator } from './AccountDiscoveryTaskCreator'
import type { CloudAgent, CloudCreateTaskType, CloudTask, ComposerIntent } from './lib'
import { agentTaskTypeBlockReason } from './lib'
import type { OrchestrationLaunchIntent } from './types'

// 统一「新建任务」向导：任务类型 → 执行方式 → 选择节点 → 任务配置。
// 单节点配置复用 AgentTaskCreator；多节点直接进入编排器，在平台和采集规则确定后只选一次节点。
type WizardStep = 'type' | 'method' | 'agents' | 'configure'
type TaskType = CloudCreateTaskType
type ExecutionMethod = 'single' | 'multi'

const TASK_TYPE_CARDS: Array<{ value: string; title: string; description: string; note: string; icon: LucideIcon; planned: boolean }> = [
  { value: 'keyword', title: '关键词采集', description: '按关键词在小红书、抖音搜索并采集匹配帖子。', note: '一次性补采', icon: Search, planned: false },
  { value: 'unattended_plan', title: '无人值守计划', description: '保存为定时计划，Agent 到点自动执行关键词采集。', note: '定时自动执行', icon: CalendarClock, planned: false },
  { value: 'creator_patrol', title: '关注博主扫描', description: '打开已关注博主主页，发现近期作品并更新博主新动态。', note: '主页作品发现', icon: Radar, planned: false },
  { value: 'negative_patrol', title: '负面帖子巡查', description: '从已有负面内容中按发布日期等条件圈定帖子，再交给 Agent 逐帖补采。', note: '定向逐帖采集', icon: ShieldAlert, planned: false },
  { value: 'comment_patrol', title: '官方账号评论巡查', description: '打开官方账号主页，按最新顺序读取指定数量的作品及当前可见评论。', note: '账号主页增强', icon: MessagesSquare, planned: false },
]

const EXECUTION_METHODS: Array<{ value: ExecutionMethod; title: string; description: string; icon: LucideIcon }> = [
  { value: 'single', title: '固定一个节点', description: '只交给指定 Agent；节点离线时任务原地等待，不自动转交。', icon: Bot },
  { value: 'multi', title: '弹性节点池（推荐）', description: '工作项留在云端，哪个兼容节点先空闲就先领取一个。', icon: Network },
]

const STEP_LABELS: Array<{ step: WizardStep; label: string }> = [
  { step: 'type', label: '任务类型' },
  { step: 'method', label: '执行方式' },
  { step: 'agents', label: '选择节点' },
  { step: 'configure', label: '任务配置' },
]

function StepIndicator({ step, labels, canBack, onBack }: { step: WizardStep; labels: typeof STEP_LABELS; canBack: (target: WizardStep) => boolean; onBack: (target: WizardStep) => void }) {
  const currentIndex = labels.findIndex(item => item.step === step)
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="创建任务步骤">
      {labels.map((item, index) => {
        const done = index < currentIndex
        const current = index === currentIndex
        const content = (
          <>
            <div className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider ${current ? 'text-primary' : done ? 'text-status-green' : 'text-muted-foreground'}`}>
              {done ? <><Check className="h-3 w-3" /> 已完成</> : `第 ${index + 1} 步`}
            </div>
            <div className="mt-0.5 truncate text-xs font-semibold text-foreground">{item.label}</div>
          </>
        )
        return (
          <li key={item.step} aria-current={current ? 'step' : undefined}
            className={`min-w-0 rounded-xl border px-2.5 py-2.5 ${current ? 'border-primary/35 bg-primary/8' : done ? 'border-status-green/25 bg-status-green/5' : 'border-border/70 bg-muted/35'}`}>
            {done && canBack(item.step)
              ? <button type="button" onClick={() => onBack(item.step)} className="-m-1 block w-full rounded-lg p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{content}</button>
              : content}
          </li>
        )
      })}
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
  onLaunchOrchestration: (intent: OrchestrationLaunchIntent) => void
}) {
  const editingExisting = intent.editExisting === true
  // 从 Agent 详情「分配任务/创建计划」进入时锁定该 Agent：跳过执行方式与选择节点两步。
  const presetAgentId = intent.agentId || ''
  // intent.mode 视为已定任务类型（如 Agent 抽屉「创建无人值守计划」），直接落到配置步。
  const presetTaskType: TaskType | null = editingExisting || intent.mode === 'unattended_plan'
    ? 'unattended_plan'
    : intent.taskType === 'comment_patrol'
      ? 'comment_patrol'
      : intent.taskType === 'creator_patrol'
        ? 'creator_patrol'
        : null
  const startsAtConfigure = editingExisting || Boolean(presetAgentId && presetTaskType)

  const [step, setStep] = useState<WizardStep>(startsAtConfigure ? 'configure' : 'type')
  const [taskType, setTaskType] = useState<TaskType>(presetTaskType || 'keyword')
  const [method, setMethod] = useState<ExecutionMethod>('single')
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>(presetAgentId ? [presetAgentId] : [])

  const mode: 'one_time' | 'unattended_plan' = taskType === 'unattended_plan' ? 'unattended_plan' : 'one_time'
  const selectedAgent = agents.find(agent => agent.id === selectedAgentIds[0])
  const selectedAgents = selectedAgentIds
    .map(id => agents.find(agent => agent.id === id))
    .filter((agent): agent is CloudAgent => Boolean(agent))
  // 已选节点里当前仍可接单的（任务类型回退修改后，原选择可能因能力/平台不符被阻断）。
  const selectedAssignableIds = selectedAgentIds.filter(id => {
    const agent = agents.find(candidate => candidate.id === id)
    return agent ? !agentTaskTypeBlockReason(agent, taskType, mode) : false
  })
  const showIndicator = !editingExisting
  const atFirstStep = step === 'type' || (step === 'configure' && startsAtConfigure)
  const orchestrationPath = method === 'multi' && taskType !== 'negative_patrol'
  const stepLabels = orchestrationPath
    ? [
        { step: 'type' as const, label: '任务类型' },
        { step: 'method' as const, label: '执行范围' },
        { step: 'agents' as const, label: '任务配置与节点' },
        { step: 'configure' as const, label: '分配确认' },
      ]
    : STEP_LABELS

  const goBack = () => {
    if (step === 'configure') {
      if (startsAtConfigure) return onClose()
      if (presetAgentId) return setStep('type')
      return setStep('agents')
    }
    if (step === 'agents') return setStep('method')
    if (step === 'method') return setStep('type')
    return onClose()
  }

  const goNext = () => {
    if (step === 'type') {
      if (presetAgentId) return setStep('configure')
      return setStep('method')
    }
    if (step === 'method') {
      if (method === 'multi' && taskType !== 'negative_patrol') {
        return onLaunchOrchestration({
          executionMode: mode,
          agentIds: [],
          lockExecutionMode: true,
          minimumAgentCount: 2,
        })
      }
      return setStep('agents')
    }
    if (step === 'agents') {
      return setStep('configure')
    }
  }

  // 步骤条回退：锁定 Agent 的链路只能回到任务类型，避免绕过锁定。
  const canBackTo = (target: WizardStep) => {
    if (editingExisting) return false
    if (presetAgentId) return target === 'type'
    return true
  }
  const goBackTo = (target: WizardStep) => {
    if (canBackTo(target)) setStep(target)
  }

  const nextDisabled = !writable
    || (step === 'agents' && selectedAssignableIds.length === 0)
    || (
      step === 'agents'
      && method === 'multi'
      && selectedAssignableIds.length < 2
    )

  const nextLabel = step === 'type'
    ? (presetAgentId ? '下一步：任务配置' : '下一步：执行方式')
    : step === 'method'
      ? method === 'multi' && taskType !== 'negative_patrol'
        ? '配置多节点任务'
        : '下一步：选择节点'
      : '下一步：任务配置'

  return (
    <Drawer onClose={onClose} width="xl" labelledBy="create-task-title" closeOnOverlay={false}>
      <header className="shrink-0 border-b border-border/70 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
        <div className="flex items-start gap-3">
          <button type="button" onClick={goBack} aria-label={atFirstStep ? '关闭任务创建' : '返回上一步'} data-dialog-initial-focus
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted hover:text-foreground">
            {atFirstStep ? <X className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
          </button>
          <div className="min-w-0 flex-1">
            <h2 id="create-task-title" className="text-lg font-bold text-foreground">{editingExisting ? '修改无人值守计划' : '新建任务'}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {editingExisting
                ? '更新该设备的无人值守计划，保存后覆盖原计划。'
                : '先选择任务类型，再决定固定给一个节点，还是交给弹性节点池。'}
            </p>
          </div>
        </div>
        {showIndicator && <div className="mt-4"><StepIndicator step={step} labels={stepLabels} canBack={canBackTo} onBack={goBackTo} /></div>}
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
        {step === 'type' && (
          <div className="mx-auto max-w-2xl">
            <div className="mb-4">
              <h3 className="text-base font-bold">这次要创建哪种任务？</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">关键词任务负责发现新内容；负面巡查负责回到已识别帖子补采最新详情。</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="任务类型">
              {TASK_TYPE_CARDS.map(item => {
                const Icon = item.icon
                const selected = !item.planned && taskType === item.value
                return (
                  <button key={item.value} type="button" role="radio" aria-checked={selected} aria-disabled={item.planned || undefined}
                    onClick={() => {
                      if (!item.planned) {
                        setTaskType(item.value as TaskType)
                        if (['comment_patrol', 'creator_patrol'].includes(item.value)) {
                          setMethod('single')
                          setSelectedAgentIds(current => current.slice(0, 1))
                        }
                      }
                    }}
                    className={`flex min-h-36 flex-col rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${item.planned ? 'cursor-not-allowed border-dashed border-border/70 bg-muted/30' : selected ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/20' : 'border-border bg-background hover:border-primary/35'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${!item.planned && selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}><Icon className="h-5 w-5" /></span>
                      {item.planned
                        ? <span className="rounded-full bg-status-orange/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">即将上线</span>
                        : <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}>{selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary-foreground" />}</span>}
                    </div>
                    <div className="mt-3 text-sm font-bold text-foreground">{item.title}</div>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.description}</p>
                    {item.note && <div className="mt-auto pt-3 text-[11px] font-medium text-primary">{item.note}</div>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step === 'method' && (
          <div className="mx-auto max-w-2xl">
            <div className="mb-4">
              <h3 className="text-base font-bold">怎么执行这批采集？</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">固定节点适合必须保留同一浏览器现场的任务；弹性池适合可拆分的批量工作。</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="执行方式">
              {EXECUTION_METHODS.map(item => {
                const Icon = item.icon
                const selected = method === item.value
                const unavailable = ['comment_patrol', 'creator_patrol'].includes(taskType) && item.value === 'multi'
                const elasticPool = item.value === 'multi'
                  && ['keyword', 'unattended_plan', 'negative_patrol'].includes(taskType)
                const itemTitle = item.title
                return (
                  <button key={item.value} type="button" role="radio" aria-checked={selected} aria-disabled={unavailable || undefined}
                    onClick={() => {
                      if (unavailable) return
                      setMethod(item.value)
                      if (item.value === 'single') setSelectedAgentIds(current => current.slice(0, 1))
                    }}
                    className={`min-h-36 rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${unavailable ? 'cursor-not-allowed border-dashed border-border/70 bg-muted/30 opacity-65' : selected ? 'border-primary bg-primary/[0.055] ring-1 ring-primary/20' : 'border-border bg-background hover:border-primary/35'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}><Icon className="h-5 w-5" /></span>
                      {unavailable
                        ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">后续开放</span>
                        : <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}>{selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary-foreground" />}</span>}
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-sm font-bold text-foreground">
                      {itemTitle}
                      {elasticPool && <span className="rounded-full bg-status-green/10 px-2 py-0.5 text-[9px] font-semibold text-status-green">动态领取</span>}
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                      {unavailable
                        ? taskType === 'creator_patrol'
                          ? '账号作品发现首版由一个 Agent 串行执行；每个账号只打开一次，避免重复发现。'
                          : '评论巡查首版由一个 Agent 串行执行，避免同一作品被重复打开。'
                        : item.description}
                    </p>
                    {!unavailable && item.value === 'multi' && selected && (
                      <p className="mt-2 text-[11px] leading-4 text-primary">
                        每个节点一次只领一个工作项；做完继续领，快的自然多做。
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step === 'agents' && (
          <div className="mx-auto max-w-2xl">
            <div className="mb-4">
              <h3 className="text-base font-bold">{method === 'multi' ? '选择参与编排的节点' : '选择一个执行节点'}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {method === 'multi'
                  ? taskType === 'negative_patrol'
                    ? '可多选；帖子保留在云端，由这些兼容节点空闲时逐篇领取。'
                    : '可多选；关键词保留在云端，由这些兼容节点空闲时逐个领取。'
                  : '任务会绑定到具体浏览器扩展。节点离线时原地等待，不会自动转交。'}
              </p>
            </div>
            <AgentPicker
              agents={agents}
              tasks={tasks}
              mode={mode}
              taskType={taskType}
              multiple={method === 'multi'}
              selectedIds={selectedAgentIds}
              onChange={setSelectedAgentIds}
            />
            {method === 'multi' && selectedAssignableIds.length < 2 && (
              <p role="status" className="mt-3 text-xs leading-5 text-status-orange">
                多 Agent 模式至少选择 2 个可用节点。
              </p>
            )}
          </div>
        )}

        {step === 'configure' && (
          selectedAgent ? (
            <div className="mx-auto max-w-2xl">
              {/* 步骤上下文摘要条：任务类型 · 执行方式 · 已选节点；可点击回退修改 */}
              <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
                <span className={`h-2 w-2 shrink-0 rounded-full ${selectedAgent.status === 'paused' ? 'bg-status-orange' : selectedAgent.online ? 'bg-status-green' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
                <span className="font-semibold text-foreground">
                  {taskType === 'unattended_plan'
                    ? '无人值守计划'
                    : taskType === 'creator_patrol'
                      ? '关注博主扫描'
                    : taskType === 'negative_patrol'
                      ? '负面帖子巡查'
                      : taskType === 'comment_patrol'
                        ? '官方账号评论巡查'
                        : '关键词采集'}
                </span>
                <span aria-hidden="true">·</span>
                <span>{method === 'multi' ? `多节点 · ${selectedAgents.length} 个 Agent` : '单个节点'}</span>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate">
                  {method === 'multi'
                    ? selectedAgents.map(agent => agent.display_name).join('、')
                    : `${selectedAgent.host_label} › ${selectedAgent.display_name}`}
                </span>
                {!editingExisting && (
                  <button type="button" onClick={goBack}
                    className="ml-auto min-h-7 shrink-0 rounded-md px-2 text-[11px] font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                    返回修改
                  </button>
                )}
              </div>
              {taskType === 'negative_patrol' ? (
                <NegativePatrolTaskCreator
                  key={`${selectedAgentIds.join(':')}:negative-patrol`}
                  agents={method === 'multi' ? selectedAgents : [selectedAgent]}
                  writable={writable}
                  onCreated={async () => {
                    await onCreated()
                    onClose()
                  }}
                />
              ) : taskType === 'comment_patrol' ? (
                <OfficialCommentPatrolTaskCreator
                  key={`${selectedAgent.id}:official-comment-patrol`}
                  agent={selectedAgent}
                  writable={writable}
                  initialOfficialAccountId={intent.officialAccountId}
                  onCreated={async () => {
                    await onCreated()
                    onClose()
                  }}
                />
              ) : taskType === 'creator_patrol' ? (
                <AccountDiscoveryTaskCreator
                  key={`${selectedAgent.id}:followed-creator-patrol`}
                  agent={selectedAgent}
                  writable={writable}
                  initialSubscriptionId={intent.subscriptionId}
                  subjectType="creator"
                  onCreated={async () => {
                    await onCreated()
                    onClose()
                  }}
                />
              ) : (
                <AgentTaskCreator
                  key={`${selectedAgent.id}:${mode}:${editingExisting ? 'edit' : 'new'}`}
                  agent={selectedAgent}
                  writable={writable}
                  initialExecutionMode={mode}
                  forceOpen
                  editExistingInitially={editingExisting}
                  hideLauncher
                  lockExecutionMode
                  onCreated={async () => {
                    await onCreated()
                    onClose()
                  }}
                />
              )}
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
    </Drawer>
  )
}
