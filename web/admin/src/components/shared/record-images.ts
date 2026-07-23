import { proxiedImg } from '@/lib/utils'

interface LocalImageEntry {
  source_url?: string
  url?: string
}

interface RecordImageSource {
  image_urls?: unknown
  image_local_urls?: unknown
  cover_local?: unknown
  cover_url?: unknown
}

export interface RecordDisplayImageEntry {
  url: string
  ref: string
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
export function recordDisplayImageEntries(
  record: RecordImageSource | null | undefined,
): RecordDisplayImageEntry[] {
  if (!record) return []

  const remoteItems = parseImageList(record.image_urls)
  const remoteUrls = remoteItems.map(itemUrl).filter(displayableUrl)
  const localEntries = parseImageList(record.image_local_urls) as LocalImageEntry[]
  const localizedSources = new Set(
    localEntries.map(entry => String(entry?.source_url || '').trim()).filter(Boolean),
  )
  const localCandidates = localEntries
    .map(entry => {
      const url = itemUrl(entry)
      return {
        url,
        ref: String(entry?.source_url || '').trim() || url,
      }
    })
    .filter(item => displayableUrl(item.url))

  const candidates: RecordDisplayImageEntry[] = [...localCandidates]
  for (const url of remoteUrls) {
    if (!localizedSources.has(url)) candidates.push({ url, ref: url })
  }

  // 封面也可能承载客户要复制的文字，因此给它同样的按需入口。
  // 若封面与正文图身份相同则只保留正文图，避免一个标识对应两张图。
  const cover = String(record.cover_local || record.cover_url || '').trim()
  const coverRef = String(record.cover_url || '').trim() || cover
  if (displayableUrl(cover) && !candidates.some(item => item.ref === coverRef)) {
    candidates.unshift({ url: cover, ref: coverRef })
  }

  const seenUrls = new Set<string>()
  const seenRefs = new Set<string>()
  return candidates
    .filter(item => {
      if (seenUrls.has(item.url) || seenRefs.has(item.ref)) return false
      seenUrls.add(item.url)
      seenRefs.add(item.ref)
      return true
    })
    .map(item => ({ ...item, url: proxiedImg(item.url) }))
}

export function recordDisplayImages(
  record: RecordImageSource | null | undefined,
): string[] {
  return recordDisplayImageEntries(record).map(item => item.url)
}
