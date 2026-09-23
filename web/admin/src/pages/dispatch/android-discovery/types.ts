export interface AndroidNode {
  id: string
  displayName: string
  deviceId: string
  status: string
  readyForSearch: boolean
  online: boolean
  holdState: 'free' | 'working' | 'stopping' | 'closure_required'
  lastHeartbeatAt: string | null
  activeRunId: string | null
  deviceHeld: boolean
  holdReason?: string
}

export interface DiscoveryRun {
  id: string
  title: string
  status: string
  agentId: string
  deviceId: string
  keywords: string[]
  createdAt: string
  deadlineAt: string | null
  stopRequested: boolean
  stopScope?: string
  progress: {total: number; completed: number; needsAction: number}
  candidateCounts?: Record<string, number>
}

export interface DiscoveryCandidate {
  id: string
  externalId: string
  canonicalUrl: string
  status: string
  demandStatus: string
  recordId: string | null
  recordVisibility?: string | null
  triageStatus?: string | null
  titleHint: string
  authorHint: string
  keyword: string
  reason?: string
}

export interface DiscoveryEvent {
  id: string
  eventId: string
  keyword: string
  deliveryMode?: string
  resolutionStatus: string
  resolutionError?: string
  rawShareUrl: string
  titleHint?: string
  candidateId?: string | null
}

export interface RunRecovery {
  state: 'working' | 'closure_required' | 'stopping' | 'stopped' | 'deadline_expired' | 'ready' | 'waiting_device' | 'node_unavailable' | 'not_needed'
  canResume: boolean
  resumeError: string | null
  deviceHeld: boolean
  closureRequired: boolean
  deviceOnline: boolean
  deviceReady: boolean
  checkedAt: string
  remainingMs: number | null
  lastClosedAt: string | null
}
export interface KeywordReceiptStats {
  links?: number; cards?: number; swipes?: number; keywordElapsedMs?: number; batchElapsedMs?: number
}
export interface DiscoveryRunDetail {
  run: DiscoveryRun
  recovery?: RunRecovery
  items: {id: string; keyword: string; status: string; reason?: string; attemptCount?: number; stats?: KeywordReceiptStats | null}[]
  candidates: DiscoveryCandidate[]
  events: DiscoveryEvent[]
}

export interface CreateDiscoveryRun {
  requestId: string
  agentId: string
  title: string
  keywords: string[]
  filters: {sort: 'latest' | 'comprehensive'; range: 'day'}
}
