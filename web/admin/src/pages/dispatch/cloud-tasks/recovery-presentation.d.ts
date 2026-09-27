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

export const DEFAULT_ELASTIC_ROUND_RELAX_MS: number

export function elasticRoundAnchorMs(item?: {
  metadata?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
  updated_at?: string | null
  updatedAt?: string | null
} | null): number

export type ElasticRoundUntriedAgent = {
  id: string
  name: string
  reason: string
}

export type ElasticRoundWaitSummary = {
  window: number
  poolSize: number
  triedAgentIds: string[]
  untried: ElasticRoundUntriedAgent[]
  sourceAgentId: string
  anchorMs: number
  relaxAtMs: number
  relaxed: boolean
  message: string
}

export function summarizeElasticRoundWait(options?: {
  item?: {
    id?: string
    status?: string | null
    platform?: string | null
    attempt_count?: number | null
    assigned_agent_id?: string | null
    metadata?: Record<string, unknown> | null
    error?: Record<string, unknown> | null
    updated_at?: string | null
  } | null
  attempts?: Array<{
    id?: string
    item_id?: string
    itemId?: string
    agent_id?: string
    agentId?: string
    attempt_number?: number
    created_at?: string | null
  }>
  poolAgentIds?: unknown[]
  agents?: Array<{
    id: string
    display_name?: string
    host_label?: string
    browser_name?: string
    status?: string
    online?: boolean
    allowed_platforms?: string[]
    active_task_count?: number
  }>
  fencedAgentIds?: Iterable<string>
  relaxAfterMs?: number
  now?: number
}): ElasticRoundWaitSummary | null
