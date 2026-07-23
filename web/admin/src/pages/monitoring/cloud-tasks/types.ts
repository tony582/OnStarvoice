export type OrchestrationPlatform = 'xiaohongshu' | 'douyin'

export type CaptureEnhancementSettings = {
  autoDetailCaptureAfterListCapture: boolean
  autoSyncAfterDetailCapture: boolean
  enableAiRelevancePrefilter: boolean
  includeBloggerMetricsOnDetailCapture: boolean
  includeCommentsOnDetailCapture: boolean
  detailCommentsMaxDetectedItems: number
  skipAlreadyCapturedOnDetailCapture: boolean
}

/**
 * The orchestration UI deliberately accepts the same agent shape already returned
 * by /capture-cloud/overview. Optional workload fields can be added by a parent
 * screen without changing the API-owned CloudAgent model.
 */
export type OrchestrationCloudAgent = {
  id: string
  client_uuid?: string
  client_label?: string
  display_name: string
  host_label: string
  browser_name: string
  operating_system: string
  app_version: string
  allowed_platforms: string[]
  capabilities?: Record<string, unknown>
  status: 'active' | 'paused' | 'revoked'
  last_heartbeat_at?: string | null
  last_error?: string
  online: boolean
  active_task_count?: number
  queued_task_count?: number
}

export type OrchestrationRecord = {
  id: string
  tenant_id?: string
  client_task_id?: string
  parent_task_id?: string | null
  task_type?: string
  title: string
  platform: OrchestrationPlatform | string
  status: string
  revision?: number
  orchestration_revision?: number
  progress?: Record<string, unknown> | null
  checkpoint?: Record<string, unknown> | null
  counts?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
  message?: string | null
  created_at?: string | null
  updated_at?: string | null
  dispatched_at?: string | null
  finished_at?: string | null
}

export type OrchestrationItemRecord = {
  id: string
  orchestration_id?: string
  item_key: string
  ordinal?: number
  keyword?: string
  platform: string
  item_type: string
  status: string
  attempt_count?: number
  assigned_agent_id?: string | null
  execution_task_id?: string | null
  assignment_revision?: number
  request_hash?: string | null
  metadata?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
  assigned_at?: string | null
  dispatched_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export type OrchestrationExecutionRecord = {
  id?: string
  task_id?: string
  taskId?: string
  agent_id?: string
  agentId?: string
  assigned_agent_id?: string
  command_id?: string
  commandId?: string
  item_ids?: string[]
  itemIds?: string[]
  keywords?: string[]
  status?: string
  agent_online?: boolean
  agentOnline?: boolean
  agent_display_name?: string
  agent_host_label?: string
  agent_browser_name?: string
  agent_operating_system?: string
  agent_app_version?: string
  agent_status?: string
  agent_last_heartbeat_at?: string | null
  command_status?: string
  command_expires_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  message?: string | null
  [key: string]: unknown
}

export type OrchestrationAttemptRecord = {
  id?: string
  item_id?: string
  itemId?: string
  agent_id?: string
  agentId?: string
  task_id?: string
  taskId?: string
  attempt_number?: number
  status?: string
  error?: Record<string, unknown> | null
  created_at?: string | null
  updated_at?: string | null
  [key: string]: unknown
}

export type OrchestrationDetailResponse = {
  ok: true
  orchestration: OrchestrationRecord
  items: OrchestrationItemRecord[]
  executions: OrchestrationExecutionRecord[]
  agents: OrchestrationCloudAgent[]
  attempts: OrchestrationAttemptRecord[]
}

export type OrchestrationDispatchResult = {
  ok: true
  orchestrationId: string
  revision: number
  status: 'pending' | string
  executions: Array<{
    taskId: string
    agentId: string
    commandId: string
    itemIds: string[]
    keywords: string[]
    status: string
    agentOnline: boolean
  }>
}

export type OrchestrationComposerDrawerProps = {
  open: boolean
  writable: boolean
  agents: OrchestrationCloudAgent[]
  onClose: () => void
  onDispatched?: (result: OrchestrationDispatchResult) => void | Promise<void>
  onChanged?: () => void | Promise<void>
}

export type OrchestrationDetailWorkspaceProps = {
  orchestrationId: string | null
  writable?: boolean
  onClose?: () => void
  onChanged?: () => void | Promise<void>
  className?: string
  refreshKey?: string | number
}
