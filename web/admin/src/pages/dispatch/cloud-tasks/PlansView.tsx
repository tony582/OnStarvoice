import { useState } from 'react'
import {
  Archive,
  Bot,
  CalendarClock,
  Copy,
  Loader2,
  Network,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CloudAgent, CloudTask } from './lib'
import {
  PLAN_MODE_LABELS,
  PLATFORM_LABELS,
  STATUS_LABELS,
  formatTime,
  hasConfiguredUnattendedPlan,
  isUnattendedPlanEnded,
  safeNumber,
  unattendedPlanDates,
} from './lib'

type PlansViewProps = {
  templates: CloudTask[]
  agents: CloudAgent[]
  writable: boolean
  onOpenOrchestration: (task: CloudTask) => void
  onEditPlan: (agent: CloudAgent) => void
  onDeletePlan: (agent: CloudAgent) => void
  onArchiveTemplate: (task: CloudTask) => void
  onRestoreTemplate: (task: CloudTask) => void
  onCopyTemplate: (task: CloudTask) => void
  templateActionId?: string
  deletingAgentId?: string
  pendingDeleteAgentIds: Set<string>
}

function isCurrentTemplate(task: CloudTask) {
  const scheduleStatus = String(task.metadata?.scheduleStatus || '')
  return !task.metadata?.scheduleArchivedAt
    && (scheduleStatus === 'active' || scheduleStatus === 'paused')
}

export function PlansView({
  templates,
  agents,
  writable,
  onOpenOrchestration,
  onEditPlan,
  onDeletePlan,
  onArchiveTemplate,
  onRestoreTemplate,
  onCopyTemplate,
  templateActionId = '',
  deletingAgentId = '',
  pendingDeleteAgentIds,
}: PlansViewProps) {
  const [view, setView] = useState<'current' | 'archive'>('current')
  const planAgents = agents.filter(agent => hasConfiguredUnattendedPlan(agent.unattended_plan))
  const currentTemplates = templates.filter(isCurrentTemplate)
  const archivedTemplates = templates.filter(task => !isCurrentTemplate(task))
  const currentPlanAgents = planAgents.filter(agent => !isUnattendedPlanEnded(agent.unattended_plan))
  const archivedPlanAgents = planAgents.filter(agent => isUnattendedPlanEnded(agent.unattended_plan))
  const visibleTemplates = view === 'current' ? currentTemplates : archivedTemplates
  const visiblePlanAgents = view === 'current' ? currentPlanAgents : archivedPlanAgents
  const currentCount = currentTemplates.length + currentPlanAgents.length
  const archiveCount = archivedTemplates.length + archivedPlanAgents.length

  if (templates.length === 0 && planAgents.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-2xl border border-border/70 bg-card py-16 text-center shadow-xs">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted/40">
          <CalendarClock className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="mt-3 text-[14px] font-semibold text-foreground">暂无定期任务</div>
        <p className="mt-1 max-w-[320px] text-[13px] leading-5 text-muted-foreground">
          新建多 Agent 无人值守计划或设备本地计划后，会集中显示在这里。
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">计划生命周期</h3>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            当前计划只显示启用和暂停项；结束、取消或删除的计划进入归档，运行历史继续保留。
          </p>
        </div>
        <div className="inline-flex self-start rounded-lg bg-muted/60 p-1" role="tablist" aria-label="计划范围">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'current'}
            onClick={() => setView('current')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${view === 'current' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            当前计划 <span className="ml-1 tabular-nums">{currentCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'archive'}
            onClick={() => setView('archive')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${view === 'archive' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            计划归档 <span className="ml-1 tabular-nums">{archiveCount}</span>
          </button>
        </div>
      </div>

      {visibleTemplates.length > 0 && (
        <section>
          <SectionHeader icon={view === 'archive' ? Archive : Network} title="多 Agent 无人值守计划" count={visibleTemplates.length} />
          <div className="mt-3 space-y-3">
            {visibleTemplates.map(task => (
              <TemplateCard
                key={task.id}
                task={task}
                archived={view === 'archive'}
                writable={writable}
                busy={templateActionId === task.id}
                onOpenOrchestration={onOpenOrchestration}
                onArchive={onArchiveTemplate}
                onRestore={onRestoreTemplate}
                onCopy={onCopyTemplate}
              />
            ))}
          </div>
        </section>
      )}

      {visiblePlanAgents.length > 0 && (
        <section>
          <SectionHeader icon={Bot} title="设备本地无人值守计划" count={visiblePlanAgents.length} />
          <div className="mt-3 space-y-3">
            {visiblePlanAgents.map(agent => (
              <AgentPlanCard
                key={agent.id}
                agent={agent}
                archived={view === 'archive'}
                writable={writable}
                onEditPlan={onEditPlan}
                onDeletePlan={onDeletePlan}
                deleting={deletingAgentId === agent.id || pendingDeleteAgentIds.has(agent.id)}
              />
            ))}
          </div>
        </section>
      )}

      {visibleTemplates.length === 0 && visiblePlanAgents.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-12 text-center">
          {view === 'archive'
            ? <Archive className="mx-auto h-7 w-7 text-muted-foreground" />
            : <CalendarClock className="mx-auto h-7 w-7 text-muted-foreground" />}
          <div className="mt-3 text-sm font-semibold">
            {view === 'archive' ? '计划归档为空' : '当前没有启用或暂停的计划'}
          </div>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
            {view === 'archive' ? '结束、取消或删除的计划会自动进入这里。' : '新建计划或从归档恢复后会显示在这里。'}
          </p>
        </div>
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
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}

function PlatformChip({ platform }: { platform?: string }) {
  const label = PLATFORM_LABELS[platform || 'unknown'] || platform || '未识别'
  return <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{label}</span>
}

function templateScheduleChip(task: CloudTask): { label: string; className: string } {
  const scheduleStatus = String(task.metadata?.scheduleStatus || '')
  if (task.metadata?.scheduleArchivedAt) return { label: '已归档', className: 'bg-muted text-muted-foreground' }
  if (scheduleStatus === 'active') return { label: '计划已启用', className: 'bg-status-green/10 text-status-green' }
  if (scheduleStatus === 'paused') return { label: '计划已暂停', className: 'bg-muted text-muted-foreground' }
  if (scheduleStatus === 'completed') return { label: '计划已结束', className: 'bg-muted text-muted-foreground' }
  if (scheduleStatus === 'canceled') return { label: '计划已取消', className: 'bg-muted text-muted-foreground' }
  return { label: STATUS_LABELS[task.status] || task.status || '未知状态', className: 'bg-muted text-muted-foreground' }
}

function TemplateCard({
  task,
  archived,
  writable,
  busy,
  onOpenOrchestration,
  onArchive,
  onRestore,
  onCopy,
}: {
  task: CloudTask
  archived: boolean
  writable: boolean
  busy: boolean
  onOpenOrchestration: (task: CloudTask) => void
  onArchive: (task: CloudTask) => void
  onRestore: (task: CloudTask) => void
  onCopy: (task: CloudTask) => void
}) {
  const chip = templateScheduleChip(task)
  const workItemCount = safeNumber(task.counts?.total ?? task.progress?.total)
  const nextRunRaw = task.metadata?.nextRunAt
  const nextRun = formatTime(typeof nextRunRaw === 'string' ? nextRunRaw : null)
  const revision = safeNumber(task.orchestration_revision)

  return (
    <div className="rounded-2xl border border-l-2 border-border/70 border-l-primary/40 bg-card p-4 shadow-xs">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PlatformChip platform={task.platform} />
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip.className}`}>{chip.label}</span>
          </div>
          <h4 className="mt-1.5 truncate text-[14px] font-semibold text-foreground">{task.title || '未命名编排计划'}</h4>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenOrchestration(task)}>查看</Button>
          {archived && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onCopy(task)}>
              <Copy className="h-3.5 w-3.5" />复制新建
            </Button>
          )}
          {archived ? (
            <Button size="sm" disabled={!writable || busy} onClick={() => onRestore(task)}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              恢复为暂停
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={!writable || busy}
              onClick={() => onArchive(task)}
              className="text-status-red hover:bg-status-red/8 hover:text-status-red"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              删除计划
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-5 text-muted-foreground">
        <span>关键词工作项 <span className="tabular-nums text-foreground">{workItemCount}</span></span>
        <span>{archived ? '归档前排期' : '下次运行'} <span className="text-foreground">{archived ? '已停止' : nextRun}</span></span>
        <span>分配版本 <span className="tabular-nums text-foreground">v{revision}</span></span>
      </div>
      {archived && <p className="mt-2 text-[11px] leading-4 text-muted-foreground">历史批次、执行摘要和采集结果均保留；复制新建不会改变此归档计划。</p>}
    </div>
  )
}

function AgentPlanCard({
  agent,
  archived,
  writable,
  onEditPlan,
  onDeletePlan,
  deleting,
}: {
  agent: CloudAgent
  archived: boolean
  writable: boolean
  onEditPlan: (agent: CloudAgent) => void
  onDeletePlan: (agent: CloudAgent) => void
  deleting: boolean
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
  const customDates = unattendedPlanDates(plan)
  const ended = isUnattendedPlanEnded(plan)
  const canEditPlan = writable && agent.capabilities?.remoteUnattendedPlanWrite === true && !deleting
  const canDeletePlan = writable && agent.capabilities?.remoteUnattendedPlanDelete === true && !deleting
  const editBlockTitle = !writable
    ? '只读模式下无法编辑计划'
    : deleting
      ? '删除指令正在等待设备确认'
      : agent.capabilities?.remoteUnattendedPlanWrite === true
        ? undefined
        : '当前客户端扩展版本不支持云端无人值守计划，升级后可编辑'
  const deleteBlockTitle = !writable
    ? '只读模式下无法删除计划'
    : deleting
      ? '删除指令正在等待设备确认'
      : agent.capabilities?.remoteUnattendedPlanDelete === true
        ? undefined
        : '需要更新 Extension 后才能安全删除设备本地计划'
  const stateLabel = deleting ? '删除中' : ended ? '已结束' : plan.enabled ? '已启用' : '未启用'
  const stateClassName = deleting
    ? 'bg-primary/10 text-primary'
    : plan.enabled && !ended
      ? 'bg-status-green/10 text-status-green'
      : 'bg-muted text-muted-foreground'

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-[14px] font-semibold text-foreground">{agent.display_name || 'Agent'}</h4>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${stateClassName}`}>{stateLabel}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span title={editBlockTitle}>
            <Button variant="outline" size="sm" disabled={!canEditPlan} onClick={() => onEditPlan(agent)}>
              {archived ? '重新配置' : '编辑计划'}
            </Button>
          </span>
          {!archived && (
            <span title={deleteBlockTitle}>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canDeletePlan}
                onClick={() => onDeletePlan(agent)}
                className="text-status-red hover:bg-status-red/8 hover:text-status-red"
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {deleting ? '删除中' : '删除计划'}
              </Button>
            </span>
          )}
        </div>
      </div>
      <div className="mt-3 grid gap-x-5 gap-y-1 text-[12px] leading-5 text-muted-foreground sm:grid-cols-2">
        <div>平台 <span className="text-foreground">{platformLabel}</span></div>
        <div>执行 <span className="text-foreground">{ended ? `${mode} · 已结束` : plan.enabled ? `${mode}${plan.startTime ? ` · ${plan.startTime}` : ''}` : '当前不自动执行'}</span></div>
        {customDates.length > 0 && <div className="sm:col-span-2">运行日期 <span className="text-foreground">{customDates.join('、')}</span></div>}
        <div>下次运行 <span className="text-foreground">{ended ? '无后续排期' : formatTime(plan.nextRunAt)}</span></div>
        <div>上次运行 <span className="text-foreground">{formatTime(plan.lastRunAt)}{lastRunStatus ? ` · ${lastRunStatus}` : ''}</span></div>
      </div>
      {keywords.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="mb-1.5 text-[11px] text-muted-foreground">关键词（{keywordCount}）</div>
          <div className="flex flex-wrap gap-1.5">
            {keywords.map(keyword => <span key={keyword} className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">{keyword}</span>)}
          </div>
        </div>
      )}
    </div>
  )
}
