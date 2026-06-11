import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-secondary text-secondary-foreground',
        primary: 'bg-primary/10 text-primary',
        success: 'bg-success/10 text-success',
        warning: 'bg-warning/10 text-warning',
        destructive: 'bg-destructive/10 text-destructive',
        outline: 'border border-border text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

// Tone-to-variant mapping helper
const TONE_MAP: Record<string, BadgeProps['variant']> = {
  positive: 'success', resolved: 'success', sent: 'success', active: 'success', official_responded: 'success',
  negative: 'destructive', critical: 'destructive', high: 'destructive', urgent: 'destructive',
  warning: 'warning', medium: 'warning', reviewing: 'warning',
  neutral: 'primary', generated: 'primary', viewer: 'primary',
  muted: 'outline', archived: 'outline', false_positive: 'outline', skipped: 'outline',
}

export function StatusBadge({ tone, children, className }: { tone?: string; children: React.ReactNode; className?: string }) {
  const variant = (tone && TONE_MAP[tone]) || 'default'
  return <Badge variant={variant} className={className}>{children}</Badge>
}
