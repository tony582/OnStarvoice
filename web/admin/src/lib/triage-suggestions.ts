import { formatTriageSuggestionReason, TRIAGE_SUGGESTION_RULE_VERSION } from '../../../../shared/triage-suggestions.mjs'

export { formatTriageSuggestionReason, TRIAGE_SUGGESTION_RULE_VERSION }
export interface TriageSuggestion {
  suggestion: 'non_monitor'
  ruleVersion: string
  reason: Record<string, unknown>
}
export interface SuggestionSummary {
  enabled: boolean
  count: number
  stats: { accepted: number; rejected: number; superseded: number; acceptanceRate: number | null }
}
export interface SuggestionBatchResult {
  updatedIds?: string[]
  statusById?: Record<string, string>
  acceptedIds?: string[]
  undoId?: string
  undoExpiresAt?: string
}
export interface SuggestionUndoResult { restored: number; restoredIds: string[]; skipped: unknown[] }
export interface SuggestionSelection { id: string; title: string; triageSuggestion: TriageSuggestion }

export function openTriageSuggestion(record: Record<string, unknown>): TriageSuggestion | null {
  const suggestion = record.triageSuggestion as TriageSuggestion | undefined
  return !record.archived_at && (!record.triage_status || record.triage_status === 'unhandled')
    && suggestion?.suggestion === 'non_monitor' ? suggestion : null
}

export function suggestionSelectionIds(selection: SuggestionSelection[], excludedIds: Set<string>): string[] {
  return [...new Set(selection.filter(row => !excludedIds.has(row.id)).map(row => row.id))]
}
