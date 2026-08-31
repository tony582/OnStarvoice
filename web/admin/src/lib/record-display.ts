type LooseRecord = Record<string, unknown>

const DOUYIN_ID = /^\d{8,}$/u
const XHS_ID = /^[A-Za-z0-9_-]{8,}$/u
const IMAGE_TYPES = new Set([
  'image', 'images', 'image_text', 'image-text', 'image_note', 'image-note',
  'picture', 'photo', 'note', '图文', '图片',
])
const VIDEO_TYPES = new Set(['video', '视频'])

function objectValue(value: unknown): LooseRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as LooseRecord
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as LooseRecord
      : {}
  } catch {
    return {}
  }
}

function directDouyinUrl(value: unknown) {
  if (!value) return null
  try {
    const parsed = new URL(String(value).trim())
    if (!/(^|\.)douyin\.com$/iu.test(parsed.hostname)) return null
    const matched = parsed.pathname.match(/^\/(video|note)\/(\d{8,})(?:\/|$)/iu)
    if (!matched) return null
    return {
      kind: matched[1].toLowerCase(),
      id: matched[2],
      url: `https://www.douyin.com/${matched[1].toLowerCase()}/${matched[2]}`,
    }
  } catch {
    return null
  }
}

function payloadParts(record: LooseRecord) {
  const payload = objectValue(record.payload)
  const firstItem = Array.isArray(payload.items)
    ? objectValue(payload.items.find(item => item && typeof item === 'object'))
    : {}
  const detailPayload = objectValue(payload.detailPayload)
  const itemDetailPayload = objectValue(firstItem.detailPayload)
  return { payload, firstItem, detailPayload, itemDetailPayload }
}

function douyinDirectCandidates(record: LooseRecord) {
  const { payload, firstItem, detailPayload, itemDetailPayload } = payloadParts(record)
  return [
    record.canonical_url,
    record.url,
    payload.detailCaptureNoteUrl,
    payload.noteUrl,
    payload.url,
    detailPayload.noteUrl,
    detailPayload.url,
    firstItem.detailCaptureNoteUrl,
    firstItem.noteUrl,
    firstItem.url,
    itemDetailPayload.noteUrl,
    itemDetailPayload.url,
  ].map(directDouyinUrl).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
}

function normalizedContentId(value: unknown) {
  const normalized = String(value || '').trim()
  return DOUYIN_ID.test(normalized) ? normalized : ''
}

function normalizedXhsContentId(value: unknown) {
  const normalized = String(value || '').trim()
  return XHS_ID.test(normalized) ? normalized : ''
}

function directXhsUrl(value: unknown) {
  if (!value) return null
  try {
    const parsed = new URL(String(value).trim())
    if (!/(^|\.)xiaohongshu\.com$/iu.test(parsed.hostname)) return null
    const matched = parsed.pathname.match(
      /^\/(?:explore|search_result|discovery\/item|note|video)\/([A-Za-z0-9_-]{8,})(?:\/|$)/iu,
    )
    return matched
      ? { id: matched[1], url: `https://www.xiaohongshu.com/explore/${matched[1]}` }
      : null
  } catch {
    return null
  }
}

function xhsOriginalUrl(record: LooseRecord) {
  const { payload, firstItem, detailPayload, itemDetailPayload } = payloadParts(record)
  const candidates = [
    record.canonical_url,
    record.url,
    payload.detailCaptureNoteUrl,
    payload.noteUrl,
    payload.url,
    detailPayload.noteUrl,
    detailPayload.url,
    firstItem.detailCaptureNoteUrl,
    firstItem.noteUrl,
    firstItem.url,
    itemDetailPayload.noteUrl,
    itemDetailPayload.url,
  ].map(directXhsUrl).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
  const id = normalizedXhsContentId(record.external_id)
  const direct = candidates.find(candidate => !id || candidate.id === id)
  if (direct) return direct.url
  return id ? `https://www.xiaohongshu.com/explore/${id}` : ''
}

function douyinContentId(record: LooseRecord, directCandidates: ReturnType<typeof douyinDirectCandidates>) {
  const { payload, firstItem, detailPayload, itemDetailPayload } = payloadParts(record)
  for (const value of [
    record.external_id,
    record.note_id,
    record.noteId,
    payload.noteId,
    payload.awemeId,
    detailPayload.noteId,
    detailPayload.awemeId,
    firstItem.noteId,
    firstItem.awemeId,
    itemDetailPayload.noteId,
    itemDetailPayload.awemeId,
    ...directCandidates.map(candidate => candidate.id),
  ]) {
    const id = normalizedContentId(value)
    if (id) return id
  }
  for (const value of [record.url, record.canonical_url]) {
    try {
      const id = normalizedContentId(new URL(String(value || '')).searchParams.get('modal_id'))
      if (id) return id
    } catch {
      // Keep the original link when identity cannot be proven.
    }
  }
  return ''
}

function douyinContentKind(record: LooseRecord) {
  const { payload, firstItem, detailPayload, itemDetailPayload } = payloadParts(record)
  for (const value of [
    record.note_type,
    record.noteType,
    payload.noteType,
    payload.note_type,
    detailPayload.noteType,
    detailPayload.note_type,
    firstItem.noteType,
    firstItem.note_type,
    itemDetailPayload.noteType,
    itemDetailPayload.note_type,
  ]) {
    const type = String(value || '').trim().toLowerCase()
    if (IMAGE_TYPES.has(type)) return 'note'
    if (VIDEO_TYPES.has(type)) return 'video'
  }
  return ''
}

export function resolveRecordOriginalUrl(value: unknown): string {
  const record = objectValue(value)
  const platform = String(record.platform || '').trim().toLowerCase()
  const hasDouyinUrl = [record.url, record.canonical_url]
    .some(url => /(^|\.)douyin\.com(?:\/|$)/iu.test(String(url || '').replace(/^https?:\/\//iu, '')))
  if (platform === 'douyin' || hasDouyinUrl) {
    const directCandidates = douyinDirectCandidates(record)
    const contentId = douyinContentId(record, directCandidates)
    const direct = directCandidates.find(candidate => !contentId || candidate.id === contentId)
    if (direct) return direct.url
    const kind = douyinContentKind(record)
    if (contentId && kind) return `https://www.douyin.com/${kind}/${contentId}`
  }
  const hasXhsUrl = [record.url, record.canonical_url]
    .some(url => /(^|\.)xiaohongshu\.com(?:\/|$)/iu.test(String(url || '').replace(/^https?:\/\//iu, '')))
  if (platform === 'xiaohongshu' || hasXhsUrl) {
    // Xiaohongshu xsec links are temporary capabilities tied to the search
    // context and Chrome Profile. Callers must use RecordSourceAction so an
    // online capture Agent refreshes the link locally; never render a stale href.
    return ''
  }
  return String(record.canonical_url || record.url || '')
}

function detailCaptureStatus(record: LooseRecord) {
  const { payload, firstItem } = payloadParts(record)
  return String(
    payload.detailCaptureStatus
      || firstItem.detailCaptureStatus
      || record.detail_capture_status
      || '',
  ).trim().toLowerCase()
}

export function isRecordDetailDegraded(value: unknown): boolean {
  const record = objectValue(value)
  const title = String(record.title || '').trim()
  const content = String(record.content || '').trim()
  const placeholder = /^抖音搜索结果\s+\d+$/u.test(title)
  const failed = ['failed', 'partial', 'error'].includes(detailCaptureStatus(record))
  return failed && (placeholder || (!title && !content))
}

export function recordDisplayTitle(value: unknown, fallback = '(无标题)'): string {
  const record = objectValue(value)
  if (isRecordDetailDegraded(record)) {
    const id = normalizedContentId(record.external_id)
      || normalizedXhsContentId(record.external_id)
      || String(record.title || '').match(/\d{8,}/u)?.[0]
      || ''
    return id ? `详情待补采 · ${id}` : '详情待补采'
  }
  return String(record.title || record.content || fallback)
}
