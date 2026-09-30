import { useEffect, useRef, useState } from 'react'
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

const EMPTY_RANGE: DateRangeValue = { from: '', to: '' }

/**
 * 内容分诊的时间筛选：一个「时间」入口，弹层内按维度切换（发布时间 / 首次发现 / 最近采集 / 处理时间），
 * 每个维度各自保留区间，同时设置多个维度时由服务端按 AND 组合。
 * 按钮上直接概括当前生效的区间，已设置的维度在页签上带蓝点。
 */
export function CombinedDateRangeFilter({ value, onChange, triggerClassName }: {
  value: CombinedDateRanges
  onChange: (value: CombinedDateRanges) => void
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [basis, setBasis] = useState<CombinedDateBasis>('publish')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  const activeBases = COMBINED_BASIS_ORDER.filter(([key]) => value[key].from || value[key].to)
  const active = activeBases.length > 0
  const summary = active
    ? `${BASIS_SHORT[activeBases[0][0]]} ${rangeLabel(value[activeBases[0][0]])}${activeBases.length > 1 ? ` +${activeBases.length - 1}` : ''}`
    : '时间'
  const fullSummary = activeBases.map(([key, label]) => `${label} ${rangeLabel(value[key])}`).join('；')

  const toggleOpen = () => {
    // 打开时定位到第一个已设置的维度，方便直接调整。
    if (!open && activeBases.length) setBasis(activeBases[0][0])
    setOpen(current => !current)
  }
  const setRange = (key: CombinedDateBasis, from: string, to: string) => onChange({ ...value, [key]: { from, to } })

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-label={`时间筛选${active ? `，已设置 ${activeBases.length} 个维度` : ''}`}
        title={active ? fullSummary : '按发布时间、首次发现、最近采集或处理时间筛选'}
        className={filterTriggerClass(active, triggerClassName)}
      >
        <CalendarRange className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[200px] truncate">{summary}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div className="responsive-filter-popover absolute left-0 top-full z-50 mt-1.5 w-[308px] rounded-xl border border-border bg-card p-3.5 shadow-lg">
          <div role="tablist" aria-label="时间维度" className="mb-3 grid grid-cols-4 gap-0.5 rounded-lg bg-muted p-0.5">
            {COMBINED_BASIS_ORDER.map(([key, label]) => {
              const set = Boolean(value[key].from || value[key].to)
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={basis === key}
                  onClick={() => setBasis(key)}
                  className={cn(
                    'relative inline-flex h-7 items-center justify-center rounded-md text-[11px] font-medium transition-colors',
                    basis === key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                  {set && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
                </button>
              )
            })}
          </div>
          {basis === 'handled' && <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">筛选此期间人工更改过处理状态的帖子。</p>}
          <DateRangeEditor
            from={value[basis].from}
            to={value[basis].to}
            onChange={(from, to) => setRange(basis, from, to)}
            onPreset={() => setOpen(false)}
          />
          {active && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
              {activeBases.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRange(key, '', '')}
                  title={`清空${label}`}
                  className="inline-flex items-center gap-1 rounded transition-colors hover:text-foreground"
                >
                  {label} {rangeLabel(value[key])}
                  <X className="h-3 w-3" />
                </button>
              ))}
              {activeBases.length > 1 && (
                <button
                  type="button"
                  onClick={() => onChange({ publish: EMPTY_RANGE, recent: EMPTY_RANGE, first: EMPTY_RANGE, handled: EMPTY_RANGE })}
                  className="ml-auto font-medium transition-colors hover:text-foreground"
                >
                  清空全部
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
