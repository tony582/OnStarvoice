import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'
import { useNav } from '@/lib/navigation'
import { OverviewPage } from '@/pages/OverviewPage'
import { OpinionPage } from '@/pages/OpinionPage'
import { SalesLeadsPage } from '@/pages/SalesLeadsPage'
import { WorkbenchPage } from '@/pages/WorkbenchPage'
import { MonitoringPage } from '@/pages/MonitoringPage'
import { DispatchPage } from '@/pages/dispatch/DispatchPage'
import { SocialAccountsPage } from '@/pages/SocialAccountsPage'
import { InsightsPage } from '@/pages/InsightsPage'
import { OpinionAnalysisPage } from '@/pages/OpinionAnalysisPage'
import { DataPage } from '@/pages/DataPage'
import { EventsPage } from '@/pages/EventsPage'
import { TracksPage } from '@/pages/TracksPage'
import { BenchmarksPage } from '@/pages/BenchmarksPage'
import { KeywordsPage } from '@/pages/KeywordsPage'
import { ContentHomePage } from '@/pages/ContentHomePage'
import { HitsPage } from '@/pages/HitsPage'
import { OwnedAccountExclusionsPage } from '@/pages/OwnedAccountExclusionsPage'
import { OfficialCommentPatrolTab } from '@/pages/monitoring/OfficialCommentPatrolTab'
import { ComingSoon } from '@/pages/ComingSoon'
import { TenantsPage, UsersPage, AuthCodesPage, SettingsPage } from '@/pages/AdminPages'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { PanelLeftOpen, Smartphone } from 'lucide-react'
import { switchUiMode } from '@/lib/ui-mode'

const PAGE_CONFIG: Record<string, { eyebrow: string; title: string }> = {
  overview: { eyebrow: 'Command Center', title: '指挥中心 · 态势驾驶舱' },
  opinion: { eyebrow: 'Opinion Handling', title: '舆情处理 · 工单' },
  workbench: { eyebrow: 'Opinion Workbench', title: '舆情工作台' },
  monitoring: { eyebrow: 'Followed Creators', title: '关注博主' },
  dispatch: { eyebrow: 'Dispatch Center', title: '调度中心' },
  'social-accounts': { eyebrow: 'Account Health', title: '社交账号' },
  salesleads: { eyebrow: 'Sales Leads', title: '销售客资' },
  events: { eyebrow: 'Events', title: '事件中心' },
  insights: { eyebrow: 'Insights', title: '分析与报告' },
  'opinion-analysis': { eyebrow: 'Opinion Analysis', title: '舆情剖析' },
  data: { eyebrow: 'Data Assets', title: '数据底座' },
  'content-home': { eyebrow: 'Content Studio', title: '内容总览' },
  tracks: { eyebrow: 'Content Studio', title: '赛道大盘' },
  hits: { eyebrow: 'Content Studio', title: '爆款拆解' },
  benchmarks: { eyebrow: 'Content Studio', title: '对标账号库' },
  keywords: { eyebrow: 'Content Studio', title: '选题与扩词' },
  review: { eyebrow: 'Content Studio', title: '内容复盘' },
  'official-comments': { eyebrow: 'Official Social', title: '官方社媒' },
  'owned-account-exclusions': { eyebrow: 'Administration', title: '自营内容排除' },
  tenants: { eyebrow: 'Administration', title: '租户管理' },
  users: { eyebrow: 'Administration', title: '用户账号' },
  'auth-codes': { eyebrow: 'Administration', title: '激活码' },
  settings: { eyebrow: 'Administration', title: '系统设置' },
}

const PAGE_COMPONENTS: Record<string, React.ComponentType> = {
  overview: OverviewPage,
  opinion: OpinionPage,
  workbench: WorkbenchPage,
  monitoring: MonitoringPage,
  dispatch: DispatchPage,
  'social-accounts': SocialAccountsPage,
  salesleads: SalesLeadsPage,
  events: EventsPage,
  insights: InsightsPage,
  'opinion-analysis': OpinionAnalysisPage,
  data: DataPage,
  tracks: TracksPage,
  benchmarks: BenchmarksPage,
  keywords: KeywordsPage,
  'content-home': ContentHomePage,
  hits: HitsPage,
  'official-comments': OfficialCommentPatrolTab,
  'owned-account-exclusions': OwnedAccountExclusionsPage,
  tenants: TenantsPage,
  users: UsersPage,
  'auth-codes': AuthCodesPage,
  settings: SettingsPage,
}

const QUEUE_TITLES: Record<string, string> = {
  triage: '内容分诊',
  leads: '评论分诊',
  misjudgments: '误判反馈',
  issues: '问题处置',
}

function pageTitle(page: string, params?: Record<string, string> | null) {
  const config = PAGE_CONFIG[page] || PAGE_CONFIG.overview
  const queue = params?.queue === 'feedback' ? 'triage' : (params?.queue || 'triage')
  return page === 'workbench' ? (QUEUE_TITLES[queue] || config.title) : config.title
}

export default function DesktopApp() {
  const { tenantId } = useAuth()
  const { page, params, seq, navigate } = useNav()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('osv_sidebar_collapsed') === '1')
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const toggleCollapse = () => setCollapsed(c => {
    const next = !c
    localStorage.setItem('osv_sidebar_collapsed', next ? '1' : '0')
    return next
  })
  const navigateFromSidebar = (nextPage: string, nextParams?: Record<string, string>) => {
    navigate(nextPage, nextParams)
    setMobileNavigationOpen(false)
  }

  const config = PAGE_CONFIG[page] || PAGE_CONFIG.overview
  const PageComponent = PAGE_COMPONENTS[page]
  const officialCommentPreview = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('preview') === 'official-comment-ops'

  return (
    <div className="flex h-dvh min-h-[480px] overflow-hidden">
      <Sidebar
        activePage={page}
        onNavigate={navigateFromSidebar}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
        showInternalItems={officialCommentPreview}
      />
      <main className={cn(
        'app-main min-w-0 flex-1 overflow-y-auto transition-[margin-left,margin-right] duration-200 [container-type:inline-size]',
        collapsed ? 'lg:ml-0' : 'lg:ml-[208px]',
        page === 'dispatch' && 'xl:overflow-hidden',
      )}>
        <div className="lg:hidden">
          <TopBar
            eyebrow={config.eyebrow}
            title={pageTitle(page, params)}
            badge={page === 'dispatch' ? 'BETA' : undefined}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
          />
        </div>
        {collapsed && (
          <button type="button" onClick={toggleCollapse} title="展开导航" aria-label="展开导航"
            className="fixed left-3 top-3 z-30 hidden h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground lg:flex">
            <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.9} />
          </button>
        )}
        <div className={cn(
          'animate-fade-up px-3 sm:px-4 lg:px-6',
          page === 'official-comments'
            ? 'pb-0 pt-0 xl:h-dvh xl:overflow-hidden'
            : 'pb-[max(2rem,env(safe-area-inset-bottom))] pt-4 sm:pt-5',
          page === 'dispatch' && 'xl:h-dvh xl:pb-0 xl:pr-0 xl:pt-0',
          collapsed && 'lg:pl-14',
        )} key={`${page}:${seq}:${tenantId}`}>
          {PageComponent ? <PageComponent /> : <ComingSoon pageId={page} />}
        </div>
      </main>
      <button type="button" onClick={() => switchUiMode('mobile')}
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[70] flex h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-4 text-xs font-bold text-background shadow-lg lg:hidden">
        <Smartphone className="h-4 w-4" />返回手机版
      </button>
    </div>
  )
}
