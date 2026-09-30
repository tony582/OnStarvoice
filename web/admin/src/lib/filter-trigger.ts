import { cn } from '@/lib/utils'

/**
 * 筛选条 pill 触发器的统一外观：未激活为灰底灰字，激活后换成浅蓝底蓝字，
 * 让「当前哪些筛选在生效」不用逐个点开就能一眼看出来。
 */
export function filterTriggerClass(active: boolean, className?: string) {
  return cn(
    'inline-flex h-10 max-w-full min-w-0 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-transparent px-3 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 lg:h-8 lg:px-2.5',
    active
      ? 'bg-primary/10 text-primary hover:bg-primary/15'
      : 'bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground',
    className,
  )
}
