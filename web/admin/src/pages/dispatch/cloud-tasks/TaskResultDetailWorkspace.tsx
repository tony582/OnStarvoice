import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ClipboardList, Loader2, RefreshCw, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { CloudTask } from './lib'
import { PLATFORM_LABELS, STATUS_LABELS, formatTime, statusTone, taskDiagnostics, taskErrorText } from './lib'
import { TaskResultRecordButton, TaskResultSyncSummary, TaskResultTimes } from './TaskResultSections'
import { historicalItemStatus, resultCount, resultMessage, resultObject, taskResultKind } from './task-result-presentation.mjs'

type ResultSummary = {
  observationCount: number
  recordCount: number
  firstCapturedAt: string | null
  lastCapturedAt: string | null
  evidence: 'linked_record_observations'
  scope: 'task_tree'
}

type DetailResponse = { ok: boolean; task: CloudTask; resultSummary?: ResultSummary }
type TaskEvent = { id: string; event_type: string; status?: string; message?: string; created_at?: string; actor_name?: string }
type ResultRecord = { id: string; title?: string; platform?: string; keyword?: string; created_at?: string; latestCapturedAt?: string; observationCount?: number }
type ResultRecordsResponse = { records: ResultRecord[]; total: number; page: number; pageSize: number }

export type TaskResultDetailWorkspaceProps = {
  taskId: string | null
  initialTask?: CloudTask | null
  onClose?: () => void
  className?: string
  refreshKey?: string | number
}

const REPORTED_METRICS = [
  ['total', '工作项'], ['processed', '已处理'], ['success', '成功'], ['failed', '失败'],
  ['skipped', '跳过'], ['saved', '设备报告保存'], ['commentsSampled', '评论样本'],
  ['riskComments', '风险评论'], ['newPosts', '发现作品'], ['creatorsScanned', '扫描博主'],
] as const

export function TaskResultDetailWorkspace({ taskId, initialTask, onClose, className, refreshKey }: TaskResultDetailWorkspaceProps) {
  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [eventsError, setEventsError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resultRefresh, setResultRefresh] = useState(0)
  const generation = useRef(0)
  const load = useCallback(async () => {
    if (!taskId) return
    const request = ++generation.current
    setLoading(true)
    setError('')
    const [taskResponse, eventResponse] = await Promise.allSettled([
      api.get<DetailResponse>(`/capture-cloud/tasks/${encodeURIComponent(taskId)}`),
      api.get<{events: TaskEvent[]}>(`/capture-cloud/tasks/${encodeURIComponent(taskId)}/events`),
    ])
    if (request !== generation.current) return
    if (taskResponse.status === 'fulfilled') { setDetail(taskResponse.value); setResultRefresh(value => value + 1) }
    else setError(taskResponse.reason instanceof Error ? taskResponse.reason.message : '读取任务结果失败')
    if (eventResponse.status === 'fulfilled') { setEvents(eventResponse.value.events || []); setEventsError('') }
    else setEventsError('执行记录暂时读取失败，可以刷新重试。')
    setLoading(false)
  }, [taskId])

  useEffect(() => {
    // Changing the selected task replaces the whole persisted result view.
    let active = true
    queueMicrotask(() => { if (active) { setDetail(null); setEvents([]); setEventsError(''); void load() } })
    return () => { active = false; generation.current += 1 }
  }, [load, refreshKey])

  const task = detail?.task?.id === taskId ? detail.task : initialTask?.id === taskId ? initialTask : null
  if (!taskId) return null
  if (!task && loading) return <div className="flex min-h-72 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="正在读取任务结果" /></div>
  if (!task) return <section className="rounded-2xl border border-status-red/25 bg-card p-5">
    <h2 id="task-result-detail-title" className="font-semibold">无法读取任务结果</h2>
    <p role="alert" className="mt-2 text-sm text-status-red">{error || '任务不存在或当前账号无权查看。'}</p>
    <Button variant="outline" className="mt-3" onClick={() => void load()}>重试</Button>
    {onClose && <Button variant="ghost" onClick={onClose}>关闭</Button>}
  </section>

  const diagnostics = taskDiagnostics(task)
  const taskError = taskErrorText(task)
  const checkpoint = resultObject(task.checkpoint)
  const metadata = resultObject(task.metadata)
  const targetResults = [checkpoint.targetResults, metadata.targetResults, task.progress?.targetResults, checkpoint.results]
    .find(Array.isArray) as unknown[] | undefined
  const targets = targetResults || (Array.isArray(metadata.targets) ? metadata.targets : [])
  const reportedMetrics = REPORTED_METRICS.filter(([key]) => resultCount(task.counts?.[key]) !== null)
  const status = task.status || task.effective_status || ''
  return <section className={cn('overflow-hidden rounded-[22px] border border-border/70 bg-card', className)}>
    <header className="border-b border-border/70 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={`rounded-full border px-2.5 py-1 font-semibold ${statusTone(status)}`}>{STATUS_LABELS[status] || status || '状态未记录'}</span>
            <span className="text-muted-foreground">{PLATFORM_LABELS[task.platform] || task.platform} · {taskResultKind(task)}</span>
          </div>
          <h2 id="task-result-detail-title" className="mt-2 break-words text-lg font-bold">{task.title || '任务结果'}</h2>
          <p className="mt-1 text-xs text-muted-foreground">保留本次任务的执行结果、内容与异常记录。</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading} aria-label="刷新任务结果"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
        {onClose && <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭任务结果" data-dialog-initial-focus><X className="h-4 w-4" /></Button>}
      </div>
    </header>
    <div className="space-y-4 p-4 sm:p-5">
      {error && <p role="alert" className="rounded-xl border border-status-red/25 p-3 text-xs text-status-red">{error} 当前显示已读取的任务记录。</p>}
      <section className="rounded-xl bg-muted/30 p-4"><TaskResultTimes createdAt={task.created_at} startedAt={task.started_at} finishedAt={task.finished_at} /></section>
      <section className="rounded-xl border border-border/70 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><ClipboardList className="h-4 w-4 text-primary" />完成情况</h3>
        {task.message && <p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{task.message}</p>}
        {taskError && <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-status-red"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{taskError}</p>}
        {reportedMetrics.length > 0 && <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{reportedMetrics.map(([key, label]) => <div key={key}><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{resultCount(task.counts?.[key])}</dd></div>)}</dl>}
        {resultCount(task.counts?.saved) !== null && <p className="mt-3 text-[11px] text-muted-foreground">“设备报告保存”保留设备原始统计；实际关联内容见下方入库结果。</p>}
        <p className="mt-3 text-[11px] text-muted-foreground">执行节点：{[task.agent_host_label, task.agent_display_name].filter(Boolean).join(' · ') || '未保留节点名称'}</p>
      </section>
      <TaskResultSyncSummary progress={task.progress} />
      {diagnostics.items.length > 0 && <section className="overflow-hidden rounded-xl border border-border/70">
        <h3 className="border-b border-border/70 px-4 py-3 text-sm font-semibold">关键词与步骤结果</h3>
        <div className="divide-y divide-border/60">{diagnostics.items.map((item, index) => <article key={`${item.round}:${item.index}:${index}`} className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-semibold">{item.keyword} <span className="font-normal text-muted-foreground">· 第 {item.round} 步</span></h4><span className="text-[11px] text-muted-foreground">{historicalItemStatus(item.status) || STATUS_LABELS[item.status] || (item.status === 'partial' ? '部分完成' : item.status)}</span></div>
          <p className="mt-2 text-[11px] text-muted-foreground">设备报告保存 {item.savedCount} · 尝试 {item.attemptCount || '未记录'} · 结束 {formatTime(item.finishedAt)}</p>
          {item.error && <p className="mt-2 break-words text-xs leading-5 text-status-red">{item.error}</p>}
          {item.noResults && <p className="mt-2 text-xs text-muted-foreground">本步骤未发现匹配内容。</p>}
        </article>)}</div>
      </section>}
      {targets.length > 0 && <section className="overflow-hidden rounded-xl border border-border/70">
        <h3 className="border-b border-border/70 px-4 py-3 text-sm font-semibold">巡查与处理结果</h3>
        <div className="divide-y divide-border/60">{targets.map((raw, index) => {
          const target = resultObject(raw)
          const title = String(target.title || resultObject(target.sourceRecord).title || target.keyword || target.externalId || target.external_id || `内容 ${index + 1}`)
          const recordId = String(target.recordId || target.record_id || target.resultRecordId || '')
          const targetStatus = String(target.status || '')
          const targetError = resultMessage(target.error) || resultMessage(target.reason)
          return <article key={`${recordId}:${index}`} className="p-4"><div className="flex flex-wrap items-start justify-between gap-2"><h4 className="min-w-0 flex-1 break-words text-xs font-semibold">{title}</h4><span className="text-[11px] text-muted-foreground">{historicalItemStatus(targetStatus) || STATUS_LABELS[targetStatus] || targetStatus || '未保留逐条结论'}</span></div>{targetError && <p className="mt-2 text-xs leading-5 text-status-red">{targetError}</p>}<TaskResultRecordButton recordId={recordId} /></article>
        })}</div>
      </section>}
      <TaskResultRecords key={taskId} taskId={taskId} summary={detail?.task.id === taskId ? detail.resultSummary : undefined} refreshKey={`${refreshKey ?? ''}:${resultRefresh}`} />
      <section className="overflow-hidden rounded-xl border border-border/70">
        <h3 className="border-b border-border/70 px-4 py-3 text-sm font-semibold">执行与异常记录</h3>
        {eventsError && <p role="alert" className="p-4 text-xs text-status-red">{eventsError}</p>}
        {events.length === 0 && !eventsError ? <p className="p-4 text-xs text-muted-foreground">未保留执行事件。</p> : <details className="p-4"><summary className="cursor-pointer text-xs text-primary">展开 {events.length} 条记录{events.length >= 200 ? '（最近 200 条）' : ''}</summary><ol className="mt-3 space-y-3">{events.map(event => <li key={event.id} className="border-l-2 border-border pl-3 text-xs"><div className="text-[11px] text-muted-foreground">{formatTime(event.created_at)}{event.status ? ` · ${STATUS_LABELS[event.status] || event.status}` : ''}</div><p className="mt-1 break-words leading-5">{event.message || '任务状态已更新'}</p></li>)}</ol></details>}
      </section>
    </div>
  </section>
}

export function TaskResultRecords({ taskId, summary, refreshKey }: { taskId: string; summary?: ResultSummary; refreshKey?: string | number }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ResultRecordsResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) { setLoading(true); setError('') } })
    void api.get<ResultRecordsResponse>(`/capture-cloud/tasks/${encodeURIComponent(taskId)}/results?page=${page}&pageSize=20`)
      .then(result => { if (active) setData(result) })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : '读取关联内容失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [taskId, page, refreshKey])
  return <section className="overflow-hidden rounded-xl border border-border/70">
    <div className="border-b border-border/70 px-4 py-3"><h3 className="text-sm font-semibold">入库结果</h3>
      {summary && summary.observationCount > 0 && <p className="mt-1 text-[11px] text-muted-foreground">关联 {summary.recordCount} 篇内容 · {summary.observationCount} 次采集记录，包含本任务及子任务；重复采集会保留多次记录。</p>}
      {!summary && data && data.total > 0 && <p className="mt-1 text-[11px] text-muted-foreground">共 {data.total} 篇关联内容，包含本任务及子任务的入库结果。</p>}
    </div>
    {error ? <p role="alert" className="p-4 text-xs text-status-red">{error}</p> : loading ? <div className="flex justify-center p-5"><Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="正在读取关联内容" /></div> : !data?.records.length ? <p className="p-4 text-xs leading-5 text-muted-foreground">未找到与本任务关联的入库记录；历史任务可能未保留关联信息。</p> : <div className="divide-y divide-border/60">{data.records.map(record => <article key={record.id} className="flex items-center gap-3 p-4"><div className="min-w-0 flex-1"><h4 className="break-words text-xs font-semibold">{record.title || '未记录标题'}</h4><p className="mt-1 text-[11px] text-muted-foreground">{PLATFORM_LABELS[record.platform || ''] || record.platform}{record.keyword ? ` · ${record.keyword}` : ''}{record.latestCapturedAt ? ` · ${formatTime(record.latestCapturedAt)}` : ''}</p></div><TaskResultRecordButton recordId={record.id} /></article>)}</div>}
    {data && data.total > data.pageSize && <div className="flex items-center justify-between gap-2 border-t border-border/70 p-3"><Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><span className="text-xs text-muted-foreground">第 {page} / {Math.ceil(data.total / data.pageSize)} 页</span><Button variant="outline" size="sm" disabled={loading || page * data.pageSize >= data.total} onClick={() => setPage(value => value + 1)}>下一页</Button></div>}
  </section>
}
