import { cn } from '@/lib/utils'

// Asana/Monday 风格:有意义的状态用饱和实色块 + 白字;中性态用柔和浅灰,避免满屏喧闹。
const SOLID = {
  green: 'bg-emerald-500 text-white dark:bg-emerald-500',
  red: 'bg-rose-500 text-white dark:bg-rose-500',
  redDeep: 'bg-rose-600 text-white dark:bg-rose-600',
  orange: 'bg-orange-500 text-white dark:bg-orange-500',
  amber: 'bg-amber-500 text-white dark:bg-amber-500',
  violet: 'bg-violet-500 text-white dark:bg-violet-500',
  blue: 'bg-blue-500 text-white dark:bg-blue-500',
  teal: 'bg-teal-500 text-white dark:bg-teal-500',
}
const SOFT = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'

const TONE_MAP: Record<string, string> = {
  positive: SOLID.green,
  active: SOLID.green,
  resolved: SOLID.green,
  sent: SOLID.green,
  negative: SOLID.red,
  high: SOLID.red,
  urgent: SOLID.redDeep,
  critical: SOLID.redDeep,
  unhandled: SOLID.orange,
  new: SOLID.orange,
  open: SOLID.orange,
  pending: SOLID.amber,
  medium: SOLID.amber,
  reviewing: SOLID.violet,
  generated: SOLID.violet,
  issue_linked: SOLID.blue,
  following: SOLID.blue,
  platform_admin: SOLID.blue,
  official_responded: SOLID.teal,
  internal_operator: SOLID.teal,
  neutral: SOFT,
  muted: SOFT,
  low: SOFT,
  normal: SOFT,
  closed: SOFT,
  archived: SOFT,
  false_positive: SOFT,
  ignored: SOFT,
  viewer: SOFT,
}

const DEFAULT = SOFT

interface StatusBadgeProps { tone?: string; children: React.ReactNode; className?: string }

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold leading-[18px]',
      (tone && TONE_MAP[tone]) || DEFAULT,
      className,
    )}>
      {children}
    </span>
  )
}
