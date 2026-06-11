import { useState, useCallback } from 'react'
import { AuthProvider, useAuth } from '@/lib/auth'
import { LoginPage } from '@/pages/LoginPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { TriagePage } from '@/pages/TriagePage'
import { IssuesPage } from '@/pages/IssuesPage'
import { ReportsPage } from '@/pages/ReportsPage'
import { MonitorPage } from '@/pages/MonitorPage'
import { DataPage } from '@/pages/DataPage'
import { TenantsPage, UsersPage, AuthCodesPage, SettingsPage } from '@/pages/AdminPages'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { Loader2 } from 'lucide-react'

const PAGE_CONFIG: Record<string, { eyebrow: string; title: string }> = {
  overview: { eyebrow: 'Workspace', title: '总览' },
  triage: { eyebrow: 'Triage Inbox', title: '舆情收件箱' },
  issues: { eyebrow: 'Issue Desk', title: '问题处置' },
  reports: { eyebrow: 'Reports', title: '报告中心' },
  monitor: { eyebrow: 'Monitoring', title: '监控任务' },
  data: { eyebrow: 'Data Assets', title: '数据资产' },
  tenants: { eyebrow: 'Administration', title: '租户管理' },
  users: { eyebrow: 'Administration', title: '用户账号' },
  'auth-codes': { eyebrow: 'Administration', title: '激活码' },
  settings: { eyebrow: 'Administration', title: '系统设置' },
}

const PAGES: Record<string, React.ComponentType> = {
  overview: OverviewPage,
  triage: TriagePage,
  issues: IssuesPage,
  reports: ReportsPage,
  monitor: MonitorPage,
  data: DataPage,
  tenants: TenantsPage,
  users: UsersPage,
  'auth-codes': AuthCodesPage,
  settings: SettingsPage,
}

function AppContent() {
  const { user, loading } = useAuth()
  const [page, setPage] = useState(() => localStorage.getItem('osv_page') || 'overview')

  const navigate = useCallback((p: string) => {
    setPage(p)
    localStorage.setItem('osv_page', p)
  }, [])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!user) return <LoginPage />

  const config = PAGE_CONFIG[page] || PAGE_CONFIG.overview
  const PageComponent = PAGES[page] || OverviewPage

  return (
    <div className="flex min-h-screen">
      <Sidebar activePage={page} onNavigate={navigate} />
      <main className="ml-60 min-w-0 flex-1 p-8">
        <TopBar eyebrow={config.eyebrow} title={config.title} />
        <PageComponent key={page} />
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
