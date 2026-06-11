import { cn } from '@/lib/utils'

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-xl border border-border bg-card px-3.5 text-[14px] shadow-sm',
        'placeholder:text-muted-foreground/50',
        'transition-all duration-200',
        'hover:border-primary/30',
        'focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/15',
        className,
      )}
      {...props}
    />
  )
}
