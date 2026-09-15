export const POST_INTENT_OPTIONS = [
  { value: 'share', label: '分享' },
  { value: 'advertising', label: '广告/软文' },
  { value: 'other', label: '其他' },
  { value: 'complaint', label: '投诉/抱怨' },
  { value: 'inquiry', label: '咨询' },
] as const

export type PostIntent = typeof POST_INTENT_OPTIONS[number]['value']
export const ALL_POST_INTENTS: PostIntent[] = POST_INTENT_OPTIONS.map(option => option.value)
export type PostRelevance = 'relevant' | 'uncertain' | 'irrelevant'
export const POST_RELEVANCE_OPTIONS = [
  { value: 'relevant', label: '相关' },
  { value: 'uncertain', label: '信息不足' },
  { value: 'irrelevant', label: '无关' },
  { value: 'unjudged', label: '未判断' },
] as const
export const POST_CONFIDENCE_OPTIONS = [
  { value: 'high', label: '高（80–100%）', shortLabel: '高置信度' },
  { value: 'medium', label: '中（60–79%）', shortLabel: '中置信度' },
  { value: 'low', label: '低（0–59%）', shortLabel: '低置信度' },
  { value: 'missing', label: '暂无评分', shortLabel: '暂无评分' },
  { value: 'manual', label: '人工判断', shortLabel: '人工判断' },
] as const

function normalizeOptions(value: unknown, options: readonly { value: string }[]): string[] {
  const values = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(values.map(item => text(item).toLowerCase()).filter(item => options.some(option => option.value === item)))]
}

export function normalizePostRelevanceFilter(value: unknown): string[] { return normalizeOptions(value, POST_RELEVANCE_OPTIONS) }
export function normalizePostConfidenceFilter(value: unknown): string[] { return normalizeOptions(value, POST_CONFIDENCE_OPTIONS) }

export function postFilterSummary(labels: string[], fallback: string): string {
  return labels.length ? `${labels[0]}${labels.length > 1 ? ` +${labels.length - 1}` : ''}` : fallback
}

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

export function initialPostIntentFilter(value: unknown): PostIntent[] {
  return normalizePostIntentFilter(value)
}

// Empty selection is unrestricted; explicitly selecting every category excludes unjudged posts.
export function appendPostIntentFilter(params: URLSearchParams, intents: string[]): void {
  const selected = normalizePostIntentFilter(intents)
  params.delete('intent')
  selected.forEach(intent => params.append('intent', intent))
}

export function appendPostRelevanceFilters(params: URLSearchParams, relevances: string[], confidences: string[]): void {
  params.delete('relevance')
  params.delete('relevanceConfidence')
  normalizePostRelevanceFilter(relevances).forEach(value => params.append('relevance', value))
  normalizePostConfidenceFilter(confidences).forEach(value => params.append('relevanceConfidence', value))
}

function relevance(value: unknown): PostRelevance | null {
  return value === 'relevant' || value === 'uncertain' || value === 'irrelevant' ? value : null
}

export function postJudgment(value: unknown) {
  const record = object(value)
  const ai = object(record.ai_result)
  const overrides = object(record.manual_overrides)
  const manual = overrides.relevance && typeof overrides.relevance === 'object' && !Array.isArray(overrides.relevance)
    ? overrides.relevance as Record<string, unknown> : {}
  const manualRelevance = relevance(manual.value) || relevance(overrides.relevance)
  const intent = normalizePostIntent('intent_display' in record ? record.intent_display : record.intent || ai.intent)
  const monitoring = object(ai.monitoringEvidence)
  const aiRelevance = relevance(ai.relevance)
  const effectiveRelevance = manualRelevance || aiRelevance
  const relevanceLabel = POST_RELEVANCE_OPTIONS.find(option => option.value === effectiveRelevance)?.label || '未判断'
  const rawConfidence = ai.relevanceConfidence
  const confidence = !manualRelevance && aiRelevance && (typeof rawConfidence === 'number' || (typeof rawConfidence === 'string' && rawConfidence.trim() !== ''))
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
    relevanceFilter: effectiveRelevance || 'unjudged',
    relevanceLabel,
    relevanceTone: effectiveRelevance === 'relevant' ? 'positive' : effectiveRelevance === 'uncertain' ? 'pending' : 'muted',
    relevanceReason: manualRelevance ? text(manual.reason) || '人工判断，未填写依据' : text(ai.relevanceReason),
    monitoringReason: text(monitoring.reason),
    monitoringStatus: text(record.monitoring_evidence_status) || text(monitoring.status),
    manual: Boolean(manualRelevance),
    archived: Boolean(record.archived_at),
    confidence,
    confidenceBand: manualRelevance ? 'manual' : confidence === null ? 'missing' : confidence >= 80 ? 'high' : confidence >= 60 ? 'medium' : 'low',
    evidence,
  }
}
