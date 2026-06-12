import { useState } from 'react'
import { useNav } from '@/lib/navigation'
import { WorkbenchTabs } from '@/components/shared/Workbench'
import { MonitorTasksTab } from '@/pages/monitoring/TasksTab'
import { MonitorHitsTab } from '@/pages/monitoring/HitsTab'

type Tab = 'tasks' | 'hits'

export function MonitoringPage() {
  const { params } = useNav()
  const initialTab: Tab = params?.tab === 'hits' ? 'hits' : 'tasks'
  const [tab, setTab] = useState<Tab>(initialTab)
  // hits 的一次性预置:导航带来的(tab=hits)或从任务行"查看命中"带来的 subscriptionId
  const [hitsInitial, setHitsInitial] = useState<Record<string, string> | undefined>(
    params?.tab === 'hits' ? params ?? undefined : undefined,
  )

  const viewHits = (subscriptionId: string) => {
    setHitsInitial({ subscriptionId })
    setTab('hits')
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <WorkbenchTabs
        tabs={[{ key: 'tasks', label: '监控任务' }, { key: 'hits', label: '监控命中' }]}
        activeKey={tab}
        onChange={key => setTab(key as Tab)}
      />
      {tab === 'tasks' && <MonitorTasksTab onViewHits={viewHits} />}
      {tab === 'hits' && <MonitorHitsTab key={hitsInitial?.subscriptionId || 'all'} initial={hitsInitial} />}
    </div>
  )
}
