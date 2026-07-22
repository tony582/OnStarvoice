import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MultiOption {
  value: string
  label: string
  count?: number | string
  keywords?: string
}

/**
 * 通用多选下拉筛选(固定选项)。外观与 KeywordFilter 一致(bg-muted 按钮 + 计数徽标 + 复选下拉),
 * 各列表页统一用它做「风险」等多选筛选。选项写死传入,选中态 string[]。
 */
export function MultiSelect({
  label,
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

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button type="button" onClick={toggleOpen} aria-expanded={open}
        className={cn('inline-flex h-10 items-center gap-1 rounded-lg border border-transparent bg-muted px-3 text-[12px] font-medium transition-colors hover:bg-muted/70 lg:h-8 lg:px-2.5',
          value.length ? 'text-primary' : 'text-muted-foreground', triggerClassName)}>
        {label}
        {value.length > 0 && <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold text-primary">{value.length}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={cn(
            'responsive-filter-popover absolute top-full z-50 mt-1 max-w-[calc(100vw-24px)] rounded-xl border border-border bg-card p-2 shadow-lg lg:z-30 lg:rounded-lg',
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
