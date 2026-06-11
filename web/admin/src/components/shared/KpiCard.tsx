import { cn, formatNumber } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface KpiCardProps {
  label: string
  value: number | string | undefined
  icon: LucideIcon
  tone?: 'default' | 'destructive' | 'warning'
}

const toneStyles = {
  default: {
    iconBg: 'bg-primary/10 text-primary',
  },
  destructive: {
    iconBg: 'bg-destructive/10 text-destructive',
  },
  warning: {
    iconBg: 'bg-warning/10 text-warning',
  },
}

export function KpiCard({ label, value, icon: Icon, tone = 'default' }: KpiCardProps) {
  const styles = toneStyles[tone]
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg">
      {/* Gradient border glow on hover */}
      <div className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          background: 'linear-gradient(135deg, transparent 40%, rgba(59,130,246,0.08) 100%)',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
          padding: '1px',
        }}
      />
      <div className="flex items-start gap-4">
        <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', styles.iconBg)}>
          <Icon className="h-5 w-5" strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <div className={cn(
            'text-3xl font-extrabold tabular-nums tracking-tight',
            tone === 'destructive' && 'text-destructive',
            tone === 'warning' && 'text-warning',
          )}>
            {formatNumber(value)}
          </div>
          <div className="mt-1 text-xs font-semibold text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  )
}
