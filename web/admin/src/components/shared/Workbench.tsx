import { cn } from '@/lib/utils'

type WorkbenchTab = {
  key: string
  label: string
  count?: number | string
}

export function WorkbenchTabs({
  tabs,
  activeKey,
  onChange,
  className,
}: {
  tabs: WorkbenchTab[]
  activeKey: string
  onChange: (key: string) => void
  className?: string
}) {
  return (
    <div className={cn('border-b border-border', className)}>
      <div className="flex min-h-9 items-end gap-1 overflow-x-auto">
        {tabs.map(tab => {
          const active = activeKey === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={cn(
                'mb-[-1px] inline-flex h-8 flex-none items-center gap-2 rounded-t-md border border-transparent px-3 text-[13px] font-medium transition-colors',
                active
                  ? 'border-border border-b-card bg-card text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {tab.count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function WorkbenchToolbar({
  children,
  meta,
  className,
}: {
  children: React.ReactNode
  meta?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 py-3', className)}>
      {meta ? <div className="min-w-0 text-[13px] text-muted-foreground">{meta}</div> : null}
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  )
}

export function WorkbenchSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props
  return (
    <select
      {...rest}
      className={cn(
        'h-8 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground outline-none transition-colors',
        'hover:border-input focus:border-primary focus:ring-2 focus:ring-primary/10',
        className,
      )}
    />
  )
}

export function WorkbenchTableShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('overflow-hidden rounded-xl border border-border bg-card shadow-xs', className)}>
      {children}
    </section>
  )
}
