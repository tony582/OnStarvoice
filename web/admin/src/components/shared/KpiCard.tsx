import { cn, formatNumber } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface KpiCardProps {
  label: string
  value: number | string | undefined
  icon: LucideIcon
  tone?: 'default' | 'destructive' | 'warning'
  onClick?: () => void
}

const TONES = {
  default: { icon: 'text-muted-foreground', num: '' },
  destructive: { icon: 'text-rose-500 dark:text-rose-400', num: 'text-rose-500 dark:text-rose-400' },
  warning: { icon: 'text-amber-500 dark:text-amber-400', num: 'text-amber-600 dark:text-amber-400' },
}

export function KpiCard({ label, value, icon: Icon, tone = 'default', onClick }: KpiCardProps) {
  const t = TONES[tone]
  const interactive = typeof onClick === 'function'
  const Tag = interactive ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      className={cn(
        'group block rounded-xl border border-border bg-card px-4 py-3.5 text-left shadow-xs transition-all duration-150',
        interactive
          ? 'cursor-pointer hover:border-primary/30 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20'
          : 'hover:border-input',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-muted-foreground">{label}</span>
        <Icon className={cn('h-4 w-4 shrink-0 transition-colors', t.icon, interactive && 'group-hover:text-primary')} strokeWidth={1.8} />
      </div>
      <div className={cn('mt-2 text-[26px] font-bold tabular-nums leading-none tracking-tight', t.num)}>
        {formatNumber(value)}
      </div>
    </Tag>
  )
}
