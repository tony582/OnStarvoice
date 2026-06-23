import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface KeywordItem { keyword: string; count: number }

// 采集关键词多选:每个关键词=一次采集 session。选项来自 /workspace/keywords(该租户采过的关键词去重)。
export function KeywordFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<KeywordItem[]>([])
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.get<any>('/workspace/keywords').then(d => setItems(d.keywords || [])).catch(() => {})
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [])

  const toggle = (kw: string) => onChange(value.includes(kw) ? value.filter(k => k !== kw) : [...value, kw])
  const filtered = q ? items.filter(i => i.keyword.toLowerCase().includes(q.toLowerCase())) : items

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={cn('inline-flex h-8 items-center gap-1 rounded-lg border border-transparent bg-muted px-2.5 text-[12px] font-medium transition-colors hover:bg-muted/70',
          value.length ? 'text-primary' : 'text-muted-foreground')}>
        采集关键词
        {value.length > 0 && <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold text-primary">{value.length}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-60 rounded-lg border border-border bg-card p-2 shadow-lg">
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="筛选关键词…"
              className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-[12px] outline-none focus:border-primary" />
          </div>
          {value.length > 0 && (
            <button onClick={() => onChange([])} className="mb-1 flex w-full items-center gap-1 px-1 text-[11px] text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />清空已选 ({value.length})
            </button>
          )}
          <div className="max-h-60 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="py-4 text-center text-[12px] text-muted-foreground">{items.length ? '无匹配关键词' : '暂无采集关键词'}</div>
            ) : filtered.map(it => (
              <label key={it.keyword} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-[12px] hover:bg-accent">
                <input type="checkbox" checked={value.includes(it.keyword)} onChange={() => toggle(it.keyword)} className="h-3.5 w-3.5 rounded border-border" />
                <span className="flex-1 truncate" title={it.keyword}>{it.keyword}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{it.count}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
