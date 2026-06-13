import { LogOut, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from './ThemeToggle'
import { useAuth } from '@/lib/auth'
import { LABELS } from '@/lib/utils'

interface TopBarProps { eyebrow: string; title: string }

export function TopBar({ eyebrow, title }: TopBarProps) {
  const { user, tenants, tenantId, switchTenant, logout } = useAuth()

  return (
    <header className="mb-4 flex items-start justify-between gap-4">
      <div>
        <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight leading-none">{title}</h1>
      </div>
      <div className="flex items-center gap-3">
        {tenants.length > 1 && (
          <div className="relative">
            <select value={tenantId} onChange={e => switchTenant(e.target.value)}
              className="h-9 appearance-none rounded-md border border-border bg-card pl-3 pr-8 text-[13px] font-medium text-foreground transition-colors hover:border-input focus:outline-none focus:ring-2 focus:ring-primary/10">
              {tenants.map(t => (<option key={t.id} value={t.id}>{t.name}</option>))}
            </select>
            <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        )}
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
            {(user?.name || user?.email || '?').slice(0, 1).toUpperCase()}
          </div>
          <span className="max-w-[140px] truncate text-[13px] font-medium">{user?.name || user?.email}</span>
          <span className="text-[11px] text-muted-foreground">{LABELS.role[user?.globalRole || ''] || ''}</span>
        </div>
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={logout} className="text-muted-foreground hover:text-destructive">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
