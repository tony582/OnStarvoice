import { LABELS } from './utils'

export interface TriageDisplayRecord {
  id?: string
  triage_status?: string
  triage_display_status?: string
  triage_display_reason?: string
  archived_at?: string | null
}

export function triageDisplay(record: TriageDisplayRecord) {
  const stored = record.triage_status || 'unhandled'
  // A local status edit can precede the next list response. Never let older
  // admission metadata overwrite a real reviewed status or archived lifecycle.
  const status = stored !== 'unhandled' || record.archived_at ? stored : record.triage_display_status || stored
  return {
    status,
    label: status === 'not_admitted' ? '未进入工作列表' : status === 'watched_not_pending' ? '已关注（不计待处理）' : LABELS.triage[status] || status,
    reason: status === 'not_admitted' ? record.triage_display_reason || '未通过工作列表准入' : status === 'watched_not_pending' ? record.triage_display_reason || '已关注的无关内容保留在工作列表，不计入待处理数量' : '',
  }
}
