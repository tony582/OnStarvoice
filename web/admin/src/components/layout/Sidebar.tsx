import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Columns3, Radar, BarChart3, Database,
  Sparkles, TrendingUp, Flame, Users2, Lightbulb, LineChart,
  Building2, Users, KeyRound, Settings, ChevronRight,
  ShieldHalf, ShieldCheck, Wand2, PanelLeftClose, HandCoins, X,
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

// 舆情工作台下的二级队列(在侧边栏纵向展开,替代主区横向卡片带)
const WORKBENCH_QUEUES: Array<{ queue: string; label: string; badgeKey?: keyof Badges; dot: string }> = [
  { queue: 'triage', label: '内容分诊', badgeKey: 'triagePending', dot: 'bg-blue-500' },
  { queue: 'leads', label: '评论分诊', badgeKey: 'leadsNew', dot: 'bg-amber-500' },
  { queue: 'feedback', label: '已转工单', badgeKey: 'ticketsPending', dot: 'bg-violet-500' },
  { queue: 'misjudgments', label: '误判反馈', badgeKey: 'feedbackPending', dot: 'bg-rose-500' },
]

const NAV_BY_WORKSPACE: Record<Workspace, NavItem[]> = {
  opinion: [
    { id: 'overview', label: '指挥中心', icon: LayoutDashboard },
    { id: 'workbench', label: '舆情工作台', icon: Columns3 },
    { id: 'monitoring', label: '监测与采集', icon: Radar, badgeKeys: ['monitorAttention'], tag: 'BETA' },
    { id: 'salesleads', label: '销售客资', icon: HandCoins },
    { id: 'insights', label: '分析与报告', icon: BarChart3 },
    { id: 'data', label: '数据底座', icon: Database },
  ],
  content: [
    { id: 'content-home', label: '内容总览', icon: Sparkles },
    { id: 'tracks', label: '赛道大盘', icon: TrendingUp },
    { id: 'hits', label: '爆款拆解', icon: Flame },
    { id: 'benchmarks', label: '对标账号库', icon: Users2 },
    { id: 'keywords', label: '选题与扩词', icon: Lightbulb },
    { id: 'review', label: '内容复盘', icon: LineChart, tag: 'NEW' },
  ],
}

const ADMIN_NAV: NavItem[] = [
  { id: 'official-accounts', label: '官方账号', icon: ShieldCheck },
  { id: 'tenants', label: '租户管理', icon: Building2 },
  { id: 'users', label: '用户账号', icon: Users, platformAdmin: true },
  { id: 'auth-codes', label: '激活码', icon: KeyRound },
  { id: 'settings', label: '系统设置', icon: Settings },
]

interface SidebarProps {
  activePage: string
  onNavigate: (page: string, params?: Record<string, string>) => void
  collapsed: boolean
  onToggleCollapse: () => void
  mobileOpen: boolean
  onMobileClose: () => void
}

export function Sidebar({ activePage, onNavigate, collapsed, onToggleCollapse, mobileOpen, onMobileClose }: SidebarProps) {
  const { isInternal, isPlatformAdmin } = useAuth()
  const { badges } = useBadges()
  const { workspace, switchWorkspace, params } = useNav()
  const activeQueue = activePage === 'workbench' ? (params?.queue || 'triage') : null
  const activeWs = WORKSPACES.find(w => w.key === workspace) || WORKSPACES[0]
  const [adminOpen, setAdminOpen] = useState(false)
  const adminActive = ADMIN_NAV.some(i => i.id === activePage)

  useEffect(() => {
    if (!mobileOpen) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onMobileClose()
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [mobileOpen, onMobileClose])

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          onClick={onMobileClose}
          className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[1px] lg:hidden"
        />
      )}
      <aside
        id="mobile-navigation"
        aria-label="主导航"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[min(88vw,320px)] flex-col overflow-hidden border-r border-sidebar-border bg-sidebar shadow-xl transition-transform duration-200 lg:z-30 lg:w-[240px] lg:shadow-none',
          mobileOpen ? 'visible translate-x-0 pointer-events-auto' : 'invisible -translate-x-full pointer-events-none',
          collapsed ? 'lg:invisible lg:-translate-x-full lg:pointer-events-none' : 'lg:visible lg:translate-x-0 lg:pointer-events-auto',
        )}
      >
      {/* 头部:Logo + 隐藏 */}
      <div className="flex items-center gap-2.5 px-4 pb-1 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary lg:h-8 lg:w-8">
          <img src="/images/logo-starvoice.svg" alt="" className="h-[18px] w-[18px] object-contain brightness-0 invert" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-bold text-foreground">StarVoice 星语</div>
          <div className="mt-0.5 text-[10px] font-medium tracking-wide text-muted-foreground lg:hidden">移动值守台</div>
        </div>
        <button onClick={onMobileClose} title="关闭导航"
          className="ml-auto flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground lg:hidden">
          <X className="h-5 w-5" strokeWidth={1.9} />
        </button>
        <button onClick={onToggleCollapse} title="隐藏导航"
          className="ml-auto hidden h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground lg:flex">
          <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.9} />
        </button>
      </div>

      {/* 工作区分段切换:舆情风控 / 内容创意(横向来回切)*/}
      <div className="mx-3 mt-2 flex gap-1 rounded-xl bg-sidebar-accent/50 p-1">
        {WORKSPACES.map(w => {
          const Icon = w.icon
          const on = w.key === workspace
          return (
            <button key={w.key} onClick={() => { switchWorkspace(w.key); onMobileClose() }} title={w.desc}
              className={cn(
                'flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12.5px] font-semibold transition-colors lg:min-h-0 lg:py-1.5',
                on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}>
              <Icon className={cn('h-4 w-4', on && w.accent)} strokeWidth={2} />
              {w.label}
            </button>
          )
        })}
      </div>
      <div className="px-4 pb-0.5 pt-1.5 text-[10px] text-muted-foreground">{activeWs.desc}</div>

      <nav className="mt-1 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-3 pb-4 pt-1">
        <NavGroup label="WORKSPACE" items={NAV_BY_WORKSPACE[workspace]} activePage={activePage} activeQueue={activeQueue} onNavigate={onNavigate} badges={badges} isPlatformAdmin={isPlatformAdmin} />
      </nav>

      {/* 底部:平台管理(向上弹出菜单)+ 版本 —— 管理类不进日常导航 */}
      {isInternal() && (
        <div className="relative mx-3 mb-1">
          {adminOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setAdminOpen(false)} />
              <div className="absolute bottom-[calc(100%+6px)] left-0 right-0 z-40 rounded-xl border border-border bg-card p-1 shadow-lg animate-in fade-in slide-in-from-bottom-1 duration-150">
                {ADMIN_NAV.map(item => {
                  if (item.platformAdmin && !isPlatformAdmin()) return null
                  const Icon = item.icon
                  const on = activePage === item.id
                  return (
                    <button key={item.id} onClick={() => { onNavigate(item.id); setAdminOpen(false) }}
                      className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
                        on ? 'bg-accent font-semibold text-primary' : 'font-medium text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground')}>
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />{item.label}
                    </button>
                  )
                })}
              </div>
            </>
          )}
          <button onClick={() => setAdminOpen(o => !o)}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
              adminActive || adminOpen ? 'bg-accent text-primary' : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground')}>
            <Settings className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
            <span>平台管理</span>
            <ChevronRight className={cn('ml-auto h-3.5 w-3.5 transition-transform', adminOpen && '-rotate-90')} />
          </button>
        </div>
      )}
      <div className="mx-4 h-px bg-sidebar-border" />
      <div className="px-4 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2.5 text-[10px] text-muted-foreground">v0.3.0 · Dual Workspace</div>
      </aside>
    </>
  )
}

function NavGroup({ label, items, activePage, activeQueue, onNavigate, badges, isPlatformAdmin }: {
  label: string; items: NavItem[]; activePage: string; activeQueue: string | null
  onNavigate: (p: string, params?: Record<string, string>) => void
  badges: Badges; isPlatformAdmin: () => boolean
}) {
  return (
    <div className="mb-1">
      <div className="mb-2 mt-4 px-3 text-[9px] font-semibold tracking-[0.16em] text-muted-foreground first:mt-1">{label}</div>
      {items.map(item => {
        if (item.platformAdmin && !isPlatformAdmin()) return null
        const isWorkbench = item.id === 'workbench'
        const onWorkbench = isWorkbench && activePage === 'workbench'
        return (
          <div key={item.id}>
            <NavButton
              item={item}
              active={activePage === item.id && !isWorkbench}
              sectionActive={onWorkbench}
              badges={badges}
              onClick={() => onNavigate(item.id, isWorkbench ? { queue: 'triage' } : undefined)}
            />
            {isWorkbench && (
              <div className="relative mb-1 mt-0.5 space-y-0.5 pl-[26px]">
                <span className="absolute bottom-1.5 left-[18px] top-1.5 w-px bg-sidebar-border" />
                {WORKBENCH_QUEUES.map(q => {
                  const on = onWorkbench && activeQueue === q.queue
                  const count = q.badgeKey ? badges[q.badgeKey] : 0
                  return (
                    <button key={q.queue} onClick={() => onNavigate('workbench', { queue: q.queue })}
                      className={cn(
                        'group flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[12.5px] transition-colors lg:min-h-0 lg:py-[6px]',
                        on ? 'bg-accent font-semibold text-primary' : 'font-medium text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                      )}>
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full transition-colors', on ? q.dot : 'bg-muted-foreground/40 group-hover:bg-muted-foreground/70')} />
                      <span className="truncate">{q.label}</span>
                      {count > 0 && (
                        <span className={cn(
                          'ml-auto inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
                          on ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground',
                        )}>{count > 99 ? '99+' : count}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function NavButton({ item, active, sectionActive, badges, onClick }: {
  item: NavItem; active: boolean; sectionActive?: boolean; badges: Badges; onClick: () => void
}) {
  const Icon = item.icon
  const badgeCount = (item.badgeKeys || []).reduce((sum, k) => sum + badges[k], 0)
  const isAttention = item.badgeKeys?.length === 1 && item.badgeKeys[0] === 'monitorAttention'
  const hot = active || sectionActive
  return (
    <button onClick={onClick}
      className={cn(
        'group relative flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors duration-150 lg:min-h-0 lg:py-[8px]',
        active ? 'bg-accent font-semibold text-primary'
          : sectionActive ? 'font-semibold text-foreground'
            : 'font-medium text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
      )}>
      <Icon className={cn('h-[17px] w-[17px] shrink-0 transition-colors', hot ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} strokeWidth={hot ? 2 : 1.6} />
      <span className="truncate">{item.label}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {item.tag && (
          <span className={cn(
            'rounded px-1.5 text-[8.5px] font-bold tracking-wide',
            item.tag === 'BETA'
              ? 'border border-primary/20 bg-primary/10 text-primary'
              : 'bg-status-green/15 text-emerald-600 dark:text-emerald-400',
          )}>{item.tag}</span>
        )}
        {badgeCount > 0 ? (
          <span className={cn(
            'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
            isAttention ? 'bg-status-orange/20 text-amber-600 dark:text-amber-400' : 'bg-primary/12 text-primary',
          )}>{badgeCount > 99 ? '99+' : badgeCount}</span>
        ) : active && !sectionActive ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        ) : null}
      </span>
    </button>
  )
}
