import { cn, formatNumber } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface KpiCardProps {
  label: string
  value: number | string | undefined
  icon: LucideIcon
  tone?: 'default' | 'destructive' | 'warning'
}

const TONES = {
  default: { icon: 'from-indigo-500/15 to-indigo-500/5 text-indigo-500 dark:from-indigo-400/15 dark:to-indigo-400/5 dark:text-indigo-400', glow: 'shadow-indigo-500/5' },
  destructive: { icon: 'from-rose-500/15 to-rose-500/5 text-rose-500 dark:from-rose-400/15 dark:to-rose-400/5 dark:text-rose-400', glow: 'shadow-rose-500/5' },
  warning: { icon: 'from-amber-500/15 to-amber-500/5 text-amber-500 dark:from-amber-400/15 dark:to-amber-400/5 dark:text-amber-400', glow: 'shadow-amber-500/5' },
}

export function KpiCard({ label, value, icon: Icon, tone = 'default' }: KpiCardProps) {
  const t = TONES[tone]
  return (
    <div className={cn(
      'group relative overflow-hidden rounded-2xl border border-border bg-card p-5 transition-all duration-300',
      'hover:-translate-y-1 hover:shadow-xl', t.glow
    )}>
      {/* Corner glow on hover */}
      <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-gradient-to-br from-primary/10 to-transparent opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100" />

      <div className="relative flex items-start gap-4">
        <div className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br', t.icon)}>
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
          <div className="mt-2 text-[12px] font-semibold text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  )
}
