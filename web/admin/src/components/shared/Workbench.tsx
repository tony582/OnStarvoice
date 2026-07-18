import { cn } from '@/lib/utils'
import { MoveHorizontal } from 'lucide-react'

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
      <div className="mobile-table-scroll flex min-h-10 items-center gap-0.5 overflow-x-auto lg:min-h-8">
        {tabs.map(tab => {
          const active = activeKey === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={cn(
                'inline-flex h-10 flex-none items-center gap-2 rounded-lg px-3 text-[12.5px] font-semibold transition-colors lg:h-8 lg:px-2.5',
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
    <div className={cn('flex flex-col items-stretch gap-2.5 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3', className)}>
      {meta ? <div className="min-w-0 text-[13px] leading-5 text-muted-foreground sm:w-auto">{meta}</div> : null}
      <div className="flex min-w-0 w-full flex-1 flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
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
        'h-10 max-w-full rounded-lg border-transparent bg-transparent px-2.5 text-[12px] font-semibold text-foreground outline-none transition-colors lg:h-8 lg:px-2',
        'hover:bg-muted focus:bg-muted focus:ring-2 focus:ring-primary/10',
        className,
      )}
    />
  )
}

export function WorkbenchTableShell({
  children,
  className,
  mobileHint = true,
}: {
  children: React.ReactNode
  className?: string
  mobileHint?: boolean
}) {
  return (
    <section className={cn('overflow-hidden rounded-xl bg-card', className)}>
      {mobileHint && (
        <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/25 px-3 py-2 text-[11px] font-medium text-muted-foreground lg:hidden">
          <MoveHorizontal className="h-3.5 w-3.5" />
          左右滑动查看完整信息
        </div>
      )}
      <div className="mobile-table-scroll overflow-x-auto">
        {children}
      </div>
    </section>
  )
}
