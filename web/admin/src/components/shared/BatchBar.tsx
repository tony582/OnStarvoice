import { Fragment, useCallback, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Minus, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 列表多选状态。resetKey 在筛选/翻页变化时改变 → 自动清空已选,避免跨页幽灵选中。
 */
export function useSelection(resetKey: string) {
  const [selection, setSelection] = useState(() => ({
    resetKey,
    ids: new Set<string>(),
  }))
  const resetSelection = new Set<string>()
  if (selection.resetKey !== resetKey) {
    setSelection({ resetKey, ids: resetSelection })
  }
  const selected = selection.resetKey === resetKey ? selection.ids : resetSelection

  const toggle = useCallback((id: string) => {
    setSelection(previous => {
      const next = new Set(previous.resetKey === resetKey ? previous.ids : [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { resetKey, ids: next }
    })
  }, [resetKey])

  const setAll = useCallback((ids: string[], checked: boolean) => {
    setSelection({ resetKey, ids: checked ? new Set(ids) : new Set() })
  }, [resetKey])

  const clear = useCallback(() => {
    setSelection({ resetKey, ids: new Set() })
  }, [resetKey])

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
  separatorBefore?: boolean
}

export type BatchActionMenu = {
  key: string
  label: string
  icon?: React.ElementType
  tone?: 'default' | 'primary'
  actions: BatchAction[]
}

/**
 * 浮动批量操作条。选中数 > 0 时从底部浮起,居中显示,操作执行期间禁用并转圈。
 */
export function BatchBar({ count, actions, menus = [], onAction, onClear, busy }: {
  count: number
  actions: BatchAction[]
  menus?: BatchActionMenu[]
  onAction: (key: string) => void
  onClear: () => void
  busy?: boolean
}) {
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)

  if (openMenuKey !== null && (count <= 0 || busy)) {
    setOpenMenuKey(null)
  }

  const runAction = useCallback((key: string) => {
    setOpenMenuKey(null)
    onAction(key)
  }, [onAction])

  const clearSelection = useCallback(() => {
    setOpenMenuKey(null)
    onClear()
  }, [onClear])

  if (count <= 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+3.75rem)] z-40 flex justify-center px-3 sm:px-4 lg:bottom-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        role="toolbar"
        aria-label="批量处理"
        aria-busy={busy || undefined}
        className="mobile-table-scroll pointer-events-auto flex max-w-full items-center overflow-x-auto rounded-lg border-2 border-primary/30 bg-card shadow-[0_16px_40px_-12px_rgba(15,23,42,0.35)] animate-in fade-in slide-in-from-bottom-3 duration-200"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 bg-primary px-4 text-primary-foreground lg:h-11">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          <span className="text-[12px] font-semibold" aria-live="polite">{busy ? '处理中' : '批量处理'}</span>
          <span className="rounded bg-white/20 px-1.5 py-0.5 text-[12px] font-bold tabular-nums">{count} 条</span>
        </div>
        <div className="flex items-center gap-1 px-2">
          {actions.map(action => {
            const Icon = action.icon
            return (
              <Fragment key={action.key}>
                {action.separatorBefore && <div className="mx-1 h-6 w-px shrink-0 bg-border" />}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => runAction(action.key)}
                  className={cn(
                    'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold transition-colors disabled:opacity-50 lg:h-8',
                    action.tone === 'danger'
                      ? 'text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                      : 'text-foreground hover:bg-accent hover:text-primary',
                  )}
                >
                  {Icon && <Icon className="h-3.5 w-3.5" />}
                  {action.label}
                </button>
              </Fragment>
            )
          })}
          {menus.map(menu => {
            const MenuIcon = menu.icon
            return (
              <DropdownMenu.Root
                key={menu.key}
                open={openMenuKey === menu.key}
                onOpenChange={open => setOpenMenuKey(open ? menu.key : null)}
              >
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    disabled={busy}
                    className={cn(
                      'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold transition-colors disabled:opacity-50 lg:h-8',
                      menu.tone === 'primary'
                        ? 'bg-primary/10 text-primary hover:bg-primary/15'
                        : 'text-foreground hover:bg-accent hover:text-primary',
                    )}
                  >
                    {MenuIcon && <MenuIcon className="h-3.5 w-3.5" />}
                    {menu.label}
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    side="top"
                    align="start"
                    sideOffset={8}
                    className="z-[90] min-w-44 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
                  >
                    {menu.actions.map(action => {
                      const Icon = action.icon
                      return (
                        <Fragment key={action.key}>
                          {action.separatorBefore && <DropdownMenu.Separator className="my-1 h-px bg-border/70" />}
                          <DropdownMenu.Item
                            onSelect={() => runAction(action.key)}
                            className={cn(
                              'flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-[12px] font-medium outline-none data-[highlighted]:bg-accent data-[highlighted]:text-primary',
                              action.tone === 'danger' && 'text-rose-600 data-[highlighted]:bg-rose-50 dark:data-[highlighted]:bg-rose-950/30',
                            )}
                          >
                            {Icon && <Icon className="h-3.5 w-3.5" />}
                            {action.label}
                          </DropdownMenu.Item>
                        </Fragment>
                      )
                    })}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )
          })}
          <div className="mx-1 h-6 w-px shrink-0 bg-border" />
          <button
            type="button"
            disabled={busy}
            onClick={clearSelection}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 lg:h-8 lg:w-8"
            aria-label="取消选择"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
