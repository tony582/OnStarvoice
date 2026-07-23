import { Bot, CalendarClock, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CloudAgent, CloudTask } from './lib'
import {
  PLAN_MODE_LABELS,
  PLATFORM_LABELS,
  STATUS_LABELS,
  formatTime,
  hasConfiguredUnattendedPlan,
  safeNumber,
} from './lib'

// 「计划」视图集中呈现所有定期任务：多 Agent 无人值守编排模板 + 各设备本地无人值守计划。
// 纯展示与跳转，暂停/恢复/编辑等写操作分别下沉到编排详情与计划编辑抽屉，此处不直接写。
export function PlansView({
  templates,
  agents,
  writable,
  onOpenOrchestration,
  onEditPlan,
}: {
  templates: CloudTask[]
  agents: CloudAgent[]
  writable: boolean
  onOpenOrchestration: (task: CloudTask) => void
  onEditPlan: (agent: CloudAgent) => void
}) {
  const planAgents = agents.filter(agent => hasConfiguredUnattendedPlan(agent.unattended_plan))

  if (templates.length === 0 && planAgents.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-2xl border border-border/70 bg-card py-16 text-center shadow-xs">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted/40">
          <CalendarClock className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="mt-3 text-[14px] font-semibold text-foreground">暂无定期任务</div>
        <p className="mt-1 max-w-[320px] text-[13px] leading-5 text-muted-foreground">
          这里集中管理所有定期任务。配置好多 Agent 无人值守计划或设备本地计划后会在此显示；
          负面帖子巡查、官方账号评论巡查上线后也会出现在这里。
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {templates.length > 0 && (
        <section>
          <SectionHeader icon={Network} title="多 Agent 无人值守计划" count={templates.length} />
          <div className="mt-3 space-y-3">
            {templates.map(task => (
              <TemplateCard key={task.id} task={task} onOpenOrchestration={onOpenOrchestration} />
            ))}
          </div>
        </section>
      )}

      {planAgents.length > 0 && (
        <section>
          <SectionHeader icon={Bot} title="设备本地无人值守计划" count={planAgents.length} />
          <div className="mt-3 space-y-3">
            {planAgents.map(agent => (
              <AgentPlanCard
                key={agent.id}
                agent={agent}
                writable={writable}
                onEditPlan={onEditPlan}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  count,
}: {
  icon: typeof CalendarClock
  title: string
  count: number
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  )
}

function PlatformChip({ platform }: { platform?: string }) {
  const label = PLATFORM_LABELS[platform || 'unknown'] || platform || '未识别'
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {label}
    </span>
  )
}

// 模板计划的状态优先看编排级 scheduleStatus（启用/暂停），否则回退到任务本身的 STATUS_LABELS。
function templateScheduleChip(task: CloudTask): { label: string; className: string } {
  const scheduleStatus = String(task.metadata?.scheduleStatus || '')
  if (scheduleStatus === 'active') {
    return { label: '计划已启用', className: 'bg-status-green/10 text-status-green' }
  }
  if (scheduleStatus === 'paused') {
    return { label: '计划已暂停', className: 'bg-muted text-muted-foreground' }
  }
  const label = STATUS_LABELS[task.status] || task.status || '未知状态'
  return { label, className: 'bg-muted text-muted-foreground' }
}

function TemplateCard({
  task,
  onOpenOrchestration,
}: {
  task: CloudTask
  onOpenOrchestration: (task: CloudTask) => void
}) {
  const chip = templateScheduleChip(task)
  const workItemCount = safeNumber(task.counts?.total ?? task.progress?.total)
  const nextRunRaw = task.metadata?.nextRunAt
  const nextRun = formatTime(typeof nextRunRaw === 'string' ? nextRunRaw : null)
  const revision = safeNumber(task.orchestration_revision)

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PlatformChip platform={task.platform} />
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip.className}`}>
              {chip.label}
            </span>
          </div>
          <h4 className="mt-1.5 truncate text-[14px] font-semibold text-foreground">
            {task.title || '未命名编排计划'}
          </h4>
        </div>
        <Button variant="outline" size="sm" onClick={() => onOpenOrchestration(task)}>
          查看编排
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-5 text-muted-foreground">
        <span>关键词工作项 <span className="tabular-nums text-foreground">{workItemCount}</span></span>
        <span>下次运行 <span className="text-foreground">{nextRun}</span></span>
        <span>分配版本 <span className="tabular-nums text-foreground">v{revision}</span></span>
      </div>
    </div>
  )
}

function AgentPlanCard({
  agent,
  writable,
  onEditPlan,
}: {
  agent: CloudAgent
  writable: boolean
  onEditPlan: (agent: CloudAgent) => void
}) {
  const plan = agent.unattended_plan
  if (!plan) return null

  const keywords = Array.isArray(plan.keywords)
    ? plan.keywords.map(value => String(value || '').trim()).filter(Boolean)
    : []
  const keywordCount = Math.max(keywords.length, safeNumber(plan.keywordCount))
  const platformLabel = PLATFORM_LABELS[plan.platform || 'unknown'] || plan.platform || '未设置'
  const mode = PLAN_MODE_LABELS[String(plan.mode || '')] || String(plan.mode || '本地设置')
  const lastRunStatus = STATUS_LABELS[String(plan.lastRunStatus || '')] || String(plan.lastRunStatus || '')

  const points = [
    `平台 ${platformLabel}`,
    `关键词 ${keywordCount} 个`,
    plan.enabled ? `执行 ${mode}${plan.startTime ? ` ${plan.startTime}` : ''}` : '当前不自动执行',
    `下次运行 ${formatTime(plan.nextRunAt)}`,
    `上次运行 ${formatTime(plan.lastRunAt)}${lastRunStatus ? ` · ${lastRunStatus}` : ''}`,
  ]

  const canEditPlan = writable && agent.capabilities?.remoteUnattendedPlanWrite === true
  const editBlockTitle = !writable
    ? '只读模式下无法编辑计划'
    : agent.capabilities?.remoteUnattendedPlanWrite === true
      ? undefined
      : '当前客户端扩展版本不支持云端无人值守计划，升级后可编辑'

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-[14px] font-semibold text-foreground">
              {agent.display_name || 'Agent'}
            </h4>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${plan.enabled ? 'bg-status-green/10 text-status-green' : 'bg-muted text-muted-foreground'}`}>
              {plan.enabled ? '已启用' : '未启用'}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            设备 {agent.host_label || '未命名设备'}
          </div>
        </div>
        <span title={editBlockTitle}>
          <Button
            variant="outline"
            size="sm"
            disabled={!canEditPlan}
            onClick={() => onEditPlan(agent)}
          >
            编辑计划
          </Button>
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{points.join(' · ')}</p>
    </div>
  )
}
