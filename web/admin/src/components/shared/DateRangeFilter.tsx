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
export type DateRangeValue = { from: string; to: string }
export type CombinedDateRanges = Record<DateBasis, DateRangeValue>

const BASIS_FULL: Record<DateBasis, string> = { publish: '发布时间', recent: '最近采集', first: '首次发现' }
const BASIS_SHORT: Record<DateBasis, string> = { publish: '发布', recent: '最近', first: '首次' }
const BASIS_ORDER: [DateBasis, string][] = [['publish', '发布时间'], ['first', '首次发现'], ['recent', '最近采集']]

function DateRangeEditor({ from, to, onChange, onPreset }: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  onPreset?: () => void
}) {
  const end = new Date()
  const today = ymd(end)
  const weekStart = new Date(end)
  const day = weekStart.getDay()
  weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1))
  const quickRanges = [
    { label: '今日', from: today, to: today },
    { label: '本周', from: ymd(weekStart), to: today },
    { label: '本月', from: ymd(new Date(end.getFullYear(), end.getMonth(), 1)), to: today },
  ]

  return (
    <>
      <div className="mb-3 grid grid-cols-3 gap-1.5">
        {quickRanges.map(range => {
          const selected = from === range.from && to === range.to
          return (
          <button key={range.label} type="button" onClick={() => { onChange(range.from, range.to); onPreset?.() }} aria-pressed={selected}
            className={cn(
              'h-7 rounded-md border text-[11px] font-medium transition-colors',
              selected
                ? 'border-primary/20 bg-accent text-primary'
                : 'border-transparent bg-muted text-muted-foreground hover:border-primary/15 hover:bg-accent hover:text-primary',
            )}>
            {range.label}
          </button>
          )
        })}
      </div>
      <div className="space-y-1.5 border-t border-border pt-3">
        <label className="flex items-center gap-2.5">
          <span className="w-7 shrink-0 text-[11px] text-muted-foreground">开始</span>
          <input type="date" value={from} max={to || undefined} onChange={e => onChange(e.target.value, to)}
            className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors focus:border-primary lg:h-8" />
        </label>
        <label className="flex items-center gap-2.5">
          <span className="w-7 shrink-0 text-[11px] text-muted-foreground">结束</span>
          <input type="date" value={to} min={from || undefined} onChange={e => onChange(from, e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors focus:border-primary lg:h-8" />
        </label>
      </div>
    </>
  )
}

/**
 * 日期区间筛选。外观与 MultiSelect / KeywordFilter 完全一致(h-8 灰 pill + 弹层),
 * 把原生 date 控件收进弹层,并提供今日/本周/本月快捷范围。值为 YYYY-MM-DD。
 * basis 切换筛选维度:发布时间(published_ts)/ 最近采集(last_seen_at)/ 首次发现(first_seen_at)。
 */
export function DateRangeFilter({ from, to, onChange, basis, onBasisChange, triggerClassName }: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  basis: DateBasis
  onBasisChange: (b: DateBasis) => void
  triggerClassName?: string
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

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={cn('inline-flex h-10 items-center gap-1 rounded-lg border border-transparent bg-muted px-3 text-[12px] font-medium transition-colors hover:bg-muted/70 lg:h-8 lg:px-2.5',
          active ? 'text-primary' : 'text-muted-foreground', triggerClassName)}>
        <CalendarRange className="h-3.5 w-3.5" />
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="responsive-filter-popover absolute left-0 top-full z-50 mt-1.5 w-[264px] rounded-xl border border-border bg-card p-3.5 shadow-lg">
          <div className="mb-3 flex h-7 items-center rounded-lg bg-muted p-0.5">
            {BASIS_ORDER.map(([v, l]) => (
              <button key={v} type="button" onClick={() => onBasisChange(v)}
                className={cn('inline-flex h-6 flex-1 items-center justify-center rounded-md text-[11px] font-medium transition-colors',
                  basis === v ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {l}
              </button>
            ))}
          </div>
          <DateRangeEditor from={from} to={to} onChange={onChange} />
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

/**
 * 内容分诊用独立日期筛选组。三个日期维度直接展示，各自保留区间；
 * 同时设置多个维度时由服务端按 AND 组合。
 */
export function CombinedDateRangeFilter({ value, onChange, triggerClassName }: {
  value: CombinedDateRanges
  onChange: (value: CombinedDateRanges) => void
  triggerClassName?: string
}) {
  return (
    <>
      {BASIS_ORDER.map(([basis]) => (
        <IndependentDateRangeFilter
          key={basis}
          basis={basis}
          value={value[basis]}
          onChange={(from, to) => onChange({ ...value, [basis]: { from, to } })}
          triggerClassName={triggerClassName}
        />
      ))}
    </>
  )
}

function IndependentDateRangeFilter({ basis, value, onChange, triggerClassName }: {
  basis: DateBasis
  value: DateRangeValue
  onChange: (from: string, to: string) => void
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = Boolean(value.from || value.to)
  const rangeLabel = `${value.from ? value.from.slice(5) : '…'}~${value.to ? value.to.slice(5) : '…'}`

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
        aria-label={`${BASIS_FULL[basis]}筛选${active ? '，已设置日期范围' : ''}`}
        title={active ? `${BASIS_FULL[basis]}：${rangeLabel}` : undefined}
        className={cn(
          'inline-flex h-10 items-center gap-1 rounded-lg border border-transparent bg-muted px-3 text-[12px] font-medium transition-colors hover:bg-muted/70 lg:h-8 lg:px-2.5',
          active ? 'text-primary' : 'text-muted-foreground',
          triggerClassName,
        )}
      >
        <span className="whitespace-nowrap">{BASIS_FULL[basis]}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className={cn(
          'responsive-filter-popover absolute top-full z-50 mt-1.5 w-[264px] rounded-xl border border-border bg-card p-3.5 shadow-lg',
          basis === 'publish' ? 'left-0' : 'right-0',
        )}>
          <DateRangeEditor from={value.from} to={value.to} onChange={onChange} onPreset={() => setOpen(false)} />
          {active && (
            <button
              type="button"
              onClick={() => onChange('', '')}
              className="mt-2.5 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3 w-3" />清空日期
            </button>
          )}
        </div>
      )}
    </div>
  )
}
