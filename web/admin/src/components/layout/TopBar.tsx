import { ChevronsUpDown, PanelLeftOpen } from 'lucide-react'
import { useAuth } from '@/lib/auth'

interface TopBarProps {
  eyebrow: string
  title: string
  badge?: string
  collapsed?: boolean
  onToggleCollapse?: () => void
  onOpenMobileNavigation?: () => void
}

export function TopBar({ eyebrow, title, badge, collapsed, onToggleCollapse, onOpenMobileNavigation }: TopBarProps) {
  const { tenants, tenantId, switchTenant } = useAuth()

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
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight sm:text-[16px]">{title}</h1>
              {badge && <span className="shrink-0 rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-[0.12em] text-primary">{badge}</span>}
            </div>
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
