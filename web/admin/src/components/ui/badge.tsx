import { cn } from '@/lib/utils'

// 语义 tone → 固定状态色(对齐 index.css 的 --color-status-*)。
// 颜色含义统一,组件三态(实色块 StatusBadge / 浅底 StatusPill / 圆点 StatusDot)共用这张映射。
type ColorKey = 'green' | 'red' | 'darkred' | 'orange' | 'amber' | 'blue' | 'purple' | 'teal' | 'grey'

const TONE_TO_COLOR: Record<string, ColorKey> = {
  positive: 'green', active: 'green', resolved: 'green', sent: 'green',
  negative: 'red', high: 'red',
  urgent: 'darkred', critical: 'darkred',
  unhandled: 'orange', new: 'orange', open: 'orange',
  pending: 'amber', medium: 'amber',
  reviewing: 'purple', generated: 'purple',
  issue_linked: 'blue', ticketed: 'blue', following: 'blue', platform_admin: 'blue',
  official_responded: 'teal', internal_operator: 'teal',
  neutral: 'grey', muted: 'grey', low: 'grey', normal: 'grey',
  closed: 'grey', archived: 'grey', false_positive: 'grey', ignored: 'grey', viewer: 'grey',
}

// 实色块(Monday 点睛):饱和底 + 对比文字。浅色底用同系深字,深色底用白字。
const SOLID: Record<ColorKey, string> = {
  green: 'bg-status-green text-white',
  red: 'bg-status-red text-white',
  darkred: 'bg-status-darkred text-white',
  orange: 'bg-status-orange text-[#663d00]',
  amber: 'bg-status-amber text-[#5c4700]',
  blue: 'bg-status-blue text-[#0a3d7a]',
  purple: 'bg-status-purple text-white',
  teal: 'bg-status-teal text-[#06484a]',
  grey: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
}

// 浅底(Asana 克制):同系浅底 + 深字,用于密集表格不喧闹。
const SOFT: Record<ColorKey, string> = {
  green: 'bg-status-green/12 text-emerald-700 dark:text-emerald-300',
  red: 'bg-status-red/12 text-rose-700 dark:text-rose-300',
  darkred: 'bg-status-darkred/15 text-rose-800 dark:text-rose-300',
  orange: 'bg-status-orange/15 text-amber-700 dark:text-amber-300',
  amber: 'bg-status-amber/20 text-amber-700 dark:text-amber-300',
  blue: 'bg-status-blue/12 text-blue-700 dark:text-blue-300',
  purple: 'bg-status-purple/12 text-purple-700 dark:text-purple-300',
  teal: 'bg-status-teal/12 text-teal-700 dark:text-teal-300',
  grey: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}

const DOT: Record<ColorKey, string> = {
  green: 'bg-status-green', red: 'bg-status-red', darkred: 'bg-status-darkred',
  orange: 'bg-status-orange', amber: 'bg-status-amber', blue: 'bg-status-blue',
  purple: 'bg-status-purple', teal: 'bg-status-teal', grey: 'bg-status-grey',
}

function colorOf(tone?: string): ColorKey {
  return (tone && TONE_TO_COLOR[tone]) || 'grey'
}

const PILL_BASE = 'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-[18px]'

interface PillProps { tone?: string; children: React.ReactNode; className?: string }

/** 实色状态块(Monday 风,用于强语义:情感/预警/危急)。 */
export function StatusBadge({ tone, children, className }: PillProps) {
  return <span className={cn(PILL_BASE, SOLID[colorOf(tone)], className)}>{children}</span>
}

/** 浅底状态胶囊(Asana 风,用于密集表格/次要语义)。 */
export function StatusPill({ tone, children, className }: PillProps) {
  return <span className={cn(PILL_BASE, SOFT[colorOf(tone)], className)}>{children}</span>
}

/** 圆点 + 文字(最克制,用于列表/图例)。 */
export function StatusDot({ tone, children, className }: PillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-foreground', className)}>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[colorOf(tone)])} />
      {children}
    </span>
  )
}
