import { useState } from 'react'
import {
  Archive, Bot, ChevronDown, ChevronUp, Loader2, MessagesSquare, Network, Play, ShieldAlert, Square,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KeywordProgressSummary, TaskDiagnosticsPanel } from './TaskDiagnostics'
import type { CloudTask } from './lib'
import {
  PLATFORM_LABELS,
  STATUS_LABELS,
  canDismissAttention,
  canResume,
  canStop,
  formatTime,
  isPlatformSafetyAttention,
  platformSafetyReason,
  resumeBlockReason,
  safeNumber,
  statusTone,
  taskDiagnostics,
  taskErrorText,
  taskProgress,
} from './lib'

export function TaskCard({
  task,
  writable,
  actionTaskId,
  onResume,
  onStop,
  onDismissAttention,
  onOpenOrchestration,
}: {
  task: CloudTask
  writable: boolean
  actionTaskId: string
  onResume: (task: CloudTask) => Promise<void>
  onStop: (task: CloudTask) => Promise<void>
  onDismissAttention: (task: CloudTask) => Promise<void>
  onOpenOrchestration: (task: CloudTask) => void
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const effectiveStatus = task.effective_status || task.status
  const progress = taskProgress(task)
  const diagnostics = taskDiagnostics(task)
  const orchestration = task.task_type === 'capture_orchestration'
  const negativePatrol = task.task_type === 'negative_post_patrol'
    || task.feature_key === 'negative_post_patrol'
    || task.feature_key === 'capture.negative_post_patrol'
  const negativePatrolFilter = negativePatrol
    && task.metadata?.filter
    && typeof task.metadata.filter === 'object'
    && !Array.isArray(task.metadata.filter)
    ? task.metadata.filter as Record<string, unknown>
    : {}
  const officialCommentPatrol = task.task_type === 'official_account_comment_patrol'
    || task.task_type === 'comment_patrol'
    || task.feature_key === 'official_account_comment_patrol'
    || task.feature_key === 'capture.official_account_comment_patrol'
  const officialCommentFilter = officialCommentPatrol
    && task.metadata?.filter
    && typeof task.metadata.filter === 'object'
    && !Array.isArray(task.metadata.filter)
    ? task.metadata.filter as Record<string, unknown>
    : task.metadata || {}
  const officialAccount = officialCommentPatrol
    && task.metadata?.officialAccount
    && typeof task.metadata.officialAccount === 'object'
    && !Array.isArray(task.metadata.officialAccount)
    ? task.metadata.officialAccount as Record<string, unknown>
    : {}
  const officialAccountName = String(
    officialAccount.accountName
    ?? officialCommentFilter.accountName
    ?? officialCommentFilter.officialAccountName
    ?? officialCommentFilter.account_name
    ?? task.metadata?.accountName
    ?? '',
  ).trim()
  const commentSamples = safeNumber(
    task.counts?.commentsSampled
    ?? task.counts?.comments_sampled
    ?? task.progress?.commentsSampled
    ?? task.progress?.comments_sampled,
  )
  const riskComments = safeNumber(
    task.counts?.riskComments
    ?? task.counts?.risk_comments
    ?? task.progress?.riskComments
    ?? task.progress?.risk_comments,
  )
  const hasKeywordDiagnostics = !orchestration && diagnostics.items.length > 0
  const resumable = !orchestration && canResume(task)
  const stoppable = !orchestration && canStop(task)
  const commandPending = Boolean(task.pending_command_id)
  const stopPending = task.pending_command_type === 'stop'
  const resumeBlocked = resumable ? resumeBlockReason(task) : ''
  const taskError = taskErrorText(task)
  const safetyAttention = !orchestration && isPlatformSafetyAttention(task)
  const safetyPosition = diagnostics.currentKeyword && diagnostics.currentOrdinal > 0
    ? `${diagnostics.currentOrdinal}/${Math.max(diagnostics.total, 1)}「${diagnostics.currentKeyword}」`
    : ''
  const dismissible = canDismissAttention(task)
  // 计划模板将从本列表移出，但保留其状态/文案分支，方便复用同一张卡渲染计划视图。
  const scheduleTemplate = orchestration && task.metadata?.orchestrationTemplate === true
  const scheduleRun = orchestration && task.metadata?.orchestrationScheduleRun === true
  const scheduleStatus = String(task.metadata?.scheduleStatus || '')
  const displayedStatus = scheduleTemplate && scheduleStatus === 'active'
    ? '计划已启用'
    : scheduleTemplate && scheduleStatus === 'paused'
      ? '计划已暂停'
      : STATUS_LABELS[effectiveStatus] || effectiveStatus
  const displayedStatusTone = scheduleTemplate && scheduleStatus === 'active'
    ? 'border-status-green/25 bg-status-green/8 text-status-green'
    : statusTone(effectiveStatus)
  const taskMode = scheduleTemplate
    ? '多 Agent 无人值守'
    : scheduleRun
      ? '计划运行批次'
      : orchestration && negativePatrol
        ? '多 Agent 负面巡查'
      : orchestration
        ? '多 Agent 编排'
        : officialCommentPatrol
          ? '官方账号评论巡查'
          : negativePatrol
          ? '负面帖子巡查'
        : task.source === 'cloud' && task.task_type.includes('plan')
          ? '自动计划'
          : task.source === 'cloud'
            ? '一次性任务'
            : '设备任务'

  const hasActions = orchestration || resumable || stoppable || commandPending || dismissible

  return (
    <article className={`rounded-2xl border border-border/70 bg-card p-4 shadow-xs ${orchestration ? 'border-l-2 border-l-primary/40' : ''}`}>
      {/* 第一行：类型图标 + 标题 + 状态 chip（右对齐） */}
      <div className="flex min-w-0 items-center gap-2">
        {negativePatrol
          ? <ShieldAlert className="h-4 w-4 shrink-0 text-status-red" />
          : orchestration
            ? <Network className="h-4 w-4 shrink-0 text-primary" />
          : officialCommentPatrol
            ? <MessagesSquare className="h-4 w-4 shrink-0 text-primary" />
          : <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <h4 className="min-w-0 flex-1 truncate text-[15px] font-bold">{task.title || '采集任务'}</h4>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${displayedStatusTone}`}>{displayedStatus}</span>
      </div>
      {/* 第二行：一条 meta 线（平台 · 形态 · Agent/关键词数 · 创建时间） */}
      <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {PLATFORM_LABELS[task.platform] || task.platform}
          {' · '}{taskMode}{' · '}
          {orchestration
            ? negativePatrol
              ? `${safeNumber(task.counts?.total ?? task.progress?.total)} 条帖子`
              : `${safeNumber(task.counts?.total ?? task.progress?.total)} 个关键词`
            : `${task.agent_host_label || '未分配设备'} › ${task.agent_display_name || '未分配 Agent'}`}
        </span>
        {!orchestration && (
          <span className={`shrink-0 ${task.agent_online ? 'text-status-green' : ''}`}>· {task.agent_online ? '在线' : '离线'}</span>
        )}
        <span className="shrink-0">· {formatTime(task.created_at || task.updated_at)}</span>
      </div>
      {!safetyAttention && (hasKeywordDiagnostics ? diagnostics.headline : task.message) && (
        <p className={`mt-2 line-clamp-1 text-xs leading-5 ${
          hasKeywordDiagnostics && diagnostics.tone === 'danger'
            ? 'text-status-red'
            : hasKeywordDiagnostics && diagnostics.tone === 'warning'
              ? 'text-amber-700 dark:text-amber-300'
              : 'text-muted-foreground'
        }`}>
          {hasKeywordDiagnostics ? diagnostics.headline : task.message}
        </p>
      )}
      {!safetyAttention && !hasKeywordDiagnostics && taskError && taskError !== task.message && <p role="alert" className="mt-2 line-clamp-1 text-xs leading-5 text-status-red">{taskError}</p>}
      {hasKeywordDiagnostics ? (
        <KeywordProgressSummary task={task} diagnostics={diagnostics} />
      ) : progress.total > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground"><span>总体进度</span><span>{progress.current}/{progress.total} · {progress.percent}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="任务总体进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} /></div>
        </div>
      )}
      {safetyAttention && (
        <div role="alert" className="mt-3 rounded-xl border border-status-red/25 bg-status-red/[0.045] p-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-status-red/10 text-status-red">
              <ShieldAlert className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-status-red">需要在原 Agent 人工处理</p>
              <p className="mt-1 text-xs leading-5 text-foreground">
                {platformSafetyReason(task)}
                {safetyPosition ? `，任务停在 ${safetyPosition}` : ''}
                。请先在 <strong>{task.agent_display_name || '原 Agent'}</strong> 完成验证；此前结果已保留。
              </p>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                验证完成后继续剩余关键词；若不再执行，可结束任务并保留现有结果。
              </p>
            </div>
          </div>
        </div>
      )}
      {/* 底部：左侧运行详情开关；右侧操作按钮（主操作实心、次操作 outline/ghost，最多 3 个） */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <button type="button" onClick={() => setDetailsOpen(value => !value)} aria-expanded={detailsOpen}
          className="flex min-h-9 items-center gap-1.5 rounded-lg text-left text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
          <span>{hasKeywordDiagnostics ? '运行报告' : '运行详情'}</span>
          {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {hasActions && (
          <div className="flex flex-wrap justify-end gap-2">
            {orchestration && (
              <Button size="sm" onClick={() => onOpenOrchestration(task)}>
                <Network className="h-4 w-4" /> 查看编排
              </Button>
            )}
            {resumable && !commandPending && (
              <Button size="sm" onClick={() => void onResume(task)} disabled={!writable || Boolean(resumeBlocked) || actionTaskId === task.id}>
                {actionTaskId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {resumeBlocked
                  ? diagnostics.retryExhausted
                    ? '失败词已达上限'
                    : '暂时不能继续'
                  : safetyAttention && task.agent_online
                    ? '验证完成，原设备继续'
                    : safetyAttention
                      ? '原设备上线后继续'
                  : task.agent_online
                    ? '继续剩余任务'
                    : '上线后继续'}
              </Button>
            )}
            {stoppable && !stopPending && (
              <Button variant="outline" size="sm" onClick={() => void onStop(task)} disabled={!writable || actionTaskId === task.id}>
                {actionTaskId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
                {safetyAttention
                  ? task.agent_online
                    ? '结束并保留结果'
                    : '上线后结束并保留'
                  : task.agent_online
                    ? '停止任务'
                    : '上线后停止'}
              </Button>
            )}
            {stopPending && (
              <Button variant="outline" size="sm" disabled>
                <Loader2 className="h-4 w-4 animate-spin" />
                {safetyAttention
                  ? task.agent_online
                    ? '等待设备结束并保留'
                    : '已排队，上线后结束'
                  : task.agent_online
                    ? '等待设备停止'
                    : '已排队，上线后停止'}
              </Button>
            )}
            {commandPending && !stoppable && !stopPending && <Button size="sm" disabled><Loader2 className="h-4 w-4 animate-spin" />等待设备响应</Button>}
            {dismissible && (
              <Button variant="ghost" size="sm" onClick={() => void onDismissAttention(task)} disabled={!writable || actionTaskId === task.id}>
                {actionTaskId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                移到历史
              </Button>
            )}
          </div>
        )}
      </div>
      {detailsOpen && (
        hasKeywordDiagnostics ? (
          <TaskDiagnosticsPanel task={task} diagnostics={diagnostics} />
        ) : (
          <div className="mt-2 grid gap-2 rounded-xl bg-muted/45 p-3 text-[11px] text-muted-foreground sm:grid-cols-2">
            {negativePatrol ? (
            <>
              <div>巡查帖子：<span className="text-foreground">{safeNumber(task.counts?.total ?? task.progress?.total)} 条</span></div>
              <div>已处理：<span className="text-foreground">{safeNumber(task.counts?.processed ?? task.progress?.current)} 条</span></div>
              {orchestration && (
                <div>执行节点：<span className="text-foreground">
                  {Array.isArray(task.metadata?.selectedAgentIds)
                    ? task.metadata.selectedAgentIds.length
                    : safeNumber(task.counts?.agents)} 个 Agent
                </span></div>
              )}
              <div>发布时间：<span className="text-foreground">{String(negativePatrolFilter.publishDateFrom || '—')} 至 {String(negativePatrolFilter.publishDateTo || '—')}</span></div>
              <div>筛选情绪：<span className="text-foreground">负面</span></div>
              <div>最后更新：<span className="text-foreground">{formatTime(task.updated_at)}</span></div>
            </>
            ) : orchestration ? (
            <>
              <div>关键词工作项：<span className="text-foreground">{safeNumber(task.counts?.total ?? task.progress?.total)} 项</span></div>
              <div>已结算：<span className="text-foreground">{safeNumber(task.progress?.current)} 项</span></div>
              <div>分配版本：<span className="text-foreground">第 {task.orchestration_revision || 0} 版</span></div>
              {scheduleTemplate && <div>下次运行：<span className="text-foreground">{formatTime(String(task.metadata?.nextRunAt || ''))}</span></div>}
              <div>最后更新：<span className="text-foreground">{formatTime(task.updated_at)}</span></div>
            </>
            ) : (
            <>
              {officialCommentPatrol && (
                <>
                  <div>官方账号：<span className="text-foreground">{officialAccountName || '—'}</span></div>
                  <div>巡查作品：<span className="text-foreground">{safeNumber(task.counts?.total ?? task.progress?.total)} 篇</span></div>
                  <div>发布时间：<span className="text-foreground">{String(officialCommentFilter.publishDateFrom || '—')} 至 {String(officialCommentFilter.publishDateTo || '—')}</span></div>
                  <div>评论样本：<span className="text-foreground">本次读取 {commentSamples} 条{riskComments > 0 ? ` · 风险 ${riskComments} 条` : ''}</span></div>
                </>
              )}
              <div>设备心跳：<span className="text-foreground">{formatTime(task.agent_last_heartbeat_at)}</span></div>
              <div>任务心跳：<span className="text-foreground">{formatTime(task.heartbeat_at)}</span></div>
              <div>业务进展：<span className="text-foreground">{formatTime(task.business_progress_at)}</span></div>
              <div>最后更新：<span className="text-foreground">{formatTime(task.updated_at)}</span></div>
              {task.attempt_number ? <div>执行次数：<span className="text-foreground">第 {task.attempt_number} 次</span></div> : null}
              {commandPending && task.pending_command_expires_at ? <div>指令保留至：<span className="text-foreground">{formatTime(task.pending_command_expires_at)}</span></div> : null}
              {resumeBlocked && !commandPending ? <div className="text-status-red sm:col-span-2">继续阻断：{resumeBlocked}</div> : null}
            </>
            )}
          </div>
        )
      )}
    </article>
  )
}
