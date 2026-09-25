// /capture-cloud/overview 的 agents[].stop_fence；phase 由服务端 summarizeAgentStopFence 计算。
export type StopFencePhase =
  | 'task_action_required'
  | 'manual_only'
  | 'auto_check_disabled'
  | 'offline'
  | 'heartbeat_degraded'
  | 'needs_operator'
  | 'node_retrying'
  | 'node_checking'
  | 'awaiting_node'
  | 'local_release_pending'

export type StopFencePendingTab = {platform?: string; evidence?: string; title?: string}

export type StopFenceCheckResult = {
  at?: string | null
  accepted?: boolean
  reason?: string
  retryable?: boolean
  requires_operator?: boolean
  pending_tab_count?: number
  pending_tabs?: StopFencePendingTab[]
  message?: string
}

export type StopFenceCheck = {
  check_id?: string
  round?: number
  first_issued_at?: string | null
  issued_at?: string | null
  expires_at?: string | null
  last_offered_at?: string | null
  next_issue_at?: string | null
  failure_count?: number
  escalated_at?: string | null
  last_result?: StopFenceCheckResult | null
}

export type StopFenceReleaseDisposition = 'return_to_pool' | 'batch_retry' | 'parent_stopped' | 'unknown'

export type AgentStopFenceTask = {
  id: string
  kind?: 'fence' | 'local_release' | string
  parent_task_id?: string | null
  title?: string
  platform?: string
  status?: string
  fenced_at?: string | null
  message?: string
  handoff_successor_task_id?: string | null
  auto_checkable?: boolean
  check?: StopFenceCheck | null
  /** 「需要处理」的批次任务，可由运营人工确认放行（服务端 stopFenceOperatorReleasable）。 */
  operator_confirmable?: boolean
  /** 放行前的预计去向（依据父批次）；实际结果以确认回执为准。 */
  release_disposition?: StopFenceReleaseDisposition | string | null
}

export type AgentStopFence = {
  phase: StopFencePhase | string
  task_count?: number
  superseded_count?: number
  action_required_count?: number
  manual_only_task_count?: number
  local_release_pending_count?: number
  /** 人工确认后节点尚未释放本机执行锁，服务端暂不派新采集（与心跳同一判定，有上限）。 */
  local_release_holds_new_work?: boolean
  since?: string | null
  auto_check_supported?: boolean
  auto_check_enabled?: boolean
  escalated?: boolean
  escalated_at?: string | null
  /** 每个节点最多列 20 条，已转交与仍需处理的混排。 */
  tasks?: AgentStopFenceTask[]
  /** 该节点当前全部已转交围栏的 id（不受 20 条限制）；人工确认必须全部带上。 */
  superseded_task_ids?: string[]
  /** 该节点全部可人工放行的「需要处理」批次任务 id（不受 20 条限制）；phase 仍为 task_action_required。 */
  operator_confirmable_task_ids?: string[]
  operator_confirmable_count?: number
}

export type StopFenceAgentLike = {
  stop_fence?: AgentStopFence | null
  app_version?: string
}

export type StopFenceNoticePendingTab = {
  platform: string
  platformLabel: string
  evidence: string
  reason: string
  title: string
}

export type StopFenceNotice = {
  phase: StopFencePhase | string
  headline: string
  detail: string
  guidance: string
  sinceLabel: string
  elapsedLabel: string
  pendingTabs: StopFenceNoticePendingTab[]
  canRecheck: boolean
  recheckHint: string
  recheckLabel: string
  /** 有已转交围栏或可放行任务，且拿全了已转交围栏的 id。 */
  canConfirm: boolean
  /** 有已转交围栏但 id 拿不全、不能确认时的说明；其余情况为空。 */
  confirmHint: string
  /** 人工确认时发送的 expectedTaskIds：已转交任务（列出的并上 superseded_task_ids）并上可放行任务（列出的并上 operator_confirmable_task_ids）。 */
  confirmTaskIds: string[]
  /** 已转交围栏总数，以服务端 superseded_count 为准。 */
  supersededCount: number
  /** 已转交但没在 tasks 里列出的数量。 */
  unlistedSupersededCount: number
  supersededTasks: AgentStopFenceTask[]
  /** 列出的可人工放行的「需要处理」批次任务。 */
  releasableTasks: AgentStopFenceTask[]
  /** 可人工放行的任务总数，以服务端 operator_confirmable_count 为准。 */
  releasableCount: number
  /** 可放行但没在 tasks 里列出的数量。 */
  unlistedReleasableCount: number
  /** 既不是已转交、也不可人工放行的任务：要在任务上继续或停止。 */
  actionTasks: AgentStopFenceTask[]
  manualOnlyTasks: AgentStopFenceTask[]
  /** 围栏还在挡新任务（local_release_pending 已放行，不算）。 */
  blocking: boolean
  /** 已放行但节点尚未释放本机执行锁，服务端暂不派新采集；此时 guidance 不再是「不影响派发」。 */
  holdsNewWork: boolean
  /** 需要有人动手的阶段（与值守 high 告警一致）。 */
  operatorRequired: boolean
  /** 面板红色强调的阶段。 */
  urgent: boolean
  /** 节点列表里的一行说明；既不挡派发、也不在等释放本机执行锁时为空。 */
  rowLabel: string
}

export function formatStopFenceTime(value: string | number | null | undefined): string
export function formatStopFenceElapsed(ms: number): string
export function stopFenceReasonLabel(reason: string | null | undefined): string
export function stopFenceEvidenceLabel(evidence: string | null | undefined): string
export function stopFencePlatformLabel(platform: string | null | undefined): string
export function stopFenceTaskStatusLabel(status: string | null | undefined): string
/** 预计去向的完整说明与简短标签；未知取值按 unknown。 */
export function stopFenceReleaseDispositionText(disposition: string | null | undefined): string
export function stopFenceReleaseDispositionShort(disposition: string | null | undefined): string
export function isAgentStopFenced(agent: StopFenceAgentLike | null | undefined): boolean
export function countStopFencedAgents(agents: StopFenceAgentLike[] | null | undefined): number
export function findExecutionStopFence<T extends StopFenceAgentLike>(executionId: string | null | undefined, agents: T[] | null | undefined): {agent: T; task: AgentStopFenceTask} | null
export function isExecutionStopFenced(executionId: string | null | undefined, agents: StopFenceAgentLike[] | null | undefined): boolean
export function agentStopFenceNotice(agent: StopFenceAgentLike | null | undefined, now?: number): StopFenceNotice | null
/** 待处理页面的去重键（平台 + 证据 + 标题）。 */
export function stopFencePendingTabKey(tab: {platform?: string; evidence?: string; title?: string} | null | undefined): string
/** 对话框打开时的快照与最新 notice 比较；返回要提示的变化，空串表示可以按快照提交。 */
export function stopFenceConfirmDrift(snapshot: StopFenceNotice | null | undefined, live: StopFenceNotice | null | undefined): string
