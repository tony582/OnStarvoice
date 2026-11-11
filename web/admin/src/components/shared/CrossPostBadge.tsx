import { BookOpen, FileText, Globe, Music2, Video } from 'lucide-react'
import { crossPostSummary } from '@/lib/cross-posts'
import { cn, platformName } from '@/lib/utils'

export function CrossPostPlatformIcon({ platform }: { platform: string }) {
  const Icon = platform === 'douyin' ? Music2 : platform === 'xiaohongshu' ? BookOpen
    : platform === 'wechat_channels' ? Video : platform === 'wechat_articles' ? FileText : Globe
  return (
    <span role="img" aria-label={platformName(platform)} title={platformName(platform)}
      className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded',
        platform === 'xiaohongshu' ? 'bg-rose-500/10 text-rose-600 dark:text-rose-300'
          : platform.startsWith('wechat_') ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'bg-muted text-foreground')}>
      <Icon className="h-3 w-3" />
    </span>
  )
}

export function CrossPostBadge({ record }: { record: Record<string, unknown> }) {
  const { count, otherPlatforms } = crossPostSummary(record)
  if (!count) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] text-primary"
      title={`同组 ${count} 条内容；处理状态各自独立`}>
      多平台 ×{count}
      {otherPlatforms.map(platform => <CrossPostPlatformIcon key={platform} platform={platform} />)}
    </span>
  )
}
