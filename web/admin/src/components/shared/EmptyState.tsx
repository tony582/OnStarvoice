import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps { icon: LucideIcon; title: string; description?: string }

export function EmptyState({ icon: Icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted/40">
        <Icon className="h-5 w-5 text-muted-foreground/60" strokeWidth={1.5} />
      </div>
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {description && <p className="mt-1.5 max-w-[300px] text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  )
}
