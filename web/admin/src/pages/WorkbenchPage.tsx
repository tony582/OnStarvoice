import { useNav } from '@/lib/navigation'
import { TriageQueue } from '@/pages/workbench/TriageQueue'
import { LeadsQueue } from '@/pages/workbench/LeadsQueue'
import { IssuesQueue } from '@/pages/workbench/IssuesQueue'
import { TicketFeedbackQueue } from '@/pages/workbench/TicketFeedbackQueue'

type QueueKey = 'triage' | 'leads' | 'salesleads' | 'feedback' | 'issues'
const QUEUE_KEYS: QueueKey[] = ['triage', 'leads', 'salesleads', 'feedback', 'issues']

/**
 * 舆情工作台:队列(内容分诊/评论线索/问题处置)已移到侧边栏二级导航,
 * 本页只按导航参数渲染当前队列。切队列由侧边栏 navigate 触发(带 queue 参数,
 * App 的 key 含 seq 会重挂载本页,从而消费一次性预置筛选)。
 */
export function WorkbenchPage() {
  const { params } = useNav()
  const queue: QueueKey = QUEUE_KEYS.includes(params?.queue as QueueKey) ? (params!.queue as QueueKey) : 'triage'
  const initial = params ?? undefined

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      {queue === 'triage' && <TriageQueue initial={initial} />}
      {queue === 'leads' && <LeadsQueue initial={initial} category="opinion" />}
      {queue === 'salesleads' && <LeadsQueue key="sales" initial={initial} category="sales" />}
      {queue === 'feedback' && <TicketFeedbackQueue />}
      {queue === 'issues' && <IssuesQueue initial={initial} />}
    </div>
  )
}
