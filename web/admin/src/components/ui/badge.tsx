import { cn } from '@/lib/utils'

const TONE_MAP: Record<string, string> = {
  positive: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/20',
  negative: 'bg-rose-500/10 text-rose-600 dark:bg-rose-400/10 dark:text-rose-400 ring-1 ring-inset ring-rose-500/20',
  neutral: 'bg-sky-500/10 text-sky-600 dark:bg-sky-400/10 dark:text-sky-400 ring-1 ring-inset ring-sky-500/20',
  muted: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  active: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/20',
  resolved: 'bg-sky-500/10 text-sky-600 ring-1 ring-inset ring-sky-500/20',
  closed: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  unhandled: 'bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400 ring-1 ring-inset ring-amber-500/20',
  reviewing: 'bg-violet-500/10 text-violet-600 dark:bg-violet-400/10 dark:text-violet-400 ring-1 ring-inset ring-violet-500/20',
  issue_linked: 'bg-indigo-500/10 text-indigo-600 dark:bg-indigo-400/10 dark:text-indigo-400 ring-1 ring-inset ring-indigo-500/20',
  official_responded: 'bg-teal-500/10 text-teal-600 dark:bg-teal-400/10 dark:text-teal-400 ring-1 ring-inset ring-teal-500/20',
  archived: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  false_positive: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  high: 'bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/20',
  critical: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 ring-1 ring-inset ring-rose-500/25 font-bold',
  medium: 'bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/20',
  low: 'bg-sky-500/10 text-sky-600 ring-1 ring-inset ring-sky-500/20',
  generated: 'bg-violet-500/10 text-violet-600 ring-1 ring-inset ring-violet-500/20',
  sent: 'bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20',
  pending: 'bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/20',
  open: 'bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/20',
  platform_admin: 'bg-indigo-500/10 text-indigo-600 ring-1 ring-inset ring-indigo-500/20',
  internal_operator: 'bg-teal-500/10 text-teal-600 ring-1 ring-inset ring-teal-500/20',
  viewer: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
}

const DEFAULT = 'bg-muted text-muted-foreground ring-1 ring-inset ring-border'

interface StatusBadgeProps { tone?: string; children: React.ReactNode; className?: string }

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold leading-5',
      (tone && TONE_MAP[tone]) || DEFAULT,
      className,
    )}>
      {children}
    </span>
  )
}
