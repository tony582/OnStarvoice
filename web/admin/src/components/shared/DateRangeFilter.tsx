import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CalendarRange, X } from 'lucide-react'
import { cn } from '@/lib/utils'

function ymd(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export type DateBasis = 'publish' | 'recent' | 'first'

const BASIS_FULL: Record<DateBasis, string> = { publish: '发布时间', recent: '最近采集', first: '首次采集' }
const BASIS_SHORT: Record<DateBasis, string> = { publish: '发布', recent: '最近', first: '首次' }
const BASIS_ORDER: [DateBasis, string][] = [['publish', '发布时间'], ['recent', '最近采集'], ['first', '首次采集']]

/**
 * 日期区间筛选。外观与 MultiSelect / KeywordFilter 完全一致(h-8 灰 pill + 弹层),
 * 把原生 date 控件收进弹层,并提供近 7/30 天等快捷。值为 YYYY-MM-DD。
 * basis 切换筛选维度:发布时间(published_ts)/ 最近采集(last_seen_at)/ 首次采集(first_seen_at)。
 */
export function DateRangeFilter({ from, to, onChange, basis, onBasisChange }: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  basis: DateBasis
  onBasisChange: (b: DateBasis) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [])

  const active = Boolean(from || to)
  const label = active
    ? `${BASIS_SHORT[basis]} ${from ? from.slice(5) : '…'}~${to ? to.slice(5) : '…'}`
    : BASIS_FULL[basis]

  const presetDays = (days: number) => {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - (days - 1))
    onChange(ymd(start), ymd(end))
  }
  const presetThisMonth = () => {
    const end = new Date()
    onChange(ymd(new Date(end.getFullYear(), end.getMonth(), 1)), ymd(end))
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={cn('inline-flex h-8 items-center gap-1 rounded-lg border border-transparent bg-muted px-2.5 text-[12px] font-medium transition-colors hover:bg-muted/70',
          active ? 'text-primary' : 'text-muted-foreground')}>
        <CalendarRange className="h-3.5 w-3.5" />
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-[264px] rounded-xl border border-border bg-card p-3.5 shadow-lg">
          <div className="mb-3 flex h-7 items-center rounded-lg bg-muted p-0.5">
            {BASIS_ORDER.map(([v, l]) => (
              <button key={v} type="button" onClick={() => onBasisChange(v)}
                className={cn('inline-flex h-6 flex-1 items-center justify-center rounded-md text-[11px] font-medium transition-colors',
                  basis === v ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {l}
              </button>
            ))}
          </div>
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            {([['近7天', () => presetDays(7)], ['近30天', () => presetDays(30)], ['本月', presetThisMonth]] as const).map(([t, fn]) => (
              <button key={t} type="button" onClick={fn}
                className="h-7 rounded-md bg-muted text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-primary">
                {t}
              </button>
            ))}
          </div>
          <div className="space-y-1.5 border-t border-border pt-3">
            <label className="flex items-center gap-2.5">
              <span className="w-7 shrink-0 text-[11px] text-muted-foreground">开始</span>
              <input type="date" value={from} max={to || undefined} onChange={e => onChange(e.target.value, to)}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors focus:border-primary" />
            </label>
            <label className="flex items-center gap-2.5">
              <span className="w-7 shrink-0 text-[11px] text-muted-foreground">结束</span>
              <input type="date" value={to} min={from || undefined} onChange={e => onChange(from, e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors focus:border-primary" />
            </label>
          </div>
          {active && (
            <button type="button" onClick={() => onChange('', '')}
              className="mt-2.5 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
              <X className="h-3 w-3" />清空时间
            </button>
          )}
        </div>
      )}
    </div>
  )
}
