export interface KeywordRetryItemLike {
  id: string
}

export interface KeywordRetryAgentLike {
  id: string
}

export interface KeywordRetryAllocation<Item, Agent> {
  item: Item
  agent: Agent | null
  overrideAgentId: string
  overridden: boolean
  preferenceFallback: boolean
  preferredAgentAlreadyAttempted: boolean
}

export function allocateKeywordRetryItems<
  Item extends KeywordRetryItemLike,
  Agent extends KeywordRetryAgentLike,
>(input: {
  items?: Item[]
  candidates?: Agent[]
  overrides?: Record<string, string>
  attemptedAgentIdsByItem?: Record<string, string[]> | Map<string, Set<string>>
}): Array<KeywordRetryAllocation<Item, Agent>>

export function buildKeywordRetryAssignments<
  Item extends KeywordRetryItemLike,
>(input: {
  items?: Item[]
  overrides?: Record<string, string>
}): Array<{itemId: string; agentId: string}>

export interface KeywordRetrySourceExecutionLike {
  status?: string
  metadata?: unknown
}

export function manualKeywordRetrySourceSettled(
  execution?: KeywordRetrySourceExecutionLike | null,
): boolean

export function keywordRetrySourceReleased(input?: {
  item?: {status?: string} | null
  execution?: KeywordRetrySourceExecutionLike | null
  elasticPool?: boolean
}): boolean
