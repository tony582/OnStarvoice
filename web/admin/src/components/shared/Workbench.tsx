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
    <div className={cn('border-b border-border/50 pb-2', className)}>
      <div className="flex min-h-8 items-center gap-0.5 overflow-x-auto">
        {tabs.map(tab => {
          const active = activeKey === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={cn(
                'inline-flex h-8 flex-none items-center gap-2 rounded-lg px-2.5 text-[12.5px] font-semibold transition-colors',
                active
                  ? 'bg-accent text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
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
        'h-8 rounded-lg border-transparent bg-transparent px-2 text-[12px] font-semibold text-foreground outline-none transition-colors',
        'hover:bg-muted focus:bg-muted focus:ring-2 focus:ring-primary/10',
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
    <section className={cn('overflow-hidden rounded-xl bg-card', className)}>
      {children}
    </section>
  )
}
