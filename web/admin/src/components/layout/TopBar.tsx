import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from './ThemeToggle'
import { useAuth } from '@/lib/auth'
import { LABELS } from '@/lib/utils'

interface TopBarProps {
  eyebrow: string
  title: string
}

export function TopBar({ eyebrow, title }: TopBarProps) {
  const { user, tenants, tenantId, switchTenant, logout } = useAuth()

  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{eyebrow}</div>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        {tenants.length > 1 && (
          <select
            value={tenantId}
            onChange={e => switchTenant(e.target.value)}
            className="h-9 rounded-lg border border-input bg-card px-3 text-sm text-foreground"
          >
            {tenants.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <span className="max-w-[180px] truncate text-sm text-muted-foreground">
          {user?.name || user?.email} · {LABELS.role[user?.globalRole || ''] || '用户'}
        </span>
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut className="h-4 w-4" />
          退出
        </Button>
      </div>
    </header>
  )
}
