import { useState } from 'react'
import { useNav } from '@/lib/navigation'
import { WorkbenchTabs } from '@/components/shared/Workbench'
import { DashboardTab } from '@/pages/insights/DashboardTab'
import { NegativePatrolTab } from '@/pages/insights/NegativePatrolTab'
import { ReportsTab } from '@/pages/insights/ReportsTab'
import { CustomerDailyReport } from '@/pages/insights/CustomerDailyReport'

type Tab = 'daily' | 'dashboard' | 'patrol' | 'reports'

export function InsightsPage() {
  const { params } = useNav()
  const initialTab: Tab = params?.tab === 'dashboard' ? 'dashboard' : params?.tab === 'reports' ? 'reports' : params?.tab === 'patrol' ? 'patrol' : 'daily'
  const [tab, setTab] = useState<Tab>(initialTab)

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <WorkbenchTabs
        tabs={[
          { key: 'daily', label: '客户日报' },
          { key: 'dashboard', label: '数据看板' },
          { key: 'patrol', label: '舆情巡查' },
          { key: 'reports', label: '报告中心' },
        ]}
        activeKey={tab}
        onChange={key => setTab(key as Tab)}
      />
      {tab === 'daily' && <CustomerDailyReport />}
      {tab === 'dashboard' && <DashboardTab onOpenPatrol={() => setTab('patrol')} />}
      {tab === 'patrol' && <NegativePatrolTab />}
      {tab === 'reports' && <ReportsTab />}
    </div>
  )
}
