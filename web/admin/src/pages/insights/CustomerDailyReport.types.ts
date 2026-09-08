export type DailyCounts = {
  monitor: number
  sdb: number
  positive: number
  neutral: number
  negative: number
  cold: number
  inProgress: null
  processed: null
  unclassified: number
  nonMonitor: number
}

export type DailyPost = {
  recordId: string
  title: string
  platform: string
  url: string
  heat?: number
  observedAt?: string
  comparisonText?: string
  previousHeat?: number
  previousObservedAt?: string
  markedAt?: string
  stale?: boolean
  status?: string
  quality?: 'measured' | 'measured_ingestion_time' | 'legacy_unverified'
  timeSource?: 'capture_timestamp' | 'ingested_at'
}

export type DailySnapshot = {
  id?: string
  version?: number
  schemaVersion: number
  tenantId: string
  tenantName: string
  reportDate: string
  mode: 'formal' | 'realtime'
  periodStart: string
  cutoffAt: string
  assessedAt: string
  monthStart: string
  heatStart: string
  summary: { day: DailyCounts; mtd: DailyCounts }
  highHeat: DailyPost[]
  coldMarked: DailyPost[]
  warnings: Array<{ code: string; message: string; blocking: boolean }>
}

export type DailyReport = {
  id: string
  reportDate: string
  mode: 'formal' | 'realtime'
  version: number
  generatedAt: string
  snapshot?: DailySnapshot
  delivery?: {
    status: 'none' | 'queued' | 'working' | 'retry_wait' | 'needs_attention' | 'document_ready' | 'sent'
    documentId?: string
    documentUrl?: string
    messageId?: string
    sentAt?: string
    error?: string
    chatName?: string
    canRetry?: boolean
  }
}

export type DailySettings = {
  appId: string
  folderToken: string
  documentBaseUrl: string
  channel: 'app' | 'webhook'
  chatId: string
  chatName: string
  editorType: 'email' | 'openid' | 'openchat'
  editorId: string
  customerEditVerified: boolean
  autoEnabled: boolean
  sendTime: string
  hasAppSecret?: boolean
  hasWebhook?: boolean
  hasWebhookSecret?: boolean
  nextRunAt?: string | null
  lastAutomaticRun?: {
    date: string
    status: 'pending' | 'enqueued' | 'needs_attention' | 'canceled'
    error?: string
  } | null
}

export const DAILY_API = '/customer-daily-reports'

export function shanghaiDate(offset = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offset * 86400000))
}

export function dailyTime(value?: string) {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间待核对'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date)
}

export function safeReportUrl(value?: string) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

export function dailyError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
