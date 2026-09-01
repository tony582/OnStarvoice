import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clock3,
  Database,
  RefreshCcw,
  SearchX,
  ShieldAlert,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type {
  CloudTask,
  TaskDiagnostics,
  TaskKeywordFailureKind,
  TaskKeywordResult,
} from './lib'
import {
  formatTime,
  taskDiagnostics,
  taskErrorText,
  taskKeywordFailureKind,
  taskPhaseLabel,
} from './lib'

const KEYWORD_STATUS_LABELS: Record<string, string> = {
  pending: '等待',
  assigned: '已分配',
  running: '进行中',
  retrying: '重试中',
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
  skipped: '跳过',
  canceled: '已停止',
}

function keywordStatusLabel(status: string) {
  return KEYWORD_STATUS_LABELS[status] || status || '未上报'
}

function keywordStatusDot(status: string) {
  if (status === 'completed') return 'bg-status-green'
  if (status === 'failed') return 'bg-status-red'
  if (status === 'partial' || status === 'retrying') return 'bg-status-orange'
  if (status === 'running') return 'bg-primary'
  return 'bg-muted-foreground/35'
}

function keywordStatusText(status: string) {
  if (status === 'completed') return 'text-status-green'
  if (status === 'failed') return 'text-status-red'
  if (status === 'partial' || status === 'retrying') return 'text-amber-700 dark:text-amber-300'
  if (status === 'running') return 'text-primary'
  return 'text-muted-foreground'
}

function failureKindLabel(kind: TaskKeywordFailureKind) {
  const labels: Record<TaskKeywordFailureKind, string> = {
    safety: '平台风控',
    search_unavailable: '搜索页未就绪',
    enhancement: '增强未完整',
    network: '网络异常',
    other: '其他异常',
  }
  return labels[kind]
}

function diagnosticTone(diagnostics: TaskDiagnostics) {
  if (diagnostics.tone === 'danger') {
    return {
      container: 'border-status-red/25 bg-status-red/[0.045]',
      icon: 'bg-status-red/10 text-status-red',
      title: 'text-status-red',
      Icon: ShieldAlert,
    }
  }
  if (diagnostics.tone === 'warning') {
    return {
      container: 'border-status-orange/30 bg-status-orange/[0.055]',
      icon: 'bg-status-orange/10 text-amber-700 dark:text-amber-300',
      title: 'text-amber-800 dark:text-amber-200',
      Icon: SearchX,
    }
  }
  if (diagnostics.tone === 'success') {
    return {
      container: 'border-status-green/25 bg-status-green/[0.045]',
      icon: 'bg-status-green/10 text-status-green',
      title: 'text-status-green',
      Icon: CheckCircle2,
    }
  }
  if (diagnostics.tone === 'active') {
    return {
      container: 'border-primary/25 bg-primary/[0.045]',
      icon: 'bg-primary/10 text-primary',
      title: 'text-primary',
      Icon: CircleDot,
    }
  }
  return {
    container: 'border-border/70 bg-muted/25',
    icon: 'bg-muted text-muted-foreground',
    title: 'text-foreground',
    Icon: AlertTriangle,
  }
}

function keywordResultCause(item: TaskKeywordResult) {
  if (item.status === 'completed' && item.resultKind === 'no_search_results') {
    return '无搜索结果（0 条正常结算）'
  }
  if (item.status === 'completed' && item.noResults) return '筛选范围内无匹配内容（0 条正常结算）'
  if (item.status === 'completed') return '完整完成'
  if (item.status === 'skipped') return item.error || '按规则跳过'
  if (item.status === 'running') return '设备正在处理'
  if (item.status === 'retrying') return item.error || '等待下一次尝试'
  if (!item.error) return failureKindLabel(taskKeywordFailureKind(item))
  return item.error
}

export function KeywordProgressSummary({
  task,
  diagnostics = taskDiagnostics(task),
}: {
  task: CloudTask
  diagnostics?: TaskDiagnostics
}) {
  if (diagnostics.items.length === 0) return null
  const currentLabel = diagnostics.currentKeyword
    ? `${diagnostics.currentOrdinal || diagnostics.processed}/${diagnostics.total} · ${diagnostics.currentKeyword}`
    : `${diagnostics.processed}/${diagnostics.total}`
  const latestResultByIndex = new Map<number, TaskKeywordResult>()
  diagnostics.items.forEach(item => latestResultByIndex.set(item.index, item))
  const resultSegments = Array.from(
    { length: diagnostics.total },
    (_, index) => latestResultByIndex.get(index) || null,
  )
  const positionLabel = diagnostics.safetyBlocked > 0
    ? '中断位置'
    : ['running', 'recovering', 'claimed'].includes(task.effective_status || task.status)
      ? '当前执行'
      : '最后执行'

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>关键词进度</span>
        <span>
          完成 <strong className="font-semibold text-status-green">{diagnostics.completed}</strong>
          {' · '}异常 <strong className={diagnostics.failed > 0 ? 'font-semibold text-status-red' : 'font-semibold text-foreground'}>{diagnostics.failed + diagnostics.partial}</strong>
          {' · '}保存 <strong className="font-semibold text-foreground">{diagnostics.saved}</strong>
        </span>
      </div>
      <div
        className="grid h-1.5 gap-0.5 overflow-hidden rounded-full"
        style={{ gridTemplateColumns: `repeat(${diagnostics.items.length}, minmax(0, 1fr))` }}
        role="img"
        aria-label={`关键词执行结果：完成 ${diagnostics.completed}，失败 ${diagnostics.failed}，部分完成 ${diagnostics.partial}`}
      >
        {resultSegments.map((item, index) => item ? (
          <span
            key={`${item.round}:${item.index}:${item.keyword}`}
            className={`${keywordStatusDot(item.status)} min-w-0 rounded-full`}
            title={`${item.index + 1}. ${item.keyword}：${keywordStatusLabel(item.status)}`}
          />
        ) : (
          <span
            key={`pending:${index}`}
            className="min-w-0 rounded-full bg-muted"
            title={`${index + 1}. 尚未上报`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {positionLabel}
          {'：'}<strong className="font-medium text-foreground">{currentLabel}</strong>
        </span>
        {diagnostics.retried > 0 && <span>累计重试 {diagnostics.retried} 次</span>}
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  icon,
}: {
  label: string
  value: string | number
  icon: ReactNode
}) {
  return (
    <div className="flex min-w-[7rem] items-center gap-2 border-l border-border/60 px-3 first:border-l-0 first:pl-0">
      <span className="text-muted-foreground">{icon}</span>
      <div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</div>
      </div>
    </div>
  )
}

export function TaskDiagnosticsPanel({
  task,
  diagnostics = taskDiagnostics(task),
}: {
  task: CloudTask
  diagnostics?: TaskDiagnostics
}) {
  const tone = diagnosticTone(diagnostics)
  const ToneIcon = tone.Icon
  const taskError = taskErrorText(task)
  const recentOperation = String(task.message || '').trim()

  return (
    <div className="mt-3 space-y-3">
      <section className={`rounded-xl border p-3.5 ${tone.container}`} aria-label="运行结论">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone.icon}`}>
            <ToneIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">运行结论</div>
            <p className={`mt-1 text-sm font-semibold leading-5 ${tone.title}`}>{diagnostics.headline}</p>
            {diagnostics.explanation && <p className="mt-1 text-xs leading-5 text-muted-foreground">{diagnostics.explanation}</p>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-y-3 border-t border-border/55 pt-3">
          <Metric label="关键词" value={`${diagnostics.processed}/${diagnostics.total}`} icon={<CircleDot className="h-3.5 w-3.5" />} />
          <Metric label="完整完成" value={diagnostics.completed} icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
          {diagnostics.noResults > 0 && <Metric label="无匹配内容" value={diagnostics.noResults} icon={<SearchX className="h-3.5 w-3.5" />} />}
          <Metric label="异常" value={diagnostics.failed + diagnostics.partial} icon={<AlertTriangle className="h-3.5 w-3.5" />} />
          <Metric label="保存结果" value={diagnostics.saved} icon={<Database className="h-3.5 w-3.5" />} />
          <Metric label="累计重试" value={diagnostics.retried} icon={<RefreshCcw className="h-3.5 w-3.5" />} />
        </div>
      </section>

      {diagnostics.items.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-border/70 bg-background/70" aria-label="关键词明细">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3.5 py-3">
            <div>
              <h5 className="text-xs font-semibold text-foreground">关键词明细</h5>
              <p className="mt-0.5 text-[11px] text-muted-foreground">按计划顺序记录每个词的结果、保存数、尝试次数与失败原因</p>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              {diagnostics.safetyBlocked > 0 && <span className="rounded-full bg-status-red/10 px-2 py-1 text-status-red">风控 {diagnostics.safetyBlocked}</span>}
              {diagnostics.searchUnavailable > 0 && <span className="rounded-full bg-status-orange/10 px-2 py-1 text-amber-700 dark:text-amber-300">搜索页未就绪 {diagnostics.searchUnavailable}</span>}
              {diagnostics.enhancementFailed > 0 && <span className="rounded-full bg-primary/8 px-2 py-1 text-primary">增强未完整 {diagnostics.enhancementFailed}</span>}
            </div>
          </div>
          <div className="hidden grid-cols-[2rem_minmax(8rem,0.8fr)_5rem_5rem_minmax(14rem,1.5fr)_6rem] gap-3 border-b border-border/60 bg-muted/25 px-3.5 py-2 text-[10px] font-medium text-muted-foreground lg:grid">
            <span>#</span>
            <span>关键词 / 状态</span>
            <span>保存</span>
            <span>尝试</span>
            <span>设备返回原因</span>
            <span>结束时间</span>
          </div>
          <div className="divide-y divide-border/60">
            {diagnostics.items.map(item => {
              const failureKind = taskKeywordFailureKind(item)
              return (
                <div
                  key={`${item.round}:${item.index}:${item.keyword}`}
                  className={`grid gap-x-3 gap-y-2 px-3.5 py-3 text-[11px] lg:grid-cols-[2rem_minmax(8rem,0.8fr)_5rem_5rem_minmax(14rem,1.5fr)_6rem] lg:items-center ${
                    failureKind === 'safety' ? 'bg-status-red/[0.035]' : ''
                  }`}
                >
                  <span className="hidden tabular-nums text-muted-foreground lg:block">{item.index + 1}</span>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`${keywordStatusDot(item.status)} h-2 w-2 shrink-0 rounded-full`} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">
                        <span className="mr-1 text-muted-foreground lg:hidden">{item.index + 1}.</span>{item.keyword}
                      </div>
                      <div className={`mt-0.5 text-[10px] font-medium ${keywordStatusText(item.status)}`}>{keywordStatusLabel(item.status)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="lg:hidden">保存</span>
                    <strong className="font-medium tabular-nums text-foreground">{item.savedCount}</strong>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="lg:hidden">尝试</span>
                    <strong className="font-medium tabular-nums text-foreground">{item.attemptCount || '—'}</strong>
                    {item.attemptCount > 1 && <span className="text-[10px]">次</span>}
                  </div>
                  <div className="min-w-0 leading-5 text-muted-foreground">
                    {item.status === 'failed' && <span className={`mr-1.5 rounded px-1.5 py-0.5 text-[9px] font-medium ${
                      failureKind === 'safety'
                        ? 'bg-status-red/10 text-status-red'
                        : failureKind === 'enhancement'
                          ? 'bg-primary/8 text-primary'
                          : 'bg-status-orange/10 text-amber-700 dark:text-amber-300'
                    }`}>{failureKindLabel(failureKind)}</span>}
                    <span className={item.status === 'failed' ? 'text-foreground' : ''}>{keywordResultCause(item)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                    <Clock3 className="h-3 w-3 lg:hidden" />
                    {formatTime(item.finishedAt)}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="grid gap-x-6 gap-y-2 rounded-xl bg-muted/35 p-3 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-3" aria-label="运行时间与设备状态">
        <div>设备状态：<span className={task.agent_online ? 'text-status-green' : 'text-status-red'}>{task.agent_online ? '在线' : '离线'}</span></div>
        <div>设备心跳：<span className="text-foreground">{formatTime(task.agent_last_heartbeat_at)}</span></div>
        <div>任务心跳：<span className="text-foreground">{formatTime(task.heartbeat_at)}</span></div>
        <div>业务进展：<span className="text-foreground">{formatTime(task.business_progress_at)}</span></div>
        <div>最后更新：<span className="text-foreground">{formatTime(task.updated_at)}</span></div>
        {task.attempt_number ? <div>执行批次：<span className="text-foreground">第 {task.attempt_number} 次</span></div> : null}
        {diagnostics.currentKeyword && (
          <div className="sm:col-span-2 lg:col-span-3">
            最后位置：<span className="text-foreground">{diagnostics.currentOrdinal}/{diagnostics.total} · {diagnostics.currentKeyword} · {taskPhaseLabel(diagnostics.currentPhase)}</span>
          </div>
        )}
        {recentOperation && recentOperation !== diagnostics.headline && (
          <div className="sm:col-span-2 lg:col-span-3">
            最近操作：<span className="text-foreground">{recentOperation}</span>
          </div>
        )}
        {taskError && taskError !== recentOperation && (
          <div className="text-status-red sm:col-span-2 lg:col-span-3">任务错误：{taskError}</div>
        )}
      </section>
    </div>
  )
}
