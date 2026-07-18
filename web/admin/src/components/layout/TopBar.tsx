import { LogOut, ChevronsUpDown, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from './ThemeToggle'
import { useAuth } from '@/lib/auth'
import { LABELS } from '@/lib/utils'

interface TopBarProps {
  eyebrow: string
  title: string
  collapsed?: boolean
  onToggleCollapse?: () => void
  onOpenMobileNavigation?: () => void
}

export function TopBar({ eyebrow, title, collapsed, onToggleCollapse, onOpenMobileNavigation }: TopBarProps) {
  const { user, tenants, tenantId, switchTenant, logout } = useAuth()

  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/92 px-3 pt-[env(safe-area-inset-top)] backdrop-blur-md sm:px-4">
      <div className="flex min-h-14 items-center justify-between gap-2 sm:gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {onOpenMobileNavigation && (
            <button
              type="button"
              onClick={onOpenMobileNavigation}
              title="打开导航"
              aria-label="打开导航"
              aria-controls="mobile-navigation"
              className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
            >
              <PanelLeftOpen className="h-5 w-5" strokeWidth={1.9} />
            </button>
          )}
          {collapsed && onToggleCollapse && (
            <button onClick={onToggleCollapse} title="展开导航"
              className="-ml-1.5 hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:flex">
              <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.9} />
            </button>
          )}
          <div className="min-w-0">
            <div className="hidden text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground sm:block">{eyebrow}</div>
            <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight sm:text-[16px]">{title}</h1>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2.5">
          {tenants.length > 1 && (
            <div className="relative hidden sm:block">
              <select value={tenantId} onChange={e => switchTenant(e.target.value)}
                className="h-8 appearance-none rounded-md border border-border bg-card pl-3 pr-8 text-[13px] font-medium text-foreground transition-colors hover:border-input focus:outline-none focus:ring-2 focus:ring-primary/10">
                {tenants.map(t => (<option key={t.id} value={t.id}>{t.name}</option>))}
              </select>
              <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
          )}
          <div className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 lg:flex">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
              {(user?.name || user?.email || '?').slice(0, 1).toUpperCase()}
            </div>
            <span className="max-w-[140px] truncate text-[13px] font-medium">{user?.name || user?.email}</span>
            <span className="text-[11px] text-muted-foreground">{LABELS.role[user?.globalRole || ''] || ''}</span>
          </div>
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={logout} aria-label="退出登录" title="退出登录" className="h-10 px-3 text-muted-foreground hover:text-destructive sm:h-8">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {tenants.length > 1 && (
        <label className="flex items-center gap-2 pb-2.5 sm:hidden">
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">当前租户</span>
          <div className="relative min-w-0 flex-1">
            <select
              value={tenantId}
              onChange={e => switchTenant(e.target.value)}
              className="h-9 w-full appearance-none rounded-lg border border-border bg-card pl-3 pr-9 text-[13px] font-semibold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            >
              {tenants.map(t => (<option key={t.id} value={t.id}>{t.name}</option>))}
            </select>
            <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        </label>
      )}
    </header>
  )
}
