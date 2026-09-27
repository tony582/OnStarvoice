// /capture-cloud/overview 的 tasks[].operator_close（服务端 loadOperatorCloseEligibility 计算）。
export type OperatorCloseReason =
  | ''
  | 'not_root'
  | 'interrupted'
  | 'status_not_closeable'
  | 'stop_fence'
  | 'stop_pending'
  | 'live_child'
  | 'live_command'
  | 'device_held'
  | 'live_item'
  | 'negative_patrol_needs_action'
  | 'active_discovery_demand'

export type OperatorCloseEligibility = { eligible: boolean; reason: OperatorCloseReason | string }

export type OperatorCloseTaskLike = {
  status: string
  title?: string
  task_type?: string
  parent_task_id?: string | null
  attention_dismissed_at?: string | null
  metadata?: Record<string, unknown>
  operator_close?: OperatorCloseEligibility
}

export type OperatorCloseSkip = { taskId: string; reason: string }

export type OperatorCloseBulkResult = {
  closedTaskIds?: string[]
  alreadyClosedTaskIds?: string[]
  skipped?: OperatorCloseSkip[]
  message?: string
}

export type HistoryClearResult = {
  clearedCount?: number
  clearedTaskIds?: string[]
  alreadyClearedTaskIds?: string[]
  skipped?: OperatorCloseSkip[]
  message?: string
}

export const OPERATOR_CLOSE_BLOCKED_TEXT: Readonly<Record<string, string>>
export const HISTORY_CLEAR_SKIPPED_TEXT: string
export function canOperatorClose(task: OperatorCloseTaskLike | null | undefined): boolean
export function operatorCloseBlockedText(reason: string | null | undefined): string
export function operatorCloseBlockedReason(task: OperatorCloseTaskLike | null | undefined): string
export function operatorCloseConfirmText(task: OperatorCloseTaskLike | null | undefined): string
export function operatorCloseBulkConfirmText(count: number): string
export function operatorCloseBulkResultText(result: OperatorCloseBulkResult): string
export function historyClearOutcome(result: HistoryClearResult): { keepSelectedIds: string[]; notice: string }
