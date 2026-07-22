import { useState } from 'react'
import { ImageOff, ZoomIn } from 'lucide-react'
import { proxiedImg } from '@/lib/utils'

interface LocalImageEntry {
  source_url?: string
  url?: string
}

function parseImageList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function itemUrl(item: unknown): string {
  if (typeof item === 'string') return item.trim()
  if (!item || typeof item !== 'object') return ''
  return String((item as LocalImageEntry).url || '').trim()
}

function displayableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith('/')
}

/**
 * 正文图优先使用采集时保存的本地副本。尚未落地的图继续尝试平台原地址，
 * 让刚采集的数据立即可见，也让历史记录可以由画廊统一处理失效链接。
 */
export function recordDisplayImages(record: any): string[] {
  if (!record) return []

  const remoteItems = parseImageList(record.image_urls)
  const remoteUrls = remoteItems.map(itemUrl).filter(displayableUrl)
  const localEntries = parseImageList(record.image_local_urls) as LocalImageEntry[]
  const localizedSources = new Set(
    localEntries.map(entry => String(entry?.source_url || '').trim()).filter(Boolean),
  )
  const localUrls = localEntries.map(itemUrl).filter(displayableUrl)

  // 没有正文图时不重复展示顶部封面。
  if (remoteUrls.length === 0 && localUrls.length === 0) return []

  const candidates: string[] = [...localUrls]
  for (const url of remoteUrls) {
    if (!localizedSources.has(url)) candidates.push(url)
  }

  // 旧记录的正文原图可能已经过期，至少保留仍可用的本地封面作为上下文。
  if (localUrls.length === 0) {
    const cover = String(record.cover_local || record.cover_url || '').trim()
    if (displayableUrl(cover)) candidates.unshift(cover)
  }

  const seen = new Set<string>()
  return candidates
    .filter(url => {
      if (seen.has(url)) return false
      seen.add(url)
      return true
    })
    .map(proxiedImg)
}

export function RecordImageGallery({
  images,
  onOpen,
}: {
  images: string[]
  onOpen: (url: string) => void
}) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const visible = images
    .map((url, index) => ({ url, key: `${url}-${index}` }))
    .filter(item => !failed.has(item.key))

  if (images.length === 0) return null

  return (
    <section aria-label="正文图片">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-semibold text-foreground">图片</h4>
        {failed.size > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ImageOff className="h-3.5 w-3.5" />
            {failed.size} 张平台原图已失效
          </span>
        )}
      </div>

      {visible.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {visible.map(item => (
            <button type="button" key={item.key} onClick={() => onOpen(item.url)} title="点击放大"
              className="group relative aspect-square cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted">
              <img src={item.url} alt="" className="h-full w-full object-cover transition group-hover:scale-105"
                referrerPolicy="no-referrer"
                onError={() => setFailed(current => {
                  const next = new Set(current)
                  next.add(item.key)
                  return next
                })} />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100">
                <ZoomIn className="h-4 w-4 text-white" />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex min-h-20 items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-4 text-[12px] text-muted-foreground">
          <ImageOff className="h-4 w-4" />
          平台原图已失效，重新采集后可恢复
        </div>
      )}
    </section>
  )
}
