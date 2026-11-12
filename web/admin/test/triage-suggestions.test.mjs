import test from 'node:test'
import assert from 'node:assert/strict'
import { openTriageSuggestion, suggestionSelectionIds, formatTriageSuggestionReason, TRIAGE_SUGGESTION_RULE_VERSION } from '../src/lib/triage-suggestions.ts'

const suggestion = { suggestion: 'non_monitor', ruleVersion: TRIAGE_SUGGESTION_RULE_VERSION, reason: { summary: '其它通用内容，与搜索词不匹配，无服务主题词' } }
test('suggestion badge never replaces a real triage status or reopens an archived row', () => {
  assert.equal(openTriageSuggestion({ triage_status: 'unhandled', triageSuggestion: suggestion }), suggestion)
  assert.equal(openTriageSuggestion({ triage_status: 'reviewed', triageSuggestion: suggestion }), null)
  assert.equal(openTriageSuggestion({ archived_at: '2026-11-12', triageSuggestion: suggestion }), null)
  assert.equal(openTriageSuggestion({ triage_status: 'unhandled', triageSuggestion: null }), null)
  assert.equal(formatTriageSuggestionReason(suggestion.reason), suggestion.reason.summary)
})

test('all-matching suggestion selection excludes unchecked IDs across pages and deduplicates IDs', () => {
  const rows = Array.from({ length: 35 }, (_, index) => ({ id: String(index), title: `内容${index}`, triageSuggestion: suggestion }))
  const ids = suggestionSelectionIds([...rows, rows[0]], new Set(['1', '33', 'no-longer-matching']))
  assert.equal(ids.length, 33)
  assert.equal(ids.includes('1'), false)
  assert.equal(ids.includes('33'), false)
  assert.equal(ids.includes('34'), true)
})
