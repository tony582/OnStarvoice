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

function imageSourceIdentity(value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    const hostname = parsed.hostname.toLowerCase()
    const isDouyinImageHost = [
      'douyinpic.com',
      'byteimg.com',
      'pstatp.com',
      'bytecdn.cn',
    ].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
    if (isDouyinImageHost) {
      const pathSegments = parsed.pathname.split('/').filter(Boolean)
      const lastSegment = decodeURIComponent(
        pathSegments[pathSegments.length - 1] || '',
      )
      const assetToken = lastSegment.split('~')[0].trim()
      if (assetToken) return `douyin:${assetToken}`
    }
  } catch {
    // 本地 /media 地址和非标准值继续按原值去重。
  }
  return raw
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
    localEntries
      .map(entry => imageSourceIdentity(String(entry?.source_url || '').trim()))
      .filter(Boolean),
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
    if (!localizedSources.has(imageSourceIdentity(url))) candidates.push({ url, ref: url })
  }

  // 封面也可能承载客户要复制的文字，因此给它同样的按需入口。
  // 若封面与正文图身份相同则只保留正文图，避免一个标识对应两张图。
  const cover = String(record.cover_local || record.cover_url || '').trim()
  const coverRef = String(record.cover_url || '').trim() || cover
  const coverIdentity = imageSourceIdentity(coverRef)
  if (
    displayableUrl(cover) &&
    !candidates.some(item => imageSourceIdentity(item.ref) === coverIdentity)
  ) {
    candidates.unshift({ url: cover, ref: coverRef })
  }

  const seenUrls = new Set<string>()
  const seenRefs = new Set<string>()
  const seenSourceIdentities = new Set<string>()
  return candidates
    .filter(item => {
      const identity = imageSourceIdentity(item.ref || item.url)
      if (
        seenUrls.has(item.url) ||
        seenRefs.has(item.ref) ||
        (identity && seenSourceIdentities.has(identity))
      ) return false
      seenUrls.add(item.url)
      seenRefs.add(item.ref)
      if (identity) seenSourceIdentities.add(identity)
      return true
    })
    .map(item => ({ ...item, url: proxiedImg(item.url) }))
}

export function recordDisplayImages(
  record: RecordImageSource | null | undefined,
): string[] {
  return recordDisplayImageEntries(record).map(item => item.url)
}
