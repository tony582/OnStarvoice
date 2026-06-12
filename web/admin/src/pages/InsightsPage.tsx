import { useState } from 'react'
import { useNav } from '@/lib/navigation'
import { WorkbenchTabs } from '@/components/shared/Workbench'
import { DashboardTab } from '@/pages/insights/DashboardTab'
import { ReportsTab } from '@/pages/insights/ReportsTab'

type Tab = 'dashboard' | 'reports'

export function InsightsPage() {
  const { params } = useNav()
  const initialTab: Tab = params?.tab === 'reports' ? 'reports' : 'dashboard'
  const [tab, setTab] = useState<Tab>(initialTab)

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-300">
      <WorkbenchTabs
        tabs={[{ key: 'dashboard', label: '数据看板' }, { key: 'reports', label: '报告中心' }]}
        activeKey={tab}
        onChange={key => setTab(key as Tab)}
      />
      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'reports' && <ReportsTab />}
    </div>
  )
}
