import {
  LayoutGrid, Inbox, FileText, Radar, BarChart3,
  Database, Building2, Users, KeyRound, Settings, ChevronRight, Target,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'
import { useBadges, type Badges } from '@/lib/badges'

const ICON_MAP: Record<string, React.ElementType> = {
  overview: LayoutGrid, workbench: Inbox, analytics: BarChart3, reports: FileText,
  monitor: Radar, 'monitor-hits': Target, data: Database, tenants: Building2, users: Users,
  'auth-codes': KeyRound, settings: Settings,
}

// badgeKeys: 该导航项汇总哪些徽标计数(舆情工作台汇总三队列)
type NavItem = { id: string; label: string; platformAdmin?: boolean; badgeKeys?: Array<keyof Badges> }

const NAV: Array<{ section: string; internal?: boolean; items: NavItem[] }> = [
  {
    section: 'WORKSPACE', items: [
      { id: 'overview', label: '总览' },
      { id: 'workbench', label: '舆情工作台', badgeKeys: ['triagePending', 'leadsNew', 'issuesOpen'] },
      { id: 'analytics', label: '数据看板' },
      { id: 'reports', label: '报告中心' },
      { id: 'monitor', label: '监控任务', badgeKeys: ['monitorAttention'] },
      { id: 'monitor-hits', label: '监控命中' },
      { id: 'data', label: '数据资产' },
    ],
  },
  {
    section: 'ADMIN', internal: true, items: [
      { id: 'tenants', label: '租户管理' },
      { id: 'users', label: '用户账号', platformAdmin: true },
      { id: 'auth-codes', label: '激活码' },
      { id: 'settings', label: '系统设置' },
    ],
  },
]

interface SidebarProps { activePage: string; onNavigate: (page: string) => void }

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { isInternal, isPlatformAdmin } = useAuth()
  const { badges } = useBadges()

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-[240px] flex-col overflow-hidden border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-3 px-5 pb-4 pt-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-md border border-sidebar-border bg-card">
          <img src="/images/logo-starvoice.svg" alt="" className="h-6 w-6 object-contain" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-foreground">OnStarVoice</div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Opinion Ops</div>
        </div>
      </div>

      <div className="mx-5 h-px bg-sidebar-border" />

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4 pt-4">
        {NAV.map(group => {
          if (group.internal && !isInternal()) return null
          return (
            <div key={group.section} className="mb-1">
              <div className="mb-2 mt-5 px-3 text-[9px] font-semibold tracking-[0.16em] text-muted-foreground first:mt-0">
                {group.section}
              </div>
              {group.items.map(item => {
                if (item.platformAdmin && !isPlatformAdmin()) return null
                const Icon = ICON_MAP[item.id] || LayoutGrid
                const active = activePage === item.id
                const badgeCount = (item.badgeKeys || []).reduce((sum, k) => sum + badges[k], 0)
                const isAttention = item.badgeKeys?.includes('monitorAttention') && item.badgeKeys.length === 1
                return (
                  <button key={item.id} onClick={() => onNavigate(item.id)}
                    className={cn(
                      'group relative flex w-full items-center gap-3 rounded-md px-3 py-[8px] text-[13px] font-medium transition-colors duration-150',
                      active
                        ? 'bg-sidebar-accent text-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
                    )}>
                    {active && (
                      <div className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-primary" />
                    )}
                    <Icon className={cn('relative z-10 h-[17px] w-[17px] shrink-0 transition-colors', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} strokeWidth={active ? 2 : 1.6} />
                    <span className="relative z-10">{item.label}</span>
                    {badgeCount > 0 && (
                      <span className={cn(
                        'relative z-10 ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
                        isAttention
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : 'bg-primary/12 text-primary',
                      )}>
                        {badgeCount > 99 ? '99+' : badgeCount}
                      </span>
                    )}
                    {active && badgeCount === 0 && <ChevronRight className="relative z-10 ml-auto h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                )
              })}
            </div>
          )
        })}
      </nav>

      <div className="mx-5 h-px bg-sidebar-border" />
      <div className="px-5 py-4">
        <div className="text-[10px] text-muted-foreground">v0.2.0 · React Edition</div>
      </div>
    </aside>
  )
}
