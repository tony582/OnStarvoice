export interface CrossPostMember {
  id: string
  platform: string
  author?: string
  published_at?: string | null
  created_at?: string
  triage_status?: string
  triage_priority?: string
  feishu_table_no?: string
  archived_at?: string | null
  title?: string
  score?: number
  evidence?: unknown
}

export interface CrossPostGroup {
  groupId: string | null
  members: CrossPostMember[]
}

export function crossPostSummary(record: Record<string, unknown>) {
  const count = Math.floor(Number(record.cross_post_count) || 0)
  const platforms = Array.isArray(record.cross_post_platforms)
    ? [...new Set(record.cross_post_platforms.filter((value): value is string => typeof value === 'string' && !!value))]
    : []
  return {
    count: record.cross_post_group_id && count >= 2 ? count : 0,
    otherPlatforms: platforms.filter(platform => platform !== record.platform),
  }
}

export function normalizeCrossPostGroup(value: CrossPostGroup): CrossPostGroup {
  const seen = new Set<string>()
  const members = (Array.isArray(value?.members) ? value.members : []).filter(member => {
    if (!member?.id || seen.has(member.id)) return false
    seen.add(member.id)
    return true
  })
  return { groupId: value?.groupId || null, members }
}

export function crossPostSelectedIds(members: CrossPostMember[], selected: Iterable<string>): string[] {
  const allowed = new Set(members.filter(member => !member.archived_at).map(member => member.id))
  return [...new Set(selected)].filter(id => allowed.has(id))
}

export function defaultCrossPostSelection(members: CrossPostMember[], currentId: string): string[] {
  return crossPostSelectedIds(members, [currentId])
}

// Member summaries must never replace the full record used by the content drawer.
export function crossPostDrawerRecord(record: Record<string, unknown>, member: CrossPostMember) {
  return {
    ...record,
    id: member.id,
    triage_status: member.triage_status || 'unhandled',
    triage_priority: member.triage_priority || 'normal',
    feishu_table_no: member.feishu_table_no || '',
    archived_at: member.archived_at || null,
  }
}
