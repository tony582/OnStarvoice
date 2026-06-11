import { LogOut, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from './ThemeToggle'
import { useAuth } from '@/lib/auth'
import { LABELS } from '@/lib/utils'

interface TopBarProps { eyebrow: string; title: string }

export function TopBar({ eyebrow, title }: TopBarProps) {
  const { user, tenants, tenantId, switchTenant, logout } = useAuth()

  return (
    <header className="mb-8 flex items-start justify-between gap-4">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary/60">{eyebrow}</div>
        <h1 className="mt-1.5 text-[26px] font-extrabold tracking-tight leading-none">{title}</h1>
      </div>
      <div className="flex items-center gap-3">
        {tenants.length > 1 && (
          <div className="relative">
            <select value={tenantId} onChange={e => switchTenant(e.target.value)}
              className="h-9 appearance-none rounded-xl border border-border bg-card pl-3 pr-8 text-[13px] font-medium text-foreground transition hover:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/20">
              {tenants.map(t => (<option key={t.id} value={t.id}>{t.name}</option>))}
            </select>
            <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        )}
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500/20 to-purple-500/20 text-[10px] font-bold text-primary">
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
