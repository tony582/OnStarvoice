import { cn } from '@/lib/utils'

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-card px-3 text-[13px]',
        'placeholder:text-muted-foreground/50',
        'transition-colors duration-150',
        'hover:border-muted-foreground/35',
        'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10',
        className,
      )}
      {...props}
    />
  )
}
