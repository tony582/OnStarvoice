import { AuthProvider, useAuth } from '@/lib/auth'
import { NavProvider, useNav } from '@/lib/navigation'
import { BadgesProvider } from '@/lib/badges'
import { LoginPage } from '@/pages/LoginPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { WorkbenchPage } from '@/pages/WorkbenchPage'
import { MonitoringPage } from '@/pages/MonitoringPage'
import { InsightsPage } from '@/pages/InsightsPage'
import { DataPage } from '@/pages/DataPage'
import { EventsPage } from '@/pages/EventsPage'
import { TracksPage } from '@/pages/TracksPage'
import { BenchmarksPage } from '@/pages/BenchmarksPage'
import { KeywordsPage } from '@/pages/KeywordsPage'
import { ContentHomePage } from '@/pages/ContentHomePage'
import { HitsPage } from '@/pages/HitsPage'
import { OfficialAccountsPage } from '@/pages/OfficialAccountsPage'
import { ComingSoon } from '@/pages/ComingSoon'
import { TenantsPage, UsersPage, AuthCodesPage, SettingsPage } from '@/pages/AdminPages'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { Loader2 } from 'lucide-react'

const PAGE_CONFIG: Record<string, { eyebrow: string; title: string }> = {
  // 舆情风控面
  overview: { eyebrow: 'Command Center', title: '指挥中心 · 态势驾驶舱' },
  workbench: { eyebrow: 'Opinion Workbench', title: '舆情工作台' },
  monitoring: { eyebrow: 'Monitoring', title: '监控中心' },
  events: { eyebrow: 'Events', title: '事件中心' },
  insights: { eyebrow: 'Insights', title: '分析与报告' },
  data: { eyebrow: 'Data Assets', title: '数据底座' },
  // 内容创意面
  'content-home': { eyebrow: 'Content Studio', title: '内容总览' },
  tracks: { eyebrow: 'Content Studio', title: '赛道大盘' },
  hits: { eyebrow: 'Content Studio', title: '爆款拆解' },
  benchmarks: { eyebrow: 'Content Studio', title: '对标账号库' },
  keywords: { eyebrow: 'Content Studio', title: '选题与扩词' },
  review: { eyebrow: 'Content Studio', title: '内容复盘' },
  // 管理
  'official-accounts': { eyebrow: 'Administration', title: '官方账号管理' },
  tenants: { eyebrow: 'Administration', title: '租户管理' },
  users: { eyebrow: 'Administration', title: '用户账号' },
  'auth-codes': { eyebrow: 'Administration', title: '激活码' },
  settings: { eyebrow: 'Administration', title: '系统设置' },
}

const PAGES: Record<string, React.ComponentType> = {
  overview: OverviewPage,
  workbench: WorkbenchPage,
  monitoring: MonitoringPage,
  events: EventsPage,
  insights: InsightsPage,
  data: DataPage,
  tracks: TracksPage,
  benchmarks: BenchmarksPage,
  keywords: KeywordsPage,
  'content-home': ContentHomePage,
  hits: HitsPage,
  'official-accounts': OfficialAccountsPage,
  tenants: TenantsPage,
  users: UsersPage,
  'auth-codes': AuthCodesPage,
  settings: SettingsPage,
}

function AppContent() {
  const { user, loading, tenantId } = useAuth()
  const { page, seq, navigate } = useNav()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!user) return <LoginPage />

  const config = PAGE_CONFIG[page] || PAGE_CONFIG.overview
  const PageComponent = PAGES[page]

  return (
    <div className="flex min-h-screen">
      <Sidebar activePage={page} onNavigate={navigate} />
      <main className="ml-[240px] min-w-0 flex-1 px-8 py-6">
        <TopBar eyebrow={config.eyebrow} title={config.title} />
        {/* key 含 seq:带参导航强制重挂载以消费一次性预置筛选;含 tenantId:切租户即时刷新当前页 */}
        <div className="animate-fade-up" key={`${page}:${seq}:${tenantId}`}>
          {PageComponent ? <PageComponent /> : <ComingSoon pageId={page} />}
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <NavProvider>
        <BadgesProvider>
          <AppContent />
        </BadgesProvider>
      </NavProvider>
    </AuthProvider>
  )
}
