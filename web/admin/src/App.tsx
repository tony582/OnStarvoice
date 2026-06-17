import { useState } from 'react'
import { cn } from '@/lib/utils'
import { AuthProvider, useAuth } from '@/lib/auth'
import { NavProvider, useNav } from '@/lib/navigation'
import { BadgesProvider } from '@/lib/badges'
import { LoginPage } from '@/pages/LoginPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { OpinionPage } from '@/pages/OpinionPage'
import { SalesLeadsPage } from '@/pages/SalesLeadsPage'
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
  opinion: { eyebrow: 'Opinion Handling', title: '舆情处理 · 工单' },
  workbench: { eyebrow: 'Opinion Workbench', title: '舆情工作台' },
  monitoring: { eyebrow: 'Monitoring', title: '关注博主' },
  salesleads: { eyebrow: 'Sales Leads', title: '销售客资' },
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
  opinion: OpinionPage,
  workbench: WorkbenchPage,
  monitoring: MonitoringPage,
  salesleads: SalesLeadsPage,
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

// 工作台标题随选中队列变化(队列已是侧边栏二级导航)
const QUEUE_TITLES: Record<string, string> = { triage: '内容分诊', leads: '评论分诊', feedback: '已转工单', issues: '问题处置' }

function AppContent() {
  const { user, loading, tenantId } = useAuth()
  const { page, params, seq, navigate } = useNav()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('osv_sidebar_collapsed') === '1')
  const toggleCollapse = () => setCollapsed(c => { const next = !c; localStorage.setItem('osv_sidebar_collapsed', next ? '1' : '0'); return next })

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!user) return <LoginPage />

  const config = PAGE_CONFIG[page] || PAGE_CONFIG.overview
  const title = page === 'workbench' ? (QUEUE_TITLES[params?.queue || 'triage'] || config.title) : config.title
  const PageComponent = PAGES[page]

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar activePage={page} onNavigate={navigate} collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      {/* 主区是独立滚动容器:滚动条落在主区右缘;抽屉打开时用 margin-right 让位,
          使主区滚动条与抽屉自身滚动条分处两栏(而非都挤在视口最右)。 */}
      <main
        className={cn('min-w-0 flex-1 overflow-y-auto pr-8 py-5 transition-[margin-left] duration-200', collapsed ? 'ml-0 pl-16' : 'ml-[240px] pl-8')}
        style={{ marginRight: 'var(--detail-dock-width, 0px)' }}
      >
        <TopBar eyebrow={config.eyebrow} title={title} />
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
