import { useState } from 'react'
import { Inbox, MessageSquareWarning, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNav } from '@/lib/navigation'
import { useBadges, type Badges } from '@/lib/badges'
import { TriageQueue } from '@/pages/workbench/TriageQueue'
import { LeadsQueue } from '@/pages/workbench/LeadsQueue'
import { IssuesQueue } from '@/pages/workbench/IssuesQueue'

type QueueKey = 'triage' | 'leads' | 'issues'

const QUEUES: Array<{ key: QueueKey; label: string; desc: string; icon: React.ElementType; badgeKey: keyof Badges; chip: string; activeBg: string; activeBorder: string }> = [
  { key: 'triage', label: '内容分诊', desc: '待研判的舆情内容', icon: Inbox, badgeKey: 'triagePending', chip: 'bg-blue-500', activeBg: 'bg-blue-50 dark:bg-blue-950/30', activeBorder: 'border-blue-300 dark:border-blue-800' },
  { key: 'leads', label: '评论线索', desc: '需跟进的高风险评论', icon: MessageSquareWarning, badgeKey: 'leadsNew', chip: 'bg-amber-500', activeBg: 'bg-amber-50 dark:bg-amber-950/30', activeBorder: 'border-amber-300 dark:border-amber-800' },
  { key: 'issues', label: '问题处置', desc: '已立项的舆情问题', icon: AlertCircle, badgeKey: 'issuesOpen', chip: 'bg-rose-500', activeBg: 'bg-rose-50 dark:bg-rose-950/30', activeBorder: 'border-rose-300 dark:border-rose-800' },
]

export function WorkbenchPage() {
  const { params } = useNav()
  const { badges } = useBadges()
  const initialQueue = (params?.queue as QueueKey) || 'triage'
  const [queue, setQueue] = useState<QueueKey>(QUEUES.some(q => q.key === initialQueue) ? initialQueue : 'triage')

  // 仅当当前队列与导航预置队列一致时,透传一次性预置筛选
  const initial = queue === params?.queue ? params ?? undefined : undefined

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-5 duration-300">
      {/* Queue switcher: segmented cards with live counts */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {QUEUES.map(q => {
          const Icon = q.icon
          const active = queue === q.key
          const count = badges[q.badgeKey]
          return (
            <button
              key={q.key}
              onClick={() => setQueue(q.key)}
              className={cn(
                'group relative flex items-center gap-3 rounded-xl border p-4 text-left shadow-xs transition-all duration-200',
                active
                  ? cn(q.activeBg, q.activeBorder, 'shadow-sm')
                  : 'border-border bg-card hover:border-input hover:shadow-sm',
              )}
            >
              <div className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white shadow-sm transition-transform group-hover:scale-105',
                q.chip,
              )}>
                <Icon className="h-[22px] w-[22px]" strokeWidth={1.9} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{q.label}</span>
                  {count > 0 && (
                    <span className={cn(
                      'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
                      active ? 'bg-white/70 text-foreground dark:bg-white/15' : 'bg-muted text-muted-foreground',
                    )}>
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">{q.desc}</div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Active queue */}
      {queue === 'triage' && <TriageQueue initial={initial} />}
      {queue === 'leads' && <LeadsQueue initial={initial} />}
      {queue === 'issues' && <IssuesQueue initial={initial} />}
    </div>
  )
}
