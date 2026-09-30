import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { filterTriggerClass } from '@/lib/filter-trigger'

export interface MultiOption {
  value: string
  label: string
  count?: number | string
  keywords?: string
}

/**
 * 通用多选下拉筛选(固定选项)。外观与 KeywordFilter 一致(灰 pill + 复选下拉),
 * 各列表页统一用它做「风险」等多选筛选。选项写死传入,选中态 string[]。
 * 只选一项时按钮直接显示「标签：选项」，多选时显示计数，不用点开就知道选了什么。
 */
export function MultiSelect({
  label,
  activeLabel,
  options,
  value,
  onChange,
  width = 'w-44',
  className,
  triggerClassName,
  searchable = false,
  searchPlaceholder = '搜索选项…',
  emptyText = '暂无选项',
  onSearch,
}: {
  label: string
  /** 激活后按钮上用的名称（例如未激活显示「全部状态」，激活后显示「处理状态：待处理」）。 */
  activeLabel?: string
  options: MultiOption[]
  value: string[]
  onChange: (v: string[]) => void
  width?: string
  className?: string
  triggerClassName?: string
  searchable?: boolean
  searchPlaceholder?: string
  emptyText?: string
  onSearch?: (query: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [alignRight, setAlignRight] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    setQuery('')
    onSearch?.('')
  }, [onSearch])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) {
        closeMenu()
      }
    }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [closeMenu, open])

  useEffect(() => {
    if (!open || !searchable || !onSearch) return
    const timer = window.setTimeout(() => onSearch(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [onSearch, open, query, searchable])

  useLayoutEffect(() => {
    if (!open || !ref.current || !menuRef.current) return
    const trigger = ref.current.getBoundingClientRect()
    const menuWidth = menuRef.current.getBoundingClientRect().width
    const wouldOverflowRight = trigger.left + menuWidth > window.innerWidth - 12
    const fitsToLeft = trigger.right - menuWidth >= 12
    setAlignRight(wouldOverflowRight && fitsToLeft)
  }, [open, searchable, width])

  const toggle = (v: string) => onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v])
  const normalizedQuery = normalizeSearchText(query)
  const filtered = normalizedQuery
    ? options.filter(option => normalizeSearchText(`${option.label} ${option.keywords || ''}`).includes(normalizedQuery))
    : options

  const toggleOpen = () => {
    if (open) {
      closeMenu()
    } else {
      setOpen(true)
    }
  }

  const selectedLabels = options.filter(option => value.includes(option.value)).map(option => option.label)
  const active = value.length > 0
  const triggerText = !active
    ? label
    : value.length === 1 && selectedLabels[0]
      ? `${activeLabel || label}：${selectedLabels[0]}`
      : (activeLabel || label)

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-label={`${activeLabel || label}筛选${active ? `，已选 ${value.length} 项` : ''}`}
        title={active ? selectedLabels.join('、') || `已选 ${value.length} 项` : undefined}
        className={filterTriggerClass(active, triggerClassName)}
      >
        <span className="max-w-[180px] truncate">{triggerText}</span>
        {value.length > 1 && <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold text-primary">{value.length}</span>}
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={cn(
            'responsive-filter-popover absolute top-full z-50 mt-1 max-w-[calc(100vw-24px)] rounded-xl border border-border bg-card p-2 shadow-lg lg:rounded-lg',
            alignRight ? 'right-0' : 'left-0',
            width,
          )}
        >
          {searchable && (
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                autoFocus
                onChange={event => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="h-10 w-full rounded-md border border-border bg-background pl-8 pr-8 text-[12px] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10 lg:h-7 lg:pl-7 lg:pr-7"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清空搜索"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          {value.length > 0 && (
            <button onClick={() => onChange([])} className="mb-1 flex w-full items-center gap-1 px-1 text-[11px] text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />清空已选 ({value.length})
            </button>
          )}
          <div className="max-h-60 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-5 text-center text-[11px] text-muted-foreground">{options.length ? '没有匹配选项' : emptyText}</div>
            ) : filtered.map(o => (
              <label key={o.value} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-[12px] hover:bg-accent lg:min-h-0 lg:px-1.5 lg:py-1.5">
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} className="h-3.5 w-3.5 rounded border-border" />
                <span className="flex-1 truncate">{o.label}</span>
                {o.count !== undefined && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{o.count}</span>}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/^#+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('zh-CN')
}
