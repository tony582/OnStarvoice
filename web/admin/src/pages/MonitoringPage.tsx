import { useEffect, useState } from 'react'
import { useNav } from '@/lib/navigation'
import { WorkbenchTabs } from '@/components/shared/Workbench'
import { MonitorTasksTab } from '@/pages/monitoring/TasksTab'
import { MonitorHitsTab } from '@/pages/monitoring/HitsTab'
import { OfficialCommentPatrolTab } from '@/pages/monitoring/OfficialCommentPatrolTab'

type Tab = 'tasks' | 'hits' | 'official-comments'

export function MonitoringPage() {
  const { params, navigate } = useNav()
  const initialTab: Tab = params?.tab === 'hits'
    ? 'hits'
    : params?.tab === 'official-comments'
      ? 'official-comments'
      : 'tasks'
  const [tab, setTab] = useState<Tab>(initialTab)
  // hits 的一次性预置:导航带来的(tab=hits)或从任务行"查看命中"带来的 subscriptionId
  const [hitsInitial, setHitsInitial] = useState<Record<string, string> | undefined>(
    params?.tab === 'hits' ? params ?? undefined : undefined,
  )

  // 老入口(monitoring?tab=cloud)兼容:采集任务已独立为一级模块「调度中心」
  useEffect(() => {
    if (params?.tab === 'cloud') navigate('dispatch')
  }, [params?.tab, navigate])

  const viewHits = (subscriptionId: string) => {
    setHitsInitial({ subscriptionId })
    setTab('hits')
  }

  if (params?.tab === 'cloud') return null

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <WorkbenchTabs
        tabs={[
          { key: 'tasks', label: '关注的博主' },
          { key: 'hits', label: '博主新动态' },
          { key: 'official-comments', label: '官方账号巡查' },
        ]}
        activeKey={tab}
        onChange={key => setTab(key as Tab)}
      />
      {tab === 'tasks' && <MonitorTasksTab onViewHits={viewHits} />}
      {tab === 'hits' && <MonitorHitsTab key={hitsInitial?.subscriptionId || 'all'} initial={hitsInitial} />}
      {tab === 'official-comments' && <OfficialCommentPatrolTab />}
    </div>
  )
}
