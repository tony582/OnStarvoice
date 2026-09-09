import { useState } from 'react'
import { AlertTriangle, Eye, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { RecordDrawer } from '@/components/shared/RecordDrawer'
import { resultCount, resultObject, resultSyncEvidence, resultTiming } from './task-result-presentation.mjs'
import { formatTime } from './lib'

export function TaskResultTimes({ createdAt, startedAt, finishedAt }: {
  createdAt?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}) {
  const timing = resultTiming({createdAt, startedAt, finishedAt})
  return <dl className="grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
    {[
      ['创建时间', formatTime(createdAt)], ['开始时间', formatTime(startedAt)],
      ['结束时间', formatTime(finishedAt)], [timing.label, timing.duration],
    ].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-medium text-foreground">{value}</dd></div>)}
  </dl>
}

export function TaskResultSyncSummary({ progress }: { progress?: Record<string, unknown> | null }) {
  const source = resultObject(progress)
  const evidence = resultSyncEvidence(progress)
  const known = evidence.known
  const complete = evidence.outcome === 'reported_drained'
  const fields = [
    ['入队', source.streamingSyncEnqueuedCount], ['成功', source.streamingSyncSuccessCount],
    ['失败', source.streamingSyncFailedCount], ['剩余', source.streamingSyncRemainingCount],
  ] as const
  return <section className="rounded-xl border border-border/70 bg-background p-3.5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-xs font-semibold">最终同步记录</h4>
      <span className={`text-[11px] ${complete ? 'text-status-green' : known ? 'text-amber-700' : 'text-muted-foreground'}`}>
        {complete ? '已上报同步结束' : known ? '同步结果有待核对' : '未保留完整同步统计'}
      </span>
    </div>
    {known && <div className="mt-3 grid grid-cols-4 gap-3 text-xs">{fields.map(([label, value]) => <div key={label}>
      <div className="text-[11px] text-muted-foreground">{label}</div><strong className="mt-1 block tabular-nums">{resultCount(value) ?? '—'}</strong>
    </div>)}</div>}
    {known && !complete && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">这里保留设备最后上报的同步计数；失败计数不能直接视为缺失内容数量。</p>}
  </section>
}

export function TaskResultRecordButton({ recordId }: { recordId?: string | null }) {
  const [record, setRecord] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  if (!recordId) return null
  const open = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get<{record?: Record<string, unknown>}>(`/opinion-analysis/records/${encodeURIComponent(recordId)}/detail`)
      if (!response.record) throw new Error('内容详情暂不可用')
      setRecord(response.record)
    } catch (err) { setError(err instanceof Error ? err.message : '打开内容失败') }
    finally { setLoading(false) }
  }
  return <>
    <Button variant="ghost" size="sm" onClick={() => void open()} disabled={loading}>
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} 内容详情
    </Button>
    {error && <span role="alert" className="inline-flex items-center gap-1 text-[11px] text-status-red"><AlertTriangle className="h-3 w-3" />{error}</span>}
    {record && <RecordDrawer record={record} canWrite={false} onClose={() => setRecord(null)} />}
  </>
}
