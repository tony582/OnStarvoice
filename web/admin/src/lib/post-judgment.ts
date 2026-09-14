export const POST_INTENT_OPTIONS = [
  { value: 'share', label: '分享' },
  { value: 'other', label: '其他' },
  { value: 'complaint', label: '投诉/抱怨' },
  { value: 'inquiry', label: '咨询' },
] as const

export type PostIntent = typeof POST_INTENT_OPTIONS[number]['value']
export type PostRelevance = 'relevant' | 'uncertain' | 'irrelevant'

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { /* Invalid historical JSON is unjudged. */ }
  }
  return {}
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

export function normalizePostIntent(value: unknown): PostIntent | null {
  const normalized = text(value).toLowerCase()
  if (normalized === 'suggestion') return 'other'
  return POST_INTENT_OPTIONS.some(option => option.value === normalized) ? normalized as PostIntent : null
}

export function normalizePostIntentFilter(value: unknown): PostIntent[] {
  const values = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(values.map(normalizePostIntent).filter((intent): intent is PostIntent => intent !== null))]
}

// No filter, including “全选”, retains records whose intent has not been judged.
export function appendPostIntentFilter(params: URLSearchParams, intents: string[]): void {
  const selected = normalizePostIntentFilter(intents)
  if (selected.length === POST_INTENT_OPTIONS.length) return
  selected.forEach(intent => params.append('intent', intent))
}

function relevance(value: unknown): PostRelevance | null {
  return value === 'relevant' || value === 'uncertain' || value === 'irrelevant' ? value : null
}

export function postJudgment(value: unknown) {
  const record = object(value)
  const ai = object(record.ai_result)
  const overrides = object(record.manual_overrides)
  const manual = object(overrides.relevance)
  const manualRelevance = relevance(manual.value) || relevance(overrides.relevance)
  const intent = normalizePostIntent('intent_display' in record ? record.intent_display : record.intent || ai.intent)
  const monitoring = object(ai.monitoringEvidence)
  const effectiveRelevance = manualRelevance || relevance(ai.relevance)
  const relevanceLabel = effectiveRelevance === 'relevant' ? '明确相关'
    : effectiveRelevance === 'uncertain' ? '待核实'
      : effectiveRelevance === 'irrelevant' ? '无关' : '待判断'
  const rawConfidence = ai.relevanceConfidence
  const confidence = (typeof rawConfidence === 'number' || (typeof rawConfidence === 'string' && rawConfidence.trim() !== ''))
    && Number.isFinite(Number(rawConfidence)) && Number(rawConfidence) >= 0 && Number(rawConfidence) <= 1
    ? Math.round(Number(rawConfidence) * 100) : null
  const evidence = (Array.isArray(monitoring.evidence) ? monitoring.evidence : []).flatMap(value => {
    const item = object(value)
    const quote = text(item.quote)
    const source = text(item.source)
    const sourceLabel = ({ title: '标题', content: '正文', transcript: '媒体转写' } as Record<string, string>)[source]
    return quote && sourceLabel ? [{ quote, source, sourceLabel, entity: text(item.entity) }] : []
  })
  return {
    intent,
    intentLabel: POST_INTENT_OPTIONS.find(option => option.value === intent)?.label || '待判断',
    intentReason: text(ai.intentReason),
    relevance: effectiveRelevance,
    relevanceLabel,
    relevanceTone: effectiveRelevance === 'relevant' ? 'positive' : effectiveRelevance === 'uncertain' ? 'pending' : 'muted',
    relevanceReason: manualRelevance ? text(manual.reason) || text(ai.relevanceReason) : text(ai.relevanceReason),
    monitoringReason: text(monitoring.reason),
    monitoringStatus: text(record.monitoring_evidence_status) || text(monitoring.status),
    manual: Boolean(manualRelevance),
    archived: Boolean(record.archived_at),
    confidence,
    evidence,
  }
}
