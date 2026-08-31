import { ExternalLink, Link2Off } from 'lucide-react'

import { cn } from '@/lib/utils'
import { resolveRecordOriginalUrl } from '@/lib/record-display'

interface RecordSourceActionProps {
  record: SourceRecord
  compact?: boolean
  className?: string
}

type SourceRecord = Record<string, unknown> & {
  platform?: unknown
  url?: unknown
  canonical_url?: unknown
  external_id?: unknown
  externalId?: unknown
}

function xhsNoteIdFromUrl(value: unknown) {
  try {
    const url = new URL(String(value || '').trim())
    const host = url.hostname.toLowerCase()
    const directMatch = url.pathname.match(
      /^\/(?:explore|search_result|discovery\/item|note|video)\/([A-Za-z0-9_-]{8,})(?:\/|$)/iu,
    )
    const profileMatch = url.pathname.match(
      /^\/user\/profile\/[A-Za-z0-9_-]{6,100}\/([A-Za-z0-9_-]{8,})(?:\/|$)/iu,
    )
    if (
      url.protocol !== 'https:' ||
      (host !== 'xiaohongshu.com' && !host.endsWith('.xiaohongshu.com')) ||
      url.username ||
      url.password
    ) {
      return ''
    }
    return directMatch?.[1] || profileMatch?.[1] || ''
  } catch {
    return ''
  }
}

function validatedStoredXhsUrl(record: SourceRecord) {
  const sourceUrl = String(record?.url || '').trim()
  const routeNoteId = xhsNoteIdFromUrl(sourceUrl)
  const expectedNoteId = String(record?.external_id || record?.externalId || '').trim()
    || xhsNoteIdFromUrl(record?.canonical_url)
  let parsed: URL
  try {
    parsed = new URL(sourceUrl)
  } catch {
    return ''
  }
  const xsecToken = String(parsed.searchParams.get('xsec_token') || '').trim()
  if (
    !routeNoteId ||
    !xsecToken ||
    (parsed.port && parsed.port !== '443') ||
    (expectedNoteId && routeNoteId.toLowerCase() !== expectedNoteId.toLowerCase())
  ) {
    return ''
  }
  return parsed.toString()
}

export function RecordSourceAction({
  record,
  compact = false,
  className = '',
}: RecordSourceActionProps) {
  const platform = String(record?.platform || '').trim().toLowerCase()
  const hasXhsUrl = [record?.url, record?.canonical_url]
    .some(url => /(^|\.)xiaohongshu\.com(?:\/|$)/iu.test(String(url || '').replace(/^https?:\/\//iu, '')))
  const isXhs = platform === 'xiaohongshu' || hasXhsUrl
  const originalUrl = isXhs
    ? validatedStoredXhsUrl(record)
    : resolveRecordOriginalUrl(record)

  if (originalUrl) {
    return (
      <a
        href={originalUrl}
        target="_blank"
        rel="noreferrer"
        onClick={event => event.stopPropagation()}
        className={cn('inline-flex shrink-0 items-center gap-0.5 font-medium text-primary hover:underline', className)}
      >
        <ExternalLink className={compact ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} />原文
      </a>
    )
  }
  if (!isXhs) return null
  return (
    <span
      title="采集时未保存可核验的完整原文链接"
      aria-label="原文不可用：采集时未保存完整链接"
      className={cn('inline-flex shrink-0 items-center gap-0.5 text-muted-foreground', className)}
    >
      <Link2Off className={compact ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} />
      原文不可用
    </span>
  )
}
