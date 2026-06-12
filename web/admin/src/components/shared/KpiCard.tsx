import { cn, formatNumber } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface KpiCardProps {
  label: string
  value: number | string | undefined
  icon: LucideIcon
  tone?: 'default' | 'destructive' | 'warning'
}

const TONES = {
  default: { icon: 'bg-blue-50 text-blue-600 dark:bg-blue-950/30 dark:text-blue-300' },
  destructive: { icon: 'bg-rose-50 text-rose-600 dark:bg-rose-950/30 dark:text-rose-300' },
  warning: { icon: 'bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300' },
}

export function KpiCard({ label, value, icon: Icon, tone = 'default' }: KpiCardProps) {
  const t = TONES[tone]
  return (
    <div className="rounded-lg border border-border bg-card p-5 transition-colors duration-150 hover:border-input">
      <div className="relative flex items-start gap-4">
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-md', t.icon)}>
          <Icon className="h-[22px] w-[22px]" strokeWidth={1.6} />
        </div>
        <div className="min-w-0">
          <div className={cn(
            'text-[28px] font-extrabold tabular-nums leading-none tracking-tight',
            tone === 'destructive' && 'text-rose-500 dark:text-rose-400',
            tone === 'warning' && 'text-amber-500 dark:text-amber-400',
          )}>
            {formatNumber(value)}
          </div>
          <div className="mt-2 text-[12px] font-medium text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  )
}
