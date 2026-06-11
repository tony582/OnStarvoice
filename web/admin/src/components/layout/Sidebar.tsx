import {
  LayoutGrid, Activity, AlertCircle, FileText, Radar,
  Database, Building2, Users, KeyRound, Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'

const ICON_MAP: Record<string, React.ElementType> = {
  overview: LayoutGrid,
  triage: Activity,
  issues: AlertCircle,
  reports: FileText,
  monitor: Radar,
  data: Database,
  tenants: Building2,
  users: Users,
  'auth-codes': KeyRound,
  settings: Settings,
}

const NAV = [
  {
    section: 'Workspace', items: [
      { id: 'overview', label: '总览' },
      { id: 'triage', label: '舆情收件箱' },
      { id: 'issues', label: '问题处置' },
      { id: 'reports', label: '报告中心' },
      { id: 'monitor', label: '监控任务' },
      { id: 'data', label: '数据资产' },
    ],
  },
  {
    section: 'Administration', internal: true, items: [
      { id: 'tenants', label: '租户管理' },
      { id: 'users', label: '用户账号', platformAdmin: true },
      { id: 'auth-codes', label: '激活码' },
      { id: 'settings', label: '系统设置' },
    ],
  },
]

interface SidebarProps {
  activePage: string
  onNavigate: (page: string) => void
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { isInternal, isPlatformAdmin } = useAuth()

  return (
    <aside className="fixed inset-y-0 left-0 z-10 flex w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className="flex items-center gap-3 border-b border-sidebar-border px-5 py-5">
        <img src="/images/logo-starvoice.svg" alt="" className="h-8 w-8 object-contain drop-shadow-md" />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-white">OnStarVoice 星语</div>
          <div className="text-[10px] uppercase tracking-widest text-sidebar-foreground/50">Opinion Ops</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV.map(group => {
          if (group.internal && !isInternal()) return null
          return (
            <div key={group.section}>
              <div className="mb-2 mt-5 px-3 text-[10px] font-bold uppercase tracking-wider text-sidebar-foreground/40 first:mt-0">
                {group.section}
              </div>
              {group.items.map(item => {
                if ('platformAdmin' in item && item.platformAdmin && !isPlatformAdmin()) return null
                const Icon = ICON_MAP[item.id] || LayoutGrid
                const isActive = activePage === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-all duration-200',
                      isActive
                        ? 'bg-sidebar-accent text-blue-400 shadow-sm'
                        : 'text-sidebar-foreground hover:bg-white/5 hover:text-white'
                    )}
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
