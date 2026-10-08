import type { DailyCounts } from './CustomerDailyReport.types'

export type MonthlyCounts = DailyCounts

export type MonthlyGroup = { label: string; counts: MonthlyCounts; topic?: string; platform?: string }

export type MonthlyPost = {
  recordId: string
  title: string
  platform: string
  url: string
  heat: number
  heatIsLowerBound?: boolean
  likes: number | null
  comments: number | null
  collects: number | null
  shares: number | null
  publishedAt: string | null
  status: string
  feishuTableNo?: string
  topic?: string
  topicLabel?: string
}

export type MonthlySnapshot = {
  id?: string
  version?: number
  schemaVersion: number
  kind: string
  tenantId: string
  tenantName: string
  reportMonth: string
  mode: 'formal' | 'realtime'
  periodStart: string
  periodEnd: string
  cutoffAt: string
  assessedAt: string
  complete: boolean
  summary: {
    basis: string
    total: MonthlyCounts
    rows: Array<{ date: string; counts: MonthlyCounts }>
    byTopic: MonthlyGroup[]
    byPlatform: MonthlyGroup[]
  }
  topNegative: MonthlyPost[]
  recordCount?: number
  warnings: Array<{ code: string; message: string; blocking: boolean }>
  evidence?: { scope?: string; missingPublishedCount?: number; recordCount?: number }
}

export type MonthlyReport = {
  id: string
  reportMonth: string
  mode: 'formal' | 'realtime'
  version: number
  generatedAt: string
  snapshot?: MonthlySnapshot
  emailDelivery?: {
    sendId?: string
    status: 'none' | 'queued' | 'working' | 'failed' | 'sent'
    recipients?: string
    sentAt?: string | null
    error?: string | null
    ambiguous?: boolean
    canRetry?: boolean
  }
}

export type MonthlySettings = {
  emailRecipients?: string
  emailReady?: boolean
  emailConfigError?: string | null
}

export const MONTHLY_API = '/customer-monthly-reports'

export function shanghaiMonth(offset = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [year, month] = today.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthlyTime(value?: string | null, dateOnly = false) {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间待核对'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }),
  }).format(date)
}
