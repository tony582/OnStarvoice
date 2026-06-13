import { useEffect, useRef, useState } from 'react'
import {
  LayoutDashboard, Columns3, Radar, Route, BarChart3, Database,
  Sparkles, TrendingUp, Flame, Users2, Lightbulb, LineChart,
  Building2, Users, KeyRound, Settings, ChevronRight, ChevronDown,
  ShieldHalf, Wand2, Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'
import { useBadges, type Badges } from '@/lib/badges'
import { useNav, type Workspace } from '@/lib/navigation'

type NavItem = { id: string; label: string; icon: React.ElementType; platformAdmin?: boolean; badgeKeys?: Array<keyof Badges>; tag?: string }

const WORKSPACES: Array<{ key: Workspace; label: string; desc: string; icon: React.ElementType; accent: string }> = [
  { key: 'opinion', label: '舆情风控', desc: '监测 · 预警 · 处置', icon: ShieldHalf, accent: 'text-status-red' },
  { key: 'content', label: '内容创意', desc: '赛道 · 爆款 · 选题', icon: Wand2, accent: 'text-status-purple' },
]

const NAV_BY_WORKSPACE: Record<Workspace, NavItem[]> = {
  opinion: [
    { id: 'overview', label: '指挥中心', icon: LayoutDashboard },
    { id: 'workbench', label: '舆情工作台', icon: Columns3, badgeKeys: ['triagePending', 'leadsNew', 'issuesOpen'] },
    { id: 'monitoring', label: '监控中心', icon: Radar, badgeKeys: ['monitorAttention'] },
    { id: 'events', label: '事件中心', icon: Route },
    { id: 'insights', label: '分析与报告', icon: BarChart3 },
    { id: 'data', label: '数据底座', icon: Database },
  ],
  content: [
    { id: 'content-home', label: '内容总览', icon: Sparkles },
    { id: 'tracks', label: '赛道大盘', icon: TrendingUp, tag: 'NEW' },
    { id: 'hits', label: '爆款拆解', icon: Flame, tag: 'NEW' },
    { id: 'benchmarks', label: '对标账号库', icon: Users2, tag: 'NEW' },
    { id: 'keywords', label: '选题与扩词', icon: Lightbulb, tag: 'NEW' },
    { id: 'review', label: '内容复盘', icon: LineChart, tag: 'NEW' },
  ],
}

const ADMIN_NAV: NavItem[] = [
  { id: 'tenants', label: '租户管理', icon: Building2 },
  { id: 'users', label: '用户账号', icon: Users, platformAdmin: true },
  { id: 'auth-codes', label: '激活码', icon: KeyRound },
  { id: 'settings', label: '系统设置', icon: Settings },
]

interface SidebarProps { activePage: string; onNavigate: (page: string) => void }

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { isInternal, isPlatformAdmin } = useAuth()
  const { badges } = useBadges()
  const { workspace, switchWorkspace } = useNav()

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-[240px] flex-col overflow-hidden border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2.5 px-5 pb-3 pt-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <img src="/images/logo-starvoice.svg" alt="" className="h-5 w-5 object-contain brightness-0 invert" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-foreground">OnStarVoice</div>
        </div>
      </div>

      <div className="px-3">
        <WorkspaceSwitcher current={workspace} onSwitch={switchWorkspace} />
      </div>

      <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4 pt-1">
        <NavGroup label="WORKSPACE" items={NAV_BY_WORKSPACE[workspace]} activePage={activePage} onNavigate={onNavigate} badges={badges} isPlatformAdmin={isPlatformAdmin} />
        {isInternal() && (
          <NavGroup label="ADMIN" items={ADMIN_NAV} activePage={activePage} onNavigate={onNavigate} badges={badges} isPlatformAdmin={isPlatformAdmin} />
        )}
      </nav>

      <div className="mx-5 h-px bg-sidebar-border" />
      <div className="px-5 py-3.5">
        <div className="text-[10px] text-muted-foreground">v0.3.0 · Dual Workspace</div>
      </div>
    </aside>
  )
}

function WorkspaceSwitcher({ current, onSwitch }: { current: Workspace; onSwitch: (ws: Workspace) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = WORKSPACES.find(w => w.key === current) || WORKSPACES[0]
  const ActiveIcon = active.icon

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-sidebar-border bg-card px-3 py-2 text-left transition-colors hover:border-input"
      >
        <ActiveIcon className={cn('h-4 w-4 shrink-0', active.accent)} strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-foreground">{active.label}</div>
          <div className="truncate text-[10px] text-muted-foreground">{active.desc}</div>
        </div>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5 animate-in fade-in slide-in-from-top-1 rounded-lg border border-border bg-card p-1 shadow-lg duration-150">
          {WORKSPACES.map(w => {
            const Icon = w.icon
            const isActive = w.key === current
            return (
              <button
                key={w.key}
                onClick={() => { onSwitch(w.key); setOpen(false) }}
                className={cn('flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors', isActive ? 'bg-accent' : 'hover:bg-muted')}
              >
                <Icon className={cn('h-4 w-4 shrink-0', w.accent)} strokeWidth={2} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold text-foreground">{w.label}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{w.desc}</div>
                </div>
                {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function NavGroup({ label, items, activePage, onNavigate, badges, isPlatformAdmin }: {
  label: string; items: NavItem[]; activePage: string; onNavigate: (p: string) => void
  badges: Badges; isPlatformAdmin: () => boolean
}) {
  return (
    <div className="mb-1">
      <div className="mb-2 mt-4 px-3 text-[9px] font-semibold tracking-[0.16em] text-muted-foreground first:mt-1">{label}</div>
      {items.map(item => {
        if (item.platformAdmin && !isPlatformAdmin()) return null
        const Icon = item.icon
        const active = activePage === item.id
        const badgeCount = (item.badgeKeys || []).reduce((sum, k) => sum + badges[k], 0)
        const isAttention = item.badgeKeys?.length === 1 && item.badgeKeys[0] === 'monitorAttention'
        return (
          <button key={item.id} onClick={() => onNavigate(item.id)}
            className={cn(
              'group relative flex w-full items-center gap-3 rounded-lg px-3 py-[8px] text-[13px] transition-colors duration-150',
              active ? 'bg-accent font-semibold text-primary' : 'font-medium text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
            )}>
            <Icon className={cn('h-[17px] w-[17px] shrink-0 transition-colors', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} strokeWidth={active ? 2 : 1.6} />
            <span className="truncate">{item.label}</span>
            {badgeCount > 0 ? (
              <span className={cn(
                'ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
                isAttention ? 'bg-status-orange/20 text-amber-600 dark:text-amber-400' : 'bg-primary/12 text-primary',
              )}>{badgeCount > 99 ? '99+' : badgeCount}</span>
            ) : item.tag ? (
              <span className="ml-auto rounded bg-status-green/15 px-1.5 text-[8.5px] font-bold tracking-wide text-emerald-600 dark:text-emerald-400">{item.tag}</span>
            ) : active ? (
              <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
