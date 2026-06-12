import { useState, useEffect, useCallback } from 'react'
import { Check, Minus, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 列表多选状态。resetKey 在筛选/翻页变化时改变 → 自动清空已选,避免跨页幽灵选中。
 */
export function useSelection(resetKey: string) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => { setSelected(new Set()) }, [resetKey])

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const setAll = useCallback((ids: string[], checked: boolean) => {
    setSelected(checked ? new Set(ids) : new Set())
  }, [])

  const clear = useCallback(() => setSelected(new Set()), [])

  return {
    selected,
    count: selected.size,
    has: (id: string) => selected.has(id),
    toggle,
    setAll,
    clear,
  }
}

/** 复选框(三态:勾选 / 半选 / 未选)。 */
export function Checkbox({ checked, indeterminate, onChange, className }: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      onClick={e => { e.stopPropagation(); onChange() }}
      className={cn(
        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors',
        checked || indeterminate
          ? 'border-primary bg-primary text-white'
          : 'border-input bg-card hover:border-primary/60',
        className,
      )}
    >
      {indeterminate ? <Minus className="h-3 w-3" strokeWidth={3} /> : checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
    </button>
  )
}

export type BatchAction = {
  key: string
  label: string
  icon?: React.ElementType
  tone?: 'default' | 'danger'
}

/**
 * 浮动批量操作条。选中数 > 0 时从底部浮起,居中显示,操作执行期间禁用并转圈。
 */
export function BatchBar({ count, actions, onAction, onClear, busy }: {
  count: number
  actions: BatchAction[]
  onAction: (key: string) => void
  onClear: () => void
  busy?: boolean
}) {
  if (count <= 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-border bg-card/95 p-1.5 pl-3 shadow-lg backdrop-blur animate-in fade-in slide-in-from-bottom-3 duration-200">
        <span className="flex items-center gap-2 pr-1 text-[13px] font-semibold text-foreground">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          已选 <span className="tabular-nums text-primary">{count}</span> 项
        </span>
        <div className="h-5 w-px bg-border" />
        {actions.map(action => {
          const Icon = action.icon
          return (
            <button
              key={action.key}
              type="button"
              disabled={busy}
              onClick={() => onAction(action.key)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:opacity-50',
                action.tone === 'danger'
                  ? 'text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                  : 'text-foreground hover:bg-muted',
              )}
            >
              {Icon && <Icon className="h-3.5 w-3.5" />}
              {action.label}
            </button>
          )
        })}
        <div className="h-5 w-px bg-border" />
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="取消选择"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
