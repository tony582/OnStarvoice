import { cn } from '@/lib/utils'

const TONE_MAP: Record<string, string> = {
  positive: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900/60',
  negative: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-900/60',
  neutral: 'bg-slate-50 text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-900/50 dark:text-slate-300 dark:ring-slate-800',
  muted: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  active: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900/60',
  resolved: 'bg-slate-50 text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-900/50 dark:text-slate-300 dark:ring-slate-800',
  closed: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  unhandled: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/60',
  reviewing: 'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:ring-violet-900/60',
  issue_linked: 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:ring-blue-900/60',
  official_responded: 'bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-200 dark:bg-teal-950/30 dark:text-teal-300 dark:ring-teal-900/60',
  archived: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  false_positive: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  high: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-900/60',
  critical: 'bg-rose-50 text-rose-800 ring-1 ring-inset ring-rose-200 font-semibold dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-900/60',
  medium: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/60',
  low: 'bg-slate-50 text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-900/50 dark:text-slate-300 dark:ring-slate-800',
  generated: 'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:ring-violet-900/60',
  sent: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900/60',
  pending: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/60',
  open: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/60',
  new: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/60',
  following: 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:ring-blue-900/60',
  ignored: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  urgent: 'bg-rose-50 text-rose-800 ring-1 ring-inset ring-rose-200 font-semibold dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-900/60',
  normal: 'bg-slate-50 text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-900/50 dark:text-slate-300 dark:ring-slate-800',
  platform_admin: 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:ring-blue-900/60',
  internal_operator: 'bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-200 dark:bg-teal-950/30 dark:text-teal-300 dark:ring-teal-900/60',
  viewer: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
}

const DEFAULT = 'bg-muted text-muted-foreground ring-1 ring-inset ring-border'

interface StatusBadgeProps { tone?: string; children: React.ReactNode; className?: string }

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium leading-5',
      (tone && TONE_MAP[tone]) || DEFAULT,
      className,
    )}>
      {children}
    </span>
  )
}
