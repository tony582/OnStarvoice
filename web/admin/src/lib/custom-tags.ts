export const MAX_CUSTOM_TAGS = 10
export const MAX_CUSTOM_TAG_NAME = 24

export interface CustomTag {
  id: string
  name: string
  usageCount?: number
  lastUsedAt?: string
}

export interface CustomTagPatch {
  addTagIds: string[]
  addNames: string[]
  removeTagIds: string[]
}

export function normalizeCustomTags(value: unknown): CustomTag[] {
  let list = value
  if (typeof list === 'string' && list.trim()) {
    try { list = JSON.parse(list) } catch { return [] }
  }
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const tags: CustomTag[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = String(row.id || '').trim()
    const name = String(row.name || '').trim()
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    tags.push({
      id,
      name,
      usageCount: numberOrUndefined(row.usageCount ?? row.usage_count),
      lastUsedAt: textOrUndefined(row.lastUsedAt ?? row.last_used_at),
    })
  }
  return tags
}

export function tagsFromRecord(record: unknown): CustomTag[] {
  if (!record || typeof record !== 'object') return []
  const row = record as Record<string, unknown>
  return normalizeCustomTags(row.customTags ?? row.custom_tags)
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function textOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}
