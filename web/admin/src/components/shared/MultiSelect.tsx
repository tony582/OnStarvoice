import { useEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MultiOption { value: string; label: string }

/**
 * 通用多选下拉筛选(固定选项)。外观与 KeywordFilter 一致(bg-muted 按钮 + 计数徽标 + 复选下拉),
 * 各列表页统一用它做「风险」等多选筛选。选项写死传入,选中态 string[]。
 */
export function MultiSelect({ label, options, value, onChange, width = 'w-44', className }: {
  label: string
  options: MultiOption[]
  value: string[]
  onChange: (v: string[]) => void
  width?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [])

  const toggle = (v: string) => onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v])

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={cn('inline-flex h-8 items-center gap-1 rounded-lg border border-transparent bg-muted px-2.5 text-[12px] font-medium transition-colors hover:bg-muted/70',
          value.length ? 'text-primary' : 'text-muted-foreground')}>
        {label}
        {value.length > 0 && <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold text-primary">{value.length}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className={cn('absolute left-0 top-full z-30 mt-1 rounded-lg border border-border bg-card p-2 shadow-lg', width)}>
          {value.length > 0 && (
            <button onClick={() => onChange([])} className="mb-1 flex w-full items-center gap-1 px-1 text-[11px] text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />清空已选 ({value.length})
            </button>
          )}
          <div className="max-h-60 overflow-y-auto">
            {options.map(o => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-[12px] hover:bg-accent">
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} className="h-3.5 w-3.5 rounded border-border" />
                <span className="flex-1 truncate">{o.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
