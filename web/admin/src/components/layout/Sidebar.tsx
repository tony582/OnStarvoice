import {
  LayoutGrid, Activity, AlertCircle, FileText, Radar,
  Database, Building2, Users, KeyRound, Settings, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'

const ICON_MAP: Record<string, React.ElementType> = {
  overview: LayoutGrid, triage: Activity, issues: AlertCircle, reports: FileText,
  monitor: Radar, data: Database, tenants: Building2, users: Users,
  'auth-codes': KeyRound, settings: Settings,
}

const NAV = [
  {
    section: 'WORKSPACE', items: [
      { id: 'overview', label: '总览' },
      { id: 'triage', label: '舆情收件箱' },
      { id: 'issues', label: '问题处置' },
      { id: 'reports', label: '报告中心' },
      { id: 'monitor', label: '监控任务' },
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

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-[240px] flex-col overflow-hidden bg-sidebar">
      {/* Subtle gradient overlay */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-500/[0.03] to-transparent" />

      {/* Brand */}
      <div className="relative flex items-center gap-3 px-5 pb-4 pt-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 ring-1 ring-white/[0.06]">
          <img src="/images/logo-starvoice.svg" alt="" className="h-6 w-6 object-contain" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-bold text-white">OnStarVoice</div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/25">Opinion Ops</div>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

      {/* Nav */}
      <nav className="relative flex-1 space-y-0.5 overflow-y-auto px-3 pt-4 pb-4">
        {NAV.map(group => {
          if (group.internal && !isInternal()) return null
          return (
            <div key={group.section} className="mb-1">
              <div className="mb-2 mt-5 px-3 text-[9px] font-bold tracking-[0.2em] text-white/20 first:mt-0">
                {group.section}
              </div>
              {group.items.map(item => {
                if ('platformAdmin' in item && item.platformAdmin && !isPlatformAdmin()) return null
                const Icon = ICON_MAP[item.id] || LayoutGrid
                const active = activePage === item.id
                return (
                  <button key={item.id} onClick={() => onNavigate(item.id)}
                    className={cn(
                      'group relative flex w-full items-center gap-3 rounded-xl px-3 py-[9px] text-[13px] font-medium transition-all duration-200',
                      active
                        ? 'text-white'
                        : 'text-sidebar-foreground hover:text-white/80'
                    )}>
                    {/* Active glow bg */}
                    {active && (
                      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-500/15 to-purple-500/10 ring-1 ring-inset ring-white/[0.06]" />
                    )}
                    {/* Active left accent */}
                    {active && (
                      <div className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.5)]" />
                    )}
                    <Icon className={cn('relative z-10 h-[17px] w-[17px] shrink-0 transition-colors', active ? 'text-indigo-400' : 'text-white/30 group-hover:text-white/50')} strokeWidth={active ? 2 : 1.6} />
                    <span className="relative z-10">{item.label}</span>
                    {active && <ChevronRight className="relative z-10 ml-auto h-3.5 w-3.5 text-white/20" />}
                  </button>
                )
              })}
            </div>
          )
        })}
      </nav>

      {/* Bottom divider glow */}
      <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/[0.04] to-transparent" />
      <div className="px-5 py-4">
        <div className="text-[10px] text-white/15">v0.2.0 · React Edition</div>
      </div>
    </aside>
  )
}
