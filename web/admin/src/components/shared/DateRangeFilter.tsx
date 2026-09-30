import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, CalendarRange, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { filterTriggerClass } from '@/lib/filter-trigger'

function ymd(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export type DateBasis = 'publish' | 'recent' | 'first'
export type CombinedDateBasis = DateBasis | 'handled'
export type DateRangeValue = { from: string; to: string }
export type CombinedDateRanges = Record<CombinedDateBasis, DateRangeValue>

const BASIS_FULL: Record<CombinedDateBasis, string> = { publish: '发布时间', recent: '最近采集', first: '首次发现', handled: '处理时间' }
const BASIS_SHORT: Record<CombinedDateBasis, string> = { publish: '发布', recent: '最近', first: '首次', handled: '处理' }
const BASIS_ORDER: [DateBasis, string][] = [['publish', '发布时间'], ['first', '首次发现'], ['recent', '最近采集']]
const COMBINED_BASIS_ORDER: [CombinedDateBasis, string][] = [...BASIS_ORDER, ['handled', '处理时间']]

function rangeLabel(value: DateRangeValue) {
  return `${value.from ? value.from.slice(5) : '…'}~${value.to ? value.to.slice(5) : '…'}`
}

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
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className={filterTriggerClass(active, triggerClassName)}>
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
 * 内容分诊的时间筛选组：发布时间 / 首次发现 / 最近采集 / 处理时间四个维度各自是一个入口，
 * 直接点开设置区间，各自保留区间、可同时设置多个（服务端按 AND 组合）。四个芯片与其它筛选芯片同一外观，
 * 靠筛选区的行名「时间」分组；激活的维度芯片上直接显示区间，不用点开就知道当前按什么时间在筛。
 */
export function CombinedDateRangeFilter({ value, onChange, triggerClassName, itemClassName }: {
  value: CombinedDateRanges
  onChange: (value: CombinedDateRanges) => void
  triggerClassName?: string
  /** 每个维度芯片外层的样式，供筛选区把它们当作普通芯片排进自动填充的行里。 */
  itemClassName?: string
}) {
  return (
    <>
      {COMBINED_BASIS_ORDER.map(([basis]) => (
        <IndependentDateRangeFilter
          key={basis}
          basis={basis}
          value={value[basis]}
          onChange={(from, to) => onChange({ ...value, [basis]: { from, to } })}
          triggerClassName={triggerClassName}
          className={itemClassName}
        />
      ))}
    </>
  )
}

function IndependentDateRangeFilter({ basis, value, onChange, triggerClassName, className }: {
  basis: CombinedDateBasis
  value: DateRangeValue
  onChange: (from: string, to: string) => void
  triggerClassName?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const active = Boolean(value.from || value.to)
  const label = rangeLabel(value)

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  // 靠右的维度弹层容易撑出视口，打开时按实际位置决定向左还是向右展开。
  useLayoutEffect(() => {
    if (!open || !ref.current || !menuRef.current) return
    const trigger = ref.current.getBoundingClientRect()
    const menuWidth = menuRef.current.getBoundingClientRect().width
    const wouldOverflowRight = trigger.left + menuWidth > window.innerWidth - 12
    const fitsToLeft = trigger.right - menuWidth >= 12
    setAlignRight(wouldOverflowRight && fitsToLeft)
  }, [open])

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
        aria-label={`${BASIS_FULL[basis]}筛选${active ? `，已设置 ${label}` : ''}`}
        title={active ? `${BASIS_FULL[basis]}：${label}` : `按${BASIS_FULL[basis]}筛选`}
        className={filterTriggerClass(active, triggerClassName)}
      >
        <span className="truncate">{active ? `${BASIS_SHORT[basis]} ${label}` : BASIS_FULL[basis]}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={cn(
            'responsive-filter-popover absolute top-full z-50 mt-1.5 w-[264px] rounded-xl border border-border bg-card p-3.5 shadow-lg',
            alignRight ? 'right-0' : 'left-0',
          )}
        >
          <div className="mb-2.5 text-[11px] font-semibold text-foreground">{BASIS_FULL[basis]}</div>
          {basis === 'handled' && <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">筛选此期间人工更改过处理状态的帖子。</p>}
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
