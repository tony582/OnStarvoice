export interface XhsRecordNavigation {
  platform?: string | null
  url?: string | null
  external_id?: string | null
  canonical_url?: string | null
}

const XHS_NOTE_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/u

function isXhsHost(hostname: string) {
  const host = String(hostname || '').trim().toLowerCase()
  return host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com')
}

export function noteIdFromXhsPath(pathname: string) {
  const standard = pathname.match(
    /^\/(?:explore|search_result|discovery\/item|note|video)\/([A-Za-z0-9_-]{8,100})\/?$/u,
  )
  if (standard) return standard[1]
  return pathname.match(
    /^\/user\/profile\/[A-Za-z0-9_-]{6,100}\/([A-Za-z0-9_-]{8,100})\/?$/u,
  )?.[1] || ''
}

export function validatedSavedXhsSourceUrl(value: string, expectedNoteId: string) {
  const expected = String(expectedNoteId || '').trim()
  if (!XHS_NOTE_ID_PATTERN.test(expected)) return ''
  try {
    const url = new URL(value)
    const actualNoteId = noteIdFromXhsPath(url.pathname)
    const xsecToken = String(url.searchParams.get('xsec_token') || '').trim()
    if (
      url.protocol !== 'https:' ||
      !isXhsHost(url.hostname) ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      actualNoteId !== expected ||
      !xsecToken
    ) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

export function targetNoteIdFromRecord(record: XhsRecordNavigation) {
  const externalId = String(record.external_id || '').trim()
  if (XHS_NOTE_ID_PATTERN.test(externalId)) return externalId
  try {
    const canonical = new URL(String(record.canonical_url || ''))
    if (
      canonical.protocol !== 'https:' ||
      !isXhsHost(canonical.hostname) ||
      (canonical.port && canonical.port !== '443') ||
      canonical.username ||
      canonical.password
    ) {
      return ''
    }
    return noteIdFromXhsPath(canonical.pathname)
  } catch {
    return ''
  }
}

export function isXhsRecord(record: XhsRecordNavigation) {
  if (String(record.platform || '').trim().toLowerCase() === 'xiaohongshu') return true
  return [record.url, record.canonical_url].some(value => {
    try {
      return isXhsHost(new URL(String(value || '')).hostname)
    } catch {
      return false
    }
  })
}
