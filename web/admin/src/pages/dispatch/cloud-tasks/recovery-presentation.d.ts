export type OrchestrationItemStatusBucket =
  | 'success'
  | 'active'
  | 'automatic_recovery'
  | 'manual'
  | 'failed'
  | 'other'

export type OrchestrationItemStatusSummary = {
  completed: number
  settled: number
  active: number
  automaticRecovery: number
  manual: number
  failed: number
}

export function orchestrationItemStatusBucket(
  status?: string | null,
): OrchestrationItemStatusBucket

export function summarizeOrchestrationItems(
  items?: Array<{ status?: string | null }>,
): OrchestrationItemStatusSummary

export function formatRecoveryCountdown(options?: {
  waitUntil?: number
  now?: number
  awaitingAgentReport?: boolean
}): string

export function formatRecoveryState(options?: {
  commandStatus?: string | null
  waitUntil?: number
  now?: number
}): string

export function formatRecoveryAttemptLabel(options?: {
  attemptCurrent?: number
  attemptTotal?: number | null
}): string

export function activeRecoveryCommandStatus(options?: {
  id?: unknown
  status?: unknown
  expiresAt?: unknown
  now?: number
}): string
