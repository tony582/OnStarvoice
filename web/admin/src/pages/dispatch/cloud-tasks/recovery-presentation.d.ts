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
