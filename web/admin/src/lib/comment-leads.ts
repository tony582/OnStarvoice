export interface CommentLead {
  id: string
  record_id: string
  status: string
  lead_type: string
  priority: string
  comment_content?: string
  comment_author_name?: string
  comment_ip_location?: string
  comment_source_type?: string
  comment_like_count?: number
  comment_seen_count?: number
  comment_first_seen_at?: string
  comment_last_seen_at?: string
  platform?: string
  record_url?: string
  record_current_url?: string
  record_canonical_url?: string
  record_external_id?: string
  record_title?: string
  record_current_title?: string
  record_content?: string
  reason?: string
  manual_lead_type?: string
  manual_reason?: string
  ai_result?: unknown
  matched_keywords?: unknown
  publish_display?: string
  captured_at?: string
  note?: string
  handled_name?: string
  progress_count?: number
  progress_latest_body?: string
  progress_latest_at?: string
  progress_latest_author?: string
  ticket_id?: string
  ticket_status?: string
}

export interface CommentLeadActivity {
  id: string
  action: string
  body?: string
  actor_name?: string
  created_at?: string
  metadata?: {
    body?: string; note?: string; correctionReason?: string
    status_from?: string; status_to?: string; previousStatus?: string; nextStatus?: string; status?: string
    before?: { status?: string }; after?: { status?: string }; previous?: { status?: string }
    [key: string]: unknown
  }
}

export interface CommentLeadTicket {
  id: string
  status: string
  [key: string]: unknown
}

export interface CommentLeadDetail {
  lead: CommentLead
  ticket?: CommentLeadTicket | null
  record: (Record<string, unknown> & { title?: string; content?: string }) | null
  activity: CommentLeadActivity[]
  suggestion?: { summary?: string; steps?: string[]; replyDraft?: string; [key: string]: unknown } | null
}

export const COMMENT_LEAD_TYPES = [
  { value: 'sales_intent', label: '真实购买意向' },
  { value: 'complaint', label: '投诉维权' },
  { value: 'renewal_billing', label: '续费收费' },
  { value: 'app_issue', label: 'App 故障' },
  { value: 'service_quality', label: '服务求助' },
  { value: 'safety_privacy', label: '安全隐私' },
  { value: 'brand_risk', label: '品牌风险' },
  { value: 'other', label: '其他评论' },
]

export const COMMENT_LEAD_STATUSES = [
  { value: 'new', label: '待处理' },
  { value: 'following', label: '跟进中' },
  { value: 'ticketed', label: '已转工单' },
  { value: 'resolved', label: '已处理' },
  { value: 'ignored', label: '已忽略' },
]

export function commentLeadIsArchived(lead: Pick<CommentLead, 'status'>) {
  return lead.status === 'resolved' || lead.status === 'ignored'
}

export function commentLeadStatusLabel(status: string) {
  return COMMENT_LEAD_STATUSES.find(option => option.value === status)?.label || status
}

export function commentLeadSource(lead: CommentLead) {
  return {
    id: lead.record_id,
    platform: lead.platform,
    url: lead.record_current_url || lead.record_url,
    canonical_url: lead.record_canonical_url,
    external_id: lead.record_external_id,
  }
}

export function commentLeadJudgment(lead: CommentLead) {
  let ai: Record<string, unknown> = {}
  try {
    const value = typeof lead.ai_result === 'string' ? JSON.parse(lead.ai_result) : lead.ai_result
    if (value && typeof value === 'object' && !Array.isArray(value)) ai = value
  } catch { /* 旧数据缺少可用判断时明确待核实。 */ }
  const manual = Boolean(lead.manual_lead_type)
  const needsReview = !manual && (ai.salesIntentStatus === 'needs_review' || (lead.lead_type === 'sales_intent' && (
    ai.salesIntent !== true || ai.salesIntentStatus !== 'confirmed' || ai.salesClassifierVersion !== 'comment-sales-v2' ||
    ['sarcasm', 'rhetorical', 'negated', 'quoted', 'uncertain'].includes(String(ai.expressionType || ''))
  )))
  const expressionLabels: Record<string, string> = { literal: '直接表达', sarcasm: '暗讽', rhetorical: '反问', negated: '否定表达', quoted: '引用他人', uncertain: '语气待核实' }
  const actorLabels: Record<string, string> = { buyer: '本人需求', seller: '卖方推广', third_party: '第三方转述', unknown: '主体待核实' }
  return {
    manual,
    needsReview,
    label: manual ? '人工修正' : needsReview ? '购买意向待核实' : ai.salesIntentStatus === 'confirmed' ? '购买意向已确认' : '',
    reason: manual ? String(lead.manual_reason || lead.reason || '') : String(lead.reason || ai.reason || ai.salesIntentReason || ''),
    salesReason: manual ? '' : String(ai.salesIntentReason || ''),
    evidence: manual || !Array.isArray(ai.salesIntentEvidence) ? [] : ai.salesIntentEvidence.filter((text: unknown): text is string => typeof text === 'string' && Boolean(text.trim())),
    expression: manual ? '' : expressionLabels[String(ai.expressionType || '')] || '',
    actor: manual ? '' : actorLabels[String(ai.salesActor || '')] || '',
    target: manual ? '' : String(ai.salesIntentTarget || ''),
  }
}


export function commentLeadTicketStatusLabel(status?: string) {
  const labels: Record<string, string> = { pending: '待处理', doing: '处理中', done: '已处理', dismissed: '已忽略', closed: '已结案' }
  return labels[status || ''] || '状态待确认'
}
