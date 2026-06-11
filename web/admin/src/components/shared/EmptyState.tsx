import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps { icon: LucideIcon; title: string; description?: string }

export function EmptyState({ icon: Icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-muted to-muted/50 ring-1 ring-inset ring-border">
        <Icon className="h-7 w-7 text-muted-foreground/50" strokeWidth={1.4} />
      </div>
      <h3 className="text-[15px] font-bold">{title}</h3>
      {description && <p className="mt-1.5 max-w-[280px] text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  )
}
