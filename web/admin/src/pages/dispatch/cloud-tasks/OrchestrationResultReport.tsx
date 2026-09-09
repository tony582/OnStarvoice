import { AlertTriangle, Bot } from 'lucide-react'
import type { OrchestrationAttemptRecord, OrchestrationCloudAgent, OrchestrationExecutionRecord, OrchestrationItemRecord } from './types'
import { PLATFORM_LABELS, STATUS_LABELS, formatTime } from './lib'
import { TaskResultRecordButton, TaskResultSyncSummary, TaskResultTimes } from './TaskResultSections'
import { historicalItemStatus, orchestrationCurrentExecution, orchestrationResultEvidence, resultCount, resultMessage, resultObject } from './task-result-presentation.mjs'

type Props = {
  items: OrchestrationItemRecord[]
  executions: OrchestrationExecutionRecord[]
  agents: OrchestrationCloudAgent[]
  attempts: OrchestrationAttemptRecord[]
  expectedSearchPasses: number
}

function executionId(execution: OrchestrationExecutionRecord) { return String(execution.taskId || execution.task_id || execution.id || '') }
function itemLabel(item: OrchestrationItemRecord) {
  return String(resultObject(item.metadata?.sourceRecord).title || item.keyword || item.metadata?.keyword || item.item_key || '未记录内容标题')
}
function itemType(item: OrchestrationItemRecord) {
  return item.item_type === 'negative_post' ? '负面巡查' : item.item_type === 'watched_content' ? '关注内容复查' : item.item_type === 'keyword' ? '关键词采集' : '内容处理'
}
function unfinishedEvidence(item: OrchestrationItemRecord, execution: OrchestrationExecutionRecord | undefined, expected: number) {
  if (!execution) return []
  const reasons = []
  const evidence = orchestrationResultEvidence(item, execution, expected)
  if (evidence.childIncomplete) reasons.push(`本次执行${STATUS_LABELS[String(execution.status)] || execution.status}`)
  if (evidence.failedStepCount > 0) reasons.push(`${evidence.failedStepCount} 个步骤未完整完成`)
  if (evidence.missingCompletedSteps && evidence.failedStepCount === 0) reasons.push(`${expected} 个计划步骤中，仅 ${evidence.completedStepCount} 个有完成记录`)
  if (evidence.syncNeedsReview) reasons.push('末次同步有待核对')
  return reasons
}

export function OrchestrationResultReport({ items, executions, agents, attempts, expectedSearchPasses }: Props) {
  const agentsById = new Map(agents.map(agent => [agent.id, agent]))
  const executionFor = (item: OrchestrationItemRecord) => orchestrationCurrentExecution(item, executions)
  const currentExecutionIds = new Set(items.map(item => executionFor(item)).filter(Boolean).map(execution => executionId(execution!)))
  const findings = items.flatMap(item => {
    const reasons = unfinishedEvidence(item, executionFor(item), expectedSearchPasses)
    return reasons.length ? [{item, reasons}] : []
  })
  return <div className="mt-4 space-y-4">
    {findings.length > 0 && <section className="rounded-xl border border-status-orange/30 bg-status-orange/5 p-4" aria-label="结果核对提醒">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" />仍有 {findings.length} 个工作项需要核对结果</h3>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">请查看以下未完整完成的步骤和待核对的同步结果；已恢复的问题保留在历次尝试中。</p>
      <ul className="mt-2 space-y-1 text-xs leading-5">{findings.map(({item, reasons}) => <li key={item.id}><strong>{itemLabel(item)}</strong>：{reasons.join('；')}</li>)}</ul>
    </section>}
    <section className="overflow-hidden rounded-xl border border-border/70">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 p-4"><h3 className="text-sm font-semibold">完整工作项结果</h3><span className="text-xs text-muted-foreground">共 {items.length} 项</span></div>
      {items.length === 0 ? <p className="p-4 text-xs text-muted-foreground">此任务没有保留工作项明细。</p> : <div className="divide-y divide-border/60">{items.map((item, index) => {
        const execution = executionFor(item)
        const source = item as OrchestrationItemRecord & {record_id?: string; result_record_id?: string}
        const agent = agentsById.get(String(item.assigned_agent_id || execution?.agentId || execution?.agent_id || execution?.assigned_agent_id || ''))
        const history = attempts.filter(attempt => String(attempt.itemId || attempt.item_id || '') === item.id)
        const steps = orchestrationResultEvidence(item, execution, expectedSearchPasses).steps
        const checkpoint = resultObject(item.metadata?.checkpoint)
        const issues = unfinishedEvidence(item, execution, expectedSearchPasses)
        const error = resultMessage(item.error)
        return <article key={item.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><span className="text-[10px] text-muted-foreground">{index + 1} · {itemType(item)} · {PLATFORM_LABELS[item.platform] || item.platform}</span><h4 className="mt-1 break-words text-sm font-semibold">{itemLabel(item)}</h4></div><span className="rounded-md bg-muted px-2 py-1 text-[11px]">{historicalItemStatus(item.status) || STATUS_LABELS[item.status] || item.status}</span></div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground"><span>执行节点：{agent?.display_name || execution?.agent_display_name || '未保留名称'}</span><span>开始：{formatTime(item.started_at)}</span><span>结束：{formatTime(item.finished_at)}</span><span>尝试：{item.attempt_count ?? history.length} 次</span>{resultCount(checkpoint.savedCount) !== null && <span>设备报告保存：{resultCount(checkpoint.savedCount)}</span>}</div>
          {error && <p className="mt-2 text-xs leading-5 text-status-red">{error}</p>}
          {issues.length > 0 && <p className="mt-2 text-xs leading-5 text-amber-800">结果核对：{issues.join('；')}</p>}
          <TaskResultRecordButton recordId={source.result_record_id || source.record_id} />
          {(steps.length > 0 || history.length > 0) && <details className="mt-2 rounded-lg bg-muted/25 p-3" open={issues.length > 0}><summary className="cursor-pointer text-xs text-primary">步骤与历次尝试</summary>
            {steps.length > 0 && <div className="mt-2 space-y-2">{steps.map((step, stepIndex) => <p key={stepIndex} className="text-[11px] leading-5">第 {String(step.round || stepIndex + 1)} 步 · {STATUS_LABELS[String(step.status)] || String(step.status || '未记录')} · 设备报告保存 {resultCount(step.savedCount) ?? '未记录'} · {formatTime(String(step.finishedAt || ''))}{resultMessage(step.error) ? ` · ${resultMessage(step.error)}` : ''}</p>)}</div>}
            {history.length > 0 && <ol className="mt-3 space-y-2 border-t border-border/60 pt-2">{history.map((attempt, attemptIndex) => <li key={attempt.id || attemptIndex} className="text-[11px] leading-5">尝试 {attempt.attempt_number || attemptIndex + 1} · {attempt.agent_display_name || attempt.agentDisplayName || '节点名称未记录'} · {STATUS_LABELS[String(attempt.status)] || attempt.status}{resultMessage(attempt.error) ? ` · ${resultMessage(attempt.error)}` : ''}</li>)}</ol>}
          </details>}
        </article>
      })}</div>}
    </section>
    <section className="overflow-hidden rounded-xl border border-border/70">
      <h3 className="flex items-center gap-2 border-b border-border/70 p-4 text-sm font-semibold"><Bot className="h-4 w-4 text-primary" />节点执行与同步记录</h3>
      {executions.length === 0 ? <p className="p-4 text-xs text-muted-foreground">未保留节点执行记录。</p> : <div className="divide-y divide-border/60">{executions.map((execution, index) => {
        const current = currentExecutionIds.has(executionId(execution))
        const agent = agentsById.get(String(execution.agentId || execution.agent_id || execution.assigned_agent_id || ''))
        const error = resultMessage(execution.error)
        return <details key={executionId(execution) || index} className="p-4"><summary className="cursor-pointer text-xs"><strong>{agent?.display_name || execution.agent_display_name || `执行记录 ${index + 1}`}</strong><span className="ml-2 text-muted-foreground">{current ? '最后执行' : '历史尝试'} · {STATUS_LABELS[String(execution.status)] || execution.status || '状态未记录'}{(execution.keywords || []).length ? ` · ${execution.keywords!.join('、')}` : ''}</span></summary>
          <div className="mt-3 space-y-3"><TaskResultTimes createdAt={execution.created_at} startedAt={typeof execution.started_at === 'string' ? execution.started_at : null} finishedAt={typeof execution.finished_at === 'string' ? execution.finished_at : null} />{error && <p className="text-xs leading-5 text-status-red">{error}</p>}<TaskResultSyncSummary progress={execution.progress} /></div>
        </details>
      })}</div>}
    </section>
  </div>
}
